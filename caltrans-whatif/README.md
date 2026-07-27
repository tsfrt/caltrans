# California Traffic What-If — Milestone 1

Animated geospatial UI over DBSQL. One Pacific-local day of California freeway traffic
(1,994 detector stations × 96 fifteen-minute buckets) rendered as a MapLibre + deck.gl map
that animates entirely client-side.

**Milestone 1 scope:** the thinnest end-to-end vertical slice that already demos animation
+ geospatial. The what-if engine (M2) and persistence/narration (M3) are NOT built — see
[Not done](#not-done-m2--m3).

---

## Stack

| Layer | Choice |
|---|---|
| Framework | **AppKit** 0.38.1 (TypeScript/React + Vite client, typed Express server) |
| Map | MapLibre GL 5 basemap + deck.gl 9 overlay (`H3HexagonLayer`, `ScatterplotLayer`, `PathLayer`, `ColumnLayer`) |
| Data | `lanl.caltrans_traffic.gold_map_frames` (5,742,720 rows) + `silver_stations_geo` |
| Compute | SQL warehouse `688f49c732cf9083` (Serverless Starter, Small, PRO, Photon) |
| Animation | `requestAnimationFrame` clock over flat typed arrays — zero queries during playback |

Streamlit was rejected: it re-runs the whole script per interaction, so a time slider
cannot animate. See `docs/ARCHITECTURE.md` §2.1.

## Project layout

```
caltrans-whatif/
├── config/queries/               # SQL → typed TS row types via `npm run typegen`
│   ├── available_days.sql         #   day picker
│   ├── corridor_options.sql       #   corridor filter
│   ├── station_geometry.sql       #   geometry, fetched ONCE per session
│   ├── traffic_time_matrix.sql    #   THE animation payload (windowed, columnar)
│   └── h3_congestion_hexes.sql    #   H3 aggregation, computed IN DBSQL
├── client/src/
│   ├── lib/frames.ts              # typed-array frame store + KPI math + packed decoder
│   ├── lib/useAnimationClock.ts   # rAF playback clock (fractional bucket position)
│   ├── lib/useTrafficData.ts      # THE data-access seam (only place naming a queryKey)
│   ├── lib/mapStyle.ts            # offline basemap style + optional CARTO
│   ├── components/TrafficMap.tsx  # MapLibre + deck.gl layers
│   ├── components/TimeControls.tsx
│   ├── components/KpiPanel.tsx
│   └── pages/map/TrafficMapPage.tsx
├── server/server.ts              # analytics({ timeout: 45s }) + server()
├── app.yaml / databricks.yml     # warehouse bound CAN_USE via valueFrom
└── tests/smoke.spec.ts           # Playwright smoke (selectors match THIS app)
```

## The central performance rule

> **Nothing queries the warehouse during animation.**

Fetch geometry once + a numeric time matrix once per view, then animate from typed arrays.
A Small warehouse answers one query in ~1s but could never serve 96 frames at interactive
rates.

This is **enforced by a test**, not just asserted: `tests/smoke.spec.ts` counts
`/api/analytics/query/` requests, waits for the clock readout to change, and fails if the
count moved. Verified: 12 requests to first paint, still 12 after scrubbing across three
different times of day.

## Measured payload + latency

Warehouse `688f49c732cf9083`, day `2026-06-10` (Wednesday), all 10 corridors.
Latency is p50 of 3 warm runs via the SQL Statement API.

| Query | Rows | Payload | p50 latency |
|---|---:|---:|---:|
| `available_days` | 30 | 1.1 kB | 0.78 s |
| `corridor_options` | 10 | 174 B | 0.66 s |
| `station_geometry` | 1,994 | 324 kB (0.31 MiB) | 0.66 s |
| `traffic_time_matrix` × 4 windows | 191,424 cells | **2,594,727 B (2.475 MiB total, ~0.62 MiB/window)** | 2.12 s (slowest window) |
| `h3_congestion_hexes` × 4 windows | 22,944 cells | **576,599 B (0.550 MiB total)** | 1.89 s (slowest window) |

Total to first interactive frame: **~3.4 MiB across 12 requests**, every one far inside the
Apps 120 s request ceiling.

### Why the payload is shaped so oddly

`gold_map_frames` is 5.7M rows and is never selected whole. One local day of all corridors
is 191,424 rows. Getting that to the browser ran into two hard limits:

1. **AppKit caps a single SSE event at 1 MiB** (`appkit/dist/stream/defaults.js`,
   `maxEventSize: 1024 * 1024`). Row-per-record JSON for one day measured
   **9,540,471 B (9.10 MiB)** — 9× over. It fails at runtime with
   `INVALID_REQUEST: Event exceeds max size of 1048576 bytes`.
2. **`ARROW_STREAM` is unusable in this environment.** Arrow measured 2.92 MiB (under the
   cap) and would have been the natural transport, but Databricks serves it via
   `EXTERNAL_LINKS` presigned URLs on `storage-proxy.databricks.com`, which is unreachable
   from here — it resolves to a sandbox egress proxy (`192.168.200.28`) and returns
   **HTTP 500 for every chunk, including for a trivial `SELECT 1`**. The app failed with
   `Failed to download chunk 0: 500 Internal Server Error`. This is an environment/egress
   limitation, not a query problem.

So the matrix is **columnar and windowed**: each metric is emitted as one comma-separated
string (no repeated JSON keys, no per-row brackets), and the day is fetched as 4 parallel
windows of 24 buckets. That keeps **full 15-minute resolution** at ~0.62 MiB per request.
Downsampling to hourly would also have fit (0.618 MiB) but would have destroyed the
resolution the animation exists to show.

Values are scaled to integers to shorten the strings (`speed × 2`, `v/c × 100`) and
level-of-service is derived client-side rather than sent, since it is a pure function of
speed and v/c.

**If a deployment has working `storage-proxy` egress, `ARROW_STREAM` becomes viable and
these queries can be simplified back to row-per-record.**

## Correctness verification

### Pacific-time correctness

Timestamps are stored UTC. `reading_date` was verified to **be the Pacific local date**,
not the UTC date — all 5,742,720 rows satisfy
`reading_date = to_date(from_utc_timestamp(time_bucket,'America/Los_Angeles'))`, while only
4,067,760 satisfy the UTC equivalent. So filtering on `reading_date` yields exactly 96
buckets of one clean local day *and* keeps the predicate on a bare partition column so
clustering still prunes.

Peak buckets, using the app's own `bucket_idx` formula:

| bucket | local time | total flow | avg speed |
|---:|---|---:|---:|
| 69 | **17:15** | 12,462,665 | 48.1 |
| 68 | **17:00** | 12,431,696 | 48.4 |
| 31 | **07:45** | 11,554,209 | 53.4 |
| 30 | **07:30** | 11,539,695 | 53.5 |

Both rush hours land where they should in **local** time.

### Every bucket checked against ground truth

A verification script decodes all 4 windows client-side and compares mean speed, total
flow, and incident count for **all 96 buckets** against a direct `GROUP BY` on the table:

```
time_matrix: 4 windows, total_json=2594727 (2.475 MiB), max_window=2.12s
  buckets checked=96 mismatches=0
  peak buckets by decoded flow:     [69, 68, 70, 67, 71, 66]
  slowest buckets by decoded speed: [69, 68, 70, 67, 71, 66]
```

This check exists because an earlier version was **silently wrong** — see
[the ARRAY_AGG trap](#the-array_agg-trap) below.

### H3 aggregation is real

Computed in the warehouse, resolution 5 (rolled up from the stored `h3_r7` with
`h3_toparent`), at the 17:00 peak bucket:

```
hex_count=239   cells_with_data=239
top cells at bucket 68 (17:00 PT), congestion %:
  8729a1c29ffffff  73   8729a0310ffffff  69   8729a4c48ffffff  69
  8729a1d2affffff  65   872830821ffffff  64
```

Cell IDs validate as genuine H3 cells at real California coordinates via `h3-js`
(`872811011ffffff` → 34.18 N, 118.20 W = the San Fernando Valley).

## What was verified visually

Ran locally against the live warehouse and driven with a real Chromium browser
(SwiftShader WebGL). Screenshots in the PR.

- **03:00 PT** — the freeway network draws uniformly **green**; KPIs read mean speed
  66.6 mph, total flow 2.38M veh/h, 0.0 % congested, 0 stations over capacity.
- **17:00 PT** — LA basin and Bay Area bloom **orange/red** with visibly extruded H3
  hexagons; KPIs read 48.4 mph, 12.43M veh/h, 32.2 % congested, 630 stations with
  v/c > 1, 55 active incidents. Worst corridors: I-405 38 mph, I-880 39 mph, I-210 42 mph.
- The KPI numbers match the SQL ground truth exactly (48.4 mph at bucket 68).
- California's shape is recognizable **with no basemap tiles at all** — the corridor
  PathLayer traces I-5, US-101, I-80 etc. through their own stations ordered by postmile.

## Basemap: no external dependency by default

Apps egress to external tile CDNs is unverified (`docs/ARCHITECTURE.md` R5). The **default
style issues zero network requests** — it is a solid background paint layer with no
`sources`, so the map is guaranteed to render regardless of egress policy. Geographic
legibility comes from the data itself.

An optional CARTO raster basemap can be toggled on in the Layers panel. If egress is
blocked the raster source simply fails and the data layers remain.

## Notable bugs found and fixed during validation

### The ARRAY_AGG trap

**`ARRAY_AGG` / `COLLECT_LIST` do not inherit a subquery's `ORDER BY`.** The first version
aggregated over an `ORDER BY bucket_idx, station_idx` subquery and produced scrambled
output: bucket 68 decoded to a mean speed of **64.80 mph when ground truth is 48.44** — the
17:00 rush hour silently vanished from the map while every individual value still looked
plausible. Fixed by collecting `(ord, value)` structs and `ARRAY_SORT`ing with an explicit
comparator. Cost of correctness: none measurable.

### Booleans arrive as strings

The SQL Statement API serialises every `JSON_ARRAY` value as a **string**, so a `BOOLEAN`
column arrives as `"false"` — which is **truthy in JavaScript**. Every weekday was being
labelled a weekend. `available_days.sql` now returns `is_weekend` as an `INT` 0/1.

### MapLibre CSS collapsed the map to zero height

`.maplibregl-map { position: relative }` from MapLibre's own stylesheet overrides a Tailwind
`absolute` utility on the same element, collapsing `inset-0` to a zero-height box. The
canvas stuck at its 300×150 default and the map rendered **blank while every KPI looked
correct**. Fixed with inline positioning plus a `ResizeObserver`.

### H3 at res 7 looked broken

Res-7 cells are ~5 km, and because stations only exist along freeway centrelines the
hexagons just retraced the corridor lines as sub-pixel specks — indistinguishable from the
station layer. Rolled up to res 5 (~25 km, 239 cells). Separately, raw `congestion_index` is
heavily skewed (p50 0.008 vs max 0.884), so a fixed elevation multiplier left every hexagon
flat; elevation is now normalised against the day's observed max.

## Running locally

```bash
npm install
npm run dev          # http://localhost:8000
npm run typegen      # regenerate TS types from config/queries/*.sql
npm run typecheck && npm run lint
npx playwright test tests/smoke.spec.ts
```

Requires a Databricks CLI profile with access to the warehouse; see `.env.example`.

## Resource binding

The warehouse ID is **never hardcoded in source**. `databricks.yml` declares it with
`permission: CAN_USE` (auto-granted to the app service principal on deploy) and `app.yaml`
injects it via `valueFrom: sql-warehouse` → `DATABRICKS_WAREHOUSE_ID`.

Note the analytics plugin's own default query timeout is **18 s**, unrelated to the
platform's 120 s ceiling. It is raised to 45 s in `server/server.ts` to absorb a warehouse
cold start while still surfacing a slow query as a renderable AppKit error rather than an
opaque proxy 504.

## Not done (M2 / M3)

Explicitly out of scope for this milestone:

- **M2 — the what-if engine.** No BPR volume-delay function, no incremental reassignment,
  no scenario levers (close a segment, ±% demand, inject an incident, change capacity), no
  before/after delta KPIs (VHT/VMT).
- **M3 — persistence + narration.** Lakebase is *not* wired (the provisioned
  `projects/caltrans-app` is untouched); no saved scenarios, no audit trail, no AI Gateway
  narration.

Seams left for them: all data access funnels through `client/src/lib/useTrafficData.ts`, the
only module naming a `queryKey`, and `baseline_capacity_vph` / `baseline_lanes` are already
in the geometry payload so the client can recompute v/c under a perturbed capacity without
refetching.

## Known weaknesses

- **Client bundle is 3.86 MB** (1.16 MB gzipped) — deck.gl and Arrow dominate. No code
  splitting; first load on a cold cache is slow.
- **Corridor filter refetches.** Changing corridor re-runs all 8 window queries even though
  the all-corridor payload already in memory is a superset. Geometry is correctly cached;
  the matrix is not.
- **`silver_stations_geo` has 2,022 stations but only 1,994 appear in `gold_map_frames`.**
  The 28 orphans are excluded so `station_idx` alignment holds. Root cause not
  investigated — it is upstream in the data generation.
- **Interpolation is linear** between 15-minute buckets; incidents snap to the nearer bucket
  rather than blending.
- **Smoke test's no-refetch assertion is timing-based** — it waits for the clock text to
  change and confirms the request count did not move. It would not catch a refetch
  triggered only after a longer delay.
- **Single hardcoded default day** (`2026-06-10`). If the underlying table is regenerated
  with a different date range, the app opens on an empty day rather than degrading.
- **WebGL verified only under SwiftShader** (software rasterisation) in a headless browser.
  Not tested on real GPU hardware or in Safari/Firefox.
- **H3 hexagons and stations overlap visually.** With both layers on, the hexagons can
  obscure station detail at high zoom; there is no automatic zoom-based layer switching.
