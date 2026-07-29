#!/usr/bin/env bash
# Apply the Lakebase `app`-schema grants for a preview app's OWN service principal.
#
#   scripts/preview/apply-lakebase-grants.sh <endpoint-path> <sp-client-id>
#
# ── WHY A PREVIEW NEEDS THIS AT ALL ──────────────────────────────────────────────────────
# The preview branch is a copy-on-write fork of `production`, so it inherits production's
# grants — and those name the PRODUCTION app's service principal UUID. Databricks provisions a
# DISTINCT service principal per app, so the preview app's SP appears nowhere in the inherited
# ACLs. `CAN_CONNECT_AND_CREATE` on the postgres resource lets it connect and create its own
# objects, but grants it nothing on the pre-existing `app` schema, which a human owns.
#
# Without this step the preview app fails on its FIRST advisor write with
# `permission denied for schema app` (SQLSTATE 42501) — at runtime, in the deployed app only.
# Local dev runs as the schema owner and cannot reproduce it.
#
# ── DELEGATION ───────────────────────────────────────────────────────────────────────────
# The grant SQL is NOT duplicated here. `lakebase/grants_advisor.sql` and the applier
# `scripts/lakebase/apply.sh` are owned by the main-deploy workflow; this script only calls
# that applier with a per-preview endpoint and SP. Copying the SQL would mean two definitions
# of "what the app is allowed to do" drifting apart, and the preview copy would be the stale one.
#
# CONTRACT this depends on (provided by the main-deploy change; see the dependency note in the
# PR body):
#   scripts/lakebase/apply.sh --grants-only --endpoint <path> --sp-role <uuid>
# and `lakebase/grants_advisor.sql` taking the SP via `psql -v sp_role=` instead of the
# hardcoded UUID it has today. If that has not landed, this script fails with a clear message
# rather than a confusing psql error.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
source scripts/preview/lib.sh

ENDPOINT="${1:-}"
SP="${2:-}"
if [[ -z "$ENDPOINT" || -z "$SP" ]]; then
  printf 'usage: %s <endpoint-path> <sp-client-id>\n' "$0" >&2
  exit 1
fi

APPLY=scripts/lakebase/apply.sh

if [[ ! -x "$APPLY" ]]; then
  cat >&2 <<EOF
::error::$APPLY not found or not executable.

This preview workflow depends on the main-deploy change that adds the shared Lakebase applier
and parameterizes lakebase/grants_advisor.sql to accept \`psql -v sp_role=\`. Land that PR first.

Without it the preview app will deploy and start, but every advisor write will fail with
\`permission denied for schema app\` (42501) at runtime.

Needed:
  $APPLY --grants-only --endpoint <endpoint-path> --sp-role <uuid>
EOF
  exit 1
fi

printf '::notice::Applying Lakebase grants on %s for SP %s\n' "$ENDPOINT" "$SP"

# PGUSER is the human who owns the `app` schema. grants_advisor.sql must run as the schema OWNER
# (or a superuser) — the app SP cannot grant itself privileges on a schema it does not own. The
# PAT in CI belongs to that same human, who is also in DATABRICKS_SUPERUSER, so the OAuth
# credential minted from it maps to the owning Postgres role.
#
# One consequence worth knowing: ALTER DEFAULT PRIVILEGES inside grants_advisor.sql applies to
# objects created by the role that RUNS it. Keeping this as the human owner is what makes those
# default privileges cover future tables; running it as some other role would silently narrow them.
: "${PGUSER:=thomas.seufert@databricks.com}"

PGUSER="$PGUSER" "$APPLY" --grants-only --endpoint "$ENDPOINT" --sp-role "$SP"

printf '::notice::Lakebase grants applied for %s\n' "$SP"
