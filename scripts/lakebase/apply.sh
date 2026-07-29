#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/lakebase/apply.sh schema [options]
  scripts/lakebase/apply.sh grants [options]
  scripts/lakebase/apply.sh verify [options]

Applies Lakebase SQL with the confirmed direct-host + generated OAuth credential
recipe. The schema mode applies 001_schema.sql and 002_schema_advisor.sql in one
transaction. The grants mode applies 003_grants_advisor.sql after the app bundle
has been deployed, because that deploy provisions the app service principal's
Postgres role. The verify mode asserts the app service principal can INSERT into
app.advisor_sessions -- the same privilege GET /api/advisor/health reports as
"canWriteSessions" -- and exits non-zero if it cannot.

Modes:
  schema    Apply 001_schema.sql + 002_schema_advisor.sql (--single-transaction).
  grants    Apply 003_grants_advisor.sql, passing -v sp_role=<--sp-role>.
  verify    Assert has_table_privilege(<sp_role>, 'app.advisor_sessions', 'INSERT').

Options:
  --project PROJECT       Lakebase project ID (default: caltrans-app)
  --branch BRANCH         Lakebase branch ID (default: production)
  --endpoint ENDPOINT     Lakebase endpoint ID (default: primary)
  --pg-user USER          Postgres role to connect as (default: thomas.seufert@databricks.com)
  --sp-role ROLE          App service principal Postgres role for grants mode
                          (default: production app UUID)
  --ttl DURATION          Credential TTL passed to Databricks CLI as a protobuf
                          duration, i.e. seconds with an "s" suffix (default: 1200s)
  --sql-dir DIR           Directory containing numbered SQL files (default: lakebase)
  -h, --help              Show this help

Environment overrides:
  LAKEBASE_PROJECT, LAKEBASE_BRANCH, LAKEBASE_ENDPOINT, PGUSER,
  LAKEBASE_SP_ROLE, LAKEBASE_CREDENTIAL_TTL, LAKEBASE_SQL_DIR
USAGE
}

MODE="${1:-}"
if [[ -z "$MODE" || "$MODE" == "-h" || "$MODE" == "--help" ]]; then
  usage
  exit 0
fi
shift

PROJECT="${LAKEBASE_PROJECT:-caltrans-app}"
BRANCH="${LAKEBASE_BRANCH:-production}"
ENDPOINT="${LAKEBASE_ENDPOINT:-primary}"
PGUSER_VALUE="${PGUSER:-thomas.seufert@databricks.com}"
SP_ROLE="${LAKEBASE_SP_ROLE:-4a27f46d-04b9-4580-9767-44b505a4cf50}"
# Protobuf Duration JSON encoding: seconds with an "s" suffix ("1200s" = 20 min).
# Bare Go-style durations like "20m" are not the documented encoding for this field.
TTL="${LAKEBASE_CREDENTIAL_TTL:-1200s}"
SQL_DIR="${LAKEBASE_SQL_DIR:-lakebase}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      PROJECT="$2"
      shift 2
      ;;
    --branch)
      BRANCH="$2"
      shift 2
      ;;
    --endpoint)
      ENDPOINT="$2"
      shift 2
      ;;
    --pg-user)
      PGUSER_VALUE="$2"
      shift 2
      ;;
    --sp-role)
      SP_ROLE="$2"
      shift 2
      ;;
    --ttl)
      TTL="$2"
      shift 2
      ;;
    --sql-dir)
      SQL_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "$MODE" in
  schema|grants|verify) ;;
  *)
    echo "Unknown mode: $MODE" >&2
    usage >&2
    exit 2
    ;;
esac

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 127
  fi
}

json_field() {
  local expr="$1"
  python3 -c "import json,sys; data=json.load(sys.stdin); print($expr)"
}

require_cmd databricks
require_cmd psql
require_cmd python3

ENDPOINT_PATH="projects/${PROJECT}/branches/${BRANCH}/endpoints/${ENDPOINT}"

HOST="$(databricks postgres get-endpoint "$ENDPOINT_PATH" -o json \
  | json_field "data['status']['hosts']['host']")"
TOKEN="$(databricks postgres generate-database-credential "$ENDPOINT_PATH" --ttl "$TTL" -o json \
  | json_field "data['token']")"

PSQL_URI="host=${HOST} port=5432 dbname=databricks_postgres user=${PGUSER_VALUE} sslmode=require"

case "$MODE" in
  schema)
    mapfile -t FILES < <(find "$SQL_DIR" -maxdepth 1 -type f \
      \( -name '001_*.sql' -o -name '002_*.sql' \) | sort)
    if [[ "${#FILES[@]}" -ne 2 ]]; then
      echo "Expected exactly 2 schema SQL files under ${SQL_DIR}, found ${#FILES[@]}" >&2
      printf '  %s\n' "${FILES[@]}" >&2
      exit 1
    fi
    PSQL_ARGS=(--single-transaction -v ON_ERROR_STOP=1)
    for file in "${FILES[@]}"; do
      PSQL_ARGS+=(-f "$file")
    done
    PGPASSWORD="$TOKEN" psql "$PSQL_URI" "${PSQL_ARGS[@]}"
    ;;
  grants)
    GRANTS_FILE="${SQL_DIR}/003_grants_advisor.sql"
    if [[ ! -f "$GRANTS_FILE" ]]; then
      echo "Missing grants SQL file: ${GRANTS_FILE}" >&2
      exit 1
    fi
    PGPASSWORD="$TOKEN" psql "$PSQL_URI" \
      -v ON_ERROR_STOP=1 \
      -v sp_role="$SP_ROLE" \
      -f "$GRANTS_FILE"
    ;;
  verify)
    # Ask Postgres directly rather than curl-ing GET /api/advisor/health: the app's
    # public URL is OAuth-gated by the Apps platform and returns 401 to both an
    # unauthenticated request and a PAT bearer token, so CI cannot read that route.
    # has_table_privilege() against the SP role is the exact check the health route
    # performs for "canWriteSessions".
    can_write="$(printf "%s\n" \
      "SELECT has_table_privilege(:'sp_role', 'app.advisor_sessions', 'INSERT');" \
      | PGPASSWORD="$TOKEN" psql "$PSQL_URI" \
          -X -qtA -v ON_ERROR_STOP=1 -v sp_role="$SP_ROLE" -f - \
      | tr -d '[:space:]')"
    if [[ "$can_write" == "t" ]]; then
      echo "canWriteSessions=true for ${SP_ROLE} (app.advisor_sessions INSERT granted)"
    else
      echo "canWriteSessions=false for ${SP_ROLE}: the app service principal cannot" >&2
      echo "INSERT into app.advisor_sessions. Re-check that 'apply.sh grants' ran AFTER" >&2
      echo "'databricks bundle deploy'. psql returned: '${can_write}'" >&2
      exit 1
    fi
    ;;
esac
