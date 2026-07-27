import { createApp, analytics, server } from '@databricks/appkit';

/**
 * The analytics plugin's DEFAULT query timeout is 18s (appkit/dist/plugins/analytics/
 * defaults.js), which is unrelated to — and much tighter than — the Apps platform's
 * non-configurable 120s request timeout.
 *
 * Measured p50 for the heaviest query (traffic_time_matrix, all corridors, one day,
 * 191,424 rows) is 0.77s warm / ~2.9s cold, so 18s would usually be fine. It is raised
 * to 45s purely to absorb a Serverless Starter warehouse cold start, while still
 * finishing well inside the platform's 120s ceiling so a slow query surfaces as an
 * AppKit error the UI can render rather than an opaque proxy 504 that never reaches
 * the app logs.
 */
createApp({
  plugins: [analytics({ timeout: 45_000 }), server()],
}).catch(console.error);
