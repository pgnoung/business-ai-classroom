// slipCheck.mjs — G3/W2: ตรวจสลิปอัตโนมัติ (pre-check ให้แอดมิน — pluggable, fail-closed)
//
// กติกาเหล็ก (แผนแม่บท — ห้ามละเมิด):
// - บอทไม่เคยยืนยันยอดเงินกับลูกค้า — เส้นทางตอบลูกค้าเมื่อได้รูป (template สุภาพ +
//   NEEDS_HUMAN) เหมือนเดิมทุกตัวอักษร ผลตรวจเป็นข้อมูลช่วยแอดมินใน console เท่านั้น
// - ระบบ provider (W2): SLIP_PROVIDER = slipok | webhook | off
//     slipok  = SlipOK API จริง (ต้องมี SLIPOK_API_KEY + SLIPOK_BRANCH_ID ครบ)
//     webhook = generic webhook เดิม (SLIP_CHECK_URL เช่น Make scenario)
//     ไม่ตั้ง = อนุมานแบบ legacy: มี SLIP_CHECK_URL = webhook, ไม่มี = off
//   ทุกทางที่ config ไม่ครบ = off สนิท (enabled=false, ไม่มี call ใด ๆ) — fail-closed
// - fire-and-forget: ช้า/พังแค่ไหนห้ามหน่วงหรือเปลี่ยนผล pipeline — ไม่มี throw หลุด
// - ดาวน์โหลดรูปตามแบบแผน transcribe.mjs (api-data host, timeout, เพดาน 15MB,
//   buffer ตายพร้อม scope — ไม่เก็บ binary ลง DB) — W3: token ของสาขาลูกค้าชนะ env
// - ผลตรวจ -> ตาราง slip_checks + ต่อท้าย handoff summary (NEEDS_HUMAN) ให้คนเห็นทันที
// - W2 amount cross-check: เทียบยอดสลิปกับ "ยอดที่ AI เพิ่งแจ้งลูกค้า" (ตัวเลขจาก
//   ตาราง approved_prices ที่โผล่ใน outbound ล่าสุดภายใน 24 ชม. — best effort, null ได้)
//   แล้วเขียน "ยอดตรง / ยอดไม่ตรง (คาด X ได้ Y)" ลง summary ให้แอดมิน

const LINE_DATA_API_BASE = "https://api-data.line.me"; // host คนละตัวกับ api.line.me
const SLIPOK_API_BASE = "https://api.slipok.com/api/line/apikey";
const DOWNLOAD_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 45_000;
export const MAX_SLIP_BYTES = 15 * 1024 * 1024;
const QUOTE_WINDOW_MS = 24 * 3_600_000; // มองย้อน "ยอดที่แจ้งลูกค้า" 24 ชม.
const QUOTE_SCAN_MESSAGES = 50;

// ตรรกะเดียวกับ startupReport ใน config.mjs — แก้ที่หนึ่งต้องแก้อีกที่
export function resolveSlipProvider(config) {
  const p = String(config.slipProvider || "").toLowerCase();
  if (p === "off") return "off";
  if (p === "slipok") return config.slipokApiKey && config.slipokBranchId ? "slipok" : "off";
  if (p === "webhook") return config.slipCheckUrl ? "webhook" : "off";
  return config.slipCheckUrl ? "webhook" : "off"; // legacy: ไม่ตั้ง SLIP_PROVIDER
}

// W2: หายอดล่าสุดที่ "ฝั่งเรา" แจ้งลูกค้าใน 24 ชม. — นับเฉพาะตัวเลขที่อยู่ในตาราง
// approved_prices เท่านั้น (กันจับเบอร์โทร/รุ่นสินค้า) — best effort, ไม่เจอ = null
export function findRecentQuotedTotal({ db, customerId, nowMs = Date.now() }) {
  const prices = db.approvedPrices();
  if (!prices.length) return null;
  const approved = new Set(prices.map((p) => Number(p.amount)).filter(Number.isFinite));
  if (!approved.size) return null;
  const cutoff = nowMs - QUOTE_WINDOW_MS;
  const messages = db.messagesFor(customerId, QUOTE_SCAN_MESSAGES); // เรียงเก่า -> ใหม่
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (m.direction !== "out" || m.msg_type !== "text" || Number(m.created_at) < cutoff) continue;
    const numbers = String(m.content).match(/\d[\d,]*(?:\.\d+)?/g) || [];
    // ยอดรวมมักอยู่ท้ายประโยค — สแกนจากตัวเลขหลังสุดของข้อความล่าสุดก่อน
    for (let j = numbers.length - 1; j >= 0; j -= 1) {
      const value = Number(numbers[j].replace(/,/g, ""));
      if (approved.has(value)) return value;
    }
  }
  return null;
}

// บรรทัดเทียบยอด — มีครบทั้งยอดสลิปและยอดที่แจ้งลูกค้าเท่านั้นถึงจะพูด
function amountCheckNote(data) {
  const amount = Number(data?.amount);
  const expected = Number(data?.expectedAmount);
  if (!Number.isFinite(amount) || !Number.isFinite(expected)) return "";
  return amount === expected
    ? " · ยอดตรง"
    : ` · ยอดไม่ตรง (คาด ${expected.toLocaleString("th-TH")} ได้ ${amount.toLocaleString("th-TH")})`;
}

// สรุปผลหนึ่งบรรทัดสำหรับ handoff summary — แอดมินอ่านแล้วรู้ทันทีว่าต้องทำอะไรต่อ
// (ข้อความ base เดิมห้ามเปลี่ยน — บรรทัดเทียบยอดต่อท้ายเฉพาะเมื่อรู้ expectedAmount)
export function summarizeSlipResult(status, data = {}) {
  if (status === "valid") {
    const amount = Number(data?.amount);
    const base = Number.isFinite(amount)
      ? `สลิปตรวจแล้ว: ✅ ยอด ${amount.toLocaleString("th-TH")} ตรง`
      : "สลิปตรวจแล้ว: ✅ ผ่านการตรวจอัตโนมัติ";
    return `${base}${amountCheckNote(data)}`;
  }
  if (status === "suspect") {
    const reason = typeof data?.reason === "string" && data.reason.trim() ? data.reason.trim() : "ไม่ผ่านการตรวจอัตโนมัติ";
    return `⚠️ สลิปน่าสงสัย: ${reason}${amountCheckNote(data)}`;
  }
  return "สลิปตรวจอัตโนมัติไม่ได้ — ให้คนตรวจ";
}

export function createSlipChecker({ config, db, fetchImpl = (...args) => globalThis.fetch(...args), logger = console }) {
  const provider = resolveSlipProvider(config);
  const enabled = provider !== "off";
  const usingMock = Boolean(config.lineMockUrl);
  const lineBase = (config.lineMockUrl || LINE_DATA_API_BASE).replace(/\/+$/, "");

  // GET เนื้อไฟล์รูปจาก LINE — ทุกความล้มเหลวคืน { ok:false, reason } ห้าม throw
  // W3: accessToken (token ของสาขา) ชนะ env — ไม่ส่งมา = ใช้ env (พฤติกรรมเดิม)
  async function downloadImage(messageId, accessToken = null) {
    const token = accessToken || config.lineChannelAccessToken;
    if (!usingMock && !(config.lineLiveSend === true && token)) {
      return { ok: false, reason: "line_blocked" };
    }
    let res;
    try {
      res = await fetchImpl(`${lineBase}/v2/bot/message/${encodeURIComponent(String(messageId))}/content`, {
        method: "GET",
        headers: { authorization: `Bearer ${token || "mock-token"}` },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn?.(`slipCheck: ดาวน์โหลดรูปล้มเหลว (${err?.name || "Error"}: ${err?.message || err})`);
      return { ok: false, reason: "download_failed" };
    }
    if (!res?.ok) return { ok: false, reason: `download_http_${res?.status ?? "?"}` };
    const declared = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_SLIP_BYTES) {
      return { ok: false, reason: "image_too_large" };
    }
    let buffer;
    try {
      buffer = Buffer.from(await res.arrayBuffer());
    } catch {
      return { ok: false, reason: "download_read_failed" };
    }
    if (buffer.length === 0) return { ok: false, reason: "image_empty" };
    if (buffer.length > MAX_SLIP_BYTES) return { ok: false, reason: "image_too_large" };
    return { ok: true, buffer, contentType: res.headers?.get?.("content-type") || "image/jpeg" };
  }

  // POST ไป generic webhook (เช่น Make scenario เดิม) — ตอบไม่เป็น JSON/ไม่มี valid boolean = error
  async function callWebhook(payload) {
    let res;
    try {
      res = await fetchImpl(config.slipCheckUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.slipCheckToken ? { authorization: `Bearer ${config.slipCheckToken}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn?.(`slipCheck: เรียกตัวตรวจล้มเหลว (${err?.name || "Error"}: ${err?.message || err})`);
      return { ok: false, reason: "check_failed" };
    }
    if (!res?.ok) return { ok: false, reason: `check_http_${res?.status ?? "?"}` };
    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, reason: "check_bad_json" };
    }
    if (!data || typeof data !== "object" || typeof data.valid !== "boolean") {
      return { ok: false, reason: "check_bad_payload" };
    }
    return { ok: true, data };
  }

  // ชื่อคน/บัญชีจาก SlipOK — เป็น object ซ้อน (displayName/name) หรือสตริงก็ได้
  function slipokPartyName(party) {
    if (!party) return "";
    if (typeof party === "string") return party;
    return String(party.displayName || party.name || "").trim();
  }

  // W2: SlipOK จริง — POST https://api.slipok.com/api/line/apikey/{branchId}
  //   header x-authorization: SLIPOK_API_KEY, body { data: <base64>, log: true }
  // การตีความผล (สำคัญ — อย่าสลับ):
  //   - body.success === true  -> สลิปจริง (valid) + ข้อมูล data.{transRef,amount,...}
  //   - body.success === false + message/code -> สลิปมีปัญหา (suspect) เช่น
  //     "สลิปซ้ำ" / "ไม่พบรายการ" — SlipOK ตอบเคสพวกนี้เป็น HTTP 400 พร้อม JSON
  //     จึงต้อง parse body ก่อนตัดสินจาก HTTP status
  //   - fetch พัง / timeout / body parse ไม่ได้ / ไม่มี success boolean -> error (ให้คนตรวจ)
  async function callSlipOk(imageBase64) {
    let res;
    try {
      res = await fetchImpl(`${SLIPOK_API_BASE}/${encodeURIComponent(String(config.slipokBranchId))}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-authorization": config.slipokApiKey,
        },
        body: JSON.stringify({ data: imageBase64, log: true }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn?.(`slipCheck: เรียก SlipOK ล้มเหลว (${err?.name || "Error"}: ${err?.message || err})`);
      return { ok: false, reason: "check_failed" };
    }
    let body = null;
    try {
      body = await res?.json();
    } catch {
      body = null;
    }
    if (body && typeof body === "object" && typeof body.success === "boolean") {
      if (body.success === true) {
        const d = body.data && typeof body.data === "object" ? body.data : {};
        const amount = Number(d.amount);
        return {
          ok: true,
          data: {
            valid: true,
            amount: Number.isFinite(amount) ? amount : null,
            transRef: typeof d.transRef === "string" ? d.transRef : "",
            sender: slipokPartyName(d.sender),
            receiver: slipokPartyName(d.receiver),
            // slipCard ฝั่ง console อ่าน payload.timestamp — รวมวัน+เวลาให้เลย
            timestamp: [d.transDate, d.transTime].filter(Boolean).join(" "),
          },
        };
      }
      const reason = typeof body.message === "string" && body.message.trim()
        ? body.message.trim()
        : "ไม่ผ่านการตรวจอัตโนมัติ";
      return { ok: true, data: { valid: false, reason, code: body.code ?? null } };
    }
    if (!res?.ok) return { ok: false, reason: `check_http_${res?.status ?? "?"}` };
    return { ok: false, reason: "check_bad_payload" };
  }

  // G6 (P2): จับคู่สลิปกับออเดอร์ที่ "ยืนยันแล้ว" ของลูกค้าคนนี้ (best effort) —
  // แนบ slip_check_id เข้าออเดอร์ + คืนข้อความเทียบยอดต่อท้าย summary ให้แอดมิน
  // ทุกความล้มเหลว = "" เงียบ ๆ (การตรวจสลิปหลักต้องเดินต่อเสมอ)
  function linkSlipToOrder(rowId, customerId, data) {
    try {
      const order = db.openConfirmedOrder(customerId);
      if (!order) return "";
      db.attachSlipToOrder(order.id, rowId);
      const amount = Number(data?.amount);
      const total = Number(order.total);
      if (!Number.isFinite(amount) || !Number.isFinite(total)) {
        return ` · แนบกับออเดอร์ #${order.order_no} (ยังเทียบยอดไม่ได้)`;
      }
      return amount === total
        ? ` · ยอดตรงออเดอร์ #${order.order_no} ✅`
        : ` · ยอดไม่ตรงออเดอร์ #${order.order_no} ⚠️ (คาด ${total.toLocaleString("th-TH")} ได้ ${amount.toLocaleString("th-TH")})`;
    } catch (err) {
      logger.debug?.(`slipCheck: จับคู่ออเดอร์ไม่สำเร็จ (${err?.message || err})`);
      return "";
    }
  }

  // บันทึกผล + ต่อท้าย handoff summary — DB พังก็แค่ log (ห้ามล้มอะไรต่อ)
  // orderNote (G6) = บรรทัดเทียบยอดกับออเดอร์ ต่อท้ายข้อความเดิม (ข้อความเดิมห้ามเปลี่ยน)
  function record(rowId, customerId, status, data, reason = "", orderNote = "") {
    try {
      const amount = Number(data?.amount);
      db.updateSlipCheck(rowId, {
        status,
        amount: Number.isFinite(amount) ? amount : null,
        transRef: typeof data?.transRef === "string" ? data.transRef.slice(0, 100) : "",
        payloadJson: JSON.stringify(data ?? { reason }),
      });
      db.setNeedsHuman(customerId, "slip_check", `${summarizeSlipResult(status, data ?? { reason })}${orderNote}`);
    } catch (err) {
      logger.error?.(`slipCheck: บันทึกผลไม่สำเร็จ (${err?.message || err})`);
    }
  }

  // จุดเข้าเดียว (fire-and-forget จาก pipeline) — ไม่มี throw ทุกกรณี
  async function checkImage({ customerId, messageId, accessToken = null } = {}) {
    if (!enabled) return { skipped: "disabled" };
    if (!customerId || !messageId) return { skipped: "missing_ids" };
    let rowId;
    try {
      rowId = db.addSlipCheck({ customerId, messageId, status: "pending" });
      // audit 2026-08-24: มีสลิปเข้ามา = แตะเรื่องเงินแล้วถาวร (ธงนี้ตัดสินว่าคำถาม
      // ใบกำกับ/ใบเสร็จหลังจากนี้เป็นเอกสารจริงที่คนต้องออก ไม่ใช่คำถามก่อนซื้อ)
      try { db.markMoneySeen(customerId); } catch { /* ธงพังห้ามล้มเส้นตรวจสลิป */ }
    } catch (err) {
      logger.error?.(`slipCheck: สร้างแถว pending ไม่สำเร็จ (${err?.message || err})`);
      return { skipped: "db_error" };
    }
    const image = await downloadImage(messageId, accessToken);
    if (!image.ok) {
      record(rowId, customerId, "error", null, image.reason);
      return { status: "error", reason: image.reason };
    }
    const imageBase64 = image.buffer.toString("base64");
    const result = provider === "slipok"
      ? await callSlipOk(imageBase64)
      : await callWebhook({
          imageBase64,
          mimeType: image.contentType,
          customerId: String(customerId),
          messageId: String(messageId),
        });
    if (!result.ok) {
      record(rowId, customerId, "error", null, result.reason);
      return { status: "error", reason: result.reason };
    }
    // W2: เทียบยอดสลิปกับยอดที่ AI เพิ่งแจ้งลูกค้า (best effort — พัง/ไม่เจอ = null)
    let expectedAmount = null;
    try {
      expectedAmount = findRecentQuotedTotal({ db, customerId });
    } catch (err) {
      logger.debug?.(`slipCheck: หา expected amount ไม่สำเร็จ (${err?.message || err})`);
    }
    const data = expectedAmount == null ? result.data : { ...result.data, expectedAmount };
    const status = data.valid === true ? "valid" : "suspect";
    // G6: มีออเดอร์ยืนยันแล้วรอจ่าย -> แนบสลิป + เทียบยอดกับ order.total ให้แอดมิน
    const orderNote = linkSlipToOrder(rowId, customerId, data);
    record(rowId, customerId, status, data, "", orderNote);
    return { status, data };
  }

  return { enabled, provider, checkImage };
}
