import {
  BUCKETS_PER_DAY,
  MINUTES_PER_BUCKET,
  frameSlice,
  losFromSpeedAndVc,
  type CorridorStat,
  type FrameKpis,
  type FrameMatrix,
} from './frames';
import type { StationRow } from './useTrafficData';

/**
 * ┌──────────────────────────────────────────────────────────────────────────────────────┐
 * │ ⚠️  MOCK BOUNDARY — NOTHING BELOW IS A REAL TRAFFIC MODEL.                            │
 * └──────────────────────────────────────────────────────────────────────────────────────┘
 *
 * CLIENT/SERVER CONTRACT for the M2 engine route, which does NOT exist in this worktree.
 * It is being built in parallel on `polly/whatif-engine` (server/scenario/**, which this
 * branch deliberately does not touch).
 *
 * Expected endpoint once the engine PR lands:
 *   POST /api/scenario/run
 *   body:     ScenarioRunRequest   (this file is the source of truth for the shape)
 *   response: ScenarioRunResponse
 *
 * Until then the UI calls applyMockScenario(), a deliberately crude client-side stand-in.
 * It exists to exercise the lever composition, the before/after KPI panel and the diff map
 * WITHOUT adding a warehouse round-trip, so the M1 invariant (12 requests, nothing queried
 * during animation) is preserved exactly. Swapping in the real route means replacing that
 * one call; every consumer already reads the FrameMatrix contract.
 *
 * WHAT THE MOCK IS NOT:
 *   - It is NOT the BPR volume-delay function. speedFromVc() below is a piecewise-linear
 *     penalty with hand-picked constants, chosen to move in the right DIRECTION under load,
 *     not to be numerically defensible. Do not read its output as a prediction.
 *   - It does NOT reassign demand across routes. There is no road-network graph in this
 *     dataset -- only detector stations along 10 corridors with postmiles -- so a closure
 *     cannot divert traffic to a parallel road. Displaced demand simply stays put.
 *   - It does NOT propagate congestion upstream/downstream. Effects are per-station.
 *
 * ⚠️ BPR COEFFICIENT CONFLICT, UNRESOLVED UPSTREAM. Two authorities disagree:
 *      Lakebase app.config seeds  alpha = 0.15, beta = 4.0   (the textbook BPR defaults)
 *      the data generator used    alpha = 0.55, beta = 4.5   (what actually shaped this data)
 *    This UI picks NEITHER, because picking one silently would launder a real disagreement
 *    into a number on a dashboard. The mock uses its own clearly-labelled non-BPR penalty,
 *    and `MOCK_MODEL` below is what the panel shows the user. When the engine lands it must
 *    declare which pair it used in ScenarioRunResponse.model, and the UI should surface that
 *    verbatim rather than assuming. Whoever resolves the conflict should note that 0.55/4.5
 *    is the pair consistent with the observed vc/speed relationship in gold_map_frames.
 *
 * ⚠️ v/c SCALING. Congestion visuals key off DEMAND-based vc_ratio (max 7.31, p99 1.14 as
 *    measured), never `served_vc_ratio`, which is hard-capped at exactly 1.0 since the *1.02
 *    detector allowance was removed in PR #2 and therefore carries no signal above capacity.
 *    Because demand v/c is that skewed, nothing here may key a CONTINUOUS colour or size
 *    scale on it unclamped -- one outlier would flatten the whole ramp. Colour comes from
 *    speedToColor(), which clamps (65-speed)/45 into [0,1]. v/c is used only for COUNTING
 *    (v/c > 1) and for the LOS threshold, neither of which is a continuous scale.
 */

/** What the UI tells the user it is running. Kept next to the caveats it describes. */
export const MOCK_MODEL = {
  name: 'client-mock-not-bpr',
  reassignment: 'none-no-network-graph',
  bprCoefficients: 'not-used (upstream conflict: 0.15/4.0 seeded vs 0.55/4.5 generated)',
} as const;
export interface ScenarioRunRequest {
  schemaVersion: 'm2-scenario-v1';
  day: string;
  scope: {
    freeway: string;
    direction?: string;
  };
  levers: ScenarioLever[];
  output: {
    bucketMinutes: 15;
    includeStationMatrix: true;
    includeWorstCorridors: true;
  };
}

export interface ScenarioRunResponse {
  schemaVersion: 'm2-scenario-v1';
  runId: string;
  model: {
    name: 'bpr-volume-delay';
    caveat: string;
    reassignment: 'corridor-postmile-simplified';
  };
  matrix: {
    stationOrder: string[];
    bucketCount: 96;
    flow: number[];
    speed: number[];
    vc: number[];
    incident: number[];
  };
  kpisByBucket: ScenarioBucketKpis[];
  warnings: string[];
}

export type ScenarioLever = ClosureLever | DemandDeltaLever | IncidentLever | CapacityChangeLever;

export interface ScenarioTarget {
  stationId: string;
  label: string;
  freeway: string;
  direction: string;
  postmile: number;
}

export interface ClosureLever {
  id: string;
  type: 'closure';
  target: ScenarioTarget;
  lanesClosed: number;
}

export interface DemandDeltaLever {
  id: string;
  type: 'demand_delta';
  freeway: string;
  direction: string;
  percent: number;
}

export interface IncidentLever {
  id: string;
  type: 'incident';
  target: ScenarioTarget;
  startBucket: number;
  durationBuckets: number;
  lanesBlocked: number;
  severity: 1 | 2 | 3 | 4;
}

export interface CapacityChangeLever {
  id: string;
  type: 'capacity_change';
  target: ScenarioTarget;
  capacityVph: number;
}

export interface ScenarioBucketKpis extends FrameKpis {
  vht: number;
  vmt: number;
}

export interface ScenarioSummary {
  request: ScenarioRunRequest;
  matrix: FrameMatrix;
  warnings: string[];
  mocked: true;
}

export interface CorridorDeltaStat extends CorridorStat {
  scenarioMeanSpeed: number;
  speedDelta: number;
}

interface StationDistance {
  miles: number;
}

const MIN_CAPACITY_VPH = 250;
const INCIDENT_SPEED_FACTOR: Record<IncidentLever['severity'], number> = {
  1: 0.88,
  2: 0.72,
  3: 0.55,
  4: 0.38,
};

export function scenarioTargetFromStation(station: StationRow): ScenarioTarget {
  const postmile = Number(station.postmile);
  return {
    stationId: station.station_id,
    label: `${station.freeway} ${station.direction} · PM ${postmile.toFixed(1)} · ${station.city}`,
    freeway: station.freeway,
    direction: station.direction,
    postmile,
  };
}

export function createScenarioRequest(day: string, freeway: string, levers: ScenarioLever[]): ScenarioRunRequest {
  return {
    schemaVersion: 'm2-scenario-v1',
    day,
    scope: { freeway },
    levers,
    output: {
      bucketMinutes: MINUTES_PER_BUCKET,
      includeStationMatrix: true,
      includeWorstCorridors: true,
    },
  };
}

export function applyMockScenario(
  baseline: FrameMatrix,
  stations: StationRow[],
  request: ScenarioRunRequest
): ScenarioSummary {
  const matrix = cloneMatrix(baseline);
  const stationIndex = new Map(stations.map((station, index) => [station.station_id, index]));
  const distances = estimateStationDistances(stations);
  // Shown verbatim in ScenarioKpiPanel's "Model caveat" block, next to the numbers they
  // qualify. Deliberately blunt: these deltas are directional illustrations, not forecasts.
  const warnings = [
    'Mocked in the client — no traffic model has run. POST /api/scenario/run (the BPR engine) is not wired up yet.',
    'Not BPR: speeds come from a hand-tuned penalty curve, chosen to move in the right direction under load, not to be numerically accurate.',
    'No demand reassignment: this data has no road-network graph — only detector stations along 10 corridors with postmiles — so a closure cannot divert traffic to a parallel route. Displaced demand stays put and effects do not propagate up- or downstream.',
    'BPR coefficients are in conflict upstream (0.15/4.0 seeded in Lakebase vs 0.55/4.5 used by the data generator); this mock uses neither rather than picking one silently.',
  ];

  for (const lever of request.levers) {
    if (lever.type === 'demand_delta') {
      applyDemandDelta(matrix, stations, lever, distances);
      continue;
    }

    const targetIndex = stationIndex.get(lever.target.stationId);
    if (targetIndex === undefined) {
      warnings.push(
        `Skipped ${lever.type}: target station ${lever.target.stationId} is outside the current corridor filter.`
      );
      continue;
    }

    if (lever.type === 'closure') applyClosure(matrix, stations[targetIndex], targetIndex, lever, distances);
    if (lever.type === 'incident') applyIncident(matrix, stations[targetIndex], targetIndex, lever, distances);
    if (lever.type === 'capacity_change') applyCapacityChange(matrix, targetIndex, lever);
  }

  return { request, matrix, warnings, mocked: true };
}

export function computeScenarioKpis(matrix: FrameMatrix, stations: StationRow[], bucket: number): ScenarioBucketKpis {
  const base = computeFrameLikeKpis(matrix, bucket);
  const distances = estimateStationDistances(stations);
  const speed = frameSlice(matrix.speed, bucket, matrix.stationCount);
  const flow = frameSlice(matrix.flow, bucket, matrix.stationCount);

  let vmt = 0;
  let vht = 0;
  for (let i = 0; i < matrix.stationCount; i++) {
    const stationVmt = Math.max(0, flow[i]) * distances[i].miles;
    vmt += stationVmt;
    if (!Number.isNaN(speed[i]) && speed[i] > 1) vht += stationVmt / speed[i];
  }

  return { ...base, vht, vmt };
}

export function computeWorstCorridorDeltas(
  baseline: FrameMatrix,
  scenario: FrameMatrix,
  stations: StationRow[],
  bucket: number,
  limit = 5
): CorridorDeltaStat[] {
  const base = rollupCorridors(baseline, stations, bucket);
  const changed = rollupCorridors(scenario, stations, bucket);

  return [...changed.entries()]
    .map(([freeway, stat]) => {
      const baseStat = base.get(freeway);
      const baselineMeanSpeed = baseStat?.meanSpeed ?? stat.meanSpeed;
      return {
        ...stat,
        scenarioMeanSpeed: stat.meanSpeed,
        speedDelta: stat.meanSpeed - baselineMeanSpeed,
      };
    })
    .sort((a, b) => a.scenarioMeanSpeed - b.scenarioMeanSpeed)
    .slice(0, limit);
}

export function leverSummary(lever: ScenarioLever): string {
  if (lever.type === 'closure') {
    return `Close ${lever.lanesClosed} lane${lever.lanesClosed === 1 ? '' : 's'} at ${lever.target.label}`;
  }
  if (lever.type === 'demand_delta') {
    return `${lever.freeway} ${lever.direction} demand ${formatSigned(lever.percent)}%`;
  }
  if (lever.type === 'incident') {
    return `Incident at ${lever.target.label}, ${bucketLabel(lever.startBucket)} PT for ${lever.durationBuckets * 15} min, severity ${lever.severity}`;
  }
  return `Set ${lever.target.label} capacity to ${Math.round(lever.capacityVph).toLocaleString()} veh/h`;
}

export function bucketLabel(bucket: number): string {
  const totalMinutes = bucket * MINUTES_PER_BUCKET;
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function computeFrameLikeKpis(matrix: FrameMatrix, bucket: number): FrameKpis {
  const { stationCount } = matrix;
  const speed = frameSlice(matrix.speed, bucket, stationCount);
  const flow = frameSlice(matrix.flow, bucket, stationCount);
  const vc = frameSlice(matrix.vc, bucket, stationCount);
  const incident = frameSlice(matrix.incident, bucket, stationCount);

  let speedSum = 0;
  let observed = 0;
  let totalFlow = 0;
  let congested = 0;
  let overCapacity = 0;
  let incidents = 0;

  for (let i = 0; i < stationCount; i++) {
    const s = speed[i];
    if (!Number.isNaN(s)) {
      speedSum += s;
      observed++;
      if (losFromSpeedAndVc(s, vc[i]) >= 4) congested++;
    }
    totalFlow += flow[i];
    if (vc[i] > 1) overCapacity++;
    if (incident[i] > 0) incidents++;
  }

  return {
    meanSpeed: observed > 0 ? speedSum / observed : 0,
    totalFlow,
    pctCongested: observed > 0 ? (congested / observed) * 100 : 0,
    overCapacity,
    incidents,
    observed,
  };
}

function cloneMatrix(source: FrameMatrix): FrameMatrix {
  return {
    stationCount: source.stationCount,
    bucketCount: source.bucketCount,
    flow: new Int32Array(source.flow),
    speed: new Float32Array(source.speed),
    vc: new Float32Array(source.vc),
    incident: new Uint8Array(source.incident),
    bucketsLoaded: [...source.bucketsLoaded],
  };
}

function applyDemandDelta(
  matrix: FrameMatrix,
  stations: StationRow[],
  lever: DemandDeltaLever,
  distances: StationDistance[]
): void {
  const factor = Math.max(0.25, 1 + lever.percent / 100);
  for (let i = 0; i < stations.length; i++) {
    const station = stations[i];
    if (station.freeway !== lever.freeway || station.direction !== lever.direction) continue;
    forEachBucket(matrix, i, (offset) => {
      matrix.flow[offset] = Math.round(matrix.flow[offset] * factor);
      recomputeVcAndSpeed(matrix, offset, capacityForStation(station), distances[i], 1, 1);
    });
  }
}

function applyClosure(
  matrix: FrameMatrix,
  station: StationRow,
  stationIndex: number,
  lever: ClosureLever,
  distances: StationDistance[]
): void {
  const lanes = Math.max(1, Number(station.baseline_lanes || station.num_lanes || 1));
  const laneFactor = Math.max(0.08, (lanes - lever.lanesClosed) / lanes);
  applyLocalCapacityFactor(matrix, station, stationIndex, distances, laneFactor, 1);
}

function applyIncident(
  matrix: FrameMatrix,
  station: StationRow,
  stationIndex: number,
  lever: IncidentLever,
  distances: StationDistance[]
): void {
  const lanes = Math.max(1, Number(station.baseline_lanes || station.num_lanes || 1));
  const laneFactor = Math.max(0.05, (lanes - lever.lanesBlocked) / lanes);
  const speedFactor = INCIDENT_SPEED_FACTOR[lever.severity];
  const endBucket = Math.min(BUCKETS_PER_DAY, lever.startBucket + lever.durationBuckets);

  for (let bucket = lever.startBucket; bucket < endBucket; bucket++) {
    const offset = bucket * matrix.stationCount + stationIndex;
    matrix.incident[offset] = Math.max(matrix.incident[offset], lever.severity);
    recomputeVcAndSpeed(matrix, offset, capacityForStation(station), distances[stationIndex], laneFactor, speedFactor);
  }
}

function applyCapacityChange(matrix: FrameMatrix, stationIndex: number, lever: CapacityChangeLever): void {
  const capacity = Math.max(MIN_CAPACITY_VPH, lever.capacityVph);
  forEachBucket(matrix, stationIndex, (offset) => {
    matrix.vc[offset] = matrix.flow[offset] / capacity;
    matrix.speed[offset] = speedFromVc(matrix.vc[offset], matrix.speed[offset], 1);
  });
}

function applyLocalCapacityFactor(
  matrix: FrameMatrix,
  station: StationRow,
  stationIndex: number,
  distances: StationDistance[],
  capacityFactor: number,
  speedFactor: number
): void {
  forEachBucket(matrix, stationIndex, (offset) => {
    recomputeVcAndSpeed(
      matrix,
      offset,
      capacityForStation(station),
      distances[stationIndex],
      capacityFactor,
      speedFactor
    );
  });
}

function recomputeVcAndSpeed(
  matrix: FrameMatrix,
  offset: number,
  baselineCapacity: number,
  _distance: StationDistance,
  capacityFactor: number,
  speedFactor: number
): void {
  const effectiveCapacity = Math.max(MIN_CAPACITY_VPH, baselineCapacity * capacityFactor);
  matrix.vc[offset] = matrix.flow[offset] / effectiveCapacity;
  matrix.speed[offset] = speedFromVc(matrix.vc[offset], matrix.speed[offset], speedFactor);
}

/**
 * Speed under a perturbed v/c. NOT the BPR function -- see the MOCK BOUNDARY header.
 *
 * `vc` is DEMAND-based and genuinely reaches 7.31 in this dataset while p99 is only 1.14, so
 * the penalty terms are clamped at VC_PENALTY_CEILING before use. Without that clamp a single
 * outlier station drives `congestionPenalty` past 200, every branch saturates at the 3 mph
 * floor, and a v/c of 7.3 becomes visually indistinguishable from one of 1.5 -- the same
 * flattening the colour scale avoids by keying on clamped speed instead of raw v/c.
 */
const VC_PENALTY_CEILING = 2.5;

function speedFromVc(vc: number, currentSpeed: number, speedFactor: number): number {
  if (Number.isNaN(currentSpeed)) return currentSpeed;
  const effectiveVc = Math.min(Math.max(vc, 0), VC_PENALTY_CEILING);
  const congestionPenalty =
    Math.max(0, effectiveVc - 0.72) * 34 + Math.max(0, effectiveVc - 1) * 24;
  const cappedSpeed = Math.max(4, Math.min(currentSpeed, 67 - congestionPenalty));
  return Math.max(3, cappedSpeed * speedFactor);
}

function forEachBucket(matrix: FrameMatrix, stationIndex: number, fn: (offset: number) => void): void {
  for (let bucket = 0; bucket < matrix.bucketCount; bucket++) {
    fn(bucket * matrix.stationCount + stationIndex);
  }
}

function capacityForStation(station: StationRow): number {
  const lanes = Number(station.baseline_lanes || station.num_lanes || 1);
  return Math.max(MIN_CAPACITY_VPH, Number(station.baseline_capacity_vph) || lanes * 1900);
}

function estimateStationDistances(stations: StationRow[]): StationDistance[] {
  const byCorridor = new Map<string, number[]>();
  for (let i = 0; i < stations.length; i++) {
    const key = `${stations[i].freeway}|${stations[i].direction}`;
    const list = byCorridor.get(key) ?? [];
    list.push(i);
    byCorridor.set(key, list);
  }

  const distances = stations.map(() => ({ miles: 0.5 }));
  for (const indices of byCorridor.values()) {
    indices.sort((a, b) => Number(stations[a].postmile) - Number(stations[b].postmile));
    for (let order = 0; order < indices.length; order++) {
      const prev = indices[order - 1];
      const next = indices[order + 1];
      const current = indices[order];
      const currentPostmile = Number(stations[current].postmile);
      const prevGap = prev === undefined ? Number.NaN : Math.abs(currentPostmile - Number(stations[prev].postmile));
      const nextGap = next === undefined ? Number.NaN : Math.abs(Number(stations[next].postmile) - currentPostmile);
      const gaps = [prevGap, nextGap].filter((gap) => Number.isFinite(gap) && gap > 0 && gap < 20);
      distances[current] = { miles: gaps.length > 0 ? Math.max(0.1, average(gaps)) : 0.5 };
    }
  }
  return distances;
}

function rollupCorridors(matrix: FrameMatrix, stations: StationRow[], bucket: number): Map<string, CorridorStat> {
  const speed = frameSlice(matrix.speed, bucket, matrix.stationCount);
  const flow = frameSlice(matrix.flow, bucket, matrix.stationCount);
  const vc = frameSlice(matrix.vc, bucket, matrix.stationCount);
  const acc = new Map<string, { speedSum: number; n: number; flow: number; congested: number }>();

  for (let i = 0; i < stations.length; i++) {
    const freeway = stations[i].freeway;
    const item = acc.get(freeway) ?? { speedSum: 0, n: 0, flow: 0, congested: 0 };
    const stationSpeed = speed[i];
    if (!Number.isNaN(stationSpeed)) {
      item.speedSum += stationSpeed;
      item.n++;
      if (losFromSpeedAndVc(stationSpeed, vc[i]) >= 4) item.congested++;
    }
    item.flow += flow[i];
    acc.set(freeway, item);
  }

  return new Map(
    [...acc.entries()].map(([freeway, item]) => [
      freeway,
      {
        freeway,
        meanSpeed: item.n > 0 ? item.speedSum / item.n : 0,
        totalFlow: item.flow,
        congestedPct: item.n > 0 ? (item.congested / item.n) * 100 : 0,
      },
    ])
  );
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}
