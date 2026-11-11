// broadcastBlocks.mjs — บล็อกประกอบของหน้าบรอดแคสต์ (ย้ายจาก broadcast.mjs 28 ก.ย. 2026)
// ลงทะเบียน LINE ทดสอบ · ตรวจผลส่งที่ยังไม่ชัด (quarantine) · รายการตั้งเวลา · สิทธิ์ทีมงานต่อ OA
// พฤติกรรมเดิมทุกข้อ — เปลี่ยนแค่ที่อยู่และรับ deps ตรง ๆ แทน closure ของหน้าเดิม
import { el } from "./dom.mjs";
import { formatBangkokDatetimeLocal, put, quarantineResolutionConfirmationText } from "./broadcastState.mjs";

function safeJsonArray(raw) {
  try {
    const value = JSON.parse(raw || "[]");
    return Array.isArray(value) ? value : [];
  } catch { return []; }
}

/* --------------------------- LINE ทดสอบของฉัน --------------------------- */

// ปลายทางผูกได้เฉพาะบัญชีที่ส่งรหัสยืนยันเข้ามาจาก OA นี้ภายใน 5 นาที — ระบบไม่แสดง LINE user ID
export function selfTestBlock({ api, toast, channelId, canRegister, initial }) {
  let model = initial || { destination: { verified: false } };
  let challenge = "";
  const section = el("details", { class: "bs-selftest" });
  const render = () => {
    const verified = model.destination?.verified === true;
    section.open = Boolean(challenge) || section.open;
    put(section, 
      el("summary", {},
        el("span", { class: `bs-dot${verified ? " is-on" : ""}`, "aria-hidden": "true" }),
        verified ? "LINE ทดสอบของฉัน: ยืนยันแล้ว" : "LINE ทดสอบของฉัน: ยังไม่ได้ยืนยัน"),
      el("p", { class: "block-hint" },
        verified
          ? `ยืนยันเมื่อ ${model.destination.verifiedAt ? new Date(model.destination.verifiedAt).toLocaleString("th-TH") : "—"} · ปุ่ม "ส่งทดสอบถึงตัวเอง" ส่งไปที่ LINE นี้เท่านั้น`
          : "สร้างรหัส แล้วส่งรหัสนั้นเข้ามาที่ LINE OA นี้จากมือถือของคุณภายใน 5 นาที ระบบจะจำ LINE นั้นเป็นปลายทางทดสอบ (ไม่แสดง user ID)"),
      challenge ? el("div", { class: "bc-self-test-code" },
        el("strong", {}, "ส่งข้อความนี้เข้า LINE OA นี้แบบตรงตัว:"),
        el("code", {}, challenge),
        el("p", { class: "block-hint" }, "ส่งแล้วกด \"เช็กสถานะ\" — รหัสใช้ได้ครั้งเดียว")) : null,
      el("div", { class: "bs-selftest-actions" },
        el("button", {
          type: "button", class: "btn btn-outline btn-mini", disabled: canRegister ? null : true,
          onclick: async () => {
            try {
              const response = await api("/console/api/broadcast/self-test/challenge", { method: "POST", body: { channelId } });
              challenge = response.challenge || "";
              model = { ...model, destination: { verified: false } };
              render();
            } catch (err) { toast(err.message); }
          },
        }, "สร้างรหัสยืนยัน"),
        el("button", {
          type: "button", class: "btn btn-outline btn-mini",
          onclick: async () => {
            try {
              model = await api(`/console/api/broadcast/self-test?channel=${encodeURIComponent(channelId)}`);
              if (model.destination?.verified) challenge = "";
              render();
            } catch (err) { toast(err.message); }
          },
        }, "เช็กสถานะ"),
        verified ? el("button", {
          type: "button", class: "btn btn-ghost btn-mini",
          onclick: async () => {
            if (!globalThis.window?.confirm?.("ลบปลายทางส่งทดสอบของคุณสำหรับ OA นี้หรือไม่?")) return;
            try {
              await api("/console/api/broadcast/self-test/remove", { method: "POST", body: { channelId } });
              model = { ...model, destination: { verified: false } };
              render();
            } catch (err) { toast(err.message); }
          },
        }, "ลบปลายทาง") : null),
    );
  };
  render();
  return section;
}

/* --------------------------- ผลส่งที่ยังไม่ชัด --------------------------- */

export function quarantineReviewBlock({ api, toast, channelId, initial }) {
  let model = initial || { quarantines: [] };
  const section = el("section", { class: "block bc-quarantine-review" });
  const outcomeLabel = {
    provider_response_missing: "ไม่ได้รับคำตอบยืนยันจาก LINE",
    provider_server_error: "LINE ตอบ server error",
    network_or_client_exception: "การเชื่อมต่อขาดระหว่างรอผล",
    provider_ambiguous: "provider ระบุผลไม่ชัดเจน",
  };
  const reload = async () => {
    model = await api(`/console/api/broadcast/quarantines?channel=${encodeURIComponent(channelId)}`);
    render();
  };
  const resolve = async (row, resolution, button) => {
    const choiceLabel = resolution === "confirmed_delivered"
      ? "ยืนยันจากหลักฐานภายนอกว่า LINE ส่งแล้ว"
      : "ยืนยันจากหลักฐานภายนอกว่า LINE ไม่ได้ส่ง";
    const reason = globalThis.window?.prompt?.(`${choiceLabel}\nระบุเหตุผลหรือหลักฐานที่ตรวจ (5-300 ตัวอักษร)\nห้ามใส่ข้อมูลส่วนตัวลูกค้า`);
    if (reason === null || reason === undefined) return;
    if (String(reason).trim().length < 5 || String(reason).trim().length > 300) return toast("เหตุผลต้องยาว 5-300 ตัวอักษรค่ะ");
    const expected = quarantineResolutionConfirmationText(row.id, resolution);
    const typed = globalThis.window?.prompt?.(`${choiceLabel}\nการกดนี้บันทึกผลตรวจเท่านั้น ไม่ส่ง LINE และไม่ส่งซ้ำอัตโนมัติ\n\nพิมพ์ข้อความนี้ให้ตรง:\n${expected}`);
    if (typed === null || typed === undefined) return;
    if (String(typed) !== expected) return toast("คำยืนยันไม่ตรง รายการยังไม่ถูกบันทึกค่ะ");
    button.disabled = true;
    try {
      const response = await api(`/console/api/broadcast/quarantines/${encodeURIComponent(row.id)}/resolve`, {
        method: "POST", body: { resolution, reason: String(reason).trim(), confirmation: typed },
      });
      toast(response.notice || "บันทึกผลตรวจแล้ว — ไม่มีการส่ง LINE");
      await reload();
    } catch (err) {
      button.disabled = false;
      toast(err.message);
    }
  };
  const render = () => {
    const rows = model?.quarantines || [];
    section.hidden = rows.length === 0;
    put(section, 
      el("div", { class: "bc-quarantine-heading" },
        el("span", {},
          el("h2", { class: "block-title" }, `ต้องตรวจผลส่ง (${rows.length})`),
          el("p", { class: "block-hint" }, model?.notice || "ผลยังไม่ชัดเจน ระบบบล็อกการส่งซ้ำจน Owner/Admin ตรวจหลักฐาน")),
        el("button", {
          type: "button", class: "btn btn-outline btn-mini",
          onclick: async (event) => {
            event.currentTarget.disabled = true;
            try { await reload(); } catch (err) { toast(err.message); }
          },
        }, "โหลดใหม่")),
      el("div", { class: "bc-quarantine-list" }, rows.map((row) => {
        const delivered = el("button", { type: "button", class: "btn btn-outline btn-mini", onclick: () => resolve(row, "confirmed_delivered", delivered) }, "ยืนยันว่าส่งแล้ว");
        const notDelivered = el("button", { type: "button", class: "btn btn-danger btn-mini", onclick: () => resolve(row, "confirmed_not_delivered", notDelivered) }, "ยืนยันว่าไม่ได้ส่ง");
        return el("article", { class: "bc-quarantine-card" },
          el("div", { class: "bc-history-main" },
            el("strong", {}, row.lineSide
              ? `${row.channelName || row.channelId} · ส่งฝั่ง LINE (เพื่อนทุกคน/กลุ่มเป้าหมาย) ประมาณ ${Number(row.recipientCount || 0).toLocaleString("th-TH")} คน`
              : `${row.channelName || row.channelId} · ${Number(row.recipientCount || 0)} คนต้องตรวจ`),
            el("span", { class: "bc-history-sub" }, `${outcomeLabel[row.outcomeCategory] || "ผลจาก LINE ไม่ชัดเจน"} · ${new Date(row.createdAt).toLocaleString("th-TH")}`),
            el("span", { class: "bc-quarantine-truth" }, row.lineSide
              ? "ดูใน LINE OA Manager (หน้าบรอดแคสต์/สถิติ) ว่าข้อความออกไปหรือไม่ · ระหว่างนี้ OA นี้ส่งบรอดแคสต์ไม่ได้"
              : "ยังสรุปไม่ได้ว่าส่งถึงหรืออ่านแล้ว · ระบบหยุด batch ถัดไปและไม่ส่งซ้ำอัตโนมัติ")),
          el("div", { class: "bc-history-actions" }, delivered, notDelivered));
      })),
    );
  };
  render();
  return section;
}

/* --------------------------- รายการตั้งเวลา --------------------------- */

export function scheduleListBlock({ api, toast, channelId, initial }) {
  let model = initial || { schedules: [] };
  const section = el("section", { class: "block bs-schedules" });
  const statusLabel = {
    scheduled: "รอเวลา", preparing: "กำลังตรวจล่าสุด", dispatched: "เริ่มส่งแล้ว", cancelled: "ยกเลิก", failed: "ไม่ส่ง (ตรวจไม่ผ่าน)",
  };
  const reload = async () => {
    model = await api(`/console/api/broadcast/schedule?channel=${encodeURIComponent(channelId)}`);
    render();
  };
  const render = () => {
    const rows = (model?.schedules || []).slice(0, 12);
    section.hidden = rows.length === 0;
    put(section, 
      el("h2", { class: "block-title" }, "งานตั้งเวลา"),
      el("div", { class: "bc-schedule-list" }, rows.map((row) => {
        const messages = safeJsonArray(row.messages_json);
        const first = messages.find((message) => message.type === "text")?.text
          || (messages.length ? `(${messages.length} บับเบิล)` : "—");
        const actual = row.status === "dispatched" && row.broadcast_status
          ? ` · ผลส่ง: ${row.broadcast_status} ${Number(row.broadcast_sent_count || 0)}/${Number(row.broadcast_audience_count || row.preview_count || 0)} คน`
          : "";
        return el("div", { class: `bc-schedule-row bc-schedule-${row.status}` },
          el("span", { class: "bc-history-main" },
            el("strong", {}, `${formatBangkokDatetimeLocal(row.scheduled_at).replace("T", " ")} น. · ${statusLabel[row.status] || row.status}`),
            el("span", { class: "bc-history-text" }, String(first).slice(0, 80)),
            el("span", { class: "bc-history-sub" }, `ยืนยัน ${Number(row.preview_count || 0)} คน · โดย ${row.created_by}${actual}`),
            row.last_error ? el("span", { class: "bc-history-err" }, row.last_error) : null),
          ["scheduled", "preparing", "dispatched"].includes(row.status)
            ? el("button", {
                type: "button", class: "btn btn-danger btn-mini",
                onclick: async () => {
                  const warning = row.status === "dispatched"
                    ? "งานเริ่มส่งแล้ว ระบบหยุดได้ที่ขอบ batch ถัดไปเท่านั้น และเรียกคืนสิ่งที่ LINE รับแล้วไม่ได้"
                    : "งานนี้ยังไม่แตะ LINE และจะยกเลิกทันที";
                  if (!globalThis.window?.confirm?.(`ยกเลิกงานตั้งเวลานี้หรือไม่?\n${warning}`)) return;
                  try {
                    await api(`/console/api/broadcast/schedule/${encodeURIComponent(row.id)}/cancel`, { method: "POST", body: {} });
                    toast("อัปเดตสถานะงานตั้งเวลาแล้ว");
                    await reload();
                  } catch (err) { toast(err.message); }
                },
              }, row.status === "dispatched" ? "ขอหยุดส่ง" : "ยกเลิก")
            : null);
      })),
    );
  };
  render();
  return section;
}

/* --------------------------- สิทธิ์ทีมงานต่อ OA --------------------------- */

export function permissionBlock({ api, toast, initial }) {
  if (!initial) return null;
  let model = initial;
  const section = el("details", { class: "block bs-permissions" });
  const render = () => {
    const rows = (model.operators || []).map((operator) => {
      const allAccess = operator.role === "owner" || operator.role === "admin";
      const granted = new Set(operator.channels || []);
      return el("div", { class: `bc-permission-row${operator.disabled ? " is-disabled" : ""}` },
        el("div", { class: "bc-permission-person" },
          el("strong", {}, operator.displayName || operator.username),
          el("span", {}, `@${operator.username} · ${operator.role}${operator.disabled ? " · ปิดใช้งาน" : ""}`)),
        allAccess
          ? el("span", { class: "bc-access-all" }, "ทุก OA")
          : el("div", { class: "bc-permission-channels" }, (model.channels || []).map((channel) => el("label", { class: "bc-permission-chip" },
              el("input", {
                type: "checkbox", checked: granted.has(channel.id) ? "checked" : null, disabled: operator.disabled ? "disabled" : null,
                onchange: async (event) => {
                  const allowed = event.target.checked;
                  event.target.disabled = true;
                  try {
                    model = await api("/console/api/broadcast/permissions", {
                      method: "POST", body: { username: operator.username, channelId: channel.id, allowed },
                    });
                    toast(`${allowed ? "ให้" : "ถอน"}สิทธิ์ ${operator.displayName || operator.username} · ${channel.name || channel.id} แล้ว`);
                    render();
                  } catch (err) {
                    event.target.checked = !allowed;
                    event.target.disabled = false;
                    toast(err.message);
                  }
                },
              }),
              el("span", {}, channel.name || channel.id)))));
    });
    put(section, 
      el("summary", { class: "block-title" }, "สิทธิ์ทีมงานสำหรับบรอดแคสต์"),
      el("p", { class: "block-hint" }, "Owner/Admin ใช้ได้ทุก OA · Operator ในระบบหลาย OA ต้องเปิดสิทธิ์ตรงนี้ก่อน ระบบบังคับซ้ำฝั่งเซิร์ฟเวอร์"),
      el("div", { class: "bc-permission-list" }, rows),
    );
  };
  render();
  return section;
}
