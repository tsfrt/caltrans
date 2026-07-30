# Blocker 7: `actions/setup-python` fails on the self-hosted `caltrans` Mac

**Branch:** `polly/fix-setup-python` (from `origin/main` @ d504cd0)
**Protocol:** written incrementally — each section appended as the item completes.

## The failure

```
Set up Python  Check if Python hostedtoolcache folder exist...
Set up Python  Creating Python hostedtoolcache folder...
Set up Python  ##[error]mkdir: /Users/runner: Permission denied
Set up Python  ##[error]The process '/bin/bash' failed with exit code 1
```

Impact at b1e167b on `main` (runs 30481710233 CI / 30481710232 Deploy Main):
- CI: `Scenario SQL drift check` FAILS at step 3 (Set up Python). Other two jobs green.
- Deploy Main: FAILS at step 5 (Set up Python) => never reaches `Apply Lakebase schema`,
  so **production schema + grants migrations do not run at all.** Highest-severity consequence.

Runner: name `caltrans`, labels [self-hosted, macOS, ARM64], Apple Silicon, persistent,
single-job. Runner user `thomas.seufert`, runner at `/Users/thomas.seufert/gh_runner/...`.
No `runner` user exists; `/Users/runner` is not writable.

---

## Item 0 — call-site inventory (DONE)

Three `setup-python` sites, all must be fixed together:
- `.github/workflows/ci.yml:173`
- `.github/workflows/deploy-main.yml:85`
- `.github/workflows/preview-up.yml:159`

**Bare `python ` invocations — complete list across `.github/` and `scripts/`:**
`grep -rn '\bpython\b' .github/ scripts/ | grep -v python3 | grep -v setup-python`
- `.github/workflows/ci.yml:179` — `run: python -m tools.scenario_sql.render --check`  <- THE ONLY real one
- (all other hits are `python-version: '3.12'` inputs or prose in comments)

So exactly ONE bare-`python` call site exists. Confirmed there are no others under
`scripts/` at all.

`python3` call sites (must keep working):
- `scripts/lakebase/apply.sh:138` — `python3 -c` JSON parse
- `scripts/lakebase/apply.sh:143` — `require_cmd python3`
- `scripts/preview/strip-self-url.sh:32` — `python3 -` heredoc, edits app.yaml in place

---

## Item 5 — sub-question (ii): bare `python`, and a Homebrew trap worth knowing

The brief's warning is correct and I verified the mechanism in the **formula source**
(`homebrew-core Formula/p/python@3.12.rb`), not just the caveats:

```ruby
def altinstall? = name != Formula["python3"].name      # line 99
...
# Install unversioned (and for an altinstall, major-versioned) symlinks in libexec/bin.
{ "python" => "python3.12", ... }
  .merge(altinstall? ? { "python3" => "python3.12", ... } : {})
  .each { |short, long| (libexec/"bin").install_symlink (bin/long).realpath => short }
```

`python@3.12` is an **altinstall** (its name differs from whatever the `python3` alias currently
points at). Consequences, which are sharper than "does not reliably put bare `python` on PATH":

- `<prefix>/bin/` gets **only `python3.12`**.
- **BOTH bare `python` AND bare `python3`** live in `<prefix>/opt/python@3.12/libexec/bin`,
  which is **NOT** on PATH by default.

So naively `brew install python@3.12` would leave *`python3` itself* unresolved (or, worse,
resolving to the `/usr/bin/python3` Xcode CLT stub that preview-up.yml explicitly warns about).
That would have traded one failure for another exactly as the brief predicted — just one level
deeper than the bare-`python` issue.

**Fix applied (two parts, both required):**
1. `ci.yml` `python -m tools.scenario_sql.render --check` -> `python3 -m ...` (the single bare site).
2. Export `$(brew --prefix python@3.12)/libexec/bin` onto `$GITHUB_PATH`. This is the documented
   caveat path and it provides `python3` **and** `python`, so the fix is belt-and-braces rather
   than dependent on (1) alone. Structurally the same keg-only-style export the repo already does
   for `libpq`, and the prefix is READ from `brew --prefix`, never hardcoded (Intel/custom prefixes).

---

## Item 6 — REAL observed CI results on the self-hosted `caltrans` runner

PR #15, branch `polly/fix-setup-python`, commit 4317198. CI run **30484708915**.

### `Scenario SQL drift check` — the job that was RED is now GREEN

```
JOB: Scenario SQL drift check => success
  1. Set up job              :: success
  2. Check out repository     :: success
  3. Ensure Python            :: success   <- WAS: "Set up Python" FAILED HERE
  4. Check rendered scenario SQL :: success
  8. Post Check out repository :: success
  9. Complete job             :: success
```

Real runtime output from the runner (not the echoed script):

```
Installing python@3.12 via Homebrew...
==> Installing python@3.12 dependency: ca-certificates
python3 will resolve to: /opt/homebrew/opt/python@3.12/libexec/bin/python3
python3 resolved: /opt/homebrew/opt/python@3.12/libexec/bin/python3
Python 3.12.13
interpreter OK: 3.12.13
scenario SQL is in sync with the generator
```

**Two things this empirically proves, beyond "it passed":**

1. `python3` resolved to **`/opt/homebrew/opt/python@3.12/libexec/bin/python3`** — the
   `libexec/bin` path, NOT `<prefix>/bin`. So the altinstall analysis in Item 5 was correct and
   **that PATH export was load-bearing.** Without it `python3` would have fallen through to the
   `/usr/bin/python3` CLT stub.
2. `python@3.12` was **NOT already present** ("Installing python@3.12 via Homebrew...", and it had
   to pull `ca-certificates`). So the fix provisioned Python from scratch on a real box with no
   human action and no sudo — which is precisely the Option C claim, now demonstrated rather than
   argued. Homebrew resolved 3.12.13 (drift from setup-python's 3.12.10 — harmless, per Item 3).

---

## Item 7 — runner prerequisites (also committed to docs/PREVIEW_ENVIRONMENTS.md)

While writing this I found `preview-up.yml:215` emits
`::error::See docs/PREVIEW_ENVIRONMENTS.md (runner prerequisites)` — but **no such section
existed**. The actionable error pointed at nothing. Added it (commit 3e4e55f), because "a missing
binary fails the same silent way the missing psql did" is exactly what that error is for.

### A human must install EXACTLY TWO things
1. **Homebrew** — as the runner user, NOT with sudo.
2. **Xcode Command Line Tools** (`xcode-select --install`) — provides `git`; Homebrew needs it too.

### Provisioned automatically by guarded idempotent steps (no human action)
| binary | formula | why it needs a PATH export |
|---|---|---|
| `psql` | `libpq` | keg-only -> brew links nothing; workflow exports `$(brew --prefix)/opt/libpq/bin` |
| `jq` | `jq` | NOT keg-only -> no export needed |
| `python3` | `python@3.12` | **altinstall** -> exports `$(brew --prefix python@3.12)/libexec/bin` |

Each has an install step AND a separate assert step that proves the binary resolves, so a missing
one fails loudly with the exact `brew install` to run rather than as a bare exit 127 mid-deploy.

### From the actions, no runner setup
- `node`/`npm`/`npx` — `actions/setup-node@v4` (into the runner's own `_work/_tool`; NO `cache: npm`)
- `databricks` — `databricks/setup-cli@v1.7.0` (exact pin; installs under `$RUNNER_TEMP`, no sudo)
- `git`/`curl`/`unzip`/`tar` — stock macOS

### NOT requirements
- **`gh`** — verified zero invocations across `.github/` and `scripts/`. PR comments use
  `actions/github-script`, which runs in the action runtime, not on the runner's PATH.
- **`actions/setup-python`** — must NOT be reintroduced (check 3i in verify-all.sh enforces this).
- **`sudo`** — no workflow step uses it (asserted structurally by check 3i).

### Secrets (unchanged by this PR)
`DATABRICKS_HOST`, `DATABRICKS_TOKEN` (PAT for thomas.seufert@databricks.com; identity is
load-bearing for the bundle state root and schema ownership). Environment `preview` must exist.

---

## Item 8 — final verification summary

`bash .polly/review/verify-all.sh` -> **ALL CHECKS PASSED, exit 0**. Full list:
1 YAML parse (6 files, now globbing actions/*) | 2 bash -n (10 scripts) | 2b bash -n (32 embedded
run: blocks) | 3a zero cache: inputs | 3b no mapfile | 3c no hardcoded brew prefix | 3d 6/6 jobs on
[self-hosted, macOS, ARM64] | 3e no ubuntu-latest runs-on | 3f no real apt-get | 3g no -pooler uses |
3h setup-cli pinned v1.7.0 | **3i (NEW) zero setup-python uses, zero bare python, zero sudo, all 3
sites on the shared action** | 4 jq guards | 5 fork-guard | 6 distinct concurrency groups |
7 no bash-4-only constructs.

Both regressions were NEGATIVE-TESTED (the check has teeth, it is not decoration):
- reintroduce bare `python` in ci.yml -> `FAIL ... bare python in step 'Check rendered scenario SQL'`, exit 1
- reintroduce `actions/setup-python` in deploy-main.yml -> `FAIL ... still USES actions/setup-python`, exit 1
Tree restored to clean after each; gate re-confirmed exit 0.

Preserved invariants re-verified (all hold):
- (a) `lib.sh:78` emits all three `--var` pairs in ONE printf — unchanged, not touched.
- (b) app bundle: `preview.workspace.root_path` = `.../preview/${var.app_name}`; `default` has
  **no** root_path key (asserted programmatically, not eyeballed).
- (c) `bundle destroy` is `-t "$PREVIEW_BUNDLE_TARGET"` scoped; BOTH `apps delete` calls pass
  `"$APP_NAME"` (teardown.sh:77, teardown.sh:85).
- `setup-node` NOT touched; `cache: npm` NOT reintroduced; setup-cli still exactly v1.7.0.

## Item 9 — UNVERIFIED, stated plainly

1. **`deploy-main.yml`'s `Ensure Python` step has not been observed running.** It only triggers on
   push to `main`, and this is a PR. It is verified *by construction* — it invokes the same
   composite action that just went green in ci.yml on the same runner — but that is inference, not
   observation. This is the highest-value remaining check, since it gates the production
   schema/grants migrations.
2. **`preview-up.yml`'s `Ensure Python` step has not been observed running.** preview-up triggers
   on every PR (opened/synchronize/reopened — NOT label-gated, contrary to my initial reading), but
   its runs were cancelled by `cancel-in-progress` concurrency as I pushed follow-up commits, and
   then the runner went offline.
3. **The `caltrans` runner went `offline` (busy=false) partway through this session**, so runs
   queued at 3e4e55f/7b05ce0 are stuck queued rather than failing. Those commits changed only docs
   and the verification gate — **no workflow logic changed after 4317198**, the commit the green
   result was measured on. A re-run once the box is back would close items 1 and 2.
4. `Databricks bundle validate` was still in_progress when its run got superseded; it has no Python
   involvement, and it was green on `main` before this change.
5. I did not run any mutating Databricks command, per the constraints — so nothing about actual
   Lakebase migration behaviour is verified here beyond the fact that the step is now reachable.
