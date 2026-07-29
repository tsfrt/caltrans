-- AI Congestion Advisor — chat persistence for the California traffic what-if app.
-- Project : projects/caltrans-app   Branch: production   DB: databricks_postgres (PG 17.10)
--
-- Applied ON TOP of lakebase/001_schema.sql, which owns the `app` schema and the
-- config/scenarios/scenario_runs/audit tables. Idempotent (IF NOT EXISTS / ON CONFLICT),
-- so it is safe to re-run and usable as a migration baseline.
--
-- SCOPE: chat state only. No traffic data is copied here — the snapshot KPIs stored on a
-- session are the *aggregates the model actually saw*, not a duplicate of the lakehouse.
--
-- ── WHY THE SNAPSHOT IS DENORMALISED ONTO THE SESSION ────────────────────────────────
-- A recommendation is only meaningful against the traffic state that produced it. The
-- underlying lakehouse table can be regenerated (it is synthetic), and the app's own
-- README already notes the date range is not stable across regenerations. If we stored
-- only (reading_date, bucket_idx, freeway) and re-derived the KPIs at read time, an old
-- chat would silently re-anchor to different numbers and the transcript would stop
-- matching its own evidence. So `snapshot_kpis` is an immutable JSONB copy of the exact
-- context handed to the model. The pointer columns are kept ALONGSIDE it (not instead of
-- it) so the UI can offer "re-assess this same slice".

CREATE SCHEMA IF NOT EXISTS app;

-- ---------------------------------------------------------------------------
-- advisor_sessions: one row per chat, anchored to a map snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.advisor_sessions (
    id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    created_by     TEXT        NOT NULL,
    title          TEXT        NOT NULL,

    -- ── snapshot anchor (the "which traffic state" pointer) ──
    reading_date   DATE        NOT NULL,
    -- 0..95 quarter-hour index of the Pacific-LOCAL day, matching the app's own
    -- bucket_idx = hour*4 + minute DIV 15 over from_utc_timestamp(...,'America/Los_Angeles').
    bucket_idx     SMALLINT    NOT NULL,
    -- Denormalised for cheap display/filtering; derivable from bucket_idx.
    local_hour     SMALLINT    NOT NULL,
    local_time     TEXT        NOT NULL,
    -- 'ALL' sentinel matches the `:freeway = 'ALL'` predicate used by the DBSQL queries,
    -- so the same value round-trips between UI, SQL, and this column with no mapping.
    corridor       TEXT        NOT NULL DEFAULT 'ALL',

    -- Immutable copy of the aggregates the model was shown. See note above.
    snapshot_kpis  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    -- Endpoint that produced this session's first assessment. Recorded per-message too;
    -- kept here so the session list can show it without joining.
    model_endpoint TEXT,

    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT advisor_sessions_bucket_chk CHECK (bucket_idx BETWEEN 0 AND 95),
    CONSTRAINT advisor_sessions_hour_chk   CHECK (local_hour BETWEEN 0 AND 23)
);

CREATE INDEX IF NOT EXISTS idx_advisor_sessions_user
    ON app.advisor_sessions (created_by, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_advisor_sessions_anchor
    ON app.advisor_sessions (reading_date, bucket_idx, corridor);

-- ---------------------------------------------------------------------------
-- advisor_messages: one row per turn
--
-- `content` is the full rendered text. For assistant turns it is the concatenation of
-- every streamed delta, written ONCE when the stream completes (or when it fails, with
-- whatever arrived — a truncated answer is more useful than a lost one, and `finish_reason`
-- distinguishes the two).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.advisor_messages (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id        UUID        NOT NULL
                                  REFERENCES app.advisor_sessions (id) ON DELETE CASCADE,
    role              TEXT        NOT NULL,
    content           TEXT        NOT NULL,

    model_endpoint    TEXT,
    prompt_tokens     INTEGER,
    completion_tokens INTEGER,
    latency_ms        INTEGER,
    -- 'stop' | 'length' | 'error' | NULL for non-assistant turns. Lets a reader tell a
    -- deliberately-short answer from a truncated or aborted one.
    finish_reason     TEXT,
    -- Whether this turn was produced by the streaming route or the non-streaming fallback.
    -- Recorded because the Apps reverse proxy's SSE behaviour is environment-dependent.
    transport         TEXT,

    -- Structured recommendations as returned by the model for THIS turn. Mirrored into
    -- app.advisor_recommendations (see justification there); kept here as the verbatim
    -- payload so a parser change can be replayed against the original.
    recommendations   JSONB,

    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT advisor_messages_role_chk
        CHECK (role IN ('system', 'user', 'assistant')),
    CONSTRAINT advisor_messages_transport_chk
        CHECK (transport IS NULL OR transport IN ('stream', 'invoke'))
);

CREATE INDEX IF NOT EXISTS idx_advisor_messages_session
    ON app.advisor_messages (session_id, created_at);

-- ---------------------------------------------------------------------------
-- advisor_recommendations: one row per discrete recommendation
--
-- ── WHY A TABLE AND NOT JUST THE JSONB COLUMN ABOVE ─────────────────────────
-- The JSONB column is kept (it is the verbatim model payload), but the recommendations
-- are ALSO shredded into rows because their consumer is different from the transcript's:
--
--   1. M2 turns a recommendation into a scenario run. That is a per-recommendation
--      lifecycle with its own state (accepted → scenario created → run finished), which
--      wants a stable identity — `id` here — and a real FK. You cannot FK to an element
--      inside a JSONB array. `scenario_id` below is the seam, nullable and unenforced for
--      now so this migration does not depend on M2's table shape.
--   2. Cross-session analytics ("which action types does the advisor propose at the PM
--      peak, and on which corridors?") is a GROUP BY over typed columns, not a
--      jsonb_array_elements unnest of every message ever sent.
--
-- Typed columns are deliberately few. `action_type` is CHECKed to a closed vocabulary so
-- M2 can switch on it exhaustively; everything qualitative stays TEXT, and anything the
-- model returns that does not fit lands in `raw` rather than being dropped.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS app.advisor_recommendations (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id       UUID        NOT NULL
                                 REFERENCES app.advisor_sessions (id) ON DELETE CASCADE,
    message_id       UUID        NOT NULL
                                 REFERENCES app.advisor_messages (id) ON DELETE CASCADE,

    -- Ordinal within the message, so display order is reproducible without relying on
    -- insertion order.
    seq              SMALLINT    NOT NULL,

    -- Closed vocabulary — M2 switches on this.
    action_type      TEXT        NOT NULL,
    -- Free-text target as named by the model, plus a resolved corridor when it matches a
    -- real `freeway` value in gold_map_frames. target_corridor being NULL while
    -- target_label is set means "the model named something we could not resolve" — which
    -- is exactly what M2 must refuse to auto-run.
    target_label     TEXT        NOT NULL,
    target_corridor  TEXT,
    target_direction TEXT,

    -- The what-if shape M2 needs: a direction and a magnitude.
    expected_effect  TEXT        NOT NULL,
    -- 'decrease' | 'increase' | 'unclear' — direction of effect on congestion/delay.
    effect_direction TEXT,
    -- Signed magnitude in the unit the model chose (usually percent). Nullable: a
    -- recommendation with no quantified magnitude is still worth recording, and forcing a
    -- number here would invite the model to invent one.
    magnitude        NUMERIC,
    magnitude_unit   TEXT,

    confidence       TEXT,
    rationale        TEXT,

    -- M2 seam: set when this recommendation has been materialised as a scenario.
    -- Intentionally NOT a foreign key — app.scenarios exists, but wiring the constraint
    -- now would couple this migration to M2's final lever vocabulary.
    scenario_id      BIGINT,

    -- Anything the model returned that does not map onto the columns above.
    raw              JSONB,

    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT advisor_recs_action_chk CHECK (action_type IN (
        'ramp_metering',
        'lane_reversal',
        'incident_clearance_priority',
        'signal_retiming',
        'demand_shift_messaging',
        'speed_harmonization',
        'shoulder_running',
        'transit_diversion',
        'other'
    )),
    CONSTRAINT advisor_recs_direction_chk CHECK (
        effect_direction IS NULL
        OR effect_direction IN ('decrease', 'increase', 'unclear')
    ),
    CONSTRAINT advisor_recs_confidence_chk CHECK (
        confidence IS NULL OR confidence IN ('low', 'medium', 'high')
    )
);

CREATE INDEX IF NOT EXISTS idx_advisor_recs_session
    ON app.advisor_recommendations (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_advisor_recs_message
    ON app.advisor_recommendations (message_id, seq);
CREATE INDEX IF NOT EXISTS idx_advisor_recs_action
    ON app.advisor_recommendations (action_type);
-- Supports "which recommendations are still unconverted" for M2.
CREATE INDEX IF NOT EXISTS idx_advisor_recs_unconverted
    ON app.advisor_recommendations (session_id)
    WHERE scenario_id IS NULL;

-- ---------------------------------------------------------------------------
-- updated_at maintenance (reuses app.touch_updated_at from 001_schema.sql)
--
-- Defined here too so this file can be applied standalone against a database that has the
-- `app` schema but an older 001_schema.sql. CREATE OR REPLACE makes that safe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION app.touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_advisor_sessions_touch ON app.advisor_sessions;
CREATE TRIGGER trg_advisor_sessions_touch
    BEFORE UPDATE ON app.advisor_sessions
    FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
