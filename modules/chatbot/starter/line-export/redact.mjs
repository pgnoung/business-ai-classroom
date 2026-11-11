#!/usr/bin/env node
// แปลงแชทดิบ (chat-export/raw) เป็นชุดที่ปิดข้อมูลส่วนตัวแล้ว (chat-export/clean) ให้ AI ใช้สกัด FAQ / น้ำเสียง / เคสทดสอบ
//
//   node starter/line-export/redact.mjs        (หรือ bash ai-admin.sh chat-redact)
//
// ปิด: เบอร์โทร · อีเมล · เลขบัญชี/เลขยาว · เลขบัตรประชาชน · ลิงก์ · LINE id · บ้านเลขที่/รหัสไปรษณีย์
// ชื่อคนที่ลูกค้าพิมพ์เองในข้อความปิดอัตโนมัติไม่ได้ทั้งหมด — AI ต้องไม่คัดลอกชื่อคนลงไฟล์ร้าน
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const RULES = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/gu, "[อีเมล]"],
  [/https?:\/\/\S+/gu, "[ลิงก์]"],
  [/\bU[0-9a-f]{32}\b/gu, "[LINE-ID]"],
  [/(?<![\d-])\d(?:[\s-]?\d){12}(?![\d-])/gu, "[เลขบัตร]"],
  [/(?<![\d])(?:\+?66[\s-]?|0)(?:[689]\d|2)[\s-]?\d{3,4}[\s-]?\d{3,4}(?!\d)/gu, "[เบอร์โทร]"],
  [/(?<![\d])\d{3}[\s-]?\d[\s-]?\d{5}[\s-]?\d(?!\d)/gu, "[เลขบัญชี]"],
  [/(?<![\d])\d{7,}(?!\d)/gu, "[เลขยาว]"],
];

// ข้อความที่หน้าตาเป็นที่อยู่ (มีคำบอกที่อยู่ + ตัวเลข) ปิดทั้งข้อความ — ปลอดภัยกว่าไล่ปิดทีละส่วน
// (ไม่ปิดเลข 5 หลักทั่วไป เพราะชนกับราคา เช่น 12900)
const ADDRESS_HINT = /(บ้านเลขที่|เลขที่|หมู่บ้าน|หมู่\s*\d|ซอย|ซ\.|ถนน|ถ\.|แขวง|ตำบล|ต\.|เขต|อำเภอ|อ\.|จังหวัด|จ\.|รหัสไปรษณีย์)/u;
const HAS_NUMBER = /\d/u;

export function redactText(text) {
  let out = String(text || "");
  if (ADDRESS_HINT.test(out) && HAS_NUMBER.test(out)) return "[ที่อยู่ลูกค้า]";
  for (const [re, label] of RULES) out = out.replace(re, label);
  return out;
}

export function redactRoom(raw, index) {
  const messages = (raw.messages || []).map((m) => ({
    from: m.from === "shop" ? "shop" : "customer",
    type: m.type || "text",
    text: m.type === "text" ? redactText(m.text) : `[${m.type || "อื่น ๆ"}]`,
  }));
  return { room: `ห้อง-${String(index + 1).padStart(4, "0")}`, messages };
}

export function run({ rawDir = join(ROOT, "chat-export", "raw", "chats"), outDir = join(ROOT, "chat-export", "clean") } = {}) {
  if (!existsSync(rawDir)) throw new Error("ยังไม่มีแชทดิบ — สกัดแชทจาก LINE OA ก่อน");
  const files = readdirSync(rawDir).filter((f) => f.endsWith(".json")).sort();
  mkdirSync(outDir, { recursive: true });
  const rooms = files.map((f, i) => redactRoom(JSON.parse(readFileSync(join(rawDir, f), "utf8")), i)).filter((r) => r.messages.length);
  writeFileSync(join(outDir, "conversations.jsonl"), rooms.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
  const md = rooms.map((r) => [`## ${r.room}`, ...r.messages.map((m) => `- ${m.from === "shop" ? "ร้าน" : "ลูกค้า"}: ${m.text.replace(/\n/g, " ⏎ ")}`)].join("\n"));
  writeFileSync(join(outDir, "conversations.md"), `# แชทที่ปิดข้อมูลส่วนตัวแล้ว (${rooms.length} ห้อง)\n\n${md.join("\n\n")}\n`, { mode: 0o600 });
  // คำถามเปิดบทสนทนาของลูกค้า — จุดเริ่มสกัด FAQ และเคสทดสอบ
  const openers = rooms.map((r) => r.messages.find((m) => m.from === "customer" && m.type === "text")?.text).filter(Boolean);
  writeFileSync(join(outDir, "customer-openers.txt"), `${openers.join("\n")}\n`, { mode: 0o600 });
  const total = rooms.reduce((n, r) => n + r.messages.length, 0);
  return { rooms: rooms.length, messages: total, openers: openers.length, outDir };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const r = run();
  console.log(`✅ ปิดข้อมูลส่วนตัวแล้ว ${r.rooms} ห้อง ${r.messages} ข้อความ → ${r.outDir}`);
  console.log("   ไฟล์ทั้งหมดอยู่ในเครื่องนี้เท่านั้น (chat-export/ ไม่ถูก commit) ห้ามอัปโหลดหรือแชร์");
}
