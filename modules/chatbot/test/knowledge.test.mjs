// G3 คลังความรู้ — DB CRUD, console API (auth/CSRF/validate/audit), เพดาน 20,000 ตัวอักษร,
// การฉีดเข้า prompt (เฉพาะ active, เพดานรวม 8,000 ตัดของเก่าก่อน, ต่อท้าย brand pack),
// follow-up draft เห็นความรู้เดียวกัน, XSS-inert render (ทุกอย่าง mock — ห้ามแตะ network จริง)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createLineClient } from "../src/lineClient.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createFollowupEngine } from "../src/followupEngine.mjs";
import {
  buildKnowledgeSection, knowledgeSectionFromDb, appendKnowledge,
  KNOWLEDGE_HEADER, KNOWLEDGE_MAX_CHARS,
} from "../src/knowledgePack.mjs";
import { KNOWLEDGE_CONTENT_MAX } from "../src/dbExtra.mjs";
import { hashPassword } from "../src/auth.mjs";
import { el } from "../public/console/dom.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen, promptText} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// นาฬิกาเดียวของเทสต์ follow-up ในไฟล์นี้ — db กับ engine ต้องอ่านค่าเดียวกัน
// (เคยเป็นสองนาฬิกา: db เดินตาม wall clock ส่วน engine ตรึงไว้ ม.ค. แล้วต้องปะ created_at ด้วยมือ)
const FU_NOON_BKK = Date.UTC(2026, 0, 15, 5, 0, 0); // 12:00 เวลาไทย — นอก quiet hours แน่นอน
const FU_SCHEDULED_AT = FU_NOON_BKK - 3_600_000; // ถึงกำหนดแล้วหนึ่งชั่วโมง

/* ------------------------------ section builder ------------------------------ */

test("buildKnowledgeSection: ว่าง = '' / มีรายการ = header + [หัวข้อ] + เนื้อหา เรียงเก่า -> ใหม่", () => {
  assert.equal(buildKnowledgeSection([], { logger: silent }), "");
  assert.equal(buildKnowledgeSection(null, { logger: silent }), "");
  const out = buildKnowledgeSection([
    { title: "โปรเก่า", content: "รายละเอียด A" },
    { title: "โปรใหม่", content: "รายละเอียด B" },
  ], { logger: silent });
  assert.ok(out.startsWith(KNOWLEDGE_HEADER));
  assert.ok(out.indexOf("[โปรเก่า]") < out.indexOf("[โปรใหม่]"), "ลำดับเก่า -> ใหม่คงเดิม");
  assert.ok(out.includes("รายละเอียด A") && out.includes("รายละเอียด B"));
});

test("buildKnowledgeSection: เกินเพดาน = ตัดรายการเก่าสุดทิ้งก่อน / รายการเดียวยาวเกิน = ตัดเนื้อหา", () => {
  const old = { title: "เก่ามาก", content: "ก".repeat(6000) };
  const fresh = { title: "ใหม่สุด", content: "ข".repeat(5000) };
  const out = buildKnowledgeSection([old, fresh], { maxChars: 8000, logger: silent });
  assert.ok(out.includes("[ใหม่สุด]"), "รายการใหม่ต้องรอด");
  assert.ok(!out.includes("[เก่ามาก]"), "รายการเก่าสุดต้องโดนตัดทิ้งก่อน");
  assert.ok(out.length <= KNOWLEDGE_HEADER.length + 1 + 8000);

  const huge = buildKnowledgeSection([{ title: "ยักษ์", content: "ค".repeat(9000) }], { maxChars: 8000, logger: silent });
  assert.ok(huge.length <= KNOWLEDGE_HEADER.length + 1 + 8000, "รายการเดียวยาวเกินต้องถูกตัดให้พอดีเพดาน");
  assert.ok(huge.includes("[ยักษ์]"));
});

test("buildKnowledgeSection: เพดานตรง emoji ไม่ผ่า Unicode ครึ่งตัว", () => {
  const content = `${"ก".repeat(7)}😊`;
  const out = buildKnowledgeSection([{ title: "x", content }], { maxChars: 12, logger: silent });
  assert.equal(out.isWellFormed(), true);
  assert.match(out, /😊/u, "emoji ที่พอดีเพดานต้องอยู่ครบ");
});

test("appendKnowledge + knowledgeSectionFromDb: ต่อท้าย brand pack, DB พัง = '' (แชทเดินต่อ)", () => {
  assert.equal(appendKnowledge("BRAND", ""), "BRAND");
  assert.equal(appendKnowledge("", "SEC"), "SEC");
  assert.equal(appendKnowledge("BRAND", "SEC"), "BRAND\n\nSEC");
  const broken = { listActiveKnowledge() { throw new Error("db down"); } };
  assert.equal(knowledgeSectionFromDb(broken, { logger: silent }), "");
});

/* --------------------------------- console API -------------------------------- */

const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

async function startConsole(t) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db };
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

test("knowledge API: ไม่มี session = 401, ไม่มี CSRF = 403 (add/edit/delete)", async (t) => {
  const { app, db } = await startConsole(t);
  const listRes = await httpRequest(app.server, { path: "/console/api/knowledge" });
  assert.equal(listRes.status, 401);

  const { cookie } = await login(app.server);
  const add = await postJson(app.server, "/console/api/knowledge", { title: "x", content: "y" }, { cookie });
  assert.equal(add.status, 403);
  const entry = db.addKnowledge({ title: "seed", content: "c" });
  const edit = await postJson(app.server, `/console/api/knowledge/${entry.id}`, { active: false }, { cookie });
  assert.equal(edit.status, 403);
  const del = await httpRequest(app.server, { method: "DELETE", path: `/console/api/knowledge/${entry.id}`, headers: { cookie } });
  assert.equal(del.status, 403);
  assert.equal(db.getKnowledge(entry.id).active, 1, "ห้ามมี mutation เกิดขึ้น");
});

test("knowledge API: add + list + audit — validate หัวข้อ/เนื้อหา (20000 พอดีผ่าน, 20001 = 400)", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };

  const ok = await postJson(app.server, "/console/api/knowledge",
    { title: "โปรโมชั่นเดือนนี้", content: "ก".repeat(20000) }, headers);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.entry.active, 1, "รายการใหม่เปิดใช้ทันที");
  const audit = db.listAudit().find((a) => a.action === "knowledge_add");
  assert.equal(audit.operator, "nok");
  assert.equal(audit.target, ok.json.entry.id);

  for (const [body, why] of [
    [{ title: "", content: "x" }, "หัวข้อว่าง"],
    [{ title: "ก".repeat(201), content: "x" }, "หัวข้อยาวเกิน"],
    [{ title: "t", content: "" }, "เนื้อหาว่าง"],
    [{ title: "t", content: "ก".repeat(20001) }, "เนื้อหายาวเกิน"],
    [{ title: "t" }, "ไม่มีเนื้อหา"],
  ]) {
    const bad = await postJson(app.server, "/console/api/knowledge", body, headers);
    assert.equal(bad.status, 400, why);
  }

  const list = await httpRequest(app.server, { path: "/console/api/knowledge", headers: { cookie } });
  assert.equal(list.json.knowledge.length, 1, "รายการพังต้องไม่ถูกบันทึก");
});

test("knowledge API: edit/toggle/delete + audit action แยกชัด + 404 เมื่อ id ไม่มีจริง", async (t) => {
  const { app, db } = await startConsole(t);
  const { cookie, csrf } = await login(app.server);
  const headers = { cookie, "x-csrf-token": csrf };
  const entry = db.addKnowledge({ title: "ขั้นตอนติดตั้ง", content: "เดิม", updatedBy: "seed" });

  const edit = await postJson(app.server, `/console/api/knowledge/${entry.id}`,
    { title: "ขั้นตอนติดตั้ง v2", content: "ใหม่" }, headers);
  assert.equal(edit.status, 200);
  assert.equal(edit.json.entry.content, "ใหม่");
  assert.equal(edit.json.entry.updated_by, "nok");
  assert.equal(db.listAudit().find((a) => a.action === "knowledge_edit").target, entry.id);

  const toggle = await postJson(app.server, `/console/api/knowledge/${entry.id}`, { active: false }, headers);
  assert.equal(toggle.json.entry.active, 0);
  assert.equal(db.listAudit().find((a) => a.action === "knowledge_toggle").detail, "off");

  const ghost = await postJson(app.server, "/console/api/knowledge/no-such-id", { active: true }, headers);
  assert.equal(ghost.status, 404);
  const badType = await postJson(app.server, `/console/api/knowledge/${entry.id}`, { active: "yes" }, headers);
  assert.equal(badType.status, 400);

  const del = await httpRequest(app.server, {
    method: "DELETE", path: `/console/api/knowledge/${entry.id}`,
    headers: { cookie, "x-csrf-token": csrf },
  });
  assert.equal(del.status, 200);
  assert.equal(db.getKnowledge(entry.id), null);
  assert.equal(db.listAudit().find((a) => a.action === "knowledge_delete").target, entry.id);
  const delGhost = await httpRequest(app.server, {
    method: "DELETE", path: `/console/api/knowledge/${entry.id}`,
    headers: { cookie, "x-csrf-token": csrf },
  });
  assert.equal(delGhost.status, 404);
});

/* ------------------------------ prompt injection ------------------------------ */

test("draft prompt: ความรู้ active เข้า system prompt (ต่อท้าย brand pack) — ปิดใช้แล้วหายทันที", async () => {
  const config = testConfig({ BRAND_PACK: "แบรนด์: ทดสอบ" });
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("รับทราบค่ะ สนใจรุ่นไหนเป็นพิเศษไหมคะ");
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  const active = db.addKnowledge({ title: "วิธีติดตั้ง", content: "ต่อปลั๊กแล้วกดปุ่มเปิดค้าง 3 วินาที" });
  const inactive = db.addKnowledge({ title: "โปรลับ", content: "เนื้อหาที่ปิดใช้แล้ว" });
  db.updateKnowledge(inactive.id, { active: false });

  await app.pipeline.handleInboundText({ customerId: "U-kn", text: "ติดตั้งยังไงคะ", replyToken: "rt" });
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.ok(system.includes(KNOWLEDGE_HEADER), "ต้องมี section ความรู้");
  assert.ok(system.includes("[วิธีติดตั้ง]") && system.includes("กดปุ่มเปิดค้าง 3 วินาที"));
  assert.ok(!system.includes("เนื้อหาที่ปิดใช้แล้ว"), "รายการปิดใช้ห้ามเข้า prompt");
  // v1.4.25: สลับลำดับเป็น [knowledge, persona, brandPack, rules] เพื่อให้ prompt caching
  // ของ OpenAI ใช้ได้ (ของคงที่ต้องอยู่หน้าสุด — brandPack เลือกใหม่ทุกเทิร์นจึงย้ายไปหลัง)
  // เจตนาเดิมของเทสต์คือ "ความรู้กับ brand pack ต้องอยู่ด้วยกันใน system เดียว" ยังคงอยู่ครบ
  assert.ok(
    system.indexOf(KNOWLEDGE_HEADER) < system.indexOf("แบรนด์: ทดสอบ"),
    "ความรู้ต้องมาก่อน brand pack (prefix คงที่เพื่อ cache)"
  );

  // ปิดใช้รายการที่เหลือ -> ข้อความถัดไปต้องไม่มี section เลย
  db.updateKnowledge(active.id, { active: false });
  await app.pipeline.handleInboundText({ customerId: "U-kn", text: "ขอบคุณค่ะ", replyToken: "rt2" });
  assert.ok(!promptText(hermesFetch.calls[1].body.messages[0].content).includes(KNOWLEDGE_HEADER));
  db.close();
});

test("draft prompt: เกิน KNOWLEDGE_MAX_CHARS — รายการเก่าสุดถูกตัดทิ้งก่อน", async () => {
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("รับทราบค่ะ มีอะไรให้ช่วยเพิ่มไหมคะ");
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  // อิงเพดานจริง ไม่ hardcode — และต้องเคารพเพดานต่อรายการ (KNOWLEDGE_CONTENT_MAX 20,000)
  // จึงต้องใช้หลายรายการเพื่อดันให้เกินเพดานรวม ไม่ใช่รายการยักษ์สองใบ
  const filler = "ค".repeat(KNOWLEDGE_CONTENT_MAX);
  db.addKnowledge({ title: "เก่ามาก", content: "ก".repeat(KNOWLEDGE_CONTENT_MAX) });
  const fillerCount = Math.ceil(KNOWLEDGE_MAX_CHARS / KNOWLEDGE_CONTENT_MAX);
  for (let i = 0; i < fillerCount; i += 1) db.addKnowledge({ title: `คั่น ${i}`, content: filler });
  db.addKnowledge({ title: "ใหม่สุด", content: "ข".repeat(1000) });

  await app.pipeline.handleInboundText({ customerId: "U-cap", text: "สวัสดีค่ะ", replyToken: "rt" });
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.ok(system.includes("[ใหม่สุด]"));
  assert.ok(!system.includes("[เก่ามาก]"), "เกินเพดานต้องตัดของเก่าก่อน");
  db.close();
});

test("follow-up draft เห็นความรู้เดียวกัน (เฉพาะ active)", async () => {
  const config = testConfig({ FOLLOWUP_ENABLED: "true" });
  const db = memoryDb({ now: () => FU_NOON_BKK });
  const hermesFetch = hermesFetchStub("วันก่อนคุยค้างไว้ สะดวกคุยต่อไหมคะ");
  const hermes = createHermesBridge({ config, fetchImpl: hermesFetch, logger: silent });
  const line = createLineClient({ config, fetchImpl: lineFetchStub(), sleep: async () => {}, logger: silent });
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => [] });
  const engine = createFollowupEngine({
    config, db, hermes, line, guard, humanizer: createHumanizer(), logger: silent,
    now: () => FU_NOON_BKK,
  });
  db.addKnowledge({ title: "นโยบายส่งฟรี", content: "ส่งฟรีทั่วไทยทุกคำสั่งซื้อ" });
  db.upsertCustomer("U-fu", {});
  db.setFollowupEnabled("U-fu", true);
  const fu = db.createFollowup({ customerId: "U-fu", scheduledAt: FU_SCHEDULED_AT, createdBy: "nok" });

  const result = await engine.processFollowup(db.getFollowup(fu.id));
  assert.equal(result.status, "sent");
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.ok(system.includes(KNOWLEDGE_HEADER) && system.includes("ส่งฟรีทั่วไทยทุกคำสั่งซื้อ"));
  db.close();
});

/* ------------------------------- XSS-inert UI ------------------------------- */

function fakeDocument() {
  const createTextNode = (s) => ({ nodeType: 3, nodeValue: s, textContent: s });
  const createElement = (tag) => ({
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    className: "",
    attrs: {},
    children: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    append(...nodes) { this.children.push(...nodes); },
    get textContent() { return this.children.map((c) => c.textContent ?? "").join(""); },
  });
  return { createElement, createTextNode };
}

test("XSS: title/content ที่มี <script> เรนเดอร์ผ่าน el() เป็น text node เสมอ", (t) => {
  globalThis.document = fakeDocument();
  t.after(() => { delete globalThis.document; });
  const payload = `<script>steal()</script><img src=x onerror=alert(1)>`;
  const node = el("p", { class: "kn-preview" }, payload);
  assert.equal(node.children.length, 1);
  assert.equal(node.children[0].nodeType, 3, "ต้องเป็น text node — parse เป็น element ไม่ได้");
  assert.equal(node.children[0].nodeValue, payload);
});

test("เพดานความรู้ต้องกว้างพอสำหรับคลังจริงของลูกแพร (11 รายการ ~7.7k ตัวอักษร)", () => {
  // เคสจริง 2026-08-13: คลัง 11 รายการกินไป 7,675 ตัวอักษร ถ้าเพดานยังเป็น 8,000
  // การเพิ่มรอบเรียนเดือนถัดไปจะดันให้ "แคตตาล็อกคลาส+ราคา" (รายการเก่าสุด) หลุด prompt เงียบ ๆ
  assert.ok(KNOWLEDGE_MAX_CHARS >= 16000, `เพดานต้องมีที่หายใจ ไม่ใช่ ${KNOWLEDGE_MAX_CHARS}`);
  const entries = Array.from({ length: 11 }, (_, i) => ({ title: `หัวข้อ ${i}`, content: "ก".repeat(700) }));
  const out = buildKnowledgeSection(entries, { logger: silent });
  for (let i = 0; i < 11; i++) assert.ok(out.includes(`[หัวข้อ ${i}]`), `รายการ ${i} ต้องไม่หลุด prompt`);
});

test("ตัดความรู้ทิ้งต้องเตือนดัง ไม่ใช่ debug เงียบ ๆ", () => {
  const warnings = [];
  const noisy = { log: () => {}, warn: (m) => warnings.push(String(m)), error: () => {}, debug: () => {} };

  buildKnowledgeSection(
    [{ title: "เก่า", content: "ก".repeat(700) }, { title: "ใหม่", content: "ข".repeat(700) }],
    { maxChars: 900, logger: noisy },
  );
  assert.equal(warnings.length, 1, "ตัดรายการเก่าทิ้งต้อง warn");
  assert.match(warnings[0], /ตัดรายการเก่าสุดทิ้ง 1 รายการ/u);

  buildKnowledgeSection([{ title: "ยักษ์", content: "ก".repeat(5000) }], { maxChars: 900, logger: noisy });
  assert.equal(warnings.length, 2, "ตัดเนื้อหารายการเดียวก็ต้อง warn");
  assert.match(warnings[1], /ยาวเกิน 900 ตัวอักษร/u);
});

test("follow-up ต้องเดินเส้น prompt เดียวกับการตอบปกติ ไม่ใช่ส่ง pack ดิบ", async () => {
  // ตรวจปรปักษ์พบว่าเส้น follow-up ส่ง brand pack ดิบทั้งก้อน รวม JSON ของแพ็ก
  // สคริปต์ตัวอย่าง "[ต่อ]" และ marker [IMAGE:key] ที่หลุดถึงลูกค้าเป็นข้อความดิบ
  const config = testConfig({ FOLLOWUP_ENABLED: "true" });
  const db = memoryDb({ now: () => FU_NOON_BKK });
  const hermesFetch = hermesFetchStub("วันก่อนคุยค้างไว้ สะดวกคุยต่อไหมคะ");
  const brandPack = [
    "LUKPRAE_BRAIN_PACK_JSON_V1",
    JSON.stringify({ packId: "p", entries: [
      { id: "c1", titleTh: "คลาส AI Agent for Business", answerTh: "เนื้อหาคลาส [ต่อ] ลองเล่าโจทย์มาหน่อยค่ะ", tags: ["คลาส"] },
    ] }),
    "END_LUKPRAE_BRAIN_PACK_JSON_V1",
    "กติกาความปลอดภัย: ราคาต้องมาจากตารางที่อนุมัติ",
  ].join("\n");

  const hermes = createHermesBridge({ config, fetchImpl: hermesFetch, logger: silent });
  const line = createLineClient({ config, fetchImpl: lineFetchStub(), sleep: async () => {}, logger: silent });
  const guard = createComplianceGuard({ bannedWords: [], getApprovedPrices: () => [] });
  const engine = createFollowupEngine({
    config, db, hermes, line, guard, humanizer: createHumanizer(), logger: silent, brandPack,
    now: () => FU_NOON_BKK,
  });
  db.addKnowledge({ title: "นโยบายส่งฟรี", content: "ส่งฟรีทั่วไทยทุกคำสั่งซื้อ" });
  db.upsertCustomer("U-fu-wire", {});
  db.setFollowupEnabled("U-fu-wire", true);
  const fu = db.createFollowup({ customerId: "U-fu-wire", scheduledAt: FU_SCHEDULED_AT, createdBy: "nok" });

  await engine.processFollowup(db.getFollowup(fu.id));
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);

  assert.doesNotMatch(system, /LUKPRAE_BRAIN_PACK_JSON_V1/u, "ห้ามส่ง marker ของแพ็กดิบเข้า prompt");
  assert.doesNotMatch(system, /"packId"/u, "ห้ามส่ง JSON ดิบเข้า prompt");
  assert.doesNotMatch(system, /\[ต่อ\]/u, "สคริปต์ตัวอย่างต้องถูกถอดเหมือนเส้นตอบปกติ");
  assert.ok(system.includes("ส่งฟรีทั่วไทยทุกคำสั่งซื้อ"), "ความรู้ทีมงานต้องยังเข้า prompt");
  db.close();
});

// ---- v1.4.27: prompt_cache_key ต้องติดไปกับทุกคำขอ และต้องคงที่ข้ามเทิร์น ----
// เหตุ (วัดจริง 2026-08-19): v1.4.25 จัดลำดับให้ knowledge+persona อยู่หน้าสุดแล้ว และ
// พิสูจน์ว่า prefix เหมือนกัน 98.2% ข้ามเทิร์น แต่ cache hit จริงยังได้แค่ 6%
// เอกสาร OpenAI: "For GPT-5.6, you must set prompt_cache_key" — ไม่มีคีย์นี้ คำขอถูก
// กระจายไปคนละเครื่องจึงหา cache ไม่เจอ
//
// คีย์ต้องคงที่ "ต่อรูปทรง prompt" ไม่ใช่ต่อลูกค้า — ถ้าผูกกับ customerId เมื่อไหร่
// cache จะแตกเป็นเสี่ยงและเสียประโยชน์ทั้งหมด (ส่วนที่แชร์คือคลังความรู้ + persona)
test("prompt cache: ทุกคำขอต้องแนบ prompt_cache_key เดิมข้ามลูกค้าและข้ามเทิร์น", async () => {
  const config = testConfig({ BRAND_PACK: "แบรนด์: ทดสอบ" });
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("รับทราบค่ะ สนใจรุ่นไหนคะ");
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await app.pipeline.handleInboundText({ customerId: "U-cache-1", text: "สวัสดีค่ะ", replyToken: "" });
  await app.pipeline.handleInboundText({ customerId: "U-cache-1", text: "ราคาเท่าไหร่คะ", replyToken: "" });
  await app.pipeline.handleInboundText({ customerId: "U-cache-2", text: "สนใจคลาสครับ", replyToken: "" });

  const keys = hermesFetch.calls.map((call) => call.body.prompt_cache_key);
  assert.ok(keys.length >= 3, "ต้องมีคำขออย่างน้อย 3 ครั้ง");
  assert.ok(keys.every(Boolean), "ทุกคำขอต้องแนบคีย์");
  assert.equal(new Set(keys).size, 1, "คีย์ต้องเป็นตัวเดียวกันหมด (ห้ามผูกกับลูกค้า)");
  assert.match(keys[0], /^[A-Za-z0-9._:-]{1,64}$/u, "คีย์ต้องอยู่ในรูปแบบที่เกตเวย์ยอมรับ");
  db.close();
});

// ---- v1.4.27: cache breakpoint ต้องปักท้ายส่วนคงที่ และห้ามเปลี่ยนข้อความที่โมเดลเห็น ----
// วัดจริง 2026-08-19 เคสเดียวกันรันติดกัน: ไม่มีหมุด cache 2% (~20 บาท) -> ปักหมุด 64% (~10 บาท)
// สาเหตุที่ลำดับอย่างเดียวไม่พอ: implicit caching ปักจุดจำที่ "ข้อความล่าสุด" เสมอ
// ของที่เก็บจึงรวมส่วนท้ายที่เปลี่ยนทุกเทิร์นไปด้วย เทิร์นถัดไปเลยไม่ตรง
test("prompt cache: หมุดอยู่ท้ายส่วนคงที่ และเนื้อความรวมเหมือนเดิมทุกตัวอักษร", async () => {
  const config = testConfig({ BRAND_PACK: "แบรนด์: ทดสอบ" });
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("รับทราบค่ะ");
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  db.addKnowledge({ title: "วิธีติดตั้ง", content: "ต่อปลั๊กแล้วกดปุ่มเปิดค้าง 3 วินาที" });
  await app.pipeline.handleInboundText({ customerId: "U-bp", text: "ติดตั้งยังไงคะ", replyToken: "" });

  const blocks = hermesFetch.calls[0].body.messages[0].content;
  assert.ok(Array.isArray(blocks), "system ต้องเดินทางเป็นบล็อกถึงจะปักหมุดได้");
  assert.equal(blocks.length, 2, "แบ่งเป็น 2 ก้อน: คงที่ / เปลี่ยนทุกเทิร์น");
  assert.deepEqual(blocks[0].prompt_cache_breakpoint, { mode: "explicit" }, "หมุดต้องอยู่ก้อนแรก");
  assert.equal(blocks[1].prompt_cache_breakpoint, undefined, "ห้ามปักหมุดในก้อนที่เปลี่ยนทุกเทิร์น");

  // ส่วนคงที่ต้องมีความรู้ทีมงาน ส่วนที่เปลี่ยนต้องไม่มี — ไม่งั้น prefix พังทุกเทิร์นเหมือนเดิม
  assert.ok(blocks[0].text.includes("กดปุ่มเปิดค้าง 3 วินาที"), "ความรู้ต้องอยู่ในก้อนคงที่");
  assert.ok(!blocks[1].text.includes("กดปุ่มเปิดค้าง 3 วินาที"), "ความรู้ห้ามซ้ำอยู่ในก้อนที่เปลี่ยน");

  // กันแอบเปลี่ยน prompt มาพร้อมกับงานประหยัดเงิน: ต่อกันแล้วต้องได้ข้อความเดิมเป๊ะ
  const joined = promptText(blocks);
  assert.ok(joined.includes("ความรู้เพิ่มเติมจากทีมงาน:\n[วิธีติดตั้ง]"));
  assert.ok(joined.includes("แบรนด์: ทดสอบ"));
  assert.ok(blocks[0].text.endsWith("\n\n"), "ก้อนคงที่ต้องลงท้ายด้วยตัวคั่นที่ join เดิมเคยใส่ให้");
  db.close();
});

// ข้อพิสูจน์ตัวจริงว่า "แบ่งบล็อกแล้วโมเดลเห็นเหมือนเดิมทุกตัวอักษร" — เทียบกับการต่อ
// สตริงแบบเดิมตรง ๆ ทดสอบที่ตัวสะพานเลยเพื่อคุมส่วนประกอบได้ครบทั้ง 4 ก้อน
test("prompt cache: ต่อบล็อกกลับมาแล้วต้องเท่ากับการ join แบบเดิมเป๊ะ", async () => {
  const { createHermesBridge } = await import("../src/hermesBridge.mjs");
  const parts = {
    knowledge: "ความรู้เพิ่มเติมจากทีมงาน:\n[ก]\nเนื้อหา ก\n",  // จงใจลงท้ายด้วย \n
    persona: "บุคลิก: ลูกแพร\n",
    brandPack: "การ์ดที่เกี่ยวข้อง: ข",
    rules: "- กติกา ค",
  };
  let sent = null;
  const bridge = createHermesBridge({
    config: { hermesBase: "http://x", hermesModel: "gpt-5.6-sol", hermesTimeoutMs: 1000, hermesApiKey: "" },
    fetchImpl: async (_url, opts) => {
      sent = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ok" } }] }) };
    },
    logger: silent,
  });
  await bridge.draftReply({ ...parts, history: [], userText: "สวัสดี" });

  const expected = [parts.knowledge, parts.persona, parts.brandPack, parts.rules].join("\n\n");
  assert.equal(promptText(sent.messages[0].content), expected, "ข้อความที่โมเดลเห็นต้องไม่เปลี่ยนแม้แต่ตัวเดียว");
  assert.deepEqual(sent.prompt_cache_options, { mode: "explicit" });
  assert.equal(sent.prompt_cache_key, "lukprae-hermes");
});
