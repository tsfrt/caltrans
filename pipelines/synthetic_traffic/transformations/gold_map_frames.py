"""Gold: per-station per-15-minute frames driving the animated map.

The app steps through ``time_bucket`` values and redraws the map at each one, so
this table is the animation's frame buffer. Pre-aggregating 5-minute readings
into 15-minute buckets cuts the row count ~3x (17.5M -> ~5.8M) and, more
importantly, means a single frame query touches ~2k rows instead of ~6k.

Clustered by ``time_bucket`` first: every app query filters on it, so liquid
clustering on that column is what keeps a frame fetch fast on a Small warehouse.
"""

from caltrans_traffic import config as C
from caltrans_traffic import traffic_model as M
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view(
    name="gold_map_frames",
    comment=(
        f"Animation-ready frames: one row per station per {C.FRAME_MINUTES}-minute "
        "bucket with flow, speed, v/c, LOS, H3 cell and geometry. Clustered by "
        "time_bucket so a single frame fetch is a narrow scan. ~5.8M rows."
    ),
    cluster_by=["time_bucket", "freeway"],
    table_properties={
        "delta.autoOptimize.optimizeWrite": "true",
        "delta.autoOptimize.autoCompact": "true",
    },
)
@dp.expect_or_fail("station_id_not_null", "station_id IS NOT NULL")
@dp.expect_or_fail("time_bucket_not_null", "time_bucket IS NOT NULL")
@dp.expect_or_drop("lat_in_california", "latitude BETWEEN 32.50 AND 42.05")
@dp.expect_or_drop("lon_in_california", "longitude BETWEEN -124.50 AND -114.10")
@dp.expect_or_drop("speed_in_range", "avg_speed_mph > 0 AND avg_speed_mph <= 100")
@dp.expect_or_drop("flow_nonneg", "avg_flow_vph >= 0")
@dp.expect_or_drop("valid_los", "level_of_service IN ('A','B','C','D','E','F')")
@dp.expect_or_drop("baseline_capacity_positive", "baseline_capacity_vph > 0")
def gold_map_frames():
    src = spark.read.table("silver_readings_enriched")

    agg = src.groupBy(
        "station_id",
        "time_bucket",
        "freeway",
        "direction",
        "district",
        "county",
        "city",
        "postmile",
        "latitude",
        "longitude",
        "station_type",
        "h3_r7",
        "h3_r8",
        "h3_r8_str",
        "h3_r9",
    ).agg(
        F.round(F.avg("demanded_flow_vph")).cast("int").alias("avg_demanded_flow_vph"),
        F.max("demanded_flow_vph").alias("peak_demanded_flow_vph"),
        F.round(F.avg("total_flow_vph")).cast("int").alias("avg_flow_vph"),
        F.max("total_flow_vph").alias("peak_flow_vph"),
        F.round(F.avg("avg_speed_mph"), 1).alias("avg_speed_mph"),
        F.round(F.min("avg_speed_mph"), 1).alias("min_speed_mph"),
        F.round(F.avg("avg_occupancy"), 4).alias("avg_occupancy"),
        F.round(F.avg("vc_ratio"), 4).alias("vc_ratio"),
        F.round(F.max("vc_ratio"), 4).alias("max_vc_ratio"),
        F.round(F.avg("served_vc_ratio"), 4).alias("served_vc_ratio"),
        F.round(F.max("served_vc_ratio"), 4).alias("max_served_vc_ratio"),
        F.round(F.avg("delay_vs_freeflow_min_per_mi"), 4).alias(
            "delay_vs_freeflow_min_per_mi"
        ),
        F.round(F.avg("free_flow_speed_mph"), 1).alias("free_flow_speed_mph"),
        F.round(F.avg("observed_pct"), 1).alias("observed_pct"),
        F.max(F.col("is_congested").cast("int")).cast("boolean").alias("is_congested"),
        F.max(F.col("incident_active").cast("int")).cast("boolean").alias("incident_active"),
        F.max("incident_severity").alias("max_incident_severity"),
        F.max("lanes_blocked").alias("lanes_blocked"),
        F.first("num_lanes").alias("num_lanes"),
        # baseline_* are the levers the what-if engine perturbs.
        F.first("baseline_capacity_vph").alias("baseline_capacity_vph"),
        F.first("baseline_lanes").alias("baseline_lanes"),
        F.first("baseline_lane_capacity_vph").alias("baseline_lane_capacity_vph"),
        F.count(F.lit(1)).alias("sample_count"),
    )

    local_time_bucket = F.from_utc_timestamp("time_bucket", C.LOCAL_TIMEZONE)

    return (
        # Recompute LOS from the bucket-average v/c rather than averaging the
        # per-sample grades, which would be meaningless for an ordinal scale.
        agg.withColumn("level_of_service", F.expr(M.level_of_service_expr("vc_ratio")))
        .withColumn("hour_of_day", F.hour(local_time_bucket))
        .withColumn("reading_date", F.to_date(local_time_bucket))
        .withColumn("day_of_week", F.dayofweek(local_time_bucket))
        .withColumn("is_weekend", F.dayofweek(local_time_bucket).isin(1, 7))
        # Geometry regenerated here so the app can hit this one table for both
        # metrics and map position without joining back to the dimension.
        .withColumn("geom", F.expr(f"ST_Point(longitude, latitude, {C.SRID})"))
        .withColumn(
            "geom_wkt", F.expr(f"ST_AsText(ST_Point(longitude, latitude, {C.SRID}))")
        )
        # A 0..1 severity ramp for direct use as a map colour scale.
        .withColumn(
            "congestion_index",
            F.expr(
                "round(least(1.0, greatest(0.0,"
                " 1.0 - (avg_speed_mph / free_flow_speed_mph))), 4)"
            ),
        )
    )
