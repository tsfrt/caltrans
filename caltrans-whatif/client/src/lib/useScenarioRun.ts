/**
 * Run the M2 what-if engine and decode its result into an animation-ready matrix.
 *
 * ── The engine runs in DBSQL, not here ───────────────────────────────────────
 * This module binds parameters and decodes rows. There is no traffic math in it
 * and there must never be: 191,424 station-buckets per scenario never cross the
 * wire, and BPR + damped MSA reassignment execute as one parameterized query.
 * See `docs/WHATIF_ENGINE.md`.
 *
 * ── Why the client calls the warehouse directly ──────────────────────────────
 * Both engine queries are in the generated `QueryRegistry`, so `useAnalyticsQuery`
 * resolves them by key exactly as `useTrafficData` resolves M1's baseline. Same
 * SSE transport, same per-query cache, same generated row types, no Express route
 * in between.
 *
 * ── Why a run is EXPLICIT and not reactive ───────────────────────────────────
 * A run is 5 warehouse queries at a MEASURED 2.3–3.7 s warm each (15–25 s cold on
 * a Small warehouse). Firing that on every lever edit would mean several runs
 * while a user arrow-keys a "lanes closed" field. So the levers are staged in the
 * panel and this hook only queries once they are COMMITTED — `committed` is
 * whatever the user last pressed Run with, and nothing else moves it.
 *
 * ⚠️ Gating MUST use `autoStart`, not `parameters: null`. Passing null parameters
 * does NOT hold a query back: `useAnalyticsQuery` only skips when serialising the
 * payload THROWS, and `JSON.stringify({parameters: null})` succeeds — so the query
 * fires with no bindings at all and DBSQL rejects it with
 * `[UNBOUND_SQL_PARAMETER] Found the unbound parameter: msa_iterations`. That is
 * measured behaviour, not a guess: the first wiring of this hook did exactly that
 * and burned 5 failed warehouse calls every time a lever was staged.
 *
 * `autoStart: false` gates the hook's effect properly. It exposes no `start()`
 * handle, but none is needed: the effect re-runs when `autoStart` flips to true,
 * which is precisely when a scenario is committed.
 *
 * ── The M1 animation invariant still holds ───────────────────────────────────
 * `docs/ARCHITECTURE.md` §3: nothing queries the warehouse during animation. A
 * run happens on a button press, completes, and then the clock plays over arrays
 * already in memory. Pressing Run is a user action, not an animation frame.
 */

import { useMemo } from 'react';
import { useAnalyticsQuery, type QueryRegistry } from '@databricks/appkit-ui/react';
import { applyPackedWindow, createFrameMatrix, type FrameMatrix, type PackedWindow } from './frames';
import { dayWindows, kpiParams, matrixParams, type ScenarioRequest } from './scenarioParams';

/** The four window starts that cover a day: [0, 24, 48, 72]. */
const WINDOW_OFFSETS = dayWindows();

/**
 * One row of `scenario_time_matrix`, from the generated registry.
 *
 * A deliberate SUPERSET of M1's `PackedWindow`: the four M1 columns carry the
 * SCENARIO values in M1's exact layout and encoding, so `applyPackedWindow`
 * decodes it unchanged. The extra column is `delay_c` (centi-minutes per mile),
 * which M1 had no need for. The assignment below is what enforces that
 * superset relationship at compile time — if the engine ever renames one of the
 * four shared columns, this line breaks instead of the map silently going blank.
 */
type ScenarioMatrixRow = QueryRegistry['scenario_time_matrix']['result'][number];
const _matrixRowIsAPackedWindow: (row: ScenarioMatrixRow) => PackedWindow = (row) => row;
void _matrixRowIsAPackedWindow;

/**
 * One row of `scenario_kpis`.
 *
 * ⚠️ Every numeric field arrives as a STRING over the SQL Statement API (JSON_ARRAY
 * serialises every value as a string). Always `Number(...)` before arithmetic.
 */
export interface ScenarioKpiRow {
  scope: 'NETWORK' | 'CORRIDOR' | 'SEGMENT';
  freeway: string;
  direction: string;
  /** SEGMENT rows only; null for NETWORK/CORRIDOR. */
  bucket_idx: number | null;
  msa_iterations_used: number;
  cells: number;
  stations: number;
  /**
   * Of `stations`, how many have ANY diversion candidate. Reported so a scenario
   * cannot imply the whole network can re-route when only 27% of it can.
   */
  stations_with_alternative: number;
  vht_before: number;
  vht_after: number;
  vht_delta: number;
  vht_delta_pct: number;
  vmt_before: number;
  vmt_after: number;
  speed_before: number;
  speed_after: number;
  speed_delta: number;
  vc_before: number;
  vc_after: number;
  vc_delta: number;
  delay_before: number;
  delay_after: number;
  delay_delta: number;
  los_ef_before: number;
  los_ef_after: number;
  los_ef_delta: number;
  demand_offnetwork_veh: number;
  /**
   * Exactly 0 on the NETWORK row (MSA damping is a convex combination, so demand
   * is conserved to machine precision). Non-zero on a CORRIDOR row is NOT an
   * error — it IS the diversion, measuring net demand moved onto or off that
   * corridor.
   */
  conservation_error_veh: number;
}

function isScenarioKpiScope(scope: unknown): scope is ScenarioKpiRow['scope'] {
  return scope === 'NETWORK' || scope === 'CORRIDOR' || scope === 'SEGMENT';
}

function toScenarioKpiRows(rows: unknown): ScenarioKpiRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter(
    (row): row is ScenarioKpiRow =>
      typeof row === 'object' &&
      row !== null &&
      isScenarioKpiScope((row as { scope?: unknown }).scope),
  );
}

/** A committed scenario: the request the user pressed Run with. */
export interface CommittedScenario {
  request: ScenarioRequest;
  /** Warnings from the lever fold, surfaced next to the numbers they qualify. */
  warnings: string[];
  /** Distinguishes one committed run from another for cache/provenance keying. */
  runKey: string;
}

export interface ScenarioRun {
  /** Full-day scenario matrix, or null until all four windows have landed. */
  matrix: FrameMatrix | null;
  kpiRows: ScenarioKpiRow[] | null;
  /** The single NETWORK-scope row: the only closed system in the result. */
  networkRow: ScenarioKpiRow | null;
  /** Worst station-buckets by delta VHT — names the time as well as the place. */
  worstSegments: ScenarioKpiRow[];
  loading: boolean;
  error: string | null;
  /** How many of the 4 windows have landed, for a progress hint. */
  windowsLoaded: number;
  warnings: string[];
}

const EMPTY_RUN: ScenarioRun = {
  matrix: null,
  kpiRows: null,
  networkRow: null,
  worstSegments: [],
  loading: false,
  error: null,
  windowsLoaded: 0,
  warnings: [],
};

/** Query result array identity -> the run key it first arrived for. */
const DATA_RUN_KEYS = new WeakMap<readonly unknown[], string>();

/**
 * Bindable stand-in used while no scenario is committed.
 *
 * Never executed — `autoStart: false` suppresses the request — but it must still
 * BIND, because the hook serialises whatever it is given. The date is arbitrary
 * and only has to satisfy the binder's `YYYY-MM-DD` check.
 */
const PLACEHOLDER_REQUEST: ScenarioRequest = { day: '2026-06-10' };

/**
 * Execute a committed scenario: 4 matrix windows in parallel plus the KPI roll-up.
 *
 * Pass `null` to run nothing (the baseline case). `stationCount` must be the
 * station count of the CURRENT view, because the packed payload's `station_idx` is
 * dense over the filtered set and positional alignment is otherwise wrong.
 */
export function useScenarioRun(
  committed: CommittedScenario | null,
  stationCount: number | null,
): ScenarioRun {
  // Hooks must be called unconditionally in a stable order, so each of the four
  // windows gets its own explicit call rather than a loop over a dynamic list —
  // same reasoning as useTrafficView.
  const w0 = useScenarioWindow(committed, WINDOW_OFFSETS[0]);
  const w1 = useScenarioWindow(committed, WINDOW_OFFSETS[1]);
  const w2 = useScenarioWindow(committed, WINDOW_OFFSETS[2]);
  const w3 = useScenarioWindow(committed, WINDOW_OFFSETS[3]);

  // Parameters must be a VALID object even when gated off, because `autoStart` is
  // what suppresses the request and the params still get serialised. A lever-free
  // placeholder binds cleanly (it is the engine's provable no-op) and is never
  // actually sent while `autoStart` is false.
  const kpiParameters = useMemo(
    () => kpiParams(committed?.request ?? PLACEHOLDER_REQUEST),
    [committed],
  );
  const kpiQ = tagRun(
    useAnalyticsQuery('scenario_kpis', kpiParameters, { autoStart: !!committed }),
    committed?.runKey ?? '',
  );

  const windows = [w0, w1, w2, w3];
  const runKey = committed?.runKey ?? '';

  // Only windows proven to belong to THIS run. A stale window from a previous run
  // describes a different scenario and must never be aligned to the current
  // geometry — the same provenance discipline useTrafficView uses for corridor
  // switches, and for the same reason: `data` is cleared from an effect, i.e.
  // AFTER the render that changed the run, so for one render the hook still
  // returns the previous run's rows.
  const packed = windows.map((q) => (q.runKey === runKey ? firstRow(q.data) : null));

  // Rebuild only when a new window actually arrives, not on every render.
  const matrixKey = `${runKey}#${stationCount ?? 'x'}#${packed.map((w) => (w ? w.first_bucket : 'x')).join('|')}`;
  const matrix = useMemo(() => {
    if (!committed || !stationCount) return null;
    const present = packed.filter((w): w is ScenarioMatrixRow => w !== null);
    // All four windows or nothing: a partially-populated matrix would animate
    // through buckets whose speed is still NaN, which reads as "no data" on the
    // map rather than "not loaded yet".
    if (present.length < WINDOW_OFFSETS.length) return null;
    const m = createFrameMatrix(stationCount);
    // applyPackedWindow throws if `stations` disagrees with the geometry, which is
    // the guard against attributing one station's speed to another.
    for (const win of present) applyPackedWindow(m, win);
    return m;
    // `packed` is rebuilt each render; matrixKey captures its meaningful identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committed, stationCount, matrixKey]);

  const kpiRows = useMemo(() => {
    if (!committed || !kpiQ.data || kpiQ.runKey !== runKey) return null;
    return toScenarioKpiRows(kpiQ.data);
  }, [committed, kpiQ.data, kpiQ.runKey, runKey]);

  if (!committed) return EMPTY_RUN;

  const all = [...windows, kpiQ];
  return {
    matrix,
    kpiRows,
    networkRow: kpiRows?.find((r) => r.scope === 'NETWORK') ?? null,
    worstSegments: kpiRows?.filter((r) => r.scope === 'SEGMENT') ?? [],
    loading: all.some((q) => q.loading),
    error: all.find((q) => q.error)?.error ?? null,
    windowsLoaded: packed.filter(Boolean).length,
    warnings: committed.warnings,
  };
}

/**
 * A stable key for a committed request, so two different scenarios never share a
 * cache entry or get mistaken for one another mid-flight.
 */
export function scenarioRunKey(request: ScenarioRequest): string {
  return JSON.stringify(request);
}

/**
 * One 24-bucket window, tagged with the run it was actually fetched for.
 *
 * MEASURED: 758,886 B (0.724 MiB) for all 10 corridors, p50 2.3 s warm. That is
 * inside AppKit's 1 MiB single-event cap (`appkit/dist/stream/defaults.js`
 * `maxEventSize`) — which an earlier version of this payload was NOT, at 1.356
 * MiB, because it also shipped the "before" side the client already holds.
 */
function useScenarioWindow(committed: CommittedScenario | null, fromBucket: number) {
  const parameters = useMemo(
    () => matrixParams(committed?.request ?? PLACEHOLDER_REQUEST, fromBucket),
    [committed, fromBucket],
  );
  return tagRun(
    useAnalyticsQuery('scenario_time_matrix', parameters, { autoStart: !!committed }),
    committed?.runKey ?? '',
  );
}

/**
 * Record which run each `data` object arrived for, and report it back.
 *
 * This is a statement about IDENTITY, not about a coincidence of cardinality: two
 * different scenarios over the same corridor return the same number of stations,
 * so a count comparison could never tell a stale run from a current one.
 */
function tagRun<T extends { data: readonly unknown[] | null }>(
  result: T,
  runKey: string,
): T & { runKey: string } {
  if (result.data === null) return { ...result, runKey };
  if (!DATA_RUN_KEYS.has(result.data)) DATA_RUN_KEYS.set(result.data, runKey);
  return { ...result, runKey: DATA_RUN_KEYS.get(result.data) ?? runKey };
}

/**
 * The matrix query aggregates to exactly one row. Pull it out defensively — an
 * empty result is a legitimate state (a corridor/window with no rows), not an
 * error.
 */
function firstRow<T>(data: readonly T[] | null | undefined): T | null {
  if (!data || data.length === 0) return null;
  return data[0];
}
