/**
 * Express routes for the AI Congestion Advisor.
 *
 * Route map:
 *   GET    /api/advisor/health                 — config probe (endpoint + db reachable)
 *   GET    /api/advisor/sessions               — session list for the current user
 *   POST   /api/advisor/sessions               — create a session from a map snapshot
 *   GET    /api/advisor/sessions/:id           — session + transcript + recommendations
 *   DELETE /api/advisor/sessions/:id           — delete (messages/recs cascade)
 *   POST   /api/advisor/sessions/:id/messages  — send a turn; streams SSE, persists on completion
 *   POST   .../messages/:messageId/review      — set/clear the human-reviewed flag on a turn
 *   GET    /api/advisor/diag/sse               — SSE-through-proxy probe (see below)
 *
 * ── THE STREAMING CONTRACT ────────────────────────────────────────────────────────────
 * `POST /sessions/:id/messages` streams its own SSE envelope rather than proxying the
 * model's. Own event types, because the client needs things the model's stream does not
 * carry: the persisted message id, token usage, and the structured recommendations parsed
 * server-side after the text is complete.
 *
 *   event: delta   { text }                      incremental
 *   event: done    { messageId, ..., recommendations }
 *   event: error   { error }
 *
 * The turn is persisted when the stream ENDS, not per delta — one INSERT per turn instead of
 * hundreds. If the client disconnects mid-stream the partial text is still written with
 * `finish_reason='aborted'`, because a truncated assessment the user saw is more useful than
 * a hole in the transcript.
 */

import type { Application, Request, Response } from 'express';
import { z } from 'zod';
import {
  ALL_CORRIDORS,
  BUCKETS_PER_DAY,
  bucketToLocalHour,
  bucketToLocalTime,
  buildSnapshotContext,
  snapshotKpis,
  type AnalyticsLike,
} from './context.js';
import {
  invokeModel,
  resolveEndpointName,
  streamModel,
  type ChatMessage,
  type ServingLike,
} from './model.js';
import { ASSESSMENT_INSTRUCTION, systemPromptWithAnchor } from './prompt.js';
import { parseModelResponse } from './recommendations.js';
import {
  appendMessage,
  audit,
  createSession,
  deleteSession,
  getSession,
  insertRecommendations,
  listMessages,
  listRecommendations,
  listSessions,
  setMessageReviewed,
  touchSession,
  type Db,
} from './store.js';

export interface AdvisorDeps {
  db: Db;
  analytics: AnalyticsLike;
  serving: ServingLike;
  logger?: { warn: (msg: string, ...args: unknown[]) => void; info?: (msg: string, ...args: unknown[]) => void };
}

/**
 * Read a route parameter as a single string.
 *
 * Express 5 types `req.params[k]` as `string | string[]` (a repeated param yields an array).
 * `:id` here can only ever be one segment, but the types don't know that, and silently
 * coercing an array via template interpolation would send `"a,b"` into a UUID predicate.
 * Returning '' for the array case makes it a clean 404 instead.
 */
function param(req: Request, key: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[key];
  return typeof v === 'string' ? v : '';
}

/**
 * Identify the caller.
 *
 * `x-forwarded-email` is injected by the Databricks Apps proxy for the authenticated user.
 * Locally there is no proxy, so fall back to a stable dev identity — stable so that sessions
 * created in one `npm run dev` session are still listed in the next one.
 */
export function currentUser(req: Request): string {
  const header = req.header('x-forwarded-email') ?? req.header('x-forwarded-preferred-username');
  if (header && header.trim() !== '') return header.trim();
  return process.env.ADVISOR_DEV_USER ?? 'local-dev@localhost';
}

const CreateSessionBody = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'day must be YYYY-MM-DD'),
  bucket: z.number().int().min(0).max(BUCKETS_PER_DAY - 1),
  corridor: z.string().min(1).max(64).default(ALL_CORRIDORS),
  title: z.string().min(1).max(200).optional(),
});

const ReviewMessageBody = z.object({
  /** Binary: true marks the turn reviewed, false clears it. */
  reviewed: z.boolean(),
});

const SendMessageBody = z.object({
  content: z.string().min(1).max(4000),
  /**
   * Client-selected transport. The UI probes the deployed environment once and sends
   * `stream: false` when SSE does not survive the proxy, so the fallback is an explicit
   * decision rather than a silent degradation.
   */
  stream: z.boolean().default(true),
});

/** Human-readable default title, so the session list is scannable without opening rows. */
function defaultTitle(day: string, bucket: number, corridor: string): string {
  const scope = corridor === ALL_CORRIDORS ? 'All corridors' : corridor;
  return `${scope} · ${day} ${bucketToLocalTime(bucket)} PT`;
}

/** Fire-and-forget audit. Never allowed to fail the user's request. */
async function tryAudit(deps: AdvisorDeps, input: Parameters<typeof audit>[1]): Promise<void> {
  try {
    await audit(deps.db, input);
  } catch (err) {
    deps.logger?.warn(
      'advisor: audit insert failed (non-fatal): %s',
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Rebuild the model request from the persisted transcript.
 *
 * Three parts, in this order:
 *
 *  1. **System prompt**, regenerated from the session's anchor rather than replayed from the
 *     stored `system` row, so a prompt improvement applies to follow-up turns in existing
 *     sessions.
 *  2. **The snapshot brief**, as the first USER turn. This is the row stored with
 *     `role='system'` at session creation — the exact evidence the advisor was given.
 *     It MUST be replayed on every turn: it is the only place the numbers live, and a
 *     follow-up question answered without it would be answered from nothing. It is
 *     re-framed as a user turn (not concatenated into the system prompt) so the evidence
 *     sits at a fixed, quotable position in the transcript.
 *  3. The user/assistant turns in order.
 *
 * Note the asymmetry: the brief is stored under `role='system'` because it is *evidence*
 * rather than conversation (that is what keeps it out of the rendered chat bubbles), but it
 * is *sent* as a user turn because `llm/v1/chat` endpoints expect exactly one leading system
 * message.
 */
export function buildMessages(
  session: { reading_date: string; corridor: string; local_time: string },
  history: { role: string; content: string }[],
): ChatMessage[] {
  const system = systemPromptWithAnchor({
    anchor: { day: session.reading_date, corridor: session.corridor },
    localTime: session.local_time,
  });

  const messages: ChatMessage[] = [{ role: 'system', content: system }];

  // The snapshot brief, if this session has one.
  const brief = history.find((m) => m.role === 'system');
  if (brief) messages.push({ role: 'user', content: brief.content });

  for (const m of history) {
    if (m.role === 'user' || m.role === 'assistant') {
      messages.push({ role: m.role, content: m.content });
    }
  }
  return messages;
}

export function registerAdvisorRoutes(app: Application, deps: AdvisorDeps): void {
  const { db, analytics, serving } = deps;

  // ── health ────────────────────────────────────────────────────────────────────────
  app.get('/api/advisor/health', async (_req: Request, res: Response) => {
    const out: Record<string, unknown> = {};
    try {
      out.endpoint = resolveEndpointName();
    } catch (err) {
      out.endpoint = null;
      out.endpointError = err instanceof Error ? err.message : String(err);
    }
    try {
      const { rows } = await db.query<{ n: number }>('SELECT 1 AS n');
      out.database = rows.length === 1 ? 'ok' : 'unexpected';
    } catch (err) {
      out.database = 'error';
      out.databaseError = err instanceof Error ? err.message : String(err);
    }
    // Report whether the advisor tables are actually writable by THIS identity. This is the
    // check that catches the `permission denied (42501)` case the SP hits when it does not
    // own the `app` schema — see lakebase/003_grants_advisor.sql.
    try {
      const { rows } = await db.query<{ can_insert: boolean }>(
        `SELECT has_table_privilege('app.advisor_sessions', 'INSERT') AS can_insert`,
      );
      out.canWriteSessions = rows[0]?.can_insert ?? null;
    } catch (err) {
      out.canWriteSessions = null;
      out.privilegeError = err instanceof Error ? err.message : String(err);
    }
    out.user = currentUser(_req);
    res.json(out);
  });

  /**
   * ── SSE-through-proxy diagnostic ────────────────────────────────────────────────────
   * Emits 10 timestamped events, one every 300ms, with no model involved. A client that
   * receives them spread over ~3s is streaming; a client that receives all 10 at once is
   * behind a buffering proxy.
   *
   * This exists because the Apps platform guide states SSE "may be buffered" without saying
   * when, and the answer determines whether the chat UI should stream at all. Kept in the
   * shipped app (it is 20 lines and costs nothing when unused) so the behaviour can be
   * re-checked in any deployment rather than inferred from this one.
   */
  app.get('/api/advisor/diag/sse', async (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const t0 = Date.now();
    for (let i = 0; i < 10; i++) {
      res.write(`event: tick\ndata: ${JSON.stringify({ i, msSinceStart: Date.now() - t0 })}\n\n`);
      await new Promise((r) => setTimeout(r, 300));
    }
    res.write(`event: done\ndata: ${JSON.stringify({ totalMs: Date.now() - t0 })}\n\n`);
    res.end();
  });

  // ── session list ──────────────────────────────────────────────────────────────────
  app.get('/api/advisor/sessions', async (req: Request, res: Response) => {
    try {
      res.json({ sessions: await listSessions(db, currentUser(req)) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list sessions' });
    }
  });

  // ── create session (seeded from the current map snapshot) ──────────────────────────
  app.post('/api/advisor/sessions', async (req: Request, res: Response) => {
    const parsed = CreateSessionBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', detail: parsed.error.issues });
      return;
    }
    const { day, bucket, corridor } = parsed.data;
    const user = currentUser(req);

    try {
      // Build the context FIRST. If the warehouse cannot answer, no empty session is created.
      const ctx = await buildSnapshotContext(analytics, { day, bucket, corridor });

      let endpoint: string | null = null;
      try {
        endpoint = resolveEndpointName();
      } catch {
        // A session is still worth creating without a configured endpoint — the snapshot is
        // the durable artefact. The send-message route reports the misconfiguration.
      }

      const session = await createSession(db, {
        createdBy: user,
        title: parsed.data.title ?? defaultTitle(day, bucket, corridor),
        readingDate: day,
        bucketIdx: bucket,
        localHour: bucketToLocalHour(bucket),
        localTime: bucketToLocalTime(bucket),
        corridor,
        snapshotKpis: snapshotKpis(ctx),
        modelEndpoint: endpoint,
      });

      // Persist the brief as the system row: it is the exact evidence the model was given,
      // and without it an old session cannot be audited for hallucination.
      await appendMessage(db, {
        sessionId: session.id,
        role: 'system',
        content: ctx.text,
        modelEndpoint: endpoint,
      });

      await tryAudit(deps, {
        actor: user,
        action: 'advisor.session.create',
        targetType: 'advisor_session',
        targetId: session.id,
        detail: { day, bucket, corridor, context_bytes: ctx.bytes, query_ms: ctx.queryMs },
      });

      res.status(201).json({
        session,
        context: { text: ctx.text, bytes: ctx.bytes, queryMs: ctx.queryMs },
        // The client sends this back verbatim as the first turn. Prompt wording stays
        // server-owned; see server/advisor/prompt.ts.
        suggestedFirstMessage: ASSESSMENT_INSTRUCTION,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Failed to create session' });
    }
  });

  // ── load a session ────────────────────────────────────────────────────────────────
  app.get('/api/advisor/sessions/:id', async (req: Request, res: Response) => {
    const user = currentUser(req);
    try {
      const session = await getSession(db, param(req, 'id'), user);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      const [messages, recommendations] = await Promise.all([
        listMessages(db, session.id),
        listRecommendations(db, session.id),
      ]);
      res.json({
        session,
        // The system row carries the snapshot brief. Sent separately so the UI can show it
        // as "evidence the advisor saw" rather than as a chat bubble.
        context: messages.find((m) => m.role === 'system')?.content ?? null,
        messages: messages.filter((m) => m.role !== 'system'),
        recommendations,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load session' });
    }
  });

  // ── delete ────────────────────────────────────────────────────────────────────────
  app.delete('/api/advisor/sessions/:id', async (req: Request, res: Response) => {
    const user = currentUser(req);
    try {
      const ok = await deleteSession(db, param(req, 'id'), user);
      if (!ok) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }
      await tryAudit(deps, {
        actor: user,
        action: 'advisor.session.delete',
        targetType: 'advisor_session',
        targetId: param(req, 'id'),
      });
      res.status(204).send();
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to delete' });
    }
  });

  /**
   * ── mark a turn reviewed ──────────────────────────────────────────────────────────
   * A binary human-review flag on one assistant turn. Not part of the M2 recommendation
   * lifecycle (`advisor_recommendations.scenario_id`) — it records that a person read the
   * assessment, which is meaningful even for a turn that correctly recommended nothing and so
   * produced no recommendation rows at all.
   *
   * Ownership is established by loading the SESSION as the current user first, exactly as the
   * delete route does. Without that, a message id alone would be enough to flag a turn in
   * someone else's session.
   */
  app.post('/api/advisor/sessions/:id/messages/:messageId/review', async (req: Request, res: Response) => {
    const parsed = ReviewMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', detail: parsed.error.issues });
      return;
    }
    const user = currentUser(req);
    const sessionId = param(req, 'id');
    const messageId = param(req, 'messageId');

    try {
      const session = await getSession(db, sessionId, user);
      if (!session) {
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      const message = await setMessageReviewed(db, {
        sessionId,
        messageId,
        reviewedBy: user,
        reviewed: parsed.data.reviewed,
      });
      if (!message) {
        // Either no such message in this session, or it is not an assistant turn. Both are the
        // caller asking to review something that is not a reviewable assessment.
        res.status(404).json({ error: 'No reviewable assistant message with that id in this session' });
        return;
      }

      await tryAudit(deps, {
        actor: user,
        action: 'advisor.message.review',
        targetType: 'advisor_message',
        targetId: messageId,
        detail: { session_id: sessionId, reviewed: parsed.data.reviewed },
      });

      res.json({ message });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Failed to update review state' });
    }
  });

  // ── send a turn ───────────────────────────────────────────────────────────────────
  app.post('/api/advisor/sessions/:id/messages', async (req: Request, res: Response) => {
    const parsed = SendMessageBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', detail: parsed.error.issues });
      return;
    }
    const user = currentUser(req);
    const sessionId = param(req, 'id');

    let endpointName: string;
    try {
      endpointName = resolveEndpointName();
    } catch (err) {
      res.status(503).json({ error: err instanceof Error ? err.message : 'Endpoint not configured' });
      return;
    }

    let session: Awaited<ReturnType<typeof getSession>>;
    try {
      session = await getSession(db, sessionId, user);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load session' });
      return;
    }
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    // Persist the user's turn before calling the model, so a model failure cannot lose the
    // question the user asked.
    try {
      await appendMessage(db, { sessionId, role: 'user', content: parsed.data.content });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save message' });
      return;
    }

    const history = await listMessages(db, sessionId);
    const messages = buildMessages(session, history);

    await tryAudit(deps, {
      actor: user,
      action: 'advisor.message.send',
      targetType: 'advisor_session',
      targetId: sessionId,
      detail: {
        endpoint: endpointName,
        transport: parsed.data.stream ? 'stream' : 'invoke',
        chars: parsed.data.content.length,
        turns: messages.length,
      },
    });

    /** Shared tail: parse, persist, shred recommendations, and report. */
    const finish = async (
      text: string,
      usage: { promptTokens: number | null; completionTokens: number | null },
      finishReason: string | null,
      latencyMs: number,
      transport: 'stream' | 'invoke',
    ) => {
      const parsedResponse = parseModelResponse(text);
      if (parsedResponse.malformed) {
        deps.logger?.warn('advisor: recommendation block present but unparseable (session %s)', sessionId);
      }
      const message = await appendMessage(db, {
        sessionId,
        role: 'assistant',
        content: text,
        modelEndpoint: endpointName,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        latencyMs,
        finishReason,
        transport,
        recommendations: parsedResponse.recommendations.length > 0 ? parsedResponse.recommendations : null,
      });
      const recs = await insertRecommendations(db, {
        sessionId,
        messageId: message.id,
        recommendations: parsedResponse.recommendations,
      });
      await touchSession(db, sessionId);
      return { message, prose: parsedResponse.prose, recommendations: recs };
    };

    // ── non-streaming fallback ──
    if (!parsed.data.stream) {
      const started = Date.now();
      try {
        const result = await invokeModel(serving, { messages });
        const latencyMs = Date.now() - started;
        const out = await finish(result.text, result.usage, result.finishReason, latencyMs, 'invoke');
        res.json({
          messageId: out.message.id,
          content: result.text,
          prose: out.prose,
          recommendations: out.recommendations,
          usage: result.usage,
          latencyMs,
          transport: 'invoke',
        });
      } catch (err) {
        res.status(502).json({ error: err instanceof Error ? err.message : 'Model call failed' });
      }
      return;
    }

    // ── streaming ──
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    // Hint to any intermediary not to buffer. The AppKit serving plugin sets the same header
    // on its own stream route; whether the Apps proxy honours it is measured, not assumed —
    // see /api/advisor/diag/sse and the PR body.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const controller = new AbortController();
    let clientGone = false;
    req.on('close', () => {
      clientGone = true;
      controller.abort();
    });

    let text = '';
    let usage = { promptTokens: null as number | null, completionTokens: null as number | null };
    let finishReason: string | null = null;
    const started = Date.now();
    let firstDeltaMs: number | null = null;

    try {
      for await (const event of streamModel(endpointName, { messages, signal: controller.signal })) {
        if (event.delta) {
          if (firstDeltaMs === null) firstDeltaMs = Date.now() - started;
          text += event.delta;
          // Send only the prose portion: the recommendation JSON would otherwise flash on
          // screen as it is generated. The client receives the structured form in `done`.
          send('delta', { text: event.delta });
        }
        if (event.usage) usage = event.usage;
        if (event.finishReason) finishReason = event.finishReason;
        if (clientGone) break;
      }

      const latencyMs = Date.now() - started;
      const out = await finish(
        text,
        usage,
        clientGone && !finishReason ? 'aborted' : finishReason,
        latencyMs,
        'stream',
      );

      if (!clientGone) {
        send('done', {
          messageId: out.message.id,
          content: text,
          prose: out.prose,
          recommendations: out.recommendations,
          usage,
          latencyMs,
          ttfbMs: firstDeltaMs,
          transport: 'stream',
        });
        res.end();
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Model stream failed';
      // Persist whatever arrived: a partial assessment the user watched appear is worth more
      // than a gap in the transcript, and finish_reason='error' marks it as incomplete.
      if (text !== '') {
        try {
          await finish(text, usage, 'error', Date.now() - started, 'stream');
        } catch (persistErr) {
          deps.logger?.warn(
            'advisor: failed to persist partial response: %s',
            persistErr instanceof Error ? persistErr.message : String(persistErr),
          );
        }
      }
      if (!clientGone) {
        send('error', { error: message });
        res.end();
      }
    }
  });
}
