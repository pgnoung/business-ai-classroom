// Decides whether the already-approved course outline should be put in this reply.
// It deliberately returns instructions only: provider acceptance remains the send boundary.

const BUSINESS = /(?:ai\s*agent\s*(?:for\s*)?business|agent\s*for\s*business|คลาสพื้นฐาน)/iu;
const WORKFLOW = /(?:ai\s*agent\s*workflow\s*automation|workflow\s*automation|คลาสต่อยอด)/iu;
const OUTLINE_TOPIC = /(?:outline|โครง(?:ร่าง)?(?:เนื้อหา)?|หัวข้อ(?:ที่)?สอน|เนื้อหา(?:คอร์ส|คลาส|การเรียน)?)/iu;
const OUTLINE_ASK = /(?:(?:ขอ|อยาก(?:ดู|ทราบ)|ส่ง(?:ให้)?|ดู(?:ให้)?|มี)\s*.{0,30}(?:outline|โครง(?:ร่าง)?(?:เนื้อหา)?|หัวข้อ(?:ที่)?สอน|เนื้อหา(?:คอร์ส|คลาส|การเรียน)?)|(?:outline|โครง(?:ร่าง)?(?:เนื้อหา)?|หัวข้อ(?:ที่)?สอน|เนื้อหา(?:คอร์ส|คลาส|การเรียน)?).{0,20}(?:มีไหม|ได้ไหม|ได้มั้ย|ไหม|มั้ย|หน่อย))/iu;
const INTEREST = /(?:สนใจ|อยาก(?:เรียน|ดู|ทราบ|รู้)|ขอ(?:รายละเอียด|ข้อมูล|outline|โครง)|เรียน(?:อะไร|ยังไง|ได้ไหม)|สอน(?:อะไร|ยังไง)|เหมาะ(?:กับ|ไหม)|ต่างกัน|เทียบ)/iu;
const PAUSE_OR_HANDOFF = /(?:ไม่ต้อง(?:ส่ง|ถาม)|ไม่เอา|หยุด(?:ส่ง|ถาม)?|ขอพัก|ไว้ก่อน|ไม่สนใจ(?:แล้ว)?|ขอ(?:คุย|ให้).*(?:ทีมงาน|คน)|ติดต่อทีมงาน|โอนแล้ว|ส่งสลิป|จองเลย|สมัครเลย)/iu;
const CANONICAL_CARD = /outline\s*ทางการทั้งสองคลาส/iu;
const BUSINESS_HEADING = /outline\s*ai\s*agent\s*for\s*business/iu;
const WORKFLOW_HEADING = /outline\s*ai\s*agent\s*workflow\s*automation/iu;
const OUTLINE_SUBSTANCE = /(?:หัวข้อที่สอน|เนื้อหา(?:การ)?สอน|บทเรียน|module)/iu;
const RESEND = /(?:อีก(?:ครั้ง|รอบ)?|ซ้ำ|ส่ง.{0,40}ใหม่)/iu;
const LOGISTICS_OR_THANKS = /(?:ที่จอด|จอดรถ|เดินทาง|สถานที่|อยู่ที่ไหน|วันไหน|กี่โมง|ใบเสร็จ|ใบกำกับ|เลื่อนรอบ|^\s*(?:ขอบคุณ|thank))/iu;
const LEARNING_GOAL = /(?:อยาก(?:ใช้|เรียน|ทำ)|ช่วยงาน|ทำงาน|เรียน(?:อะไร|ยังไง)|สอน(?:อะไร|ยังไง)|เนื้อหา(?:คอร์ส|คลาส|การเรียน)?|หัวข้อ(?:ที่)?สอน)/iu;
const BRIEF_ACK = /^\s*(?:ครับ|ค่ะ|คะ|ครับผม|ได้(?:เลย)?|โอเค|รบกวนด้วย)\s*[!.]*\s*$/iu;
const PERMISSION_OFFER = /(?:อยากดู|ต้องการดู|สนใจดู|ดู.*(?:ไหม|มั้ย)|outline.*(?:ไหม|มั้ย))/iu;

function courseMention(text = "") {
  const value = String(text);
  const business = BUSINESS.test(value);
  const workflow = WORKFLOW.test(value);
  if (business && workflow) return "both";
  if (business) return "agent_business";
  if (workflow) return "agent_workflow_automation";
  return null;
}

function requiredHeadings(course) {
  if (course === "agent_business") return [BUSINESS_HEADING];
  if (course === "agent_workflow_automation") return [WORKFLOW_HEADING];
  if (course === "both") return [BUSINESS_HEADING, WORKFLOW_HEADING];
  return [];
}

function outlineSectionHasSubstance(value, heading) {
  const start = value.search(heading);
  if (start < 0) return false;
  const boundaries = [BUSINESS_HEADING, WORKFLOW_HEADING]
    .map(pattern => value.search(pattern))
    .filter(index => index > start);
  const separator = value.indexOf("========", start + 1);
  if (separator > start) boundaries.push(separator);
  const end = boundaries.length ? Math.min(...boundaries) : value.length;
  return OUTLINE_SUBSTANCE.test(value.slice(start, end));
}

function hasApprovedOutline(knowledge, course) {
  const value = String(knowledge || "");
  return CANONICAL_CARD.test(value) && requiredHeadings(course)
    .every(heading => heading.test(value) && outlineSectionHasSubstance(value, heading));
}

function wasActuallyDelivered(history, course) {
  const headings = requiredHeadings(course);
  return headings.length > 0 && headings.every(heading => (Array.isArray(history) ? history : []).some(turn =>
    turn?.role === "assistant" && heading.test(String(turn.content || ""))
      && OUTLINE_SUBSTANCE.test(String(turn.content || "")) && !PERMISSION_OFFER.test(String(turn.content || ""))));
}

// This is shared by the database lifetime lookup. It deliberately uses the
// same strict heading-and-substance rule as the short reply history, so an
// offer such as "อยากดู Outline ไหม" never becomes a delivery marker.
export function detectDeliveredCourseOutlines(history = []) {
  const delivered = new Set();
  for (const course of ["agent_business", "agent_workflow_automation"]) {
    if (wasActuallyDelivered(history, course)) delivered.add(course);
  }
  return delivered;
}

function recentCustomerCourse(history) {
  const customerTurns = (Array.isArray(history) ? history : [])
    .filter(turn => turn?.role === "user")
    .slice(-6)
    .reverse();
  for (const turn of customerTurns) {
    const value = String(turn.content || "");
    const course = courseMention(value);
    if (course && INTEREST.test(value)) return course;
  }
  return null;
}

function rulesFor(course, explicit) {
  const label = course === "agent_business" ? "AI Agent for Business"
    : course === "agent_workflow_automation" ? "AI Agent Workflow Automation"
      : "ทั้ง AI Agent for Business และ AI Agent Workflow Automation";
  return [
    `ส่ง Outline ที่อนุมัติของ ${label} จากความรู้ที่ให้ไว้ทันที`,
    "ใช้เฉพาะข้อความจากหัวข้อ Outline ทางการทั้งสองคลาส; ห้ามแต่งหัวข้อหรือข้อเท็จจริงเพิ่ม",
    "ห้ามถามว่าลูกค้าอยากดู Outline หรือไม่ และห้ามบังคับให้มีคำถามปิดท้าย",
    "ห้ามอ้างว่ามีไฟล์แนบหรือลิงก์ และห้ามบอกว่าส่งแล้วก่อนผู้ให้บริการรับข้อความสำเร็จ",
    "ถ้าจะเสริมรีวิว ให้เลือกรีวิวที่เกี่ยวข้องและยังไม่เคยส่งได้ไม่เกินหนึ่งรายการ",
    explicit ? "นี่เป็นการตอบคำขอ Outline โดยตรง" : "นี่เป็นการช่วยส่งรายละเอียดตามความสนใจล่าสุดของลูกค้า",
  ].join("\n");
}

function alreadyDeliveredRules(course) {
  const label = course === "agent_business" ? "AI Agent for Business"
    : course === "agent_workflow_automation" ? "AI Agent Workflow Automation"
      : "ทั้งสองคลาส";
  return `เคยส่ง Outline ${label} ให้ลูกค้าแล้ว ไม่ส่งซ้ำหากลูกค้าไม่ได้ขอให้ส่งใหม่ ตอบคำถามล่าสุดของลูกค้าตามบริบทแทน`;
}

function isImmediateOutlineOffer(history) {
  const turns = Array.isArray(history) ? history : [];
  const latest = turns.at(-1);
  return latest?.role === "assistant" && OUTLINE_TOPIC.test(String(latest.content || ""))
    && PERMISSION_OFFER.test(String(latest.content || ""));
}

function isCurrentOutlineMoment({ text, course, history }) {
  if (LOGISTICS_OR_THANKS.test(text)) return false;
  if (courseMention(text) && (INTEREST.test(text) || OUTLINE_TOPIC.test(text))) return true;
  if (LEARNING_GOAL.test(text)) return true;
  return BRIEF_ACK.test(text) && isImmediateOutlineOffer(history);
}

/**
 * @returns {{course: "agent_business"|"agent_workflow_automation"|"both"|null, deliver: boolean, explicit: boolean, reason: string, rules: string}}
 */
export function planCourseOutline({ text = "", history = [], score = null, knowledge = "", closingTurn = false,
  careMode = null, presetButton = null, sentCourses = new Set() } = {}) {
  const value = String(text || "");
  const explicit = OUTLINE_ASK.test(value);
  const currentCourse = courseMention(value);
  const historicalCourse = recentCustomerCourse(history);
  // "ทั้งสองคลาส" is only meaningful for this asset when the customer is actually
  // asking for an outline. It must not turn a generic sales sentence into a course choice.
  const requestedBoth = explicit && /(?:ทั้งสอง|สอง)\s*(?:คลาส|คอร์ส)/u.test(value);
  const course = requestedBoth ? "both" : currentCourse || historicalCourse;
  const none = reason => ({ course, deliver: false, explicit, reason, rules: "" });

  if (closingTurn || careMode || PAUSE_OR_HANDOFF.test(value)) return none("care_or_handoff");
  if (!course) return none("course_ambiguous");
  if (!hasApprovedOutline(knowledge, course)) return none("approved_outline_unavailable");
  const historicalDeliveries = detectDeliveredCourseOutlines(history);
  const lifetimeDeliveries = sentCourses instanceof Set ? sentCourses : new Set(sentCourses || []);
  const delivered = course === "both"
    ? (historicalDeliveries.has("agent_business") && historicalDeliveries.has("agent_workflow_automation"))
      || lifetimeDeliveries.has("both")
      || (lifetimeDeliveries.has("agent_business") && lifetimeDeliveries.has("agent_workflow_automation"))
    : historicalDeliveries.has(course) || lifetimeDeliveries.has(course);
  if (delivered && !(explicit && RESEND.test(value))) {
    return { course, deliver: false, explicit, reason: "outline_already_delivered", rules: alreadyDeliveredRules(course) };
  }
  if (explicit) return { course, deliver: true, explicit: true, reason: "explicit_outline_request", rules: rulesFor(course, true) };
  if (presetButton?.buttonsOnlySoFar) return none("preset_opening");
  if (!Number.isFinite(score) || score < 5) return none("interest_score_not_warm");
  if (!historicalCourse && !INTEREST.test(value)) return none("no_customer_course_interest");
  if (!isCurrentOutlineMoment({ text: value, course, history })) return none("current_turn_not_outline_moment");
  return { course, deliver: true, explicit: false, reason: "warm_current_or_recent_course_interest", rules: rulesFor(course, false) };
}
