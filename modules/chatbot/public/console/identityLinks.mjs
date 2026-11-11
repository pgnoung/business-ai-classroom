// identityLinks.mjs — แผง "ช่องทางอื่นของลูกค้าคนนี้" ในห้องแชท (28 ก.ย. 2026)
//
// พี่ง้วง: ลูกค้าทักจาก Facebook จนซื้อ แล้วย้ายเข้า LINE OA — ทีมต้องเห็นว่าสองห้องคือคนเดียวกัน
// ข้อมูลมาพร้อมห้องแชท (identityLinks ใน /conversations/:id/messages) จึงไม่กระพริบตอนรีเฟรช
//   · ห้องที่เชื่อมกันแล้ว + ป้ายช่องทาง + ปุ่มเปิดห้อง · owner/admin ยกเลิกการเชื่อมได้ (ยืนยันก่อนเสมอ)
//   · ห้อง Facebook: เลือกคลาสที่ลูกค้าซื้อ (เลือกไว้ให้จากหลักฐาน) → ปุ่มส่งลิงก์ LINE (ตามสวิตช์ identity_link_mode)
//     พร้อมเหตุผลเมื่อกดไม่ได้ + ดูข้อความที่จะส่งได้ก่อน (รหัสปิดไว้) — ลูกค้าที่ยังไม่ซื้อไม่มีข้อความเชิญ (คำตอบพี่ง้วง)
//   · owner/admin: รายการห้องที่อาจเป็นคนเดียวกัน (เบอร์/อีเมลตรง = หลักฐาน · ชื่อคล้าย = คำใบ้) → คนกดยืนยันเท่านั้น
// ทุกค่าเข้า DOM ผ่าน el() (text node) · ไม่มี inline style (CSP) — หน้าตาอยู่ที่ identityLinks.css
import { el, isGeneric, timeAgo } from "./dom.mjs";

// ข้อความตรงกับ INVITE_BLOCKERS ฝั่งเซิร์ฟเวอร์ (src/consoleIdentityLinkApi.mjs)
export const INVITE_BLOCKER_TEXT = Object.freeze({
  mode_off: "สวิตช์ \"ส่งลิงก์ต่อแชท LINE\" ยังปิดอยู่ — เปิดได้ที่ ตั้งค่า › สวิตช์พฤติกรรมลูกแพร",
  no_secret: "ระบบยังไม่มีกุญแจสำหรับออกรหัส",
  no_basic_id: "ยังไม่รู้ LINE ID ของ OA (ถาม LINE ไม่สำเร็จ) — ลองโหลดหน้าใหม่อีกครั้ง",
  send_disabled: "ช่อง Facebook ยังไม่เปิดส่งข้อความจริง",
  window_closed: "เกิน 24 ชม. หลังข้อความล่าสุดของลูกค้า — Meta ไม่ให้ทักก่อน รอลูกค้าทักมาแล้วค่อยส่ง",
  too_many: "ส่งลิงก์ห้องนี้ครบ 3 ครั้งใน 24 ชม. แล้ว",
});

// ที่มาของคลาสที่เลือกไว้ให้ (identityLink.detectClass)
const SUGGEST_TEXT = Object.freeze({
  last: "เลือกไว้ให้ตามลิงก์ที่ทีมส่งครั้งก่อน",
  purchase: "เลือกไว้ให้จากออเดอร์/ป้ายซื้อแล้วของห้องนี้",
  interest: "เลือกไว้ให้จากป้ายสนใจ — ตรวจให้ตรงกับที่ลูกค้าซื้อจริงก่อนส่ง",
});

const VIA_TEXT = Object.freeze({ code: "ลูกค้าส่งรหัสยืนยันเอง", team: "ทีมงานเชื่อมเอง", suggestion: "ทีมงานยืนยันจากรายการแนะนำ" });
// 30 ก.ย. 2026: จังหวะเวลา (ลิงก์เชิญที่ยังไม่มีใครใช้ ↔ ห้อง LINE ใหม่) — คำใบ้ ไม่ใช่หลักฐาน ต้องให้คนดูบริบทก่อนเชื่อม
const REASON_TEXT = Object.freeze({
  phone: "เบอร์ตรงกัน", email: "อีเมลตรงกัน", name: "ชื่อคล้าย (ไม่ใช่หลักฐาน)", search: "ค้นเจอจากชื่อ",
  invite: "ส่งลิงก์เชิญก่อนห้องนี้แอดไลน์ · ยังไม่มีใครใช้", new_friend: "แอดไลน์หลังเราส่งลิงก์เชิญ",
});

// "ห่าง 12 นาที" / "ห่าง 3 ชม." — จังหวะเวลาระหว่างส่งลิงก์กับแอดไลน์ (ใกล้ = น่าจะใช่มากกว่า)
function gapText(ms) {
  const minutes = Math.max(1, Math.round(Number(ms) / 60_000));
  return minutes < 60 ? `ห่าง ${minutes} นาที` : `ห่าง ${Math.round(minutes / 60)} ชม.`;
}

const isFacebook = (channelId) => String(channelId || "") === "facebook";
const domKey = (id) => String(id).replace(/[^a-z0-9]/giu, "");
// "ส่งไปเมื่อสักครู่" / "ส่งไปเมื่อ 5 นาทีก่อน" / "ส่งไปเมื่อ 3/10" — timeAgo คืนแค่ตัวเลขกับหน่วย
const sentAgo = (ms) => {
  const ago = timeAgo(ms);
  if (!ago) return "";
  if (ago === "ตอนนี้") return "ส่งลิงก์ไปเมื่อสักครู่";
  if (!/นาที|ชม\./u.test(ago)) return `ส่งลิงก์ไปเมื่อ ${ago}`;
  return `ส่งลิงก์ไปเมื่อ ${ago}${ago.endsWith(".") ? " " : ""}ก่อน`;
};
const dateText = (ms) => {
  const d = new Date(Number(ms));
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("th-TH", { day: "numeric", month: "short" }) : "";
};

function channelBadge(channelId, label) {
  return el("span", { class: `idl-badge ${isFacebook(channelId) ? "idl-badge-fb" : "idl-badge-line"}` },
    label || (isFacebook(channelId) ? "Facebook" : "LINE"));
}

function roomLink(id) {
  return el("a", { class: "idl-open", href: `#/c/${encodeURIComponent(id)}` }, "เปิดห้อง ›");
}

export function createIdentityLinksPanel({ api, toast, state }) {
  const base = (customerId) => `/console/api/customers/${encodeURIComponent(customerId)}/identity`;

  async function unlink(customerId, row, refresh) {
    const ok = window.confirm(
      `ยกเลิกการเชื่อมกับห้อง ${row.channelLabel} "${row.name}"?\n`
      + "• ป้ายและสรุปที่คัดลอกมาตอนเชื่อมจะถูกถอนออก (ป้ายที่ทีมติดเองทีหลังไม่แตะ)\n"
      + "• AI ที่ระบบปิดเพราะการเชื่อมจะเปิดคืน · ทำใหม่ได้ด้วยการเชื่อมอีกครั้ง",
    );
    if (!ok) return;
    try {
      const result = await api(`${base(customerId)}/unlink`, { method: "POST", body: { confirm: true } });
      toast(result.reopened?.length ? "ยกเลิกการเชื่อมแล้ว — เปิด AI คืนให้ห้องที่ระบบเคยปิด" : "ยกเลิกการเชื่อมแล้ว");
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  }

  function linkedList(customerId, data, refresh) {
    if (!data.linked.length) return null;
    return el("ul", { class: "idl-list", "aria-label": "ห้องที่เป็นลูกค้าคนเดียวกัน" },
      data.linked.map((row) => el("li", { class: "idl-item" },
        el("div", { class: "idl-item-head" },
          channelBadge(row.channelId, row.channelLabel),
          el("strong", { class: "idl-name" }, row.name),
          roomLink(row.id),
        ),
        row.classLabel ? el("p", { class: "idl-class-badge" }, `ซื้อ ${row.classLabel}`) : null,
        el("p", { class: "idl-meta" },
          `เชื่อมเมื่อ ${dateText(row.linkedAt)} · ${VIA_TEXT[row.linkedVia] || row.linkedVia}`
            + (row.linkedBy ? ` (${row.linkedBy})` : "")
            + (row.aiEnabled ? "" : " · AI ในห้องนั้นปิดอยู่")
            + (row.needsHuman ? " · รอทีมดูแล" : "")),
        data.canManage
          ? el("button", { class: "btn btn-outline btn-mini idl-unlink", onclick: () => unlink(customerId, row, refresh) }, "ยกเลิกการเชื่อม")
          : null,
      )),
    );
  }

  function inviteStatus(invite, labels) {
    if (!invite.lastSentAt) return "";
    const cls = labels.get(invite.lastClassType);
    const sent = `${sentAgo(invite.lastSentAt)}${cls ? ` (${cls})` : ""}`;
    if (invite.lastStatus === "active") return `${sent} · ใช้ได้ถึง ${dateText(invite.lastExpiresAt)} · ยังไม่มีใครกดใช้ (ส่งใหม่ = ลิงก์เก่าใช้ไม่ได้)`;
    if (invite.lastStatus === "expired") return "ลิงก์ล่าสุดหมดอายุแล้ว — ส่งใหม่ได้";
    return invite.lastStatus === "consumed" ? "ลิงก์ล่าสุดถูกใช้แล้ว" : "ลิงก์ล่าสุดถูกแทนหรือยกเลิกแล้ว";
  }

  // ปุ่มเลือกคลาส (radiogroup) + ปุ่มส่ง — ต้องเลือกคลาสก่อนเสมอ (ข้อความเชิญ/รายละเอียดหลังเชื่อมต่างกันตามคลาส)
  function inviteBlock(customerId, customer, data, refresh) {
    const invite = data.invite;
    if (!invite || invite.blocker === "already_linked") return null;
    const blocked = Boolean(invite.blocker);
    const key = domKey(customerId);
    const classes = Array.isArray(invite.classes) ? invite.classes : [];
    const labels = new Map(classes.map((row) => [row.type, row.label]));
    state.ui.identityInviteClass ||= {};
    // ลำดับ: ที่เพิ่งเลือกในหน้านี้ > คลาสของลิงก์ที่ทีมส่งครั้งก่อน (คนเลือกเอง) > คำใบ้จากหลักฐานในห้อง
    const preset = labels.has(invite.lastClassType) ? { type: invite.lastClassType, from: "last" }
      : labels.has(invite.suggestedClass) ? { type: invite.suggestedClass, from: invite.suggestedFrom } : { type: "", from: "" };
    let selected = labels.has(state.ui.identityInviteClass[customerId]) ? state.ui.identityInviteClass[customerId] : preset.type;
    const previewText = el("pre", { class: "idl-preview-text" });
    const button = el("button", {
      class: "btn btn-primary btn-mini idl-invite", "aria-describedby": `idl-invite-hint-${key}`,
      onclick: async () => {
        if (!selected) return;
        const who = customer?.known_name || customer?.display_name || "ลูกค้า";
        if (!window.confirm(`ส่งข้อความเชิญ (${labels.get(selected)}) พร้อมลิงก์ LINE ${data.lineBasicId} ให้ "${who}" ทาง Facebook?\n`
          + "ลูกค้ากดลิงก์แล้วกดส่งใน LINE = สองห้องเชื่อมกันเอง และลูกค้าได้คำทักทาย + รายละเอียดของคลาสนี้ทันที")) return;
        button.disabled = true;
        try {
          await api(`${base(customerId)}/invite`, { method: "POST", body: { classType: selected } });
          toast(`ส่งลิงก์แล้ว (${labels.get(selected)}) — รอลูกค้ากดส่งข้อความใน LINE`);
          await refresh();
        } catch (err) {
          toast(err.message);
          button.disabled = blocked || !selected;
        }
      },
    }, "ส่งลิงก์ LINE ให้ลูกค้า");
    const radios = classes.map((row) => el("button", {
      type: "button", class: "idl-class", role: "radio", "data-class": row.type,
      "aria-checked": row.type === selected ? "true" : "false", disabled: blocked,
      onclick: () => choose(row.type),
      onkeydown: (event) => {
        const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        event.preventDefault?.();
        const next = radios[(radios.indexOf(event.currentTarget ?? event.target) + step + radios.length) % radios.length];
        next?.focus?.();
        if (next) choose(next.getAttribute("data-class"));
      },
    },
      el("span", { class: "idl-class-label" }, row.label),
      el("span", { class: "idl-class-hint" }, row.hint)));
    const suggest = el("p", { class: "idl-hint idl-suggest-note" });
    function choose(type) {
      selected = type;
      state.ui.identityInviteClass[customerId] = type;
      for (const radio of radios) radio.setAttribute("aria-checked", radio.getAttribute("data-class") === type ? "true" : "false");
      button.disabled = blocked || !selected;
      previewText.textContent = invite.previews?.[selected] || "";
      suggest.textContent = selected && selected === preset.type ? (SUGGEST_TEXT[preset.from] || "")
        : selected ? "เลือกเองแล้ว — ข้อความเชิญและรายละเอียดหลังเชื่อมจะเป็นของคลาสนี้"
          : invite.candidates?.length > 1
            ? `ห้องนี้มีหลักฐานหลายคลาส (${invite.candidates.map((type) => labels.get(type)).filter(Boolean).join(" · ")}) — เลือกคลาสที่ลูกค้าซื้อจริง`
            : "เลือกคลาสที่ลูกค้าซื้อก่อนส่ง";
    }
    choose(selected);
    const last = inviteStatus(invite, labels);
    return el("div", { class: "idl-invite-block" },
      el("p", { class: "idl-classes-title", id: `idl-classes-${key}` }, "ลูกค้าซื้อคลาสไหน"),
      el("div", { class: "idl-classes", role: "radiogroup", "aria-labelledby": `idl-classes-${key}` }, radios),
      blocked ? null : suggest,
      !blocked && !invite.buyerEvidence
        ? el("p", { class: "idl-hint idl-warn" }, "ห้องนี้ยังไม่ได้ติดป้าย customer — ถ้าลูกค้าชำระแล้ว ติดป้าย customer ด้วยเพื่อให้ AI ฝั่ง Facebook หยุดขาย")
        : null,
      blocked ? null : el("details", { class: "idl-preview" },
        el("summary", {}, "ดูข้อความที่จะส่งทาง Facebook"),
        previewText,
        el("p", { class: "idl-meta" }, "รหัสจริงสร้างตอนกดส่ง — ในตัวอย่างปิดไว้เป็น LK-•••••-•••••")),
      el("div", { class: "panel-row" }, button),
      el("p", { class: `idl-hint${blocked ? " is-blocked" : ""}`, id: `idl-invite-hint-${key}` },
        blocked
          ? (INVITE_BLOCKER_TEXT[invite.blocker] || "ตอนนี้ส่งลิงก์ไม่ได้")
          : "เฉพาะลูกค้าที่ชำระ/ลงทะเบียนแล้ว — เอกสาร การเตรียมตัว และกลุ่ม support จะไปทาง LINE"),
      last ? el("p", { class: "idl-meta" }, last) : null,
    );
  }

  async function linkTo(customerId, customer, row, refresh) {
    const here = customer?.known_name || customer?.display_name || "ห้องนี้";
    const ok = window.confirm(
      `ยืนยันว่า "${here}" กับห้อง ${row.channelLabel} "${row.name}" เป็นลูกค้าคนเดียวกัน?\n`
      + (row.strong ? `หลักฐาน: ${row.reasons.map((r) => REASON_TEXT[r] || r).join(" · ")}\n`
        : "ไม่มีหลักฐานแน่นหนา (ชื่อคล้ายเป็นแค่คำใบ้) — เปิดอ่านทั้งสองห้องก่อนกด\n")
      + "ห้อง LINE จะได้ป้าย สถานะ และสรุปจากห้อง Facebook — ถ้าซื้อแล้ว AI ในห้อง LINE จะเงียบและทีมดูแลเอง",
    );
    if (!ok) return;
    try {
      const result = await api(`${base(customerId)}/link`, {
        method: "POST", body: { otherId: row.id, via: row.strong ? "suggestion" : "team", confirm: true },
      });
      toast(result.buyer ? "เชื่อมแล้ว — ลูกค้าที่ซื้อแล้ว: ห้อง LINE ติดป้าย customer และ AI เงียบ" : "เชื่อมเป็นลูกค้าคนเดียวกันแล้ว");
      await refresh();
    } catch (err) {
      toast(err.message);
    }
  }

  function suggestionRow(customerId, customer, row, refresh) {
    return el("li", { class: `idl-item idl-suggest${row.strong ? " is-strong" : ""}` },
      el("div", { class: "idl-item-head" },
        channelBadge(row.channelId, row.channelLabel),
        el("strong", { class: "idl-name" }, row.name),
        roomLink(row.id),
      ),
      el("div", { class: "idl-reasons" },
        row.reasons.map((reason) => el("span", { class: `idl-reason idl-reason-${reason}` }, REASON_TEXT[reason] || reason)),
        row.timingMs != null ? el("span", { class: "idl-meta-inline" }, gapText(row.timingMs)) : null,
        row.lastMessageAt ? el("span", { class: "idl-meta-inline" }, `คุยล่าสุด ${timeAgo(row.lastMessageAt)}`) : null,
        row.linkedElsewhere ? el("span", { class: "idl-meta-inline" }, "มีห้องเชื่อมอยู่แล้ว") : null,
      ),
      el("button", { class: "btn btn-outline btn-mini idl-link", onclick: () => linkTo(customerId, customer, row, refresh) }, "เชื่อมเป็นคนเดียวกัน"),
    );
  }

  function suggestBlock(customerId, customer, data, refresh) {
    if (!data.canManage) return null;
    const list = el("ul", { class: "idl-list", "aria-live": "polite" });
    const input = el("input", {
      class: "note-input keep-focus idl-search", type: "search", maxlength: "60",
      placeholder: "ค้นชื่อห้องในช่องทางอื่น", "aria-label": "ค้นชื่อห้องในช่องทางอื่น",
      onkeydown: (event) => { if (event.key === "Enter" && !event.isComposing) load(input.value.trim()); },
    });
    async function load(q = "") {
      list.replaceChildren(el("li", { class: "idl-empty" }, "กำลังค้น…"));
      try {
        const res = await api(`${base(customerId)}/suggestions${q ? `?q=${encodeURIComponent(q)}` : ""}`);
        const rows = res.suggestions || [];
        list.replaceChildren(...(rows.length
          ? rows.map((row) => suggestionRow(customerId, customer, row, refresh))
          : [el("li", { class: "idl-empty" }, q ? "ไม่พบห้องชื่อนี้ในช่องทางอื่น" : "ยังไม่พบห้องที่เบอร์/อีเมล/ชื่อใกล้เคียง — ลองค้นชื่อ")]));
      } catch (err) {
        list.replaceChildren(el("li", { class: "idl-empty" }, err.message));
      }
    }
    return el("details", {
      class: "idl-suggest-box", ...(state.ui.identitySuggestOpen ? { open: "" } : {}),
      ontoggle: (event) => {
        state.ui.identitySuggestOpen = event.target.open;
        if (event.target.open && !list.childElementCount) load();
      },
    },
      el("summary", {}, "หาห้องที่อาจเป็นคนเดียวกัน"),
      el("p", { class: "idl-hint" }, "ระบบแค่แนะนำ — ไม่เชื่อมเองจากชื่อเด็ดขาด ต้องมีคนตรวจแล้วกดยืนยัน"),
      el("div", { class: "panel-row" }, input, el("button", { class: "btn btn-outline btn-mini", onclick: () => load(input.value.trim()) }, "ค้น")),
      list,
    );
  }

  /** แผงทั้งใบ — data = identityLinks จากห้องแชท (null = เซิร์ฟเวอร์ไม่ส่งมา ไม่ต้องโชว์) */
  function build({ customerId, customer, data, refresh }) {
    // white-label: ร้านทั่วไปไม่มีการเชื่อมห้อง FB↔LINE — ไม่วาดแผงเลย
    if (!data || isGeneric(state)) return null;
    const facebook = isFacebook(customer?.channel_id);
    const count = data.linked.length;
    const hasContent = count || data.invite || data.canManage;
    if (!hasContent) return null;
    return el("section", { class: "panel idl-panel", "aria-labelledby": `idl-title-${domKey(customerId)}` },
      el("h3", { class: "panel-title idl-title", id: `idl-title-${domKey(customerId)}` },
        "ช่องทางอื่นของลูกค้าคนนี้",
        count ? el("span", { class: "idl-count" }, `${count} ห้อง`) : null),
      !facebook && data.purchasedClass
        ? el("p", { class: "idl-purchased" }, "คลาสที่ซื้อ (ทีมเลือกตอนส่งลิงก์): ", el("strong", {}, data.purchasedClass.label))
        : null,
      count
        ? linkedList(customerId, data, refresh)
        : el("p", { class: "idl-hint" }, facebook
          ? `ยังไม่ได้เชื่อมกับห้อง LINE — ส่งลิงก์ให้ลูกค้ากดยืนยันเอง${data.canManage
            ? " หรือเชื่อมจากรายการด้านล่างถ้ารู้แน่ว่าเป็นคนเดียวกัน" : " (ถ้ารู้แน่ว่าเป็นคนเดียวกัน ให้ Super Admin/Admin เชื่อมให้)"}`
          : `ยังไม่ได้เชื่อมกับห้องช่องทางอื่น (เช่น ห้อง Facebook ที่ลูกค้าเคยคุยก่อนย้ายมา LINE)${data.canManage
            ? "" : " — Super Admin/Admin เชื่อมให้ได้"}`),
      facebook ? inviteBlock(customerId, customer, data, refresh) : null,
      suggestBlock(customerId, customer, data, refresh),
    );
  }

  return { build };
}
