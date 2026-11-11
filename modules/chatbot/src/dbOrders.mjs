// dbOrders.mjs — เมธอด DB ของระบบออเดอร์ (G6 P2) — แยกไฟล์คุม db.mjs <800 บรรทัด
// ตาราง orders อยู่ใน schema.mjs; กติกา status flow อยู่ orders.mjs (canTransition)
// ทุก SELECT ดึง rowid AS order_no = เลขออเดอร์ที่คนอ่าน (#N) — id จริงเป็น UUID
import { randomUUID } from "node:crypto";

// สถานะ "ยังไม่จบ" ที่ต้องโชว์ในแผงข้อมูลลูกค้า (จบ/ยกเลิก = ประวัติ ไม่ใช่งานค้าง)
const OPEN_STATUSES = "('draft','confirmed','paid','shipped')";
// สถานะที่นับเป็นยอดขาย (ยืนยันแล้วขึ้นไป — ร่าง/ยกเลิกไม่นับ)
const REVENUE_STATUSES = "('confirmed','paid','shipped','done')";

// join customers เพื่อได้ชื่อที่คนอ่านรู้เรื่อง — ลูกค้า canary ไม่ปนทุก query รายการ
const ORDER_SELECT = `
  SELECT o.rowid AS order_no, o.id, o.customer_id, o.channel_id, o.items_json,
         o.total, o.status, o.note, o.shipping_json, o.shipping_source, o.class_round_json, o.slip_check_id, o.created_by,
         o.created_at, o.updated_at,
         c.display_name, c.known_name
  FROM orders o LEFT JOIN customers c ON c.line_user_id = o.customer_id`;

// v1.1: สถานะที่ยังแก้ข้อมูลจัดส่งได้ — ก่อนของออกจากมือเรา (จัดส่งแล้ว = ที่อยู่ต้องนิ่ง)
const SHIPPING_EDITABLE = "('draft','confirmed','paid')";

export function createOrderDbMethods({ run, all, get, now, dayStartMs = () => 0, monthStartMs = () => 0 }) {
  return {
    /* ------------------------------- CRUD ------------------------------- */

    createOrder({ customerId, channelId = "default", items = [], total = null, note = "", shipping = null, shippingSource = "", createdBy = "", status = "draft" } = {}) {
      const id = randomUUID();
      const t = now();
      run(
        `INSERT INTO orders (id, customer_id, channel_id, items_json, total, status, note, shipping_json, shipping_source, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, String(customerId), String(channelId || "default"), JSON.stringify(items ?? []),
        total == null ? null : Number(total), String(status), String(note).slice(0, 500),
        shipping ? JSON.stringify(shipping) : "",
        shipping ? String(shippingSource || "human") : "",
        String(createdBy), t, t
      );
      return this.getOrder(id);
    },

    getOrder(id) {
      return get(`${ORDER_SELECT} WHERE o.id = ?`, String(id)) ?? null;
    },

    // รายการหน้า "ออเดอร์" — ใหม่สุด (ความเคลื่อนไหวล่าสุด) ขึ้นก่อน
    listOrders({ status = null, channel = null, limit = 50, offset = 0 } = {}) {
      const where = ["o.customer_id NOT LIKE 'canary:%'"];
      const params = [];
      if (status) {
        where.push("o.status = ?");
        params.push(String(status));
      }
      if (channel) {
        where.push("o.channel_id = ?");
        params.push(String(channel));
      }
      return all(
        `${ORDER_SELECT} WHERE ${where.join(" AND ")}
         ORDER BY o.updated_at DESC, o.rowid DESC LIMIT ? OFFSET ?`,
        ...params, Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 50)),
        Math.max(0, Math.trunc(Number(offset)) || 0)
      );
    },

    // ตัวเลขบน chip กรองสถานะ — นับจาก SQL ทั้งตารางเสมอ (list เป็นแค่หน้าเดียว)
    orderCounts(channel = null) {
      const params = [];
      let chWhere = "";
      if (channel) {
        chWhere = " AND channel_id = ?";
        params.push(String(channel));
      }
      const row = get(
        `SELECT COUNT(*) AS all_n,
                SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft_n,
                SUM(CASE WHEN status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_n,
                SUM(CASE WHEN status = 'paid' THEN 1 ELSE 0 END) AS paid_n,
                SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) AS shipped_n,
                SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done_n,
                SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_n
         FROM orders WHERE customer_id NOT LIKE 'canary:%'${chWhere}`,
        ...params
      ) || {};
      const n = (v) => Number(v) || 0;
      return {
        all: n(row.all_n), draft: n(row.draft_n), confirmed: n(row.confirmed_n),
        paid: n(row.paid_n), shipped: n(row.shipped_n), done: n(row.done_n),
        cancelled: n(row.cancelled_n),
      };
    },

    // ออเดอร์ค้างของลูกค้าหนึ่งคน (แผงข้อมูลข้างห้องแชท)
    listOpenOrdersFor(customerId, limit = 5) {
      return all(
        `${ORDER_SELECT} WHERE o.customer_id = ? AND o.status IN ${OPEN_STATUSES}
         ORDER BY o.created_at DESC, o.rowid DESC LIMIT ?`,
        String(customerId), Math.min(20, Math.max(1, Number(limit) || 5))
      );
    },

    // ร่างค้างล่าสุด — AI ห้ามสร้างร่างซ้ำถ้ายังมีร่างเดิมอยู่ (orders.mjs ใช้เช็ค)
    openDraftOrder(customerId) {
      return get(
        `${ORDER_SELECT} WHERE o.customer_id = ? AND o.status = 'draft'
         ORDER BY o.created_at DESC, o.rowid DESC LIMIT 1`,
        String(customerId)
      ) ?? null;
    },

    // ออเดอร์ที่ยืนยันแล้วรอจ่าย — จุดจับคู่ผลตรวจสลิป (slipCheck.mjs)
    openConfirmedOrder(customerId) {
      return get(
        `${ORDER_SELECT} WHERE o.customer_id = ? AND o.status = 'confirmed'
         ORDER BY o.created_at DESC, o.rowid DESC LIMIT 1`,
        String(customerId)
      ) ?? null;
    },

    // แก้รายการ/ยอด/โน้ตได้เฉพาะตอนยังเป็นร่าง — ยืนยันแล้วตัวเลขต้องนิ่ง
    updateOrderDraft(id, { items, total, note } = {}) {
      const row = this.getOrder(id);
      if (!row || row.status !== "draft") return false;
      return run(
        "UPDATE orders SET items_json = ?, total = ?, note = ?, updated_at = ? WHERE id = ? AND status = 'draft'",
        JSON.stringify(items ?? JSON.parse(row.items_json || "[]")),
        total === undefined ? row.total : (total == null ? null : Number(total)),
        typeof note === "string" ? note.slice(0, 500) : row.note,
        now(), String(id)
      ).changes === 1;
    },

    // v1.1: แก้ข้อมูลจัดส่งได้ถึงก่อนของออก (draft/confirmed/paid) — คนละเรื่องกับ
    // ตัวเลขเงินที่นิ่งหลังยืนยัน; shipping = null ล้างข้อมูล (ตั้งใจ — ลูกค้าขอรับหน้าร้าน)
    // REVIEW FIX: source บอกว่าใครเขียนล่าสุด — 'human' (console) ชนะ 'ai' (scorer) เสมอ:
    // การเขียนแบบ 'ai' จะไม่ทับแถวที่ shipping_source = 'human' (SQL guard ชั้นเดียวจบ กัน race)
    updateOrderShipping(id, shipping, source = "human") {
      const guard = source === "ai" ? " AND shipping_source != 'human'" : "";
      return run(
        `UPDATE orders SET shipping_json = ?, shipping_source = ?, updated_at = ?
         WHERE id = ? AND status IN ${SHIPPING_EDITABLE}${guard}`,
        shipping ? JSON.stringify(shipping) : "", shipping ? String(source) : "",
        now(), String(id)
      ).changes === 1;
    },

    // 7 ต.ค. 2026 โหมดคลาส: ผูกรอบเรียนได้ถึงก่อนจบ (draft/confirmed/paid) — null = ล้าง
    updateOrderClassRound(id, round) {
      return run(
        `UPDATE orders SET class_round_json = ?, updated_at = ? WHERE id = ? AND status IN ${SHIPPING_EDITABLE}`,
        round ? JSON.stringify(round) : "", now(), String(id),
      ).changes === 1;
    },

    // เปลี่ยนสถานะแบบ compare-and-swap — from ไม่ตรงของจริง = ไม่เปลี่ยน (กัน race สองแท็บ)
    setOrderStatus(id, from, to) {
      const ok = run(
        "UPDATE orders SET status = ?, updated_at = ? WHERE id = ? AND status = ?",
        String(to), now(), String(id), String(from)
      ).changes === 1;
      // audit 2026-08-24: ออเดอร์เดินถึงขั้นมีเงินจริง = ปักธงถาวรที่ลูกค้า เพื่อให้คำถาม
      // ใบกำกับ/ใบเสร็จหลังจากนี้ถูกส่งต่อคนเสมอ แม้ handoff_summary จะถูกตัดทิ้งไปแล้ว
      if (ok && ["confirmed", "paid", "shipped", "done"].includes(String(to))) {
        run(
          `UPDATE customers SET money_seen_at = ?, updated_at = ?
             WHERE money_seen_at = 0
               AND line_user_id = (SELECT customer_id FROM orders WHERE id = ?)`,
          now(), now(), String(id)
        );
      }
      return ok;
    },

    attachSlipToOrder(id, slipCheckId) {
      return run(
        "UPDATE orders SET slip_check_id = ?, updated_at = ? WHERE id = ?",
        String(slipCheckId), now(), String(id)
      ).changes === 1;
    },

    /* ------------------------------- stats ------------------------------- */

    // การ์ดหน้า "ภาพรวม": ออเดอร์วันนี้ (ไม่นับยกเลิก) + ยอดขายเดือนนี้ (ยืนยันแล้วขึ้นไป)
    orderStats(channel = null) {
      const t = now();
      const params = [];
      let chWhere = "";
      if (channel) {
        chWhere = " AND channel_id = ?";
        params.push(String(channel));
      }
      const today = get(
        `SELECT COUNT(*) AS n FROM orders
         WHERE created_at >= ? AND status != 'cancelled' AND customer_id NOT LIKE 'canary:%'${chWhere}`,
        dayStartMs(t), ...params
      );
      const month = get(
        `SELECT COUNT(*) AS n, SUM(total) AS sum_total FROM orders
         WHERE created_at >= ? AND status IN ${REVENUE_STATUSES} AND customer_id NOT LIKE 'canary:%'${chWhere}`,
        monthStartMs(t), ...params
      );
      const drafts = get(
        `SELECT COUNT(*) AS n FROM orders
         WHERE status = 'draft' AND customer_id NOT LIKE 'canary:%'${chWhere}`,
        ...params
      );
      return {
        todayCount: Number(today?.n) || 0,
        monthRevenue: Number(month?.sum_total) || 0,
        monthConfirmedCount: Number(month?.n) || 0,
        openDrafts: Number(drafts?.n) || 0,
      };
    },

    // G7.1: ตัวเลขออเดอร์สำหรับ Owner Daily Digest — "ใหม่" นับจาก created_at,
    // "ยืนยัน/จ่ายแล้ว" นับสถานะปัจจุบันที่ขยับในช่วง (updated_at) — ตัวเลขจาก DB ล้วน
    orderDigestStats(sinceMs = 0) {
      const since = Number(sinceMs) || 0;
      const n = (sql, ...params) => get(sql, ...params)?.n ?? 0;
      return {
        created: n(
          "SELECT COUNT(*) AS n FROM orders WHERE created_at >= ? AND customer_id NOT LIKE 'canary:%'",
          since
        ),
        confirmed: n(
          "SELECT COUNT(*) AS n FROM orders WHERE status = 'confirmed' AND updated_at >= ? AND customer_id NOT LIKE 'canary:%'",
          since
        ),
        paid: n(
          "SELECT COUNT(*) AS n FROM orders WHERE status = 'paid' AND updated_at >= ? AND customer_id NOT LIKE 'canary:%'",
          since
        ),
        revenue: Number(get(
          `SELECT SUM(total) AS s FROM orders
           WHERE status IN ${REVENUE_STATUSES} AND updated_at >= ? AND customer_id NOT LIKE 'canary:%'`,
          since
        )?.s) || 0,
      };
    },

    /* ------------------------------- export ------------------------------- */

    // keyset pagination แบบเดียวกับ exportMessagesBatch — ไม่ใช้ OFFSET ชุดใหญ่
    exportOrdersBatch({ channel = null, sinceMs = 0, untilMs = null, afterCreatedAt = -1, afterRowid = -1, limit = 500 } = {}) {
      const where = ["o.customer_id NOT LIKE 'canary:%'"];
      const params = [];
      if (channel) {
        where.push("o.channel_id = ?");
        params.push(String(channel));
      }
      if (Number(sinceMs) > 0) {
        where.push("o.created_at >= ?");
        params.push(Number(sinceMs));
      }
      if (untilMs != null) {
        where.push("o.created_at < ?");
        params.push(Number(untilMs));
      }
      where.push("(o.created_at > ? OR (o.created_at = ? AND o.rowid > ?))");
      params.push(Number(afterCreatedAt), Number(afterCreatedAt), Number(afterRowid));
      return all(
        `${ORDER_SELECT} WHERE ${where.join(" AND ")}
         ORDER BY o.created_at ASC, o.rowid ASC LIMIT ?`,
        ...params, Math.min(2000, Math.max(1, Number(limit) || 500))
      );
    },
  };
}
