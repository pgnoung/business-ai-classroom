// roundsSource.mjs — อ่าน "รอบในอนาคต" จากแหล่งเดียวกับเส้นตอบลูกค้า (28 ก.ย. 2026)
// มีสมอง = projection ของ bundle (seatRuleLinesFor) · ไม่มี = upcomingRounds (ตั้งค่าในคอนโซล > ไฟล์)
// ตัดรอบด้วยวันนี้เวลาไทยเสมอ — คลังความรู้อาจยังโชว์รอบที่ผ่านไปแล้วว่าเปิดรับ (เจอจริงคืน 28 ก.ย.)
// แยกจาก openRounds.mjs เพราะไฟล์นั้นถูก import โดยตัวจับข้อความ (ต้องไม่ลาก DB/สมองติดไปด้วย)
import { upcomingRounds } from "./classRounds.mjs";
import { upcomingRoundsFor } from "./brain/compile.mjs";

/** ไม่มี CLASS_ROUNDS_FILE / อ่านพัง = [] (ห้ามเดาวันที่) */
export function currentUpcomingRounds({ db, config, bundle = null, todayIso = "", logger = null } = {}) {
  if (!config?.classRoundsFile || !todayIso) return [];
  try {
    return bundle
      ? upcomingRoundsFor(db, bundle, todayIso)
      : upcomingRounds({ file: config.classRoundsFile, db, todayIso, logger });
  } catch (err) {
    logger?.warn?.(`roundsSource: อ่านรอบเรียนล่าสุดไม่สำเร็จ (${err?.message || err}) — ไม่ระบุวันที่`);
    return [];
  }
}
