// review.mjs — "กล่องตรวจ" (#/review): ของที่รอคนตัดสิน รวมอยู่หน้าเดียว
//
// ออกแบบสำหรับมือถือ 375 px ก่อนเสมอ (แบบแปลน §6): การ์ดซ้อนแนวตั้ง ปุ่มนิ้วโป้งเอื้อมถึง
// ไม่มีตารางแนวนอน ไม่มีอะไรที่ทำให้จอเลื่อนซ้ายขวา — ข้อความยาวตัดบรรทัดเสมอ
//
// สามปุ่มต่อแถว ไม่มีปุ่มที่สี่ (แบบแปลน §6 Step 4):
//   สอนลูกแพร   -> เปิดจอสอนโดยเติมข้อมูลให้แล้ว
//   ไม่ต้องสอน  -> ปิดเรื่องนี้พร้อมเหตุผล (เหตุผลลงคอลัมน์ reason ของคำแก้)
//   เปิดห้องแชท -> ไปดูบริบทเต็มในห้อง (กล่องนี้จงใจไม่ยกบทสนทนามาแสดง)
//
// สิ่งที่หน้านี้ "ไม่" ทำ: ไม่มีปุ่มเผยแพร่ตรง ๆ — ทุกการเปลี่ยนสมองต้องผ่านจอสอน
// ซึ่งวิ่งเข้าเส้นเขียนเดิมที่มีด่านครบ
import { el, timeAgo } from "./dom.mjs";
import { emptyArt } from "./ui.mjs";

const RISK_META = {
  red: { label: "ต้องให้พี่ง้วงตัดสิน", tone: "badge-red" },
  yellow: { label: "ควรดูก่อน", tone: "badge-orange" },
  green: { label: "แก้ได้เลย", tone: "badge-green" },
};

const SOURCE_META = {
  correction: { label: "คำแก้ของทีม", icon: "✍️" },
  guard_block: { label: "ตัวกรองกันไว้", icon: "🛡" },
  learning: { label: "ระบบเสนอ", icon: "🧠" },
  redaction: { label: "ลบตามคำขอลูกค้า", icon: "🔒" },
  lint: { label: "ของค้างในสมอง", icon: "⏰" },
};

// ตัวกรองบนหัวกล่อง — "ทั้งหมด" มาก่อนเสมอเพราะกล่องนี้มีไว้ให้กวาดให้หมด ไม่ใช่ให้ค้นหา
export const REVIEW_FILTERS = Object.freeze([
  { id: "all", label: "ทั้งหมด", match: () => true },
  { id: "mine", label: "คำแก้ที่ยังไม่ได้สอน", match: (row) => row.source === "correction" },
  { id: "red", label: "ต้องให้พี่ง้วงตัดสิน", match: (row) => row.risk === "red" },
  { id: "stale", label: "ของค้าง", match: (row) => row.source === "lint" || row.source === "redaction" },
]);

/**
 * ตัวนับบนชิป: ใช้ตัวเลขจากเซิร์ฟเวอร์ (นับจากของทั้งชุด) เสมอเมื่อมีมา
 * ตกกลับไปนับจากแถวที่โหลดมาเฉพาะตอนเซิร์ฟเวอร์ไม่ส่งมา — และเมื่อนั้นตัวเลขคือ
 * "เท่าที่เห็น" ซึ่งบรรทัด "แสดง N จาก M" ข้างบนบอกไว้แล้วว่ายังไม่ครบ
 */
export function reviewCounts(rows = [], counts = null) {
  return REVIEW_FILTERS.map((filter) => ({
    ...filter,
    count: Number.isFinite(Number(counts?.[filter.id]))
      ? Number(counts[filter.id])
      : rows.filter((row) => filter.match(row)).length,
  }));
}

/**
 * ตัดข้อความเป็นชิ้น ๆ แล้วครอบ "ช่วงที่ต่าง" ด้วย span เดียว
 *
 * ทำไม: เดิมร่างของบอทกับคำตอบของคนถูกตัดหัวที่ 240 ตัวเท่ากันทั้งคู่ ซึ่งบนของจริง 52%
 * ของคำแก้ต่างกันหลังตัวที่ 240 — คนตรวจจึงเห็นสองก้อนที่ดูเหมือนกันเป๊ะแล้วสรุปว่าจอมั่ว
 *
 * ประกอบด้วย text node กับ element เท่านั้น (กติกาเดียวกับ dom.mjs): ข้อความนี้มาจาก
 * ลูกค้าและจากโมเดล ห้ามต่อเป็นสตริง HTML ไม่ว่ากรณีใด
 * ตำแหน่งใน mark นับบน row.before / row.detail ล้วน ๆ คำนำหน้าอย่าง "ลูกแพรตอบไว้: "
 * จึงต้องเป็นคนละ node กัน ไม่ใช่เอามาต่อหน้าสตริงก่อนแล้วค่อยตัด
 */
function diffParts(text, mark) {
  const value = String(text ?? "");
  if (!Array.isArray(mark) || mark.length !== 2) return [value];
  const [start, end] = mark.map(Number);
  // ช่วงที่อ่านไม่ออกหรือเลยปลายสตริง = ไม่ต้องไฮไลต์ ดีกว่าวาดผิดตำแหน่ง
  if (!Number.isInteger(start) || !Number.isInteger(end)) return [value];
  if (start < 0 || end <= start || end > value.length) return [value];
  return [value.slice(0, start), el("span", { class: "ri-diff" }, value.slice(start, end)), value.slice(end)];
}

export function createReviewPage({ api, toast, mount, pageHeader, tabBar, stopPolling, setView, state }) {
  let filterId = "all";
  // state.features เติมหลังโมดูลนี้ถูก import ระหว่าง boot ได้ จึงต้องอ่านตอน render
  // ไม่ใช่จับค่า false ตอนสร้างหน้าไว้ตลอดอายุ session
  const isJevEnabled = () => state?.features?.jevReview === true;

  function confidence(value) {
    return Number.isFinite(Number(value)) ? `${Number(value).toFixed(1)}/10` : "ประเมินไม่ได้";
  }

  function jevCard(row, refresh) {
    const checks = Object.entries(row.result?.checks || {});
    const status = row.reviewStatus || "pending";
    const note = el("textarea", { class: "ri-dismiss-reason", maxlength: "1000", placeholder: "บันทึกเหตุผลสำหรับผู้ตรวจคนถัดไป (ไม่บังคับ)" }, row.reviewNote || "");
    const decisions = [
      ["confirmed_correct", "ยืนยันว่าถูก"],
      ["confirmed_wrong", "ยืนยันว่าผิด"],
      ["needs_context", "ต้องมีบริบทเพิ่ม"],
      ["dismissed", "ปิดรายการ"],
    ];
    const decide = (action, label) => el("button", {
      class: "btn btn-outline btn-mini",
      disabled: status !== "pending",
      onclick: async () => {
        try {
          await api(`/console/api/jev-reviews/${encodeURIComponent(row.id)}/decide`, { method: "POST", body: { action, note: note.value.trim() } });
          toast("บันทึกคำตัดสินแล้ว");
          await refresh();
        } catch (err) { toast(err.message); await refresh(); }
      },
    }, label);
    return el("article", { class: "kn-card ri-card ri-yellow" },
      el("div", { class: "kn-head ri-head" },
        el("span", { class: "ri-source" }, "JEV decision audit"),
        el("span", { class: "badge badge-orange" }, status === "pending" ? "รอคนตรวจ" : status),
        row.createdAt ? el("time", { class: "ri-time" }, timeAgo(row.createdAt)) : null,
      ),
      el("p", { class: "ri-title" }, `ข้อเสนอ: ${row.proposedAction || "—"} · JEV แนะนำ: ${row.action || "—"}`),
      el("p", { class: "block-hint" }, `ความมั่นใจรวมขั้นต่ำ: ${confidence(row.confidence10)} · โหมด: ${row.mode || "off"} · ${row.applied ? "ใช้ผลกับขั้นตอนนี้แล้ว (ไม่ได้ยืนยันการส่งถึงผู้รับ)" : "ยังไม่ได้ใช้ผลกับขั้นตอนนี้"}`),
      el("p", { class: "block-hint" }, "ความมั่นใจบอกระดับความแน่ใจของคำตอบ ไม่ได้ยืนยันว่าคำตอบถูกต้อง"),
      checks.length ? el("div", { class: "ri-detail" }, checks.map(([key, check]) =>
        el("p", {}, `${key}: ${check.choice || "—"} · ${confidence(check.confidence10)}`),
      )) : el("p", { class: "block-hint" }, "ไม่มีผลประเมินที่ใช้ได้"),
      row.customerId ? el("a", { class: "btn btn-ghost btn-mini", href: `#/c/${encodeURIComponent(row.customerId)}` }, "เปิดห้องแชท") : null,
      status === "pending" ? el("div", { class: "ri-dismiss-form" }, note, el("div", { class: "block-actions ri-actions" }, decisions.map(([action, label]) => decide(action, label)))) :
        el("p", { class: "ri-pending" }, `ผู้ตรวจ: ${row.reviewer || "—"}${row.reviewNote ? ` · ${row.reviewNote}` : ""}`),
      el("p", { class: "block-hint" }, "การยืนยันนี้เป็นบันทึกตรวจทานเท่านั้น ไม่สร้าง knowledge หรือสอนลูกแพรอัตโนมัติ"),
    );
  }

  function rowCard(row, refresh, { canPublishHere = true } = {}) {
    const risk = RISK_META[row.risk] || RISK_META.yellow;
    const source = SOURCE_META[row.source] || { label: row.source, icon: "•" };
    const buttons = [];

    if (row.actions?.teach) {
      // ปุ่มนี้เปิดจอสอน ไม่ใช่การเผยแพร่ — คนที่ไม่มีสิทธิ์เผยแพร่ก็กดได้ ของจะไปเข้าคิว
      // (ด่านสิทธิ์จริงอยู่ที่เส้นเขียนตอนกดส่งในจอสอน ไม่ใช่ที่ปุ่มนี้)
      buttons.push(el("a", {
        class: "btn btn-primary btn-mini ri-teach",
        href: `#/teach/${encodeURIComponent(row.source)}/${encodeURIComponent(row.refId)}`,
      }, "สอนลูกแพร"));
    }
    // ช่องกรอกเหตุผลอยู่ในหน้า ไม่ใช่ window.prompt — บนมือถือ prompt คือกล่องที่ปัดทิ้ง
    // ง่ายที่สุด และการปัดทิ้งโดยไม่ตั้งใจแปลว่าคำแก้ใบนั้นค้างอยู่ต่อโดยไม่มีใครรู้
    const dismissForm = el("div", { class: "ri-dismiss-form" });
    dismissForm.hidden = true;
    if (row.actions?.dismiss) {
      const reason = el("input", {
        class: "ri-dismiss-reason", type: "text", maxlength: "200",
        placeholder: "ไม่ต้องสอนเพราะอะไรคะ (เช่น เป็นเคสเฉพาะราย)",
      });
      const confirm = el("button", {
        class: "btn btn-danger btn-mini ri-dismiss-confirm",
        onclick: async () => {
          // เหตุผลไม่ใช่พิธีกรรม: เดือนหน้าคนที่เปิดกล่องนี้ต้องอ่านออกว่าทำไมถึงไม่สอน
          if (!reason.value.trim()) return toast("ใส่เหตุผลสั้น ๆ ก่อนนะคะ");
          confirm.disabled = true;
          try {
            await api(`/console/api/corrections/${encodeURIComponent(row.refId)}/decide`,
              { method: "POST", body: { action: "reject", reason: reason.value.trim() } });
            toast("ปิดเรื่องนี้แล้ว");
            await refresh();
          } catch (err) {
            toast(err.message);
            confirm.disabled = false;
            // แถวอาจถูกคนอื่นตัดสินไปแล้ว — โหลดรายการใหม่เสมอ ไม่ใช่ปล่อยให้จอค้างของเก่า
            await refresh();
          }
        },
      }, "ยืนยันไม่สอน");
      dismissForm.append(reason, confirm,
        el("button", {
          class: "btn btn-ghost btn-mini",
          onclick: () => { dismissForm.hidden = true; },
        }, "ยกเลิก"));
      buttons.push(el("button", {
        class: "btn btn-outline btn-mini ri-dismiss",
        onclick: () => { dismissForm.hidden = !dismissForm.hidden; },
      }, "ไม่ต้องสอน"));
    }
    if (row.actions?.openChat && row.customerId) {
      buttons.push(el("a", {
        class: "btn btn-ghost btn-mini",
        href: `#/c/${encodeURIComponent(row.customerId)}`,
      }, "เปิดห้องแชท"));
    }
    if (row.goTo) {
      buttons.push(el("a", { class: "btn btn-outline btn-mini", href: row.goTo }, "ไปหน้าที่แก้ได้"));
    }
    if (row.actions?.report) {
      const report = el("button", {
        class: "btn btn-outline btn-mini ri-report",
        onclick: async () => {
          report.disabled = true;
          try {
            await api("/console/api/teach/report", { method: "POST", body: { rowId: row.id, note: row.title } });
            toast("แจ้งช่างแล้วค่ะ — ระหว่างนี้ลูกแพรยังตอบตามปกติ");
          } catch (err) {
            toast(err.message);
            report.disabled = false;
          }
        },
      }, "แจ้งช่าง");
      buttons.push(report);
    }

    return el("article", { class: `kn-card ri-card ri-${row.risk}` },
      el("div", { class: "kn-head ri-head" },
        el("span", { class: "ri-source" }, `${source.icon} ${source.label}`),
        el("span", { class: `badge ${risk.tone}` }, risk.label),
        row.at ? el("time", { class: "ri-time" }, timeAgo(row.at)) : null,
      ),
      el("p", { class: "ri-title" }, row.title),
      row.amounts?.length
        ? el("p", { class: "ri-amounts" }, `ตัวเลขที่กันไว้: ${row.amounts.join(" · ")}`)
        : null,
      row.detail
        ? el("details", { class: "ri-detail" },
          el("summary", {}, row.source === "correction" ? "ดูคำตอบที่ทีมพิมพ์ไว้" : "ดูรายละเอียด"),
          row.before ? el("p", { class: "ri-before" }, "ลูกแพรตอบไว้: ", diffParts(row.before, row.beforeMark)) : null,
          el("p", { class: "ri-after" }, diffParts(row.detail, row.afterMark)),
        )
        : null,
      row.blockedWhy ? el("p", { class: "ri-blocked" }, row.blockedWhy) : null,
      // สถานะ "ส่งไปแล้ว" ต้องอยู่บนแถว ไม่ใช่ให้คนเดาจากปุ่มที่หายไป
      row.pendingNote ? el("p", { class: "ri-pending" }, `⏳ ${row.pendingNote}`) : null,
      // ownerOnly ถูกส่งมาจากเซิร์ฟเวอร์อยู่แล้ว — ถ้าไม่วาด คนที่กดไม่ได้จะรู้ตอนกดแล้วเด้ง
      row.ownerOnly && !canPublishHere
        ? el("p", { class: "ri-owner-only" }, "พี่ง้วงเท่านั้นที่กดใช้ได้ — ของคุณจะเข้าคิวรออนุมัติ")
        : null,
      buttons.length ? el("div", { class: "block-actions ri-actions" }, buttons) : null,
      dismissForm,
    );
  }

  function filterChips(rows, refresh, counts = null) {
    return el("div", { class: "ri-filters" },
      reviewCounts(rows, counts).map((filter) => el("button", {
        class: `fchip${filter.id === filterId ? " is-active" : ""}`,
        onclick: () => { filterId = filter.id; refresh({ keep: true }); },
      }, `${filter.label} ${filter.count}`)),
    );
  }

  // สถานะที่มาจากเซิร์ฟเวอร์ต้องอยู่ระดับหน้า ไม่ใช่ตัวแปรใน render รอบเดียว —
  // เดิมกดชิปกรองแล้ววาดใหม่จากข้อมูลที่ถือไว้ คำเตือน "ของคุณจะเข้าคิว" จึงหายไปเงียบ ๆ
  let page = { rows: [], total: 0, counts: null, hasMore: false, cursor: 0, queueInstead: false, canPublish: {}, jevRows: [], jevHasMore: false, jevCursor: null };

  async function render({ keep = false, append = false } = {}) {
    stopPolling();
    const jevEnabled = isJevEnabled();
    // keep = กดชิปกรอง ไม่ต้องยิงเส้นใหม่ (กล่องนี้คอมไพล์สมองหนึ่งรอบต่อการเรียกหนึ่งครั้ง)
    if (!keep) {
      const [data, jev] = await Promise.all([
        api(`/console/api/teach/review${append ? `?cursor=${encodeURIComponent(page.cursor)}` : ""}`).catch(() => ({ rows: [], total: 0, counts: {}, hasMore: false, cursor: 0, canPublish: {} })),
        !jevEnabled ? Promise.resolve({ rows: [] }) : append
          ? Promise.resolve({ rows: page.jevRows, hasMore: page.jevHasMore, nextCursor: page.jevCursor })
          : api("/console/api/jev-reviews?limit=30").catch(() => ({ rows: [] })),
      ]);
      const rows = Array.isArray(data.rows) ? data.rows : [];
      page = {
        rows: append ? [...page.rows, ...rows] : rows,
        total: Number(data.total ?? rows.length),
        counts: data.counts ?? null,
        hasMore: data.hasMore === true,
        cursor: Number(data.cursor ?? 0),
        queueInstead: data.queueInstead === true,
        canPublish: data.canPublish ?? {},
        jevRows: Array.isArray(jev.rows) ? jev.rows : [],
        jevHasMore: jev.hasMore === true,
        jevCursor: jev.nextCursor || null,
      };
    }
    const rows = page.rows;
    const filter = REVIEW_FILTERS.find((one) => one.id === filterId) ?? REVIEW_FILTERS[0];
    const shown = rows.filter((row) => filter.match(row));
    const refresh = (options = {}) => render(options);
    const canPublishHere = page.canPublish?.knowledge === true;

    mount(
      pageHeader("กล่องตรวจ"),
      el("main", { class: "page-scroll" },
        el("div", { class: "page-inner ri-page" },
          state?.features?.trainingIntake ? el("a", { class: "btn btn-primary", href: "#/teach-intake" }, "นำเข้าความรู้จากทีม") : null,
          el("section", { class: "block ri-block" },
            el("h2", { class: "block-title" },
              "รอคนตัดสิน",
              page.total ? el("span", { class: "badge badge-orange ri-count" }, String(page.total)) : null,
            ),
            el("p", { class: "block-hint" },
              "ทุกอย่างที่รอให้คนตัดสินอยู่ในกล่องนี้กล่องเดียว —"
              + " กด “สอนลูกแพร” เพื่อทำให้มันกลายเป็นความรู้ถาวร"),
            // จำนวนจริงต้องอยู่ตรงนี้เสมอ: ตัวเลขที่นับจากชุดที่ถูกตัดแล้วทำให้คนเชื่อว่า
            // เคลียร์หมดแล้วทั้งที่ยังเหลืออีกครึ่ง
            page.total > rows.length
              ? el("p", { class: "block-hint ri-shown" }, `แสดง ${rows.length} จาก ${page.total} รายการ`)
              : null,
            page.queueInstead
              ? el("p", { class: "block-hint publish-request-hint" },
                "บัญชีนี้สอนได้ตามปกติ — ของที่ส่งจะกลายเป็นคำขอให้พี่ง้วงกดอนุมัติ")
              : null,
            filterChips(rows, refresh, page.counts),
          ),
          jevEnabled && page.jevRows.length ? el("section", { class: "block ri-block" },
            el("h2", { class: "block-title" }, "JEV double-check"),
            el("p", { class: "block-hint" }, "รายการนี้แยกจาก JEV shadow ที่ใช้เปรียบเทียบคะแนนความสนใจ และทุกเคสต้องผ่านการตัดสินของคนก่อนนำไปคัดเลือกสอนในอนาคต"),
            el("div", { class: "kn-list ri-list" }, page.jevRows.map((row) => jevCard(row, refresh))),
            page.jevHasMore ? el("button", {
              class: "btn btn-outline ri-more",
              onclick: async () => {
                try {
                  const more = await api(`/console/api/jev-reviews?limit=30&cursor=${encodeURIComponent(page.jevCursor || "")}`);
                  page = {
                    ...page,
                    jevRows: [...page.jevRows, ...(Array.isArray(more.rows) ? more.rows : [])],
                    jevHasMore: more.hasMore === true,
                    jevCursor: more.nextCursor || null,
                  };
                  await render({ keep: true });
                } catch (err) { toast(err.message); }
              },
            }, "ดู JEV เพิ่ม") : null,
          ) : null,
          shown.length
            ? el("div", { class: "kn-list ri-list" },
              shown.map((row) => rowCard(row, refresh, { canPublishHere })))
            : page.jevRows.some((row) => (row.reviewStatus || "pending") === "pending")
              ? null
              : el("div", { class: "empty-state" },
              emptyArt(),
              el("p", { class: "empty-title" }, rows.length ? "ไม่มีรายการในตัวกรองนี้" : "ไม่มีอะไรรอตัดสินค่ะ"),
              el("p", { class: "empty-sub" },
                rows.length
                  ? "ลองเลือก “ทั้งหมด” เพื่อดูรายการที่เหลือ"
                  : "เมื่อทีมแก้คำตอบของลูกแพร หรือระบบกันอะไรไว้ มันจะมารออยู่ที่นี่"),
            ),
          page.hasMore
            ? el("button", {
              class: "btn btn-outline ri-more",
              onclick: () => render({ append: true }),
            }, `ดูเพิ่ม (เหลืออีก ${Math.max(0, page.total - rows.length)})`)
            : null,
        ),
      ),
      tabBar(),
    );
    setView("page");
  }

  return render;
}
