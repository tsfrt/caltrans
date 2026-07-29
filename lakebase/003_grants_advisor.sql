-- Grant the caltrans-whatif app service principal write access to the `app` schema.
--
-- ── WHY THIS FILE IS NECESSARY ───────────────────────────────────────────────────────
-- The documented Lakebase model is "deploy the app first, let the service principal CREATE
-- the schema, and it owns everything in it." That did NOT happen here: the `app` schema and
-- its config/scenarios/scenario_runs/audit tables were created by the human user
-- thomas.seufert@databricks.com before the app was wired to Lakebase at all.
--
-- `CAN_CONNECT_AND_CREATE` (the permission the bundle grants on the postgres resource) lets
-- the SP connect and create ITS OWN objects. It grants nothing on a schema someone else
-- owns. So without the statements below, every advisor write fails with:
--
--     permission denied for schema app            (SQLSTATE 42501)
--
-- and — this is the dangerous part — it fails at RUNTIME, in the deployed app only. Local
-- development runs as the schema owner and works perfectly, so the feature looks complete
-- right up until it is deployed.
--
-- ── APPLYING ─────────────────────────────────────────────────────────────────────────
-- Must be run by the schema OWNER (or a superuser), not by the app SP:
--
--   EP=projects/caltrans-app/branches/production/endpoints/primary
--   TOKEN=$(databricks postgres generate-database-credential $EP -o json \
--             | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
--   PGPASSWORD="$TOKEN" psql \
--     "host=ep-divine-mode-d23no6aj.database.us-east-1.cloud.databricks.com \
--      port=5432 dbname=databricks_postgres \
--      user=thomas.seufert@databricks.com sslmode=require" \
--     -v ON_ERROR_STOP=1 \
--     -v sp_role=4a27f46d-04b9-4580-9767-44b505a4cf50 \
--     -f lakebase/003_grants_advisor.sql
--
-- Use the DIRECT host. The `-pooler` host rejects Lakebase OAuth tokens with
-- `SASL authentication failed`.
--
-- ── ORDERING CAVEAT ──────────────────────────────────────────────────────────────────
-- The SP's Postgres role does not exist until the app has been deployed at least once with
-- the `postgres` resource attached — Databricks provisions the role on that first deploy.
-- Running this file before then fails with `role "<client-id>" does not exist`. Order:
--
--   1. databricks bundle deploy (creates/attaches the role)
--   2. psql -f lakebase/002_schema_advisor.sql
--   3. psql -f lakebase/003_grants_advisor.sql   <- this file
--   4. verify via GET /api/advisor/health  ("canWriteSessions": true)
--
-- The DO block below is written so step 3 reports a clear, actionable message instead of an
-- opaque failure if it is run out of order.

\if :{?sp_role}
\else
\set sp_role '4a27f46d-04b9-4580-9767-44b505a4cf50'
\endif

SELECT set_config('app.grants_sp_role', :'sp_role', false);

DO $$
DECLARE
    sp TEXT := current_setting('app.grants_sp_role', false);
BEGIN
    IF sp IS NULL OR sp = '' THEN
        RAISE EXCEPTION 'No app service principal role was provided.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = sp) THEN
        RAISE EXCEPTION
            'Role "%" does not exist yet. Deploy the app with the `postgres` resource '
            'attached first — Databricks provisions the service principal role on that '
            'first deploy — then re-run this file.', sp;
    END IF;

    -- USAGE lets the SP resolve names in the schema; CREATE lets it add its own objects
    -- (needed if a future migration runs from the app rather than out of band).
    EXECUTE format('GRANT USAGE, CREATE ON SCHEMA app TO %I', sp);

    -- DML on everything that exists today, including the pre-existing config/scenarios/
    -- scenario_runs/audit tables. `audit` in particular is written by the advisor.
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA app TO %I', sp);

    -- IDENTITY / SERIAL columns on app.audit and app.scenarios draw from sequences, and
    -- INSERT alone is not enough to advance one. Missing this yields
    -- `permission denied for sequence audit_id_seq` on the FIRST audit write — a failure
    -- that only appears at runtime.
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA app TO %I', sp);

    -- Future tables/sequences created by the OWNER are not covered by the ALL TABLES grants
    -- above (those apply only to objects existing at grant time). Default privileges close
    -- that gap so the next migration does not silently re-break the deployed app.
    --
    -- NOTE: ALTER DEFAULT PRIVILEGES applies to objects created by the role that RUNS this
    -- statement (the owner). Objects created by any other role are still not covered.
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', sp);
    EXECUTE format(
        'ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT USAGE, SELECT ON SEQUENCES TO %I', sp);

    RAISE NOTICE 'Granted schema `app` DML + sequence usage to %', sp;
END
$$;

-- ---------------------------------------------------------------------------
-- Verification. Prints one row per advisor table showing what the SP can do.
-- Every boolean must be `t`.
-- ---------------------------------------------------------------------------
SELECT
    t.table_name,
    has_table_privilege(:'sp_role', 'app.' || t.table_name, 'SELECT') AS can_select,
    has_table_privilege(:'sp_role', 'app.' || t.table_name, 'INSERT') AS can_insert,
    has_table_privilege(:'sp_role', 'app.' || t.table_name, 'UPDATE') AS can_update,
    has_table_privilege(:'sp_role', 'app.' || t.table_name, 'DELETE') AS can_delete
FROM information_schema.tables t
WHERE t.table_schema = 'app'
ORDER BY t.table_name;

-- Schema-level privileges (USAGE is the one that produces `permission denied for schema app`).
SELECT
    has_schema_privilege(:'sp_role', 'app', 'USAGE')  AS schema_usage,
    has_schema_privilege(:'sp_role', 'app', 'CREATE') AS schema_create;
