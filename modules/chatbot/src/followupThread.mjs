// followupThread.mjs — ข้อความทักตามต้องกลับไปที่ "เรื่องที่ค้างอยู่เรื่องเดียว" ของห้องนั้น (คำสั่งพี่ง้วง 7 ต.ค. 2026 "ทำข้อ 1-4 ได้เลย")
//
// รีวิวเคสจริง 6–7 ต.ค.: ข้อความทักตามคือเหตุอันดับหนึ่งที่ห้องได้คะแนน 4 และกินค่า AI ราว 28% — ส่วนใหญ่เป็นประโยคกว้าง ๆ
// ("ค่อย ๆ พิจารณาตามจังหวะที่สะดวกนะคะ" · "มีส่วนไหนอยากทราบเพิ่ม") ที่ไม่กลับไปที่คำถามที่ลูกแพรถามค้าง (ระดับการใช้ AI
// · งานที่อยากให้ช่วย · คำถามคัดกรองก่อนแจ้งราคา · รอบที่ชวนเลือก) และบางห้องได้สองข้อความแบบนี้ในวันเดียว
// ต้นเหตุ: พรอมต์ทักตามเดิมไม่เคยบอกว่าเรื่องที่ค้างคืออะไร ยกตัวอย่างประโยคปิดแบบกว้าง ๆ ให้เอง และสั่งให้คุยกับ "ความเจ็บ" แทนเรื่องที่ค้าง
//
// รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8 · นโยบายทักตามที่เจนเคาะเพื่อเป้าของพี่ง้วง: ต้นทุนต่ำสุด + ขายดีที่สุด + บริการดีที่สุด):
//   - ไม่ทักเลย: ปฏิเสธ/ไม่สนใจ/ไม่ต้อง · รู้สึกโดนตื๊อ · ดูแลใจ (ป่วย/ตกงาน) · v3 ปิดห้อง · เงินตึง · ลูกค้าลาเอง
//   - ขอเวลาคิด ("ขอคิดดูก่อน" · "ไว้ก่อน" · "ขอบคุณค่ะ เดี๋ยวดูก่อน"): ข้ามไม้เร็ว (+45 นาที / +4 ชม.) ทักครั้งเดียวที่ไม้วันถัดไป/วันที่ 3
//     ผูกกับเรื่องที่ยังตัดสินใจไม่ได้ (รอบที่เปิดจริง · เลือกคลาส · ข้อเสนอที่ช่วยได้หนึ่งข้อ) แล้วหยุด
//   - รอปรึกษาคนที่บ้าน/หัวหน้า: เช็กอินครั้งเดียววันที่ 2–3 เสนอสรุปสั้น ๆ ให้ส่งต่อ ไม่ชวนเลือกรอบ · รอเงินเดือน: ครั้งเดียววันที่ 3–7 ไม่กดดัน
//   - เงียบเฉย ๆ: เรื่องที่ค้างทักได้ไม่เกินสองครั้งต่อช่วงเงียบ ครั้งที่สองห่างจากครั้งแรก ≥20 ชม. และเปลี่ยนมุม/ขยับเรื่องไปข้างหน้า
//     (ระดับ → งาน · เลือกรอบ → ยังติดเรื่องไหน · คัดกรอง → ข้อที่เบากว่า) แล้วจบบันได
//   - ป้ายลาหยุดทักเฉพาะลูกค้าลาเอง · ลูกค้าตอบรับเฉย ๆ แล้วลูกแพรปิดด้วยคำลา = ย้อนหาคำถามที่ค้าง (ห้อง e67a92d5)
//   - ทีมงานพิมพ์เป็นคนสุดท้าย: ทีมถามค้าง (AI เปิด หน้าต่างทีมหมด) = ทักต่อจากคำถามนั้น · ทีมปิดห้อง = ไม่ทัก (ห้อง d13f0269)
//   - เห็นราคาแล้วไม่มีคำถามค้าง = เลือกรอบ/ยังติดเรื่องไหน (ไม่ใช่ทิปเรื่องงาน) · ขั้นสมัคร = คำถามอย่างเดียว ไม้หลัง ครั้งเดียว
//
// ไฟล์นี้เลือกเรื่องที่ค้างด้วยโค้ด (ฟรี ไม่เรียกโมเดล) จากข้อความจริงของห้อง + metadata ของคำตอบ v3 และบอกว่าไม้ไหนของบันไดใช้ได้
// (stagedFollowups.threadStepPlan จัดไม้ให้ตรงกันทั้งเส้นยิงจริงและ badge คอนโซล)
// เปิดใช้เฉพาะห้องที่ reply_engine = v3 (สวิตช์เดียวกับเครื่องตอบ — ถอยกลับ = legacy ในคอนโซล พรอมต์ทักตามเดิมทุกไบต์)
import { isClosingQuestion } from "./handoffClosing.mjs";
import { learningGoal } from "./conversationFocus.mjs";
import { roundShortThai, roundWeekdayThai, roundsMentionedIn, roundsOfDiscussedClass, isOpenRound } from "./openRounds.mjs";
import { replyEngineMode } from "./replyEngineV3/mode.mjs";
import { BOT_FAREWELL, enrollIntentOf, followupStopSignal, roundPickedIn, WAIT_FOR_MONEY_RE } from "./replyEngineV3/stage.mjs";
import { impliedLevelOf } from "./replyEngineV3/turnFacts.mjs";
import { CLOSING_TYPES, OFFER_ACTOR, OFFER_CLOSE, sentencesOf } from "./replyEngineV3/closings.mjs";
// จุดคุ้มค่าชุดเดียวกับเส้นตอบ (พี่ง้วงยืนยัน 12 ต.ค. รวมใบประกาศนียบัตร) — ไม่มีรายการคู่ขนานในไฟล์นี้
import { VALUE_POINTS } from "./replyEngineV3/promptTexts.mjs";
// ตัวอ่าน "ถามค่าเรียนของเรา" ตัวเดียวกับด่านราคา (อ่านคำพิมพ์ผิด + veto ราคาของธุรกิจลูกค้าเอง)
import { asksAboutMoney } from "./priceDisclosure.mjs";
// ข้อความสำรองของเส้นตอบ (ร่างถูกด่านเงินบล็อก / ตัวตรวจคำตอบล่ม) = ลูกค้ายังไม่ได้ของที่ขอ — อ่านจากค่าคงที่ตัวเดียวกับที่ส่งจริง
// ไม่เกิดวงนำเข้า: pipeline.mjs ไม่ได้นำเข้าไฟล์นี้หรือ stagedFollowups (ไฟล์นี้ก็โหลด pipeline.mjs อยู่แล้วผ่าน turnFacts → stage → … → qualifySweepRules)
import { BLOCKED_FALLBACK_TEMPLATE, BLOCKED_FALLBACK_UNTRACKED_TEMPLATE, JEV_HOLD_FALLBACK_TEMPLATE } from "./pipeline.mjs";
import { truncateCodePoints } from "./unicodeText.mjs";

// คำสั่งพี่ง้วง 12 ต.ค. 2026 ("ทุกอย่างคือ human touch, human sense ไม่ใช่ระบบอัตโนมัติ"):
//   - ราคาที่ถูกแบ่งรับไว้ / ลูกค้าถามราคาแล้วยังไม่ได้ตัวเลข = ทักตามแจ้งค่าเรียนเลย พร้อมเล่าว่าค่าเรียนนี้ได้อะไร คุ้มอย่างไร (price_owed)
//     ไม่ถามคัดกรองซ้ำ (เดิม screen_price → screen_light ถามข้อที่ "เบากว่า" และสั่ง "ยังไม่บอกตัวเลข" — บางห้องถูกกั้นราคา 3 ครั้ง)
//   - ลูกค้าขอของไว้ (รายละเอียด/หัวข้อ/ลิงก์/วิธีสมัคร) แล้วได้บันได/คำว่า "ยังยืนยันไม่ได้" แทน = ทักตามส่งของนั้นเลย (deliver)
//   - ห้ามสั่งให้ "ตอบเป็นเลขเดียว/ตอบแค่…/ตอบสั้น ๆ แล้ว…" และห้ามถามซ้ำคำถามที่ลูกแพรถามไว้หรือที่ลูกค้าตอบแล้ว
//   - ลูกค้าพิมพ์มาแค่ข้อความแรกแล้วเงียบ = ทักได้ครั้งเดียวตลอดอายุห้อง
//   - ห้องที่ได้ราคาแล้ว = ทักครั้งเดียว เช้าวันถัดไป · ต้องเสนอผู้บริหาร/ทุนยังไม่พร้อม = ไม่เร่ง ถามว่าติดตรงไหน ลูกแพรยินดีประสานงานให้ (decision)
export const THREAD_KINDS = Object.freeze(["screen_price", "screen_light", "price_owed", "deliver", "level", "work", "rounds_offer", "round_choice", "booking",
  "class_choice", "after_price", "question", "goal", "consult", "money_wait", "decision"]);
export const FOLLOWUP_MODES = Object.freeze(["normal", "defer", "consult", "money_wait", "decision"]);
// ทักตามที่ "ส่งของ" ให้ลูกค้า (ราคา/รายละเอียด/ภาพรวมคลาส) — ข้อความยาวกว่าคำถามเดียวได้ และไม่บังคับปิดด้วยคำถาม
export const DELIVER_KINDS = Object.freeze(new Set(["screen_price", "screen_light", "price_owed", "deliver", "level"]));
const PRICE_KINDS = new Set(["screen_price", "screen_light", "price_owed"]);
// ไม้ทักตามของก่อนแก้ที่ถามคัดกรองซ้ำแทนการแจ้งราคา
const WITHHELD_PRICE_KINDS = new Set(["screen_price", "screen_light"]);
// รีวิว 12 ต.ค.: ห้องที่ต้องเสนอผู้บริหาร/รองบ/รอปรึกษา = น้ำเสียงพี่ง้วง "ติดตรงไหน อยากได้สรุปไว้เสนอผู้บริหารไหม ลูกแพรยินดีประสานงานให้"
// ซึ่งมักจบด้วยประโยคบอกเล่า ("บอกลูกแพรได้เลยนะคะ ลูกแพรยินดีประสานงานให้ค่ะ") — ไม่บังคับปิดด้วยเครื่องหมายคำถาม (เดิมโดนตัดเหลือ "")
const CARE_KINDS = new Set(["decision", "consult"]);
/** ข้อความทักตามของเรื่องนี้ต้องปิดด้วยคำถามไหม (ด่านหลังร่าง) — ส่งของให้แล้ว / เช็กอินห้องที่รอผู้ตัดสินใจ = ไม่บังคับ */
export const threadNeedsQuestion = (thread) => !DELIVER_KINDS.has(thread?.kind) && !CARE_KINDS.has(thread?.kind);
/** ทักตามที่ "ส่งของ" ให้ลูกค้า (ราคา/รายละเอียด/ภาพรวมคลาส) — ข้อความยาวกว่าคำถามเดียวได้ */
export const threadDeliversItem = (thread) => DELIVER_KINDS.has(thread?.kind);
/** เรื่องนี้ต้องแจ้งค่าเรียน (ราคาที่ค้างจ่าย) */
export const threadDeliversPrice = (thread) => PRICE_KINDS.has(thread?.kind);
// สิ่งที่ลูกค้าได้จากค่าเรียน — ให้โมเดลเลือก 2–3 ข้อที่ตรงกับลูกค้า ไม่ใช่แม่แบบ (แหล่งเดียว: promptTexts.VALUE_POINTS)
export const FOLLOWUP_VALUE_POINTS = VALUE_POINTS.join(" · ");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** ครั้งที่สองของเรื่องที่ค้างต้องห่างจากครั้งแรกอย่างน้อยเท่านี้ (รีวิวเคสจริง 6–7 ต.ค. รอบรีวิว 8) */
export const SECOND_TOUCH_MIN_GAP_MS = 20 * HOUR_MS;
// รอปรึกษาคน = วันที่ 2–3 · รอเงินเดือน = วันที่ 3–7 (นับจากข้อความล่าสุดที่ลูกค้าพิมพ์)
const CONSULT_AFTER_MS = 2 * DAY_MS;
const MONEY_WAIT_AFTER_MS = 3 * DAY_MS;
// ย้อนหาคำถามที่ค้างได้ไม่เกินจำนวนก้อนนี้ (ลูกค้าถามเรื่องอื่นต่อ/ตอบรับเฉย ๆ แล้วลูกแพรปิดด้วยคำลา)
const LOOKBACK_BURSTS = 4;

/** ทักตามแบบมีเรื่องค้างเปิดอยู่ไหม — ผูกกับสวิตช์ reply_engine (อ่านพัง = ปิด = เส้นเดิม) */
export function followupThreadEnabled(db) {
  return replyEngineMode(db) === "v3";
}

const ADMIN_PREFIX = "[แอดมินทีมงานพิมพ์เอง]";
function parseMeta(raw) {
  try { return JSON.parse(String(raw || "{}"))?.replyEngine || null; } catch { return null; }
}

/** แถวข้อความของ session (db.messagesFor) → แถวที่ตัวเลือกเรื่องค้างอ่าน (ข้อความขาออกที่ไม่ใช่ตัวอักษร เช่น รูป ไม่นับ) */
export function followupRows(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter((row) => row && (row.direction === "in" || (row.msg_type || "text") === "text"))
    .map((row) => ({
      role: row.direction === "in" ? "user" : "assistant",
      admin: row.direction === "out" && Boolean(String(row.operator || "").trim()) && row.operator !== "system",
      proactive: row.message_class === "proactive",
      media: row.direction === "in" && (row.msg_type || "text") !== "text",
      text: String(row.content || ""),
      meta: row.direction === "out" ? parseMeta(row.metadata_json) : null,
      at: Number(row.created_at) || 0,
    }));
}

// (ช่องว่างหน้าเลขเฉพาะในบรรทัดเดียวกัน — "\s*" กับขึ้นบรรทัดยาว ๆ ช้าแบบยกกำลังสอง ผลเหมือนเดิมทุกข้อความ)
const KEYCAP_LINE = /^[^\S\n]*[1-5]️?⃣/mu;
const LADDER_ASK = /ระดับที่เท่าไหร่|ใช้\s?AI\s?มาประมาณ|เคย(?:ลอง)?ใช้\s?(?:AI|เอไอ|ChatGPT)/iu;
// ขอพื้นฐานก่อนแจ้งราคา — ประโยคที่บอกว่าตอบแล้วแจ้งค่าเรียนให้ (PRICE_NEXT_PROMISE ของ stageTasks)
const PRICE_PROMISE = /แจ้งค่าเรียนให้(?:ทันที|เลย)|บอกค่าเรียนให้(?:ทันที|เลย)/u;
const BOOKING_ASK = /รายละเอียดการสมัคร|ส่ง\S{0,12}สมัคร|สมัครรอบ(?:นี้|นั้น)|ลงทะเบียนรอบ/u;
// รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8): ขั้นสมัคร (ลูกค้าเลือกรอบแล้ว ลูกแพรถามชื่อออกใบเสร็จ/เบอร์/อีเมล) = คำถามอย่างเดียว ไม้หลัง ครั้งเดียว
const REGISTRATION_ASK = /ใบเสร็จ|ใบกำกับ|ออก(?:เอกสาร|บิล)?ในนาม|ชื่อ\s?-?\s?นามสกุล|ชื่อจริง|เบอร์(?:โทร)?(?:ติดต่อ)?|อีเมล|e-?mail|ข้อมูล(?:สำหรับ)?(?:การ)?สมัคร|ลงทะเบียน/iu;
// รอบรีวิว 8: "สนใจรอบเสาร์ที่ 17 ต.ค. ไหมคะ?" ก็เป็นคำชวนเลือกรอบ (ทักตามใช้รอบที่ยังเปิดจริง ไม่ยกวันที่เก่าในคำถามเดิม)
const ROUND_CHOICE_ASK = /สะดวก(?:มา)?(?:เรียน)?(?:เริ่ม)?(?:รอบ|วัน)|รอบไหน|เลือกรอบ|รอบ[^\n?？]{0,24}หรือ[^\n?？]{0,24}(?:ดี|คะ)|(?:เสาร์|อาทิตย์)\s?(?:ที่\s?)?\d{1,2}[^\n?？]{0,40}หรือ|(?:สนใจ|เอา|ลง)\s?รอบ[^\n?？]{0,30}?(?:ไหม|มั้ย|มั๊ย)/u;
const ROUNDS_OFFER_ASK = /ส่งรอบ|รอบ(?:เรียน)?ที่เปิด/u;
const WORK_ASK = /งาน(?:ไหน|อะไร|ด้าน)|ด้านไหน|ทำงาน|ธุรกิจ|อาชีพ|สายงาน|ให้\s?AI\s?ช่วย|สินค้า|ขาย(?:อะไร|ของ)|เรื่องไหน|เคย(?:สร้าง|ทำ)\s?(?:Custom|Workflow)/iu;
const PRICE_CARD = /\d{1,3},\d{3}\s*บาท|📌/u;
// รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8): ลูกค้าบอกเป็นนัยแล้วว่าเคย/ไม่เคยใช้ AI ("ใช้ ChatGPT ทำงานทุกวัน" · "ยังไม่เคยใช้ AI เลย") แต่ลูกแพรยังส่งบันได
// — ทักตามห้ามถามระดับซ้ำ ให้ถามเรื่องงานแทน (ตัวอ่านระดับของเทิร์นยึดต้นข้อความ จึงไม่เห็น "สนใจค่ะ ใช้ ChatGPT…")
const LEVEL_TOLD_RE = /(?:ไม่|ยังไม่|ไม่ค่อย)?เคย(?:ใช้|ทำ|สร้าง|ลอง|เล่น)|ใช้\s?(?:chat\s?-?gpt|gpt|gemini|claude|copilot|ai\b|เอไอ)|ใช้(?:อยู่|ประจำ|ทุกวัน|บ้าง)|custom\s?gpt|มือใหม่|ทำไม่เป็น|ใช้ไม่เป็น/iu;
// ลูกค้าตอบรับเฉย ๆ (ไม่ใช่คำลา ไม่ใช่เรื่องใหม่) — คำในชุดต้องไม่ซ้อนกัน ("ครับผม" = ครับ + ผม · "ดีเลย" = ดี + เลย)
// ไม่งั้นข้อความยาวที่ไม่ผ่านจะทำให้ตัวจับลองแบ่งคำทุกแบบ (ตรวจความเร็ว 5,000 ตัวอักษร)
const BARE_ACK_RE = /^(?:ok|okay|โอเค|โอเช|เค|ได้|ค่ะ|คะ|ค่า|ครับ|คับ|จ้า|จ้ะ|รับทราบ|เข้าใจ|แล้ว|อืม|อ๋อ|ดี|นะ|ผม|เลย)*$/iu;
const EMOJI_OR_SPACE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️\s]+/gu;
// (คำถามแบบเลือก "เป็น on site หรือ ออฟไซด์ครับ" ก็เป็นคำถาม — ใช้เฉพาะตอนเดินย้อนหาคำถามที่ค้าง)
const ASKS = /[?？]|ไหม|มั้ย|ยังไง|อย่างไร|เท่าไหร่|เท่าไร|เมื่อไหร่|ที่ไหน|(?<!เ)กี่|อะไร|หรือ|เหรอ|หรอ|ป่าว/u;
// คนที่ลูกค้าขอปรึกษา (ใช้ในบรรทัดสั่งงานของการเช็กอิน)
const CONSULT_WHO = /สามี|ภรรยา|แฟน|หัวหน้า|เจ้านาย|ผู้จัดการ|ที่บ้าน|ครอบครัว|พ่อ|แม่|ผู้ใหญ่|ฝ่ายบุคคล|หุ้นส่วน|บริษัท/u;
const ROUND_KINDS = new Set(["rounds_offer", "round_choice", "booking"]);
const DISCOVERY_KINDS = new Set(["level", "work"]);
// ---- 12 ต.ค. 2026: ของที่ลูกค้าขอไว้ ----
// ถามค่าเรียนของเรา = priceDisclosure.asksAboutMoney ต่อแถวลูกค้า (อ่านคำพิมพ์ผิด "เรียนเท่าไหนครับ" · "คอรส์ที่เท่าไหรนะครับ"
// · veto "ตั้งราคาสินค้าในร้าน" · สำนวน "ไม่ค่อยได้ใช้เท่าไหร่" · "แจ้งราคาไปยังผู้บริหาร") — ทักตามแจ้งราคาเองโดยลูกค้าไม่ได้ทักมา
// จึงอ่านเข้มกว่าเส้นตอบอีกชั้น (รีวิว 12 ต.ค.): "เท่าไหร่" ของเวลา/จำนวน ("เรียนนานเท่าไหร่" · "ใช้เวลาเรียนเท่าไหร่") ตัดออกก่อนอ่าน
// (คำเงินที่เหลือในข้อความยังนับ: "ราคาต่อคนเท่าไหร่" ตัด "คนเท่าไหร่" แล้วยังเหลือ "ราคา")
const NON_MONEY_AMOUNT_RE = /(?:นาน|ยาว|ไกล|เยอะ|บ่อย|เวลา(?:เรียน|อบรม)?|ชั่วโมง|ชม\.?|อายุ|ขนาด|คน|ที่นั่ง|ครั้ง)\s?(?:ประมาณ|สัก|ราว)?\s?เท่า(?:ไห|ไร|ใด|รัย)[ร่น]*/gu;
// "เสียตังไหม" / "ต้องเสียเงินเพิ่มไหม" (ตัวอ่านของด่านราคายังไม่มีคำนี้)
const COST_ASK_RE = /เสีย\s?(?:ตังค?์?|เงิน)\S{0,8}?(?:ไหม|มั้ย|มั๊ย|ป่าว|เปล่า|ด้วย|เท่า)/u;
const asksOurPrice = (text = "") => {
  const rest = String(text).replace(NON_MONEY_AMOUNT_RE, " ");
  return asksAboutMoney(rest) || COST_ASK_RE.test(rest);
};
// นักเรียนเก่า / เรียนสองคลาสพร้อมกัน = ราคาพิเศษอยู่ในการ์ดที่ทีมงานดูแล (เส้นตอบส่งห้องนี้ให้เครื่องเดิม) — ทักตามไม่แจ้งราคาคลาสเดี่ยว
// สำเนาของ replyEngineV3/lanes.mjs OLD_STUDENT_BUNDLE ทุกตัวอักษร (ตัวนั้นไม่ได้ export — เทสต์ล็อกว่าตรงกัน)
const OLD_STUDENT_BUNDLE = new RegExp([
  "เคยเรียน", "เคยมาเรียน", "เคยลง(?:คลาส|คอร์ส|เรียน|สมัคร|ทะเบียน|ไปแล้ว|แล้ว)",
  "เรียนไปแล้ว(?=\\s*(?:ค่ะ|คะ|ครับ|นะ|จ้า|รอบ|ครั้ง|ตอน|เมื่อ|$))",
  "นักเรียนเก่า", "ศิษย์", "เรียนซ้ำ", "re-?learn", "bundle", "สองคลาส", "2 ?คลาส", "ทั้งสอง(?:คลาส|คอร์ส)",
  "(?:ลง|เรียน|สมัคร|เอา)\\s*(?:ทั้ง|ครบ)\\s*(?:ทั้ง)?\\s*(?:สอง|2|คู่|business|workflow|คลาส|คอร์ส)",
].join("|"), "iu");
const DETAILS_ASK_RE = /รายละเอียด|หัวข้อ|เนื้อหา(?:ที่)?(?:สอน|เรียน|คลาส|คอร์ส)|outline|เอาท์ไลน์|สอนอะไร|เรียนอะไร|มีแบบไหน|มีคลาสอะไร|มีคอร์สอะไร|มีอะไรบ้าง|ขอข้อมูล|ข้อมูลคลาส|ข้อมูลคอร์ส|แพ็กเกจ|แพ็คเกจ|package/iu;
// ขอลิงก์/คลิป/รีวิว (ต้องมีคำขอ — "ดูคลิปแล้วสนใจค่ะ" ไม่ใช่การขอคลิป)
const LINK_ASK_RE = /(?:ขอ|มี|ส่ง|อยากดู)[^\n]{0,12}?(?:ลิงก์|ลิ้งก์|ลิ้งค์|ลิงค์|link|คลิป|รีวิว)|(?:ลิงก์|ลิ้งก์|ลิ้งค์|ลิงค์|link|คลิป|รีวิว)[^\n]{0,12}?(?:ไหม|มั้ย|หน่อย|บ้าง)/iu;
// งานทีม/องค์กร (ตั้งแต่ 4 ท่าน) = ทีมงานออกใบเสนอราคาเอง ไม่แจ้งราคาคลาสรวมในทักตาม (นโยบายราคาเดิม)
const PROJECT_ROOM_RE = /(?<!\d)(?:[4-9]|[1-9]\d{1,3})\s?(?:คน|ท่าน)|ทั้ง(?:ทีม|บริษัท|องค์กร)|อบรม(?:พนักงาน|ภายใน)|in-?house|อินเฮาส์/iu;
// ลูกค้าตอบรับข้อเสนอ ("ส่งมาเลยครับ" · "สนใจครับ" · "ขอดูค่ะ")
const ACCEPT_RE = /สนใจ|ส่งมา|ส่งให้|ขอดู|อยากดู|เอาค่ะ|เอาครับ|ได้เลย|(?<![a-z])ok(?![a-z])|โอเค/iu;
// ลูกแพรตอบว่ายืนยันไม่ได้/ไม่มีข้อมูล ทั้งที่ระบบมีข้อมูล (ห้อง 6047b1d2 · c755fafe)
// รีวิวรอบ 2 (12 ต.ค.): ข้อความสำรองชุดใหม่ไม่มีคำว่า "ยังยืนยันไม่ได้" แล้ว (เดิมทั้งสามแบบมี จึงถูกนับว่ายังไม่ได้ของ)
// — นับข้อความสำรองทั้งสามแบบตรง ๆ ทักตามส่งของจึงยังทำงานหลังข้อความสำรอง · ช่องว่าง/ขึ้นบรรทัดใหม่ระหว่างคำ (แยกบับเบิล) นับเป็นช่องว่างเดียวกัน
const FALLBACK_REPLY_PATTERNS = [BLOCKED_FALLBACK_TEMPLATE, BLOCKED_FALLBACK_UNTRACKED_TEMPLATE, JEV_HOLD_FALLBACK_TEMPLATE]
  .map((text) => String(text).trim().replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+"));
const NOT_DELIVERED_RE = new RegExp([
  "ยัง(?:ยืนยัน|คอนเฟิร์ม)[^\\n]{0,30}?ไม่ได้|ยังไม่มีข้อมูล|ไม่มีข้อมูลยืนยัน|ยังไม่มี(?:หลักสูตร|รายละเอียด|ลิงก์|คลิป)",
  ...FALLBACK_REPLY_PATTERNS,
].join("|"), "u");
// ต้องเสนอผู้มีอำนาจตัดสินใจก่อน / งบหรือทุนยังไม่พร้อม (ไม่ใช่เงินตึง — เงินตึงหยุดทักตั้งแต่ด่านบน)
// รีวิว 12 ต.ค.: ชื่อตำแหน่งเฉย ๆ ไม่ใช่การรอผู้บริหาร ("ผมทำงาน HR" · "ผมเป็น CEO บริษัทเอง" · "ผมเป็นผู้จัดการร้านเอง ตัดสินใจได้เลย")
// — ต้องมีคำว่ารอ/ส่งต่อ/เสนอ อยู่ติดตำแหน่ง ("แจ้งราคาไปยังผู้บริหารเพื่อพิจารณา" · "ขอเสนอเจ้านายก่อน" · "ให้หัวหน้าอนุมัติ")
const DECISION_ROLE = "ผู้บริหาร|เจ้านาย|หัวหน้า|ผู้จัดการ|ผู้อนุมัติ|ฝ่ายบุคคล|ฝ่ายจัดซื้อ|จัดซื้อ|บอส|ต้นสังกัด|(?<![A-Za-z])(?:HR|CEO|MD)(?![A-Za-z])";
const DECISION_MAKER_RE = new RegExp(DECISION_ROLE, "u");
const DECISION_WAIT_RE = new RegExp([
  `(?:(?:นำ)?เสนอ(?!ราคา)|รอ(?!บ)|ปรึกษา|ส่ง(?:ต่อ)?(?:ไป)?(?:ให้|ยัง)|แจ้ง\\S{0,12}?ไป(?:ยัง|ให้)|ขออนุมัติ(?:จาก)?|ถาม)\\s?(?:ทาง|กับ|ท่าน|คุณ)?\\s?(?:${DECISION_ROLE})`,
  `ให้\\s?(?:ทาง)?\\s?(?:${DECISION_ROLE})\\S{0,12}?(?:อนุมัติ|พิจารณา|ตัดสินใจ|เซ็น)`,
  `(?<!เป็น\\s?)(?:${DECISION_ROLE})\\S{0,10}?(?:พิจารณา|อนุมัติ)`,
].join("|"), "u");
const decisionWhoOf = (text = "") => {
  const match = DECISION_WAIT_RE.exec(String(text));
  return match ? DECISION_MAKER_RE.exec(match[0])?.[0] || "" : "";
};
// "ไม่แพงไปเลยครับ คุ้มมาก" · "ราคานี้ไม่เกินงบครับ" = ไม่ใช่รองบ (คำปฏิเสธนำหน้า)
const BUDGET_WAIT_RE = /(?:ทุน|งบ|เงิน|budget)(?:ประมาณ)?\s?(?:ยัง)?ไม่(?:ค่อย)?(?:พร้อม|พอ|ถึง)|ยังไม่พร้อมเรื่อง(?:ทุน|งบ|เงิน)|(?<!ไม่(?:ได้|ค่อย)?\s?)(?:เกินงบ|แพงไป)|รองบ|รออนุมัติงบ/iu;
// ทักตามที่ "สั่งให้ตอบแบบใดแบบหนึ่ง" (รีวิว 11 ต.ค.: "ตอบเป็นเลขเดียวได้เลยค่ะ" ~17 ครั้ง) และคำสัญญาแจ้งราคาหลังตอบคัดกรอง — ตัดทั้งประโยคเสมอ
const DEMAND_ANSWER_RE = /ตอบ(?:เป็น)?\s?(?:แค่|เพียง)|ตอบ(?:เป็น)?\s?(?:ตัว)?เลข|ตอบ(?:กลับ)?\s?สั้น\s?ๆ|ตอบ(?:เป็น)?\s?(?:ข้อ|คำ)เดียว|ตอบได้(?:ด้วย)?คำเดียว|พิมพ์(?:แค่|เพียง)?\s?(?:ตัว)?เลข|(?:แจ้ง|บอก)(?:ค่าเรียน|ราคา)ให้ทันที|ตอบแล้วลูกแพร(?:จะ)?(?:แจ้ง|บอก)|บอกพื้นฐาน/u;
const OFFER_TYPE_OF_ITEM = Object.freeze({ details: "outline", link: "review", enrol: "booking", price: "price" });
const DELIVER_ITEM_LABELS = Object.freeze({ details: "รายละเอียดคลาส", link: "คลิปรีวิวหรือตัวอย่างงาน", enrol: "รายละเอียดการสมัคร" });
// ป้ายหยุด/โหมดจาก metadata ของ v3 หรือข้อความลูกค้า
const HARD_STOP = /^(?:exit:|silent$|declined$|money_hardship$|care:(?:crisis|pressure)$|crisis$|pressure$)/u;

// ตัวเลือกต่อท้ายคำถาม ("…งานไหนก่อนคะ เช่น งานเอกสาร หรือตอบแชท?") ตัวแบ่งประโยคตัดหลัง คะ — ต้องอ่านคู่กับประโยคคำถามก่อนหน้า
const OPTIONS_TAIL = /^(?:เช่น|ทั้ง|หรือ|ระหว่าง)/u;
/** คำถามล่าสุดของก้อนข้อความลูกแพร (รวมตัวเลือกที่ต่อท้าย) — "" = ไม่มี */
// ช่องว่างยาวต่อกัน = ช่องเดียว ก่อนตัดประโยค (ตัวตรวจคำถามของเครื่องเดิมช้าแบบยกกำลังสองกับช่องว่างยาว ๆ — ผลเหมือนเดิมทุกข้อความปกติ)
const squashSpaces = (text) => String(text || "").replace(/[^\S\n]+/gu, " ");
export function lastQuestionOf(text = "") {
  const lines = squashSpaces(text).split("\n").map((line) => line.trim()).filter(Boolean);
  for (let li = lines.length - 1; li >= 0; li -= 1) {
    const sentences = sentencesOf(lines[li]).filter((sentence) => /\p{L}/u.test(sentence));
    const at = sentences.findLastIndex((sentence) => isClosingQuestion(sentence));
    if (at < 0) continue;
    let start = at;
    while (start > 0 && OPTIONS_TAIL.test(sentences[start])) start -= 1;
    let question = sentences.slice(start, at + 1).join(" ");
    // รอบรีวิว 8: คำถามที่ขึ้นบรรทัดใหม่กลางประโยค ("…ช่วยงานในธุรกิจส่วนตัว ⏎ หรือ งานประจำคะ") = ประโยคเดียวกับบรรทัดก่อน
    for (let back = li - 1; back >= 0 && start === 0 && OPTIONS_TAIL.test(question); back -= 1) question = `${lines[back]} ${question}`;
    return question;
  }
  return "";
}

/** ป้ายรอบ ("เสาร์ 17 ต.ค.") ที่ยังเปิดจริง ณ ตอนทัก: รอบที่ลูกแพรเพิ่งบอก หรือรอบของคลาสที่คุยกันอยู่ (≤3) */
export function threadRoundLabels(rounds = [], texts = []) {
  const open = (Array.isArray(rounds) ? rounds : []).filter(isOpenRound);
  const byDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  let chosen = roundsMentionedIn(texts, open).sort(byDate).slice(0, 3);
  if (!chosen.length) chosen = roundsOfDiscussedClass(texts, open).filter(isOpenRound).sort(byDate).slice(0, 3);
  return chosen.map((round) => `${roundWeekdayThai(round)} ${roundShortThai(round)}`);
}

function metaStop(meta) {
  if (!meta || meta.engine !== "v3") return "";
  if (meta.followupStop) return String(meta.followupStop);
  // แถวก่อน v3.6 ไม่มีคีย์ followupStop — จังหวะปิดห้อง/ลา/เงินตึงอ่านจากชื่อจังหวะเดิมได้ตรงตัว
  if (meta.stage === "EXIT") return `exit:${meta.stageReason || ""}`;
  if (meta.stage === "GOODBYE") return meta.stageReason === "care_moment" ? "care" : "goodbye";
  if ((meta.modifiers || []).includes("money_hardship")) return "money_hardship";
  return "";
}

/**
 * โหมดทักตามของช่วงเงียบนี้ — { mode, stop }
 * metadata ของ v3 รู้บริบทครบ (ปิดห้อง/ปฏิเสธ/เงินตึง/ดูแลใจ) ชนะ · ป้ายลา/ดูแลใจแบบไม่ระบุ อ่านซ้ำจากข้อความลูกค้า
 * (แถว v3 เก่าที่ "ขอคิดดูก่อน" ได้ป้ายลา = ขอเวลาคิด ไม่ใช่ลา)
 */
function modeOf(meta, customerText) {
  const fromMeta = metaStop(meta);
  if (HARD_STOP.test(fromMeta)) return { stop: fromMeta };
  const said = followupStopSignal(customerText);
  if (HARD_STOP.test(said)) return { stop: said };
  if (fromMeta === "care:waiting" || said === "waiting") return { mode: WAIT_FOR_MONEY_RE.test(customerText) ? "money_wait" : "consult" };
  if (fromMeta === "defer" || said === "defer") return { mode: "defer" };
  if (fromMeta === "care") return { stop: "care" };
  if (fromMeta === "goodbye" || said === "goodbye") return { mode: "goodbye" };
  return { mode: "normal" };
}

function lastLine(text = "") {
  return String(text).split("\n").map((line) => line.trim()).filter(Boolean).at(-1) || "";
}

const CLASS_FULL_NAMES = Object.freeze([["business", /AI Agent for Business/iu], ["workflow", /Workflow Automation/iu]]);
const classesNamedIn = (texts = []) => new Set(CLASS_FULL_NAMES.filter(([, re]) => texts.some((text) => re.test(text))).map(([key]) => key));

// ประโยคกว้าง ๆ ที่ไม่มีเรื่องของลูกค้า (รีวิวเคสจริง 6–7 ต.ค.) — ใช้ทั้งในพรอมต์ (ยกให้เห็น) และด่านหลังร่าง (ตัดประโยคนั้นทิ้ง)
// รอบรีวิว 8: เพิ่มทรงที่ยังหลุดในร่างจริง ("ถ้ามีข้อสงสัยบอกลูกแพรได้เลย" · "ทักลูกแพรได้ตลอด" · "สะดวกเมื่อไหร่ค่อยคุยกัน") ให้โมเดลเห็นด้วย
export const GENERIC_FOLLOWUP_EXAMPLES = Object.freeze([
  "ค่อย ๆ พิจารณาตามจังหวะที่สะดวก", "มีส่วนไหนอยากทราบเพิ่ม", "บอกลูกแพรได้เสมอ", "ไม่ต้องรีบตัดสินใจ", "ค่อย ๆ คิด",
  "ถ้ามีข้อสงสัยบอกลูกแพรได้เลย", "ทักลูกแพรได้ตลอด", "สะดวกเมื่อไหร่ค่อยคุยกัน", "ยินดีช่วยอธิบายเพิ่ม",
]);
// รอบรีวิว 8 (C4): คำว่า "ข้อสงสัย" ล้วน ๆ เคยตัดคำถามที่มีเรื่องจริงทิ้ง ("ยังมีข้อสงสัยเรื่องวันเรียน ค่าเรียน หรือเนื้อหาไหมคะ")
// — นับเฉพาะทรง "ถ้ามีข้อสงสัย…บอก/ถาม…ได้"
const GENERIC_SENTENCE = new RegExp([
  "ค่อย\\s?ๆ\\s?(?:คิด|พิจารณา|ดู|ตัดสินใจ|ทำความรู้จัก)", "ตามจังหวะ(?:ที่)?(?:สะดวก|ของ)", "พิจารณา(?:ได้)?ตาม(?:สะดวก|ความสะดวก)",
  "(?:ส่วนไหน|ตรงไหน|เรื่องไหน|อะไร)(?:ที่)?(?:อยาก(?:รู้|ทราบ)|สงสัย)(?:เพิ่ม(?:เติม)?)?",
  "ถ้า(?:มี|ยังมี)?\\s?(?:ข้อ|อะไร)?สงสัย[^\\n]{0,30}?(?:บอก|ถาม|ทัก|สอบถาม)[^\\n]{0,12}?ได้",
  "บอกลูกแพร(?:มา)?ได้(?:เสมอ|ตลอด)", "ทัก(?:มา)?(?:หา)?(?:ลูกแพร)?(?:มา)?(?:คุย)?(?:กัน)?ได้(?:เสมอ|ตลอด)", "ไม่ต้องรีบ(?:ตัดสินใจ)?",
  "สะดวกเมื่อไหร่(?:ค่อย)?(?:คุย|ทัก|แวะ|มา)", "ยินดีช่วย(?:อธิบาย|ตอบ)",
].join("|"), "u");
// รอบรีวิว 8 (U8): คำถามที่มีเรื่องจริง (วันเรียน/ค่าเรียน/เนื้อหา/รอบ/ชื่อคลาส) ไม่ใช่ประโยคกว้าง แม้มีคำว่า "อยากทราบเพิ่ม"
// รีวิว 12 ต.ค.: คำถามของห้องที่ต้องเสนอผู้บริหาร ("อยากทราบเพิ่มเติมเพื่อประกอบการนำเสนอไหมคะ") ก็มีเรื่องจริง
const CONCRETE_TOPIC = /วันเรียน|ค่าเรียน|ราคา|เนื้อหา|หัวข้อ|รอบ|ตารางเรียน|เวลาเรียน|สถานที่|การสมัคร|ใบเสร็จ|คลาส|คอร์ส|AI Agent|Business|Workflow|Automation|พื้นฐาน|ต่อยอด|Workshop|ผู้บริหาร|นำเสนอ|เอกสาร|สรุป|งบ|ประสานงาน/iu;
const isGenericSentence = (sentence) => GENERIC_SENTENCE.test(sentence) && !(isClosingQuestion(sentence) && CONCRETE_TOPIC.test(sentence));

// ---- ก้อนข้อความ ----
function trailing(rows, test) {
  const out = [];
  for (let i = rows.length - 1; i >= 0 && test(rows[i]); i -= 1) out.unshift(rows[i]);
  return out;
}
const bareAck = (text) => {
  const bare = String(text || "").replace(EMOJI_OR_SPACE, "");
  return !bare || BARE_ACK_RE.test(bare);
};

/**
 * ย้อนหาคำถามที่ลูกแพรถามค้าง เมื่อก้อนล่าสุดไม่มีคำถามและลูกค้าเพิ่งตอบรับเฉย ๆ (ห้อง e67a92d5: ชวนเลือกรอบ → ลูกค้าถามเรื่องอื่น
 * สองข้อ → "ok ครับ" → ลูกแพรลา) — เดินย้อนได้เฉพาะช่วงที่ลูกค้าถามเรื่องอื่นหรือตอบรับเฉย ๆ (ตอบคำถามนั้นไปแล้ว = หยุด)
 */
// คำถามชวนเลือกรอบที่ยังค้าง ชนะคำถามย่อยที่ถามตามหลัง (ห้อง e67a92d5: ชวนเลือกรอบ → ลูกค้าถามว่าเรียนที่ไหน → ลูกแพรถามว่ามาที่สถาบัน
// หรือให้ไปสอน → ลูกค้าตอบพร้อมถามต่อ → "ok ครับ" — เรื่องที่ยังตัดสินใจไม่ได้คือรอบ)
function lookBackQuestion(list, lastIn) {
  const found = [];
  let i = lastIn;
  for (let hops = 0; hops < LOOKBACK_BURSTS; hops += 1) {
    // ลูกค้าก้อนก่อนหน้า (ที่ตอบก้อนลูกแพรที่อยู่ก่อนมัน)
    let start = i;
    while (start > 0 && list[start - 1].role === "user") start -= 1;
    const said = list.slice(start, i + 1).filter((row) => !row.media).map((row) => row.text).join("\n");
    if (hops > 0 && !bareAck(said) && !ASKS.test(said)) break;
    let end = start - 1;
    while (end >= 0 && list[end].role === "assistant" && (list[end].proactive || list[end].admin)) end -= 1;
    if (end < 0 || list[end].role !== "assistant") break;
    let from = end;
    while (from > 0 && list[from - 1].role === "assistant" && !list[from - 1].admin && !list[from - 1].proactive) from -= 1;
    const rows = list.slice(from, end + 1);
    const text = rows.map((row) => row.text).join("\n");
    const question = lastQuestionOf(text);
    if (question && !isGenericSentence(question)) {
      // ลูกค้าเลือกรอบไปแล้วหลังคำถามนั้น = คำถามนั้นไม่ค้างแล้ว (และคำถามที่เก่ากว่านั้นก็ไม่ค้าง)
      const reply = list.slice(end + 1).find((row) => row.role === "user" && !row.media);
      if (reply && roundPickedIn({ text: reply.text, lastBotText: text, prevRole: "assistant" })) break;
      found.push({ question, text, meta: [...rows].reverse().find((row) => row.meta)?.meta || null });
    }
    i = from - 1;
    if (i < 0 || list[i].role !== "user") break;
  }
  return found.find((item) => ROUND_CHOICE_ASK.test(item.question)) || found[0] || null;
}

// ไม้ที่สองของเรื่องเดิม = มุมใหม่/ขยับเรื่องไปข้างหน้า (ไม่มีมุมใหม่ = ไม่ทักครั้งที่สอง)
// 12 ต.ค. 2026: ไม้แรกที่เคยกั้นราคาไว้ (screen_price ของก่อนแก้) = ไม้ที่สองแจ้งราคาเลย · แจ้งราคา/ส่งของไปแล้ว = จบ
function forwardKind(kind, { quoted, goal }) {
  if (kind === "level") return "work";
  if (kind === "screen_price") return quoted ? null : "price_owed";
  if (["screen_light", "price_owed", "deliver", "decision"].includes(kind)) return null;
  if (["round_choice", "rounds_offer", "class_choice"].includes(kind)) return "after_price";
  if (kind === "work" || kind === "question") return quoted ? "after_price" : goal ? "goal" : null;
  return null;
}

const HEADCOUNT_ASK_RE = /คนเดียว|ทีม|กี่\s?(?:คน|ท่าน)|จำนวน(?:คน|ผู้เรียน)|พนักงาน|เรียนเองหรือ|พา(?:เพื่อน|ทีม|คน)/u;
const DISMISSIVE_RE = /^(?:no+|nope|nah|ไม่สนใจ\S{0,8}|ไม่ต้อง(?:การ)?\S{0,8}|ไม่เป็นไร\S{0,8}|[\p{P}\p{S}]+)$/iu;
const BARE_NO_RE = /^ไม่(?:ค่ะ|คะ|ค่า|ครับ|คับ|อะ|อ่ะ|จ้า)?$/u;
const YES_NO_ASK_RE = /ไหม|มั้ย|หรือยัง|หรือเปล่า|รึเปล่า|ใช่ไหม/u;
function dismissiveReply(customerText, prevBotText) {
  const bare = String(customerText || "").replace(EMOJI_OR_SPACE, "");
  if (!bare || DISMISSIVE_RE.test(bare)) return true;
  return BARE_NO_RE.test(bare) && !YES_NO_ASK_RE.test(lastQuestionOf(prevBotText));
}
const none = (reason) => ({ thread: null, reason });

// 12 ต.ค. 2026: ก้อนลูกแพรที่อยู่ก่อนแถว index (ข้ามแถวลูกค้า) — "" = ไม่มี
function botBurstBefore(list, index) {
  let end = index - 1;
  while (end >= 0 && list[end].role === "user") end -= 1;
  if (end < 0) return "";
  let from = end;
  while (from > 0 && list[from - 1].role === "assistant") from -= 1;
  return list.slice(from, end + 1).map((row) => row.text).join("\n");
}
// ชนิดของข้อเสนอในประโยคคำถามท้ายก้อน ("อยากดูหัวข้อ…ไหมคะ?" = outline) — ไม่ใช่ข้อเสนอ = ""
function offerTypeOf(question = "") {
  if (!question || !OFFER_ACTOR.test(question) || !OFFER_CLOSE.test(question)) return "";
  return CLOSING_TYPES.find(([, re]) => re.test(question))?.[0] || "";
}
// ลูกค้าเลือกรอบไปแล้วในห้องนี้ (ห้อง 36e2bccc: "เสาร์14/11 พอได้ครับ" แล้วยังโดนถามเทียบรอบ)
function roundPickedInRoom(list) {
  for (let i = 1; i < list.length; i += 1) {
    const row = list[i];
    if (row.role !== "user" || row.media) continue;
    const lastBotText = botBurstBefore(list, i);
    if (!lastBotText) continue;
    // (วันที่แบบตัวเลข "เสาร์14/11" อ่านด้วย stage.numericRoundPickOf ภายใน roundPickedIn — ตัวเดียวกับเส้นตอบ)
    if (roundPickedIn({ text: row.text, lastBotText, prevRole: list[i - 1].role === "user" ? "user" : "assistant" })) return true;
  }
  return false;
}
// ก้อนลูกแพรที่เล่าภาพรวมคลาสแล้ว (เทิร์นแรกแบบใหม่ 12 ต.ค.: ขอรายละเอียด/ถามมา = ตอบจากข้อมูลจริงก่อนบันได)
// — ตัวปรับ details/answer_first ของ v3 หรือก้อนนั้นเอ่ยชื่อทั้งสองคลาส
const OVERVIEW_MODIFIERS = Object.freeze(["details", "answer_first"]);
const overviewGiven = (meta, burst) => OVERVIEW_MODIFIERS.some((name) => (meta?.modifiers || []).includes(name)) || classesNamedIn([burst]).size > 1;
// ของที่ลูกค้าขอไว้ในก้อนล่าสุดแล้วยังไม่ได้ (ได้บันได/คัดกรอง/คำว่ายืนยันไม่ได้ หรือได้ข้อเสนอเรื่องเดิมซ้ำแทนของจริง)
// รวมการตอบรับข้อเสนอ ("ส่งมาเลยครับ") ที่ได้ข้อเสนอเดิมซ้ำกลับมา — "" = ไม่มีของค้าง
// รีวิว 12 ต.ค.: เทิร์นแรก/แบ่งรับราคาที่เล่าภาพรวมคลาสไปแล้ว = ส่งของแล้ว (ไม่ส่งรายละเอียดซ้ำพร้อมบอกว่า "ยังไม่ได้รับ")
function undeliveredRequest({ customerText, recentText = "", burst, meta, question, prevBotText }) {
  const missed = (["FIRST_CONTACT", "SCREEN_PRICE"].includes(meta?.stage) && !overviewGiven(meta, burst)) || NOT_DELIVERED_RE.test(burst);
  const reoffer = offerTypeOf(question);
  const asked = DETAILS_ASK_RE.test(customerText) ? "details" : LINK_ASK_RE.test(customerText) ? "link" : "";
  if (asked && (missed || reoffer === OFFER_TYPE_OF_ITEM[asked])) return asked;
  const askedBefore = DETAILS_ASK_RE.test(recentText) ? "details" : LINK_ASK_RE.test(recentText) ? "link" : "";
  if (askedBefore && reoffer && reoffer === OFFER_TYPE_OF_ITEM[askedBefore]) return askedBefore;
  // ตอบรับข้อเสนอของก้อนก่อน แล้วได้ข้อเสนอเดิมซ้ำ/ยืนยันไม่ได้
  const accepted = (bareAck(customerText) || ACCEPT_RE.test(customerText)) ? offerTypeOf(lastQuestionOf(prevBotText)) : "";
  const item = Object.keys(OFFER_TYPE_OF_ITEM).find((key) => OFFER_TYPE_OF_ITEM[key] === accepted && key !== "price") || "";
  if (item && item !== "enrol" && (missed || reoffer === accepted)) return item;
  return "";
}

/**
 * เลือกเรื่องที่ค้างอยู่เรื่องเดียวของห้อง + ไม้ที่ใช้ได้ (โหมดของช่วงเงียบ)
 * @param {{rows: object[], priceQuoted?: boolean, priceOwed?: boolean, painPoint?: string, rounds?: object[], history?: object[]}} input
 *   rows = followupRows(...) · history = state.history ของบันไดทักตาม (ไม้ที่ส่งไปแล้ว มี thread/at) · rounds = รอบในอนาคตจากแหล่งเดียวกับเส้นตอบ
 *   priceOwed = ห้องนี้เคยถูกแบ่งรับราคาไว้ (customers.price_deferred_at / price_pivot_deferred_at)
 * @returns {{thread: object|null, plan?: object, reason: string}}
 *   plan = { mode, minStep, minOffsetMs, floorAt, questionOnly, maxTouches, morningAfter, withReview }
 *   (stagedFollowups.threadStepPlan แปลงเป็นไม้ของบันได)
 */
export function pickFollowupThread({ rows = [], priceQuoted = false, priceOwed = false, painPoint = "", rounds = [], history = [] } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // ข้อความล่าสุดที่ลูกค้า "พิมพ์" — สติกเกอร์/รูปที่ส่งตามมาไม่ได้ปิดเรื่องที่ค้าง และไม่เปิดช่วงเงียบใหม่ (รอบรีวิว 8 C6)
  const lastIn = list.findLastIndex((row) => row.role === "user" && !row.media);
  if (lastIn < 0) return none("no_customer_turn");
  const typedAt = Number(list[lastIn].at) || 0;
  const reactive = list.slice(lastIn + 1).filter((row) => row.role === "assistant" && !row.proactive);
  // ลูกค้าพิมพ์เป็นคนสุดท้ายแล้วไม่มีใครตอบ (เงียบโดยเจตนา/รอทีม) = ไม่มีเรื่องที่ลูกแพรค้างไว้
  if (!reactive.length) return none("customer_last");
  const customerStart = list.slice(0, lastIn + 1).findLastIndex((row) => row.role !== "user") + 1;
  const customerText = list.slice(customerStart, lastIn + 1).filter((row) => !row.media).map((row) => row.text).join("\n");
  const isAdminRow = (row) => row.admin || row.text.startsWith(ADMIN_PREFIX);
  const allHistory = Array.isArray(history) ? history : [];

  // 12 ต.ค. 2026 (คำสั่งพี่ง้วง): ลูกค้าพิมพ์มาแค่ข้อความแรกแล้วไม่เคยตอบลูกแพรเลย = ทักได้ครั้งเดียวตลอดอายุห้อง
  // (ห้อง 94f42134: "สนใจครับ" → บันได → ทักวันแรก → ทักซ้ำวันถัดไป) — นับทุกไม้ทักตามหลังข้อความนั้น ทั้งแบบมีเรื่องและแบบเดิม
  const firstReply = list.findIndex((row) => row.role === "assistant" && !row.proactive);
  const openingOnly = firstReply < 0 || !list.slice(firstReply + 1).some((row) => row.role === "user" && !row.media);
  const prior = allHistory.filter((item) => Number(item?.at) > typedAt);
  // ข้อยกเว้นเดียว: ไม้ก่อนหน้าของห้องนี้ทุกไม้คือไม้ที่ "กั้นราคา" (ก่อนแก้ 12 ต.ค.) และลูกค้ายังไม่เคยได้ตัวเลข = แจ้งราคาได้อีกหนึ่งครั้ง
  const withheldOnly = prior.length > 0 && prior.every((item) => WITHHELD_PRICE_KINDS.has(item?.thread));
  if (openingOnly && prior.length && !withheldOnly) return none("opening_only_followed");

  // ทีมงานพิมพ์เป็นคนสุดท้าย: ทีมถามค้าง = ทักต่อจากคำถามนั้น · ทีมปิดห้อง/ไม่ได้ถาม = ห้องของคนจริง ไม่ทักแทรก
  let askedBy = "lukprae";
  let burstRows;
  if (isAdminRow(reactive.at(-1))) {
    burstRows = trailing(reactive, isAdminRow);
    const adminText = burstRows.map((row) => row.text.replace(ADMIN_PREFIX, "").trim()).join("\n");
    if (!lastQuestionOf(adminText)) return none(BOT_FAREWELL.test(lastLine(adminText)) ? "stop:operator_closed" : "operator_last");
    askedBy = "team";
  } else {
    burstRows = trailing(reactive, (row) => !isAdminRow(row));
  }
  const burst = burstRows.map((row) => row.text.replace(ADMIN_PREFIX, "").trim()).join("\n");
  const meta = askedBy === "team" ? null : [...burstRows].reverse().find((row) => row.meta)?.meta || null;
  const modeInfo = modeOf(meta, customerText);
  if (modeInfo.stop) return none(`stop:${modeInfo.stop}`);
  if (dismissiveReply(customerText, botBurstBefore(list, customerStart))) return none("stop:dismissive");
  let mode = modeInfo.mode;

  let question = lastQuestionOf(burst);
  if (question && isGenericSentence(question)) question = "";
  const burstQuestion = question;
  let kindBurst = burst;
  let kindMeta = meta;
  // ลูกค้าลาเอง และลูกแพรไม่ได้ถามอะไรต่อ = ห้องปิดอย่างอบอุ่นแล้ว · ลูกแพรยังถามต่อ = คุยต่อจากคำถามนั้น
  if (mode === "goodbye") {
    if (!question) return none("stop:goodbye");
    mode = "normal";
  }
  // รอบรีวิว 8 (U4): ก้อนล่าสุดไม่มีคำถาม (ลูกค้าตอบรับเฉย ๆ/ถามเรื่องอื่น แล้วลูกแพรหรือเครื่องเดิมปิดด้วยคำลา) = ไม่ใช่ลูกค้าปิด
  // → ย้อนหาคำถามที่ยังค้าง (ห้อง e67a92d5: ชวนเลือกรอบไว้ ลูกค้าถามเรื่องอื่นสองข้อ แล้ว "ok ครับ")
  if (!question && askedBy === "lukprae") {
    const found = lookBackQuestion(list, lastIn);
    if (found) ({ question, text: kindBurst, meta: kindMeta } = found);
  }

  const botTexts = list.filter((row) => row.role === "assistant" && !row.admin).map((row) => row.text);
  const quoted = Boolean(priceQuoted) || botTexts.some((text) => PRICE_CARD.test(text));
  const labels = threadRoundLabels(rounds, [kindBurst, ...botTexts.slice(-8)]);
  const burstLabels = threadRoundLabels(rounds, [kindBurst]);
  // คลาสยังไม่ได้เลือก: ก้อนล่าสุด/การ์ดราคาเล่าทั้งสองคลาส และไม่มีรอบของคลาสเดียวที่คุยกันอยู่
  const pricedTexts = botTexts.filter((text) => PRICE_CARD.test(text)).slice(-2);
  const classOpen = !labels.length && (classesNamedIn([kindBurst]).size > 1 || classesNamedIn(pricedTexts).size > 1);
  let kind = null;
  const screened = askedBy === "lukprae" && (kindMeta?.stage === "SCREEN_PRICE" || PRICE_PROMISE.test(kindBurst));
  if (screened) kind = "screen_price";
  else if (askedBy === "lukprae" && (kindMeta?.stage === "FIRST_CONTACT" || KEYCAP_LINE.test(kindBurst) || LADDER_ASK.test(question))) kind = "level";
  else if (question) {
    kind = BOOKING_ASK.test(question) ? "booking" : ROUND_CHOICE_ASK.test(question) ? "round_choice"
      : ROUNDS_OFFER_ASK.test(question) ? "rounds_offer" : WORK_ASK.test(question) ? "work" : "question";
  } else if (classesNamedIn([kindBurst]).size > 1) kind = "class_choice";
  else if (burstLabels.length) kind = "round_choice";
  const registration = Boolean(question) && (kind === "booking" || REGISTRATION_ASK.test(question) || kindMeta?.stageReason === "accepted_round_pick");
  const convo = list.slice(0, lastIn + 1).filter((row) => !row.media).map((row) => ({ role: row.role, content: row.text }));
  // รีวิวเคสจริง 6–7 ต.ค.: ลูกค้าบอกระดับไปแล้ว ("เพิ่งรู้จัก ไม่เคยใช้") แต่ลูกแพรยังส่งบันได — ทักตามห้ามถามระดับซ้ำ
  // รอบรีวิว 8 (U6): บอกระดับเป็นนัยแล้ว = ถามเรื่องงานแทน (เดิมไม่มีเรื่องค้าง = ไม่ทัก เสียลูกค้าใหม่)
  if (kind === "level" && (impliedLevelOf(convo.slice(0, -1), convo.at(-1)?.content || "") || LEVEL_TOLD_RE.test(customerText))) {
    kind = "work";
    question = "";
  }
  // รีวิวเคสจริง 6–7 ต.ค.: หลังแจ้งราคาแล้ว เรื่องที่ค้างแบบทำความรู้จัก (ประเภทสินค้า/งาน/ระดับ/เคยสร้าง Custom AI ไหม) ไม่ใช่ก้าวถัดไป
  // — ทักตามพาไปเลือกรอบของคลาสที่คุยกัน · ยังไม่ได้เลือกคลาส = ถามว่าสนใจคลาสไหน · ไม่มีรอบให้อ้าง = ถามว่ายังติดเรื่องไหน
  // รอบรีวิว 8 (U5): เห็นราคาแล้วไม่มีคำถามค้าง ก็พาไปก้าวถัดไปเหมือนกัน (เดิมตกไปเป็นทิปเรื่องงาน ดึงห้องที่เห็นราคาแล้วกลับไปทำความรู้จัก)
  const nextAfterPrice = () => (labels.length ? "round_choice" : classOpen ? "class_choice" : "after_price");
  if (quoted && (kind === null || DISCOVERY_KINDS.has(kind))) kind = nextAfterPrice();
  const goalText = quoted ? "" : String(painPoint || "").trim()
    || learningGoal({ text: convo.at(-1)?.content || "", history: convo.slice(0, -1) })?.evidence || "";
  const goal = goalText ? truncateCodePoints(goalText.replace(/\s+/gu, " ").trim(), 160) : "";
  if (!kind && goal) kind = "goal";

  // 12 ต.ค. 2026 (คำสั่งพี่ง้วง): ทักตาม "ส่งของที่ค้าง" ไม่ใช่ถามซ้ำ
  //   ราคาค้างจ่าย = เคยแบ่งรับราคา / ลูกค้าเคยถามราคา (อ่านคำพิมพ์ผิด) / บอกจะสมัคร / เลือกรอบแล้ว — แต่ยังไม่เคยได้ตัวเลข
  //   ของที่ขอแล้วไม่ได้ (รายละเอียด/ลิงก์) = ส่งของนั้น · เลือกรอบแล้วและเห็นราคาแล้ว = ไม่ถามเทียบรอบซ้ำ (ขั้นสมัคร)
  // รีวิว 12 ต.ค.: อ่านทีละแถวลูกค้าด้วยตัวอ่านของด่านราคา · "จะสมัคร" ใช้ตัวอ่านของเส้นตอบ (ไม่นับ "ไม่ได้จะสมัคร" · "เคยสมัครที่อื่น"
  // · ลังเล/สมัครไปแล้ว) · ห้องนักเรียนเก่า/สองคลาส และงานทีม = ไม่แจ้งราคาคลาสเดี่ยวเอง
  const typedRows = list.filter((row) => row.role === "user" && !row.media);
  const roundPicked = roundPickedInRoom(list);
  const askedPrice = typedRows.some((row) => asksOurPrice(row.text));
  const projectRoom = typedRows.some((row) => PROJECT_ROOM_RE.test(row.text));
  const oldStudent = typedRows.some((row) => OLD_STUDENT_BUNDLE.test(row.text));
  // ราคาค้างเพราะอะไร (ถ้อยคำของบรรทัดสั่งงานตามเหตุ): ถาม/เคยแบ่งรับไว้ · เลือกรอบแล้ว · บอกว่าจะสมัคร
  const priceTrigger = Boolean(priceOwed) || screened || askedPrice ? "asked" : roundPicked ? "round" : enrollIntentOf(customerText) ? "enrol" : "";
  // (ทีมงานพิมพ์ถามเป็นคนสุดท้าย = ห้องของคนจริง ไม่แจ้งราคาแทรก)
  const owesPrice = askedBy === "lukprae" && !quoted && !projectRoom && !oldStudent && Boolean(priceTrigger);
  // คัดกรองก่อนแจ้งราคาค้างอยู่ แต่ห้องนี้ทักตามแจ้งราคาเองไม่ได้ (งานทีม/นักเรียนเก่า) = ทักต่อจากคำถามที่ค้างแทน (ไม่ใช่บรรทัดแจ้งราคา)
  if (kind === "screen_price" && !owesPrice && !quoted) kind = question ? "question" : goal ? "goal" : null;
  let deliver = "";
  if (owesPrice && !registration) kind = "price_owed";
  else if (askedBy === "lukprae" && !registration) {
    const recentText = typedRows.filter((row) => typedAt - (Number(row.at) || 0) <= DAY_MS).map((row) => row.text).join("\n");
    deliver = undeliveredRequest({ customerText, recentText, burst, meta, question: burstQuestion, prevBotText: botBurstBefore(list, customerStart) });
    if (deliver) kind = "deliver";
  }
  if (kind === "screen_price" && quoted) kind = nextAfterPrice();
  // เลือกรอบแล้ว + เห็นราคาแล้ว: คำถามเรื่องรอบ/วันเรียนที่ค้าง (รวม "เทียบรอบ…ไหมคะ") = ขั้นสมัคร ไม่ถามรอบซ้ำ
  const roundsTopic = CLOSING_TYPES.find(([type]) => type === "rounds")?.[1];
  if (roundPicked && quoted && (["round_choice", "rounds_offer"].includes(kind) || (kind === "question" && roundsTopic?.test(question)))) kind = "booking";
  if (["price_owed", "deliver"].includes(kind)) question = "";

  // ห้องที่ได้ราคาแล้ว: ต้องเสนอผู้บริหาร/หัวหน้า หรืองบ/ทุนยังไม่พร้อม = ไม่เร่ง (ห้อง fd7e6b8d · 2071698b)
  // อ่านเฉพาะข้อความลูกค้าหลังการ์ดราคา (ลูกค้าบอกเรื่องงบแล้วตามด้วย "ได้ค่ะ") — รีวิว 12 ต.ค.: ข้อความที่ถามราคาเอง
  // ("ผมทำงาน HR ครับ ค่าเรียนเท่าไหร่" → การ์ด → เงียบ) ไม่ใช่การรอผู้บริหาร · การ์ดที่ลูกแพรส่งซ้ำในคำตอบล่าสุด = อ่านตั้งแต่การ์ดก่อนหน้า
  // ไม่มีการ์ดก่อนหน้า = นับก้อนล่าสุดเฉพาะเมื่อมีคำว่ารอ/ส่งต่อ/เสนอผู้มีอำนาจ (ห้อง fd7e6b8d: "แจ้งราคาไปยังผู้บริหารเพื่อพิจารณา" แล้วได้การ์ดซ้ำ)
  const isCard = (row) => row.role === "assistant" && PRICE_CARD.test(row.text);
  const userTextFrom = (index) => list.slice(index).filter((row) => row.role === "user" && !row.media).map((row) => row.text).join("\n");
  const cardAt = list.findLastIndex(isCard);
  const cardBefore = list.slice(0, customerStart).findLastIndex(isCard);
  const sincePrice = cardAt >= customerStart
    ? (cardBefore >= 0 ? userTextFrom(cardBefore + 1) : decisionWhoOf(customerText) ? customerText : "")
    : cardAt >= 0 ? userTextFrom(cardAt + 1) : customerText;
  const execWho = decisionWhoOf(sincePrice) || (mode === "consult" ? decisionWhoOf(customerText) : "");
  const budgetWait = BUDGET_WAIT_RE.test(sincePrice);
  if (quoted && (mode === "normal" || mode === "defer" || (mode === "consult" && execWho)) && (execWho || budgetWait) && !registration) {
    mode = "decision";
    kind = "decision";
  }

  // โหมดทักครั้งเดียวนี้เป็น fallback ของ instance ที่ไม่ได้เปิด durable suppression เท่านั้น:
  // ถ้า instance เปิด CUSTOMER_FOLLOWUP_SUPPRESSION_ENABLED ข้อความ "ขอคิดก่อน" จะปิด followup_enabled
  // ตั้งแต่ inbound และไม่มาถึง picker นี้ ส่วน "ขอเช็กคิว" ที่ยัง eligible ใช้ schedule-check one-shot แยกต่างหาก
  // ห้ามใช้แผนตรงนี้เปิดห้องที่ durable suppression ปิดไว้เพื่อไล่ engagement
  // โหมดทักครั้งเดียว: ขอเวลาคิด = ผูกกับเรื่องที่ยังตัดสินใจ (ยังไม่ได้ราคา = ข้อเสนอส่งรอบให้ดูหนึ่งข้อ ไม่ใช่คำถามทำความรู้จัก)
  // · รอปรึกษา/รอเงิน = เช็กอินของเรื่องนั้นเอง
  if (mode === "defer" && !["screen_price", "price_owed", "deliver", "booking", "round_choice", "class_choice", "after_price"].includes(kind) && !registration) kind = "rounds_offer";
  if (mode === "consult" || mode === "money_wait") kind = mode;
  if (!kind) return none("no_open_thread");
  // ห้องที่ทักไปแล้วด้วยไม้กั้นราคาอย่างเดียว: ไม้นี้ต้องเป็นการแจ้งราคา ไม่งั้นจบ (ห้องที่พิมพ์มาแค่ข้อความแรก)
  const redeliverPrice = withheldOnly && kind === "price_owed";
  if (openingOnly && prior.length && !redeliverPrice) return none("opening_only_followed");

  // ครั้งที่ทักไปแล้วในช่วงเงียบนี้ (นับจากข้อความที่ลูกค้าพิมพ์ล่าสุด)
  const touches = allHistory.filter((item) => item?.thread && Number(item.at) > typedAt);
  // 12 ต.ค. 2026: ห้องที่ได้ราคาแล้ว / ลูกค้าพิมพ์มาแค่ข้อความแรก = ครั้งเดียว
  const maxTouches = mode === "normal" && !registration && !quoted && !openingOnly ? 2 : 1;
  let floorAt = 0;
  let prevTouchAt = 0;
  if (redeliverPrice) {
    // แจ้งราคาที่ค้างหลังไม้กั้นราคาของก่อนแก้ — เว้นจากไม้ก่อนเหมือนครั้งที่สอง (Facebook ใช้ช่อง "ช้า")
    prevTouchAt = Math.max(...prior.map((item) => Number(item.at) || 0));
    floorAt = prevTouchAt + SECOND_TOUCH_MIN_GAP_MS;
  } else if (touches.length >= maxTouches) return none("thread_already_followed");
  else if (touches.length === 1) {
    prevTouchAt = Number(touches[0].at) || 0;
    const next = forwardKind(touches[0].thread, { quoted, goal });
    if (!next) return none("thread_already_followed");
    kind = next;
    floorAt = Number(touches[0].at) + SECOND_TOUCH_MIN_GAP_MS;
    question = "";
  }
  const who = mode === "consult" ? (CONSULT_WHO.exec(customerText)?.[0] || "") : mode === "decision" ? execWho : "";
  const oneShot = mode !== "normal" || registration;
  // ห้องที่ได้ราคาแล้ว (และต้องเสนอผู้บริหาร/รองบ) = ทักครั้งเดียวเช้าวันถัดไป (นับจากข้อความที่ลูกค้าพิมพ์ล่าสุด)
  const morningAfter = quoted && ["normal", "defer", "decision"].includes(mode) && !registration ? typedAt : 0;
  const priceClasses = [...classesNamedIn(botTexts.slice(-8))];
  const topicRow = typedRows.findLast((row) => !bareAck(row.text) && !dismissiveReply(row.text, "") && [...row.text].length >= 8);
  return {
    thread: {
      kind, question: truncateCodePoints(question, 160), roundLabels: ROUND_KINDS.has(kind) ? labels : [],
      goal: ["goal", "rounds_offer"].includes(kind) ? goal : "", priceQuoted: quoted, askedBy, registration, mode,
      touch: redeliverPrice ? prior.length + 1 : touches.length + 1, who,
      customerTopic: topicRow ? truncateCodePoints(topicRow.text.replace(/\s+/gu, " ").trim(), 160) : "",
      deliver, budget: mode === "decision" && !execWho && budgetWait, openingOnly,
      // ราคาค้างเพราะอะไร (asked · round · enrol) · ก้อนที่ค้างเล่าภาพรวมคลาสไปแล้ว (เรื่องระดับไม่เล่าซ้ำ)
      priceTrigger: PRICE_KINDS.has(kind) ? priceTrigger || "asked" : "",
      overviewSent: kind === "level" && overviewGiven(kindMeta, kindBurst),
      // คลาสของบล็อกค่าเรียน: คุยกันอยู่คลาสเดียว = คลาสนั้น · ไม่ชัด = ทั้งสองคลาส
      priceClasses: priceClasses.length === 1 ? priceClasses : ["business", "workflow"],
    },
    plan: {
      mode, maxTouches,
      // ไม้เร็ว (+45 นาที / +4 ชม.) ข้ามเมื่อขอเวลาคิด หรืออยู่ขั้นสมัคร (ใช้ไม้หลัง)
      minStep: mode === "defer" || registration ? 1 : 0,
      minOffsetMs: mode === "consult" ? CONSULT_AFTER_MS : mode === "money_wait" ? MONEY_WAIT_AFTER_MS : 0,
      floorAt, prevTouchAt, morningAfter,
      // ทักครั้งเดียว/ขั้นสมัคร = คำถามอย่างเดียว ไม่มีรีวิว/รูปบรรยากาศแทรก
      questionOnly: oneShot,
      // แจ้งราคาที่ค้าง / ลูกค้าขอคลิปรีวิว = แนบรีวิวผู้เรียนจริงต่อท้ายถ้ามีในคลัง (คำสั่งพี่ง้วง "ส่งรีวิวด้วย แล้วแต่บริบท")
      withReview: !oneShot && (kind === "price_owed" || (kind === "deliver" && deliver === "link")),
    },
    reason: "thread",
  };
}

const q = (text) => `"${truncateCodePoints(String(text || ""), 160)}"`;
// เหตุที่ราคาค้าง → ประโยคเปิดของบรรทัดสั่งงาน + ก้าวถัดไปที่ไม่ถามสิ่งที่ลูกค้าตอบแล้ว
const PRICE_TRIGGER_TEXT = Object.freeze({
  asked: { lead: "ลูกค้าถามค่าเรียนไว้และยังไม่ได้รับตัวเลข",
    next: "แล้วถามเบา ๆ ข้อเดียวที่พาไปก้าวถัดไป เช่น อยากให้ลูกแพรส่งรอบที่เปิดอยู่ให้ดูไหม" },
  round: { lead: "ลูกค้าเลือกรอบเรียนไว้แล้ว แต่ยังไม่ได้รับค่าเรียน",
    next: "แล้วถามเบา ๆ ข้อเดียวว่าให้ลูกแพรส่งรายละเอียดการสมัครรอบที่เขาเลือกให้เลยไหม — ไม่ถามเรื่องรอบซ้ำ (ทีมงานเป็นผู้ยืนยันที่นั่ง ไม่บอกว่ากันที่ไว้ให้)" },
  enrol: { lead: "ลูกค้าบอกไว้ว่าจะสมัครเรียน แต่ยังไม่ได้รับค่าเรียน",
    next: "แล้วถามเบา ๆ ข้อเดียวที่พาไปขั้นสมัคร เช่น สะดวกเริ่มรอบไหน หรืออยากให้ลูกแพรส่งรายละเอียดการสมัครให้เลยไหม — ไม่ถามว่าสนใจไหมหรือพร้อมหรือยัง" },
});
const joinLabels = (labels = []) => labels.join(" · ");

/** บรรทัดสั่งงานของเรื่องที่ค้าง (ภาษาสั่งงานเชิงบวก — ตัวเลขเงินทุกตัวยังมาจากความรู้ที่อนุมัติและด่านราคาเดิม) */
// 12 ต.ค. 2026 (คำสั่งพี่ง้วง): ทักตาม = ส่งของที่ค้าง ไม่ถามซ้ำ · ราคาที่ค้าง = แจ้งเลยพร้อมคุณค่า · ไม่สั่งให้ตอบเป็นเลข/ตอบแค่…
export function threadRuleLines(thread) {
  if (!thread?.kind) return [];
  const labels = joinLabels(thread.roundLabels);
  const asked = thread.askedBy === "team" ? "ทีมงานถามไว้ว่า" : "ลูกแพรถามไว้ว่า";
  const value = `(${FOLLOWUP_VALUE_POINTS})`;
  // รีวิว 12 ต.ค.: ถ้อยคำตามเหตุที่ราคาค้างจริง — ไม่บอกว่าลูกค้าถามราคา ในห้องที่เขาแค่บอกว่าจะสมัครหรือเลือกรอบไว้
  const trigger = PRICE_TRIGGER_TEXT[thread.priceTrigger] || PRICE_TRIGGER_TEXT.asked;
  const priceLine = `${trigger.lead}: ข้อความนี้แจ้งค่าเรียนเลย ไม่ถามพื้นฐานหรือคัดกรองก่อนอีก — `
    + "เปิดด้วยประโยคอบอุ่นสั้น ๆ วางบล็อกค่าเรียนที่ระบบเตรียมไว้ แล้วเล่าให้เห็นว่าค่าเรียนนี้ได้อะไรและคุ้มอย่างไร โดยเลือก 2–3 ข้อที่ตรงกับเขาจาก "
    + `${value} ให้ลูกค้าเห็นเองว่าต่างจากคอร์สราคาหลักร้อยหลักพันตรงไหน (ไม่เอ่ยชื่อ ไม่ตำหนิ และไม่กล่าวอ้างเรื่องของที่อื่น) `
    + trigger.next;
  // พี่ง้วง 13 ต.ค.: หลังให้ราคา ห้ามชวนหาข้อติดใจ ("ยังติดเรื่องไหน") — ลูกค้ารู้สึกว่าถูกถามว่าไม่สะดวกค่าเรียน
  const stuckAsk = "แล้วถามเบา ๆ ข้อเดียวแบบถ่อมตัวที่พาไปข้างหน้า เช่น \"ไม่ทราบว่ามีส่วนไหนที่อยากให้ลูกแพรเล่าเพิ่มไหมคะ\" — "
    + "ห้ามถามว่าติดเรื่องไหน ห้ามยกค่าเรียนหรืองบขึ้นมาเป็นข้อกังวล และไม่ถามเรื่องงานหรือระดับซ้ำ";
  const item = DELIVER_ITEM_LABELS[thread.deliver] || "ข้อมูลที่ขอไว้";
  // ลูกค้าขอคลิป/รีวิว: แนบได้จริงเท่านั้นถึงพูดถึงคลิป (รีวิว 12 ต.ค.: ห้ามสัญญาหรือเอ่ยถึงคลิปที่ระบบส่งไม่ได้)
  const deliverLink = thread.reviewAttached
    ? "ลูกค้าขอดูคลิปรีวิวหรือตัวอย่างงานไว้: ระบบแนบรีวิวจากผู้เรียนจริงต่อท้ายข้อความนี้ให้แล้ว (ไม่ต้องใส่ลิงก์เอง) — "
      + `เขียนนำสั้น ๆ อบอุ่น พร้อมสิ่งที่ลูกค้าจะได้ 2–3 ข้อที่ตรงกับเขา ${value} แล้วปิดด้วยคำถามเบา ๆ ข้อเดียวที่พาไปก้าวถัดไป`
    : "ลูกค้าขอดูรีวิวหรือตัวอย่างงานไว้ แต่ข้อความนี้ไม่มีไฟล์หรือคลิปแนบ: ไม่เอ่ยถึง ไม่สัญญา และไม่บอกว่าจะส่งคลิป ลิงก์ หรือไฟล์ — "
      + `เล่าสั้น ๆ จากข้อมูลที่อนุมัติว่าเรียนแล้วได้อะไรที่ตรงกับงานของเขา 2–3 ข้อ ${value} แล้วปิดด้วยคำถามเบา ๆ ข้อเดียวที่พาไปก้าวถัดไป`;
  const line = {
    screen_price: priceLine,
    screen_light: priceLine,
    price_owed: priceLine,
    deliver: thread.deliver === "link" ? `${deliverLink} — ไม่ถามพื้นฐานหรือคัดกรองก่อน`
      : `ลูกค้าขอ${item}ไว้แต่ยังไม่ได้รับ: ส่ง${item}ให้เลยจากข้อมูลที่อนุมัติ สรุปสั้น ๆ อ่านง่าย พร้อมสิ่งที่ลูกค้าจะได้ 2–3 ข้อที่ตรงกับเขา ${value} `
      + "— ไม่ถามพื้นฐานหรือคัดกรองก่อน และไม่บอกว่ายังยืนยันไม่ได้หรือไม่มีข้อมูล (ข้อมูลที่อนุมัติมีอยู่แล้ว) แล้วปิดด้วยคำถามเบา ๆ ข้อเดียวที่พาไปก้าวถัดไป",
    // รีวิว 12 ต.ค.: เทิร์นแรกแบบใหม่เล่าภาพรวมคลาสไปแล้ว = ไม่เล่าซ้ำ ให้ของชิ้นถัดไป (หัวข้อที่สอนของคลาสที่ตรงกับเขา) แทน
    level: thread.overviewSent
      ? "ลูกแพรเล่าภาพรวมคลาสและถามพื้นฐานการใช้ AI ไว้แล้ว ลูกค้ายังไม่ได้ตอบ: ไม่ถามระดับ ไม่ส่งรายการบันได และไม่เล่าภาพรวมคลาสหรือรายชื่อคลาสซ้ำ — "
        + `ให้ของชิ้นถัดไปแทน: เล่าสั้น ๆ หนึ่งข้อที่ยังไม่ได้เล่า ${value} แล้วถามเบา ๆ ข้อเดียวว่าอยากให้ลูกแพรส่งหัวข้อที่สอนของคลาสที่น่าจะตรงกับเขาให้ดูไหม`
      : "ลูกแพรถามพื้นฐานการใช้ AI ไว้ และลูกค้ายังไม่ได้ตอบ: ไม่ถามระดับหรือส่งรายการบันไดซ้ำ — ส่งสิ่งที่เป็นประโยชน์ให้แทน: "
        + `บอกสั้น ๆ ว่ามีคลาสอะไรบ้างและเหมาะกับใคร (ชื่อคลาสจากข้อมูลที่อนุมัติ) พร้อมจุดเด่น 2–3 ข้อ ${value} `
        + "แล้วถามเบา ๆ ข้อเดียวว่าอยากให้ลูกแพรส่งรายละเอียดคลาสไหนให้ดูก่อน",
    work: thread.question
      ? `${asked} ${q(thread.question)} ลูกค้ายังไม่ได้ตอบ: ไม่ถามคำถามนั้นซ้ำ — ให้สิ่งที่เป็นประโยชน์หนึ่งอย่างกับเรื่องที่เขาเล่าไว้ `
        + "(ไอเดียสั้น ๆ หรือส่วนของคลาสที่ช่วยงานนั้นได้) แล้วชวนคุยต่อด้วยคำถามใหม่ข้อเดียวที่ตอบง่าย"
      : `${thread.touch === 2 ? "ลูกแพรถามระดับการใช้ AI ไปแล้วรอบก่อน (ไม่ถามซ้ำ)" : "ลูกค้าบอกเรื่องการใช้ AI ของตัวเองมาแล้ว (ไม่ต้องถามระดับอีก)"}: `
        + "ถามข้อเดียวว่าอยากให้ AI ช่วยงานไหนก่อน พร้อมตัวเลือก 3–4 อย่าง ให้ตอบได้ง่าย",
    // feedback ทีม 10 ต.ค.: ลูกค้าเงียบหลังข้อเสนอส่งรอบ แล้วข้อความทักตามส่งรอบให้เอง (20 ห้องใน 3–10 ต.ค.) = ส่งข้อมูลขายที่เขายังไม่ได้ขอ
    // — เงียบเฉย ๆ = ทักต่อจากเรื่องของเขาเพื่อเข้าใจงานมากขึ้น (ขอเวลาคิด = ทักครั้งเดียว ให้รอบเป็นข้อมูลช่วยตัดสินใจตามเดิม)
    // (เห็นราคาแล้ว = ไม่ถอยกลับไปทำความรู้จัก ใช้ถ้อยคำก้าวถัดไปหลังราคาแทน)
    rounds_offer: thread.priceQuoted && thread.mode !== "defer"
      ? `ลูกค้าเห็นค่าเรียนแล้ว: เล่าสั้น ๆ หนึ่งข้อว่าค่าเรียนนี้ได้อะไรที่ตรงกับเขา ${value} ${stuckAsk} และไม่ส่งรายการรอบเอง`
      : thread.mode === "defer"
      ? `ลูกแพรเสนอส่งรอบเรียนให้ดูไว้ ลูกค้ายังไม่ได้ตอบ: ${labels
        ? `บอกรอบที่เปิดอยู่ตอนนี้ (${labels}) เป็นข้อมูลสั้น ๆ แล้วถามแบบถ่อมตัว เช่น "ไม่ทราบว่าคุณ(ชื่อ) สะดวกรอบไหนดีนะคะ?"`
        : "ถามเบา ๆ แบบถ่อมตัว เช่น \"ไม่ทราบว่าคุณ(ชื่อ) สนใจดูรอบเรียนที่เปิดอยู่ไหมคะ ลูกแพรส่งให้ค่ะ\" (ใส่ชื่อที่ใช้เรียกแทน (ชื่อ) · ไม่ต้องระบุวันที่)"}`
      : `ลูกแพรเสนอส่งรอบเรียนให้ดูไว้ ลูกค้ายังไม่ได้ตอบ: ไม่ส่งรายการรอบ ราคา หรือข้อมูลคลาสซ้ำเอง — ทักต่อจากเรื่องที่เขาเล่าไว้${thread.goal ? ` (${q(thread.goal)})` : ""} `
        + "ด้วยคำถามข้อเดียวที่ตอบง่าย เพื่อเข้าใจงานของเขามากขึ้น เช่น ทำธุรกิจหรือขายอะไรอยู่ หรืออยากให้ AI ช่วยส่วนไหนของงานนั้นก่อน "
        + "(ถ้าเขาเล่างานไว้ชัดแล้ว ถามว่าอยากรู้ส่วนไหนของคลาสเพิ่ม เช่น เนื้อหา รูปแบบการเรียน หรือวันเรียน)",
    round_choice: `${thread.priceQuoted ? "ลูกค้าเห็นค่าเรียนแล้ว และ" : ""}ลูกแพรชวนเลือกรอบไว้ ลูกค้ายังไม่ได้ตอบ: ไม่ถามซ้ำว่ารอบไหน — `
      + `เล่าสั้น ๆ หนึ่งข้อว่าค่าเรียนนี้ได้อะไรที่ตรงกับเขา ${value} ${labels ? `เอ่ยรอบที่เปิดอยู่ตอนนี้ (${labels}) เป็นข้อมูลได้ ` : ""}${stuckAsk}`,
    booking: `ลูกค้าเลือกรอบแล้ว${labels ? ` (${labels})` : ""} และลูกแพรเสนอส่งรายละเอียดการสมัครไว้ ลูกค้ายังไม่ได้ตอบ: ไม่ถามเรื่องรอบซ้ำ — ถามสั้น ๆ ว่าให้ลูกแพรส่งรายละเอียดการสมัครรอบนั้นให้เลยไหม `
      + "(ทีมงานเป็นผู้ยืนยันที่นั่ง ไม่บอกว่ากันที่ไว้ให้)",
    after_price: `${thread.priceQuoted ? "ลูกค้าเห็นค่าเรียนแล้ว: " : ""}เล่าสั้น ๆ หนึ่งข้อว่าค่าเรียนนี้ได้อะไรที่ตรงกับเขา ${value} ${stuckAsk}`,
    class_choice: `ลูกค้าเห็นข้อมูล${thread.priceQuoted ? "และค่าเรียน" : ""}ของทั้งสองคลาสแล้วแต่ยังไม่ได้เลือก: ถามเบา ๆ หนึ่งข้อว่าสนใจคลาสไหน `
      + "หรืออยากให้ลูกแพรช่วยเลือกให้เหมาะกับงาน — ไม่ถามเรื่องงานหรือระดับซ้ำ",
    question: thread.registration
      ? `ลูกค้าอยู่ขั้นสมัครแล้ว และ${asked} ${q(thread.question)} ลูกค้ายังไม่ได้ตอบ: ถามข้อนั้นอีกครั้งสั้น ๆ ด้วยคำใหม่ — ไม่เปิดเรื่องอื่น (ทีมงานเป็นผู้ยืนยันที่นั่ง)`
      : HEADCOUNT_ASK_RE.test(thread.question) && thread.customerTopic
      ? `${asked} ${q(thread.question)} ลูกค้ายังไม่ได้ตอบ: ห้ามเดาคำตอบแทนลูกค้า (ไม่พูดราวกับเขามีทีม ใช้คนเดียว หรือมีกี่คน) และไม่ถามเรื่องคน/ทีมอีก — `
        + `กลับไปต่อเรื่องที่ลูกค้าถามหรือเล่าไว้เองล่าสุด ${q(thread.customerTopic)}: ให้ขั้นตอนหรือคำแนะนำถัดไปหนึ่งอย่างของเรื่องนั้น แล้วถามคำถามใหม่ข้อเดียวเกี่ยวกับเรื่องนั้น`
      : `${asked} ${q(thread.question)} ลูกค้ายังไม่ได้ตอบ: ไม่ถามคำถามเดิมซ้ำ — ให้ข้อมูลที่ช่วยให้เขาตัดสินใจเรื่องนั้นได้ง่ายขึ้นหนึ่งอย่าง แล้วชวนคุยต่อด้วยคำถามใหม่ข้อเดียวที่ตอบง่าย`,
    goal: `ไม่มีคำถามค้าง สิ่งที่ลูกค้าเล่าเองคือ ${q(thread.goal)}: ให้ไอเดียที่ใช้ได้จริงหนึ่งบรรทัดกับเรื่องนั้น แล้วถามคำถามสั้นข้อเดียวที่ตอบง่าย`,
    consult: `ลูกค้าบอกว่าขอปรึกษา${thread.who || "คนที่เกี่ยวข้อง"}ก่อน (ทักครั้งเดียว): น้ำเสียงอบอุ่นและเป็นมืออาชีพ ไม่เร่ง — `
      + `ถามเบา ๆ ข้อเดียวว่าอยากให้ลูกแพรสรุปข้อมูลคลาสสั้น ๆ ไว้ให้ส่งต่อให้${thread.who || "เขา"}ดูไหม หรือยังติดตรงไหนที่ลูกแพรช่วยได้ `
      + "— ไม่ชวนเลือกรอบ ไม่ถามว่าตัดสินใจหรือยัง และไม่พูดว่า \"ค่อย ๆ คิด\"",
    money_wait: "ลูกค้าบอกว่ารอเงินเดือน/รอเงินเข้าก่อน (ทักครั้งเดียว): ทักแบบไม่กดดัน ถามเบา ๆ ข้อเดียวว่าอยากให้ลูกแพรส่งรอบที่เปิดถัดไปไว้ให้ดูก่อนไหม "
      + "— ไม่เร่ง ไม่พูดเรื่องเงินหรือเงินเดือน ไม่ถามว่าพร้อมจ่ายหรือยัง",
    // 12 ต.ค. 2026 (คำสั่งพี่ง้วง): เราขายคลาสหลักหมื่นถึงหลักแสน — อบอุ่นมาก และเป็นมืออาชีพ
    decision: thread.budget
      ? "ลูกค้าเห็นค่าเรียนแล้วและบอกว่างบหรือทุนยังไม่พร้อม (ทักครั้งเดียว): น้ำเสียงอบอุ่นมากและเป็นมืออาชีพ ไม่เร่ง ไม่ชวนเลือกรอบ "
        + "ไม่พูดเรื่องโปรหรือส่วนลดเอง และไม่พูดว่า \"ค่อย ๆ คิด\" — ถามเบา ๆ ข้อเดียวว่าตอนนี้ติดตรงไหน หรืออยากได้ข้อมูลส่วนไหนเพิ่มเพื่อวางแผน "
        + "และบอกว่าลูกแพรยินดีประสานงานให้"
      : `ลูกค้าเห็นค่าเรียนแล้วและต้องเสนอ${thread.who || "ผู้มีอำนาจตัดสินใจ"}ก่อน (ทักครั้งเดียว): น้ำเสียงอบอุ่นมากและเป็นมืออาชีพ ไม่เร่ง ไม่ชวนเลือกรอบ `
        + `และไม่พูดว่า "ค่อย ๆ คิด" — ถามเบา ๆ ข้อเดียวว่าตอนนี้ติดตรงไหน หรืออยากได้ข้อมูลเพิ่มเติม สรุปข้อมูลคลาส หรือเอกสารสำหรับ${thread.who || "ผู้มีอำนาจตัดสินใจ"}ไหม `
        + "และบอกว่าลูกแพรยินดีประสานงานให้",
  }[thread.kind];
  if (!line) return [];
  const lead = thread.mode === "defer" ? "ลูกค้าขอเวลาคิดไว้ ข้อความนี้เป็นการทักครั้งเดียวของช่วงนี้ — " : "";
  return [
    "เรื่องที่ค้างอยู่ในห้องนี้ (ระบบอ่านจากบทสนทนาแล้ว) — ข้อความทักตามนี้กลับไปที่เรื่องนี้เรื่องเดียว:",
    `- ${lead}${line}`,
    DELIVER_KINDS.has(thread.kind)
      ? "- ส่งของที่ค้างให้ครบในข้อความนี้ เหมือนแอดมินที่จำได้ว่าลูกค้าขออะไรไว้ — ไม่ชี้ว่าลูกค้ายังไม่ได้ตอบ และไม่ถามซ้ำสิ่งที่ถามไปแล้ว"
      : thread.touch === 2
      ? "- นี่คือการทักครั้งที่สองของเรื่องนี้: เปลี่ยนมุมหรือขยับเรื่องไปข้างหน้าตามบรรทัดบน ไม่ถามคำถามเดิมซ้ำ และไม่ชี้ว่าลูกค้ายังไม่ได้ตอบ"
      : "- ทักต่อจากเรื่องนี้แบบเบา ๆ เหมือนคุยต่อจากเมื่อกี้ ด้วยคำถามใหม่ — ไม่ชี้ว่าลูกค้ายังไม่ได้ตอบ และไม่เปิดเรื่องใหม่",
  ];
}

/**
 * ด่านหลังร่าง: ตัดประโยคกว้าง ๆ ออก — เหลืออะไรไม่ได้ / เรื่องที่ต้องถามแต่ไม่เหลือคำถาม = "" (ไม่ส่ง)
 * ทีละบรรทัด ทีละประโยค (ประโยคที่มีเรื่องของลูกค้าอยู่ด้วยในประโยคเดียวกันโดนตัดทั้งประโยค — ถ้อยคำสั่งงานบอกไว้แล้วว่าไม่ใช้)
 * รอบรีวิว 8 (U8): คำถามที่มีเรื่องจริง (วันเรียน/ค่าเรียน/เนื้อหา/รอบ/ชื่อคลาส) ไม่ถูกตัด แม้มีคำกว้าง ๆ ปน
 * 12 ต.ค. 2026: ประโยคที่สั่งให้ลูกค้าตอบแบบใดแบบหนึ่ง ("ตอบเป็นเลขเดียวได้เลยค่ะ" · "ตอบแค่ เคย หรือ ยัง") ตัดทิ้งเสมอ
 */
export function stripGenericFollowup(text = "", { needsQuestion = true } = {}) {
  const lines = squashSpaces(text).split("\n").map((line) => {
    // อีโมจิที่ติดท้ายประโยคกว้าง ๆ ที่ตัดทิ้ง ไปพร้อมประโยคนั้น
    let dropped = false;
    const kept = sentencesOf(line).filter((sentence) => {
      if (!/\p{L}/u.test(sentence)) return !dropped;
      dropped = isGenericSentence(sentence) || DEMAND_ANSWER_RE.test(sentence);
      return !dropped;
    });
    return kept.some((sentence) => /\p{L}/u.test(sentence)) ? kept.join(" ") : "";
  });
  const out = lines.join("\n").replace(/\n{3,}/gu, "\n\n").trim();
  if (!/\p{L}/u.test(out)) return "";
  if (needsQuestion && !sentencesOf(out).some((sentence) => isClosingQuestion(sentence))) return "";
  return out;
}

// ตัวจับทุกตัวของไฟล์นี้ (เทสต์ความเร็วไล่ตรวจทุกตัว — ตัวจับใหม่ต้องเพิ่มที่นี่ด้วย)
export const FOLLOWUP_THREAD_PATTERNS = Object.freeze({ KEYCAP_LINE, LADDER_ASK, PRICE_PROMISE, BOOKING_ASK, REGISTRATION_ASK, ROUND_CHOICE_ASK,
  ROUNDS_OFFER_ASK, WORK_ASK, PRICE_CARD, LEVEL_TOLD_RE, BARE_ACK_RE, ASKS, CONSULT_WHO, HARD_STOP, OPTIONS_TAIL, GENERIC_SENTENCE, CONCRETE_TOPIC,
  NON_MONEY_AMOUNT_RE, COST_ASK_RE, OLD_STUDENT_BUNDLE, DETAILS_ASK_RE, LINK_ASK_RE, ACCEPT_RE, NOT_DELIVERED_RE, DECISION_MAKER_RE, DECISION_WAIT_RE,
  BUDGET_WAIT_RE, DEMAND_ANSWER_RE, PROJECT_ROOM_RE,
  CLASS_FULL_NAMES: CLASS_FULL_NAMES.map(([, re]) => re) });

/** ตัวอ่านของทักตาม (เทสต์บวก/ลบ): ถามค่าเรียนของเรา · ผู้มีอำนาจตัดสินใจที่ลูกค้ารออยู่ ("" = ไม่มี) */
export const followupReaders = Object.freeze({ asksOurPrice, decisionWhoOf });

export const THREAD_USER_TEXT = "(ระบบ) ลูกค้าเงียบไปสักพักแล้ว ช่วยร่างข้อความทักตาม 1 ข้อความที่กลับไปที่เรื่องที่ค้างอยู่ตามกติกาด้านบน";
