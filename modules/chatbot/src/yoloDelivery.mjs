// yoloDelivery.mjs — ครึ่ง "ส่งและบันทึก" ของ YOLO (แยกจาก yolo.mjs เพื่อคุมขนาดไฟล์, 2026-09-28)
//
// ลำดับตายตัวแบบเดียวกับ staged follow-up (stagedFollowups.mjs):
//   ด่านสด (ห้องเปลี่ยนระหว่างร่างไหม) → รั้ว sending ลงดิสก์ก่อนไบต์แรกถึง provider →
//   lineRegistry.sendBubbles (batch + stillRelevant ระหว่างก้อน) → ปิดรั้วเสมอ (ผลกำกวมห้ามส่งซ้ำเอง) →
//   บันทึกเฉพาะที่ provider รับจริง → หมุดจังหวะราคา → เลื่อนบันได FU → (ถ้าสั่ง) เปิด AI → audit
import { createHash } from "node:crypto";
import { aiPausedNow } from "./aiPause.mjs";
import { approvedClassAmounts, outboundCarriesClassPrice } from "./priceDisclosure.mjs";
import { setCustomerAiSwitch } from "./aiSwitch.mjs";
import { YOLO_LANE } from "./dbYolo.mjs";
import { shiftLadderAfterYolo, urgentMental, yoloReasonText } from "./yoloPolicy.mjs";
import { channelLabel, graphemes } from "./yoloText.mjs";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";

export function instructionHash(instruction) {
  return createHash("sha256").update(String(instruction || "")).digest("hex").slice(0, 12);
}

export function customerSummary(row) {
  if (!row) return null;
  return {
    id: row.line_user_id,
    name: String(row.known_name || row.display_name || "").trim(),
    displayName: String(row.display_name || ""),
    knownName: String(row.known_name || ""),
    channelId: String(row.channel_id || "default"),
    channel: channelLabel(row.channel_id),
    aiEnabled: Number(row.ai_enabled) === 1,
    aiOffReason: String(row.ai_off_reason || ""),
    state: String(row.state || ""),
  };
}

export function refused(base, code, extra = {}) {
  return { ...base, ok: false, status: "refused", reason: code, reasonText: yoloReasonText(code), ...extra };
}

export function createYoloDelivery({ config, db, lineRegistry, catalogByKey, logger = console, now = Date.now }) {
  const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

  // ด่านสดก่อนข้ามเส้น provider (และระหว่างทยอยส่ง) — ห้องอาจเปลี่ยนระหว่างร่างได้เป็นนาที
  // baseline = เวลาข้อความล่าสุด (เข้า/ออก) ตอนเริ่มร่าง: มีอะไรใหม่ในห้อง = ร่างนี้ไม่เห็นมัน → ไม่ส่ง
  function freshBlock(customerId, { inbound: inboundBaseline, outbound: outboundBaseline }) {
    const fresh = safe(() => db.getCustomer(customerId), null);
    if (!fresh) return "changed_before_send";
    if (Number(fresh.do_not_disturb) === 1) return "do_not_disturb";
    if (Number(fresh.marketing_consent ?? 0) < 0 || fresh.ai_off_reason === "optout") return "opted_out";
    if (urgentMental(fresh)) return "urgent_mental";
    if (aiPausedNow({ db, config })) return "ai_paused";
    if (String(fresh.channel_id || "") === "facebook" && !safe(() => db.withinFacebookWindow(customerId, now()), false)) {
      return "fb_window_closed";
    }
    const latestInbound = safe(() => db.lastInboundAt(customerId), null);
    if (latestInbound && Number(latestInbound) > Number(inboundBaseline || 0)) return "superseded";
    // ลูกแพร/ทีมตอบไประหว่างร่าง (เช่น AI ห้องนี้เปิดอยู่และเพิ่งตอบคำถามเดียวกัน) = กันส่งซ้ำความ
    const latestOutbound = safe(() => db.lastOutboundAt(customerId), null);
    if (latestOutbound && Number(latestOutbound) > Number(outboundBaseline || 0)) return "superseded";
    return null;
  }

  function record({ customerId, fresh, delivered, expected, sendResult, retrieval, requestId, source, actor, instruction, alsoEnableAi, base, warnings }) {
    const imageUrls = new Set(expected.filter((item) => item.type === "image").map((item) => item.originalContentUrl));
    const metadata = {
      yolo: true, yoloRequestId: requestId, yoloSource: source,
      ...(retrieval ? { brainRetrieval: retrieval.selection.trace } : {}),
    };
    const brain = retrieval ? { brainVersionId: retrieval.brain.versionId } : {};
    const sentTexts = [];
    const sentImages = [];
    for (const message of delivered) {
      if ((message?.type === "text" || message?.type == null) && typeof message?.text === "string") {
        db.insertMessage({ customerId, direction: "out", msgType: "text", content: message.text, messageClass: "proactive", agentMode: "ai", metadata, ...brain });
        sentTexts.push(message.text);
      } else if (message?.type === "image" && imageUrls.has(message.originalContentUrl)) {
        const key = [...catalogByKey.values()].find((entry) => entry.url === message.originalContentUrl)?.key || "image";
        db.insertMessage({
          customerId, direction: "out", msgType: "image", content: `[image:${key}] ${message.originalContentUrl}`,
          messageClass: "proactive", agentMode: "ai", metadata, ...brain,
        });
        sentImages.push(key);
      }
    }
    const sentText = sentTexts.join("\n");
    // จังหวะราคา: ราคาที่ถึงมือลูกค้าทาง YOLO ก็ต้องปักหมุดเหมือนเส้นอื่น (เหตุผลเต็มใน followupEngine.mjs)
    try {
      const amounts = approvedClassAmounts(retrieval ? retrieval.brain.bundle.guardTables.approvedPrices : db.approvedPrices() ?? []);
      if (outboundCarriesClassPrice(sentText, amounts)) db.markPriceQuoted?.(customerId);
    } catch { /* ไม่มีผลกับข้อความที่ส่งแล้ว */ }
    let ladder = null;
    try {
      const shifted = shiftLadderAfterYolo({
        stateRow: db.getFollowupState(customerId), customer: fresh,
        lastInboundAt: db.lastInboundAt(customerId), nowMs: now(), sentText,
      });
      db.saveFollowupState(customerId, shifted.state);
      ladder = shifted.summary;
    } catch (err) {
      logger.warn?.(`yolo: เลื่อนบันได FU ไม่สำเร็จ (${err?.message || err}) customer=${customerId}`);
    }
    const partial = !sendResult.ok || sendResult.stoppedEarly === true || delivered.length < expected.length;
    let aiChanged = false;
    if (alsoEnableAi && Number(fresh.ai_enabled) !== 1) {
      setCustomerAiSwitch({ db, customerId, enabled: true, operator: actor, source: `yolo·${source}`, nowMs: now() });
      aiChanged = true;
    }
    const after = db.getCustomer(customerId);
    const short = graphemes(instruction.replace(/\s+/gu, " ")).slice(0, 60).join("");
    try {
      db.addAudit({
        operator: actor, action: partial ? "yolo_partial" : "yolo_sent", target: customerId,
        detail: [
          source, `hash=${instructionHash(instruction)}`, short ? `"${short}"` : "(ไม่มีคำสั่ง)",
          `ส่ง ${delivered.length}/${expected.length}`,
          ladder ? `FU ${ladder.stage} ${ladder.before}→${ladder.after}/${ladder.ladderLength}` : "FU -",
          `AI ${Number(after?.ai_enabled) === 1 ? "on" : "off"}${aiChanged ? " (เปิดตามคำสั่ง)" : ""}`,
        ].join(" · ").slice(0, 400),
      });
    } catch { /* audit พังห้ามทำให้รายงานผลผิด — ข้อความถึงลูกค้าแล้ว */ }
    return {
      ...base, ok: true, status: partial ? "partial" : "sent", reason: partial ? "partial_delivery" : "",
      sentText, bubbles: sentTexts, images: sentImages, delivered: delivered.length, expected: expected.length,
      warnings, ladder, aiChanged, customer: customerSummary(after),
    };
  }

  async function deliver({ customerId, bubbles, images, baseline, retrieval, requestId, source, actor, instruction, alsoEnableAi, base, warnings }) {
    const block = freshBlock(customerId, baseline);
    if (block) return refused(base, block, { warnings });
    const stillRelevant = () => !freshBlock(customerId, baseline);
    if (!db.fenceProactiveSend(customerId, YOLO_LANE, requestId, now())) return refused(base, "delivery_fenced", { warnings });
    const fresh = db.getCustomer(customerId);
    let sendResult;
    try {
      sendResult = await lineRegistry.forChannel(fresh.channel_id || "default").sendBubbles({
        // ลูกค้าไม่ได้อยู่หน้าจอ — ส่งทั้งชุดในคำขอเดียวแบบเดียวกับ follow-up
        batch: true, to: lineRegistry.rawUserId(customerId), replyToken: "", bubbles,
        images: images.map((image) => ({ key: image.key, url: image.url, previewUrl: image.previewUrl ?? image.preview_url ?? image.url })),
        stillRelevant,
        purpose: SEND_PURPOSE.yolo,
      });
    } finally {
      // รั้วต้องปิดเสมอ แม้ provider โยน error — ผลกำกวมห้ามถูกลองส่งซ้ำอัตโนมัติ
      try { db.settleProactiveSend(customerId, YOLO_LANE, requestId, now()); } catch { /* แถวยังเป็น sending = ไม่ส่งซ้ำ */ }
    }
    const expected = [
      ...bubbles.map((bubble) => ({ type: "text", text: bubble.text })),
      ...images.map((image) => ({ type: "image", originalContentUrl: image.url })),
    ];
    const delivered = Array.isArray(sendResult?.delivered) ? sendResult.delivered
      : sendResult?.ok && Array.isArray(sendResult.acceptedRequestMessages) ? sendResult.acceptedRequestMessages
        : sendResult?.ok ? expected : [];
    if (!delivered.length) {
      const why = sendResult?.stoppedEarly ? "superseded" : "send_failed";
      return refused(base, why, {
        status: why === "send_failed" ? "failed" : "refused",
        detail: String(sendResult?.reason || sendResult?.status || ""),
        warnings,
      });
    }
    return record({ customerId, fresh, delivered, expected, sendResult, retrieval, requestId, source, actor, instruction, alsoEnableAi, base, warnings });
  }

  return { freshBlock, deliver };
}
