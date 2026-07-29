# Architecture Tab — Implementation Contract

Durable spec for the "Architecture" tab: an animated diagram of the Databricks
platform components this app actually uses, with LIVE status per node.

Written by the orchestrator from direct repo inspection. This file is the source of
truth for the task; it exists on disk so a sub-agent runner failure cannot erase the
contract. Ground every claim you add to it in `path:line` evidence.

## Why this exists

The user will PRESENT this tab to an audience. Two consequences drive every
requirement below:

1. **It must never be blank or broken on stage.** Topology is static and always
   renders; live status is layered on top and degrades to a grey "unknown" badge.
2. **It must never surprise-start compute.** A diagram tab that wakes a stopped SQL
   warehouse means a 5-minute spinner in front of an audience and an unexpected bill.

## Verified repo facts (from direct inspection)

Repo root: `caltrans-whatif/`. Stack: React 19 + TS client, Node server on
`@databricks/appkit` 0.38.1 + `@databricks/sdk-experimental` 0.17.0.

- `client/src/App.tsx` — already uses `react-router` v7 `createBrowserRouter`, with a
  single catch-all route `{ path: '*', element: <Layout /> }` rendering
  `<TrafficMapPage />` inside a `<main>`. Its docstring explicitly anticipates
  "sibling routes here". **`react-router` 7.13.0 is already a dependency — do not add a
  routing library.**
- `client/src/pages/map/TrafficMapPage.tsx` — the existing page-component pattern to
  mirror at `client/src/pages/architecture/`.
- `client/src/components/TrafficMap.tsx` — deck.gl + maplibre map instance.
- `server/server.ts` — `createApp({ plugins: [analytics({timeout:45_000}), serving(),
  lakebase(), server()], onPluginsReady(kit) })`; routes are registered inside
  `onPluginsReady` via `kit.server.extend((app) => ...)`, see
  `registerAdvisorRoutes(app, { db: kit.lakebase, analytics: kit.analytics,
  serving: kit.serving(), logger: console })`. **Register the new status route the same
  way, in the same place.**
- `server/advisor/routes.ts` — the route-module pattern to mirror.
- `app.yaml` — injects `DATABRICKS_WAREHOUSE_ID` (from `sql-warehouse`),
  `DATABRICKS_SERVING_ENDPOINT_NAME` (from `serving-endpoint`), `LAKEBASE_ENDPOINT`
  (from `postgres`), and `ADVISOR_SELF_URL`.
- `appkit.plugins.json` — declares the resource + permission each component needs:
  `sql_warehouse` CAN_USE, `serving_endpoint` CAN_QUERY, `postgres`
  CAN_CONNECT_AND_CREATE. Lakebase `PGHOST`/`PGPORT`/`PGDATABASE`/`PGSSLMODE` are
  platform-auto-injected at deploy time.
- `config/queries/*.sql` — 7 named queries: `available_days`, `corridor_options`,
  `h3_congestion_hexes`, `scenario_kpis`, `scenario_time_matrix`,
  `station_geometry`, `traffic_time_matrix`.
- `docs/` contains ONLY `WHATIF_ENGINE.md`. **There is no `docs/ARCHITECTURE.md`** —
  do not cite it.
- Gates: `npm run typecheck` (server+client tsc), `npm run lint` (eslint),
  `npm test` (`vitest run` + playwright smoke). Also `npm run format`.

## Task 1 — topology derivation (do this first, with evidence)

Do NOT trust the component list below as complete. Derive the real topology from the
repo and record it in this file's "Derived topology" section as you go, each node and
edge with `path:line` evidence. Expected nodes, to be confirmed/corrected:

- **Unity Catalog** — catalog/schema/tables actually referenced. Grep
  `config/queries/*.sql` for real table names (the header in `App.tsx` says
  `lanl.caltrans_traffic`; verify against the SQL, don't assume).
- **SQL Warehouse (DBSQL)** — via the appkit `analytics` plugin, 45s timeout, H3/geo
  functions in the queries.
- **Spark Declarative Pipeline** — confirm from `databricks.yml` whether an SDP
  pipeline is actually defined; if it is not, do NOT draw it as live.
- **Lakebase Postgres** — appkit `lakebase` plugin; `app` schema; migrations applied
  out of band from `lakebase/*.sql`; pooling + ~1h OAuth token refresh.
- **Model Serving / AI Gateway** — the advisor endpoint, custom streaming path in
  `server/advisor/model.ts` (note: the `serving()` plugin's own `/api/serving/stream`
  route is deliberately NOT used).
- **Databricks Apps host** — the runtime, its service-principal identity, the reverse
  proxy, and the SSE self-probe (`server/advisor/selfprobe.ts`).

Also derive the DATA FLOWS to animate. Expected: baseline map render, scenario
what-if run, AI advisor request, and the startup SSE probe.

## Task 2 — live status route (server)

ONE aggregated read-only endpoint: `GET /api/architecture/status`.

**Hard safety rules — these are non-negotiable:**

- **Read-only only.** No warehouse start/stop, no pipeline trigger/update, no
  serving-endpoint invocation, no DDL, no writes.
- **Never wake stopped compute.** Reading a warehouse's *state* via the control-plane
  GET is fine; issuing a query to determine liveness is NOT — that starts it. Same for
  the serving endpoint: read its state, never invoke it. If the only way to check a
  node is to wake it, that node reports `unknown` with a reason instead.
- **Per-node `try/catch`.** One node's 403/timeout must degrade THAT node to
  `unknown` and never fail the whole response. The route must return 200 with a
  complete node list even if every probe fails.
- **Bounded latency.** Per-probe timeout (~2-3s) and an overall budget; a slow
  control-plane call must not hang the tab. Cache results server-side (~15-30s TTL)
  so poll traffic and repeated tab visits don't amplify into API calls.
- **No secrets in the response.** No tokens, no full connection strings, no PATs.
  Warehouse ID / endpoint name / host are fine; treat anything credential-shaped as
  redacted.

Response shape (per node): stable `id`, `status` of
`healthy | degraded | unknown | not-configured`, a short human `detail`, optional
`latencyMs`, and `checkedAt`. Validate with `zod` (already a dependency).

**Auth reality to handle:** deployed, the app runs as a service principal with
injected client-credentials OAuth; locally it uses a CLI profile/PAT. A SP that can
run SQL often CANNOT read control-plane state (warehouse/pipeline GETs). So:

- Treat "no permission" as a FIRST-CLASS, EXPECTED outcome — render `unknown` with a
  detail like "control-plane read not permitted for this identity", never a fake green.
- **Never invent green.** A node whose status could not be determined is `unknown`.
  Fabricated health on a presentation diagram is the worst possible failure.
- Report which nodes needed a permission the identity lacks, so the user can decide
  whether to grant it.

## Task 3 — tabbed nav + animated diagram (client)

**Tabs.** Convert the single catch-all route into real sibling routes using the
existing `react-router` v7 setup: `Map` (default, existing `TrafficMapPage`) and
`Architecture`. Keep the existing header.

**CRITICAL — do not destroy the map on tab switch.** The deck.gl/maplibre instance is
expensive to recreate and holds animation state. Switching to Architecture and back
must not remount it or reset the animation clock: keep the map mounted and
hide/show it (e.g. CSS visibility/display on a persistent container), rather than
unmounting it via route swapping. Verify by switching tabs and confirming the map
resumes where it was, with no re-fetch storm.

**Diagram.** Nodes grouped by layer (data / compute / serving / app), edges showing
real data flow from Task 1.

- **CSS/SVG animation only — add NO new animation or diagram dependency.**
  `tailwindcss-animate` and `tw-animate-css` are already available.
- Animated flow along edges (moving dashes/particles) to show data movement.
- A stepped **walkthrough mode** that highlights one flow at a time — this is the
  presentation centerpiece.
- Click a node for a detail panel: what it is, what it's used for here, live status,
  and the evidence (file/query names).
- Live status badge per node, layered on the always-present static topology.
- **`prefers-reduced-motion`** must disable the looping animation.
- Responsive and readable on a projector: legible at large sizes, sane contrast in
  both light and dark themes (`next-themes` is in use).

**Polling.** Poll the status route on a polite interval (~15-30s), pause when the tab
is not visible, and never tight-loop or retry-storm on failure.

## Task 4 — tests + gates

- Unit-test the status aggregator's DEGRADATION behavior: a throwing/403 probe yields
  `unknown` for that node and a 200 overall with all nodes present. This is the
  demo-safety guarantee — it must be covered.
- Unit-test the topology definition (nodes/edges well-formed, no dangling edge
  endpoints) and any pure status-mapping helper.
- Client test for tab rendering; assert the map is NOT unmounted on tab switch.
- All gates green before opening the PR: `npm run typecheck`, `npm run lint`,
  `npm test`. Run `npm run format:fix` if formatting drifts.

## Acceptance contract (what review will judge)

1. Tabbed nav works; `Map` remains the default surface; the map instance survives tab
   switches without remount or animation reset.
2. Architecture tab renders the COMPLETE derived topology from static data even with
   zero live status available (no blank tab, no crash, no missing nodes).
3. Animation is CSS/SVG only, no new dependency, with a working stepped walkthrough
   and `prefers-reduced-motion` respected.
4. Exactly one aggregated status route; strictly read-only; per-node `try/catch`;
   cannot start/wake stopped compute; bounded per-probe timeout; cached; no secrets
   in the payload.
5. Unknown/failed status renders as an explicit grey "unknown" state — never a
   fabricated healthy node.
6. Topology and status claims are backed by `path:line` evidence recorded in this
   spec file's "Derived topology" section.
7. `npm run typecheck`, `npm run lint`, `npm test` all pass.
8. Its own branch, its own PR, not merged. No unrelated refactors.

## Derived topology

(The implementer fills this in during Task 1, with `path:line` evidence per node and
edge. Update this file in the same PR.)
