#!/usr/bin/env node
// brain-lints.mjs — อ่านผลด่าน (lint) ที่ถูกบันทึกไว้กับเวอร์ชันสมองที่เป็น live
//
// เฟส 1a ตัวนำเข้า **ไม่บล็อกและไม่แก้เนื้อหา** ไม่ว่า lint จะฟ้องอะไร (ดู src/brain/import.mjs)
// ผลทั้งหมดถูกเก็บลง gate_report_json ให้คนไล่แก้ "ที่แหล่ง" — แต่ของที่ไม่มีใครอ่านได้
// ก็เท่ากับไม่มี เครื่องมือนี้คือทางอ่านนั้น: จัดกลุ่มตามรหัสกฎ แล้วบอกว่าเป็นการ์ดใบไหน
//
// อ่านอย่างเดียวล้วน (openBrainReadOnly) — ไม่รัน SCHEMA/ALTER/migration และไม่คอมไพล์ใหม่
// สิ่งที่พิมพ์คือ "ผลที่บันทึกไว้ตอนนำเข้า" ไม่ใช่ผลที่ตรวจสด: อยากได้ผลสด = นำเข้าใหม่
// exit 0 เสมอ (นี่คือรายงานสุขอนามัย ไม่ใช่ด่าน — ด่านที่คืน exit code คือ brain-parity)
//
// วิธีใช้:
//   node tools/brain-lints.mjs --db /path/to/chassis.sqlite
//   node tools/brain-lints.mjs --db ... --rounds /path/class-rounds.json   # เช็คว่าไฟล์รอบเรียนตรงกับที่เวอร์ชันปักหมุดไว้ไหม
//   node tools/brain-lints.mjs --db ... --code L15                          # เฉพาะกฎเดียว
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openBrainReadOnly } from "../src/brain/readonly.mjs";

export function parseArgs(argv) {
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : null;
  };
  return {
    db: value("--db"),
    // ไม่ระบุ = ใช้ไฟล์เดียวกับที่แอปใช้ตอนรัน (แบบเดียวกับ brain-import/brain-parity)
    classRoundsFile: value("--rounds") ?? (process.env.CLASS_ROUNDS_FILE || null),
    code: (value("--code") || "").toUpperCase() || null,
  };
}

function safeJson(text, fallback = null) {
  try { return JSON.parse(String(text ?? "")); } catch { return fallback; }
}

/** map itemId -> key ของการ์ด (คนอ่านต้องรู้ว่าใบไหน ไม่ใช่เห็น id ที่จำไม่ได้) */
export function cardKeysOfVersion(db, version) {
  const revIds = safeJson(version?.manifest_json, {})?.revIds ?? [];
  const keys = new Map();
  for (const rev of db.listBrainRevs(revIds)) {
    if (!rev?.item_id || keys.has(rev.item_id)) continue;
    // key ของการ์ดความรู้เป็น uuid ที่คนจำไม่ได้ — ต่อหัวข้อให้ถ้ายังมี (การ์ดที่ถูก redact ไม่มี)
    const title = String(safeJson(rev.body_json, {})?.title ?? "").trim();
    keys.set(rev.item_id, title ? `${rev.key} — ${title}` : rev.key);
  }
  return keys;
}

/** จัดกลุ่มผลตามรหัสกฎ เรียงตามจำนวนที่เจอ (มากก่อน) แล้วตามรหัส */
export function groupFindings(findings = []) {
  const byCode = new Map();
  for (const finding of findings) {
    const code = String(finding?.code || "?");
    if (!byCode.has(code)) byCode.set(code, { code, block: 0, warn: 0, items: [] });
    const group = byCode.get(code);
    if (String(finding?.severity) === "block") group.block += 1;
    else group.warn += 1;
    group.items.push(finding);
  }
  return [...byCode.values()].sort((a, b) => (b.items.length - a.items.length) || (a.code < b.code ? -1 : 1));
}

function sha256File(path) {
  try { return createHash("sha256").update(readFileSync(String(path))).digest("hex"); } catch { return null; }
}

// --rounds มีความหมายจริง ไม่ใช่ตัวเลือกประดับ: เวอร์ชันปักหมุด sha ของไฟล์รอบเรียนไว้
// ตอนนำเข้า ถ้าไฟล์บนเครื่องวันนี้ไม่ใช่ไฟล์เดียวกัน ผล lint เรื่องรอบเรียน (L03) ที่อ่านอยู่
// คือผลของ "รอบเรียนคนละชุด" — ต้องรู้ก่อนจะไปแก้ตามที่รายงานบอก
function reportRoundsPin(version, classRoundsFile) {
  if (!classRoundsFile) return;
  const pinned = safeJson(version?.manifest_json, {})?.pinnedFiles?.classRounds ?? null;
  if (!pinned) {
    console.log(`[brain-lints] ไฟล์รอบเรียน: ${classRoundsFile} (เวอร์ชันนี้ไม่ได้ปักหมุดไฟล์รอบเรียนไว้ — รอบมาจากคอนโซล)`);
    return;
  }
  const same = pinned.sha256 && pinned.sha256 === sha256File(classRoundsFile);
  console.log(`[brain-lints] ไฟล์รอบเรียน: ${classRoundsFile} — ${same ? "ตรงกับที่เวอร์ชันปักหมุดไว้" : "ไม่ตรงกับที่เวอร์ชันปักหมุดไว้ (ผล L03 อาจเป็นของรอบคนละชุด)"}`);
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.db) {
    console.error("[brain-lints] ต้องระบุ --db <ไฟล์ฐานข้อมูล>");
    process.exitCode = 1;
    return;
  }
  const db = openBrainReadOnly(args.db);
  try {
    const live = db.getBrainPointer("live");
    if (!live) {
      console.log("[brain-lints] ยังไม่มีเวอร์ชันสมองที่เป็น live — ใช้ tools/brain-import.mjs --apply ก่อน");
      return;
    }
    const report = safeJson(live.gate_report_json, null);
    console.log(`[brain-lints] เวอร์ชัน ${live.version_id} (seq ${live.seq}) — ผลด่าน: ${report?.verdict ?? "ไม่มีรายงาน"}`);
    reportRoundsPin(live, args.classRoundsFile);
    const findings = Array.isArray(report?.findings) ? report.findings : [];
    if (!findings.length) {
      console.log("[brain-lints] ไม่มีข้อไหนฟ้องเลย 🎉");
      return;
    }
    const keys = cardKeysOfVersion(db, live);
    const groups = groupFindings(findings).filter((group) => !args.code || group.code === args.code);
    if (!groups.length) {
      console.log(`[brain-lints] ไม่มีผลของกฎ ${args.code}`);
      return;
    }
    for (const group of groups) {
      console.log(`\n${group.code} — ${group.items.length} รายการ (บล็อก ${group.block} · เตือน ${group.warn})`);
      for (const finding of group.items) {
        const key = finding.cardId ? (keys.get(finding.cardId) ?? finding.cardId) : "(ไม่ผูกกับการ์ดใบเดียว)";
        console.log(`  [${finding.severity}] ${key}${finding.grandfathered ? " (ผ่อนผัน)" : ""}`);
        console.log(`      ${finding.message}`);
      }
    }
    const blocking = findings.filter((finding) => finding.severity === "block").length;
    console.log(`\n[brain-lints] รวม ${findings.length} รายการ — บล็อก ${blocking} รายการ (เฟส 1a รับทราบไว้ ไม่ได้หยุดการนำเข้า)`);
  } finally {
    db.close();
  }
}

function isMainModule(metaUrl) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) main();
