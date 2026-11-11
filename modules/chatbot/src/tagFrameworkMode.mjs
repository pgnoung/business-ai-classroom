// tagFrameworkMode.mjs — สวิตช์ "ป้ายลูกค้าชุดเดียว" ในหน้าตั้งค่า (28 ก.ย. 2026)
//
// ไฟล์กรอบเดินทางมากับ release (instance/tag-framework.json ชี้ด้วย TAG_FRAMEWORK_FILE ของตัวห่อ phase7)
// จึงไม่ต้องแก้ไฟล์ env บนเซิร์ฟเวอร์ — ส่วนการเปิด/ปิดอยู่ที่แถว settings นี้ อ่านสดทุกครั้งที่ใช้:
//   ไม่มีแถว = เปิด (พี่ง้วงอนุมัติกรอบแล้ว) · "off" = พฤติกรรมเดิมทุกตัวอักษร (scorer ติดป้ายอิสระ, RFM แบบเดิม,
//   คอนโซลรับป้ายอะไรก็ได้) · อ่านพัง = ปิด (ทางที่พิสูจน์แล้ว)
// ป้ายที่ถูกแปลงไปแล้วไม่ถูกย้อนเมื่อปิด — เป็นแค่ชื่อชุดใหม่ ไม่กระทบการตอบแชท
export const TAG_FRAMEWORK_MODE_KEY = "tag_framework_mode";
export const TAG_FRAMEWORK_MODES = Object.freeze(["on", "off"]);

export function tagFrameworkMode(db) {
  try {
    const raw = String(db?.getSetting?.(TAG_FRAMEWORK_MODE_KEY) ?? "").trim().toLowerCase();
    return raw === "off" ? "off" : "on";
  } catch {
    return "off";
  }
}

/** กรอบที่ใช้จริงตอนนี้ — ไม่มีไฟล์กรอบ หรือสวิตช์ปิด = null (ทุกเส้นทางกลับไปแบบเดิม) */
export function activeTagFramework(db, framework) {
  return framework && tagFrameworkMode(db) === "on" ? framework : null;
}
