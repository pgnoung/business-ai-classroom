// consolePublishQueueApi.mjs — คิว "ขออนุมัติเผยแพร่" (Package K, คำสั่งพี่ง้วง 2 ก.ย. 2026)
//
// ปัญหาที่แก้: Package C ทำให้ราคา/สมอง/กติกา/รอบเรียน/คลังความรู้ เป็นสิทธิ์เจ้าของ
// คนเดียว ผลคือชมพู่กดอะไรก็ได้ 403 แล้วต้องไปตามพี่ง้วงทางแชท ซึ่งของจริงคือ
// "งานหาย" — คำขอไม่เคยถูกบันทึกไว้ที่ไหนเลย
//
// วิธีแก้ที่เลือก (คิวเดียวใช้ได้ทุกเส้น ไม่ใช่ก๊อปโค้ดต่อฟีเจอร์):
//   เก็บ "คำขอ" = {kind, method, route, body} ของ request จริงที่โดนกัน แล้ววันที่
//   เจ้าของกดอนุมัติ ระบบ "เล่นคำขอนั้นซ้ำ" ผ่าน handler ตัวเดิม แต่เปลี่ยนตัวตน
//   เป็นเจ้าของ — จึงไม่มีตรรกะตรวจสอบ/audit/ด่านล้น ชุดที่สองให้เพี้ยนจากของจริง
//
// สิ่งที่คิวนี้ "ไม่" ทำโดยเจตนา:
//   - ไม่แตะเส้นที่ทีมทำเองได้อยู่แล้ว (ที่นั่ง POST /class-rounds, คลังรีวิว PUT /reviews)
//   - ไม่ยอมให้คำขอที่กำลังเล่นซ้ำสร้างคำขอใหม่ (ctx.replaying — กันคิวซ้อนคิวไม่รู้จบ)
//   - ไม่เล่นซ้ำเส้นที่ไม่ได้อยู่ในทะเบียนข้างล่าง ถึงจะมีแถวใน DB ก็ตาม
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { publicPublishRequest, PUBLISH_SUMMARY_MAX, PUBLISH_LIST_FILTERS } from "./dbPublishRequests.mjs";

export const PUBLISH_QUEUED_MESSAGE = "ส่งให้พี่ง้วงอนุมัติแล้ว";
export const PUBLISH_APPROVE_CAPABILITY = "publish.approve";

// ทะเบียนเส้นที่เข้าคิวได้ — เป็นทั้ง allowlist ตอนเข้าคิวและตอนเล่นซ้ำ
// method/root ต้องตรงกับแถวใน DB เสมอ ไม่งั้นถือว่าแถวนั้นใช้ไม่ได้ (fail-closed)
export const PUBLISH_KINDS = Object.freeze({
  price_add: { method: "POST", root: "prices", label: "ตารางราคา" },
  price_edit: { method: "POST", root: "prices", label: "ตารางราคา" },
  price_delete: { method: "DELETE", root: "prices", label: "ตารางราคา" },
  brain_publish: { method: "POST", root: "settings", label: "สมอง AI ต่อ LINE OA" },
  product_rules: { method: "POST", root: "settings", label: "กติกาสินค้า" },
  hashtag_rules: { method: "POST", root: "settings", label: "คีย์เวิร์ดกิจกรรม #" },
  freeclass_links: { method: "POST", root: "settings", label: "ลิงก์คลาสฟรี" },
  class_round_set: { method: "POST", root: "class-rounds", label: "รอบเรียน" },
  class_round_delete: { method: "POST", root: "class-rounds", label: "รอบเรียน" },
  knowledge_add: { method: "POST", root: "knowledge", label: "คลังความรู้" },
  knowledge_edit: { method: "POST", root: "knowledge", label: "คลังความรู้" },
  knowledge_delete: { method: "DELETE", root: "knowledge", label: "คลังความรู้" },
  // เฟส 1b: คลังรีวิวเป็นข้อความที่ต่อตรงเข้า prompt เหมือนความรู้ใบอื่น จึงเข้าคิวชุดเดียวกัน
  // (เฉพาะตอนแฟล็ก KNOWLEDGE_VERSIONED เปิด — ปิดอยู่ = ทีมกรอกเองได้ตรง ๆ เหมือนเดิม)
  review_catalog_edit: { method: "PUT", root: "reviews", label: "คลังรีวิว" },
});

// หัวข้อคำขอไปโผล่ทั้งในรายการบนหน้าเว็บและในข้อความ push หาเจ้าของ — ยุบบรรทัด
// ทิ้งก่อนเสมอ ไม่งั้นข้อความที่ทีมพิมพ์เองแทรกบรรทัดปลอมเป็นเสียงระบบได้
export function cleanSummary(text) {
  return String(text || "").replace(/\s+/gu, " ").trim().slice(0, PUBLISH_SUMMARY_MAX);
}

// บันทึกคำขอ + audit + ปลุกเจ้าของ — ทุกอย่างต้องไม่โยน error ออกไปหาคนกด
// (คนกดต้องได้ 202 เสมอถ้าแถวถูกเขียนแล้ว แจ้งเตือนล้ม = เรื่องของ log)
export function queuePublishRequest({
  db, notifier = null, logger = console,
  kind, method, route, body, summary, proposedBy,
}) {
  const row = db.addPublishRequest({
    kind, method, route, body, summary: cleanSummary(summary), proposedBy,
  });
  try {
    db.addAudit({
      operator: proposedBy, action: "publish_request_queued", target: row.id,
      detail: `${kind} · ${row.summary}`,
    });
  } catch (err) {
    logger.debug?.(`publish queue: เขียน audit ไม่สำเร็จ (${err?.message || err})`);
  }
  try {
    const pending = db.countPendingPublishRequests();
    notifier?.fireLater({
      // ops: = เรื่องระบบ ไม่ผูกกับลูกค้าคนไหน (notify.mjs ตัดลิงก์เข้าห้องแชททิ้งให้เอง)
      customerId: "ops:publish", channelId: "default", reason: "publish_request",
      reasonTextOverride: `${proposedBy} ขออนุมัติเปลี่ยน${PUBLISH_KINDS[kind]?.label || "ข้อมูลตั้งต้น"}: ${row.summary}`
        + `\nรออนุมัติทั้งหมด ${pending} รายการ — เปิดหน้าตั้งค่าเพื่อกดอนุมัติหรือปฏิเสธ`,
      // force: คิวนี้ยิงนาน ๆ ครั้ง ถ้าโดน cooldown 10 นาทีกลืน คำขอใบที่สองจะเงียบหาย
      force: true,
    });
  } catch (err) {
    logger.debug?.(`publish queue: แจ้งเจ้าของไม่สำเร็จ (${err?.message || err})`);
  }
  return row;
}

/* --------------------------- เส้นทางของเจ้าของ --------------------------- */

// replay(row) -> { handled, status, payload, error } — ตัวจริงอยู่ใน consoleSettingsApi
// เพราะมันคือ handler ตัวเดียวกับที่รับ request จริง (ที่นี่ไม่รู้จักเส้นทางไหนเลย)
export function createPublishQueueRoutes({ db, replay, logger = console, denyMessage }) {
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "publish-requests") return false;
    const { json, username, operator, requireCsrf } = ctx;
    const canApprove = hasOperatorCapability(operator, PUBLISH_APPROVE_CAPABILITY);

    /* ---- GET: เจ้าของเห็นทั้งร้าน · ทีมงานเห็นเฉพาะคำขอของตัวเอง ---- */
    if (req.method === "GET" && route.length === 1) {
      // decided = อนุมัติ/ปฏิเสธ/ล้ม รวมกัน (K2) — แผง "ผลการตัดสินล่าสุด" ใช้เส้นนี้
      const status = url.searchParams.get("status") || "pending";
      if (!PUBLISH_LIST_FILTERS.includes(status)) {
        json(res, 400, { ok: false, error: `status ต้องเป็น ${PUBLISH_LIST_FILTERS.join(", ")}` });
        return true;
      }
      const limit = Number(url.searchParams.get("limit")) || 50;
      // since = ดูย้อนหลังถึงเวลาไหน (ms) — ค่าที่อ่านไม่ออกแปลว่า "ไม่จำกัด" ไม่ใช่ 400
      // เพราะนี่เป็นเส้นอ่านอย่างเดียว การตอบ 400 มีแต่ทำให้แผงหายทั้งแผงโดยไม่จำเป็น
      const sinceRaw = Number(url.searchParams.get("since"));
      const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? sinceRaw : null;
      const rows = db.listPublishRequests({
        status,
        // กรองที่ SQL ไม่ใช่ที่หน้าเว็บ — คนที่ไม่มีสิทธิ์อนุมัติต้องไม่ได้ข้อมูลคำขอของคนอื่น
        // ติดมือไปกับ response เลยแม้แต่ใบเดียว (จริงกับ decided เท่ากับ pending)
        proposedBy: canApprove ? null : username,
        limit,
        since,
      });
      json(res, 200, {
        ok: true,
        canApprove,
        pending: canApprove ? db.countPendingPublishRequests() : db.countPendingPublishRequests(username),
        requests: rows.map(publicPublishRequest),
      });
      return true;
    }

    /* ---- อนุมัติ / ปฏิเสธ — เจ้าของเท่านั้น ---- */
    const decision = route.length === 3 && req.method === "POST" ? route[2] : "";
    if (decision === "approve" || decision === "reject") {
      // ด่านสิทธิ์มาก่อน CSRF เสมอ (กติกาบ้านนี้ — ห้ามบอกใบ้ว่าหา token ได้แล้วจะผ่าน)
      if (!canApprove) {
        json(res, 403, { ok: false, error: denyMessage });
        return true;
      }
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const id = decodeURIComponent(route[1]);
      const row = db.getPublishRequest(id);
      if (!row) {
        json(res, 404, { ok: false, error: "ไม่พบคำขอนี้" });
        return true;
      }
      if (row.status !== "pending") {
        json(res, 409, { ok: false, error: "คำขอนี้ถูกตัดสินไปแล้ว" });
        return true;
      }
      const body = await ctx.readJson(req).catch(() => ({}));
      const note = cleanSummary(body?.note || "");

      if (decision === "reject") {
        const rejected = db.rejectPublishRequest(id, { decidedBy: username, note });
        if (rejected) db.scrubPublishRequestTeachText?.(id);
        if (!rejected) {
          json(res, 409, { ok: false, error: "คำขอนี้ถูกตัดสินไปแล้ว" });
          return true;
        }
        db.addAudit({
          operator: username, action: "publish_request_rejected", target: id,
          detail: `${row.kind} · ${row.summary}${note ? ` · ${note}` : ""}`,
        });
        json(res, 200, { ok: true, applied: false, request: publicPublishRequest(rejected) });
        return true;
      }

      // จองสิทธิ์ก่อนเล่นซ้ำเสมอ — กดสองครั้งรัว ๆ ต้องเขียนของจริงรอบเดียว
      if (!db.claimPublishRequest(id, { decidedBy: username })) {
        json(res, 409, { ok: false, error: "คำขอนี้ถูกตัดสินไปแล้ว" });
        return true;
      }
      let outcome;
      try {
        outcome = await replay(row, { username, operator });
      } catch (err) {
        // handler ตัวจริงโยน = ถือว่าคำขอนี้ล้ม ไม่ใช่คอนโซลล้ม — ห้ามให้ 500 หลุดออกไป
        outcome = { ok: false, error: String(err?.message || err).slice(0, PUBLISH_SUMMARY_MAX) };
        logger.debug?.(`publish queue: เล่นซ้ำคำขอ ${id} ไม่สำเร็จ (${err?.message || err})`);
      }
      // เล่นซ้ำแล้วได้ "รอรับทราบรุ่นสมอง N" — ไม่ใช่ความล้มเหลว และคนเสนอไม่ต้องส่งใหม่
      // ปล่อยคำขอค้างไว้ผูกกับรุ่นนั้น แล้วปลดให้เองตอนเจ้าของกดรับทราบหรือปัดตกรุ่น
      const awaitingVersion = outcome.ok !== true && outcome.payload?.brain?.outcome === "needs_ack"
        ? String(outcome.payload.brain.versionId || "") : "";
      if (awaitingVersion) {
        // ค้างรอรุ่น = ยังไม่จบ ข้อความยังต้องอยู่ให้คนกดรับทราบอ่านได้
        const parked = db.parkPublishRequest(id, {
          versionId: awaitingVersion,
          note: `รอพี่ง้วงรับทราบรุ่นสมอง ${outcome.payload.brain.seq ?? "?"}`,
        });
        db.addAudit({
          operator: username, action: "publish_request_pending_ack", target: id,
          detail: `${row.kind} · รุ่นสมอง ${outcome.payload.brain.seq ?? "?"}`,
        });
        json(res, 200, {
          ok: true, applied: false, pendingAck: true,
          brain: outcome.payload.brain,
          error: outcome.error || "",
          request: publicPublishRequest(parked),
        });
        return true;
      }
      const settled = db.settlePublishRequest(id, {
        status: outcome.ok ? "approved" : "failed",
        decidedBy: username,
        note: outcome.ok ? note : (outcome.error || "เล่นคำขอซ้ำไม่สำเร็จ"),
        result: outcome.ok
          ? { status: outcome.status ?? 200, payload: outcome.payload ?? null }
          : { status: outcome.status ?? 0, error: outcome.error || "", payload: outcome.payload ?? null },
      });
      db.scrubPublishRequestTeachText?.(id);
      db.addAudit({
        operator: username,
        action: outcome.ok ? "publish_request_approved" : "publish_request_failed",
        target: id,
        detail: `${row.kind} · ${row.summary}${outcome.ok ? "" : ` · ${outcome.error || "ล้มเหลว"}`}`,
      });
      // คำขอแก้ความรู้ที่ค้างจนข้อมูลตั้งต้นเปลี่ยน ต้องจบเป็นผลตัดสินที่เห็นได้
      // และตอบ 409 ให้เจ้าของรู้ว่าไม่ได้เขียนทับของใหม่ ไม่ใช่ 200 ที่อ่านเหมือนอนุมัติแล้ว.
      const staleKnowledge = outcome.status === 409 && outcome.payload?.staleKnowledge === true;
      json(res, staleKnowledge ? 409 : 200, {
        ok: !staleKnowledge,
        applied: outcome.ok === true,
        ...(staleKnowledge ? { staleKnowledge: true } : {}),
        ...(outcome.ok ? {} : { error: outcome.error || "เล่นคำขอซ้ำไม่สำเร็จ" }),
        request: publicPublishRequest(settled),
      });
      return true;
    }

    return false;
  }

  return { handle };
}
