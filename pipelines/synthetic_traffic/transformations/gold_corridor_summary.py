"""Gold: corridor-level rollup — the what-if scenario baseline.

One row per (freeway, direction, 15-minute bucket). This is what the what-if
engine reads as the "before" case: it perturbs ``baseline_capacity_vph``
(closing lanes, adding lanes, changing metering), re-runs the same BPR relation
the pipeline used, and diffs the resulting speed and delay against these
baseline columns.

Corridor totals are ~11k rows per bucket-hour rather than 2k stations, so the
scenario comparison stays interactive on a Small warehouse.
"""

from pyspark import pipelines as dp
from pyspark.sql import functions as F

from caltrans_traffic import config as C
from caltrans_traffic import traffic_model as M


@dp.materialized_view(
    name="gold_corridor_summary",
    comment=(
        f"Per-freeway per-direction per-{C.FRAME_MINUTES}-minute corridor rollup. "
        "Carries baseline_capacity_vph / baseline_lane_count for the what-if "
        "engine to perturb, plus VMT, VHT and total delay."
    ),
    cluster_by=["time_bucket", "freeway"],
    table_properties={
        "delta.autoOptimize.optimizeWrite": "true",
        "delta.autoOptimize.autoCompact": "true",
    },
)
@dp.expect_or_fail("freeway_not_null", "freeway IS NOT NULL")
@dp.expect_or_fail("time_bucket_not_null", "time_bucket IS NOT NULL")
@dp.expect_or_drop("station_count_positive", "station_count > 0")
@dp.expect_or_drop("speed_in_range", "avg_speed_mph > 0 AND avg_speed_mph <= 100")
@dp.expect_or_drop("baseline_capacity_positive", "baseline_capacity_vph > 0")
@dp.expect_or_drop("valid_los", "level_of_service IN ('A','B','C','D','E','F')")
@dp.expect("vmt_nonneg", "vmt >= 0")
def gold_corridor_summary():
    src = spark.read.table("silver_readings_enriched")

    agg = src.groupBy("freeway", "direction", "time_bucket").agg(
        F.countDistinct("station_id").alias("station_count"),
        F.round(F.avg("total_flow_vph")).cast("int").alias("avg_flow_vph"),
        F.sum("total_flow_vph").alias("sum_flow_vph"),
        F.round(F.avg("avg_speed_mph"), 1).alias("avg_speed_mph"),
        F.round(F.min("avg_speed_mph"), 1).alias("min_speed_mph"),
        F.round(F.avg("avg_occupancy"), 4).alias("avg_occupancy"),
        F.round(F.avg("vc_ratio"), 4).alias("vc_ratio"),
        F.round(F.max("vc_ratio"), 4).alias("max_vc_ratio"),
        F.round(F.avg("free_flow_speed_mph"), 1).alias("free_flow_speed_mph"),
        F.round(F.avg("delay_vs_freeflow_min_per_mi"), 4).alias(
            "avg_delay_min_per_mi"
        ),
        F.sum(F.col("is_congested").cast("int")).alias("congested_station_samples"),
        F.count(F.lit(1)).alias("sample_count"),
        F.sum(F.col("incident_active").cast("int")).alias("incident_samples"),
        F.max("incident_severity").alias("max_incident_severity"),
        # The what-if levers, summed across the corridor.
        F.round(F.sum("baseline_capacity_vph"), 1).alias("baseline_capacity_vph"),
        F.sum("baseline_lanes").alias("baseline_lane_count"),
        F.round(F.avg("baseline_lane_capacity_vph"), 1).alias(
            "baseline_lane_capacity_vph"
        ),
        F.round(F.sum("effective_capacity_vph"), 1).alias("effective_capacity_vph"),
        # Corridor extent, so VMT can be scaled by real length.
        F.round(F.min("postmile"), 2).alias("min_postmile"),
        F.round(F.max("postmile"), 2).alias("max_postmile"),
    )

    return (
        agg.withColumn("level_of_service", F.expr(M.level_of_service_expr("vc_ratio")))
        .withColumn(
            "congested_pct",
            F.expr("round(100.0 * congested_station_samples / greatest(1, sample_count), 2)"),
        )
        .withColumn("corridor_length_mi", F.expr("round(max_postmile - min_postmile, 2)"))
        # VMT / VHT over the bucket. Each station represents its share of the
        # corridor; flow is vehicles/hour, so a 15-minute bucket contributes
        # flow * (15/60) vehicles.
        .withColumn(
            "vmt",
            F.expr(
                f"round(sum_flow_vph * ({C.FRAME_MINUTES} / 60.0)"
                f" * (corridor_length_mi / greatest(1, station_count)), 1)"
            ),
        )
        .withColumn(
            "vht", F.expr("round(vmt / greatest(1.0, avg_speed_mph), 2)")
        )
        .withColumn(
            "total_delay_veh_hours",
            F.expr("round(vmt * avg_delay_min_per_mi / 60.0, 2)"),
        )
        .withColumn("hour_of_day", F.hour("time_bucket"))
        .withColumn("reading_date", F.to_date("time_bucket"))
        .withColumn("is_weekend", F.expr("dayofweek(time_bucket) IN (1, 7)"))
        .withColumn(
            "peak_period",
            F.expr(
                "CASE WHEN dayofweek(time_bucket) IN (1,7) THEN 'WEEKEND'"
                " WHEN hour(time_bucket) BETWEEN 6 AND 9 THEN 'AM_PEAK'"
                " WHEN hour(time_bucket) BETWEEN 15 AND 18 THEN 'PM_PEAK'"
                " ELSE 'OFF_PEAK' END"
            ),
        )
    )
