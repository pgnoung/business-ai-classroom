// tag-framework-live.test.mjs — เปิดกรอบป้ายชุดเดียวบน production (พี่ง้วงอนุมัติ 28 ก.ย. 2026)
// สวิตช์ tag_framework_mode (ไม่มีแถว = เปิด · off = แบบเดิมทุกตัวอักษร) · ตัวตรวจป้ายที่คนติดในคอนโซล
// · ซื้อครั้งที่/ซื้อล่าสุด คำนวณใหม่ตอนออเดอร์ขยับ/ทีมแก้ป้ายประวัติ/โยงห้องเก่า
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { manualLegacyLink } from "../src/legacyLink.mjs";
import { validateTagFramework } from "../src/tagFramework.mjs";
import { activeTagFramework, tagFrameworkMode } from "../src/tagFrameworkMode.mjs";
import { fixtureWithPurchase } from "./tagFrameworkFixture.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, promptText, testConfig,
} from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, info() {}, debug() {} };
const PASSWORD = "tag-live-pass-123456";
const fw = validateTagFramework(fixtureWithPurchase());

test("tag framework switch: no row = on · off = off · anything else = on · unreadable = off (the proven path)", () => {
  const db = memoryDb();
  assert.equal(tagFrameworkMode(db), "on");
  assert.equal(activeTagFramework(db, fw), fw);
  db.setSetting("tag_framework_mode", "off");
  assert.equal(tagFrameworkMode(db), "off");
  assert.equal(activeTagFramework(db, fw), null);
  db.setSetting("tag_framework_mode", "whatever");
  assert.equal(tagFrameworkMode(db), "on");
  assert.equal(activeTagFramework(db, null), null, "ไม่มีไฟล์กรอบ = ไม่มีอะไรเปิด");
  assert.equal(tagFrameworkMode({ getSetting() { throw new Error("db down"); } }), "off");
  db.close();
});

/* -------------------------------- pipeline -------------------------------- */

function scorerApp({ scorerTags }) {
  const db = memoryDb();
  const hermesFetch = hermesFetchStub(JSON.stringify({
    score: 6, trend: "up", buying_signals: [], tags: scorerTags, persona_type: "unknown",
    persona_read: { disc: "unknown", bank: "unknown", reason: "" },
  }));
  const app = createApp({ config: testConfig(), db, logger: silent,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {}, tagFramework: fw } });
  return { app, db, hermesFetch };
}

test("tag framework switch: off sends the scorer back to free-text tags from the next turn — on uses the closed list", async () => {
  const { app, db, hermesFetch } = scorerApp({ scorerTags: ["ถามราคาคอร์ส", "สนใจ: AI Agent for Business"] });
  db.upsertCustomer("U-sw", {});
  db.insertMessage({ customerId: "U-sw", direction: "in", content: "คลาส AI Agent ราคาเท่าไหร่คะ" });
  await app.pipeline.scoreBurst("U-sw");
  const ai = () => db.listTags("U-sw").filter((t) => t.source === "ai").map((t) => t.tag).sort();
  assert.deepEqual(ai(), ["ขั้น: ถามราคา", "สนใจ: AI Agent for Business"], "ไม่มีแถว = เปิด (พี่ง้วงอนุมัติแล้ว)");
  db.setSetting("tag_framework_mode", "off");
  db.insertMessage({ customerId: "U-sw", direction: "in", content: "ขอรายละเอียดเพิ่มค่ะ" });
  await app.pipeline.scoreBurst("U-sw");
  assert.deepEqual(ai(), ["ถามราคาคอร์ส", "สนใจ: AI Agent for Business"].sort(), "ปิด = ป้ายอิสระแบบเดิม");
  const prompts = hermesFetch.calls.map((call) => promptText(call.body.messages[0].content));
  assert.ok(prompts.some((p) => p.includes("ป้ายลูกค้า (tags) = รายการปิด")));
  assert.ok(prompts.at(-1).includes("ป้ายจากหลักฐานจริง") || prompts.at(-1).includes("ป้ายพฤติกรรม"), "รอบที่ปิดใช้คำสั่งป้ายแบบเดิม");
  assert.ok(!prompts.at(-1).includes("รายการปิด"));
  db.close();
});

/* --------------------------------- console --------------------------------- */

async function startConsole(t, { tagFramework = fw } = {}) {
  const db = memoryDb();
  const passHash = hashPassword(PASSWORD);
  db.createOperator({ username: "owner", passHash, displayName: "เจ้าของ", role: "owner" });
  db.createOperator({ username: "staff", passHash, displayName: "ทีมงาน", role: "operator" });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: "tag-live-secret" }), db, logger: silent,
    overrides: { lineFetch: lineFetchStub(), sleep: async () => {}, ...(tagFramework ? { tagFramework } : {}) } });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server, username) {
  const res = await httpRequest(server, { method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) });
  assert.equal(res.status, 200);
  return { cookie: res.headers["set-cookie"][0].split(";")[0], csrf: res.json.csrf };
}

const call = (server, session, method, path, body = null) => httpRequest(server, {
  method, path,
  headers: { cookie: session.cookie, ...(body ? { "content-type": "application/json", "x-csrf-token": session.csrf } : {}) },
  body: body ? JSON.stringify(body) : null,
});
const tagsOf = (db, id, source) => db.listTags(id).filter((row) => row.source === source).map((row) => row.tag).sort();

test("console: every role that opens a chat gets the framework view; the switch hides it", async (t) => {
  const { app } = await startConsole(t);
  const staff = await login(app.server, "staff");
  const view = await call(app.server, staff, "GET", "/console/api/customers/tag-framework");
  assert.equal(view.status, 200);
  assert.equal(view.json.mode, "on");
  assert.equal(view.json.available, true);
  const keys = view.json.framework.dimensions.map((d) => d.key);
  assert.ok(keys.includes("สนใจ") && keys.includes("ซื้อครั้งที่"));
  const owner = await login(app.server, "owner");
  const switches = await call(app.server, owner, "GET", "/console/api/settings/behavior-switches");
  assert.ok(switches.json.switches.some((s) => s.key === "tag_framework_mode" && s.value === "on"), "มีไฟล์กรอบ = สวิตช์โผล่");
  assert.equal((await call(app.server, owner, "POST", "/console/api/settings/behavior-switches", { key: "tag_framework_mode", value: "off" })).status, 200);
  const off = await call(app.server, staff, "GET", "/console/api/customers/tag-framework");
  assert.deepEqual([off.json.mode, off.json.framework], ["off", null]);
});

test("console: without a framework file the switch is not offered and the view says unavailable", async (t) => {
  const { app } = await startConsole(t, { tagFramework: null });
  const owner = await login(app.server, "owner");
  const switches = await call(app.server, owner, "GET", "/console/api/settings/behavior-switches");
  assert.ok(!switches.json.switches.some((s) => s.key === "tag_framework_mode"));
  assert.equal((await call(app.server, owner, "POST", "/console/api/settings/behavior-switches", { key: "tag_framework_mode", value: "off" })).status, 400);
  const view = await call(app.server, owner, "GET", "/console/api/customers/tag-framework");
  assert.deepEqual([view.json.available, view.json.mode, view.json.framework], [false, "off", null]);
});

test("console: the team may add free tags, but closed dimensions only take listed values (friendly Thai errors)", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-team", {});
  const staff = await login(app.server, "staff");
  const add = (tag) => call(app.server, staff, "POST", "/console/api/customers/U-team/tags", { add: tag });

  const invented = await add("สนใจ: คลาสทำขนม");
  assert.equal(invented.status, 400);
  assert.match(invented.json.error, /ไม่อยู่ในรายการของมิติ "สนใจ" — เลือกได้: AI Agent for Business/u);
  const system = await add("ซื้อครั้งที่: 3");
  assert.equal(system.status, 400);
  assert.match(system.json.error, /ระบบติดเองจากออเดอร์/u);
  const archived = await add("สนใจ: คลาส LINE OA");
  assert.equal(archived.status, 400);
  assert.match(archived.json.error, /ใช้ "สนใจ: In-house" แทน/u);

  assert.equal((await add("สนใจ:ai agent for business")).status, 200);
  assert.equal((await add("VIP")).status, 200);
  assert.equal((await add("ของแจก:Make Cheat Sheet")).status, 200);
  assert.equal((await add("ติดต่อ: งานรีวิว")).status, 200);
  assert.deepEqual(tagsOf(db, "U-team", "human"), ["VIP", "ของแจก: Make Cheat Sheet", "ติดต่อ: งานรีวิว", "สนใจ: AI Agent for Business"].sort(),
    "ป้ายในกรอบถูกเก็บเป็นรูปมาตรฐานเดียว");
  assert.ok(!db.listAudit().some((row) => row.action === "tag_add" && row.detail.includes("คลาสทำขนม")), "ป้ายที่ถูกปฏิเสธไม่ถูกบันทึก");

  db.setSetting("tag_framework_mode", "off");
  assert.equal((await add("สนใจ: คลาสทำขนม")).status, 200, "ปิดสวิตช์ = ติดอะไรก็ได้แบบเดิม");
});

test("console: history purchase tags typed by the team recompute ซื้อครั้งที่/ซื้อล่าสุด at once", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-hist", {});
  const staff = await login(app.server, "staff");
  const post = (body) => call(app.server, staff, "POST", "/console/api/customers/U-hist/tags", body);
  assert.equal((await post({ add: "ซื้อครั้งที่สอง" })).status, 200);
  assert.deepEqual(tagsOf(db, "U-hist", "rfm"), ["ซื้อครั้งที่: 2"]);
  assert.equal((await post({ add: "ม.ค.2023" })).status, 200);
  assert.deepEqual(tagsOf(db, "U-hist", "rfm"), ["ซื้อครั้งที่: 2", "ซื้อล่าสุด: Jan2023"]);
  assert.equal((await post({ remove: "ม.ค.2023" })).status, 200);
  assert.deepEqual(tagsOf(db, "U-hist", "rfm"), ["ซื้อครั้งที่: 2"]);
  assert.equal((await post({ add: "VIP" })).status, 200);
  assert.ok(db.listTags("U-hist").some((row) => row.tag === "ซื้อครั้งที่สอง" && row.source === "human"), "ป้ายของคนยังอยู่ครบ");
});

test("console: orders drive the purchase tags — confirm adds, a refund (cancel after paid) takes it back", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-buy", {});
  db.addTag("U-buy", "ซื้อครั้งแรก", "human");
  db.addTag("U-buy", "ม.ค.2023", "human");
  const owner = await login(app.server, "owner");
  const created = await call(app.server, owner, "POST", "/console/api/orders", { customerId: "U-buy", items: [{ name: "คลาส A", qty: 1, price: 4900 }] });
  assert.equal(created.status, 200);
  const id = created.json.order.id;
  assert.deepEqual(tagsOf(db, "U-buy", "rfm"), ["ซื้อครั้งที่: 1", "ซื้อล่าสุด: Jan2023"], "ร่างยังไม่นับ — ป้ายมาจากประวัติเดิม");
  assert.equal((await call(app.server, owner, "POST", `/console/api/orders/${id}/status`, { status: "confirmed" })).status, 200);
  const month = new Date(Date.now() + 7 * 3_600_000);
  const label = `${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][month.getUTCMonth()]}${month.getUTCFullYear()}`;
  assert.deepEqual(tagsOf(db, "U-buy", "rfm"), ["ซื้อครั้งที่: 2", `ซื้อล่าสุด: ${label}`, "ซื้อแล้ว: คลาส A"].sort());
  assert.equal((await call(app.server, owner, "POST", `/console/api/orders/${id}/status`, { status: "paid" })).status, 200);
  assert.equal((await call(app.server, owner, "POST", `/console/api/orders/${id}/status`, { status: "cancelled" })).status, 200);
  assert.deepEqual(tagsOf(db, "U-buy", "rfm"), ["ซื้อครั้งที่: 1", "ซื้อล่าสุด: Jan2023"], "คืนเงิน = กลับไปเท่าประวัติเดิม");
  assert.ok(!db.listTags("U-buy").some((row) => row.tag === "customer"), "ห้ามติด customer เองจากออเดอร์ (จะทำให้ AI เงียบ)");
});

test("legacy link: derived rfm tags of the old room are not copied — the live room recomputes from the copied history", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-old", { displayName: "คุณเก่า" });
  db.addTag("U-old", "ย้ายจาก LINE OA", "human");
  db.addTag("U-old", "ซื้อครั้งที่สอง", "human");
  db.addTag("U-old", "ส.ค.2024", "human");
  db.addTag("U-old", "ซื้อครั้งที่: 2", "rfm");
  db.addTag("U-old", "ซื้อล่าสุด: Aug2024", "rfm");
  db.upsertCustomer("U-new", { displayName: "คุณเก่า" });
  const owner = await login(app.server, "owner");
  const linked = await call(app.server, owner, "POST", "/console/api/customers/U-new/legacy-link", { action: "link", legacyId: "U-old" });
  assert.equal(linked.status, 200);
  assert.ok(!linked.json.copied.some((tag) => tag.startsWith("ซื้อครั้งที่:") || tag.startsWith("ซื้อล่าสุด:")));
  assert.deepEqual(tagsOf(db, "U-new", "rfm"), ["ซื้อครั้งที่: 2", "ซื้อล่าสุด: Aug2024"]);
  assert.ok(!tagsOf(db, "U-new", "human").some((tag) => tag.startsWith("ซื้อครั้งที่:")), "ไม่มีค่าเก่าค้างเป็นป้ายของคน");
});

test("legacy link (direct): the copy step skips rfm rows even without a framework", () => {
  const db = memoryDb();
  db.upsertCustomer("U-o", { displayName: "x" });
  db.addTag("U-o", "ย้ายจาก LINE OA", "human");
  db.addTag("U-o", "ซื้อแล้ว 1 ครั้ง (ลูกค้าใหม่)", "rfm");
  db.addTag("U-o", "สนใจGEN AI Classroom", "human");
  db.upsertCustomer("U-n", { displayName: "x" });
  const result = manualLegacyLink({ db, customerId: "U-n", legacyId: "U-o" });
  assert.equal(result.state, "linked");
  assert.deepEqual(result.copied, ["สนใจGEN AI Classroom"]);
  db.close();
});
