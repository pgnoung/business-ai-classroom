#!/usr/bin/env node
// reopen-fb-human-replying.mjs — เปิด AI คืนให้ห้อง Facebook ที่ถูกปิดถาวรด้วยนโยบายเก่า
// (คำสั่งเจ้าของ 2026-09-02)
//
// ที่มา: ก่อนวันนี้ echo ของแอดมินจาก Business Suite = ปิด AI ถาวร (fb_human_replying)
// และไม่มีเส้นทางอัตโนมัติใดเปิดคืน ห้องจึงตายหลังทีมงานตอบไปครั้งเดียว โค้ดใหม่เปลี่ยน
// เป็น "พัก 15 นาที" แล้ว แต่ห้องที่ปิดค้างไว้ก่อน deploy ไม่หายไปเอง — สคริปต์นี้คือ
// ตัวเก็บกวาดครั้งเดียว ที่คนต้องสั่งเอง ไม่ใช่ระบบเปิดคืนให้เงียบ ๆ
//
// วิธีใช้ (dry-run เป็นค่าตั้งต้นเสมอ):
//   node tools/reopen-fb-human-replying.mjs --db /path/to/chassis.db
//   node tools/reopen-fb-human-replying.mjs --db /path/to/chassis.db --apply
//
// ด่านที่ห้ามข้าม (ทุกข้อคือห้องที่ "ไม่ควร" ถูกเปิดคืนอัตโนมัติ):
//   - เหตุปิดต้องเป็น fb_human_replying เป๊ะ ๆ เท่านั้น
//   - state ต้องไม่ใช่ NEEDS_HUMAN (มีคนถือเคสอยู่)
//   - ห้องที่แตะเส้นเงินแล้ว (money_seen_at > 0 / deal_status ฝั่งจ่าย) ข้ามทั้งหมด
//   - ห้องที่มีป้ายสั่งเงียบ (customer / null) ข้าม เพราะป้ายคือคำสั่งของคน
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BOT_SILENCED_TAGS, openDb } from "../src/db.mjs";

const TARGET_REASON = "fb_human_replying";
const MONEY_DEAL_STATUSES = new Set(["awaiting_payment", "paid", "won"]);

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

// เหตุผลที่ "ข้าม" ต้องอธิบายได้ทีละห้อง ไม่งั้นคนสั่งจะไม่รู้ว่าอะไรถูกทิ้งไว้ข้างหลัง
export function skipReasonFor(customer, tags = []) {
  if (String(customer.ai_off_reason || "") !== TARGET_REASON) return "เหตุปิดไม่ใช่ fb_human_replying";
  if (String(customer.state || "") === "NEEDS_HUMAN") return "ยังปักธงรอคนดูแล";
  if (Number(customer.money_seen_at) > 0) return "ห้องนี้แตะเรื่องเงินแล้ว";
  if (MONEY_DEAL_STATUSES.has(String(customer.deal_status || ""))) return `ดีลอยู่สถานะ ${customer.deal_status}`;
  const silent = tags.map((t) => String(t.tag || "").trim().toLowerCase())
    .find((tag) => BOT_SILENCED_TAGS.includes(tag));
  if (silent) return `มีป้ายสั่งเงียบ "${silent}"`;
  return "";
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("ต้องระบุไฟล์ฐานข้อมูล: --db /path/to/chassis.db");
    process.exitCode = 2;
    return;
  }
  // ชื่อพารามิเตอร์คือ `file` เท่านั้น — `path` จะถูกเมิน แล้วได้ DB ว่างในหน่วยความจำ
  // แทนไฟล์จริง (พังเงียบ) จึงห้ามเดาชื่อ
  const db = openDb({ file: args.file });
  try {
    const rows = db.raw.prepare(
      "SELECT line_user_id, ai_enabled, ai_off_reason, state, deal_status, money_seen_at, display_name"
      + " FROM customers WHERE ai_enabled = 0 AND ai_off_reason = ? ORDER BY line_user_id",
    ).all(TARGET_REASON);

    let reopened = 0;
    let skipped = 0;
    for (const row of rows) {
      const skip = skipReasonFor(row, db.listTags(row.line_user_id));
      if (skip) {
        skipped += 1;
        console.log(`ข้าม  ${row.line_user_id} — ${skip}`);
        continue;
      }
      reopened += 1;
      console.log(`${args.apply ? "เปิดคืน" : "จะเปิดคืน"} ${row.line_user_id}`);
      if (!args.apply) continue;
      db.setAiEnabled(row.line_user_id, true, "");
      db.addAudit({
        operator: "tools/reopen-fb-human-replying", action: "ai_on_fb_human_replying_cleanup",
        target: row.line_user_id,
        detail: "นโยบายใหม่ 2026-09-02: echo ของแอดมิน = พัก 15 นาที ไม่ใช่ปิดถาวร",
      });
    }
    console.log(
      `\nรวม ${rows.length} ห้อง · ${args.apply ? "เปิดคืนแล้ว" : "จะเปิดคืน"} ${reopened} · ข้าม ${skipped}`
      + (args.apply ? "" : "\n(นี่คือ dry-run — ใส่ --apply เมื่อพร้อมเขียนจริง)"),
    );
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
