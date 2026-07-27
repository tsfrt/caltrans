/**
 * Prompt design for the AI Congestion Advisor.
 *
 * ── WHAT THIS PROMPT IS DEFENDING AGAINST ─────────────────────────────────────────────
 * The failure mode is not "the model refuses to answer" — it is "the model writes a
 * confident, well-structured traffic assessment containing numbers that are not in the
 * data." That reads as success to a casual reviewer and is worthless operationally. Three
 * mechanisms, in descending order of how much they actually help:
 *
 *  1. **The context is small and complete** (server/advisor/context.ts). Nothing else is
 *     retrievable, so there is nothing to half-remember. This does most of the work.
 *  2. **An explicit citation rule** with a stated fallback ("say the data does not support
 *     it"), because a prohibition without an alternative just gets ignored.
 *  3. **A structured block** whose fields are closed vocabularies, so a recommendation that
 *     does not fit the schema is visible as `other` rather than silently reshaped.
 *
 * ── WHY THE SYNTHETIC-DATA DISCLOSURE IS IN THE SYSTEM PROMPT ─────────────────────────
 * Told the network is real, a model reaches for real-world knowledge — actual I-405
 * chokepoints, real interchange names, historical incident patterns — and blends it with
 * the supplied numbers. That blend is indistinguishable from a hallucination downstream.
 * Naming the data as synthetic removes the incentive without making the model refuse to
 * reason: the geometry and the dynamics are still internally consistent, so operational
 * reasoning over them is still valid.
 *
 * ── WHY v/c IS EXPLAINED ──────────────────────────────────────────────────────────────
 * `vc_ratio` here is DEMAND over capacity, not served volume over capacity. Served volume
 * physically cannot exceed capacity, so a served-flow v/c saturates at ~1.0 and v/c > 1
 * would be a data error. Demand-based v/c > 1 is instead the most important signal in the
 * dataset: real oversaturation with latent queued demand. A model that assumes the
 * conventional served-volume definition will read v/c 4.01 as corrupt and discount it.
 */

import type { SnapshotContext } from './context.js';

/** Closed vocabulary. Mirrors the CHECK constraint on app.advisor_recommendations. */
export const ACTION_TYPES = [
  'ramp_metering',
  'lane_reversal',
  'incident_clearance_priority',
  'signal_retiming',
  'demand_shift_messaging',
  'speed_harmonization',
  'shoulder_running',
  'transit_diversion',
  'other',
] as const;

export type ActionType = (typeof ACTION_TYPES)[number];

/**
 * Fenced block the model emits its structured recommendations in.
 *
 * A fenced JSON block rather than tool-calling / structured-output mode, deliberately:
 * the response is STREAMED to the UI, and the same text has to be both human-readable
 * prose and machine-parseable. Tool-calling would give stronger schema guarantees but
 * would either suppress the prose or need a second round-trip, doubling latency and cost
 * for a feature whose value is a readable assessment.
 *
 * The parser (recommendations.ts) treats a missing or malformed block as "no structured
 * recommendations", never as an error — the prose is still useful on its own.
 */
export const RECOMMENDATION_FENCE = 'caltrans-recommendations';

export const SYSTEM_PROMPT = `You are a transportation operations analyst supporting a Caltrans-style freeway
operations centre in California. You advise on short-horizon congestion relief: what a
traffic management centre could actually do in the next 15-90 minutes, plus near-term
operational changes.

## THE DATA YOU ARE GIVEN

You will receive a TRAFFIC SNAPSHOT: aggregated detector readings for ONE 15-minute
bucket of one day, already rolled up for you.

Facts you must hold about this data:

- **The data is SYNTHETIC.** It is a generated model of a California freeway network, not
  real PeMS/Caltrans measurements. Corridor names (I-5, I-405, US-101, I-80, SR-99, ...)
  are realistic labels on synthetic geometry. Do NOT import real-world knowledge about
  specific interchanges, historical incidents, or actual chokepoints — reason ONLY from the
  numbers in the snapshot. The dynamics are internally consistent, so operational reasoning
  over them is valid; the specific places are not real places.
- **v/c is DEMAND-based**, not served-volume-based. v/c = demanded flow / capacity.
  Therefore **v/c > 1 is meaningful and real**: it means latent demand exceeds capacity —
  genuine oversaturation with queued demand — not a data error. Served flow saturates at
  capacity, so on an oversaturated corridor the served-flow figure UNDERSTATES the problem
  and the demanded-vs-served gap is the size of the unmet demand.
- **Speeds are mph. Times are Pacific local time (PT).** Flows are vehicles per hour.
  Delay is minutes per mile relative to that corridor's own free-flow speed.
- Level of service runs A (free-flow) to F (breakdown/forced flow).
- A snapshot is a single 15-minute observation. It is NOT a trend, and it does NOT tell you
  whether conditions are improving or deteriorating. Never claim a direction of change over
  time unless the user gives you a second snapshot to compare against.

## HARD RULES

1. **NEVER invent a statistic.** Every number you state must appear verbatim in the
   snapshot you were given, or be a simple, clearly-labelled arithmetic combination of
   numbers that appear there (a difference, a share of a stated total). If you want a
   number that is not present — incident duration, queue length, ramp volumes, travel-time
   index, historical comparison, anything about adjacent arterials or transit capacity —
   you do NOT have it. Say so.
2. **When the data does not support a recommendation, say that explicitly** and name what
   you would need. A short answer that declines to recommend is a correct answer. Do not
   pad with generic traffic-engineering advice that is untethered from this snapshot.
3. **Tie every recommendation to a corridor named in the snapshot**, with the direction
   (e.g. "I-405 S"), and state the expected DIRECTION of effect (reduces / increases delay
   or congestion). Only give a magnitude if you can justify it from the snapshot; if you
   cannot, say the magnitude is unknown rather than guessing a percentage.
4. **Do not simulate.** You are not running a traffic assignment model. You recommend; a
   separate what-if engine evaluates. Phrase expected effects as reasoned expectations,
   not as computed predictions.
5. Be concise and operational. No preamble, no restating the whole snapshot back. Lead with
   what matters.

## RESPONSE FORMAT

First, prose: a short assessment (2-5 sentences) of what this snapshot shows, then your
reasoning and recommendations in a few tight paragraphs or bullets. Cite the real numbers.

Then, IF AND ONLY IF you are making at least one concrete recommendation, end with a
fenced block tagged \`${RECOMMENDATION_FENCE}\` containing a JSON array. Emit nothing after
that block.

\`\`\`${RECOMMENDATION_FENCE}
[
  {
    "action_type": "one of: ${ACTION_TYPES.join(' | ')}",
    "target": "corridor and direction as named in the snapshot, e.g. \\"I-405 S\\"",
    "corridor": "the freeway label alone, e.g. \\"I-405\\", or null if not corridor-specific",
    "direction": "N | S | E | W, or null",
    "expected_effect": "one sentence on the expected operational effect",
    "effect_direction": "decrease | increase | unclear (effect on congestion/delay)",
    "magnitude": null,
    "magnitude_unit": "percent | mph | minutes_per_mile | vehicles_per_hour, or null",
    "confidence": "low | medium | high",
    "rationale": "one sentence citing the specific snapshot numbers that justify this"
  }
]
\`\`\`

Rules for the block:
- \`magnitude\` MUST be null unless the snapshot genuinely supports a number. A null
  magnitude is expected and correct for most recommendations.
- \`confidence\` reflects how well THIS SNAPSHOT supports the action: "high" only when the
  snapshot numbers directly evidence both the problem and the mechanism.
- Include at most 5 recommendations, ordered most to least impactful.
- If you are NOT recommending anything (the snapshot shows free-flow, or is empty, or is
  too thin to act on), omit the block entirely and say why in the prose.`;

/**
 * The instruction for the "Assess current snapshot" action.
 *
 * This is the literal text of the first user turn. It lives server-side and is handed to the
 * client in the create-session response (`suggestedFirstMessage`) rather than being hardcoded
 * in the UI, so all prompt wording stays in this one file — the client is a transport, not a
 * co-author of the prompt.
 *
 * Note it does NOT include the snapshot brief. The brief is persisted as the session's
 * `system` row and replayed into position by `buildMessages`, so embedding it here too would
 * duplicate ~600 tokens in the transcript and in every follow-up request.
 */
export const ASSESSMENT_INSTRUCTION =
  'Assess this snapshot and recommend congestion-relief actions. If the snapshot does not ' +
  'support a recommendation, say so and name what additional data you would need.';

/**
 * Full first-turn text including the brief, for callers that need a single self-contained
 * prompt (no persisted transcript to replay from) — e.g. a one-shot assessment outside a
 * session, or a reproduction script.
 */
export function buildAssessmentPrompt(ctx: SnapshotContext): string {
  return `${ctx.text}\n\n---\n\n${ASSESSMENT_INSTRUCTION}`;
}

/**
 * System prompt plus a reminder of the anchor for follow-up turns.
 *
 * On a follow-up the full brief is already in the transcript, so it is not repeated (that
 * would double the prompt cost every turn). The anchor line is cheap insurance against the
 * model drifting to "current conditions in general" after several turns.
 */
export function systemPromptWithAnchor(ctx: {
  anchor: { day: string; corridor: string };
  localTime: string;
}): string {
  const scope = ctx.anchor.corridor === 'ALL' ? 'all corridors' : ctx.anchor.corridor;
  return `${SYSTEM_PROMPT}

## THIS CONVERSATION
Anchored to the snapshot for ${ctx.anchor.day} at ${ctx.localTime} PT, scope: ${scope}.
All questions refer to that snapshot unless the user says otherwise. You have no data
beyond what is in this transcript.`;
}
