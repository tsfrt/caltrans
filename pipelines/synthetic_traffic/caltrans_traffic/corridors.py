"""Real California freeway corridor geometry.

Each corridor is a polyline of hand-traced control points that follow the
actual routing of the freeway. Vertices carry the local Caltrans district,
county, city and an ``urban`` intensity in 0..1 that drives lane counts,
detector spacing and peak demand downstream.

Coordinate provenance and accuracy
----------------------------------
Vertices were transcribed from public route knowledge (interchange and city
locations) at roughly 1-2 decimal places, i.e. **~1 km positional accuracy**.
They are deliberately coarse control points, not survey-grade centerlines:
the goal is that a map of the generated stations is unmistakably Californian
and that each corridor runs through the right cities in the right order. They
are NOT suitable for real navigation or for distance-critical analysis.

Postmiles are computed as cumulative great-circle distance along the polyline
from the corridor origin. Real Caltrans postmiles reset at county lines and
carry alphabetic prefixes; ours are simple monotonic route-miles, which is a
documented simplification.
"""

from __future__ import annotations

import math
from typing import NamedTuple


class Vertex(NamedTuple):
    """One control point on a corridor polyline."""

    lat: float
    lon: float
    district: int
    county: str
    city: str
    urban: float


class Corridor(NamedTuple):
    """A directional freeway corridor."""

    freeway: str
    #: The two directions of travel signed on this route.
    directions: tuple[str, str]
    vertices: tuple[Vertex, ...]


def _v(lat, lon, district, county, city, urban) -> Vertex:
    return Vertex(lat, lon, district, county, city, urban)


# ---------------------------------------------------------------------------
# Corridor definitions
# ---------------------------------------------------------------------------
# Ordered south -> north for N/S routes and west -> east for E/W routes, so
# that increasing postmile matches Caltrans convention.

CORRIDORS: tuple[Corridor, ...] = (
    # I-5: Mexican border -> San Diego -> LA -> Central Valley -> Sacramento
    # -> Redding -> Oregon. The state's spine.
    Corridor(
        "I-5",
        ("N", "S"),
        (
            _v(32.5420, -117.0300, 11, "San Diego", "San Ysidro", 0.75),
            _v(32.7010, -117.1590, 11, "San Diego", "San Diego", 0.95),
            _v(32.8480, -117.1300, 11, "San Diego", "San Diego", 0.90),
            _v(33.0140, -117.2830, 11, "San Diego", "Del Mar", 0.70),
            _v(33.1960, -117.3790, 11, "San Diego", "Carlsbad", 0.72),
            _v(33.3860, -117.5950, 11, "San Diego", "San Onofre", 0.30),
            _v(33.5420, -117.7830, 12, "Orange", "San Clemente", 0.68),
            _v(33.6960, -117.8340, 12, "Orange", "Irvine", 0.88),
            _v(33.7680, -117.9410, 12, "Orange", "Santa Ana", 0.94),
            _v(33.8700, -117.9240, 12, "Orange", "Buena Park", 0.90),
            _v(33.9160, -118.0810, 7, "Los Angeles", "Norwalk", 0.92),
            _v(34.0180, -118.2160, 7, "Los Angeles", "Los Angeles", 0.98),
            _v(34.1170, -118.2860, 7, "Los Angeles", "Glendale", 0.93),
            _v(34.2560, -118.4530, 7, "Los Angeles", "Sun Valley", 0.86),
            _v(34.4210, -118.5680, 7, "Los Angeles", "Santa Clarita", 0.74),
            _v(34.7500, -118.8800, 7, "Los Angeles", "Gorman", 0.15),
            _v(35.0500, -118.9500, 6, "Kern", "Grapevine", 0.10),
            _v(35.3730, -119.0180, 6, "Kern", "Bakersfield", 0.30),
            _v(35.9200, -119.7100, 6, "Kings", "Kettleman City", 0.10),
            _v(36.6000, -120.4300, 6, "Fresno", "Firebaugh", 0.10),
            _v(37.0500, -120.8600, 10, "Merced", "Los Banos", 0.15),
            _v(37.4900, -121.1500, 10, "Stanislaus", "Patterson", 0.15),
            _v(37.8000, -121.2400, 10, "San Joaquin", "Stockton", 0.55),
            _v(38.2500, -121.4900, 3, "Sacramento", "Elk Grove", 0.60),
            _v(38.5800, -121.4900, 3, "Sacramento", "Sacramento", 0.85),
            _v(38.9000, -121.6900, 3, "Sutter", "Yuba City", 0.30),
            _v(39.5200, -121.9500, 3, "Butte", "Chico", 0.30),
            _v(40.1800, -122.2400, 2, "Tehama", "Red Bluff", 0.20),
            _v(40.5860, -122.3910, 2, "Shasta", "Redding", 0.35),
            _v(41.3100, -122.3200, 2, "Siskiyou", "Weed", 0.10),
            _v(41.9300, -122.3800, 2, "Siskiyou", "Yreka", 0.10),
        ),
    ),
    # I-405: the San Diego Freeway. Irvine -> LAX -> Sherman Oaks.
    Corridor(
        "I-405",
        ("N", "S"),
        (
            _v(33.6620, -117.7700, 12, "Orange", "Irvine", 0.90),
            _v(33.7000, -117.8700, 12, "Orange", "Costa Mesa", 0.92),
            _v(33.7500, -118.0000, 12, "Orange", "Fountain Valley", 0.93),
            _v(33.7900, -118.0900, 12, "Orange", "Seal Beach", 0.90),
            _v(33.8300, -118.1800, 7, "Los Angeles", "Long Beach", 0.95),
            _v(33.8900, -118.2800, 7, "Los Angeles", "Carson", 0.94),
            _v(33.9200, -118.3500, 7, "Los Angeles", "Torrance", 0.95),
            _v(33.9450, -118.3900, 7, "Los Angeles", "Inglewood", 0.97),
            _v(34.0000, -118.4100, 7, "Los Angeles", "Culver City", 0.98),
            _v(34.0450, -118.4400, 7, "Los Angeles", "West Los Angeles", 1.00),
            _v(34.1000, -118.4700, 7, "Los Angeles", "Brentwood", 0.96),
            _v(34.1500, -118.4700, 7, "Los Angeles", "Sherman Oaks", 0.95),
            _v(34.2200, -118.4900, 7, "Los Angeles", "Van Nuys", 0.92),
        ),
    ),
    # I-10: Santa Monica -> downtown LA -> San Bernardino -> Palm Springs
    # -> Blythe (Arizona line).
    Corridor(
        "I-10",
        ("E", "W"),
        (
            _v(34.0180, -118.4910, 7, "Los Angeles", "Santa Monica", 0.95),
            _v(34.0280, -118.4000, 7, "Los Angeles", "West Los Angeles", 0.98),
            _v(34.0330, -118.3200, 7, "Los Angeles", "Mid-City", 0.99),
            _v(34.0380, -118.2400, 7, "Los Angeles", "Los Angeles", 1.00),
            _v(34.0350, -118.1500, 7, "Los Angeles", "East Los Angeles", 0.95),
            _v(34.0700, -117.9400, 7, "Los Angeles", "El Monte", 0.93),
            _v(34.0850, -117.8100, 7, "Los Angeles", "Pomona", 0.88),
            _v(34.0900, -117.6000, 8, "San Bernardino", "Ontario", 0.85),
            _v(34.1080, -117.4500, 8, "San Bernardino", "Fontana", 0.82),
            _v(34.1080, -117.2900, 8, "San Bernardino", "San Bernardino", 0.84),
            _v(34.0300, -117.0400, 8, "Riverside", "Beaumont", 0.45),
            _v(33.9200, -116.7800, 8, "Riverside", "Palm Springs", 0.45),
            _v(33.7400, -116.2100, 8, "Riverside", "Indio", 0.35),
            _v(33.6100, -115.7300, 8, "Riverside", "Chiriaco Summit", 0.05),
            _v(33.6100, -114.9500, 8, "Riverside", "Desert Center", 0.05),
            _v(33.6100, -114.5900, 8, "Riverside", "Blythe", 0.15),
        ),
    ),
    # US-101: LA -> Ventura -> Santa Barbara -> Salinas -> San Jose -> SF.
    # Signed "US-101" in the field; PeMS uses "US101".
    Corridor(
        "US-101",
        ("N", "S"),
        (
            _v(33.9950, -118.1700, 7, "Los Angeles", "East Los Angeles", 0.94),
            _v(34.0570, -118.2370, 7, "Los Angeles", "Los Angeles", 1.00),
            _v(34.0980, -118.3290, 7, "Los Angeles", "Hollywood", 0.98),
            _v(34.1480, -118.3870, 7, "Los Angeles", "Studio City", 0.95),
            _v(34.1720, -118.4700, 7, "Los Angeles", "Sherman Oaks", 0.94),
            _v(34.1830, -118.6000, 7, "Los Angeles", "Woodland Hills", 0.90),
            _v(34.1600, -118.8300, 7, "Los Angeles", "Calabasas", 0.80),
            _v(34.1900, -119.0400, 7, "Ventura", "Thousand Oaks", 0.78),
            _v(34.2800, -119.2900, 7, "Ventura", "Camarillo", 0.68),
            _v(34.2750, -119.2300, 7, "Ventura", "Oxnard", 0.72),
            _v(34.3500, -119.4800, 7, "Ventura", "Ventura", 0.70),
            _v(34.4200, -119.6900, 5, "Santa Barbara", "Santa Barbara", 0.72),
            _v(34.4600, -120.0300, 5, "Santa Barbara", "Goleta", 0.55),
            _v(34.6400, -120.4600, 5, "Santa Barbara", "Buellton", 0.25),
            _v(34.9500, -120.4350, 5, "Santa Barbara", "Santa Maria", 0.45),
            _v(35.2830, -120.6600, 5, "San Luis Obispo", "San Luis Obispo", 0.45),
            _v(35.6200, -120.6900, 5, "San Luis Obispo", "Paso Robles", 0.30),
            _v(35.9000, -120.9000, 5, "Monterey", "San Ardo", 0.08),
            _v(36.2000, -121.1400, 5, "Monterey", "King City", 0.20),
            _v(36.6600, -121.6300, 5, "Monterey", "Salinas", 0.50),
            _v(36.9200, -121.7600, 5, "Santa Cruz", "Watsonville", 0.45),
            _v(37.1400, -121.6500, 4, "Santa Clara", "Gilroy", 0.50),
            _v(37.3380, -121.8900, 4, "Santa Clara", "San Jose", 0.92),
            _v(37.4200, -122.0700, 4, "Santa Clara", "Mountain View", 0.93),
            _v(37.4850, -122.2280, 4, "San Mateo", "Redwood City", 0.90),
            _v(37.5630, -122.3250, 4, "San Mateo", "San Mateo", 0.92),
            _v(37.6400, -122.4100, 4, "San Mateo", "South San Francisco", 0.93),
            _v(37.7500, -122.4050, 4, "San Francisco", "San Francisco", 1.00),
        ),
    ),
    # I-80: San Francisco -> Oakland -> Sacramento -> Truckee -> Nevada line.
    Corridor(
        "I-80",
        ("E", "W"),
        (
            _v(37.7830, -122.3950, 4, "San Francisco", "San Francisco", 1.00),
            _v(37.8280, -122.3270, 4, "Alameda", "Oakland", 0.97),
            _v(37.8500, -122.2900, 4, "Alameda", "Emeryville", 0.95),
            _v(37.8700, -122.3000, 4, "Alameda", "Berkeley", 0.94),
            _v(37.9260, -122.3170, 4, "Contra Costa", "Richmond", 0.90),
            _v(38.0180, -122.1300, 4, "Contra Costa", "Hercules", 0.75),
            _v(38.0700, -122.2300, 4, "Solano", "Vallejo", 0.78),
            _v(38.2500, -122.0400, 4, "Solano", "Fairfield", 0.70),
            _v(38.3560, -121.9680, 4, "Solano", "Vacaville", 0.62),
            _v(38.5450, -121.7400, 3, "Yolo", "Davis", 0.60),
            _v(38.5820, -121.4930, 3, "Sacramento", "Sacramento", 0.88),
            _v(38.6400, -121.2700, 3, "Sacramento", "Citrus Heights", 0.72),
            _v(38.7200, -121.0800, 3, "Placer", "Rocklin", 0.60),
            _v(38.8900, -121.0800, 3, "Placer", "Auburn", 0.45),
            _v(39.1400, -120.8300, 3, "Placer", "Colfax", 0.15),
            _v(39.3200, -120.3300, 3, "Placer", "Soda Springs", 0.05),
            _v(39.3280, -120.1830, 3, "Nevada", "Truckee", 0.25),
            _v(39.5100, -120.0000, 3, "Sierra", "Verdi", 0.10),
        ),
    ),
    # I-880: the Nimitz Freeway. San Jose -> Oakland along the East Bay.
    Corridor(
        "I-880",
        ("N", "S"),
        (
            _v(37.3350, -121.9000, 4, "Santa Clara", "San Jose", 0.93),
            _v(37.3900, -121.9600, 4, "Santa Clara", "Milpitas", 0.90),
            _v(37.4900, -121.9400, 4, "Alameda", "Fremont", 0.90),
            _v(37.5800, -122.0300, 4, "Alameda", "Union City", 0.88),
            _v(37.6500, -122.0900, 4, "Alameda", "Hayward", 0.90),
            _v(37.7200, -122.1600, 4, "Alameda", "San Leandro", 0.91),
            _v(37.7700, -122.2100, 4, "Alameda", "Oakland", 0.95),
            _v(37.8100, -122.2900, 4, "Alameda", "Oakland", 0.97),
        ),
    ),
    # I-210: the Foothill Freeway. Sylmar -> Pasadena -> San Bernardino.
    Corridor(
        "I-210",
        ("E", "W"),
        (
            _v(34.3100, -118.4900, 7, "Los Angeles", "Sylmar", 0.85),
            _v(34.2700, -118.4200, 7, "Los Angeles", "Sun Valley", 0.86),
            _v(34.2300, -118.2900, 7, "Los Angeles", "La Canada", 0.84),
            _v(34.1650, -118.1400, 7, "Los Angeles", "Pasadena", 0.92),
            _v(34.1350, -118.0200, 7, "Los Angeles", "Arcadia", 0.88),
            _v(34.1200, -117.8900, 7, "Los Angeles", "Azusa", 0.85),
            _v(34.1100, -117.7100, 8, "Los Angeles", "Claremont", 0.80),
            _v(34.1070, -117.5700, 8, "San Bernardino", "Upland", 0.82),
            _v(34.1200, -117.3900, 8, "San Bernardino", "Rialto", 0.80),
            _v(34.1400, -117.2700, 8, "San Bernardino", "San Bernardino", 0.82),
        ),
    ),
    # SR-99: the Central Valley's second spine. Bakersfield -> Sacramento.
    Corridor(
        "SR-99",
        ("N", "S"),
        (
            _v(35.2900, -119.0100, 6, "Kern", "Bakersfield", 0.55),
            _v(35.4870, -119.2700, 6, "Kern", "Shafter", 0.20),
            _v(35.7900, -119.2400, 6, "Tulare", "Delano", 0.30),
            _v(36.0600, -119.0200, 6, "Tulare", "Tulare", 0.35),
            _v(36.3300, -119.2900, 6, "Tulare", "Visalia", 0.45),
            _v(36.6100, -119.4500, 6, "Fresno", "Selma", 0.30),
            _v(36.7480, -119.7720, 6, "Fresno", "Fresno", 0.70),
            _v(36.9600, -120.0600, 6, "Madera", "Madera", 0.35),
            _v(37.3050, -120.4820, 10, "Merced", "Merced", 0.45),
            _v(37.5000, -120.8500, 10, "Stanislaus", "Turlock", 0.40),
            _v(37.6390, -120.9970, 10, "Stanislaus", "Modesto", 0.60),
            _v(37.9570, -121.2900, 10, "San Joaquin", "Stockton", 0.65),
            _v(38.2500, -121.3000, 10, "San Joaquin", "Lodi", 0.45),
            _v(38.5000, -121.4400, 3, "Sacramento", "Elk Grove", 0.60),
            _v(38.5700, -121.4700, 3, "Sacramento", "Sacramento", 0.85),
        ),
    ),
    # I-15: San Diego -> Temecula -> Cajon Pass -> Barstow -> Nevada line.
    Corridor(
        "I-15",
        ("N", "S"),
        (
            _v(32.7100, -117.1300, 11, "San Diego", "San Diego", 0.92),
            _v(32.8300, -117.1200, 11, "San Diego", "Mira Mesa", 0.85),
            _v(33.0300, -117.0800, 11, "San Diego", "Escondido", 0.75),
            _v(33.2400, -117.1100, 11, "San Diego", "Fallbrook", 0.40),
            _v(33.4930, -117.1480, 8, "Riverside", "Temecula", 0.68),
            _v(33.6700, -117.3200, 8, "Riverside", "Lake Elsinore", 0.55),
            _v(33.8800, -117.5100, 8, "Riverside", "Corona", 0.80),
            _v(34.0100, -117.5500, 8, "San Bernardino", "Ontario", 0.84),
            _v(34.1070, -117.5300, 8, "San Bernardino", "Rancho Cucamonga", 0.82),
            _v(34.2500, -117.4400, 8, "San Bernardino", "Cajon Pass", 0.30),
            _v(34.4300, -117.3600, 8, "San Bernardino", "Hesperia", 0.50),
            _v(34.5400, -117.2900, 8, "San Bernardino", "Victorville", 0.50),
            _v(34.8990, -117.0200, 8, "San Bernardino", "Barstow", 0.30),
            _v(35.2700, -116.0700, 8, "San Bernardino", "Baker", 0.05),
            _v(35.6100, -115.4000, 8, "San Bernardino", "Primm", 0.05),
        ),
    ),
    # I-680: San Jose -> Walnut Creek -> Benicia, the inland East Bay bypass.
    Corridor(
        "I-680",
        ("N", "S"),
        (
            _v(37.3500, -121.8800, 4, "Santa Clara", "San Jose", 0.90),
            _v(37.4800, -121.9200, 4, "Santa Clara", "Milpitas", 0.88),
            _v(37.5600, -121.9700, 4, "Alameda", "Fremont", 0.86),
            _v(37.6900, -121.9200, 4, "Alameda", "Pleasanton", 0.82),
            _v(37.7800, -121.9300, 4, "Alameda", "Dublin", 0.82),
            _v(37.8900, -122.0600, 4, "Contra Costa", "Danville", 0.78),
            _v(37.9060, -122.0650, 4, "Contra Costa", "Walnut Creek", 0.85),
            _v(37.9800, -122.0600, 4, "Contra Costa", "Concord", 0.82),
            _v(38.0200, -122.1300, 4, "Contra Costa", "Martinez", 0.72),
            _v(38.0490, -122.1580, 4, "Solano", "Benicia", 0.70),
        ),
    ),
)


EARTH_RADIUS_MI = 3958.7613


def haversine_mi(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in statute miles."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_MI * math.asin(math.sqrt(a))


def corridor_length_mi(corridor: Corridor) -> float:
    """Total polyline length of a corridor in miles."""
    return sum(
        haversine_mi(a.lat, a.lon, b.lat, b.lon)
        for a, b in zip(corridor.vertices, corridor.vertices[1:])
    )


def interpolate(corridor: Corridor, distance_mi: float) -> tuple[float, float, Vertex]:
    """Point at ``distance_mi`` along the corridor.

    Returns ``(lat, lon, attribute_vertex)`` where the attribute vertex is the
    nearer of the two segment endpoints - district/county/city are categorical
    so they snap rather than interpolate, while ``urban`` is blended linearly.
    """
    verts = corridor.vertices
    remaining = max(0.0, distance_mi)
    for a, b in zip(verts, verts[1:]):
        seg = haversine_mi(a.lat, a.lon, b.lat, b.lon)
        if seg <= 0:
            continue
        if remaining <= seg:
            t = remaining / seg
            lat = a.lat + (b.lat - a.lat) * t
            lon = a.lon + (b.lon - a.lon) * t
            near = a if t < 0.5 else b
            blended = near._replace(urban=a.urban + (b.urban - a.urban) * t)
            return lat, lon, blended
        remaining -= seg
    last = verts[-1]
    return last.lat, last.lon, last


def corridor_summary() -> list[dict]:
    """Per-corridor length and vertex count. Used by tests and the README."""
    return [
        {
            "freeway": c.freeway,
            "directions": "/".join(c.directions),
            "vertices": len(c.vertices),
            "length_mi": round(corridor_length_mi(c), 1),
        }
        for c in CORRIDORS
    ]
