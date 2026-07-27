/**
 * Adapter: the lever UI's `ScenarioRunRequest` → this engine's `ScenarioRequest`.
 *
 * ── Why this file exists ─────────────────────────────────────────────────────
 * The lever UI (PR #7, `client/src/lib/scenario.ts`) and this engine were built
 * in parallel against no shared contract, and they landed on genuinely different
 * shapes. Both are reasonable; neither is a superset of the other. Rather than
 * change the UI (already merged, and out of this branch's file scope) or bend the
 * engine's parameter surface to a shape that does not fit DBSQL binding, the
 * translation is explicit and tested here.
 *
 * ── The differences, and how each is resolved ────────────────────────────────
 *
 * 1. LEVER SHAPE. The UI sends `levers: ScenarioLever[]` — a discriminated union,
 *    each with its own `id`, so a user can stack several closures. The engine
 *    takes ONE optional object per lever KIND, because each kind maps to a fixed
 *    set of SQL parameters and DBSQL cannot bind a variable-length list.
 *    → Resolved by folding: multiple levers of the same kind are merged into the
 *      postmile hull that covers all of them, and the widest effect wins. This is
 *      LOSSY and it is reported, not hidden: `ScenarioAdapterResult.warnings`
 *      names every fold, and the UI's own response type already has a `warnings`
 *      field to surface them in.
 *
 * 2. TARGETING. The UI targets a single `stationId`. The engine targets a
 *    postmile window on a freeway+direction, because that is what makes a
 *    "segment closure" mean a stretch of road rather than one detector.
 *    → Resolved without a lookup: the UI's `ScenarioTarget` already carries
 *      `freeway`, `direction` and `postmile`, so a tight window is built around
 *      that postmile. Width is ±`TARGET_HALF_WIDTH_MI`, chosen to be just under
 *      the densest urban detector spacing (0.60 mi, per the generator's
 *      `URBAN_SPACING_MI`) so the window catches its own station and does not
 *      silently swallow the neighbours.
 *
 * 3. INCIDENT TIME. UI: `startBucket` + `durationBuckets`. Engine: inclusive
 *    `fromBucket`..`toBucket`.
 *    → `toBucket = startBucket + durationBuckets - 1`, clamped to bucket 95. An
 *      incident that would run past midnight is TRUNCATED, not wrapped, and the
 *      truncation is warned about — wrapping would inject the incident into the
 *      morning of the same day, which is a different scenario.
 *
 * 4. CAPACITY. UI sends only an absolute `capacityVph`. The engine also supports
 *    add-lanes and a multiplier.
 *    → Absolute maps straight through. The other two are simply unreachable from
 *      the current UI; that is a UI limitation, not an engine one.
 *
 * 5. SEVERITY. The UI's mock uses severity to scale speed DIRECTLY
 *    (`INCIDENT_SPEED_FACTOR`, 0.88/0.72/0.55/0.38). The engine does not: it
 *    derives the speed effect from the capacity loss that `lanesBlocked` causes,
 *    via BPR. Severity is carried through as metadata only.
 *    → This is a REAL behavioural difference the UI should expect. Same lever,
 *      different number, because the engine routes the effect through capacity
 *      and the mock short-circuits to speed. Warned about explicitly.
 *
 * 6. RESPONSE SHAPE. The UI expects one response covering all 96 buckets with
 *    `flow`/`speed`/`vc`/`incident` as `number[]`. The engine returns four
 *    24-bucket windows of comma-separated integer strings.
 *    → NOT adapted here, deliberately. See
 *      `UI_MATRIX_ADAPTER_NOT_PROVIDED` at the bottom of this file for why the
 *      conversion is cheap on the client and expensive to do server-side.
 *
 * 7. THE BPR CONFLICT. The UI explicitly refuses to pick between 0.15/4.0 and
 *    0.55/4.5, and asks the engine to "declare which pair it used in
 *    ScenarioRunResponse.model". That is the right instinct, and `engineModel()`
 *    below answers it in exactly that field.
 */

import type { ScenarioRequest } from './contract.js';
import { BUCKETS_PER_DAY, MAX_ITERATIONS } from './params.js';

/**
 * Half-width (miles) of the postmile window built around a station target.
 * Just under the generator's densest urban detector spacing (0.60 mi) so the
 * window contains its own station without reaching the next one.
 */
export const TARGET_HALF_WIDTH_MI = 0.25;

/** The subset of the UI's `ScenarioTarget` this adapter needs. */
export interface UiTarget {
  stationId: string;
  freeway: string;
  direction: string;
  postmile: number;
}

export type UiLever =
  | { id: string; type: 'closure'; target: UiTarget; lanesClosed: number }
  | { id: string; type: 'demand_delta'; freeway: string; direction: string; percent: number }
  | {
      id: string;
      type: 'incident';
      target: UiTarget;
      startBucket: number;
      durationBuckets: number;
      lanesBlocked: number;
      severity: 1 | 2 | 3 | 4;
    }
  | { id: string; type: 'capacity_change'; target: UiTarget; capacityVph: number };

/** The subset of the UI's `ScenarioRunRequest` this adapter reads. */
export interface UiScenarioRunRequest {
  schemaVersion: string;
  day: string;
  scope: { freeway: string; direction?: string };
  levers: UiLever[];
}

export interface ScenarioAdapterResult {
  request: ScenarioRequest;
  /** Every lossy translation, in the UI's own `warnings` vocabulary. */
  warnings: string[];
}

/** `ScenarioRunResponse.model` — answers the UI's "declare which pair you used". */
export function engineModel() {
  return {
    name: 'bpr-volume-delay' as const,
    reassignment: 'corridor-postmile-simplified' as const,
    /**
     * The UI asked for this verbatim and should render it verbatim. It resolves
     * the conflict the UI correctly refused to launder: 0.55/4.5 wins because
     * this engine is INCREMENTAL — it divides one BPR factor by another, so the
     * coefficients must be the ones that produced the data or every scenario
     * measures a change against a curve the baseline was never on. The Lakebase
     * `app.config` seed of 0.15/4.0 is stale.
     */
    bprCoefficients:
      'alpha=0.55 beta=4.5 (data-generator values; Lakebase app.config seed of 0.15/4.0 is stale and NOT used)',
    caveat:
      'Reassignment is NOT network assignment: there is no road graph in this data. ' +
      'Over-capacity demand moves to parallel corridors within 8 km and 45 degrees of heading, ' +
      'to adjacent same-corridor segments, or off-network. Only 27% of stations (551 of 2,022) ' +
      'have any parallel alternative. MSA is damped over 4 iterations and has NOT converged ' +
      'there — treat results as direction and magnitude, not a converged assignment. ' +
      'See caltrans-whatif/docs/WHATIF_ENGINE.md §5.',
  };
}

const hull = (windows: Array<[number, number]>): [number, number] => [
  Math.min(...windows.map(([lo]) => lo)),
  Math.max(...windows.map(([, hi]) => hi)),
];

const targetWindow = (t: UiTarget): [number, number] => [
  t.postmile - TARGET_HALF_WIDTH_MI,
  t.postmile + TARGET_HALF_WIDTH_MI,
];

/** Are all these targets on the same freeway+direction? */
function sameCarriageway(targets: UiTarget[]): boolean {
  return targets.every((t) => t.freeway === targets[0].freeway && t.direction === targets[0].direction);
}

/**
 * Translate a UI request into an engine request.
 *
 * Throws on a target set the engine genuinely cannot express (levers of one kind
 * spread across different corridors), rather than quietly modelling only the
 * first — a scenario that silently drops a lever is indistinguishable from one
 * that worked.
 */
export function fromUiRequest(ui: UiScenarioRunRequest): ScenarioAdapterResult {
  const warnings: string[] = [];
  const request: ScenarioRequest = {
    day: ui.day,
    freeway: ui.scope?.freeway || 'ALL',
    iterations: MAX_ITERATIONS,
  };

  const byKind = <T extends UiLever['type']>(kind: T) =>
    (ui.levers ?? []).filter((l): l is Extract<UiLever, { type: T }> => l.type === kind);

  const foldNote = (kind: string, n: number) =>
    `${n} ${kind} levers were folded into one postmile window covering all of them; ` +
    `the engine takes one ${kind} lever per run, so individual per-station differences are lost.`;

  // ── closures ─────────────────────────────────────────────────────────────
  const closures = byKind('closure');
  if (closures.length > 0) {
    const targets = closures.map((c) => c.target);
    if (!sameCarriageway(targets)) {
      throw new Error(
        'closure levers span more than one freeway+direction; the engine models one ' +
          'closure target per run. Split into separate scenario runs.'
      );
    }
    if (closures.length > 1) warnings.push(foldNote('closure', closures.length));
    const [pmFrom, pmTo] = hull(targets.map(targetWindow));
    request.closure = {
      freeway: targets[0].freeway,
      direction: targets[0].direction,
      postmileFrom: pmFrom,
      postmileTo: pmTo,
      // The worst closure governs: folding by max is conservative (it cannot
      // under-report the impact), whereas summing would invent a closure wider
      // than any the user actually asked for.
      lanes: Math.max(...closures.map((c) => c.lanesClosed)),
    };
  }

  // ── demand deltas ────────────────────────────────────────────────────────
  const demands = byKind('demand_delta');
  if (demands.length > 0) {
    if (demands.length > 1) {
      warnings.push(
        `${demands.length} demand levers were combined multiplicatively into one percentage; ` +
          `the engine applies one demand delta per run.`
      );
    }
    // Multiplicative, not additive: +10% then +10% is +21%, not +20%.
    //
    // A SINGLE lever passes through untouched rather than round-tripping through
    // the factor. `(1 + 20/100 - 1) * 100` is 19.999999999999996 in IEEE 754, and
    // the common case should not carry float noise into a user-visible percentage
    // just to share a code path with the rare one.
    const percent =
      demands.length === 1
        ? demands[0].percent
        : (demands.reduce((acc, d) => acc * (1 + d.percent / 100), 1) - 1) * 100;
    const spansCorridors = demands.some(
      (d) => d.freeway !== demands[0].freeway || d.direction !== demands[0].direction
    );
    if (spansCorridors) {
      warnings.push(
        'demand levers targeted different corridors and were widened to ALL corridors, ' +
          'which applies the delta network-wide rather than per corridor.'
      );
    }
    if (Math.abs(percent) < 1e-9) {
      warnings.push('demand levers cancelled out exactly; the demand lever was dropped.');
    } else {
      request.demand = {
        freeway: spansCorridors ? 'ALL' : demands[0].freeway,
        direction: spansCorridors ? undefined : demands[0].direction,
        percent,
      };
    }
  }

  // ── incidents ────────────────────────────────────────────────────────────
  const incidents = byKind('incident');
  if (incidents.length > 0) {
    const targets = incidents.map((i) => i.target);
    if (!sameCarriageway(targets)) {
      throw new Error(
        'incident levers span more than one freeway+direction; the engine models one ' +
          'incident target per run. Split into separate scenario runs.'
      );
    }
    if (incidents.length > 1) warnings.push(foldNote('incident', incidents.length));
    const [pmFrom, pmTo] = hull(targets.map(targetWindow));
    const fromBucket = Math.max(0, Math.min(...incidents.map((i) => i.startBucket)));
    const rawTo = Math.max(...incidents.map((i) => i.startBucket + i.durationBuckets - 1));
    const toBucket = Math.min(BUCKETS_PER_DAY - 1, rawTo);
    if (rawTo > toBucket) {
      warnings.push(
        `incident duration ran past midnight (bucket ${rawTo}) and was truncated at bucket ` +
          `${toBucket}; the engine models one Pacific-local day and does not wrap.`
      );
    }
    const severity = Math.max(...incidents.map((i) => i.severity)) as 1 | 2 | 3 | 4;
    warnings.push(
      'incident severity is metadata only in the engine: the speed effect is derived from ' +
        'the capacity loss that lanesBlocked causes, routed through BPR. The client mock ' +
        'scaled speed directly by severity, so engine and mock will disagree on the same lever.'
    );
    request.incident = {
      freeway: targets[0].freeway,
      direction: targets[0].direction,
      postmileFrom: pmFrom,
      postmileTo: pmTo,
      lanesBlocked: Math.max(...incidents.map((i) => i.lanesBlocked)),
      fromBucket,
      toBucket,
      severity,
    };
  }

  // ── capacity changes ─────────────────────────────────────────────────────
  const capacities = byKind('capacity_change');
  if (capacities.length > 0) {
    const targets = capacities.map((c) => c.target);
    if (!sameCarriageway(targets)) {
      throw new Error(
        'capacity_change levers span more than one freeway+direction; the engine models one ' +
          'capacity target per run. Split into separate scenario runs.'
      );
    }
    if (capacities.length > 1) {
      warnings.push(
        `${capacities.length} capacity levers were folded to the LAST one's absolute value ` +
          `over the combined postmile window; the engine takes one capacity override per run.`
      );
    }
    const [pmFrom, pmTo] = hull(targets.map(targetWindow));
    request.capacity = {
      freeway: targets[0].freeway,
      direction: targets[0].direction,
      postmileFrom: pmFrom,
      postmileTo: pmTo,
      absoluteVph: capacities[capacities.length - 1].capacityVph,
    };
  }

  return { request, warnings };
}

/**
 * NOT IMPLEMENTED, deliberately — and this comment is the reason why.
 *
 * The UI's `ScenarioRunResponse.matrix` wants all 96 buckets in one payload with
 * `flow`/`speed`/`vc`/`incident` as `number[]`. The engine returns four 24-bucket
 * windows of comma-separated integer strings.
 *
 * Converting server-side would mean serialising ~191,424 numbers per metric as
 * JSON arrays. That is the exact shape M1 measured at **9,540,471 B (9.10 MiB)**
 * for one day — 9x over AppKit's 1 MiB single-event cap — which is why the packed
 * string encoding exists at all. Doing it in the app process would also mean
 * holding the whole matrix in Node memory to reassemble it.
 *
 * The client already has the decoder (`client/src/lib/frames.ts` splits packed
 * strings into typed arrays once, on load, for the M1 baseline matrix) and the
 * scenario matrix uses M1's identical layout and encoding. So the right move is
 * for the UI to decode the four windows the same way it already decodes M1's,
 * and to relax `ScenarioRunResponse.matrix` to the packed form — see
 * `run.ts:decodePacked` for the one-line-per-metric version.
 */
export const UI_MATRIX_ADAPTER_NOT_PROVIDED = {
  reason:
    'per-window packed strings are the transport; converting to number[] server-side ' +
    "reproduces the 9.10 MiB payload that AppKit's 1 MiB event cap rejects",
  clientDecoder: 'client/src/lib/frames.ts (already used for the M1 baseline matrix)',
} as const;
