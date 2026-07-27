/**
 * Model transport: streaming and non-streaming calls to the serving endpoint.
 *
 * ── WHY THIS EXISTS INSTEAD OF USING /api/serving/stream ──────────────────────────────
 * AppKit's `serving()` plugin gives two very different capability levels, and the streaming
 * one is weaker than the docs suggest:
 *
 *   - `AppKit.serving(alias).invoke(body)` — programmatic, server-side, returns the parsed
 *     response including `usage`. This is what the fallback path uses.
 *   - `POST /api/serving/stream` — a RAW BYTE PIPE. Its handler does
 *     `pipeline(Readable.fromWeb(rawStream), res)` on the stream returned for *the client's
 *     own request body*. The server never sees the generated text.
 *
 * `exports()` returns `{ invoke, asUser }` only — there is no programmatic `stream()`.
 *
 * That makes the built-in stream route unusable for this feature, for three reasons:
 *   1. The system prompt and the snapshot brief are built SERVER-side from DBSQL. Routing
 *      through the built-in stream would mean shipping the prompt to the browser and
 *      trusting it to send it back.
 *   2. The assistant reply must be PERSISTED. Nothing in the built-in path ever observes
 *      the text, so there is nothing to write to Lakebase.
 *   3. Latency and token usage must be recorded per turn.
 *
 * So this module re-implements the streaming call using the same public primitives the
 * plugin uses internally — `getExecutionContext().client` plus
 * `apiClient.request({ raw: true })` — and the plugin stays registered for its `invoke()`
 * and, importantly, for its resource declaration (it is what puts the `serving_endpoint`
 * CAN_QUERY requirement into the bundle).
 */

import { getExecutionContext } from '@databricks/appkit';

/**
 * The authenticated WorkspaceClient for the current execution context.
 *
 * `getExecutionContext()` returns the service context by default, or the per-user (OBO)
 * context when called inside `asUser(req)` — so this picks up whichever identity the caller
 * established, exactly like the serving plugin's own internal helper.
 *
 * Note: AppKit *also* exports a `getWorkspaceClient`, but that is the **Lakebase** one
 * (`getWorkspaceClient(config: Partial<LakebasePoolConfig>)`) and it builds a client from
 * pool config rather than the request's execution context. Using it here would work by
 * accident via the SDK default auth chain while silently ignoring OBO. Hence this indirection.
 */
function workspaceClient() {
  return getExecutionContext().client;
}

/** OpenAI-compatible chat message, which is what every `llm/v1/chat` endpoint takes. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ModelUsage {
  promptTokens: number | null;
  completionTokens: number | null;
}

export interface StreamEvent {
  /** Incremental text. */
  delta?: string;
  usage?: ModelUsage;
  finishReason?: string;
}

/**
 * Resolve the endpoint name from the environment.
 *
 * NEVER hardcoded: `app.yaml` injects it via `valueFrom: serving-endpoint`, and the bundle
 * declares the resource with CAN_QUERY. Throwing here (rather than defaulting to some
 * endpoint name) makes a misconfiguration loud at first use instead of silently querying
 * the wrong model.
 */
export function resolveEndpointName(): string {
  const name = process.env.DATABRICKS_SERVING_ENDPOINT_NAME;
  if (!name) {
    throw new Error(
      'DATABRICKS_SERVING_ENDPOINT_NAME is not set. Add `valueFrom: serving-endpoint` to ' +
        'app.yaml (deployed) or set it in .env (local).',
    );
  }
  return name;
}

/**
 * Parse one SSE `data:` payload from a chat-completions stream.
 *
 * Handles both the delta-carrying chunks and the trailing usage-only chunk. Returns null for
 * `[DONE]` and for anything unparseable — a malformed chunk mid-stream should not abort a
 * response that is otherwise fine.
 */
export function parseSseData(payload: string): StreamEvent | null {
  const trimmed = payload.trim();
  if (!trimmed || trimmed === '[DONE]') return null;

  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }

  const event: StreamEvent = {};

  const choices = obj.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const c = choices[0] as Record<string, unknown>;
    const delta = c.delta as Record<string, unknown> | undefined;
    const content = delta?.content;
    if (typeof content === 'string' && content !== '') event.delta = content;
    // Some endpoints emit the whole message instead of a delta on the final chunk.
    const message = c.message as Record<string, unknown> | undefined;
    if (!event.delta && typeof message?.content === 'string' && message.content !== '') {
      event.delta = message.content;
    }
    const fr = c.finish_reason;
    if (typeof fr === 'string' && fr !== '') event.finishReason = fr;
  }

  const usage = obj.usage as Record<string, unknown> | undefined;
  if (usage) {
    const p = usage.prompt_tokens;
    const co = usage.completion_tokens;
    event.usage = {
      promptTokens: typeof p === 'number' ? p : null,
      completionTokens: typeof co === 'number' ? co : null,
    };
  }

  return Object.keys(event).length > 0 ? event : null;
}

/**
 * Split a byte chunk stream into SSE events.
 *
 * Buffers across chunk boundaries: a `data:` line can be split mid-JSON by the transport,
 * and parsing each raw chunk independently would drop those. Events are separated by a blank
 * line per the SSE spec, but Databricks emits one `data:` line per event, so this splits on
 * newlines and treats each `data:` prefix as a complete event.
 */
export async function* iterateSse(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<StreamEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const event = parseSseData(line.slice(5));
        if (event) yield event;
      }
    }
    // Flush a final unterminated line (stream ended without a trailing newline).
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const event = parseSseData(tail.slice(5));
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface ModelCallOptions {
  messages: ChatMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * ── WHY NO `temperature` / `top_p` ────────────────────────────────────────────────────
 * Newer reasoning models on this workspace REJECT sampling parameters outright — they do not
 * ignore them. Verified against the live endpoints:
 *
 *   databricks-claude-sonnet-5  temperature → BAD_REQUEST "Model us.anthropic.claude-sonnet-5
 *                                             does not support the temperature parameter"
 *   databricks-claude-sonnet-5  top_p       → BAD_REQUEST "does not support sampling..."
 *   databricks-gpt-5-5          temperature → "Unsupported value: 'temperature'..."
 *   databricks-gpt-5-5          top_p       → "Unsupported parameter: 'top_p'..."
 *   databricks-claude-haiku-4-5 both        → OK
 *
 * Since the endpoint is operator-configurable via `app.yaml` (`valueFrom: serving-endpoint`),
 * sending a sampling parameter would make the advisor fail hard on a perfectly valid model
 * choice — and it would fail at first use, not at deploy time. The request body therefore
 * carries only `messages`, `max_tokens`, and `stream`, which every `llm/v1/chat` endpoint
 * accepts. Determinism is not sacrificed for much here: these models default to low
 * effective temperature, and the prompt (not sampling) is what constrains the output.
 */

/**
 * Default output token budget.
 *
 * MEASURED, not guessed: a full all-corridor PM-peak assessment (prose + 4-5 structured
 * recommendations) hit exactly 1600 completion tokens and came back with
 * `finish_reason: "length"` — the recommendation block was cut mid-object, and only 2 of the
 * intended recommendations survived the parser's truncation salvage. 3000 leaves headroom for
 * the worst case observed (all corridors, PM peak, 12 listed incidents).
 *
 * Still bounded well inside the Apps platform's non-configurable 120s request ceiling:
 * measured generation is ~19s at 1600 tokens, so ~35-40s at this cap.
 */
export const DEFAULT_MAX_TOKENS = 3000;

/**
 * Streaming call. Yields events as they arrive from the endpoint.
 */
export async function* streamModel(
  endpointName: string,
  opts: ModelCallOptions,
): AsyncGenerator<StreamEvent> {
  const client = workspaceClient();
  const response = await client.apiClient.request({
    path: `/serving-endpoints/${encodeURIComponent(endpointName)}/invocations`,
    method: 'POST',
    headers: new Headers({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    }),
    payload: {
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
      stream: true,
      // Ask for usage on the final chunk. Endpoints that ignore this simply omit it, and the
      // caller persists null token counts rather than failing.
      stream_options: { include_usage: true },
    },
    raw: true,
  });

  const contents = (response as { contents?: ReadableStream<Uint8Array> | null }).contents;
  if (!contents) throw new Error('Serving endpoint returned no response body for a stream request');

  yield* iterateSse(contents);
}

export interface InvokeResult {
  text: string;
  usage: ModelUsage;
  finishReason: string | null;
}

/** Minimal shape of the AppKit serving handle used for the non-streaming path. */
export interface ServingLike {
  invoke: (body: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Extract the assistant text from a non-streaming chat completion.
 *
 * Tolerant of envelope shape: AppKit's `invoke` resolves the plugin's ExecutionResult, which
 * may or may not wrap the payload in `.data`. Rather than asserting one shape, look for the
 * `choices` array wherever it is.
 */
export function extractInvokeResult(raw: unknown): InvokeResult {
  const candidates: unknown[] = [raw];
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    for (const k of ['data', 'result', 'response']) if (r[k]) candidates.push(r[k]);
  }

  for (const cand of candidates) {
    if (!cand || typeof cand !== 'object') continue;
    const c = cand as Record<string, unknown>;
    const choices = c.choices;
    if (!Array.isArray(choices) || choices.length === 0) continue;

    const first = choices[0] as Record<string, unknown>;
    const message = first.message as Record<string, unknown> | undefined;
    const content = message?.content ?? (first.delta as Record<string, unknown> | undefined)?.content;
    const usage = c.usage as Record<string, unknown> | undefined;

    return {
      text: typeof content === 'string' ? content : '',
      usage: {
        promptTokens: typeof usage?.prompt_tokens === 'number' ? usage.prompt_tokens : null,
        completionTokens: typeof usage?.completion_tokens === 'number' ? usage.completion_tokens : null,
      },
      finishReason: typeof first.finish_reason === 'string' ? first.finish_reason : null,
    };
  }

  return { text: '', usage: { promptTokens: null, completionTokens: null }, finishReason: null };
}

/**
 * Non-streaming call via the AppKit serving plugin.
 *
 * This is the fallback the UI uses when streaming is unavailable or disabled, and it is the
 * reason the `serving()` plugin stays registered: it carries OBO execution and the plugin's
 * retry/timeout interceptors.
 */
export async function invokeModel(
  serving: ServingLike,
  opts: ModelCallOptions,
): Promise<InvokeResult> {
  const raw = await serving.invoke({
    messages: opts.messages,
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
  return extractInvokeResult(raw);
}
