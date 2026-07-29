#!/usr/bin/env bash
# Deploy PR N's preview app against PR N's Lakebase branch.
#
#   scripts/preview/deploy.sh <pr-number>
#
# Assumes scripts/preview/create-branch.sh has already run for this PR.
#
# The ORDER of the phases below is load-bearing and is the main reason this is a script rather
# than a sequence of workflow steps. Each phase creates the precondition the next one needs:
#
#   1. bundle deploy      — creates the app resource, which is what provisions its service
#                           principal. Nothing SP-shaped exists before this.
#   2. UC read grants     — the SP needs SELECT on lanl.caltrans_traffic BEFORE step 4, because
#                           step 4's build runs `appkit generate-types`, which issues
#                           DESCRIBE QUERY as the SP and is FATAL. A missing grant fails the
#                           build with "N queries could not be described", not a runtime error.
#   3. Lakebase grants    — the SP needs write access to the `app` schema on the preview branch.
#                           The branch is a COW fork of production, so it inherits grants that
#                           name the PRODUCTION app's SP UUID; those do not cover this app.
#   4. apps deploy        — builds and starts. Only now do steps 2 and 3 exist to support it.
#
# Emits the resolved app name / URL / SP id as GitHub step outputs when GITHUB_OUTPUT is set.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO_ROOT="$PWD"
source scripts/preview/lib.sh

require_cmd databricks jq
PR="${1:-}"; require_pr_number "$PR"

APP_NAME="$(preview_app_name "$PR")"
BRANCH_PATH="$(preview_branch_path "$PR")"
DATABASE_PATH="$(preview_database_path "$PR")"
ENDPOINT_PATH="$(preview_endpoint_path "$PR")"
read_bundle_vars BUNDLE_VARS "$PR"

# The bundle root is the app subdirectory — it is its own bundle, not part of the repo-root one.
cd "$REPO_ROOT/caltrans-whatif"

# ── Preview-only source tweak ────────────────────────────────────────────────────────────
# Must happen before either deploy phase, since app.yaml is read from the synced source tree.
"$REPO_ROOT/scripts/preview/strip-self-url.sh"

# ── Phase 0: prove the overrides resolve before touching anything ────────────────────────
# `bundle validate` is non-mutating and catches the failure mode this whole design exists to
# prevent: a preview whose postgres resource still points at production. Cheap; always run it.
printf '::group::bundle validate (target=%s)\n' "$PREVIEW_BUNDLE_TARGET"
RESOLVED="$(databricks bundle validate -t "$PREVIEW_BUNDLE_TARGET" "${BUNDLE_VARS[@]}" -o json)"
jq '{root_path: .workspace.root_path,
     app_name:  .resources.apps.app.name,
     postgres:  (.resources.apps.app.resources[] | select(.name=="postgres") | .postgres)}' <<<"$RESOLVED"
printf '::endgroup::\n'

# Assert, don't just print. A preview silently wired to production data is the single most
# expensive way this can go wrong, and it is invisible in the deploy log.
RESOLVED_BRANCH="$(jq -r '.resources.apps.app.resources[] | select(.name=="postgres") | .postgres.branch' <<<"$RESOLVED")"
RESOLVED_DB="$(jq -r '.resources.apps.app.resources[] | select(.name=="postgres") | .postgres.database' <<<"$RESOLVED")"
RESOLVED_APP="$(jq -r '.resources.apps.app.name' <<<"$RESOLVED")"
RESOLVED_ROOT="$(jq -r '.workspace.root_path' <<<"$RESOLVED")"

fail=0
[[ "$RESOLVED_APP"    == "$APP_NAME"      ]] || { printf '::error::app name resolved to %q, want %q\n' "$RESOLVED_APP" "$APP_NAME" >&2; fail=1; }
[[ "$RESOLVED_BRANCH" == "$BRANCH_PATH"   ]] || { printf '::error::postgres.branch resolved to %q, want %q\n' "$RESOLVED_BRANCH" "$BRANCH_PATH" >&2; fail=1; }
[[ "$RESOLVED_DB"     == "$DATABASE_PATH" ]] || { printf '::error::postgres.database resolved to %q, want %q\n' "$RESOLVED_DB" "$DATABASE_PATH" >&2; fail=1; }
# The state root must be PR-specific. If it is not, this deploy would adopt another PR's (or
# production's) deployment state and treat that app as removed-from-config, i.e. destroy it.
case "$RESOLVED_ROOT" in
  *"/preview/$APP_NAME") ;;
  *) printf '::error::state root %q is not preview-scoped to %s; refusing to deploy\n' "$RESOLVED_ROOT" "$APP_NAME" >&2; fail=1 ;;
esac
[[ "$fail" -eq 0 ]] || exit 1

# ── Phase 1: create the app + its service principal ─────────────────────────────────────
printf '::group::bundle deploy %s\n' "$APP_NAME"
databricks bundle deploy -t "$PREVIEW_BUNDLE_TARGET" "${BUNDLE_VARS[@]}" --auto-approve
printf '::endgroup::\n'

SP_CLIENT_ID="$(app_sp_client_id "$APP_NAME")"
if [[ -z "$SP_CLIENT_ID" ]]; then
  printf '::error::could not read service_principal_client_id for %s\n' "$APP_NAME" >&2
  exit 1
fi
printf '::notice::%s service principal: %s\n' "$APP_NAME" "$SP_CLIENT_ID"

# ── Phase 2: Unity Catalog read grants for THIS app's SP ────────────────────────────────
# Previews share production's UC tables read-only — every reference to lanl.caltrans_traffic in
# the app is a FROM clause, and the app issues no DDL/DML against UC — so this is SELECT +
# USE SCHEMA and nothing more. Idempotent: re-GRANTing an existing privilege is a no-op.
printf '::group::UC grants for %s\n' "$SP_CLIENT_ID"
GRANT_WAREHOUSE_ID="$(jq -r '.resources.apps.app.resources[] | select(.name=="sql-warehouse") | .sql_warehouse.id' <<<"$RESOLVED")" \
  "$REPO_ROOT/scripts/preview/grant-uc-read.sh" "$SP_CLIENT_ID"
printf '::endgroup::\n'

# ── Phase 3: Lakebase grants on the preview branch ──────────────────────────────────────
# Delegated to the shared applier owned by the main-deploy workflow, so the grant SQL lives in
# exactly one place. See the contract note in scripts/preview/apply-lakebase-grants.sh.
#
# Takes the PR number, not a resource path: the shared applier wants the project/branch/endpoint
# as separate IDs and composes the path itself, so passing the PR number lets lib.sh remain the
# single place any of those names is derived.
printf '::group::Lakebase grants on %s\n' "$BRANCH_PATH"
"$REPO_ROOT/scripts/preview/apply-lakebase-grants.sh" "$PR" "$SP_CLIENT_ID"
printf '::endgroup::\n'

# ── Phase 4: build + start ──────────────────────────────────────────────────────────────
# NOTE the deliberate absence of an APP_NAME argument here, and mind the asymmetry with
# `apps delete` — the two commands read cwd the same way but the safe choice is opposite:
#
#   apps deploy  (no name, in a project dir) => "enhanced pipeline": build, typecheck, lint,
#       sync, then run the app. This is the ONLY form that BUILDS. `dist/` is gitignored and
#       app.yaml starts the app with `node ./dist/server.js`, so a build must happen — passing a
#       name switches to API-direct mode, skips the build, and deploys an app with no server
#       bundle to run. This nameless form is also the documented production path.
#   apps delete  (no name, in a project dir) => "destroy everything this project deployed",
#       i.e. PRODUCTION. There a name is mandatory; see teardown.sh.
#
# Safety here comes from `-t preview` plus the overrides, whose resolution was asserted in
# phase 0 — the same config `bundle validate` just confirmed resolves to this PR's app and to a
# preview-scoped state root.
#
# This is also where the FATAL typegen runs (`prebuild` -> appkit generate-types issues
# DESCRIBE QUERY as the app's SP), which is why phase 2's UC grants had to come first.
printf '::group::apps deploy (target=%s, app=%s)\n' "$PREVIEW_BUNDLE_TARGET" "$APP_NAME"
databricks apps deploy -t "$PREVIEW_BUNDLE_TARGET" "${BUNDLE_VARS[@]}" --auto-approve
printf '::endgroup::\n'

URL="$(app_url "$APP_NAME")"
if [[ -z "$URL" ]]; then
  printf '::error::app %s has no .url; deployment likely did not start\n' "$APP_NAME" >&2
  exit 1
fi

printf '::notice::Preview app %s is at %s\n' "$APP_NAME" "$URL"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  {
    printf 'app_name=%s\n'      "$APP_NAME"
    printf 'app_url=%s\n'       "$URL"
    printf 'sp_client_id=%s\n'  "$SP_CLIENT_ID"
    printf 'branch_path=%s\n'   "$BRANCH_PATH"
    printf 'endpoint_path=%s\n' "$ENDPOINT_PATH"
  } >>"$GITHUB_OUTPUT"
fi
