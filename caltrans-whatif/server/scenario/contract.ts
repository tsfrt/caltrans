/**
 * The M2 what-if engine's request/response contract.
 *
 * This file is the seam between the lever UI and the DBSQL engine. It is
 * deliberately the ONLY place that knows the names of the engine's SQL
 * parameters: the UI speaks `ScenarioRequest` (nested, optional, human units)
 * and `bindScenario` in ./params.ts flattens it into the 34 flat `:name`
 * bindings that `config/queries/scenario_*.sql` declare.
 *
 * Every lever is OPTIONAL and every omitted lever is a no-op. That is not just
 * ergonomics — it is the property that makes the engine's baseline provable: with
 * an empty request the engine reproduces `gold_map_frames` bit-for-bit (v/c,
 * demand and LOS exactly; speed/delay to double epsilon). See
 * `docs/WHATIF_ENGINE.md`.
 */

/** A geographic target: a postmile window on one corridor. */
export interface SegmentTarget {
  /** Corridor name exactly as stored, e.g. `'I-405'`. */
  freeway: string;
  /** `'N'`/`'S'`/`'E'`/`'W'`, or omitted for both carriageways. */
  direction?: string;
  /** Inclusive postmile window. Omit both for the whole corridor. */
  postmileFrom?: number;
  postmileTo?: number;
}

/** Lever 1 — planned lane closure. Reduces capacity; no rubbernecking term. */
export interface ClosureLever extends SegmentTarget {
  /** Lanes taken out of service. Must be >= 1. */
  lanes: number;
}

/** Lever 2 — corridor demand delta. */
export interface DemandLever {
  /** Corridor name, or `'ALL'` for every corridor. */
  freeway: string;
  direction?: string;
  /** Percent change: `20` = +20%, `-15` = -15%. */
  percent: number;
}

/**
 * Lever 3 — incident injection. Unlike a closure this carries the HCM
 * rubbernecking/merge-turbulence penalty (a further 12% off the surviving
 * lanes), and it is bounded to a time window.
 */
export interface IncidentLever extends SegmentTarget {
  lanesBlocked: number;
  /** Inclusive 15-minute bucket window, 0..95 in Pacific local time. */
  fromBucket: number;
  toBucket: number;
  /**
   * HCM severity 1..4. Advisory only: the engine's capacity effect is driven by
   * `lanesBlocked`, which is the physical quantity. Carried so the UI and the
   * saved-scenario record can describe the incident, and so a future revision
   * can attach a severity-dependent duration or demand response without a
   * contract change.
   */
  severity?: 1 | 2 | 3 | 4;
}

/**
 * Lever 4 — capacity change (new lane, ramp metering, hard-shoulder running).
 * The three forms compose in this order: `addLanes`, then `scale`, then
 * `absoluteVph`, which replaces the composed value outright.
 */
export interface CapacityLever extends SegmentTarget {
  /** Lanes added; negative removes. */
  addLanes?: number;
  /** Multiplier on effective capacity. `1.15` = ramp metering worth +15%. */
  scale?: number;
  /** Absolute effective-capacity override in vehicles/hour. */
  absoluteVph?: number;
}

/** How much demand is allowed to move, and where it may move to. */
export interface ReassignmentConfig {
  /**
   * Fraction (0..1) of the demand the SCENARIO pushed over capacity that is
   * willing to re-route at all. Demand that was already over capacity in the
   * observed data is NOT reassigned — the engine models the change, not the
   * baseline. Default 0.35.
   */
  share?: number;
  /**
   * Of that willing share, the fraction that leaves the modelled freeway network
   * entirely (local arterials, retiming, mode shift, trip suppression). This is
   * an honest sink, not a fudge: the data contains 10 freeways and no arterials,
   * so some diverted traffic has nowhere in-model to go. Tracked separately in
   * the KPI output so conservation stays auditable. Default 0.30.
   */
  offNetworkShare?: number;
  /** Max metres to a parallel-corridor target. Default 8000. */
  maxParallelDistanceM?: number;
  /** Max heading difference (degrees) for "parallel". Default 45. */
  maxParallelBearingDeg?: number;
}

/** BPR volume-delay coefficients. See `docs/WHATIF_ENGINE.md` §2. */
export interface BprConfig {
  /** Default 0.55 — the DATA GENERATOR's value, not the textbook 0.15. */
  alpha?: number;
  /** Default 4.5 — the DATA GENERATOR's value, not the textbook 4.0. */
  beta?: number;
}

export interface ScenarioRequest {
  /** Pacific-local `reading_date`, `YYYY-MM-DD`. Required. */
  day: string;
  /** Corridor to RETURN. `'ALL'` (default) or a freeway name. */
  freeway?: string;
  /**
   * First bucket of the 24-bucket output window (0, 24, 48 or 72 in practice).
   * Time-matrix requests only; ignored by the KPI query.
   */
  fromBucket?: number;
  /**
   * MSA iterations, 0..4. 0 disables reassignment. Default 4.
   * Higher is not available: the SQL unrolls a fixed 4 iterations because DBSQL
   * cannot loop with aggregates. See `docs/WHATIF_ENGINE.md` §4.
   */
  iterations?: number;
  closure?: ClosureLever;
  demand?: DemandLever;
  incident?: IncidentLever;
  capacity?: CapacityLever;
  reassignment?: ReassignmentConfig;
  bpr?: BprConfig;
  /** Rows in the worst-segment list. KPI requests only. Default 10. */
  worstN?: number;
}

/**
 * One row of `scenario_time_matrix.sql`.
 *
 * The four M1 columns carry the SCENARIO values in M1's exact layout and
 * encoding, so `client/src/lib/frames.ts` decodes this unchanged. There is no
 * "before" side by design: the client already holds the baseline from
 * `traffic_time_matrix.sql`, and returning it again measured 770,276 extra bytes
 * per window, pushing the payload over AppKit's 1 MiB single-event cap.
 *
 * Every packed column is a comma-separated integer string in bucket-major,
 * station-minor order:
 *     offset = (bucket - first_bucket) * stations + station_idx
 * `station_idx` is the position in `station_geometry.sql`'s `ORDER BY station_id`.
 */
export interface ScenarioMatrixRow {
  /** Cell count = `stations * (last_bucket - first_bucket + 1)`. */
  n: number;
  first_bucket: number;
  last_bucket: number;
  stations: number;
  /** Served flow, vehicles/hour. */
  flow: string;
  /** Speed x 2 (half-mph precision). Divide by 2. */
  speed_half: string;
  /** v/c x 100. Divide by 100. Legitimately exceeds 100. */
  vc_pct: string;
  /** 0 = no capacity loss vs baseline, else a 1..4 severity proxy. */
  incident: string;
  /** Delay vs free-flow, centi-minutes per mile (x100). Divide by 100. */
  delay_c: string;
}

/** `scope` discriminator on a `scenario_kpis.sql` row. */
export type ScenarioKpiScope = 'NETWORK' | 'CORRIDOR' | 'SEGMENT';

/**
 * One row of `scenario_kpis.sql`.
 *
 * ⚠️ Numeric fields are typed `number` but arrive as STRINGS over the SQL
 * Statement API (every JSON_ARRAY value is serialised as a string). Always
 * `Number(...)` before arithmetic — see the AppKit SQL type-handling note in
 * `.claude/skills/databricks-apps/references/appkit/sql-queries.md`.
 */
export interface ScenarioKpiRow {
  scope: ScenarioKpiScope;
  /** `'ALL'` on the NETWORK row. */
  freeway: string;
  direction: string;
  /** Set on SEGMENT rows only; `null` for NETWORK/CORRIDOR. */
  bucket_idx: number | null;

  msa_iterations_used: number;
  /** Station-buckets aggregated into this row. */
  cells: number;
  stations: number;
  /**
   * Of `stations`, how many have ANY diversion candidate at the configured
   * thresholds. Reported so a scenario cannot imply the whole network can
   * re-route when it cannot.
   */
  stations_with_alternative: number;

  vht_before: number;
  vht_after: number;
  vht_delta: number;
  vht_delta_pct: number;
  vmt_before: number;
  vmt_after: number;
  vmt_delta: number;
  vmt_delta_pct: number;

  /** VMT/VHT — the flow-weighted harmonic mean, not a plain average. */
  speed_before: number;
  speed_after: number;
  speed_delta: number;
  /** VMT-weighted, so a short ramp cannot outvote a corridor. */
  vc_before: number;
  vc_after: number;
  vc_delta: number;
  /** Minutes per mile above free-flow, VMT-weighted. */
  delay_before: number;
  delay_after: number;
  delay_delta: number;
  /** Vehicle-hours of pure delay. */
  delay_vht_before: number;
  delay_vht_after: number;
  delay_vht_delta: number;

  /** Station-buckets at LOS E or F. */
  los_ef_before: number;
  los_ef_after: number;
  los_ef_delta: number;
  /** Station-buckets with v/c > 1. */
  oversat_before: number;
  oversat_after: number;

  /** Conservation audit, in vehicles. */
  demand_observed_veh: number;
  demand_lever_veh: number;
  demand_after_veh: number;
  demand_offnetwork_veh: number;
  /**
   * `demand_after + demand_offnetwork - demand_lever`. Exactly 0 on the NETWORK
   * row (MSA damping is a convex combination). Non-zero on a CORRIDOR row is not
   * an error — it IS the diversion, measuring net demand moved onto or off that
   * corridor.
   */
  conservation_error_veh: number;

  capacity_before_vph: number;
  capacity_after_vph: number;
}

/** Query keys AppKit resolves to `config/queries/<key>.sql`. */
export const SCENARIO_MATRIX_QUERY = 'scenario_time_matrix' as const;
export const SCENARIO_KPI_QUERY = 'scenario_kpis' as const;
