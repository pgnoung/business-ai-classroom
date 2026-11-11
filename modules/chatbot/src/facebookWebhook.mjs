// facebookWebhook.mjs — ขาเข้า Facebook Messenger (v1.5, คำสั่งเจ้าของ 2026-08-30)
//
// คำสั่งเจ้าของ 3 ข้อที่ไฟล์นี้ถือเป็นกฎหมาย:
// 1. "เริ่มสำหรับคนที่ทักมาใหม่เท่านั้น ป้องกันแชทมั่ว" — ระบบไม่ import ประวัติ
//    ทุก PSID ที่เห็นครั้งแรกคือแชทใหม่โดยโครงสร้าง (ด่าน 20-ข้อความของ Meta กลายเป็นข้อดี)
// 2. "ลูกค้าเก่า (Lead Center สร้าง conversion แล้ว) ชมพู่คุยอย่างเดียวเท่านั้น" —
//    เกตรายชื่อด้านล่าง + fail-closed: ดึงชื่อโปรไฟล์ไม่ได้ = กันไว้ก่อน ไม่ใช่ปล่อยผ่าน
// 3. แอดมินตอบจาก Business Suite เมื่อไหร่ บอทหลบห้องนั้น (echo ที่ไม่ใช่ของเรา)
//    — 2026-09-02 เจ้าของเปลี่ยนจาก "ถาวร" เป็น "พัก 15 นาที ต่ออายุทุกครั้งที่ตอบ"
//    เท่ากับการตอบจากคอนโซล เพราะของเดิมทิ้งห้างร้างไว้จนไม่มีใครกลับไปเปิด
//
// โครง event ของ Meta: POST body = { object:"page", entry:[{ messaging:[event...] }] }
// ทุก event ถูกแปลงเป็นรูป LINE ก่อนเข้า pipeline — pipeline ไม่ต้องรู้จัก FB เลย
import { verifyFacebookSignature, FB_OUTBOUND_METADATA } from "./facebookClient.mjs";
import { customerKey, FACEBOOK_CHANNEL_ID } from "./channels.mjs";
import { flagNeedsHumanForTurn, stampInboundOutcome } from "./inboundOutcome.mjs";
import { OPERATOR_PAUSE_MS, canAutoEnableAi, pauseAiForHumanReply } from "./aiPausePolicy.mjs";
// 6 ต.ค. 2026: จดว่าห้องมาจากแอดไหน (referral ของ Meta) — จดอย่างเดียว ไม่แตะการตอบ (adReferral.mjs)
import { captureAdReferral } from "./adReferral.mjs";
import { isAdGreetingEcho } from "./fbAdGreeting.mjs";

// operator ของข้อความที่แอดมินพิมพ์จาก Business Suite (เห็นใน console + audit)
export const FB_HUMAN_OPERATOR = "Facebook Page (ทีม)";
export const FB_KNOWN_CUSTOMERS_KEY = "fb_known_customers";
export const AI_OFF_FB_LEGACY = "fb_legacy_customer";
export const AI_OFF_FB_UNVERIFIED = "fb_name_unverified";
// เหตุผลปิด AI แบบ "ชั่วคราว ระบบปลดเองได้" — ต่างจากสองอันบนที่ปลดด้วยมือคนเท่านั้น
export const AI_OFF_FB_GATE_PENDING = "fb_gate_pending";
export const FB_LEGACY_TAG = "ลูกค้าเก่า-ทีมดูแล";
// รอดึงชื่อโปรไฟล์ก่อนตัดสิน AI on/off — สั้นกว่า BURST_DEBOUNCE_MS (10s) มาก
// จึงไม่ทำให้การตอบช้าลง แม้ block จริงระหว่างรอ
const PROFILE_GATE_TIMEOUT_MS = 8_000;

// เทียบชื่อแบบทน噪: ตัดช่องว่าง/ตัวพิมพ์ — "สมชาย ใจดี" ต้องเจอ "สมชาย  ใจดี"
// จงใจไม่ทำ fuzzy เกินนี้ (substring สองทาง) — เหวี่ยงแหกว้างจะปิด AI ใส่ลีดผิดคน
const normalizeName = (value) => String(value || "").toLowerCase().replace(/\s+/gu, " ").trim();

// ---- เคสจริง 2026-09-05 (เส้นเงินพัง): ปุ่ม 👍 ของ Messenger ปิดห้องลูกค้าถาวร ----
//
// ไล่ขาเข้า Facebook 14 วันย้อนหลัง: "รูป" 19 ใบ มี 7 ใบเป็นไฟล์ JPEG ก้อนเดียวกันเป๊ะ
// (1,678 ไบต์) จาก CDN สติกเกอร์ของ Facebook (path /t39.1997-6/) และอีก 1 ใบเป็น webp
// 3,333 ไบต์จาก path เดียวกัน — นั่นคือ "ปุ่มไลก์" กับสติกเกอร์ ไม่ใช่รูปที่ลูกค้าตั้งใจส่ง
//
// Messenger ส่งของพวกนี้มาเป็น attachments[0].type === "image" เหมือนรูปถ่ายทุกประการ
// ต่างกันแค่มี payload.sticker_id ติดมาด้วย (นิ้วโป้ง: 369239263222822 / 369239343222814 /
// 369239383222810) โค้ดเดิมอ่านแค่ type จึงแปลงเป็น msgType "image" ทุกใบ แล้วไปป์ไลน์
// พาเข้าเส้นเงินแบบ fail-closed: ปิด AI ถาวร + ปักธงเงิน + ไม่ตอบอะไรเลย
// => ลูกค้าแค่กดไลก์ข้อความสุดท้ายของลูกแพร ห้องก็ตายทันทีโดยไม่มีใครรู้
//
// กติกา: sticker_id มีค่าเมื่อไหร่ = สติกเกอร์เสมอ (ไม่สนใจค่า) — Meta ไม่ใส่ฟิลด์นี้ให้รูปถ่าย
// ส่วน path CDN เป็นด่านที่สอง เผื่อ payload ไม่มี sticker_id (พบจริง: webp 3,333 ไบต์ใบนั้น)
// รูปถ่ายจริงของลูกค้ามาจาก path คนละชุด (/t1.15752-9/, /v/t1/...) จึงไม่ชนกัน
const FB_STICKER_ID_KEY = "sticker_id";
export const FB_STICKER_CDN_PATH = /\/t39\.1997-6\//u;

/** true = attachment ใบนี้คือสติกเกอร์/ปุ่มไลก์ ไม่ใช่รูปที่ต้องเข้าเส้นเงิน */
export function isStickerAttachment(attachment) {
  const payload = attachment?.payload;
  if (payload && typeof payload === "object" && FB_STICKER_ID_KEY in payload) {
    const id = payload[FB_STICKER_ID_KEY];
    if (id !== null && id !== undefined && String(id) !== "") return true;
  }
  if (String(attachment?.type || "") !== "image") return false;
  // path เท่านั้น — query string ของ Meta มีพารามิเตอร์สารพัด อย่าให้บังเอิญไปตรงคำ
  const raw = String(payload?.url || "");
  if (!raw) return false;
  try {
    return FB_STICKER_CDN_PATH.test(new URL(raw).pathname);
  } catch {
    return FB_STICKER_CDN_PATH.test(raw.split("?")[0]);
  }
}

export function loadKnownCustomers(db) {
  try {
    const parsed = JSON.parse(db.getSetting(FB_KNOWN_CUSTOMERS_KEY) || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeName).filter(Boolean);
  } catch {
    return [];
  }
}

export function matchKnownCustomer(displayName, knownList) {
  const name = normalizeName(displayName);
  if (!name) return false;
  return knownList.some((known) => name === known || name.includes(known) || known.includes(name));
}

export function createFacebookWebhook({
  config, db, pipeline, lineRegistry, notifier = null, webPush = null,
  readBody, json, logger = console,
  processId = "", isDraining = () => false, requestMediaIngest = () => {},
  // 28 ก.ย. 2026: รหัสเพจจาก entry.id — ลิงก์ "เปิดห้องนี้ใน Business Suite" ไม่ต้องรอถาม Graph (businessSuiteLink.mjs)
  learnPageId = () => {},
  // 6 ต.ค. 2026 ค่ำ: จดที่มาจากแอดได้แล้ว → ปลุกตัวเก็บรูปแอด (adThumbs.mjs) · ต้องคืนทันที ห้ามขวางเส้นรับข้อความ
  onAdReferralCaptured = () => {},
}) {
  const channelId = FACEBOOK_CHANNEL_ID;
  const adReferralCaptured = (result) => {
    if (!result?.captured) return;
    try { onAdReferralCaptured(); } catch { /* ตัวเก็บรูปพังห้ามลากข้อความลูกค้าล้ม */ }
  };
  const client = () => lineRegistry.forChannel(channelId);
  const creds = () => {
    const ch = lineRegistry.channels.find((c) => c.id === channelId);
    try { return ch?.credentials?.() || {}; } catch { return {}; }
  };

  // GET /webhooks/facebook — Meta ยิงตอนกด Verify ใน App Dashboard
  // ตอบ challenge เป็น plain text เมื่อ verify token ตรงเท่านั้น (fail-closed: ไม่ตั้ง = 403)
  function handleVerify(req, res, url) {
    const expected = String(creds().verifyToken || "");
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") || "";
    if (!expected || mode !== "subscribe" || token !== expected) {
      return json(res, 403, { ok: false, error: "verify token ไม่ถูกต้อง" });
    }
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(challenge);
  }

  // เกตลูกค้าเก่า Lead Center — ตัดสิน "ก่อนบอทมีสิทธิ์ตอบครั้งแรก" เท่านั้น
  // ลูกค้าที่มีแถวอยู่แล้ว = ผ่านเกตไปแล้วครั้งแรก ไม่วนซ้ำ (ทีมปลด AI จากคอนโซลได้เสมอ)
  async function legacyGate(custKey, psid) {
    const knownList = loadKnownCustomers(db);
    if (!knownList.length) return { gated: false }; // ยังไม่ตั้งรายชื่อ = ไม่มีเกต (ค่าเริ่มต้นปลอดภัยฝั่งลีดใหม่)
    let profile = null;
    try {
      profile = await Promise.race([
        client().getProfile({ userId: psid }),
        new Promise((resolve) => setTimeout(() => resolve(null), PROFILE_GATE_TIMEOUT_MS)),
      ]);
    } catch {
      profile = null;
    }
    if (profile) {
      try { db.setProfile(custKey, profile); } catch { /* ชื่อไว้ทีหลังได้ ประวัติสำคัญกว่า */ }
    }
    if (profile && !matchKnownCustomer(profile.displayName, knownList)) {
      return { gated: false, profile }; // ลีดใหม่จริง — บอทคุยได้
    }
    // ตรงรายชื่อ หรือดึงชื่อไม่ได้ (fail-closed): ห้องนี้เป็นของทีม ตั้งแต่ยังไม่ทันตอบ
    return closeGate(custKey, profile);
  }

  // ผลลัพธ์ฝั่ง "กันไว้ก่อน" ของเกต — แยกออกมาเพราะตอนระบบกำลังปิดเราต้องใช้ผลนี้
  // ทันทีโดยไม่รอ Meta (ผลเดียวกับที่เกตตัดสินตอน timeout อยู่แล้ว)
  function closeGate(custKey, profile = null) {
    const reason = profile ? AI_OFF_FB_LEGACY : AI_OFF_FB_UNVERIFIED;
    db.setAiEnabled(custKey, false, reason);
    // source "human" โดยเจตนา: ป้ายนี้ปลดโดยมือคนเท่านั้น — ห้าม scorer/RFM ล้าง
    try { db.addTag(custKey, FB_LEGACY_TAG, "human"); } catch { /* ป้ายพังไม่หยุดเกต */ }
    db.addAudit({
      operator: "system", action: "fb_legacy_gate", target: String(custKey),
      detail: profile
        ? "ชื่อตรงรายชื่อลูกค้าเก่า Lead Center — ปิด AI ให้ทีมดูแล"
        : "ดึงชื่อโปรไฟล์ไม่ได้ — กันไว้ก่อนให้ทีมตรวจ (ปลดจากคอนโซลได้)",
    });
    notifier?.fire?.({
      customerId: custKey, channelId, reason: "fb_legacy_customer",
      customerName: profile?.displayName || "",
    })?.catch?.(() => {});
    return { gated: true, profile };
  }

  // ระหว่างระบบกำลังปิด เราไม่มีเวลารอ Meta ตอบ (ได้ถึง 8 วินาที) แต่ "ตัดสินไปเลย"
  // ก็ไม่ได้เช่นกัน — closeGate ปิด AI ถาวรพร้อมป้ายที่ปลดได้ด้วยมือคนเท่านั้น
  // ลีดใหม่จริงที่บังเอิญทักตรงจังหวะ deploy จะถูกบอทเมินตลอดไปจนกว่าจะมีคนไปปลดเอง
  // = สร้างความเงียบถาวรแบบใหม่ให้ลีดใหม่ทุกคน ซึ่งคือบั๊กที่งานนี้ตั้งใจมาแก้พอดี
  //
  // จึงเลื่อนการตัดสินแทน: ปิด AI ไว้ก่อนด้วยเหตุผลชั่วคราวที่ "ระบบปลดเองได้"
  // ไม่ติดป้ายลูกค้าเก่า ไม่ปลุกใคร แล้วข้อความถัดไปของคนนี้จะวิ่งเข้าเกตจริงพร้อมโปรไฟล์
  // invariant เดิมยังอยู่ครบ: ระหว่างที่ยังไม่ผ่านเกต บอทไม่มีทางทักลูกค้าเก่า
  function deferGateWhileDraining(custKey) {
    if (!loadKnownCustomers(db).length) return { gated: false }; // ไม่มีรายชื่อ = ไม่มีเกต
    db.setAiEnabled(custKey, false, AI_OFF_FB_GATE_PENDING);
    db.addAudit({
      operator: "system", action: "fb_legacy_gate_deferred", target: String(custKey),
      detail: "ข้อความแรกเข้ามาตอนระบบกำลังปิด — พัก AI ไว้ก่อน แล้วตัดสินเกตจริงในข้อความถัดไป",
    });
    return { gated: true, deferred: true };
  }

  // เกตที่ถูกเลื่อนไว้ต้องได้ตัดสินจริงในข้อความถัดไป ไม่งั้นลูกค้าเก่าจะหลุดเกตถาวร
  // (เงื่อนไข !existing ของเส้นปกติจะไม่จริงอีกแล้ว เพราะแถวลูกค้าถูกสร้างไปตอน drain)
  // ปลด AI คืนเฉพาะเมื่อเหตุผลที่ปิดคือของเราเองเท่านั้น — ห้ามแตะห้องที่คนจริงสั่งปิด
  async function resolveDeferredGate(custKey, psid, existing) {
    if (existing?.ai_off_reason !== AI_OFF_FB_GATE_PENDING) return { gated: false, deferred: false };
    const result = await legacyGate(custKey, psid);
    if (result.gated) return result;                    // closeGate เขียนเหตุผลจริงทับให้แล้ว
    const now = db.getCustomer(custKey);
    // ด่านกลาง: ห้ามเปิดคืนทับเหตุที่คนจริงเป็นคนสั่ง (ดู aiPausePolicy.mjs)
    if (canAutoEnableAi(now, { expectReason: AI_OFF_FB_GATE_PENDING })
        && now?.ai_off_reason === AI_OFF_FB_GATE_PENDING) {
      db.setAiEnabled(custKey, true, "");
      db.addAudit({
        operator: "system", action: "fb_legacy_gate_cleared", target: String(custKey),
        detail: "ตรวจโปรไฟล์แล้วเป็นลีดใหม่จริง — เปิด AI คืนหลังเกตที่ถูกเลื่อนไว้ตอนปิดระบบ",
      });
    }
    return result;
  }

  // echo = สำเนาข้อความขาออกของเพจ ทุกทาง (บอทเรา / แอดมินใน Business Suite / แอปอื่น)
  // ของเราเองดูจาก metadata — ที่เหลือคือคนจริง: บันทึก + บอทหลบห้องนั้นถาวร
  function handleEcho(event) {
    const message = event.message || {};
    const mid = String(message.mid || "");
    if (!mid || !db.markDedupe(`fb:${mid}`)) return;
    if (message.metadata === FB_OUTBOUND_METADATA) return; // บอทเราส่งเอง — บันทึกไปแล้วตอนส่ง
    const psid = String(event.recipient?.id || "");
    if (!psid) return;
    const custKey = customerKey(channelId, psid);
    db.upsertCustomer(custKey, { channelId });
    const text = typeof message.text === "string" && message.text
      ? message.text
      : `[${(message.attachments?.[0]?.type) || "attachment"}]`;
    const adGreeting = isAdGreetingEcho(db, custKey, text); // ต้องเช็กก่อนบันทึกแถวนี้
    // insertMessage ที่มี operator เดินเข้า hook ป้ายคลาสฟรีให้เองด้วย (byHuman=true)
    db.insertMessage({
      customerId: custKey, direction: "out", channelId,
      msgType: "text", content: text, messageClass: "reactive", operator: FB_HUMAN_OPERATOR,
    });
    // 8 พ.ย. 2026: ข้อความทักของแอดไม่ใช่คนพิมพ์ — เก็บในประวัติเหมือนเดิม (ลูกแพรต้องเห็นว่าแอดถามอะไร) แต่ไม่พักบอท
    if (adGreeting) {
      logger.info?.("[facebook] ข้อความทักของแอด — ไม่พัก AI");
      return;
    }
    // 2026-09-02 (คำสั่งเจ้าของ): แอดมินพิมพ์ใน Business Suite = คนตอบเอง ซึ่งเหมือน
    // การตอบจากคอนโซลทุกประการ จึง "พัก" AI 15 นาทีเท่ากัน ไม่ใช่ปิดถาวร
    //
    // ของเดิมปิดถาวร (fb_human_replying) แล้วไม่มีใครกลับไปเปิดคืน ห้องจึงตายไปเลย
    // ทุกครั้งที่ทีมงานตอบสักครั้งเดียว — พักที่ต่ออายุทุก echo ให้ผลที่ต้องการเหมือนกัน
    // (คนพิมพ์อยู่ = บอทไม่แทรก) โดยไม่ทิ้งห้างร้างไว้ข้างหลัง
    //
    // จงใจไม่แตะ ai_enabled เลย: ห้องที่คนกดปิดเองไว้ต้องปิดต่อ และเกตที่ถูกเลื่อนไว้
    // (fb_gate_pending) ยังคงต้องตัดสินจริงในข้อความถัดไปตามเดิม — หน้าต่างพักคุมไว้แล้ว
    // ว่าบอทจะไม่เด้งมาแทรกระหว่างที่ทีมงานยังคุยอยู่
    //
    // จดลง audit เฉพาะตอน "เริ่ม" หน้าต่างพักใหม่ ไม่ใช่ทุก echo: ของจริงมี echo ราว
    // 120 ครั้ง/วัน ส่วน listAudit อ่านได้แค่ 500 แถวล่าสุดของทั้งระบบ ถ้าจดทุกครั้ง
    // ร่องรอยอย่างอื่น (เส้นเงิน/ปิด AI/คนกดปุ่ม) จะถูกดันหลุดหน้าต่างภายในไม่กี่วัน
    // การต่ออายุหน้าต่างที่ยังเปิดอยู่ยังต้องเกิดทุก echo — แค่ไม่ต้องจดซ้ำ
    const nowMs = Date.now();
    const startsPause = (Number(db.getCustomer(custKey)?.operator_active_until) || 0) <= nowMs;
    pauseAiForHumanReply(db, custKey, { nowMs, logger });
    if (startsPause) {
      db.addAudit({
        operator: "system", action: "fb_human_takeover", target: String(custKey),
        detail: `แอดมินตอบจาก Business Suite — พัก AI ${OPERATOR_PAUSE_MS / 60_000} นาที (ต่ออายุทุกครั้งที่ตอบ)`,
      });
    }
  }

  async function handleMessageEvent(event) {
    const message = event.message || {};
    if (message.is_echo) return handleEcho(event);
    const psid = String(event.sender?.id || "");
    // postback ไม่มี mid — ใช้ timestamp+psid เป็นกุญแจ dedupe แทน (Meta ส่งซ้ำ ts เดิม)
    const mid = String(message.mid || (event.postback ? `pb:${event.timestamp}:${psid}` : ""));
    if (!psid || !mid) return;

    const custKey = customerKey(channelId, psid);
    const existing = db.getCustomer(custKey);
    // ที่มาจากแอด (message.referral / postback.referral) — จดก่อนแยกชนิดข้อความและก่อนเกตลูกค้าเก่า
    // เพื่อให้ first_contact อ่านจาก "ก่อนสร้างแถว" · ไม่ throw ไม่สร้างแถวลูกค้า ไม่เปลี่ยนสิ่งที่ไปป์ไลน์เห็น
    adReferralCaptured(captureAdReferral(db, { event, customerId: custKey, channelId, firstContact: !existing, logger }));

    // ข้อความ: text ตรง ๆ / postback (ปุ่ม quick reply) ใช้ title เป็นข้อความ /
    // แนบไฟล์ = msgType image|file -> pipeline พาเข้าเส้นเงินแบบ fail-closed เอง
    // (FB แนบเป็น URL ไม่ใช่ content API — ตัวจำแนกรูปยังไม่รองรับ = unknown = เงิน)
    let msgType = "text";
    let content = "";
    let mediaUrl = "";
    if (typeof message.text === "string" && message.text) {
      content = message.text;
    } else if (event.postback) {
      content = String(event.postback.title || event.postback.payload || "");
    } else if (Array.isArray(message.attachments) && message.attachments.length) {
      const first = message.attachments[0] || {};
      if (isStickerAttachment(first)) {
        // สติกเกอร์/ปุ่มไลก์ = เดินเส้นเดียวกับสติกเกอร์ของ LINE เป๊ะ: บันทึกแถวขาเข้าไว้
        // (ประวัติ + นาฬิกาตาม follow-up ยังเดินตามเดิม) แต่ไม่ดูดไฟล์ ไม่เข้าเส้นเงิน
        // และไปป์ไลน์คืน route ignore ให้เอง เพราะ msgType ไม่ใช่ text/image
        msgType = "sticker";
        content = "[sticker]";
      } else {
        const kind = String(first.type || "file");
        msgType = kind === "image" ? "image" : "file";
        content = `[${msgType}]`;
        // Meta ส่ง URL ของไฟล์มาในตัว webhook เลย — ต้องเก็บไว้ให้ตัวดูดสื่อไปดาวน์โหลด
        // ไม่งั้นคอนโซลเห็นแค่ "[image]" และสลิป (หลักฐานการเงิน) หายไปพร้อม URL ที่หมดอายุ
        mediaUrl = String(first.payload?.url || "");
      }
    } else {
      return; // event ไม่มีเนื้อหาที่ระบบรู้จัก (reaction ฯลฯ) — เงียบ
    }

    // เกตลูกค้าเก่าต้องจบ "ก่อน" persist+pipeline — ai_enabled ถูกอ่านตอนตัดสินตอบ
    if (!existing) {
      db.upsertCustomer(custKey, { channelId });
      // ระหว่างระบบกำลังปิด ห้ามรอ Meta ได้ถึง 8 วินาที — พัก AI ไว้ก่อนแล้วเลื่อนไปตัดสิน
      // ในข้อความถัดไป (ห้ามตัดสินถาวรตรงนี้ ดูเหตุผลที่ deferGateWhileDraining)
      if (isDraining()) deferGateWhileDraining(custKey);
      else await legacyGate(custKey, psid);
    } else if (existing.ai_off_reason === AI_OFF_FB_GATE_PENDING && !isDraining()) {
      // เกตที่ค้างจากรอบ deploy ก่อน — ตัดสินตอนนี้ก่อนที่บอทจะมีสิทธิ์ตอบ
      await resolveDeferredGate(custKey, psid, existing);
    }

    // แถว attachment คือสิ่งที่คอนโซลใช้แสดงรูปจริง (เหมือนเส้น LINE ทุกอย่าง) — ต่างกันแค่
    // ที่มาของไบต์: LINE ยิง content API ด้วย message id ส่วน FB ดาวน์โหลดจาก URL ใน providerMeta
    const mediaCaptureOn = Boolean(config.messageMediaEnabled && config.inboundLineContentCapture);
    const attachment = mediaUrl
      ? {
          source: "facebook",
          kind: msgType === "image" ? "image" : "file",
          status: mediaCaptureOn ? "queued" : "unavailable",
          originalName: "",
          byteSize: null,
          providerMessageId: String(mid),
          providerMeta: { contentProvider: "facebook", url: mediaUrl },
          unavailableReason: mediaCaptureOn ? "รอดาวน์โหลดจาก Facebook" : "ยังไม่ได้เปิดเก็บไฟล์",
        }
      : null;

    const persisted = db.persistLineInbound({
      dedupeKey: `fb:${mid}`,
      customerId: custKey,
      channelId,
      attachment,
      mediaMaxCount: config.messageMediaMaxActive,
      mediaMaxBytes: config.messageMediaTotalBytes,
      msgType,
      content: msgType === "text" ? content : `[${msgType}]`,
      owesReply: true,
      channelKind: "facebook",
      processId,
    });
    if (!persisted.stored) return;

    // Start the existing leased downloader after commit, as LINE ingress does.
    // Waiting for its periodic sweep can outlast the image classifier's budget.
    if (persisted.attachmentStored && mediaCaptureOn && !isDraining()) {
      queueMicrotask(requestMediaIngest);
    }

    // ระบบกำลังปิด — เก็บข้อความไว้ให้ครบแล้วปักธงให้คนรับต่อ ไม่เริ่มคิด
    if (isDraining()) {
      try {
        db.closeInboundTurn(persisted.messageId, { status: "stranded_shutdown", reason: "arrived_during_drain" });
      } catch (err) {
        logger.warn?.(`fb webhook: จดสถานะข้อความช่วงปิดระบบไม่สำเร็จ (${err?.message || err})`);
      }
      // กติกาเดียวกับเส้น LINE: ห้องที่ปิด AI อยู่แล้วไม่ต้องปลุกซ้ำ และห้ามปักธงรัว ๆ
      // จน handoff_summary ของจริงถูกดันตกขอบ 2000 ตัวอักษร
      // หมายเหตุ: ห้องที่เพิ่งถูก deferGateWhileDraining ปิด AI ไว้จะไม่ถูกปักธงที่นี่
      // ซึ่งถูกต้อง — ข้อความถัดไปของเขาจะวิ่งเข้าเกตจริงและคุยต่อได้เองหลังรีสตาร์ท
      flagNeedsHumanForTurn(db, custKey, {
        reason: "drain_interrupted",
        message: "ข้อความเข้ามาตอนระบบกำลังปิด — บอทไม่ได้ตอบ ต้องมีคนรับต่อ",
        skipIfFlagged: true, logger,
      });
      webPush?.fireLater?.({ customerId: custKey, channelId, reason: "inbound" });
      return;
    }

    // เติมชื่อทั้งห้องใหม่และห้องเดิม แม้ไม่ได้ตั้งรายชื่อลูกค้าเก่าไว้
    if (!db.getCustomer(custKey)?.display_name) {
      queueMicrotask(() => {
        client().getProfile({ userId: psid })
          .then((profile) => {
            const current = db.getCustomer(custKey);
            if (profile && current && !current.display_name) db.setProfile(custKey, profile);
          })
          .catch(() => {});
      });
    }
    webPush?.fireLater?.({ customerId: custKey, channelId, reason: "inbound" });

    // แปลงเป็น event รูป LINE — pipeline เดินเส้นเดิมทุกเกต (burst/safety/เงิน/hashtag)
    const lineShaped = {
      type: "message",
      webhookEventId: `fb:${mid}`,
      replyToken: "",
      source: { userId: psid },
      message: { id: mid, type: msgType, ...(msgType === "text" ? { text: content } : {}) },
    };
    let sessionId = null;
    try {
      sessionId = db.activeConversationSession(custKey)?.id || null;
    } catch (err) {
      logger.warn?.(`fb webhook: อ่าน session ไม่สำเร็จ (${err?.message || err}) — เดินต่อด้วย session ว่าง`);
    }
    pipeline.handleEvent(lineShaped, { channelId, expectedSessionId: sessionId, turnId: persisted.messageId })
      .then((verdict) => stampInboundOutcome(db, persisted.messageId, verdict, logger))
      .catch((err) => {
        logger.error?.(`fb pipeline: ${err?.message || err}`);
        stampInboundOutcome(db, persisted.messageId, { error: err }, logger);
      });
  }

  // event "messaging_referrals" (ไม่มีข้อความ): คนที่มีเธรดกับเพจอยู่แล้วกดแอด/ลิงก์ m.me เข้ามาอีก
  // จดที่มาอย่างเดียว — ห้ามสร้างแถวลูกค้า (ข้อความแรกจริงต้องวิ่งเข้าเกตลูกค้าเก่าตาม !existing เหมือนเดิม)
  // ห้ามเข้าไปป์ไลน์ และห้ามทำให้ทั้ง batch ตอบ 500 (Meta จะส่งข้อความลูกค้าที่อยู่ก้อนเดียวกันซ้ำ)
  function handleReferralEvent(event) {
    try {
      const psid = String(event.sender?.id || "");
      if (!psid) return;
      const custKey = customerKey(channelId, psid);
      adReferralCaptured(captureAdReferral(db, { event, customerId: custKey, channelId, firstContact: !db.getCustomer(custKey), logger }));
    } catch (err) {
      logger.warn?.(`fb webhook: อ่าน referral ไม่สำเร็จ (${err?.message || err}) — ข้ามเฉพาะ event นี้`);
    }
  }

  // POST /webhooks/facebook — verify HMAC จาก raw ก่อน parse เสมอ (แบบเดียวกับ LINE)
  async function handleWebhook(req, res) {
    let raw;
    try {
      raw = await readBody(req, 2_000_000, {
        timeoutMs: config.lineWebhookBodyTimeoutMs,
        destroyOnOverflow: true,
      });
    } catch (err) {
      const message = String(err.message || err);
      return json(res, message.includes("นานเกินกำหนด") ? 408 : 413, { ok: false, error: message });
    }
    const appSecret = String(creds().appSecret || "");
    if (!appSecret) {
      return json(res, 503, { ok: false, error: "FB app secret ยังไม่ได้ตั้งค่า" });
    }
    if (!verifyFacebookSignature(raw, req.headers["x-hub-signature-256"], appSecret)) {
      return json(res, 403, { ok: false, error: "signature ไม่ถูกต้อง" });
    }
    let body;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return json(res, 400, { ok: false, error: "body ไม่ใช่ JSON" });
    }
    if (body?.object !== "page") return json(res, 200, { ok: true, ignored: true });

    let accepted = 0;
    try {
      for (const entry of Array.isArray(body.entry) ? body.entry : []) {
        try { learnPageId(entry?.id); } catch { /* ลิงก์ช่วยทีมเท่านั้น — ห้ามกระทบการรับข้อความ */ }
        for (const event of Array.isArray(entry?.messaging) ? entry.messaging : []) {
          if (event?.message || event?.postback) {
            await handleMessageEvent(event);
            accepted += 1;
          } else if (event?.referral) {
            handleReferralEvent(event); // ไม่นับใน accepted — ไม่ใช่ข้อความ คำตอบถึง Meta คงเดิม
          }
        }
      }
    } catch (err) {
      // DB เขียนไม่ได้ = ตอบ 500 ให้ Meta ส่งซ้ำ (dedupe กันซ้ำอยู่แล้ว) — ห้ามกลืนเงียบ
      logger.error?.(`fb webhook: DB ล้มเหลว (${err?.message || err})`);
      return json(res, 500, { ok: false, error: "บันทึกข้อมูลไม่สำเร็จ" });
    }
    json(res, 200, { ok: true, accepted });
  }

  return { handleVerify, handleWebhook };
}
