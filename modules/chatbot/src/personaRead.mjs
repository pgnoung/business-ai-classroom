// personaRead.mjs — ทำให้ผลอ่านลักษณะลูกค้า (DISC / B.A.N.K.) นิ่ง
//
// ปัญหาที่แก้ (วัดจากข้อมูลจริง 2026-08-28): scorer อ่าน DISC ใหม่ทั้งหมดทุกครั้งที่ให้คะแนน
// โดยไม่เอาผลเดิมมาต่อยอด ผลคือคนคนเดียวกันเปลี่ยนไปมาใน 5 จาก 10 ห้อง เคสที่ชัดที่สุด
// คือเปลี่ยนจาก C เป็น S ภายใน 2 นาที ซึ่งเป็นคนละขั้วของ DISC และบ่อยครั้งที่อ่านได้แล้ว
// รอบถัดไปกลับเป็น unknown = ทิ้งสิ่งที่เพิ่งรู้ไปเฉย ๆ
//
// นิสัยคนไม่เปลี่ยนทุกสองนาที การอ่านค่าใหม่ทั้งหมดทุกเทิร์นจึงรับประกันว่าจะได้สัญญาณรบกวน
//
// กติกา (ต่อฟิลด์ แยกกันระหว่าง disc กับ bank):
//   อ่านไม่ออกรอบนี้      → คงค่าเดิมไว้ ไม่ถอยกลับเป็น unknown
//   ยังไม่เคยมีค่าเดิม     → รับค่าใหม่ทันที
//   ตรงกับค่าเดิม          → คงไว้
//   ต่างจากค่าเดิม         → ยังไม่เปลี่ยน จนกว่าจะอ่านได้ค่าเดิมซ้ำสองรอบติด
//
// เก็บค่าดิบที่โมเดลตอบไว้ด้วยเสมอ (persona_read_raw) เพราะ (ก) ใช้ตัดสินเรื่องอ่านซ้ำสองรอบ
// และ (ข) วันหลังถ้าจะประเมินว่า B.A.N.K. เพิ่มความแม่นจริงไหม ต้องใช้สัญญาณดิบ ไม่ใช่ค่าที่ปรับแล้ว

export const UNKNOWN = "unknown";

const isKnown = (value) => typeof value === "string" && value !== "" && value !== UNKNOWN;

function stabilizeField(previousStable, previousRaw, incomingRaw) {
  if (!isKnown(incomingRaw)) return isKnown(previousStable) ? previousStable : UNKNOWN;
  if (!isKnown(previousStable)) return incomingRaw;
  if (incomingRaw === previousStable) return previousStable;
  // ต่างจากเดิม — ต้องอ่านได้ค่าเดิมซ้ำสองรอบติดก่อนถึงจะเปลี่ยน
  return previousRaw === incomingRaw ? incomingRaw : previousStable;
}

/**
 * รวมผลอ่านรอบใหม่เข้ากับของเดิม
 * @param {{disc?:string,bank?:string,reason?:string}|null} incoming ผลดิบจาก scorer รอบนี้
 * @param {{persona_read?:object, persona_read_raw?:object}|null} previous payload ของรอบก่อน
 */
export function stabilizePersonaRead(incoming, previous) {
  const raw = incoming && typeof incoming === "object" ? incoming : {};
  const prevStable = previous?.persona_read && typeof previous.persona_read === "object" ? previous.persona_read : {};
  const prevRaw = previous?.persona_read_raw && typeof previous.persona_read_raw === "object" ? previous.persona_read_raw : {};

  const disc = stabilizeField(prevStable.disc, prevRaw.disc, raw.disc);
  const bank = stabilizeField(prevStable.bank, prevRaw.bank, raw.bank);
  // เหตุผลใช้ของรอบที่อ่านออกล่าสุด — ถ้ารอบนี้อ่านไม่ออก เหตุผลเดิมยังอธิบายค่าที่คงไว้ได้ตรงกว่า
  const reason = isKnown(raw.disc) || isKnown(raw.bank)
    ? String(raw.reason ?? "")
    : String(prevStable.reason ?? "");

  return {
    stable: { disc, bank, reason },
    raw: { disc: raw.disc ?? UNKNOWN, bank: raw.bank ?? UNKNOWN, reason: String(raw.reason ?? "") },
  };
}

/**
 * ใช้กับ payload ทั้งก้อนตอนกำลังจะบันทึก — คืน payload ใหม่ที่ persona_read นิ่งแล้ว
 * ผู้ใช้ปลายทางทุกตัวอ่าน persona_read เหมือนเดิม ไม่ต้องแก้อะไร
 */
export function applyStablePersonaRead(payload, previousPayload) {
  if (!payload || typeof payload !== "object") return payload;
  const { stable, raw } = stabilizePersonaRead(payload.persona_read, previousPayload);
  // ธุรกิจที่เลิกใช้ DISC (scoring.parseScorePayload discRetired): ห้ามพาค่า DISC เก่าติดต่อมา
  if (payload.disc_retired === true) {
    return { ...payload, persona_read: { ...stable, disc: UNKNOWN }, persona_read_raw: { ...raw, disc: UNKNOWN } };
  }
  return { ...payload, persona_read: stable, persona_read_raw: raw };
}
