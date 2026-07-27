"""Render the M2 engine into `caltrans-whatif/config/queries/scenario_*.sql`.

    python -m tools.scenario_sql.render          # write
    python -m tools.scenario_sql.render --check  # verify committed files match

AppKit reads flat `.sql` files from `config/queries/` and generates TypeScript
row types from them, so the engine cannot live in a shared SQL include. It lives
in `engine.py` and is stamped into both files here.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import engine as E

REPO_ROOT = Path(__file__).resolve().parents[2]
QUERY_DIR = REPO_ROOT / "caltrans-whatif" / "config" / "queries"


# ---------------------------------------------------------------------------
# scenario_time_matrix.sql — the map payload
# ---------------------------------------------------------------------------

_MATRIX_DOC = f"""\
--
-- ── This file's job: the SCENARIO animation payload ─────────────────────────
-- Drop-in replacement for traffic_time_matrix.sql, and a SUPERSET of its client
-- contract: the four M1 columns (flow, speed_half, vc_pct, incident) carry the
-- SCENARIO values in exactly M1's layout and encoding, so lib/frames.ts decodes
-- this file unchanged. One column is added: `delay_c`, delay in centi-minutes
-- per mile, which M1 had no need for and the KPI panel does.
--
-- ⚠️ It deliberately does NOT return the "before" side. The client already holds
-- the baseline: it fetched traffic_time_matrix.sql for the same day and window
-- on load, and the engine's no-op proof is what guarantees those numbers ARE
-- this engine's "before". Shipping them again cost a MEASURED 770,276 extra
-- bytes per window and pushed the payload to 1,422,030 B (1.356 MiB) -- over
-- AppKit's 1 MiB single-event cap (appkit/dist/stream/defaults.js
-- `maxEventSize`), i.e. a runtime failure, not just waste. The before/after diff
-- is a client-side subtraction of two arrays already in memory.
--
-- Same encoding as M1: values scaled to integers because "48.4" costs more
-- characters than "97" (speed x2, v/c x100, delay x100), and level_of_service is
-- derived client-side rather than transmitted since it is a pure function of v/c.
--
-- Same windowing as M1 and for the same reason: a whole 96-bucket day of all
-- corridors is 2.47 MiB columnar, over the 1 MiB event cap, so the day is
-- fetched as four 24-bucket windows in parallel.
--
-- ⚠️ ARRAY_AGG / COLLECT_LIST DO NOT INHERIT A SUBQUERY'S ORDER BY on Spark.
-- An earlier M1 revision hit this: bucket 68 decoded to 64.80 mph when ground
-- truth was 48.44 mph -- the 17:00 rush hour silently vanished from the map
-- while every individual value still looked plausible. The fix, kept here, is to
-- collect (ord, value) structs and ARRAY_SORT with an explicit comparator.
--
-- The engine solves over ALL corridors; `:freeway` filters only this output.
-- The station index is therefore dense over the FILTERED set and, exactly as in
-- M1, is derived from the whole day rather than the window so indices are
-- stable across the four parallel window fetches. It must match
-- station_geometry.sql's `ORDER BY station_id` -- that shared ordering is the
-- entire client-side join.
"""


def _packed(col: str, alias: str) -> str:
    return f"""\
  ARRAY_JOIN(
    TRANSFORM(
      ARRAY_SORT(
        COLLECT_LIST(STRUCT(ord, {col})),
        (l, r) -> CASE WHEN l.ord < r.ord THEN -1 WHEN l.ord > r.ord THEN 1 ELSE 0 END
      ),
      x -> CAST(x.{col} AS STRING)
    ), ','
  ) AS {alias}"""


def render_time_matrix() -> str:
    packed = ",\n".join(
        [
            _packed("flow", "flow"),
            _packed("speed_half", "speed_half"),
            _packed("vc_pct", "vc_pct"),
            _packed("incident", "incident"),
            _packed("delay_c", "delay_c"),
        ]
    )
    return f"""{E.header("SCENARIO TIME MATRIX (map payload)")}{_MATRIX_DOC}{E.engine_sql()},
out_stations AS (
  -- Dense 0..N-1 index over the FILTERED station set, derived from the whole day.
  SELECT
    station_id,
    CAST(ROW_NUMBER() OVER (ORDER BY station_id) - 1 AS INT) AS station_idx
  FROM (
    SELECT DISTINCT station_id
    FROM station_metrics
    WHERE (:freeway = 'ALL' OR freeway = :freeway)
  )
),
cells AS (
  SELECT
    o.station_idx,
    m.bucket_idx,
    CAST(ROUND(m.served_after) AS INT)                     AS flow,
    CAST(ROUND(m.speed_after * 2) AS INT)                  AS speed_half,
    CAST(ROUND(m.vc_after * 100) AS INT)                   AS vc_pct,
    -- An "incident" pixel now means any capacity loss vs baseline, whether from
    -- the injected incident or a planned closure: 0 = none, else a 1..4 severity
    -- proxy binned by how much capacity was lost, so the M1 renderer's severity
    -- ramp keeps working unchanged.
    CAST(
      CASE
        WHEN m.cap_scen < m.cap_obs * 0.999
        THEN least(4, greatest(1, CAST(CEIL((1.0 - m.cap_scen / greatest(1e-9, m.cap_obs))
                                            * 4.0) AS INT)))
        ELSE 0
      END AS INT)                                          AS incident,
    -- Delay in CENTI-minutes per mile (x100). Integer-encoded like everything
    -- else; the client divides by 100.
    CAST(ROUND(m.delay_after * 100) AS INT)                AS delay_c
  FROM station_metrics m
  JOIN out_stations o ON o.station_id = m.station_id
  WHERE (:freeway = 'ALL' OR m.freeway = :freeway)
),
windowed AS (
  SELECT
    *,
    -- Explicit bucket-major, station-minor sort key. The 100000 multiplier
    -- exceeds the max station count (1,994) by a wide margin so the two fields
    -- can never collide.
    CAST((bucket_idx - :from_bucket) * 100000 + station_idx AS BIGINT) AS ord
  FROM cells
  WHERE bucket_idx >= :from_bucket
    AND bucket_idx < :from_bucket + 24
)
SELECT
  CAST(COUNT(*) AS INT)                        AS n,
  CAST(MIN(bucket_idx) AS INT)                 AS first_bucket,
  CAST(MAX(bucket_idx) AS INT)                 AS last_bucket,
  CAST(COUNT(DISTINCT station_idx) AS INT)     AS stations,
{packed}
FROM windowed
"""


# ---------------------------------------------------------------------------
# scenario_kpis.sql — the KPI panel
# ---------------------------------------------------------------------------

_KPI_DOC = """\
--
-- ── This file's job: the KPI panel ─────────────────────────────────────────
-- One row per scope, all from the SAME engine as scenario_time_matrix.sql (both
-- files are generated from tools/scenario_sql/engine.py, and a test fails if
-- they drift). If they diverged the panel would report numbers the map does not
-- draw.
--
-- Three scope kinds in one result set, distinguished by `scope`:
--   'NETWORK'  — one row, the whole modelled network (all 10 corridors, all 96
--                buckets), regardless of `:freeway`. Network totals are the only
--                honest place to read a diversion scenario: a corridor-scoped
--                total looks like traffic vanished when it actually moved next
--                door.
--   'CORRIDOR' — one row per freeway+direction, ordered by delta VHT desc.
--   'SEGMENT'  — the worst `:worst_n` station-buckets by delta VHT, i.e. where
--                the scenario hurts most. This is a station x 15-min bucket, not
--                a whole-day station, so it names the time as well as the place.
--
-- Aggregation rules that matter:
--   * VHT/VMT are SUMS (extensive quantities).
--   * v/c and speed are VMT-WEIGHTED means, not plain means. An unweighted mean
--     lets a 0.5-mile off-ramp with 40 vph outvote 6 miles of jammed mainline.
--   * Average network speed is recomputed as VMT/VHT (the harmonic, flow-
--     weighted definition), which is the only aggregation of speed that is
--     dimensionally meaningful.
--
-- The conservation columns are the audit trail for the reassignment: with MSA
-- damping being a convex combination of demand vectors, `demand_after_vph +
-- offnetwork_vph` must equal `demand_lever_vph` to machine precision. They are
-- returned rather than asserted so a reviewer can check the arithmetic without
-- trusting a comment.
"""


def render_kpis() -> str:
    # Shared metric list, rendered per scope so the three UNION arms cannot drift.
    def agg(scope: str, group: str) -> str:
        return f"""\
  SELECT
    '{scope}' AS scope,
    {group},
    CAST(MAX(iter) AS INT)                                       AS msa_iterations_used,
    CAST(COUNT(*) AS BIGINT)                                     AS cells,
    CAST(COUNT(DISTINCT station_id) AS INT)                      AS stations,
    SUM(vht_before)                                              AS vht_before,
    SUM(vht_after)                                               AS vht_after,
    SUM(vht_after) - SUM(vht_before)                             AS vht_delta,
    SUM(vmt_before)                                              AS vmt_before,
    SUM(vmt_after)                                               AS vmt_after,
    SUM(vmt_after) - SUM(vmt_before)                             AS vmt_delta,
    -- Network mean speed as VMT/VHT: the flow-weighted harmonic mean, the only
    -- aggregation of speed that is dimensionally sound.
    SUM(vmt_before) / greatest(1e-9, SUM(vht_before))            AS speed_before,
    SUM(vmt_after)  / greatest(1e-9, SUM(vht_after))             AS speed_after,
    -- v/c and delay are VMT-weighted so a short ramp cannot outvote a corridor.
    SUM(vc_before * vmt_before) / greatest(1e-9, SUM(vmt_before)) AS vc_before,
    SUM(vc_after  * vmt_after)  / greatest(1e-9, SUM(vmt_after))  AS vc_after,
    SUM(delay_before * vmt_before) / greatest(1e-9, SUM(vmt_before)) AS delay_before,
    SUM(delay_after  * vmt_after)  / greatest(1e-9, SUM(vmt_after))  AS delay_after,
    -- Vehicle-hours of pure delay: VMT at (1/speed - 1/free-flow).
    SUM(vmt_before * (1.0/greatest(1e-9,speed_before) - 1.0/greatest(1e-9,ff_mph)))
                                                                 AS delay_vht_before,
    SUM(vmt_after  * (1.0/greatest(1e-9,speed_after)  - 1.0/greatest(1e-9,ff_mph)))
                                                                 AS delay_vht_after,
    CAST(COUNT_IF(los_before IN ('E','F')) AS BIGINT)            AS los_ef_before,
    CAST(COUNT_IF(los_after  IN ('E','F')) AS BIGINT)            AS los_ef_after,
    CAST(COUNT_IF(vc_before > 1.0) AS BIGINT)                    AS oversat_before,
    CAST(COUNT_IF(vc_after  > 1.0) AS BIGINT)                    AS oversat_after,
    -- Conservation audit. demand_after + offnetwork must equal demand_lever.
    SUM(demand_obs   * {E.BUCKET_HOURS})                         AS demand_observed_veh,
    SUM(d_lever      * {E.BUCKET_HOURS})                         AS demand_lever_veh,
    SUM(demand_after * {E.BUCKET_HOURS})                         AS demand_after_veh,
    SUM(offnetwork_vph * {E.BUCKET_HOURS})                       AS demand_offnetwork_veh,
    SUM((demand_after + offnetwork_vph - d_lever) * {E.BUCKET_HOURS}) AS conservation_error_veh,
    -- How much of the network can divert at all, at the configured thresholds.
    CAST(COUNT(DISTINCT CASE WHEN has_alt THEN station_id END) AS INT)
                                                                 AS stations_with_alternative,
    SUM(capacity_before_vph) AS capacity_before_vph,
    SUM(capacity_after_vph)  AS capacity_after_vph"""

    network = agg("NETWORK", "'ALL' AS freeway,\n    'ALL' AS direction,\n    CAST(NULL AS INT) AS bucket_idx")
    corridor = agg("CORRIDOR", "freeway,\n    direction,\n    CAST(NULL AS INT) AS bucket_idx")
    segment = agg("SEGMENT", "freeway,\n    direction,\n    bucket_idx")

    return f"""{E.header("SCENARIO KPIs (before/after panel)")}{_KPI_DOC}{E.engine_sql()},
scoped AS (
  SELECT
    m.*,
    -- Does this station have ANY parallel-corridor alternative at the configured
    -- thresholds? Reported so a scenario cannot quietly imply the whole network
    -- can re-route when (measured) only ~27% of stations have a parallel option.
    EXISTS (SELECT 1 FROM cand c WHERE c.src = m.station_id) AS has_alt,
    m.cap_obs  AS capacity_before_vph,
    m.cap_scen AS capacity_after_vph
  FROM station_metrics m
),
corridor_scoped AS (
  -- Corridor and segment scopes honour :freeway; NETWORK deliberately does not.
  SELECT * FROM scoped WHERE (:freeway = 'ALL' OR freeway = :freeway)
),
net AS (
{network}
  FROM scoped
),
corr AS (
{corridor}
  FROM corridor_scoped
  GROUP BY freeway, direction
),
seg AS (
{segment}
  FROM corridor_scoped
  GROUP BY freeway, direction, bucket_idx, station_id
  ORDER BY vht_delta DESC
  LIMIT :worst_n
),
unioned AS (
  SELECT * FROM net
  UNION ALL SELECT * FROM corr
  UNION ALL SELECT * FROM seg
)
SELECT
  scope, freeway, direction, bucket_idx,
  msa_iterations_used, cells, stations, stations_with_alternative,
  ROUND(vht_before, 3)             AS vht_before,
  ROUND(vht_after, 3)              AS vht_after,
  ROUND(vht_delta, 3)              AS vht_delta,
  ROUND(100.0 * vht_delta / greatest(1e-9, vht_before), 3) AS vht_delta_pct,
  ROUND(vmt_before, 3)             AS vmt_before,
  ROUND(vmt_after, 3)              AS vmt_after,
  ROUND(vmt_delta, 3)              AS vmt_delta,
  ROUND(100.0 * vmt_delta / greatest(1e-9, vmt_before), 3) AS vmt_delta_pct,
  ROUND(speed_before, 3)           AS speed_before,
  ROUND(speed_after, 3)            AS speed_after,
  ROUND(speed_after - speed_before, 3) AS speed_delta,
  ROUND(vc_before, 4)              AS vc_before,
  ROUND(vc_after, 4)               AS vc_after,
  ROUND(vc_after - vc_before, 4)   AS vc_delta,
  ROUND(delay_before, 4)           AS delay_before,
  ROUND(delay_after, 4)            AS delay_after,
  ROUND(delay_after - delay_before, 4) AS delay_delta,
  ROUND(delay_vht_before, 3)       AS delay_vht_before,
  ROUND(delay_vht_after, 3)        AS delay_vht_after,
  ROUND(delay_vht_after - delay_vht_before, 3) AS delay_vht_delta,
  los_ef_before, los_ef_after,
  CAST(los_ef_after - los_ef_before AS BIGINT) AS los_ef_delta,
  oversat_before, oversat_after,
  ROUND(demand_observed_veh, 3)    AS demand_observed_veh,
  ROUND(demand_lever_veh, 3)       AS demand_lever_veh,
  ROUND(demand_after_veh, 3)       AS demand_after_veh,
  ROUND(demand_offnetwork_veh, 3)  AS demand_offnetwork_veh,
  ROUND(conservation_error_veh, 9) AS conservation_error_veh,
  ROUND(capacity_before_vph, 3)    AS capacity_before_vph,
  ROUND(capacity_after_vph, 3)     AS capacity_after_vph
FROM unioned
ORDER BY
  CASE scope WHEN 'NETWORK' THEN 0 WHEN 'CORRIDOR' THEN 1 ELSE 2 END,
  vht_delta DESC,
  freeway, direction, bucket_idx
"""


TARGETS: dict[str, str] = {
    "scenario_time_matrix.sql": render_time_matrix,
    "scenario_kpis.sql": render_kpis,
}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="verify without writing")
    args = ap.parse_args(argv)

    failures = []
    for name, fn in TARGETS.items():
        path = QUERY_DIR / name
        want = fn()
        if args.check:
            have = path.read_text() if path.exists() else ""
            if have != want:
                failures.append(name)
        else:
            path.write_text(want)
            print(f"wrote {path.relative_to(REPO_ROOT)} ({len(want):,} bytes)")

    if failures:
        print(
            "STALE (re-run `python -m tools.scenario_sql.render`): " + ", ".join(failures),
            file=sys.stderr,
        )
        return 1
    if args.check:
        print("scenario SQL is in sync with the generator")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
