"""The traffic generation model: demand profile, BPR speed-flow, LOS.

This module holds each piece of the model **twice**:

* a pure-Python reference implementation (``demand_factor``, ``bpr_speed``,
  ``occupancy_from_flow``, ``level_of_service``, ...) that the unit tests
  exercise directly, and
* a Spark SQL expression builder (``*_expr``) that the SDP transformations
  compose into their queries.

Both read their constants from :mod:`caltrans_traffic.config`, and
``tests/test_traffic_model.py`` asserts the two agree numerically. This is the
mechanism that keeps the documented math, the tested math and the math that
actually runs on the cluster identical.
"""

from __future__ import annotations

import math

from . import config as C

# ---------------------------------------------------------------------------
# 1. Diurnal demand profile
# ---------------------------------------------------------------------------


def _gauss(x: float, mu: float, sigma: float) -> float:
    """Unit-height Gaussian bump (peaks at 1.0 when x == mu)."""
    return math.exp(-(((x - mu) / sigma) ** 2) / 2.0)


def demand_factor(
    hour_of_day: float,
    is_weekend: bool,
    direction: str,
) -> float:
    """Normalised demand in roughly 0..1 for a given clock hour.

    Weekdays are a flat base load plus two Gaussian commute peaks::

        d = base + am_amp * w_am * N(h; 7.75, 1.15)
                 + pm_amp * w_pm * N(h; 17.25, 1.45)

    Weekends collapse to a single broad midday bump::

        d = base + amp * N(h; 13.5, 3.40)

    ``w_am``/``w_pm`` encode commute asymmetry: an inbound direction carries
    1.25x the morning peak and 0.85x the evening peak, and vice-versa. So the
    same corridor is busy northbound at 8am and southbound at 5pm, which is
    what makes an animated map read as a real commute rather than a pulse.
    """
    if is_weekend:
        return C.WE_BASE + C.WE_AMP * _gauss(hour_of_day, C.WE_MU, C.WE_SIGMA)

    w_am, w_pm = direction_weights(direction)
    return (
        C.WD_BASE
        + C.AM_AMP * w_am * _gauss(hour_of_day, C.AM_MU, C.AM_SIGMA)
        + C.PM_AMP * w_pm * _gauss(hour_of_day, C.PM_MU, C.PM_SIGMA)
    )


def direction_weights(direction: str) -> tuple[float, float]:
    """(am_weight, pm_weight) for a direction of travel.

    ASSUMPTION: we treat N and E as the "inbound" (toward-the-job-centre)
    orientation statewide. That is true for many real California commutes
    (northbound I-405 into West LA, eastbound I-80 into Sacramento) but it is
    a simplification - real inbound direction depends on where the employment
    centre sits relative to each individual detector. Documented in the README.
    """
    if direction in C.INBOUND_DIRECTIONS:
        return C.AM_WEIGHT_INBOUND, C.PM_WEIGHT_INBOUND
    return C.AM_WEIGHT_OUTBOUND, C.PM_WEIGHT_OUTBOUND


def demand_factor_expr(hour_expr: str, weekend_expr: str, direction_expr: str) -> str:
    """Spark SQL mirroring :func:`demand_factor`."""
    am_w = (
        f"CASE WHEN {direction_expr} IN "
        f"({', '.join(repr(d) for d in C.INBOUND_DIRECTIONS)}) "
        f"THEN {C.AM_WEIGHT_INBOUND} ELSE {C.AM_WEIGHT_OUTBOUND} END"
    )
    pm_w = (
        f"CASE WHEN {direction_expr} IN "
        f"({', '.join(repr(d) for d in C.INBOUND_DIRECTIONS)}) "
        f"THEN {C.PM_WEIGHT_INBOUND} ELSE {C.PM_WEIGHT_OUTBOUND} END"
    )
    am = f"{C.AM_AMP} * ({am_w}) * exp(-pow(({hour_expr} - {C.AM_MU}) / {C.AM_SIGMA}, 2) / 2.0)"
    pm = f"{C.PM_AMP} * ({pm_w}) * exp(-pow(({hour_expr} - {C.PM_MU}) / {C.PM_SIGMA}, 2) / 2.0)"
    weekday = f"({C.WD_BASE} + {am} + {pm})"
    weekend = (
        f"({C.WE_BASE} + {C.WE_AMP} * "
        f"exp(-pow(({hour_expr} - {C.WE_MU}) / {C.WE_SIGMA}, 2) / 2.0))"
    )
    return f"CASE WHEN {weekend_expr} THEN {weekend} ELSE {weekday} END"


def dow_scale(day_of_week: int) -> float:
    """Day-of-week demand multiplier. ``day_of_week`` follows Spark (1=Sunday)."""
    return C.DOW_SCALE[day_of_week]


def dow_scale_expr(dow_expr: str) -> str:
    cases = " ".join(f"WHEN {k} THEN {v}" for k, v in sorted(C.DOW_SCALE.items()))
    return f"CASE {dow_expr} {cases} ELSE 1.0 END"


def is_weekend(day_of_week: int) -> bool:
    """Spark dayofweek(): 1=Sunday .. 7=Saturday."""
    return day_of_week in (1, 7)


# ---------------------------------------------------------------------------
# 2. Capacity, free-flow speed and lane counts by urbanisation
# ---------------------------------------------------------------------------


def _lerp(rural: float, urban: float, urban_intensity: float) -> float:
    u = min(1.0, max(0.0, urban_intensity))
    return rural + (urban - rural) * u


def free_flow_speed(urban_intensity: float) -> float:
    """Free-flow speed (mph): ~70 rural, ~65 dense urban."""
    return _lerp(C.FREE_FLOW_RURAL, C.FREE_FLOW_URBAN, urban_intensity)


def free_flow_speed_expr(urban_expr: str) -> str:
    u = f"least(1.0, greatest(0.0, {urban_expr}))"
    return f"({C.FREE_FLOW_RURAL} + ({C.FREE_FLOW_URBAN} - {C.FREE_FLOW_RURAL}) * {u})"


def lane_capacity_vph(urban_intensity: float) -> int:
    """Per-lane capacity in vehicles/hour/lane."""
    return int(round(_lerp(C.CAPACITY_RURAL_VPL, C.CAPACITY_URBAN_VPL, urban_intensity)))


def station_type_scale(station_type: str) -> float:
    """Relative facility scale for capacity and latent demand."""
    return C.STATION_TYPE_SCALE.get(station_type, C.STATION_TYPE_SCALE["FR"])


def station_type_scale_expr(station_type_expr: str) -> str:
    """Spark SQL mirroring :func:`station_type_scale`."""
    cases = " ".join(
        f"WHEN '{station_type}' THEN {scale}"
        for station_type, scale in C.STATION_TYPE_SCALE.items()
    )
    return f"CASE {station_type_expr} {cases} ELSE {C.STATION_TYPE_SCALE['FR']} END"


def demand_scale(urban_intensity: float) -> float:
    """How hard peak demand pushes against capacity, by urbanisation.

    At full urban intensity this reaches ~1.2, so dense corridors exceed
    capacity at peak (v/c > 1, LOS F) while rural ones stay free-flowing.
    """
    return C.DEMAND_SCALE_INTERCEPT + C.DEMAND_SCALE_SLOPE * min(
        1.0, max(0.0, urban_intensity)
    )


def demand_scale_expr(urban_expr: str) -> str:
    u = f"least(1.0, greatest(0.0, {urban_expr}))"
    return f"({C.DEMAND_SCALE_INTERCEPT} + {C.DEMAND_SCALE_SLOPE} * {u})"


# ---------------------------------------------------------------------------
# 3. Speed-flow relationship (BPR volume-delay function)
# ---------------------------------------------------------------------------


def bpr_speed(free_flow_mph: float, vc_ratio: float) -> float:
    """Speed from volume/capacity via the BPR volume-delay function.

    .. math:: v = v_f / (1 + \\alpha (v/c)^\\beta)

    with :math:`\\alpha = 0.55`, :math:`\\beta = 4.5`. The classic highway
    coefficients (0.15, 4.0) barely bend until v/c ~ 1 and still predict
    ~50 mph at v/c = 1.3, which no one who has driven the 405 would accept.
    The steeper alpha/beta here yield ~62 mph at v/c 0.5, ~42 mph at v/c 1.0
    and ~20 mph at v/c 1.4 - a recognisable freeway breakdown curve.

    This is a *macroscopic* relation: it maps demand to an average speed and
    is monotonically decreasing, so it does not reproduce the backward-bending
    (hypercongested) branch of a true fundamental diagram, where flow *falls*
    once density passes critical. Flow here is demand served, not throughput.
    """
    vc = max(0.0, vc_ratio)
    speed = free_flow_mph / (1.0 + C.BPR_ALPHA * (vc**C.BPR_BETA))
    return max(C.MIN_SPEED_MPH, speed)


def bpr_speed_expr(free_flow_expr: str, vc_expr: str) -> str:
    vc = f"greatest(0.0, {vc_expr})"
    raw = f"{free_flow_expr} / (1.0 + {C.BPR_ALPHA} * pow({vc}, {C.BPR_BETA}))"
    return f"greatest({C.MIN_SPEED_MPH}, {raw})"


def occupancy_from_flow(flow_vph: float, speed_mph: float, num_lanes: int) -> float:
    """Loop-detector occupancy from flow and speed.

    Occupancy is the fraction of time a detector sees metal. From traffic flow
    theory, density = flow / speed, and a loop reports::

        occupancy = density_per_lane * effective_vehicle_length / 5280

    with a 20 ft effective length (vehicle plus detection zone). This ties
    occupancy to flow and speed rather than inventing it, so the three columns
    stay mutually consistent - a consumer can recover speed from flow and
    occupancy, as PeMS users do.
    """
    if speed_mph <= 0 or num_lanes <= 0:
        return C.MIN_OCCUPANCY
    density_per_lane = (flow_vph / num_lanes) / speed_mph  # veh/mile/lane
    occ = density_per_lane * C.EFFECTIVE_VEHICLE_LENGTH_FT / C.FEET_PER_MILE
    return min(C.MAX_OCCUPANCY, max(C.MIN_OCCUPANCY, occ))


def occupancy_from_flow_expr(flow_expr: str, speed_expr: str, lanes_expr: str) -> str:
    density = f"(({flow_expr}) / greatest(1, {lanes_expr})) / greatest(1.0, {speed_expr})"
    occ = f"{density} * {C.EFFECTIVE_VEHICLE_LENGTH_FT} / {C.FEET_PER_MILE}"
    return f"least({C.MAX_OCCUPANCY}, greatest({C.MIN_OCCUPANCY}, {occ}))"


# ---------------------------------------------------------------------------
# 4. Level of service and congestion flags
# ---------------------------------------------------------------------------


def level_of_service(vc_ratio: float) -> str:
    """HCM-style freeway LOS grade A-F from volume/capacity ratio."""
    for grade, upper in C.LOS_THRESHOLDS:
        if vc_ratio < upper:
            return grade
    return "F"


def level_of_service_expr(vc_expr: str) -> str:
    parts = " ".join(
        f"WHEN {vc_expr} < {upper} THEN '{grade}'" for grade, upper in C.LOS_THRESHOLDS
    )
    return f"CASE {parts} ELSE 'F' END"


def delay_vs_freeflow_min_per_mi(speed_mph: float, free_flow_mph: float) -> float:
    """Extra minutes to travel one mile versus free-flow conditions."""
    if speed_mph <= 0 or free_flow_mph <= 0:
        return 0.0
    return max(0.0, 60.0 / speed_mph - 60.0 / free_flow_mph)


def delay_vs_freeflow_expr(speed_expr: str, free_flow_expr: str) -> str:
    return (
        f"greatest(0.0, 60.0 / greatest(1.0, {speed_expr}) "
        f"- 60.0 / greatest(1.0, {free_flow_expr}))"
    )


def is_congested(speed_mph: float, free_flow_mph: float) -> bool:
    """True when speed falls below 75% of this station's own free-flow speed."""
    if free_flow_mph <= 0:
        return False
    return speed_mph < C.CONGESTION_SPEED_RATIO * free_flow_mph


def is_congested_expr(speed_expr: str, free_flow_expr: str) -> str:
    return f"({speed_expr}) < {C.CONGESTION_SPEED_RATIO} * ({free_flow_expr})"


# ---------------------------------------------------------------------------
# 5. Incident capacity impact
# ---------------------------------------------------------------------------


def incident_capacity_factor(num_lanes: int, lanes_blocked: int) -> float:
    """Surviving capacity fraction while an incident is active.

    Two effects compound: the physically blocked lanes, plus a 12% loss across
    the remaining lanes for rubbernecking and merge turbulence (HCM documents
    that incident capacity loss exceeds the pure lane-count loss). A 1-of-4
    lane blockage leaves 0.75 * 0.88 = 66% of capacity, which is enough to tip
    a peak-hour corridor into breakdown - exactly the localized speed collapse
    the app needs to visualise.
    """
    if num_lanes <= 0:
        return 1.0
    open_lanes = max(0, num_lanes - max(0, lanes_blocked))
    physical = open_lanes / num_lanes
    return max(0.05, physical * (1.0 - C.RUBBERNECK_CAPACITY_LOSS))


def incident_capacity_factor_expr(lanes_expr: str, blocked_expr: str) -> str:
    open_lanes = f"greatest(0, {lanes_expr} - coalesce({blocked_expr}, 0))"
    physical = f"({open_lanes} / greatest(1, {lanes_expr}))"
    return f"greatest(0.05, {physical} * (1.0 - {C.RUBBERNECK_CAPACITY_LOSS}))"


# ---------------------------------------------------------------------------
# 6. Deterministic pseudo-randomness
# ---------------------------------------------------------------------------
# The pipeline must be reproducible: a full refresh has to regenerate byte-
# identical data so that the app's saved scenarios stay comparable. We derive
# every "random" draw from a hash of stable keys rather than rand(), which is
# non-deterministic across retries and partitions.


def uniform_expr(*keys: str, salt: str = "") -> str:
    """A stable uniform(0,1) draw derived from hashing ``keys``."""
    parts = ", ".join(list(keys) + [f"'{salt}'", str(C.SEED)])
    return f"(pmod(hash({parts}), 100000) / 100000.0)"


def normal_expr(*keys: str, salt: str = "") -> str:
    """Approximately standard-normal draw via a Box-Muller transform."""
    u1 = uniform_expr(*keys, salt=salt + "_bm1")
    u2 = uniform_expr(*keys, salt=salt + "_bm2")
    return f"(sqrt(-2.0 * ln(greatest(1e-9, {u1}))) * cos(2 * pi() * {u2}))"


def lognormal_multiplier_expr(*keys: str, sigma: float, salt: str = "") -> str:
    """Multiplicative log-normal noise with unit median."""
    return f"exp({sigma} * {normal_expr(*keys, salt=salt)})"
