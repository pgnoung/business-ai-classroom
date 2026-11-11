// broadcast.mjs — เครื่องส่งบรอดแคสตาม segment (v1.2 — พี่ง้วงสั่ง 2026-08-10)
//
// กติกาเหล็ก:
// - ทุกบรอดแคสเป็นการกดของคนใน console + confirm — ไม่มีเส้นทางอัตโนมัติ/ตั้งเวลา (v1)
// - ข้อความทุกก้อนผ่าน compliance guard เหมือนข้อความถึงลูกค้าทุกใบ (ราคาต้องตรงตาราง
//   approve — บรอดแคสยิ่งต้องเข้ม เพราะผิดทีเดียวถึงลูกค้าทั้ง segment)
// - audience จาก db.broadcastAudience เท่านั้น และ revalidate ซ้ำก่อนทุก batch
//   (DND/consent/tag เปลี่ยนระหว่าง queue ต้อง fail-closed ไม่ส่งจาก snapshot เก่า)
// - ส่งผ่าน LINE multicast เป็น batch — โควตานับต่อผู้รับ 1 คน = 1 ข้อความต่อการส่ง
// - LINE 429 = หยุด batch ที่เหลือทันที; ความล้มเหลวอื่นบันทึกเป็น partial/failed ตามจริง
import { randomUUID } from "node:crypto";
import { SEND_PURPOSE } from "./lineSendLedger.mjs";
import { BROADCAST_TEXT_MAX, guardTextOf, storedMessageLogRow } from "./broadcastMessages.mjs";

// 28 ก.ย. 2026: ตัวประกอบบับเบิลย้ายไป broadcastMessages.mjs (เพิ่มสติกเกอร์ + การ์ด/การ์ดเลื่อน + ลิงก์นับคลิก)
// export ต่อจากไฟล์นี้ให้ผู้เรียกเดิม (เส้นส่งมือ · ตัวตั้งเวลา · เทสต์) ไม่ต้องเปลี่ยน import
export {
  BROADCAST_MAX_BUBBLES, BROADCAST_TEXT_MAX, buildBroadcastMessages,
} from "./broadcastMessages.mjs";
export const BROADCAST_BATCH_SIZE = 150; // < เพดาน 500 ของ LINE — ก้อนเล็ก failure ไม่ลามเยอะ
export const BROADCAST_CLAIM_LEASE_MS = 60_000;

export function createBroadcastEngine({ db, config, guard, line = null, lineRegistry = null, logger = console, uuid = null }) {
  // Stable for this chassis process. Never expose it to the browser; SQLite
  // uses it to ensure an old process cannot renew/release a successor's lease.
  const broadcastOwnerToken = randomUUID();
  function lineFor(channelId) {
    return lineRegistry ? lineRegistry.forChannel(channelId) : line;
  }

  // ตรวจข้อความทั้งชุดกับ compliance guard — ข้อความบรอดแคสคือ outbound เหมือนกันเป๊ะ
  function guardCheck(messages) {
    for (const m of messages) {
      // 28 ก.ย. 2026: การ์ด (Flex) มีข้อความหลายช่อง — หัวข้อ ข้อความ ชื่อปุ่ม ข้อความแจ้งเตือน ตรวจรวมกันทั้งใบ
      const text = guardTextOf(m);
      if (!text) continue;
      // P2 โดยเจตนา: บรอดแคสต์คือข้อความก้อนเดียวถึงทุกคน จึงไม่มี "ห้องของใคร" ให้ยึด —
      // ตัดสินด้วยตารางกลาง ซึ่งเป็น projection ของรุ่น live และเป็นค่าที่ถูกต้องที่นี่
      const check = guard.checkOutbound(text);
      if (!check.ok) {
        const detail = check.violations.map((v) => `${v.type}${v.detail ? `:${v.detail}` : ""}`).join(", ");
        return { ok: false, error: `ข้อความไม่ผ่านตัวกัน (${detail}) — ตัวเลข/ราคา ต้องตรงตารางราคาที่อนุมัติ` };
      }
    }
    return { ok: true };
  }

  // REVIEW FIX: เช็คช่องส่งพร้อมจริงก่อนรับงาน — LINE fail-closed (live send ปิด/ไม่มี token)
  // ต้องตอบ error ตั้งแต่ตอนกด ไม่ใช่รับงานแล้วล้มเงียบเป็น "ล้มเหลว 0/N" ไร้เหตุผล
  function sendReady(channelId) {
    const lineCh = lineFor(channelId);
    if (!lineCh) return { ok: false, error: "ไม่พบช่องส่งของสาขานี้" };
    if (!lineCh.sendAllowed()) {
      return { ok: false, error: "ช่องส่ง LINE ยังไม่พร้อม (live send ปิดอยู่ หรือยังไม่มี access token)" };
    }
    return { ok: true };
  }

  async function quotaFor(channelId, { fresh = false } = {}) {
    const lineCh = lineFor(channelId);
    if (!lineCh?.getQuota) return null;
    try {
      return await lineCh.getQuota({ force: fresh });
    } catch (err) {
      logger.warn?.(`broadcast: อ่านโควตาไม่สำเร็จ (${err?.message || err})`);
      return null;
    }
  }

  // B-12: explicit operator self-test. This is intentionally not a one-person
  // broadcast: no audience query, no recipient ledger, no retry key and exactly
  // one text bubble/provider attempt. `accepted` is provider request acceptance,
  // never a claim that LINE displayed or the person read the message.
  async function sendSelfTest({ channelId, lineUserId, text } = {}) {
    const ready = sendReady(channelId);
    if (!ready.ok) return { state: "rejected", error: ready.error };
    const clean = typeof text === "string" ? text.trim() : "";
    if (!lineUserId || !clean || clean.length > BROADCAST_TEXT_MAX) {
      return { state: "rejected", error: "ข้อความทดสอบต้องเป็น text 1 บับเบิลและยาวไม่เกิน 1,000 ตัวอักษร" };
    }
    const guarded = guardCheck([{ type: "text", text: clean }]);
    if (!guarded.ok) return { state: "rejected", error: guarded.error };
    const lineCh = lineFor(channelId);
    const target = lineRegistry ? lineRegistry.rawUserId(lineUserId) : String(lineUserId);
    try {
      const result = await lineCh.sendBubbles({
        to: target,
        replyToken: "",
        bubbles: [{ text: clean }],
        images: [],
        stickers: [],
        purpose: SEND_PURPOSE.broadcast,
      });
      if (result?.ok === true) return { state: "accepted", mode: result.mode || "push" };
      // Network/5xx outcomes can have reached LINE. Do not retry and do not call
      // them rejected; the operator must inspect before pressing send again.
      if (result?.ambiguous === true || Number(result?.status) === 0 || Number(result?.status) >= 500) {
        return { state: "unknown", error: "LINE ยังยืนยันผลไม่ได้ — ระบบไม่ส่งซ้ำอัตโนมัติ" };
      }
      return { state: "rejected", error: result?.reason || `LINE ปฏิเสธคำขอ${result?.status ? ` (HTTP ${result.status})` : ""}` };
    } catch {
      return { state: "unknown", error: "LINE ยังยืนยันผลไม่ได้ — ระบบไม่ส่งซ้ำอัตโนมัติ" };
    }
  }

  function quotaAllows(quota, recipientCount) {
    if (quota?.type === "none" && Number.isSafeInteger(quota.totalUsage) && quota.totalUsage >= 0) {
      return { ok: true };
    }
    if (quota?.type === "limited") {
      const limit = quota.value;
      const used = quota.totalUsage;
      if (Number.isSafeInteger(limit) && limit >= 0 && Number.isSafeInteger(used) && used >= 0) {
        return limit - used >= recipientCount
          ? { ok: true }
          : { ok: false, error: "LINE quota ไม่พอระหว่างส่ง — หยุด batch ที่เหลือ" };
      }
    }
    return { ok: false, error: "อ่านโควตา LINE ไม่ได้หรือข้อมูลไม่สมบูรณ์ — หยุด batch ที่เหลือ" };
  }

  // ส่งจริงเบื้องหลัง — คนเห็นความคืบหน้าจาก history (sending -> done/failed)
  async function runSend({ broadcastId, channelId, audience, messages, storedMessages, operator, includeTags = [], excludeTags = [], claimOwnerToken = "", aggregationUnit = "" }) {
    const lineCh = lineFor(channelId);
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let cancelled = 0;
    let lastError = "";
    let lastSentIndex = -1;
    let stopRemaining = false;
    let providerOutcomeUnknown = false;
    let quarantinePersisted = false;
    let unknown = 0;
    const scopedIds = (rows) => rows.map((customer) => customer.line_user_id);
    try {
      for (let i = 0; i < audience.length; i += BROADCAST_BATCH_SIZE) {
        const queuedBatch = audience.slice(i, i + BROADCAST_BATCH_SIZE);
        if (stopRemaining) {
          failed += queuedBatch.length;
          db.markBroadcastRecipients(broadcastId, scopedIds(queuedBatch), "failed", {
            batchNo: Math.floor(i / BROADCAST_BATCH_SIZE), error: lastError,
          });
          continue;
        }
        const cancelRequest = db.broadcastCancelRequest(broadcastId);
        if (cancelRequest) {
          const remaining = audience.slice(i);
          cancelled += remaining.length;
          lastError = `ยกเลิกโดย ${cancelRequest.cancel_requested_by || "operator"} — หยุดก่อน batch ถัดไป`;
          db.markBroadcastRecipients(broadcastId, scopedIds(remaining), "cancelled", {
            batchNo: Math.floor(i / BROADCAST_BATCH_SIZE), error: lastError,
          });
          break;
        }
        if (claimOwnerToken && !db.renewBroadcastClaim(
          channelId, broadcastId, claimOwnerToken, BROADCAST_CLAIM_LEASE_MS,
        )) {
          lastError = "lease งานส่งหมดอายุหรือเปลี่ยนเจ้าของ — หยุดก่อนเรียก LINE";
          const remaining = audience.slice(i);
          failed += remaining.length;
          db.markBroadcastRecipients(broadcastId, scopedIds(remaining), "failed", {
            batchNo: Math.floor(i / BROADCAST_BATCH_SIZE), error: lastError,
          });
          break;
        }
      // Fail closed immediately before the network call. The queue is only an upper
      // bound: never add newly eligible recipients, but remove anyone whose current
      // DND, marketing consent, channel, or tag eligibility no longer matches.
      let eligibleIds;
      try {
        eligibleIds = new Set(db.broadcastAudience({
          channelId, includeTags, excludeTags,
          recipientIds: scopedIds(queuedBatch),
          limit: queuedBatch.length,
        }).map((customer) => customer.line_user_id));
      } catch (err) {
        // อ่านสิทธิ์สดไม่ได้ = ห้ามส่ง batch นี้เด็ดขาด แต่ต้องปิด progress ให้คนเห็น
        // ว่าระบบล้ม ไม่ปล่อยแถวค้าง "sending" แล้วชวนให้กดซ้ำโดยไม่รู้สถานะ
        lastError = `ตรวจสิทธิ์ผู้รับไม่สำเร็จ: ${String(err?.message || err)}`;
        failed += queuedBatch.length;
        db.markBroadcastRecipients(broadcastId, scopedIds(queuedBatch), "failed", {
          batchNo: Math.floor(i / BROADCAST_BATCH_SIZE), error: lastError,
        });
        logger.warn?.(`broadcast: ${lastError}`);
        try {
          db.updateBroadcastProgress(broadcastId, { sentCount: sent, failedCount: failed, lastSentIndex, lastError });
        } catch { /* progress ระหว่างทางหาย แต่ finalizer ด้านล่างยังลองซ้ำ */ }
        continue;
      }
      const batch = queuedBatch.filter((customer) => eligibleIds.has(customer.line_user_id));
      const ineligible = queuedBatch.filter((customer) => !eligibleIds.has(customer.line_user_id));
      skipped += ineligible.length;
      db.markBroadcastRecipients(broadcastId, scopedIds(ineligible), "skipped", {
        batchNo: Math.floor(i / BROADCAST_BATCH_SIZE), error: "สิทธิ์/ป้าย/DND เปลี่ยนก่อนส่ง",
      });
      if (!batch.length) continue;
      const quota = await quotaFor(channelId, { fresh: true });
      // LINE monthly quota counts recipients per multicast request, not each
      // message bubble inside that request. A 5-bubble multicast to 10 people
      // consumes 10 quota units.
      const quotaCheck = quotaAllows(quota, batch.length);
      if (!quotaCheck.ok) {
        lastError = quotaCheck.error;
        failed += batch.length;
        db.markBroadcastRecipients(broadcastId, scopedIds(batch), "failed", {
          batchNo: Math.floor(i / BROADCAST_BATCH_SIZE), error: lastError,
        });
        stopRemaining = true;
        continue;
      }
      const ids = batch.map((c) => (lineRegistry ? lineRegistry.rawUserId(c.line_user_id) : c.line_user_id));
      let ok = false;
      let status = 0;
      let providerThrew = false;
      let providerAmbiguous = false;
      let providerBlocked = false;
      const retryKey = uuid?.() || randomUUID();
      // Arm a durable exact-recipient guard before the network call. If the
      // provider accepts but the response/final DB transition is lost, this
      // row survives process restart and lease expiry and blocks replay.
      const deliveryGuard = db.armBroadcastDeliveryQuarantine(
        channelId,
        broadcastId,
        claimOwnerToken,
        {
          lineUserIds: scopedIds(batch),
          batchNo: Math.floor(i / BROADCAST_BATCH_SIZE),
          retryKey,
        },
      );
      if (!deliveryGuard?.id) throw new Error("เตรียม durable delivery guard ไม่สำเร็จ — ยังไม่เรียก provider");
      try {
        const result = await lineCh.multicast({ to: ids, messages, retryKey, aggregationUnit, purpose: SEND_PURPOSE.broadcast });
        ok = result.ok === true;
        status = Number(result.status) || 0;
        providerAmbiguous = result?.ambiguous === true;
        providerBlocked = result?.blocked === true;
        if (!ok) {
          // REVIEW FIX: เก็บเหตุผลไว้เสมอ — blocked (fail-closed) หรือ HTTP status จาก LINE
          lastError = result.blocked
            ? `ช่องส่งปิดอยู่ (${result.reason || "blocked"})`
            : `LINE ตอบ HTTP ${result.status || "?"}`;
          logger.warn?.(`broadcast: batch ล้มเหลว (${lastError})`);
        }
      } catch (err) {
        providerThrew = true;
        lastError = String(err?.message || err);
        logger.warn?.(`broadcast: batch ล้มเหลว (${lastError})`);
      }
      const ambiguousOutcome = !ok && (
        providerThrew || providerAmbiguous || (!providerBlocked && (status === 0 || status >= 500))
      );
      if (ambiguousOutcome) {
        // A timeout/0/5xx can be a lost acknowledgement after LINE accepted the
        // multicast. Persist an operator-review quarantine and release the OA
        // claim atomically; never call the provider for a later batch.
        providerOutcomeUnknown = true;
        const failureKind = providerThrew
          ? "exception"
          : providerAmbiguous
            ? "ambiguous"
            : status >= 500
              ? "server_error"
              : "status_0";
        lastError = `ผลส่ง LINE ยังยืนยันไม่ได้ (${failureKind}${status ? ` HTTP ${status}` : ""}) — quarantine และห้ามส่งซ้ำกลุ่มเดิม`;
        const quarantined = db.quarantineBroadcastClaim(channelId, broadcastId, claimOwnerToken, {
          lineUserIds: scopedIds(batch),
          batchNo: Math.floor(i / BROADCAST_BATCH_SIZE),
          retryKey,
          providerStatus: status,
          failureKind,
          sentCount: sent,
          failedCount: failed,
          lastSentIndex,
          lastError,
          quarantineId: deliveryGuard.id,
        });
        if (!quarantined) throw new Error("บันทึก broadcast quarantine ไม่สำเร็จ — runtime state unknown");
        quarantinePersisted = true;
        unknown = batch.length;
        try {
          db.addAudit({
            operator, action: "broadcast_delivery_quarantined", target: channelId,
            detail: `broadcast=${broadcastId}; batch=${Math.floor(i / BROADCAST_BATCH_SIZE)}; unknown=${unknown}; operator_review=true`.slice(0, 200),
          });
        } catch (error) {
          logger.warn?.(`broadcast: บันทึก audit quarantine ไม่สำเร็จ (${error?.message || error})`);
        }
        break;
      }
      if (ok) {
        try {
          db.settleBroadcastDeliveryAttempt(channelId, broadcastId, claimOwnerToken, {
            quarantineId: deliveryGuard.id,
            lineUserIds: scopedIds(batch),
            batchNo: Math.floor(i / BROADCAST_BATCH_SIZE),
            status: "sent",
          });
        } catch (error) {
          providerOutcomeUnknown = true;
          lastError = "provider ตอบรับแล้ว แต่ปิด durable delivery guard ไม่สำเร็จ — ห้ามส่งซ้ำจนตรวจโดย Owner/Admin";
          throw error;
        }
        sent += batch.length;
        lastSentIndex = i + queuedBatch.length - 1;
        // บันทึกลงประวัติแชทรายคน (proactive) — ห้องแชทเห็นว่าบรอดแคสอะไรไปเมื่อไหร่
        for (const customer of batch) {
          try {
            for (const m of storedMessages) {
              // 28 ก.ย. 2026: สติกเกอร์/การ์ดมีทรงบันทึกของตัวเอง (เดิม m.text ของการ์ด = "undefined")
              const row = storedMessageLogRow(m);
              db.insertMessage({
                customerId: customer.line_user_id,
                direction: "out",
                msgType: row.msgType,
                content: row.content,
                metadata: row.metadata,
                messageClass: "proactive",
                operator,
                agentMode: "operator_ai_on",
              });
            }
          } catch (err) {
            logger.debug?.(`broadcast: log ข้อความไม่สำเร็จ (${err?.message || err})`);
          }
        }
      } else {
        if (status === 429) {
          lastError = "LINE ตอบ HTTP 429 — หยุด batch ที่เหลือเพื่อกันส่งซ้ำ";
          stopRemaining = true;
        }
        try {
          db.settleBroadcastDeliveryAttempt(channelId, broadcastId, claimOwnerToken, {
            quarantineId: deliveryGuard.id,
            lineUserIds: scopedIds(batch),
            batchNo: Math.floor(i / BROADCAST_BATCH_SIZE),
            status: "failed",
            error: lastError,
          });
        } catch (error) {
          providerOutcomeUnknown = true;
          lastError = "provider ให้ผลแล้ว แต่ปิด durable delivery guard ไม่สำเร็จ — ห้ามส่งซ้ำจนตรวจโดย Owner/Admin";
          throw error;
        }
        failed += batch.length;
      }
        try {
          db.updateBroadcastProgress(broadcastId, { sentCount: sent, failedCount: failed, lastSentIndex, lastError });
        } catch { /* ความคืบหน้าหาย ไม่กระทบการส่ง */ }
      }
    } catch (err) {
      lastError = `งานส่งหยุดกะทันหัน: ${String(err?.message || err)}`;
      if (!providerOutcomeUnknown) {
        try {
          const remaining = Math.max(0, audience.length - sent - failed - skipped - cancelled);
          const marked = db.markBroadcastRecipients(broadcastId, scopedIds(audience), "failed", { error: lastError });
          failed += Math.max(remaining, marked);
        } catch {
          failed += Math.max(0, audience.length - sent - failed - skipped - cancelled);
        }
      }
      logger.warn?.(`broadcast: ${lastError}`);
      throw err;
    } finally {
      const terminal = {
        sentCount: sent, failedCount: failed,
        lastSentIndex,
        status: failed === 0 && cancelled === 0 ? "done" : (sent === 0 ? "failed" : "partial"),
        lastError,
      };
      let finalized = false;
      if (!providerOutcomeUnknown) {
        try {
          finalized = claimOwnerToken
            ? db.finalizeBroadcastClaim(channelId, broadcastId, claimOwnerToken, terminal)
            : db.updateBroadcastProgress(broadcastId, terminal);
        } catch (err) {
          // Atomic finalize failure deliberately preserves the claim. A later
          // process may reclaim only after its lease expires; never release here.
          logger.warn?.(`broadcast: ปิดงานแบบ atomic ไม่สำเร็จ (${err?.message || err})`);
        }
      } else if (!quarantinePersisted) {
        logger.error?.("broadcast: provider outcome unknown and quarantine persistence failed — runtime_state_unknown/manual_recovery");
      }
      if (finalized) {
        try {
          db.addAudit({
            operator, action: "broadcast_done", target: channelId,
            detail: `ส่งแล้ว ${sent}/${sent + failed + skipped + cancelled} คน${skipped ? ` (ตัดสิทธิ์ระหว่างส่ง ${skipped})` : ""}${cancelled ? ` (ยกเลิกก่อนส่ง ${cancelled})` : ""}${failed ? ` (ล้มเหลว ${failed}: ${lastError})` : ""}`.slice(0, 200),
          });
        } catch (err) {
          logger.warn?.(`broadcast: บันทึก audit ปิดงานไม่สำเร็จ (${err?.message || err})`);
        }
      }
    }
    if (unknown > 0) return { sent, failed, skipped, unknown, quarantined: true };
    return cancelled > 0 ? { sent, failed, skipped, cancelled } : { sent, failed, skipped };
  }

  return { guardCheck, runSend, sendReady, quotaFor, sendSelfTest, broadcastOwnerToken };
}
