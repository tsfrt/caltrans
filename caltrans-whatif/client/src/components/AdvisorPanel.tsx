import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  Skeleton,
  Textarea,
} from '@databricks/appkit-ui/react';
import {
  ALL_CORRIDORS,
  type AdvisorMessage,
  type AdvisorSession,
  type Recommendation,
  type UseAdvisorResult,
} from '../lib/useAdvisor';
import { ACTION_LABELS, stripRecommendationFence } from '../lib/advisorText';

/**
 * The AI Congestion Advisor panel.
 *
 * ── LAYOUT CONTRACT WITH M1 ───────────────────────────────────────────────────────────
 * This panel is a SIBLING of the map, never an overlay on it, and it is collapsed by
 * default (see TrafficMapPage). The M1 layout — map flexes, 20rem side panel — is preserved
 * exactly when the advisor is closed; opening it narrows the map rather than covering it, so
 * the animation and the KPIs stay visible while you read the advice. That matters because
 * the whole point is to reason about what the map is showing.
 */

export interface AdvisorPanelProps {
  advisor: UseAdvisorResult;
  /** What the map is currently showing — the anchor a new session would be created from. */
  current: { day: string; bucket: number; localTime: string; corridor: string };
  onClose: () => void;
}

export function AdvisorPanel({ advisor, current, onClose }: AdvisorPanelProps) {
  const {
    sessions,
    session,
    context,
    messages,
    loading,
    sending,
    error,
    transport,
    transportDetail,
    assess,
    send,
    open,
    remove,
    setReviewed,
    reset,
  } = advisor;

  const [draft, setDraft] = useState('');
  const [showContext, setShowContext] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Follow the stream. Depends on the accumulated length so it also fires as deltas land,
  // not only when a message is added.
  const totalChars = messages.reduce((n, m) => n + m.content.length, 0);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, totalChars]);

  const anchorMatchesMap =
    session !== null &&
    session.reading_date === current.day &&
    session.bucket_idx === current.bucket &&
    session.corridor === current.corridor;

  const canSubmit = draft.trim().length > 0 && !sending && session !== null;

  function submit() {
    if (!canSubmit) return;
    const text = draft.trim();
    setDraft('');
    void send(text);
  }

  return (
    <aside
      className="flex w-full shrink-0 flex-col overflow-hidden rounded-lg border bg-card lg:w-[26rem]"
      data-testid="advisor-panel"
    >
      {/* ── header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="text-sm font-semibold">AI Congestion Advisor</h2>
        <Badge
          variant={transport === 'stream' ? 'secondary' : transport === 'probing' ? 'outline' : 'destructive'}
          title={transportDetail}
          data-testid="advisor-transport"
        >
          {transport === 'probing' ? 'probing…' : transport === 'stream' ? 'streaming' : 'buffered'}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => setShowSessions((v) => !v)}
          data-testid="advisor-sessions-toggle"
        >
          History ({sessions.length})
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close advisor">
          ✕
        </Button>
      </div>

      {/* ── session list ───────────────────────────────────────────────────── */}
      {showSessions ? (
        <div className="max-h-56 overflow-y-auto border-b" data-testid="advisor-session-list">
          {sessions.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">
              No saved sessions yet. Assess a snapshot to create one.
            </p>
          ) : (
            <ul className="divide-y">
              {sessions.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-3 py-2">
                  <button
                    className="min-w-0 flex-1 text-left"
                    onClick={() => {
                      setShowSessions(false);
                      void open(s.id);
                    }}
                    data-testid="advisor-session-item"
                  >
                    <div className="truncate text-xs font-medium">{s.title}</div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {s.message_count ?? 0} message{s.message_count === 1 ? '' : 's'} ·{' '}
                      {new Date(s.updated_at).toLocaleString()}
                    </div>
                  </button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(s.id)}
                    aria-label={`Delete ${s.title}`}
                  >
                    🗑
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      {/* ── snapshot anchor ────────────────────────────────────────────────── */}
      <div className="border-b bg-muted/40 px-3 py-2 text-xs" data-testid="advisor-anchor">
        {session ? (
          <>
            <div className="flex items-center gap-2">
              <span className="font-semibold">Anchored to</span>
              <span className="tabular-nums">
                {session.reading_date} · {session.local_time} PT ·{' '}
                {session.corridor === ALL_CORRIDORS ? 'all corridors' : session.corridor}
              </span>
            </div>
            <SnapshotSummary session={session} />
            {!anchorMatchesMap ? (
              // The single most important warning in this panel: advice is only valid against
              // the state that produced it, and the map has since moved.
              <p className="mt-1 text-[11px] text-amber-500" data-testid="advisor-anchor-drift">
                The map now shows {current.day} {current.localTime} PT ·{' '}
                {current.corridor === ALL_CORRIDORS ? 'all corridors' : current.corridor}. This
                chat still refers to the snapshot above.
              </p>
            ) : null}
            <div className="mt-1 flex gap-2">
              <button
                className="text-[11px] underline decoration-dotted"
                onClick={() => setShowContext((v) => !v)}
                data-testid="advisor-context-toggle"
              >
                {showContext ? 'Hide' : 'Show'} the data the advisor saw
              </button>
              <button className="text-[11px] underline decoration-dotted" onClick={reset}>
                New
              </button>
            </div>
          </>
        ) : (
          <span className="text-muted-foreground">
            No session. Assess the current snapshot ({current.day} {current.localTime} PT ·{' '}
            {current.corridor === ALL_CORRIDORS ? 'all corridors' : current.corridor}) to start.
          </span>
        )}
      </div>

      {showContext && context ? (
        <pre
          className="max-h-64 overflow-auto border-b bg-background px-3 py-2 text-[10px] leading-snug whitespace-pre-wrap"
          data-testid="advisor-context"
        >
          {context}
        </pre>
      ) : null}

      {/* ── transcript ─────────────────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3" data-testid="advisor-transcript">
        {loading && messages.length === 0 ? (
          <div className="space-y-2">
            <Skeleton className="h-3 w-48" />
            <p className="text-xs text-muted-foreground">
              Aggregating the snapshot from DBSQL…
            </p>
          </div>
        ) : null}

        {!session && !loading ? (
          <div className="space-y-2 text-xs text-muted-foreground">
            <p>
              The advisor reads an aggregated summary of the snapshot currently on the map —
              worst corridors by delay, stations over capacity, LOS mix, and active incidents —
              and recommends congestion-relief actions.
            </p>
            <p>
              It is instructed to cite only numbers present in that summary and to say when the
              data does not support a recommendation.
            </p>
          </div>
        ) : null}

        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} onSetReviewed={setReviewed} />
        ))}

        {sending && transport === 'invoke' ? (
          // Non-streaming path: no deltas arrive, so an explicit indeterminate state is the
          // only honest feedback.
          <div className="text-xs text-muted-foreground" data-testid="advisor-thinking">
            Consulting the model (no incremental output on this connection)…
          </div>
        ) : null}

        {error ? (
          <p className="text-xs text-destructive" data-testid="advisor-error">
            {error}
          </p>
        ) : null}
      </div>

      {/* ── composer ───────────────────────────────────────────────────────── */}
      <div className="space-y-2 border-t px-3 py-2">
        <Button
          className="w-full"
          size="sm"
          disabled={loading || sending || transport === 'probing'}
          onClick={() =>
            void assess({ day: current.day, bucket: current.bucket, corridor: current.corridor })
          }
          data-testid="advisor-assess"
        >
          Assess current snapshot
        </Button>

        <div className="flex gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              session ? 'Ask a follow-up about this snapshot…' : 'Assess a snapshot first'
            }
            disabled={!session || sending}
            rows={2}
            className="min-h-0 flex-1 text-xs"
            data-testid="advisor-input"
          />
          <Button size="sm" disabled={!canSubmit} onClick={submit} data-testid="advisor-send">
            Send
          </Button>
        </div>
      </div>
    </aside>
  );
}

/** The KPIs the advisor was given, so the anchor is verifiable at a glance. */
function SnapshotSummary({ session }: { session: AdvisorSession }) {
  const k = session.snapshot_kpis ?? {};
  const parts: string[] = [];
  if (k.mean_speed_mph != null) parts.push(`${k.mean_speed_mph} mph mean`);
  if (k.stations_over_capacity != null && k.station_count != null) {
    parts.push(`${k.stations_over_capacity}/${k.station_count} over capacity`);
  }
  if (k.incident_total != null) parts.push(`${k.incident_total} incident stations`);
  if (parts.length === 0) return null;
  return (
    <div className="mt-0.5 text-[11px] text-muted-foreground tabular-nums">{parts.join(' · ')}</div>
  );
}

function MessageBubble({
  message,
  onSetReviewed,
}: {
  message: AdvisorMessage;
  onSetReviewed: (messageId: string, reviewed: boolean) => Promise<void>;
}) {
  const isUser = message.role === 'user';
  const prose = useMemo(() => stripRecommendationFence(message.content), [message.content]);
  const recs = message.recommendations ?? [];

  return (
    <div data-testid={isUser ? 'advisor-msg-user' : 'advisor-msg-assistant'}>
      <div
        className={
          isUser
            ? 'ml-6 rounded-lg bg-primary/10 px-3 py-2 text-xs whitespace-pre-wrap'
            : 'rounded-lg bg-muted/50 px-3 py-2 text-xs whitespace-pre-wrap'
        }
      >
        {prose || (message.pending ? <span className="text-muted-foreground">…</span> : null)}
        {message.pending ? <span className="ml-1 animate-pulse">▋</span> : null}
      </div>

      {recs.length > 0 ? (
        <div className="mt-2 space-y-2" data-testid="advisor-recommendations">
          {recs.map((r, i) => (
            <RecommendationCard key={r.id ?? i} rec={r} />
          ))}
        </div>
      ) : null}

      {!isUser && !message.pending ? (
        <div className="flex items-center gap-2">
          <MessageMeta message={message} />
          <ReviewToggle message={message} onSetReviewed={onSetReviewed} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The human-reviewed flag for one assessment.
 *
 * Binary and per-turn, deliberately separate from the recommendation cards: it records that a
 * person read THIS assessment, which is meaningful even when the advisor correctly recommended
 * nothing and there are no cards at all.
 *
 * A local `busy` guard rather than a global `sending` one, so flagging a turn does not disable
 * the composer or the other turns' toggles — this is not a model call.
 */
function ReviewToggle({
  message,
  onSetReviewed,
}: {
  message: AdvisorMessage;
  onSetReviewed: (messageId: string, reviewed: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const reviewed = message.reviewed_at != null;

  // A turn that only exists client-side (an optimistic id from a non-streaming send that has
  // not been replaced yet) has no row to flag.
  if (message.id.startsWith('local-') || message.id.startsWith('pending-')) return null;

  return (
    <div className="ml-auto flex items-center gap-1.5">
      {reviewed ? (
        <Badge
          variant="secondary"
          className="text-[10px]"
          title={
            message.reviewed_by
              ? `Reviewed by ${message.reviewed_by} at ${new Date(message.reviewed_at as string).toLocaleString()}`
              : undefined
          }
          data-testid="advisor-reviewed-badge"
        >
          Reviewed
        </Badge>
      ) : null}
      <button
        className="text-[10px] text-muted-foreground underline decoration-dotted disabled:opacity-50"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void onSetReviewed(message.id, !reviewed).finally(() => setBusy(false));
        }}
        data-testid="advisor-review-toggle"
        aria-pressed={reviewed}
      >
        {reviewed ? 'Unmark' : 'Mark reviewed'}
      </button>
    </div>
  );
}

/**
 * Structured recommendations render as cards, deliberately unlike the prose bubbles: these are
 * the machine-readable artefacts M2 will turn into scenario runs, and conflating them with
 * narrative would hide that distinction.
 */
function RecommendationCard({ rec }: { rec: Recommendation }) {
  const label = ACTION_LABELS[rec.action_type] ?? rec.action_type;
  const dir = rec.effect_direction;
  const dirTone =
    dir === 'decrease' ? 'text-emerald-500' : dir === 'increase' ? 'text-red-500' : 'text-muted-foreground';

  return (
    <Card className="border-l-4 border-l-primary" data-testid="advisor-recommendation">
      <CardContent className="space-y-1 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold">{label}</span>
          <Badge variant="outline" className="text-[10px]">
            {rec.target_label}
          </Badge>
          {rec.confidence ? (
            <Badge
              variant={rec.confidence === 'high' ? 'secondary' : 'outline'}
              className="text-[10px]"
            >
              {rec.confidence} confidence
            </Badge>
          ) : null}
        </div>
        <p className="text-[11px]">{rec.expected_effect}</p>
        <div className="flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
          {dir ? <span className={dirTone}>congestion {dir}</span> : null}
          <span>
            magnitude:{' '}
            {rec.magnitude == null
              ? // Surfaced explicitly rather than hidden: "not quantified" is the honest and
                // expected state, and M2 must not silently treat it as zero.
                'not quantified'
              : `${rec.magnitude}${rec.magnitude_unit ? ` ${rec.magnitude_unit}` : ''}`}
          </span>
        </div>
        {rec.rationale ? (
          <p className="text-[10px] italic text-muted-foreground">{rec.rationale}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** Per-turn provenance: which model, how long, how many tokens, which transport. */
function MessageMeta({ message }: { message: AdvisorMessage }) {
  const bits: string[] = [];
  if (message.model_endpoint) bits.push(message.model_endpoint);
  if (message.latency_ms != null) bits.push(`${(message.latency_ms / 1000).toFixed(1)}s`);
  if (message.prompt_tokens != null && message.completion_tokens != null) {
    bits.push(`${message.prompt_tokens}→${message.completion_tokens} tok`);
  }
  if (message.transport) bits.push(message.transport);
  // A response cut off by the token cap is materially different from a complete one.
  if (message.finish_reason && message.finish_reason !== 'stop') {
    bits.push(`⚠ ${message.finish_reason}`);
  }
  if (bits.length === 0) return null;
  return <div className="mt-1 text-[10px] text-muted-foreground">{bits.join(' · ')}</div>;
}
