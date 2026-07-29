#!/usr/bin/env bash
# Render the body of the sticky preview PR comment on stdout.
#
#   scripts/preview/comment-body.sh <pr-number> <app-name> <app-url> <sp-client-id>
#
# Separate from the workflow so the wording is reviewable as text and can be eyeballed locally
# without triggering a deploy.
#
# ── ON THE ABSENCE OF A LAKEBASE BRANCH LINK ─────────────────────────────────────────────
# There is deliberately NO clickable link to the branch page. Databricks documents that a branch
# overview page and a Schema diff view exist, but documents no URL, and neither the CLI nor the
# SDK returns any web/console URL for a branch (unlike `apps get`, which does return `.url`).
# Route probing was inconclusive — the console serves a client-side SPA that 303s every unknown
# path to login identically to real ones, so a 303 proves nothing.
#
# A guessed deep link that 404s is worse than no link: it costs the reviewer a click, and once
# one line in an automated comment is wrong the whole comment stops being trusted. So this prints
# the real app URL (read from the API) plus copy-pasteable commands and an explicit click-path.
# If someone establishes the real URL template by hand, add it here with a note that console
# routes are unversioned.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
source scripts/preview/lib.sh

PR="${1:-}"; require_pr_number "$PR"
APP_NAME="${2:?app name required}"
APP_URL="${3:?app url required}"
SP="${4:-unknown}"

BRANCH_PATH="$(preview_branch_path "$PR")"
ENDPOINT_PATH="$(preview_endpoint_path "$PR")"
SOURCE="$LAKEBASE_SOURCE_BRANCH"
TTL_DAYS=$(( PREVIEW_BRANCH_TTL_SECONDS / 86400 ))

cat <<EOF
### 🚦 Preview environment for this PR

| | |
|---|---|
| **App** | ${APP_URL} |
| **App name** | \`${APP_NAME}\` |
| **Lakebase branch** | \`${BRANCH_PATH}\` |
| **Forked from** | \`${SOURCE}\` (copy-on-write) |
| **Service principal** | \`${SP}\` |

The preview has its **own Lakebase branch**, so advisor sessions, messages, recommendations and
audit rows written here do not touch production. It **shares production's Unity Catalog tables
read-only** (\`lanl.caltrans_traffic\`) — the app only ever reads them, so there is nothing for a
preview to corrupt, and nothing to wait for.

> The app sits behind Databricks SSO, so the link asks you to sign in. \`/api/*\` returns 401 to
> non-OIDC clients — you cannot smoke-test it with \`curl\`.

<details>
<summary><b>Inspect the Lakebase branch</b></summary>

\`\`\`bash
# Branch metadata (state, size, source branch, expiry)
databricks postgres get-branch ${BRANCH_PATH}

# Interactive psql against the preview branch
databricks psql ${ENDPOINT_PATH}

# What the app can see
databricks psql ${ENDPOINT_PATH} -- -c '\\dt app.*'
\`\`\`

**Schema diff vs \`${SOURCE}\`:** in the workspace, open the **Lakebase App → Branches →
\`$(preview_branch_id "$PR")\` → Parent branch → Schema diff**.

There is no direct link: Databricks publishes no addressable URL for a branch page, and the diff
is only reachable by clicking through from the branch overview. Note the diff compares **DDL
only, not data**.
</details>

<details>
<summary><b>Lifecycle &amp; cost</b></summary>

- Updated on every push to this PR; the Lakebase branch is **reused**, not recreated, so data you
  create in the preview survives across pushes.
- **Torn down automatically when this PR is closed or merged** — app destroyed, branch purged.
- A **${TTL_DAYS}-day TTL** on the branch is a backstop in case teardown never runs. It is not
  refreshed by pushes.
- Why teardown matters: an idle branch floors at ~0.5 CU with a 24h suspend timeout that cannot be
  lowered, and the project allows only **10 unarchived branches**.
- \`ADVISOR_SELF_URL\` is unset for previews, so the startup SSE self-probe is disabled — a preview
  must not probe (and write diagnostics about) the production app.
</details>
EOF
