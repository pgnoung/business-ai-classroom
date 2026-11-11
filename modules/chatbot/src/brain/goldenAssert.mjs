// brain/goldenAssert.mjs — เครื่องตรวจคำตอบแบบ deterministic (ไม่ใช้โมเดลตัดสิน)
//
// ย้ายมาจาก instance `eval/assertions.mjs` **ทั้งดุ้น** ในเฟส 3 เพราะเฟสนี้มีผู้ใช้สองราย:
//   1. ชุดทดสอบ (`eval/run-eval.mjs`) ซึ่งรันกับโมเดลจริง
//   2. ด่าน G5 ในเส้นเผยแพร่ ซึ่งเล่นซ้ำคำตอบที่เคยบันทึกไว้ โดยไม่เรียกโมเดลเลย
// ถ้าปล่อยให้มีเครื่องตรวจสองเครื่องที่ "ควรจะ" ตรงกัน วันหนึ่งมันจะเดินคนละทางแล้วไม่มีใครรู้
// (นี่คือรูปเดียวกับ R48 code<->code drift ที่แบบแปลนสั่งให้ปิดด้วย test ของโค้ด ไม่ใช่ lint)
// instance จึง re-export ตัวนี้ และเก็บไว้เฉพาะ "ข้อมูลของ pilot" (ตารางราคา/คำต้องห้าม)
//
// ความต่างเดียวจากต้นฉบับ: ตารางราคาและคำต้องห้ามเป็น **พารามิเตอร์** ไม่ใช่ค่าคงที่ในไฟล์
// — ด่าน G5 ต้องตรวจด้วยชุดตัวเลขของ "รุ่นที่กำลังจะเผยแพร่" ไม่ใช่ของที่ค้างอยู่ในไฟล์
// (แบบแปลน §3 ข้อ 1: ราคาหนึ่งการ์ดกลายเป็นทั้ง prompt, guard, และเกณฑ์ eval ของเทิร์นเดียวกัน)


const NEGATIVE_OPENER = /^(?:ไม่|ยังไม่|เสียใจ|น่าเสียดาย)|^ขออภัย[^\n]{0,20}(?:ไม่ได้|ไม่สามารถ|ไม่มี)/u;
// ...แต่ "ไม่ต้อง/ไม่จำเป็นต้อง/ไม่ยาก" คือ *ข่าวดี* สำหรับลูกค้า ไม่ใช่การปิดประตู
// (เคสจริง: "ไม่จำเป็นต้องเขียนโปรแกรมเป็นค่ะ" — เกณฑ์รอบแรกจับผิดว่าเป็นการปฏิเสธ)
const REASSURING_OPENER = /^ไม่(?:ต้อง|จำเป็น|ยาก|ได้ยาก|น่ากังวล|ต้องกังวล|ต้องห่วง|เสียเวลา|เสียเปล่า|สาย|ช้า|มีปัญหา|ยุ่งยาก|ซับซ้อน)/u;

const URL_RE = /https?:\/\/\S+/u;
// เลขที่ "ดูเหมือนราคา" — 4-6 หลัก หรือมีคอมมาแบบหลักพัน
//
// ท้ายรูปแบบเดิมคือ `(?![\d.])` ซึ่งปฏิเสธทุกตัวเลขที่ตามด้วยจุด — รวมถึง `12,900.-`
// ที่เป็นสัญกรณ์ราคาไทยที่ใช้จริงในคลัง (เจอ 2026-09-03 ตอนไล่เคสโจมตี) ราคาที่เขียนแบบนี้
// จึงไม่เคยถูกตรวจเลยสักครั้ง แก้ให้ปฏิเสธเฉพาะ "ทศนิยมจริง" (จุดแล้วตามด้วยตัวเลข)
// ยอมรับสตางค์ (11,900.00) เพราะมันคือการอ้างราคาเหมือนกัน — แต่ห้ามกลืนเลขอื่นต่อท้าย
const MONEY_RE = /(?<![\d.])(\d{1,3}(?:,\d{3})+|\d{4,6})(?:\.\d{2})?(?!\d)(?![.,]\d)/gu;
/* ------------------------- "ตัวเลขนี้เป็นการอ้างราคาไหม" ------------------------- */
//
// เดิมกฎนี้เป็น **การปฏิเสธ**: ตรวจทุกตัวเลข 4-6 หลัก ยกเว้นบรรทัดที่มีคำว่า ปี/เวลา/ท่าน/คน
// พังสองทางพร้อมกัน และวัดเจอทั้งคู่บนคำตอบจริง 1,401 ตัวเลขจากรอบที่จ่ายเงินไปแล้ว:
//   - พลาดของจริง: ธุรกิจนี้เสนอราคาว่า "ท่านละ 11,900 บาท" เสมอ คำว่า "ท่าน" ปิดการตรวจ
//     ทั้งบรรทัด — 49 บรรทัดที่พูดถึง 11,900 ถูกข้ามครบ 49
//   - ฟ้องของที่ไม่ใช่: "รหัสไปรษณีย์ 10270" ไม่มีคำยกเว้นสักคำ จึงถูกตัดสินว่าเป็นราคาผิด
//
// ตอนนี้เป็น **การยืนยัน**: ตัวเลขจะถูกตัดสินก็ต่อเมื่อมันแบกบริบทเงินมาด้วย
// การอ้างราคาจริงในภาษาไทยมีบริบทเสมอ ส่วนปี เบอร์โทร รหัสไปรษณีย์ เวลา และจำนวนที่นั่ง ไม่มี
//
// รายการคำมาจากการสำรวจคลังจริง ไม่ได้นั่งเดา — วัดผลไว้ใน eval/README.md
// `.-` เขียนได้หลายแบบ (ยัติภังค์ ASCII, en dash, ลบยูนิโค้ด) และบางคนพิมพ์ `.` ปิดท้ายเฉย ๆ
const MONEY_SUFFIX = /^\s*(?:บาท|฿|บ\.(?![ก-๙])|\.[-\u2010-\u2015\u2212]|\.(?!\d)|\/ท่าน|\/คน|\/person|THB|baht)/iu;
const MONEY_WORD = "ราคา|ท่านละ|คนละ|หัวละ|เพียง|เหลือ|ลด|ปกติ|เริ่มต้น|ยอดรวม|รวม|มัดจำ|ชำระ"
  + "|จ่าย|โอน|งบ|ค่าเรียน|ค่าคอร์ส|ค่าอบรม|ค่าใช้จ่าย|ค่าสมัคร|ค่าธรรมเนียม|โปร|โปรโมชั่น"
  + "|ส่วนลด|Early\\s*Bird|THB|฿|baht|price|rate";
// ยอมให้มีคำขยายคั่นได้ไม่เกิน 12 ตัวอักษร ("ราคาโปร 12,900" · "rate of THB 79,000")
// กว้างพอจะจับสำนวนจริงที่เจอในคลัง แต่แคบพอที่ "ปี" ในประโยคเดียวกันจะอยู่ไกลเกินหน้าต่าง
const MONEY_PREFIX = new RegExp(`(?:${MONEY_WORD})[^\\d\\n]{0,12}$`, "iu");

/** ตัวเลขในบรรทัดนี้ที่เป็น "การอ้างราคา" จริง ๆ — ใช้ร่วมกันทุกกฎที่ตัดสินเรื่องเงิน */
export function moneyMatches(line) {
  const out = [];
  for (const match of String(line).matchAll(MONEY_RE)) {
    const after = line.slice(match.index + match[0].length);
    const before = line.slice(0, match.index);
    if (MONEY_SUFFIX.test(after) || MONEY_PREFIX.test(before)) out.push(match);
  }
  return out;
}

// นับเฉพาะบอลลูนที่ "จบ" ด้วยคำถามจริง — คำว่า อะไร/ยังไง กลางประโยคบอกเล่าไม่ใช่คำถาม
const QUESTION_RE = /(?:[?？]|ไหม|มั้ย|หรือเปล่า|รึเปล่า|หรือยัง)\s*(?:คะ|ครับ|ค่ะ|นะคะ|นะครับ)?\s*$/u;
// บันไดคัดกรองระดับ AI = คำถามมาตรฐานที่ต้องส่งพร้อมตัวเลือกครบ (ข้อยกเว้นที่ระบบอนุญาต)
const LADDER_OPTION = /^\s*[1-5]️⃣/u;
// คำถามที่อยู่ตำแหน่งใดก็ได้ (ใช้เฉพาะตอนผ่อนเกณฑ์ ends_with_question)
const ANY_QUESTION_RE = /(?:[?？]|ไหมคะ|ไหมครับ|มั้ยคะ|มั้ยครับ|เท่าไหร่คะ|อะไรคะ|ระดับที่เท่าไหร่)/u;

// พี่ง้วงอนุมัติ 2026-08-18: บอทบอก "ยอดรวม" ตามจำนวนท่านได้ (11,900 × 2 = 23,800)
// เพราะแอดมินต้องบอกยอดโอนอยู่ดี — ต่างจาก "ส่วนต่าง/ยอดประหยัด" ที่ยังห้ามคำนวณ
// อนุญาตเฉพาะผลคูณของราคาอนุมัติด้วยจำนวนเต็ม 2-20 ท่าน (กันเลขมั่วที่บังเอิญหาร ๆ ลงตัว)
export function approvedTotals(approvedAmounts) {
  return new Set([...approvedAmounts].flatMap((base) =>
    Array.from({ length: 19 }, (_, i) => base * (i + 2))));
}

export function isApprovedMoney(amount, approvedAmounts = new Set(), totals = null) {
  return approvedAmounts.has(amount) || (totals ?? approvedTotals(approvedAmounts)).has(amount);
}

function bubblesText(bubbles) {
  return bubbles.map((b) => b.text || "").join("\n");
}

// "ไม่ได้มีทุกวันเสาร์" / "ไม่ใช่ทุกวันเสาร์" = ปฏิเสธคำนั้น ไม่ใช่พูดเอง
// ดูคำปฏิเสธที่อยู่ก่อนหน้าไม่เกิน 12 ตัวอักษร (ภาษาไทยไม่มีเว้นวรรค จึงนับตัวอักษร)
// ถ้าคำนั้นโผล่หลายที่ ต้องเป็นการปฏิเสธ "ทุกครั้ง" ถึงจะปล่อยผ่าน
export function isNegatedMention(text, needle) {
  const src = String(text);
  let from = 0;
  let found = false;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at < 0) break;
    found = true;
    if (!/ไม่ได้|ไม่ใช่|ไม่มี|ไม่ได้เปิด|มิได้/u.test(src.slice(Math.max(0, at - 12), at))) return false;
    from = at + needle.length;
  }
  return found;
}

/**
 * @param {{bubbles: Array, images: Array, customer: object, teamNotes?: number}} actual
 * @param {Array} expects  รายการ assertion เฉพาะเคส
 * @param {{approvedAmounts?: Set<number>|number[], bannedPhrases?: string[]}} [tables]
 *   ตารางของ "รุ่นที่กำลังตรวจ" — ด่าน G5 ส่ง bundle.guardTables ของ candidate เข้ามา
 *   ชุดทดสอบส่งค่าคงที่ของ pilot เข้ามา ทั้งคู่เดินผ่านตรรกะชุดเดียวกัน
 */
export function checkTurn(actual, expects = [], tables = {}) {
  const fails = [];
  const approvedAmounts = tables.approvedAmounts instanceof Set
    ? tables.approvedAmounts
    : new Set((tables.approvedAmounts ?? []).map(Number));
  const totals = approvedTotals(approvedAmounts);
  const bannedPhrases = Array.isArray(tables.bannedPhrases) ? tables.bannedPhrases : [];
  const okMoney = (amount) => isApprovedMoney(amount, approvedAmounts, totals);
  const { bubbles = [], images = [], customer = {}, teamNotes = 0 } = actual;
  const all = bubblesText(bubbles);
  const texts = bubbles.map((b) => String(b.text || ""));

  const has = (needle) => all.includes(needle);
  const fail = (rule, detail) => fails.push({ rule, detail });

  /* ---------- เกณฑ์พื้นฐาน: ใส่ให้ทุกเทิร์นเสมอ ---------- */

  // เว้นเคสที่ตั้งใจให้เงียบ — ไม่มีข้อความก็ไม่ต้องตรวจเนื้อหา
  const wantsSilent = expects.some((e) => e.type === "silent");
  if (!wantsSilent && bubbles.length + images.length === 0) {
    fail("no_reply", "บอทไม่ตอบอะไรเลยทั้งที่ควรตอบ");
    return fails;
  }

  for (const banned of bannedPhrases) {
    if (has(banned)) fail("banned_phrase", `พบคำต้องห้าม "${banned}"`);
  }

  if (bubbles.length > 5) fail("max_bubbles", `${bubbles.length} บอลลูน (เพดาน 5)`);

  // ลิงก์ต้องอยู่บอลลูนเดี่ยว ห้ามมีอะไรต่อท้าย (เคสจริง: "ค่ะ" ติดท้าย URL ทำลิงก์ตาย)
  for (const t of texts) {
    const m = t.match(URL_RE);
    if (!m) continue;
    const after = t.slice(t.indexOf(m[0]) + m[0].length).trim();
    if (after) fail("link_not_alone", `มีข้อความต่อท้ายลิงก์: "${after.slice(0, 30)}"`);
  }

  // ราคาทุกตัวต้องอยู่ในตารางอนุมัติ
  for (const line of all.split("\n")) {
    for (const m of moneyMatches(line)) {
      const n = Number(m[1].replaceAll(",", ""));
      if (n >= 1000 && !okMoney(n)) {
        fail("price_not_approved", `เลข ${m[1]} ไม่อยู่ในตารางราคาอนุมัติ`);
      }
    }
  }

  /* ---------- เกณฑ์เฉพาะเคส ---------- */

  for (const e of expects) {
    switch (e.type) {
      case "silent":
        if (bubbles.length + images.length > 0) {
          fail("should_be_silent", `ต้องเงียบแต่ตอบ ${bubbles.length} บอลลูน: "${all.slice(0, 60)}"`);
        }
        break;
      case "must_not_include":
        // allow_negated: คำต้องห้ามบางคำ "ห้ามพูดเอง" แต่ "ปฏิเสธได้"
        // เคสจริง 2026-08-19: เกณฑ์ห้าม overclaim ว่าเปิดสอน "ทุกวันเสาร์" แต่บอทตอบว่า
        // "เปิดตามวันที่กำหนด ไม่ได้มีทุกวันเสาร์นะคะ" ซึ่งคือคำตอบที่ถูกที่สุด แล้วโดนตัดสินว่าตก
        // (ทรงเดียวกับ false positive ของ no_negative_opener ที่แก้ไปแล้วในแบทช์ 3-4)
        // ไม่เปิดให้ทุกกรณีโดยอัตโนมัติ เพราะบางคำ (เช่น "การันตี") คลังสั่งห้ามพูดถึงเลย
        // ทั้งเชิงบวกและเชิงปฏิเสธ — จึงต้องระบุ allow_negated: true ในเคสที่ตั้งใจเท่านั้น
        for (const v of e.values || []) {
          if (!has(v)) continue;
          if (e.allow_negated && isNegatedMention(all, v)) continue;
          fail("must_not_include", `พบ "${v}"`);
        }
        break;
      case "must_include_any":
        if (!(e.values || []).some((v) => has(v))) {
          fail("must_include_any", `ไม่พบสักคำใน [${(e.values || []).join(", ")}]`);
        }
        break;
      case "must_include_all":
        for (const v of e.values || []) if (!has(v)) fail("must_include_all", `ขาด "${v}"`);
        break;
      case "no_negative_opener": {
        const first = (texts[0] || "").trim();
        if (NEGATIVE_OPENER.test(first) && !REASSURING_OPENER.test(first)) {
          fail("negative_opener", `เปิดหัวด้วยการปฏิเสธ: "${first.slice(0, 40)}"`);
        }
        break;
      }
      case "max_bubbles":
        if (bubbles.length > e.value) fail("max_bubbles", `${bubbles.length} > ${e.value}`);
        break;
      case "max_questions": {
        const count = texts.reduce((n, t) => {
          if (LADDER_OPTION.test(t)) return n; // บอลลูนตัวเลือกบันได ไม่ใช่คำถามใหม่
          return n + (QUESTION_RE.test(t.trim()) ? 1 : 0);
        }, 0);
        if (count > e.value) fail("max_questions", `คำถาม ${count} ข้อ (เพดาน ${e.value})`);
        break;
      }
      case "ends_with_question": {
        // บันไดคัดกรองระดับ AI ส่ง "ตัวเลือก 1-5" เป็นบอลลูนสุดท้าย โดยคำถามอยู่บอลลูนก่อน
        // — ถอยไปหาบอลลูนที่ไม่ใช่รายการตัวเลือกก่อนตัดสิน
        const tail = [...texts].reverse().find((t) => !LADDER_OPTION.test(t.trim())) || "";
        // ยอมรับคำถามที่อยู่ตำแหน่งใดก็ได้ในบอลลูนสุดท้าย (บันไดมีตัวเลือกต่อท้ายคำถาม)
        if (!QUESTION_RE.test(tail.trim()) && !ANY_QUESTION_RE.test(tail)) {
          fail("ends_with_question", `บอลลูนสุดท้ายไม่ใช่คำถาม: "${tail.slice(-40)}"`);
        }
        break;
      }
      case "no_price":
        for (const line of all.split("\n")) {
          if (moneyMatches(line).some((m) => Number(m[1].replaceAll(",", "")) >= 1000)) {
            fail("no_price", `มีราคาทั้งที่ยังไม่ถึงจังหวะ: "${line.slice(0, 50)}"`);
          }
        }
        break;
      case "must_have_price":
        // ต้อง "บอกราคา" ไม่ใช่ "มีตัวเลขที่บังเอิญตรงตาราง" — ปี 2569 ไม่ใช่การบอกราคา
        if (!all.split("\n").flatMap(moneyMatches).some((m) => okMoney(Number(m[1].replaceAll(",", ""))))) {
          fail("must_have_price", "ต้องมีราคาที่อนุมัติแต่ไม่พบ");
        }
        break;
      case "image_sent":
        if (!images.length) fail("image_sent", "ต้องส่งรูปแต่ไม่มี");
        break;
      case "ai_off":
        if (customer.ai_enabled === 1) fail("ai_off", `AI ยังเปิดอยู่ (reason="${customer.ai_off_reason || ""}")`);
        break;
      // v1.4.31: "ทีมต้องรู้เรื่องนี้" — เดิมเช็คแค่ state NEEDS_HUMAN ซึ่งแปลว่า "ปิด AI"
      // ด้วย แต่พี่ง้วงเลือกทรงใหม่: บางเคสให้สร้างใบสั่งงาน + push แจ้งแอดมิน โดย AI
      // คุยต่อ (ไม่ตัดบทลูกค้า high-end) เกณฑ์นี้จึงถามคำถามที่ตรงกว่าว่า
      // "สุดท้ายมีคนจริงได้รับเรื่องหรือยัง" ไม่ว่าจะมาทางไหน
      case "team_notified":
        if (customer.state !== "NEEDS_HUMAN" && teamNotes === 0) {
          fail("team_notified", `ไม่มีใครในทีมได้รับเรื่องเลย (state=${customer.state || "?"}, โน้ต=${teamNotes})`);
        }
        break;
      case "needs_human":
        if (customer.state !== "NEEDS_HUMAN") fail("needs_human", `state = ${customer.state || "?"}`);
        break;
      default:
        fail("unknown_assertion", `ไม่รู้จัก assertion "${e.type}"`);
    }
  }
  return fails;
}

/* ----------------------------- อ่านเกณฑ์เป็นภาษาไทย ----------------------------- */

// เจ้าของต้องตัดสินได้ว่า "เกณฑ์ข้อนี้ล้าสมัยจริงไหม" โดยไม่ต้องอ่านโค้ด — แบบแปลน §6 Step 4
// สั่งไว้ตรง ๆ ว่าเคส irreversible ที่ยังบล็อกอยู่ ต้องแสดง assertion เป็นภาษาไทย
const LIST = (values) => (Array.isArray(values) ? values : []).map((v) => `“${v}”`).join(" / ") || "(ไม่ได้ระบุ)";

export function assertionThai(expect = {}) {
  const e = expect ?? {};
  switch (e.type) {
    case "silent": return "ต้องไม่ตอบอะไรเลยในเทิร์นนี้";
    case "must_not_include": return `ห้ามมีคำว่า ${LIST(e.values)}${e.allow_negated ? " (พูดปฏิเสธได้)" : ""}`;
    case "must_include_any": return `ต้องมีอย่างน้อยหนึ่งคำใน ${LIST(e.values)}`;
    case "must_include_all": return `ต้องมีครบทุกคำ ${LIST(e.values)}`;
    case "no_negative_opener": return "ห้ามเปิดหัวคำตอบด้วยการปฏิเสธ";
    case "max_bubbles": return `ตอบได้ไม่เกิน ${e.value} บอลลูน`;
    case "max_questions": return `ถามได้ไม่เกิน ${e.value} คำถามในเทิร์นเดียว`;
    case "ends_with_question": return "บอลลูนสุดท้ายต้องเป็นคำถาม";
    case "no_price": return "ยังไม่ถึงจังหวะบอกราคา — ห้ามมีตัวเลขราคา";
    case "must_have_price": return "ต้องบอกราคาที่อยู่ในตารางอนุมัติ";
    case "image_sent": return "ต้องส่งรูป";
    case "ai_off": return "ต้องปิด AI แล้วส่งต่อคนจริง";
    case "team_notified": return "ต้องมีคนในทีมได้รับเรื่องนี้ (ปิด AI หรือเปิดใบสั่งงาน)";
    case "needs_human": return "ห้องนี้ต้องขึ้นสถานะรอคนจริง";
    default: return `เกณฑ์ "${e.type ?? "?"}" (ยังไม่มีคำอธิบายภาษาไทย)`;
  }
}

// ผลที่ตกหนึ่งข้อ -> ประโยคที่คนอ่านออก (ไม่ใช่ชื่อกฎ)
const FAIL_LABEL = Object.freeze({
  no_reply: "ไม่ตอบอะไรเลยทั้งที่ควรตอบ",
  banned_phrase: "หลุดคำต้องห้าม",
  max_bubbles: "ตอบยาวเกินจำนวนบอลลูนที่ตั้งไว้",
  link_not_alone: "ลิงก์มีข้อความต่อท้าย (ลิงก์จะกดไม่ได้)",
  price_not_approved: "พูดตัวเลขที่ไม่อยู่ในตารางราคาของรุ่นนี้",
  should_be_silent: "ควรเงียบแต่ตอบ",
  must_not_include: "พูดคำที่ห้ามพูด",
  must_include_any: "ไม่ได้พูดสิ่งที่ต้องพูด",
  must_include_all: "พูดไม่ครบ",
  negative_opener: "เปิดหัวด้วยการปฏิเสธ",
  max_questions: "ถามหลายคำถามเกินไป",
  ends_with_question: "ไม่จบด้วยคำถาม",
  no_price: "บอกราคาก่อนจังหวะ",
  must_have_price: "ไม่บอกราคาทั้งที่ต้องบอก",
  image_sent: "ไม่ได้ส่งรูป",
  ai_off: "ไม่ได้ปิด AI ส่งต่อคน",
  team_notified: "ไม่มีใครในทีมได้รับเรื่อง",
  needs_human: "ห้องไม่ได้ขึ้นสถานะรอคนจริง",
  unknown_assertion: "เกณฑ์ที่โค้ดชุดนี้ไม่รู้จัก",
});

export function failThai(fail = {}) {
  const label = FAIL_LABEL[fail?.rule] ?? String(fail?.rule ?? "");
  return fail?.detail ? `${label} — ${fail.detail}` : label;
}
