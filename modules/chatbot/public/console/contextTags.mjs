// contextTags.mjs — แผงป้ายลูกค้าในห้องแชท (แยกจาก context.mjs 28 ก.ย. 2026 — คุมขนาดไฟล์)
//
// กรอบป้ายชุดเดียวเปิดอยู่ (พี่ง้วงอนุมัติ 28 ก.ย.): ป้าย "มิติ: ค่า" ถูกจัดกลุ่มตามมิติ บอกว่าใครติดและจำอย่างไร
// และช่องเพิ่มป้ายให้เลือกมิติ → เลือกค่าจากรายการปิด (มิติเปิดพิมพ์เอง · ป้ายอิสระพิมพ์ได้เหมือนเดิม)
// เซิร์ฟเวอร์ตรวจซ้ำทุกครั้ง (customerTagActions.mjs) — ตัวเลือกในหน้านี้แค่ทำให้ไม่ต้องเดาชื่อ
// สวิตช์ปิด/ไม่มีไฟล์กรอบ = แผงแบบเดิมทุกอย่าง (รายการป้าย + ช่องพิมพ์ + customer ขึ้นก่อน)
// ทุกค่าลง text node ผ่าน el() · ไม่มี inline style (CSP) · สีจาก token ของธีม (tagEditor.css)
import { el } from "./dom.mjs";

// "customer" ต้องมาก่อนเสมอ — ป้ายเดียวที่เปลี่ยนพฤติกรรมระบบ (ติดแล้วบอทเงียบถาวร) การสะกดผิดจึงมีราคา
// "null" = ไม่ได้มาคุย (บัญชีมาตามเอกสาร / เจ้าของส่งทีมมาเรียน) — บอทเงียบสนิท
export const TAG_SUGGESTIONS = Object.freeze(["customer", "null", "VIP", "ผ่อนอยู่", "รอโปร", "นักเรียนเก่า", "องค์กร"]);
const FREE = "";
const VIEW_TTL_MS = 60_000;

// มุมมองกรอบจากเซิร์ฟเวอร์ (null = สวิตช์ปิด/ไม่มีไฟล์กรอบ · undefined = ยังไม่เคยโหลด)
const cache = { at: 0, view: undefined, pending: null };
const signature = (view) => (view ? `${view.frameworkId}:${view.dimensions.length}` : "off");

/** ล้างแคช (เทสต์ใช้เปลี่ยนสถานการณ์สวิตช์เปิด/ปิดในไฟล์เดียว) */
export function resetTagFrameworkCache() {
  cache.at = 0;
  cache.view = undefined;
  cache.pending = null;
}

/** โหลดมุมมองกรอบ (อย่างมากนาทีละครั้ง) — แผงแรกที่เปิดเป็นคนเรียก แผงถัด ๆ ไปใช้ของในแคช */
export function prefetchTagFramework(api, { now = Date.now } = {}) {
  if (cache.pending) return cache.pending;
  if (cache.view !== undefined && now() - cache.at < VIEW_TTL_MS) return Promise.resolve(cache.view);
  cache.pending = api("/console/api/customers/tag-framework")
    .then((data) => { cache.view = data?.framework || null; return cache.view; })
    // โหลดไม่ได้ = ใช้ค่าล่าสุดที่รู้ (ครั้งแรก = แผงแบบเดิม) แล้วลองใหม่รอบหน้า
    .catch(() => { cache.view = cache.view ?? null; return cache.view; })
    .finally(() => { cache.at = now(); cache.pending = null; });
  return cache.pending;
}

const dimensionOfTag = (tag, dims) => {
  const text = String(tag || "");
  const at = text.search(/[:：]/u);
  if (at <= 0) return null;
  const key = text.slice(0, at).trim();
  return dims.find((dim) => dim.key === key) || null;
};

/**
 * จัดป้ายของห้องเป็นกลุ่มตามลำดับมิติในไฟล์กรอบ + กลุ่ม "อื่น ๆ" (ป้ายอิสระ/ป้ายระบบ/ป้าย LINE OA เดิม)
 * @returns {{ groups: Array<{ dim: object, tags: object[] }>, other: object[] }}
 */
export function groupTagsByDimension(tags, view) {
  const dims = view?.dimensions || [];
  const byKey = new Map(dims.map((dim) => [dim.key, []]));
  const other = [];
  for (const row of tags || []) {
    const dim = dimensionOfTag(row.tag, dims);
    if (dim) byKey.get(dim.key).push(row);
    else other.push(row);
  }
  return { groups: dims.filter((dim) => byKey.get(dim.key).length).map((dim) => ({ dim, tags: byKey.get(dim.key) })), other };
}

/** คำอธิบายสั้นว่าใครติดมิตินี้และจำอย่างไร (ตรงกับคู่มือป้าย) */
export function dimensionMeta(dim) {
  if (dim.setBy === "system") return dim.dynamic ? "ระบบคำนวณ · ค่าล่าสุดเสมอ" : "ระบบติดจากออเดอร์";
  if (dim.setBy === "human") return dim.open ? "ทีมติด · พิมพ์ค่าเอง" : "ทีมติด · เลือกจากรายการ";
  const memory = dim.merge === "funnel" ? "เดินหน้าเท่านั้น" : dim.merge === "latest" ? "ค่าล่าสุด" : `สะสม ≤${dim.max}`;
  return `AI ติด · ${memory} · ทีมแก้ได้`;
}

const valueOf = (tag) => String(tag).slice(String(tag).search(/[:：]/u) + 1).trim();

/** ตัวอย่างในช่องพิมพ์ของมิติเปิด — หยิบจาก "เช่น …" ในคำอธิบายของไฟล์กรอบ */
export function exampleFor(dim) {
  const match = /เช่น\s+([^,(·]+)/u.exec(dim.guide || "");
  const example = match ? match[1].trim().replace(new RegExp(`^${dim.key}\\s*[:：]\\s*`, "u"), "") : "";
  return example ? `เช่น ${example}` : `ค่าของ ${dim.key}`;
}

export function createTagsPanel({ api, toast }) {
  // มิติ/ค่าที่เลือกค้างไว้ต่อห้อง — poll ทุก 7 วิสร้างแผงใหม่ ห้ามทำให้ตัวเลือกเด้งกลับ
  const choice = new Map();
  const picked = (customerId) => choice.get(customerId) || { dim: FREE, value: "" };

  async function mutate(customerId, body, done) {
    try {
      await api(`/console/api/customers/${encodeURIComponent(customerId)}/tags`, { method: "POST", body });
      if (body.add) toast(`ติดป้าย "${body.add}" แล้ว`);
      choice.delete(customerId);
      await done();
    } catch (err) {
      toast(err.message);
    }
  }

  function chip(customerId, row, label, refresh) {
    return el("span", { class: `tag-chip tag-${row.source}`, title: row.tag },
      label,
      el("button", {
        class: "tag-del", "aria-label": `ลบป้าย ${row.tag}`, title: "ลบป้ายนี้",
        onclick: () => mutate(customerId, { remove: row.tag }, refresh),
      }, "✕"),
    );
  }

  function freeInput(customerId, submit, value = "") {
    const suggestId = `tag-suggest-${String(customerId).replace(/[^a-z0-9]/giu, "")}`;
    const input = el("input", {
      class: "order-in keep-focus tag-input", type: "text", maxlength: "60", value,
      list: suggestId, autocomplete: "off", "aria-label": "ป้ายที่จะติด",
      placeholder: "พิมพ์ป้าย (พิมพ์ c = customer)",
      onkeydown: (e) => { if (e.key === "Enter") submit(); },
    });
    return { input, list: el("datalist", { id: suggestId }, TAG_SUGGESTIONS.map((tag) => el("option", { value: tag }))) };
  }

  // แผงแบบเดิม (สวิตช์ปิด / ไม่มีไฟล์กรอบ / โหลดกรอบครั้งแรกยังไม่เสร็จ)
  function legacyBody(customerId, list, refresh) {
    const submit = () => {
      const tag = free.input.value.trim();
      if (tag) mutate(customerId, { add: tag }, refresh);
    };
    const free = freeInput(customerId, submit);
    return [
      free.list,
      list.length
        ? el("div", { class: "tag-chips" }, list.map((row) => chip(customerId, row, row.tag, refresh)))
        : el("p", { class: "panel-sub" }, "ยังไม่มีป้าย — ระบบติดให้เองจากบทสนทนา (ความสนใจ) และจากออเดอร์จริง (RFM: ซื้อกี่ครั้ง/เมื่อไหร่/สินค้าอะไร/AOV)"),
      el("div", { class: "panel-row tag-add-row" }, free.input, el("button", { class: "btn btn-outline btn-mini", onclick: submit }, "เพิ่ม")),
      el("p", { class: "panel-sub tag-legend" }, "🟦 จากออเดอร์ (RFM) · 🟪 จากบทสนทนา · 🟩 ทีมงานติดเอง — ใช้ทำ segment broadcast ได้"),
    ];
  }

  function addRow(customerId, view, refresh, repaint) {
    const addable = view.dimensions.filter((dim) => dim.canAdd);
    const state = picked(customerId);
    const dim = addable.find((d) => d.key === state.dim) || null;
    const remember = (value) => choice.set(customerId, { dim: dim?.key || FREE, value });
    let valueControl;
    let datalist = null;
    const submit = () => {
      const value = String(valueControl.value || "").trim();
      if (!value) {
        toast(dim ? `เลือกค่าของมิติ "${dim.key}" ก่อน` : "พิมพ์ป้ายก่อน");
        return;
      }
      mutate(customerId, { add: dim ? `${dim.key}: ${value}` : value }, refresh);
    };
    if (dim && !dim.open) {
      valueControl = el("select", {
        class: "order-in keep-focus tag-value-select", "aria-label": `ค่าของมิติ ${dim.key}`,
        onchange: (e) => remember(e.target.value),
      },
      el("option", { value: "" }, "เลือกค่า…"),
      dim.values.map((v) => el("option", { value: v.value, title: v.hint || "", ...(state.value === v.value ? { selected: "" } : {}) },
        v.setBy === "human" && dim.setBy === "ai" ? `${v.value} (ทีมติด)` : v.value)));
    } else if (dim) {
      valueControl = el("input", {
        class: "order-in keep-focus tag-value-input", type: "text", maxlength: String(Math.max(8, 58 - dim.key.length)),
        autocomplete: "off", "aria-label": `ค่าของมิติ ${dim.key}`, placeholder: exampleFor(dim), value: state.value,
        oninput: (e) => remember(e.target.value),
        onkeydown: (e) => { if (e.key === "Enter") submit(); },
      });
    } else {
      const free = freeInput(customerId, submit, state.value);
      valueControl = free.input;
      valueControl.addEventListener("input", (e) => remember(e.target.value));
      datalist = free.list;
    }
    const dimSelect = el("select", {
      class: "order-in keep-focus tag-dim-select", "aria-label": "มิติของป้าย",
      // เปลี่ยนมิติ = วาดแผงนี้ใหม่ในที่ (ไม่ต้องโหลดห้องแชททั้งห้องใหม่)
      onchange: (e) => { choice.set(customerId, { dim: e.target.value, value: "" }); repaint({ focus: ".tag-add-grid > :nth-child(2)" }); },
    },
    el("option", { value: FREE, ...(dim ? {} : { selected: "" }) }, "ป้ายอิสระ (พิมพ์เอง)"),
    addable.map((d) => el("option", { value: d.key, ...(dim?.key === d.key ? { selected: "" } : {}) }, d.key)));
    return [datalist, el("div", { class: "tag-add-grid" }, dimSelect, valueControl,
      el("button", { class: "btn btn-outline btn-mini tag-add-btn", onclick: submit }, "เพิ่ม"))];
  }

  function frameworkBody(customerId, list, view, refresh, repaint) {
    const { groups, other } = groupTagsByDimension(list, view);
    const blocks = groups.map(({ dim, tags }) => el("section", { class: "tag-group", "aria-label": `มิติ ${dim.key}` },
      el("div", { class: "tag-group-head" },
        el("span", { class: "tag-group-name" }, dim.key),
        el("span", { class: "tag-group-meta" }, dimensionMeta(dim))),
      el("div", { class: "tag-chips" }, tags.map((row) => chip(customerId, row, valueOf(row.tag) || row.tag, refresh)))));
    if (other.length) {
      blocks.push(el("section", { class: "tag-group", "aria-label": "ป้ายอิสระและป้ายระบบ" },
        el("div", { class: "tag-group-head" },
          el("span", { class: "tag-group-name" }, "อื่น ๆ"),
          el("span", { class: "tag-group-meta" }, "ป้ายอิสระ · ป้ายระบบ · ป้าย LINE OA เดิม")),
        el("div", { class: "tag-chips" }, other.map((row) => chip(customerId, row, row.tag, refresh)))));
    }
    return [
      blocks.length
        ? el("div", { class: "tag-groups" }, blocks)
        : el("p", { class: "panel-sub" }, "ยังไม่มีป้าย — AI ติดจากบทสนทนา (เลือกจากรายการที่พี่ง้วงอนุมัติ) และระบบติด ซื้อครั้งที่/ซื้อล่าสุด จากการซื้อจริง"),
      ...addRow(customerId, view, refresh, repaint),
      el("p", { class: "tag-rules" },
        "มิติที่มีรายการเลือกได้เฉพาะค่าในรายการ · ซื้อครั้งที่/ซื้อล่าสุด ระบบคำนวณใหม่ทุกครั้งที่มีการซื้อ · ",
        el("a", { href: "/console/guide-tags.html", target: "_blank", rel: "noopener", class: "tag-guide-link" }, "คู่มือป้าย ›")),
      el("p", { class: "panel-sub tag-legend" }, "🟦 ระบบ (ออเดอร์/ประวัติการซื้อ) · 🟪 AI จากบทสนทนา · 🟩 ทีมงานติดเอง — ใช้แบ่งกลุ่มบรอดแคสต์"),
    ];
  }

  /** แผงทั้งใบ — กรอบยังไม่เคยโหลด = วาดแบบเดิมก่อน แล้ววาดใหม่ในที่เดิมเมื่อได้ข้อมูล */
  return function tagsPanel(customerId, tags, refresh) {
    const list = tags || [];
    const panel = el("details", { class: "panel tags-panel", ...(list.length ? { open: "" } : {}) });
    let shown = cache.view || null;
    const paint = ({ focus = "" } = {}) => {
      const body = shown ? frameworkBody(customerId, list, shown, refresh, paint) : legacyBody(customerId, list, refresh);
      // replaceChildren แปลง null เป็นข้อความ "null" — กรองทิ้งก่อน (datalist มีเฉพาะช่องป้ายอิสระ)
      panel.replaceChildren(
        el("summary", {}, `ป้ายลูกค้า (tags)${list.length ? ` (${list.length})` : ""}`),
        ...body.filter(Boolean),
      );
      if (focus) panel.querySelector(focus)?.focus?.();
    };
    paint();
    const stale = cache.view === undefined || Date.now() - cache.at >= VIEW_TTL_MS;
    if (stale) {
      prefetchTagFramework(api).then((view) => {
        if (signature(view) === signature(shown)) return;
        shown = view;
        // ห้ามวาดทับตอนทีมกำลังพิมพ์/เลือกอยู่ในแผงนี้ — รอบ poll ถัดไปจะได้แผงใหม่เอง
        // แผงที่ถูกถอดออกจากหน้าแล้ว (ห้องถูกวาดใหม่) ไม่ต้องวาด
        const busy = typeof panel.contains === "function" && panel.contains(globalThis.document?.activeElement);
        if (panel.isConnected !== false && !busy) paint();
      });
    }
    return panel;
  };
}
