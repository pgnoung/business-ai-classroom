// opportunity-handoff-reply — บั๊กจริง 3 ก.ย. 2026: หลังส่งต่องาน project ห้องถูกปิด AI
// แบบ sticky (handoff_private_inhouse) และ scorer ไม่รันอีกเลย ลูกค้าที่ตอบต่อ — ซึ่งบ่อย
// ที่สุดคือ "เบอร์" ที่บอทเพิ่งขอไปในข้อความเดียวกับที่ระบบปิด — จึงถูกบันทึกเงียบ ๆ
// ไม่มีใครรู้จนกว่าจะมีคนเปิดคิว NEEDS_HUMAN เอง
//
// กติกาที่ไฟล์นี้ล็อกไว้: ข้อความแรกหลังส่งต่อ = ปลุกทีมงานหนึ่งครั้ง (พร้อมเบอร์ถ้ามี)
// ข้อความถัด ๆ ไป = เงียบ (รบกวนซ้ำคือทีมงานเลิกอ่าน ซึ่งอันตรายกว่าไม่แจ้ง)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { HANDOFF_AI_OFF_REASON } from "../src/pipeline.mjs";
import { NOTIFY_KEY_PREFIX, NOTIFY_REASON_TEXT } from "../src/notify.mjs";
import { validateSalesPolicy } from "../src/salesPolicy.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, waitFor,
} from "./helpers.mjs";

// กติกาจริงของพี่ง้วง 1 ก.ย. 2026: ได้ช่องทางตามตัวช่องแรกก็ส่งต่อได้
const PROJECT_POLICY = validateSalesPolicy({
  schemaVersion: 1,
  businessId: "pngoung-tidkradum",
  customerJourneys: ["new_lead"],
  decisionRoles: ["owner"],
  courses: [{ id: "ai-agent-business", type: "group_live", name: "AI Agent for Business", aliases: ["AI Basic"] }],
  opportunities: [{
    type: "in_house_training",
    requiredSlots: ["business_need", "company_name", "contact_phone", "preferred_contact_time"],
    handoffSlots: [],
    handoffAnyOf: ["company_name", "contact_phone", "preferred_contact_time"],
    optionalSlots: [],
    upsize: true,
    handoffOnComplete: true,
  }],
});
const HANDOFF_INBOUND = "อยากให้ไปสอนที่บริษัท ทดสอบดี จำกัด ครับ";
const SCORER_READY = JSON.stringify({ score: 6, trend: "up", opportunity: null });

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const TEAM_ID = "U00000000000000000000000000000a01";
const HANDOFF_TICKET = (customerId) => `opportunity_handoff:${customerId}:__reply`;

function makeApp() {
  const config = testConfig();
  const db = memoryDb();
  db.setSetting(`${NOTIFY_KEY_PREFIX}default`, JSON.stringify([TEAM_ID]));
  const lineFetch = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch, sleep: async () => {} },
    logger: silent,
  });
  return { app, db, lineFetch };
}

// push แจ้งทีม = ข้อความที่ยิงไปหา LINE id ของทีมงาน (ไม่ใช่ห้องลูกค้า)
const teamPushes = (lineFetch) => lineFetch.sends
  .filter((call) => call.body?.to === TEAM_ID)
  .map((call) => call.body.messages.map((m) => m.text).join("\n"));

// จำลองห้องที่ผ่านการส่งต่องาน project มาแล้ว (ไม่ต้องพึ่ง scorer จริง)
function handedOffRoom(db, customerId) {
  db.upsertCustomer(customerId, {});
  db.setNeedsHuman(customerId, "opportunity_handoff", "ข้อมูล in_house_training ครบตาม policy");
  db.setAiEnabled(customerId, false, HANDOFF_AI_OFF_REASON);
  db.setSetting(HANDOFF_TICKET(customerId), JSON.stringify({ createdAt: Date.now(), notified: false }));
}

test("หลังส่งต่อ: ข้อความแรกของลูกค้าปลุกทีมงานหนึ่งครั้ง — ข้อความที่สองต้องเงียบ", async () => {
  const { app, db, lineFetch } = makeApp();
  handedOffRoom(db, "U-after-handoff");

  const first = await app.pipeline.handleInboundText({
    customerId: "U-after-handoff", text: "สะดวกช่วงบ่ายวันธรรมดาค่ะ", replyToken: "",
  });
  assert.equal(first.suppressed, "ai_disabled", "AI ยังต้องเงียบกับลูกค้าตามคำสั่ง");
  await waitFor(() => (teamPushes(lineFetch).length ? true : null));
  const pushes = teamPushes(lineFetch);
  assert.equal(pushes.length, 1, "ต้องปลุกทีมงานทันทีที่ลูกค้าตอบ");
  assert.match(pushes[0], /ตอบกลับมาหลังส่งต่อ/u);
  assert.ok(
    db.listAudit(50).some((row) => row.action === "opportunity_handoff_reply" && row.target === "U-after-handoff"),
    "ต้องมี audit ให้ตามย้อนได้ว่าใครถูกปลุกเพราะอะไร",
  );

  const second = await app.pipeline.handleInboundText({
    customerId: "U-after-handoff", text: "รบกวนติดต่อกลับด้วยนะคะ", replyToken: "",
  });
  assert.equal(second.suppressed, "ai_disabled");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(teamPushes(lineFetch).length, 1, "ข้อความถัดไปห้ามรบกวนซ้ำ — หนึ่งครั้งต่อหนึ่งการส่งต่อ");
  db.close();
});

// ผู้ตรวจ (a) 3 ก.ย.: ลูกค้าไทยพิมพ์รับคำก่อนแล้วค่อยส่งเบอร์ตามเป็นข้อความที่สองบ่อยมาก
// ถ้าตั๋วปลุกถูกใช้ไปกับ "ค่ะ" เบอร์จะไม่มีวันถึงทีมงาน = บั๊กเดิมย้ายที่เฉย ๆ
test("หลังส่งต่อ: 'ค่ะ' ก่อน แล้วเบอร์ตามมา — ต้องปลุกอีกครั้งพร้อมเบอร์", async () => {
  const { app, db, lineFetch } = makeApp();
  handedOffRoom(db, "U-ack-then-phone");

  await app.pipeline.handleInboundText({ customerId: "U-ack-then-phone", text: "ค่ะ", replyToken: "" });
  await waitFor(() => (teamPushes(lineFetch).length ? true : null));
  assert.equal(teamPushes(lineFetch).length, 1);
  assert.doesNotMatch(teamPushes(lineFetch)[0], /08\d{8}/u, "ข้อความแรกยังไม่มีเบอร์");

  await app.pipeline.handleInboundText({ customerId: "U-ack-then-phone", text: "0812345678", replyToken: "" });
  await waitFor(() => (teamPushes(lineFetch).length >= 2 ? true : null));
  const pushes = teamPushes(lineFetch);
  assert.equal(pushes.length, 2, "เบอร์โผล่ครั้งแรก = ปลุกได้อีกหนึ่งครั้ง");
  assert.match(pushes[1], /0812345678/u);

  // แต่ต้องหยุดแค่นั้น — ข้อความถัดไป (มีเบอร์เดิมหรือไม่ก็ตาม) ห้ามปลุกอีก
  await app.pipeline.handleInboundText({ customerId: "U-ack-then-phone", text: "0812345678 นะคะ", replyToken: "" });
  await app.pipeline.handleInboundText({ customerId: "U-ack-then-phone", text: "ยังอยู่ไหมคะ", replyToken: "" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(teamPushes(lineFetch).length, 2, "เพดานคือสองครั้งต่อหนึ่งการส่งต่อ");
  db.close();
});

// (a) การอ่านและบันทึกต้องไม่ผูกกับโควตา push — เบอร์ที่มาทีหลังก็ต้องเข้าบันทึกส่งต่อ
test("หลังส่งต่อ: ตั๋ว push หมดแล้ว แต่เบอร์ใหม่ยังต้องเข้าบันทึกส่งต่อเสมอ", async () => {
  const { app, db, lineFetch } = makeApp();
  handedOffRoom(db, "U-note-always");

  await app.pipeline.handleInboundText({ customerId: "U-note-always", text: "0811111111", replyToken: "" });
  await waitFor(() => (teamPushes(lineFetch).length ? true : null));
  await app.pipeline.handleInboundText({ customerId: "U-note-always", text: "ขอเปลี่ยนเป็น 0822222222 ค่ะ", replyToken: "" });
  await new Promise((resolve) => setTimeout(resolve, 30));

  const notes = db.listHandoffNotes("U-note-always", 20).map((note) => note.text).join("\n");
  assert.match(notes, /0811111111/u, "เบอร์แรกต้องอยู่ในบันทึก");
  assert.match(notes, /0822222222/u, "เบอร์ที่แก้ทีหลังต้องอยู่ในบันทึกด้วย แม้ push จะหมดโควตาแล้ว");
  assert.equal(teamPushes(lineFetch).length, 1, "แต่ห้ามปลุกซ้ำเพราะเบอร์เปลี่ยน");
  db.close();
});

test("หลังส่งต่อ: ลูกค้าพิมพ์เบอร์มา — เบอร์ต้องอยู่ในข้อความแจ้งทีม ไม่ให้ไปขุดเองในห้องแชท", async () => {
  const { app, db, lineFetch } = makeApp();
  handedOffRoom(db, "U-phone-after");

  await app.pipeline.handleInboundText({
    customerId: "U-phone-after", text: "เบอร์ 0812345678 สะดวกช่วงบ่ายวันธรรมดาค่ะ", replyToken: "",
  });
  await waitFor(() => (teamPushes(lineFetch).length ? true : null));
  assert.match(teamPushes(lineFetch)[0], /0812345678/u, "เบอร์ที่ค้างในทรานสคริปต์ต้องถึงทีมงาน");
  assert.ok(
    db.listHandoffNotes("U-phone-after", 10).some((note) => /หลังส่งต่อแล้ว: 0812345678/u.test(note.text)),
    "และต้องอยู่ในบันทึกส่งต่อ ไม่ใช่อยู่แต่ใน push ที่เลื่อนหายได้",
  );
  db.close();
});

test("หลังส่งต่อ: ห้องที่ส่งต่อไปก่อนมีตั๋ว (ของค้างบน production) ก็ต้องถูกปลุกหนึ่งครั้ง", async () => {
  const { app, db, lineFetch } = makeApp();
  db.upsertCustomer("U-legacy-handoff", {});
  db.setNeedsHuman("U-legacy-handoff", "opportunity_handoff", "ข้อมูลครบตาม policy");
  db.setAiEnabled("U-legacy-handoff", false, HANDOFF_AI_OFF_REASON);
  assert.equal(db.getSetting(HANDOFF_TICKET("U-legacy-handoff")), null, "ห้องเก่ายังไม่มีตั๋ว");

  await app.pipeline.handleInboundText({
    customerId: "U-legacy-handoff", text: "0891234567 ค่ะ", replyToken: "",
  });
  await waitFor(() => (teamPushes(lineFetch).length ? true : null));
  assert.equal(teamPushes(lineFetch).length, 1);

  await app.pipeline.handleInboundText({ customerId: "U-legacy-handoff", text: "ยังอยู่ไหมคะ", replyToken: "" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(teamPushes(lineFetch).length, 1, "ห้องเก่าก็ต้องปลุกครั้งเดียวเหมือนกัน");
  db.close();
});

// ผู้ตรวจ (d): เส้นเงินกับเรื่องร้องเรียนมีเจ้าของอยู่แล้ว ด่านนี้ต้องไม่แตะเลย
test("ห้องที่ AI ปิดด้วยเหตุอื่น (bank_sent / money_line / complaint) ห้ามถูกนับเป็นข้อความหลังส่งต่อ", async () => {
  const { app, db, lineFetch } = makeApp();
  for (const [customerId, reason] of [
    ["U-not-handoff-bank", "bank_sent"],
    ["U-not-handoff-money", "money_line"],
    ["U-not-handoff-complaint", "complaint"],
  ]) {
    db.upsertCustomer(customerId, {});
    db.setAiEnabled(customerId, false, reason);
    await app.pipeline.handleInboundText({ customerId, text: "ขอสอบถามเพิ่มค่ะ 0891234567", replyToken: "" });
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(teamPushes(lineFetch), [], "เหตุปิดคนละเรื่อง = ไม่ใช่หน้าที่ของด่านนี้");
  db.close();
});

// ผู้ตรวจ (b): ตั๋วเก่าที่ค้างอยู่ต้องไม่ยิงเมื่อห้องถูกปิดใหม่ด้วยเหตุอื่น
test("ตั๋วเก่าค้างอยู่ แต่ห้องถูกปิดใหม่ด้วยเหตุเงิน — ห้ามยิง (ผูกกับสถานะห้องตอนนี้)", async () => {
  const { app, db, lineFetch } = makeApp();
  handedOffRoom(db, "U-released-then-money");
  // คนจริงกดเปิด AI คืน แล้วภายหลังห้องถูกปิดด้วยเส้นเงิน — ตั๋วใบเก่ายังอยู่ในตาราง
  db.setAiEnabled("U-released-then-money", true, "");
  db.setAiEnabled("U-released-then-money", false, "money_line");
  assert.ok(db.getSetting(HANDOFF_TICKET("U-released-then-money")), "ตั๋วใบเก่ายังค้างอยู่จริง");

  await app.pipeline.handleInboundText({ customerId: "U-released-then-money", text: "0891234567 ค่ะ", replyToken: "" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(teamPushes(lineFetch), [], "เหตุปิดตอนนี้ไม่ใช่การส่งต่อ = ด่านนี้ต้องเงียบสนิท");
  db.close();
});

test("เหตุ opportunity_handoff_reply ต้องอยู่ในรายการเหตุที่แจ้งทีมได้ (ไม่งั้น notify ทิ้งเงียบ)", () => {
  assert.match(NOTIFY_REASON_TEXT.opportunity_handoff_reply, /AI ปิดอยู่/u);
});

/* ---- ผู้ตรวจ (c): ส่งต่อรอบสองหลังคนจริงปล่อยห้อง ต้องไม่ถูก fingerprint กลืน ----
 *
 * fingerprint มีไว้กัน "ส่งต่อซ้ำเรื่องเดิมทั้งที่ห้องยังปิดอยู่" เท่านั้น
 * ถ้าคนจริงกดเปิด AI คืนแล้วลีดเดิมกลับมาด้วยข้อมูลชุดเดิมเป๊ะ ห้องจะไม่ถูกปิดอีก
 * ทีมงานไม่ได้รับแจ้ง และตั๋วปลุกไม่ถูกติดอาวุธใหม่ = ลูกค้าเงียบซ้ำรอบสอง
 * ------------------------------------------------------------------------- */
test("ส่งต่อรอบสองหลังคนจริงเปิด AI คืน — ต้องปิดห้องใหม่ แจ้งทีม และติดอาวุธตั๋วปลุกใหม่", async () => {
  const db = memoryDb();
  db.setSetting(`${NOTIFY_KEY_PREFIX}default`, JSON.stringify([TEAM_ID]));
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig(), db,
    overrides: { salesPolicy: PROJECT_POLICY, hermesFetch: hermesFetchStub(SCORER_READY), lineFetch, sleep: async () => {} },
    logger: silent,
  });
  const userId = "U-second-handoff";
  db.upsertCustomer(userId, {});
  db.insertMessage({ customerId: userId, direction: "in", content: HANDOFF_INBOUND });

  await app.pipeline.scoreBurst(userId);
  assert.equal(db.getCustomer(userId).ai_enabled, 0, "รอบแรกต้องปิดห้อง");
  const firstHandoffs = db.listAudit(200).filter((r) => r.action === "opportunity_handoff" && r.target === userId).length;
  assert.equal(firstHandoffs, 1);

  // ยิงซ้ำทั้งที่ห้องยังปิดอยู่ = ต้องถูกกลืนตามเดิม (กันรบกวนทีมงาน)
  await app.pipeline.scoreBurst(userId);
  assert.equal(
    db.listAudit(200).filter((r) => r.action === "opportunity_handoff" && r.target === userId).length,
    1, "ห้องยังปิดอยู่ = ส่งต่อซ้ำต้องถูกกลืนเหมือนเดิม",
  );

  // คนจริงกดเปิด AI คืน แล้วลีดเดิมกลับมาด้วยข้อมูลชุดเดิมเป๊ะ
  db.setAiEnabled(userId, true, "");
  await app.pipeline.scoreBurst(userId);
  assert.equal(
    db.listAudit(200).filter((r) => r.action === "opportunity_handoff" && r.target === userId).length,
    2, "ปล่อยห้องแล้วลีดกลับมา = การส่งต่อครั้งใหม่ ห้ามถูก fingerprint กลืน",
  );
  assert.equal(db.getCustomer(userId).ai_enabled, 0, "ต้องปิดห้องใหม่จริง ๆ");

  // และตั๋วปลุกต้องถูกติดอาวุธใหม่ — ข้อความถัดไปของลูกค้าต้องถึงทีมงานอีกครั้ง
  const ticket = JSON.parse(db.getSetting(HANDOFF_TICKET(userId)));
  assert.equal(ticket.notified, false, "ตั๋วใบใหม่ต้องยังไม่ถูกใช้");
  assert.equal(ticket.phoneNotified, false);
  const before = teamPushes(lineFetch).length;
  await app.pipeline.handleInboundText({ customerId: userId, text: "0891234567 ค่ะ", replyToken: "" });
  await waitFor(() => (teamPushes(lineFetch).length > before ? true : null));
  assert.match(teamPushes(lineFetch).at(-1), /0891234567/u, "รอบสองก็ต้องส่งเบอร์ถึงทีมงาน");
  db.close();
});
