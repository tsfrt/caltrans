#!/usr/bin/env bash
# Remove the ADVISOR_SELF_URL entry from caltrans-whatif/app.yaml, in place.
#
#   scripts/preview/strip-self-url.sh
#
# WHY: app.yaml hardcodes the PRODUCTION app's public URL, and app.yaml supports no variable
# interpolation, so a preview app deployed from this source tree would self-probe production —
# writing its startup SSE diagnostic into production's app.audit and attributing the result to
# the wrong deployment. The correct URL is not knowable before deploy (it contains the app name
# and workspace id and is only readable from `apps get` afterwards).
#
# Unsetting the variable makes server/advisor/selfprobe.ts no-op the probe. That is the fix the
# file's own comment recommends, and losing a startup diagnostic is an acceptable trade for a
# throwaway preview. The alternative — deploy, read .url, rewrite app.yaml, deploy again —
# doubles preview deploy time to buy a diagnostic nobody reads on a PR.
#
# This mutates the CI checkout only. It is never committed, and production deploys never call it,
# so the production path keeps its real URL.
#
# Idempotent: a second run is a no-op.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

APP_YAML="caltrans-whatif/app.yaml"
[[ -f "$APP_YAML" ]] || { printf 'error: %s not found\n' "$APP_YAML" >&2; exit 1; }

# All matching lives in Python, using ONE regex for both "is it there?" and "remove it".
# Splitting those across a `grep` pre-check and a Python parser is how the first version of this
# script broke: grep matched the word inside the surrounding YAML comments, the parser matched
# only real `- name:` keys, and they disagreed on an already-stripped file.
python3 - "$APP_YAML" <<'PY'
import re, sys

path = sys.argv[1]
ENTRY = re.compile(r'\s*-\s+name:\s*ADVISOR_SELF_URL\s*$')

lines = open(path).read().splitlines(keepends=True)
out, i, removed = [], 0, False

while i < len(lines):
    if ENTRY.match(lines[i]):
        removed = True
        i += 1
        # Consume the entry's continuation lines: more-indented, and not a new `- ` list item.
        while i < len(lines):
            nxt = lines[i]
            if not nxt.strip():                 # blank line ends the entry
                i += 1
                break
            if re.match(r'\s*-\s', nxt):        # next list item
                break
            if not nxt.startswith((' ', '\t')): # dedent to top level
                break
            i += 1
        continue
    out.append(lines[i])
    i += 1

if not removed:
    print('::notice::ADVISOR_SELF_URL not set in %s; nothing to strip' % path)
    sys.exit(0)

open(path, 'w').writelines(out)

# Re-parse to prove the result is still valid YAML AND that the key is really gone. Writing a
# malformed app.yaml would fail later, at deploy time, with a much worse error message.
try:
    import yaml
except ImportError:
    print('::warning::pyyaml unavailable; skipped post-strip YAML re-parse')
else:
    env = yaml.safe_load(open(path)).get('env') or []
    names = [e.get('name') for e in env]
    if 'ADVISOR_SELF_URL' in names:
        sys.exit('::error::ADVISOR_SELF_URL still present after strip: %r' % (names,))
    print('::notice::env after strip: %s' % ', '.join(n for n in names if n))

print('::notice::Stripped ADVISOR_SELF_URL from %s (self-probe disabled for this preview)' % path)
PY
