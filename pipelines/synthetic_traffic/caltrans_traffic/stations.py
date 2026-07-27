"""Deterministic placement of PeMS-style detector stations along corridors.

Stations are a small dimension (~3k rows), so they are enumerated in plain
Python and handed to Spark via ``createDataFrame``. The synthetic-data skill's
"no driver-side loops" rule targets fact-table volume; applying it to a 3k-row
dimension would mean expressing corridor interpolation in SQL for no benefit.
The 26M-row readings fact table is generated entirely in Spark.

Placement is fully deterministic - no RNG, only hashes of stable keys - so a
full refresh reproduces identical station_ids and coordinates. The app's saved
what-if scenarios reference station_ids, so they must be stable across runs.
"""

from __future__ import annotations

from collections.abc import Iterator

from . import config as C
from . import traffic_model as M
from .corridors import CORRIDORS, Corridor, corridor_length_mi, interpolate


def _stable_unit(*parts: object) -> float:
    """Deterministic value in [0,1) from a tuple of keys.

    Uses a FNV-1a style mix rather than Python's ``hash()``, which is salted
    per-process for strings and would break reproducibility across runs.
    """
    h = 0xCBF29CE484222325
    for p in parts:
        for byte in str(p).encode("utf-8"):
            h ^= byte
            h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return (h % 1_000_000) / 1_000_000.0


def _detector_spacing_mi(urban: float) -> float:
    """Detector spacing: dense in cities, sparse in the desert."""
    u = min(1.0, max(0.0, urban))
    return C.RURAL_SPACING_MI + (C.URBAN_SPACING_MI - C.RURAL_SPACING_MI) * u


def _num_lanes(urban: float, jitter: float) -> int:
    """Lane count, interpolated by urbanisation with +/-1 lane of jitter."""
    base = C.LANES_RURAL + (C.LANES_URBAN - C.LANES_RURAL) * min(1.0, max(0.0, urban))
    lanes = int(round(base + (jitter - 0.5) * 2.0))
    return max(2, min(8, lanes))


def _station_type(draw: float) -> str:
    """Weighted PeMS station type (mainline / HOV / on-ramp / off-ramp)."""
    acc = 0.0
    for name, weight in C.STATION_TYPE_WEIGHTS:
        acc += weight
        if draw < acc:
            return name
    return C.STATION_TYPE_WEIGHTS[-1][0]


def _walk_corridor(corridor: Corridor) -> Iterator[float]:
    """Yield postmiles along a corridor at urbanisation-dependent spacing."""
    total = corridor_length_mi(corridor)
    pm = 0.0
    while pm <= total:
        yield pm
        _, _, vtx = interpolate(corridor, pm)
        pm += _detector_spacing_mi(vtx.urban)


def build_stations() -> list[dict]:
    """Enumerate every synthetic station, one row per (corridor, direction, postmile)."""
    rows: list[dict] = []
    for corridor in CORRIDORS:
        for direction in corridor.directions:
            for seq, postmile in enumerate(_walk_corridor(corridor)):
                lat, lon, vtx = interpolate(corridor, postmile)
                key = (corridor.freeway, direction, seq)

                # Offset the two carriageways ~40 m either side of the
                # centerline so opposing directions do not stack into one pin
                # on the map (and so H3 res-9 can separate them).
                side = 1.0 if direction in ("N", "E") else -1.0
                lat_off = lat + side * 0.00035
                lon_off = lon + side * 0.00035

                lanes = _num_lanes(vtx.urban, _stable_unit(*key, "lanes"))
                stype = _station_type(_stable_unit(*key, "stype"))
                # HOV stations carry fewer lanes; ramps are 1-2 lanes.
                if stype == "HV":
                    lanes = max(1, min(2, lanes // 3))
                elif stype in ("OR", "FR"):
                    lanes = 1 if _stable_unit(*key, "ramp") < 0.6 else 2

                health = _stable_unit(*key, "health")
                if health < C.DARK_STATION_FRACTION:
                    detector_health = "dark"
                elif health < C.DARK_STATION_FRACTION + C.DEGRADED_STATION_FRACTION:
                    detector_health = "degraded"
                else:
                    detector_health = "healthy"

                rows.append(
                    {
                        # PeMS-style numeric-ish id, stable and unique.
                        "station_id": f"{vtx.district:02d}{abs(hash(corridor.freeway)) % 100:02d}"
                        f"{direction}{seq:04d}",
                        "freeway": corridor.freeway,
                        "direction": direction,
                        "district": vtx.district,
                        "county": vtx.county,
                        "city": vtx.city,
                        "postmile": round(postmile, 3),
                        "abs_pm": round(postmile, 3),
                        "latitude": round(lat_off, 6),
                        "longitude": round(lon_off, 6),
                        "num_lanes": lanes,
                        "lane_capacity_vph": M.lane_capacity_vph(vtx.urban),
                        "station_type": stype,
                        "urban_intensity": round(vtx.urban, 4),
                        "detector_health": detector_health,
                    }
                )
    return rows


#: Column order and Spark types for the station rows.
STATION_COLUMNS: tuple[tuple[str, str], ...] = (
    ("station_id", "STRING"),
    ("freeway", "STRING"),
    ("direction", "STRING"),
    ("district", "INT"),
    ("county", "STRING"),
    ("city", "STRING"),
    ("postmile", "DOUBLE"),
    ("abs_pm", "DOUBLE"),
    ("latitude", "DOUBLE"),
    ("longitude", "DOUBLE"),
    ("num_lanes", "INT"),
    ("lane_capacity_vph", "INT"),
    ("station_type", "STRING"),
    ("urban_intensity", "DOUBLE"),
    ("detector_health", "STRING"),
)

#: Spark DDL schema string for the station rows. Declared explicitly so the
#: bronze table has stable types rather than whatever inference produces.
STATION_SCHEMA = ", ".join(f"{name} {dtype}" for name, dtype in STATION_COLUMNS)


def _sql_literal(value: object) -> str:
    """Render a Python value as a Spark SQL literal."""
    if isinstance(value, str):
        escaped = value.replace("'", "''")
        return f"'{escaped}'"
    return str(value)


def stations_values_sql() -> str:
    """The station inventory as a standalone ``SELECT ... FROM VALUES`` query.

    Serverless SDP compute rejects ``spark.createDataFrame(local_rows)`` with
    ``UNITY_CREDENTIAL_SCOPE_MISSING_SCOPE`` - materialising a local collection
    needs a credential scope the pipeline's analysis context does not have. So
    the rows are inlined as a SQL ``VALUES`` relation instead, which the driver
    plans entirely server-side. The literal is ~210 KB for ~2k stations, well
    inside Spark's query size limits.
    """
    names = [name for name, _ in STATION_COLUMNS]
    tuples = ",\n".join(
        "(" + ", ".join(_sql_literal(row[name]) for name in names) + ")"
        for row in build_stations()
    )
    # Cast through the declared schema so types are pinned rather than inferred
    # from the literals (e.g. postmile 0.0 must stay DOUBLE, not INT).
    projection = ", ".join(f"CAST({name} AS {dtype}) AS {name}" for name, dtype in STATION_COLUMNS)
    return f"SELECT {projection} FROM VALUES\n{tuples}\nAS t({', '.join(names)})"
