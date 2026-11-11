// fallback-human-touch-1012.test.mjs — พี่ง้วง 12 ต.ค. (ข้อ 3): "ห้ามตอบ ยังยืนยันไม่ได้ เมื่อระบบมีข้อมูล — ทุกอย่างคือ human touch, human sense"
// ข้อความสำรองที่ระบบส่งแทนร่างที่ด่านเงินบล็อกทั้งก้อน ต้อง (1) ไม่บอกว่าข้อมูลไม่มี/ยืนยันไม่ได้ (2) รับปากเท่าที่เกิดขึ้นจริง:
// ส่งเรื่องให้ทีมสำเร็จ = บอกว่าขอเช็คกับทีมงานแล้วจะกลับมาแจ้ง · ส่งเรื่องไม่สำเร็จ = ห้ามอ้างทีมงาน/บันทึกเรื่อง
// (เส้นตัวตรวจคำตอบล่ม ตรวจใน jev-pipeline.test.mjs)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  BLOCKED_FALLBACK_TEMPLATE, BLOCKED_FALLBACK_UNTRACKED_TEMPLATE, JEV_HOLD_FALLBACK_TEMPLATE, STYLE_BLOCK_TEMPLATE,
  looksLikeSelfPromise, looksLikeTeamPromise,
} from "../src/pipeline.mjs";
import { FOLLOWUP_THREAD_PATTERNS, pickFollowupThread } from "../src/followupThread.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const UNKNOWN_CLAIM = /ยืนยันไม่ได้|ยังยืนยัน|ไม่มีข้อมูล|ไม่ทราบ/u;

// ร่างประโยคเดียวที่มีเลขค่าเรียนนอกตารางอนุมัติ = ด่านเงินบล็อกทั้งก้อน (ไม่มีประโยคปลอดภัยให้กู้)
function blockedMoneyApp(db) {
  db.setApprovedPrice("ราคา-2500", 2500);
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch: hermesFetchStub("คอร์สนี้ราคา 2,590 บาทค่ะ"), lineFetch, sleep: async () => {} },
    logger: silent,
  });
  const sent = () => lineFetch.sends.flatMap((call) => call.body?.messages || []).map((message) => message.text || "").join("\n");
  return { app, sent };
}

test("ข้อความสำรองทั้งสามแบบไม่บอกว่าข้อมูลไม่มี/ยืนยันไม่ได้ · ไม่ซ้ำกัน · ไม่มีตัวเลข", () => {
  const all = [BLOCKED_FALLBACK_TEMPLATE, BLOCKED_FALLBACK_UNTRACKED_TEMPLATE, JEV_HOLD_FALLBACK_TEMPLATE];
  for (const text of all) {
    assert.doesNotMatch(text, UNKNOWN_CLAIM, text);
    assert.doesNotMatch(text, /\d/u, text);
    assert.match(text, /(?:ค่ะ|คะ)$/u, text);
  }
  assert.equal(new Set([...all, STYLE_BLOCK_TEMPLATE]).size, 4);
});

test("ส่งเรื่องให้ทีมสำเร็จเท่านั้นที่อ้างทีมงาน: แบบหลักเป็นคำรับปากแทนทีม (ตัวจับ v1.4.26 เห็น) · อีกสองแบบไม่อ้างทีมงานและไม่รับปากแทนใคร", () => {
  assert.equal(looksLikeTeamPromise(BLOCKED_FALLBACK_TEMPLATE), true);
  assert.match(BLOCKED_FALLBACK_TEMPLATE, /กลับมาแจ้ง/u);
  for (const text of [BLOCKED_FALLBACK_UNTRACKED_TEMPLATE, JEV_HOLD_FALLBACK_TEMPLATE]) {
    assert.equal(looksLikeTeamPromise(text), false, text);
    assert.equal(looksLikeSelfPromise(text), false, text);
    assert.doesNotMatch(text, /ทีม|บันทึก|กลับมา/u, text);
  }
});

test("ด่านเงินบล็อกทั้งก้อน + ส่งเรื่องให้ทีมสำเร็จ = ขอเช็คกับทีมงานแล้วกลับมาแจ้ง (ไม่ใช่ \"ข้อมูลตรงนี้ยังยืนยันไม่ได้\")", async () => {
  const db = memoryDb();
  const { app, sent } = blockedMoneyApp(db);
  const result = await app.pipeline.handleInboundText({ customerId: "U-fb-tracked", text: "ราคาเท่าไหร่คะ", replyToken: "rt" });
  assert.equal(result.blockedDraft, true);
  assert.equal(result.sent, true);
  const text = sent();
  assert.ok(text.includes(BLOCKED_FALLBACK_TEMPLATE), text);
  assert.doesNotMatch(text, /2,590/u);
  assert.doesNotMatch(text, UNKNOWN_CLAIM);
  assert.equal(db.getCustomer("U-fb-tracked").state, "NEEDS_HUMAN", "คำว่าขอเช็คกับทีมงานต้องมีเรื่องค้างให้ทีมเห็นจริง");
  db.close();
});

test("ด่านเงินบล็อกทั้งก้อน + ส่งเรื่องให้ทีมไม่สำเร็จ = ขอเรียบเรียงคำตอบใหม่แล้วชวนพิมพ์คำถามอีกครั้ง ไม่อ้างทีมงาน/บันทึกเรื่อง ไม่เอ่ยถึงตัวเลข", async () => {
  const db = memoryDb();
  db.setNeedsHuman = () => { throw new Error("fixture handoff write failed"); };
  const { app, sent } = blockedMoneyApp(db);
  const result = await app.pipeline.handleInboundText({ customerId: "U-fb-untracked", text: "ราคาเท่าไหร่คะ", replyToken: "rt" });
  assert.equal(result.blockedDraft, true);
  assert.equal(result.sent, true, "ลูกค้าต้องไม่เจอความเงียบ");
  const text = sent();
  assert.ok(text.includes(BLOCKED_FALLBACK_UNTRACKED_TEMPLATE), text);
  assert.doesNotMatch(text, /2,590/u);
  assert.doesNotMatch(text, UNKNOWN_CLAIM);
  assert.doesNotMatch(text, /ทีมงาน|บันทึกเรื่อง/u, "ไม่มีเรื่องค้างให้ทีม = ห้ามบอกว่าส่งเรื่องให้ทีมแล้ว");
  assert.doesNotMatch(text, /ตัวเลข/u, "ลูกค้าไม่เคยเห็นร่างที่ถูกบล็อก = ไม่เอ่ยถึงตัวเลขที่เขาไม่เคยเห็น");
  db.close();
});

// รีวิวรอบ 2 (12 ต.ค.): ถ้อยคำเดิม "ตัวเลขตรงนี้ขอลูกแพรทวน…" เอ่ยถึงตัวเลขที่ลูกค้าไม่เคยเห็น และ "ขอทวน…ก่อน" ฟังเหมือนจะกลับมาเอง
// ทั้งที่ประโยคเดียวกันชวนลูกค้าพิมพ์ถามใหม่ — ถ้อยคำใหม่ขอเรียบเรียงคำตอบใหม่ ไม่รับปากแทนใคร ไม่อ้างทีมงาน
test("ข้อความสำรองแบบส่งเรื่องให้ทีมไม่สำเร็จ = ถ้อยคำที่รีวิวรอบ 2 เคาะ (ไม่เอ่ยถึงตัวเลข · ไม่อ้างทีม · ไม่รับปากว่าจะกลับมา)", () => {
  assert.equal(BLOCKED_FALLBACK_UNTRACKED_TEMPLATE,
    "ขอโทษค่ะ ลูกแพรขอเรียบเรียงคำตอบเรื่องนี้ใหม่ให้ถูกต้องนะคะ 🙏 รบกวนพิมพ์คำถามมาอีกครั้งได้เลยค่ะ");
  assert.doesNotMatch(BLOCKED_FALLBACK_UNTRACKED_TEMPLATE, /ตัวเลข|ราคา|ทวน|ทีม|บันทึก|กลับมา|เดี๋ยว/u);
  assert.equal(looksLikeTeamPromise(BLOCKED_FALLBACK_UNTRACKED_TEMPLATE), false);
  assert.equal(looksLikeSelfPromise(BLOCKED_FALLBACK_UNTRACKED_TEMPLATE), false);
});

// รีวิวรอบ 2 (12 ต.ค.): ข้อความสำรองเดิมทั้งสามแบบมีคำว่า "ยังยืนยันไม่ได้" ตัวอ่าน "ยังไม่ได้ของ" ของทักตาม (NOT_DELIVERED_RE) จึงนับว่าลูกค้า
// ยังไม่ได้ของที่ขอ แล้วทักตามส่งของ (deliver) — ถ้อยคำใหม่ไม่มีคำนั้นแล้ว ทักตามต้องยังอ่านออกว่าข้อความสำรอง = ยังไม่ได้ของ
const FALLBACKS = { BLOCKED_FALLBACK_TEMPLATE, BLOCKED_FALLBACK_UNTRACKED_TEMPLATE, JEV_HOLD_FALLBACK_TEMPLATE };
let at = 1_000;
const cust = (text) => ({ role: "user", admin: false, proactive: false, media: false, text, meta: null, at: at += 1000 });
const bot = (text, stage = "") => ({ role: "assistant", admin: false, proactive: false, media: false, text,
  meta: stage ? { engine: "v3", stage, stageReason: "x", modifiers: [] } : null, at: at += 1000 });
const pick = (rows) => pickFollowupThread({ rows, rounds: [] });

test("ทักตามส่งของยังทำงานหลังข้อความสำรองทั้งสามแบบ: ขอรายละเอียด/ขอคลิป/ตอบรับข้อเสนอหัวข้อ แล้วได้ข้อความสำรอง = deliver", () => {
  for (const [name, template] of Object.entries(FALLBACKS)) {
    assert.ok(FOLLOWUP_THREAD_PATTERNS.NOT_DELIVERED_RE.test(template), name);
    for (const stage of ["DISCOVERY", "BRIDGE", ""]) {
      const details = pick([cust("ขอรายละเอียดหน่อยค่ะ"), bot(template, stage)]);
      assert.equal(details.thread?.kind, "deliver", `${name}/${stage}: ${details.reason}`);
      assert.equal(details.thread.deliver, "details", `${name}/${stage}`);
      const link = pick([cust("ขอดูรีวิวหน่อยค่ะ"), bot(template, stage)]);
      assert.equal(link.thread?.kind, "deliver", `${name}/${stage}: ${link.reason}`);
      assert.equal(link.thread.deliver, "link", `${name}/${stage}`);
    }
    // ข้อความสำรองถูกแยกเป็นสองบับเบิล (ขึ้นบรรทัดใหม่แทนช่องว่าง) = ยังอ่านออก
    const [head, ...rest] = template.split(" ");
    const split = pick([cust("ขอรายละเอียดหน่อยค่ะ"), bot(head, "BRIDGE"), bot(rest.join(" "), "BRIDGE")]);
    assert.equal(split.thread?.kind, "deliver", `${name} แยกบับเบิล: ${split.reason}`);
    // ตอบรับข้อเสนอ "อยากดูหัวข้อ…ไหมคะ" แล้วได้ข้อความสำรองแทนหัวข้อ = ส่งหัวข้อที่ค้าง
    const accepted = pick([cust("ทำร้านกาแฟค่ะ"), bot("คลาสนี้เหมาะกับร้านกาแฟมากค่ะ\nอยากดูหัวข้อที่สอนในคลาสนี้แบบเต็ม ๆ ไหมคะ?", "BRIDGE"),
      cust("ส่งมาเลยค่ะ"), bot(template, "BRIDGE")]);
    assert.equal(accepted.thread?.kind, "deliver", `${name} ตอบรับข้อเสนอ: ${accepted.reason}`);
    assert.equal(accepted.thread.deliver, "details", name);
  }
  // คุมฝั่งลบ: ส่งรายละเอียดให้แล้วชวนต่อ = ไม่ใช่ของค้าง · ข้อความขอโทษอื่นที่ไม่ใช่ข้อความสำรอง = ไม่นับ
  assert.notEqual(pick([cust("ขอรายละเอียดหน่อยค่ะ"),
    bot("AI Agent for Business เรียนสด 1 วัน มี Workshop และทีม TA ค่ะ\nอยากให้ AI ช่วยงานไหนก่อนคะ?", "BRIDGE")]).thread?.kind, "deliver");
  for (const text of ["ขอโทษค่ะ ลูกแพรพิมพ์ผิดไปนิดนึง", "ขอโทษที่ตอบช้านะคะ", "ลูกแพรขอเรียบเรียงให้สั้นลงนะคะ"]) {
    assert.ok(!FOLLOWUP_THREAD_PATTERNS.NOT_DELIVERED_RE.test(text), text);
  }
});

test("ตัวอ่านข้อความสำรองของทักตามเร็วพอกับข้อความยาว (ช่องว่างยาว/คำซ้ำของข้อความสำรอง)", () => {
  const re = FOLLOWUP_THREAD_PATTERNS.NOT_DELIVERED_RE;
  for (const template of Object.values(FALLBACKS)) {
    const words = template.split(" ");
    for (const text of [words.join(" ".repeat(5000)), `${words[0]} `.repeat(1500), `${words.slice(0, -1).join(" ")} `.repeat(200), template.repeat(300)]) {
      const started = performance.now();
      re.test(text);
      assert.ok(performance.now() - started < 50, `ช้าเกินกับข้อความยาว ${[...text].length}`);
    }
  }
});
