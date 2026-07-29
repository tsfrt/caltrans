# TOPOLOGY_EVIDENCE.md

Read-only investigation of the caltrans-whatif Databricks App. Every claim carries a
`path:line` citation. Determined **entirely by reading files** — no Databricks API call, no
SQL, no compute was touched. Where the repo does not support a claim, this file says
**"not found in repo"** rather than guessing.

> Method note: `docs/ARCHITECTURE.md` does **not** exist in this repo (`docs/` contains only
> `WHATIF_ENGINE.md` — verified by `find`). Two source files nonetheless *reference* it
> (`config/queries/station_geometry.sql:3`, `client/src/lib/useTrafficData.ts` comments). Those
> in-code references are noted where relevant but are **not** used as evidence, and the file is
> never cited as a live doc.

---

## SECTION 1 — COMPONENT TOPOLOGY

### 1. Unity Catalog (data plane — the traffic dataset)

**What it is.** The read-only source data for the map/advisor lives in Unity Catalog under
catalog `lanl`, schema `caltrans_traffic`.

**The REAL table identifiers actually referenced in SQL** (grepped across `config/queries/*.sql`
and `server/advisor/snapshot-sql.ts`; only two schema-qualified tables exist):

- `lanl.caltrans_traffic.gold_map_frames` — the per-station × 15-min-bucket fact table
  (~5,742,720 rows; one day of all corridors ≈ 191,424 rows). Referenced at:
  - `config/queries/available_days.sql:19`
  - `config/queries/corridor_options.sql:8`
  - `config/queries/h3_congestion_hexes.sql:49`
  - `config/queries/traffic_time_matrix.sql:63`
  - `config/queries/scenario_kpis.sql:251` and `config/queries/scenario_time_matrix.sql` (same `obs` CTE)
  - `config/queries/station_geometry.sql:35` (EXISTS subquery)
  - `server/advisor/snapshot-sql.ts:47` (shared `SNAPSHOT_CTE`)
- `lanl.caltrans_traffic.silver_stations_geo` — the static station geometry/attribute table
  (2,022 stations; 1,994 appear in `gold_map_frames`). Referenced at:
  - `config/queries/station_geometry.sql:33`
  - `config/queries/scenario_kpis.sql:216` and `scenario_time_matrix.sql:222` (`geo` CTE)

**Verifying the App.tsx header claim.** `client/src/App.tsx:21` shows the badge
`lanl.caltrans_traffic · DBSQL + H3`. That names the **catalog.schema**, not a table. It is
**consistent** with the SQL: every query reads `lanl.caltrans_traffic.gold_map_frames` and/or
`lanl.caltrans_traffic.silver_stations_geo`. There is no table literally named
`lanl.caltrans_traffic` — the header is a schema label, and it is accurate. (Also referenced as a
schema label in `server/scenario/params.ts:27`.)

**Grants required (control-plane note, from README, not executed).** The warehouse `CAN_USE`
binding does **not** grant UC data access; the SP needed explicit `USE SCHEMA` + `SELECT` on
`lanl.caltrans_traffic` (`README.md:517`–`537`), and `lanl` grants `USE CATALOG` to `account
users` (`README.md:539`).

### 2. SQL Warehouse / DBSQL (AppKit `analytics` plugin)

**What it is.** A DBSQL SQL Warehouse, accessed through AppKit's `analytics` plugin. The
warehouse ID is injected, never hardcoded.

**How this app uses it.**
- Plugin registered: `server/server.ts:15` — `analytics({ timeout: 45_000 })`.
- Configured timeout: **45,000 ms (45 s)** (`server/server.ts:15`). The plugin default is 18 s
  (`server/server.ts:5`–`13` comment; `README.md:596`–`599`); raised to 45 s to absorb a
  Serverless Starter cold start while staying inside the platform's non-configurable 120 s
  request ceiling.
- Warehouse ID wiring: declared `permission: CAN_USE` in `databricks.yml:27`–`31`
  (`sql-warehouse` resource, `id: ${var.sql_warehouse_id}`), value `688f49c732cf9083`
  (`databricks.yml:58`); injected as `DATABRICKS_WAREHOUSE_ID` via `valueFrom: sql-warehouse` in
  `app.yaml` (the `DATABRICKS_WAREHOUSE_ID`/`valueFrom: sql-warehouse` block).
- Client query route: the browser hooks call `useAnalyticsQuery(<queryKey>, params)` from
  `@databricks/appkit-ui/react` (`client/src/lib/useTrafficData.ts:2,68,74,86,278,290`), which
  the analytics plugin serves at `POST /api/analytics/query/<key>` (documented in
  `server/advisor/snapshot-sql.ts:6`–`10`).
- Server-side (advisor) queries run through `AppKit.analytics.query(text, params)` with typed
  `sql.*` markers (`server/advisor/context.ts` `buildSnapshotContext`, `sql.date/string/int` at
  the `params` object; `snapshot-sql.ts:9`–`11`).

**Geo / H3 SQL functions the queries ACTUALLY use** (verified by grepping for function-call
syntax `NAME(`; alias/prose false positives excluded):
- **H3 builtins actually called:**
  - `h3_toparent(h3_r7, 5)` — rolls stored r7 cells up to res 5 (`h3_congestion_hexes.sql:58`,
    rationale `:10`–`18`).
  - `h3_h3tostring(...)` — BIGINT→canonical hex string, required by deck.gl H3HexagonLayer
    (`h3_congestion_hexes.sql:58`; `station_geometry.sql:29`,`:30` for `h3_r7`/`h3_r8`).
  - **`h3_h3celltostring` is explicitly NOT used** — it does not exist on this warehouse/channel
    (`UNRESOLVED_ROUTINE`), documented at `h3_congestion_hexes.sql:20`–`21` and
    `station_geometry.sql:28`.
- **Stored H3 columns read:** `h3_r7` (`h3_congestion_hexes.sql:58`, `station_geometry.sql:29`),
  `h3_r8` (`station_geometry.sql:30`). The table also stores r9 (mentioned
  `h3_congestion_hexes.sql:11`) but r9 is not selected.
- **Spatial builtins actually called:** `ST_DistanceSphere(a.geom, b.geom)` for parallel-corridor
  diversion distance (`scenario_kpis.sql:393,399,405` and the matching `cand` CTE in
  `scenario_time_matrix.sql`). Note `ST_Distance` is deliberately **avoided** — it returns planar
  DEGREES on this channel and is unusable for metres (`scenario_kpis.sql:353`–`354`).
- Time bucketing (not geo, but load-bearing): `from_utc_timestamp(time_bucket,
  'America/Los_Angeles')` for Pacific-local bucket derivation, in every fact query
  (`h3_congestion_hexes.sql:55`–`56`, `traffic_time_matrix.sql:78`–`79`,
  `snapshot-sql.ts:41`–`43`, `scenario_kpis.sql:230`).

**The 7 client-facing query keys** (`config/queries/*.sql`): `available_days`,
`corridor_options`, `station_geometry`, `traffic_time_matrix`, `h3_congestion_hexes`,
`scenario_time_matrix`, `scenario_kpis`. The advisor's 4 aggregate queries
(`NETWORK_SQL`/`CORRIDOR_SQL`/`LOS_SQL`/`INCIDENT_SQL`) are **server-only**, executed via
`analytics.query()` and deliberately not exposed as client keys (`snapshot-sql.ts:3`–`11`).

### 3. Spark Declarative Pipeline (SDP)

**NOT DEFINED IN THIS REPO — must not be drawn as a live component.**

- `databricks.yml` declares only `resources.apps` (`databricks.yml:15`) plus three app resources
  (`sql_warehouse`, `serving_endpoint`, `postgres` — `databricks.yml:24`–`44`). There is **no**
  `resources.pipelines` / Lakeflow / DLT / declarative-pipeline stanza (grep for
  `pipeline|lakeflow|dlt|declarative` in `databricks.yml` → none).
- The `gold_*` / `silver_*` medallion table names imply an upstream pipeline produced them, but
  **no pipeline definition, notebook, or transform code exists in this repo.** The data is
  consumed read-only. Draw it, if at all, as an external/out-of-scope producer — not a live
  component of this app.

### 4. Lakebase Postgres (AppKit `lakebase` plugin — chat persistence)

**What it is.** A Lakebase (Databricks Postgres) database used to persist advisor chat sessions,
messages, recommendations, and an audit log. Accessed via AppKit's `lakebase` plugin, which also
handles connection pooling and ~1h-TTL OAuth token refresh (the Postgres password)
(`server/server.ts:37`–`43`).

**How this app uses it.**
- Plugin registered: `server/server.ts:44` — `lakebase()`.
- Resource binding: `databricks.yml:38`–`44` — resource key `postgres` (NOT the retired
  `database` key, `databricks.yml:33`–`37`), `permission: CAN_CONNECT_AND_CREATE`, branch
  `projects/caltrans-app/branches/production`, database
  `.../databases/databricks-postgres` (`databricks.yml:60`–`61`).
- Env wiring: only `LAKEBASE_ENDPOINT` is set explicitly (`app.yaml` `valueFrom: postgres`);
  `PGHOST/PGPORT/PGDATABASE/PGUSER/PGSSLMODE` are platform-injected when the `postgres` resource
  is attached (`app.yaml` comment; `.env.example:16`–`31`; `appkit.plugins.json` lakebase
  field `localOnly`/`platform` origins).

**Schema / tables used** (all in schema `app`, from `server/advisor/store.ts`):
- `app.advisor_sessions` — one row per chat; anchor + `snapshot_kpis JSONB`
  (`store.ts` `createSession` INSERT ~`:150`; `SESSION_COLUMNS`).
- `app.advisor_messages` — full transcript incl. `role='system'` brief rows
  (`store.ts` `appendMessage` / `listMessages`).
- `app.advisor_recommendations` — shredded structured recommendations, `ON DELETE CASCADE`
  (`store.ts` `insertRecommendations` / `deleteSession`).
- `app.audit` — shared audit log (`store.ts` `audit()` INSERT; also written by the SSE probe).
- Trigger `trg_advisor_sessions_touch` sets `updated_at`; `touchSession` fires it with a no-op
  UPDATE (`store.ts` `touchSession`).
- Health route probes writability with `has_table_privilege('app.advisor_sessions','INSERT')`
  (`server/advisor/routes.ts` health handler).

**Where migrations live.** **NOT in this repo.** `store.ts:6`–`19` and `server/server.ts:52`–`61`
state migrations are applied "out of band" from `lakebase/*.sql`, and reference
`lakebase/README.md` + `lakebase/grants_advisor.sql`. **No `lakebase/` directory exists here**
(verified by `find` / `ls`). The `app` schema is owned by a human user
(`thomas.seufert@databricks.com`, `store.ts:9`), not the SP; `CAN_CONNECT_AND_CREATE` alone is
insufficient and explicit GRANTs are required, which is why the app does **no** startup schema
bootstrap (`server/server.ts:52`–`61`; `README.md:321`–`347`).

### 5. Model Serving / AI Gateway (AppKit `serving` plugin + custom streaming)

**What it is.** A Databricks Model Serving `llm/v1/chat` endpoint backing the AI Congestion
Advisor. Endpoint name is injected, never hardcoded.

**How this app uses it.**
- Endpoint binding: `databricks.yml:32`–`36` — `serving-endpoint`, `permission: CAN_QUERY`
  (auto-granted to the SP on deploy); value `databricks-claude-sonnet-5`
  (`databricks.yml:56`–`57`). Injected as `DATABRICKS_SERVING_ENDPOINT_NAME` via `valueFrom:
  serving-endpoint` (`app.yaml`; resolved by `resolveEndpointName()` at
  `server/advisor/model.ts:60`–`72`, which throws if unset).
- Plugin registered: `server/server.ts:33` — `serving()`.

**What IS used vs what is deliberately NOT** (the key nuance):
- `server/server.ts:18`–`31` states the `serving()` plugin is registered for exactly two things,
  **neither of which is its streaming route**: (1) `AppKit.serving().invoke()` — the
  non-streaming fallback; (2) its **resource declaration**, which is what injects the
  `serving_endpoint` `CAN_QUERY` requirement into the bundle.
- The plugin's own `POST /api/serving/stream` route is **NOT used** — it is a raw byte pipe over
  the *client's* request body, so the server never observes the generated text and could neither
  build the prompt from DBSQL nor persist the answer (`server/server.ts:26`–`31`;
  full reasoning `server/advisor/model.ts:1`–`45`; `README.md:246`–`262`).
- **What IS used for streaming:** a custom call in `server/advisor/model.ts`. `streamModel()`
  (`model.ts:~205`) uses `getExecutionContext().client.apiClient.request({ raw: true })` to POST
  `/serving-endpoints/<name>/invocations` with `Accept: text/event-stream`, `stream: true`,
  `stream_options.include_usage: true`, then parses SSE via `iterateSse()` / `parseSseData()`
  (`model.ts` ~`155`–`235`). The non-streaming fallback is `invokeModel()` →
  `serving.invoke({...})` (`model.ts:~330`).
- Request body carries only `messages`, `max_tokens`, `stream` — **no** `temperature`/`top_p`,
  because newer reasoning endpoints reject them (`model.ts` "WHY NO temperature" comment;
  `README.md:263`–`281`). `DEFAULT_MAX_TOKENS = 3000` (`model.ts` const).
- The SSE envelope the client sees is the advisor's OWN event types (`delta`/`done`/`error`),
  not the model's, because the client needs the persisted message id, usage, and server-parsed
  recommendations (`server/advisor/routes.ts:19`–`40`).

### 6. Databricks Apps host (runtime + reverse proxy + SSE self-probe)

**What it is.** The Databricks Apps platform hosting the Node server behind an OIDC/SSO reverse
proxy.

**How this app uses it.**
- Runtime: `app.yaml` `command: ['npm', 'run', 'start']` — Node server on `@databricks/appkit`
  (`server/server.ts`). Public URL
  `https://caltrans-whatif-7474656503943141.aws.databricksapps.com` (`app.yaml` `ADVISOR_SELF_URL`
  value; `README.md:509`).
- Reverse proxy: injects `x-forwarded-email` for the authenticated user; the app reads it in
  `currentUser()` (`server/advisor/routes.ts` `currentUser`, ~`:88`–`96`). The proxy is an
  OIDC/SSO proxy that returns 302→sign-in for `GET /` and 401 for `/api/*` to non-OAuth callers
  (`server/advisor/selfprobe.ts:7`–`14`; `README.md:551`–`572`, `648`–`661`).
- **SSE self-probe** (`server/advisor/selfprobe.ts`): at startup the container mints a
  client-credentials OAuth token (`mintOAuthToken`, `selfprobe.ts:40`–`63`, POST
  `${host}/oidc/v1/token` with `scope=all-apis`), then `GET`s its own public URL
  `${ADVISOR_SELF_URL}/api/advisor/diag/sse` so the request traverses the real proxy
  (`probeSseThroughProxy`, `selfprobe.ts:68`–`160`), measures chunk arrival spread
  (`streaming = chunks > 1 && spreadMs > 700`, `selfprobe.ts:~150`), and writes the verdict to
  `app.audit` (`recordSseProbe`, `selfprobe.ts:166`–`200`). Fire-and-forget, 5 s startup delay,
  skipped when `ADVISOR_SELF_URL` unset or no SP credentials.
- The `/api/advisor/diag/sse` endpoint being probed emits 10 ticks 300 ms apart with
  `X-Accel-Buffering: no` (`server/advisor/routes.ts` diag handler).
- Per README the deployed verdict is currently `{"verdict":"unavailable","status":401}` because
  the SP holds no `CAN_USE` on the app itself, so the probe's own call is rejected by the proxy
  (`README.md:560`–`572`). SSE-through-proxy therefore **remains unmeasured**; the client
  degrades safely to non-streaming (`README.md:574`–`585`).

### Plugins actually registered (for completeness)

Only four AppKit plugins are registered in `server/server.ts:14`–`45`: `analytics`, `serving`,
`lakebase`, `server`. **Not registered:** `agents`, `files`, `genie`, `jobs` (all present in
`appkit.plugins.json` but unused here — grep of `server/server.ts` confirms no
`jobs(`/`genie(`/`files(`/`agents(`).

---

### DATA FLOWS

#### A. Baseline map render (M1) — hits the warehouse

1. Browser mounts `TrafficMapPage` (`client/src/pages/map/TrafficMapPage.tsx`) → hooks in
   `client/src/lib/useTrafficData.ts`.
2. `useAnalyticsQuery('available_days')`, `('corridor_options')`, `('station_geometry')`
   (`useTrafficData.ts:68,74,86`) → `POST /api/analytics/query/<key>` → AppKit `analytics`
   plugin → **DBSQL warehouse** → `lanl.caltrans_traffic.*`.
3. `useAnalyticsQuery('traffic_time_matrix')` and `('h3_congestion_hexes')`
   (`useTrafficData.ts:278,290`), each fetched as **4 parallel 24-bucket windows**
   (`useTrafficData.ts:29`–`31`; `frames.ts:22`) → warehouse → columnar packed payloads under
   AppKit's 1 MiB SSE event cap.
4. Client decodes/joins by shared `station_idx` ordering (`ORDER BY station_id`) and animates —
   **nothing queries the warehouse during animation** (the central performance rule,
   `README.md:69`–`96`, `station_geometry.sql:2`–`6`).

Chain: **Browser → Apps proxy → Node/AppKit analytics → SQL Warehouse → Unity Catalog.**

#### B. Scenario what-if run (M2) — DOES NOT hit the warehouse in this worktree

- The scenario is computed **client-side by a mock**: `applyMockScenario()`
  (`client/src/lib/scenario.ts:196`+) applies levers to the in-memory baseline `FrameMatrix`.
  It is explicitly **NOT** a real traffic model (`scenario.ts:12`–`62` "MOCK BOUNDARY").
- The expected server route `POST /api/scenario/run` **does not exist / is not wired**
  (`scenario.ts:22`, `:208`). No Express route registers it (grep of `server/server.ts` and
  `server/advisor/routes.ts` for `scenario` → none).
- The DBSQL scenario **engine exists on disk but is unwired**: `server/scenario/run.ts`
  (`runScenarioWindow`/`runScenarioDay`/`runScenarioKpis`, `run.ts:52`–`86`) would call
  `analytics.query(SCENARIO_MATRIX_QUERY|SCENARIO_KPI_QUERY, ...)` against
  `config/queries/scenario_time_matrix.sql` / `scenario_kpis.sql`
  (`server/scenario/contract.ts:248`–`249`) — **but nothing imports or routes `run.ts`.**

Chain (live): **Browser (in-memory mock) only.** The warehouse-backed engine
(`server/scenario/** + scenario_*.sql`) must be drawn as **present-but-not-wired**, not as a live
scenario data flow.

#### C. AI advisor request — warehouse + serving + Lakebase

Create session (`POST /api/advisor/sessions`, `routes.ts` create handler):
1. Browser → Apps proxy → `POST /api/advisor/sessions`.
2. `buildSnapshotContext(analytics, {day,bucket,corridor})` runs the 4 aggregate queries in
   parallel via `analytics.query()` → **DBSQL warehouse** → `gold_map_frames`
   (`context.ts` `buildSnapshotContext`; `snapshot-sql.ts`).
3. `resolveEndpointName()` reads the injected serving endpoint name (`routes.ts`; `model.ts:60`).
4. `createSession()` + `appendMessage(role='system', brief)` → **Lakebase** `app.advisor_sessions`
   / `app.advisor_messages` (`store.ts`).

Send a turn (`POST /api/advisor/sessions/:id/messages`, `routes.ts` messages handler):
1. Persist user turn → **Lakebase** (`appendMessage role='user'`).
2. `buildMessages()` rebuilds system prompt + snapshot brief + transcript (`routes.ts`
   `buildMessages`).
3. Stream: `streamModel(endpointName, {messages})` → custom `apiClient.request({raw:true})`
   `POST /serving-endpoints/<name>/invocations` → **Model Serving endpoint**
   (`model.ts` `streamModel`); deltas relayed to client as SSE `delta` events.
   Fallback (`stream:false`): `invokeModel()` → `serving.invoke()`.
4. On stream end: parse recommendations, `appendMessage(role='assistant')` +
   `insertRecommendations()` + `touchSession()` → **Lakebase**; emit `done` event
   (`routes.ts` `finish`).

Chain: **Browser → Apps proxy → Node/AppKit → {SQL Warehouse (context), Model Serving (LLM),
Lakebase (persist)}.**

#### D. Startup SSE probe — Apps proxy loopback + Lakebase

1. On `onPluginsReady`, `recordSseProbe(kit.lakebase, console)` fires (`server/server.ts:79`;
   `selfprobe.ts:166`).
2. After 5 s, `mintOAuthToken()` client-credentials grant → workspace OIDC `/oidc/v1/token`
   (`selfprobe.ts:40`–`63`).
3. `GET ${ADVISOR_SELF_URL}/api/advisor/diag/sse` with the OAuth bearer → **out through the real
   Apps reverse proxy and back into this same container** (`selfprobe.ts:83`–`101`); measures
   chunk spread.
4. Verdict written to **Lakebase** `app.audit` via `audit()` (`selfprobe.ts:183`–`191`;
   `store.ts` `audit`).

Chain: **Node container → OIDC token → Apps proxy → own `/api/advisor/diag/sse` → Node → Lakebase
`app.audit`.**

---

## SECTION 2 — LIVE STATUS FEASIBILITY

The deployed app runs as a **service principal (SP)** with client-credentials OAuth. The resource
bindings in `databricks.yml` grant **data-plane** permissions (`CAN_USE` warehouse, `CAN_QUERY`
endpoint, `CAN_CONNECT_AND_CREATE` postgres) — these do **not** imply control-plane read
(`GET`/status) permissions. Feasibility below reflects that gap.

| Component | SDK method / REST path to read STATUS | Permission that call requires | Does the deployed SP plausibly have it? |
|---|---|---|---|
| SQL Warehouse | `GET /api/2.0/sql/warehouses/{id}` (`WarehousesAPI.get`) → returns `state` (STARTING/RUNNING/STOPPED) | `CAN_MANAGE` (or workspace admin) on the warehouse for control-plane GET | **No — NEEDS EXPLICIT GRANT.** Binding is `CAN_USE` (`databricks.yml:29`–`31`), which permits running queries but generally **not** the control-plane GET. Grant needed: **`CAN_MANAGE` on warehouse `688f49c732cf9083`** to the app SP. |
| SQL Warehouse (safe alt) | `GET /api/2.0/sql/warehouses` list, filter by id | Same as above | Same limitation. Prefer inferring "reachable" from a completed benign metadata query rather than control-plane state — but even a query wakes compute (see FORBIDDEN). |
| DBSQL / query health | (Statement Execution API) | `CAN_USE` warehouse + UC `SELECT` | Yes for *running* a query, but running any statement **can wake a stopped warehouse** → FORBIDDEN for a status route. |
| Model Serving endpoint | `GET /api/2.0/serving-endpoints/{name}` (`ServingEndpointsAPI.get`) → `state.ready`, `state.config_update` | `CAN_VIEW` (or `CAN_MANAGE`) on the endpoint for control-plane GET | **Uncertain — likely NEEDS EXPLICIT GRANT.** Binding is `CAN_QUERY` (`databricks.yml:34`–`36`). `CAN_QUERY` permits invocation but does **not** reliably confer the control-plane GET. Grant needed: **`CAN_VIEW` on endpoint `databricks-claude-sonnet-5`** to the app SP. |
| Lakebase Postgres | `SELECT 1` over the pooled pg connection (the app's own `db.query`) | `CAN_CONNECT_AND_CREATE` (already held) + connectivity | **Yes.** `routes.ts` health already does `SELECT 1 AS n` and `has_table_privilege(...)`. This is a data-plane read on an already-open pool and does **not** wake external compute. Lakebase branch/endpoint *control-plane* status (`databricks postgres get-*`) is a separate, likely-ungranted call — prefer the in-pool `SELECT 1`. |
| Lakebase (control-plane) | `databricks postgres list-endpoints/get-branch` (REST under `/api/2.0/postgres/...`) | Postgres project/branch view permission | **Uncertain — likely NEEDS EXPLICIT GRANT;** unnecessary if the in-pool `SELECT 1` is used instead. |
| Databricks Apps host | `GET /api/2.0/apps/{name}` (`AppsAPI.get`) → `app_status`, `compute_status` | `CAN_MANAGE`/admin on the app | **No — NEEDS EXPLICIT GRANT.** README states the SP holds **no `CAN_USE` on the app itself** (`README.md:568`–`572`), so it cannot even self-probe through the proxy, let alone read app control-plane status. Grant needed: **`CAN_MANAGE` (or at least `CAN_USE`) on app `caltrans-whatif`** to the app SP. |
| SSE-through-proxy verdict | Read latest `app.audit` row where `action='advisor.diag.sse_through_proxy'` | `CAN_CONNECT_AND_CREATE` + read on `app.audit` | **Yes (data-plane), given the schema GRANTs** the advisor already needs (`README.md:321`–`347`). This is the intended status source and touches no compute. |
| SDP pipeline | n/a | n/a | **N/A — no pipeline defined** (Section 1.3). A status route must **not** invent a pipeline GET. |

**Summary of grants to name explicitly** (all currently plausibly missing for status reads):
- Warehouse control-plane GET → grant **`CAN_MANAGE`** on warehouse `688f49c732cf9083`.
- Serving endpoint control-plane GET → grant **`CAN_VIEW`** on `databricks-claude-sonnet-5`.
- Apps host control-plane GET / self-probe → grant **`CAN_USE`/`CAN_MANAGE`** on app
  `caltrans-whatif` (confirmed missing today, `README.md:568`–`572`).
- Lakebase status is fine via the already-open pool (`SELECT 1`); avoid control-plane pg calls.

### ⚠️ FORBIDDEN CALLS — MUST NEVER appear in a status route

These would **start/wake stopped compute** or **mutate state**. This is a safety guardrail for
whoever implements a status/health route.

**Would wake or start compute (never call from a status probe):**
1. Any Statement Execution API call / `analytics.query(...)` against the SQL Warehouse — running
   *any* SQL wakes a stopped Serverless warehouse. (Includes all 7 `config/queries/*.sql`, the 4
   advisor `*_SQL` aggregates, and the scenario `*.sql`.)
2. `POST /api/2.0/sql/warehouses/{id}/start` (`WarehousesAPI.start`) — explicit warehouse start.
3. Any Model Serving **invocation**: `POST /serving-endpoints/{name}/invocations`
   (both the custom `streamModel` path in `model.ts:~210` and `serving.invoke()`), and the AppKit
   `POST /api/serving/stream` route — invoking wakes/scales a scaled-to-zero endpoint.
4. Triggering the (nonexistent) scenario engine `POST /api/scenario/run` or calling
   `runScenarioWindow/Day/Kpis` — would issue the heavy scenario SQL and wake the warehouse.
5. Any pipeline start/trigger (`POST /api/2.0/pipelines/{id}/updates`, jobs `run-now`) — no
   pipeline/job is defined here, but a status route must not invent one.
6. The SSE self-probe `GET .../api/advisor/diag/sse` is cheap but is a **loopback HTTP call
   through the proxy**; do not treat it as a lightweight status check and do not fan it out.

**Would mutate state (never call from a read-only status route):**
7. Any `INSERT/UPDATE/DELETE` on Lakebase — `createSession`, `appendMessage`,
   `insertRecommendations`, `touchSession`, `deleteSession`, `audit` (`store.ts`). A status route
   may only `SELECT`.
8. Warehouse `edit`/`stop`/`delete`, serving-endpoint `update`/`delete`, app `deploy`/`start`/
   `stop`, or any UC grant mutation.

**Safe reads for a status route:** control-plane `GET`s **only if the grants above exist**
(warehouse GET, serving GET, app GET); the in-pool Lakebase `SELECT 1` / `has_table_privilege`;
and reading the latest `app.audit` SSE-probe row. Prefer these; degrade gracefully (report
"unknown/insufficient permission") when a control-plane GET returns 403/401 rather than
attempting anything from the forbidden list.

### AUTH MODEL — local (CLI/PAT) vs deployed (SP client-credentials OAuth)

**Deployed identity.** The Apps platform injects `DATABRICKS_CLIENT_ID` /
`DATABRICKS_CLIENT_SECRET` (`selfprobe.ts:52`–`54`), and the app authenticates as its **service
principal** via **client-credentials OAuth** (`mintOAuthToken`, `selfprobe.ts:40`–`63`, scope
`all-apis`). The user's identity for advisor sessions comes from the proxy-injected
`x-forwarded-email` header (`routes.ts` `currentUser`; `.env.example:33`–`34`). Warehouse/endpoint/
postgres env vars are injected via `app.yaml` `valueFrom:` + platform auto-injection.

**Local identity.** A **Databricks CLI profile / PAT** is used (`README.md:495`–`505`;
`.env.example`). There is **no** SP OAuth locally, and **no reverse proxy**. `currentUser()` falls
back to `ADVISOR_DEV_USER` (or `local-dev@localhost`) because `x-forwarded-email` is absent
(`routes.ts` `currentUser`, ~`:88`–`96`; `.env.example:33`–`35`). Lakebase env vars
(`PGHOST`…`LAKEBASE_ENDPOINT`) must be set by hand locally (`.env.example:16`–`31`).

**Which identity a status route gets:**
- **Deployed:** the SP OAuth identity (control-plane GETs subject to the SP's grants — see the
  table; most control-plane reads currently need explicit grants).
- **Local:** the developer's CLI/PAT identity, which typically has broader workspace permissions
  than the SP — so a status route that "works locally" may **fail in deployment** on the exact
  control-plane GETs the SP lacks. Do not conclude feasibility from local behavior.

**Deployed-only constructs that must degrade safely when run locally:**
- The SSE self-probe (`selfprobe.ts`): `mintOAuthToken()` returns `null` when
  `DATABRICKS_CLIENT_ID/SECRET` are absent → probe records `verdict:'unavailable'` and no-ops;
  also skipped when `ADVISOR_SELF_URL` unset (`selfprobe.ts:57`,`:170`–`174`). ✔ degrades safely.
- `x-forwarded-email` user identity → falls back to `ADVISOR_DEV_USER` locally
  (`routes.ts` `currentUser`). ✔ degrades safely.
- Any control-plane status GET using SP OAuth: locally there is no SP OAuth token; such a route
  must not assume `DATABRICKS_CLIENT_ID/SECRET` exist and must fall back to the CLI/PAT auth chain
  or report "status unavailable (local)" rather than throwing.
- Note the 401 nuance (`README.md:551`–`572`, `648`–`661`): from outside the workspace, PAT auth
  is rejected by the SSO proxy (`GET /` → 302 sign-in; `/api/*` → 401), and `databricks apps logs`
  requires OAuth — so external status polling of the deployed app is not viable on PAT; in-app
  self-reporting (audit row) is the reliable channel.

---

*End of evidence. Anything a status/diagram effort needs that is NOT in this repo: the SDP/medallion
pipeline definition, the `lakebase/` migrations + grants SQL, and `docs/ARCHITECTURE.md` — all
absent here and must not be drawn/cited as present.*
