# Self-hosted runner prerequisites — the `caltrans` macOS box

Everything the six CI jobs need on the runner named **`caltrans`**
(labels `[self-hosted, macOS, ARM64]`, single persistent runner, one job at a time).

A missing binary here fails the same silent way the missing `psql` did: a job dies with a bare
`exit 127` that reads like transient CI flake, or — worse — a deploy reports success while a
migration never ran. So this list is meant to be exhaustive rather than illustrative.

## What CI installs for you — do NOT install these by hand

| tool | installed by | notes |
|---|---|---|
| **Databricks CLI** | `databricks/setup-cli@v1.7.0` | Pinned to an exact version; `v1` does not exist upstream. Installs under `$RUNNER_TEMP`, no sudo, leaves nothing behind. |
| **Node.js 22** | `actions/setup-node@v4` | Persists in `RUNNER_TOOL_CACHE` between runs, so only the first job downloads. |
| **Python 3.12** | `actions/setup-python@v5` | ⚠️ Currently **broken on this box** — see "Known blocker" below. |
| **jq** | the workflows themselves | `brew install jq`, guarded by `command -v jq`. Needs Homebrew present. |
| **libpq / psql** | the workflows themselves | `brew install libpq`, guarded. Needs Homebrew present. |

## What a human MUST install by hand

### 1. Xcode Command Line Tools — provides `git`, `curl`, `unzip`, `tar`

```bash
xcode-select --install
```

`git` is required by `actions/checkout`; `curl` + `unzip` by `databricks/setup-cli`. All are
stock on macOS once the CLT are present.

### 2. Homebrew — REQUIRED

Not optional: it is how the workflows obtain `jq` and `psql`. Without it they stop with an
actionable `::error::` rather than a mystery 127.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"   # Apple Silicon; /usr/local on Intel
```

Install it **as the runner user** (`thomas.seufert`), never with `sudo`. The workflows probe
both `/opt/homebrew/bin/brew` and `/usr/local/bin/brew` and derive the prefix from
`brew --prefix`, so either layout works.

### 3. `jq` and `libpq` — recommended to pre-install

The workflows install these on demand, but doing it once up front avoids paying a
`brew install` inside a timed job:

```bash
brew install jq libpq
```

- **`jq`** is used by `scripts/preview/{create-branch,deploy,teardown,grant-uc-read}.sh` and by
  `.github/actions/databricks-setup`'s identity check. It is **not** keg-only — brew links it
  onto `PATH` normally, so no `PATH` export is needed.
- **`libpq`** provides `psql`, used by `scripts/lakebase/apply.sh` for the schema, grants and
  verify migrations. It **is** keg-only, so nothing lands in `<prefix>/bin`; the workflows export
  `$(brew --prefix libpq)/bin` to `$GITHUB_PATH` themselves. Prefer `libpq` over `postgresql@17`,
  which would also drag in a server nobody wants on a CI box.

### 4. ⚠️ Known blocker: the `hostedtoolcache` directory (needs `sudo`)

`actions/setup-python@v5` currently **fails** on this box:

```
##[error]mkdir: /Users/runner: Permission denied
```

The runner user is `thomas.seufert`, but the macOS Python builds from `actions/python-versions`
are compiled in `/Users/runner/hostedtoolcache` and are **non-relocatable** — upstream documents
that they "require to be installed only in `/Users/runner/hostedtoolcache`". This is why the
usual self-hosted escape hatch, `AGENT_TOOLSDIRECTORY`, does **not** fix it: pointing it
somewhere else produces a broken interpreter.

One-time fix:

```bash
sudo mkdir -p /Users/runner/hostedtoolcache
sudo chown -R "$(whoami):$(id -gn)" /Users/runner/hostedtoolcache
```

**Until this is done:** `ci.yml`'s `scenario-sql` job is red, and `deploy-main.yml` dies before
`Apply Lakebase schema` — so **production migrations do not run**.

Alternative, if the directory fix is unwanted: replace `actions/setup-python@v5` with a guarded
`brew install python@3.12` step in the same shape as the `jq` / `libpq` steps. That avoids the
non-relocatable-build problem entirely and needs no `sudo`.

## Explicitly NOT required

- **`gh`** (GitHub CLI) — no workflow invokes it. Not a runner requirement.
- **GNU coreutils** — every script is BSD-safe: no `sed -i`, `date -d`, `readlink -f`, `grep -P`,
  `base64 -w`, `timeout`, `stat -c`, `sort -V` or `realpath`.
- **bash 4+** — everything is compatible with the system bash 3.2.57. Do not add `mapfile`,
  `readarray`, `declare -A`, `${var,,}`, `${var^^}`, `&>>` or negative array indices.
- **`apt-get` / Docker / a local Postgres server** — not used.
- **passwordless sudo** — no workflow uses `sudo`. (The `hostedtoolcache` fix above is a one-time
  manual step, not something CI does.)

## Runner service environment

The runner inherits the environment of whatever launched it, unlike a fresh GitHub VM. Make sure
these are **not** exported in the runner service environment, or they will silently apply to
every run:

- `DATABRICKS_CONFIG_PROFILE` — would override the `DATABRICKS_HOST`/`TOKEN` the workflows set.
- `PGHOST`, `PGDATABASE`, `PGSSLROOTCERT` — `apply.sh` passes an explicit conninfo string whose
  keywords win, but a stray `PGSSLROOTCERT` can still break TLS.

A stale `~/.databrickscfg` on the box is harmless: the workflows set `DATABRICKS_HOST` and
`DATABRICKS_TOKEN` explicitly, which take precedence.

## Verifying the box

```bash
git --version && curl --version | head -1 && unzip -v | head -1
brew --version
command -v jq   && jq --version
command -v psql && psql --version      # or: ls "$(brew --prefix libpq)/bin/psql"
ls -ld /Users/runner/hostedtoolcache   # must exist and be writable by the runner user
bash --version | head -1               # expect 3.2.57 — scripts must stay compatible
```

To validate the workflow definitions themselves (no runner needed):

```bash
bash .polly/review/verify-all.sh
```
