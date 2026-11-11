#!/usr/bin/env node
// needs-human-sla-backfill.mjs — ปิดบันไดเตือนของ "หนี้เก่า" ก่อนเปิดนาฬิกา SLA ครั้งแรก
// (คำสั่งเจ้าของ 2026-09-02)
//
// ที่มา: วันที่เปิดใช้ นาฬิกา SLA จะเจอห้องที่รอคนค้างอยู่แล้วหลายสิบห้องพร้อมกัน
// ทุกห้องเลยกำหนดไปนานแล้ว จึงถึงกำหนดเตือนพร้อมกันหมดในรอบแรก และจะไล่เตือนคนละ
// 3 ครั้งจนกว่าจะครบ — ทีมงานจะได้ push รัวเป็นร้อยข้อความในชั่วโมงแรกแล้วปิดการ
// แจ้งเตือนทิ้ง ซึ่งแย่กว่าไม่มีระบบเตือนเลย
//
// สคริปต์นี้จึงเขียนตัวนับของห้องเก่าให้ "ครบเพดานแล้ว" ล่วงหน้า = ไม่มีบันไดเตือน
// สำหรับหนี้เก่า ห้องพวกนั้นไม่ได้หายไปไหน: ยังอยู่ในสรุปรายวันวันละสองรอบ และอยู่ใน
// คิว "รอคน" บนคอนโซลพร้อมป้ายเวลารออันใหม่ ส่วนห้องที่รอใหม่หลังจากนี้ได้บันได
// เตือนเต็ม 3 ขั้นตามปกติ
//
// วิธีใช้ (dry-run เป็นค่าตั้งต้นเสมอ):
//   node tools/needs-human-sla-backfill.mjs --db /path/to/chassis.sqlite
//   node tools/needs-human-sla-backfill.mjs --db /path/to/chassis.sqlite --older-than-hours 24 --apply
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.mjs";
import {
  NEEDS_HUMAN_REMINDER_KEY_PREFIX,
  NEEDS_HUMAN_SLA_DEFAULT_MAX,
  formatReminderState,
  isWaitingForHuman,
  parseReminderState,
  waitLabel,
} from "../src/needsHumanSla.mjs";

const DEFAULT_OLDER_THAN_HOURS = 24;
// id ลูกค้าเป็นข้อมูลส่วนบุคคล — log ของเครื่องจริงต้องอ่านพอรู้ว่าห้องไหน ไม่ใช่เก็บ id เต็ม
const shortId = (id) => `…${String(id).slice(-6)}`;

export function parseArgs(argv) {
  const args = { file: "", apply: false, olderThanHours: DEFAULT_OLDER_THAN_HOURS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--apply") args.apply = true;
    else if (flag === "--dry-run") args.apply = false;
    else if (flag === "--db" || flag === "--file") args.file = String(argv[i + 1] || "");
    else if (flag === "--older-than-hours") args.olderThanHours = Number(argv[i + 1]);
  }
  return args;
}

/**
 * เขียนตัวนับให้ห้องที่รอคนมานานกว่าเกณฑ์ — รูปแบบคีย์มาจาก needsHumanSla.mjs ตัวจริง
 * ทั้งหมด (ห้ามประกอบสตริงเอง ไม่งั้นวันหนึ่งจะเขียนคีย์ที่นาฬิกา SLA อ่านไม่เจอ)
 */
export function runBackfill({
  db,
  olderThanHours = DEFAULT_OLDER_THAN_HOURS,
  apply = false,
  maxReminders = NEEDS_HUMAN_SLA_DEFAULT_MAX,
  now = Date.now(),
  log = console.log,
} = {}) {
  const thresholdMs = Math.max(0, Number(olderThanHours) || 0) * 3_600_000;
  const rows = db.listNeedsHumanSlaCandidates();
  let marked = 0;
  let skipped = 0;
  for (const row of rows) {
    const waitedMs = now - (Number(row.last_inbound_at) || 0);
    if (!isWaitingForHuman(row)) {
      skipped += 1;
      log(`ข้าม   ${shortId(row.line_user_id)} — ไม่ได้อยู่ในคิวรอคนแล้ว`);
      continue;
    }
    // ห้องที่คนตอบไปแล้ว (ต่อให้ยังปักธงรอคนอยู่) ไม่เคยถึงกำหนดเตือนอยู่แล้ว —
    // ถ้าเขียนตัวนับเต็มใส่ไว้ วันหลังลูกค้าคนนั้นทักกลับมาแล้วไม่มีใครตอบ
    // จะไม่มีการเตือนสักครั้งเดียว จึงต้องไม่แตะห้องพวกนี้เด็ดขาด
    if ((Number(row.last_inbound_at) || 0) <= (Number(row.last_operator_outbound_at) || 0)) {
      skipped += 1;
      log(`ข้าม   ${shortId(row.line_user_id)} — มีคนตอบหลังข้อความล่าสุดของลูกค้าแล้ว`);
      continue;
    }
    if (waitedMs < thresholdMs) {
      skipped += 1;
      log(`ข้าม   ${shortId(row.line_user_id)} — รอ ${waitLabel(waitedMs)} ยังไม่ถึงเกณฑ์ (ได้บันไดเตือนเต็มตามปกติ)`);
      continue;
    }
    const before = parseReminderState(db.getSetting(NEEDS_HUMAN_REMINDER_KEY_PREFIX + row.line_user_id));
    marked += 1;
    log(
      `${apply ? "เขียน  " : "จะเขียน"} ${shortId(row.line_user_id)} — รอ ${waitLabel(waitedMs)}`
      + ` · ตัวนับ ${before.count} -> ${maxReminders}/${maxReminders} (ไม่เตือนเพิ่มแล้ว)`,
    );
    if (!apply) continue;
    db.setSetting(
      NEEDS_HUMAN_REMINDER_KEY_PREFIX + row.line_user_id,
      formatReminderState({ count: maxReminders, lastAt: now }),
    );
    db.addAudit({
      operator: "tools/needs-human-sla-backfill",
      action: "needs_human_reminder_backfill",
      target: row.line_user_id,
      detail: `หนี้เก่าก่อนเปิด SLA — รอ ${waitLabel(waitedMs)} ปิดบันไดเตือนที่ ${maxReminders}/${maxReminders}`,
    });
  }
  log(
    `\nรวมคิวรอคน ${rows.length} ห้อง · ${apply ? "ปิดบันไดเตือนแล้ว" : "จะปิดบันไดเตือน"} ${marked} · ข้าม ${skipped}`
    + (apply ? "" : "\n(นี่คือ dry-run — ใส่ --apply เมื่อพร้อมเขียนจริง)"),
  );
  return { scanned: rows.length, marked, skipped };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("ต้องระบุไฟล์ฐานข้อมูล: --db /path/to/chassis.sqlite");
    process.exitCode = 2;
    return;
  }
  if (!Number.isFinite(args.olderThanHours) || args.olderThanHours < 0) {
    console.error("--older-than-hours ต้องเป็นจำนวนชั่วโมงที่ไม่ติดลบ");
    process.exitCode = 2;
    return;
  }
  // ชื่อพารามิเตอร์คือ `file` เท่านั้น — `path` จะถูกเมิน แล้วได้ DB ว่างในหน่วยความจำ
  // แทนไฟล์จริง (พังเงียบ) จึงห้ามเดาชื่อ
  const db = openDb({ file: args.file });
  try {
    const result = runBackfill({ db, olderThanHours: args.olderThanHours, apply: args.apply });
    // ตัวอ่านคิวมีเพดานของตัวเอง — ถ้าเต็มเพดานพอดี แปลว่าอาจมีห้องที่มองไม่เห็นในรอบนี้
    if (result.scanned >= 200) {
      console.error("\nเตือน: อ่านคิวได้เต็มเพดาน 200 ห้อง อาจมีห้องเก่าที่ยังไม่ถูกกวาด — ตรวจซ้ำหลัง --apply");
    }
  } finally {
    db.close();
  }
}

// เรียกตรง ๆ หรือถูก import? — บนเครื่องจริงสคริปต์ถูกเรียกผ่าน
// /opt/<app>/current/chassis/tools/<ชื่อ>.mjs ซึ่ง `current` เป็น symlink
// ของจริง 2026-09-02: เทียบ `file://${process.argv[1]}` ตรง ๆ จึงไม่มีวันเท่ากับ
// import.meta.url (Node คลี่ symlink ให้แล้ว) สคริปต์เลย "รันแล้วเงียบ" ไม่ทำอะไรเลย
// ต้องคลี่ทั้งสองฝั่งให้เป็น real path ก่อนเทียบเสมอ
function isMainModule(metaUrl) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(metaUrl);
  } catch {
    return false; // argv[1] หายไป/ไม่ใช่ไฟล์ = ถือว่าถูก import
  }
}

if (isMainModule(import.meta.url)) main();
