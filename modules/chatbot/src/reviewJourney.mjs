// Evidence serves the current conversation, not a score-triggered campaign.
import { learningGoal, resolveReplyFocus } from "./conversationFocus.mjs";
import { SYSTEM_SHOWCASE_LABEL, capabilityAsk, isSystemShowcase, showcaseWordingRule } from "./showcaseCases.mjs";

const EVIDENCE = /รีวิว|ตัวอย่าง|ผลงาน|บรรยากาศ|คลิป|วิดีโอ|วิดิโอ|สำนักข่าว|รู้จักพี่ง้วง/u;
const ASK = /ขอ|อยาก|ดู|มี|ส่ง|แนะนำ|เพิ่ม|อีก|ไหน|ไหม|หน่อย/u;
const COMPARE = /เทียบ|เปรียบเทียบ|ต่างกัน|สองแบบ|ทั้งสอง/u;
const MULTIPLE = /หลาย|เพิ่ม|อีก|สอง|ทั้งสอง|[2๒]\s*(?:คลิป|อัน|ตัวอย่าง|รายการ)|รีวิว.*ตัวอย่าง|ตัวอย่าง.*รีวิว/u;
const TRUST = /สำนักข่าว|รู้จักพี่ง้วง|ใครสอน|ผู้สอน|น่าเชื่อถือ|ประวัติพี่ง้วง/u;
const SHOW = /ตัวอย่าง|ผลงาน|บรรยากาศ/u;
const DOUBT = /คุ้ม|กังวล|ลังเล|กลัว|ช่วยได้จริง|ใช้ได้จริง|ทำได้จริง|เหมาะกับ|เรียนไหว|ยากไหม|เห็นภาพ|ไม่เข้าใจ|ราคา|เนื้อหา|สอนอะไร|เรียนอะไร/u;
const FINISH = /ไม่ต้องส่ง|ไม่เอา.*(?:รีวิว|คลิป|ตัวอย่าง)|หยุดส่ง|ขอพัก|ไว้ก่อน|^ไม่สนใจ(?:แล้ว)?(?:ครับ|ค่ะ|คะ)?$|ขอทีมงาน|ติดต่อทีมงาน|คุยกับคน|โอนแล้ว|ส่งสลิป|เลขบัญชี|จองเลย|สมัครเลย/u;
const TOPIC = /ที่จอด|จอดรถ|เดินทาง|สถานที่|อยู่ที่ไหน|วันไหน|กี่โมง|ใบเสร็จ|ใบกำกับ|เลื่อนรอบ/u;
// 19 ต.ค. 2026: ลิงก์หน้ารีวิว/ตัวอย่างระบบบนเว็บ Academy ก็นับเป็นหลักฐานที่เพิ่งส่ง (เดิมนับแค่ลิงก์ Facebook — ส่งลิงก์เว็บแล้วไม่เว้นจังหวะฟัง)
const URL = /https:\/\/(?:(?:www\.|web\.)?facebook\.com\/(?:share|reel|watch|videos|posts)(?:\/|\?)|(?:www\.)?pngoungacademy\.com\/(?:reviews|showcase\/apps)\/[A-Za-z0-9_-])/u;
// คำสั่งพี่ง้วง 2026-10-04 (สวิตช์ natural_voice_mode): ลูกค้ายังไม่มั่นใจว่าเรียนได้/คุ้มไหม = ส่งรีวิวคนจริงก่อน
// แม้ยังไม่ได้เล่าโจทย์ ("อยากให้รีวิวคนจริงขึ้นก่อน บรรยากาศในคลาส") — รูปห้องเรียนจริงตามมาหลังเคยได้รีวิวแล้ว
// (ตัวเลือกรูป nurture ใน pipeline ใช้ตัวจับเดียวกันนี้)
// รอบ 2 (พี่ง้วงเลือกเอง): "ทดลองใช้แล้วแต่ยังไม่เก่ง" คือบอกระดับ ไม่ใช่ความกังวล — "ไม่เก่ง/ไม่เคยใช้" จึงไม่นับ
export const CONFIDENCE_TURN = /(?:มือใหม่|ไม่มีพื้นฐาน|ตาม(?:ไม่)?ทัน|ยาก(?:ไหม|มั้ย|ไป)|เรียน(?:ได้|ไหว)(?:ไหม|มั้ย)|จะ(?:ทำ|เรียน)ได้(?:ไหม|มั้ย)|เรียนคนเดียว|อายุเยอะ|ไม่ใช่สาย(?:ไอที|เทค|IT)|กังวล|ลังเล|กลัว|คุ้ม(?:ไหม|มั้ย|หรือเปล่า|รึเปล่า)|(?:ใช้|ทำ|ช่วย)ได้จริง)/iu;

export function reviewStage(score, presetButton) {
  if (presetButton?.buttonsOnlySoFar || !Number.isInteger(score)) return "cold";
  return score >= 8 ? "hot" : score >= 5 ? "warm" : "cold";
}

// A sent asset buys a listening turn; a real new request can still ask for more immediately.
function justSentEvidence(history) {
  let inbound = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const turn = history[i];
    if (turn?.role === "user") inbound += 1;
    if (turn?.role === "assistant" && URL.test(String(turn.content || ""))) return inbound < 1;
  }
  return false;
}

export function planReviewJourney({ text = "", history = [], score = null, presetButton = null,
  closingTurn = false, careMode = null, proactive = false, nurture = false } = {}) {
  const stage = reviewStage(score, presetButton);
  const none = reason => ({ stage, purpose: reason, kinds: [], maxItems: 0, explicit: false });
  if (closingTurn || careMode || FINISH.test(text)) return none("care_or_handoff");
  const explicit = EVIDENCE.test(text) && ASK.test(text);
  const profile = TRUST.test(text);
  const short = resolveReplyFocus({ text, history });
  if (short && !explicit) return none("listen_to_answer");
  if (TOPIC.test(text) && !explicit && !profile) return none("answer_logistics");
  // Exact ad buttons are entry points, never evidence of readiness or a request for a clip.
  if (presetButton?.buttonsOnlySoFar && !explicit) return none("ad_button_opening");
  const goal = learningGoal({ text, history });
  const comparing = COMPARE.test(text);
  const compareCourses = comparing && /business|พื้นฐาน/iu.test(text) && /workflow|automation|ต่อยอด/iu.test(text);
  const confidence = nurture && CONFIDENCE_TURN.test(text);
  const relevant = compareCourses || confidence || Boolean(goal) && (DOUBT.test(text) || comparing || goal.evidence === String(text).slice(0,240));
  // 19 ต.ค. 2026: "เรียนแล้วทำอะไรได้บ้าง / ใช้ได้จริงไหม / เอาไปใช้กับธุรกิจได้ไหม" = ตัวอย่างระบบที่ทำด้วย AI Agent
  // (ไม่ใช่ข้อความแรกของห้อง · กังวลเรื่องผลลัพธ์ยังเป็นรีวิวผู้เรียน · คลังไม่มีตัวอย่างระบบ = ไม่ส่งอะไรเพิ่มจากเดิม)
  const capability = !explicit && !profile && capabilityAsk(text) && history.some(t => t?.role === "assistant");
  if (!explicit && !profile && !relevant && !proactive && !capability) return none("no_current_need");
  if (!explicit && !profile && justSentEvidence(history) && !proactive) return none("listen_after_evidence");
  if (profile) return { stage, purpose: "trust_in_teacher", kinds: ["profile"], maxItems: 1, explicit: true };
  if (capability && !SHOW.test(text) && goal?.kind !== "content") {
    // เทิร์นที่เดิมเงียบ = ตัวอย่างระบบอย่างเดียว · เทิร์นที่เดิมได้รีวิว (มีโจทย์+ข้อสงสัย / ทักตาม) = ตัวอย่างระบบก่อน ไม่มีค่อยรีวิวเดิม
    return { stage, purpose: "show_what_it_builds", kinds: relevant || proactive ? ["showcase", "testimonial"] : ["showcase"],
      maxItems: 1, explicit: false, compareCourses: false, showcaseScope: "system" };
  }
  const visual = SHOW.test(text) || goal?.kind === "content";
  const mixed = explicit && /รีวิว/u.test(text) && SHOW.test(text);
  const kinds = mixed ? ["showcase", "testimonial"]
    : explicit && /รีวิว/u.test(text) ? ["testimonial"]
    : explicit && visual ? ["showcase"] : visual ? ["showcase", "testimonial"] : ["testimonial"];
  return {
    stage, purpose: comparing ? "compare_options" : visual ? "make_it_concrete" : confidence && !goal ? "build_confidence"
      : stage === "cold" ? "recognise_own_use_case" : stage === "hot" ? "resolve_final_doubt" : "evaluate_fit",
    kinds, maxItems: !proactive && ((explicit && (MULTIPLE.test(text) || comparing)) || compareCourses) ? 2 : 1, explicit,
    // A comparison must present both requested choices, not two random people from one class.
    compareCourses,
  };
}

export function reviewJourneyRules(plan, selected = []) {
  const labels = { testimonial: "รีวิวผู้เรียน", showcase: "ตัวอย่างงาน/บรรยากาศ", profile: "คลิปสื่อ/ประวัติผู้สอน" };
  const labelOf = r => isSystemShowcase(r) ? SYSTEM_SHOWCASE_LABEL : labels[r.kind] || labels.testimonial;
  if (!selected.length) return "เทิร์นนี้ไม่มีหลักฐานที่เลือกให้ส่ง ตอบคำถามลูกค้าต่อ ไม่เดาลิงก์ ไม่ย้ายไปคลาสอื่นเพราะคลิปหมด";
  return `จังหวะ: ${plan.stage} / ${plan.purpose}; จำนวนที่เลือก: ${selected.length} รายการ\n`
    + "คำตัดสินประเภทและจำนวนในส่วนนี้ใช้แทนคำแนะนำการแนบคลิปแบบเก่าในคำอธิบายคลัง แต่ห้ามเปลี่ยนข้อเท็จจริงของรายการ\n"
    + selected.map((r,i) => `รายการ ${i+1}: ${labelOf(r)}`).join("\n")
    + "\nใช้เฉพาะรายการที่เลือกด้านบน เกริ่นสั้นว่าช่วยให้เห็นภาพเรื่องใด ชื่อ บทบาท และลิงก์ตรงตามคลัง ลิงก์แต่ละอันอยู่บรรทัดแยก ส่งหลักฐานได้เลยโดยไม่ถามขออนุญาตซ้ำ เมื่อข้อมูลครบแล้วจบอย่างสุภาพได้ ไม่บังคับคำถามท้ายรีวิว ถามได้สูงสุดหนึ่งข้อเฉพาะข้อมูลที่ยังไม่รู้และจำเป็นต่อการช่วยเลือกต่อ"
    + "\nตัวอย่างงานทั่วไปใช้ประกอบภาพเท่านั้น ไม่ยืนยันว่าสอนทำชิ้นนั้นในคลาสที่ลูกค้าสนใจ ไม่เรียกตัวอย่างหรือคลิปสื่อว่ารีวิวผู้เรียน ไม่แต่งคำพูด ยอดขาย หรือผลลัพธ์ และไม่อ้างว่าเปิดดูคลิปแล้ว"
    + (selected.some(isSystemShowcase) ? `\n${SYSTEM_SHOWCASE_LABEL}: เล่าสั้น ๆ หนึ่งบรรทัดว่าระบบนี้ช่วยงานอะไร ${showcaseWordingRule()}` : "")
    + (plan.stage === "cold" ? "\nจังหวะทำความรู้จัก: ช่วยให้เห็นภาพ ไม่พ่วงชวนจองหรือโปรโมชั่นที่ลูกค้าไม่ได้ถาม ถ้าลูกค้าถามราคาให้ตอบตามคำตัดสินเรื่องราคาของเทิร์นนี้" : "\nหลักฐานช่วยตอบข้อสงสัย ไม่ทดแทนคำตอบที่ลูกค้าถามและไม่สร้างแรงกดดันให้จอง");
}
