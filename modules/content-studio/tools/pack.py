#!/usr/bin/env python3
"""Zip the kit for learners, failing closed if anything private would ship.

  python3 tools/pack.py --out ~/Downloads/content-studio.zip

Leaves out the learner's own files (my-*), caches and .DS_Store.
Stops if a file carries a live Make webhook, an OpenAI key, or a connection id.
"""
import argparse
import re
import sys
import zipfile
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {"__pycache__", ".git"}
SKIP_FILES = re.compile(r"^(my-.*|\.DS_Store)$")
LEAKS = [
    (re.compile(r"hook\.[a-z0-9]+\.make\.com/[a-z0-9]{20,}"), "live Make webhook"),
    (re.compile(r"sk-[A-Za-z0-9_-]{20,}"), "OpenAI key"),
    (re.compile(r'"__IMTCONN__":\s*\d'), "Make connection id"),
    (re.compile(r'"hook":\s*\d'), "Make webhook id"),
    (re.compile(r'"page_id":\s*"\d'), "Facebook Page id"),
]


def files() -> list:
    out = []
    for p in sorted(KIT.rglob("*")):
        rel = p.relative_to(KIT)
        if p.is_dir() or SKIP_DIRS & set(rel.parts) or SKIP_FILES.match(p.name):
            continue
        out.append(p)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, help="zip path (keep it outside git)")
    ap.add_argument("--folder", default="content-studio", help="folder name inside the zip")
    args = ap.parse_args()

    found = []
    for p in files():
        text = p.read_text(encoding="utf-8", errors="ignore")
        found += [f"{p.relative_to(KIT)}: {label}" for rx, label in LEAKS if rx.search(text)]
    if found:
        sys.exit("refusing to pack:\n  " + "\n  ".join(found))

    out = Path(args.out).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in files():
            z.write(p, f"{args.folder}/{p.relative_to(KIT)}")
    print(f"wrote {out} ({len(files())} files, {out.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
