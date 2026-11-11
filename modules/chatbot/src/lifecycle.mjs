// lifecycle.mjs — v1.4 เฟส 1 (shadow): จับ facts + เลื่อน deal_status จากสัญญาณสะอาด
// ตาม ARCHITECTURE_LIFECYCLE_PROFILES.md — เฟสนี้ "เขียนอย่างเดียว ไม่มีใครอ่าน"
// พฤติกรรมที่ลูกค้าเห็นต้องเหมือนเดิม 100% (มีเทสต์ byte-identical คุม)
//
// หลักออกแบบ:
// - สวิตช์เดียว lifecycle_mode (off default / shadow / profiles / full) อ่านจาก DB ทุกครั้ง
//   — แก้จากคอนโซลได้ไม่ต้อง deploy (แบบแผน followup_enabled) อ่านพัง = off (fail-closed)
// - ทุกทางเข้า try/catch โดยผู้เรียกใน pipeline — โมดูลนี้พังห้ามกระทบแชทเด็ดขาด
// - ระบบเลื่อนได้เฉพาะ deal_status "เดินหน้า" ใต้ sales — ข้ามแกน stage เป็นสิทธิ์คน
//   (บังคับซ้ำในชั้น DB ที่ dbLifecycle.applyLifecycleTransition)
import { activeBrand, isGenericProfile } from "./brand.mjs";
import { detectAiLevel, detectHeadcount, detectRoundInterest } from "./salesMotion.mjs";
import { SALES_DEAL_FLOW } from "./dbLifecycle.mjs";

export const LIFECYCLE_MODE_KEY = "lifecycle_mode";
export const LIFECYCLE_MODES = Object.freeze(["off", "shadow", "profiles", "full"]);

// ราคาที่ "ส่งให้ลูกค้า" ต้องเป็นราคาคอร์ส/บริการ — แถวต่ำกว่านี้ในตารางอนุมัติคือ
// ตัวปรับ (ส่วนลด 1,000/3,000 ค่าบริการ 5,000) การเจอเลขพวกนี้ไม่ใช่การแจ้งราคา
const MIN_COURSE_PRICE_THB = 4900;

export function lifecycleMode(db) {
  try {
    const raw = String(db.getSetting(LIFECYCLE_MODE_KEY) ?? "").trim();
    return LIFECYCLE_MODES.includes(raw) ? raw : "off";
  } catch {
    return "off"; // อ่านพัง = ปิด — ห้ามให้ setting เสียลากไปป์ไลน์ล้ม
  }
}

const flowIndex = (status) => SALES_DEAL_FLOW.indexOf(status);

export function createLifecycle({ db, salesPolicy = null, logger = console }) {
  // เดินหน้าเท่านั้น และเฉพาะใต้แกน sales — สถานะพัก (not_ready/waiting_next_round)
  // เป็นของคน ระบบไม่แตะ ทำให้ replay เหตุการณ์เดิมซ้ำเป็น no-op โดยธรรมชาติ
  function advanceDealStatus(customerId, toStatus, trigger, evidence) {
    const current = db.getLifecycle(customerId);
    if (!current || current.stage !== "sales") return false;
    const from = flowIndex(current.dealStatus);
    const to = flowIndex(toStatus);
    if (from === -1 || to === -1 || to <= from) return false;
    db.applyLifecycleTransition({ customerId, toStatus, trigger, actor: "system", evidence });
    return true;
  }

  function captureFact(customerId, factKey, value, evidence) {
    const result = db.setCustomerFact({
      customerId, factKey, value: String(value), source: "deterministic", evidence,
    });
    return result.written;
  }

  // ขาเข้า: หลัง name-extract ก่อน control gate — จับได้แม้ AI ปิด (คนคุยอยู่ facts ยังเดิน)
  function applyInbound({ customerId, text }) {
    if (lifecycleMode(db) === "off") return { applied: false };
    const value = String(text || "");
    const evidence = value.slice(0, 300);
    let captured = 0;

    const history = db.recentTurns?.(customerId, 6) ?? [];
    // Remove only this inbound if already stored; an older user answer closes the question.
    if (history.at(-1)?.role === "user" && String(history.at(-1).content || "") === value) history.pop();
    const level = detectAiLevel(value, { history });
    if (level !== null && captureFact(customerId, "ai_level", level, evidence)) captured += 1;

    const headcount = detectHeadcount(value);
    if (headcount !== null && captureFact(customerId, "headcount", headcount, evidence)) captured += 1;

    const round = detectRoundInterest(value);
    if (round) {
      const label = round.month ? `วันที่ ${round.day} เดือน ${round.month}` : `วันที่ ${round.day}`;
      if (captureFact(customerId, "chosen_round", label, evidence)) captured += 1;
      // เลือกรอบแล้ว = รอชำระ — เฉพาะเมื่อผ่านการเห็นราคามาแล้วเท่านั้น
      // (เลือกใต้สถานะก่อนราคา = แค่ความสนใจ ยังเดินสายคุยปกติ)
      const current = db.getLifecycle(customerId);
      if (current && ["price_sent", "awaiting_round_choice"].includes(current.dealStatus)) {
        advanceDealStatus(customerId, "awaiting_payment", "round_chosen", evidence);
      }
    }

    // ลูกค้าเริ่มให้ข้อมูลจริง = พ้นสถานะ new
    if (captured > 0) advanceDealStatus(customerId, "collecting_info", "inbound_fact", evidence);
    return { applied: true, captured };
  }

  // ขาออก: เฉพาะข้อความที่ "ส่งสำเร็จแล้ว" (ผ่าน price guard มาแล้ว = สัญญาณสะอาดสุด)
  function applyOutbound({ customerId, text }) {
    if (lifecycleMode(db) === "off") return { applied: false };
    const value = String(text || "");
    const evidence = value.slice(0, 300);

    // price_sent: เลขในข้อความต้องตรงราคาอนุมัติของคอร์ส/บริการเป๊ะ — เลขอื่นไม่นับ
    let priceSent = false;
    try {
      const amounts = new Set(
        (db.approvedPrices?.() ?? [])
          .map((row) => Number(row.amount))
          // White-label: เกณฑ์ "ราคาคอร์สขั้นต่ำ" เป็นของธุรกิจคอร์สเท่านั้น — generic นับทุกราคาที่อนุมัติ
          .filter((amount) => Number.isFinite(amount) && amount >= (isGenericProfile(activeBrand()) ? 1 : MIN_COURSE_PRICE_THB)),
      );
      for (const match of value.matchAll(/\d{1,3}(?:,\d{3})+|\d{4,7}/gu)) {
        if (amounts.has(Number(match[0].replaceAll(",", "")))) { priceSent = true; break; }
      }
    } catch (err) {
      logger.debug?.(`lifecycle: อ่านราคาอนุมัติไม่สำเร็จ (${err?.message || err})`);
    }

    // class_recommended: เอ่ยชื่อคลาสจริง (ชื่อ/alias จาก sales policy ที่ธุรกิจอนุมัติ)
    let classRecommended = false;
    const lower = value.toLocaleLowerCase("th-TH");
    for (const course of salesPolicy?.courses ?? []) {
      const names = [course.name, ...(course.aliases ?? [])];
      if (names.some((name) => name && lower.includes(String(name).toLocaleLowerCase("th-TH")))) {
        classRecommended = true;
        break;
      }
    }

    // ราคาชนะชื่อคลาส (ข้อความเดียวมีทั้งคู่บ่อย — price_sent อยู่ไกลกว่าใน flow)
    if (priceSent) advanceDealStatus(customerId, "price_sent", "price_sent", evidence);
    else if (classRecommended) advanceDealStatus(customerId, "class_recommended", "class_recommended", evidence);
    return { applied: true, priceSent, classRecommended };
  }

  return { applyInbound, applyOutbound };
}
