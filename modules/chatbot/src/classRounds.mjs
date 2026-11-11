// classRounds.mjs — ที่นั่งคงเหลือต่อรอบเรียน ให้ทีมงานกรอกเองจากคอนโซล
//
// ทำไมแยกที่เก็บเป็นสองที่:
// - "มีรอบวันไหนบ้าง" เปลี่ยนปีละไม่กี่ครั้ง -> อยู่ในไฟล์ (CLASS_ROUNDS_FILE) อ่านอย่างเดียว
//   และเดินเข้า prompt ผ่านคลังความรู้ ซึ่งเป็นส่วน "คงที่" ที่ prompt cache จับได้
// - "เหลือกี่ที่นั่ง" เปลี่ยนได้ทุกชั่วโมง -> อยู่ใน DB แล้วฉีดเข้าส่วนกติกา (ส่วนที่เปลี่ยน
//   ทุกเทิร์นอยู่แล้ว) ถ้าเอาไปยัดในคลังความรู้ ทุกครั้งที่แก้ที่นั่ง cache จะพังทั้งก้อน
//   = ค่าโมเดลเด้งขึ้นเท่าตัวจากการกรอกเลขที่นั่งครั้งเดียว
//
// ไม่มีไฟล์ = ปิดฟีเจอร์เงียบ ๆ (ธุรกิจอื่นที่ไม่มีรอบเรียนต้องไม่เห็นเมนูนี้)

import { readFileSync } from "node:fs";

// v1.4.35 (พี่ง้วงสั่ง 2026-08-19): เก็บ "จำนวนคนที่ลงทะเบียนแล้ว" ไม่ใช่ "ที่นั่งเหลือ"
// เพราะนั่นคือตัวเลขที่ทีมงานรู้จริงและรายงานในกลุ่ม LINE ทุกวัน
// ("ลงทะเบียนแล้ว = 7") ส่วน "เหลือกี่ที่" เป็นผลลัพธ์ที่คำนวณได้เสมอ
// เก็บตัวที่คนรู้ แล้วคำนวณตัวที่เหลือ — ไม่ใช่ให้คนคำนวณในหัวก่อนกรอก
export const CLASS_ENROLLED_SETTING = "class_enrolled";
export const ENROLLED_MAX = 999;
export const DEFAULT_SEATS_PER_ROUND = 15;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

// อ่านรอบจากไฟล์ — ทุกความล้มเหลวคืน [] เพราะแชทต้องเดินต่อได้เสมอ
export function readRoundsFile(file, logger = console) {
  if (!file) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const classes = raw?.classes || {};
    const capacity = Number(raw?.seatsPerRound) > 0 ? Number(raw.seatsPerRound) : DEFAULT_SEATS_PER_ROUND;
    return (Array.isArray(raw?.rounds) ? raw.rounds : [])
      .filter((round) => ISO_DATE.test(String(round?.date || "")) && classes[round?.class])
      .map((round) => ({
        date: String(round.date),
        classKey: String(round.class),
        label: String(classes[round.class]?.label || round.class),
        product: String(classes[round.class]?.product || ""),
        fileStatus: String(round.status || "open"),
        capacity,
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  } catch (err) {
    logger?.warn?.(`classRounds: อ่าน ${file} ไม่สำเร็จ (${err?.message || err}) — ซ่อนเมนูที่นั่ง`);
    return [];
  }
}

export function readEnrolled(db) {
  try {
    const raw = db.getSetting(CLASS_ENROLLED_SETTING);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out = {};
    for (const [date, value] of Object.entries(parsed)) {
      if (ISO_DATE.test(date) && Number.isInteger(value) && value >= 0 && value <= ENROLLED_MAX) out[date] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function writeEnrolled(db, enrolled) {
  db.setSetting(CLASS_ENROLLED_SETTING, JSON.stringify(enrolled));
}

// ===== รอบเรียนที่กรอกเองจาก Console (คำสั่งพี่ง้วง 2026-08-26) =====
//
// เดิมตารางรอบเรียนอยู่ในไฟล์ที่ฝังมากับ release ซึ่งเขียนไม่ได้ (release root เป็น read-only
// โดยเจตนา) การประกาศรอบใหม่จึงต้องแก้ไฟล์ในเครื่องแล้วรอ release ถัดไป
// และต้องพึ่งงานซิงก์ภายนอก ซึ่งพังได้แบบไม่มีใครเห็น
//
// ย้ายมาเก็บใน settings ของฐานข้อมูล: พี่ง้วงกรอกในหน้า "ที่นั่ง" แล้วมีผลทันที
// อยู่ข้าม release และเข้าไฟล์สำรองอัตโนมัติ ไฟล์เดิมยังใช้เป็นค่าตั้งต้นได้อยู่
// ถ้ายังไม่เคยกรอกอะไรเลย
const CLASS_ROUNDS_SETTING = "class_rounds_manual";
// capacity = null แปลว่า "ไม่จำกัดที่นั่ง" (คลาสออนไลน์)
// ห้ามบอกลูกค้าเป็นตัวเลข ให้บอกว่าราคาพิเศษมีจำนวนจำกัดแทน
export const UNLIMITED_SEATS = null;

export function readManualRounds(db) {
  try {
    const raw = db.getSetting(CLASS_ROUNDS_SETTING);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((round) => ISO_DATE.test(String(round?.date || "")) && String(round?.label || "").trim())
      .map((round) => {
        const cap = round.capacity;
        return {
          date: String(round.date),
          classKey: String(round.classKey || round.class || "custom"),
          label: String(round.label).trim().slice(0, 80),
          product: String(round.product || "").trim().slice(0, 80),
          fileStatus: ["open", "almost_full", "full", "closed"].includes(String(round.status))
            ? String(round.status) : "open",
          // ตัวเลข = จำกัดที่นั่ง · null = ไม่จำกัด (ออนไลน์)
          capacity: Number.isInteger(cap) && cap > 0 ? cap : UNLIMITED_SEATS,
        };
      })
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  } catch {
    return [];
  }
}

export function writeManualRounds(db, rounds) {
  db.setSetting(CLASS_ROUNDS_SETTING, JSON.stringify(rounds));
}

// รอบที่อ่านแล้ว (ช่อง fileStatus) -> รูปที่เก็บ (ช่อง status) ก่อนเขียนทับทั้งชุด
// เดิมหน้า "ที่นั่ง" เขียนผลของ readManualRounds กลับตรง ๆ ช่อง status จึงหายทุกครั้งที่แก้รอบหนึ่ง
// แล้วรอบอื่นที่ตั้งเป็น "เต็ม/ปิด" ไว้เด้งกลับเป็น "เปิดรับ" เงียบ ๆ (พบ 2026-09-28)
export function toStoredRound(round) {
  return {
    date: round.date, classKey: round.classKey, label: round.label,
    product: round.product, status: round.fileStatus, capacity: round.capacity,
  };
}

const THAI_MONTHS = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const THAI_WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];

export function thaiShortDate(isoDate) {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  return `${day} ${THAI_MONTHS[month - 1]} ${year}`;
}

// บอกโมเดลว่า "วันนี้วันไหน" (พี่ง้วงให้แก้การ์ดรอบเรียน 2026-09-28): prompt ของเส้นตอบลูกค้า
// ไม่เคยมีวันที่เลย การ์ดรอบในคลังความรู้จึงตัดรอบที่ผ่านไปแล้วเองไม่ได้ และจะกลับมาโชว์รอบเก่า
// ว่า "เปิดรับสมัคร" อีกทุกสัปดาห์ รูปวันเดียวกับตารางในการ์ด ("เสาร์ 10 ต.ค. 2026") ให้เทียบตรง ๆ
// มีแค่วันที่ ไม่มีเวลา = เปลี่ยนวันละครั้ง และอยู่ในก้อนกติกาที่เปลี่ยนทุกเทิร์นอยู่แล้ว
export function todayRoundsLine(todayIso) {
  if (!ISO_DATE.test(String(todayIso || ""))) return "";
  const [year, month, day] = String(todayIso).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // วันที่ที่ไม่มีจริง (เช่น 2026-02-29) ห้ามเลื่อนไปวันถัดไปเงียบ ๆ แล้วพิมพ์ชื่อวันไม่ตรงกับวันที่
  if (date.toISOString().slice(0, 10) !== todayIso) return "";
  const weekday = THAI_WEEKDAYS[date.getUTCDay()];
  return `- วันนี้ (เวลาไทย) คือ ${weekday} ${thaiShortDate(todayIso)} — รอบเรียนที่วันเรียนถึงหรือผ่านวันนี้แล้วถือว่าปิดรับ ห้ามเสนอ และคำอย่าง "เสาร์นี้" หรือ "สัปดาห์หน้า" ให้นับจากวันนี้`;
}

// รวมไฟล์ + ที่นั่ง แล้วตัดรอบที่ผ่านไปแล้วออก (รอบวันนี้ถือว่าสมัครไม่ทันแล้ว)
export function upcomingRounds({ file, db, todayIso, logger } = {}) {
  const enrolled = readEnrolled(db);
  // ที่กรอกเองจาก Console ชนะไฟล์เสมอ — ถ้ายังไม่เคยกรอก ใช้ไฟล์เป็นค่าตั้งต้น
  const manual = db ? readManualRounds(db) : [];
  const source = manual.length ? manual : readRoundsFile(file, logger);
  return source
    .filter((round) => round.date > todayIso)
    .map((round) => {
      const taken = Object.hasOwn(enrolled, round.date) ? enrolled[round.date] : null;
      return {
        ...round,
        thai: thaiShortDate(round.date),
        enrolled: taken,
        // ลงเกินความจุได้จริง (พี่ง้วง: "บางครั้งอาจเกิน") — ที่นั่งเหลือติดลบไม่มีความหมาย
        // สำหรับลูกค้า จึงตัดที่ 0 = เต็ม ส่วนยอดที่เกินเก็บไว้ให้ทีมงานเห็นในคอนโซล
        // capacity = null (ออนไลน์ ไม่จำกัดที่นั่ง) -> ไม่มีตัวเลขที่นั่งเหลือให้บอกลูกค้า
        unlimited: round.capacity === UNLIMITED_SEATS,
        seatsLeft: (round.capacity === UNLIMITED_SEATS || taken === null)
          ? null : Math.max(0, round.capacity - taken),
        overbooked: (round.capacity === UNLIMITED_SEATS || taken === null)
          ? 0 : Math.max(0, taken - round.capacity),
      };
    });
}

// ===== รายการรอบเรียนที่ประกาศแล้ว — แหล่งเดียวคือหน้า "ที่นั่ง" (คำสั่งพี่ง้วง 28 ก.ย. 2026) =====
// "แก้ที่นั่ง เอาแค่ที่เดียวพอได้ไหม ใส่ตรงที่นั่งเมนูอย่างเดียว และลูกแพรเอาตรงนั้นไปใช้"
// เดิมวันเรียนอยู่สองที่: หน้าที่นั่ง (ตัวเลขที่นั่ง) กับการ์ดรอบเรียนในคลังความรู้ (รายการวัน) ซึ่งต้องแก้
// มือทุกครั้งที่เพิ่มรอบ และค้างรอบที่ผ่านไปแล้วว่า "เปิดรับสมัคร" จนพี่ง้วงต้องสั่งแก้ (28 ก.ย.)
// ตอนนี้ลูกแพรอ่านรายการรอบจากหน้าที่นั่งสดทุกข้อความ (ตัดรอบที่ถึง/ผ่านวันนี้แล้วด้วย upcomingRounds)
// บอกแค่ "มีรอบไหน + สถานะ" — จำนวนที่นั่งยังอยู่ใน seatRuleLines เหมือนเดิม (คนละหน้าที่ ไม่พูดซ้ำ)
// เพดาน 12 รอบที่ใกล้ที่สุด: ก้อนนี้ไม่ได้อยู่ใน prompt cache ทุกบรรทัดคือค่าใช้จ่ายทุกเทิร์น
export const ANNOUNCED_ROUNDS_MAX = 12;

function roundStatusThai(round) {
  const status = String(round?.fileStatus ?? "open");
  if (status === "closed") return "ปิดรับสมัครแล้ว (ห้ามรับจอง ให้เสนอรอบถัดไป)";
  if (status === "full" || round?.seatsLeft === 0) return "เต็มแล้ว (ห้ามรับจอง ให้เสนอรอบถัดไป)";
  if (status === "almost_full") return "ใกล้เต็ม";
  return "เปิดรับสมัคร";
}

export function announcedRoundsLines(rounds = []) {
  const all = Array.isArray(rounds) ? rounds : [];
  if (!all.length) {
    return ["- ตอนนี้ยังไม่มีรอบเรียนที่ประกาศ — ห้ามเดาวันเรียนเอง ถ้าลูกค้าถามให้บอกว่ากำลังจะประกาศรอบใหม่ แล้วขอชื่อกับเบอร์ไว้แจ้ง"];
  }
  const shown = all.slice(0, ANNOUNCED_ROUNDS_MAX);
  const lines = ["- รอบเรียนที่ประกาศแล้ว (ข้อมูลสดจากหน้า \"ที่นั่ง\" ของทีม — เสนอได้เฉพาะรอบในรายการนี้ ห้ามใช้วันเรียนจากที่อื่น):"];
  for (const round of shown) {
    const [year, month, day] = String(round.date).split("-").map(Number);
    const weekday = THAI_WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
    lines.push(`  · ${weekday} ${thaiShortDate(round.date)} — ${round.label} — ${roundStatusThai(round)}`);
  }
  if (all.length > shown.length) {
    lines.push(`  · (มีรอบถัดไปอีก ${all.length - shown.length} รอบ — ถ้าลูกค้าถามวันที่ไกลกว่านี้ ให้บอกว่าขอเช็ครอบให้ก่อน)`);
  }
  return lines;
}

// กติกาที่ฉีดเข้า prompt — เขียนให้ "ทับคลังความรู้" ชัดเจน เพราะคลังบอกแค่ว่าเปิดรับสมัคร
// ส่วนตัวเลขที่นั่งสด ๆ อยู่ตรงนี้ ถ้าไม่บอกว่าอันไหนใหม่กว่า โมเดลจะเลือกเองแบบสุ่ม
//
// กติกา 0 ที่นั่งมาจากพี่ง้วงโดยตรง: ห้ามแจ้งเต็มแล้วจบเฉย ๆ ต้องเสนอรอบถัดไปทันที
// ในข้อความเดียวกัน (แจ้งเต็มแล้วเงียบ = ปิดประตูขายทั้งที่ลูกค้ากำลังสนใจ)
export function seatRuleLines(rounds = []) {
  const known = rounds.filter((round) => round.seatsLeft !== null);
  // คำสั่งพี่ง้วง 2026-08-26: คลาสออนไลน์ไม่มีลิมิตที่นั่ง แต่ "ห้ามบอกลูกค้าว่าไม่จำกัด"
  // ให้บอกว่าราคาพิเศษมีจำนวนจำกัดแทน — จำนวนที่จำกัดคือสิทธิ์ราคา ไม่ใช่ที่นั่ง
  const unlimited = rounds.filter((round) => round.unlimited === true);
  if (!known.length && !unlimited.length) return [];
  const lines = [];
  if (known.length) {
    lines.push("- ที่นั่งคงเหลือล่าสุดจากทีมงาน (ข้อมูลนี้ใหม่กว่าคลังความรู้เสมอ ให้ยึดอันนี้):");
    for (const round of known) {
      lines.push(round.seatsLeft === 0
        ? `  · ${thaiShortDate(round.date)} (${round.label}) เต็มแล้ว — ห้ามรับจอง ให้บอกว่าเต็มแล้วพร้อมเสนอรอบถัดไปที่เหมาะทันทีในข้อความเดียวกัน`
        : `  · ${thaiShortDate(round.date)} (${round.label}) เหลือ ${round.seatsLeft} ที่นั่ง — บอกตัวเลขนี้ได้ แล้วชวนยืนยันสิทธิ์แบบไม่กดดัน`);
    }
  }
  if (unlimited.length) {
    lines.push("- รอบที่รับได้ไม่จำกัดจำนวน (คลาสออนไลน์) — ห้ามพูดคำว่า “ไม่จำกัด” หรือบอกตัวเลขที่นั่งเด็ดขาด:");
    for (const round of unlimited) {
      lines.push(`  · ${thaiShortDate(round.date)} (${round.label}) — ให้บอกว่า “ราคาพิเศษมีจำนวนจำกัด” แล้วชวนยืนยันสิทธิ์แบบไม่กดดัน ห้ามบอกว่ามีที่นั่งเหลือเท่าไร`);
    }
  }
  lines.push("- รอบที่ไม่ได้อยู่ในรายการนี้ ห้ามเดาจำนวนที่นั่งเอง ให้บอกว่าที่นั่งจำนวนจำกัดและยืนยันตามลำดับการชำระ");
  return lines;
}
