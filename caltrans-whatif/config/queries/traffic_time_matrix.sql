-- THE ANIMATION PAYLOAD. Fetched once per (day, corridor, window); NEVER during animation.
--
-- @param day DATE
-- @param freeway STRING
-- @param from_bucket INT
--
-- ── Why this returns ONE row of packed strings ─────────────────────────────────
-- gold_map_frames is 5,742,720 rows. One Pacific-local day of all 10 corridors is
-- 191,424 rows (1,994 stations x 96 buckets). AppKit caps a single SSE event at 1 MiB
-- (appkit/dist/stream/defaults.js `maxEventSize: 1024 * 1024`), and MEASURED payloads for
-- that day are:
--   row-per-record JSON_ARRAY  9,540,471 B (9.10 MiB)  -- 9x over the cap
--   ARROW_STREAM               3,059,728 B (2.92 MiB)  -- under the cap, but see below
--   this columnar shape, x4 windows  2,594,580 B total (~0.62 MiB per window)  -- FITS
--
-- ARROW_STREAM would have been the natural transport and IS smaller per-request, but it
-- is UNUSABLE in this environment: Databricks serves Arrow via EXTERNAL_LINKS presigned
-- URLs on storage-proxy.databricks.com, and that host is unreachable from here --
-- it resolves to a sandbox egress proxy (192.168.200.28) and returns HTTP 500 for every
-- chunk, including for a trivial `SELECT 1`. So the app would fail with
-- "Failed to download chunk 0: 500 Internal Server Error". Verified empirically; this is
-- an environment/egress limitation, not a query problem. If a deployment has working
-- storage-proxy egress, ARROW_STREAM becomes viable and this query could be simplified
-- back to row-per-record.
--
-- Hence: transpose to COLUMNAR. Each metric becomes one comma-separated string, so the
-- ~48k JSON tokens per column collapse to a single string with no repeated key names and
-- no per-row brackets. The client splits these into typed arrays once (lib/frames.ts).
--
-- ── Why windowed instead of hourly ────────────────────────────────────────────
-- A whole day columnar is 2.47 MiB -- still over the cap. Two ways to fit:
--   (a) downsample to hourly  -> 0.618 MiB, but DESTROYS the 15-minute resolution that
--       the animation is supposed to demonstrate.
--   (b) keep 15-minute buckets and fetch the day in 4 windows of 24 buckets (6h each)
--       -> ~0.62 MiB per window.
-- (b) is chosen: full fidelity, and the client fetches all four windows in parallel on
-- load, so the whole 96-bucket day still ends up in memory before playback and the
-- animation still never touches the warehouse.
--
-- ── Encoding ──────────────────────────────────────────────────────────────────
-- Values are scaled to integers because "48.4" costs more characters than "97":
--   flow        vehicles/hour, as-is
--   speed_half  mph x 2 (half-mph precision)  -> client divides by 2
--   vc_pct      v/c x 100 (percent)           -> client divides by 100
--   incident    0 = none, else severity 1..4
-- level_of_service is NOT sent: it is a pure function of speed/vc, so the client derives
-- it rather than paying for a seventh column.
--
-- ── Pacific-time correctness ──────────────────────────────────────────────────
-- `reading_date` IS the Pacific local date, not the UTC date: all 5,742,720 rows satisfy
-- reading_date = to_date(from_utc_timestamp(time_bucket,'America/Los_Angeles')) while only
-- 4,067,760 satisfy the UTC equivalent. Filtering on it therefore yields exactly 96
-- buckets of one clean local day with no UTC straddle, AND keeps the predicate on a bare
-- partition column so clustering still prunes.
--
-- ── M2 seam ───────────────────────────────────────────────────────────────────
-- A scenario-parameterized query replaces this file's body only. The client contract
-- (n, first_bucket, stations, and the four packed columns) stays fixed, so the animation
-- code does not change. baseline_capacity_vph rides along in station_geometry.sql so the
-- client can recompute v/c under perturbed capacity without refetching.
WITH filtered AS (
  SELECT *
  FROM lanl.caltrans_traffic.gold_map_frames
  WHERE reading_date = :day
    AND (:freeway = 'ALL' OR freeway = :freeway)
),
station_order AS (
  -- Dense 0..N-1 station index. MUST use the same ORDER BY station_id as
  -- station_geometry.sql -- that shared ordering is the entire client-side join.
  -- Derived from the whole day, NOT the window, so indices are stable across windows.
  SELECT
    station_id,
    CAST(ROW_NUMBER() OVER (ORDER BY station_id) - 1 AS INT) AS station_idx
  FROM (SELECT DISTINCT station_id FROM filtered)
),
cells AS (
  SELECT
    (hour(from_utc_timestamp(f.time_bucket, 'America/Los_Angeles')) * 4)
      + (minute(from_utc_timestamp(f.time_bucket, 'America/Los_Angeles')) DIV 15) AS bucket_idx,
    o.station_idx,
    CAST(f.avg_flow_vph AS INT) AS flow,
    CAST(ROUND(f.avg_speed_mph * 2) AS INT) AS speed_half,
    CAST(ROUND(f.vc_ratio * 100) AS INT) AS vc_pct,
    CAST(
      CASE WHEN f.incident_active THEN COALESCE(f.max_incident_severity, 1) ELSE 0 END
      AS INT
    ) AS incident
  FROM filtered f
  JOIN station_order o ON o.station_id = f.station_id
),
windowed AS (
  SELECT
    *,
    -- Explicit sort key. bucket-major, station-minor. The 100000 multiplier exceeds the
    -- max station count (1,994) by a wide margin, so the two fields never collide.
    CAST((bucket_idx - :from_bucket) * 100000 + station_idx AS BIGINT) AS ord
  FROM cells
  WHERE bucket_idx >= :from_bucket
    AND bucket_idx < :from_bucket + 24
)
-- ⚠️ ARRAY_AGG / COLLECT_LIST DO NOT INHERIT A SUBQUERY'S `ORDER BY`.
-- An earlier version of this query used `ARRAY_AGG(x)` over an `ORDER BY bucket, station`
-- subquery and produced SCRAMBLED output: bucket 68 decoded to a mean speed of 64.80 mph
-- when the ground truth is 48.44 mph, i.e. the 17:00 rush hour silently vanished from the
-- map while every value still looked individually plausible. Spark makes no ordering
-- guarantee for these aggregates regardless of input order.
--
-- The fix is to make the order explicit and data-dependent: collect (ord, value) structs,
-- ARRAY_SORT them by ord with an explicit comparator, then project the value out. This
-- yields exactly the layout the client indexes as
--   offset = (bucket - first_bucket) * stations + station_idx
-- Verified against ground truth: bucket 48 -> 66.64 mph, bucket 68 -> 48.44 mph.
-- Cost of correctness: none measurable (0.624 MiB, ~2.3s, same as the broken version).
SELECT
  CAST(COUNT(*) AS INT) AS n,
  CAST(MIN(bucket_idx) AS INT) AS first_bucket,
  CAST(MAX(bucket_idx) AS INT) AS last_bucket,
  CAST(COUNT(DISTINCT station_idx) AS INT) AS stations,
  ARRAY_JOIN(
    TRANSFORM(
      ARRAY_SORT(
        COLLECT_LIST(STRUCT(ord, flow)),
        (l, r) -> CASE WHEN l.ord < r.ord THEN -1 WHEN l.ord > r.ord THEN 1 ELSE 0 END
      ),
      x -> CAST(x.flow AS STRING)
    ), ','
  ) AS flow,
  ARRAY_JOIN(
    TRANSFORM(
      ARRAY_SORT(
        COLLECT_LIST(STRUCT(ord, speed_half)),
        (l, r) -> CASE WHEN l.ord < r.ord THEN -1 WHEN l.ord > r.ord THEN 1 ELSE 0 END
      ),
      x -> CAST(x.speed_half AS STRING)
    ), ','
  ) AS speed_half,
  ARRAY_JOIN(
    TRANSFORM(
      ARRAY_SORT(
        COLLECT_LIST(STRUCT(ord, vc_pct)),
        (l, r) -> CASE WHEN l.ord < r.ord THEN -1 WHEN l.ord > r.ord THEN 1 ELSE 0 END
      ),
      x -> CAST(x.vc_pct AS STRING)
    ), ','
  ) AS vc_pct,
  ARRAY_JOIN(
    TRANSFORM(
      ARRAY_SORT(
        COLLECT_LIST(STRUCT(ord, incident)),
        (l, r) -> CASE WHEN l.ord < r.ord THEN -1 WHEN l.ord > r.ord THEN 1 ELSE 0 END
      ),
      x -> CAST(x.incident AS STRING)
    ), ','
  ) AS incident
FROM windowed
