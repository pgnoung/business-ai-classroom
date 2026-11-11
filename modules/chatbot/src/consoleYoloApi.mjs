// consoleYoloApi.mjs — เส้นคอนโซลของ YOLO + ตั้งค่า "Telegram สั่งงานลูกแพร" (2026-09-28)
//
//   GET  /console/api/customers/:id/yolo        ด่านหน้า (ไม่ร่าง): เหตุที่ส่งไม่ได้ / ต้องยืนยัน / คำเตือน
//   POST /console/api/customers/:id/yolo        { instruction?, enableAi?, confirm? } → ส่ง 1 ครั้ง
//                                               { mode:"handoff", message?, closeAi? } → ส่งต่อแอดมิน (2026-10-15)
//   GET  /console/api/settings/telegram         สถานะบอท (โทเคนแบบปิดบัง) + การจับคู่
//   POST /console/api/settings/telegram         { token } | { clear:true } | { unpair:true }
//   POST /console/api/settings/telegram/pairing รหัสจับคู่ใช้ครั้งเดียว (เจ้าของเท่านั้น)
//
// สิทธิ์: yolo.send (owner + admin) · ตั้งค่า Telegram = integrations.manage (owner) และการออกรหัส
// จับคู่ต้องเป็นบทบาท owner ด้วย — บัญชีที่จับคู่แล้วสั่งส่งข้อความหาลูกค้าได้ จึงเป็นของเจ้าของคนเดียว
// audit ไม่เคยมีโทเคนหรือรหัสจับคู่ — มีแค่ว่า "ใครทำอะไร"
import { hasOperatorCapability } from "./operatorRoles.mjs";

const DENY = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";
const CSRF_FAILED = "CSRF token ไม่ถูกต้อง";

function httpStatusFor(result) {
  if (result.ok) return 200;
  if (result.status === "needs_confirmation") return 409;
  if (result.status === "failed") return 502;
  return 422;
}

export function createConsoleYoloRoutes({ db, yolo = null, telegram = null }) {
  async function handleYolo(req, res, route, ctx) {
    const { readJson, json, username, operator, requireCsrf } = ctx;
    if (!hasOperatorCapability(operator, "yolo.send")) return json(res, 403, { ok: false, error: DENY });
    if (!yolo) return json(res, 503, { ok: false, error: "ระบบ YOLO ยังไม่พร้อม" });
    const customerId = decodeURIComponent(route[1]);
    if (req.method === "GET") {
      if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      return json(res, 200, { ok: true, ...yolo.preflight(customerId) });
    }
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method ไม่รองรับ" });
    if (!requireCsrf()) return json(res, 403, { ok: false, error: CSRF_FAILED });
    const body = await readJson(req);
    if (body.mode != null && !["followup", "handoff"].includes(body.mode)) {
      return json(res, 400, { ok: false, error: "mode ต้องเป็น followup หรือ handoff" });
    }
    if (body.mode === "handoff") return handleHandoff(res, customerId, body, ctx);
    if (body.instruction != null && typeof body.instruction !== "string") {
      return json(res, 400, { ok: false, error: "instruction ต้องเป็นข้อความ" });
    }
    for (const flag of ["enableAi", "confirm"]) {
      if (body[flag] != null && typeof body[flag] !== "boolean") return json(res, 400, { ok: false, error: `${flag} ต้องเป็น boolean` });
    }
    if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
    const result = await yolo.run({
      customerId, instruction: body.instruction || "", actor: username, source: "console",
      alsoEnableAi: body.enableAi === true, confirm: body.confirm === true,
    });
    return json(res, httpStatusFor(result), result.ok ? result : { ...result, error: result.reasonText || "ส่งไม่สำเร็จ" });
  }

  // 2026-10-15 (พี่ง้วง): ตัวเลือก "ส่งต่อแอดมิน" — { mode:"handoff", message?, closeAi? }
  // message = คำที่คนพิมพ์ ส่งถึงลูกค้าตามนั้น (ว่าง = แจ้งแอดมินอย่างเดียว) · closeAi ไม่ส่ง = ปิด (ค่าเริ่มต้น)
  async function handleHandoff(res, customerId, body, ctx) {
    const { json, username, operator } = ctx;
    if (body.message != null && typeof body.message !== "string") return json(res, 400, { ok: false, error: "message ต้องเป็นข้อความ" });
    if (body.closeAi != null && typeof body.closeAi !== "boolean") return json(res, 400, { ok: false, error: "closeAi ต้องเป็น boolean" });
    if (typeof yolo.handoff !== "function") return json(res, 503, { ok: false, error: "ตัวเลือกส่งต่อแอดมินยังไม่พร้อม" });
    if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
    const result = await yolo.handoff({
      customerId, message: body.message || "", closeAi: body.closeAi !== false, source: "console",
      actor: username, actorName: operator?.displayName || operator?.display_name || username,
    });
    return json(res, httpStatusFor(result), result.ok ? result : { ...result, error: result.reasonText || "ส่งต่อไม่สำเร็จ" });
  }

  async function handleTelegram(req, res, route, ctx) {
    const { readJson, json, username, operator, requireCsrf } = ctx;
    if (!hasOperatorCapability(operator, "integrations.manage")) return json(res, 403, { ok: false, error: DENY });
    if (!telegram) return json(res, 503, { ok: false, error: "ช่อง Telegram ยังไม่พร้อม" });
    if (route.length === 2 && req.method === "GET") return json(res, 200, { ok: true, ...telegram.view() });
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method ไม่รองรับ" });
    if (!requireCsrf()) return json(res, 403, { ok: false, error: CSRF_FAILED });
    if (route.length === 3 && route[2] === "pairing") {
      if (operator?.role !== "owner") return json(res, 403, { ok: false, error: "เฉพาะเจ้าของเท่านั้นที่ออกรหัสจับคู่ได้" });
      const pairing = telegram.createPairing(username);
      if (!pairing.ok) return json(res, pairing.status || 409, { ok: false, error: pairing.error });
      db.addAudit({ operator: username, action: "telegram_pairing_created", detail: "รหัสใช้ครั้งเดียว อายุ 15 นาที" });
      return json(res, 200, pairing);
    }
    if (route.length !== 2) return json(res, 404, { ok: false, error: "ไม่พบ endpoint นี้" });
    const body = await readJson(req);
    if (body.clear === true) {
      telegram.clearToken();
      db.addAudit({ operator: username, action: "telegram_token_clear", detail: "ลบโทเคน + การจับคู่" });
      return json(res, 200, { ok: true, ...telegram.view() });
    }
    if (body.unpair === true) {
      telegram.unpair();
      db.addAudit({ operator: username, action: "telegram_unpair", detail: "ยกเลิกการจับคู่เจ้าของ" });
      return json(res, 200, { ok: true, ...telegram.view() });
    }
    if (typeof body.token !== "string" || !body.token.trim()) return json(res, 400, { ok: false, error: "ไม่มีข้อมูลให้บันทึก" });
    const saved = await telegram.saveToken(body.token);
    if (!saved.ok) return json(res, saved.status || 400, { ok: false, error: saved.error });
    db.addAudit({ operator: username, action: "telegram_token_set", detail: saved.botUsername ? `bot @${saved.botUsername}` : "bot" });
    return json(res, 200, { ok: true, ...telegram.view() });
  }

  // คืน true = จัดการแล้ว / false = ไม่ใช่เส้นของไฟล์นี้
  async function handle(req, res, url, route, ctx) {
    if (route[0] === "customers" && route[2] === "yolo" && route.length === 3) {
      await handleYolo(req, res, route, ctx);
      return true;
    }
    if (route[0] === "settings" && route[1] === "telegram" && (route.length === 2 || (route.length === 3 && route[2] === "pairing"))) {
      await handleTelegram(req, res, route, ctx);
      return true;
    }
    return false;
  }

  return { handle };
}
