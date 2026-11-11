// roundsWatch.mjs — เตือนทีมงานทาง LINE เมื่อตารางรอบเรียนใกล้หมด
//
// เหตุจริง 2026-08-19: ปฏิทินมี 13 รอบถึงสิ้นปี แต่ระบบรู้แค่ 3 รอบ ค้างมา 4 วัน
// ลูกค้าถามรอบเดือนถัดไป ลูกแพรตอบว่า "ยังไม่ประกาศ" ทั้งที่รับจองได้ = เสียโอกาสขาย
// เงียบ ๆ โดยไม่มีใครรู้ และที่รู้ในที่สุดก็เพราะเจ้าของบังเอิญทัก ไม่ใช่เพราะระบบจับได้
//
// รอบแรกเคยแก้ด้วยการ "เตือนลงล็อกไฟล์" ซึ่งไม่ได้แก้ปัญหาเลย — ย้ายที่ซ่อนปัญหาเฉย ๆ
// เพราะปัญหาคือ "ไม่มีใครรู้" ไม่ใช่ "ไม่มีที่บันทึก" การเตือนจึงต้องไปถึงคนจริง
//
// เกาะรอบ retention รายวัน (แบบเดียวกับตัวเฝ้าดีลร้อนค้าง) — ไม่สร้าง timer ใหม่
// เพราะ timer ที่ไม่มีรอบแรกตอนบูตเคยทำให้งานทั้งชุด "ไม่เคยรันเลย" มาแล้ว

import { upcomingRounds as listRounds } from "./classRounds.mjs";

export const ROUNDS_WARN_KEY = "rounds_warn_last_at";
export const ROUNDS_LOW_THRESHOLD = 3;
export const ROUNDS_HORIZON_DAYS = 45;
// เตือนซ้ำทุก 3 วัน ไม่ใช่ทุกวัน — เตือนทุกวันคือวิธีที่แน่นอนที่สุดที่จะทำให้คนเลิกอ่าน
// แล้วกลายเป็นไม่มีใครรู้เหมือนเดิม แค่เสียงดังกว่า
export const ROUNDS_WARN_COOLDOWN_MS = 3 * 24 * 3_600_000;

export function roundsHealth(rounds = [], todayIso) {
  const bookable = rounds.filter((round) => round.fileStatus !== "full" && round.fileStatus !== "closed");
  const warnings = [];
  if (bookable.length === 0) {
    warnings.push("ไม่มีรอบเรียนที่รับจองได้เลย — ลูกแพรจะตอบทุกคนว่ายังไม่ประกาศ");
  } else if (bookable.length < ROUNDS_LOW_THRESHOLD) {
    warnings.push(`เหลือรอบที่รับจองได้แค่ ${bookable.length} รอบ`);
  }
  const last = bookable.at(-1);
  if (last) {
    const days = Math.round((Date.parse(`${last.date}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86_400_000);
    if (days < ROUNDS_HORIZON_DAYS) warnings.push(`รอบสุดท้ายที่ประกาศคือ ${last.thai} (อีก ${days} วัน)`);
  }
  return { bookable: bookable.length, warnings };
}

export function checkRoundsAndWarn({ config, db, notifier, logger = console, now = Date.now } = {}) {
  if (!config?.classRoundsFile) return { skipped: "no_rounds_file" };
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(now()));
  const rounds = listRounds({ file: config.classRoundsFile, db, todayIso, logger });
  const health = roundsHealth(rounds, todayIso);
  if (!health.warnings.length) return { ok: true, bookable: health.bookable, warned: false };

  let lastAt = 0;
  try {
    lastAt = Number(db.getSetting(ROUNDS_WARN_KEY)) || 0;
  } catch { lastAt = 0; }
  if (now() - lastAt < ROUNDS_WARN_COOLDOWN_MS) {
    return { ok: true, bookable: health.bookable, warned: false, reason: "cooldown" };
  }

  const text = `ตารางรอบเรียนใกล้หมด — ${health.warnings.join(" · ")} `
    + "รบกวนเพิ่มรอบใหม่ในไฟล์รอบเรียนแล้ว sync ให้ลูกแพรด้วยนะคะ";
  logger.warn?.(`[roundsWatch] ${text}`);
  try {
    db.setSetting(ROUNDS_WARN_KEY, String(now()));
    db.addAudit({ operator: "system", action: "rounds_low_warning", target: "ops:rounds", detail: health.warnings.join(" · ") });
  } catch (err) {
    logger.debug?.(`roundsWatch: บันทึกเวลาเตือนไม่สำเร็จ (${err?.message || err})`);
  }
  // force: true เพราะ cooldown ของตัวแจ้งเตือนผูกกับ "ลูกค้า" ส่วนงานนี้เป็นเรื่อง ops
  // ที่ยิงแค่ทุก 3 วันอยู่แล้ว ถ้าปล่อยให้ cooldown ลูกค้ากลืน จะไม่มีรอบสองให้เตือนอีก
  notifier?.fireLater?.({
    customerId: "ops:rounds",
    channelId: "default",
    reason: "rounds_low",
    reasonTextOverride: text,
    force: true,
  });
  return { ok: true, bookable: health.bookable, warned: true, warnings: health.warnings };
}
