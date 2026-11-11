// settings.mjs — หน้า "ตั้งค่า" (#/settings): โมเดล AI + Follow-up + เวลาทำการของบอท
// หน้านี้ไม่ poll — operator กำลังกรอกฟอร์ม ห้าม re-render ทับ (บทเรียน correction queue)
import { el, brandCopy, isGeneric } from "./dom.mjs";
import { fxLine, priceLabelThb, priceLabelUsd, switchDot } from "./ui.mjs";
import { publishLabel, publishQueueBlock, publishQueueHint, publishToast } from "./publishQueue.mjs";
import { brainVersionsBlock } from "./brainVersions.mjs";
import { claudeExportTestersBlock } from "./settingsClaude.mjs";
import { adWelcomeQuestionBlock } from "./settingsAdWelcome.mjs";
import { behaviorSwitchesBlock } from "./settingsBehaviorSwitches.mjs";
import { identityLinkTemplatesBlock } from "./settingsIdentityLink.mjs";
import { hashtagTagsBlock } from "./settingsHashtagTags.mjs";
import { webPushBlock } from "./webPushUi.mjs";
import { telegramControlBlock } from "./telegramSettings.mjs";

// Settings is deliberately a single DOM tree. Selecting an OA only toggles
// visibility of its rows: re-rendering here would silently discard a draft in
// another OA's addendum / notification form.
export function selectedChannelId(channels, requestedId) {
  const list = Array.isArray(channels) ? channels.filter((channel) => channel?.id) : [];
  if (!list.length) return null;
  return list.some((channel) => channel.id === requestedId) ? requestedId : list[0].id;
}

export function productRulesStarter() {
  return [
    "ข้อเสนอ <ชื่อสินค้า/บริการ>: เหมาะกับลูกค้าที่ <ลักษณะความต้องการ> — เปิดเรื่องเมื่อลูกค้าพูดถึง <ปัญหา/เป้าหมาย>",
    "ลูกค้าที่ซื้อ <ข้อเสนอ A> แล้ว: ห้ามเสนอ <ข้อเสนอ A> ซ้ำ — เสนอ <บริการต่อเนื่อง/อุปกรณ์เสริม/ขั้นถัดไป> เมื่อบริบทเหมาะ",
    "ลูกค้าป้าย <มูลค่าสูง/พร้อมตัดสินใจ>: เริ่มจากทางเลือกที่ตรงความต้องการ ไม่ต้องบังคับเริ่มจากแพ็กเกจเล็ก",
    "ลูกค้าป้าย <ห่างหาย>: ถามสารทุกข์หรือเป้าหมายก่อน อย่าเพิ่งขาย",
    "ข้อเสนอที่ไม่ควรซื้อซ้ำ: อย่าชวนซื้อซ้ำ — เสนอการดูแล ผลลัพธ์ต่อเนื่อง หรือทางเลือกถัดไปแทน",
  ].join("\n");
}

export function businessDisplayName(state) {
  return state?.branding?.name || "ธุรกิจนี้";
}

export function businessKeywordRows(value) {
  const current = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return Object.entries(current).map(([tag, entry]) => {
    const structured = entry && typeof entry === "object" && !Array.isArray(entry);
    return {
      tag,
      seed: String((structured ? entry.seed : entry) || ""),
      note: String((structured ? entry.note : "") || ""),
      deliveryText: String((structured ? entry.deliveryText : "") || ""),
      bare: !String(tag).startsWith("#") && !String(tag).startsWith("@"),
    };
  });
}

export function businessKeywordMap(rows) {
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    const rawTag = String(row?.tag || "").trim().toLowerCase();
    const seed = String(row?.seed || "").trim();
    const note = String(row?.note || "").trim();
    const deliveryText = String(row?.deliveryText || "").trim();
    if (!rawTag || !seed) continue;
    const prefixed = rawTag.startsWith("#") || rawTag.startsWith("@");
    const tag = prefixed || row?.bare === true || deliveryText ? rawTag : `#${rawTag}`;
    out[tag] = note || deliveryText
      ? { seed, ...(note ? { note } : {}), ...(deliveryText ? { deliveryText } : {}) }
      : seed;
  }
  return out;
}

export function scorerSuggestionsControl({ enabled = false, api, toast }) {
  let current = enabled === true;
  const status = el("span", { class: "switch-state" });
  const toggle = el("button", {
    type: "button", class: "switch-line", role: "switch",
    "aria-label": "สร้างคำแนะนำสำหรับทีมงาน",
    onclick: async () => {
      if (toggle.disabled) return;
      toggle.disabled = true;
      try {
        const result = await api("/console/api/settings/suggestions", { method: "POST", body: { enabled: !current } });
        current = result.enabled === true;
        update();
        toast(current ? "เปิดสร้างคำแนะนำในรอบวิเคราะห์ถัดไปแล้ว" : "ปิดสร้างคำแนะนำแล้ว — คะแนนและการตอบแชทยังทำงาน");
      } catch (err) { toast(err.message); }
      finally { toggle.disabled = false; }
    },
  }, status);
  function update() {
    toggle.setAttribute("aria-checked", String(current));
    status.textContent = current ? "เปิด — สร้างคำแนะนำ" : "ปิด — ไม่สร้างคำแนะนำ";
    status.className = `switch-state ${current ? "is-on-text" : "is-off-text"}`;
  }
  update();
  return el("section", { class: "scorer-suggestions-control" },
    el("h3", {}, "คำแนะนำสำหรับทีมงาน (Suggestion)"),
    el("p", { class: "block-hint" }, "ปิด = ไม่ขอให้ AI สร้างแนวทางคุยต่อหรือคำถามแนะนำ และไม่นำคำแนะนำเก่ากลับมาใช้ คะแนน บริบทลูกค้า และการตอบแชทยังทำงานและใช้ token ตามปกติ"),
    toggle,
    el("p", { class: "block-hint" }, "มีผลทั้ง LINE และ Facebook ในรอบวิเคราะห์ถัดไป งานที่เริ่มแล้วอาจจบอีกหนึ่งรอบ · ร่างที่ถูกบล็อกยังแจ้งเตือนให้ทีมตรวจ"),
  );
}

export function createSettingsPage({ api, toast, mount, pageHeader, tabBar, stopPolling, setView, state }) {
  const can = (capability) => state?.me?.capabilities?.includes(capability) === true;
  const sharedScopeLine = () => el("p", { class: "settings-shared-scope" },
    `ใช้ร่วมทุก LINE OA ภายใต้ ${businessDisplayName(state)} — เปลี่ยนที่นี่มีผลทั้งธุรกิจ`);

  // 2 ก.ย. 2026 (คำสั่งพี่ง้วง): "เผยแพร่" ของที่เปลี่ยนสมองลูกแพร = สิทธิ์เจ้าของ
  // จงใจ "ไม่ซ่อนทั้งบล็อก" ต่างจากกล่องเงิน/กล่องต่อสาย — ชมพู่ต้องเปิดดูราคาและกติกา
  // ปัจจุบันตอนคุยกับลูกค้าอยู่ทุกวัน ซ่อนไปเท่ากับทำให้ทำงานไม่ได้
  //
  // Package K (คำสั่งเดียวกัน): เลิกล็อกช่องกรอกแล้ว — ทีมงานแก้ได้ตามปกติ กดแล้ว
  // เซิร์ฟเวอร์เก็บเป็น "คำขอ" รอพี่ง้วงกดอนุมัติ (202 queued) หน้าเว็บจึงเปลี่ยนแค่
  // ป้ายปุ่มกับข้อความ toast — ห้ามเดาเองว่าจะได้ 200 หรือ 202 เพราะสิทธิ์เปลี่ยนได้
  // ระหว่างที่หน้าเปิดค้างอยู่ (ดู publishQueue.mjs)
  function createScope(chData, brainData) {
    const businessName = businessDisplayName(state);
    // The channel inventory is the normal source of truth. If that optional
    // request fails, keep the page useful with the already-scoped brain rows
    // instead of hiding every OA-specific setting behind an empty selector.
    const channels = chData?.channels?.length ? chData.channels : (brainData?.channels || []);
    const rows = [];
    let currentId = selectedChannelId(channels, state?.settingsChannel);
    const brainByChannel = new Map((brainData?.channels || []).map((channel) => [channel.id, channel]));
    const brainValue = el("strong", { class: "settings-context-value" });
    const select = el("select", {
      class: "model-select keep-focus settings-oa-select",
      "aria-label": "เลือก LINE OA ที่ต้องการตั้งค่า",
    });
    for (const channel of channels) {
      const option = el("option", { value: channel.id }, channel.name || channel.id);
      if (channel.id === currentId) option.selected = true;
      select.append(option);
    }
    const apply = (requestedId) => {
      currentId = selectedChannelId(channels, requestedId);
      if (state) state.settingsChannel = currentId;
      for (const row of rows) {
        const visible = row.channelId === currentId;
        row.node.hidden = !visible;
        row.node.classList.toggle("is-oa-hidden", !visible);
      }
      const brain = brainByChannel.get(currentId);
      brainValue.textContent = brain?.mode === "separate"
        ? `สมองแยกของ ${channels.find((channel) => channel.id === currentId)?.name || currentId}`
        : "สมองกลางร่วมของธุรกิจ";
      if (currentId) select.value = currentId;
    };
    select.addEventListener("change", () => apply(select.value));
    return {
      channels,
      register(channelId, node) {
        rows.push({ channelId, node });
        node.dataset.oaId = channelId;
        apply(currentId);
        return node;
      },
      block: el("section", { class: "block settings-context" },
        el("h2", { class: "block-title" }, "ขอบเขตการตั้งค่า"),
        el("p", { class: "block-hint" }, "เลือก OA เพื่อดูค่าที่ผูกกับช่องทางนั้น โดย draft ของ OA อื่นยังคงอยู่ ไม่ถูกล้าง"),
        el("dl", { class: "settings-context-list" },
          el("div", { class: "settings-context-row" }, el("dt", {}, "Business"), el("dd", {}, businessName)),
          el("div", { class: "settings-context-row" }, el("dt", {}, "Brain"), el("dd", {}, brainValue)),
          el("div", { class: "settings-context-row" }, el("dt", {}, "LINE OA"), el("dd", {}, select)),
        ),
      ),
    };
  }
  /* ----------------------------- โมเดล AI (B8) ----------------------------- */

  // v1.4.9: inheritLabel = option พิเศษค่า "" (เช่น follow-up "ตามตัวหลัก") —
  // เลือกแล้ว POST model:"" เพื่อล้าง override; effectiveModel ใช้โชว์ราคาจริงตอน inherit
  function modelSelect({ label, target, models, current, defaultModel, thbPerUsd, refresh, inheritLabel = "", effectiveModel = "" }) {
    const select = el("select", { class: "model-select keep-focus" });
    const ids = new Set(models.map((m) => m.id));
    const options = [...models];
    // โมเดลปัจจุบัน (เช่นค่า env เดิม) ไม่อยู่ในไฟล์ราคา -> เพิ่ม option ให้เลือกกลับได้
    if (current && !ids.has(current)) {
      options.unshift({ id: current, label: current, inUsdPerM: null, outUsdPerM: null });
    }
    if (inheritLabel) {
      const opt = el("option", { value: "" }, inheritLabel);
      if (!current) opt.selected = true;
      select.append(opt);
    }
    for (const model of options) {
      const opt = el("option", { value: model.id },
        `${model.label || model.id} — ${priceLabelThb(model, thbPerUsd)}${model.id === defaultModel ? " (ค่าเริ่มต้น)" : ""}`);
      if (model.id === current) opt.selected = true;
      select.append(opt);
    }
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        const saved = await api("/console/api/models", { method: "POST", body: { target, model: select.value } });
        // v1.4.9b: ล้าง override ไม่ได้แปลว่า "ตามตัวหลัก" เสมอ (env default อาจตั้งไว้)
        // — บอกโมเดลที่มีผลจริงจากคำตอบ server เท่านั้น
        toast(select.value
          ? `สลับโมเดล${label}เป็น ${select.value} แล้ว`
          : `${label} กลับไปค่าอัตโนมัติแล้ว (ตอนนี้ใช้ ${saved?.followupModel || "ตามตัวหลัก"})`);
      } catch (err) {
        toast(err.message);
      }
      await refresh();
    });
    const active = options.find((m) => m.id === (current || effectiveModel));
    return el("label", { class: "model-pick" },
      el("span", { class: "model-pick-label" }, label),
      select,
      el("span", { class: "model-pick-price" },
        priceLabelThb(active, thbPerUsd), " ", el("small", {}, priceLabelUsd(active))),
    );
  }

  function modelBlock(modelsData, refresh) {
    if (!modelsData) {
      return el("section", { class: "block" },
        el("h2", { class: "block-title" }, "โมเดล AI"),
        el("p", { class: "block-hint" }, "โหลดรายการโมเดลไม่สำเร็จ — ลองรีเฟรชหน้านี้"),
      );
    }
    const thbPerUsd = Number(modelsData.thbPerUsd) || 36;
    // v1.4.9b: dropdown เลือก option "" (อัตโนมัติ) เมื่อไม่มี override ใน DB —
    // label ของ option นั้นต้องบอก "ค่าที่จะได้จริงถ้าเลือก" (followupInheritModel
    // จาก server ซึ่งเดินโซ่เดียวกับ bridge) ไม่ใช่โมเดล override ปัจจุบัน
    const fuOverride = modelsData.followupOverrideActive === true;
    const fuInherit = modelsData.followupInheritModel || modelsData.replyModel || "?";
    const fuInheritLabel = modelsData.followupDefaultModel
      ? `ค่าเริ่มต้นระบบ (${fuInherit})`
      : `ตามตัวหลัก (ตอนนี้: ${fuInherit})`;
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "โมเดล AI"),
      el("p", { class: "block-hint" }, "เลือกสมองแยกได้ 3 เส้น: ตอบลูกค้า / follow-up (sub-agent ทักตามสเตจ) / วิเคราะห์ score — มีผลทันที ไม่ต้องรีสตาร์ท"),
      sharedScopeLine(),
      modelSelect({
        label: "ตอบลูกค้า", target: "reply", models: modelsData.replyModels || modelsData.models || [],
        current: modelsData.replyModel, defaultModel: modelsData.defaultModel, thbPerUsd, refresh,
      }),
      modelSelect({
        label: "Follow-up (ทักตามสเตจ)", target: "followup", models: modelsData.followupModels || modelsData.models || [],
        current: fuOverride ? modelsData.followupModel : "",
        defaultModel: modelsData.followupDefaultModel || "", thbPerUsd, refresh,
        inheritLabel: fuInheritLabel,
        effectiveModel: modelsData.followupModel || modelsData.replyModel || "",
      }),
      modelSelect({
        label: "วิเคราะห์ score", target: "scorer", models: modelsData.scorerModels || modelsData.models || [],
        current: modelsData.scorerModel, defaultModel: modelsData.scorerDefaultModel || modelsData.defaultModel, thbPerUsd, refresh,
      }),
      scorerSuggestionsControl({ enabled: modelsData.suggestionsEnabled, api, toast }),
      el("p", { class: "block-hint" }, "ทุกโมเดลในรายการวิ่งผ่าน OpenAI API key ของบริษัท (จ่ายตามโทเคน) — โครงรายการรองรับ provider อื่นในอนาคตผ่าน field \"provider\" ในไฟล์ราคา"),
      el("p", { class: "block-hint" }, fxLine(modelsData)),
    );
  }

  /* --------------------------- Follow-up ทั้งระบบ --------------------------- */

  function followupBlock(fuData, refresh) {
    const fuOn = fuData?.enabled === true;
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "Follow-up ทั้งระบบ"),
      el("p", { class: "block-hint" }, "สวิตช์รวมของการทักตามลูกค้าอัตโนมัติ — ปิดแล้วนัดทุกตัวหยุดส่ง (นัดไม่หาย)"),
      sharedScopeLine(),
      el("button", {
        class: "switch-line",
        role: "switch",
        "aria-checked": fuOn ? "true" : "false",
        onclick: async () => {
          try {
            await api("/console/api/settings/followup", { method: "POST", body: { enabled: !fuOn } });
            toast(!fuOn ? "เปิด follow-up ทั้งระบบแล้ว" : "ปิด follow-up ทั้งระบบแล้ว");
            await refresh();
          } catch (err) {
            toast(err.message);
          }
        },
      },
        switchDot(fuOn),
        el("span", { class: `switch-state ${fuOn ? "is-on-text" : "is-off-text"}` }, fuOn ? "เปิดอยู่" : "ปิดอยู่"),
        el("span", { class: "switch-line-hint" }, "แตะเพื่อสลับ"),
      ),
    );
  }

  /* -------- v1.4.47: สวิตช์หยุด AI ทั้งระบบ (cutover / kick off) -------- */

  function aiPauseBlock(apData, refresh) {
    if (!apData) return null;
    const paused = apData.paused === true;
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, paused ? "⏸ ลูกแพรหยุดตอบทั้งระบบ" : "▶ ลูกแพรทำงานอยู่"),
      el("p", { class: "block-hint" },
        paused
          ? "รับทุกข้อความ บันทึกประวัติ ดึงชื่อ จับข้อมูลลูกค้าตามปกติ แต่ไม่ตอบใครและไม่ทักใครก่อน — " +
            "ใช้ช่วงตรวจข้อมูลก่อน kick off แตะเพื่อ kick off"
          : "ลูกแพรตอบลูกค้าและทักตามสเตจตามปกติ — แตะเพื่อหยุดทั้งระบบ (ข้อมูลยังถูกบันทึกต่อ)"),
      sharedScopeLine(),
      el("button", {
        class: "switch-line",
        role: "switch",
        "aria-checked": paused ? "false" : "true",
        onclick: async () => {
          const next = !paused;
          if (!next && !window.confirm(brandCopy("Kick off: ลูกแพรจะเริ่มตอบลูกค้าทุกคนที่ AI เปิดอยู่ทันที ยืนยันไหม?", state))) return;
          try {
            await api("/console/api/settings/ai-pause", { method: "POST", body: { paused: next } });
            toast(next ? "หยุดลูกแพรทั้งระบบแล้ว (ยังบันทึกข้อมูลต่อ)" : "Kick off แล้ว — ลูกแพรเริ่มตอบลูกค้า");
            await refresh();
          } catch (err) {
            toast(err.message);
          }
        },
      },
        switchDot(!paused),
        el("span", { class: `switch-state ${paused ? "is-off-text" : "is-on-text"}` }, paused ? "หยุดอยู่" : "ทำงานอยู่"),
        el("span", { class: "switch-line-hint" }, paused ? "แตะเพื่อ kick off" : "แตะเพื่อหยุด"),
      ),
      // 2026-08-24: โหมดร่างอย่างเดียว — มีผลเฉพาะตอนหยุดทั้งระบบ
      paused ? el("button", {
        class: "switch-line",
        role: "switch",
        "aria-checked": apData.draftMode === true ? "true" : "false",
        onclick: async () => {
          const next = !(apData.draftMode === true);
          try {
            await api("/console/api/settings/ai-pause", { method: "POST", body: { draftMode: next } });
            toast(next
              ? "เปิดโหมดร่างแล้ว — ลูกแพรจะวางร่างไว้เหนือช่องพิมพ์ให้ทีมกดส่งเอง (ยังไม่ส่งหาลูกค้า)"
              : "ปิดโหมดร่างแล้ว — ระหว่างหยุดระบบจะเงียบสนิท");
            await refresh();
          } catch (err) {
            toast(err.message);
          }
        },
      },
        switchDot(apData.draftMode === true),
        el("span", { class: `switch-state ${apData.draftMode === true ? "is-on-text" : "is-off-text"}` },
          apData.draftMode === true ? "โหมดร่าง: เปิด" : "โหมดร่าง: ปิด"),
        el("span", { class: "switch-line-hint" },
          "AI คิดร่างให้ทีมกด \"ใช้ร่างนี้\" เอง — ไม่ส่งหาลูกค้า (มีค่าโมเดลต่อข้อความ)"),
      ) : null,
    );
  }

  /* -------- v1.4.12b: สวิตช์คีย์เวิร์ดกิจกรรม # (LINE OA auto-response) -------- */

  // v1.4.49 (คำสั่งเจ้าของ 2026-08-29): วางลิงก์คลาสฟรีไว้ตรงนี้ — ลูกแพรหรือแอดมิน
  // ส่งลิงก์นี้ในแชทเมื่อไหร่ ระบบติดป้าย "คลาสฟรี" ให้เอง แล้ว FU เว้น 7 วันอัตโนมัติ
  function freeclassBlock(fcData, refresh) {
    if (!fcData) return null;
    const canPublish = can("rules.manage");
    const patterns = Array.isArray(fcData.patterns) ? fcData.patterns : [];
    const rows = patterns.length ? [...patterns] : [""];
    const list = el("div", { class: "ht-list" });
    const inputs = [];
    for (const value of rows) {
      const input = el("input", {
        class: "order-in keep-focus", type: "text", maxlength: "200",
        placeholder: "เช่น pngoung.com/p/ชื่อคลาสฟรี (วางบางส่วนของลิงก์ก็ได้)", value,
      });
      inputs.push(input);
      list.append(el("div", { class: "ht-row" }, input));
    }
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "ลิงก์คลาสฟรี"),
      el("p", { class: "block-hint" },
        "เมื่อลูกแพรหรือแอดมินส่งลิงก์นี้ในแชท ระบบจะติดป้าย \"คลาสฟรี\" ให้ลูกค้าคนนั้นเอง " +
        "แล้วเว้นการทักตาม 7 วันให้เขาได้ลองเรียนก่อน ค่อยตามต่อ — ว่างไว้ = ปิดระบบนี้"),
      canPublish ? null : publishQueueHint(),
      list,
      el("div", { class: "ht-actions" },
        el("button", { class: "btn", onclick: () => list.append(el("div", { class: "ht-row" }, (() => { const i = el("input", { class: "order-in keep-focus", type: "text", maxlength: "200", placeholder: "ลิงก์เพิ่มเติม" }); inputs.push(i); return i; })())) }, "+ เพิ่มลิงก์"),
        el("button", {
          class: "btn btn-primary",
          onclick: async () => {
            try {
              const next = inputs.map((i) => i.value.trim()).filter(Boolean);
              const result = await api("/console/api/settings/freeclass", { method: "POST", body: { patterns: next } });
              toast(publishToast(result, next.length
                ? `บันทึกแล้ว — ส่งลิงก์นี้เมื่อไหร่ ป้ายคลาสฟรีติดเอง (${next.length} ลิงก์)`
                : "ล้างรายการแล้ว — ปิดการติดป้ายอัตโนมัติ"));
              await refresh();
            } catch (err) { toast(err.message); }
          },
        }, publishLabel(canPublish, "บันทึก")),
      ),
    );
  }

  // v1.5 (คำสั่งเจ้าของ 2026-08-30): ตั้งค่าฝั่ง Facebook — โทเคนกรอกตรงนี้เท่านั้น
  // (ไม่วิ่งผ่านแชท/อีเมล) + รายชื่อลูกค้าเก่า Lead Center ที่ทีมต้องดูแลเอง
  // 2 ก.ย. 2026: แยกเป็นสองบล็อก เพราะของสองอย่างนี้คนละเจ้าของ —
  // กล่องโทเคน/verify = การต่อ webhook (เจ้าของ) · รายชื่อลูกค้าเก่า = งานหน้างานของทีม
  // เซิร์ฟเวอร์กันเป็นฟิลด์อยู่แล้ว ตรงนี้แค่ไม่วาดกล่องที่บันทึกไม่ได้
  function facebookBlock(fbData, refresh) {
    if (!fbData) return null;
    const secretInput = (placeholder) => el("input", {
      class: "order-in keep-focus", type: "password", maxlength: "1000",
      placeholder, autocomplete: "new-password",
    });
    const tokenIn = secretInput(fbData.hasPageAccessToken ? "ตั้งค่าแล้ว — วางใหม่เพื่อเปลี่ยน" : "วาง Page Access Token");
    const secretIn = secretInput(fbData.hasAppSecret ? "ตั้งค่าแล้ว — วางใหม่เพื่อเปลี่ยน" : "วาง App Secret");
    const verifyIn = el("input", {
      class: "order-in keep-focus", type: "text", maxlength: "200",
      placeholder: fbData.hasVerifyToken ? "ตั้งค่าแล้ว — พิมพ์ใหม่เพื่อเปลี่ยน" : "ตั้งรหัส Verify Token (คิดเองสั้น ๆ)",
    });
    const statusLine = (label, ok) => el("div", { class: "ht-row" },
      el("span", null, `${label}: `),
      // 28 ก.ย. 2026: CSP style-src 'self' บล็อก style="" เงียบ ๆ (ขึ้น error ทุกครั้งที่เปิดหน้าตั้งค่า) — ใช้คลาสแทน
      el("strong", { class: ok ? "fb-key-state is-set" : "fb-key-state is-unset" }, ok ? "ตั้งค่าแล้ว" : "ยังไม่ตั้ง"));
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "Facebook Messenger"),
      el("p", { class: "block-hint" },
        fbData.enabled
          ? (fbData.liveSend ? "เปิดใช้งานจริงอยู่ — ลูกแพรตอบลูกค้า Facebook ที่ทักเข้ามาใหม่" : "ช่องทางเปิดแล้วแต่ยังไม่ยิงข้อความจริง (โหมดปลอดภัย) — ทีมระบบเป็นคนเปิดขั้นสุดท้าย")
          : "ช่องทางยังปิดอยู่ — กรอกค่าให้ครบก่อน แล้วทีมระบบจะเปิดให้"),
      statusLine("Page Access Token", fbData.hasPageAccessToken),
      statusLine("App Secret", fbData.hasAppSecret),
      statusLine("Verify Token", fbData.hasVerifyToken),
      el("div", { class: "ht-list" },
        el("div", { class: "ht-row" }, tokenIn),
        el("div", { class: "ht-row" }, secretIn),
        el("div", { class: "ht-row" }, verifyIn),
      ),
      el("div", { class: "ht-actions" },
        el("button", {
          class: "btn btn-primary",
          onclick: async () => {
            try {
              const body = {};
              if (tokenIn.value.trim()) body.pageAccessToken = tokenIn.value.trim();
              if (secretIn.value.trim()) body.appSecret = secretIn.value.trim();
              if (verifyIn.value.trim()) body.verifyToken = verifyIn.value.trim();
              if (!Object.keys(body).length) { toast("ไม่มีอะไรเปลี่ยน"); return; }
              await api("/console/api/settings/facebook", { method: "POST", body });
              toast("บันทึกการตั้งค่า Facebook แล้ว");
              await refresh();
            } catch (err) { toast(err.message); }
          },
        }, "บันทึก"),
      ),
    );
  }

  // รายชื่อลูกค้าเก่า Lead Center — ทีมหน้างานต้องเติมเองได้ทุกวัน (ไม่ใช่ของเจ้าของ)
  function facebookKnownCustomersBlock(fbData, refresh) {
    if (!fbData) return null;
    const known = Array.isArray(fbData.knownCustomers) ? fbData.knownCustomers : [];
    const knownIn = el("textarea", {
      class: "order-in keep-focus", rows: "6",
      placeholder: "วางรายชื่อลูกค้าเก่าจาก Lead Center (สร้าง conversion แล้ว) หนึ่งชื่อต่อบรรทัด\nคนในรายชื่อนี้ทักมา = ลูกแพรเงียบ ให้ทีมดูแลเอง",
    });
    knownIn.value = known.join("\n");
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "รายชื่อลูกค้าเก่า (Lead Center)"),
      el("p", { class: "block-hint" },
        `คนในรายชื่อนี้ทักมาครั้งแรก ลูกแพรจะเงียบและแจ้งทีมทันที — ตอนนี้มี ${known.length} ชื่อ ` +
        "(ระบบเทียบกับชื่อโปรไฟล์ Facebook เทียบไม่ได้ = เงียบไว้ก่อนเสมอ ปลดได้จากห้องแชท)"),
      el("div", { class: "ht-list" }, el("div", { class: "ht-row" }, knownIn)),
      el("div", { class: "ht-actions" },
        el("button", {
          class: "btn btn-primary",
          onclick: async () => {
            try {
              const names = knownIn.value.split("\n").map((s) => s.trim()).filter(Boolean);
              if (names.join("\n") === known.join("\n")) { toast("ไม่มีอะไรเปลี่ยน"); return; }
              await api("/console/api/settings/facebook", { method: "POST", body: { knownCustomers: names } });
              toast(`บันทึกรายชื่อลูกค้าเก่า ${names.length} ชื่อแล้ว`);
              await refresh();
            } catch (err) { toast(err.message); }
          },
        }, "บันทึกรายชื่อ"),
      ),
    );
  }

  function hashtagBlock(htData, refresh) {
    if (!htData) return null; // โหลดไม่สำเร็จ = ไม่โชว์บล็อก (ไม่ลากหน้าล้ม)
    const on = htData.enabled === true;
    const canPublish = can("rules.manage");
    const toggle = el("button", {
      class: "switch-line",
      role: "switch",
      "aria-checked": on ? "true" : "false",
      onclick: async () => {
        try {
          const result = await api("/console/api/settings/hashtag", { method: "POST", body: { enabled: !on } });
          toast(publishToast(result,
            !on ? "เปิดโหมดเงียบให้คีย์เวิร์ด # แล้ว" : "ปิดโหมดเงียบ — ลูกแพรจะตอบข้อความ # ด้วย"));
          await refresh();
        } catch (err) {
          toast(err.message);
        }
      },
    },
      switchDot(on),
      el("span", { class: `switch-state ${on ? "is-on-text" : "is-off-text"}` }, on ? "เปิดอยู่" : "ปิดอยู่"),
      el("span", { class: "switch-line-hint" }, canPublish ? "แตะเพื่อสลับ" : "แตะเพื่อส่งขออนุมัติ"),
    );
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "คีย์เวิร์ดกิจกรรม (#)"),
      el("p", { class: "block-hint" },
        "ข้อความที่ขึ้นต้นด้วย # (เช่น #horeca จากกิจกรรมนักเรียน) ลูกแพรจะเงียบเฉพาะข้อความนั้น " +
        "ให้ระบบตอบกลับอัตโนมัติของ LINE OA ทำงานแทน — ข้อความถัดไปลูกแพรตอบปกติ"),
      sharedScopeLine(),
      toggle,
      canPublish ? null : publishQueueHint(),
      // v1.4.50: รายการคีย์เวิร์ดธุรกิจที่ลูกแพร "ตอบเอง" (ตรงกับ greeting message ของ OA)
      // ว่าง = ทุก # เงียบเหมือนเดิม ปลอดภัยเป็นค่าเริ่มต้น
      on ? businessKeywordRow(htData, refresh, canPublish) : null,
    );
  }

  // 2026-09-04 (เคสจริง Facebook): ลูกค้ากดปุ่มคำถามสำเร็จรูป "คิดค่าบริการเท่าไหร่" สามครั้ง
  // ติดกัน บอทอ่านเป็นการทวงแล้วเทราคาใส่คนแปลกหน้า — ระบบยุบการกดปุ่มให้แล้ว รายการนี้คือ
  // "วลีไหนบ้างที่ถือว่าเป็นปุ่ม" (ตรงตัวเป๊ะ ไม่มีคำลงท้าย) เจ้าของแก้ได้เมื่อเพจ/rich menu เปลี่ยนปุ่ม
  // อ่าน/เขียนผ่านเส้น /settings/hashtag เส้นเดียวกับคีย์เวิร์ด # (ของประเภทเดียวกัน: ข้อความ
  // ที่ไม่ได้ออกมาจากนิ้วลูกค้า) · ข้อมูลเก่าที่ไม่มีฟิลด์นี้ = วาดจากค่ามาตรฐาน ไม่ลากหน้าล้ม
  function presetButtonBlock(htData, refresh) {
    if (!htData) return null;
    const canPublish = can("rules.manage");
    const defaults = Array.isArray(htData.presetButtonDefaults) ? htData.presetButtonDefaults : [];
    const current = Array.isArray(htData.presetButtons) ? htData.presetButtons : defaults;
    const configured = htData.presetButtonsConfigured === true;
    const input = el("textarea", {
      class: "order-in keep-focus", rows: "6",
      placeholder: "พิมพ์วลีของปุ่ม บรรทัดละหนึ่งวลี เช่น\nคิดค่าบริการเท่าไหร่\nคุณให้บริการอะไรบ้าง",
    });
    input.value = current.join("\n");
    async function save(next) {
      try {
        const result = await api("/console/api/settings/hashtag", { method: "POST", body: { presetButtons: next } });
        toast(publishToast(result, next === null
          ? "กลับไปใช้รายการปุ่มมาตรฐานแล้ว"
          : next.length
            ? `บันทึกแล้ว — ระบบจะอ่าน ${next.length} วลีนี้เป็นการกดปุ่ม ไม่ใช่การพิมพ์`
            : "ล้างรายการแล้ว — ปิดการจับปุ่มสำเร็จรูป (ทุกข้อความถือว่าลูกค้าพิมพ์เอง)"));
        await refresh();
      } catch (err) {
        toast(err.message);
      }
    }
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "ปุ่มคำถามสำเร็จรูป (Facebook / LINE rich menu)"),
      el("p", { class: "block-hint" },
        "ข้อความที่ตรงกับวลีในรายการนี้เป๊ะ ๆ (ไม่มี ค่ะ/ครับ ต่อท้าย) ระบบจะถือว่าลูกค้า \"กดปุ่ม\" ไม่ใช่พิมพ์เอง: " +
        "กดซ้ำกี่ครั้งก็นับเป็นคำถามเดียว ไม่อ่านเป็นการทวง และยังไม่ถือว่ารู้จักลูกค้าจากข้อความปุ่ม — " +
        (configured ? "ตอนนี้ใช้รายการที่ตั้งเอง" : "ตอนนี้ใช้รายการมาตรฐาน")),
      sharedScopeLine(),
      canPublish ? null : publishQueueHint(),
      input,
      el("div", { class: "ht-actions" },
        configured
          ? el("button", { class: "btn", onclick: () => save(null) }, publishLabel(canPublish, "กลับไปใช้ค่ามาตรฐาน"))
          : null,
        el("button", {
          class: "btn btn-primary",
          onclick: () => save(input.value.split("\n").map((line) => line.trim()).filter(Boolean)),
        }, publishLabel(canPublish, "บันทึกรายการปุ่ม")),
      ),
    );
  }

  // v1.4.52 (คำสั่งเจ้าของ 2026-08-28): เดิมเป็นช่อง JSON ดิบ ซึ่งพิมพ์โน้ตกิจกรรมยาว ๆ
  // ไม่สะดวกและพิมพ์ผิดง่าย เปลี่ยนเป็นตารางทีละคำ พร้อมแยกสองช่องให้ชัด เพราะสองช่องนี้
  // ทำหน้าที่ต่างกันมากและสลับกันไม่ได้
  function businessKeywordRow(htData, refresh, canPublish = true) {
    const rows = businessKeywordRows(htData.businessKeywords);
    if (!rows.length) rows.push({ tag: "", seed: "", note: "", deliveryText: "", bare: false });

    async function save(next) {
      try {
        const result = await api("/console/api/settings/hashtag", { method: "POST", body: { businessKeywords: next } });
        toast(publishToast(result, Object.keys(next).length
          ? `บันทึกแล้ว — ลูกแพรจะตอบเอง ${Object.keys(next).length} คำ (คำอื่นยังเงียบเหมือนเดิม)`
          : "ล้างรายการแล้ว — ทุก # กลับไปเงียบให้ LINE OA ตอบ"));
        await refresh();
      } catch (err) {
        toast(err.message);
      }
    }

    const list = el("div", { class: "ht-list" });
    function addRow(row) {
      const tagInput = el("input", {
        class: "order-in keep-focus ht-tag", type: "text", maxlength: "41",
        placeholder: "#horeca", value: row.tag,
      });
      const seedInput = el("input", {
        class: "order-in keep-focus ht-seed", type: "text", maxlength: "200",
        placeholder: "ลูกค้าต้องการอะไร เช่น สนใจคลาส AI จากงาน HoReCa", value: row.seed,
      });
      const noteInput = el("textarea", {
        class: "note-input keep-focus ht-note", rows: "3", maxlength: "600",
        placeholder: "กิจกรรมนี้คืออะไร (ลูกแพรใช้เป็นบริบท ไม่ได้พูดออกไปตรง ๆ)\n"
          + "เช่น งานสัมมนา HoReCa 25 ส.ค. ที่ไบเทค พี่ง้วงสอนหัวข้อ AI สำหรับร้านอาหารและโรงแรม "
          + "ผู้ฟังส่วนใหญ่เป็นเจ้าของร้านและผู้จัดการ",
      });
      noteInput.value = row.note;
      const deliveryInput = el("textarea", {
        class: "note-input keep-focus ht-delivery", rows: "3", maxlength: "2000",
        placeholder: "ข้อความที่ต้องส่งตรง (ไม่ผ่าน AI) เช่น ชื่อไฟล์และลิงก์ที่เจ้าของยืนยัน",
      });
      deliveryInput.value = row.deliveryText;
      const originalBare = el("input", { class: "ht-original-bare", type: "hidden", value: row.bare ? "1" : "0" });
      const box = el("div", { class: "ht-row" },
        el("div", { class: "ht-row-head" },
          tagInput,
          el("button", {
            class: "btn btn-outline btn-mini",
            onclick: () => { box.remove(); },
          }, "ลบคำนี้"),
        ),
        el("label", { class: "ht-label" }, "ลูกค้าต้องการอะไร (ใช้แทนข้อความที่ลูกค้าพิมพ์)"),
        seedInput,
        el("label", { class: "ht-label" }, "โน้ตกิจกรรม (ลูกแพรรู้ไว้เป็นบริบท ไม่พูดออกไปตรง ๆ)"),
        noteInput,
        el("label", { class: "ht-label" }, "ข้อความส่งตรง (ถ้ามี จะส่งตามนี้โดยไม่เรียก AI)"),
        deliveryInput,
        originalBare,
      );
      list.append(box);
    }
    for (const row of rows) addRow(row);

    function collect() {
      const rowsToSave = [];
      for (const box of list.querySelectorAll(".ht-row")) {
        const tag = String(box.querySelector(".ht-tag")?.value || "").trim().toLowerCase();
        const seed = String(box.querySelector(".ht-seed")?.value || "").trim();
        const note = String(box.querySelector(".ht-note")?.value || "").trim();
        const deliveryText = String(box.querySelector(".ht-delivery")?.value || "").trim();
        const bare = box.querySelector(".ht-original-bare")?.value === "1";
        if (!tag || !seed) continue;
        rowsToSave.push({ tag, seed, note, deliveryText, bare });
      }
      return businessKeywordMap(rowsToSave);
    }

    return el("div", { class: "block-sub" },
      el("p", { class: "block-hint" },
        "คีย์เวิร์ดในรายการนี้ ลูกแพรจะตอบเอง (เช่นที่เขียนไว้ใน greeting message) — " +
        "คำที่ไม่อยู่ในรายการยังเงียบให้ LINE OA ตอบเหมือนเดิม " +
        "⚠️ อย่าใส่คำที่ตั้ง auto-response ไว้ใน LINE OA Manager แล้ว ลูกค้าจะได้คำตอบซ้อนกัน"),
      el("p", { class: "block-hint" },
        "สองช่องนี้ทำหน้าที่ต่างกัน — ช่องบนคือสิ่งที่ระบบจะอ่าน 'เหมือนลูกค้าพิมพ์มาเอง' " +
        "ส่วนโน้ตกิจกรรมคือสิ่งที่ลูกแพรรู้ไว้เฉย ๆ ว่าลูกค้ามาจากงานไหน จะได้ไม่คุยผิดบริบท " +
        "ตั้งแต่ข้อความแรก ห้ามเอาคำอธิบายงานไปใส่ช่องบน ลูกแพรจะเข้าใจว่าลูกค้าเป็นคนพูดประโยคนั้น"),
      list,
      el("div", { class: "btn-row" },
        el("button", {
          class: "btn btn-outline btn-mini",
          onclick: () => addRow({ tag: "", seed: "", note: "", deliveryText: "", bare: false }),
        }, "+ เพิ่มคำ"),
        el("button", {
          class: "btn btn-primary btn-mini", onclick: () => save(collect()),
        }, publishLabel(canPublish, "บันทึกรายการ")),
        el("button", {
          class: "btn btn-outline btn-mini",
          onclick: () => save(htData.businessKeywordDefaults || {}),
        }, "ใช้ชุดมาตรฐาน 4 คำ"),
        el("button", { class: "btn btn-outline btn-mini", onclick: () => save({}) }, "ล้างรายการ"),
      ),
    );
  }

  /* ----------------------- สรุปรายวันถึงเจ้าของ (G7.1) ----------------------- */

  // สวิตช์ runtime ของ Owner Daily Digest — ปลายทาง (LINE user id เจ้าของ) ตั้งใน env
  // เท่านั้น ไม่ผ่าน console (กันคนแก้ปลายทาง push จากหน้าเว็บ)
  function digestBlock(dgData, refresh) {
    if (!dgData) return null; // โหลดไม่สำเร็จ = ไม่โชว์บล็อก (ไม่ลากหน้าล้ม)
    const on = dgData.enabled === true;
    const configured = dgData.configured === true;
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "สรุปรายวันถึงเจ้าของ"),
      el("p", { class: "block-hint" },
        `สรุปหน้าร้าน (แชทเข้า / ลูกค้า hot / ออเดอร์ / ค่าใช้จ่าย AI / โควตา / สลิปน่าสงสัย) ส่งเข้า LINE เจ้าของเวลา ${dgData.times || "08:30,20:00"} — ไม่มีความเคลื่อนไหว = ไม่ส่ง`),
      sharedScopeLine(),
      el("button", {
        class: "switch-line",
        role: "switch",
        "aria-checked": on ? "true" : "false",
        onclick: async () => {
          try {
            await api("/console/api/settings/digest", { method: "POST", body: { enabled: !on } });
            toast(!on ? "เปิดสรุปรายวันถึงเจ้าของแล้ว" : "ปิดสรุปรายวันถึงเจ้าของแล้ว");
            await refresh();
          } catch (err) {
            toast(err.message);
          }
        },
      },
        switchDot(on),
        el("span", { class: `switch-state ${on ? "is-on-text" : "is-off-text"}` }, on ? "เปิดอยู่" : "ปิดอยู่"),
        el("span", { class: "switch-line-hint" }, "แตะเพื่อสลับ"),
      ),
      configured
        ? null
        : el("p", { class: "block-hint" },
            "ยังไม่ได้ตั้งปลายทาง (DIGEST_LINE_USER_ID ใน env) — สวิตช์นี้บันทึกได้ แต่ระบบจะยังไม่ส่งจนกว่าจะตั้งและรีสตาร์ท"),
    );
  }

  /* ------------- v1.1 (item 7): กติกาสินค้า — สอน AI ว่าสินค้าไหนคุยกับใคร ------------- */

  // starter prompt ให้ทีมกรอกต่อได้เลย (พี่ง้วงสั่ง: มีคู่มือ + prompt เบื้องต้น)
  function productRulesBlock(prData, refresh) {
    if (!prData) return null;
    const canPublish = can("rules.manage");
    const input = el("textarea", {
      class: "order-in keep-focus product-rules-input", rows: "7",
      maxlength: String(prData.maxChars || 4000),
      placeholder: "เขียนกติกาบรรทัดละข้อ — AI จะยึดตามนี้ทุกครั้งที่ตอบ",
    });
    input.value = prData.rules || "";
    const editActions = () => {
      const saveBtn = el("button", {
        class: "btn btn-primary btn-mini",
        onclick: async () => {
          saveBtn.disabled = true;
          try {
            const result = await api("/console/api/settings/product-rules", {
              method: "POST", body: { rules: input.value },
            });
            toast(publishToast(result, "บันทึกกติกาสินค้าแล้ว — มีผลกับคำตอบ AI ทันที"));
            await refresh();
          } catch (err) {
            toast(err.message);
            saveBtn.disabled = false;
          }
        },
      }, publishLabel(canPublish, "บันทึกกติกา"));
      const starterBtn = el("button", {
        class: "btn btn-outline btn-mini",
        onclick: () => {
          if (input.value.trim() && !window.confirm("มีกติกาอยู่แล้ว — แทนที่ด้วยแม่แบบเริ่มต้นไหม?")) return;
          input.value = productRulesStarter();
          input.focus();
        },
      }, "ใช้แม่แบบเริ่มต้น");
      return el("div", { class: "block-actions" }, starterBtn, saveBtn);
    };
    const topTags = (prData.tagSummary || []).slice(0, 12);
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "กติกาสินค้า (สอน AI เรื่องสินค้ากับลูกค้า)"),
      el("p", { class: "block-hint" },
        "บอก AI ว่าสินค้าไหนควรคุยกับลูกค้าแบบไหน ซื้อแล้วห้ามขายซ้ำตัวไหน และจังหวะไหนควร upsell/cross-sell — ทำงานร่วมกับป้ายลูกค้า (RFM + intent) อัตโนมัติ ",
        el("a", { href: "/console/guide-tags.html", target: "_blank", class: "kb-link" }, "อ่านคู่มือ + ตัวอย่างเต็ม ›")),
      sharedScopeLine(),
      topTags.length
        ? el("p", { class: "block-hint" }, `ป้ายที่มีอยู่ในระบบตอนนี้: ${topTags.map((t) => `${t.tag} (${t.customer_count})`).join(" · ")}`)
        : null,
      canPublish ? null : publishQueueHint(),
      input,
      editActions(),
    );
  }

  /* --------------- v1.1 (bug 5): ผู้รับแจ้งเตือนเมื่อลูกค้าขอคุยกับคน --------------- */

  function notifyBlock(ntData, chData, refresh, scope) {
    if (!ntData) return null; // โหลดไม่สำเร็จ = ไม่โชว์บล็อก (ไม่ลากหน้าล้ม)
    const chName = (id) => chData?.channels?.find((c) => c.id === id)?.name || id;
    // v1.2 (พี่ง้วงสั่ง): 1 user id กด Enter = 1 คน — เป็นชิปลบทีละคนได้ ไม่ใช่ textarea
    const rows = (ntData.channels || []).map((ch) => {
      const ids = [...(ch.ids || [])];
      const chipList = el("div", { class: "notify-chip-list" });
      const renderChips = () => {
        const children = ids.map((id) => el("span", { class: "notify-chip" },
            `${id.slice(0, 8)}…${id.slice(-6)}`,
            el("button", {
              class: "tag-del", "aria-label": `ลบ ${id}`, title: id,
              onclick: () => {
                ids.splice(ids.indexOf(id), 1);
                renderChips();
              },
            }, "✕"),
          ));
        if (!children.length) children.push(el("span", { class: "block-hint" }, "ยังไม่มีผู้รับ — ระบบจะไม่แจ้งใคร"));
        chipList.replaceChildren(...children);
      };
      renderChips();
      const input = el("input", {
        class: "order-in keep-focus notify-id-input", type: "text", maxlength: "40",
        placeholder: "วาง LINE user ID แล้วกด Enter (ขึ้นต้น U ยาว 33 ตัวอักษร)",
        onkeydown: (e) => {
          if (e.key !== "Enter") return;
          e.preventDefault();
          const id = input.value.trim();
          if (!/^U[0-9a-f]{32}$/.test(id)) return toast("รูปแบบไม่ถูกต้อง — ต้องขึ้นต้น U ตามด้วย 32 ตัวอักษร (a-f, 0-9)");
          if (ids.includes(id)) return toast("มีคนนี้อยู่แล้ว");
          ids.push(id);
          input.value = "";
          renderChips();
        },
      });
      const saveBtn = el("button", {
        class: "btn btn-primary btn-mini",
        onclick: async () => {
          saveBtn.disabled = true;
          try {
            await api("/console/api/settings/notify", {
              method: "POST", body: { channelId: ch.id, ids },
            });
            toast(`บันทึกผู้รับแจ้งเตือนของ ${chName(ch.id)} แล้ว (${ids.length} คน)`);
            await refresh();
          } catch (err) {
            toast(err.message);
            saveBtn.disabled = false;
          }
        },
      }, "บันทึก");
      const row = el("div", { class: "notify-row settings-oa-row" },
        el("p", { class: "order-section-label" }, chName(ch.id)),
        chipList,
        el("div", { class: "notify-add-row" }, input, saveBtn),
      );
      return scope?.register(ch.id, row) || row;
    });
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "แจ้งทีมเมื่อลูกค้าขอคุยกับคน"),
      el("p", { class: "block-hint" },
        "เมื่อลูกค้าถามว่า \"บอทหรือคน\" ร้องเรียน หรือเข้าเคสฉุกเฉิน ระบบจะ push แจ้ง LINE ของทีมงานตามรายชื่อนี้ทันที (แยกตั้งได้ต่อสาขา)"),
      el("p", { class: "settings-oa-scope" }, "เฉพาะ LINE OA ที่เลือกด้านบน"),
      el("p", { class: "block-hint notify-cost-hint" },
        "ℹ การแจ้งเตือนนับเป็น push message 1 คน ต่อ 1 ข้อความ — มีผลกับโควตาข้อความของ OA"),
      el("details", { class: "notify-howto" },
        el("summary", {}, "วิธีหา LINE user ID ของทีมงาน (ง่ายสุด 3 ขั้น)"),
        el("ol", { class: "notify-howto-steps" },
          el("li", {}, "ให้ทีมงานคนนั้น แอดเป็นเพื่อน + ทักแชทหา OA ของสาขานั้น (พิมพ์อะไรก็ได้ เช่น \"ขอ id\")"),
          el("li", {}, "เปิดห้องแชทของเขาใน console นี้ → แผงข้อมูลลูกค้าด้านขวา"),
          el("li", {}, "กดปุ่ม \"คัดลอก user ID\" ใต้ชื่อ แล้วมาวางในช่องนี้ กด Enter"),
        ),
      ),
      ...rows,
    );
  }

  /* ----------------------- เวลาทำการของบอท (Schedule Gate) ----------------------- */

  function scheduleBlock(sched, refresh) {
    const data = sched || { enabled: false, activeHours: "", ackTemplate: "", activeNow: null };
    let enabled = data.enabled === true;

    const [startVal = "", endVal = ""] = String(data.activeHours || "").split("-");
    const startInput = el("input", { class: "time-input keep-focus", type: "time", value: startVal || "09:00" });
    const endInput = el("input", { class: "time-input keep-focus", type: "time", value: endVal || "20:00" });
    const ackInput = el("textarea", {
      class: "ack-input keep-focus", rows: "3", maxlength: "500",
      placeholder: "ข้อความตอบรับนอกเวลา (ไม่บังคับ) เช่น ตอนนี้นอกเวลาทำการ ทีมงานจะรีบตอบช่วงเช้านะคะ",
    });
    ackInput.value = data.ackTemplate || "";

    const switchBtn = el("button", {
      class: "switch-line",
      role: "switch",
      "aria-checked": enabled ? "true" : "false",
      onclick: () => {
        enabled = !enabled;
        switchBtn.setAttribute("aria-checked", enabled ? "true" : "false");
        switchBtn.replaceChildren(
          switchDot(enabled),
          el("span", { class: `switch-state ${enabled ? "is-on-text" : "is-off-text"}` }, enabled ? "เปิดใช้" : "ปิดอยู่"),
          el("span", { class: "switch-line-hint" }, "กดบันทึกเพื่อให้มีผล"),
        );
      },
    },
      switchDot(enabled),
      el("span", { class: `switch-state ${enabled ? "is-on-text" : "is-off-text"}` }, enabled ? "เปิดใช้" : "ปิดอยู่"),
      el("span", { class: "switch-line-hint" }, "กดบันทึกเพื่อให้มีผล"),
    );

    const saveBtn = el("button", {
      class: "btn btn-primary",
      onclick: async () => {
        const activeHours = `${startInput.value}-${endInput.value}`;
        if (enabled && (!startInput.value || !endInput.value)) {
          toast("เลือกเวลาเปิด-ปิดก่อนนะคะ");
          return;
        }
        saveBtn.disabled = true;
        try {
          await api("/console/api/settings/schedule", {
            method: "POST",
            body: { enabled, activeHours, ackTemplate: ackInput.value },
          });
          toast("บันทึกเวลาทำการแล้ว");
          await refresh();
        } catch (err) {
          toast(err.message);
          saveBtn.disabled = false;
        }
      },
    }, "บันทึกเวลาทำการ");

    const statusLine = data.activeNow === true
      ? el("p", { class: "sched-status is-on-text" }, "ตอนนี้อยู่ในเวลาทำการ — บอทตอบลูกค้าอยู่")
      : data.activeNow === false
        ? el("p", { class: "sched-status is-off-text" }, "ตอนนี้อยู่นอกเวลาทำการ — บอทพัก (ข้อความลูกค้ายังถูกบันทึก เคสด่วนยังแจ้งทีม)")
        : null;

    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "เวลาทำการของบอท"),
      el("p", { class: "block-hint" },
        "นอกช่วงเวลานี้ AI จะพักไม่ตอบอัตโนมัติ — ข้อความลูกค้ายังถูกบันทึกครบ และเคสด่วน (ฉุกเฉิน/ร้องเรียน) ยังแจ้งทีมตามปกติ"),
      sharedScopeLine(),
      switchBtn,
      statusLine,
      el("div", { class: "sched-times" },
        el("label", { class: "sched-time" }, el("span", {}, "เปิดรับตั้งแต่"), startInput),
        el("label", { class: "sched-time" }, el("span", {}, "ถึงเวลา"), endInput),
      ),
      el("p", { class: "block-hint" }, "ตั้งข้ามคืนได้ เช่น 20:00 ถึง 08:00 (บอททำงานช่วงกลางคืน)"),
      ackInput,
      el("p", { class: "block-hint" }, "ข้อความตอบรับนอกเวลา ส่งครั้งเดียวต่อลูกค้าต่อช่วงปิดหนึ่งช่วง — เว้นว่าง = ไม่ส่ง"),
      el("div", { class: "block-actions" }, saveBtn),
    );
  }

  /* ----------------------- ตารางราคา approved_prices (M5) ----------------------- */

  // ตัวเลขทุกตัวที่บอทพูดต้องตรงตารางนี้ (price guard) — แก้จาก console มีผลทันที
  function pricesBlock(priceData, refresh) {
    const prices = priceData?.prices || [];
    const canPublish = can("prices.manage");

    function priceRow(row) {
      const amountInput = el("input", {
        class: "price-amount keep-focus", type: "number", min: "0", step: "0.01", value: String(row.amount),
      });
      // ทีมงานแก้ตัวเลขได้ แต่กดแล้วกลายเป็นคำขอ ไม่ใช่การเปลี่ยนราคาที่บอทพูดทันที
      const saveBtn = el("button", {
        class: "btn",
        onclick: async () => {
          const amount = Number(amountInput.value);
          if (!Number.isFinite(amount) || amount <= 0) {
            toast("ยอดต้องเป็นตัวเลขมากกว่า 0");
            return;
          }
          saveBtn.disabled = true;
          try {
            const result = await api(`/console/api/prices/${encodeURIComponent(row.label)}`, { method: "POST", body: { amount } });
            toast(publishToast(result, `แก้ยอด "${row.label}" แล้ว — guard ใช้ค่าใหม่ทันที`));
            await refresh();
          } catch (err) {
            toast(err.message);
            saveBtn.disabled = false;
          }
        },
      }, publishLabel(canPublish, "บันทึก"));
      const delBtn = el("button", {
        class: "btn btn-danger",
        onclick: async () => {
          delBtn.disabled = true;
          try {
            const result = await api(`/console/api/prices/${encodeURIComponent(row.label)}`, { method: "DELETE" });
            toast(publishToast(result, `ลบ "${row.label}" แล้ว — บอทพูดเลขนี้ไม่ได้อีก`));
            await refresh();
          } catch (err) {
            toast(err.message);
            delBtn.disabled = false;
          }
        },
      }, publishLabel(canPublish, "ลบ", "ขอให้ลบ"));
      return el("div", { class: "price-row" },
        el("span", { class: "price-label" }, row.label),
        amountInput, saveBtn, delBtn,
      );
    }

    const priceAddRow = () => {
      const labelInput = el("input", {
        class: "price-new-label keep-focus", type: "text", maxlength: "100",
        placeholder: "ชื่อรายการ เช่น ค่าเรียนคลาส AI ราคาปกติ",
      });
      const newAmountInput = el("input", {
        class: "price-amount keep-focus", type: "number", min: "0", step: "0.01", placeholder: "ยอด (บาท)",
      });
      const addBtn = el("button", {
        class: "btn btn-primary",
        onclick: async () => {
          const label = labelInput.value.trim();
          const amount = Number(newAmountInput.value);
          if (!label) {
            toast("ใส่ชื่อรายการก่อนนะคะ");
            return;
          }
          if (!Number.isFinite(amount) || amount <= 0) {
            toast("ยอดต้องเป็นตัวเลขมากกว่า 0");
            return;
          }
          addBtn.disabled = true;
          try {
            const result = await api("/console/api/prices", { method: "POST", body: { label, amount } });
            toast(publishToast(result, "เพิ่มราคาแล้ว — guard ใช้ตารางใหม่ทันที"));
            await refresh();
          } catch (err) {
            toast(err.message);
            addBtn.disabled = false;
          }
        },
      }, publishLabel(canPublish, "เพิ่มราคา"));
      return el("div", { class: "price-add" }, labelInput, newAmountInput, addBtn);
    };

    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "ตารางราคา (guard)"),
      el("p", { class: "block-hint" },
        "ตัวเลขทุกตัวที่บอทพูดกับลูกค้าต้องตรงกับตารางนี้ — แก้แล้วมีผลทันที ไม่ต้องรีสตาร์ท"),
      sharedScopeLine(),
      canPublish ? null : publishQueueHint(),
      prices.length
        ? el("div", { class: "price-list" }, prices.map(priceRow))
        : el("p", { class: "block-hint" }, "ตารางว่าง = บอทถูกกันไม่ให้พูดตัวเลขราคาใด ๆ (fail-closed)"),
      priceAddRow(),
    );
  }

  /* --------------------------- เปลี่ยนรหัสผ่าน (M1) --------------------------- */

  function passwordBlock() {
    const currentInput = el("input", {
      class: "pw-input keep-focus", type: "password",
      autocomplete: "current-password", placeholder: "รหัสผ่านปัจจุบัน",
    });
    const newInput = el("input", {
      class: "pw-input keep-focus", type: "password", minlength: "10",
      autocomplete: "new-password", placeholder: "รหัสผ่านใหม่ (อย่างน้อย 10 ตัวอักษร)",
    });
    const saveBtn = el("button", {
      class: "btn btn-primary",
      onclick: async () => {
        if (newInput.value.length < 10) {
          toast("รหัสผ่านใหม่ต้องยาวอย่างน้อย 10 ตัวอักษร");
          return;
        }
        saveBtn.disabled = true;
        try {
          const data = await api("/console/api/password", {
            method: "POST",
            body: { currentPassword: currentInput.value, newPassword: newInput.value },
          });
          // session ใหม่ถูกออกผ่าน cookie แล้ว — ต้องใช้ csrf ใหม่ต่อจากนี้
          if (data.csrf && state) state.csrf = data.csrf;
          currentInput.value = "";
          newInput.value = "";
          toast("เปลี่ยนรหัสผ่านแล้ว — เครื่องอื่นที่ล็อกอินค้างไว้ถูกตัดออกทั้งหมด");
        } catch (err) {
          toast(err.message);
        }
        saveBtn.disabled = false;
      },
    }, "เปลี่ยนรหัสผ่าน");
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "เปลี่ยนรหัสผ่าน"),
      el("p", { class: "block-hint" },
        "เปลี่ยนแล้วทุกเครื่อง/แท็บอื่นที่ล็อกอินด้วยบัญชีนี้จะหลุดทันที (เครื่องนี้ใช้งานต่อได้)"),
      el("div", { class: "pw-form" }, currentInput, newInput),
      el("div", { class: "block-actions" }, saveBtn),
    );
  }

  /* ----------------------- ผู้ใช้ Console (Super Admin) ----------------------- */

  function operatorsBlock(data, refresh) {
    if (!can("users.manage") || !data) return null;

    function accountRow(account) {
      if (account.roleKey === "super_admin") {
        return el("div", { class: "settings-user-row is-owner" },
          el("div", { class: "settings-user-summary" },
            el("strong", {}, account.displayName || account.username),
            el("span", { class: "channel-meta" }, `@${account.username}`),
          ),
          el("span", { class: "badge badge-green" }, "Super Admin"),
        );
      }

      const name = el("input", {
        class: "pw-input keep-focus", value: account.displayName || account.username,
        maxlength: "80", "aria-label": `ชื่อแสดงผลของ ${account.username}`,
      });
      const role = el("select", { class: "model-select keep-focus", "aria-label": `Role ของ ${account.username}` },
        el("option", { value: "admin", ...(account.roleKey === "admin" ? { selected: "" } : {}) }, "Admin"),
        el("option", { value: "staff", ...(account.roleKey === "staff" ? { selected: "" } : {}) }, "Staff"),
      );
      const disabled = el("input", {
        type: "checkbox", ...(account.disabled ? { checked: "" } : {}),
        "aria-label": `ปิดบัญชี ${account.username}`,
      });
      const save = el("button", {
        class: "btn btn-outline btn-mini",
        onclick: async () => {
          save.disabled = true;
          try {
            await api(`/console/api/operators/${encodeURIComponent(account.username)}`, {
              method: "POST",
              body: { displayName: name.value, role: role.value, disabled: disabled.checked },
            });
            toast(`บันทึกสิทธิ์ @${account.username} แล้ว — session เดิมถูกตัด`);
            await refresh();
          } catch (err) {
            toast(err.message);
            save.disabled = false;
          }
        },
      }, "บันทึก");
      const resetPassword = el("input", {
        class: "pw-input keep-focus", type: "password", minlength: "12", maxlength: "256",
        autocomplete: "new-password", placeholder: "รหัสใหม่อย่างน้อย 12 ตัว",
        "aria-label": `รหัสผ่านใหม่ของ ${account.username}`,
      });
      const reset = el("button", {
        class: "btn btn-outline btn-mini",
        onclick: async () => {
          if (resetPassword.value.length < 12) {
            toast("รหัสผ่านใหม่ต้องยาวอย่างน้อย 12 ตัวอักษร");
            return;
          }
          reset.disabled = true;
          try {
            await api(`/console/api/operators/${encodeURIComponent(account.username)}/password`, {
              method: "POST", body: { newPassword: resetPassword.value },
            });
            resetPassword.value = "";
            toast(`รีเซ็ตรหัส @${account.username} แล้ว — session เดิมถูกตัด`);
          } catch (err) {
            toast(err.message);
          }
          reset.disabled = false;
        },
      }, "รีเซ็ตรหัส");

      return el("div", { class: `settings-user-row${account.disabled ? " is-disabled" : ""}` },
        el("div", { class: "settings-user-summary" },
          el("strong", {}, `@${account.username}`),
          el("span", { class: "channel-meta" }, account.disabled ? "ปิดใช้งานอยู่" : "ใช้งานอยู่"),
        ),
        el("div", { class: "settings-user-controls" }, name, role,
          el("label", { class: "settings-user-disabled" }, disabled, " ปิดบัญชี"), save),
        el("div", { class: "settings-user-reset" }, resetPassword, reset),
      );
    }

    const username = el("input", {
      class: "pw-input keep-focus", maxlength: "32", autocomplete: "off",
      placeholder: "username เช่น team.nok", "aria-label": "username ของผู้ใช้ใหม่",
    });
    const displayName = el("input", {
      class: "pw-input keep-focus", maxlength: "80", autocomplete: "off",
      placeholder: "ชื่อที่แสดง เช่น พี่นก", "aria-label": "ชื่อแสดงผลของผู้ใช้ใหม่",
    });
    const role = el("select", { class: "model-select keep-focus", "aria-label": "Role ของผู้ใช้ใหม่" },
      el("option", { value: "staff" }, "Staff — แชท/ลูกค้า/ออเดอร์"),
      el("option", { value: "admin" }, "Admin — ตั้งค่าระบบได้"),
    );
    const password = el("input", {
      class: "pw-input keep-focus", type: "password", minlength: "12", maxlength: "256",
      autocomplete: "new-password", placeholder: "รหัสเริ่มต้นอย่างน้อย 12 ตัว",
      "aria-label": "รหัสเริ่มต้นของผู้ใช้ใหม่",
    });
    const create = el("button", {
      class: "btn btn-primary",
      onclick: async () => {
        if (password.value.length < 12) {
          toast("รหัสเริ่มต้นต้องยาวอย่างน้อย 12 ตัวอักษร");
          return;
        }
        create.disabled = true;
        try {
          await api("/console/api/operators", {
            method: "POST",
            body: { username: username.value, displayName: displayName.value, role: role.value, password: password.value },
          });
          username.value = "";
          displayName.value = "";
          password.value = "";
          toast("สร้างผู้ใช้ใหม่แล้ว");
          await refresh();
        } catch (err) {
          toast(err.message);
          create.disabled = false;
        }
      },
    }, "สร้างผู้ใช้");

    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "ผู้ใช้และสิทธิ์ Console"),
      el("p", { class: "block-hint" },
        "เฉพาะ Super Admin สร้างบัญชีได้ · Admin จัดการระบบและความรู้ · Staff ดูแลแชท ลูกค้า ออเดอร์ และ Follow-up"),
      el("div", { class: "settings-user-create" }, username, displayName, role, password, create),
      el("div", { class: "settings-user-list" }, (data.operators || []).map(accountRow)),
    );
  }

  /* ----------------------- สมอง AI ต่อสาขา (G6 P1) ----------------------- */

  // โผล่เฉพาะ instance ที่มี >1 สาขา — dropdown ต่อสาขา + addendum ตอนเลือกสมองแยก
  // ความหมาย (ตัดสินใจแล้ว ฝั่ง server บังคับตาม): สมองแยก = คลังความรู้ของสาขาเอง
  // (ไม่อ่านความรู้กลาง) + ข้อความแนะนำตัว/บุคลิกเสริมต่อท้าย Brand Pack กลาง —
  // ราคา รูป และกฎความปลอดภัยยังใช้กลางร่วมกันเสมอ
  function brainBlock(brainData, refresh, scope) {
    const channels = brainData?.channels || [];
    if (!channels.length) return null;
    const canPublish = can("brain.publish");

    function channelRow(ch) {
      const isSep = ch.mode === "separate";
      const select = el("select", { class: "model-select keep-focus", "aria-label": `สมอง AI ของ ${ch.name || ch.id}` },
        el("option", { value: "shared", ...(isSep ? {} : { selected: "" }) }, "🧠 ใช้สมองกลาง (ค่าเริ่มต้น)"),
        el("option", { value: "separate", ...(isSep ? { selected: "" } : {}) }, "🎨 สมองแยกของสาขานี้"),
      );
      select.addEventListener("change", async () => {
        select.disabled = true;
        try {
          const result = await api(`/console/api/settings/brain/${encodeURIComponent(ch.id)}`, {
            method: "POST", body: { mode: select.value },
          });
          toast(publishToast(result, select.value === "separate"
            ? `${ch.name || ch.id} ใช้สมองแยกแล้ว — เพิ่มความรู้ของสาขาได้ที่หน้า "ความรู้"`
            : `${ch.name || ch.id} กลับมาใช้สมองกลางแล้ว`));
        } catch (err) {
          toast(err.message);
        }
        await refresh();
      });

      const addendumInput = el("textarea", {
        class: "ack-input keep-focus", rows: "3", maxlength: "4000",
        placeholder: "ข้อความแนะนำตัว/บุคลิกเสริมของสาขานี้ (ไม่บังคับ) เช่น สาขานี้ชื่อร้าน... อยู่ที่... เปิดกี่โมง...",
      });
      addendumInput.value = ch.addendum || "";
      const addendumSave = () => {
        const saveBtn = el("button", {
          class: "btn btn-outline btn-mini",
          onclick: async () => {
            saveBtn.disabled = true;
            try {
              const result = await api(`/console/api/settings/brain/${encodeURIComponent(ch.id)}`, {
                method: "POST", body: { addendum: addendumInput.value },
              });
              toast(publishToast(result, `บันทึกข้อความเสริมของ ${ch.name || ch.id} แล้ว — AI ใช้ตั้งแต่ข้อความถัดไป`));
              await refresh();
            } catch (err) {
              toast(err.message);
              saveBtn.disabled = false;
            }
          },
        }, publishLabel(canPublish, "บันทึกข้อความเสริม"));
        return el("div", { class: "block-actions" }, saveBtn);
      };

      const row = el("div", { class: `brain-row settings-oa-row${isSep ? " is-separate" : ""}` },
        el("div", { class: "brain-row-head" },
          el("span", { class: "channel-name" }, ch.name || ch.id),
          select,
        ),
        isSep
          ? el("div", { class: "brain-addendum" },
              addendumInput,
              addendumSave(),
              el("p", { class: "block-hint" },
                "สาขานี้อ่าน \"ความรู้ของสาขาตัวเอง\" เท่านั้น (จัดการที่หน้า \"ความรู้\" — เลือก scope สาขานี้)"),
            )
          : null,
        canPublish ? null : publishQueueHint(),
      );
      return scope?.register(ch.id, row) || row;
    }

    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "สมอง AI ต่อ LINE OA"),
      el("p", { class: "block-hint" },
        "แต่ละ LINE OA เลือกได้ว่าใช้สมองกลางร่วมกัน หรือแยกสมองของตัวเอง — สมองแยก = คลังความรู้ของสาขาเอง + ข้อความแนะนำตัว/บุคลิกเสริม ส่วนราคา รูป และกฎความปลอดภัยยังใช้กลางร่วมกันเสมอ"),
      el("p", { class: "settings-oa-scope" }, "เฉพาะ LINE OA ที่เลือกด้านบน"),
      el("div", { class: "brain-list" }, channels.map(channelRow)),
    );
  }

  /* ------------------------- สาขา / LINE OA (W3, read-only) ------------------------- */

  // เพิ่ม/แก้สาขา = แก้ไฟล์ CHANNELS_FILE บนเครื่อง server แล้วรีสตาร์ท (จงใจ —
  // secret ไม่ผ่าน console) — หน้านี้มีไว้ให้เห็นว่าระบบรู้จักสาขาไหนบ้าง
  function channelsBlock(chData, scope) {
    const channels = chData?.channels || [];
    if (!channels.length) return null;
    return el("section", { class: "block" },
      el("h2", { class: "block-title" }, "สาขา / LINE OA"),
      el("p", { class: "block-hint" },
        channels.length > 1
          ? "แชทถูกแยกต่อสาขาอัตโนมัติ — ราคา รูป และกฎความปลอดภัยใช้กลางร่วมกันเสมอ ส่วนสมอง AI เลือกได้ต่อสาขาที่บล็อก \"สมอง AI ต่อสาขา\" ด้านบน"
          : "ตอนนี้มี LINE OA เดียว — เพิ่มสาขาได้เมื่อธุรกิจเดียวกันมีหลาย OA"),
      el("div", { class: "channel-list" },
        channels.map((ch) => {
          const row = el("div", { class: `channel-row settings-oa-row${ch.active ? "" : " is-off"}` },
            el("span", { class: "channel-name" }, ch.name || ch.id),
            el("span", { class: "channel-meta" },
              `id: ${ch.id}`,
              ch.destination ? ` · OA: …${String(ch.destination).slice(-8)}` : " · ยังไม่เคยรับ webhook",
            ),
            el("span", { class: `badge ${ch.active ? "badge-green" : "badge-gray"}` }, ch.active ? "ใช้งาน" : "ปิดอยู่"),
          );
          return scope?.register(ch.id, row) || row;
        }),
      ),
      el("p", { class: "settings-oa-scope" }, "เฉพาะ LINE OA ที่เลือกด้านบน — ไม่มี access token หรือ secret แสดงใน console"),
      el("p", { class: "block-hint" },
        "เพิ่ม/แก้สาขา: แก้ไฟล์ CHANNELS_FILE (JSON, chmod 600 นอก git) แล้วรีสตาร์ทระบบ — ดู docs/HANDOFF.md"),
    );
  }

  /* --------------------------------- render --------------------------------- */

  async function renderSettings() {
    stopPolling();
    const canManageSettings = can("settings.manage");
    const canManageAiPause = can("ai_pause.manage");
    // 1 ก.ย. 2026: กล่องที่เป็น "การตั้ง webhook / การเชื่อมต่อ" เป็นของเจ้าของคนเดียว
    // ด่านจริงอยู่ฝั่งเซิร์ฟเวอร์ — ตรงนี้แค่ไม่ยิงเส้นที่จะได้ 403 กลับมา และไม่วาดกล่องนั้น
    const canManageIntegrations = can("integrations.manage");
    // white-label (8 ต.ค. 2026): ร้านทั่วไปไม่มีคำถามต้อนรับโฆษณา ข้อความเชื่อม FB→LINE
    // Telegram และตัวทดสอบ Claude export — ไม่ยิงเส้น ไม่วาดกล่อง (course เหมือนเดิม)
    const generic = isGeneric(state);
    const requests = canManageSettings ? [
      canManageIntegrations ? api("/console/api/models").catch(() => null) : Promise.resolve(null),
      api("/console/api/settings/followup").catch(() => null),
      api("/console/api/settings/schedule").catch(() => null),
      api("/console/api/channels").catch(() => null),
      api("/console/api/prices").catch(() => null),
      api("/console/api/settings/brain").catch(() => null),
      canManageIntegrations ? api("/console/api/settings/digest").catch(() => null) : Promise.resolve(null),
      // ผู้รับแจ้งเตือน "ลูกค้าขอคุยกับคน" เป็นของทีม ไม่ใช่การต่อ webhook — เกตด้วย
      // สิทธิ์เดียวกับที่เซิร์ฟเวอร์ใช้จริง (notifications.manage) ให้ตรงกันทั้งสองฝั่ง
      can("notifications.manage") ? api("/console/api/settings/notify").catch(() => null) : Promise.resolve(null),
      api("/console/api/settings/product-rules").catch(() => null),
      api("/console/api/settings/hashtag").catch(() => null),
      api("/console/api/settings/freeclass").catch(() => null),
      // เส้นนี้ถือทั้งสถานะโทเคน (เจ้าของ) และรายชื่อลูกค้าเก่า Lead Center (ทีม) —
      // เซิร์ฟเวอร์ตัดเฉพาะฟิลด์ให้แล้ว จึงต้องโหลดให้ทุกคนที่เข้าหน้าตั้งค่าได้
      api("/console/api/settings/facebook").catch(() => null),
      canManageAiPause ? api("/console/api/settings/ai-pause").catch(() => null) : Promise.resolve(null),
      can("users.manage") && !generic ? api("/console/api/settings/claude-export-testers").catch(() => null) : Promise.resolve(null),
      can("notifications.manage") ? api("/console/api/push").catch(() => null) : Promise.resolve(null),
      // เฟส 1b: ประวัติรุ่นสมอง — โหลดพร้อมเส้นอื่น ไม่ใช่ต่อคิวเป็นรอบที่สอง
      api("/console/api/brain/versions").catch(() => null),
      // เฟส 3: บทสนทนาที่จะพังถ้าใช้สมองรุ่นนี้ (404 เมื่อ TEACH_ENABLED ปิด = null)
      api("/console/api/eval/failing").catch(() => null),
    ] : Array(17).fill(Promise.resolve(null));
    const [modelsData, fuData, schedData, chData, priceData, brainData, dgData, notifyData, prData, htData, fcData, fbData, apData, claudeTestersData, pushData, brainVersionsData, evalFailingData] = await Promise.all(requests);
    const operatorsData = can("users.manage")
      ? await api("/console/api/operators").catch(() => null)
      : null;
    // Package K: แผงคิวคำขอ — เจ้าของเห็นของทั้งร้านพร้อมปุ่มอนุมัติ · ทีมงานเห็นของตัวเอง
    // คืน null เมื่อทีมงานยังไม่เคยส่งคำขอ (ไม่ต้องมีกล่องว่างเกะกะกลางหน้าตั้งค่า)
    const publishQueue = await publishQueueBlock({ api, toast, refresh: renderSettings });
    // เฟส 1b: "ตอนนี้ลูกแพรใช้สมองรุ่นไหน · มีรุ่นทดลองค้างไหม · ถอยกลับยังไง"
    // คืน null เมื่อแฟล็กปิดหรือยังไม่เคยมีรุ่นสมอง — ไม่ต้องมีกล่องว่างเกะกะกลางหน้า
    const brainVersions = brainVersionsBlock({
      data: brainVersionsData, failing: evalFailingData, api, toast, refresh: renderSettings,
    });
    // 2026-09-28: คำถามต้อนรับในโฆษณา Facebook — กล่องโหลดข้อมูลของตัวเอง ไม่แตะ Promise.all ข้างบน
    const adWelcome = canManageSettings && !generic ? await adWelcomeQuestionBlock({ api, toast, refresh: renderSettings }) : null;
    // 28 ก.ย. 2026: สวิตช์พฤติกรรมใหม่ของคืนนั้น — เจ้าของกดเอง ทีมเห็นสถานะ
    const behaviorSwitches = canManageSettings ? await behaviorSwitchesBlock({ api, toast, refresh: renderSettings, state }) : null;
    // 28 ก.ย. 2026 (ค่ำ): ข้อความที่ลูกค้าได้ใน LINE หลังเชื่อมจาก Facebook แยกตามคลาส — เจ้าของแก้ ทีมดูได้
    const identityLinkTemplates = canManageSettings && !generic ? await identityLinkTemplatesBlock({ api, toast }) : null;
    // 28 ก.ย. 2026 (ข้อ 8): คีย์เวิร์ด # → ป้าย ของแจก/กิจกรรม ที่เจ้าของติ๊กเอง — null เมื่อเครื่องนี้ไม่มีกรอบป้าย
    const hashtagTags = canManageSettings ? await hashtagTagsBlock({ api, toast, refresh: renderSettings }) : null;
    const scope = createScope(chData, brainData);
    const configurationBlocks = canManageSettings ? [
      state.me?.role === "owner" ? el("section", { class: "block" },
        el("a", { class: "btn btn-outline", href: "#/readiness" }, "ความพร้อมสมองและ LINE OA")) : null,
      // วางไว้บนสุด: ของที่ "รอคนตัดสินใจ" ต้องเห็นก่อนของที่ตั้งค่าไว้แล้ว
      publishQueue,
      brainVersions,
      canManageAiPause ? aiPauseBlock(apData, renderSettings) : null, // owner-only: เปิด AI ทั้งระบบได้ทันที
      behaviorSwitches,
      identityLinkTemplates,
      webPushBlock(pushData, { api, toast, refresh: renderSettings }),
      scope.block,
      brainBlock(brainData, renderSettings, scope),
      canManageIntegrations ? modelBlock(modelsData, renderSettings) : null,
      pricesBlock(priceData, renderSettings),
      productRulesBlock(prData, renderSettings),
      followupBlock(fuData, renderSettings),
      hashtagBlock(htData, renderSettings),
      hashtagTags,
      presetButtonBlock(htData, renderSettings),
      freeclassBlock(fcData, renderSettings),
      canManageIntegrations ? facebookBlock(fbData, renderSettings) : null,
      // 2026-09-28: ช่องสั่งงานลูกแพรทาง Telegram — โหลดข้อมูลของตัวเอง (telegramSettings.mjs)
      canManageIntegrations && !generic ? telegramControlBlock({ api, toast }) : null,
      facebookKnownCustomersBlock(fbData, renderSettings),
      adWelcome,
      canManageIntegrations ? digestBlock(dgData, renderSettings) : null,
      can("notifications.manage") ? notifyBlock(notifyData, chData, renderSettings, scope) : null,
      scheduleBlock(schedData, renderSettings),
      // บล็อกนี้แสดง 8 ตัวท้ายของ destination + ป้าย "ยังไม่เคยรับ webhook" = สถานะการต่อสาย
      // ตรงตัว (ตัว chData ยังโหลดอยู่เพราะ createScope ต้องใช้ แค่ไม่วาดบล็อก)
      canManageIntegrations ? channelsBlock(chData, scope) : null,
      generic ? null : claudeExportTestersBlock(claudeTestersData, { api, toast, refresh: renderSettings }),
    ] : [];
    mount(
      pageHeader("ตั้งค่า"),
      el("main", { class: "page-scroll" }, el("div", { class: "page-inner" },
        configurationBlocks,
        operatorsBlock(operatorsData, renderSettings),
        passwordBlock(),
      )),
      tabBar(),
    );
    setView("page");
  }

  return renderSettings;
}
