// consoleUsageApi.mjs — หน้า "Usage วันนี้" ของเจ้าของ (8 พ.ย. 2026)
//
//   GET /console/api/usage/today   ตัวเลขรวมวันนี้ + สถานะกุญแจ API (สิทธิ์ finance.view = พี่ง้วงคนเดียว)
//
// กันเส้นตอบแชทไม่ให้ช้าลง:
//   · แคชผลทั้งก้อน 30 วิในหน่วยความจำ — เปิดหลายแท็บ/หน้า poll ทุกนาที ก็คิวรี SQLite ไม่เกินครั้งละ 30 วิ
//   · คำขอซ้อนระหว่างกำลังประกอบ = รอผลเดียวกัน (ไม่ยิงซ้ำ) · ประกอบพัง = ตอบ 500 ไม่ค้างแคชที่พัง
//   · สถานะกุญแจถามเกตเวย์ในเครื่อง (GET /models/health ไม่ยิงผู้ให้บริการ) เพดาน 2.5 วิ — ล่ม = หน้าอื่นยังขึ้นครบ
// ผลไม่มีชื่อ ข้อความ หรือรหัสลูกค้า · ไม่มีค่ากุญแจ (เกตเวย์ส่งแค่เลขชุด)
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { buildUsageToday } from "./usageToday.mjs";

export const USAGE_CACHE_MS = 30_000;
export const USAGE_GATEWAY_TIMEOUT_MS = 2_500;
const DENY = "หน้านี้สำหรับเจ้าของเท่านั้น";

/** แปลงผล /models/health ของเกตเวย์ให้เหลือเฉพาะสิ่งที่หน้าเจ้าของต้องเห็น (pure) */
export function keysFromHealth(health) {
  if (!health || typeof health !== "object") return null;
  const slots = (list) => (Array.isArray(list) ? list : [])
    .map((key) => ({ slot: Number(key?.slot) || 0, active: key?.active === true })).filter((key) => key.slot > 0);
  return {
    ok: health.ok === true,
    openai: slots(health.openaiKeys),
    anthropic: slots(health.anthropicKeys),
    lastSwitchAt: { openai: String(health.openaiKeyLastSwitchAt || ""), anthropic: String(health.anthropicKeyLastSwitchAt || "") },
    failingModels: Object.keys(health.modelFailures && typeof health.modelFailures === "object" ? health.modelFailures : {}).slice(0, 12),
  };
}

export function createConsoleUsageRoutes({
  db, now = Date.now, costReport, fxNow, currentModels = () => ({}), qualifyModel = "", qualifyDailyCapThb = 0,
  gatewayBase = "", gatewayToken = "", fetchImpl = globalThis.fetch, logger = console, cacheMs = USAGE_CACHE_MS,
} = {}) {
  let cached = null; // { at, payload }
  let building = null;

  async function gatewayKeys() {
    if (!gatewayBase || typeof fetchImpl !== "function") return null;
    try {
      const res = await fetchImpl(`${String(gatewayBase).replace(/\/+$/u, "")}/models/health`, {
        headers: gatewayToken ? { authorization: `Bearer ${gatewayToken}` } : {},
        signal: AbortSignal.timeout(USAGE_GATEWAY_TIMEOUT_MS),
      });
      if (!res?.ok) return null;
      return keysFromHealth(await res.json());
    } catch {
      return null; // เกตเวย์ไม่ตอบ = การ์ดกุญแจบอกว่าอ่านไม่ได้ ไม่ลากทั้งหน้า
    }
  }

  async function build() {
    const nowMs = now();
    const rate = fxNow();
    const thbPerUsd = Number(rate?.thbPerUsd) > 0 ? Number(rate.thbPerUsd) : 0;
    const usage = buildUsageToday({ db, nowMs, costReport, thbPerUsd, models: currentModels() || {}, qualifyModel, qualifyDailyCapThb });
    return { ...usage, fxSource: rate?.source || "", keys: await gatewayKeys() };
  }

  async function payload() {
    const t = now();
    if (cached && t - cached.at < cacheMs) return cached.payload;
    building ??= build().then((value) => {
      cached = { at: now(), payload: value };
      return value;
    }).finally(() => { building = null; });
    return building;
  }

  async function handle(req, res, url, route, { json, operator }) {
    if (route[0] !== "usage") return false;
    if (!hasOperatorCapability(operator, "finance.view")) {
      json(res, 403, { ok: false, error: DENY });
      return true;
    }
    if (route.length !== 2 || route[1] !== "today") {
      json(res, 404, { ok: false, error: "ไม่พบเส้นทาง" });
      return true;
    }
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    try {
      json(res, 200, { ok: true, usage: await payload() });
    } catch (err) {
      logger.warn?.(`usage-today: ประกอบตัวเลขไม่สำเร็จ (${err?.message || err})`);
      json(res, 500, { ok: false, error: "อ่านตัวเลขการใช้งานวันนี้ไม่สำเร็จ" });
    }
    return true;
  }

  return { handle };
}
