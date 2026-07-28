import {
  MINUTES_PER_BUCKET,
  frameSlice,
  losFromSpeedAndVc,
  type CorridorStat,
  type FrameKpis,
  type FrameMatrix,
} from './frames';
import type { StationRow } from './useTrafficData';

/**
 * Scenario lever vocabulary and the client-side KPI arithmetic over an
 * already-fetched matrix.
 *
 * ── The model runs in DBSQL ──────────────────────────────────────────────────
 * This file used to contain `applyMockScenario()`, a hand-tuned piecewise-linear
 * penalty curve standing in for a traffic model while the engine was built on a
 * parallel branch. That mock is GONE. Scenarios are now executed by the real M2
 * engine — BPR volume-delay plus damped MSA reassignment, as one parameterized
 * DBSQL query — via `useScenarioRun`. See `docs/WHATIF_ENGINE.md`.
 *
 * What the engine is, stated as plainly as the mock's caveats were:
 *
 *   • BPR volume-delay with alpha=0.55 beta=4.5, the DATA GENERATOR's
 *     coefficients. Not the textbook 0.15/4.0 and not the Lakebase `app.config`
 *     seed (which still holds the textbook pair and is stale). The engine is
 *     INCREMENTAL — it divides one BPR factor by another — so the coefficients
 *     must be the ones that produced the data. `engineModel()` in
 *     ./scenarioAdapter declares this and the KPI panel renders it verbatim.
 *
 *   • It DOES reassign demand, but that is NOT network assignment. There is no
 *     road graph in this data — 2,022 point detectors on 10 corridors with
 *     postmiles, no ramps as edges, no OD matrix. Over-capacity demand moves to
 *     parallel corridors within 8 km and 45° of heading, to adjacent
 *     same-corridor segments, or off-network. Only 27% of stations (551 of 2,022)
 *     have any parallel alternative, and every KPI row reports
 *     `stations_with_alternative` so a scenario cannot imply otherwise.
 *
 *   • MSA is damped over 4 iterations and has NOT converged there (still moving
 *     ~15% per step, measured). Read results as direction and magnitude.
 *
 *   • With no lever set the engine is a PROVABLE no-op: v/c, demand and LOS are
 *     bit-identical to `gold_map_frames`, speed and delay to double epsilon. That
 *     is what makes M1's baseline matrix a legitimate "before" side for the diff,
 *     and it is why the sentinel discipline in ./scenarioParams is load-bearing.
 *
 * ⚠️ v/c SCALING, unchanged and still important. Congestion visuals key off
 *    DEMAND-based vc_ratio (max 7.8163, p99 1.147 as measured), never
 *    `served_vc_ratio`, which is hard-capped at exactly 1.0 and therefore carries
 *    no signal above capacity. Because demand v/c is that skewed, nothing here may
 *    key a CONTINUOUS colour or size scale on it unclamped — one outlier would
 *    flatten the whole ramp. Colour comes from speedToColor(), which clamps
 *    (65-speed)/45 into [0,1]. v/c is used only for COUNTING (v/c > 1) and for the
 *    LOS threshold, neither of which is a continuous scale.
 */

export type ScenarioLever = ClosureLever | DemandDeltaLever | IncidentLever | CapacityChangeLever;

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
  /**
   * HCM severity 1..4. ⚠️ METADATA ONLY in the engine: the speed effect is derived
   * from the capacity loss `lanesBlocked` causes, routed through BPR. The old mock
   * scaled speed directly by severity, so the same lever reports a different
   * number now. Warned about on every incident translation.
   */
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

export interface CorridorDeltaStat extends CorridorStat {
  scenarioMeanSpeed: number;
  speedDelta: number;
}

interface StationDistance {
  miles: number;
}

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

/**
 * Per-bucket KPIs over a matrix already in memory.
 *
 * Deliberately computed here rather than read from `scenario_kpis`: the engine's
 * NETWORK/CORRIDOR rows are WHOLE-DAY aggregates, and this panel reports the
 * clock's current 15-minute bucket. The two are not comparable, and showing a
 * whole-day total next to a moving clock would misread as a per-bucket number.
 * The engine's roll-up is used for the worst-segment list and the conservation
 * audit, where whole-day is the right frame.
 *
 * O(stationCount) over a contiguous span, so it is safe to run every tick.
 */
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
  limit = 5,
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

/**
 * Per-station segment length, as a postmile Voronoi over each carriageway.
 *
 * ⚠️ VMT/VHT computed from these inherit the detector spacing, and the engine's
 * own SQL derives segment lengths the same way (clamped to [0.05, 12] mi). So
 * these numbers are consistent with the engine's, but both are a function of where
 * the detectors happen to be.
 */
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
    ]),
  );
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatSigned(value: number): string {
  return value > 0 ? `+${value}` : `${value}`;
}
