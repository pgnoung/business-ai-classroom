// brand.mjs — ชั้น white-label ของเอนจิน (ชื่อแอดมิน AI / เจ้าของ / ธุรกิจ / โปรไฟล์ธุรกิจ)
//
// หลักข้อเดียวที่ห้ามแตก: ไม่ได้ตั้ง env ใหม่ = ทุกข้อความออกมาเหมือนเดิมทุกตัวอักษร
// (ค่าเริ่มต้นคือแบรนด์ลูกแพร/พี่ง้วง ติดกระดุม ที่ production ใช้อยู่วันนี้)
//
// brandText() ใช้กับ "ข้อความที่โค้ดเขียนเอง" เท่านั้น (template / กติกาในพรอมต์ / ข้อความแจ้งทีม)
// ห้ามใช้กับข้อมูลของลูกค้า ทีมงาน หรือคลังความรู้ — ร้านผลไม้ที่ขาย "ลูกแพร" จริง ๆ ต้องไม่ถูกเขียนทับ
// แบรนด์เริ่มต้น = คืนข้อความเดิมทันที (ไม่มีการแทนที่ใด ๆ เลย)

export const BUSINESS_PROFILE_COURSE = "course";
export const BUSINESS_PROFILE_GENERIC = "generic";
export const BUSINESS_PROFILES = Object.freeze([BUSINESS_PROFILE_COURSE, BUSINESS_PROFILE_GENERIC]);

export const DEFAULT_AGENT_NAME = "ลูกแพร";
export const DEFAULT_OWNER_NAME = "พี่ง้วง";
export const DEFAULT_BUSINESS_NAME = "พี่ง้วง ติดกระดุม";
export const DEFAULT_REVIEW_DOMAINS = Object.freeze(["pngoungacademy.com"]);
// โปรไฟล์ generic ที่ไม่ได้ตั้งชื่อ — ห้ามตกกลับไปเป็นชื่อของพี่ง้วง/ลูกแพร
export const GENERIC_AGENT_NAME = "แอดมิน";
export const GENERIC_OWNER_NAME = "เจ้าของร้าน";
export const GENERIC_BUSINESS_NAME = "ร้านของเรา";

const NAME_MAX = 60;
const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;

// คำต้นทางที่ brandText แทนที่ — ชื่อใหม่ที่ "มีคำเหล่านี้อยู่ข้างใน" (เช่น "น้องลูกแพร") จะทำให้การแทนที่
// ไม่คงที่ (แทนซ้ำแล้วงอก) จึงปฏิเสธ เว้นแต่ตรงกับค่าเริ่มต้นของช่องนั้นเป๊ะ
const SOURCE_TOKENS = ["ลูกแพร", "น้องแพร", "พี่ง้วง", "ชมพู่", "LuKprae", "Lukprae"];

function cleanName(value, fallback, own = "") {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  // ตัวควบคุม/markup/ยาวเกิน = ค่าตั้งผิด — ถอยกลับค่าเริ่มต้นแทนการตัดคำแบบเดาใจ
  if (!text || text.length > NAME_MAX || /[\u0000-\u001F\u007F<>{}`$\\]/u.test(text)) return fallback;
  if (text !== own && SOURCE_TOKENS.some((token) => text.includes(token))) return fallback;
  return text;
}

export function parseReviewDomains(value, fallback = DEFAULT_REVIEW_DOMAINS) {
  if (value === undefined || value === null || String(value).trim() === "") return [...fallback];
  const out = [];
  for (const raw of String(value).split(",")) {
    const domain = raw.trim().toLowerCase().replace(/^www\./u, "");
    if (DOMAIN_RE.test(domain) && !out.includes(domain)) out.push(domain);
  }
  return out.length ? out : [...fallback];
}

/** ค่าผิด = ดังตอนบูต (เหมือน BRAIN_READ) — โปรไฟล์ที่พิมพ์ผิดแล้วเงียบ ๆ กลับเป็น course จะโชว์ของพี่ง้วงให้ร้านอื่น */
export function businessProfileMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "") return BUSINESS_PROFILE_COURSE;
  if (!BUSINESS_PROFILES.includes(mode)) {
    throw new Error(`BUSINESS_PROFILE ต้องเป็น ${BUSINESS_PROFILES.join(" หรือ ")} เท่านั้น (ได้ "${value}")`);
  }
  return mode;
}

/** สร้างแบรนด์จาก env object (ใช้ใน createConfig) — คืน object ที่แช่แข็งแล้ว */
export function brandFromEnv(source = {}) {
  const pick = (key) => {
    const v = source[key];
    return v === undefined || v === "" ? undefined : v;
  };
  const profile = businessProfileMode(pick("BUSINESS_PROFILE"));
  return makeBrand({
    agentName: pick("BRAND_AGENT_NAME"),
    ownerName: pick("BRAND_OWNER_NAME"),
    businessName: pick("BRAND_BUSINESS_NAME"),
    reviewDomains: pick("BRAND_REVIEW_DOMAINS"),
    businessId: pick("BUSINESS_ID"),
    profile,
  });
}

export function makeBrand({ agentName, ownerName, businessName, reviewDomains, businessId, profile } = {}) {
  const generic = profile === BUSINESS_PROFILE_GENERIC;
  const domainFallback = generic ? [] : DEFAULT_REVIEW_DOMAINS;
  const brand = {
    agentName: cleanName(agentName, generic ? GENERIC_AGENT_NAME : DEFAULT_AGENT_NAME, DEFAULT_AGENT_NAME),
    ownerName: cleanName(ownerName, generic ? GENERIC_OWNER_NAME : DEFAULT_OWNER_NAME, DEFAULT_OWNER_NAME),
    businessName: cleanName(businessName, generic ? GENERIC_BUSINESS_NAME : DEFAULT_BUSINESS_NAME, DEFAULT_BUSINESS_NAME),
    reviewDomains: Object.freeze(parseReviewDomains(Array.isArray(reviewDomains) ? reviewDomains.join(",") : reviewDomains, domainFallback)),
    businessId: String(businessId ?? "").trim(),
    profile: generic ? BUSINESS_PROFILE_GENERIC : BUSINESS_PROFILE_COURSE,
  };
  brand.isDefaultNames = brand.agentName === DEFAULT_AGENT_NAME
    && brand.ownerName === DEFAULT_OWNER_NAME
    && brand.businessName === DEFAULT_BUSINESS_NAME;
  // generic ต้องแทนชื่อทีมงานภายใน ("ชมพู่") ด้วยแม้ชื่อทั้งสามจะเหมือนค่าเริ่มต้น
  brand.rewrites = brand.isDefaultNames && brand.profile === BUSINESS_PROFILE_COURSE ? null : buildRewrites(brand);
  return Object.freeze(brand);
}

export const DEFAULT_BRAND = makeBrand();

function buildRewrites(brand) {
  // ลำดับสำคัญ: วลียาวก่อนคำสั้น (ชื่อธุรกิจมีคำว่า "พี่ง้วง" อยู่ข้างใน)
  const pairs = [
    [DEFAULT_BUSINESS_NAME, brand.businessName],
    [`ทีมงาน${DEFAULT_OWNER_NAME}`, `ทีมงาน${brand.businessName}`],
    ["ทีมงาน (คุณชมพู่)", "ทีมงาน"],
    ["คุณชมพู่", "ทีมงาน"],
    // "ชมพู่" เดี่ยว ๆ เป็นชื่อผลไม้ได้ — แทนเฉพาะวลีของข้อความระบบที่หมายถึงแอดมินคนจริงเท่านั้น
    ["ชมพู่ดูแลต่อ", "ทีมงานดูแลต่อ"],
    ["รบกวนชมพู่", "รบกวนทีมงาน"],
    ["รอชมพู่", "รอทีมงาน"],
    ["ส่งต่อชมพู่", "ส่งต่อทีมงาน"],
    ["น้องแพร", brand.agentName],
    [DEFAULT_AGENT_NAME, brand.agentName],
    [DEFAULT_OWNER_NAME, brand.ownerName],
    ["LuKprae", brand.agentName],
    ["Lukprae", brand.agentName],
  ];
  // โปรไฟล์ generic: คำของธุรกิจคอร์สในข้อความระบบที่ถึงมือลูกค้า ("ยืนยันที่นั่ง") เป็นคำกลางของร้านทั่วไป
  // คำศัพท์ของธุรกิจคอร์สในกติกาพรอมต์/แม่แบบ (โค้ดเขียนเอง) → คำกลางของร้านทั่วไป (วลียาวก่อน)
  if (brand.profile === BUSINESS_PROFILE_GENERIC) {
    pairs.push(
      ["ยืนยันที่นั่ง", "ยืนยันรายการ"],
      ["คอร์ส/ที่เรียนอื่น", "ร้านอื่น"],
      ["ข้อมูลคลาส", "ข้อมูลสินค้า"],
      ["ของคลาสที่คุยอยู่", "ของสินค้าที่คุยอยู่"],
      ["ของคลาสที่เกี่ยวข้อง", "ของสินค้าที่เกี่ยวข้อง"],
      ["'คลาสเดียว'", "'รายการเดียว'"],
      ["คลาสนี้", "สินค้านี้"],
      ["เสนอคลาส", "เสนอสินค้า"],
      ["ค่าเรียน", "ราคา"],
      ["สมัครเรียน", "สั่งซื้อ"],
      ["บาท/ท่าน", "บาท"],
      ["จองที่นั่ง", "สั่งจอง"],
      ["ล็อกที่นั่ง", "ล็อกสินค้า"],
      ["ที่นั่งยืนยันตามลำดับการชำระ", "รายการยืนยันตามลำดับการชำระ"],
      ["ผู้เรียน", "ลูกค้า"],
      ["รอบเรียน", "รอบ"],
      // ท้ายสุด: "คลาส" ที่เหลือในกติกา/แม่แบบ = สินค้า/บริการของร้าน (ไม่มีคำว่า "คลาสสิก" ในข้อความระบบ)
      ["คลาส", "สินค้า"],
    );
  }
  return pairs.filter(([from, to]) => from !== to);
}

let ACTIVE = DEFAULT_BRAND;

/** createApp ตั้งค่านี้ครั้งเดียวตอนประกอบแอป — โมดูลที่ไม่มี config ในมือใช้ค่านี้ */
export function setActiveBrand(brand) {
  ACTIVE = brand && typeof brand === "object" && typeof brand.agentName === "string" ? brand : DEFAULT_BRAND;
  return ACTIVE;
}

export function activeBrand() {
  return ACTIVE;
}

/** config.brand ถ้ามี ไม่งั้นแบรนด์ที่ active */
export function brandOf(config) {
  const b = config?.brand;
  return b && typeof b.agentName === "string" ? b : ACTIVE;
}

export function isGenericProfile(brandOrConfig) {
  const b = brandOrConfig?.agentName !== undefined ? brandOrConfig : brandOf(brandOrConfig);
  return b.profile === BUSINESS_PROFILE_GENERIC;
}

/**
 * แทนชื่อแบรนด์ในข้อความที่โค้ดเขียนเอง — แบรนด์เริ่มต้น = คืนค่าเดิมตัวเดิม
 * @param {string} text ข้อความ template/กติกาในโค้ด (ห้ามส่งข้อมูลลูกค้า/คลังความรู้มา)
 */
export function brandText(text, brand = ACTIVE) {
  const b = brand?.agentName !== undefined ? brand : brandOf(brand);
  if (!b.rewrites || typeof text !== "string" || !text) return text;
  let out = text;
  for (const [from, to] of b.rewrites) {
    if (out.includes(from)) out = out.split(from).join(to);
  }
  return out;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** รูปแบบ regex ของชื่อแอดมิน AI (ค่าเริ่มต้นตรงกับ "ลูกแพร" เดิม) */
export function agentNamePattern(brand = ACTIVE) {
  const b = brand?.agentName !== undefined ? brand : brandOf(brand);
  return escapeRegExp(b.agentName);
}

/** slug ปลอดภัยสำหรับชื่อไฟล์/คีย์ (ASCII) — ว่าง = fallback */
export function brandSlug(brand = ACTIVE, fallback = "shop") {
  const b = brand?.agentName !== undefined ? brand : brandOf(brand);
  const slug = String(b.businessId || "").toLowerCase().replace(/[^a-z0-9-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40);
  return slug || fallback;
}

/** รูปทรงที่ส่งให้คอนโซล (ไม่มีอะไรลับ) */
export function publicBrand(brand = ACTIVE) {
  const b = brand?.agentName !== undefined ? brand : brandOf(brand);
  return Object.freeze({
    agentName: b.agentName,
    ownerName: b.ownerName,
    businessName: b.businessName,
    profile: b.profile,
  });
}
