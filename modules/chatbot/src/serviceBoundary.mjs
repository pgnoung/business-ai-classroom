// Sales advice is not an unlimited content-production service. No age, wealth,
// score or message-volume inference; only explicit, bounded task requests.
import { brandText } from "./brand.mjs";
const TOPICS = Object.freeze({
  song: { noun: "เพลง", sample: "ลองเริ่มจากธีม ‘เริ่มใหม่ในเช้าวันพรุ่งนี้’ แล้วเลือกอารมณ์และแนวเพลงที่ต้องการค่ะ" },
  story: { noun: "เรื่องหรือบทละคร", sample: "ตัวอย่างแนวเรื่องสั้น ๆ: คนสองคนต้องร่วมแก้ปัญหาเดียวกัน แต่มีเป้าหมายต่างกัน จึงต้องเรียนรู้ที่จะไว้ใจกันค่ะ" },
  content: { noun: "บทความหรือคอนเทนต์", sample: "ตัวอย่างโครงสั้น ๆ: เปิดด้วยปัญหาของผู้อ่าน ตามด้วยประโยชน์หนึ่งข้อ แล้วจบด้วยสิ่งที่นำไปลองได้ค่ะ" },
});

export function serviceBoundaryState(customer) {
  let raw;
  try { raw = JSON.parse(customer?.service_boundary_json || "{}"); } catch { raw = {}; }
  const used = Object.fromEntries(Object.keys(TOPICS).filter(k => raw?.used?.[k] === true).map(k => [k, true]));
  return { topic: Object.hasOwn(TOPICS, raw?.topic) ? raw.topic : "", paused: raw?.paused === true, used };
}

export function serviceFollowupPaused(customer) {
  return serviceBoundaryState(customer).paused;
}

function clauses(text) {
  return String(text || "").normalize("NFC").trim().split(/[\n!?。]|\s+(?:แต่|แล้ว|และ)\s+/u)
    .map(s => s.trim().replace(/^(?:สวัสดี(?:ครับ|ค่ะ|คะ)?\s*)?(?:ผม|ฉัน|ดิฉัน)?\s*/u, ""));
}

export function classifyServiceIntent(text, customer, { preset = false } = {}) {
  if (preset) return null;
  const value = String(text || "").trim();
  // A quoted scenario is evidence, not an instruction to perform that task.
  if (!value || /[“”"]|(?:ลูกค้า|เพื่อน|เขา)(?:บอก|ถาม|พูด)ว่า/u.test(value)) return null;
  const parts = clauses(value);
  const learning = parts.some(s => /^(?:(?:ขอ|ช่วย|รบกวน)\s*)?(?:สนใจ(?:เรียน|คลาส|คอร์ส)|อยากเรียน|ต้องการเรียน|ขอสมัคร|สมัครเรียน|ขอจองคลาส|ขอจองคอร์ส|(?:คลาส|คอร์ส).{0,45}(?:ราคา|เรียน|สอน|วันไหน|เหมาะ)|(?:ราคาคลาส|ราคาคอร์ส|ค่าเรียน).{0,20}(?:เท่าไหร่|กี่บาท)|มี(?:คลาส|คอร์ส)|เรียน(?:วันไหน|ที่ไหน|อะไร)|สอน(?:อะไร|เรื่องนี้ไหม))/u.test(s));
  if (learning) return { kind: "learning" };
  for (const s of parts) {
    const task = s.match(/^(?:(?:ช่วย|รบกวน|ขอให้|อยากให้|สอน(?:วิธี|การ)?|ขอ)\s*)*(?:แต่ง|เขียน|ทำ|สร้าง|แก้|ปรับ)\s*(?:เนื้อ)?(เพลง|นิยาย|ละคร|บทละคร|เรื่องสั้น|บทความ|คอนเทนต์|แคปชั่น|แคปชัน)/u);
    if (task) {
      // Capability/curriculum questions are sales advice, not production requests.
      if (/(?:ในคลาส|ในคอร์ส|สอนได้ไหม|เรียนได้ไหม|ทำได้ไหม|ได้หรือเปล่า)/u.test(s)
        || /^\s*(?:ได้ไหม|ได้มั้ย)/u.test(s.slice(task[0].length))) return null;
      return { kind: "work", topic: task[1] === "เพลง" ? "song" : /นิยาย|ละคร|เรื่องสั้น/u.test(task[1]) ? "story" : "content" };
    }
  }
  const state = serviceBoundaryState(customer);
  if (state.paused && state.topic && parts.some(s => /^(?:ขอ|ช่วย|รบกวน)?\s*(?:อีก(?:ตอน|เพลง|บท|แบบ)|ต่อ(?:อีก|เลย|ให้)|เขียนต่อ|แต่งต่อ|แก้(?:ให้|ใหม่)|ปรับ(?:ให้|ใหม่)|เพิ่ม(?:อีก|ให้)|เอา(?:อีก|แบบ))/u.test(s))) {
    return { kind: "work", topic: state.topic };
  }
  return null;
}

// Ingress only changes the reversible follow-up hold. A failed/abandoned draft
// never consumes the example. Explicit learning clears ONLY this feature's hold.
export function nextServiceState(customer, intent) {
  const state = serviceBoundaryState(customer);
  if (intent?.kind === "learning") return { ...state, paused: false };
  if (intent?.kind === "work") return { ...state, topic: intent.topic, paused: true };
  return state;
}

export function serviceBoundaryReply(intent, customer) {
  if (intent?.kind !== "work" || !Object.hasOwn(TOPICS, intent.topic)) return null;
  const state = serviceBoundaryState(customer);
  const topic = TOPICS[intent.topic];
  if (state.used[intent.topic]) return {
    topic: intent.topic,
    text: brandText(`ลูกแพรช่วยอธิบายแนวทางเบื้องต้นเพื่อประกอบการเลือกเรียนได้ค่ะ ส่วนการทำ${topic.noun}ฉบับเต็มหรือแก้ชิ้นงานต่อเนื่องอยู่นอกขอบเขตการให้ข้อมูลคลาสนะคะ หากสนใจเรียนทำด้วยตัวเอง ลูกแพรช่วยดูแนวทางเรียนที่เหมาะให้ได้ค่ะ`),
  };
  return {
    topic: intent.topic,
    text: brandText(`ลูกแพรยกตัวอย่างแนวทางสั้น ๆ ให้เห็นภาพนะคะ ${topic.sample}\n\nส่วนการทำชิ้นงานเต็มหรือแก้ต่อเนื่องอยู่นอกขอบเขตการให้ข้อมูลคลาสค่ะ อยากเรียนวิธีทำด้วยตัวเอง หรือกำลังมองหาบริการทำชิ้นงานให้คะ?`),
  };
}

export const SERVICE_SCOPE_RULE = "- บทบาทคือที่ปรึกษาเลือกเรียน ไม่ใช่บริการผลิตชิ้นงานหรือสอนเต็มหลักสูตรในแชท: ให้แนวทางสั้นได้ แต่ไม่เขียนงานฉบับเต็ม ไม่แก้งานวน ไม่รับจ้างแทนทีม และไม่เดาว่าลูกค้าหลอกถามหรือมีศักยภาพต่ำจากอายุ/การเกษียณ/ข้อจำกัดงบ ถ้าถามข้อมูลเรียนให้ตอบตรงคำถามตามความรู้ที่ยืนยันแล้ว";
