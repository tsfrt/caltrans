/**
 * Deployed-environment SSE self-probe.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────────────
 * The Apps platform guide says SSE responses "may be buffered" by the reverse proxy, without
 * saying when. That single fact decides whether the advisor should stream at all — and it
 * cannot be answered from outside this workspace, because Databricks Apps sits behind an
 * OIDC/SSO proxy that rejects PAT auth: `GET /` returns 302 → /oidc/oauth2/v2.0/authorize and
 * `/api/*` returns 401, with or without a bearer token. So no external client in this
 * environment can measure the deployed app's streaming behaviour.
 *
 * The app itself CAN: the platform injects `DATABRICKS_CLIENT_ID` / `DATABRICKS_CLIENT_SECRET`,
 * which mint a real OAuth token that the proxy accepts. So at startup the app:
 *
 *   1. mints an OAuth token via client-credentials,
 *   2. calls its OWN public URL — `GET /api/advisor/diag/sse`, which emits 10 ticks 300 ms
 *      apart — so the request traverses the real reverse proxy,
 *   3. measures the arrival spread of the response chunks,
 *   4. writes the verdict to `app.audit`, which is readable over psql.
 *
 * Step 4 is the point: it closes the observability loop without needing an authenticated
 * external client. `databricks apps logs` is also unavailable here (it requires OAuth and
 * fails on a PAT profile), so stdout would be a dead end.
 *
 * ── HOW THE VERDICT IS DECIDED ────────────────────────────────────────────────────────
 * On ARRIVAL SPREAD, not total duration. A buffering proxy still takes ~2.7 s to deliver the
 * whole body, so duration alone proves nothing. Many chunks spread over seconds ⇒ streaming.
 * One chunk, or all chunks within a few ms ⇒ buffered.
 *
 * This runs once per container start, costs one in-process HTTP request, and is skipped
 * entirely when not deployed (no client id) or when the self URL is not configured.
 */

import type { Db } from './store.js';
import { audit } from './store.js';

export interface SseProbeResult {
  verdict: 'streaming' | 'buffered' | 'unavailable';
  chunks: number;
  firstChunkMs: number | null;
  lastChunkMs: number | null;
  spreadMs: number | null;
  status: number | null;
  detail: string;
}

/**
 * Mint a workspace OAuth token from the injected service-principal credentials.
 *
 * Uses the client-credentials grant against the workspace OIDC endpoint with the `all-apis`
 * scope. Returns null (rather than throwing) when the credentials are absent, which is the
 * normal local-development case.
 */
async function mintOAuthToken(): Promise<string | null> {
  const host = process.env.DATABRICKS_HOST;
  const clientId = process.env.DATABRICKS_CLIENT_ID;
  const clientSecret = process.env.DATABRICKS_CLIENT_SECRET;
  if (!host || !clientId || !clientSecret) return null;

  const base = host.startsWith('http') ? host : `https://${host}`;
  const res = await fetch(`${base}/oidc/v1/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'all-apis' }),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { access_token?: string };
  return body.access_token ?? null;
}

/**
 * Probe the deployed app's own SSE endpoint through the public URL (and therefore through the
 * reverse proxy).
 */
export async function probeSseThroughProxy(selfUrl: string): Promise<SseProbeResult> {
  const token = await mintOAuthToken();
  if (!token) {
    return {
      verdict: 'unavailable',
      chunks: 0,
      firstChunkMs: null,
      lastChunkMs: null,
      spreadMs: null,
      status: null,
      detail: 'no service-principal credentials in env (not a deployed app)',
    };
  }

  const url = `${selfUrl.replace(/\/$/, '')}/api/advisor/diag/sse`;
  const t0 = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    });
  } catch (err) {
    return {
      verdict: 'unavailable',
      chunks: 0,
      firstChunkMs: null,
      lastChunkMs: null,
      spreadMs: null,
      status: null,
      // A network failure here is itself a finding: it means the container cannot reach its
      // own public hostname (egress restriction), not that streaming is broken.
      detail: `fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok || !res.body) {
    return {
      verdict: 'unavailable',
      chunks: 0,
      firstChunkMs: null,
      lastChunkMs: null,
      spreadMs: null,
      status: res.status,
      detail: `HTTP ${res.status} — the proxy did not pass the request through`,
    };
  }

  const reader = res.body.getReader();
  let chunks = 0;
  let firstChunkMs: number | null = null;
  let lastChunkMs: number | null = null;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        chunks++;
        const at = Date.now() - t0;
        if (firstChunkMs === null) firstChunkMs = at;
        lastChunkMs = at;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (firstChunkMs === null) {
    return {
      verdict: 'buffered',
      chunks: 0,
      firstChunkMs: null,
      lastChunkMs: null,
      spreadMs: null,
      status: res.status,
      detail: 'response body produced no chunks',
    };
  }

  const spreadMs = (lastChunkMs ?? firstChunkMs) - firstChunkMs;
  // The server spends ~2.7s emitting 10 ticks. Real incremental delivery therefore spreads
  // over seconds; a buffered body arrives as one (or a few back-to-back) chunks.
  const streaming = chunks > 1 && spreadMs > 700;

  return {
    verdict: streaming ? 'streaming' : 'buffered',
    chunks,
    firstChunkMs,
    lastChunkMs,
    spreadMs,
    status: res.status,
    detail: `${chunks} chunk(s); first at ${firstChunkMs}ms, last at ${lastChunkMs}ms, spread ${spreadMs}ms`,
  };
}

/**
 * Run the probe at startup and record the verdict in `app.audit`.
 *
 * Fire-and-forget and fully guarded: a diagnostic must never delay or break app startup.
 * Skipped when `ADVISOR_SELF_URL` is unset, which is how local development opts out.
 */
export function recordSseProbe(
  db: Db,
  logger: { warn: (msg: string, ...args: unknown[]) => void } = console,
): void {
  const selfUrl = process.env.ADVISOR_SELF_URL;
  if (!selfUrl) return;

  void (async () => {
    try {
      // Give the server a moment to start listening — the probe calls back in through the
      // public URL, so this app must already be serving.
      await new Promise((r) => setTimeout(r, 5000));
      const result = await probeSseThroughProxy(selfUrl);
      await audit(db, {
        actor: 'system',
        action: 'advisor.diag.sse_through_proxy',
        targetType: 'app',
        targetId: process.env.DATABRICKS_APP_NAME ?? 'caltrans-whatif',
        detail: { ...result, self_url: selfUrl },
      });
      logger.warn('advisor: SSE-through-proxy probe → %s (%s)', result.verdict, result.detail);
    } catch (err) {
      logger.warn(
        'advisor: SSE-through-proxy probe failed: %s',
        err instanceof Error ? err.message : String(err),
      );
    }
  })();
}
