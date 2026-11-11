// personaParticles.mjs — ด่านคำลงท้ายผู้หญิงของลูกแพร (คำสั่งพี่ง้วง 5 ต.ค. 2026 "เพิ่มด่านกันคำว่าครับให้หน่อย")
//
// เคสจริง (เครื่อง production legacy + Sonnet, case-038): ส่ง "ยินดีครับ... เอ่อ ยินดีค่ะ 😊" ถึงลูกค้า
// ลูกแพรเป็นผู้หญิง แต่ก่อนหน้านี้ไม่มีอะไรในเส้นส่งที่ลบคำลงท้ายผู้ชายเลย (humanizer นับ ครับ เป็นคำสุภาพ)
//
// ทำไม "แก้" ไม่ "บล็อก": ครับ → ค่ะ/คะ เป็นการเปลี่ยนไวยากรณ์ชุดปิด ความหมายเท่าเดิม
//   · บล็อกแล้วร่างใหม่ = จ่ายโมเดลอีกรอบ + ลูกค้ารอ 5–20 วิ + อาจพลาดซ้ำ
//   · บล็อกเฉย ๆ = ลูกค้าเจอความเงียบ ซึ่งทั้งระบบถือว่าแย่กว่า
// ทำไมไม่ replace ทั้งก้อนแบบ autoFix เดิม: ได้ภาษาไทยผิดสามแบบ — "สนใจไหมค่ะ" (คำถามต้อง คะ),
//   "ค่ะผม" (ครับผม), และ "ยินดีค่ะ... เอ่อ ยินดีค่ะ" (คำแก้ตัวเองซ้ำ) — แถมด่านจับคำถาม
//   (handoffClosing QUESTION_KA_END, humanizer QUESTION_HINT) อาศัย คะ จึงพังตามไปด้วย
// "ผม" แปลว่า "เส้นผม" ได้ (ร้านตัดผม ทำผม ป้ายรีวิว "CEO ร้านตัดผม") จึงแค่แจ้ง (residual) ห้ามแก้
//
// โมดูลบริสุทธิ์: ไม่มี I/O ไม่เรียกโมเดล ไม่ import โมดูลอื่น — เรียกซ้ำได้ผลเท่าเดิม (idempotent)

/** ชนิดการแก้ที่รายงานใน fixes[].kind */
export const PARTICLE_FIX_KINDS = Object.freeze([
  "self_correction", "double_particle", "na_khrap", "khrap_phom", "khrap_question", "khrap",
  "khrap_variant", "ha", "khap",
]);
/** ชนิดที่แจ้งอย่างเดียว (ไม่แก้) ใน residual[].kind — guard_error มาจาก humanizer เมื่อด่านนี้พังเอง */
export const PARTICLE_RESIDUAL_KINDS = Object.freeze(["male_pronoun", "protected_particle", "empty_guard", "guard_error"]);

/* --------------------------------- ช่วงห้ามแตะ --------------------------------- */

// URL ใช้นิยามเดียวกับ humanizer (URL_SOURCE): อักษรไทยไม่ใช่ส่วนของลิงก์
const PROTECTED_PATTERNS = Object.freeze([
  /https?:\/\/[^\s\u0E00-\u0E7F]+/gu,
  /www\.[^\s\u0E00-\u0E7F]+/gu,
  /\[image:[^\]\n]*\]/giu,
  /\[approved-url:[^\]\n]*\]/giu,
  /\{\{[^{}\n]*\}\}/gu,
]);
const MIN_PROTECT_CHARS = 2; // ชื่อสั้นกว่านี้กันทั้งข้อความโดยไม่ตั้งใจ

function protectedRanges(text, protect) {
  const ranges = [];
  for (const pattern of PROTECTED_PATTERNS) {
    for (const match of text.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  }
  for (const raw of Array.isArray(protect) ? protect : []) {
    if (typeof raw !== "string") continue;
    const needle = raw.trim();
    if ([...needle].length < MIN_PROTECT_CHARS) continue;
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      ranges.push([at, at + needle.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

const overlaps = (ranges, start, end) => ranges.some(([from, to]) => from < end && start < to);

/* ------------------------------- ขอบประโยคไทย ------------------------------- */

const EMOJI_CHARS = "\\p{Extended_Pictographic}\\p{Emoji_Modifier}\\u200D\\uFE0F\\uFE0E\\u20E3";
// คำลงท้ายที่ "จบประโยค" ต้องตามด้วยช่องว่าง/เครื่องหมาย/emoji/จบข้อความ — "คับ" ใน "คับแคบ" ไม่ใช่
const END_AHEAD = new RegExp(`^(?:$|[\\s.!?？…~,，)\\]"'”’${EMOJI_CHARS}])`, "u");
// ครับ/คร้าบ/ค้าบ ยืดเสียง (ครับบบ) นับ บ ที่ต่อท้ายเฉพาะตอนไม่มีอักษรไทยตามมา — ของเดิม ครับ+ กิน บ ตัวแรกของ
// คำถัดไป: "ขอบคุณครับบอส" ได้ "ขอบคุณค่ะอส" "โอนได้เลยครับบัญชี…" ได้สระลอย "ค่ะัญชี" และรอบสองแก้ซ้ำ
// ("ได้ครับบังคับ" → "ค่ะังคับ" → "ค่ะังค่ะ") — จุดเดียวที่ด่านเปลี่ยนตัวอักษรนอกคำลงท้าย (รีวิวปรปักษ์รอบ 3 5 ต.ค.)
// ใช้ชุดเดียวทุกที่ที่จับคำลงท้าย: ขอบประโยค คำแก้ หาง ตัวเทียบเนื้อหา ตัวสลับ ตัวแจ้งช่วงห้ามแตะ
// รอบ 3 ตรวจซ้ำ: ครับบบ ตามด้วยคำไทยต้องกินบ ที่ยืดทั้งหมด (ไม่เหลือ "ค่ะบบ") แต่เหลือบ ตัวสุดท้ายให้คำถัดไปที่ขึ้นต้นด้วย บ (ครับบอส → ค่ะบอส)
const KHRAP_STRETCH = "(?:บ+(?![\\u0E00-\\u0E7F])|บ+(?=[เแโใไ])|บ+(?=บ[\\u0E00-\\u0E7F]))?";
const KHRAP_FORMS = `ครับ${KHRAP_STRETCH}|คร[้๊]าบ${KHRAP_STRETCH}|ค้าบ${KHRAP_STRETCH}`;
// ฮะ/คับ กำกวม: ไม่นับเสียงหัวเราะ (ฮะฮะ ฮ่าฮะ) และคำ บังคับ ประคับประคอง
const MALE_PARTICLE = `(?:${KHRAP_FORMS}|(?<!ฮะ|ฮ่า|ฮา)ฮะ|(?<!บัง|ประ)คับ)(?:ผม)?`;
// ภาษาไทยไม่มี full stop: คำลงท้าย/เครื่องหมายแล้วเว้นวรรค = ประโยคใหม่
// ฮะ/คับ/ครับผม ก็จบประโยค — ของเดิมไม่มี เลย "ได้ฮะ รบกวนแจ้งว่า…ไหนครับ" ไม่เห็นว่า รบกวน อยู่ต้นประโยค (รีวิวปรปักษ์รอบ 3 5 ต.ค.)
const SENTENCE_BREAK = new RegExp(`(?:ค่ะ|คะ|ค่า|${MALE_PARTICLE}|[!?？.…])\\)?\\s+`, "gu");
const TRAILING_DECOR = new RegExp(`[\\s.!…~${EMOJI_CHARS}]+$`, "u");
// emoji ที่ลูกแพรชอบวางหลังประโยคแรก ("ได้เลยค่ะ 😊 รบกวน…") ตกไปอยู่ต้นประโยคถัดไป ต้องตัดก่อนดูกฎต้นประโยค
// (รบกวน… / ลูกค้าว่า… / ใครที่…) — ของเดิมตัดแค่ท้าย คำถามเลยได้ ค่ะ (รีวิวปรปักษ์รอบ 3 5 ต.ค.)
const LEADING_DECOR = new RegExp(`^[\\s.!…~${EMOJI_CHARS}]+`, "u");

const lineStartOf = (text, offset) => text.lastIndexOf("\n", offset - 1) + 1;

function sentenceStartIn(segment) {
  let start = 0;
  for (const match of segment.matchAll(SENTENCE_BREAK)) start = match.index + match[0].length;
  return start;
}

/* ------------------------------- ประโยคคำถาม -------------------------------- */

// สัญญาณชุดเดียวกับ humanizer QUESTION_HINT (ไหม/มั้ย/หรือเปล่า/หรือยัง, คำแสดงคำถาม, หรือ-ตัวเลือก)
// "ผ้าไหม" คือผ้า ไม่ใช่คำถาม
// ไง/ป่ะ/ปะ/เปล่า ถามแบบเดียวกับ ไหม — ของเดิมไม่รู้จัก "ว่าไงครับ" "สนใจป่ะครับ" เลยได้ ค่ะ (รีวิวปรปักษ์ 5 ต.ค. #15)
// "ยังไง" ท้ายประโยคไม่นับตรงนี้ เพราะอาจเป็นเรื่องเล่า ("จะสอนว่าใช้ AI ยังไง") ให้ QUESTION_WORD ตัดสิน
// "ว่างเปล่า" "มือเปล่า" "ตาเปล่า" ไม่ใช่คำถาม และ "เปล่า" คำเดียว = ตอบว่า "ไม่" ไม่ได้ถาม
// (รีวิวปรปักษ์รอบ 2 5 ต.ค.: "เปล่าครับ" "มองด้วยตาเปล่าครับ" เคยได้ คะ)
// "โอนแล้วยัง" "สนใจป่าว" ถามแบบภาษาพูด แต่ "ยัง" "ป่าว" คำเดียว = ตอบ ไม่ได้ถาม (รีวิวปรปักษ์รอบ 3 5 ต.ค.)
const QUESTION_END = /(?<!ผ้า)(?:ไหม|มั้ย|มั๊ย|ไม๊|หรือเปล่า|รึเปล่า|(?<=\S)(?<!ว่าง|มือ|ตา)เปล่า|หรือป่าว|รึป่าว|ป่ะ|ปะ|หรือยัง|รึยัง|แล้วยัง|(?<=\S)ป่าว|หรือไม่|หรือ|เหรอ|หรอ|(?<!ยัง)ไง)$/u;
// "ใคร่ครวญ" ไม่ใช่ "ใคร" · "เกี่ยวกับ" "เกี่ยง" ไม่ใช่ "กี่" (รีวิวปรปักษ์ 5 ต.ค. #15: "สอนเกี่ยวกับ AI ครับ" เคยได้ คะ)
// "เป็นไงบ้าง" = ไง ที่ไม่ได้อยู่ท้าย
const QUESTION_WORD = /(?:อะไร|ไหน|ใคร(?!่)|ทำไม|ยังไง|อย่างไร|เมื่อไหร่|เมื่อไร|เท่าไหร่|เท่าไร|(?<!เ)กี่|ไง)/gu;
const QUESTION_WORD_WINDOW = 20;
const CHOICE_WORD = /หรือ(?!เปล่า|ป่าว|ยัง|ไม่)/gu;
const CHOICE_WINDOW = 48;
// คำแสดงคำถามที่ไม่ได้ถาม: "ไม่มีค่าใช้จ่ายอะไรเพิ่ม" "ถ้ามีอะไรสงสัย" — แต่ "ไม่ทราบว่า…ไหน" ยังเป็นคำถาม
// ไม่/ถ้า ต้องอยู่ "วลีเดียวกัน" (ก่อนเว้นวรรค) กับคำแสดงคำถาม: ของเดิมดูทั้งประโยค เลยตัด
// "ถ้าไม่สะดวกวันเสาร์ สะดวกวันไหนครับ" เป็น ค่ะ ทั้งที่เงื่อนไขจบที่วรรคแล้ว วลีหลังยังถาม (รีวิวปรปักษ์ 5 ต.ค. #15)
// "หากิน" "หากัน" ไม่ใช่ หาก
const INDEFINITE = /ไม่(?!ทราบ)|ถ้า|หาก(?!ิน|ัน)/u;
// คำแสดงคำถามในประโยคย่อยหลัง "ว่า" = เล่าให้ฟัง ไม่ได้ถาม — "แจ้งให้ว่าเริ่มกี่โมง" "จะสอนว่าใช้ AI ยังไง"
// ยกเว้นกริยาถาม (ไม่ทราบว่า/สอบถามว่า/สงสัยว่า/คิดว่า) และคำขอ "รบกวนแจ้งว่า…ไหน" ยังเป็นคำถาม
// "กว่า" "ว่าง" ไม่ใช่ ว่า (รีวิวปรปักษ์ 5 ต.ค. #15) — แต่ "บอกว่า" คือ ว่า: ของเดิมตัดทิ้งเพราะลงท้าย ก
// เลย "เดี๋ยวพี่ง้วงจะบอกว่าใช้ AI ยังไงครับ" ได้ คะ (รีวิวปรปักษ์รอบ 2 5 ต.ค.)
const COMPLEMENT_WA = /(?:(?<=บอก)|(?<!ก))ว่า(?!ง)/gu;
// ว่า หลังกริยาถาม/เรียกชื่อ ยังถาม: "ชื่อว่าอะไร" "แปลว่าอะไร" "หมายความว่ายังไง" "เห็นว่ายังไง" และคนเป็นประธาน
// ต้นประโยค "ลูกค้าว่ายังไง" "แล้วพี่ว่าคลาสไหนเหมาะ" — ของเดิมนับเป็นเรื่องเล่าหมด เลยได้ "อะไรค่ะ" แบบที่ด่านนี้มีไว้กัน
// แต่ "แจ้งให้ทราบว่า…" = บอกเล่า และคนที่ไม่ได้อยู่ต้นประโยค ("แจ้งคุณลูกค้าว่าเริ่มกี่โมง") ไม่นับ (รีวิวปรปักษ์รอบ 2 5 ต.ค.)
// "อยากรู้ว่า…ไหน" ถามเหมือน "อยากทราบว่า" (รีวิวปรปักษ์รอบ 3 5 ต.ค.)
const ASKING_BEFORE_WA = /(?:(?<!ให้)ทราบ|อยากรู้|ถาม|สงสัย|คิด|เห็น|ชื่อ|เรียก|แปล|หมายความ|หมายถึง)\s?$|^\s*(?:แล้ว)?(?:(?:คุณ)?(?:ลูกค้า|พี่|น้อง|ท่าน|คุณ)\S{0,6}|รู้สึก)\s?$/u;
const REQUEST_START = /^\s*รบกวน/u;
const LISTING = /(?:เช่น|ทั้ง|เหมาะกับ|เหมาะสำหรับ|ไม่ว่า)/u;
// ช่องทางชำระที่เล่าให้ฟัง "โอนผ่านพร้อมเพย์หรือบัญชีธนาคาร" = บอกเล่า (รีวิวปรปักษ์ 5 ต.ค. #15)
// แต่ "สะดวกโอนผ่าน…หรือ…" "จะโอนผ่าน…หรือ…" "…หรือบัญชีธนาคารดี" ยังถามให้เลือก (รีวิวปรปักษ์รอบ 2 5 ต.ค.)
const PAY_CHANNEL = /(?<!(?:สะดวก|จะ|อยาก|เลือก|ต้องการ)\s?)(?:โอน|ชำระ|จ่าย)(?:เงิน)?(?:ได้)?(?:ทั้ง)?ผ่าน/u;
const CHOICE_ASKS_BEST = /ดี$/u;
// บอกตัวเลือกที่ทำได้ทุกทาง "โอนหรือจ่ายบัตรได้" "ออนไลน์หรือออนไซต์ราคาเดียวกัน" และช่วงตัวเลขโดยประมาณ
// "ภายใน 1 หรือ 2 วัน" = บอกเล่า — ของเดิมได้ คะ แล้ว humanizer แยกเป็นบอลลูนคำถาม "โอนหรือจ่ายบัตรได้คะ?"
// ถามว่าทำได้ไหมต้องมี ไหม ท้าย ซึ่ง QUESTION_END จับก่อนถึงตรงนี้ · "จะมา 1 หรือ 2 ท่าน" ไม่มีคำประมาณ ยังถาม
// (รีวิวปรปักษ์รอบ 3 5 ต.ค.)
// รอบ 3 ตรวจซ้ำ: "…หรือเพิ่มรายได้" เป็นคำถามตัวเลือก — ได้ ของคำว่า รายได้ ไม่ใช่ "ทำได้"
const CHOICE_CAN_END = /(?:(?<!ราย)ได้(?:หมด|ทั้งคู่|ทั้งสอง\S{0,4})?|เหมือนกัน|เท่ากัน|เดียวกัน)$/u;
const APPROX_BEFORE = /(?:ภายใน|ประมาณ|ราว ?ๆ?|ไม่เกิน|อย่างน้อย|ใช้เวลา)\s?\d[\d,.]*\s?$/u;
const NUMBER_AHEAD = /^\s?\d/u;
// "สะดวกเมื่อไหร่ส่งสลิปได้เลย" = เชิญชวน ไม่ใช่คำถาม
// "ถ้ามีอะไรสงสัยทักมาได้" "ติดตรงไหนบอกลูกแพรได้" "…ลูกแพรอธิบายให้ฟังได้" = ชวนให้ทักมา (รีวิวปรปักษ์ 5 ต.ค. #15)
// แต่ช่วงระหว่างกริยากับ ได้ ที่มีคำแสดงคำถาม = ถามจริง: "ติดต่อทางไหนได้" "ติดต่อกลับเบอร์ไหนได้"
// "ปรึกษาใครได้" — ของเดิมกลืนเป็นบอกเล่าเลยได้ ค่ะ (รีวิวปรปักษ์รอบ 2 5 ต.ค.)
const STATEMENT_TAIL = /(?:ได้เลย|ได้ตลอด|ได้เสมอ|ได้ทันที|(?:บอก|แจ้ง|ทัก|ถาม|ปรึกษา|ติดต่อ|อธิบาย)(?<span>\S{0,12})ได้)$/u;
const QUESTION_IN_SPAN = /ไหน|ใคร(?!่)|อะไร|(?<!เ)กี่/u;
// "ใครที่สมัครวันนี้…" "อะไรที่ลูกค้าอยากรู้…" "เหมาะกับใครที่อยาก…" = ประโยคขยาย (ใครก็ตามที่) ไม่ได้ถาม
// จำกัดแค่ ใคร/อะไร ที่ต้นประโยคหรือหลังคำแจกแจง เพราะ "ตรงไหนที่ยังไม่ชัด" "มีอะไรที่ลูกแพรช่วยได้บ้าง" ยังถามจริง
// (รีวิวปรปักษ์รอบ 2 5 ต.ค.: ช่องว่างไม่มีวรรคทำให้ประโยคขยายพวกนี้กลายเป็นคำถาม)
const RELATIVE_QWORD = /^(?:ใคร|อะไร)$/u;

function isStatementTail(value) {
  const match = value.match(STATEMENT_TAIL);
  return Boolean(match) && !QUESTION_IN_SPAN.test(match.groups.span ?? "");
}

function isRelativeClause(value, match, gap) {
  if (!RELATIVE_QWORD.test(match[0]) || !gap.startsWith("ที่")) return false;
  const before = value.slice(0, match.index);
  return !before.trim() || LISTING.test(before);
}

// คำถามไม่จำเป็นต้องจบที่คำแสดงคำถาม แต่หลังคำนั้นยาวและมีวรรค = ขึ้นประโยคย่อยใหม่แล้ว
// ยาวแต่ไม่มีวรรค ("สนใจคลาสไหนเป็นพิเศษสำหรับธุรกิจของคุณลูกค้า") ยังเป็นคำถามเดียว (รีวิวปรปักษ์ 5 ต.ค. #15)
const reachesEnd = (gap) => [...gap].length <= QUESTION_WORD_WINDOW || !/\s/u.test(gap);
const phraseBefore = (value, index) => value.slice(0, index).match(/\S*$/u)[0];

function isReportedQuestion(value, index) {
  if (REQUEST_START.test(value)) return false;
  const head = value.slice(0, index);
  const wa = [...head.matchAll(COMPLEMENT_WA)].at(-1);
  return Boolean(wa) && !ASKING_BEFORE_WA.test(head.slice(0, wa.index));
}

const isIndirectAt = (value, index) => INDEFINITE.test(phraseBefore(value, index)) || isReportedQuestion(value, index);

// ถามใช่/ไม่ใช่ที่ "เล่า" ว่าลูกแพรจะไปเช็ค: "เดี๋ยวลูกแพรเช็คให้ว่ามีที่ไหม" "ขอเช็คก่อนว่าว่างไหม" = บอกเล่า
// ของเดิม QUESTION_END ตัดสินเป็นคำถามทันที ได้ "…ไหมคะ" แล้ว humanizer เติม "?" เหมือนถามลูกค้า (รีวิวปรปักษ์รอบ 3 5 ต.ค.)
// ต้องครบสามข้อถึงจะเป็นบอกเล่า เพราะพลาดฝั่งนี้ได้ "ไหมค่ะ" ที่ด่านนี้มีไว้กัน:
//   กริยาเล่า (เช็ค/ดู/ตรวจ/แจ้ง/บอก/ถามทีม) อยู่ก่อน ว่า · ก่อนกริยามีคนทำที่เป็นลูกแพร/ทีม (เดี๋ยว/ขอ/จะ/ลูกแพร…)
//   · ไม่ใช่กริยาถาม (ทราบว่า/อยากทราบว่า/สงสัยว่า/ถามว่า) และไม่ใช่คำขอ (รบกวน/ช่วย/ลอง…/หน่อย/ขอให้)
//   "เช็คว่าได้รับอีเมลไหม" (สั่งให้ลูกค้าเช็ค ไม่มีคนทำ) จึงยังเป็นคำถาม
//   ข้อเสนอ "จะให้ลูกแพรเช็คว่า…ไหม" "สะดวกให้ทีมงานเช็ค…" เช็คกับคนฟัง "ขอเช็คกับพี่ว่า…ไหม" และขออนุญาตแยกวรรค
//   "ขอเช็คก่อนว่าว่าง ได้ไหม" ถามลูกค้าจริง ยังได้ คะ
const YES_NO_END = /(?:ไหม|มั้ย|มั๊ย|ไม๊|หรือเปล่า|รึเปล่า|หรือยัง|รึยัง)$/u;
const DETACHED_ASK = /\s(?:ได้|ดี|โอเค|สะดวก)?(?:ไหม|มั้ย|มั๊ย|ไม๊|หรือเปล่า|รึเปล่า|หรือยัง|รึยัง)$/u;
const REPORTING_VERB = /(?:เช็ค|เช็ก|ดู|ตรวจ|แจ้ง|บอก|ถามทีม)\S{0,12}\s?$/u;
const SPEAKER_DOES = /(?:เดี๋ยว|ขอ(?!ให้|ความ)|จะ|กำลัง|ลูกแพร|ทีม|แอดมิน)/u;
const LISTENER = "(?:คุณ)?(?:ลูกค้า|พี่|น้อง|ท่าน|คุณ)";
const REQUEST_CUE = new RegExp(
  `^\\s*(?:${LISTENER}\\S{0,6}?\\s?)?(?:รบกวน|ช่วย|ลอง|ฝาก|กรุณา)|หน่อย|อยากให้|ขอให้|ขอความ`
  + `|ให้(?:ลูกแพร|ทีม|แอดมิน|เรา)|กับ${LISTENER}`,
  "u",
);

function isReportedYesNo(value) {
  if (!YES_NO_END.test(value) || DETACHED_ASK.test(value)) return false;
  const wa = [...value.matchAll(COMPLEMENT_WA)].at(-1);
  if (!wa) return false;
  // รอบ 3 ตรวจซ้ำ: นับเป็นคำรายงานเฉพาะเมื่อประโยค ว่า… วิ่งถึงท้ายโดยไม่มีช่วงเว้นวรรค (เว้นข้างตัวเลขได้)
  // "ลูกแพรเช็คแล้วว่ารอบเสาร์เต็ม สนใจรอบอาทิตย์ไหมครับ" = ถามจริงหลังเว้นวรรค ต้องได้ คะ
  if (/(?<!\d)\s(?!\d)/u.test(value.slice(wa.index))) return false;
  const head = value.slice(0, wa.index);
  if (ASKING_BEFORE_WA.test(head) || REQUEST_CUE.test(head)) return false;
  const verb = head.match(REPORTING_VERB);
  return Boolean(verb) && SPEAKER_DOES.test(head.slice(0, verb.index));
}

function isQuestionSentence(sentence) {
  const value = String(sentence || "").replace(LEADING_DECOR, "").replace(TRAILING_DECOR, "");
  if (!value) return false;
  if (isReportedYesNo(value)) return false;
  if (QUESTION_END.test(value)) return true;
  if (isStatementTail(value)) return false;
  for (const match of value.matchAll(QUESTION_WORD)) {
    const gap = value.slice(match.index + match[0].length);
    if (!reachesEnd(gap) || gap.startsWith("ๆ") || gap.includes("ก็")) continue;
    if (isRelativeClause(value, match, gap) || isIndirectAt(value, match.index)) continue;
    return true;
  }
  for (const match of value.matchAll(CHOICE_WORD)) {
    const prefix = value.slice(0, match.index);
    const gap = value.slice(match.index + match[0].length);
    if ([...gap].length > CHOICE_WINDOW || gap.includes("ก็")) continue;
    if (isIndirectAt(value, match.index) || LISTING.test(prefix) || LISTING.test(gap)) continue;
    if (PAY_CHANNEL.test(prefix) && !CHOICE_ASKS_BEST.test(gap)) continue;
    if (CHOICE_CAN_END.test(gap) || (APPROX_BEFORE.test(prefix) && NUMBER_AHEAD.test(gap))) continue;
    return true;
  }
  return false;
}

/* ------------------------- (1) คำแก้ตัวเองหลังคำลงท้ายผู้ชาย ------------------------- */

// กฎเดียวที่พิสูจน์ได้ว่าไม่เปลี่ยนความหมาย (รีวิวปรปักษ์รอบ 2 5 ต.ค.; เป้าพี่ง้วง: ลูกแพรห้ามส่ง ครับ
// หน้าที่ของด่านคือคำลงท้าย ไม่ใช่เขียนเนื้อหาของโมเดลใหม่):
//   ยุบ "ประโยค + ครับ + คำแก้ + หาง" เหลือแค่หาง ก็ต่อเมื่อเนื้อหาสองฝั่ง "เท่ากัน" หลังตัดคำลงท้าย คำเสริม
//   (เลย/นะ/มาก/ด้วย/จ้า/ลูกแพร) วรรค จุดไข่ปลา เครื่องหมาย — "ยินดีครับ... เอ่อ ยินดีค่ะ" "ยินดีเลยครับ เอ้ย ยินดีค่ะ"
//   "ยินดีครับ เอ่อ ลูกแพรยินดีค่ะ" ส่งออกเป็นหาง (คำสุดท้ายของโมเดล) ที่มีเนื้อหาครบทุกตัวอักษร
//   กรณีอื่นทั้งหมดไม่ยุบ: สลับคำลงท้ายอย่างเดียว คงคำแก้และทั้งสองประโยคไว้ตามที่โมเดลเขียน
// ทำไมเลิกกฎ "หางชนะ / ประโยคสั้นให้หางแทน / รายการข้อเท็จจริง": รอบแรกแก้ทีละรู แล้วรอบสองยังเจอรูใหม่ทุกทาง —
//   ตัด ไม่ แล้วความหมายกลับ ("ไม่ต้องโอนมัดจำ" → "ต้องโอนมัดจำ"), ทิ้งราคา/วัน/การคืนเงิน/คำว่าฟรี ที่รายการไม่รู้จัก,
//   ตัด "เอ้ย" ทิ้งแล้วเหลือสองราคาติดกัน ("4,900 บาทค่ะ 5,900 บาทค่ะ") — ตัวอักษรอย่างเดียวแยกไม่ออกว่าคำไหนเป็นข้อเท็จจริง
//   เห็น "เอ้ย" กลางข้อความแย่น้อยกว่าลูกค้าได้ข้อมูลผิดหรือขาด และยังเห็นว่าค่าไหนถูกแก้
// หางว่าง (ไม่มีอะไรต่อในบรรทัด) หรือหางมีแต่คำลงท้าย ("ยินดีครับ เอ้ย ค่ะ") ก็ไม่ยุบ: คำแก้อาจบอกล่วงหน้าถึง
//   ค่าที่ตามมาบรรทัดถัดไป ("ได้ครับ เอ้ย\nไม่ได้ค่ะ") ถ้าตัดทิ้งจะเหลือสองค่าที่ขัดกันโดยไม่มีคำแก้คั่น
// ประโยคที่ไม่มีเนื้อหาเลย ("ครับ เอ้ย ค่ะ") ก็ไม่ยุบ ด้วยเหตุผลเดียวกัน: คำแก้อาจแก้ประโยคก่อนหน้า

const FILLER = `[ \\t\\u00A0.…,，!~\\-–—${EMOJI_CHARS}]`;
const MARKER_END = `(?=${FILLER}|\\n|$)`;
// แก้ชัด: เอ้ย/อุ๊ย/ขอโทษ…พิมพ์ผิด/ขอแก้เป็น · กำกวม: เอ่อ (ลังเล) / ขอโทษ (ขอโทษจริง) — กฎเดียวกันหมด
// เพราะเนื้อหาสองฝั่งเท่ากันพิสูจน์เองแล้วว่าเป็นคำแก้คำลงท้าย ไม่ใช่คำขอโทษจริง ("ขอโทษค่ะ ที่ตอบช้า" ไม่เคยเท่ากับประโยคก่อน)
const MARKER = `(?:(?:เอ้ย|เอ๊ย|อุ๊ย|อุ้ย)(?:ค่ะ|คะ|นะคะ)?|ขอโทษ(?:ค่ะ|คะ|นะคะ)?[ \\t]*(?:ที่)?พิมพ์ผิด(?:ค่ะ|คะ|นะคะ)?|เอ่อ(?:ค่ะ|คะ)?|ขอโทษ(?:ค่ะ|คะ|นะคะ)?)${MARKER_END}|ขอแก้เป็น`;
const SLIP_PARTICLE = `(?:นะ)?${MALE_PARTICLE}`;
// คำแก้ไม่บังคับ: "ยินดีครับ... ยินดีค่ะ 😊" (พิมพ์ซ้ำโดยไม่มี เอ่อ/เอ้ย) เคยส่ง "ยินดีค่ะ... ยินดีค่ะ" ซ้ำแบบหุ่นยนต์
// ไม่มีคำแก้ = ต้องมีหางในบรรทัดเดียวกันที่ลงท้ายผู้หญิง (ดู planCollapse) และเนื้อหาเท่ากันทุกตัวเหมือนเดิม
// (รีวิวปรปักษ์รอบ 3 5 ต.ค.)
const SELF_CORRECTION = new RegExp(`(?<particle>${SLIP_PARTICLE})${FILLER}*(?:(?<marker>${MARKER})${FILLER}*)?`, "gu");
const TAIL_SENTENCE = new RegExp(`^(.*?)(นะคะ|ค่ะ|คะ|ค่า|นะครับ|ครับ${KHRAP_STRETCH})(?=$|[\\s.!?？…~,，)${EMOJI_CHARS}])`, "u");
const FEMALE_TAIL = /^(?:นะคะ|ค่ะ|คะ)$/u;
const MAX_COLLAPSES = 20;

// ตัวเทียบเนื้อหา: ตัดคำลงท้ายทุกเพศ คำเสริม วรรค เครื่องหมาย emoji แล้ว NFC — ไม่ตัด ไม่/ยังไม่ ตัวเลข ชื่อธนาคาร
// วันเวลา คำว่าฟรี จึงแก้ค่าไหนก็ตาม ("4,900 อุ๊ย 5,900" "ไม่ต้อง… เอ้ย ต้อง…") สองฝั่งไม่มีทางเท่ากัน
// คะ/ค่า/คับ ตัดเฉพาะตอนไม่มีตัวอักษรต่อ (คะแนน ค่าเรียน คับแคบ ไม่ใช่คำลงท้าย)
const KEY_PARTICLES = new RegExp(`นะคะ|นะครับ|${KHRAP_FORMS}|ค่ะ|จ้ะ|จ้า|ฮะ|(?:คะ|ค่า|คับ)(?![\\p{L}\\p{M}])|นะ`, "gu");
const KEY_FILLERS = /เลย|มาก|ด้วย|ลูกแพร/gu;
const KEY_NOISE = new RegExp(`[\\s\\p{P}\\p{S}${EMOJI_CHARS}]+`, "gu");
const contentKey = (value) => value.normalize("NFC").replace(KEY_PARTICLES, "").replace(KEY_FILLERS, "").replace(KEY_NOISE, "");

// หางที่ไม่มีคำลงท้าย ("ยินดีครับ เอ้ย ยินดี 😊"): ใส่คำลงท้ายเดิมหน้า emoji/จุดท้าย ขั้นสลับคำแก้เป็น ค่ะ/คะ ต่อเอง
function tailWithParticle(rest, particle) {
  const decor = rest.match(TRAILING_DECOR)?.[0] ?? "";
  return rest.slice(0, rest.length - decor.length) + particle + decor;
}

// ไม่มีคำแก้ = ต้องมั่นใจว่าเป็นคำลงท้ายจริง: ฮะ/คับ/คร้าบ/ค้าบ ใช้เกณฑ์เดียวกับขั้นสลับ (จบประโยค ไม่ใช่เสียงหัวเราะ/ส่วนของคำ)
// ไม่งั้น "ขอบคุณฮะฮะขอบคุณค่ะ" (หัวเราะ) ได้ "ฮะขอบคุณค่ะ" และ "ห้องคับห้องค่ะ" (คับ = แคบ) ได้ "ห้องค่ะ" เนื้อหาหาย
// (รีวิวปรปักษ์รอบ 3 5 ต.ค. — ช่องนี้เปิดขึ้นตอนให้คำแก้ไม่บังคับ แบบที่มีคำแก้ไม่เคยเจอเพราะ ฮะ ต้องติดคำแก้)
function slipEndsSentence(text, match) {
  const { particle } = match.groups;
  const naLength = particle.startsWith("นะ") ? "นะ".length : 0;
  const core = particle.slice(naLength).replace(/ผม$/u, "");
  return isSentenceEndParticle(particleFamily(core), text, match.index + naLength, match.index + particle.length, false);
}

// แผนยุบหนึ่งจุด: คืน { start, end, replacement } หรือ null (ไม่ยุบ ให้ขั้นสลับคำทำงาน)
function planCollapse(text, match) {
  if (!match.groups.marker && !slipEndsSentence(text, match)) return null;
  const particleAt = match.index;
  const markerEnd = match.index + match[0].length;
  const lineStart = lineStartOf(text, particleAt);
  const lineEndRaw = text.indexOf("\n", markerEnd);
  const lineEnd = lineEndRaw < 0 ? text.length : lineEndRaw;
  const sentenceAt = lineStart + sentenceStartIn(text.slice(lineStart, particleAt));
  const clause = text.slice(sentenceAt, particleAt);
  const clauseKey = contentKey(clause);
  if (!clauseKey) return null;
  const rest = text.slice(markerEnd, lineEnd);
  const tail = rest.match(TAIL_SENTENCE);
  if (!match.groups.marker && (!tail || !FEMALE_TAIL.test(tail[2]))) return null;
  if (clauseKey !== contentKey(tail ? tail[1] : rest)) return null;
  // เริ่มลบหลัง emoji/หัวข้อที่นำหน้าประโยค — ของเดิมลบติดไปด้วย ("ได้ค่ะ 😊 ยินดีครับ เอ่อ ยินดีค่ะ" → "ได้ค่ะ ยินดีค่ะ")
  // ยุบแบบไม่มีคำแก้ทำให้เจอบ่อยขึ้น (รีวิวปรปักษ์รอบ 3 5 ต.ค.)
  const start = sentenceAt + (clause.length - clause.replace(LEADING_DECOR, "").length);
  if (tail) return { start, end: markerEnd + tail[0].length, replacement: tail[0] };
  return { start, end: lineEnd, replacement: tailWithParticle(rest, match.groups.particle) };
}

// ช่วงห้ามแตะต้องอยู่ "ทั้งก้อน" ในส่วนที่ยุบ และยังอยู่ในข้อความใหม่ — ไม่งั้นไม่ยุบ (ปล่อยให้ขั้นสลับคำทำงาน)
function collapseKeepsProtected(text, ranges, plan) {
  return ranges.every(([from, to]) => {
    if (to <= plan.start || from >= plan.end) return true;
    return from >= plan.start && to <= plan.end && plan.replacement.includes(text.slice(from, to));
  });
}

function collapseSelfCorrections(input, protect, fixes) {
  let text = input;
  for (let round = 0; round < MAX_COLLAPSES; round += 1) {
    const ranges = protectedRanges(text, protect);
    let applied = false;
    for (const match of text.matchAll(SELF_CORRECTION)) {
      const plan = planCollapse(text, match);
      if (!plan || !collapseKeepsProtected(text, ranges, plan)) continue;
      fixes.push({ kind: "self_correction", from: text.slice(plan.start, plan.end), to: plan.replacement });
      text = text.slice(0, plan.start) + plan.replacement + text.slice(plan.end);
      applied = true;
      break;
    }
    if (!applied) return text;
  }
  return text;
}

/* --------------------------- (2)–(8) สลับคำลงท้าย --------------------------- */

// ยาวก่อนสั้นในแต่ละกลุ่ม: นะครับผม → นะครับ → ครับผม → ครับ
const MALE_TOKEN = new RegExp(`(นะ)?(${KHRAP_FORMS}|ฮะ|คับ)(ผม)?([ \\t]*[?？])?`, "gu");
// "ชนะ" "สถานะ" "ฐานะ" "ทัศนะ" ลงท้ายด้วย นะ ที่เป็นส่วนของคำ ไม่ใช่คำลงท้าย
const NA_IN_WORD = /(?:ช|ฐา|สถา|ทัศ)$/u;
const LAUGH_BEFORE = /(?:ฮะ|ฮ่า|ฮา|ๆ)$/u;
const LAUGH_AFTER = /^(?:ฮะ|ฮ่า|ฮา|ๆ)/u;
// "คับ" เป็นส่วนของคำ: บังคับ ประคับประคอง (คับแคบ/คับคั่ง/คับข้องใจ/คับขัน ตกที่ END_AHEAD อยู่แล้ว)
const KHAP_IN_WORD = /(?:บัง|ประ)$/u;
// ต้องติดกันจริงเท่านั้น และไม่นับ "ค่า" — "ได้ครับ ค่าเรียน 4,900" ห้ามโดนลบคำลงท้ายทิ้ง
const FEMALE_BEFORE = /(?:ค่ะ|คะ)$/u;
const FEMALE_AFTER = new RegExp(`^(?:ค่ะ|คะ|นะคะ)(?=$|[\\s.!?？…~,，)${EMOJI_CHARS}])`, "u");

function particleFamily(particle) {
  if (particle.startsWith("ครับ")) return "khrap";
  if (particle === "ฮะ") return "ha";
  if (particle === "คับ") return "khap";
  return "khrap_variant";
}

// คำลงท้ายกำกวม (คร้าบ/ค้าบ/ฮะ/คับ) แก้เฉพาะตอนจบประโยค และไม่ใช่ส่วนของคำ/เสียงหัวเราะ
function isSentenceEndParticle(family, full, particleAt, afterAt, hasQuestionMark) {
  if (family === "khrap") return true;
  if (!hasQuestionMark && !END_AHEAD.test(full.slice(afterAt, afterAt + 2))) return false;
  const before = full.slice(lineStartOf(full, particleAt), particleAt);
  if (family === "ha") return !LAUGH_BEFORE.test(before) && !LAUGH_AFTER.test(full.slice(afterAt));
  if (family === "khap") return !KHAP_IN_WORD.test(before);
  return true;
}

function fixKindFor({ family, naParticle, phom, question }) {
  if (naParticle) return "na_khrap";
  if (family !== "khrap") return family;
  if (phom) return "khrap_phom";
  return question ? "khrap_question" : "khrap";
}

function swapMaleParticles(text, protect, fixes) {
  const ranges = protectedRanges(text, protect);
  return text.replace(MALE_TOKEN, (match, na = "", particle, phom = "", qmark = "", offset, full) => {
    if (overlaps(ranges, offset, offset + match.length)) return match;
    const family = particleFamily(particle);
    const particleAt = offset + na.length;
    const afterAt = particleAt + particle.length + phom.length;
    if (!isSentenceEndParticle(family, full, particleAt, afterAt, Boolean(qmark))) return match;
    const lineStart = lineStartOf(full, offset);
    const naInWord = Boolean(na) && NA_IN_WORD.test(full.slice(lineStart, offset));
    const naParticle = Boolean(na) && !naInWord;
    const mark = qmark.trim();
    let to;
    let kind;
    if (!naParticle && (FEMALE_BEFORE.test(full.slice(lineStart, particleAt)) || FEMALE_AFTER.test(full.slice(afterAt)))) {
      // "ได้ครับค่ะ" / "ได้ค่ะครับ" — มีคำลงท้ายผู้หญิงติดกันอยู่แล้ว ลบตัวผู้ชายทิ้ง ห้ามได้ "ค่ะค่ะ"
      to = (naInWord ? na : "") + mark;
      kind = "double_particle";
    } else if (naParticle) {
      to = `นะคะ${mark}`;
      kind = fixKindFor({ family, naParticle });
    } else {
      const sentence = full.slice(lineStart, particleAt);
      const question = Boolean(mark) || isQuestionSentence(sentence.slice(sentenceStartIn(sentence)));
      to = `${naInWord ? na : ""}${question ? "คะ" : "ค่ะ"}${mark}`;
      kind = fixKindFor({ family, naParticle, phom, question });
    }
    fixes.push({ kind, from: match, to });
    return to;
  });
}

/* ----------------------- (9) "ผม" แทนตัวเอง — แจ้งอย่างเดียว ----------------------- */

const HAIR_BEFORE = /(?:ตัด|ทำ|ทรง|สระ|ย้อม|ดัด|เส้น|ช่าง|ยืด|โกรก|บำรุง|หวี|เป่า|ต่อ|ปลูก|ซาลอน|แชมพู|สี|ร้าน)\s?$/u;
const HAIR_AFTER = /^(?:ร่วง|ยาว|สั้น|หงอก|บาง|หนา|แห้ง|เสีย|มัน|ดำ|สวย|นุ่ม|หยิก|ฟู|เปีย|ทรง)/u;
const SELF_BEFORE = /(?:ของ|กับ|ทาง|ให้|ถึง|แก่|หา|ตัว|ที่)\s?$/u;
const SELF_AFTER = /^(?:ขอ|จะ|ช่วย|แนะนำ|เข้าใจ|ยินดี|คิด|ว่า|เอง|ได้|ส่ง|เช็ค|เช็ก|ไม่|ก็|เป็น|อยาก|ชื่อ|ทราบ|รับ|ดู|แจ้ง|มี|เคย|ยัง|ต้อง|พร้อม|รู้|ดูแล|นะ|เลย|อยู่|สอน|ทำงาน|ตอบ|คือ)/u;
const PRONOUN_START = /(?:^|[\s(“"'‘.!?？…,]|ค่ะ|คะ|นะคะ)$/u;
const SAMPLE_CHARS = 10;

function findMalePronouns(text, ranges) {
  const found = [];
  for (const match of text.matchAll(/ผม/gu)) {
    const at = match.index;
    if (overlaps(ranges, at, at + 2)) continue;
    const before = text.slice(Math.max(0, at - 12), at);
    const after = text.slice(at + 2, at + 16);
    if (HAIR_BEFORE.test(before) || HAIR_AFTER.test(after)) continue;
    const startOfClause = at === 0 || PRONOUN_START.test(before);
    if (SELF_BEFORE.test(before) || (startOfClause && SELF_AFTER.test(after))) {
      found.push({ kind: "male_pronoun", sample: text.slice(at, at + SAMPLE_CHARS).split(/\s/u)[0] });
    }
  }
  return found;
}

const PROTECTED_KHRAP = new RegExp(KHRAP_FORMS, "gu");

function protectedParticles(text, ranges) {
  const found = [];
  for (const [from, to] of ranges) {
    for (const match of text.slice(from, to).matchAll(PROTECTED_KHRAP)) {
      found.push({ kind: "protected_particle", sample: match[0] });
    }
  }
  return found;
}

/* ---------------------------------- ทางเข้า ---------------------------------- */

/**
 * เปลี่ยนคำลงท้ายผู้ชายเป็นผู้หญิงตามชนิดประโยค (deterministic ไม่เรียกโมเดล)
 * ห้ามแตะ: URL, [IMAGE:…], [approved-url:…], {{slot}}, และข้อความใน protect (ชื่อลูกค้า ป้ายรีวิว)
 * @param {string} text
 * @param {{ protect?: string[] }} [options]
 * @returns {{ text: string, changed: boolean, fixes: Array<{kind: string, from: string, to: string}>,
 *   residual: Array<{kind: string, sample: string}> }}
 */
export function enforceFemaleParticles(text, { protect = [] } = {}) {
  const original = String(text ?? "");
  const fixes = [];
  const collapsed = collapseSelfCorrections(original, protect, fixes);
  const swapped = swapMaleParticles(collapsed, protect, fixes);
  const ranges = protectedRanges(swapped, protect);
  const residual = [...findMalePronouns(swapped, ranges), ...protectedParticles(swapped, ranges)];
  // ด่านสุดท้าย: ห้ามทำข้อความที่มีเนื้อหาให้ว่าง (ลูกค้าเจอความเงียบแย่กว่าคำลงท้ายผิด)
  if (!swapped.trim() && original.trim()) {
    return { text: original, changed: false, fixes: [], residual: [...residual, { kind: "empty_guard", sample: "" }] };
  }
  return { text: swapped, changed: swapped !== original, fixes, residual };
}

/** มีคำลงท้ายผู้ชายที่ด่านจะแก้หรือไม่ (นอกช่วงห้ามแตะ) — ใช้ตรวจแม่แบบข้อความระบบ */
export function hasMaleParticle(text, { protect = [] } = {}) {
  return enforceFemaleParticles(text, { protect }).fixes.length > 0;
}
