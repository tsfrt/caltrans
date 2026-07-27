-- H3 congestion aggregation -- the DBSQL geospatial showcase, computed IN the warehouse.
--
-- @param day DATE
-- @param freeway STRING
-- @param from_bucket INT
--
-- Deliberately server-side: the point of the layer is that DBSQL's native H3 support does
-- the spatial binning. The client only renders what came back.
--
-- ── Why resolution 5, not the stored r7 ───────────────────────────────────────
-- The table stores h3_r7/r8/r9. Rendering r7 directly was tried and looked WRONG: an r7
-- cell is ~5 km across, and because the stations only exist along freeway centrelines the
-- cells just retrace the corridor lines as sub-pixel specks at statewide zoom -- visually
-- indistinguishable from the station layer, so the H3 aggregation read as "not working".
-- h3_toparent(h3_r7, 5) rolls r7 up to res 5 (~25 km cells): 1,994 stations -> 239 cells
-- (vs 890 at r7, 556 at r6, 81 at r4), which is coarse enough to read as genuine REGIONAL
-- congestion at California zoom. This also demonstrates the H3 hierarchy, which is a
-- better showcase of the builtins than a flat grouping.
--
-- h3_h3tostring is the correct BIGINT -> canonical hex string builtin on this
-- warehouse/channel; `h3_h3celltostring` does NOT exist here (verified: UNRESOLVED_ROUTINE).
-- deck.gl's H3HexagonLayer requires that string form and will not accept the BIGINT.
--
-- ── Why congestion is renormalised ────────────────────────────────────────────
-- Raw congestion_index is heavily skewed: for 2026-06-10 min 0.0, p50 0.008, p99 0.526,
-- max 0.884. Feeding the raw mean into getElevation produced essentially flat hexagons
-- (0.02 * 22000 = a few hundred metres, invisible at this scale). congestion_pct is the
-- mean scaled to percent, and max_congestion_pct reports the highest value in this window
-- so the client can normalise elevation against the actual observed range rather than a
-- hardcoded guess.
--
-- ── Payload shape ─────────────────────────────────────────────────────────────
-- Same columnar+windowed strategy as traffic_time_matrix.sql, and for the same reason:
-- AppKit's 1 MiB SSE event cap, with the ARROW_STREAM escape hatch unavailable because
-- storage-proxy.databricks.com is unreachable from this environment (HTTP 500 on every
-- presigned chunk). MEASURED: ~0.14 MiB per 24-bucket window.
--
-- The 15-char hex ids dominate the payload, so they are sent ONCE as a dictionary
-- (hex_ids) and the per-bucket metrics are dense positional arrays indexed into it. The
-- CROSS JOIN makes the grid dense so the client needs no per-bucket key list; cells with
-- no stations in a bucket carry congestion_pct = -1, which the client reads as "no data"
-- and skips rather than drawing as zero congestion.
--
-- Bucketing matches traffic_time_matrix.sql exactly -- same reading_date partition
-- predicate, same Pacific-local bucket_idx derivation -- so hexes and stations stay in
-- lockstep on one shared animation clock.
WITH filtered AS (
  SELECT *
  FROM lanl.caltrans_traffic.gold_map_frames
  WHERE reading_date = :day
    AND (:freeway = 'ALL' OR freeway = :freeway)
),
agg AS (
  SELECT
    (hour(from_utc_timestamp(time_bucket, 'America/Los_Angeles')) * 4)
      + (minute(from_utc_timestamp(time_bucket, 'America/Los_Angeles')) DIV 15) AS bucket_idx,
    -- h3_toparent walks the H3 hierarchy from the stored r7 cell up to r5.
    h3_h3tostring(h3_toparent(h3_r7, 5)) AS hex_id,
    -- Scaled to integers to keep the packed strings short.
    CAST(ROUND(AVG(congestion_index) * 100) AS INT) AS congestion_pct,
    CAST(ROUND(AVG(avg_speed_mph) * 2) AS INT) AS speed_half
  FROM filtered
  GROUP BY bucket_idx, hex_id
),
hex_dim AS (
  -- Stable hex ordering for the whole day, so hex indices are identical across windows.
  SELECT hex_id, CAST(ROW_NUMBER() OVER (ORDER BY hex_id) - 1 AS INT) AS hex_idx
  FROM (SELECT DISTINCT hex_id FROM agg)
),
dense AS (
  SELECT
    b.bucket_idx,
    h.hex_idx,
    COALESCE(a.congestion_pct, -1) AS congestion_pct,
    COALESCE(a.speed_half, 0) AS speed_half
  FROM (SELECT DISTINCT bucket_idx FROM agg) b
  CROSS JOIN hex_dim h
  LEFT JOIN agg a ON a.bucket_idx = b.bucket_idx AND a.hex_id = h.hex_id
),
windowed AS (
  SELECT
    *,
    -- Explicit sort key: bucket-major, hex-minor. 10000 comfortably exceeds the 239
    -- distinct res-5 cells, so the two fields cannot collide.
    CAST((bucket_idx - :from_bucket) * 10000 + hex_idx AS BIGINT) AS ord
  FROM dense
  WHERE bucket_idx >= :from_bucket
    AND bucket_idx < :from_bucket + 24
)
-- ⚠️ Same hazard as traffic_time_matrix.sql: ARRAY_AGG / COLLECT_LIST DO NOT inherit a
-- subquery's ORDER BY, so the positional contract must be enforced with an explicit
-- ARRAY_SORT over (ord, value) structs. Getting this wrong scrambles which hexagon shows
-- which congestion value -- visually plausible, completely wrong.
-- hex_ids is sorted the same way so hex_idx i always names hexIds[i] on the client.
SELECT
  CAST((SELECT COUNT(*) FROM hex_dim) AS INT) AS hex_count,
  CAST(MIN(bucket_idx) AS INT) AS first_bucket,
  CAST(MAX(congestion_pct) AS INT) AS max_congestion_pct,
  (
    SELECT ARRAY_JOIN(
      TRANSFORM(
        ARRAY_SORT(
          COLLECT_LIST(STRUCT(hex_idx, hex_id)),
          (l, r) -> CASE WHEN l.hex_idx < r.hex_idx THEN -1
                         WHEN l.hex_idx > r.hex_idx THEN 1 ELSE 0 END
        ),
        x -> x.hex_id
      ), ','
    )
    FROM hex_dim
  ) AS hex_ids,
  ARRAY_JOIN(
    TRANSFORM(
      ARRAY_SORT(
        COLLECT_LIST(STRUCT(ord, congestion_pct)),
        (l, r) -> CASE WHEN l.ord < r.ord THEN -1 WHEN l.ord > r.ord THEN 1 ELSE 0 END
      ),
      x -> CAST(x.congestion_pct AS STRING)
    ), ','
  ) AS congestion_pct,
  ARRAY_JOIN(
    TRANSFORM(
      ARRAY_SORT(
        COLLECT_LIST(STRUCT(ord, speed_half)),
        (l, r) -> CASE WHEN l.ord < r.ord THEN -1 WHEN l.ord > r.ord THEN 1 ELSE 0 END
      ),
      x -> CAST(x.speed_half AS STRING)
    ), ','
  ) AS speed_half
FROM windowed
