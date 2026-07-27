"""Unit tests for the traffic generation model.

These run off-cluster with no Spark. They cover the properties the generated
data must have for the app to be believable: two commute peaks in the right
place, commute asymmetry between directions, a monotonically degrading
speed-flow curve, self-consistent occupancy, and correct LOS banding.
"""

from __future__ import annotations

import math
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest
from caltrans_traffic import config as C
from caltrans_traffic import traffic_model as M

# ---------------------------------------------------------------------------
# Diurnal demand profile
# ---------------------------------------------------------------------------


def _peak_hour(direction: str, weekend: bool, lo: float, hi: float) -> float:
    """Clock hour maximising demand within [lo, hi), at 1-minute resolution."""
    samples = [(m / 60.0) for m in range(int(lo * 60), int(hi * 60))]
    return max(samples, key=lambda h: M.demand_factor(h, weekend, direction))


def test_weekday_has_two_distinct_commute_peaks():
    am = _peak_hour("N", False, 4.0, 12.0)
    pm = _peak_hour("N", False, 12.0, 22.0)
    assert 7.0 <= am <= 9.0, f"AM peak at {am}, expected 7-9am"
    assert 16.0 <= pm <= 19.0, f"PM peak at {pm}, expected 4-7pm"


def test_commute_peaks_are_pacific_local_not_utc():
    tz = ZoneInfo(C.LOCAL_TIMEZONE)
    sim_start = datetime.fromisoformat(C.SIM_START).replace(tzinfo=tz)
    am_peak_local = sim_start + timedelta(hours=C.AM_MU)
    pm_peak_local = sim_start + timedelta(hours=C.PM_MU)

    assert 7 <= am_peak_local.hour <= 9
    assert 16 <= pm_peak_local.hour <= 19
    assert am_peak_local.astimezone(ZoneInfo("UTC")).hour not in range(7, 10)
    assert pm_peak_local.astimezone(ZoneInfo("UTC")).hour not in range(16, 20)


def test_midday_is_a_trough_between_the_peaks():
    """A real commute profile dips between peaks - it is not one wide plateau."""
    am = M.demand_factor(C.AM_MU, False, "N")
    pm = M.demand_factor(C.PM_MU, False, "N")
    midday = M.demand_factor(12.0, False, "N")
    assert midday < 0.6 * am
    assert midday < 0.6 * pm


def test_overnight_demand_is_near_base_load():
    for hour in (0.0, 2.0, 3.0):
        assert M.demand_factor(hour, False, "N") == pytest.approx(C.WD_BASE, abs=0.02)


def test_commute_asymmetry_flips_between_am_and_pm():
    """Inbound is busier in the morning, outbound in the evening."""
    am_in = M.demand_factor(C.AM_MU, False, "N")
    am_out = M.demand_factor(C.AM_MU, False, "S")
    pm_in = M.demand_factor(C.PM_MU, False, "N")
    pm_out = M.demand_factor(C.PM_MU, False, "S")

    assert am_in > am_out, "northbound should dominate the AM peak"
    assert pm_out > pm_in, "southbound should dominate the PM peak"
    # And the asymmetry must be visible, not a rounding artefact.
    assert am_in / am_out > 1.15
    assert pm_out / pm_in > 1.15


def test_east_west_directions_share_the_inbound_orientation():
    assert M.direction_weights("E") == M.direction_weights("N")
    assert M.direction_weights("W") == M.direction_weights("S")


def test_weekend_profile_is_a_single_midday_bump():
    peak = _peak_hour("N", True, 0.0, 24.0)
    assert 11.0 <= peak <= 16.0, f"weekend peak at {peak}, expected midday"
    # No sharp commute spike at 8am on a Saturday.
    assert M.demand_factor(8.0, True, "N") < M.demand_factor(8.0, False, "N")


def test_weekend_peak_is_lower_than_weekday_peak():
    assert M.demand_factor(C.WE_MU, True, "N") < M.demand_factor(C.PM_MU, False, "S")


def test_dow_scale_makes_friday_busiest_and_sunday_lightest():
    scales = {d: M.dow_scale(d) for d in range(1, 8)}
    assert max(scales, key=scales.get) == 6, "Friday should be the heaviest"
    assert min(scales, key=scales.get) == 1, "Sunday should be the lightest"


def test_is_weekend_matches_spark_dayofweek_convention():
    # Spark: 1=Sunday .. 7=Saturday
    assert M.is_weekend(1) and M.is_weekend(7)
    assert not any(M.is_weekend(d) for d in (2, 3, 4, 5, 6))


# ---------------------------------------------------------------------------
# Speed-flow relationship
# ---------------------------------------------------------------------------


def test_free_flow_speed_at_zero_demand():
    assert M.bpr_speed(65.0, 0.0) == pytest.approx(65.0)


def test_speed_decreases_monotonically_with_vc_ratio():
    speeds = [M.bpr_speed(65.0, vc / 10.0) for vc in range(0, 26)]
    assert all(b <= a for a, b in zip(speeds, speeds[1:])), "BPR must be monotone"


def test_speed_at_capacity_is_a_plausible_freeway_breakdown():
    """At v/c == 1 a freeway is congested but still moving, ~35-50 mph."""
    assert 35.0 <= M.bpr_speed(65.0, 1.0) <= 50.0


def test_oversaturation_collapses_to_stop_and_go_speeds():
    assert 15.0 <= M.bpr_speed(65.0, 1.4) <= 30.0
    # Textbook BPR (0.15, 4.0) would predict ~50 mph here, which is why we
    # deliberately use steeper coefficients.
    textbook = 65.0 / (1 + 0.15 * 1.4**4.0)
    assert M.bpr_speed(65.0, 1.4) < textbook


def test_speed_never_drops_below_the_creep_floor():
    assert M.bpr_speed(65.0, 99.0) == pytest.approx(C.MIN_SPEED_MPH)


def test_light_demand_barely_reduces_speed():
    """Below LOS C a driver should not notice much slowing."""
    assert M.bpr_speed(65.0, 0.3) > 63.0


def test_free_flow_speed_is_higher_in_rural_areas():
    assert M.free_flow_speed(0.0) > M.free_flow_speed(1.0)
    assert M.free_flow_speed(0.0) == pytest.approx(C.FREE_FLOW_RURAL)


def test_station_type_scale_applies_once_to_capacity_and_demand():
    demand_factor = 0.8
    lanes = 2
    lane_capacity = 2000

    for station_type, type_scale in C.STATION_TYPE_SCALE.items():
        base_capacity = lanes * lane_capacity * M.station_type_scale(station_type)
        demanded_flow = round(demand_factor * base_capacity)

        assert M.station_type_scale(station_type) == pytest.approx(type_scale)
        assert demanded_flow == round(demand_factor * lanes * lane_capacity * type_scale)
        if station_type != "ML":
            assert demanded_flow != round(demand_factor * base_capacity * type_scale)


def test_demand_and_served_flow_are_separate_under_oversaturation():
    effective_capacity = 4000.0
    demanded_flow = 5600
    served_flow = min(demanded_flow, math.floor(effective_capacity))
    demand_vc_ratio = demanded_flow / effective_capacity
    served_vc_ratio = served_flow / effective_capacity

    assert demanded_flow > served_flow
    assert demand_vc_ratio == pytest.approx(1.4)
    assert served_vc_ratio == pytest.approx(1.0)
    assert M.level_of_service(demand_vc_ratio) == "F"
    assert M.free_flow_speed(1.0) == pytest.approx(C.FREE_FLOW_URBAN)


def test_urban_corridors_are_driven_harder_than_rural_ones():
    assert M.demand_scale(1.0) > 1.0, "dense urban peaks must exceed capacity"
    assert M.demand_scale(0.0) < 1.0, "rural corridors should stay free-flowing"


def test_lane_capacity_is_in_the_hcm_range():
    for u in (0.0, 0.5, 1.0):
        assert 1900 <= M.lane_capacity_vph(u) <= 2200


# ---------------------------------------------------------------------------
# Occupancy consistency
# ---------------------------------------------------------------------------


def test_occupancy_rises_as_speed_falls_at_constant_flow():
    free = M.occupancy_from_flow(6000, 65.0, 4)
    jammed = M.occupancy_from_flow(6000, 20.0, 4)
    assert jammed > free


def test_occupancy_matches_the_density_formula():
    """occupancy = (flow / lanes / speed) * effective_length / 5280."""
    flow, speed, lanes = 6000.0, 60.0, 4
    expected = (flow / lanes / speed) * C.EFFECTIVE_VEHICLE_LENGTH_FT / C.FEET_PER_MILE
    assert M.occupancy_from_flow(flow, speed, lanes) == pytest.approx(expected)


def test_occupancy_stays_a_fraction():
    for flow in (0, 500, 5000, 50000):
        for speed in (1.0, 25.0, 70.0):
            occ = M.occupancy_from_flow(flow, speed, 4)
            assert 0.0 <= occ <= 1.0


def test_free_flow_occupancy_is_realistically_low():
    """A quiet freeway lane sits in the low single-digit percents."""
    assert 0.0 < M.occupancy_from_flow(2000, 65.0, 4) < 0.05


def test_occupancy_handles_degenerate_input():
    assert M.occupancy_from_flow(1000, 0.0, 4) == C.MIN_OCCUPANCY
    assert M.occupancy_from_flow(1000, 60.0, 0) == C.MIN_OCCUPANCY


# ---------------------------------------------------------------------------
# Level of service and delay
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "vc,expected",
    [
        (0.0, "A"),
        (0.20, "A"),
        (0.45, "B"),
        (0.65, "C"),
        (0.85, "D"),
        (0.96, "E"),
        (1.00, "F"),
        (1.50, "F"),
    ],
)
def test_level_of_service_banding(vc, expected):
    assert M.level_of_service(vc) == expected


def test_level_of_service_is_monotone_in_vc():
    grades = [M.level_of_service(vc / 100.0) for vc in range(0, 200)]
    order = {g: i for i, g in enumerate("ABCDEF")}
    ranks = [order[g] for g in grades]
    assert all(b >= a for a, b in zip(ranks, ranks[1:]))


def test_delay_is_zero_at_free_flow_and_positive_when_slow():
    assert M.delay_vs_freeflow_min_per_mi(65.0, 65.0) == pytest.approx(0.0)
    assert M.delay_vs_freeflow_min_per_mi(30.0, 65.0) > 0


def test_delay_matches_travel_time_difference():
    """20 mph vs 60 mph free-flow = 3 min/mi vs 1 min/mi = 2 min/mi of delay."""
    assert M.delay_vs_freeflow_min_per_mi(20.0, 60.0) == pytest.approx(2.0)


def test_congestion_flag_trips_below_the_speed_ratio():
    ff = 65.0
    assert not M.is_congested(0.95 * ff, ff)
    assert M.is_congested(0.50 * ff, ff)
    # Exactly at the threshold is not congested (strict inequality).
    assert not M.is_congested(C.CONGESTION_SPEED_RATIO * ff, ff)


# ---------------------------------------------------------------------------
# Incident capacity impact
# ---------------------------------------------------------------------------


def test_no_blockage_still_loses_capacity_to_rubbernecking():
    factor = M.incident_capacity_factor(4, 0)
    assert factor == pytest.approx(1.0 - C.RUBBERNECK_CAPACITY_LOSS)
    assert factor < 1.0


def test_capacity_falls_as_more_lanes_are_blocked():
    factors = [M.incident_capacity_factor(4, b) for b in range(0, 5)]
    assert all(b <= a for a, b in zip(factors, factors[1:]))


def test_one_of_four_lanes_blocked_matches_hand_calculation():
    assert M.incident_capacity_factor(4, 1) == pytest.approx(0.75 * 0.88)


def test_capacity_factor_never_reaches_zero():
    """Even a full blockage leaves a residual so v/c stays finite."""
    assert M.incident_capacity_factor(4, 4) > 0.0
    assert M.incident_capacity_factor(2, 99) > 0.0


def test_incident_pushes_a_busy_corridor_into_breakdown():
    """The whole point: an incident must visibly collapse speed at peak."""
    ff, base_capacity, demand = 65.0, 8000.0, 6000.0
    before = M.bpr_speed(ff, demand / base_capacity)
    after = M.bpr_speed(ff, demand / (base_capacity * M.incident_capacity_factor(4, 2)))
    assert before > 55.0, "should be flowing before the incident"
    assert after < 25.0, "should be crawling during the incident"


# ---------------------------------------------------------------------------
# Determinism of the pseudo-random expression builders
# ---------------------------------------------------------------------------


def test_random_expressions_are_deterministic_and_seeded():
    a = M.uniform_expr("station_id", "interval_idx", salt="dem")
    b = M.uniform_expr("station_id", "interval_idx", salt="dem")
    assert a == b, "same inputs must build the same expression"
    assert str(C.SEED) in a, "seed must be mixed in for reproducibility"
    assert "rand(" not in a, "must not use non-deterministic rand()"


def test_different_salts_produce_different_expressions():
    assert M.uniform_expr("k", salt="one") != M.uniform_expr("k", salt="two")


def test_normal_and_lognormal_expressions_are_wellformed():
    assert "rand(" not in M.normal_expr("k", salt="s")
    ln = M.lognormal_multiplier_expr("k", sigma=0.08, salt="s")
    assert ln.startswith("exp(") and "0.08" in ln


# ---------------------------------------------------------------------------
# Python reference vs Spark SQL builders
# ---------------------------------------------------------------------------
# The builders emit Spark SQL, so we cannot execute them here. Instead we
# translate the handful of SQL constructs they use into Python and evaluate,
# which catches drift between the tested math and the shipped math.

_SQL_TO_PY = {
    "exp(": "math.exp(",
    "pow(": "math.pow(",
    "sqrt(": "math.sqrt(",
    "ln(": "math.log(",
    "cos(": "math.cos(",
    "pi()": "math.pi",
    "least(": "min(",
    "greatest(": "max(",
}


def _coalesce(*args):
    """Spark's coalesce(): first non-null argument."""
    return next((a for a in args if a is not None), None)


def _eval_sql(expr: str, **bindings) -> float:
    """Evaluate a simple arithmetic Spark SQL expression in Python."""
    py = expr
    for sql, replacement in _SQL_TO_PY.items():
        py = py.replace(sql, replacement)
    namespace = {"math": math, "min": min, "max": max, "coalesce": _coalesce}
    return eval(py, namespace, bindings)  # noqa: S307


@pytest.mark.parametrize("urban", [0.0, 0.25, 0.6, 1.0])
def test_free_flow_expr_matches_python(urban):
    sql = M.free_flow_speed_expr("urban_intensity")
    assert _eval_sql(sql, urban_intensity=urban) == pytest.approx(
        M.free_flow_speed(urban)
    )


@pytest.mark.parametrize("urban", [0.0, 0.3, 0.75, 1.0])
def test_demand_scale_expr_matches_python(urban):
    sql = M.demand_scale_expr("urban_intensity")
    assert _eval_sql(sql, urban_intensity=urban) == pytest.approx(M.demand_scale(urban))


@pytest.mark.parametrize("vc", [0.0, 0.4, 0.9, 1.0, 1.3, 2.0])
def test_bpr_speed_expr_matches_python(vc):
    sql = M.bpr_speed_expr("ff", "vc")
    assert _eval_sql(sql, ff=65.0, vc=vc) == pytest.approx(M.bpr_speed(65.0, vc))


@pytest.mark.parametrize(
    "flow,speed,lanes", [(0, 65.0, 4), (4000, 60.0, 4), (9000, 22.0, 5)]
)
def test_occupancy_expr_matches_python(flow, speed, lanes):
    sql = M.occupancy_from_flow_expr("flow", "speed", "lanes")
    assert _eval_sql(sql, flow=flow, speed=speed, lanes=lanes) == pytest.approx(
        M.occupancy_from_flow(flow, speed, lanes)
    )


@pytest.mark.parametrize("speed", [65.0, 40.0, 12.0])
def test_delay_expr_matches_python(speed):
    sql = M.delay_vs_freeflow_expr("speed", "ff")
    assert _eval_sql(sql, speed=speed, ff=65.0) == pytest.approx(
        M.delay_vs_freeflow_min_per_mi(speed, 65.0)
    )


@pytest.mark.parametrize("lanes,blocked", [(4, 0), (4, 1), (5, 3), (2, 2)])
def test_incident_capacity_expr_matches_python(lanes, blocked):
    sql = M.incident_capacity_factor_expr("lanes", "blocked")
    assert _eval_sql(sql, lanes=lanes, blocked=blocked) == pytest.approx(
        M.incident_capacity_factor(lanes, blocked)
    )


def test_los_expr_covers_every_grade():
    sql = M.level_of_service_expr("vc_ratio")
    for grade in "ABCDEF":
        assert f"'{grade}'" in sql


def test_dow_scale_expr_lists_every_day():
    sql = M.dow_scale_expr("dow")
    for day, scale in C.DOW_SCALE.items():
        assert f"WHEN {day} THEN {scale}" in sql


def test_station_type_scale_expr_lists_every_type():
    sql = M.station_type_scale_expr("station_type")
    for station_type, scale in C.STATION_TYPE_SCALE.items():
        assert f"WHEN '{station_type}' THEN {scale}" in sql


def test_pipeline_sql_uses_local_time_and_carries_latent_demand():
    root = Path(__file__).resolve().parents[1]
    bronze = (
        root / "pipelines/synthetic_traffic/transformations/bronze_station_readings.py"
    ).read_text()
    silver = (
        root / "pipelines/synthetic_traffic/transformations/silver_readings_enriched.py"
    ).read_text()

    assert "to_utc_timestamp(\"local_ts\"" in bronze
    assert "hour(local_ts) + minute(local_ts) / 60.0" in bronze
    assert "demand_factor * base_capacity_vph" in bronze
    assert "demand_factor * base_capacity_vph * type_scale" not in bronze
    assert '"demanded_flow_vph"' in bronze
    assert "demanded_flow_vph / greatest(1.0, effective_capacity_vph)" in silver
    assert "total_flow_vph / greatest(1.0, effective_capacity_vph)" in silver


# ---------------------------------------------------------------------------
# Incident window / reading clock alignment
# ---------------------------------------------------------------------------
# bronze_incidents picks its start hour in LOCAL commute hours and
# bronze_station_readings stores ts as a UTC instant. Both must convert through
# the same timezone or the incident join silently misses by the Pacific offset.


def _reading_instant(interval_idx: int) -> datetime:
    """UTC instant of a reading, mirroring bronze_station_readings."""
    tz = ZoneInfo(C.LOCAL_TIMEZONE)
    local = datetime.fromisoformat(C.SIM_START).replace(tzinfo=tz) + timedelta(
        minutes=interval_idx * C.INTERVAL_MINUTES
    )
    return local.astimezone(ZoneInfo("UTC"))


def _incident_window(
    day_offset: int, start_hour: float, duration_min: int, *, to_utc: bool
) -> tuple[datetime, datetime]:
    """(start, end) of an incident window, mirroring bronze_incidents.

    ``to_utc=False`` reproduces the pre-fix behaviour, where the naive local
    wall clock was persisted as if it were already a UTC instant.
    """
    tz = ZoneInfo(C.LOCAL_TIMEZONE)
    naive = datetime.fromisoformat(C.SIM_START) + timedelta(days=day_offset)
    # Snap to the 5-minute detector grid exactly as the SQL does.
    minutes = math.floor((start_hour - math.floor(start_hour)) * 12) * 5
    naive += timedelta(hours=math.floor(start_hour), minutes=minutes)
    start = naive.replace(tzinfo=ZoneInfo("UTC") if not to_utc else tz)
    start = start.astimezone(ZoneInfo("UTC"))
    return start, start + timedelta(minutes=duration_min)


def test_incident_window_covers_the_reading_at_its_local_hour():
    """An 8:00am local incident must hit the 8:00am local reading."""
    day_offset, local_hour, duration_min = 1, 8.0, 30
    # 8:00am local on day 1 == interval 1 * 288 + 8 * 12.
    interval_idx = (day_offset * C.INTERVALS_PER_DAY) + int(local_hour * 12)
    reading_ts = _reading_instant(interval_idx)

    # Sanity: the reading really is at 8am Pacific.
    assert reading_ts.astimezone(ZoneInfo(C.LOCAL_TIMEZONE)).hour == 8

    start, end = _incident_window(day_offset, local_hour, duration_min, to_utc=True)
    assert start <= reading_ts < end, (
        f"incident window {start}..{end} misses reading at {reading_ts}"
    )
    assert start.astimezone(ZoneInfo(C.LOCAL_TIMEZONE)).hour == 8


def test_naive_incident_window_would_miss_the_reading():
    """Regression guard: the pre-fix naive-local window is off by the PDT offset."""
    day_offset, local_hour, duration_min = 1, 8.0, 30
    interval_idx = (day_offset * C.INTERVALS_PER_DAY) + int(local_hour * 12)
    reading_ts = _reading_instant(interval_idx)

    start, end = _incident_window(day_offset, local_hour, duration_min, to_utc=False)
    assert not (start <= reading_ts < end), (
        "naive-local incident window unexpectedly matched; the regression test "
        "no longer reproduces the bug it guards against"
    )
    # It lands 7 hours early in PDT, i.e. at 1am Pacific instead of 8am.
    assert start.astimezone(ZoneInfo(C.LOCAL_TIMEZONE)).hour == 1


@pytest.mark.parametrize("local_hour", [0.0, 6.5, 8.25, 15.5, 18.75, 23.0])
def test_incident_windows_align_at_every_local_hour(local_hour):
    """Every incident start hour the generator can draw must find its reading."""
    day_offset, duration_min = 3, 15
    interval_idx = (day_offset * C.INTERVALS_PER_DAY) + int(local_hour * 12)
    reading_ts = _reading_instant(interval_idx)

    start, end = _incident_window(day_offset, local_hour, duration_min, to_utc=True)
    assert start <= reading_ts < end
    assert start.astimezone(ZoneInfo(C.LOCAL_TIMEZONE)).hour == int(local_hour)


def test_bronze_incidents_converts_its_local_clock_to_utc():
    """The transformation itself must do the conversion, not just the model."""
    root = Path(__file__).resolve().parents[1]
    incidents = (
        root / "pipelines/synthetic_traffic/transformations/bronze_incidents.py"
    ).read_text()

    assert 'to_utc_timestamp("_local_start_ts"' in incidents
    # end_ts is derived from the converted start_ts, so it inherits the fix.
    assert 'timestampadd(MINUTE, duration_min, start_ts)' in incidents
    # The naive literal must not be assigned straight to start_ts any more.
    assert 'F.col("start_ts")' not in incidents.split("def bronze_incidents")[0]
