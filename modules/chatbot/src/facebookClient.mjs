// facebookClient.mjs — ขาออก Facebook Messenger ทางเดียวของระบบ (v1.5)
//
// สัญญาสำคัญของไฟล์นี้: interface ต้องตรงกับ createLineClient ทุก method
// เพราะ registry (lineClient.mjs) เสียบ client ตาม provider ของ channel —
// pipeline / followupEngine / stagedFollowups เรียกผ่าน registry โดยไม่รู้จัก provider
//
// ความต่างจาก LINE ที่จงใจ:
// - ไม่มี replyToken — ทุกการส่งคือ push (Send API), replyToken ที่ส่งมาถูกเพิกเฉย
// - metadata "lukprae-bot" ติดทุกข้อความ — webhook echo ใช้แยก "ของเราเอง" ออกจาก
//   "แอดมินพิมพ์จาก Business Suite" (ตัวหลังคือสัญญาณให้บอทหลบทั้งห้อง)
// - multicast/บรอดแคส = blocked เสมอ (นโยบายกันแบน 24 ชม. — ไม่มีข้อยกเว้น)
// - sticker ของ LINE ไม่มีเทียบเท่า — ข้ามเงียบ ๆ ไม่ใช่ล้ม
//
// fail-closed เหมือน LINE ทุกชั้น: mock ได้เสมอ / live ต้องเปิด FB_LIVE_SEND เอง
import { createHmac, timingSafeEqual } from "node:crypto";
import { orderOutbound } from "./bubbleOrder.mjs";

const GRAPH_API_BASE = "https://graph.facebook.com";
const PROFILE_TIMEOUT_MS = 10_000;
// Send API metadata (สูงสุด 1000 ตัวอักษร) สะท้อนกลับมาใน echo ตรง ๆ
export const FB_OUTBOUND_METADATA = "lukprae-bot";

// โดเมนที่ Meta ใช้เสิร์ฟไฟล์แนบของ Messenger — รายการปิด ไม่รับโฮสต์อื่นเด็ดขาด
export const FB_MEDIA_HOSTS = Object.freeze(["fbcdn.net", "fbsbx.com", "cdninstagram.com"]);

// ตรวจ X-Hub-Signature-256 จาก raw body ก่อน parse เสมอ (รูปแบบ "sha256=<hex>")
export function verifyFacebookSignature(rawBody, header, appSecret) {
  if (!appSecret || !header) return false;
  const value = String(header);
  if (!value.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(`sha256=${expected}`);
  const b = Buffer.from(value);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// credentials เป็น getter — โทเคนกรอกจากคอนโซล (DB settings) เปลี่ยนได้โดยไม่ restart
// จึงห้าม snapshot ค่าไว้ตอนสร้าง client
export function createFacebookClient({
  config,
  credentials = () => ({ pageAccessToken: "" }),
  outboundAllowed = () => true,
  fetchImpl = (...args) => globalThis.fetch(...args),
  sleep = defaultSleep,
  logger = console,
} = {}) {
  const usingMock = Boolean(config.fbMockUrl);
  const base = (config.fbMockUrl || `${GRAPH_API_BASE}/${config.fbApiVersion || "v24.0"}`).replace(/\/+$/, "");

  const token = () => {
    try { return String(credentials()?.pageAccessToken || ""); } catch { return ""; }
  };

  function outboundIsAllowed(to, action) {
    try {
      return outboundAllowed({ channelId: "facebook", to: String(to || ""), action }) === true;
    } catch {
      return false;
    }
  }

  function sendAllowed() {
    return usingMock || config.fbLiveSend === true;
  }

  async function callSend(body) {
    try {
      const res = await fetchImpl(`${base}/me/messages?access_token=${encodeURIComponent(token() || "mock-token")}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.lineTimeoutMs || 15_000),
      });
      return { ok: Boolean(res?.ok), status: res?.status ?? 0 };
    } catch (err) {
      logger.warn?.(`facebookClient: ส่งไม่สำเร็จ (${err?.name || "Error"}: ${err?.message || err})`);
      return { ok: false, status: 0, error: String(err?.message || err) };
    }
  }

  // interface ตรงกับ lineClient.sendBubbles — คืน {ok, mode, calls, delivered?, acceptedRequestMessages?}
  // FB ไม่มี reply token: mode เป็น "push" เสมอ; ล้มกลางลูปต้องรายงาน delivered
  // (บทเรียนโควตา LINE 2026-08-15: ข้อความที่ออกไปแล้วต้องถูกบันทึกเสมอ)
  // รีวิวรอบ 4: ลำดับรูปตามกติกาเดียวกับ LINE (imageAfter · รูปก่อนคำถามปิดท้าย — bubbleOrder.mjs) · delivered/acceptedRequestMessages = ลำดับที่ส่งจริง
  async function sendBubbles({ to, replyToken = "", quoteToken = "", bubbles = [], images = [], stickers = [], batch = false, stillRelevant = null, imageAfter = undefined }) {
    void replyToken; void quoteToken; void stickers; // FB ไม่มีของพวกนี้ — จงใจเพิกเฉย ไม่ล้ม
    const textList = Array.isArray(bubbles) ? bubbles : [];
    const imageList = Array.isArray(images) ? images : [];
    if (textList.length + imageList.length === 0) {
      return { ok: false, blocked: false, reason: "empty" };
    }
    if (!sendAllowed()) return { ok: false, blocked: true, reason: "live_send_disabled" };
    if (!outboundIsAllowed(to, "send_bubbles")) return { ok: false, blocked: true, reason: "pilot_not_allowlisted" };
    if (!usingMock && !token()) return { ok: false, blocked: true, reason: "no_access_token" };

    const textMsgs = textList.map((bubble) => ({
      message: {
        type: "text",
        text: typeof bubble === "string" ? bubble : bubble.text,
      },
      pauseSec: typeof bubble === "object" ? bubble.pauseSec ?? 2 : 2,
    }));
    const imageMsgs = imageList.map((image) => ({
      message: { type: "image", originalContentUrl: image.url, previewImageUrl: image.previewUrl || image.url },
      pauseSec: 2,
    }));
    const outbound = orderOutbound({ textMsgs, imageMsgs, imageAfter });

    // แปลงรูปกลาง (ที่ pipeline/console ใช้บันทึกประวัติ) -> payload ของ Send API
    const toFbPayload = (message) => message.type === "image"
      // metadata ต้องติดรูปด้วย — 30 ส.ค. echo รูปที่ไม่มีลายเซ็นถูกตีเป็น "ทีมพิมพ์เอง" → AI off ห้องลูกค้าจริง
      ? { attachment: { type: "image", payload: { url: message.originalContentUrl, is_reusable: false } }, metadata: FB_OUTBOUND_METADATA }
      : { text: message.text, metadata: FB_OUTBOUND_METADATA };

    let calls = 0;
    const delivered = [];
    for (let i = 0; i < outbound.length; i += 1) {
      if (i > 0 && !batch) {
        await sleep(outbound[i].pauseSec * 1000 * (config.sendDelayScale ?? 1));
      }
      // ลูกค้าพิมพ์แทรกระหว่างที่เรากำลังทยอยส่ง — บอลลูนที่เหลือตอบคำถามเก่าไปแล้ว
      // (เคสจริง 1 ก.ย. 2026 ห้อง Facebook: คิดเสร็จ 21:07:20 ด่านก่อนส่งผ่านถูกต้อง
      //  ลูกค้าพิมพ์ใหม่ 21:07:28 ระหว่างหน่วงจังหวะพิมพ์ บอลลูนที่เหลือยังออกต่อจนถึง
      //  21:07:33 แล้วบอทต้องขอโทษตอบใหม่) หยุดตรงนี้ = ลูกค้าเห็นของเก่าน้อยลง
      //  และรอบถัดไปตอบคำถามล่าสุดให้ครบเอง เพราะเห็นประวัติทั้งหมดอยู่แล้ว
      // batch:true still crosses the provider boundary once per Messenger item,
      // so it must recheck before every call too.
      if (i > 0 && stillRelevant && !stillRelevant()) {
        return {
          ok: true, mode: "push", calls, stoppedEarly: true,
          delivered: delivered.slice(), acceptedRequestMessages: delivered.slice(),
        };
      }
      const result = await callSend({
        recipient: { id: String(to) },
        messaging_type: "RESPONSE",
        message: toFbPayload(outbound[i].message),
      });
      if (!result.ok) {
        return { ok: false, mode: "push", calls, failedAt: i, status: result.status, delivered: delivered.slice() };
      }
      calls += 1;
      delivered.push(outbound[i].message);
    }
    return { ok: true, mode: "push", calls, acceptedRequestMessages: outbound.map((item) => item.message) };
  }

  // นโยบายกันแบน: ไม่มีบรอดแคส/multicast ฝั่ง Facebook — blocked เสมอ ไม่มี override
  async function multicast() {
    return { ok: false, blocked: true, reason: "facebook_no_multicast" };
  }

  // typing indicator — best-effort เหมือน loading ของ LINE พังได้โดยไม่กระทบ reply
  async function startLoading({ to } = {}) {
    if (!to) return { ok: false, skipped: "no_target" };
    if (!sendAllowed()) return { ok: false, blocked: true, reason: "live_send_disabled" };
    if (!outboundIsAllowed(to, "start_loading")) return { ok: false, blocked: true, reason: "pilot_not_allowlisted" };
    if (!usingMock && !token()) return { ok: false, blocked: true, reason: "no_access_token" };
    const result = await callSend({ recipient: { id: String(to) }, sender_action: "typing_on" });
    return { ok: result.ok, status: result.status };
  }

  // โปรไฟล์จาก PSID — หัวใจของเกตลูกค้าเก่า Lead Center: ล้มเหลวทุกแบบ = null
  // (ฝั่ง webhook ถือ null เป็น fail-closed — กันไว้ก่อน ไม่ใช่ปล่อยผ่าน)
  async function getProfile({ userId } = {}) {
    if (!userId) return null;
    if (!sendAllowed()) return null;
    if (!usingMock && !token()) return null;
    try {
      const signal = AbortSignal.timeout(PROFILE_TIMEOUT_MS);
      let res = await fetchImpl(
        `${base}/${encodeURIComponent(String(userId))}?fields=first_name,last_name,profile_pic`,
        { method: "GET", headers: { Authorization: `Bearer ${token() || "mock-token"}` }, signal },
      );
      // Meta may reject profile_pic while names are accessible (verified on
      // existing Messenger rooms). Retry names only, once, for field error 100;
      // never retry quota/server errors or loosen authentication/send controls.
      if (!res?.ok && res?.status === 400) {
        const error = await res.json();
        if (error?.error?.code === 100) {
          res = await fetchImpl(
            `${base}/${encodeURIComponent(String(userId))}?fields=first_name,last_name`,
            { method: "GET", headers: { Authorization: `Bearer ${token() || "mock-token"}` }, signal },
          );
        }
      }
      if (!res?.ok) return null;
      const data = await res.json();
      const displayName = [data?.first_name, data?.last_name]
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter(Boolean)
        .join(" ");
      if (!displayName) return null;
      return { displayName, pictureUrl: typeof data?.profile_pic === "string" ? data.profile_pic : "" };
    } catch (err) {
      logger.debug?.(`facebookClient: ดึงโปรไฟล์ไม่ได้ (${err?.name || "Error"})`);
      return null;
    }
  }

  async function getQuota() {
    return null; // FB ไม่มีโควตาแบบ LINE — Overview โชว์ "-"
  }

  // 28 ก.ย. 2026: รหัสเพจของโทเคนนี้ (GET /me) — ลิงก์ "เปิดห้องนี้ใน Business Suite" (businessSuiteLink.mjs)
  // อ่านอย่างเดียว · ตอบผิดรูป/ล้ม = null (ห้ามเดา)
  async function getPageInfo() {
    if (!usingMock && !token()) return null;
    try {
      const res = await fetchImpl(`${base}/me?fields=id,name`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token() || "mock-token"}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res?.ok) return null;
      const data = await res.json();
      const id = typeof data?.id === "string" ? data.id.trim() : "";
      if (!/^\d{5,25}$/u.test(id)) return null;
      return { id, name: typeof data?.name === "string" ? data.name : "" };
    } catch (err) {
      logger.debug?.(`facebookClient: ถามรหัสเพจไม่ได้ (${err?.name || "Error"})`);
      return null;
    }
  }

  // LINE ID (basic ID) มีเฉพาะ LINE — ลิงก์เชิญเลือก OA ของ LINE เท่านั้น
  async function getBotInfo() {
    return null;
  }

  // สถิติรายวันของ LINE ไม่มีคู่เทียบใน Messenger (ส่งฟรีทุกข้อความ) — ตัวดึงสถิติข้ามช่องนี้อยู่แล้ว
  async function getDeliveryInsight() {
    return { ok: false, httpStatus: 0, reason: "not_line" };
  }

  // 28 ก.ย. 2026 สตูดิโอบรอดแคสต์/ข้อความตามขั้น: ช่อง Facebook ไม่มีบรอดแคสต์และห้ามทักนอกหน้าต่าง 24 ชม.
  // (นโยบาย Meta) — ทุกเส้นใหม่ของ LINE ตอบ blocked ที่นี่ ต่อให้ผู้เรียกหลุดมาถึงช่องนี้ก็ส่งไม่ได้
  async function pushMessages() { return { ok: false, blocked: true, reason: "facebook_no_step_messages" }; }
  async function broadcastMessages() { return { ok: false, blocked: true, reason: "facebook_no_broadcast" }; }
  async function narrowcast() { return { ok: false, blocked: true, reason: "facebook_no_broadcast" }; }
  const notLine = async () => ({ ok: false, httpStatus: 0, reason: "not_line" });

  // Facebook แนบไฟล์มาเป็น "URL ชั่วคราวบน CDN ของ Meta" ในตัว webhook เอง (ไม่มี content API
  // แบบ LINE) จึงดาวน์โหลดจาก URL ตรง ๆ — แต่ URL นั้นมาจาก payload ภายนอก ถ้ายิงตามดื้อ ๆ
  // เซิร์ฟเวอร์เราจะกลายเป็นเครื่องมือยิงเป้าหมายภายใน (SSRF) จึงล็อกเฉพาะโดเมน CDN ของ Meta
  function allowedMediaUrl(raw) {
    let parsed = null;
    try { parsed = new URL(String(raw || "")); } catch { return null; }
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.toLowerCase();
    const ok = FB_MEDIA_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
    return ok ? parsed.toString() : null;
  }

  async function getMessageContent(mediaUrl, { maxBytes = 10 * 1024 * 1024 } = {}) {
    if (usingMock) return { ok: false, status: 0, reason: "content_unavailable" };
    const url = allowedMediaUrl(mediaUrl);
    if (!url) return { ok: false, status: 0, reason: "invalid_media_url" };
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(config.lineTimeoutMs ?? 10_000) });
      if (!res.ok) return { ok: false, status: res.status, reason: "provider_rejected" };
      const lengthHeader = res.headers.get("content-length");
      const declaredLength = lengthHeader == null || lengthHeader === "" ? null : Number(lengthHeader);
      if (declaredLength != null && (!Number.isFinite(declaredLength) || declaredLength <= 0 || declaredLength > maxBytes)) {
        try { await res.body?.cancel?.(); } catch { /* noop */ }
        return { ok: false, status: res.status, reason: "content_too_large" };
      }
      if (!res.body) return { ok: false, status: res.status, reason: "empty_content" };
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const chunk = Buffer.from(next.value);
          total += chunk.length;
          if (total > maxBytes) {
            try { await reader.cancel("content_too_large"); } catch { /* noop */ }
            return { ok: false, status: res.status, reason: "content_too_large" };
          }
          chunks.push(chunk);
        }
      } finally {
        try { reader.releaseLock(); } catch { /* noop */ }
      }
      if (!total) return { ok: false, status: res.status, reason: "empty_content" };
      return {
        ok: true, status: res.status, bytes: Buffer.concat(chunks, total),
        mime: String(res.headers.get("content-type") || "").split(";", 1)[0].toLowerCase(),
      };
    } catch (error) {
      return { ok: false, status: 0, reason: "network_error", error: String(error?.message || error) };
    }
  }

  return {
    sendBubbles, multicast, pushMessages, broadcastMessages, narrowcast, startLoading, getProfile, getBotInfo, getPageInfo, getQuota,
    getDeliveryInsight, getNarrowcastProgress: notLine, getAudienceGroups: notLine, getFollowersInsight: notLine,
    getMessageEventInsight: notLine, getAggregationUnitInsight: notLine, getMessageContent, sendAllowed, usingMock,
  };
}
