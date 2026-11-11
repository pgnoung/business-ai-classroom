// priceDirectives.mjs — ทะเบียน "ข้าง" ของทุกคำสั่งเรื่องราคาที่พรอมต์ปล่อยออกไป
//
// ทำไมต้องมีไฟล์นี้ (บทเรียนจากการตรวจปรปักษ์ 2026-09-04 รอบที่สาม):
// ด่านกันคำสั่งสวนกันรุ่นก่อนเทียบด้วย "รายการวลี marker ที่เขียนมือไว้" — คำสั่งเรื่องราคา
// ที่ถ้อยคำไม่อยู่ในรายการจึงล่องหนทั้งบรรทัด และรอบนี้มีสองบรรทัดที่หลุดด่านไปจริง:
//   1. เทิร์น quote_deferral_owed แบกทั้ง "ห้ามยื่นตัวเลขราคาให้เองโดยไม่ถูกถาม" (สาขา cold)
//      และ "คำตอบนี้ต้องมีราคาอยู่ด้วยเสมอ" (บล็อกติดค้างราคา) — ซึ่งเป็นฉากที่สถานะ owed
//      ถูกสร้างขึ้นมาเพื่อรองรับพอดี
//   2. pipeline สั่ง "ถ้าไม่มีข้อมูลให้บอกว่าขอเช็คกับทีมก่อน" ใต้หัวข้อ "กติกาที่ห้ามละเมิด
//      เด็ดขาด" ทุกเทิร์น ขณะที่เทิร์นคัดกรองแบนวลีนั้นด้วยชื่อ (ความล้มเหลว v1.4.39 ที่
//      บันทึกไว้ว่า "ขอลูกแพรเช็คตัวเลขกับทีมงานอีกครั้งนะคะ" คือผลผลิตของบรรทัดนี้)
//
// การไล่เติม marker ทีละวลีจึงไม่เคยปิดคลาสของบั๊กได้ — ปิดได้แค่ตัวอย่างที่เจอรอบนั้น
// ไฟล์นี้กลับด้าน: **คำสั่งเรื่องราคาต้องประกาศ "ข้าง" ของตัวเอง ณ จุดที่มันถูกเขียน**
// ผ่าน priceRule(side, text) แล้วเทสต์จะยืนยันว่าไม่มีบรรทัดไหนในพรอมต์ที่พูดถึงราคา/บาท/
// โปรฯ/ส่วนลด โดยไม่มีข้าง — คำสั่งใหม่ที่ไม่ประกาศข้างจะเห็นเทสต์แดงทันที ไม่ใช่หลุดเงียบ ๆ
//
// ต้นทุนในโปรดักชัน = ศูนย์: ถ้าไม่มีใครเปิด capture อยู่ priceRule คืนสตริงเดิมเฉย ๆ
// ไม่เก็บสถานะอะไรเลย (ทะเบียนที่โตตามจำนวนลูกค้าคือ memory leak — เคยพิจารณาแล้วตัดทิ้ง)

// สองแกนของคำตัดสิน + neutral
//
// เกณฑ์ตัดสินว่าบรรทัดหนึ่งอยู่ข้างไหน — ใช้คำถามเดียวนี้เสมอ:
// **"บรรทัดนี้สั่งเรื่องเทิร์นนี้แบบไม่มีเงื่อนไขหรือเปล่า"**
//   · สั่งไม่มีเงื่อนไขว่าต้องมีตัวเลขราคาในคำตอบนี้            -> quote
//   · สั่งไม่มีเงื่อนไขว่าห้ามมีตัวเลขราคาในคำตอบนี้           -> defer
//   · สั่งไม่มีเงื่อนไขว่ายกตารางโปรฯ/ส่วนลดในคำตอบนี้ได้       -> promo
//   · สั่งไม่มีเงื่อนไขว่าห้ามยกตารางโปรฯ/ส่วนลดในคำตอบนี้      -> no_promo
//   · พูดถึงเงินแต่มีเงื่อนไข ("ถ้าลูกค้าถามราคา…") หรือเป็นข้อห้ามที่จริงทุกเทิร์น
//     ("ห้ามแต่งตัวเลขเอง" / "ห้ามคำนวณส่วนต่างเอง")            -> neutral
//
// เกณฑ์นี้สำคัญกว่าที่เห็น: ถ้าเอากติกาแบบมีเงื่อนไขไปนับเป็นข้าง ด่านจะแดงในฉากที่ไม่มี
// อะไรผิดจริง แล้วคนถัดไปจะแก้ด้วยการอ่อนข้อให้ด่าน ซึ่งคือจุดจบของด่านทุกตัว
export const PRICE_DIRECTIVE_SIDES = Object.freeze(["quote", "defer", "promo", "no_promo", "neutral"]);
const SIDES = new Set(PRICE_DIRECTIVE_SIDES);

// สแต็ก ไม่ใช่ตัวแปรเดี่ยว — เผื่อ capture ซ้อน capture ในเทสต์
// ว่างเสมอในโปรดักชัน (ไม่มีผู้เรียก withPriceDirectiveCapture นอกชุดเทสต์)
const captures = [];

/**
 * ประกาศคำสั่งเรื่องราคาหนึ่งบรรทัดพร้อม "ข้าง" ของมัน แล้วคืนข้อความเดิมไปใช้ต่อ
 *
 * ใช้ครอบ **ทั้งบรรทัด** ไม่ใช่เฉพาะท่อนที่มีคำว่าราคา — ด่านตรวจความครบถ้วนเทียบราย
 * บรรทัดของพรอมต์ ถ้าครอบแค่บางท่อน บรรทัดนั้นจะยังนับว่า "ไม่มีข้าง"
 *
 * บรรทัดเดียวพูดได้สองแกนพร้อมกัน (เช่นแม่แบบแจ้งราคาที่มีท่อนโปรฯ อยู่ในตัว) จึงรับได้
 * ทั้งข้างเดี่ยวและอาร์เรย์ของข้าง
 *
 * @param {string|string[]} side
 * @param {string} text
 * @returns {string} ข้อความเดิม (identity)
 */
export function priceRule(side, text) {
  const sides = Array.isArray(side) ? side : [side];
  for (const item of sides) {
    if (!SIDES.has(item)) {
      throw new TypeError(`priceRule: ข้าง "${item}" ไม่มีอยู่จริง — ใช้ได้เฉพาะ ${PRICE_DIRECTIVE_SIDES.join("/")}`);
    }
  }
  // priceRule is an identity function. Its callers may include customer evidence
  // in a rule, so branding must happen only on static template fragments before
  // interpolation rather than here over arbitrary text.
  const value = String(text ?? "");
  const open = captures[captures.length - 1];
  if (open) for (const item of sides) open.push({ side: item, text: value });
  return value;
}

// Some prompt builders shield runtime literals while branding only their static
// templates. Keep an active test capture aligned with the final restored prompt
// so the directive audit continues to inspect the exact emitted line.
export function restoreCapturedPriceDirectiveLiterals(replacements = []) {
  for (const captured of captures) {
    for (const directive of captured) {
      for (const { literal, marker } of replacements) {
        directive.text = directive.text.split(marker).join(literal);
      }
    }
  }
}

/**
 * ประกอบพรอมต์หนึ่งก้อนพร้อมเก็บ "ข้าง" ของทุกคำสั่งเรื่องราคาที่ถูกปล่อยระหว่างทาง
 *
 * build ต้องเป็นฟังก์ชัน **synchronous** — ถ้าคืน promise มา สแต็กจะปิดก่อนกติกาถูกเขียน
 * แล้วผลที่ได้จะ "เขียวเพราะไม่เห็นอะไรเลย" ซึ่งอันตรายกว่าแดง จึงโยนทิ้งตรง ๆ
 *
 * @param {() => string} build
 * @returns {{text: string, directives: Array<{side: string, text: string}>}}
 */
export function withPriceDirectiveCapture(build) {
  const captured = [];
  captures.push(captured);
  try {
    const text = build();
    if (text && typeof text.then === "function") {
      throw new TypeError("withPriceDirectiveCapture: build ต้องเป็นฟังก์ชัน synchronous");
    }
    return { text: String(text ?? ""), directives: captured.slice() };
  } finally {
    captures.pop();
  }
}

// "บรรทัดนี้พูดเรื่องเงินหรือเปล่า" — เกณฑ์ของด่านตรวจความครบถ้วน
// ครอบตามที่พี่ง้วงระบุ: ราคา · จำนวนบาท · โปรโมชั่น · ส่วนลด · การบอก/ไม่บอกตัวเลข
//
// ภาษาไทยไม่มีช่องว่างระหว่างคำ การหาสตริงเปล่า ๆ จึงยิงเข้ากลางคำอื่นได้ —
// "บาท" อยู่ใน "บทบาท" พอดี (ตรวจปรปักษ์ 2026-09-04) แล้วสองบรรทัดเรื่อง "รีวิวนักเรียนจริง"
// ที่พูดว่า "ธุรกิจ/บทบาทใกล้เคียงลูกค้า" ก็ถูกด่านความครบถ้วนรายงานว่า "พูดเรื่องเงินแต่ไม่มีข้าง"
// ทั้งที่ไม่ได้พูดเรื่องเงินเลย — ด่านเขียวอยู่ได้เพราะไม่มีฉากไหนเดินเข้าสาขา warm/ลังเล
// แก้ที่ต้นเหตุด้วย lookbehind ของ "บท" ตัวเดียว: ยังจับ "500 บาท" · "กี่บาท" · "ห้าบาท"
// ได้ครบเหมือนเดิม (คำอื่นในรายการไม่มีกับดักทรงนี้ — ตรวจแล้วทีละตัว)
export const PRICE_MENTION = new RegExp(
  "(?:ราคา|(?<!บท)บาท|โปรโมชั่น|โปรโมชัน|โปรฯ|ส่วนลด|early\\s*bird" +
  "|ค่าเรียน|ค่าคอร์ส|ค่าอบรม|ค่าคลาส|ค่าใช้จ่าย|ค่าธรรมเนียม|มัดจำ|\\d[\\d,]*\\.-)",
  "iu",
);

// ถ้อยคำที่เทิร์นคัดกรองแบนด้วยชื่อ — พรอมต์ก้อนเดียวกันห้ามมีคำสั่งไหนไปสั่งให้พูด
// (ความล้มเหลว v1.4.39: "ขอลูกแพรเช็คตัวเลขกับทีมงานอีกครั้งนะคะ")
export const SCREENING_BANNED_PHRASES = Object.freeze([
  "ขอเช็กก่อน", "ขอเช็คกับทีม", "รอทีมงาน", "ยังบอกไม่ได้", "แจ้งราคาไม่ได้",
]);

// บรรทัดที่ *ประกาศ* รายการต้องห้าม ต้องเอ่ยวลีพวกนั้นโดยธรรมชาติ — ยกเว้นตัวเอง
// ด้วย marker ที่อยู่ในบรรทัดเดียวกัน ไม่ใช่ด้วยการเดาจากตำแหน่ง
export const SCREENING_BAN_DECLARATION = "ถ้อยคำต้องห้ามในเทิร์นนี้";

// "ห้ามบอกให้รอทีมงานยืนยัน" กับ "ให้บอกว่าขอเช็คกับทีมก่อน" มีวลีเดียวกันแต่คนละขั้ว —
// การหาสตริงเปล่า ๆ จับผิดฝั่งทันที (โหมดเทรนภายในมีทั้งสองประโยคที่เป็นข้อห้าม)
// จึงต้องมองย้อนกลับไปหาคำปฏิเสธที่อยู่ในอนุประโยคเดียวกัน
// ระวัง: "ไม่มี" ไม่ใช่คำปฏิเสธของคำสั่ง ("ถ้าไม่มีข้อมูลให้บอกว่าขอเช็คกับทีมก่อน"
// คือการ *สั่ง* ให้พูดวลีนั้น) รายการนี้จึงมีเฉพาะคำที่ปฏิเสธการกระทำจริง ๆ
const BAN_PREFIX = /(?:ห้าม|อย่า|ไม่ต้อง|เลิก)[^\n]{0,24}$/u;

/**
 * บรรทัดนี้ "สั่งให้พูด" วลีต้องห้ามหรือเปล่า (ต่างจาก "สั่งห้ามพูด")
 * @param {string} text
 * @returns {string[]} วลีต้องห้ามที่ถูกสั่งให้พูด
 */
export function ordersBannedPhrases(text) {
  const value = String(text ?? "");
  const found = [];
  for (const phrase of SCREENING_BANNED_PHRASES) {
    let from = 0;
    for (;;) {
      const at = value.indexOf(phrase, from);
      if (at < 0) break;
      if (!BAN_PREFIX.test(value.slice(0, at))) { found.push(phrase); break; }
      from = at + phrase.length;
    }
  }
  return found;
}

/**
 * แยกคำสั่งที่เก็บได้ตามข้าง แล้วบอกว่าบรรทัดไหนในพรอมต์ "พูดเรื่องเงินแต่ไม่มีข้าง"
 *
 * @param {{text: string, directives: Array<{side: string, text: string}>}} captured
 * @param {{ignore?: string[]}} options ข้อความอิสระที่คนเป็นคนเขียน (โน้ตทีมงาน กติกาสินค้า
 *   ที่นั่งคงเหลือ ฯลฯ) — เป็น "ข้อมูล" ไม่ใช่ "คำสั่งที่โค้ดปล่อย" จึงจัดข้างให้ไม่ได้
 */
export function classifyPriceDirectives({ text = "", directives = [] } = {}, { ignore = [] } = {}) {
  const bySide = { quote: [], defer: [], promo: [], no_promo: [], neutral: [] };
  for (const item of directives) {
    if (bySide[item.side]) bySide[item.side].push(item.text);
  }
  // บรรทัดของคำสั่งที่ประกาศข้างไว้แล้ว (คำสั่งหนึ่งอันอาจกินหลายบรรทัด เช่นแม่แบบแจ้งราคา)
  const covered = new Set();
  for (const item of directives) {
    for (const line of item.text.split("\n")) covered.add(line.trim());
  }
  for (const value of ignore) {
    for (const line of String(value ?? "").split("\n")) covered.add(line.trim());
  }
  const unclassified = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && PRICE_MENTION.test(line) && !covered.has(line));
  return { bySide, unclassified };
}
