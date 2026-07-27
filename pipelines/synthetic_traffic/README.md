# Synthetic California Traffic — Spark Declarative Pipeline

Generates a realistic PeMS-style California traffic dataset from nothing but math.
No external data source: the pipeline is the data source. It is the foundation for
the what-if traffic modeling Databricks App.

**Target:** `lanl.caltrans_traffic` (serverless SDP, channel CURRENT)
**Verified run:** 7 datasets, ~3 min wall clock, 17.47M reading rows.

---

## Dataset graph

```
bronze_stations ──┬─→ bronze_incidents ──┐
                  │                      ├─→ bronze_station_readings
                  └─→ silver_stations_geo┤        │
                            │            │        ▼
                            └────────────┴─→ silver_readings_enriched
                                                  │
                                        ┌─────────┴─────────┐
                                        ▼                   ▼
                                 gold_map_frames    gold_corridor_summary
```

| Dataset | Type | Rows (verified) | Purpose |
|---|---|---|---|
| `bronze_stations` | MV | 2,022 | Detector inventory on 10 real CA corridors |
| `bronze_incidents` | MV | 20,425 | Incident log driving capacity loss |
| `bronze_station_readings` | MV | 17,470,088 | 5-minute detector samples |
| `silver_stations_geo` | MV | 2,022 | + H3 res 7/8/9, `GEOMETRY(4326)`, WKT, baseline capacity |
| `silver_readings_enriched` | MV | 17,228,168 | + v/c, LOS, delay, congestion flag (241,920 dropped) |
| `gold_map_frames` | MV | 5,742,720 | Animation frame buffer, 15-min buckets |
| `gold_corridor_summary` | MV | 57,600 | Per-corridor baseline for scenario diffing |

All datasets are **materialized views**, not streaming tables: the source is
generated rather than tailed, and full recompute is what makes the output
reproducible.

### Volume decision

5-minute intervals × 30 days × 2,022 stations = **17.47M rows** — comfortably in
the "tens of millions" budget, so no downgrade to 15-minute sampling or a station
subset was needed. The app never queries this table directly; it reads
`gold_map_frames` (5.7M rows, pre-bucketed to 15 min), so a single animation frame
touches ~2,022 rows.

---

## Schema

### `bronze_stations` / `silver_stations_geo`

| Column | Type | Notes |
|---|---|---|
| `station_id` | STRING | `{district:02d}{freeway_hash:02d}{direction}{seq:04d}` |
| `freeway` | STRING | `I-5`, `I-405`, `I-10`, `US-101`, `I-80`, `I-880`, `I-210`, `SR-99`, `I-15`, `I-680` |
| `direction` | STRING | `N`/`S` or `E`/`W` |
| `district` | INT | Caltrans district (2,3,4,5,6,7,8,10,11,12 present) |
| `county`, `city` | STRING | 34 distinct counties |
| `postmile`, `abs_pm` | DOUBLE | Cumulative route-miles from corridor origin |
| `latitude`, `longitude` | DOUBLE | WGS84, all inside CA bbox |
| `num_lanes` | INT | 1–8, scales with urbanisation |
| `lane_capacity_vph` | INT | 1,950–2,100 veh/hr/lane |
| `station_type` | STRING | `ML` 72% / `HV` / `OR` / `FR` |
| `urban_intensity` | DOUBLE | 0..1, drives demand, lanes, spacing |
| `detector_health` | STRING | `healthy` / `degraded` / `dark` |
| **silver adds:** | | |
| `h3_r7`, `h3_r8`, `h3_r9` | BIGINT | H3 cell ids |
| `h3_r7_str`, `h3_r8_str`, `h3_r9_str` | STRING | Hex form for map clients |
| `h3_r8_boundary_wkt` | STRING | Cell polygon for choropleths |
| `geom` | GEOMETRY(4326) | Native geometry |
| `geom_wkt` | STRING | `POINT(lon lat)` |
| `baseline_capacity_vph` | DOUBLE | **What-if lever:** `num_lanes × lane_capacity_vph` |
| `baseline_lanes`, `baseline_lane_capacity_vph` | INT | What-if levers |

### `bronze_station_readings` / `silver_readings_enriched`

| Column | Type | Notes |
|---|---|---|
| `station_id`, `ts` | STRING, TIMESTAMP | 5-minute grid |
| `total_flow_vph` | INT | Served flow, saturates at capacity |
| `avg_occupancy` | DOUBLE | Fraction 0..1, derived from flow & speed |
| `avg_speed_mph` | DOUBLE | BPR output + 2.5% jitter |
| `observed_pct` | DOUBLE | Detector health; 0 for dark stations |
| `num_lanes_reporting` | INT | `num_lanes × observed_pct` |
| **silver adds:** `vc_ratio` | DOUBLE | flow / effective capacity |
| `level_of_service` | STRING | HCM grade A–F |
| `delay_vs_freeflow_min_per_mi` | DOUBLE | Extra min/mile vs free-flow |
| `is_congested` | BOOLEAN | speed < 75% of own free-flow |
| `time_bucket`, `peak_period`, `hour_of_day`, `is_weekend` | | Animation/filter dimensions |
| `incident_active`, `lanes_blocked`, `incident_severity` | | Incident context |

### `bronze_incidents`

`incident_id`, `station_id`, `freeway`, `direction`, `district`, `county`, `city`,
`start_ts`, `end_ts`, `duration_min`, `severity` (1–4), `lanes_blocked`,
`num_lanes`, `incident_type` (`collision`/`breakdown`/`debris`/`construction`).

---

## The generation model

All math lives in `caltrans_traffic/traffic_model.py`, held **twice**: a pure-Python
reference implementation and a Spark SQL expression builder. `tests/test_traffic_model.py`
asserts the two agree numerically, so the documented math, the tested math and the
math that runs on the cluster cannot drift apart.

### 1. Geography

Ten corridors are hand-traced polylines (`caltrans_traffic/corridors.py`) whose
vertices follow real freeway routing through real cities in the right order.
Stations are placed by walking each polyline at urbanisation-dependent spacing
(0.6 mi urban → 6.0 mi rural), so LA has dense coverage and the Mojave stretch of
I-15 does not. Opposing carriageways are offset ~40 m so a map does not stack them.

> **Accuracy:** vertices are ~1 km control points transcribed from public route
> knowledge, not survey-grade centerlines. Good enough that the map is
> unmistakably Californian; **not** suitable for navigation or distance-critical
> analysis. Postmiles are monotonic route-miles, whereas real Caltrans postmiles
> reset at county lines with alphabetic prefixes.

### 2. Demand — twin Gaussian commute peaks

Weekday demand is a flat base load plus two Gaussian bumps:

```
d(h) = 0.16 + 0.62·w_am·N(h; 7.75, 1.15) + 0.72·w_pm·N(h; 17.25, 1.45)
```

Weekends collapse to one broad midday bump, `0.14 + 0.46·N(h; 13.5, 3.40)`.

**Commute asymmetry** comes from `w_am`/`w_pm`: an inbound direction gets 1.25×
the morning peak and 0.85× the evening peak, and vice-versa. This is what makes an
animated map read as a commute rather than a synchronised pulse.

Demand is then scaled by day-of-week (Friday 1.05 heaviest, Sunday 0.62 lightest),
by urbanisation (`0.45 + 0.75·urban`, so only dense corridors exceed capacity),
and by log-normal noise (σ=0.08).

### 3. Capacity and incidents

```
effective_capacity = num_lanes · lane_capacity_vph · incident_factor
incident_factor    = (open_lanes / num_lanes) · (1 − 0.12)
```

The 12% term is rubbernecking and merge turbulence — HCM documents that incident
capacity loss exceeds the pure lane-count loss. One of four lanes blocked leaves
`0.75 × 0.88 = 66%` of capacity, enough to tip a peak corridor into breakdown.

### 4. Speed — BPR volume-delay function

```
speed = free_flow / (1 + α·(v/c)^β)      α = 0.55, β = 4.5
```

| v/c | speed (ff=65) | LOS |
|---|---|---|
| 0.0 | 65.0 | A |
| 0.5 | 63.5 | B |
| 0.7 | 58.5 | C |
| 0.9 | 48.4 | D |
| 1.0 | 41.9 | F |
| 1.4 | 18.6 | F |

α/β are deliberately steeper than the textbook highway values (0.15, 4.0), which
barely bend until v/c≈1 and still predict ~50 mph at v/c=1.4 — a number no one who
has driven the 405 would accept. Speed floors at 8 mph (creep, not gridlock).

> **Limitation:** BPR is monotonically decreasing, so it does not reproduce the
> backward-bending (hypercongested) branch of a true fundamental diagram, where
> *flow itself* falls once density passes critical. `total_flow_vph` is demand
> served, capped at capacity — not measured throughput under breakdown.

### 5. Occupancy — derived, not invented

```
density  = flow / lanes / speed              (veh/mile/lane)
occupancy = density · 20 ft / 5280 ft
```

Tying occupancy to flow and speed keeps the three reported measures mutually
consistent, so a consumer can recover speed from flow and occupancy as PeMS users
do. A 20 ft effective length covers vehicle plus detection zone.

### 6. Determinism

Every pseudo-random draw is `hash(keys..., seed)`, never `rand()`. A full refresh
regenerates byte-identical data, which matters because the app's saved what-if
scenarios reference `station_id`s and compare against baseline numbers.

---

## Data quality expectations

| Dataset | Expectations |
|---|---|
| `bronze_stations` | `expect_or_fail`: non-null id, id shape. `expect_or_drop`: lat/lon in CA bbox, district 1–12, direction in NSEW, lanes 1–8, capacity 1000–2400 |
| `bronze_incidents` | `expect_or_fail`: non-null id. `expect_or_drop`: `end_ts > start_ts`, severity 1–4, `lanes_blocked ≤ num_lanes`, valid type |
| `bronze_station_readings` | `expect_or_fail`: non-null id/ts. `expect_or_drop`: flow ≥ 0 and ≤ 20000, speed in (0,100], occupancy in [0,1], observed_pct 0–100 |
| `silver_readings_enriched` | drops `observed_pct < 20` (unusable samples), plus v/c ≥ 0 and valid LOS |
| `silver_stations_geo` | non-null H3/geom, positive baseline capacity, `ST_SRID(geom) = 4326` |
| `gold_*` | CA bbox, speed range, valid LOS, positive baseline capacity |

The dark-detector path is a deliberate data-quality story: 28 stations report
`observed_pct = 0`, producing 241,920 bronze rows that silver drops — verified
exactly, with zero leakage.

---

## Verified geo support

Probed empirically on this workspace **before** committing to these functions
(serverless Spark writing UC Delta, read back via DBSQL warehouse
`688f49c732cf9083`, channel CURRENT, dbsql 2026.20):

- `h3_longlatash3` at res 7/8/9, `h3_h3tostring`, `h3_boundaryaswkt`
- native `GEOMETRY(4326)` column type surviving a Delta round-trip
- `ST_Point`, `ST_AsText`, `ST_SRID`, `ST_X`, `ST_GeomFromText`, `ST_Distance`, `ST_Contains`

Because native geometry is available it is stored directly, **and** WKT + H3 hex
strings are stored alongside. That redundancy is deliberate: an app on the SQL
connector gets a string it can hand straight to a map layer without a client-side
geometry codec. If a runtime lacked `ST_*`, dropping the `geom` column alone
degrades this table gracefully.

---

## Deploy and run

```bash
databricks bundle validate -p DEFAULT
databricks bundle deploy   -p DEFAULT          # dev target (default)
databricks bundle run synthetic_traffic -p DEFAULT
```

Target `prod` with `-t prod`. Catalog/schema are bundle variables
(`var.catalog`, `var.schema`), defaulting to `lanl.caltrans_traffic`.

### Local tests

```bash
uv venv --python 3.12 .venv && . .venv/bin/activate
uv pip install -e '.[dev]'
python -m pytest -q        # 103 tests, no Spark required
python -m ruff check .
```

### Packaging note

`caltrans_traffic/` sits **inside** `root_path`, which SDP puts on `sys.path` for
every transformation module — this is why the imports resolve with no pip install.
An `environment.dependencies: [--editable ...]` install was tried first and failed
on serverless pipeline compute, so the package ships as plain source.

Station rows are inlined as a SQL `VALUES` relation rather than
`spark.createDataFrame(local_rows)`, which serverless pipeline compute rejects with
`UNITY_CREDENTIAL_SCOPE_MISSING_SCOPE`. The literal is ~260 KB for 2,022 stations.

---

## Assumptions

1. **Inbound = N/E statewide.** True for many real commutes (northbound I-405 into
   West LA, eastbound I-80 into Sacramento) but real inbound direction depends on
   where the employment centre sits relative to each detector.
2. **Corridor coordinates are ~1 km control points**, not centerlines (above).
3. **Postmiles are monotonic route-miles**, not true Caltrans county-reset postmiles.
4. **Station counts are synthetic**, not PeMS's real ~40k detectors — 2,022 keeps
   the fact table inside the stated volume budget.
5. **BPR has no hypercongested branch** (above).
6. **`lane_capacity_vph` is uniform per station**; real capacity varies with grade,
   curvature, weather and truck share, none of which are modelled.
7. **No holidays.** The 30-day June 2026 window has no holiday effects, though
   day-of-week variation is modelled.
8. **Timestamps carry no timezone conversion.** `SIM_START` is a naive literal, so
   the stored range is `2026-06-01 00:00` – `2026-06-30 23:55` and the verified
   warehouse session timezone is `Etc/UTC` — meaning "7am peak" is 7am *as stored*,
   not 7am Pacific. An app that renders these in local time should either set the
   session timezone to `America/Los_Angeles` or treat the values as wall-clock.
   No DST handling either way (June has no transition).
