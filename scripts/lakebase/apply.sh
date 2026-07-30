#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/lakebase/apply.sh schema [options]
  scripts/lakebase/apply.sh grants [options]
  scripts/lakebase/apply.sh verify [options]

Applies Lakebase SQL with the confirmed direct-host + generated OAuth credential
recipe. The schema mode applies every NNN_*.sql except the grants files, in
numeric order, in one transaction -- so a newly added migration is picked up
automatically. The grants mode applies 003_grants_advisor.sql after the app bundle
has been deployed, because that deploy provisions the app service principal's
Postgres role. The verify mode asserts the app service principal can INSERT into
app.advisor_sessions -- the same privilege GET /api/advisor/health reports as
"canWriteSessions" -- and exits non-zero if it cannot.

Modes:
  schema    Apply every NNN_*.sql except *_grants_*, in numeric order
            (--single-transaction).
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

# Guard every value-taking option. Without this, `--sp-role` with no value expanded `$2`
# under `set -u` and died with a bare `line NN: $2: unbound variable` instead of the usage
# path -- unreadable in a CI log. Also rejects a following flag (`--sp-role --ttl 60s`),
# which would otherwise silently consume the next option as the value.
require_value() {
  if [[ $# -lt 2 || -z "$2" || "$2" == -* ]]; then
    echo "Option $1 requires a value" >&2
    usage >&2
    exit 2
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project)
      require_value "$@"
      PROJECT="$2"
      shift 2
      ;;
    --branch)
      require_value "$@"
      BRANCH="$2"
      shift 2
      ;;
    --endpoint)
      require_value "$@"
      ENDPOINT="$2"
      shift 2
      ;;
    --pg-user)
      require_value "$@"
      PGUSER_VALUE="$2"
      shift 2
      ;;
    --sp-role)
      require_value "$@"
      SP_ROLE="$2"
      shift 2
      ;;
    --ttl)
      require_value "$@"
      TTL="$2"
      shift 2
      ;;
    --sql-dir)
      require_value "$@"
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
    # ── WHICH FILES ──────────────────────────────────────────────────────────────────
    # Every NNN_*.sql except the grants files, which run separately as the schema owner
    # with -v sp_role (see the `grants` mode below).
    #
    # Deliberately a glob rather than an enumerated list: this used to match only 001_* and
    # 002_* and assert a count of exactly 2, which meant adding a migration silently SKIPPED
    # it here -- the app then deployed against a database missing the new columns and failed
    # at runtime, in the deployed app only. That is the same failure class
    # 003_grants_advisor.sql was written to document. A glob cannot fall behind the directory.
    #
    # `sort` orders by the numeric prefix, so migrations still apply in sequence (001 before
    # 002 before 004), and psql's --single-transaction below makes the batch atomic. The
    # deployment order `schema -> bundle deploy -> grants` is unchanged: grants is a separate
    # mode, and `-not -name '*_grants_*'` is what keeps it out of this batch.
    #
    # ── WHY NOT mapfile ──────────────────────────────────────────────────────────────
    # `mapfile`/`readarray` is a bash 4 BUILTIN and this script runs on the self-hosted macOS
    # runner, where /bin/bash is 3.2.57 (Apple ships the last GPLv2 release and will not
    # update it). There `mapfile` is a "command not found", which under `set -euo pipefail`
    # aborts immediately -- and deploy-main.yml calls this in `schema` mode, so PRODUCTION
    # SCHEMA MIGRATION could not run at all. scripts/preview/lib.sh:97 (read_bundle_vars)
    # fixed the identical construct for the same reason.
    #
    # IFS= and -r keep each path verbatim; the `|| [[ -n "$line" ]]` guard is the standard
    # handling for a final line with no trailing newline. FILES is reset first so a
    # re-invocation cannot append to a stale array.
    #
    # The body uses `if` rather than `[[ -n "$line" ]] && FILES+=(...)`: as the LAST command
    # in the loop body, a failing `&&` list is the body's exit status, which `set -e` would
    # treat as a fatal error on an empty line.
    FILES=()
    while IFS= read -r line || [[ -n "$line" ]]; do
      if [[ -n "$line" ]]; then
        FILES+=("$line")
      fi
    done < <(find "$SQL_DIR" -maxdepth 1 -type f \
      -name '[0-9][0-9][0-9]_*.sql' -not -name '*_grants_*' | sort)
    if [[ "${#FILES[@]}" -eq 0 ]]; then
      # No file list to print here: bash 3.2 treats "${FILES[@]}" on an EMPTY array as an
      # unbound variable under `set -u` (fixed upstream in 4.4), and zero matches is exactly
      # when this branch runs.
      echo "No NNN_*.sql schema files found under ${SQL_DIR}" >&2
      exit 1
    fi
    echo "Applying ${#FILES[@]} schema migration(s):" >&2
    printf '  %s\n' "${FILES[@]}" >&2
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
    #
    # The query is fed on stdin via `-f -` rather than `-c` because `psql -c` does not
    # perform `:'sp_role'` variable interpolation -- it sends the string to the server
    # verbatim, which fails with `syntax error at or near ":"`.
    psql_stderr="$(mktemp)"
    trap 'rm -f "$psql_stderr"' EXIT

    # `set -e` must NOT fire on a psql failure here. The most likely real-world failure is
    # `role "<uuid>" does not exist` -- the app bundle was never deployed, so Databricks
    # never provisioned the SP's Postgres role. Under `set -euo pipefail` that made psql's
    # bare exit 3 kill the script before the diagnostic below could run, so an operator saw
    # a raw psql error that reads like transient CI flake instead of "production grants are
    # broken". `if ! var=$(...)` suspends errexit for just this substitution; the rest of
    # the script keeps `set -euo pipefail`.
    if ! can_write_raw="$(printf "%s\n" \
          "SELECT has_table_privilege(:'sp_role', 'app.advisor_sessions', 'INSERT');" \
          | PGPASSWORD="$TOKEN" psql "$PSQL_URI" \
              -X -qtA -v ON_ERROR_STOP=1 -v sp_role="$SP_ROLE" -f - 2>"$psql_stderr")"; then
      echo "::error::canWriteSessions could not be determined for ${SP_ROLE} -- the" \
           "privilege query itself failed." >&2
      echo "If psql reports 'role \"${SP_ROLE}\" does not exist', the app service" >&2
      echo "principal has no Postgres role yet: 'databricks bundle deploy' must run" >&2
      echo "(and provision the role) BEFORE 'apply.sh grants' and this check." >&2
      echo "psql said:" >&2
      sed 's/^/  /' "$psql_stderr" >&2
      exit 1
    fi

    can_write="$(printf '%s' "$can_write_raw" | tr -d '[:space:]')"
    if [[ "$can_write" == "t" ]]; then
      echo "canWriteSessions=true for ${SP_ROLE} (app.advisor_sessions INSERT granted)"
    else
      echo "::error::canWriteSessions is false for ${SP_ROLE} -- grants did not apply." >&2
      echo "The app service principal cannot INSERT into app.advisor_sessions." >&2
      echo "Re-check that 'apply.sh grants' ran AFTER 'databricks bundle deploy'." >&2
      echo "psql returned: '${can_write}'" >&2
      exit 1
    fi
    ;;
esac
