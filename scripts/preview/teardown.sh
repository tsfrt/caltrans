#!/usr/bin/env bash
# Destroy PR N's preview app and delete its Lakebase branch.
#
#   scripts/preview/teardown.sh <pr-number>
#
# Runs on `pull_request: closed`, which fires on BOTH merge and plain close — there is no
# separate "merged" event, so this one path must handle both.
#
# TWO PROPERTIES THIS SCRIPT MUST HAVE:
#
# 1. IDEMPOTENT AND NON-FAILING WHEN THERE IS NOTHING TO DO. A PR can close without a preview
#    ever existing (preview-up failed, or was never triggered), and teardown can be re-run. A
#    teardown that exits non-zero on "already gone" trains people to ignore red X's on closed
#    PRs, which is how a real leak gets missed. Each phase is therefore best-effort and reports
#    what it did; only an unexpected failure with resources still present is fatal.
#
# 2. IT MUST NEVER TOUCH PRODUCTION. Two specific hazards, both handled explicitly below:
#      - `databricks apps delete` with NO name argument, run inside caltrans-whatif/, means
#        "destroy all resources deployed by this project" — i.e. production. Always pass a name.
#      - `bundle destroy` acts on whatever state root the target+vars resolve to. Deploying or
#        destroying the `default` target would resolve production's state root. We always pass
#        -t preview AND assert the resolved app name/state root are PR-scoped before destroying.
#
# Teardown is a COST requirement, not hygiene: an idle Lakebase branch floors at ~0.5 CU with a
# 24h suspend timeout that cannot be lowered, and a project allows only 10 unarchived branches.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO_ROOT="$PWD"
source scripts/preview/lib.sh

require_cmd databricks jq
PR="${1:-}"; require_pr_number "$PR"

APP_NAME="$(preview_app_name "$PR")"
BRANCH_PATH="$(preview_branch_path "$PR")"
read_bundle_vars BUNDLE_VARS "$PR"

# Refuse to proceed if the derived names somehow collide with production. These can only fire if
# lib.sh is edited wrongly, which is exactly when a guard earns its keep.
if [[ "$APP_NAME" == "caltrans-whatif" ]]; then
  printf '::error::refusing to tear down %q — that is the PRODUCTION app\n' "$APP_NAME" >&2
  exit 1
fi
if [[ "$BRANCH_PATH" == "$(source_branch_path)" ]]; then
  printf '::error::refusing to delete %q — that is the PRODUCTION branch\n' "$BRANCH_PATH" >&2
  exit 1
fi

failures=0

# ── Phase 1: the app ────────────────────────────────────────────────────────────────────
if app_exists "$APP_NAME"; then
  printf '::notice::Destroying preview app %s\n' "$APP_NAME"

  # Prefer `bundle destroy`: it removes the app AND the synced source files and deployment state
  # under this preview's root path. A bare `apps delete` would orphan that workspace directory.
  #
  # Assert the resolution first. `bundle destroy` has no dry-run, so `bundle validate` with the
  # same target+vars is the only chance to see what it is about to act on.
  pushd "$REPO_ROOT/caltrans-whatif" >/dev/null
  if RESOLVED="$(databricks bundle validate -t "$PREVIEW_BUNDLE_TARGET" "${BUNDLE_VARS[@]}" -o json 2>/dev/null)"; then
    R_APP="$(jq -r '.resources.apps.app.name' <<<"$RESOLVED")"
    R_ROOT="$(jq -r '.workspace.root_path' <<<"$RESOLVED")"
    if [[ "$R_APP" != "$APP_NAME" ]]; then
      printf '::error::resolved app name %q != %q; refusing to destroy\n' "$R_APP" "$APP_NAME" >&2
      failures=1
    elif [[ "$R_ROOT" != *"/preview/$APP_NAME" ]]; then
      printf '::error::resolved state root %q is not preview-scoped; refusing to destroy\n' "$R_ROOT" >&2
      failures=1
    else
      printf '  state root: %s\n' "$R_ROOT"
      if ! databricks bundle destroy -t "$PREVIEW_BUNDLE_TARGET" "${BUNDLE_VARS[@]}" --auto-approve; then
        # Fall back to deleting just the app by explicit name. Leaves the workspace files behind,
        # but an orphaned directory costs nothing while a running app costs compute.
        printf '::warning::bundle destroy failed for %s; falling back to apps delete\n' "$APP_NAME"
        if ! databricks apps delete "$APP_NAME"; then
          printf '::error::could not delete app %s\n' "$APP_NAME" >&2
          failures=1
        fi
      fi
    fi
  else
    printf '::warning::bundle validate failed; deleting app %s by name only\n' "$APP_NAME"
    if ! databricks apps delete "$APP_NAME"; then
      printf '::error::could not delete app %s\n' "$APP_NAME" >&2
      failures=1
    fi
  fi
  popd >/dev/null

  if app_exists "$APP_NAME"; then
    printf '::error::app %s still exists after teardown\n' "$APP_NAME" >&2
    failures=1
  else
    printf '::notice::App %s deleted\n' "$APP_NAME"
  fi
else
  printf '::notice::App %s does not exist; nothing to delete\n' "$APP_NAME"
fi

# ── Phase 2: the Lakebase branch ────────────────────────────────────────────────────────
# Deliberately AFTER the app: deleting the branch out from under a running app would leave it
# up with a dangling postgres resource.
STATE="$(preview_branch_state "$BRANCH_PATH")"
case "$STATE" in
  ABSENT)
    printf '::notice::Branch %s does not exist; nothing to delete\n' "$BRANCH_PATH"
    ;;
  *)
    printf '::notice::Deleting Lakebase branch %s (state=%s)\n' "$BRANCH_PATH" "$STATE"
    # --purge: hard delete. A soft-deleted branch still occupies its name and counts toward the
    # 10-unarchived-branch ceiling, so a soft delete would not actually reclaim anything — and it
    # would block a re-opened PR from recreating the same branch id.
    if ! databricks postgres delete-branch "$BRANCH_PATH" --purge; then
      # Re-check rather than trusting the exit code: a concurrent teardown or an expired TTL may
      # have removed it already, which is success as far as this workflow is concerned.
      if [[ "$(preview_branch_state "$BRANCH_PATH")" == "ABSENT" ]]; then
        printf '::notice::Branch %s already gone\n' "$BRANCH_PATH"
      else
        printf '::error::could not delete branch %s\n' "$BRANCH_PATH" >&2
        failures=1
      fi
    else
      printf '::notice::Branch %s purged\n' "$BRANCH_PATH"
    fi
    ;;
esac

# ── Report remaining branch budget ──────────────────────────────────────────────────────
# Surfaced on every teardown because the 10-unarchived-branch ceiling is a hard limit whose
# breach otherwise shows up as a confusing create-branch failure on some unrelated future PR.
if COUNT="$(databricks postgres list-branches "projects/${LAKEBASE_PROJECT}" -o json 2>/dev/null \
            | jq '[.[] | select(.status.current_state != "ARCHIVED" and .status.current_state != "DELETED")] | length')"; then
  printf '::notice::%s now has %s unarchived branch(es) of 10 max\n' "$LAKEBASE_PROJECT" "$COUNT"
fi

exit "$failures"
