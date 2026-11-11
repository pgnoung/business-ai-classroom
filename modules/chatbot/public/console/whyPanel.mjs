// whyPanel.mjs — Step 0 "ทำไมตอบแบบนี้" ใต้ฟองของ AI ในห้องแชท
//
// แยกจาก teach.mjs เพื่อคุมขนาดไฟล์ (< 400 บรรทัดตามกติกาของหน้าคอนโซล) และเพราะ
// ห้องแชทเป็นผู้ใช้เพียงรายเดียวของมัน — จอสอนไม่ได้เรียกไฟล์นี้เลย
//
// 2026-09-28 (คำสั่งพี่ง้วง): แผงนี้มีกล่อง "สอนลูกแพร" ในตัว (whyTeach.mjs) — พิมพ์แล้วกดบันทึก
// ได้เลยโดยไม่ต้องเปลี่ยนหน้า ส่วนลิงก์จอสอนเดิมยังอยู่เป็นทางรอง "สอนแบบละเอียด" สำหรับ
// ข้อเท็จจริงที่ต้องเป็นความรู้ถาวร (การ์ด/ราคา ผ่านบันไดเผยแพร่)
import { el } from "./dom.mjs";
import { lessonsUsedLine, teachBox } from "./whyTeach.mjs";

// ความจำของแผงต่อข้อความ: ห้องแชทสร้างฟองใหม่ทั้งห้องทุกครั้งที่มีข้อความเข้า — แผงที่กางอยู่
// ต้องกางต่อ และสิ่งที่พิมพ์สอนค้างไว้ต้องไม่หาย (โหลดซ้ำก็ไม่ต้อง ใช้ผลรอบก่อนวาดทันที)
// ผูกกับตัว api ของหน้า (หนึ่งตัวต่อการเปิดคอนโซลหนึ่งครั้ง) — เซสชันใหม่ = เริ่มจากศูนย์
// จำเฉพาะแผงที่เคยกาง (ไม่ใช่ทุกฟอง) — ห้องที่มีคำตอบของ AI เกินเพดาน ต้องไม่ดันความจำของแผง
// ที่กำลังพิมพ์สอนอยู่ตกออกไปเพียงเพราะห้องถูกวาดใหม่
const PANEL_MEMORY = new WeakMap();
const PANEL_MEMORY_MAX = 60;

function panelsFor(api) {
  let panels = PANEL_MEMORY.get(api);
  if (!panels) {
    panels = new Map();
    PANEL_MEMORY.set(api, panels);
  }
  return panels;
}

/**
 * แผงอ่านอย่างเดียวใต้ฟองแชท — โหลดตอนกางครั้งแรกเท่านั้น (ห้องหนึ่งมีหลายสิบฟอง
 * ถ้ายิงพร้อมกันทุกฟองตอนเปิดห้อง เราจะคอมไพล์สมองหลายสิบรอบเพื่อสิ่งที่ไม่มีใครกาง)
 *
 * ความซื่อสัตย์ของแผงนี้อยู่ที่ **ไม่เดา**: เซิร์ฟเวอร์ตอบมาว่ารู้หรือไม่รู้ หน้าเว็บพิมพ์ตามนั้น
 * ห้ามเติมคำว่า "รุ่นสมอง" ให้เทิร์นที่ไม่มี brain_version_id เด็ดขาด
 */
export function whyPanel({ api, message, canTeach = true }) {
  const panels = panelsFor(api);
  const key = String(message.id);
  let memory = panels.get(key) ?? null;
  const remember = () => {
    if (!memory) {
      memory = { open: false, payload: null, draft: null, note: "", noteTone: "" };
      panels.set(key, memory);
      if (panels.size > PANEL_MEMORY_MAX) panels.delete(panels.keys().next().value);
    }
    return memory;
  };
  const path = `/console/api/teach/why?messageId=${encodeURIComponent(message.id)}`;
  const body = el("div", { class: "why-body" }, el("p", { class: "why-line" }, "แตะเพื่อดูที่มาของคำตอบนี้"));
  const box = el("details", { class: "why" },
    el("summary", { class: "why-summary" }, "ทำไมตอบแบบนี้"),
    body,
  );
  let loaded = false;
  const paint = () => body.replaceChildren(...whyNodes(memory?.payload?.why, {
    messageId: message.id, canTeach, lessons: memory?.payload?.lessons, api, memory: remember(), onSaved: refresh,
  }));
  // หลังบันทึกบทเรียน: ดึงแผงใหม่ให้ "สอนจากข้อความนี้แล้ว" ขึ้นทันที — ล้มก็คงหน้าเดิมไว้
  // (ข้อความยืนยันการบันทึกขึ้นไปแล้ว ไม่ต้องทำให้คนสับสนว่าบันทึกไม่สำเร็จ)
  async function refresh() {
    try {
      remember().payload = await api(path);
      paint();
    } catch { /* คงหน้าเดิม */ }
  }
  if (memory?.open && memory.payload) {
    box.open = true;
    loaded = true;
    paint();
  }
  box.addEventListener("toggle", async () => {
    if (box.open === true) remember().open = true;
    else if (memory) memory.open = false;
    if (loaded || box.open !== true) return;
    loaded = true;
    body.replaceChildren(el("p", { class: "why-line" }, "กำลังดูให้ค่ะ…"));
    try {
      remember().payload = await api(path);
      paint();
    } catch (err) {
      loaded = false;
      body.replaceChildren(el("p", { class: "why-line" }, `ดูที่มาไม่ได้: ${err.message}`));
    }
  });
  return box;
}

export function whyNodes(why, { messageId = "", canTeach = true, lessons = null, api = null, memory = null, onSaved = null } = {}) {
  const brain = why?.brain ?? {};
  const nodes = [
    el("p", { class: "why-line" },
      el("span", { class: "why-key" }, "สมองที่ใช้ "),
      el("strong", { class: brain.known ? "why-known" : "why-legacy" }, brain.label || "ไม่ทราบ"),
    ),
    el("p", { class: "why-sub" }, brain.why || ""),
  ];
  if (brain.known && (brain.sources ?? []).length) {
    nodes.push(el("p", { class: "why-line" },
      el("span", { class: "why-key" }, "สิ่งที่ป้อนคำตอบ "),
      (brain.sources ?? []).map((source) => `${SOURCE_KIND_TH[source.kind] || source.kind} ${source.count}`).join(" · "),
    ));
  }
  nodes.push(el("p", { class: "why-line" },
    el("span", { class: "why-key" }, "เส้นทาง "),
    why?.route?.answeredBy === "คน"
      ? `คนตอบเอง${why.route.operator ? ` (${why.route.operator})` : ""}`
      : "ตอบด้วย AI",
  ));
  // บทเรียนที่เทิร์นนี้ใช้จริง (pipeline จดไว้ตอนส่ง) — ไม่มี = ไม่พิมพ์อะไร ไม่ใช่ "ไม่ได้ใช้"
  nodes.push(lessonsUsedLine(lessons?.used));
  if (api && messageId) nodes.push(teachBox({ api, messageId, lessons, memory: memory ?? {}, onSaved }));
  // หัวข้อบอกก่อนว่ารายการข้างล่างคือ "ข้อจำกัดของโหมด" — คนอ่านเคยเข้าใจว่าเป็น error (2026-09-05)
  if ((why?.unknown ?? []).length) nodes.push(el("div", { class: "why-key why-unknown-head" }, "ข้อจำกัดของโหมดนี้ (ไม่ใช่ข้อผิดพลาด)"));
  nodes.push(el("ul", { class: "why-unknown" },
    (why?.unknown ?? []).map((line) => el("li", {}, line))));
  if (canTeach && messageId) {
    nodes.push(el("div", { class: "why-links" },
      // จอสอนเดิม = ทางรอง สำหรับข้อเท็จจริงที่ต้องเป็นการ์ดความรู้/ราคา (ผ่านบันไดเผยแพร่)
      el("a", {
        class: "btn btn-outline btn-mini why-teach",
        href: `#/teach/message/${encodeURIComponent(messageId)}`,
      }, "สอนแบบละเอียด (เป็นความรู้ถาวร)"),
      lessons?.canTeach ? el("a", { class: "why-lessons-link", href: "#/lessons" }, "ดูบทเรียนทั้งหมด ›") : null,
    ));
  }
  return nodes.filter(Boolean);
}

const SOURCE_KIND_TH = {
  fact: "ความรู้", price: "ราคา", schedule: "รอบเรียน", product: "สินค้า", policy: "กติกา",
};
