// consoleHashtagTagsApi.mjs — GET/POST /console/api/settings/hashtag-tags (ข้อ 8 ของพี่ง้วง 28 ก.ย. 2026)
//
// หน้าตั้งค่าให้เจ้าของติ๊กเองทีละคีย์เวิร์ดว่า # ไหนติดป้ายอะไร (ไม่ติด / ของแจก: … / กิจกรรม: …)
// ค่าเริ่มต้นทุกคำ = ไม่ติด · อ่านได้ทุกบทบาทที่เข้าหน้าตั้งค่า · เปลี่ยนได้เฉพาะ Super Admin (เหมือนสวิตช์พฤติกรรม)
// รายการคำ = คำที่ตั้งเป็นคีย์เวิร์ดกิจกรรมไว้ + คำที่ลูกค้าพิมพ์จริง (≥2 ห้อง ใน 180 วัน) + คำที่มีกติกาอยู่แล้ว
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { hashtagBusinessKeywords } from "./pipeline.mjs";
import { activeTagFramework } from "./tagFrameworkMode.mjs";
import {
  HASHTAG_TAG_DIMENSIONS, listHashtagKeywordsSeen, readHashtagTagRules, saveHashtagTagRule, validateHashtagTagRule,
} from "./hashtagTagRules.mjs";

const DENY_READ = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";
const DENY_EDIT = "เฉพาะ Super Admin เท่านั้นที่ตั้งว่าคีย์เวิร์ดไหนติดป้ายอะไร";

export function createHashtagTagRoutes({ db, config, tagFramework = null, now = Date.now } = {}) {
  function snapshot(canEdit) {
    const rules = readHashtagTagRules(db);
    let configured = {};
    try {
      configured = hashtagBusinessKeywords({ db, config }) || {};
    } catch {
      configured = {};
    }
    let seen = [];
    try {
      seen = listHashtagKeywordsSeen(db, { now: now() });
    } catch {
      seen = [];
    }
    const byKeyword = new Map(seen.map((row) => [row.keyword, { ...row }]));
    for (const keyword of [...Object.keys(configured), ...Object.keys(rules)]) {
      if (!byKeyword.has(keyword)) byKeyword.set(keyword, { keyword, rooms: 0, lastAt: 0 });
    }
    const keywords = [...byKeyword.values()]
      .map((row) => ({ ...row, configured: Object.hasOwn(configured, row.keyword), rule: rules[row.keyword] || null }))
      .sort((a, b) => Number(Boolean(b.rule)) - Number(Boolean(a.rule)) || b.rooms - a.rooms || a.keyword.localeCompare(b.keyword));
    return {
      ok: true, canEdit,
      // กรอบปิด = กติกาเก็บไว้ได้ แต่ยังไม่ติดป้ายให้ใคร (บอกเจ้าของตรง ๆ)
      active: Boolean(activeTagFramework(db, tagFramework)),
      dimensions: [...HASHTAG_TAG_DIMENSIONS],
      keywords,
    };
  }

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "settings" || route[1] !== "hashtag-tags" || route.length !== 2) return false;
    const { json, readJson, username, operator, requireCsrf } = ctx;
    if (!tagFramework) {
      json(res, 404, { ok: false, error: "เครื่องนี้ยังไม่มีกรอบป้ายชุดเดียว" });
      return true;
    }
    if (!hasOperatorCapability(operator, "settings.manage")) {
      json(res, 403, { ok: false, error: DENY_READ });
      return true;
    }
    const canEdit = String(operator?.role || "") === "owner";
    if (req.method === "GET") {
      json(res, 200, snapshot(canEdit));
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    if (!canEdit) {
      json(res, 403, { ok: false, error: DENY_EDIT });
      return true;
    }
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }
    const body = await readJson(req);
    const checked = validateHashtagTagRule({ keyword: body?.keyword, dimension: body?.dimension, value: body?.value }, tagFramework);
    if (!checked.ok) {
      json(res, 400, { ok: false, error: checked.reason });
      return true;
    }
    saveHashtagTagRule(db, checked.keyword, checked.rule);
    db.addAudit({
      operator: username, action: "hashtag_tag_rule", target: checked.keyword,
      detail: checked.rule ? `${checked.rule.dimension}: ${checked.rule.value}` : "ไม่ติดป้าย",
    });
    json(res, 200, snapshot(canEdit));
    return true;
  }
  return { handle };
}
