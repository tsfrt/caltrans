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

  const packedWindows = matrixWindows.map((q) => firstRow(q.data));
  const packedHexWindows = hexWindows.map((q) => firstRow(q.data));

  // Rebuild only when a new window actually arrives, not on every render.
  const matrixKey = packedWindows.map((w) => (w ? w.first_bucket : 'x')).join('|');
  const alignmentError = useMemo(() => {
    if (!stations || stations.length === 0) return null;
    const stale = packedWindows.find(
      (win): win is PackedWindow => win !== null && Number(win.stations) !== stations.length
    );
    if (!stale) return null;
    return (
      `STALE WINDOW GUARD: traffic_time_matrix returned ${Number(stale.stations)} stations ` +
      `but the active geometry has ${stations.length}. Refusing to align station_idx until ` +
      `the corridor/day query cache catches up.`
    );
    // packedWindows is rebuilt each render; matrixKey captures its meaningful identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, matrixKey]);

  const matrix = useMemo(() => {
    if (!stations || stations.length === 0) return null;
    if (alignmentError) return null;
    const present = packedWindows.filter((w): w is PackedWindow => w !== null);
    if (present.length === 0) return null;
    const m = createFrameMatrix(stations.length);
    for (const win of present) applyPackedWindow(m, win);
    return m;
    // packedWindows is rebuilt each render; matrixKey captures its meaningful identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, matrixKey, alignmentError]);

  const hexKey = packedHexWindows.map((w) => (w ? w.first_bucket : 'x')).join('|');
  const hexFrames = useMemo(() => {
    const present = packedHexWindows.filter((w): w is PackedHexWindow => w !== null);
    if (present.length === 0) return null;
    // The hex dictionary is identical across windows (hex_dim spans the whole day), so any
    // window's copy defines the index space.
    const hexIds = present[0].hex_ids.split(',');
    const frames = createHexFrames(hexIds);
    for (const win of present) applyPackedHexWindow(frames, win);
    return frames;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hexKey]);

  const allQueries = [stationsQ, ...matrixWindows, ...hexWindows];
  const error = alignmentError ?? allQueries.find((q) => q.error)?.error ?? null;

  return {
    matrix,
    hexFrames,
    stations,
    loading: allQueries.some((q) => q.loading),
    error,
    windowsLoaded: packedWindows.filter(Boolean).length,
  };
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
  return useAnalyticsQuery('traffic_time_matrix', params);
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
  return useAnalyticsQuery('h3_congestion_hexes', params);
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
