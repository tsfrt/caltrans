#!/usr/bin/env bash
# Shared naming + helpers for the per-PR preview lifecycle.
#
# Sourced by every other script in this directory. Sourcing this file is what guarantees
# preview-up and preview-down agree on the names of the resources they create and destroy —
# a teardown that computes a name differently from the setup silently leaks a branch and an
# app, and the leak is invisible (nothing errors; the PR just closes and the cost stays).
# So: one derivation, one place.
#
# Everything here is pure string derivation plus read-only Databricks calls. Nothing in this
# file mutates the workspace.

set -euo pipefail

# ── Fixed coordinates ────────────────────────────────────────────────────────────────────
# The Lakebase project and the branch previews fork FROM. Both are stable for this repo;
# they are variables only so the scripts read clearly, not because they are meant to be swapped.
: "${LAKEBASE_PROJECT:=caltrans-app}"
: "${LAKEBASE_SOURCE_BRANCH:=production}"
: "${LAKEBASE_ENDPOINT_ID:=primary}"

# The Postgres database id inside a branch. NOTE the HYPHEN: this repo's database is
# `databricks-postgres`, not the Databricks default `databricks_postgres`. Getting this wrong
# produces a valid-looking resource path that does not resolve.
: "${LAKEBASE_DATABASE_ID:=databricks-postgres}"

# Bundle target dedicated to previews. Deploying previews through the `default` target would
# share production's deployment state root — see caltrans-whatif/databricks.yml.
: "${PREVIEW_BUNDLE_TARGET:=preview}"

# TTL backstop on preview branches, as a Go/protobuf duration string (seconds).
# 7 days. This is a BACKSTOP, not the primary cleanup path: preview-down.yml deletes the
# branch when the PR closes. It exists because that workflow can fail to run at all (a
# force-pushed/deleted branch, a cancelled run, a repo with Actions disabled mid-flight), and
# an orphaned branch is not free — an idle Lakebase branch floors at ~0.5 CU with a 24h
# suspend timeout that cannot be lowered. It also protects the 10-unarchived-branch-per-project
# ceiling, which one abandoned PR per week would reach in well under a quarter.
# Lakebase caps TTL at 30 days; do not raise this past 2592000.
: "${PREVIEW_BRANCH_TTL_SECONDS:=604800}"

# ── Derivations ──────────────────────────────────────────────────────────────────────────

# App name for PR N. Constraint (confirmed via `databricks apps update -h`): lowercase
# alphanumerics and hyphens only, and the workspace enforces uniqueness. The `caltrans-whatif-pr-`
# prefix is 19 chars against a 26-char practical ceiling, so PR numbers up to 7 digits fit.
preview_app_name() { printf 'caltrans-whatif-pr-%s' "$1"; }

# Branch id for PR N. Lakebase requires 1-63 chars, starting with a lowercase letter — hence
# the `pr-` prefix rather than a bare number.
preview_branch_id() { printf 'pr-%s' "$1"; }

preview_branch_path() {
  printf 'projects/%s/branches/%s' "$LAKEBASE_PROJECT" "$(preview_branch_id "$1")"
}

# The database resource path. This is the value that MUST move in lockstep with the branch:
# it is a full path that EMBEDS the branch id, so overriding the bundle's `lakebase_branch`
# while leaving `lakebase_database` at its default points the preview app's postgres resource
# at PRODUCTION data. Deriving both from the same PR number here makes them impossible to skew.
preview_database_path() {
  printf 'projects/%s/branches/%s/databases/%s' \
    "$LAKEBASE_PROJECT" "$(preview_branch_id "$1")" "$LAKEBASE_DATABASE_ID"
}

preview_endpoint_path() {
  printf 'projects/%s/branches/%s/endpoints/%s' \
    "$LAKEBASE_PROJECT" "$(preview_branch_id "$1")" "$LAKEBASE_ENDPOINT_ID"
}

source_branch_path() {
  printf 'projects/%s/branches/%s' "$LAKEBASE_PROJECT" "$LAKEBASE_SOURCE_BRANCH"
}

# The three --var overrides that define a preview, emitted as a single argument list.
# Always pass all three together; see the lockstep note on preview_database_path.
preview_bundle_vars() {
  local pr="$1"
  printf -- '--var\napp_name=%s\n--var\nlakebase_branch=%s\n--var\nlakebase_database=%s\n' \
    "$(preview_app_name "$pr")" "$(preview_branch_path "$pr")" "$(preview_database_path "$pr")"
}

# Read preview_bundle_vars into the named array variable:  read_bundle_vars MYARR 42
#
# This exists instead of the obvious `mapfile -t ARR < <(preview_bundle_vars "$PR")` because
# `mapfile`/`readarray` is a bash 4 builtin and these scripts now run on the self-hosted macOS
# runner, where /bin/bash is 3.2.57 (Apple ships the last GPLv2 release and will not update it).
# There, `mapfile` is a "command not found" — which under `set -e` aborts deploy.sh/teardown.sh
# immediately, before anything useful has run.
#
# The `while read` loop is portable to 3.2. IFS= and -r keep values verbatim, and the
# `[[ -n "$line" ]]` after the loop is the standard guard for a final line with no trailing
# newline (harmless here, since preview_bundle_vars always ends with one).
#
# No value emitted by preview_bundle_vars ever contains whitespace or a glob character — they are
# all `--var` and `key=<derived-name>` strings built from a validated integer — but reading
# line-wise rather than word-splitting keeps that from being a correctness dependency.
read_bundle_vars() {
  local __arrname="$1" pr="$2" line
  # `eval` is how a function assigns to a caller-named array on bash 3.2 (no `local -n`, no
  # `declare -g`). __arrname is a literal identifier at every call site, never user input.
  eval "$__arrname=()"
  while IFS= read -r line || [[ -n "$line" ]]; do
    eval "$__arrname+=(\"\$line\")"
  done < <(preview_bundle_vars "$pr")
}

# ── Guards ───────────────────────────────────────────────────────────────────────────────

# Reject anything that is not a plain positive integer. Every derived name above flows into a
# Databricks resource path and into `--var` strings, so an unvalidated value here is the one
# place this plumbing could be talked into naming (and later DESTROYING) something other than
# the intended preview. GitHub only ever gives us a real PR number, but these scripts are also
# meant to be run by hand during debugging, which is exactly when a typo would land.
require_pr_number() {
  local pr="${1:-}"
  if [[ ! "$pr" =~ ^[1-9][0-9]*$ ]]; then
    printf 'error: PR number must be a positive integer, got %q\n' "$pr" >&2
    return 1
  fi
}

# Fail loudly and early if a dependency is missing, rather than midway through a partially
# created preview.
require_cmd() {
  local missing=0 c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || { printf 'error: %s not found on PATH\n' "$c" >&2; missing=1; }
  done
  return "$missing"
}

# ── Read-only lookups ────────────────────────────────────────────────────────────────────

# True if the branch exists in a state we can reuse. `get-branch` exits non-zero when the
# branch is absent, which is the signal we want for idempotency.
#
# A soft-deleted branch still occupies the name, so treat DELETED as "not reusable" and let
# the caller surface it rather than silently trying to fork from a tombstone.
preview_branch_state() {
  local path="$1" out
  if ! out=$(databricks postgres get-branch "$path" -o json 2>/dev/null); then
    printf 'ABSENT\n'; return 0
  fi
  printf '%s\n' "$(jq -r '.status.current_state // "UNKNOWN"' <<<"$out")"
}

app_exists() { databricks apps get "$1" -o json >/dev/null 2>&1; }

# Read the app's public URL from the API. Never construct this: the
# `<name>-<workspace-id>.<region>.databricksapps.com` shape is an observation, not a documented
# contract, and a URL that is wrong-but-plausible in a PR comment costs more review trust than
# a missing one.
app_url() { databricks apps get "$1" -o json | jq -r '.url // empty'; }

# The app's OWN service principal client id. Databricks provisions a distinct SP per app, so
# this differs for every preview — which is precisely why the production grants inherited by a
# copy-on-write branch do not cover a preview app.
app_sp_client_id() {
  databricks apps get "$1" -o json | jq -r '.service_principal_client_id // empty'
}
