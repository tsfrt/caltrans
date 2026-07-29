# PR #14 post-run slowness + 6 blockers — fix log

Branch `polly/ci-followup`, base commit 7b11a4a. Written incrementally; each section is
appended as the work lands.

---

## 1. Post-run diagnosis — CONFIRMED, with one correction to the stated mechanism

### `cache: npm` does register a post step, and it does upload — confirmed at source

`actions/setup-node@v4` `action.yml` `runs:` block, fetched from
`raw.githubusercontent.com/actions/setup-node/v4/action.yml`:

```yaml
runs:
  using: 'node20'
  main: 'dist/setup/index.js'
  post: 'dist/cache-save/index.js'
  post-if: success()
```

So the post step exists unconditionally as far as the action manifest is concerned. Whether it
does any work is decided at runtime by `src/cache-save.ts`:

```ts
export async function run(earlyExit?: boolean) {
  const cacheLock = core.getState(State.CachePackageManager);
  if (cacheLock) {
    await cachePackages(cacheLock);
    ...
```

`State.CachePackageManager` is only set when the `cache:` input was provided. With no `cache:`
input the post step short-circuits to a `core.debug` and exits — measurably free. With
`cache: npm` it proceeds to:

```ts
const cacheId = await cache.saveCache(cachePaths, primaryKey);
```

`@actions/cache.saveCache` is tar + upload to the Actions cache *service* over HTTPS. So the
user's stated mechanism is correct: **the cached path is local, the cache backend is remote.**
The existing comment in `ci.yml:42-43` conflates the two and is wrong.

### The correction: it is gated on a cache MISS, not every run

`cache-save.ts` has an early return the diagnosis did not account for:

```ts
if (primaryKey === state) {
  core.info(`Cache hit occurred on the primary key ${primaryKey}, not saving cache.`);
  return;
}
```

`primaryKey` is `node-cache-${platform}-${arch}-${packageManager}-${hash(lockfile)}`. So the
tar+upload fires when the restore did **not** hit that exact primary key — i.e. on the first
run for a given lockfile hash, and on every run whose cache entry is not reachable.

That "not reachable" case is the reason this is still a real per-run cost rather than a
once-per-lockfile-change cost, because of Actions cache **branch scoping** (GitHub docs,
"Caching dependencies to speed up workflows"):

> Workflow runs cannot restore caches created for child branches or sibling branches.

A run on `feature-a` can only restore caches from `feature-a`, the default branch, and (for PRs)
the base branch. `setup-node` for npm passes **no `restoreKeys`** (verified in
`src/cache-restore.ts` — restore keys are supplied only for Yarn Berry). Combined:

- Every **first** CI run on a new PR branch: no branch-scoped entry under that exact primary
  key → restore misses → **tar + upload fires**.
- Any run after the 7-day idle eviction, or after the 10 GB repo ceiling evicts by
  last-access date → miss → **upload fires again**.
- Three workflows × the same lockfile all write the same primary key, so they contend and
  re-upload rather than co-operating.

So: not literally "every single run", but every new branch and every eviction, which on an
active repo is frequent — and it is **pure waste on this runner** regardless of how often it
fires, which is the actual point.

### Why it is waste specifically here

`~/.npm` is in the runner user's home directory, **outside** `$GITHUB_WORKSPACE`. The runner is
persistent and single-job, so that directory survives between jobs on local disk. `npm ci`
consults `~/.npm` directly and gets its speedup from the local content whether or not the
Actions cache service has ever seen it. The remote copy buys nothing: it is restoring, over the
network, data that never left the box. What it costs:

- post-step wall clock: tar of the whole npm cache dir + HTTPS upload, serialized at the end
  of the job on a **single-job** runner, so it delays the next queued job 1:1;
- repo Actions cache quota (10 GB) and the eviction thrashing that follows from three workflows
  writing the same key.

### Empirical timing evidence

`gh api repos/tsfrt/caltrans/actions/runs/30471320457/jobs` — CI on `main`. Note these three
jobs ran on **`ubuntu-latest`** (main has not switched to self-hosted yet), so treat the
absolute numbers as a floor, not as this runner's cost:

```
JOB App lint, typecheck, unit tests
  [3]  Set up Node.js          16:34:06 -> 16:34:07   (1s)
  [4]  Install dependencies    16:34:07 -> 16:34:42  (35s)
  ...
  [15] Post Set up Node.js     16:35:08 -> 16:35:11   (3s)   <-- the cache-save upload
  [16] Post Check out repository 16:35:11 -> 16:35:11  (0s)
```

`Post Set up Node.js` = **3s**, versus `Post Check out repository` = **0s**, in the same job on
a hosted VM with a fast datacentre uplink. On the two jobs with **no** `cache:` input
(`Scenario SQL drift check`, `Databricks bundle validate`) every post step is 0-1s:

```
JOB Scenario SQL drift check
  [7] Post Set up Python       16:34:13 -> 16:34:13   (0s)   <-- no cache: input, no-op
  [8] Post Check out repository 16:34:13 -> 16:34:14  (1s)
JOB Databricks bundle validate
  [10] Post Check out repository 16:34:13 -> 16:34:13  (0s)
```

The 3s vs 0s delta isolates the cache upload as the only post step doing real work. On a home
Mac uploading to GitHub over a residential/office uplink this is expected to be substantially
worse than 3s, and it scales with npm cache directory size, which on a persistent runner
**grows monotonically** — it is never wiped, because it lives outside the workspace that
`git clean -ffdx` scrubs. That growth is why this degrades over time rather than staying at 3s.

**Unverified:** I could not measure the post-step duration on the `caltrans` Mac itself. Both
completed self-hosted-labelled runs I found (30470147029, 30471321508) failed at the
`databricks-setup` step, which **skipped** `actions/setup-node@v4` entirely — so no
`Post Set up Node.js` step was ever registered in them, and the API confirms they were
dispatched to `ubuntu-latest` anyway. The mechanism is confirmed from source and the relative
cost is confirmed from hosted timings; the absolute seconds on the Mac are inferred, not
measured.

### Verdict

Diagnosis **confirmed** on mechanism and on remedy. Removing `cache: npm` makes the post step a
no-op via the `if (cacheLock)` guard, with zero loss to `npm ci` speed on a persistent runner.

---

## 2. Broader post-step audit

Fetched the `runs:` block of every action used, to enumerate what actually registers a post step:

| action | post step | cost here |
|---|---|---|
| `actions/checkout@v4` | `post: dist/index.js` | ~0-1s. See below — it is **not** what people think. |
| `actions/setup-node@v4` | `post: dist/cache-save/index.js`, `post-if: success()` | **The problem.** Fixed. |
| `actions/setup-python@v5` | `post: dist/cache-save/index.js`, `post-if: success()` | No-op — no `cache:` input. Confirmed, left alone. |
| `databricks/setup-cli@v1.7.0` | composite, **no post at all** | zero |
| `actions/github-script@v7` | `main:` only, **no post** | zero |
| `./.github/actions/databricks-setup` | composite; wraps setup-cli + two `run:` steps | zero of its own |

### `actions/checkout@v4`'s post step — the premise in the brief is wrong

The brief says checkout's post step "runs `git clean -ffdx` style cleanup". **It does not.** From
`src/main.ts`, the same entrypoint branches on `IsPost`:

```ts
if (!stateHelper.IsPost) { run() } else { cleanup() }
```

`cleanup()` calls `gitSourceProvider.cleanup()`, which only removes auth: `git config --unset-all`
of the SSH command / HTTP auth header, the submodule equivalents, and the `includeIf` credential
entries. `git clean -ffdx` lives in `prepareExistingDirectory()`, reached from **`getSource()` — the
MAIN step**, not the post step.

Measured, this matches: `Post Check out repository` is **0-1s** in every job in run 30471320457.

So the `clean: true` cost is real but it is paid at the **start** of the job, and it is not part of
the "post run" phase the user is seeing. **Recommendation: leave `clean: true` exactly as is.**
The safety argument in `deploy-main.yml` and `ci.yml` is correct and the cost is in the wrong phase
to be the complaint. I changed nothing here.

### The 3-job serialization — confirmed, and it is the second-order problem

`ci.yml` does run 3 separate jobs, each with its own checkout + toolchain setup, on a single-job
runner — so setup/teardown is paid **3× serially**. Caught live during this work:

```
run 30475129626 (CI, polly/ci-followup):
  Scenario SQL drift check    status=queued   labels=self-hosted,macOS,ARM64
  Databricks bundle validate  status=queued   labels=self-hosted,macOS,ARM64
  App lint, typecheck, tests  status=queued   labels=self-hosted,macOS,ARM64
run 30475124369 (Preview up): preview  status=in_progress  runner=caltrans
```

All three CI jobs blocked behind one preview job on the single runner.

**Recommendation (NOT done in this change, as instructed):** consolidating `scenario-sql` and
`bundle-validate` into one job is very likely a net win — from the hosted timings they are ~4s and
~6s of actual work each against ~2-3s of per-job overhead, they share a checkout, and their
toolchains do not conflict (setup-python vs setup-cli). `app` should stay separate: it is the long
one (~70s) and merging it would serialize the fast gates behind it and lose per-job pass/fail
granularity. Net effect would be 3 jobs → 2 and one less checkout+setup cycle. I did **not**
restructure the job graph — it changes the PR's required-check names, which is a repo-settings
concern, so it wants its own change. What I did instead was add `concurrency:` to `ci.yml`
(previously absent), which addresses the more dangerous consequence: a queue of superseded CI runs
starving `preview-down` and leaking a paid branch.

---

## 3. The six blockers

| # | Blocker | Fix | Verification |
|---|---|---|---|
| 1 | `mapfile` (bash 4) at `apply.sh:156` on the production schema path | `while IFS= read -r` loop, same `find ... \| sort` | Output byte-identical to mapfile against real `lakebase/`; tested 0/1/2 files |
| 2 | `jq` required, installed by nothing | guarded `brew install jq` + assert, in both preview workflows, **before** `databricks-setup` | check 4: guard+install+assert present in exactly the 2 workflows that need it |
| 3 | Hardcoded `/opt/homebrew` in preview-up | `BREW_PREFIX="$(brew --prefix)"`, matching deploy-main | check 3c: no `BREW_PREFIX=/` anywhere |
| 4 | No `python3` provisioning in preview-up | `actions/setup-python@v5` @ 3.12 | YAML parses; matches the other two workflows |
| 5 | No fork guard on `ci.yml` | 2-clause `if` on all 3 jobs + `concurrency:` | truth table: push RUNS, same-repo PR RUNS, fork PR SKIPPED, null-repo SKIPPED |
| 6 | Shared concurrency group let preview-up cancel teardown | distinct `preview-up-<n>` / `preview-teardown-<n>` | check 6: all 4 groups pairwise distinct |

Extra bash-3.2 hazards found and fixed while editing blocker 1 (neither was in the brief):
- loop body uses `if` not `[[ -n ]] && arr+=()`; as the body's last command a failing `&&` list
  becomes the body's exit status, which `set -e` treats as fatal;
- the zero-match diagnostic guards `"${FILES[@]}"` — bash 3.2 treats an empty array expansion as
  **unbound** under `set -u` (fixed upstream only in 4.4), so the naive form would have replaced
  the error message with `FILES[@]: unbound variable` in exactly the case that prints it.

Swept for the other bash-4-only constructs named in the brief — `declare -A`, `local -A`,
`declare -g`, `local -n`, `${var,,}`, `${var^^}`, `&>>`, negative array indices: **zero hits**
outside comments (check 7).

---

## 4. Preserved safety properties — all re-verified

- **(a)** `lib.sh` `preview_bundle_vars` still emits all three `--var` overrides in ONE `printf`.
  `git diff` shows **`scripts/preview/lib.sh` is not touched by this change at all.**
- **(b)** Verified against the LIVE workspace with `databricks bundle validate -o json`:
  `default` root_path = `/Workspace/Users/thomas.seufert@databricks.com/.bundle/caltrans-whatif/default`
  — ends in `/default`, contains no app name. `databricks.yml` is untouched.
- **(c)** Every `bundle destroy` is `-t "$PREVIEW_BUNDLE_TARGET"`; every `apps delete` fallback
  passes `"$APP_NAME"` (teardown.sh:77, :85). No bare-delete path. Untouched.

## 5. Non-mutating validation

`databricks bundle validate -o json` for the `default` target: **exit 0** against the real
workspace (CLI v1.7.0, auth from `~/.databrickscfg`). Root bundle also resolves
(`caltrans-synthetic-traffic`). No mutating command was run — no deploy, destroy, apps
deploy/delete, create/delete-branch, or psql.

## 6. Stated plainly as UNVERIFIED

- **Post-step duration on the `caltrans` Mac itself.** Not measured. Both self-hosted-labelled
  runs I found failed early at `databricks-setup`, which skipped setup-node entirely, and the API
  shows they were dispatched to `ubuntu-latest` regardless. Mechanism is confirmed from source;
  absolute seconds on the Mac are inferred from the hosted 3s-vs-0s delta plus the fact that a
  persistent runner's `~/.npm` grows without bound.
- **Whether Homebrew / libpq / jq are actually present on the box.** Cannot inspect it from here.
  The workflows now fail loudly with `::error::` instead of a bare 127. See the prerequisites
  checklist.
- **The workflows have not been executed with these changes.** Everything below the YAML/shell
  parse level (does `brew install jq` succeed there, does setup-python resolve darwin-arm64 on
  that box) is verified by construction and by upstream docs, not by a green run.
- **`git clean -ffdx` wall-clock on that workspace.** Not measured; argued to be irrelevant to the
  post-run complaint because it runs in checkout's MAIN step, which the source confirms.
- **GitHub Actions `==` vs `||` operator precedence** is not documented; I parenthesized rather
  than depend on it.

---

## 7. Landing note

PR #14 was **merged at `7b11a4a`** — its original head, before any of this work. None of these 5
commits were in it, so every issue above was live on `main`. On the user's instruction these were
rebased onto the merged `main` (all touched files were byte-identical between `7b11a4a` and
`origin/main`, so the replay was conflict-free) and pushed directly to `main`.

`.polly/` is gitignored repo-wide ("agent orchestration state ... never part of a feature
branch"), so these review notes and the verification scripts were committed with `git add -f` to
satisfy the write-incrementally protocol. **They are safe to delete from `main` if unwanted** —
`.polly/review/verify-all.sh` is the only piece worth keeping, as a reusable gate.
