"""Bronze: synthetic incident log.

Incidents are the story driver: each one removes capacity at one station for a
bounded window, which the readings table turns into a localized speed collapse.
Generated as a station x day cross join thinned by a deterministic hash, so the
same incidents reappear on every full refresh.
"""

from caltrans_traffic import config as C
from caltrans_traffic import traffic_model as M
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view(
    name="bronze_incidents",
    comment=(
        "Synthetic incident log (collision/breakdown/debris/construction). "
        "Incidents are 2x more likely during commute peaks and scale with "
        "urbanisation; each removes capacity at its station for its duration."
    ),
    cluster_by=["freeway", "start_ts"],
    table_properties={
        "delta.autoOptimize.optimizeWrite": "true",
        "delta.enableRowTracking": "true",
    },
)
@dp.expect_or_fail("incident_id_not_null", "incident_id IS NOT NULL")
@dp.expect_or_drop("station_id_not_null", "station_id IS NOT NULL")
@dp.expect_or_drop("end_after_start", "end_ts > start_ts")
@dp.expect_or_drop("valid_severity", "severity BETWEEN 1 AND 4")
@dp.expect_or_drop("lanes_blocked_sane", "lanes_blocked BETWEEN 0 AND num_lanes")
@dp.expect_or_drop(
    "valid_incident_type",
    "incident_type IN ('collision', 'breakdown', 'debris', 'construction')",
)
@dp.expect("duration_under_6h", "duration_min <= 360")
def bronze_incidents():
    stations = spark.read.table("bronze_stations")
    days = spark.range(0, C.SIM_DAYS).withColumnRenamed("id", "day_offset")

    keys = ["station_id", "day_offset"]
    # Urban corridors see more incidents (more vehicles, more conflict points).
    occur_p = f"{C.INCIDENT_RATE_PER_STATION_DAY} * (0.4 + 1.2 * urban_intensity)"

    # Hour of day: 60% of incidents land in a commute peak window, mirroring
    # the demand profile rather than spreading uniformly across the clock.
    peak_draw = M.uniform_expr(*keys, salt="peak")
    hour_frac = M.uniform_expr(*keys, salt="hour")
    start_hour = f"""
        CASE
          WHEN {peak_draw} < 0.32 THEN 6.5 + 3.0 * {hour_frac}
          WHEN {peak_draw} < 0.60 THEN 15.5 + 3.5 * {hour_frac}
          ELSE 24.0 * {hour_frac}
        END
    """

    sev_draw = M.uniform_expr(*keys, salt="sev")
    severity = f"""
        CASE
          WHEN {sev_draw} < 0.52 THEN 1
          WHEN {sev_draw} < 0.82 THEN 2
          WHEN {sev_draw} < 0.96 THEN 3
          ELSE 4
        END
    """

    type_draw = M.uniform_expr(*keys, salt="type")
    type_cases = []
    acc = 0.0
    for name, weight in C.INCIDENT_TYPE_WEIGHTS[:-1]:
        acc += weight
        type_cases.append(f"WHEN {type_draw} < {acc} THEN '{name}'")
    incident_type = (
        f"CASE {' '.join(type_cases)} ELSE '{C.INCIDENT_TYPE_WEIGHTS[-1][0]}' END"
    )

    def _severity_case(bounds: dict[int, int], fallback: int) -> str:
        arms = " ".join(
            f"WHEN severity = {sev} THEN {minutes}" for sev, minutes in sorted(bounds.items())
        )
        return f"CASE {arms} ELSE {fallback} END"

    dur_min = _severity_case(C.INCIDENT_DURATION_MIN, 15)
    dur_max = _severity_case(C.INCIDENT_DURATION_MAX, 30)
    dur_frac = M.uniform_expr(*keys, salt="dur")

    blocked_draw = M.uniform_expr(*keys, salt="blocked")

    return (
        stations.join(days, how="cross")
        .withColumn("_occur", F.expr(M.uniform_expr(*keys, salt="occur")))
        .filter(F.expr(f"_occur < ({occur_p})"))
        .withColumn("severity", F.expr(severity))
        .withColumn("incident_type", F.expr(incident_type))
        .withColumn("_start_hour", F.expr(start_hour))
        # Snap starts to the 5-minute detector grid so incident windows align
        # with the sample cadence and always cover >= 1 reading.
        #
        # _local_start_ts is a naive America/Los_Angeles wall clock, because
        # start_hour above is expressed in local commute hours (6.5-9.5am,
        # 3.5-7pm). bronze_station_readings builds its local clock the same way
        # and stores ts as a UTC instant, so this MUST make the same conversion:
        # comparing a naive-local incident window against a UTC reading ts
        # silently shifts every window by the Pacific offset (7h in PDT).
        .withColumn(
            "_local_start_ts",
            F.expr(
                f"date_trunc('HOUR', timestampadd(DAY, day_offset, timestamp'{C.SIM_START}'))"
                f" + make_interval(0, 0, 0, 0, cast(floor(_start_hour) as int),"
                f" cast(floor((_start_hour - floor(_start_hour)) * 12) * 5 as int), 0)"
            ),
        )
        .withColumn("start_ts", F.to_utc_timestamp("_local_start_ts", C.LOCAL_TIMEZONE))
        .withColumn(
            "duration_min",
            F.expr(
                f"cast(round((({dur_min}) + (({dur_max}) - ({dur_min})) * {dur_frac})"
                f" / 5.0) * 5 as int)"
            ),
        )
        .withColumn("end_ts", F.expr("timestampadd(MINUTE, duration_min, start_ts)"))
        # Construction closes more lanes than a stalled car on the shoulder;
        # a breakdown usually blocks nothing at all.
        .withColumn(
            "lanes_blocked",
            F.expr(
                f"""
                least(num_lanes - 1, greatest(0, CASE
                  WHEN incident_type = 'breakdown'
                    THEN (CASE WHEN {blocked_draw} < 0.55 THEN 0 ELSE 1 END)
                  WHEN incident_type = 'debris'
                    THEN (CASE WHEN {blocked_draw} < 0.65 THEN 0 ELSE 1 END)
                  WHEN incident_type = 'construction' THEN least(2, severity)
                  ELSE severity - (CASE WHEN {blocked_draw} < 0.5 THEN 1 ELSE 0 END)
                END))
                """
            ),
        )
        .withColumn(
            "incident_id",
            F.concat_ws("-", F.lit("INC"), F.col("station_id"), F.col("day_offset")),
        )
        .select(
            "incident_id",
            "station_id",
            "freeway",
            "direction",
            "district",
            "county",
            "city",
            "start_ts",
            "end_ts",
            "duration_min",
            "severity",
            "lanes_blocked",
            "num_lanes",
            "incident_type",
            F.to_timestamp(F.lit(C.GENERATION_TIMESTAMP_UTC)).alias("_generated_at"),
        )
    )
