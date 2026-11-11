// imageCatalog.mjs — แคตตาล็อกรูป "อนุมัติแล้วเท่านั้น" สำหรับขาออก LINE
//
// กติกาเหล็ก (prior art ที่พิสูจน์แล้วจากงาน Fern):
// - model ห้ามสร้าง/เดา URL รูปเองเด็ดขาด — เลือกได้เฉพาะ key จากแคตตาล็อกนี้
//   ผ่าน marker [IMAGE:key] (tolerate [image:key]) ในข้อความ draft
// - chassis เป็นคน parse marker + แปลง key -> URL ที่ผ่านการตรวจแล้ว
// - key ที่ไม่อยู่ในแคตตาล็อก = ทิ้งพร้อม warn (ห้ามเดา ห้ามส่ง)
// - ไฟล์แคตตาล็อกพัง/หาย = แคตตาล็อกว่าง (ฟีเจอร์ปิดเอง ไม่ล้มระบบ)
import { existsSync, readFileSync } from "node:fs";

// marker ทั้ง [IMAGE:key] และ [image:key] (case-insensitive) — key คือทุกอย่างจนถึง ]
export const IMAGE_MARKER_PATTERN = /\[image:([^\]]*)\]/giu;

// โหลดไฟล์ JSON แคตตาล็อก — รับ 2 รูปแบบ:
//   1. bare array [{key, url, preview_url?, description?, needs_verification?}]
//   2. object ห่อ { images: [...] } (ไฟล์จาก data pipeline — key อื่น ๆ เช่น
//      generated/source/excluded ถูกข้ามเฉย ๆ)
// -> [{key, url, previewUrl, description, needsVerification}] เฉพาะ entry ที่ผ่านการตรวจ
export function loadImageCatalog(file, { logger = console } = {}) {
  if (!file || !existsSync(file)) return []; // ไม่มีไฟล์ = ฟีเจอร์รูปปิดอยู่ ไม่ใช่ error
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    logger.warn?.(`imageCatalog: อ่านแคตตาล็อกไม่ได้ (${err?.message || err}) — ใช้แคตตาล็อกว่าง`);
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.images)
      ? parsed.images
      : null;
  if (!list) {
    logger.warn?.("imageCatalog: ไฟล์ต้องเป็น JSON array หรือ object ที่มี images เป็น array — ใช้แคตตาล็อกว่าง");
    return [];
  }

  const entries = [];
  const seen = new Set();
  for (const item of list) {
    const key = typeof item?.key === "string" ? item.key.trim() : "";
    const url = typeof item?.url === "string" ? item.url.trim() : "";
    if (!key) {
      logger.warn?.("imageCatalog: ข้าม entry ที่ไม่มี key");
      continue;
    }
    if (seen.has(key)) {
      logger.warn?.(`imageCatalog: key ซ้ำ "${key}" — ใช้ตัวแรก ข้ามตัวหลัง`);
      continue;
    }
    // LINE image message บังคับ https อยู่แล้ว — อย่างอื่น (http/ftp/relative) ปฏิเสธที่ต้นทาง
    if (!url.startsWith("https://")) {
      logger.warn?.(`imageCatalog: ข้าม "${key}" — url ต้องขึ้นต้น https:// (ได้ "${url.slice(0, 60)}")`);
      continue;
    }
    const previewRaw = typeof item?.preview_url === "string" ? item.preview_url.trim() : "";
    let previewUrl = url; // default: ใช้รูปเต็มเป็น preview
    if (previewRaw) {
      if (previewRaw.startsWith("https://")) previewUrl = previewRaw;
      else logger.warn?.(`imageCatalog: preview_url ของ "${key}" ไม่ใช่ https:// — ใช้ url หลักแทน`);
    }
    seen.add(key);
    entries.push({
      key,
      url,
      previewUrl,
      description: typeof item?.description === "string" ? item.description : "",
      needsVerification: item?.needs_verification === true,
    });
  }
  // log ตอน start เสมอ — โหลดได้ 0 key ต้องมองเห็น (เคยเงียบจนรูปหายทั้งระบบ)
  logger.log?.(`imageCatalog: โหลดแคตตาล็อกสำเร็จ ${entries.length} key จาก ${file}`);
  return entries;
}

// ดึง marker จาก draft: คืน { text (marker ถูกลอกออกหมด), images (เฉพาะ key ที่อยู่ในแคตตาล็อก),
// dropped (key แปลกหน้าที่ถูกทิ้ง — ให้ caller เอาไปแจ้งเตือน/toast ได้) }
// - unique ตามลำดับที่เจอ สูงสุด maxImages รูป
// - key แปลกหน้า = ทิ้งพร้อม warn — ห้ามเดา URL แทนเด็ดขาด
// - marker ทุกตัว (รวมตัวที่โดนทิ้ง) ถูกลอกออกจากข้อความก่อนถึง humanizer
export function extractImageMarkers(text, { catalog = [], maxImages = 6, logger = console } = {}) {
  const value = String(text || "");
  const byKey = catalog instanceof Map ? catalog : new Map(catalog.map((entry) => [entry.key, entry]));

  const images = [];
  const dropped = [];
  const overflow = [];
  const seenKeys = new Set();
  for (const match of value.matchAll(IMAGE_MARKER_PATTERN)) {
    const key = String(match[1] || "").trim();
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const entry = byKey.get(key);
    if (!entry) {
      logger.warn?.(`imageCatalog: marker key "${key}" ไม่อยู่ในแคตตาล็อก — ทิ้ง (ห้ามเดา URL)`);
      dropped.push(key);
      continue;
    }
    if (entry.needsVerification === true) {
      logger.warn?.(`imageCatalog: marker key "${key}" ยัง needs_verification — ทิ้งจนกว่าจะตรวจผ่าน`);
      dropped.push(key);
      continue;
    }
    if (images.length >= maxImages) {
      // v1.4.13 (audit จับ): เดิมทิ้งเงียบ — operator เห็น ok แล้วเชื่อว่าส่งครบ
      // ต้องคืน key ที่เกินเพดานให้ caller เตือนคนเสมอ (คนละเหตุกับ dropped = ไม่รู้จัก key)
      logger.warn?.(`imageCatalog: รูปเกินเพดาน ${maxImages} รูป/ตอบ — ทิ้ง "${key}"`);
      overflow.push(key);
      continue;
    }
    images.push({ key: entry.key, url: entry.url, previewUrl: entry.previewUrl || entry.url });
  }

  const stripped = value
    .replace(IMAGE_MARKER_PATTERN, "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .replace(/[ \t]{2,}/gu, " ")
    .trim();

  return { text: stripped, images, dropped, overflow };
}
