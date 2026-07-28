/**
 * Tests for the UI→engine adapter and the SQL parameter binder.
 *
 * Ported from `server/scenario/ui-adapter.test.ts` when the engine call moved to
 * the client. Every assertion about the FOLDING is unchanged; the assertions
 * about BINDING now go through `matrixParams`/`kpiParams` and unwrap `sql.*`
 * markers, because that is what actually goes to the warehouse now.
 *
 * These tests pin that every LOSSY fold is reported rather than silent — a
 * scenario that quietly drops or merges a lever looks identical to one that
 * worked.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BUCKETS_PER_DAY,
  DEFAULTS,
  isBaseline,
  kpiParams,
  matrixParams,
  WINDOW_BUCKETS,
} from './scenarioParams';
import {
  TARGET_HALF_WIDTH_MI,
  engineModel,
  fromUiRequest,
  type UiLever,
  type UiScenarioRunRequest,
} from './scenarioAdapter';

const DAY = '2026-06-10';

const target = (freeway: string, direction: string, postmile: number, id = 'S1') => ({
  stationId: id,
  freeway,
  direction,
  postmile,
});

const req = (levers: UiLever[], freeway = 'ALL'): UiScenarioRunRequest => ({
  schemaVersion: 'm2-scenario-v1',
  day: DAY,
  scope: { freeway },
  levers,
});

/** Unwrap `sql.*` markers to plain values so assertions stay readable. */
const plain = (params: Record<string, { value: string }>): Record<string, string> =>
  Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v.value]));

/**
 * The exact parameter names each query's BODY references, transcribed from
 * `config/queries/scenario_*.sql`. AppKit throws on any key the body does not
 * mention, so these sets are the contract.
 */
const MATRIX_KEYS = [
  'day', 'freeway', 'from_bucket', 'bpr_alpha', 'bpr_beta', 'msa_iterations',
  'reassign_share', 'reassign_offnetwork_share', 'parallel_max_dist_m', 'parallel_max_bearing_deg',
  'close_freeway', 'close_direction', 'close_pm_from', 'close_pm_to', 'close_lanes',
  'demand_freeway', 'demand_direction', 'demand_pct',
  'incident_freeway', 'incident_direction', 'incident_pm_from', 'incident_pm_to',
  'incident_lanes_blocked', 'incident_from_bucket', 'incident_to_bucket',
  'capacity_freeway', 'capacity_direction', 'capacity_pm_from', 'capacity_pm_to',
  'capacity_add_lanes', 'capacity_scale', 'capacity_abs_vph',
];

const KPI_KEYS = [...MATRIX_KEYS.filter((k) => k !== 'from_bucket'), 'worst_n'];

describe('the two queries take DIFFERENT parameter sets', () => {
  // This is a regression test for a real bug in the never-executed server code:
  // it built ONE 34-key object and sent it to both queries. AppKit validates
  // against the `:name` occurrences in the SQL BODY and throws on an extra key:
  //   Invalid value for worst_n: expected a parameter defined in the query
  // DBSQL itself tolerates the extra parameter, so SQL-level testing could never
  // have caught this.
  const base = fromUiRequest(req([])).request;

  it('scenario_time_matrix takes from_bucket and NOT worst_n', () => {
    const keys = Object.keys(matrixParams(base, 0)).sort();
    expect(keys).toEqual([...MATRIX_KEYS].sort());
    expect(keys).toContain('from_bucket');
    expect(keys).not.toContain('worst_n');
  });

  it('scenario_kpis takes worst_n and NOT from_bucket', () => {
    const keys = Object.keys(kpiParams(base)).sort();
    expect(keys).toEqual([...KPI_KEYS].sort());
    expect(keys).toContain('worst_n');
    expect(keys).not.toContain('from_bucket');
  });

  it('every parameter name each query references is transcribed from the SQL itself', () => {
    // Read the generated SQL rather than restating it, so a new `:param` in the
    // engine fails here instead of at the warehouse.
    const queryDir = join(import.meta.dirname, '..', '..', '..', 'config', 'queries');
    const referenced = (file: string) => {
      const sqlText = readFileSync(join(queryDir, file), 'utf8');
      const names = new Set([...sqlText.matchAll(/:([a-zA-Z_]\w*)/g)].map((m) => m[1]));
      // `:param_doc_block` is a render-time placeholder inside a comment, not a bind.
      names.delete('param_doc_block');
      return [...names].sort();
    };
    expect(referenced('scenario_time_matrix.sql')).toEqual([...MATRIX_KEYS].sort());
    expect(referenced('scenario_kpis.sql')).toEqual([...KPI_KEYS].sort());
  });
});

describe('every bound value is a sql.* marker', () => {
  // The other real bug in the never-executed server code: it typed params as
  // `Record<string, string | number>`. AppKit's `_createParameter` rejects a raw
  // value outright ("expected SQL type (use sql.string(), ...)").
  const base = fromUiRequest(req([])).request;

  it('markers carry both a __sql_type and a string value', () => {
    for (const [key, marker] of Object.entries(matrixParams(base, 24))) {
      expect(marker, key).toHaveProperty('__sql_type');
      expect(typeof (marker as { value: unknown }).value, key).toBe('string');
    }
  });

  it('pins DOUBLE params as DOUBLE even when the value is integral', () => {
    // `capacity_scale`'s "off" sentinel is 1, which sql.number() would infer as
    // INT. The SQL declares it DOUBLE, so the type must be explicit.
    const p = matrixParams(base, 0) as unknown as Record<string, { __sql_type: string }>;
    expect(p.capacity_scale.__sql_type).toBe('DOUBLE');
    expect(p.capacity_abs_vph.__sql_type).toBe('DOUBLE');
    expect(p.close_pm_from.__sql_type).toBe('DOUBLE');
    expect(p.msa_iterations.__sql_type).toBe('INT');
    expect(p.close_lanes.__sql_type).toBe('INT');
    expect(p.day.__sql_type).toBe('DATE');
  });
});

describe('adapter output is always bindable', () => {
  it('an empty lever list produces the provable no-op', () => {
    const { request, warnings } = fromUiRequest(req([]));
    expect(warnings).toEqual([]);
    expect(isBaseline(request)).toBe(true);
    // These sentinels are what make the engine reproduce gold_map_frames
    // bit-for-bit. The client uses M1's baseline as the "before" side of every
    // diff, which is only legitimate because of that.
    expect(plain(matrixParams(request, 0) as never)).toMatchObject({
      day: DAY,
      close_freeway: '',
      demand_freeway: '',
      incident_freeway: '',
      capacity_freeway: '',
      capacity_scale: '1',
      capacity_abs_vph: '-1',
    });
  });

  it('every lever kind at once binds without error', () => {
    const { request } = fromUiRequest(
      req([
        { id: 'a', type: 'closure', target: target('I-405', 'S', 46.07), lanesClosed: 2 },
        { id: 'b', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: 20 },
        {
          id: 'c',
          type: 'incident',
          target: target('US-101', 'N', 22.0),
          startBucket: 64,
          durationBuckets: 9,
          lanesBlocked: 2,
          severity: 3,
        },
        { id: 'd', type: 'capacity_change', target: target('I-10', 'E', 12.5), capacityVph: 14000 },
      ]),
    );
    expect(() => matrixParams(request, 0)).not.toThrow();
    expect(() => kpiParams(request)).not.toThrow();
    expect(isBaseline(request)).toBe(false);
    expect(plain(matrixParams(request, 0) as never)).toMatchObject({
      close_freeway: 'I-405',
      close_lanes: '2',
      demand_freeway: 'I-5',
      demand_pct: '20',
      incident_freeway: 'US-101',
      incident_lanes_blocked: '2',
      incident_from_bucket: '64',
      incident_to_bucket: '72', // 64 + 9 - 1
      capacity_freeway: 'I-10',
      capacity_abs_vph: '14000',
    });
  });

  it('binds the BPR pair the engine declares, not the textbook or Lakebase seed', () => {
    const { request } = fromUiRequest(req([]));
    const p = plain(matrixParams(request, 0) as never);
    expect(p.bpr_alpha).toBe('0.55');
    expect(p.bpr_beta).toBe('4.5');
    expect(DEFAULTS.bpr).toEqual({ alpha: 0.55, beta: 4.5 });
    // Guard the doc's claim: the engine must NOT be on the textbook curve.
    expect(p.bpr_alpha).not.toBe('0.15');
    expect(p.bpr_beta).not.toBe('4');
  });
});

describe('window boundaries', () => {
  const base = fromUiRequest(req([])).request;

  it('accepts exactly the four window starts that cover a day', () => {
    for (const from of [0, 24, 48, 72]) {
      expect(() => matrixParams(base, from)).not.toThrow();
    }
  });

  it('rejects an off-grid start rather than silently misaligning the animation', () => {
    // The client indexes each window by (bucket - first_bucket), so an off-grid
    // start would shift every value to the wrong bucket while still looking
    // plausible.
    expect(() => matrixParams(base, 10)).toThrow(/multiple of 24/);
  });

  it('rejects a start that would run past the end of the day', () => {
    expect(() => matrixParams(base, BUCKETS_PER_DAY)).toThrow(/fromBucket/);
    expect(BUCKETS_PER_DAY - WINDOW_BUCKETS).toBe(72);
  });
});

describe('station target → postmile window', () => {
  it('brackets the station tightly enough not to swallow its neighbours', () => {
    const { request } = fromUiRequest(
      req([{ id: 'a', type: 'closure', target: target('I-405', 'S', 46.07), lanesClosed: 2 }]),
    );
    expect(request.closure?.postmileFrom).toBeCloseTo(46.07 - TARGET_HALF_WIDTH_MI, 9);
    expect(request.closure?.postmileTo).toBeCloseTo(46.07 + TARGET_HALF_WIDTH_MI, 9);
    // The generator's densest urban spacing is 0.60 mi, so a full window must
    // stay under that or it reaches the adjacent detector.
    expect(2 * TARGET_HALF_WIDTH_MI).toBeLessThan(0.6);
  });

  it('folds several closures into the hull that covers all of them, and says so', () => {
    const { request, warnings } = fromUiRequest(
      req([
        { id: 'a', type: 'closure', target: target('I-405', 'S', 45.38), lanesClosed: 2 },
        { id: 'b', type: 'closure', target: target('I-405', 'S', 51.29), lanesClosed: 3 },
      ]),
    );
    expect(request.closure?.postmileFrom).toBeCloseTo(45.38 - TARGET_HALF_WIDTH_MI, 9);
    expect(request.closure?.postmileTo).toBeCloseTo(51.29 + TARGET_HALF_WIDTH_MI, 9);
    // Max, not sum: folding must not invent a wider closure than was asked for.
    expect(request.closure?.lanes).toBe(3);
    expect(warnings.join(' ')).toMatch(/2 closure levers were folded/);
  });

  it('refuses to model closures spread across corridors rather than dropping one', () => {
    expect(() =>
      fromUiRequest(
        req([
          { id: 'a', type: 'closure', target: target('I-405', 'S', 46.0), lanesClosed: 2 },
          { id: 'b', type: 'closure', target: target('US-101', 'N', 22.0), lanesClosed: 1 },
        ]),
      ),
    ).toThrow(/more than one freeway/);
  });

  it('treats opposite directions of the same freeway as different carriageways', () => {
    expect(() =>
      fromUiRequest(
        req([
          { id: 'a', type: 'closure', target: target('I-405', 'S', 46.0), lanesClosed: 2 },
          { id: 'b', type: 'closure', target: target('I-405', 'N', 46.0), lanesClosed: 2 },
        ]),
      ),
    ).toThrow(/more than one freeway/);
  });
});

describe('demand deltas combine multiplicatively', () => {
  it('+10% then +10% is +21%, not +20%', () => {
    const { request, warnings } = fromUiRequest(
      req([
        { id: 'a', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: 10 },
        { id: 'b', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: 10 },
      ]),
    );
    expect(request.demand?.percent).toBeCloseTo(21, 9);
    expect(warnings.join(' ')).toMatch(/combined multiplicatively/);
  });

  it('widens to ALL corridors when levers disagree, and warns', () => {
    const { request, warnings } = fromUiRequest(
      req([
        { id: 'a', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: 10 },
        { id: 'b', type: 'demand_delta', freeway: 'I-405', direction: 'S', percent: 10 },
      ]),
    );
    expect(request.demand?.freeway).toBe('ALL');
    expect(request.demand?.direction).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/widened to ALL corridors/);
  });

  it('drops a lever pair that cancels out rather than binding a 0% no-effect lever', () => {
    // 1.25 * 0.80 == 1.0, so the net delta is 0% and the lever must be DROPPED,
    // not passed through — the binder rejects demand_pct === 0 outright.
    const { request, warnings } = fromUiRequest(
      req([
        { id: 'a', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: 25 },
        { id: 'b', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: -20 },
      ]),
    );
    expect(request.demand).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/cancelled out/);
    expect(() => matrixParams(request, 0)).not.toThrow();
    expect(plain(matrixParams(request, 0) as never).demand_freeway).toBe('');
  });
});

describe('incident time window', () => {
  it('converts start + duration to an inclusive window', () => {
    const { request } = fromUiRequest(
      req([
        {
          id: 'a',
          type: 'incident',
          target: target('US-101', 'N', 22.0),
          startBucket: 64,
          durationBuckets: 9,
          lanesBlocked: 2,
          severity: 2,
        },
      ]),
    );
    expect(request.incident?.fromBucket).toBe(64);
    expect(request.incident?.toBucket).toBe(72);
  });

  it('a 1-bucket incident is a single bucket, not zero', () => {
    const { request } = fromUiRequest(
      req([
        {
          id: 'a',
          type: 'incident',
          target: target('US-101', 'N', 22.0),
          startBucket: 68,
          durationBuckets: 1,
          lanesBlocked: 1,
          severity: 1,
        },
      ]),
    );
    expect(request.incident?.fromBucket).toBe(68);
    expect(request.incident?.toBucket).toBe(68);
  });

  it('truncates at midnight rather than wrapping into the morning', () => {
    const { request, warnings } = fromUiRequest(
      req([
        {
          id: 'a',
          type: 'incident',
          target: target('US-101', 'N', 22.0),
          startBucket: 92,
          durationBuckets: 12,
          lanesBlocked: 1,
          severity: 1,
        },
      ]),
    );
    expect(request.incident?.toBucket).toBe(95);
    expect(warnings.join(' ')).toMatch(/past midnight/);
    expect(() => matrixParams(request, 0)).not.toThrow();
  });

  it('always warns that severity behaves differently than the old client mock', () => {
    const { warnings } = fromUiRequest(
      req([
        {
          id: 'a',
          type: 'incident',
          target: target('US-101', 'N', 22.0),
          startBucket: 64,
          durationBuckets: 4,
          lanesBlocked: 2,
          severity: 4,
        },
      ]),
    );
    expect(warnings.join(' ')).toMatch(/severity is metadata only/);
  });
});

describe("engineModel answers the UI's question about the BPR conflict", () => {
  // The old mock's header said: "When the engine lands it must declare which pair
  // it used, and the UI should surface that verbatim rather than assuming."
  const model = engineModel();

  it('names the pair it used and says the Lakebase seed is stale', () => {
    expect(model.bprCoefficients).toMatch(/alpha=0\.55/);
    expect(model.bprCoefficients).toMatch(/beta=4\.5/);
    expect(model.bprCoefficients).toMatch(/0\.15\/4\.0 is stale/);
  });

  it('uses the model name and reassignment label the UI type expects', () => {
    expect(model.name).toBe('bpr-volume-delay');
    expect(model.reassignment).toBe('corridor-postmile-simplified');
  });

  it('does not overclaim the reassignment as network assignment', () => {
    expect(model.caveat).toMatch(/NOT network assignment/);
    expect(model.caveat).toMatch(/no road graph/);
    expect(model.caveat).toMatch(/has NOT converged/);
  });
});

describe('the adapter covers every lever the UI can build', () => {
  it('handles all four discriminants declared in scenario.ts', () => {
    // Read the UI's own union rather than restating it, so a new lever kind added
    // there fails here instead of being silently ignored at runtime.
    const uiSource = readFileSync(join(import.meta.dirname, 'scenario.ts'), 'utf8');
    const kinds = new Set([...uiSource.matchAll(/^\s*type: '([a-z_]+)';/gm)].map((m) => m[1]));
    expect(kinds).toEqual(new Set(['closure', 'demand_delta', 'incident', 'capacity_change']));
  });
});
