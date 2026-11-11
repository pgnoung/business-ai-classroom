// orders.mjs — ระบบออเดอร์ v1 (G6 P2): กติกา status flow, validate รายการ,
// เทียบราคากับตาราง approve, จับร่างออเดอร์จาก scorer, webhook เชื่อมระบบนอก
//
// กติกาเหล็ก (human-confirms-money):
// - AI สร้างได้เฉพาะสถานะ "draft" และเป็นของ admin-facing เท่านั้น — ไม่มีเส้นทางไหน
//   ส่งเรื่องออเดอร์/ยอดเงินไปหาลูกค้าอัตโนมัติ ทุกการยืนยันเป็นการกดของคนใน console
// - ราคาใน draft มาจากตาราง approved_prices เท่านั้น (เทียบชื่อแบบ fuzzy) —
//   เทียบไม่ได้ = price null ให้คนเติมเอง ห้ามใช้ตัวเลขที่ model เดา
// - webhook (ORDER_WEBHOOK_URL) = สะพานสากลไป Make/Sheets/ระบบลูกค้า — fire-and-forget
//   ล้วน ๆ: ล้มเหลว log อย่างเดียว ห้าม block สถานะออเดอร์; ไม่มี env = ปิดสนิท

import { parseShippingJson } from "./shipping.mjs";
import { classModeCanTransition, orderInfoWarnings, orderMode } from "./orderMode.mjs";

export const ORDER_STATUSES = Object.freeze(["draft", "confirmed", "paid", "shipped", "done", "cancelled"]);

// เส้นทางสถานะที่ถูกกฎ — ข้ามขั้นไม่ได้ (draft -> paid ต้องผ่าน confirmed ก่อน)
// ยกเลิกได้จากทุกสถานะที่ยังไม่จบ; done/cancelled = ปลายทาง แก้ไม่ได้อีก
export const ORDER_TRANSITIONS = Object.freeze({
  draft: Object.freeze(["confirmed", "cancelled"]),
  confirmed: Object.freeze(["paid", "cancelled"]),
  paid: Object.freeze(["shipped", "cancelled"]),
  shipped: Object.freeze(["done", "cancelled"]),
  done: Object.freeze([]),
  cancelled: Object.freeze([]),
});

// mode "class" (orderMode.mjs) = ชำระแล้ว → ลงทะเบียนเรียนแล้ว ตรง ๆ ไม่มีขั้นจัดส่ง
export function canTransition(from, to, mode = "shipping") {
  if (mode === "class") return classModeCanTransition(from, to);
  return (ORDER_TRANSITIONS[from] || []).includes(to);
}

export const ORDER_ITEM_NAME_MAX = 100;
export const ORDER_MAX_ITEMS = 20;

// validate รายการจากฝั่ง console (แอดมินแก้ร่าง) — ทรงผิด = คืน null ให้ตอบ 400
// item: { name: 1-100 ตัวอักษร, qty: 1-99, price: null หรือเลข >= 0 }
export function normalizeOrderItems(raw) {
  if (!Array.isArray(raw) || raw.length > ORDER_MAX_ITEMS) return null;
  const items = [];
  for (const it of raw) {
    const name = typeof it?.name === "string" ? it.name.trim().slice(0, ORDER_ITEM_NAME_MAX) : "";
    if (!name) return null;
    const qtyN = Number(it.qty);
    if (!Number.isInteger(qtyN) || qtyN < 1 || qtyN > 99) return null;
    let price = null;
    if (it.price !== null && it.price !== undefined && it.price !== "") {
      const p = Number(it.price);
      if (!Number.isFinite(p) || p < 0) return null;
      price = p;
    }
    items.push({ name, qty: qtyN, price });
  }
  return items;
}

// เทียบชื่อสินค้าเข้าตาราง approved_prices แบบ fuzzy (normalize แล้ว exact -> contains)
// BUGFIX 2026-08-10 (เคสจริง: "Airdog X3Pro" ถูกจับคู่ราคาประกันแพ็คคู่ 2,790):
// - หลาย match ต้องเลือก label "สั้นสุด" (ใกล้ตัวสินค้าเพียวที่สุด) — ไม่ใช่ยาวสุด
//   (label ยิ่งยาว = แพ็คพ่วง/ประกัน/คูปอง ยิ่งไม่ใช่ตัวสินค้า)
// - หมวดเสี่ยง (ประกัน/คูปอง/ค่าบริการ/ค่าจัดส่ง/ส่วนลด) จับคู่ได้เฉพาะเมื่อ
//   ชื่อ item เอ่ยหมวดนั้นเอง — ชื่อสินค้าเพียวห้ามโดนแถวพวกนี้เด็ดขาด
const normalize = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
const RISKY_LABEL_WORDS = ["ประกัน", "คูปอง", "ค่าบริการ", "ค่าจัดส่ง", "ส่วนลด"];
export function resolveApprovedPrice(prices, name) {
  const target = normalize(name);
  if (!target) return null;
  // สองชั้นตามทิศของ contains:
  // ชั้น 1: label ครอบชื่อ item (label ⊇ item) = สินค้า/แพ็คเกจของสิ่งที่ขอ -> เลือก label สั้นสุด
  // ชั้น 2 (เมื่อชั้น 1 ว่าง): ชื่อ item ครอบ label (item ⊇ label) = label เป็นเศษของชื่อ
  //         -> เลือก label ยาวสุด (เศษที่เจาะจงสุด)
  let bestSuper = null, bestSuperLen = Infinity;
  let bestSub = null, bestSubLen = -1;
  for (const row of prices || []) {
    const label = normalize(row.label);
    if (!label) continue;
    if (label === target) return Number(row.amount); // exact ชนะทันที
    // แถวหมวดเสี่ยง: ข้าม เว้นแต่ชื่อ item เอ่ยหมวดนั้นเอง
    if (RISKY_LABEL_WORDS.some((w) => label.includes(normalize(w)) && !target.includes(normalize(w)))) continue;
    if (label.includes(target) && label.length < bestSuperLen) {
      bestSuper = row;
      bestSuperLen = label.length;
    } else if (target.includes(label) && label.length > bestSubLen) {
      bestSub = row;
      bestSubLen = label.length;
    }
  }
  const best = bestSuper || bestSub;
  return best ? Number(best.amount) : null;
}

// รายการจาก scorer ({name, qty}) -> รายการพร้อมราคา — total คำนวณเฉพาะเมื่อรู้ราคาครบ
export function priceOrderItems(items, approvedPrices) {
  const priced = (items || []).map((it) => ({
    name: it.name,
    qty: it.qty,
    price: resolveApprovedPrice(approvedPrices, it.name),
  }));
  const total = priced.length && priced.every((it) => Number.isFinite(it.price))
    ? priced.reduce((sum, it) => sum + it.price * it.qty, 0)
    : null;
  return { items: priced, total };
}

/* --------------------- AI draft-order capture (จาก scorer) --------------------- */

// เรียกจาก pipeline หลังบันทึก score (fire-and-forget อยู่แล้วทั้งเส้น) — เงื่อนไข:
// score >= 8 + มีก้อน order ที่ validate แล้ว + ลูกค้ายังไม่มีร่างค้าง -> สร้าง draft
// v1.1: มีร่างค้างอยู่แล้ว + scorer เพิ่งจับข้อมูลจัดส่งได้ -> เติม shipping เข้าร่างเดิม
// (เคสจริงที่พบบ่อยสุด: ร่างเกิดตอน "ตกลงซื้อ" — ชื่อ/ที่อยู่/เบอร์ตามมาทีหลังในแชท)
// คืน order ที่สร้าง/อัปเดต หรือ null; ทุกความล้มเหลว = null เงียบ ๆ (ห้ามกระทบแชท)
export function maybeCaptureDraftOrder({ db, customerId, payload, logger = console }) {
  try {
    if (!payload?.order || !(Number(payload.score) >= 8)) return null;
    if (String(customerId).startsWith("canary:")) return null;
    const shipping = payload.order.shipping || null;
    const existing = db.openDraftOrder(customerId);
    if (existing) {
      // ร่างค้างแล้ว — งานเดียวที่เหลือคือเติม/อัปเดตข้อมูลจัดส่งล่าสุดจากแชท
      // (scorer ส่งค่าล่าสุดเสมอ — ลูกค้าแก้เบอร์กลางแชทก็ตามทัน); ไม่มี shipping = จบเงียบ
      // REVIEW FIX: แอดมินแก้ shipping จาก console แล้ว (source='human') = คนชนะเสมอ —
      // scorer ห้ามทับ (กติกาเดียวกับ known_name: ai_auto ห้ามทับค่าที่คนตั้ง)
      if (!shipping) return null;
      if (existing.shipping_source === "human") return null;
      if (existing.shipping_json === JSON.stringify(shipping)) return null; // ไม่มีอะไรใหม่
      if (!db.updateOrderShipping(existing.id, shipping, "ai")) return null;
      db.addAudit({
        operator: "ai_auto", action: "order_shipping_auto", target: customerId,
        detail: `#${existing.order_no} เติมข้อมูลจัดส่งจากบทสนทนา`.slice(0, 200),
      });
      const mode = orderMode(db);
      const warnings = orderInfoWarnings(shipping, mode);
      if (warnings.length) {
        // ธงให้คนเห็นทันทีใน console — ข้อมูลผิด (เบอร์ 9 หลัก/ปณ.เพี้ยน) ห้ามผ่านเงียบ
        db.addHandoffNote?.({
          customerId, author: "ai_auto",
          text: `${mode === "class" ? "ข้อมูลผู้เรียน" : "ข้อมูลจัดส่ง"}ออเดอร์ #${existing.order_no} มีจุดต้องทวน: ${warnings.join(" / ")}`.slice(0, 400),
        });
      }
      logger.log?.(`[orders] เติมข้อมูลจัดส่งเข้าออเดอร์ร่าง #${existing.order_no} customer=${customerId}`);
      return db.getOrder(existing.id);
    }
    const customer = db.getCustomer(customerId);
    if (!customer) return null;
    const { items, total } = priceOrderItems(payload.order.items, db.approvedPrices());
    const hint = payload.order.total_hint;
    const noteParts = [`สร้างอัตโนมัติจากบทสนทนา (score ${payload.score}/10)`];
    // ยอดที่ model ได้ยินจากแชทเป็นแค่ "คำใบ้ให้คนตรวจ" — ไม่เอาไปตั้งเป็น total เอง
    if (total == null && Number.isFinite(hint)) {
      noteParts.push(`ยอดที่คุยกันในแชท ~฿${Number(hint).toLocaleString("th-TH")} (ต้องตรวจกับตารางราคา)`);
    }
    const order = db.createOrder({
      customerId,
      channelId: customer.channel_id || "default",
      items,
      total,
      note: noteParts.join(" · "),
      shipping,
      shippingSource: shipping ? "ai" : "",
      createdBy: "ai",
      status: "draft",
    });
    db.addAudit({
      operator: "ai_auto", action: "order_ai_draft", target: customerId,
      detail: `#${order.order_no} ${items.map((it) => `${it.name} x${it.qty}`).join(", ")}`.slice(0, 200),
    });
    logger.log?.(`[orders] สร้างออเดอร์ร่าง #${order.order_no} จากบทสนทนา customer=${customerId}`);
    return order;
  } catch (err) {
    logger.debug?.(`orders: จับร่างออเดอร์ไม่สำเร็จ (${err?.message || err}) — ไม่มีผลกับแชท`);
    return null;
  }
}

/* ---------------------- integration webhook (ระบบลูกค้า) ---------------------- */

const WEBHOOK_TIMEOUT_MS = 15_000;

// สะพานเชื่อม Make/Sheets/ระบบ order ของลูกค้า — ยิงตอนสถานะเปลี่ยนเป็น confirmed/paid
// fail-closed: ไม่มี ORDER_WEBHOOK_URL = ปิดสนิท; ล้มเหลว = log เท่านั้น ไม่มี retry
export function createOrderWebhook({ config, fetchImpl = (...args) => globalThis.fetch(...args), logger = console }) {
  const enabled = Boolean(config.orderWebhookUrl);

  async function fireStatusChange({ order, customerName = "", channelName = "" }) {
    if (!enabled) return { skipped: "disabled" };
    let items = [];
    try {
      items = JSON.parse(order.items_json || "[]");
    } catch {
      items = [];
    }
    try {
      const res = await fetchImpl(config.orderWebhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.orderWebhookToken ? { authorization: `Bearer ${config.orderWebhookToken}` } : {}),
        },
        body: JSON.stringify({
          orderId: order.id,
          orderNo: order.order_no,
          status: order.status,
          customer: { name: customerName, channel: channelName },
          items,
          total: order.total,
          // v1.1: ข้อมูลจัดส่งไปกับ webhook — ปลายทาง (Google Sheet/ระบบลูกค้า) ไม่ต้องมาแกะเอง
          shipping: parseShippingJson(order.shipping_json),
          ts: Date.now(),
        }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!res?.ok) {
        logger.warn?.(`orderWebhook: HTTP ${res?.status ?? "?"} (order #${order.order_no}) — ไม่ retry`);
        return { ok: false, status: res?.status ?? null };
      }
      return { ok: true };
    } catch (err) {
      logger.warn?.(`orderWebhook: ยิงไม่สำเร็จ (${err?.name || "Error"}: ${err?.message || err}) — ไม่ retry`);
      return { ok: false };
    }
  }

  return { enabled, fireStatusChange };
}

/* -------------------- safe wrappers (ใช้ใน consoleApi บรรทัดเดียว) -------------------- */

// ออเดอร์ค้างของลูกค้า สำหรับแผงข้อมูลข้างห้องแชท — พัง = [] (ห้ามลากหน้าแชทล้ม)
// v1.1: แนบ shipping + warning ไปด้วย — แผงข้างแชทต้องเห็นธง "ข้อมูลจัดส่งต้องทวน" ทันที
export function safeListOpenOrdersFor(db, customerId) {
  try {
    const mode = orderMode(db);
    return db.listOpenOrdersFor(customerId, 5).map((order) => {
      const shipping = parseShippingJson(order.shipping_json);
      return { ...order, shipping, shippingWarnings: orderInfoWarnings(shipping, mode) };
    });
  } catch {
    return [];
  }
}

// สถิติการ์ดหน้า "ภาพรวม" — พัง = null (การ์ดโชว์ "—")
export function safeOrderStats(db, channel) {
  try {
    return db.orderStats(channel);
  } catch {
    return null;
  }
}
