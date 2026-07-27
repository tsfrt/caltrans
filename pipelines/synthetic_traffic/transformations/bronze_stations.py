"""Bronze: synthetic PeMS-style detector station inventory.

~2,000 stations placed along ten real California freeway corridors. This is a
generated source, so it is a materialized view rather than a streaming table:
there is no upstream to tail, and a full recompute is both cheap and required
for reproducibility.
"""

from caltrans_traffic.stations import stations_values_sql
from pyspark import pipelines as dp
from pyspark.sql import functions as F


@dp.materialized_view(
    name="bronze_stations",
    comment=(
        "Synthetic PeMS-style vehicle detector stations along 10 real California "
        "freeway corridors (I-5, I-405, I-10, US-101, I-80, I-880, I-210, SR-99, "
        "I-15, I-680). Coordinates interpolated along hand-traced route polylines."
    ),
    cluster_by=["freeway", "direction"],
    table_properties={
        "delta.autoOptimize.optimizeWrite": "true",
        "delta.enableRowTracking": "true",
    },
)
@dp.expect_or_fail("station_id_not_null", "station_id IS NOT NULL")
@dp.expect_or_fail("station_id_unique_shape", "length(station_id) BETWEEN 6 AND 16")
@dp.expect_or_drop("lat_in_california", "latitude BETWEEN 32.50 AND 42.05")
@dp.expect_or_drop("lon_in_california", "longitude BETWEEN -124.50 AND -114.10")
@dp.expect_or_drop("valid_district", "district BETWEEN 1 AND 12")
@dp.expect_or_drop("valid_direction", "direction IN ('N', 'S', 'E', 'W')")
@dp.expect_or_drop("positive_lanes", "num_lanes BETWEEN 1 AND 8")
@dp.expect_or_drop("sane_lane_capacity", "lane_capacity_vph BETWEEN 1000 AND 2400")
@dp.expect("nonneg_postmile", "postmile >= 0")
def bronze_stations():
    # Stations are a ~2k-row dimension enumerated deterministically in Python,
    # then inlined as a SQL VALUES relation (see stations_values_sql for why
    # createDataFrame does not work on serverless pipeline compute). The 17.5M-row
    # readings fact table is generated entirely in Spark.
    return (
        spark.sql(stations_values_sql())
        .withColumn("_generated_at", F.current_timestamp())
        .withColumn("_generator_version", F.lit("v1"))
    )
