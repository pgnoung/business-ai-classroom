// imageClassifier.mjs — ดูรูปก่อนตัดสินว่าเป็นเรื่องเงินไหม
//
// คำสั่งเจ้าของ 2026-08-29: เดิมรูป "ทุกใบ" ถูกตีเป็นเรื่องเงิน ลูกแพรจึงเงียบและห้องติดธง
// ถาวรที่ปลดได้ทางเดียวคือลบบทสนทนาทั้งห้องทิ้ง แต่ของจริงลูกค้าส่งรูปโพสต์ของพี่ง้วง
// มาถามว่า "สอนอันนี้ไหม" บ่อยกว่าส่งสลิป — ลีดคุณภาพดีจึงตายเงียบทุกครั้ง
//
// ทิศทางความเสียหายไม่สมมาตร และเป็นกติกาเดียวที่คุมทั้งไฟล์นี้:
//   พลาดจับสลิป -> บอทอาจยืนยันยอดเอง เงินผิดกู้คืนไม่ได้
//   จับเกิน      -> เสียลีด ซึ่งคนแก้ได้
// ดังนั้น "other" ต้องมาจากการที่โมเดลบอกชัดเท่านั้น ทุกความล้มเหลว ทุกคำตอบที่อ่านไม่ออก
// ทุก timeout ต้องออกมาเป็น "unknown" ซึ่งฝั่ง safetyRouter ถือเป็นเรื่องเงินไว้ก่อน
// ห้ามมีเส้นทางไหนในไฟล์นี้ที่ความผิดพลาดกลายเป็น "other"

// เคสจริง 2026-09-05: รูปจริงจากลูกค้าขนาด 1,067,264 ไบต์ (PNG 960x1280) ถูกเกตเวย์ของเราเอง
// (openai-stateless-gateway.mjs) ตอบ HTTP 400 เพราะ data URI base64 พองขึ้น ~33% เป็นราว 1.42MB
// ชนเพดาน body รวม 1 MiB ในวันนั้น — ค่าเดิม 3.5MB ของไฟล์นี้จึงโกหกมาตลอด
// วันเดียวกันยกเพดาน body ของเกตเวย์เป็น 6 MiB (MAX_REQUEST_BYTES) ส่วนเพดานรูปต่อใบของเกตเวย์
// คือ MAX_IMAGE_BYTES = 4,000,000 ตัวอักษรของ data URI -> ไบต์ดิบสูงสุดที่ผ่านได้จริง ≈ 4,000,000 / 1.37
// ตั้งไว้ 2,900,000 ให้มีที่หายใจ: รูปถ่ายสลิป/หน้าจอจากมือถือ (1-2.5MB) ต้องได้รับการจำแนก
// ไม่ใช่ตกเป็น unknown แล้วปิด AI ทั้งห้อง; ใหญ่กว่านี้ยังตกเป็น unknown พร้อมเหตุผล "รูปใหญ่เกิน"
export const MAX_CLASSIFY_BYTES = 2_900_000;
export const ALLOWED_MIME = Object.freeze(["image/jpeg", "image/png"]);
export const KINDS = Object.freeze(["slip", "document", "other"]);

const MONEY_KINDS = new Set(["slip", "document"]);
export const isMoneyImageKind = (kind) => MONEY_KINDS.has(String(kind || ""));

// ---- ตรวจปรปักษ์ 2026-09-05: โมเดลตอบ kind "other" แต่บรรยายว่าเป็นสลิป ----
//
// ตัวแกะคำตอบเชื่อ field "kind" อย่างเดียว ถ้าโมเดลขัดกันเอง
// ({"kind":"other","description":"สลิปโอนเงิน ... ธนาคาร ..."}) รูปนั้นจะกลายเป็นข้อความ
// "(ลูกค้าส่งรูปมา: …)" เดินเส้นคุยปกติ และด่านคำนามใน safetyRouter ก็ถูกปิดไว้สำหรับข้อความ
// สังเคราะห์ชุดนี้พอดี = ชั้นกันพลาดชั้นที่สองหายไปทั้งชั้น
// ทิศทางความเสียหายของไฟล์นี้ไม่สมมาตรอยู่แล้ว (พลาดสลิป = เงินผิดกู้ไม่ได้) จึงให้คำบรรยาย
// ที่พูดถึงหลักฐานการเงินชนะ kind เสมอ แล้วตกกลับเป็น "document" (ฝั่งเงิน)
export const MONEY_DESCRIPTION_NOUN =
  /สล[ิี]?[ปบ๊]|สร[ิี]ป|\bslip\b|ใบเสร็จ|ใบกำกับ|ใบแจ้งหนี้|ใบวางบิล|หลักฐาน(?:การ)?(?:โอน|ชำระ|จ่าย)|โอนเงิน|พร้อมเพย์/iu;
export const descriptionLooksLikeMoney = (description) => MONEY_DESCRIPTION_NOUN.test(String(description || ""));

// คำสั่งเขียนให้เอียงไปทาง "เข้าเส้นเงิน" โดยตั้งใจ — ถ้าโมเดลลังเลระหว่างสองทาง
// ต้องเลือกทางที่ปลอดภัยกว่าเสมอ
const INSTRUCTION = [
  "คุณคือตัวจำแนกรูปของระบบแชตลูกค้า ตอบเป็น JSON บรรทัดเดียวเท่านั้น",
  'รูปแบบ: {"kind":"slip"|"document"|"other","description":"คำอธิบายสั้นไม่เกิน 100 ตัวอักษร"}',
  "",
  'ใช้ "slip" เมื่อเป็นหลักฐานการโอน/ชำระเงิน เช่น สลิปธนาคาร หน้าจอแอปธนาคาร QR พร้อมเพย์ที่มียอด ใบเสร็จการจ่าย',
  'ใช้ "document" เมื่อเป็นเอกสารทางการหรือเอกสารธุรกิจ เช่น ใบเสนอราคา ใบกำกับภาษี ใบแจ้งหนี้ หนังสือรับรองบริษัท บัตรประชาชน',
  'ใช้ "other" เมื่อไม่ใช่สองอย่างข้างบนอย่างชัดเจน เช่น ภาพโฆษณา โพสต์โซเชียล ภาพหน้าจอเว็บ ภาพสินค้า ภาพถ่ายทั่วไป มีม สติกเกอร์',
  "",
  'ถ้าลังเลระหว่าง slip/document กับ other ให้เลือกฝั่ง slip หรือ document เสมอ',
  'ถ้าดูไม่ออกจริง ๆ ให้ตอบ {"kind":"document","description":"ดูไม่ออก"}',
  "ห้ามอ่านตัวเลขยอดเงินหรือเลขบัญชีออกมาใน description",
].join("\n");

function parseVerdict(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  // โมเดลชอบห่อ JSON ด้วย ```json — ตัดออกก่อน แต่ไม่พยายามซ่อมอย่างอื่น
  const text = raw.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "").trim();
  let parsed;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  if (typeof parsed.kind !== "string" || !KINDS.includes(parsed.kind)) return null;
  const description = typeof parsed.description === "string" ? parsed.description.replace(/\s+/gu, " ").trim().slice(0, 120) : "";
  return { kind: parsed.kind, description };
}

/**
 * @param {Buffer|Uint8Array|null} bytes ไบต์ของรูปที่ดาวน์โหลดมาแล้ว
 * @param {string} mime ชนิดไฟล์ที่บันทึกไว้
 * @param {(messages:Array)=>Promise<string>} callModel ตัวยิงเข้าโมเดล คืนข้อความดิบ
 * @returns {Promise<{kind:"slip"|"document"|"other"|"unknown",description:string}>}
 */
export async function classifyImage({ bytes, mime = "", callModel, logger = console } = {}) {
  // เคสจริง 2026-09-05: ops ไล่ย้อนรูป 14 ห้องที่ถูกปิดแล้วแยกไม่ออกเลยว่า "เกตเวย์ปฏิเสธรูป 1MB"
  // กับ "สวิตช์จำแนกยังไม่เปิด" ต่างกันตรงไหน เพราะทุกทางออกมาเป็น unknown เปล่า ๆ เหมือนกันหมด
  // จึงคืน reason ติดไปด้วย (ไปโผล่ใน audit ของไปป์ไลน์) — สัญญา fail-closed ไม่เปลี่ยน:
  // ทุกความล้มเหลวยังเป็น kind "unknown" เหมือนเดิม reason เป็นแค่ข้อมูลประกอบ ไม่มีใครใช้ตัดสิน
  const size = bytes && typeof bytes.length === "number" ? bytes.length : 0;
  // reasonCode ไม่ได้เปลี่ยนสัญญา fail-closed (ทุกความล้มเหลวยังเป็น kind "unknown")
  // มันตอบคำถามเดียวให้ไปป์ไลน์: "เราได้ลองดูรูปใบนี้จริงไหม" — รูปที่ลองแล้วจำแนกไม่ออก
  // ยังเป็นสลิปได้เต็ม ๆ ต่างจากรูปที่ระบบไม่เคยแตะเลยเพราะสวิตช์ปิด/ไฟล์ยังไม่มา
  const unknown = (why, reasonCode) => {
    const reason = size > 0 ? `${why} (${size} ไบต์)` : why;
    logger.warn?.(`imageClassifier: จำแนกไม่ได้ (${reason}) — ถือเป็นเรื่องเงินไว้ก่อน`);
    return { kind: "unknown", description: "", reason, reasonCode };
  };
  if (!bytes || typeof bytes.length !== "number" || bytes.length < 1) return unknown("ไม่มีไบต์รูป", "no_bytes");
  if (bytes.length > MAX_CLASSIFY_BYTES) return unknown(`รูปใหญ่เกิน ${bytes.length}>${MAX_CLASSIFY_BYTES}`, "too_large");
  if (!ALLOWED_MIME.includes(String(mime))) return unknown(`ชนิดไฟล์ไม่รองรับ ${mime}`, "bad_mime");
  if (typeof callModel !== "function") return unknown("ไม่มีตัวเรียกโมเดล", "no_model");

  const url = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
  const messages = [
    { role: "system", content: INSTRUCTION },
    { role: "user", content: [{ type: "text", text: "รูปนี้คืออะไร" }, { type: "image_url", image_url: { url } }] },
  ];

  let raw;
  try {
    raw = await callModel(messages);
  } catch (err) {
    return unknown(`เรียกโมเดลล้ม: ${err?.message || err}`, "model_error");
  }
  const verdict = parseVerdict(raw);
  if (!verdict) return unknown("อ่านคำตอบของโมเดลไม่ออก", "unparsable");
  // คำบรรยายชนะ kind เมื่อสองอย่างขัดกัน — ดู MONEY_DESCRIPTION_NOUN
  if (verdict.kind === "other" && descriptionLooksLikeMoney(verdict.description)) {
    return { ...verdict, kind: "document", reason: "คำอธิบายบอกว่าเป็นหลักฐานการเงิน แม้โมเดลตอบ other", reasonCode: "" };
  }
  return { ...verdict, reason: "", reasonCode: "" };
}
