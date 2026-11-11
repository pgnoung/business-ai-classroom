// publishQueue.mjs — แผง "คำขออนุมัติเผยแพร่" (Package K, คำสั่งพี่ง้วง 2 ก.ย. 2026)
//
// แผงเดียวใช้สองมุมมอง โดยตั้งใจ:
//   เจ้าของ (publish.approve) = เห็นคำขอทั้งร้าน กดอนุมัติ/ปฏิเสธได้
//   ทีมงาน                    = เห็นเฉพาะคำขอของตัวเอง อ่านอย่างเดียว
// ทำแผงเดียวเพราะสิ่งที่ทีมงานต้องรู้คือ "คำขอที่ส่งไปยังค้างอยู่ไหม" ซึ่งเป็นข้อมูล
// ชุดเดียวกับที่เจ้าของเห็น ต่างแค่กรองและปุ่ม — ฝั่งเซิร์ฟเวอร์กรองให้แล้วอีกชั้น
//
// ด่านจริงอยู่ฝั่งเซิร์ฟเวอร์เสมอ (consolePublishQueueApi.mjs) ตรงนี้แค่ไม่วาดปุ่ม
// ที่กดแล้วเด้ง 403
import { el, timeAgo } from "./dom.mjs";

export const PUBLISH_SUBMIT_LABEL = "ส่งให้พี่ง้วงอนุมัติ";
export const PUBLISH_SUBMIT_TOAST = "ส่งให้พี่ง้วงอนุมัติแล้ว";

// ป้ายปุ่ม: คนที่เผยแพร่เองได้เห็นคำเดิม · คนที่ต้องขออนุมัติเห็นว่ากดแล้วจะเกิดอะไร
// (ปุ่มที่เขียนว่า "บันทึก" แต่จริง ๆ ส่งคำขอ = คนกดคิดว่าบันทึกแล้วแล้วเดินจากไป)
export function publishLabel(canPublish, ownerLabel, requestLabel = PUBLISH_SUBMIT_LABEL) {
  return canPublish ? ownerLabel : requestLabel;
}

// ข้อความ toast หลังยิงสำเร็จ — เซิร์ฟเวอร์เป็นคนบอกว่าเกิดอะไรขึ้นจริง
// หน้าเว็บห้ามเดาเอง (สิทธิ์อาจเปลี่ยนระหว่างที่หน้าเปิดค้างอยู่ และเฟส 1b เพิ่มผลลัพธ์ใหม่)
//
// เหตุผลที่ต้องอ่าน result.brain: เฟส 1b มีผลลัพธ์ที่ "ตอบ 200 แต่ของยังไม่ถึงลูกค้า"
// (รุ่นทดลอง / รอเจ้าของรับทราบ) — ถ้ายังพูดว่า "AI จะใช้ตอบตั้งแต่ข้อความถัดไป" เหมือนเดิม
// คนกดจะเดินจากไปโดยเชื่อว่าเสร็จแล้ว ทั้งที่ไม่มีอะไรเปลี่ยนและไม่มีใครถูกบอก
export const BRAIN_OUTCOME_TOAST = Object.freeze({
  canary: "ส่งเป็นรุ่นทดลองแล้ว รอพี่ง้วงกดใช้",
  needs_ack: "ส่งให้พี่ง้วงรับทราบแล้ว — ยังไม่มีผลกับลูกแพรจนกว่าจะกดรับทราบ",
});

export function publishToast(result, okMessage) {
  if (result?.queued === true) return result.message || PUBLISH_SUBMIT_TOAST;
  const outcome = result?.brain?.outcome;
  if (outcome && BRAIN_OUTCOME_TOAST[outcome]) return BRAIN_OUTCOME_TOAST[outcome];
  return okMessage;
}

export function publishQueueHint() {
  return el("p", { class: "block-hint publish-request-hint" },
    "แก้ได้ตามปกติ — กดแล้วระบบจะส่งเป็นคำขอให้พี่ง้วงกดอนุมัติ ยังไม่มีผลกับลูกแพรจนกว่าจะอนุมัติ");
}

const STATUS_META = {
  pending: { label: "รออนุมัติ", tone: "badge-orange" },
  // เฟส 1b: อนุมัติแล้วแต่สมองยังมีข้อค้าง — คนเสนอไม่ต้องทำอะไรต่อ เจ้าของต้องไปกดรับทราบ
  pending_ack: { label: "รอพี่ง้วงรับทราบรุ่นสมอง", tone: "badge-orange" },
  approved: { label: "อนุมัติแล้ว", tone: "badge-green" },
  rejected: { label: "ปฏิเสธ", tone: "badge-gray" },
  failed: { label: "ทำรายการไม่สำเร็จ", tone: "badge-red" },
};

/* ---------------------- K2: ผลการตัดสินล่าสุด (2 ก.ย. 2026) ----------------------
   ช่องโหว่ที่ปิด: ใบที่เล่นซ้ำแล้วล้ม (failed) หรือถูกปฏิเสธ จะหลุดจากรายการ "รออนุมัติ"
   ทันที คนเสนอเห็นแค่ว่าคำขอหายไป ไม่เคยรู้ว่าไม่ผ่านเพราะอะไร แล้วก็ไม่ส่งใหม่
   -> ของที่พี่ง้วงตั้งใจให้เข้าสมองลูกแพร ค้างอยู่ที่ความเข้าใจผิดของคนสองคน
   เหตุผลอยู่ใน decision_note อยู่แล้วตั้งแต่ Package K — ที่ขาดคือทางกลับมาถึงตา */
export const PUBLISH_DECIDED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const PUBLISH_DECIDED_MAX = 20;
export const PUBLISH_FAILED_RETRY_HINT = "แก้แล้วส่งใหม่ได้จากหน้าเดิม";

// คำนำหน้าเหตุผล — เขียนให้อ่านรู้เรื่องโดยไม่ต้องรู้ว่าระบบเรียกสถานะนี้ว่าอะไร
// อนุมัติแล้วไม่ต้องมีคำนำหน้า (หมายเหตุของเจ้าของเป็นคำชม/บริบท ไม่ใช่คำอธิบายความล้ม)
const DECISION_NOTE_LEAD = {
  rejected: "เหตุผลที่ปฏิเสธ",
  failed: "สาเหตุที่ทำไม่สำเร็จ",
  pending_ack: "ค้างอยู่ที่",
};

function bodyPreview(body) {
  try {
    const text = JSON.stringify(body ?? {}, null, 2);
    return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
  } catch {
    return "(อ่านรายละเอียดคำขอไม่ได้)";
  }
}

/* -------------------------------- การ์ดคำขอ -------------------------------- */

function requestCard(request, { api, toast, refresh, canApprove }) {
  const meta = STATUS_META[request.status] || { label: request.status, tone: "badge-gray" };

  async function decide(decision, note) {
    try {
      const result = await api(`/console/api/publish-requests/${encodeURIComponent(request.id)}/${decision}`, {
        method: "POST", body: note ? { note } : {},
      });
      // อนุมัติแล้ว "ทำไม่สำเร็จ" ต้องบอกเหตุผลตรง ๆ ไม่ใช่บอกว่าอนุมัติแล้วเฉย ๆ
      // (คำขอที่ข้อมูลไม่ผ่านด่านตรวจจะจบที่สถานะ failed — ของจริงไม่ได้เปลี่ยน)
      if (decision === "approve" && result?.applied !== true) {
        toast(`อนุมัติแล้วแต่ทำรายการไม่สำเร็จ: ${result?.error || "ไม่ทราบสาเหตุ"}`, "error");
      } else {
        toast(decision === "approve" ? "อนุมัติแล้ว — มีผลกับลูกแพรทันที" : "ปฏิเสธคำขอแล้ว");
      }
      await refresh();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  const noteInput = canApprove
    ? el("input", {
        class: "order-in keep-focus pq-note", type: "text", maxlength: "200",
        placeholder: "เหตุผล (ไม่บังคับ — จะถูกบันทึกไว้กับคำขอ)",
      })
    : null;

  return el("article", { class: "kn-card pq-card" },
    el("div", { class: "kn-head" },
      el("strong", { class: "kn-name" }, request.summary || request.kind),
      el("span", { class: `badge ${meta.tone}` }, meta.label),
    ),
    el("p", { class: "kn-meta pq-meta" },
      `โดย ${request.proposedBy || "—"} · ${timeAgo(request.createdAt)}`
      + `${request.decidedBy ? ` · ตัดสินโดย ${request.decidedBy}` : ""}`),
    el("details", { class: "pq-detail" },
      el("summary", {}, "ดูรายละเอียดที่จะถูกเปลี่ยน"),
      el("p", { class: "kn-meta" }, `${request.method} /console/api/${(request.route || []).join("/")}`),
      el("pre", { class: "kb-pre pq-pre" }, bodyPreview(request.body)),
    ),
    request.decisionNote ? el("p", { class: "kn-meta" }, `หมายเหตุ: ${request.decisionNote}`) : null,
    canApprove && request.status === "pending"
      ? el("div", { class: "block-actions pq-actions" },
          noteInput,
          el("button", {
            class: "btn btn-primary btn-mini",
            onclick: () => decide("approve", noteInput.value.trim()),
          }, "อนุมัติ"),
          el("button", {
            class: "btn btn-outline btn-mini",
            onclick: () => {
              if (!window.confirm(`ปฏิเสธคำขอ "${request.summary || request.kind}"?\n\nของเดิมจะไม่ถูกเปลี่ยนเลย`)) return;
              decide("reject", noteInput.value.trim());
            },
          }, "ปฏิเสธ"),
        )
      : null,
  );
}

/* ------------------------- การ์ดผลการตัดสิน (อ่านอย่างเดียว) ------------------------- */

// จงใจไม่ใช้ requestCard ตัวเดิม: การ์ดนี้ไม่มีปุ่ม ไม่มีช่องเหตุผล และหลักเวลาคือ
// "ตัดสินเมื่อไร" ไม่ใช่ "ขอมาเมื่อไร" — ยัดธงเข้าไปในการ์ดเดิมจะทำให้เส้นที่ยังมีปุ่ม
// อนุมัติจริงอ่านยากขึ้นโดยไม่ได้อะไรกลับมา
function decidedCard(request) {
  const meta = STATUS_META[request.status] || { label: request.status, tone: "badge-gray" };
  const lead = DECISION_NOTE_LEAD[request.status];
  return el("article", { class: "kn-card pq-card pq-decided-card" },
    el("div", { class: "kn-head" },
      el("strong", { class: "kn-name" }, request.summary || request.kind),
      el("span", { class: `badge ${meta.tone}` }, meta.label),
    ),
    el("p", { class: "kn-meta pq-meta" },
      `${request.proposedBy ? `โดย ${request.proposedBy} · ` : ""}`
      + `ตัดสินโดย ${request.decidedBy || "—"} · ${timeAgo(request.decidedAt || request.createdAt)}`),
    lead && request.decisionNote
      ? el("p", { class: "kn-meta pq-decision-note" }, `${lead}: ${request.decisionNote}`)
      : null,
    // ทางออกที่ไม่ต้องมีปุ่ม: ของเดิมยังอยู่ในหน้าที่กรอกมาแต่แรก แก้แล้วกดส่งใหม่ได้เลย
    request.status === "failed"
      ? el("p", { class: "kn-meta pq-retry-hint" }, PUBLISH_FAILED_RETRY_HINT)
      : null,
  );
}

// ยุบไว้เป็นค่าเริ่มต้น (ไม่มี attribute open) — ของที่ "ยังต้องตัดสิน" ต้องมาก่อนประวัติเสมอ
function decidedSection(requests) {
  if (!requests.length) return null;
  return el("details", { class: "pq-detail pq-decided" },
    el("summary", {}, `ผลการตัดสินล่าสุด (${requests.length})`),
    el("p", { class: "block-hint" },
      "คำขอที่ตัดสินไปแล้วใน 7 วันหลังสุด — ใบที่ทำรายการไม่สำเร็จจะบอกสาเหตุไว้ด้วย"),
    el("div", { class: "kn-list pq-list pq-decided-list" }, requests.map(decidedCard)),
  );
}

/* --------------------------------- แผงรวม --------------------------------- */

// คืน null = ไม่ต้องวาดอะไร (ทีมงานที่ยังไม่เคยส่งคำขอ ไม่ต้องมีกล่องว่างเกะกะ)
export async function publishQueueBlock({ api, toast, refresh, now = Date.now() }) {
  const since = Math.max(0, now - PUBLISH_DECIDED_WINDOW_MS);
  // ยิงคู่กันไปเลย — แผงเดียวกัน รอทีละเส้นคือทำให้หน้าตั้งค่าช้าขึ้นฟรี ๆ
  // แยก catch กันคนละใบ: ประวัติโหลดไม่ได้ต้องไม่ทำให้คิวที่ยังค้างหายไปด้วย
  const [data, decidedData] = await Promise.all([
    api("/console/api/publish-requests?status=pending").catch(() => null),
    api(`/console/api/publish-requests?status=decided&since=${since}&limit=${PUBLISH_DECIDED_MAX}`)
      .catch(() => null),
  ]);
  if (!data) return null; // โหลดคิวไม่ได้ = ไม่ลากหน้าตั้งค่าทั้งหน้าให้ล้ม
  const canApprove = data?.canApprove === true;
  const requests = Array.isArray(data?.requests) ? data.requests : [];
  // เซิร์ฟเวอร์กรองเจ้าของคำขอให้แล้ว (ทีมงานได้เฉพาะของตัวเอง) — ที่นี่แค่ตัดความยาว
  const decided = Array.isArray(decidedData?.requests)
    ? decidedData.requests.slice(0, PUBLISH_DECIDED_MAX)
    : [];
  if (!canApprove && requests.length === 0 && decided.length === 0) return null;

  return el("section", { class: "block pq-block" },
    el("h2", { class: "block-title" },
      canApprove ? "คำขอรออนุมัติ" : "คำขอของฉันที่รออนุมัติ",
      requests.length ? el("span", { class: "badge badge-orange pq-count" }, String(requests.length)) : null,
    ),
    el("p", { class: "block-hint" },
      canApprove
        ? "ของที่ทีมงานเสนอให้เปลี่ยนในสมองลูกแพร — อนุมัติแล้วระบบจะลงมือทำให้ทันทีด้วยชื่อของพี่ง้วง"
        : "ส่งไปแล้ว รอพี่ง้วงกดอนุมัติ — ยังไม่มีผลกับลูกแพรจนกว่าจะอนุมัติ"),
    requests.length
      ? el("div", { class: "kn-list pq-list" },
          requests.map((request) => requestCard(request, { api, toast, refresh, canApprove })))
      : el("p", { class: "kb-empty" }, "ยังไม่มีคำขอรออนุมัติ"),
    decidedSection(decided),
  );
}
