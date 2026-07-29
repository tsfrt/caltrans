-- Mark an advisor assistant turn as reviewed by a human.
--
-- ── WHY THIS IS ON THE MESSAGE, NOT THE RECOMMENDATION ───────────────────────
-- `app.advisor_recommendations.scenario_id` (002_schema_advisor.sql) is the seam for the
-- PER-RECOMMENDATION lifecycle: accepted -> scenario created -> run finished. This flag is a
-- different and coarser fact — "a human read this assessment" — and it is deliberately kept
-- independent of that lifecycle so neither constrains the other.
--
-- The decisive reason it cannot hang off recommendations: the prompt treats "the data does not
-- support a recommendation" as a CORRECT answer (see server/advisor/prompt.ts, HARD RULES #2),
-- and such a turn produces ZERO recommendation rows. Those turns are exactly the ones worth
-- confirming a human read, so a per-recommendation flag would be unable to express the case
-- that matters most.
--
-- ── WHY TWO NULLABLE COLUMNS AND NOT A BOOLEAN ───────────────────────────────
-- `reviewed_at IS NOT NULL` IS the boolean, and it answers "who" and "when" for free. A bare
-- `reviewed BOOLEAN NOT NULL DEFAULT false` would need both of these columns added in a later
-- migration anyway, and a review record that says the flag flipped but not who flipped it is
-- not an audit trail. Everything above the schema still treats this as a binary flag.
--
-- Reviewing is not a model action, so nothing here touches `recommendations`, token counts, or
-- `finish_reason`: those describe how the turn was PRODUCED and must stay immutable.
--
-- ── APPLYING ─────────────────────────────────────────────────────────────────
-- Idempotent, like 001-003, so it is safe to re-run and safe to apply to a database that has
-- already had it applied. Applied out of band (or by scripts/lakebase/apply.sh schema), never
-- from app startup — see the ownership caveat in server/advisor/store.ts.

ALTER TABLE app.advisor_messages
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reviewed_by TEXT;

-- Supports "which turns in this session are still unreviewed", the same partial-index idiom as
-- idx_advisor_recs_unconverted in 002_schema_advisor.sql.
CREATE INDEX IF NOT EXISTS idx_advisor_messages_unreviewed
    ON app.advisor_messages (session_id)
    WHERE reviewed_at IS NULL;
