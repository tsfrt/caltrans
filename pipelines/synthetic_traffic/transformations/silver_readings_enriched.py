"""Silver: readings joined to the station dimension with congestion metrics.

Drops unusable observations (dark detectors reporting 0% observed) and adds the
derived congestion measures the app and the what-if engine consume: v/c ratio,
HCM level of service, delay versus free-flow, and a congestion flag.
"""

from pyspark import pipelines as dp
from pyspark.sql import functions as F

from caltrans_traffic import config as C
from caltrans_traffic import traffic_model as M

#: Minimum detector observation rate to treat a reading as usable. PeMS
#: analysts commonly discard samples below ~20% observed; we use the same idea.
MIN_OBSERVED_PCT = 20.0


@dp.materialized_view(
    name="silver_readings_enriched",
    comment=(
        "Readings joined to stations with derived congestion metrics: v/c ratio, "
        "HCM level of service A-F, delay vs free-flow (min/mile), congestion flag. "
        f"Readings with observed_pct < {MIN_OBSERVED_PCT} are dropped as unusable."
    ),
    cluster_by=["ts", "freeway"],
    table_properties={
        "delta.autoOptimize.optimizeWrite": "true",
        "delta.enableRowTracking": "true",
    },
)
@dp.expect_or_fail("station_id_not_null", "station_id IS NOT NULL")
@dp.expect_or_fail("ts_not_null", "ts IS NOT NULL")
@dp.expect_or_drop("usable_observation", f"observed_pct >= {MIN_OBSERVED_PCT}")
@dp.expect_or_drop("flow_nonneg", "total_flow_vph >= 0")
@dp.expect_or_drop("speed_in_range", "avg_speed_mph > 0 AND avg_speed_mph <= 100")
@dp.expect_or_drop("occupancy_fraction", "avg_occupancy BETWEEN 0 AND 1")
@dp.expect_or_drop("vc_ratio_nonneg", "vc_ratio >= 0")
@dp.expect_or_drop("valid_los", "level_of_service IN ('A','B','C','D','E','F')")
@dp.expect("delay_nonneg", "delay_vs_freeflow_min_per_mi >= 0")
@dp.expect("vc_ratio_plausible", "vc_ratio <= 3.0")
def silver_readings_enriched():
    readings = spark.read.table("bronze_station_readings")
    stations = spark.read.table("silver_stations_geo").select(
        "station_id",
        "freeway",
        "direction",
        "district",
        "county",
        "city",
        "postmile",
        "abs_pm",
        "latitude",
        "longitude",
        "station_type",
        "urban_intensity",
        "h3_r7",
        "h3_r8",
        "h3_r8_str",
        "h3_r9",
        "baseline_capacity_vph",
        "baseline_lanes",
        "baseline_lane_capacity_vph",
    )

    df = readings.join(F.broadcast(stations), on="station_id", how="inner")

    # v/c against the capacity actually available at that moment (incident
    # reductions included), which is what determines observed congestion.
    df = df.withColumn(
        "vc_ratio",
        F.expr("round(total_flow_vph / greatest(1.0, effective_capacity_vph), 4)"),
    )

    return (
        df.withColumn("level_of_service", F.expr(M.level_of_service_expr("vc_ratio")))
        .withColumn(
            "delay_vs_freeflow_min_per_mi",
            F.expr(
                "round("
                + M.delay_vs_freeflow_expr("avg_speed_mph", "free_flow_speed_mph")
                + ", 4)"
            ),
        )
        .withColumn(
            "is_congested",
            F.expr(M.is_congested_expr("avg_speed_mph", "free_flow_speed_mph")),
        )
        .withColumn("speed_ratio", F.expr("round(avg_speed_mph / free_flow_speed_mph, 4)"))
        # Time dimensions the app filters and animates on.
        .withColumn("reading_date", F.to_date("ts"))
        .withColumn("hour_of_day", F.hour("ts"))
        .withColumn("day_of_week", F.dayofweek("ts"))
        .withColumn("is_weekend", F.expr("dayofweek(ts) IN (1, 7)"))
        .withColumn(
            "peak_period",
            F.expr(
                "CASE WHEN dayofweek(ts) IN (1,7) THEN 'WEEKEND'"
                " WHEN hour(ts) BETWEEN 6 AND 9 THEN 'AM_PEAK'"
                " WHEN hour(ts) BETWEEN 15 AND 18 THEN 'PM_PEAK'"
                " ELSE 'OFF_PEAK' END"
            ),
        )
        # 15-minute bucket used by the gold animation frames.
        .withColumn(
            "time_bucket",
            F.expr(
                f"timestampadd(MINUTE,"
                f" -cast(minute(ts) % {C.FRAME_MINUTES} as int),"
                f" date_trunc('MINUTE', ts))"
            ),
        )
        .select(
            "station_id",
            "ts",
            "time_bucket",
            "reading_date",
            "hour_of_day",
            "day_of_week",
            "is_weekend",
            "peak_period",
            "freeway",
            "direction",
            "district",
            "county",
            "city",
            "postmile",
            "abs_pm",
            "latitude",
            "longitude",
            "station_type",
            "h3_r7",
            "h3_r8",
            "h3_r8_str",
            "h3_r9",
            "total_flow_vph",
            "avg_occupancy",
            "avg_speed_mph",
            "observed_pct",
            "num_lanes_reporting",
            "num_lanes",
            "free_flow_speed_mph",
            "speed_ratio",
            "base_capacity_vph",
            "effective_capacity_vph",
            "baseline_capacity_vph",
            "baseline_lanes",
            "baseline_lane_capacity_vph",
            "vc_ratio",
            "level_of_service",
            "delay_vs_freeflow_min_per_mi",
            "is_congested",
            "incident_active",
            "lanes_blocked",
            "incident_severity",
        )
    )
