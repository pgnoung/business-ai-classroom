// lessons.mjs — หน้า "บทเรียน" (#/lessons): บทเรียนที่สอนลูกแพรจากแผง "ทำไมตอบแบบนี้"
//
// คำสั่งพี่ง้วง 2026-09-28 — ที่เดียวที่เห็นว่าสอนอะไรไว้บ้าง ลูกแพรหยิบไปใช้กี่ครั้ง แก้/ปิด/ลบได้
// และอนุมัติบทเรียนที่ทีมส่งมา ด่านจริงอยู่ฝั่งเซิร์ฟเวอร์ (consoleLessonsApi.mjs) ตรงนี้แค่ไม่วาด
// ปุ่มที่กดแล้วเด้ง 403 — ทีมงานเห็นบทเรียนที่ใช้อยู่ + ของตัวเองที่ส่งไป
// หน้านี้ไม่ poll — เจ้าของอาจกำลังแก้ข้อความ ห้าม re-render ทับ
import { el, timeAgo } from "./dom.mjs";

const STATUS = {
  active: { label: "ใช้อยู่", badge: "badge-green" },
  pending: { label: "รออนุมัติ", badge: "badge-orange" },
  disabled: { label: "ปิดไว้", badge: "badge-gray" },
};
const FILTERS = [["", "ทั้งหมด", "all"], ["active", "ใช้อยู่", "active"], ["pending", "รออนุมัติ", "pending"], ["disabled", "ปิดไว้", "disabled"]];

export function createLessonsPage({ api, toast, mount, pageHeader, tabBar, stopPolling, setView }) {
  const view = { status: "", q: "", rows: [], data: null, editing: null };

  async function load({ append = false } = {}) {
    const params = new URLSearchParams();
    if (view.status) params.set("status", view.status);
    if (view.q) params.set("q", view.q);
    if (append) params.set("offset", String(view.rows.length));
    const query = params.toString(); // ไม่ใช้ params.size — Safari บน iPhone รุ่นเก่ายังไม่มี
    const data = await api(`/console/api/lessons${query ? `?${query}` : ""}`);
    view.data = data;
    view.rows = append ? [...view.rows, ...(data.lessons ?? [])] : (data.lessons ?? []);
  }

  async function render({ reload = true, append = false } = {}) {
    stopPolling();
    if (reload) await load({ append });
    const data = view.data ?? {};
    mount(
      pageHeader("บทเรียน"),
      el("main", { class: "page-scroll" },
        el("div", { class: "page-inner lessons-page" },
          intro(data),
          pauseCard(data),
          filterRow(data.counts ?? {}),
          searchRow(),
          view.rows.length ? el("div", { class: "lessons-list" }, view.rows.map((row) => lessonCard(row, data))) : emptyState(),
          data.hasMore
            ? el("button", { class: "btn btn-outline btn-block lessons-more", type: "button", onclick: () => run(() => render({ append: true })) }, "ดูเพิ่ม")
            : null,
        ),
      ),
      tabBar(),
    );
    setView("page");
  }

  // ทุกปุ่มผ่านตัวนี้: error ขึ้น toast แทนการทำให้ทั้งหน้าพัง
  // task คืนข้อความได้ (เช่นคำเตือนตอนบันทึกบทเรียนที่มีโค้ดสั่งโมเดล) — แทนข้อความสำเร็จปกติ
  async function run(task, doneMessage = "") {
    try {
      const override = await task();
      const message = typeof override === "string" && override ? override : doneMessage;
      if (message) toast(message);
    } catch (err) {
      toast(err.message || "ทำรายการไม่สำเร็จ");
    }
  }

  function intro(data) {
    return el("section", { class: "lessons-intro" },
      el("h2", { class: "lessons-heading" }, "บทเรียนที่สอนลูกแพร"),
      el("p", {}, "สอนจากปุ่ม \"ทำไมตอบแบบนี้\" ใต้คำตอบของลูกแพรในห้องแชท — ตอนตอบลูกค้า ลูกแพรหยิบบทเรียนที่ใกล้เรื่องที่สุด 3 เรื่อง"
        + " กับเรื่องที่สอนล่าสุดไปใช้เอง เป็นแนวการตอบ ไม่ใช่ข้อความสำเร็จรูป"),
      el("p", { class: "lessons-note" }, "ราคา รอบเรียน และเงื่อนไขการชำระเงิน ลูกแพรยังยึดตารางและคลังความรู้เสมอ"
        + (data.canApprove ? "" : " · บทเรียนที่ทีมสอนจะเริ่มใช้หลังพี่ง้วงอนุมัติ")),
    );
  }

  function pauseCard(data) {
    if (!data.canApprove) {
      return data.paused ? el("p", { class: "lessons-paused-note", role: "status" }, "ตอนนี้พี่ง้วงหยุดใช้บทเรียนชั่วคราว") : null;
    }
    const toggle = el("button", {
      class: `btn btn-mini ${data.paused ? "btn-primary" : "btn-outline"} lessons-pause-toggle`, type: "button",
      onclick: () => run(async () => {
        toggle.disabled = true;
        await api("/console/api/lessons/pause", { method: "POST", body: { paused: !data.paused } });
        await render();
      }, data.paused ? "กลับมาใช้บทเรียนแล้ว" : "หยุดใช้บทเรียนชั่วคราวแล้ว"),
    }, data.paused ? "กลับมาใช้บทเรียน" : "หยุดใช้ชั่วคราว");
    return el("section", { class: `lessons-pause${data.paused ? " is-paused" : ""}` },
      el("div", {},
        el("strong", {}, data.paused ? "หยุดใช้บทเรียนอยู่" : "ลูกแพรใช้บทเรียนตอนตอบอยู่"),
        el("p", {}, data.paused
          ? "ลูกแพรตอบแบบไม่มีบทเรียนทุกห้อง จนกว่าจะกดกลับมาใช้ — บทเรียนไม่ได้หายไปไหน"
          : "ถ้าลูกแพรตอบแปลกหลังสอน กดหยุดได้ทันทีโดยไม่ต้องลบอะไร"),
      ),
      toggle,
    );
  }

  function filterRow(counts) {
    return el("nav", { class: "inbox-filters lessons-filters", "aria-label": "กรองสถานะบทเรียน" },
      FILTERS.map(([value, label, key]) => el("button", {
        class: `fchip fchip-branch${view.status === value ? " is-active" : ""}`, type: "button",
        ...(view.status === value ? { "aria-pressed": "true" } : { "aria-pressed": "false" }),
        onclick: () => run(async () => { view.status = value; await render(); }),
      }, label, el("span", { class: "fchip-count" }, String(counts[key] ?? 0)))),
    );
  }

  function searchRow() {
    const input = el("input", {
      class: "lessons-search-input keep-focus", type: "search", maxlength: "80", value: view.q,
      placeholder: "ค้นคำในบทเรียน เช่น ที่จอดรถ ราคา", "aria-label": "ค้นหาบทเรียน",
    });
    const go = () => run(async () => { view.q = input.value.trim(); await render(); });
    input.addEventListener("keydown", (event) => { if (event.key === "Enter") go(); });
    return el("div", { class: "lessons-search" }, input, el("button", { class: "btn btn-outline btn-mini", type: "button", onclick: go }, "ค้นหา"));
  }

  function emptyState() {
    return el("div", { class: "empty-state lessons-empty" },
      el("p", { class: "empty-title" }, view.q || view.status ? "ไม่พบบทเรียนที่ตรงกับตัวกรองนี้" : "ยังไม่มีบทเรียน"),
      el("p", { class: "empty-sub" }, "เปิดห้องแชท กด \"ทำไมตอบแบบนี้\" ใต้คำตอบของลูกแพร แล้วพิมพ์สอนได้เลย"),
    );
  }

  function channelLabel(data, channelId) {
    if (!channelId) return "ใช้ทุกช่องทาง";
    const channel = (data.channels ?? []).find((item) => item.id === channelId);
    return `เฉพาะ ${channel?.name || channelId}`;
  }

  function lessonCard(row, data) {
    if (view.editing === row.id) return editCard(row, data);
    const meta = STATUS[row.status] ?? STATUS.disabled;
    const mine = row.createdBy === data.username;
    return el("article", { class: `lesson-card is-${row.status}` },
      el("header", { class: "lesson-card-head" },
        el("strong", { class: "lesson-title" }, row.title),
        el("span", { class: `badge ${meta.badge}` }, meta.label),
      ),
      el("p", { class: "lesson-teaching" }, row.teaching),
      contextBlock(row),
      el("p", { class: "lesson-meta" },
        `สอนโดย ${row.createdByName || row.createdBy || "ทีมงาน"} · ${timeAgo(row.createdAt) || "—"} · ${channelLabel(data, row.channelId)}`,
        ` · ลูกแพรใช้แล้ว ${Number(row.useCount || 0).toLocaleString("th-TH")} ครั้ง`,
        row.lastUsedAt ? ` (ล่าสุด ${timeAgo(row.lastUsedAt)})` : "",
      ),
      actionsFor(row, data, mine),
    );
  }

  function contextBlock(row) {
    const hasContext = row.customerText || row.aiText;
    return el("details", { class: "lesson-context" },
      el("summary", {}, "ดูต้นเรื่อง"),
      hasContext
        ? [
            row.customerText ? el("p", {}, el("span", { class: "lesson-key" }, "ลูกค้าพูดว่า "), row.customerText) : null,
            row.aiText ? el("p", {}, el("span", { class: "lesson-key" }, "ลูกแพรเคยตอบ "), row.aiText) : null,
          ]
        : el("p", { class: "lesson-key" }, "ไม่มีข้อความต้นเรื่อง (ลูกค้าขอให้ลบข้อมูล หรือห้องถูกล้างประวัติแล้ว) — คำสอนยังใช้ได้ตามปกติ"),
      row.customerId
        ? el("a", { class: "lesson-room-link", href: `#/c/${encodeURIComponent(row.customerId)}` }, "เปิดห้องแชทต้นเรื่อง ›")
        : null,
    );
  }

  function actionsFor(row, data, mine) {
    const buttons = [];
    const act = (label, cls, task, done, confirmText = "") => buttons.push(el("button", {
      class: `btn btn-mini ${cls}`, type: "button",
      onclick: () => {
        if (confirmText && !window.confirm(confirmText)) return;
        run(async () => { await task(); await render(); }, done);
      },
    }, label));
    const post = (path, body = {}) => api(`/console/api/lessons/${encodeURIComponent(row.id)}${path}`, { method: "POST", body });
    const edit = () => buttons.push(el("button", {
      class: "btn btn-mini btn-ghost", type: "button",
      onclick: () => { view.editing = row.id; render({ reload: false }); },
    }, "แก้ไข"));
    if (data.canApprove) {
      if (row.status === "pending") {
        act("อนุมัติ", "btn-primary", () => post("/approve"), "อนุมัติแล้ว — ลูกแพรเริ่มใช้ตั้งแต่ข้อความถัดไป");
        act("ไม่อนุมัติ", "btn-danger", () => post("/decline"), "ไม่อนุมัติบทเรียนนี้แล้ว", "ไม่อนุมัติบทเรียนนี้? คำขอจะถูกลบ");
        edit();
      } else {
        edit();
        act(row.status === "active" ? "ปิดใช้" : "เปิดใช้", "btn-outline", () => post("/enable", { enabled: row.status !== "active" }),
          row.status === "active" ? "ปิดบทเรียนนี้แล้ว" : "เปิดใช้บทเรียนนี้แล้ว");
        act("ลบ", "btn-danger", () => api(`/console/api/lessons/${encodeURIComponent(row.id)}`, { method: "DELETE" }),
          "ลบบทเรียนแล้ว", "ลบบทเรียนนี้ถาวร? (ถ้าแค่อยากพักไว้ ให้กดปิดใช้แทน)");
      }
    } else if (mine && row.status === "pending") {
      edit();
      act("ถอนคำขอ", "btn-danger", () => api(`/console/api/lessons/${encodeURIComponent(row.id)}`, { method: "DELETE" }),
        "ถอนคำขอแล้ว", "ถอนบทเรียนที่ส่งให้พี่ง้วงอนุมัติ?");
    }
    return buttons.length ? el("div", { class: "lesson-actions" }, buttons) : null;
  }

  function editCard(row, data) {
    const topic = el("input", { class: "lesson-edit-topic keep-focus", type: "text", maxlength: String(data.limits?.topic || 60), value: row.topic, "aria-label": "หัวข้อบทเรียน", placeholder: "เรื่อง/หัวข้อ" });
    const teaching = el("textarea", { class: "lesson-edit-teaching keep-focus", rows: "4", maxlength: String(data.limits?.teaching || 600), "aria-label": "สิ่งที่สอน" });
    teaching.value = row.teaching;
    const channels = data.channels ?? [];
    const scope = data.canApprove && channels.length > 1
      ? el("select", { class: "lesson-edit-scope keep-focus", "aria-label": "ใช้กับช่องทางไหน" },
          el("option", { value: "" }, "ใช้ทุกช่องทาง"),
          channels.map((channel) => el("option", { value: channel.id }, `เฉพาะ ${channel.name}`)))
      : null;
    if (scope) scope.value = row.channelId || "";
    const save = el("button", {
      class: "btn btn-mini btn-primary", type: "button",
      onclick: () => run(async () => {
        save.disabled = true;
        const saved = await api(`/console/api/lessons/${encodeURIComponent(row.id)}`, {
          method: "POST",
          body: { topic: topic.value, teaching: teaching.value, ...(scope ? { channelId: scope.value || null } : {}) },
        }).catch((err) => { save.disabled = false; throw err; });
        view.editing = null;
        await render();
        return saved?.injectionWarning ? String(saved.message || "") : "";
      }, row.status === "active" ? "บันทึกแล้ว — ลูกแพรใช้ฉบับใหม่ตั้งแต่ข้อความถัดไป" : "บันทึกแล้ว"),
    }, "บันทึก");
    const cancel = el("button", {
      class: "btn btn-mini btn-ghost", type: "button",
      onclick: () => { view.editing = null; render({ reload: false }); },
    }, "ยกเลิก");
    return el("article", { class: `lesson-card is-${row.status} is-editing` },
      el("label", { class: "lesson-edit-label" }, "เรื่อง/หัวข้อ", topic),
      el("label", { class: "lesson-edit-label" }, "สิ่งที่สอน", teaching),
      scope ? el("label", { class: "lesson-edit-label" }, "ใช้กับ", scope) : null,
      el("div", { class: "lesson-actions" }, cancel, save),
    );
  }

  return () => render();
}
