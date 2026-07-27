"""Unit tests for corridor geometry and station placement.

The headline assertion is geographic: every generated station must fall inside
California and on the right corridor, because the app's credibility rests on
the map looking genuinely Californian.
"""

from __future__ import annotations

import pytest
from caltrans_traffic import config as C
from caltrans_traffic.corridors import (
    CORRIDORS,
    corridor_length_mi,
    corridor_summary,
    haversine_mi,
    interpolate,
)
from caltrans_traffic.stations import (
    STATION_COLUMNS,
    STATION_SCHEMA,
    build_stations,
    stations_values_sql,
)

REQUIRED_FREEWAYS = {
    "I-5",
    "I-405",
    "I-10",
    "US-101",
    "I-80",
    "I-880",
    "I-210",
    "SR-99",
    "I-15",
    "I-680",
}


@pytest.fixture(scope="module")
def stations():
    return build_stations()


# ---------------------------------------------------------------------------
# Corridor geometry
# ---------------------------------------------------------------------------


def test_all_required_corridors_are_present():
    assert {c.freeway for c in CORRIDORS} == REQUIRED_FREEWAYS


def test_every_corridor_vertex_is_inside_california():
    for corridor in CORRIDORS:
        for v in corridor.vertices:
            assert C.CA_MIN_LAT <= v.lat <= C.CA_MAX_LAT, f"{corridor.freeway} {v}"
            assert C.CA_MIN_LON <= v.lon <= C.CA_MAX_LON, f"{corridor.freeway} {v}"


def test_corridor_districts_are_valid_caltrans_districts():
    for corridor in CORRIDORS:
        for v in corridor.vertices:
            assert 1 <= v.district <= 12


def test_corridor_urban_intensity_is_a_fraction():
    for corridor in CORRIDORS:
        for v in corridor.vertices:
            assert 0.0 <= v.urban <= 1.0


def test_corridor_lengths_are_plausible():
    """Sanity-check traced polylines against real route lengths."""
    lengths = {c["freeway"]: c["length_mi"] for c in corridor_summary()}
    # I-5 runs ~796 mi in California; our traced polyline should be close.
    assert 650 <= lengths["I-5"] <= 850
    # I-405 is ~72 mi.
    assert 45 <= lengths["I-405"] <= 90
    # I-880 is ~46 mi.
    assert 30 <= lengths["I-880"] <= 60
    # I-210 is ~85 mi.
    assert 55 <= lengths["I-210"] <= 100


def test_consecutive_vertices_have_no_implausible_jumps():
    """Guards against a transcription typo teleporting a corridor."""
    for corridor in CORRIDORS:
        for a, b in zip(corridor.vertices, corridor.vertices[1:]):
            assert haversine_mi(a.lat, a.lon, b.lat, b.lon) < 80.0, (
                f"{corridor.freeway}: suspicious gap {a.city} -> {b.city}"
            )


def test_north_south_corridors_are_ordered_south_to_north():
    for corridor in CORRIDORS:
        if "N" in corridor.directions:
            first, last = corridor.vertices[0], corridor.vertices[-1]
            assert last.lat > first.lat, f"{corridor.freeway} not ordered S->N"


def test_east_west_corridors_are_ordered_west_to_east():
    for corridor in CORRIDORS:
        if "E" in corridor.directions:
            first, last = corridor.vertices[0], corridor.vertices[-1]
            assert last.lon > first.lon, f"{corridor.freeway} not ordered W->E"


def test_interpolation_endpoints_match_the_polyline():
    for corridor in CORRIDORS:
        lat, lon, _ = interpolate(corridor, 0.0)
        assert (lat, lon) == pytest.approx(
            (corridor.vertices[0].lat, corridor.vertices[0].lon)
        )


def test_interpolation_midpoint_lies_within_the_corridor_bbox():
    for corridor in CORRIDORS:
        half = corridor_length_mi(corridor) / 2.0
        lat, lon, _ = interpolate(corridor, half)
        lats = [v.lat for v in corridor.vertices]
        lons = [v.lon for v in corridor.vertices]
        assert min(lats) <= lat <= max(lats)
        assert min(lons) <= lon <= max(lons)


def test_interpolation_past_the_end_clamps():
    corridor = CORRIDORS[0]
    beyond = corridor_length_mi(corridor) + 500
    lat, lon, _ = interpolate(corridor, beyond)
    assert (lat, lon) == pytest.approx(
        (corridor.vertices[-1].lat, corridor.vertices[-1].lon)
    )


def test_haversine_against_a_known_distance():
    """LA City Hall to Sacramento Capitol is ~360 miles."""
    d = haversine_mi(34.0537, -118.2428, 38.5767, -121.4934)
    assert 340 <= d <= 385


# ---------------------------------------------------------------------------
# Station population
# ---------------------------------------------------------------------------


def test_station_count_is_in_the_requested_range(stations):
    assert 2000 <= len(stations) <= 5000, f"got {len(stations)}"


def test_station_ids_are_unique(stations):
    ids = [s["station_id"] for s in stations]
    assert len(ids) == len(set(ids))


def test_every_station_is_inside_california(stations):
    for s in stations:
        assert C.CA_MIN_LAT <= s["latitude"] <= C.CA_MAX_LAT, s
        assert C.CA_MIN_LON <= s["longitude"] <= C.CA_MAX_LON, s


def test_all_corridors_and_both_directions_are_populated(stations):
    by_freeway = {}
    for s in stations:
        by_freeway.setdefault(s["freeway"], set()).add(s["direction"])
    assert set(by_freeway) == REQUIRED_FREEWAYS
    for freeway, directions in by_freeway.items():
        assert len(directions) == 2, f"{freeway} has directions {directions}"


def test_directions_are_valid(stations):
    assert {s["direction"] for s in stations} <= {"N", "S", "E", "W"}


def test_districts_are_valid_caltrans_districts(stations):
    assert all(1 <= s["district"] <= 12 for s in stations)


def test_lane_counts_and_capacities_are_sane(stations):
    for s in stations:
        assert 1 <= s["num_lanes"] <= 8, s
        assert 1900 <= s["lane_capacity_vph"] <= 2200, s


def test_station_types_are_valid_pems_codes(stations):
    assert {s["station_type"] for s in stations} <= {"ML", "HV", "OR", "FR"}


def test_mainline_stations_are_the_majority(stations):
    ml = sum(1 for s in stations if s["station_type"] == "ML")
    assert ml / len(stations) > 0.6


def test_postmiles_increase_along_each_corridor(stations):
    groups = {}
    for s in stations:
        groups.setdefault((s["freeway"], s["direction"]), []).append(s["postmile"])
    for key, postmiles in groups.items():
        assert postmiles == sorted(postmiles), f"{key} postmiles out of order"
        assert postmiles[0] >= 0


def test_urban_corridors_are_sampled_more_densely_than_rural_ones():
    """I-405 through LA should have far tighter detector spacing than rural I-5."""
    stations = build_stations()
    per_mile = {}
    for corridor in CORRIDORS:
        count = sum(
            1 for s in stations if s["freeway"] == corridor.freeway
        ) / 2  # two directions
        per_mile[corridor.freeway] = count / corridor_length_mi(corridor)
    assert per_mile["I-405"] > per_mile["I-5"]
    assert per_mile["I-880"] > per_mile["I-15"]


def test_opposing_directions_do_not_share_exact_coordinates(stations):
    """Carriageways are offset so a map does not stack them into one pin."""
    coords = {}
    for s in stations:
        coords.setdefault((s["freeway"], round(s["postmile"], 1)), set()).add(
            (s["latitude"], s["longitude"])
        )
    stacked = [k for k, v in coords.items() if len(v) < 2]
    # Allow a few coincidences from postmile rounding, but not systemic overlap.
    assert len(stacked) < 0.10 * len(coords)


def test_detector_health_mix_matches_configuration(stations):
    total = len(stations)
    dark = sum(1 for s in stations if s["detector_health"] == "dark")
    degraded = sum(1 for s in stations if s["detector_health"] == "degraded")
    assert 0 < dark / total < 3 * C.DARK_STATION_FRACTION
    assert 0 < degraded / total < 3 * C.DEGRADED_STATION_FRACTION


def test_generation_is_deterministic():
    """Two runs must agree exactly - the app's saved scenarios depend on it."""
    assert build_stations() == build_stations()


def test_urban_stations_have_more_lanes_than_rural_ones(stations):
    urban = [s["num_lanes"] for s in stations if s["urban_intensity"] > 0.85]
    rural = [s["num_lanes"] for s in stations if s["urban_intensity"] < 0.20]
    assert urban and rural
    assert sum(urban) / len(urban) > sum(rural) / len(rural)


def test_expected_marquee_cities_appear(stations):
    """Spot-check that the corridors run through the cities they should."""
    cities = {s["city"] for s in stations}
    for city in ("Los Angeles", "San Francisco", "San Diego", "Sacramento", "Fresno"):
        assert city in cities, f"missing {city}"


# ---------------------------------------------------------------------------
# The SQL VALUES rendering used by the bronze transformation
# ---------------------------------------------------------------------------


def test_values_sql_declares_every_column_in_schema_order():
    sql = stations_values_sql()
    names = [name for name, _ in STATION_COLUMNS]
    assert sql.startswith("SELECT ")
    for name, dtype in STATION_COLUMNS:
        assert f"CAST({name} AS {dtype}) AS {name}" in sql
    assert f"AS t({', '.join(names)})" in sql


def test_values_sql_emits_one_tuple_per_station(stations):
    sql = stations_values_sql()
    # Every data tuple sits on its own line and starts with the quoted id.
    tuple_lines = [ln for ln in sql.splitlines() if ln.startswith("('")]
    assert len(tuple_lines) == len(stations)


def test_values_sql_escapes_single_quotes():
    """A city like "O'Neals" must not break out of its string literal."""
    from caltrans_traffic.stations import _sql_literal

    assert _sql_literal("O'Neals") == "'O''Neals'"
    assert _sql_literal(42) == "42"
    assert _sql_literal(1.5) == "1.5"


def test_values_sql_has_balanced_quotes():
    """An odd number of quotes anywhere means a malformed literal."""
    assert stations_values_sql().count("'") % 2 == 0


def test_station_schema_matches_column_declaration():
    assert STATION_SCHEMA == ", ".join(f"{n} {t}" for n, t in STATION_COLUMNS)


def test_station_rows_expose_every_required_column(stations):
    required = {
        "station_id",
        "freeway",
        "direction",
        "district",
        "county",
        "city",
        "postmile",
        "latitude",
        "longitude",
        "num_lanes",
        "lane_capacity_vph",
        "station_type",
        "abs_pm",
    }
    assert required <= set(stations[0])
