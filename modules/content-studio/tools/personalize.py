#!/usr/bin/env python3
"""Make a learner's own copy of the studio page with their shop profile filled in.

  python3 tools/personalize.py --profile my-shop.json --out my-studio.html
  python3 tools/personalize.py --profile my-shop.json --logo logo.png --hook https://hook.eu2.make.com/xxx

The profile keys are the ones the page understands (see examples/profile.example.json).
The page still lets the learner edit everything; this only sets what it starts with.
A copy that carries --hook can post to the learner's Page, so it must stay on their own
computer: never upload it to a public website or a shared drive.
"""
import argparse
import base64
import json
import mimetypes
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TEMPLATE = ROOT / "webapp" / "studio.html"
PRESET = re.compile(r'(<script id="preset" type="application/json">)(.*?)(</script>)', re.S)
KEYS = ("shop", "sells", "audience", "tone", "signoff", "hashtags", "avoid", "style", "color", "logo")
HOOK = re.compile(r"^https://hook\.[a-z0-9.]+make\.com/[A-Za-z0-9]+$")
COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")
MAX_LOGO = 400_000


def clean_profile(raw: dict) -> dict:
    unknown = sorted(set(raw) - set(KEYS))
    if unknown:
        sys.exit("unknown profile keys: " + ", ".join(unknown))
    profile = {k: str(raw[k]).strip() for k in KEYS if k in raw and raw[k] is not None}
    if "color" in profile and not COLOR.match(profile["color"]):
        sys.exit(f"color must look like #c2410c, got {profile['color']!r}")
    if profile.get("logo") and not profile["logo"].startswith("data:image/"):
        sys.exit("logo inside the profile must be a data:image/... URL; pass a file with --logo instead")
    return profile


def logo_data_url(path: Path) -> str:
    data = path.read_bytes()
    if len(data) > MAX_LOGO:
        sys.exit(f"logo is {len(data) // 1000} KB; shrink it under {MAX_LOGO // 1000} KB first")
    mime = mimetypes.guess_type(path.name)[0] or ""
    if not mime.startswith("image/"):
        sys.exit(f"{path.name} is not an image")
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def render(template: str, preset: dict) -> str:
    # "</" inside a script block would close it early; JSON allows the escaped form.
    payload = json.dumps(preset, ensure_ascii=False).replace("</", "<\\/")
    out, n = PRESET.subn(lambda m: m.group(1) + payload + m.group(3), template, count=1)
    if n != 1:
        sys.exit("preset block not found in the template")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--profile", required=True, help="shop profile JSON")
    ap.add_argument("--logo", help="logo image file (png/jpg/webp, under 400 KB)")
    ap.add_argument("--hook", help="the learner's Make webhook address (keeps the copy private)")
    ap.add_argument("--out", default="my-studio.html")
    args = ap.parse_args()

    profile = clean_profile(json.loads(Path(args.profile).read_text(encoding="utf-8")))
    if args.logo:
        profile["logo"] = logo_data_url(Path(args.logo))
    preset = {"profile": profile}
    if args.hook:
        if not HOOK.match(args.hook.strip()):
            sys.exit("hook must look like https://hook.<zone>.make.com/<id>")
        preset["hook"] = args.hook.strip()

    out = Path(args.out)
    out.write_text(render(TEMPLATE.read_text(encoding="utf-8"), preset), encoding="utf-8")
    print(f"wrote {out} for {profile.get('shop') or 'unnamed shop'}" + (" (with Make link: keep it private)" if args.hook else ""))


if __name__ == "__main__":
    main()
