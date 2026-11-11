// broadcastAudience.mjs — ตัวเลือกผู้รับของสตูดิโอบรอดแคสต์ (28 ก.ย. 2026)
// 4 โหมด: เพื่อนทุกคน (broadcast) · ตามป้ายของเรา (multicast) · กลุ่มเป้าหมาย LINE (narrowcast) · ข้อมูลประชากร (narrowcast)
// ป้ายจัดกลุ่มตาม "มิติ: ค่า" จากข้อมูลจริง (ไม่ hard-code) · ห้องสแปม/บล็อก เซิร์ฟเวอร์ตัดให้เสมอ
import { el } from "./dom.mjs";
import { put } from "./broadcastState.mjs";

export const AUDIENCE_MODES = Object.freeze([
  { mode: "all", title: "เพื่อนทุกคน", sub: "ทุกคนที่เพิ่มเพื่อน OA นี้ (เหมือนบรอดแคสต์ใน OA Manager)", glyph: "◎", lineSide: true },
  { mode: "tags", title: "ตามป้ายของเรา", sub: "คนที่คุยกับลูกแพรแล้ว เลือกด้วยป้าย สนใจ/ขั้น/ซื้อ ฯลฯ", glyph: "#", lineSide: false },
  { mode: "audience", title: "กลุ่มเป้าหมาย LINE", sub: "กลุ่มจาก OA Manager เช่นแท็กแชท ช่องทางเพิ่มเพื่อน", glyph: "◈", lineSide: true },
  { mode: "demographic", title: "ข้อมูลประชากร", sub: "เพศ อายุ ภูมิภาค ระบบมือถือ ระยะเวลาเป็นเพื่อน", glyph: "◐", lineSide: true },
]);

const GENDER = [["male", "ชาย"], ["female", "หญิง"]];
const APP = [["ios", "iOS"], ["android", "Android"]];
const AGE_LABEL = (value) => `${value.replace("age_", "")} ปี`;
const PERIOD_LABEL = { day_7: "7 วัน", day_30: "30 วัน", day_90: "90 วัน", day_180: "180 วัน", day_365: "1 ปี" };

export function createAudienceState() {
  return {
    mode: "tags",
    audience: { include: new Set(), exclude: new Set() },
    demographic: { gender: new Set(), appType: new Set(), area: new Set(), age: { gte: "", lt: "" }, subscriptionPeriod: { gte: "", lt: "" } },
  };
}

/** เป้าหมายที่ส่งให้เซิร์ฟเวอร์ตามโหมด (ป้ายส่งแยกเป็น includeTags/excludeTags) */
export function audienceTargetPayload(state) {
  if (state.mode === "audience") {
    return { include: [...state.audience.include], exclude: [...state.audience.exclude] };
  }
  if (state.mode === "demographic") {
    const d = state.demographic;
    const range = (r) => ({ ...(r.gte ? { gte: r.gte } : {}), ...(r.lt ? { lt: r.lt } : {}) });
    return {
      gender: [...d.gender], appType: [...d.appType], area: [...d.area],
      age: range(d.age), subscriptionPeriod: range(d.subscriptionPeriod),
    };
  }
  return {};
}

function toggleSet(set, value) {
  if (set.has(value)) set.delete(value); else set.add(value);
}

function chip(label, { active = false, tone = "", onClick, count = null, title = "" } = {}) {
  return el("button", {
    type: "button", class: `bs-chip${tone ? ` is-${tone}` : ""}${active ? " is-active" : ""}`,
    "aria-pressed": active ? "true" : "false", title: title || null, onclick: onClick,
  }, label, count !== null ? el("span", { class: "bs-chip-count" }, Number(count).toLocaleString("th-TH")) : null);
}

/* -------------------------------- ป้ายของเรา -------------------------------- */

export function tagPanel({ meta, segments, channelId, onChange }) {
  const root = el("div", { class: "bs-tag-panel" });
  let query = "";
  const groups = meta.tagGroups || [];
  const presets = meta.presets || [];
  const mutate = (fn) => { fn(); render(); onChange(); };

  const render = () => {
    const segment = segments.current(channelId);
    const refocus = globalThis.document?.activeElement?.classList?.contains("bs-tag-search");
    const lower = query.trim().toLocaleLowerCase("th-TH");
    const presetActive = (preset) => preset.exclude.every((tag) => segment.exclude.has(tag));
    const allKnown = segment.include.has("*");
    const selected = el("div", { class: "bs-selected" },
      el("div", { class: "bs-selected-row" },
        el("span", { class: "bs-selected-label" }, "ส่งถึง"),
        segment.include.size
          ? [...segment.include].map((tag) => chip(tag === "*" ? "ทุกคนที่ระบบรู้จัก" : tag.replace(/:\*$/u, ": ทุกค่า"), {
              active: true, tone: "include", title: "กดเพื่อเอาออก", onClick: () => mutate(() => segments.toggle(channelId, "include", tag)),
            }))
          : el("span", { class: "bs-muted" }, "ยังไม่ได้เลือก — เลือกป้ายด้านล่างอย่างน้อย 1 อย่าง")),
      el("div", { class: "bs-selected-row" },
        el("span", { class: "bs-selected-label" }, "ยกเว้น"),
        segment.exclude.size
          ? [...segment.exclude].map((tag) => chip(tag.replace(/:\*$/u, ": ทุกค่า"), {
              active: true, tone: "exclude", title: "กดเพื่อเอาออก", onClick: () => mutate(() => segments.toggle(channelId, "exclude", tag)),
            }))
          : el("span", { class: "bs-muted" }, "ไม่มี")),
    );
    const quick = el("div", { class: "bs-quick" },
      chip(`ทุกคนที่ระบบรู้จัก`, {
        active: allKnown, tone: "include", count: meta.reachableKnown ?? null,
        title: "ทุกห้องแชทที่ส่งถึงได้ (ตัดสแปม/ขอหยุดทัก/บล็อกแล้ว)",
        onClick: () => mutate(() => segments.toggle(channelId, "include", "*")),
      }),
      presets.map((preset) => chip(preset.label, {
        active: presetActive(preset), tone: "exclude", title: preset.hint,
        onClick: () => mutate(() => {
          const on = presetActive(preset);
          for (const tag of preset.exclude) {
            if (on) segment.exclude.delete(tag);
            else { segment.exclude.add(tag); segment.include.delete(tag); }
          }
        }),
      })),
    );
    const search = el("input", {
      class: "order-in bs-input bs-tag-search keep-focus", type: "search", placeholder: "ค้นหาป้าย…",
      "aria-label": "ค้นหาป้าย", oninput: (event) => { query = event.target.value; render(); },
    });
    search.value = query;
    const visibleGroups = groups
      .map((group) => ({ ...group, tags: group.tags.filter((tag) => !lower || tag.tag.toLocaleLowerCase("th-TH").includes(lower)) }))
      .filter((group) => group.tags.length);
    const groupNodes = visibleGroups.map((group) => {
      const hasSelection = group.tags.some((tag) => segment.include.has(tag.tag) || segment.exclude.has(tag.tag))
        || (group.wildcard && (segment.include.has(group.wildcard) || segment.exclude.has(group.wildcard)));
      const details = el("details", { class: "bs-dim", open: hasSelection || lower || visibleGroups.length <= 2 ? "open" : null },
        el("summary", { class: "bs-dim-head" },
          el("strong", {}, group.label),
          el("span", { class: "bs-muted" }, `${group.tags.length} ป้าย`),
          group.wildcard
            ? el("span", { class: "bs-dim-all" },
                chip("ส่งทั้งมิติ", { active: segment.include.has(group.wildcard), tone: "include", onClick: (event) => { event.preventDefault(); mutate(() => segments.toggle(channelId, "include", group.wildcard)); } }),
                chip("เว้นทั้งมิติ", { active: segment.exclude.has(group.wildcard), tone: "exclude", onClick: (event) => { event.preventDefault(); mutate(() => segments.toggle(channelId, "exclude", group.wildcard)); } }))
            : null),
        el("ul", { class: "bs-tag-list" }, group.tags.map((tag) => el("li", { class: "bs-tag-row" },
          el("span", { class: "bs-tag-name" },
            el("strong", {}, group.dimension ? tag.value : tag.tag),
            el("span", { class: "bs-muted" }, `${Number(tag.count || 0).toLocaleString("th-TH")} คน${tag.purchased ? " · ซื้อแล้ว" : ""}`)),
          el("span", { class: "bs-tag-actions" },
            chip("ส่ง", { active: segment.include.has(tag.tag), tone: "include", onClick: () => mutate(() => segments.toggle(channelId, "include", tag.tag)) }),
            chip("เว้น", { active: segment.exclude.has(tag.tag), tone: "exclude", onClick: () => mutate(() => segments.toggle(channelId, "exclude", tag.tag)) }))))),
      );
      return details;
    });
    put(root, 
      selected, quick,
      groups.length ? search : null,
      groups.length
        ? (groupNodes.length ? el("div", { class: "bs-dims" }, groupNodes) : el("p", { class: "block-hint" }, "ไม่พบป้ายที่ตรงกับคำค้น"))
        : el("p", { class: "block-hint" }, "ยังไม่มีป้ายใน OA นี้ — ป้ายเกิดจากออเดอร์จริง บทสนทนา หรือทีมติดเองในห้องแชท"),
      el("p", { class: "block-hint" }, "มีป้ายใดป้ายหนึ่งที่เลือก = ได้รับ · มีป้ายยกเว้นแม้ป้ายเดียว = ไม่ได้รับ · ห้องสแปม (null) คนที่บล็อก และคนที่ขอหยุดทัก ถูกตัดออกให้เสมอ"),
    );
    if (refocus) queueMicrotask(() => { search.focus(); search.setSelectionRange?.(search.value.length, search.value.length); });
  };
  render();
  return root;
}

/* ------------------------------ กลุ่มเป้าหมาย LINE ------------------------------ */

export function audienceGroupPanel({ api, channelId, state, onChange, toast }) {
  const root = el("div", { class: "bs-audience-panel" });
  let model = null;
  let loading = false;

  const load = async (fresh = false) => {
    loading = true;
    render();
    try {
      model = await api(`/console/api/broadcast/studio/audiences?channel=${encodeURIComponent(channelId)}${fresh ? "&fresh=1" : ""}`);
    } catch (error) {
      model = { available: false, reason: error.message, groups: [] };
      toast?.(error.message);
    }
    loading = false;
    render();
  };

  const render = () => {
    if (loading && !model) {
      put(root, el("div", { class: "bs-skeleton", "aria-hidden": "true" }), el("p", { class: "block-hint" }, "กำลังโหลดกลุ่มเป้าหมายจาก LINE…"));
      return;
    }
    const groups = model?.groups || [];
    const toolbar = el("div", { class: "bs-audience-toolbar" },
      el("p", { class: "block-hint" }, model?.notice || "กลุ่มที่สร้างใน LINE OA Manager ใช้ส่งจากที่นี่ได้"),
      el("button", { type: "button", class: "btn btn-outline btn-mini", disabled: loading ? true : null, onclick: () => load(true) }, loading ? "กำลังโหลด…" : "โหลดใหม่"));
    if (!model?.available && !groups.length) {
      put(root, toolbar, el("p", { class: "bs-empty" },
        model?.reason === "live_send_disabled" ? "ช่องส่ง LINE ยังไม่เปิด — ดึงรายการกลุ่มไม่ได้" : "ยังดึงรายการกลุ่มจาก LINE ไม่ได้ — ลองโหลดใหม่"));
      return;
    }
    if (!groups.length) {
      put(root, toolbar, el("p", { class: "bs-empty" }, "OA นี้ยังไม่มีกลุ่มเป้าหมาย — สร้างได้ใน LINE OA Manager (เมนู กลุ่มเป้าหมาย/Audience) เช่นจากแท็กแชท"));
      return;
    }
    const rows = groups.map((group) => {
      const included = state.audience.include.has(group.audienceGroupId);
      const excluded = state.audience.exclude.has(group.audienceGroupId);
      return el("li", { class: `bs-aud-row${group.usable ? "" : " is-disabled"}` },
        el("span", { class: "bs-aud-copy" },
          el("strong", {}, group.description || `กลุ่ม ${group.audienceGroupId}`),
          el("span", { class: "bs-aud-meta" },
            el("span", { class: "bs-badge" }, group.typeLabel || group.type),
            el("span", { class: "bs-muted" }, group.routeLabel || group.createRoute),
            el("span", { class: "bs-muted" }, Number.isSafeInteger(group.audienceCount)
              ? (group.audienceCount === 0 && !group.minRecipientExempt ? "น้อยกว่า 20 คน" : `${group.audienceCount.toLocaleString("th-TH")} คน`)
              : "ไม่ทราบจำนวน"),
            group.usable ? null : el("span", { class: "bs-badge is-warn" }, `ยังใช้ไม่ได้ (${group.status})`))),
        el("span", { class: "bs-tag-actions" },
          chip("ส่ง", {
            active: included, tone: "include",
            onClick: () => { if (!group.usable) return; state.audience.exclude.delete(group.audienceGroupId); toggleSet(state.audience.include, group.audienceGroupId); render(); onChange(); },
          }),
          chip("เว้น", {
            active: excluded, tone: "exclude",
            onClick: () => { if (!group.usable) return; state.audience.include.delete(group.audienceGroupId); toggleSet(state.audience.exclude, group.audienceGroupId); render(); onChange(); },
          })));
    });
    put(root, toolbar, el("ul", { class: "bs-aud-list" }, rows),
      el("p", { class: "block-hint" }, "เลือกหลายกลุ่ม = คนที่อยู่กลุ่มใดกลุ่มหนึ่ง · กลุ่มยกเว้นตัดออก · รวมกันไม่เกิน 10 กลุ่ม · กลุ่มที่ผลลัพธ์ต่ำกว่า 50 คน LINE จะไม่ส่ง (ยกเว้นแท็กแชท/อัปโหลดรายชื่อ)"),
      model?.truncated ? el("p", { class: "block-hint" }, "แสดง 200 กลุ่มล่าสุด") : null);
  };

  render();
  if (!model) load(false);
  return root;
}

/* -------------------------------- ข้อมูลประชากร -------------------------------- */

export function demographicPanel({ meta, state, onChange }) {
  const root = el("div", { class: "bs-demo-panel" });
  const options = meta.demographic?.options || {};
  const areaLabels = meta.demographic?.areaLabels || {};
  const d = state.demographic;

  const select = (label, range, values, format) => {
    const make = (key, placeholder) => {
      const node = el("select", {
        class: "order-in bs-select keep-focus", "aria-label": `${label} ${placeholder}`,
        onchange: (event) => { range[key] = event.target.value; onChange(); },
      }, el("option", { value: "" }, placeholder), values.map((value) => el("option", { value }, format(value))));
      node.value = range[key] || "";
      return node;
    };
    return el("div", { class: "bs-demo-range" }, el("span", { class: "bs-field-label" }, label),
      el("span", { class: "bs-range" }, make("gte", "ตั้งแต่"), el("span", { "aria-hidden": "true" }, "–"), make("lt", "ถึงก่อน")));
  };

  const render = () => {
    const chips = (label, set, entries) => el("div", { class: "bs-demo-row" },
      el("span", { class: "bs-field-label" }, label),
      el("span", { class: "bs-chips" }, entries.map(([value, text]) => chip(text, {
        active: set.has(value), tone: "include", onClick: () => { toggleSet(set, value); render(); onChange(); },
      }))));
    put(root, 
      chips("เพศ", d.gender, GENDER),
      select("อายุ", d.age, options.age || [], AGE_LABEL),
      chips("ภูมิภาค", d.area, (options.area || []).map((value) => [value, areaLabels[value] || value])),
      chips("ระบบมือถือ", d.appType, APP),
      select("เป็นเพื่อนมาแล้ว", d.subscriptionPeriod, options.subscriptionPeriod || [], (value) => PERIOD_LABEL[value] || value),
      el("p", { class: "block-hint" },
        "ไม่เลือก = ไม่กรองเรื่องนั้น · LINE คำนวณผู้รับตอนส่ง (ข้อมูลช้าประมาณ 3 วัน) · ไทยตัดผู้ใช้อายุต่ำกว่า 20 ปีเสมอ · "
        + `ต้องมีเพื่อนที่ LINE ระบุข้อมูลได้อย่างน้อย ${meta.limits?.demographicMinTargetReach || 100} คน และผลลัพธ์อย่างน้อย ${meta.limits?.narrowcastMinRecipients || 50} คน`),
    );
  };
  render();
  return root;
}

/* -------------------------------- เพื่อนทุกคน -------------------------------- */

export function allFriendsPanel({ meta }) {
  const f = meta.followers;
  return el("div", { class: "bs-all-panel" },
    f && f.reach !== null
      ? el("div", { class: "bs-all-stat" },
          el("span", { class: "bs-all-num" }, Number(f.reach).toLocaleString("th-TH")),
          el("span", { class: "bs-all-copy" },
            el("strong", {}, "เพื่อนที่ส่งถึงได้ (ประมาณ)"),
            el("span", { class: "bs-muted" }, `เพื่อนทั้งหมด ${Number(f.followers).toLocaleString("th-TH")} − บล็อก ${Number(f.blocks || 0).toLocaleString("th-TH")} · สถิติ LINE วันที่ ${String(f.date || "").replace(/^(\d{4})(\d{2})(\d{2})$/u, "$3/$2/$1")}`)))
      : el("p", { class: "bs-empty" }, "ยังอ่านจำนวนเพื่อนจาก LINE ไม่ได้ — ระบบจะไม่รับงานส่งถึงเพื่อนทุกคนจนกว่าจะรู้ว่าโควตาพอ"),
    el("p", { class: "block-hint" }, "LINE นับโควตาเฉพาะคนที่ได้รับจริง (คนบล็อกไม่นับ) · ส่งผ่าน API บรอดแคสต์ของ LINE เลขคำขอถูกเก็บไว้ดูสถิติเปิดอ่าน/คลิกภายหลัง"),
  );
}
