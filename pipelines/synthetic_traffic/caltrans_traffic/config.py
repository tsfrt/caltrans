"""Single source of truth for the synthetic traffic generation model.

Every constant here is consumed twice: once by the pure-Python reference
implementation in :mod:`caltrans_traffic.traffic_model` (which the unit tests
exercise) and once by the Spark SQL expression builders in the same module
(which the SDP transformations use). Keeping them in one place is what stops
the tested math and the executed math from drifting apart.
"""

from __future__ import annotations

# ---------------------------------------------------------------------------
# Simulation window and cadence
# ---------------------------------------------------------------------------

#: Wall-clock (America/Los_Angeles) start of the simulated window. 2026-06-01
#: is a Monday, so the window starts cleanly on a commute day. Transformations
#: convert this local wall-clock to UTC for persisted ``ts`` values.
SIM_START = "2026-06-01 00:00:00"

#: IANA timezone used by the diurnal demand model and app-facing time filters.
LOCAL_TIMEZONE = "America/Los_Angeles"

#: Fixed metadata timestamp for deterministic full refreshes. This is not the
#: wall-clock run time; it identifies the generation configuration version.
GENERATION_TIMESTAMP_UTC = "2026-06-01 00:00:00"

#: Number of days simulated.
SIM_DAYS = 30

#: Detector sample cadence in minutes. Real PeMS mainline detectors report
#: every 5 minutes, which is what we reproduce.
INTERVAL_MINUTES = 5

#: Time-bucket width (minutes) for the gold animation frames.
FRAME_MINUTES = 15

INTERVALS_PER_DAY = (24 * 60) // INTERVAL_MINUTES
TOTAL_INTERVALS = INTERVALS_PER_DAY * SIM_DAYS


# ---------------------------------------------------------------------------
# Diurnal demand profile
# ---------------------------------------------------------------------------
# Weekday demand is modelled as a flat base load plus two Gaussian commute
# peaks. Weekends replace the twin peaks with a single broad midday bump.

WD_BASE = 0.16
AM_AMP = 0.62
AM_MU = 7.75  # 7:45am
AM_SIGMA = 1.15
PM_AMP = 0.72
PM_MU = 17.25  # 5:15pm
PM_SIGMA = 1.45

WE_BASE = 0.14
WE_AMP = 0.46
WE_MU = 13.5  # 1:30pm
WE_SIGMA = 3.40

#: Commute asymmetry. Directions are split into two commute orientations: the
#: "inbound" set carries the heavier morning load, the "outbound" set the
#: heavier evening load. See traffic_model.direction_weights for the caveat.
INBOUND_DIRECTIONS = ("N", "E")
AM_WEIGHT_INBOUND = 1.25
PM_WEIGHT_INBOUND = 0.85
AM_WEIGHT_OUTBOUND = 0.85
PM_WEIGHT_OUTBOUND = 1.25

#: Day-of-week demand multipliers, keyed by Spark's dayofweek() (1=Sunday).
DOW_SCALE = {
    1: 0.62,  # Sunday
    2: 0.98,  # Monday
    3: 1.00,
    4: 1.01,
    5: 1.02,
    6: 1.05,  # Friday is the heaviest commute day
    7: 0.72,  # Saturday
}


# ---------------------------------------------------------------------------
# Demand scaling by urbanisation
# ---------------------------------------------------------------------------
# Urban intensity (0..1, carried on every corridor vertex) scales peak demand
# so that only genuinely urban corridors push v/c above 1.0 and collapse.

DEMAND_SCALE_INTERCEPT = 0.45
DEMAND_SCALE_SLOPE = 0.75

#: Multiplicative log-normal demand noise, as a sigma on the log scale.
DEMAND_NOISE_SIGMA = 0.08


# ---------------------------------------------------------------------------
# Speed-flow relationship (BPR volume-delay function)
# ---------------------------------------------------------------------------
# speed = free_flow / (1 + alpha * (v/c) ** beta)
#
# alpha/beta are tuned away from the textbook (0.15, 4) highway values so that
# oversaturated conditions collapse to a realistic 20-30 mph rather than the
# implausibly high speeds classic BPR predicts at v/c > 1.

BPR_ALPHA = 0.55
BPR_BETA = 4.5

#: Free-flow speed floor/ceiling by urbanisation (mph).
FREE_FLOW_URBAN = 65.0
FREE_FLOW_RURAL = 70.0

#: Absolute floor on modelled speed (mph) - even in full breakdown, traffic
#: creeps rather than stops dead for a whole 5-minute sample.
MIN_SPEED_MPH = 8.0

#: Effective vehicle length (feet) used to convert density to loop-detector
#: occupancy. Physical vehicle length plus detector zone length.
EFFECTIVE_VEHICLE_LENGTH_FT = 20.0
FEET_PER_MILE = 5280.0

#: Occupancy is a fraction; clamp to a physically sensible band.
MIN_OCCUPANCY = 0.002
MAX_OCCUPANCY = 0.60


# ---------------------------------------------------------------------------
# Station population
# ---------------------------------------------------------------------------
#: Detector spacing (miles) at full urban intensity and at full rural.
URBAN_SPACING_MI = 0.60
RURAL_SPACING_MI = 6.00

#: Lane counts interpolate between rural and urban.
LANES_RURAL = 2
LANES_URBAN = 6

#: Per-lane capacity (vehicles/hour/lane).
CAPACITY_URBAN_VPL = 2100
CAPACITY_RURAL_VPL = 1950

#: PeMS station type mix. ML=mainline, HV=HOV, OR=on-ramp, FR=off-ramp.
STATION_TYPE_WEIGHTS = (("ML", 0.70), ("HV", 0.12), ("OR", 0.09), ("FR", 0.09))

#: Relative capacity/demand scale by station facility type. This is applied
#: exactly once by scaling base capacity; latent demand is demand_factor times
#: that scaled base capacity, not an additional station-type multiplier.
STATION_TYPE_SCALE = {"ML": 1.00, "HV": 0.55, "OR": 0.22, "FR": 0.20}


# ---------------------------------------------------------------------------
# Detector health (drives the observed_pct data-quality story)
# ---------------------------------------------------------------------------
#: Fraction of stations whose detectors are degraded.
DEGRADED_STATION_FRACTION = 0.08
#: Fraction of stations that are fully dark (observed_pct = 0). These rows are
#: dropped by the silver expectations - that is the point.
DARK_STATION_FRACTION = 0.015


# ---------------------------------------------------------------------------
# Incidents
# ---------------------------------------------------------------------------
#: Target mean incidents per station per day (before urban weighting).
INCIDENT_RATE_PER_STATION_DAY = 0.28

INCIDENT_TYPE_WEIGHTS = (
    ("collision", 0.34),
    ("breakdown", 0.38),
    ("debris", 0.18),
    ("construction", 0.10),
)

#: Incident duration bounds in minutes, by severity (1 = minor .. 4 = major).
INCIDENT_DURATION_MIN = {1: 10, 2: 25, 3: 55, 4: 110}
INCIDENT_DURATION_MAX = {1: 25, 2: 60, 3: 120, 4: 260}

#: Extra capacity loss beyond the physically blocked lanes, capturing
#: rubbernecking and merge turbulence (HCM-style incident capacity reduction).
RUBBERNECK_CAPACITY_LOSS = 0.12


# ---------------------------------------------------------------------------
# Level of service thresholds (HCM freeway LOS by volume/capacity ratio)
# ---------------------------------------------------------------------------
LOS_THRESHOLDS = (
    ("A", 0.35),
    ("B", 0.55),
    ("C", 0.77),
    ("D", 0.92),
    ("E", 1.00),
)  # anything above the last threshold is "F"

#: A station is flagged congested when its speed drops below this fraction of
#: its own free-flow speed.
CONGESTION_SPEED_RATIO = 0.75


# ---------------------------------------------------------------------------
# California bounding box (used by data-quality expectations)
# ---------------------------------------------------------------------------
CA_MIN_LAT, CA_MAX_LAT = 32.50, 42.05
CA_MIN_LON, CA_MAX_LON = -124.50, -114.10

#: H3 resolutions materialised in silver.
H3_RESOLUTIONS = (7, 8, 9)

#: WGS84.
SRID = 4326

#: Deterministic seed mixed into every hash-derived pseudo-random draw.
SEED = 20260601
