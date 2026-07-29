# California Traffic What-If

Animated geospatial UI over DBSQL, plus an **AI Congestion Advisor** that assesses the
snapshot on screen and recommends congestion-relief actions, with the chat persisted in
Lakebase. See [AI Congestion Advisor](#ai-congestion-advisor).

Animated geospatial UI over DBSQL. One Pacific-local day of California freeway traffic
(1,994 detector stations × 96 fifteen-minute buckets) rendered as a MapLibre + deck.gl map
that animates entirely client-side.

**Scope:** M1's animated baseline plus the AI advisor. The what-if *engine* (M2 — BPR volume
delay, scenario levers, before/after deltas) is NOT built: the advisor recommends, it does not
simulate. See [Not done](#not-done-m2).

---

## Stack

| Layer | Choice |
|---|---|
| Framework | **AppKit** 0.38.1 (TypeScript/React + Vite client, typed Express server) |
| Map | MapLibre GL 5 basemap + deck.gl 9 overlay (`H3HexagonLayer`, `ScatterplotLayer`, `PathLayer`, `ColumnLayer`) |
| Data | `lanl.caltrans_traffic.gold_map_frames` (5,742,720 rows) + `silver_stations_geo` |
| Compute | SQL warehouse `688f49c732cf9083` (Serverless Starter, Small, PRO, Photon) |
| Animation | `requestAnimationFrame` clock over flat typed arrays — zero queries during playback |
| LLM | Model Serving `databricks-claude-sonnet-5` (configurable — `valueFrom: serving-endpoint`) |
| Chat storage | Lakebase Postgres 17.10, `projects/caltrans-app` / `production` |

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
│   ├── components/AdvisorPanel.tsx# chat panel (sibling of the map, collapsible)
│   ├── lib/useAdvisor.ts          # advisor data seam + SSE transport negotiation
│   ├── lib/advisorText.ts         # fence stripping + action labels
│   ├── components/TimeControls.tsx
│   ├── components/KpiPanel.tsx
│   └── pages/map/TrafficMapPage.tsx
├── server/
│   ├── server.ts                  # analytics + serving + lakebase + server plugins
│   └── advisor/                   # AI Congestion Advisor (server side)
│       ├── snapshot-sql.ts        #   4 DBSQL rollups of ONE bucket
│       ├── context.ts             #   pure brief formatter (+ tests)
│       ├── prompt.ts              #   system prompt + closed action vocabulary
│       ├── model.ts               #   streaming + non-streaming transport
│       ├── recommendations.ts     #   fenced-JSON parser (lenient shape, strict vocab)
│       ├── store.ts               #   Lakebase persistence (+ tests)
│       ├── routes.ts              #   /api/advisor/*
│       └── selfprobe.ts           #   SSE-through-proxy diagnostic
├── app.yaml / databricks.yml     # warehouse bound CAN_USE via valueFrom
└── tests/smoke.spec.ts           # Playwright smoke (map + advisor selectors)
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

## AI Congestion Advisor

Reads the snapshot **currently on the map**, assesses it with a Model Serving LLM, and
recommends congestion-relief actions. The whole chat is persisted in Lakebase, anchored to the
traffic state that produced it.

Open it from the map's side panel ("Ask the AI Congestion Advisor"). It is a collapsible flex
**sibling** of the map, never an overlay: opening it narrows the map so the animation and KPIs
stay visible while you read the advice. Closed, the M1 layout is unchanged.

### Snapshot-context strategy

A snapshot is one 15-minute Pacific-local bucket — 1,994 stations at full resolution. Handing
that to a model raw would be ~1,994 rows x ~15 fields, which it would neither read nor be able
to cite reliably. So four rollups run **in parallel** in DBSQL and are rendered into one small
labelled-text brief:

| Rollup | Shape | Contents |
|---|---|---|
| network | 1 row | mean/min speed, mean+max v/c, stations over capacity, LOS-congested count, demanded vs served flow, mean delay/mi |
| corridor | ≤8 rows | worst corridor-**directions** by mean delay per mile |
| LOS | ≤6 rows | level-of-service histogram |
| incidents | ≤12 rows | severity, lanes blocked, location, speed, v/c |

**Measured: 4,338 bytes / 4,418 prompt tokens** for an all-corridor PM-peak snapshot;
2,704 prompt tokens for a single corridor off-peak. DBSQL time for all four: **3.8 s** cold.

Three deliberate choices in the brief:

- **Ordered by delay per mile, not raw speed.** Delay normalises against each corridor's own
  free-flow speed, so an urban corridor at 45 mph and a rural one at 45 mph are not treated as
  equally broken.
- **Unserved demand is pre-computed** (`demanded − served`, plus its share of demand).
  Arithmetic is exactly what models get wrong, so it is done in code and labelled.
- **A truncated incident list says so.** The network rollup supplies the true total, so 12
  listed out of 55 can never read as "the network has 12 incidents".

The queries live in `server/advisor/snapshot-sql.ts`, not `config/queries/`, because they are
only ever consumed server-side on the way into a prompt — exposing them as client query keys
would widen the app's public surface for no caller.

### Prompt design

The failure mode being defended against is not refusal — it is a confident, well-structured
assessment containing numbers that are not in the data. Three mechanisms, in descending order
of how much they actually help:

1. **The context is small and complete.** Nothing else is retrievable, so there is nothing to
   half-remember. This does most of the work.
2. **An explicit citation rule with a stated fallback** — "when the data does not support a
   recommendation, say so and name what you would need". A prohibition without an alternative
   just gets ignored.
3. **A fenced JSON block** whose fields are closed vocabularies, so a recommendation that does
   not fit the schema surfaces as `other` rather than being silently reshaped.

The system prompt states explicitly that the data is **synthetic** (told the network is real, a
model blends real-world I-405 knowledge with the supplied numbers, and that blend is
indistinguishable from a hallucination downstream), that **v/c is DEMAND-based** so `v/c > 1`
is genuine oversaturation rather than a data error, that speeds are mph and times Pacific
local, and that a single bucket is not a trend.

### Real model output, with number verification

`databricks-claude-sonnet-5`, snapshot `2026-06-10 17:00 PT`, all corridors:

> This is a severe, network-wide PM peak breakdown, not an isolated event. 636 of 1,994
> stations (31.9%) are at LOS F, mean v/c is 0.891 network-wide but every listed worst corridor
> is oversaturated (v/c 0.94–1.27 mean), and total unserved demand is 1,093,916 veh/h (8.1% of
> demand). 55 stations have active incidents […] notably I-680 S (severity 4, 4/6 lanes
> blocked, speed 8.0 mph, v/c 4.01 at postmile 9.5) […]
>
> - **I-210 W** has no incident stations (0/52) yet 51/52 stations are over capacity with delay
>   1.027 min/mi — this looks like pure recurrent demand saturation, not incident-driven, so
>   incident clearance won't help here; only demand-management or metering is applicable.
>
> What I cannot support from this data: I have no ramp volumes, no queue lengths, no incident
> duration/ETA, and no arterial/transit capacity data, so I can't size the effect of ramp
> metering in mph or vehicles/hour […] I'm also not claiming any trend — this is one 15-minute
> bucket.

**Verification: all 42 distinct numeric tokens in that response appear verbatim in the
supplied brief.** Checked mechanically by extracting every number-like token from the response
and matching against the context — not by eye.

On a free-flow snapshot (`03:00 PT`, I-210) it **correctly declines to recommend anything**,
emits no recommendation block, and names the three things it would need. Its 16 numeric tokens
also all trace to the brief, apart from `100` (from "LOS A: 104 (100.0%)") and `1.0` (the
definitional v/c threshold, not a data claim).

### Structured recommendations — the M2 seam

Recommendations are rendered as cards, visually distinct from prose, and shredded into
`app.advisor_recommendations` rows. `action_type` is CHECK-constrained to a closed vocabulary
so M2 can switch on it exhaustively, and `scenario_id` is the (deliberately unconstrained)
hook for "this recommendation became a scenario run".

`magnitude` is nullable **and usually null** — the UI prints "not quantified" rather than
hiding it, because forcing a number would invite the model to invent one, and M2 must not read
a missing magnitude as zero. `target_corridor` NULL while `target_label` is set means the model
named something unresolvable, which is exactly what M2 must refuse to auto-run.

### Streaming is negotiated, not assumed

The Apps platform guide says SSE "may be buffered" by the reverse proxy. Shipping a
token-by-token UX that silently collapses into a 20-second blank screen in production is the
exact failure mode to avoid, so the client **measures** instead of assuming: on load it calls
`/api/advisor/diag/sse` (10 ticks, 300 ms apart) and decides on the **arrival spread** of the
chunks — not the total duration, since a buffering proxy still takes ~2.7 s to deliver.

| Verdict | Transport | UI |
|---|---|---|
| spread > 700 ms over >1 chunk | `POST … {stream:true}` | live deltas, `streaming` badge |
| otherwise | `POST … {stream:false}` | determinate "consulting the model" state, `buffered` badge |

Both paths persist identically and record `transport` per message. **Measured locally: 338
incremental deltas over 18.7 s (TTFB 3.7 s) — genuine streaming.** Through the deployed proxy:
see [Deployment](#deployment).

### Why the built-in `/api/serving/stream` is not used

AppKit's `serving()` plugin exposes two very different capability levels:

- `AppKit.serving(alias).invoke(body)` — programmatic, server-side, returns `usage`.
- `POST /api/serving/stream` — a **raw byte pipe**: `pipeline(Readable.fromWeb(rawStream), res)`
  over *the client's own request body*. `exports()` returns `{ invoke, asUser }` only; there is
  **no programmatic `stream()`**.

So the built-in stream route cannot build the prompt server-side (the browser would have to
supply it — and it does not even have the aggregates), cannot persist the reply (nothing in
that path ever observes the text), and cannot record latency or tokens. Hence a custom
streaming route over `getExecutionContext().client` + `apiClient.request({ raw: true })` — the
same primitives the plugin uses internally. The plugin stays registered for `invoke()` and,
importantly, for its **resource declaration**, which is what puts the `serving_endpoint`
CAN_QUERY requirement into the bundle.

### Model parameters: no `temperature`, no `top_p`

Newer models on this workspace **reject** sampling parameters rather than ignoring them:

```
databricks-claude-sonnet-5  temperature -> BAD_REQUEST "does not support the temperature parameter"
databricks-claude-sonnet-5  top_p       -> BAD_REQUEST "does not support sampling..."
databricks-gpt-5-5          temperature -> "Unsupported value: 'temperature'..."
databricks-claude-haiku-4-5 both        -> OK
```

Since the endpoint is operator-configurable via `app.yaml`, sending one would make the advisor
fail hard on a perfectly valid model choice — at first use, not at deploy time. The request
body carries only `messages`, `max_tokens`, `stream`.

`max_tokens` is **3000**, raised from 1600 after a real all-corridor assessment came back
`finish_reason: "length"` with the recommendation block cut mid-object (only 2 of the intended
recommendations survived the parser's truncation salvage).

### Latency and cost per assessment

| Stage | All corridors, PM peak | One corridor, off-peak |
|---|---|---|
| DBSQL (4 rollups, parallel) | 3.8 s | 1.5 s |
| Model TTFB | 3.7 s | — (non-streaming) |
| Model total | 18.2 s | 9.6 s |
| Prompt tokens | 4,418 | 2,704 |
| Completion tokens | 1,600 (capped; now 3,000) | 531 |

**~6k tokens per assessment**, dominated by the prompt. A follow-up turn costs the brief again
(it must be replayed — it is the only place the numbers live) plus the transcript, so a long
conversation grows linearly; there is no summarisation. Per-turn `prompt_tokens`,
`completion_tokens`, and `latency_ms` are persisted on every message row, so cost is measured
from the data rather than estimated.

### Lakebase schema

`lakebase/002_schema_advisor.sql` (idempotent; applied out of band, not from app startup).

| Table | Purpose |
|---|---|
| `app.advisor_sessions` | One row per chat. Anchor (`reading_date`, `bucket_idx`, `local_hour`, `local_time`, `corridor`) **plus** `snapshot_kpis JSONB` — an immutable copy of the aggregates the model saw. |
| `app.advisor_messages` | One row per turn: role, content, `model_endpoint`, token counts, `latency_ms`, `finish_reason`, `transport`, and the verbatim `recommendations JSONB`. Indexed `(session_id, created_at)`. |
| `app.advisor_recommendations` | One row per discrete recommendation, FK to session + message, `ON DELETE CASCADE`. |

**Why the snapshot is denormalised onto the session:** a recommendation is only meaningful
against the traffic state that produced it. The underlying table is synthetic and can be
regenerated, so re-deriving KPIs at read time would silently re-anchor an old chat to different
numbers and the transcript would stop matching its own evidence.

**Why recommendations are a table *and* a JSONB column:** the JSONB is the verbatim model
payload; the rows exist because their consumer differs from the transcript's. M2 needs a stable
per-recommendation identity to attach a scenario lifecycle to (you cannot FK to an element
inside a JSONB array), and cross-session analytics is a `GROUP BY` over typed columns rather
than an unnest of every message ever sent.

Session create and message send also append to the existing `app.audit`.

### ⚠️ The Lakebase resource binding is NOT sufficient — the SP also needs schema GRANTs

`CAN_CONNECT_AND_CREATE` lets the app's service principal connect and create **its own**
objects. It grants nothing on a schema someone else owns — and `app` was created by
`thomas.seufert@databricks.com`, not the SP. Without `lakebase/003_grants_advisor.sql`, every
advisor write fails with `permission denied for schema app` (SQLSTATE 42501) — **at runtime, in
the deployed app only.** Local development runs as the schema owner and works perfectly, so the
feature looks complete right up until it is deployed.

Ordering matters, because the SP's Postgres role does not exist until the first bundle deploy
that attaches the `postgres` resource:

```
1. scripts/lakebase/apply.sh schema           # 001 + 002, one transaction
2. databricks bundle deploy                   # provisions the SP's Postgres role
3. scripts/lakebase/apply.sh grants           # defaults to production SP role
4. GET /api/advisor/health  ->  "canWriteSessions": true
```

Verified after step 3 — all seven tables in `app` report `t` for SELECT/INSERT/UPDATE/DELETE by
the SP, and schema USAGE + CREATE are granted. The grant file includes `GRANT USAGE, SELECT ON
ALL SEQUENCES`, without which the *first audit write* fails on `audit_id_seq` — again only at
runtime.

`GET /api/advisor/health` reports the live answer via `has_table_privilege`, so this is
checkable in any deployment rather than inferred from this one.

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

## Basemap: bundled by default, zero external requests (measured)

Apps egress to external tile CDNs is unverified (`docs/ARCHITECTURE.md` R5), so the app
**does not depend on it**. `OFFLINE_STYLE` in `client/src/lib/mapStyle.ts` is a
self-contained style with `sources: {}` — a single `background` paint layer, no tiles, no
glyphs URL (no text layers, so none is needed). It is what `TrafficMap.tsx` passes to
`new maplibregl.Map({ style: ... })`, and `useExternalBasemap` defaults to `false`.

**Measured, not assumed.** Instrumenting the page and counting every request whose URL is
not `localhost:8000`:

```
EXTERNAL (non-localhost) REQUESTS with default settings: 0

After enabling the "External basemap" toggle:  26 cartocdn requests
  https://c.basemaps.cartocdn.com/dark_all/6/10/25@2x.png   ...
```

So the deployed map **cannot** render blank due to blocked tile egress in its default
configuration — there are no tiles to fetch. Geographic legibility comes from the data: a
`PathLayer` traces each corridor through its own stations ordered by postmile.

The CARTO raster basemap is strictly opt-in. If egress is blocked, that source fails and the
data layers remain, so the degradation is a missing backdrop rather than a broken map.

## Colour scale: clamped on speed, not on v/c

`vc_ratio` in this dataset reaches a **max of 7.8163** while p99 is only 1.147, so any scale
keyed linearly on v/c would saturate and look flat. This app is not exposed to that:

- **Nothing in the render path keys on `vc_ratio`.** Colour comes from `speedToColor(speed)`.
  `vc` is used only for *counting* (`vc > 1` → the "Over capacity" KPI) and for the LOS
  threshold in `losFromSpeedAndVc`, neither of which is a continuous visual scale.
- `speedToColor` clamps explicitly: `t = Math.max(0, Math.min(1, (65 - speed) / 45))`.
  Verified across the full observed range (min 8.0 mph → free-flow 66.6 mph) plus
  out-of-range guards:

  | speed | rgb | | speed | rgb |
  |---|---|---|---|---|
  | 8 | `235,22,0` (clamped red) | | 55 | `149,191,63` |
  | 20 | `235,22,0` | | 65 | `64,209,90` (green) |
  | 48.4 | `205,179,46` | | 80 | `64,209,90` (clamped) |
  | | | | −50 / NaN | clamped red / grey |

- **Hex elevation** is the one place a magnitude *is* scaled, and it normalises against the
  window's observed max (`congestion / max(observedMax, 0.05) * 45000`), so the ratio is
  bounded to `[0, 1]` and a skewed distribution can't flatten it. The `0.05` floor prevents a
  divide-by-zero on an all-free-flow corridor.

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

## Deployment

Deployed and **RUNNING**: <https://caltrans-whatif-7474656503943141.aws.databricksapps.com>

```
app_status:        RUNNING   ("App is running")
compute_status:    ACTIVE
active_deployment: SUCCEEDED ("App started successfully")
```

### ⚠️ The warehouse binding is NOT sufficient — the SP also needs UC grants

`databricks.yml` auto-grants the app service principal `CAN_USE` on the **warehouse**, but
that says nothing about **Unity Catalog data access**. The first deploy therefore failed
outright:

```
Error: Type generation failed: 5 queries could not be described:
available_days, corridor_options, h3_congestion_hexes, station_geometry,
traffic_time_matrix.
```

All five failing — including the trivial `corridor_options` — is the signature of a
permissions problem, not SQL syntax. `SHOW GRANTS ON SCHEMA lanl.caltrans_traffic` listed no
`SELECT` for any principal but the owner. Fix, scoped to just this app's SP:

```sql
GRANT USE SCHEMA ON SCHEMA lanl.caltrans_traffic TO `<app-service-principal-client-id>`;
GRANT SELECT     ON SCHEMA lanl.caltrans_traffic TO `<app-service-principal-client-id>`;
```

Get the client ID from `databricks apps get <app> -o json | jq -r .service_principal_client_id`.
(`lanl` already grants `USE CATALOG` to `account users`, so no catalog-level grant was
needed here.)

After the grants, the deploy succeeded. That success is itself the proof the SP can read the
data: `prebuild` runs `appkit generate-types`, which is **fatal** and issues
`DESCRIBE QUERY` for all five queries using the SP's own credentials — so
`Building app... → App started successfully` cannot happen unless every query resolves.

Separately, `postinstall: npm run typegen` was made non-fatal. Generated types are committed,
so regenerating them at install time is an optimisation; a missing grant should surface as a
renderable query error in the UI rather than bricking startup before the server boots.

### ⚠️ SSE through the deployed proxy is UNVERIFIED

The one question this milestone could not answer. Databricks Apps sits behind an OIDC/SSO proxy
and this environment has only PAT auth, so `GET /` returns the sign-in page and `/api/*` returns
**401 with or without a bearer token**; `databricks apps logs` also requires OAuth
(`OAuth Token not supported for current auth type pat`). So no external client here can observe
the deployed app's streaming behaviour.

An in-app self-probe was built to close that gap from the inside
(`server/advisor/selfprobe.ts`): the container mints an OAuth token from its injected
`DATABRICKS_CLIENT_ID`/`SECRET`, calls its **own public URL** so the request traverses the real
proxy, measures chunk arrival spread, and writes the verdict to `app.audit`. The mechanism works
end to end — token minted, audit row written — but the verdict is:

```json
{"verdict":"unavailable","status":401,
 "detail":"HTTP 401 — the proxy did not pass the request through"}
```

The app's own service principal holds no `CAN_USE` on the app, so the proxy rejects it.
Granting it would rewrite the deployed app's permission ACL, which was outside the scope
authorised for this change, so **it was not done and SSE-through-proxy remains unmeasured.**

To finish the measurement, someone with app-admin rights should either grant the SP `CAN_USE`
on `caltrans-whatif` and restart it (then read the audit row), or simply open the app in an
SSO browser session and watch whether the advisor's text appears incrementally.

**This is mitigated, not ignored.** The client never assumes streaming: it probes
`/api/advisor/diag/sse` on load and falls back to non-streaming `invoke` with a determinate
loading state, so a buffering proxy degrades to a slower-but-correct UX rather than a blank
screen. The fallback path is **exercised and verified**, not merely written — see the off-peak
assessment above, which ran with `transport: "invoke"` in 9.6 s.

**Also not verified:** the deployed *UI* has still never been rendered by a browser, for the
same auth reason. All UI verification (screenshots, streaming growth, history reload) was done
against the **local** dev server hitting the **same live warehouse, the same serving endpoint,
and the same Lakebase instance**.

## Resource binding

The warehouse ID is **never hardcoded in source**. `databricks.yml` declares it with
`permission: CAN_USE` (auto-granted to the app service principal on deploy) and `app.yaml`
injects it via `valueFrom: sql-warehouse` → `DATABRICKS_WAREHOUSE_ID`.

Note the analytics plugin's own default query timeout is **18 s**, unrelated to the
platform's 120 s ceiling. It is raised to 45 s in `server/server.ts` to absorb a warehouse
cold start while still surfacing a slow query as a renderable AppKit error rather than an
opaque proxy 504.

## Not done (M2)

Explicitly out of scope:

- **The what-if engine now exists** — BPR volume-delay + damped incremental (MSA)
  reassignment as one parameterized DBSQL query, all four scenario levers, and before/after
  VHT/VMT/v/c/speed/delay/LOS deltas per station and per corridor. See
  **[docs/WHATIF_ENGINE.md](docs/WHATIF_ENGINE.md)**;
  `config/queries/scenario_{time_matrix,kpis}.sql` are generated from
  `tools/scenario_sql/engine.py` and bound by `server/scenario/`. Two caveats that matter:
  `MAX_ITERS` is 4 even though the measured evidence says MSA has **not** converged there, and
  **the advisor still recommends rather than simulates** — it is prompted to phrase effects as
  reasoned expectations rather than computed predictions, so it cannot imply it ran the engine.
- **Wiring the advisor to the engine.** The seam is in place on both sides —
  `app.advisor_recommendations` carries action + target + magnitude + a null `scenario_id`, and
  `server/scenario/contract.ts` is the request shape it would populate — but nothing consumes
  it. `app.scenarios` / `app.scenario_runs` remain unused.
- **No conversation summarisation.** The snapshot brief is replayed on every turn, so prompt
  cost grows linearly with transcript length.
- **No cross-snapshot comparison.** The advisor is told a single bucket is not a trend and
  refuses to claim direction of change; comparing two snapshots would need a second brief and a
  different prompt.

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
  Not tested on real GPU hardware, in Safari/Firefox, or inside the deployed container.
- **`vc_ratio`'s 7.8163 outlier is not surfaced anywhere.** It cannot distort the colour scale
  (which is speed-keyed and clamped), but a station at v/c 7.8 is reported identically to one
  at v/c 1.01 in the "Over capacity" count. A future severity breakdown should bucket it.
- **H3 hexagons and stations overlap visually.** With both layers on, the hexagons can
  obscure station detail at high zoom; there is no automatic zoom-based layer switching.
- **The hosted app's UI is unverified — this is the single biggest gap.** The deployment is
  RUNNING and the service principal provably resolves all five queries, but **no browser has
  ever rendered the deployed page.** `GET /` returns `302 → /oidc/oauth2/v2.0/authorize`
  *with or without* a PAT bearer token, and `POST /api/analytics/query/*` returns 401;
  `databricks auth login` needs an interactive browser, and `databricks apps logs` requires
  OAuth (`OAuth Token not supported for current auth type pat`). Every screenshot and KPI
  figure in this README comes from the **local** dev server hitting the **same live
  warehouse**. What is proven about the deployment is that it builds, starts, serves, and can
  read the data — *not* that its map paints. **Someone with SSO should open the URL and
  confirm the map renders with data.** The basemap is bundled with zero external requests, so
  tile egress is not a plausible failure mode there, but WebGL-in-that-container is untested.
- **The UC grant is a live change to shared infrastructure**, applied at the schema level to
  the app SP. It was required to make the app work at all, but reviewers should confirm it
  matches their access policy.
- **SSE through the deployed proxy is unmeasured** (401 for the SP; ACL change not authorised).
  The negotiated fallback means production cannot silently break, but whether deployed users get
  token-by-token or a single blob is genuinely unknown. This is the biggest gap in this change.
- **`x-forwarded-email` is trusted for identity.** Sessions are scoped by it, so it is also the
  authorisation boundary. That header is injected by the Apps proxy and cannot be spoofed
  through it, but the app does no verification of its own — running this off-platform, or behind
  a misconfigured proxy, would make session isolation forgeable. There is no sharing model and
  no row-level security.
- **The advisor's own numbers were verified mechanically for two snapshots, not exhaustively.**
  Zero hallucinated tokens across a PM-peak all-corridor assessment (42 distinct numbers) and an
  off-peak single-corridor one (16). That is strong evidence, not a guarantee: the check is
  string containment, so a number that appears in the brief but is *misattributed* to the wrong
  corridor would pass. Spot-reading the two responses found no such misattribution, but no
  automated check enforces it.
- **The recommendation parser is lenient by design**, so a malformed block degrades to "prose
  only" and the structured cards silently disappear. `finish_reason` and a server-side warn log
  are the only signals; the UI does not tell the user a block failed to parse.
- **Only one model was exercised end to end** (`databricks-claude-sonnet-5`). The endpoint is
  configurable and the code avoids model-specific parameters, but the prompt's fenced-block
  compliance is unverified on GPT-5.5 / Gemini / Haiku.
- **The SSE self-probe adds a startup HTTP call** to the app's own public URL. It is
  fire-and-forget and guarded, but it is a diagnostic shipped in production code, gated only by
  `ADVISOR_SELF_URL`.
- **`app.advisor_messages.content` is unbounded TEXT** and stores every assistant turn in full
  alongside its brief. Nothing prunes old sessions.
- **Both Lakebase migrations are applied by hand.** There is no migration runner and no schema
  version table, so a deployment can run against a stale schema and fail at first write.
- **A stale-window guard now silently drops mismatched payloads.** The corridor-switch crash is
  fixed by filtering windows whose station/hex count disagrees with the current geometry. That
  is correct, but if a genuine future bug made counts disagree permanently, the map would render
  empty rather than throwing — quieter, and harder to notice.
