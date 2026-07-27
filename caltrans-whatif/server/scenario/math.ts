/**
 * The engine's math, as pure TypeScript functions.
 *
 * ⚠️ These are NOT the code path the app runs. The scenario math executes in
 * DBSQL (`config/queries/scenario_*.sql`, generated from
 * `tools/scenario_sql/engine.py`) precisely so 191,424 station-buckets never
 * cross the wire. This module exists for three narrower reasons:
 *
 *   1. It is the executable specification of the formulas, so the unit tests can
 *      pin BPR / LOS / delay / VHT / VMT arithmetic without a warehouse.
 *   2. It documents the non-obvious choices (why the speed ceiling is not
 *      free-flow, why delay is pivoted additively) next to the arithmetic they
 *      apply to, rather than only in a SQL comment.
 *   3. The client can recompute a KPI on already-fetched arrays without a round
 *      trip, using the same definitions the panel used.
 *
 * `server/scenario/scenario.test.ts` asserts the constants here match
 * `tools/scenario_sql/engine.py`, so the two cannot drift silently.
 */

/** 15-minute bucket, in hours. Turns a vehicles/hour rate into vehicles. */
export const BUCKET_HOURS = 0.25;

/** Absolute speed floor (mph). Matches the data generator's MIN_SPEED_MPH. */
export const MIN_SPEED_MPH = 8.0;

/**
 * HCM freeway LOS thresholds on DEMAND-based v/c (upper bound of each grade).
 * Identical to `caltrans_traffic.config.LOS_THRESHOLDS`.
 */
export const LOS_THRESHOLDS: ReadonlyArray<readonly [string, number]> = [
  ['A', 0.35],
  ['B', 0.55],
  ['C', 0.77],
  ['D', 0.92],
  ['E', 1.0],
];

/** Extra capacity loss beyond the blocked lanes for an INCIDENT (rubbernecking). */
export const RUBBERNECK_CAPACITY_LOSS = 0.12;

/** Floor on any capacity factor, so a total closure keeps v/c finite. */
export const MIN_CAPACITY_FACTOR = 0.05;

/** BPR coefficients matching the data generator. See `docs/WHATIF_ENGINE.md` §2. */
export const BPR_ALPHA = 0.55;
export const BPR_BETA = 4.5;

/**
 * The BPR congestion multiplier on free-flow travel time: `1 + alpha*(v/c)^beta`.
 *
 * This is the only place BPR appears. The engine never evaluates BPR to get a
 * speed — it takes the RATIO of two factors and applies it to the observed speed
 * (`pivotSpeed` below), which is what makes a lever-free scenario an exact no-op.
 */
export function bprTravelTimeFactor(vc: number, alpha = BPR_ALPHA, beta = BPR_BETA): number {
  return 1 + alpha * Math.pow(Math.max(0, vc), beta);
}

/**
 * Absolute BPR speed. Provided for comparison against the generator's curve;
 * the engine does NOT use it, because `gold_map_frames` carries 2.5% measurement
 * jitter on top of this curve (measured MAE 0.75 mph over 191,424 rows) and
 * re-deriving speed would make the baseline visibly differ from the M1 map.
 */
export function bprSpeed(freeFlowMph: number, vc: number, alpha = BPR_ALPHA, beta = BPR_BETA): number {
  return Math.max(MIN_SPEED_MPH, freeFlowMph / bprTravelTimeFactor(vc, alpha, beta));
}

/**
 * Pivot-point speed: observed speed scaled by the modelled travel-time ratio.
 *
 * The ceiling is `max(freeFlowMph, speedBefore)`, NOT `freeFlowMph`. Measured:
 * 62,976 of 191,424 rows in one day have `avg_speed_mph` ABOVE
 * `free_flow_speed_mph` (by up to 4.0 mph) because of the generator's jitter, so
 * a bare free-flow ceiling silently trimmed a third of the baseline and broke the
 * no-op on speed while it still passed on v/c.
 */
export function pivotSpeed(
  speedBefore: number,
  vcBefore: number,
  vcAfter: number,
  freeFlowMph: number,
  alpha = BPR_ALPHA,
  beta = BPR_BETA
): number {
  const ratio = bprTravelTimeFactor(vcBefore, alpha, beta) / bprTravelTimeFactor(vcAfter, alpha, beta);
  const ceiling = Math.max(freeFlowMph, speedBefore);
  return Math.min(ceiling, Math.max(MIN_SPEED_MPH, speedBefore * ratio));
}

/** HCM LOS grade A–F from demand-based v/c. */
export function levelOfService(vc: number): string {
  for (const [grade, upper] of LOS_THRESHOLDS) {
    if (vc < upper) return grade;
  }
  return 'F';
}

/** Extra minutes to travel one mile versus free-flow. Never negative. */
export function delayMinPerMile(speedMph: number, freeFlowMph: number): number {
  if (speedMph <= 0 || freeFlowMph <= 0) return 0;
  return Math.max(0, 60 / speedMph - 60 / freeFlowMph);
}

/**
 * Delay pivoted ADDITIVELY: observed delay plus the modelled change.
 *
 * The stored `delay_vs_freeflow_min_per_mi` is the mean of the per-5-minute
 * delays in the bucket, and delay is convex in speed, so by Jensen it exceeds the
 * delay implied by the bucket's mean speed — measured up to 3.08 min/mi higher on
 * oversaturated rows. Recomputing "after" from speed while reading "before" from
 * the table would report a large spurious delay REDUCTION for a scenario that
 * changed nothing.
 */
export function pivotDelay(
  delayObserved: number,
  speedBefore: number,
  speedAfter: number,
  freeFlowMph: number
): number {
  const modelled = delayMinPerMile(speedAfter, freeFlowMph) - delayMinPerMile(speedBefore, freeFlowMph);
  return Math.max(0, delayObserved + modelled);
}

/**
 * Vehicle-miles travelled in one bucket.
 * Uses SERVED flow, not demand: vehicle-miles that never got onto the road are
 * not travelled.
 */
export function vmt(servedVph: number, segmentLengthMi: number, bucketHours = BUCKET_HOURS): number {
  return servedVph * bucketHours * segmentLengthMi;
}

/** Vehicle-hours travelled in one bucket: VMT / speed. */
export function vht(servedVph: number, segmentLengthMi: number, speedMph: number, bucketHours = BUCKET_HOURS): number {
  if (speedMph <= 0) return 0;
  return vmt(servedVph, segmentLengthMi, bucketHours) / speedMph;
}

/** Vehicle-hours of pure DELAY: VMT at (1/speed − 1/free-flow). */
export function delayVht(
  servedVph: number,
  segmentLengthMi: number,
  speedMph: number,
  freeFlowMph: number,
  bucketHours = BUCKET_HOURS
): number {
  if (speedMph <= 0 || freeFlowMph <= 0) return 0;
  return vmt(servedVph, segmentLengthMi, bucketHours) * (1 / speedMph - 1 / freeFlowMph);
}

/**
 * Network mean speed as VMT/VHT — the flow-weighted harmonic mean.
 * A plain average of station speeds is not a network speed: it lets a 0.5-mile
 * off-ramp carrying 40 vph outvote six miles of jammed mainline.
 */
export function networkSpeed(totalVmt: number, totalVht: number): number {
  if (totalVht <= 0) return 0;
  return totalVmt / totalVht;
}

/** Surviving capacity fraction under a PLANNED lane closure (no rubbernecking). */
export function closureCapacityFactor(numLanes: number, lanesClosed: number): number {
  if (numLanes <= 0) return 1;
  const open = Math.max(0, numLanes - Math.max(0, lanesClosed));
  return Math.max(MIN_CAPACITY_FACTOR, open / numLanes);
}

/**
 * Surviving capacity fraction under an INCIDENT: blocked lanes plus a 12% loss
 * across the remaining lanes for rubbernecking and merge turbulence. HCM
 * documents that incident capacity loss exceeds the pure lane-count loss.
 * 1 of 4 lanes blocked leaves 0.75 × 0.88 = 66%.
 */
export function incidentCapacityFactor(numLanes: number, lanesBlocked: number): number {
  if (numLanes <= 0) return 1;
  const open = Math.max(0, numLanes - Math.max(0, lanesBlocked));
  return Math.max(MIN_CAPACITY_FACTOR, (open / numLanes) * (1 - RUBBERNECK_CAPACITY_LOSS));
}

/**
 * One damped MSA step: `x + 1/(k+1) * (y - x)` for 1-based iteration `k`.
 * A convex combination of two demand vectors, which is exactly why total demand
 * is conserved to machine precision at every iteration.
 */
export function msaStep(x: number, y: number, iteration: number): number {
  if (iteration < 1) return x;
  return x + (1 / (iteration + 1)) * (y - x);
}

/**
 * Served flow: `min(demand, capacity)`. At v/c > 1 a detector cannot record more
 * than capacity, so throughput saturates while latent demand keeps climbing.
 */
export function servedFlow(demandVph: number, capacityVph: number): number {
  return Math.min(Math.max(0, demandVph), Math.max(0, capacityVph));
}
