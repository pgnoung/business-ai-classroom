// lineClient.mjs — ขาออก LINE ทางเดียวของระบบ
//
// กติกา:
// - default LINE_LIVE_SEND=false = fail-closed ไม่ยิง LINE จริงเด็ดขาด
// - LINE_MOCK_URL ตั้งแล้ว = ยิงเข้า mock แทน host จริง (ใช้ตอน dev/smoke)
// - reply token ใช้เมื่ออยู่ใน window (สูงสุด 5 bubbles ต่อ call) ไม่งั้น push
// - ทุก fetch มี AbortSignal.timeout 15s (SPEC ข้อ 5)
// - loading animation = best-effort เท่านั้น พังได้โดยไม่กระทบ reply
// - 28 ก.ย. 2026: ทุกคำขอที่ LINE ตอบรับ แจ้ง onSend (บัญชี lineSendLedger.mjs) พร้อม "เหตุผลการส่ง" (purpose)
//   ที่ผู้เรียกส่งมา — เจ้าของอยากรู้ว่าโควตาไปกับแจ้งเตือนทีม ตอบลูกค้า หรือบรอดแคสต์ บันทึกพัง = ส่งต่อตามปกติ
import { createHmac, timingSafeEqual } from "node:crypto";
import { SEND_PURPOSE, fallbackPurpose, normalizeSendPurpose } from "./lineSendLedger.mjs";
import { orderOutbound } from "./bubbleOrder.mjs";

export const MAX_BUBBLES_PER_REPLY = 5; // identityLinkClasses.mjs แตกข้อความของคลาสตามเพดานนี้ (เทสต์ผูกไว้)
const LINE_API_BASE = "https://api.line.me";
// G2a: GET โปรไฟล์/โควตา — timeout สั้นกว่าขาส่ง (10s ตาม SPEC F1/F7)
const PROFILE_TIMEOUT_MS = 10_000;
const QUOTA_TIMEOUT_MS = 10_000;
// cache โควตาใน memory 5 นาที — Overview โหลดบ่อย ห้ามยิง LINE ทุกครั้ง
const QUOTA_CACHE_TTL_MS = 5 * 60_000;
// สถิติรายวันของ LINE (Insight) — endpoint นี้จำกัด 60 คำขอ/ชม. ต่อ channel (ตัวเรียกคุมจังหวะเอง)
const INSIGHT_TIMEOUT_MS = 10_000;
const INSIGHT_STATUSES = new Set(["ready", "unready", "out_of_service"]);
const INSIGHT_KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/u;
const INSIGHT_MAX_FIELDS = 40;
// 28 ก.ย. 2026 สตูดิโอบรอดแคสต์ — ค่าที่ตรวจกับเอกสารทางการแล้ว (developers.line.biz/en/reference/messaging-api/)
//   customAggregationUnits: ชื่อเดียวต่อคำขอ [a-zA-Z0-9_] ยาวไม่เกิน 30 (#send-push-message-request-body)
//   X-Line-Retry-Key: UUID ที่เราสร้างเอง · LINE จำ 24 ชม. · ส่งซ้ำ = 409 + x-line-accepted-request-id
const AGGREGATION_UNIT_RE = /^[A-Za-z0-9_]{1,30}$/u;
const RETRY_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID_RE = /^[A-Za-z0-9-]{8,64}$/u;
const AUDIENCE_PAGE_SIZE = 40; // เพดานของ LINE ต่อหน้า (#get-audience-groups-query-parameters)
const AUDIENCE_MAX_PAGES = 5;

function lineHeaderId(res, name) {
  try {
    const value = res?.headers?.get?.(name);
    return typeof value === "string" && REQUEST_ID_RE.test(value.trim()) ? value.trim() : "";
  } catch {
    return "";
  }
}

// ตัวเลขจำนวนเต็มไม่ติดลบเท่านั้น · null = LINE ปิดค่าไว้ (น้อยกว่า 20 คน — กติกาความเป็นส่วนตัวของ LINE)
function insightNumber(value) {
  if (value === null) return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

// สถิติการเปิดอ่าน/คลิกของ LINE (event by requestId และ per-unit) — เก็บเฉพาะตัวเลข ไม่มีข้อมูลคน
function normalizeMessageEventInsight(data) {
  if (!data || typeof data !== "object") return null;
  const overview = {};
  for (const [key, value] of Object.entries(data.overview && typeof data.overview === "object" ? data.overview : {})) {
    if (!INSIGHT_KEY.test(key)) continue;
    const number = insightNumber(value);
    if (number !== undefined) overview[key] = number;
    else if (key === "requestId" && typeof value === "string" && REQUEST_ID_RE.test(value)) overview.requestId = value;
    else if (key === "timestamp" && Number.isSafeInteger(value) && value > 0) overview.timestamp = value;
  }
  const messages = (Array.isArray(data.messages) ? data.messages : []).slice(0, 12).map((row) => {
    const out = {};
    for (const key of ["seq", "impression", "uniqueImpression", "mediaPlayed", "uniqueMediaPlayed"]) {
      const number = insightNumber(row?.[key]);
      if (number !== undefined) out[key] = number;
    }
    return out;
  });
  const clicks = (Array.isArray(data.clicks) ? data.clicks : []).slice(0, 30).map((row) => {
    const out = { url: typeof row?.url === "string" ? row.url.slice(0, 1000) : "" };
    for (const key of ["seq", "click", "uniqueClick", "uniqueClickOfRequest"]) {
      const number = insightNumber(row?.[key]);
      if (number !== undefined) out[key] = number;
    }
    return out;
  });
  return { overview, messages, clicks };
}

// ตรวจ HMAC จาก raw body ก่อน parse เสมอ (SPEC server row)
export function verifyLineSignature(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// W3 (multi-OA): channel = { id, channelAccessToken, ... } — ใช้ token ของสาขานั้น
// ไม่ส่ง channel = ใช้ token จาก env (พฤติกรรมเดิมทุกประการ)
// LINE รับได้สูงสุด 5 ข้อความต่อหนึ่งคำขอ
const MAX_MESSAGES_PER_REQUEST = 5;

export function createLineClient({
  config,
  channel = null,
  outboundAllowed = () => true,
  fetchImpl = (...args) => globalThis.fetch(...args),
  sleep = defaultSleep,
  logger = console,
  now = Date.now,
  onSend = null,
}) {
  const usingMock = Boolean(config.lineMockUrl);
  const base = (config.lineMockUrl || LINE_API_BASE).replace(/\/+$/, "");
  const accessToken = channel?.channelAccessToken || config.lineChannelAccessToken;
  const channelId = channel?.id || DEFAULT_CHANNEL_ID;

  function outboundIsAllowed(to, action) {
    try {
      return outboundAllowed({ channelId, to: String(to || ""), action }) === true;
    } catch {
      return false;
    }
  }

  function sendAllowed() {
    // mock = ปลอดภัยเสมอ / live ต้องเปิด flag เอง (fail-closed)
    return usingMock || config.lineLiveSend === true;
  }

  // แจ้งบัญชีการส่งหลัง LINE ตอบรับคำขอหนึ่งคำขอ — ห้ามโยน error และห้ามรอ (การส่งสำคัญกว่าตัวนับเสมอ)
  function noteSend(event) {
    if (typeof onSend !== "function") return;
    try {
      onSend({ channelId, requests: 1, ...event });
    } catch (err) {
      logger.debug?.(`lineClient: บันทึกบัญชีการส่งไม่สำเร็จ (${err?.message || err}) — ไม่กระทบการส่ง`);
    }
  }

  async function callLine(path, body, { headers: extraHeaders = {}, readErrorBody = false } = {}) {
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken || "mock-token"}`,
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(config.lineTimeoutMs),
      });
      // 28 ก.ย. 2026 (สตูดิโอบรอดแคสต์): LINE แนบ X-Line-Request-Id กับทุกคำตอบ — broadcast/narrowcast
      // ใช้เลขนี้ถามสถิติ/ความคืบหน้าทีหลัง · 409 ของ retry key แนบ x-line-accepted-request-id
      const out = {
        ok: Boolean(res?.ok), status: res?.status ?? 0,
        requestId: lineHeaderId(res, "x-line-request-id"),
        acceptedRequestId: lineHeaderId(res, "x-line-accepted-request-id"),
      };
      // 11 ต.ค. 2026: เฉพาะผู้เรียกที่ขอ (แคมเปญ #AIAGENT) — อ่านเหตุผลที่ LINE ปฏิเสธ ไว้แยก "ก้อนข้อความผิดสเปก" ออกจาก "ส่งไม่ถึงคน"
      // ผู้เรียกเดิมไม่ส่ง readErrorBody = เส้นเดิมทุกไบต์ (ไม่อ่าน body)
      if (readErrorBody && !out.ok) {
        try { out.errorDetail = String(await res.text()).replace(/\s+/gu, " ").slice(0, 300); } catch { /* อ่านไม่ได้ = ไม่มีรายละเอียด */ }
      }
      return out;
    } catch (err) {
      logger.warn?.(`lineClient: ${path} ล้มเหลว (${err?.name || "Error"}: ${err?.message || err})`);
      return { ok: false, status: 0, error: String(err?.message || err) };
    }
  }

  // Only accepts a provider message id, never a caller supplied URL. This is
  // intentionally separate from outbound delivery and is used after webhook
  // persistence by the private-media ingest worker.
  async function getMessageContent(messageId, { maxBytes = 10 * 1024 * 1024 } = {}) {
    if (!/^[A-Za-z0-9_-]{1,128}$/u.test(String(messageId || ""))) return { ok: false, status: 0, reason: "invalid_message_id" };
    if (!accessToken || usingMock) return { ok: false, status: 0, reason: "content_unavailable" };
    try {
      const res = await fetchImpl(`https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`, {
        headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(config.lineTimeoutMs),
      });
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
      const bytes = Buffer.concat(chunks, total);
      return { ok: true, status: res.status, bytes, mime: String(res.headers.get("content-type") || "").split(";", 1)[0].toLowerCase() };
    } catch (error) {
      return { ok: false, status: 0, reason: "network_error", error: String(error?.message || error) };
    }
  }

  // ส่งชุด bubble หนึ่งรอบ (text ก่อน แล้วตามด้วยรูปจากแคตตาล็อกที่ pipeline ตรวจแล้ว)
  // รวมทุก message <=5 = reply ครั้งเดียวเมื่อมี token; เกิน 5 = reply แบ่งไม่ได้ -> push ทั้งหมด
  // batch = ส่งทั้งชุดในคำขอเดียว ไม่เว้นช่องไฟระหว่างบับเบิล
  //
  // ใช้กับ follow-up เท่านั้น (คำสั่งเจ้าของ 2026-08-28): ตอนคุยสด ลูกค้าอยู่หน้าจอ
  // ช่องไฟแบบคนพิมพ์จึงมีค่า แต่ตอน follow-up ลูกค้าไม่ได้อยู่ จำลองการพิมพ์ให้ใครดูก็ไม่มี
  // ผลที่ลูกค้าเห็นเหมือนเดิมทุกอย่าง (ยังเป็นหลายบับเบิลในแชท) แต่:
  //   - ยิงคำขอเดียว ไม่ใช่ทีละบับเบิล
  //   - ถ้าล้มก็ล้มทั้งชุด ไม่มีกรณีลูกค้าได้ข้อความครึ่งเดียว (บทเรียนโควตาหมด 2026-08-15)
  //   - ปล่อยล็อกเร็วขึ้น 8-16 วินาทีต่อรอบ
  //
  // purpose = เหตุผลการส่ง (SEND_PURPOSE ใน lineSendLedger.mjs) — ไม่ส่ง = "other"
  // ตอบลูกค้า (customer_reply) ที่ต้องออกทาง push จะถูกบันทึกเป็น customer_reply_fallback พร้อมเหตุ
  // imageAfter (ไม่บังคับ) = จำนวนบอลลูนข้อความก่อนรูป — ทักตามที่แนบรูปบรรยากาศวางรูปต่อจากคำนำของมัน (12 ต.ค. 2026)
  // ไม่ส่ง/ค่าไม่ถูกต้อง = กติกาเดิมทุกไบต์
  async function sendBubbles({ to, replyToken = "", quoteToken = "", bubbles = [], images = [], stickers = [], batch = false, stillRelevant = null, purpose = SEND_PURPOSE.other, imageAfter = undefined }) {
    const textList = Array.isArray(bubbles) ? bubbles : [];
    const imageList = Array.isArray(images) ? images : [];
    const stickerList = Array.isArray(stickers) ? stickers : [];
    if (textList.length + imageList.length + stickerList.length === 0) {
      return { ok: false, blocked: false, reason: "empty" };
    }
    if (!sendAllowed()) {
      return { ok: false, blocked: true, reason: "live_send_disabled" };
    }
    if (!outboundIsAllowed(to, "send_bubbles")) {
      return { ok: false, blocked: true, reason: "pilot_not_allowlisted" };
    }
    if (!usingMock && !accessToken) {
      return { ok: false, blocked: true, reason: "no_access_token" };
    }

    // แต่ละรายการถือ pause ของตัวเองไว้ใช้ในโหมด push (รูปใช้จังหวะ default เท่า bubble)
    // v1.2.1: bubble แรกแนบ quoteToken ของข้อความลูกค้า = LINE แสดงเป็น reply แบบ quote
    // (ลูกค้าเห็นชัดว่าบอทกำลังตอบข้อความไหน — ใช้ได้ทั้ง endpoint reply และ push)
    const textMsgs = textList.map((bubble, index) => ({
      message: {
        type: "text",
        text: typeof bubble === "string" ? bubble : bubble.text,
        ...(index === 0 && quoteToken ? { quoteToken } : {}),
      },
      pauseSec: typeof bubble === "object" ? bubble.pauseSec ?? 2 : 2,
    }));
    const imageMsgs = imageList.map((image) => ({
      message: {
        type: "image",
        originalContentUrl: image.url,
        previewImageUrl: image.previewUrl || image.url,
      },
      pauseSec: 2,
    }));
    const stickerMsgs = stickerList.map((sticker) => ({
      message: { type: "sticker", packageId: String(sticker.packageId), stickerId: String(sticker.stickerId) },
      pauseSec: 2,
    }));
    // FEEDBACK 2026-08-10: ถ้า bubble สุดท้ายเป็นคำถามชวนคุยต่อ ให้ส่งรูปให้จบก่อน
    // แล้วปิดท้ายด้วยคำถามเสมอ — จบด้วยรูปแล้วลูกค้ามักเงียบ · imageAfter = รูปต่อจากคำนำของมัน (กติกากลาง bubbleOrder.mjs ใช้ร่วมกับ Facebook)
    const outbound = orderOutbound({ textMsgs, imageMsgs, stickerMsgs, imageAfter });

    const sendPurpose = normalizeSendPurpose(purpose);
    // เหตุที่ต้องใช้ push แทน reply — ตั้งเฉพาะเมื่อ reply เป็นไปได้หรือเป็นคำตอบลูกค้า
    // (แจ้งเตือนทีม/ทักตาม ไม่มี reply token โดยธรรมชาติ ไม่ต้องติดเหตุ)
    let pushDetail = replyToken
      ? (outbound.length > MAX_BUBBLES_PER_REPLY ? "over_five" : "")
      : (sendPurpose === SEND_PURPOSE.customerReply ? "no_reply_token" : "");
    if (replyToken && outbound.length <= MAX_BUBBLES_PER_REPLY) {
      const result = await callLine("/v2/bot/message/reply", {
        replyToken,
        messages: outbound.map((item) => item.message),
      });
      if (result.ok) {
        noteSend({ method: "reply", purpose: sendPurpose, sends: 1, recipients: 1, messageObjects: outbound.length });
        return {
          ok: true,
          mode: "reply",
          calls: 1,
          // Exact provider-request order. Callers may use this to project
          // Console history, but it remains request acceptance—not delivery or
          // a customer read receipt.
          acceptedRequestMessages: outbound.map((item) => item.message),
        };
      }
      // LINE ตอบ 400 = ปฏิเสธคำขอแน่นอน (เช่น reply token หมดอายุ/ใช้แล้ว)
      // จึงค่อย fallback เป็น push ได้. Network/timeout/5xx เป็นผลลัพธ์กำกวม:
      // provider อาจรับ reply ไปแล้ว ห้าม push ซ้ำเพราะลูกค้าจะได้ข้อความสองชุด.
      if (result.status !== 400) {
        const ambiguous = result.status === 0 || result.status >= 500;
        logger.warn?.(`lineClient: reply ไม่สำเร็จ (status ${result.status}) — ${ambiguous ? "ผลลัพธ์กำกวม ห้าม push ซ้ำ" : "ไม่เข้าเงื่อนไข fallback"}`);
        return {
          ok: false,
          mode: "reply",
          calls: 1,
          status: result.status,
          ambiguous,
          reason: ambiguous ? "reply_outcome_ambiguous" : "reply_rejected_no_fallback",
        };
      }
      logger.warn?.("lineClient: reply ถูกปฏิเสธด้วย HTTP 400 — fallback เป็น push");
      pushDetail = "reply_rejected";
    }

    const pushPurpose = fallbackPurpose(sendPurpose);
    let calls = 0;
    if (batch) {
      // LINE รับได้ 5 ข้อความต่อคำขอ — ชุดที่ยาวกว่านั้นแบ่งเป็นก้อน
      const delivered = [];
      for (let i = 0; i < outbound.length; i += MAX_MESSAGES_PER_REQUEST) {
        // A follow-up can span more than one provider request. Recheck before
        // every chunk so a customer opt-out or takeover after an accepted
        // chunk cannot release a later one.
        if (i > 0 && stillRelevant && !stillRelevant()) {
          return {
            ok: true, mode: "push", calls, stoppedEarly: true,
            delivered: delivered.slice(), acceptedRequestMessages: delivered.slice(),
          };
        }
        const chunk = outbound.slice(i, i + MAX_MESSAGES_PER_REQUEST);
        const result = await callLine("/v2/bot/message/push", { to, messages: chunk.map((item) => item.message) });
        if (!result.ok) {
          return {
            ok: false, mode: "push", calls, failedAt: i, status: result.status,
            delivered: delivered.slice(),
          };
        }
        noteSend({ method: "push", purpose: pushPurpose, detail: pushDetail, sends: calls === 0 ? 1 : 0, recipients: 1, messageObjects: chunk.length });
        calls += 1;
        delivered.push(...chunk.map((item) => item.message));
      }
      return { ok: true, mode: "push", calls, acceptedRequestMessages: outbound.map((item) => item.message) };
    }
    for (let i = 0; i < outbound.length; i += 1) {
      if (i > 0) {
        // คงสูตร pauseSec * 1000 * scale ไว้เหมือนเดิม — เทสต์ตั้ง scale = 0 เพื่อไม่ให้รอจริง
        await sleep(outbound[i].pauseSec * 1000 * (config.sendDelayScale ?? 1));
      // ลูกค้าพิมพ์แทรกระหว่างที่เรากำลังทยอยส่ง — บอลลูนที่เหลือตอบคำถามเก่าไปแล้ว
      // (เคสจริง 1 ก.ย. 2026 ห้อง Facebook: คิดเสร็จ 21:07:20 ด่านก่อนส่งผ่านถูกต้อง
      //  ลูกค้าพิมพ์ใหม่ 21:07:28 ระหว่างหน่วงจังหวะพิมพ์ บอลลูนที่เหลือยังออกต่อจนถึง
      //  21:07:33 แล้วบอทต้องขอโทษตอบใหม่) หยุดตรงนี้ = ลูกค้าเห็นของเก่าน้อยลง
      //  และรอบถัดไปตอบคำถามล่าสุดให้ครบเอง เพราะเห็นประวัติทั้งหมดอยู่แล้ว
        if (stillRelevant && !stillRelevant()) {
          const sent = outbound.slice(0, calls).map((item) => item.message);
          return { ok: true, mode: "push", calls, stoppedEarly: true, delivered: sent, acceptedRequestMessages: sent };
        }
      }
      const result = await callLine("/v2/bot/message/push", { to, messages: [outbound[i].message] });
      // ยิงทีละบอลลูน (จังหวะพิมพ์แบบคน) = LINE นับโควตาทีละคำขอ — sends นับครั้งเดียวต่อการสั่งส่ง
      // เพื่อให้การ์ดบอกได้ว่า "ถ้ารวมบอลลูนเป็นคำขอเดียว จะประหยัดได้เท่าไร"
      if (result.ok) noteSend({ method: "push", purpose: pushPurpose, detail: pushDetail, sends: calls === 0 ? 1 : 0, recipients: 1, messageObjects: 1 });
      if (!result.ok) {
        // v1.4.3 (เคสจริง 2026-08-15: โควตา push รายเดือนหมดกลางบทสนทนา — 429):
        // ข้อความก่อนหน้าในลูป "ถึงมือลูกค้าไปแล้ว" ต้องบอก caller ให้บันทึก
        // ไม่งั้นบทสนทนาใน DB ขาดหาย ทั้งที่ลูกค้าเห็นข้อความจริง
        return {
          ok: false, mode: "push", calls, failedAt: i, status: result.status,
          delivered: outbound.slice(0, calls).map((item) => item.message),
        };
      }
      calls += 1;
    }
    return {
      ok: true,
      mode: "push",
      calls,
      acceptedRequestMessages: outbound.map((item) => item.message),
    };
  }

  // v1.2 (บรอดแคส): multicast ถึงหลายคนในคำขอเดียว (LINE รับสูงสุด 500 id/ครั้ง)
  // โควตานับตามจำนวนผู้รับ; messages <=5 ก้อนต่อครั้ง — caller (broadcast engine) แบ่ง batch เอง
  // 28 ก.ย. 2026: aggregationUnit = ชื่อหน่วยสถิติของ LINE (customAggregationUnits) — ให้บรอดแคสต์ตามป้าย
  // ดูยอดเปิดอ่าน/คลิกจาก LINE ได้ (สถิติแบบ requestId ใช้ได้แค่ broadcast/narrowcast)
  async function multicast({ to = [], messages = [], retryKey = "", aggregationUnit = "", purpose = SEND_PURPOSE.other }) {
    if (!Array.isArray(to) || !to.length || !Array.isArray(messages) || !messages.length) {
      return { ok: false, blocked: false, reason: "empty" };
    }
    if (!sendAllowed()) return { ok: false, blocked: true, reason: "live_send_disabled" };
    if (to.some((target) => !outboundIsAllowed(target, "multicast"))) {
      return { ok: false, blocked: true, reason: "pilot_not_allowlisted" };
    }
    if (!usingMock && !accessToken) return { ok: false, blocked: true, reason: "no_access_token" };
    const key = String(retryKey || "");
    if (key && !RETRY_KEY_RE.test(key)) {
      return { ok: false, blocked: true, reason: "invalid_retry_key" };
    }
    const unit = String(aggregationUnit || "");
    if (unit && !AGGREGATION_UNIT_RE.test(unit)) return { ok: false, blocked: true, reason: "invalid_aggregation_unit" };
    const recipients = to.slice(0, 500);
    const payload = messages.slice(0, 5);
    const result = await callLine("/v2/bot/message/multicast", {
      to: recipients,
      messages: payload,
      ...(unit ? { customAggregationUnits: [unit] } : {}),
    }, { headers: key ? { "x-line-retry-key": key } : {} });
    if (result.ok === true) {
      noteSend({ method: "multicast", purpose: normalizeSendPurpose(purpose), sends: 1, recipients: recipients.length, messageObjects: payload.length });
    }
    return { ok: result.ok === true, status: result.status ?? 0 };
  }

  // 28 ก.ย. 2026: push "ข้อความสำเร็จรูป" (text/image/sticker/flex ที่ประกอบและตรวจแล้ว) ในคำขอเดียว ≤5 ก้อน
  // ผู้ใช้: ส่งทดสอบถึงตัวเองของสตูดิโอ + ข้อความตามขั้น — ไม่มีจังหวะพิมพ์แบบคน (ลูกค้าไม่ได้อยู่หน้าจอ)
  // ambiguous = timeout/0/5xx (LINE อาจรับไปแล้ว) — ผู้เรียกห้ามส่งซ้ำเอง
  async function pushMessages({ to, messages = [], retryKey = "", aggregationUnit = "", purpose = SEND_PURPOSE.other, includeErrorDetail = false }) {
    if (!to || !Array.isArray(messages) || !messages.length) return { ok: false, blocked: false, reason: "empty" };
    if (messages.length > MAX_MESSAGES_PER_REQUEST) return { ok: false, blocked: true, reason: "too_many_messages" };
    if (!sendAllowed()) return { ok: false, blocked: true, reason: "live_send_disabled" };
    if (!outboundIsAllowed(to, "push_messages")) return { ok: false, blocked: true, reason: "pilot_not_allowlisted" };
    if (!usingMock && !accessToken) return { ok: false, blocked: true, reason: "no_access_token" };
    const key = String(retryKey || "");
    if (key && !RETRY_KEY_RE.test(key)) return { ok: false, blocked: true, reason: "invalid_retry_key" };
    const unit = String(aggregationUnit || "");
    if (unit && !AGGREGATION_UNIT_RE.test(unit)) return { ok: false, blocked: true, reason: "invalid_aggregation_unit" };
    const result = await callLine("/v2/bot/message/push", {
      to: String(to), messages,
      ...(unit ? { customAggregationUnits: [unit] } : {}),
    }, { headers: key ? { "x-line-retry-key": key } : {}, ...(includeErrorDetail ? { readErrorBody: true } : {}) });
    // 409 + retry key = LINE รับคำขอเดียวกันนี้ไปแล้วก่อนหน้า (ไม่ใช่การส่งใหม่)
    const duplicate = Boolean(key) && result.status === 409;
    if (result.ok === true) {
      noteSend({ method: "push", purpose: normalizeSendPurpose(purpose), sends: 1, recipients: 1, messageObjects: messages.length });
    }
    return {
      ok: result.ok === true || duplicate, status: result.status ?? 0, duplicate,
      requestId: result.requestId || result.acceptedRequestId || "",
      ambiguous: result.ok !== true && !duplicate && (!result.status || result.status >= 500),
      ...(includeErrorDetail && result.errorDetail ? { errorDetail: result.errorDetail } : {}),
    };
  }

  // 11 ต.ค. 2026 (แคมเปญ #AIAGENT): ตอบด้วย "ข้อความสำเร็จรูป" (text/flex ที่ประกอบและตรวจแล้ว) ≤5 ก้อนผ่าน reply token
  // กติกาเดียวกับ sendBubbles: LINE ตอบ 400 = token ใช้ไม่ได้แน่ → push ทั้งชุดในคำขอเดียว · 0/5xx = กำกวม ห้าม push ซ้ำ
  // ฟังก์ชันใหม่ล้วน — sendBubbles/pushMessages เดิมไม่ถูกแตะ ผู้เรียกเดิมไม่เห็นอะไรเปลี่ยน
  async function replyMessages({ to, replyToken = "", messages = [], purpose = SEND_PURPOSE.customerReply }) {
    if (!Array.isArray(messages) || !messages.length) return { ok: false, blocked: false, reason: "empty" };
    if (messages.length > MAX_MESSAGES_PER_REQUEST) return { ok: false, blocked: true, reason: "too_many_messages" };
    if (!sendAllowed()) return { ok: false, blocked: true, reason: "live_send_disabled" };
    if (!outboundIsAllowed(to, "reply_messages")) return { ok: false, blocked: true, reason: "pilot_not_allowlisted" };
    if (!usingMock && !accessToken) return { ok: false, blocked: true, reason: "no_access_token" };
    const sendPurpose = normalizeSendPurpose(purpose);
    let pushDetail = sendPurpose === SEND_PURPOSE.customerReply ? "no_reply_token" : "";
    if (replyToken) {
      const result = await callLine("/v2/bot/message/reply", { replyToken, messages });
      if (result.ok) {
        noteSend({ method: "reply", purpose: sendPurpose, sends: 1, recipients: 1, messageObjects: messages.length });
        return { ok: true, mode: "reply", calls: 1, acceptedRequestMessages: messages };
      }
      if (result.status !== 400) {
        const ambiguous = result.status === 0 || result.status >= 500;
        logger.warn?.(`lineClient: reply ไม่สำเร็จ (status ${result.status}) — ${ambiguous ? "ผลลัพธ์กำกวม ห้าม push ซ้ำ" : "ไม่เข้าเงื่อนไข fallback"}`);
        return {
          ok: false, mode: "reply", calls: 1, status: result.status, ambiguous,
          reason: ambiguous ? "reply_outcome_ambiguous" : "reply_rejected_no_fallback",
        };
      }
      logger.warn?.("lineClient: reply ถูกปฏิเสธด้วย HTTP 400 — fallback เป็น push");
      pushDetail = "reply_rejected";
    }
    if (!to) return { ok: false, blocked: false, reason: "no_target" };
    const result = await callLine("/v2/bot/message/push", { to: String(to), messages });
    if (!result.ok) {
      return { ok: false, mode: "push", calls: replyToken ? 2 : 1, status: result.status, ambiguous: !result.status || result.status >= 500 };
    }
    noteSend({ method: "push", purpose: fallbackPurpose(sendPurpose), detail: pushDetail, sends: 1, recipients: 1, messageObjects: messages.length });
    return { ok: true, mode: "push", calls: replyToken ? 2 : 1, acceptedRequestMessages: messages };
  }

  // 28 ก.ย. 2026: ส่งถึง "เพื่อนทุกคน" ของ OA (POST /v2/bot/message/broadcast — #send-broadcast-message)
  // - LINE ตอบ 200 + {} · เลขคำขออยู่ใน X-Line-Request-Id (ใช้ถามสถิติ #get-message-event)
  // - ไม่มีรายชื่อผู้รับ → pilot allowlist ตรวจรายคนไม่ได้ = โหมดนำร่องปิดเส้นนี้ทั้งเส้น (fail-closed)
  // - โควตานับตามจำนวนคนที่ได้รับจริง (คนบล็อกไม่นับ) ซึ่งรู้ทีหลัง — บัญชีจด recipients 0 (ไม่ทราบ)
  async function broadcastMessages({ messages = [], retryKey = "", notificationDisabled = false, purpose = SEND_PURPOSE.broadcast } = {}) {
    if (!Array.isArray(messages) || !messages.length) return { ok: false, blocked: false, reason: "empty" };
    if (messages.length > MAX_MESSAGES_PER_REQUEST) return { ok: false, blocked: true, reason: "too_many_messages" };
    if (!sendAllowed()) return { ok: false, blocked: true, reason: "live_send_disabled" };
    if (!outboundIsAllowed("__all_friends__", "broadcast")) return { ok: false, blocked: true, reason: "pilot_mode_blocks_broadcast" };
    if (!usingMock && !accessToken) return { ok: false, blocked: true, reason: "no_access_token" };
    const key = String(retryKey || "");
    if (key && !RETRY_KEY_RE.test(key)) return { ok: false, blocked: true, reason: "invalid_retry_key" };
    const result = await callLine("/v2/bot/message/broadcast", {
      messages, ...(notificationDisabled === true ? { notificationDisabled: true } : {}),
    }, { headers: key ? { "x-line-retry-key": key } : {} });
    const duplicate = Boolean(key) && result.status === 409;
    if (result.ok === true) {
      noteSend({ method: "broadcast", purpose: normalizeSendPurpose(purpose), sends: 1, recipients: 0, messageObjects: messages.length });
    }
    return {
      ok: result.ok === true || duplicate, status: result.status ?? 0, duplicate,
      requestId: result.requestId || result.acceptedRequestId || "",
      ambiguous: result.ok !== true && !duplicate && (!result.status || result.status >= 500),
    };
  }

  // 28 ก.ย. 2026: ส่งแบบเลือกกลุ่มของ LINE (POST /v2/bot/message/narrowcast — #send-narrowcast-message)
  // recipient = กลุ่มเป้าหมาย (audience) · filter = ข้อมูลประชากร · limit = เพดานโควตา
  // LINE ตอบ 202 แล้วส่งเบื้องหลัง — ผลจริงถามจาก getNarrowcastProgress(requestId)
  async function narrowcast({ messages = [], recipient = null, filter = null, limit = null, retryKey = "", notificationDisabled = false, purpose = SEND_PURPOSE.broadcast } = {}) {
    if (!Array.isArray(messages) || !messages.length) return { ok: false, blocked: false, reason: "empty" };
    if (messages.length > MAX_MESSAGES_PER_REQUEST) return { ok: false, blocked: true, reason: "too_many_messages" };
    if (!sendAllowed()) return { ok: false, blocked: true, reason: "live_send_disabled" };
    if (!outboundIsAllowed("__all_friends__", "narrowcast")) return { ok: false, blocked: true, reason: "pilot_mode_blocks_broadcast" };
    if (!usingMock && !accessToken) return { ok: false, blocked: true, reason: "no_access_token" };
    const key = String(retryKey || "");
    if (key && !RETRY_KEY_RE.test(key)) return { ok: false, blocked: true, reason: "invalid_retry_key" };
    const body = { messages };
    if (recipient && typeof recipient === "object") body.recipient = recipient;
    if (filter && typeof filter === "object") body.filter = filter;
    if (limit && typeof limit === "object") body.limit = limit;
    if (notificationDisabled === true) body.notificationDisabled = true;
    const result = await callLine("/v2/bot/message/narrowcast", body, { headers: key ? { "x-line-retry-key": key } : {} });
    const duplicate = Boolean(key) && result.status === 409;
    if (result.ok === true) {
      noteSend({ method: "narrowcast", purpose: normalizeSendPurpose(purpose), sends: 1, recipients: 0, messageObjects: messages.length });
    }
    return {
      ok: result.ok === true || duplicate, status: result.status ?? 0, duplicate,
      requestId: result.requestId || result.acceptedRequestId || "",
      ambiguous: result.ok !== true && !duplicate && (!result.status || result.status >= 500),
    };
  }

  // best-effort: โชว์ "กำลังพิมพ์..." ฝั่งลูกค้า (LINE loading animation, มือถือเท่านั้น)
  // - loadingSeconds ตามสเปค LINE: ทวีคูณของ 5 ในช่วง 5-60 — ปัด/หนีบให้อัตโนมัติ
  // - พังทุกกรณี = log ระดับ debug แล้วไปต่อ ห้ามกระทบเส้นทาง reply เด็ดขาด
  // - fail-closed เดียวกับ sendBubbles: mock ได้เสมอ / live ต้องเปิด LINE_LIVE_SEND เอง
  async function startLoading({ to, seconds = 20 } = {}) {
    if (!to) return { ok: false, skipped: "no_target" };
    if (!sendAllowed()) return { ok: false, blocked: true, reason: "live_send_disabled" };
    if (!outboundIsAllowed(to, "start_loading")) return { ok: false, blocked: true, reason: "pilot_not_allowlisted" };
    if (!usingMock && !accessToken) {
      return { ok: false, blocked: true, reason: "no_access_token" };
    }
    const rounded = Math.round(Number(seconds) / 5) * 5;
    const loadingSeconds = Number.isFinite(rounded) ? Math.min(60, Math.max(5, rounded)) : 20;
    try {
      const res = await fetchImpl(`${base}/v2/bot/chat/loading/start`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${accessToken || "mock-token"}`,
        },
        body: JSON.stringify({ chatId: to, loadingSeconds }),
        signal: AbortSignal.timeout(config.lineTimeoutMs),
      });
      if (!res?.ok) {
        logger.debug?.(`lineClient: loading animation ตอบ status ${res?.status ?? "?"} — ข้าม (best-effort)`);
      }
      return { ok: Boolean(res?.ok), status: res?.status ?? 0 };
    } catch (err) {
      logger.debug?.(`lineClient: loading animation ล้มเหลว (${err?.message || err}) — ไม่กระทบ reply`);
      return { ok: false, status: 0 };
    }
  }

  // GET กลับ LINE API (โปรไฟล์/โควตา) — ทุกความล้มเหลวคืน null ห้าม throw
  async function getJson(path, timeoutMs) {
    try {
      const res = await fetchImpl(`${base}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken || "mock-token"}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res?.ok) {
        logger.debug?.(`lineClient: GET ${path} ตอบ status ${res?.status ?? "?"}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      logger.debug?.(`lineClient: GET ${path} ล้มเหลว (${err?.name || "Error"}: ${err?.message || err})`);
      return null;
    }
  }

  // F1: ดึงโปรไฟล์ลูกค้า — ล้มเหลวทุกแบบ = null ให้ caller ใช้ fallback "ลูกค้า <ท้าย id>"
  // fail-closed เดียวกับขาส่ง: mock ได้เสมอ / live ต้องเปิด LINE_LIVE_SEND + มี token
  async function getProfile({ userId } = {}) {
    if (!userId) return null;
    if (!sendAllowed()) return null;
    if (!usingMock && !accessToken) return null;
    const data = await getJson(`/v2/bot/profile/${encodeURIComponent(String(userId))}`, PROFILE_TIMEOUT_MS);
    const displayName = typeof data?.displayName === "string" ? data.displayName.trim() : "";
    if (!displayName) return null;
    return {
      displayName,
      pictureUrl: typeof data.pictureUrl === "string" ? data.pictureUrl : "",
    };
  }

  // 28 ก.ย. 2026: LINE ID ของ OA ที่โทเคนนี้เป็นเจ้าของ (basic ID เช่น "@abc1234") — ลิงก์เชิญจาก Facebook
  // (identityLink.mjs) ใช้เมื่อไม่ได้ตั้ง LINE_BASIC_ID · GET /v2/bot/info อ่านอย่างเดียว · ตอบผิดรูป/ล้ม = null (ห้ามเดา)
  async function getBotInfo() {
    if (!sendAllowed()) return null;
    if (!usingMock && !accessToken) return null;
    const data = await getJson("/v2/bot/info", PROFILE_TIMEOUT_MS);
    const basicId = typeof data?.basicId === "string" ? data.basicId.trim() : "";
    if (!basicId) return null;
    // 30 ก.ย. 2026: premium ID (เช่น @pngoung) ถ้า OA ซื้อไว้ — จำง่ายกว่า basic ID สุ่ม (@093kafsy) ให้ลูกค้าค้นหาเอง
    const premiumId = typeof data?.premiumId === "string" ? data.premiumId.trim() : "";
    return { basicId, premiumId, displayName: typeof data.displayName === "string" ? data.displayName : "" };
  }

  // F7: โควตาข้อความเดือนนี้ — cache ใน memory 5 นาที (cache เฉพาะผลสำเร็จ)
  // คืน { type: "limited"|"none", value, totalUsage, cachedAt } หรือ null
  let quotaCache = null;
  async function getQuota({ force = false } = {}) {
    if (!sendAllowed()) return null;
    if (!usingMock && !accessToken) return null;
    const t = now();
    if (!force && quotaCache && t - quotaCache.cachedAt < QUOTA_CACHE_TTL_MS) return quotaCache.data;

    const [quota, consumption] = await Promise.all([
      getJson("/v2/bot/message/quota", QUOTA_TIMEOUT_MS),
      getJson("/v2/bot/message/quota/consumption", QUOTA_TIMEOUT_MS),
    ]);
    const type = quota?.type === "limited" ? "limited" : quota?.type === "none" ? "none" : null;
    if (!type) return null; // endpoint พัง/รูปทรงแปลก = null — หน้า Overview โชว์ "-" แทน
    const value = type === "limited" ? Number(quota.value) : null;
    if (type === "limited" && !Number.isFinite(value)) return null;
    const totalUsage = Number(consumption?.totalUsage);
    if (!Number.isFinite(totalUsage)) return null;

    const data = { type, value, totalUsage, cachedAt: t };
    quotaCache = { data, cachedAt: t };
    return data;
  }

  // 28 ก.ย. 2026: สถิติทางการรายวันของ LINE — "Get number of message deliveries"
  // GET /v2/bot/insight/message/delivery?date=YYYYMMDD (วันตามเวลาญี่ปุ่น UTC+9 · 60 คำขอ/ชม.)
  // developers.line.biz/en/reference/messaging-api/#get-number-of-delivery-messages (ตรวจ 28 ก.ย. 2026)
  // คืน { ok:true, status, counts } หรือ { ok:false, httpStatus, reason } — ไม่ throw
  // counts เก็บเฉพาะช่องที่เป็นตัวเลขจำนวนเต็มไม่ติดลบ (LINE เพิ่มช่องใหม่ได้เรื่อย ๆ จึงไม่ล็อกรายชื่อ)
  async function getDeliveryInsight({ date } = {}) {
    const day = String(date || "");
    if (!/^\d{8}$/u.test(day)) return { ok: false, httpStatus: 0, reason: "invalid_date" };
    if (!sendAllowed()) return { ok: false, httpStatus: 0, reason: "live_send_disabled" };
    if (!usingMock && !accessToken) return { ok: false, httpStatus: 0, reason: "no_access_token" };
    let res;
    try {
      res = await fetchImpl(`${base}/v2/bot/insight/message/delivery?date=${day}`, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken || "mock-token"}` },
        signal: AbortSignal.timeout(INSIGHT_TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, httpStatus: 0, reason: err?.name === "TimeoutError" ? "timeout" : "network_error" };
    }
    if (!res?.ok) return { ok: false, httpStatus: Number(res?.status) || 0, reason: "http_error" };
    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, httpStatus: Number(res.status) || 200, reason: "bad_json" };
    }
    const status = typeof data?.status === "string" && INSIGHT_STATUSES.has(data.status) ? data.status : null;
    if (!status) return { ok: false, httpStatus: Number(res.status) || 200, reason: "bad_shape" };
    const counts = {};
    if (status === "ready") {
      for (const [key, value] of Object.entries(data)) {
        if (key === "status" || !INSIGHT_KEY.test(key)) continue;
        if (!Number.isSafeInteger(value) || value < 0) continue;
        if (Object.keys(counts).length >= INSIGHT_MAX_FIELDS) break;
        counts[key] = value;
      }
    }
    return { ok: true, status, counts };
  }

  // GET แบบบอกสถานะ HTTP ด้วย (ผู้เรียกต้องแยก "ไม่มีข้อมูล" ออกจาก "ยิงไม่สำเร็จ") — ไม่ throw
  async function getJsonDetailed(path, timeoutMs = INSIGHT_TIMEOUT_MS) {
    if (!sendAllowed()) return { ok: false, httpStatus: 0, reason: "live_send_disabled" };
    if (!usingMock && !accessToken) return { ok: false, httpStatus: 0, reason: "no_access_token" };
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: "GET",
        headers: { authorization: `Bearer ${accessToken || "mock-token"}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      return { ok: false, httpStatus: 0, reason: err?.name === "TimeoutError" ? "timeout" : "network_error" };
    }
    if (!res?.ok) return { ok: false, httpStatus: Number(res?.status) || 0, reason: "http_error" };
    try {
      return { ok: true, httpStatus: Number(res.status) || 200, data: await res.json() };
    } catch {
      return { ok: false, httpStatus: Number(res.status) || 200, reason: "bad_json" };
    }
  }

  // ความคืบหน้าของ narrowcast (#get-narrowcast-progress-status) — phase: waiting|sending|succeeded|failed
  // LINE เก็บให้ถาม 14 วันหลัง acceptedTime (เกินแล้ว 404)
  async function getNarrowcastProgress({ requestId } = {}) {
    const id = String(requestId || "");
    if (!REQUEST_ID_RE.test(id)) return { ok: false, httpStatus: 0, reason: "invalid_request_id" };
    const result = await getJsonDetailed(`/v2/bot/message/progress/narrowcast?requestId=${encodeURIComponent(id)}`);
    if (!result.ok) return result;
    const data = result.data || {};
    const phase = ["waiting", "sending", "succeeded", "failed"].includes(data.phase) ? data.phase : null;
    if (!phase) return { ok: false, httpStatus: result.httpStatus, reason: "bad_shape" };
    const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
    return {
      ok: true, phase,
      successCount: count(data.successCount), failureCount: count(data.failureCount), targetCount: count(data.targetCount),
      errorCode: Number.isSafeInteger(data.errorCode) ? data.errorCode : null,
      failedDescription: typeof data.failedDescription === "string" ? data.failedDescription.slice(0, 200) : "",
      acceptedTime: typeof data.acceptedTime === "string" ? data.acceptedTime.slice(0, 40) : "",
      completedTime: typeof data.completedTime === "string" ? data.completedTime.slice(0, 40) : "",
    };
  }

  // กลุ่มเป้าหมาย (audience) ของ OA นี้ (#get-audience-groups) — รวมกลุ่มที่สร้างใน OA Manager
  // (แท็กแชท / ช่องทางเพิ่มเพื่อน ฯลฯ ใช้กับ narrowcast ได้ตามเอกสาร using-audience#audience-sharing)
  async function getAudienceGroups() {
    const groups = [];
    for (let page = 1; page <= AUDIENCE_MAX_PAGES; page += 1) {
      const result = await getJsonDetailed(`/v2/bot/audienceGroup/list?page=${page}&size=${AUDIENCE_PAGE_SIZE}`);
      if (!result.ok) return page === 1 ? result : { ok: true, groups, truncated: true };
      const rows = Array.isArray(result.data?.audienceGroups) ? result.data.audienceGroups : [];
      for (const row of rows) {
        const id = Number(row?.audienceGroupId);
        if (!Number.isSafeInteger(id) || id <= 0) continue;
        groups.push({
          audienceGroupId: id,
          type: typeof row.type === "string" ? row.type.slice(0, 40) : "",
          createRoute: typeof row.createRoute === "string" ? row.createRoute.slice(0, 40) : "",
          description: typeof row.description === "string" ? row.description.slice(0, 120) : "",
          status: typeof row.status === "string" ? row.status.slice(0, 20) : "",
          audienceCount: Number.isSafeInteger(row.audienceCount) && row.audienceCount >= 0 ? row.audienceCount : null,
          created: Number.isSafeInteger(row.created) ? row.created : null,
          permission: typeof row.permission === "string" ? row.permission.slice(0, 20) : "",
          isIfaAudience: row.isIfaAudience === true,
          expireTimestamp: Number.isSafeInteger(row.expireTimestamp) ? row.expireTimestamp : null,
        });
      }
      if (result.data?.hasNextPage !== true) return { ok: true, groups, truncated: false };
    }
    return { ok: true, groups, truncated: true };
  }

  // จำนวนเพื่อน (#get-number-of-followers) — date = YYYYMMDD เวลาญี่ปุ่น
  // followers นับทุกคนที่เคยเพิ่ม (ไม่ลดเมื่อบล็อก) · blocks = บล็อกอยู่ · targetedReaches = คนที่ LINE ระบุข้อมูลประชากรได้
  async function getFollowersInsight({ date } = {}) {
    const day = String(date || "");
    if (!/^\d{8}$/u.test(day)) return { ok: false, httpStatus: 0, reason: "invalid_date" };
    const result = await getJsonDetailed(`/v2/bot/insight/followers?date=${day}`);
    if (!result.ok) return result;
    const data = result.data || {};
    const status = typeof data.status === "string" && INSIGHT_STATUSES.has(data.status) ? data.status : null;
    if (!status) return { ok: false, httpStatus: result.httpStatus, reason: "bad_shape" };
    const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
    return { ok: true, status, followers: count(data.followers), targetedReaches: count(data.targetedReaches), blocks: count(data.blocks) };
  }

  // สถิติการเปิดอ่าน/คลิกของ broadcast/narrowcast หนึ่งคำขอ (#get-message-event)
  async function getMessageEventInsight({ requestId } = {}) {
    const id = String(requestId || "");
    if (!REQUEST_ID_RE.test(id)) return { ok: false, httpStatus: 0, reason: "invalid_request_id" };
    const result = await getJsonDetailed(`/v2/bot/insight/message/event?requestId=${encodeURIComponent(id)}`);
    if (!result.ok) return result;
    const insight = normalizeMessageEventInsight(result.data);
    return insight ? { ok: true, ...insight } : { ok: false, httpStatus: result.httpStatus, reason: "bad_shape" };
  }

  // สถิติของ push/multicast ตามชื่อหน่วย (#get-statistics-per-unit) — from/to = YYYYMMDD เวลาญี่ปุ่น ห่างไม่เกิน 30 วัน
  async function getAggregationUnitInsight({ unit, from, to } = {}) {
    const name = String(unit || "");
    if (!AGGREGATION_UNIT_RE.test(name) || !/^\d{8}$/u.test(String(from || "")) || !/^\d{8}$/u.test(String(to || ""))) {
      return { ok: false, httpStatus: 0, reason: "invalid_query" };
    }
    const query = `customAggregationUnit=${encodeURIComponent(name)}&from=${from}&to=${to}`;
    const result = await getJsonDetailed(`/v2/bot/insight/message/event/aggregation?${query}`);
    if (!result.ok) return result;
    const insight = normalizeMessageEventInsight(result.data);
    return insight ? { ok: true, ...insight } : { ok: false, httpStatus: result.httpStatus, reason: "bad_shape" };
  }

  return {
    sendBubbles, multicast, pushMessages, replyMessages, broadcastMessages, narrowcast, startLoading, getProfile, getBotInfo, getQuota,
    getDeliveryInsight, getNarrowcastProgress, getAudienceGroups, getFollowersInsight, getMessageEventInsight,
    getAggregationUnitInsight, getMessageContent, sendAllowed, usingMock,
  };
}

/* ------------------------- W3: multi-OA line registry ------------------------- */
// client ต่อสาขา (สร้างครั้งเดียวต่อ channel — quota cache แยกกันเอง) + ตัวช่วยถอด
// raw LINE user id จาก customer key (ดู scheme ใน src/channels.mjs)
// forChannel(id ที่ไม่รู้จัก/ไม่ส่ง) = client ของ channel "default" (โหมด legacy เดิม)
import { DEFAULT_CHANNEL_ID, splitCustomerKey } from "./channels.mjs";
import { createFacebookClient } from "./facebookClient.mjs";

// onSend = ตัวบันทึกบัญชีการส่ง (lineSendLedger.mjs) — ใส่ให้เฉพาะ client ของ LINE
// (Facebook ส่งฟรีทุกข้อความ ไม่มีโควตาให้แยก จึงไม่ต้องบันทึก)
export function createLineRegistry({ config, channels = [], fetchImpl, sleep, logger = console, now = Date.now, outboundAllowed, onSend = null }) {
  const byId = new Map(channels.map((ch) => [ch.id, ch]));
  const knownIds = new Set(byId.keys());
  const clients = new Map();
  // legacy fallback: ไม่มี channel "default" ในไฟล์ = client จาก env เดิม (fail-closed ถ้าไม่มี token)
  const fallbackChannel = byId.get(DEFAULT_CHANNEL_ID) ?? null;

  function forChannel(channelId) {
    const id = byId.has(channelId) ? channelId : DEFAULT_CHANNEL_ID;
    if (!clients.has(id)) {
      const channel = byId.get(id) ?? fallbackChannel;
      // v1.5: channel ที่ประกาศ provider "facebook" ได้ client ของ Messenger แทน —
      // interface ตรงกันทุก method ผู้เรียก (pipeline/FU/console) ไม่ต้องรู้จัก provider
      clients.set(id, channel?.provider === "facebook"
        ? createFacebookClient({
            config, credentials: channel.credentials, fetchImpl, sleep, logger, outboundAllowed,
          })
        : createLineClient({
            config, channel, fetchImpl, sleep, logger, now, outboundAllowed, onSend,
          }));
    }
    return clients.get(id);
  }

  return {
    forChannel,
    forCustomerKey: (key) => forChannel(splitCustomerKey(key, knownIds).channelId),
    channelIdOf: (key) => splitCustomerKey(key, knownIds).channelId,
    rawUserId: (key) => splitCustomerKey(key, knownIds).userId,
    tokenFor: (channelId) => byId.get(channelId)?.channelAccessToken || config.lineChannelAccessToken,
    nameFor: (channelId) => byId.get(channelId)?.name || "",
    channels,
    knownIds,
  };
}
