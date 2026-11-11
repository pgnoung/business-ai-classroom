import { hasOperatorCapability } from "./operatorRoles.mjs";

// Owner/admin browser notification routes. No subscription endpoint or VAPID
// private key is ever returned to the browser after registration.
// ownerItems(username) = รายการแจ้งเตือนของห้องตรวจ (เฉพาะบัญชี owner — consoleApi ส่งมา · ไม่ส่ง = ไม่มี)
export function createConsolePushRoutes({ webPush, db, ownerItems = null }) {
  async function handle(req, res, route, ctx) {
    if (route[0] !== "push") return false;
    const { readJson, json, username, operator, session, requireCsrf } = ctx;
    if (!hasOperatorCapability(operator, "notifications.manage")) {
      json(res, 403, { ok: false, error: "เฉพาะ Super Admin หรือ Admin เปิดการแจ้งเตือนบนอุปกรณ์ได้" });
      return true;
    }

    if (req.method === "GET" && route.length === 1) {
      // ?endpoint= ให้เบราว์เซอร์ถามได้ว่า "เครื่องนี้" ยังอยู่ในสถานะส่งถึงจริงไหม
      // เดิมหน้าเว็บเดาเองจากการมี subscription object ในเครื่อง ซึ่งไม่รู้เรื่อง
      // session หมดอายุ token_version เปลี่ยน หรือถูกปลดฝั่งเซิร์ฟเวอร์เลย
      const url = new URL(req.url, "http://internal");
      const endpoint = url.searchParams.get("endpoint") || "";
      const status = webPush?.statusFor(username) || {};
      json(res, 200, {
        ok: true,
        ...status,
        thisDeviceActive: endpoint ? webPush?.isEndpointActive?.(username, endpoint) === true : null,
        // ตัวเลือก "เฉพาะห้องตรวจ" มีความหมายเฉพาะบัญชี owner (ห้องตรวจเด้งถึง owner คนเดียว)
        reviewScope: operator?.role === "owner",
      });
      return true;
    }
    if (req.method === "GET" && route[1] === "pending" && route.length === 2) {
      // `events` คือรูปแบบปัจจุบัน (หนึ่งการแจ้งเตือนต่อหนึ่งเคส)
      // `event` คงไว้ให้ service worker รุ่นเก่าที่ยังค้างบนเครื่องอ่านได้ต่อ
      const waiting = webPush?.pendingListFor?.(username) || [];
      // 12 ต.ค. 2026 ค่ำ: "รอยืนยันปิด N ห้อง" ถึงพี่ง้วงคนเดียว (ทีมไม่เห็นรายการนี้แม้เครื่องตื่นพร้อมกัน)
      let extra = [];
      if (operator?.role === "owner" && typeof ownerItems === "function") {
        try { extra = ownerItems(username) || []; } catch { extra = []; }
      }
      const events = [...waiting, ...extra];
      json(res, 200, { ok: true, events, event: events[events.length - 1] || null });
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }
    const body = await readJson(req);
    if (route[1] === "subscribe" && route.length === 2) {
      const result = webPush.subscribe({
        operator, endpoint: body.endpoint, sessionId: session.sid,
        sessionExpiresAt: session.exp, userAgent: req.headers["user-agent"] || "",
      });
      if (!result.ok) {
        const status = result.error === "web_push_unavailable" ? 503 : 400;
        json(res, status, { ok: false, error: status === 503 ? "Web Push ยังไม่พร้อมบนเซิร์ฟเวอร์" : "push endpoint ไม่ถูกต้อง" });
        return true;
      }
      db.addAudit({ operator: username, action: "web_push_subscribe", detail: "console device enabled" });
      json(res, 201, { ok: true, activeDeviceCount: webPush?.statusFor(username)?.activeDeviceCount });
      return true;
    }
    // 13 ต.ค. 2026: เลือกว่าเครื่องของบัญชีนี้จะเด้งเรื่องอะไร (all · admin · review) — ตั้งได้เฉพาะบัญชีตัวเอง
    if (route[1] === "scope" && route.length === 2) {
      const scope = String(body?.scope || "");
      const result = webPush?.setScope?.(username, scope);
      if (!result?.ok) {
        json(res, 400, { ok: false, error: "ตัวเลือกการแจ้งเตือนไม่ถูกต้อง" });
        return true;
      }
      db.addAudit({ operator: username, action: "web_push_scope", detail: `scope=${scope}` });
      json(res, 200, { ok: true, scope });
      return true;
    }
    if (route[1] === "unsubscribe" && route.length === 2) {
      const result = webPush.unsubscribe({ operatorUsername: username, endpoint: body.endpoint });
      if (!result.ok) {
        json(res, 400, { ok: false, error: "push endpoint ไม่ถูกต้อง" });
        return true;
      }
      db.addAudit({ operator: username, action: "web_push_unsubscribe", detail: "console device disabled" });
      json(res, 200, { ok: true, activeDeviceCount: webPush?.statusFor(username)?.activeDeviceCount });
      return true;
    }
    json(res, 404, { ok: false, error: "ไม่พบ endpoint นี้" });
    return true;
  }
  return { handle };
}
