// adThumbs.mjs — เก็บสำเนารูปแอดไว้ในฐานข้อมูล ให้แถบ "มาจากโฆษณา" มีรูปตลอด (พี่ง้วง 6 ต.ค. 2026 ค่ำ:
// "ให้รูปอยู่ตลอดดีกว่า เพราะจะได้เช็ค และทำ analytic ใดๆง่าย")
//
// ทำไม: ลิงก์รูปที่ Meta ส่งมากับ referral (และ thumbnail ของ creative) เป็นลิงก์ CDN ที่เซ็นวันหมดอายุไว้ไม่กี่วัน
// พอหมดอายุ แถบในห้องแชทเหลือแต่ภาพสำรอง — จึงโหลดรูปมาเก็บครั้งเดียวต่อแอด (ตาราง ad_thumbs) แล้วเสิร์ฟเอง
//
// กติกา:
// - โหลดเฉพาะลิงก์ https บน CDN ของ Meta (photoUrlValue) · ไม่ตามเปลี่ยนทาง (redirect: error) — กัน SSRF
// - ตรวจไบต์หัวไฟล์ว่าเป็นรูปจริง (JPEG/PNG/WEBP/GIF) ไม่เชื่อ content-type · เพดาน AD_THUMB_MAX_BYTES
// - ห้ามขวางเส้นรับข้อความ: kick() คืนทันที งานวิ่งเบื้องหลังทีละรูป พังแค่จด log แล้วพักแอดนั้นไว้ก่อน
// - เป็นรูปแอดของเพจเราเอง ไม่ผูกกับลูกค้าคนไหน (ไม่มี customer_id) · อยู่ในไฟล์ DB จึงติดไปกับสำรองทุกคืน
import { photoUrlValue } from "./adReferral.mjs";

export const AD_THUMB_MAX_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 10_000;
const BATCH = 20;
const MIN_INTERVAL_MS = 60_000;
const RETRY_AFTER_MS = 6 * 3_600_000;

/** ชนิดรูปจากไบต์หัวไฟล์ — ไม่ใช่รูปที่รองรับ = '' */
export function sniffImageType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && String.fromCharCode(...b.slice(0, 4)) === "RIFF" && String.fromCharCode(...b.slice(8, 12)) === "WEBP") return "image/webp";
  if (b.length >= 4 && String.fromCharCode(...b.slice(0, 4)) === "GIF8") return "image/gif";
  return "";
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`รูปใหญ่เกิน ${maxBytes} ไบต์`);
  if (!res.body?.getReader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > maxBytes) throw new Error(`รูปใหญ่เกิน ${maxBytes} ไบต์`);
    return buf;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* ปิดไม่ได้ก็ทิ้ง */ }
      throw new Error(`รูปใหญ่เกิน ${maxBytes} ไบต์`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

/** โหลดรูปแอดหนึ่งรูปจาก CDN ของ Meta — คืน { contentType, bytes } หรือ throw */
export async function fetchAdThumb(url, { fetchImpl, maxBytes = AD_THUMB_MAX_BYTES, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const safe = photoUrlValue(url);
  if (!safe) throw new Error("ไม่ใช่ลิงก์รูปบน CDN ของ Meta");
  if (typeof fetchImpl !== "function") throw new Error("ไม่มีตัวโหลด");
  const res = await fetchImpl(safe, {
    redirect: "error", headers: { accept: "image/*" }, signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res?.ok) throw new Error(`CDN ตอบ ${res?.status ?? "?"}`);
  const bytes = await readCapped(res, maxBytes);
  const contentType = sniffImageType(bytes);
  if (!contentType) throw new Error("ไฟล์ที่ได้ไม่ใช่รูปที่รองรับ");
  return { contentType, bytes };
}

/**
 * ตัวเก็บรูปเบื้องหลัง — kick() ปลุกให้ไล่เก็บรูปของแอดที่ยังไม่มีสำเนา (ทีละ BATCH รูป ทีละรูป)
 * ปลุกซ้ำระหว่างวิ่ง = วิ่งอีกรอบหลังจบ (แอดใหม่ที่เพิ่งคลิกไม่ตกหล่น) · ไม่ force = เว้นระยะ MIN_INTERVAL_MS
 */
export function createAdThumbKeeper({
  db, fetchImpl, logger = console, now = Date.now,
  minIntervalMs = MIN_INTERVAL_MS, retryAfterMs = RETRY_AFTER_MS, batch = BATCH,
} = {}) {
  let running = null;
  let again = false;
  let stopped = false;
  let lastStart = -Infinity;
  const failedUntil = new Map();

  async function runOnce() {
    let saved = 0;
    let failed = 0;
    const t = now();
    for (const [adId, until] of failedUntil) if (until <= t) failedUntil.delete(adId);
    const pending = db.adsMissingThumb?.(batch, { exclude: [...failedUntil.keys()] }) || [];
    for (const row of pending) {
      if (stopped) break;
      try {
        const { contentType, bytes } = await fetchAdThumb(row.photo_url, { fetchImpl });
        db.saveAdThumb({ adId: row.ad_id, contentType, bytes, sourceUrl: row.photo_url });
        failedUntil.delete(row.ad_id);
        saved += 1;
      } catch (err) {
        failedUntil.set(row.ad_id, now() + retryAfterMs);
        failed += 1;
        try { logger?.warn?.(`ad thumbs: เก็บรูปแอด ${row.ad_id} ไม่สำเร็จ (${err?.message || err}) — ลองใหม่ภายหลัง`); } catch { /* */ }
      }
    }
    return { saved, failed };
  }

  async function loop() {
    let total = { saved: 0, failed: 0 };
    // เส้นที่ปลุก (webhook/เปิดห้อง) ต้องไม่จ่ายค่า SQL ของตัวเก็บรูป — เริ่มรอบถัดไปของ event loop
    await new Promise((resolve) => setImmediate(resolve));
    do {
      again = false;
      if (stopped) break;
      const result = await runOnce();
      total = { saved: total.saved + result.saved, failed: total.failed + result.failed };
    } while (again);
    return total;
  }

  function kick({ force = false } = {}) {
    if (stopped) return null;
    if (running) { again = true; return running; }
    if (!force && now() - lastStart < minIntervalMs) return null;
    lastStart = now();
    running = loop()
      .catch((err) => {
        try { logger?.warn?.(`ad thumbs: รอบเก็บรูปล้ม (${err?.message || err})`); } catch { /* */ }
        return { saved: 0, failed: 0 };
      })
      .finally(() => { running = null; });
    return running;
  }

  /** ระหว่างปิดบริการ: ไม่เริ่มรอบใหม่ และรอบที่เดินอยู่หยุดก่อนโหลดรูปถัดไป */
  function stop() {
    stopped = true;
  }

  return { kick, stop };
}
