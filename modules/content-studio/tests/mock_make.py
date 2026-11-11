#!/usr/bin/env python3
"""Stand-in for the learner's Make webhook so the page can be tried without Make.

Serves the kit folder at http://127.0.0.1:<port>/ (webapp/studio.html, my-studio.html) and answers POST /hook the way
blueprints/studio.json does. GET /last shows what the page sent last (sizes only).

  python3 tests/mock_make.py --port 5480
"""
import argparse
import base64
import json
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

WEB = Path(__file__).resolve().parent.parent
# 64x64 brand-orange JPEG, enough for the page to show "a picture came back".
DOT = (
    "/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAQK"
    "ADAAQAAAABAAAAQAAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAQABA"
    "AwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicR"
    "QygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SV"
    "lpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAA"
    "ABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJico"
    "KSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8"
    "jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABAQEBAQEBgQEBgkGBgYJDAkJCQkMDwwMDAwMDxIPDw8PDw8SEhISEhISEhUVFRUV"
    "FRkZGRkZHBwcHBwcHBwcHP/bAEMBBAUFBwcHDAcHDB0UEBQdHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR0dHR"
    "0dHf/dAAQABP/aAAwDAQACEQMRAD8A4Oiiivx8/ooKKKKACiiigAooooA//9Dg6KKK/Hz+igooooAKKKKACiiigD//0eDooor8fP6KCiiigAoo"
    "ooAKKKKAP//S4Oiiivx8/ooKKKKACiiigAooooA//9k="
)
CAPTIONS = [
    "มื้อเที่ยงนี้ไม่ต้องคิดเยอะ 🌶️\nแกงไตปลาแห้งเมนูใหม่ เริ่มขายพรุ่งนี้\n#ทดสอบ",
    "เมื่อวานป้าลองสูตรใหม่ให้ลูกค้าประจำชิม\nทุกคนขอเพิ่มข้าวกันหมด\n#ทดสอบ",
    "ไตปลาแห้งมาแล้ววว 🔥\n#ทดสอบ",
]
LAST: dict = {}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(WEB), **kw)

    def end_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def reply(self, body: dict, status: int = 200) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:
        if self.path == "/last":
            return self.reply(LAST)
        return super().do_GET()

    def do_POST(self) -> None:
        if self.path != "/hook":
            return self.reply({"error": "not found"}, 404)
        size = int(self.headers.get("Content-Length", 0))
        form = {k: v[0] for k, v in parse_qs(self.rfile.read(size).decode()).items()}
        action = form.get("action", "")
        LAST.clear()
        LAST.update({k: (len(v) if k.endswith("_b64") else v) for k, v in form.items()})
        if action == "ping":
            return self.reply({"ok": True, "pong": True, "kit": "content-studio-quick"})
        if action == "caption":
            time.sleep(0.6)
            return self.reply({"captions": CAPTIONS})
        if action == "image":
            time.sleep(1.5)
            return self.reply({"ok": True, "b64": form.get("ref1_b64") or DOT})
        if action == "post":
            jpeg = base64.b64decode(form.get("image_b64", ""))[:2] == b"\xff\xd8"
            when = form.get("publish_date")
            ahead = (int(when) / 1000 - time.time()) / 60 if when else 0
            if not jpeg or not form.get("caption") or (when and not 10 <= ahead <= 30 * 24 * 60):
                return self.reply({"ok": False, "error": "post_failed"})
            return self.reply({"ok": True, "id": "mock_404_123", "mode": "scheduled" if when else "now"})
        return self.reply({"ok": False, "error": "unknown_action"})


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5480)
    port = ap.parse_args().port
    print(f"mock Make on http://127.0.0.1:{port}/webapp/studio.html or /my-studio.html  (webhook: http://127.0.0.1:{port}/hook)")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
