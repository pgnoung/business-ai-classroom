// customerTagActions.mjs — การเพิ่ม/ถอดป้ายลูกค้าที่ "คนกด" ในคอนโซล เส้นเดียว (ย้ายออกจาก consoleApi.mjs 28 ก.ย. 2026)
//
// ปุ่ม "สแปม" ใหม่ต้องเดินทางเดียวกับการติดป้าย null จากแผงป้ายทุกบรรทัด (คำสั่งพี่ง้วง "spam = null chat tag")
// ถ้าเขียนแยกสองที่ วันหนึ่งกติกาปิด AI ของป้ายจะเพี้ยนกัน — ห้องที่กดสแปมจะไม่เงียบเหมือนห้องที่ติดป้ายเอง
// (บทเรียนเดิม 2026-08-28: กติกาป้าย customer กระจาย 8 จุดโดยไม่มีตัวกลาง แล้วรั่วทีละจุด)
import { normalizeTag } from "./dbTags.mjs";
import { silentTagReason } from "./pipeline.mjs";
import { LEGACY_SOURCE_TAG } from "./legacyLink.mjs";
import { checkHumanTag } from "./tagFramework.mjs";
import { isPurchaseEvidenceTag } from "./purchaseHistory.mjs";
import { refreshRfmTags } from "./tags.mjs";
import { isNotQualifiedRow } from "./notQualified.mjs";

function safeListTags(db, customerId) {
  try {
    return db.listTags(customerId);
  } catch {
    return [];
  }
}

// กรอบป้ายชุดเดียว: ทีมติด/ถอดป้ายประวัติการซื้อจาก LINE OA เดิม (ซื้อครั้ง… / ม.ค.2023) = คำนวณ
// ซื้อครั้งที่/ซื้อล่าสุด ใหม่ทันที ให้ป้ายของระบบตรงกับหลักฐานเสมอ
function refreshPurchaseTagsIfEvidence({ db, customerId, tag, framework }) {
  if (framework?.purchase && isPurchaseEvidenceTag(tag, framework.purchase)) refreshRfmTags(db, customerId, { framework });
}

/**
 * ติดป้ายที่คนกด — ป้ายเงียบ (customer/null) ปิด AI ทันทีด้วยเหตุของป้าย
 * framework = กรอบป้ายที่เปิดอยู่ (activeTagFramework) — มี = มิติที่มีรายการรับเฉพาะค่าในรายการ
 *   (ข้อความปฏิเสธเป็นภาษาไทยจาก checkHumanTag) และป้ายในกรอบถูกเขียนเป็นรูปมาตรฐานเดียว
 * @returns {{ ok: true, tag: string, aiSilenced: boolean } | { ok: false, status: number, error: string }}
 */
export function addCustomerTag({ db, customerId, tag, operator, framework = null }) {
  let add = normalizeTag(tag);
  if (!add) return { ok: false, status: 400, error: "ป้ายว่าง" };
  if (framework) {
    const check = checkHumanTag(add, framework);
    if (!check.ok) return { ok: false, status: 400, error: check.reason };
    add = normalizeTag(check.tag);
  }
  if (safeListTags(db, customerId).some((row) => row.tag === add)) {
    return { ok: false, status: 409, error: "ป้ายนี้มีอยู่แล้ว" };
  }
  if (!db.addTag(customerId, add, "human")) return { ok: false, status: 400, error: "เพิ่มป้ายไม่สำเร็จ" };
  db.addAudit({ operator, action: "tag_add", target: customerId, detail: add.slice(0, 80) });
  refreshPurchaseTagsIfEvidence({ db, customerId, tag: add, framework });
  // ป้าย "customer" = ซื้อแล้ว บอทเงียบถาวร ทีมงานคุยเอง (v1.4.33) · "null" = ไม่ใช่แชทจริง/สแปม
  //
  // 2026-08-28: เดิมการติดป้ายไม่ได้ปิด AI เลย ตัวแปลงป้าย→ปิด AI มีที่เดียว
  // คือใน pipeline ซึ่งเดินเฉพาะตอนลูกค้าพิมพ์ข้อความเข้ามาใหม่ — แต่คนที่ซื้อจบ
  // แล้วมักไม่พิมพ์อะไรอีก ป้ายจึงไม่มีวันมีผล ผลจริง: ทีมงานติดป้ายไว้เมื่อวาน
  // เช้าวันรุ่งขึ้น follow-up ก็ยังทักลูกค้ารายนั้นอยู่ดี
  //
  // ปิดที่นี่ทันทีตอนกด เพื่อให้ป้ายมีผลตรงกับที่ทีมงานเข้าใจ ไม่ใช่รอเงื่อนไข
  // ที่มองไม่เห็น (ยังคงเก็บด่านใน pipeline ไว้ — กันเส้นทางติดป้ายทางอื่น)
  let aiSilenced = false;
  const silenceReason = silentTagReason(add);
  if (silenceReason) {
    const tagged = db.getCustomer(customerId);
    // เขียนเหตุใหม่เมื่อ AI ยังเปิด หรือปิดอยู่ด้วยเหตุ bank_sent
    // เหตุผลเดิม (2026-08-28) คือ "ตัวคัด follow-up รับห้อง bank_sent เป็น candidate อยู่"
    // ซึ่งไม่จริงแล้วตั้งแต่ 2026-09-05 (คำสั่งพี่ง้วง: AI ปิด = FU หยุดสนิท) —
    // ยังเขียนทับต่อไปเพราะเหตุปิดควรบอกความจริงล่าสุดว่าห้องนี้เป็นของทีมงานแล้ว
    // เหตุที่หนักกว่านี้ (เช่น urgent_mental) ห้ามทับ
    // 5 ต.ค. 2026 (พี่ง้วง): ห้องสีเหลือง (ตัวกวาดคัดกรองปิดเอง) ก็ทับได้ — ป้ายที่คนติดชนะการตัดสินของ AI เสมอ
    // ไม่ทับ = ห้องยังเป็น not_qualified แล้วตัวกวาดเปิดเขียวคืนเองได้ ทั้งที่ทีมติดป้ายให้บอทเงียบไปแล้ว
    const overwritable = tagged?.ai_enabled === 1 || tagged?.ai_off_reason === "bank_sent" || isNotQualifiedRow(tagged);
    if (overwritable) {
      db.setAiEnabled(customerId, false, silenceReason);
      db.addAudit({
        operator, action: "ai_off_customer_handover", target: customerId,
        detail: `ติดป้าย "${add}" ในคอนโซล — ปิด AI ทันที บอทเงียบจนกว่าจะปลดป้ายและเปิดเอง`,
      });
      aiSilenced = true;
    }
  }
  return { ok: true, tag: add, aiSilenced };
}

/**
 * ถอดป้ายที่คนกด — ป้ายระบบเก่าถอดไม่ได้ · ถอดป้ายเงียบ "ไม่" เปิด AI คืน (คนต้องกดเปิดเอง)
 * @returns {{ ok: true, removed: boolean } | { ok: false, status: number, error: string }}
 */
export function removeCustomerTag({ db, customerId, tag, operator, framework = null }) {
  const remove = String(tag ?? "").trim();
  // 2026-08-24 (audit จับ): ป้ายระบบเก่าคือกลไก read-only ทั้งฝั่ง server/client —
  // ถอดได้ = ห้อง legacy กลับมากดส่งแล้วพังเงียบ (id เก่า 404 ที่ Messaging API)
  if (remove === LEGACY_SOURCE_TAG) {
    return { ok: false, status: 403, error: "ป้ายระบบเก่าถอดไม่ได้ — เป็นตัวล็อกห้องอ้างอิงแบบอ่านอย่างเดียว" };
  }
  const removed = db.removeTag(customerId, remove);
  db.addAudit({ operator, action: "tag_remove", target: customerId, detail: remove.slice(0, 80) });
  if (removed) refreshPurchaseTagsIfEvidence({ db, customerId, tag: remove, framework });
  return { ok: true, removed };
}

export { safeListTags };
