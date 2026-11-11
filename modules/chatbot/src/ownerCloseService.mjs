// ownerCloseService.mjs — พี่ง้วง/ชมพู่กดยืนยัน (หรือไม่ปิด) ห้องที่ AI เสนอ (คำสั่งพี่ง้วง 12 ต.ค. 2026 ค่ำ)
//
// "ยืนยัน" = ลูกแพรลาสุภาพหนึ่งข้อความ (ข้อความตายตัวตามหมวด — offtopicFallbackText ไม่มีโมเดลร่าง) แล้วห้องเป็นสีเหลือง
// not_qualified ด้วย closer.applyClose ชุดเดียวกับการตีจบ (CAS · audit · qualify:<id> · qualify_hold)
// "ปิดเงียบ" = ห้องเหลืองโดยไม่ส่งคำลา (Facebook นอกหน้าต่าง 24 ชม. / ส่งไม่สำเร็จ / เจ้าของเลือกเอง)
// "ไม่ปิด" = จำไว้ (offtopic_owner_kept:<id> หมวดนั้น 30 วัน) + เหตุสั้นของเจ้าของเป็นตัวอย่างห้ามปิด · ย้อนได้ใน 10 วิ
//
// ลำดับยืนยัน (ห้ามสลับ):
//   1. CAS pending → confirming ด้วย revision ที่คอนโซลเห็น (กดซ้ำสองเครื่อง = 409 · ไม่มีอะไรออกไปซ้ำ)
//   2. ในคิวของห้อง (pipeline.runExclusive — คิวเดียวกับเส้นตอบลูกค้า) ตรวจใหม่ทั้งหมดก่อนส่งไบต์แรก:
//      ตัวกวาด qualify_sweep_mode ต้องเป็น on (ไม่งั้นห้องเหลืองถูกคืนทุกนาที = ลาแล้วไม่ปิด — ปฏิเสธก่อนส่งเสมอ)
//      · AI ยังเปิดและห้องไม่เหลือง · closer.blockReason ว่าง · ไม่มีข้อความลูกค้าใหม่หลังที่คนตรวจเห็น (409 ลูกค้าพิมพ์ใหม่
//      และคืน pending พร้อมจุดอ้างอิงใหม่) · Facebook ต้องอยู่ในหน้าต่าง 24 ชม.
//   3. รั้ว proactive_attempts (lane owner_close · คีย์ = id ข้อเสนอ) ลงดิสก์ก่อนยิง — ผลกำกวมห้ามส่งซ้ำเอง
//   4. push (LINE ไม่มี reply token แล้ว · นับโควตา) → บันทึกเฉพาะที่ provider รับ → applyClose → audit ด้วยชื่อผู้กด
//      applyClose ปิดเทียบ "ข้อความที่คนตรวจเห็น" (anchorSeen) — ลูกค้าพิมพ์แทรกระหว่างยิง push ห้องก็ยังเหลือง
//      (ไม่งั้นลาแล้วห้องเขียว ลูกแพรตอบต่อท้ายคำลา) ข้อความใหม่ไปตามเส้นห้องเหลือง: เปิดคืนเร็ว/ตัวกวาดตรวจซ้ำ
// ไม่เก็บข้อความแชทใน audit/log — เก็บรหัสข้อเสนอ หมวด และผลเท่านั้น
import { aiPausedNow } from "./aiPause.mjs";
import { FACEBOOK_CHANNEL_ID } from "./channels.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
import { isNotQualifiedRow } from "./notQualified.mjs";
import { forgetOfftopicOwnerKept, rememberOfftopicOwnerKept } from "./offtopicClose.mjs";
import { ownerRejectNoteText } from "./ownerReviewPrompt.mjs";
import { QUALIFY_LATEST_INBOUND_SQL, readQualifySweepModeStrict } from "./qualifySweepRules.mjs";

export const OWNER_CLOSE_LANE = "owner_close";
export const OWNER_CLOSE_ACTIONS = Object.freeze(["confirm", "silent", "reject"]);
/** "ไม่ปิด" ย้อนได้ภายในกี่มิลลิวินาที (ยืนยันแล้วส่งคำลาไปแล้ว ย้อนไม่ได้) */
export const OWNER_CLOSE_UNDO_MS = 10_000;
/** ค้าง confirming นานเกินนี้ = โปรเซสตายกลางการยืนยัน (รอบตรวจกู้ให้) */
export const OWNER_CLOSE_STUCK_MS = 5 * 60_000;
export const OWNER_CLOSE_REJECT_NOTE_MAX = 200;
/** เหตุ "ไม่ปิด" เติมทีหลังได้นานแค่ไหน (ชิปเหตุผลในแถบย้อนของหน้าเว็บ) */
export const OWNER_CLOSE_NOTE_WINDOW_MS = 10 * 60_000;

// ข้อความตอบกลับของคอนโซล (ภาษาไทย) — code คือสัญญากับหน้าเว็บ ห้ามเปลี่ยนชื่อ
const MESSAGES = Object.freeze({
  not_found: "ไม่พบข้อเสนอนี้ (อาจถูกลบตามสิทธิ์ให้ลืม)",
  bad_request: "คำขอไม่ถูกต้อง",
  already_decided: "ข้อเสนอนี้ถูกตัดสินไปแล้ว — โหลดใหม่เพื่อดูผล",
  stale_revision: "มีคนกดข้อเสนอนี้ไปก่อนแล้ว — โหลดใหม่ก่อนนะคะ",
  sweep_not_on: "ตัวคัดกรองรายชั่วโมงไม่ได้เปิดอยู่ (qualify_sweep_mode ไม่ใช่ on) — ปิดห้องเป็นสีเหลืองไม่ได้ ยังไม่ได้ส่งอะไรถึงลูกค้า",
  room_changed: "ห้องนี้เปลี่ยนไปแล้ว (AI ปิดอยู่หรือเป็นสีเหลืองแล้ว) — ข้อเสนอหมดอายุ",
  blocked: "ห้องนี้ปิดไม่ได้แล้ว (มีคนรับห้อง/เรื่องเงิน/คะแนนสูง ฯลฯ) — ข้อเสนอหมดอายุ",
  customer_typed: "ลูกค้าพิมพ์ใหม่ — อ่านข้อความล่าสุดก่อนตัดสินอีกครั้งนะคะ",
  fb_window_closed: "ห้อง Facebook นี้เลย 24 ชม. แล้ว ส่งคำลาไม่ได้ — เลือก \"ปิดเงียบ\" ได้ (ห้องเป็นสีเหลืองโดยไม่ส่งข้อความ)",
  opted_out: "ลูกค้าขอไม่รับข้อความ — ส่งคำลาไม่ได้ เลือก \"ปิดเงียบ\" ได้",
  ai_paused: "ตอนนี้พัก AI ทั้งระบบอยู่ — ส่งคำลาไม่ได้ เลือก \"ปิดเงียบ\" ได้",
  delivery_fenced: "การส่งครั้งก่อนของข้อเสนอนี้ผลไม่แน่ชัด — ระบบไม่ส่งซ้ำเอง เลือก \"ปิดเงียบ\" หรือ \"ไม่ปิด\"",
  send_failed: "ส่งคำลาไม่สำเร็จ — ยังไม่ได้ปิดห้อง เลือก \"ปิดเงียบ\" หรือ \"ไม่ปิด\" ได้",
  close_failed: "ปิดห้องเป็นสีเหลืองไม่สำเร็จ — ยังไม่ได้ส่งอะไรถึงลูกค้า",
  not_undoable: "ย้อนได้เฉพาะ \"ไม่ปิด\" เท่านั้น — ยืนยันแล้วส่งคำลาไปแล้วย้อนไม่ได้",
  undo_expired: "เลย 10 วินาทีแล้ว ย้อนไม่ได้ — ข้อเสนอนี้จบแล้ว",
  superseded: "ห้องนี้มีข้อเสนอใหม่แล้ว ย้อนข้อเสนอเก่าไม่ได้",
  not_notable: "เติมเหตุได้เฉพาะห้องที่เพิ่งกด \"ไม่ปิด\" เองเท่านั้น",
  note_expired: "เลยเวลาเติมเหตุแล้ว — ข้อเสนอนี้จบแล้ว",
});

const refusal = (status, code, extra = {}) => ({ status, body: { ok: false, code, error: MESSAGES[code] || code, ...extra } });
const okResult = (body) => ({ status: 200, body: { ok: true, ...body } });

/** ตัวเลขรุ่นที่คอนโซลส่งมา — ต้องเป็นจำนวนเต็มไม่ติดลบ (ไม่ส่ง = คำขอไม่ถูกต้อง) */
function parseRevision(value) {
  const number = typeof value === "number" ? value : (typeof value === "string" && /^\d{1,9}$/u.test(value) ? Number(value) : NaN);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

export function createOwnerCloseService({ config = {}, db, closer, pipeline = null, lineRegistry = null, logger = console, now = Date.now } = {}) {
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };
  const latestInbound = (customerId) => db.raw.prepare(QUALIFY_LATEST_INBOUND_SQL).get(String(customerId)) ?? null;
  const exclusive = (customerId, work) => (typeof pipeline?.runExclusive === "function" ? pipeline.runExclusive(customerId, work) : work());

  function audit(operator, action, target, detail) {
    try {
      db.addAudit({ operator: String(operator || "system:owner_review"), action, target: String(target || ""), detail: String(detail).slice(0, 400) });
    } catch (err) {
      logger.warn?.(`owner-close: บันทึก audit ไม่สำเร็จ (${err?.message || err})`);
    }
  }

  const detailOf = (proposal, extra = []) => [`proposal=${proposal.id}`, proposal.category, ...extra].filter(Boolean).join(" · ");

  // คืนสถานะ confirming → pending/expired/send_failed (ไม่เช็ค revision — เราเป็นคนถือ confirming อยู่เอง)
  function settle(proposal, status, { outcome = "", baselineInboundId, decidedBy, decidedAt } = {}) {
    return db.casOwnerCloseProposal(proposal.id, {
      from: ["confirming"],
      patch: {
        status, outcome,
        ...(baselineInboundId !== undefined ? { baselineInboundId } : {}),
        ...(decidedBy !== undefined ? { decidedBy } : {}),
        ...(decidedAt !== undefined ? { decidedAt } : {}),
      },
    });
  }

  /* ---------------------------------- ส่งคำลา ---------------------------------- */

  async function sendGoodbye(proposal, row, latest, username) {
    const customerId = String(proposal.customer_id);
    const t = Number(now());
    const claim = db.claimProactiveAttempt(customerId, OWNER_CLOSE_LANE, proposal.id, t);
    if (!claim.ok || !db.fenceProactiveSend(customerId, OWNER_CLOSE_LANE, proposal.id, t)) return { ok: false, code: "delivery_fenced" };
    const text = closer.fallbackText(proposal.category);
    let sendResult = null;
    try {
      const client = lineRegistry?.forChannel?.(row.channel_id || "default");
      if (!client?.sendBubbles) return { ok: false, code: "send_failed", detail: "no_client" };
      sendResult = await client.sendBubbles({
        batch: true, to: lineRegistry.rawUserId(customerId), replyToken: "", bubbles: [{ text }], images: [],
        // ลูกค้าพิมพ์แทรกระหว่างยิง = หยุด (มีผลเมื่อมีหลายชิ้น — คำลามีชิ้นเดียว ด่านหลักอยู่ก่อนยิงในคิวของห้อง)
        stillRelevant: () => String(safe(() => latestInbound(customerId)?.id, "")) === String(latest.id),
        purpose: SEND_PURPOSE.ownerClose,
      });
    } catch (err) {
      logger.warn?.(`owner-close: ส่งคำลาไม่สำเร็จ (${err?.name || "Error"})`);
      sendResult = null;
    } finally {
      // รั้วต้องปิดเสมอ แม้ provider โยน error — ผลกำกวมห้ามถูกลองส่งซ้ำอัตโนมัติ
      safe(() => db.settleProactiveSend(customerId, OWNER_CLOSE_LANE, proposal.id, Number(now())), null);
    }
    const delivered = Array.isArray(sendResult?.delivered) ? sendResult.delivered
      : sendResult?.ok && Array.isArray(sendResult.acceptedRequestMessages) ? sendResult.acceptedRequestMessages
        : sendResult?.ok ? [{ type: "text", text }] : [];
    if (!delivered.some((message) => (message?.type ?? "text") === "text")) {
      return { ok: false, code: "send_failed", detail: String(sendResult?.reason || sendResult?.status || "no_result").slice(0, 60) };
    }
    safe(() => db.insertMessage({
      customerId, direction: "out", msgType: "text", content: text, messageClass: "proactive", agentMode: "ai",
      metadata: { ownerClose: { proposalId: proposal.id, category: proposal.category, confirmedBy: username } },
    }), null);
    return { ok: true, text };
  }

  /* ---------------------------------- ยืนยัน ---------------------------------- */

  // ตรวจในคิวของห้อง — คืน {row, latest} = ผ่าน · {status, body} = ผลที่ส่งกลับคอนโซล (สถานะข้อเสนอถูกจัดการแล้ว)
  // restoreTo = สถานะก่อนกด (pending หรือ send_failed) — ถูกปฏิเสธแบบ "ยังตัดสินใหม่ได้" คืนสถานะเดิม
  function freshRefusal(proposal, { silent, seenMessageId, restoreTo }) {
    const customerId = String(proposal.customer_id);
    // ระหว่างรอคิวของห้อง ตัวกู้ (recoverStuck) อาจคืนข้อเสนอนี้ไปแล้ว — ไม่ใช่ของเราแล้ว ห้ามส่งอะไรต่อ
    const current = db.ownerCloseProposal(proposal.id);
    if (current?.status !== "confirming" || Number(current.revision) !== Number(proposal.revision)) {
      return refusal(409, "stale_revision");
    }
    const sweep = readQualifySweepModeStrict(db);
    if (sweep !== "on") {
      settle(proposal, restoreTo, { outcome: "sweep_not_on" });
      return refusal(409, "sweep_not_on");
    }
    const row = db.getCustomer(customerId);
    if (!row || Number(row.ai_enabled) !== 1 || isNotQualifiedRow(row)) {
      settle(proposal, "expired", { outcome: "room_ai_off" });
      return refusal(409, "room_changed");
    }
    const block = closer.blockReason(customerId, row, proposal.category);
    if (block) {
      settle(proposal, "expired", { outcome: `blocked:${block}` });
      return refusal(409, "blocked", { blockReason: block });
    }
    const latest = latestInbound(customerId);
    if (!latest || String(latest.id) !== String(seenMessageId)) {
      settle(proposal, restoreTo, { outcome: "customer_typed", baselineInboundId: String(latest?.id || proposal.baseline_inbound_id) });
      return refusal(409, "customer_typed", { latestInboundId: String(latest?.id || "") });
    }
    if (!silent) {
      if (Number(row.marketing_consent ?? 0) < 0 || row.ai_off_reason === "optout") {
        settle(proposal, restoreTo, { outcome: "opted_out" });
        return refusal(409, "opted_out", { canSilent: true });
      }
      if (aiPausedNow({ db, config })) {
        settle(proposal, restoreTo, { outcome: "ai_paused" });
        return refusal(409, "ai_paused", { canSilent: true });
      }
      if (String(row.channel_id || "") === FACEBOOK_CHANNEL_ID && !safe(() => db.withinFacebookWindow(customerId, Number(now())), false)) {
        settle(proposal, restoreTo, { outcome: "fb_window_closed" });
        return refusal(409, "fb_window_closed", { canSilent: true });
      }
    }
    return { row, latest };
  }

  async function confirmInQueue(proposal, { silent, seenMessageId, username, restoreTo }) {
    const customerId = String(proposal.customer_id);
    const fresh = freshRefusal(proposal, { silent, seenMessageId, restoreTo });
    if (fresh.status) return fresh;
    const { row, latest } = fresh;
    let sent = null;
    if (!silent) {
      sent = await sendGoodbye(proposal, row, latest, username);
      if (!sent.ok) {
        const t = Number(now());
        settle(proposal, "send_failed", { outcome: sent.detail ? `${sent.code}:${sent.detail}` : sent.code, decidedBy: username, decidedAt: t });
        audit(username, "owner_close_send_failed", customerId, detailOf(proposal, [sent.code]));
        return refusal(sent.code === "delivery_fenced" ? 409 : 502, sent.code, { canSilent: true, proposal: publicProposal(db.ownerCloseProposal(proposal.id)) });
      }
    }
    const plan = { category: proposal.category, cue: proposal.cue, reason: proposal.ai_reason };
    // ส่งคำลาแล้ว = ปิดเทียบข้อความที่คนตรวจเห็น (anchorSeen) — ลูกค้าพิมพ์แทรกระหว่างยิง push ห้องก็ยังเหลือง
    // (ลาแล้วห้องยังเขียว = ลูกแพรตอบต่อท้ายคำลา) ข้อความใหม่ถูกตัดสินต่อโดยเส้นห้องเหลืองตามปกติ · ปิดเงียบไม่มีช่วงรอ ใช้ด่านเดิม
    const applyResult = closer.applyClose({ customerId, plan, inboundId: String(latest.id), owner: { username, silent, anchorSeen: !silent } });
    const applied = applyResult.outcome;
    const typedDuringSend = applyResult.newerInbound === true;
    const t = Number(now());
    if (applied !== "yellow" && silent) {
      // ปิดเงียบไม่สำเร็จ = ไม่มีอะไรเกิดขึ้นกับลูกค้า — คืนสถานะเดิมให้ตัดสินใหม่
      settle(proposal, restoreTo, { outcome: `close_failed:${applied}` });
      return refusal(409, "close_failed", { outcome: applied });
    }
    // ส่งคำลาแล้วแต่ปิดเหลืองไม่ได้ (คนรับห้อง/เงินเข้าระหว่างยิง ฯลฯ) — คำลาถึงลูกค้าแล้ว ข้อเสนอจบ ห้องตามด่านนั้น
    const status = silent ? "closed_silent" : "confirmed";
    const outcome = silent ? applied
      : applied === "yellow" ? (typedDuringSend ? "yellow:customer_typed_during_send" : "yellow") : `sent_not_closed:${applied}`;
    settle(proposal, status, { outcome, decidedBy: username, decidedAt: t });
    audit(username, silent ? "owner_close_silent" : "owner_close_confirm", customerId,
      detailOf(proposal, [silent ? "ไม่ส่งคำลา" : "ส่งคำลาแล้ว", outcome]));
    return okResult({
      proposal: publicProposal(db.ownerCloseProposal(proposal.id)),
      sent: !silent, closed: applied === "yellow", outcome,
      ...(typedDuringSend ? { customerTypedDuringSend: true } : {}),
    });
  }

  /**
   * ตัดสินข้อเสนอ — คืน {status, body} ให้ API ส่งตรง ๆ (body.code = สัญญากับหน้าเว็บ)
   * @param {{proposalId: string, action: "confirm"|"silent"|"reject", operator: {username: string}, seenMessageId?: string, revision: number, reason?: string}} input
   */
  async function decide({ proposalId, action, operator, seenMessageId = "", revision, reason = "" } = {}) {
    const username = String(operator?.username || "").slice(0, 60);
    if (!OWNER_CLOSE_ACTIONS.includes(action) || !username) return refusal(400, "bad_request");
    const expected = parseRevision(revision);
    if (expected === null) return refusal(400, "bad_request", { field: "revision" });
    if (action !== "reject" && !String(seenMessageId || "").trim()) return refusal(400, "bad_request", { field: "seenMessageId" });
    if (typeof reason !== "string" || Array.from(reason).length > OWNER_CLOSE_REJECT_NOTE_MAX) return refusal(400, "bad_request", { field: "reason" });
    const proposal = db.ownerCloseProposal(String(proposalId || ""));
    if (!proposal) return refusal(404, "not_found");
    // ยืนยัน (ส่งคำลา) ได้จาก pending เท่านั้น · ปิดเงียบ/ไม่ปิด ได้จาก pending หรือหลังส่งไม่สำเร็จ
    const from = action === "confirm" ? ["pending"] : ["pending", "send_failed"];
    if (!from.includes(proposal.status)) return refusal(409, "already_decided", { status: proposal.status });
    if (Number(proposal.revision) !== expected) return refusal(409, "stale_revision", { revision: Number(proposal.revision) });

    if (action === "reject") return reject(proposal, { username, expected, reason });

    const claimed = db.casOwnerCloseProposal(proposal.id, { from, expectedRevision: expected, patch: { status: "confirming" } });
    if (!claimed) return refusal(409, "stale_revision");
    try {
      return await exclusive(String(proposal.customer_id), () => confirmInQueue(claimed, {
        silent: action === "silent", seenMessageId: String(seenMessageId), username, restoreTo: proposal.status,
      }));
    } catch (err) {
      logger.error?.(`owner-close: ยืนยันไม่สำเร็จ (${err?.message || err})`);
      // ยังถือ confirming อยู่ = ไม่รู้ว่าข้ามเส้น provider หรือยัง — ให้ตัวกู้ (recoverStuck) ตัดสินจากรั้วส่ง
      return refusal(500, "send_failed", { canSilent: false });
    }
  }

  function reject(proposal, { username, expected, reason }) {
    const row = safe(() => db.getCustomer(proposal.customer_id), null);
    const note = ownerRejectNoteText(reason, [row?.display_name, row?.known_name]);
    const t = Number(now());
    const updated = db.casOwnerCloseProposal(proposal.id, {
      from: ["pending", "send_failed"], expectedRevision: expected,
      patch: { status: "rejected", outcome: "owner_kept", ownerNote: note, decidedBy: username, decidedAt: t },
    });
    if (!updated) return refusal(409, "stale_revision");
    try {
      rememberOfftopicOwnerKept(db, proposal.customer_id, proposal.category, { by: username, proposalId: proposal.id, nowMs: t });
    } catch (err) {
      logger.warn?.(`owner-close: จด "ไม่ปิด" ไม่สำเร็จ (${err?.message || err})`);
    }
    audit(username, "owner_close_reject", proposal.customer_id, detailOf(proposal, [note ? "มีเหตุ" : "ไม่มีเหตุ"]));
    return okResult({ proposal: publicProposal(updated), undoUntil: t + OWNER_CLOSE_UNDO_MS });
  }

  /** ย้อน "ไม่ปิด" ภายใน 10 วิ — กลับเป็น pending และลบความจำ "ไม่ปิด" ของข้อเสนอนี้ */
  function undo({ proposalId, operator, revision } = {}) {
    const username = String(operator?.username || "").slice(0, 60);
    const expected = parseRevision(revision);
    if (!username || expected === null) return refusal(400, "bad_request");
    const proposal = db.ownerCloseProposal(String(proposalId || ""));
    if (!proposal) return refusal(404, "not_found");
    if (proposal.status !== "rejected") return refusal(409, "not_undoable", { status: proposal.status });
    if (Number(now()) - (Number(proposal.decided_at) || 0) > OWNER_CLOSE_UNDO_MS) return refusal(409, "undo_expired");
    let back = null;
    try {
      back = db.casOwnerCloseProposal(proposal.id, {
        from: ["rejected"], expectedRevision: expected,
        patch: { status: "pending", outcome: "", ownerNote: "", decidedBy: "", decidedAt: null },
      });
    } catch (err) {
      if (/UNIQUE/u.test(String(err?.message || ""))) return refusal(409, "superseded");
      throw err;
    }
    if (!back) return refusal(409, "stale_revision");
    safe(() => forgetOfftopicOwnerKept(db, proposal.customer_id, proposal.category, { proposalId: proposal.id, nowMs: Number(now()) }), false);
    audit(username, "owner_close_undo", proposal.customer_id, detailOf(proposal));
    return okResult({ proposal: publicProposal(back) });
  }

  /**
   * เติมเหตุ "ไม่ปิด" ทีหลัง (แตะชิปในแถบย้อน) — เฉพาะคนที่กดเองและภายใน 10 นาที · ไม่เปลี่ยนสถานะ
   * เหตุนี้คือตัวอย่างห้ามปิดที่รอบตรวจถัดไปอ่าน (recentOwnerCloseRejections) — ปิดชื่อ/เบอร์ก่อนเก็บเสมอ
   */
  function note({ proposalId, operator, revision, reason = "" } = {}) {
    const username = String(operator?.username || "").slice(0, 60);
    const expected = parseRevision(revision);
    if (!username || expected === null) return refusal(400, "bad_request", { field: "revision" });
    if (typeof reason !== "string" || !reason.trim() || Array.from(reason).length > OWNER_CLOSE_REJECT_NOTE_MAX) {
      return refusal(400, "bad_request", { field: "reason" });
    }
    const proposal = db.ownerCloseProposal(String(proposalId || ""));
    if (!proposal) return refusal(404, "not_found");
    if (proposal.status !== "rejected" || String(proposal.decided_by) !== username) return refusal(409, "not_notable", { status: proposal.status });
    if (Number(now()) - (Number(proposal.decided_at) || 0) > OWNER_CLOSE_NOTE_WINDOW_MS) return refusal(409, "note_expired");
    const row = safe(() => db.getCustomer(proposal.customer_id), null);
    const text = ownerRejectNoteText(reason, [row?.display_name, row?.known_name]);
    const updated = db.casOwnerCloseProposal(proposal.id, { from: ["rejected"], expectedRevision: expected, patch: { ownerNote: text } });
    if (!updated) return refusal(409, "stale_revision");
    audit(username, "owner_close_note", proposal.customer_id, detailOf(proposal, ["มีเหตุ"]));
    return okResult({ proposal: publicProposal(updated) });
  }

  /** หมดอายุ (รอเกิน 72 ชม. / ห้องถูกกัน) — ใช้โดยรอบตรวจ · คืน true = เปลี่ยนแล้ว */
  function expire(proposal, outcome) {
    const changed = db.casOwnerCloseProposal(proposal.id, {
      from: ["pending", "send_failed"], expectedRevision: Number(proposal.revision),
      patch: { status: "expired", outcome: String(outcome || "expired").slice(0, 80) },
    });
    if (changed) audit("system:owner_review", "owner_close_expired", proposal.customer_id, detailOf(proposal, [outcome]));
    return Boolean(changed);
  }

  /**
   * กู้ข้อเสนอที่ค้าง confirming (โปรเซสตายกลางการยืนยัน) — รั้วส่งบอกว่าข้ามเส้น provider ไปแล้วหรือยัง
   * ข้ามแล้ว/ไม่แน่ใจ = send_failed (ห้ามส่งซ้ำ ให้คนเลือกปิดเงียบ/ไม่ปิด) · ยังไม่ข้าม = คืน pending
   */
  function recoverStuck(nowMs = Number(now())) {
    let recovered = 0;
    for (const proposal of db.stuckConfirmingOwnerCloseProposals(nowMs - OWNER_CLOSE_STUCK_MS)) {
      const attempt = safe(() => db.getProactiveAttempt(proposal.customer_id, OWNER_CLOSE_LANE, proposal.id), null);
      const crossed = attempt && ["sending", "settled"].includes(attempt.status);
      if (settle(proposal, crossed ? "send_failed" : "pending", { outcome: crossed ? "interrupted_after_send" : "interrupted" })) {
        recovered += 1;
        audit("system:owner_review", "owner_close_recovered", proposal.customer_id, detailOf(proposal, [crossed ? "send_failed" : "pending"]));
      }
    }
    return recovered;
  }

  return { decide, undo, note, expire, recoverStuck };
}

/** รูปที่คอนโซลเห็น (ไม่มีข้อความแชท ไม่มีชื่อเต็ม) — ใช้ร่วมกับ consoleOwnerReviewApi */
export function publicProposal(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    channelId: String(row.channel_id || "default"),
    batchId: String(row.batch_id || ""),
    source: String(row.source || ""),
    category: String(row.category || ""),
    cue: String(row.cue || ""),
    reason: String(row.ai_reason || ""),
    status: String(row.status || ""),
    outcome: String(row.outcome || ""),
    note: String(row.owner_note || ""),
    baselineInboundId: String(row.baseline_inbound_id || ""),
    decidedBy: String(row.decided_by || ""),
    decidedAt: row.decided_at == null ? null : Number(row.decided_at),
    revision: Number(row.revision) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
  };
}
