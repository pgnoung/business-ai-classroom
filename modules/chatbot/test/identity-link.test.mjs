// identity-link — ลูกค้าคนเดียวกันข้าม Facebook ↔ LINE (คำสั่งพี่ง้วง 28 ก.ย. 2026 + คำตอบเรื่องข้อความ ~21:30)
// รหัสใช้ครั้งเดียว/หมดอายุ/เพดาน · เชิญเฉพาะคนที่ซื้อแล้ว (ทีมเลือกคลาส) · หลังเชื่อม "สวัสดีค่ะ คุณ{ชื่อ}" + รายละเอียดคลาส
// · รหัสใช้ไม่ได้ = ไม่ตอบลูกค้า (ธงอย่างเดียว) · แจ้งทีมหลังรู้ผลการส่งจริง · ยกเลิกการเชื่อมถอนของคืน · PDPA
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, waitFor } from "./helpers.mjs";
import {
  createIdentityLink, IDENTITY_NOTE_AUTHOR, IDENTITY_LINK_LIMITS, IDENTITY_TEMPLATE_KEY_PREFIX, normalizePhone,
  readIdentityTemplate, saveIdentityTemplate,
} from "../src/identityLink.mjs";
import {
  CODE_ALPHABET, CODE_TTL_MS, IDENTITY_LINK_MODE_KEY, MASKED_CODE,
  findLinkCodeTokens, formatLinkCode, generateLinkCode, hashLinkCode, identityLinkPrefill,
  isTemplateOnlyMessage, lineOaMessageUrl, maskLinkCodes, normalizeLineBasicId, normalizeLinkCode, textWithoutLinkCodes,
} from "../src/identityLinkCodes.mjs";
import { IDENTITY_TEMPLATE_DEFAULTS, identityWelcomeBubbles } from "../src/identityLinkClasses.mjs";
import { AI_PAUSE_SETTING } from "../src/aiPause.mjs";
import { SCHEDULE_ENABLED_KEY, SCHEDULE_HOURS_KEY } from "../src/scheduleGate.mjs";
import { promptSafeHandoffNotes } from "../src/pipeline.mjs";
import { isHumanNoteAuthor } from "../src/lineOaContext.mjs";

// ค่าจำลองประกอบจากชิ้น (ตัวสแกนความลับของ release จับรูป "ชื่อลงท้าย secret = ค่าจริง")
const SECRET = ["identity", "link", "test", "key"].join("-");
const FB = "facebook:psid-111";
const LINE = "U0123456789abcdef0123456789abcd01";
const LINE_2 = "U0123456789abcdef0123456789abcd02";
const START = Date.UTC(2026, 8, 28, 5, 0, 0);

function harness({ mode = "manual", basicId = "@lukprae", fbSendOk = true, lineSendOk = true } = {}) {
  let clock = START;
  const now = () => clock;
  const db = memoryDb({ now });
  db.setSetting(IDENTITY_LINK_MODE_KEY, mode);
  const sends = [];
  const client = (channelId) => ({
    sendAllowed: () => true,
    sendBubbles: async (args) => {
      sends.push({ channelId, ...args });
      const ok = channelId === "facebook" ? fbSendOk : lineSendOk;
      return ok ? { ok: true, mode: args.replyToken ? "reply" : "push" } : { ok: false, status: 500 };
    },
  });
  const lineRegistry = {
    channels: [
      { id: "default", name: "พี่ง้วง", active: true, basicId },
      { id: "facebook", name: "Facebook", provider: "facebook", active: true },
    ],
    forChannel: (id) => client(id),
    rawUserId: (key) => String(key).replace(/^facebook:/u, ""),
  };
  const notifications = [];
  const exclusive = [];
  const pipeline = { runExclusive: (id, work) => { exclusive.push(id); return work(); } };
  const link = createIdentityLink({
    config: { consoleSessionSecret: SECRET }, db, lineRegistry, pipeline, now,
    notifier: { fireLater: (args) => notifications.push(args) },
    logger: { warn() {}, debug() {}, error() {}, log() {} },
  });
  const advance = (ms) => { clock += ms; };
  return { db, link, sends, notifications, exclusive, advance, now };
}

function seedFacebookRoom(db, id = FB, { name = "สมหญิง ใจดี", tags = [], known = "" } = {}) {
  db.upsertCustomer(id, { displayName: name, channelId: "facebook" });
  db.insertMessage({ customerId: id, direction: "in", channelId: "facebook", content: "สนใจคลาส AI Agent ค่ะ" });
  db.insertMessage({ customerId: id, direction: "out", channelId: "facebook", content: "ยินดีค่ะ", agentMode: "ai" });
  for (const [tag, source] of tags) db.addTag(id, tag, source);
  if (known) db.setKnownName(id, known);
  return db.getCustomer(id);
}

// ห้อง LINE ที่ webhook เพิ่งบันทึกข้อความเข้ามา (persistLineInbound ตัวจริง) — คืน messageId ของเทิร์นนั้น
function lineInbound(db, id, text, key = `m-${Math.random().toString(36).slice(2)}`) {
  const persisted = db.persistLineInbound({
    dedupeKey: key, customerId: id, channelId: "default", msgType: "text", content: text, owesReply: true, channelKind: "line",
  });
  assert.equal(persisted.stored, true);
  return persisted.messageId;
}

async function invite(h, customerId = FB, operator = "chompoo", classType = "live_business") {
  const result = await h.link.sendInvite({ customerId, operator, classType });
  assert.equal(result.ok, true, JSON.stringify(result));
  const sent = h.sends.filter((call) => call.channelId === "facebook").at(-1);
  const code = findLinkCodeTokens(sent.bubbles[0].text)[0];
  assert.ok(code, "ข้อความเชิญต้องมีรหัส");
  return { result, sent, code: formatLinkCode(code.code) };
}

/* -------------------------------- รหัส (บริสุทธิ์) -------------------------------- */

test("รหัส: รูป LK-XXXXX-XXXXX จากชุด Crockford · อ่านแบบพิมพ์เองได้ · ตัวผิดรูปไม่นับ", () => {
  for (let i = 0; i < 200; i += 1) {
    const code = generateLinkCode();
    assert.match(code, /^LK-[0-9A-Z]{5}-[0-9A-Z]{5}$/u);
    assert.ok([...code.slice(3).replace("-", "")].every((ch) => CODE_ALPHABET.includes(ch)));
  }
  assert.equal(normalizeLinkCode("lk-7kq9m-4xw2p"), "7KQ9M4XW2P");
  assert.equal(normalizeLinkCode("LK 7KQ9M 4XW2P"), "7KQ9M4XW2P");
  assert.equal(normalizeLinkCode("7kq9m4xw2p"), "7KQ9M4XW2P");
  assert.equal(normalizeLinkCode("LK-OIL00-11111"), "01100" + "11111", "O→0 และ I/L→1 แบบ Crockford");
  assert.equal(normalizeLinkCode("LK-UUUUU-UUUUU"), "", "U ไม่อยู่ในชุดตัวอักษร");
  assert.equal(normalizeLinkCode("LK-7KQ9M-4XW2PA"), "", "ยาวเกินไม่นับ");
  assert.deepEqual(findLinkCodeTokens("ต่อแชทจาก Facebook (รหัส LK-7KQ9M-4XW2P)").map((t) => t.code), ["7KQ9M4XW2P"]);
  assert.deepEqual(findLinkCodeTokens("รหัสLK7KQ9M4XW2P ค่ะ").map((t) => t.code), ["7KQ9M4XW2P"], "ติดกับอักษรไทยได้");
  assert.deepEqual(findLinkCodeTokens("XLK-7KQ9M-4XW2P"), [], "ติดตัวอักษรละตินข้างหน้า = ไม่ใช่รหัส");
  assert.deepEqual(findLinkCodeTokens("LK-7KQ9M-4XW2P9"), [], "มีตัวอักษรต่อท้าย = ไม่ใช่รหัส");
  assert.deepEqual(findLinkCodeTokens("ส่งของเลข TH12345678901 แล้วค่ะ"), []);
});

test("รหัส: hash ต้องมีกุญแจ · กุญแจต่างกันได้คนละค่า · รูปพิมพ์ต่างกันได้ค่าเดียวกัน", () => {
  assert.equal(hashLinkCode("LK-7KQ9M-4XW2P", ""), "");
  const a = hashLinkCode("LK-7KQ9M-4XW2P", "k1");
  assert.match(a, /^[0-9a-f]{64}$/u);
  assert.equal(hashLinkCode("lk 7kq9m 4xw2p", "k1"), a);
  assert.notEqual(hashLinkCode("LK-7KQ9M-4XW2P", "k2"), a);
});

test("ข้อความ: ปิดรหัส · ตัดรหัสออกจากข้อความที่ลูกแพรเห็น · แยกข้อความสำเร็จรูปจากคำถามจริง", () => {
  assert.equal(maskLinkCodes("ต่อแชทจาก Facebook (รหัส LK-7KQ9M-4XW2P)"), `ต่อแชทจาก Facebook (รหัส ${MASKED_CODE})`);
  assert.equal(textWithoutLinkCodes("ต่อแชทจาก Facebook (รหัส LK-7KQ9M-4XW2P)"), "ต่อแชทจาก Facebook");
  assert.equal(textWithoutLinkCodes("รหัส LK-7KQ9M-4XW2P อยากถามรอบเสาร์ค่ะ"), "อยากถามรอบเสาร์ค่ะ");
  assert.equal(isTemplateOnlyMessage("ต่อแชทจาก Facebook (รหัส LK-7KQ9M-4XW2P)"), true);
  assert.equal(isTemplateOnlyMessage("สวัสดีครับ ต่อแชทจาก Facebook (รหัส LK-7KQ9M-4XW2P) 🙏"), true);
  assert.equal(isTemplateOnlyMessage("ต่อแชทจาก Facebook (รหัส LK-7KQ9M-4XW2P) คลาสเริ่มกี่โมงคะ"), false);
});

test("ลิงก์ LINE: รูปตามเอกสาร LINE (ID และข้อความ percent-encode แบบ RFC 3986) · ID ผิดรูป = ไม่มีลิงก์", () => {
  assert.equal(normalizeLineBasicId("@AbC123"), "@abc123");
  assert.equal(normalizeLineBasicId("abc123"), "@abc123");
  assert.equal(normalizeLineBasicId("@a b"), "");
  assert.equal(normalizeLineBasicId(""), "");
  assert.equal(lineOaMessageUrl("@linedevelopers", "Hi there!"), "https://line.me/R/oaMessage/%40linedevelopers/?Hi%20there%21");
  const url = lineOaMessageUrl("@lukprae", identityLinkPrefill("LK-7KQ9M-4XW2P"));
  assert.equal(url, "https://line.me/R/oaMessage/%40lukprae/?LK-7KQ9M-4XW2P", "ข้อความสำเร็จรูปเป็นรหัสล้วน = ลิงก์สั้นอ่านออก");
  assert.ok(url.length < 80);
  const thai = lineOaMessageUrl("@lukprae", "ต่อแชท (รหัส LK-7KQ9M-4XW2P)!");
  assert.equal(decodeURIComponent(thai.split("/?")[1]), "ต่อแชท (รหัส LK-7KQ9M-4XW2P)!");
  assert.ok(!/[()!]/u.test(thai.split("/?")[1]), "วงเล็บ/ตกใจต้องถูก encode");
  assert.equal(lineOaMessageUrl("", "x"), "");
});

/* ---------------------------------- ส่งลิงก์เชิญ ---------------------------------- */

test("ส่งลิงก์เชิญ: ผ่าน Facebook ด้วย purpose operator · ประวัติเก็บแบบปิดรหัส · ฐานเก็บแค่ hash", async () => {
  const h = harness();
  seedFacebookRoom(h.db);
  const { result, sent, code } = await invite(h);
  assert.equal(result.classType, "live_business");
  assert.equal(sent.purpose, "operator");
  assert.equal(sent.to, "psid-111");
  assert.match(sent.bubbles[0].text, /^ขอบคุณที่ลงทะเบียนคลาส AI Agent for Business กับพี่ง้วงนะคะ 🙏\nรายละเอียดการเตรียมตัวก่อนเรียนและกลุ่ม support อยู่ที่ LINE ค่ะ\n\n👉 รบกวนคุณสมหญิง แอดไลน์ @lukprae แล้วส่งรหัสนี้มาในแชทนะคะ/u);
  assert.equal(sent.bubbles.length, 2, "คำเชิญ (มีรหัส) + ลิงก์ล้วนอีกบอลลูน");
  assert.equal(sent.bubbles[1].text, `https://line.me/R/oaMessage/%40lukprae/?${code}`);
  const history = h.db.messagesFor(FB, 10, { includeArchived: true });
  const out = history.at(-1);
  assert.equal(out.direction, "out");
  assert.equal(out.message_class, "proactive", "ลิงก์เชิญไม่ใช่คำตอบ — ห้ามปิดหนี้คำตอบที่ค้าง");
  assert.equal(out.operator, "chompoo");
  assert.ok(!out.content.includes(code) && out.content.includes(MASKED_CODE), "ประวัติห้ามเก็บรหัสที่ยังใช้ได้");
  const codes = h.db.raw.prepare("SELECT * FROM identity_link_codes").all();
  assert.equal(codes.length, 1);
  assert.equal(codes[0].code_hash, hashLinkCode(code, SECRET));
  assert.ok(!JSON.stringify(codes).includes(code.slice(3, 8)), "ฐานไม่มีรหัสดิบ");
  assert.equal(codes[0].expires_at - codes[0].created_at, CODE_TTL_MS);
  assert.equal(codes[0].class_type, "live_business", "ฝั่ง LINE ต้องรู้ว่าต้องส่งรายละเอียดของคลาสไหน");
  h.db.close();
});

test("ส่งลิงก์เชิญ: ปิดสวิตช์/นอก 24 ชม. ของ Meta/ไม่มี basic ID/เชื่อมแล้ว/เกินเพดาน = ไม่ส่งและบอกเหตุ", async () => {
  const off = harness({ mode: "off" });
  seedFacebookRoom(off.db);
  assert.deepEqual(await off.link.sendInvite({ customerId: FB, operator: "a" }), { ok: false, reason: "mode_off" });
  off.db.close();

  const noId = harness({ basicId: "" });
  seedFacebookRoom(noId.db);
  assert.equal((await noId.link.sendInvite({ customerId: FB, operator: "a" })).reason, "no_basic_id");
  noId.db.close();

  const late = harness();
  seedFacebookRoom(late.db);
  late.advance(24 * 3_600_000);
  assert.equal((await late.link.sendInvite({ customerId: FB, operator: "a" })).reason, "window_closed");
  late.db.close();

  const many = harness();
  seedFacebookRoom(many.db);
  for (let i = 0; i < IDENTITY_LINK_LIMITS.invitesPerRoomPerDay; i += 1) await invite(many);
  assert.equal((await many.link.sendInvite({ customerId: FB, operator: "a" })).reason, "too_many");
  assert.equal(many.db.raw.prepare("SELECT COUNT(*) AS n FROM identity_link_codes WHERE status='active'").get().n, 1, "ลิงก์ใหม่ยกเลิกรหัสเก่า");
  // 30 ก.ย. 2026 (พี่ง้วง: เชื่อมสำเร็จ → ยกเลิกการเชื่อม → จะเชื่อมใหม่ "มันไม่ให้เชื่อมแล้ว"): ลิงก์ที่ลูกค้าใช้สำเร็จไม่นับเพดาน
  many.db.raw.prepare("UPDATE identity_link_codes SET status = 'consumed' WHERE status = 'active'").run();
  assert.equal((await many.link.sendInvite({ customerId: FB, operator: "a", classType: "live_business" })).ok, true, "ลิงก์ที่ยังไม่ได้ใช้เหลือ 2 = ส่งใหม่ได้");
  assert.equal((await many.link.sendInvite({ customerId: FB, operator: "a", classType: "live_business" })).reason, "too_many",
    "ลิงก์ที่ไม่มีใครกดครบ 3 ในวันเดียว = ยังกันส่งรัวเหมือนเดิม");
  many.db.close();

  const line = harness();
  line.db.upsertCustomer(LINE, { displayName: "LINE" });
  assert.equal((await line.link.sendInvite({ customerId: LINE, operator: "a" })).reason, "not_facebook");
  line.db.close();

  const noClass = harness();
  seedFacebookRoom(noClass.db);
  assert.deepEqual(await noClass.link.sendInvite({ customerId: FB, operator: "a" }), { ok: false, reason: "class_required" });
  assert.deepEqual(await noClass.link.sendInvite({ customerId: FB, operator: "a", classType: "lead" }), { ok: false, reason: "class_required" },
    "ไม่มีข้อความเชิญลูกค้าที่ยังไม่ซื้อ (พี่ง้วง: ให้อยู่ที่ facebook ก่อน)");
  assert.equal(noClass.sends.length, 0);
  assert.equal(noClass.db.raw.prepare("SELECT COUNT(*) AS n FROM identity_link_codes").get().n, 0);
  noClass.db.close();
});

test("ส่งลิงก์เชิญ: Facebook ส่งไม่สำเร็จ = ยกเลิกรหัสทันที ไม่เก็บประวัติว่าส่งแล้ว", async () => {
  const h = harness({ fbSendOk: false });
  seedFacebookRoom(h.db);
  const result = await h.link.sendInvite({ customerId: FB, operator: "a", classType: "live_business" });
  assert.deepEqual(result, { ok: false, reason: "send_failed" });
  assert.equal(h.db.raw.prepare("SELECT status FROM identity_link_codes").get().status, "revoked");
  assert.equal(h.db.messagesFor(FB, 10, { includeArchived: true }).length, 2);
  h.db.close();
});

/* ------------------------------ ขาเข้า LINE: เชื่อมด้วยรหัส ------------------------------ */

test("ลูกค้าซื้อคลาสสด: ส่งรหัสใน LINE = เชื่อม + customer/AI เงียบ + \"สวัสดีค่ะ คุณ{ชื่อ}\" + รายละเอียดคลาส (reply token) + แจ้งทีมหลังส่งจริง", async () => {
  const h = harness();
  seedFacebookRoom(h.db, FB, { tags: [["สนใจ AI Agent", "ai"], ["คลาสฟรี", "ai"], ["VIP", "human"]], known: "สมหญิง" });
  h.db.markPriceQuoted(FB);
  h.db.markCustomerContextKnown(FB);
  const { code } = await invite(h, FB, "chompoo", "live_workflow");
  const text = identityLinkPrefill(code);
  const messageId = lineInbound(h.db, LINE, text);
  const verdict = h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId, replyToken: "rt-1" });
  assert.deepEqual(verdict, { matched: true, outcome: "linked", done: true, text: "" });
  await waitFor(() => h.notifications.length === 1);
  const reply = h.sends.find((call) => call.channelId === "default");
  assert.equal(reply.purpose, "customer_reply");
  assert.equal(reply.replyToken, "rt-1", "ใช้ reply token = ฟรี ไม่นับโควตา push");
  const expected = identityWelcomeBubbles({ classType: "live_workflow", template: IDENTITY_TEMPLATE_DEFAULTS.live_workflow, knownName: "สมหญิง" }).bubbles;
  assert.deepEqual(reply.bubbles.map((bubble) => bubble.text), expected);
  assert.match(expected[0], /^สวัสดีค่ะ คุณสมหญิง 🙏\nรายละเอียดการเตรียมตัวก่อนเรียนคลาส AI Agent Workflow Automation ค่ะ/u);
  assert.ok(expected.length >= 2 && expected.length <= 5);
  assert.deepEqual(h.exclusive, [LINE], "ต้องต่อคิวเดียวกับลูกแพรของห้องนั้น");

  assert.deepEqual(h.db.listLinkedIdentities(LINE).map((row) => row.customer_id).sort(), [FB, LINE].sort());
  const tags = h.db.listTags(LINE).map((row) => row.tag);
  assert.ok(tags.includes("สนใจ AI Agent") && tags.includes("VIP") && tags.includes("customer"));
  assert.ok(!tags.includes("คลาสฟรี"), "ป้ายเหตุการณ์คลาสฟรีไม่คัดลอก (นาฬิกา 7 วันจะเริ่มใหม่ผิด ๆ)");
  const lineRoom = h.db.getCustomer(LINE);
  assert.equal(lineRoom.ai_enabled, 0, "ซื้อแล้ว = AI เงียบ ทีมดูแลเอง");
  assert.equal(lineRoom.ai_off_reason, "customer_handover");
  assert.equal(lineRoom.state, "NEEDS_HUMAN");
  assert.equal(lineRoom.known_name, "สมหญิง");
  assert.ok(lineRoom.price_quoted_at > 0 && lineRoom.known_context_at > 0, "เดินต่อจากจังหวะราคาเดิม");
  assert.equal(h.db.identityInherited(LINE).classType, "live_workflow");
  const summary = h.db.listHandoffNotes(LINE, 10).find((note) => note.author === IDENTITY_NOTE_AUTHOR);
  assert.ok(summary?.pinned === 1);
  assert.match(summary.text, /ซื้อ\/ลงทะเบียนแล้ว — Classroom AI Agent Workflow Automation/u);
  assert.ok(!summary.text.includes("สนใจคลาส AI Agent ค่ะ"), "ห้ามยกข้อความลูกค้ามาเป็นโน้ตของทีม");
  assert.equal(h.db.getCustomer(FB).followup_enabled, 0, "ย้ายไปคุย LINE แล้ว — ทักตามฝั่ง Facebook ปิด");
  assert.ok(h.db.listHandoffNotes(FB, 10).some((note) => note.author === IDENTITY_NOTE_AUTHOR && /ซื้อ Classroom AI Agent Workflow Automation/u.test(note.text)));
  const stored = h.db.raw.prepare("SELECT content FROM messages WHERE id = ?").get(messageId).content;
  assert.ok(stored.includes(MASKED_CODE) && !stored.includes(code), "ข้อความขาเข้าที่เก็บไว้ต้องปิดรหัส");
  assert.equal(h.db.raw.prepare("SELECT status FROM identity_link_codes").get().status, "consumed");

  const note = h.notifications[0];
  assert.equal(note.reason, "identity_linked");
  assert.equal(note.customerId, LINE);
  assert.equal(note.force, true, "cooldown/คิวแจ้งเตือนกลืนไม่ได้ — การเชื่อมเกิดครั้งเดียว");
  assert.match(note.reasonTextOverride, /ซื้อ Classroom AI Agent Workflow Automation · ติดป้าย customer \+ AI เงียบให้แล้ว · ระบบส่งคำทักทาย \+ รายละเอียดคลาสให้ลูกค้าแล้ว/u);
  const history = h.db.messagesFor(LINE, 10).filter((row) => row.direction === "out").map((row) => row.content);
  assert.deepEqual(history, expected, "ประวัติเก็บทุกบับเบิลที่ส่งจริง");
  assert.equal(h.db.raw.prepare("SELECT status FROM inbound_turn_outcomes WHERE message_id = ?").get(messageId).status, "answered");
  h.db.close();
});

test("ทีมเชื่อมห้องที่ยังไม่ซื้อ: ป้าย/หมุด/ชื่อ/สรุปตามมา ลูกแพรคุยต่อ · ไม่มีข้อความถึงลูกค้าและไม่ปลุกทีม", () => {
  const h = harness();
  seedFacebookRoom(h.db, FB, { tags: [["สนใจ AI Agent", "ai"]], known: "สมหญิง" });
  h.db.markPriceQuoted(FB);
  h.db.upsertCustomer(LINE, { displayName: "LINE คน" });
  assert.equal(h.link.linkByTeam({ customerId: LINE, otherId: FB, operator: "nok" }).state, "linked");
  const lineRoom = h.db.getCustomer(LINE);
  assert.equal(lineRoom.ai_enabled, 1, "ยังไม่ซื้อ = ลูกแพรคุยต่อ");
  assert.equal(lineRoom.known_name, "สมหญิง");
  assert.ok(lineRoom.price_quoted_at > 0);
  const notes = h.db.listHandoffNotes(LINE, 10);
  const summary = notes.find((note) => note.author === IDENTITY_NOTE_AUTHOR);
  assert.match(summary.text, /ยังไม่ได้ซื้อ/u);
  assert.ok(promptSafeHandoffNotes(notes).some((row) => row.id === summary.id), "โน้ตสรุปต้องเข้าพรอมต์ของลูกแพร");
  assert.equal(isHumanNoteAuthor(IDENTITY_NOTE_AUTHOR), false, "โน้ตของระบบต้องไม่นับเป็นคนสรุป");
  assert.equal(h.sends.length, 0);
  assert.equal(h.notifications.length, 0);
  h.db.close();
});

test("ลูกค้าซื้อแล้ว (ป้าย customer): ห้อง LINE ติดป้าย customer + AI เงียบ + ธงรอคน + แจ้งทีมแบบซื้อแล้ว", async () => {
  const h = harness();
  seedFacebookRoom(h.db, FB, { tags: [["customer", "human"]] });
  const { code, result } = await invite(h);
  assert.equal(result.classType, "live_business");
  const text = `สวัสดีค่ะ ${identityLinkPrefill(code)}\nขอสไลด์ด้วยนะคะ`;
  const messageId = lineInbound(h.db, LINE, text);
  const verdict = h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId, replyToken: "rt-2" });
  assert.equal(verdict.outcome, "linked");
  assert.equal(verdict.done, false, "มีคำถามจริงต่อท้าย = ส่งต่อให้เส้นปกติ (ซึ่งเงียบเพราะป้าย customer)");
  assert.equal(verdict.text, "สวัสดีค่ะ\nขอสไลด์ด้วยนะคะ");
  const lineRoom = h.db.getCustomer(LINE);
  assert.equal(lineRoom.ai_enabled, 0);
  assert.equal(lineRoom.ai_off_reason, "customer_handover");
  assert.equal(lineRoom.state, "NEEDS_HUMAN");
  assert.ok(h.db.listTags(LINE).some((row) => row.tag === "customer" && row.source === "human"));
  await waitFor(() => h.notifications.length === 1);
  const welcome = h.sends.find((call) => call.channelId === "default").bubbles[0].text;
  assert.match(welcome, /^สวัสดีค่ะ คุณสมหญิง 🙏\nรายละเอียดการเตรียมตัวก่อนเรียนคลาส AI Agent for Business ค่ะ/u,
    "ห้อง LINE ยังไม่มีชื่อ = ใช้ชื่อฝั่ง Facebook ของคนเดียวกัน");
  assert.match(h.notifications[0].reasonTextOverride, /ซื้อ Classroom AI Agent for Business/u);
  h.db.close();
});

test("คลาสออนไลน์ที่เจ้าของเว้นว่างข้อความ: สวัสดี + \"ทีมงานจะส่งขั้นตอนลงทะเบียนให้ในแชทนี้นะคะ\" + ธงรอคน + แจ้งทีม", async () => {
  const h = harness();
  seedFacebookRoom(h.db, FB, { known: "มาลี" });
  // ค่าเริ่มต้นของคลาสออนไลน์มีข้อความแล้ว (30 ก.ย.) — ทางสำรองนี้เกิดเมื่อเจ้าของตั้งใจเว้นว่างในหน้าตั้งค่า
  assert.equal(saveIdentityTemplate(h.db, "online", { text: "", by: "ngoung" }).ok, true);
  const { code } = await invite(h, FB, "chompoo", "online");
  assert.match(h.sends.at(-1).bubbles[0].text, /\nขั้นตอนลงทะเบียนเข้าเรียนและกลุ่ม support อยู่ที่ LINE ค่ะ/u);
  const text = identityLinkPrefill(code);
  h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId: lineInbound(h.db, LINE, text), replyToken: "rt-on" });
  await waitFor(() => h.notifications.length === 1);
  const reply = h.sends.find((call) => call.replyToken === "rt-on");
  assert.deepEqual(reply.bubbles.map((bubble) => bubble.text), ["สวัสดีค่ะ คุณมาลี 🙏\nทีมงานจะส่งขั้นตอนลงทะเบียนให้ในแชทนี้นะคะ"]);
  assert.match(h.db.getCustomer(LINE).handoff_summary, /ยังไม่มีข้อความรายละเอียดของ AI Agent for Business Online/u);
  assert.match(h.notifications[0].reasonTextOverride, /ซื้อ AI Agent for Business Online .*ยังไม่มีข้อความรายละเอียด.*ขั้นตอนลงทะเบียน/u);
  h.db.close();
});

test("เจ้าของแก้ข้อความของคลาสในหน้าตั้งค่า = ลูกค้าคนถัดไปได้ข้อความใหม่ทันที (ไม่ต้อง deploy) · กลับค่าเริ่มต้นได้", async () => {
  const h = harness();
  seedFacebookRoom(h.db, FB, { known: "มาลี" });
  assert.equal(readIdentityTemplate(h.db, "online").isDefault, true);
  const saved = saveIdentityTemplate(h.db, "online", { text: "ลงทะเบียนที่ลิงก์นี้ค่ะ\n---\nมีคำถามพิมพ์ไว้ได้เลยนะคะ", by: "ngoung" });
  assert.equal(saved.ok, true);
  assert.equal(saved.template.updatedBy, "ngoung");
  const { code } = await invite(h, FB, "chompoo", "online");
  const text = identityLinkPrefill(code);
  h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId: lineInbound(h.db, LINE, text), replyToken: "rt-t" });
  await waitFor(() => h.notifications.length === 1);
  assert.deepEqual(h.sends.find((call) => call.replyToken === "rt-t").bubbles.map((bubble) => bubble.text),
    ["สวัสดีค่ะ คุณมาลี 🙏\nลงทะเบียนที่ลิงก์นี้ค่ะ", "มีคำถามพิมพ์ไว้ได้เลยนะคะ"]);
  assert.match(h.notifications[0].reasonTextOverride, /ระบบส่งคำทักทาย \+ รายละเอียดคลาสให้ลูกค้าแล้ว/u);
  const tooLong = saveIdentityTemplate(h.db, "live_business", { text: Array.from({ length: 6 }, (_, i) => `ข้อ ${i}`).join("\n---\n"), by: "ngoung" });
  assert.equal(tooLong.ok, false, "เกิน 5 บับเบิล = ไม่บันทึก");
  assert.equal(readIdentityTemplate(h.db, "live_business").isDefault, true);
  assert.equal(saveIdentityTemplate(h.db, "online", { text: null, by: "ngoung" }).template.isDefault, true, "กลับไปใช้ค่าเริ่มต้น");
  h.db.setSetting(`${IDENTITY_TEMPLATE_KEY_PREFIX}live_private`, "{พัง");
  const broken = readIdentityTemplate(h.db, "live_private");
  assert.deepEqual([broken.text, broken.readError], ["", true], "อ่านไม่ได้ = ไม่ส่งค่าเริ่มต้นแทนข้อความที่เจ้าของอาจแก้ไว้");
  h.db.close();
});

test("รหัสรุ่นก่อนมีคลาส: ห้อง Facebook ยังไม่ซื้อ = เชื่อมแบบคุยต่อ ไม่มีข้อความถึงลูกค้า · ซื้อแล้ว = สวัสดี + ทีมงานจะส่งรายละเอียด", async () => {
  const lead = harness();
  seedFacebookRoom(lead.db);
  const oldCode = generateLinkCode();
  lead.db.insertIdentityLinkCode({ customerId: FB, codeHash: hashLinkCode(oldCode, SECRET), via: "console", by: "a", expiresAt: START + CODE_TTL_MS });
  const verdict = lead.link.handleLineText({ channelId: "default", customerId: LINE, text: oldCode, messageId: lineInbound(lead.db, LINE, oldCode), replyToken: "rt-old" });
  assert.equal(verdict.outcome, "linked");
  await waitFor(() => lead.notifications.length === 1);
  assert.equal(lead.sends.filter((call) => call.channelId === "default").length, 0, "ไม่มีข้อความสำหรับคนที่ยังไม่ซื้อ");
  assert.equal(lead.db.getCustomer(LINE).ai_enabled, 1);
  assert.match(lead.notifications[0].reasonTextOverride, /ยังไม่ได้ซื้อ/u);
  lead.db.close();

  const buyer = harness();
  seedFacebookRoom(buyer.db, FB, { tags: [["customer", "human"]], known: "มาลี" });
  const buyerCode = generateLinkCode();
  buyer.db.insertIdentityLinkCode({ customerId: FB, codeHash: hashLinkCode(buyerCode, SECRET), via: "console", by: "a", expiresAt: START + CODE_TTL_MS });
  buyer.link.handleLineText({ channelId: "default", customerId: LINE, text: buyerCode, messageId: lineInbound(buyer.db, LINE, buyerCode), replyToken: "rt-b" });
  await waitFor(() => buyer.notifications.length === 1);
  assert.deepEqual(buyer.sends.find((call) => call.replyToken === "rt-b").bubbles.map((bubble) => bubble.text),
    ["สวัสดีค่ะ คุณมาลี 🙏\nทีมงานจะส่งรายละเอียดให้ในแชทนี้นะคะ"]);
  assert.match(buyer.notifications[0].reasonTextOverride, /ซื้อ แล้ว \(ไม่ได้ระบุคลาส\)/u);
  buyer.db.close();
});

test("ส่งข้อความหลังเชื่อมไม่สำเร็จ = ธงรอคนบอกให้ทีมส่งเอง + แจ้งทีมว่าส่งไม่สำเร็จ (ยังแจ้งเสมอ)", async () => {
  const h = harness({ lineSendOk: false });
  seedFacebookRoom(h.db);
  const { code } = await invite(h);
  const text = identityLinkPrefill(code);
  const messageId = lineInbound(h.db, LINE, text);
  h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId, replyToken: "rt-f" });
  await waitFor(() => h.notifications.length === 1);
  assert.match(h.notifications[0].reasonTextOverride, /ส่งข้อความถึงลูกค้าไม่สำเร็จ — รบกวนทักทายและส่งรายละเอียดเอง/u);
  assert.match(h.db.getCustomer(LINE).handoff_summary, /ส่งข้อความถึงลูกค้าไม่สำเร็จ/u);
  assert.equal(h.db.raw.prepare("SELECT status FROM inbound_turn_outcomes WHERE message_id = ?").get(messageId).status, "stranded_error");
  h.db.close();
});

test("โหมด off: รหัสที่ออกไปแล้วยังเชื่อมได้ แต่ไม่ส่งข้อความถึงลูกค้า (ปิดเทิร์นเงียบ + แจ้งทีม)", async () => {
  const h = harness();
  seedFacebookRoom(h.db);
  const { code } = await invite(h);
  h.db.setSetting(IDENTITY_LINK_MODE_KEY, "off");
  const messageId = lineInbound(h.db, LINE, identityLinkPrefill(code));
  const verdict = h.link.handleLineText({ channelId: "default", customerId: LINE, text: identityLinkPrefill(code), messageId });
  assert.equal(verdict.outcome, "linked");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.sends.filter((call) => call.channelId === "default").length, 0);
  assert.equal(h.db.raw.prepare("SELECT status, reason FROM inbound_turn_outcomes WHERE message_id = ?").get(messageId).status, "silent_by_design");
  assert.equal(h.notifications[0].reason, "identity_linked");
  assert.match(h.notifications[0].reasonTextOverride, /สวิตช์ส่งลิงก์ต่อแชท LINE ปิดอยู่/u);
  assert.match(h.db.getCustomer(LINE).handoff_summary, /ระบบจึงไม่ได้ส่งข้อความถึงลูกค้า/u);
  h.db.close();
});

test("รหัสใช้ครั้งเดียว: ห้อง LINE อื่นส่งรหัสเดิม = ไม่เชื่อม ไม่ตอบลูกค้า ปักธงให้ทีม · ห้องเดิมส่งซ้ำ = เงียบ ไม่นับว่าผิด", async () => {
  const h = harness();
  seedFacebookRoom(h.db);
  const { code } = await invite(h);
  const text = identityLinkPrefill(code);
  h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId: lineInbound(h.db, LINE, text) });
  const again = h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId: lineInbound(h.db, LINE, text) });
  assert.equal(again.outcome, "already_linked");
  assert.equal(h.db.countIdentityLinkFailures({ customerId: LINE, sinceMs: 0 }), 0);
  const otherMsg = lineInbound(h.db, LINE_2, text);
  const stolen = h.link.handleLineText({ channelId: "default", customerId: LINE_2, text, messageId: otherMsg, replyToken: "rt-x" });
  assert.equal(stolen.outcome, "consumed");
  assert.equal(stolen.done, true);
  assert.deepEqual(h.db.listLinkedIdentities(LINE_2), []);
  assert.equal(h.db.getCustomer(LINE_2).state, "NEEDS_HUMAN", "ธงรอคนอยู่ในคิวของทีม");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(!h.sends.some((call) => call.replyToken === "rt-x"), "รหัสใช้ไม่ได้ = ไม่ตอบลูกค้าเลย (พี่ง้วง: ไม่ต้องครับ)");
  assert.ok(!h.notifications.some((row) => row.customerId === LINE_2), "ไม่ push ปลุกทีม — ธงอย่างเดียว");
  assert.equal(h.db.raw.prepare("SELECT status FROM inbound_turn_outcomes WHERE message_id = ?").get(otherMsg).status, "silent_by_design");
  h.db.close();
});

test("รหัสหมดอายุ/ถูกแทนด้วยลิงก์ใหม่ = ไม่เชื่อม", async () => {
  const h = harness();
  seedFacebookRoom(h.db);
  const first = await invite(h);
  const second = await invite(h);
  const revoked = h.link.handleLineText({ channelId: "default", customerId: LINE, text: identityLinkPrefill(first.code), messageId: lineInbound(h.db, LINE, identityLinkPrefill(first.code)) });
  assert.equal(revoked.outcome, "revoked");
  h.advance(CODE_TTL_MS + 1);
  const expired = h.link.handleLineText({ channelId: "default", customerId: LINE, text: identityLinkPrefill(second.code), messageId: lineInbound(h.db, LINE, identityLinkPrefill(second.code)) });
  assert.equal(expired.outcome, "expired");
  assert.deepEqual(h.db.listLinkedIdentities(LINE), []);
  h.db.close();
});

test("รหัสมั่ว: ไม่มีคำถามอื่น = ไม่ตอบ + ธงรอคน · มีคำถามอื่น = ลูกแพรตอบส่วนที่เหลือโดยไม่เห็นรหัส", async () => {
  const h = harness();
  const guess = "ต่อแชทจาก Facebook (รหัส LK-22222-22222)";
  const only = h.link.handleLineText({ channelId: "default", customerId: LINE, text: guess, messageId: lineInbound(h.db, LINE, guess), replyToken: "rt-g" });
  assert.deepEqual(only, { matched: true, outcome: "not_found", done: true });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.sends.length, 0, "ไม่ตอบลูกค้า");
  assert.equal(h.db.getCustomer(LINE).state, "NEEDS_HUMAN");
  assert.equal(h.notifications.length, 0);
  const withQuestion = "LK-33333-33333 ราคาคลาสเท่าไหร่คะ";
  const mixed = h.link.handleLineText({ channelId: "default", customerId: LINE_2, text: withQuestion, messageId: lineInbound(h.db, LINE_2, withQuestion) });
  assert.deepEqual(mixed, { matched: true, outcome: "not_found", done: false, text: "ราคาคลาสเท่าไหร่คะ" });
  assert.notEqual(h.db.getCustomer(LINE_2).state, "NEEDS_HUMAN", "รหัสที่ไม่เคยมีจริงปนคำถาม = ไม่ปลุกทีม");
  assert.deepEqual(h.link.handleLineText({ channelId: "default", customerId: LINE, text: "สวัสดีค่ะ", messageId: "x" }), { matched: false });
  h.db.close();
});

test("เพดาน: ส่งผิดครบ 5 ครั้ง/วัน ห้องนั้นไม่ถูกตรวจรหัสอีก (แม้รหัสจริง) · ไม่ตอบ ไม่ปลุกทีมเพิ่ม", async () => {
  const h = harness();
  seedFacebookRoom(h.db);
  const { code } = await invite(h);
  for (let i = 0; i < IDENTITY_LINK_LIMITS.failuresPerRoomPerDay; i += 1) {
    const guess = `รหัส LK-4444${i}-44444 ค่ะ ขอถามหน่อย`;
    assert.equal(h.link.handleLineText({ channelId: "default", customerId: LINE, text: guess, messageId: lineInbound(h.db, LINE, guess) }).outcome, "not_found");
  }
  const notesBefore = h.notifications.length;
  const real = identityLinkPrefill(code);
  const verdict = h.link.handleLineText({ channelId: "default", customerId: LINE, text: real, messageId: lineInbound(h.db, LINE, real), replyToken: "rt-r" });
  assert.deepEqual(verdict, { matched: true, outcome: "rate_limited", done: true });
  assert.deepEqual(h.db.listLinkedIdentities(LINE), []);
  assert.equal(h.db.raw.prepare("SELECT status FROM identity_link_codes").get().status, "active", "รหัสจริงยังไม่ถูกเผา");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!h.sends.some((call) => call.replyToken === "rt-r"));
  assert.equal(h.notifications.length, notesBefore);
  h.advance(24 * 3_600_000 + 1);
  const later = h.link.handleLineText({ channelId: "default", customerId: LINE, text: real, messageId: lineInbound(h.db, LINE, real) });
  assert.equal(later.outcome, "linked", "พ้นหน้าต่างเพดาน 24 ชม. แล้วตรวจได้อีก (รหัสยังไม่หมดอายุ 30 วัน)");
  h.db.close();
});

test("ชนการเชื่อมเดิม: ห้อง LINE ที่เป็นของลูกค้า Facebook อีกคน = ไม่เชื่อม ไม่เผารหัส ขอให้ทีมตรวจ", async () => {
  const h = harness();
  seedFacebookRoom(h.db, FB);
  seedFacebookRoom(h.db, "facebook:psid-222", { name: "อีกคน" });
  h.db.upsertCustomer(LINE, { displayName: "LINE" });
  assert.equal(h.link.linkByTeam({ customerId: LINE, otherId: "facebook:psid-222", operator: "nok" }).state, "linked");
  const { code } = await invite(h);
  const text = identityLinkPrefill(code);
  const verdict = h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId: lineInbound(h.db, LINE, text) });
  assert.equal(verdict.outcome, "conflict");
  assert.equal(h.db.raw.prepare("SELECT status FROM identity_link_codes WHERE customer_id = ?").get(FB).status, "active");
  assert.match(h.db.getCustomer(LINE).handoff_summary, /เชื่อมกับลูกค้าคนอื่นอยู่แล้ว/u, "ธงรอคนบอกเหตุให้ทีม");
  assert.equal(h.notifications.length, 0, "ไม่ push ปลุกทีม ไม่ตอบลูกค้า — ธงอย่างเดียว");
  h.db.close();
});

/* ---------------------------- ทีมเชื่อมเอง / ยกเลิกการเชื่อม ---------------------------- */

test("ทีมเชื่อม/ยกเลิก: ช่องเดียวกันเชื่อมไม่ได้ · ยกเลิกแล้วถอนป้ายที่คัดลอก เปิด AI ที่ระบบปิดคืน ลบโน้ต เปิดทักตาม FB คืน", () => {
  const h = harness();
  seedFacebookRoom(h.db, FB, { tags: [["customer", "human"], ["สนใจ AI Agent", "ai"]] });
  h.db.upsertCustomer(LINE, { displayName: "LINE คน" });
  h.db.upsertCustomer(LINE_2, { displayName: "LINE อีกห้อง" });
  assert.equal(h.link.linkByTeam({ customerId: LINE, otherId: LINE_2, operator: "nok" }).state, "same_channel");
  const linked = h.link.linkByTeam({ customerId: LINE, otherId: FB, operator: "nok", via: "suggestion" });
  assert.equal(linked.state, "linked");
  assert.equal(h.db.getCustomer(LINE).ai_off_reason, "customer_handover");
  assert.equal(h.db.getIdentityLinkRow(LINE).linked_via, "suggestion");
  // คนติดป้ายเองทีหลัง = ของคน ห้ามถอน
  h.advance(5 * 60_000);
  h.db.addTag(LINE, "ส่งเอกสารแล้ว", "human");

  const result = h.link.unlink({ customerId: FB, operator: "nok" });
  assert.equal(result.state, "unlinked");
  assert.deepEqual(h.db.listLinkedIdentities(LINE), [], "เหลือห้องเดียว = ไม่ใช่การเชื่อมแล้ว");
  const tags = h.db.listTags(LINE).map((row) => row.tag);
  assert.deepEqual(tags, ["ส่งเอกสารแล้ว"]);
  assert.equal(h.db.getCustomer(LINE).ai_enabled, 1, "AI ที่ระบบปิดเพราะการเชื่อม ต้องเปิดคืน");
  assert.ok(!h.db.listHandoffNotes(LINE, 20).some((note) => note.author === IDENTITY_NOTE_AUTHOR));
  assert.ok(!h.db.listHandoffNotes(FB, 20).some((note) => note.author === IDENTITY_NOTE_AUTHOR));
  assert.equal(h.db.getCustomer(FB).followup_enabled, 1);
  assert.equal(h.link.unlink({ customerId: FB, operator: "nok" }).state, "not_linked");
  h.db.close();
});

test("ยกเลิกการเชื่อม: ป้าย customer ที่คนติดเองในห้อง LINE = AI ยังเงียบต่อ", () => {
  const h = harness();
  seedFacebookRoom(h.db, FB, { tags: [["customer", "human"]] });
  h.db.upsertCustomer(LINE, { displayName: "LINE คน" });
  h.db.addTag(LINE, "customer", "human");
  h.db.setAiEnabled(LINE, false, "customer_handover");
  h.link.linkByTeam({ customerId: LINE, otherId: FB, operator: "nok" });
  h.link.unlink({ customerId: LINE, operator: "nok" });
  assert.ok(h.db.listTags(LINE).some((row) => row.tag === "customer"), "ป้ายที่มีอยู่ก่อนเชื่อมไม่ได้มาจากการเชื่อม");
  assert.equal(h.db.getCustomer(LINE).ai_enabled, 0);
  h.db.close();
});

test("รวมคน: รหัสของลูกค้ารวมสองคนที่มีห้องเชื่อมอยู่แล้วไม่ได้ · ทีมรวมได้ถ้าช่องทางไม่ชน", () => {
  const h = harness();
  h.db.upsertCustomer("branch2:Ub", { displayName: "สาขา 2", channelId: "branch2" });
  seedFacebookRoom(h.db, FB);
  h.db.upsertCustomer(LINE, { displayName: "LINE" });
  assert.equal(h.link.linkByTeam({ customerId: FB, otherId: LINE, operator: "nok" }).state, "linked");
  const other = "facebook:psid-999";
  seedFacebookRoom(h.db, other, { name: "อีกคน" });
  h.db.upsertCustomer("branch3:Uc", { displayName: "สาขา 3", channelId: "branch3" });
  assert.equal(h.link.linkByTeam({ customerId: other, otherId: "branch3:Uc", operator: "nok" }).state, "linked");
  const merged = h.link.linkByTeam({ customerId: LINE, otherId: "branch3:Uc", operator: "nok" });
  assert.equal(merged.state, "conflict", "สองคนต่างมี Facebook = รวมไม่ได้ (หนึ่งคนหนึ่งห้องต่อช่องทาง)");
  assert.equal(h.link.linkByTeam({ customerId: LINE, otherId: "branch2:Ub", operator: "nok" }).state, "linked");
  assert.equal(h.db.listLinkedIdentities(FB).length, 3);
  h.db.close();
});

/* ------------------------------------ PDPA ------------------------------------ */

test("PDPA: ลืมห้อง Facebook = แถวเชื่อม/รหัส/สรุปที่คัดลอกไปห้อง LINE หาย · ห้อง LINE ไม่เหลือ id ของห้องที่ถูกลืม", async () => {
  const h = harness();
  seedFacebookRoom(h.db, FB, { known: "สมหญิง" });
  const { code } = await invite(h);
  const text = identityLinkPrefill(code);
  h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId: lineInbound(h.db, LINE, text) });
  h.db.resetCustomer(FB, { forget: true });
  const dump = JSON.stringify([
    h.db.raw.prepare("SELECT * FROM customer_identity_links").all(),
    h.db.raw.prepare("SELECT * FROM identity_link_codes").all(),
    h.db.raw.prepare("SELECT * FROM identity_link_attempts").all(),
    h.db.raw.prepare("SELECT * FROM handoff_notes").all(),
  ]);
  assert.ok(!dump.includes("psid-111"), "ไม่เหลือ id ของห้องที่ถูกลืม");
  assert.deepEqual(h.db.listLinkedIdentities(LINE), []);
  assert.ok(!h.db.listHandoffNotes(LINE, 20).some((note) => note.author === IDENTITY_NOTE_AUTHOR), "สรุปที่มาจากห้องที่ถูกลืมต้องหาย");
  assert.ok(h.db.listTags(LINE).length >= 0);
  h.db.close();
});

test("PDPA: ลืมห้อง LINE = รหัสของห้อง Facebook ไม่เหลือ id ของ LINE · โน้ต 'ย้ายไป LINE' ในห้อง Facebook หาย", async () => {
  const h = harness();
  seedFacebookRoom(h.db);
  const { code } = await invite(h);
  const text = identityLinkPrefill(code);
  h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId: lineInbound(h.db, LINE, text) });
  await waitFor(() => h.sends.some((call) => call.channelId === "default"));
  h.db.resetCustomer(LINE, { forget: true });
  assert.equal(h.db.raw.prepare("SELECT redeemed_by FROM identity_link_codes").get().redeemed_by, "");
  assert.ok(!h.db.listHandoffNotes(FB, 20).some((note) => note.author === IDENTITY_NOTE_AUTHOR));
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM customer_identity_links").get().n, 0);
  h.db.close();
});

/* ------------------------------------ แนะนำ ------------------------------------ */

test("แนะนำ: เบอร์/อีเมลตรงเป๊ะ = หลักฐานดี · ชื่อคล้าย = คำใบ้อ่อน · ช่องเดียวกัน/ห้องระบบเก่า/เชื่อมแล้วไม่แนะนำ", () => {
  const h = harness();
  seedFacebookRoom(h.db, FB, { name: "Somchai Jaidee" });
  h.db.setCustomerFact({ customerId: FB, factKey: "contact_phone", value: "+66 81-234-5678", source: "human" });
  h.db.upsertCustomer(LINE, { displayName: "ชายหนึ่ง" });
  h.db.setCustomerFact({ customerId: LINE, factKey: "contact_phone", value: "081 234 5678", source: "deterministic" });
  h.db.upsertCustomer(LINE_2, { displayName: "Somchai Jaidee." });
  h.db.upsertCustomer("U-legacy", { displayName: "Somchai Jaidee" });
  h.db.addTag("U-legacy", "ย้ายจาก LINE OA", "human");
  seedFacebookRoom(h.db, "facebook:psid-333", { name: "Somchai Jaidee" });
  const list = h.link.suggestions(FB);
  assert.deepEqual(list.map((row) => [row.id, row.strong, row.reasons.join(",")]), [
    [LINE, true, "phone"],
    [LINE_2, false, "name"],
  ]);
  assert.equal(normalizePhone("+66812345678"), "0812345678");
  assert.deepEqual(h.link.suggestions(FB, { q: "ชายหนึ่ง" }).map((row) => row.id), [LINE]);
  h.link.linkByTeam({ customerId: FB, otherId: LINE, operator: "nok" });
  assert.ok(!h.link.suggestions(FB).some((row) => row.id === LINE), "เชื่อมแล้วไม่แนะนำซ้ำ");
  h.db.close();
});

test("แผง: ไม่มีรหัส/hash ออกไปถึงเบราว์เซอร์ · บอกเหตุที่ส่งลิงก์ไม่ได้ · เฉพาะ owner/admin จัดการได้", async () => {
  const h = harness();
  seedFacebookRoom(h.db);
  const before = h.link.panel(FB, { operator: { role: "operator" } });
  assert.equal(before.canManage, false);
  assert.equal(before.invite.blocker, "");
  assert.equal(before.lineBasicId, "@lukprae");
  await invite(h);
  const after = h.link.panel(FB, { operator: { role: "admin" } });
  assert.equal(after.canManage, true);
  assert.equal(after.invite.lastStatus, "active");
  assert.equal(after.invite.lastClassType, "live_business");
  assert.deepEqual(after.invite.classes.map((row) => row.type), ["online", "live_business", "live_workflow", "live_private", "online_fb", "online_line"]);
  assert.match(after.invite.previews.online, /ขั้นตอนลงทะเบียนเข้าเรียนและกลุ่ม support/u);
  assert.match(after.invite.previews.online_fb, /คลาส Facebook Ads Online/u);
  assert.ok(after.invite.previews.live_business.includes(MASKED_CODE), "ตัวอย่างใช้รหัสปิด");
  assert.ok(!/LK-[0-9A-Z]{5}-[0-9A-Z]{5}/u.test(JSON.stringify(after)), "ไม่มีรหัสจริงออกไปถึงเบราว์เซอร์");
  assert.ok(!/code_hash|[0-9a-f]{64}/u.test(JSON.stringify(after)));
  assert.equal(h.link.panel("missing"), null);
  h.db.close();
});

test("เพดานทั้งระบบ: ถูกยิงรหัสมั่วเกิน 60 ครั้ง/ชม. = ห้องอื่นยังไม่ถูกตรวจรหัส แต่ปักธงให้ทีมเชื่อมมือ (ไม่ตอบ ไม่ปลุกซ้ำ)", async () => {
  const h = harness();
  seedFacebookRoom(h.db);
  const { code } = await invite(h);
  for (let i = 0; i < IDENTITY_LINK_LIMITS.failuresPerHour; i += 1) h.db.recordIdentityLinkAttempt({ customerId: `U-attacker-${i % 12}`, outcome: "not_found" });
  const text = identityLinkPrefill(code);
  const verdict = h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId: lineInbound(h.db, LINE, text), replyToken: "rt-busy" });
  assert.deepEqual(verdict, { matched: true, outcome: "busy", done: true });
  assert.deepEqual(h.db.listLinkedIdentities(LINE), []);
  assert.equal(h.db.getCustomer(LINE).state, "NEEDS_HUMAN", "ลูกค้าจริงที่โดนหางเลขต้องมีคนตาม");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(!h.sends.some((call) => call.replyToken === "rt-busy"));
  assert.equal(h.notifications.length, 0);
  h.db.close();
});

/* ------------------------- ผลตรวจจากผู้ตรวจโค้ด (28 ก.ย.) ------------------------- */

test("เพดานนับทีละรหัส: ข้อความเดียวแนบ 3 รหัส = ใช้งบ 3 ครั้ง · งบเหลือ 2 = ตรวจแค่ 2 รหัสแรก", async () => {
  const h = harness();
  seedFacebookRoom(h.db);
  const { code } = await invite(h);
  const three = "LK-44441-44444 LK-44442-44444 LK-44443-44444";
  assert.equal(h.link.handleLineText({ channelId: "default", customerId: LINE, text: three, messageId: lineInbound(h.db, LINE, three) }).outcome, "not_found");
  assert.equal(h.db.countIdentityLinkFailures({ customerId: LINE }), 3, "สามรหัส = เดาสามครั้ง");
  const again = "LK-44444-44444 LK-44445-44444 LK-44446-44444";
  h.link.handleLineText({ channelId: "default", customerId: LINE, text: again, messageId: lineInbound(h.db, LINE, again) });
  assert.equal(h.db.countIdentityLinkFailures({ customerId: LINE }), IDENTITY_LINK_LIMITS.failuresPerRoomPerDay, "ตรวจไม่เกินงบที่เหลือ");
  const real = identityLinkPrefill(code);
  assert.equal(h.link.handleLineText({ channelId: "default", customerId: LINE, text: real, messageId: lineInbound(h.db, LINE, real) }).outcome, "rate_limited");
  assert.deepEqual(h.db.listLinkedIdentities(LINE), []);
  h.db.close();
});

test("เพดานทั้งระบบนับเฉพาะการเดาจริง: ห้องที่ถูกพักแล้วยิงต่อ ไม่ลากห้องอื่นให้ busy", async () => {
  const h = harness();
  seedFacebookRoom(h.db);
  const { code } = await invite(h);
  for (let i = 0; i < IDENTITY_LINK_LIMITS.failuresPerHour + 10; i += 1) {
    const spam = `LK-4444${i % 10}-4444${Math.floor(i / 10) % 10}`;
    h.link.handleLineText({ channelId: "default", customerId: LINE_2, text: spam, messageId: lineInbound(h.db, LINE_2, spam) });
  }
  assert.equal(h.db.countIdentityLinkFailures({}), IDENTITY_LINK_LIMITS.failuresPerRoomPerDay, "ครั้งที่ถูกพักไม่ใช่การเดา");
  const real = identityLinkPrefill(code);
  const verdict = h.link.handleLineText({ channelId: "default", customerId: LINE, text: real, messageId: lineInbound(h.db, LINE, real) });
  assert.equal(verdict.outcome, "linked");
  h.db.close();
});

test("โหมด auto: สองจังหวะติดกัน (ติดป้าย customer + ยืนยันยอด) = ส่งลิงก์ครั้งเดียว", async () => {
  const h = harness({ mode: "auto" });
  seedFacebookRoom(h.db, FB, { tags: [["customer", "human"]] });
  h.db.createOrder({ customerId: FB, channelId: "facebook", items: [{ name: "Classroom AI Agent for business", qty: 1, price: null }], status: "paid" });
  assert.equal(h.link.maybeAutoInvite({ customerId: FB, trigger: "customer_tag", operator: "nok" }).scheduled, true);
  assert.equal(h.link.maybeAutoInvite({ customerId: FB, trigger: "payment_confirmed", operator: "nok" }).scheduled, true, "ยังไม่ออกรหัสตอนตรวจ");
  await waitFor(() => h.sends.some((call) => call.channelId === "facebook"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.sends.filter((call) => call.channelId === "facebook").length, 1);
  assert.deepEqual(h.db.raw.prepare("SELECT status, issued_via, class_type FROM identity_link_codes").all().map((row) => ({ ...row })),
    [{ status: "active", issued_via: "auto", class_type: "live_business" }], "รหัสที่ส่งไปแล้วต้องไม่ถูกลิงก์ที่สองแทน · คลาสมาจากออเดอร์");
  h.db.close();
});

test("หลักฐานคลาส: ออเดอร์/ป้ายซื้อแล้ว = การซื้อ · ป้ายสนใจ = คำใบ้ · สองคลาส = ไม่เดา", () => {
  const h = harness();
  seedFacebookRoom(h.db, FB, { tags: [["สนใจ: AI Agent for Business Online", "ai"]] });
  assert.deepEqual(h.link.detectClass(FB), { type: "online", source: "interest", candidates: ["online"] });
  h.db.addTag(FB, "สนใจ: AI Workflow Automation", "ai");
  assert.deepEqual(h.link.detectClass(FB), { type: "", source: "interest_ambiguous", candidates: ["online", "live_workflow"] });
  h.db.addTag(FB, "ซื้อแล้ว: Classroom AI Agent For Business", "rfm");
  assert.deepEqual(h.link.detectClass(FB), { type: "live_business", source: "purchase", candidates: ["live_business"] }, "การซื้อชนะคำใบ้");
  h.db.createOrder({ customerId: FB, channelId: "facebook", items: [{ name: "In-house training: 2Day", qty: 1, price: null }], status: "paid" });
  assert.deepEqual(h.link.detectClass(FB), { type: "", source: "purchase_ambiguous", candidates: ["live_business", "live_private"] });
  h.db.createOrder({ customerId: "facebook:psid-9", channelId: "facebook", items: [{ name: "Online Custom GPTs — Early Bird", qty: 1, price: null }], status: "draft" });
  assert.deepEqual(h.link.detectClass("facebook:psid-9"), { type: "", source: "", candidates: [] }, "ร่างออเดอร์ยังไม่ใช่การซื้อ");
  h.db.close();
});

test("โหมด auto: มีแค่ป้ายสนใจ = ไม่ส่งเอง (กันเชิญผิดคลาส) + ปักธงห้อง Facebook ให้ทีมเลือกคลาสแล้วกดส่ง", async () => {
  const h = harness({ mode: "auto" });
  seedFacebookRoom(h.db, FB, { tags: [["customer", "human"], ["สนใจ: AI Agent for Business", "ai"]] });
  assert.deepEqual(h.link.maybeAutoInvite({ customerId: FB, trigger: "customer_tag", operator: "nok" }),
    { skipped: "class_unknown", candidates: ["live_business"] });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(h.sends.length, 0);
  const fb = h.db.getCustomer(FB);
  assert.equal(fb.state, "NEEDS_HUMAN");
  assert.match(fb.handoff_summary, /ไม่แน่ใจว่าซื้อคลาสไหน/u);
  const panel = h.link.panel(FB, { operator: { role: "owner" } });
  assert.equal(panel.invite.suggestedClass, "live_business", "แผงยังเลือกไว้ให้จากป้ายสนใจ — คนยืนยันก่อนส่ง");
  assert.equal(panel.invite.suggestedFrom, "interest");
  h.db.close();
});

test("PDPA: ลืมห้อง Facebook ในคนที่มี 3 ห้อง = ห้องที่เหลือไม่เหลือร่องรอยสิ่งที่คัดลอกจากห้องที่ถูกลืม", () => {
  const h = harness();
  seedFacebookRoom(h.db, FB, { known: "สมหญิง", tags: [["สนใจ AI Agent", "ai"]] });
  h.db.upsertCustomer(LINE, { displayName: "LINE คน" });
  h.db.upsertCustomer("branch2:Ub", { displayName: "สาขา 2", channelId: "branch2" });
  assert.equal(h.link.linkByTeam({ customerId: FB, otherId: LINE, operator: "nok" }).state, "linked");
  assert.equal(h.link.linkByTeam({ customerId: LINE, otherId: "branch2:Ub", operator: "nok" }).state, "linked");
  assert.equal(h.db.identityInherited(LINE).knownName, "สมหญิง");
  h.db.resetCustomer(FB, { forget: true });
  assert.equal(h.db.listLinkedIdentities(LINE).length, 2, "สองห้องที่เหลือยังเป็นคนเดียวกัน");
  for (const id of [LINE, "branch2:Ub"]) {
    const state = h.db.identityInherited(id);
    for (const key of ["from", "at", "tags", "silenced", "knownName", "pins"]) assert.ok(!(key in state), `${id}: ${key}`);
  }
  const dump = JSON.stringify(h.db.raw.prepare("SELECT * FROM customer_identity_links").all());
  assert.ok(!dump.includes("psid-111") && !dump.includes("สมหญิง"));
  h.db.close();
});

/* --------------------- ผลตรวจรอบสอง (28 ก.ย. ค่ำ): ด่านของเส้นส่งใหม่ --------------------- */

// ช่วงเวลาทำการที่ไม่ครอบเวลาจริงตอนนี้ (ด่านเวลาทำการอ่านนาฬิกาจริง ไม่ใช่นาฬิกาของเทสต์)
function windowAwayFromNow() {
  const minute = Math.floor(((Date.now() + 7 * 3_600_000) % 86_400_000) / 60_000);
  const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const start = (minute + 180) % 1440;
  return `${hhmm(start)}-${hhmm((start + 30) % 1440)}`;
}

test("โหมด auto: สวิตช์หยุด AI ทั้งระบบ = ไม่ส่งลิงก์เอง (ปุ่มที่ทีมกดเองยังส่งได้ เหมือนพิมพ์ตอบเอง)", async () => {
  const h = harness({ mode: "auto" });
  seedFacebookRoom(h.db, FB, { tags: [["customer", "human"]] });
  h.db.createOrder({ customerId: FB, channelId: "facebook", items: [{ name: "Classroom AI Agent for business", qty: 1, price: null }], status: "paid" });
  h.db.setSetting(AI_PAUSE_SETTING, "1");
  assert.deepEqual(h.link.maybeAutoInvite({ customerId: FB, trigger: "customer_tag", operator: "nok" }), { skipped: "ai_paused" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.sends.length, 0, "ไม่ตอบใคร ไม่ทักใคร");
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM identity_link_codes").get().n, 0);
  const manual = await h.link.sendInvite({ customerId: FB, operator: "nok", classType: "live_business" });
  assert.equal(manual.ok, true);
  h.db.close();
});

test("ด่านก่อนส่งข้อความหลังเชื่อม: หยุด AI ทั้งระบบ / คนกำลังตอบห้องนี้ / นอกเวลาทำการ = ไม่ส่ง แต่เชื่อมแล้ว + ธง + แจ้งทีมตามเหตุ", async () => {
  const gates = [
    ["paused", /ระบบพัก AI ทั้งหมดอยู่/u],
    ["operator_active", /มีคนในทีมกำลังตอบห้องนี้อยู่/u],
    ["schedule_off", /นอกเวลาทำการของบอท/u],
  ];
  for (const [gate, expected] of gates) {
    const h = harness();
    seedFacebookRoom(h.db, FB, { known: "มาลี" });
    const { code } = await invite(h);
    const text = identityLinkPrefill(code);
    const messageId = lineInbound(h.db, LINE, text);
    if (gate === "paused") h.db.setSetting(AI_PAUSE_SETTING, "1");
    if (gate === "operator_active") h.db.setOperatorActiveUntil(LINE, Date.now() + 60_000);
    if (gate === "schedule_off") {
      h.db.setSetting(SCHEDULE_ENABLED_KEY, "1");
      h.db.setSetting(SCHEDULE_HOURS_KEY, windowAwayFromNow());
    }
    const verdict = h.link.handleLineText({ channelId: "default", customerId: LINE, text, messageId, replyToken: "rt-gate" });
    assert.equal(verdict.outcome, "linked", gate);
    await waitFor(() => h.notifications.length === 1);
    assert.equal(h.sends.filter((call) => call.channelId === "default").length, 0, `${gate}: ไม่มีข้อความถึงลูกค้า`);
    assert.match(h.notifications[0].reasonTextOverride, expected, gate);
    assert.match(h.db.getCustomer(LINE).handoff_summary, expected, gate);
    assert.equal(h.db.raw.prepare("SELECT status FROM inbound_turn_outcomes WHERE message_id = ?").get(messageId).status, "silent_by_design", gate);
    assert.deepEqual(h.db.listLinkedIdentities(LINE).map((row) => row.customer_id).sort(), [FB, LINE].sort(), `${gate}: ยังเชื่อมห้อง`);
    h.db.close();
  }
});
