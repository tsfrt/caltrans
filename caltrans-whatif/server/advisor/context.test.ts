/**
 * Tests for the snapshot-context builder.
 *
 * The contract these pin is narrow but load-bearing: **the brief must contain exactly the
 * numbers the warehouse returned, and nothing that looks like a number but isn't.** That is
 * what makes it possible to audit a model response for hallucination by string-matching its
 * numeric tokens against the brief — the check used in the PR body.
 *
 * `formatSnapshotContext` is pure, so these run with no warehouse and no network.
 */

import { describe, expect, it } from 'vitest';
import {
  bucketToLocalHour,
  bucketToLocalTime,
  buildSnapshotContext,
  formatSnapshotContext,
  num,
  peakPeriodLabel,
  snapshotKpis,
  type CorridorRow,
  type IncidentRow,
  type LosRow,
  type NetworkRow,
} from './context.js';

// Real values from lanl.caltrans_traffic.gold_map_frames at reading_date 2026-06-10,
// bucket 68 (17:00 PT), all corridors. Verified against a direct GROUP BY.
const NETWORK: NetworkRow = {
  station_count: 1994,
  mean_speed_mph: 48.4,
  min_speed_mph: 8.0,
  mean_free_flow_mph: 66.6,
  mean_vc: 0.891,
  max_vc: 4.01,
  stations_over_capacity: 636,
  stations_congested: 1138,
  stations_with_incident: 55,
  total_served_flow_vph: 12431696,
  total_demanded_flow_vph: 13525612,
  mean_delay_min_per_mi: 0.534,
};

const CORRIDORS: CorridorRow[] = [
  {
    freeway: 'I-405',
    direction: 'S',
    station_count: 62,
    mean_speed_mph: 26.2,
    free_flow_mph: 65.3,
    mean_vc: 1.27,
    max_vc: 2.08,
    stations_over_capacity: 62,
    mean_delay_min_per_mi: 1.626,
    incident_count: 5,
    max_lanes_blocked: 2,
    demanded_flow_vph: 500000,
    served_flow_vph: 340284,
  },
];

const LOS: LosRow[] = [
  { los: 'A', station_count: 1 },
  { los: 'F', station_count: 636 },
];

const INCIDENTS: IncidentRow[] = [
  {
    station_id: '0451S0008',
    freeway: 'I-680',
    direction: 'S',
    county: 'Santa Clara',
    city: 'Milpitas',
    postmile: 9.5,
    severity: 4,
    lanes_blocked: 4,
    num_lanes: 6,
    speed_mph: 8.0,
    vc_ratio: 4.01,
  },
];

const ANCHOR = { day: '2026-06-10', bucket: 68, corridor: 'ALL' };

function fullBrief() {
  return formatSnapshotContext({
    anchor: ANCHOR,
    network: NETWORK,
    corridors: CORRIDORS,
    los: LOS,
    incidents: INCIDENTS,
    incidentTotal: 55,
  });
}

describe('bucket → Pacific local time', () => {
  it('maps the verified peak buckets', () => {
    // The dataset's verified peaks. If this drifts, the chat anchors to a different time
    // than the map shows — the one failure this feature cannot tolerate.
    expect(bucketToLocalTime(68)).toBe('17:00');
    expect(bucketToLocalTime(28)).toBe('07:00');
    expect(bucketToLocalTime(0)).toBe('00:00');
    expect(bucketToLocalTime(95)).toBe('23:45');
    expect(bucketToLocalHour(68)).toBe(17);
  });

  it('wraps out-of-range buckets instead of emitting nonsense', () => {
    expect(bucketToLocalTime(96)).toBe('00:00');
    expect(bucketToLocalTime(-1)).toBe('23:45');
  });
});

describe('peakPeriodLabel', () => {
  it('labels the operational periods around the dataset peaks', () => {
    expect(peakPeriodLabel(7)).toBe('AM peak');
    expect(peakPeriodLabel(17)).toBe('PM peak');
    expect(peakPeriodLabel(12)).toBe('midday off-peak');
    expect(peakPeriodLabel(21)).toBe('evening');
    expect(peakPeriodLabel(3)).toBe('overnight');
  });
});

describe('num', () => {
  it('normalises the string scalars the SQL Statement API returns', () => {
    // The API serialises JSON values as strings; this app has already been burned by it
    // (a BOOLEAN "false" is truthy in JS).
    expect(num('48.4')).toBe(48.4);
    expect(num(48.4)).toBe(48.4);
    expect(num('0')).toBe(0);
  });

  it('returns null (never NaN) for missing or unparseable values', () => {
    // NaN would render as "NaN" in the brief and the model would narrate around it.
    expect(num(null)).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num('')).toBeNull();
    expect(num('n/a')).toBeNull();
  });
});

describe('formatSnapshotContext', () => {
  it('states the anchor: date, Pacific time, period and scope', () => {
    const t = fullBrief();
    expect(t).toContain('Date 2026-06-10 (Pacific local) · time 17:00 PT · PM peak');
    expect(t).toContain('entire monitored network (all corridors)');
  });

  it('names the corridor when one is filtered', () => {
    const t = formatSnapshotContext({
      anchor: { ...ANCHOR, corridor: 'I-405' },
      network: NETWORK,
      corridors: CORRIDORS,
      los: LOS,
      incidents: [],
      incidentTotal: 0,
    });
    expect(t).toContain('corridor I-405 only');
  });

  it('emits every network figure verbatim', () => {
    const t = fullBrief();
    for (const s of [
      '1,994',
      '48.4 mph',
      '8.0 mph',
      '66.6 mph',
      '0.534 min per mile',
      '0.891',
      '4.01',
      '636 of 1,994',
      '1,138',
      '13,525,612 veh/h',
      '12,431,696 veh/h',
    ]) {
      expect(t).toContain(s);
    }
  });

  it('computes unserved demand rather than leaving the subtraction to the model', () => {
    // 13,525,612 - 12,431,696 = 1,093,916 (8.1%). Arithmetic is exactly what models get
    // wrong, so it is done here and labelled.
    const t = fullBrief();
    expect(t).toContain('1,093,916 veh/h');
    expect(t).toContain('8.1% of demand');
  });

  it('reports LOS shares against the supplied total', () => {
    const t = fullBrief();
    expect(t).toContain('LOS A: 1 (0.2%)');
    expect(t).toContain('LOS F: 636 (99.8%)');
  });

  it('describes worst corridors with speed, delay, v/c and capacity counts', () => {
    const t = fullBrief();
    expect(t).toContain(
      'I-405 S: 26.2 mph vs 65.3 mph free-flow · delay 1.626 min/mi · mean v/c 1.27 (max 2.08) · 62/62 stations over capacity',
    );
  });

  it('never presents a truncated incident list as complete', () => {
    // The rollup counts 55; only one row is listed. Reading the list as exhaustive would let
    // the model conclude the network has a single incident.
    const t = fullBrief();
    expect(t).toContain('55 incident-affected stations total');
    expect(t).toContain('list truncated at');
  });

  it('says "all listed" when the list really is complete', () => {
    const t = formatSnapshotContext({
      anchor: ANCHOR,
      network: NETWORK,
      corridors: [],
      los: [],
      incidents: INCIDENTS,
      incidentTotal: 1,
    });
    expect(t).toContain('all listed');
    expect(t).not.toContain('truncated');
  });

  it('states plainly when there are no incidents', () => {
    const t = formatSnapshotContext({
      anchor: ANCHOR,
      network: NETWORK,
      corridors: [],
      los: [],
      incidents: [],
      incidentTotal: 0,
    });
    expect(t).toContain('None active in this snapshot.');
  });

  it('tells the model to refuse rather than speculate on an empty snapshot', () => {
    const t = formatSnapshotContext({
      anchor: ANCHOR,
      network: null,
      corridors: [],
      los: [],
      incidents: [],
      incidentTotal: 0,
    });
    expect(t).toContain('NO DATA');
    expect(t).toContain('Do not speculate');
  });

  it('emits no NaN/undefined/null artefacts when fields are missing', () => {
    // A model shown "NaN mph" will write a sentence around it.
    const sparse: NetworkRow = { ...NETWORK, min_speed_mph: null, mean_vc: undefined };
    const t = formatSnapshotContext({
      anchor: ANCHOR,
      network: sparse,
      corridors: [],
      los: [],
      incidents: [],
      incidentTotal: 0,
    });
    expect(t).not.toMatch(/NaN|undefined|null/);
    expect(t).toContain('n/a');
  });

  it('stays small enough for the model to read in full', () => {
    // The anti-hallucination argument depends on the brief being short. A 1,994-row dump
    // would be ~100x this.
    expect(Buffer.byteLength(fullBrief(), 'utf8')).toBeLessThan(8 * 1024);
  });
});

describe('snapshotKpis', () => {
  it('persists numbers, not the prose brief', () => {
    const ctx = {
      anchor: ANCHOR,
      localTime: '17:00',
      localHour: 17,
      network: NETWORK,
      corridors: CORRIDORS,
      los: LOS,
      incidents: INCIDENTS,
      incidentTotal: 55,
      text: fullBrief(),
      bytes: 4338,
      queryMs: 3772,
    };
    const k = snapshotKpis(ctx);
    expect(k.mean_speed_mph).toBe(48.4);
    expect(k.stations_over_capacity).toBe(636);
    expect(k.incident_total).toBe(55);
    expect(k.context_bytes).toBe(4338);
    // Prose in a JSONB column would be unqueryable; the brief is reproducible from these.
    expect(JSON.stringify(k)).not.toContain('TRAFFIC SNAPSHOT');
    expect((k.worst_corridors as { freeway: string }[])[0].freeway).toBe('I-405');
  });
});

describe('buildSnapshotContext', () => {
  /** Fake analytics handle: returns a canned payload per query, records the params it saw. */
  function fakeAnalytics(shapes: Record<string, unknown>) {
    const seen: Record<string, unknown>[] = [];
    return {
      seen,
      analytics: {
        query: (text: string, params?: Record<string, unknown>) => {
          if (params) seen.push(params);
          // Identify the query by a distinctive column in its SELECT list.
          if (text.includes('stations_over_capacity') && text.includes('GROUP BY freeway'))
            return Promise.resolve(shapes.corridor);
          if (text.includes('level_of_service')) return Promise.resolve(shapes.los);
          if (text.includes('WHERE incident_active')) return Promise.resolve(shapes.incident);
          return Promise.resolve(shapes.network);
        },
      } as never,
    };
  }

  it('binds day, corridor and bucket as typed SQL parameters', async () => {
    const { analytics, seen } = fakeAnalytics({
      network: { rows: [NETWORK] },
      corridor: { rows: CORRIDORS },
      los: { rows: LOS },
      incident: { rows: INCIDENTS },
    });
    await buildSnapshotContext(analytics, ANCHOR);
    expect(seen).toHaveLength(4); // all four rollups issued
    // Typed markers, not bare strings — a bare value would be inlined as a literal.
    expect(seen[0].day).toMatchObject({ __sql_type: 'DATE', value: '2026-06-10' });
    expect(seen[0].freeway).toMatchObject({ __sql_type: 'STRING', value: 'ALL' });
    expect(seen[0].bucket).toMatchObject({ __sql_type: 'INT', value: '68' });
  });

  it('unwraps rows from whichever envelope the plugin returns', async () => {
    // The envelope shape is not part of the plugin's public typed contract.
    for (const wrap of [
      (r: unknown[]) => r,
      (r: unknown[]) => ({ rows: r }),
      (r: unknown[]) => ({ data: r }),
      (r: unknown[]) => ({ data: { rows: r } }),
    ]) {
      const { analytics } = fakeAnalytics({
        network: wrap([NETWORK]),
        corridor: wrap(CORRIDORS),
        los: wrap(LOS),
        incident: wrap(INCIDENTS),
      });
      const ctx = await buildSnapshotContext(analytics, ANCHOR);
      expect(ctx.network?.mean_speed_mph).toBe(48.4);
      expect(ctx.corridors).toHaveLength(1);
    }
  });

  it('trusts the rollup for the incident total, not the truncated list', async () => {
    const { analytics } = fakeAnalytics({
      network: { rows: [NETWORK] }, // says 55
      corridor: { rows: [] },
      los: { rows: [] },
      incident: { rows: INCIDENTS }, // lists 1
    });
    const ctx = await buildSnapshotContext(analytics, ANCHOR);
    expect(ctx.incidentTotal).toBe(55);
    expect(ctx.incidents).toHaveLength(1);
    expect(ctx.text).toContain('list truncated at');
  });

  it('reports byte size so cost is measurable, not guessed', async () => {
    const { analytics } = fakeAnalytics({
      network: { rows: [NETWORK] },
      corridor: { rows: CORRIDORS },
      los: { rows: LOS },
      incident: { rows: INCIDENTS },
    });
    const ctx = await buildSnapshotContext(analytics, ANCHOR);
    expect(ctx.bytes).toBe(Buffer.byteLength(ctx.text, 'utf8'));
  });

  it('produces a usable brief when the snapshot is empty', async () => {
    const { analytics } = fakeAnalytics({
      network: { rows: [] },
      corridor: { rows: [] },
      los: { rows: [] },
      incident: { rows: [] },
    });
    const ctx = await buildSnapshotContext(analytics, ANCHOR);
    expect(ctx.network).toBeNull();
    expect(ctx.text).toContain('NO DATA');
  });
});
