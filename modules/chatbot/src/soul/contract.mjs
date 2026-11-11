// soul/contract.mjs — สัญญาของ soul (ส่วน C) ที่ตรวจด้วยเครื่อง แทน regex 17 ข้อของ persona-runtime ทีละน้อย
//
// C1 หมุด: ทุกข้อความในเครื่องหมายคำพูด ("…" หรือ “…”) ต้องอยู่ในส่วน A
//     ขึ้นบรรทัดด้วย "- <เส้น>:" = หมุดนั้นต้องอยู่ในบล็อกของเส้นนั้น (เช่น "- followup: "ผู้ช่วย AI ผู้หญิง"")
// C2 ข้อห้าม: ข้อความในเครื่องหมายคำพูดต้องไม่อยู่ในส่วน A/B · `…` ใน backtick = regex
//     บรรทัดที่อ้าง C5 = วลีทุกวลีใน C5 (ยกเว้นที่อยู่ในหมุด C1 ซึ่งบอกให้เลี่ยงวลีนั้น) · คำว่า "ตัวหนา" = ห้าม **
// บรรทัดที่ไม่มีอะไรให้เครื่องตรวจ คืนเป็น unchecked ให้คนเห็น — ไม่แกล้งทำเป็นตรวจแล้ว
// soul แบบคอมไพล์ (มีส่วน P · ขั้นที่ 3): หมุดที่ไม่ระบุเส้นต้องอยู่ใน "ส่วน A เอง" ไม่ใช่แค่ในคำห่อของเส้นใดเส้นหนึ่ง
//   + งบความยาว: ส่วน C เขียน "งบส่วน A ไม่เกิน 17,000 ตัวอักษร" = ส่วน A หลังคอมไพล์ยาวเกินไม่ได้ (นับเป็น code point)
import { SOUL_PATHS } from "./parse.mjs";

const QUOTED = /"([^"\n]+)"|“([^”\n]+)”/gu;
const BACKTICK = /`([^`\n]+)`/gu;

/** หัวข้อ ### Cn. ของส่วน C → บรรทัดในหัวข้อนั้น */
function sectionsOfC(partC) {
  const sections = {};
  let current = null;
  for (const line of String(partC || "").split("\n")) {
    const heading = /^###\s*(C\d+)\b/u.exec(line.trim());
    if (heading) {
      current = heading[1];
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  return sections;
}

function bullets(lines = []) {
  return lines.map((line) => line.trim()).filter((line) => /^(?:-|\d+\.)\s/u.test(line))
    .map((line) => line.replace(/^(?:-|\d+\.)\s+/u, ""));
}

function scoped(text) {
  const match = /^([A-Za-z0-9]+):\s+(.*)$/u.exec(text);
  return match && SOUL_PATHS.includes(match[1]) ? { path: match[1], text: match[2] } : { path: null, text };
}

const quotes = (text) => [...String(text).matchAll(QUOTED)].map((m) => m[1] ?? m[2]);

/** อ่านสัญญาจากส่วน C — คืน { pins, forbidden, unchecked } */
export function readContract(soul) {
  const sections = sectionsOfC(soul?.parts?.C);
  const pins = [];
  const forbidden = [];
  const unchecked = [];
  for (const bullet of bullets(sections.C1)) {
    const { path, text } = scoped(bullet);
    const found = quotes(text);
    if (!found.length) unchecked.push(`C1: ${bullet}`);
    for (const pin of found) pins.push({ path, pin });
  }
  const c5Phrases = bullets(sections.C5).flatMap((bullet) => quotes(bullet));
  for (const bullet of bullets(sections.C2)) {
    const { path, text } = scoped(bullet);
    if (/\bC5\b/u.test(text)) {
      for (const phrase of c5Phrases) forbidden.push({ path, kind: "phrase", value: phrase, source: "C5" });
      continue;
    }
    const regexes = [...text.matchAll(BACKTICK)].map((m) => m[1]);
    for (const value of regexes) forbidden.push({ path, kind: "regex", value, source: "C2" });
    const literals = quotes(text.replace(BACKTICK, ""));
    for (const value of literals) forbidden.push({ path, kind: "phrase", value, source: "C2" });
    if (/ตัวหนา/u.test(text)) forbidden.push({ path, kind: "regex", value: "\\*\\*", source: "C2" });
    if (!regexes.length && !literals.length && !/ตัวหนา/u.test(text)) unchecked.push(`C2: ${bullet}`);
  }
  const budgetMatch = /งบส่วน\s*A\s*ไม่เกิน\s*([\d,]+)\s*ตัวอักษร/u.exec(String(soul?.parts?.C || ""));
  const budgetA = budgetMatch ? Number(budgetMatch[1].replace(/,/gu, "")) : null;
  return { pins, forbidden, unchecked, budgetA };
}

function blocksFor(soul, path) {
  const paths = soul?.paths || {};
  if (path) return [String(paths[path] ?? soul?.parts?.A ?? "")];
  if (soul?.compiled) return [String(soul?.parts?.A || "")];
  return Object.keys(paths).length ? Object.values(paths).map(String) : [String(soul?.parts?.A || "")];
}

/**
 * ตรวจสัญญา — คืน { ok, failures: [ข้อความภาษาไทย], checked, unchecked }
 * รับ soul ที่ parse แล้ว (parseSoul) หรือ soul ที่โหลดแล้ว (loadSoul)
 */
export function soulContract(soul) {
  const { pins, forbidden, unchecked, budgetA } = readContract(soul);
  const failures = [];
  const lengthA = [...String(soul?.parts?.A || "")].length;
  if (budgetA !== null && lengthA > budgetA) failures.push(`C3 ส่วน A ยาว ${lengthA} ตัวอักษร เกินงบ ${budgetA}`);
  for (const { path, pin } of pins) {
    if (!blocksFor(soul, path).some((block) => block.includes(pin))) failures.push(`C1 ขาดหมุด${path ? ` (${path})` : ""}: "${pin}"`);
  }
  const pinTexts = pins.map((p) => p.pin);
  const partB = String(soul?.parts?.B || "");
  // ข้อห้ามที่ไม่ระบุเส้น: ตรวจทุกข้อความที่ถึงโมเดล — soul แบบคอมไพล์ = ทุกบล็อกหลังประกอบ (รวมคำห่อของแต่ละเส้น)
  const everything = soul?.compiled ? Object.values(soul?.paths || {}).map(String) : null;
  for (const rule of forbidden) {
    const texts = [...(everything && !rule.path ? everything : blocksFor(soul, rule.path)), ...(rule.path ? [] : [partB])];
    if (rule.kind === "regex") {
      let pattern;
      try {
        pattern = new RegExp(rule.value, "u");
      } catch {
        failures.push(`${rule.source} regex อ่านไม่ได้: ${rule.value}`);
        continue;
      }
      if (texts.some((text) => pattern.test(text))) failures.push(`${rule.source} เจอสิ่งต้องห้าม /${rule.value}/`);
      continue;
    }
    // วลีที่อยู่ในหมุด C1 (ประโยคที่บอกให้เลี่ยงวลีนั้น) ไม่นับเป็นการละเมิด
    const excusing = pinTexts.filter((pin) => pin.includes(rule.value));
    const hit = texts.some((text) => excusing.reduce((acc, pin) => acc.split(pin).join(""), text).includes(rule.value));
    if (hit) failures.push(`${rule.source} เจอวลีต้องห้าม: "${rule.value}"`);
  }
  return { ok: failures.length === 0, failures, checked: pins.length + forbidden.length + (budgetA !== null ? 1 : 0), unchecked,
    ...(budgetA !== null ? { budgetA, lengthA } : {}) };
}
