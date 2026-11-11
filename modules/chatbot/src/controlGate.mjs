// controlGate.mjs — สวิตช์ AI on/off ต่อลูกค้า (บทเรียน Fern ที่พิสูจน์แล้วใน production)
//
// กติกาตายตัว:
// 1. อ่าน ai_enabled สองครั้ง: ก่อนคิด (beforeThink) + ก่อนส่ง (confirmBeforeSend)
//    — กันเคสแอดมิน takeover ระหว่างที่บอทกำลังรอ Hermes/burst
// 2. FALSE เป็น sticky ภายในรอบเดียวกัน: เจอ false ครั้งเดียว = รอบนี้จบ ห้ามส่ง
//    แม้ operator จะเปิดกลับระหว่างทาง
// 3. ปิดแล้วเปิดใหม่ไม่ replay ข้อความเก่า — ข้อความที่ถูก suppress ถูกทิ้ง
//    (log ไว้ใน DB แล้วจากชั้น webhook) ไม่มีคิวค้างรอยิงย้อนหลัง
// 4. control lookup พัง (throw) = AI ไม่ตอบ (fail-closed, SPEC ข้อ 3)

export function createControlGate({ isAiEnabled, logger = console }) {
  function safeRead(customerId) {
    try {
      return isAiEnabled(customerId) === true;
    } catch (err) {
      // อ่านสถานะไม่ได้ = ถือว่าปิด — ห้ามเดาว่าเปิด
      logger.warn?.(`controlGate: อ่าน ai_enabled ไม่ได้ (${err?.message || err}) -> fail closed`);
      return false;
    }
  }

  return {
    // เปิด gate หนึ่งรอบต่อหนึ่ง burst — คืน token ที่จำผล sticky ไว้ในตัว
    open(customerId) {
      let sticky = false;
      const first = safeRead(customerId);
      if (!first) sticky = true;

      return {
        customerId,
        allowedToThink: first,

        // เรียกก่อนยิงข้อความออกเสมอ (อ่านครั้งที่สอง)
        confirmBeforeSend() {
          if (sticky) return false;
          const second = safeRead(customerId);
          if (!second) {
            sticky = true; // เจอ false แล้วห้ามกลับมาเปิดในรอบนี้
            return false;
          }
          return true;
        },
      };
    },
  };
}
