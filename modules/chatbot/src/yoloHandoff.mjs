// yoloHandoff.mjs — ตัวเลือก "🔔 ส่งต่อแอดมิน" ของปุ่ม YOLO (คำสั่งพี่ง้วง 2026-10-15)
//
// "ปุ่ม yolo ให้มี option แจ้งเตือนเข้า admin เลย — เลือกปิด AI หรือไม่ปิดก็ได้ พร้อมคำพูดที่พี่ง้วงพิมพ์เข้าไปได้"
//
// ต่างจาก YOLO ทักต่อ (yolo.mjs) ตรงที่ไม่มีโมเดลร่าง — ข้อความถึงลูกค้าคือ "คำพูดที่คนพิมพ์" ส่งตามนั้นเป๊ะ
// (เหมือนพิมพ์ตอบในห้องแชท จึงบันทึกเป็นข้อความของคน ไม่ใช่ของลูกแพร) แล้วส่งห้องให้แอดมินด้วยชุดเดียวกับ
// การส่งไม้ต่อที่มีอยู่: ธง NEEDS_HUMAN + โน้ตส่งต่อ + push แจ้งทีม (force — cooldown ห้ามกลืน)
//
// ลำดับ: ด่านหน้า → (ถ้าเลือก) ปิด AI ก่อนส่ง (กันลูกค้าตอบไวแล้ว AI ตอบแทรกก่อนปิด) → ส่งข้อความ (ถ้ามี)
//        → ธงรอคน + โน้ต → push แอดมิน (บอกในข้อความว่าถึงลูกค้าแล้วหรือยัง) → audit
// ส่งข้อความไม่ถึง ≠ ยกเลิกการส่งต่อ: ห้องยังต้องไปถึงแอดมิน (แจ้งในผลและในข้อความ push ว่าไม่ถึง)
// สวิตช์ AI ใช้เส้นเดียวกับปุ่มในห้องแชท (aiSwitch.mjs) — ปิด = เหตุ manual ที่เส้นอัตโนมัติเปิดคืนไม่ได้
import { randomUUID } from "node:crypto";
import { setCustomerAiSwitch } from "./aiSwitch.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
import { customerSummary } from "./yoloDelivery.mjs";
import { cleanInstruction, graphemes } from "./yoloText.mjs";

export const YOLO_HANDOFF_LANE = "yolo_handoff";
export const YOLO_HANDOFF_REASON = "owner_handoff";
export const YOLO_HANDOFF_MAX_CHARS = 1000;
const MAX_BUBBLES = 4;

const TEXT = Object.freeze({
  unknown_customer: "ไม่พบห้องลูกค้านี้ในระบบ (อาจถูกลบข้อมูลตามคำขอแล้ว)",
  legacy_room: "ห้องนี้เป็นประวัติจาก LINE OA เดิม — ส่งต่อในห้องจริงที่โยงแล้วนะคะ",
  in_flight: "กำลังส่งต่อห้องนี้อยู่ รอสักครู่นะคะ",
  invalid_message: `ข้อความยาวเกินไป — ขอไม่เกิน ${YOLO_HANDOFF_MAX_CHARS} ตัวอักษรนะคะ`,
  opted_out: "ลูกค้าขอให้หยุดทัก/ไม่รบกวน — ส่งข้อความไม่ได้ ลบข้อความออกแล้วกดส่งต่อแอดมินอย่างเดียวได้ค่ะ",
  no_conversation: "ลูกค้ายังไม่เคยทักเข้ามา — ส่งข้อความไม่ได้ ลบข้อความออกแล้วกดส่งต่อแอดมินอย่างเดียวได้ค่ะ",
  fb_window_closed: "ห้อง Facebook นี้ลูกค้าเงียบเกิน 24 ชม.แล้ว (กติกา Meta) — ส่งข้อความไม่ได้ ลบข้อความออกแล้วกดส่งต่อแอดมินอย่างเดียวได้ค่ะ",
  delivery_fenced: "รายการนี้ถูกล็อกการส่งไว้แล้ว — ไม่ส่งซ้ำค่ะ",
});

export function yoloHandoffReasonText(code) {
  return TEXT[String(code || "")] || String(code || "");
}

// แบ่งฟองตามบรรทัดว่างที่คนเว้นเอง — ไม่ผ่าน humanizer (คำของคน ห้ามเติม/ตัดคำ) · เกินเพดานรวมฟองท้าย
export function handoffBubbles(message) {
  const parts = String(message || "").split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length <= MAX_BUBBLES) return parts;
  return [...parts.slice(0, MAX_BUBBLES - 1), parts.slice(MAX_BUBBLES - 1).join("\n\n")];
}

const oneLine = (value) => String(value || "").replace(/\s+/gu, " ").trim().slice(0, 40);

// บรรทัด "ข้อความถึงลูกค้าเป็นยังไง" — ใช้ทั้งโน้ตและ push · unknown = อาจถึงแล้ว ต้องเช็กก่อนส่งซ้ำ (รีวิว 15 ต.ค. #3)
export function handoffSendLine(send = {}, sentText = "") {
  const preview = graphemes(String(sentText || "").replace(/\s+/gu, " ").trim());
  const quoted = `"${preview.slice(0, 160).join("")}${preview.length > 160 ? "…" : ""}"`;
  switch (send.outcome) {
    case "sent": return `ข้อความที่ส่งให้ลูกค้าแล้ว: ${quoted}`;
    case "partial": return `⚠️ ข้อความถึงลูกค้าบางส่วน: ${quoted} — เปิดแชทดูก่อนตอบต่อ`;
    case "unknown": return "⚠️ ไม่แน่ใจว่าข้อความถึงลูกค้าหรือยัง (ระบบส่งขัดข้อง) — เปิดแชทเช็กก่อนส่งซ้ำ";
    case "failed": return "⚠️ ข้อความถึงลูกค้าส่งไม่สำเร็จ — เข้าไปตอบเองในแชทด้วยค่ะ";
    case "blocked": return `⚠️ ไม่ได้ส่งข้อความหาลูกค้า (${yoloHandoffReasonText(send.blocked)})`;
    default: return "ยังไม่ได้ส่งข้อความหาลูกค้า";
  }
}

// ข้อความ push ถึงแอดมิน (notify.mjs เติม "คุณ<ชื่อ>" ไว้หน้า + ลิงก์ห้องไว้ท้ายให้เอง)
export function handoffNotifyText({ actorName, aiOn, sentText, send = { outcome: "none" } }) {
  const who = oneLine(actorName) || "ทีม";
  const ai = aiOn ? "AI ห้องนี้ยังเปิด (ลูกแพรคุยต่อได้)" : "AI ห้องนี้ปิดแล้ว — แอดมินตอบเองนะคะ";
  return `ถูกส่งต่อให้แอดมินโดย ${who} (ปุ่ม YOLO)\n${ai}\n${handoffSendLine(send, sentText)}`;
}

export function createYoloHandoff({ config = {}, db, lineRegistry, notifier = null, pipeline = null, logger = console, now = Date.now }) {
  const inFlight = new Set();
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  // ด่านของ "ข้อความถึงลูกค้า" — ใช้สองรอบ: ก่อนเริ่ม (ปฏิเสธทั้งคำขอ ยังไม่แตะห้อง) และในคิวของห้องก่อนยิงจริง
  // (รีวิว 15 ต.ค. #1: ระหว่างรอคิว ลูกค้าอาจเพิ่งขอหยุดทัก/หน้าต่าง FB ปิด) — รอบสองไม่ส่ง แต่ยังส่งต่อแอดมินต่อ
  function messageBlock(customerId, customer) {
    if (Number(customer?.do_not_disturb) === 1 || Number(customer?.marketing_consent ?? 0) < 0
      || customer?.ai_off_reason === "optout") return "opted_out";
    if (!safe(() => db.lastInboundAt(customerId), null)) return "no_conversation";
    if (String(customer?.channel_id || "") === "facebook" && !safe(() => db.withinFacebookWindow(customerId, now()), false)) {
      return "fb_window_closed";
    }
    return null;
  }

  function refusalFor(customerId, customer, hasMessage) {
    if (!customer || customerId.startsWith("canary:")) return "unknown_customer";
    if (safe(() => db.isLegacyReferenceRoom(customerId), false)) return "legacy_room";
    if (inFlight.has(customerId)) return "in_flight";
    return hasMessage ? messageBlock(customerId, customer) : null;
  }

  // outcome: sent | partial | failed (provider ปฏิเสธชัด) | unknown (โยน error/ไม่มีผลชัด — อาจถึงแล้ว) | blocked
  async function sendMessage({ customerId, bubbles, requestId, actor, source }) {
    const fresh = safe(() => db.getCustomer(customerId), null);
    const blocked = fresh ? messageBlock(customerId, fresh) : "unknown_customer";
    if (blocked) return { outcome: "blocked", blocked, delivered: [], expected: bubbles.length };
    if (!db.claimProactiveAttempt(customerId, YOLO_HANDOFF_LANE, requestId, now()).ok
      || !db.fenceProactiveSend(customerId, YOLO_HANDOFF_LANE, requestId, now())) {
      return { outcome: "blocked", blocked: "delivery_fenced", delivered: [], expected: bubbles.length };
    }
    let result = null;
    let threw = false;
    try {
      result = await lineRegistry.forChannel(fresh.channel_id || "default").sendBubbles({
        batch: true, to: lineRegistry.rawUserId(customerId), replyToken: "",
        bubbles: bubbles.map((text) => ({ text })), images: [], purpose: SEND_PURPOSE.yolo,
      });
    } catch (err) {
      threw = true;
      logger.warn?.(`yolo-handoff: ส่งข้อความไม่สำเร็จ (${err?.name || "Error"}) customer=${customerId}`);
    } finally {
      try { db.settleProactiveSend(customerId, YOLO_HANDOFF_LANE, requestId, now()); } catch { /* sending ค้าง = ไม่ส่งซ้ำ */ }
    }
    const delivered = Array.isArray(result?.delivered) ? result.delivered
      : result?.ok && Array.isArray(result.acceptedRequestMessages) ? result.acceptedRequestMessages
        : result?.ok ? bubbles.map((text) => ({ type: "text", text })) : [];
    const texts = delivered.filter((m) => (m?.type === "text" || m?.type == null) && typeof m?.text === "string").map((m) => m.text);
    // คำของคน = แถวของคน (operator ≠ '') · settleTurnsUpTo 0 = ไม่ปิดคำถามค้างของลูกค้า (ประโยคส่งต่อไม่ใช่คำตอบ)
    // บันทึกพังห้ามล้มการส่งต่อ — ข้อความถึงลูกค้าแล้ว (รีวิว 15 ต.ค. #2)
    const agentMode = Number(safe(() => db.getCustomer(customerId)?.ai_enabled, 0)) === 1 ? "operator_ai_on" : "operator_ai_off";
    for (const text of texts) {
      try {
        db.insertMessage({
          customerId, direction: "out", msgType: "text", content: text, messageClass: "reactive", operator: actor, agentMode,
          settleTurnsUpTo: 0, metadata: { yolo: true, yoloHandoff: true, yoloRequestId: requestId, yoloSource: source },
        });
      } catch (err) {
        logger.error?.(`yolo-handoff: บันทึกข้อความที่ส่งแล้วไม่สำเร็จ (${err?.message || err}) customer=${customerId}`);
      }
    }
    const outcome = texts.length >= bubbles.length ? "sent"
      : texts.length ? "partial"
        : threw || (!result?.ok && !Array.isArray(result?.delivered) && result?.status == null) ? "unknown" : "failed";
    return { outcome, delivered: texts, expected: bubbles.length };
  }

  function step(label, fn) {
    try { return fn(); } catch (err) {
      logger.error?.(`yolo-handoff: ${label} ไม่สำเร็จ (${err?.message || err}) — ทำขั้นถัดไปต่อ`);
      return null;
    }
  }

  async function handoffUnaudited({ customerId, message = "", closeAi = true, actor = "", actorName = "", source = "console" }) {
    const id = String(customerId || "");
    const requestId = randomUUID();
    const raw = String(message ?? "");
    const cleaned = cleanInstruction(raw, YOLO_HANDOFF_MAX_CHARS);
    const customer = id ? safe(() => db.getCustomer(id), null) : null;
    const base = { requestId, mode: "handoff", customer: customerSummary(customer) };
    const refuse = (code) => ({ ...base, ok: false, status: "refused", reason: code, reasonText: yoloHandoffReasonText(code) });
    if (graphemes(raw.trim()).length > YOLO_HANDOFF_MAX_CHARS) return refuse("invalid_message");
    const refusal = refusalFor(id, customer, Boolean(cleaned));
    if (refusal) return refuse(refusal);
    // ชื่อคนสั่งลง handoff_summary ที่ตัวอ่านแยกบรรทัด "[ISO] reason" — ห้ามมีขึ้นบรรทัดใหม่ (รีวิว 15 ต.ค. #6)
    const who = oneLine(actorName || actor) || "ทีม";

    inFlight.add(id);
    try {
      let aiClosed = false;
      if (closeAi === true && Number(customer.ai_enabled) === 1) {
        setCustomerAiSwitch({ db, customerId: id, enabled: false, operator: actor, source: `yolo·handoff·${source}`, nowMs: now() });
        aiClosed = true;
      }
      let sent = { outcome: "none", delivered: [], expected: 0 };
      if (cleaned) {
        const bubbles = handoffBubbles(cleaned);
        const run = () => sendMessage({ customerId: id, bubbles, requestId, actor, source });
        try {
          sent = await (pipeline?.runExclusive ? pipeline.runExclusive(id, run) : run());
        } catch (err) {
          logger.error?.(`yolo-handoff: คิวส่งล้ม (${err?.message || err}) customer=${id}`);
          sent = { outcome: "unknown", delivered: [], expected: bubbles.length };
        }
      }
      const sentText = sent.delivered.join("\n");
      const after = safe(() => db.getCustomer(id), customer);
      const aiOn = Number(after?.ai_enabled) === 1;
      const summary = `ส่งต่อแอดมินจากปุ่ม YOLO โดย ${who} — ${aiOn ? "AI ยังเปิด" : "AI ปิด"}`;
      step("ตั้งธงรอคน", () => db.setNeedsHuman(id, YOLO_HANDOFF_REASON, summary));
      step("เขียนโน้ตส่งต่อ", () => db.addHandoffNote({
        customerId: id, author: actor, text: `🔔 ${summary}\n${handoffSendLine(sent, sentText)}`,
      }));
      const notify = notifier?.fire
        ? await notifier.fire({
          customerId: id, channelId: after?.channel_id || "default", reason: YOLO_HANDOFF_REASON,
          customerName: after?.known_name || after?.display_name || "", force: true,
          reasonTextOverride: handoffNotifyText({ actorName: who, aiOn, sentText, send: sent }),
        }).catch(() => ({ skipped: "error" }))
        : { skipped: "no_notifier" };
      const notSent = ["failed", "unknown", "blocked"].includes(sent.outcome);
      return {
        ...base, ok: true, status: notSent || sent.outcome === "partial" ? "partial" : "handed_off",
        reason: notSent ? (sent.outcome === "blocked" ? sent.blocked : sent.outcome === "unknown" ? "send_unknown" : "send_failed") : "",
        reasonText: sent.outcome === "blocked" ? yoloHandoffReasonText(sent.blocked) : "",
        sentText, bubbles: sent.delivered, delivered: sent.delivered.length, expected: sent.expected,
        aiClosed, notify: { sent: Number(notify?.sent || 0), total: Number(notify?.total || 0), skipped: notify?.skipped || "" },
        customer: customerSummary(after),
      };
    } finally {
      inFlight.delete(id);
    }
  }

  async function handoff(options = {}) {
    const result = await handoffUnaudited(options).catch((err) => {
      logger.error?.(`yolo-handoff: ล้มเหลว (${err?.message || err}) customer=${options.customerId}`);
      return { ok: false, status: "failed", mode: "handoff", reason: "internal_error", reasonText: "ระบบขัดข้อง — ยังส่งต่อไม่สำเร็จ ลองใหม่อีกครั้งค่ะ" };
    });
    try {
      const short = graphemes(String(options.message || "").replace(/\s+/gu, " ").trim()).slice(0, 60).join("");
      db.addAudit({
        operator: String(options.actor || "unknown"), action: result.ok ? "yolo_handoff" : "yolo_handoff_refused",
        target: String(options.customerId || ""),
        detail: [
          String(options.source || "console"), result.ok ? result.status : result.reason,
          short ? `"${short}"` : "(ไม่มีข้อความถึงลูกค้า)",
          result.ok ? `AI ${result.customer?.aiEnabled ? "on" : "off"}${result.aiClosed ? " (ปิดตามที่เลือก)" : ""}` : "",
          result.ok ? `แจ้งแอดมิน ${result.notify.sent}/${result.notify.total}${result.notify.skipped ? ` (${result.notify.skipped})` : ""}` : "",
        ].filter(Boolean).join(" · ").slice(0, 400),
      });
    } catch { /* audit พังห้ามเปลี่ยนผล — ห้องถูกส่งต่อแล้ว */ }
    return result;
  }

  return { handoff };
}
