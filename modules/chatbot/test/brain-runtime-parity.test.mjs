// brain-runtime-parity.test.mjs — ด่านของเฟส 2
//
// แบบแปลน §11 P2 บอก proof ไว้ตรง ๆ: "hash prompt 50 เทิร์น byte-equal กับ legacy"
// และ §11 กติกาข้อ (1): รายการใดที่เปลี่ยนไบต์ที่โมเดลเห็น = release ของตัวเอง —
// ห้ามซุกใต้คำว่า "ไม่เปลี่ยนพฤติกรรม" เฟสนี้จึงต้องพิสูจน์ว่า **ไม่เปลี่ยนเลยสักไบต์**
//
// วิธีพิสูจน์: รันไปป์ไลน์จริง 50 เทิร์นสองรอบบนข้อมูลชุดเดียวกันเป๊ะ (ต่างกันแค่แฟล็ก)
// แล้วเทียบ `messages[]` ที่ถูกส่งออกไปจริงจาก hermesBridge — ไม่ใช่เทียบชิ้นส่วนที่
// ประกอบเอง เพราะความผิดที่เหมือนกันสองฝั่งจะไม่มีวันถูกจับได้ · ไม่มีการเรียกโมเดลจริง
// (fetch ถูก poison ทั้งไฟล์ · stub คืนข้อความคงที่)
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { CAMPAIGN_RECEIPT_POLICY } from "../src/campaignReceiptPolicy.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";
import { importCurrentSourcesAsVersion1 } from "../src/brain/import.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";
import { FREECLASS_PATTERNS_KEY } from "../src/db.mjs";
import { QUESTION_ENDING, REPLY_CLOSING_QUESTION_KEY } from "../src/replyClosingQuestion.mjs";
import { announcedRoundsLines, todayRoundsLine, upcomingRounds } from "../src/classRounds.mjs";
import { NATURAL_VOICE_RULE } from "../src/conversationStyle.mjs";
import { genericAddressRule } from "../src/customerAddress.mjs";
import { buildReplyFocusRules } from "../src/conversationFocus.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
// นาฬิกาเดียวทั้งไฟล์ และเป็นนาฬิกาจริง: ค่าที่ตรึงไว้ในอดีตจะทำให้หน้าต่างเวลาของ
// ไปป์ไลน์ (dedupe รูป 7 วัน ฯลฯ) ทำงานคนละแบบกับของจริง แล้ว corpus นี้จะวัดของน้อยลง
const CLOCK = Date.now();
const REPLY = "รับทราบค่ะ เดี๋ยวลูกแพรดูให้นะคะ";

const PACK = [
  "LUKPRAE_BRAIN_PACK_JSON_V1",
  JSON.stringify({ entries: [
    { id: "agent", titleTh: "AI Agent for Business", answerTh: "รายละเอียดคลาส Agent ค่ะ", tags: ["AI Agent for Business"], questionPatterns: [] },
    { id: "workflow", titleTh: "AI Workflow Automation", answerTh: "รายละเอียดคลาส Workflow ค่ะ", tags: ["AI Workflow Automation"], questionPatterns: [] },
    { id: "venue", titleTh: "ที่จอดรถและการเดินทาง", answerTh: "จอดฟรี 2 ชั่วโมงที่อาคาร B ค่ะ", tags: ["จอดรถ"], questionPatterns: [] },
  ] }),
  "END_LUKPRAE_BRAIN_PACK_JSON_V1",
].join("\n");

// รอบเรียนอยู่ในไฟล์ (ไม่ใช่ที่กรอกเอง) เพื่อให้ทั้งสองทางต้องผ่านเส้น readRoundsFile
// เหมือนกัน และ importer ปักหมุด sha ของไฟล์ลง manifest ตามที่ instance จริงทำ
const ROUNDS = {
  seatsPerRound: 20,
  classes: {
    onsite: { label: "รอบสอนสด", product: "AI Agent for Business" },
    online: { label: "รอบออนไลน์", product: "AI Workflow Automation" },
  },
  rounds: [
    { date: "2099-01-10", class: "onsite", status: "open" },
    { date: "2099-02-20", class: "onsite", status: "open" },
    { date: "2099-03-05", class: "online", status: "open" },
  ],
};

// คลังจริงมีทั้งความรู้กลาง ความรู้เฉพาะสาขา ราคาหลายรายการ กติกาหลายบรรทัด ป้ายลูกค้า
// ลิงก์คลาสฟรี และคีย์เวิร์ดกิจกรรม — ทั้งหมดคือสิ่งที่เฟสนี้ย้ายทางอ่าน
function seedRealisticDb(db) {
  db.addKnowledge({ title: "แคตตาล็อกคลาสและราคา", content: "AI Agent for Business 19,900 บาท\nEarly Bird 12,900 บาท", updatedBy: "owner" });
  db.addKnowledge({ title: "วิธีสมัคร", content: "ทักแชทแล้วทีมงานส่งลิงก์ชำระเงินให้ค่ะ", updatedBy: "owner" });
  db.addKnowledge({ title: "ที่จอดรถและการเดินทาง", content: "จอดฟรี 2 ชั่วโมงที่อาคาร B ใกล้ BTS", updatedBy: "chomphu" });
  const off = db.addKnowledge({ title: "โปรเก่าที่ปิดแล้ว", content: "โปรปีที่แล้ว", updatedBy: "owner" });
  db.updateKnowledge(off.id, { active: false, updatedBy: "owner" });
  db.addKnowledge({ title: "สำนวนเฉพาะเฟซบุ๊ก", content: "ตอบสั้นและมี quick reply", updatedBy: "owner", channelId: "facebook" });

  db.setApprovedPrice("AI Agent for Business", 19900);
  db.setApprovedPrice("Early Bird", 12900);
  db.setApprovedPrice("คลาสออนไลน์", 11900);

  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ\n- ห้ามเสนอส่วนลดเองทุกกรณี\nคลาสออนไลน์ไม่มีที่นั่งจำกัด");
  db.setSetting(FREECLASS_PATTERNS_KEY, JSON.stringify(["https://line.me/freeclass"]));
  db.setSetting("hashtag_business_keywords", JSON.stringify({ "#online": "สนใจคลาสเรียนออนไลน์" }));
  db.setSetting("hashtag_silence", "0");
  db.setSetting("class_enrolled", JSON.stringify({ "2099-01-10": 20, "2099-02-20": 7 }));
}

// 50 เทิร์น = 10 ห้อง × 5 เทิร์น — ตั้งใจให้มีทั้งคำถามราคา รอบเรียน สถานที่ ขอรูป
// คำรับสั้น (เส้น continuation) คำถามองค์กร (เส้นกติกาสินค้า) และคีย์เวิร์ดกิจกรรม
const TURN_TEXTS = [
  "สนใจคลาส AI Agent for Business ค่ะ",
  "ราคาเท่าไหร่คะ",
  "รอบไหนยังมีที่นั่งบ้างคะ",
  "ที่จอดรถเป็นยังไงบ้างคะ",
  "ครับ",
];
const CORPUS = Array.from({ length: 10 }, (_, room) => TURN_TEXTS.map((text, index) => ({
  customerId: `U-parity-${String(room).padStart(2, "0")}`,
  text: room % 3 === 0 && index === 3 ? "ขอดูรูปคลาสหน่อยค่ะ" : text,
}))).flat();

function writeRoundsFile() {
  const dir = mkdtempSync(join(tmpdir(), "brain-runtime-parity-"));
  const file = join(dir, "class-rounds.json");
  writeFileSync(file, JSON.stringify(ROUNDS), "utf8");
  return file;
}

/** รัน 50 เทิร์นแล้วคืน "ข้อความที่โมเดลเห็นจริง" ของทุกเทิร์น */
async function runCorpus({ versioned = false, closingQuestion = null } = {}) {
  const roundsFile = writeRoundsFile();
  const db = memoryDb({ now: () => CLOCK });
  seedRealisticDb(db);
  // สวิตช์คำถามปิดท้าย (คำสั่งพี่ง้วง 13 ก.ย.): null = ไม่มีแถว = ค่าเริ่มต้นของระบบ (on)
  if (closingQuestion) db.setSetting(REPLY_CLOSING_QUESTION_KEY, closingQuestion);
  // นำเข้าสมองทั้งสองรอบเสมอ — ตัวแปรเดียวที่ต่างกันคือ "runtime อ่านจากไหน"
  // (ถ้ารอบ legacy ไม่มีตารางสมอง เราจะเทียบสองฐานที่ไม่เหมือนกันแล้วเรียกว่า parity)
  importCurrentSourcesAsVersion1(db, { now: () => CLOCK, classRoundsFile: roundsFile, logger: silent });

  const hermesFetch = hermesFetchStub(REPLY);
  const app = createApp({
    config: testConfig({
      BRAND_PACK: PACK,
      CLASS_ROUNDS_FILE: roundsFile,
      HISTORY_TURNS: "6",
      ...(versioned ? { BRAIN_READ: "versioned", KNOWLEDGE_VERSIONED: "true" } : {}),
    }),
    db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });

  for (const turn of CORPUS) {
    db.upsertCustomer(turn.customerId, {});
    await app.pipeline.handleInboundText({ customerId: turn.customerId, text: turn.text, replyToken: "rt" });
  }
  const prompts = hermesFetch.calls
    .filter((call) => Array.isArray(call.body?.messages))
    .map((call) => JSON.stringify(call.body.messages));
  const cacheKeys = hermesFetch.calls.map((call) => call.body?.prompt_cache_key ?? "");
  db.close();
  return { prompts, cacheKeys, app };
}

const sha = (parts) => createHash("sha256").update(parts.join(" ")).digest("hex");

test("50 เทิร์น: prompt ที่โมเดลเห็นเหมือนกันทุกไบต์ ทั้งเปิดและปิด BRAIN_READ", async () => {
  const legacy = await runCorpus({ versioned: false });
  const versioned = await runCorpus({ versioned: true });

  assert.equal(legacy.prompts.length, CORPUS.length, "ทุกเทิร์นต้องถึงโมเดล ไม่งั้นด่านนี้วัดของน้อยกว่าที่คิด");
  assert.equal(versioned.prompts.length, legacy.prompts.length);
  for (const [index, prompt] of legacy.prompts.entries()) {
    assert.equal(versioned.prompts[index], prompt, `เทิร์นที่ ${index + 1} ไบต์ไม่ตรง — ${CORPUS[index].text}`);
  }
  assert.equal(sha(versioned.prompts), sha(legacy.prompts));
});

// ด่าน "ปิดแฟล็กแล้วไม่มีอะไรเปลี่ยน" ต้องเทียบกับ **โค้ดก่อนเฟสนี้** ไม่ใช่กับตัวเอง:
// ค่านี้คำนวณจาก corpus ชุดเดียวกันบนโค้ดก่อนเฟส 2 แล้วตรึงไว้ — ยืนยันซ้ำสองฐาน:
// c458187d (เฟส 1a live บนเครื่องจริง) และ 883a4eba (ฐานหลังซ่อมชุดเทสต์) ให้ค่าเดียวกัน
// แก้ค่านี้ได้ต่อเมื่อ "ตั้งใจ" เปลี่ยนไบต์ที่โมเดลเห็น ซึ่งแบบแปลนบังคับให้เป็น release
// ของตัวเองพร้อมป้าย "เปลี่ยนพฤติกรรม" — ไม่ใช่การอัปเดตตัวเลขให้เทสต์เขียว
//
// หมุนค่าครั้งที่ 1 — 2026-09-04 "จังหวะราคาจุดเดียว" (release เปลี่ยนพฤติกรรมโดยเจตนา)
//   ค่าเดิมก่อนหมุน (ของที่ใช้อยู่จริงบนเครื่อง): 010a27ab5a04496c5ce08a573879b0f42ce3f361fa427223e225137d61861b0e
//   (ร่างแรกของงานนี้เคยตั้งค่าไว้ที่ 571d4b24b86b966daec67fde7167290c206b74865b62cc58541efc38c3571116
//    ก่อนปิดข้อบกพร่อง 14 ข้อจากการตรวจปรปักษ์ ค่านั้นไม่เคยถูกปล่อยออกไป ทิ้งได้)
//   สิ่งที่เปลี่ยน: คำสั่งเรื่อง "จังหวะราคา" ย้ายมาตัดสินที่ src/priceDisclosure.mjs จุดเดียว
//   ทั้งพรอมต์ (เดิมกระจายอยู่ ~39 บรรทัดจากตัวประกอบ 5 ตัวใน 3 โมดูล แล้วสั่งสวนกันเอง)
//
// หมุนค่าครั้งที่ 2 — 2026-09-04 "ด่านกันคำสั่งสวนกันแบบครบถ้วน + สัญญาณมีโครงสร้าง"
//   ค่าเดิมก่อนหมุน: b9174f08439d920a97a9c6674b139daea5de7a222a53b7719319e1659c9b7d61
//
//   สามอย่างที่เปลี่ยนไบต์ที่โมเดลเห็น:
//     1. ตัวอ่าน "เรารู้จักเขาแล้ว" ที่เป็น regex ภาษาไทยเขียนมือ 5 ตัว (named_class /
//        answered_ladder / told_headcount / told_project_context / told_us_their_work)
//        ถูกลบทั้งชุด แล้วแทนด้วยสัญญาณมีโครงสร้าง (known_name / known_context_at /
//        pain_point + persona_type ของ scorer) — regex ชุดนั้นจับประโยคเปิดมาตรฐานของ
//        ลีดทุกคน ("อยากใช้ AI" / "ขอถามข้อมูล") แล้วเทราคาใส่คนแปลกหน้าตั้งแต่ข้อความแรก
//     2. กติกา "ถ้าไม่มีข้อมูลให้บอกว่าขอเช็คกับทีมก่อน" เชื่อฟังคำตัดสินแล้ว — เทิร์นที่
//        ยังไม่ถึงจังหวะราคาได้ฉบับ "ตัวเลขทุกตัวต้องมาจากตารางราคาที่อนุมัติแล้วเท่านั้น" แทน
//     3. สาขา cold ที่สั่ง "ห้ามยื่นตัวเลขราคาให้เอง" ไม่ยิงพร้อมบล็อก "ติดค้างราคา" อีกแล้ว
//        และกติกาส่วนลดใน pipeline แยกฉบับตามแกนโปรโมชั่น ไม่ใช่ตามโหมดอย่างเดียว
//
//   ขอบเขตของ diff (วัดจาก corpus 50 เทิร์นชุดเดียวกัน หลังหมุน):
//     - 10 เทิร์น "ราคาเท่าไหร่คะ" เปลี่ยนจาก "แจ้งราคา" เป็น "คัดกรองหนึ่งข้อ" — เป็นผล
//       โดยตรงของข้อ 1: ห้องพวกนี้มีแค่ "สนใจคลาส AI Agent for Business ค่ะ" อยู่ในประวัติ
//       ซึ่งคือการเอ่ยชื่อสินค้า ไม่ใช่การบอกอะไรเกี่ยวกับตัวเขา (นโยบายข้อ 1 ของพี่ง้วง)
//     - 30 เทิร์นถือกติกา "ถ้าไม่มีข้อมูลให้บอกว่าขอเช็คกับทีมก่อน" (เทิร์นที่ประตูราคาเปิด)
//       และ 20 เทิร์นถือฉบับที่ไม่มีวลีนั้น (เทิร์นที่ยังไม่ถึงจังหวะ) — เดิม 50/50 ถือฉบับ
//       ที่มีวลีนั้นทุกเทิร์น รวมถึงเทิร์นคัดกรองที่แบนวลีนี้ด้วยชื่ออยู่ห่างกันไม่กี่บรรทัด
//     - ไม่มีเทิร์นไหนถือคำสั่งสองข้างของแกนเดียวกันอีกแล้ว (ยืนยันด้วย
//       test/price-directive-contradiction.test.mjs ซึ่งตอนนี้ตรวจ "ทุกบรรทัดที่พูดเรื่องเงิน
//       ต้องประกาศข้าง" ไม่ใช่เทียบกับรายการวลีที่เขียนมือไว้)
//     - ข้อความฝั่ง user/assistant ไม่เปลี่ยนสักเทิร์นเดียว และไม่มีบรรทัดเรื่องอื่น
//       (น้ำเสียง รูปภาพ รอบเรียน ป้ายลูกค้า ความรู้) เปลี่ยนเลย
// หมุนค่าครั้งที่ 3 — 2026-09-04 "ปิดหกต้นเหตุจากการตรวจปรปักษ์รอบที่ห้า"
//   ค่าเดิมก่อนหมุน: 41880c427136825e7e174e817d6d0d321253e9d42963ef56e3b0d2e4ba324267
//
//   สิ่งที่เปลี่ยนไบต์ที่โมเดลเห็นใน corpus นี้มี **บรรทัดเดียว** — กติกา "ห้ามแต่งตัวเลข"
//   ใต้หัวข้อ "กติกาที่ห้ามละเมิดเด็ดขาด" ของ pipeline:
//     เดิม 30 เทิร์น (เทิร์นที่ประตูราคาเปิด) ถือฉบับ "...ถ้าไม่มีข้อมูลให้บอกว่าขอเช็คกับทีมก่อน"
//     และ 20 เทิร์นถือฉบับที่ไม่มีวลีนั้น — รอบก่อนแก้ผิดข้าง เพราะเคสจริงที่พังคือ
//     ความล้มเหลว v1.4.39 ("ขอลูกแพรเช็คตัวเลขกับทีมงานอีกครั้งนะคะ") ซึ่งเกิดกับลูกค้าที่
//     *ต่อรองราคาต่ำกว่าตาราง* = เทิร์นแจ้งราคาพอดี และเทิร์นนั้นแบก "ห้ามหลบ ห้ามบอกให้
//     รอทีมงาน" อยู่ด้วย จึงสวนกับตัวเอง
//     ตอนนี้ทั้ง 50 เทิร์น (นอกโหมดเทรน) ถือฉบับเดียวกัน: "ตัวเลขทุกตัวต้องมาจากตารางราคา
//     ที่อนุมัติแล้วเท่านั้น และตารางนั้นคือคำตอบสุดท้าย ห้ามบอกว่าขอเช็คกับทีมก่อน"
//
//   ของอีกห้าข้อในงานรอบนี้ (แกน volunteerPrice, หมุด pivot ที่นับเป็นการเลี่ยง,
//   กับดัก "บาท" ใน "บทบาท", ความหงุดหงิดที่ต้องมีสถานะรองรับ, ปักหมุดราคาบนเส้นเชิงรุก)
//   วัดแล้วไม่เปลี่ยนไบต์ของ corpus นี้เลยสักเทิร์น: 10 ห้องนี้ไม่มีเทิร์นที่ pivot ไปคลาส
//   ออนไลน์ ไม่มีถ้อยคำหงุดหงิด ไม่มีเทิร์นที่ประตูราคาเปิดโดยไม่ติดค้าง (30 เทิร์นที่ประตู
//   เปิดคือเทิร์นที่ owed ทั้งหมด → volunteerPrice จริงทุกเทิร์น ฉบับของกติกาจึงเหมือนเดิม)
//   และหมุด price_quoted_at บนเส้น follow-up ไม่ได้อยู่ในพรอมต์
// 2026-09-13: owner-authorized reply experience behavior release.
// Previous: 2e4f9918efb0fd00e0590cbfd1a8339bd589c17b9f2e3d393f41d51370489373
// Compared the same mocked 50-turn corpus against d1daaff142a8: all 50 changed
// only in reply guidance (latest question first, optional questions, no score-only
// pitch, concise empathy framing). No knowledge/prices changed. Versioned and
// legacy assemblies remain byte-identical across all 50 turns.
// 15 Sep owner-requested behavior release (Chompoo feedback): all 50 turns gain the
// latest-topic rule; owed-price wording stops treating a price answer as a booking pitch.
// Before fa0aac61d705617d802c2ceb7650099f55215e97992b8a14b96141b4b1588b06.
// Corpus diff: exactly two added lines and one replaced line; no other prompt changes.
// 23 Sep owner-requested # campaign no-chasing policy. Each prompt gains only
// this shared block; stripping it must recover the previous frozen corpus.
const PRE_CAMPAIGN_PROMPT_SHA256 = "87f94652e33ee685d3083915fbbac474796274f024c57107ca1887f43872f05d";
const BASE_PROMPT_SHA256 = "f6cd79278364af58453fa123e9823a44680ea59bc8437c90c6a3f3a9e68ba345";

// 28 Sep owner-requested closing-question release (reply_closing_question, default on):
// the frozen corpus below is pinned with the switch OFF — off must stay byte-identical to the
// previous release. The ON corpus is proven in the next test: swapping the three on-variants back
// to their off-variants must recover this exact frozen hash (no other prompt bytes change).
// 28 Sep owner-requested rounds changes: every turn gains one contiguous rounds block right before the
// seat lines — (1) one "today" line (todayRoundsLine; the reply prompt never carried a date, so past
// rounds could not be told apart) and (2) the announced-rounds list read live from the "ที่นั่ง" page
// (announcedRoundsLines; the owner made that page the only place to enter rounds). The today line
// follows the real clock (CLOCK is Date.now()), so the frozen hashes are checked with exactly that
// block stripped once per turn; nothing else may change.
// วันของไปป์ไลน์อ่านนาฬิกาจริงทุกเทิร์น — รันคร่อมเที่ยงคืนได้สองวัน จึงรับได้ทั้งวันก่อนและหลังรัน
const bangkokToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
async function runCorpusDated(options) {
  const first = bangkokToday();
  const result = await runCorpus(options);
  return { ...result, days: [...new Set([first, bangkokToday()])] };
}
// รายการรอบที่ corpus ควรเห็น — ประกอบจากไฟล์รอบ + จำนวนลงทะเบียนชุดเดียวกับ seedRealisticDb
function corpusAnnouncedLines(todayIso) {
  const db = memoryDb({ now: () => CLOCK });
  seedRealisticDb(db);
  try {
    return announcedRoundsLines(upcomingRounds({ file: writeRoundsFile(), db, todayIso, logger: silent }));
  } finally {
    db.close();
  }
}
function withoutTodayLine({ prompts, days }) {
  const additions = days.map((day) => JSON.stringify(`\n${[todayRoundsLine(day), ...corpusAnnouncedLines(day)].join("\n")}`).slice(1, -1));
  return prompts.map((prompt, index) => {
    const hits = additions.filter((addition) => prompt.split(addition).length === 2);
    assert.equal(hits.length, 1, `เทิร์นที่ ${index + 1} ต้องมีก้อนวันนี้ + รายการรอบหนึ่งครั้งพอดี`);
    return prompt.replace(hits[0], "");
  });
}

// 2026-10-02 owner-authorized reply experience release: the lead-context block is
// new reply guidance, not a Brain runtime change. Keep the pre-release hash useful
// by stripping only this exact unknown-score block used by this frozen corpus.
// Each corpus customer has no saved score, so accepting a generic score regex here
// would hide a change to the released guidance or an accidental per-turn variation.
const REPLY_LEAD_CONTEXT_UNKNOWN = `\n${[
  "[คะแนนประกอบการตอบ — ใช้ภายใน ห้ามบอกคะแนนหรือ stage ให้ลูกค้า]",
  "ยังไม่มีคะแนนความสนใจที่ใช้ได้ (unknown); ห้ามเดาว่าลูกค้าไม่สนใจ",
  "คะแนนเป็นข้อมูลก่อนหน้า scorer อาจยังไม่ประเมินข้อความล่าสุด ต้องอ่านเจตนาและบริบทล่าสุดทุกครั้ง cold: ช่วยให้เห็นความเหมาะโดยไม่ซักถามเป็นชุด; warm: ให้รายละเอียดและหลักฐานที่ตรงโจทย์; hot: ตอบข้อสงสัยสุดท้ายและช่วยขั้นตอนที่ลูกค้าต้องการ คำขอชัดเจนให้ทำตามได้โดยไม่รอคะแนนเพิ่ม คะแนนสูงไม่อนุญาตให้เร่งขายหลังขอพักหรือส่งข้อมูลซ้ำ คะแนนไม่เปลี่ยนกติกาข้อมูลอนุมัติ ราคา การชำระเงิน และการส่งต่อคน คะแนนความสนใจไม่ใช่คะแนนคุณภาพลูกค้าหรือคุณภาพคำตอบ",
].join("\n")}`;

// The two current style lines are also an intentional 2026-10-02 behavior change.
// Normalize each exact current form to 494746ca so the frozen baseline still catches
// any prompt byte outside the approved release delta.
const OCT2_STYLE_DELTAS = Object.freeze([
  {
    current: "- ปกติใช้ 1–2 บับเบิล; เรื่องซับซ้อนหรือมีลิงก์ใช้ได้ถึง 3–4 บับเบิล ลิงก์รีวิว/ลิงก์สมัครต้องอยู่ย่อหน้าของตัวเอง (เว้นบรรทัดว่างก่อน-หลัง) ถ้ามีคำถามที่จำเป็นให้วางไว้ย่อหน้าสุดท้ายของตัวเอง และห้ามแยกคำรับสั้น ๆ เป็นบับเบิลเดี่ยว",
    previous: "- ปกติใช้ 1–2 บับเบิล; เรื่องซับซ้อนหรือมีลิงก์ใช้ได้ถึง 3–4 บับเบิล ลิงก์รีวิว/ลิงก์สมัครต้องอยู่ย่อหน้าของตัวเอง (เว้นบรรทัดว่างก่อน-หลัง) คำถามปิดท้ายอยู่ย่อหน้าสุดท้ายของตัวเอง และห้ามแยกคำรับสั้น ๆ เป็นบับเบิลเดี่ยว",
  },
  {
    // 2026-10-03: เติม "(ร้อยเข้ากับประโยคที่เสนอ ไม่แยกเป็นประโยคทวน)" — งานน้ำเสียงคนคุยแชทที่พี่ง้วงอนุมัติ
    current: "- ห้ามถามชื่อลูกค้าเพื่อหาเรื่องชวนคุย; ใช้ชื่อที่ระบบยืนยันได้เฉพาะจังหวะที่เป็นธรรมชาติและเป็นครั้งคราว (ไม่ต้องเรียกทุกข้อความ) และก่อนเสนอทางออกให้สะท้อนโจทย์/ความกังวลที่ลูกค้าเพิ่งบอกจริงแบบสั้น ๆ (ร้อยเข้ากับประโยคที่เสนอ ไม่แยกเป็นประโยคทวน) ห้ามใช้ประโยคเห็นใจสำเร็จรูปที่ไม่อิงบริบท",
    previous: "- ห้ามถามชื่อลูกค้าเพื่อหาเรื่องชวนคุย (ใช้ชื่อที่ระบบให้มาได้ตามปกติ)",
  },
]);

// 2026-10-03 (พี่ง้วงอนุมัติ: "ตอบแชทแข็งเกินไป ช่วยปรับให้หน่อย"): กติกาน้ำเสียงคนคุยแชทหนึ่งบรรทัด
// และบรรทัดชื่อของห้องที่ไม่มีชื่อเรียกได้ (เลิกสั่งให้เรียก "คุณลูกค้า") — ทุกเทิร์นใน corpus เป็นห้องไม่มีชื่อ
// จึงต้องพบทั้งสองอย่างหนึ่งครั้งพอดี แล้วคืนเป็นรูปเดิมให้ hash ฐานยังจับไบต์อื่นที่เปลี่ยนโดยไม่ตั้งใจได้
const OCT3_VOICE_DELTAS = Object.freeze([
  {
    current: `- ตอบสิ่งที่ลูกค้าถามก่อน ไม่ต้องเกริ่นรับเรื่องทุกครั้ง และห้ามทวนข้อมูลที่เพิ่งตอบไป\n${NATURAL_VOICE_RULE}`,
    previous: "- ตอบสิ่งที่ลูกค้าถามก่อน ไม่ต้องเกริ่นรับเรื่องทุกครั้ง และห้ามทวนข้อมูลที่เพิ่งตอบไป",
  },
  {
    current: genericAddressRule(),
    previous: "- ชื่อที่ใช้เรียกลูกค้าคนนี้คือ \"คุณลูกค้า\" — ใช้คำนี้ตรงตัว ห้ามดัดแปลงหรือเดาชื่ออื่น\n"
      + "- ต้องเรียกชื่อลูกค้าในจังหวะทักทาย จังหวะเสนอทางเลือก และจังหวะชวนตัดสินใจ "
      + "ส่วนประโยคอื่น ๆ ไม่ต้องเรียกซ้ำ และห้ามถามชื่อลูกค้าเพื่อหาเรื่องคุยต่อ",
  },
]);

// รีวิว 2026-10-03 รอบ 4: corpus อ่านถ้อยคำ "ปัจจุบัน" ของสามบรรทัดนี้จากซอร์สเอง จึงจับการแก้ที่ไม่ได้อนุมัติไม่ได้
// และ corpus ไม่มีเทิร์นเปิดห้องด้วยคำตอบสั้น — ตรึงไบต์ที่พี่ง้วงอนุมัติ ("ตอบแชทแข็งเกินไป ช่วยปรับให้หน่อย") ไว้ตรงนี้
// แก้ถ้อยคำเหล่านี้ = ต้องได้อนุมัติแล้วอัปเดต sha ที่นี่พร้อมบันทึกเหตุผล
const APPROVED_OCT3_PROMPT_SHA256 = Object.freeze({
  naturalVoice: "05ec75f3e23f555314302b61bba684592da298cd3e5a11ad710cb78cf47a239e",
  genericAddress: "f922e53a4968374f0c1f22c306c27fe699298c4428c551533b8d890a38ff0330",
  closingQuestionOn: "54e93a37efba494c638f6e5ef4ba264312c40ba3c33aa7f74494c8f5444467d9",
  openingNumber: "98f3a8b501b778615fe2e271a7c4a61115c9eb420eac73b40464dd8d1c9272d1",
  openingPositive: "5ecca8ec61cc23a51022bf7ead22bd9712728eb473dbff45f71f974dbb0ec02f",
  openingNegative: "1f87cc2517117d69e24c0d3b325a3f0f1e3bc27c99761d7c92af7b2074b423d6",
});

test("ถ้อยคำน้ำเสียงที่อนุมัติ 3 ต.ค. ตรึงด้วย sha256 (corpus อ่านถ้อยคำปัจจุบันจากซอร์ส จึงไม่จับเอง)", () => {
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const opening = (text) => buildReplyFocusRules({ text, history: [] }).at(-1);
  assert.deepEqual({
    naturalVoice: hash(NATURAL_VOICE_RULE),
    genericAddress: hash(genericAddressRule()),
    closingQuestionOn: hash(QUESTION_ENDING.general.on),
    openingNumber: hash(opening("3")),
    openingPositive: hash(opening("เคยค่ะ")),
    openingNegative: hash(opening("ยังค่ะ")),
  }, APPROVED_OCT3_PROMPT_SHA256);
});

function replaceExactlyOnce(prompt, current, previous, label, index) {
  const encodedCurrent = JSON.stringify(current).slice(1, -1);
  const count = prompt.split(encodedCurrent).length - 1;
  assert.equal(count, 1, `เทิร์นที่ ${index + 1} ต้องมี ${label} ที่อนุมัติหนึ่งครั้งพอดี`);
  return prompt.replace(encodedCurrent, JSON.stringify(previous).slice(1, -1));
}

function withoutApprovedOct2ReplyDelta(prompts) {
  return prompts.map((initial, index) => {
    let prompt = replaceExactlyOnce(initial, REPLY_LEAD_CONTEXT_UNKNOWN, "", "replyLeadContext", index);
    for (const [deltaIndex, delta] of OCT2_STYLE_DELTAS.entries()) {
      prompt = replaceExactlyOnce(prompt, delta.current, delta.previous, `style delta ${deltaIndex + 1}`, index);
    }
    for (const [deltaIndex, delta] of OCT3_VOICE_DELTAS.entries()) {
      prompt = replaceExactlyOnce(prompt, delta.current, delta.previous, `voice delta ${deltaIndex + 1}`, index);
    }
    return prompt;
  });
}

test("ปิดแฟล็ก = ไบต์เดียวกับก่อนเฟส 2 (ตรึงกับ c458187d และ 883a4eba)", async () => {
  const prompts = withoutApprovedOct2ReplyDelta(withoutTodayLine(await runCorpusDated({ versioned: false, closingQuestion: "off" })));
  assert.equal(sha(prompts), BASE_PROMPT_SHA256);
  const addition = JSON.stringify(`\n${CAMPAIGN_RECEIPT_POLICY}`).slice(1, -1);
  for (const prompt of prompts) assert.equal(prompt.split(addition).length, 2);
  assert.equal(sha(prompts.map(prompt => prompt.replace(addition, ""))), PRE_CAMPAIGN_PROMPT_SHA256);
});

test("คำถามปิดท้าย (ค่าเริ่มต้น on): ต่างจาก corpus ที่ตรึงไว้เฉพาะสามท่อนคำถาม — สลับกลับแล้วได้ไบต์เดิมทุกเทิร์น", async () => {
  const on = { prompts: withoutTodayLine(await runCorpusDated({ versioned: false })) };
  const off = { prompts: withoutTodayLine(await runCorpusDated({ versioned: false, closingQuestion: "off" })) };
  const esc = (value) => JSON.stringify(value).slice(1, -1);
  const back = (prompt) => Object.values(QUESTION_ENDING)
    .reduce((text, pair) => text.split(esc(pair.on)).join(esc(pair.off)), prompt);
  assert.equal(on.prompts.length, CORPUS.length);
  let changed = 0;
  for (const [index, prompt] of on.prompts.entries()) {
    if (prompt !== off.prompts[index]) changed += 1;
    assert.equal(
      withoutApprovedOct2ReplyDelta([back(prompt)])[0],
      withoutApprovedOct2ReplyDelta([off.prompts[index]])[0],
      `เทิร์นที่ ${index + 1} ต่างเกินสามท่อนคำถามหรือ release 2 ต.ค. — ${CORPUS[index].text}`,
    );
  }
  assert.equal(sha(withoutApprovedOct2ReplyDelta(on.prompts.map(back))), BASE_PROMPT_SHA256);
  assert.ok(changed >= 20, `เทิร์นปกติต้องได้คำถามปิดท้าย (เปลี่ยน ${changed} เทิร์น)`);
  // เทิร์นคัดกรองราคา "ราคาเท่าไหร่คะ" ของคนแปลกหน้า = คำถามคัดกรองคือคำถามเดียวอยู่แล้ว — ห้ามแตะ
  for (const [index, turn] of CORPUS.entries()) {
    if (turn.text === "ราคาเท่าไหร่คะ") assert.equal(on.prompts[index], off.prompts[index], `เทิร์นคัดกรองที่ ${index + 1} ต้องไม่เปลี่ยน`);
  }
});

test("prompt_cache_key หมุนตามรุ่นสมองเมื่อเปิดแฟล็ก และคงเดิมเมื่อปิด", async () => {
  const legacy = await runCorpus({ versioned: false });
  const versioned = await runCorpus({ versioned: true });

  assert.ok(legacy.cacheKeys.every((key) => key === "lukprae-hermes"), "ปิดแฟล็ก = คีย์เดิมทุกไบต์");
  const keys = new Set(versioned.cacheKeys);
  assert.equal(keys.size, 1, "รุ่นเดียว = คีย์เดียว (หมุนตอนเผยแพร่ ไม่ใช่ทุกเทิร์น)");
  const key = [...keys][0];
  assert.match(key, /^pngoung-tidkradum-[0-9a-f-]{36}$/u, `คีย์ต้องเป็น <tenant>-<versionId> แต่ได้ ${key}`);
  assert.notEqual(key, "lukprae-hermes");
});

/* ------------------------------ canary ต่อรุ่น ------------------------------ */
// แบบแปลน §7 "Canary / shadow": ตั้งแต่ P2 guard อ่าน `bundle.guards.*` ของเวอร์ชันที่
// ประกอบ prompt เทิร์นนั้น พร้อมด่านคู่ที่เขียนไว้ตรง ๆ —
//   ลูกค้าฝั่ง canary พูดราคาที่มีเฉพาะใน canary = ไม่ถูกตัด
//   ลูกค้าฝั่ง live  พูดราคานั้น = ถูกตัด
// ถ้าไม่มีคู่นี้ "guard อ่านจาก bundle" จะพิสูจน์ไม่ได้เลยว่าอ่านของรุ่นไหน

const CANARY_LABEL = "โปรลับรอบทดลอง";
const CANARY_AMOUNT = 8700;
const CANARY_TESTER = "U-canary-tester";
const LIVE_ROOM = "U-live-room";
// สองประโยค: ประโยคแรกมีตัวเลข ประโยคที่สองปลอดภัยเสมอ — ฝั่งที่ถูกตัดจะเหลือประโยคหลัง
const DRAFT_WITH_CANARY_PRICE = "ตอนนี้มีโปรพิเศษ 8,700 บาทค่ะ รบกวนแจ้งชื่อกับเบอร์ติดต่อกลับด้วยนะคะ";

function publishCanaryWithExtraPrice(db) {
  const live = db.getBrainPointer("live");
  const manifest = JSON.parse(live.manifest_json);
  const rev = db.appendBrainRev({
    itemId: `price:${CANARY_LABEL}`, kind: "price", key: `price:${CANARY_LABEL}`,
    body: { label_th: CANARY_LABEL, amount: CANARY_AMOUNT, kind: "normal" },
    scope: { channel: "*" }, confidence: "needs_owner_confirm",
    provenance: { source: "test:canary" }, createdBy: "test", createdAt: CLOCK + 1_000,
  });
  const version = db.createBrainVersion({
    parentId: live.version_id, label: "รุ่นทดลอง (ราคาใหม่)", status: "draft",
    revIds: [...manifest.revIds, rev.rev_id],
    pinnedFiles: manifest.pinnedFiles, lintAllowlist: manifest.lintAllowlist, counts: manifest.counts,
    codeContract: live.code_contract, createdBy: "test", createdAt: CLOCK + 1_000,
  });
  db.setBrainVersionGateReport(version.version_id, { verdict: "pass", kind: "test", findings: [] });
  db.setBrainVersionStatus(version.version_id, "validated", { at: CLOCK + 1_000 });
  db.setBrainVersionCanary(version.version_id, { tester_ids: [CANARY_TESTER] });
  // ตั้ง pointer ตรง ๆ ในฐาน **โดยเจตนา**: setBrainPointer ปฏิเสธรุ่นที่ราคาต่างจาก live
  // (canary_not_supported_for_kind — มีเทสต์ของตัวเองใน brain-runtime-guard.test.mjs)
  // สิ่งที่คู่นี้พิสูจน์คือ "guard อ่านตารางของรุ่นที่ประกอบ prompt เทิร์นนั้นจริงไหม" ซึ่งต้อง
  // ถูกต้องเสมอ รวมถึงรุ่นที่ถูกย้อนกลับหรือฐานถูกซ่อมด้วยมือ ไม่ใช่แค่ตอนมี canary ปกติ
  db.raw.prepare("UPDATE brain_versions SET pointer = 'canary', status = 'canary' WHERE version_id = ?")
    .run(version.version_id);
  return version;
}

async function sentTextFor(customerId) {
  const roundsFile = writeRoundsFile();
  const db = memoryDb({ now: () => CLOCK });
  seedRealisticDb(db);
  importCurrentSourcesAsVersion1(db, { now: () => CLOCK, classRoundsFile: roundsFile, logger: silent });
  publishCanaryWithExtraPrice(db);

  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig({
      BRAND_PACK: PACK, CLASS_ROUNDS_FILE: roundsFile,
      BRAIN_READ: "versioned", KNOWLEDGE_VERSIONED: "true",
    }),
    db,
    overrides: { hermesFetch: hermesFetchStub(DRAFT_WITH_CANARY_PRICE), lineFetch, sleep: async () => {} },
    logger: silent,
  });

  db.upsertCustomer(customerId, {});
  await app.pipeline.handleInboundText({ customerId, text: "มีโปรอะไรบ้างคะ", replyToken: "rt" });
  const text = lineFetch.sends
    .flatMap((call) => (call.body?.messages ?? []).map((message) => String(message.text ?? "")))
    .join("\n");
  db.close();
  return text;
}

test("ห้องฝั่ง canary พูดราคาที่มีเฉพาะในรุ่น canary ได้ — ไม่ถูกตัด", async () => {
  const text = await sentTextFor(CANARY_TESTER);
  assert.match(text, /8,700/u, "ราคาที่อนุมัติในรุ่นของห้องนี้ต้องไปถึงลูกค้า");
});

test("ห้องฝั่ง live พูดราคาเดียวกันแล้วถูกตัด — ตารางของ live ไม่มีเลขนี้", async () => {
  const text = await sentTextFor(LIVE_ROOM);
  assert.doesNotMatch(text, /8,700/u, "ราคาที่ยังไม่อนุมัติในรุ่น live ห้ามหลุด");
  assert.match(text, /รบกวนแจ้งชื่อ/u, "ประโยคที่ปลอดภัยต้องถูกกู้ไว้ ไม่ใช่ทิ้งทั้งก้อน");
});
