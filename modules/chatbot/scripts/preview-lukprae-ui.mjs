// preview-lukprae-ui.mjs — คอนโซลจำลองสำหรับตรวจหน้าตาธีมลูกแพร (loopback เท่านั้น)
//
// ทุกชื่อ ข้อความ ยอดเงิน และออเดอร์ในไฟล์นี้แต่งขึ้นทั้งหมด (SYNTHETIC) — ไม่มีข้อมูลลูกค้าจริง
// ไม่มีกุญแจ ไม่ยิง LINE/Hermes จริง (poisonGlobalFetch + stub) และฟังเฉพาะ 127.0.0.1
//
// ใช้:  node scripts/preview-lukprae-ui.mjs            → http://127.0.0.1:4898/console
//       PREVIEW_SCENE=calm   ไม่มีใครรอคน (ลูกแพรยิ้มสบาย ๆ)
//       PREVIEW_SCENE=busy   มีคนรอนาน + สลิปน่าสงสัย (ลูกแพรตกใจ)
//       PREVIEW_INTRO=1      เปิดเมนู Intro (ตั้งค่า console_intro_enabled)
//       PREVIEW_THEME=airdog ดูธีมตั้งต้นของ instance อื่น (กันธีมอื่นพัง)
//       ห้องตรวจ: http://127.0.0.1:4898/console/#/owner-review (มือถือ 375px · สลับธีมมืดที่ปุ่มพระจันทร์บนหัว)
//       PREVIEW_OWNER_REVIEW=0  ห้องตรวจ (#/owner-review) ว่าง — ค่าเริ่มต้นมีห้องรอยืนยันปิด 4 ห้อง
//       PREVIEW_OWNER_SWEEP=off ตัวคัดกรองรายชั่วโมงปิด (ดูแถบเตือน "ตอนนี้ยังปิดห้องไม่ได้")
//       ตรวจแชทวันนี้: http://127.0.0.1:4898/console/#/owner-review/daily — คิว 20:00 จำลอง 9 ห้อง + วันก่อนค้าง 2 ห้อง
//       PREVIEW_OWNER_DAILY=building คิวกำลังเตรียม (AI อ่าน 4/9) · PREVIEW_OWNER_DAILY=none ยังไม่มีคิว
// บัญชีจำลอง: demo-owner / demo-admin / demo-staff  รหัสผ่าน demo-pass-123456
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { testConfig, memoryDb, lineFetchStub, hermesFetchStub, poisonGlobalFetch } from "../test/helpers.mjs";
import { QUALIFY_SWEEP_MODE_KEY } from "../src/notQualified.mjs";
import { seedPreviewDailyReview } from "./preview-owner-review-daily.mjs";

poisonGlobalFetch();

const port = Number(process.env.PORT || 4898);
const scene = String(process.env.PREVIEW_SCENE || "normal");
const theme = String(process.env.PREVIEW_THEME || "lukprae");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// นาฬิกาเลื่อนได้: เขียนประวัติย้อนหลังด้วยเวลาในอดีต แล้วคืนเป็นเวลาจริงก่อนเปิดเซิร์ฟเวอร์
let fixedNow = null;
const db = memoryDb({ now: () => fixedNow ?? Date.now() });
const at = (ms, fn) => { fixedNow = ms; try { return fn(); } finally { fixedNow = null; } };

const PASS = hashPassword("demo-pass-123456");
db.createOperator({ username: "demo-owner", passHash: PASS, displayName: "พี่ง้วง", role: "owner" });
db.createOperator({ username: "demo-admin", passHash: PASS, displayName: "ชมพู่", role: "admin" });
db.createOperator({ username: "demo-staff", passHash: PASS, displayName: "ทีมงานจำลอง", role: "operator" });
if (process.env.PREVIEW_INTRO === "1") db.setSetting("console_intro_enabled", "1");

// ตัวสุ่มแบบกำหนดเมล็ด — ภาพหน้าจอต้องออกมาเหมือนเดิมทุกครั้งที่รัน
let seed = 20260928;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (list) => list[Math.floor(rand() * list.length)];

const FIRST = ["แพรวา", "ธนพล", "กมลชนก", "วีรยุทธ", "ศิริพร", "ณัฐวุฒิ", "พิมพ์ชนก", "อนันต์", "จิราพร", "ชยพล",
  "มณีรัตน์", "ภาคิน", "สุดารัตน์", "ปิยะ", "วรรณา", "เอกชัย", "นลินี", "ธีรวัฒน์", "อรอุมา", "กิตติ",
  "ปวีณา", "สมชาย", "รัชนี", "ธนากร", "ลลิตา", "พงศกร", "จันทร์เพ็ญ", "ศุภชัย", "ดวงใจ", "อภิชาติ",
  "เพ็ญศรี", "ชัยวัฒน์", "ขวัญใจ", "ประเสริฐ", "นภัสสร", "ยุทธนา", "สายใจ", "วิชัย", "อัมพร", "ไพโรจน์"];
const BIZ = ["ร้านกาแฟ", "โรงงานบรรจุภัณฑ์", "คลินิกความงาม", "บริษัททัวร์", "ร้านอาหาร", "อสังหาฯ", "โรงเรียนกวดวิชา",
  "ร้านดอกไม้", "ธุรกิจส่งออก", "ร้านเสื้อผ้า", "โรงแรม", "บริษัทบัญชี"];
const ASKS = [
  "สนใจคลาส AI Agent for Business ค่ะ รอบถัดไปวันไหนคะ",
  "ขอรายละเอียดคลาสออนไลน์หน่อยครับ",
  "เรียนแล้วเอาไปใช้กับทีมขายได้เลยไหมคะ",
  "มีคลาสสำหรับองค์กรไหมครับ ทีมประมาณ 20 คน",
  "ต้องมีพื้นฐานเขียนโค้ดไหมคะ",
  "สอนทำแชทบอท LINE ด้วยไหมครับ",
  "ขอดูตารางรอบเรียนเดือนหน้าค่ะ",
  "เรียนจบแล้วมีคนช่วยติดตั้งให้ไหมครับ",
];
const AI_REPLIES = [
  "ยินดีค่ะ ลูกแพรขอเล่าภาพรวมให้ฟังสั้น ๆ ก่อนนะคะ คลาสนี้เน้นลงมือทำกับงานจริงของธุรกิจค่ะ",
  "ได้เลยค่ะ ขอถามนิดนึงนะคะ ตอนนี้ธุรกิจของคุณใช้ AI ช่วยงานส่วนไหนอยู่บ้างคะ",
  "ไม่ต้องมีพื้นฐานเขียนโค้ดเลยค่ะ ทุกขั้นตอนทำตามได้ในห้องเรียนค่ะ",
  "มีค่ะ ลูกแพรขอเช็กรอบที่ยังมีที่นั่งให้ก่อนนะคะ",
];

const customers = [];
const now = Date.now();
const nowStart = (() => { // เที่ยงคืนวันนี้ตามเวลาไทย
  const bkk = now + 7 * HOUR;
  return bkk - (bkk % DAY) - 7 * HOUR;
})();

function addCustomer(i, { score = null, needs = false, aiOff = false, createdAt, name }) {
  const id = `demo-${String(i).padStart(3, "0")}`;
  at(createdAt, () => db.upsertCustomer(id, { displayName: name }));
  // payload จำลองรูปเดียวกับที่ scorer เขียนจริง (มี score) — ไม่งั้นแผงข้างห้องขึ้น "ความสนใจ undefined/10"
  if (Number.isInteger(score)) at(createdAt + 2 * MIN, () => db.recordScore(id, score, JSON.stringify({ score })));
  if (aiOff) db.setAiEnabled(id, false, "operator_manual");
  if (needs) db.setNeedsHuman(id, "customer_asked_for_human", "ลูกค้าขอคุยกับทีมงานเรื่องรอบเรียน");
  customers.push({ id, score, needs });
  return id;
}

// เขียนบทสนทนาหนึ่งตา: ลูกค้าถาม -> (AI หรือคน) ตอบหลังรอสักพัก
function exchange(id, askedAt, { by = "ai", waitMs = 20_000, ask = pick(ASKS), reply = pick(AI_REPLIES), answer = true } = {}) {
  at(askedAt, () => db.insertMessage({ customerId: id, direction: "in", content: ask }));
  if (!answer) return;
  at(askedAt + waitMs, () => db.insertMessage({
    customerId: id, direction: "out", content: reply,
    agentMode: by === "ai" ? "ai" : "operator_ai_on",
    operator: by === "ai" ? "" : "demo-admin",
  }));
}

// ฐานลูกค้าเก่าที่ย้ายมาจาก LINE OA เดิม — ไม่มีคะแนน (คือกลุ่ม cold ส่วนใหญ่ของของจริง)
for (let i = 0; i < 64; i += 1) {
  addCustomer(200 + i, { createdAt: now - (40 + i) * DAY, name: `${pick(FIRST)} (ฐานเดิม)` });
}

// ลูกค้าที่คุยจริงใน 14 วันล่าสุด
const SCORES = [9, 9, 8, 8, 8, 7, 7, 6, 6, 6, 5, 5, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, null, null, null, 4, 3, 2, 6, 5, 3, null, 2, 1];
SCORES.forEach((score, i) => {
  const name = `${FIRST[i % FIRST.length]} · ${BIZ[i % BIZ.length]}`;
  const created = now - Math.floor(rand() * 13 + 1) * DAY - Math.floor(rand() * 8) * HOUR;
  const id = addCustomer(i + 1, { score, createdAt: created, name });
  // บทสนทนาย้อนหลังสองสามตา + วันนี้สำหรับคนส่วนใหญ่
  const turns = 1 + Math.floor(rand() * 3);
  for (let t = 0; t < turns; t += 1) {
    const askedAt = created + (t + 1) * (3 * HOUR + Math.floor(rand() * 9) * HOUR);
    if (askedAt > nowStart - HOUR) break;
    const human = rand() < 0.22;
    exchange(id, askedAt, { by: human ? "human" : "ai", waitMs: human ? (3 + Math.floor(rand() * 20)) * MIN : (6 + Math.floor(rand() * 40)) * 1000 });
  }
  if (i < 29) {
    const todayAt = Math.min(now - 25 * MIN, nowStart + 9 * HOUR + Math.floor(rand() * 7) * HOUR);
    const human = rand() < 0.15;
    exchange(id, todayAt, { by: human ? "human" : "ai", waitMs: human ? (2 + Math.floor(rand() * 9)) * MIN : (5 + Math.floor(rand() * 25)) * 1000 });
  }
});

// ห้องที่รอคนตอบอยู่ตอนนี้ (สถานะ NEEDS_HUMAN + ข้อความลูกค้าล่าสุดยังไม่มีใครตอบ)
const waiting = scene === "calm" ? [] : scene === "busy"
  ? [{ mins: 94, ask: "ขอคุยกับทีมงานได้ไหมคะ อยากจองให้ทีมทั้งแผนก" }, { mins: 41, ask: "โอนแล้วค่ะ ส่งสลิปให้นะคะ" },
    { mins: 17, ask: "ขอใบเสนอราคาในนามบริษัทได้ไหมครับ" }, { mins: 6, ask: "รบกวนโทรกลับได้ไหมคะ" }]
  : [{ mins: 23, ask: "ขอคุยกับทีมงานได้ไหมคะ อยากจองให้ทีมทั้งแผนก" }, { mins: 7, ask: "ขอใบเสนอราคาในนามบริษัทได้ไหมครับ" }];
waiting.forEach((room, i) => {
  const id = addCustomer(100 + i, {
    score: [8, 7, 9, 6][i] ?? 6, needs: true, createdAt: now - (2 + i) * DAY,
    name: ["มาลัย · โรงงานบรรจุภัณฑ์", "ธนวัฒน์ · บริษัทบัญชี", "รุ่งนภา · คลินิกความงาม", "วิทยา · ร้านอาหาร"][i],
  });
  exchange(id, now - (2 + i) * DAY + 2 * HOUR, { by: "ai", waitMs: 18_000 });
  at(now - room.mins * MIN, () => db.insertMessage({ customerId: id, direction: "in", content: room.ask }));
  if (scene === "busy" && i === 1) {
    at(now - 40 * MIN, () => db.addSlipCheck({ customerId: id, status: "suspect", amount: 4900, payloadJson: JSON.stringify({ reason: "ยอดในสลิปไม่ตรงกับบัญชีที่ตรวจได้" }) }));
  }
});

// เงินรั่วแบบที่เจอในข้อมูลจริงเดือนกันยายน (แต่งขึ้นใหม่ทั้งหมด): ลูกค้าพูดคนสุดท้ายแล้วค้างหลายวัน
// ห้องพวกนี้ AI ปิดอยู่ (ส่งต่อให้คน) จึงไม่มีใครตอบเลย — หน้าภาพรวมต้องเห็นทันที
if (scene !== "calm") {
  [
    { days: 11, name: "ชนิดา · บริษัทอสังหาฯ", score: 9, ask: "สนใจคอนซัลแบบรายเดือนค่ะ รบกวนติดต่อกลับด้วยนะคะ", money: false },
    { days: 6, name: "กฤษดา · โรงงานอาหาร", score: 8, ask: "อยากได้ in-house ให้ทีม 12 คนครับ ขอราคาหน่อย", money: false },
    { days: 2, name: "วิภา · ร้านเบเกอรี่", score: 7, ask: "โอนมัดจำแล้วนะคะ ช่วยเช็กให้หน่อยค่ะ", money: true },
  ].forEach((room, i) => {
    const id = addCustomer(160 + i, { score: room.score, createdAt: now - (room.days + 3) * DAY, name: room.name, aiOff: true });
    exchange(id, now - (room.days + 2) * DAY, { by: "ai", waitMs: 25_000 });
    at(now - room.days * DAY - 3 * HOUR, () => db.insertMessage({ customerId: id, direction: "in", content: room.ask }));
    if (room.money) db.markMoneySeen(id);
  });
}
// ลูกค้าร้อนที่เงียบไป 2–6 วัน และยังไม่เคยมีคนจริงทัก (มีแต่ลูกแพรตอบ)
[
  { days: 5, name: "คุณเอ · บริษัทขนส่ง", score: 9 },
  { days: 3, name: "อรวรรณ · คลินิกทันตกรรม", score: 8 },
  { days: 2, name: "สุรชัย · ร้านวัสดุก่อสร้าง", score: 8 },
].forEach((room, i) => {
  const id = addCustomer(170 + i, { score: room.score, createdAt: now - (room.days + 4) * DAY, name: room.name });
  exchange(id, now - room.days * DAY - 5 * HOUR, { by: "ai", waitMs: 18_000,
    ask: "สนใจคลาส AI Agent for Business ค่ะ รอบถัดไปวันไหนคะ", reply: "มีรอบปลายเดือนนี้ค่ะ ลูกแพรส่งรายละเอียดให้นะคะ" });
});

// ห้องแชทตัวอย่างสำหรับภาพหน้าจอห้องแชท (คุยกันยาวพอให้เห็นฟองแชททุกแบบ)
const showcase = addCustomer(150, { score: 9, createdAt: now - 3 * DAY, name: "แพรวา · ร้านกาแฟสองสาขา" });
const convo = [
  ["in", "สวัสดีค่ะ เห็นโพสต์คลาส AI Agent for Business ค่ะ สนใจให้ทีมหน้าร้านใช้ AI ตอบแชทลูกค้า", null, 300 * MIN],
  ["out", "สวัสดีค่ะคุณแพรวา ลูกแพรยินดีดูแลนะคะ ขอถามนิดนึงค่ะ ตอนนี้ร้านได้รับแชทวันละประมาณกี่ข้อความคะ", "ai", 299.6 * MIN],
  ["in", "วันละร้อยกว่าข้อความค่ะ ส่วนใหญ่ถามเมนู เวลาเปิดปิด แล้วก็สั่งเค้กล่วงหน้า", null, 290 * MIN],
  ["out", "เข้าใจเลยค่ะ งานแบบนี้เหมาะกับการให้ AI ช่วยร่างคำตอบมากค่ะ ในคลาสจะได้ลองทำบอทกับคำถามจริงของร้านเองเลยนะคะ", "ai", 289.5 * MIN],
  ["in", "ถ้าเรียนแล้วทำไม่เป็น มีคนช่วยไหมคะ", null, 60 * MIN],
  ["out", "มีทีมงานคอยช่วยหลังเรียนค่ะ เดี๋ยวชมพู่จากทีมงานส่งรายละเอียดการดูแลหลังคลาสให้นะคะ", "ai", 59.6 * MIN],
  ["out", "สวัสดีค่ะคุณแพรวา ชมพู่นะคะ หลังเรียนมีกลุ่มถามตอบและนัดช่วยติดตั้งได้ค่ะ ส่งรายละเอียดให้ในแชทนี้เลยนะคะ", "operator", 52 * MIN],
  ["in", "ดีมากเลยค่ะ งั้นขอจองรอบถัดไปสองที่นะคะ", null, 9 * MIN],
];
for (const [direction, content, mode, ago] of convo) {
  at(now - ago, () => db.insertMessage({
    customerId: showcase, direction, content,
    agentMode: mode === "ai" ? "ai" : mode === "operator" ? "operator_ai_on" : null,
    operator: mode === "operator" ? "demo-admin" : "",
  }));
}

// ออเดอร์: วันนี้ 1 ใบ + ยืนยันแล้วเดือนนี้อีกหลายใบ + ร่างรอตรวจ 1 ใบ
const order = (customerId, total, status, ago) => at(now - ago, () => db.createOrder({
  customerId, items: [{ name: "Classroom AI Agent for Business", qty: total > 20000 ? 2 : 1, price: total > 20000 ? total / 2 : total }],
  total, status, createdBy: "demo-admin",
}));
order(customers[0].id, 23800, "confirmed", 2 * HOUR);
order(customers[1].id, 11900, "paid", 3 * DAY);
order(customers[2].id, 11900, "done", 6 * DAY);
order(customers[3].id, 35700, "paid", 9 * DAY);
order(showcase, 23800, "draft", 8 * MIN);

// ต้นทุน AI (เห็นเฉพาะเจ้าของ) — ตัวเลขจำลอง
for (let i = 0; i < 60; i += 1) {
  at(now - Math.floor(rand() * 20) * HOUR, () => db.addLlmUsage({
    customerId: pick(customers).id, kind: i % 5 === 0 ? "score" : "draft",
    model: i % 5 === 0 ? "gpt-5.6-luna" : "gpt-5.6-sol", tokensIn: 9000 + Math.floor(rand() * 4000), tokensOut: 300 + Math.floor(rand() * 200),
  }));
}

// ห้องตรวจของพี่ง้วง (12 ต.ค. 2026 ค่ำ): ห้องที่ AI เสนอปิดรอยืนยัน — ประโยคแต่งขึ้นทั้งหมด
// ห้องที่ 2 ลูกค้าพิมพ์ต่อหลัง AI เสนอ (การ์ดขึ้น "ลูกค้าพิมพ์มาใหม่") · ห้อง Facebook เงียบเกิน 24 ชม. = ปิดได้แค่แบบเงียบ
if (process.env.PREVIEW_OWNER_SWEEP !== "off") db.setSetting(QUALIFY_SWEEP_MODE_KEY, "on");
const OWNER_REVIEW_ROOMS = [
  {
    name: "ประยุทธ ศรีสุข", category: "ask_money", source: "cue_luna", channelId: "default", minsAgo: 150,
    reason: "ขอยืมเงินจากเราตรง ๆ ไม่ได้ถามเรื่องคลาสเลย",
    turns: [
      ["in", "สวัสดีครับ เห็นโพสต์คลาส AI ครับ", 200],
      ["out", "สวัสดีค่ะ ลูกแพรดูแลเรื่องคลาสเรียน AI ของพี่ง้วงนะคะ สนใจนำ AI ไปใช้กับงานแบบไหนคะ", 199],
      ["in", "ช่วงนี้ผมลำบากมากครับ ไม่มีงานเลย", 170],
      ["out", "เข้าใจเลยค่ะ ถ้าวันไหนพร้อมเรียน ลูกแพรยินดีเล่ารายละเอียดให้นะคะ", 169],
      ["in", "ขอยืมเงินสัก 2,000 ได้ไหมครับ เดี๋ยวสิ้นเดือนคืนให้", 151],
    ],
  },
  {
    name: "พระมหาวิชัย", category: "monk", source: "luna_screen", channelId: "default", minsAgo: 95,
    reason: "บวชอยู่และบอกว่าไม่มีปัจจัยลงเรียน คุยต่อเรื่องธรรมะ",
    typedAfter: ["in", "อาตมาขอถามเรื่องปฏิบัติธรรมต่ออีกนิดได้ไหม", 20],
    turns: [
      ["in", "เจริญพร อาตมาบวชอยู่ สนใจ AI แต่ไม่มีปัจจัย", 140],
      ["out", "นมัสการค่ะ ลูกแพรขอบพระคุณที่สนใจนะคะ คลาสเป็นแบบสอนสดค่ะ", 139],
      ["in", "โยมช่วยสอนให้ฟรีได้ไหม แล้วเล่าเรื่องการทำสมาธิให้ฟังหน่อย", 96],
    ],
  },
  {
    name: "ธนากร วงศ์ใหญ่", category: "business_pitch", source: "cue_luna", channelId: "facebook", minsAgo: 30 * 60,
    reason: "ชวนเราร่วมลงทุนธุรกิจปุ๋ย ไม่ได้มาเพื่อเรียน",
    turns: [
      ["in", "สวัสดีครับ ผมทำธุรกิจปุ๋ยอินทรีย์ครับ", 31 * 60],
      ["out", "สวัสดีค่ะ ลูกแพรดูแลเรื่องคลาสเรียน AI นะคะ ธุรกิจปุ๋ยใช้ AI ช่วยได้หลายส่วนเลยค่ะ", 31 * 60 - 1],
      ["in", "สนใจร่วมลงทุนกับผมไหมครับ ผลตอบแทนเดือนละ 20% แน่นอน", 30 * 60 + 2],
    ],
  },
  {
    name: "ณัฐพล ใจเย็น", category: "off_topic_personal", source: "luna_screen", channelId: "default", minsAgo: 12,
    reason: "ถามเรื่องแฟนและขอให้ร้องเพลงกล่อมนอน ไม่มีเรื่องเรียน",
    turns: [
      ["in", "ลูกแพรมีแฟนยังครับ", 40],
      ["out", "ลูกแพรเป็นแอดมินดูแลเรื่องคลาส AI ค่ะ มีอะไรเกี่ยวกับการเรียนให้ช่วยไหมคะ", 39],
      ["in", "ไม่เอาเรื่องเรียน ร้องเพลงกล่อมให้ฟังหน่อย นอนไม่หลับ", 13],
    ],
  },
];
const ownerReviewCount = process.env.PREVIEW_OWNER_REVIEW === "0" ? 0 : OWNER_REVIEW_ROOMS.length;
OWNER_REVIEW_ROOMS.slice(0, ownerReviewCount).forEach((room, i) => {
  const id = `demo-orv-${i + 1}`;
  at(now - 3 * DAY, () => db.upsertCustomer(id, { displayName: room.name, channelId: room.channelId }));
  let baseline = "";
  for (const [direction, content, ago] of room.turns) {
    const msgId = at(now - ago * MIN, () => db.insertMessage({ customerId: id, direction, content, agentMode: direction === "out" ? "ai" : null }));
    if (direction === "in") baseline = String(msgId);
  }
  at(now - room.minsAgo * MIN, () => db.insertOwnerCloseProposal({
    customerId: id, channelId: room.channelId, source: room.source, category: room.category, cue: room.source === "cue_luna" ? room.category : "",
    aiReason: room.reason, baselineInboundId: baseline,
  }));
  if (room.typedAfter) {
    const [direction, content, ago] = room.typedAfter;
    at(now - ago * MIN, () => db.insertMessage({ customerId: id, direction, content }));
  }
});
// รอบตรวจล่าสุด (สำหรับหน้าว่าง "ตรวจล่าสุดรอบ …") — รอบ 09/12/15/19 ที่ผ่านมาล่าสุดตามเวลาไทย
{
  const slots = [0, -1].flatMap((dayOffset) => [19, 15, 12, 9].map((hour) => nowStart + dayOffset * DAY + hour * HOUR));
  const lastSlot = slots.find((slot) => slot <= now) ?? nowStart - 5 * HOUR;
  const batch = at(lastSlot, () => db.claimOwnerReviewBatch({ kind: "scan", slotMs: lastSlot, windowStartMs: lastSlot - 3 * HOUR, windowEndMs: lastSlot }));
  if (batch) db.updateOwnerReviewBatch(batch.id, { status: "ready", readyAt: lastSlot + 4 * MIN, counts: { rooms: 23, evaluated: 9, proposed: ownerReviewCount } });
}

// ห้องตรวจ เฟส B (12 ต.ค. 2026): คิวตรวจแชทรายวัน 20:00 — ห้อง/ข้อความ/ผลตรวจของ AI แต่งขึ้นทั้งหมด (ดู preview-owner-review-daily.mjs)
seedPreviewDailyReview({ db, at, now, mode: String(process.env.PREVIEW_OWNER_DAILY || "ready") });

// 8 พ.ย. 2026: หน้า Usage วันนี้ (#/usage) — คำตอบ AI วันนี้พร้อม metadata ของเครื่องตอบ + การเรียกโมเดลรายชั่วโมง
// ทั้งหมดแต่งขึ้น (ห้อง U-usage-demo-*) · ชั่วโมงในอนาคตไม่ถูกเขียน
{
  const dayStart = now - ((now + 7 * HOUR) % DAY);
  const KINDS = [["draft", "gpt-6.1-sol", 2600, 180], ["staged_followup", "gpt-6.1-sol", 2400, 160], ["score", "gpt-5.6-luna", 1400, 60],
    ["owner_review", "gpt-5.6-luna", 1800, 70], ["qualify", "gpt-6.1-sol", 2200, 70]];
  for (let hour = 0; dayStart + hour * HOUR < now; hour += 1) {
    const busy = hour >= 8 && hour <= 21 ? 2 + (hour % 4) : hour % 3 === 0 ? 1 : 0;
    for (let n = 0; n < busy; n += 1) {
      const id = `U-usage-demo-${hour}-${n}`;
      const t = Math.min(now - MIN, dayStart + hour * HOUR + (n * 13 + 5) * MIN);
      at(t, () => db.upsertCustomer(id, { displayName: `ลูกค้าจำลอง ${hour}.${n}` }));
      at(t, () => db.insertMessage({ customerId: id, direction: "in", content: "สนใจคลาสค่ะ" }));
      at(t + MIN / 2, () => db.insertMessage({ customerId: id, direction: "out", content: "ได้เลยค่ะ", agentMode: "ai", metadata: {
        replyEngine: { engine: "v3", calls: n % 4 === 3 ? 2 : 1, styleCard: "opus-style-v9.3:preview", styleBank: n % 2 ? ["b1"] : [],
          firstDraft: n % 4 === 3 ? { hard: [], soft: ["R10-homework"] } : { hard: [], soft: [] } },
      } }));
      if (n % 2 === 0) at(t + 20 * MIN, () => db.insertMessage({ customerId: id, direction: "out", content: "ทักมาถามต่อนะคะ", agentMode: "ai", messageClass: "proactive" }));
      for (const [kind, model, tokensIn, tokensOut] of KINDS.slice(0, 2 + (n % 4))) {
        at(t + MIN / 2, () => db.addLlmUsage({ customerId: id, kind, model, tokensIn, tokensOut, cachedIn: Math.floor(tokensIn * 0.6), cacheWriteIn: 0 }));
      }
    }
  }
}

const app = createApp({
  config: testConfig({
    CONSOLE_SESSION_SECRET: "preview-console-secret-123456",
    CONSOLE_BRAND_NAME: "พี่ง้วง - ติดกระดุม",
    CONSOLE_BRAND_MARK: "พง",
    CONSOLE_BRAND_AGENT: "ลูกแพร AI",
    CONSOLE_BRAND_THEME: theme,
    TEACH_ENABLED: "true",
    CHAT_HISTORY_ENABLED: "true",
  }),
  db,
  logger: { log() {}, warn() {}, error() {}, debug() {} },
  overrides: {
    lineFetch: lineFetchStub({ quota: { type: "limited", value: 15000 }, consumption: { totalUsage: 4260 } }),
    hermesFetch: hermesFetchStub(),
    sleep: async () => {},
  },
});
app.server.listen(port, "127.0.0.1", () => {
  console.log(`LuKprae UI preview (${scene}, theme=${theme}): http://127.0.0.1:${port}/console`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.server.close(() => { db.close(); process.exit(0); }));
