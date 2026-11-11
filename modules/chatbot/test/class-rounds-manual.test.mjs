// รอบเรียนที่กรอกเองจาก Console (คำสั่งพี่ง้วง 2026-08-26)
// เดิมตารางรอบอยู่ในไฟล์ที่ฝังมากับ release ซึ่งเขียนไม่ได้ ต้องแก้ในเครื่องแล้วรอ release
// ถัดไป และมีงานอัตโนมัติคอยซิงก์ซึ่งล้มเงียบมานาน
import test from "node:test";
import assert from "node:assert/strict";
import { ANNOUNCED_ROUNDS_MAX, announcedRoundsLines, readManualRounds, seatRuleLines, todayRoundsLine, upcomingRounds, writeManualRounds } from "../src/classRounds.mjs";
import { memoryDb } from "./helpers.mjs";

const TODAY = "2026-08-26";

test("รอบที่กรอกเองต้องชนะไฟล์ และรอบที่ผ่านไปแล้วต้องถูกตัดออก", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  writeManualRounds(db, [
    { date: "2026-08-01", label: "รอบที่ผ่านไปแล้ว", capacity: 15 },
    { date: "2026-09-05", label: "Classroom AI Agent for Business", capacity: 15, classKey: "basic" },
  ]);
  const rounds = upcomingRounds({ file: "", db, todayIso: TODAY });
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].date, "2026-09-05");
  assert.equal(rounds[0].capacity, 15);
  assert.equal(rounds[0].unlimited, false);
});

test("เว้นที่นั่งว่าง = ไม่จำกัด และต้องไม่มีตัวเลขที่นั่งเหลือให้บอกลูกค้า", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  writeManualRounds(db, [{ date: "2026-09-12", label: "คลาสออนไลน์", capacity: null }]);
  const [round] = upcomingRounds({ file: "", db, todayIso: TODAY });
  assert.equal(round.unlimited, true);
  assert.equal(round.capacity, null);
  assert.equal(round.seatsLeft, null, "ไม่จำกัดที่นั่ง = ไม่มีตัวเลขให้บอก");
  assert.equal(round.overbooked, 0);
});

test("ลูกแพรต้องไม่พูดคำว่าไม่จำกัด และต้องบอกว่าราคาพิเศษมีจำนวนจำกัดแทน", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  writeManualRounds(db, [{ date: "2026-09-12", label: "คลาสออนไลน์", capacity: null }]);
  const rounds = upcomingRounds({ file: "", db, todayIso: TODAY });
  const lines = seatRuleLines(rounds).join("\n");

  assert.match(lines, /ราคาพิเศษมีจำนวนจำกัด/u, "ต้องสั่งให้บอกว่าราคาพิเศษมีจำนวนจำกัด");
  assert.match(lines, /ห้ามพูดคำว่า/u, "ต้องห้ามพูดคำว่าไม่จำกัดอย่างชัดเจน");
  // ห้ามมีตัวเลขที่นั่งของรอบนี้หลุดเข้า prompt
  assert.doesNotMatch(lines, /เหลือ \d+ ที่นั่ง/u, "รอบไม่จำกัดต้องไม่มีตัวเลขที่นั่งเหลือ");
});

test("รอบจำกัดที่นั่งยังบอกตัวเลขได้เหมือนเดิม และเต็มแล้วต้องเสนอรอบถัดไป", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  writeManualRounds(db, [
    { date: "2026-09-05", label: "คลาสสอนสด", capacity: 15 },
    { date: "2026-09-19", label: "คลาสสอนสดรอบสอง", capacity: 10 },
  ]);
  db.setSetting("class_enrolled", JSON.stringify({ "2026-09-05": 7, "2026-09-19": 10 }));
  const rounds = upcomingRounds({ file: "", db, todayIso: TODAY });
  const lines = seatRuleLines(rounds).join("\n");
  assert.match(lines, /เหลือ 8 ที่นั่ง/u);
  assert.match(lines, /เต็มแล้ว — ห้ามรับจอง/u);
  assert.match(lines, /เสนอรอบถัดไป/u);
});

test("ค่าที่พังในที่เก็บต้องไม่ทำให้ทั้งระบบล้ม", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  db.setSetting("class_rounds_manual", "ไม่ใช่ JSON");
  assert.deepEqual(readManualRounds(db), []);
  writeManualRounds(db, [{ date: "ไม่ใช่วันที่", label: "x" }, { date: "2026-09-05", label: "" }]);
  assert.deepEqual(readManualRounds(db), [], "แถวที่ข้อมูลไม่ครบต้องถูกทิ้ง ไม่ใช่หลุดไปถึงลูกค้า");
});

test("บรรทัดวันนี้บอกวันแบบเดียวกับตารางในการ์ด และสั่งให้รอบที่ผ่านไปแล้วถือว่าปิดรับ", () => {
  const line = todayRoundsLine("2026-09-28");
  assert.match(line, /วันนี้ \(เวลาไทย\) คือ จันทร์ 28 ก\.ย\. 2026/u);
  assert.match(line, /ถึงหรือผ่านวันนี้แล้วถือว่าปิดรับ ห้ามเสนอ/u);
  assert.match(todayRoundsLine("2026-10-10"), /คือ เสาร์ 10 ต\.ค\. 2026/u, "ต้องตรงกับ \"เสาร์ 10 ต.ค. 2026\" ในการ์ดรอบเรียน");
  assert.equal(todayRoundsLine(""), "", "วันที่พัง = ไม่มีบรรทัด ดีกว่าบอกวันผิด");
  assert.equal(todayRoundsLine("28/09/2026"), "");
  assert.equal(todayRoundsLine("2026-02-29"), "", "วันที่ไม่มีจริงต้องไม่ได้ชื่อวันของวันถัดไป");
});

// คำสั่งพี่ง้วง 28 ก.ย.: "ใส่ตรงที่นั่งเมนูอย่างเดียว และลูกแพรเอาตรงนั้นไปใช้"
test("รายการรอบที่ประกาศแล้วมาจากหน้าที่นั่ง: บอกวัน คลาส สถานะ ไม่พูดตัวเลขที่นั่งซ้ำ", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  writeManualRounds(db, [
    { date: "2026-08-22", label: "รอบที่ผ่านไปแล้ว", status: "open", capacity: 15 },
    { date: "2026-10-10", label: "Classroom AI Agent for Business", status: "open", capacity: 15 },
    { date: "2026-10-24", label: "Classroom AI Agent Workflow Automation", status: "open", capacity: 15 },
    { date: "2026-10-31", label: "Classroom AI Agent Workflow Automation", status: "closed", capacity: 15 },
    { date: "2026-11-14", label: "คลาสออนไลน์", status: "almost_full", capacity: null },
  ]);
  db.setSetting("class_enrolled", JSON.stringify({ "2026-10-10": 2, "2026-10-24": 15 }));
  const lines = announcedRoundsLines(upcomingRounds({ file: "", db, todayIso: "2026-09-28" }));
  assert.match(lines[0], /รอบเรียนที่ประกาศแล้ว \(ข้อมูลสดจากหน้า "ที่นั่ง"/u);
  assert.deepEqual(lines.slice(1), [
    "  · เสาร์ 10 ต.ค. 2026 — Classroom AI Agent for Business — เปิดรับสมัคร",
    "  · เสาร์ 24 ต.ค. 2026 — Classroom AI Agent Workflow Automation — เต็มแล้ว (ห้ามรับจอง ให้เสนอรอบถัดไป)",
    "  · เสาร์ 31 ต.ค. 2026 — Classroom AI Agent Workflow Automation — ปิดรับสมัครแล้ว (ห้ามรับจอง ให้เสนอรอบถัดไป)",
    "  · เสาร์ 14 พ.ย. 2026 — คลาสออนไลน์ — ใกล้เต็ม",
  ]);
  assert.doesNotMatch(lines.join("\n"), /22 ส\.ค\./u, "รอบที่ผ่านไปแล้วต้องไม่อยู่ในรายการ");
  assert.doesNotMatch(lines.join("\n"), /เหลือ \d+ ที่นั่ง/u, "ตัวเลขที่นั่งอยู่ในบรรทัดที่นั่ง ไม่พูดซ้ำที่นี่");
});

test("ไม่มีรอบประกาศ = บอกให้ขอชื่อ/เบอร์ไว้แจ้ง ห้ามเดาวัน · รอบเยอะเกินตัดที่เพดานพร้อมบอกว่ามีต่อ", () => {
  const empty = announcedRoundsLines([]);
  assert.equal(empty.length, 1);
  assert.match(empty[0], /ยังไม่มีรอบเรียนที่ประกาศ — ห้ามเดาวันเรียนเอง/u);
  const many = Array.from({ length: ANNOUNCED_ROUNDS_MAX + 3 }, (_, index) => ({
    date: `2027-01-${String(index + 1).padStart(2, "0")}`, label: "คลาส", fileStatus: "open", seatsLeft: null,
  }));
  const lines = announcedRoundsLines(many);
  assert.equal(lines.length, 1 + ANNOUNCED_ROUNDS_MAX + 1);
  assert.match(lines.at(-1), /มีรอบถัดไปอีก 3 รอบ/u);
});
