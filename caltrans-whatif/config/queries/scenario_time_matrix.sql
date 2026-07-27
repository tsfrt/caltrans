-- ══════════════════════════════════════════════════════════════════════════════
--  M2 WHAT-IF ENGINE — SCENARIO TIME MATRIX (map payload)
--
--  GENERATED FILE. Edit tools/scenario_sql/engine.py and run
--      python -m tools.scenario_sql.render
--  `tests/test_scenario_sql.py` fails if this file drifts from the generator.
--
--  What this is: a BPR volume-delay model with damped incremental (MSA)
--  demand reassignment, executed ENTIRELY IN DBSQL. The app process binds
--  parameters and forwards rows; it does no traffic math.
--
--  ── The one idea that makes the no-op proof exact ──────────────────────────
--  This is an INCREMENTAL (pivot-point) model, not an absolute one. It never
--  predicts a speed; it predicts the *ratio* by which congestion changes and
--  multiplies the observed value by it:
--
--      tt_factor      = 1 + alpha*(v/c)^beta                    (BPR)
--      speed_after    = speed_observed * tt_factor(vc_before) / tt_factor(vc_after)
--      c_eff_baseline = demanded_flow_vph / vc_ratio            (from the data itself)
--
--  Two consequences, both deliberate:
--    * With no lever set, vc_after == vc_before EXACTLY, so every ratio is
--      exactly 1.0 and every output column reproduces the source table
--      bit-for-bit. The engine is a provable no-op. An absolute model could not
--      manage this: gold_map_frames carries 2.5% speed jitter on top of the BPR
--      curve, so re-deriving speed from BPR alone lands 0.75 mph off on average
--      (measured MAE over 191,424 rows) and the "baseline" would visibly differ
--      from the map the user was just looking at.
--    * The per-station calibration residual — jitter, detector health, whatever
--      else the observed value embeds — is preserved through the scenario
--      instead of being thrown away and replaced by a model mean.
--
--  Reading effective capacity out of the data as demand/vc rather than
--  reconstructing it from num_lanes x lane_capacity x station_type_scale is the
--  same trick applied to the denominator, and it matters: reconstruction is
--  exact only for incident-free rows (max abs error 9.2e-4) and drifts by up to
--  1.44 v/c units on rows where an incident covers only part of the 15-minute
--  bucket, because `incident_active`/`lanes_blocked` are bucket-MAX aggregates.
--
--  ── Honest scope of "reassignment" ────────────────────────────────────────
--  There is NO road-network graph in this data — 2,022 point detectors on 10
--  named corridors, with postmiles. There are no ramps-as-edges, no arterials,
--  no turn movements, no OD matrix. True equilibrium assignment (shortest paths
--  over a graph, Frank-Wolfe / Dial on an OD table) is therefore IMPOSSIBLE
--  here, and this query does not attempt it or claim it.
--
--  What it does instead: over-capacity demand at a station is split into
--    (a) a share diverted to *parallel-corridor* stations that are physically
--        near (ST_DistanceSphere on geom) and heading the same way (bearing
--        derived from postmile-ordered neighbours), weighted by spare capacity
--        and inverse distance;
--    (b) a share that leaves the modelled network entirely, standing in for the
--        local arterial network the data does not contain — tracked explicitly
--        as `demand_offnetwork_vph` so conservation stays auditable;
--    (c) the remainder, which stays put and queues.
--  Damping is textbook MSA: x_(k+1) = x_k + 1/(k+1) * (y_k - x_k), a convex
--  combination, which is why total demand is conserved to machine precision at
--  every iteration. Limitations are enumerated in docs/WHATIF_ENGINE.md §5.
--
--  ── Why the iterations are written out longhand ────────────────────────────
--  `WITH RECURSIVE` cannot reference itself inside an aggregate on this channel
--  (`INVALID_RECURSIVE_REFERENCE.PLACE`, SQLSTATE 42836) and each iteration is
--  a SUM/GROUP BY over diversion candidates. So 4 iterations are
--  rendered explicitly and `:msa_iterations` picks the iterate. Arms above the
--  requested count carry a literal-false predicate and are pruned by the
--  optimiser, so latency really does fall when you ask for fewer.
-- ══════════════════════════════════════════════════════════════════════════════
--
-- ── This file's job: the SCENARIO animation payload ─────────────────────────
-- Drop-in replacement for traffic_time_matrix.sql, and a SUPERSET of its client
-- contract: the four M1 columns (flow, speed_half, vc_pct, incident) carry the
-- SCENARIO values in exactly M1's layout and encoding, so lib/frames.ts decodes
-- this file unchanged. One column is added: `delay_c`, delay in centi-minutes
-- per mile, which M1 had no need for and the KPI panel does.
--
-- ⚠️ It deliberately does NOT return the "before" side. The client already holds
-- the baseline: it fetched traffic_time_matrix.sql for the same day and window
-- on load, and the engine's no-op proof is what guarantees those numbers ARE
-- this engine's "before". Shipping them again cost a MEASURED 770,276 extra
-- bytes per window and pushed the payload to 1,422,030 B (1.356 MiB) -- over
-- AppKit's 1 MiB single-event cap (appkit/dist/stream/defaults.js
-- `maxEventSize`), i.e. a runtime failure, not just waste. The before/after diff
-- is a client-side subtraction of two arrays already in memory.
--
-- Same encoding as M1: values scaled to integers because "48.4" costs more
-- characters than "97" (speed x2, v/c x100, delay x100), and level_of_service is
-- derived client-side rather than transmitted since it is a pure function of v/c.
--
-- Same windowing as M1 and for the same reason: a whole 96-bucket day of all
-- corridors is 2.47 MiB columnar, over the 1 MiB event cap, so the day is
-- fetched as four 24-bucket windows in parallel.
--
-- ⚠️ ARRAY_AGG / COLLECT_LIST DO NOT INHERIT A SUBQUERY'S ORDER BY on Spark.
-- An earlier M1 revision hit this: bucket 68 decoded to 64.80 mph when ground
-- truth was 48.44 mph -- the 17:00 rush hour silently vanished from the map
-- while every individual value still looked plausible. The fix, kept here, is to
-- collect (ord, value) structs and ARRAY_SORT with an explicit comparator.
--
-- The engine solves over ALL corridors; `:freeway` filters only this output.
-- The station index is therefore dense over the FILTERED set and, exactly as in
-- M1, is derived from the whole day rather than the window so indices are
-- stable across the four parallel window fetches. It must match
-- station_geometry.sql's `ORDER BY station_id` -- that shared ordering is the
-- entire client-side join.
WITH -- ── 1. Static network geometry ────────────────────────────────────────────────
-- Everything here is time-invariant, so it is computed once over all 2,022
-- stations rather than per bucket.
--
-- `seg_len_mi` is a postmile Voronoi: a station represents the half-distance to
-- its upstream neighbour plus the half-distance to its downstream neighbour.
-- That makes the per-station segment lengths of a corridor sum to the corridor
-- length without double counting, which is what VMT requires. The two endpoints
-- of a corridor have only one neighbour, so they take the FULL single-sided gap
-- (the COALESCE fallbacks), which keeps the ends from being silently half-length.
-- Clamped to [0.05, 12] mi so a duplicated postmile cannot produce a
-- zero-length (VMT-free) segment, and a rural detector gap cannot make one
-- station stand for 40 miles of road.
--
-- `bearing_deg` is the local heading, from the great-circle bearing between the
-- postmile-adjacent neighbours. It is what makes "parallel corridor" mean
-- something: I-405 N and US-101 N near Sherman Oaks head the same way and are a
-- plausible substitute for each other, whereas a crossing freeway 400 m away is
-- not an alternative route at all.
geo AS (
  SELECT
    s.station_id,
    s.freeway,
    s.direction,
    s.postmile,
    s.num_lanes,
    s.latitude,
    s.longitude,
    s.geom,
    -- NOTE the parentheses around every window call. `OVER w - LAG(...)` parses
    -- as the identifier `w-s` on this channel (INVALID_IDENTIFIER, 42602); a
    -- named window reference must be wrapped before it can be an operand.
    least(12.0, greatest(0.05,
      COALESCE(
        ((LEAD(s.postmile) OVER w) - (LAG(s.postmile) OVER w)) / 2.0,
        ((LEAD(s.postmile) OVER w) - s.postmile),
        (s.postmile - (LAG(s.postmile) OVER w)),
        0.5
      )
    )) AS seg_len_mi,
    pmod(degrees(atan2(
      radians(COALESCE((LEAD(s.longitude) OVER w), s.longitude)
              - COALESCE((LAG(s.longitude) OVER w), s.longitude)) * cos(radians(s.latitude)),
      radians(COALESCE((LEAD(s.latitude) OVER w), s.latitude)
              - COALESCE((LAG(s.latitude) OVER w), s.latitude))
    )), 360.0) AS bearing_deg
  FROM lanl.caltrans_traffic.silver_stations_geo s
  WINDOW w AS (PARTITION BY s.freeway, s.direction ORDER BY s.postmile)
),
-- ── 2. Observed baseline for one Pacific-local day, ALL corridors ────────────
-- `reading_date` IS the Pacific local date, so this predicate stays on a bare
-- clustering-adjacent column and still yields exactly 96 clean local buckets
-- with no UTC straddle. gold_map_frames is 5,742,720 rows; this touches 191,424.
--
-- The corridor filter is applied to the OUTPUT, never here: excluding US-101
-- from the solve would delete the very corridor I-405's traffic diverts onto,
-- and the scenario would silently under-report relief.
obs AS (
  SELECT
    f.station_id,
    CAST((hour(from_utc_timestamp(f.time_bucket, 'America/Los_Angeles')) * 4 + (minute(from_utc_timestamp(f.time_bucket, 'America/Los_Angeles')) DIV 15)) AS INT) AS bucket_idx,
    f.freeway,
    f.direction,
    f.postmile,
    f.num_lanes,
    f.free_flow_speed_mph                     AS ff_mph,
    CAST(f.avg_demanded_flow_vph AS DOUBLE)   AS demand_obs,
    CAST(f.avg_flow_vph AS DOUBLE)            AS served_obs,
    f.avg_speed_mph                           AS speed_obs,
    f.vc_ratio                                AS vc_obs,
    f.level_of_service                        AS los_obs,
    f.delay_vs_freeflow_min_per_mi            AS delay_obs,
    f.incident_active                         AS incident_obs,
    COALESCE(f.lanes_blocked, 0)              AS lanes_blocked_obs,
    -- Effective capacity, read back out of the data. Exact by construction:
    -- vc_ratio was defined as demanded_flow / effective_capacity upstream, so
    -- this inverts it rather than re-deriving it (see header). vc_ratio is
    -- never 0 or NULL in this table (verified over the full day), but the
    -- guard keeps a future data change from producing a division by zero.
    CAST(f.avg_demanded_flow_vph AS DOUBLE)
      / greatest(1e-9, f.vc_ratio)            AS cap_obs
  FROM lanl.caltrans_traffic.gold_map_frames f
  WHERE f.reading_date = :day
),
-- ── 3. Levers ────────────────────────────────────────────────────────────────
-- Every lever is OFF at its sentinel ('' freeway, 0 lanes, 0 percent, 1.0
-- scale, -1 absolute), and every lever contributes a MULTIPLIER on observed
-- effective capacity or observed demand. With all levers off every multiplier
-- is exactly 1.0, which is what makes the no-op exact.
--
-- Capacity levers compose in a fixed, documented order:
--     add_lanes  ->  closure  ->  incident  ->  scale  ->  absolute override
-- so a scenario that adds a lane and then closes two is unambiguous.
--
-- The incident lever uses the WORSE of the injected blockage and whatever the
-- data already had at that station-bucket, rather than compounding them: two
-- overlapping incidents do not halve capacity twice, the bigger blockage
-- governs. Note the baseline incident factor is reconstructed from bucket-MAX
-- `lanes_blocked`, so for a bucket where an incident was active for only part
-- of the 15 minutes it overstates the baseline blockage; that only ever damps
-- the injected effect, never inflates it, and it cannot disturb the no-op
-- because with the lever off the ratio is factor/factor.
lever AS (
  SELECT
    o.*,
    g.seg_len_mi,
    -- capacity multiplier -----------------------------------------------------
    (
      CASE
        WHEN :capacity_freeway <> '' AND o.freeway = :capacity_freeway
             AND (:capacity_direction = '' OR o.direction = :capacity_direction)
             AND o.postmile BETWEEN :capacity_pm_from AND :capacity_pm_to
             AND :capacity_add_lanes <> 0
        THEN greatest(0.05,
               (CAST(o.num_lanes AS DOUBLE) + :capacity_add_lanes)
               / greatest(1.0, CAST(o.num_lanes AS DOUBLE)))
        ELSE 1.0
      END
      *
      CASE
        WHEN :close_freeway <> '' AND o.freeway = :close_freeway
             AND (:close_direction = '' OR o.direction = :close_direction)
             AND o.postmile BETWEEN :close_pm_from AND :close_pm_to
             AND :close_lanes > 0
        THEN greatest(0.05, greatest(0.0, CAST(o.num_lanes AS DOUBLE) - CAST(:close_lanes AS DOUBLE)) / greatest(1.0, CAST(o.num_lanes AS DOUBLE)))
        ELSE 1.0
      END
      *
      CASE
        WHEN :incident_freeway <> '' AND o.freeway = :incident_freeway
             AND (:incident_direction = '' OR o.direction = :incident_direction)
             AND o.postmile BETWEEN :incident_pm_from AND :incident_pm_to
             AND o.bucket_idx BETWEEN :incident_from_bucket AND :incident_to_bucket
             AND :incident_lanes_blocked > 0
        THEN least(1.0,
               greatest(0.05, (greatest(0.0, CAST(o.num_lanes AS DOUBLE) - CAST(:incident_lanes_blocked AS DOUBLE)) / greatest(1.0, CAST(o.num_lanes AS DOUBLE))) * (1.0 - 0.12))
               / CASE WHEN o.incident_obs
                      THEN greatest(0.05, (greatest(0.0, CAST(o.num_lanes AS DOUBLE) - CAST(o.lanes_blocked_obs AS DOUBLE)) / greatest(1.0, CAST(o.num_lanes AS DOUBLE))) * (1.0 - 0.12))
                      ELSE 1.0 END)
        ELSE 1.0
      END
      *
      CASE
        WHEN :capacity_freeway <> '' AND o.freeway = :capacity_freeway
             AND (:capacity_direction = '' OR o.direction = :capacity_direction)
             AND o.postmile BETWEEN :capacity_pm_from AND :capacity_pm_to
        THEN greatest(0.05, :capacity_scale)
        ELSE 1.0
      END
    ) AS cap_mult,
    -- demand multiplier -------------------------------------------------------
    CASE
      WHEN :demand_freeway <> '' AND :demand_pct <> 0
           AND (:demand_freeway = 'ALL' OR o.freeway = :demand_freeway)
           AND (:demand_direction = '' OR o.direction = :demand_direction)
      THEN greatest(0.0, 1.0 + :demand_pct / 100.0)
      ELSE 1.0
    END AS dem_mult
  FROM obs o
  JOIN geo g ON g.station_id = o.station_id
),
scen AS (
  SELECT
    l.*,
    l.demand_obs * l.dem_mult AS d_lever,
    -- The absolute override lands last and replaces the composed value outright.
    CASE
      WHEN :capacity_freeway <> '' AND l.freeway = :capacity_freeway
           AND (:capacity_direction = '' OR l.direction = :capacity_direction)
           AND l.postmile BETWEEN :capacity_pm_from AND :capacity_pm_to
           AND :capacity_abs_vph > 0
      THEN :capacity_abs_vph
      ELSE greatest(1.0, l.cap_obs * l.cap_mult)
    END AS cap_scen
  FROM lever l
),
-- ── 4. Diversion candidates (the closest thing to a network in this data) ────
-- A pair (src -> dst) means "demand facing over-capacity conditions at src could
-- plausibly end up at dst instead". There are TWO kinds, and both are needed.
--
-- (a) PARALLEL-CORRIDOR — a genuinely different route. Three conditions:
--       * different freeway         — a same-corridor station is the same traffic
--                                     stream, not an alternative route
--       * ST_DistanceSphere <= lim  — ST_Distance returns planar DEGREES on this
--                                     channel and is unusable for metres
--       * bearing within limit      — a CROSSING freeway is close but is not a
--                                     substitute. This filter earns its keep: for
--                                     the I-405 S pm 45-52 segment the only
--                                     freeway within 12 km is I-10, at a measured
--                                     111-114 deg heading difference. I-10 East is
--                                     not an alternative to I-405 South, and the
--                                     filter correctly rejects it.
--     The lat/lon prefilter is a cheap bounding box (0.09 deg lat ~ 10 km, 0.11 deg
--     lon ~ 9 km at CA latitudes) so this is not a 2,022 x 2,022 cross join before
--     the spatial predicate runs. It is deliberately wider than any sane
--     `:parallel_max_dist_m`, so it cannot clip a real candidate.
--
--     COVERAGE, measured: at 8,000 m / 45 deg only 551 of 2,022 stations have ANY
--     parallel candidate (416 at 5,000 m). Rural I-5 and the Mojave stretch of
--     I-15 have none because in reality they have none.
--
-- (b) SAME-CORRIDOR, ADJACENT POSTMILE — the queue spreading, not a route choice.
--     Without this, the most important scenario in the app produces NO network
--     diversion at all: measured, 0 of the 9 stations in the I-405 S pm 45-52
--     closure window have a parallel candidate, so 100% of diverted demand went
--     to the off-network sink and no neighbouring segment showed any effect. That
--     is not what happens on a real freeway, where blocking lanes backs traffic
--     up into the segments behind it.
--
--     Interpretation matters here and is easy to overclaim: this is NOT route
--     choice and NOT a shockwave model. It is a crude spatial spreading of
--     unserved demand into the adjacent segments of the same carriageway, which
--     is where a queue physically goes. It has no direction of propagation (a
--     real queue grows UPSTREAM only) and no travel time, because the data has no
--     signed direction-of-travel along postmiles -- postmile increases with route
--     mileage, not with the direction traffic flows. Documented in
--     docs/WHATIF_ENGINE.md §5 as one of the model's two biggest weaknesses.
cand AS (
  SELECT src, dst, w_dist FROM (
    -- (a) parallel corridors
    SELECT
      a.station_id AS src,
      b.station_id AS dst,
      1.0 / (1.0 + ST_DistanceSphere(a.geom, b.geom) / 1000.0) AS w_dist
    FROM geo a
    JOIN geo b
      ON b.freeway <> a.freeway
     AND abs(b.latitude  - a.latitude)  < 0.09
     AND abs(b.longitude - a.longitude) < 0.11
    WHERE ST_DistanceSphere(a.geom, b.geom) <= :parallel_max_dist_m
      AND abs(pmod(a.bearing_deg - b.bearing_deg + 180.0, 360.0) - 180.0)
          <= :parallel_max_bearing_deg

    UNION ALL

    -- (b) same corridor + same direction, within 2 postmile steps either way.
    -- Weighted at half a parallel candidate of the same distance, because
    -- spilling into the neighbouring segment relieves the detector but not the
    -- corridor -- the vehicles are still in the same jam.
    SELECT
      a.station_id AS src,
      b.station_id AS dst,
      0.5 / (1.0 + abs(b.postmile - a.postmile)) AS w_dist
    FROM geo a
    JOIN geo b
      ON b.freeway   = a.freeway
     AND b.direction = a.direction
     AND b.station_id <> a.station_id
     AND abs(b.postmile - a.postmile) <= 2.0
  )
),
-- Each candidate pair, duplicated under both of its endpoint keys. This exists
-- purely so one iteration can read the previous iterate ONCE, via a single
-- equi-join, and still recover BOTH the source's excess and the destination's
-- spare capacity (see the fan-out note in the iteration comment).
cand_role AS (
  SELECT src, dst, w_dist, 0 AS role, src AS join_key FROM cand
  UNION ALL
  SELECT src, dst, w_dist, 1 AS role, dst AS join_key FROM cand
),
-- ── 5. MSA seed: lever-adjusted demand, no reassignment yet ─────────────────
st0 AS (
  SELECT
    station_id, bucket_idx, freeway, direction, postmile, num_lanes,
    seg_len_mi, ff_mph, demand_obs, served_obs, speed_obs, vc_obs,
    los_obs, delay_obs, cap_obs, cap_scen, d_lever,
    d_lever  AS x,
    0.0      AS leak,
    -- Excess demand that was ALREADY over capacity in the observed data. Carried
    -- unchanged through every iteration, because reassignment must only move the
    -- demand the SCENARIO pushed over capacity -- see the `divertible` note in
    -- the iteration block. This is the difference between an *incremental*
    -- assignment model and one that quietly relitigates the baseline.
    greatest(0.0, demand_obs - cap_obs) AS base_excess,
    0        AS iter
  FROM scen
),
-- ── MSA iteration 1 of 4 (damping step 1/2) ─────────────────────────────────
-- ⚠️ PERFORMANCE — READ THIS BEFORE EDITING. This block references the previous
-- iterate `st0` EXACTLY ONCE, and `st1` references `x1_move` exactly once.
-- That is a hard constraint, not a style preference.
--
-- DBSQL inlines CTEs: every *textual* reference to a CTE re-expands its entire
-- upstream chain, including the 191,424-row scan of gold_map_frames and the
-- spatial candidate join. Reference count therefore compounds as
-- refs^iterations. MEASURED on warehouse 688f49c732cf9083, 4 iterations,
-- reassign_share 0.3:
--     4 refs/iteration (separate pressure/pull/send/recv CTEs)   434 s
--     2 refs/iteration (folded send into the state CTE)          235 s
--     1 ref/iteration  (this structure)                          see docs
-- Zero-iteration baseline is 1.6 s, so only the single-reference form is
-- interactive. If you add a reference here, re-measure before committing.
--
-- Getting to one reference needs two tricks:
--
--  (a) `cand_role` carries each candidate pair TWICE, keyed once by src and once
--      by dst. One equi-join to the previous iterate therefore lands the
--      source's excess (role 0) and the destination's spare capacity (role 1) on
--      the two rows of the same pair, and a window over (src, dst, bucket)
--      copies each across to the other. No self-join, no second reference.
--
--  (b) The normalisation total (`pull`) is computed with a WINDOW function in a
--      nested subquery rather than a separate GROUP BY CTE. Nested subqueries
--      inside one CTE do not multiply references; a second CTE would.
--
-- Both `sent` and `received` then fall out of a SINGLE grouping pass, because
-- role 0 rows are keyed to the sender and role 1 rows to the receiver.
x1_flux AS (
  SELECT
    f.*,
    -- Total attractiveness visible to this source in this bucket: destination
    -- spare capacity discounted by distance. Recomputed every iteration because
    -- spare capacity is exactly what the previous iteration changed.
    -- Only role-0 rows contribute, or every pair would be counted twice.
    SUM(CASE WHEN f.role = 0 THEN f.w_dist * f.pair_dst_spare ELSE 0.0 END)
      OVER (PARTITION BY f.src, f.bucket_idx) AS pull
  FROM (
    SELECT
      p.*,
      c.role, c.src, c.dst, c.w_dist,
      -- DIVERTIBLE excess: over-capacity demand MINUS whatever was already over
      -- capacity in the observed baseline. Without the `- base_excess` term the
      -- engine would re-route the data's own pre-existing congestion, so a
      -- lever-free scenario with reassignment enabled came out 49 mph faster in
      -- places and moved 678,535 vehicle-equivalents off-network -- i.e. it
      -- "fixed" the baseline and the no-op proof failed. Measured, then fixed.
      greatest(0.0, greatest(0.0, p.x - p.cap_scen) - p.base_excess) AS my_excess,
      greatest(0.0, p.cap_scen - p.x) AS my_spare,
      -- The partner's state, copied across the two rows of this pair.
      MAX(CASE WHEN c.role = 1 THEN greatest(0.0, p.cap_scen - p.x) END)
        OVER (PARTITION BY c.src, c.dst, p.bucket_idx) AS pair_dst_spare,
      MAX(CASE WHEN c.role = 0
               THEN greatest(0.0, greatest(0.0, p.x - p.cap_scen) - p.base_excess) END)
        OVER (PARTITION BY c.src, c.dst, p.bucket_idx) AS pair_src_excess
    -- LEFT JOIN, not JOIN: a station with no parallel alternative (measured:
    -- 1,471 of 2,022 at 8 km / 45 deg) must survive the iteration unchanged
    -- rather than dropping out of the network.
    FROM st0 p
    LEFT JOIN cand_role c ON c.join_key = p.station_id
  ) f
),
x1_move AS (
  -- One grouping pass yields BOTH directions of flow for every station-bucket,
  -- plus the carried state, so `st1` needs no second look at `st0`.
  SELECT
    station_id,
    bucket_idx,
    MAX(freeway) AS freeway, MAX(direction) AS direction, MAX(postmile) AS postmile,
    MAX(num_lanes) AS num_lanes, MAX(seg_len_mi) AS seg_len_mi, MAX(ff_mph) AS ff_mph,
    MAX(demand_obs) AS demand_obs, MAX(served_obs) AS served_obs,
    MAX(speed_obs) AS speed_obs, MAX(vc_obs) AS vc_obs, MAX(los_obs) AS los_obs,
    MAX(delay_obs) AS delay_obs, MAX(cap_obs) AS cap_obs, MAX(cap_scen) AS cap_scen,
    MAX(d_lever) AS d_lever, MAX(x) AS x, MAX(leak) AS leak,
    MAX(base_excess) AS base_excess, MAX(my_excess) AS my_excess,
    -- Is there anywhere with room to send to? NULL when this station is nobody's
    -- source, which is also the "no alternative" case.
    MAX(CASE WHEN role = 0 THEN pull END) AS pull,
    -- Demand arriving here, split across the candidates that can take it in
    -- proportion to (distance weight x spare capacity). The denominator is the
    -- same sum the numerators are drawn from, which is what makes total sent
    -- equal total received exactly rather than approximately.
    SUM(CASE WHEN role = 1 AND pull > 0.0
             THEN pair_src_excess * :reassign_share
                  * (1.0 - :reassign_offnetwork_share)
                  * w_dist * my_spare / pull
             ELSE 0.0 END) AS received
  FROM x1_flux
  GROUP BY station_id, bucket_idx
),
st1 AS (
  SELECT
    m.station_id, m.bucket_idx, m.freeway, m.direction, m.postmile, m.num_lanes,
    m.seg_len_mi, m.ff_mph, m.demand_obs, m.served_obs, m.speed_obs, m.vc_obs,
    m.los_obs, m.delay_obs, m.cap_obs, m.cap_scen, m.d_lever,
    -- MSA damping: x' = x + 1/(k+1) * (y - x), where y is the all-or-nothing
    -- loading. A convex combination of two demand vectors that each conserve
    -- total demand, which is why conservation holds to machine precision.
    --
    -- Traffic is sent to the network only if somewhere reachable actually has
    -- room. The off-network share leaves regardless: it stands in for the local
    -- arterial network, which is not in this data and so is never "full" here.
    greatest(0.0, m.x + (1.0 / 2.0) * (
        (m.x
         - CASE WHEN COALESCE(m.pull, 0.0) > 0.0
                THEN m.my_excess * :reassign_share
                     * (1.0 - :reassign_offnetwork_share)
                ELSE 0.0 END
         - m.my_excess * :reassign_share * :reassign_offnetwork_share
         + m.received)
        - m.x)) AS x,
    m.leak + (1.0 / 2.0) * (
      (m.leak + m.my_excess * :reassign_share * :reassign_offnetwork_share) - m.leak
    ) AS leak,
    m.base_excess,
    1 AS iter
  FROM x1_move m
),
-- ── MSA iteration 2 of 4 (damping step 1/3) ─────────────────────────────────
-- ⚠️ PERFORMANCE — READ THIS BEFORE EDITING. This block references the previous
-- iterate `st1` EXACTLY ONCE, and `st2` references `x2_move` exactly once.
-- That is a hard constraint, not a style preference.
--
-- DBSQL inlines CTEs: every *textual* reference to a CTE re-expands its entire
-- upstream chain, including the 191,424-row scan of gold_map_frames and the
-- spatial candidate join. Reference count therefore compounds as
-- refs^iterations. MEASURED on warehouse 688f49c732cf9083, 4 iterations,
-- reassign_share 0.3:
--     4 refs/iteration (separate pressure/pull/send/recv CTEs)   434 s
--     2 refs/iteration (folded send into the state CTE)          235 s
--     1 ref/iteration  (this structure)                          see docs
-- Zero-iteration baseline is 1.6 s, so only the single-reference form is
-- interactive. If you add a reference here, re-measure before committing.
--
-- Getting to one reference needs two tricks:
--
--  (a) `cand_role` carries each candidate pair TWICE, keyed once by src and once
--      by dst. One equi-join to the previous iterate therefore lands the
--      source's excess (role 0) and the destination's spare capacity (role 1) on
--      the two rows of the same pair, and a window over (src, dst, bucket)
--      copies each across to the other. No self-join, no second reference.
--
--  (b) The normalisation total (`pull`) is computed with a WINDOW function in a
--      nested subquery rather than a separate GROUP BY CTE. Nested subqueries
--      inside one CTE do not multiply references; a second CTE would.
--
-- Both `sent` and `received` then fall out of a SINGLE grouping pass, because
-- role 0 rows are keyed to the sender and role 1 rows to the receiver.
x2_flux AS (
  SELECT
    f.*,
    -- Total attractiveness visible to this source in this bucket: destination
    -- spare capacity discounted by distance. Recomputed every iteration because
    -- spare capacity is exactly what the previous iteration changed.
    -- Only role-0 rows contribute, or every pair would be counted twice.
    SUM(CASE WHEN f.role = 0 THEN f.w_dist * f.pair_dst_spare ELSE 0.0 END)
      OVER (PARTITION BY f.src, f.bucket_idx) AS pull
  FROM (
    SELECT
      p.*,
      c.role, c.src, c.dst, c.w_dist,
      -- DIVERTIBLE excess: over-capacity demand MINUS whatever was already over
      -- capacity in the observed baseline. Without the `- base_excess` term the
      -- engine would re-route the data's own pre-existing congestion, so a
      -- lever-free scenario with reassignment enabled came out 49 mph faster in
      -- places and moved 678,535 vehicle-equivalents off-network -- i.e. it
      -- "fixed" the baseline and the no-op proof failed. Measured, then fixed.
      greatest(0.0, greatest(0.0, p.x - p.cap_scen) - p.base_excess) AS my_excess,
      greatest(0.0, p.cap_scen - p.x) AS my_spare,
      -- The partner's state, copied across the two rows of this pair.
      MAX(CASE WHEN c.role = 1 THEN greatest(0.0, p.cap_scen - p.x) END)
        OVER (PARTITION BY c.src, c.dst, p.bucket_idx) AS pair_dst_spare,
      MAX(CASE WHEN c.role = 0
               THEN greatest(0.0, greatest(0.0, p.x - p.cap_scen) - p.base_excess) END)
        OVER (PARTITION BY c.src, c.dst, p.bucket_idx) AS pair_src_excess
    -- LEFT JOIN, not JOIN: a station with no parallel alternative (measured:
    -- 1,471 of 2,022 at 8 km / 45 deg) must survive the iteration unchanged
    -- rather than dropping out of the network.
    FROM st1 p
    LEFT JOIN cand_role c ON c.join_key = p.station_id
  ) f
),
x2_move AS (
  -- One grouping pass yields BOTH directions of flow for every station-bucket,
  -- plus the carried state, so `st2` needs no second look at `st1`.
  SELECT
    station_id,
    bucket_idx,
    MAX(freeway) AS freeway, MAX(direction) AS direction, MAX(postmile) AS postmile,
    MAX(num_lanes) AS num_lanes, MAX(seg_len_mi) AS seg_len_mi, MAX(ff_mph) AS ff_mph,
    MAX(demand_obs) AS demand_obs, MAX(served_obs) AS served_obs,
    MAX(speed_obs) AS speed_obs, MAX(vc_obs) AS vc_obs, MAX(los_obs) AS los_obs,
    MAX(delay_obs) AS delay_obs, MAX(cap_obs) AS cap_obs, MAX(cap_scen) AS cap_scen,
    MAX(d_lever) AS d_lever, MAX(x) AS x, MAX(leak) AS leak,
    MAX(base_excess) AS base_excess, MAX(my_excess) AS my_excess,
    -- Is there anywhere with room to send to? NULL when this station is nobody's
    -- source, which is also the "no alternative" case.
    MAX(CASE WHEN role = 0 THEN pull END) AS pull,
    -- Demand arriving here, split across the candidates that can take it in
    -- proportion to (distance weight x spare capacity). The denominator is the
    -- same sum the numerators are drawn from, which is what makes total sent
    -- equal total received exactly rather than approximately.
    SUM(CASE WHEN role = 1 AND pull > 0.0
             THEN pair_src_excess * :reassign_share
                  * (1.0 - :reassign_offnetwork_share)
                  * w_dist * my_spare / pull
             ELSE 0.0 END) AS received
  FROM x2_flux
  GROUP BY station_id, bucket_idx
),
st2 AS (
  SELECT
    m.station_id, m.bucket_idx, m.freeway, m.direction, m.postmile, m.num_lanes,
    m.seg_len_mi, m.ff_mph, m.demand_obs, m.served_obs, m.speed_obs, m.vc_obs,
    m.los_obs, m.delay_obs, m.cap_obs, m.cap_scen, m.d_lever,
    -- MSA damping: x' = x + 1/(k+1) * (y - x), where y is the all-or-nothing
    -- loading. A convex combination of two demand vectors that each conserve
    -- total demand, which is why conservation holds to machine precision.
    --
    -- Traffic is sent to the network only if somewhere reachable actually has
    -- room. The off-network share leaves regardless: it stands in for the local
    -- arterial network, which is not in this data and so is never "full" here.
    greatest(0.0, m.x + (1.0 / 3.0) * (
        (m.x
         - CASE WHEN COALESCE(m.pull, 0.0) > 0.0
                THEN m.my_excess * :reassign_share
                     * (1.0 - :reassign_offnetwork_share)
                ELSE 0.0 END
         - m.my_excess * :reassign_share * :reassign_offnetwork_share
         + m.received)
        - m.x)) AS x,
    m.leak + (1.0 / 3.0) * (
      (m.leak + m.my_excess * :reassign_share * :reassign_offnetwork_share) - m.leak
    ) AS leak,
    m.base_excess,
    2 AS iter
  FROM x2_move m
),
-- ── MSA iteration 3 of 4 (damping step 1/4) ─────────────────────────────────
-- ⚠️ PERFORMANCE — READ THIS BEFORE EDITING. This block references the previous
-- iterate `st2` EXACTLY ONCE, and `st3` references `x3_move` exactly once.
-- That is a hard constraint, not a style preference.
--
-- DBSQL inlines CTEs: every *textual* reference to a CTE re-expands its entire
-- upstream chain, including the 191,424-row scan of gold_map_frames and the
-- spatial candidate join. Reference count therefore compounds as
-- refs^iterations. MEASURED on warehouse 688f49c732cf9083, 4 iterations,
-- reassign_share 0.3:
--     4 refs/iteration (separate pressure/pull/send/recv CTEs)   434 s
--     2 refs/iteration (folded send into the state CTE)          235 s
--     1 ref/iteration  (this structure)                          see docs
-- Zero-iteration baseline is 1.6 s, so only the single-reference form is
-- interactive. If you add a reference here, re-measure before committing.
--
-- Getting to one reference needs two tricks:
--
--  (a) `cand_role` carries each candidate pair TWICE, keyed once by src and once
--      by dst. One equi-join to the previous iterate therefore lands the
--      source's excess (role 0) and the destination's spare capacity (role 1) on
--      the two rows of the same pair, and a window over (src, dst, bucket)
--      copies each across to the other. No self-join, no second reference.
--
--  (b) The normalisation total (`pull`) is computed with a WINDOW function in a
--      nested subquery rather than a separate GROUP BY CTE. Nested subqueries
--      inside one CTE do not multiply references; a second CTE would.
--
-- Both `sent` and `received` then fall out of a SINGLE grouping pass, because
-- role 0 rows are keyed to the sender and role 1 rows to the receiver.
x3_flux AS (
  SELECT
    f.*,
    -- Total attractiveness visible to this source in this bucket: destination
    -- spare capacity discounted by distance. Recomputed every iteration because
    -- spare capacity is exactly what the previous iteration changed.
    -- Only role-0 rows contribute, or every pair would be counted twice.
    SUM(CASE WHEN f.role = 0 THEN f.w_dist * f.pair_dst_spare ELSE 0.0 END)
      OVER (PARTITION BY f.src, f.bucket_idx) AS pull
  FROM (
    SELECT
      p.*,
      c.role, c.src, c.dst, c.w_dist,
      -- DIVERTIBLE excess: over-capacity demand MINUS whatever was already over
      -- capacity in the observed baseline. Without the `- base_excess` term the
      -- engine would re-route the data's own pre-existing congestion, so a
      -- lever-free scenario with reassignment enabled came out 49 mph faster in
      -- places and moved 678,535 vehicle-equivalents off-network -- i.e. it
      -- "fixed" the baseline and the no-op proof failed. Measured, then fixed.
      greatest(0.0, greatest(0.0, p.x - p.cap_scen) - p.base_excess) AS my_excess,
      greatest(0.0, p.cap_scen - p.x) AS my_spare,
      -- The partner's state, copied across the two rows of this pair.
      MAX(CASE WHEN c.role = 1 THEN greatest(0.0, p.cap_scen - p.x) END)
        OVER (PARTITION BY c.src, c.dst, p.bucket_idx) AS pair_dst_spare,
      MAX(CASE WHEN c.role = 0
               THEN greatest(0.0, greatest(0.0, p.x - p.cap_scen) - p.base_excess) END)
        OVER (PARTITION BY c.src, c.dst, p.bucket_idx) AS pair_src_excess
    -- LEFT JOIN, not JOIN: a station with no parallel alternative (measured:
    -- 1,471 of 2,022 at 8 km / 45 deg) must survive the iteration unchanged
    -- rather than dropping out of the network.
    FROM st2 p
    LEFT JOIN cand_role c ON c.join_key = p.station_id
  ) f
),
x3_move AS (
  -- One grouping pass yields BOTH directions of flow for every station-bucket,
  -- plus the carried state, so `st3` needs no second look at `st2`.
  SELECT
    station_id,
    bucket_idx,
    MAX(freeway) AS freeway, MAX(direction) AS direction, MAX(postmile) AS postmile,
    MAX(num_lanes) AS num_lanes, MAX(seg_len_mi) AS seg_len_mi, MAX(ff_mph) AS ff_mph,
    MAX(demand_obs) AS demand_obs, MAX(served_obs) AS served_obs,
    MAX(speed_obs) AS speed_obs, MAX(vc_obs) AS vc_obs, MAX(los_obs) AS los_obs,
    MAX(delay_obs) AS delay_obs, MAX(cap_obs) AS cap_obs, MAX(cap_scen) AS cap_scen,
    MAX(d_lever) AS d_lever, MAX(x) AS x, MAX(leak) AS leak,
    MAX(base_excess) AS base_excess, MAX(my_excess) AS my_excess,
    -- Is there anywhere with room to send to? NULL when this station is nobody's
    -- source, which is also the "no alternative" case.
    MAX(CASE WHEN role = 0 THEN pull END) AS pull,
    -- Demand arriving here, split across the candidates that can take it in
    -- proportion to (distance weight x spare capacity). The denominator is the
    -- same sum the numerators are drawn from, which is what makes total sent
    -- equal total received exactly rather than approximately.
    SUM(CASE WHEN role = 1 AND pull > 0.0
             THEN pair_src_excess * :reassign_share
                  * (1.0 - :reassign_offnetwork_share)
                  * w_dist * my_spare / pull
             ELSE 0.0 END) AS received
  FROM x3_flux
  GROUP BY station_id, bucket_idx
),
st3 AS (
  SELECT
    m.station_id, m.bucket_idx, m.freeway, m.direction, m.postmile, m.num_lanes,
    m.seg_len_mi, m.ff_mph, m.demand_obs, m.served_obs, m.speed_obs, m.vc_obs,
    m.los_obs, m.delay_obs, m.cap_obs, m.cap_scen, m.d_lever,
    -- MSA damping: x' = x + 1/(k+1) * (y - x), where y is the all-or-nothing
    -- loading. A convex combination of two demand vectors that each conserve
    -- total demand, which is why conservation holds to machine precision.
    --
    -- Traffic is sent to the network only if somewhere reachable actually has
    -- room. The off-network share leaves regardless: it stands in for the local
    -- arterial network, which is not in this data and so is never "full" here.
    greatest(0.0, m.x + (1.0 / 4.0) * (
        (m.x
         - CASE WHEN COALESCE(m.pull, 0.0) > 0.0
                THEN m.my_excess * :reassign_share
                     * (1.0 - :reassign_offnetwork_share)
                ELSE 0.0 END
         - m.my_excess * :reassign_share * :reassign_offnetwork_share
         + m.received)
        - m.x)) AS x,
    m.leak + (1.0 / 4.0) * (
      (m.leak + m.my_excess * :reassign_share * :reassign_offnetwork_share) - m.leak
    ) AS leak,
    m.base_excess,
    3 AS iter
  FROM x3_move m
),
-- ── MSA iteration 4 of 4 (damping step 1/5) ─────────────────────────────────
-- ⚠️ PERFORMANCE — READ THIS BEFORE EDITING. This block references the previous
-- iterate `st3` EXACTLY ONCE, and `st4` references `x4_move` exactly once.
-- That is a hard constraint, not a style preference.
--
-- DBSQL inlines CTEs: every *textual* reference to a CTE re-expands its entire
-- upstream chain, including the 191,424-row scan of gold_map_frames and the
-- spatial candidate join. Reference count therefore compounds as
-- refs^iterations. MEASURED on warehouse 688f49c732cf9083, 4 iterations,
-- reassign_share 0.3:
--     4 refs/iteration (separate pressure/pull/send/recv CTEs)   434 s
--     2 refs/iteration (folded send into the state CTE)          235 s
--     1 ref/iteration  (this structure)                          see docs
-- Zero-iteration baseline is 1.6 s, so only the single-reference form is
-- interactive. If you add a reference here, re-measure before committing.
--
-- Getting to one reference needs two tricks:
--
--  (a) `cand_role` carries each candidate pair TWICE, keyed once by src and once
--      by dst. One equi-join to the previous iterate therefore lands the
--      source's excess (role 0) and the destination's spare capacity (role 1) on
--      the two rows of the same pair, and a window over (src, dst, bucket)
--      copies each across to the other. No self-join, no second reference.
--
--  (b) The normalisation total (`pull`) is computed with a WINDOW function in a
--      nested subquery rather than a separate GROUP BY CTE. Nested subqueries
--      inside one CTE do not multiply references; a second CTE would.
--
-- Both `sent` and `received` then fall out of a SINGLE grouping pass, because
-- role 0 rows are keyed to the sender and role 1 rows to the receiver.
x4_flux AS (
  SELECT
    f.*,
    -- Total attractiveness visible to this source in this bucket: destination
    -- spare capacity discounted by distance. Recomputed every iteration because
    -- spare capacity is exactly what the previous iteration changed.
    -- Only role-0 rows contribute, or every pair would be counted twice.
    SUM(CASE WHEN f.role = 0 THEN f.w_dist * f.pair_dst_spare ELSE 0.0 END)
      OVER (PARTITION BY f.src, f.bucket_idx) AS pull
  FROM (
    SELECT
      p.*,
      c.role, c.src, c.dst, c.w_dist,
      -- DIVERTIBLE excess: over-capacity demand MINUS whatever was already over
      -- capacity in the observed baseline. Without the `- base_excess` term the
      -- engine would re-route the data's own pre-existing congestion, so a
      -- lever-free scenario with reassignment enabled came out 49 mph faster in
      -- places and moved 678,535 vehicle-equivalents off-network -- i.e. it
      -- "fixed" the baseline and the no-op proof failed. Measured, then fixed.
      greatest(0.0, greatest(0.0, p.x - p.cap_scen) - p.base_excess) AS my_excess,
      greatest(0.0, p.cap_scen - p.x) AS my_spare,
      -- The partner's state, copied across the two rows of this pair.
      MAX(CASE WHEN c.role = 1 THEN greatest(0.0, p.cap_scen - p.x) END)
        OVER (PARTITION BY c.src, c.dst, p.bucket_idx) AS pair_dst_spare,
      MAX(CASE WHEN c.role = 0
               THEN greatest(0.0, greatest(0.0, p.x - p.cap_scen) - p.base_excess) END)
        OVER (PARTITION BY c.src, c.dst, p.bucket_idx) AS pair_src_excess
    -- LEFT JOIN, not JOIN: a station with no parallel alternative (measured:
    -- 1,471 of 2,022 at 8 km / 45 deg) must survive the iteration unchanged
    -- rather than dropping out of the network.
    FROM st3 p
    LEFT JOIN cand_role c ON c.join_key = p.station_id
  ) f
),
x4_move AS (
  -- One grouping pass yields BOTH directions of flow for every station-bucket,
  -- plus the carried state, so `st4` needs no second look at `st3`.
  SELECT
    station_id,
    bucket_idx,
    MAX(freeway) AS freeway, MAX(direction) AS direction, MAX(postmile) AS postmile,
    MAX(num_lanes) AS num_lanes, MAX(seg_len_mi) AS seg_len_mi, MAX(ff_mph) AS ff_mph,
    MAX(demand_obs) AS demand_obs, MAX(served_obs) AS served_obs,
    MAX(speed_obs) AS speed_obs, MAX(vc_obs) AS vc_obs, MAX(los_obs) AS los_obs,
    MAX(delay_obs) AS delay_obs, MAX(cap_obs) AS cap_obs, MAX(cap_scen) AS cap_scen,
    MAX(d_lever) AS d_lever, MAX(x) AS x, MAX(leak) AS leak,
    MAX(base_excess) AS base_excess, MAX(my_excess) AS my_excess,
    -- Is there anywhere with room to send to? NULL when this station is nobody's
    -- source, which is also the "no alternative" case.
    MAX(CASE WHEN role = 0 THEN pull END) AS pull,
    -- Demand arriving here, split across the candidates that can take it in
    -- proportion to (distance weight x spare capacity). The denominator is the
    -- same sum the numerators are drawn from, which is what makes total sent
    -- equal total received exactly rather than approximately.
    SUM(CASE WHEN role = 1 AND pull > 0.0
             THEN pair_src_excess * :reassign_share
                  * (1.0 - :reassign_offnetwork_share)
                  * w_dist * my_spare / pull
             ELSE 0.0 END) AS received
  FROM x4_flux
  GROUP BY station_id, bucket_idx
),
st4 AS (
  SELECT
    m.station_id, m.bucket_idx, m.freeway, m.direction, m.postmile, m.num_lanes,
    m.seg_len_mi, m.ff_mph, m.demand_obs, m.served_obs, m.speed_obs, m.vc_obs,
    m.los_obs, m.delay_obs, m.cap_obs, m.cap_scen, m.d_lever,
    -- MSA damping: x' = x + 1/(k+1) * (y - x), where y is the all-or-nothing
    -- loading. A convex combination of two demand vectors that each conserve
    -- total demand, which is why conservation holds to machine precision.
    --
    -- Traffic is sent to the network only if somewhere reachable actually has
    -- room. The off-network share leaves regardless: it stands in for the local
    -- arterial network, which is not in this data and so is never "full" here.
    greatest(0.0, m.x + (1.0 / 5.0) * (
        (m.x
         - CASE WHEN COALESCE(m.pull, 0.0) > 0.0
                THEN m.my_excess * :reassign_share
                     * (1.0 - :reassign_offnetwork_share)
                ELSE 0.0 END
         - m.my_excess * :reassign_share * :reassign_offnetwork_share
         + m.received)
        - m.x)) AS x,
    m.leak + (1.0 / 5.0) * (
      (m.leak + m.my_excess * :reassign_share * :reassign_offnetwork_share) - m.leak
    ) AS leak,
    m.base_excess,
    4 AS iter
  FROM x4_move m
),
-- ── 6. Pick the requested iterate ───────────────────────────────────────────
picked AS (
  SELECT * FROM st0 WHERE 0 = :msa_iterations
  UNION ALL
  SELECT * FROM st1 WHERE 1 = :msa_iterations
  UNION ALL
  SELECT * FROM st2 WHERE 2 = :msa_iterations
  UNION ALL
  SELECT * FROM st3 WHERE 3 = :msa_iterations
  UNION ALL
  SELECT * FROM st4 WHERE 4 = :msa_iterations
),
solved AS (
  SELECT
    p.*,
    -- SNAP. The MSA update is `x + 1/(k+1)*(y - x)` applied up to 4 times;
    -- in floating point that leaves ~1e-12 of residue on x even when every delta
    -- is exactly zero. Downstream, v/c is pivoted on the ratio x/d_lever, so a
    -- 1e-12 residue is the difference between an exactly-1.0 ratio and a
    -- nearly-1.0 one -- and it was enough to flip one station-bucket sitting on
    -- the LOS D/E threshold. Anything within 1e-6 vph of the lever-adjusted
    -- demand is treated as unmoved: six orders of magnitude below the smallest
    -- meaningful flow (1 vehicle/hour), so this cannot mask a real diversion.
    CASE WHEN abs(p.x - p.d_lever) < 1e-6 THEN p.d_lever ELSE p.x END AS dx
  FROM picked p
),
-- ── 7. Metrics, before and after ────────────────────────────────────────────
-- The BEFORE side is read straight from the table, not recomputed, so "before"
-- on the KPI panel is literally the number the M1 map drew. The AFTER side is
-- the observed value times the BPR travel-time ratio (see header). Every ratio
-- collapses to 1.0 when no lever is set.
--
-- VMT/VHT use SERVED flow, not demand: vehicle-miles that never got onto the
-- road are not travelled. Served flow is min(demand, capacity) in ratio form,
-- so suppressed throughput under a closure shows up as a VMT drop while the
-- delay/VHT rise shows up on the traffic that does move.
--   VMT = served_vph * 0.25 h * seg_len_mi
--   VHT = VMT / speed_mph
metrics AS (
  SELECT
    s.station_id, s.bucket_idx, s.freeway, s.direction, s.postmile,
    s.num_lanes, s.seg_len_mi, s.ff_mph, s.iter,
    s.demand_obs, s.d_lever, s.dx AS demand_after, s.leak AS offnetwork_vph,
    s.cap_obs, s.cap_scen,
    s.vc_obs   AS vc_before,
    -- v/c "after" is pivoted on the observed v/c rather than recomputed as
    -- x/cap_scen. Algebraically identical when nothing changed, but NOT identical
    -- in floating point: the MSA arithmetic (x + 1/(k+1)*(y - x), four times over)
    -- leaves ~1e-12 of residue on x even when every delta is zero, and
    -- 1e-12 was enough to flip one station-bucket sitting exactly on the
    -- LOS D/E threshold to a different grade. Multiplying the observed v/c by a
    -- ratio that is exactly 1.0 when nothing moved keeps the no-op bit-exact.
    s.vc_obs
      * (s.dx / greatest(1e-9, s.demand_obs))
      * (s.cap_obs / greatest(1e-9, s.cap_scen)) AS vc_after,
    s.speed_obs AS speed_before,
    s.served_obs AS served_before,
    s.los_obs,
    s.delay_obs,
    (1.0 + :bpr_alpha * pow(greatest(0.0, s.vc_obs), :bpr_beta)) AS tt_before,
    (1.0 + :bpr_alpha * pow(greatest(0.0, s.vc_obs * (s.dx / greatest(1e-9, s.demand_obs)) * (s.cap_obs / greatest(1e-9, s.cap_scen))), :bpr_beta)) AS tt_after,
    least(s.demand_obs, s.cap_obs) AS served_model_before,
    least(s.dx, s.cap_scen)        AS served_model_after
  FROM solved s
),
derived AS (
  SELECT
    m.*,
    -- Pivot-point speed, floored at 8.0 mph (in full breakdown traffic
    -- creeps rather than stopping dead, as the generator also assumes) and
    -- ceilinged so relief cannot invent speed above free-flow.
    --
    -- The ceiling is `greatest(ff_mph, speed_before)`, NOT `ff_mph`. Measured:
    -- 62,976 of 191,424 rows in one day have avg_speed_mph ABOVE
    -- free_flow_speed_mph, by up to 4.0 mph, because the generator adds 2.5%
    -- measurement jitter after the BPR curve. A bare `least(ff_mph, ...)` ceiling
    -- therefore silently trimmed a third of the baseline and the no-op proof
    -- failed on speed while passing on v/c. Anchoring the ceiling on the observed
    -- value keeps the no-op exact and still prevents relief running away.
    least(greatest(m.ff_mph, m.speed_before), greatest(8.0,
      m.speed_before * m.tt_before / greatest(1e-9, m.tt_after))) AS speed_after,
    -- Pivot-point served flow: observed throughput scaled by the modelled
    -- throughput ratio, so it too is an exact no-op with no lever set.
    m.served_before * m.served_model_after
      / greatest(1e-9, m.served_model_before)                    AS served_after
  FROM metrics m
),
station_metrics AS (
  SELECT
    d.* EXCEPT (los_obs, delay_obs),
    -- LOS is derived from v/c on BOTH sides with the same expression, rather than
    -- reading `level_of_service` for before and computing after. The table agrees
    -- with this expression on 191,423 of 191,424 rows for 2026-06-10 -- the one
    -- exception sits exactly on a threshold, where the stored grade was decided
    -- from an unrounded v/c. Deriving both sides identically makes the no-op
    -- exact by construction instead of exact-modulo-one-row.
    CASE WHEN d.vc_before < 0.35 THEN 'A' WHEN d.vc_before < 0.55 THEN 'B' WHEN d.vc_before < 0.77 THEN 'C' WHEN d.vc_before < 0.92 THEN 'D' WHEN d.vc_before < 1.0 THEN 'E' ELSE 'F' END AS los_before,
    CASE WHEN d.vc_after < 0.35 THEN 'A' WHEN d.vc_after < 0.55 THEN 'B' WHEN d.vc_after < 0.77 THEN 'C' WHEN d.vc_after < 0.92 THEN 'D' WHEN d.vc_after < 1.0 THEN 'E' ELSE 'F' END  AS los_after,
    -- Delay is pivoted ADDITIVELY, not multiplicatively: observed delay plus the
    -- modelled change in delay.
    --
    -- The stored `delay_vs_freeflow_min_per_mi` is the MEAN of the per-5-minute
    -- delays in the bucket, and delay is convex in speed, so by Jensen it exceeds
    -- the delay implied by the bucket's mean speed -- measured up to 3.08 min/mi
    -- higher on oversaturated rows. Recomputing "after" from speed while reading
    -- "before" from the table would therefore report a large spurious delay
    -- REDUCTION for a scenario that changed nothing. Adding the modelled delta to
    -- the observed value preserves the within-bucket variance the table captured
    -- and is an exact no-op when the delta is zero.
    greatest(0.0, d.delay_obs
      + (60.0 / greatest(1e-9, d.speed_after) - 60.0 / greatest(1e-9, d.ff_mph))
      - (60.0 / greatest(1e-9, d.speed_before) - 60.0 / greatest(1e-9, d.ff_mph))
    )                                                            AS delay_after,
    d.delay_obs                                                  AS delay_before,
    d.served_before * 0.25 * d.seg_len_mi               AS vmt_before,
    d.served_after  * 0.25 * d.seg_len_mi               AS vmt_after,
    d.served_before * 0.25 * d.seg_len_mi
      / greatest(1e-9, d.speed_before)                            AS vht_before,
    d.served_after  * 0.25 * d.seg_len_mi
      / greatest(1e-9, d.speed_after)                             AS vht_after
  FROM derived d
),
out_stations AS (
  -- Dense 0..N-1 index over the FILTERED station set, derived from the whole day.
  SELECT
    station_id,
    CAST(ROW_NUMBER() OVER (ORDER BY station_id) - 1 AS INT) AS station_idx
  FROM (
    SELECT DISTINCT station_id
    FROM station_metrics
    WHERE (:freeway = 'ALL' OR freeway = :freeway)
  )
),
cells AS (
  SELECT
    o.station_idx,
    m.bucket_idx,
    CAST(ROUND(m.served_after) AS INT)                     AS flow,
    CAST(ROUND(m.speed_after * 2) AS INT)                  AS speed_half,
    CAST(ROUND(m.vc_after * 100) AS INT)                   AS vc_pct,
    -- An "incident" pixel now means any capacity loss vs baseline, whether from
    -- the injected incident or a planned closure: 0 = none, else a 1..4 severity
    -- proxy binned by how much capacity was lost, so the M1 renderer's severity
    -- ramp keeps working unchanged.
    CAST(
      CASE
        WHEN m.cap_scen < m.cap_obs * 0.999
        THEN least(4, greatest(1, CAST(CEIL((1.0 - m.cap_scen / greatest(1e-9, m.cap_obs))
                                            * 4.0) AS INT)))
        ELSE 0
      END AS INT)                                          AS incident,
    -- Delay in CENTI-minutes per mile (x100). Integer-encoded like everything
    -- else; the client divides by 100.
    CAST(ROUND(m.delay_after * 100) AS INT)                AS delay_c
  FROM station_metrics m
  JOIN out_stations o ON o.station_id = m.station_id
  WHERE (:freeway = 'ALL' OR m.freeway = :freeway)
),
windowed AS (
  SELECT
    *,
    -- Explicit bucket-major, station-minor sort key. The 100000 multiplier
    -- exceeds the max station count (1,994) by a wide margin so the two fields
    -- can never collide.
    CAST((bucket_idx - :from_bucket) * 100000 + station_idx AS BIGINT) AS ord
  FROM cells
  WHERE bucket_idx >= :from_bucket
    AND bucket_idx < :from_bucket + 24
)
SELECT
  CAST(COUNT(*) AS INT)                        AS n,
  CAST(MIN(bucket_idx) AS INT)                 AS first_bucket,
  CAST(MAX(bucket_idx) AS INT)                 AS last_bucket,
  CAST(COUNT(DISTINCT station_idx) AS INT)     AS stations,
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
  ) AS incident,
  ARRAY_JOIN(
    TRANSFORM(
      ARRAY_SORT(
        COLLECT_LIST(STRUCT(ord, delay_c)),
        (l, r) -> CASE WHEN l.ord < r.ord THEN -1 WHEN l.ord > r.ord THEN 1 ELSE 0 END
      ),
      x -> CAST(x.delay_c AS STRING)
    ), ','
  ) AS delay_c
FROM windowed
