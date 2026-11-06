#!/usr/bin/env python3
"""
Lint every ```mermaid block in the repo's markdown.

Exists because the same mistake has now been made twice: a ';' inside diagram text SPLITS the
statement and breaks rendering with no useful error. Catching it by eye has failed, so catch it here.
"""
import re, sys, pathlib

# Scan from the REPO ROOT, not the working directory. The first version used Path("."), which meant
# running it from poc/ silently skipped the repo-root RSKIP — the very file whose diagram broke. A
# linter that passes because it looked nowhere is worse than no linter.
ROOT = pathlib.Path(__file__).resolve().parents[3]

BAD_CHARS = {";": "splits the statement — use '.' or '—' instead"}
problems = []
scanned = 0

for path in sorted(ROOT.rglob("*.md")):
    if any(x in path.parts for x in ("node_modules", ".git", "rskj")): continue
    text = path.read_text(encoding="utf8", errors="replace")
    for m in re.finditer(r"```mermaid\n(.*?)```", text, re.S):
        start = text[:m.start()].count("\n") + 2
        body = m.group(1)
        scanned += 1
        kind = body.strip().split("\n")[0].strip()
        for off, line in enumerate(body.split("\n")):
            n, t = start + off, line.strip()
            if not t: continue
            for ch, why in BAD_CHARS.items():
                if ch in t:
                    problems.append(f"{path.relative_to(ROOT)}:{n}: '{ch}' in mermaid text — {why}\n      {t[:90]}")
            if kind.startswith("sequenceDiagram") and not t.startswith(
                ("sequenceDiagram", "autonumber", "participant", "actor", "Note ", "loop", "end",
                 "alt", "else", "opt", "par", "and", "rect", "activate", "deactivate", "%%")):
                if not re.match(r"^[\w\-]+\s*(->>|-->>|->|-->|-x|--x)\s*[\w\-]+\s*:", t):
                    problems.append(f"{path.relative_to(ROOT)}:{n}: not a valid sequence message\n      {t[:90]}")

print("\n".join(f"  {p}" for p in problems) if problems else f"  all mermaid blocks are clean ({scanned} block(s) in {ROOT.name}/)")
sys.exit(1 if problems else 0)
