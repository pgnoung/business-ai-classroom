// reply-engine-v3-lanes.test.mjs — เทิร์นไหนคงเครื่องเดิม (spec v3.1 §A5 · §A8.2) และสวิตช์ reply_engine อ่านอย่างไร
// ข้อความลูกค้าทุกบรรทัดเป็นประโยคสังเคราะห์
import test from "node:test";
import assert from "node:assert/strict";
import { chooseLane, CAMPAIGN_KEYWORD_COPY, PAYMENT_STARTED_STATUSES, TEAM_PROMISE_COPY, lanePromisesTeam } from "../src/replyEngineV3/lanes.mjs";
import { REPLY_ENGINE_KEY, REPLY_ENGINE_MODES, replyEngineMode } from "../src/replyEngineV3/mode.mjs";
import { CAMPAIGN_KEYWORD, PAYMENT_STARTED_DEAL_STATUSES, TEAM_PROMISE_RE, looksLikeTeamPromise } from "../src/pipeline.mjs";

const base = (over = {}) => ({
  text: "ทำร้านกาแฟค่ะ อยากให้ AI ช่วยทำโพสต์", parts: [], history: [], customer: { ai_enabled: 1, deal_status: "new" },
  intent: "general", priceDisclosure: { mode: "defer", reason: "defer_cold_no_money_ask" }, handoffIntent: null,
  projectHandoff: null, handoffProject: null, projectOpportunity: null, outlinePlan: { deliver: false }, hasApprovedFacts: true,
  inboundFlags: [], ...over,
});
const reason = (over) => chooseLane(base(over)).reason;

test("สวิตช์: ไม่มีแถว/ค่าอื่น/อ่านพัง = legacy · ต้องเป็น \"v3\" ตรงตัวเท่านั้น", () => {
  const dbWith = (value) => ({ getSetting: (key) => (key === REPLY_ENGINE_KEY ? value : null) });
  assert.equal(REPLY_ENGINE_KEY, "reply_engine");
  assert.deepEqual([...REPLY_ENGINE_MODES], ["legacy", "v3"]);
  for (const value of [null, undefined, "", "legacy", "garbage", "V3", " v3", "v3 ", "on"]) assert.equal(replyEngineMode(dbWith(value)), "legacy", String(value));
  assert.equal(replyEngineMode(dbWith("v3")), "v3");
  assert.equal(replyEngineMode({ getSetting() { throw new Error("db down"); } }), "legacy");
  assert.equal(replyEngineMode(null), "legacy");
});

test("สำเนาค่าคงที่ใน lanes.mjs ตรงกับต้นฉบับใน pipeline.mjs (กันวงวน import โดยไม่ให้สองที่เพี้ยนกัน)", () => {
  assert.deepEqual([...PAYMENT_STARTED_STATUSES], [...PAYMENT_STARTED_DEAL_STATUSES]);
  assert.equal(CAMPAIGN_KEYWORD_COPY.source, CAMPAIGN_KEYWORD.source);
  assert.equal(CAMPAIGN_KEYWORD_COPY.flags, CAMPAIGN_KEYWORD.flags);
});

test("เทิร์นปกติ = v3", () => {
  assert.deepEqual(chooseLane(base()), { engine: "v3", reason: "v3" });
});

test("ทุกเหตุของเลนเครื่องเดิม (ตามลำดับในตาราง)", () => {
  const cases = [
    ["closing_turn", { handoffIntent: { kind: "booking" } }],
    ["closing_turn", { projectHandoff: { phoneKnown: false } }],
    ["project", { handoffProject: "in_house_training" }],
    ["project", { projectOpportunity: "private_class" }],
    ["project", { priceDisclosure: { mode: "quote", projectPricing: true } }],
    ["care", { priceDisclosure: { mode: "defer", careMode: "pause" } }],
    ["bank_payment", { customer: { ai_enabled: 1, deal_status: "awaiting_payment" } }],
    ["bank_payment", { text: "ขอเลขบัญชีหน่อยค่ะ" }],
    ["bank_payment", { text: "ผ่อนบัตรเครดิตได้ไหมคะ" }],
    ["bank_payment", { text: "ออกใบกำกับภาษีได้ไหม" }],
    ["bank_payment", { customer: { ai_enabled: 1, deal_status: "paid_confirmed" } }],
    ["document_presale", { intent: "document_presale" }],
    ["outline_delivery", { outlinePlan: { deliver: true } }],
    ["legacy_identity", { customer: { ai_enabled: 1, deal_status: "new", legacy_link: "candidate:U-old" } }],
    ["legacy_identity", { customer: { ai_enabled: 1, deal_status: "new", legacy_link: "ambiguous:2" } }],
    ["online_topic", { text: "มีคลาสออนไลน์ไหมคะ" }],
    ["online_topic", { text: "ขอดูย้อนหลังได้ไหม" }],
    ["online_topic", { priceDisclosure: { mode: "defer", onlinePivot: true } }],
    ["old_student_bundle", { text: "เคยเรียนคลาสออฟไลน์มาแล้วค่ะ" }],
    ["old_student_bundle", { text: "เรียนสองคลาสพร้อมกันได้ไหม" }],
    ["seats", { text: "เหลือกี่ที่คะ" }],
    ["media", { text: "[image] รูปที่ลูกค้าส่ง" }],
    ["media", { parts: ["สวัสดีค่ะ", "[sticker]"], text: "สวัสดีค่ะ\n[sticker]" }],
    ["campaign", { text: "#น้องฝน" }],
    ["no_approved_facts", { hasApprovedFacts: false }],
  ];
  for (const [expected, over] of cases) {
    const lane = chooseLane(base(over));
    assert.deepEqual(lane, { engine: "legacy", reason: expected }, `${expected} ${JSON.stringify(over)}`);
  }
});

test("ลำดับ: เหตุแรกที่ตรงชนะ (ส่งต่อทีมชนะเรื่องเงิน เงินชนะออนไลน์)", () => {
  assert.equal(reason({ handoffIntent: { kind: "contact_team" }, text: "ขอเลขบัญชีค่ะ" }), "closing_turn");
  assert.equal(reason({ text: "โอนเงินคลาสออนไลน์ยังไงคะ" }), "bank_payment");
  assert.equal(reason({ text: "#โปร เคยเรียนแล้ว" }), "old_student_bundle");
});

test("ขายของออนไลน์ = ธุรกิจของลูกค้า ไม่ใช่คลาสออนไลน์ (เดินต่อใน v3)", () => {
  assert.equal(reason({ text: "ขายของออนไลน์ค่ะ อยากให้ AI ช่วยทำโพสต์" }), "v3");
  assert.equal(reason({ text: "มีร้านออนไลน์ใน Shopee ค่ะ" }), "v3");
  assert.equal(reason({ text: "ขายของออนไลน์ค่ะ มีคลาสออนไลน์ไหม" }), "online_topic");
});

test("อินพุตพัง = legacy (ห้าม throw ใส่เส้นตอบลูกค้า)", () => {
  const lane = chooseLane({ get text() { throw new Error("boom"); } });
  assert.equal(lane.engine, "legacy");
});

// ---- รีวิว 4 ต.ค. (lens legacy-safety): หัวข้อที่คุยค้าง · วิธีจ่าย/บิล · ที่นั่ง · นักเรียนเก่า ----
const u = (content) => ({ role: "user", content });
const b = (content) => ({ role: "assistant", content });

test("หัวข้อที่คุยค้างในหน้าต่างประวัติ: ถามราคาสั้น ๆ ต่อจากเรื่องออนไลน์/นักเรียนเก่า/สองคลาส/Private = เครื่องเดิม", () => {
  const ask = "ราคาเท่าไหร่คะ";
  assert.equal(reason({ text: ask, history: [u("มีคลาสออนไลน์ไหมคะ"), b("มีค่ะ Online Class ดูย้อนหลังได้ค่ะ")] }), "online_topic");
  assert.equal(reason({ text: "ถ้าจะเรียนคลาสสอนสดต่อ ราคาเท่าไหร่คะ", history: [u("เคยเรียน Online Class ของพี่ง้วงแล้วค่ะ"), b("ดีเลยค่ะ")] }), "online_topic");
  assert.equal(reason({ text: ask, history: [u("อยากลงทั้ง Business และ Workflow พร้อมกันเลยค่ะ"), b("ดีเลยค่ะ")] }), "old_student_bundle");
  assert.equal(reason({ text: ask, history: [u("เคยลงคลาสพี่ง้วงไปแล้วค่ะ"), b("ขอบคุณค่ะ")] }), "old_student_bundle");
  assert.equal(reason({ text: ask, history: [u("ถ้าทำ private ให้ทีมได้ไหมคะ"), b("ได้ค่ะ")] }), "project");
  // ธุรกิจออนไลน์ของลูกค้า / ข้อความบอทที่พูดถึงสิทธิ์ทบทวนออนไลน์ ไม่ใช่หัวข้อคลาสออนไลน์
  assert.equal(reason({ text: ask, history: [u("ขายของออนไลน์ค่ะ"), b("ผู้เรียนได้สิทธิ์ทบทวนผ่านคลาสออนไลน์ไม่จำกัดเวลาค่ะ")] }), "v3");
});

test("หน้าต่างประวัติ = 16 ก้อนเดียวกับที่ v3 เห็น (เรื่องที่เลยหน้าต่างไปแล้วไม่ล็อกเทิร์นถัดไปตลอด session)", () => {
  const old = [u("มีคลาสออนไลน์ไหมคะ"), b("มีค่ะ")];
  const chatter = Array.from({ length: 16 }, (_, i) => (i % 2 ? b(`ตอบข้อ ${i}`) : u(`เล่าเรื่องงานข้อ ${i}`)));
  assert.equal(reason({ text: "ราคาเท่าไหร่คะ", history: [...old, ...chatter] }), "v3");
  assert.equal(reason({ text: "ราคาเท่าไหร่คะ", history: [...old, ...chatter.slice(-12)] }), "online_topic");
});

test("วิธีจ่าย/บิล/เบิก/บัตร = เครื่องเดิม (v3 ไม่มีข้อมูลชำระเงิน) · ค่าใช้จ่าย/แจกจ่าย/บัตรคำ ไม่ใช่", () => {
  for (const text of ["แบ่งจ่ายได้ไหมคะ", "จ่ายครึ่งก่อนได้ไหมคะ", "จ่ายเป็นเงินสดได้ไหมคะ", "จ่ายสดหน้างานได้ไหมคะ", "เบิกบริษัทได้ไหมคะ",
    "ออกบิลในนามบริษัทได้ไหมคะ", "รับบัตรไหมคะ", "มีค่าธรรมเนียมไหมคะ", "ขอใบเสนอราคาหน่อยค่ะ", "รวม VAT หรือยังคะ", "ถ้าไม่ได้ไปขอรีฟันด์ได้ไหม", "can I pay by card?"]) {
    assert.equal(reason({ text }), "bank_payment", text);
  }
  for (const text of ["อยากลดค่าใช้จ่ายในร้านค่ะ", "อยากให้ AI ช่วยแจกจ่ายงานในทีม", "เป็นครูค่ะ อยากทำบัตรคำให้นักเรียน", "ทำแอป display ร้านค่ะ"]) {
    assert.notEqual(reason({ text }), "bank_payment", text);
  }
});

test("ถามว่าง/เต็ม/ที่ว่าง = ที่นั่ง (เครื่องเดิมมีจำนวนที่นั่งจริง) · ไม่ว่าง/เต็มที่/เต็มเวลา ไม่ใช่", () => {
  for (const text of ["ยังว่างอยู่ไหมคะรอบหน้า", "เต็มยังคะ", "ยังมีที่ว่างไหมคะ", "รอบ 17 เต็มหรือยัง", "ยังรับอยู่ไหมคะ", "เหลือที่ไหมคะ"]) {
    assert.equal(reason({ text }), "seats", text);
  }
  for (const text of ["ไม่ว่างเลยค่ะช่วงนี้", "อยากใช้ AI ให้เต็มที่", "ทำงานประจำเต็มเวลาค่ะ", "มีเวลาที่ว่างแค่วันเสาร์"]) {
    assert.notEqual(reason({ text }), "seats", text);
  }
});

test("นักเรียนเก่าหลายแบบ + ขายออนไลน์เฉย ๆ = เครื่องเดิม · เคยลงมือ/เรียนไปแล้วได้อะไร ไม่ใช่นักเรียนเก่า", () => {
  for (const text of ["เคยลงคลาสพี่ง้วงไปแล้วรอบนึง ได้ส่วนลดไหม", "เคยมาเรียนแล้วค่ะ", "เรียนไปแล้วค่ะ", "เป็นลูกศิษย์พี่ง้วงค่ะ", "อยากเรียนครบทั้งสองคลาส"]) {
    assert.equal(reason({ text }), "old_student_bundle", text);
  }
  for (const text of ["มีคอร์สที่ขายออนไลน์ไหมคะ", "คลาสนี้มีขายออนไลน์ด้วยไหม"]) assert.equal(reason({ text }), "online_topic", text);
  for (const text of ["เคยลงมือทำ Custom GPT นิดหน่อยค่ะ", "เรียนไปแล้วทำได้เลยไหมคะ", "ขายของออนไลน์ค่ะ", "ทำธุรกิจออนไลน์ค่ะ"]) {
    assert.equal(reason({ text }), "v3", text);
  }
});

// ---- held-out 5 ต.ค. (v3.2): เทิร์นที่ v3 เคยเขียนคำขายใส่ ทั้งที่เครื่องเดิมมีเส้นของมัน ----
test("ตามเรื่องทีมงาน: ลูกแพรเพิ่งบอกว่าทีมจะติดต่อ/ดูแลต่อ หรือลูกค้าถามว่าทักมายัง = เครื่องเดิม", () => {
  const promised = [u("ขอคุยทาง LINE ค่ะ"), b("รับทราบค่ะ ทีมงานจะติดต่อกลับทาง LINE นะคะ")];
  assert.equal(reason({ text: "ค่ะ", history: promised }), "handoff_followup");
  const later = [...promised, u("โอเคค่ะ"), b("ระหว่างรอ เล่างานให้ลูกแพรฟังได้นะคะ")];
  assert.equal(reason({ text: "ทักมายังคะ", history: later }), "handoff_followup");
  assert.equal(reason({ text: "ยังไม่มีใครติดต่อมาเลยค่ะ", history: later }), "handoff_followup");
  // ไม่เคยสัญญาว่าทีมจะติดต่อ / เล่าเรื่องทีมของตัวเอง = v3 ตามเดิม
  assert.equal(reason({ text: "ทักมายังคะ", history: [u("สนใจค่ะ"), b("ดีเลยค่ะ ทำงานด้านไหนอยู่คะ?")] }), "v3");
  assert.equal(reason({ text: "ทีมงานของเรามีสามคนค่ะ อยากให้ AI ช่วยตอบแชท" }), "v3");
});

test("ส่งช่องทางติดต่อมาอย่างเดียว = เครื่องเดิม · เล่างานที่มีคำว่าไลน์ ไม่ใช่", () => {
  for (const text of ["somchai@example.com", "081 234 5678", "0812345678", "line id: somchai99", "ไลน์ไอดี somchai99", "[LINEส่วนตัว]", "[อีเมล]"]) {
    assert.equal(reason({ text }), "contact_info", text);
  }
  for (const text of ["อยากให้ AI ตอบไลน์ลูกค้าค่ะ", "ขายของผ่าน LINE OA ค่ะ"]) assert.equal(reason({ text }), "v3", text);
});

test("หลอกลวง/ข้อความอ้างว่าได้เงิน หรือลูกแพรเพิ่งเตือนเรื่อง OTP = ดูแลใจ (เครื่องเดิม)", () => {
  for (const text of ["เป็นเรื่องจริงหรือเรื่องปลอมคะ", "แบบนี้หลอกหรือเปล่าคะ", "กลัวโดนมิจฉาชีพค่ะ", "โดนแฮกเฟซค่ะ"]) {
    assert.equal(reason({ text }), "care", text);
  }
  assert.equal(reason({ text: "ไม่กล้าทำอะไรเลยค่ะ", history: [u("มีข้อความมาว่าจะได้เงิน"), b("ยังไม่กดลิงก์ ไม่โอนเงิน และไม่บอกรหัส OTP นะคะ")] }), "care");
  assert.equal(reason({ text: "อยากให้ AI ช่วยตรวจรีวิวสินค้าค่ะ" }), "v3");
});

test("กิจกรรม/ของแจก: คำกดรับ · คำที่ประกาศให้กด (พิมพ์ผิดตัวท้ายได้) · ขอลิงก์เข้าเรียน = เครื่องเดิม", () => {
  const announce = [b('พี่ง้วงมีแจก AI ช่วยตรวจแคปชั่น กด "รับข้อมูลอัพเดท" เพื่อรับได้เลยครับ'), b("สวัสดีค่ะ ลูกแพรยินดีบริการนะคะ")];
  assert.equal(reason({ text: "รับข้อมูลอัพเดต", history: announce }), "campaign");
  assert.equal(reason({ text: "อยากได้", history: [b('พิมพ์ "อยากได้" เพื่อรับเทมเพลตฟรีค่ะ')] }), "campaign");
  for (const text of ["ขอรับสิทธิ์ค่ะ", "รับเทมเพลตค่ะ", "ขอลิงค์เข้าเรียน", "ขอลิ้งก์เข้ากลุ่มหน่อยค่ะ", "ยังไม่ได้รับลิงก์เลยค่ะ"]) {
    assert.equal(reason({ text }), "campaign", text);
  }
  for (const text of ["รับทำขนมค่ะ อยากให้ AI ช่วยเขียนโพสต์", "เรียนจบแล้วยังไงต่อคะ"]) assert.equal(reason({ text }), "v3", text);
});

test("รูปที่ตัวจำแนกแปลงเป็นข้อความ \"(ลูกค้าส่งรูปมา: …)\" = สื่อ (เครื่องเดิม)", () => {
  assert.equal(reason({ text: "(ลูกค้าส่งรูปมา: ภาพการ์ดอวยพรวันศุกร์)" }), "media");
  assert.equal(reason({ text: "(ลูกค้าส่งสติกเกอร์)" }), "media");
  assert.equal(reason({ text: "ส่งรูปให้ดูได้ไหมคะ" }), "v3");
});

// ---- รีวิวปรปักษ์ v3.2 (5 ต.ค.): ตัวอย่างที่ผู้ตรวจยืนยันด้วยการรันจริง ----
test("ตัวจับรับปากแทนทีม: สำเนาตรงกับ pipeline และตัดสินเหมือน looksLikeTeamPromise ทุกประโยคที่ตัวนั้นนับ", () => {
  assert.equal(TEAM_PROMISE_COPY.source, TEAM_PROMISE_RE.source);
  assert.equal(TEAM_PROMISE_COPY.flags, TEAM_PROMISE_RE.flags);
  const lines = ["ทีมงาน (คุณชมพู่) จะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ", "ลูกแพรส่งเรื่องให้ทีมงานแล้วนะคะ เดี๋ยวมีคนติดต่อกลับค่ะ",
    "รับทราบค่ะ ทีมงาน จะติดต่อกลับภายในวันนี้นะคะ", "ให้ทีมผู้ดูแลออกแบบให้ไหมคะ?", "ทีมผู้ดูแลจะโทรหาช่วงบ่ายค่ะ", "ในคลาสมีทีม TA ช่วยระหว่างทำค่ะ"];
  for (const line of lines) if (looksLikeTeamPromise(line)) assert.equal(lanePromisesTeam(line), true, line);
  for (const line of ["เดี๋ยวแอดมินจะติดต่อกลับนะคะ", "คุณชมพู่จะติดต่อกลับในแชทนี้นะคะ", "ทีมงานจะสแกนเพิ่มเพื่อนและดูแลต่อทาง LINE นะคะ"]) {
    assert.equal(lanePromisesTeam(line), true, line);
  }
  for (const line of ["ให้ทีมผู้ดูแลออกแบบให้ไหมคะ?", "ในคลาสมีทีม TA ช่วยระหว่างทำค่ะ", "ทีมของคุณติดต่อลูกค้าทางไหนบ้างคะ?"]) {
    assert.equal(lanePromisesTeam(line), false, line);
  }
});

test("ตามเรื่องทีมงานหลายสำนวน หลังลูกแพรรับปากไว้ = เครื่องเดิม", () => {
  const later = [u("ขอคุยกับคนได้ไหมคะ"), b("รับทราบค่ะ ทีมงานจะติดต่อกลับทาง LINE นะคะ"), u("โอเคค่ะ"), b("ระหว่างรอ เล่างานให้ลูกแพรฟังได้นะคะ")];
  for (const text of ["โทรมายังคะ", "ทักมาแล้วยังคะ", "เมื่อไหร่ทีมงานจะติดต่อมาคะ", "ยังไม่เห็นใครติดต่อมาเลยค่ะ", "รอนานแล้วนะคะ"]) {
    assert.equal(reason({ text, history: later }), "handoff_followup", text);
  }
  assert.equal(reason({ text: "ค่ะ รอนะคะ", history: [u("ขอคุยกับคนได้ไหม"), b("เดี๋ยวแอดมินจะติดต่อกลับนะคะ")] }), "handoff_followup");
});

test("ความปลอดภัยหลายสำนวน + คำเตือนของลูกแพรหลายแบบ = ดูแลใจ", () => {
  for (const text of ["เพจนี้สแกมไหมคะ", "มีคนแอบอ้างชื่อพี่ง้วงมาขายคอร์สค่ะ", "เฟซโดนแฮ็คค่ะ", "มีคนขอรหัส OTP ค่ะ", "ใช่พี่ง้วงตัวจริงไหมคะ",
    "มีคอลเซ็นเตอร์โทรมาอ้างว่าเป็นทีมงานค่ะ", "กดลิงก์แปลกๆไปแล้วค่ะ ทำไงดี", "มีคนทักมาบอกว่าได้รางวัล ให้กดลิงก์รับค่ะ"]) {
    assert.equal(reason({ text }), "care", text);
  }
  for (const warning of ["ถ้าไม่แน่ใจ อย่าเพิ่งกดลิงก์และอย่าโอนเงินให้ใครนะคะ", "อย่าให้รหัสผ่านหรือรหัสยืนยันตัวตนกับใครนะคะ", "เพจจริงของพี่ง้วงมีเพจเดียวค่ะ ระวังเพจปลอมนะคะ"]) {
    assert.equal(reason({ text: "ตกใจมากเลยค่ะ", history: [u("มีคนทักมาแปลก ๆ ค่ะ"), b(warning)] }), "care", warning);
  }
});

test("ของแจก/สิทธิ์ สะกดเพี้ยนหรือพูดอ้อม + ประกาศหลายแบบ = กิจกรรม · ส่งช่องทางติดต่อมีคำนำ/คำลงท้าย = ติดต่อ", () => {
  for (const text of ["รับสิทธ์ค่ะ", "รับสิทธิค่ะ", "รับเทมเพลทค่ะ", "ขอเทมเพลตค่ะ", "สนใจรับข้อมูลอัพเดทค่ะ", "ขอรับไฟล์ค่ะ", "ขอลิงก์ Zoom ค่ะ", "ขอลิงค์ค่ะ",
    "ทำไมไม่ได้รับลิงก์คะ", "ได้สิทธิ์แล้วต้องทำยังไงต่อคะ", "ยังไม่ได้ไฟล์เลยค่ะ"]) {
    assert.equal(reason({ text }), "campaign", text);
  }
  const pairs = [['พิมพ์ว่า "อยากได้" เพื่อรับเทมเพลตฟรีค่ะ', "อยากได้"], ["พิมพ์คำว่า แจกฟรี เพื่อรับไฟล์ค่ะ", "แจกฟรี"],
    ['คอมเมนต์คำว่า "สนใจ" ใต้โพสต์ได้เลยค่ะ', "สนใจ"], ['ทักคำว่า "ขอชีท" มาได้เลยค่ะ', "ขอชีทค่ะ"], ["พิมพ์ «ขอไฟล์» มาได้เลยค่ะ", "ขอไฟล์"]];
  for (const [announce, text] of pairs) assert.equal(reason({ text, history: [b(announce), b("สวัสดีค่ะ ลูกแพรยินดีบริการนะคะ")] }), "campaign", announce);
  for (const text of ["เบอร์ 0812345678 ค่ะ", "อีเมล somchai@example.com ครับ", "+66 81 234 5678", "ไลน์ somchai99 ค่ะ"]) assert.equal(reason({ text }), "contact_info", text);
  for (const text of ["ใช้ Copilot ค่ะ", "capcut", "ขอบคุณค่ะ"]) assert.notEqual(reason({ text }), "contact_info", text);
});
