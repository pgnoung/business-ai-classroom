import { hashPassword } from "./auth.mjs";
import { internalManagedRole, operatorInfo, publicRoleKey, publicRoleLabel } from "./operatorRoles.mjs";

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;

function publicAccount(row) {
  return {
    username: row.username,
    displayName: row.display_name,
    roleKey: publicRoleKey(row.role),
    roleLabel: publicRoleLabel(row.role),
    disabled: row.disabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cleanPassword(value) {
  const password = String(value || "");
  return password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX ? password : null;
}

function cleanDisplayName(value) {
  const name = String(value || "").trim();
  return name && name.length <= 80 ? name : null;
}

export function createOperatorAdminRoutes({ db }) {
  async function handle(req, res, route, ctx) {
    if (route[0] !== "operators") return false;
    const { readJson, json, username, operator, requireCsrf } = ctx;
    if (operator?.role !== "owner") {
      json(res, 403, { ok: false, error: "เฉพาะ Super Admin จัดการผู้ใช้ได้" });
      return true;
    }

    if (req.method === "GET" && route.length === 1) {
      json(res, 200, { ok: true, operators: db.listOperators().map(publicAccount) });
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

    if (route.length === 1) {
      const body = await readJson(req);
      const targetUsername = String(body.username || "").trim().toLowerCase();
      const displayName = cleanDisplayName(body.displayName);
      const role = internalManagedRole(body.role);
      const password = cleanPassword(body.password);
      if (!USERNAME_RE.test(targetUsername)) {
        json(res, 400, { ok: false, error: "username ต้องมี 3–32 ตัว ใช้ a-z, 0-9, จุด, ขีดกลาง หรือขีดล่าง" });
        return true;
      }
      if (!displayName || !role || !password) {
        json(res, 400, { ok: false, error: "ชื่อแสดงผล/role/rหัสผ่านไม่ถูกต้อง (รหัสอย่างน้อย 12 ตัว)" });
        return true;
      }
      if (db.getOperator(targetUsername)) {
        json(res, 409, { ok: false, error: "username นี้มีอยู่แล้ว" });
        return true;
      }
      const created = db.createOperator({
        username: targetUsername,
        passHash: hashPassword(password),
        displayName,
        role,
      });
      db.addAudit({ operator: username, action: "operator_create", target: targetUsername, detail: `role=${publicRoleKey(role)}` });
      json(res, 201, { ok: true, operator: publicAccount(created) });
      return true;
    }

    const targetUsername = decodeURIComponent(route[1] || "");
    const target = db.getOperator(targetUsername);
    if (!target) {
      json(res, 404, { ok: false, error: "ไม่พบบัญชีนี้" });
      return true;
    }
    // บัญชี owner ใช้ช่องทางเปลี่ยนรหัสของตัวเองเท่านั้น และห้าม demote/disable
    // ผ่าน user admin เพื่อไม่ให้ระบบเหลือโดยไม่มี Super Admin.
    if (target.role === "owner") {
      json(res, 403, { ok: false, error: "บัญชี Super Admin แก้จากหน้านี้ไม่ได้" });
      return true;
    }

    if (route.length === 2) {
      const body = await readJson(req);
      const displayName = cleanDisplayName(body.displayName);
      const role = internalManagedRole(body.role);
      if (!displayName || !role || typeof body.disabled !== "boolean") {
        json(res, 400, { ok: false, error: "ชื่อแสดงผล/role/สถานะไม่ถูกต้อง" });
        return true;
      }
      db.updateOperatorAccount(targetUsername, { displayName, role, disabled: body.disabled });
      db.addAudit({
        operator: username,
        action: "operator_update",
        target: targetUsername,
        detail: `role=${publicRoleKey(role)} disabled=${body.disabled}`,
      });
      json(res, 200, { ok: true, operator: publicAccount(db.getOperator(targetUsername)) });
      return true;
    }

    if (route.length === 3 && route[2] === "password") {
      const body = await readJson(req);
      const password = cleanPassword(body.newPassword);
      if (!password) {
        json(res, 400, { ok: false, error: "รหัสผ่านใหม่ต้องยาว 12–256 ตัวอักษร" });
        return true;
      }
      db.changeOperatorPassword(targetUsername, hashPassword(password));
      db.addAudit({ operator: username, action: "operator_password_reset", target: targetUsername });
      json(res, 200, { ok: true });
      return true;
    }

    json(res, 404, { ok: false, error: "ไม่พบ endpoint นี้" });
    return true;
  }

  return { handle };
}
