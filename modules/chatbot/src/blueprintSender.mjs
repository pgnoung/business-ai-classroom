// blueprintSender.mjs — ตัวเดินรอบของแคมเปญ #AIAGENT: สร้าง "การวางระบบ AI Agent" → ส่งตามเวลา → คืน FU
//
// สวิตช์ blueprint_send_mode (ไม่มีแถว = off):
//   off         ไม่เรียกโมเดล ไม่ส่งอะไร (ทำแค่คืน FU ที่ครบกำหนด — การพักเกิดตอนรับคำขอ ต้องคืนเสมอ)
//   pregenerate สร้าง + เก็บ + แจ้งทีมให้เปิดดูตัวอย่าง (ไม่ส่งลูกค้า)
//   on          สร้าง และส่งเมื่อถึง sendAt (เฉพาะ 09:00–21:00 เวลาไทย) — คำขอที่มาหลัง sendAt ส่งเมื่อสร้างเสร็จ
//
// กันส่งซ้ำ: จองก่อนยิงด้วย CAS (ready → sending พร้อม retryKey ที่เก็บลงฐานก่อนเรียก LINE)
//   ค้าง sending (โปรเซสตายกลางทาง/ผลกำกวม) = ยิงซ้ำด้วย retryKey เดิม → LINE ตอบ 409 = รับไปแล้ว ไม่ส่งซ้ำถึงลูกค้า
//   รอบซ้อน = ล็อกในโปรเซส · สองโปรเซส = CAS ของแถวคำขอ
// ส่งไม่ถึง (บล็อก/ไม่ใช่เพื่อน/LINE ปฏิเสธถาวร 4xx) = undeliverable ไม่ลองซ้ำ · ผลกำกวมลองได้ไม่เกิน 3 ครั้งภายใน 23 ชม.
//   LINE 400 ตอนส่งการ์ด = ก้อนการ์ดอาจผิดสเปก → ลองครั้งเดียวด้วยข้อความตัวอักษร (retry key ใหม่) ก่อนตัดสินว่าส่งไม่ถึง
//   LINE 403 = ช่อง/แพ็กเกจไม่อนุญาต (ไม่ใช่ปัญหารายคน) → หยุดรอบ แจ้งทีม คงสถานะ ready ไว้ส่งรอบหน้า
// เงิน: เพดานต่อวัน blueprint_daily_cap_thb (ค่าเริ่มต้น ฿150) นับจากยอดจริงที่ provider ตอบ · ล้ม/ผิดรูป ลองได้ 3 ครั้งต่อคน
//   เรียกโมเดลได้ไม่เกิน MAX_MODEL_CALLS_PER_PERSON ครั้งต่อคนตลอดแคมเปญ (ส่งข้อความใหม่ซ้ำ ๆ เผาเพดานของคนอื่นไม่ได้)
// สวิตช์ยังไม่เป็น on ใกล้เวลาส่ง (12 ชม./1 ชม./เลยเวลา) ขณะมีคำขอรอ = แจ้งทีม — ทำแม้โหมด off (ใบตอบรับรับปากเวลาไว้แล้ว)
import { randomUUID } from "node:crypto";
import { aiPausedNow } from "./aiPause.mjs";
import { isBangkokQuietHours } from "./broadcastSchedule.mjs";
import { SEND_PURPOSE, bangkokDay } from "./lineSendLedger.mjs";
import { usageFields } from "./llmUsageFields.mjs";
import { createLock } from "./locks.mjs";
import { loadModelPricing, pricingById, usageCostUsd } from "./modelPricing.mjs";
import { readCampaigns, readDailyCapThb, readSendMode, thaiShortDateTime } from "./blueprintCampaignConfig.mjs";
import {
  addSpendThb, countByStatus, listEntries, readCampaignState, readSpendThb, updateEntry, writeCampaignState,
} from "./blueprintStore.mjs";
import { historyRowFor, messageTexts, outboundLineFor, releaseFollowupHold } from "./blueprintCampaign.mjs";
import { blueprintContent, blueprintContentError } from "./blueprintContent.mjs";

export const BLUEPRINT_TICK_MS = 60_000;
export const GENERATE_PER_TICK = 3;
export const SENDS_PER_TICK = 20;
export const PUSH_SPACING_MS = 2_000;
export const MAX_GENERATE_ATTEMPTS = 3;
export const MAX_SEND_ATTEMPTS = 3;
export const STALE_SENDING_MS = 2 * 60_000;
export const RETRY_KEY_WINDOW_MS = 23 * 3_600_000;
export const BLUEPRINT_MAX_COMPLETION_TOKENS = 6_000;
export const BLUEPRINT_RETRY_MAX_COMPLETION_TOKENS = 9_000;
// ราคาไม่รู้ = นับแพงไว้ก่อน (ห้ามจ่ายเกินเพดานเพราะไม่รู้ราคา) · ประมาณการก่อนเรียกคิดจากขนาดงานจริงของแคมเปญนี้
const FALLBACK_USD_PER_M = { in: 15, out: 75 };
const ESTIMATE_TOKENS = { in: 6_000, out: 4_000 };
export const MAX_MODEL_CALLS_PER_PERSON = 6;
// เรียกโมเดลแล้วได้ null แต่ใช้เวลานาน = provider น่าจะทำงาน (และคิดเงิน) ไปแล้ว → นับค่าประมาณเข้าเพดาน
// ได้ null เร็ว (ไม่อนุญาตโมเดล/ต่อเกตเวย์ไม่ได้) = ยังไม่มีใครคิดเงิน ไม่นับ
export const BILLED_NULL_MIN_MS = 5_000;
export const MODE_ALERT_LEAD_MS = Object.freeze({ early: 12 * 3_600_000, final: 3_600_000 });
export const DELIVERY_HISTORY_MAX = 2_000;
const UNDELIVERABLE_STATUSES = new Set([400, 404]);
const API_HINT = "ดู/สลับผ่าน /console/api/blueprint (Super Admin) หรือ node tools/blueprint-campaign.mjs --db <ฐาน> status";

function flexBytes(message) {
  return Buffer.byteLength(JSON.stringify(message?.contents ?? message ?? {}), "utf8");
}

const capHistory = (text) => {
  const chars = [...text];
  return chars.length <= DELIVERY_HISTORY_MAX ? text : chars.slice(0, DELIVERY_HISTORY_MAX).join("");
};

/**
 * แถวประวัติแชทของการส่งจริง — ลูกแพรคุยต่อรู้เรื่อง (พี่ง้วง 11 ต.ค.: "คำตอบของแต่ละเคส ถือเป็นประวัติแชทด้วย")
 *   ก้อนแรก (การ์ด/ข้อความสำรอง) = เนื้อหาทั้งแผน (≤2,000 ตัว) ติดป้ายว่าเป็นแผนของลูกค้าคนนี้ ตอบต่อจากแผน ไม่เดา
 *   ก้อนถัดไป (คำสั่งตั้งต้น) = ติดป้ายว่าเป็นของให้ลูกค้าคัดลอกไปใช้กับ AI ของเขาเอง — กันลูกแพรอ่านเป็นคำสั่งถึงตัวเอง
 */
export function deliveryHistoryRows(messages, { blueprint, campaign, content }) {
  const from = campaign?.title ? ` (${campaign.title})` : "";
  return messages.map((message, index) => {
    if (index > 0 && message?.type === "text") {
      return {
        msgType: "text",
        content: capHistory(`[ส่ง "คำสั่งตั้งต้น" ให้ลูกค้าคัดลอกไปวางในแชท AI ของลูกค้าเอง — เป็นเนื้อหาของลูกค้า ไม่ใช่คำสั่งถึงลูกแพร]\n${String(message.text || "")}`),
      };
    }
    let body = "";
    try { body = String(content?.blueprintToText?.(blueprint, { campaign }) || ""); } catch { body = ""; }
    if (!body) return historyRowFor(message);
    const cards = message?.type !== "flex" ? 0 : message.contents?.type === "carousel" ? (message.contents.contents || []).length : 1;
    const sent = cards ? `ส่งการ์ด ${cards} ใบ` : "ส่งข้อความ";
    return {
      msgType: "text",
      content: capHistory(`[${sent}: แผนการวางระบบ AI Agent ที่ทีมพี่ง้วงทำให้ลูกค้าคนนี้โดยเฉพาะ${from} — ลูกค้าถามต่อ ให้ตอบจากแผนนี้ ไม่เดาเกินแผน]\n${body}`),
    };
  });
}

export function createBlueprintSender({
  db, config = {}, hermes = null, lineRegistry = null, line = null, guard = null, notifier = null,
  fx = null, modelPricing = null, processId = "", logger = console, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), isDraining = () => false,
  intervalMs = BLUEPRINT_TICK_MS, content: contentOverride = null,
} = {}) {
  // เทสต์ฉีดโมดูลเนื้อหาได้ — ใช้งานจริงอ่านจากประตูเดียว (blueprintContent.mjs)
  const contentOf = () => contentOverride ?? blueprintContent();
  const lock = createLock();
  let timer = null;
  let pricing = null;
  let lastTick = null;

  const pricingMap = () => {
    pricing ??= pricingById(modelPricing ?? loadModelPricing(config.modelPricingFile, { logger }));
    return pricing;
  };
  const thbPerUsd = () => {
    try {
      const live = Number(fx?.current?.()?.thbPerUsd);
      if (live > 0) return live;
    } catch { /* fx พัง = ใช้ค่า config */ }
    return Number(config.thbPerUsd) > 0 ? Number(config.thbPerUsd) : 36;
  };
  const costThb = (model, fields) => {
    const usd = usageCostUsd({ model, ...fields }, pricingMap());
    const safeUsd = usd ?? ((fields.tokensIn || 0) * FALLBACK_USD_PER_M.in + (fields.tokensOut || 0) * FALLBACK_USD_PER_M.out) / 1_000_000;
    return safeUsd * thbPerUsd();
  };
  const modelFor = (campaign) => campaign.model || db.getSetting("reply_model") || config.hermesModel || "";

  const lineFor = (customerId, customer) => outboundLineFor({ lineRegistry, line }, customerId, customer);

  function audit(action, target, detail) {
    try { db.addAudit({ operator: "system", action, target, detail: String(detail).slice(0, 480) }); } catch { /* บันทึกไม่ได้ห้ามล้มรอบ */ }
  }

  function notifyTeam(campaignId, text) {
    try {
      return notifier?.fire?.({ customerId: `ops:blueprint:${campaignId}`, reason: "blueprint", reasonTextOverride: text, force: true });
    } catch (err) {
      logger.warn?.(`blueprint: แจ้งทีมไม่สำเร็จ (${err?.message || err})`);
      return null;
    }
  }

  /* ------------------------------- คืน FU ------------------------------- */

  function releaseDueHolds(entries, t) {
    let released = 0;
    for (const entry of entries) {
      const hold = entry.hold;
      if (!hold || hold.releasedAt || !(t >= Number(hold.until))) continue;
      const result = releaseFollowupHold(db, entry.customerId, hold, { at: t });
      const write = updateEntry(db, entry.campaignId, entry.customerId, (current) => (current?.hold && !current.hold.releasedAt
        ? { ...current, hold: { ...current.hold, releasedAt: t, result } } : null));
      if (write.changed) {
        released += 1;
        if (hold.applied) audit("blueprint_followup_release", entry.customerId, `${entry.campaignId} ${result === "restored" ? "คืน FU เป็นค่าเดิมแล้ว" : "ไม่คืน (ทีม/ลูกค้าเปลี่ยนเองระหว่างพัก)"}`);
      }
    }
    return released;
  }

  /* ----------------------------- สร้างแบบวางระบบ ----------------------------- */

  function budgetLeft(t, model) {
    const cap = readDailyCapThb(db);
    const spent = readSpendThb(db, bangkokDay(t));
    const estimate = costThb(model, { tokensIn: ESTIMATE_TOKENS.in, tokensOut: ESTIMATE_TOKENS.out, cachedIn: 0 });
    return { ok: spent + estimate <= cap, cap, spent, estimate };
  }

  /** ข้อความเสริม (ถ้าโมดูลเนื้อหามีให้): คำสั่งตั้งต้นที่ลูกค้ากดค้างคัดลอกไปใช้ได้ — ประกอบจากแผนตรง ๆ ไม่เรียกโมเดล */
  function extraMessages(content, blueprint, campaign) {
    if (typeof content?.buildAgentBriefText !== "function") return [];
    try {
      const brief = String(content.buildAgentBriefText(blueprint, { campaign }) || "").trim();
      return brief && [...brief].length <= 5_000 ? [{ type: "text", text: brief }] : [];
    } catch (err) {
      logger.warn?.(`blueprint: ประกอบคำสั่งตั้งต้นไม่สำเร็จ (${err?.message || err}) — ส่งเฉพาะแผน`);
      return [];
    }
  }

  function renderMessages(blueprint, campaign, customer, { textOnly = false } = {}) {
    const content = contentOf();
    const displayName = String(customer?.display_name || "");
    const extra = extraMessages(content, blueprint, campaign);
    if (!textOnly) {
      try {
        const flex = content.buildBlueprintFlex(blueprint, { campaign, displayName });
        if (flex?.type === "flex" && flexBytes(flex) <= content.flexMaxBytes) return { messages: [flex, ...extra], format: "flex" };
        logger.warn?.(`blueprint: การ์ดใหญ่เกิน ${content.flexMaxBytes} ไบต์ — ใช้ข้อความสำรอง`);
      } catch (err) {
        logger.warn?.(`blueprint: ประกอบการ์ดไม่สำเร็จ (${err?.message || err}) — ใช้ข้อความสำรอง`);
      }
    }
    return { messages: [{ type: "text", text: content.blueprintToText(blueprint, { campaign }) }, ...extra], format: "text" };
  }

  function guardProblem(messages, customerId, channelId) {
    for (const text of messages.flatMap(messageTexts)) {
      const verdict = guard?.checkOutbound?.(text, { customerId, channelId });
      if (verdict && verdict.ok === false) return (verdict.violations || []).map((v) => v?.rule || v?.type || "violation").join(",") || "guard";
    }
    return "";
  }

  function failGeneration(entry, rev, reason) {
    const write = updateEntry(db, entry.campaignId, entry.customerId, (current) => {
      if (!current || current.status !== "pending" || current.rev !== rev) return null;
      const attempts = (Number(current.attempts) || 0) + 1;
      return { ...current, attempts, lastError: reason, status: attempts >= MAX_GENERATE_ATTEMPTS ? "failed" : "pending" };
    });
    if (write.entry?.status === "failed") audit("blueprint_generate_failed", entry.customerId, `${entry.campaignId} สร้างไม่ผ่าน ${MAX_GENERATE_ATTEMPTS} ครั้ง (${reason})`);
  }

  /** จองสิทธิ์เรียกโมเดลหนึ่งครั้งของคนนี้ (CAS) — ครบเพดานต่อคน = failed ให้ทีมดู ไม่เรียกต่อ */
  function reserveModelCall(entry, rev) {
    return updateEntry(db, entry.campaignId, entry.customerId, (current) => {
      if (!current || current.status !== "pending" || current.rev !== rev) return null;
      const calls = Number(current.modelCalls) || 0;
      if (calls >= MAX_MODEL_CALLS_PER_PERSON) return { ...current, status: "failed", lastError: "model_call_cap" };
      return { ...current, modelCalls: calls + 1 };
    });
  }

  async function generate(entry, campaign, t) {
    const model = modelFor(campaign);
    const budget = budgetLeft(t, model);
    if (!budget.ok) return { stop: "daily_cap", budget };
    const rev = entry.rev;
    const reserved = reserveModelCall(entry, rev);
    if (!reserved.changed) return { discarded: true };
    if (reserved.entry.status === "failed") {
      audit("blueprint_generate_failed", entry.customerId, `${entry.campaignId} เรียกโมเดลครบ ${MAX_MODEL_CALLS_PER_PERSON} ครั้งแล้ว (ส่งข้อความใหม่หลายรอบ)`);
      return { failed: "model_call_cap" };
    }
    const content = contentOf();
    const prompt = content.buildBlueprintMessages({ business: entry.business, answer: entry.answer, campaign });
    const system = prompt.find((m) => m?.role === "system");
    const user = prompt.find((m) => m?.role === "user");
    const startedAt = now();
    const result = await hermes?.draftWithModel?.({
      model, label: "hermes-blueprint",
      maxCompletionTokens: BLUEPRINT_MAX_COMPLETION_TOKENS, retryMaxCompletionTokens: BLUEPRINT_RETRY_MAX_COMPLETION_TOKENS,
      persona: String(system?.content || ""), userText: String(user?.content || ""),
    });
    let thb = 0;
    if (result?.usage) {
      const fields = usageFields(result.usage);
      thb = costThb(result.model || model, fields);
      addSpendThb(db, bangkokDay(t), thb);
      // kind "followup": llm_usage.kind เป็นชุดปิดตาม CHECK (เพิ่มชนิดใหม่ = rebuild ตาราง ซึ่งห้ามทำ) — YOLO ใช้แบบเดียวกัน
      // ผลข้างเคียงที่รู้: บรรทัด "followup" ของรายงานต้นทุนในคอนโซลรวมค่าแคมเปญนี้ด้วย — ยอดแยกของแคมเปญอยู่ที่
      // blueprint_spend:<วัน> (/health → blueprint.thbToday) และ draft.costThb รายคน
      try { db.addLlmUsage({ customerId: entry.customerId, kind: "followup", model: result.model || model, ...fields }); } catch (err) {
        logger.warn?.(`blueprint: บันทึกต้นทุนลง llm_usage ไม่สำเร็จ (${err?.message || err}) — ยอดยังนับในเพดานของแคมเปญ`);
      }
    } else if (result || now() - startedAt >= BILLED_NULL_MIN_MS) {
      // provider ไม่ส่งตัวเลข / ล้มหลังทำงานไปนาน (เช่น 5xx แล้วลองซ้ำ) = นับค่าประมาณแทน ห้ามจ่ายเกินเพดานเพราะไม่รู้ยอด
      addSpendThb(db, bangkokDay(t), budget.estimate);
    }
    if (!result?.text) {
      failGeneration(entry, rev, "model_unavailable");
      return { failed: "model_unavailable" };
    }
    const parsed = content.parseBlueprintText(result.text);
    if (!parsed.ok) {
      failGeneration(entry, rev, `invalid:${(parsed.errors || []).slice(0, 3).join(" | ")}`.slice(0, 300));
      return { failed: "invalid" };
    }
    const customer = db.getCustomer(entry.customerId);
    const rendered = renderMessages(parsed.value, campaign, customer);
    const problem = guardProblem(rendered.messages, entry.customerId, entry.channelId);
    if (problem) {
      failGeneration(entry, rev, `guard:${problem}`);
      return { failed: "guard" };
    }
    const write = updateEntry(db, entry.campaignId, entry.customerId, (current) => {
      if (!current || current.status !== "pending" || current.rev !== rev) return null; // ลูกค้าส่งใหม่ระหว่างสร้าง = ทิ้งรอบนี้
      return {
        ...current, status: "ready", lastError: "",
        draft: { blueprint: parsed.value, model: result.model || model, generatedAt: now(), forRev: rev, format: rendered.format, costThb: Math.round(thb * 100) / 100 },
      };
    });
    return write.changed ? { ready: true } : { discarded: true };
  }

  /* --------------------------------- ส่ง --------------------------------- */

  function settleSkip(entry, status, reason) {
    const write = updateEntry(db, entry.campaignId, entry.customerId, (current) => (current && current.status === "ready"
      ? { ...current, status, lastError: reason } : null));
    if (write.changed) audit(`blueprint_${status}`, entry.customerId, `${entry.campaignId} ${reason}`);
  }

  function preSendBlock(entry, customer, campaign) {
    if (!customer) return ["skipped", "customer_missing"];
    if ((Number(entry.sendCount) || 0) >= campaign.maxSendsPerPerson) return ["skipped", "max_sends"];
    if (String(customer.channel_id || "") === "facebook") return ["skipped", "facebook_room"];
    try {
      if (db.lineFollowState?.(entry.customerId)?.state === "unfollowed") return ["undeliverable", "unfollowed"];
    } catch { /* ไม่รู้สถานะเพื่อน = ลองส่ง (LINE บอกเองถ้าส่งไม่ได้) */ }
    if (db.isSpamCustomer?.(entry.customerId)) return ["skipped", "spam"];
    if (db.isBotSilencedByTag?.(entry.customerId)) return ["skipped", "silenced_tag"];
    if (Number(customer.do_not_disturb) === 1) return ["skipped", "do_not_disturb"];
    if (Number(customer.marketing_consent) < 0) return ["skipped", "marketing_opt_out"];
    return null;
  }

  function claim(entry, t) {
    return updateEntry(db, entry.campaignId, entry.customerId, (current) => {
      if (!current) return null;
      if (current.status === "ready") {
        return { ...current, status: "sending", send: { retryKey: randomUUID(), firstClaimAt: t, claimedAt: t, owner: processId, attempts: 1 } };
      }
      const stale = current.status === "sending" && current.send?.retryKey && t - Number(current.send.claimedAt) >= STALE_SENDING_MS;
      if (!stale) return null;
      if ((Number(current.send.attempts) || 0) >= MAX_SEND_ATTEMPTS || t - Number(current.send.firstClaimAt) > RETRY_KEY_WINDOW_MS) {
        return { ...current, status: "failed", lastError: "send_outcome_unknown" };
      }
      return { ...current, send: { ...current.send, claimedAt: t, owner: processId, attempts: (Number(current.send.attempts) || 0) + 1 } };
    });
  }

  function finishSend(entry, retryKey, patch) {
    return updateEntry(db, entry.campaignId, entry.customerId, (current) => {
      if (!current || current.status !== "sending" || current.send?.retryKey !== retryKey) return null;
      return patch(current);
    });
  }

  function recordDelivery(entry, campaign, rendered, blueprint) {
    const session = db.activeConversationSession?.(entry.customerId);
    const rows = deliveryHistoryRows(rendered.messages, { blueprint, campaign, content: contentOf() });
    for (const row of rows) {
      try {
        db.insertMessage({
          customerId: entry.customerId, direction: "out", msgType: row.msgType, content: row.content,
          messageClass: "proactive", agentMode: "blueprint", sessionId: session?.id ?? null,
          metadata: { blueprint: { campaignId: entry.campaignId, kind: "delivery", format: rendered.format } },
        });
      } catch (err) { logger.debug?.(`blueprint: บันทึกประวัติแชทไม่สำเร็จ (${err?.message || err})`); }
    }
  }

  async function sendOne(entry, campaign, t) {
    const customer = db.getCustomer(entry.customerId);
    if (entry.status === "ready") {
      const block = preSendBlock(entry, customer, campaign);
      if (block) {
        settleSkip(entry, block[0], block[1]);
        return { skipped: block[1] };
      }
    }
    const claimed = claim(entry, t);
    if (!claimed.changed) return { skipped: "not_claimed" };
    let current = claimed.entry;
    if (current.status === "failed") {
      audit("blueprint_send_failed", entry.customerId, `${entry.campaignId} ผลการส่งไม่แน่ชัดเกิน ${MAX_SEND_ATTEMPTS} ครั้ง`);
      return { failed: "send_outcome_unknown" };
    }
    const blueprint = current.draft?.blueprint;
    // ค้าง sending จากรอบที่สลับเป็นข้อความแล้ว = ยิงซ้ำด้วยรูปเดิม (retry key ผูกกับเนื้อหานั้น)
    let rendered = renderMessages(blueprint, campaign, customer, { textOnly: current.send?.textFallback === true });
    const problem = guardProblem(rendered.messages, entry.customerId, entry.channelId);
    if (problem) {
      finishSend(current, current.send.retryKey, (row) => ({ ...row, status: "failed", lastError: `guard:${problem}` }));
      audit("blueprint_send_failed", entry.customerId, `${entry.campaignId} ไม่ผ่าน compliance guard ตอนส่ง`);
      return { failed: "guard" };
    }
    const { lineCh, to } = lineFor(entry.customerId, customer);
    if (typeof lineCh?.pushMessages !== "function") {
      finishSend(current, current.send.retryKey, (row) => ({ ...row, status: "ready", send: null, lastError: "no_push_route" }));
      return { halt: "no_push_route" };
    }
    let result = await lineCh.pushMessages({
      to, messages: rendered.messages, retryKey: current.send.retryKey, purpose: SEND_PURPOSE.campaign, includeErrorDetail: true,
    });
    if (!result.ok && Number(result.status) === 400 && rendered.format === "flex") {
      // 400 ตอนส่งการ์ด: ก้อนการ์ดอาจผิดสเปก — สลับเป็นข้อความครั้งเดียวด้วย retry key ใหม่ (จดลงฐานก่อนยิงเสมอ)
      logger.warn?.(`blueprint: LINE ปฏิเสธการ์ด (400${result.errorDetail ? ` ${result.errorDetail}` : ""}) — ลองส่งเป็นข้อความ`);
      const textRetryKey = randomUUID();
      const swapped = finishSend(current, current.send.retryKey, (row) => ({
        ...row, lastError: `line_400_flex:${result.errorDetail || ""}`.slice(0, 300),
        send: { ...row.send, retryKey: textRetryKey, textFallback: true, claimedAt: now() },
      }));
      if (swapped.changed) {
        current = swapped.entry;
        audit("blueprint_flex_rejected", entry.customerId, `${entry.campaignId} LINE ปฏิเสธการ์ด 400 ${result.errorDetail || ""} → ส่งเป็นข้อความ`);
        rendered = renderMessages(blueprint, campaign, customer, { textOnly: true });
        result = await lineCh.pushMessages({
          to, messages: rendered.messages, retryKey: textRetryKey, purpose: SEND_PURPOSE.campaign, includeErrorDetail: true,
        });
      }
    }
    const retryKey = current.send.retryKey;
    const at = now();
    if (result.ok) {
      const write = finishSend(current, retryKey, (row) => {
        const sendCount = (Number(row.sendCount) || 0) + 1;
        // ส่งใหม่ระหว่างกำลังส่ง (requeue) แต่ครบจำนวนที่แคมเปญให้แล้ว = จบที่ sent ไม่ทำรอบใหม่ (จดไว้ให้ทีมเห็น)
        const requeue = row.requeue && sendCount < campaign.maxSendsPerPerson;
        return {
          ...row, status: requeue ? "pending" : "sent", requeue: false, sentAt: at, sendCount,
          ...(row.requeue && !requeue ? { lastError: "max_sends_resubmit_ignored" } : {}),
          lastSent: { at, format: rendered.format, requestId: result.requestId || "", duplicate: result.duplicate === true },
          send: null, ...(requeue ? { attempts: 0, draft: undefined } : {}),
        };
      });
      // 409 (LINE รับคำขอนี้ไปแล้วจากรอบที่ผลกำกวม) ก็จด — รอบกำกวมไม่เคยจดประวัติ ลูกแพรต้องเห็นแผนที่ลูกค้าได้รับ
      if (write.changed) recordDelivery(entry, campaign, rendered, blueprint);
      audit("blueprint_sent", entry.customerId, `${entry.campaignId} ส่งแล้ว (${rendered.format}${result.duplicate ? " · LINE รับไปแล้วก่อนหน้า" : ""})`);
      return { sent: true };
    }
    if (result.blocked) {
      // ด่านของเราเอง (ปิดส่งจริง/pilot/ไม่มี token) — ไม่ได้ยิงถึง LINE จึงปล่อยกลับเป็น ready แล้วหยุดทั้งรอบ
      finishSend(current, retryKey, (row) => ({ ...row, status: "ready", send: null, lastError: `blocked:${result.reason || "unknown"}` }));
      return { halt: `blocked:${result.reason || "unknown"}` };
    }
    if (result.ambiguous) {
      finishSend(current, retryKey, (row) => ({ ...row, lastError: `ambiguous:${result.status || 0}` }));
      return { ambiguous: true };
    }
    const status = Number(result.status) || 0;
    const detail = result.errorDetail ? `:${result.errorDetail}` : "";
    if (status === 429 || status === 403) {
      // 429 = โควตา/อัตราส่ง · 403 = ช่องหรือแพ็กเกจไม่อนุญาต — ไม่ใช่ปัญหารายคน: คืนเป็น ready หยุดรอบ แจ้งทีม
      finishSend(current, retryKey, (row) => ({ ...row, status: "ready", send: null, lastError: `line_${status}${detail}`.slice(0, 300) }));
      return { halt: `line_${status}` };
    }
    const final = UNDELIVERABLE_STATUSES.has(status) ? "undeliverable" : "failed";
    finishSend(current, retryKey, (row) => ({ ...row, status: final, send: null, lastError: `line_${status}${detail}`.slice(0, 300) }));
    audit(`blueprint_${final}`, entry.customerId, `${entry.campaignId} LINE ตอบ ${status}${detail}`);
    return { [final]: true };
  }

  /* ------------------------------- รอบหลัก ------------------------------- */

  function expire(entries, campaignsById, t) {
    let expired = 0;
    for (const entry of entries) {
      const campaign = campaignsById.get(entry.campaignId);
      if (!campaign || t < campaign.expiresAtMs || !["pending", "ready"].includes(entry.status)) continue;
      const write = updateEntry(db, entry.campaignId, entry.customerId, (current) => (current && ["pending", "ready"].includes(current.status)
        ? { ...current, status: "expired" } : null));
      if (write.changed) expired += 1;
    }
    return expired;
  }

  function maybeNotifyPreview(campaign, t) {
    if (t >= campaign.sendAtMs) return;
    const counts = countByStatus(listEntries(db, campaign.campaignId));
    if (counts.pending > 0 || counts.ready === 0) return;
    const state = readCampaignState(db, campaign.campaignId);
    if (Number(state.previewNotifiedReady) >= counts.ready) return;
    writeCampaignState(db, campaign.campaignId, { ...state, previewNotifiedReady: counts.ready, previewNotifiedAt: t });
    const mode = readSendMode(db);
    notifyTeam(campaign.campaignId, `แบบวางระบบ AI Agent (${campaign.title}) สร้างเสร็จ ${counts.ready} ราย`
      + `${counts.failed ? ` · สร้างไม่ผ่าน ${counts.failed} ราย` : ""}`
      + ` · สวิตช์ส่งตอนนี้ ${mode}${mode === "on" ? "" : ` (ต้องเป็น on ก่อน ${thaiShortDateTime(campaign.sendAtMs)} ถึงจะส่ง)`} — ${API_HINT}`);
  }

  function maybeNotifySummary(campaign, t) {
    if (t < campaign.sendAtMs) return;
    const counts = countByStatus(listEntries(db, campaign.campaignId));
    if (counts.pending + counts.ready + counts.sending > 0) return;
    const done = counts.sent + counts.undeliverable + counts.failed + counts.skipped;
    const state = readCampaignState(db, campaign.campaignId);
    if (!done || Number(state.summaryNotifiedDone) >= done) return;
    writeCampaignState(db, campaign.campaignId, { ...state, summaryNotifiedDone: done, summaryNotifiedAt: t });
    notifyTeam(campaign.campaignId, `ส่งแบบวางระบบ AI Agent (${campaign.title}) แล้ว ${counts.sent} ราย`
      + ` · ส่งไม่ถึง ${counts.undeliverable} · ข้าม ${counts.skipped} · ไม่สำเร็จ ${counts.failed} — รายชื่อ: GET /console/api/blueprint/requests?campaignId=${campaign.campaignId} (Super Admin)`);
  }

  /**
   * ใบตอบรับรับปากเวลาส่งไว้แล้ว แต่ส่งจริงต้องมีคนสลับ blueprint_send_mode เป็น on — ใกล้เวลาแล้วยังไม่ on = แจ้งทีม
   * 12 ชม. ก่อน / 1 ชม. ก่อน / เลยเวลาแล้ว (อย่างละครั้งต่อแคมเปญ) เฉพาะเมื่อมีคำขอรอสร้าง/รอส่ง
   */
  function maybeAlertSendMode(campaigns, entries, mode, t) {
    if (mode === "on") return;
    for (const campaign of campaigns) {
      if (!campaign.enabled || t >= campaign.expiresAtMs) continue;
      const left = campaign.sendAtMs - t;
      if (left > MODE_ALERT_LEAD_MS.early) continue;
      const counts = countByStatus(entries.filter((e) => e.campaignId === campaign.campaignId));
      const waiting = counts.pending + counts.ready;
      if (!waiting) continue;
      const stage = left <= 0 ? "late" : left <= MODE_ALERT_LEAD_MS.final ? "final" : "early";
      const key = `modeAlert_${stage}`;
      const state = readCampaignState(db, campaign.campaignId);
      if (state[key]) continue;
      writeCampaignState(db, campaign.campaignId, { ...state, [key]: t });
      const when = thaiShortDateTime(campaign.sendAtMs);
      notifyTeam(campaign.campaignId, `แคมเปญ AI Agent (${campaign.title}) ${left <= 0 ? `เลยเวลาส่ง ${when} แล้ว` : `จะถึงเวลาส่ง ${when}`}`
        + ` แต่สวิตช์ส่งยังเป็น ${mode} — มีคำขอรอ ${waiting} ราย (สร้างเสร็จแล้ว ${counts.ready})`
        + ` · ${mode === "off" ? "เปลี่ยนเป็น pregenerate เพื่อสร้างล่วงหน้า แล้ว" : ""}เปลี่ยนเป็น on ก่อนเวลาส่ง:`
        + " node tools/blueprint-campaign.mjs --db <ฐาน> mode on --apply หรือ POST /console/api/blueprint/mode");
    }
  }

  function notifyOnce(campaign, key, t, text) {
    const state = readCampaignState(db, campaign.campaignId);
    const day = bangkokDay(t);
    if (state[key] === day) return;
    writeCampaignState(db, campaign.campaignId, { ...state, [key]: day });
    notifyTeam(campaign.campaignId, text);
  }

  async function runTick() {
    const t = now();
    const campaigns = readCampaigns(db, { logger });
    const entries = listEntries(db);
    const released = releaseDueHolds(entries, t);
    const mode = readSendMode(db);
    const summary = { mode, released, generated: 0, sent: 0 };
    if (entries.length) {
      try { maybeAlertSendMode(campaigns, entries, mode, t); } catch (err) { logger.warn?.(`blueprint: ตรวจสวิตช์ก่อนเวลาส่งไม่สำเร็จ (${err?.message || err})`); }
    }
    if (mode === "off" || !entries.length || isDraining()) return summary;
    if (!contentOf()) return { ...summary, skipped: "content_unavailable" };
    if (aiPausedNow({ db, config })) return { ...summary, skipped: "ai_paused" };
    const byId = new Map(campaigns.map((c) => [c.campaignId, c]));
    summary.expired = expire(entries, byId, t);

    // 1) สร้าง — ทีละคน (เกตเวย์รับงานพร้อมกันได้น้อย และแชร์กับคำตอบสดของลูกค้า)
    const pending = listEntries(db).filter((e) => e.status === "pending" && byId.has(e.campaignId)
      && (Number(e.sendCount) || 0) < byId.get(e.campaignId).maxSendsPerPerson)
      .sort((a, b) => Number(a.receivedAt) - Number(b.receivedAt));
    for (const entry of pending.slice(0, GENERATE_PER_TICK)) {
      if (isDraining()) break;
      const campaign = byId.get(entry.campaignId);
      const result = await generate(entry, campaign, now());
      if (result.stop === "daily_cap") {
        notifyOnce(campaign, "capNotifiedDay", t, `แบบวางระบบ AI Agent (${campaign.title}) หยุดสร้างชั่วคราว: ถึงเพดานค่าโมเดลวันนี้ ฿${result.budget.cap} — ปรับเพดานได้ในคอนโซล`);
        break;
      }
      if (result.ready) summary.generated += 1;
    }
    for (const campaign of campaigns) maybeNotifyPreview(campaign, now());

    // 2) ส่ง — โหมด on เท่านั้น · ถึงเวลาแล้ว · ไม่ใช่ช่วงพักเสียง 21:00–09:00
    if (mode !== "on" || isBangkokQuietHours(now())) return summary;
    const due = listEntries(db).filter((e) => {
      const campaign = byId.get(e.campaignId);
      if (!campaign || now() < campaign.sendAtMs) return false;
      return e.status === "ready" || (e.status === "sending" && now() - Number(e.send?.claimedAt) >= STALE_SENDING_MS);
    }).sort((a, b) => Number(a.receivedAt) - Number(b.receivedAt));
    let pushes = 0;
    for (const entry of due.slice(0, SENDS_PER_TICK)) {
      if (isDraining() || readSendMode(db) !== "on" || aiPausedNow({ db, config })) break;
      if (pushes > 0) await sleep(PUSH_SPACING_MS);
      const campaign = byId.get(entry.campaignId);
      const result = await sendOne(entry, campaign, now());
      if (!result.skipped) pushes += 1;
      if (result.sent) summary.sent += 1;
      if (result.halt) {
        summary.halt = result.halt;
        notifyOnce(campaign, "haltNotifiedDay", t, `ส่งแบบวางระบบ AI Agent (${campaign.title}) หยุดชั่วคราว (${result.halt}) — ระบบจะลองใหม่รอบถัดไป`);
        break;
      }
    }
    for (const campaign of campaigns) maybeNotifySummary(campaign, now());
    return summary;
  }

  async function runOnce() {
    if (!lock.tryAcquire()) return { skipped: "run_in_flight" };
    try {
      const result = await runTick();
      lastTick = { at: now(), ...result };
      return result;
    } catch (err) {
      logger.error?.(`blueprint: รอบล้มเหลว (${err?.message || err})`);
      return { error: true };
    } finally {
      lock.release();
    }
  }

  function start() {
    if (timer || !(intervalMs > 0)) return false;
    timer = setInterval(() => { void runOnce(); }, intervalMs);
    timer.unref?.();
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** ตัวเลขรวมสำหรับ /health — ไม่มีรหัสลูกค้า ไม่มีเนื้อหา */
  function stats() {
    try {
      const t = now();
      const campaigns = readCampaigns(db);
      const entries = listEntries(db);
      return {
        mode: readSendMode(db),
        armed: timer !== null,
        ...(contentOf() ? {} : { contentError: blueprintContentError() || "unavailable" }),
        campaigns: campaigns.filter((c) => c.enabled && t < c.expiresAtMs).length,
        requests: countByStatus(entries),
        // ห้องที่แคมเปญพัก FU ไว้และยังไม่คืน — ต้องเป็น 0 ก่อนถอยกลับ release ที่ไม่มีตัวคืน (tools/blueprint-campaign.mjs rollback-check)
        holdsActive: entries.filter((e) => e.hold?.applied && !e.hold.releasedAt).length,
        thbToday: Math.round(readSpendThb(db, bangkokDay(t)) * 100) / 100,
        capThb: readDailyCapThb(db),
        lastTickAt: lastTick?.at ?? null,
      };
    } catch {
      return { mode: "off", error: true };
    }
  }

  return { runOnce, start, stop, stats, renderMessages };
}
