// context.mjs — แผงข้อมูลลูกค้าข้างห้องแชท (context pane)
// เดสก์ท็อป: คอลัมน์ขวา 340px พับได้ / มือถือ: แผ่นเลื่อนจากขวา เปิดจากปุ่ม "ข้อมูล"
// เนื้อหา: การ์ดลูกค้า (ชื่อจริง/score/ค่า AI) + คำแนะนำปิดการขาย + บันทึกส่งต่อ +
// นัด follow-up + ประวัติ escalate + export — ย้ายจาก console.js (คุมขนาดไฟล์ <800)
import { el, timeAgo } from "./dom.mjs";
import {
  customerLabel, avatarEl, scoreBadge, segmentOf, SEGMENT_META, TREND_LABELS,
  orderStatusBadge, orderItemsSummary, orderTotalLabel, followupSuppressionLabel, followupSuppressionBadge,
} from "./ui.mjs";
import { createExportControls } from "./exportUi.mjs";
import { createTagsPanel } from "./contextTags.mjs";
import { createIdentityLinksPanel } from "./identityLinks.mjs";

const DEAL_STEPS = Object.freeze(["ส่งราคา", "ส่งบัญชี", "รอตรวจยอด", "ยืนยันที่นั่ง"]);
const PAYMENT_REVIEW = /(?:payment_review|image_review|payment_requires_human_review)/u;

// Score is an observation, not a purchase probability or permission to pitch.
export function scoringStatus(score, customer = {}, now = Date.now()) {
  const insufficient = score?.payload?.score_assessment?.status === "insufficient_evidence";
  const at = Number(score?.at ?? customer.last_score_at);
  const stale = Number.isFinite(at) && at > 0 && now - at > 72 * 60 * 60_000;
  return { insufficient, stale,
    label: insufficient ? "ยังประเมินความพร้อมไม่ได้" : stale ? "คะแนนเก่า — เช็คความพร้อมปัจจุบันก่อน" : "คะแนนความสนใจ ไม่ใช่โอกาสซื้อเป็น %" };
}

// A-18 reads the existing lifecycle/event trail only. It does not infer that a
// bank transfer happened from a slip-check result, and it never turns a model
// result into a financial confirmation.
export function dealProgress({ lifecycle, lifecycleEvents = [], customer = {} } = {}) {
  const stage = String(lifecycle?.stage || "sales");
  const status = String(lifecycle?.dealStatus || "new");
  const events = Array.isArray(lifecycleEvents) ? lifecycleEvents : [];
  // A stage transition is DB-enforced as human-only. The event trail supplies
  // provenance for new confirmations, while the state still renders correctly
  // for an older, already-confirmed record whose historical event was absent.
  const confirmed = stage === "enrolled" && status === "paid_confirmed";
  const paymentReview = PAYMENT_REVIEW.test(String(customer?.handoff_summary || ""))
    || events.some((event) => PAYMENT_REVIEW.test(String(event?.trigger || "")));
  const priceSent = ["price_sent", "awaiting_round_choice", "awaiting_team_decision", "quote_sent", "awaiting_payment", "paid_confirmed", "prep_sent"].includes(status);
  const accountSent = ["awaiting_payment", "paid_confirmed", "prep_sent"].includes(status);
  const active = confirmed ? 3 : paymentReview ? 2 : accountSent ? 1 : priceSent ? 0 : -1;
  return {
    steps: DEAL_STEPS.map((label, index) => ({ label, done: index < active || (confirmed && index === active), active: index === active && !confirmed })),
    canConfirm: stage === "sales" && status === "awaiting_payment" && !confirmed,
    confirmed,
  };
}

// B7b: คำอธิบาย DISC / B.A.N.K. หนึ่งบรรทัด — แอดมินใหม่อ่านแล้วใช้ได้ทันที
const DISC_EXPLAIN = {
  D: "จ่าฝูง: ตรงประเด็น เน้นผลลัพธ์ ตัดสินใจเร็ว — อย่าอ้อม",
  I: "สายพลังบวก: ชอบคุย เรื่องเล่า รีวิว",
  S: "สายมั่นคง: ใจเย็น อย่าเร่ง เน้นความปลอดภัย/ประกัน",
  C: "สายข้อมูล: ต้องการสเปก ตัวเลข เปรียบเทียบครบ",
};
const BANK_EXPLAIN = {
  Blueprint: "สายแบบแผน: ชอบขั้นตอนชัด มีเอกสาร อย่าข้ามสเต็ป",
  Action: "สายลุย: ชอบเร็ว เน้นผลลัพธ์ พร้อมก็ปิดการขายได้เลย",
  Nurturing: "สายใส่ใจ: เน้นความสัมพันธ์ ครอบครัว ความรู้สึก",
  Knowledge: "สายวิชาการ: ชอบข้อมูลลึก มีหลักฐาน/งานวิจัยรองรับ",
};

// Opportunity Layer is deliberately separate from score/DISC/B.A.N.K.  It may only
// render the normalized state produced by the business policy; raw scorer JSON is
// an untrusted candidate and must never be made to look like a customer fact.
const JOURNEY_LABELS = {
  new_lead: "ลูกค้าใหม่ (ยืนยันจาก record)",
  returning_student: "ผู้เรียนเดิม (ยืนยันแล้ว)",
  progression_candidate: "มีพื้นฐานเดิม (ยืนยันแล้ว)",
  unknown: "ยังไม่ทราบ / ยังไม่ยืนยัน",
};

function identifierLabel(value) {
  return String(value || "")
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

// The backend uses camelCase for normalized state.  Keep aliases for a short
// migration window, but require enabled=true so payload.sales_signals (raw LLM
// output) cannot accidentally be displayed as verified state.
export function normalizedOpportunityState(payload = {}) {
  const candidates = [payload.salesState, payload.sales_state, payload.sales];
  const state = candidates.find((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
    && candidate.enabled === true);
  if (!state) return null;

  const opportunity = state.opportunity && typeof state.opportunity === "object" && !Array.isArray(state.opportunity)
    ? state.opportunity : null;
  const slots = Object.fromEntries(Object.entries(opportunity?.slots || {})
    .filter(([key, value]) => identifierLabel(key) && typeof value === "string" && value.trim())
    .map(([key, value]) => [identifierLabel(key), value.trim()]));
  const missingSlots = Array.isArray(opportunity?.missingSlots)
    ? opportunity.missingSlots.map(identifierLabel).filter(Boolean) : [];

  return {
    customerJourney: JOURNEY_LABELS[state.customerJourney] || JOURNEY_LABELS.unknown,
    decisionRole: typeof state.decisionRole === "string" && state.decisionRole.trim()
      ? identifierLabel(state.decisionRole) : "ยังไม่มีการยืนยัน",
    opportunity: opportunity && typeof opportunity.type === "string" && opportunity.type.trim()
      ? {
        type: identifierLabel(opportunity.type),
        slots,
        missingSlots,
        handoffReady: opportunity.handoffReady === true,
        upsizeEligible: opportunity.upsizeEligible === true,
      }
      : null,
  };
}

export function createContextPane({ api, toast, state }) {
  // 28 ก.ย. 2026: แผง "ช่องทางอื่นของลูกค้าคนนี้" (Facebook ↔ LINE) อยู่ไฟล์ของตัวเอง
  const identityLinksPanel = createIdentityLinksPanel({ api, toast, state });
  // B8c: ค่าใช้จ่าย AI สะสมของลูกค้า — THB นำ, ไม่รู้ราคา = "—" (tolerant)
  function costChip(aiCost) {
    if (!aiCost) return null;
    const fmt = (v) => (Math.abs(v) < 10
      ? v.toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : Math.round(v).toLocaleString("th-TH"));
    const incomplete = aiCost.unknownTokens > 0 || aiCost.unknownCacheWriteCalls > 0;
    const label = aiCost.usd > 0 ? `AI ≈฿${fmt(aiCost.thb)}${incomplete ? "+" : ""}` : incomplete ? "AI —" : "AI ฿0";
    return el("span", {
      class: "cost-chip",
      title: `ประมาณการต้นทุน AI สะสมจาก token ที่บันทึก รวมร่างที่ไม่ได้ส่งและราคาแคช ไม่ใช่ใบแจ้งหนี้จริง ($${(aiCost.usd || 0).toFixed(4)} @${Number(aiCost.thbPerUsd || 0).toFixed(2)}฿/$)${aiCost.unknownTokens > 0 ? " · ยังมี token ที่ไม่ทราบราคา" : ""}${aiCost.unknownCacheWriteCalls > 0 ? ` · ${aiCost.unknownCacheWriteCalls} รายการไม่มีข้อมูลต้นทุนเขียนแคช ยอดจริงอาจสูงกว่านี้` : ""}`,
    }, label);
  }

  // การ์ดหัวแผง: อวตารใหญ่ + ชื่อ + segment + score + แก้ชื่อจริง (F2)
  function customerCard(customerId, customer, score, aiCost, refresh) {
    const assessment = scoringStatus(score, customer);
    const seg = segmentOf(customer);
    const nameInput = el("input", {
      class: "name-input keep-focus", type: "text", maxlength: "60",
      placeholder: "ชื่อจริงลูกค้า (จากแชท)", value: customer.known_name || "",
    });
    const saveBtn = el("button", {
      class: "btn btn-outline btn-mini",
      onclick: async () => {
        saveBtn.disabled = true;
        try {
          await api(`/console/api/customers/${encodeURIComponent(customerId)}/name`, {
            method: "POST", body: { knownName: nameInput.value.trim() },
          });
          toast("บันทึกชื่อแล้ว");
          await refresh();
        } catch (err) {
          toast(err.message);
          saveBtn.disabled = false;
        }
      },
    }, "บันทึก");
    const ownerSelect = el("select", {
      class: "owner-select keep-focus",
      "aria-label": "ผู้รับผิดชอบบทสนทนา",
      onchange: async (event) => {
        ownerSelect.disabled = true;
        try {
          await api(`/console/api/customers/${encodeURIComponent(customerId)}/owner`, {
            method: "POST", body: { owner: event.target.value },
          });
          toast(event.target.value ? "มอบหมายผู้รับผิดชอบแล้ว" : "ยกเลิกผู้รับผิดชอบแล้ว");
          await refresh();
        } catch (err) {
          toast(err.message);
          ownerSelect.disabled = false;
        }
      },
    },
      el("option", { value: "", selected: !customer.human_owner }, "ยังไม่มอบหมาย"),
      (state.operators || []).map((operator) => el("option", {
        value: operator.username,
        selected: customer.human_owner === operator.username,
      }, operator.displayName || operator.username)),
    );

    return el("div", { class: "ctx-card" },
      el("div", { class: "ctx-id" },
        avatarEl(customer, { size: "lg" }),
        el("span", { class: "ctx-id-main" },
          el("strong", { class: "ctx-name" }, customerLabel(customer)),
          el("span", { class: "ctx-sub" },
            `${String(customerId).startsWith("facebook:") ? "Facebook" : "LINE"}: …${String(customerId).slice(-8)} `,
            // v1.2: copy user id ตัวเต็ม (raw LINE id — customerId หลายสาขาเป็น "<ch>:<uid>")
            // ใช้ตั้งผู้รับแจ้งเตือนทีมในหน้าตั้งค่า — ดูขั้นตอนใน "วิธีหา LINE user ID"
            el("button", {
              class: "btn btn-outline btn-mini ctx-copy-id",
              onclick: async (e) => {
                const raw = String(customerId).includes(":")
                  ? String(customerId).split(":").slice(1).join(":")
                  : String(customerId);
                try {
                  await navigator.clipboard.writeText(raw);
                  toast("คัดลอก user ID แล้ว — เอาไปวางในตั้งค่า > แจ้งทีม ได้เลย");
                } catch {
                  window.prompt("คัดลอก user ID:", raw); // คลิปบอร์ดไม่ให้สิทธิ์ — ให้ copy มือ
                }
              },
            }, "คัดลอก user ID"),
          ),
        ),
      ),
      el("div", { class: "ctx-score-row" },
        el("span", { class: `seg-chip seg-chip-${seg}`, title: assessment.label },
          assessment.insufficient ? "ข้อมูลยังไม่พอ" : `${SEGMENT_META[seg].icon} ${SEGMENT_META[seg].label}`),
        (assessment.insufficient ? null : scoreBadge(score?.score ?? customer.last_score))
          ?? el("span", { class: "score-badge score-none" }, assessment.insufficient ? "ยังไม่ทราบ" : "ยังไม่มี score"),
        !assessment.insufficient && score?.payload?.trend
          ? el("span", { class: `trend trend-${score.payload.trend}` }, TREND_LABELS[score.payload.trend] || "")
          : null,
        costChip(aiCost),
      ),
      el("p", { class: "muted" }, assessment.label),
      el("div", { class: "name-edit" },
        el("label", {}, "ชื่อจริง:"), nameInput, saveBtn,
      ),
      el("div", { class: "owner-edit" },
        el("label", {}, "ผู้รับผิดชอบ:"), ownerSelect,
      ),
    );
  }

  // F3: คำแนะนำการปิดการขายจาก scorer ล่าสุด — "ใช้คำถามนี้" เทลงกล่องตอบ
  function salesPanel(score, textarea) {
    const payload = score?.payload;
    if (!payload) return null;
    const persona = payload.persona_read || {};
    const opportunityState = normalizedOpportunityState(payload);
    const opportunity = opportunityState?.opportunity;
    const opportunityLayer = opportunityState
      ? el("section", { class: "opportunity-layer", "aria-label": "Opportunity Layer" },
          el("p", { class: "opportunity-title" }, "Opportunity Layer"),
          el("p", { class: "opportunity-note" },
            "ข้อมูลนี้ผ่าน policy เพื่อช่วยเก็บ requirement — ทีมต้องยืนยันก่อนเสนอราคา นัดหมาย หรือดำเนินการ"),
          el("div", { class: "opportunity-row" },
            el("span", { class: "opportunity-key" }, "Customer journey (ยืนยันแล้ว)"),
            el("span", { class: "opportunity-value" }, opportunityState.customerJourney),
          ),
          el("div", { class: "opportunity-row" },
            el("span", { class: "opportunity-key" }, "บทบาทผู้ตัดสินใจ (ระบุชัดเจน)"),
            el("span", { class: "opportunity-value" }, opportunityState.decisionRole),
          ),
          opportunity
            ? [
              el("div", { class: "opportunity-row" },
                el("span", { class: "opportunity-key" }, "ประเภทโอกาส (ตาม policy)"),
                el("span", { class: "opportunity-value" }, opportunity.type),
              ),
              el("div", { class: "opportunity-slots" },
                el("span", { class: "opportunity-key" }, "ข้อมูลที่เก็บได้จากบทสนทนา"),
                Object.keys(opportunity.slots).length
                  ? el("dl", { class: "opportunity-slot-list" }, Object.entries(opportunity.slots).map(([key, value]) => [
                      el("dt", {}, key), el("dd", {}, value),
                    ]))
                  : el("span", { class: "opportunity-empty" }, "ยังไม่มี"),
              ),
              el("div", { class: "opportunity-slots" },
                el("span", { class: "opportunity-key" }, "ยังต้องเก็บ"),
                opportunity.missingSlots.length
                  ? el("div", { class: "chip-row opportunity-chips" }, opportunity.missingSlots.map((slot) =>
                      el("span", { class: "chip opportunity-missing" }, slot)))
                  : el("span", { class: "opportunity-empty" }, "ครบตาม policy"),
              ),
              el("div", { class: "opportunity-status" },
                el("span", { class: `chip ${opportunity.handoffReady ? "opportunity-ready" : "opportunity-pending"}` },
                  opportunity.handoffReady ? "พร้อมให้ทีมรับช่วง" : "เก็บ requirement ยังไม่ครบ"),
                el("span", { class: `chip ${opportunity.upsizeEligible ? "opportunity-ready" : "opportunity-pending"}` },
                  opportunity.upsizeEligible ? "เข้าเงื่อนไขให้ทีมพิจารณาต่อ" : "ยังไม่เข้าเงื่อนไขพิจารณาต่อ"),
              ),
            ]
            : el("p", { class: "opportunity-empty" }, "ยังไม่มี Opportunity ที่เข้า policy"),
        )
      : null;
    return el("details", {
      class: "panel sales-panel", ...(state.ui.salesOpen ? { open: "" } : {}),
      ontoggle: (e) => { state.ui.salesOpen = e.target.open; },
    },
      el("summary", {}, payload.score_assessment?.status === "insufficient_evidence"
        ? "แนวทางคุยต่อ — ข้อมูลยังไม่พอประเมินความพร้อม"
        : `แนวทางคุยต่อ (ความสนใจ ${payload.score}/10)`),
      payload.next_move ? el("p", { class: "panel-text" }, payload.next_move) : null,
      payload.suggested_question
        ? el("div", { class: "panel-row" },
            el("p", { class: "panel-text panel-question" }, `ถามต่อ: ${payload.suggested_question}`),
            el("button", {
              class: "btn btn-outline btn-mini",
              onclick: () => {
                textarea.value = payload.suggested_question;
                textarea.dispatchEvent(new Event("input"));
                textarea.focus();
              },
            }, "ใช้คำถามนี้"),
          )
        : null,
      el("div", { class: "chip-row" },
        // ธุรกิจที่เลิกใช้ DISC (4 ต.ค. 2026): ผลใหม่มีธง disc_retired — ไม่โชว์ป้าย DISC อีก
        !payload.disc_retired && persona.disc && persona.disc !== "unknown" ? el("span", { class: "chip" }, `DISC: ${persona.disc}`) : null,
        persona.bank && persona.bank !== "unknown" ? el("span", { class: "chip" }, `B.A.N.K.: ${persona.bank}`) : null,
        ...(payload.buying_signals || []).map((s) => el("span", { class: "chip chip-signal" }, s)),
      ),
      !payload.disc_retired && DISC_EXPLAIN[persona.disc] ? el("p", { class: "chip-explain" }, `DISC ${persona.disc} — ${DISC_EXPLAIN[persona.disc]}`) : null,
      BANK_EXPLAIN[persona.bank] ? el("p", { class: "chip-explain" }, `B.A.N.K. ${persona.bank} — ${BANK_EXPLAIN[persona.bank]}`) : null,
      persona.reason ? el("p", { class: "panel-sub" }, persona.reason) : null,
      opportunityLayer,
    );
  }

  // B6: บันทึกส่งต่อ (handoff notes) — Enter ส่งได้, โน้ต ai_auto หน้าตาต่างจากโน้ตคน
  function notesPanel(customerId, notes, refresh) {
    const input = el("textarea", {
      class: "note-input keep-focus", rows: "2", maxlength: "500",
      placeholder: "พิมพ์บันทึกส่งต่อ (⌘/Ctrl+Enter บันทึก)",
    });
    async function submit() {
      const text = input.value.trim();
      if (!text) return;
      try {
        await api(`/console/api/customers/${encodeURIComponent(customerId)}/notes`, {
          method: "POST", body: { text },
        });
        input.value = "";
        state.ui.notesOpen = true;
        toast("บันทึกแล้ว — AI จะเห็นโน้ตนี้ทุกครั้งที่ร่างคำตอบ");
        await refresh();
      } catch (err) {
        toast(err.message);
      }
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });

    function noteRow(n) {
      const isAuto = n.author === "ai_auto";
      return el("div", { class: `note-row${isAuto ? " is-auto" : ""}${n.pinned ? " is-pinned" : ""}` },
        el("span", { class: "note-main" },
          el("span", { class: "note-meta" }, `${isAuto ? "AI (อัตโนมัติ)" : n.author || "ทีมงาน"} · ${timeAgo(n.created_at)}`),
          el("span", { class: "note-text" }, n.text),
        ),
        el("button", {
          class: "icon-del note-pin", "aria-label": n.pinned ? "เลิกปักหมุดบันทึก" : "ปักหมุดบันทึก",
          title: n.pinned ? "เลิกปักหมุด" : "ปักหมุด",
          onclick: async () => {
            try {
              await api(`/console/api/notes/${encodeURIComponent(n.id)}/pin`, { method: "POST", body: { pinned: !n.pinned } });
              state.ui.notesOpen = true;
              toast(n.pinned ? "เลิกปักหมุดแล้ว" : "ปักหมุดแล้ว");
              await refresh();
            } catch (err) { toast(err.message); }
          },
        }, n.pinned ? "📌" : "☆"),
        el("button", {
          class: "icon-del", "aria-label": "ลบบันทึก", title: "ลบบันทึก",
          onclick: async () => {
            try {
              await api(`/console/api/notes/${encodeURIComponent(n.id)}/delete`, { method: "POST", body: {} });
              state.ui.notesOpen = true;
              toast("ลบบันทึกแล้ว");
              await refresh();
            } catch (err) {
              toast(err.message);
            }
          },
        }, "✕"),
      );
    }

    const list = notes || [];
    return el("details", {
      class: "panel notes-panel", ...(state.ui.notesOpen ? { open: "" } : {}),
      ontoggle: (e) => { state.ui.notesOpen = e.target.open; },
    },
      el("summary", {}, `บันทึกส่งต่อ (handoff)${list.length ? ` (${list.length})` : ""}`),
      list.length
        ? el("div", { class: "note-list" }, list.map(noteRow))
        : el("p", { class: "panel-sub" }, "ยังไม่มีบันทึก — โน้ตที่เขียนตรงนี้ AI อ่านก่อนตอบทุกครั้ง"),
      el("div", { class: "panel-row" },
        input,
        el("button", { class: "btn btn-primary btn-mini", onclick: submit }, "ส่ง"),
      ),
    );
  }

  // F5+F6: นัด follow-up + ล้างประวัติ (test phase)
  function followupPanel(customerId, customer, followups, followupGlobal, refresh, { appointmentArmed = true } = {}) {
    const pending = (followups || []).filter((f) => f.status === "pending");
    const fuOn = customer.followup_enabled === 1;
    const suppressionReason = followupSuppressionLabel(customer);

    async function createFollowup(scheduledAt, note) {
      if (suppressionReason) {
        toast("ห้องนี้ไม่ต้องติดตาม — เปิดติดตามคืนก่อนตั้งนัดใหม่");
        return;
      }
      try {
        await api(`/console/api/customers/${encodeURIComponent(customerId)}/followups`, {
          method: "POST", body: { scheduledAt, note },
        });
        toast("ตั้งนัด follow-up แล้ว");
        state.ui.fuOpen = true;
        await refresh();
      } catch (err) {
        toast(err.message);
      }
    }
    function presetAt(daysAhead) {
      const d = new Date();
      d.setDate(d.getDate() + daysAhead);
      d.setHours(10, 0, 0, 0); // preset ทุกตัวนัด 10:00 (นอก quiet hours เสมอ)
      return d.getTime();
    }

    const noteInput = el("input", {
      class: "fu-note keep-focus", type: "text", maxlength: "300",
      placeholder: "โน้ตให้ AI (ไม่บังคับ) เช่น ลูกค้ารอเลือกรอบเรียนที่สะดวก",
    });
    const customInput = el("input", { class: "fu-when keep-focus", type: "datetime-local" });

    return el("details", {
      class: "panel fu-panel", ...(state.ui.fuOpen ? { open: "" } : {}),
      ontoggle: (e) => { state.ui.fuOpen = e.target.open; },
    },
      el("summary", {}, `นัด follow-up${pending.length ? ` (ค้าง ${pending.length})` : ""}`),
      suppressionReason ? el("p", { class: "panel-warn" }, followupSuppressionBadge(customer), ` ${suppressionReason} — จะหยุดติดตามจนกว่าทีมเปิดคืน`) : null,
      // audit 2026-08-26: คำเตือนเดิมบอกแค่เรื่องสวิตช์ ทำให้เข้าใจว่า "เปิดสวิตช์แล้วจะส่ง"
      // แต่บนเครื่องนี้ตัวจับเวลานัดหมายถูกตรึงเป็น 0 = ไม่มีวันส่ง ต่อให้เปิดสวิตช์ก็ตาม
      // นัดที่ชมพู่ตั้งไว้จะถูกบันทึก ถูกนับ แต่ไม่เคยถูกส่ง ต้องบอกตรง ๆ ก่อนเขากด
      appointmentArmed === false
        ? el("p", { class: "panel-warn" }, "ระบบนัดหมายยังไม่ติดเครื่องบนเซิร์ฟเวอร์นี้ — นัดที่บันทึกไว้จะถูกเก็บไว้ แต่ยังไม่ถูกส่งออกไป")
        : (!followupGlobal
          ? el("p", { class: "panel-warn" }, "สวิตช์ follow-up ทั้งระบบปิดอยู่ — นัดจะยังไม่ถูกส่งจนกว่าจะเปิดจากหน้าภาพรวม")
          : null),
      el("div", { class: "panel-row" },
        el("button", {
          class: `btn btn-mini ${fuOn ? "btn-outline" : "btn-danger"}`,
          onclick: async () => {
            if (suppressionReason && !window.confirm(`เปิดติดตามของ ${customerLabel(customer)} คืนหรือไม่?\nเหตุผลที่หยุด: ${suppressionReason}\nระบบอาจส่งข้อความติดตามใหม่ตามกติกา แต่นัดเดิมที่ยกเลิกจะไม่กลับมา`)) return;
            try {
              await api(`/console/api/customers/${encodeURIComponent(customerId)}/followup`, {
                method: "POST", body: { enabled: !fuOn },
              });
              toast(!fuOn ? "เปิด follow-up ลูกค้าคนนี้แล้ว" : "ปิด follow-up ลูกค้าคนนี้แล้ว");
              state.ui.fuOpen = true;
              await refresh();
            } catch (err) {
              toast(err.message);
            }
          },
        }, suppressionReason ? "เปิดติดตามคืน" : fuOn ? "follow-up ลูกค้านี้: เปิดอยู่" : "follow-up ลูกค้านี้: ปิดอยู่"),
        customer.do_not_disturb === 1 ? el("span", { class: "badge badge-red" }, "ลูกค้าขอไม่ให้ทัก") : null,
      ),
      pending.length
        ? el("div", { class: "fu-list" },
            pending.map((f) => el("div", { class: "fu-row" },
              el("span", { class: "fu-when-label" },
                new Date(f.scheduled_at).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })),
              f.note ? el("span", { class: "fu-note-label" }, f.note) : null,
              el("button", {
                class: "btn btn-danger btn-mini",
                onclick: async () => {
                  try {
                    await api(`/console/api/followups/${encodeURIComponent(f.id)}/cancel`, { method: "POST", body: {} });
                    toast("ยกเลิกนัดแล้ว");
                    state.ui.fuOpen = true;
                    await refresh();
                  } catch (err) {
                    toast(err.message);
                  }
                },
              }, "ยกเลิก"),
            )),
          )
        : null,
      el("div", { class: "panel-row fu-presets" },
        // B5: นัดเร็วภายในวัน — ตกใน quiet hours engine จะเลื่อนไป 09:00 ให้เอง
        el("button", { class: "btn btn-outline btn-mini", onclick: () => createFollowup(Date.now() + 3_600_000, noteInput.value.trim()) }, "อีก 1 ชม."),
        el("button", { class: "btn btn-outline btn-mini", onclick: () => createFollowup(presetAt(1), noteInput.value.trim()) }, "พรุ่งนี้ 10:00"),
        el("button", { class: "btn btn-outline btn-mini", onclick: () => createFollowup(presetAt(3), noteInput.value.trim()) }, "อีก 3 วัน"),
        el("button", { class: "btn btn-outline btn-mini", onclick: () => createFollowup(presetAt(7), noteInput.value.trim()) }, "อีก 7 วัน"),
      ),
      el("div", { class: "panel-row" },
        customInput,
        el("button", {
          class: "btn btn-primary btn-mini",
          onclick: () => {
            const t = new Date(customInput.value).getTime();
            if (!Number.isFinite(t)) {
              toast("เลือกวันเวลาก่อนนะคะ");
              return;
            }
            createFollowup(t, noteInput.value.trim());
          },
        }, "ตั้งนัดเอง"),
      ),
      el("div", { class: "panel-row" }, noteInput),
      // Reset for test and PDPA forget are separate owner-only actions. The
      // server enforces the same role and CSRF boundary.
      state.me?.role === "owner" ? el("div", { class: "danger-zone" },
        el("button", {
          class: "btn btn-danger btn-mini",
          onclick: async () => {
            // audit 2026-08-26: ปุ่มนี้ลบประวัติลูกค้าจริงถาวร แต่คำยืนยันเดิมไม่บอกว่า
            // "ลูกค้าคนไหน" ผลคือพลาดกดในห้องผิดแล้วไม่มีทางรู้ตัวก่อนกดตกลง
            // อันตรายจริงคือ "ลบผิดคน" ไม่ใช่ "กดโดยไม่ตั้งใจ" — คำยืนยันจึงต้องมีชื่อ
            const who = String(customer?.display_name || customer?.known_name || customerId);
            if (!window.confirm(
              `ล้างประวัติของ "${who}" ทั้งหมด (ข้อความ/score/นัด/คำแก้)\n\n`
              + "นี่คือลูกค้าจริงในระบบ ไม่ใช่ห้องทดสอบ — ตรวจชื่อให้ตรงก่อนกดตกลง\n"
              + "กู้คืนได้จากไฟล์สำรองของคืนก่อนหน้าเท่านั้น",
            )) return;
            try {
              await api(`/console/api/customers/${encodeURIComponent(customerId)}/reset`, { method: "POST", body: {} });
              toast("ล้างประวัติแล้ว — เริ่มทดสอบใหม่ได้เลย");
              await refresh();
            } catch (err) {
              toast(err.message);
            }
          },
        }, "ล้างประวัติ (ทดสอบ)"),
        el("button", {
          class: "btn btn-danger btn-mini",
          onclick: async () => {
            const confirmation = window.prompt(
              "ลบตัวตน ประวัติ ป้าย ออเดอร์ และไฟล์ของลูกค้าคนนี้ถาวร\n"
              + "ระบบจะเก็บเฉพาะ hash tombstone เพื่อกันข้อมูลกลับมาจาก backup\n\n"
              + "ถ้าห้องนี้เคยใช้รูปจากคลังสาธารณะเดิม ระบบจะหยุดและให้ทีมตรวจรูปก่อน โดยจะยังไม่ลบข้อมูลใด ๆ\n\n"
              + "พิมพ์ ลืมลูกค้า เพื่อยืนยัน",
            );
            if (confirmation !== "ลืมลูกค้า") return;
            try {
              await api(`/console/api/customers/${encodeURIComponent(customerId)}/forget`, {
                method: "POST", body: { confirm: confirmation },
              });
              toast("ลืมลูกค้าแล้ว — เก็บเฉพาะ tombstone สำหรับการกู้คืน");
              window.location.hash = "#/chat";
            } catch (err) {
              toast(err.message);
            }
          },
        }, "ลืมลูกค้า (PDPA)"),
      ) : null,
    );
  }

  // G6 (P2): ออเดอร์ค้างของลูกค้าคนนี้ — สรุปสั้น + ลิงก์ไปหน้าออเดอร์ + สร้างร่างใหม่
  function ordersPanel(customerId, orders, refresh) {
    const open = orders || [];
    const createBtn = el("button", {
      class: "btn btn-outline btn-mini",
      onclick: async () => {
        createBtn.disabled = true;
        try {
          const resp = await api("/console/api/orders", { method: "POST", body: { customerId } });
          toast(`สร้างออเดอร์ร่าง #${resp.order.order_no} แล้ว — ไปเติมรายการที่หน้าออเดอร์`);
          await refresh();
        } catch (err) {
          toast(err.message);
          createBtn.disabled = false;
        }
      },
    }, "+ สร้างออเดอร์ร่าง");
    return el("details", {
      class: "panel orders-panel", ...(open.length ? { open: "" } : {}),
    },
      el("summary", {}, `ออเดอร์${open.length ? ` (ค้าง ${open.length})` : ""}`),
      open.length
        ? el("div", { class: "order-mini-list" }, open.map((o) =>
            el("a", { class: "order-mini", href: "#/orders" },
              orderStatusBadge(o.status, state.features?.orderMode),
              el("span", { class: "order-mini-main" },
                el("span", { class: "order-mini-title" }, `#${o.order_no} · ${orderItemsSummary(o, 44)}`),
                el("span", { class: "order-mini-sub" }, orderTotalLabel(o.total)),
                // v1.1: ธงข้อมูลจัดส่ง — เห็นตั้งแต่ข้างห้องแชท ไม่ต้องรอเปิดหน้าออเดอร์
                // 7 ต.ค. 2026 โหมดคลาส: ข้อมูลผู้เรียน (ไม่มีที่อยู่จัดส่ง)
                (o.shippingWarnings || []).length
                  ? el("span", { class: "order-mini-warn" }, `⚠ ${state.features?.orderMode === "class" ? "ข้อมูลผู้เรียน" : "ข้อมูลจัดส่ง"}ต้องทวน (${o.shippingWarnings.length})`)
                  : (o.shipping ? null : el("span", { class: "order-mini-warn order-mini-warn-soft" },
                      state.features?.orderMode === "class" ? "ยังไม่มีข้อมูลผู้เรียน" : "ยังไม่มีที่อยู่จัดส่ง")),
              ),
              el("span", { class: "order-mini-cta" }, "›"),
            )))
        : el("p", { class: "panel-sub" }, "ยังไม่มีออเดอร์ค้าง — ระบบสร้างร่างให้อัตโนมัติเมื่อลูกค้าตกลงซื้อในแชท"),
      el("div", { class: "panel-row" }, createBtn),
    );
  }

  function dealPanel(customerId, customer, lifecycle, lifecycleEvents, refresh) {
    const progress = dealProgress({ lifecycle, lifecycleEvents, customer });
    const canConfirm = progress.canConfirm && state.me?.capabilities?.includes("payments.confirm") === true;
    const confirmBtn = canConfirm ? el("button", {
      class: "btn btn-primary btn-mini",
      onclick: async () => {
        if (!window.confirm("ตรวจยอดเข้าบัญชีจริงแล้วใช่ไหม?\nการกดนี้จะบันทึกว่าได้รับชำระเงิน แต่จะไม่ส่งข้อความหาลูกค้า")) return;
        confirmBtn.disabled = true;
        try {
          const result = await api(`/console/api/customers/${encodeURIComponent(customerId)}/confirm-payment`, {
            method: "POST", body: { confirm: true },
          });
          toast(result.changed ? "บันทึกยืนยันยอดแล้ว — ระบบไม่ส่งข้อความหาลูกค้า" : "รายการนี้ยืนยันยอดแล้ว");
          await refresh();
        } catch (err) {
          toast(err.message);
          confirmBtn.disabled = false;
        }
      },
    }, "ยืนยันยอด (คนกด)") : null;
    return el("section", { class: "panel deal-panel" },
      el("h3", { class: "panel-title" }, "ดีล"),
      el("div", { class: "deal-steps", "aria-label": "สถานะดีล" }, progress.steps.map((step) =>
        el("span", { class: `deal-step${step.done ? " is-done" : ""}${step.active ? " is-active" : ""}` },
          el("span", { class: "deal-step-dot", "aria-hidden": "true" }), step.label,
        ))),
      progress.confirmed
        ? el("p", { class: "panel-sub deal-note" }, "ยืนยันยอดโดยทีมแล้ว — ไม่ได้ส่งข้อความอัตโนมัติ")
        : el("p", { class: "panel-sub deal-note" }, "การยืนยันยอดต้องตรวจบัญชีจริงและกดโดย Super Admin หรือ Admin เท่านั้น"),
      confirmBtn ? el("div", { class: "panel-row" }, confirmBtn) : null,
    );
  }

  function exportPanel(customerId) {
    return el("details", {
      class: "panel export-panel", ...(state.ui.exportOpen ? { open: "" } : {}),
      ontoggle: (e) => { state.ui.exportOpen = e.target.open; },
    },
      el("summary", {}, "Export แชทคนนี้ (CSV)"),
      el("div", { class: "panel-row" },
        createExportControls({ scope: "customer", customerId, buttonLabel: "ดาวน์โหลด CSV" }),
      ),
    );
  }

  function escalatePanel(customer) {
    if (!customer.handoff_summary) return null;
    return el("details", { class: "panel handoff", ...(customer.state === "NEEDS_HUMAN" ? { open: "" } : {}) },
      el("summary", {}, "ประวัติแจ้งเตือนระบบ (escalate)"),
      el("pre", { class: "handoff-text" }, customer.handoff_summary),
    );
  }

  /* --------------------- v1.1 (item 7): chat tags ของลูกค้า --------------------- */
  // 28 ก.ย. 2026: แผงป้ายย้ายไป contextTags.mjs — จัดกลุ่มตามมิติของกรอบป้ายชุดเดียว (สวิตช์ปิด = แผงแบบเดิม)
  // 3 ที่มา: 🟦 rfm (ระบบคำนวณจากออเดอร์/ประวัติการซื้อ) / 🟪 ai (จากบทสนทนา) / 🟩 human (ทีมติดเอง)
  // โหลดกรอบครั้งแรกตอนเปิดห้องแรก (ไม่ยิงตอนสร้างหน้า — ก่อน /me ยืนยัน session)
  const tagsPanel = createTagsPanel({ api, toast });

  // 2026-08-24: เคสที่ระบบไม่เสนอ candidate เอง (ชื่อซ้ำหลายห้อง / หาไม่เจอ / เคยปฏิเสธ)
  // ให้แอดมินค้นชื่อ → เห็นห้องเก่าที่ชื่อตรง → เปิดตรวจ → กดโยงเอง (server ตรวจซ้ำทุกชั้น)
  function legacyManualPanel(customerId, customer, tags, refresh) {
    const link = String(customer?.legacy_link || "");
    if (link.startsWith("candidate:") || link.startsWith("linked:")) return null;
    // ห้องอ้างอิงระบบเก่าเองไม่มีสิทธิ์โยงต่อ (กันวนลูป legacy→legacy)
    if ((tags || []).some((row) => row.tag === "ย้ายจาก LINE OA")) return null;
    const list = el("div", { class: "panel-rows" });
    const input = el("input", {
      class: "note-input keep-focus", type: "text",
      placeholder: "ค้นชื่อโปรไฟล์ในระบบเก่า (ตรงทั้งชื่อ)",
      value: customer?.display_name || "",
    });
    async function search() {
      list.replaceChildren(el("p", { class: "panel-sub" }, "กำลังค้น…"));
      try {
        const q = input.value.trim();
        const resp = await api(`/console/api/customers/${encodeURIComponent(customerId)}/legacy-candidates?q=${encodeURIComponent(q)}`);
        const rows = resp.candidates || [];
        if (!rows.length) {
          list.replaceChildren(el("p", { class: "panel-sub" }, "ไม่พบห้องระบบเก่าชื่อนี้ (ต้องตรงทั้งชื่อ)"));
          return;
        }
        list.replaceChildren(...rows.map((row) => el("div", { class: "panel-row" },
          el("a", { href: `#/c/${encodeURIComponent(row.id)}`, class: "panel-text legacy-candidate-link" },
            `${row.displayName || "(ไม่มีชื่อ)"} · ${Number(row.messages || 0).toLocaleString("th-TH")} ข้อความ ›`),
          row.linkedBy
            ? el("span", { class: "panel-sub" }, "ถูกโยงแล้ว")
            : el("button", {
                class: "btn btn-outline btn-mini",
                onclick: async () => {
                  if (!window.confirm(`ยืนยันโยง "${customer?.display_name || customerId}" กับห้องเก่า "${row.displayName}"?
ป้ายและสถานะของห้องเก่าจะถูกคัดลอกมา`)) return;
                  try {
                    const result = await api(`/console/api/customers/${encodeURIComponent(customerId)}/legacy-link`, {
                      method: "POST", body: { action: "link", legacyId: row.id },
                    });
                    toast(`โยงแล้ว · คัดลอกป้าย ${result.copied?.length || 0} ป้าย`);
                    await refresh();
                  } catch (err) { toast(err.message); }
                },
              }, "โยงห้องนี้"),
        )));
      } catch (err) {
        list.replaceChildren(el("p", { class: "panel-sub" }, err.message));
      }
    }
    return el("details", { class: "panel handoff" },
      el("summary", {}, link.startsWith("ambiguous:")
        ? `โยงห้องระบบเก่า (ชื่อซ้ำ ${link.slice("ambiguous:".length)} ห้อง — ต้องเทียบมือ)`
        : "โยงห้องระบบเก่า (เทียบมือ)"),
      el("p", { class: "panel-sub" },
        "ระบบโยงให้เองเฉพาะชื่อตรงห้องเดียว เคสนี้ต้องคนเทียบ: เปิดห้องเก่าอ่านประวัติก่อน แล้วค่อยกดโยง"),
      el("div", { class: "panel-row" }, input, el("button", { class: "btn btn-outline btn-mini", onclick: search }, "ค้น")),
      list,
    );
  }

  function legacyLinkPanel(customerId, customer, refresh) {
    if (!String(customer?.legacy_link || "").startsWith("candidate:")) return null;
    const act = async (action) => {
      try {
        const result = await api(`/console/api/customers/${encodeURIComponent(customerId)}/legacy-link`, {
          method: "POST", body: { action },
        });
        toast(action === "confirm"
          ? `ยืนยันโยงแล้ว · คัดลอกป้าย ${result.copied?.length || 0} ป้าย`
          : "ปฏิเสธ candidate แล้ว — ไม่คัดลอกข้อมูล");
        await refresh();
      } catch (err) {
        toast(err.message);
      }
    };
    return el("details", { class: "panel handoff", open: "" },
      el("summary", {}, "ตรวจการโยงห้องระบบเก่า"),
      el("p", { class: "panel-sub" },
        "พบห้องเก่าชื่อตรงกันหนึ่งห้อง ระบบพัก AI ไว้ก่อนและยังไม่คัดลอกป้าย กรุณาค้นชื่อเดียวกันเพื่อตรวจห้องอ้างอิง แล้วค่อยเลือกด้านล่าง"),
      el("div", { class: "panel-row" },
        el("button", { class: "btn btn-primary btn-mini", onclick: () => act("confirm") }, "ยืนยันว่าเป็นคนเดียวกัน"),
        el("button", { class: "btn btn-outline btn-mini", onclick: () => act("reject") }, "ไม่ใช่คนเดียวกัน"),
      ),
    );
  }

  // ประกอบแผงทั้งใบ — closeContext มาจาก chat.mjs (มือถือ: ปิดแผ่นเลื่อน)
  function build({ customerId, customer, score, followups, followupGlobal, followupAppointmentArmed = true, handoffNotes, aiCost, orders, tags, lifecycle, lifecycleEvents, identityLinks = null, textarea, refresh, closeContext }) {
    return el("aside", { class: "context-pane", "aria-label": "ข้อมูลลูกค้า" },
      el("div", { class: "ctx-head" },
        el("strong", {}, "ข้อมูลลูกค้า"),
        el("button", { class: "icon-btn ctx-close", "aria-label": "ปิดแผงข้อมูล", onclick: closeContext }, "✕"),
      ),
      el("div", { class: "ctx-scroll", "data-scroll-key": `customer:${customerId}` },
        customerCard(customerId, customer, score, aiCost, refresh),
        identityLinksPanel.build({ customerId, customer, data: identityLinks, refresh }),
        legacyLinkPanel(customerId, customer, refresh),
        legacyManualPanel(customerId, customer, tags, refresh),
        tagsPanel(customerId, tags, refresh), // v1.1 item 7
        salesPanel(score, textarea),
        dealPanel(customerId, customer, lifecycle, lifecycleEvents, refresh),
        ordersPanel(customerId, orders, refresh), // G6
        notesPanel(customerId, handoffNotes, refresh),
        followupPanel(customerId, customer, followups, followupGlobal, refresh,
          { appointmentArmed: followupAppointmentArmed !== false }),
        escalatePanel(customer),
        exportPanel(customerId),
      ),
    );
  }

  return { build };
}
