// ownerChatModel.mjs — โมเดลของ "คุยกับลูกแพร" ทาง Telegram (คำสั่งพี่ง้วง 28 ก.ย. 2026 บ่าย)
//
// "ลองปรับ telegram เป็น luna ได้ไหม" — แชทเจ้าของเลือกโมเดลเองแยกจากเส้นตอบลูกค้าทุกเส้น:
//   luna = gpt-5.6-luna ผ่าน hermes.draftWithModel (ตรวจกับรายการโมเดลรวม HERMES_ALLOWED_MODELS
//          ไม่ใช่ allowlist ของบทบาทตอบลูกค้า ซึ่งบน production มีแค่ sol)
//   sol  = ทางเดิมทุกไบต์ (hermes.draftReply บทบาท reply — โมเดลเดียวกับที่ตอบลูกค้า)
// สวิตช์ settings.owner_chat_model: ไม่มีแถว = luna (คำสั่งเจ้าของ) · "sol" = ทางเดิม
// · ค่าอื่น/อ่านพัง = sol (ทางที่พิสูจน์แล้วบน production — เหมือนสวิตช์อื่นที่อ่านพังแล้วกลับไปพฤติกรรมเดิม)
// · ระบบไม่อนุญาต luna (รายการโมเดลรวมไม่มี) = sol เช่นกัน
//
// งบของ luna (เกตเวย์: reasoning_effort ได้แค่ low/medium/high · max_completion_tokens ≤ 10,000):
//   effort "low" — เกตเวย์เขียนไว้ว่า luna "reasoning เบา" ตัวเลขทุกตัวคำนวณมาให้แล้วในข้อมูลสด/ผลค้น
//   งานของโมเดลคือเล่า ไม่ใช่คิดเลข จึงไม่ต้องคิดนาน ตอบไวกว่า
//   4,000 โทเคน — พอสำหรับคิด (low ใช้หลักร้อย) + คำตอบยาวสุดที่เราเจอ (แคปชั่น/สคริปต์ ~1,500)
//   ยกสองเมื่อยกแรกล้มแบบ retry ได้: 8,000 (ยังต่ำกว่าเพดานเกตเวย์)
export const OWNER_CHAT_MODEL_KEY = "owner_chat_model";
export const OWNER_CHAT_MODEL_MODES = Object.freeze(["luna", "sol"]);
export const OWNER_CHAT_LUNA_MODEL = "gpt-5.6-luna";
export const OWNER_CHAT_LUNA_EFFORT = "low";
export const OWNER_CHAT_LUNA_MAX_TOKENS = 4_000;
export const OWNER_CHAT_LUNA_RETRY_MAX_TOKENS = 8_000;

/** ไม่มีแถว = luna · "sol" = sol · ค่าอื่น/อ่านพัง = sol */
export function ownerChatModelMode(db) {
  try {
    const raw = db?.getSetting?.(OWNER_CHAT_MODEL_KEY);
    if (raw == null || String(raw).trim() === "") return "luna";
    const value = String(raw).trim().toLowerCase();
    return value === "luna" ? "luna" : "sol";
  } catch {
    return "sol";
  }
}

/**
 * แผนการเรียกโมเดลของข้อความนี้
 * @returns {{mode: "luna", model: string, reasoningEffort: string, maxCompletionTokens: number, retryMaxCompletionTokens: number}
 *   | {mode: "sol", reason?: string}}
 */
export function ownerChatModelPlan({ db, config = {} } = {}) {
  if (ownerChatModelMode(db) !== "luna") return { mode: "sol" };
  // OWNER_CHAT_MODEL (white-label) — ไม่ตั้ง = OWNER_CHAT_LUNA_MODEL เดิมทุกตัวอักษร
  const lunaModel = String(config.ownerChatModel || "").trim() || OWNER_CHAT_LUNA_MODEL;
  const allowed = Array.isArray(config.hermesAllowedModels) ? config.hermesAllowedModels : [];
  if (allowed.length && !allowed.includes(lunaModel)) return { mode: "sol", reason: "luna_not_allowed" };
  return {
    mode: "luna",
    model: lunaModel,
    reasoningEffort: OWNER_CHAT_LUNA_EFFORT,
    maxCompletionTokens: OWNER_CHAT_LUNA_MAX_TOKENS,
    retryMaxCompletionTokens: OWNER_CHAT_LUNA_RETRY_MAX_TOKENS,
  };
}
