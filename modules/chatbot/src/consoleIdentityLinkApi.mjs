// consoleIdentityLinkApi.mjs — เส้นคอนโซลของแผง "ช่องทางอื่นของลูกค้าคนนี้" (28 ก.ย. 2026)
//
//   GET  /customers/:id/identity              ข้อมูลแผง (ทุกบทบาทที่เปิดห้องได้ — ไม่มีรหัส/hash ออกไป)
//   POST /customers/:id/identity/invite       { classType } ส่งลิงก์ต่อแชท LINE ในห้อง Facebook (operations.use + สวิตช์เปิด)
//   GET  /customers/:id/identity/suggestions  ห้องที่อาจเป็นคนเดียวกัน ?q=ค้นชื่อ (identity.link)
//   POST /customers/:id/identity/link         { otherId, via: "team"|"suggestion", confirm: true } (identity.link)
//   POST /customers/:id/identity/unlink       { confirm: true } (identity.link)
//   GET  /settings/identity-link-templates         ข้อความหลังลูกค้าเชื่อม LINE แยกตามคลาส (settings.manage อ่านได้)
//   POST /settings/identity-link-templates         { classType, text } | { classType, reset: true } — Super Admin เท่านั้น
//   POST /settings/identity-link-templates/preview { classType, text } → บับเบิลที่ลูกค้าจะเห็น (ไม่บันทึก)
// ตรรกะทั้งหมดอยู่ identityLink.mjs — ไฟล์นี้ตรวจสิทธิ์ CSRF รูปข้อมูล แล้วแปลงผลเป็นรหัส HTTP + ข้อความไทย
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { IDENTITY_LINK_CAPABILITY, readIdentityTemplate, saveIdentityTemplate } from "./identityLink.mjs";
import {
  IDENTITY_CLASSES, IDENTITY_CLASS_TYPES, IDENTITY_TEMPLATE_DEFAULTS, IDENTITY_TEMPLATE_LIMITS,
  identityWelcomeBubbles, normalizeClassType, validateTemplateText, welcomeFallbackText,
} from "./identityLinkClasses.mjs";

// เหตุที่ส่งลิงก์ไม่ได้ → [HTTP, ข้อความ] (คอนโซลใช้ข้อความชุดเดียวกันบนปุ่ม — public/console/identityLinks.mjs)
export const INVITE_BLOCKERS = Object.freeze({
  mode_off: [409, "สวิตช์ \"ส่งลิงก์ต่อแชท LINE\" ยังปิดอยู่ (ตั้งค่า > สวิตช์พฤติกรรมลูกแพร)"],
  not_facebook: [400, "ส่งลิงก์ได้เฉพาะห้อง Facebook"],
  not_found: [404, "ไม่พบลูกค้า"],
  no_secret: [503, "ระบบยังไม่มีกุญแจสำหรับออกรหัส"],
  no_basic_id: [409, "ยังไม่รู้ LINE ID ของ OA (ถาม LINE ไม่สำเร็จ และไม่ได้ตั้ง LINE_BASIC_ID) — ลองกดใหม่อีกครั้ง"],
  already_linked: [409, "ลูกค้าคนนี้มีห้อง LINE ที่เชื่อมกันแล้ว"],
  send_disabled: [503, "ช่อง Facebook ยังไม่เปิดส่งข้อความจริง"],
  window_closed: [409, "เกิน 24 ชม. หลังข้อความล่าสุดของลูกค้า — Meta ไม่ให้ทักก่อน รอลูกค้าทักมาก่อนแล้วค่อยส่ง"],
  too_many: [429, "ส่งลิงก์ห้องนี้ครบ 3 ครั้งใน 24 ชม. แล้ว"],
  send_failed: [502, "Facebook ไม่รับข้อความ — ยังไม่ได้ส่งลิงก์ (รหัสถูกยกเลิกแล้ว)"],
  class_required: [400, "เลือกคลาสที่ลูกค้าซื้อก่อนส่งลิงก์"],
});

// ชื่อตัวอย่างในหน้าตั้งค่า (ลูกค้าจริงเห็นชื่อสั้นของตัวเอง — customerAddress.mjs)
const SAMPLE_NAME = "มาลี";

function templateView(db, type) {
  const template = readIdentityTemplate(db, type);
  const info = IDENTITY_CLASSES[type];
  return {
    classType: type, label: info.label, format: info.format, hint: info.hint,
    text: template.text, isDefault: template.isDefault, updatedBy: template.updatedBy, updatedAt: template.updatedAt,
    empty: !template.text.trim(), readError: template.readError,
    preview: identityWelcomeBubbles({ classType: type, template: template.text, knownName: SAMPLE_NAME }).bubbles,
    fallback: welcomeFallbackText(type),
    defaultText: IDENTITY_TEMPLATE_DEFAULTS[type],
  };
}

/** เส้นหน้าตั้งค่า — คืน false เมื่อไม่ใช่เส้นของไฟล์นี้ */
async function handleTemplates(req, res, route, { db, json, readJson, username, operator, requireCsrf }) {
  const preview = route[2] === "preview";
  if (route.length > 3 || (route.length === 3 && !preview)) return false;
  if (!hasOperatorCapability(operator, "settings.manage")) {
    json(res, 403, { ok: false, error: "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้" });
    return true;
  }
  const canEdit = String(operator?.role || "") === "owner";
  if (req.method === "GET" && !preview) {
    json(res, 200, {
      ok: true, canEdit, sampleName: SAMPLE_NAME, limits: IDENTITY_TEMPLATE_LIMITS,
      templates: IDENTITY_CLASS_TYPES.map((type) => templateView(db, type)),
    });
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
  const type = normalizeClassType(body?.classType);
  if (!type) {
    json(res, 400, { ok: false, error: "ไม่รู้จักคลาสนี้" });
    return true;
  }
  const text = typeof body?.text === "string" ? body.text : "";
  if (preview) {
    const checked = validateTemplateText(text);
    json(res, 200, {
      ok: true, valid: checked.ok, error: checked.error,
      bubbles: identityWelcomeBubbles({ classType: type, template: checked.text, knownName: SAMPLE_NAME }).bubbles,
    });
    return true;
  }
  // ข้อความตายตัวที่ส่งถึงลูกค้าจริง = เจ้าของอนุมัติเท่านั้น (เหตุผลเดียวกับสวิตช์พฤติกรรม)
  if (!canEdit) {
    json(res, 403, { ok: false, error: "เฉพาะ Super Admin เท่านั้นที่แก้ข้อความที่ส่งถึงลูกค้าได้" });
    return true;
  }
  if (body?.reset !== true && typeof body?.text !== "string") {
    json(res, 400, { ok: false, error: "ต้องส่งข้อความ (text) หรือ reset: true" });
    return true;
  }
  const saved = saveIdentityTemplate(db, type, { text: body?.reset === true ? null : text, by: username });
  if (!saved.ok) {
    json(res, 400, { ok: false, error: saved.error });
    return true;
  }
  const view = templateView(db, type);
  try {
    db.addAudit({
      operator: username, action: "identity_link_template_saved", target: type,
      detail: body?.reset === true ? "กลับไปใช้ข้อความค่าเริ่มต้น"
        : `แก้ข้อความหลังเชื่อม LINE ${view.empty ? "(เว้นว่าง)" : `(${view.text.length} ตัวอักษร · ${view.preview.length} บับเบิล)`}`,
    });
  } catch { /* audit ล้มไม่ทำให้การบันทึกที่สำเร็จแล้วกลายเป็นล้ม */ }
  json(res, 200, { ok: true, template: view });
  return true;
}

const LINK_ERRORS = Object.freeze({
  same: [400, "เลือกห้องอื่นที่ไม่ใช่ห้องนี้"],
  missing: [404, "ไม่พบห้องที่เลือก"],
  same_channel: [409, "สองห้องนี้อยู่ช่องทางเดียวกัน — หนึ่งคนมีได้ห้องเดียวต่อช่องทาง"],
  conflict: [409, "ห้องที่เลือกเป็นของลูกค้าอีกคนที่มีห้องช่องทางเดียวกันอยู่แล้ว — ยกเลิกการเชื่อมเดิมก่อน"],
});

const DENY_MANAGE = "เฉพาะ Super Admin หรือ Admin เท่านั้นที่เชื่อม/ยกเลิกการเชื่อมห้องได้";

export function createConsoleIdentityLinkRoutes({ db, identityLink }) {
  async function handle(req, res, url, route, ctx) {
    if (route[0] === "settings" && route[1] === "identity-link-templates") return handleTemplates(req, res, route, { db, ...ctx });
    if (route[0] !== "customers" || route[2] !== "identity" || route.length < 3 || route.length > 4) return false;
    const { json, readJson, username, operator, requireCsrf } = ctx;
    const action = route[3] || "";
    if (!["", "invite", "suggestions", "link", "unlink"].includes(action)) return false;
    let customerId = "";
    try { customerId = decodeURIComponent(route[1]); } catch { customerId = ""; }
    if (!customerId || !db.getCustomer(customerId)) {
      json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
      return true;
    }
    const canManage = hasOperatorCapability(operator, IDENTITY_LINK_CAPABILITY);

    if (req.method === "GET" && action === "") {
      json(res, 200, { ok: true, identity: identityLink.panel(customerId, { operator }) });
      return true;
    }
    if (req.method === "GET" && action === "suggestions") {
      if (!canManage) {
        json(res, 403, { ok: false, error: DENY_MANAGE });
        return true;
      }
      const q = String(url.searchParams.get("q") || "").trim().slice(0, 60);
      json(res, 200, { ok: true, q, suggestions: identityLink.suggestions(customerId, { q }) });
      return true;
    }
    if (req.method !== "POST" || action === "" || action === "suggestions") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }
    const body = await readJson(req);

    if (action === "invite") {
      if (!hasOperatorCapability(operator, "operations.use")) {
        json(res, 403, { ok: false, error: "บัญชีนี้ไม่มีสิทธิ์ส่งข้อความถึงลูกค้า" });
        return true;
      }
      // คลาสที่ทีมเลือก — ไม่เลือก/ค่าแปลก = class_required (ตรวจหลังเหตุที่ส่งไม่ได้อื่น ๆ ให้ปุ่มบอกเหตุที่ตรงที่สุด)
      const classType = normalizeClassType(body?.classType);
      const result = await identityLink.sendInvite({ customerId, operator: username, via: "console", classType });
      if (!result.ok) {
        const [status, error] = INVITE_BLOCKERS[result.reason] || [500, "ส่งลิงก์ไม่สำเร็จ"];
        json(res, status, { ok: false, reason: result.reason, error });
        return true;
      }
      json(res, 200, { ok: true, invite: result, identity: identityLink.panel(customerId, { operator }) });
      return true;
    }

    if (!canManage) {
      json(res, 403, { ok: false, error: DENY_MANAGE });
      return true;
    }
    if (body?.confirm !== true) {
      json(res, 400, { ok: false, error: "ต้องยืนยันก่อน (confirm: true)" });
      return true;
    }
    if (action === "link") {
      const otherId = typeof body.otherId === "string" ? body.otherId.trim() : "";
      if (!otherId || otherId.length > 200) {
        json(res, 400, { ok: false, error: "ต้องเลือกห้องที่จะเชื่อม" });
        return true;
      }
      const via = body.via === "suggestion" ? "suggestion" : "team";
      const result = identityLink.linkByTeam({ customerId, otherId, operator: username, via });
      if (result.state !== "linked" && result.state !== "already") {
        const [status, error] = LINK_ERRORS[result.state] || [409, "เชื่อมห้องไม่สำเร็จ"];
        json(res, status, { ok: false, state: result.state, error });
        return true;
      }
      json(res, 200, {
        ok: true, state: result.state,
        buyer: (result.inherited || []).some((item) => item.buyer === true),
        identity: identityLink.panel(customerId, { operator }),
      });
      return true;
    }
    // unlink
    const result = identityLink.unlink({ customerId, operator: username });
    if (result.state !== "unlinked") {
      json(res, 409, { ok: false, state: result.state, error: "ห้องนี้ไม่ได้เชื่อมกับห้องอื่น" });
      return true;
    }
    json(res, 200, {
      ok: true, state: result.state, reopened: result.reopened || [],
      identity: identityLink.panel(customerId, { operator }),
    });
    return true;
  }
  return { handle };
}
