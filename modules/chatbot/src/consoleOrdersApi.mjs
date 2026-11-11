// consoleOrdersApi.mjs — เส้นทาง /console/api/orders* (G6 P2)
// แยกจาก consoleApi.mjs เพื่อคุมขนาดไฟล์ <800 บรรทัด — session ถูกตรวจก่อนถึงตรงนี้แล้ว
// (ctx.requireCsrf ผูกกับ session ของ request นั้น ๆ) ทุก mutation มี audit row เสมอ
//
// กติกา human-confirms-money: ทุกการเปลี่ยนสถานะเป็นการกดของคนใน console เท่านั้น
// (AI สร้างได้แค่ draft จาก pipeline) — webhook ยิง fire-and-forget ตอน confirmed/paid
import { canTransition, normalizeOrderItems, ORDER_STATUSES } from "./orders.mjs";
import { normalizeShipping, parseShippingJson } from "./shipping.mjs";
import { normalizeClassRound, orderInfoWarnings, orderMode, parseClassRound } from "./orderMode.mjs";
import { upcomingRounds } from "./classRounds.mjs";
import { refreshRfmTags } from "./tags.mjs";
import { activeTagFramework } from "./tagFrameworkMode.mjs";
import { csvField, fmtBangkok, bangkokMonthRangeMs } from "./exportCsv.mjs";

const ORDER_NOTE_MAX = 500;
const STATUS_SET = new Set(ORDER_STATUSES);

const ORDERS_CSV_HEADER = [
  "วันที่สร้าง", "เลขออเดอร์", "ลูกค้า", "user_id", "สถานะ", "รายการ",
  "ยอดรวม", "ผู้รับ", "เบอร์ผู้รับ", "ที่อยู่จัดส่ง", "อีเมล",
  "สลิป", "ผู้สร้าง", "โน้ต", "สาขา",
];

// v1.1: แนบ shipping ที่ parse แล้ว + warning สด ๆ ไปกับทุก order ที่ console เห็น
// (คำนวณตอนอ่านเสมอ — กติกาตรวจอัปเดตแล้วออเดอร์เก่าได้ผลใหม่ทันที ไม่มีค่าค้าง)
// 7 ต.ค. 2026: โหมดคลาส (orderMode.mjs) — ตรวจแค่เบอร์/อีเมลผู้เรียน + แนบรอบเรียนที่ผูกไว้
function withShipping(order, mode = "shipping") {
  if (!order) return order;
  const shipping = parseShippingJson(order.shipping_json);
  return { ...order, shipping, shippingWarnings: orderInfoWarnings(shipping, mode), classRound: parseClassRound(order.class_round_json) };
}

const STATUS_TH_SHIPPING = {
  draft: "ร่าง", confirmed: "ยืนยันแล้ว", paid: "จ่ายแล้ว",
  shipped: "จัดส่งแล้ว", done: "จบ", cancelled: "ยกเลิก",
};
const STATUS_TH_CLASS = {
  draft: "ร่าง", confirmed: "ยืนยันแล้ว · รอชำระ", paid: "ชำระแล้ว",
  shipped: "จัดส่งแล้ว", done: "ลงทะเบียนเรียนแล้ว", cancelled: "ยกเลิก",
};
const statusTh = (mode) => (mode === "class" ? STATUS_TH_CLASS : STATUS_TH_SHIPPING);
const FLOW_TH = {
  shipping: "ร่าง → ยืนยัน → จ่าย → จัดส่ง → จบ",
  class: "ร่าง → ยืนยันออเดอร์ → ชำระแล้ว → ลงทะเบียนเรียนแล้ว",
};

function itemsLabel(itemsJson) {
  try {
    return (JSON.parse(itemsJson || "[]") || [])
      .map((it) => `${it.name} x${it.qty}${Number.isFinite(it.price) ? ` (฿${it.price})` : ""}`)
      .join("; ");
  } catch {
    return "";
  }
}

function customerLabel(row) {
  return row.known_name || row.display_name || `ลูกค้า ${String(row.customer_id).slice(-6)}`;
}

export function createOrdersRoutes({ db, config, channelLabel = (id) => String(id || "default"), orderWebhook = null, now = Date.now, logger = console, tagFramework = null, metaCapi = null }) {
  // ป้าย RFM ของลูกค้า — กรอบป้ายเปิดอยู่ = ซื้อครั้งที่/ซื้อล่าสุด (อ่านสวิตช์สดทุกครั้ง)
  const refreshTags = (customerId) => refreshRfmTags(db, customerId, { logger, framework: activeTagFramework(db, tagFramework) });
  // ยิง webhook ตอน confirmed/paid — fire-and-forget ล้วน ๆ (ห้าม block/ห้ามล้ม response)
  function fireWebhook(order) {
    if (!orderWebhook?.enabled) return;
    if (order.status !== "confirmed" && order.status !== "paid") return;
    setTimeout(() => {
      orderWebhook.fireStatusChange({
        order,
        customerName: customerLabel(order),
        channelName: channelLabel(order.channel_id),
      }).catch((err) => {
        logger.debug?.(`orderWebhook: ${err?.message || err}`);
      });
    }, 0);
  }

  // โหมดคลาส: ให้ตาราง enrollments ตรงกับออเดอร์เสมอ — ชำระแล้ว/ลงทะเบียนแล้ว + มีรอบ = มีแถว "enrolled" ของรอบนั้นหนึ่งแถว
  // เปลี่ยนรอบ/ล้างรอบ/ยกเลิกออเดอร์ = ยกเลิกแถวที่ออเดอร์นี้สร้าง · ลูกค้าลงรอบเดียวกันไว้แล้ว (ทีมกรอกเอง) = ไม่สร้างซ้ำ
  // แถวที่ออเดอร์สร้างจำได้จาก confirmed_by ที่ลงท้าย "· order:<id>" (ตารางไม่มีคอลัมน์ order_id)
  function syncEnrollment(order, username) {
    if (!order) return;
    try {
      const marker = `order:${order.id}`;
      const round = ["paid", "done"].includes(order.status) ? parseClassRound(order.class_round_json) : null;
      const rows = db.listEnrollments(order.customer_id);
      const mine = rows.filter((row) => row.status === "enrolled" && String(row.confirmed_by || "").endsWith(marker));
      const matches = (row) => round && row.course_id === round.classKey && row.round_date === round.date;
      for (const row of mine) {
        if (!matches(row)) db.setEnrollmentStatus(row.id, "cancelled");
      }
      if (!round || rows.some((row) => row.status === "enrolled" && matches(row))) return;
      db.addEnrollment({
        customerId: order.customer_id, courseId: round.classKey, roundDate: round.date,
        confirmedBy: `${String(username).slice(0, 40)} · ${marker}`,
      });
      db.addAudit({ operator: username, action: "enrollment_from_order", target: order.customer_id, detail: `#${order.order_no} ${round.classKey} ${round.date}` });
    } catch (err) {
      logger.warn?.(`orders: ซิงก์ผู้เรียนจากออเดอร์ #${order.order_no} ไม่สำเร็จ (${err?.message || err})`);
    }
  }

  function safeUpcomingRounds() {
    try {
      const todayIso = new Date(now() + 7 * 3_600_000).toISOString().slice(0, 10);
      return upcomingRounds({ file: config?.classRoundsFile, db, todayIso, logger })
        .map((r) => ({ date: r.date, classKey: r.classKey, label: r.label, thai: r.thai }));
    } catch {
      return [];
    }
  }

  // คืน true = จัดการ route แล้ว / false = ไม่ใช่ของส่วนนี้
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "orders") return false;
    const { readJson, json, username, requireCsrf, parseChannelParam } = ctx;
    const mode = orderMode(db);
    const STATUS_TH = statusTh(mode);
    const shape = (order) => withShipping(order, mode);

    /* ---- GET /orders — รายการ + ตัวนับต่อสถานะ (chip กรอง) ---- */
    if (req.method === "GET" && route.length === 1) {
      const status = url.searchParams.get("status") || "";
      if (status && !STATUS_SET.has(status)) {
        json(res, 400, { ok: false, error: "status ไม่อยู่ในรายการสถานะออเดอร์" });
        return true;
      }
      const chParam = parseChannelParam(url);
      if (!chParam.ok) {
        json(res, 400, { ok: false, error: "channel ไม่อยู่ในรายการสาขา" });
        return true;
      }
      const limit = Math.min(100, Math.max(1, Math.trunc(Number(url.searchParams.get("limit"))) || 30));
      const offset = Math.max(0, Math.trunc(Number(url.searchParams.get("offset"))) || 0);
      const rows = db.listOrders({ status: status || null, channel: chParam.channel, limit: limit + 1, offset });
      const hasMore = rows.length > limit;
      json(res, 200, {
        ok: true,
        orders: (hasMore ? rows.slice(0, limit) : rows).map(shape),
        counts: db.orderCounts(chParam.channel),
        hasMore, limit, offset,
        channel: chParam.channel,
        orderMode: mode,
        // โหมดคลาส: รอบที่ยังเปิด (หน้า "ที่นั่ง" ชนะไฟล์) ให้เลือกผูกกับออเดอร์ — อ่านพัง = []
        classRounds: mode === "class" ? safeUpcomingRounds() : [],
      });
      return true;
    }

    /* ---- GET /orders/export — CSV (แบบแผนเดียวกับ export แชท: BOM + formula-safe) ---- */
    if (req.method === "GET" && route[1] === "export" && route.length === 2) {
      const chParam = parseChannelParam(url);
      if (!chParam.ok) {
        json(res, 400, { ok: false, error: "channel ไม่อยู่ในรายการสาขา" });
        return true;
      }
      const month = url.searchParams.get("month") || "";
      let sinceMs = 0;
      let untilMs = null;
      if (month) {
        const range = bangkokMonthRangeMs(month);
        if (!range) {
          json(res, 400, { ok: false, error: "month ต้องเป็นรูปแบบ YYYY-MM" });
          return true;
        }
        sinceMs = range.sinceMs;
        untilMs = range.untilMs;
      }
      const stampDate = new Date(now() + 7 * 3_600_000);
      const pad = (n) => String(n).padStart(2, "0");
      const stamp = `${stampDate.getUTCFullYear()}${pad(stampDate.getUTCMonth() + 1)}${pad(stampDate.getUTCDate())}`;
      const chPart = chParam.channel ? `-${String(chParam.channel).replace(/[^a-zA-Z0-9_-]/g, "")}` : "";
      res.writeHead(200, {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="orders${chPart}-${month || "all"}-${stamp}.csv"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      res.write("\uFEFF" + ORDERS_CSV_HEADER.map(csvField).join(",") + "\r\n");
      let rows = 0;
      let afterCreatedAt = -1;
      let afterRowid = -1;
      for (;;) {
        const batch = db.exportOrdersBatch({ channel: chParam.channel, sinceMs, untilMs, afterCreatedAt, afterRowid, limit: 500 });
        if (batch.length === 0) break;
        res.write(batch.map((o) => {
          const ship = parseShippingJson(o.shipping_json) || {};
          return [
            fmtBangkok(o.created_at), `#${o.order_no}`, customerLabel(o), o.customer_id,
            STATUS_TH[o.status] || o.status, itemsLabel(o.items_json),
            o.total == null ? "" : o.total,
            ship.name || "", ship.phone || "", ship.address || "", ship.email || "",
            o.slip_check_id ? "แนบแล้ว" : "",
            o.created_by, o.note, channelLabel(o.channel_id),
          ].map(csvField).join(",") + "\r\n";
        }).join(""));
        rows += batch.length;
        const last = batch[batch.length - 1];
        afterCreatedAt = last.created_at;
        afterRowid = last.order_no;
        if (batch.length < 500) break;
      }
      res.end();
      db.addAudit({
        operator: username, action: "orders_export",
        detail: `month=${month || "all"}${chParam.channel ? ` channel=${chParam.channel}` : ""} rows=${rows}`,
      });
      return true;
    }

    /* ---- POST /orders — แอดมินสร้างร่างเอง (จากแผงข้อมูลลูกค้า/หน้าออเดอร์) ---- */
    if (req.method === "POST" && route.length === 1) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const body = await readJson(req);
      const customerId = String(body.customerId || "");
      const customer = customerId ? db.getCustomer(customerId) : null;
      if (!customer) {
        json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
        return true;
      }
      const items = body.items === undefined ? [] : normalizeOrderItems(body.items);
      if (items === null) {
        json(res, 400, { ok: false, error: "items ไม่ถูกต้อง (name 1-100 ตัวอักษร, qty 1-99, price ว่างหรือเลข >= 0)" });
        return true;
      }
      const note = typeof body.note === "string" ? body.note.trim().slice(0, ORDER_NOTE_MAX) : "";
      const order = db.createOrder({
        customerId,
        channelId: customer.channel_id || "default",
        items,
        total: null,
        note,
        shipping: normalizeShipping(body.shipping), // v1.1: key เองก็ใส่ที่อยู่ได้ตั้งแต่สร้าง
        createdBy: username,
        status: "draft",
      });
      db.addAudit({ operator: username, action: "order_create", target: customerId, detail: `#${order.order_no}` });
      refreshTags(customerId); // ร่างยังไม่นับเป็นการซื้อ แต่คำนวณให้ตรงข้อมูลจริงทุกครั้งที่ออเดอร์เกิด
      json(res, 200, { ok: true, order: shape(order) });
      return true;
    }

    /* ---- POST /orders/<id> — แก้รายการ/ยอด/โน้ต (เฉพาะร่าง) ---- */
    if (req.method === "POST" && route.length === 2) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const id = decodeURIComponent(route[1]);
      const row = db.getOrder(id);
      if (!row) {
        json(res, 404, { ok: false, error: "ไม่พบออเดอร์นี้" });
        return true;
      }
      const body = await readJson(req);
      const hasDraftPatch = body.items !== undefined || body.total !== undefined || body.note !== undefined;
      // โหมดคลาส: ผูก/ล้างรอบเรียน (ถึงก่อนจบ) — ส่งมาคู่กับอย่างอื่นได้ ตรวจทรงก่อนเขียนอะไรทั้งนั้น
      let classRound;
      if (body.classRound !== undefined) {
        classRound = body.classRound === null ? null : normalizeClassRound(body.classRound);
        if (body.classRound !== null && !classRound) {
          json(res, 400, { ok: false, error: "รอบเรียนไม่ถูกต้อง" });
          return true;
        }
      }
      // REVIEW FIX (atomic): ออเดอร์ไม่ใช่ร่าง + ขอแก้รายการ/ยอด/โน้ตมาด้วย = ปฏิเสธทั้งก้อน
      // ก่อนแตะอะไร — ห้ามเขียน shipping สำเร็จแล้วค่อยตอบ error (caller งงว่าตกลงบันทึกไหม)
      if (row.status !== "draft" && hasDraftPatch) {
        json(res, 409, { ok: false, error: `แก้รายการได้เฉพาะออเดอร์ร่าง (ตอนนี้: ${STATUS_TH[row.status] || row.status}) — ส่งเฉพาะ shipping ถ้าต้องการแก้ที่อยู่` });
        return true;
      }
      // รอบเรียนเขียน "ท้ายสุด" หลังส่วนอื่นผ่านหมด — คำขอที่ตอบ error ต้องไม่ทิ้งรอบที่เปลี่ยนไปแล้วไว้ (รีวิว 7 ต.ค.)
      const roundEditable = ["draft", "confirmed", "paid"].includes(row.status);
      if (classRound !== undefined && !roundEditable) {
        json(res, 409, { ok: false, error: `เปลี่ยนรอบเรียนได้ถึงก่อนจบออเดอร์ (ตอนนี้: ${STATUS_TH[row.status] || row.status})` });
        return true;
      }
      const applyRound = () => {
        if (classRound === undefined) return true;
        if (!db.updateOrderClassRound(id, classRound)) return false;
        db.addAudit({ operator: username, action: "order_class_round", target: row.customer_id, detail: `#${row.order_no} ${classRound ? classRound.date : "ล้าง"}` });
        if (mode === "class") syncEnrollment(db.getOrder(id), username);
        return true;
      };
      const roundConflict = () => json(res, 409, { ok: false, error: "สถานะออเดอร์เพิ่งเปลี่ยน — รีเฟรชแล้วลองใหม่" });
      if (classRound !== undefined && body.shipping === undefined && !hasDraftPatch) {
        if (!applyRound()) { roundConflict(); return true; }
        json(res, 200, { ok: true, order: shape(db.getOrder(id)) });
        return true;
      }
      // v1.1: ข้อมูลจัดส่งแก้ได้ถึงก่อนจัดส่ง (draft/confirmed/paid) — คนละกติกากับ
      // ตัวเลขเงินที่นิ่งหลังยืนยัน; console = คนแก้ (source 'human' — scorer จะไม่ทับอีก)
      if (body.shipping !== undefined) {
        const shipping = body.shipping === null ? null : normalizeShipping(body.shipping);
        if (!db.updateOrderShipping(id, shipping, "human")) {
          json(res, 409, { ok: false, error: `แก้ข้อมูลจัดส่งได้ถึงก่อนจัดส่ง (ตอนนี้: ${STATUS_TH[row.status] || row.status})` });
          return true;
        }
        db.addAudit({ operator: username, action: "order_shipping_edit", target: row.customer_id, detail: `#${row.order_no}` });
        if (!hasDraftPatch) {
          if (!applyRound()) { roundConflict(); return true; }
          json(res, 200, { ok: true, order: shape(db.getOrder(id)) });
          return true;
        }
      }
      const patch = {};
      if (body.items !== undefined) {
        const items = normalizeOrderItems(body.items);
        if (items === null) {
          json(res, 400, { ok: false, error: "items ไม่ถูกต้อง (name 1-100 ตัวอักษร, qty 1-99, price ว่างหรือเลข >= 0)" });
          return true;
        }
        patch.items = items;
      }
      if (body.total !== undefined) {
        if (body.total !== null) {
          const t = Number(body.total);
          if (!Number.isFinite(t) || t < 0) {
            json(res, 400, { ok: false, error: "total ต้องเป็น null หรือตัวเลข >= 0" });
            return true;
          }
          patch.total = t;
        } else {
          patch.total = null;
        }
      }
      if (body.note !== undefined) {
        if (typeof body.note !== "string" || body.note.length > ORDER_NOTE_MAX) {
          json(res, 400, { ok: false, error: `note ต้องเป็นข้อความไม่เกิน ${ORDER_NOTE_MAX} ตัวอักษร` });
          return true;
        }
        patch.note = body.note.trim();
      }
      if (patch.items === undefined && patch.total === undefined && patch.note === undefined) {
        json(res, 400, { ok: false, error: "ไม่มีข้อมูลให้บันทึก (ส่ง items/total/note อย่างน้อย 1 อย่าง)" });
        return true;
      }
      if (!db.updateOrderDraft(id, patch)) {
        json(res, 409, { ok: false, error: "ออเดอร์นี้ถูกยืนยันไปแล้ว — แก้รายการไม่ได้" });
        return true;
      }
      db.addAudit({ operator: username, action: "order_edit", target: row.customer_id, detail: `#${row.order_no}` });
      if (!applyRound()) { roundConflict(); return true; }
      json(res, 200, { ok: true, order: shape(db.getOrder(id)) });
      return true;
    }

    /* ---- POST /orders/<id>/status — เดินสถานะตามกฎ (CAS กัน race สองแท็บ) ---- */
    if (req.method === "POST" && route[2] === "status" && route.length === 3) {
      if (!requireCsrf()) {
        json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
        return true;
      }
      const id = decodeURIComponent(route[1]);
      const row = db.getOrder(id);
      if (!row) {
        json(res, 404, { ok: false, error: "ไม่พบออเดอร์นี้" });
        return true;
      }
      const body = await readJson(req);
      const to = String(body.status || "");
      if (!STATUS_SET.has(to)) {
        json(res, 400, { ok: false, error: "status ไม่อยู่ในรายการสถานะออเดอร์" });
        return true;
      }
      if (!canTransition(row.status, to, mode)) {
        json(res, 409, {
          ok: false,
          error: `เปลี่ยนจาก "${STATUS_TH[row.status] || row.status}" เป็น "${STATUS_TH[to] || to}" ไม่ได้ — ต้องเดินตามลำดับ ${FLOW_TH[mode]} (ยกเลิกได้ทุกขั้นที่ยังไม่จบ)`,
        });
        return true;
      }
      if (!db.setOrderStatus(id, row.status, to)) {
        json(res, 409, { ok: false, error: "สถานะออเดอร์เพิ่งถูกเปลี่ยนจากที่อื่น — รีเฟรชแล้วลองใหม่" });
        return true;
      }
      const fresh = db.getOrder(id);
      db.addAudit({
        operator: username, action: "order_status", target: fresh.customer_id,
        detail: `#${fresh.order_no} ${row.status} -> ${to}`,
      });
      fireWebhook(fresh); // เฉพาะ confirmed/paid — fire-and-forget
      // โหมดคลาส: ชำระแล้ว + มีรอบเรียน = ลงชื่อผู้เรียนเข้ารอบ (ตาราง enrollments) — พังห้ามย้อนสถานะเงิน
      if (mode === "class") syncEnrollment(fresh, username);
      // 7 ต.ค. 2026: ชำระแล้ว = ส่ง Purchase เข้า Meta Conversions API (metaCapi.mjs — สวิตช์ meta_capi_mode, ค่าเริ่มต้นปิด)
      if (to === "paid") {
        try { void metaCapi?.onOrderPaid?.(fresh); } catch { /* ส่ง Meta พังห้ามย้อนสถานะเงิน */ }
      }
      // v1.1 (item 7): สถานะออเดอร์ขยับ = ป้าย RFM ของลูกค้าคนนี้เปลี่ยน — recompute เงียบ ๆ
      // (ยืนยัน/จ่าย = นับเพิ่ม · ยกเลิกหลังจ่าย = คืนเงิน ลดครั้งที่และเดือนล่าสุดตาม)
      refreshTags(fresh.customer_id);
      json(res, 200, { ok: true, order: shape(fresh) });
      return true;
    }

    return false;
  }

  return { handle };
}
