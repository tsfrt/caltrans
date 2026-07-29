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
