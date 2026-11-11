// เลิกใช้ DISC + สไตล์แชทจากที่ลูกค้าพิมพ์จริง (พี่ง้วงสั่ง 4 ต.ค. 2026 หลังตรวจ ก.ย.: DISC อ่านไม่ออก 81% ที่ออกเป็น C 86%)
import test from "node:test";
import assert from "node:assert/strict";
import { chatStyleRule, readChatStyle } from "../src/chatStyle.mjs";
import { buildScorerSystem, parseScorePayload } from "../src/scoring.mjs";
import { applyStablePersonaRead } from "../src/personaRead.mjs";
import { stagedRules } from "../src/stagedFollowups.mjs";
import { validateSalesPolicy } from "../src/salesPolicy.mjs";

const user = (content) => ({ role: "user", content }), bot = (content) => ({ role: "assistant", content });
const COURSE_POLICY = validateSalesPolicy({
  schemaVersion: 1, businessId: "pngoung-tidkradum", customerJourneys: ["new_lead"], decisionRoles: ["owner"],
  routingPrior: { dominantInterest: "ai", share: 0.99, publicClaimAuthorized: false },
  courses: [{ id: "ai-agent-business", type: "group_live", name: "AI Agent for Business", aliases: ["AI Basic"] }],
  opportunities: [{ type: "private_class", requiredSlots: ["business_need"], optionalSlots: [], upsize: true, handoffOnComplete: true }],
});

test("สไตล์แชท: นับเฉพาะที่ลูกค้าพิมพ์เอง ไม่นับข้อความแทนรูป/สติกเกอร์ และต้องมีอย่างน้อย 2 ข้อความ", () => {
  assert.equal(readChatStyle([user("สนใจค่ะ")]), null);
  assert.equal(readChatStyle([user("(ลูกค้าส่งรูปมา: ภาพสินค้า)"), user("[สติกเกอร์]")], ""), null);
  const short = readChatStyle([user("2"), bot("เคยลองใช้มาบ้างแล้วนะคะ อยากใช้กับงานไหนคะ?"), user("ทำคอนเทนต์ค่ะ")], "ราคาเท่าไหร่คะ");
  assert.equal(short.length, "short");
  assert.equal(short.messages, 3);
  const long = readChatStyle([user("ผมทำร้านอาหารอยู่ที่เชียงใหม่ครับ ตอนนี้มีพนักงานห้าคน อยากให้ AI ช่วยตอบแชทลูกค้าตอนกลางคืน เพราะช่วงนั้นไม่มีคนดูเลย ลูกค้าหายไปเยอะมาก"),
    user("แล้วก็อยากทำคอนเทนต์ลงเพจทุกวันด้วยครับ ตอนนี้ลงได้อาทิตย์ละครั้งเพราะไม่มีเวลาคิด ไม่รู้ว่าคลาสไหนเหมาะกับผมครับ ช่วยแนะนำหน่อย")]);
  assert.equal(long.length, "long");
});

test("สไตล์แชท: บรรทัดกติกาไม่สั่งตอบสั้นเฉย ๆ (ยังต้องมีคุณค่า + ก้าวถัดไป) · ไม่มีสัญญาณ = ว่าง", () => {
  const line = chatStyleRule(readChatStyle([user("2"), user("สนใจค่ะ 😊"), user("ราคาเท่าไหร่คะ 😊")]));
  assert.match(line, /พิมพ์สั้น/u);
  assert.match(line, /คุณค่าหนึ่งประโยค/u);
  assert.match(line, /อีโมจิ/u);
  assert.equal(chatStyleRule(null), "");
  assert.equal(chatStyleRule({ length: "medium", emoji: false, asksALot: false }), "");
});

test("ตัวให้คะแนนธุรกิจคอร์สไม่ขอ DISC แล้ว · ธุรกิจอื่นยังขอเหมือนเดิม", () => {
  const course = buildScorerSystem({ salesPolicy: COURSE_POLICY });
  assert.doesNotMatch(course, /"disc"/u);
  assert.doesNotMatch(course, /DISC\//u);
  assert.match(course, /"persona_read": \{"bank"/u);
  assert.match(buildScorerSystem({}), /"disc": "D"\|"I"\|"S"\|"C"\|"unknown"/u);
});

test("ผลให้คะแนนของธุรกิจที่เลิก DISC: ค่า disc = unknown + ธงติดไปถึง DB · ตัวทำให้นิ่งไม่พา C เก่าติดต่อ", () => {
  const raw = JSON.stringify({ score: 6, trend: "up", persona_read: { disc: "D", bank: "Action", reason: "ตอบสั้น ตัดสินใจเร็ว" } });
  const parsed = parseScorePayload(raw, { discRetired: true });
  assert.equal(parsed.persona_read.disc, "unknown");
  assert.equal(parsed.persona_read.bank, "Action");
  assert.equal(parsed.disc_retired, true);
  // อ่านซ้ำจาก DB (ไม่ส่ง option) ก็ยังเลิกอยู่
  assert.equal(parseScorePayload(JSON.stringify(parsed)).persona_read.disc, "unknown");
  const previous = { persona_read: { disc: "C", bank: "Knowledge", reason: "" }, persona_read_raw: { disc: "C", bank: "Knowledge" } };
  const stored = applyStablePersonaRead(parsed, previous);
  assert.equal(stored.persona_read.disc, "unknown");
  assert.equal(stored.persona_read_raw.disc, "unknown");
  // ธุรกิจที่ยังใช้ DISC ทำงานแบบเดิม
  assert.equal(applyStablePersonaRead(parseScorePayload(raw), previous).persona_read.disc, "C");
});

test("ข้อความทักตาม: ใช้สไตล์แชทแทน DISC · ผลเก่าที่ยังเป็น C ไม่ถูกใช้เมื่อเลิกแล้ว · ไม่ส่งสไตล์ = กติกาเดิม", () => {
  const oldPayload = { persona_read: { disc: "C", bank: "Knowledge", reason: "" } };
  const legacy = stagedRules({ stage: "warm", scorePayload: oldPayload });
  assert.match(legacy, /DISC\): C/u);
  const styled = stagedRules({ stage: "warm", scorePayload: oldPayload, chatStyle: "- สไตล์แชทของลูกค้า: ลูกค้าใช้อีโมจิ" });
  assert.doesNotMatch(styled, /DISC/u);
  assert.match(styled, /สไตล์แชทของลูกค้า/u);
  assert.doesNotMatch(stagedRules({ stage: "warm", scorePayload: { ...oldPayload, disc_retired: true } }), /DISC/u);
});

test("สไตล์แชท: ปุ่มเมนูสำเร็จรูปไม่นับเป็นสิ่งที่ลูกค้าพิมพ์ (รีวิว 4 ต.ค.)", () => {
  const phrases = ["คิดค่าบริการเท่าไหร่", "จองคิวได้ไหม"];
  const history = [user("คิดค่าบริการเท่าไหร่"), { role: "user", content: "จองคิวได้ไหม", fromPresetButton: true }, user("ผมทำร้านอาหารอยู่ที่เชียงใหม่ครับ อยากให้ AI ช่วยตอบแชทลูกค้าตอนกลางคืนเพราะไม่มีคนดู")];
  assert.equal(readChatStyle(history, "", { presetPhrases: phrases }), null, "เหลือข้อความที่พิมพ์เองแค่ 1 ข้อความ = ยังไม่พอ");
  const style = readChatStyle(history, "แล้วอยากลงคอนเทนต์ทุกวันด้วยครับ ตอนนี้ลงได้อาทิตย์ละครั้งเพราะไม่มีเวลาคิดเลย", { presetPhrases: phrases });
  assert.notEqual(style.length, "short");
  assert.equal(style.asksALot, false);
});
