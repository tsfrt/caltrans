# California Traffic What-If Modeling — Architecture Decision Record

**Workspace:** `fevm-serverless-stable-blj52t.cloud.databricks.com` (AWS, serverless)
**Warehouse:** `688f49c732cf9083` — "Serverless Starter Warehouse", Small, PRO, Photon, channel `CURRENT`, dbsql `2026.20`
**Date:** 2026-07-27
**Status:** proposed — awaiting sign-off

---

## 1. Verified environment facts

Everything in this section was empirically confirmed against the live workspace, not assumed.

| Capability | Status | Notes |
|---|---|---|
| DBSQL geospatial | ✅ Fully available | 97 `st_*` + 40 `h3_*` builtins on channel **CURRENT**. Preview channel **not** required. |
| Native `GEOMETRY` columns | ✅ Persistable in Delta | Verified `CREATE TABLE ... geom GEOMETRY(4326)` → INSERT → read back. **Must** parameterize SRID. |
| Databricks Apps | ✅ Enabled | 2 apps live. `inflation-chatbot-dev` already binds this warehouse `CAN_USE`. |
| Model Serving / AI Gateway | ✅ Enabled | 44 endpoints: 39 chat FM, 3 embedding, 2 agent. |
| Writable UC target | ✅ `lanl.caltrans_traffic` | `CREATE SCHEMA` in `lanl` succeeded. Schema created. |
| California traffic data | ❌ **Does not exist** | Zero Caltrans/PeMS/detector/road-network tables in any catalog. |
| Lakebase | ❌ **No instance** | Both `postgres list-projects` and legacy `database list-database-instances` empty. Must be provisioned. |
| UC REST API | ❌ Denied for our identity | `catalogs list` → "Access denied to clusters that don't have Unity Catalog enabled". |
| GitHub push | ❌ No credentials | No `gh` CLI, no push creds. PRs cannot be opened from this environment. |

### 1.1 Hard constraints discovered

These are non-obvious and would otherwise be rediscovered the hard way.

1. **Bare `GEOMETRY` / `GEOGRAPHY` type names fail.** `CAST(NULL AS GEOMETRY)` → `UNSUPPORTED_DATATYPE (0A000)`. `CAST(NULL AS GEOMETRY(4326))` works. Always parameterize the SRID.
2. **ST predicates and measures reject `GEOGRAPHY`.** `ST_Distance`, `ST_Contains`, `ST_Intersects`, `ST_DWithin`, `ST_DistanceSphere` all require `GEOMETRY` and fail on `GEOGRAPHY` with `DATATYPE_MISMATCH.UNEXPECTED_INPUT_TYPE (42K09)`. The bundled `databricks-dbsql` skill's GEOGRAPHY-first examples are **wrong for this channel**.
3. **`ST_Distance` / `ST_Area` / `ST_Length` return planar degrees**, not meters. Use `ST_DistanceSphere` / `ST_DistanceSpheroid` for real-world distance.
4. **H3 functions take WKT string/binary, never `GEOGRAPHY`.** Wrap with `ST_AsText()`. `h3_center` does not exist — use `h3_centeraswkt`.
5. **All DDL and metadata discovery must go through SQL** (`information_schema`, `SHOW`), because the UC REST API is denied.
6. **Apps enforce a non-configurable 120-second request timeout**, and SSE may be buffered by the reverse proxy. Long-running work must not sit inside one request.
7. **Lakebase credentials expire in ~1 hour.** Never use a PAT as the Postgres password; recycle physical connections at ~45 min (`max_lifetime=2700`) or mint per-connection.
8. **Deploy the app *before* initializing Lakebase schemas**, or the app service principal won't own them → `permission denied (42501)`.

---

## 2. The five architecture decisions

| # | Decision | Runner-up (why not) |
|---|---|---|
| 1 | **AppKit** (TypeScript/React + Vite client, typed Express server), scaffolded via `databricks apps init` | FastAPI + React — same runtime, but you hand-roll typegen, caching, pooling, token refresh. Streamlit/Dash rejected for animation (see §2.1). |
| 2 | **Geometry once + numeric time-matrix once + 100% client-side animation.** MapLibre basemap under a deck.gl overlay. | Pre-baked vector tiles — static tiles can't express live what-if mutation. kepler.gl — opaque state, can't cleanly drive a scenario slider. |
| 3 | **BPR volume-delay + damped incremental reassignment, as chained CTEs in one parameterized DBSQL query.** Runs **in DBSQL**. | ML model in UC via serving — no credible training label, adds latency and opacity. |
| 4 | **Lakebase for app config + saved scenarios**, pooled with token-refresh-aware connections. | Raw per-request psycopg → connection storms. |
| 5 | **AI Gateway via OpenAI-compatible streaming** for scenario narration. | `ai_query()` in SQL for interactive narration — no streaming, occupies the warehouse. Still useful for *batch* pre-narration. |

### 2.1 Why not Streamlit

Three structural blockers for an animated app, all documented in the bundled Apps skill:

1. **Streamlit re-runs the entire script on every interaction.** A 24-frame time slider = 24 full script re-executions. No path to smooth animation.
2. **The OBO token from `x-forwarded-access-token` never refreshes.** The documented workaround is a full page refresh — which resets the animation.
3. **Connection exhaustion causes multi-minute freezes** unless every connection is cached.

Dash avoids the rerun model but animates via per-frame server round-trips, and deck.gl support is an unofficial wrapper. Rejected.

---

## 3. The central performance rule

> **Nothing queries the warehouse during animation.**

Three queries fire per scenario run; the animation loop then reads only typed arrays already in browser memory. This is the only design that survives a **Small** warehouse. It will answer a scenario query in ~1–2s — but it will never answer 24 queries in the ~400ms a smooth scrub demands, and each query burns DBUs.

| Payload | Fetched | Approx size |
|---|---|---|
| Network geometry (simplified LineStrings) | Once per session, immutable | 1.5–2.5 MB |
| Baseline time-matrix (`segment × hour × metrics`) | Once per session | few MB as typed arrays |
| Scenario delta | Once per scenario run | small |

---

## 4. Data foundation — synthetic, PeMS-shaped

There is no California traffic data in the workspace, and nothing in `samples` can substitute (the only point geometry anywhere is NYC taxi trips and 50 global weather cities).

**Decision: generate synthetic PeMS-shaped data via a Spark Declarative Pipeline**, keeping the schema PeMS-faithful so a later swap to real data is a schema no-op.

Rejected alternatives:
- **Real Caltrans PeMS** — requires per-user account registration and manual web-form extraction; not scriptable from here; tens of GB/year.
- **CARTO Overture via Delta Sharing** — `carto.overturemaps_transportation` is already federated in the metastore and gives *real* CA road geometry, but has **no traffic volumes or speeds**. It's a basemap, not a time series. Good later enhancement: snap synthetic stations onto true centerlines.

### 4.1 Medallion shape (target `lanl.caltrans_traffic`)

- **Bronze** — `stations` (detectors along real I-5 / I-405 / US-101 / I-80 / SR-99 corridors, `GEOMETRY(4326)` + H3 res 7/8/9), `station_readings` (5-min flow/occupancy/speed), `incidents`.
- **Silver** — cleaned + enriched: v/c ratio, level-of-service A–F, delay vs free-flow, congestion flags.
- **Gold** — pre-aggregated animation table (hourly or 15-min buckets) + corridor summary + `baseline_capacity` fields the what-if engine perturbs.

Generation must be *physically plausible*, not random noise: AM (7–9) and PM (16–19) peaks, weekday/weekend profiles, directional commute asymmetry, and a proper speed-flow relation (free-flow ~65mph degrading as occupancy rises).

---

## 5. Component diagram

```
            ┌──────────────────────────── Databricks App (AppKit) ───────────────────────────┐
            │  client/ React + Vite                                                          │
 Browser ───┤    MapLibre basemap  ←overlay─  deck.gl (H3Hexagon + Path + Trips + Arc)       │
            │    useAnimationClock (rAF)  →  interpolate typed arrays in memory              │
            │  server/ typed Express                                                         │
            │    config/queries/*.sql  →  generated TS row types                             │
            └───┬───────────────────────┬────────────────────────────┬──────────────────────-┘
                │ CAN_USE               │ CAN_CONNECT_AND_CREATE     │ CAN_QUERY
                ▼                       ▼                            ▼
        DBSQL warehouse           Lakebase (Postgres)         AI Gateway / Serving
        688f49c732cf9083          scenarios, config, audit    chat FM endpoint
                │                                                   
                ▼                                                   
     Unity Catalog: lanl.caltrans_traffic                          
       bronze → silver → gold   (built by SDP)                     
```

---

## 6. Top risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **No GitHub credentials** — PRs cannot be opened; work strands on local branches. | Needs human action: supply creds or accept local-branch delivery. |
| R2 | **Lakebase does not exist** and costs money to provision (0.5 CU min, scale-to-zero). | Requires explicit human go-ahead before provisioning. |
| R3 | **120s Apps request timeout + SSE buffering** could break streaming narration. | Keep scenario queries well under the limit; verify SSE empirically before committing to streaming UX. |
| R4 | **Small warehouse** may not sustain 52M-row generation or concurrent demo load. | Parameterize row volume; start at 30 days; pre-aggregate Gold aggressively. |
| R5 | **Basemap egress** — Apps network egress for external tile providers is unconfirmed. | Self-host a MapLibre style, or verify egress before depending on a CDN. |

---

## 7. Phased build order

**Milestone 1 — thinnest end-to-end vertical slice that still demos animation + geo**
1. SDP generates synthetic stations + readings into `lanl.caltrans_traffic` (bronze→silver→gold). *(in progress)*
2. AppKit app scaffolded, bound to the warehouse, rendering stations on a MapLibre + deck.gl map.
3. Client-side 24-hour animation driven by the pre-aggregated Gold table.

**Milestone 2 — the what-if engine**
4. BPR volume-delay + reassignment as a parameterized DBSQL query.
5. Scenario levers: close a segment, ±% corridor demand, inject an incident, change capacity.
6. KPI panel: VHT, VMT, worst-N segments, before/after deltas.

**Milestone 3 — persistence + narration**
7. Provision Lakebase; saved scenarios, config, audit *(gated on R2 approval)*.
8. AI Gateway narration of scenario deltas, streamed into the UI.
9. Optional: mount `carto.overturemaps_transportation` to snap stations to true highway centerlines.

---

## 8. Open decisions needed from the human

1. **Provision Lakebase?** Incurs cost. Blocks Milestone 3.
2. **GitHub credentials?** Without them there is no PR deliverable.
3. **Is `lanl` an acceptable home** for the traffic schema, or should a dedicated catalog be created?
