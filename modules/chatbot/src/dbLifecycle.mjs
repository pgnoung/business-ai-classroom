// dbLifecycle.mjs — v1.4 Lifecycle เฟส 1 (shadow) ตาม ARCHITECTURE_LIFECYCLE_PROFILES.md
//
// ความจำแบบมีโครงสร้างที่รอด /reset: facts มีที่มา (precedence human > deterministic
// > scorer), สถานะสองแกนบน customers, event log แบบ append-only, ประวัติเรียนที่คนยืนยัน
//
// กติกาเหล็กที่บังคับในชั้น DB (ไม่ใช่แค่ policy ของผู้เรียก):
// - ข้ามแกน lifecycle_stage = คนกดเท่านั้น (actor 'human') — ระบบเลื่อนได้เฉพาะ
//   deal_status ใต้ stage เดิม
// - enum ปิดทุกช่อง เขียนค่านอกรายการ = โยนทันที ไม่เขียนเงียบ
import { randomUUID } from "node:crypto";

export const LIFECYCLE_STAGES = Object.freeze(["sales", "enrolled", "alumni", "closed_lost"]);

// deal_status ใต้ sales เรียงตามคู่มือชมพู่ 4.4 ขั้น 1-9 (ลำดับ = ทิศทางเดินหน้า)
// not_ready / waiting_next_round เป็นสถานะพัก (คน/เฟสหลังตั้ง — ไม่อยู่ในเส้นเดินหน้า)
export const SALES_DEAL_FLOW = Object.freeze([
  "new", "collecting_info", "class_recommended", "details_sent", "price_sent",
  "awaiting_round_choice", "awaiting_team_decision", "quote_sent", "awaiting_payment",
]);
export const DEAL_STATUSES = Object.freeze([
  ...SALES_DEAL_FLOW, "not_ready", "waiting_next_round",
  // ใต้ enrolled (คนย้ายแกนเองในเฟส 2 — คอลัมน์รองรับไว้ตั้งแต่ schema แรก)
  "paid_confirmed", "prep_sent",
]);

// คีย์ facts ปิดตามแบบบันทึกคู่มือ 5.1 — เพิ่มคีย์ = แก้ที่นี่ที่เดียว
export const FACT_KEYS = Object.freeze([
  "ai_level", "headcount", "business_context", "goal_pain", "decision_role",
  "company_name", "contact_phone", "contact_email", "tax_info",
  "recommended_product", "quoted_price_label", "chosen_round",
  "purchased_course_id", "concern", "budget_timeframe",
]);
export const FACT_SOURCES = Object.freeze(["human", "deterministic", "scorer"]);

// ใครทับใครได้: คนชนะทุกชั้นและระบบห้ามทับ; deterministic ทับได้เฉพาะของ scorer;
// scorer เติมได้เฉพาะคีย์ว่าง (แบบแผนเดียวกับ known_name)
const SOURCE_RANK = Object.freeze({ human: 3, deterministic: 2, scorer: 1 });

export function createLifecycleDbMethods({ db, run, all, get, now }) {
  return {
    /* ---------------------------- customer facts ---------------------------- */

    getCustomerFacts(customerId) {
      return all(
        "SELECT fact_key, value, source, evidence, updated_at FROM customer_facts WHERE customer_id = ? ORDER BY fact_key",
        String(customerId),
      );
    },

    getCustomerFact(customerId, factKey) {
      return get(
        "SELECT fact_key, value, source, evidence, updated_at FROM customer_facts WHERE customer_id = ? AND fact_key = ?",
        String(customerId), String(factKey),
      ) ?? null;
    },

    // คืน {written, reason} เสมอ — ผู้เรียกใน pipeline เป็น fire-and-forget
    // จึงต้องรู้ได้จากค่า return ว่าค่าใหม่ถูกปฏิเสธเพราะ precedence (ไม่ใช่บั๊กเงียบ)
    setCustomerFact({ customerId, factKey, value, source, evidence = "" }) {
      if (!FACT_KEYS.includes(factKey)) throw new Error(`fact_key นอกรายการ: ${factKey}`);
      if (!FACT_SOURCES.includes(source)) throw new Error(`source นอกรายการ: ${source}`);
      const clean = String(value ?? "").trim();
      if (!clean) return { written: false, reason: "empty_value" };
      const existing = this.getCustomerFact(customerId, factKey);
      if (existing) {
        // ชั้นเดียวกันก็ไม่ทับ — "เขียนครั้งแรกที่พบ" กัน detector แกว่งค่าไปมาใน
        // บทสนทนาเดียว (ลูกค้าเปลี่ยนใจจริงให้คนแก้จากคอนโซล ซึ่ง rank ชนะอยู่แล้ว)
        if (SOURCE_RANK[source] <= SOURCE_RANK[existing.source]) {
          return { written: false, reason: `kept_${existing.source}` };
        }
      }
      run(
        `INSERT INTO customer_facts (customer_id, fact_key, value, source, evidence, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(customer_id, fact_key) DO UPDATE SET
           value = excluded.value, source = excluded.source,
           evidence = excluded.evidence, updated_at = excluded.updated_at`,
        String(customerId), factKey, clean.slice(0, 500), source,
        String(evidence || "").slice(0, 500), now(),
      );
      return { written: true, reason: existing ? `override_${existing.source}` : "first_write" };
    },

    clearCustomerFacts(customerId) {
      return run("DELETE FROM customer_facts WHERE customer_id = ?", String(customerId)).changes;
    },

    /* --------------------------- lifecycle state ---------------------------- */

    getLifecycle(customerId) {
      const row = get(
        "SELECT lifecycle_stage, deal_status FROM customers WHERE line_user_id = ?",
        String(customerId),
      );
      if (!row) return null;
      return { stage: row.lifecycle_stage || "sales", dealStatus: row.deal_status || "new" };
    },

    // การเลื่อนสถานะทุกครั้งเขียนคอลัมน์ + event log ให้จบในที่เดียว
    // ข้ามแกน stage โดย actor ไม่ใช่ 'human' = โยน — invariant อยู่ในโครงสร้าง ไม่ใช่วินัยผู้เรียก
    applyLifecycleTransition({ customerId, toStage = null, toStatus = null, trigger = "", actor = "system", evidence = "", markMoneySeen = false }) {
      const current = this.getLifecycle(customerId);
      if (!current) throw new Error(`ไม่พบลูกค้า: ${customerId}`);
      const nextStage = toStage ?? current.stage;
      const nextStatus = toStatus ?? current.dealStatus;
      if (!LIFECYCLE_STAGES.includes(nextStage)) throw new Error(`lifecycle_stage นอกรายการ: ${nextStage}`);
      if (!DEAL_STATUSES.includes(nextStatus)) throw new Error(`deal_status นอกรายการ: ${nextStatus}`);
      if (nextStage !== current.stage && actor !== "human") {
        throw new Error(`ข้ามแกน lifecycle_stage (${current.stage} -> ${nextStage}) ต้องเป็นคนกดเท่านั้น`);
      }
      if (nextStage === current.stage && nextStatus === current.dealStatus) {
        return { changed: false, ...current };
      }
      const updatedAt = now();
      db.exec("SAVEPOINT lifecycle_transition");
      try {
        run(
          `UPDATE customers
           SET lifecycle_stage = ?, deal_status = ?,
               money_seen_at = CASE WHEN ? = 1 AND money_seen_at = 0 THEN ? ELSE money_seen_at END,
               updated_at = ?
           WHERE line_user_id = ?`,
          nextStage, nextStatus, markMoneySeen ? 1 : 0, updatedAt, updatedAt, String(customerId),
        );
        run(
          `INSERT INTO lifecycle_events (id, customer_id, from_stage, to_stage, from_status, to_status, trigger, actor, evidence, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(), String(customerId), current.stage, nextStage, current.dealStatus, nextStatus,
          String(trigger).slice(0, 80), String(actor).slice(0, 40), String(evidence || "").slice(0, 300), updatedAt,
        );
        db.exec("RELEASE SAVEPOINT lifecycle_transition");
      } catch (error) {
        try {
          db.exec("ROLLBACK TO SAVEPOINT lifecycle_transition");
          db.exec("RELEASE SAVEPOINT lifecycle_transition");
        } catch { /* preserve original transition error */ }
        throw error;
      }
      return { changed: true, stage: nextStage, dealStatus: nextStatus };
    },

    // Financial confirmation has a stricter invariant than a general lifecycle
    // transition: exactly one human request may win awaiting_payment -> paid.
    // Keep the compare-and-swap, lifecycle event, and admin audit in the same
    // IMMEDIATE transaction so concurrent Console tabs cannot duplicate proof.
    confirmCustomerPayment({ customerId, confirmedBy }) {
      const id = String(customerId);
      const operator = String(confirmedBy || "").trim();
      if (!operator) throw new Error("payment confirmation requires an operator");
      db.exec("BEGIN IMMEDIATE");
      try {
        const current = get(
          "SELECT lifecycle_stage, deal_status FROM customers WHERE line_user_id = ?",
          id,
        );
        if (!current) {
          db.exec("ROLLBACK");
          return { found: false, allowed: false, changed: false };
        }
        const stage = current.lifecycle_stage || "sales";
        const dealStatus = current.deal_status || "new";
        if (stage === "enrolled" && dealStatus === "paid_confirmed") {
          db.exec("ROLLBACK");
          return { found: true, allowed: true, changed: false, stage, dealStatus };
        }
        if (stage !== "sales" || dealStatus !== "awaiting_payment") {
          db.exec("ROLLBACK");
          return { found: true, allowed: false, changed: false, stage, dealStatus };
        }

        const updatedAt = now();
        const changed = run(
          `UPDATE customers
           SET lifecycle_stage = 'enrolled', deal_status = 'paid_confirmed',
               money_seen_at = CASE WHEN money_seen_at = 0 THEN ? ELSE money_seen_at END,
               updated_at = ?
           WHERE line_user_id = ?
             AND COALESCE(lifecycle_stage, 'sales') = 'sales'
             AND COALESCE(deal_status, 'new') = 'awaiting_payment'`,
          updatedAt, updatedAt, id,
        ).changes;
        if (changed !== 1) throw new Error("payment confirmation compare-and-swap failed");
        run(
          `INSERT INTO lifecycle_events (id, customer_id, from_stage, to_stage, from_status, to_status, trigger, actor, evidence, created_at)
           VALUES (?, ?, 'sales', 'enrolled', 'awaiting_payment', 'paid_confirmed', 'payment_confirmed', 'human', ?, ?)`,
          randomUUID(), id, `confirmed_by:${operator}`.slice(0, 300), updatedAt,
        );
        run(
          "INSERT INTO admin_audit (id, operator, action, target, detail, created_at) VALUES (?, ?, 'payment_confirmed', ?, ?, ?)",
          randomUUID(), operator, id, "lifecycle awaiting_payment -> paid_confirmed", updatedAt,
        );
        db.exec("COMMIT");
        return {
          found: true, allowed: true, changed: true,
          stage: "enrolled", dealStatus: "paid_confirmed",
        };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* preserve the original failure */ }
        throw error;
      }
    },

    listLifecycleEvents(customerId, limit = 50) {
      return all(
        "SELECT * FROM lifecycle_events WHERE customer_id = ? ORDER BY created_at DESC, id LIMIT ?",
        String(customerId), Math.max(1, Math.min(500, Number(limit) || 50)),
      );
    },

    /* ------------------------------ enrollments ----------------------------- */

    // เขียนโดยปุ่มคนกดในคอนโซล (เฟส 2) เท่านั้น — เมธอดตรวจ enum ให้ครบตั้งแต่เฟส 1
    addEnrollment({ customerId, courseId, roundDate = "", status = "enrolled", confirmedBy = "" }) {
      if (!["enrolled", "completed", "cancelled"].includes(status)) {
        throw new Error(`enrollment status นอกรายการ: ${status}`);
      }
      if (!String(courseId || "").trim()) throw new Error("enrollment ต้องมี course_id");
      const id = randomUUID();
      run(
        `INSERT INTO enrollments (id, customer_id, course_id, round_date, status, confirmed_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, String(customerId), String(courseId), String(roundDate).slice(0, 40),
        status, String(confirmedBy).slice(0, 80), now(), now(),
      );
      return this.listEnrollments(customerId).find((row) => row.id === id);
    },

    // 7 ต.ค. 2026 โหมดคลาส: ออเดอร์ยกเลิก/เปลี่ยนรอบ → ยกเลิกแถวที่ออเดอร์นั้นสร้าง (consoleOrdersApi syncEnrollment)
    setEnrollmentStatus(id, status) {
      if (!["enrolled", "completed", "cancelled"].includes(status)) throw new Error(`enrollment status นอกรายการ: ${status}`);
      return run("UPDATE enrollments SET status = ?, updated_at = ? WHERE id = ?", status, now(), String(id)).changes === 1;
    },

    listEnrollments(customerId) {
      return all(
        "SELECT * FROM enrollments WHERE customer_id = ? ORDER BY created_at DESC",
        String(customerId),
      );
    },
  };
}
