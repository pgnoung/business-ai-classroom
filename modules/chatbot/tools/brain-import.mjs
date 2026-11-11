#!/usr/bin/env node
// brain-import.mjs — ยกแหล่งความจริงที่ใช้อยู่วันนี้เข้าสมองเป็นเวอร์ชันหนึ่งใบ (เฟส 1a)
//
// เฟส 1a ไม่มีอะไรในระบบเรียกตัวนำเข้าเอง และนั่นถูกต้อง: การนำเข้าเป็น "การตัดสินใจ"
// ไม่ใช่ผลข้างเคียงของการบูต สคริปต์นี้คือทางเข้าเดียวที่ตั้งใจให้คนเรียก
//
// สมองที่นำเข้ายัง **ไม่ถูกอ่าน** โดยเส้นตอบลูกค้าเลยแม้แต่ไบต์เดียว — สิ่งที่ได้คือ
// เวอร์ชันที่คอมไพล์ได้ + รายงานว่ามันตรงกับตารางเดิมไหม (เปิด BRAIN_SHADOW_PARITY
// แล้วบรรทัดเดียวกันจะขึ้นตอนบูตทุกครั้ง)
//
// วิธีใช้ (dry-run เป็นค่าตั้งต้นเสมอ — ไม่เขียนอะไรลงฐาน):
//   node tools/brain-import.mjs --db /path/to/chassis.sqlite
//   node tools/brain-import.mjs --db /path/to/chassis.sqlite --apply
//   node tools/brain-import.mjs --db ... --apply \
//     --rounds /path/class-rounds.json \
//     --pinned '{"persona":"/path/persona-distilled.md","brandPack":"/path/brain-pack-context.txt"}' \
//     --allowlist /path/config/brain-lint-allowlist.json
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.mjs";
import { openBrainReadOnly } from "../src/brain/readonly.mjs";
import { importCurrentSourcesAsVersion1 } from "../src/brain/import.mjs";
import { collectCurrentSourceCards, readSourceRounds } from "../src/brain/sources.mjs";
import { brainParityLogLine, brainParityReport } from "../src/brain/parity.mjs";

const QUIET = Object.freeze({ warn() {}, debug() {}, log() {} });

export function parseArgs(argv) {
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : null;
  };
  let pinned = {};
  const rawPinned = value("--pinned");
  if (rawPinned) {
    try { pinned = JSON.parse(rawPinned); } catch { throw new Error("--pinned ต้องเป็น JSON ของ {ชื่อ: path}"); }
    if (!pinned || typeof pinned !== "object" || Array.isArray(pinned)) throw new Error("--pinned ต้องเป็นวัตถุ {ชื่อ: path}");
  }
  return {
    db: value("--db"),
    apply: argv.includes("--apply"),
    // ไม่ระบุ --rounds = ใช้ค่าเดียวกับที่แอปใช้ตอนรัน (CLASS_ROUNDS_FILE)
    // ถ้าไม่ตกมาที่ค่านี้ เครื่องมือจะอ่านโลกคนละใบกับตอนบูต แล้วพิมพ์ว่า "ตรง"
    // ในขณะที่บรรทัด parity ตอนบูตพิมพ์ว่า "ไม่ตรง" — สองคำตอบที่ขัดกันเรื่องเดียวกัน
    classRoundsFile: value("--rounds") ?? (process.env.CLASS_ROUNDS_FILE || null),
    roundsFromEnv: !value("--rounds") && Boolean(process.env.CLASS_ROUNDS_FILE),
    allowlistFile: value("--allowlist"),
    pinnedFiles: pinned,
  };
}

export function todayInBangkok(at = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(at);
}

function main(argv = process.argv.slice(2)) {
  let args;
  try { args = parseArgs(argv); } catch (err) { fail(err.message); return; }
  if (!args.db) { fail("ต้องระบุ --db <ไฟล์ฐานข้อมูล>"); return; }

  // ซ้อม = เปิดแบบอ่านอย่างเดียวจริง ๆ (openDb รัน SCHEMA/ALTER/migration = เขียนไฟล์)
  const db = args.apply ? openDb({ file: args.db }) : openBrainReadOnly(args.db);
  try {
    const todayIso = todayInBangkok();
    reportRoundsSource(db, args);
    if (!args.apply) {
      const cards = collectCurrentSourceCards(db, { classRoundsFile: args.classRoundsFile, logger: QUIET });
      const counts = cards.reduce((acc, card) => ({ ...acc, [card.kind]: (acc[card.kind] ?? 0) + 1 }), {});
      console.log(`[brain-import] ซ้อมอย่างเดียว (ยังไม่เขียนอะไร) — การ์ด ${cards.length} ใบ`);
      for (const kind of Object.keys(counts).sort()) console.log(`  ${kind}: ${counts[kind]}`);
      console.log(brainParityLogLine(brainParityReport(db, { todayIso, classRoundsFile: args.classRoundsFile })));
      console.log("[brain-import] ใส่ --apply เพื่อเขียนจริง");
      return;
    }

    const result = importCurrentSourcesAsVersion1(db, {
      todayIso,
      classRoundsFile: args.classRoundsFile,
      allowlistFile: args.allowlistFile,
      pinnedFiles: args.pinnedFiles,
      logger: QUIET,
    });
    console.log(result.created
      ? `[brain-import] สร้างเวอร์ชัน ${result.versionId} (${result.reason}) — การ์ด ${result.cards} ใบ, revision ใหม่ ${result.appended} ใบ`
      : `[brain-import] แหล่งไม่เปลี่ยน — ยังเป็นเวอร์ชัน ${result.versionId} เดิม`);
    for (const finding of result.lints ?? []) {
      console.log(`  [${finding.severity}] ${finding.code}: ${finding.message}`);
    }
    console.log(brainParityLogLine(brainParityReport(db, { todayIso, classRoundsFile: args.classRoundsFile })));
  } finally {
    db.close();
  }
}

// บอกให้ชัดว่ารอบเรียนมาจากไหน — "ไฟล์ไหน" เป็นคำถามแรกเสมอเมื่อตัวเลขไม่ตรงกัน
function reportRoundsSource(db, args) {
  const { origin } = readSourceRounds(db, { classRoundsFile: args.classRoundsFile, logger: QUIET });
  if (origin === "class_rounds_manual") {
    console.log("[brain-import] รอบเรียน: จากคอนโซล (settings.class_rounds_manual) — ไฟล์ไม่ถูกใช้");
    return;
  }
  if (origin === "class_rounds_file") {
    const via = args.roundsFromEnv ? "CLASS_ROUNDS_FILE" : "--rounds";
    console.log(`[brain-import] รอบเรียน: จากไฟล์ ${args.classRoundsFile} (${via})`);
    return;
  }
  console.log(`[brain-import] รอบเรียน: ไม่มีเลย${args.classRoundsFile ? ` (ไฟล์ ${args.classRoundsFile} ว่างหรืออ่านไม่ได้)` : " (ไม่ได้ระบุไฟล์)"}`);
}

function fail(message) {
  console.error(`[brain-import] ${message}`);
  process.exitCode = 1;
}

// เรียกตรง ๆ หรือถูก import? — บนเครื่องจริงสคริปต์ถูกเรียกผ่าน symlink `current`
// ต้องคลี่ทั้งสองฝั่งเป็น real path ก่อนเทียบ ไม่งั้นสคริปต์ "รันแล้วเงียบ"
function isMainModule(metaUrl) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) main();
