// training.mjs — owner-only review queue for reset-created training candidates.
// A confirmation is deliberately not a model/knowledge activation action.
import { el, timeAgo } from "./dom.mjs";
import { emptyArt } from "./ui.mjs";

function formatTime(value) {
  if (!value) return "—";
  try { return new Date(value).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" }); } catch { return "—"; }
}

function ackLabel(status) {
  if (status === "sent") return { className: "training-ack-ok", text: "แจ้งผู้ฝึกแล้ว" };
  if (status === "failed") return { className: "training-ack-warn", text: "ส่งข้อความยืนยันไม่สำเร็จ" };
  if (status === "ambiguous") return { className: "training-ack-warn", text: "ผลส่งข้อความยืนยันไม่ชัดเจน — ห้ามส่งซ้ำอัตโนมัติ" };
  return { className: "training-ack-pending", text: "รอส่งข้อความยืนยัน" };
}

export function createTrainingReviewPage({ api, toast, mount, pageHeader, tabBar, stopPolling, setView }) {
  async function decide(id, action, buttonSet) {
    buttonSet.forEach((button) => { button.disabled = true; });
    try {
      await api(`/console/api/training-candidates/${encodeURIComponent(id)}/decide`, { method: "POST", body: { action } });
      toast(action === "approve" ? "ยืนยันเพื่อวิเคราะห์แล้ว — ยังไม่ถูกนำไปใช้กับสมอง" : "ปัดตกชุดบทสนทนาแล้ว");
      await render();
    } catch (err) {
      toast(err.message);
      buttonSet.forEach((button) => { button.disabled = false; });
    }
  }

  async function resolveAck(id, button) {
    button.disabled = true;
    try {
      await api(`/console/api/training-candidates/${encodeURIComponent(id)}/ack/resolve`, {
        method: "POST", body: { action: "resolve_without_send" },
      });
      toast("ปิดสถานะ ACK แล้ว — ไม่มีการส่งข้อความซ้ำ");
      await render();
    } catch (err) {
      toast(err.message);
      button.disabled = false;
    }
  }

  function card(row) {
    const ack = ackLabel(row.ack_status);
    const ackResolved = row.ack_resolved === true;
    const reviewPending = row.status === "pending_owner_confirmation";
    const approve = el("button", { class: "btn btn-primary", type: "button" }, "ยืนยันเพื่อวิเคราะห์");
    const reject = el("button", { class: "btn btn-danger", type: "button" }, "ปัดตก");
    approve.addEventListener("click", () => decide(row.id, "approve", [approve, reject]));
    reject.addEventListener("click", () => decide(row.id, "reject", [approve, reject]));
    const resolveAckButton = el("button", { class: "btn", type: "button" }, "ปิด ACK โดยไม่ส่งซ้ำ");
    resolveAckButton.addEventListener("click", () => resolveAck(row.id, resolveAckButton));
    const detail = el("details", { class: "training-detail" },
      el("summary", {}, "ดูบทสนทนา"),
      el("p", { class: "training-detail-loading" }, "กำลังโหลดบทสนทนา…"),
    );
    detail.addEventListener("toggle", async () => {
      if (!detail.open || detail.dataset.loaded === "1") return;
      try {
        const data = await api(`/console/api/training-candidates/${encodeURIComponent(row.id)}`);
        const turns = data.candidate?.transcript || [];
        detail.replaceChildren(
          el("summary", {}, "ดูบทสนทนา"),
          el("div", { class: "training-transcript" }, turns.length
            ? turns.map((turn) => el("p", { class: `training-turn training-turn-${turn.direction}` },
                el("span", { class: "training-turn-label" }, turn.direction === "in" ? "ลูกค้า" : "ลูกแพร"),
                el("span", { class: "training-turn-text" }, turn.content),
              ))
            : el("p", { class: "empty-sub" }, "ไม่มีข้อความตัวอักษรใน session นี้"),
        ));
        detail.dataset.loaded = "1";
      } catch (err) {
        detail.replaceChildren(el("summary", {}, "ดูบทสนทนา"), el("p", { class: "training-detail-error" }, err.message));
      }
    });
    return el("article", { class: "training-card" },
      el("div", { class: "training-card-head" },
        el("strong", {}, reviewPending ? "รอเจ้าของยืนยัน" : row.status === "approved" ? "ยืนยันเพื่อวิเคราะห์แล้ว" : "ปัดตกแล้ว"),
        el("time", { title: formatTime(row.created_at) }, timeAgo(row.created_at)),
      ),
      el("p", { class: "training-meta" }, `${row.message_count || 0} ข้อความ · เก็บจากคำสั่ง /reset · หมดอายุ ${formatTime(row.expires_at)}`),
      el("p", { class: `training-ack ${ackResolved ? "training-ack-ok" : ack.className}` },
        ackResolved ? "เจ้าของปิดสถานะ ACK แล้ว — ไม่มีการส่งข้อความซ้ำ" : ack.text,
      ),
      row.ack_resolution_available === true
        ? el("div", { class: "training-ack-actions" }, resolveAckButton)
        : null,
      detail,
      reviewPending ? el("div", { class: "training-actions" }, reject, approve) : null,
    );
  }

  async function render() {
    stopPolling();
    const data = await api("/console/api/training-candidates?status=all");
    // Keep review-pending rows visible, plus decided rows whose ACK still needs
    // owner resolution. Clean decided rows do not clutter the working queue.
    const rows = (data.candidates || []).filter((row) =>
      row.status === "pending_owner_confirmation" || (row.ack_status !== "sent" && row.ack_resolved !== true));
    mount(
      pageHeader("คิวเทรนนิ่ง"),
      el("main", { class: "page-scroll" },
        el("div", { class: "page-inner training-list" },
          el("section", { class: "training-notice" },
            el("strong", {}, "รอเจ้าของยืนยัน"),
            el("p", {}, "กดยืนยันแล้วจะเป็นชุดข้อมูลสำหรับวิเคราะห์เท่านั้น ยังไม่เปลี่ยน Persona, Brain หรือ Knowledge จนกว่าจะมีขั้น promote แยกค่ะ"),
          ),
          rows.length ? rows.map(card) : el("div", { class: "empty-state" },
            emptyArt(),
            el("p", { class: "empty-title" }, "ไม่มีบทสนทนารอการยืนยัน"),
            el("p", { class: "empty-sub" }, "เมื่อผู้ฝึกพิมพ์ /reset ชุดบทสนทนาจะมาอยู่ที่นี่"),
          ),
        ),
      ),
      tabBar(),
    );
    setView("page");
  }
  return render;
}
