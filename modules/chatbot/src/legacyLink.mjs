// legacyLink.mjs — โยงลูกค้าจริง (Messaging API userId) เข้ากับห้องอ้างอิงจากระบบเก่า
// (chat.line.biz userId) "ด้วยชื่อโปรไฟล์" — v1.4.48 แผน B ของ cutover (2026-08-23)
//
// ทำไมต้องมี: พิสูจน์แล้วทั้ง OA pilot และ OA จริง (Codex 2026-08-23: botId Ud794… ≠ Uf4e0…,
// /bot/profile ของ userId เก่า = 404) ว่า chat.line.biz กับ Messaging API เป็นคนละ namespace
// ลูกค้าคนเดียวกันมี id คนละชุด การ import ด้วย id จึงไม่มีวันตรงคน สิ่งเดียวที่ทั้งสองฝั่ง
// มีเหมือนกันคือ "ชื่อโปรไฟล์ LINE"
//
// กติกาความปลอดภัย (ผิดแล้วเจ็บ: โยงผิดคน = ป้าย/ประวัติของคนอื่นไปโผล่ในห้องลูกค้า):
// - ชื่อตรงเป๊ะใช้ได้เพียงเสนอ candidate เพราะ display name เปลี่ยน/ปลอมได้
// - candidate ไม่คัดลอกป้ายหรือสถานะของอีกคน
// - พนักงานต้องกดยืนยันใน Console ครั้งเดียว จึงคัดลอกป้ายและสถานะ handover
// - ชื่อซ้ำหลายห้อง = ไม่เสนอ candidate อัตโนมัติ ต้องให้คนเทียบเอง
//
// 2026-09-02 (คำสั่งเจ้าของ): เดิมโค้ดนี้ "พัก AI" ของ candidate ไว้รอคนยืนยัน ผลจริงคือ
// ลูกค้า 11 คนนั่งรอ 3–4.5 ชั่วโมงโดยไม่มีใครตอบ และตอนกดยืนยันระบบก็แค่เปิดสวิตช์คืน
// ไม่ได้ตอบข้อความที่ค้างให้ด้วย นโยบายใหม่: AI คุยต่อ "แบบลูกค้าใหม่" ทันที
// (pipeline แทรกกติกาห้ามอ้างประวัติระบบเก่าให้เฉพาะห้องที่ยังรอยืนยัน) + แจ้งทีมหนึ่งครั้ง
// ความเสี่ยงเดิมยังถูกกันครบ: ไม่มีป้าย ไม่มีประวัติ ไม่มีชื่อจากห้องเก่าไหลข้ามมาเลย
import { canAutoEnableAi } from "./aiPausePolicy.mjs";
import { BOT_SILENCED_TAGS } from "./db.mjs";
import { normalizeThai } from "./safetyRouter.mjs";
import { AUTO_TAG_NOTE_WINDOW_MS, LEGACY_AUTO_CUSTOMER_NOTE, SYSTEM_LINK_AUTHOR } from "./legacyAutoTag.mjs";

export const LEGACY_SOURCE_TAG = "ย้ายจาก LINE OA";
export const LEGACY_LINK_TAG = "โยงระบบเก่า";
// เหตุที่ "นโยบายเดิม" เคยใช้ปิด AI ไว้ระหว่างรอยืนยัน — ไม่ถูกเขียนใหม่อีกแล้ว
// แต่ห้องที่ค้างมาก่อน deploy 2026-09-02 ยังมีเหตุนี้ติดอยู่ ต้องปลดคืนได้
const LEGACY_PAUSE_REASONS = new Set(["legacy_candidate", "legacy_ambiguous"]);

// ---- ห้องระบบเก่าที่ "เป็นลูกค้าจริงอยู่แล้ว" (คำสั่งเจ้าของ 2026-09-02, รอบสอง) ----
//
// ของจริงบน production: ป้าย "ลงทะเบียนแล้ว" = ซื้อ/ลงทะเบียนจบแล้ว (798 ห้องอ้างอิง)
// ส่วน "พร้อมลงทะเบียน" แปลว่าแค่พร้อมจะลง — ยังไม่ใช่ลูกค้า จึงเทียบแบบ "เท่ากันเป๊ะ"
// หลัง normalize เท่านั้น ห้ามใช้ contains เด็ดขาด ไม่งั้นสองป้ายนี้จะถูกนับเป็นอันเดียวกัน
export const LEGACY_REGISTERED_TAGS = Object.freeze(["ลงทะเบียนแล้ว"]);
// ป้ายที่ระบบติดให้เองเมื่อเจอเคสนี้ — ต้องตรงกับ SILENT_TAG_REASON ใน pipeline.mjs
// (ตัวแปลงป้าย -> ปิด AI ใช้ชื่อป้ายนี้ตัวเดียว)
const AUTO_CUSTOMER_TAG = "customer";
// source "human" โดยเจตนา ไม่ใช่ "ai": ป้าย source 'ai' ถูก replaceSourceTags() ของ scorer
// (pipeline.mjs:1185) ลบทิ้งยกชุดทุกครั้งที่รีเฟรชป้าย — ป้ายที่สั่งให้บอทเงียบหายเงียบ ๆ ไม่ได้
const AUTO_CUSTOMER_TAG_SOURCE = "human";
// ข้อความโน้ต/ชื่อผู้เขียนของระบบ + หน้าต่างเวลา อยู่ใน legacyAutoTag.mjs (28 ก.ย. 2026) ให้ SQL ของคอนโซล
// ใช้กติกาเดียวกันได้โดยไม่ต้อง import ไฟล์นี้ (ไฟล์นี้ import db.mjs = วง import)
export { LEGACY_AUTO_CUSTOMER_NOTE };
export const LEGACY_AUTO_CUSTOMER_AUDIT = "legacy_registered_customer_tag";
const CUSTOMER_HANDOVER_REASON = "customer_handover";

const normalizeTagText = (value) => String(value ?? "").normalize("NFC").trim().toLowerCase();
const EXISTING_CUSTOMER_TAGS = new Set(
  [...LEGACY_REGISTERED_TAGS, ...BOT_SILENCED_TAGS].map(normalizeTagText),
);

// ห้องอ้างอิงห้องนี้เป็น "ลูกค้าจริงอยู่แล้ว" ไหม — อ่านป้ายอย่างเดียว ไม่เขียนอะไร
export function legacyRoomIsExistingCustomer(db, legacyId) {
  try {
    return db.listTags(legacyId).some((row) => EXISTING_CUSTOMER_TAGS.has(normalizeTagText(row.tag)));
  } catch {
    return false; // อ่านป้ายไม่ได้ = ไม่กล้าสรุปว่าเป็นลูกค้าเก่า (เส้นทางปกติยังกันด้วยการยืนยัน)
  }
}

// ระบบเป็นคนติดป้าย customer ให้เองหรือเปล่า — ใช้โน้ตของระบบเป็นหลักฐาน
// (ไม่ใช้ audit เพราะ listAudit อ่านได้แค่ 500 แถวล่าสุดทั้งระบบ ห้องเก่าจะหลุดหน้าต่าง
//  และไม่ใช้ settings เพราะคีย์จะพก LINE user id ไว้ข้ามการลบข้อมูลตาม PDPA)
function autoCustomerTagAddedBySystem(db, customerId) {
  try {
    return db.listHandoffNotes(customerId, 500)
      .some((note) => note.author === SYSTEM_LINK_AUTHOR && note.text === LEGACY_AUTO_CUSTOMER_NOTE);
  } catch {
    return false;
  }
}

// F7 (ตรวจย้อนหลัง ก.ย. 2026): ป้าย customer "แถวนี้" เป็นของระบบจริงไหม — ไม่ใช่แค่ "เคยมีโน้ตของระบบ"
// คอลัมน์ source ของป้ายเป็น human ทั้งสองแบบ (ป้ายระบบจงใจใช้ human กัน scorer ลบทิ้ง และ CHECK ของ
// ตาราง customer_tags รับแค่ rfm/ai/human) หลักฐานจึงเป็นเวลา: ป้ายระบบถูกติดคู่กับโน้ตในจังหวะเดียวกัน
// ถ้าคนถอนแล้วติดป้ายเองใหม่ทีหลัง แถวป้ายจะใหม่กว่าโน้ตมาก = ป้ายของคน ห้ามแตะ
// (AUTO_TAG_NOTE_WINDOW_MS อยู่ใน legacyAutoTag.mjs — SYSTEM_CUSTOMER_TAG_SQL ใช้ค่าเดียวกัน)
function systemOwnsCustomerTag(db, customerId) {
  try {
    const tag = db.listTags(customerId).find((row) => row.tag === AUTO_CUSTOMER_TAG);
    if (!tag) return false;
    const tagAt = Number(tag.created_at) || 0;
    return db.listHandoffNotes(customerId, 500).some((note) => note.author === SYSTEM_LINK_AUTHOR
      && note.text === LEGACY_AUTO_CUSTOMER_NOTE
      && Math.abs((Number(note.created_at) || 0) - tagAt) <= AUTO_TAG_NOTE_WINDOW_MS);
  } catch {
    return false;
  }
}

/**
 * F7 ข้อ 3 (ตรวจย้อนหลัง ก.ย. 2026): คนกดเปิด AI คืนในห้องที่ "ระบบ" ติดป้าย customer ให้จากชื่อซ้ำ
 * = คนตัดสินแล้วว่าให้บอทคุย ป้ายของระบบต้องถอนด้วย — ไม่งั้นด่านป้ายใน pipeline ปิดห้องซ้ำทุกเทิร์น
 * (ของจริง: ชมพู่เปิด AI คืนสามครั้งในห้องเดียว ป้ายปิดกลับทุกครั้ง) · ป้ายที่คนติดเองห้ามแตะ
 * @returns {boolean} ถอนป้ายของระบบออกหรือไม่
 */
export function releaseAutoCustomerTagOnReopen({ db, customerId, operator = "team", logger = console } = {}) {
  if (!systemOwnsCustomerTag(db, customerId)) return false;
  try {
    const removed = db.removeTag(customerId, AUTO_CUSTOMER_TAG);
    if (removed) {
      db.addAudit({
        operator: String(operator || "team").slice(0, 80), action: `${LEGACY_AUTO_CUSTOMER_AUDIT}_released`,
        target: customerId, detail: "เปิด AI คืนด้วยมือ — ถอนป้าย customer ที่ระบบติดให้จากชื่อซ้ำ (ป้ายที่คนติดไม่แตะ)",
      });
    }
    return removed;
  } catch (err) {
    logger.warn?.(`legacyLink: ถอนป้าย customer ของระบบไม่สำเร็จ (${err?.message || err})`);
    return false;
  }
}

// F7 ข้อ 2: ข้อความแรก ๆ ที่ "ถามแบบลีดใหม่" — ราคา/รายละเอียด/สนใจ/ตอบบันไดคัดกรอง/in-house/คอนซัล
// นักเรียนเก่าที่กลับมามักเปิดด้วยคีย์เวิร์ดกิจกรรมหรือคำทักทาย (10 เคสที่ถูกในชุดตรวจเป็นแบบนั้นทั้งหมด)
// คำตอบบันไดคัดกรองของลูกแพรเอง ("3", "Stage 3 ครับ") ก็นับ — นักเรียนเก่าไม่ต้องถูกคัดกรองระดับใหม่
const NEW_LEAD_INQUIRY =
  /ราคา|เท่าไหร่|เท่าไร|กี่บาท|ค่าเรียน|รายละเอียด|สอนอะไร|สนใจ|เรียนวันไหน|ยังไม่เคย|คอนซัล|consult|in.?house|^\s*(?:stage|สเตจ|ระดับ)?\s*[1-7]\s*(?:นะ)?\s*(?:ครับ|ค่ะ|คะ|คับ|ค่า|จ้า)?\s*$/iu;
export function looksLikeNewLeadInquiry(texts = []) {
  return (Array.isArray(texts) ? texts : [texts]).slice(0, 3)
    .some((text) => NEW_LEAD_INQUIRY.test(normalizeThai(String(text || "")).trim()));
}

// ลูกค้าเก่าตัวจริง: ปิดบอททันทีและติดป้ายให้ตรงกับที่ทีมงานเห็นในคอนโซล
// เจตนา: เคสนี้ "ต้องเงียบ" ต่างจาก candidate ทั่วไปที่ต้องคุยต่อ — เพราะห้องเก่าบอกแล้วว่า
// คนนี้ซื้อจบไปแล้ว การให้บอทขายซ้ำแย่กว่าการรอทีมงาน
function markLegacyExistingCustomer({ db, customerId, notifier, logger = console }) {
  try {
    const added = db.addTag(customerId, AUTO_CUSTOMER_TAG, AUTO_CUSTOMER_TAG_SOURCE);
    db.setAiEnabled(customerId, false, CUSTOMER_HANDOVER_REASON);
    // โน้ตนี้เป็นทั้งข้อความให้ทีมอ่าน และหลักฐานว่า "ระบบ" เป็นคนติดป้าย (ใช้ตอน reject)
    if (added) db.addHandoffNote({ customerId, author: SYSTEM_LINK_AUTHOR, text: LEGACY_AUTO_CUSTOMER_NOTE });
    db.addAudit({
      operator: "system", action: LEGACY_AUTO_CUSTOMER_AUDIT, target: customerId,
      detail: added
        ? "ห้องระบบเก่ามีป้ายลงทะเบียนแล้ว/ลูกค้า — ติดป้าย customer + ปิด AI รอทีมงาน"
        : "ห้องระบบเก่ามีป้ายลงทะเบียนแล้ว/ลูกค้า — ป้าย customer มีอยู่ก่อนแล้ว ปิด AI รอทีมงาน",
    });
    if (notifier?.fireLater) {
      const customer = db.getCustomer(customerId);
      notifier.fireLater({
        customerId,
        channelId: customer?.channel_id || "default",
        reason: "legacy_registered_customer",
        customerName: customer?.known_name || customer?.display_name || "",
        force: true,
      });
    }
    return true;
  } catch (err) {
    logger.error?.(`legacyLink: ติดป้ายลูกค้าเก่าไม่สำเร็จ (${err?.message || err})`);
    return false;
  }
}

export function normalizeDisplayName(name = "") {
  return String(name || "").normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

// ตัดสินจากรายชื่อผู้สมัคร (แถว legacy ที่ชื่อ normalize แล้วตรงกัน)
export function decideLegacyLink({ displayName = "", candidates = [] } = {}) {
  const key = normalizeDisplayName(displayName);
  if (!key) return { state: "no_name", legacyId: "", candidates: [] };
  const hits = candidates.filter((c) => normalizeDisplayName(c.display_name) === key);
  if (hits.length === 1) return { state: "linked", legacyId: hits[0].line_user_id, candidates: hits };
  if (hits.length > 1) return { state: "ambiguous", legacyId: "", candidates: hits };
  return { state: "none", legacyId: "", candidates: [] };
}

// ทำงานจริงกับ DB — คืนผลลัพธ์ที่บันทึกแล้ว; ล้มเหลว = ไม่โยง (ห้ามลากแชทล้ม)
// inboundTexts = ข้อความที่ลูกค้าพิมพ์เองในห้องนี้จนถึงตอนนี้ (เก่า -> ใหม่) — ไม่ส่งมา = พฤติกรรมเดิม
export function linkLegacyByName({ db, customerId, displayName, logger = console, notifier = null, inboundTexts = [] }) {
  const customer = db.getCustomer(customerId);
  if (!customer) return { state: "no_customer" };
  if (customer.legacy_link) return { state: "already", value: customer.legacy_link };
  const name = displayName || customer.display_name || "";
  const decision = decideLegacyLink({ displayName: name, candidates: name ? db.findLegacyByDisplayName(name) : [] });
  if (decision.state === "no_name") return decision; // ยังไม่มีชื่อ = ยังไม่ตัดสิน รอรอบหน้า
  // ห้องอ้างอิงที่ตรงชื่อ (หนึ่งห้องหรือหลายห้อง) มีป้ายบอกว่าเป็นลูกค้าจริงอยู่แล้วไหม
  const existingCustomer = decision.candidates.some((c) => legacyRoomIsExistingCustomer(db, c.line_user_id));
  if (decision.state === "linked") {
    const legacy = db.getCustomer(decision.legacyId);
    db.addHandoffNote({
      customerId, author: "ระบบ (โยงระบบเก่าด้วยชื่อ)",
      text: `พบห้องระบบเก่าชื่อ "${legacy?.display_name || name}" ตรงกันห้องเดียว — AI คุยต่อแบบลูกค้าใหม่ ` +
        "และยังไม่คัดลอกป้าย เพราะชื่อ LINE ไม่ใช่หลักฐานยืนยันตัวบุคคล รบกวนทีมงานกดตรวจและยืนยันในแผงข้อมูลลูกค้า",
    });
    db.setLegacyLink(customerId, `candidate:${decision.legacyId}`);
    // F7 ข้อ 2 (ตรวจย้อนหลัง ก.ย. 2026): ชื่อตรงห้องเดียวก็ยังเป็นแค่ชื่อ — ถ้าข้อความแรกถามแบบลีดใหม่
    // (ราคา/รายละเอียด/สนใจ/คอนซัล) ให้คนยืนยันก่อน บอทคุยแบบลูกค้าใหม่ไปพลาง (ห้ามอ้างประวัติ)
    const inquiring = existingCustomer && looksLikeNewLeadInquiry(inboundTexts);
    if (existingCustomer && !inquiring) markLegacyExistingCustomer({ db, customerId, notifier, logger });
    else if (inquiring) notifyRegisteredInquiry({ db, customerId, notifier });
    else notifyCandidate({ db, customerId, notifier });
    logger.debug?.(`legacyLink: สร้าง candidate ให้ ${customerId} (existingCustomer=${existingCustomer}, inquiring=${inquiring})`);
    return { ...decision, state: "candidate", existingCustomer };
  }
  if (decision.state === "ambiguous") {
    db.addHandoffNote({
      customerId, author: "ระบบ (โยงระบบเก่าด้วยชื่อ)",
      text: `ชื่อ "${name}" ตรงกับห้องระบบเก่า ${decision.candidates.length} ห้อง — ระบบไม่โยงให้เอง ` +
        "AI คุยต่อแบบลูกค้าใหม่ไปก่อน " +
        `รบกวนทีมงานเทียบแล้วโยงมือ: ${decision.candidates.map((c) => `${c.line_user_id.slice(0, 10)}… (ป้าย ${db.listTags(c.line_user_id).length})`).join(", ")}`,
    });
    db.setLegacyLink(customerId, `ambiguous:${decision.candidates.length}`);
    // F7 ข้อ 1 (ตรวจย้อนหลัง ก.ย. 2026 — D328, D331, D337, D341, D878, D882, D889): ชื่อตรงหลายห้อง
    // = ชื่อเล่นทั่วไป ห้ามติดป้ายเงียบเด็ดขาด แม้มีห้องใดห้องหนึ่งลงทะเบียนแล้ว (เดิม "เงียบไว้ก่อน"
    // ทำให้ลีดใหม่ไม่ได้คำตอบ 27–72 ชม.) — AI คุยต่อแบบลูกค้าใหม่ (LEGACY_PENDING_RULE) + ทีมเทียบเอง
    notifyCandidate({ db, customerId, notifier });
    return { ...decision, existingCustomer };
  }
  db.setLegacyLink(customerId, "none");
  return decision;
}

// ปลุกทีมหนึ่งครั้งต่อห้อง: ก่อนหน้านี้ห้องเงียบเองจึงไม่มีใครต้องรู้ ตอนนี้ AI คุยต่อ
// ทีมจึงต้องรู้ว่ามีห้องรอเทียบตัวตนอยู่ ไม่งั้น candidate จะค้างไปเรื่อย ๆ โดยไม่มีใครกด
// force: linkLegacyByName เดินได้ครั้งเดียวต่อคน (legacy_link ถูกเขียนแล้ว) ถ้าโดน
// cooldown กลืนจะไม่มีรอบสองให้แจ้งอีกเลย
function notifyCandidate({ db, customerId, notifier }) {
  if (!notifier?.fireLater) return;
  try {
    const customer = db.getCustomer(customerId);
    notifier.fireLater({
      customerId,
      channelId: customer?.channel_id || "default",
      reason: "legacy_candidate",
      customerName: customer?.known_name || customer?.display_name || "",
      force: true,
    });
  } catch { /* แจ้งทีมพังห้ามล้มการโยง */ }
}

// F7 ข้อ 2: ห้องเก่าที่ลงทะเบียนแล้ว แต่ลูกค้าเปิดด้วยคำถามแบบลีดใหม่ — ข้อความแจ้งทีมต้องไม่อ้างว่า
// "ติดป้ายและปิด AI ให้แล้ว" (ข้อความเริ่มต้นของเหตุนี้) เพราะรอบนี้ระบบไม่ได้ทำทั้งสองอย่าง
function notifyRegisteredInquiry({ db, customerId, notifier }) {
  if (!notifier?.fireLater) return;
  try {
    const customer = db.getCustomer(customerId);
    notifier.fireLater({
      customerId,
      channelId: customer?.channel_id || "default",
      reason: "legacy_registered_customer",
      customerName: customer?.known_name || customer?.display_name || "",
      reasonTextOverride: "ชื่อ LINE ตรงกับห้องลูกค้าเก่าที่ลงทะเบียนแล้ว แต่ข้อความแรกถามแบบลูกค้าใหม่ "
        + "— AI คุยต่อแบบลูกค้าใหม่ไปก่อน (ไม่อ้างประวัติเก่า) รบกวนทีมงานกดยืนยันหรือปฏิเสธการโยงในแผงข้อมูลลูกค้า",
      force: true,
    });
  } catch { /* แจ้งทีมพังห้ามล้มการโยง */ }
}

function candidateIdOf(value = "") {
  const match = String(value || "").match(/^candidate:(.+)$/u);
  return match?.[1] || "";
}

// Called only from the authenticated Console. The candidate id never comes
// from the browser; it is read from the server-side customer row created above.
export function confirmLegacyLink({ db, customerId, operator = "team" }) {
  const customer = db.getCustomer(customerId);
  const legacyId = candidateIdOf(customer?.legacy_link);
  if (!customer || !legacyId) return { state: "not_candidate" };
  const legacy = db.getCustomer(legacyId);
  const isReference = legacy && db.listTags(legacyId).some((row) => row.tag === LEGACY_SOURCE_TAG);
  if (!isReference || normalizeDisplayName(customer.display_name) !== normalizeDisplayName(legacy.display_name)) {
    return { state: "invalid_candidate" };
  }
  // audit 2026-08-26: กติกาที่เขียนไว้ในโค้ดเองคือ "ห้องเก่าห้องหนึ่งต้องถูกโยงได้
  // โดยลูกค้าจริงคนเดียวเท่านั้น" (db.mjs:320) เส้นทางโยงมือเช็คไว้แล้ว
  // แต่เส้นทางยืนยัน candidate ไม่เคยเช็ค — ลูกค้าจริงหลายคนที่ชื่อ LINE ตรงกัน
  // จึงยืนยันห้องเก่าห้องเดียวกันได้ไม่จำกัด แล้วประวัติ/ป้าย/โน้ตของคนหนึ่ง
  // จะถูกคัดลอกไปติดอีกคนโดยไม่มีใครรู้
  const taken = db.customerLinkedToLegacy(legacyId);
  if (taken && taken.line_user_id !== customerId) {
    return { state: "legacy_taken", by: taken.line_user_id };
  }

  return applyLegacyLink({ db, customerId, customer, legacy, legacyId, operator, via: "confirm" });
}

// ผลของการโยง (คัดลอกป้าย/สถานะ/โน้ต/ตั้ง linked:) — ใช้ร่วมทั้งเส้นยืนยัน candidate
// และเส้นโยงมือ เพื่อไม่ให้สองเส้นเพี้ยนจากกัน
function applyLegacyLink({ db, customerId, customer, legacy, legacyId, operator = "team", via = "confirm" }) {
  const copied = [];
  for (const row of db.listTags(legacyId)) {
    const tag = String(row.tag || "");
    if (!tag || tag === LEGACY_SOURCE_TAG) continue;
    // ป้าย rfm (ซื้อครั้งที่/ซื้อล่าสุด …) คำนวณจากหลักฐาน ไม่ใช่ป้ายของคน — ห้องใหม่คำนวณเองจากป้ายประวัติที่คัดลอกไป
    // (คัดลอกเป็น human = ค้างเป็นค่าเก่าคู่กับค่าที่ระบบคำนวณใหม่ในมิติค่าเดียว)
    if (row.source === "rfm") continue;
    if (db.addTag(customerId, tag, "human")) copied.push(tag);
  }
  db.addTag(customerId, LEGACY_LINK_TAG, "human");
  if (legacy.ai_enabled === 0 && legacy.ai_off_reason === "customer_handover") {
    db.setAiEnabled(customerId, false, "customer_handover");
  } else if (LEGACY_PAUSE_REASONS.has(String(customer.ai_off_reason || ""))
             && canAutoEnableAi(customer, { expectReason: customer.ai_off_reason })) {
    // ห้องที่ค้างมาจากก่อน 2026-09-02 (ระบบเคยปิด AI ไว้เอง) — ปลดคืนได้เพราะเหตุนี้
    // เป็นของระบบเอง; ห้องที่คนจริงสั่งปิดไว้ไม่เข้าเงื่อนไขนี้และต้องปิดต่อ
    db.setAiEnabled(customerId, true);
  }
  db.addHandoffNote({
    customerId, author: String(operator || "team").slice(0, 80),
    text: `${via === "manual" ? "โยงมือ (ทีมงานเทียบเอง)" : "ยืนยันโยง"}กับห้องระบบเก่าชื่อ "${legacy.display_name || customer.display_name}" แล้ว — ` +
      `คัดลอกป้าย ${copied.length} ป้าย${legacy.ai_off_reason === "customer_handover" ? " · ผู้ซื้อเก่า: AI ปิด ทีมงานดูแลเอง" : ""}`,
  });
  db.setLegacyLink(customerId, `linked:${legacyId}`);
  return { state: "linked", copied, customer: db.getCustomer(customerId) };
}

// 2026-08-24 (คำสั่งพี่ง้วง "แอดมิน confirm เพื่อเทียบลูกค้ากันใหม่ได้"): เส้นโยงมือ
// สำหรับเคสที่ระบบไม่กล้าเสนอเอง (ambiguous หลายห้อง / none / เคย reject) —
// คนเป็นผู้ตัดสินและมีชื่อคนกดใน audit+โน้ตเสมอ; กติกากันพลาด:
// - ห้องปลายทางต้องเป็นห้องอ้างอิงจริง (มีป้ายระบบเก่า) และยังไม่ถูกใครโยง
// - ห้องต้นทางต้องยังไม่ linked: (แก้ลิงก์เดิม = ต้องให้ Codex/owner ทำมือ เพราะต้องถอนป้ายที่คัดลอกไปแล้ว)
// - ไม่บังคับชื่อตรง (นั่นคือเหตุที่ระบบเสนอเองไม่ได้) แต่ฝั่ง UI ต้องแสดงชื่อทั้งสองก่อนกด
export function manualLegacyLink({ db, customerId, legacyId, operator = "team" }) {
  const customer = db.getCustomer(customerId);
  if (!customer) return { state: "no_customer" };
  if (String(customer.legacy_link || "").startsWith("linked:")) return { state: "already_linked" };
  const legacy = db.getCustomer(String(legacyId || ""));
  const isReference = legacy && db.listTags(legacy.line_user_id).some((row) => row.tag === LEGACY_SOURCE_TAG);
  if (!isReference) return { state: "not_reference" };
  if (legacy.line_user_id === customerId) return { state: "not_reference" };
  const taken = db.customerLinkedToLegacy(legacy.line_user_id);
  if (taken && taken.line_user_id !== customerId) return { state: "legacy_taken", by: taken.line_user_id };
  return applyLegacyLink({ db, customerId, customer, legacy, legacyId: legacy.line_user_id, operator, via: "manual" });
}

export function rejectLegacyLink({ db, customerId, operator = "team" }) {
  const customer = db.getCustomer(customerId);
  if (!candidateIdOf(customer?.legacy_link)) return { state: "not_candidate" };
  // ป้าย customer ที่ "ระบบ" ติดให้เพราะเข้าใจว่าเป็นลูกค้าเก่า — ตรวจแล้วไม่ใช่คนเดียวกัน
  // จึงต้องถอนคืนพร้อมเปิด AI; ป้ายที่คนติดเองห้ามแตะเด็ดขาด (ไม่มีโน้ตของระบบ = ไม่ใช่ของเรา)
  if (customer.ai_off_reason === CUSTOMER_HANDOVER_REASON && autoCustomerTagAddedBySystem(db, customerId)) {
    db.removeTag(customerId, AUTO_CUSTOMER_TAG);
    db.setAiEnabled(customerId, true);
    db.addAudit({
      operator: String(operator || "team").slice(0, 80), action: `${LEGACY_AUTO_CUSTOMER_AUDIT}_undo`,
      target: customerId, detail: "ปฏิเสธ candidate — ถอนป้าย customer ที่ระบบติดให้ และเปิด AI คืน",
    });
  } else if (LEGACY_PAUSE_REASONS.has(String(customer.ai_off_reason || ""))
      && canAutoEnableAi(customer, { expectReason: customer.ai_off_reason })) {
    db.setAiEnabled(customerId, true); // ห้องค้างจากนโยบายเดิมเท่านั้น
  }
  db.setLegacyLink(customerId, "rejected");
  db.addHandoffNote({
    customerId, author: String(operator || "team").slice(0, 80),
    text: "ตรวจแล้วไม่ใช่คนเดียวกับห้องระบบเก่าที่ชื่อเหมือนกัน — ไม่คัดลอกข้อมูลและยกเลิก candidate",
  });
  return { state: "rejected", customer: db.getCustomer(customerId) };
}
