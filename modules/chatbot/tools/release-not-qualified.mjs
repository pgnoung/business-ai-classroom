#!/usr/bin/env node
// release-not-qualified.mjs — คืนห้องสีเหลือง "AI off (not qualify)" ก่อนถอยกลับไป release ที่ไม่รู้จักตัวกวาด
// (รีวิวปรปักษ์ 5 ต.ค. #4 — คำสั่งพี่ง้วง 5 ต.ค. 2026 "ระบบนี้ reverse ไปมาระหว่างเหลืองกับเขียวเท่านั้น")
//
// ที่มา: release ก่อนตัวกวาด (เช่น a5005211) ไม่มีโค้ดเปิดห้อง not_qualified คืนเลย — ห้องเหลืองที่ค้างอยู่ตอนถอยกลับ
// จะเงียบไปตลอด ข้อความร้องเรียน/ถามราคา/ขอคุยกับคนในห้องนั้นไม่มีใครตอบ และป้ายโชว์รหัสดิบ "not_qualified"
// สคริปต์นี้คือขั้นที่คนต้องสั่งเอง "ก่อน" สลับ unit — ไม่ใช่ระบบเปิดคืนให้เงียบ ๆ
//
// วิธีใช้ (dry-run เป็นค่าตั้งต้นเสมอ · รันด้วยบัญชี service เหมือน tools อื่น):
//   node tools/release-not-qualified.mjs --db /path/to/chassis.sqlite
//   node tools/release-not-qualified.mjs --db /path/to/chassis.sqlite --apply
//
// --apply ทำตามลำดับนี้:
//   1) ตั้งสวิตช์ qualify_sweep_mode = off ก่อน — ตัวกวาดที่ยังรันอยู่จะไม่ปิดเหลืองห้องใหม่ระหว่างทาง
//   2) releaseAllNotQualified (ฟังก์ชันเดียวกับที่ตัวกวาดใช้ตอนสวิตช์ไม่ใช่ on) — ด่านคน/เงิน + CAS เดิม: เปิดคืนเฉพาะห้อง
//      AI_ACTIVE/RESOLVED ที่ยังไม่มีเรื่องเงิน ไม่มีคนรับห้อง + audit ai_on_qualified "release:rollback" ทีละห้อง
//   3) ห้องที่ยังเหลืองค้าง (รอทีมตรวจ NEEDS_HUMAN / มีเรื่องเงิน / มีคนรับห้องแล้ว) เปลี่ยนเหตุเป็น manual
//      (รีวิวปรปักษ์รอบ 2 5 ต.ค.) — release เก่าไม่รู้จัก not_qualified: ป้ายโชว์รหัสดิบสีแดง "โดยระบบ" และไม่มีทางไหน
//      เปิดคืน · manual = "AI ปิด · โดยคน" (ห้องของทีม) ซึ่งตรงความหมายจริงใน release เก่า + audit ทีละห้อง
//      "release:rollback_keep" · ข้อความที่ค้างอยู่ AI ไม่ตอบย้อนหลัง — ขึ้นคิวรอตอบให้ทีม
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.mjs";
import { MANUAL_AI_OFF_REASON } from "../src/aiPausePolicy.mjs";
import {
  NOT_QUALIFIED_REASON, QUALIFY_AUDIT_OPERATOR, QUALIFY_SWEEP_MODE_KEY, qualifySweepMode,
} from "../src/notQualified.mjs";
import { releaseAllNotQualified, releaseKeepReason } from "../src/qualifySweepRules.mjs";

export const RELEASE_REASON = "rollback";
export const ROLLBACK_KEEP_AUDIT_ACTION = "ai_off_rollback_keep";
export const ROLLBACK_KEEP_AUDIT_DETAIL = "release:rollback_keep";
const KEEP_CAS_SQL = `UPDATE customers SET ai_off_reason = ?
  WHERE line_user_id = ? AND ai_enabled = 0 AND ai_off_reason = ?`;
const KEEP_TEXT = Object.freeze({
  needs_human: "รอทีมตรวจ (NEEDS_HUMAN)",
  money: "ห้องนี้แตะเรื่องเงินแล้ว",
  human_owner: "มีคนรับห้องนี้แล้ว (human_owner)",
  human_since_off: "ทีมตอบ/เขียนโน้ตหลังห้องเป็นเหลือง",
});

function parseArgs(argv) {
  const args = { file: "", apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--apply") args.apply = true;
    else if (flag === "--dry-run") args.apply = false;
    else if (flag === "--db" || flag === "--file") args.file = String(argv[i + 1] || "");
  }
  return args;
}

// เหตุที่ห้องนี้ "คืนเองไม่ได้" — ด่านเดียวกับ releaseAllNotQualified ("" = คืนได้) · ข้อความไทยให้คนอ่าน
export function keepReasonFor(row, db) {
  const code = releaseKeepReason(db, row);
  if (!code) return "";
  return KEEP_TEXT[code] || `สถานะ ${String(row?.state ?? "") || "-"}`;
}

/** ห้องเหลืองทั้งหมด แยกเป็น คืนได้ / ต้องให้คนดูแล (อ่านอย่างเดียว) */
export function planNotQualifiedRelease(db) {
  const rows = db.raw.prepare(
    "SELECT * FROM customers WHERE ai_enabled = 0 AND ai_off_reason = ? ORDER BY line_user_id",
  ).all(NOT_QUALIFIED_REASON);
  const releasable = [];
  const keep = [];
  for (const row of rows) {
    const why = keepReasonFor(row, db);
    if (why) keep.push({ id: String(row.line_user_id), why });
    else releasable.push(String(row.line_user_id));
  }
  return { mode: qualifySweepMode(db), releasable, keep };
}

// ห้องที่ต้องให้คนดูแล: not_qualified -> manual (CAS: เหตุอื่นที่เขียนทับระหว่างทางไม่ถูกแตะ) + audit หนึ่งแถว
function holdForStaff(db, { id, why }, logger) {
  if (db.raw.prepare(KEEP_CAS_SQL).run(MANUAL_AI_OFF_REASON, id, NOT_QUALIFIED_REASON).changes !== 1) return false;
  try {
    db.addAudit({ operator: QUALIFY_AUDIT_OPERATOR, action: ROLLBACK_KEEP_AUDIT_ACTION, target: id, detail: ROLLBACK_KEEP_AUDIT_DETAIL });
  } catch (err) {
    logger.warn?.(`release-not-qualified: บันทึก audit ไม่สำเร็จ ${id} (${err?.message || err}) — ${why}`);
  }
  return true;
}

/** ปิดสวิตช์ → คืนห้องด้วยด่าน/CAS ของตัวกวาด → ห้องที่ยังเหลืองค้างเปลี่ยนเป็น manual ให้ทีม */
export function applyNotQualifiedRelease({ db, now = Date.now, logger = console } = {}) {
  db.setSetting(QUALIFY_SWEEP_MODE_KEY, "off");
  const released = releaseAllNotQualified({ db, now, reason: RELEASE_REASON, logger });
  const after = planNotQualifiedRelease(db);
  const remaining = after.keep.filter((room) => holdForStaff(db, room, logger));
  return { mode: after.mode, released, remaining, notReleased: after.releasable };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("ต้องระบุไฟล์ฐานข้อมูล: --db /path/to/chassis.sqlite");
    process.exitCode = 2;
    return;
  }
  const db = openDb({ file: args.file }); // ชื่อพารามิเตอร์คือ file เท่านั้น (path = ได้ DB ว่างในหน่วยความจำ)
  try {
    if (!args.apply) {
      const plan = planNotQualifiedRelease(db);
      for (const id of plan.releasable) console.log(`จะเปิดคืน ${id}`);
      for (const { id, why } of plan.keep) console.log(`ให้คนดูแล (จะตั้งเป็น manual) ${id} — ${why}`);
      console.log(`\nสวิตช์ตอนนี้: ${plan.mode} · ห้องเหลือง ${plan.releasable.length + plan.keep.length}`
        + ` · จะเปิดคืน ${plan.releasable.length} · ให้คนดูแล ${plan.keep.length}`
        + "\n(นี่คือ dry-run — ใส่ --apply เมื่อพร้อมเขียนจริง: ปิดสวิตช์ก่อน แล้วค่อยเปิดคืน)"
        + "\nข้อความที่ค้างอยู่ AI ไม่ตอบย้อนหลัง — ขึ้นคิวรอตอบให้ทีม");
      return;
    }
    const result = applyNotQualifiedRelease({ db, logger: console });
    for (const { id, why } of result.remaining) console.log(`ตั้งเป็น manual ให้คนดูแล ${id} — ${why}`);
    for (const id of result.notReleased) console.log(`เปิดคืนไม่สำเร็จ ${id} — ลองใหม่อีกครั้ง`);
    const touched = result.released + result.remaining.length;
    console.log(`\nสวิตช์: ${result.mode} · เปิดคืนแล้ว ${result.released} · ให้คนดูแล ${result.remaining.length}`
      + (touched > 0 ? "\nข้อความที่ค้างอยู่ AI ไม่ตอบย้อนหลัง — ขึ้นคิวรอตอบให้ทีม" : ""));
    if (result.notReleased.length) process.exitCode = 1;
  } finally {
    db.close();
  }
}

// /opt/<app>/current เป็น symlink — เทียบ real path ทั้งสองฝั่ง (บทเรียน reopen-fb-human-replying 2 ก.ย.)
function isMainModule(metaUrl) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) main();
