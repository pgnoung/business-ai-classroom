#!/usr/bin/env node
// brain-gate-preview.mjs — "ถ้าเปิด KNOWLEDGE_VERSIONED วันนี้ อะไรจะถูกบล็อกบ้าง"
//
// อ่านอย่างเดียวล้วน ไม่เขียนอะไรลงฐานเลย (openBrainReadOnly — openDb รัน migration ซึ่งคือ
// การเขียนไฟล์ ห้ามใช้กับฐาน production ในเครื่องมือรายงาน)
//
// ทำไมต้องมีก่อนเปิดแฟล็ก: ด่านเฟส 1b บล็อกเฉพาะปัญหาที่ "การแก้ครั้งนั้นแตะ" แต่ข้อมูลจริง
// วันนี้มีหนี้ความรู้อยู่เท่าไรไม่มีใครรู้ ถ้าเปิดแฟล็กแล้วค่อยมาเจอตอนพี่ง้วงกดบันทึกจากมือถือ
// นั่นคือการทดลองบนคนที่กำลังทำงาน — รายงานนี้ตอบล่วงหน้าได้ในคำสั่งเดียว
//
// วิธีใช้:
//   node tools/brain-gate-preview.mjs --db /path/to/chassis.sqlite
//   node tools/brain-gate-preview.mjs --db ... --rounds /path/class-rounds.json --verbose
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openBrainReadOnly } from "../src/brain/readonly.mjs";
import { previewGates } from "../src/brain/readiness.mjs";

export { previewGates } from "../src/brain/readiness.mjs";

export function parseArgs(argv) {
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : null;
  };
  return {
    db: value("--db"),
    classRoundsFile: value("--rounds") ?? (process.env.CLASS_ROUNDS_FILE || null),
    verbose: argv.includes("--verbose"),
  };
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.db) {
    console.error("[brain-gate-preview] ต้องระบุ --db <ไฟล์ฐานข้อมูล>");
    process.exitCode = 1;
    return;
  }
  const db = openBrainReadOnly(args.db);
  try {
    const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
    const preview = previewGates(db, { todayIso, classRoundsFile: args.classRoundsFile });
    if (!preview.ok) {
      console.log("[brain-gate-preview] ยังไม่มีรุ่นสมองที่ถูกตั้งเป็น live — เปิดแฟล็กแล้วคอนโซลจะทำงานเหมือนเดิมทุกอย่าง");
      return;
    }
    console.log(`[brain-gate-preview] รุ่น ${preview.seq} · การ์ด ${preview.cards} ใบ · parity ${preview.parity.ok ? "ตรง" : `ไม่ตรง (${preview.parity.reason})`}`);
    console.log(`  หนี้ที่ต้องกด "รับทราบ" ครั้งเดียว: ${preview.debt.needsAck.length} ข้อ`);
    console.log(`  การ์ดที่แก้ตัวมันเองแล้วจะถูกบล็อก: ${countCards(preview.worst.blocking)} ใบ (${preview.worst.blocking.length} ข้อ)`);
    if (preview.worst.verdict === "error") console.log("  ⚠ เครื่องมือตรวจเองไม่ผ่าน G0 — ห้ามเชื่อผลด้านบน");
    if (args.verbose) {
      for (const finding of preview.debt.needsAck) console.log(`  [รับทราบ] ${finding.code} · ${finding.message}`);
      // จัดกลุ่มตามการ์ด แล้วพิมพ์ "หัวข้อ" กับ "ข้อความที่จะบล็อก" ให้ครบ — เพื่อให้เคลียร์หนี้
      // ได้จริงก่อนเปิดแฟล็ก โดยไม่ต้องเปิดฐานหาว่า fact:<uuid> คือใบไหน
      const byCard = new Map();
      for (const finding of preview.worst.blocking) {
        const key = finding.cardId ?? "(ทั้งสมอง)";
        if (!byCard.has(key)) byCard.set(key, []);
        byCard.get(key).push(finding);
      }
      for (const [cardId, findings] of byCard) {
        const card = preview.cardsById.get(cardId);
        console.log(`  [บล็อก] ${card ? `"${card.title}"` : cardId}${card ? ` (${card.key})` : ""}`);
        for (const finding of findings) {
          const hit = finding.detail ?? finding.amountText ?? finding.scope ?? "";
          console.log(`      ${finding.code}${hit ? ` · ข้อความที่ติด: ${hit}` : ""} — ${finding.message}`);
        }
      }
    } else if (preview.debt.needsAck.length || preview.worst.blocking.length) {
      console.log("  ใส่ --verbose เพื่อดูรายข้อ");
    }
    // ไม่ใช่ exit 1 เมื่อมีหนี้: หนี้เป็นเรื่องปกติของข้อมูลจริง และเป็นสิ่งที่ ack ถูกคิดมาเพื่อรับ
    // exit 1 เฉพาะเรื่องที่ "เปิดแฟล็กแล้วพังแน่" คือ parity ไม่ตรง หรือเครื่องมือตรวจเสีย
    if (!preview.parity.ok || preview.worst.verdict === "error") process.exitCode = 1;
  } finally {
    db.close();
  }
}

function countCards(findings) {
  return new Set(findings.map((finding) => finding.cardId ?? "-")).size;
}

function isMainModule(metaUrl) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) main();
