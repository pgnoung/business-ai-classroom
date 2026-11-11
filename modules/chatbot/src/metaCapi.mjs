// metaCapi.mjs — ส่ง "Purchase" เข้า Meta Conversions API เมื่อออเดอร์ "ชำระแล้ว" (พี่ง้วง 7 ต.ค. 2026:
// "อยากให้ทำ conversion api ... ทำจากหน้าลูกแพรดีไหม")
//
// ทำไมส่งจากลูกแพร: ลูกแพรรู้ PSID ของลูกค้า Messenger อยู่แล้ว (customer_id = facebook:<psid>) และรู้ว่าห้องไหนจ่ายจริง
// Meta จะเรียนว่า "แชทแบบไหนจบที่การซื้อ" แล้วหาคนแบบนั้นมาเพิ่ม · ไอติมยังไม่เคยส่ง Purchase จริง → ลูกแพรเป็นผู้ส่งคนเดียว
//
// payload = Business Messaging (เอกสาร Meta "Conversions API for Business Messaging"):
//   action_source "business_messaging" · messaging_channel "messenger" · user_data { page_id, page_scoped_user_id }
//   event_id = lukprae-order-<id> (Meta dedupe ด้วย event_id; ใบเสร็จในเครื่องกันส่งซ้ำอีกชั้น)
//
// กติกา:
// - สวิตช์ meta_capi_mode: off (ค่าเริ่มต้น) | test (ส่งพร้อม test_event_code — เห็นใน Events Manager แต่ไม่นับ) | live
// - ห้องที่ไม่ใช่ Messenger (LINE) / ไม่มียอด = ข้ามถาวร · ยังไม่ตั้งชุดข้อมูล/โทเค็นอ่านไม่ได้/Meta พัง = ข้ามไว้ก่อน
//   ตัวกวาด sweep() ลองใหม่ทุก 30 นาที สูงสุด 5 ครั้งภายใน 6.5 วัน (dbMetaCapi.reserveCapiEvent)
// - ห้ามขวางการกดสถานะออเดอร์: send() คืนทันที งานวิ่งเบื้องหลัง พังแค่จดใบเสร็จ failed
// - ไม่ส่ง PII ใด ๆ นอกจาก page_id + PSID ที่ Meta กำหนดให้ใช้กับ Business Messaging
import { activeBrand, isGenericProfile } from "./brand.mjs";
export const META_CAPI_MODE_KEY = "meta_capi_mode";
export const META_CAPI_MODES = Object.freeze(["off", "test", "live"]);
export const META_CAPI_DATASET_KEY = "meta_capi_dataset_id";
export const META_CAPI_TEST_CODE_KEY = "meta_capi_test_event_code";

const DATASET_ID = /^\d{5,32}$/u;
const PSID = /^\d{5,32}$/u;
const TEST_CODE = /^[A-Za-z0-9_-]{3,40}$/u;
const TIMEOUT_MS = 10_000;
// Meta รับ event ย้อนหลังได้ 7 วัน — เผื่อขอบไว้ 6.5 วัน
const RETRY_WINDOW_MS = 6.5 * 86_400_000;

export function metaCapiMode(db) {
  // White-label: โปรไฟล์ generic ปิดฟีเจอร์เฉพาะธุรกิจคอร์สของพี่ง้วงเสมอ (ค่าใน DB ไม่มีผล)
  if (isGenericProfile(activeBrand())) return "off";
  try {
    const value = db?.getSetting?.(META_CAPI_MODE_KEY);
    return META_CAPI_MODES.includes(value) ? value : "off";
  } catch {
    return "off";
  }
}

/** PSID จาก customer_id ของห้อง Messenger ("facebook:<psid>") — ห้องอื่น = "" */
export function psidOf(customerId) {
  const match = /^facebook:(\d{5,32})$/u.exec(String(customerId || ""));
  return match && PSID.test(match[1]) ? match[1] : "";
}

export function buildPurchaseEvent({ order, psid, pageId, nowMs = Date.now() }) {
  return {
    event_name: "Purchase",
    event_time: Math.floor(nowMs / 1000),
    event_id: `lukprae-order-${order.id}`,
    action_source: "business_messaging",
    messaging_channel: "messenger",
    user_data: { page_id: String(pageId), page_scoped_user_id: String(psid) },
    custom_data: { currency: "THB", value: Number(order.total) },
  };
}

export function createMetaCapi({
  db, getPageToken = () => "", getPageId = async () => "", fetchImpl,
  graphBase = "https://graph.facebook.com/v24.0", logger = console, now = Date.now,
} = {}) {
  /** เหตุที่ข้าม — "" = ส่งได้ */
  function skipReason(order, mode) {
    if (mode === "off") return "off";
    if (!psidOf(order.customer_id)) return "not_messenger";
    if (!(Number(order.total) > 0)) return "no_total";
    if (!DATASET_ID.test(String(db.getSetting(META_CAPI_DATASET_KEY) || ""))) return "no_dataset";
    if (mode === "test" && !TEST_CODE.test(String(db.getSetting(META_CAPI_TEST_CODE_KEY) || ""))) return "no_test_code";
    return "";
  }

  async function deliver(order, mode) {
    const pageId = String(await getPageId() || "");
    const token = String(getPageToken() || "");
    if (!/^\d{5,32}$/u.test(pageId) || !token) return { status: "skipped", detail: !token ? "no_page_token" : "no_page_id" };
    const dataset = String(db.getSetting(META_CAPI_DATASET_KEY));
    // โทเค็นอยู่ใน body ไม่อยู่ใน URL — URL ไปโผล่ใน log/proxy ได้ง่ายกว่า (รีวิว 7 ต.ค.)
    const body = { data: [buildPurchaseEvent({ order, psid: psidOf(order.customer_id), pageId, nowMs: now() })], access_token: token };
    if (mode === "test") body.test_event_code = String(db.getSetting(META_CAPI_TEST_CODE_KEY));
    const res = await fetchImpl(`${graphBase.replace(/\/+$/u, "")}/${dataset}/events`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let payload = null;
    try { payload = await res.json(); } catch { payload = null; }
    if (res.ok && Number(payload?.events_received) >= 1) {
      return { status: "sent", detail: `events_received=${payload.events_received}${payload.fbtrace_id ? ` trace=${payload.fbtrace_id}` : ""}` };
    }
    const err = payload?.error;
    // ข้อความ error ของ Meta ไม่มีโทเค็น แต่ตัดสั้นไว้เสมอ
    return { status: "failed", detail: `HTTP ${res.status}${err ? ` ${err.code || ""} ${String(err.message || "").slice(0, 160)}` : ""}` };
  }

  /** เรียกตอนออเดอร์เปลี่ยนเป็น "ชำระแล้ว" — คืนทันที (Promise สำหรับเทสต์) ไม่ throw */
  function onOrderPaid(order) {
    const mode = metaCapiMode(db);
    if (mode === "off" || !order?.id) return Promise.resolve({ status: "off" });
    const eventId = `lukprae-order-${order.id}`;
    const reason = skipReason(order, mode);
    try {
      if (!db.reserveCapiEvent({ orderId: order.id, mode, eventId, valueThb: Number(order.total) || null })) {
        return Promise.resolve({ status: "duplicate" });
      }
    } catch (err) {
      logger.warn?.(`meta capi: จองใบเสร็จไม่สำเร็จ (${err?.message || err})`);
      return Promise.resolve({ status: "failed" });
    }
    if (reason) {
      db.finishCapiEvent({ orderId: order.id, mode, status: "skipped", detail: reason });
      return Promise.resolve({ status: "skipped", detail: reason });
    }
    return deliver(order, mode)
      .catch((err) => ({ status: "failed", detail: String(err?.message || err).slice(0, 200) }))
      .then((result) => {
        try { db.finishCapiEvent({ orderId: order.id, mode, ...result }); } catch { /* db ปิดระหว่างทาง */ }
        if (result.status !== "sent") logger.warn?.(`meta capi: ออเดอร์ ${order.id} ${result.status} (${result.detail})`);
        return result;
      });
  }

  /**
   * ตัวกวาดลองใหม่ (server ปลุกทุก 30 นาที): ออเดอร์ที่ชำระแล้วใน 7 วันแต่ยังไม่ถูกส่งสำเร็จ —
   * เช่น ตั้งชุดข้อมูลทีหลัง / โทเค็นหรือรหัสเพจอ่านไม่ได้ชั่วคราว / Meta พัง · ทีละออเดอร์ ไม่ throw
   */
  let sweeping = false;
  let stopped = false;
  async function sweep() {
    const mode = metaCapiMode(db);
    if (mode === "off" || sweeping || stopped) return { tried: 0 };
    sweeping = true;
    let tried = 0;
    try {
      const rows = db.capiRetryCandidates({ mode, sinceMs: now() - RETRY_WINDOW_MS });
      for (const order of rows) {
        if (stopped) break;
        tried += 1;
        await onOrderPaid(order);
      }
    } catch (err) {
      logger.warn?.(`meta capi: รอบลองใหม่ล้ม (${err?.message || err})`);
    } finally {
      sweeping = false;
    }
    return { tried };
  }

  function stop() { stopped = true; }

  return { onOrderPaid, sweep, stop };
}
