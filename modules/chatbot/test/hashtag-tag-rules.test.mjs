// hashtag-tag-rules.test.mjs — คีย์เวิร์ด # → ป้าย ของแจก:/กิจกรรม: ที่เจ้าของติ๊กเอง (ข้อ 8 ของพี่ง้วง 28 ก.ย. 2026)
// ค่าเริ่มต้นทุกคำ = ไม่ติด · ติดเฉพาะคำที่ตั้งกติกา · กรอบปิด = ไม่ติด · ทั้งคำที่ลูกแพรตอบและคำที่ LINE OA ตอบ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { validateTagFramework } from "../src/tagFramework.mjs";
import {
  applyHashtagTagRule, hashtagKeywordOf, listHashtagKeywordsSeen, readHashtagTagRules, validateHashtagTagRule,
} from "../src/hashtagTagRules.mjs";
import { hashtagTagsBlock } from "../public/console/settingsHashtagTags.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";
import { fixtureWithPurchase } from "./tagFrameworkFixture.mjs";
import { hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
// กรอบทดสอบ + มิติ กิจกรรม (ของจริงมีทั้ง ของแจก และ กิจกรรม)
const fw = validateTagFramework(fixtureWithPurchase({
  dimensions: [...fixtureWithPurchase().dimensions, { key: "กิจกรรม", setBy: "human", open: true }],
}));

test("hashtag tags: rules are validated — default none, only ของแจก/กิจกรรม, a real name, no colon", () => {
  assert.equal(hashtagKeywordOf("  #Make สนใจค่ะ"), "#make");
  assert.equal(hashtagKeywordOf("สอน C# ไหม"), "");
  assert.deepEqual(validateHashtagTagRule({ keyword: "#make", dimension: "" }, fw), { ok: true, keyword: "#make", rule: null });
  assert.deepEqual(validateHashtagTagRule({ keyword: "#MAKE", dimension: "ของแจก", value: " Make  Cheat Sheet " }, fw),
    { ok: true, keyword: "#make", rule: { dimension: "ของแจก", value: "Make Cheat Sheet" } });
  assert.equal(validateHashtagTagRule({ keyword: "make", dimension: "ของแจก", value: "x" }, fw).ok, false);
  assert.equal(validateHashtagTagRule({ keyword: "#make", dimension: "สนใจ", value: "In-house" }, fw).ok, false, "มิติของ AI ห้ามติดจาก #");
  assert.match(validateHashtagTagRule({ keyword: "#make", dimension: "ของแจก", value: "" }, fw).reason, /ใส่ชื่อของแจก/u);
  assert.equal(validateHashtagTagRule({ keyword: "#make", dimension: "กิจกรรม", value: "a:b" }, fw).ok, false);
  const db = memoryDb();
  db.setSetting("hashtag_tag_rules", JSON.stringify({ "#ok": { dimension: "กิจกรรม", value: "MOS2026" }, "#bad": { dimension: "ขั้น", value: "x" }, broken: 1 }));
  assert.deepEqual(readHashtagTagRules(db), { "#ok": { dimension: "กิจกรรม", value: "MOS2026" } }, "แถวผิดรูปถูกข้าม ไม่เดา");
  db.setSetting("hashtag_tag_rules", "{not json");
  assert.deepEqual(readHashtagTagRules(db), {});
  db.close();
});

test("hashtag tags: a configured keyword tags the room once as the team's tag — nothing without a rule or with the framework off", () => {
  const db = memoryDb();
  db.setSetting("hashtag_tag_rules", JSON.stringify({ "#make": { dimension: "ของแจก", value: "Make Cheat Sheet" } }));
  assert.equal(applyHashtagTagRule({ db, customerId: "U-1", text: "#make", framework: fw, logger: silent }), "ของแจก: Make Cheat Sheet");
  assert.deepEqual(db.listTags("U-1").map((row) => [row.tag, row.source]), [["ของแจก: Make Cheat Sheet", "human"]]);
  assert.ok(db.listAudit().some((row) => row.action === "hashtag_tag_auto" && row.detail === "#make → ของแจก: Make Cheat Sheet"));
  assert.equal(applyHashtagTagRule({ db, customerId: "U-1", text: "#make อีกที", framework: fw, logger: silent }), null, "ติดแล้วไม่ติดซ้ำ");
  assert.equal(applyHashtagTagRule({ db, customerId: "U-2", text: "#other", framework: fw, logger: silent }), null, "ไม่มีกติกา = ไม่ติด (ค่าเริ่มต้น)");
  assert.equal(applyHashtagTagRule({ db, customerId: "U-3", text: "#make", framework: null, logger: silent }), null, "กรอบปิด = ไม่ติด");
  assert.equal(applyHashtagTagRule({ db, customerId: "canary:x", text: "#make", framework: fw, logger: silent }), null);
  assert.deepEqual(db.listTags("U-2"), []);
  db.close();
});

test("hashtag tags: the keywords list only shows words seen in at least two rooms (no one-off customer text)", () => {
  const db = memoryDb();
  const t = Date.now();
  for (const [id, text] of [["U-a", "#make"], ["U-b", "#Make สนใจ"], ["U-a", "#make"], ["U-c", "#ส่วนตัวมาก"], ["U-d", "สวัสดี #make"]]) {
    db.upsertCustomer(id, {});
    db.insertMessage({ customerId: id, direction: "in", content: text });
  }
  assert.deepEqual(listHashtagKeywordsSeen(db, { now: t + 1000 }).map((row) => [row.keyword, row.rooms]), [["#make", 2]]);
  db.close();
});

/* --------------------------- pipeline + console --------------------------- */

function makeApp() {
  const db = memoryDb();
  const passHash = hashPassword("hashtag-tags-pass-123456");
  db.createOperator({ username: "owner", passHash, displayName: "เจ้าของ", role: "owner" });
  db.createOperator({ username: "staff", passHash, displayName: "ทีม", role: "operator" });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: "hashtag-tags-secret" }), db, logger: silent,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {}, tagFramework: fw } });
  return { app, db };
}

test("hashtag tags (pipeline): tags on keywords LINE OA answers and on keywords ลูกแพร answers", async () => {
  const { app, db } = makeApp();
  db.setSetting("hashtag_business_keywords", JSON.stringify({ "#online": "สนใจคลาสเรียนออนไลน์" }));
  db.setSetting("hashtag_tag_rules", JSON.stringify({
    "#make": { dimension: "ของแจก", value: "Make Cheat Sheet" }, "#online": { dimension: "กิจกรรม", value: "Greeting Online" },
  }));
  const silenced = await app.pipeline.handleInboundText({ customerId: "U-make", text: "#make", replyToken: "rt" });
  assert.equal(silenced.suppressed, "hashtag_auto_response", "พฤติกรรมเงียบเดิมไม่เปลี่ยน");
  assert.ok(db.listTags("U-make").some((row) => row.tag === "ของแจก: Make Cheat Sheet"));
  const answered = await app.pipeline.handleInboundText({ customerId: "U-online", text: "#online", replyToken: "rt" });
  assert.equal(answered.sent, true);
  assert.ok(db.listTags("U-online").some((row) => row.tag === "กิจกรรม: Greeting Online"));
  await app.pipeline.handleInboundText({ customerId: "U-plain", text: "#horeca", replyToken: "rt" });
  assert.deepEqual(db.listTags("U-plain"), [], "ไม่มีกติกา = ไม่ติดอะไร");
  db.setSetting("tag_framework_mode", "off");
  await app.pipeline.handleInboundText({ customerId: "U-off", text: "#make", replyToken: "rt" });
  assert.deepEqual(db.listTags("U-off"), [], "ปิดป้ายชุดเดียว = ไม่ติด");
  db.close();
});

async function login(server, username) {
  const res = await httpRequest(server, { method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "hashtag-tags-pass-123456" }) });
  return { cookie: res.headers["set-cookie"][0].split(";")[0], csrf: res.json.csrf };
}
const call = (server, s, method, body = null) => httpRequest(server, {
  method, path: "/console/api/settings/hashtag-tags",
  headers: { cookie: s.cookie, ...(body ? { "content-type": "application/json", "x-csrf-token": s.csrf } : {}) },
  body: body ? JSON.stringify(body) : null,
});

test("hashtag tags (console): owner ticks per keyword, staff can only look, bad values are refused in Thai", async (t) => {
  const { app, db } = makeApp();
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  db.setSetting("hashtag_business_keywords", JSON.stringify({ "#online": "สนใจคลาสเรียนออนไลน์" }));
  const owner = await login(app.server, "owner");
  const staff = await login(app.server, "staff");
  const view = await call(app.server, staff, "GET");
  assert.equal(view.status, 200);
  assert.deepEqual([view.json.canEdit, view.json.active], [false, true]);
  assert.deepEqual(view.json.keywords.map((k) => [k.keyword, k.configured, k.rule]), [["#online", true, null]], "ค่าเริ่มต้น = ไม่ติด");
  assert.equal((await call(app.server, staff, "POST", { keyword: "#online", dimension: "กิจกรรม", value: "x" })).status, 403);
  const bad = await call(app.server, owner, "POST", { keyword: "#online", dimension: "สนใจ", value: "In-house" });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /ไม่ติดป้าย \/ ของแจก \/ กิจกรรม/u);
  const saved = await call(app.server, owner, "POST", { keyword: "#Make", dimension: "ของแจก", value: "Make Cheat Sheet" });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.keywords[0], { keyword: "#make", rooms: 0, lastAt: 0, configured: false, rule: { dimension: "ของแจก", value: "Make Cheat Sheet" } });
  const cleared = await call(app.server, owner, "POST", { keyword: "#make", dimension: "" });
  assert.equal(cleared.json.keywords.find((k) => k.keyword === "#make"), undefined, "ลบกติกาแล้ว คำที่ไม่มีใครพิมพ์หายจากรายการ");
  assert.ok(db.listAudit().filter((row) => row.action === "hashtag_tag_rule").length === 2);
});

test("hashtag tags (settings panel): renders one row per keyword and saves the owner's choice", async (t) => {
  installBrowserGlobals(t);
  const calls = [];
  const notices = [];
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body || null });
    return { ok: true, canEdit: true, active: true, dimensions: ["ของแจก", "กิจกรรม"],
      keywords: [{ keyword: "#make", rooms: 12, lastAt: 1, configured: false, rule: null }] };
  };
  const block = await hashtagTagsBlock({ api, toast: (text) => notices.push(text), refresh: async () => {} });
  const dim = block.querySelector(".hashtag-tag-dim");
  const value = block.querySelector(".hashtag-tag-value");
  assert.equal(dim.children[0].attributes.selected, "", "ค่าเริ่มต้น = ไม่ติดป้าย");
  assert.equal(value.value, "make", "ชื่อตั้งต้นมาจากคีย์เวิร์ด");
  assert.equal(value.disabled, true);
  dim.value = "ของแจก";
  dim.dispatch("change", { target: dim });
  assert.equal(value.disabled, false);
  value.value = "Make Cheat Sheet";
  block.querySelector(".hashtag-tag-edit .btn").dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), { path: "/console/api/settings/hashtag-tags", method: "POST", body: { keyword: "#make", dimension: "ของแจก", value: "Make Cheat Sheet" } });
  assert.match(notices.at(-1), /#make → ของแจก: Make Cheat Sheet/u);
});
