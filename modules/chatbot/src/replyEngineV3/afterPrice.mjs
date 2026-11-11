// afterPrice.mjs — ข้อเท็จจริงของห้องที่ v3 ใช้ไม่ให้ถอยหลังหลังแจ้งราคา/ส่งรอบ (เครื่องเดิมไม่ได้ใช้ไฟล์นี้)
// รีวิวเคสจริงทั้งวัน 5 ต.ค.: ห้องร้อนตอบระดับเป็นช่วงแล้วโดนถามทำความรู้จักติดกันสี่ข้อ · การ์ดราคาโชว์สองคลาสทั้งที่ลูกแพรแนะนำคลาสเดียว
// · ถามวันที่ที่เป็นรอบของอีกคลาสแล้วได้ข้อเสนอดูหัวข้อ · หลังราคาตอบสั้นกำกวมแล้วโดนถามเรื่องงานซ้ำ
import { isClosingQuestion } from "../handoffClosing.mjs";
import { explicitCalendarDates } from "../followupTiming.mjs";
import { detectRoundInterest } from "../salesMotion.mjs";
import { roundShortThai, roundWeekdayThai } from "../openRounds.mjs";
import { CLASS_NAMES } from "./priceFacts.mjs";

// รอบรีวิว 8 (ตรวจความเร็ว): ช่องว่างหน้าเลขเฉพาะในบรรทัดเดียวกัน — "\s*" กับขึ้นบรรทัดยาว ๆ ช้าแบบยกกำลังสอง (ผลจริง/เท็จเหมือนเดิมทุกข้อความ)
const KEYCAP_LINE = /^[^\S\n]*[1-5]️?⃣/mu;
const ADMIN_PREFIX = "[แอดมินทีมงานพิมพ์เอง]";
const isAdmin = (text) => String(text || "").startsWith(ADMIN_PREFIX);

/** ก้อนข้อความของลูกแพร (บอลลูนติดกันรวมเป็นก้อน) ใหม่สุดก่อน */
export function botBurstsNewestFirst(history = []) {
  const turns = Array.isArray(history) ? history : [];
  const out = [];
  let i = turns.length - 1;
  while (i >= 0) {
    if (turns[i]?.role !== "assistant") { i -= 1; continue; }
    const parts = [];
    let admin = false;
    while (i >= 0 && turns[i]?.role === "assistant") {
      if (isAdmin(turns[i].content)) admin = true;
      parts.unshift(String(turns[i].content || ""));
      i -= 1;
    }
    out.push({ text: parts.join("\n"), admin });
  }
  return out;
}

// ---- ระดับแบบช่วงใต้บันได ("2-3" · "2 หรือ 3") — ตัวอ่านระดับของเครื่องเดิมไม่รับช่วง ระดับเลยว่างทั้งห้อง ----
// ขึ้นต้นข้อความ (ตามด้วยคำอธิบายได้ เช่น "1-4 ค่ะ ยังไม่เคยทำ automation") และก้อนก่อนหน้าของลูกแพรต้องมีบันได
// — ช่วงที่ตามด้วยหน่วยนับ ("2-3 คน" / "2-3 ชั่วโมง" / "1-2 ปี") ไม่ใช่ระดับ
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): "2-3 สัปดาห์ / 2-3 บริษัท / 3-4 hr" เคยถูกอ่านเป็นระดับ · "สองถึงสาม" (เขียนเป็นคำ) อ่านไม่ออก
const LEVEL_WORD = "(?:[1-5]|หนึ่ง|สอง|สาม|สี่|ห้า)";
const LEVEL_WORD_VALUE = Object.freeze({ หนึ่ง: 1, สอง: 2, สาม: 3, สี่: 4, ห้า: 5 });
const LEVEL_RANGE = new RegExp(`^\\s*(?:(?:ข้อ|ระดับ|เลข)\\s*)?(${LEVEL_WORD})\\s*(?:-|–|—|~|,|\\/|หรือ|ถึง|กับ|และ|&)\\s*(?:(?:ข้อ|ระดับ)\\s*)?(${LEVEL_WORD})(?![\\d.:,])`
  + "(?!\\s*(?:คน|ท่าน|วัน|ชั่วโมง|ชม|โมง|นาที|เดือน|ปี|ครั้ง|รอบ|บาท|พัน|หมื่น|k|%|อย่าง|ตัว|อัน|ชิ้น|เรื่อง|งาน|สัปดาห์|อาทิตย์|week|บริษัท|ร้าน|สาขา|แห่ง|ที่|hrs?|hours?|นาที|min|ปี|คอร์ส|คลาส))", "iu");
const levelValue = (raw) => LEVEL_WORD_VALUE[raw] ?? Number(raw);
function rangeLevelOf(text = "", botBefore = "") {
  if (!KEYCAP_LINE.test(String(botBefore || ""))) return null;
  const match = LEVEL_RANGE.exec(String(text || "").trim());
  if (!match) return null;
  const [lo, hi] = [levelValue(match[1]), levelValue(match[2])].sort((a, b) => a - b);
  if (lo === hi) return null;
  return { lo, hi, product: hi <= 4 ? "ai_agent_for_business" : lo >= 5 ? "workflow_automation_or_higher" : null };
}

// รีวิวเคสจริง 6–7 ต.ค.: ตอบใต้บันไดว่า "stage 3 ค่ะ" / "Stage4 ไม่เคยเขียนโค้ด" ตัวอ่านระดับของเครื่องเดิมไม่รับ — ระดับว่าง การ์ดราคาโชว์สองคลาส
// แล้วปิดด้วยคำถามคัดกรองหลังราคา · คำว่า stage/level/สเตจ/เลเวล + เลข 1–5 ขึ้นต้นข้อความ หลังก้อนที่มีบันได = ระดับนั้น (ช่วงเท่ากัน)
// รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8 U6): ตอบเลขข้อแล้วเล่าต่อในข้อความเดียว ("2 ค่ะ ขายเสื้อผ้าใน IG อยากให้ช่วยตอบแชท") ตัวอ่านเดิมไม่รับ
// พอถามค่าเรียนเลยโดนถามระดับซ้ำ — เลข 1–5 ขึ้นต้นข้อความ (มี/ไม่มีคำว่า ข้อ/ระดับ) หลังบันได = ระดับนั้น
// (เลขที่ตามด้วยหน่วย/วันที่/ช่วง เช่น "3 คน" · "1 วัน" · "2 ต.ค." · "1-2 ชั่วโมง" ไม่ใช่ระดับ · ตัวอ่านของเครื่องเดิมไม่ถูกแตะ)
const STAGE_WORD_LEVEL = new RegExp("^\\s*(?:(?:stage|level|lv\\.?|สเตจ|เลเวล|ข้อ|ระดับ|เลข)\\s?)?([1-5])(?![\\d.:,/])"
  + "(?!\\s*(?:คน|ท่าน|วัน|ชั่วโมง|ชม|โมง|นาที|เดือน|ปี|ครั้ง|รอบ|บาท|พัน|หมื่น|k\\b|%|อย่าง|ตัว|อัน|ชิ้น|เรื่อง|สัปดาห์|อาทิตย์|week|บริษัท|ร้าน|สาขา|แห่ง|ที่|hrs?\\b|hours?\\b|min\\b|คอร์ส|คลาส"
  + "|ต\\.?\\s?ค|พ\\.?\\s?ย|ธ\\.?\\s?ค|ตุลา|พฤศจิ|ธันวา|[-–—~]|(?:หรือ|ถึง|กับ|และ|&)\\s?(?:\\d|หนึ่ง|สอง|สาม|สี่|ห้า)))", "iu");
// รอบรีวิว 8: ตอบ "Stage4 …" ใต้คำถามคัดกรองเรื่องการใช้ AI (ไม่ใช่ใต้บันไดตรง ๆ — บันไดอยู่ก้อนก่อนหน้า) ก็เป็นระดับ — ต้องมีคำว่า stage/ระดับ/ข้อ นำหน้า
// (เลขเปล่า ๆ นับเฉพาะใต้บันได)
const LEVEL_WORD_LEAD = /^\s*(?:stage|level|lv|สเตจ|เลเวล|ข้อ|ระดับ|เลข)/iu;
function stageWordLevelOf(text = "", botBefore = "") {
  const bot = String(botBefore || "");
  const ladder = KEYCAP_LINE.test(bot);
  if (!ladder && !(LEVEL_ASKED.test(bot) && LEVEL_WORD_LEAD.test(String(text || "")))) return null;
  const match = STAGE_WORD_LEVEL.exec(String(text || ""));
  if (!match) return null;
  const level = Number(match[1]);
  return { lo: level, hi: level, product: level <= 4 ? "ai_agent_for_business" : "workflow_automation_or_higher" };
}

/** ช่วงระดับล่าสุดที่ลูกค้าตอบใต้บันได (ทั้ง session + เทิร์นนี้) · null = ไม่มี */
export function historyRangeLevel(history = [], text = "") {
  const turns = [...(Array.isArray(history) ? history : []), { role: "user", content: String(text) }];
  let found = null;
  let bot = "";
  for (const turn of turns) {
    if (turn?.role === "assistant") { bot = bot ? `${bot}\n${turn.content}` : String(turn.content || ""); continue; }
    const hit = rangeLevelOf(turn?.content, bot) || stageWordLevelOf(turn?.content, bot);
    if (hit) found = hit;
    bot = "";
  }
  return found;
}

// ---- คลาสที่ลูกแพรแนะนำไปแล้ว (ยังไม่รู้ระดับ) — นับเฉพาะรูปคำแนะนำ ("คลาส X …" / "แนะนำ X" / "X เหมาะ/ตรงกว่า/เริ่มจาก…") ----
// ชื่อคลาสบนการ์ดราคา ในคำถามคัดกรอง ในบรรทัดบอกรอบ หรือในคำอธิบายโปสเตอร์ที่ลูกค้าส่งมา (ยังไม่รู้ระดับ) ไม่ใช่คำแนะนำ
const CLASS_NAME = { business: "AI Agent for Business", workflow: "(?:AI Agent )?Workflow Automation" };
const recommends = (name) => new RegExp(`(?:คลาส|คอร์ส|แนะนำ(?:ให้เริ่ม(?:จาก|ที่)?)?|เริ่ม(?:จาก|ที่))\\s*(?:คลาส\\s*)?${name}`
  + `|${name}\\s*(?:ค่ะ|คะ)?\\s*(?:เหมาะ|ตรงกว่า|ตรงกับ|เป็นคลาส|คลาส(?:พื้นฐาน|ต่อยอด)|เริ่มจาก|เริ่มได้|จะช่วย|จะได้|ได้ฝึก|ได้ลงมือ)`, "iu");
const CLASS_RECOMMENDED = [["business", recommends(CLASS_NAME.business)], ["workflow", recommends(CLASS_NAME.workflow)]];
const PRICE_CARD_LINE = /📌|ราคาปกติ|โปรโมชั่น|early ?bird|ลดเหลือ|\d{1,3},\d{3}/iu;
const CLASS_HELP_ASK = /เคย(?:สร้าง|วาง|ทำ|ใช้)[^\n?？]{0,60}Workflow Automation[^\n?？]{0,30}(?:หรือยัง|แล้ว|ไหม|มั้ย)/giu;
function classesRecommended(text = "") {
  const kept = String(text).split("\n").filter((line) => !PRICE_CARD_LINE.test(line)).join("\n").replace(CLASS_HELP_ASK, " ");
  return CLASS_RECOMMENDED.filter(([, re]) => re.test(kept)).map(([key]) => key);
}
/** คลาสเดียวที่ลูกแพรแนะนำในก้อนล่าสุดที่มีคำแนะนำ · แนะนำ/เล่าสองคลาสในก้อนเดียว = ยังเปิดอยู่ (null) */
export function recommendedClassOf(history = []) {
  for (const burst of botBurstsNewestFirst(history)) {
    const keys = classesRecommended(burst.text);
    if (keys.length === 1) return keys[0];
    if (keys.length > 1) return null;
  }
  return null;
}

// ลูกค้าขอดูทั้งสองคลาส/เทียบกัน = การ์ดราคาสองคลาส
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): "แล้วอีกคลาสราคาเท่าไหร่" หลังลูกแพรแนะนำคลาสเดียว เคยได้การ์ดคลาสเดิมซ้ำ
export const BOTH_CLASSES_ASK = /ทั้ง\s*(?:2|สอง)\s*(?:คอร์ส|คลาส)|(?:2|สอง)\s*(?:คอร์ส|คลาส)|ทุก\s*(?:คอร์ส|คลาส)|(?:คอร์ส|คลาส|ตัว|อัน)\s*(?:อื่น|ไหนบ้าง|อะไรบ้าง)|อีก\s*(?:คอร์ส|คลาส|ตัว|อัน)|(?:คอร์ส|คลาส)\s*ถัดไป|มีกี่\s*(?:คอร์ส|คลาส)|เทียบ|ต่างกัน/u;
// ลูกค้าเอ่ยชื่อคลาสเองแบบชัด ๆ เท่านั้น — "business plan" / "อยากทำ automation" ของลูกค้าไม่ใช่การเลือกคลาส
const TEXT_CLASS = [
  ["business", /(?:คลาส|คอร์ส)\s*(?:ai\s*agent\s*(?:for\s*)?)?business|ai\s*agent\s*for\s*business|คลาสพื้นฐาน/iu],
  // รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): "คลาส advance" · "อันที่สอนทำระบบอัตโนมัติ" · "ตัว automation" = เอ่ยถึงคลาสต่อยอด (ไม่ใช่โจทย์งานของลูกค้า)
  // รีวิวเคสจริง 6–7 ต.ค.: "คลาส Make" / "คอร์ส n8n" = คลาสต่อยอด (เครื่องมือที่สอนในคลาส Workflow)
  ["workflow", /(?:คลาส|คอร์ส)\s*(?:ai\s*agent\s*)?(?:workflow|automation)|ai\s*agent\s*workflow|workflow\s*automation|คลาสต่อยอด|คอร์สต่อยอด|(?:คลาส|คอร์ส)\s*(?:advanced?|แอดวานซ์|ขั้นสูง)|(?:อัน|ตัว|คลาส|คอร์ส)ที่สอน\S{0,8}?(?:ระบบ)?อัตโนมัติ|ตัว\s*(?:workflow|automation)|(?:คลาส|คอร์ส)\s*(?:make(?:\.com)?|n8n)\b/iu],
];

// ---- คลาสที่ลูกค้าบอกเองว่าอยากเรียน (รีวิวเคสจริง 6–7 ต.ค.) ----
// ลูกค้าตอบระดับ 4 แล้วบอกในก้อนเดียวกันว่า "อยากลงคลาส Advance (Make Automation)" — ระดับชนะ เลยได้การ์ดราคา รอบ และดีลคู่ของคลาสพื้นฐาน
// รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8 U3/C2): ตัวอ่านเดิมนับ "สนใจ automation" / "สนใจ makeup" / "เพื่อนอยากเรียน advance" / "จะเรียน advance เลยได้ไหม"
// / "อยากได้ตัว automation ตอบแชท" เป็นคำเลือกคลาส มือใหม่ระดับ 2 เลยได้การ์ด Workflow 15,900 + รอบ 24/31 — ตอนนี้นับเฉพาะ:
//   คำกริยาของลูกค้าเอง (ลง/สมัคร/เรียน/เอา) + ชื่อคลาส/คำเรียกคลาส ติดกัน · ไม่ใช่ประโยคคำถาม/เงื่อนไข · ไม่มีคำปฏิเสธนำหน้า · ไม่ใช่ของคนอื่น
//   · คำละตินต้องเป็นคำเต็ม (make ≠ makeup)
const WISH_TERMS = Object.freeze({
  workflow: "(?:advanced?\\b|แอดวานซ์|ขั้นสูง|\\bmake(?:\\.com)?\\b|\\bn8n\\b|\\bworkflow\\b|\\bautomation\\b|ออโตเมชั่?น|ต่อยอด)",
  business: "(?:(?:ai\\s?agent\\s?)?for\\s?business\\b|\\bbusiness\\b|บิสสิเนส|พื้นฐาน)",
});
const WISH_VERB = "(?:อยาก|ขอ|จะ|ต้องการ|ตั้งใจ)?\\s?(?:จะ)?\\s?(?:ลง|สมัคร|เรียน|เอา)(?:เรียน)?\\s?(?:คลาส|คอร์ส|ตัว|รุ่น)?\\s?(?:ai\\s?agent\\s?)?";
const wishRe = (term) => new RegExp(`${WISH_VERB}${term}`, "giu");
const CLASS_WISH = Object.freeze([["workflow", wishRe(WISH_TERMS.workflow)], ["business", wishRe(WISH_TERMS.business)]]);
// ท่อนประโยค: ขึ้นบรรทัด · หลังคำลงท้าย · "แต่" · เครื่องหมาย — คำถามในท่อนอื่น ("อยากลงคลาส Advance ครับ ราคาเท่าไหร่") ไม่ทำให้คำบอกนี้หาย
const WISH_CLAUSE_SPLIT = /\n|(?<=ค่ะ|คะ|ครับ|คับ|นะ|จ้า)[^\S\n]+|แต่|[,;!?？]/u;
// คำถามเรื่องราคาในท่อนเดียวกัน ("อยากลงคลาส Advance ราคาเท่าไหร่ครับ") ไม่ทำให้คำบอกหาย — คำถามที่ถามว่าเรียนได้ไหม/ต้องมีอะไร/ถ้า… ถึงไม่นับ
const WISH_QUESTION = /ไหม|มั้ย|มั๊ย|ป่าว|หรือเปล่า|รึเปล่า|หรือยัง|ยังไง|อย่างไร|อะไร|ไหน|เมื่อไหร่|ได้หรือ|(?:^|\s)(?:ถ้า|หาก)|^(?:ถ้า|หาก)/u;
const WISH_NEGATED = /(?:ไม่|ยังไม่|มิ)(?:ได้|ค่อย)?\s?(?:อยาก|จะ|ค่อย|คิด(?:จะ)?|ต้องการ)?\s?$/u;
const WISH_OTHER_PERSON = /(?:เพื่อน|แฟน|สามี|ภรรยา|ลูก(?!ค้า)|หัวหน้า|เจ้านาย|พนักงาน|ลูกน้อง|น้องที่|เขา|เค้า|คนอื่น|ทีม|ให้)\S{0,6}\s?$/u;
// "ต้องเรียน business ก่อน" / "ควรเรียน…" = ถามหรือเล่าเงื่อนไข ไม่ใช่บอกว่าอยากเรียน
const WISH_NOT_DESIRE = /(?:ต้อง|ควร|หรือ)\s?$/u;
function wishesIn(clause, re) {
  if (WISH_QUESTION.test(clause)) return false;
  for (const match of clause.matchAll(re)) {
    const before = clause.slice(0, match.index);
    if (!WISH_NEGATED.test(before) && !WISH_OTHER_PERSON.test(before) && !WISH_NOT_DESIRE.test(before)) return true;
  }
  return false;
}
// ท่อนที่ขึ้นต้นด้วย "หรือ" = ตัวเลือกของคำถามท่อนก่อน ("เรียน advance เลยได้ไหมครับ หรือต้องเรียน business ก่อน") — อ่านรวมกับท่อนก่อน
function joinOptionClauses(clauses) {
  const out = [];
  for (const clause of clauses) {
    if (out.length && /^หรือ/u.test(clause)) out[out.length - 1] += ` ${clause}`;
    else out.push(clause);
  }
  return out;
}
/** คลาสที่ข้อความนี้บอกว่าอยากเรียน (ทั้งสองคลาส/ไม่บอก = null) */
export function classWishIn(text = "") {
  // ช่องว่างยาวต่อกัน = ช่องเดียวก่อนตัดท่อน (ตัวตัดท่อนไล่ช่องว่างทุกตำแหน่ง — ข้อความช่องว่างยาว ๆ ช้าแบบยกกำลังสอง)
  const clauses = joinOptionClauses(String(text || "").replace(/[^\S\n]+/gu, " ").split(WISH_CLAUSE_SPLIT).map((part) => String(part || "").trim()).filter(Boolean));
  const keys = CLASS_WISH.filter(([, re]) => clauses.some((clause) => wishesIn(clause, re))).map(([key]) => key);
  return keys.length === 1 ? keys[0] : null;
}
/** คำบอกล่าสุดของลูกค้าว่าอยากเรียนคลาสไหน (ข้อความนี้ก่อน แล้วย้อนประวัติ) — null = ไม่เคยบอก */
export function classWishOf(history = [], text = "") {
  return classWishWithTurn(history, text)?.wish || null;
}
// ก้อนที่ถามระดับ (บันได/คำถามระดับการใช้ AI) — ข้อความลูกค้าที่ตามมาคือคำตอบระดับ
const LEVEL_ASKED = /^[^\S\n]*[1-5]️?⃣|ระดับที่เท่าไหร่|ใช้\s?AI\s?มา(?:ประมาณ|แค่ไหน)|เคยใช้\s?(?:AI|เอไอ)\S{0,12}(?:ไหม|มั้ย|หรือยัง|แค่ไหน)/imu;
/** { wish, levelAfter } — คำบอกล่าสุด (ข้อความนี้ก่อน) และมีคำตอบระดับใต้บันไดหลังคำบอกนั้นไหม (รอบรีวิว 8: ระดับที่ตอบทีหลังชนะ) */
export function classWishWithTurn(history = [], text = "") {
  const turns = [...(Array.isArray(history) ? history : []), { role: "user", content: String(text || "") }];
  let levelAfter = false;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i]?.role !== "user") continue;
    const value = String(turns[i].content || "");
    const wish = classWishIn(value);
    if (wish) return { wish, current: i === turns.length - 1, levelAfter };
    const before = [];
    for (let j = i - 1; j >= 0 && turns[j]?.role === "assistant"; j -= 1) before.unshift(String(turns[j].content || ""));
    if (LEVEL_ASKED.test(before.join("\n")) && !/[?？]/u.test(value)) levelAfter = true;
  }
  return null;
}
// รีวิวเคสจริง 6–7 ต.ค.: หลังราคาแต่ยังไม่รู้คลาส ลูกแพรถามว่าสนใจคลาสไหน หรือให้ช่วยเลือก — ลูกค้าขอให้ช่วยเลือกเอง = ถามข้อที่ใช้เลือกคลาสได้หนึ่งข้อ
// (เป็นคำถามคัดกรองที่ลูกค้าขอเอง ไม่ใช่การถอยกลับไปทำความรู้จัก)
// รอบรีวิว 8 (C8): "เพื่อนแนะนำให้มาเรียน" / "พี่ที่ออฟฟิศแนะนำคลาสนี้มา" คือเล่าว่ามีคนแนะนำ ไม่ใช่ขอให้ลูกแพรช่วยเลือก — ต้องเป็นคำขอ
export const HELP_CHOOSE_RE = /ช่วย(?:ลูกค้า|ผม|ฉัน|หนู|เรา|พี่)?\s?(?:เลือก|แนะนำ)|แนะนำ(?:คลาส|คอร์ส)?\s?(?:ให้)?\s?(?:หน่อย|ด้วย|ได้ไหม|ได้มั้ย|ที)|แนะนำ(?:คลาส|คอร์ส)ให้|(?:คลาส|คอร์ส|อัน|ตัว)\s?ไหน(?:ดี|เหมาะ)|เหมาะกับ(?:ผม|ฉัน|หนู|เรา|ตัวเอง|เค้า|เขา)|เลือก(?:ไม่ถูก|ไม่ได้|ยังไง)/u;
// เคยเรียนคลาสพื้นฐานแล้ว = อยากเรียน Workflow ได้ตรง ๆ (ห้องนักเรียนเก่า/ดีลสองคลาสเป็นของเครื่องเดิมอยู่แล้ว — กันไว้อีกชั้น)
export const BUSINESS_DONE_RE = /(?:เรียน|ผ่าน|จบ|ลง)(?:คลาส|คอร์ส)?\s?(?:พื้นฐาน|business|ai agent for business)\S{0,6}?(?:แล้ว|มาแล้ว|ไปแล้ว)|ศิษย์เก่า|นักเรียนเก่า/iu;
// ตัวจับใหม่ของรอบรีวิว 8 (เทสต์ความเร็วไล่ตรวจทุกตัว)
export const CLASS_WISH_PATTERNS = Object.freeze({ STAGE_WORD_LEVEL, LEVEL_WORD_LEAD, WISH_CLAUSE_SPLIT, WISH_QUESTION, WISH_NEGATED, WISH_OTHER_PERSON, WISH_NOT_DESIRE, LEVEL_ASKED,
  BUSINESS_DONE_RE, WISH_WORKFLOW: CLASS_WISH[0][1], WISH_BUSINESS: CLASS_WISH[1][1] });

// ลูกค้าพูดถึงคลาสแบบบรรยาย ("อันที่สอน…" / "คลาสต่อยอด" / "advance") แต่ระบบชี้คลาสเดียวไม่ได้ = อย่าตัดเหลือคลาสที่ลูกแพรแนะนำ
export const CLASS_DESCRIBED_RE = /อันที่|ตัวที่|คลาสที่|คอร์สที่|advance|แอดวานซ์|ขั้นสูง|ต่อยอด|อัตโนมัติ|automation|workflow|พื้นฐาน/iu;
export function classInText(text = "") {
  const keys = TEXT_CLASS.filter(([, re]) => re.test(String(text))).map(([key]) => key);
  return keys.length === 1 ? keys[0] : null;
}

// ---- เพดานคำถามทำความรู้จัก: ก้อนของลูกแพรที่ถามติดกัน (ใหม่สุดก่อน) จนกว่าจะเจอบันได / ชื่อคลาส / ราคา / ข้อความแอดมิน ----
const RESET_BURST = /AI Agent for Business|Workflow Automation|\d{1,3},\d{3}\s*บาท/u;
export const DISCOVERY_STREAK_CAP = 2;
const lastLettered = (text) => String(text).split(/\n+/u).map((line) => line.trim()).filter((line) => /\p{L}/u.test(line)).at(-1) || "";
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): คำถามยืนยัน/ขอให้ขยายความ ("อีเมลนี้ใช่ไหมคะ?" → "ใช่") ไม่ใช่คำถามทำความรู้จัก — เคยนับจนเชื่อมเข้าคลาส
// ข้อความทักตามแบบ "ยังสนใจเรื่อง AI อยู่ไหมคะ?" ก็เป็นคำถามเช็ก ไม่ใช่คำถามทำความรู้จัก
const CONFIRM_QUESTION = /ใช่(?:ไหม|มั้ย|มั๊ย)|หรือเปล่า|รึเปล่า|ช่วยขยาย|หมายถึง|ยังสนใจ[^\n?？]{0,24}?(?:ไหม|มั้ย|มั๊ย)/u;
const lastQuestionOf = (text) => String(text).split(/\n+/u).map((line) => line.trim()).filter((line) => /[?？]/u.test(line) || isClosingQuestion(line)).at(-1) || "";
export function discoveryStreakOf(history = []) {
  let streak = 0;
  for (const burst of botBurstsNewestFirst(history)) {
    if (burst.admin || KEYCAP_LINE.test(burst.text) || RESET_BURST.test(burst.text)) break;
    // ก้อนที่ไม่ถาม (บอลลูนที่ส่งไม่ครบ / คำทักทาย / ข้อความทักตามที่ไม่ถาม) ไม่นับและไม่ตัดสาย
    if (!(/[?？]/u.test(burst.text) || isClosingQuestion(lastLettered(burst.text)))) continue;
    if (CONFIRM_QUESTION.test(lastQuestionOf(burst.text) || lastLettered(burst.text))) continue;
    streak += 1;
  }
  return streak;
}

// ---- คนทำเล่นเพื่อความสนุกที่ตอบปฏิเสธสั้น ๆ (ไม่มีงานจะเอาไปใช้) — เพดานห้ามพาไปขายคลาส ----
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (ตรวจความเร็ว): ตัวนี้ทำงานทุกเทิร์นของ v3 — เดิม \s* สามตัวติดกันรอบท่อนที่ไม่บังคับ ช่องว่างยาว ๆ ค้างหลายวินาที
// ช่องว่างแต่ละช่วงต้องตามด้วยคำ (ผลเหมือนเดิม) และนับช่องว่างหลายตัวเป็นช่องเดียวก่อนตรวจ
const BARE_NEGATIVE = /^\s*(?:ไม่(?:มี|ได้|ค่อย)?|ยังไม่มี|no|nope)(?:\s*(?:เลย|อะ|อ่ะ))?(?:\s*(?:ค่ะ|คะ|ค่า|ครับ|คับ|ครับผม|จ้า|นะ))*(?:\s*[.!]+)?\s*$/iu;
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): "งานเอกสารไม่สนุกเลย" คือคนมีงานจริง ไม่ใช่คนทำเล่น
const HOBBY_RE = /(?<!ไม่)สนุก|เล่น\s*ๆ|เล่นเล่น|ทำเล่น|ขำ\s*ๆ|งานอดิเรก|ยามว่าง|แก้เบื่อ|ฆ่าเวลา/u;
// บอกเองในข้อความนี้ว่าไม่ได้ใช้ทำงาน/ยังไม่ทำงาน (นักศึกษา เกษียณ แม่บ้าน ใช้ส่วนตัว) — รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): เพดานคำถามพาไปขายคลาส
const NO_WORK_RE = /(?:ยัง)?ไม่ได้(?:ทำงาน|ใช้(?:ทำงาน|กับงาน))(?!ด้าน|ที่|เกี่ยว|สาย)|ว่างงาน|นักศึกษา|นักเรียน|เกษียณ|แม่บ้าน|พ่อบ้าน|ใช้ส่วนตัว|ใช้เล่น|ไม่ได้ทำธุรกิจ/u;
/** ข้อความนี้บอกว่าไม่มีงานจะใช้: ปฏิเสธสั้น ๆ หลังเล่าว่าใช้ AI ทำเล่น · หรือบอกเองว่าไม่ได้ใช้ทำงาน/ยังไม่ทำงาน */
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิวสอง): "เป็นแม่บ้าน แต่อยากเปิดร้านออนไลน์" เคยถูกพักไม่ให้เชื่อมเข้าคลาส — บอกเป้าหมายงาน/รายได้ในอนาคต = มีงานจะใช้
const FUTURE_WORK_RE = /อยาก(?:เปิด|เริ่ม|ทำ|มี|ลอง)\S{0,6}?(?:ร้าน|ธุรกิจ|กิจการ|ขาย|เพจ)|หา(?:งาน|รายได้)|รายได้เสริม|อาชีพเสริม|เอาไป(?:ใช้)?(?:ทำงาน|หางาน|ขาย|สมัครงาน)/u;
export function hobbyNoWorkOf(history = [], text = "") {
  if (FUTURE_WORK_RE.test(String(text || ""))) return false;
  if (NO_WORK_RE.test(String(text || ""))) return true;
  if (!BARE_NEGATIVE.test(String(text || "").replace(/\s+/gu, " "))) return false;
  const said = (Array.isArray(history) ? history : []).filter((turn) => turn?.role === "user").map((turn) => String(turn.content || ""));
  return said.some((value) => HOBBY_RE.test(value));
}

// ---- วันที่ลูกค้าถามว่ามีรอบไหม ----
// ไม่ใช่การถามรอบ: ยกเลิก/เลื่อน/ไม่ว่างวันนั้น · เรื่องเงิน/เอกสาร · เรื่องงานของลูกค้าเอง ("ส่งของวันที่ 24")
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): "เสาร์ 17 ติดธุระ มีรอบอื่นไหม" · "เสาร์ 10 ไปไม่ทัน มีรอบไหนอีก" เคยถูกอ่านว่าถามรอบวันที่นั้น (แล้วยืนยันว่ามี)
// — วันนั้นติด/ไปไม่ได้ = ไม่ได้ถามวันนั้น · ขอรอบอื่น = ถามรอบทั้งหมด · "17 ไม่สะดวก 24 ได้ไหม" = ถามวันที่ที่ตามหลังคำปฏิเสธ
// เรื่องเงิน/เอกสาร/งานของลูกค้าเอง/ยกเลิก-เลื่อนรอบที่สมัครแล้ว = ไม่ใช่การถามรอบเลย
const NOT_ROUND_TOPIC = /ยกเลิก|ขอเลื่อน|เลื่อนไป|คืนเงิน|ผ่อน|โอน|จ่าย|สลิป|ชำระ|ใบกำกับ|ใบเสร็จ|วันเกิด|เกิดวันที่|ส่งของ|รับของ|ส่งงาน|ลูกค้า|นัด(?!เรียน)|โทร|คุยรายละเอียด/u;
// วันนั้นติด/ไปไม่ได้/ขอเลื่อน = ไม่ได้ถามวันนั้น
const NEG_DATE = /ไม่สะดวก|ไม่ว่าง|ไม่ได้แล้ว|ติด(?:ธุระ|งาน|สอบ|ประชุม|เรียน|นัด|ภารกิจ|เคส|ลูก)|ไม่ทัน|ไปไม่ได้|ไปไม่|มาไม่ได้|มาไม่|(?<!ได้)ไม่ได้(?=\s|ค่ะ|คะ|ครับ|นะ|$)/u;
const OTHER_DATE_ASK = /(?:รอบ|วัน)\S{0,3}อื่น|ไหนอีก|อื่นอีก/u;
// "ธันวามีรอบวันที่ 5 ไหม" — ชื่อเดือนอยู่ก่อนเลขวัน
const MONTH_WORDS = [[/มกรา|ม\.ค/u, 1], [/กุมภา|ก\.พ/u, 2], [/มีนา|มี\.ค/u, 3], [/เมษา|เม\.ย/u, 4], [/พฤษภา|พ\.ค/u, 5], [/มิถุนา|มิ\.ย/u, 6],
  [/กรกฎา|ก\.ค/u, 7], [/สิงหา|ส\.ค/u, 8], [/กันยา|ก\.ย/u, 9], [/ตุลา|ต\.ค/u, 10], [/พฤศจิกา|พ\.ย/u, 11], [/ธันวา|ธ\.ค/u, 12]];
const DAY_NUMBER = /(?<![\d.:\/])([0-3]?\d)(?![\d.:\/])(?!\s*(?:คน|ท่าน|ชั่วโมง|ชม|โมง|นาที|บาท|ครั้ง|ปี|เดือน|%))/u;
const WEEKDAY_DAY = /(?:วัน)?(เสาร์|อาทิตย์)\s*(?:ที่\s*)?([0-3]?\d)(?![\d:.\/])(?!\s*(?:คน|ท่าน|ชั่วโมง|ชม|โมง|นาที|บาท|วัน|ครั้ง))/u;
const WEEKDAY_INDEX = Object.freeze({ อาทิตย์: 0, เสาร์: 6 });
const AVAIL_ASK = /มี(?:\S{0,6})?(?:ไหม|มั้ย|มั๊ย|ป่าว|ปะ|รึเปล่า|หรือเปล่า|หรือไม่|รึยัง|หรือยัง)|มีรอบ|มีเรียน|มีสอน|เปิด(?:รอบ|สอน|เรียน)?\s*(?:ไหม|มั้ย|มั๊ย)|(?:เรียน|ไป|มา)ได้(?:ไหม|มั้ย|มั๊ย)|ได้(?:ไหม|มั้ย|มั๊ย)|ว่าง(?:ไหม|มั้ย)|[?？]/u;
const MONTH_SHORT = ["ม.ค.", "ก.พ.", "มี.ค.", "เม.ย.", "พ.ค.", "มิ.ย.", "ก.ค.", "ส.ค.", "ก.ย.", "ต.ค.", "พ.ย.", "ธ.ค."];
const pad = (n) => String(n).padStart(2, "0");
// วันที่เลขเดียว ("เสาร์ 24") = วันนั้นที่ถัดจากวันนี้ (วันนี้หรือหลังจากนี้)
function nextDayIso(day, todayIso) {
  const [y, m, d] = String(todayIso).split("-").map(Number);
  if (!y || !(day >= 1 && day <= 31)) return "";
  let year = y;
  let month = day >= d ? m : m + 1;
  if (month > 12) { month = 1; year += 1; }
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= last ? `${year}-${pad(month)}-${pad(day)}` : "";
}
// "เสาร์ 7" = วันที่ 7 ถัดจากวันนี้ที่เป็นวันเสาร์จริง ภายในสองเดือน — รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): "เสาร์ที่ 25" (25 ต.ค. เป็นวันอาทิตย์)
// เคยวนไปหาเดือนที่วันที่ 25 เป็นวันเสาร์ได้ปีหน้า — ชื่อวันกับเลขวันไม่ตรงกันในสองเดือน = ไม่เดาวันที่ ("" ให้ถามกลับ)
const WEEKDAY_SEARCH_MONTHS = 2;
function nextWeekdayDayIso(day, weekday, todayIso) {
  let iso = nextDayIso(day, todayIso);
  for (let i = 0; iso && i < WEEKDAY_SEARCH_MONTHS; i += 1) {
    if (new Date(`${iso}T00:00:00Z`).getUTCDay() === weekday) return iso;
    const [y, m] = iso.split("-").map(Number);
    iso = nextDayIso(day, `${m === 12 ? y + 1 : y}-${pad(m === 12 ? 1 : m + 1)}-01`);
  }
  return "";
}
/** วันที่ (YYYY-MM-DD) ที่ลูกค้าถามว่ามีรอบไหม · "" = ข้อความนี้ไม่ได้ถาม
 * ไม่ใช้ resolveDateExpressions: "วันที่ 24 มี…" ถูกอ่านเป็นวันอื่นเพราะคำว่า มี ตามหลัง */
export function requestedDateOf(text = "", todayIso = "") {
  const value = String(text || "");
  if (!todayIso || OTHER_DATE_ASK.test(value) || NOT_ROUND_TOPIC.test(value)) return "";
  const neg = NEG_DATE.exec(value);
  // วันที่ที่ตามหลังคำปฏิเสธ ("17 ไม่สะดวก 24 ได้ไหม") — ส่วนหลังต้องถามเองและไม่มีคำปฏิเสธซ้ำ
  if (neg) {
    const rest = value.slice(neg.index + neg[0].length);
    const bare = DAY_NUMBER.exec(rest);
    if (!bare) return "";
    return requestedDateOf(rest, todayIso) || (AVAIL_ASK.test(rest) ? nextDayIso(Number(bare[1]), todayIso) : "");
  }
  if (!AVAIL_ASK.test(value)) return "";
  const refMs = Date.parse(`${todayIso}T12:00:00+07:00`);
  const explicit = explicitCalendarDates(value, refMs);
  if (explicit.length) return explicit[0];
  const months = MONTH_WORDS.filter(([re]) => re.test(value));
  const day = DAY_NUMBER.exec(value.replace(/[\u0E00-\u0E7F.]+/gu, (m) => " ".repeat(m.length)));
  if (months.length === 1 && day) return explicitCalendarDates(`${Number(day[1])} ${MONTH_SHORT[months[0][1] - 1]}`, refMs)[0] || "";
  const legacy = detectRoundInterest(value);
  if (legacy?.month) return explicitCalendarDates(`${legacy.day} ${MONTH_SHORT[legacy.month - 1]}`, refMs)[0] || "";
  const weekday = WEEKDAY_DAY.exec(value);
  if (weekday && (!legacy || legacy.day === Number(weekday[2]))) return nextWeekdayDayIso(Number(weekday[2]), WEEKDAY_INDEX[weekday[1]], todayIso);
  return legacy?.day ? nextDayIso(legacy.day, todayIso) : "";
}

/** ถามวัน (เสาร์/อาทิตย์ + เลขวัน) ว่ามีรอบไหม แต่ระบุวันที่จริงไม่ได้ ("เสาร์ที่ 25" ที่ไม่ใช่วันเสาร์ในสองเดือนนี้) */
export function roundDayAskOf(text = "") {
  const value = String(text || "");
  return WEEKDAY_DAY.test(value) && AVAIL_ASK.test(value) && !NOT_ROUND_TOPIC.test(value) && !NEG_DATE.test(value) && !OTHER_DATE_ASK.test(value);
}

const classOfRound = (round) => (round?.classKey === "advance" || /Workflow/iu.test(String(round?.product || round?.label || "")) ? "workflow" : "business");
const labelOfIso = (iso) => `${roundWeekdayThai({ date: iso })} ${roundShortThai({ date: iso })}`;
/**
 * วันที่ลูกค้าถามเทียบรอบที่เปิดทั้งหมด: open = มีรอบของคลาสนี้ · other_class = เป็นรอบของอีกคลาส · none = ไม่มีรอบ
 * nearest = รอบของคลาสนี้ไม่เกินสองรอบ หลังวันที่ถามก่อน (คนที่ขอวันอื่นมักเห็นรอบก่อนหน้าแล้ว) ไม่พอค่อยเติมรอบก่อนหน้า
 */
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (รอบรีวิว): เคยเสนอรอบหลังวันที่ถามก่อนเสมอ เลยข้ามรอบที่ใกล้กว่าก่อนวันนั้น (ถาม 24 ต.ค. ได้ 14/21 พ.ย. แทน 10/17 ต.ค.)
// และรอบที่เต็มแล้วถูกบอกว่า "ยังไม่มีรอบ" — ตอนนี้เลือกรอบที่ใกล้ที่สุดจริง (ใกล้เท่ากัน = รอบที่ยังไม่เคยบอกมาก่อน) · รอบเต็ม/ปิด = full
// (ให้น้ำหนักรอบที่ยังไม่เคยบอกมากกว่านี้ไม่ได้: ห้องจริงที่เห็นสามรอบแรกไปแล้วจะได้รอบเดือนธันวาแทนรอบที่ใกล้กว่า)
const DAY_MS = 86_400_000;
const distanceOf = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;
export function dateFitOf(iso = "", { allRounds = [], classKey = null, closedRounds = [], shownDates = [] } = {}) {
  if (!iso) return null;
  const mine = classKey || "business";
  const own = (Array.isArray(allRounds) ? allRounds : []).filter((round) => classOfRound(round) === mine);
  const label = labelOfIso(iso);
  if (own.some((round) => round.date === iso)) return { iso, label, status: "open", otherClass: "", nearest: [] };
  const other = (Array.isArray(allRounds) ? allRounds : []).find((round) => round.date === iso);
  const closed = (Array.isArray(closedRounds) ? closedRounds : []).some((round) => round?.date === iso && classOfRound(round) === mine);
  const shown = new Set(Array.isArray(shownDates) ? shownDates : []);
  const nearest = [...own].sort((a, b) => (distanceOf(a.date, iso) - distanceOf(b.date, iso))
    || (Number(shown.has(a.date)) - Number(shown.has(b.date))) || (a.date < b.date ? -1 : 1))
    .slice(0, 2).sort((a, b) => (a.date < b.date ? -1 : 1));
  return { iso, label, status: closed ? "full" : other ? "other_class" : "none", otherClass: !closed && other ? CLASS_NAMES[classOfRound(other)] : "",
    nearest: nearest.map((round) => labelOfIso(round.date)) };
}
