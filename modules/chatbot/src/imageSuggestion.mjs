// imageSuggestion.mjs — v1.3.4: เลือกภาพประกอบจาก "สิ่งที่กำลังคุยกันอยู่" แบบ deterministic
//
// เหตุ 2026-08-13: เจ้าของบ่นว่าลูกแพรแทบไม่ส่งรูปเลย ทั้งบทสนทนา 49 ข้อความส่ง 1 ใบ
// และส่งเฉพาะตอนลูกค้าขอเอง ตรวจแล้วพบสองชั้น
//   1) โมเดลเห็น [IMAGE:key] เฉพาะตอนข้อความลูกค้ามีคำว่า "รูป" (แก้ไปแล้วด้วย offerImages)
//   2) รูป 5 จาก 7 ใบไม่มี pack entry ไหนอ้างถึงเลย จึงไม่มีวันถูกเสนอไม่ว่ากรณีใด
//
// ชั้นที่ 2 แก้ที่ pack ไม่ได้โดยไม่ rebuild แพ็กที่ผ่านการอนุมัติแล้ว จึงเลือกทางที่
// ตรงกว่าและตรวจสอบง่ายกว่า: ผูกภาพกับ "บริการที่กำลังคุย" โดยตรง ไม่ต้องพึ่งการจับคู่การ์ด

// บริการที่ recommendProduct คืนมา -> ภาพของบริการนั้น
const PRODUCT_IMAGE = Object.freeze({
  ai_agent_for_business: "ai-agent-for-business",
  workflow_automation_or_higher: "ai-agent-workflow-automation",
  private_or_in_house: "private-class",
  in_house_training: "in-house-training",
});

// ลูกค้าเอ่ยชื่อบริการเอง — ตรงกว่าการเดาจากระดับ/จำนวนคน จึงชนะเสมอ
// ตรวจปรปักษ์ 2026-08-14: คำเดี่ยวกำกวมจับผิดบริบท — "ขายออนไลน์" ได้รูปคลาสออนไลน์
// "ธุรกิจส่วนตัว" (คำตอบคำถามคัดกรองของเราเอง) ได้รูป Private Class
// คำกำกวมจึงต้องประกบบริบทเรียนเสมอ ส่วนชื่อเฉพาะ (workflow, custom gpt, in-house)
// ยังจับเดี่ยวได้เพราะไม่มีความหมายอื่นในแชทนี้
const SPOKEN_SERVICE = Object.freeze([
  { key: "ai-agent-workflow-automation", pattern: /(?:workflow|automation|ออโตเมชั่น|ออโตเมชัน|make\.com|เชื่อมระบบ)/iu },
  { key: "online-custom-gpts", pattern: /(?:custom\s*gpt|(?:คลาส|คอร์ส|เรียน|สอน)[^\n]{0,12}(?:ออนไลน์|online)|(?:ออนไลน์|online)[^\n]{0,12}(?:คลาส|คอร์ส|เรียน|ดูย้อนหลัง)|ดูย้อนหลัง)/iu },
  // v1.4.1 (เคสจริง 2026-08-14): "ให้ไปสอนที่บริษัท" ไม่เข้า pattern เดิม — ต้องมีกริยา
  // สอน/เรียน/อบรม/จัดอบรม นำหน้า "ที่บริษัท" เสมอ กัน "ทำงานที่บริษัท" ติดผิด
  { key: "in-house-training", pattern: /(?:in\s*-?\s*house|อบรมในองค์กร|อบรมทั้งทีม|จัดที่ออฟฟิศ|จัดที่บริษัท|(?:สอน|เรียน|อบรม|จัดอบรม)[^\n]{0,10}ที่\s*(?:บริษัท|ออฟฟิศ|องค์กร|สำนักงาน|โรงงาน)|สอนถึงที่|สอนพนักงาน|เทรนพนักงาน)/iu },
  // 2026-10-02: โปสเตอร์ที่ปรึกษารายเดือนชื่อ "MONTHLY PRIVATE CONSULT" — "private consult" ต้องไม่ได้รูป Private Class
  { key: "private-class", pattern: /(?:private(?!\s*consult)|(?:คลาส|คอร์ส|เรียน|สอน)[^\n]{0,12}ส่วนตัว|ส่วนตัว[^\n]{0,12}(?:คลาส|คอร์ส|เรียน)|เรียนเดี่ยว|กลุ่มเล็กส่วนตัว)/iu },
  { key: "monthly-consult", pattern: /(?:ที่ปรึกษา|consult.{0,10}(?:รายเดือน|เดือน)|monthly|private\s*consult)/iu },
  { key: "flash-consult", pattern: /(?:flash|ปรึกษารายครั้ง|ปรึกษาเป็นครั้ง|ปรึกษาสั้น)/iu },
  { key: "ai-agent-for-business", pattern: /(?:ai\s*agent\s*for\s*business|คลาสพื้นฐาน|เบสิค|basic)/iu },
]);

// 2026-10-03 (พี่ง้วงทดลองจริง "สนใจ Private Class" แล้วได้แต่ข้อความ): โปสเตอร์บริการถูกเสนอแบบ
// "ทางเลือก" โมเดลจึงข้ามรูป — ลูกค้าเรียกชื่อบริการเองแบบชัด = ต้องแนบโปสเตอร์ของบริการนั้น
// และระบบแนบให้เองถ้าโมเดลลืม (pipeline.decideImageOffer) — รูปที่ออกไปเรียกคืนไม่ได้ จึงนับเฉพาะชื่อเรียกเต็ม
// รีวิว 2026-10-03: คำเดี่ยว private / flash / monthly / ออนไลน์ เคยจับ "Flash Express" "monthly report"
// และลูกค้าเก่าถามซัพพอร์ต — ตัดออกหมด (ยังได้รูปแบบ "ทางเลือก" ผ่าน SPOKEN_SERVICE ตามเดิม)
// คลาสออนไลน์ไม่อยู่ในชุดนี้โดยเจตนา: โปสเตอร์มี 4,900 ตัวใหญ่ ให้โมเดลตัดสินจากบริบท (กติกากัน downgrade)
// ลำดับต้องตรงกับ SPOKEN_SERVICE เพื่อให้ผลตรงกับ suggestImageKey เมื่อลูกค้าเอ่ยหลายบริการ
const NAMED_SERVICE_POSTER = Object.freeze([
  { key: "in-house-training", pattern: /(?:in\s*-?\s*house|อินเฮ้?า?ส์|อบรม(?:ใน)?องค์กร|อบรมทั้งทีม)/iu },
  { key: "private-class", pattern: /(?:private\s*[-_]?\s*(?:class|course|คลาส)|ไพรเวท\s*[-_]?\s*(?:คลาส|class)|(?:คลาส|คอร์ส|เรียน)\s*ส่วนตัว)/iu },
  { key: "monthly-consult", pattern: /(?:monthly\s*(?:private\s*)?consult|private\s*[-_]?\s*consult|ที่ปรึกษา(?:ธุรกิจ)?\s*รายเดือน|ปรึกษารายเดือน)/iu },
  { key: "flash-consult", pattern: /(?:flash\s*[-_]?\s*consult|ปรึกษารายครั้ง)/iu },
]);
// ลูกค้าปฏิเสธบริการนั้นอยู่ ("ไม่สนใจ private class") — ห้ามบังคับรูป
const DECLINED_SERVICE = /(?:ไม่(?:ได้)?สนใจ|ไม่เอา|ไม่ต้องการ|ไม่ใช่|ยกเลิก|เปลี่ยนใจ)/u;
// ไม่ใช่จังหวะเสนอขาย: ขอบคุณปิดเรื่อง / ลูกค้าเก่า-ซื้อ-จอง-โอนแล้ว / ขอเลื่อน-เปลี่ยน-ย้ายรอบ
// รีวิว 2026-10-03 (รอบ 3–4): "จอง/สมัคร/โอนเงินค่า … แล้ว" คือลูกค้าที่ซื้อแล้วมาถามซัพพอร์ต ไม่ใช่จังหวะยื่นโปสเตอร์
// (ประโยคก่อนซื้อที่บังเอิญมี "แล้ว" ตามหลัง เสียแค่โปสเตอร์ภาคบังคับ ยังได้แบบทางเลือก — รูปที่ออกไปเรียกคืนไม่ได้
// จึงเอียงข้าง "ไม่บังคับ")
// รีวิวรอบ 5: "แล้ว" ต้องจบวลี (ช่องว่าง/เครื่องหมาย/คำลงท้าย) — "จองยังไงแล้วต้องจ่ายไหม" "แล้วราคาเท่าไหร่" คือคำเชื่อมของลูกค้าใหม่
const NOT_A_PITCH_TURN = /(?:ขอบคุณ|เคย(?:เรียน|ซื้อ|สมัคร|จ้าง|ใช้)|(?:ซื้อ|สมัคร|จ่าย|ชำระ|โอน|ลงทะเบียน|จอง)[^\n]{0,30}?แล้ว(?=\s|$|[!?.,]|ค่ะ|คะ|ครับ|นะ|จ้า|ฮะ)|เรียนไปแล้ว|เลื่อน|(?:เปลี่ยน|ย้าย|สลับ)(?:วัน|รอบ|เวลา))/u;
// คำที่มี "ภาพ/รูป" แต่ไม่ใช่รูปภาพ (คุณภาพ ประสิทธิภาพ ภาพรวม ภาพลักษณ์ รูปแบบ …) — แทนด้วยช่องว่างก่อนตรวจคำขอ/คำปฏิเสธรูป
// (รีวิวรอบ 4: "ขอเรียน Private Class ที่เน้นคุณภาพ" เคยนับเป็นขอรูป แล้วปลดตัวกันรูปซ้ำ) ช่องว่างกันช่วงคำของ NO_MEDIA ข้ามคำ
const NON_IMAGE_WORDS = /(?:ภาพ(?:รวม|ลักษณ์|ยนตร์)|(?:ประสิทธิ|คุณ|สุข|ศักย|สมรรถ|ทัศนีย|ส)ภาพ|รูป(?:แบบ|ธรรม|ร่าง))/gu;
export function withoutNonImageWords(text) {
  return String(text || "").replace(NON_IMAGE_WORDS, " ");
}
// ลูกค้าไม่เอารูป: "ไม่ต้องแนบรูป" "อย่าส่งเป็นรูป" "ไม่อยากให้ส่งรูป" "ไม่จำเป็นต้องส่งรูป" "ขอเฉพาะข้อความ"
// (รีวิว 2026-10-03 รอบ 3–4: เดิมจับแค่ "ไม่ต้องส่งรูป") — "อย่าลืมส่งรูป" คือการขอ · "อย่า" ใน "ตัวอย่าง/อย่างไร" ไม่ใช่คำห้าม ·
// คำคั่นยาวได้ถึง 8 ตัวแต่ห้ามข้ามช่องว่าง ("ไม่ต้องรอ ขอรูป" คือการขอ) · "รูปสลิป" คือสลิปโอนของลูกค้า ไม่ใช่รูปของเรา
const NO_MEDIA = /(?:ไม่ต้อง|ไม่อยาก|ไม่เอา|ไม่รับ|ไม่ขอ|ไม่ได้ขอ|ไม่จำเป็น(?:ต้อง)?|ขอไม่|อย่า(?!ลืม|ง)|งด)\S{0,8}?(?:รูป(?!แบบ|สลิป)|ภาพ(?!รวม|สลิป)|โปสเตอร์|poster)|(?:ข้อความ|ตัวอักษร)(?:ล้วน|อย่างเดียว|เท่านั้น|พอ)|(?:แค่|เฉพาะ)\s*ข้อความ/iu;

/** ลูกค้าบอกเองว่าไม่เอารูปในข้อความนี้ — ห้ามนับเป็นการขอรูป ห้ามเสนอรูป และห้ามระบบแนบโปสเตอร์ให้ */
export function explicitPosterNegated(text) {
  return NO_MEDIA.test(withoutNonImageWords(text));
}

/**
 * โปสเตอร์บริการที่ลูกค้าเรียกชื่อเองแบบชัด (และไม่ได้ปฏิเสธ/ไม่ใช่จังหวะขาย) ในข้อความนี้
 * @param {string} text ข้อความล่าสุดของลูกค้า
 * @param {Set<string>|string[]|null} availableKeys key ที่อนุมัติ (null = ไม่กรอง)
 * @returns {string} key หรือ "" ถ้าไม่มี
 */
export function namedServicePoster(text, availableKeys = null) {
  const value = String(text || "");
  if (DECLINED_SERVICE.test(value) || NOT_A_PITCH_TURN.test(value) || explicitPosterNegated(value)) return "";
  const allowed = availableKeys instanceof Set ? availableKeys : Array.isArray(availableKeys) ? new Set(availableKeys) : null;
  for (const { key, pattern } of NAMED_SERVICE_POSTER) {
    if ((!allowed || allowed.has(key)) && pattern.test(value)) return key;
  }
  return "";
}

// ขอดูรูป/โปสเตอร์จริง ๆ — ใช้ปลดด่านกัน downgrade ของโปสเตอร์ออนไลน์เท่านั้น
// (IMAGE_REQUEST ของตัวเลือกการ์ดกว้างกว่า: จับ "ภาพรวม" และไม่สนคำปฏิเสธ "ไม่ต้องส่งรูป")
// รีวิว 2026-10-03 รอบ 3: คำนามลอย ๆ ("โปสเตอร์คลาสสอนสดสวยดี") ไม่ใช่การขอ — ต้องมีกริยาขอ/ดู/ส่ง/มี นำหน้า
// "เห็นภาพ" (= เข้าใจ) ไม่นับ
const POSTER_ASK = /(?:ขอ|ส่ง|ดู|อยากได้|อยากดู|แนบ|มี)\s*(?:ดู\s*)?(?:รูป(?!แบบ)|ภาพ(?!รวม)|โปสเตอร์|poster)|เห็น\s*(?:รูป(?!แบบ)|โปสเตอร์|poster)/iu;
export function explicitPosterAsk(text) {
  const value = withoutNonImageWords(text);
  return POSTER_ASK.test(value) && !NO_MEDIA.test(value);
}

// v1.4.5 (คำสั่งพี่ง้วง 2026-08-15): การ์ดช่องทางชำระเงิน — ส่งเฉพาะจังหวะที่คุยเรื่อง
// "จะโอนยังไง/บัญชีไหน" จริง ๆ ไม่ใช่จังหวะคุยราคา (คำว่า ราคา/เท่าไหร่ จงใจไม่อยู่ในนี้)
const PAYMENT_IMAGE_PATTERN = /(?:โอนเข้าบัญชี|เลขบัญชี|เลขที่บัญชี|บัญชีธนาคาร|ช่องทาง(?:การ)?ชำระ|ชำระ(?:เงิน)?ยังไง|จ่ายเงินยังไง|โอนไป(?:ที่)?ไหน|โอนยังไง|ขอบัญชี|แจ้งบัญชี)/iu;
const PAYMENT_IMAGE_KEY = "payment-kbank";

// v1.4.5: ภาพบรรยากาศคลาสจริง 2 ใบ — สลับใบที่ยังไม่เคยส่งก่อน เพื่อไม่ยิงรูปซ้ำ
// รีวิว 2026-10-03 รอบ 3: "ขอรูปคลาสออนไลน์" คือขอโปสเตอร์คลาสออนไลน์ ไม่ใช่รูปบรรยากาศห้องเรียนสด
const ATMOSPHERE_PATTERN = /(?:บรรยากาศ|ห้องเรียน|สถานที่เรียน|(?:เรียน|สอน)ที่ไหน|เรียนกันยังไง|สอน(?:กัน)?ยังไง|เรียนกี่คน|กี่คนต่อ(?:คลาส|รอบ|กลุ่ม)|กลุ่มเล็ก|ดูแลทั่วถึง|ใกล้ชิด|รูป(?:คลาส(?!\s*(?:ออนไลน์|online))|ตอนเรียน|ห้องเรียน)|ภาพ(?:คลาส(?!\s*(?:ออนไลน์|online))|ห้องเรียน)|สอนสดจริงไหม)/iu;
// v1.4.9: single source of truth — stagedFollowups (เส้น proactive) import ตัวนี้
// ไม่นิยามซ้ำ กัน DRY drift (เดิมนิยาม 2 ที่ แก้รายการที่เดียวหลุดอีกที่)
export const ATMOSPHERE_IMAGES = Object.freeze(["classroom-atmosphere-1", "classroom-atmosphere-2"]);

/**
 * เลือกภาพที่ควรเสนอในเทิร์นนี้ — คืน key เดียวเสมอ เพื่อไม่ให้กลายเป็นการยัดรูปหลายใบ
 * @param {string} text ข้อความล่าสุดของลูกค้า
 * @param {string|null} recommendedProduct ผลจาก recommendProduct()
 * @param {Set<string>|string[]} availableKeys key ที่มีอยู่จริงในแคตตาล็อกและอนุมัติแล้ว
 * @param {{sentKeys?: string[]}} [opts] key ที่ส่งไปแล้ว (ใช้สลับภาพบรรยากาศ)
 * @returns {string} key ของภาพ หรือ "" ถ้าไม่มีอะไรเหมาะ
 */
export function suggestImageKey(text, recommendedProduct = null, availableKeys = null, { sentKeys = [] } = {}) {
  const allowed = availableKeys instanceof Set
    ? availableKeys
    : new Set(Array.isArray(availableKeys) ? availableKeys : []);
  if (!allowed.size) return "";

  const value = String(text || "");
  // จังหวะชำระเงินชนะทุกอย่าง — ลูกค้ากำลังจะโอน ไม่ใช่กำลังเลือกคลาส
  if (allowed.has(PAYMENT_IMAGE_KEY) && PAYMENT_IMAGE_PATTERN.test(value)) return PAYMENT_IMAGE_KEY;
  // ถามถึงบรรยากาศ/รูปแบบการสอน — ส่งภาพคลาสจริงใบที่ยังไม่เคยส่ง
  if (ATMOSPHERE_PATTERN.test(value)) {
    const sent = new Set(Array.isArray(sentKeys) ? sentKeys : []);
    const nextAtmosphere = ATMOSPHERE_IMAGES.find((key) => allowed.has(key) && !sent.has(key))
      || ATMOSPHERE_IMAGES.find((key) => allowed.has(key));
    if (nextAtmosphere) return nextAtmosphere;
  }
  // ลูกค้าเอ่ยชื่อบริการเองมาก่อน — เขากำลังถามถึงสิ่งนั้นจริง ๆ
  for (const { key, pattern } of SPOKEN_SERVICE) {
    if (allowed.has(key) && pattern.test(value)) return key;
  }
  const routed = PRODUCT_IMAGE[String(recommendedProduct || "")];
  return routed && allowed.has(routed) ? routed : "";
}

// บรรทัดกฎที่บอกโมเดลว่ามีภาพอะไรให้ใช้ — ใช้ถ้อยคำเดียวกับที่ตัวเลือกการ์ดใช้
// เพื่อไม่ให้โมเดลเจอคำสั่งสองแบบเรื่องเดียวกัน
// v1.4.5 (คำสั่งพี่ง้วง 2026-08-15 "รูปคลาสส่งเวลาแนะนำคลาส"): mustAttach = เทิร์นแนะนำ
// รายละเอียดคลาส — ภาษาปล่อยให้เลือกทำให้โมเดลข้ามรูปบ่อย จึงต้องสั่งเป็นภาคบังคับ
// 2026-10-04 (พี่ง้วง "ส่งรูปบ่อยหน่อย จะได้ดู humanize"): nurture = จังหวะที่ทีมจริงส่งรูปประกอบเอง (สวิตช์ natural_voice_mode)
const NURTURE_IMAGE_WORDING = Object.freeze({
  recommend: "ถ้าคำตอบนี้แนะนำหรือพูดถึงคลาสนี้ ให้แนบโปสเตอร์นี้ประกอบด้วย ลูกค้าจะเห็นภาพคลาสจริงโดยไม่ต้องรอขอ",
  confidence: "ลูกค้ายังไม่มั่นใจว่าจะเรียนได้ แนบรูปบรรยากาศคลาสจริงนี้ประกอบด้วย ให้เห็นว่าเรียนกลุ่มเล็กและมีคนช่วยใกล้ชิด",
});
export function imageOfferRule(key, { explicitAsk = false, mustAttach = false, alongsideLadder = false, nurture = "" } = {}) {
  if (!key) return "";
  return `- ภาพที่อนุมัติสำหรับเรื่องที่กำลังคุยกันอยู่: [IMAGE:${key}] `
    + (explicitAsk
      ? "ลูกค้าขอรูปเอง: ส่งรูปด้วย marker นี้"
      : mustAttach
        ? "ลูกค้ากำลังถามถึงคลาสนี้โดยตรง: ต้องใส่ marker นี้ในคำตอบเสมอ ห้ามข้าม"
        : NURTURE_IMAGE_WORDING[nurture]
          || "ถ้าภาพช่วยให้ลูกค้าเห็นภาพชัดขึ้นในเทิร์นนี้ ให้ใส่ marker ได้เลย ไม่ต้องรอให้ลูกค้าขอ")
    + " แล้วจบข้อความด้วยคำถามเดียวที่เป็นประโยชน์ ห้ามใส่ marker เกินหนึ่งใบต่อหนึ่งคำตอบ"
    // รีวิว 2026-10-03: ข้อความแรกมีกติกาบันได 7 Stage "แนบเสมอ" อีกใบ — บอกให้ชัดว่านับแยก ไม่ให้สองกติกาสวนกัน
    + (alongsideLadder ? " (ไม่นับรูปบันได 7 Stage ของข้อความแรก ซึ่งแนบคู่กันได้)" : "");
}
