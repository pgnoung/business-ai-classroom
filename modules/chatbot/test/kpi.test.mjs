// นิยาม KPI ต้องแม่น (คำสั่งพี่ง้วง 1 ก.ย. 2026)
// KPI ที่นิยามเพี้ยนอันตรายกว่าไม่มี KPI เพราะคนจะตัดสินใจจากมัน
import test from "node:test";
import assert from "node:assert/strict";
import {
  senderOf, responsePairs, classifyRoom, roomIsClosed, percentile,
  inWorkingHours, summarizeKpi,
  BACKLOG_MAX_AGE_MS,
} from "../src/kpi.mjs";

const MIN = 60_000;
// 2026-09-01 10:00 เวลาไทย (เลขคงที่ ไม่พึ่งนาฬิกาเครื่อง)
const T10 = Math.floor(Date.UTC(2026, 8, 1, 3, 0, 0) / 1000) * 1000;
const at = (offsetMin) => T10 + offsetMin * MIN;

const inMsg = (offsetMin) => ({ direction: "in", created_at: at(offsetMin) });
const aiMsg = (offsetMin) => ({ direction: "out", agent_mode: "ai", operator: "", created_at: at(offsetMin) });
const humanMsg = (offsetMin) => ({ direction: "out", agent_mode: "operator_ai_off", operator: "ชมพู่", created_at: at(offsetMin) });
const followupMsg = (offsetMin) => ({ ...aiMsg(offsetMin), message_class: "proactive" });

test("แยกออกว่าข้อความขาออกใครส่ง รวมถึงแถวเก่าที่ยังไม่มีป้าย", () => {
  assert.equal(senderOf(aiMsg(0)), "ai");
  assert.equal(senderOf(humanMsg(0)), "human");
  assert.equal(senderOf({ direction: "out", agent_mode: "operator_ai_on", operator: "ชมพู่" }), "human");
  assert.equal(senderOf({ direction: "out", agent_mode: null, operator: "ชมพู่" }), "human", "แถวเก่ามีชื่อคน = คน");
  assert.equal(senderOf({ direction: "out", agent_mode: null, operator: "" }), null, "แถวเก่าไม่มีป้ายเลย = ไม่นับ");
});

test("ลูกค้าพิมพ์รัวหลายข้อความ นับเป็นหนึ่งตา และจับเวลาจากข้อความแรก", () => {
  const pairs = responsePairs([inMsg(0), inMsg(1), inMsg(2), aiMsg(5)]);
  assert.equal(pairs.length, 1, "สามข้อความติดกัน = หนึ่งตา");
  assert.equal(pairs[0].waitedMs, 5 * MIN, "ต้องนับจากตอนที่เขาเริ่มรอ ไม่ใช่ข้อความสุดท้าย");
  assert.equal(pairs[0].by, "ai");
});

test("follow-up ไม่ใช่การตอบ — ห้ามนับเป็นความเร็วตอบ และห้ามปิดตาที่ลูกค้ายังรออยู่", () => {
  const pairs = responsePairs([inMsg(0), followupMsg(10), humanMsg(30)]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].by, "human");
  assert.equal(pairs[0].waitedMs, 30 * MIN, "ถ้านับ follow-up เป็นการตอบ ตัวเลขจะสวยเกินจริง");
});

test("ข้อความที่บอทส่งโดยลูกค้าไม่ได้ถามก่อน ไม่นับเป็นการตอบ", () => {
  assert.deepEqual(responsePairs([aiMsg(0), aiMsg(1)]), []);
});

test("จำแนกห้องได้ถูกทั้งสี่แบบ", () => {
  assert.equal(classifyRoom([inMsg(0), aiMsg(1)]), "ai");
  assert.equal(classifyRoom([inMsg(0), humanMsg(1)]), "human");
  assert.equal(classifyRoom([inMsg(0), aiMsg(1), humanMsg(2)]), "hybrid");
  assert.equal(classifyRoom([inMsg(0)]), "none", "ยังไม่มีใครตอบ");
});

test("นิยาม 'ปิดการขาย' ตามที่พี่ง้วงกำหนด", () => {
  assert.equal(roomIsClosed({ ai_off_reason: "bank_sent" }), true, "ส่งเลขบัญชีแล้ว");
  assert.equal(roomIsClosed({ ai_off_reason: "handoff_private_inhouse" }), true, "ส่งรายละเอียด private/in-house แล้ว");
  assert.equal(roomIsClosed({ deal_status: "awaiting_payment" }), true);
  assert.equal(roomIsClosed({ ai_off_reason: "money_line" }), false, "แตะเรื่องเงินยังไม่ใช่ปิดการขาย");
  assert.equal(roomIsClosed({ ai_off_reason: "fb_human_replying" }), false);
  assert.equal(roomIsClosed({}), false);
});

test("ใช้ค่ากลาง ไม่ใช่ค่าเฉลี่ย — เคสตอบข้ามคืนต้องไม่ลากตัวเลขทั้งชุด", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 1000], 50), 3, "ค่าเฉลี่ยจะเป็น 202 ซึ่งไม่สะท้อนอะไรเลย");
  assert.equal(percentile([1, 2, 3, 4, 1000], 90), 1000);
  assert.equal(percentile([], 50), null);
});

test("เวลาทำการ 09:00–21:00 เวลาไทย", () => {
  assert.equal(inWorkingHours(T10), true, "10:00 = เวลาทำการ");
  assert.equal(inWorkingHours(at(-90)), false, "08:30 = นอกเวลา");
  assert.equal(inWorkingHours(at(12 * 60)), false, "22:00 = นอกเวลา");
});

test("สรุปรวม: ความเร็ว แชทค้าง และ % ปิดการขายเฉพาะ Hybrid กับ AI ล้วน", () => {
  const rooms = [
    // AI ล้วน ปิดได้ (ส่งเลขบัญชี)
    { customer: { line_user_id: "u1", ai_enabled: 0, ai_off_reason: "bank_sent" },
      messages: [inMsg(0), aiMsg(2)] },
    // AI ล้วน ยังไม่ปิด
    { customer: { line_user_id: "u2", ai_enabled: 1 }, messages: [inMsg(0), aiMsg(1)] },
    // Hybrid ปิดได้
    { customer: { line_user_id: "u3", ai_enabled: 1, deal_status: "awaiting_payment" },
      messages: [inMsg(0), aiMsg(4), inMsg(10), humanMsg(70)] },
    // คนล้วน ปิดได้ — ต้องไม่โผล่เป็น % ให้เอาไปเทียบ
    { customer: { line_user_id: "u4", ai_enabled: 0, ai_off_reason: "handoff_private_inhouse" },
      messages: [inMsg(0), humanMsg(20)] },
    // ลูกค้าพิมพ์ค้างไว้ ไม่มีใครตอบ
    { customer: { line_user_id: "u5", ai_enabled: 0, ai_off_reason: "fb_human_replying" },
      messages: [inMsg(-300)] },
  ];
  const kpi = summarizeKpi({ rooms, nowMs: at(0) });

  assert.equal(kpi.speed.all.ai.count, 3, "AI ตอบ 3 ตา");
  assert.equal(kpi.speed.all.ai.medianMs, 2 * MIN);
  assert.equal(kpi.speed.all.human.count, 2);
  assert.equal(kpi.speed.all.human.medianMs, 20 * MIN);

  assert.equal(kpi.backlog.total, 1);
  assert.equal(kpi.backlog.buckets.find((b) => b.key === "over8h").rooms, 0);
  assert.equal(kpi.backlog.buckets.find((b) => b.key === "under8h").rooms, 1, "รอมา 5 ชม.");
  assert.equal(kpi.backlog.waitingForHuman, 1, "AI ปิดอยู่ = ต้องมีคนไปตอบ");

  assert.deepEqual(kpi.closing.fullyAi, { rooms: 2, closed: 1, ratePct: 50 });
  assert.deepEqual(kpi.closing.hybrid, { rooms: 1, closed: 1, ratePct: 100 });
  assert.equal(kpi.closing.humanOnlyRooms, 1);
  assert.equal(kpi.closing.humanOnlyClosed, 1);
  assert.equal(kpi.closing.ratePct, undefined, "ห้ามมี % รวมให้เอาไปเทียบข้ามกลุ่ม");
  assert.equal(kpi.closing.noReplyRooms, 1);
});

test("ไม่มีข้อมูลต้องคืน null ไม่ใช่ 0 — 0 อ่านว่า 'ตอบทันที' ซึ่งหลอกตา", () => {
  const kpi = summarizeKpi({ rooms: [], nowMs: T10 });
  assert.equal(kpi.speed.all.ai.medianMs, null);
  assert.equal(kpi.closing.fullyAi.ratePct, null);
  assert.equal(kpi.totals.rooms, 0);
});

/* ---- ตรวจกับของจริง 1 ก.ย. 2026: นิยาม "แชทค้าง" เดิมนับของที่ไม่ใช่งาน ----
 * ได้ 58 ห้อง แต่ 37 ห้องเงียบเกิน 7 วัน (คุยจบไปแล้ว) และห้องที่ค้างนานสุดคือข้อความ
 * "#FOUNDER" ซึ่งระบบตั้งใจไม่ตอบ ปล่อยให้ LINE OA จัดการ — ตัวเลขแบบนั้นทีมจะเลิกสนใจ
 */
const hashMsg = (offsetMin) => ({ direction: "in", created_at: at(offsetMin), is_hashtag: 1 });

test("แฮชแท็กที่ระบบตั้งใจเงียบ ต้องไม่ถูกนับเป็นแชทค้าง", () => {
  const kpi = summarizeKpi({
    rooms: [{ customer: { line_user_id: "u1", ai_enabled: 1 }, messages: [hashMsg(-60)] }],
    nowMs: at(0),
  });
  assert.equal(kpi.backlog.total, 0, "#FOUNDER ไม่ใช่คนรอคำตอบ");
  assert.equal(kpi.backlog.excluded.hashtagRooms, 1, "ต้องบอกด้วยว่าตัดออกกี่ห้อง ไม่ซ่อน");
});

test("แฮชแท็กต้องไม่ทำให้ตัวเลขความเร็วตอบเพี้ยน", () => {
  // ลูกค้าส่งแฮชแท็กก่อน แล้วค่อยถามจริง — เวลารอต้องนับจากคำถามจริงเท่านั้น
  const pairs = responsePairs([hashMsg(0), inMsg(50), aiMsg(51)]);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].waitedMs, 1 * MIN, "ถ้านับจากแฮชแท็กจะกลายเป็นรอ 51 นาที ทั้งที่ตอบใน 1 นาที");
});

test("บทสนทนาที่จบไปแล้วไม่ใช่งานค้าง แต่ต้องบอกจำนวนให้เห็น", () => {
  const old = -(BACKLOG_MAX_AGE_MS / MIN) - 60; // เกินเพดานไป 1 ชม.
  const kpi = summarizeKpi({
    rooms: [
      { customer: { line_user_id: "u1", ai_enabled: 1 }, messages: [{ direction: "in", created_at: at(old) }] },
      { customer: { line_user_id: "u2", ai_enabled: 1 }, messages: [inMsg(-30)] },
    ],
    nowMs: at(0),
  });
  assert.equal(kpi.backlog.total, 1, "เหลือเฉพาะห้องที่ยังลงมือทัน");
  assert.equal(kpi.backlog.excluded.endedRooms, 1);
  assert.equal(kpi.backlog.excluded.maxAgeHours, 48);
});

/* ---- ไม่นับวันที่ทีมไม่ได้ทำงาน (คำสั่งพี่ง้วง 1 ก.ย. 2026) ----
 * กฎที่พี่ง้วงให้: เช้า 09:00-11:00 ไม่มีใครในทีมตอบเลย = วันนั้นชมพู่หยุด
 * ดีกว่ารายชื่อวันหยุดตายตัวเพราะจับวันนักขัตฤกษ์/วันลา/วันหยุดชดเชยได้เอง
 */
// 2026-09-06 เป็นวันอาทิตย์ · 2026-09-07 เป็นวันจันทร์
const SUN_10 = Date.UTC(2026, 8, 6, 3, 0, 0);
const MON_10 = Date.UTC(2026, 8, 7, 3, 0, 0);
const atDay = (base, offsetMin) => base + offsetMin * MIN;

test("วันอาทิตย์ไม่นับเข้า KPI ของทีม", () => {
  const kpi = summarizeKpi({
    rooms: [{ customer: { line_user_id: "u1" }, messages: [
      { direction: "in", created_at: SUN_10 },
      { direction: "out", agent_mode: "operator_ai_off", operator: "ชมพู่", created_at: atDay(SUN_10, 60) },
      { direction: "in", created_at: MON_10 },
      { direction: "out", agent_mode: "operator_ai_off", operator: "ชมพู่", created_at: atDay(MON_10, 5) },
    ] }],
    nowMs: atDay(MON_10, 600),
  });
  assert.equal(kpi.speed.workingHours.human.count, 2, "ชุดเวลาทำการยังนับทั้งสองวัน");
  assert.equal(kpi.speed.workingDays.human.count, 1, "ชุดวันทำงานต้องเหลือแค่วันจันทร์");
  assert.equal(kpi.speed.workingDays.human.medianMs, 5 * MIN, "ต้องไม่โดนวันอาทิตย์ 60 นาทีลาก");
  assert.ok(kpi.days.excluded.some((d) => d.key === "2026-09-06" && d.reason === "วันอาทิตย์"));
});

test("วันที่เช้าไม่มีใครในทีมตอบเลย = ทีมหยุด ไม่นับ", () => {
  const kpi = summarizeKpi({
    rooms: [{ customer: { line_user_id: "u1" }, messages: [
      // จันทร์: ลูกค้าถามตอนเช้า แต่มีแต่ AI ตอบ ไม่มีคนเลย -> ถือว่าทีมหยุด
      { direction: "in", created_at: MON_10 },
      { direction: "out", agent_mode: "ai", created_at: atDay(MON_10, 1) },
    ] }],
    nowMs: atDay(MON_10, 600),
  });
  assert.ok(kpi.days.excluded.some((d) => d.reason === "ทีมหยุด (เช้าไม่มีใครตอบ)"));
  assert.equal(kpi.speed.workingDays.ai.count, 0, "วันที่ทีมหยุด ไม่เอามาเทียบผลงาน");
});

test("เช้าไม่มีลูกค้าทักเลย ไม่ใช่หลักฐานว่าทีมหยุด — ห้ามตัดวันทำงานจริงทิ้ง", () => {
  const AFTERNOON = atDay(MON_10, 4 * 60); // 14:00
  const kpi = summarizeKpi({
    rooms: [{ customer: { line_user_id: "u1" }, messages: [
      { direction: "in", created_at: AFTERNOON },
      { direction: "out", agent_mode: "operator_ai_off", operator: "ชมพู่", created_at: AFTERNOON + 3 * MIN },
    ] }],
    nowMs: atDay(MON_10, 600),
  });
  assert.deepEqual(kpi.days.excluded, [], "เช้าเงียบเพราะไม่มีใครถาม ไม่ใช่เพราะทีมหยุด");
  assert.equal(kpi.speed.workingDays.human.count, 1, "งานบ่ายของวันนั้นต้องยังถูกนับ");
});

test("วันหยุดนักขัตฤกษ์ที่กรอกไว้เอง ต้องถูกตัดด้วย", () => {
  const kpi = summarizeKpi({
    rooms: [{ customer: { line_user_id: "u1" }, messages: [
      { direction: "in", created_at: MON_10 },
      { direction: "out", agent_mode: "operator_ai_off", operator: "ชมพู่", created_at: atDay(MON_10, 5) },
    ] }],
    nowMs: atDay(MON_10, 600),
    holidays: new Set(["2026-09-07"]),
  });
  assert.equal(kpi.speed.workingDays.human.count, 0);
  assert.ok(kpi.days.excluded.some((d) => d.reason === "วันหยุดนักขัตฤกษ์"));
});
