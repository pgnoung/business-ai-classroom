// reply-engine-v3-console.test.mjs — สวิตช์ "เครื่องตอบแชท v3" ในแผงสวิตช์พฤติกรรม (spec v3.1 §A2 · §A8.9)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { BEHAVIOR_SWITCHES } from "../src/consoleBehaviorSwitchesApi.mjs";
import { BEHAVIOR_SWITCH_COPY } from "../public/console/settingsBehaviorSwitches.mjs";
import { replyEngineMode } from "../src/replyEngineV3/mode.mjs";
import { httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const PASSWORD = "engine-switch-pass-123";
const PATH = "/console/api/settings/behavior-switches";
const silent = { log() {}, warn() {}, error() {}, info() {}, debug() {} };

async function start(t) {
  const db = memoryDb();
  const passHash = hashPassword(PASSWORD);
  db.createOperator({ username: "owner", passHash, displayName: "เจ้าของ", role: "owner" });
  db.createOperator({ username: "admin", passHash, displayName: "แอดมิน", role: "admin" });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: "engine-switch-secret" }), db,
    overrides: { lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}
async function login(server, username) {
  const res = await httpRequest(server, { method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }) });
  assert.equal(res.status, 200);
  return { cookie: res.headers["set-cookie"][0].split(";")[0], csrf: res.json.csrf };
}
const post = (server, s, body) => httpRequest(server, { method: "POST", path: PATH,
  headers: { cookie: s.cookie, "content-type": "application/json", "x-csrf-token": s.csrf }, body: JSON.stringify(body) });

test("สวิตช์อยู่ในรายการ ค่าเริ่มต้น legacy · เจ้าของเปิด v3 ได้ มี audit · ถอยกลับได้ทันที", async (t) => {
  const { app, db } = await start(t);
  const owner = await login(app.server, "owner");
  const view = await httpRequest(app.server, { path: PATH, headers: { cookie: owner.cookie } });
  const item = view.json.switches.find((entry) => entry.key === "reply_engine");
  assert.deepEqual(item, { key: "reply_engine", values: ["legacy", "v3"], value: "legacy" });
  const on = await post(app.server, owner, { key: "reply_engine", value: "v3" });
  assert.equal(on.status, 200);
  assert.equal(replyEngineMode(db), "v3");
  assert.equal(on.json.switches.find((entry) => entry.key === "reply_engine").value, "v3");
  assert.equal((await post(app.server, owner, { key: "reply_engine", value: "legacy" })).status, 200);
  assert.equal(replyEngineMode(db), "legacy");
  const audits = db.raw.prepare("SELECT target, detail FROM admin_audit WHERE action = 'behavior_switch' AND target = 'reply_engine'").all();
  assert.deepEqual(audits.map((row) => row.detail), ["legacy → v3", "v3 → legacy"]);
});

test("ค่าแปลกถูกปฏิเสธ ไม่มีอะไรถูกเขียน · admin เปลี่ยนไม่ได้ (Super Admin เท่านั้น)", async (t) => {
  const { app, db } = await start(t);
  const owner = await login(app.server, "owner");
  for (const value of ["V3", "garbage", "on", "", "v4"]) {
    assert.equal((await post(app.server, owner, { key: "reply_engine", value })).status, 400, value);
  }
  assert.equal(db.getSetting("reply_engine"), null);
  const admin = await login(app.server, "admin");
  assert.equal((await post(app.server, admin, { key: "reply_engine", value: "v3" })).status, 403);
  assert.equal(db.getSetting("reply_engine"), null);
});

test("คำอธิบายภาษาไทยครบทุกค่า และตรงกับสเปก", () => {
  const item = BEHAVIOR_SWITCHES.find((entry) => entry.key === "reply_engine");
  assert.deepEqual([...item.values], ["legacy", "v3"]);
  const copy = BEHAVIOR_SWITCH_COPY.reply_engine;
  assert.equal(copy.title, "เครื่องตอบแชท v3 (ตรรกะใหม่)");
  assert.match(copy.legacy, /^ใช้เครื่องตอบเดิมทุกตัวอักษร \(ค่าเริ่มต้น\)/u);
  assert.match(copy.v3, /ราคา ส่วนลด บันไดระดับ และรีวิว ระบบเติมเองจากข้อมูลที่อนุมัติ/u);
  assert.match(copy.v3, /ถอยกลับ = กดกลับเป็นเครื่องเดิม มีผลข้อความถัดไป/u);
});
