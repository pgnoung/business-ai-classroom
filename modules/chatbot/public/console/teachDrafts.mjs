// teachDrafts.mjs — ข้อความที่พิมพ์ค้างไว้ในจอสอน (เก็บในเบราว์เซอร์ของคนกดเท่านั้น)
//
// แยกจาก teach.mjs เพื่อคุมขนาดไฟล์ และเพราะมันเป็นเรื่องของ "เครื่องคนกด" ล้วน:
// ไม่มีอะไรในนี้ถูกส่งขึ้นเซิร์ฟเวอร์ และไม่มีอะไรในนี้ควรอยู่ในตรรกะของการสอน

// เก็บต่อ (แหล่ง, id) ไม่ใช่ก้อนเดียว — เปิดสองเรื่องสลับกันแล้วข้อความต้องไม่ปนกัน
// localStorage พังได้ (โหมดส่วนตัว/พื้นที่เต็ม) ทุกทางจึงต้องกลืน error แล้วเดินต่อ
export const TEACH_DRAFT_PREFIX = "lukprae.teach_draft:";
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function draftKey(source, ref) {
  return `${TEACH_DRAFT_PREFIX}${source}:${ref}`;
}

export function saveDraft(source, ref, { title = "", content = "" } = {}) {
  if (!content.trim() && !title.trim()) return clearDraft(source, ref);
  try {
    localStorage.setItem(draftKey(source, ref), JSON.stringify({ title, content, at: Date.now() }));
  } catch { /* พื้นที่เต็ม/โหมดส่วนตัว — ไม่ใช่เหตุให้จอพัง */ }
}

export function readDraft(source, ref) {
  try {
    const saved = JSON.parse(String(localStorage.getItem(draftKey(source, ref)) || "null"));
    if (!saved || typeof saved !== "object") return null;
    if (Date.now() - Number(saved.at || 0) > DRAFT_TTL_MS) { clearDraft(source, ref); return null; }
    return { title: String(saved.title || ""), content: String(saved.content || "") };
  } catch { return null; }
}

export function clearDraft(source, ref) {
  try { localStorage.removeItem(draftKey(source, ref)); } catch { /* เหมือนกัน */ }
}

