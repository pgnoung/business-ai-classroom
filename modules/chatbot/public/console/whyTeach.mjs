// whyTeach.mjs — กล่อง "สอนลูกแพร" ในแผง "ทำไมตอบแบบนี้" (คำสั่งพี่ง้วง 2026-09-28)
//
// "พิมพ์สอนในนั้นได้เลย ไม่ต้องเข้าไปหน้าตั้งค่าอีก กดบันทึกแล้วลูกแพรเก็บเข้าบทเรียน"
// — กดบันทึกแล้วอยู่หน้าเดิม ไม่เปลี่ยนหน้า ไม่มีขั้นตอนเพิ่ม เซิร์ฟเวอร์เป็นคนบอกว่าผลคืออะไร
// (ใช้ทันที หรือรอพี่ง้วงอนุมัติ) หน้าเว็บห้ามเดาเอง — สิทธิ์อาจเปลี่ยนระหว่างที่หน้าเปิดค้าง
//
// ห้องแชท re-render ทั้งห้องทุกครั้งที่มีข้อความใหม่ กล่องนี้จึงเก็บสิ่งที่พิมพ์ค้างไว้ใน memory
// ของแผง (whyPanel.mjs) แล้ววาดคืนตอนสร้างใหม่ ช่องพิมพ์ติด keep-focus ให้ poll พักขณะพิมพ์
// พร้อมคลาสเฉพาะข้อความ (why-t-xxxx) เพราะตัวกู้ค่าของห้องแชทจับคู่ช่องด้วยชื่อคลาส —
// ถ้าทุกแผงใช้คลาสเดียวกัน ข้อความที่พิมพ์ใต้ฟองหนึ่งจะไปโผล่ใต้อีกฟอง
import { el } from "./dom.mjs";

const STATUS_TH = { active: "ใช้อยู่", pending: "รอพี่ง้วงอนุมัติ", disabled: "ปิดไว้" };
const MIN_TEACHING = 3;

// ชื่อคลาสต่อข้อความ — id ข้อความมีอักขระที่ใช้ใน selector ไม่ได้ จึงแปลงเป็น hash
// 64 บิต (FNV-1a สองรอบคนละค่าตั้งต้น) ให้โอกาสชนกันข้ามฟองในห้องเดียวกันเป็นศูนย์ในทางปฏิบัติ
export function panelToken(messageId) {
  const fnv = (seed) => {
    let hash = seed;
    for (const ch of String(messageId)) {
      hash ^= ch.codePointAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  };
  return `${fnv(0x811c9dc5)}${fnv(0x01000193 ^ 0x5bd1e995)}`;
}

export function lessonsUsedLine(used = []) {
  if (!Array.isArray(used) || !used.length) return null;
  const titles = used.map((lesson) => (lesson.missing
    ? "(บทเรียนที่ถูกลบไปแล้ว)"
    : `${lesson.title}${lesson.status === "active" ? "" : ` (${STATUS_TH[lesson.status] || lesson.status})`}`));
  return el("p", { class: "why-line why-lessons-used" },
    el("span", { class: "why-key" }, "ใช้บทเรียน "),
    el("strong", {}, `${used.length} เรื่อง`),
    el("span", { class: "why-lessons-titles" }, `: ${titles.join(" · ")}`),
  );
}

/**
 * @param {{api: Function, messageId: string, lessons: object, memory: object, onSaved?: Function}} deps
 *   memory = ที่เก็บของแผงนี้ (อยู่รอด re-render) — draft/note ถูกอ่านและเขียนที่นี่
 */
export function teachBox({ api, messageId, lessons, memory, onSaved = null }) {
  if (!lessons?.canTeach || !lessons.teachable) return null;
  const limits = { teaching: Number(lessons.limits?.teaching) || 600, topic: Number(lessons.limits?.topic) || 60 };
  const token = panelToken(messageId);
  const draft = memory.draft ?? { teaching: "", topic: String(lessons.suggestedTopic || "") };
  const topic = el("input", {
    class: `why-lesson-topic keep-focus why-t-${token}`, type: "text", maxlength: String(limits.topic),
    placeholder: "เรื่อง/หัวข้อ เช่น ที่จอดรถ", "aria-label": "เรื่องหรือหัวข้อของบทเรียน",
  });
  topic.value = draft.topic;
  const teaching = el("textarea", {
    class: `why-lesson-input keep-focus why-t-${token}`, rows: "3", maxlength: String(limits.teaching),
    placeholder: "สอนลูกแพร: เรื่องแบบนี้ควรตอบยังไง / อะไรที่ไม่ควรพูด",
    "aria-label": "สิ่งที่อยากสอนลูกแพร",
  });
  teaching.value = draft.teaching;
  const counter = el("span", { class: "why-lesson-count", "aria-hidden": "true" });
  const save = el("button", { class: "btn btn-primary btn-mini why-lesson-save", type: "button" }, "บันทึกบทเรียน");
  const status = el("p", { class: `why-lesson-status${memory.noteTone ? ` is-${memory.noteTone}` : ""}`, role: "status", "aria-live": "polite" });
  status.textContent = memory.note || ""; // ข้อความยืนยันต้องอยู่รอดการวาดแผงใหม่หลังบันทึก
  let saving = false;

  const sync = () => {
    memory.draft = { teaching: teaching.value, topic: topic.value };
    counter.textContent = `${[...teaching.value].length}/${limits.teaching}`;
    save.disabled = saving || teaching.value.trim().length < MIN_TEACHING;
  };
  const setNote = (text, tone) => {
    memory.note = text;
    memory.noteTone = tone;
    status.textContent = text;
    status.className = `why-lesson-status is-${tone}`;
  };

  async function submit() {
    const text = teaching.value.trim();
    if (saving || text.length < MIN_TEACHING) return;
    saving = true;
    sync();
    setNote("กำลังบันทึก…", "busy");
    try {
      const result = await api("/console/api/lessons", {
        method: "POST", body: { messageId, teaching: text, topic: topic.value.trim() },
      });
      teaching.value = "";
      setNote(result.message || "บันทึกแล้ว", result.status === "active" ? "active" : "pending");
      saving = false;
      sync();
      await onSaved?.(result);
    } catch (err) {
      saving = false;
      setNote(err.message || "บันทึกไม่สำเร็จ ลองใหม่อีกครั้งนะคะ", "error");
      sync();
    }
  }

  teaching.addEventListener("input", sync);
  topic.addEventListener("input", sync);
  // ⌘/Ctrl + Enter = บันทึก (Enter เฉย ๆ ยังขึ้นบรรทัดใหม่ตามปกติ)
  teaching.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault?.();
      submit();
    }
  });
  save.addEventListener("click", submit);
  sync();

  const taught = Array.isArray(lessons.taughtHere) ? lessons.taughtHere : [];
  return el("section", { class: "why-lesson", "aria-label": "สอนลูกแพรจากข้อความนี้" },
    el("p", { class: "why-lesson-head" }, "สอนลูกแพร"),
    taught.length
      ? el("ul", { class: "why-lesson-taught", "aria-label": "บทเรียนที่สอนจากข้อความนี้แล้ว" },
          taught.map((lesson) => el("li", {},
            el("strong", {}, lesson.title), ` — ${lesson.teaching} `,
            el("span", { class: `why-lesson-badge is-${lesson.status}` }, STATUS_TH[lesson.status] || lesson.status))))
      : null,
    topic,
    teaching,
    el("div", { class: "why-lesson-row" }, counter, save),
    status,
    lessons.paused
      ? el("p", { class: "why-lesson-hint" }, "ตอนนี้พี่ง้วงหยุดใช้บทเรียนชั่วคราว — บันทึกไว้ได้ ลูกแพรจะเริ่มใช้เมื่อเปิดอีกครั้ง")
      : null,
    lessons.canApprove
      ? null
      : el("p", { class: "why-lesson-hint" }, "บทเรียนของทีมจะเริ่มใช้หลังพี่ง้วงอนุมัติ"),
  );
}
