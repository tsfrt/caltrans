#!/usr/bin/env python3
"""Extract every `run:` script from the workflows + composite action and `bash -n` it.

`bash -n` on the scripts/ files does not cover shell embedded in YAML, which is where
most of this PR's new code lives. GitHub expands ${{ }} before the shell ever sees it,
so those are replaced with a placeholder token rather than left to break the parse.
"""
import glob
import re
import subprocess
import sys
import tempfile

import yaml

EXPR = re.compile(r"\$\{\{[^}]*\}\}")
# Glob the composite actions rather than naming them: ensure-python was added for blocker 7
# and carries the Homebrew provisioning shell, so a hardcoded list would skip exactly the
# new code this check exists to cover.
files = sorted(glob.glob(".github/workflows/*.yml")) + sorted(
    glob.glob(".github/actions/*/action.yml")
)

fail = 0
checked = 0
for f in files:
    d = yaml.safe_load(open(f))
    if "jobs" in d:
        blocks = [
            (jn, s)
            for jn, j in d["jobs"].items()
            for s in (j.get("steps") or [])
        ]
    else:
        blocks = [("<composite>", s) for s in d["runs"]["steps"]]

    for jn, s in blocks:
        script = s.get("run")
        if not script:
            continue
        name = s.get("name") or "<unnamed>"
        # github-script steps are JS, not shell.
        if "github-script" in (s.get("uses") or ""):
            continue
        sanitized = EXPR.sub("EXPR_PLACEHOLDER", script)
        with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as tf:
            tf.write(sanitized)
            path = tf.name
        r = subprocess.run(
            ["bash", "-n", path], capture_output=True, text=True
        )
        checked += 1
        status = "OK  " if r.returncode == 0 else "FAIL"
        print(f"{status} {f} :: {jn} :: {name}")
        if r.returncode != 0:
            print(r.stderr)
            fail = 1

print(f"\n{checked} embedded run: blocks checked")
sys.exit(fail)
