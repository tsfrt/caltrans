# M2 — The What-If Engine

BPR volume-delay plus damped incremental (MSA) demand reassignment, executed
**entirely in DBSQL** as one parameterized query. The app process binds
parameters and forwards rows; it does no traffic math.

**Warehouse:** `688f49c732cf9083` (Serverless Starter, Small, PRO, Photon, channel
`CURRENT`, dbsql `2026.20`)
**Data:** `lanl.caltrans_traffic.gold_map_frames` (5,742,720 rows) +
`silver_stations_geo` (2,022 stations)
**Validated against:** day `2026-06-10` (Wednesday), 191,424 station-buckets

| Artefact | What it is |
|---|---|
| `tools/scenario_sql/engine.py` | The engine, once. **Edit here.** |
| `tools/scenario_sql/render.py` | Writes both `.sql` files from it |
| `config/queries/scenario_time_matrix.sql` | **Generated.** Map payload |
| `config/queries/scenario_kpis.sql` | **Generated.** KPI panel |
| `server/scenario/{contract,params,math}.ts` | The executable spec. Pins the SQL constants against `engine.py`. |
| `client/src/lib/scenarioParams.ts` | Validate → bind to `sql.*` markers. No math. |
| `client/src/lib/scenarioAdapter.ts` | Lever UI shape → engine shape. Reports every lossy fold. |
| `client/src/lib/useScenarioRun.ts` | Calls both queries via `useAnalyticsQuery`. No math. |
| `tests/test_scenario_sql.py` | 27 tests: drift + structural invariants |
| `server/scenario/scenario.test.ts` | 61 tests: the arithmetic |
| `client/src/lib/scenarioAdapter.test.ts` | 26 tests: binding + lever folding |

Both queries embed the **same** engine body, asserted by
`test_both_queries_embed_the_identical_engine`. If they could drift, the KPI panel
would report numbers the map does not draw.

---

## 1. The idea: an incremental model, not an absolute one

The engine never predicts a speed. It predicts the **ratio** by which congestion
changes, and multiplies the observed value by it:

```
tt_factor(v/c)  = 1 + alpha * (v/c)^beta                       ← BPR
speed_after     = speed_observed * tt_factor(vc_before) / tt_factor(vc_after)
c_eff_baseline  = demanded_flow_vph / vc_ratio                 ← read from the data
```

This is the standard "pivot-point" formulation, and it buys two things.

**It makes the baseline provable.** With no lever set, `vc_after == vc_before`
exactly, so every ratio is exactly 1.0 and every output column reproduces the
source table. An absolute model *cannot* do this here: `gold_map_frames` carries
2.5% measurement jitter on top of the BPR curve, so re-deriving speed from BPR
alone lands **0.75 mph off on average** (measured MAE over 191,424 rows, p99 2.45
mph, max 26.6 mph). The "baseline" would visibly differ from the map the user was
looking at one second earlier.

**It preserves per-station calibration.** Whatever the observed value embeds —
jitter, detector health, local geometry — survives the scenario instead of being
replaced by a model mean.

Effective capacity is read out of the data the same way, as `demand / vc`, rather
than reconstructed from `num_lanes × lane_capacity × station_type_scale`.
Reconstruction is exact only for incident-free rows (max abs error 9.2e-4) and
drifts by **up to 1.44 v/c units** on rows where an incident covers part of a
15-minute bucket, because `incident_active` / `lanes_blocked` are bucket-MAX
aggregates while `vc_ratio` was computed at 5-minute resolution.

### v/c is demand-based, deliberately

`vc_ratio` in this data is *latent demand* over capacity, so it legitimately
exceeds 1.0 (max observed 7.8163, p99 1.147). `served_vc_ratio` hard-ceilings at
exactly 1.0 and is useless for what-if work. The engine is built on the
demand-based ratio — that is what makes oversaturation modelable at all.

---

## 2. BPR coefficients: 0.55 / 4.5, not 0.15 / 4.0

**Decision: match the data generator (α=0.55, β=4.5). The Lakebase
`app.config` seed of 0.15 / 4.0 is WRONG for this engine and should be corrected.**

Three values were in play:

| Source | α | β | Status |
|---|---|---|---|
| Textbook BPR (US Bureau of Public Roads) | 0.15 | 4.0 | Rejected |
| `caltrans_traffic.config` (the data generator) | **0.55** | **4.5** | **Adopted** |
| Lakebase `app.config` seed | 0.15 | 4.0 | **Stale — conflicts** |

### Why the generator wins

The decisive argument is not which curve is more realistic in general — it is
that **this engine divides one BPR factor by another**. If the engine used
coefficients other than the ones that produced the data, then for a station whose
`vc_before` and `vc_after` are equal the ratio would still be 1.0 (so the strict
no-op survives), but every *non-trivial* scenario would be measuring a change
against a curve the baseline was never on. The reported delta would mix a real
capacity effect with an artefact of the coefficient mismatch, and there would be
no way to separate them. Internal consistency is worth more here than fidelity to
a 1964 fit.

The generator's own justification also holds up, though its README overstates it.
Measured (65 mph free-flow):

| v/c | textbook 0.15/4.0 | steepened 0.55/4.5 |
|---|---|---|
| 1.0 | 56.5 mph | 41.9 mph |
| 1.3 | 45.5 mph | 23.3 mph |
| 1.4 | **41.2 mph** | 18.6 mph |

`pipelines/synthetic_traffic/README.md` claims textbook BPR "still predicts ~50
mph at v/c = 1.4". The real figure is **41.2 mph** — the direction of the argument
is right (41 mph on a freeway 40% over capacity is still implausibly fast, and
2.2× the steepened curve) but the number is wrong. Recorded here and pinned by a
test rather than repeated.

### Why the Lakebase conflict is not resolved in code

`lakebase/schema.sql` seeds `bpr_alpha=0.15` / `bpr_beta=4.0`. Those rows are
pre-existing and owned by the Lakebase migration (out of scope for this branch —
see the file-scope note in the PR). The engine therefore takes its coefficients as
**query parameters** with defaults in `client/src/lib/scenarioParams.ts` (and
mirrored in `server/scenario/params.ts`, which the arithmetic tests pin), so:

* the app works correctly today without touching the Lakebase migration;
* once the seed is corrected to 0.55 / 4.5, the client can read it from
  `app.config` and pass it through with no engine change;
* a test (`test_engine_bpr_defaults_follow_the_generator_not_the_textbook`)
  asserts the defaults follow the generator AND that the conflicting seed still
  exists, so this section cannot quietly become false.

**If you wire the app to read `app.config` before fixing the seed, every scenario
silently switches to the textbook curve.** Fix the seed first.

---

## 3. Levers

All four compose. Every lever is optional; every omitted lever is exactly a
no-op. Capacity multipliers apply in a **fixed documented order** so a scenario
that adds a lane and then closes two is unambiguous:

```
add_lanes  →  closure  →  incident  →  scale  →  absolute override
```

| # | Lever | Effect |
|---|---|---|
| 1 | **Lane closure** | `open/total`, floored at 5%. **No** rubbernecking term — a planned closure is coned off and signed. |
| 2 | **Corridor demand delta** | `1 + pct/100` on latent demand, per freeway+direction, or `ALL`. |
| 3 | **Incident injection** | `(open/total) × 0.88` — the extra 12% is HCM rubbernecking/merge turbulence. Bounded to a bucket window. |
| 4 | **Capacity change** | add/remove lanes, multiply (ramp metering), or override absolutely. |

An incident is **always worse than a closure of the same lane count** (asserted
across every lane/blockage combination in the vitest suite). That asymmetry is
the point of having both levers.

The incident lever takes the **worse** of the injected blockage and whatever the
data already had at that station-bucket, rather than compounding them — two
overlapping incidents do not halve capacity twice.

---

## 4. Reassignment — and what it is not

### What it is not

**There is no road network in this data.** 2,022 point detectors on 10 named
corridors, with postmiles. No ramps as edges, no arterials, no turn movements, no
OD matrix, no travel times between points. True equilibrium assignment —
shortest paths over a graph, Frank–Wolfe or Dial over an OD table — is
**impossible** here. This engine does not attempt it and does not claim it.

### What it is

Over-capacity demand at a station is split three ways:

| Destination | Mechanism |
|---|---|
| **Parallel corridor** | A different freeway, within `ST_DistanceSphere ≤ 8 km`, heading within 45°. Weighted by spare capacity × inverse distance. |
| **Adjacent same-corridor segments** | Within 2 postmiles on the same carriageway. Weighted at **half** a parallel candidate — spilling into the next segment relieves the detector but not the corridor. |
| **Off-network sink** | Leaves the modelled freeways entirely. |

The off-network share is an **honest sink, not a fudge**: the data contains 10
freeways and no arterials, so some diverted traffic genuinely has nowhere in-model
to go (local streets, retiming, mode shift, trip suppression). It is tracked as a
separate returned column (`demand_offnetwork_veh`) precisely so conservation stays
auditable rather than hidden in a residual.

Damping is textbook MSA: `x_{k+1} = x_k + 1/(k+1) · (y_k − x_k)`. Because that is
a convex combination of two demand vectors that each conserve total demand, total
demand is conserved to machine precision at every iteration — measured
`conservation_error_veh` is **exactly 0.0** on the NETWORK row of every scenario
run below.

### Only scenario-induced excess is reassigned

The engine reassigns `max(0, x − c) − base_excess`, where `base_excess` is
whatever was already over capacity in the observed data. Without that term the
engine re-routes the *data's own pre-existing congestion*, and a **lever-free**
scenario with reassignment enabled came out up to **49 mph faster** in places
while moving **678,535 vehicle-equivalents** off-network — it "fixed" the baseline
and the no-op proof failed. Found by measurement, fixed, and now pinned by
`test_base_excess_is_carried_through_every_iteration`.

### The parallel-corridor filter genuinely bites

For the I-405 S pm 45–52 segment, the only freeway within 12 km is I-10, at a
measured **111–114° heading difference**. I-10 East is not an alternative to
I-405 South, and the bearing filter correctly rejects it — which is why the
same-corridor mechanism had to exist. Before it was added, **0 of 9** stations in
that closure window had any diversion target and 100% of moved demand went to the
off-network sink.

### Coverage, measured

| Threshold | Stations with ≥1 parallel candidate |
|---|---|
| 5,000 m / 45° | 416 of 2,022 (21%) |
| 8,000 m / 45° | **551 of 2,022 (27%)** |
| 8,000 m / 60° | 608 of 2,022 (30%) |

Rural I-5 and the Mojave stretch of I-15 have no parallel freeway because in
reality they have none. Every KPI row returns `stations_with_alternative` so a
scenario cannot imply the whole network can re-route when 73% of it cannot.

---

## 5. Limitations a transportation engineer would object to

Listed in descending order of how much they would bother a reviewer.

1. **No route choice.** Diversion is driven by *spare capacity and proximity*, not
   by travel time or generalised cost. A real driver compares path costs; this
   model spreads pressure into whatever is nearby and empty. There is no
   equilibrium condition, so there is nothing to converge *to* in Wardrop's sense.

2. **MSA has not converged at 4 iterations.** Measured, I-405 S closure, demand
   moved out of the closed window:

   | iterations | moved out (vph) | to adjacent | off-network | Δ vs previous |
   |---|---|---|---|---|
   | 1 | 40,009 | 12,969 | 27,040 | — |
   | 2 | 60,789 | 17,228 | 43,561 | +52% |
   | 3 | 75,275 | 19,969 | 55,306 | +24% |
   | 4 | **86,244** | 21,897 | 64,347 | **+15%** |

   Still moving 15% per step. The harmonic step `1/(k+1)` converges slowly by
   construction, and 4 iterations is a **latency budget, not a convergence
   criterion** — it was the number recorded in `docs/ARCHITECTURE.md` before any
   measurement existed. Since latency turns out to be flat in iteration count
   (§6), the honest recommendation is to **raise `MAX_ITERS` and re-measure**;
   the current results should be read as "the direction and rough magnitude of
   the effect", not a converged assignment.

3. **Same-corridor spreading has no direction.** A real queue grows *upstream*
   only. This spreads symmetrically into both neighbours, because postmile
   increases with route mileage and the data does not record which way traffic
   flows along it. So a closure relieves the segment behind it slightly when it
   should only load it.

4. **No time dynamics.** Each 15-minute bucket is solved independently. Real
   congestion propagates *between* buckets — a 17:00 closure still affects 17:45.
   There is no peak spreading, no queue carry-over, no shockwave.

5. **BPR is monotonic**, so it cannot reproduce the backward-bending
   (hypercongested) branch of a real fundamental diagram, where *flow itself*
   falls once density passes critical. Inherited from the generator; the data has
   the same limitation.

6. **The 5% capacity floor produces visible artefacts.** Closing 1 lane of a
   1-lane on-ramp leaves 5% of capacity and reports **v/c 22.3**. That is
   arithmetically what was asked for, and the floor is what keeps v/c finite
   rather than infinite, but it is not a physically meaningful number. The lever
   UI should discourage closing more lanes than a station has.

7. **`reassign_share` and `reassign_offnetwork_share` are unc­alibrated.** The
   defaults (0.35 / 0.30) are plausible-looking guesses. Nothing in this dataset
   can calibrate them — that would need observed before/after counts from a real
   closure. They are parameters so a user can explore sensitivity, not settings
   with a defensible value.

8. **Segment lengths are a postmile Voronoi**, so VMT/VHT inherit the detector
   spacing. Clamped to [0.05, 12] mi. Real Caltrans postmiles reset at county
   lines; these are monotonic route-miles (generator limitation).

---

## 6. Performance

Two DBSQL facts forced the query's shape, both verified on this warehouse.

**`WITH RECURSIVE` cannot aggregate over its recursive reference** —
`INVALID_RECURSIVE_REFERENCE.PLACE ... in aggregates`, SQLSTATE 42836 — and every
reassignment iteration is a `SUM ... GROUP BY` over diversion candidates. So MSA
iterations are **unrolled at render time**. (`RECURSIVE` must also immediately
follow `WITH`, so it cannot be introduced mid-chain anyway.)

**CTEs are inlined, so reference count compounds as `refs^iterations`.** Each
textual reference to the previous iterate re-expands the entire upstream chain,
including the 191,424-row scan and the spatial join. Measured, 4 iterations:

| references to the previous iterate per iteration | latency |
|---|---|
| 4 (separate pressure / pull / send / recv CTEs) | **434 s** |
| 2 (send folded into the state CTE) | **235 s** |
| 1 (current structure) | **2.3 s** |

Zero-iteration baseline is 1.6 s. Only the single-reference form is interactive.
Getting to one reference needed two tricks: `cand_role` carries each candidate
pair twice (keyed by src and by dst) so one equi-join recovers both endpoints'
state, and the normalisation total is a **window function inside one CTE** rather
than a second CTE. `test_iteration_reads_previous_iterate_exactly_once` enforces
this, because a comment alone did not prevent it happening once already.

### Measured latency and payload

p50 of 3 warm runs, first run discarded. Day `2026-06-10`, all 10 corridors.

| Query | Scenario | p50 | Payload |
|---|---|---|---|
| `scenario_time_matrix` (1 window) | baseline, 0 iterations | **2.40 s** | 758,886 B (0.724 MiB) |
| `scenario_time_matrix` (1 window) | I-405 closure, 4 iterations | **2.31 s** | 758,955 B (0.724 MiB) |
| `scenario_time_matrix` (1 window) | closure, `freeway=I-405` | **2.21 s** | 50,249 B (0.048 MiB) |
| `scenario_kpis` | baseline, 0 iterations | **2.93 s** | 8,683 B |
| `scenario_kpis` | I-405 closure, 4 iterations | **3.44 s** | 8,936 B |
| `scenario_kpis` | +20% demand, 4 iterations | **3.48 s** | 9,049 B |

**A whole scenario day = 4 windows × 0.724 MiB = 2.90 MiB**, versus M1's 2.475
MiB for the same thing. Fetched as four parallel requests, so wall-clock is
roughly one query.

Latency is **flat in iteration count** (2.86–4.05 s across 0–4 iterations, and
the ordering is not even monotonic — noise dominates). The `UNION ALL` arms above
the requested count are pruned, but the saving is smaller than run-to-run
variance on a Small warehouse. This is why §5 item 2 recommends raising the
iteration count: it is nearly free.

### Why the payload is shaped this way

The scenario matrix is a **superset of M1's client contract** — the four M1
columns (`flow`, `speed_half`, `vc_pct`, `incident`) carry the *scenario* values
in M1's exact layout and encoding, so `client/src/lib/frames.ts` decodes it
unchanged. One column is added: `delay_c` (centi-minutes per mile).

It deliberately does **not** return the "before" side. The client already holds
the baseline — it fetched `traffic_time_matrix.sql` for the same day and window on
load, and the no-op proof is what guarantees those numbers *are* this engine's
"before". Shipping them again measured **770,276 extra bytes per window** and
pushed the payload to 1,422,030 B (1.356 MiB), over AppKit's 1 MiB single-event
cap (`appkit/dist/stream/defaults.js` `maxEventSize`) — a runtime failure, not
just waste. The diff is a client-side subtraction of two arrays already in memory.

`ARROW_STREAM` remains unusable in this environment (`storage-proxy.databricks.com`
returns HTTP 500 for every chunk); see the M1 README.

---

## 7. Validation

Everything below was run on `688f49c732cf9083`. Full output is in the PR body.

### The no-op proof — the single most important check

All levers off, `msa_iterations=4`, `reassign_share=0.35`, over all 191,424
station-buckets of `2026-06-10`:

| metric | max |Δ| vs source table |
|---|---|
| v/c | **0.0** (bit-identical) |
| demand | **0.0** (bit-identical) |
| LOS grade changes | **0 rows** |
| speed | 7.1e-15 (double epsilon) |
| delay | 1.8e-15 |
| VHT | 5.7e-14 |
| VMT | 9.1e-13 |
| served flow | 1.8e-12 |
| off-network leakage | **0.0** |

Identical at `msa_iterations=0` and `4`. Three fixes were needed to get here, all
found by measurement:

1. **Speed ceiling.** 62,976 of 191,424 rows have `avg_speed_mph` *above*
   `free_flow_speed_mph` (by up to 4.0 mph) because of the generator's jitter. A
   `least(ff_mph, …)` ceiling silently trimmed a third of the baseline. The
   ceiling is `max(ff_mph, speed_before)`.
2. **Delay pivots additively.** The stored delay is a mean of per-5-min delays;
   delay is convex in speed, so by Jensen it exceeds the delay implied by the
   bucket's mean speed — measured up to **3.08 min/mi** higher. Recomputing
   "after" while reading "before" from the table reported a large spurious delay
   *reduction* for a scenario that changed nothing.
3. **Float snap.** Four MSA steps leave ~1e-12 of residue on demand even when
   every delta is zero, which was enough to flip one station-bucket sitting
   exactly on the LOS D/E threshold. v/c is now pivoted on a ratio that is
   exactly 1.0 when nothing moved, and demand within 1e-6 vph of the lever-
   adjusted value is snapped (six orders of magnitude below 1 vehicle/hour, so it
   cannot mask a real diversion).

LOS is derived from v/c on **both** sides with the same expression rather than
read from `level_of_service` for "before". The stored grade agrees on 191,423 of
191,424 rows; the one exception sits exactly on a threshold where the stored grade
was decided from an unrounded v/c.

### Scenarios

All four levers verified directionally correct, with per-station output in the PR
body:

* **Close 2 lanes, I-405 S pm 45–52, 17:00** — v/c 1.31→2.11, speed 23.4→8.0 mph,
  delay 1.93→6.87 min/mi, VHT 78.2→137.3 at the worst station.
* **+20% demand on I-405** — corridor VHT +36.4% (S) / +32.7% (N), network mean
  speed 58.26→57.58 mph, LOS E/F cells 9,522→10,568. Demand appears on I-5,
  showing cross-corridor diversion.
* **Capacity +1 lane, I-405 S pm 45–52** — v/c 1.31→1.10, speed 23.4→36.9 mph,
  VHT 78.2→59.6; one ramp goes LOS **F→C**.
* **Incident, 2 lanes blocked, US-101 N pm 20–30, buckets 64–72** — inside the
  window capacity falls to 58.7% (`0.667 × 0.88`) and LOS goes D→F; **outside**
  the window (bucket 63) every column is an exact no-op, which is the time-bounding
  check.

### Conservation

I-405 S closure, 4 iterations: **86,244 vph** leaves the closed window, **21,897
vph** arrives at adjacent segments, **64,347 vph** goes off-network,
`conservation_error_veh` = **exactly 0.0** on the NETWORK row.

A **CORRIDOR** row's `conservation_error_veh` is legitimately non-zero — it *is*
the net demand moved onto or off that corridor. Only the NETWORK row is a closed
system, which is why `scope='NETWORK'` ignores the `:freeway` filter (a
corridor-scoped total makes diverted traffic look like it vanished).

### Tests

```
uv run --with pytest pytest -q          144 passed   (27 new + 117 pre-existing)
npx vitest run                          148 passed   (61 arithmetic + 26 binding + 61 other)
npm run test:smoke                        9 passed   (live warehouse, real browser)
npm run typecheck                       clean
npm run lint                            clean
```

The smoke suite runs the engine end to end in a browser: a lever-free Run
reproduces the baseline (`Conservation error 0.0 veh`) and a closure moves demand
off-network with conservation still exactly 0.

---

## 8. Not done

* **Scenario persistence.** `app.scenarios` / `app.scenario_runs` exist in
  Lakebase but nothing writes to them.
* **The Lakebase `bpr_alpha` / `bpr_beta` seed is still 0.15 / 4.0** — see §2.
  Correcting it belongs to the Lakebase migration, not this branch.
* **`MAX_ITERS` is still 4** despite the convergence evidence in §5 item 2 and
  latency being flat in iteration count. Raising it is the single highest-value
  follow-up.
* **No calibration of the reassignment shares.** Not possible with this data.

---

## 9. Reconciling with the lever UI (PR #7)

The lever UI and this engine were built in parallel with no shared contract and
landed on **genuinely different request shapes**. Both are reasonable; neither is
a superset. `client/src/lib/scenarioAdapter.ts` translates, and every lossy step
is reported in `warnings` rather than hidden.

| | Lever UI (`client/src/lib/scenario.ts`) | This engine |
|---|---|---|
| Levers | `levers: ScenarioLever[]` — a stackable union | one optional object per lever KIND |
| Targeting | a single `stationId` | postmile window on freeway+direction |
| Incident time | `startBucket` + `durationBuckets` | inclusive `fromBucket`..`toBucket` |
| Capacity | absolute `capacityVph` only | add-lanes, multiplier, or absolute |
| Severity | scales speed **directly** (0.88/0.72/0.55/0.38) | metadata only — speed follows from capacity via BPR |
| Matrix | 96 buckets, `number[]` per metric | 4 windows of packed integer strings |

**The engine takes one lever per kind because DBSQL cannot bind a variable-length
list** — each kind maps to a fixed parameter set. The adapter folds multiples into
the postmile hull covering all of them, taking the **max** effect (folding by max
cannot under-report impact; summing would invent a closure wider than asked for).
Levers of one kind spread across *different corridors* **throw** rather than
modelling only the first: a scenario that silently drops a lever is
indistinguishable from one that worked.

**Two differences the UI must expect, not just tolerate:**

1. **Severity means something different.** The mock scales speed directly; the
   engine derives the speed effect from the capacity loss `lanesBlocked` causes.
   Same lever, different number. Warned on every incident translation.
2. **The matrix is never inflated to `number[]`.** That shape for 96 buckets is
   the exact form M1 measured at **9,540,471 B (9.10 MiB)** — 9× over AppKit's
   1 MiB event cap. The scenario matrix uses M1's identical encoding, so
   `useScenarioRun` decodes the four packed windows with M1's own
   `applyPackedWindow` unchanged.

The UI asked the engine to declare which BPR pair it used. `engineModel()` answers
exactly that, and the KPI panel renders it **verbatim** rather than assuming.

### How it is wired

Both queries are in the generated `QueryRegistry`, so the client calls them
directly through `useAnalyticsQuery` — same SSE transport and per-query cache M1's
baseline uses. There is no Express route.

Three bugs in the never-executed server binding were found and fixed by wiring it
up, each confirmed against AppKit's implementation:

1. **`analytics.query()` takes SQL text, not a query key.** Key resolution happens
   only in AppKit's HTTP route via `app.getAppQuery()`.
2. **Parameters must be `sql.*` markers.** Raw values throw
   `Invalid value for day: expected SQL type`.
3. **The two queries take DIFFERENT 32-parameter sets.** `scenario_time_matrix`
   references `:from_bucket` and never `:worst_n`; `scenario_kpis` is the reverse.
   Both declare all 34 in their `-- @param` header (typegen reads that), but
   AppKit validates against the `:name` occurrences in the SQL BODY and throws on
   any extra key. DBSQL itself tolerates the extra parameter, which is why
   SQL-level testing never surfaced it.

A run is **explicit** — 5 queries at a measured 2.3–3.7 s warm — so levers stage
locally and the warehouse is only touched on **Run scenario**. Gating uses
`autoStart`, NOT `parameters: null`: null parameters do not hold a query back
(the hook only skips when serialisation throws), so they fire with no bindings and
fail with `[UNBOUND_SQL_PARAMETER]`. `tests/smoke.spec.ts` asserts staging fires
exactly **0** scenario queries.
