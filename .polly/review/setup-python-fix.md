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
