#!/usr/bin/env python3
"""Evaluate ci.yml's fork guard against real event payload shapes.

Implements the two GitHub expression semantics the guard depends on, both taken
from the Actions docs rather than assumed:
  1. "If you attempt to dereference a nonexistent property, it will evaluate to
     an empty string."  -> push payloads have no `pull_request`, so the chain
     yields '' rather than erroring.
  2. `||` short-circuits, and loose `==` coerces null and '' to 0.

Asserts every job in ci.yml carries the guard, then truth-tables it.
"""
import glob
import sys

import yaml

REPO = "tsfrt/caltrans"


def deref(obj, path):
    """GitHub property dereference: missing property -> empty string."""
    cur = obj
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return ""
        cur = cur[part]
    return "" if cur is None else cur


def guard(event_name, payload):
    """github.event_name != 'pull_request' || (head.repo.full_name == github.repository)"""
    if event_name != "pull_request":
        return True  # short-circuits; second clause never evaluated
    return deref(payload, "pull_request.head.repo.full_name") == REPO


CASES = [
    ("push to main", "push", {"ref": "refs/heads/main", "commits": []}, True,
     "event_name is 'push' -> first clause true, short-circuits. pull_request "
     "absent, but never dereferenced."),
    ("workflow_dispatch", "workflow_dispatch", {}, True,
     "any non-pull_request event passes the first clause."),
    ("PR from same repo", "pull_request",
     {"pull_request": {"head": {"repo": {"full_name": "tsfrt/caltrans"}}}}, True,
     "first clause false; 'tsfrt/caltrans' == 'tsfrt/caltrans' -> true."),
    ("PR from a fork", "pull_request",
     {"pull_request": {"head": {"repo": {"full_name": "attacker/caltrans"}}}}, False,
     "first clause false; 'attacker/caltrans' != 'tsfrt/caltrans' -> SKIPPED."),
    ("PR, deleted fork (repo null)", "pull_request",
     {"pull_request": {"head": {"repo": None}}}, False,
     "repo is null -> deref yields ''; '' != 'tsfrt/caltrans' -> SKIPPED (fails closed)."),
]

print("=== ci.yml: every job carries the guard? ===")
d = yaml.safe_load(open(".github/workflows/ci.yml"))
missing = []
for jn, j in d["jobs"].items():
    cond = (j.get("if") or "").strip()
    ok = "github.event_name != 'pull_request'" in cond and \
         "head.repo.full_name == github.repository" in cond
    print(f"  {'OK  ' if ok else 'FAIL'} job={jn}: if={cond!r}")
    if not ok:
        missing.append(jn)
print(f"  concurrency: {d.get('concurrency')}")

print("\n=== truth table ===")
fail = bool(missing)
for name, ev, payload, expect, why in CASES:
    got = guard(ev, payload)
    status = "OK  " if got == expect else "FAIL"
    verdict = "RUNS" if got else "SKIPPED"
    if got != expect:
        fail = True
    print(f"  {status} {name:32s} -> {verdict:8s} (expected {'RUNS' if expect else 'SKIPPED'})")
    print(f"       {why}")

print("\n=== counter-example: the naive single-clause guard ===")
naive = lambda p: deref(p, "pull_request.head.repo.full_name") == REPO
push_payload = {"ref": "refs/heads/main"}
print(f"  push with one-clause guard -> {'RUNS' if naive(push_payload) else 'SKIPPED'}"
      "   <-- why the event_name clause is required")
assert not naive(push_payload), "expected the naive guard to break push"

print()
if fail:
    print("FAIL")
    sys.exit(1)
print("PASS: guard holds for push, workflow_dispatch, same-repo PR, fork PR")
