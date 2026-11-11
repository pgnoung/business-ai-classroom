// consoleTrainingApi.mjs — owner-only review of LINE `/reset` training snapshots.
// A decision changes candidate workflow state only. It never writes persona,
// knowledge, or runtime prompt state; a separate, explicit promotion is needed.

const STATUSES = new Set(["pending_owner_confirmation", "approved", "rejected"]);
const ACK_ATTEMPT_STALE_MS = 120_000;

function isOwner(operator) {
  return operator?.role === "owner";
}

function ackAttemptInFlight(row, currentTime = Date.now()) {
  if (!String(row?.ack_detail || "").startsWith("attempt_started")) return false;
  const encoded = Number(String(row.ack_detail).split(":")[1]);
  const startedAt = Number.isFinite(encoded) && encoded > 0 ? encoded : Number(row.created_at) || currentTime;
  return startedAt > currentTime - ACK_ATTEMPT_STALE_MS;
}

function summary(row, trainingCandidateDays = 90) {
  return {
    id: row.id,
    status: row.status,
    ack_status: row.ack_status || "pending",
    ack_detail: row.ack_detail || "",
    ack_resolved: Number(row.ack_resolved_at) > 0,
    ack_resolved_at: row.ack_resolved_at ?? null,
    ack_resolution: row.ack_resolution || "",
    ack_resolution_available: row.ack_status !== "sent" && !row.ack_resolved_at && !ackAttemptInFlight(row),
    message_count: Number(row.message_count) || 0,
    created_at: row.created_at,
    expires_at: Number(row.created_at) + Math.max(0, Number(trainingCandidateDays) || 0) * 86_400_000,
    decided_at: row.decided_at ?? null,
    decided_by: row.decided_by || "",
    applied_to_brain: false,
  };
}

function transcript(row) {
  let parsed = [];
  try { parsed = JSON.parse(row.transcript_json || "[]"); } catch { parsed = []; }
  if (!Array.isArray(parsed)) parsed = [];
  return parsed
    .filter((turn) => turn && (turn.direction === "in" || turn.direction === "out"))
    .map((turn) => ({
      direction: turn.direction,
      content: String(turn.content || ""),
      created_at: Number(turn.created_at) || 0,
      agent_mode: turn.agent_mode || null,
      operator: turn.operator || "",
      message_class: turn.message_class || "reactive",
    }));
}

export function createTrainingReviewRoutes({ db, trainingCandidateDays = 90 }) {
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "training-candidates") return false;
    const { json, readJson, username, operator, requireCsrf } = ctx;
    if (!isOwner(operator)) {
      json(res, 403, { ok: false, error: "สำหรับเจ้าของระบบเท่านั้น" });
      return true;
    }

    if (req.method === "GET" && route.length === 1) {
      const status = url.searchParams.get("status") || "pending_owner_confirmation";
      if (status !== "all" && !STATUSES.has(status)) {
        json(res, 400, { ok: false, error: "status ไม่ถูกต้อง" });
        return true;
      }
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 100));
      // v1.2.6 (ตรวจอิสระ): เมื่อเก็บบทสนทนาถาวร แถวจะสะสมจนเกินเพดาน แล้วชุดที่ยังไม่
      // ตัดสินซึ่งเก่ากว่า 100 ชุดล่าสุดจะหายจากหน้าจอเจ้าของแบบเงียบ ๆ — คิวงานที่ยัง
      // ค้างจึงต้องถูกดึงมาก่อนเสมอ และต้องบอกยอดค้างจริงให้ UI เตือนได้
      const pendingQueue = status === "all"
        ? db.listTrainingCandidates({ status: "pending_owner_confirmation", limit })
        : [];
      const listed = db.listTrainingCandidates({ status: status === "all" ? null : status, limit });
      const seen = new Set(pendingQueue.map((row) => row.id));
      const merged = [...pendingQueue, ...listed.filter((row) => !seen.has(row.id))].slice(0, limit);
      const candidates = merged.map((row) => summary(row, trainingCandidateDays));
      const pendingTotal = db.listTrainingCandidates({ status: "pending_owner_confirmation", limit: 200 }).length;
      json(res, 200, {
        ok: true,
        status,
        candidates,
        pendingTotal,
        hasMore: listed.length >= limit,
        promotionRequired: true,
        notice: "การยืนยันนี้ยังไม่เปลี่ยน Persona, Brain หรือ Knowledge; ต้อง promote แยกต่างหาก",
      });
      return true;
    }

    if (req.method === "GET" && route.length === 2) {
      const row = db.getTrainingCandidate(decodeURIComponent(route[1]));
      if (!row) {
        json(res, 404, { ok: false, error: "ไม่พบชุดบทสนทนา" });
        return true;
      }
      json(res, 200, {
        ok: true,
        // v1.2.6: ความเห็นของผู้ทดสอบต้องอ่านคู่กับบทสนทนาเสมอ ไม่งั้นรีวิวไม่ได้
        candidate: {
          ...summary(row, trainingCandidateDays),
          transcript: transcript(row),
          feedback: db.trainingFeedbackForSession(row.session_id).map((item) => ({
            reviewer: item.reviewer, content: item.content, at: item.created_at,
          })),
        },
        promotionRequired: true,
        notice: "การยืนยันนี้ยังไม่เปลี่ยน Persona, Brain หรือ Knowledge; ต้อง promote แยกต่างหาก",
      });
      return true;
    }

    if (req.method === "POST" && route.length === 3 && route[2] === "decide") {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const candidateId = decodeURIComponent(route[1]);
      const current = db.getTrainingCandidate(candidateId);
      if (!current) {
        json(res, 404, { ok: false, error: "ไม่พบชุดบทสนทนา" });
        return true;
      }
      if (current.status !== "pending_owner_confirmation") {
        json(res, 409, { ok: false, error: "ชุดบทสนทนานี้ถูกตัดสินแล้ว" });
        return true;
      }
      const body = await readJson(req);
      const action = String(body.action || "");
      if (action !== "approve" && action !== "reject") {
        json(res, 400, { ok: false, error: "action ต้องเป็น approve หรือ reject" });
        return true;
      }
      const candidate = db.decideTrainingCandidate(candidateId, {
        approved: action === "approve", decidedBy: username,
      });
      if (!candidate) {
        json(res, 409, { ok: false, error: "ชุดบทสนทนานี้ถูกตัดสินแล้ว" });
        return true;
      }
      db.addAudit({
        operator: username,
        action: `training_candidate_${action}`,
        target: candidateId,
        detail: `messages=${Number(candidate.message_count) || 0}; promotion_required=true`,
      });
      json(res, 200, {
        ok: true,
        candidate: summary(candidate, trainingCandidateDays),
        promotionRequired: true,
        notice: "บันทึกการตัดสินแล้ว แต่ยังไม่เปลี่ยน Persona, Brain หรือ Knowledge",
      });
      return true;
    }

    if (req.method === "POST" && route.length === 4 && route[2] === "ack" && route[3] === "resolve") {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const candidateId = decodeURIComponent(route[1]);
      const current = db.getTrainingCandidate(candidateId);
      if (!current) {
        json(res, 404, { ok: false, error: "ไม่พบชุดบทสนทนา" });
        return true;
      }
      const body = await readJson(req);
      if (String(body.action || "") !== "resolve_without_send") {
        json(res, 400, { ok: false, error: "action ต้องเป็น resolve_without_send" });
        return true;
      }
      if (current.ack_status === "sent") {
        json(res, 409, { ok: false, error: "ข้อความยืนยันถูกส่งสำเร็จแล้ว ไม่ต้องปิดสถานะซ้ำ" });
        return true;
      }
      if (current.ack_resolved_at) {
        json(res, 409, { ok: false, error: "สถานะ ACK นี้ถูกปิดแล้ว" });
        return true;
      }
      if (ackAttemptInFlight(current)) {
        json(res, 409, { ok: false, error: "กำลังส่ง ACK อยู่ กรุณารอผลก่อนปิดสถานะ" });
        return true;
      }
      const candidate = db.resolveTrainingCandidateAck(candidateId, { resolvedBy: username });
      if (!candidate) {
        json(res, 409, { ok: false, error: "สถานะ ACK เปลี่ยนแล้ว กรุณาโหลดใหม่" });
        return true;
      }
      db.addAudit({
        operator: username,
        action: "training_ack_resolve_without_send",
        target: candidateId,
        detail: `previous_status=${String(current.ack_status || "pending")}; no_provider_send=true`,
      });
      json(res, 200, {
        ok: true,
        candidate: summary(candidate, trainingCandidateDays),
        sent: false,
        notice: "ปิดสถานะ ACK แล้วโดยไม่ส่งข้อความซ้ำ",
      });
      return true;
    }

    return false;
  }

  return { handle };
}
