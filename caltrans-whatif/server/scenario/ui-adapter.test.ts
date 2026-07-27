/**
 * Tests for the UI→engine adapter.
 *
 * The lever UI (PR #7) and this engine were built in parallel and landed on
 * different request shapes. These tests pin the translation, and in particular
 * pin that every LOSSY fold is reported rather than silent — a scenario that
 * quietly drops or merges a lever looks identical to one that worked.
 *
 * They also assert the adapter's output actually BINDS, by running it through
 * `bindScenario`, so a shape mismatch fails here rather than at the warehouse.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { bindScenario } from './params.js';
import {
  TARGET_HALF_WIDTH_MI,
  engineModel,
  fromUiRequest,
  type UiLever,
  type UiScenarioRunRequest,
} from './ui-adapter.js';

const DAY = '2026-06-10';

const target = (freeway: string, direction: string, postmile: number, id = 'S1') => ({
  stationId: id,
  freeway,
  direction,
  postmile,
});

const req = (levers: UiLever[], freeway = 'ALL'): UiScenarioRunRequest => ({
  schemaVersion: 'm2-scenario-v1',
  day: DAY,
  scope: { freeway },
  levers,
});

describe('adapter output is always bindable', () => {
  it('an empty lever list produces the provable no-op', () => {
    const { request, warnings } = fromUiRequest(req([]));
    expect(warnings).toEqual([]);
    const params = bindScenario(request);
    expect(params).toMatchObject({
      day: DAY,
      close_freeway: '',
      demand_freeway: '',
      incident_freeway: '',
      capacity_freeway: '',
      capacity_scale: 1,
      capacity_abs_vph: -1,
    });
  });

  it('every lever kind at once binds without error', () => {
    const { request } = fromUiRequest(
      req([
        { id: 'a', type: 'closure', target: target('I-405', 'S', 46.07), lanesClosed: 2 },
        { id: 'b', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: 20 },
        {
          id: 'c',
          type: 'incident',
          target: target('US-101', 'N', 22.0),
          startBucket: 64,
          durationBuckets: 9,
          lanesBlocked: 2,
          severity: 3,
        },
        {
          id: 'd',
          type: 'capacity_change',
          target: target('I-10', 'E', 12.5),
          capacityVph: 14000,
        },
      ])
    );
    expect(() => bindScenario(request)).not.toThrow();
    expect(bindScenario(request)).toMatchObject({
      close_freeway: 'I-405',
      close_lanes: 2,
      demand_freeway: 'I-5',
      demand_pct: 20,
      incident_freeway: 'US-101',
      incident_lanes_blocked: 2,
      incident_from_bucket: 64,
      incident_to_bucket: 72, // 64 + 9 - 1
      capacity_freeway: 'I-10',
      capacity_abs_vph: 14000,
    });
  });
});

describe('station target → postmile window', () => {
  it('brackets the station tightly enough not to swallow its neighbours', () => {
    const { request } = fromUiRequest(
      req([{ id: 'a', type: 'closure', target: target('I-405', 'S', 46.07), lanesClosed: 2 }])
    );
    expect(request.closure?.postmileFrom).toBeCloseTo(46.07 - TARGET_HALF_WIDTH_MI, 9);
    expect(request.closure?.postmileTo).toBeCloseTo(46.07 + TARGET_HALF_WIDTH_MI, 9);
    // The generator's densest urban spacing is 0.60 mi, so a full window must
    // stay under that or it reaches the adjacent detector.
    expect(2 * TARGET_HALF_WIDTH_MI).toBeLessThan(0.6);
  });

  it('folds several closures into the hull that covers all of them, and says so', () => {
    const { request, warnings } = fromUiRequest(
      req([
        { id: 'a', type: 'closure', target: target('I-405', 'S', 45.38), lanesClosed: 2 },
        { id: 'b', type: 'closure', target: target('I-405', 'S', 51.29), lanesClosed: 3 },
      ])
    );
    expect(request.closure?.postmileFrom).toBeCloseTo(45.38 - TARGET_HALF_WIDTH_MI, 9);
    expect(request.closure?.postmileTo).toBeCloseTo(51.29 + TARGET_HALF_WIDTH_MI, 9);
    // Max, not sum: folding must not invent a wider closure than was asked for.
    expect(request.closure?.lanes).toBe(3);
    expect(warnings.join(' ')).toMatch(/2 closure levers were folded/);
  });

  it('refuses to model closures spread across corridors rather than dropping one', () => {
    expect(() =>
      fromUiRequest(
        req([
          { id: 'a', type: 'closure', target: target('I-405', 'S', 46.0), lanesClosed: 2 },
          { id: 'b', type: 'closure', target: target('US-101', 'N', 22.0), lanesClosed: 1 },
        ])
      )
    ).toThrow(/more than one freeway/);
  });

  it('treats opposite directions of the same freeway as different carriageways', () => {
    expect(() =>
      fromUiRequest(
        req([
          { id: 'a', type: 'closure', target: target('I-405', 'S', 46.0), lanesClosed: 2 },
          { id: 'b', type: 'closure', target: target('I-405', 'N', 46.0), lanesClosed: 2 },
        ])
      )
    ).toThrow(/more than one freeway/);
  });
});

describe('demand deltas combine multiplicatively', () => {
  it('+10% then +10% is +21%, not +20%', () => {
    const { request, warnings } = fromUiRequest(
      req([
        { id: 'a', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: 10 },
        { id: 'b', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: 10 },
      ])
    );
    expect(request.demand?.percent).toBeCloseTo(21, 9);
    expect(warnings.join(' ')).toMatch(/combined multiplicatively/);
  });

  it('widens to ALL corridors when levers disagree, and warns', () => {
    const { request, warnings } = fromUiRequest(
      req([
        { id: 'a', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: 10 },
        { id: 'b', type: 'demand_delta', freeway: 'I-405', direction: 'S', percent: 10 },
      ])
    );
    expect(request.demand?.freeway).toBe('ALL');
    expect(request.demand?.direction).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/widened to ALL corridors/);
  });

  it('drops a lever pair that cancels out rather than binding a 0% no-effect lever', () => {
    // bindScenario REJECTS demand_pct === 0 as a lever that silently does nothing,
    // so the adapter must drop it instead of passing it through.
    const { request, warnings } = fromUiRequest(
      req([
        { id: 'a', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: 25 },
        { id: 'b', type: 'demand_delta', freeway: 'I-5', direction: 'N', percent: -20 },
      ])
    );
    // 1.25 * 0.80 == 1.0, so the net delta is 0% and the lever must be DROPPED,
    // not passed through — bindScenario rejects demand_pct === 0 outright.
    expect(request.demand).toBeUndefined();
    expect(warnings.join(' ')).toMatch(/cancelled out/);
    expect(() => bindScenario(request)).not.toThrow();
    expect(bindScenario(request).demand_freeway).toBe('');
  });
});

describe('incident time window', () => {
  it('converts start + duration to an inclusive window', () => {
    const { request } = fromUiRequest(
      req([
        {
          id: 'a',
          type: 'incident',
          target: target('US-101', 'N', 22.0),
          startBucket: 64,
          durationBuckets: 9,
          lanesBlocked: 2,
          severity: 2,
        },
      ])
    );
    expect(request.incident?.fromBucket).toBe(64);
    expect(request.incident?.toBucket).toBe(72);
  });

  it('a 1-bucket incident is a single bucket, not zero', () => {
    const { request } = fromUiRequest(
      req([
        {
          id: 'a',
          type: 'incident',
          target: target('US-101', 'N', 22.0),
          startBucket: 68,
          durationBuckets: 1,
          lanesBlocked: 1,
          severity: 1,
        },
      ])
    );
    expect(request.incident?.fromBucket).toBe(68);
    expect(request.incident?.toBucket).toBe(68);
  });

  it('truncates at midnight rather than wrapping into the morning', () => {
    const { request, warnings } = fromUiRequest(
      req([
        {
          id: 'a',
          type: 'incident',
          target: target('US-101', 'N', 22.0),
          startBucket: 92,
          durationBuckets: 12,
          lanesBlocked: 1,
          severity: 1,
        },
      ])
    );
    expect(request.incident?.toBucket).toBe(95);
    expect(warnings.join(' ')).toMatch(/past midnight/);
    expect(() => bindScenario(request)).not.toThrow();
  });

  it('always warns that severity behaves differently than in the client mock', () => {
    const { warnings } = fromUiRequest(
      req([
        {
          id: 'a',
          type: 'incident',
          target: target('US-101', 'N', 22.0),
          startBucket: 64,
          durationBuckets: 4,
          lanesBlocked: 2,
          severity: 4,
        },
      ])
    );
    expect(warnings.join(' ')).toMatch(/severity is metadata only/);
  });
});

describe("engineModel answers the UI's question about the BPR conflict", () => {
  // client/src/lib/scenario.ts says: "When the engine lands it must declare which
  // pair it used in ScenarioRunResponse.model, and the UI should surface that
  // verbatim rather than assuming."
  const model = engineModel();

  it('names the pair it used and says the Lakebase seed is stale', () => {
    expect(model.bprCoefficients).toMatch(/alpha=0\.55/);
    expect(model.bprCoefficients).toMatch(/beta=4\.5/);
    expect(model.bprCoefficients).toMatch(/0\.15\/4\.0 is stale/);
  });

  it('uses the model name and reassignment label the UI type expects', () => {
    expect(model.name).toBe('bpr-volume-delay');
    expect(model.reassignment).toBe('corridor-postmile-simplified');
  });

  it('does not overclaim the reassignment as network assignment', () => {
    expect(model.caveat).toMatch(/NOT network assignment/);
    expect(model.caveat).toMatch(/no road graph/);
    expect(model.caveat).toMatch(/has NOT converged/);
  });
});

describe('the adapter covers every lever the UI can build', () => {
  it('handles all four discriminants declared in client/src/lib/scenario.ts', () => {
    // Read the UI's own union rather than restating it, so a new lever kind added
    // there fails here instead of being silently ignored at runtime.
    const uiSource = readFileSync(join(import.meta.dirname, '..', '..', 'client', 'src', 'lib', 'scenario.ts'), 'utf8');
    const kinds = new Set([...uiSource.matchAll(/^\s*type: '([a-z_]+)';/gm)].map((m) => m[1]));
    expect(kinds).toEqual(new Set(['closure', 'demand_delta', 'incident', 'capacity_change']));
  });
});
