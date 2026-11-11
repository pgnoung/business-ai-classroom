// showcaseCases.mjs — "ตัวอย่างระบบที่ทำด้วย AI Agent" (หน้า https://pngoungacademy.com/showcase/apps/<id>)
//
// 19 ต.ค. 2026: ลูกแพรส่งตัวอย่างระบบเป็นลิงก์หน้าเว็บได้แบบเดียวกับลิงก์รีวิวผู้เรียน เมื่อลูกค้าถามว่าเรียนแล้วทำอะไรได้บ้าง
// / ใช้ได้จริงไหม / เอาไปใช้กับธุรกิจได้ไหม — รายการอยู่ในคลัง "รีวิวนักเรียนจริง" กลุ่มที่ชื่อมีทั้ง "ตัวอย่าง" และ "ระบบ"
// (ไม่มีกลุ่มนี้ในคลัง = พฤติกรรมเดิมทุกอย่าง)
//
// กติกาถ้อยคำ (P-111/P-112 + กติกา human touch 12 ต.ค.): ตัวอย่างระบบเป็น "ตัวอย่าง" ไม่ใช่รีวิว ไม่ใช่ร้านหรือลูกค้าจริง
// ไม่อ้างยอดขาย/ผลลัพธ์ และไม่เติมคำว่าเดโม/ข้อมูลสมมติ/สร้างด้วย AI ในคำที่ลูกค้าเห็น
// ไฟล์นี้ไม่ import อะไร (reviewSelection / reviewJourney / socialProof ใช้ร่วมกันได้โดยไม่วนกัน)

/**
 * ประโยคเดียวที่อนุญาตให้บอกว่าระบบแบบนี้สร้างในคลาสไหน — ว่าง = ปิด (ไม่พูดเรื่องคลาสเลย)
 * 19 ต.ค. 2026 พี่ง้วงยืนยัน: ตัวอย่างระบบทุกเคสสร้างในคลาส Workflow ("1. Workflow") — แก้/ปิดได้ที่บรรทัดนี้ที่เดียว
 */
export const SHOWCASE_CLASS_CLAIM = "ระบบแนวนี้สร้างได้ในคลาส AI Agent Workflow Automation";

export const SYSTEM_SHOWCASE_LABEL = "ตัวอย่างระบบที่ทำด้วย AI Agent";

const SITE_KEY_PREFIX = "https://pngoungacademy.com/showcase/apps/";
/** path ของหน้าตัวอย่างระบบ — id ตัวเล็ก ตัวเลข ขีด 2–40 ตัว เท่านั้น */
export const SITE_SHOWCASE_PATH = /^\/showcase\/apps\/([a-z0-9-]{2,40})\/?$/u;
export const showcaseKeyFor = (id) => `${SITE_KEY_PREFIX}${id}`;
export const isShowcaseUrlKey = (key) => String(key || "").startsWith(SITE_KEY_PREFIX);

/** กลุ่มในคลังที่เป็นตัวอย่างระบบ ("ตัวอย่างระบบที่ทำด้วย AI Agent") — ไม่ใช่คลิปตัดต่อ/บรรยากาศ */
export const isSystemShowcaseSection = (section = "") => /ตัวอย่าง/u.test(section) && /ระบบ/u.test(section);
export const isSystemShowcase = (row) => Boolean(row) && row.kind === "showcase" && isSystemShowcaseSection(String(row.section || ""));

// ลูกค้าถามว่าเรียนแล้วสร้าง/ทำอะไรได้ หรือเอาไปใช้กับงานได้จริงไหม (ตัวนับมีเพดาน ปลอด ReDoS)
// "ช่วยได้จริงไหม" / "คุ้มไหม" / "กลัวว่าใช้ไม่ได้จริง" = สงสัยผลลัพธ์ → รีวิวผู้เรียนตามเดิม ไม่ใช่ตัวอย่างระบบ
export const CAPABILITY_ASK_RE = new RegExp([
  "(?:ทำ|สร้าง|ใช้ทำ|เอาไปทำ|เอาไปใช้ทำ|ประยุกต์|ประยุกต์ใช้)อะไรได้(?:บ้าง|มั่ง|มั้ง)",
  "สร้าง(?:ระบบ)?อะไรได้",
  "ทำระบบอะไร",
  "(?:ใช้|ทำ)(?:งาน)?ได้จริง(?:ไหม|มั้ย|มั๊ย|หรือเปล่า|รึเปล่า|เหรอ|หรอ|ป่าว)",
  "เอาไปใช้(?:กับ|ใน|ที่)?(?:ธุรกิจ|งาน|ร้าน|บริษัท|องค์กร)",
  "(?:ใช้|ปรับใช้|ประยุกต์ใช้)กับ(?:ธุรกิจ|ร้าน|บริษัท|งาน)[^\\n]{0,20}?(?:ได้(?:ไหม|มั้ย|ยังไง|อย่างไร|บ้าง)|ยังไง|อย่างไร)",
  "เป็นรูปธรรม(?:ไหม|มั้ย)",
].join("|"), "u");
// ถามผลของ "คนที่เรียนไปแล้ว" (มีคนเรียนแล้วใช้ได้จริงไหม) = อยากเห็นคนจริง → รีวิวผู้เรียน (พบในชุดสถานการณ์ eval 19 ต.ค.)
const RESULT_DOUBT_RE = /กลัว|กังวล|ลังเล|ไม่แน่ใจ|ไม่มั่นใจ|คุ้ม|เสียดาย|มีคน|คน(?:ที่)?เรียน(?:แล้ว|ไป|จบ)|ผู้เรียน|คนอื่น|ศิษย์|รุ่นก่อน|รุ่นที่แล้ว/u;
/** คำถามแบบ "ทำอะไรได้บ้าง / ใช้ได้จริงไหม" ที่ไม่ใช่ความกังวลเรื่องผลลัพธ์ */
export const capabilityAsk = (text = "") => CAPABILITY_ASK_RE.test(String(text)) && !RESULT_DOUBT_RE.test(String(text));

// ---- ถ้อยคำที่สั่งโมเดล (ส่วนต่อเทิร์น — มีเฉพาะเทิร์นที่เลือกตัวอย่างระบบ) ----
const CLASS_LINE = () => (SHOWCASE_CLASS_CLAIM
  ? ` เรื่องคลาสพูดได้ตามประโยคนี้เท่านั้น (ใช้แทนข้อห้ามเรื่องคลาสของตัวอย่างงานทั่วไป): "${SHOWCASE_CLASS_CLAIM}"`
  : " และไม่บอกว่าสอนทำระบบนี้ในคลาส");
/** ข้อห้ามถ้อยคำของตัวอย่างระบบ (ใช้ทั้งเครื่อง v3 และเครื่องเดิม) */
export const showcaseWordingRule = () => `เรียกว่า${SYSTEM_SHOWCASE_LABEL} ไม่เรียกว่ารีวิว ไม่บอกว่าเป็นร้าน บริษัท หรือลูกค้าจริง `
  + `ไม่แต่งยอดขายหรือผลลัพธ์ ไม่เติมคำว่าเดโม ข้อมูลสมมติ หรือสร้างด้วย AI${CLASS_LINE()}`;
/** บรรทัดนำของช่อง {{รีวิว}} เมื่อของที่เลือกเป็นตัวอย่างระบบ */
export const showcaseLeadLine = () => `แนะนำ${SYSTEM_SHOWCASE_LABEL}หนึ่งประโยคว่าระบบนี้ช่วยงานแบบไหนให้เห็นภาพ (${showcaseWordingRule()}) `
  + "แล้ววาง {{รีวิว}} ไว้บรรทัดของมันเอง";

// ---- รหัสในข้อความที่ปุ่ม "ทักไลน์" บนหน้าเว็บพิมพ์ไว้ให้ (19 ต.ค. 2026) ----
// ปุ่มบนหน้า /showcase/apps/<id> และ /reviews/<key> เปิด LINE พร้อมข้อความที่มีรหัส "เคส WF-<id>" / "รหัส RV-<key>"
// ข้อความต้องไม่ขึ้นต้นด้วย # (ลูกแพรเงียบกับ #hashtag ที่ไม่รู้จัก ให้ auto-response ของ OA ตอบ)
// ตัวจับยอมรับ: มี/ไม่มีคำว่า เคส/รหัส · ช่องว่างรอบขีด · ขีดแบบยาว · ตัวพิมพ์ใหญ่เล็กของ WF/RV และ id เคส
const CASE_CODE_RE = /(?<![A-Za-z0-9])[Ww][Ff]\s{0,2}[-\u2010-\u2014]\s{0,2}([A-Za-z0-9][A-Za-z0-9-]{1,39})(?![A-Za-z0-9])/gu;
const REVIEW_CODE_RE = /(?<![A-Za-z0-9])[Rr][Vv]\s{0,2}[-\u2010-\u2014]\s{0,2}([A-Za-z0-9_][A-Za-z0-9_-]{4,39})(?![A-Za-z0-9_])/gu;
const trimDash = (value) => String(value).replace(/-+$/u, "");

/** รหัสทั้งหมดในข้อความ ตามลำดับที่พบ — [{ kind: "case", id } | { kind: "review", key }] (id เคสเป็นตัวเล็กเสมอ) */
export function arrivalCodesIn(text = "") {
  const source = String(text || "").slice(0, 2000);
  const found = [];
  for (const m of source.matchAll(CASE_CODE_RE)) {
    const id = trimDash(m[1]).toLowerCase();
    if (/^[a-z0-9-]{2,40}$/u.test(id)) found.push({ at: m.index, kind: "case", id });
  }
  for (const m of source.matchAll(REVIEW_CODE_RE)) {
    const key = trimDash(m[1]);
    if (key.length >= 5) found.push({ at: m.index, kind: "review", key });
  }
  return found.sort((a, b) => a.at - b.at).map(({ at, ...code }) => code);
}
/** ลิงก์หน้าเว็บของรหัส (ผู้เรียกใช้ reviewUrlKey ทำเป็นคีย์กันส่งซ้ำ) */
export const arrivalUrlOf = (code) => (code?.kind === "case" ? showcaseKeyFor(code.id)
  : code?.kind === "review" ? `https://pngoungacademy.com/reviews/${code.key}` : "");
/** ลิงก์ของทุกรหัสในข้อความลูกค้า — ลูกค้ากดมาจากหน้าไหน = หน้านั้นถือว่าได้ไปแล้ว ไม่ส่งกลับ */
export const arrivalUrlsIn = (texts = []) => (Array.isArray(texts) ? texts : [texts])
  .flatMap((text) => arrivalCodesIn(text)).map(arrivalUrlOf).filter(Boolean);
