// identityLink.mjs — ลูกค้าคนเดียวกันข้ามช่องทาง Facebook ↔ LINE (คำสั่งพี่ง้วง 28 ก.ย. 2026)
//
// ปัญหา: ลูกค้าทักทาง Facebook คุยจนซื้อ แล้วย้ายไป LINE OA — ห้อง LINE เป็นห้องใหม่ ลูกแพรไม่รู้ว่าเป็นลูกค้าเก่า
// ทางแก้หลัก (ลูกค้ายืนยันตัวเอง ไม่ใช่ระบบเดา):
//   1) ห้อง Facebook ได้ข้อความสั้น ๆ พร้อมลิงก์เปิดแชท LINE ที่เตรียมข้อความ + รหัสใช้ครั้งเดียวไว้ให้
//   2) ลูกค้ากดส่งใน LINE → webhook เจอรหัส → เชื่อมสองห้องเป็นคนเดียวกัน → ห้อง LINE ได้สถานะ/ป้าย/สรุปจาก Facebook
//   3) ซื้อแล้ว (ป้าย customer ฯลฯ) = ห้อง LINE ติดป้าย customer + AI เงียบ + ปักธงให้ทีม · ยังไม่ซื้อ = ลูกแพรคุยต่อจากเดิม
// ทีมเชื่อม/ยกเลิกเองได้ในคอนโซล (owner/admin) · ระบบแนะนำห้องที่อาจเป็นคนเดียวกันให้คนยืนยันเท่านั้น
// "ชื่อเหมือนกัน" ไม่เคยเป็นหลักฐาน — ไม่มีเส้นไหนเชื่อมเองจากชื่อ (บทเรียน legacyLink.mjs)
//
// รหัสผิด/หมดอายุ/ใช้แล้ว: ไม่เชื่อม ไม่ให้ลูกแพรเห็นรหัส (ตัดออกจากข้อความ) · ส่งผิดเกินเพดาน = ไม่ตรวจต่อ
// ข้อความถึงลูกค้าทุกข้อความผ่านสวิตช์ identity_link_mode (ค่าเริ่มต้น off) — ถ้อยคำอยู่ที่ identityLinkCodes.mjs
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
import { DEFAULT_CHANNEL_ID, FACEBOOK_CHANNEL_ID } from "./channels.mjs";
import { BOT_SILENCED_TAGS, FB_MESSAGING_WINDOW_MS, FREE_CLASS_TAG } from "./db.mjs";
import { aiPausedNow } from "./aiPause.mjs";
import { scheduleState } from "./scheduleGate.mjs";
import { FB_LEGACY_TAG } from "./facebookWebhook.mjs";
import { LEGACY_LINK_TAG, LEGACY_SOURCE_TAG } from "./legacyLink.mjs";
import { scrubCustomerText } from "./ownerChatText.mjs";
import { flagNeedsHumanForTurn } from "./inboundOutcome.mjs";
import { isHumanNoteAuthor } from "./lineOaContext.mjs";
import { INHERITED_FROM_KEYS } from "./dbIdentityLinks.mjs";
import {
  CODE_TTL_MS, MASKED_CODE,
  findLinkCodeTokens, generateLinkCode, hashLinkCode, identityLinkMode, identityLinkPrefill,
  isTemplateOnlyMessage, lineOaMessageUrl, normalizeLineBasicId, textWithoutLinkCodes,
} from "./identityLinkCodes.mjs";
import { identityLandingUrl } from "./identityLinkLanding.mjs";
import { isNotQualifiedRow } from "./notQualified.mjs";
import { trackingBaseUrl } from "./broadcastStudio.mjs";
import {
  IDENTITY_CLASSES, IDENTITY_CLASS_TYPES, classLabel, classTypeFromText,
  customerCallName, identityInviteBubbles, identityInviteText, identityWelcomeBubbles, normalizeClassType,
} from "./identityLinkClasses.mjs";
import { DAY_MS, HOUR_MS, VIA_TEXT, identityIsBuyer, isFacebookRoom, nameOf, safe } from "./identityLinkShared.mjs";
import { readIdentityTemplate } from "./identityLinkTemplates.mjs";
import { createIdentityLinkConsole } from "./identityLinkConsole.mjs";

// ทางเข้าเดิมของโมดูลอื่น/เทสต์ — ตัวจริงอยู่ในไฟล์ที่แยกออกไป (28 ก.ย. ค่ำ: ไฟล์นี้เกิน 800 บรรทัด)
export { IDENTITY_LINK_CAPABILITY, identityIsBuyer, isFacebookRoom } from "./identityLinkShared.mjs";
export { IDENTITY_TEMPLATE_KEY_PREFIX, readIdentityTemplate, saveIdentityTemplate } from "./identityLinkTemplates.mjs";
export { linkedIdentityLines, normalizeEmail, normalizePhone, samePersonResolution } from "./identityLinkConsole.mjs";

// ผู้เขียนโน้ตของระบบนี้ — ต้องอยู่ใน NON_HUMAN_NOTE_AUTHORS (lineOaContext.mjs) ไม่งั้นนับเป็น "คนสรุปแล้ว"
export const IDENTITY_NOTE_AUTHOR = "ระบบ (เชื่อมช่องทาง)";
export const IDENTITY_LINK_LIMITS = Object.freeze({
  invitesPerRoomPerDay: 3,
  invitesPerHour: 60,
  failuresPerRoomPerDay: 5,
  failuresPerHour: 60,
});
// ป้ายที่ไม่คัดลอก: ป้ายเงียบ (customer ใส่แยกตามสถานะซื้อ · null = เฉพาะห้องนั้น) ป้ายกลไกระบบเก่า/เกต Facebook
// และป้ายเหตุการณ์คลาสฟรี (นาฬิกา 7 วันของมันผูกกับเวลาติดป้าย — คัดลอกแล้วนาฬิกาจะเริ่มใหม่ผิด ๆ)
const NOT_COPIED = new Set([...BOT_SILENCED_TAGS, LEGACY_SOURCE_TAG, LEGACY_LINK_TAG, FB_LEGACY_TAG].map((tag) => tag.toLowerCase()));
// หมุดจังหวะราคา/บริบท — ห้อง LINE ต้องเดินต่อจากจุดเดิม ไม่ใช่เริ่มคัดกรองลูกค้าใหม่ (ดันไปทาง quote ทางเดียว)
const PIN_MARKERS = Object.freeze([
  ["known_context_at", "markCustomerContextKnown"],
  ["price_deferred_at", "markPriceDeferred"],
  ["price_quoted_at", "markPriceQuoted"],
  ["price_pivot_deferred_at", "markOnlinePivotDeferred"],
  ["money_seen_at", "markMoneySeen"],
]);
const DEAL_TEXT = Object.freeze({
  collecting_info: "กำลังเก็บข้อมูล", class_recommended: "แนะนำคลาสแล้ว", details_sent: "ส่งรายละเอียดแล้ว",
  price_sent: "แจ้งราคาแล้ว", awaiting_round_choice: "รอเลือกรอบ", awaiting_team_decision: "รอทีมตัดสินใจ",
  quote_sent: "ส่งใบเสนอราคาแล้ว", awaiting_payment: "รอชำระเงิน", not_ready: "ยังไม่พร้อม",
  waiting_next_round: "รอรอบถัดไป", paid_confirmed: "ชำระแล้ว (ทีมยืนยัน)", prep_sent: "ส่งข้อมูลเตรียมเรียนแล้ว",
});
const PROFILE_WAIT_MS = 2_000;
const FAILURE_OUTCOMES_WITH_REAL_CODE = new Set(["expired", "consumed", "revoked", "conflict"]);

const oneLine = (value, max) => {
  const text = scrubCustomerText(String(value ?? "").replace(/\s+/gu, " ").trim());
  return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
};
const thaiDate = (ms) => new Date(Number(ms) + 7 * HOUR_MS).toISOString().slice(0, 10);


function parseScore(db, customerId) {
  const raw = safe(() => db.latestScoreRow(customerId)?.payload_json, "");
  const payload = safe(() => JSON.parse(String(raw || "")), null);
  return payload && typeof payload === "object" ? payload : {};
}

function copyableTag(tag) {
  const text = String(tag || "").trim();
  if (!text || NOT_COPIED.has(text.toLowerCase())) return false;
  return !text.includes(FREE_CLASS_TAG);
}

function summaryNoteText(db, source, { buyer, via, at, classType = "" }) {
  const score = parseScore(db, source.line_user_id);
  const tags = safe(() => db.listTags(source.line_user_id), []).map((row) => row.tag).filter(copyableTag);
  const teamNote = safe(() => db.listHandoffNotes(source.line_user_id, 50), [])
    .filter((note) => isHumanNoteAuthor(note.author))
    .pop();
  // ไม่ยกข้อความลูกค้ามาตรง ๆ — โน้ตนี้เข้าพรอมต์ในฐานะบันทึกของทีม ข้อความดิบของลูกค้าจึงห้ามได้สิทธิ์นั้น
  const lines = [
    `ต่อจากห้อง Facebook ของลูกค้าคนเดียวกัน (${VIA_TEXT[via] || via} · ${thaiDate(at)})`,
    buyer
      ? `สถานะ: ซื้อ/ลงทะเบียนแล้ว${classType ? ` — ${classLabel(classType)} (ทีมเลือกตอนส่งลิงก์)` : ""} · ทีมงานดูแลเองทั้งหมด AI เงียบ`
      : "สถานะ: ยังไม่ได้ซื้อ — คุยต่อจากที่ค้างไว้ ไม่ต้องแนะนำตัวใหม่ และไม่ถามซ้ำเรื่องที่ลูกค้าเคยบอกแล้ว",
    source.known_name ? `ชื่อที่ลูกค้าบอก: ${oneLine(source.known_name, 40)}` : "",
    DEAL_TEXT[source.deal_status] ? `ความคืบหน้าฝั่ง Facebook: ${DEAL_TEXT[source.deal_status]}` : "",
    score.context_summary ? `สรุปจากตัวอ่านแชท: ${oneLine(score.context_summary, 150)}` : "",
    score.pain_point ? `เรื่องที่อยากแก้: ${oneLine(score.pain_point, 90)}` : "",
    tags.length ? `ป้ายฝั่ง Facebook: ${oneLine(tags.slice(0, 8).join(" · "), 110)}` : "",
    teamNote ? `โน้ตทีมล่าสุดฝั่ง Facebook: ${oneLine(teamNote.text, 110)}` : "",
  ].filter(Boolean);
  return lines.join("\n").slice(0, 500);
}

function movedNoteText({ via, at, followupDisabled, classType = "" }) {
  return `ลูกค้าเชื่อมแชทกับ LINE แล้ว (${VIA_TEXT[via] || via} · ${thaiDate(at)}${classType ? ` · ซื้อ ${classLabel(classType)}` : ""}) — ต่อจากนี้คุยทาง LINE เป็นหลัก`
    + (followupDisabled ? " · ปิดทักตามอัตโนมัติฝั่ง Facebook ให้แล้ว (เปิดคืนได้ในแผงข้อมูล)" : "");
}

export function createIdentityLink({
  config = {}, db, lineRegistry = null, pipeline = null, notifier = null, logger = console, now = Date.now,
} = {}) {
  const secret = () => String(config.consoleSessionSecret || "");
  // โดเมนสาธารณะของหน้า /r/line — ชุดเดียวกับลิงก์นับคลิก (Caddy ส่ง /r/* เข้าแอปแล้ว) · สำรอง = โดเมนของคอนโซล
  const landingBase = () => {
    const tracked = trackingBaseUrl(config);
    if (tracked) return tracked;
    try { return new URL(String(config.consolePublicBaseUrl || "")).origin; } catch { return ""; }
  };
  const audit = (operator, action, target, detail) => safe(() => db.addAudit({ operator, action, target, detail }), null);

  /* ----------------------------- ช่องทาง / เงื่อนไข ----------------------------- */

  function lineChannels() {
    return (lineRegistry?.channels || []).filter((ch) => ch && ch.provider !== "facebook" && ch.active !== false);
  }

  // LINE ID ที่ถามจาก LINE เอง (GET /v2/bot/info) เมื่อไม่ได้ตั้งค่า — จำเฉพาะผลสำเร็จ ล้ม = ถามใหม่รอบหน้า (ห้ามเดา)
  const resolvedBasicIds = new Map();
  let resolving = null;
  const basicIdFor = (ch) => normalizeLineBasicId(ch.basicId) || resolvedBasicIds.get(ch.id) || "";

  /** ถาม LINE ID ของ OA ที่ยังไม่ได้ตั้งค่า (ครั้งเดียวต่อช่องที่ได้ผล) — ไม่ throw */
  function resolveBasicIds() {
    if (resolving) return resolving;
    resolving = (async () => {
      for (const ch of lineChannels()) {
        if (basicIdFor(ch)) continue;
        try {
          const info = await lineRegistry?.forChannel?.(ch.id)?.getBotInfo?.();
          // premium ID ก่อน (พี่ง้วง 30 ก.ย.: "ปรับ line oa @pngoung") — ลูกค้าค้นหาในแอป LINE ได้ง่าย · ไม่มีค่อยใช้ basic ID
          const id = normalizeLineBasicId(info?.premiumId) || normalizeLineBasicId(info?.basicId);
          if (id) {
            resolvedBasicIds.set(ch.id, id);
            // LINE ID ของ OA เป็นข้อมูลสาธารณะ (ลูกค้าค้นหาได้) — จดไว้ให้ตรวจได้ว่าลิงก์เชิญชี้ OA ไหน
            logger.log?.(`[identity-link] ลิงก์เชิญของ ${ch.id} ใช้ LINE ID ${id}${normalizeLineBasicId(info?.premiumId) ? " (premium)" : " (basic)"}`
              + ` · บอลลูนลิงก์ ${identityLandingUrl(landingBase(), "LK-…") || "ลิงก์ line.me ตรง (ไม่มีโดเมนสาธารณะ)"}`);
          }
        } catch (err) {
          logger.debug?.(`identityLink: ถาม LINE ID ของ OA ${ch.id} ไม่สำเร็จ (${err?.message || err})`);
        }
      }
    })().finally(() => { resolving = null; });
    return resolving;
  }

  /** OA ปลายทางของลิงก์เชิญ: default ก่อน แล้ว OA แรกที่รู้ basic ID — ไม่มีเลย = ส่งลิงก์ไม่ได้ */
  function targetLineChannel() {
    const list = lineChannels();
    const pick = list.find((ch) => ch.id === DEFAULT_CHANNEL_ID && basicIdFor(ch))
      || list.find((ch) => basicIdFor(ch));
    return pick ? { id: pick.id, basicId: basicIdFor(pick), name: String(pick.name || "") } : null;
  }

  function channelLabel(channelId) {
    if (channelId === FACEBOOK_CHANNEL_ID) return "Facebook";
    const list = lineChannels();
    const channel = list.find((ch) => ch.id === channelId);
    return list.length > 1 && channel?.name ? `LINE · ${channel.name}` : "LINE";
  }

  function linkedLineIdentity(customerId) {
    return safe(() => db.listLinkedIdentities(customerId), [])
      .find((row) => row.customer_id !== customerId && row.channel_id !== FACEBOOK_CHANNEL_ID) || null;
  }

  function fbWindowOpen(customerId, nowMs) {
    const last = Number(safe(() => db.lastInboundAt(customerId), 0)) || 0;
    return last > 0 && nowMs - last < FB_MESSAGING_WINDOW_MS;
  }

  /**
   * ลูกค้าห้องนี้ซื้อ/สนใจคลาสไหน ตามหลักฐานในฐาน (ใช้เลือกไว้ให้ในปุ่มส่งลิงก์ + โหมด auto)
   * purchase = ชื่อสินค้าบนออเดอร์ที่ซื้อจริง / ป้าย "ซื้อแล้ว: …" · interest = ป้ายสนใจ (คำใบ้ — คนต้องยืนยัน)
   * @returns {{type: string, source: ""|"purchase"|"purchase_ambiguous"|"interest"|"interest_ambiguous", candidates: string[]}}
   */
  function detectClass(customerId) {
    const purchased = new Set();
    const interested = new Set();
    for (const name of safe(() => db.identityPurchasedItemNames(customerId), [])) {
      const type = classTypeFromText(name);
      if (type) purchased.add(type);
    }
    for (const row of safe(() => db.listTags(customerId), [])) {
      const tag = String(row?.tag || "").trim();
      const bought = /^ซื้อแล้ว\s*:/u.test(tag);
      const type = classTypeFromText(bought ? tag.replace(/^ซื้อแล้ว\s*:/u, "") : tag);
      if (type) (bought ? purchased : interested).add(type);
    }
    const pick = (set, source) => ({
      type: set.size === 1 ? [...set][0] : "",
      source: set.size === 1 ? source : `${source}_ambiguous`,
      candidates: IDENTITY_CLASS_TYPES.filter((type) => set.has(type)),
    });
    if (purchased.size) return pick(purchased, "purchase");
    if (interested.size) return pick(interested, "interest");
    return { type: "", source: "", candidates: [] };
  }

  /** เหตุที่ส่งลิงก์ไม่ได้ตอนนี้ ("" = ส่งได้) — คอนโซลใช้โชว์เหตุผลบนปุ่ม */
  function inviteBlocker(customer, { via = "console", nowMs = now() } = {}) {
    if (!customer) return "not_found";
    if (!isFacebookRoom(customer)) return "not_facebook";
    const mode = identityLinkMode(db);
    if (mode === "off" || (via === "auto" && mode !== "auto")) return "mode_off";
    // สวิตช์หยุด AI ทั้งระบบ = "ไม่ตอบใคร ไม่ทักใคร" (aiPause.mjs) — การส่งเองของระบบหยุดตามทุกเส้น
    // ปุ่มที่ทีมกดเองในคอนโซลคือการกระทำของคน ส่งได้เหมือนพิมพ์ตอบเอง (แบบเดียวกับการส่งมือใน consoleApi)
    if (via === "auto" && aiPausedNow({ db, config })) return "ai_paused";
    if (!secret()) return "no_secret";
    if (!targetLineChannel()) return "no_basic_id";
    if (linkedLineIdentity(customer.line_user_id)) return "already_linked";
    // auto ส่งได้ครั้งเดียวต่อห้อง — ตรวจซ้ำตอนจะออกรหัสจริง (สองจังหวะที่มาติดกันต่างก็ผ่านด่านแรกของ maybeAutoInvite)
    if (via === "auto" && db.countIdentityLinkCodes({ customerId: customer.line_user_id, via: "auto" }) > 0) return "already_invited";
    const fb = safe(() => lineRegistry?.forChannel?.(customer.channel_id), null);
    if (!fb || fb.sendAllowed?.() === false) return "send_disabled";
    if (!fbWindowOpen(customer.line_user_id, nowMs)) return "window_closed";
    // เพดานต่อห้องนับเฉพาะลิงก์ที่ลูกค้ายังไม่ได้ใช้ — กันส่งรัวหาคนที่ไม่กด · ลิงก์ที่ใช้เชื่อมสำเร็จแล้วไม่นับ
    // (30 ก.ย. 2026 พี่ง้วง: เชื่อมสำเร็จ → ยกเลิกการเชื่อม → จะเชื่อมใหม่ "มันไม่ให้เชื่อมแล้ว" เพราะครบ 3 ครั้งใน 24 ชม.)
    const roomInvites = db.countIdentityLinkCodes({ customerId: customer.line_user_id, sinceMs: nowMs - DAY_MS, excludeStatus: "consumed" });
    if (roomInvites >= IDENTITY_LINK_LIMITS.invitesPerRoomPerDay) return "too_many";
    if (db.countIdentityLinkCodes({ sinceMs: nowMs - HOUR_MS }) >= IDENTITY_LINK_LIMITS.invitesPerHour) return "too_many";
    return "";
  }

  /* ------------------------------ การสืบทอดข้อมูล ------------------------------ */

  // FB → LINE เท่านั้น: ห้อง Facebook คือที่ที่ลูกค้าคุยจนซื้อ ห้อง LINE คือปลายทาง (ต้องเรียกใน transaction)
  // ป้ายที่คัดลอก + สถานะซื้อแล้ว (ป้าย customer · AI เงียบ · ธงรอคน) ลงห้องปลายทาง
  function inheritTagsAndSilence({ sourceTags, target, targetId, buyer, type }) {
    const copied = [];
    for (const row of sourceTags) {
      if (copyableTag(row.tag) && db.addTag(targetId, row.tag, row.source)) copied.push(row.tag);
    }
    if (buyer && db.addTag(targetId, "customer", "human")) copied.push("customer");
    let silenced = false;
    if (buyer) {
      // เหตุเดียวกับการติดป้าย customer ในคอนโซล (customerTagActions.mjs) — ทับได้เฉพาะ AI เปิด/bank_sent
      // และห้องสีเหลืองของตัวกวาดคัดกรอง (5 ต.ค. 2026: คนซื้อแล้วชนะการตัดสินของ AI — ห้ามให้ตัวกวาดเปิดคืนเอง)
      if (target.ai_enabled === 1 || target.ai_off_reason === "bank_sent" || isNotQualifiedRow(target)) {
        db.setAiEnabled(targetId, false, "customer_handover");
        silenced = true;
      }
      db.setNeedsHuman(targetId, "identity_linked",
        `ลูกค้าเดิมจาก Facebook ที่ซื้อแล้ว${type ? ` (${classLabel(type)})` : ""} เข้ามาทาง LINE — ทีมงานดูแลต่อ (เช่น ส่งเอกสารคลาส)`);
    }
    return { copied, silenced };
  }

  // หมุดจังหวะราคา/บริบท + ชื่อที่ลูกค้าบอก — เฉพาะที่ห้องปลายทางยังไม่มี
  function inheritPinsAndName({ source, target, targetId }) {
    const pins = [];
    for (const [column, marker] of PIN_MARKERS) {
      if (Number(source[column]) > 0 && !(Number(target[column]) > 0) && typeof db[marker] === "function") {
        db[marker](targetId);
        pins.push(column);
      }
    }
    let knownName = "";
    if (source.known_name && !target.known_name) {
      db.setKnownName(targetId, source.known_name);
      knownName = String(db.getCustomer(targetId)?.known_name || "");
    }
    return { pins, knownName };
  }

  // classType = คลาสที่ทีมเลือกตอนส่งลิงก์ (มี = ทีมยืนยันแล้วว่าซื้อ) · "" = ดูหลักฐานในห้อง Facebook อย่างเดียว
  function applyInheritance({ sourceId, targetId, via, actor, classType = "" }) {
    const source = db.getCustomer(sourceId);
    const target = db.getCustomer(targetId);
    const at = now();
    const sourceTags = db.listTags(sourceId);
    const type = normalizeClassType(classType);
    const buyer = Boolean(type) || identityIsBuyer(db, sourceId, sourceTags);
    const { copied, silenced } = inheritTagsAndSilence({ sourceTags, target, targetId, buyer, type });
    const { pins, knownName } = inheritPinsAndName({ source, target, targetId });
    const summary = db.addHandoffNote({ customerId: targetId, author: IDENTITY_NOTE_AUTHOR, text: summaryNoteText(db, source, { buyer, via, at, classType: type }) });
    db.setHandoffNotePinned(summary.id, true);
    // ห้อง Facebook: ลูกค้าย้ายไปคุย LINE แล้ว — ทักตามอัตโนมัติสองช่องทางพร้อมกันคือการรบกวน
    let followupDisabled = false;
    if (Number(source.followup_enabled) === 1) {
      db.setFollowupEnabled(sourceId, false);
      followupDisabled = true;
    }
    const moved = db.addHandoffNote({ customerId: sourceId, author: IDENTITY_NOTE_AUTHOR, text: movedNoteText({ via, at, followupDisabled, classType: type }) });
    const targetState = db.identityInherited(targetId);
    db.setIdentityInherited(targetId, {
      ...targetState, from: sourceId, at, tags: copied, silenced, knownName, pins, ...(type ? { classType: type } : {}),
      notes: [...(targetState.notes || []), { id: summary.id, about: sourceId }],
    });
    const sourceState = db.identityInherited(sourceId);
    db.setIdentityInherited(sourceId, {
      ...sourceState, followupDisabled: Boolean(sourceState.followupDisabled || followupDisabled),
      notes: [...(sourceState.notes || []), { id: moved.id, about: targetId }],
    });
    db.addAudit({
      operator: actor, action: "identity_link_inherit", target: targetId,
      detail: `จาก ${sourceId} · ${buyer ? `ซื้อแล้ว${type ? ` (${classLabel(type)})` : ""}: ป้าย customer + AI เงียบ` : "ยังไม่ซื้อ: AI คุยต่อพร้อมบริบท"} · ป้าย ${copied.length} · หมุด ${pins.length}`,
    });
    return { buyer, classType: type, copied, silenced, pins, summaryNoteId: summary.id };
  }

  // หลังเชื่อม: ทุกห้อง LINE ของคนนี้ที่ยังไม่ได้สืบทอด รับข้อมูลจากห้อง Facebook ของคนเดียวกัน
  function inheritWithinPerson({ customerId, via, actor }) {
    const rows = db.listLinkedIdentities(customerId);
    const fb = rows.find((row) => row.channel_id === FACEBOOK_CHANNEL_ID);
    if (!fb) return [];
    const results = [];
    for (const row of rows) {
      if (row.channel_id === FACEBOOK_CHANNEL_ID || db.identityInherited(row.customer_id).from) continue;
      results.push({ targetId: row.customer_id, sourceId: fb.customer_id, ...applyInheritance({ sourceId: fb.customer_id, targetId: row.customer_id, via, actor }) });
    }
    return results;
  }

  // ถอนสิ่งที่การเชื่อมคัดลอกเข้ามา — ป้ายที่ติดทีหลัง (คนติดเองใหม่) ไม่แตะ · เปิด AI คืนเฉพาะที่ระบบปิดเอง
  function undoInheritance(customerId, { aboutId, actor }) {
    const state = db.identityInherited(customerId);
    const notes = Array.isArray(state.notes) ? state.notes : [];
    for (const note of notes.filter((item) => item?.about === aboutId)) safe(() => db.deleteHandoffNote(note.id), false);
    const next = { ...state, notes: notes.filter((item) => item?.about !== aboutId) };
    let reopened = false;
    if (state.from === aboutId) {
      const window = Number(state.at || 0) + 60_000;
      const current = new Map(db.listTags(customerId).map((row) => [row.tag, row]));
      for (const tag of Array.isArray(state.tags) ? state.tags : []) {
        const row = current.get(tag);
        if (row && Number(row.created_at) <= window) db.removeTag(customerId, tag);
      }
      const customer = db.getCustomer(customerId);
      if (state.knownName && customer?.known_name === state.knownName) db.setKnownName(customerId, "");
      const stillSilent = db.listTags(customerId).some((row) => BOT_SILENCED_TAGS.includes(String(row.tag).trim().toLowerCase()));
      if (state.silenced && customer?.ai_enabled === 0 && customer.ai_off_reason === "customer_handover" && !stillSilent) {
        db.setAiEnabled(customerId, true);
        reopened = true;
      }
      for (const key of INHERITED_FROM_KEYS) delete next[key];
    }
    if (next.followupDisabled && !notes.some((item) => item?.about !== aboutId)) {
      if (Number(db.getCustomer(customerId)?.followup_enabled) === 0) db.setFollowupEnabled(customerId, true);
      delete next.followupDisabled;
    }
    db.setIdentityInherited(customerId, next);
    if (reopened) {
      db.addAudit({ operator: actor, action: "identity_unlink_ai_reopened", target: customerId,
        detail: "ยกเลิกการเชื่อม — ถอนป้าย customer ที่คัดลอกมาและเปิด AI คืน (ป้ายที่คนติดเองไม่แตะ)" });
    }
    return { reopened };
  }

  /* -------------------------------- เชื่อม/ยกเลิก -------------------------------- */

  /** ทีมเชื่อมสองห้องเอง (owner/admin) — ต้องต่างช่องทาง · รวมคนสองคนได้ถ้าช่องไม่ชน */
  function linkByTeam({ customerId, otherId, operator, via = "team" }) {
    const kind = via === "suggestion" ? "suggestion" : "team";
    const result = db.runIdentityLinkTransaction(() => {
      const link = db.linkIdentityRowsInTx({ aId: customerId, bId: otherId, via: kind, by: operator, allowMerge: true });
      if (link.state !== "linked") return link;
      return { ...link, inherited: inheritWithinPerson({ customerId, via: kind, actor: operator }) };
    });
    if (result.state === "linked") {
      audit(operator, "identity_link_team", customerId, `เชื่อมกับ ${otherId} (${VIA_TEXT[kind]})`);
    }
    return result;
  }

  /** เอาห้องนี้ออกจากคนเดียวกัน — ถอนของที่คัดลอกทั้งสองทิศ */
  function unlink({ customerId, operator }) {
    const result = db.runIdentityLinkTransaction(() => {
      const rows = db.listLinkedIdentities(customerId);
      if (!rows.length) return { state: "not_linked" };
      const reopened = [];
      for (const row of rows) {
        if (row.customer_id === customerId) continue;
        if (undoInheritance(row.customer_id, { aboutId: customerId, actor: operator }).reopened) reopened.push(row.customer_id);
        if (undoInheritance(customerId, { aboutId: row.customer_id, actor: operator }).reopened) reopened.push(customerId);
      }
      const out = db.unlinkIdentityRowInTx(customerId);
      return { ...out, reopened: [...new Set(reopened)], others: rows.filter((row) => row.customer_id !== customerId).map((row) => row.customer_id) };
    });
    if (result.state === "unlinked") {
      audit(operator, "identity_unlink", customerId, `ยกเลิกการเชื่อมกับ ${result.others.join(", ")}`);
    }
    return result;
  }

  /* --------------------------------- ส่งลิงก์เชิญ --------------------------------- */

  // classType = คลาสที่ลูกค้าซื้อ (ทีมเลือกในแผง / โหมด auto ใช้หลักฐานการซื้อ) — ไม่มี = ไม่ส่ง
  // (ข้อความเชิญมีแต่แบบลูกค้าที่ซื้อแล้ว: พี่ง้วงให้ลูกค้าที่ยังไม่ซื้อ "อยู่ที่ facebook ก่อน")
  async function sendInvite({ customerId, operator = "system", via = "console", classType = "" }) {
    // ยังไม่รู้ LINE ID (ไม่ได้ตั้งค่า + บูตแล้วยังถามไม่สำเร็จ) = ถาม LINE ก่อนตัดสินว่าส่งได้ไหม
    if (!targetLineChannel()) await resolveBasicIds();
    const nowMs = now();
    const customer = safe(() => db.getCustomer(customerId), null);
    const blocker = inviteBlocker(customer, { via, nowMs });
    if (blocker) return { ok: false, reason: blocker };
    const type = normalizeClassType(classType);
    if (!type) return { ok: false, reason: "class_required" };
    const target = targetLineChannel();
    const code = generateLinkCode();
    const codeHash = hashLinkCode(code, secret());
    const url = lineOaMessageUrl(target.basicId, identityLinkPrefill(code));
    // 30 ก.ย. 2026 (พี่ง้วงทดลองรอบสาม: "ไปค้างหน้า add line ... ต้องกด open in browser ไม่สะดวก"): บอลลูนลิงก์ชี้หน้าของเราเอง
    // ที่พาออกจากเบราว์เซอร์ในแอป Facebook ให้ (identityLinkLanding.mjs) · ไม่มีโดเมนสาธารณะ = ใช้ลิงก์ line.me ตรงแบบเดิม
    const linkBubble = identityLandingUrl(landingBase(), code) || url;
    const text = identityInviteText({
      classType: type, code, basicId: target.basicId, knownName: customer.known_name, displayName: customer.display_name,
    });
    // บันทึกรหัสก่อนยิง — ลูกค้าที่กดไวกว่าการเขียนฐานต้องไม่เจอ "รหัสใช้ไม่ได้"
    const issued = db.insertIdentityLinkCode({ customerId, codeHash, via, by: operator, expiresAt: nowMs + CODE_TTL_MS, classType: type });
    let result;
    try {
      const client = lineRegistry.forChannel(customer.channel_id);
      const to = lineRegistry.rawUserId(customerId);
      // 30 ก.ย. 2026 (พี่ง้วงทดลองจริง: ลิงก์กดไม่ได้ + "ยาวไป ... ส่งเป็น 2 บอลลูน"): คำเชิญสั้นที่มีรหัส + ลิงก์ล้วนอีกบอลลูน
      result = await client.sendBubbles({ to, bubbles: identityInviteBubbles(text, linkBubble).map((part) => ({ text: part })), images: [], purpose: SEND_PURPOSE.operator });
    } catch (err) {
      result = { ok: false, error: String(err?.message || err) };
    }
    if (!result?.ok) {
      db.revokeIdentityLinkCode(codeHash);
      audit(operator, "identity_link_invite_failed", customerId, `ส่งลิงก์ LINE ไม่สำเร็จ (${result?.reason || result?.status || "error"})`);
      return { ok: false, reason: result?.blocked ? "send_disabled" : "send_failed" };
    }
    // ประวัติเก็บแบบปิดรหัส — รหัสที่ยังใช้ได้ห้ามค้างในห้องแชท/ไฟล์ export
    safe(() => db.insertMessage({
      customerId, direction: "out", channelId: customer.channel_id, msgType: "text",
      content: identityInviteBubbles(text, linkBubble).join("\n\n").split(code).join(MASKED_CODE), messageClass: "proactive",
      operator: via === "auto" ? "system" : operator,
      agentMode: via === "auto" ? "ai" : (customer.ai_enabled === 1 ? "operator_ai_on" : "operator_ai_off"),
      metadata: { identityLink: "invite", classType: type },
    }), null);
    audit(operator, "identity_link_invite", customerId, `ส่งลิงก์ LINE (${classLabel(type)}) · ${via} · หมดอายุ ${thaiDate(issued.expiresAt)}`);
    return { ok: true, classType: type, sentAt: issued.createdAt, expiresAt: issued.expiresAt };
  }

  /** โหมด auto: ส่งให้เองหนึ่งครั้งต่อห้อง Facebook เมื่อทีมติดป้าย customer / ยืนยันยอด (ไม่รอให้คอนโซลตอบช้า) */
  function maybeAutoInvite({ customerId, trigger = "", operator = "system" }) {
    try {
      if (identityLinkMode(db) !== "auto") return { skipped: "mode" };
      const customer = db.getCustomer(customerId);
      if (!isFacebookRoom(customer)) return { skipped: "not_facebook" };
      if (db.countIdentityLinkCodes({ customerId, via: "auto" }) > 0) return { skipped: "already_invited" };
      const blocker = inviteBlocker(customer, { via: "auto" });
      if (blocker) {
        audit("system", "identity_link_auto_skipped", customerId, `${trigger}: ${blocker}`);
        return { skipped: blocker };
      }
      // ส่งเองได้เฉพาะเมื่อ "การซื้อ" บอกคลาสชัดคลาสเดียว (ออเดอร์/ป้ายซื้อแล้ว) — ป้ายสนใจเป็นแค่คำใบ้ให้คน:
      // เชิญผิดคลาส = ลูกค้าได้ข้อความลงทะเบียนออนไลน์ทั้งที่ซื้อคลาสสด (ความผิดที่ลูกค้าเห็น) · ไม่แน่ใจ = ปักธงให้ทีมเลือกเอง
      const detected = detectClass(customerId);
      if (detected.source !== "purchase") {
        audit("system", "identity_link_auto_skipped", customerId, `${trigger}: class_unknown (${detected.source || "no_evidence"})`);
        safe(() => db.setNeedsHuman(customerId, "identity_link_class_unknown",
          "ลูกค้าซื้อแล้วแต่ระบบไม่แน่ใจว่าซื้อคลาสไหน — ยังไม่ได้ส่งลิงก์ LINE ให้อัตโนมัติ: "
          + "เปิดแผง \"ช่องทางอื่นของลูกค้าคนนี้\" เลือกคลาสแล้วกดส่งลิงก์เอง"), null);
        return { skipped: "class_unknown", candidates: detected.candidates };
      }
      setTimeout(() => {
        sendInvite({ customerId, operator: `auto:${operator}`.slice(0, 80), via: "auto", classType: detected.type })
          .catch((err) => logger.warn?.(`identityLink: ส่งลิงก์อัตโนมัติไม่สำเร็จ (${err?.message || err})`));
      }, 0);
      return { scheduled: true, classType: detected.type };
    } catch (err) {
      logger.warn?.(`identityLink: ตรวจการส่งลิงก์อัตโนมัติไม่สำเร็จ (${err?.message || err})`);
      return { skipped: "error" };
    }
  }

  /* ---------------------------- ขาเข้า LINE: รับรหัส ---------------------------- */

  // ลองทีละรหัส (ไม่เกินงบที่เหลือ) — ผลที่ดีที่สุดชนะ · บันทึกทีละรหัส (แนบหลายรหัส = เดาหลายครั้ง)
  // ใช้รหัส + เชื่อม + สืบทอด อยู่ในก้อนเดียว (พังกลางทาง = รหัสยังใช้ได้)
  function redeem(lineCustomerId, codes) {
    const rank = ["linked", "already_linked", "conflict", "expired", "consumed", "revoked", "not_found", "unavailable"];
    let best = { outcome: "not_found" };
    for (const code of codes) {
      const outcome = redeemOne(lineCustomerId, code);
      db.recordIdentityLinkAttempt({ customerId: lineCustomerId, outcome: outcome.outcome });
      if (rank.indexOf(outcome.outcome) < rank.indexOf(best.outcome)) best = outcome;
      if (best.outcome === "linked") break;
    }
    return best;
  }

  function redeemOne(lineCustomerId, code) {
    const codeHash = hashLinkCode(code, secret());
    if (!codeHash) return { outcome: "unavailable" };
    const row = db.findIdentityLinkCode(codeHash);
    if (!row) return { outcome: "not_found" };
    if (row.status === "consumed") return { outcome: row.redeemed_by === lineCustomerId ? "already_linked" : "consumed", sourceId: row.customer_id };
    if (row.status === "revoked") return { outcome: "revoked", sourceId: row.customer_id };
    if (Number(row.expires_at) <= now()) return { outcome: "expired", sourceId: row.customer_id };
    const source = db.getCustomer(row.customer_id);
    if (!isFacebookRoom(source)) return { outcome: "not_found" };
    const CONFLICT = Symbol("conflict");
    try {
      return db.runIdentityLinkTransaction(() => {
        if (!db.consumeIdentityLinkCodeInTx({ codeHash, redeemedBy: lineCustomerId })) return { outcome: "consumed", sourceId: row.customer_id };
        const link = db.linkIdentityRowsInTx({ aId: row.customer_id, bId: lineCustomerId, via: "code", by: "customer_code" });
        if (link.state === "already") return { outcome: "already_linked", sourceId: row.customer_id };
        if (link.state !== "linked") throw Object.assign(new Error("identity link conflict"), { [CONFLICT]: link.state });
        const classType = normalizeClassType(row.class_type);
        const inherited = applyInheritance({ sourceId: row.customer_id, targetId: lineCustomerId, via: "code", actor: "system", classType });
        return { outcome: "linked", sourceId: row.customer_id, inherited, classType };
      });
    } catch (err) {
      if (err && err[CONFLICT]) return { outcome: "conflict", sourceId: row.customer_id, reason: err[CONFLICT] };
      throw err;
    }
  }

  // งบเดารหัสที่เหลือ (นับทีละรหัส): "rate_limited" = ห้องนี้ส่งผิดเกินเพดานเอง (เงียบ ไม่ปลุกใคร)
  // "busy" = ทั้งระบบถูกยิงรหัสมั่วเกินเพดาน ห้องที่ไม่ได้ทำอะไรผิดโดนหางเลขไปด้วย — ยังไม่ตรวจรหัส (กันเดาสุ่ม)
  // แต่ปักธงให้ทีมเชื่อมมือแทน · budget = จำนวนรหัสที่ยังตรวจได้ในข้อความนี้
  function guessBudget(customerId, nowMs) {
    const room = IDENTITY_LINK_LIMITS.failuresPerRoomPerDay - db.countIdentityLinkFailures({ customerId, sinceMs: nowMs - DAY_MS });
    if (room <= 0) return { outcome: "rate_limited", budget: 0 };
    const system = IDENTITY_LINK_LIMITS.failuresPerHour - db.countIdentityLinkFailures({ sinceMs: nowMs - HOUR_MS });
    if (system <= 0) return { outcome: "busy", budget: 0 };
    return { outcome: "", budget: Math.min(room, system) };
  }

  // ผลของข้อความหลังเชื่อม (ทักทาย + รายละเอียดคลาส) — ข้อความเดียวกันทั้งธงรอคนในห้องและแจ้งเตือนทีม
  function deliveryText(delivery, classType) {
    const cls = classType ? classLabel(classType) : "คลาสที่ลูกค้าซื้อ";
    const manual = "รบกวนทักทายและส่งรายละเอียดเองในห้อง LINE นี้";
    switch (delivery) {
      case "sent": return "ระบบส่งคำทักทาย + รายละเอียดคลาสให้ลูกค้าแล้ว รบกวนดูแลต่อในห้อง LINE นี้";
      case "sent_fallback": return `ยังไม่มีข้อความรายละเอียดของ ${cls} ในหน้าตั้งค่า — ระบบทักทายแล้วบอกลูกค้าว่าทีมงานจะส่ง${
        IDENTITY_CLASSES[classType]?.format === "online" ? "ขั้นตอนลงทะเบียน" : "รายละเอียด"}ให้ในแชทนี้ รบกวนส่งเองในห้อง LINE นี้`;
      case "mode_off": return `สวิตช์ส่งลิงก์ต่อแชท LINE ปิดอยู่ ระบบจึงไม่ได้ส่งข้อความถึงลูกค้า — ${manual}`;
      case "paused": return `ระบบพัก AI ทั้งหมดอยู่ ยังไม่ได้ส่งข้อความถึงลูกค้า — ${manual}`;
      case "schedule_off": return `นอกเวลาทำการของบอท ยังไม่ได้ส่งข้อความถึงลูกค้า — ${manual}`;
      case "operator_active": return "มีคนในทีมกำลังตอบห้องนี้อยู่ ระบบจึงไม่ส่งซ้อน — รบกวนส่งรายละเอียดคลาสต่อในห้อง LINE นี้";
      case "blocked": return `ช่อง LINE ยังไม่เปิดส่งข้อความจริง ยังไม่ได้ส่งข้อความถึงลูกค้า — ${manual}`;
      default: return `ส่งข้อความถึงลูกค้าไม่สำเร็จ — ${manual}`;
    }
  }

  // แจ้งทีมทาง LINE (push ถึงแอดมิน · purpose team_alert ใน notify.mjs) หลังรู้ผลการส่งจริง
  // force = cooldown 10 นาที/ห้อง และคิวแจ้งเตือนที่ค้างอยู่กลืนไม่ได้ — การเชื่อมเกิดครั้งเดียว ไม่มีรอบสอง
  // ลิงก์เปิดห้องในคอนโซล notify.mjs ต่อท้ายให้เอง (consolePublicBaseUrl)
  function notifyLinked({ customerId, channelId, sourceId, buyer, classType = "", delivery = "" }) {
    const source = safe(() => db.getCustomer(sourceId), null);
    const lineRow = safe(() => db.getCustomer(customerId), null);
    const from = `ลูกค้าเดิมจาก Facebook (${nameOf(source) || "ไม่มีชื่อ"}) เข้ามาทาง LINE แล้ว`;
    notifier?.fireLater?.({
      customerId, channelId, reason: "identity_linked",
      customerName: nameOf(lineRow) || nameOf(source),
      reasonTextOverride: buyer
        ? `${from} — ซื้อ ${classType ? classLabel(classType) : "แล้ว (ไม่ได้ระบุคลาส)"} · ติดป้าย customer + AI เงียบให้แล้ว · ${deliveryText(delivery, classType)}`
        : `${from} — ยังไม่ได้ซื้อ: เชื่อมห้องให้แล้ว ลูกแพรคุยต่อพร้อมบริบทเดิมจาก Facebook`,
      force: true,
    });
  }

  // ลูกค้าที่ซื้อแล้วแต่ไม่ได้รายละเอียดครบจากระบบ = ธงรอคนบอกว่าต้องทำอะไร (ห้อง LINE เงียบ AI อยู่แล้ว)
  function flagWelcomeForTeam(customerId, classType, delivery) {
    safe(() => db.setNeedsHuman(customerId, "identity_link_welcome", deliveryText(delivery, classType)), null);
  }

  /**
   * ข้อความหลังเชื่อมของห้อง LINE นี้: "สวัสดีค่ะ คุณ{ชื่อ} 🙏" + ข้อความของคลาสที่เจ้าของอนุมัติ
   * ชื่อ: ของห้อง LINE ก่อน (ชื่อที่ลูกค้าใช้ในช่องทางนี้) — เรียกไม่ได้ค่อยใช้ชื่อฝั่ง Facebook ของคนเดียวกัน
   */
  function welcomeFor(customerId, classType, sourceId = "") {
    const row = safe(() => db.getCustomer(customerId), null);
    const source = sourceId ? safe(() => db.getCustomer(sourceId), null) : null;
    const names = customerCallName({ knownName: row?.known_name, displayName: row?.display_name })
      ? { knownName: row?.known_name, displayName: row?.display_name }
      : { knownName: source?.known_name, displayName: source?.display_name };
    const template = readIdentityTemplate(db, classType);
    return identityWelcomeBubbles({ classType, template: template.text, ...names });
  }

  // ห้อง LINE ใหม่ (ลูกค้ากดลิงก์แล้วส่งรหัสเป็นข้อความแรก) ยังไม่มีชื่อ — webhook ดึงโปรไฟล์แบบไม่รอ
  // ถามชื่อ LINE เองก่อนทักทาย (รอไม่เกิน 2 วินาที ไม่ได้ = ใช้ชื่อฝั่ง Facebook ของคนเดียวกัน)
  async function welcomeWithProfile(customerId, channelId, classType, sourceId) {
    if (!safe(() => db.getCustomer(customerId)?.display_name, "")) {
      let timer = null;
      try {
        const profile = await Promise.race([
          lineRegistry?.forChannel?.(channelId)?.getProfile?.({ userId: lineRegistry.rawUserId(customerId) }),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), PROFILE_WAIT_MS); timer.unref?.(); }),
        ]);
        if (profile?.displayName) db.setProfile(customerId, profile);
      } catch (err) {
        logger.debug?.(`identityLink: ดึงชื่อ LINE ก่อนทักทายไม่สำเร็จ (${err?.message || err}) — ใช้ชื่อฝั่ง Facebook`);
      } finally {
        clearTimeout(timer);
      }
    }
    return welcomeFor(customerId, classType, sourceId);
  }

  // ตอบใน LINE ตามคิวเดียวกับลูกแพร (ข้อความถัดไปของลูกค้าต้องไม่แซงคิว) — ด่านเดียวกับข้อความตอบรับรูป/ไฟล์
  // ใช้ reply token ของข้อความลูกค้า (ฟรี ไม่นับโควตา push) · onDone(ผล) ถูกเรียกครั้งเดียวเสมอ แม้กลางทางพัง
  // ด่านเดียวกับข้อความตอบรับรูป/ไฟล์: หยุด AI ทั้งระบบ · คนกำลังตอบห้องนี้ · นอกเวลาทำการของบอท — "" = ส่งได้
  function replyGate(customerId) {
    if (aiPausedNow({ db, config })) return "paused";
    if ((Number(db.getCustomer(customerId)?.operator_active_until) || 0) > Date.now()) return "operator_active";
    const sched = safe(() => scheduleState({ db }), null);
    return sched?.enabled && !sched.active ? "schedule_off" : "";
  }

  // agent_mode มีแค่ ai/operator_ai_on/operator_ai_off (KPI อ่านแบบนั้น) — ข้อความสำเร็จรูปของบอทใช้ "ai"
  // เหมือนข้อความตอบรับนอกเวลาทำการใน pipeline · metadata.identityLink แยกออกจากคำตอบที่ลูกแพรเขียนเอง
  function recordReplies({ customerId, channelId, texts, basisAt, kind }) {
    for (const content of texts) {
      safe(() => db.insertMessage({
        customerId, direction: "out", channelId, msgType: "text", content, messageClass: "reactive",
        agentMode: "ai", settleTurnsUpTo: basisAt, metadata: { identityLink: kind },
      }), null);
    }
  }

  // bubbles = รายการข้อความ หรือฟังก์ชัน (async ได้) ที่สร้างข้อความตอนจะส่งจริง — หลังผ่านด่านแล้วเท่านั้น
  function scheduleLineReply({ customerId, channelId, replyToken, bubbles, messageId, kind, onDone = null }) {
    const close = (status, reason) => safe(() => db.closeInboundTurn(messageId, { status, reason }), null);
    let reported = false;
    const report = (delivery) => {
      if (reported) return;
      reported = true;
      try { onDone?.(delivery); } catch (err) { logger.warn?.(`identityLink: แจ้งผลการส่งไม่สำเร็จ (${err?.message || err})`); }
    };
    const record = (texts, basisAt) => recordReplies({ customerId, channelId, texts, basisAt, kind });
    const work = async () => {
      const gate = replyGate(customerId);
      if (gate) {
        close("silent_by_design", `identity_link_${kind}:${gate === "paused" ? "ai_paused" : gate}`);
        return report(gate);
      }
      const inboundBasisAt = db.lastInboundAt(customerId) || 0;
      const texts = typeof bubbles === "function" ? await bubbles() : bubbles;
      let result;
      try {
        result = await lineRegistry.forChannel(channelId).sendBubbles({
          to: lineRegistry.rawUserId(customerId), replyToken, bubbles: texts.map((text) => ({ text })), images: [],
          purpose: SEND_PURPOSE.customerReply,
        });
      } catch (err) {
        result = { ok: false, error: String(err?.message || err) };
      }
      if (result?.ok) {
        report("sent");
        record(texts, inboundBasisAt);
        return null;
      }
      // push ล้มกลางชุด = บับเบิลที่ถึงลูกค้าแล้วต้องอยู่ในประวัติ (ทีมจะได้ไม่ส่งซ้ำ)
      const delivered = (Array.isArray(result?.delivered) ? result.delivered : [])
        .filter((message) => message?.type === "text").map((message) => String(message.text || ""));
      if (delivered.length) record(delivered, inboundBasisAt);
      if (result?.blocked) { close("silent_by_design", `identity_link_${kind}:blocked`); return report("blocked"); }
      close("stranded_error", `identity_link_${kind}_send_failed`);
      return report("failed");
    };
    const run = typeof pipeline?.runExclusive === "function" ? pipeline.runExclusive(customerId, work) : work();
    Promise.resolve(run)
      .catch((err) => logger.warn?.(`identityLink: ส่งข้อความหลังเชื่อมไม่สำเร็จ (${err?.message || err})`))
      .finally(() => report("failed"));
  }

  // ตรวจรหัสในข้อความ (ไม่เกินงบเพดาน) — ระบบพังกลางทาง = "error" (transaction ถอย รหัสยังใช้ได้)
  function checkCodes(customerId, tokens, nowMs) {
    try {
      const limit = guessBudget(customerId, nowMs);
      if (!limit.outcome) return redeem(customerId, tokens.slice(0, limit.budget).map((token) => token.code));
      db.recordIdentityLinkAttempt({ customerId, outcome: limit.outcome });
      return { outcome: limit.outcome };
    } catch (err) {
      logger.warn?.(`identityLink: ตรวจรหัสไม่สำเร็จ (${err?.message || err}) — ไม่เชื่อม`);
      return { outcome: "error" };
    }
  }

  // เชื่อมสำเร็จ: ซื้อแล้ว + สวิตช์เปิด = "สวัสดีค่ะ คุณ{ชื่อ}" + รายละเอียดคลาส (คำตอบพี่ง้วงข้อ 4) แล้วแจ้งทีมตามผลจริง
  // ไม่มีข้อความสำหรับคนที่ยังไม่ซื้อ (รหัสรุ่นก่อนมีคลาส) · สวิตช์ปิด = ไม่มีข้อความถึงลูกค้า (ทีมได้ธง + แจ้งเตือน)
  function onLinked({ result, customerId, channelId, messageId, replyToken, mode, templateOnly, close }) {
    const buyer = result.inherited?.buyer === true;
    const classType = result.classType || "";
    const report = (delivery) => notifyLinked({ customerId, channelId, sourceId: result.sourceId, buyer, classType, delivery });
    if (!buyer || mode === "off") {
      if (templateOnly) close("identity_link_linked");
      if (buyer) flagWelcomeForTeam(customerId, classType, "mode_off");
      report(buyer ? "mode_off" : "");
      return;
    }
    let welcome = null;
    scheduleLineReply({
      customerId, channelId, replyToken, messageId, kind: "welcome",
      bubbles: async () => {
        welcome = await welcomeWithProfile(customerId, channelId, classType, result.sourceId);
        return welcome.bubbles;
      },
      onDone: (sent) => {
        const delivery = sent === "sent" && welcome && !welcome.usedTemplate ? "sent_fallback" : sent;
        if (delivery !== "sent") flagWelcomeForTeam(customerId, classType, delivery);
        report(delivery);
      },
    });
  }

  // รหัสใช้ไม่ได้: ไม่ตอบลูกค้าเลย (พี่ง้วง: "ไม่ต้องครับ") — ปักธงรอคนอย่างเดียว ไม่ push ปลุกทีม
  // (คิวรอคน + บันได SLA ตามต่อให้เอง) · รหัสที่ไม่เคยมีจริงปนคำถามจริง = ไม่ปักธง ลูกแพรตอบคำถามตามปกติ
  function flagRejectedCode(customerId, outcome, templateOnly) {
    const busy = outcome === "busy";
    if (!busy && (outcome === "rate_limited" || !(FAILURE_OUTCOMES_WITH_REAL_CODE.has(outcome) || templateOnly))) return;
    flagNeedsHumanForTurn(db, customerId, {
      reason: "identity_link_review",
      message: busy
        ? "ระบบพักการตรวจรหัสเชื่อมแชทชั่วคราว (มีคนส่งรหัสมั่วเข้ามามาก) — ถ้าเป็นลูกค้าเดิม เชื่อมเองได้ในแผงช่องทางอื่น"
        : `รหัสเชื่อมแชทจาก Facebook ใช้ไม่ได้ (${OUTCOME_TEXT[outcome] || outcome}) — เชื่อมเองได้ในแผงช่องทางอื่น`,
      skipIfFlagged: true, logger,
    });
  }

  /**
   * ขาเข้า LINE (เรียกจาก webhook หลังบันทึกข้อความแล้ว) — ไม่มีรหัส = { matched: false } เดินเส้นเดิมทุกไบต์
   * @returns {{matched: boolean, done?: boolean, text?: string, outcome?: string}}
   *   done = ข้อความนี้จบที่นี่ (ไม่ส่งต่อให้ลูกแพร) · text = ข้อความที่ตัดรหัสออกแล้ว ให้ลูกแพรตอบส่วนที่เหลือ
   */
  function handleLineText({ channelId, customerId, text, messageId, replyToken = "" }) {
    const tokens = findLinkCodeTokens(text);
    if (!tokens.length) return { matched: false };
    const result = checkCodes(customerId, tokens, now());
    // ประวัติไม่เก็บรหัส (ทั้งที่ใช้ได้และใช้ไม่ได้) — ลูกแพรกับไฟล์ export ไม่ต้องเห็นมัน
    safe(() => db.maskIdentityLinkCodesInMessage(messageId), null);
    const cleaned = textWithoutLinkCodes(text);
    const templateOnly = isTemplateOnlyMessage(text);
    const close = (reason) => safe(() => db.closeInboundTurn(messageId, { status: "silent_by_design", reason }), null);
    const { outcome } = result;
    if (outcome !== "rate_limited") {
      audit("system", "identity_link_code_received", customerId, `รหัสเชื่อมแชท: ${outcome}${result.sourceId ? ` · ห้อง ${result.sourceId}` : ""}`);
    }
    if (outcome === "linked") {
      onLinked({ result, customerId, channelId, messageId, replyToken, mode: identityLinkMode(db), templateOnly, close });
      return { matched: true, outcome, done: templateOnly, text: cleaned };
    }
    if (outcome !== "already_linked") flagRejectedCode(customerId, outcome, templateOnly);
    if (!templateOnly) return { matched: true, outcome, done: false, text: cleaned };
    close(`identity_link_${outcome}`);
    return { matched: true, outcome, done: true };
  }

  /* ------------------------------ คอนโซล: แผง + แนะนำ ------------------------------ */

  const { panel, suggestions } = createIdentityLinkConsole({ db, now, core: { inviteBlocker, targetLineChannel, channelLabel, detectClass, landingBase } });

  return {
    handleLineText, sendInvite, maybeAutoInvite, linkByTeam, unlink, panel, suggestions,
    inviteBlocker, targetLineChannel, resolveBasicIds, channelLabel, detectClass, welcomeFor, landingBase,
  };
}

const OUTCOME_TEXT = Object.freeze({
  expired: "หมดอายุแล้ว", consumed: "ใช้ไปแล้ว", revoked: "ถูกแทนด้วยลิงก์ใหม่", conflict: "ห้องนี้เชื่อมกับลูกค้าคนอื่นอยู่แล้ว",
  not_found: "ไม่พบรหัสนี้", unavailable: "ระบบตรวจรหัสไม่ได้", error: "ระบบขัดข้อง",
});

