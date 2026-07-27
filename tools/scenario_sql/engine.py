"""Single source of truth for the M2 what-if engine SQL.

`caltrans-whatif/config/queries/scenario_time_matrix.sql` and
`scenario_kpis.sql` must run the *same* engine: if they diverged, the KPI panel
would report numbers the map does not draw. They cannot simply `import` each
other -- AppKit reads flat `.sql` files -- so instead this module holds the
engine once and `render.py` writes both files from it. `tests/test_scenario_sql.py`
re-renders and asserts the committed files match, so drift is a test failure
rather than a silent inconsistency.

The engine's shape is forced by two DBSQL facts, both verified on warehouse
688f49c732cf9083 (dbsql 2026.20):

1. `WITH RECURSIVE` cannot aggregate over the recursive reference
   (`INVALID_RECURSIVE_REFERENCE.PLACE ... in aggregates SQLSTATE 42836`), and
   every reassignment iteration is a `SUM(...) GROUP BY` over diversion
   candidates. So MSA iterations are **unrolled** at render time, not looped.
2. `RECURSIVE` must follow `WITH` immediately, so it cannot be introduced
   part-way down a CTE chain anyway.

Read `caltrans-whatif/docs/WHATIF_ENGINE.md` for the modelling rationale.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Rendering constants
# ---------------------------------------------------------------------------

#: Number of MSA iterations written into the SQL. `:msa_iterations` selects which
#: iterate is returned (0 = no reassignment). Iterations above the requested
#: count are pruned by the optimiser because the UNION ALL arm carrying them has
#: a literal-false predicate -- measured, see docs/WHATIF_ENGINE.md.
MAX_ITERS = 4

#: Width of one gold_map_frames bucket, in hours. 15-minute buckets -> 0.25 h.
#: This is the multiplier that turns a vehicles/hour rate into vehicles.
BUCKET_HOURS = 0.25

#: HCM freeway LOS thresholds on demand-based v/c, identical to
#: `caltrans_traffic.config.LOS_THRESHOLDS`.
LOS_THRESHOLDS = (("A", 0.35), ("B", 0.55), ("C", 0.77), ("D", 0.92), ("E", 1.00))

#: Absolute speed floor (mph), identical to `caltrans_traffic.config.MIN_SPEED_MPH`.
MIN_SPEED_MPH = 8.0

#: Extra capacity loss beyond the physically blocked lanes for an *incident*
#: (rubbernecking + merge turbulence), identical to
#: `caltrans_traffic.config.RUBBERNECK_CAPACITY_LOSS`. A planned lane closure
#: does NOT get this term -- see docs/WHATIF_ENGINE.md.
RUBBERNECK_CAPACITY_LOSS = 0.12

#: Floor on any capacity-reduction factor, so a total closure still leaves a
#: sliver of capacity and v/c stays finite. Mirrors the generator's 0.05.
MIN_CAPACITY_FACTOR = 0.05

TABLE_FRAMES = "lanl.caltrans_traffic.gold_map_frames"
TABLE_STATIONS = "lanl.caltrans_traffic.silver_stations_geo"

LOCAL_TZ = "America/Los_Angeles"


# ---------------------------------------------------------------------------
# Small SQL expression helpers, mirroring caltrans_traffic.traffic_model
# ---------------------------------------------------------------------------


def los_expr(vc: str) -> str:
    """HCM LOS grade from a demand-based v/c expression."""
    arms = " ".join(f"WHEN {vc} < {upper} THEN '{grade}'" for grade, upper in LOS_THRESHOLDS)
    return f"CASE {arms} ELSE 'F' END"


def bpr_tt_factor(vc: str) -> str:
    """The BPR congestion multiplier on free-flow travel time: 1 + a*(v/c)^b."""
    return f"(1.0 + :bpr_alpha * pow(greatest(0.0, {vc}), :bpr_beta))"


def incident_factor(lanes: str, blocked: str) -> str:
    """Surviving capacity fraction under an incident (blocked lanes + rubbernecking)."""
    open_lanes = f"greatest(0.0, CAST({lanes} AS DOUBLE) - CAST({blocked} AS DOUBLE))"
    physical = f"({open_lanes} / greatest(1.0, CAST({lanes} AS DOUBLE)))"
    return f"greatest({MIN_CAPACITY_FACTOR}, {physical} * (1.0 - {RUBBERNECK_CAPACITY_LOSS}))"


def closure_factor(lanes: str, closed: str) -> str:
    """Surviving capacity fraction under a *planned* lane closure (no rubbernecking)."""
    open_lanes = f"greatest(0.0, CAST({lanes} AS DOUBLE) - CAST({closed} AS DOUBLE))"
    return f"greatest({MIN_CAPACITY_FACTOR}, {open_lanes} / greatest(1.0, CAST({lanes} AS DOUBLE)))"


# ---------------------------------------------------------------------------
# Documented parameter surface
# ---------------------------------------------------------------------------
# (name, sql_type, default_meaning) -- the server module in
# caltrans-whatif/server/scenario/ binds exactly these and nothing else.

PARAMS: tuple[tuple[str, str, str], ...] = (
    ("day", "DATE", "Pacific-local reading_date to model. Required."),
    ("freeway", "STRING", "'ALL' or a freeway name. OUTPUT filter only -- the engine "
                          "always solves over all 10 corridors so diversion targets exist."),
    ("from_bucket", "INT", "First 15-minute bucket index (0..95, Pacific local) of the "
                           "24-bucket output window. Time matrix only."),
    ("bpr_alpha", "DOUBLE", "BPR alpha. 0.55 to match the data generator."),
    ("bpr_beta", "DOUBLE", "BPR beta. 4.5 to match the data generator."),
    ("msa_iterations", "INT", f"0..{MAX_ITERS}. 0 disables reassignment entirely."),
    ("close_freeway", "STRING", "'' disables the lane-closure lever."),
    ("close_direction", "STRING", "'' = both directions."),
    ("close_pm_from", "DOUBLE", "Closure postmile window start."),
    ("close_pm_to", "DOUBLE", "Closure postmile window end."),
    ("close_lanes", "INT", "Lanes to close. 0 disables."),
    ("demand_freeway", "STRING", "'' disables the demand lever. 'ALL' = every corridor."),
    ("demand_direction", "STRING", "'' = both directions."),
    ("demand_pct", "DOUBLE", "Percent demand change, e.g. 20 = +20%, -15 = -15%. 0 disables."),
    ("incident_freeway", "STRING", "'' disables the incident lever."),
    ("incident_direction", "STRING", "'' = both directions."),
    ("incident_pm_from", "DOUBLE", "Incident postmile window start."),
    ("incident_pm_to", "DOUBLE", "Incident postmile window end."),
    ("incident_lanes_blocked", "INT", "Lanes blocked by the injected incident. 0 disables."),
    ("incident_from_bucket", "INT", "First bucket (0..95) the incident is active."),
    ("incident_to_bucket", "INT", "Last bucket (0..95) the incident is active, inclusive."),
    ("capacity_freeway", "STRING", "'' disables all three capacity levers."),
    ("capacity_direction", "STRING", "'' = both directions."),
    ("capacity_pm_from", "DOUBLE", "Capacity-lever postmile window start."),
    ("capacity_pm_to", "DOUBLE", "Capacity-lever postmile window end."),
    ("capacity_add_lanes", "INT", "Lanes to ADD (negative removes). 0 = no change."),
    ("capacity_scale", "DOUBLE", "Multiplier on effective capacity. 1.0 = no change."),
    ("capacity_abs_vph", "DOUBLE", "Absolute effective-capacity override in vph. "
                                   "-1 = no override. Applied last."),
    ("reassign_share", "DOUBLE", "Fraction of over-capacity demand that is willing to "
                                 "re-route at all (0..1). 0 disables diversion."),
    ("reassign_offnetwork_share", "DOUBLE", "Of the willing share, the fraction that leaves "
                                            "the modelled freeway network entirely (local "
                                            "arterials, not in the data). 0..1."),
    ("parallel_max_dist_m", "DOUBLE", "Max ST_DistanceSphere metres to a parallel-corridor "
                                      "diversion target."),
    ("parallel_max_bearing_deg", "DOUBLE", "Max heading difference (degrees) for a parallel-"
                                           "corridor target to count as 'parallel'."),
    ("worst_n", "INT", "Rows in the worst-segment list. KPI query only."),
)


# ---------------------------------------------------------------------------
# Engine SQL
# ---------------------------------------------------------------------------

_HEADER = f"""\
-- ══════════════════════════════════════════════════════════════════════════════
--  M2 WHAT-IF ENGINE — {{title}}
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
--  a SUM/GROUP BY over diversion candidates. So {MAX_ITERS} iterations are
--  rendered explicitly and `:msa_iterations` picks the iterate. Arms above the
--  requested count carry a literal-false predicate and are pruned by the
--  optimiser, so latency really does fall when you ask for fewer.
-- ══════════════════════════════════════════════════════════════════════════════
"""


def _bucket_idx(ts_col: str) -> str:
    """0..95 Pacific-local 15-minute bucket index."""
    local = f"from_utc_timestamp({ts_col}, '{LOCAL_TZ}')"
    return f"(hour({local}) * 4 + (minute({local}) DIV 15))"


_GEOMETRY = f"""\
-- ── 1. Static network geometry ────────────────────────────────────────────────
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
  FROM {TABLE_STATIONS} s
  WINDOW w AS (PARTITION BY s.freeway, s.direction ORDER BY s.postmile)
),"""


_OBSERVED = f"""\
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
    CAST({_bucket_idx('f.time_bucket')} AS INT) AS bucket_idx,
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
  FROM {TABLE_FRAMES} f
  WHERE f.reading_date = :day
),"""


_LEVERS = f"""\
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
        THEN greatest({MIN_CAPACITY_FACTOR},
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
        THEN {closure_factor('o.num_lanes', ':close_lanes')}
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
               {incident_factor('o.num_lanes', ':incident_lanes_blocked')}
               / CASE WHEN o.incident_obs
                      THEN {incident_factor('o.num_lanes', 'o.lanes_blocked_obs')}
                      ELSE 1.0 END)
        ELSE 1.0
      END
      *
      CASE
        WHEN :capacity_freeway <> '' AND o.freeway = :capacity_freeway
             AND (:capacity_direction = '' OR o.direction = :capacity_direction)
             AND o.postmile BETWEEN :capacity_pm_from AND :capacity_pm_to
        THEN greatest({MIN_CAPACITY_FACTOR}, :capacity_scale)
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
),"""


_CANDIDATES = """\
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
),"""


def _iteration(k: int) -> str:
    """Render MSA iteration k (1-based), reading `it{k-1}` and writing `it{k}`.

    One iteration is:
      excess_i    = max(0, x_i - c_i)                    over-capacity demand
      willing_i   = reassign_share * excess_i            drivers open to re-routing
      offnet_i    = willing_i * offnetwork_share         leaves the modelled network
      divert_i    = willing_i - offnet_i, but only if station i has at least one
                    candidate with spare capacity; otherwise it stays put
      y_i         = x_i - sent_i + received_i            all-or-nothing loading
      x'_i        = x_i + 1/(k+1) * (y_i - x_i)          MSA damping

    x' is a convex combination of two demand vectors that each conserve total
    demand (sent == received + offnet by construction), so total demand is
    conserved exactly at every iteration. That is the property the conservation
    check in scenario_kpis.sql verifies numerically.
    """
    prev = f"st{k - 1}"
    step = f"(1.0 / {k + 1}.0)"
    return f"""\
-- ── MSA iteration {k} of {MAX_ITERS} (damping step 1/{k + 1}) ─────────────────────────────────
-- ⚠️ PERFORMANCE — READ THIS BEFORE EDITING. This block references the previous
-- iterate `{prev}` EXACTLY ONCE, and `st{k}` references `x{k}_move` exactly once.
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
x{k}_flux AS (
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
    FROM {prev} p
    LEFT JOIN cand_role c ON c.join_key = p.station_id
  ) f
),
x{k}_move AS (
  -- One grouping pass yields BOTH directions of flow for every station-bucket,
  -- plus the carried state, so `st{k}` needs no second look at `{prev}`.
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
  FROM x{k}_flux
  GROUP BY station_id, bucket_idx
),
st{k} AS (
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
    greatest(0.0, m.x + {step} * (
        (m.x
         - CASE WHEN COALESCE(m.pull, 0.0) > 0.0
                THEN m.my_excess * :reassign_share
                     * (1.0 - :reassign_offnetwork_share)
                ELSE 0.0 END
         - m.my_excess * :reassign_share * :reassign_offnetwork_share
         + m.received)
        - m.x)) AS x,
    m.leak + {step} * (
      (m.leak + m.my_excess * :reassign_share * :reassign_offnetwork_share) - m.leak
    ) AS leak,
    m.base_excess,
    {k} AS iter
  FROM x{k}_move m
),"""


_IT0 = """\
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
),"""


def _select_iterate() -> str:
    """UNION ALL over the unrolled iterates, filtered by `:msa_iterations`.

    A UNION arm whose predicate is `N = :msa_iterations` for a literal N becomes
    provably empty once the parameter is bound, so the optimiser prunes the whole
    dependent subtree. This is why asking for 2 iterations costs less than 4
    rather than costing the same -- verified by measurement, not assumed.
    """
    arms = "\n  UNION ALL\n".join(
        f"  SELECT * FROM st{k} WHERE {k} = :msa_iterations" for k in range(MAX_ITERS + 1)
    )
    return f"""\
-- ── 6. Pick the requested iterate ───────────────────────────────────────────
picked AS (
{arms}
),
solved AS (
  SELECT
    p.*,
    -- SNAP. The MSA update is `x + 1/(k+1)*(y - x)` applied up to {MAX_ITERS} times;
    -- in floating point that leaves ~1e-12 of residue on x even when every delta
    -- is exactly zero. Downstream, v/c is pivoted on the ratio x/d_lever, so a
    -- 1e-12 residue is the difference between an exactly-1.0 ratio and a
    -- nearly-1.0 one -- and it was enough to flip one station-bucket sitting on
    -- the LOS D/E threshold. Anything within 1e-6 vph of the lever-adjusted
    -- demand is treated as unmoved: six orders of magnitude below the smallest
    -- meaningful flow (1 vehicle/hour), so this cannot mask a real diversion.
    CASE WHEN abs(p.x - p.d_lever) < 1e-6 THEN p.d_lever ELSE p.x END AS dx
  FROM picked p
),"""


_METRICS = f"""\
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
--   VMT = served_vph * {BUCKET_HOURS} h * seg_len_mi
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
    {bpr_tt_factor('s.vc_obs')} AS tt_before,
    {bpr_tt_factor(
      's.vc_obs * (s.dx / greatest(1e-9, s.demand_obs))'
      ' * (s.cap_obs / greatest(1e-9, s.cap_scen))'
    )} AS tt_after,
    least(s.demand_obs, s.cap_obs) AS served_model_before,
    least(s.dx, s.cap_scen)        AS served_model_after
  FROM solved s
),
derived AS (
  SELECT
    m.*,
    -- Pivot-point speed, floored at {MIN_SPEED_MPH} mph (in full breakdown traffic
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
    least(greatest(m.ff_mph, m.speed_before), greatest({MIN_SPEED_MPH},
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
    {los_expr('d.vc_before')} AS los_before,
    {los_expr('d.vc_after')}  AS los_after,
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
    d.served_before * {BUCKET_HOURS} * d.seg_len_mi               AS vmt_before,
    d.served_after  * {BUCKET_HOURS} * d.seg_len_mi               AS vmt_after,
    d.served_before * {BUCKET_HOURS} * d.seg_len_mi
      / greatest(1e-9, d.speed_before)                            AS vht_before,
    d.served_after  * {BUCKET_HOURS} * d.seg_len_mi
      / greatest(1e-9, d.speed_after)                             AS vht_after
  FROM derived d
)"""


def engine_sql() -> str:
    """The shared CTE chain, ending with the `station_metrics` CTE.

    Callers append either `,\\n<further CTEs>` or `\\nSELECT ... FROM station_metrics`.
    """
    parts = [_GEOMETRY, _OBSERVED, _LEVERS, _CANDIDATES, _IT0]
    parts += [_iteration(k) for k in range(1, MAX_ITERS + 1)]
    parts += [_select_iterate(), _METRICS]
    return "WITH " + "\n".join(parts)


def header(title: str) -> str:
    return _HEADER.format(title=title)
