#!/usr/bin/env bash
# Full verification suite for PR #14. Run from the repo root:
#   bash .polly/review/verify-all.sh
#
# Every check prints its own PASS/FAIL and the script exits non-zero if any failed,
# so this is runnable as a gate rather than something a human has to read carefully.
set -uo pipefail

fails=0
note() { printf '\n=== %s ===\n' "$1"; }
ck() { if [ "$1" -eq 0 ]; then echo "PASS"; else echo "FAIL"; fails=$((fails + 1)); fi; }

note "1. Every workflow + action YAML parses"
# Glob the actions dir rather than naming databricks-setup: ensure-python was added for
# blocker 7, and a hardcoded list silently stops covering new composite actions.
for f in .github/workflows/*.yml .github/actions/*/action.yml; do
  python3 -c "import yaml,sys; yaml.safe_load(open('$f')); print('OK  $f')" || fails=$((fails + 1))
done

note "2. bash -n on every script under scripts/ and .github/scripts/"
for f in $(find scripts .github/scripts -name '*.sh' | sort); do
  if bash -n "$f" 2>/dev/null; then echo "OK  $f"; else echo "FAIL $f"; bash -n "$f"; fails=$((fails + 1)); fi
done

note "2b. bash -n on every embedded run: block in the YAML"
python3 .polly/review/verify-run-shell.py >/tmp/runshell.out 2>&1
ck $?
tail -2 /tmp/runshell.out

note "3a. zero \`cache:\` inputs on any setup-* step (parsed, not grepped)"
python3 .polly/review/verify-setup-inputs.py >/tmp/setupin.out 2>&1
ck $?
tail -1 /tmp/setupin.out

note "3b. zero mapfile/readarray in scripts/lakebase/ outside comments"
if grep -rn 'mapfile\|readarray' scripts/lakebase/ | grep -vE ':[[:space:]]*#'; then
  echo "FAIL: real code hit"; fails=$((fails + 1))
else
  echo "PASS: no mapfile/readarray outside comments"
fi

note "3c. no hardcoded brew prefix (BREW_PREFIX must come from brew --prefix)"
grep -rn 'BREW_PREFIX=' .github/ || true
if grep -rqn 'BREW_PREFIX=/' .github/; then
  echo "FAIL: hardcoded prefix"; fails=$((fails + 1))
else
  echo "PASS: all BREW_PREFIX values derived from brew --prefix"
fi

note "3d. 6/6 jobs on [self-hosted, macOS, ARM64] labels; zero ubuntu-latest"
python3 - <<'PY' || exit 1
import glob, sys, yaml
n = 0; bad = []
for f in sorted(glob.glob('.github/workflows/*.yml')):
    d = yaml.safe_load(open(f))
    for jn, j in d['jobs'].items():
        r = j.get('runs-on'); n += 1
        ok = isinstance(r, list) and sorted(r) == sorted(['self-hosted', 'macOS', 'ARM64'])
        print(f"  {'OK  ' if ok else 'FAIL'} {f}::{jn} runs-on={r}")
        if not ok: bad.append((f, jn))
print(f"  {n} jobs; expected 6")
sys.exit(0 if (not bad and n == 6) else 1)
PY
ck $?

note "3e. zero ubuntu-latest as an actual runs-on value"
# Comment-aware: deploy-main.yml legitimately MENTIONS ubuntu-latest in prose
# ("on ubuntu-latest python3 is guaranteed; on a bare macOS box it is a stub"),
# which is documentation of why setup-python exists, not a runner selection.
# Check 3d already proves all 6 runs-on values structurally, so this only has to
# catch a stray non-comment occurrence.
grep -rn 'ubuntu-latest' .github/ || echo "(no matches at all)"
if grep -rn 'ubuntu-latest' .github/ | grep -vE ':[[:space:]]*#' | grep -vE '#.*ubuntu-latest'; then
  echo "FAIL: ubuntu-latest outside a comment"; fails=$((fails + 1))
else
  echo "PASS: ubuntu-latest appears only in comments"
fi

note "3f. zero REAL apt-get invocations (comments referencing it are fine)"
grep -rn 'apt-get' .github/ scripts/ || echo "(no matches at all)"
if grep -rn 'apt-get' .github/ scripts/ | grep -vE ':[[:space:]]*#' | grep -vE '#.*apt-get'; then
  echo "FAIL: real apt-get invocation"; fails=$((fails + 1))
else
  echo "PASS: apt-get appears only in comments"
fi

note "3g. zero -pooler host USES (docs warning against it are correct and stay)"
# The constraint is "never CONNECT to the -pooler host", not "never mention it".
# lakebase/README.md documents both hostnames and warns to use the direct one, and
# 003_grants_advisor.sql carries the same warning as a SQL comment -- both are the
# safety documentation, so removing them would be a regression. Fail only on a
# -pooler string that is not on a comment/doc line.
grep -rn -- '-pooler' .github/ scripts/ lakebase/ caltrans-whatif/databricks.yml 2>/dev/null || echo "(no matches at all)"
if grep -rn -- '-pooler' .github/ scripts/ caltrans-whatif/databricks.yml 2>/dev/null \
     | grep -vE ':[[:space:]]*#' | grep -vE '#.*-pooler'; then
  echo "FAIL: -pooler used outside a comment in shell/workflow/bundle config"; fails=$((fails + 1))
else
  echo "PASS: -pooler appears only in prose/comments warning against it; no code connects to it"
fi

note "3h. databricks/setup-cli pinned to exact v1.7.0"
grep -rn 'setup-cli@' .github/
if grep -rn 'setup-cli@' .github/ | grep -vq 'setup-cli@v1\.7\.0'; then
  echo "FAIL: a non-v1.7.0 pin exists"; fails=$((fails + 1))
else
  echo "PASS: all pins are v1.7.0"
fi

note "3i. blocker 7: zero setup-python USES, zero bare \`python\`, all 3 sites on ensure-python"
python3 - <<'PY' || exit 1
import glob, re, sys, yaml
# Structural, not grep: these files legitimately DISCUSS setup-python and bare `python` in
# comments explaining why they were removed, so scan parsed `uses:`/`run:` values only.
need = {'.github/workflows/ci.yml', '.github/workflows/deploy-main.yml',
        '.github/workflows/preview-up.yml'}
bad = []
for f in sorted(glob.glob('.github/workflows/*.yml')) + sorted(glob.glob('.github/actions/*/action.yml')):
    d = yaml.safe_load(open(f))
    steps = ([s for j in d['jobs'].values() for s in (j.get('steps') or [])]
             if 'jobs' in d else list(d['runs'].get('steps') or []))
    uses = [s.get('uses') or '' for s in steps]
    if any('setup-python' in u for u in uses):
        bad.append(f'{f}: still USES actions/setup-python'); continue
    for s in steps:
        code = '\n'.join(l for l in (s.get('run') or '').split('\n')
                         if not l.strip().startswith('#'))
        if re.search(r'(^|[^\w./-])python(\s|$)', code, re.M):
            bad.append(f"{f}: bare `python` in step {s.get('name')!r}")
        if re.search(r'\bsudo\b', code):
            bad.append(f"{f}: sudo in step {s.get('name')!r}")
    if f in need:
        if not any(u.endswith('/actions/ensure-python') for u in uses):
            bad.append(f'{f}: does NOT use ./.github/actions/ensure-python')
        else:
            print(f'  OK   {f}: uses ensure-python')
for b in bad: print('  FAIL', b)
print('  => all 3 setup-python sites replaced; no bare python; no sudo' if not bad else '  => REGRESSION')
sys.exit(1 if bad else 0)
PY
ck $?

note "4. command -v jq guard present in each workflow that needs it"
python3 - <<'PY' || exit 1
import glob, sys, yaml
# Which workflows reach jq: the preview pair (scripts + the composite action's
# identity check). ci.yml -> bundle-validate.sh (no jq); deploy-main.yml ->
# apply.sh (parses JSON with python3).
need = {'.github/workflows/preview-up.yml', '.github/workflows/preview-down.yml'}
bad = []
for f in sorted(glob.glob('.github/workflows/*.yml')):
    d = yaml.safe_load(open(f))
    runs = ' '.join(
        s.get('run', '') for j in d['jobs'].values() for s in (j.get('steps') or [])
    )
    has_guard = 'command -v jq' in runs
    has_install = 'brew install jq' in runs
    has_assert = 'jq --version' in runs
    want = f in need
    ok = (has_guard and has_install and has_assert) if want else True
    print(f"  {'OK  ' if ok else 'FAIL'} {f}: needs_jq={want} guard={has_guard} "
          f"install={has_install} assert={has_assert}")
    if not ok: bad.append(f)
sys.exit(1 if bad else 0)
PY
ck $?

note "5. ci.yml fork-guard evaluated for pull_request (same-repo AND fork) and push"
python3 .polly/review/verify-fork-guard.py >/tmp/forkguard.out 2>&1
ck $?
tail -1 /tmp/forkguard.out

note "6. concurrency groups pairwise distinct across workflows"
python3 - <<'PY' || exit 1
import glob, sys, yaml
g = {}
for f in sorted(glob.glob('.github/workflows/*.yml')):
    c = yaml.safe_load(open(f)).get('concurrency')
    print(f"  {f}: {c}")
    if c: g.setdefault(c['group'], []).append(f)
clash = {k: v for k, v in g.items() if len(v) > 1}
print(f"  collisions: {clash or 'none'}")
sys.exit(1 if clash else 0)
PY
ck $?

note "7. bash-4-only constructs anywhere in shell (must be none)"
found=0
for pat in 'mapfile' 'readarray' 'declare -A' 'local -A' 'declare -g' 'local -n' '&>>' ',,}' '\^\^}'; do
  hits=$(grep -rn -- "$pat" scripts/ .github/ 2>/dev/null | grep -vE ':[[:space:]]*#' | grep -vE '#.*'"$(printf '%s' "$pat" | sed 's/[^a-zA-Z]//g')" || true)
  if [ -n "$hits" ]; then echo "HIT $pat:"; echo "$hits"; found=1; fi
done
if [ "$found" -eq 0 ]; then echo "PASS: no bash-4-only constructs outside comments"; else echo "(review hits above)"; fi

printf '\n============================\n'
if [ "$fails" -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "$fails CHECK(S) FAILED"; fi
exit "$fails"
