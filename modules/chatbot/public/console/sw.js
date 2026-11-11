// LuKprae Console notification worker. No cache/offline layer: authenticated
// console pages remain network-only and no customer data is persisted here.
//
// สัญญาที่ต้องรักษาบนมือถือ (audit 2026-08-25):
// เราสมัครด้วย userVisibleOnly:true — แปลว่าสัญญากับเบราว์เซอร์ว่า "ทุก push
// ต้องกลายเป็นการแจ้งเตือนที่คนเห็น" ถ้าจบ event โดยไม่เรียก showNotification
// Chrome จะขึ้นข้อความอังกฤษของตัวเองและหักโควตา ส่วน WebKit บน iPhone
// ถอนสิทธิ์ push ทิ้งได้เลย → เน็ตสะดุดไม่กี่ครั้งกลายเป็นเงียบถาวร
// ทุกเส้นทางในไฟล์นี้จึงต้องจบด้วยการแจ้งเตือนเสมอ แม้จะไม่รู้ว่าเรื่องอะไร
const ICON = "/console/static/app-icon-192.png";
const BADGE = "/console/static/app-badge-72.png";
const FETCH_TIMEOUT_MS = 8000;

// ข้อความสำรองไม่มีชื่อลูกค้า ไม่มีเนื้อความ ไม่มีรหัสเคส — ปลอดภัยบนหน้าจอล็อก
function wakeFallback() {
  return self.registration.showNotification("ลูกแพร", {
    body: "แตะเพื่อเปิด Console",
    icon: ICON,
    badge: BADGE,
    tag: "lukprae-wake",
    renotify: false,
    data: { url: "/console/" },
  });
}

async function showQueuedEvents() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let payload;
  try {
    const response = await fetch("/console/api/push/pending", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    payload = await response.json();
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
  // รองรับทั้งรูปแบบเดิม (event เดียว) และรูปแบบใหม่ (events หลายรายการ)
  const events = Array.isArray(payload?.events)
    ? payload.events
    : (payload?.event ? [payload.event] : []);
  const shown = events.filter((event) => event && event.url);
  if (!shown.length) return false;
  // หนึ่งการแจ้งเตือนต่อหนึ่งเคส — ถ้ายุบเหลืออันเดียว ลูกค้าที่เหลือจะหายเงียบ
  await Promise.all(shown.map((event) => self.registration.showNotification(
    event.title || "ลูกแพร",
    {
      body: event.body || "แตะเพื่อเปิด Console",
      icon: ICON,
      badge: BADGE,
      tag: event.tag || "lukprae-update",
      renotify: true,
      data: { url: event.url },
    },
  )));
  if (typeof self.registration.getNotifications === "function" && "setAppBadge" in self.navigator) {
    try {
      const open = await self.registration.getNotifications();
      await self.navigator.setAppBadge(open.length);
    } catch { /* badge เป็นของแถม ห้ามทำให้ push ล้ม */ }
  }
  return true;
}

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let delivered = false;
    try {
      delivered = await showQueuedEvents();
    } catch {
      delivered = false;
    }
    // ไม่รู้ว่าเรื่องอะไร (หมดเซสชัน/เน็ตล่ม/เซิร์ฟเวอร์รีสตาร์ท) ก็ยังต้องแจ้ง
    // ไม่งั้นระบบปฏิบัติการจะลงโทษเราจนแจ้งเตือนตายถาวร
    if (!delivered) await wakeFallback();
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const candidate = new URL(event.notification.data?.url || "/console/", self.location.origin);
  const target = candidate.origin === self.location.origin && candidate.pathname.startsWith("/console/")
    ? candidate.href
    : new URL("/console/", self.location.origin).href;
  event.waitUntil((async () => {
    if ("clearAppBadge" in self.navigator) {
      try { await self.navigator.clearAppBadge(); } catch { /* ไม่สำคัญพอจะทำให้พัง */ }
    }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      const current = new URL(client.url);
      if (current.origin !== self.location.origin || !current.pathname.startsWith("/console")) continue;
      // navigate() ปฏิเสธเมื่อหน้าต่างนั้นยังไม่ถูก worker ตัวนี้ควบคุม (พบบ่อยมาก
      // เพราะหน้าที่ register ไว้จะไม่ถูกควบคุมจนกว่าจะโหลดใหม่) ถ้าไม่ดักไว้
      // ทั้ง handler จะล้ม → กดการแจ้งเตือนแล้วไม่มีอะไรเปิดขึ้นมาเลย
      try {
        await client.navigate(target);
      } catch { /* เปิดไม่ตรงห้องดีกว่าไม่เปิดอะไรเลย */ }
      return client.focus();
    }
    return self.clients.openWindow(target);
  })());
});

// worker ตัวใหม่ต้องได้คุมเครื่องทันที — บนมือถือ PWA แทบไม่เคยถูกปิดสนิท
// ถ้ารอให้ทุกแท็บปิดก่อน โค้ดที่แก้แล้วจะไม่มีวันไปถึงเครื่องพี่ง้วง
// ปลอดภัยเพราะ worker นี้ไม่มี fetch handler และไม่มี cache จึงไม่มีปัญหาเวอร์ชันชนกัน
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
