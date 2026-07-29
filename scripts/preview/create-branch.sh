#!/usr/bin/env bash
# Create (or reuse) the Lakebase branch backing PR N's preview.
#
#   scripts/preview/create-branch.sh <pr-number>
#
# Idempotent, because it has to be: `pull_request: synchronize` fires on EVERY push to the PR,
# so this runs many times per PR and must reuse the branch it made the first time.
#
# Prints the branch resource path on stdout as the last line, so callers can capture it.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
source scripts/preview/lib.sh

require_cmd databricks jq
PR="${1:-}"; require_pr_number "$PR"

BRANCH_ID="$(preview_branch_id "$PR")"
BRANCH_PATH="$(preview_branch_path "$PR")"
SOURCE_PATH="$(source_branch_path)"

STATE="$(preview_branch_state "$BRANCH_PATH")"

case "$STATE" in
  READY)
    # The common case on `synchronize`. Reuse it as-is.
    #
    # Deliberately NOT refreshing the TTL here. A push extending the expiry sounds friendly but
    # means an abandoned-then-force-pushed PR can outlive the backstop indefinitely, and the
    # backstop is the only thing standing between a failed teardown and a branch that bills
    # forever. 7 days from creation is the guarantee; if a PR outlives it, re-open/re-push
    # recreates the branch from production, which for a preview is the correct outcome anyway.
    printf '::notice::Reusing existing Lakebase branch %s (state=READY)\n' "$BRANCH_PATH"
    printf '%s\n' "$BRANCH_PATH"
    exit 0
    ;;
  ABSENT)
    : # fall through to create
    ;;
  INIT|IMPORTING|RESETTING)
    # A concurrent run is mid-create. `concurrency:` in preview-up.yml should prevent this, but
    # cancel-in-progress can leave a create in flight. Wait for it rather than racing it.
    printf '::notice::Branch %s is %s; waiting for it to become READY\n' "$BRANCH_PATH" "$STATE"
    for _ in $(seq 1 60); do
      sleep 10
      STATE="$(preview_branch_state "$BRANCH_PATH")"
      [[ "$STATE" == "READY" ]] && break
    done
    if [[ "$STATE" != "READY" ]]; then
      printf '::error::Branch %s stuck in state %s after 10m\n' "$BRANCH_PATH" "$STATE" >&2
      exit 1
    fi
    printf '%s\n' "$BRANCH_PATH"
    exit 0
    ;;
  ARCHIVED|DELETED)
    # The name is occupied by a tombstone/archive, so a plain create would fail. Don't try to
    # resurrect it: a preview branch has no state worth recovering, and `undelete` semantics
    # here are unverified. Purge the corpse and fork a fresh one from production.
    printf '::warning::Branch %s exists in state %s; purging and recreating\n' "$BRANCH_PATH" "$STATE"
    databricks postgres delete-branch "$BRANCH_PATH" --purge
    ;;
  *)
    printf '::error::Branch %s in unexpected state %q; refusing to guess\n' "$BRANCH_PATH" "$STATE" >&2
    exit 1
    ;;
esac

printf '::notice::Creating Lakebase branch %s from %s (ttl=%ss)\n' \
  "$BRANCH_PATH" "$SOURCE_PATH" "$PREVIEW_BRANCH_TTL_SECONDS"

# Copy-on-write fork of `production`. Lakebase branches are COW by construction — naming a
# `source_branch` is what makes this cheap; there is no bulk copy and no flag to ask for one.
#
# `ttl` and `no_expiry` are mutually exclusive; we want the TTL, so no_expiry is omitted
# entirely rather than set false.
#
# --replace-existing is NOT used. Its documented behaviour is "update the branch if it already
# exists", which does not state whether an existing branch's data is preserved or re-forked, and
# the state machine above already handles every existing-branch case explicitly. Preferring the
# explicit path keeps "reuse" and "recreate" from collapsing into one ambiguous flag.
databricks postgres create-branch "projects/${LAKEBASE_PROJECT}" "$BRANCH_ID" \
  --json "$(jq -nc \
      --arg src "$SOURCE_PATH" \
      --arg ttl "${PREVIEW_BRANCH_TTL_SECONDS}s" \
      '{spec: {source_branch: $src, ttl: $ttl}}')"

STATE="$(preview_branch_state "$BRANCH_PATH")"
if [[ "$STATE" != "READY" ]]; then
  printf '::error::Branch %s created but state is %s, expected READY\n' "$BRANCH_PATH" "$STATE" >&2
  exit 1
fi

printf '::notice::Branch %s is READY\n' "$BRANCH_PATH"
printf '%s\n' "$BRANCH_PATH"
