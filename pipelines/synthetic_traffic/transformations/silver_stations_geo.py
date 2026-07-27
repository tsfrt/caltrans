"""Silver: stations enriched with geospatial columns.

Geo support was probed empirically on this workspace before committing to these
functions (serverless Spark 4.x writing UC Delta, read back through DBSQL
warehouse 688f49c732cf9083, channel CURRENT, dbsql 2026.20). Verified working:

* ``h3_longlatash3`` (BIGINT cell ids) at resolutions 7, 8 and 9
* ``h3_h3tostring`` (hex string form, what a JS/deck.gl map layer wants)
* ``h3_boundaryaswkt`` (cell polygon, for choropleth rendering)
* native ``GEOMETRY(4326)`` column type surviving a Delta round-trip
* ``ST_Point``, ``ST_AsText``, ``ST_SRID``, ``ST_X``/``ST_Y``, ``ST_GeomFromText``,
  ``ST_Distance``, ``ST_Contains``

Because the native GEOMETRY type is available we store it directly, and we
*also* store the WKT string and the H3 hex strings. That redundancy is
deliberate: a Databricks App talking to the warehouse over the SQL connector
gets a string it can hand straight to a map layer without needing a client-side
geometry codec. If a future runtime lacked ST_*, dropping the `geom` column
alone would degrade this table gracefully.
"""

from pyspark import pipelines as dp
from pyspark.sql import functions as F

from caltrans_traffic import config as C


@dp.materialized_view(
    name="silver_stations_geo",
    comment=(
        "Cleaned station dimension enriched with H3 cell ids at res 7/8/9 "
        "(BIGINT + hex string), native GEOMETRY(4326) point, and WKT. "
        "Also carries baseline_capacity_vph for the what-if engine."
    ),
    cluster_by=["freeway", "direction"],
    table_properties={
        "delta.autoOptimize.optimizeWrite": "true",
        "delta.enableRowTracking": "true",
    },
)
@dp.expect_or_fail("station_id_not_null", "station_id IS NOT NULL")
@dp.expect_or_drop("lat_in_california", "latitude BETWEEN 32.50 AND 42.05")
@dp.expect_or_drop("lon_in_california", "longitude BETWEEN -124.50 AND -114.10")
@dp.expect_or_drop("h3_res8_not_null", "h3_r8 IS NOT NULL")
@dp.expect_or_drop("geom_not_null", "geom IS NOT NULL")
@dp.expect_or_drop("baseline_capacity_positive", "baseline_capacity_vph > 0")
@dp.expect("geom_srid_4326", "ST_SRID(geom) = 4326")
def silver_stations_geo():
    df = spark.read.table("bronze_stations")

    for res in C.H3_RESOLUTIONS:
        df = df.withColumn(
            f"h3_r{res}", F.expr(f"h3_longlatash3(longitude, latitude, {res})")
        ).withColumn(
            f"h3_r{res}_str", F.expr(f"h3_h3tostring(h3_longlatash3(longitude, latitude, {res}))")
        )

    return (
        df
        # Native geometry, verified to survive the Delta round-trip.
        .withColumn("geom", F.expr(f"ST_Point(longitude, latitude, {C.SRID})"))
        # String forms for map clients that cannot decode binary geometry.
        .withColumn("geom_wkt", F.expr(f"ST_AsText(ST_Point(longitude, latitude, {C.SRID}))"))
        .withColumn("h3_r8_boundary_wkt", F.expr("h3_boundaryaswkt(h3_r8)"))
        # The field the what-if engine perturbs: total station capacity at
        # full lane availability. Scenarios scale this to model lane closures,
        # added lanes, or metering changes.
        .withColumn(
            "baseline_capacity_vph",
            F.expr("cast(num_lanes * lane_capacity_vph as double)"),
        )
        .withColumn("baseline_lanes", F.col("num_lanes"))
        .withColumn("baseline_lane_capacity_vph", F.col("lane_capacity_vph"))
        .select(
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
            "num_lanes",
            "lane_capacity_vph",
            "station_type",
            "urban_intensity",
            "detector_health",
            "h3_r7",
            "h3_r7_str",
            "h3_r8",
            "h3_r8_str",
            "h3_r9",
            "h3_r9_str",
            "h3_r8_boundary_wkt",
            "geom",
            "geom_wkt",
            "baseline_capacity_vph",
            "baseline_lanes",
            "baseline_lane_capacity_vph",
        )
    )
