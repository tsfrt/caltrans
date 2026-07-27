"""Bronze: 5-minute detector readings — the core fact table.

Volume: 2,022 stations x 8,640 intervals (30 days @ 5 min) = ~17.5M rows.

The generation chain, in order:

1. **Demand** = diurnal profile (twin Gaussian commute peaks on weekdays, one
   broad midday bump at weekends) x day-of-week scale x direction commute
   asymmetry x urbanisation scale x log-normal noise.
2. **Capacity** = num_lanes x lane_capacity_vph, reduced while an incident is
   active at that station (blocked lanes + 12% rubbernecking loss).
3. **v/c** = demanded flow / effective capacity.
4. **Speed** = BPR volume-delay function of v/c against free-flow speed.
5. **Occupancy** = derived from flow and speed via density = flow / speed, so
   the three reported measures stay mutually consistent.

The simulated clock is generated in America/Los_Angeles local time and then
stored as UTC timestamps. Everything except metadata columns in upstream
dimension tables is derived from hashes of (station_id, interval) rather than
rand(), so traffic measures are reproducible across full refreshes.
"""

from caltrans_traffic import config as C
from caltrans_traffic import traffic_model as M
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view(
    name="bronze_station_readings",
    comment=(
        f"Synthetic {C.INTERVAL_MINUTES}-minute detector readings over "
        f"{C.SIM_DAYS} days (~17.5M rows). Demand follows twin commute peaks "
        "with direction asymmetry; speed follows a BPR volume-delay curve; "
        "occupancy is derived from flow/speed. Incidents collapse speed locally."
    ),
    cluster_by=["ts", "station_id"],
    table_properties={
        "delta.autoOptimize.optimizeWrite": "true",
        "delta.enableRowTracking": "true",
    },
)
@dp.expect_or_fail("station_id_not_null", "station_id IS NOT NULL")
@dp.expect_or_fail("ts_not_null", "ts IS NOT NULL")
@dp.expect_or_drop("demand_nonneg", "demanded_flow_vph >= 0")
@dp.expect_or_drop("flow_nonneg", "total_flow_vph >= 0")
@dp.expect_or_drop("served_not_above_demand", "total_flow_vph <= demanded_flow_vph")
@dp.expect_or_drop("flow_upper_bound", "total_flow_vph <= 20000")
@dp.expect_or_drop("speed_in_range", "avg_speed_mph > 0 AND avg_speed_mph <= 100")
@dp.expect_or_drop("occupancy_fraction", "avg_occupancy BETWEEN 0 AND 1")
@dp.expect_or_drop("observed_pct_range", "observed_pct BETWEEN 0 AND 100")
@dp.expect_or_drop(
    "lanes_reporting_sane", "num_lanes_reporting BETWEEN 0 AND num_lanes"
)
def bronze_station_readings():
    stations = spark.read.table("bronze_stations").select(
        "station_id",
        "freeway",
        "direction",
        "num_lanes",
        "lane_capacity_vph",
        "urban_intensity",
        "detector_health",
        "station_type",
    )

    # One row per 5-minute interval across the whole window.
    intervals = spark.range(0, C.TOTAL_INTERVALS).withColumnRenamed("id", "interval_idx")

    keys = ["station_id", "interval_idx"]

    df = (
        stations.join(intervals, how="cross")
        .withColumn(
            "local_ts",
            F.expr(
                f"timestampadd(MINUTE, interval_idx * {C.INTERVAL_MINUTES},"
                f" timestamp'{C.SIM_START}')"
            ),
        )
        .withColumn("ts", F.to_utc_timestamp("local_ts", C.LOCAL_TIMEZONE))
        # Fractional hour drives the smooth Gaussian profile; dayofweek drives
        # weekday/weekend shape. Both are intentionally local Pacific values;
        # using UTC here moves California commute peaks into the wrong app hour.
        .withColumn("hour_frac", F.expr("hour(local_ts) + minute(local_ts) / 60.0"))
        .withColumn("dow", F.dayofweek("local_ts"))
        .withColumn("is_weekend", F.expr("dow IN (1, 7)"))
    )

    # --- 1. demand -----------------------------------------------------------
    demand = M.demand_factor_expr("hour_frac", "is_weekend", "direction")
    noise = M.lognormal_multiplier_expr(*keys, sigma=C.DEMAND_NOISE_SIGMA, salt="dem")
    df = df.withColumn(
        "demand_factor",
        F.expr(
            f"greatest(0.0, ({demand}) * {M.dow_scale_expr('dow')}"
            f" * {M.demand_scale_expr('urban_intensity')} * {noise})"
        ),
    )

    # Ramps and HOV lanes have proportionally smaller facilities and demand.
    # Apply this station-type scale once by scaling base capacity; latent demand
    # is then demand_factor × base_capacity_vph, not type_scale squared.
    df = df.withColumn(
        "type_scale",
        F.expr(M.station_type_scale_expr("station_type")),
    )

    # --- 2. capacity, reduced by any active incident -------------------------
    # Join the incident log on station + time window. Incidents are sparse
    # (~17k rows) so this is a broadcast-friendly range join.
    incidents = spark.read.table("bronze_incidents").select(
        F.col("station_id").alias("inc_station_id"),
        F.col("start_ts").alias("inc_start"),
        F.col("end_ts").alias("inc_end"),
        F.col("lanes_blocked").alias("inc_lanes_blocked"),
        F.col("severity").alias("inc_severity"),
    )

    df = (
        df.join(
            F.broadcast(incidents),
            (F.col("station_id") == F.col("inc_station_id"))
            & (F.col("ts") >= F.col("inc_start"))
            & (F.col("ts") < F.col("inc_end")),
            how="left",
        )
        .withColumn("incident_active", F.col("inc_start").isNotNull())
        .withColumn("lanes_blocked", F.coalesce(F.col("inc_lanes_blocked"), F.lit(0)))
    )

    df = df.withColumn(
        "capacity_factor",
        F.expr(
            f"CASE WHEN incident_active THEN "
            f"{M.incident_capacity_factor_expr('num_lanes', 'lanes_blocked')} "
            f"ELSE 1.0 END"
        ),
    )
    df = df.withColumn(
        "base_capacity_vph", F.expr("num_lanes * lane_capacity_vph * type_scale")
    )
    df = df.withColumn(
        "effective_capacity_vph", F.expr("base_capacity_vph * capacity_factor")
    )

    # --- 3. demanded flow and v/c -------------------------------------------
    df = df.withColumn(
        "demanded_flow_vph", F.expr("cast(round(demand_factor * base_capacity_vph) as int)")
    ).withColumn(
        "vc_ratio",
        F.expr("demanded_flow_vph / greatest(1.0, effective_capacity_vph)"),
    )

    # --- 4. speed via BPR ----------------------------------------------------
    ff = M.free_flow_speed_expr("urban_intensity")
    df = df.withColumn("free_flow_speed_mph", F.expr(ff)).withColumn(
        "avg_speed_raw",
        F.expr(M.bpr_speed_expr("free_flow_speed_mph", "vc_ratio")),
    )
    # A little measurement jitter on top of the deterministic curve, so the
    # data does not look suspiciously smooth to an analyst.
    speed_jitter = M.normal_expr(*keys, salt="spd")
    df = df.withColumn(
        "avg_speed_mph",
        F.expr(
            f"round(least(95.0, greatest({C.MIN_SPEED_MPH},"
            f" avg_speed_raw * (1.0 + 0.025 * {speed_jitter}))), 1)"
        ),
    )

    # Served flow: at v/c > 1 a real detector cannot record more than
    # capacity, so throughput saturates even though latent demand keeps climbing.
    df = df.withColumn(
        "total_flow_vph",
        F.expr("least(demanded_flow_vph, cast(floor(effective_capacity_vph) as int))"),
    )

    # --- 5. occupancy derived from flow and speed ---------------------------
    df = df.withColumn(
        "avg_occupancy",
        F.expr(
            "round("
            + M.occupancy_from_flow_expr(
                "total_flow_vph", "avg_speed_mph", "num_lanes"
            )
            + ", 4)"
        ),
    )

    # --- detector health -> observed_pct ------------------------------------
    # 'dark' stations report 0% observed; these rows are dropped in silver,
    # which is what gives the pipeline a real data-quality story.
    obs_draw = M.uniform_expr(*keys, salt="obs")
    df = df.withColumn(
        "observed_pct",
        F.expr(
            f"""
            CASE detector_health
              WHEN 'dark' THEN 0.0
              WHEN 'degraded' THEN round(35.0 + 45.0 * {obs_draw}, 1)
              ELSE round(96.0 + 4.0 * {obs_draw}, 1)
            END
            """
        ),
    ).withColumn(
        "num_lanes_reporting",
        F.expr("cast(round(num_lanes * observed_pct / 100.0) as int)"),
    )

    return df.select(
        "station_id",
        "ts",
        "demanded_flow_vph",
        "total_flow_vph",
        "avg_occupancy",
        "avg_speed_mph",
        "observed_pct",
        "num_lanes_reporting",
        # Carried forward so silver can compute v/c and LOS without re-deriving
        # the generation model.
        F.col("num_lanes"),
        F.col("base_capacity_vph").cast("double").alias("base_capacity_vph"),
        F.col("effective_capacity_vph").cast("double").alias("effective_capacity_vph"),
        F.col("free_flow_speed_mph"),
        F.col("incident_active"),
        F.col("lanes_blocked"),
        F.coalesce(F.col("inc_severity"), F.lit(0)).alias("incident_severity"),
    )
