// Conservative, local-only signal for a customer turn that should suppress sales follow-up.
// It deliberately returns null unless the customer states one of these closed reasons clearly.

const CLOSED_REASONS = new Set([
  "customer_will_return",
  "customer_considering",
  "colleague_will_contact",
  "accounting_documents",
]);

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/[\s\p{P}]+/gu, "")
    .trim();
}

function hasQuotedOrExampleContext(text) {
  return /(?:["“”‘’]|ตัวอย่าง|เช่น|กรณีศึกษา|newsletter|unsubscribe|ข่าว|ลูกค้าพูดว่า|เขียนข้อความ|usecase|use case|(?:เขา|ลูกค้า|เพื่อน|ceo).{0,30}(?:บอกว่า|พูดว่า))/iu.test(text);
}

function hasNegation(text) {
  return /(?:ไม่ได้|ไม่(?:ได้)?บอก|ไม่ต้อง|อย่า|ไม่.{0,12}(?:ติดต่อกลับ|คิดดู|พิจารณา|ให้ทีม|ตามเอกสาร)|don't|do not|won't|will not)/iu.test(text);
}

function stillAsksAboutClass(text) {
  return /(?:คอร์ส.*(?:เรียน|เนื้อหา|สอน)|(?:เรียน|เนื้อหา|สอน).*คอร์ส|เรียนอะไร|สอนอะไร|เนื้อหาอะไร)/iu.test(text);
}

function hasActiveSalesRequest(text) {
  return /(?:ช่วย|ขอ|บอก).{0,16}(?:ราคา|รายละเอียด|โปร(?:โมชัน)?)/iu.test(text);
}

function hasThirdPartyDeferral(text) {
  return /(?:เพื่อน|เขา|ลูกค้า).{0,24}(?:จะ|กำลัง|อยาก|ขอ|ให้).{0,12}(?:คิดดู|พิจารณา|ตัดสินใจ|ปรึกษา|ติดต่อกลับ|ทีมงาน|ลูกน้อง)/iu.test(text);
}

// 28 ก.ย. 2026 (ตรวจ ก.ย.: ลูกค้าที่ "ขอคิดก่อน" ยังถูกทักตามใน 72 ชม.) — รูปเดิมรับเฉพาะข้อความที่ขึ้นต้นด้วย
// (ขอ)คิดดูก่อน/พิจารณาก่อน ส่วนรูปที่พิมพ์จริงบ่อยกว่าหลุดทั้งหมด: "ขอคิดก่อน" (ไม่มี ดู) · "ขอตัดสินใจก่อน" ·
// "ขอปรึกษาแฟนก่อน" · "เดี๋ยวผมคิดอีกที" · "ต้องขอคิดดูก่อน" · มีคำนำหน้า ("ค่ะ" / "ตอนนี้" / ประโยคก่อนหน้า)
// โครงที่รับ = คำขอเวลา (ขอ/เดี๋ยว/ต้อง/ไว้) + คำกริยาตัดสินใจ + คำเลื่อน (ก่อน/อีกที/แล้วแจ้งกลับ)
// ไม่รับ: ขอ "คำ" ปรึกษา (ขอให้เราช่วย) · "สักครู่" (กลับมาในไม่กี่นาที) · ข้อความที่ยังถามอะไรอยู่
const CONSIDER_LEAD = "(?:ขอ|เดี๋ยว|เด๋ว|เด่ว|เดียว|เดะ|ต้อง|ไว้)(?:ผม|ฉัน|ดิฉัน|เรา|หนู|พี่)?(?:ขอ)?(?:ลอง)?(?:เวลา)?(?:ไป)?(?:หาข้อมูล(?:และ|แล้ว))?";
const CONSIDER_VERB = "(?:คิด(?!เลข|ราคา|ค่า|เงิน|ว่า|ถึง)(?:ดู)?|ตัดสินใจ|พิจารณา|เก็บไปคิด|ปรึกษา(?:กับ)?(?:แฟน|ที่บ้าน|ครอบครัว|หุ้นส่วน|หัวหน้า|ทางทีม|ทีม|ผู้บริหาร|เจ้านาย|หลาน|ลูก|สามี|ภรรยา|พ่อ|แม่|ผู้ใหญ่|ที่บริษัท|บริษัท|ภายใน)?|คุยกับ(?:แฟน|ที่บ้าน|ครอบครัว|หุ้นส่วน|หัวหน้า|ทางทีม|ทีม|ผู้บริหาร|เจ้านาย|หลาน|ผู้ใหญ่))";
const CONSIDER_TAIL = "(?:ก่อน|อีกที|อีกครั้ง|อีกหน่อย|สักพัก|แป[๊ป]?[บป]|นิดนึง|แล้ว(?:จะ)?(?:มา)?(?:แจ้ง|บอก|ตอบ|ติดต่อ)(?:กลับ)?)";
const CONSIDER_BROAD = new RegExp(`${CONSIDER_LEAD}${CONSIDER_VERB}.{0,16}?${CONSIDER_TAIL}`, "u");
const ASKS_SOMETHING = /[?？]|ไหม|มั้ย|มั๊ย|หรือเปล่า|รึเปล่า|ยังไง|อย่างไร|เท่าไ(?:หร่|ร)|อะไร|ไหน|กี่/u;
// ผู้ตรวจโค้ด 28 ก.ย.: "ขอตัดสินใจก่อนว่าจะเรียนรอบเช้าหรือรอบบ่าย แล้วจะโอนเลย" คือผู้ซื้อที่กำลังเลือกตัวเลือก
// ไม่ใช่คนขอพัก — การหยุดติดตามเป็นแบบถาวร จึงต้องไม่แตะคนที่เลือกระหว่างตัวเลือกหรือบอกว่าจะจ่าย/สมัคร/จอง
const CHOOSING_OPTION = /ว่าจะ[^\n]{0,40}?(?:ไหน|กี่|หรือ|อะไร|ยังไง|ดี(?:ค่ะ|คะ|ครับ|นะ|\s|$))/u;
const COMMITTED_TO_BUY = /(?:จะ|แล้ว(?:จะ)?|เดี๋ยว)\s*(?:รีบ)?\s*(?:โอน|สมัคร|จอง|ชำระ|จ่าย)|รีบแจ้ง|แจ้งจำนวน/u;

// Personal pause statements: a scheduling objection inside an active sales
// request (or a description of a device/another person) must remain eligible.
const COURTESY_TAIL = "(?:(?:เลย|ก่อน|นะ|ครับผม|ครับ|ค่ะ|คะ|ขอบคุณ|มาก|ๆ))*";
const PAUSE_LEAD = "(?:(?:ผม|ฉัน|ดิฉัน|เรา|หนู|พี่|ตอนนี้|ตอนนี่|ช่วงนี้|พักนี้|ยังๆ|ครับ|ค่ะ|คะ))*";
const CUSTOMER_PAUSE = new RegExp(`^${PAUSE_LEAD}(?:(?:ยัง)?ไม่(?:พร้อม|สะดวก(?:คุย)?|สนใจ|ว่าง)|ติดงาน(?:อยู่)?|(?:ทำงาน|งานยุ่ง)?(?:ยัง)?ไม่มีเวลา(?:คุย)?|ขอพัก(?:การคุย|คุย|การติดต่อ|การติดตาม)?|หมอให้พักสายตา|(?:ยัง)?ดูๆอยู่)${COURTESY_TAIL}$`, "u");
const CUSTOMER_RETURN_WHEN_READY = new RegExp(`^${PAUSE_LEAD}(?:(?:ยัง)?ไม่(?:พร้อม|สะดวก)${COURTESY_TAIL})?(?:ไว้|ถ้า)?(?:พร้อม|สะดวก)(?:แล้ว)?(?:เดี๋ยว|จะ|ค่อย)+(?:ทัก(?:มา|ไป|กลับ)?|ติดต่อ(?:มา|ไป|กลับ)?|แจ้ง(?:มา|ไป|กลับ))(?:เอง)?${COURTESY_TAIL}$`, "u");
const CUSTOMER_SELF_RETURN = new RegExp(`^(?:เดี๋ยว|ไว้)?(?:ผม|ฉัน|ดิฉัน|เรา|หนู|พี่)?(?:จะ)?ทัก(?:มา|ไป|กลับ)?เอง${COURTESY_TAIL}$`, "u");
const ACTIVE_ALTERNATIVE = /(?:อยาก(?:ได้|เรียน|รู้|ใช้|สมัคร)|สนใจ(?:เรียน|คลาส|คอร์ส|รอบ|ตัว)|(?:แต่|ส่วน).{0,25}(?:อยาก|สนใจ)|ขอ(?:เรียน|สมัคร|จอง))/u;
const OTHER_SUBJECT = /(?:เพื่อน|ลูกค้า|เขา|เครื่อง|ระบบ|มือถือ|คอมพิวเตอร์|สมมติ)/u;
const REQUESTED_CONTACT = /(?:ช่วย|รบกวน|ขอให้).{0,20}(?:โทร|ทัก|ติดต่อ|ส่ง)|(?:โทร|ทัก|ติดต่อ|ส่ง(?:โปร|รายละเอียด|ข้อความ)).{0,24}(?:ได้|พรุ่งนี้|วัน|บ่าย|เย็น|เช้า|อีกที)/u;
// A polite ending can separate a pause from a short explanation or follow an
// address. Require an explicit personal/time clause, not a keyword anywhere.
const PERSONAL_CONTEXT = "(?:(?:ยังๆ)?(?:ครับ|ค่ะ|คะ)(?:คุณ|พี่)?[\\p{Script=Thai}]{1,20}|(?:เป็น)?ข้าราชการบำนาญ|เกษียณ(?:แล้ว)?|กำลังพักอยู่)?";
const EXPLAINED_CUSTOMER_PAUSE = new RegExp(`^(?:${PAUSE_LEAD}(?:ยัง)?ไม่(?:พร้อม|สะดวก|สนใจ|ว่าง)(?:ครับผม|ครับ|ค่ะ|คะ)|${PERSONAL_CONTEXT}(?:ตอนนี้|ตอนนี่|ช่วงนี้|พักนี้)(?:(?:ยัง)?ไม่(?:พร้อม|สะดวก|สนใจ|ว่าง)|(?:ทำงาน|งานยุ่ง)${COURTESY_TAIL}(?:ยัง)?ไม่มีเวลา(?:เลย)?|หมอให้พักสายตา)(?:ครับผม|ครับ|ค่ะ|คะ|$))`, "u");

function result(reason) {
  // Keeping this assertion local makes the public contract closed if phrases change later.
  return CLOSED_REASONS.has(reason) ? { reason } : null;
}

/**
 * Return a closed follow-up-suppression reason only for an explicit customer intent.
 * `history` is accepted for a stable call signature but intentionally cannot turn an
 * otherwise ambiguous current message into a suppression decision.
 */
export function classifyFollowupSuppression(text, { history = [] } = {}) {
  void history;
  const raw = String(text || "").trim();
  const compact = normalize(raw);
  const direct = compact.replace(/^(?:(?:สวัสดี|ขอบคุณ)?(?:ครับ|ค่ะ|คะ)|ขออนุญาต)+/u, "");
  const own = direct.replace(/^(?:ผม|ฉัน|ดิฉัน|เรา)/u, "");
  if (!compact || hasQuotedOrExampleContext(raw) || hasNegation(raw) || hasThirdPartyDeferral(raw)) return null;

  // A customer asking another person's team to call back remains an active request,
  // not a declaration that their own colleague will take over.
  if (/(?:รบกวน|ช่วย|ให้)(?:ทีมงาน|แอดมิน|เจ้าหน้าที่)(?:ของคุณ)?(?:ติดต่อกลับ|โทรกลับ|ทักกลับ)/u.test(raw)) return null;

  if (stillAsksAboutClass(raw) || hasActiveSalesRequest(raw) || REQUESTED_CONTACT.test(compact)) return null;

  // Existing-document work must be explicit. An invoice word or a payment claim alone
  // does not establish that a post-sale accounting owner will handle it.
  const accountingSpeaker = /^(?:(?:ผม|ฉัน|ดิฉัน|เรา)(?:เป็น|อยู่|มาจาก|ติดต่อจาก)?|มาจาก|ติดต่อจาก|จาก)?(?:ฝ่ายบัญชี|แผนกบัญชี)(?:ครับ|ค่ะ|คะ|บริษัท|ของ|มาตาม|ขอตาม|ขอ|รบกวน|เดี๋ยว|ตาม|ตรวจ|ส่ง|$)/u.test(direct);
  const documentWork = /(?:ตาม|ส่ง|ตรวจ)(?:เอกสาร|ใบเสร็จ|ใบกำกับ|หลักฐาน)/u.test(compact)
    || /(?:เอกสาร|ใบเสร็จ|ใบกำกับ|หลักฐาน).{0,16}(?:ค้าง|ชำระแล้ว|โอนไปแล้ว)/u.test(raw);
  const explicitExistingDocument = /^(?:ขอ|มา|รบกวน)?(?:ตาม|ติดตาม)(?:ใบเสร็จ|ใบกำกับ)(?:ที่ค้าง|เดิม|ที่ส่งไปแล้ว|หลังชำระ|การชำระ)/u.test(own);
  const documentPresalesOrUseCase = /(?:ก่อน(?:ซื้อ|ตัดสินใจ|ชำระ)|ใบเสนอราคา|อยากใช้|ใช้\s*ai|ระบบ|สอน|เรียน|ทำได้ไหม)/iu.test(raw);
  if (!documentPresalesOrUseCase && ((accountingSpeaker && documentWork) || explicitExistingDocument)) return result("accounting_documents");

  const ownColleagueHandoff = /^(?:เดี๋ยว)?ให้(?:ลูกน้อง|ทีมงาน|ทีม|เพื่อนร่วมงาน)(?:ของผม|ของเรา)?(?:ทักมา|ทักไป|ติดต่อกลับ|โทรกลับ|ทักกลับ)/u.test(own)
    || /^(?:ผม|ฉัน|ดิฉัน|เรา).{0,24}(?:ceo|เจ้าของบริษัท).{0,24}ให้(?:ทีมงาน|ทีม|ลูกน้อง)(?:ทักมา|ทักไป|ติดต่อกลับ|โทรกลับ|ทักกลับ)/iu.test(raw);
  if (ownColleagueHandoff) return result("colleague_will_contact");

  const customerWillReturn = /^(?:(?:เดี๋ยว|ไว้)(?:ผม|ฉัน|ดิฉัน|เรา)?ติดต่อกลับ(?:ไป)?|ขอติดต่อกลับ(?:ไป)?|(?:ill|iwill|letme)getbacktoyou|willgetbacktoyou(?:later)?)/iu.test(own);
  if (customerWillReturn) return result("customer_will_return");

  const customerConsidering = /^(?:ขอ)?(?:คิดดู|พิจารณา)ก่อน|^(?:letme|ineedto)thinkaboutit|^illconsiderit/iu.test(own);
  if (customerConsidering) return result("customer_considering");

  // รูปกว้าง (ดูคอมเมนต์ CONSIDER_BROAD) — ข้อความที่ยังถามอะไรอยู่ = ลูกค้ายังคุยต่อ ไม่ใช่การขอพัก
  if (!ASKS_SOMETHING.test(raw) && !CHOOSING_OPTION.test(raw) && !COMMITTED_TO_BUY.test(raw)
    && CONSIDER_BROAD.test(compact)) return result("customer_considering");

  if (!ASKS_SOMETHING.test(raw) && !COMMITTED_TO_BUY.test(raw)
    && !ACTIVE_ALTERNATIVE.test(compact) && !OTHER_SUBJECT.test(compact)) {
    if (CUSTOMER_RETURN_WHEN_READY.test(direct) || CUSTOMER_SELF_RETURN.test(direct)) return result("customer_will_return");
    if (CUSTOMER_PAUSE.test(direct) || EXPLAINED_CUSTOMER_PAUSE.test(direct)) return result("customer_considering");
  }

  return null;
}
