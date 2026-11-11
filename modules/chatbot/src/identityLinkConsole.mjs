// identityLinkConsole.mjs — มุมมองคอนโซลของการเชื่อมลูกค้าข้าม Facebook ↔ LINE (อ่านอย่างเดียว · แยกจาก identityLink.mjs)
//   panel()       ข้อมูลแผง "ช่องทางอื่นของลูกค้าคนนี้" + ตัวเลือกคลาส/ข้อความเชิญตัวอย่าง (รหัสปิดเสมอ)
//   suggestions() ห้องที่อาจเป็นคนเดียวกัน — คนยืนยันเท่านั้น
//   samePersonResolution / linkedIdentityLines = ตัวช่วยของแชทเจ้าของ (นับห้องที่เชื่อมกันเป็นคนเดียว)
// ส่วนที่เขียน/ส่งข้อความทั้งหมดอยู่ identityLink.mjs — ไฟล์นี้ไม่เขียนฐาน ไม่ส่งอะไรถึงใคร
import { DEFAULT_CHANNEL_ID, FACEBOOK_CHANNEL_ID } from "./channels.mjs";
import { LEGACY_SOURCE_TAG } from "./legacyLink.mjs";
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { similarity } from "./customerResolver.mjs";
import { MASKED_CODE, identityLinkMode, lineOaMessageUrl } from "./identityLinkCodes.mjs";
import {
  IDENTITY_CLASSES, IDENTITY_CLASS_TYPES, classLabel, identityInviteBubbles, identityInviteText, normalizeClassType,
} from "./identityLinkClasses.mjs";
import { identityLandingUrl } from "./identityLinkLanding.mjs";
import { DAY_MS, IDENTITY_LINK_CAPABILITY, VIA_TEXT, identityIsBuyer, isFacebookRoom, nameOf, safe } from "./identityLinkShared.mjs";

/**
 * @param {{db: object, now?: () => number, core: {inviteBlocker: Function, targetLineChannel: Function,
 *   channelLabel: Function, detectClass: Function}}} deps  core = ตัวตัดสินจาก identityLink (ชุดเดียวกับตอนส่งจริง)
 */
export function createIdentityLinkConsole({ db, now = Date.now, core }) {
  const { inviteBlocker, targetLineChannel, channelLabel, detectClass } = core;

  const inheritedClass = (row) => normalizeClassType(safe(() => JSON.parse(String(row?.inherited_json || "{}")), {})?.classType);

  function describeIdentity(row) {
    const classType = inheritedClass(row);
    return {
      id: row.customer_id,
      channelId: row.channel_id,
      channelLabel: channelLabel(row.channel_id),
      name: nameOf(row) || "ลูกค้า",
      linkedVia: row.linked_via,
      linkedBy: row.linked_via === "code" ? "" : row.linked_by,
      linkedAt: Number(row.created_at) || 0,
      aiEnabled: Number(row.ai_enabled) === 1,
      needsHuman: row.state === "NEEDS_HUMAN",
      classType,
      classLabel: classType ? classLabel(classType) : "",
    };
  }

  // ตัวเลือกคลาสบนปุ่มส่งลิงก์ (เลือกไว้ให้จากหลักฐาน — คนยืนยันก่อนส่งเสมอ) + ข้อความเชิญตัวอย่างต่อคลาส
  // ตัวอย่างใช้รหัสปิด LK-•••••-••••• — รหัสจริงเกิดตอนกดส่งเท่านั้น (ไม่มีรหัสค้างในเบราว์เซอร์)
  function inviteChoices(customer, target) {
    const detected = detectClass(customer.line_user_id);
    // บอลลูนลิงก์ = หน้า /r/line ของเรา (พาออกจากเบราว์เซอร์ในแอป Facebook) · ไม่มีโดเมนสาธารณะ = ลิงก์ line.me ตรง
    const previewUrl = identityLandingUrl(core.landingBase?.(), MASKED_CODE)
      || (target ? `${lineOaMessageUrl(target.basicId, "")}${MASKED_CODE}` : "");
    const previews = {};
    for (const type of IDENTITY_CLASS_TYPES) {
      // ตัวอย่างโชว์ทั้งสองบอลลูนที่ลูกค้าจะได้ (คำเชิญที่มีรหัส + ลิงก์ล้วน)
      previews[type] = identityInviteBubbles(identityInviteText({
        classType: type, code: MASKED_CODE, basicId: target?.basicId || "",
        knownName: customer.known_name, displayName: customer.display_name,
      }), previewUrl).join("\n\n");
    }
    return {
      classes: IDENTITY_CLASS_TYPES.map((type) => ({ type, label: IDENTITY_CLASSES[type].label, hint: IDENTITY_CLASSES[type].hint })),
      suggestedClass: detected.type,
      suggestedFrom: detected.source,
      candidates: detected.candidates,
      buyerEvidence: identityIsBuyer(db, customer.line_user_id),
      previews,
    };
  }

  /** ข้อมูลแผง "ช่องทางอื่นของลูกค้าคนนี้" — ไม่มีรหัสดิบ/ไม่มี hash ออกไปถึงเบราว์เซอร์ */
  function panel(customerId, { operator = null } = {}) {
    const customer = safe(() => db.getCustomer(customerId), null);
    if (!customer) return null;
    const rows = safe(() => db.listLinkedIdentities(customerId), []);
    const mode = identityLinkMode(db);
    const target = targetLineChannel();
    let invite = null;
    if (isFacebookRoom(customer)) {
      const last = safe(() => db.latestIdentityLinkCode(customerId), null);
      invite = {
        blocker: inviteBlocker(customer),
        lastSentAt: last ? Number(last.created_at) : null,
        lastExpiresAt: last ? Number(last.expires_at) : null,
        lastStatus: last ? (last.status === "active" && Number(last.expires_at) <= now() ? "expired" : last.status) : "",
        lastClassType: last ? normalizeClassType(last.class_type) : "",
        ...inviteChoices(customer, target),
      };
    }
    const personClass = rows.map(inheritedClass).find(Boolean) || "";
    return {
      mode,
      canManage: hasOperatorCapability(operator, IDENTITY_LINK_CAPABILITY),
      linked: rows.filter((row) => row.customer_id !== customerId).map(describeIdentity),
      invite,
      purchasedClass: personClass ? { type: personClass, label: classLabel(personClass) } : null,
      lineBasicId: target?.basicId || "",
    };
  }

  /** ห้องที่อาจเป็นคนเดียวกัน — ให้คนยืนยันเท่านั้น (เบอร์/อีเมลตรงเป๊ะ = หลักฐานดี · ชื่อคล้าย = คำใบ้อ่อน) */
  function suggestions(customerId, { q = "", limit = 6 } = {}) {
    const customer = db.getCustomer(customerId);
    if (!customer) return [];
    const ownChannel = String(customer.channel_id || DEFAULT_CHANNEL_ID);
    const samePerson = new Set(safe(() => db.listLinkedIdentities(customerId), []).map((row) => row.customer_id));
    samePerson.add(customerId);
    const found = new Map();
    const add = (id, reason) => {
      if (samePerson.has(id)) return;
      const entry = found.get(id) || { id, reasons: new Set() };
      entry.reasons.add(reason);
      found.set(id, entry);
    };
    const mine = contactKeys(db.identityContactValues(customerId));
    if (mine.phones.size || mine.emails.size) {
      const every = db.allIdentityContactValues();
      for (const row of every.facts) {
        if (row.fact_key === "contact_phone" && mine.phones.has(normalizePhone(row.value))) add(row.customer_id, "phone");
        if (row.fact_key === "contact_email" && mine.emails.has(normalizeEmail(row.value))) add(row.customer_id, "email");
      }
      for (const row of every.orders) {
        const ship = safe(() => JSON.parse(row.shipping_json), {}) || {};
        if (mine.phones.has(normalizePhone(ship.phone))) add(row.customer_id, "phone");
        if (mine.emails.has(normalizeEmail(ship.email))) add(row.customer_id, "email");
      }
    }
    // 30 ก.ย. 2026 (พี่ง้วง: "LINE ใช้ชื่อเล่น ชื่อไม่ตรงกับ Facebook"): จังหวะเวลาเป็นคำใบ้ที่ดีกว่าชื่อ
    //   ห้อง LINE → ห้อง Facebook ที่ลิงก์เชิญยังไม่มีใครใช้ ส่งใน 24 ชม. ก่อนห้องนี้เริ่มคุย/แอดเพื่อน
    //   ห้อง Facebook ที่มีลิงก์ค้าง → ห้อง LINE ที่เริ่มคุย/แอดเพื่อนใน 24 ชม. หลังส่งลิงก์
    const timing = new Map(); // id → เวลาห่าง (ms) ไว้เรียง/แสดง
    const onFacebook = ownChannel === FACEBOOK_CHANNEL_ID;
    if (!onFacebook) {
      const seenAt = Number(safe(() => db.lineRoomSeenAt(customerId), 0)) || now();
      for (const row of safe(() => db.openIdentityInvites({ sinceMs: seenAt - DAY_MS, untilMs: seenAt, nowMs: now() }), [])) {
        add(String(row.customer_id), "invite");
        if (!timing.has(String(row.customer_id))) timing.set(String(row.customer_id), seenAt - Number(row.created_at));
      }
    } else {
      const open = safe(() => db.openIdentityInvites({ sinceMs: now() - 30 * DAY_MS, nowMs: now(), limit: 50 }), [])
        .find((row) => String(row.customer_id) === String(customerId));
      if (open) {
        for (const row of safe(() => db.newLineRoomsBetween({ sinceMs: Number(open.created_at), untilMs: Number(open.created_at) + DAY_MS }), [])) {
          add(String(row.line_user_id), "new_friend");
          timing.set(String(row.line_user_id), Number(row.seen_at) - Number(open.created_at));
        }
      }
    }
    const rooms = db.listIdentityCandidateRooms({ sinceMs: now() - 180 * DAY_MS });
    const byId = new Map(rooms.map((row) => [row.line_user_id, row]));
    const myNames = [customer.known_name, customer.display_name].map(nameKey).filter((name) => [...name].length >= 3);
    const query = nameKey(q);
    for (const row of rooms) {
      if (String(row.channel_id || DEFAULT_CHANNEL_ID) === ownChannel || samePerson.has(row.line_user_id)) continue;
      const names = [row.known_name, row.display_name].map(nameKey).filter(Boolean);
      if (query && names.some((name) => name.includes(query))) add(row.line_user_id, "search");
      else if (!query && myNames.some((mine) => names.some((name) => similarity(mine, name) >= 0.8))) add(row.line_user_id, "name");
    }
    const out = [];
    for (const entry of found.values()) {
      const row = byId.get(entry.id) || safe(() => db.getCustomer(entry.id), null);
      if (!row || String(row.channel_id || DEFAULT_CHANNEL_ID) === ownChannel) continue;
      // ห้องอ้างอิงจากระบบ LINE OA เดิมไม่ใช่ห้องที่ส่งถึงลูกค้าได้ (id คนละชุด — legacyLink.mjs)
      if (!byId.has(entry.id) && safe(() => db.listTags(entry.id), []).some((tag) => tag.tag === LEGACY_SOURCE_TAG)) continue;
      const reasons = [...entry.reasons];
      out.push({
        id: entry.id, channelId: row.channel_id, channelLabel: channelLabel(row.channel_id), name: nameOf(row) || "ลูกค้า",
        reasons, strong: reasons.includes("phone") || reasons.includes("email"),
        timingMs: timing.has(entry.id) ? Math.max(0, timing.get(entry.id)) : null,
        lastMessageAt: Number(row.last_message_at || safe(() => db.lastInboundAt(entry.id), 0)) || null,
        linkedElsewhere: Boolean(safe(() => db.identityPersonOf(entry.id), null)),
      });
    }
    // หลักฐานจริง (เบอร์/อีเมล) ก่อน → จังหวะเวลา (ห่างน้อยก่อน) → ที่เหลือตามความเคลื่อนไหวล่าสุด
    return out.sort((a, b) => Number(b.strong) - Number(a.strong)
      || Number(a.timingMs == null) - Number(b.timingMs == null)
      || (a.timingMs ?? 0) - (b.timingMs ?? 0)
      || Number(b.lastMessageAt || 0) - Number(a.lastMessageAt || 0)).slice(0, limit);
  }

  return { panel, suggestions };
}

function nameKey(value) {
  return String(value ?? "").normalize("NFC").toLowerCase().replace(/^\s*(?:คุณ|k\.)\s*/u, "").replace(/\s+/gu, " ").trim();
}

export function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/gu, "");
  if (digits.startsWith("66") && digits.length === 11) digits = `0${digits.slice(2)}`;
  return /^0\d{8,9}$/u.test(digits) ? digits : "";
}

export function normalizeEmail(value) {
  const text = String(value ?? "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(text) ? text : "";
}

function contactKeys({ facts = [], orders = [] } = {}) {
  const phones = new Set();
  const emails = new Set();
  for (const row of facts) {
    if (row.fact_key === "contact_phone" && normalizePhone(row.value)) phones.add(normalizePhone(row.value));
    if (row.fact_key === "contact_email" && normalizeEmail(row.value)) emails.add(normalizeEmail(row.value));
  }
  for (const row of orders) {
    let ship = {};
    try { ship = JSON.parse(row.shipping_json) || {}; } catch { ship = {}; }
    if (normalizePhone(ship.phone)) phones.add(normalizePhone(ship.phone));
    if (normalizeEmail(ship.email)) emails.add(normalizeEmail(ship.email));
  }
  return { phones, emails };
}

/**
 * ชื่อเดียวกันหลายห้องที่ "เชื่อมเป็นคนเดียวกันแล้ว" (Facebook ↔ LINE) = คนเดียว ไม่ต้องถามพี่ง้วงว่าห้องไหน
 * ใช้กับงานอ่านอย่างเดียว (แชทเจ้าของ/ค้นห้อง) เท่านั้น — YOLO/สั่งงานที่ส่งข้อความยังต้องเลือกห้องเอง
 * @returns resolution เดิม หรือ { status: "unique", samePerson: true, matches: [ห้องที่คุยล่าสุด], linkedIds }
 */
export function samePersonResolution(db, resolution) {
  if (resolution?.status !== "ambiguous") return resolution;
  const matches = Array.isArray(resolution.matches) ? resolution.matches : [];
  if (matches.length < 2 || Number(resolution.total || matches.length) > matches.length) return resolution;
  const persons = new Set(matches.map((match) => {
    try { return db.identityPersonOf(match.id) || `room:${match.id}`; } catch { return `room:${match.id}`; }
  }));
  const [only] = [...persons];
  if (persons.size !== 1 || only.startsWith("room:")) return resolution;
  const newest = [...matches].sort((a, b) => Number(b.lastMessageAt || 0) - Number(a.lastMessageAt || 0))[0];
  return {
    status: "unique", query: resolution.query, matches: [newest], loose: matches.every((match) => Number(match.tier) > 1),
    hasSimilar: false, similar: [], suggestions: [], samePerson: true, linkedIds: matches.map((match) => match.id),
  };
}

/** บรรทัดบริบท "ช่องทางอื่นของคนเดียวกัน" สำหรับแชทเจ้าของ/ค้นห้อง — ไม่มี id ดิบ */
export function linkedIdentityLines(db, customerId) {
  const rows = (() => { try { return db.listLinkedIdentities(customerId); } catch { return []; } })()
    .filter((row) => row.customer_id !== customerId);
  if (!rows.length) return [];
  const text = rows.map((row) => `${row.channel_id === FACEBOOK_CHANNEL_ID ? "Facebook" : "LINE"} (${VIA_TEXT[row.linked_via] || row.linked_via})`);
  return [`  ช่องทางอื่นของลูกค้าคนเดียวกัน: ${text.join(" · ")} — นับเป็นคนเดียว ไม่ใช่ลูกค้าสองคน`];
}
