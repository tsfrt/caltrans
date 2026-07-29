# Per-PR Preview Environments

Every pull request gets its own running app on its own copy-on-write Lakebase branch, and both
are destroyed when the PR closes.

| Artefact | What it is |
|---|---|
| `.github/workflows/preview-up.yml` | `pull_request: opened/synchronize/reopened` → create branch, deploy app, sticky comment |
| `.github/workflows/preview-down.yml` | `pull_request: closed` (merge **or** plain close) → destroy app, purge branch |
| `.github/actions/databricks-setup/` | Pinned CLI + PAT auth + identity check |
| `scripts/preview/lib.sh` | Single source of truth for every derived name |
| `scripts/preview/create-branch.sh` | Idempotent branch create/reuse with TTL backstop |
| `scripts/preview/deploy.sh` | The four-phase deploy; ordering is load-bearing |
| `scripts/preview/grant-uc-read.sh` | `USE SCHEMA` + `SELECT` on the shared traffic tables |
| `scripts/preview/apply-lakebase-grants.sh` | Delegates to `scripts/lakebase/apply.sh` |
| `scripts/preview/strip-self-url.sh` | Disables the self-probe for previews |
| `scripts/preview/comment-body.sh` | The sticky comment text |

Logic lives in the shell scripts, not the YAML, so it is reviewable and runnable by hand.

## Resources per PR

For PR **N**:

| Resource | Name |
|---|---|
| App | `caltrans-whatif-pr-N` |
| Lakebase branch | `projects/caltrans-app/branches/pr-N` |
| Database | `projects/caltrans-app/branches/pr-N/databases/databricks-postgres` |
| Endpoint | `projects/caltrans-app/branches/pr-N/endpoints/primary` |
| Bundle state root | `.../.bundle/caltrans-whatif/preview/caltrans-whatif-pr-N` |

## What is isolated, and what is shared

**Isolated: Lakebase.** Each preview forks `production` copy-on-write, so advisor sessions,
messages, recommendations and audit rows written in a preview never touch production. This is
where the app writes and where schema changes land, so it is where isolation matters.

**Shared read-only: Unity Catalog.** Previews read production's `lanl.caltrans_traffic`. This is
safe because the app never writes UC — all ten references are `FROM` clauses, and only the
separate synthetic-traffic pipeline bundle writes there. It is also the only practical option:
the tables are millions of rows, and the catalog/schema names are embedded in `.sql` text, in
generated SQL, and in a TypeScript template literal, where DAB variables cannot reach.

The preview app's SP is granted exactly `USE SCHEMA` + `SELECT`, nothing wider.

> If a PR ever needs to change the **pipeline's** output schema, this model does not cover it —
> that needs a per-PR catalog, and it should be an explicit opt-in, not the default.

## Why previews need their own bundle target

This is the subtle part, and it is the reason `databricks.yml` has a `preview` target rather than
previews just passing `--var app_name=`.

**One DAB bundle + target = one deployment state root.** Passing `--var app_name=` to the
`default` target changes the app's *name* but not the *state root* — verified with
`bundle validate`:

```console
$ databricks bundle validate -o json --var app_name=caltrans-whatif-pr-42 \
    | jq -c '{app:.resources.apps.app.name, root:.workspace.root_path}'
{"app":"caltrans-whatif-pr-42","root":".../.bundle/caltrans-whatif/default"}

$ databricks bundle validate -o json --var app_name=caltrans-whatif-pr-99 \
    | jq -r .workspace.root_path
.../.bundle/caltrans-whatif/default          # <-- IDENTICAL
```

Every PR would share production's state. DAB would read that state, see one app recorded under a
different name than the config now asks for, and treat the recorded app as removed — so deploying
PR 99 would **destroy** PR 42's app, and deploying either would fight with production.

The `preview` target interpolates `${var.app_name}` into `workspace.root_path`, which makes both
the name *and* the state root per-PR:

```console
$ databricks bundle validate -t preview --var app_name=caltrans-whatif-pr-42 ... -o json
{"app":"caltrans-whatif-pr-42","root":".../.bundle/caltrans-whatif/preview/caltrans-whatif-pr-42"}
$ databricks bundle validate -t preview --var app_name=caltrans-whatif-pr-99 ... -o json
{"app":"caltrans-whatif-pr-99","root":".../.bundle/caltrans-whatif/preview/caltrans-whatif-pr-99"}
```

The `default` target's `root_path` is deliberately left implicit so production keeps resolving to
`.bundle/caltrans-whatif/default` exactly as before. **Do not add `app_name` to `root_path` on the
`default` target** — that would move production's state and orphan the existing deployment.

`deploy.sh` and `teardown.sh` both re-assert this from `bundle validate` output before acting, and
refuse to proceed if the resolved state root is not preview-scoped.

## Both Lakebase variables must move together

`lakebase_database` is a **full resource path that embeds the branch id**:

```
projects/caltrans-app/branches/pr-42/databases/databricks-postgres
                               ^^^^^
```

So overriding `lakebase_branch` **alone** leaves the database pointing at
`branches/production/...` — a preview app reading and writing **production data**, with nothing in
the deploy log to suggest anything is wrong. `lib.sh` derives both from one PR number so they
cannot skew, and `deploy.sh` asserts both resolved values before deploying.

Note the database id is hyphenated in this repo: `databricks-postgres`, not the Databricks default
`databricks_postgres`.

## Deploy ordering

`deploy.sh` runs four phases and each creates the precondition for the next:

1. **`bundle deploy`** — creates the app, which is what provisions its service principal. No SP
   exists before this.
2. **UC read grants** — must precede step 4, because step 4's build runs `appkit generate-types`,
   which issues `DESCRIBE QUERY` as the SP and is **fatal**. A missing grant fails the *build*
   with `N queries could not be described`, not at runtime.
3. **Lakebase grants** — the branch inherited production's grants, which name the *production*
   app's SP UUID. See below.
4. **`apps deploy`** — builds and starts, now that 2 and 3 exist.

### `apps deploy` takes no name; `apps delete` must have one

Both commands read the working directory, but the safe choice is **opposite**, which is a good way
to introduce a bug while "making things consistent":

| Command | No name, inside `caltrans-whatif/` | What we do |
|---|---|---|
| `apps deploy` | Enhanced pipeline: **build**, typecheck, lint, sync, run | **Omit the name.** This is the only form that builds, and `dist/` is gitignored while `app.yaml` runs `node ./dist/server.js`. Passing a name switches to API-direct mode, skips the build, and deploys an app with no server bundle. Also the documented production path. |
| `apps delete` | "Destroy everything this project deployed" — i.e. **production** | **Always pass the name.** |

For `apps deploy`, safety comes from `-t preview` plus the overrides, whose resolution phase 0
already asserted.

## Each preview app has its own service principal

Databricks provisions a **distinct SP per app**. A copy-on-write branch inherits production's
grants, which reference the production SP's UUID — so the preview app appears in no ACL.
`CAN_CONNECT_AND_CREATE` lets it connect and create its own objects but grants nothing on the
pre-existing `app` schema, which a human owns.

Without the grants step, a preview app deploys and starts fine, then fails on its **first advisor
write** with `permission denied for schema app` (SQLSTATE 42501) — at runtime, in the deployed app
only. Local dev runs as the schema owner and cannot reproduce it.

`apply-lakebase-grants.sh` reads the app's own SP with

```bash
databricks apps get caltrans-whatif-pr-42 -o json | jq -r .service_principal_client_id
```

and passes it to the shared applier. **The grant SQL is not duplicated** — `lakebase/**` is owned
by the main-deploy workflow.

> **Dependency:** this requires `scripts/lakebase/apply.sh --grants-only --endpoint <p> --sp-role <uuid>`
> and `lakebase/grants_advisor.sql` accepting `psql -v sp_role=`. If that has not landed,
> `apply-lakebase-grants.sh` fails with an explicit message instead of a confusing psql error.

## Teardown is a cost control

Not hygiene. An idle Lakebase branch floors at **~0.5 CU** with a 24h suspend timeout that
**cannot be lowered**, and a project allows only **10 unarchived branches** — so a leaked branch
bills indefinitely *and* eats a slot a future PR needs. `teardown.sh` prints the remaining branch
budget on every run.

Two safety properties:

- **Never touches production.** A bare `databricks apps delete` run inside `caltrans-whatif/` means
  "destroy all resources deployed by this project" — i.e. production. Teardown always passes an
  explicit name, always passes `-t preview`, and asserts the resolved app name and state root are
  PR-scoped before destroying anything.
- **Idempotent and non-failing when there is nothing to do.** A PR can close without a preview ever
  existing. Teardown exits 0 in that case; it exits non-zero only when resources are still present
  afterwards, so a red run on a closed PR is believable and means a real leak.

Safe to re-run by hand: `scripts/preview/teardown.sh 42`.

### TTL backstop

Branches are created with a **7-day TTL**, deliberately *not* refreshed by pushes. The TTL is a
backstop for when teardown never runs at all (cancelled run, deleted branch, Actions disabled).
Refreshing on push would let an abandoned-then-touched PR outlive the backstop forever. Lakebase
caps TTL at 30 days.

## `ADVISOR_SELF_URL`

`app.yaml` hardcodes the **production** app's public URL, and `app.yaml` supports no variable
interpolation. A preview deployed from the same source tree would self-probe production, writing
its startup SSE diagnostic into production's `app.audit` under the wrong deployment.

The URL is not knowable before deploy. `strip-self-url.sh` **removes the entry** from the CI
checkout, which makes `selfprobe.ts` no-op the probe — the fix the file's own comment recommends.
Losing a startup diagnostic on a throwaway preview is a good trade against deploying twice to
obtain it. Production deploys never call the script and keep the real URL.

## Secrets a human must set before the first run

Both are repository (or `preview` environment) secrets:

| Secret | Value |
|---|---|
| `DATABRICKS_HOST` | `https://fevm-serverless-stable-blj52t.cloud.databricks.com` |
| `DATABRICKS_TOKEN` | PAT for `thomas.seufert@databricks.com` |

The workflows reference an environment named **`preview`** — create it, or delete the
`environment: preview` lines.

**The token's identity matters and is not interchangeable:**

- The bundle state root is `/Workspace/Users/${workspace.current_user.userName}/...`, so a
  different identity silently deploys to a different state root.
- `grants_advisor.sql` must run as the **owner** of the `app` schema. `thomas.seufert@databricks.com`
  owns it, has a Postgres role, and is in `DATABRICKS_SUPERUSER`.
- `ALTER DEFAULT PRIVILEGES` inside that file applies to objects created by the role that *runs*
  it — so changing the identity would silently narrow future grants.

Auth is **PAT**. Do not set `DATABRICKS_AUTH_TYPE` (that is an OAuth-M2M requirement and would
break PAT auth), and no service principal or extra Postgres role is needed.

## Running by hand

```bash
export DATABRICKS_HOST=... DATABRICKS_TOKEN=...
scripts/preview/create-branch.sh 42
scripts/preview/deploy.sh 42
scripts/preview/comment-body.sh 42 caltrans-whatif-pr-42 "$(databricks apps get caltrans-whatif-pr-42 -o json | jq -r .url)" "$(databricks apps get caltrans-whatif-pr-42 -o json | jq -r .service_principal_client_id)"
scripts/preview/teardown.sh 42
```

All of them are idempotent.

## Known gaps

- **No smoke test against the deployed preview.** Databricks Apps sits behind SSO; `/api/*` returns
  401 to non-OIDC clients, so an external check cannot reach it. No gate is built on something
  that cannot work.
- **No link to the Lakebase branch page.** Databricks documents that a branch overview and a
  Schema diff view exist but documents no URL, and neither CLI nor SDK returns a console URL for a
  branch (unlike `apps get`, which returns `.url`). Route probing was inconclusive — the console
  SPA 303s unknown paths to login identically to real ones. The comment therefore gives the real
  app URL plus copy-pasteable commands and a click-path. A guessed link that 404s would cost more
  trust than a missing one. If someone establishes the template by hand, add it to
  `comment-body.sh` with a note that console routes are unversioned.
- **Forked PRs get no preview.** They receive no secrets and a read-only token. Both workflows skip
  them explicitly rather than failing halfway.
- **First-push latency.** Branch creation plus two deploy phases plus a full app build; expect
  several minutes.
