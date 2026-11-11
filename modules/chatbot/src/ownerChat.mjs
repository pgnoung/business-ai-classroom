// ownerChat.mjs — สมองของ "คุยกับลูกแพร" ทาง Telegram (คำสั่งพี่ง้วง 28 ก.ย. 2026)
//
// "ช่วยให้ ลูกแพร telegram มีสมอง และ สามารถคุยกับพี่ง้วง เป็นเหมือนลูกแพรจริงๆเลย เพื่อพี่ง้วง
//  จะสื่อสารกับ ลูกแพรทาง telegram ในเรื่องคลาสสอน หรือใดๆ เป็นหลัก ได้ไหมครับ คุยเป็น native human ได้เลย"
// บ่ายวันเดียวกัน: "ลองปรับ telegram เป็น luna ได้ไหม · แล้ว สามารถลิ้งค์ไวๆ กับ สมองลูกแพร เพื่อดูข้อมูล
//  พี่ง้วง สอบถาม วิเคราะห์ ได้ไหม"
//
// ตำแหน่งในเส้นทาง (telegramControl.mjs): คำตอบรายการค้าง → คำสั่งแบบตายตัว → mini AI ถอดเป็นคำสั่ง
// → "ที่เหลือทั้งหมด" มาที่นี่ (เดิมตอบ UNKNOWN_TEXT) — ไฟล์นี้ไม่มีทางสั่งระบบได้เลย: ไม่มี yolo ไม่มีสวิตช์ AI
// ในมือ มีแค่ร่างข้อความตอบพี่ง้วง + ค้นข้อมูลแบบอ่านอย่างเดียว คำสั่งทุกอย่างยังผ่านเส้นคำสั่งเดิมที่มีปุ่มยืนยัน
//
// ต่อข้อความหนึ่ง (โมเดลเรียกได้ไม่เกินสองครั้ง + สำรองหนึ่งครั้ง):
//   1) วางแผนค้น (ownerChatLookupCatalog.mjs) — ข้ามเลยถ้าข้อความไม่ต้องใช้ข้อมูล (คุยเล่น/ร่างแคปชั่น)
//      ตัวให้คะแนน (luna) ตอบ JSON เลือกคิวรีจากรายการปิด → ตรวจเข้ม → รันแบบอ่านอย่างเดียว (ownerChatLookups.mjs)
//   2) ตอบ: ความรู้ที่อนุมัติ (สมองรุ่นเดียวกับที่ลูกค้าได้ — ส่วนคงที่ แคชได้) + บุคลิกเจ้าของ
//      + ข้อมูลสด + ตารางราคา + ห้องที่เอ่ยถึง + "ผลค้นข้อมูล" + ความจำแชท 20 เทิร์น
//      โมเดลตามสวิตช์ owner_chat_model (ownerChatModel.mjs): luna (ค่าตั้งต้น) = draftWithModel
//      · sol = draftReply ทางเดิมทุกไบต์ · luna ไม่ตอบ = ถอยไปทางเดิมหนึ่งครั้ง
//   3) แนบลิงก์เปิดห้องในคอนโซลของห้องที่คำตอบเอ่ยถึง (ownerChatLinks.mjs — ไม่เก็บในความจำ)
// ค่าโมเดลบันทึก llm_usage ด้วยโมเดลที่ใช้จริง: ตอบ = kind "draft" · วางแผนค้น = kind "score" (customer_id ว่าง)
// เพดาน 300 "ครั้งที่เรียกโมเดล" ต่อวัน (วางแผน + ตอบ + สำรอง) · ล้มทุกแบบ = ข้อความขอโทษอบอุ่น
// สวิตช์ settings.owner_chat_mode: ไม่มีแถว = เปิด · "off" = พฤติกรรมเดิม (UNKNOWN_TEXT) · อ่านพัง = ปิด
import { activeBrand, isGenericProfile } from "./brand.mjs";
import { createHash } from "node:crypto";
import { composeKnowledgeForChannel } from "./knowledgePack.mjs";
import { knowledgeBlockFor } from "./brain/compile.mjs";
import { usageFields } from "./llmUsageFields.mjs";
import { loadModelPricing, pricingById } from "./modelPricing.mjs";
import { bangkokIsoDate, channelLabel, maskName } from "./yoloText.mjs";
import { buildOwnerSnapshot } from "./ownerChatSnapshot.mjs";
import { findMentionedCustomers, mentionContextLines, MAX_MENTIONS } from "./ownerChatMentions.mjs";
import { resolveCustomer } from "./customerResolver.mjs";
import { approvedPriceLines, buildOwnerRules, looksLikePromptLeak, ownerPersona, PROMPT_LEAK_REPLY } from "./ownerChatPrompt.mjs";
import { extractLessonProposal } from "./ownerChatLessons.mjs";
import { cleanOwnerReply, customerNameForms } from "./ownerChatText.mjs";
import { ownerChatModelPlan } from "./ownerChatModel.mjs";
import { lookupPlannerSystem, lookupPlannerTranscript, needsLookup, validateLookupPlan } from "./ownerChatLookupCatalog.mjs";
import { runOwnerLookups } from "./ownerChatLookups.mjs";
import { collectRooms, roomLinkLines } from "./ownerChatLinks.mjs";

export const OWNER_CHAT_MODE_KEY = "owner_chat_mode";
export const OWNER_CHAT_MODES = Object.freeze(["on", "off"]);
// เพดานกันเงินรั่วจากลูปผิดปกติ (คนพิมพ์จริงไม่ถึง) — นับ "ครั้งที่เรียกโมเดล" ต่อวันเวลาไทยใน settings
// (นับจากความจำไม่ได้ เพราะความจำเก็บแค่ 200 เทิร์นล่าสุด) · อ่านตัวนับไม่ได้ = ถือว่าเต็ม (ไม่เดาว่าว่าง)
export const OWNER_CHAT_DAILY_CAP = 300;
export const OWNER_CHAT_DAY_COUNT_KEY = "owner_chat_day_count";
export const OWNER_CHAT_HISTORY_TURNS = 20;
const PLANNER_HISTORY_TURNS = 4;
const OWNER_TEXT_MAX = 4000;
// ผู้อ่านสมองของแชทเจ้าของ (ไม่ใช่ห้องลูกค้า) — คงที่ เพื่อให้ได้รุ่นเดิมทุกข้อความ (กลุ่มทดลองตัดสินจาก id)
const OWNER_BRAIN_SUBJECT = "owner:telegram";
const QUIET = { log() {}, warn() {}, error() {}, debug() {}, info() {} };

export const OWNER_CHAT_FALLBACK_TEXT = "ขอโทษนะคะพี่ง้วง ตอนนี้สมองลูกแพรติดขัดนิดหน่อย ตอบไม่ทัน 🙏 "
  + "ลองพิมพ์มาใหม่อีกทีได้เลยค่ะ ส่วนคำสั่ง yolo / เปิด-ปิด AI / สถานะ ยังใช้ได้ตามปกตินะคะ";
export const OWNER_CHAT_CAP_TEXT = "วันนี้พี่ง้วงคุยกับลูกแพรเยอะมากเลยค่ะ ระบบพักการคุยไว้ก่อนถึงเที่ยงคืน (กันค่า AI บานปลาย) "
  + "คำสั่ง yolo / เปิด-ปิด AI / สถานะ ยังใช้ได้ตามปกตินะคะ";
const LOOKUP_FAILED_NOTE = "ผลค้นข้อมูล: รอบนี้ค้นข้อมูลเพิ่มไม่สำเร็จ — ตอบจากข้อมูลสดเท่านั้น ถ้าคำถามต้องใช้ข้อมูลย้อนหลัง บอกพี่ง้วงตรง ๆ ว่ายังค้นไม่ได้ ให้ลองถามใหม่อีกครั้ง";

/** ไม่มีแถว = เปิด (คำสั่งเจ้าของ) · "off" = ปิด · อ่านพัง = ปิด (กลับไปพฤติกรรมเดิม) */
export function ownerChatMode(db) {
  // White-label: โปรไฟล์ generic ปิดฟีเจอร์เฉพาะธุรกิจคอร์สของพี่ง้วงเสมอ (ค่าใน DB ไม่มีผล)
  if (isGenericProfile(activeBrand())) return "off";
  try {
    const raw = String(db?.getSetting?.(OWNER_CHAT_MODE_KEY) ?? "").trim().toLowerCase();
    return raw === "off" ? "off" : "on";
  } catch {
    return "off";
  }
}

/** กุญแจความจำของเจ้าของคนนี้ — hash ของบัญชี Telegram (ไม่เก็บ id ดิบซ้ำอีกที่) */
export function ownerChatRef(owner) {
  const id = String(owner?.userId || "").trim();
  return id ? createHash("sha256").update(`lukprae-owner-chat:${id}`).digest("hex").slice(0, 24) : "";
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

// "2026-09-28:17" — วันเวลาไทย + จำนวนครั้งที่เรียกโมเดลแล้ววันนั้น
function dayCount(db, day) {
  const raw = String(db.getSetting(OWNER_CHAT_DAY_COUNT_KEY) || "");
  const [storedDay, count] = raw.split(":");
  return storedDay === day ? Math.max(0, Number(count) || 0) : 0;
}

// ชื่อของห้องที่พี่ง้วงเอ่ยถึง (รวมชื่อต้น) — ด่านความเป็นส่วนตัวของบทเรียนใช้กันชื่อลูกค้าติดไปกับบทเรียน
// ที่ใช้กับลูกค้าทุกคน (ด่านคอนโซลเทียบแค่ชื่อเต็ม แต่ในแชทคนเรียกกันด้วยชื่อต้น "คุณสมชาย")
function mentionedNames(db, mentions) {
  const names = [];
  for (const mention of mentions) {
    for (const room of mention.status === "unique" ? [mention.room] : mention.rooms || []) {
      const row = safe(() => db.getCustomer(room.id), null);
      names.push(row?.known_name, row?.display_name);
    }
  }
  return customerNameForms(names.filter(Boolean));
}

// ห้องในบริบทของข้อความนี้ (สำหรับแนบลิงก์) — ชื่อปิดบังชุดเดียวกับที่โมเดลเห็น
function contextRooms(db, snapshot, mentions) {
  const facts = snapshot?.facts || {};
  const fromMentions = [];
  for (const mention of mentions) {
    for (const room of mention.status === "unique" ? [mention.room] : mention.rooms || []) {
      fromMentions.push({ id: room.id, mask: maskName(room.label, 3), channel: channelLabel(room.channelId) });
    }
  }
  return [
    ...(facts.waiting?.rooms || []).map((room) => ({ id: room.id, mask: room.name, channel: room.channel })),
    ...(facts.hotLeads || []).map((lead) => ({ id: lead.id, mask: lead.name, channel: lead.channel })),
    ...(facts.actions || []).map((action) => action.room).filter(Boolean),
    ...fromMentions,
  ];
}

export function createOwnerChat({ config = {}, db, hermes, brainRuntime = null, fx = null, logger = console, now = Date.now }) {
  const available = () => typeof hermes?.draftReply === "function";
  const pricing = pricingById(safe(() => loadModelPricing(config.modelPricingFile, { logger: QUIET }), []));
  const thbPerUsd = () => safe(() => Number(fx?.current?.().thbPerUsd) || 0, 0) || Number(config.thbPerUsd) || 36;

  // จองโควตาหนึ่งครั้งก่อนเรียกโมเดล — เต็ม/อ่านตัวนับไม่ได้/เขียนไม่ได้ = ไม่เรียก
  function reserveCall(nowMs) {
    const day = bangkokIsoDate(nowMs);
    const used = safe(() => dayCount(db, day), OWNER_CHAT_DAILY_CAP);
    if (used >= OWNER_CHAT_DAILY_CAP) return false;
    try { db.setSetting(OWNER_CHAT_DAY_COUNT_KEY, `${day}:${used + 1}`); return true; } catch { return false; }
  }

  function recordUsage(result, kind) {
    if (!result?.usage) return;
    try { db.addLlmUsage({ customerId: "", kind, model: result.model || "", ...usageFields(result.usage) }); } catch { /* ห้ามล้ม */ }
  }

  function resolveBrain(nowMs) {
    if (!brainRuntime?.enabled) return null;
    try { return brainRuntime.resolve?.(OWNER_BRAIN_SUBJECT, "default", nowMs) ?? null; } catch { return null; }
  }

  // คำถามภาษาพูดเรื่องลูกค้าที่ mini AI อ่านเป็น "สถานะ" ("เคสคุณเอน่าปิดไหม ควรทักยังไง") — ตอบคำถามจริง
  // พร้อมห้องนั้นในบริบทแทนการ์ดสถานะ (เจอในรอบทดสอบกับโมเดลจริง 28 ก.ย.) · อ่านอย่างเดียว ไม่เปลี่ยนอะไร
  // เจอห้องเดียวเท่านั้น — กำกวม/ไม่เจอ ผู้เรียกใช้เส้นคำสั่งเดิม (รายการให้เลือก/ชื่อใกล้เคียง)
  function focusRoom({ target = "", channel = "" } = {}) {
    const resolution = safe(() => resolveCustomer(db, { query: target, channel }), null);
    if (resolution?.status !== "unique") return null;
    return { status: "unique", query: resolution.query, room: resolution.matches[0], loose: resolution.loose === true };
  }

  /**
   * วางแผนค้น (เรียกได้ก่อน mini AI ตอบ เพื่อให้สองอย่างวิ่งพร้อมกัน) — ไม่โยน error เด็ดขาด
   * @returns {Promise<{status: "skipped"|"ok"|"failed"|"capped", queries: Array, dropped?: Array}>}
   */
  async function plan({ text, owner }) {
    const ownerRef = ownerChatRef(owner);
    if (!ownerRef || !needsLookup(text) || typeof hermes?.scoreCustomer !== "function") return { status: "skipped", queries: [] };
    const nowMs = now();
    if (!reserveCall(nowMs)) return { status: "capped", queries: [] };
    const history = safe(() => db.recentOwnerChatTurns(ownerRef, { limit: PLANNER_HISTORY_TURNS }), []);
    let result = null;
    try {
      result = await hermes.scoreCustomer({ system: lookupPlannerSystem({ nowMs }), transcript: lookupPlannerTranscript({ text, history }), trustedTurns: true });
    } catch (err) {
      logger.warn?.(`ownerChat: วางแผนค้นไม่สำเร็จ (${err?.name || "Error"})`);
      result = null;
    }
    recordUsage(result, "score");
    if (!result || result.failed || typeof result.text !== "string") return { status: "failed", queries: [] };
    const checked = validateLookupPlan(result.text, { ownerText: text, nowMs });
    if (checked.dropped.length) logger.debug?.(`ownerChat: ทิ้งคิวรีที่ไม่ผ่าน ${checked.dropped.map((d) => `${d.name}:${d.reason}`).join(",")}`);
    return { status: "ok", queries: checked.queries, dropped: checked.dropped };
  }

  /** ประกอบพรอมต์ทั้งก้อน (ไม่เรียกโมเดล) — แยกไว้ให้เทสต์/ตรวจได้ว่าส่งอะไรออกไปบ้าง */
  function compose({ text, ownerRef, pendingHint = "", lessons = false, nowMs = now(), focus = null, lookups = null, lookupStatus = "skipped" }) {
    const brain = resolveBrain(nowMs);
    const bundle = brain?.bundle ?? null;
    const snapshot = buildOwnerSnapshot({ db, config, nowMs, logger, bundle });
    const detected = safe(() => findMentionedCustomers(db, text), []);
    const mentions = focus
      ? [focus, ...detected.filter((m) => !(m.status === "unique" && m.room.id === focus.room.id))].slice(0, MAX_MENTIONS)
      : detected;
    const lookupLines = lookups?.text
      ? ["ผลค้นข้อมูลสำหรับคำถามนี้ (ระบบค้นจากฐานข้อมูลจริงตอนนี้ · อ่านอย่างเดียว · ตัวเลขใช้ได้ตามนี้):", lookups.text]
      : lookupStatus === "failed" ? [LOOKUP_FAILED_NOTE] : [];
    const rules = buildOwnerRules({
      snapshot: snapshot.text,
      priceLines: approvedPriceLines(safe(() => (bundle ? bundle.guardTables.approvedPrices : db.approvedPrices()), [])),
      mentionLines: safe(() => mentionContextLines({ db, config, mentions, nowMs }), []),
      lookupLines,
      pendingHint,
    });
    return {
      draftArgs: {
        persona: ownerPersona({ lessons }),
        // ความรู้ชุดเดียวกับเส้นตอบลูกค้า (สมองกลาง) — อ่านพัง = "" (คุยต่อได้ บอกว่าไม่เห็นข้อมูล)
        knowledge: safe(() => (bundle ? knowledgeBlockFor(bundle, db, "default")
          : composeKnowledgeForChannel({ db, channelId: "default", logger })), ""),
        brandPack: "",
        rules,
        history: safe(() => db.recentOwnerChatTurns(ownerRef, { limit: OWNER_CHAT_HISTORY_TURNS }), [])
          .map((turn) => ({ role: turn.role, content: turn.content })),
        userText: [...String(text ?? "")].slice(0, OWNER_TEXT_MAX).join(""),
        role: "reply",
        // ข้อความของพี่ง้วงเอง (สอน/ร่างโพสต์เรื่อง prompt injection ได้) — ตัวตัดข้อความหลอกระบบไม่แตะ (รีวิวรอบ 4)
        trustedTurns: true,
        // คีย์แคชเดียวกับเส้นลูกค้าของรุ่นนี้ (ก้อนความรู้ขึ้นต้นเหมือนกัน) · ไม่ส่ง mirrorRoomId (ไม่ใช่ห้องลูกค้า)
        brainVersionId: brain?.versionId || "",
      },
      snapshot, mentions,
      rooms: collectRooms(contextRooms(db, snapshot, mentions), lookups?.rooms),
    };
  }

  // luna (ค่าตั้งต้น) ผ่าน draftWithModel · ไม่ตอบ = ถอยไปทางเดิม (sol) หนึ่งครั้งถ้ายังมีโควตา
  async function callModel(draftArgs, nowMs) {
    const choice = ownerChatModelPlan({ db, config });
    if (choice.mode === "luna" && typeof hermes.draftWithModel === "function") {
      let luna = null;
      try {
        luna = await hermes.draftWithModel({
          ...draftArgs, model: choice.model, reasoningEffort: choice.reasoningEffort,
          maxCompletionTokens: choice.maxCompletionTokens, retryMaxCompletionTokens: choice.retryMaxCompletionTokens,
        });
      } catch (err) {
        logger.warn?.(`ownerChat: luna ล้ม (${err?.name || "Error"})`);
        luna = null;
      }
      recordUsage(luna, "draft");
      if (typeof luna?.text === "string" && luna.text.trim()) return luna;
      logger.warn?.("ownerChat: luna ไม่ตอบ — ถอยไปใช้โมเดลหลัก (sol) หนึ่งครั้ง");
      if (!reserveCall(nowMs)) return null;
    }
    let sol = null;
    try { sol = await hermes.draftReply(draftArgs); } catch (err) {
      logger.warn?.(`ownerChat: เรียกโมเดลไม่สำเร็จ (${err?.name || "Error"})`);
      sol = null;
    }
    recordUsage(sol, "draft");
    return sol;
  }

  /**
   * ตอบพี่ง้วงหนึ่งข้อความ — lookup = แผนค้นที่เริ่มไว้ก่อน (ถ้าไม่มี วางแผนตรงนี้)
   * @returns {Promise<{ok: boolean, text: string, links?: string[], reason?: string, lesson?: object|null, customerNames?: string[], lookups?: string[]}>}
   */
  async function reply({ text, owner, pendingHint = "", lessons = false, focus = null, lookup = null }) {
    const ownerRef = ownerChatRef(owner);
    if (!available() || !ownerRef) return { ok: false, reason: "unavailable", text: OWNER_CHAT_FALLBACK_TEXT };
    const planned = (await (lookup ?? plan({ text, owner }).catch(() => null))) || { status: "failed", queries: [] };
    const nowMs = now();
    if (!reserveCall(nowMs)) return { ok: false, reason: "daily_cap", text: OWNER_CHAT_CAP_TEXT };
    const lookups = planned.queries?.length
      ? safe(() => runOwnerLookups({ db, config, queries: planned.queries, nowMs, pricing, thbPerUsd: thbPerUsd(), logger }), null)
      : null;
    const { draftArgs, mentions, rooms } = compose({
      text, ownerRef, pendingHint, lessons, nowMs, focus, lookups, lookupStatus: lookups ? "ok" : planned.status,
    });
    const result = await callModel(draftArgs, nowMs);
    if (!result || typeof result.text !== "string" || !result.text.trim()) {
      return { ok: false, reason: "model_failed", text: OWNER_CHAT_FALLBACK_TEXT };
    }
    const lastOwnerText = draftArgs.history.filter((turn) => turn.role === "user").at(-1)?.content || "";
    const proposal = extractLessonProposal(result.text, { ownerText: draftArgs.userText, previousOwnerText: lastOwnerText });
    let answer = cleanOwnerReply(proposal.text);
    if (looksLikePromptLeak(answer)) answer = PROMPT_LEAK_REPLY;
    if (!answer) return { ok: false, reason: "empty_reply", text: OWNER_CHAT_FALLBACK_TEXT };
    try {
      db.addOwnerChatExchange({ ownerRef, userText: draftArgs.userText, assistantText: answer });
    } catch (err) {
      logger.warn?.(`ownerChat: บันทึกความจำแชทไม่สำเร็จ (${err?.message || err}) — ตอบต่อได้ แต่ข้อความนี้จะไม่อยู่ในความจำ`);
    }
    return {
      ok: true, text: answer, links: roomLinkLines(answer, rooms, config),
      lesson: lessons ? proposal.lesson : null, customerNames: mentionedNames(db, mentions),
      lookups: lookups?.ran || [], model: result.model || "",
    };
  }

  return {
    available,
    enabled: () => available() && ownerChatMode(db) === "on",
    focusRoom,
    plan,
    compose,
    reply,
  };
}
