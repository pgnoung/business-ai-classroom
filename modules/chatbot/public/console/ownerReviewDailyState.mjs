// ownerReviewDailyState.mjs — สถานะคิวตรวจแชทรายวันแบบ pure (#/owner-review/daily · เฟส B · 12 ต.ค. 2026)
//
// ไม่แตะ DOM ไม่ยิง API — ตัวคุม (ownerReviewDaily.mjs) ถือ view หนึ่งก้อนต่อคิวหนึ่งรอบ แล้วใช้ฟังก์ชันพวกนี้อ่าน/รวมผล
//   view.order = ลำดับของเซิร์ฟเวอร์ (น่าห่วงก่อน → AI ยังไม่ได้อ่าน → เสี่ยงมากก่อน) · view.deck = ห้องที่ยังไม่มีป้าย (ใบแรก = การ์ดที่ดูอยู่)
//   ผลจากเซิร์ฟเวอร์รวมเฉพาะ revision ที่ใหม่กว่า · คนอื่นติดป้ายห้องที่ดูอยู่ = ไม่ดึงการ์ดออกใต้นิ้ว (ตัวคุมขึ้นแถบบอกแทน)

export const DAILY_BASE = "/console/api/owner-review/daily";
const BATCH_RE = /[?&]batch=([\w-]{1,80})(?:&|$)/u;

/** รอบที่ขอดูจาก hash (#/owner-review/daily?batch=<id>) — ว่าง = รอบล่าสุดที่พร้อม */
export function dailyBatchFromHash(hash) {
  return BATCH_RE.exec(String(hash || ""))?.[1] || "";
}

export const dailyQueuePath = (batchId = "") => (batchId ? `${DAILY_BASE}?batch=${encodeURIComponent(batchId)}` : DAILY_BASE);
export const dailyItemPath = (id, tail = "") => `${DAILY_BASE}/items/${encodeURIComponent(String(id))}${tail}`;
export const dailyBatchPath = (id, tail = "") => `${DAILY_BASE}/batches/${encodeURIComponent(String(id))}${tail}`;

export const labelWord = (label) => (label === "good" ? "ดีแล้ว" : label === "needs_fix" ? "ต้องปรับ" : "ติดป้าย");

/** ตัวเลขของคิวจากรายการในมือ — ป้ายของทุกคน + ห้องน่าห่วงที่เหลือ + ห้องที่ "ดีที่เหลือทั้งหมด" ครอบได้ */
export function dailyCounts(items = []) {
  const counts = { total: 0, labelled: 0, remaining: 0, good: 0, needsFix: 0, flaggedRemaining: 0, bulkEligible: 0 };
  for (const item of items) {
    counts.total += 1;
    if (item?.label) {
      counts.labelled += 1;
      if (item.label === "good") counts.good += 1;
      else if (item.label === "needs_fix") counts.needsFix += 1;
    } else {
      counts.remaining += 1;
      if (item?.flagged) counts.flaggedRemaining += 1;
      if (item?.bulkEligible) counts.bulkEligible += 1;
    }
  }
  return counts;
}

/** บทเรียนที่ "ต้องปรับ" ของรอบนี้สร้างใหม่ (จากรายการห้องของเซิร์ฟเวอร์ — นับถูกแม้เปิดหน้าใหม่ · ย้อนแล้วหายเอง) */
export function lessonsCreated(items = []) {
  return items.reduce((sum, item) => sum + (Array.isArray(item?.lessons) ? item.lessons.filter((entry) => entry?.created === true).length : 0), 0);
}

/** บรรทัดที่บอกก่อนกดบันทึกว่า "ต้องปรับ" แล้วลูกแพรจะได้อะไร (เจ้าของใช้ทันที · ทีมรออนุมัติ · ป้ายอย่างเดียว) */
export function fixCopy(detail, { lessonPath, bubble }) {
  if (lessonPath) {
    if (!detail?.lessonsApplyNow) return "บทเรียนนี้จะรอพี่ง้วงอนุมัติก่อน ลูกแพรจึงจะใช้";
    return detail.lessonsPaused
      ? "บันทึกเป็นบทเรียนทันที แต่ตอนนี้พักการใช้บทเรียนอยู่ — ลูกแพรจะเริ่มใช้เมื่อเปิดอีกครั้ง"
      : "บันทึกแล้วลูกแพรใช้บทเรียนนี้ทันทีตั้งแต่ข้อความถัดไป";
  }
  if (detail?.teachEnabled === false) return "ระบบสอนลูกแพรปิดอยู่ — บันทึกเป็นป้าย \"ต้องปรับ\" อย่างเดียว";
  if (!bubble) return "ไม่ได้ระบุข้อความ — บันทึกเป็นป้าย \"ต้องปรับ\" พร้อมเหตุผล (ยังไม่สร้างบทเรียน)";
  return "บัญชีนี้สอนลูกแพรไม่ได้ — บันทึกเป็นป้าย \"ต้องปรับ\" อย่างเดียว";
}

/** ข้อความหลังบันทึก "ต้องปรับ" — ทางบทเรียนใช้คำของเซิร์ฟเวอร์ (บอกตรง ๆ ว่าใช้ทันทีหรือรออนุมัติ) */
export function fixDoneText(res, { lessonPath, detail }) {
  if (lessonPath && res?.message) return String(res.message);
  if (lessonPath) return res?.lessonStatus === "pending" ? "ส่งให้พี่ง้วงอนุมัติแล้ว" : "บันทึกบทเรียนแล้ว";
  return detail?.teachEnabled === false ? "บันทึกว่าต้องปรับแล้ว — ระบบสอนลูกแพรปิดอยู่" : "บันทึกว่าต้องปรับแล้ว";
}

/** view ใหม่จากคำตอบของ GET /daily (null = ยังไม่มี/โหลดไม่ได้) */
export function newDailyView(queue, { requested = "" } = {}) {
  const items = Array.isArray(queue?.items) ? queue.items : [];
  return {
    requested,
    batch: queue?.batch ?? null,
    items: new Map(items.map((item) => [item.id, item])),
    order: items.map((item) => item.id),
    deck: items.filter((item) => !item.label).map((item) => item.id),
    taper: queue?.taper ?? null, backlog: Array.isArray(queue?.backlog) ? queue.backlog : [], building: queue?.building ?? null,
    nextDailyAt: queue?.nextDailyAt ?? null, chips: Array.isArray(queue?.chips) ? queue.chips : [], codes: queue?.codes || {},
    undoMs: Number(queue?.undoMs) || 10_000, betterReplyMax: Number(queue?.betterReplyMax) || 500, canPin: queue?.canPin === true,
    betterReplyMin: Number(queue?.betterReplyMin) || 6,
    details: new Map(), detailState: new Map(), showEarlier: new Set(), busyKeys: new Set(), expandedIssues: new Set(),
    // ร่าง "ต้องปรับ" ต่อฟอง (หน่วยความจำเท่านั้น — หายเมื่อปิดหน้า) · ห้องที่เพิ่งขอ "กำลังดู" ไปแล้ว
    drafts: new Map(), claimedId: "", claimedAt: 0,
    busy: false, bulkBusy: false, bulkArmedUntil: 0, pinBusy: false, shownAt: 0, picking: false, flashId: "", notice: null,
    taperOpen: false, lessonsApplyNow: false, sessionLabels: 0, newBatch: null, error: null,
  };
}

/** กุญแจร่างของแผ่นต้องปรับ — หนึ่งร่างต่อฟอง (ไม่ระบุฟอง = ทั้งห้อง) */
export const draftKey = (itemId, bubbleId = "") => `${String(itemId)}:${String(bubbleId || "room")}`;

/**
 * ห้องที่คนอื่นกำลังดูอยู่ (viewingBy) ไม่ขึ้นเป็นการ์ดถัดไปถ้ายังมีห้องว่าง — สลับห้องว่างใบแรกขึ้นหน้า (ที่เหลือคงลำดับ)
 * พี่ง้วงกับชมพู่เริ่มพร้อมกันตอนสองทุ่มจะไม่เปิดห้องน่าห่วงห้องเดียวกัน · คืน true = ลำดับเปลี่ยน
 */
export function preferUnclaimed(view) {
  const deck = view?.deck || [];
  if (!deck.length || !view.items.get(deck[0])?.viewingBy) return false;
  const free = deck.findIndex((id) => !view.items.get(id)?.viewingBy);
  if (free <= 0) return false;
  view.deck = [deck[free], ...deck.filter((_, index) => index !== free)];
  return true;
}

/** การ์ดที่ดูอยู่ไปไว้ท้ายกอง (คนอื่นกำลังดูห้องนี้ — "ข้ามไปห้องอื่น") */
export function deferCurrent(view) {
  if (!view || view.deck.length < 2) return false;
  view.deck = [...view.deck.slice(1), view.deck[0]];
  return true;
}

/**
 * ขอบเขตของ "ดีที่เหลือทั้งหมด" — ห้องปกติที่ AI อ่านแล้วไม่ชี้จุดใด ไม่รวมการ์ดที่เปิดอยู่ (เซิร์ฟเวอร์ใช้เกณฑ์เดียวกัน)
 * smallIssues = ห้องไม่น่าห่วงที่ AI ชี้จุดเล็กไว้ (ต้องดูเอง) · คืน { count, smallIssues, exceptId }
 */
export function bulkScope(view) {
  const current = currentItem(view);
  let count = 0;
  let smallIssues = 0;
  for (const item of dailyItems(view)) {
    if (item.label || item.id === current?.id) continue;
    if (item.bulkEligible) count += 1;
    else if (!item.flagged && !item.sampled && item.aiStatus === "done" && Number(item.issueCount) > 0) smallIssues += 1;
  }
  return { count, smallIssues, exceptId: current?.id || "" };
}

export const currentItem = (view) => (view ? view.items.get(view.deck[0]) ?? null : null);
export const dailyItems = (view) => (view ? view.order.map((id) => view.items.get(id)).filter(Boolean) : []);

/** ตัวเลขรอบเดิม/ระดับ/ค้างตรวจจากคำตอบใหม่ (ไม่แตะรายการห้อง) */
export function applyDailyMeta(view, queue) {
  Object.assign(view, {
    taper: queue?.taper ?? view.taper, backlog: Array.isArray(queue?.backlog) ? queue.backlog : view.backlog,
    building: queue?.building ?? null, nextDailyAt: queue?.nextDailyAt ?? view.nextDailyAt,
  });
}

/** รวมคิวรอบเดิมทั้งก้อน (หลัง "ดีที่เหลือทั้งหมด") — การ์ดที่ดูอยู่ (ยังไม่มีป้าย) อยู่หน้าสุดต่อ · คืน true = การ์ดหน้าสุดเปลี่ยน */
export function applyDailyQueue(view, queue) {
  const items = Array.isArray(queue?.items) ? queue.items : [];
  const keep = currentItem(view);
  view.items = new Map(items.map((item) => [item.id, item]));
  view.order = items.map((item) => item.id);
  const open = items.filter((item) => !item.label).map((item) => item.id);
  view.deck = keep && open.includes(keep.id) ? [keep.id, ...open.filter((id) => id !== keep.id)] : open;
  applyDailyMeta(view, queue);
  return keep?.id !== view.deck[0];
}

/**
 * ผลของห้องหนึ่งจากเซิร์ฟเวอร์ (revision ใหม่กว่าหรือเท่ากันเท่านั้น)
 * คืน "current" = คนอื่นติดป้ายห้องที่ดูอยู่ (ตัวคุมขึ้นแถบบอก) · "dropped" = ห้องในกองที่คนอื่นติดป้ายแล้ว หายจากกอง
 *     "updated" = ข้อมูลใหม่ (ใช่/ไม่ใช่, revision) · "" = ไม่รู้จัก/เก่ากว่า
 */
export function mergeDailyItem(view, fresh) {
  const local = view?.items.get(fresh?.id);
  if (!local || (Number(fresh.revision) || 0) < (Number(local.revision) || 0)) return "";
  view.items.set(fresh.id, { ...local, ...fresh });
  if (!fresh.label || local.label || !view.deck.includes(fresh.id)) return "updated";
  if (view.deck[0] === fresh.id) return "current";
  view.deck = view.deck.filter((id) => id !== fresh.id);
  return "dropped";
}

/** ห้องหายจากคิว (ลบตามสิทธิ์ให้ลืม / ไม่อยู่ในสาขาแล้ว) */
export function dropDailyItem(view, id) {
  view.deck = view.deck.filter((row) => row !== id);
  view.order = view.order.filter((row) => row !== id);
  view.items.delete(id);
  view.details.delete(id);
  view.detailState.delete(id);
}

/** การ์ดที่บันทึกไม่ผ่านกลับเข้ากอง — กำลังทำห้องอื่นอยู่ = คืนเป็นใบถัดไป (ไม่แทรกใต้นิ้ว) */
export function returnToDeck(view, id, { behind = false } = {}) {
  const rest = view.deck.filter((row) => row !== id);
  view.deck = behind && rest.length ? [rest[0], id, ...rest.slice(1)] : [id, ...rest];
}
