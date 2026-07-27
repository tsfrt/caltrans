/**
 * Validate a `ScenarioRequest` and bind it to the engine's flat SQL parameters.
 *
 * The engine's SQL declares 34 `:name` parameters, all of them REQUIRED — DBSQL
 * has no notion of an unbound parameter, and AppKit's `sql.*` helpers have no
 * null. So every lever is expressed as a SENTINEL that means "off":
 *
 *     freeway/direction   ''    (empty string)
 *     lane counts         0
 *     percent             0
 *     scale               1.0
 *     absolute override  -1
 *
 * `bindScenario({day})` therefore produces the exact binding set that makes the
 * engine a provable no-op. That is why the sentinels are here and not in the SQL:
 * one place decides what "off" means, and the no-op proof tests exactly it.
 *
 * Validation is strict and fails closed. A lever with a nonsensical target
 * (unknown corridor, inverted postmile window, 0 lanes closed) is a REJECTED
 * request, not a silently-ignored one — a scenario that quietly does nothing is
 * indistinguishable from a working baseline on the map, which is the worst
 * possible failure mode for this UI.
 */

import type { ScenarioRequest } from './contract.js';

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
 * NOT the textbook (0.15, 4.0) and NOT the Lakebase `app.config` seed, which
 * still holds the textbook values. The generator wins because the engine is
 * incremental: it divides one BPR factor by another, and internal consistency
 * with the curve that produced the data is what makes a lever-free scenario an
 * exact no-op. See `docs/WHATIF_ENGINE.md` §2 for the full argument and for how
 * to override these from Lakebase once that row is corrected.
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

export class ScenarioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioValidationError';
  }
}

const fail = (message: string): never => {
  throw new ScenarioValidationError(message);
};

/** SQL parameter values, as AppKit's analytics plugin accepts them. */
export type ScenarioParams = Record<string, string | number>;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  if (typeof value !== 'string' || value.length === 0) {
    return fail(`${label} is required`);
  }
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
 * Resolve an optional postmile window to a concrete, ordered pair.
 * Omitting both ends means the whole corridor — deliberately permissive, because
 * "close a lane on I-405" is a reasonable thing for a UI to ask.
 */
const postmiles = (from: number | undefined, to: number | undefined, label: string): [number, number] => {
  if (from === undefined && to === undefined) return [PM_MIN, PM_MAX];
  const lo = from === undefined ? PM_MIN : finite(from, `${label}.postmileFrom`);
  const hi = to === undefined ? PM_MAX : finite(to, `${label}.postmileTo`);
  if (hi < lo) return fail(`${label}.postmileTo (${hi}) must be >= postmileFrom (${lo})`);
  return [lo, hi];
};

/**
 * Flatten a validated request into the engine's parameter set.
 *
 * Returns EVERY parameter on every call, sentinel-valued where a lever is off,
 * because a partially-bound statement is a DBSQL error rather than a default.
 */
export function bindScenario(request: ScenarioRequest): ScenarioParams {
  if (!request || typeof request !== 'object') return fail('request must be an object');

  const { day } = request;
  if (typeof day !== 'string' || !DAY_RE.test(day)) {
    return fail(`day must be a YYYY-MM-DD Pacific-local date, got ${JSON.stringify(day)}`);
  }

  const freeway =
    request.freeway === undefined || request.freeway === 'ALL' ? 'ALL' : corridor(request.freeway, 'freeway');

  // Windows must start on a window boundary: the client fetches the day as four
  // 24-bucket windows and indexes them by `(bucket - first_bucket)`, so an
  // off-grid start would silently misalign the animation rather than error.
  const fromBucket =
    request.fromBucket === undefined
      ? DEFAULTS.fromBucket
      : intInRange(request.fromBucket, 'fromBucket', 0, BUCKETS_PER_DAY - WINDOW_BUCKETS);
  if (fromBucket % WINDOW_BUCKETS !== 0) {
    fail(`fromBucket must be a multiple of ${WINDOW_BUCKETS}, got ${fromBucket}`);
  }

  const iterations =
    request.iterations === undefined
      ? DEFAULTS.iterations
      : intInRange(request.iterations, 'iterations', 0, MAX_ITERATIONS);

  const worstN = request.worstN === undefined ? DEFAULTS.worstN : intInRange(request.worstN, 'worstN', 1, 500);

  // ── BPR ──────────────────────────────────────────────────────────────────
  // alpha 0 would make the model insensitive to congestion (every travel-time
  // factor 1.0, every scenario a no-op), so it is rejected rather than accepted
  // as a silently inert configuration. beta below 1 is not a BPR curve.
  const alpha =
    request.bpr?.alpha === undefined ? DEFAULTS.bpr.alpha : fractionInRange(request.bpr.alpha, 'bpr.alpha', 0.001, 5);
  const beta =
    request.bpr?.beta === undefined ? DEFAULTS.bpr.beta : fractionInRange(request.bpr.beta, 'bpr.beta', 1, 10);

  // ── reassignment ─────────────────────────────────────────────────────────
  const r = request.reassignment ?? {};
  const share =
    r.share === undefined ? DEFAULTS.reassignment.share : fractionInRange(r.share, 'reassignment.share', 0, 1);
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

  const params: ScenarioParams = {
    day,
    freeway,
    from_bucket: fromBucket,
    bpr_alpha: alpha,
    bpr_beta: beta,
    msa_iterations: iterations,
    worst_n: worstN,
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

  // ── lever 1: closure ─────────────────────────────────────────────────────
  if (request.closure) {
    const c = request.closure;
    const [pmFrom, pmTo] = postmiles(c.postmileFrom, c.postmileTo, 'closure');
    // A station's lane count is not known here (it varies per station along the
    // corridor), so the upper bound is the widest freeway in the data. The SQL
    // floors surviving capacity at 5% per station, so over-closing a narrow
    // station degrades gracefully rather than dividing by zero.
    params.close_freeway = corridor(c.freeway, 'closure.freeway');
    params.close_direction = direction(c.direction, 'closure.direction');
    params.close_pm_from = pmFrom;
    params.close_pm_to = pmTo;
    params.close_lanes = intInRange(c.lanes, 'closure.lanes', 1, 8);
  }

  // ── lever 2: demand delta ────────────────────────────────────────────────
  if (request.demand) {
    const d = request.demand;
    params.demand_freeway = d.freeway === 'ALL' ? 'ALL' : corridor(d.freeway, 'demand.freeway');
    params.demand_direction = direction(d.direction, 'demand.direction');
    // -100% is total suppression; the engine clamps the multiplier at 0 anyway.
    // +200% is an arbitrary but deliberate ceiling: beyond it the BPR curve is
    // extrapolating far past any calibration and the output stops being defensible.
    const pct = fractionInRange(d.percent, 'demand.percent', -100, 200);
    if (pct === 0) fail('demand.percent of 0 has no effect; omit the lever instead');
    params.demand_pct = pct;
  }

  // ── lever 3: incident injection ──────────────────────────────────────────
  if (request.incident) {
    const i = request.incident;
    const [pmFrom, pmTo] = postmiles(i.postmileFrom, i.postmileTo, 'incident');
    const fromB = intInRange(i.fromBucket, 'incident.fromBucket', 0, BUCKETS_PER_DAY - 1);
    const toB = intInRange(i.toBucket, 'incident.toBucket', 0, BUCKETS_PER_DAY - 1);
    if (toB < fromB) {
      fail(`incident.toBucket (${toB}) must be >= incident.fromBucket (${fromB})`);
    }
    if (i.severity !== undefined && ![1, 2, 3, 4].includes(i.severity)) {
      fail(`incident.severity must be 1..4, got ${i.severity}`);
    }
    params.incident_freeway = corridor(i.freeway, 'incident.freeway');
    params.incident_direction = direction(i.direction, 'incident.direction');
    params.incident_pm_from = pmFrom;
    params.incident_pm_to = pmTo;
    params.incident_lanes_blocked = intInRange(i.lanesBlocked, 'incident.lanesBlocked', 1, 8);
    params.incident_from_bucket = fromB;
    params.incident_to_bucket = toB;
  }

  // ── lever 4: capacity change ─────────────────────────────────────────────
  if (request.capacity) {
    const c = request.capacity;
    const [pmFrom, pmTo] = postmiles(c.postmileFrom, c.postmileTo, 'capacity');
    const addLanes = c.addLanes === undefined ? 0 : intInRange(c.addLanes, 'capacity.addLanes', -8, 8);
    const scale = c.scale === undefined ? 1 : fractionInRange(c.scale, 'capacity.scale', 0.05, 5);
    const abs = c.absoluteVph === undefined ? -1 : fractionInRange(c.absoluteVph, 'capacity.absoluteVph', 1, 100000);
    if (addLanes === 0 && scale === 1 && abs === -1) {
      fail('capacity lever has no effect: set addLanes, scale or absoluteVph');
    }
    params.capacity_freeway = corridor(c.freeway, 'capacity.freeway');
    params.capacity_direction = direction(c.direction, 'capacity.direction');
    params.capacity_pm_from = pmFrom;
    params.capacity_pm_to = pmTo;
    params.capacity_add_lanes = addLanes;
    params.capacity_scale = scale;
    params.capacity_abs_vph = abs;
  }

  return params;
}

/** True when no lever is set, i.e. the engine must reproduce the source data. */
export function isBaseline(request: ScenarioRequest): boolean {
  return !request.closure && !request.demand && !request.incident && !request.capacity;
}

/**
 * The four `fromBucket` values that cover one whole day.
 * Exported so the client and any server-side prefetch agree on the windowing
 * rather than each hardcoding `[0, 24, 48, 72]`.
 */
export function dayWindows(): number[] {
  const windows: number[] = [];
  for (let b = 0; b < BUCKETS_PER_DAY; b += WINDOW_BUCKETS) windows.push(b);
  return windows;
}
