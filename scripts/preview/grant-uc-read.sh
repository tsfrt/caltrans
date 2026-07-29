#!/usr/bin/env bash
# Grant a preview app's service principal READ-ONLY access to the shared traffic tables.
#
#   scripts/preview/grant-uc-read.sh <sp-client-id>
#
# Previews deliberately SHARE production's Unity Catalog data rather than getting their own copy.
# That is safe because the app only ever reads it — every reference to lanl.caltrans_traffic in
# the app is a FROM clause, and no code path issues DDL or DML against UC. Only the separate
# synthetic-traffic pipeline bundle writes there. It is also the only practical option: the
# tables are millions of rows and the catalog/schema names are baked into .sql text and TS
# string literals that DAB variables cannot reach.
#
# So the grants below are exactly USE SCHEMA + SELECT, and nothing wider.
#
# TIMING: this must run AFTER `bundle deploy` (the SP does not exist before the app resource
# does) and BEFORE `apps deploy` (whose build runs `appkit generate-types`, issuing
# DESCRIBE QUERY as this SP; it is fatal, so a missing grant fails the BUILD with
# "N queries could not be described" rather than surfacing as a runtime data error).
#
# Idempotent: GRANT of an already-held privilege is a no-op in Unity Catalog.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
source scripts/preview/lib.sh

require_cmd databricks jq

SP="${1:-}"
if [[ -z "$SP" ]]; then
  printf 'usage: %s <sp-client-id>\n' "$0" >&2
  exit 1
fi
# The SP client id is interpolated into a SQL identifier below, so constrain it to the UUID
# shape `apps get` returns. This is the only user-controlled value reaching the statement.
if [[ ! "$SP" =~ ^[0-9a-fA-F-]{36}$ ]]; then
  printf 'error: service principal client id %q is not a UUID\n' "$SP" >&2
  exit 1
fi

# Warehouse used only to execute the GRANT statements. Read from the bundle so it cannot drift
# from the warehouse the app itself is bound to. deploy.sh passes it in via the environment,
# having already resolved it; the fallback exists so this script is runnable standalone.
: "${UC_SCHEMA:=lanl.caltrans_traffic}"
: "${GRANT_WAREHOUSE_ID:=}"
if [[ -z "$GRANT_WAREHOUSE_ID" ]]; then
  # NOTE the subshell + cd: `bundle validate` resolves whichever bundle owns the CWD, and this
  # repo has TWO bundle roots. Run from the repo root it would resolve `caltrans-synthetic-traffic`
  # (the pipeline), which declares no apps and no `preview` target — yielding a null warehouse id.
  GRANT_WAREHOUSE_ID="$(cd caltrans-whatif && databricks bundle validate -t "$PREVIEW_BUNDLE_TARGET" -o json 2>/dev/null \
    | jq -r '.resources.apps.app.resources[]? | select(.name=="sql-warehouse") | .sql_warehouse.id')"
fi
if [[ -z "$GRANT_WAREHOUSE_ID" || "$GRANT_WAREHOUSE_ID" == "null" ]]; then
  printf 'error: could not resolve a SQL warehouse id to run GRANTs on\n' >&2
  exit 1
fi

run_sql() {
  local stmt="$1" resp state
  resp="$(databricks api post /api/2.0/sql/statements \
    --json "$(jq -nc --arg w "$GRANT_WAREHOUSE_ID" --arg s "$stmt" \
                '{warehouse_id: $w, statement: $s, wait_timeout: "50s"}')" -o json)"
  state="$(jq -r '.status.state // "UNKNOWN"' <<<"$resp")"
  if [[ "$state" != "SUCCEEDED" ]]; then
    printf '::error::GRANT failed (%s): %s\n' "$state" "$(jq -r '.status.error.message // "no message"' <<<"$resp")" >&2
    printf '  statement: %s\n' "$stmt" >&2
    return 1
  fi
  printf '  ok: %s\n' "$stmt"
}

printf '::notice::Granting %s read-only access to %s\n' "$SP" "$UC_SCHEMA"

# Backtick-quote the SP id: it is a UUID, which is not a bare-word-legal SQL identifier.
run_sql "GRANT USE SCHEMA ON SCHEMA ${UC_SCHEMA} TO \`${SP}\`"
run_sql "GRANT SELECT ON SCHEMA ${UC_SCHEMA} TO \`${SP}\`"

# The `lanl` catalog already grants USE CATALOG to `account users`, so no catalog-level grant is
# needed. If that ever changes, the symptom is the same "queries could not be described" build
# failure and the fix is a matching GRANT USE CATALOG here.
