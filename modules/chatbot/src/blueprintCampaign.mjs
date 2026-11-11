import { createHash } from "node:crypto";
// blueprintCampaign.mjs — ขาเข้าของแคมเปญ #AIAGENT (คลาส IESA S-Curve MBA รุ่น 6, 11 ต.ค. 2026)
//
// คำสั่งพี่ง้วง 04:15 "เอาให้ไม่กระทบระบบเดิม" — ทุกอย่างในไฟล์นี้ถูกเรียกจากจุดเดียวใน pipeline.mjs
// และจะทำงานก็ต่อเมื่อ (1) มีแคมเปญที่เปิดอยู่ในตาราง settings (2) ข้อความ LINE "ขึ้นต้น" ด้วยคีย์เวิร์ดของแคมเปญ
// (3) ยังไม่พ้นช่วงแคมเปญ — นอกนั้น match() คืน null แล้ว pipeline เดินเส้นเดิมทุกไบต์
//
// เมื่อเข้าเงื่อนไข (ทำในคิวของลูกค้าคนนั้น ลำดับเดียวกับคำตอบปกติ):
//   1) แยกธุรกิจ/คำตอบ (blueprintIntakeParse) แล้วเก็บ blueprint_req:<campaignId>:<customerId> (ส่งซ้ำ = ล่าสุดชนะ)
//   2) พัก follow-up ของคนนี้คนเดียวถึง sendAt + followupOffDays (แบบ CAS บนแถวลูกค้า จำค่าเดิมไว้คืนทีหลัง)
//   3) ติดป้ายของทีม (ค่าเริ่มต้น "ที่มา: IESA6 · AI Agent") + โน้ตที่มา (เขียนเฉพาะเมื่อยังว่าง)
//   4) ตอบรับครั้งเดียวด้วย buildAckMessages (reply token ฟรี) — ไม่มีคำตอบ AI ปกติสำหรับข้อความนี้
// ข้อความถัดไปที่ไม่ขึ้นต้นด้วยคีย์เวิร์ด = ลูกแพรคุยตามปกติ (ไฟล์นี้ไม่แตะ)
import { aiPausedForReactiveCustomer } from "./aiPause.mjs";
import { FACEBOOK_CHANNEL_ID } from "./channels.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
import { checkHumanTag } from "./tagFramework.mjs";
import { activeTagFramework } from "./tagFrameworkMode.mjs";
import { campaignForText, keywordRegex, readCampaigns } from "./blueprintCampaignConfig.mjs";
import { parseBlueprintSubmission } from "./blueprintIntakeParse.mjs";
import { readEntry, updateEntry } from "./blueprintStore.mjs";
import { blueprintContent } from "./blueprintContent.mjs";

const DAY_MS = 86_400_000;
export const BLUEPRINT_ROUTE = "blueprint_campaign";

/** ข้อความทั้งหมดในก้อนข้อความ LINE (text + ทุก text ใน Flex) — ใช้ตรวจ compliance และบันทึกประวัติ */
export function messageTexts(message) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (typeof node.text === "string" && node.text.trim()) out.push(node.text);
    if (typeof node.altText === "string" && node.altText.trim()) out.push(node.altText);
    for (const [key, value] of Object.entries(node)) {
      if (key !== "text" && key !== "altText" && value && typeof value === "object") walk(value);
    }
  };
  walk(message);
  return out;
}

/** แถวประวัติแชทของข้อความขาออกหนึ่งก้อน (Flex = สรุปหัวเรื่อง ไม่ใช่ JSON ทั้งก้อน) */
export function historyRowFor(message) {
  if (message?.type === "text") return { msgType: "text", content: String(message.text || "") };
  if (message?.type === "flex") {
    const cards = message.contents?.type === "carousel" ? (message.contents.contents || []).length : 1;
    return { msgType: "text", content: `[การ์ด ${cards} ใบ] ${String(message.altText || "").trim()}`.trim() };
  }
  return { msgType: "text", content: `[${String(message?.type || "unknown")}]` };
}

/** ช่องส่งของลูกค้าคนนี้ (สาขา LINE ของห้อง + LINE id ดิบ) — กติกาเดียวกับ outboundFor ของ pipeline */
/** UUID v4 รูปแบบคงที่จาก (แคมเปญ, ลูกค้า, ครั้งที่ส่ง) — X-Line-Retry-Key ต้องเป็น UUID */
function ackRetryKey(campaignId, customerId, submissions = 1) {
  const h = createHash("sha256").update(`bp-ack|${campaignId}|${customerId}|${Number(submissions) || 1}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16], 16) & 3) | 8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function outboundLineFor({ lineRegistry = null, line = null }, customerId, customer = null) {
  if (!lineRegistry) return { lineCh: line, to: customerId };
  const channelId = customer?.channel_id || lineRegistry.channelIdOf(customerId);
  return { lineCh: lineRegistry.forChannel(channelId), to: lineRegistry.rawUserId(customerId) };
}

/**
 * พัก FU ของลูกค้าคนเดียว จำค่าเดิมไว้คืนทีหลัง (CAS บนแถวลูกค้า)
 *   FU เปิดอยู่ (1)                       → ปิด + ปักธงคนเลือก · คืนเป็น 1
 *   FU ปิดแบบ "ยังไม่มีใครตัดสิน" (0/0/ไม่มีเหตุ) — ห้องฐานเดิมส่วนใหญ่ของ @pngoung
 *                                         → ปักธงคนเลือกอย่างเดียว ให้ recordScore ไม่เปิด FU เองระหว่างพัก · คืนเป็น 0/0
 *   ทีม/ลูกค้าปิดไว้แล้ว (ธงคน หรือมีเหตุหยุด) → ไม่แตะ ไม่จำ ไม่คืน
 *   ห้องรอโอน (awaiting_payment)           → ไม่แตะ: FU ปกติปิด = ตัวทักเบา ๆ ของการชำระเงินเริ่มทำงาน (เปลี่ยนเส้นเดิม)
 */
export function applyFollowupHold(db, customerId, { until, at }) {
  const customer = db.getCustomer(customerId);
  if (!customer) return { applied: false, reason: "no_customer", until };
  if (String(customer.deal_status || "") === "awaiting_payment") return { applied: false, reason: "payment_flow", until };
  if (Number(customer.followup_enabled) === 1) {
    const prior = { enabled: 1, choice: Number(customer.followup_choice_by_human) === 1 ? 1 : 0 };
    const changed = db.raw.prepare(
      `UPDATE customers SET followup_enabled = 0, followup_choice_by_human = 1, updated_at = ?
        WHERE line_user_id = ? AND followup_enabled = 1`,
    ).run(Number(at), String(customerId)).changes === 1;
    return changed ? { applied: true, prior, until, appliedAt: at } : { applied: false, reason: "changed_concurrently", until };
  }
  const undecided = Number(customer.followup_choice_by_human) !== 1 && !String(customer.followup_suppression_reason || "");
  if (!undecided) return { applied: false, reason: "already_off", until };
  const changed = db.raw.prepare(
    `UPDATE customers SET followup_choice_by_human = 1, updated_at = ?
      WHERE line_user_id = ? AND followup_enabled = 0 AND followup_choice_by_human = 0 AND followup_suppression_reason = ''`,
  ).run(Number(at), String(customerId)).changes === 1;
  return changed ? { applied: true, prior: { enabled: 0, choice: 0 }, until, appliedAt: at } : { applied: false, reason: "changed_concurrently", until };
}

/** ทีมกดสวิตช์ FU ของห้องนี้เองหลังเวลาที่เราพัก (คอนโซลจด followup_toggle ทุกครั้ง) */
function humanToggledSince(db, customerId, sinceMs) {
  if (!(Number(sinceMs) > 0)) return false;
  try {
    return Boolean(db.raw.prepare(
      "SELECT 1 AS hit FROM admin_audit WHERE action = 'followup_toggle' AND target = ? AND created_at >= ? LIMIT 1",
    ).get(String(customerId), Number(sinceMs)));
  } catch {
    return false;
  }
}

/**
 * คืน FU เป็นค่าเดิม เฉพาะเมื่อห้องยังอยู่ในสภาพที่เราพักไว้ (ปิด + ปักธงคนเลือก + ไม่มีเหตุหยุดจากลูกค้า)
 * ถ้าทีมกดเปลี่ยนเอง (แม้กดปิดซึ่งหน้าตาเหมือนที่เราพักทุกช่อง — ดูจาก audit) หรือลูกค้าบอก "ขอคิดก่อน" = การตัดสินใจนั้นชนะ ไม่คืน
 * ห้ามใช้ setFollowupEnabled(true): ตัวนั้นล้างเหตุหยุดของลูกค้าและปลดพักเส้นบริการด้วย
 */
export function releaseFollowupHold(db, customerId, hold, { at }) {
  if (!hold?.applied) return "not_applied";
  if (humanToggledSince(db, customerId, hold.appliedAt)) return "kept_human_toggle";
  const changed = db.raw.prepare(
    `UPDATE customers SET followup_enabled = ?, followup_choice_by_human = ?, updated_at = ?
      WHERE line_user_id = ? AND followup_enabled = 0 AND followup_choice_by_human = 1
        AND followup_suppression_reason = ''`,
  ).run(Number(hold.prior?.enabled) === 1 ? 1 : 0, Number(hold.prior?.choice) === 1 ? 1 : 0, Number(at), String(customerId)).changes === 1;
  return changed ? "restored" : "kept_later_change";
}

const IN_FLIGHT = new Set(["pending", "ready", "sending"]);

function nextEntry(current, { campaign, customerId, channelId, parsed, turnId, at }) {
  if (current && turnId && current.lastTurnId === turnId) return null; // ข้อความเดิมถูกส่งเข้ามาซ้ำ (เล่นซ้ำ/กู้คืน)
  // เส้นเดิมที่ "ส่งข้อความค้างเข้าไปตอบใหม่" (เปิด AI กลับหลังตรวจไฟล์ / ยืนยันลิงก์บัญชี / คัดกรองเขียว) ไม่มี turnId
  // ข้อความเดิมเล่นซ้ำแบบนี้ไม่ใช่คำขอใหม่ — ไม่ทิ้งร่าง ไม่นับเพิ่ม ไม่ตอบรับซ้ำ (f0ac79dc ก็เงียบให้)
  if (current && !turnId && current.rawText === parsed.rawText) return null;
  // กดส่งข้อความเดิมเป๊ะซ้ำระหว่างรอสร้าง/รอส่ง = นับครั้ง แต่ไม่ทิ้งร่างและไม่เรียกโมเดลใหม่ (กันเผาเพดานเงิน)
  if (current && current.rawText === parsed.rawText && IN_FLIGHT.has(current.status)) {
    return {
      ...current, submissions: (Number(current.submissions) || 0) + 1,
      lastTurnId: turnId || "", lastReceivedAt: at,
    };
  }
  const base = current ?? {
    v: 1, campaignId: campaign.campaignId, customerId, channelId,
    firstReceivedAt: at, submissions: 0, rev: 0, status: "pending", attempts: 0, sendCount: 0,
  };
  const next = {
    ...base,
    channelId: channelId || base.channelId,
    business: parsed.business, answer: parsed.answer, rawText: parsed.rawText,
    receivedAt: at, submissions: (Number(base.submissions) || 0) + 1, rev: (Number(base.rev) || 0) + 1,
    lastTurnId: turnId || "",
  };
  if (base.status === "sending") return { ...next, requeue: true }; // กำลังส่งของรอบก่อน — ส่งเสร็จแล้วค่อยทำรอบใหม่
  const { draft, lastError, ...rest } = next;
  return { ...rest, status: "pending", attempts: 0, requeue: false };
}

export function createBlueprintCampaign({
  db, config = {}, lineRegistry = null, line = null, guard = null, tagFramework = null,
  processId = "", logger = console, now = Date.now,
} = {}) {
  const lineFor = (customerId, customer) => outboundLineFor({ lineRegistry, line }, customerId, customer);

  function isFacebookRoom(customerId, channelId) {
    if (channelId === FACEBOOK_CHANNEL_ID) return true;
    const channel = lineRegistry?.channels?.find?.((ch) => ch.id === channelId);
    return channel?.provider === "facebook";
  }

  /**
   * ข้อความนี้เป็นของแคมเปญไหม — อ่านอย่างเดียว ไม่เขียนอะไร · ทุกความผิดพลาด = null (pipeline เดินเส้นเดิม)
   * @returns {{ campaign: object, channelId: string } | null}
   */
  function match({ customerId, text }) {
    try {
      if (!customerId || String(customerId).startsWith("canary:")) return null;
      if (!blueprintContent()) return null; // โมดูลเนื้อหาโหลดไม่ได้ = ปิดแคมเปญ ไม่รับปากสิ่งที่ส่งไม่ได้
      const t = now();
      const campaign = campaignForText(text, readCampaigns(db).filter((c) => c.enabled && t < c.expiresAtMs));
      if (!campaign) return null;
      const customer = db.getCustomer(customerId);
      const channelId = String(customer?.channel_id || lineRegistry?.channelIdOf?.(customerId) || "default");
      if (isFacebookRoom(customerId, channelId)) return null;
      const entry = readEntry(db, campaign.campaignId, customerId);
      // ได้ครบจำนวนที่แคมเปญให้แล้ว = ส่งต่อให้เส้นเดิม (ไม่รับปากซ้ำในสิ่งที่จะไม่ส่ง)
      if (entry?.status === "sent" && Number(entry.sendCount) >= campaign.maxSendsPerPerson) return null;
      return { campaign, channelId };
    } catch (err) {
      logger.warn?.(`blueprint: ตรวจคีย์เวิร์ดแคมเปญไม่สำเร็จ (${err?.message || err}) — เดินเส้นเดิม`);
      return null;
    }
  }

  function applyTag(customerId, campaign) {
    if (!campaign.tag) return null;
    try {
      const framework = activeTagFramework(db, tagFramework);
      let tag = campaign.tag;
      if (framework) {
        const check = checkHumanTag(campaign.tag, framework);
        if (!check.ok) {
          logger.warn?.(`blueprint: ป้าย ${campaign.campaignId} ไม่ผ่านกรอบป้าย (${check.reason}) — ไม่ติด`);
          return null;
        }
        tag = check.tag;
      }
      if (!db.addTag(customerId, tag, "human")) return null;
      db.addAudit({ operator: "system", action: "blueprint_tag", target: customerId, detail: `${campaign.campaignId} → ${tag}`.slice(0, 200) });
      return tag;
    } catch (err) {
      logger.warn?.(`blueprint: ติดป้ายไม่สำเร็จ (${err?.message || err})`);
      return null;
    }
  }

  function holdFollowup(customerId, campaign, entry, at) {
    if (entry?.hold || campaign.followupOffDays <= 0) return;
    const until = Math.max(campaign.sendAtMs, at) + campaign.followupOffDays * DAY_MS;
    const hold = applyFollowupHold(db, customerId, { until, at });
    updateEntry(db, campaign.campaignId, customerId, (current) => (current && !current.hold ? { ...current, hold } : null));
    db.addAudit({
      operator: "system", action: "blueprint_followup_hold", target: customerId,
      detail: `${campaign.campaignId} พัก FU ถึง ${new Date(until).toISOString()} (${hold.applied ? "พักแล้ว" : hold.reason})`,
    });
  }

  /**
   * ใบตอบรับต้องไม่ "ปิดคิวรอของทีม" — ห้องที่ AI ปิด / รอคนรับต่อ / แอดมินกำลังตอบ / มีข้อความลูกค้าก่อนหน้ายังค้างตอบ
   * ส่งเป็น proactive (ไม่ปิดเทิร์นเก่าเป็น answered และ KPI ไม่ตัดเวลารอของลูกค้า) — f0ac79dc เงียบให้ # ห้องจึงค้างให้ทีมเห็น
   * ห้องปกติ (AI คุยอยู่ ไม่มีอะไรค้าง) = reactive เหมือนคำตอบทั่วไป
   */
  function ackKeepsTeamQueue(customer, customerId, turnId) {
    if (Number(customer?.ai_enabled) !== 1) return "ai_off"; // รวมห้องคัดกรองเหลือง / เส้นเงิน / ป้ายลูกค้า
    if (String(customer?.state || "") === "NEEDS_HUMAN") return "needs_human";
    if ((Number(customer?.operator_active_until) || 0) > now()) return "operator_active";
    try {
      const owed = db.raw.prepare(
        `SELECT 1 AS hit FROM inbound_turn_outcomes
          WHERE customer_id = ? AND status IN ('owed','sending') AND message_id != ? LIMIT 1`,
      ).get(String(customerId), String(turnId || ""));
      if (owed) return "earlier_turn_owed";
    } catch { /* อ่านบัญชีเทิร์นไม่ได้ = ถือว่าไม่มีค้าง (เส้นปกติ) */ }
    return "";
  }

  async function sendAck({ customerId, campaign, entry, replyToken, turnId }) {
    const customer = db.getCustomer(customerId);
    // 11 ต.ค. 13:20 (ทดสอบจริงของพี่ง้วง): ไม่ส่งใบตอบรับต้องทิ้งร่องรอยเสมอ — เดิมคืนเงียบ ตรวจย้อนไม่ได้
    const skipAck = (reason) => {
      db.addAudit({ operator: "system", action: "blueprint_ack_skipped", target: customerId, detail: `${campaign.campaignId} ${reason}` });
      return { suppressed: reason };
    };
    if (aiPausedForReactiveCustomer({ db, config, customerId })) return skipAck("blueprint_recorded_ai_paused");
    if (db.isBotSilencedByTag?.(customerId) || db.isSpamCustomer?.(customerId)) return skipAck("blueprint_recorded_silenced_room");
    // submissions ส่งต่อให้ตัวประกอบข้อความ (ส่งซ้ำ = "อัปเดตคำตอบแล้ว") — ตัวที่ไม่รู้จักช่องนี้ก็ไม่สนเฉย ๆ
    const messages = blueprintContent().buildAckMessages({ campaign, business: entry.business, submissions: entry.submissions, now: now() });
    for (const text of messages.flatMap(messageTexts)) {
      const verdict = guard?.checkOutbound?.(text, { customerId, channelId: entry.channelId });
      if (verdict && verdict.ok === false) {
        logger.warn?.(`blueprint: ข้อความตอบรับ ${campaign.campaignId} ไม่ผ่าน compliance guard — ไม่ส่ง`);
        db.addAudit({ operator: "system", action: "blueprint_ack_guard", target: customerId, detail: campaign.campaignId });
        return { suppressed: "blueprint_ack_guard" };
      }
    }
    const { lineCh, to } = lineFor(customerId, customer);
    // ไม่มี reply token (ห้องที่ทีมรับช่วง/เส้นรอพิมพ์จบ ฯลฯ) = ส่งใบตอบรับเป็น push แทน เฉพาะข้อความแคมเปญที่ลูกค้าพิมพ์ขอเอง
    // retryKey คงที่ต่อการส่งครั้งที่ n ของคนนี้ → ประมวลซ้ำ = LINE ตอบ 409 ไม่ส่งซ้ำถึงลูกค้า
    const viaPush = !replyToken;
    const pushKey = viaPush ? ackRetryKey(campaign.campaignId, customerId, entry.submissions) : "";
    const sendAckMessages = (msgs) => (viaPush
      ? lineCh.pushMessages({ to, messages: msgs, retryKey: pushKey, purpose: SEND_PURPOSE.campaign })
      : lineCh.replyMessages({ to, replyToken, messages: msgs, purpose: SEND_PURPOSE.customerReply }));
    if (typeof (viaPush ? lineCh?.pushMessages : lineCh?.replyMessages) !== "function") return skipAck(viaPush ? "blueprint_recorded_no_push_route" : "blueprint_recorded_no_reply_route");
    const inboundBasisAt = db.lastInboundAt(customerId) || 0;
    const keepQueue = ackKeepsTeamQueue(customer, customerId, turnId);
    if (turnId) {
      try { db.markInboundTurnSending(turnId, processId); } catch (err) { logger.warn?.(`blueprint: จดสถานะกำลังส่งไม่สำเร็จ (${err?.message || err})`); }
    }
    let sentMessages = messages;
    let sendResult = await sendAckMessages(messages);
    // LINE ปฏิเสธด้วย 400 ทั้ง reply และ push = ก้อนข้อความมีปัญหา (ส่วนใหญ่คือ Flex ผิดสเปก) ไม่ใช่ลูกค้า
    // ลองอีกครั้งด้วยข้อความตัวอักษรอย่างเดียว — คำรับปากหลักอยู่ในข้อความแรกครบแล้ว ใบรับเป็นของแถม
    const textOnly = messages.filter((message) => message?.type === "text");
    if (!sendResult.ok && Number(sendResult.status) === 400 && textOnly.length && textOnly.length < messages.length) {
      logger.warn?.(`blueprint: ตอบรับ ${campaign.campaignId} ถูก LINE ปฏิเสธ 400 — ลองใหม่ด้วยข้อความอย่างเดียว`);
      const retry = await sendAckMessages(textOnly);
      if (retry.ok) {
        sendResult = { ...retry, fallback: "text_only" };
        sentMessages = textOnly;
      }
    }
    if (sendResult.ok) {
      for (const message of sentMessages) {
        const row = historyRowFor(message);
        db.insertMessage({
          customerId, direction: "out", msgType: row.msgType, content: row.content,
          ...(keepQueue ? { messageClass: "proactive" } : { messageClass: "reactive", settleTurnsUpTo: inboundBasisAt }),
          agentMode: "blueprint",
          metadata: { blueprint: { campaignId: campaign.campaignId, kind: "ack", ...(keepQueue ? { keepQueue } : {}) } },
        });
      }
      updateEntry(db, campaign.campaignId, customerId, (current) => (current ? { ...current, ackedAt: now() } : null));
    } else {
      logger.warn?.(`blueprint: ตอบรับ ${campaign.campaignId} ไม่สำเร็จ (${sendResult.status ?? sendResult.reason ?? "?"})`);
    }
    db.addAudit({
      operator: "system", action: "blueprint_ack", target: customerId,
      detail: `${campaign.campaignId} ${sendResult.ok ? `ส่งแล้ว (${sendResult.mode}${sendResult.fallback ? ` · ${sendResult.fallback}` : ""}${keepQueue ? ` · ไม่ปิดคิวทีม: ${keepQueue}` : ""})` : `ไม่สำเร็จ (${sendResult.status ?? sendResult.reason ?? "?"})`}`,
    });
    return { sent: sendResult.ok === true, sendResult, route: BLUEPRINT_ROUTE, deterministic: true };
  }

  /** เก็บคำขอหนึ่งข้อความ + พัก FU + ป้าย + โน้ตที่มา (ไม่ส่งอะไร) — ใช้ร่วมกันระหว่างเส้นสดและเก็บย้อนหลัง */
  function recordSubmission({ campaign, channelId, customerId, text, turnId, at }) {
    const parsed = parseBlueprintSubmission(text, campaign);
    if (!db.getCustomer(customerId)) db.upsertCustomer(customerId, { channelId });
    const written = updateEntry(db, campaign.campaignId, customerId,
      (current) => nextEntry(current, { campaign, customerId, channelId, parsed, turnId, at }));
    if (!written.ok) return { suppressed: "blueprint_store_conflict" };
    if (!written.changed) return { suppressed: "blueprint_duplicate" };
    const entry = written.entry;
    db.addAudit({
      operator: "system", action: "blueprint_intake", target: customerId,
      detail: `${campaign.campaignId} ครั้งที่ ${entry.submissions} · ธุรกิจ ${entry.business ? "มี" : "ว่าง"} · คำตอบ ${entry.answer ? "มี" : "ว่าง"}`,
    });
    holdFollowup(customerId, campaign, entry, at);
    applyTag(customerId, campaign);
    if (campaign.note) {
      try { db.setHashtagNote?.(customerId, campaign.note); } catch (err) { logger.warn?.(`blueprint: เขียนโน้ตที่มาไม่สำเร็จ (${err?.message || err})`); }
    }
    return { entry };
  }

  /**
   * รับคำขอหนึ่งข้อความ — pipeline เรียกในคิวของลูกค้าคนนั้นแล้ว
   * คืนค่ารูปเดียวกับ verdict ของ pipeline ({ sent, sendResult } หรือ { suppressed }) ให้บัญชีเทิร์นจดได้ตรงความจริง
   */
  async function intake({ campaign, channelId = "default", customerId, text, replyToken = "", turnId = null, expectedSessionId = null }) {
    try {
      if (expectedSessionId && db.activeConversationSession(customerId)?.id !== expectedSessionId) {
        return { suppressed: "session_rotated_before_pipeline" };
      }
      const recorded = recordSubmission({ campaign, channelId, customerId, text, turnId, at: now() });
      if (!recorded.entry) return recorded;
      return await sendAck({ customerId, campaign, entry: recorded.entry, replyToken, turnId });
    } catch (err) {
      logger.error?.(`blueprint: รับคำขอ ${campaign?.campaignId || "?"} ไม่สำเร็จ (${err?.message || err})`);
      return { suppressed: "blueprint_error" };
    }
  }

  /**
   * เก็บคำขอที่เข้ามา "ก่อน deploy" ย้อนหลัง (ตอนนั้น f0ac79dc เงียบให้ # แต่ข้อความลงตาราง messages แล้ว)
   * เลือกข้อความขาเข้าชนิด text ที่ขึ้นต้นด้วยคีย์เวิร์ดตั้งแต่ sinceMs (ไม่รวม Facebook/canary) — ข้อความล่าสุดต่อคน
   * คนที่มีคำขออยู่แล้ว = ข้าม (เส้นสดชนะ ทำซ้ำได้ไม่นับซ้ำ) · ไม่ส่งใบตอบรับย้อนหลัง: ของจริงไปตามเวลาแคมเปญ
   * @returns {{ matched: number, recorded: number, wouldRecord: number, existing: number, facebook: number }}
   */
  function backfill({ campaign, sinceMs, untilMs = now(), apply = false }) {
    const re = keywordRegex(campaign.keyword);
    const rows = db.raw.prepare(
      `SELECT id, customer_id, content, created_at, channel_id FROM messages
        WHERE direction = 'in' AND msg_type = 'text' AND created_at >= ? AND created_at <= ?
        ORDER BY created_at ASC, rowid ASC`,
    ).all(Number(sinceMs), Number(untilMs));
    const latest = new Map();
    for (const row of rows) {
      if (re.test(String(row.content || "").normalize("NFC"))) latest.set(String(row.customer_id), row);
    }
    const out = { matched: latest.size, recorded: 0, wouldRecord: 0, existing: 0, facebook: 0 };
    for (const [customerId, row] of latest) {
      if (customerId.startsWith("canary:")) continue;
      const customer = db.getCustomer(customerId);
      const channelId = String(customer?.channel_id || row.channel_id || "default");
      if (customerId.startsWith("facebook:") || isFacebookRoom(customerId, channelId)) { out.facebook += 1; continue; }
      if (readEntry(db, campaign.campaignId, customerId)) { out.existing += 1; continue; }
      if (!apply) { out.wouldRecord += 1; continue; }
      const result = recordSubmission({
        campaign, channelId, customerId, text: String(row.content || ""), turnId: String(row.id), at: Number(row.created_at),
      });
      if (result.entry) {
        out.recorded += 1;
        updateEntry(db, campaign.campaignId, customerId, (current) => (current ? { ...current, backfilled: true } : null));
      }
    }
    return out;
  }

  return { match, intake, backfill };
}
