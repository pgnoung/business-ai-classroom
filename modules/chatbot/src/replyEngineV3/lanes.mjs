// lanes.mjs — เทิร์นไหนให้ v3 เขียน เทิร์นไหนคงเครื่องเดิม (spec v3.1 §A5 · phase 1)
// v3 ไม่เขียนประโยคส่งต่อทีม เลขบัญชี งานองค์กร เรื่องเงิน/เอกสาร ดูแลใจ ออนไลน์ นักเรียนเก่า ที่นั่ง หรือสื่อ —
// เทิร์นพวกนั้นเครื่องเดิมเป็นเจ้าของถ้อยคำ (กุญแจสองดอกของการปิดห้องไม่ถูกแตะ)
// ไฟล์นี้ห้าม import pipeline.mjs (วงวน) — ค่าคงที่สองตัวข้างล่างเป็นสำเนา มีเทสต์เทียบกับต้นฉบับใน pipeline
import { NON_AI_SERVICE_TOPIC } from "../serviceTopic.mjs";
import { isBankInfoConversation } from "../salesDecisionGuard.mjs";
import { legacyIdentityPending } from "../aiPausePolicy.mjs";
import { historyWindow } from "./prompt.mjs";

// สำเนาของ pipeline.PAYMENT_STARTED_DEAL_STATUSES และ pipeline.CAMPAIGN_KEYWORD (เทสต์ lanes ล็อกว่าตรงกัน)
export const PAYMENT_STARTED_STATUSES = Object.freeze(["awaiting_payment", "paid_confirmed", "prep_sent"]);
export const CAMPAIGN_KEYWORD_COPY = /^\s*[#@]\S/u;

// รีวิว 4 ต.ค.: "แบ่งจ่าย / เงินสด / บิล / เบิกบริษัท / รับบัตร" ต้องเป็นของเครื่องเดิม (v3 ไม่มีข้อมูลชำระเงินเลย)
// "ค่าใช้จ่าย / แจกจ่ายงาน / บัตรคำ" ไม่นับ (ลูกค้าเล่าเรื่องงานของเขา เช่น ครูทำบัตรคำ อยากลดค่าใช้จ่าย)
export const PAYMENT_TOPIC = /โอน|เลขบัญชี|บัญชี|พร้อมเพย์|qr|สลิป|ชำระ|(?<!ใช้|แจก)จ่าย|ผ่อน|บัตร(?!คำ|ภาพ)|บิล|เบิก|เงินสด|ใบเสร็จ|ใบกำกับ|ใบเสนอราคา|ภาษี|\bvat\b|นิติบุคคล|มัดจำ|คืนเงิน|เงินคืน|รีฟันด์|ค่าธรรมเนียม|\b(?:pay(?:ment)?|invoice|receipt|refund)\b/iu;
// ตรวจคิว 13 ต.ค.: พิมพ์ "ออนไลน" / "ออนไล" (ไม่มีการันต์) หลุดจากเลนคลาสออนไลน์ → v3 ตอบว่ามีแต่เรียนสด
const ONLINE_TOPIC = /ออนไล|ออนลาย|online|vdo|on ?demand|ดูย้อนหลัง/iu;
// "ขายของออนไลน์ / ร้านออนไลน์" คือธุรกิจของลูกค้า ไม่ใช่คลาสออนไลน์ (INCOME_RE ของ stage.mjs นับเป็นสัญญาณเชื่อมคลาส)
// "ขายออนไลน์" เฉย ๆ ไม่ยกเว้น ("มีคอร์สที่ขายออนไลน์ไหม" = ถามคลาสออนไลน์)
const ONLINE_BUSINESS = /(?:ขาย(?:ของ|สินค้า)|ร้าน(?:ค้า)?|ธุรกิจ|การตลาด|ตลาด|หน้าร้าน)\s*(?:ออนไลน์?|ออนไล|ออนลาย|online)/giu;
// นักเรียนเก่า / เรียนสองคลาสพร้อมกัน — ราคาพิเศษพวกนี้อยู่ในการ์ดส่วนลดที่ v3 ไม่เห็น
// "เคยลงมือ" / "เรียนไปแล้วได้อะไร" ไม่ใช่นักเรียนเก่า
const OLD_STUDENT_BUNDLE = new RegExp([
  "เคยเรียน", "เคยมาเรียน", "เคยลง(?:คลาส|คอร์ส|เรียน|สมัคร|ทะเบียน|ไปแล้ว|แล้ว)",
  "เรียนไปแล้ว(?=\\s*(?:ค่ะ|คะ|ครับ|นะ|จ้า|รอบ|ครั้ง|ตอน|เมื่อ|$))",
  "นักเรียนเก่า", "ศิษย์", "เรียนซ้ำ", "re-?learn", "bundle", "สองคลาส", "2 ?คลาส", "ทั้งสอง(?:คลาส|คอร์ส)",
  "(?:ลง|เรียน|สมัคร|เอา)\\s*(?:ทั้ง|ครบ)\\s*(?:ทั้ง)?\\s*(?:สอง|2|คู่|business|workflow|คลาส|คอร์ส)",
].join("|"), "iu");
const PROJECT_TOPIC = /\bprivate\b|ไพรเวท|in-?house|อินเฮาส์/iu;
// "ยังว่างไหม / เต็มยัง / มีที่ว่างไหม" = ถามที่นั่ง (เครื่องเดิมมีจำนวนที่นั่งจริง) · "ไม่ว่าง" / "เต็มที่" / "เต็มเวลา" ไม่ใช่
const SEATS = /ที่นั่ง|(?<!เวลา)ที่ว่าง|(?<!ไม่)ว่าง(?:อยู่)?(?:ไหม|มั้ย|ป่าว|รึเปล่า|หรือเปล่า)|เต็ม(?:แล้ว|หรือยัง|รึยัง|ยัง|ไหม|มั้ย)|เหลือ(?:กี่)?ที่|ยังรับ/u;
// ตัวจำแนกรูปแปลงรูปทั่วไปเป็น "(ลูกค้าส่งรูปมา: …)" แล้วเดินเส้นคุยปกติ (imageClassifier.mjs) — held-out case-004/010
const MEDIA = /^(?:\[(?:image|รูป|ไฟล์|sticker)|\(ลูกค้าส่ง(?:รูป|สติกเกอร์|เสียง|วิดีโอ|ไฟล์))/iu;
// held-out 5 ต.ค. (v3.2): เทิร์นที่ v3 เขียนคำขายใส่ ทั้งที่เครื่องเดิมมีเส้นของมันอยู่แล้ว
// เรื่องหลอกลวง/ความปลอดภัย = ดูแลใจ ห้ามขาย (sep-026 "เป็นเรื่องจริงหรือเรื่องปลอม") — พลาดไปทางเครื่องเดิมได้ เครื่องเดิมคือ production วันนี้
const SAFETY_TOPIC = /หลอก|มิจฉา|\bscam\b|สแกม|โกง|แก๊ง|ต้มตุ๋น|แอบอ้าง|คอลเซ็นเตอร์|ปลอม|ตัวจริง|จริงหรือ(?:เปล่า|ไม่)|ได้เงินจริง|ได้รางวัล|\bOTP\b|รหัส(?:ผ่าน|ยืนยัน)|ลิ้?[งน][กค]์?แปลก|แฮ็?[กค]|(?:โดน|ถูก)(?:hack|ขโมย)/iu;
// ลูกแพรเพิ่งเตือนเรื่องความปลอดภัยไป (อย่ากดลิงก์ / อย่าบอก OTP) = ห้องนี้ยังอยู่ในจังหวะดูแลใจ
const BOT_SAFETY_WARNING = /OTP|มิจฉา|หลอกลวง|แอบอ้าง|ไม่โอนเงิน|ยังไม่กด|อย่า(?:เพิ่ง)?(?:กด|โอน|ให้รหัส|บอกรหัส|แจ้งรหัส)|รหัสผ่าน|รหัสยืนยัน|(?:เพจ|บัญชี)ปลอม|ระวัง(?:มิจฉา|เพจ|การหลอก|ลิ้?[งน][กค]์?)/u;
// ลูกแพร/ทีมรับปากว่าจะติดต่อ แล้วลูกค้าตามเรื่อง — ประโยคส่งต่อทีมเป็นของเครื่องเดิม (sep-010 "ทักมายังคะ")
// สำเนาของ pipeline.TEAM_PROMISE_RE + เงื่อนไขของ looksLikeTeamPromise (เทสต์ lanes ล็อกว่าตรงกัน) + ผู้รับปากที่ตัวนั้นไม่นับ
export const TEAM_PROMISE_COPY = new RegExp(
  "(?:ส่ง(?:เรื่อง|ต่อ)|ให้|ขอให้|กับ|เช็คกับ|คุยกับ)\\s*(?:ทีมงาน|ทีมผู้ดูแล|ทีมดูแล|ทีมที่ดูแล)"
  + "|(?:ทีมงาน|ทีมผู้ดูแล|ทีมดูแล|ทีมที่ดูแล)[^\\n]{0,14}?(?:จะ|เป็นผู้|ช่วย)\\s*"
  + "(?:ดูแล|ตรวจสอบ|ตรวจ|ยืนยัน|พิจารณา|สรุป|ติดต่อ|โทร|ประสาน|เสนอราคา|แจ้งกลับ|รับช่วง|เข้ามา)",
  "u",
);
const TEAM_PROMISE_OFFER_COPY = /[?？]\s*$|ไหมคะ|ไหมครับ|มั้ยคะ|มั้ยครับ|ดีไหม|ดีมั้ย/u;
const TEAM_PROMISE_COMMITMENT_COPY = /ลูกแพร|เดี๋ยว|ขอ|ต้องให้|จะ/u;
const OTHER_PROMISER = /(?:ทีม(?:งาน|ผู้ดูแล|ดูแล|แอดมิน)|(?:คุณ)?ชมพู่|แอดมิน|เจ้าหน้าที่|มีคน)[^\n]{0,40}?(?:ติดต่อ|โทร|ทัก|ดูแลต่อ|ประสาน|สแกน|แจ้งกลับ|ตอบกลับ)/u;
const CONTACT_CHASE = /(?:ทัก|โทร|ติดต่อ)(?:มา|ไป|กลับ)?(?:แล้ว)?(?:หรือ|รึ)?ยัง|เมื่อไหร่\S{0,12}(?:ทัก|โทร|ติดต่อ)|ยังไม่(?:เห็น|มี)?(?:ใคร|คน)?\S{0,8}(?:ทัก|โทร|ติดต่อ)|รอ(?:นาน|อยู่|สาย)/u;
// ลูกค้าส่งช่องทางติดต่อของตัวเองมาอย่างเดียว (case-023) — ข้อความจริงหรือแบบปิดข้อมูลของชุดทดสอบ (JS \w = ASCII)
const CONTACT_VALUE = "\\[(?:อีเมล|เบอร์|LINE|ไลน์)[^\\]]*\\]|[\\w.+-]+@[\\w-]+\\.[\\w.]+|(?:\\+66\\s?|0)\\d[\\d -]{7,11}\\d";
// รีวิวเคสจริงทั้งวัน 5 ต.ค. (ตรวจความเร็ว): ช่องว่าง/ขึ้นบรรทัดยาว ๆ หลังคำว่า line เคยทำให้ตัวจับลองแบ่งช่องว่างทุกแบบ — ช่องว่างแต่ละช่วงต้องตามด้วยคำ (ผลเหมือนเดิม)
const CONTACT_TAIL = "(?:\\s*(?:นะ(?:ค่ะ|คะ|ครับ)?|ค่ะ|คะ|ครับ))?\\s*$";
const CONTACT_INFO = new RegExp(
  `^\\s*(?:(?:เบอร์|โทร|อีเมล|email|ไลน์|line)(?:\\s*(?:id|ไอดี))?(?:\\s*[:：])?\\s*)?(?:${CONTACT_VALUE})${CONTACT_TAIL}`
  + `|^\\s*(?:line(?:\\s*id)?|ไอดีไลน์|ไลน์ไอดี|ไลน์)(?:\\s*[:：])?\\s*@?[\\w.-]{3,}${CONTACT_TAIL}`,
  "iu",
);
// ผู้ได้สิทธิ์จากกิจกรรมขอทางเข้าเรียน/ของที่แจก (sep-039 "ขอลิงค์เข้าเรียน")
const LINK = "ลิ้?[งน][กค]์?";
const ENTITLEMENT_ASK = new RegExp([
  `${LINK}\\s*(?:เข้า)?(?:เรียน|คลาส|กลุ่ม|ห้อง|zoom|ซูม|ไลฟ์|live)`, "เข้า(?:เรียน|คลาส|กลุ่ม|ห้อง)(?:ยังไง|อย่างไร|ทางไหน)",
  `(?:ยัง)?ไม่ได้(?:รับ)?(?:${LINK}|ไฟล์|สิทธ)`, "ได้(?:รับ)?สิทธ", `^ขอ${LINK}\\s*(?:หน่อย|ด้วย)?\\s*(?:ค่ะ|คะ|ครับ)?\\s*$`,
].join("|"), "iu");
// คำกดรับของแจก (sep-032 "รับข้อมูลอัพเดต" ตามประกาศ กด "รับข้อมูลอัพเดท") — ทนพิมพ์ผิด สิทธิ์/สิทธิ/สิทธ์ เทมเพลต/เทมเพลท
const GIVEAWAY_CLAIM = new RegExp(
  "^(?:สนใจ|อยาก(?:ได้)?)?(?:\\s*ขอ)?\\s*รับ(?:ข้อมูล|สิทธ|ของ|ฟรี|เทมเพล[ตท]|template|ไฟล์)"
  + `|^(?:ขอ(?:รับ)?)\\s*(?:เทมเพล[ตท]|template|ไฟล์|ชีท|${LINK})`,
  "iu",
);
const ANNOUNCED_QUOTED = /(?:กด|พิมพ์|ส่ง|ทัก|แชท|คอมเมนต์|เมนต์|เม้น)(?:คำ)?(?:ว่า)?\s*["“”'«「]([^"“”'»」\n]{2,30})["“”'»」]/gu;
const ANNOUNCED_BARE = /(?:กด|พิมพ์|ส่ง|ทัก|คอมเมนต์|เมนต์|เม้น)คำว่า\s*([^\s"“”'«「]{2,20})\s*(?:เพื่อ|แล้ว|มา|ได้)/gu;

// รีวิวเคสจริงทั้งวัน 5 ต.ค.: ลูกค้าสาย creative บอกว่าสนใจงานกราฟิก เว็บไซต์ VDO (งานผลิตวิดีโอของเขาเอง) แล้วถูกนับเป็นคำถามคลาสออนไลน์
// — VDO ที่ต่อจากงาน/การผลิต ไม่นับ · ถามเรียนเป็นวิดีโอ / ดูย้อนหลัง / คอร์ส VDO ยังเป็นคำถามคลาสออนไลน์ (ตรวจจากข้อความเดิมก่อนตัด)
const VIDEO_WORK = /(?:graphic|กราฟ(?:ฟ)?ิก|website|เว็บ(?:ไซต์)?|ตัดต่อ|ถ่าย|ทำ|สร้าง|ผลิต|รับทำ|งาน|content|คอนเทน(?:ต์)?|motion|anim\S{0,12})[^\n]{0,24}?vdo|vdo\s*(?:edit\S{0,8}|production|โปรดักชั่น|ตัดต่อ|มาร์เก็ตติ้ง|marketing)/giu;
const ONLINE_VDO = /(?:เรียน|สอน|คอร์ส|คลาส)\S{0,6}\s*(?:(?:เป็น|แบบ|ผ่าน)\s*)?vdo|(?:เป็น|แบบ|ผ่าน)\s*vdo|vdo\s*(?:สอน|คอร์ส|คลาส|ย้อนหลัง|บันทึก)/iu;
// feedback ทีม 10 ต.ค.: เครื่องเดิมเริ่มขั้นสมัครแล้ว (ถามออกเอกสารในนามบุคคลธรรมดาหรือบริษัท / ขอข้อมูลออกใบเสร็จ) — คำตอบของลูกค้า
// ("บุคคลธรรมดาค่ะ") ต้องไปต่อที่เครื่องเดิม (ค่าเรียน + ช่องทางชำระ) ไม่ใช่ v3 ที่ไม่มีข้อมูลชำระเงิน
// · ขอข้อมูลผู้เรียนเพื่อลงทะเบียน (ชื่อ–นามสกุล อีเมล เบอร์) ก็เป็นขั้นสมัครของเครื่องเดิมเหมือนกัน
const REGISTRATION_STEP = new RegExp([
  "ออก(?:เอกสาร|ใบเสร็จ|ใบกำกับ(?:ภาษี)?)\\S{0,8}ในนาม", "ในนามบุคคลธรรมดา",
  "ข้อมูล(?:สำหรับ)?(?:ออก)?(?:ใบเสร็จ|ใบกำกับ)", "ข้อมูล(?:ผู้เรียน|ลงทะเบียน|การสมัคร|สำหรับ(?:ลงทะเบียน|สมัคร))",
  "(?:ส่ง|ขอ|แจ้ง)\\S{0,6}ชื่อ\\s?[–-]?\\s?นามสกุล",
  // รีวิวปรปักษ์ 10 ต.ค.: ถ้อยคำอื่นของคำถามเอกสาร ("เป็นชื่อบุคคลธรรมดาหรือบริษัทคะ" · "ในนามบริษัทหรือบุคคลคะ") — ต้องมีคำเรื่องเอกสาร
  // ในประโยคเดียวกัน ("บริษัทหรือบุคคลทั่วไปก็เรียนได้ค่ะ" คือบอกกลุ่มผู้เรียน ไม่ใช่ขั้นสมัคร)
  "(?:เอกสาร|ใบเสร็จ|ใบกำกับ|ในนาม|เป็นชื่อ)[^\\n?？]{0,30}?บุคคล(?:ธรรมดา)?[^\\n?？]{0,16}?หรือ[^\\n?？]{0,12}?(?:บริษัท|นิติบุคคล)",
  "(?:เอกสาร|ใบเสร็จ|ใบกำกับ|ในนาม|เป็นชื่อ)[^\\n?？]{0,30}?(?:บริษัท|นิติบุคคล)[^\\n?？]{0,12}?หรือ[^\\n?？]{0,12}?บุคคล",
].join("|"), "u");
const legacy = (reason) => ({ engine: "legacy", reason });
const onlineTopic = (value) => ONLINE_VDO.test(String(value))
  || ONLINE_TOPIC.test(String(value).replace(ONLINE_BUSINESS, " ").replace(VIDEO_WORK, " "));

// Routing ใช้หน้าต่างหัวข้อล่าสุด 16 ก้อนต่อไป แม้ prompt v3.8 จะเก็บ context มากขึ้น
// เพื่อไม่ให้หัวข้อออนไลน์/Private เก่าล็อกห้องไป legacy ตลอด session
const ROUTING_HISTORY_MESSAGES = 16;
const routingHistory = (history) => historyWindow(Array.isArray(history) ? history : []).slice(-ROUTING_HISTORY_MESSAGES);

// ข้อความลูกค้าในหน้าต่างหัวข้อล่าสุด + เทิร์นนี้ — หัวข้อที่คุยค้างไว้ตามไปถึงคำถามราคาสั้น ๆ ("ราคาเท่าไหร่คะ")
function userWindow(history, text) {
  const past = routingHistory(history).filter((turn) => turn.role === "user").map((turn) => turn.content);
  return [...past, text];
}

// ก้อนข้อความล่าสุดของลูกแพรก่อนเทิร์นนี้ ("" = เทิร์นก่อนหน้าเป็นของลูกค้า)
function lastBotBurst(history) {
  const turns = Array.isArray(history) ? history : [];
  const out = [];
  for (let i = turns.length - 1; i >= 0 && turns[i]?.role === "assistant"; i -= 1) out.unshift(String(turns[i]?.content ?? ""));
  return out.join("\n");
}

const compact = (value) => String(value).normalize("NFC").replace(/[\s"“”'.!?？]/gu, "").toLowerCase();

// ลูกค้าพิมพ์คำที่ประกาศกิจกรรมสั่งให้กด/พิมพ์ (อนุโลมพิมพ์ผิดตัวท้าย: อัพเดต ↔ อัพเดท)
function claimsAnnouncedPhrase(botTurns, text) {
  const said = compact(text);
  if (!said) return false;
  return botTurns.some((turn) => [...String(turn).matchAll(ANNOUNCED_QUOTED), ...String(turn).matchAll(ANNOUNCED_BARE)].some(([, phrase]) => {
    const want = compact(phrase);
    const stem = [...want].slice(0, Math.max(4, [...want].length - 1)).join("");
    return stem.length >= 4 && said.startsWith(stem);
  }));
}

/** ประโยครับปากแทนทีม — ความหมายเดียวกับ pipeline.looksLikeTeamPromise + ผู้รับปากอื่น (ชมพู่/แอดมิน/มีคน) */
export function lanePromisesTeam(text = "") {
  return String(text).split(/\n+/u).some((line) => {
    if (TEAM_PROMISE_OFFER_COPY.test(line.trim()) || !TEAM_PROMISE_COMMITMENT_COPY.test(line)) return false;
    return TEAM_PROMISE_COPY.test(line) || OTHER_PROMISER.test(line);
  });
}

// ข้อความล่าสุดของลูกแพรรับปากแทนทีม = เทิร์นนี้เป็นของเครื่องเดิมไม่ว่าลูกค้าตอบอะไร
// (ทั้งก้อน/ทั้งหน้าต่างนับเฉพาะเมื่อลูกค้าตามเรื่องจริง — รีวิว v3.2: คำรับปากเก่าในก้อนไม่ควรล็อกเทิร์นคุยงานปกติ)
function handoffFollowup(history, text) {
  const turns = Array.isArray(history) ? history : [];
  if (turns.at(-1)?.role === "assistant" && lanePromisesTeam(turns.at(-1)?.content)) return true;
  if (!CONTACT_CHASE.test(text)) return false;
  return routingHistory(history).some((turn) => turn.role === "assistant" && lanePromisesTeam(turn.content));
}

// ลำดับตามตาราง §A5 — เหตุแรกที่ตรงชนะ
function legacyReason(s) {
  const text = String(s.text || "");
  const parts = Array.isArray(s.parts) && s.parts.length ? s.parts.map(String) : [text];
  const disclosure = s.priceDisclosure || {};
  const said = userWindow(s.history, text);
  const botTurns = routingHistory(s.history).filter((turn) => turn.role === "assistant").map((turn) => turn.content);
  if (s.handoffIntent || s.projectHandoff) return "closing_turn";
  if (handoffFollowup(s.history, text)) return "handoff_followup";
  if (parts.some((part) => CONTACT_INFO.test(part))) return "contact_info";
  if (s.handoffProject || s.projectOpportunity || disclosure.projectPricing || said.some((t) => PROJECT_TOPIC.test(t))) return "project";
  // soul v1.1 C6 (20 ต.ค. 2026): สาย LINE / Facebook / ที่ปรึกษา / วางระบบ = Private หรือที่ปรึกษาที่ทีมออกแบบ (พี่ง้วงยืนยัน 20 ต.ค.)
  // ตัวตัดสินจังหวะ v3 รู้จักแค่ 2 คลาส AI และเปิดบันไดระดับ — ให้เครื่องเดิมที่เห็นการ์ดทุกบริการตอบแทน
  if (said.some((t) => NON_AI_SERVICE_TOPIC.test(t))) return "service_topic";
  if (disclosure.careMode || said.slice(-3).some((t) => SAFETY_TOPIC.test(t))
    || botTurns.slice(-3).some((t) => BOT_SAFETY_WARNING.test(t))) return "care";
  if (isBankInfoConversation(s.customer) || PAYMENT_TOPIC.test(text)
    || PAYMENT_STARTED_STATUSES.includes(String(s.customer?.deal_status || ""))) return "bank_payment";
  if (REGISTRATION_STEP.test(lastBotBurst(s.history))) return "registration_step";
  if (s.intent === "document_presale") return "document_presale";
  if (s.outlinePlan?.deliver) return "outline_delivery";
  if (legacyIdentityPending(s.customer)) return "legacy_identity";
  if (said.some(onlineTopic) || disclosure.onlinePivot) return "online_topic";
  if (said.some((t) => OLD_STUDENT_BUNDLE.test(t))) return "old_student_bundle";
  if (SEATS.test(text)) return "seats";
  if (parts.some((part) => MEDIA.test(part.trim()))) return "media";
  if (parts.some((part) => CAMPAIGN_KEYWORD_COPY.test(part) || GIVEAWAY_CLAIM.test(part.trim()) || ENTITLEMENT_ASK.test(part))
    || claimsAnnouncedPhrase(botTurns, text)) return "campaign";
  if (!s.hasApprovedFacts) return "no_approved_facts";
  return "";
}

/** @returns {{engine: "v3"|"legacy", reason: string}} */
export function chooseLane(s = {}) {
  try {
    const reason = legacyReason(s);
    return reason ? legacy(reason) : { engine: "v3", reason: "v3" };
  } catch {
    return legacy("lane_error");
  }
}
