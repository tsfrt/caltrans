#!/usr/bin/env python3
"""Structurally assert no setup-node/setup-python step carries a `cache:` input.

Greps see comments; this parses the YAML and looks at the actual `with:` mapping,
which is the only thing the Actions runner reads.
"""
import glob
import sys

import yaml

bad = []
for f in sorted(glob.glob(".github/workflows/*.yml")):
    d = yaml.safe_load(open(f))
    for jn, j in (d.get("jobs") or {}).items():
        for s in j.get("steps") or []:
            u = s.get("uses", "") or ""
            if "setup-node" in u or "setup-python" in u:
                w = s.get("with") or {}
                print(f"{f} :: job={jn} :: {u} :: with={w}")
                for k in ("cache", "cache-dependency-path"):
                    if k in w:
                        bad.append(f"{f}:{jn}:{u} has {k}={w[k]!r}")

print()
if bad:
    print("FAIL: cache inputs still present:")
    for b in bad:
        print("  " + b)
    sys.exit(1)
print("PASS: no `cache:` / `cache-dependency-path:` input on any setup-* step")
