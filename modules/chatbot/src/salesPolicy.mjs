// salesPolicy.mjs — optional, per-instance opportunity rules for non-product businesses.
//
// This module deliberately does not read customers, orders, scores or tags.  It is
// a pure boundary: score/DISC describe a conversation; this policy describes which
// course and handoff decisions the business has explicitly approved.
import { existsSync, readFileSync } from "node:fs";

const ID = /^[a-z][a-z0-9_-]{1,63}$/u;
const SLOT = /^[a-z][a-z0-9_]{1,63}$/u;
const ROOT_KEYS = new Set([
  "schemaVersion", "businessId", "customerJourneys", "decisionRoles",
  "courses", "opportunities", "routingPrior",
]);
const COURSE_KEYS = new Set(["id", "type", "name", "aliases", "progressesTo"]);
// v1.4.36: requiredSlots กับ handoffSlots ทำคนละหน้าที่ — เดิมใช้ลิสต์เดียวทำสองงาน
//   requiredSlots = "ต้องถามอะไรบ้าง ตามลำดับ" (คุณภาพการขาย — โจทย์ธุรกิจมาก่อนเสมอ)
//   handoffSlots  = "ต้องได้อะไรครบถึงจะส่งต่อคนจริง" (ขั้นต่ำเชิงปฏิบัติการ)
// รวมสองอย่างไว้ลิสต์เดียวแล้วเลือกได้แค่ทางใดทางหนึ่ง: ถ้าตัดโจทย์ธุรกิจออกเพื่อให้
// ส่งต่อเร็ว บอทจะเปิดบทสนทนาด้วย "ขอทราบชื่อบริษัท" ทันที (ห้วนและผิดที่ โดยเฉพาะ
// private class ที่เป็นบุคคล) ถ้าเก็บไว้ handoff จะไม่มีวันครบเมื่อลูกค้าไม่พูดถึงโจทย์
// เป็นคำที่ตัวตรวจหลักฐานรู้จัก — ลีดค้างอยู่กับบอทตลอดไป
// handoffSlots ไม่ใส่ = ใช้ requiredSlots ทั้งชุด (พฤติกรรมเดิมของธุรกิจอื่น)
const OPPORTUNITY_KEYS = new Set([
  "type", "requiredSlots", "optionalSlots", "handoffSlots", "handoffAnyOf", "upsize", "handoffOnComplete",
]);
const ORIGINS = new Set(["direct_request", "proactive_recommendation"]);
const SUPPORTED_SLOTS = new Set([
  "goal", "desired_outcome", "business_need",
  "learner_context", "audience_context", "organization_context",
  "participant_count", "audience_size",
  "format_location", "rough_timeframe", "timeline",
  "current_course_id",
  // v1.2.2 (คำสั่งพี่ง้วง 2026-08-12): งานที่ต้องออกแบบเฉพาะราย (private / in-house /
  // วิทยากร) ส่งต่อทีมงานได้ต่อเมื่อมีช่องทางติดต่อกลับจริง — ทีมงานรับงานต่อได้ทันที
  "contact_phone", "preferred_contact_time",
  // v1.3.6 (คำสั่งพี่ง้วง 2026-08-14): งาน project ให้ชมพู่รับช่วงเอง — ต้องได้ชื่อ
  // บริษัท/แบรนด์เบื้องต้นด้วย ทีมงานจะได้เตรียมข้อมูลที่ตอบโจทย์ก่อนโทรกลับ
  "company_name",
]);

const OUTCOME_EVIDENCE = /(?:เป้าหมาย|เพื่อ(?:ให้|จะ)?|ช่วยแก้|แก้ปัญหา|pain point|ปัญหา|งานซ้ำ|ทำไม่ทัน|ลด(?:งาน|เวลา|ต้นทุน|ขั้นตอน|ปัญหา)|เพิ่ม(?:ยอด|ประสิทธิภาพ|ผลลัพธ์)|อยากให้(?:ทีม|ธุรกิจ|งาน)|ต้องการให้(?:ทีม|ธุรกิจ|งาน)|ทำให้(?:ทีม|งาน|ธุรกิจ))/iu;
const PEOPLE_CONTEXT_EVIDENCE = /(?:ผู้เรียน(?:เป็น|คือ|มีพื้นฐาน|ไม่มีพื้นฐาน|ส่วนใหญ่|หลัก)|ผู้ฟัง(?:เป็น|คือ|ส่วนใหญ่|หลัก)|พนักงาน(?:ฝ่าย|แผนก|เป็น|มีพื้นฐาน|ไม่มีพื้นฐาน)|ทีม(?:การตลาด|ขาย|เซลส์|แอดมิน|ไอที|บริหาร|บัญชี|hr|บุคคล|คอนเทนต์)|ผู้บริหาร(?:ระดับ|ของ|ใน)?)/iu;
const ORGANIZATION_EVIDENCE = /(?:บริษัท|องค์กร|หน่วยงาน|สถาบัน|โรงเรียน|มหาวิทยาลัย|ร้าน|กิจการ|แผนก|ฝ่าย)/iu;
const PEOPLE_COUNT_EVIDENCE = /(?:^|[^\d])\d{1,4}\s*(?:คน|ท่าน)(?=$|[^\p{L}\d])/iu;
const FORMAT_EVIDENCE = /(?:ออนไลน์|online|zoom|ออนไซต์|onsite|on-site|ที่บริษัท|ที่องค์กร|ที่สถานที่|นอกสถานที่)/iu;
// เบอร์ติดต่อกลับ: มือถือไทย 10 หลักขึ้นต้น 06/08/09 (ยอมให้มีขีด/เว้นวรรคคั่น)
const PHONE_EVIDENCE = /0[689]\d{8}/u;
// ชื่อบริษัท: ต้องมีคำบ่งชี้องค์กร/รูปแบบนิติบุคคล — ชื่อแบรนด์ล้วน ๆ ("KTC ค่ะ")
// แยกไม่ออกจากคำตอบทั่วไป จึงยอมให้บอทถามซ้ำแบบชี้เจาะ ("บริษัทชื่ออะไรคะ") ดีกว่าจับมั่ว
//
// v1.4.36: รับ "ชื่อคนติดต่อ" ด้วย (พี่ง้วง 2026-08-19: "ชื่อบริษัท(หรือคนติดต่อ)")
// v1.4.32 ขยายตัวสกัดให้จับ "ผมชื่อโต้งครับ" ไปแล้ว แต่ไม่ได้ขยายตัวตรวจหลักฐานตัวนี้
// ค่าที่สกัดได้จึงถูกทิ้งทุกครั้งอย่างเงียบ ๆ = ลูกค้าบอกชื่อตัวเองแล้วบอทยังวนถามชื่อ
// บริษัทต่อ และ handoff ไม่มีวันครบ (ลีดองค์กรค้างอยู่กับบอท ไม่ถึงชมพู่)
// ต้องเป็น "การแนะนำตัว" เท่านั้น ไม่ใช่การถามชื่อของสิ่งอื่น ("ชื่อคลาสอะไรคะ") —
// จึงบังคับให้ "ชื่อ" อยู่ต้นข้อความหรือหลังช่องว่าง (กัน "ทราบชื่อ...") + บัญชีคำต้องห้าม
const CONTACT_PERSON_EVIDENCE = /(?:^|[\s("'])(?:ผม|ดิฉัน|หนู|เรา|ฉัน)?\s*ชื่อ\s*(?!อะไร|ไร|ไหน|คลาส|คอร์ส|วิชา|หลักสูตร|รอบ|เพจ|เว็บ|บัญชี|ธนาคาร|ไฟล์|ผู้สอน|อาจารย์|วิทยากร)[\p{L}\p{N}]/u;
const COMPANY_NAME_EVIDENCE = /(?:บริษัท|หจก|ห้างหุ้นส่วน|จำกัด|มหาชน|องค์กร|หน่วยงาน|สถาบัน|โรงเรียน|มหาวิทยาลัย|โรงงาน|โรงแรม|โรงพยาบาล|คลินิก|ร้าน|แบรนด์|กิจการ|บ\.|จก\.?|brand|co\.|ltd|inc\b|corp|company|group)/iu;
const CONTACT_TIME_EVIDENCE = /(?:เช้า|สาย|บ่าย|เย็น|ค่ำ|กลางวัน|หลังเลิกงาน|พักเที่ยง|\d{1,2}\s*[:.]\s*\d{2}|\d{1,2}\s*(?:โมง|ทุ่ม|น\.)|วัน(?:จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์|ธรรมดา|ทำการ)|ช่วง(?:ไหน|เช้า|บ่าย|เย็น)|สะดวก)/iu;
const TIMEFRAME_EVIDENCE = /(?:เดือน(?:นี้|หน้า|ถัดไป|ที่\s*\d+)|สัปดาห์(?:นี้|หน้า|ถัดไป)|ไตรมาส(?:นี้|หน้า|ที่\s*\d+)|ภายใน\s*\d+\s*(?:วัน|สัปดาห์|เดือน)|เร็ว\s*ๆ\s*นี้|\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)/iu;

function fail(message) {
  throw new Error(`Invalid sales policy: ${message}`);
}

function text(value, label, { max = 200, required = true } = {}) {
  if (typeof value !== "string") {
    if (!required) return "";
    fail(`${label} must be a string`);
  }
  const clean = value.trim();
  if (required && !clean) fail(`${label} must not be empty`);
  if (clean.length > max) fail(`${label} exceeds ${max} characters`);
  return clean;
}

function id(value, label) {
  const clean = text(value, label, { max: 64 });
  if (!ID.test(clean)) fail(`${label} must be a lowercase identifier`);
  return clean;
}

function uniqueIds(values, label) {
  if (!Array.isArray(values) || !values.length) fail(`${label} must be a non-empty array`);
  const out = values.map((value, index) => id(value, `${label}[${index}]`));
  if (new Set(out).size !== out.length) fail(`${label} contains duplicates`);
  return out;
}

function slots(values, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(values)) fail(`${label} must be an array`);
  if (!allowEmpty && !values.length) fail(`${label} must not be empty`);
  const out = values.map((value, index) => text(value, `${label}[${index}]`, { max: 64 }));
  if (out.some((value) => !SLOT.test(value))) fail(`${label} contains an invalid slot`);
  if (out.some((value) => !SUPPORTED_SLOTS.has(value))) fail(`${label} contains an unsupported evidence slot`);
  if (new Set(out).size !== out.length) fail(`${label} contains duplicates`);
  return out;
}

/**
 * Validate and freeze an instance-owned policy.  The intentionally small schema
 * keeps current commercial facts (price/date/seat) out of this policy.
 */
export function validateSalesPolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("root must be an object");
  for (const key of Object.keys(input)) {
    if (!ROOT_KEYS.has(key)) fail(`root has unknown key ${key}`);
  }
  if (input.schemaVersion !== 1) fail("schemaVersion must be 1");

  const businessId = id(input.businessId, "businessId");
  const customerJourneys = uniqueIds(input.customerJourneys, "customerJourneys");
  const decisionRoles = uniqueIds(input.decisionRoles, "decisionRoles");

  if (!Array.isArray(input.courses) || !input.courses.length) fail("courses must be a non-empty array");
  const courseIds = new Set();
  const courses = input.courses.map((course, index) => {
    if (!course || typeof course !== "object" || Array.isArray(course)) fail(`courses[${index}] must be an object`);
    for (const key of Object.keys(course)) {
      if (!COURSE_KEYS.has(key)) fail(`courses[${index}] has unknown key ${key}`);
    }
    const courseId = id(course.id, `courses[${index}].id`);
    if (courseIds.has(courseId)) fail(`courses contains duplicate id ${courseId}`);
    courseIds.add(courseId);
    const aliases = Array.isArray(course.aliases)
      ? course.aliases.map((alias, aliasIndex) => text(alias, `courses[${index}].aliases[${aliasIndex}]`, { max: 100 }))
      : fail(`courses[${index}].aliases must be an array`);
    if (!aliases.length) fail(`courses[${index}].aliases must not be empty`);
    return Object.freeze({
      id: courseId,
      type: id(course.type, `courses[${index}].type`),
      name: text(course.name, `courses[${index}].name`, { max: 160 }),
      aliases: Object.freeze([...new Set(aliases)]),
      progressesTo: course.progressesTo == null ? null : id(course.progressesTo, `courses[${index}].progressesTo`),
    });
  });
  for (const course of courses) {
    if (course.progressesTo && !courseIds.has(course.progressesTo)) {
      fail(`courses.${course.id}.progressesTo is not a configured course`);
    }
  }

  if (!Array.isArray(input.opportunities) || !input.opportunities.length) fail("opportunities must be a non-empty array");
  const opportunityTypes = new Set();
  const opportunities = input.opportunities.map((opportunity, index) => {
    if (!opportunity || typeof opportunity !== "object" || Array.isArray(opportunity)) fail(`opportunities[${index}] must be an object`);
    for (const key of Object.keys(opportunity)) {
      if (!OPPORTUNITY_KEYS.has(key)) fail(`opportunities[${index}] has unknown key ${key}`);
    }
    const type = id(opportunity.type, `opportunities[${index}].type`);
    if (opportunityTypes.has(type)) fail(`opportunities contains duplicate type ${type}`);
    opportunityTypes.add(type);
    const requiredSlots = slots(opportunity.requiredSlots, `opportunities[${index}].requiredSlots`);
    const optionalSlots = slots(opportunity.optionalSlots ?? [], `opportunities[${index}].optionalSlots`, { allowEmpty: true });
    if (optionalSlots.some((slot) => requiredSlots.includes(slot))) fail(`opportunities.${type} repeats a required slot`);
    // v1.5.x (คำสั่งพี่ง้วง 1 ก.ย. 2026: "ถามเยอะเกิน strict เกิน จะพลาดลีดไป"):
    // handoffAnyOf = "ได้อย่างใดอย่างหนึ่งก็ส่งต่อได้" ต่างจาก handoffSlots ที่ต้องครบทุกช่อง
    // ของจริง: ห้องงาน in-house ที่มีสถานะจริง 3 ห้อง ส่งต่อได้ 0 ห้องตลอดอายุระบบ
    // สองห้องให้เบอร์โทรมาแล้ว ติดแค่ชื่อบริษัท เบอร์จึงค้างในบอทโดยไม่มีใครโทรกลับ
    const handoffAnyOf = opportunity.handoffAnyOf === undefined
      ? []
      : slots(opportunity.handoffAnyOf, `opportunities[${index}].handoffAnyOf`, { allowEmpty: true });
    // ต้องเป็นสับเซ็ตของสิ่งที่ถาม — ส่งต่อโดยรอ slot ที่ไม่มีใครถามคือรอตลอดกาล
    const handoffSlots = opportunity.handoffSlots === undefined
      ? (handoffAnyOf.length ? [] : requiredSlots)
      : slots(opportunity.handoffSlots, `opportunities[${index}].handoffSlots`, { allowEmpty: true });
    const strays = handoffSlots.filter((slot) => !requiredSlots.includes(slot));
    if (strays.length) fail(`opportunities.${type}.handoffSlots must be a subset of requiredSlots (${strays.join(",")})`);
    const anyStrays = handoffAnyOf.filter((slot) => !requiredSlots.includes(slot));
    if (anyStrays.length) fail(`opportunities.${type}.handoffAnyOf must be a subset of requiredSlots (${anyStrays.join(",")})`);
    return Object.freeze({
      type,
      requiredSlots: Object.freeze(requiredSlots),
      handoffSlots: Object.freeze(handoffSlots),
      handoffAnyOf: Object.freeze(handoffAnyOf),
      optionalSlots: Object.freeze(optionalSlots),
      // An upsize is more sensitive than a normal course-progression suggestion.
      // It always needs explicit high-confidence decision authority and business need.
      upsize: opportunity.upsize === true,
      handoffOnComplete: opportunity.handoffOnComplete === true,
    });
  });

  let routingPrior = null;
  if (input.routingPrior !== undefined) {
    const raw = input.routingPrior;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("routingPrior must be an object");
    const allowed = new Set(["dominantInterest", "share", "publicClaimAuthorized"]);
    for (const key of Object.keys(raw)) {
      if (!allowed.has(key)) fail(`routingPrior has unknown key ${key}`);
    }
    const share = Number(raw.share);
    if (!Number.isFinite(share) || share < 0 || share > 1) fail("routingPrior.share must be from 0 to 1");
    if (raw.publicClaimAuthorized !== false) fail("routingPrior.publicClaimAuthorized must be false");
    routingPrior = Object.freeze({
      dominantInterest: id(raw.dominantInterest, "routingPrior.dominantInterest"),
      share,
      publicClaimAuthorized: false,
    });
  }

  return Object.freeze({
    schemaVersion: 1,
    businessId,
    customerJourneys: Object.freeze(customerJourneys),
    decisionRoles: Object.freeze(decisionRoles),
    courses: Object.freeze(courses),
    opportunities: Object.freeze(opportunities),
    routingPrior,
  });
}

// Missing path is intentionally disabled.  A configured but bad file is an
// operator/configuration error and must fail at startup rather than silently run
// with a different sales policy.
export function loadSalesPolicy(file) {
  if (!file) return null;
  if (!existsSync(file)) throw new Error(`Invalid sales policy: configured file does not exist (${file})`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Invalid sales policy: cannot parse ${file} (${error.message})`);
  }
  return validateSalesPolicy(parsed);
}

function cleanSlotValue(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/gu, " ").slice(0, 500) : "";
}

function exactCustomerQuote(value, customerText) {
  const quote = cleanSlotValue(value);
  const source = typeof customerText === "string"
    ? customerText.trim().replace(/\s+/gu, " ").slice(0, 20_000)
    : "";
  if (quote.length < 2 || !source) return "";
  return source.toLocaleLowerCase("th-TH").includes(quote.toLocaleLowerCase("th-TH")) ? quote : "";
}

function courseEvidenceValid(value, evidence, policy) {
  const course = policy.courses.find((item) => item.id === value);
  if (!course || !/(?:เคยเรียน|เรียนมาแล้ว|ศิษย์เก่า)/iu.test(evidence)) return false;
  const normalizedEvidence = evidence.toLocaleLowerCase("th-TH");
  return [course.name, ...course.aliases]
    .some((name) => normalizedEvidence.includes(String(name).toLocaleLowerCase("th-TH")));
}

// v1.4.1: สกัด slot แกนหลักจากข้อความลูกค้าโดยตรง — scorer โมเดลคืน slot ไม่สม่ำเสมอ
// (เคสจริง: คืน company_name แต่ไม่คืน business_need ทั้งที่ลูกค้าพูดชัด) ทำให้ ping
// ถึงทีมงานไม่มีวันยิง ชั้นนี้ deterministic + quote จากข้อความจริงเท่านั้น จึงคง
// สัญญา traceability เดิมครบ (ทุก slot ตรวจย้อนได้ว่าลูกค้าพูดเมื่อไหร่)
const SLOT_QUOTE_EXTRACTORS = Object.freeze({
  business_need: /(?:pain point|ปัญหา|งานซ้ำ|ทำไม่ทัน|ลด(?:งาน|เวลา|ต้นทุน|ขั้นตอน)|เพิ่ม(?:ยอด|ประสิทธิภาพ|ผลลัพธ์)|อยากให้(?:ทีม|ธุรกิจ|งาน)|ต้องการให้(?:ทีม|ธุรกิจ|งาน))[^\n]{0,160}/iu,
  // ห้ามจับ "บริษัท" เดี่ยว — "ให้ไปสอนที่บริษัท มีไหมครับ" เคยถูกเก็บเป็นชื่อบริษัทจริง ๆ
  // ต้องมีร่องรอยการบอกชื่อ (ชื่อบริษัท.../...จำกัด/หจก./แบรนด์) เท่านั้น
  // v1.4.32 (พี่ง้วงกำหนด 2026-08-19): "ชื่อบริษัท หรือชื่อคนติดต่อ" อย่างใดอย่างหนึ่งพอ
  // ลูกค้าจำนวนมากแนะนำตัวด้วยชื่อตัวเองก่อน ("ผมชื่อโต้งครับ") ถ้าไม่รับชื่อคน
  // บอทจะวนถามชื่อบริษัทต่อทั้งที่ได้ข้อมูลติดต่อครบแล้ว = ลีดองค์กรค้างอยู่กับบอท
  company_name: /(?:(?:ชื่อบริษัท|บริษัทชื่อ|ร้านชื่อ|แบรนด์)[^\n]{0,80}|[^\n]{0,60}(?:จำกัด|มหาชน)|(?:หจก\.?|ห้างหุ้นส่วน)[^\n]{0,80}|(?:ผม|ดิฉัน|หนู|เรา)?\s*ชื่อ\s*[^\s\n]{1,30})/iu,
  contact_phone: /0[689][\d\s-]{8,12}/u,
  preferred_contact_time: /(?:สะดวก[^\n]{0,80}|ช่วง(?:เช้า|บ่าย|เย็น|ค่ำ)[^\n]{0,60}|หลังเลิกงาน[^\n]{0,60}|\d{1,2}\s*(?:โมง|ทุ่ม|น\.)[^\n]{0,60}|วัน(?:จันทร์|อังคาร|พุธ|พฤหัส|ศุกร์|เสาร์|อาทิตย์|ธรรมดา|ทำการ)[^\n]{0,60})/iu,
  participant_count: /(?:^|[^\d])(\d{1,4}\s*(?:คน|ท่าน))(?=$|[^\p{L}\d])/iu,
});

function extractSlotQuote(slot, latestCustomerText) {
  const pattern = SLOT_QUOTE_EXTRACTORS[slot];
  if (!pattern) return "";
  const match = pattern.exec(String(latestCustomerText || ""));
  if (!match) return "";
  return (match[1] ?? match[0]).trim().replace(/\s+/gu, " ").slice(0, 200);
}

function slotEvidenceValid(slot, value, evidence, policy) {
  if (!evidence) return false;
  if (["goal", "desired_outcome", "business_need"].includes(slot)) return OUTCOME_EVIDENCE.test(evidence);
  if (["learner_context", "audience_context"].includes(slot)) return PEOPLE_CONTEXT_EVIDENCE.test(evidence);
  if (slot === "organization_context") return ORGANIZATION_EVIDENCE.test(evidence);
  if (["participant_count", "audience_size"].includes(slot)) return PEOPLE_COUNT_EVIDENCE.test(evidence);
  if (slot === "format_location") return FORMAT_EVIDENCE.test(evidence);
  if (["rough_timeframe", "timeline"].includes(slot)) return TIMEFRAME_EVIDENCE.test(evidence);
  if (slot === "contact_phone") return PHONE_EVIDENCE.test(evidence.replace(/[\s-]/gu, ""));
  if (slot === "preferred_contact_time") return CONTACT_TIME_EVIDENCE.test(evidence);
  if (slot === "company_name") return COMPANY_NAME_EVIDENCE.test(evidence) || CONTACT_PERSON_EVIDENCE.test(evidence);
  if (slot === "current_course_id") return courseEvidenceValid(value, evidence, policy);
  return false;
}

// v1.4.1 (เคสจริง 2026-08-14): "แล้วให้ไปสอนที่บริษัท มีไหม" ไม่เข้า pattern เดิมเลย
// (เดิมรู้จักแค่คำว่า "อบรม" กับ in-house ภาษาอังกฤษ) — ลูกค้าไทยพูด "สอน/เทรน/จัดคลาส
// ที่บริษัท-ออฟฟิศ-โรงงาน" กันเป็นปกติ; ระวังไม่จับคำถามเรื่องสถานที่เรียนของเรา
// ("เรียนที่บริษัทพี่ง้วงใช่ไหม" ไม่มีกริยา สอน/อบรม/เทรน นำหน้า จึงไม่ติด)
//
// v1.4.36: ยังพลาดทรงที่พบบ่อยที่สุด — มี "สิ่งที่สอน" คั่นระหว่างกริยากับผู้รับ
// ("จัดอบรม AI ให้ทีมที่บริษัท" / "สอน AI ให้ทีมขาย" / "จัดเทรนนิ่ง AI ในองค์กร")
// เดิมบังคับให้กริยาติดกับ ที่/ใน+สถานที่ ทันที จึงจับไม่ได้ 5 ใน 8 ประโยคที่ทดสอบ
// ผลคือโหมดคัดกรองงาน project ไม่ทำงานเลย = บอทกลับไปเทราคาทั้งชุด (บั๊กเดิม v1.4.1)
// และ handoff ไม่มีวันเกิด ลีดองค์กรค้างอยู่กับบอท
// ยอมให้มีคำคั่นได้ไม่เกิน 20 ตัว แต่ห้ามข้ามคำถาม/คำลงท้าย ("สอนแบบไหนคะ ที่บริษัท…"
// เป็นคำถามเรื่องคลาสของเรา ไม่ใช่การขอให้ไปสอน) — กัน false positive ที่แพงกว่าการพลาด
const TRAINING_VERB = "(?:สอน|อบรม|เทรน|จัด(?:คลาส|คอร์ส|อบรม|เทรนนิ่ง))";
// คำคั่นที่ยอมได้: อะไรก็ได้ที่ไม่ใช่คำถาม/คำลงท้ายประโยค (กันการข้ามไปคนละใจความ)
const SAME_CLAUSE_GAP = "(?:(?!ไหน|อะไร|กี่|บ้าง|คะ|ครับ|ค่ะ|\\?|？)[^\\n]){0,20}?";
const TRAINING_TARGET = "(?:ทีม|พนักงาน|บริษัท|องค์กร|ออฟฟิศ|สำนักงาน|โรงงาน|หน่วยงาน|ที่ทำงาน)";
// พี่ง้วง 13 ต.ค.: "Classroom = On-site เช่นกัน" — แชทจริง: ลูกแพรถาม "On-site หรือออนไลน์" ลูกค้าตอบ "On-site ค่ะ"
// แล้วถูกพาเข้าเส้น In-house ที่บริษัท · on-site/ออนไซต์ เปล่า ๆ = คลาสสอนสดที่ห้องเรียน ไม่ใช่งานองค์กร
// นับเป็น in-house เฉพาะเมื่อมีปลายทางเป็นทีม/บริษัทในประโยคเดียวกัน ("onsite ที่บริษัท" · "on-site ให้พนักงาน")
const ON_SITE_AT_TARGET = `(?:on[-\\s]?site|ออนไซต์|ออนไซท์)${SAME_CLAUSE_GAP}(?:ให้|ที่|ถึง(?:ที่)?|ใน)\\s*${TRAINING_TARGET}`;
const IN_HOUSE_INTENT = new RegExp(
  `(?:in[-\\s]?house|อินเฮาส์|${ON_SITE_AT_TARGET}`
  + "|อบรม(?:ทีม|ในองค์กร|บริษัท|พนักงาน|ภายใน|ให้(?:ทีม|บริษัท|องค์กร|พนักงาน))"
  + `|(?:ให้)?(?:ไป|มา|เข้าไป|เข้ามา)?\\s*${TRAINING_VERB}${SAME_CLAUSE_GAP}(?:ให้|ที่|ถึง(?:ที่)?|ใน)\\s*${TRAINING_TARGET}`
  + "|สอนพนักงาน|เทรนพนักงาน|เทรนทีม|สอนทีมงาน"
  // แชทจริง 13 ต.ค.: "จะเชิญมาอบรม จากระดับ3 ไปให้ถึงระดับ 6" (เชิญเราไปสอนทีมเขา) เคยได้คำขายคลาสสด — เชิญ+อบรม/สอน = งานองค์กร
  + "|เชิญ\\s*(?:พี่ง้วง|วิทยากร|ทีม)?\\s*(?:ไป|มา|เข้าไป|เข้ามา)?\\s*(?:อบรม|สอน|เทรน))",
  "iu",
);
const BARE_ON_SITE = /on[-\s]?site|ออนไซต์|ออนไซท์/iu;
/**
 * หมุด in-house เก่าที่มาจาก on-site เปล่า ๆ (ก่อน 13 ต.ค. ตัวจับนับ "online หรือ onsite" เป็นงานองค์กร — 11 ห้องค้างหมุดตั้งแต่ ก.ย.)
 * = ยังไม่ได้ข้อมูลองค์กรสักช่อง · ลูกค้าพูดคำ on-site · และไม่มีข้อความไหนของลูกค้าที่เป็นเจตนา in-house จริงตามตัวจับปัจจุบัน
 */
export function staleOnSitePin(opportunity, customerTexts = []) {
  if (opportunity?.type !== "in_house_training" || opportunity.origin !== "direct_request") return false;
  if (Object.keys(opportunity.slots || {}).length) return false;
  const texts = (Array.isArray(customerTexts) ? customerTexts : [customerTexts]).map((text) => String(text || ""));
  return texts.some((text) => BARE_ON_SITE.test(text)) && !texts.some((text) => IN_HOUSE_INTENT.test(text));
}

// ตัวจับ opportunity ชุดเดียวของทั้งระบบ — ห้ามมีสำเนาที่ไหนอีก
// (ตรวจปรปักษ์ 2026-09-04: แกนโปรโมชั่นเคยมีตัวจับงาน project ของตัวเองใน priceDisclosure
//  ซึ่งไม่ตรงกับตัวนี้ ผลคือพรอมต์ก้อนเดียวแบกทั้งแม่แบบ "PROMOTION Early Bird 📌" และ
//  "ห้ามยกตารางราคา ราคาโปร" พร้อมกัน เมื่อสองตัวอ่านข้อความเดียวกันแล้วตอบไม่ตรงกัน)
// "บรรยาย" เดี่ยว ๆ ถูกถอดออก (ตรวจปรปักษ์ 2026-09-04 รอบที่หก): มันคือคำไทยธรรมดาที่แปลว่า
// "อธิบาย/เล่า" ("ช่วยบรรยายรายละเอียดคลาสหน่อยค่ะ" / "บรรยายภาพให้หน่อย") ไม่ได้บอกเจตนา
// จ้างวิทยากรอะไรเลย แต่มันขับแกนโปรโมชั่นอยู่ — ลูกค้าที่พูดคำนี้ครั้งเดียวในห้อง จะถูกตัด
// โปรโมชั่นทิ้งทั้งห้องแบบไม่มีวันกลับ ทั้งที่เขาแค่ขอให้เราอธิบายคลาส
// ตอนนี้ต้องมีบริบทของ "การไปพูดให้ใครฟัง" มาด้วย ("เชิญ...บรรยาย" / "ไปบรรยาย" /
// "บรรยายให้พนักงาน" / "บรรยายพิเศษ" / "ค่าตัวบรรยาย") ซึ่งเป็นเจตนาจริง ๆ
// speaker / วิทยากร ยังเปล่าได้เหมือนเดิม — สองคำนั้นไม่มีความหมายอื่นในบริบทนี้
const SPEAKER_INTENT = new RegExp(
  "(?:speaker|วิทยากร"
  + "|(?:เชิญ|รับ|ไป|มา|เข้า(?:ไป|มา)|ขอ|จ้าง|ให้)\\s*(?:ไป|มา)?\\s*บรรยาย"
  + "|บรรยาย(?:ให้|ที่|ใน|พิเศษ|งาน|สัมมนา)"
  + "|(?:ค่าตัว|คิวงาน|ตารางงาน)\\s*บรรยาย)",
  "iu",
);

const OPPORTUNITY_PATTERNS = Object.freeze([
  ["speaker_engagement", SPEAKER_INTENT],
  ["in_house_training", IN_HOUSE_INTENT],
  ["private_class", /(?:private\s*class|เรียนตัวต่อตัว|เรียนส่วนตัว|คลาสส่วนตัว)/iu],
  ["course_progression", /(?:เรียนต่อ|ต่อยอด|ต่อคลาส|ต่อคอร์ส|เคยเรียน|เรียนมาแล้ว|ศิษย์เก่า)/iu],
]);

// งานออกแบบเฉพาะราย — ทีมผู้ดูแลเป็นผู้ออกใบเสนอราคาเสมอ (คำสั่งพี่ง้วง 2026-08-14)
// course_progression ไม่อยู่ในชุดนี้: มันคือลูกค้าเก่าที่กลับมาเรียนคลาสรวม ไม่ใช่งาน project
export const PROJECT_OPPORTUNITY_TYPES = new Set(["in_house_training", "private_class", "speaker_engagement"]);

function directOpportunityType(customerText, policy) {
  const value = String(customerText || "");
  return OPPORTUNITY_PATTERNS.find(([type, pattern]) =>
    policy.opportunities.some((item) => item.type === type) && pattern.test(value))?.[0] || null;
}

// 2026-09-04 (ตรวจปรปักษ์รอบที่แปด): `detectProjectOpportunityShape` ถูกลบทั้งฟังก์ชัน
//
// มันคือสำเนาของตัวจับข้างบนที่ **ตัดด่าน policy.opportunities ออก** แล้วกวาดทับทุกเทิร์น
// ของลูกค้าในหน้าต่างประวัติ ให้แกนโปรโมชั่นใน priceDisclosure ใช้ ผลที่วัดได้คือคำถาม
// ก่อนซื้อธรรมดา ("วิทยากรคือใครคะ" / "คลาสนี้สอนพนักงานออฟฟิศได้ไหมคะ") ตัดโปรโมชั่น
// Early Bird ทิ้งทั้งห้องอย่างถาวร — ตัวจับที่ไม่มีด่านย่อมกว้างกว่าตัวจับที่ pipeline ใช้จริง
// เสมอ และ "ความเป็นซูเปอร์เซ็ต" ที่เคยอ้างว่าปลอดภัยก็คือรอยรั่วนั้นตรง ๆ
// ตอนนี้แกนโปรฯ อ่าน resolveProjectOpportunity ของไปป์ไลน์ตัวเดียว (ผ่าน policy + หมุดที่
// บันทึกไว้จริง) จึงไม่มีนิยาม "งาน project" ตัวที่สองในระบบให้เพี้ยนออกจากกันได้อีก

// v1.4.1: ให้ pipeline ตรวจ "ข้อความปัจจุบัน" ตอนตอบได้เลย — sales state จาก scorer
// ช้าหนึ่งเทิร์นเสมอ (scorer รันหลังตอบ) เทิร์นแรกที่ลูกค้าเอ่ยงาน project จึงต้องมี
// ตัวตรวจ deterministic ฝั่ง reply ไม่งั้นบอทเทราคาหมดก่อนเข้าสู่โหมดคัดกรอง
export function detectDirectOpportunityType(customerText, policy) {
  if (!policy) return null;
  return directOpportunityType(customerText, policy);
}

function proactiveOpportunityType(customerText, policy, role) {
  if (!role || !OUTCOME_EVIDENCE.test(String(customerText || ""))) return null;
  const value = String(customerText || "");
  if (policy.opportunities.some((item) => item.type === "in_house_training" && item.upsize)
      && PEOPLE_CONTEXT_EVIDENCE.test(value) && PEOPLE_COUNT_EVIDENCE.test(value)) {
    return "in_house_training";
  }
  if (policy.opportunities.some((item) => item.type === "private_class" && item.upsize)
      && /(?:โจทย์เฉพาะ|ปรึกษา|consult|ตัวเอง|เฉพาะธุรกิจ)/iu.test(value)) {
    return "private_class";
  }
  return null;
}

function decisionRoleRetracted(customerText) {
  const value = String(customerText || "");
  return /(?:พิมพ์ผิด|พูดผิด|ไม่ใช่|ไม่ได้เป็น).{0,40}(?:owner|ceo|decision[ -]?maker|ผู้ตัดสินใจ|เจ้าของ)/iu.test(value)
    || /(?:เป็นพนักงาน|เป็นลูกจ้าง|ไม่มีอำนาจตัดสินใจ|ไม่ได้เป็นคนตัดสินใจ)/iu.test(value);
}

function learningHistoryRetracted(customerText) {
  const value = String(customerText || "");
  return /(?:ไม่เคยเรียน|ยังไม่เคยเรียน|ไม่ใช่ศิษย์เก่า)/iu.test(value)
    || /(?:พิมพ์ผิด|พูดผิด).{0,40}(?:เคยเรียน|เรียนมาแล้ว|ศิษย์เก่า)/iu.test(value);
}

function explicitDecisionRole(customerText, policy) {
  const value = String(customerText || "");
  const subject = "(?:ผม|ดิฉัน|ฉัน|หนู|เรา)\\s*(?:เป็น|คือ|ทำหน้าที่เป็น|เป็นคน)|(?:i\\s+am|i['’]m)|ในฐานะ";
  const candidates = [
    ["ceo", new RegExp(`(?:${subject})\\s*(?:the\\s+)?(?:ceo|ซีอีโอ)`, "iu")],
    ["owner", new RegExp(`(?:${subject})\\s*(?:the\\s+)?(?:owner|เจ้าของ(?:กิจการ|บริษัท|ธุรกิจ)?)`, "iu")],
    ["decision_maker", new RegExp(`(?:${subject})\\s*(?:the\\s+)?(?:decision[ -]?maker|ผู้(?:มีอำนาจ)?ตัดสินใจ|คนตัดสินใจ)`, "iu")],
  ];
  for (const [role, pattern] of candidates) {
    const match = value.match(pattern);
    if (policy.decisionRoles.includes(role) && match) {
      return Object.freeze({ role, source: "inbound_customer", evidence: cleanSlotValue(match[0]) });
    }
  }
  return null;
}

export function detectExplicitDecisionRole(customerText, policy) {
  return explicitDecisionRole(customerText, policy)?.role || null;
}

function verifiedJourney(policy, verifiedLearning) {
  if (!verifiedLearning || typeof verifiedLearning !== "object") return null;
  const journey = typeof verifiedLearning.customerJourney === "string" ? verifiedLearning.customerJourney : "";
  const source = typeof verifiedLearning.source === "string" ? verifiedLearning.source : "";
  const sourceRef = cleanSlotValue(verifiedLearning.sourceRef);
  if (!policy.customerJourneys.includes(journey) || !sourceRef) return null;
  if (journey === "new_lead") {
    return source === "no_verified_learning_record"
      ? Object.freeze({ customerJourney: journey, source, sourceRef, courseId: null })
      : null;
  }
  const courseId = typeof verifiedLearning.courseId === "string" ? verifiedLearning.courseId : "";
  const verifiedCourse = ["verified_enrollment", "verified_course_order"].includes(source)
    && policy.courses.some((course) => course.id === courseId);
  return verifiedCourse
    ? Object.freeze({ customerJourney: journey, source, sourceRef, courseId })
    : null;
}

function selfReportedCourse(customerText, policy) {
  const value = String(customerText || "").toLocaleLowerCase("th-TH");
  if (!/(?:เคยเรียน|เรียนมาแล้ว|ศิษย์เก่า)/u.test(value)) return null;
  for (const course of policy.courses) {
    if ([course.name, ...course.aliases].some((name) => value.includes(String(name).toLocaleLowerCase("th-TH")))) {
      return course.id;
    }
  }
  return null;
}

/**
 * Normalize untrusted scorer JSON.  It never turns an unknown journey, course,
 * role or opportunity into a recommendation.
 */
export function normalizeSalesSignals(raw = {}, policy, previousState = null, {
  customerText = "",
  // Routing and every newly durable slot must come from the latest inbound
  // turn. Previous normalized slots carry forward explicitly; letting a model
  // re-quote any older SCORE_TURNS text would allow a completed enquiry's
  // requirements to leak into a new session.
  latestCustomerText = customerText,
  verifiedLearning = null,
} = {}) {
  if (!policy) return Object.freeze({ enabled: false, customerJourney: "unknown", opportunity: null });
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const freshLearning = verifiedJourney(policy, verifiedLearning);
  const priorLearning = verifiedJourney(policy, previousState?.learningVerification);
  const learningVerification = freshLearning || priorLearning;
  const customerJourney = learningVerification?.customerJourney || "unknown";
  const roleRetracted = decisionRoleRetracted(latestCustomerText);
  const freshRole = roleRetracted ? null : explicitDecisionRole(latestCustomerText, policy);
  const priorRole = !roleRetracted && previousState?.decisionRoleSource === "inbound_customer"
    && policy.decisionRoles.includes(previousState?.decisionRole)
    && cleanSlotValue(previousState?.decisionRoleEvidence)
      ? Object.freeze({
          role: previousState.decisionRole,
          source: "inbound_customer",
          evidence: cleanSlotValue(previousState.decisionRoleEvidence),
        })
      : null;
  const roleEvidence = freshRole || priorRole;
  const role = roleEvidence?.role || null;
  const learningRetracted = learningHistoryRetracted(latestCustomerText);
  const reportedCourseId = learningRetracted
    ? null
    : (selfReportedCourse(latestCustomerText, policy) || previousState?.reportedCourseId || null);
  const freshCandidate = input.opportunity && typeof input.opportunity === "object" && !Array.isArray(input.opportunity)
    ? input.opportunity : null;
  const previousOpportunity = previousState?.opportunity && typeof previousState.opportunity === "object"
    ? previousState.opportunity : null;
  const previousActive = previousOpportunity && previousOpportunity.handoffReady !== true
    && !(learningRetracted && previousOpportunity.type === "course_progression")
    && !staleOnSitePin(previousOpportunity, String(customerText || "").split("\n"))
    ? previousOpportunity : null;
  const detectedDirectType = directOpportunityType(latestCustomerText, policy);
  const directType = learningRetracted && detectedDirectType === "course_progression"
    ? null
    : detectedDirectType;
  const proactiveType = directType ? null : proactiveOpportunityType(latestCustomerText, policy, role);
  const routedType = directType || proactiveType;
  const candidateType = routedType || previousActive?.type || "";
  const definition = policy.opportunities.find((item) => item.type === candidateType);
  if (!definition) {
    return Object.freeze({
      enabled: true,
      customerJourney,
      learningVerification,
      reportedCourseId,
      decisionRole: role,
      decisionRoleSource: roleEvidence?.source || null,
      decisionRoleEvidence: roleEvidence?.evidence || null,
      opportunity: null,
    });
  }

  const startsNewSession = Boolean(routedType) && previousOpportunity?.handoffReady === true;
  const samePrevious = previousActive?.type === definition.type && !startsNewSession
    ? previousActive : null;
  // The model can propose slot records only inside a route established by
  // deterministic customer wording or an already-open server state. Unknown or
  // mismatched fresh types cannot switch/erase that state.
  const candidate = freshCandidate && (!freshCandidate.type || freshCandidate.type === definition.type)
    ? freshCandidate : {};

  const allowedSlots = new Set([...definition.requiredSlots, ...definition.optionalSlots]);
  const rawSlots = candidate.slots && typeof candidate.slots === "object" && !Array.isArray(candidate.slots)
    ? candidate.slots : {};
  const normalizedSlots = {};
  const usedEvidence = new Set();
  for (const [slot, value] of Object.entries(samePrevious?.slots || {})) {
    if (allowedSlots.has(slot) && cleanSlotValue(value)) {
      normalizedSlots[slot] = cleanSlotValue(value);
      usedEvidence.add(cleanSlotValue(value).toLocaleLowerCase("th-TH"));
    }
  }
  for (const slot of allowedSlots) {
    const record = rawSlots[slot];
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const evidence = exactCustomerQuote(record.evidence, latestCustomerText);
    if (!evidence) continue;
    const value = cleanSlotValue(record.value);
    const evidenceKey = evidence.toLocaleLowerCase("th-TH");
    if (usedEvidence.has(evidenceKey) || !slotEvidenceValid(slot, value, evidence, policy)) continue;
    // Course progression uses canonical ids, not fuzzy aliases from a model.
    if (slot === "current_course_id") {
      if (!policy.courses.some((course) => course.id === value)) continue;
      normalizedSlots[slot] = value;
      usedEvidence.add(evidenceKey);
      continue;
    }
    // Persist the exact inbound quote, not an LLM paraphrase. This makes every
    // handoff field traceable to a real customer turn and prevents invented slot values.
    normalizedSlots[slot] = evidence;
    usedEvidence.add(evidenceKey);
  }
  // v1.4.1: ชั้น deterministic เติม slot ที่โมเดลไม่คืน — quote จากข้อความล่าสุดของ
  // ลูกค้าเท่านั้น และผ่านตัวตรวจหลักฐานเดียวกับ slot จากโมเดลทุกตัว
  // (optional ที่มีตัวสกัดก็เติมด้วย — ทำให้สรุป ping ถึงทีมงานสมบูรณ์ขึ้น เช่น จำนวนคน)
  for (const slot of [...definition.requiredSlots, ...definition.optionalSlots]) {
    if (normalizedSlots[slot]) continue;
    const quote = extractSlotQuote(slot, latestCustomerText);
    if (!quote || !slotEvidenceValid(slot, quote, quote, policy)) continue;
    const quoteKey = quote.toLocaleLowerCase("th-TH");
    if (usedEvidence.has(quoteKey)) continue;
    normalizedSlots[slot] = quote;
    usedEvidence.add(quoteKey);
  }
  const missingSlots = definition.requiredSlots.filter((slot) => !normalizedSlots[slot]);
  // v1.4.36 (พี่ง้วง 2026-08-19: "เอาแค่ 3 อย่างพอ ... เพราะชมพู่เก็บต่อเอง"):
  // การส่งต่อรอเฉพาะ handoffSlots — slot อื่นที่ยังขาดถือเป็นข้อมูลเสริม ไม่ใช่ตัวขวาง
  const missingHandoffSlots = definition.handoffSlots.filter((slot) => !normalizedSlots[slot]);
  const businessNeed = Boolean(normalizedSlots.business_need);
  const origin = directType
    ? "direct_request"
    : proactiveType
      ? "proactive_recommendation"
      : (ORIGINS.has(samePrevious?.origin) ? samePrevious.origin : "unclassified");
  const proactiveAllowed = origin !== "proactive_recommendation"
    || (definition.upsize && businessNeed && Boolean(role));
  // handoffAnyOf ว่าง = ไม่ได้ตั้งไว้ = พฤติกรรมเดิมทุกประการ
  // ตั้งไว้ = ต้องได้อย่างน้อยหนึ่งช่อง ไม่งั้นส่งต่อไปก็ไม่มีอะไรให้ทีมทำต่อ
  const anyOfSatisfied = definition.handoffAnyOf.length === 0
    || definition.handoffAnyOf.some((slot) => Boolean(normalizedSlots[slot]));
  const handoffReady = missingHandoffSlots.length === 0 && anyOfSatisfied && proactiveAllowed;
  const upsizeEligible = definition.upsize && origin === "proactive_recommendation"
    && businessNeed && Boolean(role);
  const courseId = typeof candidate.course_id === "string" && policy.courses.some((course) => course.id === candidate.course_id)
    ? candidate.course_id
    : (policy.courses.some((course) => course.id === samePrevious?.courseId) ? samePrevious.courseId : null);

  return Object.freeze({
    enabled: true,
    customerJourney,
    learningVerification,
    reportedCourseId,
    decisionRole: role,
    decisionRoleSource: roleEvidence?.source || null,
    decisionRoleEvidence: roleEvidence?.evidence || null,
    opportunity: Object.freeze({
      type: definition.type,
      courseId,
      origin,
      slots: Object.freeze(normalizedSlots),
      missingSlots: Object.freeze(missingSlots),
      handoffReady,
      upsizeEligible,
      proactiveAllowed,
      handoffOnComplete: definition.handoffOnComplete,
    }),
  });
}

// Business-prompt context only.  It asks the scorer to return evidence; the
// normalizer above remains the final authority for eligibility.
// v1.3.5 (ตรวจ prompt จริง): ก้อนนี้ ~2,800 ตัวอักษรถูกฉีดเข้า "reply prompt" ทุกเทิร์น
// ทั้งที่เกินครึ่งเป็นคำสั่งให้ scorer คืนฟิลด์ JSON ("Return customer_journey...") ซึ่งโมเดล
// ตอบแชททำตามไม่ได้เลย = กฎตายก้อนใหญ่ที่เบียดกฎจริง — แยกเป็นสองเวอร์ชัน:
// reply ได้เฉพาะสรุปธุรกิจสั้น ๆ / scorer ได้ฉบับเต็มเหมือนเดิม
export function renderSalesPolicyReplySummary(policy) {
  if (!policy) return "";
  const courses = policy.courses.map((course) =>
    `- ${course.name} (${course.aliases.slice(0, 3).join(", ")})${course.progressesTo ? ` — ต่อยอดไป ${course.progressesTo}` : ""}`
  );
  return [
    "คอร์สที่ธุรกิจนี้มีจริง (ห้ามเสนอคอร์สนอกรายการ):",
    ...courses,
    "- การส่งต่อทีมงาน: ห้ามสัญญาเวลาติดต่อกลับ ราคา หรือวันเวลานอกแหล่งข้อมูลที่อนุมัติ",
    // คำสั่งพี่ง้วง 2026-08-14: งาน project (Private/In-house/วิทยากร) ทีมงานคนจริงรับช่วงเอง
    // — บอทมีหน้าที่เก็บข้อมูลให้ครบอย่างเป็นธรรมชาติ แล้วปิดอย่างอบอุ่น ไม่ใช่ขายต่อเอง
    "- งานออกแบบเฉพาะราย (Private/In-house/วิทยากร): เก็บข้อมูลอย่างเป็นธรรมชาติ ทีละคำถาม " +
    "แทรกไปกับการคุยปกติ เมื่อได้ครบแล้วบอกลูกค้าอย่างอบอุ่นว่าทีมงานผู้ดูแลโดยตรง" +
    "จะติดต่อกลับตามเบอร์และช่วงเวลาที่สะดวก — ห้ามพูดถึงระบบภายในหรือขั้นตอนส่งต่อ",
    // v1.4.32 (พี่ง้วงกำหนด 2026-08-19): "เอาแค่ 3 อย่างพอ ชมพู่เก็บต่อเอง"
    // เหตุจริง: ลูกค้าให้ชื่อบริษัท หัวข้อ เบอร์ และเวลาสะดวกครบแล้ว บอทยังขอจำนวนคน
    // กับ Google Map ต่อ (ทั้งที่บอกจำนวนไปแล้ว) จนจบบทสนทนายังไม่มีใครในทีมได้เรื่อง
    // ลีดองค์กรที่ให้เบอร์แล้วคือคนที่ตัดสินใจจะคุยแล้ว ถามต่ออีกคือเสี่ยงให้เปลี่ยนใจฟรี ๆ
    "- ครบ 3 อย่างนี้เมื่อไหร่ให้หยุดถามเพิ่มทันที: ชื่อบริษัทหรือชื่อผู้ติดต่อ / เบอร์โทร / " +
    "ช่วงเวลาที่สะดวกให้ติดต่อกลับ — รายละเอียดที่เหลือ (จำนวนผู้เรียน สถานที่ งบ วันที่) " +
    "ทีมงานเก็บเองตอนโทร ห้ามถามซ้ำสิ่งที่ลูกค้าบอกไปแล้วเด็ดขาด",
  ].join("\n");
}

export function renderSalesPolicyPrompt(policy) {
  if (!policy) return "";
  const courses = policy.courses.map((course) =>
    `- ${course.id}: ${course.name} (type=${course.type}; aliases=${course.aliases.join(", ")}; progresses_to=${course.progressesTo || "none"})`
  );
  const opportunities = policy.opportunities.map((opportunity) =>
    `- ${opportunity.type}: required_slots=${opportunity.requiredSlots.join(",")}; optional_slots=${opportunity.optionalSlots.join(",") || "none"}; upsize=${opportunity.upsize}; handoff_on_complete=${opportunity.handoffOnComplete}`
  );
  return [
    "Opportunity policy (business-approved; do not invent beyond it):",
    `business_id=${policy.businessId}`,
    "courses:", ...courses,
    "opportunities:", ...opportunities,
    `allowed_customer_journeys=${policy.customerJourneys.join(",")}`,
    `allowed_decision_roles=${policy.decisionRoles.join(",")}`,
    policy.routingPrior
      ? `internal_routing_prior=${policy.routingPrior.dominantInterest}:${policy.routingPrior.share}; never state this share to a customer; explicit customer wording always wins`
      : "",
    "Return customer_journey only from allowed_customer_journeys or unknown, together with customer_journey_evidence. returning_student/progression_candidate require type=verified_enrollment or verified_course_order, confidence=high, a configured course_id and evidence. new_lead requires type=no_verified_learning_record, confidence=high and evidence. Self-reported history remains unknown.",
    "Return decision_role only when the customer explicitly states the role and include explicit=true, confidence=high and a short evidence quote; otherwise null.",
    "Return opportunity only from opportunities above and include origin=direct_request when the customer asks for it, or origin=proactive_recommendation when the system is considering an upsize. Collect only its listed slots. Each slot must be {value, evidence}, where evidence is an exact short quote from a CUSTOMER turn; without an exact customer quote, omit the slot. Never infer course history, job authority, price, date, availability, or consent.",
    "For a proactive_recommendation with upsize=true, require an explicit decision role and business_need before mentioning the opportunity or asking its qualification slots. A direct_request may be qualified without a decision role.",
    "When all required slots of handoff_on_complete=true are present, use a seamless team handoff; never promise contact timing, quote, schedule, availability, or send anything.",
  ].filter(Boolean).join("\n");
}

// v1.3.6: ข้อความ ping ทีมงานเมื่อ opportunity ครบ slot — ต้องอ่านแล้วโทรกลับได้ทันที
// ค่าใน slots คือคำพูดจริงของลูกค้า (normalizer เก็บ quote ไม่ใช่คำสรุปของโมเดล)
const HANDOFF_TYPE_LABEL = Object.freeze({
  private_class: "Private Class",
  in_house_training: "In-house Training",
  speaker_engagement: "งานวิทยากร",
});
const HANDOFF_SLOT_LABEL = Object.freeze([
  // v1.4.36: ช่องนี้รับ "ชื่อบริษัทหรือชื่อผู้ติดต่อ" อย่างใดอย่างหนึ่ง ป้ายจึงต้องบอกทั้งสอง
  // ไม่งั้นชมพู่เห็น "บริษัท: ผมชื่อโต้ง" แล้วนึกว่าระบบเก็บผิดช่อง
  ["company_name", "บริษัท/ผู้ติดต่อ"],
  ["business_need", "โจทย์ธุรกิจ"],
  ["goal", "เป้าหมาย"],
  ["learner_context", "ผู้เรียน"],
  ["audience_context", "ผู้ฟัง/ทีม"],
  ["participant_count", "จำนวนคน"],
  ["format_location", "รูปแบบ/สถานที่"],
  ["rough_timeframe", "ช่วงเวลาที่อยากจัด"],
  ["contact_phone", "เบอร์ติดต่อกลับ"],
  ["preferred_contact_time", "เวลาที่สะดวก"],
]);

// v1.5.x (บั๊กจริง 3 ก.ย. 2026): บรรทัดแรกเดิมเขียนว่า "ให้ข้อมูลครบแล้ว — รอทีมงานโทรกลับ"
// ทุกครั้งไม่มีเงื่อนไข ตั้งแต่กติกา 1 ก.ย. ที่ส่งต่อได้ตั้งแต่ได้ชื่อบริษัทช่องเดียว
// ข้อความนั้นจึงโกหกทีมงานเป็นปกติ: บอกว่าครบและให้โทรกลับ ทั้งที่ไม่มีเบอร์สักตัวในสรุป
// ping ต้องตอบสองคำถามแรกของคนอ่านให้ได้ในบรรทัดเดียว — ลีดอะไร และ "ตามตัวได้ไหม"
// แล้วประกาศช่องที่ยังไม่มีตรง ๆ (เงียบไว้ = คนอ่านเดาเอาเองว่ามีครบ)
const HANDOFF_MISSING_LABEL = Object.freeze([
  ["contact_phone", "เบอร์ติดต่อ"],
  ["preferred_contact_time", "เวลาที่สะดวก"],
  ["company_name", "ชื่อบริษัท/ผู้ติดต่อ"],
]);

export function renderHandoffPing(opportunity) {
  const type = HANDOFF_TYPE_LABEL[opportunity?.type] || String(opportunity?.type || "งาน project");
  const slots = opportunity?.slots || {};
  const knownOrder = new Set(HANDOFF_SLOT_LABEL.map(([slot]) => slot));
  const entry = (slot, label) =>
    `• ${label}: ${String(slots[slot]).replace(/\s+/gu, " ").trim().slice(0, 100)}`;
  const lines = [
    ...HANDOFF_SLOT_LABEL.filter(([slot]) => slots[slot]).map(([slot, label]) => entry(slot, label)),
    // slot นอกรายการ label (policy ต่อ instance ตั้งเองได้) ต้องไม่หายจากสรุป
    ...Object.keys(slots).filter((slot) => !knownOrder.has(slot)).map((slot) => entry(slot, slot)),
  ];
  // "ตามตัวได้" = มีเบอร์เท่านั้น — ห้องแชท LINE เปิดอยู่เสมออยู่แล้ว จึงไม่นับเป็นช่องทางใหม่
  const reachable = Boolean(slots.contact_phone);
  // ผู้ตรวจ 3 ก.ย.: "เวลาที่สะดวก" ไม่ใช่ช่องทางติดต่อ — บรรทัดสรุปจะมี
  // "• เวลาที่สะดวก: บ่ายวันพุธ" อยู่ ทีมงานที่กวาดตาผ่านอาจอ่านเป็น "นัดโทรแล้ว"
  // ทั้งที่ไม่มีเบอร์ให้โทรสักตัว หัวเรื่องจึงต้องพูดออกมาตรง ๆ ว่ารู้แค่เวลา
  const timeOnly = !reachable && Boolean(slots.preferred_contact_time);
  const missing = HANDOFF_MISSING_LABEL.filter(([slot]) => !slots[slot]).map(([, label]) => label);
  return [
    reachable
      ? `ลีด ${type} — มีเบอร์แล้ว โทรกลับได้เลย`
      : timeOnly
        ? `ลีด ${type} — รู้แค่เวลาที่สะดวก ยังไม่มีเบอร์ ต้องทักกลับในห้องแชท`
        : `ลีด ${type} — ยังไม่มีเบอร์ ต้องทักกลับในห้องแชท`,
    ...lines,
    missing.length ? `ยังไม่มี: ${missing.join(" · ")}` : "",
    // ลิงก์เข้าห้องแชทถูกต่อท้ายโดย notify.mjs อยู่แล้ว — ตรงนี้จึงชี้ทางอย่างเดียว ห้ามใส่ลิงก์ซ้ำ
    reachable
      ? "AI หยุดตอบลูกค้าคนนี้แล้ว รอทีมงานรับช่วงต่อ"
      : "AI หยุดตอบลูกค้าคนนี้แล้ว — เปิดห้องแชทเพื่อคุยต่อและขอข้อมูลที่เหลือ",
  ].filter(Boolean).join("\n");
}

// v1.5.x: เบอร์ที่ลูกค้าพิมพ์มา "หลัง" ส่งต่อไปแล้ว (AI ปิด scorer ไม่รันอีก) ต้องถึงทีมงาน
// ใช้ตัวสกัด+ตัวตรวจหลักฐานชุดเดียวกับ slot contact_phone ห้ามมี regex เบอร์ตัวที่สองในระบบ
export function extractContactPhoneQuote(customerText) {
  const quote = extractSlotQuote("contact_phone", customerText);
  return quote && slotEvidenceValid("contact_phone", quote, quote, null) ? quote : "";
}

export function renderSalesState(state) {
  if (!state?.enabled) return "";
  if (!state.opportunity) {
    return `latest_verified_customer_journey=${state.customerJourney}; self_reported_course=${state.reportedCourseId || "none"} (not verified); no active opportunity`;
  }
  const { opportunity } = state;
  return [
    `latest_verified_customer_journey=${state.customerJourney}`,
    `latest_explicit_decision_role=${state.decisionRole || "none"}`,
    `self_reported_course=${state.reportedCourseId || "none"} (not verified)`,
    `latest_opportunity=${opportunity.type}`,
    `opportunity_origin=${opportunity.origin}`,
    `proactive_allowed=${opportunity.proactiveAllowed}`,
    `known_slots=${Object.keys(opportunity.slots).join(",") || "none"}`,
    `missing_slots=${opportunity.missingSlots.join(",") || "none"}`,
    opportunity.origin === "proactive_recommendation" && !opportunity.proactiveAllowed
      ? "Do not mention this proactive opportunity and do not ask its slots. Continue the customer's chosen path."
      : "Ask at most one missing qualification slot in this turn. Do not re-ask a known slot.",
  ].join("\n");
}
