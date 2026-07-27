/**
 * THE advisor data-access seam.
 *
 * Mirrors the role `useTrafficData.ts` plays for the map: every advisor network call goes
 * through here, and no component below knows a URL. The map's data flows through AppKit's
 * `useAnalyticsQuery`; the advisor's cannot, because its routes are custom Express endpoints
 * (see server/advisor/routes.ts) rather than typegen'd warehouse queries — so this module
 * hand-rolls fetch + SSE parsing.
 *
 * ── WHY STREAMING IS NEGOTIATED, NOT ASSUMED ──────────────────────────────────────────
 * The Databricks Apps reverse proxy "may buffer" SSE (platform guide), and that behaviour is
 * environment-dependent. Shipping a token-by-token UX that silently collapses into a 20-second
 * blank screen in production is the exact failure this module is built to avoid. So the client
 * PROBES `/api/advisor/diag/sse` once per page load and picks its transport from the result:
 *
 *   streaming works  → POST with `stream: true`,  render deltas live
 *   buffered/blocked → POST with `stream: false`, render a determinate loading state
 *
 * Either way the server persists identically, and `transport` is recorded per message so the
 * transcript says which path produced each turn.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export const ALL_CORRIDORS = 'ALL';

export interface AdvisorSession {
  id: string;
  created_by: string;
  title: string;
  reading_date: string;
  bucket_idx: number;
  local_hour: number;
  local_time: string;
  corridor: string;
  snapshot_kpis: SnapshotKpis;
  model_endpoint: string | null;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export interface SnapshotKpis {
  station_count?: number | null;
  mean_speed_mph?: number | null;
  min_speed_mph?: number | null;
  mean_vc?: number | null;
  max_vc?: number | null;
  stations_over_capacity?: number | null;
  stations_congested?: number | null;
  stations_with_incident?: number | null;
  total_demanded_flow_vph?: number | null;
  total_served_flow_vph?: number | null;
  mean_delay_min_per_mi?: number | null;
  incident_total?: number | null;
  context_bytes?: number | null;
  query_ms?: number | null;
  worst_corridors?: {
    freeway: string;
    direction: string;
    mean_speed_mph: number | null;
    mean_delay_min_per_mi: number | null;
    mean_vc: number | null;
    stations_over_capacity: number | null;
    station_count: number | null;
  }[];
}

export interface Recommendation {
  id?: string;
  seq?: number;
  action_type: string;
  target_label: string;
  target_corridor: string | null;
  target_direction: string | null;
  expected_effect: string;
  effect_direction: string | null;
  magnitude: number | string | null;
  magnitude_unit: string | null;
  confidence: string | null;
  rationale: string | null;
}

export interface AdvisorMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  model_endpoint?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  latency_ms?: number | null;
  finish_reason?: string | null;
  transport?: string | null;
  recommendations?: Recommendation[] | null;
  created_at: string;
  /** Set while an assistant turn is still streaming. */
  pending?: boolean;
}

/** Transport the client resolved for this page load. */
export type Transport = 'stream' | 'invoke' | 'probing';

/**
 * Narrow an `unknown` SSE payload field to a string.
 *
 * The payloads come off the wire as `unknown`; interpolating one directly would render
 * "[object Object]" if the server ever changed a field's shape. Returning undefined lets the
 * caller keep its existing value instead.
 */
function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // fall through — a non-JSON body means an infrastructure error page, not an API error
  }
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

/**
 * Probe whether SSE survives whatever sits between this browser and the app.
 *
 * The server emits 10 ticks 300ms apart. If the first tick lands well before the last, the
 * connection is incremental. If everything arrives at once, something buffered it.
 *
 * `incremental` is decided on ARRIVAL SPREAD, not on total duration: a buffering proxy still
 * takes ~3s to deliver, so duration alone proves nothing.
 */
export async function probeSse(): Promise<{ incremental: boolean; spreadMs: number; detail: string }> {
  try {
    const res = await fetch('/api/advisor/diag/sse', { headers: { Accept: 'text/event-stream' } });
    if (!res.ok || !res.body) return { incremental: false, spreadMs: 0, detail: `HTTP ${res.status}` };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const t0 = performance.now();
    let firstChunkAt: number | null = null;
    let lastChunkAt = t0;
    let chunks = 0;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        chunks++;
        if (firstChunkAt === null) firstChunkAt = performance.now();
        lastChunkAt = performance.now();
        decoder.decode(value, { stream: true });
      }
    }

    if (firstChunkAt === null) return { incremental: false, spreadMs: 0, detail: 'no chunks' };
    const spreadMs = lastChunkAt - firstChunkAt;
    // The server spends ~2.7s emitting. Anything under ~700ms of spread means the transport
    // collected the whole body before releasing it.
    const incremental = spreadMs > 700 && chunks > 1;
    return {
      incremental,
      spreadMs,
      detail: `${chunks} chunk(s), first→last ${Math.round(spreadMs)}ms`,
    };
  } catch (err) {
    return {
      incremental: false,
      spreadMs: 0,
      detail: err instanceof Error ? err.message : 'probe failed',
    };
  }
}

export interface UseAdvisorResult {
  sessions: AdvisorSession[];
  session: AdvisorSession | null;
  /** The snapshot brief the advisor was given — the evidence behind the answers. */
  context: string | null;
  messages: AdvisorMessage[];
  recommendations: Recommendation[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  transport: Transport;
  transportDetail: string;
  assess: (anchor: { day: string; bucket: number; corridor: string }) => Promise<void>;
  send: (content: string) => Promise<void>;
  open: (sessionId: string) => Promise<void>;
  remove: (sessionId: string) => Promise<void>;
  reset: () => void;
}

export function useAdvisor(): UseAdvisorResult {
  const [sessions, setSessions] = useState<AdvisorSession[]>([]);
  const [session, setSession] = useState<AdvisorSession | null>(null);
  const [context, setContext] = useState<string | null>(null);
  const [messages, setMessages] = useState<AdvisorMessage[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transport, setTransport] = useState<Transport>('probing');
  const [transportDetail, setTransportDetail] = useState('probing SSE…');

  // Guards a late response from a superseded session from overwriting the current one.
  const activeSession = useRef<string | null>(null);

  // Probe once per mount.
  useEffect(() => {
    let cancelled = false;
    void probeSse().then((r) => {
      if (cancelled) return;
      setTransport(r.incremental ? 'stream' : 'invoke');
      setTransportDetail(
        r.incremental
          ? `SSE streams incrementally (${r.detail})`
          : `SSE buffered or unavailable (${r.detail}) — using non-streaming fallback`,
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshSessions = useCallback(async () => {
    try {
      const data = await json<{ sessions: AdvisorSession[] }>(await fetch('/api/advisor/sessions'));
      setSessions(data.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to list sessions');
    }
  }, []);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  const reset = useCallback(() => {
    activeSession.current = null;
    setSession(null);
    setContext(null);
    setMessages([]);
    setRecommendations([]);
    setError(null);
  }, []);

  const open = useCallback(async (sessionId: string) => {
    setLoading(true);
    setError(null);
    activeSession.current = sessionId;
    try {
      const data = await json<{
        session: AdvisorSession;
        context: string | null;
        messages: AdvisorMessage[];
        recommendations: Recommendation[];
      }>(await fetch(`/api/advisor/sessions/${sessionId}`));
      if (activeSession.current !== sessionId) return;
      setSession(data.session);
      setContext(data.context);
      setMessages(data.messages);
      setRecommendations(data.recommendations);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open session');
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Send one turn.
   *
   * Streaming path appends a `pending` assistant message and mutates its text as deltas land.
   * The final `done` event replaces it with the persisted row (real id, usage, parsed
   * recommendations), so what ends up on screen is what is in Lakebase, not the client's
   * reconstruction of it.
   */
  const sendTo = useCallback(
    async (sessionId: string, content: string, useStream: boolean) => {
      setSending(true);
      setError(null);

      const userMsg: AdvisorMessage = {
        id: `local-${Date.now()}`,
        role: 'user',
        content,
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, userMsg]);

      try {
        const res = await fetch(`/api/advisor/sessions/${sessionId}/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, stream: useStream }),
        });

        if (!useStream) {
          const data = await json<{
            messageId: string;
            content: string;
            recommendations: Recommendation[];
            usage: { promptTokens: number | null; completionTokens: number | null };
            latencyMs: number;
          }>(res);
          setMessages((prev) => [
            ...prev,
            {
              id: data.messageId,
              role: 'assistant',
              content: data.content,
              recommendations: data.recommendations,
              prompt_tokens: data.usage?.promptTokens ?? null,
              completion_tokens: data.usage?.completionTokens ?? null,
              latency_ms: data.latencyMs,
              transport: 'invoke',
              created_at: new Date().toISOString(),
            },
          ]);
          setRecommendations((prev) => [...prev, ...(data.recommendations ?? [])]);
          return;
        }

        if (!res.ok || !res.body) {
          throw new Error(`HTTP ${res.status}`);
        }

        const pendingId = `pending-${Date.now()}`;
        setMessages((prev) => [
          ...prev,
          { id: pendingId, role: 'assistant', content: '', created_at: new Date().toISOString(), pending: true },
        ]);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let streamError: string | null = null;

        const handleEvent = (name: string, dataRaw: string) => {
          if (!dataRaw) return;
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(dataRaw) as Record<string, unknown>;
          } catch {
            return;
          }
          if (name === 'delta' && typeof payload.text === 'string') {
            const text = payload.text;
            setMessages((prev) =>
              prev.map((m) => (m.id === pendingId ? { ...m, content: m.content + text } : m)),
            );
          } else if (name === 'done') {
            const recs = (payload.recommendations as Recommendation[] | undefined) ?? [];
            setMessages((prev) =>
              prev.map((m) =>
                m.id === pendingId
                  ? {
                      ...m,
                      id: asString(payload.messageId) ?? pendingId,
                      content: asString(payload.content) ?? m.content,
                      recommendations: recs,
                      latency_ms: typeof payload.latencyMs === 'number' ? payload.latencyMs : null,
                      transport: 'stream',
                      pending: false,
                    }
                  : m,
              ),
            );
            setRecommendations((prev) => [...prev, ...recs]);
          } else if (name === 'error') {
            streamError = asString(payload.error) ?? 'Model stream failed';
          }
        };

        // SSE frame parsing: events are separated by a blank line.
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, sep);
            buffer = buffer.slice(sep + 2);
            let name = 'message';
            const dataLines: string[] = [];
            for (const line of frame.split('\n')) {
              if (line.startsWith('event:')) name = line.slice(6).trim();
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
            }
            handleEvent(name, dataLines.join('\n'));
          }
        }

        if (streamError) {
          setError(streamError);
          // Leave whatever text arrived on screen but stop showing it as in-flight.
          setMessages((prev) => prev.map((m) => (m.id === pendingId ? { ...m, pending: false } : m)));
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to send message');
      } finally {
        setSending(false);
        void refreshSessions();
      }
    },
    [refreshSessions],
  );

  /**
   * "Assess current snapshot": create a session anchored to what the map is showing, then
   * immediately send the server-authored first turn.
   *
   * The instruction text comes back from the server (`suggestedFirstMessage`) rather than being
   * written here, so all prompt wording lives in server/advisor/prompt.ts.
   */
  const assess = useCallback(
    async (anchor: { day: string; bucket: number; corridor: string }) => {
      setLoading(true);
      setError(null);
      try {
        const data = await json<{
          session: AdvisorSession;
          context: { text: string; bytes: number; queryMs: number };
          suggestedFirstMessage: string;
        }>(
          await fetch('/api/advisor/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(anchor),
          }),
        );

        activeSession.current = data.session.id;
        setSession(data.session);
        setContext(data.context.text);
        setMessages([]);
        setRecommendations([]);
        await refreshSessions();
        setLoading(false);

        // `transport === 'probing'` should not happen (the button is disabled until the probe
        // resolves), but default to the safe path rather than assuming streaming works.
        await sendTo(data.session.id, data.suggestedFirstMessage, transport === 'stream');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to assess snapshot');
        setLoading(false);
      }
    },
    [refreshSessions, sendTo, transport],
  );

  const send = useCallback(
    async (content: string) => {
      if (!session) return;
      await sendTo(session.id, content, transport === 'stream');
    },
    [session, sendTo, transport],
  );

  const remove = useCallback(
    async (sessionId: string) => {
      try {
        const res = await fetch(`/api/advisor/sessions/${sessionId}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
        if (session?.id === sessionId) reset();
        await refreshSessions();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to delete session');
      }
    },
    [session, reset, refreshSessions],
  );

  return {
    sessions,
    session,
    context,
    messages,
    recommendations,
    loading,
    sending,
    error,
    transport,
    transportDetail,
    assess,
    send,
    open,
    remove,
    reset,
  };
}
