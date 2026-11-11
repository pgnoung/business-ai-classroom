// inboundImageClassifier.mjs — ต่อรูปที่ดาวน์โหลดจาก LINE เข้ากับตัวจำแนก
//
// หน้าที่เดียว: หาไบต์ของรูปให้ได้ แล้วส่งให้ imageClassifier.mjs ตัดสิน
// ตัวตัดสินใจ (safetyRouter) และไปป์ไลน์เป็นคนใช้ผลลัพธ์
//
// จังหวะเวลาเป็นเรื่องสำคัญ: LINE ส่ง event เข้ามา -> ระบบบันทึกแล้วสั่งดาวน์โหลดแบบไม่รอ
// (server.mjs queueMicrotask(runMediaIngest)) เส้นรูปไม่ผ่าน burst ของข้อความ จึงต้องมี
// งบรอไฟล์ของตัวเอง และปลุก retry ที่ถึงกำหนดผ่านตัวดาวน์โหลดเดิมที่มี lease/เพดาน
//
// fail closed ทุกทาง: ไม่มีไฟล์ · รอไม่ทัน · อ่านไม่ได้ · โมเดลล้ม -> คืน unknown
// ซึ่งฝั่งไปป์ไลน์ถือเป็นเรื่องเงินไว้ก่อน เพราะพลาดจับสลิปแล้วกู้เงินคืนไม่ได้

import { readFileSync } from "node:fs";
import { classifyImage } from "./imageClassifier.mjs";

const POLL_MS = 250;
// เคสจริง 2026-09-05: unknown เปล่า ๆ ทำให้ ops แยกไม่ออกว่ารูปนั้นเกตเวย์ปฏิเสธ ดาวน์โหลดไม่ทัน
// หรือสวิตช์ยังปิดอยู่ — ทุกทางออก unknown ต้องพก reason ติดไปให้ audit ของไปป์ไลน์เสมอ
// reasonCode บอกไปป์ไลน์ว่า "ระบบเคยเห็นไบต์ของรูปใบนี้จริงไหม" — สามเหตุในไฟล์นี้คือเหตุที่
// ยังไม่เคยเห็น (ตรวจปรปักษ์ 2026-09-05: การไม่ปักธงเงินให้รูปที่ "เคยเห็นแต่จำแนกไม่ออก"
// ทำให้สลิปจริงขนาดใหญ่หลุดจากตราเงินในคิวรอคน)
const unknown = (reason, reasonCode) => ({ kind: "unknown", description: "", reason, reasonCode });

export function createInboundImageClassifier({ config, db, privateMedia, hermes, logger = console, requestMediaIngest = () => {} } = {}) {
  const enabled = config?.imageClassifyEnabled === true
    && typeof hermes?.classifyImageMessages === "function"
    && Boolean(privateMedia?.enabled?.());
  const waitMs = Math.max(0, Number(config?.imageClassifyWaitMs) || 0);

  // หาไฟล์แนบของข้อความนี้ — ระบบเก็บ providerMessageId ไว้ตอนบันทึก inbound
  function findAttachment(customerId, messageId) {
    if (!messageId) return null;
    try {
      return db.raw.prepare(
        `SELECT id, status, mime, storage_key, next_attempt_at FROM message_attachments
          WHERE customer_id = ? AND provider_message_id = ? AND direction = 'in' AND kind = 'image'
          ORDER BY id DESC LIMIT 1`,
      ).get(String(customerId), String(messageId)) || null;
    } catch (err) {
      logger.warn?.(`inboundImageClassifier: หาไฟล์แนบไม่ได้ (${err?.message || err})`);
      return null;
    }
  }

  async function waitForReady(customerId, messageId) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const row = findAttachment(customerId, messageId);
      if (row?.status === "ready" && row.storage_key) return row;
      // สถานะที่จบแล้วแต่ไม่ใช่ ready (unavailable/failed) รอต่อไปก็ไม่มีประโยชน์
      if (row && row.status !== "queued") return null;
      if (Date.now() >= deadline) return null;
      // A transient fetch already has a bounded retry time in the durable queue.
      // Nudge only due rows; the shared lock and lease keep concurrent fetches out.
      if (row?.status === "queued" && Number(row.next_attempt_at || 0) <= Date.now()) {
        requestMediaIngest();
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(POLL_MS, Math.max(0, deadline - Date.now()))));
    }
  }

  function readBytes(row) {
    let opened = null;
    try {
      opened = privateMedia.open(row.storage_key);
      return readFileSync(opened.path);
    } catch (err) {
      logger.warn?.(`inboundImageClassifier: อ่านไฟล์รูปไม่ได้ (${err?.message || err})`);
      return null;
    } finally {
      try { opened?.close?.(); } catch { /* ปิดไม่ได้ = ไม่ต้องทำอะไรต่อ */ }
    }
  }

  async function classify({ customerId = "", messageId = "" } = {}) {
    if (!enabled) return unknown("สวิตช์จำแนกรูปปิดอยู่", "disabled");
    const row = await waitForReady(customerId, messageId);
    if (!row) {
      logger.debug?.(`inboundImageClassifier: ไม่มีไฟล์รูปให้จำแนกทัน customer=${customerId}`);
      return unknown("ไม่มีไฟล์รูปให้จำแนกทัน (ดาวน์โหลดไม่เสร็จหรือไฟล์ใช้ไม่ได้)", "no_file");
    }
    const bytes = readBytes(row);
    if (!bytes) return unknown("อ่านไฟล์รูปที่เก็บไว้ไม่ได้", "read_error");
    return classifyImage({
      bytes,
      mime: String(row.mime || ""),
      callModel: (messages) => hermes.classifyImageMessages(messages),
      logger,
    });
  }

  return { enabled, classify };
}
