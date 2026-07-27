/**
 * The animation data model.
 *
 * ARCHITECTURE RULE (docs/ARCHITECTURE.md §3): nothing queries the warehouse during
 * animation. The warehouse is hit a fixed number of times per (day, corridor) view;
 * everything below then runs off flat typed arrays already resident in browser memory.
 * A Small warehouse answers one query in ~0.8s but could never serve 96 frames at
 * interactive rates.
 *
 * Layout is a dense [bucket][station] matrix flattened into one allocation per metric:
 *
 *     offset = bucket_idx * stationCount + station_idx
 *
 * so reading frame N is a contiguous subarray view -- no per-frame allocation, no
 * grouping, no object churn, no GC pressure during playback. That is the property that
 * makes the scrubber smooth.
 */

export const BUCKETS_PER_DAY = 96; // 24h / 15min
export const MINUTES_PER_BUCKET = 15;

/** Buckets per fetched window. 96 / 24 = 4 windows per day. See traffic_time_matrix.sql. */
export const BUCKETS_PER_WINDOW = 24;
export const WINDOW_COUNT = BUCKETS_PER_DAY / BUCKETS_PER_WINDOW;

/** Level-of-service labels, indexed by the code returned from losFromSpeedAndVc(). */
export const LOS_LABELS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

/** Sentinel for "no corridor filter" -- mirrors the `:freeway = 'ALL'` SQL predicate. */
export const ALL_CORRIDORS = 'ALL';

/** Sentinel written by h3_congestion_hexes.sql for a hex with no stations in a bucket. */
const NO_DATA = -1;

export interface FrameMatrix {
  stationCount: number;
  bucketCount: number;
  /** vehicles/hour */
  flow: Int32Array;
  /** mph */
  speed: Float32Array;
  /** volume/capacity; > 1 means demand exceeds capacity */
  vc: Float32Array;
  /** 0 = no incident, else severity 1..4 */
  incident: Uint8Array;
  /** buckets that were actually populated by a fetched window */
  bucketsLoaded: boolean[];
}

/** One row of traffic_time_matrix: a packed window of 24 buckets. */
export interface PackedWindow {
  n: number;
  first_bucket: number;
  last_bucket: number;
  stations: number;
  flow: string;
  speed_half: string;
  vc_pct: string;
  incident: string;
}

/** Allocate an empty full-day matrix that windows are then scattered into. */
export function createFrameMatrix(stationCount: number): FrameMatrix {
  const size = BUCKETS_PER_DAY * stationCount;
  const speed = new Float32Array(size);
  // NaN marks "no reading" so KPI means can exclude holes rather than averaging in a fake
  // zero, which would drag mean speed down and misreport congestion.
  speed.fill(Number.NaN);
  return {
    stationCount,
    bucketCount: BUCKETS_PER_DAY,
    flow: new Int32Array(size),
    speed,
    vc: new Float32Array(size),
    incident: new Uint8Array(size),
    bucketsLoaded: new Array<boolean>(BUCKETS_PER_DAY).fill(false),
  };
}

/**
 * Scatter one packed window into the day matrix, in place.
 *
 * The SQL emits values in (bucket major, station minor) order -- guaranteed by the
 * `ORDER BY bucket_idx, station_idx` inside the aggregating subquery -- so the i-th value
 * of each packed column maps to:
 *   bucket  = first_bucket + floor(i / stations)
 *   station = i % stations
 *
 * Decoding is done with a manual character scan rather than String.split(',').map(Number).
 * split() on a ~48k-element string allocates 48k intermediate strings per column per
 * window (~200k short-lived objects per window, x4 windows x2 queries); the scan writes
 * straight into the typed array with zero intermediate allocation.
 */
export function applyPackedWindow(matrix: FrameMatrix, win: PackedWindow): void {
  const stations = Number(win.stations);
  const firstBucket = Number(win.first_bucket);

  if (stations !== matrix.stationCount) {
    throw new Error(
      `traffic_time_matrix returned ${stations} stations but geometry has ` +
        `${matrix.stationCount} -- station_idx alignment would be wrong`,
    );
  }

  const flow = parsePackedInts(win.flow);
  const speedHalf = parsePackedInts(win.speed_half);
  const vcPct = parsePackedInts(win.vc_pct);
  const incident = parsePackedInts(win.incident);

  const count = flow.length;
  for (let i = 0; i < count; i++) {
    const bucket = firstBucket + Math.floor(i / stations);
    if (bucket >= BUCKETS_PER_DAY) break;
    const off = bucket * stations + (i % stations);
    matrix.flow[off] = flow[i];
    // Undo the integer scaling applied in SQL to keep the payload small.
    matrix.speed[off] = speedHalf[i] / 2;
    matrix.vc[off] = vcPct[i] / 100;
    matrix.incident[off] = incident[i];
  }

  const lastBucket = Math.min(Number(win.last_bucket), BUCKETS_PER_DAY - 1);
  for (let b = firstBucket; b <= lastBucket; b++) matrix.bucketsLoaded[b] = true;
}

/**
 * Parse a comma-separated integer string into an Int32Array without intermediate strings.
 * Handles negative values (the -1 no-data sentinel in the H3 payload).
 */
export function parsePackedInts(packed: string): Int32Array {
  if (!packed) return new Int32Array(0);

  // Exact count up front so the array is allocated once at the right size.
  let count = 1;
  for (let i = 0; i < packed.length; i++) {
    if (packed.charCodeAt(i) === 44 /* ',' */) count++;
  }

  const out = new Int32Array(count);
  let idx = 0;
  let value = 0;
  let negative = false;
  let seenDigit = false;

  for (let i = 0; i < packed.length; i++) {
    const code = packed.charCodeAt(i);
    if (code === 44 /* ',' */) {
      out[idx++] = negative ? -value : value;
      value = 0;
      negative = false;
      seenDigit = false;
    } else if (code === 45 /* '-' */ && !seenDigit) {
      negative = true;
    } else if (code >= 48 && code <= 57) {
      value = value * 10 + (code - 48);
      seenDigit = true;
    }
    // Anything else (e.g. stray whitespace) is ignored rather than producing NaN.
  }
  out[idx] = negative ? -value : value;
  return out;
}

/** Contiguous view of one metric at one bucket. Does not copy the underlying data. */
export function frameSlice<T extends Int32Array | Float32Array | Uint8Array>(
  arr: T,
  bucket: number,
  stationCount: number,
): T {
  const start = bucket * stationCount;
  return arr.subarray(start, start + stationCount) as T;
}

/** Format a bucket index as a Pacific-local wall-clock label, e.g. 68 -> "17:00". */
export function bucketToLocalTime(bucket: number): string {
  const totalMinutes = bucket * MINUTES_PER_BUCKET;
  const h = Math.floor(totalMinutes / 60) % 24;
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Level-of-service code 0..5 (A..F) derived client-side.
 *
 * LOS is a deterministic function of speed and v/c, so deriving it here avoids sending a
 * seventh column across ~191k cells. Thresholds follow the HCM-style banding used when the
 * gold table was built (free flow ~65 mph degrading to LOS F under breakdown).
 */
export function losFromSpeedAndVc(speed: number, vc: number): number {
  if (Number.isNaN(speed)) return 5;
  if (vc >= 1 || speed < 30) return 5; // F -- breakdown / over capacity
  if (speed < 40) return 4; // E
  if (speed < 50) return 3; // D
  if (speed < 57) return 2; // C
  if (speed < 62) return 1; // B
  return 0; // A
}

export interface FrameKpis {
  meanSpeed: number;
  totalFlow: number;
  pctCongested: number;
  overCapacity: number;
  incidents: number;
  observed: number;
}

/**
 * KPIs for the currently displayed frame, computed over the typed arrays.
 *
 * O(stationCount) over a contiguous span (~1,994 elements) -- microseconds, so this is
 * safe to run every animation tick rather than needing its own query.
 */
export function computeFrameKpis(matrix: FrameMatrix, bucket: number): FrameKpis {
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
      // LOS E(4) and F(5) are the congested classes.
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

export interface CorridorStat {
  freeway: string;
  meanSpeed: number;
  totalFlow: number;
  congestedPct: number;
}

/** Per-corridor rollup for the current frame, sorted worst (slowest) first. */
export function computeWorstCorridors(
  matrix: FrameMatrix,
  bucket: number,
  freewayByStation: string[],
  limit = 5,
): CorridorStat[] {
  const { stationCount } = matrix;
  const speed = frameSlice(matrix.speed, bucket, stationCount);
  const flow = frameSlice(matrix.flow, bucket, stationCount);
  const vc = frameSlice(matrix.vc, bucket, stationCount);

  const acc = new Map<string, { speedSum: number; n: number; flow: number; congested: number }>();
  for (let i = 0; i < stationCount; i++) {
    const fw = freewayByStation[i];
    if (!fw) continue;
    let a = acc.get(fw);
    if (!a) {
      a = { speedSum: 0, n: 0, flow: 0, congested: 0 };
      acc.set(fw, a);
    }
    const s = speed[i];
    if (!Number.isNaN(s)) {
      a.speedSum += s;
      a.n++;
      if (losFromSpeedAndVc(s, vc[i]) >= 4) a.congested++;
    }
    a.flow += flow[i];
  }

  return [...acc.entries()]
    .map(([freeway, a]) => ({
      freeway,
      meanSpeed: a.n > 0 ? a.speedSum / a.n : 0,
      totalFlow: a.flow,
      congestedPct: a.n > 0 ? (a.congested / a.n) * 100 : 0,
    }))
    .sort((x, y) => x.meanSpeed - y.meanSpeed)
    .slice(0, limit);
}

/**
 * Congestion colour ramp, green -> red, driven by speed.
 *
 * Speed is used rather than the LOS band because it is continuous, so colour shifts
 * smoothly as the animation interpolates instead of stepping between six discrete bands.
 */
export function speedToColor(speed: number): [number, number, number] {
  if (Number.isNaN(speed)) return [90, 90, 100];
  // 65 mph free flow -> green; 20 mph and below -> red.
  const t = Math.max(0, Math.min(1, (65 - speed) / 45));
  if (t < 0.5) {
    // green -> amber
    const k = t / 0.5;
    return [Math.round(64 + k * 191), Math.round(209 - k * 40), Math.round(90 - k * 60)];
  }
  // amber -> red
  const k = (t - 0.5) / 0.5;
  return [Math.round(255 - k * 20), Math.round(169 - k * 147), Math.round(30 - k * 30)];
}

// ── H3 hexagon frames ─────────────────────────────────────────────────────────

/** One row of h3_congestion_hexes: a packed window plus the hex-id dictionary. */
export interface PackedHexWindow {
  hex_count: number;
  first_bucket: number;
  /** Highest congestion_pct in this window; used to normalise elevation. */
  max_congestion_pct: number;
  hex_ids: string;
  congestion_pct: string;
  speed_half: string;
}

export interface HexFrames {
  /** Canonical H3 hex strings, indexed by hex_idx. Passed straight to H3HexagonLayer. */
  hexIds: string[];
  /** congestion, [bucket][hex]; NaN where the hex had no stations in that bucket. */
  congestion: Float32Array;
  /** mph, [bucket][hex] */
  speed: Float32Array;
  hexCount: number;
  /**
   * Largest congestion value seen across all loaded windows, as a 0..1 fraction.
   * Elevation is normalised against this so the tallest hex is always readable regardless
   * of how skewed the day is (raw congestion_index has p50 0.008 vs max 0.884).
   */
  maxCongestion: number;
}

export function createHexFrames(hexIds: string[]): HexFrames {
  const size = BUCKETS_PER_DAY * hexIds.length;
  const congestion = new Float32Array(size);
  const speed = new Float32Array(size);
  congestion.fill(Number.NaN);
  speed.fill(Number.NaN);
  return { hexIds, congestion, speed, hexCount: hexIds.length, maxCongestion: 0 };
}

/** Scatter one packed H3 window into the day-wide hex frames, in place. */
export function applyPackedHexWindow(frames: HexFrames, win: PackedHexWindow): void {
  const hexCount = frames.hexCount;
  const firstBucket = Number(win.first_bucket);
  const congestion = parsePackedInts(win.congestion_pct);
  const speedHalf = parsePackedInts(win.speed_half);

  for (let i = 0; i < congestion.length; i++) {
    const bucket = firstBucket + Math.floor(i / hexCount);
    if (bucket >= BUCKETS_PER_DAY) break;
    const off = bucket * hexCount + (i % hexCount);
    const c = congestion[i];
    // -1 is the SQL no-data sentinel; keep it NaN so the layer can skip the cell instead
    // of drawing it as zero congestion (which would read as "free flowing").
    frames.congestion[off] = c === NO_DATA ? Number.NaN : c / 100;
    frames.speed[off] = c === NO_DATA ? Number.NaN : speedHalf[i] / 2;
  }

  // Track the running max across windows so elevation scaling is stable once all four land.
  const windowMax = Number(win.max_congestion_pct) / 100;
  if (Number.isFinite(windowMax) && windowMax > frames.maxCongestion) {
    frames.maxCongestion = windowMax;
  }
}
