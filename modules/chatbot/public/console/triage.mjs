// triage.mjs — ของใช้ร่วมของ "คัดห้อง" บนคอนโซล (28 ก.ย. 2026)
//
// คำขอพี่ง้วง: คิว "รอตอบ" ในหน้าแชทต้องเหมือนรายการบนหน้าภาพรวม · กดห้องค้างแล้วทำงานต่อได้เลย
// ไม่ต้อง back กลับมาทุกครั้ง · ปุ่ม "สแปม" คัดคนออกจาก inbox (สแปม = ป้าย null) · AI ปิดต้องบอกว่า
// "ปิดโดยคน" (ม่วง CI ลูกแพร) หรือ "ปิดโดยระบบ" (แดง)
// ไฟล์นี้รวมของที่หน้าภาพรวม (overviewCeo.mjs) รายการแชท (inbox.mjs) และหัวห้อง (chat.mjs) ใช้ร่วมกัน
// ป้ายหน้าตาเดียวกันทุกที่ และตรรกะ "ห้องถัดไป" มีที่เดียว (ฟังก์ชันบริสุทธิ์ ทดสอบได้ตรง ๆ)
import { el } from "./dom.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// ชิปที่ทำงานเป็น "คิว" — เปิดห้องจากชิปเหล่านี้แล้ว URL จำคิวไว้ (#/chat/<คิว>/<ห้อง>)
// รีเฟรชหน้า/กดย้อนกลับแล้วยังอยู่คิวเดิม และปุ่มกลับพากลับคิวเดิม
// 30 ก.ย. 2026: "hotfollow" = ลูกค้าร้อนรอทีมทักต่อ — ไล่ทักทีละห้อง พิมพ์คุยเสร็จแล้วห้องถัดไปเปิดเอง
export const HOT_FOLLOW_FILTER = "hotfollow";
export const QUEUE_FILTERS = Object.freeze(["waiting", "waiting24", HOT_FOLLOW_FILTER, "spam"]);
const QUEUES = new Set(QUEUE_FILTERS);
export const WAITING_FILTERS = Object.freeze(["waiting", "waiting24"]);
const WAITING = new Set(WAITING_FILTERS);

export function isQueueFilter(filter) {
  return QUEUES.has(String(filter || ""));
}

export function isWaitingFilter(filter) {
  return WAITING.has(String(filter || ""));
}

export function isHotFollowFilter(filter) {
  return String(filter || "") === HOT_FOLLOW_FILTER;
}

/** คิวที่ "ทำเสร็จแล้วเปิดห้องถัดไปเอง" หลังส่งข้อความ — คิวรอตอบ + คิวรอทีมทักต่อ (สแปมไม่ใช่) */
export function isAdvanceQueue(filter) {
  return isWaitingFilter(filter) || isHotFollowFilter(filter);
}

/** ลิงก์เข้าห้อง — อยู่ในคิว = จำคิวไว้ใน URL · ที่อื่นใช้ลิงก์เดิม #/c/<id> */
export function roomHash(filter, id) {
  const room = encodeURIComponent(String(id || ""));
  return isQueueFilter(filter) ? `#/chat/${filter}/${room}` : `#/c/${room}`;
}

// ระยะเวลาเป็นภาษาคน: "23 นาที" / "2 ชม." / "11 วัน" — เว้นวรรคแบบไม่ตัดบรรทัด (NBSP)
// ประโยคของลูกแพรเคยขึ้นบรรทัดใหม่ระหว่าง "11" กับ "วัน" อ่านสะดุด (ย้ายมาจาก overviewCeo.mjs)
const NBSP = "\u00a0";
export function spanLabel(ms) {
  const v = Math.max(0, Number(ms) || 0);
  if (v < MIN) return "ไม่ถึงนาที";
  if (v < HOUR) return `${Math.floor(v / MIN)}${NBSP}นาที`;
  if (v < 48 * HOUR) return `${Math.floor(v / HOUR)}${NBSP}ชม.`;
  return `${Math.floor(v / DAY)}${NBSP}วัน`;
}

// 3 พ.ย. 2026 ไม้ต่อจากลูกแพร (src/relayBaton.mjs): สถานะตามเวลาทำการหลังลูกแพรคุยจบ — จันทร์–เสาร์ 09:00–18:00
// ontrack ยังไม่ถึง 3 ชม. · due 3–6 ชม. · overdue เกิน 6 ชม. (เส้นตาย) · ไม่มีสถานะ = แถวจากเซิร์ฟเวอร์รุ่นเก่า
export const RELAY_TONE = { overdue: "urgent", due: "warn", ontrack: "calm" };
export function relayStatusLabel(status, workElapsedMs) {
  const span = spanLabel(workElapsedMs);
  if (status === "overdue") return `เกินเวลาแล้ว · ${span}`;
  if (status === "due") return `ควรต่อแล้ว · ${span}`;
  if (status === "ontrack") return `ยังทัน · ${span}`;
  return "";
}

/**
 * ห้องถัดไปหลังจัดการห้องปัจจุบันเสร็จ — บริสุทธิ์
 * order   = ลำดับคิวก่อนกด (ที่คนเห็นอยู่) · fresh = ลำดับคิวล่าสุดจากเซิร์ฟเวอร์ (ห้องที่ตอบแล้วหลุดไปแล้ว)
 * ไปห้องที่อยู่ "ถัดลงไป" จากห้องเดิมที่ยังรอตอบอยู่ · ถึงท้ายคิวแล้ว = วนกลับห้องบนสุด · ไม่เหลือ = null
 */
export function nextWaitingId({ order = [], fresh = order, currentId = "" } = {}) {
  const current = String(currentId || "");
  const still = (Array.isArray(fresh) ? fresh : []).map(String).filter((id) => id && id !== current);
  if (!still.length) return null;
  const alive = new Set(still);
  const before = (Array.isArray(order) ? order : []).map(String);
  const at = before.indexOf(current);
  if (at >= 0) {
    for (let i = at + 1; i < before.length; i += 1) if (alive.has(before[i])) return before[i];
  }
  return still[0];
}

// ค่า `by` ที่มีสีของตัวเอง (ตรงกับ src/aiOffActor.mjs) — ค่าอื่น/ไม่มี = เทา "unknown" ไม่เดาสี
// 5 ต.ค. 2026 (คำสั่งพี่ง้วง "icon สีเหลือง ประมาณว่า AI off (not qualify)"): "qualify" = ตัวกวาดรายชั่วโมงปิด
// เพราะยังไม่เข้าเกณฑ์ลูกค้า — สีเหลืองของตัวเอง (token --qualify*) ไม่ปน "AI พัก"/"กำลังพิจารณา" ที่เป็นเหลืองอำพัน
export const AI_OFF_QUALIFY_BY = "qualify";
const AI_OFF_BY_COLORS = new Set(["human", "system", AI_OFF_QUALIFY_BY]);

/** คลาสสีของสถานะ AI ปิด (by-human/by-system/by-qualify/by-unknown) — ใช้ทุกที่ที่โชว์สถานะ ไม่ให้สีหลุดกันคนละจุด */
export function aiOffBy(info) {
  return AI_OFF_BY_COLORS.has(info?.by) ? info.by : "unknown";
}

/** ห้องนี้ AI ปิดเพราะตัวกวาดคัดกรองว่ายังไม่เข้าเกณฑ์หรือไม่ (ป้ายเหลือง) */
export function isNotQualifiedOff(info) {
  return aiOffBy(info) === AI_OFF_QUALIFY_BY;
}

/**
 * บรรทัดเหตุบนแถบคิวใต้หัวห้อง — ห้องเหลืองขึ้นชื่อป้ายนำหน้า ("AI off (not qualify) — เหตุ") ให้ตรงกับป้ายบนแถว
 * ห้องอื่นใช้ถ้อยคำเดิม "AI ปิดเพราะ: เหตุ" · ไม่มีเหตุ = null
 */
export function aiOffWhyText(info) {
  if (!info?.reasonText) return null;
  return isNotQualifiedOff(info) ? `${info.label} — ${info.reasonText}` : `AI ปิดเพราะ: ${info.reasonText}`;
}

/** ป้าย "AI ปิดเพราะใคร" — info มาจากเซิร์ฟเวอร์ (src/aiOffActor.mjs) · null = AI เปิด */
export function aiOffBadge(info, { withReason = false } = {}) {
  if (!info) return null;
  const by = aiOffBy(info);
  return el("span", {
    class: `badge ai-off-badge by-${by}`,
    title: info.reasonText ? `${info.label} — ${info.reasonText}` : info.label,
  }, info.label, withReason && info.reasonText ? el("span", { class: "ai-off-why" }, ` · ${info.reasonText}`) : null);
}

/** เหตุที่ AI ปิด เป็นตัวหนังสือจาง ๆ ต่อท้ายป้าย — มือถือไม่มี tooltip คิวรอตอบจึงต้องเห็นเหตุบนแถวเลย */
export function aiOffReason(info) {
  if (!info?.reasonText) return null;
  return el("span", { class: `ai-off-reason by-${aiOffBy(info)}` }, info.reasonText);
}

/** สถานะ AI ของห้องในคิวรอตอบ: ปิด (โดยคน/ระบบ) · พัก · เปิด — withReason = ต่อท้ายด้วยเหตุที่ปิด */
export function aiStateBadge({ aiOff = null, aiOn = true, aiPaused = false } = {}, { withReason = false } = {}) {
  if (aiOff) return withReason ? [aiOffBadge(aiOff), aiOffReason(aiOff)] : aiOffBadge(aiOff);
  if (!aiOn) return null;
  return aiPaused
    ? el("span", { class: "badge ai-on-badge is-paused", title: "AI พักชั่วคราว — มีคนเพิ่งตอบในห้องนี้" }, "AI พัก")
    : el("span", { class: "badge ai-on-badge", title: "AI เปิดอยู่ แต่ยังไม่มีคำตอบหลังข้อความล่าสุดของลูกค้า" }, "AI เปิด");
}

// Facebook: คอนโซลส่งแบบ RESPONSE ได้ภายใน 24 ชม. หลังข้อความล่าสุดของลูกค้าเท่านั้น
export const FB_CLOSED_TEXT = "FB เกิน 24 ชม. — ตอบใน Business Suite";
// 28 ก.ย. 2026 (พี่ง้วง): รู้ลิงก์ห้องใน Business Suite = ป้ายกดเปิดห้องนั้นได้เลย (แท็บใหม่)
export function fbClosedBadge(businessSuiteUrl = "") {
  const title = "ลูกค้าทักมาเกิน 24 ชม. แล้ว คอนโซลส่งข้อความหาเขาไม่ได้ — คนตอบได้ใน Meta Business Suite ภายใน 7 วัน";
  const url = /^https:\/\/business\.facebook\.com\//u.test(String(businessSuiteUrl || "")) ? String(businessSuiteUrl) : "";
  return url
    ? el("a", { class: "badge badge-fb-closed is-link", href: url, target: "_blank", rel: "noopener noreferrer", title: `${title} · กดเพื่อเปิดห้องนี้ใน Business Suite` }, `${FB_CLOSED_TEXT} ↗`)
    : el("span", { class: "badge badge-fb-closed", title }, FB_CLOSED_TEXT);
}

const VALUE_CHIP = { money: ["เรื่องเงิน", "is-money"], hot: ["สนใจสูง", "is-hot"], warm: ["กำลังพิจารณา", "is-warm"] };
export function valueBadge(value, score = null) {
  const chip = VALUE_CHIP[value];
  if (!chip) return null;
  return el("span", { class: `badge value-badge ${chip[1]}` }, value === "money" ? chip[0] : `${chip[0]} ${score ?? ""}`.trim());
}

/* -------------------------------- กล่องยืนยันสแปม -------------------------------- */

// <dialog> ของจริง (ไม่ใช่ window.confirm) — บอกให้ครบว่ากดแล้วเกิดอะไร และกดผิดคืนได้ที่ไหน
// เบราว์เซอร์ที่ไม่มี showModal (หรือ DOM จำลองในเทสต์) ใช้ window.confirm แทน
export function confirmSpam({ name = "" } = {}) {
  const doc = globalThis.document;
  return new Promise((resolve) => {
    const title = `ย้าย ${name || "ห้องนี้"} ไปสแปม?`;
    let settled = false;
    let dialog = null;
    // กดย้อนกลับ/เปลี่ยนหน้าระหว่างกล่องเปิดอยู่ = ยกเลิก (กล่องอยู่นอก #app จะค้างทับหน้าใหม่)
    const onHash = () => done(false);
    const done = (value) => {
      if (settled) return;
      settled = true;
      globalThis.window?.removeEventListener?.("hashchange", onHash);
      try { dialog?.close?.(); } catch { /* ปิดไม่ได้ก็ถอดทิ้ง */ }
      dialog?.remove?.();
      resolve(value);
    };
    globalThis.window?.addEventListener?.("hashchange", onHash);
    const cancel = el("button", { type: "button", class: "btn btn-outline", onclick: () => done(false) }, "ยกเลิก");
    const confirm = el("button", { type: "button", class: "btn btn-spam-confirm", onclick: () => done(true) }, "ย้ายไปสแปม");
    dialog = el("dialog", {
      class: "spam-dialog", "aria-labelledby": "spam-dialog-title",
      oncancel: (event) => { event.preventDefault?.(); done(false); },
    },
      el("h2", { id: "spam-dialog-title", class: "spam-dialog-title" }, title),
      el("ul", { class: "spam-dialog-list" },
        el("li", {}, "AI ปิดทันที (โดยคน) และไม่ทักตามอีก"),
        el("li", {}, "ห้องหายจากทุกรายการในหน้าแชทและหน้าภาพรวม ไม่นับในตัวเลข และไม่แจ้งเตือนทีม"),
        el("li", {}, "ดูย้อนหลังได้ที่ชิป \"สแปม\" · กด \"ไม่ใช่สแปม\" เพื่อคืนห้องได้ทุกเมื่อ"),
      ),
      el("p", { class: "spam-dialog-note" }, "ติดป้าย null ให้ห้องนี้ — กติกาเดียวกับป้ายในแผงข้อมูลลูกค้า"),
      el("div", { class: "spam-dialog-actions" }, cancel, confirm),
    );
    doc.body.append(dialog);
    if (typeof dialog.showModal === "function") {
      try {
        dialog.showModal();
        cancel.focus?.();
        return;
      } catch { /* ตกไปใช้ confirm ด้านล่าง */ }
    }
    done(globalThis.window?.confirm?.(`${title}\nAI จะปิดและห้องจะหายจากทุกคิว — คืนได้ที่ชิปสแปม`) === true);
  });
}

/* ------------------------------ คำสั่ง: เสร็จสิ้น / สแปม ------------------------------ */

/** ปิดเคส (✓ เสร็จสิ้น) — คืน true เมื่อสำเร็จ */
export async function resolveRoom({ api, toast, customerId }) {
  try {
    await api(`/console/api/customers/${encodeURIComponent(customerId)}/resolve`, { method: "POST", body: { resolved: true } });
    return true;
  } catch (err) {
    toast?.(err.message);
    return false;
  }
}

/** ติด/ถอนสแปม — ติดต้องยืนยันก่อนเสมอ · คืน true เมื่อสำเร็จ */
export async function setSpam({ api, toast, customerId, name = "", spam = true, confirmFn = confirmSpam }) {
  if (spam && !(await confirmFn({ name }))) return false;
  try {
    const res = await api(`/console/api/customers/${encodeURIComponent(customerId)}/spam`, { method: "POST", body: { spam } });
    if (spam) toast?.(`ย้าย ${name || "ห้องนี้"} ไปสแปมแล้ว — AI ปิด ไม่ทักตาม ดูได้ที่ชิปสแปม`);
    else {
      toast?.(res?.aiEnabled
        ? `คืน ${name || "ห้องนี้"} จากสแปมแล้ว`
        : `คืน ${name || "ห้องนี้"} จากสแปมแล้ว — AI ยังปิดอยู่ กดเปิดในห้องแชทเองถ้าจะให้ลูกแพรตอบ`);
    }
    return true;
  } catch (err) {
    toast?.(err.message);
    return false;
  }
}

/**
 * ปุ่มลัดบนแถวคิว: ✓ เสร็จสิ้น + สแปม (หรือ "ไม่ใช่สแปม" ในคิวสแปม) — onDone() หลังสำเร็จ
 * ปุ่มอยู่นอกลิงก์ของแถวเสมอ (ปุ่มในลิงก์ = HTML ผิด และกดแล้วพาเข้าห้องแทน)
 */
export function rowQuickActions({ api, toast, room, spamQueue = false, onDone = () => {} }) {
  const name = String(room?.name || "");
  let busy = false;
  const run = (fn) => async (event) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (busy) return;
    busy = true;
    try {
      if (await fn()) await onDone();
    } finally {
      busy = false;
    }
  };
  if (spamQueue) {
    return el("div", { class: "row-actions" },
      el("button", {
        type: "button", class: "row-act is-unspam", title: `คืน ${name} จากสแปม`, "aria-label": `ไม่ใช่สแปม: ${name}`,
        onclick: run(() => setSpam({ api, toast, customerId: room.id, name, spam: false })),
      }, "↩ ไม่ใช่สแปม"),
    );
  }
  return el("div", { class: "row-actions" },
    el("button", {
      type: "button", class: "row-act is-done", title: `ปิดเคส ${name} ว่าเสร็จสิ้น`, "aria-label": `เสร็จสิ้น: ${name}`,
      onclick: run(async () => {
        const ok = await resolveRoom({ api, toast, customerId: room.id });
        if (ok) toast?.(`ปิดเคส ${name} แล้ว — ลูกค้าทักมาใหม่เมื่อไหร่จะกลับเข้าคิวเอง`);
        return ok;
      }),
    }, "✓ เสร็จสิ้น"),
    el("button", {
      type: "button", class: "row-act is-spam", title: `ย้าย ${name} ไปสแปม`, "aria-label": `สแปม: ${name}`,
      onclick: run(() => setSpam({ api, toast, customerId: room.id, name, spam: true })),
    }, "สแปม"),
  );
}
