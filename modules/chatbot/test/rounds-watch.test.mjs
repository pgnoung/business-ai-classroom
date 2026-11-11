// เตือนตารางรอบเรียนใกล้หมด (v1.4.32) — ต้องไปถึงคนจริง ไม่ใช่ลงล็อกไฟล์
//
// เหตุจริง 2026-08-19: ปฏิทินมี 13 รอบ ระบบรู้ 3 รอบ ค้าง 4 วัน ลูกค้าถามรอบเดือนถัดไป
// แล้วลูกแพรตอบว่า "ยังไม่ประกาศ" ทั้งที่รับจองได้ — และที่รู้ในที่สุดก็เพราะเจ้าของบังเอิญทัก
// เทสต์ชุดนี้ล็อกว่า "สภาพตอนเกิดเหตุ" ต้องถูกเตือนแน่นอน
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkRoundsAndWarn, ROUNDS_WARN_COOLDOWN_MS, ROUNDS_WARN_KEY } from "../src/roundsWatch.mjs";
import { poisonGlobalFetch, memoryDb } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const NOW = Date.parse("2026-08-19T03:00:00Z"); // 10:00 ไทย

function fileWith(dates) {
  const dir = mkdtempSync(join(tmpdir(), "roundswatch-"));
  const file = join(dir, "class-rounds.json");
  writeFileSync(file, JSON.stringify({
    classes: { basic: { label: "Classroom Basic", product: "AI Agent for Business" } },
    rounds: dates.map((date) => ({ date, class: "basic", status: "open" })),
  }), "utf8");
  return file;
}

function spyNotifier() {
  const calls = [];
  return { calls, fireLater: (args) => calls.push(args) };
}

test("เตือน: สภาพตอนเกิดเหตุจริง (เหลือ 3 รอบ รอบสุดท้ายอีก 38 วัน) ต้องถูกเตือน", () => {
  const db = memoryDb({ now: () => NOW });
  const notifier = spyNotifier();
  const result = checkRoundsAndWarn({
    config: { classRoundsFile: fileWith(["2026-08-22", "2026-08-29", "2026-09-26"]) },
    db, notifier, logger: silent, now: () => NOW,
  });

  assert.equal(result.warned, true);
  assert.equal(notifier.calls.length, 1, "ต้อง push ถึงคนจริง ไม่ใช่แค่เขียนล็อก");
  assert.match(notifier.calls[0].reasonTextOverride, /ตารางรอบเรียนใกล้หมด/u);
  assert.equal(notifier.calls[0].force, true, "งาน ops ห้ามถูก cooldown ของฝั่งลูกค้ากลืน");
  db.close();
});

test("เตือน: ตารางยาวถึงสิ้นปี = เงียบ (ห้ามกวนทีมงานโดยไม่จำเป็น)", () => {
  const db = memoryDb({ now: () => NOW });
  const notifier = spyNotifier();
  const result = checkRoundsAndWarn({
    config: { classRoundsFile: fileWith(["2026-09-12", "2026-10-10", "2026-11-14", "2026-12-19"]) },
    db, notifier, logger: silent, now: () => NOW,
  });
  assert.equal(result.warned, false);
  assert.equal(result.bookable, 4);
  assert.equal(notifier.calls.length, 0);
  db.close();
});

test("เตือน: ไม่มีรอบเลย = เตือนแรงสุด", () => {
  const db = memoryDb({ now: () => NOW });
  const notifier = spyNotifier();
  const result = checkRoundsAndWarn({
    config: { classRoundsFile: fileWith(["2026-01-01"]) },
    db, notifier, logger: silent, now: () => NOW,
  });
  assert.equal(result.bookable, 0);
  assert.match(notifier.calls[0].reasonTextOverride, /ไม่มีรอบเรียนที่รับจองได้เลย/u);
  db.close();
});

test("เตือน: ไม่ยิงซ้ำทุกวัน — เตือนรัวคือวิธีที่แน่นอนที่สุดที่จะทำให้คนเลิกอ่าน", () => {
  const db = memoryDb({ now: () => NOW });
  const notifier = spyNotifier();
  const config = { classRoundsFile: fileWith(["2026-08-22", "2026-08-29", "2026-09-26"]) };

  checkRoundsAndWarn({ config, db, notifier, logger: silent, now: () => NOW });
  const nextDay = checkRoundsAndWarn({ config, db, notifier, logger: silent, now: () => NOW + 86_400_000 });
  assert.equal(nextDay.warned, false, "วันถัดมาต้องเงียบ");
  assert.equal(notifier.calls.length, 1);

  const later = checkRoundsAndWarn({
    config, db, notifier, logger: silent, now: () => NOW + ROUNDS_WARN_COOLDOWN_MS + 1000,
  });
  assert.equal(later.warned, true, "ครบ 3 วันแล้วยังไม่แก้ = ต้องเตือนอีก");
  assert.equal(notifier.calls.length, 2);
  assert.ok(Number(db.getSetting(ROUNDS_WARN_KEY)) > NOW);
  db.close();
});

test("เตือน: ธุรกิจที่ไม่มีรอบเรียน ต้องไม่โดนกวนเลย", () => {
  const db = memoryDb({ now: () => NOW });
  const notifier = spyNotifier();
  assert.deepEqual(
    checkRoundsAndWarn({ config: {}, db, notifier, logger: silent, now: () => NOW }),
    { skipped: "no_rounds_file" },
  );
  assert.equal(notifier.calls.length, 0);
  db.close();
});
