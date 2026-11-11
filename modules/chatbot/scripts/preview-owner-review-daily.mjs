// preview-owner-review-daily.mjs — คิวตรวจแชทรายวันจำลองสำหรับพรีวิวหน้าตา (#/owner-review/daily · เฟส B · 12 ต.ค. 2026)
//
// ใช้จาก scripts/preview-lukprae-ui.mjs (และเทสต์ owner-review-daily-ui) — ทุกชื่อ/ข้อความแต่งขึ้นทั้งหมด (SYNTHETIC)
// ไม่ยิง LuNa/Hermes: เขียนผลตรวจของ AI ลงฐานตรง ๆ ด้วยเมธอดเดียวกับตัวเดินรอบ (saveOwnerReviewItemReview ฯลฯ)
//   mode "ready"    = คิวของคืนล่าสุดพร้อมแล้ว 9 ห้อง (น่าห่วง 2 · AI ไม่ได้อ่าน 1 · สุ่มตรวจ 1 · ทีมงานตอบแทรก 1) + วันก่อนค้าง 2 ห้อง
//   mode "building" = คิวคืนล่าสุดกำลังเตรียม (AI อ่านไปบางห้อง) ยังไม่มีคิวพร้อม
//   mode "none"     = ไม่สร้างอะไร (หน้า "ยังไม่มีคิวตรวจแชท")
import { OWNER_REVIEW_STARTED_DAY_KEY, bangkokDayKey, shiftDayKey } from "../src/ownerReviewTaper.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// [ชื่อ, ช่องทาง, ผลตรวจ AI, บทสนทนา [ทิศ, ข้อความ, นาทีก่อนตัดรอบ, ผู้ตอบ(ai|team|step), ปัญหา?, ชนิดข้อความ?]]
//   step = ข้อความต้อนรับที่ตั้งไว้ (อัตโนมัติ — แตะแก้ไม่ได้) · ชนิด image = รูปจากคลังที่ลูกแพรส่ง ("[image:key] https://…")
const TODAY_ROOMS = [
  {
    key: "price", name: "ธนพร · ร้านเค้กโฮมเมด", risk: 88, summary: "ลูกค้าถามราคาคลาส ลูกแพรตอบราคาเก่าและไม่บอกว่าได้อะไร",
    context: ["in", "เมื่อวานทักไว้เรื่องคลาสออนไลน์ค่ะ", 26 * 60],
    turns: [
      ["in", "คลาส AI Agent for Business ราคาเท่าไหร่คะ", 300],
      ["out", "คลาสละ 9,900 บาทค่ะ", 299, "ai", [["wrong_price", "ราคาไม่ตรงกับรอบเดือนนี้"], ["no_value_before_price", "บอกราคาแต่ไม่บอกว่าได้อะไร"]]],
      ["in", "รวมอะไรบ้างคะ มีเรียนย้อนหลังไหม", 280],
      ["out", "มีค่ะ ลูกแพรขอเช็กรายละเอียดรอบเรียนให้ก่อนนะคะ ยังยืนยันไม่ได้ค่ะ", 279, "ai", [["hedge_word", "ใช้คำไม่มั่นใจ"]]],
    ],
  },
  {
    key: "slip", name: "วรพล · โรงงานพลาสติก", risk: 72, summary: "ลูกค้าแจ้งโอนแล้ว ลูกแพรตอบเองแทนที่จะส่งต่อทีม",
    turns: [
      ["in", "โอนมัดจำแล้วนะครับ เดี๋ยวส่งสลิปให้", 240],
      ["out", "ขอบคุณค่ะ ลูกแพรบันทึกให้เรียบร้อยแล้วนะคะ ที่นั่งของคุณวรพลยืนยันแล้วค่ะ", 239, "ai", [["missed_handoff", "เรื่องเงินที่โอนแล้วควรส่งต่อทีม"], ["promise_risk", "ยืนยันที่นั่งก่อนตรวจสลิป"]]],
    ],
  },
  {
    key: "curt", name: "กานดา · คลินิกทันตกรรม", risk: 45, summary: "ตอบถูกแต่ห้วน เหมือนบอท",
    turns: [
      ["in", "สวัสดีค่ะ อยากให้พนักงานหน้าร้านใช้ AI ตอบแชทคนไข้ได้ไหมคะ", 200],
      ["out", "ได้ค่ะ", 199, "ai", [["curt_or_robotic", "ตอบสั้นเกินไป ไม่ชวนคุยต่อ"]]],
      ["in", "แล้วต้องเริ่มยังไงคะ", 190],
      ["out", "ลงคลาสค่ะ", 189, "ai", []],
    ],
  },
  {
    key: "team", name: "ปิยะนุช · ร้านดอกไม้", risk: 15, summary: "ตอบครบ ทีมงานช่วยตอบเรื่องใบเสร็จต่อ",
    turns: [
      ["in", "ขอใบเสร็จในนามบริษัทได้ไหมคะ", 180],
      ["out", "ได้ค่ะ ลูกแพรส่งเรื่องให้ทีมงานดูแลต่อนะคะ", 179, "ai", []],
      ["out", "สวัสดีค่ะ ชมพู่นะคะ ส่งชื่อบริษัทกับเลขผู้เสียภาษีมาได้เลยค่ะ", 160, "team", []],
      ["in", "ขอบคุณค่ะ", 150],
    ],
  },
  {
    key: "unread", name: "เอกชัย · บริษัทขนส่ง", aiStatus: "failed", summary: "",
    turns: [
      ["in", "มีคลาสสำหรับทีมขาย 15 คนไหมครับ", 140],
      ["out", "มีค่ะ คลาส in-house ปรับเนื้อหาตามงานของทีมได้เลยค่ะ ขอทราบช่วงเวลาที่สะดวกได้ไหมคะ", 139, "ai", []],
    ],
  },
  {
    key: "sample", name: "สุนิสา · ร้านกาแฟสองสาขา", risk: 8, sampled: true, summary: "ถามรอบเรียนถัดไป ตอบครบพร้อมชวนจอง",
    turns: [
      ["out", "สวัสดีค่ะ ขอบคุณที่แอดไลน์พี่ง้วง ติดกระดุมนะคะ", 125, "step"],
      ["in", "รอบถัดไปวันไหนคะ", 120],
      ["out", "รอบถัดไปเสาร์ที่ 24 ค่ะ เรียนสด 2 วัน ได้ลงมือทำบอทกับเมนูของร้านเองเลยนะคะ", 119, "ai", []],
    ],
  },
  {
    key: "repeat", name: "ภูมิ · สตาร์ทอัพ", risk: 32, summary: "ตอบดี แต่ถามชื่อธุรกิจซ้ำ",
    turns: [
      ["in", "ทำแอปจองคิวร้านตัดผมครับ สนใจใช้ AI ตอบลูกค้า", 100],
      ["out", "ยินดีค่ะ ขอถามนิดนึงนะคะ ตอนนี้ทำธุรกิจอะไรอยู่คะ", 99, "ai", [["repeated_question", "ลูกค้าบอกธุรกิจไปแล้ว"]]],
    ],
  },
  {
    key: "fine1", name: "อรทัย · โรงเรียนกวดวิชา", risk: 5, summary: "ตอบครบ สุภาพ",
    turns: [
      ["in", "ไม่มีพื้นฐานเขียนโค้ดเรียนได้ไหมคะ", 80],
      ["out", "เรียนได้ค่ะ ทุกขั้นตอนทำตามได้ในห้องเรียน ไม่ต้องเขียนโค้ดเลยนะคะ", 79, "ai", []],
    ],
  },
  {
    key: "fine2", name: "ชัยวัฒน์ · ร้านอาหารอีสาน", risk: 10, summary: "ตอบครบ ส่งตารางเรียนตามที่ขอ",
    turns: [
      ["in", "ขอตารางเรียนเดือนหน้าครับ", 60],
      ["out", "[image:class-schedule-next-month] https://pngoungacademy.com/static/preview/class-schedule.jpg", 59.5, "ai", [], "image"],
      ["out", "ส่งให้แล้วนะคะ เดือนหน้ามี 2 รอบ เสาร์ที่ 7 กับ 21 ค่ะ", 59, "ai", []],
    ],
  },
];

const BACKLOG_ROOMS = [
  { key: "old1", name: "มาลี · ร้านเสื้อผ้า", risk: 64, summary: "ตอบยาวเกินแชท", label: "needs_fix",
    turns: [["in", "สอนทำโพสต์ขายของด้วยไหมคะ", 300], ["out", "สอนค่ะ ".repeat(30).trim(), 299, "ai", [["over_long", "ยาวเกินไปสำหรับแชท"]]]] },
  { key: "old2", name: "สมศักดิ์ · อู่ซ่อมรถ", risk: 12, summary: "ตอบครบ",
    turns: [["in", "เรียนกี่ชั่วโมงครับ", 200], ["out", "เรียนสด 2 วัน วันละ 6 ชั่วโมงค่ะ", 199, "ai", []]] },
  { key: "old3", name: "นงลักษณ์ · ร้านขนม", risk: 20, summary: "ตอบครบ",
    turns: [["in", "มีผ่อนไหมคะ", 150], ["out", "ผ่อนได้ 0% 3 เดือนค่ะ", 149, "ai", []]] },
];

/** 20:00 เวลาไทยล่าสุดที่ผ่านมาแล้ว (≤ now) */
export function lastDailyCutoff(now) {
  const bkk = now + 7 * HOUR;
  const dayStart = bkk - (bkk % DAY) - 7 * HOUR;
  const today = dayStart + 20 * HOUR;
  return now >= today ? today : today - DAY;
}

function writeRooms(db, at, rooms, cutoff, prefix) {
  const made = new Map();
  rooms.forEach((room, index) => {
    const id = `demo-odr-${prefix}-${index + 1}`;
    at(cutoff - 3 * DAY, () => db.upsertCustomer(id, { displayName: room.name }));
    if (room.context) at(cutoff - room.context[2] * MIN, () => db.insertMessage({ customerId: id, direction: "in", content: room.context[1] }));
    const issues = [];
    for (const [direction, content, minsBefore, by = "ai", problems = [], msgType = "text"] of room.turns) {
      const team = direction === "out" && by === "team";
      const step = direction === "out" && by === "step";
      const messageId = at(cutoff - minsBefore * MIN, () => db.insertMessage({
        customerId: id, direction, content, msgType, operator: team ? "demo-admin" : "",
        agentMode: direction === "out" ? (team ? "operator_ai_on" : step ? "step_message" : "ai") : null,
        ...(step ? { messageClass: "proactive" } : {}),
      }));
      for (const [code, note] of problems) issues.push({ code, messageId: String(messageId), note });
    }
    made.set(id, { room, issues });
  });
  return made;
}

/** สร้างรอบหนึ่งรอบจากห้องจำลอง — ลบห้องอื่นของพรีวิวที่ลูกแพรเคยตอบในช่วงเดียวกันออกจากคิวนี้ (พรีวิวอยากได้ 9 ห้องพอดี) */
function buildBatch(db, at, rooms, { cutoff, prefix, status, reviewUntil = rooms.length }) {
  const made = writeRooms(db, at, rooms, cutoff, prefix);
  const batch = at(cutoff, () => db.claimOwnerReviewBatch({ kind: "daily", slotMs: cutoff, windowStartMs: cutoff - DAY, windowEndMs: cutoff }));
  if (!batch) return null;
  db.insertOwnerReviewItemsForBatch(batch, { dayKey: bangkokDayKey(cutoff) });
  db.raw.prepare("DELETE FROM owner_review_items WHERE batch_id = ? AND customer_id NOT LIKE ?").run(batch.id, `demo-odr-${prefix}-%`);
  const items = new Map(db.ownerReviewItemsForBatch(batch.id).map((item) => [item.customer_id, item]));
  [...made.entries()].forEach(([customerId, { room, issues }], index) => {
    const item = items.get(customerId);
    if (!item || index >= reviewUntil) return;
    const aiStatus = room.aiStatus || "done";
    db.saveOwnerReviewItemReview(item.id, { aiStatus, risk: aiStatus === "done" ? room.risk : null, summary: room.summary, issues: aiStatus === "done" ? issues : [] });
    const flagged = aiStatus === "done" && (room.risk >= 60 || issues.some((row) => ["wrong_price", "wrong_fact", "promise_risk", "missed_handoff"].includes(row.code)));
    db.setOwnerReviewItemInclusion(item.id, { flagged, sampled: Boolean(room.sampled) && !flagged, included: "all" });
  });
  db.updateOwnerReviewBatch(batch.id, {
    status, ...(status === "ready" ? { readyAt: cutoff + 25 * MIN } : {}),
    counts: { populated: true, rooms: rooms.length, reviewed: Math.min(reviewUntil, rooms.length), taper: { level: 0, reason: "warmup" } },
  });
  return { batch, made, items };
}

/**
 * db = memoryDb ของพรีวิว · at(ms, fn) = เขียนด้วยนาฬิกาที่เลื่อนได้ · now = เวลาจริง
 * คืน { cutoff, batchId, backlogId } (ว่างถ้า mode none)
 */
export function seedPreviewDailyReview({ db, at, now = Date.now(), mode = "ready" }) {
  if (mode === "none") return {};
  const cutoff = lastDailyCutoff(now);
  // สัปดาห์แรกวันที่ 3 — แถบระดับขึ้น "วันที่ 3/7"
  db.setSetting(OWNER_REVIEW_STARTED_DAY_KEY, shiftDayKey(bangkokDayKey(now), -2));
  if (mode === "building") {
    const today = buildBatch(db, at, TODAY_ROOMS, { cutoff, prefix: "t", status: "building", reviewUntil: 4 });
    return { cutoff, batchId: today?.batch.id ?? "" };
  }
  const backlog = buildBatch(db, at, BACKLOG_ROOMS, { cutoff: cutoff - DAY, prefix: "y", status: "ready" });
  // วันก่อน: ตรวจไปแล้ว 1 ห้อง (มาลี = ต้องปรับ) เหลือค้าง 2 ห้อง → ชิป "ยังค้าง"
  for (const [customerId, { room }] of backlog?.made || []) {
    const item = backlog.items.get(customerId);
    if (!item || !room.label) continue;
    db.casOwnerReviewItemLabel(item.id, { expectedRevision: Number(item.revision) || 0, label: room.label, note: "", via: "single", by: "demo-owner", at: cutoff - DAY + 2 * HOUR });
  }
  const today = buildBatch(db, at, TODAY_ROOMS, { cutoff, prefix: "t", status: "ready" });
  return { cutoff, batchId: today?.batch.id ?? "", backlogId: backlog?.batch.id ?? "" };
}
