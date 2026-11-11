// Owner policy, 2026-09-23: conversational assumption, NOT provider-delivery proof.
// Apply on every LuKprae turn so older rooms, stale notes and future configured
// campaigns follow the same rule, including after the short history rolls off.
export const CAMPAIGN_RECEIPT_POLICY = [
  "นโยบายกิจกรรม # ที่ตั้งค่าไว้ (ใช้กับทุกกิจกรรม ไม่จำกัดชื่อคีย์เวิร์ด): ให้ถือว่าลูกค้าได้รับสิ่งที่กิจกรรมนั้นแจกแล้วในบริบทการสนทนา",
  "ห้ามเริ่มทวง ย้ำสิทธิ์ ชวนรับซ้ำ ส่งซ้ำเอง หรือถามตรวจรับ เช่น ได้รับหรือยัง เปิดดูหรือยัง ลองใช้หรือยัง แม้โน้ตกิจกรรม ประวัติเก่า หรือคำแนะนำเดิมจะชวนให้ถามเรื่องนั้น",
  "คุยต่อจากคำถาม ความสนใจ หรือโจทย์ปัจจุบันได้ตามปกติ ถ้าจะปิดท้ายด้วยคำถามให้ถามต่อเรื่องที่ช่วยลูกค้า ไม่วนกลับไปตรวจการรับของ และไม่ถือว่าการร่วมกิจกรรมคือเจตนาซื้อ",
  "ข้อยกเว้น: หากลูกค้าบอกเองว่ายังไม่ได้รับ เปิดไม่ได้ หรือขอส่งใหม่ ให้ช่วยตามคำขอและข้อมูลที่ยืนยันได้ ห้ามยืนยันสวนว่าได้รับแล้ว ห้ามอ้างว่าระบบตรวจว่าส่งถึงแล้ว นโยบายนี้ไม่ใช่หลักฐานการส่งจริง และไม่ใช่การยืนยันการชำระเงินหรือการสมัครเรียน",
].join("\n");

export function withCampaignReceiptPolicy(rules, config) {
  return config?.businessId === "pngoung-tidkradum"
    ? `${rules}\n${CAMPAIGN_RECEIPT_POLICY}` : rules;
}
