// telegramSettings.mjs — บล็อก "Telegram สั่งงานลูกแพร" ในหน้าตั้งค่า (2026-09-28)
//
// โทเคนกรอกที่นี่ที่เดียว (ไม่ผ่านแชท/อีเมล) เก็บแบบเขียนอย่างเดียว — จอแสดงแค่เลขบอท + จุด ๆ
// เหมือนกล่องโทเคน Facebook · รหัสจับคู่โชว์ครั้งเดียวตอนกดสร้าง (เซิร์ฟเวอร์เก็บแค่ hash)
// บล็อกโหลดข้อมูลของตัวเอง settings.mjs จึงมี hook บรรทัดเดียว (หน้าตั้งค่ามีคนแก้พร้อมกันหลายคน)
import { el } from "./dom.mjs";

const PATH = "/console/api/settings/telegram";

function when(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "-";
  return new Date(value).toLocaleString("th-TH", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function statusRow(label, value, tone) {
  return el("div", { class: "tg-status-row" },
    el("span", { class: "tg-status-label" }, label),
    el("span", { class: `tg-pill is-${tone}` }, value));
}

function steps(botUsername) {
  const bot = botUsername ? `@${botUsername}` : "บอท";
  return el("ol", { class: "tg-steps" },
    el("li", {}, "เปิด Telegram คุยกับ @BotFather พิมพ์ /newbot แล้วตั้งชื่อบอทใหม่สำหรับลูกแพรโดยเฉพาะ (ห้ามใช้บอทแจ้งเตือนเดิม)"),
    el("li", {}, "คัดลอกโทเคนที่ BotFather ให้มา วางในช่องด้านล่าง แล้วกด \"บันทึกโทเคน\""),
    el("li", {}, `กด "สร้างรหัสจับคู่" แล้วส่ง /start ตามด้วยรหัสให้ ${bot} ภายใน 15 นาที (หรือกดลิงก์เปิดบอทพร้อมรหัส)`),
    el("li", {}, "บอทตอบว่า \"จับคู่สำเร็จ\" = พร้อมใช้ · พิมพ์ \"ช่วยด้วย\" ในแชทบอทเพื่อดูคำสั่งทั้งหมด"));
}

export function telegramControlBlock({ api, toast }) {
  const section = el("section", { class: "block tg-block", "aria-labelledby": "tg-title" },
    el("h2", { class: "block-title", id: "tg-title" }, "Telegram สั่งงานลูกแพร"),
    el("p", { class: "block-hint" }, "กำลังโหลด…"));
  let pairing = null; // รหัสที่เพิ่งสร้าง — อยู่แค่ในหน้าจอนี้ ไม่มีทางดึงกลับจากเซิร์ฟเวอร์

  function render(view) {
    const configured = view?.configured === true;
    const tokenInput = el("input", {
      class: "tg-input keep-focus", type: "password", maxlength: "200", autocomplete: "new-password", spellcheck: "false",
      "aria-label": "โทเคนบอท Telegram",
      placeholder: configured ? "ตั้งค่าแล้ว — วางโทเคนใหม่เพื่อเปลี่ยนบอท" : "วางโทเคนจาก @BotFather",
    });
    const act = (label, handler, className = "btn btn-outline btn-mini") => el("button", {
      class: className, type: "button",
      onclick: async (event) => {
        const button = event?.currentTarget;
        if (button) button.disabled = true;
        try { await handler(); } catch (err) { toast(err.message); } finally { if (button) button.disabled = false; }
      },
    }, label);
    const paired = view?.paired;
    const pairingRow = paired
      ? statusRow("จับคู่เจ้าของ", `จับคู่แล้ว · โดย ${paired.pairedBy || "-"} · ${when(paired.pairedAt)} · Telegram ${paired.userHint}`, "ok")
      : view?.pairing
        ? statusRow("จับคู่เจ้าของ", `รอส่งรหัส (หมดอายุ ${when(view.pairing.expiresAt)})`, "wait")
        : view?.pairingLockedAt
          // บอทเงียบกับทุกคนก่อนจับคู่ — จอนี้เป็นที่เดียวที่บอกได้ว่ารหัสถูกยกเลิกเพราะมีคนเดาผิดเกินกำหนด
          ? statusRow("จับคู่เจ้าของ", `รหัสถูกยกเลิก ${when(view.pairingLockedAt)} — มีการส่งรหัสผิดเกิน 5 ครั้ง สร้างรหัสใหม่ได้เลยค่ะ`, "bad")
          : statusRow("จับคู่เจ้าของ", "ยังไม่จับคู่ — ยังไม่มีใครสั่งงานได้", "off");
    const receiving = !configured
      ? statusRow("การรับคำสั่ง", "ปิดอยู่ (ยังไม่มีโทเคน)", "off")
      : view?.lastError
        ? statusRow("การรับคำสั่ง", `ผิดพลาด ${when(view.lastErrorAt)} — ${view.lastError}`, "bad")
        : statusRow("การรับคำสั่ง", view?.lastOkAt ? `ปกติ · ตรวจล่าสุด ${when(view.lastOkAt)}` : "กำลังเริ่ม…", view?.lastOkAt ? "ok" : "wait");
    // replaceChildren ของ DOM จริงแปลง null เป็นข้อความ "null" (el() ข้ามให้ แต่ตัวนี้ไม่ข้าม) — กรองก่อนเสมอ
    section.replaceChildren(...[
      el("h2", { class: "block-title", id: "tg-title" }, "Telegram สั่งงานลูกแพร"),
      el("p", { class: "block-hint" },
        "พี่ง้วงพิมพ์สั่งลูกแพรผ่าน Telegram ได้ เช่น \"yolo LINE คุณเอ ถามต่อเรื่องจำนวนพนักงาน\" · \"ปิด AI FB คุณบี\" · \"สถานะ คุณเอ\" — รับคำสั่งจากบัญชีที่จับคู่ไว้บัญชีเดียวเท่านั้น"
        + " · ข้อความอื่นพิมพ์คุยกับลูกแพรได้เลย (เปิด/ปิดได้ที่สวิตช์ \"คุยกับลูกแพรทาง Telegram\")"),
      el("div", { class: "tg-status" },
        statusRow("บอท", configured ? `${view.botUsername ? `@${view.botUsername} · ` : ""}${view.tokenHint}` : "ยังไม่ตั้ง", configured ? "ok" : "off"),
        pairingRow,
        receiving),
      steps(view?.botUsername),
      el("div", { class: "tg-row" },
        tokenInput,
        act("บันทึกโทเคน", async () => {
          const token = tokenInput.value.trim();
          if (!token) { toast("วางโทเคนก่อนนะคะ"); return; }
          const next = await api(PATH, { method: "POST", body: { token } });
          tokenInput.value = "";
          pairing = null;
          toast(`บันทึกแล้ว — บอท @${next.botUsername || "?"} พร้อมจับคู่`);
          render(next);
        }, "btn btn-primary btn-mini")),
      pairing ? el("div", { class: "tg-code", role: "status" },
        el("span", { class: "tg-code-label" }, "รหัสจับคู่ (ใช้ครั้งเดียว · 15 นาที)"),
        el("code", { class: "tg-code-value" }, pairing.code),
        el("span", { class: "tg-code-help" }, `ส่ง /start ${pairing.code} ให้ @${pairing.botUsername || "บอท"} หรือ`),
        pairing.deepLink ? el("a", { class: "tg-link", href: pairing.deepLink, target: "_blank", rel: "noopener noreferrer" }, "เปิดบอทพร้อมรหัส ↗") : null)
        : null,
      el("div", { class: "tg-actions" },
        configured ? act(paired ? "สร้างรหัสใหม่ (เปลี่ยนบัญชี)" : "สร้างรหัสจับคู่", async () => {
          pairing = await api(`${PATH}/pairing`, { method: "POST", body: {} });
          toast("สร้างรหัสแล้ว — ส่งให้บอทภายใน 15 นาทีนะคะ");
          render(await api(PATH));
        }) : null,
        paired ? act("ยกเลิกการจับคู่", async () => {
          if (!globalThis.window?.confirm?.("ยกเลิกการจับคู่? บัญชี Telegram เดิมจะสั่งงานลูกแพรไม่ได้ทันที")) return;
          render(await api(PATH, { method: "POST", body: { unpair: true } }));
          toast("ยกเลิกการจับคู่แล้ว");
        }) : null,
        configured ? act("ลบโทเคน", async () => {
          if (!globalThis.window?.confirm?.("ลบโทเคนบอท? ช่อง Telegram จะหยุดรับคำสั่งทันที และต้องจับคู่ใหม่")) return;
          pairing = null;
          render(await api(PATH, { method: "POST", body: { clear: true } }));
          toast("ลบโทเคนแล้ว");
        }, "btn btn-danger btn-mini") : null),
    ].filter(Boolean));
  }

  api(PATH)
    .then((view) => render(view))
    .catch((err) => section.replaceChildren(
      el("h2", { class: "block-title", id: "tg-title" }, "Telegram สั่งงานลูกแพร"),
      el("p", { class: "block-hint" }, `โหลดสถานะไม่สำเร็จ (${err?.message || "error"}) — รีเฟรชหน้าอีกครั้งได้`)));
  return section;
}
