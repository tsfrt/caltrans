/**
 * Call the engine. Thin by design: validate, bind, execute, decode.
 *
 * There is no traffic math in this file and there must never be. The whole point
 * of the M2 decision recorded in `docs/ARCHITECTURE.md` §2 is that the model runs
 * IN DBSQL — 191,424 station-buckets per scenario never cross the wire, and the
 * app process stays a transport.
 *
 * SQL lives in `config/queries/scenario_*.sql` (not inline here) so AppKit
 * generates row types for it and applies its own query cache.
 */

import {
  SCENARIO_KPI_QUERY,
  SCENARIO_MATRIX_QUERY,
  type ScenarioKpiRow,
  type ScenarioMatrixRow,
  type ScenarioRequest,
} from './contract.js';
import { bindScenario, dayWindows, type ScenarioParams } from './params.js';

/**
 * The slice of AppKit's analytics plugin this module needs.
 *
 * Declared structurally rather than imported so the module is unit-testable with
 * a stub and does not drag the plugin (and a warehouse connection) into tests.
 */
export interface AnalyticsLike {
  query(
    queryKey: string,
    options?: { params?: ScenarioParams }
  ): Promise<{ data?: unknown[]; rows?: unknown[] } | unknown[]>;
}

/** AppKit has returned rows under both shapes across versions; accept either. */
function rowsOf<T>(result: { data?: unknown[]; rows?: unknown[] } | unknown[]): T[] {
  if (Array.isArray(result)) return result as T[];
  if (Array.isArray(result?.data)) return result.data as T[];
  if (Array.isArray(result?.rows)) return result.rows as T[];
  return [];
}

/**
 * One 24-bucket window of the scenario animation payload.
 *
 * MEASURED: 758,886 B (0.724 MiB) for all 10 corridors, p50 2.3 s warm on a
 * Small warehouse. That is inside AppKit's 1 MiB single-event cap
 * (`appkit/dist/stream/defaults.js` `maxEventSize`) — which the earlier version
 * of this payload was NOT, at 1.356 MiB, because it also shipped the "before"
 * side the client already holds.
 */
export async function runScenarioWindow(
  analytics: AnalyticsLike,
  request: ScenarioRequest
): Promise<ScenarioMatrixRow | null> {
  const params = bindScenario(request);
  const rows = rowsOf<ScenarioMatrixRow>(await analytics.query(SCENARIO_MATRIX_QUERY, { params }));
  // The query is a single-row aggregate; an empty result means the day/corridor
  // combination matched nothing, which is a legitimate answer, not an error.
  return rows[0] ?? null;
}

/**
 * All four windows of a day, fetched in parallel.
 *
 * Parallel, not sequential, and for the reason in `docs/ARCHITECTURE.md` §3: the
 * animation must never touch the warehouse, so every bucket has to be in memory
 * before playback starts. Four concurrent ~2.3 s queries put the whole day in
 * hand in about the time of one.
 */
export async function runScenarioDay(analytics: AnalyticsLike, request: ScenarioRequest): Promise<ScenarioMatrixRow[]> {
  const windows = await Promise.all(
    dayWindows().map((fromBucket) => runScenarioWindow(analytics, { ...request, fromBucket }))
  );
  return windows.filter((w): w is ScenarioMatrixRow => w !== null);
}

/**
 * The KPI panel's rows: one NETWORK row, one per corridor+direction, and the
 * worst `worstN` station-buckets.
 *
 * MEASURED: ~9,000 B, p50 3.4 s warm.
 */
export async function runScenarioKpis(analytics: AnalyticsLike, request: ScenarioRequest): Promise<ScenarioKpiRow[]> {
  const params = bindScenario(request);
  return rowsOf<ScenarioKpiRow>(await analytics.query(SCENARIO_KPI_QUERY, { params }));
}

/**
 * Decode one packed column into a typed array.
 *
 * The engine emits each metric as a single comma-separated integer string (no
 * repeated JSON keys, no per-row brackets) in bucket-major, station-minor order:
 *     offset = (bucket - first_bucket) * stations + station_idx
 *
 * `scale` undoes the integer encoding: 2 for `speed_half`, 100 for `vc_pct` and
 * `delay_c`, 1 for `flow` and `incident`.
 */
export function decodePacked(packed: string, scale = 1): Float64Array {
  if (!packed) return new Float64Array(0);
  const parts = packed.split(',');
  const out = new Float64Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = Number(parts[i]) / scale;
  return out;
}

/** Pull the single NETWORK-scope row out of a KPI result. */
export function networkRow(rows: ScenarioKpiRow[]): ScenarioKpiRow | undefined {
  return rows.find((r) => r.scope === 'NETWORK');
}

/** Corridor rows, worst delta-VHT first (the order the query already returns). */
export function corridorRows(rows: ScenarioKpiRow[]): ScenarioKpiRow[] {
  return rows.filter((r) => r.scope === 'CORRIDOR');
}

/** The worst station-buckets, worst delta-VHT first. */
export function worstSegments(rows: ScenarioKpiRow[]): ScenarioKpiRow[] {
  return rows.filter((r) => r.scope === 'SEGMENT');
}
