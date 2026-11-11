// booking-handoff.test.mjs — "กุญแจสองดอก: ลูกค้าเอ่ยเรื่องจอง + ลูกแพรส่งไม้ต่อจริง = ปิดห้อง"
//
// คำสั่งพี่ง้วง 2026-09-05 (verbatim):
//   "ถ้าสมมติมีคน จะจองไว้ก่อน หรือใดๆ, หรือ ขอติดต่อทีมงาน, ให้สุดท้าย ลูกแพร คุยได้
//    และ ส่งต่อให้ชมพู่ (อันนี้ทำอยู่แล้วดีมาก) แต่ให้ ปิด AI ตัวนั้นไปเลยครับ
//    ไม่ต้อง follow up เพราะส่งให้ ชมพู่ handle ต่อเอง"
//
// ของจริงที่ทำให้คำสั่งนี้เกิด (probe อ่านอย่างเดียว 2026-09-05): 14 วันหลังสุด ลูกแพร
// รับปากว่า "ทีมงานจะติดต่อกลับ" 16 ครั้งใน 15 ห้อง — 8 ห้องยังเปิด AI อยู่ แปลว่า
// หลัง push ส่งต่อชมพู่แล้ว บอทยังคุยต่อและ follow-up ยังทักซ้ำ ลูกค้าที่ตัดสินใจซื้อแล้ว
// จึงได้ยินสองเสียงพร้อมกัน
//
// ---- ทำไมไฟล์นี้ถูกเขียนใหม่ทั้งไฟล์ (2026-09-05 รอบสอง) ----
// รอบแรกปิดห้องด้วย regex บนข้อความลูกค้าดอกเดียว การตรวจปรปักษ์สี่ชุดพบ 30 ข้อ ที่หนักสุด:
// "ขอถามเรื่องจองหน่อยค่ะ" / "ขอรายละเอียดการสมัครค่ะ" / "เดี๋ยวค่อยจองนะคะ" ปิดห้องถาวร
// ส่วน "จอง 1 ที่ครับ" ไม่ปิด — regex อ่านความตั้งใจในภาษาไทยไม่ออก
//
// รอบนี้ต้องครบสองดอกถึงจะปิด:
//   ดอกที่ 1 = ลูกค้าเอ่ยเรื่องจอง/ติดต่อทีมงาน (ใบ้ หลวมได้ อ่านย้อนหลังได้ 2 ข้อความ)
//   ดอกที่ 2 = ลูกแพรรับปากส่งไม้ต่อ "ในข้อความที่ถึงมือลูกค้าจริงแล้ว" (คำพิพากษา)
// ตารางด้านล่างล็อกทั้งสี่ช่องของเมทริกซ์ไว้ ไม่ใช่แค่ช่องที่ปิดห้อง
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createStagedFollowups, previewStagedFollowup } from "../src/stagedFollowups.mjs";
import { needsPersonReason, personReasonLabel } from "../src/needsPersonReason.mjs";
import { isWaitingForHuman } from "../src/needsHumanSla.mjs";
import { canAutoEnableAi, isStickyAiOffReason } from "../src/aiPausePolicy.mjs";
import { NOTIFY_REASON_TEXT } from "../src/notify.mjs";
import { validateSalesPolicy } from "../src/salesPolicy.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, waitFor,
  httpRequest, listen, promptText,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const NOTIFY_UID = "U00000000000000000000000000000a01";
// กุญแจดอกที่ 2 ในรูปที่ตัวจับ v1.4.26 เห็น — ถ้อยคำนี้คือสิ่งที่ลูกแพรพูดจริงในโปรดักชัน
const HANDOFF_REPLY = "รับทราบค่ะ ทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งให้ในแชทนี้นะคะ 🙏🏻";
// คำตอบที่ "ไม่ได้" ส่งไม้ต่อ — ลูกแพรอ่านแล้วเห็นว่าเขายังแค่ถาม จึงคุยต่อตามปกติ
const KEEP_TALKING_REPLY = "ได้เลยค่ะ 😊 ตอนนี้เปิดสองรอบนะคะ สนใจรอบไหนดีคะ";

function makeApp({ reply = HANDOFF_REPLY, notify = true, salesPolicy = null } = {}) {
  const db = memoryDb();
  db.setApprovedPrice("ราคา-12900", 12900);
  if (notify) db.setSetting("escalate_notify:default", JSON.stringify([NOTIFY_UID]));
  const hermesFetch = hermesFetchStub(reply);
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig(),
    db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {}, ...(salesPolicy ? { salesPolicy } : {}) },
    logger: silent,
  });
  return { app, db, hermesFetch, lineFetch };
}

const auditActions = (db, customerId) =>
  db.listAudit(200).filter((row) => row.target === customerId).map((row) => row.action);

const promiseNotes = (db, customerId) =>
  db.listHandoffNotes(customerId, 20).filter((note) => note.author === "ai_promise");

const teamPushes = (lineFetch) =>
  lineFetch.calls.filter((call) => call.url?.endsWith("/v2/bot/message/push") && call.body?.to === NOTIFY_UID);

/* ============================ เมทริกซ์กุญแจสองดอก ============================ */

/* ---- (1,1) ครบสองดอก -> ปิดห้องถาวร + ปลุกชมพู่ใบเดียว ---- */

test("กุญแจ (1,1): ลูกค้าจอง + ลูกแพรส่งไม้ต่อ -> ปิด AI ถาวร ปลุกทีมใบเดียว", async () => {
  const { app, db, lineFetch } = makeApp();
  const customerId = "U-booking-1";

  const result = await app.pipeline.handleInboundText({
    customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "rt-1",
  });
  assert.equal(result.sent, true, "ข้อความสุดท้ายต้องถึงลูกค้าจริงก่อนปิดห้อง");

  const customer = db.getCustomer(customerId);
  assert.equal(customer.state, "NEEDS_HUMAN", "ห้องต้องเข้าคิวรอคน");
  assert.equal(customer.ai_enabled, 0, "ปิด AI ถาวรตามคำสั่ง");
  assert.equal(customer.ai_off_reason, "booking_handoff");
  assert.match(customer.handoff_summary || "", /booking_handoff/u, "ทีมต้องอ่านเหตุได้จากสรุป");

  const actions = auditActions(db, customerId);
  assert.ok(actions.includes("ai_off_booking_handoff"), `ต้องมีแถวปิด AI (ได้ ${actions.join(",")})`);
  assert.ok(actions.includes("booking_handoff"), "ต้องมีแถวบอกว่าอะไรทำให้ห้องถูกปิด");
  const detail = db.listAudit(200).find((row) => row.action === "booking_handoff" && row.target === customerId).detail;
  assert.match(detail, /booking/u, "detail ต้องบอกชนิดของเจตนา");
  assert.match(detail, /กุญแจ 1/u, "detail ต้องบอกว่ากุญแจดอกที่ 1 มาจากไหน");
  assert.match(detail, /กุญแจ 2/u, "detail ต้องบอกว่าลูกแพรส่งไม้ต่อแบบไหน");
  assert.match(detail, /จอง/u, "detail ต้องมีวลีที่จับได้ ให้คนสอบทานตัวจับได้ทีหลัง");

  // คำรับปาก "ทีมงานจะติดต่อกลับ" อยู่ในคำตอบจริง แต่ห้องถูกส่งต่อไปแล้ว —
  // บล็อก v1.4.26 ต้องเห็นว่า alreadyHandled แล้วเงียบ (ไม่งั้นทีมโดนปลุกสองรอบต่อหนึ่งเคส)
  assert.equal(promiseNotes(db, customerId).length, 0, "ห้ามมีโน้ตคำรับปากซ้ำ");
  assert.ok(!actions.includes("promise_team_followup"), "ห้ามมีแถวคำรับปากซ้ำ");

  await waitFor(() => teamPushes(lineFetch).length >= 1);
  assert.equal(teamPushes(lineFetch).length, 1, "ปลุกทีมใบเดียวต่อหนึ่งการส่งต่อ");
  assert.match(teamPushes(lineFetch)[0].body.messages[0].text, /จอง|สมัคร/u);
  assert.ok(auditActions(db, customerId).includes("escalate_notify"));

  // เทิร์นถัดไปต้องเงียบสนิท — นี่คือหัวใจของคำสั่ง
  const next = await app.pipeline.handleInboundText({ customerId, text: "รอสายนะคะ", replyToken: "" });
  assert.equal(next.suppressed, "ai_disabled");
  db.close();
});

/* ---- ผู้ตรวจรอบสาม ข้อ 6: ห้องที่ปิดแล้ว ลูกค้ายังพิมพ์ต่อ — ต้องมีคนรู้ ---- */

test("ข้อ 6: ปิดห้องเพราะจองแล้ว ลูกค้าพิมพ์ชื่อ/รอบตามมา -> ปลุกทีมงานหนึ่งครั้ง ไม่ตอบเอง", async () => {
  const { app, db, lineFetch } = makeApp();
  const customerId = "U-wake-after-booking";

  await app.pipeline.handleInboundText({ customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "rt-w1" });
  assert.equal(db.getCustomer(customerId).ai_off_reason, "booking_handoff", "ต้องปิดด้วยเหตุนี้จริงก่อน");
  await waitFor(() => teamPushes(lineFetch).length >= 1);
  const pushesAfterClose = teamPushes(lineFetch).length;

  // ของจริง: ลูกค้าไทยพิมพ์ชื่อ/รอบตามมาในนาทีถัดไปเสมอ เดิมข้อความนี้ถูกกลืนเงียบ
  // เพราะตั๋วปลุกทีมงานมีแต่กับงาน project — ห้องจองไม่เคยได้ตั๋วเลย
  const next = await app.pipeline.handleInboundText({
    customerId, text: "ชื่อสมชายค่ะ ขอ 2 ที่รอบ 26 นะคะ", replyToken: "rt-w2",
  });
  assert.equal(next.suppressed, "ai_disabled", "AI ต้องเงียบต่อ — พี่ง้วงสั่งให้ชมพู่ handle เอง");
  await waitFor(() => teamPushes(lineFetch).length > pushesAfterClose);
  assert.equal(teamPushes(lineFetch).length, pushesAfterClose + 1, "ปลุกใบเดียว ไม่ใช่ทุกข้อความ");
  assert.ok(auditActions(db, customerId).includes("opportunity_handoff_reply"),
    "ต้องมีแถว audit ว่าลูกค้าตอบกลับมาหลังห้องถูกปิด");

  // ข้อความที่สาม (ไม่มีเบอร์) ต้องไม่ปลุกซ้ำ — เพดานเดิมของตั๋วยังอยู่ครบ
  await app.pipeline.handleInboundText({ customerId, text: "รอสายนะคะ", replyToken: "rt-w3" });
  assert.equal(teamPushes(lineFetch).length, pushesAfterClose + 1, "เพดานตั๋วต้องไม่ถูกยกเลิก");
  db.close();
});

test("ข้อ 6: ห้องที่ปิดด้วย human_requested มาแต่เดิม (ไม่มีตั๋ว) ต้องไม่ถูกปลุกใหม่ทั้งกอง", async () => {
  const { app, db, lineFetch } = makeApp();
  const customerId = "U-legacy-human-requested";
  db.upsertCustomer(customerId, {});
  // จำลองห้องเก่าที่ safetyRouter ปิดไว้ตั้งแต่ก่อนมีตั๋ว — ไม่มี setting ใด ๆ ผูกอยู่
  db.setAiEnabled(customerId, false, "human_requested");
  const before = teamPushes(lineFetch).length;
  const result = await app.pipeline.handleInboundText({ customerId, text: "สวัสดีค่ะ", replyToken: "rt-l1" });
  assert.equal(result.suppressed, "ai_disabled");
  assert.equal(teamPushes(lineFetch).length, before, "ไม่มีตั๋ว = ไม่ปลุก (ตั๋วสังเคราะห์มีไว้ให้งาน project เท่านั้น)");
  db.close();
});

/* ---- (1,0) ลูกค้าเอ่ยถึงการจอง แต่ลูกแพรอ่านแล้วเห็นว่ายังแค่ถาม -> ไม่ปิด ---- */

test("กุญแจ (1,0): ลูกค้าเอ่ยเรื่องจอง แต่ลูกแพรไม่ได้ส่งไม้ต่อ -> AI คุยต่อ ไม่มี push", async () => {
  const { app, db, lineFetch } = makeApp({ reply: KEEP_TALKING_REPLY });
  const customerId = "U-hint-only";

  const result = await app.pipeline.handleInboundText({
    customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "rt-2",
  });
  assert.equal(result.sent, true);

  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_enabled, 1, "ลูกแพรยังไม่ได้ส่งไม้ต่อ = ห้องยังเป็นของบอท");
  assert.equal(customer.state, "AI_ACTIVE");
  assert.equal(customer.ai_off_reason, "");
  const actions = auditActions(db, customerId);
  assert.ok(!actions.includes("booking_handoff"), `ห้ามปิดห้องด้วยใบ้ดอกเดียว (ได้ ${actions.join(",")})`);
  assert.equal(promiseNotes(db, customerId).length, 0, "ไม่มีคำรับปาก = ไม่มีโน้ต");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(teamPushes(lineFetch).length, 0, "ห้ามปลุกทีมเมื่อยังไม่มีการส่งต่อจริง");
  db.close();
});

/* ---- (0,1) ลูกแพรรับปากเอง โดยลูกค้าไม่ได้เอ่ยเรื่องจอง -> ทรงเดิม v1.4.26 ---- */

test("กุญแจ (0,1): ลูกแพรรับปากว่าทีมงานจะดูแล โดยไม่มีใบ้ -> โน้ต + push แต่ AI ยังเปิด", async () => {
  const { app, db, lineFetch } = makeApp();
  const customerId = "U-promise-only";

  await app.pipeline.handleInboundText({ customerId, text: "สนใจคลาสค่ะ", replyToken: "rt-3" });

  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_enabled, 1, "ทรงที่พี่ง้วงเลือกไว้ 2026-08-19 สำหรับบริบทที่ไม่ใช่การจอง");
  const actions = auditActions(db, customerId);
  assert.ok(actions.includes("promise_team_followup"), `ต้องยังเป็นเส้น v1.4.26 (ได้ ${actions.join(",")})`);
  assert.ok(!actions.includes("booking_handoff"), "ห้ามปิดห้องด้วยกุญแจดอกเดียว");
  assert.equal(promiseNotes(db, customerId).length, 1, "โน้ตคำรับปากต้องยังถูกเขียนเหมือนเดิม");
  await waitFor(() => teamPushes(lineFetch).length >= 1);
  assert.equal(teamPushes(lineFetch).length, 1);
  db.close();
});

/* ---- (0,0) ไม่มีอะไรเกิดขึ้น ---- */

test("กุญแจ (0,0): คุยปกติ ไม่มีใบ้ ไม่มีคำรับปาก -> ไม่มีอะไรเปลี่ยน", async () => {
  const { app, db, lineFetch } = makeApp({ reply: KEEP_TALKING_REPLY });
  const customerId = "U-plain";
  await app.pipeline.handleInboundText({ customerId, text: "สนใจคลาสค่ะ", replyToken: "rt-4" });
  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_enabled, 1);
  assert.equal(customer.state, "AI_ACTIVE");
  assert.deepEqual(auditActions(db, customerId).filter((action) => action === "booking_handoff"), []);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(teamPushes(lineFetch).length, 0);
  db.close();
});

/* ---- ใบ้จากสองเทิร์นก่อน + คำรับปากวันนี้ -> ปิด ---- */
//
// ทรงที่พบบ่อยที่สุดในห้องจริง: "ขอจองค่ะ" -> "รอบไหนดีคะ" -> "รอบ 26 ค่ะ" -> ส่งไม้ต่อ
// ถ้าใบ้อ่านแค่ข้อความล่าสุด กุญแจสองดอกจะไม่มีวันครบพร้อมกันในบทสนทนาทรงนี้เลย
test("ใบ้ย้อนหลัง: ลูกค้าเอ่ยเรื่องจองเมื่อสองเทิร์นก่อน แล้วลูกแพรส่งไม้ต่อวันนี้ -> ปิดห้อง", async () => {
  const db = memoryDb();
  db.setApprovedPrice("ราคา-12900", 12900);
  db.setSetting("escalate_notify:default", JSON.stringify([NOTIFY_UID]));
  const customerId = "U-lookback";
  db.upsertCustomer(customerId, {});
  // ประวัติจริงของห้อง: เขาขอจอง บอทถามรอบ แล้วเทิร์นนี้เขาตอบรอบ
  db.insertMessage({ customerId, direction: "in", msgType: "text", content: "ขอจองค่ะ" });
  db.insertMessage({ customerId, direction: "out", msgType: "text", content: "ได้เลยค่ะ สนใจรอบไหนดีคะ" });

  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig(),
    db,
    overrides: { hermesFetch: hermesFetchStub(HANDOFF_REPLY), lineFetch, sleep: async () => {} },
    logger: silent,
  });
  const result = await app.pipeline.handleInboundText({ customerId, text: "รอบ 26 ค่ะ", replyToken: "rt-5" });
  assert.equal(result.sent, true);
  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_enabled, 0, "ใบ้จากข้อความก่อนหน้าต้องยังนับ");
  assert.equal(customer.ai_off_reason, "booking_handoff");
  const detail = db.listAudit(200).find((row) => row.action === "booking_handoff" && row.target === customerId).detail;
  assert.match(detail, /ข้อความก่อนหน้า/u, "audit ต้องบอกว่าใบ้มาจากเทิร์นก่อน ไม่ใช่เทิร์นนี้");
  db.close();
});

test("ใบ้ย้อนหลัง: ข้อความเก่ากว่า 24 ชั่วโมงไม่นับ (ห้องเงียบไปหนึ่งวันแล้วกลับมาคุยเรื่องอื่น)", async () => {
  const db = memoryDb();
  db.setApprovedPrice("ราคา-12900", 12900);
  const customerId = "U-lookback-stale";
  db.upsertCustomer(customerId, {});
  db.insertMessage({ customerId, direction: "in", msgType: "text", content: "ขอจองค่ะ" });
  db.insertMessage({ customerId, direction: "out", msgType: "text", content: "ได้เลยค่ะ สนใจรอบไหนดีคะ" });
  // ดันข้อความทั้งคู่ให้เก่ากว่าหน้าต่าง 24 ชั่วโมง — ยืนยันว่าเขียนติดจริง ไม่ใช่ no-op
  // (ถ้าคำสั่งนี้เงียบไป เทสต์จะเขียวเพราะข้อความยังใหม่ ซึ่งคือการวัดคนละเรื่องกัน)
  db.raw.exec("UPDATE messages SET created_at = created_at - 200000000");
  assert.ok(
    Date.now() - Number(db.messagesFor(customerId, 5)[0].created_at) > 24 * 60 * 60_000,
    "ต้องดันเวลาให้พ้นหน้าต่างจริงก่อน ไม่งั้นเทสต์นี้ไม่ได้วัดอะไรเลย",
  );

  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig(),
    db,
    overrides: { hermesFetch: hermesFetchStub(HANDOFF_REPLY), lineFetch, sleep: async () => {} },
    logger: silent,
  });
  await app.pipeline.handleInboundText({ customerId, text: "ขอบคุณค่ะ", replyToken: "rt-6" });
  assert.equal(db.getCustomer(customerId).ai_enabled, 1, "ใบ้ต้องหมดอายุ ไม่งั้นห้องจะปิดจากบทสนทนาเมื่อวาน");
  db.close();
});

/* ---- ธง NEEDS_HUMAN ค้าง (AI ยังเปิด) ต้องปิดได้ ---- */
//
// ข้อ 13/25 ของการตรวจปรปักษ์: state NEEDS_HUMAN ถูกตั้งจาก hermes_down / send_failed /
// compliance_block โดยที่ AI ยังเปิดและบอทยังคุยอยู่ ธงพวกนี้ค้างได้เป็นวัน (probe 2 ก.ย.
// นับได้ 28 ห้อง) รอบแรกเช็ค state ด้วย ห้องกลุ่มนี้จึงไม่มีวันถูกปิด ทั้งที่มันคือ
// ประชากรที่เจ้าของบ่นถึงตรง ๆ
test("ธงค้าง: ห้อง NEEDS_HUMAN ที่ AI ยังเปิดอยู่ ต้องถูกปิดเมื่อครบสองดอก", async () => {
  const { app, db, lineFetch } = makeApp();
  const customerId = "U-stale-flag";
  db.upsertCustomer(customerId, {});
  db.setNeedsHuman(customerId, "hermes_down", "สมองไม่ตอบเมื่อสัปดาห์ที่แล้ว");
  assert.equal(db.getCustomer(customerId).state, "NEEDS_HUMAN");
  assert.equal(db.getCustomer(customerId).ai_enabled, 1, "ธงนี้ไม่เคยปิด AI");

  await app.pipeline.handleInboundText({ customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "rt-7" });
  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_enabled, 0, "ธงเก่าห้ามบังการปิดห้อง");
  assert.equal(customer.ai_off_reason, "booking_handoff");
  assert.match(customer.handoff_summary || "", /booking_handoff/u, "สรุปต้องมีเหตุใหม่ต่อท้าย");
  await waitFor(() => teamPushes(lineFetch).length >= 1);
  assert.equal(teamPushes(lineFetch).length, 1, "ปลุกทีมด้วยเหตุใหม่ ไม่ใช่ปล่อยให้ทีมอ่านเหตุเก่า");
  db.close();
});

/* ---- ส่งไม่ครบ (ลูกค้าพิมพ์แทรกกลางการทยอยส่ง) -> ห้ามปิด ---- */
//
// ข้อ 27: บอลลูนที่มีประโยคส่งไม้ต่ออาจไม่เคยถึงเขาเลย แล้วคำถามที่เขาเพิ่งพิมพ์จะถูกกลืน
// เป็น ai_disabled โดยไม่มีใครรู้ — ปล่อยให้เทิร์นถัดไปเป็นคนตัดสินแทน
test("ส่งไม่ครบ: ลูกค้าพิมพ์แทรกกลางทาง -> ห้ามปิดห้อง (บอลลูนส่งไม้ต่ออาจไม่ถึงเขา)", async () => {
  const db = memoryDb();
  db.setApprovedPrice("ราคา-12900", 12900);
  db.setSetting("escalate_notify:default", JSON.stringify([NOTIFY_UID]));
  const customerId = "U-partial";
  // คำตอบสามบอลลูน (humanizer ยุบย่อหน้าสั้นเข้าด้วยกัน จึงต้องยาวพอจะแยกจริง) —
  // ประโยคส่งไม้ต่ออยู่บอลลูนสุดท้าย ซึ่งคือบอลลูนที่ลูกค้าจะไม่ได้เห็นในฉากนี้
  const threeBubbles = [
    "ขอบคุณมากนะคะที่สนใจคลาสของเรา ลูกแพรดีใจมากเลยค่ะที่ได้ดูแลคุณลูกค้าในวันนี้ และหวังว่าคลาสนี้จะช่วยให้งานเบาลงจริง ๆ นะคะ",
    "คลาสนี้เหมาะกับเจ้าของธุรกิจที่อยากเอา AI มาช่วยงานหน้าร้านและงานเอกสารให้เร็วขึ้น เรียนจบแล้วเอาไปใช้ได้เลยค่ะ ไม่ต้องเขียนโค้ดเป็นเลยนะคะ",
    "รับทราบค่ะ เดี๋ยวทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งให้ในแชทนี้นะคะ",
  ].join("\n\n");
  let pushes = 0;
  const base = lineFetchStub();
  const lineFetch = async (url, opts = {}) => {
    const result = await base(url, opts);
    if (String(url).endsWith("/v2/bot/message/push")) {
      pushes += 1;
      // ลูกค้าพิมพ์แทรกทันทีหลังบอลลูนแรกถึงมือเขา -> stillRelevant() เป็นเท็จรอบถัดไป
      if (pushes === 1) db.insertMessage({ customerId, direction: "in", msgType: "text", content: "อ้อ ขอถามเพิ่มค่ะ" });
    }
    return result;
  };
  lineFetch.calls = base.calls;
  const app = createApp({
    config: testConfig(),
    db,
    overrides: { hermesFetch: hermesFetchStub(threeBubbles), lineFetch, sleep: async () => {} },
    logger: silent,
  });
  // replyToken ว่าง = เส้น push ทีละบอลลูน ซึ่งเป็นเส้นเดียวที่มี stillRelevant
  await app.pipeline.handleInboundText({ customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "" });
  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_enabled, 1, "ส่งไม่ครบ = ยังไม่รู้ว่าเขาได้อ่านการส่งไม้ต่อหรือยัง");
  assert.ok(!auditActions(db, customerId).includes("booking_handoff"));
  db.close();
});

/* ---- template ปลอบใจ/ด่านความปลอดภัย ไม่ใช่การส่งไม้ต่อ ---- */
//
// ด่านนี้เป็นด่านที่ "ต้องมี" ไม่ใช่ด่านเผื่อ: PRICE_REVIEW_TEMPLATE และ
// BLOCKED_FALLBACK_TEMPLATE มีถ้อยคำที่ตัวจับ v1.4.26 อ่านว่าเป็นคำรับปากของทีมงานจริง ๆ
// ถ้าไม่กันเส้น deterministic ไว้ ลูกค้าที่พิมพ์ "ขอจองไว้ก่อนค่ะ" แล้วบังเอิญโดนด่านราคา
// หรือด่านถ้อยคำในเทิร์นเดียวกัน จะถูกปิดห้องถาวรด้วย template ที่แปลว่า "ขอเช็คก่อนนะคะ"
test("เส้นปลอบใจ: template ของด่านความปลอดภัยมีถ้อยคำคล้ายคำรับปาก แต่ห้ามปิดห้อง", async () => {
  const { looksLikeTeamPromise, PRICE_REVIEW_TEMPLATE, BLOCKED_FALLBACK_TEMPLATE } =
    await import("../src/pipeline.mjs");
  // ยืนยันก่อนว่าตัวจับกุญแจดอกที่ 2 "เห็น" template พวกนี้จริง — ไม่งั้นด่านข้างล่างไร้ความหมาย
  assert.equal(looksLikeTeamPromise(PRICE_REVIEW_TEMPLATE), true);
  assert.equal(looksLikeTeamPromise(BLOCKED_FALLBACK_TEMPLATE), true);

  // ลูกค้าจอง + โมเดลตอบด้วยตัวเลขที่ไม่มีในตารางอนุมัติ = ด่านราคาบล็อก แล้วส่ง template แทน
  const { app, db } = makeApp({ reply: "ได้เลยค่ะ คลาสนี้ 7,777 บาท จองให้เลยนะคะ" });
  const customerId = "U-blocked-draft";
  await app.pipeline.handleInboundText({ customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "rt-guard" });
  const customer = db.getCustomer(customerId);
  assert.notEqual(customer.ai_off_reason, "booking_handoff",
    "คำตอบที่ลูกค้าได้คือ template ปลอบใจ ไม่ใช่การส่งไม้ต่อ — ห้ามปิดห้องถาวร");
  assert.ok(!auditActions(db, customerId).includes("booking_handoff"));
  db.close();
});

/* ---- เส้น template เดิมต้องไม่ถูกแตะเลย ---- */

test("ขอบเขต: 'ขอคุยกับแอดมินค่ะ' ยังเดินเส้น template เดิมทุกไบต์", async () => {
  const { app, db, hermesFetch } = makeApp();
  const customerId = "U-admin-1";
  const result = await app.pipeline.handleInboundText({ customerId, text: "ขอคุยกับแอดมินค่ะ", replyToken: "rt-8" });
  assert.equal(result.route, "human_handoff");
  assert.equal(result.deterministic, true);
  assert.equal(hermesFetch.calls.length, 0, "เส้น template ห้ามเสียเงินเรียกโมเดล");
  assert.equal(db.getCustomer(customerId).ai_off_reason, "human_requested");
  assert.ok(!auditActions(db, customerId).includes("booking_handoff"), "กลไกใหม่ห้ามแทรกเส้นเดิม");
  db.close();
});

/* ---- ขอติดต่อทีมงานบนเส้น AI -> เหตุ human_requested ---- */

// F4 (ตรวจย้อนหลัง ก.ย. 2026): "ขอ/เอาเบอร์-ไลน์ทีมงาน" ย้ายไปเส้น template human_handoff แล้ว
// (ของจริงเส้น AI ปล่อยห้องเปิดค้าง 11–25 ชม.) — เส้นสองกุญแจยังเป็นเจ้าของคำขอติดต่อรูปอื่น
// เช่น "ขอติดต่อทีมงานค่ะ" ซึ่งลูกแพรต้องตอบเอง (แจ้งช่องทางได้ถ้าคลังความรู้มี) แล้วกุญแจ 2 ปิดห้อง
test("ติดต่อทีมงาน: เส้น AI (ไม่ใช่ template) ก็ต้องปิดถาวรด้วยเหตุ human_requested", async () => {
  const { app, db, hermesFetch } = makeApp({
    reply: "ได้เลยค่ะ ลูกแพรส่งเรื่องให้ทีมงานเข้ามาดูแลต่อในแชทนี้แล้วนะคะ เดี๋ยวทีมงานจะติดต่อกลับค่ะ",
  });
  const customerId = "U-contact-1";

  const result = await app.pipeline.handleInboundText({
    customerId, text: "ขอติดต่อทีมงานค่ะ", replyToken: "rt-9",
  });
  assert.equal(result.sent, true);
  assert.equal(result.deterministic, false, "วลีนี้ไม่ได้อยู่ในเส้น template — ต้องผ่านโมเดลจริง");
  assert.ok(hermesFetch.calls.length >= 1);

  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_enabled, 0);
  assert.equal(customer.ai_off_reason, "human_requested", "ปลายทางเดียวกับเส้น human_handoff เดิม");
  assert.ok(auditActions(db, customerId).includes("ai_off_human_requested"));
  db.close();
});

/* ---- คำถามเรื่องจอง = ยังไม่ตัดสินใจ ---- */

test("คำถาม: 'จองได้ไหมคะ' -> AI ยังคุยต่อตามปกติ (ห้ามปิดปากลีด)", async () => {
  const { app, db } = makeApp({ reply: KEEP_TALKING_REPLY });
  const customerId = "U-ask-1";
  const result = await app.pipeline.handleInboundText({ customerId, text: "จองได้ไหมคะ", replyToken: "rt-10" });
  assert.equal(result.sent, true);
  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_enabled, 1);
  assert.equal(customer.state, "AI_ACTIVE");
  db.close();
});

/* ---- ส่งไม่ถึงลูกค้าเลย = ห้ามปิดห้อง ---- */

test("ส่งล้ม: ลูกค้าไม่ได้รับอะไรเลย -> ห้ามปิดห้องด้วยเหตุการจอง", async () => {
  const db = memoryDb();
  db.setApprovedPrice("ราคา-12900", 12900);
  // LINE ตอบ 500 ทุกครั้ง = ไม่มีบอลลูนไหนถึงมือลูกค้า
  const lineFetch = async () => ({ ok: false, status: 500, text: async () => "boom", json: async () => ({}) });
  const app = createApp({
    config: testConfig(),
    db,
    overrides: { hermesFetch: hermesFetchStub(HANDOFF_REPLY), lineFetch, sleep: async () => {} },
    logger: silent,
  });
  const customerId = "U-booking-fail";
  await app.pipeline.handleInboundText({ customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "rt-11" });
  const customer = db.getCustomer(customerId);
  assert.notEqual(customer.ai_off_reason, "booking_handoff", "ส่งไม่ถึง = ยังไม่ได้ตอบเขา ห้ามปิดด้วยเหตุนี้");
  assert.ok(!auditActions(db, customerId).includes("booking_handoff"));
  db.close();
});

/* ---- จอง + ส่งเลขบัญชีในเทิร์นเดียว -> เงินชนะ ---- */

test("เทิร์นเดียวมีทั้งจองและเลขบัญชี: bank_sent ชนะ และปลุกทีมใบเดียว", async () => {
  const bankReply = [
    "รับทราบค่ะ ทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งให้นะคะ",
    "โอนได้ที่บัญชีนี้ค่ะ\n\nธนาคาร : กสิกรไทย\nเลขที่บัญชี : 0000000000\nชื่อบัญชี : บริษัททดสอบ",
  ].join("\n\n");
  const { app, db, lineFetch } = makeApp({ reply: bankReply });
  const customerId = "U-booking-bank";
  const result = await app.pipeline.handleInboundText({
    customerId, text: "ตกลงค่ะ ขอสมัครเลย ขอเลขบัญชีด้วยค่ะ", replyToken: "rt-12",
  });
  assert.equal(result.sent, true);
  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_off_reason, "bank_sent", "จังหวะเงินมีของที่ต้องตรวจจริง จึงต้องชนะ");
  assert.equal(customer.deal_status, "awaiting_payment");
  assert.ok(!auditActions(db, customerId).includes("ai_off_booking_handoff"));

  await waitFor(() => teamPushes(lineFetch).length >= 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(teamPushes(lineFetch).length, 1, "หนึ่งเทิร์น = ปลุกทีมใบเดียว");
  db.close();
});

/* ---- scorer ต้องไม่ยิง push ใบที่สองทับการปิดห้อง ---- */
//
// ข้อ 26: scoreBurst วิ่งหลังตอบเสร็จ (fire-and-forget) ถ้า opportunity ครบ slot พอดี
// maybeHandoffOpportunity เคยตั้ง needsHuman ใหม่ เขียน ai_off_reason ทับเป็น
// handoff_private_inhouse แล้วยิง push ใบที่สอง — ทีมโดนปลุกสองรอบต่อหนึ่งเทิร์น
test("scorer: ห้องที่เพิ่งถูกปิดเพราะการจอง ต้องไม่ถูก opportunity handoff ปลุกซ้ำ", async () => {
  const policy = validateSalesPolicy({
    schemaVersion: 1,
    businessId: "pngoung-tidkradum",
    customerJourneys: ["new_lead"],
    decisionRoles: ["owner"],
    routingPrior: { dominantInterest: "ai", share: 0.99, publicClaimAuthorized: false },
    courses: [{ id: "ai-agent-business", type: "group_live", name: "AI Agent for Business", aliases: ["AI Basic"] }],
    opportunities: [
      { type: "private_class", requiredSlots: ["organization_context", "audience_size"], optionalSlots: [], upsize: true, handoffOnComplete: true },
    ],
  });
  const db = memoryDb();
  db.setSetting("escalate_notify:default", JSON.stringify([NOTIFY_UID]));
  const customerId = "U-scorer-after-close";
  db.upsertCustomer(customerId, {});
  db.insertMessage({ customerId, direction: "in", msgType: "text", content: "อยากเรียน private class บริษัทค้าปลีกมีทีม 20 คน" });
  // ห้องถูกปิดไปแล้วเพราะลูกค้าจอง (สถานะเดียวกับที่บล็อกกุญแจสองดอกทิ้งไว้)
  db.setNeedsHuman(customerId, "booking_handoff", "ลูกค้าขอจอง/สมัครแล้ว");
  db.setAiEnabled(customerId, false, "booking_handoff");

  const scorer = JSON.stringify({
    score: 6,
    trend: "up",
    persona_read: { disc: "S", bank: "Nurturing", reason: "ให้ข้อมูลใจเย็น" },
    opportunity: {
      type: "private_class",
      origin: "direct_request",
      slots: {
        organization_context: { value: "บริษัทค้าปลีก", evidence: "บริษัทค้าปลีก" },
        audience_size: { value: "20 คน", evidence: "20 คน" },
      },
    },
    order: null,
  });
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig(),
    db,
    overrides: { hermesFetch: hermesFetchStub(scorer), lineFetch, salesPolicy: policy, sleep: async () => {} },
    logger: silent,
  });
  await app.pipeline.scoreBurst(customerId);
  await new Promise((resolve) => setTimeout(resolve, 20));

  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_off_reason, "booking_handoff", "เหตุปิดห้ามถูกเขียนทับ");
  const actions = auditActions(db, customerId);
  assert.ok(!actions.includes("opportunity_handoff"), `ห้ามส่งต่อซ้ำ (ได้ ${actions.join(",")})`);
  assert.equal(teamPushes(lineFetch).length, 0, "ห้ามปลุกทีมใบที่สอง");
  db.close();
});

/* ---- /reset ต้องเปิด AI คืน ---- */

test("/reset: ล้างเหตุ booking_handoff แล้วเปิด AI คืนให้ห้องเทรน", async () => {
  const { app, db } = makeApp();
  const customerId = "U-booking-reset";
  await app.pipeline.handleInboundText({ customerId, text: "ขอสมัครค่ะ", replyToken: "rt-13" });
  assert.equal(db.getCustomer(customerId).ai_enabled, 0);

  db.resetCustomer(customerId);
  const after = db.getCustomer(customerId);
  assert.equal(after.ai_enabled, 1, "/reset ต้องคืนห้องให้บอทคุยต่อได้");
  assert.equal(after.ai_off_reason, "", "เหตุต้องถูกล้าง ไม่งั้นห้องยังถูกอ่านว่าเป็นของคน");
  db.close();
});

/* ---- ห้องฝั่ง Facebook ---- */
//
// เคสจริงส่วนใหญ่ที่พูดว่า "จองคิว/สมัคร" มาจากฝั่ง Facebook (ปุ่มคำถามสำเร็จรูปอยู่ที่นั่น)
// กลไกนี้จึงต้องไม่ผูกกับช่องทางใดช่องทางหนึ่ง — ปุ่มถูกกันด้วย presetButtons อยู่แล้ว
test("Facebook: ห้องฝั่งเพจก็ต้องปิดถาวรด้วยเหตุเดียวกัน", async () => {
  const { app, db } = makeApp();
  const customerId = "facebook:psid-booking";
  db.upsertCustomer(customerId, { channelId: "facebook" });
  const result = await app.pipeline.handleInboundText({ customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "" });
  assert.equal(result.sent, true);
  const customer = db.getCustomer(customerId);
  assert.equal(customer.channel_id, "facebook");
  assert.equal(customer.ai_enabled, 0);
  assert.equal(customer.ai_off_reason, "booking_handoff");
  assert.equal(customer.state, "NEEDS_HUMAN");
  db.close();
});

/* ============================== ทะเบียนและปลายทาง ============================== */

test("จอง: เหตุ booking_handoff เป็นเหตุ 'ของคน' — เส้นทางอัตโนมัติเปิดคืนเองไม่ได้", () => {
  assert.equal(isStickyAiOffReason("booking_handoff"), true);
  assert.equal(canAutoEnableAi({ ai_enabled: 0, ai_off_reason: "booking_handoff" }), false);
  assert.ok(NOTIFY_REASON_TEXT.booking_handoff, "ต้องมีข้อความแจ้งทีม ไม่งั้น push ถูกทิ้งเงียบ");
});

const fuCustomer = (reason) => ({
  line_user_id: "U-fu", ai_enabled: reason ? 0 : 1, ai_off_reason: reason,
  do_not_disturb: 0, followup_enabled: 1, marketing_consent: 0, last_score: 9,
  deal_status: reason === "bank_sent" ? "awaiting_payment" : "new",
});

test("follow-up: ห้อง booking_handoff และ bank_sent ไม่มีนัดทักอีกเลย (คำสั่ง 2026-09-05)", () => {
  for (const reason of ["booking_handoff", "bank_sent", "human_requested"]) {
    assert.equal(
      previewStagedFollowup({ customer: fuCustomer(reason), lastInboundAt: 1_000, nowMs: 10_000_000 }),
      null,
      `${reason}: AI ปิด = ห้ามมีข้อความอัตโนมัติตามไปอีก`,
    );
  }
  // ห้องที่ AI ยังเปิดอยู่ต้องมีนัดตามปกติ — ไม่งั้นเทสต์นี้ "เขียวเพราะทุกอย่างตายหมด"
  assert.notEqual(previewStagedFollowup({ customer: fuCustomer(""), lastInboundAt: 1_000, nowMs: 10_000_000 }), null);
});

test("follow-up: SQL คัดห้องต้องไม่หยิบห้องที่ AI ปิดเลยสักเหตุ", () => {
  const db = memoryDb();
  for (const [id, reason] of [["U-b1", "booking_handoff"], ["U-b2", "bank_sent"], ["U-b3", ""]]) {
    db.upsertCustomer(id, {});
    db.insertMessage({ customerId: id, direction: "in", msgType: "text", content: "ทัก" });
    if (reason) db.setAiEnabled(id, false, reason);
  }
  const ids = db.listStagedFollowupCandidates({ nowMs: Date.now(), activeWithinMs: 3 * 86_400_000 })
    .map((row) => row.line_user_id);
  assert.deepEqual(ids, ["U-b3"], "เหลือเฉพาะห้องที่บอทยังเป็นเจ้าของแชท");
  db.close();
});

test("follow-up (F5): นัดที่ค้างคิวของห้อง booking_handoff ถูกข้ามเป็น human_owned", async () => {
  const { createFollowupEngine } = await import("../src/followupEngine.mjs");
  const { createHermesBridge } = await import("../src/hermesBridge.mjs");
  const { createComplianceGuard } = await import("../src/complianceGuard.mjs");
  const { createHumanizer } = await import("../src/humanizer.mjs");
  const { createLineClient } = await import("../src/lineClient.mjs");
  // เที่ยงวันเวลาไทย — ต้องไม่ตกในช่วงเงียบ ไม่งั้นเทสต์จะ "เขียวด้วยเหตุผลผิด"
  const noon = Date.UTC(2026, 0, 15, 5, 0, 0);
  const config = testConfig({ FOLLOWUP_ENABLED: "true" });
  const db = memoryDb({ now: () => noon });
  const customerId = "U-fu-booking";
  db.upsertCustomer(customerId, {});
  db.setFollowupEnabled(customerId, true);
  const scheduled = db.createFollowup({ customerId, scheduledAt: noon - 1000, createdBy: "nok", note: "" });
  db.setNeedsHuman(customerId, "booking_handoff", "ลูกค้าขอจอง/สมัครแล้ว");
  db.setAiEnabled(customerId, false, "booking_handoff");

  const engine = createFollowupEngine({
    config,
    db,
    hermes: createHermesBridge({ config, fetchImpl: hermesFetchStub("ทักตามนัด"), logger: silent }),
    line: createLineClient({ config, fetchImpl: lineFetchStub(), sleep: async () => {}, logger: silent }),
    guard: createComplianceGuard({ bannedWords: [], getApprovedPrices: () => db.approvedPrices() }),
    humanizer: createHumanizer(),
    logger: silent,
    now: () => noon,
  });
  const out = await engine.runDue();
  const result = out.results.find((row) => row.id === scheduled.id) ?? out.results[0];
  assert.equal(result?.status, "skipped");
  assert.equal(result?.detail, "human_owned", `ได้ ${JSON.stringify(result ?? null)}`);
  assert.equal(db.getFollowup(scheduled.id).status, "skipped");
  db.close();
});

test("SLA: ห้อง booking_handoff เป็นเหตุ 'ต้องใช้คน' (ยอมจ่ายค่า push) และอยู่ในคิวรอคน", () => {
  const room = {
    line_user_id: "U-sla-booking", state: "AI_ACTIVE", handoff_summary: "",
    ai_enabled: 0, ai_off_reason: "booking_handoff",
  };
  assert.equal(needsPersonReason(room), "booking_handoff");
  assert.match(personReasonLabel("booking_handoff"), /จอง|สมัคร/u);
  assert.equal(isWaitingForHuman(room), true, "ต้องโผล่ในคิวรอคนบนคอนโซล");
});

test("SLA: อ่านเหตุจากสรุป handoff ได้ด้วย (ห้องที่มีคนเปิด AI คืนแต่ยังไม่มีใครตอบ)", () => {
  assert.equal(needsPersonReason({
    state: "NEEDS_HUMAN", ai_enabled: 1, ai_off_reason: "",
    handoff_summary: "[2026-09-05T01:00:00.000Z] booking_handoff: ลูกค้าขอจอง/สมัครแล้ว",
  }), "booking_handoff");
});

/* ================================ กติกาในพรอมต์ ================================ */
//
// ใบ้ต้องอ่านเหมือน "ข้อมูลให้ลูกแพรตัดสิน" ไม่ใช่คำสั่งปิดห้าง — และในเทิร์นเดียวกัน
// ต้องไม่มีคำสั่งไหนสั่งให้ถามคัดกรองต่อ (แกนนั้นถูกตรวจเต็มรูปใน
// test/price-directive-contradiction.test.mjs)

test("พรอมต์: ใบ้จอง -> สั่งให้ลูกแพรตัดสินเองว่ายืนยันหรือยังลังเล และห้ามถามคัดกรองเพิ่ม", async () => {
  const { baseRules } = await import("../src/pipeline.mjs");
  const { detectHandoffHint } = await import("../src/handoffIntent.mjs");
  const customer = {
    line_user_id: "U-p", known_name: "", last_score: null,
    price_deferred_at: 0, price_quoted_at: 0, known_context_at: 0, price_pivot_deferred_at: 0,
  };
  const text = "ขอจองไว้ก่อนค่ะ";
  const rules = baseRules("general", [], {
    customer, currentText: text, history: [], handoffIntent: detectHandoffHint(text),
  });
  assert.match(rules, /ถ้าเขายืนยันชัดว่าจะจอง\/สมัคร/u, "การตัดสินเป็นของลูกแพร ไม่ใช่ของ regex");
  // R1: ประโยคส่งไม้ต่อถูกกำหนดคำต่อคำ — กุญแจดอกที่ 2 ต้องอ่านประโยคเดียวกันนี้ออก
  assert.match(rules, /ทีมงาน \(คุณชมพู่\) จะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ/u);
  assert.match(rules, /ไม่ถามคำถามคัดกรองเพิ่ม/u);
  assert.match(rules, /ถ้ายังเป็นคำถาม แค่สนใจ หรือยังลังเล/u, "ทางออกสำหรับคนที่แค่ถาม ต้องอยู่ในกติกาเดียวกัน");
  assert.match(rules, /ห้ามพูดว่าลูกแพรล็อกที่นั่ง/u, "ระบบไม่มีตัวล็อกที่นั่งจริง (บทเรียน v1.4.37)");
  // R1: ห้ามมีคำสั่งสวนทางแบบไม่มีเงื่อนไขอยู่ในเทิร์นเดียวกันอีก (เหตุผลเต็มอยู่ใน
  // test/price-directive-contradiction.test.mjs — ที่นี่ล็อกไว้ให้เห็นคู่กับถ้อยคำจริง)
  assert.doesNotMatch(rules, /ห้ามปิดท้ายด้วยคำถามใด ๆ|ห้ามสำรวจโจทย์เพิ่ม/u,
    "คำสั่งสวนทางทำให้ลูกแพรต้องเขียนประโยคส่งไม้ต่อ = กุญแจดอกที่ 2 กลายเป็นตรายาง");

  const contact = baseRules("general", [], {
    customer, currentText: "ขอติดต่อทีมงานค่ะ", history: [],
    handoffIntent: detectHandoffHint("ขอติดต่อทีมงานค่ะ"),
  });
  assert.match(contact, /ลูกแพรส่งเรื่องให้ทีมงานคนจริงเข้ามาดูแลต่อในแชทนี้แล้วนะคะ/u);
  assert.match(contact, /ไม่ชวนคุยขายต่อ/u);
  assert.match(contact, /ถ้าเขาแค่เล่าว่าทีมงานเคยติดต่อไปแล้ว/u, "ทางออกสำหรับการเล่าเรื่องอดีต");

  const plain = baseRules("general", [], { customer, currentText: "สนใจคลาสค่ะ", history: [] });
  assert.doesNotMatch(plain, /ไม่ถามคำถามคัดกรองเพิ่ม/u, "เทิร์นปกติต้องไม่มีกติกานี้ปน");
});

/* ================================ กันโมดูลที่ไม่เกี่ยว ================================ */

test("ขอบเขต: booking_handoff ต้องไม่ถูกอ่านเป็นเหตุ 'เส้นเงิน'", async () => {
  const { isMoneyLineReason } = await import("../src/pipeline.mjs");
  assert.equal(isMoneyLineReason("booking_handoff"), false,
    "ถ้าอ่านเป็นเส้นเงิน ห้องจะถูกปักธงเงินถาวรทั้งที่ยังไม่มีใครจ่ายอะไร");
});

// createStagedFollowups ถูก import ไว้เพื่อยืนยันว่าโมดูลยังโหลดได้หลังแก้กติกา
// (ถ้า export หายหรือไฟล์พัง เทสต์นี้แดงทันทีแทนที่จะไปแดงที่อื่นแบบงง ๆ)
test("โมดูล staged follow-up ยังประกอบได้หลังกลับข้อยกเว้น bank_sent", () => {
  assert.equal(typeof createStagedFollowups, "function");
});

/* ===== R1: ประตูจังหวะราคาของเทิร์นส่งไม้ต่อ ต้องเปิดจริงในพรอมต์ที่ส่งให้โมเดล ===== */
//
// รอบสองส่งคีย์ผิดชื่อ (bookingCommit แทน closingTurn) ประตูนี้จึงไม่เคยเปิดเลยสักครั้ง
// และไม่มีเทสต์ไหนจับได้ เพราะทุกเทสต์เรียก baseRules ตรง ๆ พร้อมส่ง handoffIntent เอง
// เทสต์นี้จึงอ่านจาก "พรอมต์ที่ถูกส่งไปให้โมเดลจริง" ผ่านไปป์ไลน์ทั้งเส้น

test("R1: เทิร์นจอง+ถามราคา -> พรอมต์จริงต้องสั่งแจ้งราคา และห้ามมีคำสั่งคัดกรองปน", async () => {
  const { app, db, hermesFetch } = makeApp({ reply: KEEP_TALKING_REPLY });
  const customerId = "U-gate-quote";
  await app.pipeline.handleInboundText({ customerId, text: "ขอจองค่ะ ราคาเท่าไหร่คะ", replyToken: "rt-gate1" });
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.match(system, /ไม่ถามคำถามคัดกรองเพิ่ม/u, "กติกาใบ้ต้องอยู่ในพรอมต์จริง");
  assert.doesNotMatch(system, /ปิดด้วยคำถามคัดกรองข้อเดียว/u,
    "ประตูราคาไม่เปิด = พรอมต์สั่งคัดกรองในเทิร์นเดียวกับที่แบนการคัดกรอง (บั๊กรอบสอง)");
  assert.doesNotMatch(system, /ยังไม่ถึงจังหวะราคา/u, "เขาถามราคามาแล้ว ต้องตอบให้จบในข้อความนี้");
  db.close();
});

test("R1: เทิร์นจองที่ไม่ได้ถามราคา -> พรอมต์จริงต้องเงียบเรื่องราคาทั้งเทิร์น", async () => {
  const { app, db, hermesFetch } = makeApp({ reply: KEEP_TALKING_REPLY });
  const customerId = "U-gate-silent";
  await app.pipeline.handleInboundText({ customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "rt-gate2" });
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.match(system, /ไม่ถามคำถามคัดกรองเพิ่ม/u);
  assert.doesNotMatch(system, /ยังไม่ถึงจังหวะราคา|ปิดด้วยคำถามคัดกรองข้อเดียว/u,
    "ไม่ถามราคา = ไม่ต้องพูดเรื่องราคาเลย ทั้งฝั่งให้บอกและฝั่งห้ามบอก");
  assert.doesNotMatch(system, /ปกติปิดท้ายด้วยคำถามนำหนึ่งข้อ|ทำความเข้าใจโจทย์ของลูกค้าก่อน/u,
    "คำสั่งให้ถามต้องถูกระงับ");
  assert.doesNotMatch(system, /ห้ามปิดท้ายด้วยคำถามใด ๆ|ห้ามสำรวจโจทย์เพิ่ม/u,
    "และต้องไม่มีคำสั่งสวนทางมาแทน — ลูกแพรต้องเลือกเอง");
  db.close();
});

/* ==================== R2: กุญแจดอกที่ 2 ต้องเข้มและเป็นอิสระ ==================== */
//
// รอบสองใช้ตัวจับ v1.4.26 (looksLikeTeamPromise/looksLikeSelfPromise) ซึ่งออกแบบมาเพื่อ
// "ออกใบสั่งงานให้ทีมงาน" จึงตั้งใจหลวม — ราคาของการจับเกินที่นั่นคือโน้ตหนึ่งใบ แต่ที่นี่
// คือปิดปากลูกแพรถาวร ตารางนี้คือคำตอบว่า "อะไรคือการส่งไม้ต่อจริง" ในถ้อยคำของลูกแพรเอง

const HANDOVER_ACCEPTED = [
  // สองประโยคที่พรอมต์กำหนดคำต่อคำ (ต้องอ่านออกแบบไม่มีข้อแม้)
  "ทีมงาน (คุณชมพู่) จะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ",
  "ลูกแพรส่งเรื่องให้ทีมงานคนจริงเข้ามาดูแลต่อในแชทนี้แล้วนะคะ",
  // ตัวอย่างที่ผู้ตรวจปรปักษ์รอบสองยกมาว่า "อันนี้แหละของจริง"
  "รับทราบค่ะ ลูกแพรส่งเรื่องให้ทีมงานคนจริงเข้ามาดูแลต่อในแชทนี้แล้วนะคะ",
  // ถ้อยคำที่ลูกแพรพูดจริงในโปรดักชัน
  "รับทราบค่ะ ทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งให้ในแชทนี้นะคะ 🙏🏻",
  "ได้เลยค่ะ เดี๋ยวทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งให้นะคะ",
  // ถอดความแบบต่าง ๆ ที่ยังเป็นการส่งมอบเคสแบบไม่มีเงื่อนไข
  "ขอบคุณมากนะคะ เดี๋ยวลูกแพรส่งต่อให้ทีมงานคุณชมพู่ดูแลต่อในแชทนี้เลยค่ะ",
  "ลูกแพรส่งเรื่องให้ทีมงานจัดทำใบเสนอราคาให้แล้วนะคะ",
  "คุณชมพู่จะติดต่อกลับในแชทนี้นะคะ",
  "รับทราบค่ะ เดี๋ยวทีมผู้ดูแลจะติดต่อกลับเพื่อยืนยันที่นั่งนะคะ",
  "ขอบคุณที่ไว้วางใจนะคะ ทีมงานจะเข้ามาดูแลต่อในแชทนี้ค่ะ",
  "ลูกแพรส่งต่อให้คุณชมพู่ดูแลต่อแล้วนะคะ",
  "ตอนนี้ลูกแพรส่งเรื่องให้ทีมงานยืนยันที่นั่งให้เรียบร้อยแล้วค่ะ",
  "เดี๋ยวทีมงานจะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ ขอบคุณมากค่ะ",
];

const HANDOVER_REJECTED = [
  // ตัวอย่างจากรายงานตรวจปรปักษ์รอบสอง — ข้อเสนอแบบมีเงื่อนไข ลูกค้ายังไม่ได้แจ้งอะไรเลย
  "คลาสนี้เรียน 2 วันเต็มค่ะ หากต้องการจอง แจ้งชื่อและรอบที่สะดวกมาได้เลยค่ะ เดี๋ยวลูกแพรส่งเรื่องให้ทีมงานยืนยันที่นั่งให้นะคะ",
  // ตัวอย่างจากรายงานเดียวกัน — คำสุภาพประจำร้าน + คำถามปิดท้าย
  "ขอบคุณที่สนใจนะคะ ตอนนี้เปิดรอบ 19 และ 26 ค่ะ ทีมงานพร้อมช่วยดูแลทุกขั้นตอนค่ะ สะดวกรอบไหนดีคะ",
  "ทีมงานพร้อมช่วยดูแลทุกขั้นตอนค่ะ",
  "ยินดีให้บริการค่ะ ทีมงานยินดีดูแลทุกท่านค่ะ",
  "ถ้าสนใจจอง เดี๋ยวลูกแพรส่งเรื่องให้ทีมงานยืนยันที่นั่งให้นะคะ",
  "เมื่อพร้อมแจ้งมาได้เลยนะคะ เดี๋ยวทีมงานจะติดต่อกลับค่ะ",
  "ส่งชื่อและเบอร์มาได้เลยค่ะ เดี๋ยวทีมงานจะติดต่อกลับนะคะ",
  "กรณีที่ต้องการให้ทีมงานติดต่อกลับ แจ้งมาได้เลยนะคะ",
  "รับทราบค่ะ เดี๋ยวทีมงานจะติดต่อกลับนะคะ สะดวกรอบไหนดีคะ",
  "ทีมงานจะติดต่อกลับไหมคะ",
  "ได้เลยค่ะ 😊 ตอนนี้เปิดสองรอบนะคะ สนใจรอบไหนดีคะ",
  "ขอบคุณค่ะ เดี๋ยวลูกแพรสรุปรายละเอียดคลาสให้นะคะ",
  "ลูกแพรจะส่งรายละเอียดให้นะคะ",
  "ทีมงานเคยติดต่อกลับไปแล้วใช่ไหมคะ",
  "ขอบคุณสำหรับข้อมูลนะคะ",
  /* ---- ผู้ตรวจรอบสาม 2026-09-05: ทุกประโยคด้านล่างถูก "รันจริง" แล้วพบว่ารอบสองปิดห้องให้ ---- */
  // ข้อ 1: "ขอ" ไปแมตช์กลางคำว่า "ของ" — วลีนี้ลูกแพรพูดทุกวันในฐานะคำโฆษณาบริการหลังการขาย
  "ทีมงานของเราดูแลต่อให้หลังเรียนจบค่ะ",
  "ทีมงานของเราติดต่อกลับทุกเคสภายใน 1 วันค่ะ",
  "ของเรามีทีมงานดูแลต่อค่ะ",
  // ทีมงาน *ของลูกค้า* ไม่ใช่ของเรา — ปิดห้องใส่คนนี้คือฆ่าลีดที่กำลังจะซื้อ
  "ให้ทีมงานของคุณดูแลต่อจากบอทได้เลยค่ะ",
  // ข้อ 2: "จะ" เปล่า ๆ ทำให้ประโยคเล่า "ขั้นตอนจ่ายเงิน" ปิดห้อง ทั้งที่ลูกค้ายังต้องโอนก่อน
  "สมัครได้เลยค่ะ โอนมัดจำแล้วแจ้งสลิปในแชทนี้ได้เลยนะคะ หลังจากนั้นทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งนะคะ",
  "ขั้นตอนคือ โอนแล้วส่งสลิปในแชทนี้ ทีมงานจะยืนยันที่นั่งให้ค่ะ",
  // ข้อ 2: คุณสมบัติสินค้า ไม่ใช่การส่งมอบเคส
  "เรียนจบแล้วจะมีทีมงานดูแลต่อในกลุ่มไลน์ด้วยนะคะ",
  "คลาสนี้จะมีทีมงานดูแลต่อหลังเรียนจบ 30 วันเลยค่ะ",
  "ทีมงานน่าจะติดต่อกลับภายในวันนี้ค่ะ",
  // ข้อ 4: ตอบคำถาม "สมัครยังไงคะ" — ลูกค้ายังไม่ได้แจ้งชื่อเลยสักตัว
  "ขั้นตอนง่ายมากค่ะ แจ้งชื่อและรอบที่สะดวก จากนั้นทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งค่ะ",
  // ข้อ 4 + ความเสี่ยงคงค้างข้อ 1 ของรอบสอง: ธุรกิจนี้ *ขาย* ระบบส่งต่อลูกค้าให้ทีมงาน
  "ในคลาสจะสอนให้บอทส่งต่อลูกค้าให้ทีมงานดูแลต่อได้อัตโนมัติค่ะ",
  "ทีมงานของเราสอนเรื่องการส่งต่อลูกค้าให้ทีมงานดูแลต่อในคลาสด้วยค่ะ",
  // ข้อ 5: คำเชื่อมลำดับไทยที่รอบสองไม่รู้จัก — ทั้งสามข้อยังค้างการกระทำของลูกค้าไว้
  "พอโอนเสร็จ แจ้งในแชทนี้นะคะ เดี๋ยวทีมงานยืนยันที่นั่งให้ค่ะ",
  "เมื่อตัดสินใจแล้วแจ้งชื่อและรอบนะคะ ลูกแพรจะส่งเรื่องให้ทีมงานติดต่อกลับค่ะ",
  "ถ้าสนใจรอบ 26 นะคะ แจ้งชื่อได้เลยค่ะ ลูกแพรยินดีมากค่ะ เดี๋ยวทีมงานติดต่อกลับยืนยันที่นั่งนะคะ",
];

test("R2: ตารางกุญแจดอกที่ 2 — ประโยคส่งไม้ต่อจริงต้องอ่านออกครบ", async () => {
  const { looksLikeHandoverReply } = await import("../src/pipeline.mjs");
  for (const reply of HANDOVER_ACCEPTED) {
    assert.equal(looksLikeHandoverReply([{ text: reply }]), true,
      `ต้องอ่านว่าเป็นการส่งไม้ต่อ: "${reply}"`);
  }
  assert.ok(HANDOVER_ACCEPTED.length >= 12, "ฝั่งรับต้องมีอย่างน้อย 12 รูปประโยค");
});

test("R2: ตารางกุญแจดอกที่ 2 — คำสุภาพ/เงื่อนไข/คำถาม ห้ามนับเป็นการส่งไม้ต่อ", async () => {
  const { looksLikeHandoverReply } = await import("../src/pipeline.mjs");
  for (const reply of HANDOVER_REJECTED) {
    assert.equal(looksLikeHandoverReply([{ text: reply }]), false,
      `ห้ามอ่านว่าเป็นการส่งไม้ต่อ (ปิดห้องผิด = ปิดปากลีดถาวร): "${reply}"`);
  }
  assert.ok(HANDOVER_REJECTED.length >= 12, "ฝั่งปฏิเสธต้องมีอย่างน้อย 12 รูปประโยค");
});

test("R2: อ่านรายประโยคในบอลลูนเดียว ไม่ใช่รายบรรทัด (humanizer ยุบประโยคสั้นเข้าด้วยกัน)", async () => {
  const { looksLikeHandoverReply } = await import("../src/pipeline.mjs");
  // เงื่อนไขกับคำรับปากอยู่บอลลูนเดียวกันคนละประโยค — ถ้าอ่านรายบรรทัดจะมองไม่เห็นเงื่อนไข
  assert.equal(looksLikeHandoverReply([
    { text: "หากสนใจแจ้งชื่อมาได้เลยค่ะ เดี๋ยวลูกแพรส่งเรื่องให้ทีมงานดูแลต่อนะคะ" },
  ]), false);
  // คำถามอยู่บอลลูนสุดท้าย ส่วนคำรับปากอยู่บอลลูนก่อนหน้า = ยังรอคำตอบอยู่
  assert.equal(looksLikeHandoverReply([
    { text: "รับทราบค่ะ เดี๋ยวทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งนะคะ" },
    { text: "สะดวกรอบไหนดีคะ" },
  ]), false);
  // บอลลูนสุดท้ายไม่ใช่คำถาม = ปิดได้
  assert.equal(looksLikeHandoverReply([
    { text: "คลาสนี้เรียน 2 วันเต็มค่ะ" },
    { text: "รับทราบค่ะ เดี๋ยวทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งนะคะ" },
  ]), true);
  assert.equal(looksLikeHandoverReply([]), false, "ไม่มีบอลลูนถึงมือลูกค้า = ไม่มีอะไรให้ตัดสิน");
});

test("R2 รอบสาม: 'ได้เลยค่ะ' เดี่ยว ๆ คือคำตอบรับ ไม่ใช่ข้อเสนอที่ค้างการกระทำลูกค้าไว้", async () => {
  const { looksLikeHandoverReply } = await import("../src/pipeline.mjs");
  // ถ้าปิดกั้น "ได้เลย" แบบไม่ผูกกับกริยาสั่งการ ประโยคตอบรับปกติจะพังทั้งกอง
  assert.equal(looksLikeHandoverReply([
    { text: "ได้เลยค่ะ เดี๋ยวทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งให้นะคะ" },
  ]), true);
  // แต่ "แจ้ง/ส่ง ... ได้เลย" คือการสั่งให้ลูกค้าทำอะไรต่อ = ห้องยังไม่จบ
  assert.equal(looksLikeHandoverReply([
    { text: "แจ้งชื่อได้เลยค่ะ เดี๋ยวทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งให้นะคะ" },
  ]), false);
});

test("R2 รอบสาม: เงื่อนไขที่อยู่คนละบอลลูน (humanizer ตัดย่อหน้า) ต้องยังมองเห็น", async () => {
  const { looksLikeHandoverReply } = await import("../src/pipeline.mjs");
  const { splitIntoBubbles } = await import("../src/humanizer.mjs");
  // พรอมต์สั่งให้ประโยคปิดท้ายอยู่ย่อหน้าของตัวเอง humanizer จึงแยกเป็นคนละบอลลูนเสมอ
  const draft = "ขอบคุณที่สนใจนะคะ คลาสนี้เรียน 2 วันเต็มค่ะ\n\n"
    + "หากต้องการจอง แจ้งชื่อและรอบที่สะดวกมาได้เลยค่ะ\n\n"
    + "เดี๋ยวลูกแพรส่งเรื่องให้ทีมงานยืนยันที่นั่งให้นะคะ";
  const bubbles = splitIntoBubbles(draft);
  assert.ok(bubbles.length >= 2, "ต้องถูกตัดเป็นหลายบอลลูนจริง ไม่งั้นเทสต์นี้ไม่ได้ทดสอบอะไร");
  assert.ok(!bubbles.at(-1).includes("หาก"), "เงื่อนไขต้องไปอยู่บอลลูนก่อนหน้า");
  // นี่คือตัวอย่างที่ผู้ตรวจรอบสองสั่งให้ปฏิเสธ — รอบสองรับมันเพราะดูแค่ในบอลลูนเดียวกัน
  assert.equal(looksLikeHandoverReply(bubbles.map((text) => ({ text }))), false,
    "ลูกค้ายังไม่ได้แจ้งชื่อ = ยังไม่มีอะไรถูกส่งมอบ ปิดห้องตรงนี้คือทิ้งเขากลางคัน");
});

test("R2: เส้น v1.4.26 (โน้ต ai_promise) ต้องไม่ถูกแตะ — ยังหลวมเหมือนเดิมทุกไบต์", async () => {
  const { looksLikeTeamPromise, looksLikeHandoverReply } = await import("../src/pipeline.mjs");
  const conditional = "หากต้องการจอง แจ้งชื่อมาได้เลยค่ะ เดี๋ยวลูกแพรส่งเรื่องให้ทีมงานยืนยันที่นั่งให้นะคะ";
  assert.equal(looksLikeTeamPromise(conditional), true, "ใบสั่งงานยังต้องออก — ลูกค้าถูกรับปากไปแล้ว");
  assert.equal(looksLikeHandoverReply([{ text: conditional }]), false, "แต่ห้องยังไม่ปิด");
});

/* ============ เมทริกซ์กุญแจสองดอกฉบับ K2 เข้ม (R7) ============ */

const CONDITIONAL_PROMISE_REPLY =
  "คลาสนี้เรียน 2 วันเต็มค่ะ หากต้องการจอง แจ้งชื่อและรอบที่สะดวกมาได้เลยค่ะ เดี๋ยวลูกแพรส่งเรื่องให้ทีมงานยืนยันที่นั่งให้นะคะ";
const COURTESY_REPLY = "ขอบคุณที่สนใจนะคะ ทีมงานพร้อมช่วยดูแลทุกขั้นตอนเลยค่ะ";
const QUESTION_TAIL_REPLY = "รับทราบค่ะ เดี๋ยวทีมงานจะติดต่อกลับเพื่อยืนยันที่นั่งนะคะ สะดวกรอบไหนดีคะ";
const DICTATED_BOOKING_REPLY =
  "รับทราบค่ะ ทีมงาน (คุณชมพู่) จะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ";
const DICTATED_CONTACT_REPLY = "รับทราบค่ะ ลูกแพรส่งเรื่องให้ทีมงานคนจริงเข้ามาดูแลต่อในแชทนี้แล้วนะคะ";

async function runTurn({ reply, text, customerId, seed = null }) {
  const { app, db, lineFetch } = makeApp({ reply });
  db.upsertCustomer(customerId, {});
  if (seed) seed(db);
  const result = await app.pipeline.handleInboundText({ customerId, text, replyToken: `rt-${customerId}` });
  return { app, db, lineFetch, result, customer: db.getCustomer(customerId) };
}

test("K2 เข้ม: ใบ้ครบ แต่คำตอบจบด้วยคำถาม -> ห้ามปิดห้อง", async () => {
  const { db, customer } = await runTurn({
    reply: QUESTION_TAIL_REPLY, text: "ขอจองไว้ก่อนค่ะ", customerId: "U-k2-question",
  });
  assert.equal(customer.ai_enabled, 1, "ลูกแพรยังรอคำตอบเขาอยู่ — ปิดตรงนี้คือทิ้งเขากลางคัน");
  assert.ok(!auditActions(db, "U-k2-question").includes("booking_handoff"));
  db.close();
});

test("K2 เข้ม: ใบ้ครบ แต่คำรับปากมีเงื่อนไขนำหน้า -> ห้ามปิดห้อง", async () => {
  const { db, customer } = await runTurn({
    reply: CONDITIONAL_PROMISE_REPLY, text: "ขอจองไว้ก่อนค่ะ", customerId: "U-k2-conditional",
  });
  assert.equal(customer.ai_enabled, 1, "ลูกค้ายังต้องแจ้งชื่อก่อน = ยังไม่มีอะไรถูกส่งมอบ");
  assert.ok(!auditActions(db, "U-k2-conditional").includes("booking_handoff"));
  db.close();
});

test("K2 เข้ม: ใบ้ครบ แต่คำตอบเป็นคำสุภาพประจำร้าน -> ห้ามปิดห้อง", async () => {
  const { db, customer } = await runTurn({
    reply: COURTESY_REPLY, text: "ขอจองไว้ก่อนค่ะ", customerId: "U-k2-courtesy",
  });
  assert.equal(customer.ai_enabled, 1, "\"ทีมงานพร้อมช่วยดูแล\" พูดได้ตั้งแต่ทักทาย ไม่ใช่การส่งมอบเคส");
  db.close();
});

test("K2 เข้ม: ใบ้ครบ + ประโยคส่งไม้ต่อที่พรอมต์กำหนดไว้ -> ปิดห้อง", async () => {
  const { db, customer } = await runTurn({
    reply: DICTATED_BOOKING_REPLY, text: "ขอจองไว้ก่อนค่ะ", customerId: "U-k2-dictated",
  });
  assert.equal(customer.ai_enabled, 0);
  assert.equal(customer.ai_off_reason, "booking_handoff");
  db.close();
});

test("K2 เข้ม: ขอติดต่อทีมงาน + ประโยคที่พรอมต์กำหนดไว้ -> ปิดห้องด้วยเหตุ human_requested", async () => {
  const { db, customer } = await runTurn({
    reply: DICTATED_CONTACT_REPLY, text: "ขอเบอร์ทีมงานหน่อยค่ะ", customerId: "U-k2-contact",
  });
  assert.equal(customer.ai_enabled, 0);
  assert.equal(customer.ai_off_reason, "human_requested");
  db.close();
});

test("K1 (R4): คำสั่งซื้อที่บอกว่าจองอะไร + ส่งไม้ต่อจริง -> ปิดห้อง", async () => {
  const { db, customer } = await runTurn({
    reply: DICTATED_BOOKING_REPLY,
    text: "ขอสมัครคลาส AI Agent for Business ค่ะ",
    customerId: "U-k1-object",
  });
  assert.equal(customer.ai_enabled, 0, "รอบสองอ่านรูปประโยคนี้ไม่ออกทั้งตระกูล");
  assert.equal(customer.ai_off_reason, "booking_handoff");
  db.close();
});

test("K1 (R3c): ถอนคำพูดในเทิร์นนี้ ล้างใบ้ย้อนหลัง -> ห้ามปิดห้อง", async () => {
  const { db, customer } = await runTurn({
    reply: DICTATED_BOOKING_REPLY,
    text: "ขอคิดดูก่อนนะคะ",
    customerId: "U-k1-retract",
    seed: (database) => {
      database.insertMessage({ customerId: "U-k1-retract", direction: "in", msgType: "text", content: "ขอจองค่ะ" });
      database.insertMessage({ customerId: "U-k1-retract", direction: "out", msgType: "text", content: "ได้เลยค่ะ สนใจรอบไหนดีคะ" });
    },
  });
  assert.equal(customer.ai_enabled, 1, "คนที่เพิ่งบอกว่าขอคิดดูก่อน คือคนที่ follow-up มีค่าที่สุด");
  assert.ok(!auditActions(db, "U-k1-retract").includes("booking_handoff"));
  db.close();
});

test("R3(b): แอดมินคนจริงตอบไปแล้ว = เริ่มช่วงใหม่ ใบ้ก่อนหน้านั้นไม่นับ", async () => {
  const customerId = "U-lookback-human";
  const { db, customer } = await runTurn({
    reply: DICTATED_BOOKING_REPLY,
    text: "รอบ 26 ค่ะ",
    customerId,
    seed: (database) => {
      database.insertMessage({ customerId, direction: "in", msgType: "text", content: "ขอจองค่ะ" });
      // ชมพู่เข้ามาตอบเอง — ตั้งแต่จุดนี้ห้องเป็นของคน ใบ้ของบอทก่อนหน้านี้หมดความหมาย
      database.insertMessage({
        customerId, direction: "out", msgType: "text",
        content: "สวัสดีค่ะ ชมพู่ดูแลต่อเองนะคะ", operator: "chomphu",
      });
    },
  });
  assert.equal(customer.ai_enabled, 1, "หลังคนตอบ ใบ้เก่าต้องไม่ลากห้องไปปิดเอง");
  assert.ok(!auditActions(db, customerId).includes("booking_handoff"));
  db.close();
});

test("R3(a): ใบ้ย้อนหลังต้องไม่หลุดหน้าต่างเพราะมีรูป/สติกเกอร์คั่นเยอะ", async () => {
  const customerId = "U-lookback-noise";
  const { db, customer } = await runTurn({
    reply: DICTATED_BOOKING_REPLY,
    text: "รอบ 26 ค่ะ",
    customerId,
    seed: (database) => {
      database.insertMessage({ customerId, direction: "in", msgType: "text", content: "ขอจองค่ะ" });
      // สิบสองแถวถัดมาไม่มีข้อความขาเข้าเลย — ตัวอ่านรุ่นก่อนอ่าน 12 แถวหลังสุดแล้วมองไม่เห็น
      for (let index = 0; index < 12; index += 1) {
        database.insertMessage({ customerId, direction: "out", msgType: "text", content: `ได้เลยค่ะ (${index})` });
      }
    },
  });
  assert.equal(customer.ai_enabled, 0, "ใบ้ยังอยู่ในหน้าต่าง 24 ชม. และอยู่ใน session เดียวกัน");
  assert.equal(customer.ai_off_reason, "booking_handoff");
  db.close();
});

test("R3(d): /reset ล้างใบ้ย้อนหลัง — ข้อความเก่าก่อนรีเซ็ตต้องมองไม่เห็น", async () => {
  const { prepareTrainingResetCommand } = await import("../src/trainingCommands.mjs");
  const customerId = "U-lookback-reset";
  const { app, db } = makeApp({ reply: DICTATED_BOOKING_REPLY });
  db.upsertCustomer(customerId, {});
  db.insertMessage({ customerId, direction: "in", msgType: "text", content: "ขอจองค่ะ" });
  prepareTrainingResetCommand({ db, channelId: "default", customerId, dedupeKey: "reset-1" });
  await app.pipeline.handleInboundText({ customerId, text: "รอบ 26 ค่ะ", replyToken: "rt-reset" });
  assert.equal(db.getCustomer(customerId).ai_enabled, 1, "บทสนทนาใหม่ต้องไม่ถูกปิดด้วยใบ้ของรอบก่อน");
  db.close();
});

test("R3(d): คนกดเปิด AI คืนในคอนโซล -> ใบ้ก่อนหน้านั้นต้องมองไม่เห็น (ไม่งั้นเปิดคืนไม่ขึ้น)", async (t) => {
  // เดินผ่านเส้นทางจริงของคอนโซล ไม่ใช่เรียกฟังก์ชันปักหมุดตรง ๆ — สิ่งที่ต้องพิสูจน์คือ
  // "ปุ่มที่ชมพู่กด" ล้างใบ้จริง ถ้าเทสต์เรียกฟังก์ชันเอง มันพิสูจน์แค่ว่าฟังก์ชันทำงาน
  const db = memoryDb();
  db.setApprovedPrice("ราคา-12900", 12900);
  db.createOperator({ username: "nok", passHash: hashPassword("operator-pass-123"), displayName: "พี่นก" });
  const customerId = "U-console-reenable";
  db.upsertCustomer(customerId, {});
  db.insertMessage({ customerId, direction: "in", msgType: "text", content: "ขอจองค่ะ" });
  db.setAiEnabled(customerId, false, "booking_handoff");

  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "test-console-secret-0123456789" }),
    db,
    overrides: { hermesFetch: hermesFetchStub(DICTATED_BOOKING_REPLY), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const loginRes = await httpRequest(app.server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nok", password: "operator-pass-123" }),
  });
  assert.equal(loginRes.status, 200, `login ต้องผ่าน: ${loginRes.text}`);
  const cookie = (loginRes.headers["set-cookie"]?.[0] || "").split(";")[0];
  const toggle = await httpRequest(app.server, {
    method: "POST", path: `/console/api/customers/${customerId}/ai`,
    headers: { "content-type": "application/json", cookie, "x-csrf-token": loginRes.json.csrf },
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(toggle.status, 200, `เปิด AI คืนต้องผ่าน: ${toggle.text}`);
  assert.equal(db.getCustomer(customerId).ai_enabled, 1);

  await app.pipeline.handleInboundText({ customerId, text: "รอบ 26 ค่ะ", replyToken: "rt-reenable" });
  assert.equal(db.getCustomer(customerId).ai_enabled, 1,
    "ถ้าใบ้เก่ายังนับ ห้องจะถูกปิดซ้ำทันทีในข้อความแรกหลังเปิดคืน — ลูปที่คนกดเปิดไม่มีทางชนะ");
});

test("R6: ขอติดต่อทีมงานกลางการเก็บ slot งาน project -> ปิดได้เมื่อลูกแพรส่งไม้ต่อจริง", async () => {
  const policy = validateSalesPolicy({
    schemaVersion: 1,
    businessId: "pngoung-tidkradum",
    customerJourneys: ["new_lead"],
    decisionRoles: ["owner"],
    routingPrior: { dominantInterest: "ai", share: 0.99, publicClaimAuthorized: false },
    courses: [{ id: "ai-agent-business", type: "group_live", name: "AI Agent for Business", aliases: ["AI Basic"] }],
    opportunities: [
      { type: "in_house_training", requiredSlots: ["organization_context", "audience_size"], optionalSlots: [], upsize: true, handoffOnComplete: true },
    ],
  });
  const { app, db } = makeApp({ reply: DICTATED_CONTACT_REPLY, salesPolicy: policy });
  const customerId = "U-project-contact";
  db.upsertCustomer(customerId, {});
  db.insertMessage({ customerId, direction: "in", msgType: "text", content: "อยากจัดอบรมพนักงานในบริษัทครับ" });
  await app.pipeline.handleInboundText({
    customerId, text: "ขอเบอร์ทีมงานหน่อยครับ อยากจัดอบรมพนักงานที่บริษัท", replyToken: "rt-proj",
  });
  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_enabled, 0, "ลีดองค์กรที่ขอเบอร์คนจริง ไม่ควรถูกไล่ถาม slot ต่อ");
  assert.equal(customer.ai_off_reason, "human_requested");
  db.close();
});

test("R6: งาน project + ลูกค้าขอใบเสนอราคา (ฝั่งจอง) ยังต้องปล่อยให้ flow เก็บ slot ทำงาน", async () => {
  const policy = validateSalesPolicy({
    schemaVersion: 1,
    businessId: "pngoung-tidkradum",
    customerJourneys: ["new_lead"],
    decisionRoles: ["owner"],
    routingPrior: { dominantInterest: "ai", share: 0.99, publicClaimAuthorized: false },
    courses: [{ id: "ai-agent-business", type: "group_live", name: "AI Agent for Business", aliases: ["AI Basic"] }],
    opportunities: [
      { type: "in_house_training", requiredSlots: ["organization_context", "audience_size"], optionalSlots: [], upsize: true, handoffOnComplete: true },
    ],
  });
  const { app, db } = makeApp({ reply: DICTATED_BOOKING_REPLY, salesPolicy: policy });
  const customerId = "U-project-quote";
  db.upsertCustomer(customerId, {});
  await app.pipeline.handleInboundText({
    customerId, text: "อยากจัดอบรมพนักงานที่บริษัท ขอใบเสนอราคาค่ะ", replyToken: "rt-proj2",
  });
  assert.equal(db.getCustomer(customerId).ai_enabled, 1,
    "ปิดก่อนได้ slot = ทีมได้ใบสั่งงานที่ไม่มีข้อมูลอะไรเลย");
  db.close();
});

/* ---- R5: ดราฟต์ที่ถูกกู้บางส่วน — ตั้งใจไม่ปิดห้อง (บันทึกไว้เป็นสัญญา ไม่ใช่อุบัติเหตุ) ---- */

test("R5: guard ตัดบางประโยคทิ้งแล้วส่งที่เหลือ -> ห้ามปิดห้อง (ยอมรับสภาพไว้ก่อนโดยตั้งใจ)", async () => {
  // ประโยคแรกมีตัวเลขนอกตารางอนุมัติ (ถูกตัด) ประโยคที่สองเป็นการส่งไม้ต่อ (รอด)
  const reply = [
    "คลาสนี้ราคา 7,777 บาทค่ะ",
    "รับทราบค่ะ ทีมงาน (คุณชมพู่) จะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ",
  ].join("\n\n");
  const { app, db } = makeApp({ reply });
  const customerId = "U-partial-block";
  const result = await app.pipeline.handleInboundText({ customerId, text: "ขอจองไว้ก่อนค่ะ", replyToken: "rt-pb" });
  assert.equal(result.sent, true, "ลูกค้ายังต้องได้รับคำตอบ");
  const customer = db.getCustomer(customerId);
  assert.equal(customer.ai_enabled, 1,
    "คำตอบที่ถูกด่านตัดไปแล้วอาจไม่ครบความหมาย — ปล่อยให้เทิร์นหน้าเป็นคนปิดปลอดภัยกว่า");
  assert.ok(!auditActions(db, customerId).includes("booking_handoff"));
  db.close();
});
