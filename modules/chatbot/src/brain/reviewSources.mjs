// brain/reviewSources.mjs — ของที่รอ "คนตัดสิน" มารวมอยู่กล่องเดียว (แบบแปลน §6 Step 4)
//
// ทำไมต้องมีไฟล์นี้: วันนี้ของที่รอคนอยู่กระจายอยู่ห้าที่ (คิวคำแก้, ข้อเสนอการเรียนรู้,
// ผลตรวจของรุ่นสมอง, ทะเบียนการลบตาม PDPA, ร่างที่ตัวกรองบล็อก) และสามในห้าไม่มีหน้าไหน
// อ่านมันเลย — ตาราง corrections มีคำแก้ค้างอยู่ 138 แถวบนเครื่องจริงโดยไม่มีใครเห็น
//
// กติกาของไฟล์นี้:
//   1. อ่านอย่างเดียว ไม่เขียนอะไรทั้งสิ้น (การตัดสินเดินผ่านเส้นเดิมของแต่ละแหล่ง)
//   2. ไม่มีตารางใหม่ — ทุกแถวมาจากตารางที่มีอยู่ก่อนแล้ว จึงไม่มี cascade ใหม่ให้ต้องดูแล
//   3. ข้อความของลูกค้าไม่ถูกคัดลอกลงแถวไหนเลย: สิ่งที่แสดงคือ "ร่างของบอท" กับ
//      "คำตอบที่คนของเราพิมพ์" เท่านั้น ส่วนตัวลูกค้าเหลือแค่ปุ่มเปิดห้อง (แบบแปลน §12 PDPA)
import { findPriceViolations, multipliableAmounts, surchargeAmounts } from "../complianceGuard.mjs";
import { learningRiskFlags } from "../learningDigest.mjs";
import { classifyTeachProposal } from "./teach.mjs";
import { isRecognizedSystemCorrectionSource, isTeachableCorrection } from "../correctionCapture.mjs";

const CORRECTION_SCAN_MAX = 200;
const LEARNING_SCAN_MAX = 50;
const SNIPPET_MAX = 240;

export const REVIEW_SOURCE_LABEL = Object.freeze({
  correction: "คำแก้ของทีมที่ยังไม่ได้สอน",
  guard_block: "ร่างที่ระบบกันไว้ รอทีมตรวจ",
  learning: "ข้อเสนอจากระบบเรียนรู้รายวัน",
  redaction: "การ์ดที่ถูกลบตามคำขอลูกค้า",
  lint: "ของหมดอายุในสมองรุ่นที่ใช้อยู่",
});

/**
 * รวมทุกแหล่งเป็นรายการเดียว เรียงตาม "ต้องตัดสินก่อน" (แดงก่อน แล้วใหม่ก่อน)
 *
 * @param {object} db
 * @param {{taughtRefs?: Set<string>, liveFindings?: object[], liveRevIds?: Set<string>, limit?: number}} options
 */
export function collectReviewRows(db, {
  pendingRefs = new Map(), liveFindings = [], liveRevIds = null, limit = 60, cursor = 0,
} = {}) {
  const rank = { red: 0, yellow: 1, green: 2 };
  const byUrgency = (a, b) => (rank[a.risk] ?? 3) - (rank[b.risk] ?? 3) || Number(b.at) - Number(a.at);
  // ของค้างในสมอง (โปรหมดอายุ / การ์ดที่ถูกลบ) มีที่นั่งของตัวเองเสมอ — ถ้าปล่อยให้แข่ง
  // กับคำแก้ 138 ใบตามลำดับเดียวกัน มันจะไม่มีวันโผล่ขึ้นหน้าแรกเลยสักครั้ง
  const compliance = [...redactionRows(db, liveRevIds), ...lintRows(liveFindings)].sort(byUrgency);
  const queue = [...correctionRows(db, pendingRefs), ...learningRows(db)].sort(byUrgency);
  const size = Math.min(200, Math.max(1, Number(limit) || 60));
  const start = Math.max(0, Math.trunc(Number(cursor) || 0));
  // ลำดับทั้งชุดถูกคิดครั้งเดียว แล้วค่อยหั่นเป็นหน้า — ถ้าคิดลำดับใหม่ต่อหน้า
  // ที่นั่งที่กันไว้จะทำให้หน้าถัดไปเหลื่อมกับหน้าแรก แล้วบางแถวหายไปเลย
  const reserved = Math.min(compliance.length, Math.max(0, Math.floor(size / 4)));
  const ordered = [
    ...compliance.slice(0, reserved),
    ...[...compliance.slice(reserved), ...queue].sort(byUrgency),
  ];
  return {
    rows: ordered.slice(start, start + size),
    total: ordered.length,
    // ตัวนับต้องนับจากของทั้งชุด ไม่ใช่จากหน้าที่โหลดมา — ชิปที่เขียนว่า "ของค้าง 1"
    // ทั้งที่มี 12 ใบ คือตัวเลขที่ทำให้คนเชื่อว่าเคลียร์หมดแล้ว
    counts: reviewCounts(ordered),
    hasMore: start + size < ordered.length,
    cursor: start + size,
  };
}

/**
 * นิยามของตัวกรองอยู่ฝั่งเซิร์ฟเวอร์ที่เดียว — หน้าเว็บมีชื่อไทยของมัน แต่ห้ามมีนิยามของตัวเอง
 * (สองที่ = วันหนึ่งตัวนับกับรายการจะไม่ตรงกัน แล้วไม่มีใครรู้ว่าอันไหนถูก)
 */
export const REVIEW_FILTER_MATCH = Object.freeze({
  all: () => true,
  mine: (row) => row.source === "correction",
  red: (row) => row.risk === "red",
  stale: (row) => row.source === "lint" || row.source === "redaction",
});

export function reviewCounts(rows = []) {
  const out = {};
  for (const [id, match] of Object.entries(REVIEW_FILTER_MATCH)) out[id] = rows.filter(match).length;
  return out;
}

/* ------------------------- (ก)(ข) คำแก้ + ร่างที่โดนบล็อก ------------------------- */

// แถวคำแก้แบ่งเป็นสองเรื่องคนละเรื่องกัน และต้องไม่ปนกันบนจอ:
//   มี human_final = "ทีมพิมพ์คำตอบที่ถูกไว้แล้ว" -> สอนได้เลย
//   ไม่มี human_final แต่ร่างมีตัวเลขนอกตาราง = ตัวกรองกันไว้ -> ถามว่า "ราคานี้ถูกต้องไหม"
function correctionRows(db, pendingRefs) {
  const approved = approvedSets(db);
  const out = [];
  for (const row of safe(() => db.listCorrectionWorkQueue(CORRECTION_SCAN_MAX).corrections, [])) {
    const id = String(row.id);
    // สอนไปแล้วจริง (มีรุ่นผูกอยู่บนแถว) = ไม่ต้องอยู่ในกล่องอีก
    if (String(row.taught_version_id || "")) continue;
    // ส่งเข้าคิวรออนุมัติ = ยังต้องเห็น แต่กดสอนซ้ำไม่ได้ (ไม่งั้นส่งซ้ำได้ไม่รู้จบ)
    const pendingNote = pendingRefs.get(id) || "";
    const human = String(row.human_final || "").trim();
    const draft = String(row.ai_draft || "").trim();
    if (human) {
      // แถวเก่าที่ข้อความก่อน/หลังเท่ากันหลังถอด marker และยุบช่องว่าง
      // เป็นร่องรอยการส่ง ไม่ใช่บทเรียน จึงเก็บในฐานข้อมูลต่อ แต่ไม่แสดง
      // ว่าเป็นรายการรอสอน และไม่ทำให้ผู้ใช้เข้าใจว่าเคยสอนไปแล้ว
      if (!isTeachableCorrection(draft, human)) continue;
      const proposal = classifyTeachProposal({ correctText: human });
      // แสดง "ช่วงที่ต่าง" ไม่ใช่ 240 ตัวแรกของทั้งสองก้อน — เหตุผลอยู่ที่ focusedPair
      const focused = focusedPair(draft, human);
      out.push({
        id: `correction:${id}`, source: "correction", refId: id,
        kind: proposal.kind, risk: proposal.risk,
        title: "ทีมงานแก้คำตอบของลูกแพร แต่ยังไม่ได้สอนให้จำ",
        detail: focused.after,
        before: focused.before,
        beforeMark: focused.beforeMark,
        afterMark: focused.afterMark,
        at: Number(row.created_at) || 0,
        customerId: String(row.customer_id || ""),
        ownerOnly: proposal.risk === "red",
        pendingNote,
        actions: {
          teach: !pendingNote && proposal.writable && !proposal.blocked,
          dismiss: !pendingNote, openChat: true,
        },
        blockedWhy: proposal.blocked ? proposal.blockReason : (proposal.writable ? "" : proposal.notWritableWhy),
      });
      continue;
    }
    if (!draft) continue;
    const violations = findPriceViolations(draft, approved.amounts, approved.multipliable, approved.surcharges);
    if (violations.length) {
      // Keep legacy price rows byte-for-byte meaningful: their approved-table
      // comparison is still the evidence for listing amounts here.
      const numbers = [...new Set(violations.map((violation) => String(violation.detail)))];
      out.push({
        id: `correction:${id}`, source: "guard_block", refId: id,
        kind: "price", risk: "red",
        title: `ลูกแพรจะพูดตัวเลข ${numbers.slice(0, 3).join(" · ")} ที่ไม่อยู่ในตารางราคา — ตัวกรองกันไว้`,
        detail: snippet(draft),
        before: "",
        amounts: numbers.slice(0, 5),
        at: Number(row.created_at) || 0,
        customerId: String(row.customer_id || ""),
        ownerOnly: true,
        pendingNote,
        actions: { teach: !pendingNote, dismiss: !pendingNote, openChat: true },
        blockedWhy: "",
      });
      continue;
    }
    // Non-price system drafts only surface when their stored closed provenance
    // proves they were captured by a known guard. No violation detail is
    // copied into the review row; the operator must save a material human edit
    // before the existing Teach gate can write anything.
    if (!isRecognizedSystemCorrectionSource(row.source_reason)) continue;
    out.push({
      id: `correction:${id}`, source: "guard_block", refId: id,
      kind: "fact", risk: "yellow",
      title: "ร่างของลูกแพรที่ระบบกันไว้ — รอทีมพิมพ์คำตอบที่ถูกต้อง",
      detail: snippet(draft),
      before: "",
      at: Number(row.created_at) || 0,
      customerId: String(row.customer_id || ""),
      ownerOnly: false,
      pendingNote,
      actions: { teach: !pendingNote, dismiss: !pendingNote, openChat: true },
      blockedWhy: "บันทึกคำแก้ของคนก่อน จึงจะสอนลูกแพรได้",
    });
  }
  return out;
}

function approvedSets(db) {
  const rows = safe(() => db.approvedPrices(), []);
  return {
    amounts: new Set(rows.map((row) => Number(row.amount)).filter(Number.isFinite)),
    multipliable: multipliableAmounts(rows),
    surcharges: surchargeAmounts(rows),
  };
}

/* ------------------------------ (ค) ข้อเสนอการเรียนรู้ ----------------------------- */

function learningRows(db) {
  const out = [];
  for (const row of safe(() => db.listLearningCandidates({ status: "proposed", limit: LEARNING_SCAN_MAX }), [])) {
    const flags = safeArray(row.risk_flags_json);
    const risk = flags.length ? "red" : "green";
    out.push({
      id: `learning:${row.id}`, source: "learning", refId: String(row.id),
      kind: "fact", risk,
      title: `ระบบเสนอความรู้ใหม่: ${String(row.title || "").slice(0, 80)}`,
      detail: snippet(String(row.proposed_content || "")),
      before: "",
      at: Number(row.created_at) || 0,
      customerId: "",
      ownerOnly: true,
      // ข้อเสนอมีเส้นตัดสินของตัวเองอยู่แล้ว (หน้าเรียนรู้) — กล่องนี้พาไปที่นั่น ไม่ทำซ้ำ
      actions: { teach: false, dismiss: false, openChat: false },
      goTo: "#/corrections",
      blockedWhy: flags.length
        ? `ข้อเสนอนี้มีเรื่องที่ต้องให้คนตรวจเอง (${flags.join(", ")}) — เปิดหน้าเรียนรู้เพื่อตัดสิน`
        : "",
    });
  }
  return out;
}

/* --------------------------- (ง) การ์ดที่ถูกลบตาม PDPA --------------------------- */

// การ์ดที่ถูกลบเนื้อแล้วยังอยู่ใน manifest ของรุ่นที่ใช้อยู่ = รุ่นนั้นคอมไพล์ไม่ได้อีกแล้ว
// ต้องออกรุ่นใหม่ที่ไม่มีการ์ดใบนั้น (แบบแปลน §5 PDPA ข้อ 2) — ถ้าไม่ขึ้นกล่องนี้
// จะไม่มีใครรู้จนกว่าจะมีคนกดบันทึกอะไรสักอย่างแล้วเจอ "ประกอบสมองไม่ได้"
function redactionRows(db, liveRevIds) {
  if (!liveRevIds || liveRevIds.size === 0) return [];
  const out = [];
  for (const row of safe(() => db.listBrainRedactions(50), [])) {
    if (!liveRevIds.has(String(row.rev_id))) continue;
    out.push({
      id: `redaction:${row.rev_id}`, source: "redaction", refId: String(row.item_id || ""),
      kind: String(row.kind || "fact"), risk: "red",
      title: `การ์ด "${row.key || row.item_id}" ถูกลบตามคำขอลูกค้า — ต้องเผยแพร่รุ่นใหม่ที่ไม่มีใบนี้`,
      detail: String(row.reason || "ลบตามคำขอเจ้าของข้อมูล"),
      before: "",
      at: Number(row.redacted_at) || 0,
      customerId: "",
      ownerOnly: true,
      // ไม่มีปุ่มไหนในคอนโซลที่ทำเรื่องนี้ได้จริง (การนำเข้าใหม่เป็นคำสั่งฝั่งเครื่อง) —
      // ชี้ไปหน้าตั้งค่าคือการส่งคนไปหาปุ่มที่ไม่มีอยู่ ต้องบอกตรง ๆ แล้วให้แจ้งช่างแทน
      actions: { teach: false, dismiss: false, openChat: false, report: true },
      blockedWhy: "เรื่องนี้ต้องให้ช่างนำเข้าสมองใหม่ให้ ไม่มีปุ่มในคอนโซลที่ทำแทนได้ —"
        + " กดแจ้งช่างแล้วรอได้เลยค่ะ ระหว่างนี้ลูกแพรยังตอบตามปกติ",
    });
  }
  return out;
}

/* ------------------------- (จ) โปรหมดอายุ / รอบที่ผ่านไปแล้ว ------------------------- */

// ผลตรวจ L03 ของรุ่นที่ใช้อยู่ — ตัวตรวจหาเจอมาตั้งแต่เฟส 1b แล้ว แต่ไม่มีใครเห็น
// เพราะมันซ่อนอยู่ใต้ details ในหน้าตั้งค่า
export function lintRows(findings = []) {
  return (Array.isArray(findings) ? findings : [])
    .filter((finding) => String(finding?.code) === "L03")
    .map((finding) => ({
      id: `lint:${finding.code}:${finding.cardId || finding.message}`.slice(0, 120),
      source: "lint", refId: String(finding.cardId || ""),
      kind: "schedule",
      risk: finding.severity === "block" ? "red" : "yellow",
      title: String(finding.message || ""),
      detail: finding.severity === "block"
        ? "ของชิ้นนี้บล็อกการเผยแพร่ครั้งถัดไปที่ไปแตะมัน"
        : "ยังเผยแพร่ได้ แต่ควรเก็บก่อนกลายเป็นของค้าง",
      before: "",
      at: 0,
      customerId: "",
      ownerOnly: true,
      actions: { teach: false, dismiss: false, openChat: false },
      goTo: "#/rounds",
      blockedWhy: "",
    }));
}

/* ------------------------------ "สอนไปแล้วหรือยัง" ------------------------------ */

/**
 * คำแก้ที่ "ส่งเข้าคิวรออนุมัติอยู่" -> ข้อความสถานะที่จะขึ้นบนแถว
 *
 * ต่างจาก "สอนแล้ว" (ซึ่งบันทึกบนแถวคำแก้ตรง ๆ): ใบที่ทีมงานส่งยังไม่มีรุ่นเป็นของตัวเอง
 * จนกว่าเจ้าของจะกดอนุมัติ ถ้าไม่นับว่าส่งแล้ว ชมพู่จะกดส่งซ้ำได้เรื่อย ๆ แล้วคิวจะเต็มไป
 * ด้วยคำขอใบเดียวกันที่ไม่มีใครรู้ว่าซ้ำ
 */
export function pendingTeachRefs(db, limit = 100) {
  const refs = new Map();
  for (const row of safe(() => db.listPublishRequests({ status: "pending", limit }), [])) {
    const teach = safeJson(row.body_json)?.teach;
    const ref = String(teach?.correction_ref || teach?.correctionRef || "");
    if (ref) refs.set(ref, "ส่งให้พี่ง้วงแล้ว รออนุมัติ");
  }
  return refs;
}

export function liveManifestRevIds(db) {
  const live = safe(() => db.getBrainPointer("live"), null);
  if (!live) return null;
  const manifest = safeJson(live.manifest_json);
  return new Set((manifest?.revIds ?? []).map(String));
}

/* ---------------------------------- ตัวช่วย ---------------------------------- */

// ตัดข้อความให้พอตัดสินใจได้ แต่ไม่ยกทั้งบทสนทนามาวางบนหน้าจอรวม
export function snippet(text, max = SNIPPET_MAX) {
  return cut(collapse(text), max);
}

/**
 * คู่ "ร่างของบอท / คำตอบที่คนพิมพ์" ที่เลื่อนหน้าต่างไปหยุดตรงจุดที่ต่างกันจริง
 *
 * ทำไมต้องมี (วัดจากตารางจริง 3 ก.ย. 2026): คำแก้ที่ค้างอยู่ 151 ใบซึ่งมีคำตอบของคนพิมพ์
 * มี 78 ใบ (52%) ที่ตัวอักษรตัวแรกซึ่งต่างกันอยู่หลังตำแหน่งที่ 240 — กลางค่าอยู่ที่ 274
 * การตัดหัว 240 ตัวจึงคืนข้อความที่ "เหมือนกันเป๊ะ" สองก้อนขึ้นจอ แล้วคนตรวจสรุปว่าจอมั่ว
 * ทั้งที่ข้อมูลถูกทุกตัว — ของที่พังคือวิธีแสดง ไม่ใช่ข้อมูล
 *
 * @param {string} aiDraft ร่างที่ลูกแพรจะตอบ
 * @param {string} humanFinal คำตอบที่ทีมงานพิมพ์แทน
 * @param {number} [max] งบตัวอักษรของเนื้อความแต่ละก้อน (ไม่นับ "…" ที่เติมบอกว่ายังมีต่อ
 *   — กติกาเดียวกับ snippet() ที่คืน 241 ตัวเมื่องบคือ 240)
 * @returns {{before: string, after: string, beforeMark: number[]|null, afterMark: number[]|null}}
 *   beforeMark/afterMark คือช่วงที่ต่าง โดยนับตำแหน่ง "บนสตริงที่คืนออกไปแล้ว" (รวม "…"
 *   ที่เติมข้างหน้าด้วย) ผู้เรียกจึง slice ตรง ๆ ได้เลย ไม่ต้องบวกออฟเซ็ตเอง
 */
export function focusedPair(aiDraft, humanFinal, max = SNIPPET_MAX) {
  const budget = Math.max(1, Math.trunc(Number(max)) || SNIPPET_MAX);
  const draft = collapse(aiDraft);
  const final = collapse(humanFinal);
  // ไม่มีของให้เทียบ หรือเหมือนกันทุกตัวอักษร -> ตัดหัวแบบเดิม ไม่มีอะไรให้ทำเครื่องหมาย
  if (!draft || !final || draft === final) {
    return { before: cut(draft, budget), after: cut(final, budget), beforeMark: null, afterMark: null };
  }
  const { prefix, suffix } = commonEdges(draft, final);
  const before = focusWindow(draft, prefix, draft.length - suffix, budget);
  const after = focusWindow(final, prefix, final.length - suffix, budget);
  return { before: before.text, after: after.text, beforeMark: before.mark, afterMark: after.mark };
}

// บริบทที่เหมือนกันข้างละเท่านี้ พอให้รู้ว่าช่วงที่ต่างอยู่ตรงไหนของประโยค
// โดยไม่กินงบจนตัวที่ต่างเองถูกเบียดหายไป
const FOCUS_CONTEXT = 60;
const COMBINING = /\p{M}/u;

// `|| ""` ไม่ใช่ `?? ""` โดยตั้งใจ — snippet() เดิมกลืน 0/false เป็นสตริงว่าง
// ผู้เรียกที่มีอยู่พึ่งพฤติกรรมนั้นอยู่ การเปลี่ยนตรงนี้จะทำให้ค่าที่ไม่ใช่ข้อความโผล่ขึ้นจอ
function collapse(text) {
  return String(text || "").replace(/\s+/gu, " ").trim();
}

function cut(value, max) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const clamp = (value, low, high) => Math.min(Math.max(value, low), high);
const isCombining = (ch) => typeof ch === "string" && COMBINING.test(ch);
const inCharRange = (ch, low, high) => {
  const code = typeof ch === "string" ? ch.charCodeAt(0) : Number.NaN;
  return code >= low && code <= high;
};

// หัวและท้ายที่เหมือนกันของสองข้อความ — ที่เหลือตรงกลางคือ "สิ่งที่คนแก้"
function commonEdges(a, b) {
  const shortest = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < shortest && a[prefix] === b[prefix]) prefix += 1;
  // ไล่ท้ายแบบไม่กั้น มันจะเดินย้อนทับหัวที่นับไปแล้วเมื่อข้อความซ้ำ ๆ (เช่น "ค่ะ ค่ะ ค่ะ")
  // แล้วช่วงที่ต่างจะกลายเป็นช่วงติดลบ — กั้นไว้ที่ shortest - prefix เสมอ
  let suffix = 0;
  while (suffix < shortest - prefix && a.at(-1 - suffix) === b.at(-1 - suffix)) suffix += 1;
  // อีโมจิหนึ่งตัวคือสองหน่วยรหัส และสระ/วรรณยุกต์ไทยเป็นตัวลอยที่ต้องเกาะพยัญชนะข้างหน้า
  // ถ้าเส้นแบ่งตกกลางคู่พวกนี้ ไฮไลต์จะได้ครึ่งตัวหรือได้สระเปล่าที่ไม่มีตัวเกาะ —
  // ถอยเส้นแบ่งออกให้ครบตัวเสมอ (ถอยได้อย่างเดียว ช่วงที่ต่างจึงกว้างขึ้นเท่านั้น ไม่หด)
  while (prefix > 0
    && (inCharRange(a[prefix - 1], 0xD800, 0xDBFF) || isCombining(a[prefix]) || isCombining(b[prefix]))) {
    prefix -= 1;
  }
  while (suffix > 0
    && (inCharRange(a.at(-suffix), 0xDC00, 0xDFFF) || isCombining(a.at(-suffix)) || isCombining(b.at(-suffix)))) {
    suffix -= 1;
  }
  return { prefix, suffix };
}

// หน้าต่างที่เลื่อนไปหยุดตรงช่วงที่ต่าง โดยมีบริบทที่เหมือนกันขนาบสองข้าง
function focusWindow(text, changeStart, changeEnd, max) {
  const start = clamp(changeStart, 0, text.length);
  const end = clamp(changeEnd, start, text.length);
  // สั้นพอที่จะแสดงทั้งก้อนอยู่แล้ว = ไม่ต้องเลื่อนหน้าต่าง หน้าตาจึงเหมือนของเดิมเป๊ะ
  if (text.length <= max) return windowText(text, "", "", start, end);
  let from = Math.max(0, start - FOCUS_CONTEXT);
  // ใช้งบให้เต็มเสมอ — ที่ว่างที่เหลือไว้เฉย ๆ คือบริบทที่คนตรวจไม่ได้เห็นฟรี ๆ
  let to = Math.min(text.length, Math.max(end + FOCUS_CONTEXT, from + max));
  // ช่วงที่ต่างยาวกว่างบทั้งก้อน: เก็บ "จุดที่เริ่มต่าง" ไว้ให้เห็น แล้วตัดหางทิ้ง
  if (to - from > max) to = from + max;
  // ชนท้ายข้อความแล้วยังเหลืองบ -> ถอยหน้าต่างกลับไปทางหัวแทนที่จะปล่อยที่ว่างทิ้ง
  if (to - from < max) from = Math.max(0, to - max);
  return windowText(text.slice(from, to), from > 0 ? "…" : "", to < text.length ? "…" : "",
    start - from, end - from);
}

function windowText(body, head, tail, start, end) {
  const markStart = clamp(start, 0, body.length);
  const markEnd = clamp(end, markStart, body.length);
  return {
    text: `${head}${body}${tail}`,
    // "…" ที่เติมข้างหน้าดันตำแหน่งไปหนึ่งตัว ถ้าไม่บวกคืน ไฮไลต์จะเลื่อนไปหนึ่งตัวอักษร
    // ทุกแถวที่หน้าต่างไม่ได้เริ่มที่ตัวแรก
    mark: markEnd > markStart ? [markStart + head.length, markEnd + head.length] : null,
  };
}

export function riskOfText(text) {
  const flags = learningRiskFlags(String(text || ""));
  if (flags.includes("money") || flags.includes("promotion_or_terms")) return "red";
  return flags.length ? "yellow" : "green";
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function safeJson(text) {
  try { return JSON.parse(String(text || "null")); } catch { return null; }
}

function safeArray(text) {
  const parsed = safeJson(text);
  return Array.isArray(parsed) ? parsed : [];
}
