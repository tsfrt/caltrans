export type TopologyLayer =
  | 'ingest'
  | 'storage+governance'
  | 'compute'
  | 'serving+AI'
  | 'app';

export type TopologyLiveness = 'live-capable' | 'static-only';

export type TopologyFlowId =
  | 'baseline-map-render'
  | 'scenario-whatif-run'
  | 'ai-advisor-request'
  | 'startup-sse-probe';

export type TopologyNode = {
  id: string;
  label: string;
  layer: TopologyLayer;
  vendorService: string;
  description: string;
  evidence: string;
  liveness: TopologyLiveness;
  honestNote?: string;
};

export type TopologyEdge = {
  from: string;
  to: string;
  label: string;
  flowId: TopologyFlowId;
};

export const topologyNodes: TopologyNode[] = [
  {
    id: 'databricks-apps-host',
    label: 'Databricks Apps host runtime',
    layer: 'app',
    vendorService: 'Databricks Apps',
    description: 'Hosts the React client and Node/AppKit backend runtime for this app.',
    evidence: 'app.yaml:13',
    liveness: 'live-capable',
  },
  {
    id: 'apps-oidc-reverse-proxy',
    label: 'Apps OIDC reverse proxy',
    layer: 'app',
    vendorService: 'Databricks Apps Proxy',
    description: 'Front-door auth proxy that gates requests and forwards identity headers.',
    evidence: 'server/advisor/selfprobe.ts:7',
    liveness: 'live-capable',
  },
  {
    id: 'browser-client',
    label: 'Browser map client',
    layer: 'app',
    vendorService: 'React + deck.gl',
    description: 'Loads baseline traffic datasets and renders the animated map.',
    evidence: 'client/src/pages/map/TrafficMapPage.tsx:8',
    liveness: 'live-capable',
  },
  {
    id: 'scenario-client-mock',
    label: 'What-if run (client-side mock)',
    layer: 'app',
    vendorService: 'Client simulation',
    description: 'Scenario run uses applyMockScenario over in-memory baseline frames.',
    evidence: 'client/src/lib/scenario.ts:196',
    liveness: 'static-only',
    honestNote: 'Current what-if execution is local mock logic, not a live backend run.',
  },
  {
    id: 'unity-catalog-traffic',
    label: 'Unity Catalog traffic tables',
    layer: 'storage+governance',
    vendorService: 'Databricks Unity Catalog',
    description: 'Queries read lanl.caltrans_traffic datasets for map and scenario analytics.',
    evidence: 'config/queries/traffic_time_matrix.sql:35',
    liveness: 'live-capable',
  },
  {
    id: 'lakebase-postgres',
    label: 'Lakebase Postgres app schema',
    layer: 'storage+governance',
    vendorService: 'Databricks Lakebase',
    description: 'Stores advisor threads, messages, feedback, and audit probe records.',
    evidence: 'server/advisor/routes.ts:153',
    liveness: 'live-capable',
  },
  {
    id: 'dbsql-warehouse',
    label: 'DBSQL warehouse analytics engine',
    layer: 'compute',
    vendorService: 'Databricks SQL Warehouse',
    description: 'AppKit analytics plugin executes named SQL query files against warehouse.',
    evidence: 'server/server.ts:17',
    liveness: 'live-capable',
  },
  {
    id: 'dbsql-scenario-engine-unrouted',
    label: 'DBSQL scenario engine (present but unrouted)',
    layer: 'compute',
    vendorService: 'Databricks SQL Warehouse',
    description: 'Scenario SQL execution code exists on disk but is not registered by any route.',
    evidence: 'server/scenario/run.ts:52',
    liveness: 'static-only',
    honestNote: 'Engine code is real but unreachable from active Express/AppKit routes.',
  },
  {
    id: 'sdp-pipeline-not-deployed',
    label: 'Spark Declarative Pipeline (not deployed from repo)',
    layer: 'compute',
    vendorService: 'Databricks Declarative Pipelines',
    description: 'No deployed SDP pipeline is defined for this app in current repository config.',
    evidence: 'databricks.yml:1',
    liveness: 'static-only',
    honestNote: 'Topology shows this as context only; this repo does not deploy it.',
  },
  {
    id: 'serving-advisor-endpoint',
    label: 'Model Serving advisor endpoint',
    layer: 'serving+AI',
    vendorService: 'Databricks Model Serving',
    description: 'Advisor requests invoke serving through server/advisor/model.ts streaming logic.',
    evidence: 'server/advisor/model.ts:330',
    liveness: 'live-capable',
  },
  {
    id: 'startup-sse-selfprobe',
    label: 'Startup SSE self-probe',
    layer: 'app',
    vendorService: 'Advisor diagnostics',
    description: 'App startup probe calls public diag SSE through proxy and records verdict.',
    evidence: 'server/advisor/selfprobe.ts:68',
    liveness: 'live-capable',
  },
];

export const topologyEdges: TopologyEdge[] = [
  {
    from: 'browser-client',
    to: 'databricks-apps-host',
    label: 'POST /api/analytics/query/*',
    flowId: 'baseline-map-render',
  },
  {
    from: 'databricks-apps-host',
    to: 'dbsql-warehouse',
    label: 'analytics.query(key, params)',
    flowId: 'baseline-map-render',
  },
  {
    from: 'dbsql-warehouse',
    to: 'unity-catalog-traffic',
    label: 'Read lanl.caltrans_traffic.*',
    flowId: 'baseline-map-render',
  },
  {
    from: 'browser-client',
    to: 'scenario-client-mock',
    label: 'applyMockScenario()',
    flowId: 'scenario-whatif-run',
  },
  {
    from: 'scenario-client-mock',
    to: 'dbsql-scenario-engine-unrouted',
    label: 'Real server DBSQL engine exists but is not invoked',
    flowId: 'scenario-whatif-run',
  },
  {
    from: 'browser-client',
    to: 'databricks-apps-host',
    label: 'POST /api/advisor/query',
    flowId: 'ai-advisor-request',
  },
  {
    from: 'databricks-apps-host',
    to: 'serving-advisor-endpoint',
    label: 'serving.invoke(..., stream:true)',
    flowId: 'ai-advisor-request',
  },
  {
    from: 'databricks-apps-host',
    to: 'lakebase-postgres',
    label: 'Persist advisor history + feedback',
    flowId: 'ai-advisor-request',
  },
  {
    from: 'startup-sse-selfprobe',
    to: 'apps-oidc-reverse-proxy',
    label: 'GET /api/advisor/diag/sse via public URL',
    flowId: 'startup-sse-probe',
  },
  {
    from: 'apps-oidc-reverse-proxy',
    to: 'databricks-apps-host',
    label: 'Proxy forwards authenticated app request',
    flowId: 'startup-sse-probe',
  },
  {
    from: 'startup-sse-selfprobe',
    to: 'lakebase-postgres',
    label: 'Record probe verdict in app.audit',
    flowId: 'startup-sse-probe',
  },
];
