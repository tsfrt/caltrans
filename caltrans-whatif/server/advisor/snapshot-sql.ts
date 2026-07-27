/**
 * The DBSQL side of the snapshot context.
 *
 * ── WHY THESE QUERIES LIVE HERE AND NOT IN config/queries/ ────────────────────────────
 * `config/queries/*.sql` is the *client*-facing seam: those files are typegen'd into the
 * `QueryRegistry` and reachable from the browser via `POST /api/analytics/query/<key>`.
 * The advisor's aggregates are only ever consumed server-side, on the way into a model
 * prompt. Exposing them as client query keys would widen the app's public surface for no
 * caller. They are executed through `AppKit.analytics.query(text, params)`, which takes
 * raw SQL and the same typed `sql.*` markers.
 *
 * ── THE SHAPE CONSTRAINT ──────────────────────────────────────────────────────────────
 * A snapshot is ONE bucket of ONE Pacific-local day: 1,994 stations at full resolution.
 * Handing that to a model raw would be ~1,994 rows × ~15 fields, and the model would
 * neither read it nor be able to cite it reliably. So every query below aggregates to
 * O(10) rows. Three round-trips (network / corridor / incident) rather than one wide
 * query, because they roll up along different axes and Databricks answers each in well
 * under a second — see server/advisor/context.ts for the measured cost.
 *
 * ── PACIFIC-TIME CORRECTNESS ──────────────────────────────────────────────────────────
 * Identical treatment to traffic_time_matrix.sql, and for the same reasons:
 *   - `reading_date` IS the Pacific local date (verified against all 5,742,720 rows), so
 *     filtering on it yields one clean local day AND keeps the predicate on a bare
 *     partition column so clustering still prunes.
 *   - `bucket_idx` is derived from `from_utc_timestamp(time_bucket,'America/Los_Angeles')`
 *     so bucket 68 means 17:00 PT, matching the animation clock exactly.
 * Getting either wrong would anchor the chat to a different traffic state than the map is
 * showing, which is the one failure this feature cannot tolerate.
 */

/** Number of corridor-directions handed to the model. See context.ts for the rationale. */
export const WORST_CORRIDOR_LIMIT = 8;

/** Maximum incident rows described individually before falling back to a count. */
export const INCIDENT_LIMIT = 12;

/**
 * Shared bucket derivation. Kept as one string so the three queries cannot drift apart —
 * a mismatch here would silently mix two different times of day into one context.
 */
const SNAPSHOT_CTE = `
WITH snap AS (
  SELECT
    *,
    (hour(from_utc_timestamp(time_bucket, 'America/Los_Angeles')) * 4)
      + (minute(from_utc_timestamp(time_bucket, 'America/Los_Angeles')) DIV 15) AS bucket_idx
  FROM lanl.caltrans_traffic.gold_map_frames
  WHERE reading_date = :day
    AND (:freeway = 'ALL' OR freeway = :freeway)
),
bucket AS (
  SELECT * FROM snap WHERE bucket_idx = :bucket
)`;

/**
 * Network-level rollup: one row.
 *
 * Both `avg_flow_vph` (served) and `avg_demanded_flow_vph` (latent demand) are returned.
 * That pair is what makes v/c interpretable: served flow saturates at capacity, so on an
 * oversaturated corridor served flow *understates* the problem. The model is told
 * explicitly in the system prompt that v/c is demand-based, and giving it both numbers
 * lets it see the gap rather than take it on faith.
 */
export const NETWORK_SQL = `${SNAPSHOT_CTE}
SELECT
  CAST(COUNT(*) AS INT)                                             AS station_count,
  ROUND(AVG(avg_speed_mph), 1)                                      AS mean_speed_mph,
  ROUND(MIN(min_speed_mph), 1)                                      AS min_speed_mph,
  ROUND(AVG(free_flow_speed_mph), 1)                                AS mean_free_flow_mph,
  ROUND(AVG(vc_ratio), 3)                                           AS mean_vc,
  ROUND(MAX(vc_ratio), 2)                                           AS max_vc,
  CAST(SUM(CASE WHEN vc_ratio > 1 THEN 1 ELSE 0 END) AS INT)        AS stations_over_capacity,
  CAST(SUM(CASE WHEN is_congested THEN 1 ELSE 0 END) AS INT)        AS stations_congested,
  CAST(SUM(CASE WHEN incident_active THEN 1 ELSE 0 END) AS INT)     AS stations_with_incident,
  CAST(SUM(avg_flow_vph) AS BIGINT)                                 AS total_served_flow_vph,
  CAST(SUM(avg_demanded_flow_vph) AS BIGINT)                        AS total_demanded_flow_vph,
  ROUND(AVG(delay_vs_freeflow_min_per_mi), 3)                       AS mean_delay_min_per_mi
FROM bucket`;

/**
 * Per-corridor-direction rollup, worst-first by delay.
 *
 * Ordered by `delay_vs_freeflow_min_per_mi` rather than raw speed because delay normalises
 * against each corridor's own free-flow speed — an urban corridor at 45 mph and a rural one
 * at 45 mph are not equally broken. `station_count` rides along so the model can tell a
 * 249-station corridor from a 37-station one and weight its advice accordingly.
 */
export const CORRIDOR_SQL = `${SNAPSHOT_CTE}
SELECT
  freeway,
  direction,
  CAST(COUNT(*) AS INT)                                       AS station_count,
  ROUND(AVG(avg_speed_mph), 1)                                AS mean_speed_mph,
  ROUND(AVG(free_flow_speed_mph), 1)                          AS free_flow_mph,
  ROUND(AVG(vc_ratio), 2)                                     AS mean_vc,
  ROUND(MAX(vc_ratio), 2)                                     AS max_vc,
  CAST(SUM(CASE WHEN vc_ratio > 1 THEN 1 ELSE 0 END) AS INT)  AS stations_over_capacity,
  ROUND(AVG(delay_vs_freeflow_min_per_mi), 3)                 AS mean_delay_min_per_mi,
  CAST(SUM(CASE WHEN incident_active THEN 1 ELSE 0 END) AS INT) AS incident_count,
  CAST(COALESCE(MAX(lanes_blocked), 0) AS INT)                AS max_lanes_blocked,
  CAST(SUM(avg_demanded_flow_vph) AS BIGINT)                  AS demanded_flow_vph,
  CAST(SUM(avg_flow_vph) AS BIGINT)                           AS served_flow_vph
FROM bucket
GROUP BY freeway, direction
ORDER BY mean_delay_min_per_mi DESC
LIMIT ${WORST_CORRIDOR_LIMIT}`;

/**
 * Level-of-service histogram. Six rows at most.
 *
 * `level_of_service` is read from the table rather than re-derived, so the model sees the
 * same LOS the pipeline assigned. (The client derives LOS itself from speed+vc to save
 * payload; that is a separate code path and not what is quoted to the model.)
 */
export const LOS_SQL = `${SNAPSHOT_CTE}
SELECT
  level_of_service        AS los,
  CAST(COUNT(*) AS INT)   AS station_count
FROM bucket
GROUP BY level_of_service
ORDER BY level_of_service`;

/**
 * Active incidents, worst-first.
 *
 * One row per affected station, capped at INCIDENT_LIMIT. `severity DESC, lanes_blocked
 * DESC` means the cap drops the *least* severe rows, and context.ts reports the true total
 * alongside so a truncated list is never mistaken for a complete one.
 */
export const INCIDENT_SQL = `${SNAPSHOT_CTE}
SELECT
  station_id,
  freeway,
  direction,
  county,
  city,
  ROUND(postmile, 1)                              AS postmile,
  CAST(COALESCE(max_incident_severity, 0) AS INT) AS severity,
  CAST(COALESCE(lanes_blocked, 0) AS INT)         AS lanes_blocked,
  CAST(num_lanes AS INT)                          AS num_lanes,
  ROUND(avg_speed_mph, 1)                         AS speed_mph,
  ROUND(vc_ratio, 2)                              AS vc_ratio
FROM bucket
WHERE incident_active
ORDER BY severity DESC, lanes_blocked DESC, vc_ratio DESC
LIMIT ${INCIDENT_LIMIT}`;
