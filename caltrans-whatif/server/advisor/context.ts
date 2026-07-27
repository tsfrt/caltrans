/**
 * Snapshot context: turn one map bucket into a compact, factual brief for the model.
 *
 * ── THE DESIGN CONSTRAINT ─────────────────────────────────────────────────────────────
 * The single biggest quality risk in this feature is the model inventing statistics. Two
 * things reduce it, and both are implemented here rather than left to the prompt:
 *
 *  1. **Every number the model is allowed to cite is in the brief, and nothing else is.**
 *     `formatSnapshotContext` is a pure function, so the exact bytes sent to the model are
 *     reproducible and diffable in a test against a direct SQL `GROUP BY`.
 *  2. **The brief is small enough to be read in full.** Measured ~1.9 kB / ~600 tokens for
 *     an all-corridor snapshot (see the PR body). A 1,994-row dump would be ~100× that and
 *     would push the real numbers out of the model's effective attention, which is when
 *     plausible-looking fabrication starts.
 *
 * Splitting the pure formatter from the I/O (`buildSnapshotContext`) is what makes claim 1
 * testable without a warehouse.
 */

import { sql } from '@databricks/appkit';
import {
  CORRIDOR_SQL,
  INCIDENT_LIMIT,
  INCIDENT_SQL,
  LOS_SQL,
  NETWORK_SQL,
  WORST_CORRIDOR_LIMIT,
} from './snapshot-sql.js';

export const ALL_CORRIDORS = 'ALL';
export const BUCKETS_PER_DAY = 96;

// ---------------------------------------------------------------------------
// Row shapes. These mirror the SELECT lists in snapshot-sql.ts.
//
// Every field is typed `number | string` where the warehouse may hand back either: the SQL
// Statement API serialises JSON values as STRINGS, which already caused a real bug in this
// app (a BOOLEAN arriving as "false" — truthy in JS — labelled every weekday a weekend, see
// available_days.sql). `num()` below normalises defensively at the boundary rather than
// trusting the wire type.
// ---------------------------------------------------------------------------

type Scalar = number | string | null | undefined;

export interface NetworkRow {
  station_count: Scalar;
  mean_speed_mph: Scalar;
  min_speed_mph: Scalar;
  mean_free_flow_mph: Scalar;
  mean_vc: Scalar;
  max_vc: Scalar;
  stations_over_capacity: Scalar;
  stations_congested: Scalar;
  stations_with_incident: Scalar;
  total_served_flow_vph: Scalar;
  total_demanded_flow_vph: Scalar;
  mean_delay_min_per_mi: Scalar;
}

export interface CorridorRow {
  freeway: string;
  direction: string;
  station_count: Scalar;
  mean_speed_mph: Scalar;
  free_flow_mph: Scalar;
  mean_vc: Scalar;
  max_vc: Scalar;
  stations_over_capacity: Scalar;
  mean_delay_min_per_mi: Scalar;
  incident_count: Scalar;
  max_lanes_blocked: Scalar;
  demanded_flow_vph: Scalar;
  served_flow_vph: Scalar;
}

export interface LosRow {
  los: string;
  station_count: Scalar;
}

export interface IncidentRow {
  station_id: string;
  freeway: string;
  direction: string;
  county: Scalar;
  city: Scalar;
  postmile: Scalar;
  severity: Scalar;
  lanes_blocked: Scalar;
  num_lanes: Scalar;
  speed_mph: Scalar;
  vc_ratio: Scalar;
}

/** What the map was showing when the session was created. */
export interface SnapshotAnchor {
  /** Pacific-local date, `YYYY-MM-DD`. */
  day: string;
  /** 0..95 quarter-hour index of the Pacific-local day. */
  bucket: number;
  /** Corridor filter, or the `ALL` sentinel. */
  corridor: string;
}

export interface SnapshotContext {
  anchor: SnapshotAnchor;
  localTime: string;
  localHour: number;
  network: NetworkRow | null;
  corridors: CorridorRow[];
  los: LosRow[];
  incidents: IncidentRow[];
  /** True incident total at this bucket — may exceed `incidents.length`. */
  incidentTotal: number;
  /** The rendered brief handed to the model. */
  text: string;
  /** Size of `text` in bytes, for cost/latency reporting. */
  bytes: number;
  /** Wall-clock ms for the DBSQL round-trips. */
  queryMs: number;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Coerce a wire scalar to a number, or null.
 *
 * Returns null rather than NaN for absent/unparseable values so callers must decide how to
 * render "missing" instead of silently printing `NaN` into a prompt — a model shown `NaN`
 * will happily narrate around it.
 */
export function num(v: Scalar): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Format a number for the brief, or `n/a`. Avoids `NaN`/`undefined` reaching the model. */
function fmt(v: Scalar, digits = 1): string {
  const n = num(v);
  if (n === null) return 'n/a';
  return Number.isInteger(n) && digits === 0 ? String(n) : n.toFixed(digits);
}

/** Integers with thousands separators — easier for a model to read back correctly. */
function int(v: Scalar): string {
  const n = num(v);
  if (n === null) return 'n/a';
  return Math.round(n).toLocaleString('en-US');
}

/**
 * Pacific-local wall time for a bucket index. Mirrors `bucketToLocalTime` in
 * client/src/lib/frames.ts so the chat header and the map clock cannot disagree.
 */
export function bucketToLocalTime(bucket: number): string {
  const b = ((Math.round(bucket) % BUCKETS_PER_DAY) + BUCKETS_PER_DAY) % BUCKETS_PER_DAY;
  const h = Math.floor(b / 4);
  const m = (b % 4) * 15;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function bucketToLocalHour(bucket: number): number {
  const b = ((Math.round(bucket) % BUCKETS_PER_DAY) + BUCKETS_PER_DAY) % BUCKETS_PER_DAY;
  return Math.floor(b / 4);
}

/**
 * Peak-period label. Purely descriptive — it tells the model *which operational period it
 * is reasoning about* (AM peak vs midday vs PM peak vs overnight), because the appropriate
 * response to oversaturation differs by period: ramp metering is a peak-period tool,
 * overnight congestion usually means an incident rather than demand.
 *
 * Boundaries follow the dataset's verified peaks at 07:00 and 17:00 Pacific.
 */
export function peakPeriodLabel(hour: number): string {
  if (hour >= 6 && hour < 10) return 'AM peak';
  if (hour >= 15 && hour < 19) return 'PM peak';
  if (hour >= 10 && hour < 15) return 'midday off-peak';
  if (hour >= 19 && hour < 23) return 'evening';
  return 'overnight';
}

/**
 * Render the brief.
 *
 * PURE — no I/O, no clock, no randomness. This is the function the tests pin, because it
 * defines exactly which numbers the model is permitted to cite.
 *
 * Format is plain labelled text rather than JSON: at this size it costs fewer tokens than
 * JSON's structural punctuation, and the units travel next to the values ("26.2 mph", not
 * a bare `26.2` whose unit lives in a schema the model has to remember).
 */
export function formatSnapshotContext(input: {
  anchor: SnapshotAnchor;
  network: NetworkRow | null;
  corridors: CorridorRow[];
  los: LosRow[];
  incidents: IncidentRow[];
  incidentTotal: number;
}): string {
  const { anchor, network, corridors, los, incidents, incidentTotal } = input;
  const localTime = bucketToLocalTime(anchor.bucket);
  const hour = bucketToLocalHour(anchor.bucket);
  const scope =
    anchor.corridor === ALL_CORRIDORS
      ? 'entire monitored network (all corridors)'
      : `corridor ${anchor.corridor} only`;

  const lines: string[] = [];

  lines.push('# TRAFFIC SNAPSHOT');
  lines.push(
    `Date ${anchor.day} (Pacific local) · time ${localTime} PT · ${peakPeriodLabel(hour)} · scope: ${scope}`,
  );
  lines.push(
    'This is a single 15-minute observation bucket, not a daily average or a trend.',
  );
  lines.push('');

  if (!network || num(network.station_count) === null || num(network.station_count) === 0) {
    // An empty snapshot is a legitimate state (corridor with no stations, day outside the
    // generated range). Say so explicitly — the alternative is a brief full of `n/a` that
    // invites the model to fill the gaps.
    lines.push(
      'NO DATA: the warehouse returned no detector readings for this date/time/corridor ' +
        'combination. Do not speculate about conditions; report that the snapshot is empty.',
    );
    return lines.join('\n');
  }

  const demanded = num(network.total_demanded_flow_vph);
  const served = num(network.total_served_flow_vph);

  lines.push('## NETWORK TOTALS');
  lines.push(`- Detector stations reporting: ${int(network.station_count)}`);
  lines.push(
    `- Mean speed: ${fmt(network.mean_speed_mph)} mph (mean free-flow speed ${fmt(network.mean_free_flow_mph)} mph)`,
  );
  lines.push(`- Lowest station speed: ${fmt(network.min_speed_mph)} mph`);
  lines.push(
    `- Mean delay vs free-flow: ${fmt(network.mean_delay_min_per_mi, 3)} min per mile`,
  );
  lines.push(
    `- Mean v/c: ${fmt(network.mean_vc, 3)} · highest single-station v/c: ${fmt(network.max_vc, 2)}`,
  );
  lines.push(
    `- Stations with v/c > 1 (demand exceeds capacity): ${int(network.stations_over_capacity)} of ${int(network.station_count)}`,
  );
  lines.push(`- Stations flagged congested: ${int(network.stations_congested)}`);
  lines.push(`- Stations with an active incident: ${int(network.stations_with_incident)}`);
  lines.push(`- Total demanded flow: ${int(network.total_demanded_flow_vph)} veh/h`);
  lines.push(`- Total served flow: ${int(network.total_served_flow_vph)} veh/h`);
  if (demanded !== null && served !== null && demanded > served) {
    // Spelled out because it is the single most decision-relevant fact in the brief and the
    // subtraction is exactly the kind of arithmetic a model gets wrong when asked to infer it.
    lines.push(
      `- Unserved demand (demanded − served): ${int(demanded - served)} veh/h, i.e. ` +
        `${(((demanded - served) / demanded) * 100).toFixed(1)}% of demand is not being served at this bucket`,
    );
  }
  lines.push('');

  if (los.length > 0) {
    const total = los.reduce((acc, r) => acc + (num(r.station_count) ?? 0), 0);
    const parts = los.map((r) => {
      const n = num(r.station_count) ?? 0;
      const pct = total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
      return `LOS ${r.los}: ${int(r.station_count)} (${pct}%)`;
    });
    lines.push('## LEVEL OF SERVICE DISTRIBUTION');
    lines.push(`- ${parts.join(' · ')}`);
    lines.push('- LOS F is breakdown/forced-flow; LOS A is free-flow.');
    lines.push('');
  }

  if (corridors.length > 0) {
    lines.push(
      `## WORST CORRIDOR-DIRECTIONS (top ${Math.min(corridors.length, WORST_CORRIDOR_LIMIT)} by mean delay per mile)`,
    );
    for (const c of corridors) {
      const d = num(c.demanded_flow_vph);
      const s = num(c.served_flow_vph);
      const unserved = d !== null && s !== null && d > s ? `, unserved ${int(d - s)} veh/h` : '';
      lines.push(
        `- ${c.freeway} ${c.direction}: ${fmt(c.mean_speed_mph)} mph vs ${fmt(c.free_flow_mph)} mph free-flow · ` +
          `delay ${fmt(c.mean_delay_min_per_mi, 3)} min/mi · mean v/c ${fmt(c.mean_vc, 2)} (max ${fmt(c.max_vc, 2)}) · ` +
          `${int(c.stations_over_capacity)}/${int(c.station_count)} stations over capacity · ` +
          `${int(c.incident_count)} incident station(s), max ${int(c.max_lanes_blocked)} lane(s) blocked${unserved}`,
      );
    }
    lines.push('');
  }

  lines.push('## ACTIVE INCIDENTS');
  if (incidentTotal === 0) {
    lines.push('- None active in this snapshot.');
  } else {
    if (incidents.length < incidentTotal) {
      // Never let a truncated list read as complete.
      lines.push(
        `- ${incidentTotal} incident-affected stations total; the ${incidents.length} most severe are listed ` +
          `(list truncated at ${INCIDENT_LIMIT}).`,
      );
    } else {
      lines.push(`- ${incidentTotal} incident-affected station(s), all listed:`);
    }
    for (const i of incidents) {
      const place = [i.city, i.county].filter((x) => x !== null && x !== undefined && x !== '');
      const where = place.length > 0 ? ` (${place.join(', ')})` : '';
      lines.push(
        `- ${i.freeway} ${i.direction} @ postmile ${fmt(i.postmile)}${where}: severity ${int(i.severity)}, ` +
          `${int(i.lanes_blocked)} of ${int(i.num_lanes)} lane(s) blocked, ` +
          `speed ${fmt(i.speed_mph)} mph, v/c ${fmt(i.vc_ratio, 2)} · station ${i.station_id}`,
      );
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the analytics plugin handle this module needs.
 *
 * The parameter map is typed as the plugin types it — `SQLTypeMarker | null | undefined`,
 * not `unknown`. Widening it to `unknown` would look harmless but makes the plugin's own
 * handle unassignable (parameters are contravariant), and, worse, would let a caller pass a
 * bare string where a typed marker is required — which Databricks binds as a literal rather
 * than a parameter.
 */
/**
 * The plugin does not re-export its `SQLTypeMarker` union type (only the `isSQLTypeMarker`
 * guard), so derive it from the `sql` helper object rather than restating the union by hand —
 * a restated union would silently drift if a marker kind is added.
 *
 * `ReturnType<typeof sql.string>` alone would only capture the STRING variant, which then
 * rejects `sql.date(...)`; mapping over every key and taking the union of return types gives
 * the whole marker set.
 */
type SqlMarker = ReturnType<(typeof sql)[keyof typeof sql]>;

export interface AnalyticsLike {
  query: (
    text: string,
    params?: Record<string, SqlMarker | null | undefined>,
    formatParameters?: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

/**
 * AppKit's `analytics.query` resolves to the plugin's ExecutionResult-ish envelope. Pull
 * the rows out tolerantly: the envelope shape is not part of the plugin's public typed
 * contract, so match on what is present rather than asserting one shape.
 */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>;
    for (const key of ['rows', 'data', 'result']) {
      const v = r[key];
      if (Array.isArray(v)) return v as T[];
      // one level of nesting, e.g. { data: { rows: [...] } }
      if (v && typeof v === 'object') {
        const inner = (v as Record<string, unknown>).rows ?? (v as Record<string, unknown>).data;
        if (Array.isArray(inner)) return inner as T[];
      }
    }
  }
  return [];
}

/**
 * Query the warehouse and render the brief.
 *
 * The four queries run in parallel — they are independent rollups of the same bucket, and
 * serialising them would multiply the user-visible latency before the model is even called.
 */
export async function buildSnapshotContext(
  analytics: AnalyticsLike,
  anchor: SnapshotAnchor,
  signal?: AbortSignal,
): Promise<SnapshotContext> {
  const params = {
    day: sql.date(anchor.day),
    freeway: sql.string(anchor.corridor),
    bucket: sql.int(anchor.bucket),
  };

  const started = Date.now();
  const [networkRes, corridorRes, losRes, incidentRes] = await Promise.all([
    analytics.query(NETWORK_SQL, params, undefined, signal),
    analytics.query(CORRIDOR_SQL, params, undefined, signal),
    analytics.query(LOS_SQL, params, undefined, signal),
    analytics.query(INCIDENT_SQL, params, undefined, signal),
  ]);
  const queryMs = Date.now() - started;

  const network = rowsOf<NetworkRow>(networkRes)[0] ?? null;
  const corridors = rowsOf<CorridorRow>(corridorRes);
  const los = rowsOf<LosRow>(losRes);
  const incidents = rowsOf<IncidentRow>(incidentRes);

  // The network rollup counts ALL incident-affected stations; the incident list is capped.
  // Trust the rollup for the total so truncation is always reported honestly.
  const incidentTotal = num(network?.stations_with_incident) ?? incidents.length;

  const text = formatSnapshotContext({ anchor, network, corridors, los, incidents, incidentTotal });

  return {
    anchor,
    localTime: bucketToLocalTime(anchor.bucket),
    localHour: bucketToLocalHour(anchor.bucket),
    network,
    corridors,
    los,
    incidents,
    incidentTotal,
    text,
    bytes: Buffer.byteLength(text, 'utf8'),
    queryMs,
  };
}

/**
 * The compact KPI object persisted on the session row (`snapshot_kpis` JSONB).
 *
 * Deliberately NOT the full brief text — the brief is reproducible from these numbers plus
 * the formatter, and storing prose in a JSONB column makes it unqueryable. The corridor
 * list is kept because "which corridor was worst when this advice was given" is the first
 * question anyone reading an old session asks.
 */
export function snapshotKpis(ctx: SnapshotContext): Record<string, unknown> {
  return {
    station_count: num(ctx.network?.station_count),
    mean_speed_mph: num(ctx.network?.mean_speed_mph),
    min_speed_mph: num(ctx.network?.min_speed_mph),
    mean_vc: num(ctx.network?.mean_vc),
    max_vc: num(ctx.network?.max_vc),
    stations_over_capacity: num(ctx.network?.stations_over_capacity),
    stations_congested: num(ctx.network?.stations_congested),
    stations_with_incident: num(ctx.network?.stations_with_incident),
    total_demanded_flow_vph: num(ctx.network?.total_demanded_flow_vph),
    total_served_flow_vph: num(ctx.network?.total_served_flow_vph),
    mean_delay_min_per_mi: num(ctx.network?.mean_delay_min_per_mi),
    incident_total: ctx.incidentTotal,
    los: ctx.los.map((r) => ({ los: r.los, station_count: num(r.station_count) })),
    worst_corridors: ctx.corridors.slice(0, WORST_CORRIDOR_LIMIT).map((c) => ({
      freeway: c.freeway,
      direction: c.direction,
      mean_speed_mph: num(c.mean_speed_mph),
      mean_delay_min_per_mi: num(c.mean_delay_min_per_mi),
      mean_vc: num(c.mean_vc),
      stations_over_capacity: num(c.stations_over_capacity),
      station_count: num(c.station_count),
    })),
    context_bytes: ctx.bytes,
    query_ms: ctx.queryMs,
  };
}
