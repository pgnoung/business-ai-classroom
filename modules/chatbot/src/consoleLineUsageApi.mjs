// consoleLineUsageApi.mjs — เส้นทางของการ์ด "LINE OA เดือนนี้" (28 ก.ย. 2026)
//
//   GET /console/api/line-usage?month=YYYY-MM&channel=<id>   รายงานโควตา/ที่มาของข้อความ (สิทธิ์ line_usage.view)
//   PUT /console/api/line-usage/plan                          ราคาแพ็กเกจที่เจ้าของกรอก (สิทธิ์ finance.view + CSRF)
//
// line_usage.view = เจ้าของ + แอดมิน (พี่ง้วงขอให้ owner/admin เห็น) · staff ถูกกันสองชั้น (route + capability)
// ตัวเลขเงิน (cost/plan) ออกเฉพาะผู้มี finance.view — แบบเดียวกับค่า AI บนหน้าภาพรวม (คำสั่ง 1 ก.ย. 2026)
// โควตาเดือนนี้ยิงถาม LINE สด (lineClient แคช 5 นาที) พังก็ยังได้รายงานส่วนที่เหลือ
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { lineChannelsOf } from "./lineInsight.mjs";
import { loadLineUsageReport } from "./lineUsage.mjs";
import { LINE_PLAN_KEYS, parsePlanInput, readPlan, resolveMonth } from "./lineUsageReport.mjs";

export const LINE_USAGE_CAPABILITY = "line_usage.view";
const DENY_VIEW = "เฉพาะเจ้าของและแอดมินเท่านั้นที่ดูการใช้ข้อความ LINE ได้";
const DENY_PLAN = "เฉพาะเจ้าของเท่านั้นที่ตั้งราคาแพ็กเกจ LINE ได้";

export function createConsoleLineUsageRoutes({ db, channels = [], lineRegistry = null, now = Date.now, logger = console } = {}) {
  const lineChannels = lineChannelsOf(channels);
  const lineIds = new Set(lineChannels.map((ch) => ch.id));
  const nameOf = (id) => lineChannels.find((ch) => ch.id === id)?.name || id;

  async function liveQuotas(ids) {
    if (!lineRegistry) return [];
    return Promise.all(ids.map(async (id) => ({
      channelId: id, name: nameOf(id),
      quota: await Promise.resolve().then(() => lineRegistry.forChannel(id).getQuota()).catch(() => null),
    })));
  }

  async function report(req, res, url, { json, operator }) {
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
    const nowMs = now();
    const month = resolveMonth(url.searchParams.get("month"), nowMs);
    if (!month.ok) return json(res, 400, { ok: false, error: "เดือนต้องเป็น YYYY-MM ของเดือนนี้หรือย้อนหลังไม่เกิน 11 เดือน" });
    const channel = url.searchParams.get("channel") || "";
    if (channel && !lineIds.has(channel)) {
      return json(res, 400, { ok: false, error: "เลือกได้เฉพาะ OA ของ LINE (Facebook ส่งฟรี ไม่มีโควตา)" });
    }
    const ids = channel ? [channel] : [...lineIds];
    const includeCost = hasOperatorCapability(operator, "finance.view");
    try {
      const data = loadLineUsageReport({
        db, nowMs, monthKey: month.key, channelIds: channel ? [channel] : [],
        quotas: month.current ? await liveQuotas(ids) : [],
        includeCost,
        // audit ไม่ได้จดว่าแจ้งเตือนออกทาง OA ไหน — เติมช่วงก่อนเริ่มบันทึกได้เฉพาะมุมมองรวม/instance OA เดียว
        auditBackfill: !channel || lineIds.size <= 1,
      });
      return json(res, 200, {
        ok: true, report: data, canEditPlan: includeCost,
        channels: lineChannels.map((ch) => ({ id: ch.id, name: ch.name || ch.id })),
      });
    } catch (err) {
      logger.warn?.(`line-usage: ประกอบรายงานไม่สำเร็จ (${err?.message || err})`);
      return json(res, 500, { ok: false, error: "อ่านข้อมูลการใช้ข้อความ LINE ไม่สำเร็จ" });
    }
  }

  async function savePlan(req, res, { json, operator, username, readJson, requireCsrf }) {
    if (req.method !== "PUT") return json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
    if (!hasOperatorCapability(operator, "finance.view")) return json(res, 403, { ok: false, error: DENY_PLAN });
    if (!requireCsrf()) return json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
    const parsed = parsePlanInput(await readJson(req));
    if (!parsed.ok) return json(res, 400, { ok: false, error: parsed.error });
    for (const [field, key] of Object.entries(LINE_PLAN_KEYS)) {
      db.setSetting(key, parsed.plan[field] === null ? "" : String(parsed.plan[field]));
    }
    const values = Object.entries(parsed.plan).map(([field, value]) => `${field}=${value ?? "-"}`).join(" ");
    try {
      db.addAudit({ operator: username, action: "line_plan_update", target: "line_plan", detail: values });
    } catch (err) {
      logger.warn?.(`line-usage: บันทึก audit ราคาแพ็กเกจไม่สำเร็จ (${err?.message || err})`);
    }
    return json(res, 200, { ok: true, plan: readPlan((key) => db.getSetting(key)) });
  }

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "line-usage") return false;
    if (!hasOperatorCapability(ctx.operator, LINE_USAGE_CAPABILITY)) {
      ctx.json(res, 403, { ok: false, error: DENY_VIEW });
      return true;
    }
    if (route.length === 1) { await report(req, res, url, ctx); return true; }
    if (route.length === 2 && route[1] === "plan") { await savePlan(req, res, ctx); return true; }
    ctx.json(res, 404, { ok: false, error: "ไม่พบเส้นทาง" });
    return true;
  }

  return { handle };
}
