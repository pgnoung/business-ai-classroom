// canary.mjs — synthetic probe ยิงจริง (G1b)
//
// ทำงาน: ทุก intervalMs ยิงข้อความสังเคราะห์ผ่าน pipeline เต็มเส้น (gate -> router ->
// hermes -> guard -> humanizer -> gate -> LINE mock/live) แล้ววัด round-trip
// บันทึกลง canary_state และโผล่ใน /health — บอทเงียบ = จับได้ก่อนลูกค้าจับได้
//
// กติกา (SPEC ข้อ 5):
// - synchronous lock: รอบก่อนยังไม่จบ = ข้ามรอบนี้ ไม่ยิงซ้อน — release ใน finally เสมอ
// - probe หนึ่งรอบมีเพดานเวลา AbortSignal.timeout(timeoutMs) — ค้าง = นับเป็น fail
// - alert = log line เสมอ + POST webhook ถ้าตั้ง CANARY_ALERT_WEBHOOK_URL
//   (alert พังห้ามทำให้ canary พังตาม)
import { createLock } from "./locks.mjs";

const CANARY_ID = "line-webhook";
const ALERT_TIMEOUT_MS = 10_000;

export function createCanary({
  db,
  probeFn = null,
  intervalMs = 0,
  timeoutMs = 30_000,
  alertWebhookUrl = "",
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = Date.now,
  logger = console,
}) {
  const lock = createLock();
  let timer = null;

  // ยิง alert: log เสมอ + webhook แบบ best-effort (มี timeout ของตัวเอง)
  async function alert(status, detail) {
    logger.error?.(`[canary] ALERT status=${status} detail=${detail}`);
    if (!alertWebhookUrl) return;
    try {
      await fetchImpl(alertWebhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "ai-front-line-chassis",
          canary: CANARY_ID,
          status,
          detail,
          at: new Date(now()).toISOString(),
        }),
        signal: AbortSignal.timeout(ALERT_TIMEOUT_MS),
      });
    } catch (err) {
      logger.error?.(`[canary] alert webhook ล้มเหลว (${err?.message || err})`);
    }
  }

  // ครอบ probe ด้วยเพดานเวลา — ส่ง AbortSignal.timeout ให้ probeFn ใช้ตัด fetch ภายใน
  // และ race กับ timer ปกติ (ref'd) เพราะ timer ภายใน AbortSignal.timeout เป็น unref
  // — ถ้า probe ค้างและ event loop ว่าง signal จะไม่มีวันยิง (เจอจริงในเทสต์)
  function probeWithTimeout() {
    const signal = AbortSignal.timeout(timeoutMs);
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`probe เกิน ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([
      Promise.resolve().then(() => probeFn(signal)),
      deadline,
    ]).finally(() => clearTimeout(timer));
  }

  async function runProbe() {
    // lock แบบ synchronous — รอบก่อนยังไม่จบ = ข้ามรอบนี้ ไม่ยิงซ้อน
    if (!lock.tryAcquire()) {
      return { skipped: true, reason: "probe_in_flight" };
    }
    try {
      const probeAt = now();
      if (!probeFn) {
        db.setCanary(CANARY_ID, { status: "not_armed", detail: "ยังไม่ arm probe (ตั้ง CANARY_INTERVAL_MS)", lastProbeAt: probeAt });
        return { armed: false };
      }
      db.setCanary(CANARY_ID, { status: "probing", lastProbeAt: probeAt });

      let ok = false;
      let errorDetail = null;
      try {
        ok = (await probeWithTimeout()) === true;
      } catch (err) {
        errorDetail = String(err?.message || err);
      }
      const roundTripMs = now() - probeAt;

      if (ok) {
        db.setCanary(CANARY_ID, {
          status: "ok", detail: "", lastProbeAt: probeAt, lastOkAt: now(), roundTripMs,
        });
        return { armed: true, ok: true, roundTripMs };
      }

      const status = errorDetail ? "error" : "failed";
      const detail = errorDetail ?? "probe ไม่ได้ reply — ต้องปลุกคน";
      db.setCanary(CANARY_ID, { status, detail, lastProbeAt: probeAt, roundTripMs });
      await alert(status, detail);
      return { armed: true, ok: false, roundTripMs, ...(errorDetail ? { error: true } : {}) };
    } catch (err) {
      // ชั้นกันตาย: DB เขียนไม่ได้ ฯลฯ — ห้ามทำ interval ตายเงียบ
      logger.error?.(`canary: probe พัง (${err?.message || err})`);
      try {
        db.setCanary(CANARY_ID, { status: "error", detail: String(err?.message || err), lastProbeAt: now() });
      } catch { /* DB พังจริง — log ไว้แล้วพอ */ }
      return { armed: true, ok: false, error: true };
    } finally {
      lock.release(); // ปล่อย lock เสมอ ไม่ว่าจะจบทางไหน
    }
  }

  // เริ่มยิงเป็นรอบ ๆ — เปิดเฉพาะเมื่อ armed + intervalMs > 0
  function start() {
    if (timer || !probeFn || intervalMs <= 0) return false;
    timer = setInterval(() => {
      runProbe().catch((err) => logger.error?.(`canary: ${err?.message || err}`));
    }, intervalMs);
    timer.unref?.(); // ไม่ค้ำ process ตอน shutdown
    logger.log?.(`[canary] เริ่มยิงทุก ${intervalMs}ms (timeout ${timeoutMs}ms)`);
    return true;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function status() {
    return db.getCanary(CANARY_ID);
  }

  return {
    runProbe, start, stop, status,
    get busy() { return lock.held; },
    get running() { return timer !== null; },
  };
}
