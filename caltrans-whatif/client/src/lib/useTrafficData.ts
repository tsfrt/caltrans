import { useMemo } from 'react';
import { useAnalyticsQuery } from '@databricks/appkit-ui/react';
import { sql } from '@databricks/appkit-ui/js';
import {
  applyPackedHexWindow,
  applyPackedWindow,
  BUCKETS_PER_WINDOW,
  createFrameMatrix,
  createHexFrames,
  WINDOW_COUNT,
  type FrameMatrix,
  type HexFrames,
  type PackedHexWindow,
  type PackedWindow,
} from './frames';

/**
 * THE data-access seam.
 *
 * Every warehouse read for the map funnels through this module, and it is the ONLY place
 * that names a queryKey. M2 replaces the baseline queries here with
 * scenario-parameterized ones (adding scenario levers to the parameter objects) without
 * touching the map, the animation clock, or the KPI panel -- they consume the returned
 * FrameMatrix / HexFrames, which are stable contracts.
 *
 * These hooks fire once per (day, corridor) selection. They are NOT called during
 * animation; the clock only advances an index into data already in memory.
 *
 * The day is fetched as WINDOW_COUNT (4) parallel windows of 24 buckets each, because a
 * whole day in one response exceeds AppKit's 1 MiB SSE event cap. See
 * config/queries/traffic_time_matrix.sql for the full derivation. React runs these hooks
 * unconditionally and in a fixed order, so the fixed-length window list keeps hook order
 * stable across renders.
 */

export type StationRow = {
  station_id: string;
  freeway: string;
  direction: string;
  district: number;
  county: string;
  city: string;
  postmile: number;
  latitude: number;
  longitude: number;
  num_lanes: number;
  station_type: string;
  h3_r7: string;
  h3_r8: string;
  baseline_capacity_vph: number;
  baseline_lanes: number;
};

export interface TrafficView {
  matrix: FrameMatrix | null;
  hexFrames: HexFrames | null;
  stations: StationRow[] | null;
  loading: boolean;
  /** Non-null if any underlying query failed. */
  error: string | null;
  /** How many of the 4 windows have landed -- drives the "still loading" hint. */
  windowsLoaded: number;
}

/** Selectable days, for the date picker. */
export function useAvailableDays() {
  const params = useMemo(() => ({}), []);
  return useAnalyticsQuery('available_days', params);
}

/** Corridor filter options. */
export function useCorridorOptions() {
  const params = useMemo(() => ({}), []);
  return useAnalyticsQuery('corridor_options', params);
}

/**
 * Station geometry. Immutable across the session, so it takes no parameters and AppKit's
 * query cache serves every later mount.
 *
 * Returns ALL stations that have frames, not just the selected corridor's, so switching
 * corridors never refetches geometry.
 */
export function useStationGeometry() {
  const params = useMemo(() => ({}), []);
  return useAnalyticsQuery('station_geometry', params);
}

/** Fixed window offsets: [0, 24, 48, 72]. */
const WINDOW_OFFSETS = Array.from({ length: WINDOW_COUNT }, (_, i) => i * BUCKETS_PER_WINDOW);

/** Query result array identity -> the view key it first arrived for. */
const DATA_VIEW_KEYS = new WeakMap<readonly unknown[], string>();

/**
 * Compose all reads into one animation-ready view.
 *
 * station_idx in the matrix is positional -- it comes from
 * `ROW_NUMBER() OVER (ORDER BY station_id)` over the SAME station set that
 * station_geometry.sql returns in the SAME order -- so the join is index-only with no
 * per-row key lookup.
 */
export function useTrafficView(day: string, freeway: string): TrafficView {
  const stationsQ = useStationGeometry();

  // Hooks must be called unconditionally in a stable order, so each of the 4 windows gets
  // its own explicit hook call rather than a loop over a dynamic list.
  const w0 = useMatrixWindow(day, freeway, WINDOW_OFFSETS[0]);
  const w1 = useMatrixWindow(day, freeway, WINDOW_OFFSETS[1]);
  const w2 = useMatrixWindow(day, freeway, WINDOW_OFFSETS[2]);
  const w3 = useMatrixWindow(day, freeway, WINDOW_OFFSETS[3]);

  const h0 = useHexWindow(day, freeway, WINDOW_OFFSETS[0]);
  const h1 = useHexWindow(day, freeway, WINDOW_OFFSETS[1]);
  const h2 = useHexWindow(day, freeway, WINDOW_OFFSETS[2]);
  const h3 = useHexWindow(day, freeway, WINDOW_OFFSETS[3]);

  const matrixWindows = [w0, w1, w2, w3];
  const hexWindows = [h0, h1, h2, h3];

  // Stations participating in the current view, in station_idx order.
  const stations = useMemo(() => {
    if (!stationsQ.data) return null;
    const scoped = freeway === 'ALL' ? stationsQ.data : stationsQ.data.filter((s) => s.freeway === freeway);
    // station_geometry.sql already orders by station_id and filter preserves order, so
    // scoped[i] corresponds to station_idx === i. Sorting defensively costs little and
    // protects against a future edit dropping the ORDER BY.
    return [...scoped].sort((a, b) => (a.station_id < b.station_id ? -1 : 1));
  }, [stationsQ.data, freeway]);

  // The view key every in-flight read belongs to. Any window whose provenance is not
  // exactly this string describes a DIFFERENT view and must not be aligned to `stations`.
  const viewKey = `${day}|${freeway}`;

  // Only windows proven to have been fetched FOR THE CURRENT VIEW. See useTaggedWindow for
  // why provenance -- not a station count -- is the correct discriminator.
  const packedWindows = matrixWindows.map((q) => (q.viewKey === viewKey ? firstRow(q.data) : null));
  const packedHexWindows = hexWindows.map((q) => (q.viewKey === viewKey ? firstRow(q.data) : null));

  // Rebuild only when a new window actually arrives, not on every render. The key is scoped
  // by viewKey so switching corridor always invalidates the memo, even between two corridors
  // whose payloads happen to look alike.
  const matrixKey = `${viewKey}#${packedWindows.map((w) => (w ? w.first_bucket : 'x')).join('|')}`;
  const matrix = useMemo(() => {
    if (!stations || stations.length === 0) return null;
    const present = packedWindows.filter((w): w is PackedWindow => w !== null);
    if (present.length === 0) return null;
    assertStationSetAligned(present, stations.length, viewKey);
    const m = createFrameMatrix(stations.length);
    for (const win of present) applyPackedWindow(m, win);
    return m;
    // packedWindows is rebuilt each render; matrixKey captures its meaningful identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, matrixKey]);

  const hexKey = `${viewKey}#${packedHexWindows.map((w) => (w ? w.first_bucket : 'x')).join('|')}`;
  const hexFrames = useMemo(() => {
    const present = packedHexWindows.filter((w): w is PackedHexWindow => w !== null);
    if (present.length === 0) return null;
    // The hex dictionary is identical across windows OF ONE CORRIDOR (hex_dim spans the whole
    // day), so any window's copy defines the index space -- but NOT across corridors, which
    // have different cell sets. Provenance filtering above guarantees every window here is
    // from one corridor; a hex_count disagreement within that set would mean the four windows
    // of ONE view disagree, which applyPackedHexWindow cannot detect on its own (unlike
    // applyPackedWindow it has no built-in guard) and would silently write one cell's
    // congestion into another's index. Fail LOUD rather than draw a plausible wrong map.
    const hexIds = present[0].hex_ids.split(',');
    assertHexSetAligned(present, hexIds, viewKey);
    const frames = createHexFrames(hexIds);
    for (const win of present) applyPackedHexWindow(frames, win);
    return frames;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hexKey]);

  const allQueries = [stationsQ, ...matrixWindows, ...hexWindows];
  const error = allQueries.find((q) => q.error)?.error ?? null;

  return {
    matrix,
    hexFrames,
    stations,
    loading: allQueries.some((q) => q.loading),
    error,
    // Counts only windows belonging to the current view, so a mid-corridor-switch render does
    // not report the previous corridor's windows as already loaded.
    windowsLoaded: packedWindows.filter(Boolean).length,
  };
}

/**
 * The view a window belongs to: `${day}|${freeway}`. Exported so the guard tests and the
 * hook cannot drift apart on the format.
 */
export function trafficViewKey(day: string, freeway: string): string {
  return `${day}|${freeway}`;
}

/**
 * Throw if any window disagrees with the geometry about how many stations this view has.
 *
 * Reached ONLY after provenance filtering, so a disagreement here is NOT the benign
 * mid-corridor-switch race -- it means traffic_time_matrix and station_geometry genuinely
 * disagree about the station set for the SAME (day, freeway). Waiting cannot fix that, and
 * aligning positionally anyway would attribute one station's speed to another while every
 * individual value still looked plausible -- the same failure mode as the ARRAY_AGG trap.
 * So this fails LOUD: the throw reaches ErrorBoundary, which renders the message and stack.
 */
export function assertStationSetAligned(
  windows: readonly PackedWindow[],
  stationCount: number,
  viewKey: string,
): void {
  const mismatch = windows.find((w) => Number(w.stations) !== stationCount);
  if (!mismatch) return;
  throw new Error(
    `STATION SET MISMATCH for view ${viewKey}: traffic_time_matrix window at bucket ` +
      `${Number(mismatch.first_bucket)} reports ${Number(mismatch.stations)} stations but ` +
      `station_geometry yields ${stationCount} for the same day+corridor. Refusing to align ` +
      `station_idx -- positional alignment would mis-attribute every metric. Check that both ` +
      `queries scope stations identically (EXISTS in gold_map_frames).`,
  );
}

/** Same contract as assertStationSetAligned, for the hex index space. */
export function assertHexSetAligned(
  windows: readonly PackedHexWindow[],
  hexIds: readonly string[],
  viewKey: string,
): void {
  const mismatch = windows.find((w) => Number(w.hex_count) !== hexIds.length);
  if (!mismatch) return;
  throw new Error(
    `HEX SET MISMATCH for view ${viewKey}: h3_congestion_hexes window at bucket ` +
      `${Number(mismatch.first_bucket)} reports ${Number(mismatch.hex_count)} cells but the ` +
      `window at bucket ${Number(windows[0].first_bucket)} defined ${hexIds.length}. hex_dim ` +
      `must span the whole day so every window of one view shares an index space.`,
  );
}

/**
 * A window read tagged with the view it was actually fetched for.
 *
 * WHY PROVENANCE AND NOT A COUNT. On a corridor change `stations` narrows SYNCHRONOUSLY
 * (it is derived by filtering the already-cached all-corridor geometry) while the eight
 * window queries are still in flight. useAnalyticsQuery clears `data` to null from an
 * effect, i.e. AFTER that render, so for one render the hook still returns the PREVIOUS
 * corridor's rows next to the new corridor's geometry. Aligning those positionally is the
 * M1 corridor-switch bug.
 *
 * Comparing station counts detects that only by luck. Scoped as station_geometry.sql scopes
 * them, today's ten corridors happen to have distinct counts (I-680 75, I-880 77, I-210 104,
 * I-405 129, I-80 165, SR-99 169, I-15 178, I-10 215, US-101 379, I-5 503) -- but in raw
 * silver_stations_geo I-80 and SR-99 are BOTH exactly 170, so one upstream row change
 * collapses the guard and it fails silently, drawing I-80's congestion on SR-99's stations.
 *
 * So this hook records which (day, freeway) each `data` object arrived for and exposes it as
 * `viewKey`. The caller keeps a window only when that tag equals the view it is rendering,
 * which is a statement about identity rather than about a coincidence of cardinality.
 */
function useTaggedWindow<T>(
  result: { data: readonly T[] | null; loading: boolean; error: string | null },
  viewKey: string,
): { data: readonly T[] | null; loading: boolean; error: string | null; viewKey: string } {
  if (result.data === null) return { ...result, viewKey };
  if (!DATA_VIEW_KEYS.has(result.data)) DATA_VIEW_KEYS.set(result.data, viewKey);
  return { ...result, viewKey: DATA_VIEW_KEYS.get(result.data) ?? viewKey };
}

function useMatrixWindow(day: string, freeway: string, fromBucket: number) {
  const params = useMemo(
    () => ({
      day: sql.date(day),
      freeway: sql.string(freeway),
      from_bucket: sql.int(fromBucket),
    }),
    [day, freeway, fromBucket]
  );
  return useTaggedWindow(useAnalyticsQuery('traffic_time_matrix', params), `${day}|${freeway}`);
}

function useHexWindow(day: string, freeway: string, fromBucket: number) {
  const params = useMemo(
    () => ({
      day: sql.date(day),
      freeway: sql.string(freeway),
      from_bucket: sql.int(fromBucket),
    }),
    [day, freeway, fromBucket]
  );
  return useTaggedWindow(useAnalyticsQuery('h3_congestion_hexes', params), `${day}|${freeway}`);
}

/**
 * These queries aggregate to exactly one row. Pull it out defensively -- an empty result is
 * a legitimate state (a corridor/window with no rows), not an error.
 *
 * Typed via the generated QueryRegistry result element rather than a cast, so a SQL column
 * rename breaks the build here instead of silently producing undefined at runtime.
 */
function firstRow<T>(data: readonly T[] | null | undefined): T | null {
  if (!data || data.length === 0) return null;
  return data[0];
}
