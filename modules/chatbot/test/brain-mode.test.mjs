// brain-mode.test.mjs — G6 P1: สมอง AI ต่อสาขา (dropdown สมองกลาง/สมองแยก + addendum)
// ครอบ: unit (brainModeOf/composeBrandPackForChannel/listActiveKnowledge scoping),
// console API (auth/CSRF/validate/audit brain_mode_change), knowledge สร้างเข้า scope สาขา,
// pipeline draft ใช้สมองตามสาขาลูกค้า (separate = addendum + ความรู้สาขาเท่านั้น),
// follow-up draft เห็นสมองเดียวกัน (ทุกอย่าง mock — ห้ามแตะ network จริง)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../src/server.mjs";
import { customerKey } from "../src/channels.mjs";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createLineClient } from "../src/lineClient.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createFollowupEngine } from "../src/followupEngine.mjs";
import {
  brainModeOf, composeBrandPackForChannel, KNOWLEDGE_HEADER, ADDENDUM_HEADER,
  brainModeKey, brainAddendumKey,
} from "../src/knowledgePack.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen, promptText} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// นาฬิกาเดียวของเทสต์ follow-up ในไฟล์นี้ — db กับ engine ต้องอ่านค่าเดียวกัน
// (เคยเป็นสองนาฬิกา: db เดินตาม wall clock ส่วน engine ตรึงไว้ ม.ค. แล้วต้องปะ created_at ด้วยมือ)
const FU_NOON_BKK = Date.UTC(2026, 0, 15, 5, 0, 0); // 12:00 เวลาไทย — นอก quiet hours แน่นอน
const FU_SCHEDULED_AT = FU_NOON_BKK - 3_600_000; // ถึงกำหนดแล้วหนึ่งชั่วโมง
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

const CHANNELS = [
  { id: "a", name: "สาขาเอ", channelSecret: "secret-a", channelAccessToken: "token-a", active: true },
  { id: "b", name: "สาขาบี", channelSecret: "secret-b", channelAccessToken: "token-b", active: true },
];

/* ---------------------------------- unit ---------------------------------- */

test("brainModeOf: default shared / setting separate / DB พัง = shared (fail-safe)", () => {
  const db = memoryDb();
  assert.equal(brainModeOf(db, "a"), "shared");
  db.setSetting(brainModeKey("a"), "separate");
  assert.equal(brainModeOf(db, "a"), "separate");
  db.setSetting(brainModeKey("a"), "weird-value");
  assert.equal(brainModeOf(db, "a"), "shared", "ค่าประหลาด = shared");
  const broken = { getSetting() { throw new Error("db down"); } };
  assert.equal(brainModeOf(broken, "a"), "shared");
  db.close();
});

test("listActiveKnowledge: scope null = เฉพาะกลาง (แถวเดิมทุกแถว) / scope สาขา = เฉพาะของสาขา", () => {
  const db = memoryDb();
  db.addKnowledge({ title: "กลาง", content: "C" });
  db.addKnowledge({ title: "ของเอ", content: "A", channelId: "a" });
  const central = db.listActiveKnowledge();
  assert.deepEqual(central.map((r) => r.title), ["กลาง"]);
  const scoped = db.listActiveKnowledge("a");
  assert.deepEqual(scoped.map((r) => r.title), ["ของเอ"]);
  assert.equal(db.listActiveKnowledge("b").length, 0, "สาขาที่ไม่มีของตัวเอง = ว่าง (ไม่อ่านกลาง)");
  db.close();
});

test("composeBrandPackForChannel: shared = กลางเดิมเป๊ะ / separate = base กลาง + addendum + ความรู้สาขาเท่านั้น", () => {
  const db = memoryDb();
  db.addKnowledge({ title: "กลาง", content: "ความรู้กลาง" });
  db.addKnowledge({ title: "ของเอ", content: "ความรู้สาขาเอ", channelId: "a" });
  db.setSetting(brainAddendumKey("a"), "สาขาเอ อยู่รัชดา เปิด 10 โมง");

  // v1.5 (คำสั่งเจ้าของ 2026-08-30 — Facebook): addendum เป็นเรื่องของ "ช่องทาง"
  // ไม่ผูกกับโหมดความรู้อีกต่อไป — shared ที่ตั้ง addendum ไว้จึงเห็น addendum ด้วย
  // สิ่งที่ยังต้องจริงเสมอ: shared เห็นความรู้กลาง และห้ามเห็นความรู้ของสาขาอื่น
  const shared = composeBrandPackForChannel({ db, brandPack: "BRAND", channelId: "a", logger: silent });
  assert.ok(shared.startsWith("BRAND"));
  assert.ok(shared.includes("[กลาง]") && shared.includes("ความรู้กลาง"));
  assert.ok(shared.includes(ADDENDUM_HEADER) && shared.includes("อยู่รัชดา"), "addendum ที่ตั้งไว้ต้องเข้าแม้โหมด shared");
  assert.ok(!shared.includes("ความรู้สาขาเอ"), "ความรู้ scope สาขายังห้ามรั่วเข้าคลังกลาง");

  // channel ที่ "ไม่ตั้ง addendum" (ทางเดิมของทุก instance ที่มีอยู่) = ผลลัพธ์เดิมทุกตัวอักษร
  const untouched = composeBrandPackForChannel({ db, brandPack: "BRAND", channelId: "no-addendum", logger: silent });
  assert.ok(!untouched.includes(ADDENDUM_HEADER), "ไม่ตั้ง addendum = ไม่มี addendum (พฤติกรรมเดิมเป๊ะ)");

  // separate — brand pack กลางยังเป็นฐาน + addendum + ความรู้เฉพาะสาขา (ไม่อ่านกลาง)
  db.setSetting(brainModeKey("a"), "separate");
  const sep = composeBrandPackForChannel({ db, brandPack: "BRAND", channelId: "a", logger: silent });
  assert.ok(sep.startsWith("BRAND"), "brand pack กลางต้องเป็นฐานเสมอ");
  assert.ok(sep.includes(ADDENDUM_HEADER) && sep.includes("อยู่รัชดา"));
  assert.ok(sep.indexOf("BRAND") < sep.indexOf(ADDENDUM_HEADER), "addendum ต่อท้าย brand pack");
  assert.ok(sep.includes("[ของเอ]") && sep.includes("ความรู้สาขาเอ"));
  assert.ok(!sep.includes("ความรู้กลาง"), "สมองแยกห้ามอ่านความรู้กลาง (true separation)");

  // สาขา b ยัง shared — เห็นกลางตามเดิม ไม่เห็นของเอ
  const b = composeBrandPackForChannel({ db, brandPack: "BRAND", channelId: "b", logger: silent });
  assert.ok(b.includes("ความรู้กลาง") && !b.includes("ความรู้สาขาเอ") && !b.includes(ADDENDUM_HEADER));
  db.close();
});

/* --------------------------- console API (multi-OA) --------------------------- */

function writeChannelsFile(t, channels = CHANNELS) {
  const dir = mkdtempSync(join(tmpdir(), "chassis-brain-"));
  const file = join(dir, "channels.json");
  writeFileSync(file, JSON.stringify(channels), { mode: 0o600 });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return file;
}

async function startMulti(t, { hermesFetch = hermesFetchStub() } = {}) {
  const config = testConfig({
    CONSOLE_SESSION_SECRET: CONSOLE_SECRET,
    CHANNELS_FILE: writeChannelsFile(t),
    BRAND_PACK: "แบรนด์กลาง: ทดสอบ",
  });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db, config, hermesFetch };
}

function postJson(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server) {
  const res = await postJson(server, "/console/api/login", { username: "nok", password: PASSWORD });
  assert.equal(res.status, 200);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

test("settings/brain API: ไม่มี session = 401, ไม่มี CSRF = 403, channel มั่ว = 404", async (t) => {
  const { app, db } = await startMulti(t);
  assert.equal((await httpRequest(app.server, { path: "/console/api/settings/brain" })).status, 401);

  const { cookie, csrf } = await login(app.server);
  const noCsrf = await postJson(app.server, "/console/api/settings/brain/a", { mode: "separate" }, { cookie });
  assert.equal(noCsrf.status, 403);
  assert.equal(brainModeOf(db, "a"), "shared", "ห้ามมี mutation เกิดขึ้น");

  const headers = { cookie, "x-csrf-token": csrf };
  const ghost = await postJson(app.server, "/console/api/settings/brain/no-such", { mode: "separate" }, headers);
  assert.equal(ghost.status, 404);
  const badMode = await postJson(app.server, "/console/api/settings/brain/a", { mode: "hybrid" }, headers);
  assert.equal(badMode.status, 400);
  const empty = await postJson(app.server, "/console/api/settings/brain/a", {}, headers);
  assert.equal(empty.status, 400);
});

test("settings/brain API: สลับโหมด + audit brain_mode_change + addendum + audit แยก", async (t) => {
  const { app, db } = await startMulti(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const before = await httpRequest(app.server, { path: "/console/api/settings/brain", headers: { cookie } });
  assert.equal(before.status, 200);
  assert.equal(before.json.multi, true);
  assert.deepEqual(before.json.channels.map((c) => [c.id, c.mode]), [["a", "shared"], ["b", "shared"]]);

  const flip = await postJson(app.server, "/console/api/settings/brain/a", { mode: "separate" }, headers);
  assert.equal(flip.status, 200);
  assert.equal(flip.json.mode, "separate");
  const audit = db.listAudit().find((row) => row.action === "brain_mode_change");
  assert.ok(audit, "ต้องมี audit brain_mode_change");
  assert.equal(audit.target, "a");
  assert.equal(audit.detail, "shared -> separate");

  // ตั้งโหมดเดิมซ้ำ = ไม่เพิ่ม audit ใหม่ (ไม่มีการเปลี่ยนจริง)
  await postJson(app.server, "/console/api/settings/brain/a", { mode: "separate" }, headers);
  assert.equal(db.listAudit().filter((row) => row.action === "brain_mode_change").length, 1);

  const addendum = await postJson(app.server, "/console/api/settings/brain/a",
    { addendum: "สาขาเอ ทีมช่างของตัวเอง" }, headers);
  assert.equal(addendum.status, 200);
  assert.equal(addendum.json.addendum, "สาขาเอ ทีมช่างของตัวเอง");
  assert.ok(db.listAudit().some((row) => row.action === "brain_addendum_edit" && row.target === "a"));

  const tooLong = await postJson(app.server, "/console/api/settings/brain/a", { addendum: "ก".repeat(4001) }, headers);
  assert.equal(tooLong.status, 400);
});

test("knowledge API: สร้างเข้า scope สาขาได้ (channelId) — channel มั่ว = 400, ไม่ส่ง = กลาง", async (t) => {
  const { app, db } = await startMulti(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const central = await postJson(app.server, "/console/api/knowledge", { title: "กลาง", content: "c" }, headers);
  assert.equal(central.status, 200);
  assert.equal(central.json.entry.channel_id, null);

  const scoped = await postJson(app.server, "/console/api/knowledge",
    { title: "ของเอ", content: "a", channelId: "a" }, headers);
  assert.equal(scoped.status, 200);
  assert.equal(scoped.json.entry.channel_id, "a");
  assert.ok(db.listAudit().some((row) => row.action === "knowledge_add" && row.detail.startsWith("[a]")));

  const bad = await postJson(app.server, "/console/api/knowledge",
    { title: "x", content: "y", channelId: "no-such" }, headers);
  assert.equal(bad.status, 400);

  // list ยังคืนทุกแถว (frontend กรองตาม scope เอง) — แถวมี channel_id ให้กรองได้
  const list = await httpRequest(app.server, { path: "/console/api/knowledge", headers: { cookie } });
  assert.deepEqual(list.json.knowledge.map((r) => [r.title, r.channel_id]).sort(),
    [["กลาง", null], ["ของเอ", "a"]].sort());
});

/* ------------------------- pipeline + follow-up ต่อสาขา ------------------------- */

test("pipeline draft: ลูกค้าสาขา separate ได้ addendum + ความรู้สาขาเท่านั้น / สาขา shared ได้กลาง", async (t) => {
  const hermesFetch = hermesFetchStub("รับทราบค่ะ สนใจรุ่นไหนเป็นพิเศษไหมคะ");
  const { app, db } = await startMulti(t, { hermesFetch });
  db.addKnowledge({ title: "กลาง", content: "โปรกลางทุกสาขา" });
  db.addKnowledge({ title: "ของเอ", content: "โปรเฉพาะสาขาเอ", channelId: "a" });
  db.setSetting(brainModeKey("a"), "separate");
  db.setSetting(brainAddendumKey("a"), "สาขาเอ พูดลงท้ายว่าจ้า");

  const custA = customerKey("a", "U-brain");
  db.upsertCustomer(custA, { channelId: "a" });
  await app.pipeline.handleInboundText({ customerId: custA, text: "สวัสดีค่ะ", replyToken: "rt" });
  const systemA = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.ok(systemA.includes("แบรนด์กลาง: ทดสอบ"), "brand pack กลางเป็นฐานเสมอ");
  assert.ok(systemA.includes(ADDENDUM_HEADER) && systemA.includes("พูดลงท้ายว่าจ้า"));
  assert.ok(systemA.includes("[ของเอ]") && systemA.includes("โปรเฉพาะสาขาเอ"));
  assert.ok(!systemA.includes("โปรกลางทุกสาขา"), "สมองแยกห้ามเห็นความรู้กลาง");

  const custB = customerKey("b", "U-brain");
  db.upsertCustomer(custB, { channelId: "b" });
  await app.pipeline.handleInboundText({ customerId: custB, text: "สวัสดีค่ะ", replyToken: "rt2" });
  const systemB = promptText(hermesFetch.calls[1].body.messages[0].content);
  assert.ok(systemB.includes(KNOWLEDGE_HEADER) && systemB.includes("โปรกลางทุกสาขา"));
  assert.ok(!systemB.includes(ADDENDUM_HEADER) && !systemB.includes("โปรเฉพาะสาขาเอ"));
});

test("follow-up draft: ใช้สมองตามสาขาลูกค้า (separate = addendum + ความรู้สาขา)", async () => {
  const config = testConfig({ FOLLOWUP_ENABLED: "true", BRAND_PACK: "แบรนด์กลาง" });
  const db = memoryDb({ now: () => FU_NOON_BKK });
  const hermesFetch = hermesFetchStub("วันก่อนคุยค้างไว้ สะดวกคุยต่อไหมคะ");
  const hermes = createHermesBridge({ config, fetchImpl: hermesFetch, logger: silent });
  const line = createLineClient({ config, fetchImpl: lineFetchStub(), sleep: async () => {}, logger: silent });
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => [] });
  const engine = createFollowupEngine({
    config, db, hermes, line, guard, humanizer: createHumanizer(),
    brandPack: config.brandPack, logger: silent,
    now: () => FU_NOON_BKK,
  });
  db.addKnowledge({ title: "กลาง", content: "โปรกลาง" });
  db.addKnowledge({ title: "ของเอ", content: "โปรสาขาเอ", channelId: "a" });
  db.setSetting(brainModeKey("a"), "separate");
  db.setSetting(brainAddendumKey("a"), "บุคลิกสาขาเอ");

  const cust = customerKey("a", "U-fu-brain");
  db.upsertCustomer(cust, { channelId: "a" });
  db.setFollowupEnabled(cust, true);
  const fu = db.createFollowup({ customerId: cust, scheduledAt: FU_SCHEDULED_AT, createdBy: "nok" });

  const result = await engine.processFollowup(db.getFollowup(fu.id));
  assert.equal(result.status, "sent");
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.ok(system.includes(ADDENDUM_HEADER) && system.includes("บุคลิกสาขาเอ"));
  assert.ok(system.includes("โปรสาขาเอ") && !system.includes("โปรกลาง"), "follow-up เห็นสมองสาขาเดียวกัน");
  db.close();
});
