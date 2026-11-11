// broadcastResults.mjs — แท็บ "ผลลัพธ์" ของสตูดิโอบรอดแคสต์ (28 ก.ย. 2026)
// ต่อแคมเปญ: สถานะ · ผู้รับ · คลิก (ลิงก์ของเรา) · สถิติ LINE (เปิดอ่าน/คลิก) · ตอบกลับใน 72 ชม. · ออเดอร์ใน 14 วัน
// ตัวเลขจาก LINE ต่ำกว่า 20 คน LINE ปิดค่าไว้ (ความเป็นส่วนตัว) — แสดงว่า "น้อยกว่า 20" ไม่ใช่ 0
import { el } from "./dom.mjs";
import { put } from "./broadcastState.mjs";
import { bubblesFromStored } from "./broadcastComposer.mjs";

const STATUS = {
  sending: ["กำลังส่ง", "is-sending"], done: ["ส่งแล้ว", "is-done"], partial: ["ส่งได้บางส่วน", "is-partial"], failed: ["ไม่สำเร็จ", "is-failed"],
};
const PHASE = {
  accepted: "LINE รับคำขอแล้ว", waiting: "LINE รอคิวส่ง", sending: "LINE กำลังส่ง", succeeded: "LINE ส่งเสร็จ",
  failed: "LINE ส่งไม่สำเร็จ", unknown: "ผลยังไม่ชัด — รอตรวจ", rejected: "LINE ปฏิเสธคำขอ",
  confirmed_delivered: "ยืนยันแล้วว่าส่งออก", confirmed_not_delivered: "ยืนยันแล้วว่าไม่ได้ส่ง",
};

function num(value) {
  return Number.isSafeInteger(value) ? value.toLocaleString("th-TH") : "—";
}

function insightValue(value) {
  if (value === null) return "น้อยกว่า 20";
  return Number.isSafeInteger(value) ? value.toLocaleString("th-TH") : "—";
}

function when(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return "";
  return new Date(t).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" });
}

export function campaignHeadline(campaign) {
  const messages = Array.isArray(campaign.messages) ? campaign.messages : [];
  const text = messages.find((m) => m?.type === "text")?.text;
  if (text) return String(text).slice(0, 90);
  const card = messages.find((m) => m?.type === "card");
  if (card) return `[การ์ด] ${card.cards?.[0]?.title || card.cards?.[0]?.text || ""}`.trim();
  if (messages.some((m) => m?.type === "image")) return "[รูปภาพ]";
  if (messages.some((m) => m?.type === "sticker")) return "[สติกเกอร์]";
  return "—";
}

export function campaignAudienceLine(campaign) {
  if (campaign.mode === "all") return "เพื่อนทุกคน";
  if (campaign.mode === "audience") {
    const count = (campaign.target?.include || []).length;
    const ex = (campaign.target?.exclude || []).length;
    return `กลุ่มเป้าหมาย LINE ${count} กลุ่ม${ex ? ` · เว้น ${ex} กลุ่ม` : ""}`;
  }
  if (campaign.mode === "demographic") {
    const t = campaign.target || {};
    const parts = [];
    if (t.gender?.length) parts.push(t.gender.map((g) => (g === "male" ? "ชาย" : "หญิง")).join("/"));
    if (t.age) parts.push(`อายุ ${t.age.gte ? t.age.gte.replace("age_", "") : ""}–${t.age.lt ? t.age.lt.replace("age_", "") : ""}`);
    if (t.area?.length) parts.push(`${t.area.length} ภูมิภาค`);
    if (t.appType?.length) parts.push(t.appType.join("/"));
    if (t.subscriptionPeriod) parts.push("ตามระยะเวลาเป็นเพื่อน");
    return `ข้อมูลประชากร: ${parts.join(" · ") || "—"}`;
  }
  const include = (campaign.includeTags || []).map((tag) => (tag === "*" ? "ทุกคนที่ระบบรู้จัก" : tag.replace(/:\*$/u, ": ทุกค่า")));
  const exclude = (campaign.excludeTags || []).map((tag) => tag.replace(/:\*$/u, ": ทุกค่า"));
  return `ป้าย: ${include.join(", ") || "—"}${exclude.length ? ` · เว้น ${exclude.join(", ")}` : ""}`;
}

function recipientsOf(campaign) {
  if (campaign.mode && campaign.mode !== "tags") {
    if (Number.isSafeInteger(campaign.line?.successCount)) return `${num(campaign.line.successCount)} คน`;
    if (Number.isSafeInteger(campaign.insight?.overview?.delivered)) return `${num(campaign.insight.overview.delivered)} คน`;
    return Number.isSafeInteger(campaign.estimate) ? `~${num(campaign.estimate)} คน` : "LINE คำนวณ";
  }
  return `${num(campaign.sentCount)}/${num(campaign.audienceCount)} คน`;
}

function metric(label, value, hint = "") {
  return el("div", { class: "bs-metric" },
    el("span", { class: "bs-metric-value" }, value),
    el("span", { class: "bs-metric-label" }, label),
    hint ? el("span", { class: "bs-metric-hint" }, hint) : null);
}

export function createBroadcastResultsTab({ api, toast }) {
  function detailView(campaign) {
    const outcomes = campaign.outcomes || {};
    const basis = outcomes.basis === "recipients" ? "ในผู้รับที่ระบบรู้ชื่อ"
      : outcomes.basis === "known_customers" ? "ประมาณจากลูกค้าที่ระบบรู้จัก (ส่งถึงเพื่อนทุกคน)"
        : "ไม่ทราบรายชื่อผู้รับ — ดูตัวเลขจาก LINE";
    const overview = campaign.insight?.overview || {};
    const summary = campaign.recipientSummary;
    return el("div", { class: "bs-detail" },
      el("div", { class: "bs-metrics" },
        metric("ตอบกลับใน 72 ชม.", outcomes.replied72h === null || outcomes.replied72h === undefined ? "—" : num(outcomes.replied72h), basis),
        metric("ออเดอร์ใน 14 วัน", outcomes.orders14d ? num(outcomes.orders14d.orders) : "—",
          outcomes.orders14d?.total ? `ยอด ${Number(outcomes.orders14d.total).toLocaleString("th-TH")} บาท` : basis),
        metric("คลิกลิงก์ของเรา", num(campaign.clicks), campaign.linkCount ? `${campaign.linkCount} ลิงก์` : "ไม่มีลิงก์"),
        campaign.insight
          ? metric("เปิดอ่าน (LINE)", insightValue(overview.uniqueImpression), `คลิก ${insightValue(overview.uniqueClick)}${overview.delivered !== undefined ? ` · ส่งถึง ${insightValue(overview.delivered)}` : ""}`)
          : metric("สถิติ LINE", "รอข้อมูล", campaign.mode === "tags" || !campaign.mode ? "LINE รวมสถิติหลังส่งไม่กี่ชั่วโมง" : "กดอัปเดตผลเพื่อถาม LINE"),
      ),
      campaign.line?.phase ? el("p", { class: "bs-muted" },
        `${PHASE[campaign.line.phase] || campaign.line.phase}${Number.isSafeInteger(campaign.line.targetCount) ? ` · เป้าหมาย ${num(campaign.line.targetCount)}` : ""}${Number.isSafeInteger(campaign.line.failureCount) && campaign.line.failureCount ? ` · ไม่ถึง ${num(campaign.line.failureCount)}` : ""}${campaign.line.error ? ` · ${campaign.line.error}` : ""}`) : null,
      summary ? el("p", { class: "bs-muted" },
        `ส่งแล้ว ${num(summary.sent)} · ตัดสิทธิ์ก่อนส่ง ${num(summary.skipped)} · ล้มเหลว ${num(summary.failed)} · ยกเลิก ${num(summary.cancelled)}${summary.unknown ? ` · รอตรวจ ${num(summary.unknown)}` : ""}`) : null,
      (campaign.links || []).length
        ? el("table", { class: "bs-links" },
            el("thead", {}, el("tr", {}, el("th", {}, "ลิงก์"), el("th", {}, "คลิก"))),
            el("tbody", {}, campaign.links.map((link) => el("tr", {},
              el("td", {}, link.label ? el("strong", {}, `${link.label} · `) : null, el("span", { class: "bs-link-url" }, link.url)),
              el("td", {}, num(link.clicks))))))
        : null,
      campaign.lastError ? el("p", { class: "bc-history-err" }, `สาเหตุ: ${campaign.lastError}`) : null,
      el("p", { class: "block-hint" }, "ตอบกลับ/ออเดอร์ = เกิดขึ้นหลังส่งในช่วงเวลานั้น ไม่ได้แปลว่าเกิดเพราะข้อความนี้ · คลิกตัดบอทพรีวิวลิงก์ออกเท่าที่ทำได้"),
    );
  }

  function campaignCard(campaign, { onTemplate, onChanged }) {
    const [label, tone] = campaign.cancelRequested
      ? [campaign.status === "sending" ? "กำลังหยุด" : "ยกเลิกแล้ว", "is-partial"]
      : (STATUS[campaign.status] || [campaign.status, ""]);
    const detailSlot = el("div", { class: "bs-detail-slot" });
    let open = false;
    const loadDetail = async (refresh = false) => {
      put(detailSlot, el("div", { class: "bs-skeleton", "aria-hidden": "true" }));
      try {
        const response = await api(`/console/api/broadcast/studio/campaigns/${encodeURIComponent(campaign.id)}${refresh ? "?refresh=1" : ""}`);
        put(detailSlot, detailView(response.campaign),
          el("button", { type: "button", class: "btn btn-outline btn-mini", onclick: () => loadDetail(true) }, "อัปเดตผลจาก LINE"));
      } catch (error) {
        put(detailSlot, el("p", { class: "bc-history-err" }, error.message));
      }
    };
    const detailButton = el("button", {
      type: "button", class: "btn btn-outline btn-mini", "aria-expanded": "false",
      onclick: () => {
        open = !open;
        detailButton.setAttribute("aria-expanded", open ? "true" : "false");
        detailButton.textContent = open ? "ซ่อนผลลัพธ์" : "ดูผลลัพธ์";
        if (open) loadDetail(false); else put(detailSlot);
      },
    }, "ดูผลลัพธ์");
    return el("article", { class: `bs-campaign ${tone}` },
      el("header", { class: "bs-campaign-head" },
        el("span", { class: `bs-status ${tone}` }, label),
        el("strong", { class: "bs-campaign-no" }, `#${campaign.broadcastNo}`),
        el("span", { class: "bs-badge" }, campaign.modeLabel || "ตามป้าย"),
        el("span", { class: "bs-muted" }, `${when(campaign.createdAt)} · โดย ${campaign.createdBy || "—"}`)),
      el("p", { class: "bs-campaign-text" }, campaignHeadline(campaign)),
      el("p", { class: "bs-muted bs-campaign-aud" }, campaignAudienceLine(campaign)),
      el("div", { class: "bs-campaign-stats" },
        el("span", {}, el("strong", {}, recipientsOf(campaign)), " ผู้รับ"),
        el("span", {}, el("strong", {}, num(campaign.clicks)), " คลิก"),
        campaign.insight?.overview ? el("span", {}, el("strong", {}, insightValue(campaign.insight.overview.uniqueImpression)), " เปิดอ่าน") : null,
        campaign.line?.phase ? el("span", { class: "bs-muted" }, PHASE[campaign.line.phase] || campaign.line.phase) : null),
      campaign.lastError && !open ? el("p", { class: "bc-history-err" }, campaign.lastError) : null,
      el("div", { class: "bs-campaign-actions" },
        detailButton,
        el("button", {
          type: "button", class: "btn btn-ghost btn-mini",
          onclick: () => onTemplate({
            mode: campaign.mode || "tags", includeTags: campaign.includeTags, excludeTags: campaign.excludeTags,
            target: campaign.target || {}, bubbles: bubblesFromStored(campaign.messages),
          }),
        }, "ใช้เป็นแม่แบบ"),
        campaign.status === "sending" && !campaign.cancelRequested ? el("button", {
          type: "button", class: "btn btn-danger btn-mini",
          onclick: async () => {
            if (!globalThis.window?.confirm?.(`ขอหยุดบรอดแคสต์ #${campaign.broadcastNo} ที่ขอบ batch ถัดไปหรือไม่?\nผู้รับใน batch ที่ LINE รับไปแล้วเรียกคืนไม่ได้`)) return;
            try {
              await api(`/console/api/broadcast/cancel/${encodeURIComponent(campaign.id)}`, { method: "POST", body: {} });
              toast(`รับคำขอหยุด #${campaign.broadcastNo} แล้ว`);
              onChanged();
            } catch (error) { toast(error.message); }
          },
        }, "หยุดส่ง") : null),
      detailSlot,
    );
  }

  function render({ channelId, campaigns = [], onTemplate, blocks = [] }) {
    const list = el("div", { class: "bs-campaigns" });
    const section = el("section", { class: "block bs-results" },
      el("div", { class: "bs-results-head" },
        el("h2", { class: "block-title" }, "ประวัติบรอดแคสต์"),
        el("span", { class: "bs-muted" }, "30 รายการล่าสุดของ OA นี้")),
      list);
    const paint = (rows) => {
      put(list, ...(rows.length
        ? rows.map((campaign) => campaignCard(campaign, { onTemplate, onChanged: refresh }))
        : [el("p", { class: "bs-empty" }, "ยังไม่เคยส่งบรอดแคสต์จาก OA นี้ — เริ่มที่แท็บ \"สร้างข้อความ\"")]));
    };
    let timer = null;
    const refresh = async () => {
      clearTimeout(timer);
      if (!section.isConnected && timer !== null) return;
      try {
        const fresh = await api(`/console/api/broadcast/studio/campaigns?channel=${encodeURIComponent(channelId)}`);
        paint(fresh.campaigns || []);
        if ((fresh.campaigns || []).some((c) => c.status === "sending")) timer = setTimeout(refresh, 4000);
      } catch { /* ผู้ใช้โหลดหน้าใหม่เองได้ */ }
    };
    paint(campaigns);
    if (campaigns.some((c) => c.status === "sending")) timer = setTimeout(refresh, 4000);
    return el("div", { class: "bs-results-wrap" }, ...blocks.filter(Boolean), section);
  }

  return { render };
}
