// aiSwitch.mjs — สวิตช์ AI รายห้อง "เส้นเดียว" ที่คนกด (คอนโซล · YOLO · Telegram)
//
// ย้ายออกมาจาก POST /console/api/customers/:id/ai เมื่อ 2026-09-28 เพื่อให้คำสั่ง
// "เปิด AI / ปิด AI" ทาง Telegram และ "แล้วคุยต่อ" ของ YOLO เดินเส้นเดียวกับปุ่มในห้องแชททุกบรรทัด
// (ปิด = เหตุ manual ที่เส้นอัตโนมัติเปิดคืนไม่ได้ · เปิด = ล้างธงรอคน + ประทับรีเซ็ตใบ้ส่งไม้ต่อ)
// ถ้ามีคนแก้กติกาการเปิด/ปิดในอนาคต ต้องแก้ที่นี่ที่เดียว ไม่ใช่ไล่แก้สามที่
import { MANUAL_AI_OFF_REASON, answerPendingInbound } from "./aiPausePolicy.mjs";
import { stampHandoffHintReset } from "./pipeline.mjs";
import { releaseAutoCustomerTagOnReopen } from "./legacyLink.mjs";
import { NOT_QUALIFIED_REASON, qualifyHumanOnKey, qualifyReleaseKey } from "./notQualified.mjs";
import { createQualifyAnswerPending } from "./qualifyAnswerPending.mjs";

// รีวิวปรปักษ์ 5 ต.ค. #5: คนกดเปิด AI "ทุกห้อง ทุกเหตุ" (คอนโซล · Telegram · YOLO · คีย์แดชบอร์ด) = ประทับเวลา
// qualify_human_on:<id> — ตัวกวาดคัดกรองไม่ปิดเหลืองห้องที่คนเพิ่งคืนให้ AI (QUALIFY_HUMAN_RECENT_MS)
// เดิมปักหมุดเฉพาะห้องที่ปิดเพราะ not_qualified: ห้องร้องเรียน/ขอคุยกับคนที่ทีมคุยจบทางโทรศัพท์แล้วกดเปิดคืน
// ถูกตัวกวาดปิดเหลืองในรอบชั่วโมงถัดไป · เขียนไม่ได้ = เตือน แต่การเปิด AI ต้องสำเร็จเสมอ
export function markHumanAiOn({ db, customerId, nowMs = Date.now(), logger = console }) {
  try {
    db.setSetting(qualifyHumanOnKey(customerId), String(Number(nowMs) || Date.now()));
    return true;
  } catch (err) {
    logger?.warn?.(`aiSwitch: ประทับเวลาคนเปิด AI ไม่สำเร็จ (${err?.message || err})`);
    return false;
  }
}

// รีวิวปรปักษ์ 5 ต.ค. #21: ถ้อยคำ audit เมื่อคนกดเปิดทับห้องสีเหลืองแล้วระบบตอบข้อความที่ค้าง
export const NOT_QUALIFIED_HUMAN_ON_PENDING_DETAIL =
  "คนกดเปิด AI ทับห้องสีเหลือง — ส่งข้อความที่ค้างเข้าเส้นทางตอบอีกครั้ง (push เพราะ reply token หมดอายุ)";
// รีวิวปรปักษ์รอบ 2 5 ต.ค.: ห้องเหลืองค้างได้หลายวัน — คนกดเปิดแล้วระบบเคยตอบ "ค่ะ" ที่ลูกค้าส่งมา 5 วันก่อนทันที
// และตอบซ้ำข้อความที่ทีมตอบไปแล้วทาง LINE OA Manager (ไม่มีแถวขาออกในระบบ) — ตอบเฉพาะเมื่อข้อความล่าสุดของห้องเป็นของ
// ลูกค้าและไม่เก่ากว่า 24 ชม. นอกนั้นปล่อยให้คิวรอตอบ (ห้องเปิด AI แล้วข้อความล่าสุดยังไม่มีใครตอบ = ขึ้นคิวเอง)
export const NOT_QUALIFIED_HUMAN_ON_PENDING_MAX_AGE_MS = 24 * 3_600_000;

// 5 ต.ค. 2026 (พี่ง้วง): คนกดเปิด AI ทับห้องสีเหลือง "AI off (not qualify)" = คนตัดสินแล้วว่าคุยต่อ
// ปักหมุด qualify_release:<id> ให้ตัวกวาดคัดกรองไม่ปิดห้องนี้อีก (คนชนะ AI) — ลบเองเฉพาะตอน PDPA reset
// คืน suffix ต่อท้าย audit ("" = ไม่ใช่ห้องสีเหลือง) · เขียนหมุดไม่ได้ = เตือน แต่การเปิด AI ต้องสำเร็จเสมอ
export const NOT_QUALIFIED_OVERRIDE_AUDIT_SUFFIX = " · override:not_qualified";

export function markNotQualifiedOverride({ db, customerId, previousOffReason, operator = "", nowMs = Date.now(), logger = console }) {
  if (String(previousOffReason ?? "").trim() !== NOT_QUALIFIED_REASON) return "";
  try {
    db.setSetting(qualifyReleaseKey(customerId), JSON.stringify({ at: Number(nowMs) || Date.now(), by: String(operator || "") }));
  } catch (err) {
    logger?.warn?.(`aiSwitch: ปักหมุดห้ามปิดซ้ำของห้องสีเหลืองไม่สำเร็จ (${err?.message || err})`);
  }
  return NOT_QUALIFIED_OVERRIDE_AUDIT_SUFFIX;
}

export function setCustomerAiSwitch({ db, customerId, enabled, operator, source = "console", nowMs = Date.now(), pipeline = null, notifier = null, logger = null }) {
  const on = enabled === true;
  const previousOffReason = String(db.getCustomer(customerId)?.ai_off_reason || "");
  // 2026-09-02: ปิดด้วยมือต้องทิ้งเหตุ "manual" ไว้ ไม่ใช่ค่าว่าง — เส้นทางอัตโนมัติ
  // ทุกเส้นเช็ค canAutoEnableAi() จากเหตุนี้ก่อนเปิดคืน (ค่าว่าง = แยกไม่ออกว่าใครสั่ง)
  let customer = db.setAiEnabled(customerId, on, on ? "" : MANUAL_AI_OFF_REASON);
  if (on) {
    // F7 (ตรวจย้อนหลัง ก.ย. 2026): เปิด AI คืน = ถอนป้าย customer ที่ "ระบบ" ติดจากชื่อซ้ำ
    // ไม่งั้นด่านป้ายในไปป์ไลน์ปิดห้องกลับทุกเทิร์น (ป้ายที่คนติดเองไม่แตะ)
    releaseAutoCustomerTagOnReopen({ db, customerId, operator, logger: logger ?? console });
    customer = db.clearNeedsHuman(customerId); // เปิด AI กลับ = ปิดธง takeover
    // R3(d) (คำสั่งพี่ง้วง 2026-09-05): คนกดเปิดคืน = ห้องเริ่มรอบใหม่ ใบ้ส่งไม้ต่อ
    // จากบทสนทนาก่อนหน้าต้องมองไม่เห็น ไม่งั้นข้อความแรกที่ลูกค้าพิมพ์กลับมาอาจถูก
    // ปิดห้องซ้ำด้วยใบ้เก่าทันที — ลูปที่คนกดเปิดคืนไม่มีทางชนะ
    stampHandoffHintReset(db, customerId, nowMs);
  }
  const override = on
    ? markNotQualifiedOverride({ db, customerId, previousOffReason, operator, nowMs, logger: logger ?? console })
    : "";
  if (on) markHumanAiOn({ db, customerId, nowMs, logger: logger ?? console });
  // คอนโซลคงรายละเอียด "on"/"off" เดิมเป๊ะ (เทสต์/รายงานเดิมอ่านค่านี้) — ช่องอื่นต่อท้ายที่มา
  // ห้องสีเหลืองต่อท้าย " · override:not_qualified" (ยังขึ้นต้นด้วย "on" ตัวอ่านเดิมใช้ startsWith)
  db.addAudit({
    operator, action: "ai_toggle", target: customerId,
    detail: `${on ? "on" : "off"}${source && source !== "console" ? ` · ${source}` : ""}${override}`,
  });
  // F5 (ตรวจย้อนหลัง ก.ย. 2026): ห้องที่ปิดเพราะไฟล์แนบ — ข้อความที่ลูกค้าพิมพ์ตามมาระหว่าง AI ปิด
  // ถูกกลืนเงียบ คนกดเปิดคืนแล้วต้องได้คำตอบ ไม่ใช่รอให้ลูกค้าพิมพ์ใหม่ (ไม่มี pipeline = ไม่เดา)
  if (on && previousOffReason === "file_review" && typeof pipeline?.handleInboundText === "function") {
    answerPendingInbound({
      db, pipeline, notifier, customerId, logger: logger ?? console,
      auditAction: "file_review_pending_reply",
      auditDetail: "เปิด AI คืนหลังไฟล์แนบ — ส่งข้อความที่ค้างเข้าเส้นทางตอบอีกครั้ง (push เพราะ reply token หมดอายุ)",
    });
  }
  // รีวิวปรปักษ์ 5 ต.ค. #21: ห้องสีเหลืองกลืนทุกข้อความเงียบ ๆ และไม่อยู่ในคิวรอตอบ — คนกดเปิดทับ (= เห็นว่าคุยต่อได้)
  // ต้องได้คำตอบข้อความที่ค้างเหมือนตัวกวาดเปิดเขียวเอง ไม่ใช่รอให้ลูกค้าพิมพ์ใหม่ · เส้นเดียวกับตัวกวาด
  // (qualifyAnswerPending: เคารพหน้าต่าง 24 ชม. ของ Facebook + ข้อความที่พิมพ์ระหว่างเหลืองครบ + ไม่ตอบข้อความเก่า/ตอบแล้ว)
  // ไม่มี pipeline (Telegram/YOLO/สคริปต์) = ไม่เดาแทนคน เหมือนเส้นไฟล์แนบ — คีย์แดชบอร์ดอยู่ operatorApi.mjs
  if (on && override && typeof pipeline?.handleInboundText === "function") {
    createQualifyAnswerPending({
      db, pipeline, notifier, logger: logger ?? console, now: () => Number(nowMs) || Date.now(),
      auditDetail: NOT_QUALIFIED_HUMAN_ON_PENDING_DETAIL, via: "human_on",
      maxPendingAgeMs: NOT_QUALIFIED_HUMAN_ON_PENDING_MAX_AGE_MS,
    })({ customerId });
  }
  return customer;
}
