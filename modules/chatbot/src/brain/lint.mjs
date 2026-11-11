// brain/lint.mjs — 8 กฎที่เปิดตัวตามแบบแปลน §5 (L01 L02+L02b L03 L05 L07 L12 L15 L16)
//
// ทุกข้อคืน {code, severity, message, cardId} — ข้อความเป็นภาษาไทยเพราะคนที่ต้องแก้คือ
// เจ้าของและทีมงาน ไม่ใช่ช่าง
//
// กฎ grandfather (แบบแปลน §5): การ์ดที่มาจาก import และ body ยังไม่เคยถูกแก้ ได้
// L02/L03/L05 เป็น "เตือน" ไม่ใช่ "บล็อก" พร้อมตัวนับหนี้ความรู้
//
// โหมด `compat` (เฟส 1a) ขยายรายการนั้นเป็น L15/L16/L07 ด้วย และนี่คือการตัดสินใจที่
// ต้องเขียนเหตุผลไว้: เฟสนี้ตัวนำเข้า **ห้ามแก้หรือทิ้งเนื้อหา** ไม่ว่ากรณีใด เพราะ
// เป้าหมายเดียวของมันคือ "สมองต้องได้ไบต์เดียวกับ prompt วันนี้" ถ้า L15 บล็อกได้
// ทางเลือกมีแค่ (ก) ไม่นำเข้าการ์ดนั้น = สมองไม่ตรง หรือ (ข) ลบข้อความในการ์ด =
// สมองไม่ตรง ทั้งสองทางทำลายเหตุผลของเฟส คำเตือนยังถูกบันทึกครบใน gate_report_json
// ให้เจ้าของไล่แก้ "ที่แหล่ง" แล้วนำเข้าใหม่ — P1b ที่มีด่านจริงจะสลับโหมดเป็น strict
import { learningRiskFlags } from "../learningDigest.mjs";
import { ACCEPTING_ROUND_STATUSES } from "./sources.mjs";
import { hasNormalizerCasualties } from "./text.mjs";

export const GRANDFATHERED_CODES = Object.freeze(["L02", "L03", "L05"]);
export const COMPAT_GRANDFATHERED_CODES = Object.freeze(["L02", "L03", "L05", "L15", "L16"]);
// L07 ไม่ผูกกับการ์ดใบเดียว (เป็นงบรวมของขอบเขต) จึงเข้าเกณฑ์ provenance ไม่ได้
export const COMPAT_ALWAYS_WARN_CODES = Object.freeze(["L07"]);
// กฎที่พูดถึง "ข้อความที่ไปถึงลูกค้า" — เงียบสำหรับการ์ดที่ถูกปิดไปแล้ว
export const OFF_CARD_SILENT_CODES = Object.freeze(["L02", "L05", "L12", "L16"]);
export const BLOCK = "block";
export const WARN = "warn";

// สิ่งที่ต้องไม่มีวันไปถึงลูกค้า — คำที่แปลว่า "นี่คือของปลอม/ของทดสอบ/บั๊ก"
const SENTINELS = Object.freeze(["(Mock)", "local candidate", "โหมดเทรน", "no live send", "undefined", "NaN"]);
// ตัวเลขรูปเงินบาท: มีคอมมาคั่นหลักพัน หรือมีคำว่าบาท/฿ ติดอยู่
const MONEY_LIKE = /(?:฿\s*\d[\d,]*(?:\.\d+)?)|(?:\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)|(?:\b\d{3,}(?:\.\d+)?\s*บาท)/gu;
// L02b: คำที่แปลว่า "นี่คือเงื่อนไขเงิน" — การ์ดสีเขียวพูดคำพวกนี้ไม่ได้โดยไม่ยกระดับ
const MONEY_TERMS = /(?:%|เปอร์เซ็นต์|ส่วนลด|ผ่อน|มัดจำ|คืนเงิน)/u;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const THAI_MOBILE = /\b0\d{8,9}\b/gu;
const LINE_HANDLE = /@[A-Za-z0-9._-]{4,}/gu;
// คำว่า "LINE id" ที่ตามด้วยไอดีจริง ๆ — เก็บตัวไอดีไว้เทียบ allowlist
// (เดิมแค่มีคำว่า "ไลน์ไอดี" ก็ฟ้องแล้ว ไม่ว่าไอดีที่ตามมาจะเป็นของร้านเราเองหรือไม่
//  ผลคือการ์ด "ช่องทางติดต่อ" ของร้านถูกล็อกแก้ไม่ได้ตลอดกาล แม้เจ้าของจะยกเว้นไอดีนั้นแล้ว)
const LINE_ID_TOKEN = /(?:line\s*id|ไลน์ไอดี)\s*[:：]?\s*(@?[A-Za-z0-9._-]{3,})/giu;
// ลำดับตัวเลขยาว ๆ ที่คั่นด้วยขีด/ช่องว่างได้ (เลขบัญชี 10 หลัก, เลขผู้เสียภาษี/บัตร 13 หลัก)
// ตัดตัวเลขสั้นและวันที่ทิ้งด้วยเพดาน 9 หลัก — ไม่งั้น "2026-09-03" จะกลายเป็นเลขบัญชี
const DIGIT_RUN = /\d[\d\s-]{4,}\d/gu;
const ACCOUNT_MIN_DIGITS = 9;
const onlyDigits = (value) => String(value ?? "").replace(/\D+/gu, "");
// 45 วัน = เกณฑ์เดียวกับ roundsWatch เดิม (แบบแปลน L03)
const ROUND_HORIZON_DAYS = 45;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{cards: object[], bundle: object, todayIso?: string|null,
 *          allowlist?: string[], mode?: 'compat'|'strict'}} input
 * @returns {{code: string, severity: 'block'|'warn', message: string, cardId: string|null}[]}
 */
export function runBrainLints({ cards = [], bundle = {}, todayIso = null, allowlist = [], mode = "compat" } = {}) {
  const today = todayIso ?? bundle.todayIso ?? null;
  const allowed = new Set((allowlist ?? []).map((value) => String(value).toLowerCase()));
  // ชั้นตัวเลขล้วนของ allowlist: เลขบัญชี/เลขผู้เสียภาษี "ของร้านเราเอง" ที่เจ้าของยืนยัน
  // (config/brain-lint-allowlist.json ช่อง accountNumbers) — เทียบแบบตัดขีด/ช่องว่างทิ้ง
  // เพราะคนเขียนการ์ดใส่ขีดคั่นบ้าง ไม่ใส่บ้าง แต่มันคือเลขเดียวกัน
  const allowedDigits = new Set(
    (allowlist ?? []).map((value) => onlyDigits(value)).filter((digits) => digits.length >= ACCOUNT_MIN_DIGITS),
  );
  const findings = [
    ...lintL01(cards),
    ...lintL02(cards, bundle),
    ...lintL03(cards, today),
    ...lintL05(cards),
    ...lintL07(bundle),
    ...lintL12(cards),
    ...lintL15(cards, allowed, allowedDigits),
    ...lintL16(cards),
  ];
  // การ์ดที่ถูกปิด (inject 'never') ไม่ได้เข้า prompt เลย — กฎที่พูดถึง "ข้อความที่ไปถึงลูกค้า"
  // จึงไม่มีอะไรให้พูดถึง ถ้ายังฟ้องอยู่ การปิดของเสียจะถูกกันด้วยของเสียชิ้นนั้นเอง ทั้งที่
  // การลบใบเดียวกันผ่านได้ = กฎที่สอนให้คนลบทิ้งแทนที่จะปิดเก็บไว้ดูประวัติ
  // ยกเว้น L15 (PDPA): เนื้อยังถูกเก็บอยู่ในฐานแม้จะปิด จึงยังต้องเห็น แต่เป็นคำเตือน
  const silenced = new Set(cards.filter((card) => card.inject === "never").map((card) => card.itemId));
  return findings
    .filter((finding) => !(silenced.has(finding.cardId) && OFF_CARD_SILENT_CODES.includes(finding.code)))
    .map((finding) => (silenced.has(finding.cardId) && finding.code === "L15"
      ? { ...finding, severity: WARN, offCard: true }
      : finding))
    .map((finding) => (shouldGrandfather(finding, cards, mode) ? { ...finding, severity: WARN, grandfathered: true } : finding))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || compareIds(a.cardId, b.cardId));
}

function compareIds(a, b) {
  return String(a ?? "") < String(b ?? "") ? -1 : String(a ?? "") > String(b ?? "") ? 1 : 0;
}

// การ์ดที่ provenance.source ขึ้นต้น "import:" = ยังไม่มีใครแตะตั้งแต่ยกเข้ามา
//
// โหมด `gate` (เฟส 1b) ไม่ยกเว้นให้ใครเลยโดยเจตนา: sources.mjs ติดป้าย provenance
// `import:knowledge_entries:<id>` ให้ทุกแถวความรู้ ไม่ว่าใครจะเพิ่งแก้ไปเมื่อสิบวินาทีก่อน
// ธง grandfather จึงแยก "ของเก่าที่ยกมา" ออกจาก "ของที่เพิ่งแก้" ไม่ได้ ซึ่งกลับหัวเจตนา
// ของกฎ (แบบแปลน §5: รายการที่แก้หรือเพิ่มต้องผ่าน) — ด่านตรวจมีสัญญาณที่ดีกว่าคือชุด
// item_id ที่การแก้ครั้งนี้แตะจริง แล้วจัดของเก่าเป็น needs_ack เอง (ดู brain/gate.mjs)
function shouldGrandfather(finding, cards, mode) {
  if (mode === "gate") return false;
  const compat = mode === "compat";
  if (compat && COMPAT_ALWAYS_WARN_CODES.includes(finding.code)) return true;
  const codes = compat ? COMPAT_GRANDFATHERED_CODES : GRANDFATHERED_CODES;
  if (!codes.includes(finding.code)) return false;
  const card = cards.find((row) => row.itemId === finding.cardId);
  return String(card?.provenance?.source || "").startsWith("import:");
}

/* ------------------------------------ L01 ----------------------------------- */
// คีย์เดียว scope/เวลาซ้อนกัน โดยไม่มี supersedes_rev — สองการ์ดพูดเรื่องเดียวกันคนละคำตอบ
function lintL01(cards) {
  const byKey = new Map();
  for (const card of cards) {
    const bucket = `${card.kind}|${card.key}|${JSON.stringify(card.scope ?? {})}`;
    if (!byKey.has(bucket)) byKey.set(bucket, []);
    byKey.get(bucket).push(card);
  }
  const out = [];
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    for (const card of group.slice(1)) {
      out.push({
        code: "L01", severity: BLOCK, cardId: card.itemId,
        message: `การ์ด "${cardLabel(card)}" ซ้ำคีย์และขอบเขตกับอีกใบ แต่ไม่ได้ระบุว่าใบไหนแทนที่ใบไหน — เลือกใบที่ถูกต้องแล้วลบอีกใบ`,
      });
    }
  }
  return out;
}

/* --------------------------------- L02 / L02b -------------------------------- */
// ตัวเลขรูปเงินในการ์ดที่ไม่ใช่ราคา ต้องเป็นยอดที่อนุมัติแล้วเท่านั้น
function lintL02(cards, bundle) {
  const approved = new Set((bundle?.guardTables?.approvedAmounts ?? []).map(Number));
  const out = [];
  for (const card of cards) {
    if (card.kind === "price") continue;
    const text = textOf(card);
    for (const raw of text.match(MONEY_LIKE) ?? []) {
      const amount = Number(String(raw).replace(/[^\d.]/gu, ""));
      if (!Number.isFinite(amount) || approved.has(amount)) continue;
      out.push({
        code: "L02", severity: BLOCK, cardId: card.itemId, detail: raw.trim(),
        message: `การ์ด "${cardLabel(card)}" มีตัวเลข ${raw.trim()} ที่ไม่อยู่ในตารางราคาที่อนุมัติ — เพิ่มเป็นราคา/ส่วนลดที่อนุมัติ หรือเอาตัวเลขออก`,
      });
    }
    // L02b: การ์ดสีเขียว (fact) ที่พูดเงื่อนไขเงิน ต้องถูกยกระดับ ไม่ใช่เผยแพร่แบบมอบสิทธิ์
    // ติดป้าย rule ไว้เพราะด่านต้องยกเป็น "บล็อก" เมื่อคนเขียนใช้สิทธิ์ที่มอบมา — ข้อความ
    // ของกฎข้อนี้บอกอยู่แล้วว่า "เผยแพร่แบบมอบสิทธิ์ไม่ได้" ถ้ามันยังเป็นแค่คำเตือน
    // กฎข้อนี้ก็ไม่เคยกันอะไรเลย (ดู brain/gate.mjs)
    if (card.kind === "fact" && MONEY_TERMS.test(text)) {
      out.push({
        code: "L02", rule: "L02b", severity: WARN, cardId: card.itemId,
        message: `การ์ด "${cardLabel(card)}" พูดถึงเงื่อนไขเงิน (ส่วนลด/ผ่อน/มัดจำ/คืนเงิน/%) — ต้องให้เจ้าของอนุมัติ เผยแพร่แบบมอบสิทธิ์ไม่ได้`,
      });
    }
  }
  return out;
}

/* ------------------------------------ L03 ----------------------------------- */
// รอบที่ผ่านไปแล้วแต่ยังเปิดรับ / โปรที่หมดอายุ / สินค้าที่ขายอยู่แต่ไม่มีรอบข้างหน้า
const accepting = (card) => ACCEPTING_ROUND_STATUSES.includes(String(card.body?.status));

function lintL03(cards, todayIso) {
  const out = [];
  const schedules = cards.filter((card) => card.kind === "schedule");
  for (const card of schedules) {
    if (todayIso && String(card.body?.date) <= todayIso && accepting(card)) {
      out.push({
        code: "L03", severity: BLOCK, cardId: card.itemId,
        message: `รอบ ${card.body.date} (${card.body.label_th}) ผ่านไปแล้วแต่ยังเปิดรับสมัคร — ปิดรอบหรือเลื่อนวัน`,
      });
    }
  }
  const nowMs = todayIso ? Date.parse(`${todayIso}T00:00:00Z`) : null;
  for (const card of cards) {
    if (card.validUntil && nowMs !== null && Number(card.validUntil) < nowMs) {
      out.push({
        code: "L03", severity: BLOCK, cardId: card.itemId,
        message: `การ์ด "${cardLabel(card)}" หมดอายุไปแล้ว แต่ยังอยู่ในเวอร์ชันนี้ — เอาออกหรือต่ออายุ`,
      });
    }
  }
  if (todayIso) {
    const openDates = schedules.filter(accepting).map((card) => card.body.date).sort();
    for (const product of cards.filter((card) => card.kind === "product" && card.body?.status === "selling")) {
      const mine = schedules.filter((card) => card.body?.product_key === product.body?.name_th && accepting(card));
      const horizon = (mine.length ? mine.map((c) => c.body.date) : openDates).filter((date) => date > todayIso).sort();
      if (!horizon.length) {
        out.push({
          code: "L03", severity: WARN, cardId: product.itemId,
          message: `สินค้า "${product.body.name_th}" ยังขายอยู่แต่ไม่มีรอบที่เปิดรับข้างหน้าเลย — ประกาศรอบถัดไป`,
        });
      } else if (Date.parse(`${horizon.at(-1)}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`) < ROUND_HORIZON_DAYS * DAY_MS) {
        out.push({
          code: "L03", severity: WARN, cardId: product.itemId,
          message: `สินค้า "${product.body.name_th}" มีรอบเปิดสุดท้าย ${horizon.at(-1)} ซึ่งเหลือน้อยกว่า ${ROUND_HORIZON_DAYS} วัน — เตรียมรอบถัดไป`,
        });
      }
    }
  }
  return out;
}

/* ------------------------------------ L05 ----------------------------------- */
// ชื่อสินค้าที่การ์ดอื่นอ้างถึง ต้องมีการ์ดสินค้าเป็นชื่อ canonical จริง ๆ
function lintL05(cards) {
  const canonical = new Set();
  for (const card of cards.filter((row) => row.kind === "product")) {
    canonical.add(String(card.body?.name_th ?? ""));
    for (const alias of card.body?.aliases ?? []) canonical.add(String(alias));
  }
  const out = [];
  for (const card of cards) {
    const referenced = String(card.body?.product_key ?? "").trim();
    if (!referenced || canonical.has(referenced)) continue;
    out.push({
      code: "L05", severity: BLOCK, cardId: card.itemId,
      message: `การ์ด "${cardLabel(card)}" อ้างสินค้า "${referenced}" ที่ไม่มีชื่อจริงในแคตตาล็อก — เพิ่มสินค้าหรือแก้ชื่อให้ตรง`,
    });
  }
  return out;
}

/* ------------------------------------ L07 ----------------------------------- */
// งบตัวอักษรที่ปักหมุด: ต้องวัด "ก่อนตัด" เสมอ
//
// วัดหลังตัดคือกับดักที่มองไม่เห็น: buildKnowledgeSection ตัดให้พอดีเพดานอยู่แล้ว
// ตัวเลขหลังตัดจึงไม่มีวันเกิน แล้ว L07 จะเงียบตลอดกาลพอดีในวันที่ความรู้เริ่มตกขอบ
// ซึ่งเป็นเหตุการณ์ที่กฎข้อนี้ถูกเขียนขึ้นมาเพื่อจับ (R08/R10: แคตตาล็อกราคาหายเงียบ)
function lintL07(bundle) {
  const cap = Number(bundle?.budget?.knowledgeMaxChars ?? 0);
  if (!cap) return [];
  const out = [];
  for (const [scope, usage] of Object.entries(bundle?.budget?.usage ?? {})) {
    const total = Number(usage?.totalChars ?? 0);
    const dropped = Number(usage?.droppedCount ?? 0);
    if (total <= cap && dropped === 0) continue;
    out.push({
      // scope = ชื่อขอบเขต (central / channel id) — ด่านใช้เทียบกับงบของรุ่นก่อนหน้า
      // เพื่อแยก "การแก้ครั้งนี้ทำให้ล้น" ออกจาก "ล้นอยู่ก่อนแล้ว" (ดู brain/gate.mjs)
      code: "L07", severity: BLOCK, cardId: null, scope,
      message: `ความรู้ของขอบเขต "${scope}" รวม ${total} ตัวอักษร เกินเพดาน ${cap}`
        + ` — มี ${dropped} รายการถูกตัดทิ้งก่อนเข้า prompt ต้องตัดเนื้อหาเอง ไม่ใช่ปล่อยให้ระบบทิ้งรายการเก่าสุด`,
    });
  }
  return out;
}

/* ------------------------------------ L12 ----------------------------------- */
function lintL12(cards) {
  const out = [];
  for (const card of cards) {
    const text = textOf(card);
    for (const sentinel of SENTINELS) {
      if (!text.includes(sentinel)) continue;
      out.push({
        code: "L12", severity: BLOCK, cardId: card.itemId,
        message: `การ์ด "${cardLabel(card)}" มีคำว่า "${sentinel}" ซึ่งเป็นร่องรอยของข้อมูลทดสอบหรือบั๊ก — ห้ามไปถึงลูกค้า`,
      });
    }
  }
  return out;
}

/* ------------------------------------ L15 ----------------------------------- */
// PDPA: ข้อมูลส่วนบุคคลต้องไม่ถูกฝังอยู่ในความรู้ของธุรกิจ
//
// allowlist = ช่องทางติดต่อของร้านเราเอง (ดึงจากไฟล์ที่ปักหมุด + config ของ instance)
// ถ้าไม่มีข้อยกเว้นนี้ เบอร์ OA ของร้านที่อยู่ใน persona อยู่แล้วจะถูกฟ้องทุกใบ
// แล้วรายงานจะกลายเป็นเสียงรบกวนที่ไม่มีใครอ่าน = กฎที่ตายทั้งที่ยังเปิดอยู่
function lintL15(cards, allowed, allowedDigits = new Set()) {
  const out = [];
  for (const card of cards) {
    const text = textOf(card);
    const hits = [];
    if (matchesOutsideAllowlist(text, EMAIL, allowed)) hits.push("อีเมล");
    // เลขบัญชีที่ขึ้นต้นด้วย 0 หน้าตาเหมือนเบอร์มือถือ — ให้ชั้นตัวเลขของ allowlist ตัดสินด้วย
    if (matchesOutsideAllowlist(text, THAI_MOBILE, allowed, allowedDigits)) hits.push("เบอร์โทร");
    if (matchesOutsideAllowlist(text, LINE_HANDLE, allowed) || lineIdOutsideAllowlist(text, allowed)) {
      hits.push("LINE id/@handle");
    }
    if (!hits.length) {
      // ตาข่ายชั้นสอง: รูปแบบที่ learningDigest จับได้แต่ regex ข้างบนไม่ครอบ
      // (เลขบัญชี บัตรประชาชน เลขผู้เสียภาษี) — ไม่มีค่าให้เทียบ allowlist จึงฟ้องตรง ๆ
      if (!learningRiskFlags(text).includes("personal_or_financial_data")) continue;
      if (!/(?:เลขประจำตัวผู้เสียภาษี|บัตรประชาชน|เลขบัญชี)/u.test(text)) continue;
      // เลขในการ์ดเป็นของร้านเราเองทุกตัว = ไม่ใช่ข้อมูลบุคคล (เหมือน contacts ของ L15)
      // ไม่มีเลขให้ดูเลย = ยังฟ้องเหมือนเดิม เพราะคำว่า "เลขบัญชี" อาจตามด้วยของลูกค้า
      if (accountNumbersAllOwned(text, allowedDigits)) continue;
      hits.push("เลขบัญชี/บัตรประชาชน");
    }
    out.push({
      code: "L15", severity: BLOCK, cardId: card.itemId, detail: hits.join(" · "),
      message: `การ์ด "${cardLabel(card)}" มีข้อมูลที่อาจระบุตัวบุคคล (${hits.join(" · ")}) — ลบออกก่อนเผยแพร่`,
    });
  }
  return out;
}

// true ก็ต่อเมื่อ "มีเลขยาวอย่างน้อยหนึ่งชุด และทุกชุดอยู่ใน allowlist ของเราเอง"
function accountNumbersAllOwned(text, allowedDigits) {
  if (!allowedDigits?.size) return false;
  const runs = (String(text).match(DIGIT_RUN) ?? [])
    .map((run) => onlyDigits(run))
    .filter((digits) => digits.length >= ACCOUNT_MIN_DIGITS);
  return runs.length > 0 && runs.every((digits) => allowedDigits.has(digits));
}

// "มีคำว่า LINE id" อย่างเดียวไม่ใช่ข้อมูลส่วนบุคคล — ต้องมีไอดีที่ยังไม่ถูกยกเว้นตามมาด้วย
// เดิมแค่คำว่า "ไลน์ไอดี" ปรากฏก็ฟ้องแล้ว ไม่ว่าไอดีที่ตามมาจะเป็นของร้านเราเองหรือไม่
// ผลคือการ์ด "ช่องทางติดต่อ" ของร้านถูกล็อกแก้ไม่ได้ตลอดกาล แม้เจ้าของจะยกเว้นไอดีนั้นไปแล้ว
function lineIdOutsideAllowlist(text, allowed) {
  for (const match of String(text).matchAll(LINE_ID_TOKEN)) {
    if (!allowed.has(String(match[1]).toLowerCase())) return true;
  }
  return false;
}

function matchesOutsideAllowlist(text, pattern, allowed, allowedDigits = null) {
  for (const hit of String(text).match(pattern) ?? []) {
    if (allowed.has(String(hit).toLowerCase())) continue;
    if (allowedDigits?.has(onlyDigits(hit))) continue;
    return true;
  }
  return false;
}

/* ------------------------------------ L16 ----------------------------------- */
// อักขระที่ normalizer จะตัดทิ้ง: การ์ดผ่านตาคน แต่ runtime เห็นคนละสตริง
function lintL16(cards) {
  const out = [];
  for (const card of cards) {
    if (!hasNormalizerCasualties(textOf(card))) continue;
    out.push({
      code: "L16", severity: BLOCK, cardId: card.itemId,
      message: `การ์ด "${cardLabel(card)}" มีอักขระซ่อน (ความกว้างศูนย์ / เ เ แทน แ / รูปประกอบต่างลำดับ) ที่ระบบจะตัดทิ้งตอนใช้งาน — พิมพ์ใหม่ให้สะอาด`,
    });
  }
  return out;
}

/* ---------------------------------- ตัวช่วย ---------------------------------- */

// ชื่อที่คนอ่านออกของการ์ดหนึ่งใบ — `fact:9f3c-...` ไม่มีใครเอาไปทำอะไรต่อได้
// (คีย์ของราคา/รอบเรียนอ่านรู้เรื่องอยู่แล้ว ส่วนความรู้ต้องใช้หัวข้อ)
export function cardLabel(card) {
  const title = String(card?.body?.title ?? "").trim();
  return title || String(card?.key ?? card?.itemId ?? "");
}

// ข้อความทั้งหมดของการ์ดที่คนอ่านได้ (ไม่รวมคีย์/ตัวเลขโครงสร้าง เช่น sha, rowid)
function textOf(card) {
  const parts = [];
  walk(card.body, parts);
  return parts.join("\n");
}

function walk(value, out) {
  if (typeof value === "string") { out.push(value); return; }
  if (Array.isArray(value)) { for (const item of value) walk(item, out); return; }
  if (value && typeof value === "object") { for (const key of Object.keys(value).sort()) walk(value[key], out); }
}
