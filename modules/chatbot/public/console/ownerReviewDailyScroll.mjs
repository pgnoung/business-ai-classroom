// ownerReviewDailyScroll.mjs — ตำแหน่งจอของแท็บ "ตรวจแชทวันนี้" (#/owner-review/daily · เฟส B · รีวิว 13 ต.ค. 2026)
//
// รีวิวบน iPhone (375×812) เจอสามเรื่องที่ทำให้ตรวจ ~120 ห้อง/คืนช้า:
//   1. ห้องถัดไปเด้งกลับบนสุดของหน้า — แชทเริ่มใต้แถบปุ่ม ต้องเลื่อนลงทุกห้อง → เลื่อนให้กองการ์ดอยู่ใต้แถบความคืบหน้าแทน
//   2. กด "ต้องปรับ" ในแชทยาว = การ์ดถูกวาดใหม่แล้วจอกระโดดไปที่อื่น (Safari ไม่มี scroll anchoring) → จำฟองกลางจอแล้วคืนตำแหน่ง
//   3. แผ่น "ต้องปรับ" สูงเกินจอเมื่อคีย์บอร์ดขึ้น ปุ่มบันทึกจมใต้คีย์บอร์ด → ขนาดแผ่นตาม visualViewport (ส่วนที่มองเห็นจริง)
// ไม่มีสถานะของคิว ไม่ยิง API · ทุกเมธอดของ DOM เรียกแบบมีตัวกัน (เทสต์ใช้ DOM ปลอมที่ไม่มี layout)

const rectOf = (node) => (typeof node?.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null);

/** กล่องเลื่อนของหน้า (main.page-scroll) ที่ห่อโหนดนี้อยู่ */
export const scrollerOf = (node) => node?.closest?.(".page-scroll") ?? null;

/**
 * เลื่อนให้ target อยู่ใต้แถบความคืบหน้าที่ติดขอบบน (ไม่ใช่บนสุดของหน้า — แท็บ/ระดับการตรวจเลื่อนขึ้นไปดูได้เสมอ)
 * เลื่อนเฉพาะเมื่อห่างจากตำแหน่งนั้นเกิน 4px · คืน true = สั่งเลื่อนแล้ว
 */
export function scrollUnderBar(target, { bar = null, gap = 8, behavior = "auto" } = {}) {
  const scroller = scrollerOf(target);
  const box = rectOf(scroller);
  const at = rectOf(target);
  if (!scroller || !box || !at) return false;
  const barHeight = rectOf(bar)?.height || 0;
  const top = Math.max(0, Math.round(at.top - box.top + (Number(scroller.scrollTop) || 0) - barHeight - gap));
  if (Math.abs((Number(scroller.scrollTop) || 0) - top) <= 4) return false;
  if (typeof scroller.scrollTo === "function") scroller.scrollTo({ top, behavior });
  else scroller.scrollTop = top;
  return true;
}

/**
 * จำฟองที่อยู่ใกล้กลางจอที่สุด (ก่อนวาดการ์ดใหม่) — prefer = id ของฟองที่อยากยึดก่อนถ้ามองเห็นอยู่
 * @returns {null | {scroller, id: string, top: number}}
 */
export function captureAnchor(root, { prefer = "" } = {}) {
  const scroller = scrollerOf(root);
  const box = rectOf(scroller);
  if (!scroller || !box) return null;
  const middle = box.top + box.height / 2;
  let best = null;
  for (const node of root.querySelectorAll?.(".odr-msg") || []) {
    const at = rectOf(node);
    if (!at || at.bottom < box.top || at.top > box.bottom) continue;
    const id = String(node.getAttribute?.("data-msg") || "");
    if (!id) continue;
    const distance = id === prefer ? -1 : Math.abs((at.top + at.bottom) / 2 - middle);
    if (!best || distance < best.distance) best = { id, top: at.top, distance };
  }
  return best ? { scroller, id: best.id, top: best.top } : null;
}

/** คืนตำแหน่งให้ฟองเดิมอยู่ที่เดิมบนจอ (หลังวาดการ์ดใหม่) */
export function restoreAnchor(root, anchor) {
  if (!anchor) return false;
  const node = Array.from(root.querySelectorAll?.(".odr-msg") || []).find((row) => row.getAttribute?.("data-msg") === anchor.id);
  const at = rectOf(node);
  if (!at) return false;
  const delta = Math.round(at.top - anchor.top);
  if (Math.abs(delta) <= 1) return false;
  anchor.scroller.scrollTop = (Number(anchor.scroller.scrollTop) || 0) + delta;
  return true;
}

/**
 * แผ่นล่างตามส่วนที่มองเห็นจริง (คีย์บอร์ด iPhone ไม่ทำให้ 100dvh หด) — ตั้ง --odr-vv-h / --odr-vv-top บนชั้นของแผ่น
 * ผ่าน CSSOM (CSP ห้าม style="") · คืนฟังก์ชันเลิกฟัง · ไม่มี visualViewport (เบราว์เซอร์เก่า/เทสต์) = ไม่ทำอะไร
 */
export function followVisualViewport(layer) {
  const viewport = globalThis.visualViewport;
  if (!viewport || typeof viewport.addEventListener !== "function" || typeof layer?.style?.setProperty !== "function") return () => {};
  const apply = () => {
    layer.style.setProperty("--odr-vv-h", `${Math.max(240, Math.round(Number(viewport.height) || 0))}px`);
    layer.style.setProperty("--odr-vv-top", `${Math.max(0, Math.round(Number(viewport.offsetTop) || 0))}px`);
  };
  apply();
  layer.classList?.add("odr-vv");
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  return () => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
  };
}
