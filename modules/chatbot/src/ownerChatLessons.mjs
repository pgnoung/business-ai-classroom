// ownerChatLessons.mjs — "สอนลูกแพร" ผ่านแชท Telegram (28 ก.ย. 2026)
//
// พี่ง้วงพิมพ์ "ต่อไปถ้าลูกค้าถามเรื่อง… ให้ตอบ…" → ลูกแพรตอบรับ แล้วเสนอบทเรียนเป็นบล็อก [[บทเรียน]]
// ท้ายคำตอบ → ระบบดึงบล็อกออก (พี่ง้วงไม่เห็นบล็อกดิบ) → โชว์บทเรียนพร้อมปุ่มยืนยัน → กดแล้วจึงบันทึก
// ผ่านด่านชุดเดียวกับคอนโซล (ownerLessonStore.mjs: ความยาว ความเป็นส่วนตัว กันซ้ำ เพดาน audit)
//
// ทำไมต้องมีด่านเพิ่มก่อนเชื่อบล็อกของโมเดล: บทเรียนเปลี่ยนวิธีพูดกับลูกค้าทุกคนทันที —
//   · บล็อกนับเฉพาะเมื่อข้อความนี้ของพี่ง้วงมีท่าทีสอนจริง (TEACHING_CUE) หรือเป็นคำตอบรับสั้น ๆ ("ได้เลย")
//     ต่อจากข้อความก่อนหน้าที่สอนอยู่ — โมเดลที่เสนอบทเรียนเองกลางคุยเล่นจึงไม่มีปุ่มโผล่มากวน
//   · บัญชีคอนโซลที่จับคู่ Telegram ไว้ต้องยังมีสิทธิ์สอน (lessons.teach) ถึงจะบันทึกได้ และจะ "ใช้ทันที"
//     ก็ต่อเมื่อยังมีสิทธิ์อนุมัติ (lessons.approve = เจ้าของ) ไม่งั้นเข้าคิวรออนุมัติเหมือนทีมงานสอนจากคอนโซล
//   · ไม่มีอะไรถูกเขียนจนกว่าพี่ง้วงกดยืนยัน (ปุ่มใช้ครั้งเดียว หมดอายุ 10 นาที — แบบเดียวกับคำสั่ง yolo)
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { OWNER_LESSON_LIMITS as LIMITS, cleanLessonText, oneLine } from "./ownerLessons.mjs";
import { createOwnerLessonWriter } from "./ownerLessonStore.mjs";

const TEACH = "lessons.teach";
const APPROVE = "lessons.approve";
export const TEACHING_CUE = /ต่อไป|จำไว้|จดไว้|บันทึก|บทเรียน|สอน|ครั้งหน้า|คราวหน้า|ถ้าลูกค้า|เวลาลูกค้า|ลูกค้าถาม|ให้ตอบ|ตอบว่า|อย่าตอบ|ห้ามตอบ|อย่าบอก|ห้ามบอก|อย่าพูด|ห้ามพูด|ให้บอก|ควรตอบ|ต้องตอบ|ทุกครั้ง|remember|lesson/iu;
// ตอบรับสั้น ๆ หลังลูกแพรถามว่า "บันทึกเป็นบทเรียนไหมคะ" — ยาวกว่านี้ถือเป็นเรื่องใหม่
const AFFIRM = /^(?:ได้|โอเค|ok|okay|ใช่|เอา|จัด|ตกลง|yes|ครับ|ค่ะ|จ้า)/iu;
const AFFIRM_MAX_CHARS = 25;
const BLOCK = /\[\[\s*(?:บทเรียน|lesson)\s*\]\]([\s\S]*?)(?:\[\[\s*\/\s*(?:บทเรียน|lesson)\s*\]\]|$)/giu;
const STRAY_MARK = /\[\[\s*\/?\s*(?:บทเรียน|lesson)\s*\]\]/giu;

/**
 * แยกบล็อกบทเรียนออกจากคำตอบ — คำตอบที่คืนไม่มีบล็อกเสมอ (แม้บล็อกจะใช้ไม่ได้)
 * @returns {{text: string, lesson: {topic: string, teaching: string}|null}}
 */
export function extractLessonProposal(reply, { ownerText = "", previousOwnerText = "" } = {}) {
  const bodies = [];
  const text = String(reply ?? "").replace(BLOCK, (_, body) => { bodies.push(body); return ""; })
    .replace(STRAY_MARK, "").replace(/\n{3,}/gu, "\n\n").trim();
  const current = String(ownerText || "").trim();
  const taught = TEACHING_CUE.test(current)
    || (AFFIRM.test(current) && [...current].length <= AFFIRM_MAX_CHARS && TEACHING_CUE.test(String(previousOwnerText || "")));
  if (!bodies.length || !taught) return { text, lesson: null };
  const body = bodies[0];
  const topic = oneLine(/หัวข้อ\s*[:：]\s*(.+)/u.exec(body)?.[1] || "", LIMITS.topic);
  const teaching = cleanLessonText(/สอน\s*[:：]\s*([\s\S]+)/u.exec(body)?.[1] || "", LIMITS.teaching + 1);
  return { text, lesson: teaching ? { topic, teaching } : null };
}

export function createOwnerChatLessons({ config = {}, db, notifier = null, logger = console }) {
  const writer = createOwnerLessonWriter({ db, config, notifier, logger });

  // บัญชีคอนโซลที่ออกรหัสจับคู่ (เจ้าของ) — ต้องยังอยู่และไม่ถูกปิด ถึงจะสอนในนามบัญชีนั้นได้
  function operatorFor(owner) {
    const username = String(owner?.pairedBy || "").trim();
    if (!username) return null;
    let operator = null;
    try { operator = db.getOperator(username); } catch { operator = null; }
    return operator && Number(operator.disabled || 0) !== 1 ? operator : null;
  }

  return {
    // จอสอนปิด = ไม่มีทางสอนเลย (กติกาเดียวกับเส้นคอนโซลที่เป็น 404)
    enabled: () => config.teachEnabled === true,

    /** ตรวจก่อนโชว์ปุ่ม — คืน { ok, lesson } หรือ { ok:false, error } (ไม่เขียนอะไร) */
    prepare(proposal, { owner, customerNames = [] } = {}) {
      const operator = operatorFor(owner);
      if (!operator || !hasOperatorCapability(operator, TEACH)) {
        return { ok: false, error: "บัญชีคอนโซลที่จับคู่ Telegram ไว้ใช้สอนลูกแพรไม่ได้แล้ว — จับคู่ใหม่จากบัญชีเจ้าของในคอนโซลนะคะ" };
      }
      const lesson = { topic: String(proposal?.topic || ""), teaching: String(proposal?.teaching || ""), customerNames };
      const checked = writer.check({ teaching: lesson.teaching, topic: lesson.topic, scope: null, customerNames });
      if (!checked.ok) return { ok: false, error: checked.error };
      if (checked.duplicateOf?.status === "active") return { ok: false, error: "มีบทเรียนนี้อยู่แล้ว — ลูกแพรใช้อยู่แล้วค่ะ" };
      return { ok: true, lesson };
    },

    /** บันทึกหลังพี่ง้วงกดยืนยัน — ด่านเดียวกับคอนโซลทุกข้อ (ตรวจซ้ำเพราะผ่านไปได้ถึง 10 นาที) */
    save(lesson, { owner } = {}) {
      const operator = operatorFor(owner);
      if (!operator || !hasOperatorCapability(operator, TEACH)) {
        return { ok: false, error: "บัญชีคอนโซลที่จับคู่ Telegram ไว้ใช้สอนลูกแพรไม่ได้แล้ว — จับคู่ใหม่จากบัญชีเจ้าของในคอนโซลนะคะ" };
      }
      const username = String(operator.username);
      return writer.save({
        teaching: lesson?.teaching, topic: lesson?.topic || "", scope: null, username, auditAs: `telegram:${username}`,
        canApprove: hasOperatorCapability(operator, APPROVE), customerNames: lesson?.customerNames || [],
      });
    },
  };
}
