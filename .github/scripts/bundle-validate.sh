#!/usr/bin/env bash
# Run `databricks bundle validate` in a bundle directory, tolerating the absence
# of workspace credentials so the gate passes on pull requests from forks.
#
# `bundle validate` does all of its local work first — YAML parsing, schema
# validation, variable and target resolution — and only then contacts the
# workspace to resolve the current user. On a fork runner there are no
# credentials, so it fails at that last step with an auth error even though the
# bundle itself is valid.
#
# We must not simply grep for "an auth error appears somewhere in the output",
# because the auth error is always present on a fork and would mask a genuine
# problem reported alongside it. Instead: drop the auth error lines, and fail if
# ANY other `Error:` line remains.
set -uo pipefail

BUNDLE_DIR="${1:?usage: bundle-validate.sh <bundle-dir>}"

cd "$BUNDLE_DIR"

output=$(databricks bundle validate 2>&1)
status=$?
printf '%s\n' "$output"

if [ "$status" -eq 0 ]; then
  exit 0
fi

# Auth-resolution failures observed from CLI v1.7.0 when no credentials are
# present (with only DATABRICKS_HOST set, or with no configuration at all).
auth_re='cannot configure default credentials|cannot resolve bundle auth configuration|Credential was not sent|401 Unauthorized'

# Every error line the CLI emitted...
errors=$(printf '%s\n' "$output" | grep -E '^Error:' || true)
# ...minus the ones that are purely about missing credentials.
other_errors=$(printf '%s\n' "$errors" | grep -Ev "$auth_re" | grep -E '^Error:' || true)

if [ -n "$other_errors" ]; then
  echo "::error title=bundle validate::Bundle validation reported errors unrelated to missing credentials."
  printf '%s\n' "$other_errors"
  exit "$status"
fi

if [ -n "$errors" ]; then
  echo "::notice title=bundle validate::Bundle parsed and validated; stopped at workspace auth resolution, which fork-safe CI intentionally has no credentials for."
  exit 0
fi

# Non-zero exit with no recognizable `Error:` line — do not guess, fail loudly.
exit "$status"
