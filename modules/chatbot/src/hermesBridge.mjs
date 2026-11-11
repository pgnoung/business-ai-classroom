// hermesBridge.mjs — เรียกสมอง Hermes แบบ stateless เท่านั้น
//
// บทเรียนจากการทดสอบ G0:
// - ใช้ POST {HERMES_BASE}/chat/completions เท่านั้น — /v1/responses เก็บ state
//   ฝั่ง server ห้ามใช้กับข้อความลูกค้า
// - chassis เป็นเจ้าของ state ทั้งหมด: inject brand pack + persona + กติกา +
//   history N turns จาก DB เข้า prompt เองทุก call
// - error/timeout ทุกแบบ -> คืน null ให้ caller ใช้ rule fallback + mark human review
//   (fail-closed: สมองล่มห้ามเดา)
// - G2a: เพิ่ม scoreCustomer สำหรับ interest scorer — call แยกจาก reply เสมอ
//   (response_format ใช้ไม่ได้ — สั่ง JSON-only ใน prompt แล้ว parse defensive ฝั่งเรา)
import { wellFormedMessages } from "./unicodeText.mjs";
import { maskInjectionInMessages } from "./promptInjection.mjs";
import { sharedPersonaLength } from "./soul/index.mjs";
import { createHash, createHmac } from "node:crypto";
const MIRROR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// เพดานจำนวนข้อความประวัติที่ยอมส่งใน 1 request — ต้องต่ำกว่าเพดานของเกตเวย์เสมอ
// (เกตเวย์ปัจจุบันรับ 160 ใบรวม system+ข้อความล่าสุด) HISTORY_TURNS=60 = 120 ใบ
// จึงพอดีอยู่แล้ว ค่านี้คือกันชนไว้เผื่อมีคนขยาย HISTORY_TURNS โดยไม่ได้ดูฝั่งเกตเวย์
export const MAX_HISTORY_MESSAGES = 140;

// v1.4.2 (เคสจริง 2026-08-16 ตี 1: ลูกค้าถามคลาส+ราคาแล้วบอทตอบ "ขอเวลาตรวจข้อมูล"
// วนซ้ำ 3 รอบ): โมเดล reasoning หัก "โทเคนที่ใช้คิด" จากงบ completion ก้อนเดียวกับ
// ข้อความที่ตอบ — เส้น reply ไม่เคยประกาศงบเอง เลยได้ default ของเกตเวย์ (800)
// ซึ่งพอกติกาใน prompt หนาขึ้น โมเดลคิดจนงบหมดก่อนได้พิมพ์แม้แต่ตัวเดียว
// (finish_reason=length + content ว่าง -> 502 -> ลูกค้าเจอ template ค้าง)
// งบเป็น "เพดาน" ไม่ใช่เป้า — คำตอบปกติไม่แพงขึ้น จ่ายเพิ่มเฉพาะเทิร์นที่คิดหนักจริง
// v1.4.5 (คำสั่งพี่ง้วง 2026-08-15 "เพิ่มโควตาโทเคนได้เลย ผมต้องการคุณภาพจริงๆ"):
// ขยับเพดานขึ้นอีกชั้น — เทิร์นซับซ้อน (คลาส+ราคา+รูป+รีวิวควบกัน) ห้ามตายเพราะงบคิด
export const REPLY_MAX_COMPLETION_TOKENS = 6_000;
// retry หนึ่งครั้งด้วยเพดานสูงสุดของเกตเวย์ — เทิร์นหนักที่สุด (คลาส+ราคาควบคำถาม)
// ต้องจบในสองยกเสมอ ยกที่สองล้มค่อย fallback template (บทเรียน: ลูกค้าห้ามเจอความเงียบ
// แต่ template ซ้ำ ๆ แย่พอกัน)
export const REPLY_RETRY_MAX_COMPLETION_TOKENS = 10_000;

// 2026-10-01: ลองอ่านรูปซ้ำด้วยรุ่นสำรองเฉพาะเมื่อตัวหลักล้มเร็ว (500 ของ 6.1 กลับมาใน 1–2 วิ)
// ล้มหลังรอนานกว่านี้ = ไม่ลองซ้ำ เพื่อไม่ให้ห้องรอเกินสองเท่า
export const IMAGE_CLASSIFY_FALLBACK_MAX_WAIT_MS = 20_000;

// 5 ต.ค. 2026 (คำสั่งพี่ง้วง "ใช้ sol 6.1"): ตัวกวาดคัดกรองลูกค้ารายชั่วโมง (qualifySweep.mjs) ใช้รุ่นนี้ตายตัว
// ห้ามตาม scorer_model — แถวนั้นเปลี่ยนได้จากคอนโซล ถ้าใช้ scoreCustomer รุ่นของตัวกวาดจะเปลี่ยนตามเงียบ ๆ
// 11 ต.ค. 2026 ค่ำ (คำสั่งพี่ง้วง "กลับมาที่ sol 5.6 เหมือนเดิม"): 5.6 Sol — ต้องอยู่ใน HERMES_SCORER_ALLOWED_MODELS เสมอ
// 8 พ.ย. 2026 (พี่ง้วง "คัดกรองเข้าเกณฑ์ ... ปรับเป็น 6.1 sol ได้นะครับ"): กลับเป็น 6.1 Sol — 11 ต.ค. ถอยทุกบทบาทเพราะ
// คำตอบลูกค้า "ห้วน" ไม่ใช่เพราะการตัดสิน · งานนี้ไม่ส่งถึงลูกค้า · reasoning low รับได้ทั้งสองรุ่น
export const QUALIFY_MODEL = "gpt-6.1-sol";
// เพดานงบตอบของงานคัดกรอง — คำตอบเป็น JSON บรรทัดเดียว (~150 token) ที่เหลือเผื่อการคิดระดับ low
export const QUALIFY_COMPLETION_TOKEN_CEILING = 1_500;
// 12 ต.ค. 2026 (คำสั่งพี่ง้วง "คุยไปเรื่อย ... ให้คุณตีจบได้เลย"): กุญแจดอกที่ 2 ของการตีจบ (offtopicClose.mjs) ใช้ Luna ตายตัว
// ห้ามตาม scorer_model (สลับได้จากคอนโซล) · ต้องอยู่ใน HERMES_SCORER_ALLOWED_MODELS (production มี gpt-5.6-luna อยู่แล้ว)
export const OFFTOPIC_MODEL = "gpt-5.6-luna";
// คำตอบเป็น JSON บรรทัดเดียว (~60 token) — เพดานนี้คือกันชนให้การคิดแบบเบาของ Luna ไม่กินงบจนเนื้อว่าง
export const OFFTOPIC_COMPLETION_TOKEN_CEILING = 1_000;
// รีวิว 12 ต.ค.: Luna เรียกก่อนร่างคำตอบของลูกค้า — ห้ามรอถึง hermesTimeoutMs (90 วิ) · หมดเวลา = ไม่ตีจบ ตอบตามปกติ
export const OFFTOPIC_TIMEOUT_MS = 8_000;
const OFFTOPIC_TIMEOUT_MAX_MS = 30_000;
// 12 ต.ค. 2026 ค่ำ (พี่ง้วง: "AI เสนอห้องที่ท่าทีไม่พาไปสู่การเรียน แล้วพี่ง้วง/ชมพู่กดยืนยัน"): รอบตรวจ 09/12/15/19 ของเจ้าของ
// (ownerReviewScheduler.mjs) อ่านท่าทีห้องที่ไม่มีดอกที่ 1 ด้วย Luna รุ่นเดียวกัน — call แยก คีย์แคชของตัวเอง ไม่ใช่เส้นตอบลูกค้า
// ทำงานเบื้องหลัง (ไม่มีลูกค้ารอ) จึงรอได้นานกว่าเทิร์นสด แต่ยังมีเส้นตายของตัวเอง (ไม่ถือช่องเกตเวย์ค้าง)
export const OWNER_REVIEW_TIMEOUT_MS = 20_000;

// B8: getReplyModel/getScorerModel = getter อ่านสดทุก call (สลับโมเดลจาก console ได้
// โดยไม่ restart) — getter พัง/คืนค่าว่าง = ใช้ config.hermesModel เดิม (fail-safe)
// v1.4.9: เพิ่ม getFollowupModel — sub-agent ทักตามสเตจเลือกโมเดลแยกได้
// ค่าว่างทุกชั้น = ตามตัวหลัก (reply model ที่ resolve แล้ว ณ call นั้น)
export function createHermesBridge({
  config,
  fetchImpl = (...args) => globalThis.fetch(...args),
  logger = console,
  getReplyModel = null,
  getScorerModel = null,
  getFollowupModel = null,
}) {
  const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  const allowedModels = new Set(Array.isArray(config.hermesAllowedModels) ? config.hermesAllowedModels : []);
  const replyAllowedModels = new Set(Array.isArray(config.hermesReplyAllowedModels) && config.hermesReplyAllowedModels.length
    ? config.hermesReplyAllowedModels : allowedModels);
  const scorerAllowedModels = new Set(Array.isArray(config.hermesScorerAllowedModels) && config.hermesScorerAllowedModels.length
    ? config.hermesScorerAllowedModels : allowedModels);
  const followupAllowedModels = new Set(Array.isArray(config.hermesFollowupAllowedModels) && config.hermesFollowupAllowedModels.length
    ? config.hermesFollowupAllowedModels : allowedModels);

  function normalizedReasoningEffort(value) {
    const effort = String(value || "").trim().toLowerCase();
    return REASONING_EFFORTS.has(effort) ? effort : "";
  }

  function modelAllowed(model, roleAllowedModels = allowedModels) {
    return roleAllowedModels.size === 0 || roleAllowedModels.has(model);
  }

  function resolveModel(getter, configuredDefault = config.hermesModel, roleAllowedModels = allowedModels) {
    try {
      const model = typeof getter === "function" ? getter() : "";
      if (typeof model === "string" && model.trim() && modelAllowed(model.trim(), roleAllowedModels)) return model.trim();
    } catch {
      // getter พัง (เช่น DB อ่านไม่ได้) — ตกไปใช้ default เงียบ ๆ
    }
    if (typeof configuredDefault === "string" && configuredDefault.trim() && modelAllowed(configuredDefault.trim(), roleAllowedModels)) return configuredDefault.trim();
    if (typeof config.hermesModel === "string" && config.hermesModel.trim() && modelAllowed(config.hermesModel.trim(), roleAllowedModels)) return config.hermesModel.trim();
    return roleAllowedModels.values().next().value || config.hermesModel;
  }

  // v1.4.27 (วัดจริง 2026-08-19): v1.4.25 จัดลำดับ prompt ให้ส่วนคงที่อยู่หน้าสุดแล้ว
  // และพิสูจน์ได้ว่า prefix เหมือนกันข้ามเทิร์นถึง 98.2% — แต่รันจริง cache hit ยังได้แค่ 6%
  // (draft 18 ครั้งติด 0% ทุกครั้ง) เอกสาร OpenAI ระบุตรง ๆ ว่า
  // "For GPT-5.6, you must set prompt_cache_key to use the more reliable matching"
  // คือรุ่นที่เราใช้พอดี — ไม่มีคีย์นี้ คำขอถูกกระจายไปคนละเครื่องจึงหา cache ไม่เจอ
  //
  // คีย์ต้อง "คงที่ต่อรูปทรง prompt" ไม่ใช่ต่อลูกค้า — ถ้าแยกตามลูกค้า cache จะแตกเป็นเสี่ยง
  // และเสียประโยชน์ทั้งหมด (ส่วนที่แชร์กันคือคลังความรู้ + persona ซึ่งเหมือนกันทุกคน)
  // เอกสารแนะนำให้คุมทราฟฟิกต่อคีย์ ~15 req/min — ปริมาณจริงของเราต่ำกว่ามาก
  //
  // P2 (แบบแปลน §5): เมื่อ runtime อ่านสมองที่มีเวอร์ชัน คีย์กลายเป็น `<tenant>-<versionId>`
  // เวอร์ชันใหม่จึงหมุน cache **ครั้งเดียว** ตอนเผยแพร่ แทนที่จะแชร์คีย์เดิมกับเนื้อคนละชุด
  // (คีย์เดิมกับเนื้อใหม่ = จ่ายเต็มราคาไปเรื่อย ๆ โดยไม่มีใครเห็นว่าทำไม)
  const CACHE_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
  const TENANT_ID = String(config.businessId || "lukprae").replace(/[^A-Za-z0-9._:-]/gu, "-").slice(0, 24);
  // White-label: คีย์แคชของเส้นที่ไม่มีเวอร์ชันสมองขึ้นต้นด้วย "lukprae-" มาตลอด — โปรไฟล์ generic ใช้ BUSINESS_ID แทน
  // (course/production คงคีย์เดิมทุกตัวอักษร แม้ตั้ง BUSINESS_ID ไว้ — ไม่ให้แคชเดิมหมุนทิ้ง)
  const LABEL_PREFIX = config.brand?.profile === "generic" && config.businessId ? TENANT_ID : "lukprae";
  // 2026-10-04 (เครื่องตอบ v3): suffix แยกแคชของพรอมต์คนละรูปทรง ("-v3") ไม่ให้แย่งคีย์กับเครื่องเดิม
  // suffix ว่าง = คีย์เดิมทุกตัวอักษร (คีย์ยาวเกินยังเป็น "" เหมือนเดิม) · มี suffix แล้วยาวเกิน = ย่อด้วย sha256
  function cacheKeyFor(label, brainVersionId = "", suffix = "") {
    const version = String(brainVersionId || "").trim();
    const key = version ? `${TENANT_ID}-${version}${suffix}` : `${LABEL_PREFIX}-${label}${suffix}`;
    if (CACHE_KEY_PATTERN.test(key)) return key;
    if (!suffix) return "";
    const hashed = `${TENANT_ID}-${createHash("sha256").update(version + suffix).digest("hex").slice(0, 32)}`;
    return CACHE_KEY_PATTERN.test(hashed) ? hashed : "";
  }

  // แกนกลางยิง /chat/completions หนึ่งครั้ง — ทุกความล้มเหลวคืน null (fail-closed)
  async function callChat(messages, { label = "hermes", model = config.hermesModel, reasoningEffort = "", attempt = "primary", includeFailureMetadata = false, maxCompletionTokens = 0, signal = null, brainVersionId = "", mirrorRoomId = "", cacheSuffix = "", trustedTurns = false } = {}) {
    const promptCacheKey = cacheKeyFor(label, brainVersionId, cacheSuffix);
    if (!config.hermesBase) return null; // ไม่มีสมอง = ไม่เดา
    // Last provider boundary: callers and persisted legacy data may contain a
    // lone UTF-16 surrogate. Never serialize that malformed text upstream.
    // 12 ต.ค. 2026: ตัดข้อความหลอกระบบ (prompt injection) ของลูกค้าก่อนถึงโมเดลทุกเส้น (ร่าง/v3/ทักตาม/ให้คะแนน/ตัวกวาด/Luna/เรียนรู้)
    // แบบ best-effort เฉพาะโค้ดแบบแข็ง (รีวิวรอบ 5): ทุกข้อความลูกค้า/บทสนทนา = ตัดบรรทัดโค้ดและช่วงโค้ด บรรทัดภาษาไทยของคน + หัวแถวของเราคงไว้ ·
    // บล็อก system = ตัดเฉพาะบรรทัดที่มีโทเคน · คำสั่งให้ลืมคำสั่ง/ขอดูพรอมต์ไม่ตัด (โมเดลตอบตามกติกาของลูกแพร)
    // รวมข้อความในประวัติ (ส่งก้อนโค้ดมาเมื่อไหร่ก็ไม่ถึงโมเดล) · ไม่มีอะไรเข้าข่าย = คำขอเดิมทุกไบต์ (promptInjection.mjs)
    // รีวิวรอบ 7: ข้อความหลอกระบบไม่ใช่เหตุตีจบแล้ว — ตัดแล้วตอบตามปกติ (ตัวตัดเป็นด่านเดียวของเรื่องนี้)
    // ตัดก่อนจัดรูปยูนิโค้ด · trustedTurns = แชทเจ้าของ (Telegram) — ข้อความของพี่ง้วงเองไม่ถูกตัด
    // เส้นร่างคำตอบลูกค้า (hermes · hermes-followup) ที่มีการตัดจริง = ต่อบันทึกบอกโมเดลว่าป้ายคืออะไร (ตอบส่วนที่เหลือตามปกติ)
    const outboundMessages = wellFormedMessages(maskInjectionInMessages(messages, {
      trustedTurns, note: label === "hermes" || label === "hermes-followup",
    }));

    let res;
    try {
      const timeoutSignal = AbortSignal.timeout(config.hermesTimeoutMs);
      const providerSignal = signal && typeof signal.addEventListener === "function"
        ? AbortSignal.any([timeoutSignal, signal])
        : timeoutSignal;
      res = await fetchImpl(`${config.hermesBase.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.hermesApiKey ? { authorization: `Bearer ${config.hermesApiKey}` } : {}),
          ...(mirrorRoomId && label === "hermes" && config.hermesApiKey ? {
            "x-lukprae-role": label,
            "x-lukprae-room-hash": createHmac("sha256", config.hermesApiKey).update(String(mirrorRoomId)).digest("hex"),
            ...(brainVersionId ? { "x-lukprae-brain-version": brainVersionId } : {}),
          } : {}),
        },
        body: JSON.stringify({
          model,
          messages: outboundMessages,
          stream: false,
          ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
          // explicit = เชื่อหมุดที่เราปักเอง แทนการให้ระบบเดาจากข้อความล่าสุด
          // (ข้อความที่ไม่มีหมุดก็ยังทำงานได้ปกติ แค่ไม่มีอะไรถูกเก็บเพิ่ม)
          ...(outboundMessages.some((m) => Array.isArray(m.content)) ? { prompt_cache_options: { mode: "explicit" } } : {}),
          ...(normalizedReasoningEffort(reasoningEffort) ? { reasoning_effort: normalizedReasoningEffort(reasoningEffort) } : {}),
          ...(Number.isInteger(maxCompletionTokens) && maxCompletionTokens > 0 ? { max_completion_tokens: maxCompletionTokens } : {}),
        }),
        // SPEC ข้อ 5: ทุก fetch ต้องมี AbortSignal.timeout (Hermes 90s)
        signal: providerSignal,
      });
    } catch (err) {
      if (signal?.aborted) {
        logger.debug?.(`${label}: ยกเลิก draft ตามคำสั่ง caller`);
        return includeFailureMetadata ? { failed: true, retryable: false, failureClass: "cancelled" } : null;
      }
      // network down / timeout(AbortError|TimeoutError) — ทั้งหมด fallback ปลอดภัย
      logger.warn?.(`${label}: fetch ล้มเหลว (${err?.name || "Error"}: ${err?.message || err})`);
      return includeFailureMetadata ? { failed: true, retryable: true, failureClass: "transport" } : null;
    }

    if (!res || !res.ok) {
      logger.warn?.(`${label}: HTTP ${res?.status ?? "??"}`);
      const status = Number(res?.status || 0);
      const retryable = status === 0 || status === 408 || status === 429 || status >= 500;
      return includeFailureMetadata ? { failed: true, retryable, failureClass: retryable ? "unavailable" : "definitive_rejection" } : null;
    }

    let data;
    try {
      data = await res.json();
    } catch {
      logger.warn?.(`${label}: response ไม่ใช่ JSON`);
      return null;
    }

    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || !text.trim()) {
      logger.warn?.(`${label}: JSON ไม่มี choices/message/content ที่ใช้ได้`);
      return null;
    }

    // model แนบกลับไปให้ caller บันทึก llm_usage ได้ (B8.3)
    const mirrorId = res.headers?.get?.("x-lukprae-mirror-id") || "";
    // เกตเวย์รายงานรุ่นที่ตอบจริงทุกคำขอ ไม่ใช่เฉพาะตอน fallback — จด receipt นี้แทนรุ่นที่ขอ
    // เพื่อให้ llm_usage แยก requested config จาก actual served model ได้
    const servedModel = String(res.headers?.get?.("x-lukprae-served-model") || "");
    const usedModel = servedModel && /^[a-z0-9.-]{1,64}$/u.test(servedModel) ? servedModel : model;
    if (usedModel !== model) logger.warn?.(`${label}: ขอ ${model} แต่เกตเวย์รายงานว่าตอบด้วย ${usedModel}`);
    return { text: text.trim(), usage: data.usage ?? null, model: usedModel, attempt,
      ...(MIRROR_ID.test(mirrorId) ? { mirrorId } : {}) };
  }

  // เหตุ 2026-08-13: เกตเวย์จำกัดจำนวนข้อความต่อ request แต่ฝั่งนี้ไม่เคยนับเลย
  // พอบทสนทนายาวขึ้นเรื่อย ๆ (ความจำตลอดชีพ) จึงยิงเกินเพดานแล้วโดนตอบ 400 ทุกเทิร์น
  // ตัดของเก่าสุดทิ้งดีกว่าตอบลูกค้าไม่ได้เลย แต่ต้องดังพอให้ทีมงานเห็นว่ากำลังลืม
  function boundHistory(history) {
    const turns = history.map((turn) => ({ role: turn.role, content: String(turn.content ?? "") }));
    if (turns.length <= MAX_HISTORY_MESSAGES) return turns;
    const dropped = turns.length - MAX_HISTORY_MESSAGES;
    logger.warn?.(`hermes: ประวัติ ${turns.length} ข้อความเกินเพดาน ${MAX_HISTORY_MESSAGES} — ตัดของเก่าสุดทิ้ง ${dropped} ข้อความ`);
    return turns.slice(dropped);
  }

  // รูปข้อความของงานร่างทุกเส้น (draftReply / draftWithModel) — ส่วนคงที่ขึ้นหน้า + หมุดแคช (ดูเหตุผลใน draftReply)
  // 7 พ.ย. 2026 (งานแคช): แบ่งบล็อกตามความถี่ที่เปลี่ยน ข้อความรวมยังเหมือนเดิมทุกตัวอักษร
  // - ส่วน knowledge + persona ที่เส้นตอบแชทกับทักตามใช้ร่วมกัน (ราว 71k token) ปักหมุดของตัวเอง สองเส้นจึงอ่านแคชก้อนเดียวกัน
  // - cacheBrandPack: เฉพาะผู้เรียกที่ค้นการ์ดด้วยคำคงที่ (ทักตามตามสเตจ) การ์ดจึงเหมือนกันทุกห้อง · การ์ดที่เปลี่ยนตามข้อความห้ามปัก (เขียนแล้วไม่ได้อ่านซ้ำ)
  function draftMessages({ persona = "", brandPack = "", knowledge = "", rules = "", history = [], userText = "", cacheBrandPack = false }) {
    const stable = [knowledge, persona].filter(Boolean).join("\n\n");
    const volatile = [brandPack, rules].filter(Boolean).join("\n\n");
    const pinned = (text) => ({ type: "text", text, prompt_cache_breakpoint: { mode: "explicit" } });
    const systemBlocks = [];
    if (stable) {
      const stableText = volatile ? `${stable}\n\n` : stable;
      const sharedPersona = knowledge ? sharedPersonaLength(persona) : 0;
      const sharedEnd = sharedPersona ? knowledge.length + 2 + sharedPersona : 0;
      // ท้ายที่เหลือมีแต่ตัวขึ้นบรรทัด = ไม่แบ่ง (เกตเวย์ทิ้งบล็อกที่มีแต่ช่องว่าง ตัวคั่นจะหาย)
      if (sharedEnd && stableText.slice(sharedEnd).trim()) systemBlocks.push(pinned(stableText.slice(0, sharedEnd)), pinned(stableText.slice(sharedEnd)));
      else systemBlocks.push(pinned(stableText));
    }
    if (volatile) {
      if (cacheBrandPack && brandPack && rules) systemBlocks.push(pinned(`${brandPack}\n\n`), { type: "text", text: rules });
      else systemBlocks.push({ type: "text", text: volatile });
    }
    return [
      ...(systemBlocks.length ? [{ role: "system", content: systemBlocks }] : []),
      ...boundHistory(history),
      { role: "user", content: String(userText) },
    ];
  }

  // v1.3.4: knowledge เป็นพารามิเตอร์ของตัวเอง ไม่เดินทางซ่อนอยู่ใน brandPack อีก
  // เพราะ brandPack ผ่านตัวเลือกการ์ดที่ตัดด้วย .slice() ระดับตัวอักษร ความรู้ที่ทีมงาน
  // อนุมัติจึงเคยหายไปกลางทางแบบเงียบ ๆ (ค่าเริ่มต้น "" = พฤติกรรมเดิมทุกไบต์)
  // v1.4.9: role "followup" = เส้น sub-agent ทักตามสเตจ — ใช้ followup_model เมื่อตั้งไว้
  // ไล่ชั้น: getter (DB สด) -> config.hermesFollowupModel -> ตามตัวหลัก (reply resolved)
  async function draftReply({ persona = "", brandPack = "", knowledge = "", rules = "", history = [], userText = "", role = "reply", signal = null, brainVersionId = "", mirrorRoomId = "", trustedTurns = false, cacheBrandPack = false }) {
    // v1.4.25 (วัดจริง 2026-08-19): OpenAI คิดค่า cached input ถูกกว่าปกติมาก แต่ cache
    // ทำงานแบบ "prefix ต้องเหมือนเป๊ะ" — เดิมวาง brandPack ไว้หน้าสุดทั้งที่ selectRelevantBrandPack
    // เลือกการ์ดใหม่ทุกเทิร์นตามข้อความลูกค้า => prefix เปลี่ยนตั้งแต่ token แรก => cache พังทุก call
    // (พิสูจน์แล้ว: ยิง prompt เดียวกันสองครั้ง cached_tokens = 13,603/13,617 = 99.9%)
    // ลำดับใหม่เอาของ "คงที่" ขึ้นหน้า: knowledge (เรียง created_at,rowid คงที่) + persona
    // (ไฟล์ pinned) แล้วค่อยตามด้วยของที่เปลี่ยนทุกเทิร์น (brandPack, rules)
    //
    // v1.4.27: ลำดับอย่างเดียวไม่พอ — วัดจริงแล้ว prefix เหมือนกัน 98.2% แต่ cache ยังติด
    // แค่ 2-6% เพราะ implicit caching ปักจุดจำไว้ที่ "ข้อความล่าสุด" เสมอ ของที่ถูกเก็บ
    // จึงเป็นทั้งเทิร์นรวมส่วนท้ายที่เปลี่ยน พอเทิร์นถัดไปมาก็ไม่ตรงกับที่เก็บไว้
    // เอกสาร OpenAI แนะนำ explicit breakpoint กับรูปทรง "ของคงที่ก้อนใหญ่ + ท้ายเปลี่ยน"
    // ตรง ๆ — ปักหมุดท้ายส่วนคงที่ ส่วนนั้นจึงถูกเก็บเป็นก้อนของตัวเองและตรงทุกเทิร์น
    //
    // ข้อความที่โมเดลเห็นต้องเหมือนเดิม "ทุกตัวอักษร": บล็อกแรกจบด้วย "\n\n" แทนตัวคั่น
    // ที่ join เคยใส่ให้ ไม่งั้นเท่ากับแอบเปลี่ยน prompt ไปพร้อมกับงานประหยัดเงิน
    const messages = draftMessages({ persona, brandPack, knowledge, rules, history, userText, cacheBrandPack });
    const replyModel = resolveModel(getReplyModel, config.hermesModel, replyAllowedModels);
    const model = role === "followup"
      ? resolveModel(getFollowupModel, config.hermesFollowupModel || replyModel, followupAllowedModels)
      : replyModel;
    const label = role === "followup" ? "hermes-followup" : "hermes";
    // 2026-09-30: ระดับการคิดตั้งจาก HERMES_REPLY_REASONING_EFFORT — ว่าง = ไม่ส่ง (พรอมต์เดิมทุกไบต์)
    const reasoningEffort = config.hermesReplyReasoningEffort || "";
    // v1.4.2: ประกาศงบเองเสมอ (ห้ามพึ่ง default เกตเวย์) + retry หนึ่งครั้งด้วยเพดานเต็ม
    // เมื่อยกแรกล้มแบบ retryable (เคสหลัก: โมเดลคิดจนงบหมด content ว่าง -> 502)
    const first = await callChat(messages, {
      label, model, reasoningEffort, includeFailureMetadata: true,
      maxCompletionTokens: REPLY_MAX_COMPLETION_TOKENS,
      signal, brainVersionId, mirrorRoomId, trustedTurns,
    });
    if (first && !first.failed) return first;
    // retry เฉพาะ 5xx (เคสหลัก: 502 content ว่าง) — timeout ไม่ retry เพราะกินเวลา
    // ไปแล้ว 90 วิ ลูกค้ารอ 3 นาทีแย่กว่าได้ fallback แล้วคนจริงเข้ามาดู
    if (!first || first.retryable !== true || first.failureClass === "transport") return null;
    logger.warn?.(`${label}: ยกแรกล้มแบบ retryable — ลองอีกครั้งด้วยงบเพดานเต็ม`);
    const second = await callChat(messages, {
      label, model, reasoningEffort, attempt: "retry_full_budget",
      maxCompletionTokens: REPLY_RETRY_MAX_COMPLETION_TOKENS,
      signal, brainVersionId, mirrorRoomId, trustedTurns,
    });
    return second && !second.failed ? second : null;
  }

  // 2026-10-04 (เครื่องตอบ v3 — spec v3.1 §A4): รับ messages ที่ประกอบเสร็จแล้ว (บล็อกแคช + บล็อกต่อเทิร์น + ประวัติ)
  // โมเดล/ระดับการคิด/งบ/retry ชุดเดียวกับ draftReply บทบาท reply · label "hermes" = หัว mirror เหมือนเดิม
  // คีย์แคช "-v3" แยกจากเครื่องเดิม · ล้มแบบ transport/timeout = null ทันทีเหมือน draftReply
  async function draftReplyV3({ messages = [], signal = null, brainVersionId = "", mirrorRoomId = "", attempt = "v3" } = {}) {
    const model = resolveModel(getReplyModel, config.hermesModel, replyAllowedModels);
    const reasoningEffort = config.hermesReplyReasoningEffort || "";
    const options = { label: "hermes", model, reasoningEffort, signal, brainVersionId, mirrorRoomId, cacheSuffix: "-v3" };
    const first = await callChat(messages, {
      ...options, attempt, includeFailureMetadata: true, maxCompletionTokens: REPLY_MAX_COMPLETION_TOKENS,
    });
    if (first && !first.failed) return first;
    if (!first || first.retryable !== true || first.failureClass === "transport") return null;
    logger.warn?.("hermes: v3 ยกแรกล้มแบบ retryable — ลองอีกครั้งด้วยงบเพดานเต็ม");
    const second = await callChat(messages, { ...options, attempt: `${attempt}_retry_full_budget`, maxCompletionTokens: REPLY_RETRY_MAX_COMPLETION_TOKENS });
    return second && !second.failed ? second : null;
  }

  // 28 ก.ย. 2026 (คำสั่งพี่ง้วง "ลองปรับ telegram เป็น luna ได้ไหม"): แชทเจ้าของเลือกโมเดลเองนอกบทบาท
  // ตอบลูกค้า — ตรวจกับรายการโมเดลรวมของระบบ (HERMES_ALLOWED_MODELS) ไม่ใช่ allowlist ของเส้นตอบลูกค้า
  // ไม่ผ่าน = คืน null โดยไม่ยิงอะไร (ผู้เรียกถอยไปทางเดิม) · รูปข้อความเดียวกับ draftReply ทุกไบต์
  // ไม่มีหัว mirror (label ไม่ใช่ "hermes") — ไม่ใช่ห้องลูกค้า · retry หนึ่งครั้งกติกาเดียวกับ draftReply
  async function draftWithModel({
    model = "", reasoningEffort = "", maxCompletionTokens = REPLY_MAX_COMPLETION_TOKENS,
    retryMaxCompletionTokens = REPLY_RETRY_MAX_COMPLETION_TOKENS, label = "hermes-owner",
    brainVersionId = "", signal = null, trustedTurns: _trusted = true, ...parts
  } = {}) {
    const chosen = String(model || "").trim();
    if (!chosen || !modelAllowed(chosen)) {
      logger.warn?.(`${label}: โมเดล "${chosen || "-"}" ไม่อยู่ในรายการที่ระบบอนุญาต — ไม่เรียก provider`);
      return null;
    }
    const messages = draftMessages(parts);
    // แชทเจ้าของเท่านั้น: ข้อความของพี่ง้วงไม่ถูกตัด ตัดเฉพาะโทเคนในบล็อก system (ห้องลูกค้าที่ยกมา)
    const first = await callChat(messages, {
      label, model: chosen, reasoningEffort, includeFailureMetadata: true, maxCompletionTokens, signal, brainVersionId, trustedTurns: true,
    });
    if (first && !first.failed) return first;
    if (!first || first.retryable !== true || first.failureClass === "transport") return null;
    logger.warn?.(`${label}: ยกแรกล้มแบบ retryable — ลองอีกครั้งด้วยงบที่ใหญ่ขึ้น`);
    const second = await callChat(messages, {
      label, model: chosen, reasoningEffort, attempt: "retry_full_budget",
      maxCompletionTokens: retryMaxCompletionTokens, signal, brainVersionId, trustedTurns: true,
    });
    return second && !second.failed ? second : null;
  }

  // G2a (F3): scorer call — stateless เหมือนเดิม แต่ transcript ถูก render เป็น
  // ข้อความเดียว (scorer วิเคราะห์บทสนทนา ไม่ได้คุยต่อ)
  // คืน { text, usage, model } หรือ null — parse/validate JSON เป็นหน้าที่ caller
  // B8: ใช้ scorer_model แยกจาก reply_model (score วิ่งบนโมเดลถูกได้)
  // trustedTurns = transcript เป็นข้อความของพี่ง้วงเอง (mini AI ถอดคำสั่ง Telegram · วางแผนค้นของแชทเจ้าของ) — ไม่ตัด
  async function scoreCustomer({ system = "", transcript = "", trustedTurns = false }) {
    // system เป็นบล็อกได้ (ส่วนคงที่ปักหมุดแคช + ส่วนของห้องนี้ — ดู scorerSystemBlocks)
    const systemContent = Array.isArray(system) ? system : String(system);
    const messages = [
      ...(system && systemContent.length ? [{ role: "system", content: systemContent }] : []),
      { role: "user", content: String(transcript) },
    ];
    return callChat(messages, {
      label: "hermes-scorer",
      model: resolveModel(getScorerModel, config.hermesScorerModel || config.hermesModel, scorerAllowedModels),
      includeFailureMetadata: true,
      maxCompletionTokens: config.scorerMaxTokens,
      trustedTurns: trustedTurns === true,
    });
  }

  // Optional scorer recovery call. The pipeline invokes this only after the
  // primary scorer is unavailable or returns a structurally unusable payload.
  // It never runs on the reply path and therefore cannot duplicate a LINE send.
  async function scoreCustomerFallback({ system = "", transcript = "" }) {
    const primaryModel = resolveModel(getScorerModel, config.hermesScorerModel || config.hermesModel, scorerAllowedModels);
    const fallbackModel = String(config.hermesScorerFallbackModel || "").trim();
    // v1.4.10: fallback ที่ "ไม่ยิงเลย" ต้องบอกเหตุผล — เหตุ 2026-08-17 terra เงียบทั้งวัน
    // โดยไม่มีร่องรอยว่าข้ามเพราะอะไร
    if (!fallbackModel || fallbackModel === primaryModel || !modelAllowed(fallbackModel)) {
      const why = !fallbackModel ? "no_fallback_model"
        : fallbackModel === primaryModel ? "fallback_equals_primary" : "fallback_not_allowed";
      logger.debug?.(`hermes-scorer-fallback: ข้ามไม่ยิง (${why})`);
      return null;
    }
    const messages = [
      ...(system ? [{ role: "system", content: String(system) }] : []),
      { role: "user", content: String(transcript) },
    ];
    return callChat(messages, {
      label: "hermes-scorer-fallback",
      model: fallbackModel,
      reasoningEffort: config.hermesScorerFallbackReasoningEffort,
      attempt: "fallback",
      maxCompletionTokens: config.scorerMaxTokens,
    });
  }

  // C-1: bounded daily-learning clustering. This shares the stateless scorer
  // boundary but never inherits the larger sales scorer completion budget.
  // The caller performs its own cost preflight and schema/risk validation;
  // this final provider boundary still enforces the approved scorer allowlist
  // and the absolute 1,500-token ceiling from the Console spec.
  async function scoreLearning({ system = "", transcript = "", model = "", maxCompletionTokens = 1500 } = {}) {
    const requestedModel = String(model || "").trim();
    if (!requestedModel || !modelAllowed(requestedModel, scorerAllowedModels)) {
      logger.warn?.("hermes-learning: model ไม่อยู่ใน scorer allowlist — ไม่เรียก provider");
      return null;
    }
    const boundedTokens = Math.min(1500, Math.max(1, Math.trunc(Number(maxCompletionTokens)) || 1500));
    const messages = [
      ...(system ? [{ role: "system", content: String(system) }] : []),
      { role: "user", content: String(transcript) },
    ];
    return callChat(messages, {
      label: "hermes-learning",
      model: requestedModel,
      maxCompletionTokens: boundedTokens,
    });
  }

  // 5 ต.ค. 2026 (คำสั่งพี่ง้วง): ตัวกวาดคัดกรอง "ไม่เข้าเกณฑ์" รายชั่วโมง — call แยกจากเส้นตอบลูกค้าเสมอ
  // · รุ่นตายตัว QUALIFY_MODEL แต่ยังต้องผ่าน scorer allowlist เป็นด่านสุดท้าย (ไม่ผ่าน = ไม่ยิง คืน null)
  // · system = กติกาคงที่ชุดเดียวทุกห้อง ปักหมุดแคชแบบ explicit · user = ข้อมูลของห้องนั้น (ท้ายสุดเสมอ)
  // · ไม่ส่ง brainVersionId: คีย์แคชต้องเป็น lukprae-hermes-qualify ของตัวเอง ห้ามชนคีย์ <tenant>-<version> ของเส้นตอบ
  // · reasoning low: งานจัดหมวดจากหลักฐานที่ยกมา ไม่ต้องคิดยาว (6.1 Sol ไม่รับ none/minimal · 5.6 Sol รับ low — ยิงจริงผ่านเกตเวย์ production 11 ต.ค. ได้ 200)
  // · ไม่มี retry ในตัว: ล้มแล้วตัวกวาดลองใหม่รอบหน้าเอง — ห้ามยิงซ้อน (เกตเวย์ MAX_INFLIGHT=4 ใช้ร่วมกับเส้นตอบลูกค้า)
  async function qualifyCustomer({ system = "", user = "", maxCompletionTokens = 800 } = {}) {
    // HERMES_QUALIFY_MODEL (white-label) — ไม่ตั้ง = QUALIFY_MODEL เดิมทุกตัวอักษร
    const qualifyModel = String(config.hermesQualifyModel || "").trim() || QUALIFY_MODEL;
    if (!modelAllowed(qualifyModel, scorerAllowedModels)) {
      logger.warn?.(`hermes-qualify: ${qualifyModel} ไม่อยู่ใน scorer allowlist — ไม่เรียก provider`);
      return null;
    }
    const boundedTokens = Math.min(QUALIFY_COMPLETION_TOKEN_CEILING,
      Math.max(1, Math.trunc(Number(maxCompletionTokens)) || 800));
    const systemContent = Array.isArray(system)
      ? system
      : (String(system) ? [{ type: "text", text: String(system), prompt_cache_breakpoint: { mode: "explicit" } }] : []);
    const messages = [
      ...(systemContent.length ? [{ role: "system", content: systemContent }] : []),
      { role: "user", content: String(user) },
    ];
    return callChat(messages, {
      label: "hermes-qualify",
      model: qualifyModel,
      reasoningEffort: "low",
      includeFailureMetadata: true,
      maxCompletionTokens: boundedTokens,
    });
  }

  // 12 ต.ค. 2026: ยืนยันการตีจบแชทนอกเรื่อง (กุญแจดอกที่ 2 — offtopicClose.mjs) — call แยกจากเส้นตอบลูกค้าเสมอ
  // · รุ่นตายตัว OFFTOPIC_MODEL ผ่าน scorer allowlist เป็นด่านสุดท้าย (ไม่ผ่าน = ไม่ยิง คืน null = ไม่ตีจบ)
  // · ไม่ส่ง reasoning_effort (เกตเวย์รับ low/medium/high กับ Luna — ค่าเริ่มต้นของ Luna คิดเบาอยู่แล้ว) · ไม่มี retry ในตัว
  // · system คงที่ปักหมุดแคช (คีย์ lukprae-hermes-offtopic ของตัวเอง) · user = หมวด + บทสนทนาของห้องนั้น
  // · เส้นตายของตัวเอง (OFFTOPIC_TIMEOUT_MS ราว 8 วิ ไม่ใช่ 90 วิของสมองหลัก): ยกเลิก fetch ด้วย signal และ race กับนาฬิกา
  //   (fetch ที่ไม่ฟัง signal ก็ค้างไปป์ไลน์ไม่ได้) — หมดเวลา = { failed } = ไม่ตีจบ
  async function offtopicCheck({ system = "", user = "", maxCompletionTokens = 600, timeoutMs = OFFTOPIC_TIMEOUT_MS } = {}) {
    return lunaJsonCheck("hermes-offtopic", { system, user, maxCompletionTokens, timeoutMs, defaultTimeoutMs: OFFTOPIC_TIMEOUT_MS });
  }

  // 12 ต.ค. 2026 ค่ำ: อ่านท่าทีห้องให้รอบตรวจของเจ้าของ (ownerReviewPrompt.mjs) — รุ่น/allowlist/เพดาน token เดียวกับ offtopicCheck
  // คีย์แคช lukprae-hermes-owner-review ของตัวเอง (system prompt คนละชุด ห้ามแย่งแคชของดอกที่ 2)
  // เฟส B: purpose "daily" = คิวตรวจแชท 20:00 (ownerReviewDailyPrompt.mjs) — call เดิม แค่คีย์แคชแยก (-daily) ไม่แย่งกับการอ่านท่าที
  async function ownerReviewCheck({ system = "", user = "", maxCompletionTokens = 600, timeoutMs = OWNER_REVIEW_TIMEOUT_MS, purpose = "" } = {}) {
    // 3 พ.ย. 2026: purpose "team" = ตรวจคำตอบของทีม (teamReplyReview.mjs) — คีย์แคชของตัวเอง
    const label = purpose === "daily" ? "hermes-owner-review-daily"
      : purpose === "team" ? "hermes-owner-review-team" : "hermes-owner-review";
    return lunaJsonCheck(label, { system, user, maxCompletionTokens, timeoutMs, defaultTimeoutMs: OWNER_REVIEW_TIMEOUT_MS });
  }

  async function lunaJsonCheck(label, { system = "", user = "", maxCompletionTokens = 600, timeoutMs, defaultTimeoutMs } = {}) {
    if (!modelAllowed(OFFTOPIC_MODEL, scorerAllowedModels)) {
      logger.warn?.(`${label}: ${OFFTOPIC_MODEL} ไม่อยู่ใน scorer allowlist — ไม่เรียก provider`);
      return null;
    }
    const boundedTokens = Math.min(OFFTOPIC_COMPLETION_TOKEN_CEILING,
      Math.max(1, Math.trunc(Number(maxCompletionTokens)) || 600));
    const deadlineMs = Math.min(OFFTOPIC_TIMEOUT_MAX_MS, Math.max(1, Math.trunc(Number(timeoutMs)) || defaultTimeoutMs));
    const messages = [
      ...(String(system) ? [{ role: "system", content: [{ type: "text", text: String(system), prompt_cache_breakpoint: { mode: "explicit" } }] }] : []),
      { role: "user", content: String(user) },
    ];
    const controller = new AbortController();
    let timer = null;
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        logger.warn?.(`${label}: เกิน ${deadlineMs} ms — ไม่รอ (ไม่ตีจบ/ไม่เสนอ)`);
        resolve({ failed: true, retryable: true, failureClass: "timeout" });
      }, deadlineMs);
    });
    try {
      return await Promise.race([
        callChat(messages, {
          label,
          model: OFFTOPIC_MODEL,
          includeFailureMetadata: true,
          maxCompletionTokens: boundedTokens,
          signal: controller.signal,
        }),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  // v1.4.48: จำแนกรูปขาเข้าว่าเป็นสลิป/เอกสารหรือไม่ — คืนข้อความดิบให้ผู้เรียกแปลเอง
  // ใช้เพดาน token ต่ำเพราะคำตอบเป็น JSON บรรทัดเดียว และคุมค่าใช้จ่ายต่อรูป
  // 2026-10-01: 6.1 Sol ตอบ HTTP 500 กับรูปราว 6% (5.6 Sol 0 จาก 48) — ถ้าไม่ลองซ้ำ รูปเมนูธรรมดา
  // จะกลายเป็น unknown แล้วปิด AI ทั้งห้อง จึงลองซ้ำด้วยรุ่นสำรองหนึ่งครั้ง เฉพาะความล้มแบบชั่วคราว
  // (คำตอบที่ได้แต่อ่านไม่ออก/ถูกปฏิเสธถาวร ไม่ลองซ้ำ — ปล่อยให้ fail-closed ตามเดิม)
  // ล้มช้า (หมดเวลา) ก็ไม่ลองซ้ำ: ห้องรอคำตอบอยู่ ไม่มีเพดานเวลารวมคุมอีกชั้น
  async function classifyImageMessages(messages, { signal = null } = {}) {
    const model = config.imageClassifyModel || config.hermesModel;
    const startedAt = Date.now();
    const result = await callChat(messages, {
      label: "image-classify", model, maxCompletionTokens: 300, signal, includeFailureMetadata: true,
    });
    if (!result?.failed) return result?.text || "";
    const fallbackModel = config.imageClassifyFallbackModel || "";
    const failedFast = Date.now() - startedAt <= IMAGE_CLASSIFY_FALLBACK_MAX_WAIT_MS;
    if (!result.retryable || !failedFast || !fallbackModel || fallbackModel === model || !modelAllowed(fallbackModel) || signal?.aborted) return "";
    logger.warn?.(`image-classify: ${model} ล้มชั่วคราว (${result.failureClass}) — ลองซ้ำด้วย ${fallbackModel}`);
    const retry = await callChat(messages, {
      label: "image-classify-fallback", model: fallbackModel, attempt: "fallback", maxCompletionTokens: 300, signal,
    });
    return retry?.text || "";
  }

  async function recordMirrorDelivery(value) {
    if (!MIRROR_ID.test(value?.id || "") || !config.hermesBase) return false;
    try {
      const response = await fetchImpl(`${config.hermesBase.replace(/\/+$/, "")}/mirror/delivery`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.hermesApiKey}` },
        body: JSON.stringify(value), signal: AbortSignal.timeout(2000), redirect: "error",
      });
      return response.ok && (await response.json()).recorded === true;
    } catch { return false; }
  }
  return { draftReply, draftReplyV3, draftWithModel, scoreCustomer, scoreCustomerFallback, scoreLearning, qualifyCustomer, offtopicCheck, ownerReviewCheck, classifyImageMessages, recordMirrorDelivery };
}
