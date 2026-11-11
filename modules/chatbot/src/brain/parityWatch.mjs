// brain/parityWatch.mjs — นาฬิกาของด่านเฟส 1a: "สมองเงาตรงกับตารางจริงมากี่วันติดแล้ว"
//
// ด่านคือ diff = 0 ติดกันหลายคืน แต่วันนี้ตรวจได้แค่บรรทัดเดียวตอนบูต (เห็นตอน deploy) กับ
// tools/brain-parity.mjs ที่ต้องมีคนพิมพ์เอง — ไม่มีใครนับให้ และไม่มีใครรู้ถ้ามันเพี้ยนตอนตีสาม
// ตัวนี้จึงเดินเองตาม BRAIN_PARITY_TICK_MS (default 6 ชม.) แบบแผนเดียวกับ retention/needsHumanSla:
// setInterval + unref + lock ปล่อยใน finally · ล้มเหลวทุกชนิด log แล้วจบในตัว ห้ามโยนถึงเส้นทางแชท ·
// อ่านอย่างเดียวทั้งหมด ยกเว้น settings สองตัวที่เป็นตัวนับของมันเอง (ไม่แตะ prompt/guard/การ์ด)
// ตัวนับต้องอยู่ใน DB ไม่ใช่แรม (บทเรียนเดียวกับ needsHumanSla): ทุก deploy จะรีเซ็ตของที่อยู่ในแรม
// แล้ว "ตรง N วันติด" จะไม่มีวันโตพอจะผ่านด่านได้เลย
import { createLock } from "../locks.mjs";
import { brainParityReport } from "./parity.mjs";

export const BRAIN_PARITY_LAST_KEY = "brain_parity_last";
export const BRAIN_PARITY_STREAK_KEY = "brain_parity_streak";
export const BRAIN_PARITY_DEFAULT_TICK_MS = 6 * 3_600_000;
// ยังไม่ได้นำเข้าสมอง = ไม่ใช่ความผิดพลาด ห้ามปลุกใคร (parity.mjs คืน ok:true อยู่แล้ว)
export const BRAIN_PARITY_QUIET_REASONS = Object.freeze(["no_brain_version", "brain_tables_unavailable"]);
const QUIET = new Set(BRAIN_PARITY_QUIET_REASONS);
// timer 6 ชม. ที่ไม่มีรอบแรกบนเครื่องที่รีสตาร์ทบ่อย = งานที่ไม่เคยรันเลย (เกิดกับ retention มาแล้ว)
const BOOT_DELAY_MS = 3 * 60_000;

const todayInBangkok = (atMs) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(atMs));

// ค่าพัง/อ่านไม่ได้ = null (เริ่มนับใหม่ ดีกว่าปล่อยตัวนับค้างเพราะอ่านไม่ออก)
function readJsonSetting(db, key) {
  try {
    const parsed = JSON.parse(String(db.getSetting(key) ?? "null"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch { return null; }
}

/** ลายเซ็นของอาการ — เปลี่ยนก็ต่อเมื่อ "ส่วนที่ต่าง" เปลี่ยน ไม่ใช่ทุกรอบที่ยังไม่ตรง */
export function parityDriftSignature(record) {
  if (!record || record.ok !== false) return "";
  return `${record.reason}|${[...(record.mismatches ?? [])].sort().join(",")}`;
}

/** ข้อความถึงทีม — บอกชื่อ "ส่วนที่ต่าง" เท่านั้น ห้ามมีเนื้อความรู้หรือข้อมูลลูกค้า */
export function parityDriftText(record) {
  const parts = (record?.mismatches ?? []).join(" · ") || record?.reason || "ไม่ทราบสาเหตุ";
  return `สมองเงาไม่ตรงกับตารางที่ระบบใช้จริง (เวอร์ชัน ${record?.version || "—"}) — ส่วนที่ต่าง: ${parts}`
    + " · ยังไม่กระทบลูกค้าเพราะสมองยังเป็นเงา แต่ตัวนับ 'ตรงกี่วันติด' ถูกรีเซ็ตแล้ว"
    + " รบกวนตรวจก่อนเปิดให้สมองอ่านจริงนะคะ";
}

// ตรง = +1 วันละครั้ง (ไม่ใช่ทุก tick) · ไม่ตรง = ล้มกระดาน เพราะด่านคือ "ติดกัน" ไม่ใช่
// "รวมกี่วัน" · ยังไม่มีเวอร์ชันสมอง = ไม่นับและไม่ล้าง (ไม่มีอะไรให้พิสูจน์)
export function nextParityStreak(stored, { ok, hasVersion, todayIso }) {
  const days = Math.max(0, Math.trunc(Number(stored?.days) || 0));
  const lastDay = stored?.lastDay ?? null;
  if (!ok) return { days: 0, lastDay: null };
  if (!hasVersion || lastDay === todayIso) return { days, lastDay };
  return { days: days + 1, lastDay: todayIso };
}

// brainRuntime (P2): ผลตรวจแต่ละรอบต้องไหลกลับไปที่ทางอ่านสมอง — ตัวเฝ้าคือตัวเดียว
// ที่รู้ว่า "สมองที่กำลังเสิร์ฟ" เริ่มไม่ตรงกับตารางจริง และ runtime คือตัวเดียวที่หยุดเสิร์ฟได้
export function createBrainParityWatch({ db, config = {}, notifier = null, logger = console, now = Date.now, brainRuntime = null } = {}) {
  const lock = createLock();
  const tickMs = Math.max(0, Number(config.brainParityTickMs) || 0);
  let timer = null;
  let bootTimer = null;

  function runOnce() {
    if (!lock.tryAcquire()) return { skipped: "run_in_flight" };
    try {
      if (config.brainShadowParity !== true) return { skipped: "disabled" }; // เช็คสดทุกรอบ
      const at = typeof now === "function" ? Number(now()) : Number(now);
      const todayIso = todayInBangkok(at);
      // ตัวเดียว/พารามิเตอร์ชุดเดียวกับบรรทัดตอนบูต ไม่งั้นสองที่จะพูดคนละเรื่องเรื่องรอบเรียน
      const report = brainParityReport(db, { todayIso, classRoundsFile: config.classRoundsFile });
      const record = {
        at, ok: report.ok === true, reason: report.reason, version: report.versionId ?? null,
        mismatches: (report.mismatches ?? []).map((m) => m.part), // ชื่อส่วนพอ ไม่ต้องเก็บ sha
      };
      const previous = readJsonSetting(db, BRAIN_PARITY_LAST_KEY);
      const streak = nextParityStreak(readJsonSetting(db, BRAIN_PARITY_STREAK_KEY), {
        ok: record.ok, hasVersion: Boolean(record.version), todayIso,
      });
      try {
        db.setSetting(BRAIN_PARITY_LAST_KEY, JSON.stringify(record));
        db.setSetting(BRAIN_PARITY_STREAK_KEY, JSON.stringify(streak));
      } catch (err) { logger.debug?.(`brainParity: บันทึกผลไม่สำเร็จ (${err?.message || err})`); }
      // ส่งผลให้ทางอ่านสมองก่อนตัดสินใจแจ้ง — ไม่ตรง = หยุดเสิร์ฟสมองทันทีในรอบนี้เลย
      try { brainRuntime?.noteParity?.(record); } catch (err) {
        logger.debug?.(`brainParity: ส่งผลให้ brainRuntime ไม่สำเร็จ (${err?.message || err})`);
      }
      const drift = !record.ok && !QUIET.has(record.reason);
      let notified = false;
      const signature = parityDriftSignature(record);
      // ยิงครั้งเดียวต่อ "อาการหนึ่งแบบ" — ยิงทุกรอบคือวิธีที่แน่นอนที่สุดที่จะทำให้ทีมปิดเสียงทิ้ง
      if (drift && signature && signature !== parityDriftSignature(previous)) {
        const text = parityDriftText(record);
        logger.warn?.(`[brainParity] ${text}`);
        // ops: = เรื่องระบบ ไม่ผูกกับลูกค้า (notify.mjs ตัดลิงก์ห้องแชททิ้งเอง)
        // force: cooldown ของ notify ผูกกับลูกค้า งานนี้เป็น ops ที่กันซ้ำด้วยลายเซ็นแล้ว
        notifier?.fireLater?.({
          customerId: "ops:brain", channelId: "default", reason: "brain_parity_drift",
          reasonTextOverride: text, force: true,
        });
        notified = true;
        try {
          const detail = record.mismatches.join(" · ") || record.reason;
          db.addAudit({ operator: "system", action: "brain_parity_drift", target: "ops:brain", detail });
        } catch { /* audit ล้มไม่กระทบผลที่บันทึกไว้แล้ว */ }
      }
      return { ...record, streakDays: streak.days, drift, notified };
    } catch (err) {
      logger.error?.(`brainParity: ${err?.message || err}`);
      return { skipped: "error" };
    } finally {
      lock.release(); // ปล่อย lock เสมอ ไม่ว่าจะจบทางไหน
    }
  }

  function start() {
    if (timer || config.brainShadowParity !== true || !(tickMs > 0)) return false;
    bootTimer = setTimeout(() => {
      const last = Number(readJsonSetting(db, BRAIN_PARITY_LAST_KEY)?.at) || 0;
      if (!last || Date.now() - last >= tickMs) runOnce(); // รีสตาร์ทถี่ ๆ ไม่ต้องตรวจซ้ำ
    }, BOOT_DELAY_MS);
    bootTimer.unref?.();
    timer = setInterval(runOnce, tickMs);
    timer.unref?.(); // ไม่ค้ำ process ตอน shutdown
    logger.log?.(`[brainParity] เฝ้าสมองเงาทุก ${tickMs}ms + รอบแรกใน ${BOOT_DELAY_MS}ms`);
    return true;
  }

  function stop() {
    if (bootTimer) clearTimeout(bootTimer);
    if (timer) clearInterval(timer);
    bootTimer = timer = null;
  }

  /** สรุปสำหรับ /health และสรุปรายวัน — อ่านจากสิ่งที่บันทึกไว้ ไม่ตรวจใหม่ */
  function snapshot() {
    const off = config.brainShadowParity !== true;
    const last = off ? null : readJsonSetting(db, BRAIN_PARITY_LAST_KEY);
    const days = off ? 0 : Math.max(0, Math.trunc(Number(readJsonSetting(db, BRAIN_PARITY_STREAK_KEY)?.days) || 0));
    return {
      // "none" = ยังไม่มีอะไรให้พิสูจน์ (ปิดอยู่ / ยังไม่เคยตรวจ / ยังไม่มีเวอร์ชันสมอง)
      parity: !last ? "none" : (last.ok === true ? (last.version ? "ok" : "none") : "drift"),
      streakDays: days,
      lastAt: last ? (Number(last.at) || null) : null,
      version: last?.version ?? null,
      mismatches: Array.isArray(last?.mismatches) ? last.mismatches : [],
    };
  }

  return {
    runOnce, start, stop, snapshot,
    get busy() { return lock.held; },
    get running() { return timer !== null; },
  };
}
