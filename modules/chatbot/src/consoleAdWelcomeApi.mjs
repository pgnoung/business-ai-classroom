// consoleAdWelcomeApi.mjs — GET/POST /console/api/settings/fb-ad-welcome
// (audit ก.ย. 2026 §4.1: ให้ระบบรู้ว่าโฆษณา Facebook ถามอะไรก่อนลูกค้าพิมพ์ "ยังครับ" มา)
//
// อ่านได้ทุกบทบาทที่เข้าหน้าตั้งค่าได้ (ทีมควรเห็นว่าลูกแพรเข้าใจโฆษณาว่าอย่างไร)
// เขียนได้เฉพาะ Super Admin / Admin ตามที่เจ้าของกำหนด — ค่านี้เข้าพรอมต์ของเทิร์นเปิดห้องตรง ๆ
// ทุกการเขียนมีแถว audit (เก็บแค่ความยาว ไม่เก็บข้อความ)
import { hasOperatorCapability } from "./operatorRoles.mjs";
import {
  AD_WELCOME_QUESTION_KEY, AD_WELCOME_QUESTION_MAX, normalizeAdWelcomeQuestion, readAdWelcomeQuestion,
} from "./adWelcomeQuestion.mjs";

const EDIT_ROLES = new Set(["owner", "admin"]);
const DENY_READ = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";
const DENY_EDIT = "เฉพาะ Super Admin หรือ Admin เท่านั้นที่แก้คำถามต้อนรับในโฆษณาได้";

export function createAdWelcomeRoutes({ db } = {}) {
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "settings" || route[1] !== "fb-ad-welcome" || route.length !== 2) return false;
    const { json, readJson, username, operator, requireCsrf } = ctx;
    if (!hasOperatorCapability(operator, "settings.manage")) {
      json(res, 403, { ok: false, error: DENY_READ });
      return true;
    }
    const snapshot = () => ({
      ok: true,
      question: readAdWelcomeQuestion(db),
      maxChars: AD_WELCOME_QUESTION_MAX,
      canEdit: EDIT_ROLES.has(String(operator?.role || "")),
    });
    if (req.method === "GET") {
      json(res, 200, snapshot());
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    if (!EDIT_ROLES.has(String(operator?.role || ""))) {
      json(res, 403, { ok: false, error: DENY_EDIT });
      return true;
    }
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }
    const body = await readJson(req);
    if (typeof body?.question !== "string" || [...body.question].length > AD_WELCOME_QUESTION_MAX * 2) {
      json(res, 400, { ok: false, error: `question ต้องเป็นข้อความไม่เกิน ${AD_WELCOME_QUESTION_MAX} ตัวอักษร` });
      return true;
    }
    const question = normalizeAdWelcomeQuestion(body.question);
    db.setSetting(AD_WELCOME_QUESTION_KEY, question);
    db.addAudit({
      operator: username, action: "fb_ad_welcome_question_set", target: AD_WELCOME_QUESTION_KEY,
      detail: question ? `${[...question].length} ตัวอักษร` : "(ล้างค่า)",
    });
    json(res, 200, snapshot());
    return true;
  }
  return { handle };
}
