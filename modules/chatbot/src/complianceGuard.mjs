// complianceGuard.mjs — ด่านก่อน+หลัง model
//
// 1. banned words สบส. (โหลดจาก config/clinic-banned.json — superlative/การันตีผล)
// 2. no-diagnosis heuristic — บอทห้ามวินิจฉัยโรค
// 3. PRICE GUARD (SPEC ข้อ 6): ตัวเลขทุกตัวในบริบทราคา ต้องตรงกับ approved_prices
//    รวมเลขที่ model คำนวณใหม่ (ราคาเฉลี่ย/ส่วนลด) — ไม่ตรง = block + escalate
//    ตารางว่าง = block ทุกเลขราคา (fail-closed)
import { readFileSync } from "node:fs";

export function loadBannedWords(file, { logger = console } = {}) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((w) => typeof w === "string" && w.trim()).map((w) => w.trim());
  } catch (err) {
    logger.warn?.(`complianceGuard: อ่าน banned words ไม่ได้ (${err?.message || err}) — ใช้ลิสต์ว่าง`);
    return [];
  }
}

// heuristic วินิจฉัยโรค — conservative: ประโยคที่ฟันธงอาการ/โรคเท่านั้น
const DIAGNOSIS_PATTERNS = [
  /วินิจฉัย/u,
  /(?:น่าจะ|อาจจะ|คงจะ|คง)\s*เป็นโรค/u,
  /(?:คุณ|ลูกค้า)\s*เป็นโรค/u,
  /อาการ(?:แบบ)?นี้\s*(?:คือ|เป็น)โรค/u,
  /ยืนยันว่า(?:คุณ)?เป็น/u,
  /ฟันธงว่าเป็น/u,
];

/* ------------------------------- price guard ------------------------------ */

// v1.4.9 (เคสลูกค้า B 2026-08-17): comma ต้องเป็น "ตัวคั่นหลักพัน" เท่านั้น
// (ตามด้วยกลุ่มละ 3 หลักเป๊ะ) — ของเดิม /\d[\d,]*/ งาบ comma คั่นลิสต์ติดมาด้วย
// "ขึ้นต้น 06, 08" -> token "06," ซึ่ง inPriceContext บังคับเป็นราคาทันที + ปิด
// ข้อยกเว้นเบอร์/รหัสไปรษณีย์ที่ gate ด้วย !includes(",") -> false positive ทั้งตระกูล
const NUMBER_PATTERN = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/gu;

// v1.4.9: เลขที่ "ประกบชื่อเดือนไทยโดยตรง" = วันที่ ไม่ใช่ราคา ("22 ส.ค. 2026")
// ใช้ adjacency แคบ (เดือนต้องติดเลข) ไม่ใช่ ±window กัน "ราคา ส.ค. นี้ 77,000" หลุด
const THAI_MONTH_AFTER =
  /^\s*(?:ม\.?ค|ก\.?พ|มี\.?ค|เม\.?ย|พ\.?ค|มิ\.?ย|ก\.?ค|ส\.?ค|ก\.?ย|ต\.?ค|พ\.?ย|ธ\.?ค|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)/u;
const THAI_MONTH_BEFORE =
  /(?:ม\.?ค|ก\.?พ|มี\.?ค|เม\.?ย|พ\.?ค|มิ\.?ย|ก\.?ค|ส\.?ค|ก\.?ย|ต\.?ค|พ\.?ย|ธ\.?ค|มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม|พ\.?ศ|ค\.?ศ)\.?\s*$/u;

// คำที่บอกว่าเลขนี้อยู่ในบริบทราคา (มองหน้าต่างรอบตัวเลข)
const PRICE_CONTEXT =
  /(?:ราคา|บาท|฿|ค่า(?:บริการ|คอร์ส|รักษา|ใช้จ่าย|มัดจำ)|คอร์สละ|ครั้งละ|ต่อครั้ง|เริ่มต้น(?:ที่)?|โปรโมชั่น|โปรโมชัน|ส่วนลด|ลดเหลือ|เหลือเพียง|ลดพิเศษ|ชำระ|จ่าย|มัดจำ|ยอด|เฉลี่ย|สุทธิ|net)/iu;

// 2026-09-05 (ดราฟต์จริงในคิวรอคน 2026-09-04): สองในสามดราฟต์ที่ถูกบล็อกที่ "เลขลำดับ" ไม่ได้อยู่ในบริบทราคาเลย —
// คำบอกราคาซ่อนอยู่ในคำอื่น แล้วด่านมองไม่ออก:
//   · "โดยแบ่ง AI เป็นทีมตามบทบาท … 🔹 ตัวที่ 1" — "บาท" ที่จับได้คือครึ่งหลังของ "บทบาท" → (?<!บท)บาท
//   · "จึงต่อยอดจาก Stage 4 ได้ตรงกับงาน" — "ยอด" ที่จับได้คือครึ่งหลังของ "ต่อยอด" → (?<!ต่อ)ยอด
// แก้ที่ต้นเหตุตรงนี้ แทนการเปิดข้อยกเว้นเลขลำดับ (ตัวที่/Stage/คีย์แคป) ที่รีวิวปรปักษ์ 6 รอบหาทางอ้อมได้ทุกรอบ —
// ข้อยกเว้นที่ต้อง "อ่านคำรอบเลข" ว่าปลอดภัยไหม คือลิสต์ต้องห้ามที่ไม่มีวันครบ ส่วนสองบรรทัดนี้แค่ทำให้คำบอกราคา
// เป็นคำบอกราคาจริง ๆ · lookbehind ต้องเห็นตัวอักษรก่อนขอบหน้าต่างด้วย ดูวิธีค้นใน inPriceContext
// "บาท" / "บาทค่ะ" / "บาท/ท่าน" / "12,900บาท" และ "ยอด" / "ยอดรวม" / "ยอดชำระ" / "ยอดโอน" ยังเป็นบริบทราคาเหมือนเดิมทุกตัว
//
// ใช้กับ "จำนวนเต็ม 1–2 หลัก" เท่านั้น (รีวิวรอบ 9, 2026-09-05 — SMALL_ORDINAL_SHAPE ใน inPriceContext): หลักการคือ
// เลข 1–2 หลักไม่มีวันเป็นราคาคลาส แต่เลข 3 หลักขึ้นไปอาจใช่ — ดราฟต์จริงที่ถูกบล็อกผิดทุกตัวเป็นเลขลำดับ 1 หลัก
// (ตัวที่ 1 / Stage 3 / Stage 4) ส่วนช่องรั่วที่รีวิวเจอทุกช่องเป็นเลข 3 หลักขึ้นไป ("ต่อยอดโอน 5900" — ยอดโอนจริงที่ซ่อน
// หลัง "ต่อ" / "ราคา 12,900 บาท\n\n1️⃣ Early Bird 9900" — ราคาไม่มี comma ในลิสต์ใต้หัวข้อ) เลขพวกนั้นจึงยังเดิน
// PRICE_CONTEXT ตัวบน + หน้าต่างเดิมของ 0611997e ทุกตัวอักษร (inPriceContextOriginal) ไม่ผ่านตัวนี้เลย
const PRICE_CONTEXT_SMALL =
  /(?:ราคา|(?<!บท)บาท|฿|ค่า(?:บริการ|คอร์ส|รักษา|ใช้จ่าย|มัดจำ)|คอร์สละ|ครั้งละ|ต่อครั้ง|เริ่มต้น(?:ที่)?|โปรโมชั่น|โปรโมชัน|ส่วนลด|ลดเหลือ|เหลือเพียง|ลดพิเศษ|ชำระ|จ่าย|มัดจำ|(?<!ต่อ)ยอด|เฉลี่ย|สุทธิ|net)/iu;
// ตัวเดียวกันแบบ g สำหรับค้นตั้งแต่ตำแหน่งที่กำหนด (lastIndex) — ห้ามใช้ PRICE_CONTEXT_SMALL.test(slice) ตรง ๆ ดู inPriceContext
const PRICE_CONTEXT_SMALL_FROM = new RegExp(PRICE_CONTEXT_SMALL.source, "giu");

// หน่วยนับ/ระยะเวลา (ไม่ใช่สกุลเงิน) ตามหลังตัวเลข = จำนวน ไม่ใช่ราคา
// เช่น รับประกัน 3 ปี / ผ่อน 3 เดือน / ห้อง 30 ตร.ม. — "บาท" จงใจไม่อยู่ในลิสต์นี้
// หมายเหตุ: "เท่า" ต้องไม่กิน "เท่านั้น/เท่าไหร่/เท่าไร" (พิเศษ 12,900 เท่านั้น = ราคา)
// v1.4.6 (เคสจริง 2026-08-15 23:40): "ชำระได้ 2 ช่องทางค่ะ" — คำว่า "ชำระ" ในหน้าต่าง
// ดันเลข 2 เข้าบริบทราคา แต่ "ช่องทาง" ไม่อยู่ในลิสต์หน่วยนับ → guard บล็อกทั้งดราฟต์
// ทั้งที่ทุกตัวเลขเงินถูกหมด — เติมหน่วยนับเชิงตัวเลือก/โครงสร้างที่แชทขายใช้จริง
const QUANTITY_UNIT_AFTER =
  /^\s*(?:ปี|เดือน|วัน|ชั่วโมง|นาที|ครั้ง|รูป|ชิ้น|เครื่อง|รุ่น|ตัว|คน|ท่าน|ที่นั่ง|ขั้นตอน|ช่องทาง|แบบ|วิธี|ตัวเลือก|ข้อ|รอบ|คลาส|คอร์ส|หมวด|จุด|เรื่อง|ระดับ|ตร\.ม\.|ตารางเมตร|กิโล|กก\.|ลิตร|%|เปอร์เซ็นต์|เท่า(?!นั้น|ไหร่|ไร))/u;

// เลขที่เป็นส่วนของชื่อรุ่นสินค้า เช่น X1, X3, X5, X8, "X 3 Pro" — ตามด้วย Pro/Ultra
const MODEL_SUFFIX_AFTER = /^\s*(?:pro|ultra)\b/iu;

/* ---------- ข้อยกเว้นเดียวที่เพิ่มหลัง 0611997e: ราคาสกุลต่างประเทศ (ลิสต์อนุญาตตัวอักษรตรงตัว) ---------- */
// 2026-09-04 (คิวรอคน 6 ห้อง นานสุด 85 ชม.): "แนะนำ ChatGPT Plus ราคา US$20/เดือน ชำระกับ OpenAI โดยตรง" (2 ห้อง 4 ดราฟต์)
// ถูกบล็อกที่เลข 20 ทั้งที่เป็นราคาของ OpenAI ไม่ใช่เงินบาทของเรา — นี่คือดราฟต์จริงชุดเดียวที่ต้องการข้อยกเว้น
//
// บทเรียนจากรีวิวปรปักษ์ 6 รอบ (2026-09-04 → 05): ข้อยกเว้นที่ตัดสินว่า "เลขนี้ปลอดภัย" ด้วยการอ่านคำรอบเลข
// ถูกอ้อมได้ทุกรอบ — เเสน (เ+เ แทน แ) / 15'OOO / 16-K / thousands / ลบ. / พันธ์บาท / โค้ดพอยต์ไทยที่ยังไม่กำหนด /
// บั๊กปักหมุดท้ายคำที่ "เค" — ลิสต์คำข้างในไม่ว่าจะเรียกว่าอะไรก็คือลิสต์ต้องห้ามที่ไม่มีวันครบ
// จึงเหลือข้อยกเว้นเดียว เขียนเป็น "ตัวอักษรตรงตัว" ทั้งหน้าและหลังเลข: ไม่แยกคำ ไม่ normalize ไม่มี \s ไม่สนตัวพิมพ์
// อะไรที่ไม่ตรงกับลิสต์ข้างล่างเป๊ะ ๆ = ตรวจตามปกติ เท่ากับ 0611997e ทุกประการ — ลิสต์อนุญาตทั้งหมดอยู่ในบล็อกนี้ที่เดียว
//
// (1) ตัวเลข: จำนวนเต็ม ASCII 1–3 หลัก ไม่มี comma ไม่มีทศนิยม — ค่า SaaS ของร้านมีแค่หลักสิบถึงหลักร้อย ราคาคลาส 4 หลักขึ้นไป
const FOREIGN_AMOUNT_SHAPE = /^\d{1,3}$/u;
// (2) หน้าเลข: ข้อความก่อนเลขต้องลงท้ายด้วย US$ / USD / $ ตรงตัว คั่นได้แค่ช่องว่าง ASCII หนึ่งตัว (ไม่ใช่ \s — "US$\n20" ไม่ใช่)
//     USD ต้องไม่เป็นท้ายคำละติน · ไม่มี €/£/¥/SGD/ดอลลาร์/เหรียญ เพราะไม่เคยมีในดราฟต์จริงของร้าน — ถ้าวันหนึ่งมี
//     ค่อยเติมตัวอักษรตรงตัวลงบรรทัดนี้ (ไม่ใช่เติม "คำที่แปลว่าเงินต่างประเทศ")
const FOREIGN_MARK_BEFORE = /(?:US\$|(?<![A-Za-z])USD|\$) ?$/u;
// (3) หลังเลข: หนึ่งในรูปตรงตัวนี้ (รวมช่องว่างนำหน้าของ " ต่อเดือน") …
const FOREIGN_TAILS = Object.freeze([
  "/เดือน", "/ปี", "/month", "/mo", "/yr", "/year", "/user", "/seat",
  " ต่อเดือน", " ต่อปี", " per month", " per year", "/เดือน/ท่าน",
]);
//     … แล้วต้องจบด้วย จบสตริง / ช่องว่าง ASCII หนึ่งตัว / วรรคตอน . , ; : ! ? ) หนึ่งตัว / ขึ้นบรรทัด "\n" เท่านั้น
const FOREIGN_TAIL_END = /^(?:$|[ .,;:!?)]|\n)/u;
//     "ไม่มีท้าย" ไม่ใช่ข้อยกเว้น (รีวิวรอบ 9, 2026-09-05 — ถอด FOREIGN_BARE_END ที่รอบ 8 เปิดไว้): "ราคา 19,900 บาท (≈ US$590)" /
//     "US$590." คือโมเดลแปลงราคาบาทของเราเป็นดอลลาร์เอง — ถ้าแปลงผิด เลขเงินผิดถึงมือลูกค้าโดยไม่มีตารางไหนรับรอง
//     การแปลงสกุลไม่ใช่ฟีเจอร์ของร้าน ส่วนราคา SaaS จริงทุกดราฟต์เขียนพร้อมรอบบิล ("US$20/เดือน") จึงต้องมีท้ายจากลิสต์เสมอ
//     ("US$20/เดือน" / "$20 ต่อเดือน" / "US$20/mo, …" ผ่าน · "US$20" / "US$20." / "(US$590)" / "$999" ตรวจตามปกติ = เท่า 0611997e)
// ตัวอย่างที่ "ตรวจตามปกติ" โดยตั้งใจ (ทุกตัวเท่า 0611997e): US$20K · $20 เค · $20 หมื่น · US$15'OOO · "$20  x" (ช่องว่างสองตัว) ·
// "$20 anything" · US$20/เดือนละ · 20 USD/เดือน (สกุลอยู่หลังเลข) · US$1200 (4 หลัก) · US$1,200 (comma) · US$19.99 (ทศนิยม)

function isForeignCurrencyAmount(head, rawNum, tail) {
  if (!FOREIGN_AMOUNT_SHAPE.test(rawNum)) return false;
  if (!FOREIGN_MARK_BEFORE.test(head)) return false;
  return FOREIGN_TAILS.some((literal) => tail.startsWith(literal) && FOREIGN_TAIL_END.test(tail.slice(literal.length)));
}

function isExemptNumber(text, rawNum, index) {
  if (rawNum === "1669") return true; // เบอร์ฉุกเฉินการแพทย์ ต้องพูดได้เสมอ
  const before = text[index - 1] || "";
  const after = text[index + rawNum.length] || "";
  // เวลา เช่น 14:30 หรือ 14.30 น. — เลขสองฝั่งของ : /. ตามด้วย น.
  if (before === ":" || after === ":") return true;
  if (after === "." && /\s*น\./u.test(text.slice(index + rawNum.length))) return true;
  if (before === "." && /น\./u.test(text.slice(Math.max(0, index - 4), index + rawNum.length + 2))) return true;
  // เบอร์โทรไทย 0xxxxxxxxx
  if (/^0\d{8,9}$/.test(rawNum)) return true;
  const tail = text.slice(index + rawNum.length);
  // v1.4.9b (รีวิว 2026-08-17 — critical fail-open): ยกเว้นวันที่ไทยเฉพาะเลขที่ "มีรูปทรง
  // วันที่จริง" เท่านั้น — วัน 1-31 (1-2 หลัก) หรือปี 4 หลัก (19xx/20xx/25xx/26xx) และ
  // ต้องไม่มี comma (comma = หลักพัน = ราคาแน่นอน). เดิมยกเว้นเลขอะไรก็ได้ที่ติดชื่อเดือน
  // ทำให้ "ส.ค. 5,900 บาท" / "ส.ค. 5900" หลุด (ราคานอกตารางถึงมือลูกค้า)
  const dateShaped = !rawNum.includes(",")
    && ((/^\d{1,2}$/.test(rawNum) && Number(rawNum) >= 1 && Number(rawNum) <= 31)
      || /^(?:19|20|25|26)\d{2}$/.test(rawNum));
  if (dateShaped && THAI_MONTH_AFTER.test(tail)) return true;
  if (dateShaped && THAI_MONTH_BEFORE.test(text.slice(Math.max(0, index - 10), index))) return true;
  // จำนวน/ระยะเวลา/หน่วยวัด — เลขตามด้วยหน่วยนับที่ไม่ใช่เงิน (เลขตามด้วย "บาท" ยังโดนตรวจเต็ม)
  // ยกเว้นเลขรูปแบบ comma (4,990) = ราคาแน่นอน (สอดคล้อง inPriceContext:68) — หน่วยนับตามหลัง
  // ไม่ปลดล็อก กัน "ลดเหลือ 4,990 เครื่องสุดท้ายค่ะ" หลุดเป็นจำนวนทั้งที่เป็นราคา
  if (!rawNum.includes(",") && QUANTITY_UNIT_AFTER.test(tail)) return true;
  if (!rawNum.includes(",") && ORDINAL_UNIT_BEFORE.test(text.slice(Math.max(0, index - 12), index))) return true;
  // ชื่อรุ่นสินค้า: เลขติดตัวอักษรละตินไม่มีช่องว่าง (X3) หรือตามด้วย Pro/Ultra (X 3 Pro)
  if (/[a-z]/iu.test(before)) return true;
  if (MODEL_SUFFIX_AFTER.test(tail)) return true;
  // ข้อยกเว้นเดียวที่เพิ่มหลัง 0611997e — "US$20/เดือน" ของ OpenAI (ลิสต์อนุญาตตัวอักษรตรงตัว + ท้ายรอบบิลจากลิสต์เสมอ ดูบล็อกเหนือฟังก์ชันนี้)
  // ข้อความทั้งก้อนก่อนเลข ไม่ตัดที่ 12 ตัว: lookbehind (?<![A-Za-z]) ของ USD ต้องเห็นตัวอักษรก่อนรหัสสกุลเสมอ
  if (isForeignCurrencyAmount(text.slice(0, index), rawNum, tail)) return true;
  return false;
}

// หน่วยนับที่อยู่ "หน้า" ตัวเลข — "ท่านที่ 11" คือลำดับคน ไม่ใช่ราคา
// (ตัวกรองเดิมดูเฉพาะหน่วยที่ตามหลังเลข จึงมองข้ามรูปแบบนี้ทั้งหมด)
const ORDINAL_UNIT_BEFORE = /(?:ท่านที่|คนที่|ลำดับที่|ครั้งที่|รอบที่|เดือนที่|ปีที่|วันที่|ข้อที่|ระดับ)\s*$/u;

// ย่อหน้าใหม่ = ขอบที่หน้าต่างบริบทราคา "ของเลข 1–2 หลัก" ห้ามข้าม: บรรทัดว่างคั่น ("\n\n" รวมบรรทัดที่มีแต่ช่องว่าง) หรือขึ้นบรรทัดแล้ว
// ตามด้วยตัวนำรายการ (bullet · อีโมจิ/สัญลักษณ์ · เลขข้อ "1." "2)" · คีย์แคป 1️⃣) — ช่องว่างท้ายบรรทัดก่อนขึ้นบรรทัดไม่นับ
// 2026-09-05 (ดราฟต์จริง): "…ราคาเริ่มต้นโปรโมชั่น 79,000 บาท\n\nสำหรับ Stage 3 หากอยาก…" — "บาท" ท้ายย่อหน้าก่อนอยู่ในระยะ
// 20 ตัวอักษรของเลข 3 จึงถูกนับเป็นบริบทราคาของมัน ทั้งที่คนอ่านไม่มีวันอ่านข้ามย่อหน้าแบบนั้น (G4 ในสมองก็ต้องแบ่งการ์ด
// ด้วยเหตุผลเดียวกัน ดู brain/gate.mjs promptSegments) · CR เดี่ยว ๆ ไม่ใช่ขึ้นบรรทัด (สอดคล้องกับที่อื่นในไฟล์นี้)
// เลข 3 หลักขึ้นไปไม่ตัดขอบย่อหน้า (รีวิวรอบ 9): "ราคา 12,900 บาท\n\n1️⃣ Early Bird 9900\n2️⃣ ปกติ 12900" — ราคาไม่มี comma
// ในลิสต์ใต้หัวข้อ ถ้าตัดขอบ 9900 จะหลุดจากบริบทราคาแล้วถึงมือลูกค้าโดยไม่ผ่านตาราง
const PARAGRAPH_BREAK = /\r?\n(?:[ \t]*\r?\n)+|\r?\n(?=[ \t]*(?:[-•*·▪▫◦‣⁃]|[\p{Extended_Pictographic}\p{So}]|[\d๐-๙]{1,2}[.)]|\d\uFE0F?\u20E3))/gu;

// ขอบย่อหน้าที่ครอบโทเคน [tokenStart, tokenEnd): เริ่มหลังตัวแบ่งย่อหน้าตัวสุดท้ายก่อนโทเคน จบตรงตัวแบ่งตัวแรกหลังโทเคน
// (ตัวแบ่งไม่มีตัวเลขอยู่ข้างใน โทเคนจึงอยู่ก่อนหรือหลังตัวแบ่งเสมอ ไม่มีวันคร่อม)
function paragraphBounds(text, tokenStart, tokenEnd) {
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(PARAGRAPH_BREAK)) {
    const breakEnd = match.index + match[0].length;
    if (breakEnd <= tokenStart) { start = breakEnd; continue; }
    if (match.index >= tokenEnd) { end = match.index; break; }
  }
  return [start, end];
}

// เลขที่ได้ใช้บริบทแบบผ่อน (PRICE_CONTEXT_SMALL + หน้าต่างตัดขอบย่อหน้า): จำนวนเต็ม ASCII 1–2 หลักเท่านั้น ไม่มี comma ไม่มีทศนิยม
// รีวิวรอบ 9 (2026-09-05): เลข 1–2 หลักไม่มีวันเป็นราคาคลาส (ราคาต่ำสุดในตาราง 4 หลัก ส่วนลด/ค่าเสริม 4 หลัก) แต่เลข 3 หลักขึ้นไปอาจใช่ —
// ดราฟต์จริงที่ถูกบล็อกผิดทุกตัวเป็นเลขลำดับ 1 หลัก ส่วนช่องรั่วที่การผ่อนบริบทเปิดล้วนเป็นเลข 3 หลักขึ้นไป จึงผ่อนให้แค่เท่าที่ดราฟต์จริงต้องการ
// ห้ามขยายเป็น \d{1,3}: "ราคา $\n\n990" / "ค่าเรียน 990 บทบาท" จะหลุดจากบริบทราคาทันที (ทดสอบแบบกลายพันธุ์ไว้แล้ว)
const SMALL_ORDINAL_SHAPE = /^\d{1,2}$/u;

// ทางเดิมของ 0611997e ทุกตัวอักษร — เลข 3 หลักขึ้นไป / comma / ทศนิยม เดินทางนี้ (ห้ามแตะ: diff กับ 0611997e ต้องเห็นว่าไม่เปลี่ยน)
function inPriceContextOriginal(text, rawNum, index) {
  if (rawNum.includes(",")) return true; // 12,900 = รูปแบบราคาแน่นอน
  const windowStart = Math.max(0, index - 20);
  const window = text.slice(windowStart, index + rawNum.length + 12);
  return PRICE_CONTEXT.test(window);
}

export function inPriceContext(text, rawNum, index) {
  // fail-closed: ทุกอย่างที่ไม่ใช่จำนวนเต็ม 1–2 หลัก (รวมเลข comma ซึ่งเป็นราคาแน่นอน) = ทางเดิมของ 0611997e ไม่มีข้อยกเว้น
  if (!SMALL_ORDINAL_SHAPE.test(rawNum)) return inPriceContextOriginal(text, rawNum, index);
  // เลข 1–2 หลัก: หน้าต่าง ±20/+12 เท่าเดิม แต่ตัดที่ขอบย่อหน้าทั้งสองข้าง และคำบอกราคาต้องเป็นคำจริง (ไม่ใช่ครึ่งหลังของ บทบาท/ต่อยอด)
  // ผลที่ตั้งใจ: "ราคา\n\n99" (คำบอกราคาอยู่คนละย่อหน้ากับเลขลำดับ) ไม่ถูกนับเป็นบริบทราคาอีก — "ราคา\n\n9900" ยังถูกนับเหมือนเดิม
  const [paragraphStart, paragraphEnd] = paragraphBounds(text, index, index + rawNum.length);
  const windowStart = Math.max(paragraphStart, index - 20);
  const windowEnd = Math.min(paragraphEnd, index + rawNum.length + 12);
  // ค้นจาก windowStart บนข้อความที่ตัดขวาที่ windowEnd โดยไม่ slice ฝั่งซ้าย: lookbehind (?<!บท)/(?<!ต่อ) ใน PRICE_CONTEXT_SMALL
  // ต้องเห็นตัวอักษรก่อนขอบหน้าต่าง — ถ้า slice ทั้งสองข้าง "บทบาท" ที่ตกขอบซ้ายพอดีจะเหลือให้เห็นแค่ "บาท" แล้วจับผิดเหมือนเดิม
  // ขอบเขตการจับเท่าเดิมทุกตัวอักษร: เริ่มค้นได้ตั้งแต่ windowStart และคำที่จับต้องจบก่อน windowEnd
  PRICE_CONTEXT_SMALL_FROM.lastIndex = windowStart;
  return PRICE_CONTEXT_SMALL_FROM.test(text.slice(0, windowEnd));
}

// v1.3 (คู่มือแอดมินคนจริง 2026-08-13): คู่มือสั่งให้คำนวณยอดรวมให้ลูกค้าเห็นภาพ
// ("ท่านละ 11,900 บาท รวม 2 ท่านเป็น 23,800 บาท") ยอดรวมจึงเป็นเลขที่ถูกต้องเสมอ
// ถ้าเท่ากับราคาที่อนุมัติคูณจำนวนคนพอดี — ต่างจากราคาที่โมเดลแต่งขึ้นเอง
// เพดาน 30 คนคือขนาดคลาสสูงสุดที่ In-house รองรับ กันเลขมั่วที่บังเอิญหารลงตัว
const MAX_HEADCOUNT_MULTIPLE = 30;
// คูณได้เฉพาะ "ราคาต่อท่านจริง" — ตัวเลขหลักพันในตารางคือส่วนลดกับค่าบริการเสริม
// (1,000 / 3,000 / 5,000) ถ้าปล่อยให้คูณได้ เลขกลม ๆ แทบทุกตัวจะผ่านด่านไปหมด
const MIN_MULTIPLIABLE_UNIT = 4000;

// รายการที่เป็น "ส่วนลด" หรือ "ค่าบริการเสริม" ไม่ใช่ราคาต่อท่าน จึงคูณจำนวนคนไม่ได้
// (ปล่อยให้ 5,000 คูณได้ = เลขกลมอย่าง 10,000 หลุดด่านทันที)
const NON_UNIT_PRICE_LABEL = /(?:ส่วนลด|ค่าบริการท่านที่|ท่านที่ \d|นอกสถานที่|เพิ่มท่านละ|ราคารวมก่อนลด)/u;

export function multipliableAmounts(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  return new Set(list
    .filter((row) => !NON_UNIT_PRICE_LABEL.test(String(row?.label || "")))
    .map((row) => Number(row?.amount))
    .filter((amount) => Number.isFinite(amount) && amount >= MIN_MULTIPLIABLE_UNIT));
}

// v1.3.4 (เหตุจริง 2026-08-13): ลูกค้าถาม "หัก ณ ที่จ่ายไหม" ลูกแพรตอบถูกทุกตัวเลข
// ("ยอด 23,800 รวม VAT แล้ว หัก 3% จากยอดก่อน VAT = 667.29 ยอดโอนสุทธิ 23,132.71")
// แต่ guard บล็อกทั้งคำตอบเพราะรับได้แค่ "เลขในตาราง" กับ "เลขในตาราง × จำนวนเต็ม"
// ทดสอบครบทุกราคาที่อนุมัติ = โดนบล็อก 11/11 ซึ่งเป็นความล้มเหลวเชิงระบบ ไม่ใช่เคสเดียว
//
// เลขภาษีเป็นฟังก์ชันของยอดที่ผ่านด่านแล้ว ไม่ใช่ราคาที่โมเดลแต่งขึ้น จึงคำนวณตรวจได้
// จงใจไม่รับ "ส่วนต่าง/ยอดประหยัด" (a - b) เพราะนั่นคือการตลาดที่ต้องมาจากตารางเท่านั้น
// จงใจไม่รับ "ครึ่งหนึ่ง" (มัดจำ 50%) เพราะชนกับบทเรียนเดิมโดยตรง: โมเดลหารราคาเอง
// เป็น "เฉลี่ยครั้งละ ..." คือเคสที่ guard ต้องบล็อก ยอดมัดจำที่เป็นเงื่อนไขจริงของธุรกิจ
// ต้องอยู่ในตารางที่อนุมัติเอง (เช่น 6,450 = Re-learn 50%) ไม่ใช่ให้ guard เดาให้
const VAT_RATE = 0.07;
const WITHHOLDING_RATE = 0.03;

function derivedAmountsOf(base) {
  const preVat = base / (1 + VAT_RATE);
  const withholding = preVat * WITHHOLDING_RATE;
  // จงใจไม่มี base * VAT_RATE: ราคาในตารางรวม VAT แล้ว (คู่มือข้อ 5.8) VAT ของ 12,900
  // จึงเป็น 843.93 ไม่ใช่ 903 — สูตรนั้นผิดหลักบัญชี และวัดแล้วเป็นต้นเหตุของเลขที่หลุดด่าน
  // เพิ่มขึ้น 395 ตัว (100% ของช่องโหว่ที่เปิดใหม่) เช่น "In-house ลดพิเศษเหลือ 77,000 บาท"
  // ซึ่งเป็นคลาสความล้มเหลวที่ guard ตั้งขึ้นมากันโดยตรง
  return [
    preVat,                 // ยอดก่อน VAT
    preVat * VAT_RATE,      // VAT ที่คิดจากฐานก่อน VAT
    withholding,            // หัก ณ ที่จ่าย 3%
    base - withholding,     // ยอดโอนสุทธิหลังหัก
  ];
}

// ตัวเลขเงินที่ปัดสองตำแหน่งแล้วตรงกัน = ตัวเดียวกัน (23,132.71 กับ 23,132.7100001)
const sameMoney = (a, b) => Math.abs(a - b) < 0.005;

// v1.3.4: คู่มือสั่งให้บวก "ค่าบริการเสริม" เข้ากับราคาหลักอย่างชัดเจน
//   In-house 79,000 + ท่านที่ 11 อีก 1,000 = 80,000
//   Private 59,000 + ท่านที่ 5 อีก 5,000 = 64,000
//   In-house 79,000 + ค่าบริการนอกสถานที่ 5,000 = 84,000
// ยอดพวกนี้ถูกบล็อกทั้งหมดก่อนหน้านี้ ซึ่งเป็นความล้มเหลวคลาสเดียวกับบั๊กภาษี
// ตัวบวกต้องเป็นรายการที่ติดป้ายว่าเป็นส่วนเสริมจริงเท่านั้น (ไม่ใช่ราคาต่อท่าน)
const MAX_SURCHARGE_UNITS = 30;

export function surchargeAmounts(rows = []) {
  const list = Array.isArray(rows) ? rows : [];
  return new Set(list
    .filter((row) => NON_UNIT_PRICE_LABEL.test(String(row?.label || "")))
    .map((row) => Number(row?.amount))
    .filter((amount) => Number.isFinite(amount) && amount > 0));
}

// ค่าธรรมเนียมบัตรเครดิตกับยอดผ่อน — คู่มือระบุอัตราไว้ตรง ๆ แต่ต้องปลดล็อกตามบริบทเท่านั้น
// การหารราคาแบบไม่มีบริบทคือเคสที่ guard ต้องบล็อก ("เฉลี่ยครั้งละ ...") จึงต้องมีคำว่าผ่อน
const CARD_FEE_RATE = 0.025;
const INSTALLMENT_TERMS = Object.freeze([3, 4, 6, 10]);
const CARD_FEE_CONTEXT = /(?:บัตรเครดิต|ค่าธรรมเนียม(?:บัตร)?|รูดบัตร)/u;
const INSTALLMENT_CONTEXT = /ผ่อน[^\n]{0,20}(?:เดือน|งวด)|(?:เดือน|งวด)ละ/u;

function contextualAmountsOf(base, context) {
  const values = [];
  if (context.cardFee) values.push(base * CARD_FEE_RATE, base * (1 + CARD_FEE_RATE));
  if (context.installment) {
    for (const term of INSTALLMENT_TERMS) values.push(base / term);
  }
  return values;
}

function isApprovedTotal(amount, approved, multipliable = approved, surcharges = new Set(), context = {}) {
  if (approved.has(amount)) return true;
  const totals = [];
  for (const unit of multipliable) {
    if (unit < MIN_MULTIPLIABLE_UNIT) continue;
    const times = amount / unit;
    if (Number.isInteger(times) && times >= 2 && times <= MAX_HEADCOUNT_MULTIPLE) return true;
    for (let n = 2; n <= MAX_HEADCOUNT_MULTIPLE; n += 1) totals.push(unit * n);
  }
  // ยอดหลัก + ค่าบริการเสริมตามคู่มือ — "ตรงตัวเท่านั้น" ห้ามใช้เป็นฐานคำนวณต่อ
  // (บทเรียน: ทุกครั้งที่ขยายชุดตัวเลขที่ยอมรับ แล้วเอาไปคำนวณต่อ ช่องโหว่จะโตแบบทวีคูณ)
  //
  // และต้องมี "ทั้งฐานและตัวบวก" อยู่ในข้อความเดียวกัน ซึ่งเป็นวิธีที่คู่มือเขียนจริงเสมอ
  // ("In-house 79,000 บาท ท่านที่ 11 เพิ่ม 1,000 บาท รวม 80,000") — ถ้าไม่บังคับข้อนี้
  // 59,000 + 1,000×18 จะทำให้ "ลดพิเศษเหลือ 77,000" หลุดด่านไปด้วย
  for (const base of multipliable) {
    if (base < MIN_MULTIPLIABLE_UNIT || !context.present?.has(base)) continue;
    for (const extra of surcharges) {
      if (!context.present?.has(extra)) continue;
      for (let k = 1; k <= MAX_SURCHARGE_UNITS; k += 1) {
        const total = base + extra * k;
        if (total === amount) return true;
        if (total > amount) break; // เลยเป้าแล้ว ไม่ต้องไล่ต่อ
      }
    }
  }
  // ฐานที่ยอมให้คำนวณภาษี/ค่าธรรมเนียม/ยอดผ่อนต่อได้ = ราคาที่อนุมัติ กับยอดรวมจำนวนคนเท่านั้น
  for (const base of [...approved, ...totals]) {
    if (derivedAmountsOf(base).some((value) => sameMoney(value, amount))) return true;
    if (contextualAmountsOf(base, context).some((value) => sameMoney(value, amount))) return true;
  }
  return false;
}

// หาเลขราคาที่ "ไม่อยู่ในตาราง approve" — คืนรายการ violation
export function findPriceViolations(text, approvedAmounts, multipliable = null, surcharges = null) {
  const value = String(text || "");
  const approved = approvedAmounts instanceof Set ? approvedAmounts : new Set(approvedAmounts || []);
  const extras = surcharges instanceof Set ? surcharges : new Set();
  // บริบทอ่านจากข้อความทั้งก้อนครั้งเดียว — ปลดล็อกสูตรเฉพาะเมื่อกำลังพูดเรื่องนั้นจริง
  const present = new Set();
  for (const match of value.matchAll(NUMBER_PATTERN)) {
    const parsed = Number(match[0].replaceAll(",", ""));
    if (Number.isFinite(parsed)) present.add(parsed);
  }
  const context = {
    cardFee: CARD_FEE_CONTEXT.test(value),
    installment: INSTALLMENT_CONTEXT.test(value),
    present,
  };
  const violations = [];
  for (const match of value.matchAll(NUMBER_PATTERN)) {
    const rawNum = match[0];
    const index = match.index ?? 0;
    if (isExemptNumber(value, rawNum, index)) continue;
    if (!inPriceContext(value, rawNum, index)) continue;
    const amount = Number(rawNum.replaceAll(",", ""));
    if (!isApprovedTotal(amount, approved, multipliable instanceof Set ? multipliable : approved, extras, context)) {
      violations.push({ type: "price", detail: rawNum });
    }
  }
  return violations;
}

/* --------------------------------- guard ---------------------------------- */

// v1.2.3: ป้ายกำกับข้อมูลตัวอย่างในโหมดเทรน — ตัวเลขที่อยู่ในข้อความที่ติดป้ายนี้
// ไม่ถูกนับเป็นการอ้างราคาจริง (ลูกค้าอ่านเห็นเองว่าเป็นตัวอย่างที่รอทีมงานยืนยัน)
export const TRAINING_MOCK_MARK = /ข้อมูลตัวอย่าง/u;

// ช่วงข้อความที่เป็น "ชื่อนิติบุคคล" — บริษัท/บจก./หจก. ... จำกัด (กัน "จำกัดความ"
// ด้วย lookahead) — ใช้ยกเว้นคำแบนที่บังเอิญเป็นส่วนของชื่อ เช่น บริษัท ดีที่สุดฯ จำกัด
const COMPANY_NAME_SPAN = /(?:บริษัท|บจก\.?|หจก\.?)\s*[^\n]{0,60}?(?:จำกัด(?!ความ)(?:\s*\(มหาชน\))?|corporation|co\.,?\s*ltd\.?)/giu;

// v1.4.6b: ข้อความที่ "ยกมาเป๊ะ ๆ" จากคลังความรู้ที่เจ้าของอนุมัติ (เช่น บรรทัดชื่อ-ตำแหน่ง
// ของผู้รีวิว "โรงพิมพ์...อันดับ 1 ของประเทศไทย") ไม่ใช่คำเคลมของโมเดล — คำแบนที่อยู่ใน
// ช่วง quote พวกนี้ต้องไม่บล็อก ไม่งั้นรีวิวรายนั้นส่งไม่สำเร็จตลอดกาล (deadlock ซ้ำรอย
// เคส "ดีที่สุด" 2026-08-15 และเคส "อันดับ 1" 2026-08-16); การันตีความปลอดภัย: ยกเว้น
// เฉพาะสตริงยาว ≥ 12 ตัวอักษรที่ตรงกับของอนุมัติแบบตัวต่อตัวเท่านั้น — โมเดลแต่งเองไม่ตรง = โดนตามเดิม
const MIN_APPROVED_QUOTE_LENGTH = 12;

export function createComplianceGuard({ bannedWords = [], getApprovedPrices = () => [], getApprovedQuotes = () => [], getRoomPrices = null, trainingMockMode = false, logger = console }) {
  // ก่อน model: ธงบริบทเสี่ยงจากฝั่งลูกค้า เพื่อเติมกติกาเข้า system prompt
  function checkInbound(text) {
    const value = String(text || "");
    const flags = [];
    if (/(?:เป็นโรคอะไร|โรคอะไร|วินิจฉัย|ใช่โรค)/u.test(value)) flags.push("asks_diagnosis");
    if (/(?:ขอส่วนลด|ลดได้ไหม|ลดได้มั้ย|ลดหน่อย|ต่อราคา)/u.test(value)) flags.push("asks_discount");
    return { flags };
  }

  // หลัง model (และหลัง template): ด่านสุดท้ายก่อนถึงมือลูกค้า
  //
  // approvedPrices (P2): ชุดตัวเลขของ "เทิร์นนี้" — มาจาก bundle ของสมองรุ่นที่ประกอบ
  // prompt เทิร์นเดียวกัน ไม่ใช่ตารางกลาง (แบบแปลน §7: ลูกค้าฝั่ง canary พูดราคาที่มี
  // เฉพาะในรุ่น canary ต้องไม่ถูกตัด ส่วนลูกค้าฝั่ง live พูดเลขเดียวกันต้องถูกตัด)
  // ไม่ส่งมา = อ่านตารางกลางเหมือนเดิมทุกไบต์ · ส่งอาร์เรย์ว่าง = fail-closed เหมือนเดิม
  function checkOutbound(text, { approvedPrices = null, customerId = "", channelId = "" } = {}) {
    const value = String(text || "");
    const violations = [];
    // ลำดับแหล่งของ "ตัวเลขที่อนุมัติแล้ว" สำหรับข้อความก้อนนี้:
    //   1. ที่ผู้เรียกส่งมาเอง (เส้นตอบลูกค้า resolve สมองไปแล้ว ไม่ต้อง resolve ซ้ำ)
    //   2. สมองของห้องนี้ (ผู้ส่งอื่นแค่บอก customerId ก็ได้ตารางของห้องนั้น)
    //   3. ตารางกลาง = projection ของรุ่น live (ถูกต้องสำหรับข้อความถึงทุกคน เช่นบรอดแคสต์)
    // อ่านสมองไม่ได้ต้องตกมาข้อ 3 ไม่ใช่กลายเป็นชุดว่าง — ชุดว่างแปลว่า "ห้ามทุกตัวเลข"
    // ซึ่งจะเปลี่ยน follow-up ที่เคยส่งได้ให้กลายเป็นบล็อกยกชุดเพราะสมองสะดุดครั้งเดียว
    const priceRows = () => {
      if (approvedPrices !== null) return approvedPrices;
      if (getRoomPrices && customerId) {
        try {
          const rows = getRoomPrices(String(customerId), String(channelId || ""));
          if (Array.isArray(rows)) return rows;
        } catch (err) {
          logger.debug?.(`complianceGuard: อ่านตารางราคาของห้องไม่สำเร็จ (${err?.message || err}) — ใช้ตารางกลาง`);
        }
      }
      return getApprovedPrices();
    };

    // v1.4.6 (เคสจริง 2026-08-15 deadlock รีวิว): "บริษัท ดีที่สุด ทดสอบ จำกัด"
    // คือชื่อนิติบุคคลของผู้รีวิวในคลังความรู้ — คำแบนที่เป็นส่วนของวิสามานยนาม
    // (อยู่ในช่วงชื่อบริษัท) ไม่ใช่คำโฆษณาเกินจริง; ถ้าบล็อก รีวิวรายนั้นจะส่งไม่สำเร็จ
    // ตลอดกาล (redraft ก็ต้องพิมพ์ชื่อบริษัทเดิมซ้ำ → โดนบล็อกวน ลูกค้าทวงกี่รอบก็เจอ fallback)
    const exemptSpans = [...value.matchAll(COMPANY_NAME_SPAN)].map((m) => [m.index, m.index + m[0].length]);
    try {
      for (const quote of getApprovedQuotes() ?? []) {
        const phrase = String(quote || "");
        if (phrase.length < MIN_APPROVED_QUOTE_LENGTH) continue;
        let at = value.indexOf(phrase);
        while (at !== -1) {
          exemptSpans.push([at, at + phrase.length]);
          at = value.indexOf(phrase, at + 1);
        }
      }
    } catch { /* อ่าน quote ไม่ได้ = ไม่มีข้อยกเว้นเพิ่ม (fail-closed ไปทางเข้ม) */ }
    const insideExemptSpan = (start, length) =>
      exemptSpans.some(([s, e]) => start >= s && start + length <= e);
    for (const word of bannedWords) {
      let index = value.indexOf(word);
      while (index !== -1 && insideExemptSpan(index, word.length)) index = value.indexOf(word, index + 1);
      if (index !== -1) violations.push({ type: "banned_word", detail: word });
    }

    for (const pattern of DIAGNOSIS_PATTERNS) {
      if (pattern.test(value)) {
        violations.push({ type: "diagnosis", detail: pattern.source });
        break;
      }
    }

    let approvedAmounts;
    let unitPrices;
    let extraFees;
    try {
      const rows = priceRows();
      approvedAmounts = new Set(rows.map((row) => Number(row.amount)));
      unitPrices = multipliableAmounts(rows);
      extraFees = surchargeAmounts(rows);
    } catch {
      approvedAmounts = new Set(); // อ่านตารางไม่ได้ = fail-closed บล็อกเลขราคาทุกตัว
      unitPrices = new Set();
      extraFees = new Set();
    }
    const priceViolations = findPriceViolations(value, approvedAmounts, unitPrices, extraFees);
    if (trainingMockMode && priceViolations.length && TRAINING_MOCK_MARK.test(value)) {
      // โหมดเทรนเท่านั้น: ปล่อยผ่านแต่ต้องเห็นในล็อกทุกครั้ง ว่าตัวเลขไหนเป็นของสมมติ
      logger.warn?.(`complianceGuard: training mock ปล่อยตัวเลขที่ยังไม่อนุมัติ (${priceViolations.map((v) => v.detail).join(", ")})`);
    } else {
      violations.push(...priceViolations);
    }

    // v1.3.5: การจับคู่ "ราคาปกติ" กับเลขที่เป็นราคาโปรคือราคาผิดสินค้า — บล็อกแม้เลขจะ
    // อยู่ในตารางก็ตาม และไม่ยกเว้นในโหมดเทรน (ป้าย mock ไม่ทำให้การจับคู่ผิดกลายเป็นถูก)
    try {
      violations.push(...findPriceBindingViolations(value, priceRows()));
    } catch {
      // อ่านตารางไม่ได้ — ด่านราคาหลักด้านบน fail-closed อยู่แล้ว ไม่ต้องซ้ำ
    }

    return { ok: violations.length === 0, violations };
  }

  return { checkInbound, checkOutbound };
}


/* -------- v1.3.4: ตัดเฉพาะประโยคที่ผิด แทนการทิ้งคำตอบทั้งก้อน -------- */
// เหตุจริง 2026-08-13: ดราฟต์ที่ถูกบล็อกมีประโยคปิดการขายที่ถูกต้องอยู่ด้วย
//   "...หัก 3% จะหัก 667.29 บาท ยอดโอนสุทธิ 23,132.71 บาทค่ะ
//    รอบที่เปิดรับคือวันเสาร์ที่ 15 หรือ 22 สิงหาคม เวลา 10:00-17:00 น. สะดวกรอบไหนคะ?"
// guard ทิ้งทั้งข้อความเพราะเลขภาษีสองตัว ประโยคปิดการขายจึงหายไปด้วย และไม่เคยถูกลองใหม่อีกเลย
//
// กติกา: ตัดเฉพาะประโยคที่มีตัวเลขต้องห้าม ประโยคที่เหลือปลอดภัยอยู่แล้วเพราะผ่าน guard
// ถ้าไม่เหลืออะไรที่มีเนื้อหา = คืน null ให้ caller ใช้ fallback เดิม (ห้ามส่งข้อความว่าง)
const SENTENCE_SPLIT = /(?<=[.!?？\n])\s+|(?<=(?:ค่ะ|คะ|ครับ|นะคะ|นะครับ))\s+/u;
const MIN_KEPT_SENTENCE_CHARS = 12;

// ดราฟต์ที่ถูกบล็อกห้ามพารูปติดไปด้วย แม้ประโยคที่กู้มาจะปลอดภัยแล้วก็ตาม —
// รูปถูกเลือกมาให้เข้ากับข้อความเต็ม ไม่ใช่ข้อความที่เหลือหลังตัด
const IMAGE_MARKER = /\[\s*image\s*:[^\]]*\]/giu;

// D (รีวิวปรปักษ์รอบ 3, 2026-09-05): การยุบช่องว่างทุกช่วงเป็น " " เคยลากเครื่องหมายสกุลจากบรรทัดก่อนมาชิดเลขบรรทัดถัดไป
// ("ราคาปกติ US$\n\n15,900" → "US$ 15,900") ประโยคที่ด่านเพิ่งบล็อกจึงกลับผ่านตอนกู้ — ช่วงช่องว่างที่มีอะไรนอกจาก
// space/tab (ตัวขึ้นบรรทัด และช่องว่างทุกชนิดที่ฝั่งเปิดข้อยกเว้นไม่ยอมรับว่าเป็นบรรทัดเดียวกัน) ยุบเป็น "\n" เดียว
// ช่วงที่มีแต่ space/tab ยุบเป็น " " เหมือนเดิม การแบ่งประโยคและกติกาที่เหลือของฟังก์ชันนี้ไม่เปลี่ยน
export function stripViolatingSentences(text, checkFn) {
  const value = String(text || "").replace(IMAGE_MARKER, " ")
    .replace(/\s{2,}/gu, (run) => (/[^ \t]/u.test(run) ? "\n" : " "));
  if (!value.trim()) return null;
  const sentences = value.split(SENTENCE_SPLIT).map((part) => part.trim()).filter(Boolean);
  if (sentences.length <= 1) return null; // ประโยคเดียว = ตัดแล้วไม่เหลืออะไร
  const kept = sentences.filter((sentence) => checkFn(sentence).ok);
  if (!kept.length) return null;
  const rebuilt = kept.join(" ").trim();
  // เหลือแค่เศษสั้น ๆ ไม่นับว่าเป็นคำตอบ — ปล่อยให้ fallback ทำงานแทนดีกว่าส่งของกำกวม
  if ([...rebuilt].length < MIN_KEPT_SENTENCE_CHARS) return null;
  if (!checkFn(rebuilt).ok) return null; // กันเคสที่ประกอบใหม่แล้วผิดอีก
  return { text: rebuilt, droppedCount: sentences.length - kept.length };
}


/* -------- v1.3.5: ด่านผูกราคา — "ราคาปกติ" ต้องไม่ใช่เลขที่เป็นราคาโปรเท่านั้น -------- */
// เหตุจริง: โมเดลตอบ "ราคาปกติ 15,900 / โปร 12,900" — เลขทั้งคู่อยู่ในตารางอนุมัติ
// (15,900 = Early Bird ของ Workflow, 12,900 = Early Bird ของ Business) guard เดิมตรวจแค่
// "เลขอยู่ในตารางไหม" จึงมองไม่เห็นการจับคู่ผิด ทั้งที่ลูกค้าได้ราคาผิดสินค้าไปเต็ม ๆ
const NORMAL_PRICE_PHRASE = /(?:ราคาปกติ|ราคาเต็ม|ราคาจริง)[^\n0-9]{0,25}(\d{1,3}(?:,\d{3})+)/gu;
const PROMO_LABEL = /(?:early\s*bird|โปรโมชั่น|โปรโมชัน|ส่วนลด|ลดเพิ่ม|ลดเหลือ)/iu;
const NORMAL_LABEL = /(?:ราคาปกติ|ราคาเต็ม)/u;

// เลขที่ "เป็นราคาโปรอย่างเดียว" = มีป้ายโปรและไม่มีป้ายราคาปกติในทุกแถวที่มันปรากฏ
export function promoOnlyAmounts(rows = []) {
  const promo = new Set();
  const normal = new Set();
  for (const row of Array.isArray(rows) ? rows : []) {
    const amount = Number(row?.amount);
    if (!Number.isFinite(amount)) continue;
    const label = String(row?.label || "");
    if (PROMO_LABEL.test(label)) promo.add(amount);
    if (NORMAL_LABEL.test(label)) normal.add(amount);
  }
  return new Set([...promo].filter((amount) => !normal.has(amount)));
}

export function findPriceBindingViolations(text, rows = []) {
  const promoOnly = promoOnlyAmounts(rows);
  if (!promoOnly.size) return [];
  const violations = [];
  for (const match of String(text || "").matchAll(NORMAL_PRICE_PHRASE)) {
    const amount = Number(match[1].replaceAll(",", ""));
    if (promoOnly.has(amount)) {
      violations.push({ type: "price_binding", detail: `ราคาปกติ ${match[1]} (เลขนี้เป็นราคาโปรเท่านั้น)` });
    }
  }
  return violations;
}
