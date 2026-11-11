// telegramStore.mjs — ที่เก็บของช่อง "Telegram สั่งงานลูกแพร" ใน DB settings (2026-09-28)
//
// ไม่มีตารางใหม่ ไม่มี env ใหม่: โทเคนกรอกจากคอนโซลเท่านั้น (แบบเดียวกับโทเคน Facebook)
// อ่านสดทุกครั้ง — เปลี่ยน/ลบโทเคนในคอนโซลมีผลรอบถัดไปของตัวรับข้อความโดยไม่ต้อง restart
//
// การจับคู่เจ้าของ: คอนโซลออกรหัสใช้ครั้งเดียว อายุ 15 นาที เก็บเฉพาะ hash (sha256) ของรหัส
// ส่งผิดเกิน 5 ครั้ง = ทิ้งรหัสทันที · จับคู่สำเร็จ = ลบรหัส (ใช้ซ้ำไม่ได้)
// ชื่อคีย์ตั้งเป็นกลาง (ไม่ลงท้าย token/secret) — ตัวสแกนความลับของ release จับชื่อแบบนั้น
import { createHash, randomInt, timingSafeEqual } from "node:crypto";

export const TG_SETTING_BOT = "telegram_control_bot";
export const TG_SETTING_BOT_NAME = "telegram_control_bot_name";
export const TG_SETTING_OWNER = "telegram_control_owner";
export const TG_SETTING_PAIRING = "telegram_control_pairing";
export const TG_SETTING_OFFSET = "telegram_control_offset";
export const TG_SETTING_STATUS = "telegram_control_status";
export const PAIRING_TTL_MS = 15 * 60_000;
export const MAX_PAIRING_ATTEMPTS = 5;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ไม่มี 0/O/1/I ให้พิมพ์ผิด
const CODE_LENGTH = 10;

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");
export const normalizePairingCode = (value) => String(value || "").toUpperCase().replace(/[^A-Z0-9]/gu, "");

export function createTelegramStore({ db, now = Date.now }) {
  function read(key) {
    try { return String(db.getSetting(key) || ""); } catch { return ""; }
  }
  function readJson(key) {
    try {
      const value = JSON.parse(read(key) || "null");
      return value && typeof value === "object" ? value : null;
    } catch { return null; }
  }
  const write = (key, value) => db.setSetting(key, value == null ? "" : typeof value === "string" ? value : JSON.stringify(value));
  const patchStatus = (patch) => write(TG_SETTING_STATUS, { ...(readJson(TG_SETTING_STATUS) || {}), ...patch });

  return {
    token: () => read(TG_SETTING_BOT),
    botName: () => read(TG_SETTING_BOT_NAME),
    // โทเคนใหม่ = บอทใหม่: offset เดิมใช้ไม่ได้ และการจับคู่เดิมผูกกับบอทเก่า ต้องจับคู่ใหม่
    saveToken(token, botName) {
      write(TG_SETTING_BOT, token);
      write(TG_SETTING_BOT_NAME, botName || "");
      write(TG_SETTING_OFFSET, "");
      write(TG_SETTING_OWNER, "");
      write(TG_SETTING_PAIRING, "");
      write(TG_SETTING_STATUS, "");
    },
    clearAll() {
      for (const key of [TG_SETTING_BOT, TG_SETTING_BOT_NAME, TG_SETTING_OFFSET, TG_SETTING_OWNER, TG_SETTING_PAIRING, TG_SETTING_STATUS]) write(key, "");
    },

    owner() {
      const value = readJson(TG_SETTING_OWNER);
      return value?.userId && value?.chatId ? value : null;
    },
    clearOwner: () => write(TG_SETTING_OWNER, ""),

    pairing() {
      const value = readJson(TG_SETTING_PAIRING);
      if (!value?.codeHash) return null;
      if (Number(value.expiresAt) <= now()) return null;
      return value;
    },
    createPairing(createdBy) {
      const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
      const expiresAt = now() + PAIRING_TTL_MS;
      write(TG_SETTING_PAIRING, { codeHash: sha256(code), expiresAt, createdBy: String(createdBy || ""), attempts: 0 });
      patchStatus({ pairingLockedAt: 0 });
      return { code, expiresAt };
    },
    // คืน { ok, pairedBy } หรือ { ok:false, reason } — เทียบ hash แบบ timing-safe
    consumePairing(rawCode, { userId, chatId }) {
      const pairing = readJson(TG_SETTING_PAIRING);
      if (!pairing?.codeHash) return { ok: false, reason: "no_pairing" };
      if (Number(pairing.expiresAt) <= now()) {
        write(TG_SETTING_PAIRING, "");
        return { ok: false, reason: "expired" };
      }
      const expected = Buffer.from(String(pairing.codeHash), "hex");
      const candidate = Buffer.from(sha256(normalizePairingCode(rawCode)), "hex");
      if (expected.length !== candidate.length || !timingSafeEqual(expected, candidate)) {
        const attempts = Number(pairing.attempts || 0) + 1;
        const locked = attempts >= MAX_PAIRING_ATTEMPTS;
        write(TG_SETTING_PAIRING, locked ? "" : { ...pairing, attempts });
        // บอทตอบใครไม่ได้ก่อนจับคู่ (แยกเจ้าของกับคนแปลกหน้าไม่ออก) — ทิ้งร่องรอยให้คอนโซลบอกแทน
        // ว่ารหัสถูกยกเลิกเพราะผิดเกินกำหนด ไม่ใช่บอทเสีย (code review 2026-09-28)
        if (locked) patchStatus({ pairingLockedAt: now() });
        return { ok: false, reason: locked ? "locked" : "mismatch" };
      }
      write(TG_SETTING_OWNER, { userId: String(userId), chatId: String(chatId), pairedBy: pairing.createdBy || "", pairedAt: now() });
      write(TG_SETTING_PAIRING, "");
      patchStatus({ pairingLockedAt: 0 });
      return { ok: true, pairedBy: pairing.createdBy || "" };
    },

    offset() {
      const value = Number(read(TG_SETTING_OFFSET));
      return Number.isSafeInteger(value) && value > 0 ? value : 0;
    },
    setOffset: (value) => write(TG_SETTING_OFFSET, String(Math.max(0, Math.trunc(Number(value) || 0)))),

    status: () => readJson(TG_SETTING_STATUS) || {},
    patchStatus,
  };
}
