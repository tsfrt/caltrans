/**
 * Unit tests for the engine's pure math and its parameter binding.
 *
 * These cannot prove the SQL is right — only a warehouse run can, and the
 * measured results are in `docs/WHATIF_ENGINE.md` §6. What they DO cover is:
 *
 *   * the arithmetic identities the engine relies on (a lever-free scenario is a
 *     no-op; MSA damping conserves demand; delay pivots additively),
 *   * the constants matching the SQL generator, read out of
 *     `tools/scenario_sql/engine.py` rather than restated, so drift fails here,
 *   * the sentinel binding that MAKES the no-op — if `bindScenario({day})` ever
 *     emits a non-sentinel, the baseline silently stops being the baseline.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BPR_ALPHA,
  BPR_BETA,
  BUCKET_HOURS,
  LOS_THRESHOLDS,
  MIN_CAPACITY_FACTOR,
  MIN_SPEED_MPH,
  RUBBERNECK_CAPACITY_LOSS,
  bprSpeed,
  bprTravelTimeFactor,
  closureCapacityFactor,
  delayMinPerMile,
  delayVht,
  incidentCapacityFactor,
  levelOfService,
  msaStep,
  networkSpeed,
  pivotDelay,
  pivotSpeed,
  servedFlow,
  vht,
  vmt,
} from './math.js';
import {
  BUCKETS_PER_DAY,
  CORRIDORS,
  DEFAULTS,
  MAX_ITERATIONS,
  ScenarioValidationError,
  WINDOW_BUCKETS,
  bindScenario,
  dayWindows,
  isBaseline,
} from './params.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const ENGINE_PY = readFileSync(join(REPO_ROOT, 'tools', 'scenario_sql', 'engine.py'), 'utf8');

/** Read a `NAME = <number>` constant out of the SQL generator. */
function pyConst(name: string): number {
  const m = ENGINE_PY.match(new RegExp(`^${name}\\s*=\\s*([-\\d.]+)`, 'm'));
  if (!m) throw new Error(`constant ${name} not found in tools/scenario_sql/engine.py`);
  return Number(m[1]);
}

describe('constants agree with the SQL generator', () => {
  // If these drift, the TypeScript helpers describe a different model than the
  // one that actually runs — the exact failure this project has a pipeline test
  // for on the generator side too.
  it.each([
    ['BUCKET_HOURS', BUCKET_HOURS],
    ['MIN_SPEED_MPH', MIN_SPEED_MPH],
    ['RUBBERNECK_CAPACITY_LOSS', RUBBERNECK_CAPACITY_LOSS],
    ['MIN_CAPACITY_FACTOR', MIN_CAPACITY_FACTOR],
  ])('%s', (name, tsValue) => {
    expect(tsValue).toBe(pyConst(name));
  });

  it('LOS thresholds match, in order', () => {
    const pyBlock = ENGINE_PY.match(/^LOS_THRESHOLDS = (.*)$/m)?.[1] ?? '';
    const parsed = [...pyBlock.matchAll(/\("([A-F])",\s*([\d.]+)\)/g)].map((m) => [m[1], Number(m[2])] as const);
    expect(parsed.length).toBe(5);
    expect(parsed).toEqual(LOS_THRESHOLDS);
  });

  it('the generator renders exactly MAX_ITERATIONS iterations', () => {
    expect(pyConst('MAX_ITERS')).toBe(MAX_ITERATIONS);
  });

  it('default BPR coefficients are the generator values, not the textbook ones', () => {
    // The single most consequential decision in this milestone: the data was
    // generated with 0.55/4.5, so the engine uses 0.55/4.5. Lakebase app.config
    // still seeds the textbook 0.15/4.0 — see docs/WHATIF_ENGINE.md §2.
    expect([BPR_ALPHA, BPR_BETA]).toEqual([0.55, 4.5]);
    expect([DEFAULTS.bpr.alpha, DEFAULTS.bpr.beta]).toEqual([0.55, 4.5]);
    expect([BPR_ALPHA, BPR_BETA]).not.toEqual([0.15, 4.0]);
  });
});

describe('BPR volume-delay', () => {
  it('is 1.0 at zero demand, so free-flow is unchanged', () => {
    expect(bprTravelTimeFactor(0)).toBe(1);
    expect(bprSpeed(65, 0)).toBeCloseTo(65, 10);
  });

  it('reproduces the generator curve documented in pipelines/synthetic_traffic/README.md', () => {
    // The README's own table, which the pipeline's tests also pin.
    const table: ReadonlyArray<readonly [number, number]> = [
      [0.0, 65.0],
      [0.5, 63.5],
      [0.7, 58.5],
      [0.9, 48.4],
      [1.0, 41.9],
      [1.4, 18.6],
    ];
    for (const [vc, expected] of table) {
      expect(bprSpeed(65, vc)).toBeCloseTo(expected, 1);
    }
  });

  it('is monotonically decreasing in v/c', () => {
    let previous = Infinity;
    for (let vc = 0; vc <= 3; vc += 0.05) {
      const s = bprSpeed(65, vc);
      expect(s).toBeLessThanOrEqual(previous + 1e-12);
      previous = s;
    }
  });

  it('floors at MIN_SPEED_MPH rather than approaching zero', () => {
    expect(bprSpeed(65, 100)).toBe(MIN_SPEED_MPH);
  });

  it('treats negative v/c as zero rather than producing a negative factor', () => {
    expect(bprTravelTimeFactor(-5)).toBe(1);
  });

  it('textbook coefficients predict much higher speeds at high v/c — the reason for 0.55/4.5', () => {
    // The generator's justification, made checkable. NOTE: the pipeline README
    // overstates it slightly, claiming textbook BPR "still predicts ~50 mph at
    // v/c = 1.4". The actual textbook figure is 41.2 mph (computed here). The
    // DIRECTION of the argument holds — 41 mph on a freeway 40% over capacity is
    // still implausibly fast, and 2.2x the steepened curve's 18.6 mph — but the
    // README's number is wrong and this test records the correct one.
    expect(bprSpeed(65, 1.4, 0.15, 4.0)).toBeCloseTo(41.24, 1);
    expect(bprSpeed(65, 1.4, 0.55, 4.5)).toBeCloseTo(18.57, 1);
    expect(bprSpeed(65, 1.4, 0.15, 4.0) / bprSpeed(65, 1.4, 0.55, 4.5)).toBeGreaterThan(2);
    // At capacity the gap is already 15 mph: 56.5 vs 41.9.
    expect(bprSpeed(65, 1.0, 0.15, 4.0)).toBeCloseTo(56.52, 1);
    expect(bprSpeed(65, 1.0, 0.55, 4.5)).toBeCloseTo(41.94, 1);
  });
});

describe('pivot-point speed (the no-op mechanism)', () => {
  it('returns the observed speed EXACTLY when v/c is unchanged', () => {
    // This identity is the whole baseline proof. Not "close to" — exactly.
    for (const [speed, vc, ff] of [
      [23.4, 1.314, 65.0],
      [66.6, 0.31, 69.8],
      [8.0, 7.8163, 65.4],
    ] as const) {
      expect(pivotSpeed(speed, vc, vc, ff)).toBe(speed);
    }
  });

  it('falls when v/c rises and rises when v/c falls', () => {
    expect(pivotSpeed(23.4, 1.314, 2.105, 65)).toBeLessThan(23.4);
    expect(pivotSpeed(23.4, 1.314, 1.095, 65)).toBeGreaterThan(23.4);
  });

  it('does not trim an observed speed that already exceeds free-flow', () => {
    // 62,976 of 191,424 rows in one day are above free-flow because the generator
    // adds 2.5% jitter. A bare least(ff, ...) ceiling broke the no-op on a third
    // of the network; the ceiling is max(ff, observed) for exactly this reason.
    expect(pivotSpeed(69.0, 0.4, 0.4, 65.0)).toBe(69.0);
  });

  it('never exceeds the ceiling even under extreme relief', () => {
    expect(pivotSpeed(20, 2.0, 0.0, 65)).toBeLessThanOrEqual(65);
  });

  it('never drops below the floor even under extreme congestion', () => {
    expect(pivotSpeed(60, 0.2, 8.0, 65)).toBe(MIN_SPEED_MPH);
  });
});

describe('level of service', () => {
  it('grades the HCM bands', () => {
    expect(levelOfService(0.0)).toBe('A');
    expect(levelOfService(0.34)).toBe('A');
    expect(levelOfService(0.35)).toBe('B'); // thresholds are exclusive upper bounds
    expect(levelOfService(0.54)).toBe('B');
    expect(levelOfService(0.76)).toBe('C');
    expect(levelOfService(0.91)).toBe('D');
    expect(levelOfService(0.99)).toBe('E');
    expect(levelOfService(1.0)).toBe('F');
    expect(levelOfService(7.8163)).toBe('F'); // max observed v/c in the data
  });

  it('is monotone: grade never improves as v/c rises', () => {
    const order = 'ABCDEF';
    let previous = -1;
    for (let vc = 0; vc <= 2; vc += 0.01) {
      const rank = order.indexOf(levelOfService(vc));
      expect(rank).toBeGreaterThanOrEqual(previous);
      previous = rank;
    }
  });
});

describe('delay', () => {
  it('is zero at free-flow and positive below it', () => {
    expect(delayMinPerMile(65, 65)).toBe(0);
    expect(delayMinPerMile(32.5, 65)).toBeCloseTo(60 / 32.5 - 60 / 65, 12);
  });

  it('never goes negative when speed exceeds free-flow', () => {
    // Jitter puts a third of the data above free-flow; a negative delay would
    // propagate into a negative delay-VHT and a nonsense KPI.
    expect(delayMinPerMile(69, 65)).toBe(0);
  });

  it('pivots additively, preserving the observed value when speed is unchanged', () => {
    // The stored delay is a mean of per-5-min delays and by Jensen exceeds the
    // delay implied by the mean speed (measured up to 3.08 min/mi). Recomputing
    // it would report a spurious reduction for a scenario that changed nothing.
    expect(pivotDelay(4.4308, 26.9, 26.9, 68.4)).toBe(4.4308);
  });

  it('adds the modelled change on top of the observed delay', () => {
    const observed = 4.4308;
    const result = pivotDelay(observed, 26.9, 13.45, 68.4);
    expect(result).toBeGreaterThan(observed);
    expect(result).toBeCloseTo(observed + (60 / 13.45 - 60 / 26.9), 10);
  });

  it('clamps at zero rather than reporting negative delay', () => {
    expect(pivotDelay(0.1, 30, 65, 65)).toBe(0);
  });
});

describe('VMT / VHT', () => {
  it('VMT is flow x hours x length', () => {
    expect(vmt(12588, 0.67)).toBeCloseTo(12588 * 0.25 * 0.67, 9);
  });

  it('VHT is VMT / speed', () => {
    expect(vht(12588, 0.67, 18.1)).toBeCloseTo((12588 * 0.25 * 0.67) / 18.1, 9);
  });

  it('reproduces a measured station-bucket from the warehouse run', () => {
    // Station 0775S0049, bucket 68, baseline: flow 12,588 vph, speed 18.1 mph,
    // VHT 117.71 (from the validated lane-closure run in docs/WHATIF_ENGINE.md).
    // Solving back for the segment length pins the whole chain, not one factor.
    const segLen = (117.71 * 18.1) / (12588 * 0.25);
    expect(vht(12588, segLen, 18.1)).toBeCloseTo(117.71, 2);
  });

  it('VHT rises when speed falls at constant flow — the congestion signal', () => {
    expect(vht(10000, 1, 20)).toBeGreaterThan(vht(10000, 1, 40));
  });

  it('VHT is zero rather than infinite at zero speed', () => {
    expect(vht(10000, 1, 0)).toBe(0);
  });

  it('delay-VHT is zero at free-flow and positive below it', () => {
    expect(delayVht(10000, 1, 65, 65)).toBeCloseTo(0, 12);
    expect(delayVht(10000, 1, 20, 65)).toBeGreaterThan(0);
  });

  it('network speed is VMT/VHT, not a plain average', () => {
    // A 0.1-mile ramp at 60 mph and 10 miles of mainline at 20 mph: the plain
    // mean is 40 mph, the flow-weighted truth is much closer to 20.
    const rampVmt = vmt(500, 0.1);
    const mainVmt = vmt(8000, 10);
    const combined = networkSpeed(rampVmt + mainVmt, vht(500, 0.1, 60) + vht(8000, 10, 20));
    expect(combined).toBeGreaterThan(20);
    expect(combined).toBeLessThan(21);
    expect((60 + 20) / 2).toBe(40); // what the naive answer would have been
  });

  it('network speed is zero rather than NaN on an empty network', () => {
    expect(networkSpeed(0, 0)).toBe(0);
  });
});

describe('capacity factors', () => {
  it('a closure loses exactly the closed lanes, with no rubbernecking term', () => {
    expect(closureCapacityFactor(4, 2)).toBeCloseTo(0.5, 12);
    expect(closureCapacityFactor(6, 2)).toBeCloseTo(2 / 3, 12);
  });

  it('an incident loses more than its lanes — 1 of 4 leaves 66%, per HCM', () => {
    expect(incidentCapacityFactor(4, 1)).toBeCloseTo(0.75 * 0.88, 12);
    expect(incidentCapacityFactor(4, 1)).toBeCloseTo(0.66, 2);
  });

  it('an incident is always worse than a closure of the same lane count', () => {
    for (let lanes = 2; lanes <= 8; lanes++) {
      for (let blocked = 1; blocked < lanes; blocked++) {
        expect(incidentCapacityFactor(lanes, blocked)).toBeLessThan(closureCapacityFactor(lanes, blocked));
      }
    }
  });

  it('a total closure floors at MIN_CAPACITY_FACTOR, keeping v/c finite', () => {
    // This floor is why a 1-lane ramp with 1 lane closed reports v/c 22 rather
    // than infinity. Documented as a known artefact, not hidden.
    expect(closureCapacityFactor(4, 4)).toBe(MIN_CAPACITY_FACTOR);
    expect(closureCapacityFactor(1, 5)).toBe(MIN_CAPACITY_FACTOR);
    expect(incidentCapacityFactor(4, 9)).toBe(MIN_CAPACITY_FACTOR);
  });

  it('no closed lanes is exactly a no-op', () => {
    expect(closureCapacityFactor(4, 0)).toBe(1);
    expect(incidentCapacityFactor(4, 0)).toBeCloseTo(0.88, 12); // rubbernecking alone
  });
});

describe('MSA damping', () => {
  it('uses step 1/(k+1)', () => {
    expect(msaStep(100, 200, 1)).toBeCloseTo(150, 12);
    expect(msaStep(100, 200, 2)).toBeCloseTo(100 + 100 / 3, 12);
    expect(msaStep(100, 200, 4)).toBeCloseTo(120, 12);
  });

  it('is a no-op when the loading equals the current state', () => {
    // The reason a lever-free scenario stays put through all four iterations.
    for (let k = 1; k <= 4; k++) expect(msaStep(1234.5, 1234.5, k)).toBe(1234.5);
  });

  it('conserves the total when one station sends what another receives', () => {
    // The identity behind the measured conservation_error_veh of exactly 0.0.
    const sent = 400;
    for (let k = 1; k <= 4; k++) {
      const sender = msaStep(1000, 1000 - sent, k);
      const receiver = msaStep(500, 500 + sent, k);
      expect(sender + receiver).toBeCloseTo(1500, 9);
    }
  });

  it('stays between the current state and the loading (it is a convex combination)', () => {
    for (let k = 1; k <= 4; k++) {
      const x = msaStep(100, 900, k);
      expect(x).toBeGreaterThanOrEqual(100);
      expect(x).toBeLessThanOrEqual(900);
    }
  });
});

describe('served flow', () => {
  it('saturates at capacity while demand keeps climbing', () => {
    expect(servedFlow(12000, 10000)).toBe(10000);
    expect(servedFlow(8000, 10000)).toBe(8000);
  });

  it('never goes negative', () => {
    expect(servedFlow(-5, 10000)).toBe(0);
    expect(servedFlow(5000, -1)).toBe(0);
  });
});

describe('bindScenario — the sentinels that make the baseline', () => {
  const DAY = '2026-06-10';

  it('binds every lever to its off sentinel for a bare request', () => {
    const p = bindScenario({ day: DAY });
    // Spelled out rather than snapshotted: if any one of these changes, the
    // engine stops being a no-op with no lever set, and the map silently lies.
    expect(p).toMatchObject({
      day: DAY,
      freeway: 'ALL',
      close_freeway: '',
      close_lanes: 0,
      demand_freeway: '',
      demand_pct: 0,
      incident_freeway: '',
      incident_lanes_blocked: 0,
      capacity_freeway: '',
      capacity_add_lanes: 0,
      capacity_scale: 1,
      capacity_abs_vph: -1,
    });
  });

  it('binds all 34 engine parameters on every call', () => {
    // DBSQL rejects a partially-bound statement, so a missing key is a runtime
    // failure, not a default. Every parameter the SQL declares must be present.
    const declared = [...ENGINE_PY.matchAll(/^ {4}\("([a-z_]+)", "(?:DATE|STRING|INT|DOUBLE)"/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(30);
    const bound = Object.keys(bindScenario({ day: DAY }));
    expect(new Set(bound)).toEqual(new Set(declared));
  });

  it('defaults iterations to the maximum the SQL unrolls', () => {
    expect(bindScenario({ day: DAY }).msa_iterations).toBe(MAX_ITERATIONS);
  });

  it('recognises a bare request as the baseline', () => {
    expect(isBaseline({ day: DAY })).toBe(true);
    expect(isBaseline({ day: DAY, closure: { freeway: 'I-405', lanes: 2 } })).toBe(false);
  });

  it('rejects a malformed day rather than querying a wrong one', () => {
    for (const day of ['', '2026-6-10', 'yesterday', '06/10/2026']) {
      expect(() => bindScenario({ day })).toThrow(ScenarioValidationError);
    }
  });

  it('rejects an unknown corridor', () => {
    expect(() => bindScenario({ day: DAY, closure: { freeway: 'I-999', lanes: 1 } })).toThrow(/must be one of/);
  });

  it('accepts every corridor actually present in the data', () => {
    for (const freeway of CORRIDORS) {
      expect(() => bindScenario({ day: DAY, closure: { freeway, lanes: 1 } })).not.toThrow();
    }
  });

  it('rejects an inverted postmile window', () => {
    expect(() =>
      bindScenario({
        day: DAY,
        closure: { freeway: 'I-405', lanes: 2, postmileFrom: 52, postmileTo: 45 },
      })
    ).toThrow(/postmileFrom/);
  });

  it('treats an omitted postmile window as the whole corridor', () => {
    const p = bindScenario({ day: DAY, closure: { freeway: 'I-405', lanes: 1 } });
    expect(Number(p.close_pm_from)).toBeLessThan(0);
    expect(Number(p.close_pm_to)).toBeGreaterThan(1000);
  });

  it('rejects levers that would silently do nothing', () => {
    // A scenario that quietly does nothing is indistinguishable from a working
    // baseline on the map — the worst failure mode this UI has.
    expect(() => bindScenario({ day: DAY, demand: { freeway: 'I-5', percent: 0 } })).toThrow(/no effect/);
    expect(() => bindScenario({ day: DAY, capacity: { freeway: 'I-5' } })).toThrow(/no effect/);
    expect(() => bindScenario({ day: DAY, closure: { freeway: 'I-5', lanes: 0 } })).toThrow(/closure.lanes/);
  });

  it('rejects an iteration count the SQL has not unrolled', () => {
    expect(() => bindScenario({ day: DAY, iterations: MAX_ITERATIONS + 1 })).toThrow(/iterations/);
    expect(() => bindScenario({ day: DAY, iterations: -1 })).toThrow(/iterations/);
    expect(bindScenario({ day: DAY, iterations: 0 }).msa_iterations).toBe(0);
  });

  it('rejects an off-grid window start that would misalign the animation', () => {
    expect(() => bindScenario({ day: DAY, fromBucket: 7 })).toThrow(/multiple of/);
    for (const b of dayWindows()) {
      expect(bindScenario({ day: DAY, fromBucket: b }).from_bucket).toBe(b);
    }
  });

  it('covers the whole day with exactly four windows', () => {
    const windows = dayWindows();
    expect(windows).toEqual([0, 24, 48, 72]);
    expect(windows.length * WINDOW_BUCKETS).toBe(BUCKETS_PER_DAY);
  });

  it('rejects an inverted incident time window', () => {
    expect(() =>
      bindScenario({
        day: DAY,
        incident: { freeway: 'I-405', lanesBlocked: 2, fromBucket: 70, toBucket: 60 },
      })
    ).toThrow(/toBucket/);
  });

  it('rejects an alpha of zero, which would make every scenario inert', () => {
    expect(() => bindScenario({ day: DAY, bpr: { alpha: 0 } })).toThrow(/bpr.alpha/);
  });

  it('rejects out-of-range reassignment shares', () => {
    expect(() => bindScenario({ day: DAY, reassignment: { share: 1.5 } })).toThrow(/share/);
    expect(() => bindScenario({ day: DAY, reassignment: { offNetworkShare: -0.1 } })).toThrow(/offNetworkShare/);
  });

  it('binds a full four-lever scenario', () => {
    const p = bindScenario({
      day: DAY,
      freeway: 'I-405',
      fromBucket: 48,
      iterations: 3,
      closure: { freeway: 'I-405', direction: 'S', postmileFrom: 45, postmileTo: 52, lanes: 2 },
      demand: { freeway: 'ALL', percent: 20 },
      incident: {
        freeway: 'US-101',
        direction: 'N',
        lanesBlocked: 1,
        fromBucket: 64,
        toBucket: 72,
        severity: 3,
      },
      capacity: { freeway: 'I-10', direction: 'E', scale: 1.15 },
      reassignment: { share: 0.4, offNetworkShare: 0.25 },
    });
    expect(p).toMatchObject({
      freeway: 'I-405',
      from_bucket: 48,
      msa_iterations: 3,
      close_freeway: 'I-405',
      close_direction: 'S',
      close_lanes: 2,
      demand_freeway: 'ALL',
      demand_pct: 20,
      incident_freeway: 'US-101',
      incident_lanes_blocked: 1,
      incident_from_bucket: 64,
      incident_to_bucket: 72,
      capacity_freeway: 'I-10',
      capacity_scale: 1.15,
      reassign_share: 0.4,
    });
  });
});
