#!/usr/bin/env node
// brain-parity.mjs — รายงานอย่างเดียวว่า "สมองที่คอมไพล์แล้ว ตรงกับตารางที่ระบบใช้จริงไหม"
//
// อ่านอย่างเดียวล้วน ไม่เขียนอะไรลงฐานเลย ปลอดภัยกับฐานของ production
// (ใช้คู่กับ BRAIN_SHADOW_PARITY ที่พิมพ์บรรทัดเดียวกันตอนบูต)
//
// วิธีใช้:
//   node tools/brain-parity.mjs --db /path/to/chassis.sqlite
//   node tools/brain-parity.mjs --db ... --rounds /path/class-rounds.json --verbose
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openBrainReadOnly } from "../src/brain/readonly.mjs";
import { brainParityLogLine, brainParityReport } from "../src/brain/parity.mjs";

export function parseArgs(argv) {
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : null;
  };
  return {
    db: value("--db"),
    // เหมือน brain-import: ไม่ระบุ = ใช้ไฟล์เดียวกับที่แอปใช้ตอนรัน ไม่งั้นเครื่องมือกับ
    // บรรทัดตอนบูตจะให้คำตอบขัดกันเรื่องรอบเรียน
    classRoundsFile: value("--rounds") ?? (process.env.CLASS_ROUNDS_FILE || null),
    verbose: argv.includes("--verbose"),
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.db) {
    console.error("[brain-parity] ต้องระบุ --db <ไฟล์ฐานข้อมูล>");
    process.exitCode = 1;
    return;
  }
  // อ่านอย่างเดียวจริง ๆ — openDb รัน SCHEMA/ALTER/migration ซึ่งคือการเขียนไฟล์
  const db = openBrainReadOnly(args.db);
  try {
    const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
    const report = brainParityReport(db, { todayIso, classRoundsFile: args.classRoundsFile });
    if (args.classRoundsFile) console.log(`[brain-parity] ไฟล์รอบเรียน: ${args.classRoundsFile}`);
    console.log(brainParityLogLine(report));
    if (args.verbose) {
      for (const mismatch of report.mismatches) {
        console.log(`  ${mismatch.part}: ตารางเดิม ${mismatch.expectedSha.slice(0, 12)} vs สมอง ${mismatch.actualSha.slice(0, 12)}`);
      }
    }
    // ไม่ตรง = exit 1 เพื่อให้เอาไปต่อท่อกับงานกลางคืนได้ตรง ๆ
    if (!report.ok) process.exitCode = 1;
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
