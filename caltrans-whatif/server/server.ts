import { analytics, createApp, lakebase, server, serving } from '@databricks/appkit';
import { registerAdvisorRoutes } from './advisor/routes.js';

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
const appkit = await createApp({
  plugins: [
    analytics({ timeout: 45_000 }),
    /**
     * The `serving()` plugin is registered for two things, NEITHER of which is its
     * streaming route:
     *   1. `AppKit.serving().invoke()` — the non-streaming fallback path.
     *   2. Its resource declaration, which is what puts the `serving_endpoint`
     *      CAN_QUERY requirement into the bundle and validates the wiring.
     *
     * Its `POST /api/serving/stream` route is NOT used: it is a raw byte pipe over the
     * *client's* request body, so the server never observes the generated text and could
     * neither build the prompt from DBSQL nor persist the answer. See
     * server/advisor/model.ts for the full reasoning and the custom streaming call.
     *
     * Timeout is left at the plugin default (120s), which matches the platform ceiling.
     */
    serving(),
    /**
     * Lakebase handles pooling AND OAuth token refresh. That refresh is not optional:
     * Lakebase credentials are ~1h-TTL OAuth tokens used as the Postgres password, so a
     * naive long-lived pool dies mid-session.
     */
    lakebase(),
    server(),
  ],
  // Not async: `server.extend` is synchronous and there is no schema bootstrap to await
  // (migrations are applied out of band — see the note below).
  onPluginsReady(kit) {
    /**
     * Routes are registered here rather than at module scope so they exist before the
     * server accepts requests.
     *
     * NOTE: no schema bootstrap. The `app` schema already exists and is owned by a human
     * user, not the app service principal, so a `CREATE TABLE IF NOT EXISTS` from here
     * would fail on a permission check in the deployed app and, worse, would silently
     * succeed against a fresh database and leave two divergent definitions. Migrations
     * are applied out of band from `lakebase/*.sql`. See lakebase/README.md.
     */
    kit.server.extend((app) => {
      registerAdvisorRoutes(app, {
        db: kit.lakebase,
        analytics: kit.analytics,
        serving: kit.serving(),
        logger: console,
      });
    });
  },
});

export default appkit;
