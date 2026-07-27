import { describe, expect, it } from 'vitest';
import {
  assertHexSetAligned,
  assertStationSetAligned,
  trafficViewKey,
} from './useTrafficData';
import type { PackedHexWindow, PackedWindow } from './frames';

/**
 * Regression tests for the stale-window-vs-geometry guard.
 *
 * The M1 corridor-switch bug: on a corridor change `stations` narrows synchronously (it is
 * derived by filtering already-cached all-corridor geometry) while the eight window queries
 * are still in flight, so for one render the previous corridor's windows sit next to the new
 * corridor's geometry. Aligning them positionally mis-attributes every metric.
 *
 * The guard is layered:
 *   1. PROVENANCE (useTaggedWindow) drops windows fetched for a different view. This is what
 *      handles the benign race, and it is an identity check, not a cardinality check.
 *   2. These assertions then fail LOUD on any surviving disagreement, because after
 *      provenance filtering a mismatch is a real data bug that waiting cannot fix.
 *
 * The station counts below are the real ones, scoped exactly as station_geometry.sql scopes
 * them (EXISTS in gold_map_frames), measured against the live warehouse.
 */

const CORRIDOR_STATION_COUNTS: Record<string, number> = {
  'I-680': 75,
  'I-880': 77,
  'I-210': 104,
  'I-405': 129,
  'I-80': 165,
  'SR-99': 169,
  'I-15': 178,
  'I-10': 215,
  'US-101': 379,
  'I-5': 503,
  ALL: 1994,
};

function packedWindow(firstBucket: number, stations: number): PackedWindow {
  return {
    n: stations * 24,
    first_bucket: firstBucket,
    last_bucket: firstBucket + 23,
    stations,
    flow: '',
    speed_half: '',
    vc_pct: '',
    incident: '',
  };
}

function packedHexWindow(firstBucket: number, hexCount: number): PackedHexWindow {
  return {
    hex_count: hexCount,
    first_bucket: firstBucket,
    max_congestion_pct: 50,
    hex_ids: '',
    congestion_pct: '',
    speed_half: '',
  };
}

describe('trafficViewKey', () => {
  it('distinguishes corridor and day independently', () => {
    expect(trafficViewKey('2026-06-10', 'I-80')).toBe('2026-06-10|I-80');
    // Two corridors with EQUAL station counts still get different view keys, which is the
    // whole point: identity, not cardinality.
    expect(trafficViewKey('2026-06-10', 'I-80')).not.toBe(trafficViewKey('2026-06-10', 'SR-99'));
    expect(trafficViewKey('2026-06-10', 'I-80')).not.toBe(trafficViewKey('2026-06-11', 'I-80'));
  });
});

describe('assertStationSetAligned', () => {
  it('accepts four windows that agree with the geometry', () => {
    const windows = [0, 24, 48, 72].map((b) => packedWindow(b, 1994));
    expect(() => assertStationSetAligned(windows, 1994, '2026-06-10|ALL')).not.toThrow();
  });

  it('throws LOUDLY when a window describes a different station set', () => {
    // The exact M1 bug: all-corridor windows (1,994) next to I-405 geometry (129).
    const windows = [packedWindow(0, 1994)];
    expect(() => assertStationSetAligned(windows, 129, '2026-06-10|I-405')).toThrowError(
      /STATION SET MISMATCH for view 2026-06-10\|I-405/,
    );
  });

  it('names both counts and the offending bucket so the failure is diagnosable', () => {
    const windows = [packedWindow(0, 1994), packedWindow(24, 129)];
    expect(() => assertStationSetAligned(windows, 129, '2026-06-10|I-405')).toThrowError(
      /window at bucket 0 reports 1994 stations but station_geometry yields 129/,
    );
  });

  it('throws when only ONE of four windows is stale', () => {
    const windows = [
      packedWindow(0, 129),
      packedWindow(24, 129),
      packedWindow(48, 1994), // straggler from the previous corridor
      packedWindow(72, 129),
    ];
    expect(() => assertStationSetAligned(windows, 129, '2026-06-10|I-405')).toThrow();
  });

  it('is not fooled by the I-80 / SR-99 count collision that defeats a count-only guard', () => {
    // In raw silver_stations_geo both corridors have EXACTLY 170 stations. A guard that only
    // compares counts cannot tell these apart at all, so it would happily align SR-99's
    // speeds onto I-80's stations. Provenance is what separates them (asserted above via
    // trafficViewKey); this test pins the hazard so nobody "simplifies" the guard back to a
    // count comparison and calls it equivalent.
    const collidingCount = 170;
    const i80Windows = [packedWindow(0, collidingCount)];
    // Same count => the assertion alone CANNOT detect the swap. That is precisely why the
    // hook filters by viewKey before ever reaching here.
    expect(() =>
      assertStationSetAligned(i80Windows, collidingCount, '2026-06-10|SR-99'),
    ).not.toThrow();
    expect(trafficViewKey('2026-06-10', 'I-80')).not.toBe(trafficViewKey('2026-06-10', 'SR-99'));
  });

  it('accepts every real corridor against its own measured station count', () => {
    for (const [freeway, count] of Object.entries(CORRIDOR_STATION_COUNTS)) {
      const windows = [0, 24, 48, 72].map((b) => packedWindow(b, count));
      expect(() =>
        assertStationSetAligned(windows, count, trafficViewKey('2026-06-10', freeway)),
      ).not.toThrow();
    }
  });

  it('rejects every real corridor when paired with a DIFFERENT corridor geometry', () => {
    const entries = Object.entries(CORRIDOR_STATION_COUNTS);
    for (const [freeway, count] of entries) {
      for (const [otherFreeway, otherCount] of entries) {
        if (freeway === otherFreeway || count === otherCount) continue;
        expect(() =>
          assertStationSetAligned(
            [packedWindow(0, count)],
            otherCount,
            trafficViewKey('2026-06-10', otherFreeway),
          ),
        ).toThrow(/STATION SET MISMATCH/);
      }
    }
  });
});

describe('assertHexSetAligned', () => {
  it('accepts windows that share one index space', () => {
    const hexIds = ['8729a1c29ffffff', '8729a0310ffffff', '8729a4c48ffffff'];
    const windows = [0, 24].map((b) => packedHexWindow(b, hexIds.length));
    expect(() => assertHexSetAligned(windows, hexIds, '2026-06-10|ALL')).not.toThrow();
  });

  it('throws LOUDLY when a window has a different cell count', () => {
    // applyPackedHexWindow has NO built-in guard (unlike applyPackedWindow, which throws), so
    // without this assertion a stale corridor's congestion would be written into this
    // corridor's cell indices and draw a plausible-looking but wrong map.
    const hexIds = ['8729a1c29ffffff', '8729a0310ffffff'];
    const windows = [packedHexWindow(0, 2), packedHexWindow(24, 239)];
    expect(() => assertHexSetAligned(windows, hexIds, '2026-06-10|I-405')).toThrowError(
      /HEX SET MISMATCH for view 2026-06-10\|I-405/,
    );
  });

  it('reports both cell counts and the defining bucket', () => {
    const hexIds = ['8729a1c29ffffff'];
    const windows = [packedHexWindow(0, 1), packedHexWindow(48, 239)];
    expect(() => assertHexSetAligned(windows, hexIds, '2026-06-10|ALL')).toThrowError(
      /window at bucket 48 reports 239 cells but the window at bucket 0 defined 1/,
    );
  });
});
