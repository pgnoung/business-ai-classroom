// yolo.mjs — "YOLO": ลูกแพรพิมพ์ต่อในห้องนี้ตอนนี้ 1 ครั้งตามคำสั่งพี่ง้วง (2026-09-28)
//
// use case จากพี่ง้วงเอง:
//   (1) วันอาทิตย์ชมพู่หยุด ลูกค้า in-house ถามต่อหลังลูกแพรส่งต่อทีมไปแล้ว (AI ปิด) — ไม่มีใครตอบ
//       จนพรุ่งนี้ → YOLO ให้ลูกแพรกลับมาตอบในบริบทเดิมหนึ่งครั้ง
//   (2) ลูกค้าเงียบ ต้องรอ FU cold อีก 3 ชม. → YOLO ทักตอนนี้เลยแทน FU ขั้นนั้น
//
// ไม่ใช่ทางส่งเส้นที่สอง — ใช้ชิ้นส่วนเดียวกับ follow-up ทุกชิ้น (stagedFollowups.mjs):
//   ร่าง: hermes.draftReply(role "followup") + persona/ความรู้/brand pack/สมองรุ่นของห้อง
//   ด่าน: compliance guard ตารางราคาของห้อง · ห้ามช่องทางชำระเงิน · กันแก้ราคาขึ้น ·
//         marker รูปผ่านแคตตาล็อก · humanizer · reply delivery policy
//   ส่ง: รั้ว proactive_attempts (lane 'yolo') ก่อนข้ามเส้น provider → lineRegistry.sendBubbles
//        (pilot allowlist + FB ต่อข้อความ) → บันทึกเฉพาะที่ provider รับจริง (message_class proactive)
// ไม่แตะสวิตช์ AI ของห้อง เว้นแต่สั่ง "แล้วคุยต่อ" (เส้นเดียวกับปุ่มคอนโซล — aiSwitch.mjs)
import { randomUUID } from "node:crypto";
import { aiPausedNow } from "./aiPause.mjs";
import { withCampaignReceiptPolicy } from "./campaignReceiptPolicy.mjs";
import { composeBrandPackOnly, composeKnowledgeForChannel } from "./knowledgePack.mjs";
import { catalogShortlistContext, knowledgeWithCatalogShortlist } from "./reviewCatalogPrompt.mjs";
import { applyKnownFactsOverride, IMAGE_DEDUPE_WINDOW_MS } from "./pipeline.mjs";
import { selectRelevantBrandPack } from "./brainPackSelector.mjs";
import { selectFollowupKnowledge } from "./brain/followupKnowledge.mjs";
import { upcomingRoundsFor } from "./brain/compile.mjs";
import { announcedRoundsLines, seatRuleLines, upcomingRounds } from "./classRounds.mjs";
import { extractImageMarkers } from "./imageCatalog.mjs";
import { dropGenericAddress, enforceCustomerAddress, planCustomerAddress } from "./customerAddress.mjs";
import { degradeToDeliverable } from "./replyDeliveryPolicy.mjs";
import { paymentInstructionsIndex } from "./salesDecisionGuard.mjs";
import { detectUpwardPriceRevision } from "./priceConsistency.mjs";
import { usageFields } from "./llmUsageFields.mjs";
import { bangkokDayStartMs } from "./bangkokTime.mjs";
import { FB_MESSAGING_WINDOW_MS } from "./db.mjs";
import { YOLO_LANE } from "./dbYolo.mjs";
import {
  evaluateYoloPreflight, findInstructionLeak, yoloReasonText,
  YOLO_FB_DRAFT_MARGIN_MS, YOLO_ROOM_COOLDOWN_MS, YOLO_DAILY_SEND_CAP, YOLO_UNRESOLVED_LOOKBACK_MS,
} from "./yoloPolicy.mjs";
import { YOLO_REPAIR_RULES, YOLO_USER_TEXT, yoloRules } from "./yoloPrompt.mjs";
import { createYoloDelivery, customerSummary, instructionHash, refused } from "./yoloDelivery.mjs";
import { createYoloHandoff } from "./yoloHandoff.mjs";
import { bangkokIsoDate, bangkokNowLabel, cleanInstruction, graphemes } from "./yoloText.mjs";
import { scopedPersona, withRoomSoul } from "./soul/index.mjs";

export { instructionHash };

const MAX_INSTRUCTION = 500;
const PAYMENT_IMAGE_KEY = /^(?:payment|bank|promptpay|qr)/iu;
const ASKS_FOR_IMAGES = /รูป|ภาพ|โปสเตอร์|image|photo/iu;

export function createYolo({
  config, db, hermes, lineRegistry, guard, humanizer,
  persona = "", brandPack = "", brainRuntime = null, imageCatalog = [], replyDeliveryPolicy = null,
  pipeline = null, notifier = null, logger = console, now = Date.now,
}) {
  const catalogByKey = new Map((imageCatalog || []).map((entry) => [entry.key, entry]));
  const inFlight = new Set();
  const delivery = createYoloDelivery({ config, db, lineRegistry, catalogByKey, logger, now });
  // 2026-10-15: ตัวเลือก "ส่งต่อแอดมิน" — ไม่ร่าง ส่งคำของคนตามนั้น + ธงรอคน + push แอดมิน
  const { handoff } = createYoloHandoff({ config, db, lineRegistry, notifier, pipeline, logger, now });

  function safe(fn, fallback) {
    try { return fn(); } catch { return fallback; }
  }

  function gatherFacts(customerId, nowMs) {
    const id = String(customerId || "");
    const customer = id ? safe(() => db.getCustomer(id), null) : null;
    const lastInboundAt = customer ? safe(() => db.lastInboundAt(id), null) : null;
    const isFacebook = String(customer?.channel_id || "") === "facebook";
    const dayStart = bangkokDayStartMs(nowMs);
    return {
      customer,
      nowMs,
      isCanary: id.startsWith("canary:"),
      isLegacy: customer ? safe(() => db.isLegacyReferenceRoom(id), false) : false,
      lastInboundAt,
      lastOperatorOutboundAt: customer ? safe(() => db.lastOperatorOutboundAt(id), null) : null,
      silencedTag: customer ? safe(() => db.isBotSilencedByTag(id), false) : false,
      // อ่าน pause ไม่ได้ = ถือว่าหยุด (fail-safe เดียวกับ aiPause.mjs)
      aiPaused: aiPausedNow({ db, config }),
      fbWindowOpenForDraft: !isFacebook || safe(() => db.withinFacebookWindow(id, nowMs + YOLO_FB_DRAFT_MARGIN_MS), false),
      fbClosesAt: isFacebook && lastInboundAt ? Number(lastInboundAt) + FB_MESSAGING_WINDOW_MS : null,
      inFlight: inFlight.has(id),
      // อ่านเพดานไม่ได้ = ถือว่าเต็ม (ไม่เดาว่าว่าง)
      roomSends: safe(() => db.countYoloSends({ customerId: id, sinceMs: nowMs - YOLO_ROOM_COOLDOWN_MS }), 1),
      daySends: safe(() => db.countYoloSends({ sinceMs: dayStart }), YOLO_DAILY_SEND_CAP),
      dayDrafts: safe(() => db.countYoloDrafts({ sinceMs: dayStart }), Number.MAX_SAFE_INTEGER),
      // รั้วส่งที่ค้างผลกำกวม (ระบบดับระหว่างส่ง) — ตอนกำลังส่งอยู่จริงในโปรเซสนี้ in_flight กันไว้แล้ว
      // อ่านไม่ได้ = ไม่รู้ (ถ้า DB อ่านไม่ได้จริง roomSends ข้างบนถอยเป็น "เต็ม" และปฏิเสธก่อนถึงตรงนี้)
      unresolvedSendAt: inFlight.has(id) ? null
        : safe(() => db.lastUnresolvedYoloSendAt({ customerId: id, sinceMs: nowMs - YOLO_UNRESOLVED_LOOKBACK_MS }), null),
      // นัด follow-up ที่ทีมตั้งเอง (followupEngine) — YOLO ไม่ยกเลิกของคน แค่เตือนว่ามีนัดใกล้ ๆ
      nextAppointmentAt: customer ? safe(() => db.listFollowupsFor(id, 20)
        .filter((row) => row.status === "pending" && Number(row.scheduled_at) <= nowMs + 24 * 3_600_000)
        .map((row) => Number(row.scheduled_at)).sort((a, b) => a - b)[0] ?? null, null) : null,
    };
  }

  // สิ่งที่คอนโซลโชว์ก่อนกดส่ง — ไม่ร่าง ไม่เขียนอะไรทั้งสิ้น
  function preflight(customerId) {
    const nowMs = now();
    const facts = gatherFacts(customerId, nowMs);
    const verdict = evaluateYoloPreflight(facts);
    return {
      customer: customerSummary(facts.customer),
      refusal: verdict.refusal ? { code: verdict.refusal, text: yoloReasonText(verdict.refusal) } : null,
      confirm: verdict.confirm.map((code) => ({ code, text: yoloReasonText(code) })),
      warnings: verdict.warnings,
      fbWindowClosesAt: facts.fbClosesAt,
      daySends: facts.daySends,
      dayCap: YOLO_DAILY_SEND_CAP,
    };
  }

  function latestScorePayload(customerId) {
    try {
      const row = db.scoreHistory(customerId, 1)?.[0];
      return row?.payload_json ? JSON.parse(row.payload_json) : null;
    } catch { return null; }
  }

  // รอบ/ที่นั่งล่าสุด — ตัวประกอบเดียวกับเส้นตอบลูกค้า (pipeline.currentRoundsRules) ตัดรอบด้วยวันนี้เวลาไทย
  // คลังความรู้ (sync จาก class-rounds.json) ยังโชว์รอบที่ผ่านไปแล้วว่า "เปิดรับสมัคร" ได้ถ้ายังไม่มีคน sync ซ้ำ
  function currentSeatRules(retrieval, nowMs) {
    if (!config.classRoundsFile) return [];
    try {
      const todayIso = bangkokIsoDate(nowMs);
      const rounds = retrieval
        ? upcomingRoundsFor(db, retrieval.brain.bundle, todayIso)
        : upcomingRounds({ file: config.classRoundsFile, db, todayIso, logger });
      // รายการรอบชุดเดียวกับเส้นตอบลูกค้า — แหล่งเดียวคือหน้าที่นั่ง (28 ก.ย.)
      return [...announcedRoundsLines(rounds), ...seatRuleLines(rounds)];
    } catch (err) {
      logger.warn?.(`yolo: อ่านรอบเรียน/ที่นั่งล่าสุดไม่สำเร็จ (${err?.message || err}) — ร่างต่อโดยไม่บอกตัวเลขที่นั่ง`);
      return [];
    }
  }

  function previousProactiveTexts(customerId) {
    try {
      const history = JSON.parse(String(db.getFollowupState(customerId)?.history_json ?? "[]"));
      return Array.isArray(history) ? history.map((item) => item?.question).filter(Boolean) : [];
    } catch { return []; }
  }

  async function draft({ customer, customerId, instruction, retrieval, extraRule = "" }) {
    const channelId = customer.channel_id || "default";
    let hasApprovedFacts = false;
    try {
      hasApprovedFacts = retrieval
        ? (retrieval.brain.bundle.guardTables.approvedPrices?.length ?? 0) > 0
        : (db.approvedPrices()?.length ?? 0) > 0;
    } catch { /* fail-closed เหมือนเส้นหลัก */ }
    const recent = db.recentTurns(customerId, 4);
    const lastUserText = [...recent].reverse().find((turn) => turn?.role === "user")?.content || "";
    let handoffNotes = [];
    try { handoffNotes = db.listHandoffNotes(customerId, 10); } catch { handoffNotes = []; }
    const nowMs = now();
    const rules = yoloRules({
      instruction, customer, scorePayload: latestScorePayload(customerId), handoffNotes,
      previousTexts: previousProactiveTexts(customerId),
      todayLabel: bangkokNowLabel(nowMs), seatRules: currentSeatRules(retrieval, nowMs),
    });
    const result = await hermes.draftReply({
      persona: scopedPersona(persona),
      // 19 ต.ค. 2026: YOLO ให้โมเดลเลือกเองตามคำสั่งพี่ง้วง — เห็นกติกาการใช้ + รายชื่อสั้น ≤3 ที่โค้ดจัดอันดับ
      // จากคำสั่ง + ข้อความล่าสุดของลูกค้า แทนทั้งคลัง · สวิตช์ review_catalog_in_prompt=on = ข้อความเดิม
      knowledge: knowledgeWithCatalogShortlist({ db,
        context: catalogShortlistContext({ db, customerId, history: db.recentTurns(customerId, config.historyTurns), note: instruction }),
        knowledge: applyKnownFactsOverride(retrieval ? retrieval.selection.knowledge : composeKnowledgeForChannel({
          db, channelId, logger,
        }), { hasApprovedFacts, trainingMockMode: config.trainingMockMode, logger }) }),
      brandPack: selectRelevantBrandPack(applyKnownFactsOverride(composeBrandPackOnly({ db, brandPack, channelId }),
        { hasApprovedFacts, trainingMockMode: config.trainingMockMode, logger }), instruction || lastUserText || "ติดตามลูกค้า", {
        recentContext: recent.map((turn) => ({ role: turn.role, content: String(turn.content || "").slice(0, 300) })),
      }),
      rules: withCampaignReceiptPolicy(extraRule ? `${rules}\n${extraRule}` : rules, config),
      history: db.recentTurns(customerId, config.historyTurns),
      userText: YOLO_USER_TEXT,
      // เส้นเชิงรุกทั้งหมดใช้โมเดล followup ตัวเดียวกัน (ไม่ตั้ง = ตามตัวหลัก)
      role: "followup",
    });
    // เงินจ่ายไปแล้วแม้ร่างจะถูกทิ้งทีหลัง — บันทึกก่อนตรวจเสมอ
    // kind "followup": ตาราง llm_usage มี CHECK ชนิดปิด (ขยายต้อง rebuild ตาราง) และ YOLO ใช้โมเดล
    // บทบาท followup อยู่แล้ว ค่าใช้จ่ายจึงรวมกับเส้นเชิงรุก — แยกดูรายครั้งได้จาก audit yolo_sent
    if (result?.usage) {
      try { db.addLlmUsage({ customerId, kind: "followup", model: result.model || "", ...usageFields(result.usage) }); } catch { /* ห้ามล้ม */ }
    }
    return result;
  }

  function inspect(text, { customerId, customer, retrieval, priorOutbound }) {
    const value = String(text || "").trim();
    if (!value) return { ok: false, code: "empty_draft" };
    if (findInstructionLeak(value)) return { ok: false, code: "instruction_leak", repair: YOLO_REPAIR_RULES.leak() };
    if (paymentInstructionsIndex(value) >= 0) return { ok: false, code: "payment_instructions", repair: YOLO_REPAIR_RULES.payment() };
    const check = guard.checkOutbound(value, {
      customerId, channelId: customer.channel_id || "",
      ...(retrieval ? { approvedPrices: retrieval.brain.bundle.guardTables.approvedPrices } : {}),
    });
    if (!check.ok) {
      const banned = check.violations.filter((v) => v.type === "banned_word").map((v) => v.detail).filter(Boolean);
      const repair = [
        banned.length ? YOLO_REPAIR_RULES.banned_word(banned.join(", ")) : "",
        check.violations.some((v) => /price/iu.test(String(v.type))) ? YOLO_REPAIR_RULES.price() : "",
      ].filter(Boolean).join("\n") || YOLO_REPAIR_RULES.other();
      return { ok: false, code: "guard_blocked", violations: check.violations.map((v) => v.type), repair };
    }
    // กันกลับคำราคาให้แพงขึ้น — ต้องให้คนยืนยันเสมอ (ไม่ร่างใหม่ให้เอง)
    if (detectUpwardPriceRevision(value, priorOutbound).raised) return { ok: false, code: "price_revision_upward" };
    return { ok: true };
  }

  // ร่าง "นอก" คิวของห้อง (ห้ามขวางเส้นตอบลูกค้า/ข้อความฉุกเฉินระหว่างรอโมเดล) แล้วค่อยเข้าคิว
  // เดียวกับเส้นตอบลูกค้าเฉพาะช่วงส่ง — ในคิวตรวจซ้ำว่าไม่มีข้อความใหม่ทั้งสองทิศตั้งแต่เริ่มร่าง
  async function composeAndSend({ customerId, instruction, actor, source, alsoEnableAi, requestId, base, warnings }) {
    const baseline = {
      inbound: safe(() => db.lastInboundAt(customerId), null),
      outbound: safe(() => db.lastOutboundAt(customerId), null),
    };
    const customer = db.getCustomer(customerId);
    const retrieval = config.brainRetrievalEnabled === true
      ? selectFollowupKnowledge({
        config, brainRuntime, db, customerId, channelId: customer.channel_id || "default", atMs: now(),
        // คำสั่งของพี่ง้วงคือ "หัวข้อ" ของข้อความนี้ — ให้สมองเลือกการ์ดตามคำสั่ง ไม่ใช่แค่ข้อความล่าสุด
        ...(instruction ? { turns: [...db.recentTurns(customerId, 6), { role: "user", content: instruction }] } : {}),
      })
      : null;
    if (retrieval && !retrieval.ok) return refused(base, "brain_not_ready", { detail: retrieval.reason, warnings });
    const claim = db.claimProactiveAttempt(customerId, YOLO_LANE, requestId, now());
    if (!claim.ok) return refused(base, "delivery_fenced", { warnings });
    const priorOutbound = db.recentTurns(customerId, config.historyTurns)
      .filter((turn) => turn?.role === "assistant").map((turn) => String(turn.content || ""));

    let result = await draft({ customer, customerId, instruction, retrieval });
    if (!result) return refused(base, "hermes_down", { warnings });
    let verdict = inspect(result.text, { customerId, customer, retrieval, priorOutbound });
    if (!verdict.ok && verdict.repair) {
      // ร่างใหม่หนึ่งครั้งพร้อมบอกเหตุ — ไม่เกินสองร่างต่อคำสั่ง (คุมค่าโมเดล)
      const retry = await draft({ customer, customerId, instruction, retrieval, extraRule: verdict.repair });
      if (retry) {
        result = retry;
        verdict = inspect(retry.text, { customerId, customer, retrieval, priorOutbound });
      }
    }
    if (!verdict.ok) {
      logger.warn?.(`yolo: ไม่ส่ง (${verdict.code}${verdict.violations ? `:${verdict.violations.join(",")}` : ""}) customer=${customerId}`);
      return refused(base, verdict.code, { violations: verdict.violations || [], warnings });
    }

    const parsed = extractImageMarkers(result.text, { catalog: catalogByKey, maxImages: config.imageMaxPerReply ?? 6, logger });
    const recentKeys = new Set(safe(() => db.recentImageKeys(customerId, now() - IMAGE_DEDUPE_WINDOW_MS), []));
    const wantsImages = ASKS_FOR_IMAGES.test(instruction);
    const images = parsed.images
      .filter((image) => !PAYMENT_IMAGE_KEY.test(image.key))
      .filter((image) => wantsImages || !recentKeys.has(image.key));
    // 2026-10-03: ด่านชื่อเดียวกับ follow-up — ชื่อเต็ม → ชื่อต้น ไม่เรียกถี่ และห้องไม่มีชื่อไม่เรียก "คุณลูกค้า"
    const addressPlan = planCustomerAddress({
      knownName: customer?.known_name || "", displayName: customer?.display_name || "",
      history: safe(() => db.recentTurns(customerId, config.historyTurns), []),
    });
    const addressedText = dropGenericAddress(enforceCustomerAddress(parsed.text, addressPlan), addressPlan);
    const degraded = degradeToDeliverable({
      policy: replyDeliveryPolicy || undefined, route: "yolo", intent: "", reason: "",
      bubbles: humanizer.humanize({ customerId, text: addressedText }), images,
    });
    const bubbles = degraded.bubbles;
    const finalImages = degraded.images;
    if (!bubbles.length && !finalImages.length) return refused(base, "empty_draft", { warnings });

    const send = () => delivery.deliver({
      customerId, bubbles, images: finalImages, baseline, retrieval, requestId, source, actor, instruction, alsoEnableAi, base, warnings,
    });
    return pipeline?.runExclusive ? pipeline.runExclusive(customerId, send) : send();
  }

  // ร่องรอยของคำสั่งที่ "ไม่ได้ส่ง" — ไม่มีข้อความลูกค้าในแถว มีแค่เหตุ + hash คำสั่ง
  function auditRefusal(result, { actor, source }) {
    if (result?.ok || result?.status === "needs_confirmation") return result;
    try {
      db.addAudit({
        operator: String(actor || "unknown"), action: "yolo_refused", target: String(result?.customer?.id || ""),
        detail: [String(source || "console"), String(result?.reason || "?"), `hash=${instructionHash(result?.instruction || "")}`]
          .join(" · ").slice(0, 200),
      });
    } catch { /* audit พังห้ามเปลี่ยนคำตอบ */ }
    return result;
  }

  async function run(options = {}) {
    return auditRefusal(await runUnaudited(options), options);
  }

  async function runUnaudited({ customerId, instruction = "", actor = "", source = "console", alsoEnableAi = false, confirm = false } = {}) {
    const id = String(customerId || "");
    const requestId = randomUUID();
    const raw = String(instruction ?? "");
    const cleaned = cleanInstruction(raw, MAX_INSTRUCTION);
    const base = { requestId, customer: customerSummary(safe(() => db.getCustomer(id), null)), instruction: cleaned };
    if (graphemes(raw.trim()).length > MAX_INSTRUCTION) return refused(base, "invalid_instruction");
    const nowMs = now();
    const facts = gatherFacts(id, nowMs);
    const verdict = evaluateYoloPreflight(facts);
    if (verdict.refusal) return refused(base, verdict.refusal, { warnings: verdict.warnings });
    if (verdict.confirm.length && confirm !== true) {
      return {
        ...base, ok: false, status: "needs_confirmation", reason: verdict.confirm[0],
        reasonText: yoloReasonText(verdict.confirm[0]),
        confirm: verdict.confirm.map((code) => ({ code, text: yoloReasonText(code) })),
        warnings: verdict.warnings,
      };
    }
    inFlight.add(id);
    try {
      // 20 ต.ค. 2026 (ขั้นที่ 3 ของแผน soul): ร่างด้วย soul รุ่นของห้องนั้น
      return await withRoomSoul(id, () => composeAndSend({
        customerId: id, instruction: cleaned, actor: String(actor || "unknown"), source: String(source || "console"),
        alsoEnableAi: alsoEnableAi === true, requestId, base, warnings: verdict.warnings,
      }));
    } catch (err) {
      logger.error?.(`yolo: ล้มเหลว (${err?.message || err}) customer=${id}`);
      return refused(base, "send_failed", { status: "failed", detail: "internal_error", warnings: verdict.warnings });
    } finally {
      inFlight.delete(id);
    }
  }

  return { preflight, run, handoff };
}
