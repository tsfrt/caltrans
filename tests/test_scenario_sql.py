"""Tests for the M2 what-if engine's SQL generator.

Two jobs:

1. **Drift.** `caltrans-whatif/config/queries/scenario_*.sql` are GENERATED. If a
   reviewer edits the `.sql` directly, the next render silently reverts it, so
   ``test_rendered_sql_is_in_sync`` fails instead.

2. **Structural invariants that cost real latency or correctness.** The
   single-reference rule in particular is not visible from reading one CTE, but
   violating it took the query from 2.3 s to 434 s on the warehouse. A comment
   alone did not stop it happening once already, so it is asserted here.

The engine's numeric behaviour is verified on the warehouse (see
`caltrans-whatif/docs/WHATIF_ENGINE.md` §6) and its arithmetic is pinned by
`caltrans-whatif/server/scenario/scenario.test.ts`. This file deliberately does
not try to re-implement the model in Python.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT))

from tools.scenario_sql import engine as E  # noqa: E402
from tools.scenario_sql import render as R  # noqa: E402

RENDERED = {name: fn() for name, fn in R.TARGETS.items()}


def _iteration_block(k: int) -> str:
    """The SQL of MSA iteration `k` alone, excluding the `picked` selector."""
    body = E.engine_sql()
    start = body.index(f"x{k}_flux AS (")
    end = body.index(f"x{k + 1}_flux AS (") if k < E.MAX_ITERS else body.index("picked AS (")
    return body[start:end]


def _cte_body(name: str) -> str:
    """The SQL between `<name> AS (` and its matching close, by paren depth."""
    body = E.engine_sql()
    start = body.index(f"{name} AS (") + len(f"{name} AS (")
    depth = 1
    for i in range(start, len(body)):
        if body[i] == "(":
            depth += 1
        elif body[i] == ")":
            depth -= 1
            if depth == 0:
                return body[start:i]
    raise AssertionError(f"unbalanced parentheses in CTE {name}")


# ---------------------------------------------------------------------------
# 1. Drift
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(R.TARGETS))
def test_rendered_sql_is_in_sync(name: str) -> None:
    """The committed .sql must equal what the generator produces right now."""
    path = R.QUERY_DIR / name
    assert path.exists(), f"{name} has not been rendered; run tools.scenario_sql.render"
    assert path.read_text() == RENDERED[name], (
        f"{name} is stale or was hand-edited. Edit tools/scenario_sql/engine.py "
        f"and run `python -m tools.scenario_sql.render`."
    )


def test_render_check_mode_passes() -> None:
    assert R.main(["--check"]) == 0


def test_both_queries_embed_the_identical_engine() -> None:
    """The KPI panel must not be able to report numbers the map does not draw."""
    body = E.engine_sql()
    for name, sql in RENDERED.items():
        assert body in sql, f"{name} does not contain the shared engine body verbatim"


# ---------------------------------------------------------------------------
# 2. Structural invariants
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("k", range(1, E.MAX_ITERS + 1))
def test_iteration_reads_previous_iterate_exactly_once(k: int) -> None:
    """The rule that keeps the query interactive.

    DBSQL inlines CTEs, so each textual reference to the previous iterate
    re-expands the whole upstream chain -- including the 191,424-row scan of
    gold_map_frames. Cost compounds as refs^iterations. MEASURED for 4
    iterations on warehouse 688f49c732cf9083: 4 refs = 434 s, 2 refs = 235 s,
    1 ref = 2.3 s.
    """
    # Scope to the iteration block only. The `picked` selector below references
    # every iterate once more, which is unavoidable -- it is how :msa_iterations
    # chooses one -- and those arms are pruned by the optimiser because their
    # predicate is a literal comparison against the bound parameter.
    block = _iteration_block(k)
    prev = f"st{k - 1}"
    # FROM/JOIN position only, so a mention in a comment or an alias does not trip.
    refs = re.findall(rf"\b(?:FROM|JOIN)\s+{prev}\b", block)
    assert len(refs) == 1, (
        f"iteration {k} references {prev} {len(refs)} times in FROM/JOIN position; "
        f"must be exactly 1 or latency grows exponentially (see docs/WHATIF_ENGINE.md)"
    )


def test_state_cte_reads_its_move_cte_exactly_once() -> None:
    """Same rule, one level down: st{k} must not re-read x{k}_move twice."""
    body = E.engine_sql()
    for k in range(1, E.MAX_ITERS + 1):
        refs = re.findall(rf"\b(?:FROM|JOIN)\s+x{k}_move\b", body)
        assert len(refs) == 1, f"x{k}_move referenced {len(refs)} times, expected 1"


def test_every_iterate_is_selectable() -> None:
    """`:msa_iterations` must be able to pick any iterate, including 0."""
    body = E.engine_sql()
    for k in range(E.MAX_ITERS + 1):
        assert f"SELECT * FROM st{k} WHERE {k} = :msa_iterations" in body


def test_base_excess_is_carried_through_every_iteration() -> None:
    """Reassignment must move only what the SCENARIO pushed over capacity.

    Without the `- base_excess` term the engine re-routes the data's own
    pre-existing congestion, and a lever-free scenario with reassignment enabled
    came out up to 49 mph faster in places while moving 678,535 vehicle-
    equivalents off-network -- i.e. it "fixed" the baseline and the no-op proof
    failed. Measured before the fix.
    """
    body = E.engine_sql()
    # Seeded once from the observed data...
    assert "greatest(0.0, demand_obs - cap_obs) AS base_excess" in body
    # ...subtracted in EVERY iteration's divertible-excess term...
    assert body.count("- p.base_excess) AS my_excess") == E.MAX_ITERS
    # ...and carried through every iteration's projection, or later iterations
    # would start relitigating the baseline again.
    assert body.count("MAX(base_excess) AS base_excess") == E.MAX_ITERS
    for k in range(1, E.MAX_ITERS + 1):
        assert "- p.base_excess) AS my_excess" in _iteration_block(k), (
            f"iteration {k} reassigns pre-existing congestion, not just the "
            f"scenario's own excess"
        )


def test_scenario_solves_over_all_corridors() -> None:
    """The `:freeway` filter must be an OUTPUT filter, never an engine filter.

    Excluding US-101 from the solve would delete the corridor that I-405's
    traffic diverts onto, and the scenario would silently under-report relief.
    """
    # The observed-data CTE filters on the day only.
    obs = _cte_body("obs")
    assert "reading_date = :day" in obs
    assert ":freeway" not in obs, "the engine must not be narrowed to one corridor"
    # And the output filter must exist somewhere downstream, or :freeway is dead.
    assert ":freeway = 'ALL' OR" in "".join(RENDERED.values())


def test_geometry_window_calls_are_parenthesised() -> None:
    """`OVER w - LAG(...)` parses as the identifier `w-s` on this channel.

    Verified failure: INVALID_IDENTIFIER, SQLSTATE 42602. A named window
    reference must be wrapped in parentheses before it can be an operand.
    """
    # Strip `--` comments first: the CTE's own explanatory comment quotes the
    # broken form `OVER w - LAG(...)` as the thing NOT to do, and scanning it
    # would fail the test on the documentation of the bug rather than the bug.
    geo = re.sub(r"--[^\n]*", "", _cte_body("geo"))
    # Every window call that is an OPERAND must be wrapped. The only bare form
    # allowed is a window call that is the whole expression, i.e. immediately
    # followed by `)` (closing its own wrapper) or `,`/newline (end of item).
    assert "OVER w" in geo, "the geo CTE should still use a named window"
    for match in re.finditer(r"OVER w(.)", geo):
        following = match.group(1)
        assert following in ")\n,", (
            f"a window reference is followed by {following!r} without parentheses; "
            f"`OVER w - LAG(...)` parses as the identifier `w-s` (42602), not an "
            f"expression. Wrap the window call: `(LEAD(x) OVER w) - ...`"
        )


def test_distance_uses_the_spherical_function() -> None:
    """ST_Distance returns planar DEGREES on this channel and is unusable here."""
    body = E.engine_sql()
    assert "ST_DistanceSphere(" in body
    assert not re.search(r"\bST_Distance\(", body)


def test_no_geography_casts() -> None:
    """ST predicates reject GEOGRAPHY on this channel (42K09)."""
    assert "GEOGRAPHY" not in E.engine_sql().upper()


def test_timestamps_are_converted_to_pacific() -> None:
    """time_bucket is stored UTC; a raw hour() would mislabel California peaks."""
    body = E.engine_sql()
    assert "from_utc_timestamp" in body
    assert "America/Los_Angeles" in body
    # Every hour()/minute() call must be on a converted timestamp.
    for fn in ("hour(", "minute("):
        for match in re.finditer(re.escape(fn), body):
            tail = body[match.end() : match.end() + 20]
            assert tail.startswith("from_utc_timestamp"), (
                f"{fn} applied to a non-converted timestamp: {tail!r}"
            )


def test_packed_columns_are_explicitly_sorted() -> None:
    """COLLECT_LIST does not inherit a subquery's ORDER BY on Spark.

    M1 hit this: bucket 68 decoded to 64.80 mph when ground truth was 48.44 mph,
    i.e. the 17:00 rush hour silently vanished from the map while every
    individual value still looked plausible. Every packed column must therefore
    collect (ord, value) structs and ARRAY_SORT with an explicit comparator.
    """
    matrix = RENDERED["scenario_time_matrix.sql"]
    collects = matrix.count("COLLECT_LIST(STRUCT(ord,")
    sorts = matrix.count("ARRAY_SORT(")
    assert collects > 0
    assert collects == sorts, f"{collects} COLLECT_LIST but {sorts} ARRAY_SORT"
    assert "l.ord < r.ord" in matrix


def test_matrix_does_not_ship_the_before_side() -> None:
    """Measured: shipping it added 770,276 B/window and broke the 1 MiB cap."""
    matrix = RENDERED["scenario_time_matrix.sql"]
    select_tail = matrix.rsplit("FROM windowed", 1)[0].rsplit("SELECT", 1)[1]
    for banned in ("AS flow_before", "AS speed_half_before", "AS vc_pct_before"):
        assert banned not in select_tail


def test_matrix_client_contract_is_m1_superset() -> None:
    """lib/frames.ts must decode this file unchanged."""
    matrix = RENDERED["scenario_time_matrix.sql"]
    for col in ("AS n", "AS first_bucket", "AS last_bucket", "AS stations",
                "AS flow", "AS speed_half", "AS vc_pct", "AS incident", "AS delay_c"):
        assert col in matrix, f"missing client-contract column {col}"


def test_kpi_query_returns_the_conservation_audit() -> None:
    """The reassignment is only checkable if its arithmetic is returned."""
    kpi = RENDERED["scenario_kpis.sql"]
    for col in ("demand_lever_veh", "demand_after_veh", "demand_offnetwork_veh",
                "conservation_error_veh", "stations_with_alternative"):
        assert col in kpi


def test_kpi_query_has_all_three_scopes() -> None:
    kpi = RENDERED["scenario_kpis.sql"]
    for scope in ("'NETWORK'", "'CORRIDOR'", "'SEGMENT'"):
        assert scope in kpi


def test_network_scope_ignores_the_corridor_filter() -> None:
    """A corridor-scoped total makes diverted traffic look like it vanished."""
    kpi = RENDERED["scenario_kpis.sql"]
    net = kpi.split("net AS (")[1].split("\n),")[0]
    assert "FROM scoped" in net
    assert "corridor_scoped" not in net


def _sql_only(text: str) -> str:
    """Strip `--` comments, so prose that mentions `:something` is not scanned."""
    return re.sub(r"--[^\n]*", "", text)


def test_every_declared_parameter_is_actually_used() -> None:
    """A documented-but-unbound parameter is a lever that silently does nothing."""
    combined = _sql_only(E.engine_sql() + "".join(RENDERED.values()))
    for name, _sql_type, _doc in E.PARAMS:
        assert f":{name}" in combined, f"parameter :{name} is declared but never referenced"


def test_no_undeclared_parameters() -> None:
    """Anything the SQL references but the server does not bind fails at runtime.

    DBSQL rejects a partially-bound statement with UNBOUND_SQL_PARAMETER (42P02),
    so an undeclared `:name` is not a default -- it is a hard failure on every
    request.
    """
    declared = {name for name, _t, _d in E.PARAMS}
    used = set(re.findall(r":([a-z_][a-z0-9_]*)", _sql_only("".join(RENDERED.values()))))
    assert used <= declared, f"SQL uses undeclared parameters: {sorted(used - declared)}"


def test_los_thresholds_match_the_data_generator() -> None:
    """LOS must grade the same way the pipeline graded it, or before/after differ."""
    from caltrans_traffic import config as C

    assert tuple(E.LOS_THRESHOLDS) == tuple(C.LOS_THRESHOLDS)


def test_physical_constants_match_the_data_generator() -> None:
    from caltrans_traffic import config as C

    assert E.MIN_SPEED_MPH == C.MIN_SPEED_MPH
    assert E.RUBBERNECK_CAPACITY_LOSS == C.RUBBERNECK_CAPACITY_LOSS
    assert E.BUCKET_HOURS == C.FRAME_MINUTES / 60.0
    assert E.LOCAL_TZ == C.LOCAL_TIMEZONE


def test_engine_bpr_defaults_follow_the_generator_not_the_textbook() -> None:
    """The milestone's central modelling decision, asserted rather than asserted-in-prose.

    The generator produced this data with alpha 0.55 / beta 4.5. Lakebase
    app.config still seeds the textbook 0.15 / 4.0. The generator wins; see
    caltrans-whatif/docs/WHATIF_ENGINE.md §2.
    """
    from caltrans_traffic import config as C

    ts_defaults = (
        REPO_ROOT / "caltrans-whatif" / "server" / "scenario" / "params.ts"
    ).read_text()
    assert f"alpha: {C.BPR_ALPHA}" in ts_defaults
    assert f"beta: {C.BPR_BETA}" in ts_defaults
    # And the conflicting Lakebase seed is still on record, so the doc's claim
    # about it stays true.
    seed = (REPO_ROOT / "lakebase" / "schema.sql").read_text()
    assert "'bpr_alpha'" in seed and "'0.15'" in seed


def test_param_annotations_exist_for_every_parameter() -> None:
    """AppKit typegen cannot describe a query without them.

    `DESCRIBE QUERY` rejects bound parameters (UNBOUND_SQL_PARAMETER, 42P02), so
    AppKit textually substitutes each `:name` with a literal whose type it reads
    from a `-- @param name TYPE` comment. A missing annotation means typegen
    fails with "queries could not be described" and the app cannot build --
    verified: both queries failed exactly that way before the block was added.
    """
    annotated = {"STRING", "INT", "DOUBLE", "DATE", "BIGINT", "BOOLEAN", "TIMESTAMP"}
    for name, sql in RENDERED.items():
        found = dict(re.findall(r"--\s*@param\s+(\w+)\s+(\w+)", sql))
        for pname, ptype, _doc in E.PARAMS:
            assert pname in found, f"{name} is missing `-- @param {pname} {ptype}`"
            assert found[pname] == ptype, (
                f"{name}: @param {pname} is annotated {found[pname]}, expected {ptype}"
            )
            assert ptype in annotated, f"{ptype} is not a type AppKit typegen recognises"


def test_generated_typescript_row_types_match_the_hand_written_contract() -> None:
    """`server/scenario/contract.ts` must describe the columns the SQL returns.

    The contract types are hand-written (they are the seam the lever UI codes
    against and needed to exist before typegen could run). Typegen has since been
    run against the live warehouse, so the two can be compared -- and must be, or
    the UI is typed against a shape the query does not produce.
    """
    generated = (
        REPO_ROOT / "caltrans-whatif" / "shared" / "appkit-types" / "analytics.d.ts"
    ).read_text()
    contract = (
        REPO_ROOT / "caltrans-whatif" / "server" / "scenario" / "contract.ts"
    ).read_text()

    for query in ("scenario_time_matrix", "scenario_kpis"):
        block = generated.split(f"{query}: {{", 1)[1].split("result: Array<{", 1)[1]
        columns = re.findall(r"^\s{10}(\w+)[?]?:", block[: block.index("\n        }>")], re.M)
        assert columns, f"no result columns found for {query} in analytics.d.ts"
        for column in columns:
            assert re.search(rf"^\s*{column}[?]?:", contract, re.M), (
                f"{query} returns column `{column}` but contract.ts does not declare it"
            )
