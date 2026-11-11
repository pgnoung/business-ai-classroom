import { el } from "./dom.mjs";

function browserSupported() {
  return typeof navigator !== "undefined"
    && typeof window !== "undefined"
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

function applicationKey(value) {
  const padded = String(value || "").padEnd(Math.ceil(String(value || "").length / 4) * 4, "=");
  const bytes = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bytes, (char) => char.charCodeAt(0));
}

function sameKey(subscription, publicKey) {
  const applied = subscription?.options?.applicationServerKey;
  if (!applied || !publicKey) return true; // เทียบไม่ได้ = อย่าเพิ่งทิ้งของที่ใช้ได้อยู่
  const current = new Uint8Array(applied);
  const expected = applicationKey(publicKey);
  if (current.length !== expected.length) return false;
  return current.every((byte, index) => byte === expected[index]);
}

async function registration() {
  const reg = await navigator.serviceWorker.register("/console/sw.js", { scope: "/console/" });
  // register() คืนค่าตั้งแต่ worker ยัง installing อยู่ ถ้าเรียก subscribe ต่อทันที
  // Chrome จะโยน AbortError "no active Service Worker" — สิทธิ์ถูกอนุญาตไปแล้ว
  // แต่ไม่มีการสมัคร และบน iPhone จะไม่มีโอกาสขออนุญาตอีกเลย
  await navigator.serviceWorker.ready;
  return reg;
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker.getRegistration("/console/");
  return reg ? reg.pushManager.getSubscription() : null;
}

// แปล DOMException เป็นภาษาที่คนอ่านรู้เรื่อง — ของเดิมโยนข้อความอังกฤษดิบขึ้นจอไทย
function friendlyError(error) {
  const name = String(error?.name || "");
  if (name === "NotAllowedError") return "เบราว์เซอร์ปฏิเสธการแจ้งเตือน — ต้องไปเปิดในตั้งค่าของเครื่อง";
  if (name === "AbortError") return "เปิดไม่ทัน ลองกดอีกครั้งอีกสักครู่";
  if (name === "NotSupportedError") return "เครื่อง/เบราว์เซอร์นี้ยังไม่รองรับการแจ้งเตือนแบบนี้";
  return error?.message || "เปิดแจ้งเตือนไม่สำเร็จ";
}

// เรียกตอน boot ทุกครั้ง: ถ้าเคยอนุญาตไว้แล้วแต่การสมัครหลุด (เบราว์เซอร์หมุน endpoint,
// ติดตั้ง PWA ใหม่, หรือหมุนกุญแจ VAPID) ให้สมัครใหม่เงียบ ๆ แล้วรายงานเซิร์ฟเวอร์
// ของเดิม return false เฉย ๆ เมื่อไม่พบการสมัคร = แจ้งเตือนตายถาวรโดยไม่มีใครรู้
export async function refreshExistingWebPushBinding({ api, state }) {
  if (state?.features?.webPush !== true || !browserSupported()) return false;
  if (Notification.permission !== "granted") return false;
  const publicKey = String(state?.webPushPublicKey || "");
  try {
    let subscription = await currentSubscription();
    if (subscription && publicKey && !sameKey(subscription, publicKey)) {
      try { await subscription.unsubscribe(); } catch { /* จะสมัครใหม่อยู่แล้ว */ }
      subscription = null;
    }
    if (!subscription && publicKey) {
      const reg = await registration();
      subscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationKey(publicKey),
      });
    }
    if (!subscription?.endpoint) return false;
    await api("/console/api/push/subscribe", { method: "POST", body: { endpoint: subscription.endpoint } });
    return true;
  } catch {
    return false;
  }
}

// 13 ต.ค. 2026 (พี่ง้วง: "ให้เด้งเฉพาะห้องตรวจ หรือข้อความแจ้งเตือนแอดมินใด ๆ"): เลือกได้ต่อบัญชีว่ามือถือจะเด้งเรื่องอะไร
const SCOPE_LABEL = Object.freeze({ all: "ทุกแชทใหม่", admin: "เฉพาะงานแอดมิน", review: "เฉพาะห้องตรวจ" });
function scopeHint(scope, review) {
  if (scope === "review") return "เด้งเฉพาะห้องตรวจ: รอยืนยันปิดแชท และคิวตรวจแชท 20:00";
  if (scope === "admin") {
    return `เด้งเฉพาะห้องที่รอคนดูแล (ลูกค้าขอคุยกับคน · ส่งสลิป/ไฟล์ · ร้องเรียน · จอง/โอน) และเตือนระบบ${review ? " + ห้องตรวจ" : ""}`;
  }
  return `เด้งทุกแชทใหม่ที่ยังไม่มีใครตอบ${review ? " + ห้องตรวจ" : ""}`;
}

function scopePicker(data, { api, toast }) {
  const review = data.reviewScope === true;
  const options = review ? ["all", "admin", "review"] : ["all", "admin"];
  let current = options.includes(data.scope) ? data.scope : "all";
  const hint = el("p", { class: "block-hint push-scope-hint" }, scopeHint(current, review));
  const buttons = options.map((scope) => el("button", {
    type: "button", role: "radio", "data-scope": scope,
    class: scope === current ? "btn btn-primary" : "btn btn-ghost",
    "aria-checked": scope === current ? "true" : "false",
    onclick: async () => {
      if (scope === current) return;
      buttons.forEach((button) => { button.disabled = true; });
      try {
        await api("/console/api/push/scope", { method: "POST", body: { scope } });
        current = scope;
        for (const button of buttons) {
          const on = button.getAttribute("data-scope") === current;
          button.className = on ? "btn btn-primary" : "btn btn-ghost";
          button.setAttribute("aria-checked", on ? "true" : "false");
        }
        hint.textContent = scopeHint(current, review);
        toast(`บันทึกแล้ว: ${SCOPE_LABEL[current]}`);
      } catch (error) {
        toast(error?.message || "บันทึกไม่สำเร็จ ลองอีกครั้งนะคะ");
      } finally {
        buttons.forEach((button) => { button.disabled = false; });
      }
    },
  }, SCOPE_LABEL[scope]));
  return el("div", { class: "push-scope" },
    el("p", { class: "block-hint", id: "push-scope-label" }, "ให้มือถือเด้งเรื่องอะไรบ้าง"),
    el("div", { class: "block-actions", role: "radiogroup", "aria-labelledby": "push-scope-label" }, buttons),
    hint);
}

export function webPushBlock(data, { api, toast, refresh }) {
  if (!data) return null;
  const available = data.available === true;
  const support = browserSupported();
  const denied = support && Notification.permission === "denied";
  const publicKey = String(data.publicKey || "");
  const status = el("p", { class: "push-status" }, available
    ? `เปิดบน ${Number(data.activeDeviceCount) || 0} อุปกรณ์`
    : "ยังไม่เปิด Web Push บนเซิร์ฟเวอร์");
  const enable = el("button", {
    class: "btn btn-primary",
    disabled: !available || !support || denied,
    onclick: async () => {
      enable.disabled = true;
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") throw new Error("ยังไม่ได้อนุญาต Notification ในเบราว์เซอร์");
        const reg = await registration();
        let subscription = await reg.pushManager.getSubscription();
        // การสมัครเก่าที่ผูกกับกุญแจคนละดอกจะส่งไม่ถึงตลอดกาล และกดปุ่มนี้ซ้ำก็ไม่ช่วย
        // เพราะของเดิมเจอ subscription แล้วใช้ต่อทันทีโดยไม่เทียบกุญแจ
        if (subscription && publicKey && !sameKey(subscription, publicKey)) {
          try { await subscription.unsubscribe(); } catch { /* สมัครใหม่ต่อได้ */ }
          subscription = null;
        }
        if (!subscription) {
          subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: applicationKey(publicKey),
          });
        }
        await api("/console/api/push/subscribe", { method: "POST", body: { endpoint: subscription.endpoint } });
        toast("เปิดแจ้งเตือนบนอุปกรณ์นี้แล้ว");
        await refresh();
      } catch (error) {
        toast(friendlyError(error));
        enable.disabled = false;
      }
    },
  }, "เปิดแจ้งเตือนบนเครื่องนี้");
  const disable = el("button", {
    class: "btn btn-ghost",
    disabled: !available || !support,
    onclick: async () => {
      disable.disabled = true;
      try {
        const subscription = await currentSubscription();
        if (subscription?.endpoint) {
          await api("/console/api/push/unsubscribe", { method: "POST", body: { endpoint: subscription.endpoint } });
          await subscription.unsubscribe();
        }
        toast("ปิดแจ้งเตือนบนอุปกรณ์นี้แล้ว");
        await refresh();
      } catch (error) {
        toast(friendlyError(error));
        disable.disabled = false;
      }
    },
  }, "ปิดบนเครื่องนี้");
  // ความจริงต้องมาจากเซิร์ฟเวอร์ ไม่ใช่จากการมี object ในเครื่อง — เครื่องที่ถูกปลด
  // ฝั่งเซิร์ฟเวอร์ (session หมด/เปลี่ยนรหัส/ถูกปิด) จะยังถือ object อยู่และหลอกว่าปกติ
  if (available && support) {
    currentSubscription().then(async (subscription) => {
      if (!subscription?.endpoint) {
        status.textContent = `เครื่องนี้ยังไม่เปิด · รวม ${Number(data.activeDeviceCount) || 0} อุปกรณ์`;
        return;
      }
      let live = null;
      try {
        const check = await api(`/console/api/push?endpoint=${encodeURIComponent(subscription.endpoint)}`);
        live = check?.thisDeviceActive;
      } catch { /* ถามไม่ได้ = ไม่ยืนยันว่าเปิดอยู่ */ }
      status.textContent = live === true
        ? `อุปกรณ์นี้เปิดอยู่ · รวม ${Number(data.activeDeviceCount) || 0} อุปกรณ์`
        : "อุปกรณ์นี้หลุดจากระบบแจ้งเตือน — กด “เปิดแจ้งเตือนบนเครื่องนี้” อีกครั้ง";
    }).catch(() => {});
  }
  return el("section", { class: "block" },
    el("h2", { class: "block-title" }, "แจ้งเตือนแชทใหม่บนมือถือ"),
    el("p", { class: "block-hint" },
      "แจ้งเตือนแบบ Web Push แม้ไม่ได้เปิดหน้า Console อยู่ แตะแล้วเปิดห้องแชทตรงเคส โดยไม่แสดงข้อความลูกค้าบนหน้าจอล็อก"),
    status,
    !support ? el("p", { class: "block-hint" }, "เบราว์เซอร์นี้ยังไม่รองรับ Web Push") : null,
    denied
      ? el("p", { class: "block-hint" },
        "เครื่องนี้เคยกด “ไม่อนุญาต” ไว้ — กดปุ่มซ้ำไม่ช่วยแล้ว ต้องไปเปิดที่ ตั้งค่า → การแจ้งเตือน → ลูกแพร (บน iPhone: ลบไอคอนออกจากหน้าจอโฮมแล้วเพิ่มใหม่)")
      : null,
    el("p", { class: "block-hint" }, "iPhone/iPad: ต้องเพิ่มเว็บนี้ไว้ที่หน้าจอโฮมก่อน แล้วเปิดจากไอคอน LuKprae เพื่ออนุญาตการแจ้งเตือน"),
    el("div", { class: "block-actions" }, enable, disable),
    available ? scopePicker(data, { api, toast }) : null,
  );
}
