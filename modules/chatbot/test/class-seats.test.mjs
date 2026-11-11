// ที่นั่งคงเหลือ (v1.4.31) — ทีมงานกรอกเองจากคอนโซล มีผลกับลูกแพรทันที
//
// กติกามาจากพี่ง้วงโดยตรง: ไม่กรอก = "จำนวนจำกัด" / กรอกเลข = บอกจำนวนจริง /
// กรอก 0 = เต็มแล้ว **พร้อมเสนอรอบถัดไปทันทีในข้อความเดียวกัน** (ห้ามแจ้งเต็มแล้วจบเฉย ๆ
// เพราะเท่ากับปิดประตูขายทั้งที่ลูกค้ากำลังสนใจ)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { readEnrolled, seatRuleLines, upcomingRounds, writeEnrolled } from "../src/classRounds.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, promptText,
} from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, warn: () => {}, error: () => {} };
const TODAY = "2026-08-19";

function roundsFile(rounds) {
  const dir = mkdtempSync(join(tmpdir(), "rounds-"));
  const file = join(dir, "class-rounds.json");
  writeFileSync(file, JSON.stringify({
    classes: {
      basic: { label: "Classroom Basic", product: "AI Agent for Business" },
      advance: { label: "Classroom Advance", product: "AI Agent Automation Workflow" },
    },
    rounds,
  }), "utf8");
  return file;
}

const DEFAULT_ROUNDS = [
  { date: "2026-09-12", class: "basic", status: "open" },
  { date: "2026-09-19", class: "basic", status: "open" },
  { date: "2026-08-01", class: "basic", status: "open" }, // ผ่านไปแล้ว
];

test("ที่นั่ง: รอบที่ผ่านไปแล้วต้องไม่โผล่ และรอบที่ยังไม่กรอกต้องเป็น null", () => {
  const db = memoryDb();
  const rounds = upcomingRounds({ file: roundsFile(DEFAULT_ROUNDS), db, todayIso: TODAY, logger: silent });
  assert.deepEqual(rounds.map((r) => r.date), ["2026-09-12", "2026-09-19"]);
  assert.equal(rounds[0].seatsLeft, null, "ไม่กรอก = ไม่มีตัวเลข");
  assert.equal(rounds[0].capacity, 15, "ฐาน 15 ท่านต่อรอบมาจากไฟล์");
  assert.equal(rounds[0].thai, "12 ก.ย. 2026");
  db.close();
});

test("ที่นั่ง: ค่าที่พังใน DB ต้องถูกทิ้ง ไม่ใช่หลุดไปถึงลูกค้า", () => {
  const db = memoryDb();
  db.setSetting("class_enrolled", JSON.stringify({ "2026-09-12": 2, "2026-09-19": -5, "ไม่ใช่วันที่": 3, "2026-10-10": "สอง" }));
  assert.deepEqual(readEnrolled(db), { "2026-09-12": 2 }, "เอาเฉพาะค่าที่ถูกต้องจริง");
  db.setSetting("class_enrolled", "{พัง");
  assert.deepEqual(readEnrolled(db), {}, "JSON พัง = ไม่พูดตัวเลขเลย ดีกว่าพูดผิด");
  db.close();
});

test("ที่นั่ง: 0 ต้องแปลว่าเต็มแล้ว + สั่งให้เสนอรอบถัดไปทันที ไม่ใช่ 'เหลือ 0 ที่'", () => {
  const lines = seatRuleLines([
    { date: "2026-09-12", label: "Classroom Basic", seatsLeft: 2 },
    { date: "2026-09-19", label: "Classroom Basic", seatsLeft: 0 },
    { date: "2026-10-10", label: "Classroom Advance", seatsLeft: null },
  ]).join("\n");

  assert.match(lines, /12 ก\.ย\. 2026[^\n]*เหลือ 2 ที่นั่ง/u);
  assert.match(lines, /19 ก\.ย\. 2026[^\n]*เต็มแล้ว[^\n]*เสนอรอบถัดไป/u);
  assert.doesNotMatch(lines, /เหลือ 0 ที่/u, "0 ห้ามกลายเป็นตัวเลขชวนสับสน");
  assert.doesNotMatch(lines, /10 ต\.ค\./u, "รอบที่ไม่ได้กรอก ห้ามเดาตัวเลขให้");
  assert.match(lines, /ใหม่กว่าคลังความรู้เสมอ/u, "ต้องบอกโมเดลว่าอันไหนชนะ ไม่งั้นมันเลือกเอง");
});

test("ที่นั่ง: ไม่มีใครกรอกเลย = ไม่ต้องเพิ่มกติกาอะไรเข้า prompt", () => {
  assert.deepEqual(seatRuleLines([{ date: "2026-09-12", label: "x", seatsLeft: null }]), []);
});

/* ------------------------------ ถึง prompt จริง ------------------------------ */

test("ที่นั่ง: ตัวเลขที่กรอกต้องเดินทางถึง system prompt ที่ยิงออกไปจริง", async (t) => {
  // ทั้ง DB และ pipeline ใช้ Date เดียวกัน; รอบจำลองต้องยังไม่ผ่านไปตามวันรันจริง
  t.mock.timers.enable({ apis: ["Date"], now: new Date(`${TODAY}T12:00:00+07:00`) });
  const db = memoryDb({ now: () => Date.now() });
  const hermesFetch = hermesFetchStub("รับทราบค่ะ");
  const app = createApp({
    config: testConfig({ CLASS_ROUNDS_FILE: roundsFile(DEFAULT_ROUNDS) }),
    db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });

  await app.pipeline.handleInboundText({ customerId: "U-seat", text: "รอบ 12 ก.ย. ยังว่างไหมคะ", replyToken: "" });
  const before = promptText(hermesFetch.calls.at(-1).body.messages[0].content);
  assert.doesNotMatch(before, /ที่นั่งคงเหลือล่าสุดจากทีมงาน/u, "ยังไม่กรอก = ไม่มีบรรทัดที่นั่ง");

  writeEnrolled(db, { "2026-09-12": 13 }); // ลง 13 จาก 15 = เหลือ 2
  await app.pipeline.handleInboundText({ customerId: "U-seat", text: "แล้วตอนนี้ล่ะคะ", replyToken: "" });
  const after = promptText(hermesFetch.calls.at(-1).body.messages[0].content);
  assert.match(after, /12 ก\.ย\. 2026[^\n]*เหลือ 2 ที่นั่ง/u, "กรอกแล้วต้องมีผลทันที ไม่ต้อง restart");
  db.close();
});

test("ที่นั่ง: ตัวเลขต้องอยู่ในส่วนที่เปลี่ยนได้ ห้ามไปทำลาย prompt cache", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(`${TODAY}T12:00:00+07:00`) });
  const db = memoryDb({ now: () => Date.now() });
  const hermesFetch = hermesFetchStub("รับทราบค่ะ");
  const app = createApp({
    config: testConfig({ CLASS_ROUNDS_FILE: roundsFile(DEFAULT_ROUNDS) }),
    db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  writeEnrolled(db, { "2026-09-12": 13 }); // ลง 13 จาก 15 = เหลือ 2
  await app.pipeline.handleInboundText({ customerId: "U-cache-seat", text: "สอบถามค่ะ", replyToken: "" });

  const blocks = hermesFetch.calls.at(-1).body.messages[0].content;
  assert.ok(Array.isArray(blocks) && blocks.length === 2);
  // ก้อนแรกคือส่วนคงที่ที่ cache จับไว้ — ที่นั่งเปลี่ยนบ่อย ห้ามอยู่ตรงนั้นเด็ดขาด
  assert.doesNotMatch(blocks[0].text, /เหลือ 2 ที่นั่ง/u, "ที่นั่งห้ามอยู่ในก้อนที่ cache จับ");
  assert.match(blocks[1].text, /เหลือ 2 ที่นั่ง/u, "ต้องอยู่ในก้อนที่เปลี่ยนทุกเทิร์นอยู่แล้ว");
  // วันนี้ (2026-09-28): โมเดลต้องรู้วันเพื่อไม่เสนอรอบในคลังความรู้ที่ผ่านไปแล้ว — เปลี่ยนวันละครั้ง
  // จึงต้องอยู่ก้อนเดียวกับที่นั่ง ไม่ใช่ก้อนที่ cache จับ
  assert.doesNotMatch(blocks[0].text, /วันนี้ \(เวลาไทย\) คือ/u, "วันที่ห้ามอยู่ในก้อนที่ cache จับ");
  assert.match(blocks[1].text, /วันนี้ \(เวลาไทย\) คือ [^\n]*รอบเรียนที่วันเรียนถึงหรือผ่านวันนี้แล้วถือว่าปิดรับ/u);
  // รายการรอบจากหน้าที่นั่ง (แหล่งเดียว 28 ก.ย.) — แก้รอบได้บ่อย จึงอยู่ก้อนที่เปลี่ยนทุกเทิร์นเหมือนตัวเลขที่นั่ง
  assert.doesNotMatch(blocks[0].text, /รอบเรียนที่ประกาศแล้ว \(ข้อมูลสดจากหน้า/u, "รายการรอบห้ามอยู่ในก้อนที่ cache จับ");
  assert.match(blocks[1].text, /รอบเรียนที่ประกาศแล้ว \(ข้อมูลสดจากหน้า[^\n]*\n\s+· [^\n]*12 ก\.ย\. 2026/u);
  db.close();
});

// ตัวตรวจโค้ด 28 ก.ย.: การ์ดคลังไม่มีวันเรียนแล้ว (หน้าที่นั่งคือแหล่งเดียว) — เทิร์น "ขอเลื่อนรอบ" เป็นจังหวะดูแล
// ที่ตัดตัวเลขที่นั่งทิ้ง แต่ต้องยังเห็นว่ารอบไหนเปิดอยู่ ไม่งั้นลูกแพรไม่มีข้อมูลรอบเลยสักบรรทัด
test("ที่นั่ง: เทิร์นขอเลื่อนรอบ (จังหวะดูแล) ยังเห็นรายการรอบที่เปิด แต่ไม่เห็นตัวเลขที่นั่ง", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(`${TODAY}T12:00:00+07:00`) });
  const db = memoryDb({ now: () => Date.now() });
  const hermesFetch = hermesFetchStub("รับทราบค่ะ");
  const app = createApp({
    config: testConfig({ CLASS_ROUNDS_FILE: roundsFile(DEFAULT_ROUNDS) }),
    db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  writeEnrolled(db, { "2026-09-12": 13 }); // ลง 13 จาก 15 = เหลือ 2
  await app.pipeline.handleInboundText({ customerId: "U-reschedule", text: "ขอเลื่อนรอบเรียนค่ะ พอดีลูกไม่สบาย", replyToken: "" });
  const prompt = promptText(hermesFetch.calls.at(-1).body.messages[0].content);
  assert.match(prompt, /รอบเรียนที่ประกาศแล้ว \(ข้อมูลสดจากหน้า/u, "ต้องรู้ว่ารอบไหนยังเปิดให้เลื่อนไปได้");
  assert.match(prompt, /วันนี้ \(เวลาไทย\) คือ/u);
  assert.doesNotMatch(prompt, /เหลือ 2 ที่นั่ง/u, "จังหวะดูแลไม่พูดตัวเลขที่นั่ง (เหมือนเดิม)");
  db.close();
});

test("ที่นั่ง: ไม่ตั้งไฟล์รอบเรียน = ฟีเจอร์ปิดสนิท (ธุรกิจอื่นต้องไม่เห็น)", async () => {
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("รับทราบค่ะ");
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  writeEnrolled(db, { "2026-09-12": 13 }); // ลง 13 จาก 15 = เหลือ 2
  await app.pipeline.handleInboundText({ customerId: "U-off", text: "สอบถามค่ะ", replyToken: "" });
  const prompt = promptText(hermesFetch.calls.at(-1).body.messages[0].content);
  assert.doesNotMatch(prompt, /ที่นั่งคงเหลือล่าสุด/u);
  assert.doesNotMatch(prompt, /รอบเรียนที่วันเรียนถึงหรือผ่านวันนี้แล้ว/u, "ธุรกิจที่ไม่มีรอบเรียนต้องไม่เห็นกติการอบ");
  assert.doesNotMatch(prompt, /รอบเรียนที่ประกาศ/u, "ธุรกิจที่ไม่มีรอบเรียนต้องไม่เห็นรายการรอบ");
  db.close();
});


/* ---------------- v1.4.35: กรอก "คนที่ลงทะเบียน" ระบบแปลงเป็น "ที่นั่งเหลือ" ---------------- */
// พี่ง้วง: ชมพู่รายงานในกลุ่ม LINE ว่า "ลงทะเบียนแล้ว = 7" ทุกวัน จึงควรกรอกเลขเดียวกัน
// ไม่ใช่ให้คำนวณ 15-7 ในหัวก่อน (คิดในหัวตอนงานยุ่ง = ที่มาของตัวเลขผิดถึงลูกค้า)

test("แปลงเลข: ลง 7 คน จากฐาน 15 = เหลือ 8 ที่", () => {
  const db = memoryDb();
  writeEnrolled(db, { "2026-09-12": 7 });
  const round = upcomingRounds({ file: roundsFile(DEFAULT_ROUNDS), db, todayIso: TODAY, logger: silent })
    .find((r) => r.date === "2026-09-12");
  assert.equal(round.enrolled, 7);
  assert.equal(round.seatsLeft, 8);
  assert.equal(round.overbooked, 0);
  db.close();
});

test("แปลงเลข: ลงครบ 15 = เต็ม (เหลือ 0) และลงเกินไม่ทำให้ที่นั่งติดลบ", () => {
  const db = memoryDb();
  writeEnrolled(db, { "2026-09-12": 15, "2026-09-19": 18 });
  const rounds = upcomingRounds({ file: roundsFile(DEFAULT_ROUNDS), db, todayIso: TODAY, logger: silent });
  const full = rounds.find((r) => r.date === "2026-09-12");
  const over = rounds.find((r) => r.date === "2026-09-19");
  assert.equal(full.seatsLeft, 0);
  assert.equal(over.seatsLeft, 0, "ลงเกินความจุ ที่นั่งเหลือต้องเป็น 0 ไม่ใช่ -3");
  assert.equal(over.overbooked, 3, "ยอดที่เกินยังเก็บไว้ให้ทีมงานเห็น");
  db.close();
});

test("แปลงเลข: สิ่งที่ลูกแพรพูดยังเป็น 'ที่นั่งเหลือ' เหมือนเดิม ไม่ใช่จำนวนคนลง", () => {
  const db = memoryDb();
  writeEnrolled(db, { "2026-09-12": 7, "2026-09-19": 15 });
  const rounds = upcomingRounds({ file: roundsFile(DEFAULT_ROUNDS), db, todayIso: TODAY, logger: silent });
  const lines = seatRuleLines(rounds).join("\n");
  assert.match(lines, /12 ก\.ย\. 2026[^\n]*เหลือ 8 ที่นั่ง/u, "ลูกค้าต้องได้ยิน 'เหลือ 8 ที่' ไม่ใช่ 'ลง 7 คน'");
  assert.doesNotMatch(lines, /7 คน|ลงทะเบียน/u, "จำนวนคนลงเป็นข้อมูลภายใน ห้ามหลุดถึงลูกค้า");
  assert.match(lines, /19 ก\.ย\. 2026[^\n]*เต็มแล้ว/u);
  db.close();
});
