// identityLinkCodes.mjs — รหัสเชื่อมแชท Facebook → LINE + ข้อความที่ลูกค้าเห็น (28 ก.ย. 2026)
//
// พี่ง้วง: "ลูกค้าทักมาจาก fb และจบคลาส ลูกค้าเข้า LINE OA แต่ลูกแพร ai ไม่ทราบว่าเป็นลูกค้าเก่า ... จะได้ seamless"
// ไฟล์นี้เป็นฟังก์ชันบริสุทธิ์ล้วน (ไม่แตะฐาน ไม่ยิงเน็ต) — ตัวทำงานจริงอยู่ที่ identityLink.mjs
//
// รหัส: "LK-XXXXX-XXXXX" = 10 ตัวจากชุด Crockford base32 (ไม่มี I L O U) = 50 บิต สุ่มด้วย crypto
//   · ฐานเก็บแค่ HMAC-SHA256 ของรหัส (กุญแจ = ความลับของ instance ที่อยู่นอกฐาน) — ฐานรั่วก็เดารหัสย้อนไม่ได้
//   · ใช้ได้ครั้งเดียว · หมดอายุ 30 วัน · ส่งผิดเกินเพดานต่อห้อง/ทั้งระบบ = ไม่ตรวจต่อ (identityLink.mjs)
//   · พิมพ์เองก็ได้: ตัวเล็ก/ไม่มีขีด/เว้นวรรค/O↔0/I,L↔1 อ่านเป็นรหัสเดียวกัน
// ลิงก์: https://line.me/R/oaMessage/{LINE ID ที่ percent-encode}/?{ข้อความที่ percent-encode}
//   ตรวจกับเอกสาร LINE 28 ก.ย. 2026 (developers.line.biz/en/docs/messaging-api/using-line-url-scheme/):
//   ใช้ basic ID หรือ premium ID ได้ · ต้อง percent-encode ทั้ง ID และข้อความแบบ UTF-8
//   · ใช้ได้ใน LINE บน iOS/Android เท่านั้น (LINE บน PC ไม่รองรับ) — ข้อความเชิญจึงบอกรหัสไว้ให้พิมพ์เองด้วย
import { activeBrand, isGenericProfile } from "./brand.mjs";
import { createHmac, randomInt } from "node:crypto";

export const IDENTITY_LINK_MODE_KEY = "identity_link_mode";
// off    = ไม่มีข้อความถึงลูกค้าเลย (ค่าเริ่มต้น) — แผงในคอนโซล + เชื่อม/ยกเลิกด้วยมือยังใช้ได้
// manual = ปุ่ม "ส่งลิงก์ไลน์ให้ลูกค้า" ในห้อง Facebook ใช้ได้ + ตอบรับใน LINE เมื่อเชื่อมสำเร็จ
// auto   = manual + ส่งลิงก์ให้เองหนึ่งครั้ง เมื่อทีมติดป้าย customer หรือกดยืนยันยอดในห้อง Facebook
export const IDENTITY_LINK_MODES = Object.freeze(["off", "manual", "auto"]);

export function identityLinkMode(db) {
  // White-label: โปรไฟล์ generic ปิดฟีเจอร์เฉพาะธุรกิจคอร์สของพี่ง้วงเสมอ (ค่าใน DB ไม่มีผล)
  if (isGenericProfile(activeBrand())) return "off";
  try {
    const value = String(db.getSetting(IDENTITY_LINK_MODE_KEY) ?? "").trim();
    return IDENTITY_LINK_MODES.includes(value) ? value : "off";
  } catch {
    return "off"; // อ่านสวิตช์ไม่ได้ = ไม่ส่งอะไรถึงลูกค้า (fail-closed)
  }
}

export const CODE_PREFIX = "LK";
export const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 10;
export const CODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const MASKED_CODE = "LK-•••••-•••••";
const HASH_DOMAIN = "lukprae-identity-link-code-v1\0";

/** รหัสใหม่รูป LK-XXXXX-XXXXX — สุ่มทีละตัวด้วย crypto.randomInt (กระจายเท่ากันทุกตัวอักษร) */
export function generateLinkCode(pick = randomInt) {
  let body = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) body += CODE_ALPHABET[pick(CODE_ALPHABET.length)];
  return `${CODE_PREFIX}-${body.slice(0, 5)}-${body.slice(5)}`;
}

/** ตัวรหัส 10 ตัวที่ปรับรูปแล้ว หรือ "" ถ้าไม่ใช่รหัสที่เป็นไปได้ (รับทั้งแบบมี/ไม่มี LK นำหน้า) */
export function normalizeLinkCode(raw) {
  let text = String(raw ?? "").normalize("NFKC").toUpperCase().replace(/[^0-9A-Z]/gu, "");
  if (text.length === CODE_LENGTH + CODE_PREFIX.length && text.startsWith(CODE_PREFIX)) text = text.slice(CODE_PREFIX.length);
  if (text.length !== CODE_LENGTH) return "";
  const mapped = text.replace(/[IL]/gu, "1").replace(/O/gu, "0");
  return [...mapped].every((ch) => CODE_ALPHABET.includes(ch)) ? mapped : "";
}

export function formatLinkCode(normalized) {
  const body = normalizeLinkCode(normalized);
  return body ? `${CODE_PREFIX}-${body.slice(0, 5)}-${body.slice(5)}` : "";
}

// "LK" + ตัวคั่นได้ไม่เกิน 3 ตัว + 10 ตัวอักษร/ตัวเลข (คั่นทีละตัวได้) และต้องไม่ติดตัวอักษรอื่นหน้า/หลัง
// (ข้อความยาวที่บังเอิญมี LK ตามด้วยสิบกว่าตัวจึงไม่ถูกนับ) — ตัวอักษรไทยนำหน้าได้ ("รหัสLK-…")
const TOKEN_SOURCE = String.raw`(?<![0-9A-Za-z])[Ll][\s]?[Kk][\s\-–—_:.]{0,3}((?:[0-9A-Za-z][\s\-–—_.]?){9}[0-9A-Za-z])(?![0-9A-Za-z])`;
const tokenRe = () => new RegExp(TOKEN_SOURCE, "gu");
// รหัสพร้อมคำนำ/วงเล็บที่ครอบ ("(รหัส LK-…)", "รหัสเชื่อมแชท: LK-…") — ใช้ตอนตัดรหัสออกจากข้อความให้ลูกแพร
const wrappedTokenRe = () => new RegExp(
  String.raw`(?:[(（[]\s*)?(?:รหัส(?:เชื่อมแชท|ยืนยัน)?\s*[:：]?\s*)?${TOKEN_SOURCE}(?:\s*[)）\]])?`, "gu",
);
const MAX_TOKENS = 3;

/** รหัสที่พบในข้อความ (ไม่เกิน 3) — code = ตัวรหัสปรับรูปแล้ว, ตัวที่ไม่ใช่รหัสที่เป็นไปได้ถูกตัดทิ้ง */
export function findLinkCodeTokens(text) {
  const out = [];
  for (const match of String(text ?? "").normalize("NFC").matchAll(tokenRe())) {
    const code = normalizeLinkCode(match[1]);
    if (!code) continue;
    out.push({ raw: match[0], code, index: match.index });
    if (out.length >= MAX_TOKENS) break;
  }
  return out;
}

/** HMAC ของรหัสที่ปรับรูปแล้ว — ไม่มีกุญแจ = คืน "" (ผู้เรียกต้องถือว่าออก/ตรวจรหัสไม่ได้) */
export function hashLinkCode(code, secret) {
  const body = normalizeLinkCode(code);
  const key = String(secret ?? "");
  if (!body || !key) return "";
  return createHmac("sha256", key).update(HASH_DOMAIN).update(body).digest("hex");
}

/** ปิดรหัสทุกตัวในข้อความก่อนเก็บลงประวัติ (รหัสที่ใช้แล้ว/ใช้ไม่ได้ก็ไม่ต้องเหลือให้ใครอ่าน) */
export function maskLinkCodes(text) {
  return String(text ?? "").normalize("NFC").replace(tokenRe(), MASKED_CODE);
}

/** ข้อความที่ลูกแพรเห็นแทนข้อความดิบ: เอารหัส (และวงเล็บ "รหัส …" ที่ครอบ) ออก — รหัสไม่ใช่คำสั่งถึง AI */
export function textWithoutLinkCodes(text) {
  return String(text ?? "").normalize("NFC")
    .replace(wrappedTokenRe(), " ")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\s*\n\s*/gu, "\n")
    .trim();
}

// คำที่อยู่ในข้อความสำเร็จรูปของเราเอง + คำทักทาย/คำลงท้าย — ถ้าตัดออกแล้วไม่เหลืออะไร
// แปลว่าลูกค้าแค่กดส่งข้อความที่เราเตรียมให้ (ไม่มีคำถามให้ลูกแพรตอบต่อ)
const TEMPLATE_NOISE = [
  /ต่อแชท(?:กัน)?(?:จาก|ต่อจาก)?\s*(?:facebook|เฟซบุ๊ก|เฟสบุ๊ค|เฟสบุ๊ก|fb|messenger)/giu,
  /รหัส(?:เชื่อมแชท|ยืนยัน)?/gu,
  /สวัสดี|หวัดดี|ดีค่ะ|ดีครับ|hello|hi\b/giu,
  /นะคะ|นะครับ|ครับ|ค่ะ|คะ|ค่า|คับ|จ้า|จ้ะ/gu,
];

/** true = ข้อความนี้มีแค่ข้อความสำเร็จรูป/คำทักทาย ไม่มีเรื่องอื่นให้ตอบ */
export function isTemplateOnlyMessage(text) {
  let rest = String(text ?? "").normalize("NFC").replace(tokenRe(), " ");
  for (const pattern of TEMPLATE_NOISE) rest = rest.replace(pattern, " ");
  return !/[\p{L}\p{N}]/u.test(rest);
}

/** basic/premium ID ของ OA ในรูป "@xxxx" ตัวเล็ก — ผิดรูปคืน "" (ห้ามเดาเติมให้) */
export function normalizeLineBasicId(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return "";
  const id = raw.startsWith("@") ? raw : `@${raw}`;
  return /^@[a-z0-9._-]{2,30}$/u.test(id) ? id : "";
}

// percent-encode แบบ RFC 3986 เต็ม (ตัวอย่างในเอกสาร LINE เข้ารหัส "!" เป็น %21 ซึ่ง encodeURIComponent ปล่อยผ่าน)
const strictEncode = (value) => encodeURIComponent(String(value ?? ""))
  .replace(/[!'()*]/gu, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

/** ลิงก์เปิดแชท OA พร้อมข้อความเตรียมไว้ (ลูกค้ายังต้องกดส่งเอง — LINE ไม่ส่งแทน) */
export function lineOaMessageUrl(basicId, text) {
  const id = normalizeLineBasicId(basicId);
  if (!id) return "";
  return `https://line.me/R/oaMessage/${strictEncode(id)}/?${strictEncode(text)}`;
}

/* ------------------------------ ข้อความในช่องพิมพ์ของ LINE ------------------------------ */
// ข้อความถึงลูกค้าทั้งหมด (เชิญ/หลังเชื่อม) อยู่ที่ identityLinkClasses.mjs — แยกตามคลาสที่ซื้อ (คำตอบพี่ง้วง 28 ก.ย.)
// รหัสใช้ไม่ได้ = ไม่มีข้อความถึงลูกค้าเลย ("ไม่ต้องครับ") · ลูกค้าที่ยังไม่ซื้อไม่ได้รับเชิญ ("ให้อยู่ที่ facebook ก่อน")

/**
 * ข้อความที่เตรียมไว้ในช่องพิมพ์ของ LINE = ตัวรหัสล้วน (ลูกค้าแก้ก่อนส่งได้)
 * จงใจไม่ใส่ภาษาไทย: ลิงก์ต้อง percent-encode ข้อความทั้งหมด ไทยหนึ่งตัวกลายเป็น 9 ตัวอักษร
 * ลิงก์ในแชท Facebook จึงยาวเป็น "%E0%B8%95%E0%B9%88…" สองร้อยกว่าตัว (เห็นจริงในภาพหน้าจอ 28 ก.ย.)
 * รหัสล้วนได้ลิงก์สั้นอ่านออก: https://line.me/R/oaMessage/%40xxxx/?LK-XXXXX-XXXXX
 * — หลังเชื่อม ลูกค้าได้ "สวัสดีค่ะ คุณ{ชื่อ}" + รายละเอียดคลาสใน LINE ทันที (พิมพ์ทักทายเพิ่มก็ยังอ่านรหัสเจอ)
 */
export function identityLinkPrefill(code) {
  return String(code ?? "");
}
