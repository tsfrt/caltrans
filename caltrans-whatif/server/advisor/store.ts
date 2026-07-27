/**
 * Lakebase persistence for advisor chat.
 *
 * Every function takes a minimal `Db` interface rather than the AppKit plugin handle, so the
 * persistence layer is testable against a fake without a Postgres instance — and so the
 * SQL text itself (column lists, parameter order, CASCADE behaviour) is what the tests pin.
 *
 * ── OWNERSHIP CAVEAT (read this before debugging a permission error) ──────────────────
 * The `app` schema was created by a human user (thomas.seufert@databricks.com), NOT by the
 * app's service principal. `CAN_CONNECT_AND_CREATE` lets the SP create its own objects but
 * grants nothing on someone else's schema, so the SP needs explicit GRANTs or every write
 * here fails with `permission denied (42501)`. See lakebase/README.md and
 * lakebase/grants_advisor.sql. This module does NOT attempt to create the schema at
 * startup: doing so as the SP would either no-op (it exists) or, worse, succeed in a fresh
 * database and leave two divergent definitions of the same tables. Migrations are applied
 * out of band from lakebase/*.sql.
 */

import type { ParsedRecommendation } from './recommendations.js';

/**
 * Minimal shape of the Lakebase plugin handle this module needs.
 *
 * `T` is constrained to `QueryResultRow` (i.e. an index-signature object) to match
 * `pg.Pool.query`'s own generic bound. Without the constraint the plugin's handle is not
 * assignable to this interface — `T` could be instantiated with something unrelated to a
 * row — so the structural match has to mirror pg's variance, not merely resemble it.
 */
export interface QueryResultRowLike {
  [column: string]: unknown;
}

export interface Db {
  query: <T extends QueryResultRowLike = QueryResultRowLike>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface SessionRow extends QueryResultRowLike {
  id: string;
  created_by: string;
  title: string;
  reading_date: string;
  bucket_idx: number;
  local_hour: number;
  local_time: string;
  corridor: string;
  snapshot_kpis: Record<string, unknown>;
  model_endpoint: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageRow extends QueryResultRowLike {
  id: string;
  session_id: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  model_endpoint: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  finish_reason: string | null;
  transport: string | null;
  recommendations: unknown;
  created_at: string;
}

export interface RecommendationRow extends QueryResultRowLike {
  id: string;
  session_id: string;
  message_id: string;
  seq: number;
  action_type: string;
  target_label: string;
  target_corridor: string | null;
  target_direction: string | null;
  expected_effect: string;
  effect_direction: string | null;
  magnitude: string | number | null;
  magnitude_unit: string | null;
  confidence: string | null;
  rationale: string | null;
  scenario_id: number | null;
  created_at: string;
}

/**
 * `reading_date` comes back from `pg` as a JS Date (node-postgres parses DATE into Date
 * using the *local* timezone). Rendering that with toISOString() would shift the date by a
 * day for anyone west of UTC — which is everyone this app is about. Format from the local
 * date parts instead, which is what node-postgres already anchored it to.
 */
function toDateString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, '0');
    const d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // Anything else (null, or an unexpected wire type) becomes '' rather than being coerced —
  // String({}) would yield "[object Object]" and end up in the UI as a date.
  return typeof v === 'number' ? String(v) : '';
}

/** Normalise a session row for the wire, so the client never sees a raw Date or a null KPI blob. */
export function serialiseSession(row: SessionRow): SessionRow {
  return {
    ...row,
    reading_date: toDateString(row.reading_date),
    bucket_idx: Number(row.bucket_idx),
    local_hour: Number(row.local_hour),
    snapshot_kpis: row.snapshot_kpis ?? {},
  };
}

const SESSION_COLUMNS = `
  id, created_by, title, reading_date, bucket_idx, local_hour, local_time,
  corridor, snapshot_kpis, model_endpoint, created_at, updated_at`;

export async function createSession(
  db: Db,
  input: {
    createdBy: string;
    title: string;
    readingDate: string;
    bucketIdx: number;
    localHour: number;
    localTime: string;
    corridor: string;
    snapshotKpis: Record<string, unknown>;
    modelEndpoint: string | null;
  },
): Promise<SessionRow> {
  const { rows } = await db.query<SessionRow>(
    `INSERT INTO app.advisor_sessions
       (created_by, title, reading_date, bucket_idx, local_hour, local_time,
        corridor, snapshot_kpis, model_endpoint)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING ${SESSION_COLUMNS}`,
    [
      input.createdBy,
      input.title,
      input.readingDate,
      input.bucketIdx,
      input.localHour,
      input.localTime,
      input.corridor,
      JSON.stringify(input.snapshotKpis),
      input.modelEndpoint,
    ],
  );
  return serialiseSession(rows[0]);
}

/**
 * Sessions for the session list.
 *
 * Scoped to `created_by`: the anchor and the transcript are a user's own working notes, and
 * the app has no sharing model. `message_count` is joined in so the list can show whether a
 * session has any turns without a second round-trip per row.
 */
export async function listSessions(
  db: Db,
  createdBy: string,
  limit = 50,
): Promise<(SessionRow & { message_count: number })[]> {
  const { rows } = await db.query<SessionRow & { message_count: string | number }>(
    `SELECT ${SESSION_COLUMNS
      .split(',')
      .map((c) => `s.${c.trim()}`)
      .join(', ')},
            COALESCE(m.cnt, 0) AS message_count
     FROM app.advisor_sessions s
     LEFT JOIN (
       SELECT session_id, COUNT(*) AS cnt
       FROM app.advisor_messages
       WHERE role <> 'system'
       GROUP BY session_id
     ) m ON m.session_id = s.id
     WHERE s.created_by = $1
     ORDER BY s.updated_at DESC
     LIMIT $2`,
    [createdBy, limit],
  );
  return rows.map((r) => ({
    ...serialiseSession(r),
    message_count: Number(r.message_count ?? 0),
  }));
}

export async function getSession(
  db: Db,
  id: string,
  createdBy: string,
): Promise<SessionRow | null> {
  // created_by is part of the predicate, not checked after the fetch, so another user's
  // session id is indistinguishable from a nonexistent one.
  const { rows } = await db.query<SessionRow>(
    `SELECT ${SESSION_COLUMNS} FROM app.advisor_sessions WHERE id = $1 AND created_by = $2`,
    [id, createdBy],
  );
  return rows.length > 0 ? serialiseSession(rows[0]) : null;
}

const MESSAGE_COLUMNS = `
  id, session_id, role, content, model_endpoint, prompt_tokens, completion_tokens,
  latency_ms, finish_reason, transport, recommendations, created_at`;

/**
 * Full transcript for replay.
 *
 * `role = 'system'` rows are included: the system prompt is part of what produced the
 * answers, and hiding it would make an old session unreproducible. The route filters it out
 * of the client payload; callers that rebuild a model request need it.
 */
export async function listMessages(db: Db, sessionId: string): Promise<MessageRow[]> {
  const { rows } = await db.query<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS}
     FROM app.advisor_messages
     WHERE session_id = $1
     ORDER BY created_at ASC, id ASC`,
    [sessionId],
  );
  return rows;
}

export async function appendMessage(
  db: Db,
  input: {
    sessionId: string;
    role: 'system' | 'user' | 'assistant';
    content: string;
    modelEndpoint?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    latencyMs?: number | null;
    finishReason?: string | null;
    transport?: 'stream' | 'invoke' | null;
    recommendations?: unknown;
  },
): Promise<MessageRow> {
  const { rows } = await db.query<MessageRow>(
    `INSERT INTO app.advisor_messages
       (session_id, role, content, model_endpoint, prompt_tokens, completion_tokens,
        latency_ms, finish_reason, transport, recommendations)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING ${MESSAGE_COLUMNS}`,
    [
      input.sessionId,
      input.role,
      input.content,
      input.modelEndpoint ?? null,
      input.promptTokens ?? null,
      input.completionTokens ?? null,
      input.latencyMs ?? null,
      input.finishReason ?? null,
      input.transport ?? null,
      input.recommendations === undefined || input.recommendations === null
        ? null
        : JSON.stringify(input.recommendations),
    ],
  );
  return rows[0];
}

/** Bump the session's updated_at so the session list orders by real activity. */
export async function touchSession(db: Db, sessionId: string): Promise<void> {
  // The trg_advisor_sessions_touch trigger sets updated_at; this UPDATE exists to fire it.
  await db.query(`UPDATE app.advisor_sessions SET title = title WHERE id = $1`, [sessionId]);
}

/**
 * Shred a turn's recommendations into rows.
 *
 * One multi-row INSERT rather than N statements: it is one round-trip, and it is atomic, so
 * a message can never end up with a partial set of recommendations attached.
 */
export async function insertRecommendations(
  db: Db,
  input: { sessionId: string; messageId: string; recommendations: ParsedRecommendation[] },
): Promise<RecommendationRow[]> {
  if (input.recommendations.length === 0) return [];

  const cols = 14;
  const values: unknown[] = [];
  const tuples = input.recommendations.map((r, i) => {
    values.push(
      input.sessionId,
      input.messageId,
      i,
      r.action_type,
      r.target_label,
      r.target_corridor,
      r.target_direction,
      r.expected_effect,
      r.effect_direction,
      r.magnitude,
      r.magnitude_unit,
      r.confidence,
      r.rationale,
      JSON.stringify(r.raw ?? {}),
    );
    const base = i * cols;
    const ph = Array.from({ length: cols }, (_, k) => `$${base + k + 1}`);
    // Only the JSONB column needs an explicit cast; the rest are inferred from the target.
    ph[cols - 1] = `${ph[cols - 1]}::jsonb`;
    return `(${ph.join(', ')})`;
  });

  const { rows } = await db.query<RecommendationRow>(
    `INSERT INTO app.advisor_recommendations
       (session_id, message_id, seq, action_type, target_label, target_corridor,
        target_direction, expected_effect, effect_direction, magnitude, magnitude_unit,
        confidence, rationale, raw)
     VALUES ${tuples.join(', ')}
     RETURNING id, session_id, message_id, seq, action_type, target_label, target_corridor,
               target_direction, expected_effect, effect_direction, magnitude,
               magnitude_unit, confidence, rationale, scenario_id, created_at`,
    values,
  );
  return rows;
}

export async function listRecommendations(
  db: Db,
  sessionId: string,
): Promise<RecommendationRow[]> {
  const { rows } = await db.query<RecommendationRow>(
    `SELECT id, session_id, message_id, seq, action_type, target_label, target_corridor,
            target_direction, expected_effect, effect_direction, magnitude, magnitude_unit,
            confidence, rationale, scenario_id, created_at
     FROM app.advisor_recommendations
     WHERE session_id = $1
     ORDER BY created_at ASC, seq ASC`,
    [sessionId],
  );
  return rows;
}

export async function deleteSession(db: Db, id: string, createdBy: string): Promise<boolean> {
  // Messages and recommendations go with it via ON DELETE CASCADE.
  const res = await db.query(
    `DELETE FROM app.advisor_sessions WHERE id = $1 AND created_by = $2`,
    [id, createdBy],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Append to the existing shared audit log.
 *
 * Best-effort by design: audit is observability, and losing an audit row must never fail the
 * user's action. The caller logs the swallowed error.
 */
export async function audit(
  db: Db,
  input: {
    actor: string;
    action: string;
    targetType?: string | null;
    targetId?: string | null;
    detail?: Record<string, unknown> | null;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO app.audit (actor, action, target_type, target_id, detail)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      input.actor,
      input.action,
      input.targetType ?? null,
      input.targetId ?? null,
      input.detail ? JSON.stringify(input.detail) : null,
    ],
  );
}
