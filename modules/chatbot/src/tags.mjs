// tags.mjs — v1.1 (item 7): RFM tags จากออเดอร์จริง + กติกาสินค้าเข้า prompt
//
// หลัก RFM ตามที่พี่ง้วงสอนใน LINE OA (คำสั่งตรง 2026-08-10):
// "ซื้อครั้งที่เท่าไหร่" (Frequency), "ซื้อเมื่อไหร่" (Recency),
// "ซื้อสินค้าอะไร" (Product), "AOV เท่าไหร่" (Monetary)
// ป้ายทั้งชุดคำนวณจาก DB ล้วน ๆ (ไม่มี LLM call) — recompute ตอนสถานะออเดอร์ขยับ
// และแอดมินแก้/ลบ/เพิ่มป้ายเองได้เสมอ (source 'human' ระบบไม่แตะ)
//
// การใช้งานปลายทาง: segment สำหรับ broadcast + กติกาให้ AI ว่าสินค้าไหนควรคุยกับใคร
// (ซื้อแล้วไม่ขายซ้ำ แต่ upsell/cross-sell ตามบริบทได้) — คู่มือเต็ม: /console/guide-tags.html
//
// 28 ก.ย. 2026 (กรอบป้ายชุดเดียว เปิดอยู่): ป้ายความถี่/ความใหม่แบบเดิมถูกแทนด้วยมิติของระบบ
// "ซื้อครั้งที่: N" + "ซื้อล่าสุด: Sep2026" (ค่าเดียว คำนวณใหม่ทุกครั้ง รวมป้ายนับครั้ง/ป้ายเดือนจาก LINE OA เดิม
// กติกากันนับซ้ำอยู่ใน purchaseHistory.mjs) · ป้ายสินค้า "ซื้อแล้ว: …" กับ AOV คงเดิม
// ปิดสวิตช์ tag_framework_mode = ป้ายชุดเดิมทุกตัวอักษร
import { PURCHASED_ORDER_STATUSES, purchaseTagsFor, summarizePurchases } from "./purchaseHistory.mjs";

// สถานะที่นับเป็น "ซื้อจริง" — ตรงกับ REVENUE_STATUSES ของ dbOrders
const PURCHASED_STATUSES = new Set(PURCHASED_ORDER_STATUSES);
const DAY_MS = 86_400_000;
export const RFM_MAX_PRODUCT_TAGS = 5;

// ป้าย recency ตามช่วง — คงที่พอสำหรับ broadcast (recompute ทุกครั้งที่ออเดอร์ขยับ)
function recencyTag(daysSince) {
  if (daysSince <= 30) return "ซื้อล่าสุดใน 30 วัน";
  if (daysSince <= 90) return "ซื้อล่าสุด 31-90 วัน";
  return "ห่างหายเกิน 90 วัน";
}

// AOV เป็นช่วง — ตัวเลขเป๊ะ ๆ จะเปลี่ยนทุกออเดอร์จน broadcast segment ไม่นิ่ง
function aovTag(aov) {
  if (aov >= 50_000) return "AOV สูงมาก (฿50,000+)";
  if (aov >= 20_000) return "AOV สูง (฿20,000-49,999)";
  if (aov >= 5_000) return "AOV กลาง (฿5,000-19,999)";
  return "AOV เริ่มต้น (ต่ำกว่า ฿5,000)";
}

/**
 * ป้าย RFM จากข้อมูลที่โหลดมาแล้ว (บริสุทธิ์ — เครื่องมือแปลงป้ายทั้งฐานใช้ตัวเดียวกับตอนออเดอร์ขยับ)
 * orders = ออเดอร์ทุกสถานะของลูกค้า · humanTags = ป้าย source human (หลักฐานการซื้อจาก LINE OA เดิม)
 * purchase = framework.purchase ของกรอบที่เปิดอยู่ (null = RFM แบบเดิมทุกตัวอักษร)
 */
export function rfmTagsFromData({ orders = [], humanTags = [], purchase = null, now = Date.now } = {}) {
  const bought = orders.filter((o) => PURCHASED_STATUSES.has(o.status));
  const tags = [];
  if (purchase) {
    tags.push(...purchaseTagsFor(summarizePurchases({
      orderTimes: bought.map((o) => Number(o.created_at) || 0), humanTags, purchase,
    }), purchase));
    if (!bought.length) return tags;
  } else {
    if (!bought.length) return [];
    const n = bought.length;
    tags.push(n === 1 ? "ซื้อแล้ว 1 ครั้ง (ลูกค้าใหม่)" : `ซื้อซ้ำ (${n} ครั้ง)`);
    const lastAt = Math.max(...bought.map((o) => Number(o.created_at) || 0));
    tags.push(recencyTag(Math.floor((now() - lastAt) / DAY_MS)));
  }
  return [...tags, ...productAndAovTags(bought)];
}

// คำนวณป้าย RFM ของลูกค้าหนึ่งคนจากออเดอร์จริง — คืน [] เมื่อยังไม่เคยซื้อ
// framework = กรอบป้ายที่ "เปิดอยู่" (activeTagFramework) — ไม่ส่ง = แบบเดิม
export function computeRfmTags(db, customerId, { now = Date.now, framework = null } = {}) {
  const orders = db.listOrdersFor?.(customerId) ?? listOrdersFallback(db, customerId);
  const purchase = framework?.purchase || null;
  const humanTags = purchase
    ? (db.listTags?.(customerId) || []).filter((row) => row.source === "human").map((row) => row.tag)
    : [];
  return rfmTagsFromData({ orders, humanTags, purchase, now });
}

function productAndAovTags(orders) {
  const tags = [];
  // สินค้า: ชื่อ item ไม่ซ้ำ เรียงจากออเดอร์ล่าสุดก่อน (เพดานกันป้ายบาน)
  const seen = new Set();
  for (const order of [...orders].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))) {
    let items = [];
    try {
      items = JSON.parse(order.items_json || "[]") || [];
    } catch { /* ออเดอร์เก่าพัง = ข้าม */ }
    for (const it of items) {
      const name = String(it?.name || "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (seen.size <= RFM_MAX_PRODUCT_TAGS) tags.push(`ซื้อแล้ว: ${name}`);
    }
  }

  const totals = orders.map((o) => Number(o.total)).filter((t) => Number.isFinite(t) && t > 0);
  if (totals.length) {
    tags.push(aovTag(totals.reduce((s, t) => s + t, 0) / totals.length));
  }
  return tags;
}

// listOrdersFor ยังไม่มีใน dbOrders — ดึงตรงจากตาราง (read-only, ปลอดภัย)
function listOrdersFallback(db, customerId) {
  try {
    return db.raw
      .prepare("SELECT status, total, items_json, created_at FROM orders WHERE customer_id = ?")
      .all(String(customerId));
  } catch {
    return [];
  }
}

// recompute + เขียนทับป้าย rfm ทั้งชุด — เรียกตอนออเดอร์ถูกสร้าง/สถานะเปลี่ยน (รวมยกเลิก = คืนเงิน)
// ตอนทีมติด/ถอดป้ายประวัติการซื้อ และหลังโยงห้องระบบเก่า (fire-and-forget)
// ทุกความล้มเหลว = เงียบ (ป้ายเป็นของเสริม ห้ามลากเส้นทางออเดอร์/แชทล้ม)
export function refreshRfmTags(db, customerId, { now = Date.now, logger = console, framework = null } = {}) {
  try {
    if (String(customerId).startsWith("canary:")) return false;
    db.replaceSourceTags(customerId, "rfm", computeRfmTags(db, customerId, { now, framework }));
    return true;
  } catch (err) {
    logger.debug?.(`tags: refresh RFM ไม่สำเร็จ (${err?.message || err})`);
    return false;
  }
}

/* --------------------------- กติกาสินค้า -> prompt --------------------------- */

export const PRODUCT_RULES_KEY = "product_rules";
export const PRODUCT_RULES_MAX = 4000;

// บรรทัดกติกาที่ฉีดเข้า system prompt เมื่อลูกค้ามีป้าย/ทีมตั้งกติกาไว้
// — ป้ายบอก AI ว่ากำลังคุยกับใคร; กติกาสินค้าบอกว่าสินค้าไหนควรคุยกับใคร
export function composeTagRules({ tags = [], productRules = "" } = {}) {
  const lines = [];
  if (tags.length) {
    lines.push(`- ป้ายลูกค้า (chat tags): ${tags.map((t) => t.tag || t).join(" · ")}`);
    if (tags.some((t) => String(t.tag || t).startsWith("ซื้อแล้ว:"))) {
      lines.push(
        "- สินค้าที่มีป้าย \"ซื้อแล้ว:\" = ลูกค้ามีแล้ว ห้ามเสนอขายตัวเดิมซ้ำ " +
        "เว้นแต่ลูกค้าเปิดเรื่องเองหรือบริบทซื้อซ้ำ/ซื้อเพิ่มชัดเจน — " +
        "เสนอสินค้าเสริม อุปกรณ์ หรือรุ่นที่เข้ากับบริบท (upsell/cross-sell) ได้ตามธรรมชาติ"
      );
    }
  }
  const rules = String(productRules || "").trim();
  if (rules) {
    lines.push("กติกาสินค้าจากทีมงาน (ยึดตามนี้ก่อนเสมอ):");
    for (const line of rules.split("\n")) {
      const clean = line.trim();
      if (clean) lines.push(clean.startsWith("-") ? clean : `- ${clean}`);
    }
  }
  return lines;
}
