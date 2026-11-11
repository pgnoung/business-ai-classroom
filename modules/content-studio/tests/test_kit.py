#!/usr/bin/env python3
"""Checks for the Content Studio Quick kit. Standard library only:

  python3 -m unittest discover -s skills/content-studio-quick/tests -v
"""
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KIT / "tools"))
import build_blueprints as bb  # noqa: E402
import personalize as pz  # noqa: E402

BLUEPRINT = json.loads((KIT / "blueprints" / bb.FILE).read_text())
PAGE = (KIT / "webapp" / "studio.html").read_text()


def modules(flow: list) -> list:
    out = []
    for m in flow:
        out.append(m)
        out += m.get("onerror", [])
        for r in m.get("routes", []):
            out += modules(r["flow"])
    return out


class BlueprintTest(unittest.TestCase):
    def test_file_matches_builder(self) -> None:
        self.assertEqual((KIT / "blueprints" / bb.FILE).read_text(), bb.dump(bb.studio({})))

    def test_student_file_has_no_account_ids(self) -> None:
        for m in modules(BLUEPRINT["flow"]):
            self.assertNotIn("__IMTCONN__", m.get("parameters") or {}, m["id"])
            self.assertNotIn("hook", m.get("parameters") or {}, m["id"])
            self.assertNotIn("makeConnectionId", m.get("parameters") or {}, m["id"])
        post = next(m for m in modules(BLUEPRINT["flow"]) if m["module"].startswith("facebook-pages"))
        self.assertEqual(post["mapper"]["page_id"], "")

    def test_every_route_answers_the_page_with_cors(self) -> None:
        router = BLUEPRINT["flow"][1]
        actions = set()
        for route in router["routes"]:
            last = route["flow"][-1]
            self.assertEqual(last["module"], "gateway:WebhookRespond")
            headers = {h["key"]: h["value"] for h in last["mapper"]["headers"]}
            self.assertEqual(headers["Access-Control-Allow-Origin"], "*")
            first = route["flow"][0]
            actions.add(first["filter"]["conditions"][0][0]["b"])
            for m in route["flow"]:
                if m["module"] not in ("gateway:WebhookRespond",):
                    kinds = [e["module"] for e in m.get("onerror", [])]
                    self.assertEqual(kinds, ["gateway:WebhookRespond", "builtin:Ignore"], m["id"])
        self.assertEqual(actions, {"ping", "caption", "image", "post"})

    def test_image_routes_are_mutually_exclusive(self) -> None:
        routes = [r for r in BLUEPRINT["flow"][1]["routes"] if r["flow"][0]["filter"]["conditions"][0][0]["b"] == "image"]
        self.assertEqual(len(routes), bb.MAX_REFS + 1)
        for count in range(bb.MAX_REFS + 1):
            sent = {f"{{{{1.ref{i}_b64}}}}" for i in range(1, count + 1)}
            hits = 0
            for r in routes:
                conds = r["flow"][0]["filter"]["conditions"][0][1:]
                ok = all((c["a"] in sent) == (c["o"] == "exist") for c in conds)
                hits += ok
            self.assertEqual(hits, 1, f"{count} refs must match exactly one route")

    def test_numbers_stay_numbers(self) -> None:
        cap = next(m for m in modules(BLUEPRINT["flow"]) if m["module"] == "openai-gpt-3:CreateCompletion")
        self.assertIsInstance(cap["mapper"]["max_tokens"], int)
        self.assertIs(cap["mapper"]["parseJSONResponse"], False)

    def test_only_the_teacher_copy_carries_a_rate_cap(self) -> None:
        self.assertNotIn("scheduling", BLUEPRINT)
        teacher = bb.studio(dict(hook=1, openai_conn=2, fb_conn=3, page_id="4"))
        self.assertEqual(teacher["scheduling"]["maximum_runs_per_minute"], 100)

    def test_teacher_ids_never_land_in_blueprints_folder(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as f:
            json.dump(dict(hook=1, openai_conn=2, fb_conn=3, page_id="4"), f)
        run = subprocess.run([sys.executable, str(KIT / "tools" / "build_blueprints.py"), "--teacher", f.name],
                             capture_output=True, text=True)
        self.assertNotEqual(run.returncode, 0)
        self.assertEqual((KIT / "blueprints" / bb.FILE).read_text(), bb.dump(bb.studio({})))


class PageTest(unittest.TestCase):
    def test_page_calls_only_actions_the_blueprint_knows(self) -> None:
        called = set(re.findall(r'call\("(\w+)"', PAGE))
        self.assertEqual(called, {"ping", "caption", "image", "post"})

    def test_page_sends_fields_the_blueprint_reads(self) -> None:
        text = json.dumps(BLUEPRINT, ensure_ascii=False)
        for field in ("shop", "sells", "audience", "tone", "signoff", "hashtags", "avoid", "brief", "extra",
                      "prompt", "size", "quality", "caption", "image_b64", "publish_date"):
            self.assertIn("{{1." + field, text.replace("ifempty(1.", "{{1.").replace("if(1.", "{{1.")
                          .replace("toBinary(1.", "{{1."), field)

    def test_page_has_no_secrets_or_remote_scripts(self) -> None:
        self.assertNotRegex(PAGE, r"hook\.[a-z0-9]+\.make\.com/[a-z0-9]{20,}")
        self.assertNotRegex(PAGE, r"sk-[A-Za-z0-9]{20,}")
        self.assertNotRegex(PAGE, r"<script[^>]+src=")
        self.assertNotIn("innerHTML", PAGE)

    def test_escape_never_confirms_a_post(self) -> None:
        self.assertRegex(PAGE, r'\$\("#confirm"\)\.returnValue = "";\s*\$\("#confirm"\)\.showModal\(\)')
        self.assertIn('$("#confirm").returnValue === "yes"', PAGE)

    def test_post_is_sent_only_after_a_live_ping(self) -> None:
        body = PAGE[PAGE.index("async function send()"):PAGE.index("function renderHistory()")]
        self.assertLess(body.index('call("ping"'), body.index('call("post"'))
        self.assertIn("return;", body[:body.index('call("post"')])

    def test_make_queue_and_learning_answers_are_explained(self) -> None:
        for text in ('"Accepted"', '"Successfully determined."', "410"):
            self.assertIn(text, PAGE)

    def test_each_page_file_keeps_its_own_storage(self) -> None:
        self.assertIn('const NS = "csq:" + location.pathname', PAGE)
        self.assertIn('store.get("preset", "") !== presetKey', PAGE)

    def test_page_stays_small(self) -> None:
        self.assertLess(len(PAGE.splitlines()), 800)


class PersonalizeTest(unittest.TestCase):
    def test_render_injects_profile_and_escapes_script_end(self) -> None:
        out = pz.render(PAGE, {"profile": {"shop": "ร้าน</script><b>x"}})
        block = re.search(r'<script id="preset" type="application/json">(.*?)</script>', out, re.S).group(1)
        self.assertEqual(json.loads(block)["profile"]["shop"], "ร้าน</script><b>x")
        self.assertNotIn("</script><b>", block)

    def test_example_profile_is_clean(self) -> None:
        raw = json.loads((KIT / "examples" / "profile.example.json").read_text())
        self.assertEqual(pz.clean_profile(raw)["shop"], "ครัวป้านวล")

    def test_rejects_bad_input(self) -> None:
        with self.assertRaises(SystemExit):
            pz.clean_profile({"shop": "x", "password": "y"})
        with self.assertRaises(SystemExit):
            pz.clean_profile({"color": "red"})
        with self.assertRaises(SystemExit):
            pz.clean_profile({"logo": "https://example.com/logo.png"})


if __name__ == "__main__":
    unittest.main()
