#!/usr/bin/env bash
# Apply the Lakebase `app`-schema grants for a preview app's OWN service principal.
#
#   scripts/preview/apply-lakebase-grants.sh <pr-number> <sp-client-id>
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
# The grant SQL is NOT duplicated here. `lakebase/003_grants_advisor.sql` and the applier
# `scripts/lakebase/apply.sh` are owned by the main-deploy workflow; this script only calls
# that applier with a per-preview branch and SP. Copying the SQL would mean two definitions
# of "what the app is allowed to do" drifting apart, and the preview copy would be the stale one.
#
# CONTRACT this depends on (provided by the main-deploy change; see the dependency note in the
# PR body):
#   scripts/lakebase/apply.sh grants --project <id> --branch <id> --endpoint <id> --sp-role <uuid>
# and `lakebase/003_grants_advisor.sql` taking the SP via `psql -v sp_role=` instead of the
# hardcoded UUID it has today. If that has not landed, this script fails with a clear message
# rather than a confusing psql error.
#
# Note the shape of that call: `grants` is a POSITIONAL mode, not a flag — apply.sh reads
# `MODE="$1"; shift` and its option loop rejects any unrecognized token with exit 2. And
# --project/--branch/--endpoint are each an ID, not a path: apply.sh composes
# `projects/$PROJECT/branches/$BRANCH/endpoints/$ENDPOINT` itself, so handing it a full
# resource path would produce a doubled, non-resolving path.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
source scripts/preview/lib.sh

PR="${1:-}"
SP="${2:-}"
if [[ -z "$PR" || -z "$SP" ]]; then
  printf 'usage: %s <pr-number> <sp-client-id>\n' "$0" >&2
  exit 1
fi
require_pr_number "$PR"

BRANCH_ID="$(preview_branch_id "$PR")"

APPLY=scripts/lakebase/apply.sh

if [[ ! -x "$APPLY" ]]; then
  cat >&2 <<EOF
::error::$APPLY not found or not executable.

This preview workflow depends on the main-deploy change that adds the shared Lakebase applier
and parameterizes lakebase/003_grants_advisor.sql to accept \`psql -v sp_role=\`. Land that PR first.

Without it the preview app will deploy and start, but every advisor write will fail with
\`permission denied for schema app\` (42501) at runtime.

Needed:
  $APPLY grants --project <project-id> --branch <branch-id> --endpoint <endpoint-id> --sp-role <uuid>

For this preview that is:
  $APPLY grants --project $LAKEBASE_PROJECT --branch $BRANCH_ID --endpoint $LAKEBASE_ENDPOINT_ID --sp-role $SP
EOF
  exit 1
fi

printf '::notice::Applying Lakebase grants on %s for SP %s\n' "$(preview_branch_path "$PR")" "$SP"

# PGUSER is the human who owns the `app` schema. 003_grants_advisor.sql must run as the schema
# OWNER (or a superuser) — the app SP cannot grant itself privileges on a schema it does not own.
# The PAT in CI belongs to that same human, who is also in DATABRICKS_SUPERUSER, so the OAuth
# credential minted from it maps to the owning Postgres role. apply.sh reads PGUSER from the
# environment (it also accepts --pg-user), so exporting it here is the documented path.
#
# One consequence worth knowing: ALTER DEFAULT PRIVILEGES inside 003_grants_advisor.sql applies to
# objects created by the role that RUNS it. Keeping this as the human owner is what makes those
# default privileges cover future tables; running it as some other role would silently narrow them.
: "${PGUSER:=thomas.seufert@databricks.com}"

# Pass the branch as an ID, not a path — apply.sh composes the endpoint path from the three
# pieces. Its defaults point at `production`, so --branch is the override that makes this
# preview-scoped; passing --project/--endpoint explicitly keeps this call independent of those
# defaults rather than silently inheriting a change to them.
PGUSER="$PGUSER" "$APPLY" grants \
  --project "$LAKEBASE_PROJECT" \
  --branch "$BRANCH_ID" \
  --endpoint "$LAKEBASE_ENDPOINT_ID" \
  --sp-role "$SP"

printf '::notice::Lakebase grants applied for %s\n' "$SP"
