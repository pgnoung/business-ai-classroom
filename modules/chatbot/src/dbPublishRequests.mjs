// dbPublishRequests.mjs — เมธอด DB ของคิว "ขออนุมัติเผยแพร่" (Package K)
// ตาราง publish_requests อยู่ใน schema.mjs; ตัวตัดสินใจว่าเส้นไหนเข้าคิว + ตัวเล่นซ้ำ
// อยู่ใน consolePublishQueueApi.mjs — ไฟล์นี้รู้แค่ "เก็บ/อ่าน/เปลี่ยนสถานะ" เท่านั้น
//
// ทำไมต้องมี claim แยกจาก status (บั๊กที่กันไว้ตั้งแต่ยังไม่เกิด):
//   อนุมัติ = เล่นคำขอเดิมซ้ำผ่าน handler ตัวจริง ซึ่งเป็น async มี await คั่นกลาง
//   ถ้าเช็ค "ยัง pending อยู่ไหม" แล้วค่อยเล่นซ้ำ สองคำขอที่กดพร้อมกันจะผ่านด่านทั้งคู่
//   แล้วเขียนของลงไปสองรอบ (ราคาซ้ำ / ความรู้ซ้ำใบ) — จองสิทธิ์ด้วย UPDATE เงื่อนไข
//   เดียวก่อนเสมอ เพราะ UPDATE หนึ่งคำสั่งของ SQLite เป็น atomic
import { randomUUID } from "node:crypto";

export const PUBLISH_SUMMARY_MAX = 200;
export const PUBLISH_LIST_MAX = 200;
export const PUBLISH_STATUSES = Object.freeze(["pending", "approved", "rejected", "failed"]);
// K2 (2 ก.ย. 2026): "ตัดสินไปแล้ว" ทั้งสามแบบรวมเป็นก้อนเดียว — คนเสนอต้องเห็นผลของใบ
// ที่หายไปจากคิว ไม่ใช่ต้องเดาว่าจบลงแบบไหน (ใบที่ล้มเงียบ = งานหายรอบสอง)
export const PUBLISH_DECIDED_STATUSES = Object.freeze(["approved", "rejected", "failed"]);
// ค่าที่เส้น list รับได้ทั้งหมด (ไว้ให้ฝั่ง API ตรวจ query ด้วยทะเบียนเดียวกับที่นี่)
export const PUBLISH_LIST_FILTERS = Object.freeze([...PUBLISH_STATUSES, "decided", "all"]);

// เก็บ JSON ที่ปั้นไม่ได้ (circular/undefined) เป็นสตริงว่าง ดีกว่าโยนทิ้งทั้งคำขอ
function toJson(value, fallback) {
  try {
    const text = JSON.stringify(value);
    return typeof text === "string" ? text : fallback;
  } catch {
    return fallback;
  }
}

function fromJson(text, fallback) {
  try {
    const parsed = JSON.parse(String(text || ""));
    return parsed === null || parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

// รูปที่หน้าเว็บใช้ — จงใจ "แปลงแล้ว" ตั้งแต่ชั้น DB เพื่อไม่ให้ทุกหน้าต้อง JSON.parse เอง
export function publicPublishRequest(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    method: row.method,
    route: fromJson(row.route_json, []),
    body: fromJson(row.body_json, {}),
    summary: row.summary || "",
    proposedBy: row.proposed_by || "",
    // pending_ack = pending ที่ติดค้างอยู่กับรุ่นสมองที่รอเจ้าของรับทราบ — สถานะที่หน้าเว็บ
    // ต้องเห็นแยกจาก "รออนุมัติ" ธรรมดา (คนเสนอไม่ต้องรออะไรเพิ่ม เจ้าของต้องไปกดรับทราบ)
    status: row.awaiting_version_id ? "pending_ack" : row.status,
    // คีย์นี้โผล่เฉพาะเมื่อมีของจริงให้รอ — ตอนแฟล็กปิดไม่มีทางมีค่า รูป payload จึงเท่ากับ base
    ...(row.awaiting_version_id ? { awaitingVersionId: row.awaiting_version_id } : {}),
    decidedBy: row.decided_by || "",
    decidedAt: row.decided_at ?? null,
    decisionNote: row.decision_note || "",
    result: row.result_json ? fromJson(row.result_json, null) : null,
    createdAt: row.created_at,
  };
}

export function createPublishRequestDbMethods({ run, all, get, now }) {
  return {
    addPublishRequest({ kind, method, route = [], body = {}, summary = "", proposedBy = "" } = {}) {
      const id = randomUUID();
      run(
        `INSERT INTO publish_requests
           (id, kind, method, route_json, body_json, summary, proposed_by, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        id, String(kind), String(method).toUpperCase(),
        toJson(Array.isArray(route) ? route.map(String) : [], "[]"),
        toJson(body && typeof body === "object" ? body : {}, "{}"),
        String(summary).slice(0, PUBLISH_SUMMARY_MAX), String(proposedBy), now(),
      );
      return this.getPublishRequest(id);
    },

    getPublishRequest(id) {
      return get("SELECT * FROM publish_requests WHERE id = ?", String(id)) ?? null;
    },

    // ใหม่สุดขึ้นก่อนเสมอ — เจ้าของเปิดมาต้องเจอของที่เพิ่งขอมาทันที
    // proposedBy = กรองเป็นของคนคนเดียว (ทีมงานเห็นเฉพาะคำขอตัวเอง ไม่เห็นของคนอื่น)
    // since = มิลลิวินาที "ตั้งแต่เมื่อไร" (หน้าเว็บส่งหน้าต่าง 7 วันมา) — ไม่ส่ง = ไม่จำกัด
    listPublishRequests({ status = "pending", proposedBy = null, limit = 50, since = null } = {}) {
      const clauses = [];
      const params = [];
      const decided = status === "decided";
      if (decided) {
        clauses.push(`status IN (${PUBLISH_DECIDED_STATUSES.map(() => "?").join(", ")})`);
        params.push(...PUBLISH_DECIDED_STATUSES);
      } else if (status && status !== "all") {
        if (!PUBLISH_STATUSES.includes(status)) return [];
        clauses.push("status = ?");
        params.push(status);
      }
      if (proposedBy) {
        clauses.push("proposed_by = ?");
        params.push(String(proposedBy));
      }
      // หลักเวลาของรายการที่ตัดสินแล้วคือ "ตัดสินเมื่อไร" ไม่ใช่ "ขอมาเมื่อไร" —
      // ใบที่เสนอไว้สองสัปดาห์ก่อนแต่เพิ่งถูกตัดสินวันนี้ ต้องอยู่บนสุด ไม่ใช่ตกขอบ
      // หน้าต่าง 7 วันไปเงียบ ๆ ซึ่งคือบั๊กเดิมที่ K2 ตั้งใจปิดพอดี
      // (timeCol มาจาก boolean ในโค้ด ไม่ใช่ค่าจากผู้ใช้ จึงต่อเป็นสตริงได้อย่างปลอดภัย)
      const timeCol = decided ? "COALESCE(decided_at, created_at)" : "created_at";
      const sinceMs = Math.trunc(Number(since));
      if (Number.isFinite(sinceMs) && sinceMs > 0) {
        clauses.push(`${timeCol} >= ?`);
        params.push(sinceMs);
      }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const capped = Math.min(PUBLISH_LIST_MAX, Math.max(1, Math.trunc(Number(limit)) || 50));
      return all(
        `SELECT * FROM publish_requests ${where} ORDER BY ${timeCol} DESC, rowid DESC LIMIT ?`,
        ...params, capped,
      );
    },

    countPendingPublishRequests(proposedBy = null) {
      const row = proposedBy
        ? get("SELECT COUNT(*) AS n FROM publish_requests WHERE status = 'pending' AND proposed_by = ?", String(proposedBy))
        : get("SELECT COUNT(*) AS n FROM publish_requests WHERE status = 'pending'");
      return Number(row?.n || 0);
    },

    // จองสิทธิ์เล่นซ้ำ — คืน true ได้ครั้งเดียวต่อคำขอหนึ่งใบเท่านั้น
    // เงื่อนไข claimed_at = 0 อยู่ใน UPDATE เดียวกัน จึงไม่มีช่องว่างระหว่าง "อ่าน" กับ "เขียน"
    claimPublishRequest(id, { decidedBy = "" } = {}) {
      return run(
        `UPDATE publish_requests SET claimed_at = ?, decided_by = ?
          WHERE id = ? AND status = 'pending' AND claimed_at = 0`,
        now(), String(decidedBy), String(id),
      ).changes === 1;
    },

    // ปิดคำขอ — ใช้ทั้งเส้นอนุมัติสำเร็จ (approved), เล่นซ้ำแล้วพัง (failed) และปฏิเสธ (rejected)
    // คำขอที่เล่นซ้ำแล้วได้ "รอรับทราบ": คืนสิทธิ์กดให้ (claimed_at = 0) แล้วผูกไว้กับรุ่นนั้น
    // ถ้าปล่อยให้จบเป็น failed คนเสนอจะเห็นคำขอหายไปอยู่ในกองที่ล้มเหลว ทั้งที่ของยังรออยู่จริง
    parkPublishRequest(id, { versionId, note = "" } = {}) {
      run(
        `UPDATE publish_requests
            SET claimed_at = 0, awaiting_version_id = ?, decision_note = ?
          WHERE id = ? AND status = 'pending'`,
        String(versionId || ""), String(note).slice(0, PUBLISH_SUMMARY_MAX), String(id),
      );
      return this.getPublishRequest(id);
    },

    // รุ่นที่รออยู่ถูกตัดสินแล้ว (รับทราบ/ปัดตก) — ปลดคำขอที่ผูกไว้กับรุ่นนั้นทุกใบ
    releaseParkedPublishRequests(versionId, { status, decidedBy = "", note = "" } = {}) {
      if (!PUBLISH_STATUSES.includes(status)) return 0;
      const rows = all(
        "SELECT id FROM publish_requests WHERE awaiting_version_id = ? AND status = 'pending'",
        String(versionId),
      );
      for (const row of rows) {
        run(
          `UPDATE publish_requests
              SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, awaiting_version_id = ''
            WHERE id = ?`,
          status, String(decidedBy), now(), String(note).slice(0, PUBLISH_SUMMARY_MAX), row.id,
        );
      }
      return rows.length;
    },

    /**
     * ตัดสินแล้ว = ข้อความที่คนพิมพ์ในจอสอนหมดหน้าที่ (PDPA §5 ข้อ 3)
     *
     * แถวคำขออยู่ในฐานต่อไปเพื่อเป็นประวัติว่าใครขออะไรและใครตัดสิน — แต่ `teach.correct_text`
     * ซึ่งเป็นคำตอบที่เขียนถึงลูกค้ารายหนึ่ง ไม่มีเหตุผลให้อยู่ต่อหลังจากนั้น
     * เรียกทุกทางที่คำขอจบชีวิต (อนุมัติ / ปฏิเสธ / ล้ม / ปลดจากรุ่นที่ถูกปัดตก)
     */
    scrubPublishRequestTeachText(id) {
      const row = this.getPublishRequest(id);
      if (!row) return false;
      let body = null;
      try { body = JSON.parse(String(row.body_json || "null")); } catch { body = null; }
      if (!body || typeof body !== "object" || !body.teach || typeof body.teach !== "object") return false;
      if (!("correct_text" in body.teach) && !("correctText" in body.teach)) return false;
      const teach = { ...body.teach };
      delete teach.correct_text;
      delete teach.correctText;
      teach.correct_text_cleared = true;
      run("UPDATE publish_requests SET body_json = ? WHERE id = ?",
        toJson({ ...body, teach }, row.body_json), String(id));
      return true;
    },

    settlePublishRequest(id, { status, decidedBy = "", note = "", result = null } = {}) {
      if (!PUBLISH_STATUSES.includes(status)) return null;
      // ล้าง awaiting_version_id ทุกครั้งที่ตัดสิน: แถวที่จบแล้วแต่ยังถือเลขรุ่นไว้ จะรายงาน
      // ตัวเองว่า pending_ack ตลอดกาล — คนเสนอเห็นของค้างที่ไม่มีอยู่จริงและรอไปเรื่อย ๆ
      run(
        `UPDATE publish_requests
            SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, result_json = ?,
                awaiting_version_id = ''
          WHERE id = ?`,
        status, String(decidedBy), now(), String(note).slice(0, PUBLISH_SUMMARY_MAX),
        result === null ? "" : toJson(result, ""), String(id),
      );
      return this.getPublishRequest(id);
    },

    // ปฏิเสธ = ตัดสินใจอย่างเดียว ไม่แตะของจริงเลย — ต้องยังเป็น pending ที่ยังไม่ถูกจอง
    rejectPublishRequest(id, { decidedBy = "", note = "" } = {}) {
      const changed = run(
        `UPDATE publish_requests
            SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?,
                awaiting_version_id = ''
          WHERE id = ? AND status = 'pending' AND claimed_at = 0`,
        String(decidedBy), now(), String(note).slice(0, PUBLISH_SUMMARY_MAX), String(id),
      ).changes === 1;
      return changed ? this.getPublishRequest(id) : null;
    },
  };
}
