// followupEngine.mjs — F5: Follow-up Engine v1 (push ตามนัดที่แอดมินตั้งจาก console)
//
// กติกา (SPEC G2a + แบบแผน canary.mjs):
// - scheduler: setInterval + synchronous lock (release ใน finally) — รอบก่อนไม่จบ = ข้าม
// - ทุก fetch มี AbortSignal.timeout อยู่แล้วใน hermesBridge/lineClient
// - ลำดับ guard ต่อนัด: global on? -> customer on? -> ไม่ human-owned? -> ไม่ do_not_disturb?
//   -> marketing_consent ไม่ถูกปฏิเสธ? -> ลูกค้ายังไม่ตอบหลังตั้งนัด? -> ไม่อยู่ quiet hours?
// - quiet hours 21:00-09:00 (เวลาไทย): เลื่อนไป 09:00 ถัดไป ไม่ยกเลิก
// - draft จาก Hermes ผ่าน compliance guard เต็ม — block = skipped + NEEDS_HUMAN
// - ส่งสำเร็จ = log message_class='proactive' + status sent
import { aiPausedNow } from "./aiPause.mjs";
import { reviewFollowup } from "./jevFollowupReview.mjs";
import { withCampaignReceiptPolicy } from "./campaignReceiptPolicy.mjs";
import { serviceFollowupPaused } from "./serviceBoundary.mjs";
import { scorerSuggestionsEnabled, withoutScorerSuggestions } from "./scorerSuggestions.mjs";
import { createLock } from "./locks.mjs";
import { composeBrandPackOnly, composeKnowledgeForChannel } from "./knowledgePack.mjs";
import { catalogShortlistContext, knowledgeForDraftReview, knowledgeWithCatalogShortlist } from "./reviewCatalogPrompt.mjs";
import { applyKnownFactsOverride } from "./pipeline.mjs";
import { approvedClassAmounts, outboundCarriesClassPrice } from "./priceDisclosure.mjs";
import { selectRelevantBrandPack } from "./brainPackSelector.mjs";
import { usageFields } from "./llmUsageFields.mjs";
import { selectFollowupKnowledge } from "./brain/followupKnowledge.mjs";
import { formatSystemCorrectionSource } from "./correctionCapture.mjs";
import { dropGenericAddress, enforceCustomerAddress, planCustomerAddress } from "./customerAddress.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
import { followupDecisionInstructions, parseFollowupDraftDecision } from "./followupDraftDecision.mjs";
import { scopedPersona, withRoomSoul } from "./soul/index.mjs";

export const QUIET_START_HOUR = 21; // 21:00 เวลาไทย
export const QUIET_END_HOUR = 9; // ถึง 09:00 เวลาไทย
const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DUE_BATCH_LIMIT = 10;

export function bangkokHour(tsMs) {
  return Math.floor(((tsMs + BANGKOK_OFFSET_MS) % DAY_MS) / HOUR_MS);
}

export function inQuietHours(tsMs) {
  const hour = bangkokHour(tsMs);
  return hour >= QUIET_START_HOUR || hour < QUIET_END_HOUR;
}

// 09:00 เวลาไทยที่ใกล้ที่สุดถัดไป (สำหรับเลื่อนนัดที่ตกใน quiet hours)
export function nextQuietEnd(tsMs) {
  const dayStart = Math.floor((tsMs + BANGKOK_OFFSET_MS) / DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS;
  const nineToday = dayStart + QUIET_END_HOUR * HOUR_MS;
  return tsMs < nineToday ? nineToday : nineToday + DAY_MS;
}

// สวิตช์ global 2 ชั้น: ค่า runtime ใน DB (console แก้ได้สด ๆ) ชนะ env default
// อ่าน DB พัง = fail-closed (ปิด)
export function followupGlobalEnabled({ db, config }) {
  try {
    const stored = db.getSetting("followup_enabled");
    if (stored === "1") return true;
    if (stored === "0") return false;
  } catch {
    return false;
  }
  return config.followupEnabled === true;
}

function followupRules({ note = "", scorePayload = null, lastScore = null, handoffNotes = [] }) {
  const rules = [
    "งานนี้: ร่างข้อความ follow-up ที่แอดมินทักไปหาลูกค้าเอง (ลูกค้าไม่ได้ทักมาก่อน)",
    "กติกาที่ห้ามละเมิดเด็ดขาด:",
    "- ห้ามแต่งตัวเลขราคา ส่วนลด หรือโปรโมชั่นเอง ถ้าไม่มีข้อมูลให้ชวนคุยโดยไม่พูดตัวเลข",
    "- ห้าม hard sell ห้ามกดดัน ห้ามสร้างความเร่งด่วนปลอม",
    "- สั้น 1-2 ประโยค ภาษาแชทไทยธรรมชาติ อ้างถึงเรื่องที่คุยค้างไว้",
    "- จบด้วยคำถามเปิดชวนคุยต่อ 1 คำถาม",
    followupDecisionInstructions(),
  ];
  if (note) rules.push(`- โน้ตจากแอดมินสำหรับนัดนี้: ${note}`);
  if (Number.isInteger(lastScore)) rules.push(`- คะแนนความสนใจล่าสุดของลูกค้า: ${lastScore}/10`);
  if (scorePayload?.persona_read?.disc && scorePayload.persona_read.disc !== "unknown") {
    rules.push(`- ลักษณะลูกค้า (DISC): ${scorePayload.persona_read.disc} — ${scorePayload.persona_read.reason || ""}`);
  }
  if (scorePayload?.next_move) rules.push(`- คำแนะนำจากระบบวิเคราะห์: ${scorePayload.next_move}`);
  // B6: บันทึกส่งต่อจากทีมงาน — draft prompt ทุกใบต้องเห็นบริบทเดียวกับหน้าแชท
  if (handoffNotes.length) {
    rules.push("บันทึกจากทีมงาน:");
    for (const noteRow of handoffNotes) {
      rules.push(`- [${noteRow.author || "ทีมงาน"}] ${noteRow.text}`);
    }
  }
  return rules.join("\n");
}

const DRAFT_TASK_PROMPT =
  "(ระบบ) ถึงเวลานัด follow-up ลูกค้าคนนี้แล้ว ช่วยร่างข้อความทักไปหาลูกค้า 1 ข้อความตามกติกาด้านบน";

export function createFollowupEngine({
  config,
  db,
  hermes,
  line,
  lineRegistry = null, // W3: multi-OA — ไม่ส่งมา = ใช้ line เดิม (backward compatible)
  guard,
  humanizer,
  persona = "",
  brandPack = "",
  brainRuntime = null,
  decisionReview = null,
  notifier = null,
  logger = console,
  now = Date.now,
}) {
  const lock = createLock();
  let timer = null;
  const intervalMs = config.followupIntervalMs ?? 0;

  function skip(row, detail) {
    db.setFollowupStatus(row.id, "skipped", { detail });
    return { id: row.id, status: "skipped", detail };
  }

  // อ่าน payload ของ score ล่าสุด (พัง = null — follow-up ยังร่างได้จากประวัติเปล่า ๆ)
  function latestScorePayload(customerId) {
    try {
      const row = db.latestScoreRow(customerId);
      if (!row?.payload_json) return null;
      return JSON.parse(row.payload_json);
    } catch {
      return null;
    }
  }

  // ประมวลผลนัดเดียว — caller (runDue) เช็ค global switch มาแล้ว
  async function processFollowup(row) {
    const customerId = row.customer_id;
    // Snapshot before drafting: follow-up has no current inbound event, so this
    // is the latest canonical inbound linked to the customer at draft start.
    let correctionInboundMessageId = "";
    try { correctionInboundMessageId = String(db.latestInboundMessageId?.(customerId) || ""); } catch { /* unavailable is honest */ }
    const customer = db.getCustomer(customerId);
    if (!customer) return skip(row, "no_customer");
    // ป้าย "customer" = ซื้อแล้ว บอทเงียบถาวร (v1.4.33) — ด่าน ai_enabled ด้านล่างกันได้
    // โดยอ้อมอยู่แล้ว แต่มีอย่างน้อย 4 ปุ่มในระบบที่เปิด AI กลับได้โดยไม่ดูป้าย
    // ถ้าพึ่งด่านอ้อมอย่างเดียว วันที่ใครกดปุ่มนั้น นัดเก่าที่ค้างคิวจะยิงออกทันที
    if (db.isBotSilencedByTag?.(customerId)) return skip(row, "tag_silenced");
    if (customer.followup_enabled !== 1) return skip(row, "customer_disabled");
    if (serviceFollowupPaused(customer)) return skip(row, "service_boundary");
    // human-owned = คนจริงคุมห้องอยู่ (AI ปิด หรือ state ไม่ใช่ AI_ACTIVE) — บอทห้ามทักแทรก
    if (customer.ai_enabled !== 1 || customer.state !== "AI_ACTIVE") return skip(row, "human_owned");
    if (customer.do_not_disturb === 1) return skip(row, "do_not_disturb");
    if (Number(customer.marketing_consent) < 0) return skip(row, "consent_refused");
    if ((Number(customer.operator_active_until) || 0) > now()) return skip(row, "operator_active");
    if (customer.channel_id === "facebook" && !db.withinFacebookWindow(customerId, now())) {
      return skip(row, "fb_window_closed");
    }

    // ลูกค้าทักเข้ามาหลังตั้งนัด = คุยกันต่อแล้ว ไม่ต้อง follow-up ซ้ำ
    const lastInboundAt = db.lastInboundAt(customerId);
    if (lastInboundAt && lastInboundAt > row.created_at) return skip(row, "customer_replied");
    // ด่านป้ายด้านบนอยู่ "ก่อน" เรียกโมเดลซึ่งกินเวลาได้เป็นนาที ถ้าทีมงานติดป้ายระหว่างนั้น
    // ข้อความยังหลุดออกไปได้ — เช็คซ้ำอีกครั้งตรงจุดที่ใกล้การส่งที่สุด
    if (db.isBotSilencedByTag?.(customerId)) return skip(row, "tag_silenced");

    // quiet hours: เลื่อนไป 09:00 ถัดไป (ยัง pending — ไม่ยกเลิก)
    const t = now();
    if (inQuietHours(t)) {
      const nextAt = nextQuietEnd(t);
      db.rescheduleFollowup(row.id, nextAt, "quiet_hours_deferred");
      return { id: row.id, status: "deferred", scheduledAt: nextAt };
    }

    // ร่างจากบริบท: ประวัติ + score/persona_read ล่าสุด + โน้ตแอดมิน + บันทึกส่งต่อ (B6)
    const scorePayload = latestScorePayload(customerId);
    let handoffNotes = [];
    try {
      handoffNotes = db.listHandoffNotes(customerId, 10);
    } catch {
      handoffNotes = []; // อ่านโน้ตพัง — follow-up ยังร่างได้จากบริบทที่เหลือ
    }
    // v1.3.4: เส้นนี้เคยส่ง brand pack ดิบทั้งก้อนเข้า prompt — รวม JSON ของแพ็กและสคริปต์
    // ตัวอย่าง "[ต่อ]" 28 ชุดที่เส้นตอบปกติจงใจถอดทิ้ง และ marker [IMAGE:key] ที่หลุดถึงลูกค้า
    // เป็นข้อความดิบ ต้องเดินเส้นเดียวกับการตอบปกติทุกประการ
    const followupText = String(row.note || "").trim() || "ติดตามลูกค้า";
    const retrieval = config.brainRetrievalEnabled === true
      ? selectFollowupKnowledge({
        config, brainRuntime, db, customerId, channelId: customer.channel_id || "default",
        atMs: t,
      })
      : null;
    if (retrieval && !retrieval.ok) return { id: row.id, status: "held", detail: retrieval.reason };
    const claim = db.claimProactiveAttempt(customerId, "scheduled", row.id, t);
    if (!claim.ok) return skip(row, claim.reason);
    let followupHasFacts = false;
    try {
      followupHasFacts = retrieval
        ? (retrieval.brain.bundle.guardTables.approvedPrices?.length ?? 0) > 0
        : (db.approvedPrices()?.length ?? 0) > 0;
    } catch { /* อ่านตารางพัง = fail-closed เหมือนเส้นหลัก */ }
    const recentHistory = db.recentTurns(customerId, config.historyTurns);
    const result = await hermes.draftReply({
      persona: scopedPersona(persona),
      // ความรู้ที่ทีมงานอนุมัติส่งแยก ไม่ผ่านตัวเลือกการ์ด (เหมือนเส้นตอบปกติ)
      // ตรวจปรปักษ์ 2026-08-14: เส้นนี้ไม่เคยเรียก override — ร่าง follow-up วิ่งด้วยคำสั่ง
      // "ราคาต้องรอทีมยืนยัน" ฉบับเต็มทั้งที่ knowledge ที่แนบมีราคาครบ ต้องเหมือนเส้นตอบปกติ
      // 19 ต.ค. 2026: โมเดลเป็นคนเลือกรีวิวเองในเส้นนี้ (ตามโน้ตที่ทีมอนุมัติ) — เห็นกติกาการใช้ + รายชื่อสั้น ≤3
      // ที่โค้ดจัดอันดับจากบทสนทนา แทนทั้ง 117 รายการ · สวิตช์ review_catalog_in_prompt=on = ข้อความเดิม
      knowledge: knowledgeWithCatalogShortlist({ db, context: catalogShortlistContext({ db, customerId, history: recentHistory, note: row.note }),
        knowledge: applyKnownFactsOverride(retrieval ? retrieval.selection.knowledge : composeKnowledgeForChannel({
          db, channelId: customer.channel_id || "default", logger,
        }), { hasApprovedFacts: followupHasFacts, trainingMockMode: config.trainingMockMode, logger }) }),
      brandPack: selectRelevantBrandPack(applyKnownFactsOverride(composeBrandPackOnly({
        db, brandPack, channelId: customer.channel_id || "default",
      }), { hasApprovedFacts: followupHasFacts, trainingMockMode: config.trainingMockMode, logger }), followupText, {
        recentContext: recentHistory.slice(-4).map((turn) => ({
          role: turn.role, content: String(turn.content || "").slice(0, 300),
        })),
      }),
      rules: withCampaignReceiptPolicy(followupRules({
        note: row.note,
        scorePayload: scorerSuggestionsEnabled(db) ? scorePayload : withoutScorerSuggestions(scorePayload),
        lastScore: Number.isInteger(customer.last_score) ? customer.last_score : null,
        handoffNotes,
      }), config),
      history: recentHistory,
      userText: DRAFT_TASK_PROMPT,
      role: "followup",
    });
    if (!result) return skip(row, "hermes_down");

    // B8: บันทึก token usage (ไม่มี usage = ข้ามเงียบ, พังห้ามล้มนัด)
    if (result.usage) {
      try {
        db.addLlmUsage({
          customerId, kind: "followup", model: result.model || "",
          ...usageFields(result.usage),
        });
      } catch (err) {
        logger.debug?.(`followup: บันทึก llm_usage ไม่สำเร็จ (${err?.message || err})`);
      }
    }

    const draftDecision = parseFollowupDraftDecision(result.text);
    if (draftDecision.action === "skip") {
      try {
        db.closeProactiveAttempt?.(customerId, "scheduled", row.id, now());
        db.addAudit({
          operator: "system", action: "followup_no_send", target: customerId,
          detail: `reason=${draftDecision.reason}`,
        });
      } catch (err) {
        logger.debug?.(`followup: บันทึก no-send decision ไม่สำเร็จ (${err?.message || err})`);
      }
      return skip(row, `no_send:${draftDecision.reason}`);
    }
    const draftText = draftDecision.text;

    // compliance guard เต็ม — block = skipped + NEEDS_HUMAN (draft เข้าคิว correction)
    // P2: ตัดสินด้วยตารางราคาของ "ห้องนี้" (guard resolve สมองให้เอง) ไม่ใช่ตารางกลาง
    const check = guard.checkOutbound(draftText, {
      customerId, channelId: customer?.channel_id || "",
      ...(retrieval ? { approvedPrices: retrieval.brain.bundle.guardTables.approvedPrices } : {}),
    });
    if (!check.ok) {
      const summary = check.violations.map((v) => `${v.type}:${v.detail ?? ""}`).join(", ");
      try {
        db.addCorrection({
          customerId, aiDraft: draftText, humanFinal: "",
          sourceReason: formatSystemCorrectionSource("system:followup_compliance_block", check.violations),
          inboundMessageId: correctionInboundMessageId,
        });
        db.setNeedsHuman(customerId, "followup_blocked", summary);
      } catch (err) {
        logger.error?.(`followup: บันทึก escalation ไม่สำเร็จ (${err?.message || err})`);
      }
      logger.warn?.(`followup: guard บล็อก draft (${summary}) customer=${customerId} — skipped`);
      return skip(row, `guard_blocked: ${summary}`.slice(0, 200));
    }

    // 2026-09-28 (audit ก.ย. §4.2): ชื่อเต็ม/handle → ชื่อต้น และไม่เรียกชื่อถี่ (ด่านเดียวกับเส้นตอบปกติ)
    const addressPlan = planCustomerAddress({
      knownName: customer.known_name || "", displayName: customer.display_name || "",
      history: db.recentTurns(customerId, config.historyTurns),
    });
    // 2026-10-03: ร่างจากโมเดล — ห้องที่ไม่มีชื่อเรียกได้ ตัด "คุณลูกค้า" (ด่านเดียวกับเส้นตอบปกติ)
    const bubbles = humanizer.humanize({ customerId, text: dropGenericAddress(enforceCustomerAddress(draftText, addressPlan), addressPlan) });
    if (!bubbles.length) return skip(row, "empty_after_humanize");

    // กัน race: guard ทั้งชุดด้านบนรันก่อนเรียก Hermes (นานได้ถึง 90s) — เช็คซ้ำแบบเบา ๆ
    // ก่อนยิงจริง เผื่อแอดมิน takeover หรือลูกค้าทักเข้ามาระหว่างร่าง (เจตนาเดียวกับ
    // gate.confirmBeforeSend ในเส้นทาง reactive) — เจอเงื่อนไขเปลี่ยน = ทิ้งนัด ไม่ส่ง
    const fresh = db.getCustomer(customerId);
    if (
      !fresh ||
      fresh.ai_enabled !== 1 ||
      fresh.state !== "AI_ACTIVE" ||
      fresh.do_not_disturb === 1 ||
      fresh.followup_enabled !== 1 ||
      serviceFollowupPaused(fresh) ||
      Number(fresh.marketing_consent ?? 0) < 0 ||
      (Number(fresh.operator_active_until) || 0) > now()
    ) {
      return skip(row, "superseded_before_send");
    }
    const freshInboundAt = db.lastInboundAt(customerId);
    if (freshInboundAt && freshInboundAt > row.created_at) {
      return skip(row, "superseded_before_send");
    }
    // Pause may be toggled while Hermes is drafting. Recheck at the final
    // provider boundary so no stale proactive message escapes after the UI
    // reports that the whole system is paused.
    if (aiPausedNow({ db, config })) {
      return skip(row, "ai_paused_before_send");
    }

    // v1.5: Facebook — ข้อความเชิงรุกออกได้เฉพาะในหน้าต่าง 24 ชม. (นโยบาย Meta,
    // นอกหน้าต่าง = เสี่ยงแบนทั้งเพจ) เกินแล้วยกเลิกถาวร ไม่เลื่อน: เลื่อนไปหน้าต่าง
    // ก็ยังปิดอยู่ดี และเมื่อลูกค้าทักใหม่ระบบจะตั้งนัด FU รอบใหม่ให้เองตามปกติ
    if ((fresh.channel_id || "") === "facebook" && !db.withinFacebookWindow(customerId, now())) {
      return skip(row, "fb_window_closed");
    }
    // W3: ยิงด้วย client/token ของสาขาลูกค้า + ถอด raw user id จาก customer key
    const lineCh = lineRegistry ? lineRegistry.forChannel(fresh.channel_id || "default") : line;
    const to = lineRegistry ? lineRegistry.rawUserId(customerId) : customerId;
    const stillRelevant = () => {
      const current = db.getCustomer(customerId);
      const currentInboundAt = db.lastInboundAt(customerId);
      return Boolean(
        current
        && current.ai_enabled === 1
        && current.state === "AI_ACTIVE"
        && current.do_not_disturb === 0
        && current.followup_enabled === 1
        && !serviceFollowupPaused(current)
        && Number(current.marketing_consent ?? 0) >= 0
        && (Number(current.operator_active_until) || 0) <= now()
        && (current.channel_id !== "facebook" || db.withinFacebookWindow(customerId, now()))
        && followupGlobalEnabled({ db, config })
        && !db.isBotSilencedByTag?.(customerId)
        && !(currentInboundAt && currentInboundAt > row.created_at)
        && !aiPausedNow({ db, config })
      );
    };
    if (!stillRelevant()) return skip(row, "superseded_before_send");
    if (!await reviewFollowup({ reviewer: decisionReview, db, customerId, turnId: correctionInboundMessageId,
      notifier, threshold10: config.jevReviewThreshold,
      blockPaymentInstructions: config.salesDecisionGuardEnabled === true,
      draftText: bubbles.map(b => b.text).join("\n"),
      // 19 ต.ค. 2026: ด่านตรวจเห็นเฉพาะรายการคลังที่อยู่ในร่างนี้จริง
      knowledge: knowledgeForDraftReview({ db, draftText: bubbles.map(b => b.text).join("\n"),
        knowledge: retrieval?.selection?.knowledge || composeKnowledgeForChannel({ db, channelId: fresh.channel_id || "default", logger }) }),
      isCurrent: stillRelevant })) return skip(row, "jev_review_required");
    if (!stillRelevant()) return skip(row, "superseded_after_jev");
    if (!db.fenceProactiveSend(customerId, "scheduled", row.id, now())) return skip(row, "delivery_fenced");
    const sendResult = await lineCh.sendBubbles({ to, replyToken: "", bubbles, images: [], stillRelevant, purpose: SEND_PURPOSE.followup });
    db.settleProactiveSend(customerId, "scheduled", row.id, now());
    const delivered = sendResult.delivered ?? (sendResult.ok ? bubbles : []);
    if (!delivered.length) {
      return skip(row, sendResult.stoppedEarly
        ? "superseded_before_send"
        : `send_failed:${sendResult.status ?? sendResult.reason ?? "?"}`);
    }

    for (const bubble of delivered) {
      db.insertMessage({
        customerId,
        direction: "out",
        msgType: "text",
        content: bubble.text,
        messageClass: "proactive", // follow-up = ข้อความที่เราเริ่มเอง
        agentMode: "ai", // B7d
        ...(retrieval ? {
          brainVersionId: retrieval.brain.versionId,
          metadata: { brainRetrieval: retrieval.selection.trace },
        } : {}),
      });
    }
    // ---- จังหวะราคา: ข้อความเชิงรุกก็คือ "ราคาถึงมือลูกค้า" เหมือนกัน ----
    //
    // ตรวจปรปักษ์ 2026-09-04 (รอบที่ห้า): หมุด price_quoted_at เคยมีผู้เขียนอยู่ที่เดียว
    // คือเส้น reactive ทั้งที่เส้นนี้ร่างด้วยความรู้ที่มีตารางราคาครบ (applyKnownFactsOverride
    // ด้านบน) และผ่าน compliance guard ชุดเดียวกัน — ห้องที่ได้ราคาไปทาง follow-up จึงยัง
    // "ติดค้างราคา" ในสายตาระบบตลอดไป แล้วเทิร์นถัดไปของเส้นตอบปกติจะสั่ง "คำตอบนี้ต้องมี
    // ราคาอยู่ด้วยเสมอ" ซ้ำอีก ทั้งที่ลูกค้าเพิ่งได้ตัวเลขไปเมื่อกี้
    //
    // เมื่อเปิด retrieval ต้องใช้ราคาจากสมองรุ่นเดียวกับ draft/guard ไม่ใช่ตารางสดที่อาจเปลี่ยนกลางเทิร์น
    // เขียนหลัง provider ตอบว่าส่งสำเร็จเท่านั้น และ UPDATE เป็น "เขียนครั้งแรกชนะ" จึงเรียกซ้ำได้
    try {
      const amounts = approvedClassAmounts(retrieval
        ? retrieval.brain.bundle.guardTables.approvedPrices
        : db.approvedPrices() ?? []);
      const deliveredText = delivered.map((bubble) => bubble.text || "").join("\n");
      if (outboundCarriesClassPrice(deliveredText, amounts)) db.markPriceQuoted?.(customerId);
    } catch (err) {
      logger.debug?.(`followup: ปักหมุดจังหวะราคาไม่สำเร็จ (${err?.message || err}) — ไม่มีผลกับนัดนี้`);
    }
    const partial = !sendResult.ok || sendResult.stoppedEarly === true;
    db.setFollowupStatus(row.id, "sent", {
      detail: partial ? `partial_delivery:${delivered.length}/${bubbles.length}` : "",
    });
    return { id: row.id, status: "sent", bubbles: delivered.length, partial };
  }

  async function runDue() {
    // lock แบบ synchronous — รอบก่อนยังไม่จบ = ข้ามรอบนี้ (แบบเดียวกับ canary)
    if (!lock.tryAcquire()) {
      return { skipped: true, reason: "run_in_flight" };
    }
    try {
      if (!followupGlobalEnabled({ db, config })) {
        return { skipped: true, reason: "followup_disabled" };
      }
      // v1.4.47: AI paused ทั้งระบบ = ห้ามทักใครก่อน
      if (aiPausedNow({ db, config })) {
        return { skipped: true, reason: "ai_paused" };
      }
      const due = db.dueFollowups(now(), DUE_BATCH_LIMIT);
      const results = [];
      for (const row of due) {
        try {
          // 20 ต.ค. 2026 (ขั้นที่ 3 ของแผน soul): เขียนด้วย soul รุ่นของห้องนั้น
          results.push(await withRoomSoul(row.customer_id, () => processFollowup(row)));
        } catch (err) {
          // นัดเดียวพังห้ามล้มทั้งรอบ — ปิดนัดนั้นเป็น skipped แล้วไปต่อ
          logger.error?.(`followup: ประมวลผลนัด ${row.id} พัง (${err?.message || err})`);
          try {
            db.setFollowupStatus(row.id, "skipped", { detail: String(err?.message || err).slice(0, 200) });
          } catch {
            /* DB พังจริง — log ไว้แล้วพอ */
          }
          results.push({ id: row.id, status: "skipped", error: true });
        }
      }
      return { processed: results.length, results };
    } finally {
      lock.release(); // ปล่อย lock เสมอ ไม่ว่าจะจบทางไหน
    }
  }

  // arm interval เฉพาะเมื่อ intervalMs > 0 — สวิตช์ global เช็คสดทุกรอบใน runDue
  // (ให้ toggle runtime จาก console มีผลทันทีโดยไม่ต้อง restart)
  function start() {
    if (timer || intervalMs <= 0) return false;
    timer = setInterval(() => {
      runDue().catch((err) => logger.error?.(`followup: ${err?.message || err}`));
    }, intervalMs);
    timer.unref?.(); // ไม่ค้ำ process ตอน shutdown
    logger.log?.(`[followup] scheduler เดินทุก ${intervalMs}ms (global switch เช็คสดทุกรอบ)`);
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    runDue,
    processFollowup,
    start,
    stop,
    get busy() { return lock.held; },
    get running() { return timer !== null; },
  };
}
