/**
 * Bind a scenario request to the engine's flat SQL parameters, as `sql.*` markers.
 *
 * ── Why this is on the client ────────────────────────────────────────────────
 * Both engine queries are in the generated `QueryRegistry`
 * (`shared/appkit-types/analytics.d.ts`), so the client calls them through
 * `useAnalyticsQuery` exactly as M1 fetches its baseline — same SSE transport,
 * same per-query cache, same generated row types. No Express route sits in
 * between, so the binder has to be here.
 *
 * This is a port of `server/scenario/params.ts` and it keeps that file's sentinel
 * discipline verbatim. The engine's SQL declares every parameter REQUIRED (DBSQL
 * has no unbound parameter and `sql.*` has no null), so every lever is expressed
 * as a SENTINEL meaning "off":
 *
 *     freeway/direction   ''    (empty string)
 *     lane counts         0
 *     percent             0
 *     scale               1.0
 *     absolute override  -1
 *
 * A lever-free request therefore produces the binding set that makes the engine a
 * provable no-op, which is load-bearing: the client uses M1's baseline matrix as
 * the "before" side of every diff, and that is only legitimate because the engine
 * reproduces `gold_map_frames` bit-for-bit when no lever is set. Change a sentinel
 * and you silently break the diff, not just this file.
 *
 * ── Why TWO exported binders and not one ────────────────────────────────────
 * The two queries take DIFFERENT parameter sets. `scenario_time_matrix`
 * references `:from_bucket` and never `:worst_n`; `scenario_kpis` is the reverse.
 * Both declare all 34 in their `-- @param` header (typegen reads that), but
 * AppKit validates against the `:name` occurrences in the SQL BODY and THROWS on
 * any key the body does not mention:
 *
 *     Invalid value for worst_n: expected a parameter defined in the query
 *     (valid: day, from_bucket, ...)
 *
 * Verified against `appkit/dist/plugins/analytics/query.js:convertToSQLParameters`.
 * DBSQL itself tolerates the extra parameter, so this failure is purely AppKit's
 * validation layer — which is exactly why SQL-level testing never surfaced it.
 * Sending one 34-key object to both queries cannot work; hence `matrixParams`
 * and `kpiParams`, each emitting precisely the 32 keys its query references.
 */

import { sql } from '@databricks/appkit-ui/js';
import type { QueryRegistry } from '@databricks/appkit-ui/react';

/** Corridors present in `lanl.caltrans_traffic`. */
export const CORRIDORS = [
  'I-5',
  'I-10',
  'I-15',
  'I-80',
  'I-210',
  'I-405',
  'I-680',
  'I-880',
  'SR-99',
  'US-101',
] as const;

export const DIRECTIONS = ['N', 'S', 'E', 'W'] as const;

/** MSA iterations unrolled in the generated SQL. Requests above this are invalid. */
export const MAX_ITERATIONS = 4;

/** 15-minute buckets in one Pacific-local day. */
export const BUCKETS_PER_DAY = 96;

/** Buckets in one output window of `scenario_time_matrix.sql`. */
export const WINDOW_BUCKETS = 24;

/**
 * Engine defaults. `bpr.alpha`/`bpr.beta` match the DATA GENERATOR (0.55/4.5),
 * NOT the textbook (0.15/4.0) and NOT the Lakebase `app.config` seed, which still
 * holds the textbook values.
 *
 * The generator wins because the engine is INCREMENTAL: it divides one BPR factor
 * by another, so the coefficients must be the ones that produced the data or every
 * scenario measures a change against a curve the baseline was never on.
 *
 * ⚠️ Do NOT switch these to read from Lakebase `app.config` until that seed is
 * corrected to 0.55/4.5 — doing so silently moves every scenario onto the
 * textbook curve. See `docs/WHATIF_ENGINE.md` §2.
 */
export const DEFAULTS = {
  freeway: 'ALL',
  fromBucket: 0,
  iterations: MAX_ITERATIONS,
  worstN: 10,
  bpr: { alpha: 0.55, beta: 4.5 },
  reassignment: {
    share: 0.35,
    offNetworkShare: 0.3,
    maxParallelDistanceM: 8000,
    maxParallelBearingDeg: 45,
  },
} as const;

/** A postmile range wide enough to mean "the whole corridor". */
const PM_MIN = -1;
const PM_MAX = 100000;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export class ScenarioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioValidationError';
  }
}

const fail = (message: string): never => {
  throw new ScenarioValidationError(message);
};

// ── the request shape (mirrors server/scenario/contract.ts) ──────────────────

export interface SegmentTarget {
  freeway: string;
  direction?: string;
  postmileFrom?: number;
  postmileTo?: number;
}

export interface EngineClosureLever extends SegmentTarget {
  lanes: number;
}

export interface EngineDemandLever {
  freeway: string;
  direction?: string;
  percent: number;
}

export interface EngineIncidentLever extends SegmentTarget {
  lanesBlocked: number;
  fromBucket: number;
  toBucket: number;
  severity?: 1 | 2 | 3 | 4;
}

export interface EngineCapacityLever extends SegmentTarget {
  addLanes?: number;
  scale?: number;
  absoluteVph?: number;
}

export interface ScenarioRequest {
  day: string;
  freeway?: string;
  iterations?: number;
  worstN?: number;
  closure?: EngineClosureLever;
  demand?: EngineDemandLever;
  incident?: EngineIncidentLever;
  capacity?: EngineCapacityLever;
  reassignment?: {
    share?: number;
    offNetworkShare?: number;
    maxParallelDistanceM?: number;
    maxParallelBearingDeg?: number;
  };
  bpr?: { alpha?: number; beta?: number };
}

/**
 * Parameter types straight from the generated registry, so a `-- @param` rename
 * in the SQL breaks the build here rather than at runtime in the browser.
 */
export type MatrixParams = QueryRegistry['scenario_time_matrix']['parameters'];
export type KpiParams = QueryRegistry['scenario_kpis']['parameters'];

// ── validators ──────────────────────────────────────────────────────────────

const finite = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(`${label} must be a finite number`);
  }
  return value;
};

const intInRange = (value: unknown, label: string, lo: number, hi: number): number => {
  const n = finite(value, label);
  if (!Number.isInteger(n) || n < lo || n > hi) {
    return fail(`${label} must be an integer in [${lo}, ${hi}], got ${n}`);
  }
  return n;
};

const fractionInRange = (value: unknown, label: string, lo: number, hi: number): number => {
  const n = finite(value, label);
  if (n < lo || n > hi) return fail(`${label} must be in [${lo}, ${hi}], got ${n}`);
  return n;
};

const corridor = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) return fail(`${label} is required`);
  if (!(CORRIDORS as readonly string[]).includes(value)) {
    return fail(`${label} must be one of ${CORRIDORS.join(', ')}, got ${JSON.stringify(value)}`);
  }
  return value;
};

/** `''` means both carriageways. */
const direction = (value: unknown, label: string): string => {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || !(DIRECTIONS as readonly string[]).includes(value)) {
    return fail(`${label} must be one of ${DIRECTIONS.join(', ')} or omitted, got ${JSON.stringify(value)}`);
  }
  return value;
};

/**
 * Resolve an optional postmile window to a concrete, ordered pair. Omitting both
 * ends means the whole corridor — deliberately permissive, because "close a lane
 * on I-405" is a reasonable thing for a UI to ask.
 */
const postmiles = (from: number | undefined, to: number | undefined, label: string): [number, number] => {
  if (from === undefined && to === undefined) return [PM_MIN, PM_MAX];
  const lo = from === undefined ? PM_MIN : finite(from, `${label}.postmileFrom`);
  const hi = to === undefined ? PM_MAX : finite(to, `${label}.postmileTo`);
  if (hi < lo) return fail(`${label}.postmileTo (${hi}) must be >= postmileFrom (${lo})`);
  return [lo, hi];
};

/**
 * The engine parameters common to BOTH queries, as plain values.
 *
 * Kept as numbers/strings here and wrapped in `sql.*` markers by the two public
 * binders, so the validation logic exists once and the marker types stay exact.
 */
interface CommonBinding {
  day: string;
  freeway: string;
  bpr_alpha: number;
  bpr_beta: number;
  msa_iterations: number;
  reassign_share: number;
  reassign_offnetwork_share: number;
  parallel_max_dist_m: number;
  parallel_max_bearing_deg: number;
  close_freeway: string;
  close_direction: string;
  close_pm_from: number;
  close_pm_to: number;
  close_lanes: number;
  demand_freeway: string;
  demand_direction: string;
  demand_pct: number;
  incident_freeway: string;
  incident_direction: string;
  incident_pm_from: number;
  incident_pm_to: number;
  incident_lanes_blocked: number;
  incident_from_bucket: number;
  incident_to_bucket: number;
  capacity_freeway: string;
  capacity_direction: string;
  capacity_pm_from: number;
  capacity_pm_to: number;
  capacity_add_lanes: number;
  capacity_scale: number;
  capacity_abs_vph: number;
}

/**
 * Validate a request and flatten it to the 31 parameters both queries share.
 *
 * Returns EVERY parameter on every call, sentinel-valued where a lever is off,
 * because a partially-bound statement is a DBSQL error rather than a default.
 *
 * Validation is strict and fails closed. A lever with a nonsensical target
 * (unknown corridor, inverted postmile window, 0 lanes closed) is a REJECTED
 * request, not a silently-ignored one — a scenario that quietly does nothing is
 * indistinguishable from a working baseline on the map, which is the worst
 * possible failure mode for this UI.
 */
function bindCommon(request: ScenarioRequest): CommonBinding {
  if (!request || typeof request !== 'object') return fail('request must be an object');

  const { day } = request;
  if (typeof day !== 'string' || !DAY_RE.test(day)) {
    return fail(`day must be a YYYY-MM-DD Pacific-local date, got ${JSON.stringify(day)}`);
  }

  const freeway =
    request.freeway === undefined || request.freeway === 'ALL' ? 'ALL' : corridor(request.freeway, 'freeway');

  const iterations =
    request.iterations === undefined
      ? DEFAULTS.iterations
      : intInRange(request.iterations, 'iterations', 0, MAX_ITERATIONS);

  // ── BPR ────────────────────────────────────────────────────────────────────
  // alpha 0 would make the model insensitive to congestion (every travel-time
  // factor 1.0, every scenario a no-op), so it is rejected rather than accepted
  // as a silently inert configuration. beta below 1 is not a BPR curve.
  const alpha =
    request.bpr?.alpha === undefined ? DEFAULTS.bpr.alpha : fractionInRange(request.bpr.alpha, 'bpr.alpha', 0.001, 5);
  const beta = request.bpr?.beta === undefined ? DEFAULTS.bpr.beta : fractionInRange(request.bpr.beta, 'bpr.beta', 1, 10);

  // ── reassignment ───────────────────────────────────────────────────────────
  const r = request.reassignment ?? {};
  const share = r.share === undefined ? DEFAULTS.reassignment.share : fractionInRange(r.share, 'reassignment.share', 0, 1);
  const offNetworkShare =
    r.offNetworkShare === undefined
      ? DEFAULTS.reassignment.offNetworkShare
      : fractionInRange(r.offNetworkShare, 'reassignment.offNetworkShare', 0, 1);
  const maxDistanceM =
    r.maxParallelDistanceM === undefined
      ? DEFAULTS.reassignment.maxParallelDistanceM
      : fractionInRange(r.maxParallelDistanceM, 'reassignment.maxParallelDistanceM', 0, 50000);
  const maxBearingDeg =
    r.maxParallelBearingDeg === undefined
      ? DEFAULTS.reassignment.maxParallelBearingDeg
      : fractionInRange(r.maxParallelBearingDeg, 'reassignment.maxParallelBearingDeg', 0, 180);

  const b: CommonBinding = {
    day,
    freeway,
    bpr_alpha: alpha,
    bpr_beta: beta,
    msa_iterations: iterations,
    reassign_share: share,
    reassign_offnetwork_share: offNetworkShare,
    parallel_max_dist_m: maxDistanceM,
    parallel_max_bearing_deg: maxBearingDeg,

    // every lever off
    close_freeway: '',
    close_direction: '',
    close_pm_from: 0,
    close_pm_to: 0,
    close_lanes: 0,
    demand_freeway: '',
    demand_direction: '',
    demand_pct: 0,
    incident_freeway: '',
    incident_direction: '',
    incident_pm_from: 0,
    incident_pm_to: 0,
    incident_lanes_blocked: 0,
    incident_from_bucket: 0,
    incident_to_bucket: 0,
    capacity_freeway: '',
    capacity_direction: '',
    capacity_pm_from: 0,
    capacity_pm_to: 0,
    capacity_add_lanes: 0,
    capacity_scale: 1,
    capacity_abs_vph: -1,
  };

  // ── lever 1: closure ───────────────────────────────────────────────────────
  if (request.closure) {
    const c = request.closure;
    const [pmFrom, pmTo] = postmiles(c.postmileFrom, c.postmileTo, 'closure');
    // A station's lane count is not known here (it varies per station along the
    // corridor), so the upper bound is the widest freeway in the data. The SQL
    // floors surviving capacity at 5% per station, so over-closing a narrow
    // station degrades gracefully rather than dividing by zero.
    b.close_freeway = corridor(c.freeway, 'closure.freeway');
    b.close_direction = direction(c.direction, 'closure.direction');
    b.close_pm_from = pmFrom;
    b.close_pm_to = pmTo;
    b.close_lanes = intInRange(c.lanes, 'closure.lanes', 1, 8);
  }

  // ── lever 2: demand delta ──────────────────────────────────────────────────
  if (request.demand) {
    const d = request.demand;
    b.demand_freeway = d.freeway === 'ALL' ? 'ALL' : corridor(d.freeway, 'demand.freeway');
    b.demand_direction = direction(d.direction, 'demand.direction');
    // -100% is total suppression; the engine clamps the multiplier at 0 anyway.
    // +200% is an arbitrary but deliberate ceiling: beyond it the BPR curve is
    // extrapolating far past any calibration and the output stops being defensible.
    const pct = fractionInRange(d.percent, 'demand.percent', -100, 200);
    if (pct === 0) fail('demand.percent of 0 has no effect; omit the lever instead');
    b.demand_pct = pct;
  }

  // ── lever 3: incident injection ────────────────────────────────────────────
  if (request.incident) {
    const i = request.incident;
    const [pmFrom, pmTo] = postmiles(i.postmileFrom, i.postmileTo, 'incident');
    const fromB = intInRange(i.fromBucket, 'incident.fromBucket', 0, BUCKETS_PER_DAY - 1);
    const toB = intInRange(i.toBucket, 'incident.toBucket', 0, BUCKETS_PER_DAY - 1);
    if (toB < fromB) fail(`incident.toBucket (${toB}) must be >= incident.fromBucket (${fromB})`);
    if (i.severity !== undefined && ![1, 2, 3, 4].includes(i.severity)) {
      fail(`incident.severity must be 1..4, got ${i.severity}`);
    }
    b.incident_freeway = corridor(i.freeway, 'incident.freeway');
    b.incident_direction = direction(i.direction, 'incident.direction');
    b.incident_pm_from = pmFrom;
    b.incident_pm_to = pmTo;
    b.incident_lanes_blocked = intInRange(i.lanesBlocked, 'incident.lanesBlocked', 1, 8);
    b.incident_from_bucket = fromB;
    b.incident_to_bucket = toB;
  }

  // ── lever 4: capacity change ───────────────────────────────────────────────
  if (request.capacity) {
    const c = request.capacity;
    const [pmFrom, pmTo] = postmiles(c.postmileFrom, c.postmileTo, 'capacity');
    const addLanes = c.addLanes === undefined ? 0 : intInRange(c.addLanes, 'capacity.addLanes', -8, 8);
    const scale = c.scale === undefined ? 1 : fractionInRange(c.scale, 'capacity.scale', 0.05, 5);
    const abs = c.absoluteVph === undefined ? -1 : fractionInRange(c.absoluteVph, 'capacity.absoluteVph', 1, 100000);
    if (addLanes === 0 && scale === 1 && abs === -1) {
      fail('capacity lever has no effect: set addLanes, scale or absoluteVph');
    }
    b.capacity_freeway = corridor(c.freeway, 'capacity.freeway');
    b.capacity_direction = direction(c.direction, 'capacity.direction');
    b.capacity_pm_from = pmFrom;
    b.capacity_pm_to = pmTo;
    b.capacity_add_lanes = addLanes;
    b.capacity_scale = scale;
    b.capacity_abs_vph = abs;
  }

  return b;
}

/**
 * Wrap the shared binding in `sql.*` markers.
 *
 * Every value MUST be a marker: AppKit's `_createParameter` rejects a raw string
 * or number outright ("expected SQL type (use sql.string(), ...)"). Types are
 * pinned per parameter to match the SQL's `-- @param` declarations — `sql.int`
 * for INT, `sql.double` for DOUBLE — rather than relying on `sql.number`'s
 * inference, which would bind the integral DOUBLE `capacity_scale: 1` as INT.
 */
function commonMarkers(b: CommonBinding) {
  return {
    day: sql.date(b.day),
    freeway: sql.string(b.freeway),
    bpr_alpha: sql.double(b.bpr_alpha),
    bpr_beta: sql.double(b.bpr_beta),
    msa_iterations: sql.int(b.msa_iterations),
    reassign_share: sql.double(b.reassign_share),
    reassign_offnetwork_share: sql.double(b.reassign_offnetwork_share),
    parallel_max_dist_m: sql.double(b.parallel_max_dist_m),
    parallel_max_bearing_deg: sql.double(b.parallel_max_bearing_deg),
    close_freeway: sql.string(b.close_freeway),
    close_direction: sql.string(b.close_direction),
    close_pm_from: sql.double(b.close_pm_from),
    close_pm_to: sql.double(b.close_pm_to),
    close_lanes: sql.int(b.close_lanes),
    demand_freeway: sql.string(b.demand_freeway),
    demand_direction: sql.string(b.demand_direction),
    demand_pct: sql.double(b.demand_pct),
    incident_freeway: sql.string(b.incident_freeway),
    incident_direction: sql.string(b.incident_direction),
    incident_pm_from: sql.double(b.incident_pm_from),
    incident_pm_to: sql.double(b.incident_pm_to),
    incident_lanes_blocked: sql.int(b.incident_lanes_blocked),
    incident_from_bucket: sql.int(b.incident_from_bucket),
    incident_to_bucket: sql.int(b.incident_to_bucket),
    capacity_freeway: sql.string(b.capacity_freeway),
    capacity_direction: sql.string(b.capacity_direction),
    capacity_pm_from: sql.double(b.capacity_pm_from),
    capacity_pm_to: sql.double(b.capacity_pm_to),
    capacity_add_lanes: sql.int(b.capacity_add_lanes),
    capacity_scale: sql.double(b.capacity_scale),
    capacity_abs_vph: sql.double(b.capacity_abs_vph),
  };
}

/**
 * Parameters for `scenario_time_matrix` — the 31 shared plus `from_bucket`.
 *
 * MUST NOT include `worst_n`: that query's body never mentions it and AppKit
 * throws on an unreferenced key.
 *
 * `fromBucket` must start on a window boundary: the client indexes each window by
 * `(bucket - first_bucket)`, so an off-grid start would silently misalign the
 * animation rather than error.
 */
export function matrixParams(request: ScenarioRequest, fromBucket: number): MatrixParams {
  const b = bindCommon(request);
  const from = intInRange(fromBucket, 'fromBucket', 0, BUCKETS_PER_DAY - WINDOW_BUCKETS);
  if (from % WINDOW_BUCKETS !== 0) {
    fail(`fromBucket must be a multiple of ${WINDOW_BUCKETS}, got ${from}`);
  }
  return { ...commonMarkers(b), from_bucket: sql.int(from) };
}

/**
 * Parameters for `scenario_kpis` — the 31 shared plus `worst_n`.
 *
 * MUST NOT include `from_bucket`: the KPI query aggregates the whole day and its
 * body never mentions it.
 */
export function kpiParams(request: ScenarioRequest): KpiParams {
  const b = bindCommon(request);
  const worstN = request.worstN === undefined ? DEFAULTS.worstN : intInRange(request.worstN, 'worstN', 1, 500);
  return { ...commonMarkers(b), worst_n: sql.int(worstN) };
}

/** True when no lever is set, i.e. the engine must reproduce the source data. */
export function isBaseline(request: ScenarioRequest): boolean {
  return !request.closure && !request.demand && !request.incident && !request.capacity;
}

/**
 * The four `fromBucket` values that cover one whole day.
 * Exported so every caller agrees on the windowing rather than hardcoding
 * `[0, 24, 48, 72]`.
 */
export function dayWindows(): number[] {
  const windows: number[] = [];
  for (let b = 0; b < BUCKETS_PER_DAY; b += WINDOW_BUCKETS) windows.push(b);
  return windows;
}
