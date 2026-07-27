-- Lakebase (Postgres 17) schema for the California traffic what-if modeling app.
-- Project : projects/caltrans-app
-- Branch  : production
-- Database: databricks_postgres
--
-- SCOPE: application state only. All traffic data lives in Unity Catalog
-- (lanl.caltrans_traffic) and is queried via DBSQL. Nothing here duplicates
-- lakehouse data.
--
-- NOTE ON OWNERSHIP: when the Databricks App is deployed, its service principal
-- needs CAN_CONNECT_AND_CREATE and should own this schema. Creating objects as a
-- human user first can cause `permission denied (42501)` for the app SP. The
-- grants at the bottom are the mitigation.

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- config: singleton-ish key/value app configuration
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.config (
    key          TEXT PRIMARY KEY,
    value        JSONB       NOT NULL,
    description  TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by   TEXT
);

-- ---------------------------------------------------------------------------
-- scenarios: saved what-if scenarios
--
-- `levers` holds the scenario definition as JSONB so the lever vocabulary can
-- evolve without migrations. Expected shape:
--   {
--     "closures":       [{"segment_id": 123, "lanes_blocked": 2}],
--     "demand_deltas":  [{"corridor": "I-405", "direction": "N", "pct": 20}],
--     "incidents":      [{"segment_id": 456, "severity": 3, "start_hour": 7,
--                         "duration_min": 45}],
--     "capacity_changes":[{"segment_id": 789, "new_capacity_vph": 2200}]
--   }
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.scenarios (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          TEXT        NOT NULL,
    description   TEXT,
    levers        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    base_date     DATE,
    is_baseline   BOOLEAN     NOT NULL DEFAULT false,
    created_by    TEXT        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scenarios_created_by ON app.scenarios (created_by);
CREATE INDEX IF NOT EXISTS idx_scenarios_created_at ON app.scenarios (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_scenarios_levers     ON app.scenarios USING gin (levers);

-- ---------------------------------------------------------------------------
-- scenario_runs: one row per execution of a scenario against the lakehouse
--
-- Results are NOT stored here in full (they live in the lakehouse / are
-- recomputed). We persist the KPI rollup so the UI can list past runs cheaply.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.scenario_runs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scenario_id   BIGINT      NOT NULL REFERENCES app.scenarios (id) ON DELETE CASCADE,
    status        TEXT        NOT NULL DEFAULT 'pending',
    kpis          JSONB,
    query_ms      INTEGER,
    error         TEXT,
    narrative     TEXT,
    run_by        TEXT,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at   TIMESTAMPTZ,
    CONSTRAINT scenario_runs_status_chk
        CHECK (status IN ('pending', 'running', 'succeeded', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_runs_scenario   ON app.scenario_runs (scenario_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status     ON app.scenario_runs (status);

-- ---------------------------------------------------------------------------
-- audit: append-only record of user actions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.audit (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor       TEXT        NOT NULL,
    action      TEXT        NOT NULL,
    target_type TEXT,
    target_id   TEXT,
    detail      JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_occurred ON app.audit (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor    ON app.audit (actor, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_scenarios_touch ON app.scenarios;
CREATE TRIGGER trg_scenarios_touch
    BEFORE UPDATE ON app.scenarios
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- seed config
-- ---------------------------------------------------------------------------
INSERT INTO app.config (key, value, description, updated_by) VALUES
    ('traffic_catalog',   '"lanl"'::jsonb,               'Unity Catalog holding traffic data', 'polly'),
    ('traffic_schema',    '"caltrans_traffic"'::jsonb,   'Schema holding traffic medallion tables', 'polly'),
    ('default_corridors', '["I-5","I-405","US-101","I-80","SR-99"]'::jsonb, 'Corridors shown on first load', 'polly'),
    ('animation_hours',   '24'::jsonb,                   'Frames in the time animation', 'polly'),
    ('bpr_alpha',         '0.15'::jsonb,                 'BPR volume-delay alpha coefficient', 'polly'),
    ('bpr_beta',          '4.0'::jsonb,                  'BPR volume-delay beta exponent', 'polly')
ON CONFLICT (key) DO NOTHING;
