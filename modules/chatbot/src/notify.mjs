// notify.mjs — v1.1 (พี่ง้วงสั่ง 2026-08-10, bug 5): push แจ้งทีมงานทาง LINE
// เมื่อลูกค้า "ต้องการคนจริง" — ถามว่าเป็นบอท, ร้องเรียน, หรือเคสฉุกเฉิน
//
// กติกา:
// - ผู้รับ = LINE user id ต่อสาขา (settings `escalate_notify:<channelId>`, แก้จาก console)
//   ไม่มีค่าในตาราง = fallback env ESCALATE_NOTIFY_IDS — ไม่มีทั้งคู่ = ปิดสนิท (fail-closed)
// - ทุกการแจ้งนับเป็น push message 1 คน ต่อ 1 ข้อความ (มีผลกับโควตา OA — บอกไว้ใน UI)
// - cooldown ต่อลูกค้า 10 นาที กันแจ้งรัว ๆ จาก burst เดียวกัน (in-memory — restart รีเซ็ต)
// - fire-and-forget ล้วน ๆ: ล้มเหลว = log เงียบ ห้ามกระทบเส้นทางตอบลูกค้าเด็ดขาด

import { DEFAULT_CHANNEL_ID } from "./channels.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
import { activeBrand, brandText, isGenericProfile } from "./brand.mjs";
export const NOTIFY_COOLDOWN_MS = 10 * 60_000;
export const NOTIFY_KEY_PREFIX = "escalate_notify:";
export const NOTIFY_MAX_RECIPIENTS = 10;

// เหตุที่ควรปลุกคน — v1.4.5 (คำสั่งพี่ง้วง 2026-08-15): จังหวะชำระเงินต้อง push แจ้ง
// ทันที ("รายละเอียดให้โอนเข้ามาที่ชมพู่ push message พี่ง้วงก่อนตอนนี้") — เดิมจงใจ
// ไม่แจ้ง payment_review เพราะกลัวแจ้งรัว แต่มี cooldown 10 นาที/ลูกค้า คุมอยู่แล้ว
// และเส้นเงินคือจังหวะที่พลาดไม่ได้ที่สุดของธุรกิจ high-ticket
export const NOTIFY_REASON_TEXT = Object.freeze({
  file_review: "ลูกค้าส่งไฟล์แนบ — AI หยุดรอทีมเปิดตรวจไฟล์ในแชท ยังไม่ได้ยืนยันว่าเป็นเอกสารชำระเงิน",
  identity_question: "ถามว่าคุยกับบอทหรือคน — ระบบตอบเปิดเผยแล้ว และเสนอโอนต่อทีมงาน",
  complaint: "ไม่พอใจ/ร้องเรียน — AI หยุดขายแล้ว รอคนจริงดูแลต่อ",
  urgent_medical: "แจ้งอาการเสี่ยงฉุกเฉิน — ระบบแนะนำ 1669 แล้ว ต้องมีคนตามต่อทันที",
  urgent_mental: "พบสัญญาณวิกฤตสุขภาพจิต — ระบบแนะนำสายด่วน 1323 และปิด AI แล้ว ต้องมีคนตามต่อทันที",
  payment_review: "ถึงจังหวะชำระเงิน/ส่งสลิป — AI พักแล้ว ต้องมีคนจริงตรวจยอดและยืนยันเอง",
  image_review: "ส่งรูปเข้ามา (อาจเป็นสลิป/เอกสาร) — ระบบไม่อ่านรูปเอง ต้องมีคนจริงเปิดตรวจ",
  // เฟส 1b: มีคนแก้ข้อมูลตั้งต้นของ AI แล้วด่านตอบว่า "สมองยังมีข้อค้างที่ต้องรับทราบก่อน"
  // คนที่กดอาจไม่มีสิทธิ์รับทราบเอง — ไม่ปลุกเจ้าของ = ของค้างอยู่ในที่ที่ไม่มีใครเห็น
  brain_needs_ack: "มีการแก้ข้อมูลตั้งต้นของลูกแพร แต่สมองยังมีข้อค้างที่ต้องรับทราบก่อนใช้งาน",
  // v1.4.11 (คำสั่งพี่ง้วง 2026-08-18): สองเหตุใหม่ที่ AI ปิดถาวรรอคนจริง
  human_requested: "ลูกค้าขอคุยกับคนจริง — AI หยุดตอบถาวรแล้ว รอแอดมินเข้ามาดูแลในแชทนี้",
  // F4b (ตรวจย้อนหลัง ก.ย. 2026): ลูกค้าพิมพ์ "ไม่ต้องตอบกลับแล้ว" — ลูกแพรหยุดเงียบ ไม่ส่งอะไรเลย
  customer_asked_quiet: "ลูกค้าขอให้หยุดตอบ — ลูกแพรหยุดทันทีโดยไม่ส่งข้อความใด ๆ และปิด AI ห้องนี้แล้ว รบกวนทีมงานอ่านแชทว่าลูกค้าติดเรื่องไหน แล้วตัดสินใจว่าจะทักเองหรือปล่อยไว้",
  // คำสั่งพี่ง้วง 2026-09-05: กลับข้อยกเว้น v1.4.11 — ห้องที่ส่งต่อคนแล้วต้องไม่มี
  // ข้อความอัตโนมัติตามไปอีกเลย รวมถึง follow-up ทวงโอนที่เคยได้รับอนุญาตไว้
  bank_sent: "ส่งเลขบัญชี/สรุปยอดให้ลูกค้าแล้ว — AI หยุดตอบถาวร follow-up หยุดแล้ว ชมพู่ดูแลต่อในแชทนี้",
  // คำสั่งพี่ง้วง 2026-09-05: ลูกค้าตัดสินใจจอง/สมัคร = ลูกแพรตอบรับข้อความสุดท้ายแล้วเงียบ
  // 2026-10-15 (พี่ง้วง): ปุ่ม YOLO "ส่งต่อแอดมิน" — ข้อความจริงส่งผ่าน reasonTextOverride (ใครส่ง · AI เปิด/ปิด ·
  // ข้อความที่ส่งลูกค้า) บรรทัดนี้เป็นค่าเริ่มต้นกันพลาด และทำให้ reason นี้ผ่านด่าน "reason ที่แจ้งได้"
  owner_handoff: "ถูกส่งต่อให้แอดมินจากปุ่ม YOLO — รบกวนเข้าไปดูแลต่อในแชทนี้",
  booking_handoff: "ลูกค้าขอจอง/สมัครแล้ว — ลูกแพรตอบรับและหยุดตอบถาวรแล้ว รบกวนชมพู่เข้าไปยืนยันที่นั่งและขั้นตอนต่อในแชทนี้",
  // v1.4.26 (คำสั่งพี่ง้วง 2026-08-19): บอทรับปากว่า "ทีมงานจะดูแล/ติดต่อกลับ" แต่ระบบ
  // ไม่ได้เปิดเคสให้ใครเลย 10% ของครั้งที่พูด — ลูกค้ารอเก้อโดยไม่มีใครรู้
  // v1.4.32: เตือน ops เมื่อตารางรอบเรียนใกล้หมด — ส่งข้อความเองผ่าน reasonTextOverride
  // ใส่ไว้ที่นี่เพื่อให้ยังผ่านด่าน "reason ที่แจ้งได้" (ไม่ใช่ทุก reason ยิงหาคนได้)
  // v1.4.45: สมองล่ม = ลูกค้าเจอความเงียบตั้งแต่เทิร์นที่สาม (pipeline.mjs:1750)
  // เดิมปักธงใน DB อย่างเดียว ไม่มีใครรู้จนกว่าจะเปิด console = ยิ่งพังหนัก ยิ่งเงียบ
  hermes_down: "สมองของลูกแพรไม่ตอบ — ลูกค้าจะเริ่มไม่ได้รับคำตอบ ต้องมีคนเข้าไปดูแลแชทแทนทันที",
  rounds_low: "ตารางรอบเรียนใกล้หมด — ต้องประกาศรอบใหม่ ไม่งั้นลูกแพรจะตอบลูกค้าว่ายังไม่ประกาศ",
  // 18 ต.ค. 2026 (audit ลูกแพร): ขั้นชำระเงินที่ระบบประกอบเอง — ข้อความจริงส่งผ่าน reasonTextOverride บรรทัดนี้กันพลาด
  payment_step_manual: "ลูกค้าแจ้งประเภทเอกสารแล้ว แต่ระบบประกอบสรุปยอดและช่องทางชำระเองไม่ได้ — รบกวนทีมส่งให้ในแชทนี้",
  payment_step_stalled: "มีห้องตอบเรื่องออกเอกสารแล้ว แต่ระบบส่งช่องทางชำระ 0 ครั้งใน 2 วัน — ต้องตรวจขั้นชำระเงินของลูกแพร",
  promise_team_followup: "ลูกแพรรับปากว่าทีมงานจะดูแล/ติดต่อกลับ — ต้องมีคนจริงตามเรื่องนี้ให้จบ (AI ยังคุยต่อให้อยู่ ไม่ได้ปิดแชท)",
  // v1.4.37: คำสัญญาที่ลูกแพรพูดในนามตัวเอง (ล็อกที่นั่ง/ออกใบเสนอราคา) ไม่มีระบบรองรับเลย
  // จึงเร่งด่วนกว่าแบบ "ทีมงานจะติดต่อกลับ" ที่อย่างน้อยมีคนอยู่ปลายทาง
  // 2026-09-02: ห้อง candidate ระบบเก่าไม่เงียบอีกแล้ว ทีมจึงต้องรู้เองว่ามีห้องรอเทียบตัวตน
  legacy_candidate: "ชื่อ LINE ตรงกับห้องลูกค้าระบบเก่า — AI คุยต่อแบบลูกค้าใหม่ไปก่อน (ไม่อ้างประวัติเก่า) รบกวนทีมงานเข้าไปกดยืนยันหรือปฏิเสธการโยงในแผงข้อมูลลูกค้า",
  // ห้องระบบเก่ามีป้าย "ลงทะเบียนแล้ว"/ลูกค้า = คนนี้ซื้อจบไปแล้ว บอทต้องเงียบ ไม่ใช่ขายซ้ำ
  legacy_registered_customer: "ชื่อ LINE ตรงกับห้องลูกค้าเก่าที่ลงทะเบียนแล้ว — ระบบติดป้าย customer และปิด AI ให้แล้ว รบกวนทีมงานเข้าไปตอบเอง (ถ้าไม่ใช่คนเดียวกัน กดปฏิเสธการโยงเพื่อเปิด AI คืน)",
  // ข้อความที่ค้างตั้งแต่ห้องยังถูกพักไว้ และระบบตอบให้เองไม่ได้
  legacy_pending_reply: "มีข้อความค้างระหว่างรอยืนยันตัวตน — ระบบตอบให้เองไม่ได้ ต้องมีคนเข้าไปตอบในแชทนี้",
  promise_self_action: "ลูกแพรบอกลูกค้าว่า 'ล็อกที่นั่ง/ออกใบเสนอราคาให้แล้ว' — ระบบไม่มีตัวทำให้ ต้องมีคนจริงทำเดี๋ยวนี้ (AI ยังคุยต่อให้อยู่)",
  // Package K (2 ก.ย. 2026): ทีมงานส่งคำขอเปลี่ยนของที่เข้าสมองลูกแพร แล้วรอเจ้าของกดอนุมัติ
  // ข้อความจริงส่งผ่าน reasonTextOverride (มีหัวข้อคำขอ + จำนวนที่ค้าง) — บรรทัดนี้เป็น
  // ค่าเริ่มต้นกันพลาด และเป็นสิ่งที่ทำให้ reason นี้ผ่านด่าน "reason ที่แจ้งได้"
  publish_request: "มีคำขอเปลี่ยนข้อมูลตั้งต้นของลูกแพรรออนุมัติ — เปิดหน้าตั้งค่าเพื่อกดอนุมัติหรือปฏิเสธ",
  // Phase 1a (3 ก.ย. 2026): ตัวเฝ้าสมองเงา (src/brain/parityWatch.mjs) ส่งข้อความจริงผ่าน
  // reasonTextOverride (มีชื่อ "ส่วนที่ต่าง" อยู่ในนั้น) — บรรทัดนี้เป็นค่าเริ่มต้นกันพลาด
  // และเป็นสิ่งที่ทำให้ reason นี้ผ่านด่าน "reason ที่แจ้งได้"
  brain_parity_drift: "สมองเงาไม่ตรงกับตารางที่ระบบใช้จริง — ยังไม่กระทบลูกค้า แต่ต้องตรวจก่อนเปิดให้สมองอ่านจริง",
  // Phase 2 (3 ก.ย. 2026): ทางอ่านสมองล้มติดกันหลายเทิร์น — ลูกค้ายังได้คำตอบ (ตกกลับ
  // ตารางเดิมทุกเทิร์น) แต่การแก้ข้อมูลรุ่นใหม่ไม่มีผลเลย ซึ่งเป็นความล้มเหลวที่เงียบที่สุด
  // ข้อความจริงส่งผ่าน reasonTextOverride (มีจำนวนเทิร์นที่ตก) — บรรทัดนี้กันพลาด
  brain_read_fallback: "ลูกแพรอ่านสมองที่มีเวอร์ชันไม่ได้ ระบบตกกลับไปอ่านตารางเดิมให้แล้ว — ลูกค้ายังได้คำตอบ แต่ต้องมีคนตรวจ",
  // deploy ถูก auto-revert หลังมีการเผยแพร่รุ่นใหม่ = โค้ดเก่ากับสมองใหม่ไม่เข้ากัน
  // ระบบถอยไปรุ่นที่โหลดได้เองแล้ว แต่ "การแก้ล่าสุดยังไม่ถึงลูกค้า" ต้องมีคนรู้
  brain_contract_fallback: "สมองรุ่นล่าสุดต้องใช้โค้ดที่ยังไม่ได้ deploy — ระบบถอยไปใช้รุ่นเก่าให้แล้ว การแก้ล่าสุดยังไม่ถึงลูกค้า",
  // ห้องที่กำลังคุยเรื่องเงินอยู่ แล้วรุ่นสมอง (และตารางราคา) ที่ห้องนั้นใช้เปลี่ยนกลางทาง
  brain_version_switch: "ห้องนี้ได้ราคาจากสมองรุ่นก่อน แล้วรุ่นเปลี่ยนกลางการคุยเรื่องเงิน — ต้องมีคนจริงยืนยันตัวเลขกับลูกค้าก่อนปิดการขาย",
  // v1.5.x (บั๊กจริง 3 ก.ย. 2026): ห้องที่ส่งต่องาน project ไปแล้ว AI ปิดสนิท ลูกค้าที่ตอบ
  // ต่อ (บ่อยที่สุดคือ "เบอร์" ที่บอทเพิ่งขอไปในข้อความเดียวกับที่ปิด) ตกลงไปในความเงียบ
  // ping ส่งต่อยิงไปแล้วรอบหนึ่งก่อนหน้านี้ ทีมงานจึงไม่มีอะไรบอกว่ามีข้อมูลใหม่เข้ามา
  // ยิงครั้งเดียวต่อหนึ่งการส่งต่อ — ข้อความถัดไปของลูกค้าไม่ต้องปลุกซ้ำ
  opportunity_handoff_reply: "ลูกค้าตอบกลับมาหลังส่งต่อให้ทีมงานแล้ว — AI ปิดอยู่ ไม่มีใครตอบให้ ต้องเปิดห้องแชทอ่านและตอบเอง",
  // F14 (ตรวจย้อนหลัง ก.ย. 2026): คำขอที่มาถึงระหว่าง AI พัก (ไม่มีคนจริงอยู่ในห้อง) เคยถูกกลืนเงียบ
  paused_contact_request: "ลูกค้าขอติดต่อทีมงาน/ขอจองระหว่างที่ AI พักอยู่ — ลูกแพรยังไม่ได้ตอบ และยังไม่มีใครตอบ รบกวนเข้าไปตอบในแชทนี้",
  // 28 ก.ย. 2026 (พี่ง้วง: ลูกค้าจาก Facebook ย้ายมา LINE แล้วลูกแพรจำไม่ได้): ข้อความจริงส่งผ่าน reasonTextOverride
  // (identityLink.mjs บอกว่าซื้อแล้วหรือยัง + ชื่อฝั่ง Facebook) — สองบรรทัดนี้เป็นค่าเริ่มต้นกันพลาด
  identity_linked: "ลูกค้าเดิมจาก Facebook เข้ามาทาง LINE แล้ว — เชื่อมห้องให้แล้ว เปิดห้อง LINE นี้เพื่อดูแลต่อ",
  identity_link_review: "ลูกค้าส่งรหัสเชื่อมแชทจาก Facebook ที่ใช้ไม่ได้ — ถ้าเป็นลูกค้าเดิม เชื่อมเองได้ในแผงช่องทางอื่นของห้องนี้",
  // 30 ก.ย. 2026: ห้อง LINE ใหม่ไม่ส่งรหัส แต่มีลิงก์เชิญจาก Facebook ที่ยังไม่ใช้ในช่วงนั้น (identityLinkHints.mjs — ข้อความจริงส่งผ่าน override)
  identity_link_candidate: "เพิ่งแอดไลน์แต่ยังไม่ได้ส่งรหัสเชื่อมแชท — อาจเป็นลูกค้า Facebook ที่เราส่งลิงก์ไป เปิดห้องนี้แล้วดูรายการแนะนำในแผงช่องทางอื่น",
});

// F15 (ตรวจย้อนหลัง ก.ย. 2026): push ก้ำกึ่ง 75 ครั้งยิงตอนที่คนจริงเพิ่งพิมพ์ในห้องนั้นเอง — คำรับปากของบอท
// ห้องรอเทียบตัวตนระบบเก่า รูปในห้องที่ไม่มีเรื่องเงิน ลูกค้าตอบหลังส่งต่อ — ทีมชินกับเสียงเตือนจนของสำคัญจม
// เหตุกลุ่มนี้ (ไม่ใช่เงิน/ร้องเรียน/ขอคน/ฉุกเฉิน): คนจริงส่งข้อความในห้องภายใน 10 นาที = คนอยู่หน้าห้องแล้ว
// ไม่ปลุกซ้ำ (ทะลุ force ด้วย เพราะคนเห็นเองอยู่แล้ว) · คิวรอคน/โน้ต/บันได SLA ยังอยู่ครบ
// รูป: ห้องที่มีธงเงินแล้ว (อาจเป็นสลิป) ยิงเสมอ — เงินต้องเป็นของคนจริงทุกครั้ง
// White-label: โปรไฟล์ generic ไม่มี "ที่นั่ง/รอบเรียน" — ถ้อยคำกลางสำหรับร้านทั่วไป
const NOTIFY_REASON_TEXT_GENERIC = Object.freeze({
  booking_handoff: "ลูกค้าขอสั่งซื้อ/จองแล้ว — ลูกแพรตอบรับและหยุดตอบถาวรแล้ว รบกวนทีมงานเข้าไปยืนยันรายการและขั้นตอนต่อในแชทนี้",
  promise_self_action: "ลูกแพรบอกลูกค้าว่าจัดการ/จองให้แล้ว — ระบบไม่มีตัวทำให้ ต้องมีคนจริงทำเดี๋ยวนี้ (AI ยังคุยต่อให้อยู่)",
});

/** ข้อความเหตุผลของการแจ้งทีม (ตามแบรนด์) — แบรนด์เริ่มต้น = NOTIFY_REASON_TEXT เดิมทุกตัวอักษร */
export function notifyReasonText(reason, brand = activeBrand()) {
  const base = (isGenericProfile(brand) && NOTIFY_REASON_TEXT_GENERIC[reason]) || NOTIFY_REASON_TEXT[reason];
  return base ? brandText(base, brand) : base;
}

export const HUMAN_ACTIVE_WINDOW_MS = 10 * 60_000;
export const HUMAN_ACTIVE_DEDUP_REASONS = Object.freeze([
  "promise_team_followup", "legacy_candidate", "image_review", "opportunity_handoff_reply", "customer_asked_quiet",
]);
const HUMAN_ACTIVE_DEDUP = new Set(HUMAN_ACTIVE_DEDUP_REASONS);

/** คนจริงเพิ่งตอบในห้องนี้ภายในกี่มิลลิวินาที — null = ไม่ต้องข้าม (เหตุนอกกลุ่ม/ห้องเงิน/ไม่มีคนตอบ) */
function humanActiveAgoMs(db, customerId, reason, now = Date.now()) {
  if (!HUMAN_ACTIVE_DEDUP.has(reason) || String(customerId).startsWith("ops:")) return null;
  if (reason === "image_review" && Number(db.getCustomer?.(customerId)?.money_seen_at || 0) > 0) return null;
  const last = Number(db.lastOperatorOutboundAt?.(customerId) || 0);
  if (!last) return null;
  const ago = now - last;
  return ago >= 0 && ago < HUMAN_ACTIVE_WINDOW_MS ? ago : null;
}

const LINE_USER_ID_PATTERN = /^U[0-9a-f]{32}$/;

export function validNotifyIds(raw) {
  if (!Array.isArray(raw)) return null;
  const ids = [...new Set(raw.map((v) => String(v || "").trim()).filter(Boolean))];
  if (ids.length > NOTIFY_MAX_RECIPIENTS) return null;
  return ids.every((id) => LINE_USER_ID_PATTERN.test(id)) ? ids : null;
}

// ผู้รับของสาขานี้ — settings ต่อสาขาชนะ env; พังทุกกรณี = [] (ปิด)
export function notifyIdsFor(db, channelId, config = {}) {
  try {
    const raw = db.getSetting(NOTIFY_KEY_PREFIX + (channelId || "default"));
    if (raw !== null && raw !== undefined && raw !== "") {
      const ids = validNotifyIds(JSON.parse(raw));
      if (ids) return ids; // [] ที่ตั้งใจเซฟไว้ = ปิดของสาขานี้ (ชนะ env)
    }
  } catch { /* ค่าใน DB พัง -> ใช้ env */ }
  return validNotifyIds(config.escalateNotifyIds || []) || [];
}

export function createEscalationNotifier({ db, config = {}, line = null, lineRegistry = null, logger = console }) {
  const lastSent = new Map(); // customerId + recipient -> provider accepted timestamp
  const inFlight = new Map();

  // reasonTextOverride: กฎฉุกเฉินเฉพาะธุรกิจ (reason อิสระจาก SAFETY_RULES_FILE) ส่งข้อความเอง
  // force: เหตุที่ยิงได้ครั้งเดียวตลอดชีพ (เช่น opportunity handoff ที่กันซ้ำด้วย
  // fingerprint แล้ว) — ถ้าปล่อยให้ cooldown กลืน จะไม่มีรอบสองให้แจ้งอีกเลย
  async function fire({ customerId, channelId = "default", reason, customerName = "", reasonTextOverride = "", force = false }) {
    try {
      if (String(customerId).startsWith("canary:")) return { skipped: "canary" };
      const reasonText = reasonTextOverride || notifyReasonText(reason);
      if (!reasonText) return { skipped: "reason_not_notifiable" };
      // 28 ก.ย. 2026: ห้องที่ทีมย้ายไปสแปม (ป้าย null) ไม่ปลุกทีม — ยกเว้นสัญญาณวิกฤตสุขภาพจิต
      // (ความปลอดภัยของคนมาก่อนการคัดห้อง กดสแปมผิดคนต้องไม่ทำให้เคสวิกฤตเงียบ) · อ่านป้ายไม่ได้ = แจ้งตามเดิม
      if (reason !== "urgent_mental") {
        let spam = false;
        try { spam = db.isSpamCustomer?.(customerId) === true; } catch { spam = false; }
        if (spam) return { skipped: "spam" };
      }
      const humanAgo = humanActiveAgoMs(db, customerId, reason);
      if (humanAgo !== null) {
        db.addAudit({
          operator: "system", action: "escalate_notify_skipped", target: customerId,
          detail: `${reason} — คนจริงตอบในห้องนี้เมื่อ ${Math.max(1, Math.round(humanAgo / 60_000))} นาทีก่อน ไม่ปลุกทีมซ้ำ (F15)`,
        });
        return { skipped: "human_active" };
      }
      const ids = notifyIdsFor(db, channelId, config);
      if (!ids.length) return { skipped: "no_recipients" };
      const recipientKey = (id) => JSON.stringify([customerId, id]);
      const eligible = ids.filter((id) => force || !lastSent.has(recipientKey(id))
        || Date.now() - lastSent.get(recipientKey(id)) >= NOTIFY_COOLDOWN_MS);
      if (!eligible.length) return { skipped: "cooldown" };

      // ผู้รับแจ้งเตือนทุกคนเป็น LINE user id (validNotifyIds บังคับรูปแบบไว้) — ห้องที่อยู่บน
      // Facebook จึงส่งผ่าน client ของ Messenger ไม่ได้เลย เพราะ id คนละ namespace
      // ของจริง 28 ส.ค.–1 ก.ย. 2026: เคส Facebook แจ้งไม่ถึงใครเลย 5 จาก 5 ครั้ง
      // (รวม payment_review ตอนลูกค้าแจ้งโอนเงิน และ promise_team_followup อีก 4 ครั้ง
      //  ที่บอทรับปากลูกค้าว่าทีมงานจะติดต่อกลับ) audit บันทึกไว้ว่า "0/2 คน" ทุกครั้ง
      // คำสั่งพี่ง้วง 1 ก.ย. 2026: ให้ push ออกทาง LINE OA เหมือนเดิมเสมอ แล้วบอกในข้อความ
      // ว่าเคสมาจาก Facebook — สาขา LINE อื่นยังใช้ OA ของสาขาตัวเองเหมือนเดิม
      const sourceChannel = lineRegistry?.channels?.find((ch) => ch.id === channelId) ?? null;
      const foreignTransport = sourceChannel?.provider === "facebook";
      const lineCh = lineRegistry
        ? lineRegistry.forChannel(foreignTransport ? DEFAULT_CHANNEL_ID : channelId)
        : line;
      if (!lineCh) return { skipped: "no_line_client" };
      // คนอ่านต้องรู้ทันทีว่าต้องไปเปิดห้องฝั่งไหน ไม่งั้นเสียเวลาหาผิดที่
      const sourceLine = foreignTransport
        ? `\n📮 เคสจาก ${sourceChannel?.name || "Facebook"}`
        : "";
      // REVIEW FIX: display name มาจากโปรไฟล์ LINE ที่ลูกค้าตั้งเอง — ห้ามให้แทรกบรรทัด/
      // ปลอมเป็นเสียงระบบในข้อความแจ้งทีม: ยุบ whitespace + จำกัดความยาวก่อนเสมอ
      const rawName = String(customerName || "").replace(/\s+/g, " ").trim().slice(0, 50);
      const name = rawName || `ลูกค้า ${String(customerId).slice(-6)}`;
      // v1.4.32: บางเหตุเป็นเรื่องระบบ ไม่ได้ผูกกับลูกค้าคนไหน (เช่น ตารางรอบเรียนใกล้หมด)
      // ถ้าใช้ข้อความทรงเดียวกันจะได้ "คุณลูกค้า rounds ตารางรอบเรียนใกล้หมด" ซึ่งอ่านไม่รู้เรื่อง
      // และทำให้คนอ่านสับสนว่าต้องไปเปิดแชทของใคร
      // v1.4.49 (คำสั่งเจ้าของ 2026-08-29): แจ้งเตือนต้องกดเข้าห้องได้เลย ไม่ใช่บอกให้ไปเปิดเอง
      const roomLink = !String(customerId).startsWith("ops:") && config.consolePublicBaseUrl
        ? `\n👉 ${config.consolePublicBaseUrl}/#/c/${encodeURIComponent(String(customerId))}`
        : "";
      const text = String(customerId).startsWith("ops:")
        ? `🔔 แจ้งจากระบบ Front Desk${sourceLine}\n${reasonText}`
        : `🔔 แจ้งจากระบบ Front Desk${sourceLine}\nคุณ${name} ${reasonText}${roomLink || "\n\nเปิดหน้าแชทใน console เพื่อรับช่วงต่อได้เลยค่ะ"}`;
      let sent = 0;
      let attempted = 0;
      for (const id of eligible) {
        const key = recipientKey(id);
        if (!force && lastSent.has(key) && Date.now() - lastSent.get(key) < NOTIFY_COOLDOWN_MS) continue;
        // Forced one-shot handoffs must not disappear behind another notice.
        if (!force && inFlight.has(key)) continue;
        inFlight.set(key, (inFlight.get(key) || 0) + 1);
        attempted += 1;
        try {
          // 28 ก.ย. 2026: ติดป้าย team_alert — push ถึงทีมนับโควตา LINE ทีละคน (การ์ด "LINE OA เดือนนี้")
          const result = await lineCh.sendBubbles({ to: id, bubbles: [{ text }], images: [], purpose: SEND_PURPOSE.teamAlert });
          if (result?.ok) {
            sent += 1;
            lastSent.set(key, Date.now());
          }
        } catch (err) {
          // One unavailable recipient must not swallow the rest of the team.
          // Never log provider payloads/URLs that may carry credentials or PII.
          logger.debug?.(`notify: recipient send failed (${err?.name || "Error"})`);
        } finally {
          const remaining = inFlight.get(key) - 1;
          if (remaining) inFlight.set(key, remaining);
          else inFlight.delete(key);
        }
      }
      if (!attempted) return { skipped: "in_flight" };
      db.addAudit({
        operator: "system", action: "escalate_notify", target: customerId,
        detail: `${reason} — push แจ้งทีม ${sent}/${ids.length} คน · พยายาม ${attempted} คน`,
      });
      return { ok: sent === attempted, sent, total: ids.length };
    } catch (err) {
      logger.debug?.(`notify: แจ้งทีมไม่สำเร็จ (${err?.message || err}) — ไม่มีผลกับแชท`);
      return { skipped: "error" };
    }
  }

  // fire-and-forget wrapper — ให้เส้นทาง reply จบก่อนเสมอ
  function fireLater(args) {
    setTimeout(() => {
      fire(args).catch((err) => logger.debug?.(`notify: ${err?.message || err}`));
    }, 0);
  }

  return { fire, fireLater };
}
