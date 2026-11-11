// consoleTeachApi.mjs — เส้นทาง /console/api/teach/* ของเฟส 3 (ฝั่งที่คนแตะ)
//
// สามหน้าที่ ไม่มีข้อที่สี่:
//   1. GET  /teach/review     กล่องตรวจ — ของที่รอคนตัดสิน จากห้าแหล่ง รวมเป็นรายการเดียว
//   2. GET  /teach/session    จอสอน — ข้อมูลตั้งต้นของการสอนหนึ่งครั้ง (อ่านอย่างเดียว)
//      POST /teach/plan       คิดข้อเสนอใหม่หลังคนแก้ข้อความ/ชิป (deterministic ไม่เรียกโมเดล)
//   3. GET  /teach/why        Step 0 "ทำไมลูกแพรตอบแบบนี้" — เฉพาะสิ่งที่ระบบรู้จริง
//
// ไฟล์นี้ **ไม่มีทางเขียนสมองของตัวเอง** โดยเจตนา: การกดส่งของจอสอนยิงเข้าเส้นเดิม
// (POST /knowledge, POST /prices) ซึ่งเดินผ่าน brainWriteHook อยู่แล้ว — ถ้าเฟสนี้เพิ่ม
// ทางเขียนที่สอง วันหนึ่งด่านจะถูกข้ามโดยไม่มีใครรู้ว่าข้ามตั้งแต่เมื่อไร
import { hasOperatorCapability } from "./operatorRoles.mjs";
import {
  collectReviewRows, pendingTeachRefs, liveManifestRevIds, snippet,
} from "./brain/reviewSources.mjs";
import {
  TEACH_REASON_CHIPS, classifyTeachProposal, relatedKnowledge,
  sanitizeTeachContext, teachPrivacyRefusal, TEACH_CORRECT_TEXT_MAX, RELATED_WEAK_SCORE,
} from "./brain/teach.mjs";
import { compileBrain } from "./brain/compile.mjs";
import { runBrainLints } from "./brain/lint.mjs";
import { liveLintAllowlist } from "./brain/lintAllowlist.mjs";
import { todayInBangkok } from "./brain/import.mjs";
import { knowledgeExpectedHash, knowledgeMetadataFromRow } from "./brain/knowledgeMetadata.mjs";
import { catalogOutOfPrompt, KNOWLEDGE_MAX_CHARS, REVIEW_CATALOG_MAX_CHARS } from "./knowledgePack.mjs";
import { isRecognizedSystemCorrectionSource, isTeachableCorrection } from "./correctionCapture.mjs";
import { lessonsForWhyPanel } from "./consoleLessonsApi.mjs";

const QUIET = Object.freeze({ warn() {}, debug() {}, log() {}, error() {} });
export const TEACH_READ_CAPABILITY = "corrections.review";
const REVIEW_LIMIT = 60;

// ป้ายสถานะเดียวสำหรับจอสอนและคลังความรู้: metadata เป็นเพียงข้อมูลกำกับ
// ไม่ใช่คำสัญญาว่าคำตอบเก่าหรือ runtime legacy จะใช้การค้นคืนแล้ว.
export function knowledgeMetadataStatus({ config = {}, db = {} } = {}) {
  const enabled = config.brainRetrievalEnabled === true;
  const versioned = config.knowledgeVersioned === true;
  const versionedRead = config.brainRead === "versioned";
  const live = typeof db.getBrainPointer === "function" ? safe(() => db.getBrainPointer("live"), null) : null;
  const liveReady = Boolean(live?.version_id);
  const ready = enabled && versioned && versionedRead && liveReady;
  let message = "ยังไม่เปิดใช้การเลือกความรู้ตามเรื่อง";
  if (enabled && versioned && versionedRead && !liveReady) message = "รอสมองรุ่นที่ใช้งานจริงก่อน จึงจะเลือกความรู้ตามเรื่องได้";
  else if (enabled && versioned && versionedRead) message = "เปิดฟอร์มกำกับความรู้ได้ — การตอบจริงตรวจจากข้อมูลของแต่ละข้อความ";
  // metadata adds a retrieval path, but does not relax the existing corpus ceiling
  // while legacy/versioned compatibility is still guarded by parity.
  // 19 ต.ค. 2026: คลังรีวิวมีงบแยก (สวิตช์ review_catalog_in_prompt ≠ on) — บอกทีมว่าเพดานนี้ไม่นับคลังรีวิว
  const status = { enabled, ready, message, corpusCapChars: KNOWLEDGE_MAX_CHARS };
  if (safe(() => catalogOutOfPrompt(db), false)) status.reviewCatalogCapChars = REVIEW_CATALOG_MAX_CHARS;
  return status;
}

/**
 * @param {{db: object, config: object, logger?: object, denyMessage?: string}} deps
 */
export function createTeachRoutes({ db, config = {}, logger = console, notifier = null, denyMessage = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้" }) {
  const enabled = config.teachEnabled === true;

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "teach") return false;
    const { json, operator, requireCsrf } = ctx;
    // แฟล็กปิด = เส้นนี้ต้องเหมือนไม่มีอยู่จริง (404) ไม่ใช่ 403 ซึ่งแปลว่า "มีอยู่แต่คุณห้ามดู"
    if (!enabled) {
      json(res, 404, { ok: false, error: "ไม่พบเส้นทางนี้" });
      return true;
    }
    if (!hasOperatorCapability(operator, TEACH_READ_CAPABILITY)) {
      json(res, 403, { ok: false, error: denyMessage });
      return true;
    }
    const canPublishKnowledge = hasOperatorCapability(operator, "knowledge.publish");
    const canPublishPrices = hasOperatorCapability(operator, "prices.manage");
    const knowledgeMetadata = knowledgeMetadataStatus({ config, db });

    /* ---- GET /teach/review — กล่องตรวจ ---- */
    if (req.method === "GET" && route[1] === "review" && route.length === 2) {
      const findings = safe(() => liveLintFindings(db), []);
      const cursor = Number(url.searchParams.get("cursor")) || 0;
      const page = safe(() => collectReviewRows(db, {
        pendingRefs: pendingTeachRefs(db),
        liveFindings: findings,
        liveRevIds: liveManifestRevIds(db),
        limit: REVIEW_LIMIT,
        cursor,
      }), { rows: [], total: 0, counts: {}, hasMore: false, cursor: 0 });
      json(res, 200, {
        ok: true,
        rows: page.rows,
        // จำนวนจริงทั้งหมด ไม่ใช่จำนวนที่หน้านี้แสดง — ตัวนับที่นับจากชุดที่ถูกตัดแล้ว
        // ทำให้คนเชื่อว่าเคลียร์หมดแล้วทั้งที่ยังเหลืออีกครึ่ง
        total: page.total, counts: page.counts ?? {}, hasMore: page.hasMore, cursor: page.cursor,
        // ปุ่มที่กดแล้วเด้ง 403 คือปุ่มที่สอนคนให้ไม่เชื่อหน้าจอ — หน้าเว็บซ่อนตามค่านี้
        // (ด่านจริงยังอยู่ที่ handler ของเส้นเขียนเหมือนเดิม ที่นี่ไม่ใช่ด่าน)
        canPublish: { knowledge: canPublishKnowledge, prices: canPublishPrices },
        // ทีมงานที่ไม่มีสิทธิ์เผยแพร่ ยังสอนได้ — ของจะไปเข้าคิวขออนุมัติเหมือนเส้นอื่น
        queueInstead: !canPublishKnowledge,
        knowledgeMetadata,
      });
      return true;
    }

    /* ---- GET /teach/session — ข้อมูลตั้งต้นของการสอนหนึ่งครั้ง ---- */
    if (req.method === "GET" && route[1] === "session" && route.length === 2) {
      const source = String(url.searchParams.get("source") || "");
      const ref = String(url.searchParams.get("ref") || "");
      const session = buildSession(db, { source, ref });
      if (!session.ok) {
        json(res, session.status ?? 404, { ok: false, error: session.error });
        return true;
      }
      json(res, 200, {
        ok: true,
        chips: TEACH_REASON_CHIPS,
        ...session.payload,
        canPublish: { knowledge: canPublishKnowledge, prices: canPublishPrices },
        knowledgeMetadata,
      });
      return true;
    }

    /* ---- POST /teach/correction-final — save a human edit, never teach/publish ---- */
    if (req.method === "POST" && route[1] === "correction-final" && route.length === 2) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const body = await ctx.readJson(req).catch(() => ({}));
      const source = String(body?.source || "");
      const ref = String(body?.ref || "");
      const humanFinal = String(body?.humanFinal || "").trim();
      if (source !== "correction" && source !== "guard_block") {
        json(res, 400, { ok: false, error: "แหล่งนี้บันทึกคำแก้ไม่ได้" });
        return true;
      }
      if (!humanFinal || humanFinal.length > TEACH_CORRECT_TEXT_MAX) {
        json(res, 400, { ok: false, error: "กรอกคำตอบที่แก้จากร่างจริง (ไม่เกิน 2000 ตัวอักษร) ก่อนบันทึก" });
        return true;
      }
      const row = safe(() => db.getCorrection(ref), null);
      if (!row || String(row.status || "candidate") !== "candidate") {
        json(res, 409, { ok: false, error: "รายการนี้ถูกตัดสินไปแล้วหรือไม่พบรายการ" });
        return true;
      }
      if (String(row.taught_version_id || "")) {
        json(res, 409, { ok: false, error: "รายการนี้ถูกสอนไปแล้ว — เปิดหน้าคลังความรู้เพื่อแก้ของที่สอนไว้แทนนะคะ" });
        return true;
      }
      if (!isTeachableCorrection(row.ai_draft, humanFinal)) {
        json(res, 409, { ok: false, error: "คำแก้ต้องต่างจากร่างที่ลูกแพรตอบจริง จึงจะบันทึกเป็นบทเรียนได้" });
        return true;
      }
      if (!safe(() => db.setCorrectionFinal(ref, humanFinal), false)) {
        json(res, 409, { ok: false, error: "บันทึกคำแก้ไม่สำเร็จ เพราะรายการเปลี่ยนสถานะแล้ว" });
        return true;
      }
      safe(() => db.addAudit({
        operator: ctx.username, action: "correction_human_final_saved", target: ref, detail: "saved_for_teach",
      }), null);
      const session = buildSession(db, { source, ref });
      if (!session.ok) {
        json(res, session.status ?? 409, { ok: false, error: session.error });
        return true;
      }
      json(res, 200, { ok: true, ...session.payload });
      return true;
    }

    /* ---- POST /teach/plan — คิดใหม่หลังคนแก้ (อ่านอย่างเดียว ไม่เขียนอะไรเลย) ---- */
    if (req.method === "POST" && route[1] === "plan" && route.length === 2) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const body = await ctx.readJson(req).catch(() => ({}));
      const correctText = String(body?.correctText || "").slice(0, TEACH_CORRECT_TEXT_MAX);
      const title = String(body?.title || "").slice(0, 200);
      const proposal = classifyTeachProposal({ chips: body?.chips, correctText, title });
      const related = relatedWithMetadata(db, `${title}\n${correctText}`);
      json(res, 200, { ok: true, proposal, related, searchIsWeak: isWeakSearch(related), knowledgeMetadata });
      return true;
    }

    /* ---- POST /teach/report — แจ้งช่างสำหรับเรื่องที่คอนโซลทำแทนไม่ได้ ---- */
    if (req.method === "POST" && route[1] === "report" && route.length === 2) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const body = await ctx.readJson(req).catch(() => ({}));
      const rowId = String(body?.rowId || "").slice(0, 200);
      const note = String(body?.note || "").replace(/\s+/gu, " ").trim().slice(0, 300);
      try {
        db.addAudit({
          operator: ctx.username, action: "teach_engineer_report", target: rowId,
          detail: note || "ต้องให้ช่างจัดการ",
        });
      } catch (err) {
        logger.debug?.(`teach: บันทึกการแจ้งช่างไม่สำเร็จ (${err?.message || err})`);
      }
      try {
        notifier?.fireLater({
          customerId: "ops:teach", channelId: "default", reason: "teach_engineer_report", force: true,
          reasonTextOverride: `${ctx.username} แจ้งช่างจากกล่องตรวจ: ${note || rowId}`,
        });
      } catch (err) {
        logger.debug?.(`teach: ปลุกทีมไม่สำเร็จ (${err?.message || err})`);
      }
      json(res, 200, { ok: true, reported: true });
      return true;
    }

    /* ---- GET /teach/why — Step 0 ---- */
    if (req.method === "GET" && route[1] === "why" && route.length === 2) {
      const messageId = String(url.searchParams.get("messageId") || "");
      const row = messageId ? safe(() => db.messageBrainContext(messageId), null) : null;
      if (!row) {
        json(res, 404, { ok: false, error: "ไม่พบข้อความนี้" });
        return true;
      }
      // 2026-09-28: แนบส่วน "บทเรียน" (ใช้บทเรียนอะไรบ้าง + กล่องสอน) — ดู consoleLessonsApi.mjs
      json(res, 200, {
        ok: true, why: explainReply(db, row, { config, logger }),
        lessons: lessonsForWhyPanel(db, row, { operator }),
      });
      return true;
    }

    return false;
  }

  return { handle, enabled };
}

/* ------------------------------- ข้อมูลของจอสอน ------------------------------- */

function buildSession(db, { source, ref }) {
  // เปิดจากห้องแชท (Step 0 -> "สอนลูกแพรจากข้อความนี้") — ตั้งต้นจากข้อความของบอทเอง
  if (source === "message") return messageSession(db, ref);
  if (source !== "correction" && source !== "guard_block") {
    return { ok: false, status: 400, error: "แหล่งนี้ยังเปิดจอสอนไม่ได้ในเฟสนี้" };
  }
  const row = safe(() => db.getCorrection(ref), null);
  if (!row) return { ok: false, status: 404, error: "ไม่พบคำแก้นี้ (อาจถูกตัดสินหรือถูกลบไปแล้ว)" };
  // สองคนเปิดแถวเดียวกันจากมือถือคนละเครื่อง คนหนึ่งปัดตกไปแล้ว — อีกคนต้องรู้ ไม่ใช่สอนต่อเงียบ ๆ
  if (String(row.status || "candidate") !== "candidate") {
    return {
      ok: false, status: 409,
      error: `เรื่องนี้ถูกตัดสินไปแล้วโดย ${row.decided_by || "ทีมงาน"}`
        + `${row.decided_at ? ` เมื่อ ${new Date(Number(row.decided_at)).toLocaleString("th-TH")}` : ""}`
        + " — กลับไปดูกล่องตรวจเพื่อเอารายการล่าสุดนะคะ",
    };
  }
  if (String(row.taught_version_id || "")) {
    return {
      ok: false, status: 409,
      error: "เรื่องนี้ถูกสอนไปแล้ว — เปิดหน้าคลังความรู้เพื่อแก้ของที่สอนไว้แทนนะคะ",
    };
  }
  const draft = String(row.ai_draft || "");
  const correctText = String(row.human_final || "");
  if (source === "correction" && correctText && !isTeachableCorrection(draft, correctText)) {
    return {
      ok: false, status: 409,
      error: "รายการนี้ไม่มีการแก้เนื้อความ จึงไม่ใช่บทเรียนและยังไม่ได้สอนให้สมองจำ",
    };
  }
  // Legacy guard rows were price-only. New system provenance distinguishes
  // non-price guards, so do not prelabel a banned-word/diagnosis draft as a
  // money lesson before a person has written the correction.
  const chips = source === "guard_block" && guardBlockStartsAsPrice(row) ? ["wrong_price"] : [];
  const teachingBlocked = !isTeachableCorrection(draft, correctText);
  const proposal = classifyTeachProposal({ chips, correctText });
  const related = relatedWithMetadata(db, `${correctText}\n${draft}`);
  const inboundSource = correctionInboundSource(db, row);
  const provenance = correctionProvenance(row);
  return {
    ok: true,
    payload: {
      // ตารางราคาปัจจุบัน — จอสอนต้องให้เลือก "แก้ของเดิม" ได้ ไม่ใช่เพิ่มได้อย่างเดียว
      // (เพิ่มอย่างเดียว = ชื่อเดิมตัน 409 และชื่อคล้ายกันได้ราคาสองแถวในตารางของตัวกรอง)
      prices: safe(() => db.approvedPrices(), []),
      searchIsWeak: isWeakSearch(related),
      source,
      ref: String(row.id),
      // Source is exposed only through the DB's correction-scoped accessor:
      // same-customer inbound, never a caller-selected message id.
      aiDraft: snippet(draft),
      // Corrections are review artifacts. A human final does not prove this
      // draft reached the customer, so never relabel it as a delivered reply.
      draftLabel: "ร่างของลูกแพร:",
      correctText,
      inboundSource,
      provenance,
      humanDecisionReason: String(row.decided_by || "") && String(row.reason || "")
        ? String(row.reason).trim()
        : "",
      teachingBlocked,
      teachingBlockedReason: teachingBlocked
        ? "บันทึกคำแก้ของคนที่ต่างจากร่างเดิมก่อน จึงจะสอนลูกแพรจากรายการนี้ได้"
        : "",
      selectedChips: chips,
      proposal,
      related,
      customerId: String(row.customer_id || ""),
      at: Number(row.created_at) || 0,
      decidedAt: row.decided_at ? Number(row.decided_at) : null,
      status: String(row.status || ""),
    },
  };
}

function correctionProvenance(row) {
  const source = String(row?.source_reason || "");
  if (!isRecognizedSystemCorrectionSource(source)) return { recorded: false, label: "ที่มาร่างของระบบ: ไม่ได้บันทึก" };
  if (source === "system:price_revision_upward") return { recorded: true, label: "ที่มาร่างของระบบ: กันการปรับราคาสูงกว่าที่เคยแจ้ง" };
  if (source === "system:ai_paused_draft") return { recorded: true, label: "ที่มาร่างของระบบ: เก็บไว้เพราะ AI ถูกพัก" };
  const [, path = "", suffix = ""] = /^system:([^:]+)(?::(.*))?$/u.exec(source) || [];
  const origin = path === "followup_compliance_block"
    ? "ด่านตรวจข้อความติดตาม"
    : path === "staged_followup_compliance_block"
      ? "ด่านตรวจข้อความติดตามตามช่วง"
      : "ด่านตรวจคำตอบ";
  const typeLabels = {
    price: "ราคา", price_binding: "การผูกราคา", banned_word: "คำต้องห้าม", diagnosis: "การวินิจฉัย",
  };
  const types = suffix.split(",").map((type) => typeLabels[type]).filter(Boolean);
  return { recorded: true, label: `ที่มาร่างของระบบ: ${origin}${types.length ? ` (${types.join(" · ")})` : ""}` };
}

function guardBlockStartsAsPrice(row) {
  const sourceReason = String(row?.source_reason || "");
  if (!sourceReason) return true; // legacy price-only captures
  return sourceReason === "system:price_revision_upward"
    || /:(?:[a-z_]+,)*price(?:,|$)/u.test(sourceReason);
}

function correctionInboundSource(db, correction) {
  const customerId = String(correction?.customer_id || "");
  const correctionId = String(correction?.id || "");
  if (!customerId || !correctionId || typeof db.getCorrectionInboundMessage !== "function") {
    return { available: false };
  }
  const message = safe(() => db.getCorrectionInboundMessage({ customerId, correctionId }), null);
  if (!message || String(message.customer_id || "") !== customerId || String(message.direction || "") !== "in") {
    return { available: false };
  }
  const kind = String(message.msg_type || "unknown");
  return {
    available: true,
    messageId: String(message.id || ""),
    kind,
    // A text message is shown verbatim in this authorized operator view.  For
    // image/audio, preserve the factual kind and room link without inventing a
    // transcription or visual description.
    text: kind === "text" ? String(message.content || "") : "",
  };
}

// จอสอนที่เปิดจากห้องแชท: ตั้งต้นจาก "คำตอบของลูกแพร" ที่ยังไม่มีใครแก้
//
// ด่านที่ห้ามหาย: เปิดได้เฉพาะข้อความ **ขาออก** เท่านั้น ข้อความขาเข้าเป็นคำพูดของลูกค้า
// การดึงมันเข้าจอสอนคือการเปิดทางให้ข้อความลูกค้าไหลลง teach_json ทางอ้อม (PDPA)
function messageSession(db, ref) {
  const row = safe(() => db.messageBrainContext(ref), null);
  if (!row) return { ok: false, status: 404, error: "ไม่พบข้อความนี้" };
  if (String(row.direction) !== "out") {
    return { ok: false, status: 400, error: "สอนจากข้อความของลูกค้าไม่ได้ — เปิดจากคำตอบของลูกแพรแทน" };
  }
  const draft = String(row.content || "");
  const proposal = classifyTeachProposal({ chips: [], correctText: "" });
  const messageRelated = relatedWithMetadata(db, draft);
  return {
    ok: true,
    payload: {
      source: "message", ref: String(row.id),
      aiDraft: snippet(draft),
      // ช่องคำตอบเริ่มว่างโดยเจตนา: คนสอนต้องเขียนสิ่งที่ "ควรตอบ" ไม่ใช่แก้คำเดิมทีละคำ
      correctText: "",
      selectedChips: [], proposal,
      prices: safe(() => db.approvedPrices(), []),
      related: messageRelated,
      searchIsWeak: isWeakSearch(messageRelated),
      customerId: String(row.customer_id || ""),
      at: Number(row.created_at) || 0,
      decidedAt: null, status: "",
    },
  };
}

/* ---------------------------- Step 0: ความซื่อสัตย์ ---------------------------- */

// 2026-09-05 (พี่ง้วงอ่านแล้วเข้าใจว่า "อ่านไม่ได้"): ป้ายต้องบอกด้วยว่านี่คือโหมดปกติของทุกห้องตอนนี้
// ไม่ใช่ข้อผิดพลาด — ความซื่อสัตย์ยังอยู่ครบ (ยังบอกว่าอ่านจากตารางเดิม ไม่แต่งเลขรุ่น)
export const READ_FROM_LEGACY_TABLES = "อ่านจากตารางเดิม (โหมดปกติตอนนี้)";

/**
 * "ทำไมลูกแพรตอบแบบนี้" — แสดงเฉพาะสิ่งที่ระบบรู้จริง (แบบแปลน §6 Step 0)
 *
 * กติกาข้อเดียวที่ห้ามพลาด: ห้ามบอกเป็นนัยว่าสมองเสิร์ฟเทิร์นนี้ ถ้ามันไม่ได้เสิร์ฟ
 * `brain_version_id` บนแถวข้อความคือหลักฐานเดียวที่มี — ว่างเมื่อไร คำตอบคือ
 * "อ่านจากตารางเดิม" ไม่ใช่การเดารุ่นจาก pointer ปัจจุบัน (ซึ่งอาจเปลี่ยนไปแล้วหลายรอบ)
 */
export function explainReply(db, row, { config = {}, logger = console } = {}) {
  const versioned = config.brainRead === "versioned";
  const versionId = String(row?.brain_version_id || "");
  const version = versionId ? safe(() => db.getBrainVersion(versionId), null) : null;
  const base = {
    messageId: String(row?.id || ""),
    at: Number(row?.created_at) || 0,
    // เส้นทางที่ "บันทึกไว้จริง" เท่านั้น — ไม่มี route_inputs ในเฟสนี้ จึงไม่แต่งขึ้นมา
    route: {
      answeredBy: row?.operator ? "คน" : "AI",
      operator: String(row?.operator || ""),
      agentMode: String(row?.agent_mode || ""),
      messageClass: String(row?.message_class || ""),
    },
    // สิ่งที่ระบบ "ไม่รู้" ต้องเขียนไว้บนหน้าเดียวกัน ไม่ใช่ปล่อยให้คนเดาว่ารู้
    unknown: [
      // ถ้อยคำต้องอ่านออกว่าเป็น "ข้อจำกัดของโหมด" ไม่ใช่ความผิดพลาดของเทิร์นนี้ (เจ้าของเคยอ่านผิด 2026-09-05)
      "โหมดนี้ส่งความรู้ทั้งชุดให้ลูกแพรพร้อมกัน จึงยังชี้ไม่ได้ว่าคำตอบมาจากการ์ดใบไหน (ระบบไม่รู้ว่าโมเดลหยิบการ์ดใบไหนไปใช้ — จะชี้ได้เมื่อเปิดอ่านจากรุ่นสมอง)",
      "ยังไม่ได้เปิดบันทึกร่องรอยว่าด่านกรองตัดอะไรออกในเทิร์นนี้ — เป็นของเฟสถัดไป ไม่ใช่ความผิดพลาด",
    ],
  };
  if (!version) {
    return {
      ...base,
      brain: {
        known: false,
        label: READ_FROM_LEGACY_TABLES,
        // เหตุผลต้องต่างกันจริง ๆ ระหว่าง "ยังไม่เปิดทางอ่านสมอง" กับ "เปิดแล้วแต่เทิร์นนี้ไม่ได้ใช้"
        why: versioned
          ? "เทิร์นนี้ไม่ได้ผูกกับรุ่นสมองใด (ตอบก่อนเปิดทางอ่านสมอง หรือเป็นคำตอบสำเร็จรูป/คนตอบเอง) — ไม่ใช่ข้อผิดพลาด"
          : "ปกติค่ะ — ตอนนี้ระบบยังอ่านคลังความรู้และตารางราคาโดยตรง ซึ่งเป็นโหมดที่ใช้อยู่ทุกห้อง ส่วน \"รุ่นสมอง\" ยังเป็นเงาตามแผน จะเปิดให้อ่านจริงเมื่อผ่านด่านตรงกันติดกันครบ",
        sources: [],
      },
    };
  }
  const counts = safeJson(version.manifest_json)?.counts ?? {};
  return {
    ...base,
    brain: {
      known: true,
      label: `รุ่นสมอง ${version.seq}`,
      versionId: version.version_id,
      seq: version.seq,
      versionLabel: String(version.label || ""),
      publishedAt: version.published_at ? Number(version.published_at) : null,
      why: "เทิร์นนี้ถูกตอบด้วยรุ่นสมองใบนี้ (บันทึกไว้ตอนตอบ ไม่ใช่เดาจากรุ่นที่ใช้อยู่ตอนนี้)",
      sources: Object.entries(counts)
        .filter(([, n]) => Number(n) > 0)
        .map(([kind, n]) => ({ kind, count: Number(n) })),
    },
  };
}

/* ----------------------- teach context ที่เส้นเขียนเอาไปใช้ ----------------------- */

/**
 * แปลงสิ่งที่หน้าเว็บส่งมาให้เป็น teach context ที่ปลอดภัยพอจะลง teach_json
 *
 * สองอย่างที่ทำที่นี่และห้ามทำที่อื่น:
 *   1. `customer_hash` คำนวณจากแถวคำแก้ฝั่งเซิร์ฟเวอร์เสมอ — ค่าที่หน้าเว็บส่งมาถูกทิ้ง
 *      (รับมาแล้วไม่มีทางแยกออกว่าเป็น hash จริงหรือ id ดิบที่ถูกส่งมาตรง ๆ)
 *   2. แฟล็กปิด = ไม่มี teach context เลย ไม่ใช่ context เปล่า ๆ — teach_json ของเส้นเขียน
 *      เดิมต้องมีรูปเหมือนก่อนมีเฟสนี้ทุกไบต์
 */
export function resolveTeachContext(db, raw, { teachEnabled = false, cardText = "" } = {}) {
  if (!teachEnabled || !raw || typeof raw !== "object") return null;
  // ทิ้ง customer_hash ที่หน้าเว็บส่งมาก่อนกรอง แล้วค่อยเติมของที่คำนวณเองทีหลัง —
  // ถ้าไม่ทิ้งก่อน คนที่ยิง API ตรง ๆ จะแนบ id ดิบมาในช่องนี้ได้
  const teach = sanitizeTeachContext(stripClientHash(raw));
  const owner = teach.correction_ref
    ? safe(() => db.getCorrection(teach.correction_ref), null)
    : (teach.message_ref ? safe(() => db.messageBrainContext(teach.message_ref), null) : null);
  // ห้ามให้ API ตรงข้ามด่านคิว: ถ้าเจ้าของอ้างคำแก้ที่ข้อความลูกค้าเห็นจริง
  // เหมือนเดิม ก็ไม่ใช่หลักฐานให้สอน แม้ caller จะพยายามแนบ correct_text ใหม่มาเอง
  if (teach.correction_ref) {
    if (!owner || !isTeachableCorrection(owner.ai_draft, owner.human_final)) {
      return { error: "รายการคำแก้นี้ยังไม่มีคำแก้เนื้อความที่ยืนยันแล้ว จึงใช้สอนสมองไม่ได้" };
    }
  }
  // ด่านความเป็นส่วนตัวอยู่ตรงนี้ ไม่ใช่ที่หน้าจอ: /teach/plan เป็นคำแนะนำ คนกดข้ามได้
  const refusal = teachPrivacyRefusal({
    correctText: teach.correct_text ?? "", cardText,
    customerNames: customerNamesOf(db, owner?.customer_id),
  });
  if (refusal) return { error: refusal };
  if (!owner) return teach;
  const hash = safe(() => db.teachCustomerHash(owner.customer_id), "");
  return hash ? { ...teach, customer_hash: hash } : teach;
}

// ค่าที่หน้าเว็บส่งมาในช่อง hash ถูกทิ้งเสมอ — รับมาแล้วไม่มีทางแยกว่าเป็น hash หรือ id ดิบ
export function stripClientHash(raw = {}) {
  const { customer_hash: _a, customerHash: _b, ...rest } = raw && typeof raw === "object" ? raw : {};
  return rest;
}

// ชื่อของลูกค้าห้องนั้น (ชื่อที่ทีมตั้งเอง + ชื่อโปรไฟล์ LINE) — ใช้เทียบกับข้อความที่จะเป็นการ์ด
function customerNamesOf(db, customerId) {
  if (!customerId) return [];
  const row = safe(() => db.getCustomer(customerId), null);
  return [row?.known_name, row?.display_name].filter(Boolean).map(String);
}

/* ---------------------------------- ตัวช่วย ---------------------------------- */

// ผลตรวจของรุ่นที่ใช้อยู่ (คอมไพล์สดเพื่อให้ข้อที่ผูกกับ "วันนี้" ขึ้นเองในวันถัดมา)
function liveLintFindings(db) {
  const live = db.getBrainPointer("live");
  if (!live) return [];
  const todayIso = todayInBangkok(Date.now());
  const bundle = compileBrain(db, live.version_id, { todayIso, logger: QUIET });
  const manifest = safeJson(live.manifest_json) ?? {};
  return runBrainLints({
    cards: bundle.cards, bundle, todayIso: bundle.todayIso,
    allowlist: liveLintAllowlist(db, manifest.lintAllowlist ?? []),
  }).map((finding) => ({
    code: finding.code, severity: finding.severity, message: finding.message,
    cardId: finding.cardId ?? null,
  }));
}

// ผลค้นที่ "อ่อน" = ไม่มีใบไหนใกล้พอจะเชื่อ — จอต้องพูดว่าระบบหาไม่เจอ ไม่ใช่ยืนยันว่าไม่มี
function isWeakSearch(related = []) {
  return related.length === 0 || related.every((card) => card.weak === true)
    || Number(related[0]?.score ?? 0) < RELATED_WEAK_SCORE;
}

// relatedKnowledge คืนข้อมูลไว้พอให้ตัดสินว่าจะทับใบเดิมหรือไม่; เพิ่มเฉพาะ metadata
// ที่อ่านจากแถวเดิม เพื่อจอสอนไม่เขียนทับ scope เดิมแบบเงียบ ๆ เมื่อเลือกแก้ใบนั้น.
function relatedWithMetadata(db, text) {
  return safe(() => relatedKnowledge(db.listKnowledge(), text).map((card) => {
    const row = db.getKnowledge(card.id);
    const metadata = knowledgeMetadataFromRow(row);
    return { ...card, knowledgeMetadata: metadata, expectedKnowledgeHash: knowledgeExpectedHash(row) };
  }), []);
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}

function safeJson(text) {
  try { return JSON.parse(String(text || "null")); } catch { return null; }
}
