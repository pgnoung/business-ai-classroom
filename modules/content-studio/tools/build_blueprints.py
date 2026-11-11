#!/usr/bin/env python3
"""Build the one Make blueprint for Content Studio Quick.

One webhook, one router, four jobs picked by the `action` field the web page sends:
ping (setup check) · caption (3 captions) · image (AI picture from 0–3 references) ·
post (post now or schedule on the learner's Facebook Page).

The student file (blueprints/studio.json) carries no account ids: on Import, Make asks
the learner to create a webhook, pick the OpenAI and Facebook connections and the Page.
With --teacher the same flow is filled with real ids so a teacher copy can be created
through Make MCP; that copy must be written outside blueprints/.

  python3 tools/build_blueprints.py                                   # write blueprints/
  python3 tools/build_blueprints.py --check                           # exit 1 on drift
  python3 tools/build_blueprints.py --teacher ids.json --out /tmp/x   # live copy
"""
import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "blueprints"
FILE = "studio.json"

CAPTION_MODEL = "gpt-4.1"
IMAGE_MODEL = "gpt-image-2-2026-04-21"
MAX_REFS = 3

JSON_HEADERS = [
    {"key": "Access-Control-Allow-Origin", "value": "*"},
    {"key": "Content-Type", "value": "application/json; charset=utf-8"},
]

CAPTION_RULES = """คุณคือแอดมินเพจมือโปรของร้านค้าไทย เขียนแคปชันโพสต์ Facebook ภาษาไทย 3 แบบจากข้อมูลร้านและเรื่องที่ได้รับ

กติกา
1. บรรทัดแรกต้องทำให้คนหยุดอ่าน เพราะ Facebook บนมือถือโชว์แค่ราว 3 บรรทัดก่อนคำว่า "ดูเพิ่มเติม"
2. 3 แบบต้องต่างแนวกันชัด: แบบแรกขายตรง เน้นประโยชน์ที่ลูกค้าได้ · แบบที่สองเล่าเรื่องใกล้ตัวลูกค้า · แบบที่สามสั้น สนุก แชร์ง่าย
3. ใช้น้ำเสียงของร้านตามที่บอก ยาว 3–8 บรรทัด ประโยคสั้น อีโมจิพอดี ๆ ห้ามใช้ตัวหนา ดอกจัน หรือ markdown
4. ใช้เฉพาะข้อมูลที่ให้มา ห้ามแต่งราคา โปรโมชั่น ส่วนลด หรือสรรพคุณที่ไม่ได้บอก และห้ามใช้คำที่ร้านห้าม
5. ปิดด้วยคำปิดท้ายของร้านแบบคัดลอกตรงตัว แล้วตามด้วยแฮชแท็ก 3–5 อัน (ใช้แฮชแท็กประจำร้านก่อน)
6. จัดบรรทัดแบบโพสต์ Facebook จริง: ขึ้นบรรทัดใหม่ (\\n) ทุก 1–2 ประโยค · คำปิดท้ายอยู่บรรทัดของตัวเอง · เว้น 1 บรรทัดว่าง (\\n\\n) ก่อนแฮชแท็ก

ตอบเป็น JSON เท่านั้น รูปแบบ {"captions": ["แบบที่ 1", "แบบที่ 2", "แบบที่ 3"]} โดยใช้ \\n ขึ้นบรรทัดภายในแต่ละแบบ"""

CAPTION_INPUT = """ร้าน: {{1.shop}}
ขายอะไร: {{1.sells}}
ลูกค้าหลัก: {{1.audience}}
น้ำเสียงของร้าน: {{1.tone}}
คำปิดท้าย / ช่องทางติดต่อ: {{1.signoff}}
แฮชแท็กประจำร้าน: {{1.hashtags}}
คำที่ห้ามใช้: {{1.avoid}}

โพสต์นี้เกี่ยวกับ: {{1.brief}}
รายละเอียดเพิ่ม: {{1.extra}}"""

REF_NOTE = (
    "\n\nภาพอ้างอิงที่แนบมาคือของจริงของร้าน (โลโก้ / สินค้า / คน) ใช้ให้ตรงตามภาพ "
    "ถ้ามีโลโก้ต้องคงรูปและสีเดิมให้อ่านออก ห้ามวาดโลโก้ใหม่หรือเดาแบรนด์ "
    "ตัวหนังสือไทยบนภาพต้องสะกดถูกและอ่านง่าย"
)


def pos(x: int, y: int = 0, note: str | None = None) -> dict:
    meta = {"designer": {"x": x, "y": y}}
    if note:
        meta["notes"] = [{"text": note}]
    return meta


def conn(value: int | None) -> dict:
    return {"__IMTCONN__": value} if value else {}


def respond(mid: int, body: str, x: int, y: int) -> dict:
    return {"id": mid, "module": "gateway:WebhookRespond", "version": 1, "parameters": {},
            "mapper": {"status": "200", "body": body, "headers": JSON_HEADERS}, "metadata": pos(x, y)}


def on_error(mid: int, error: str, x: int, y: int) -> list:
    """Answer the web page with a known code instead of leaving it waiting, then end the route."""
    return [respond(mid, f'{{"ok": false, "error": "{error}"}}', x, y),
            {"id": mid + 1, "module": "builtin:Ignore", "version": 1, "mapper": {}, "metadata": pos(x + 300, y)}]


def when(action: str, extra: list | None = None) -> dict:
    cond = [{"a": "{{1.action}}", "o": "text:equal", "b": action}] + (extra or [])
    return {"name": f"action = {action}", "conditions": [cond]}


def ping_route() -> dict:
    done = respond(10, '{"ok": true, "pong": true, "kit": "content-studio-quick"}', 600, -300)
    done["filter"] = when("ping")
    return {"flow": [done]}


def caption_route(ids: dict) -> dict:
    ask = {"id": 20, "module": "openai-gpt-3:CreateCompletion", "version": 1,
           "parameters": conn(ids.get("openai_conn")), "filter": when("caption"),
           "mapper": {"select": "chat", "model": CAPTION_MODEL,
                      "messages": [{"role": "system", "content": CAPTION_RULES},
                                   {"role": "user", "content": CAPTION_INPUT}],
                      "max_tokens": 1600, "temperature": 0.9, "top_p": 1, "n_completions": 1,
                      "response_format": "json_object", "parseJSONResponse": False},
           "onerror": on_error(25, "caption_failed", 600, -100),
           "metadata": pos(600, 0, "ต่อ OpenAI ของตัวเอง (API key ของตัวเอง) · อยากเปลี่ยนสไตล์แคปชัน "
                                   "แก้ข้อความ system ในกล่องนี้ได้เลย")}
    return {"flow": [ask, respond(21, "{{20.result}}", 900, 0)]}


def image_route(n: int, ids: dict) -> dict:
    base = 40 + 10 * n
    refs = [{"fileData": f'{{{{toBinary(1.ref{i}_b64; "base64")}}}}', "fileName": f"ref{i}.jpg"}
            for i in range(1, n + 1)]
    extra = [{"a": f"{{{{1.ref{n}_b64}}}}", "o": "exist"}] if n else []
    if n < MAX_REFS:
        extra.append({"a": f"{{{{1.ref{n + 1}_b64}}}}", "o": "notexist"})
    mapper = {"n": 1, "size": '{{ifempty(1.size; "1024x1280")}}', "model": IMAGE_MODEL,
              "prompt": "{{1.prompt}}" + (REF_NOTE if n else ""),
              "quality": '{{ifempty(1.quality; "medium")}}', "background": "opaque",
              "output_format": "jpeg", "output_compression": 82}
    if refs:
        mapper["image"] = refs
    y = 300 + n * 250
    gen = {"id": base, "module": "openai-gpt-3:" + ("editImage" if n else "GenerateImage"), "version": 1,
           "parameters": conn(ids.get("openai_conn")), "mapper": mapper,
           "filter": {**when("image", extra), "name": f"ทำรูป · รูปอ้างอิง {n} รูป"},
           "onerror": on_error(base + 5, "image_failed", 600, y + 120),
           "metadata": pos(600, y, "4 กล่องทำรูปใช้ OpenAI connection เดียวกัน (แยกตามจำนวนรูปอ้างอิง 0–3 รูป)"
                           if n == 0 else None)}
    done = respond(base + 1, f'{{"ok": true, "b64": "{{{{base64({base}.resImgData)}}}}"}}', 900, y)
    return {"flow": [gen, done]}


def post_route(ids: dict) -> dict:
    post = {"id": 30, "module": "facebook-pages:CreatePostWithPhotos", "version": 6,
            "parameters": conn(ids.get("fb_conn")), "filter": when("post"),
            "mapper": {"date": '{{if(1.publish_date; parseDate(1.publish_date; "x"))}}',
                       "photos": [{"type": "data", "data": '{{toBinary(1.image_b64; "base64")}}',
                                   "fileName": "post.jpg"}],
                       "message": "{{1.caption}}", "page_id": ids.get("page_id", "")},
            "onerror": on_error(35, "post_failed", 600, 1500),
            "metadata": pos(600, 1350, "ต่อ Facebook ของตัวเอง แล้วเลือกเพจที่จะโพสต์ · ช่อง Date มีสูตรให้แล้ว: "
                                       "เว็บส่งเวลามา = ตั้งเวลา / ไม่ส่ง = โพสต์ทันที")}
    done = respond(31, '{"ok": true, "id": "{{30.id}}", "mode": "{{if(1.publish_date; "scheduled"; "now")}}"}',
                   900, 1350)
    return {"flow": [post, done]}


def studio(ids: dict) -> dict:
    routes = [ping_route(), caption_route(ids)]
    routes += [image_route(n, ids) for n in range(MAX_REFS + 1)]
    routes.append(post_route(ids))
    hook = {"maxResults": 1}
    if ids.get("hook"):
        hook["hook"] = ids["hook"]
    flow = [
        {"id": 1, "module": "gateway:CustomWebHook", "version": 1, "mapper": {}, "parameters": hook,
         "metadata": pos(0, 0, "กด Add สร้าง webhook ใหม่ ตั้งชื่ออะไรก็ได้ → Save → Copy address "
                               "แล้วไปวางในเว็บ Content Studio ช่อง 'ลิงก์ Make'")},
        {"id": 2, "module": "builtin:BasicRouter", "version": 1, "mapper": None, "routes": routes,
         "metadata": pos(300)},
    ]
    bp = {"name": "⚡ Content Studio — แคปชัน · ทำรูป · โพสต์/ตั้งเวลา", "flow": flow,
          "metadata": {"instant": True, "version": 1, "designer": {"orphans": []}}}
    if ids:
        # Created through Make MCP: without a rate cap inside the blueprint Make switches it off within minutes.
        # The learner's Import file must not carry this key (Import rejects top-level scheduling).
        bp["scheduling"] = {"type": "immediately", "maximum_runs_per_minute": 100}
    return bp


def dump(obj: dict) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=1) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="fail if blueprints/ differs from the builder")
    ap.add_argument("--teacher", help="JSON with hook, openai_conn, fb_conn, page_id")
    ap.add_argument("--out", help="output folder (required with --teacher)")
    args = ap.parse_args()

    ids = json.loads(Path(args.teacher).read_text()) if args.teacher else {}
    out = Path(args.out) if args.out else OUT
    if ids and out.resolve() == OUT.resolve():
        sys.exit("--teacher needs --out outside blueprints/ so live ids never ship")
    text = dump(studio(ids))
    target = out / FILE

    if args.check:
        if not target.exists() or target.read_text() != text:
            sys.exit(f"{target} drifts from the builder; run tools/build_blueprints.py")
        print("blueprint matches builder")
        return
    out.mkdir(parents=True, exist_ok=True)
    target.write_text(text)
    print("wrote", target)


if __name__ == "__main__":
    main()
