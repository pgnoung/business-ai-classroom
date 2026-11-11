// dbTrialInvites.mjs — สิทธิ์ชวนทดลองเรียนฟรีที่ลูกแพรเปิดได้ต่อวัน (พี่ง้วง 12 ต.ค. 2026 · เจนเคาะ: กิมมิกต้องเป็นความจริง)
//
// ลูกค้าที่ "จาง ๆ" ได้คำชวนลองคลาสทดลองเรียนฟรี พร้อมบอกว่าสิทธิ์ที่ลูกแพรเปิดได้แต่ละวันมีจำนวนจำกัด —
// ประโยคนั้นจริงได้ก็ต่อเมื่อระบบนับและหยุดจริง: ตารางนี้นับคำชวนต่อวันเวลาไทย (ทุกห้องรวมกัน) และหนึ่งห้องได้คำชวนครั้งเดียว
//   - reserve  = จองหนึ่งสิทธิ์ของวันนี้ "ก่อน" ร่าง/ส่ง (คำสั่ง SQL เดียว = อะตอมมิก ข้ามโปรเซสได้) — ห้องเดิมจองซ้ำวันเดิม = สิทธิ์เดิม
//                (ไม่นับเพิ่ม) และผู้จองล่าสุดถือสิทธิ์นั้นแทน (holder) — ผู้ถือเดิมคืนสิทธิ์ไม่ได้อีก
//   - sent     = คำชวนพร้อมลิงก์ถึงมือลูกค้าแล้ว → ห้องนี้ไม่ได้คำชวนอีก · จดเสมอแม้การจองหาย/ถูกคนอื่นถือ (upsert) — ส่งแล้วต้องนับ
//   - release  = ร่าง/ส่งไม่สำเร็จ หรือคำตอบที่ส่งจริงไม่มีลิงก์ → คืนสิทธิ์ให้วันนี้ (เฉพาะผู้ถือคนปัจจุบัน — ไม่ลบการจองของคนอื่น)
//   - การจองที่ค้าง (โปรเซสตายก่อนคืน) เลิกนับเองหลัง TRIAL_RESERVATION_TTL_MS — พลาดไปทางนับเกินชั่วคราว (ชวนน้อยลง) ไม่ใช่ชวนเกินเพดาน
// ผู้ตรวจ 12 ต.ค.: เดิมทักตามที่ถูกลูกค้าพิมพ์แทรกคืนสิทธิ์ (DELETE ทั้งแถว) ทั้งที่เทิร์นตอบแชทจองแถวเดียวกันอยู่และส่งคำชวนออกไปแล้ว
//   → แถวหาย ยอดวันนั้นเป็น 0 และห้องนั้นถูกชวนซ้ำได้ — จึงมี holder และ sent แบบ upsert
// PDPA: ลบลูกค้า = เปลี่ยนรหัสห้องเป็นค่าสุ่ม (ไม่เหลือ id) แต่คงแถวไว้นับยอดของวันนั้น — ไม่งั้นการลบทำให้ชวนเกินเพดานของวันได้
// ตารางสร้างตอนจองสิทธิ์ครั้งแรก (ไม่ใช่ตอนเปิดฐาน): ฐานที่ยังไม่เคยชวนใครมีโครงตารางเท่าเดิมทุกตาราง
// — เทสต์ "เหมือนคอมมิต production ทุกไบต์" (blueprint-zero-impact) เทียบทุกตารางในฐาน · อ่าน/คืน/ลบตอนยังไม่มีตาราง = ไม่มีอะไรให้ทำ
export const TRIAL_RESERVATION_TTL_MS = 30 * 60_000;

export const TRIAL_INVITES_SCHEMA = `
-- trial_invites — คำชวนทดลองเรียนฟรีที่ลูกแพรเปิดให้ลูกค้า (หนึ่งแถวต่อห้อง · นับต่อวันเวลาไทย · src/dbTrialInvites.mjs)
CREATE TABLE IF NOT EXISTS trial_invites (
  customer_id TEXT PRIMARY KEY,
  day         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'sent')),
  holder      TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trial_invites_day ON trial_invites(day, status);
`;

export function createTrialInviteDbMethods({ db, run, get }) {
  let ready = false;
  const exists = () => ready || (ready = Boolean(get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'trial_invites'")));
  const ensure = () => { if (!exists()) { db.exec(TRIAL_INVITES_SCHEMA); ready = true; } };
  const liveCount = (day, atMs) => (exists() ? Number(get(
    `SELECT COUNT(*) AS n FROM trial_invites WHERE day = ? AND (status = 'sent' OR updated_at >= ?)`,
    String(day), Number(atMs) - TRIAL_RESERVATION_TTL_MS,
  )?.n || 0) : 0);
  return {
    trialInviteRow(customerId) {
      return exists() ? get("SELECT * FROM trial_invites WHERE customer_id = ?", String(customerId)) ?? null : null;
    },
    /** คำชวนของวันนั้นที่ยังนับอยู่ (ส่งแล้ว + จองที่ยังไม่หมดอายุ) */
    trialInvitesCounted(day, atMs) {
      return liveCount(day, atMs);
    },
    /**
     * ห้องนี้เคยได้ข้อความที่มีลิงก์นี้แล้วหรือยัง (ข้อความขาออกทุก session — รวมลิงก์ที่ส่งตอนลูกค้าขอเอง/ทีมงานพิมพ์/เครื่องเดิม)
     * ผู้ตรวจ 12 ต.ค.: ลูกค้าที่ได้ลิงก์ทดลองเรียนไปแล้วถูกชวนซ้ำด้วยลิงก์เดิมพร้อมประโยค "วันนี้ลูกแพรขอฝากไว้ให้ก่อน"
     */
    roomReceivedText(customerId, needle) {
      const value = String(needle || "");
      if (!value) return false;
      return Boolean(get(
        "SELECT 1 AS ok FROM messages WHERE customer_id = ? AND direction = 'out' AND instr(content, ?) > 0 LIMIT 1",
        String(customerId), value,
      ));
    },
    /**
     * จองหนึ่งสิทธิ์ของวัน — { ok, reason } · reason: reserved | already_reserved | already_invited | cap_reached
     * เช็คเพดานกับเขียนแถวอยู่ในคำสั่งเดียว (SQLite ล็อกทั้งฐานตอนเขียน) จึงไม่มีสองห้องได้สิทธิ์สุดท้ายพร้อมกัน
     * holder = ผู้ถือการจองนี้ (หนึ่งค่าต่อด่าน) — ห้องเดิมจองซ้ำ = สิทธิ์เดิม แต่ผู้ถือเปลี่ยนเป็นผู้จองล่าสุด
     */
    reserveTrialInvite({ customerId, day, cap, atMs, holder = "" }) {
      const id = String(customerId);
      const owner = String(holder || "");
      const limit = Math.max(0, Math.trunc(Number(cap) || 0));
      const existing = this.trialInviteRow(id);
      if (existing?.status === "sent") return { ok: false, reason: "already_invited" };
      if (existing?.status === "reserved" && existing.day === String(day)
        && Number(existing.updated_at) >= Number(atMs) - TRIAL_RESERVATION_TTL_MS) {
        run("UPDATE trial_invites SET updated_at = ?, holder = ? WHERE customer_id = ? AND status = 'reserved'", Number(atMs), owner, id);
        return { ok: true, reason: "already_reserved" };
      }
      if (limit <= 0) return { ok: false, reason: "cap_reached" };
      ensure();
      const result = run(
        `INSERT INTO trial_invites (customer_id, day, status, holder, created_at, updated_at)
         SELECT ?, ?, 'reserved', ?, ?, ?
         WHERE (SELECT COUNT(*) FROM trial_invites
                 WHERE day = ? AND customer_id <> ? AND (status = 'sent' OR updated_at >= ?)) < ?
         ON CONFLICT(customer_id) DO UPDATE SET day = excluded.day, status = 'reserved', holder = excluded.holder,
           updated_at = excluded.updated_at
           WHERE trial_invites.status = 'reserved'`,
        id, String(day), owner, Number(atMs), Number(atMs),
        String(day), id, Number(atMs) - TRIAL_RESERVATION_TTL_MS, limit,
      );
      return Number(result.changes) === 1 ? { ok: true, reason: "reserved" } : { ok: false, reason: "cap_reached" };
    },
    /**
     * คำชวนถึงมือลูกค้าแล้ว — จดเสมอ (upsert): การจองยังอยู่ = เปลี่ยนเป็นส่งแล้ว (นับในวันที่จอง) · การจองหาย/หมดอายุ = เพิ่มแถวส่งแล้วของวัน day
     * คืน true เมื่อแถวของห้องนี้เป็น "ส่งแล้ว" จริงหลังคำสั่ง
     */
    markTrialInviteSent({ customerId, day, atMs }) {
      ensure();
      run(
        `INSERT INTO trial_invites (customer_id, day, status, holder, created_at, updated_at)
         VALUES (?, ?, 'sent', '', ?, ?)
         ON CONFLICT(customer_id) DO UPDATE SET status = 'sent', updated_at = excluded.updated_at
           WHERE trial_invites.status = 'reserved'`,
        String(customerId), String(day), Number(atMs), Number(atMs),
      );
      return this.trialInviteRow(customerId)?.status === "sent";
    },
    /** คืนสิทธิ์ที่จองไว้แต่ไม่ได้ส่ง — เฉพาะเมื่อผู้ถือคนปัจจุบันคือ holder (แถวที่ส่งแล้ว/คนอื่นถือ ไม่ถูกแตะ) */
    releaseTrialInvite({ customerId, holder = "" }) {
      if (!exists()) return false;
      const result = run("DELETE FROM trial_invites WHERE customer_id = ? AND status = 'reserved' AND holder = ?",
        String(customerId), String(holder || ""));
      return Number(result.changes) === 1;
    },
    /** PDPA/รีเซ็ตห้อง: ไม่เหลือ id ของลูกค้า แต่คงยอดของวันนั้นไว้ (ยอดของวันต้องไม่ลดเพราะการลบ) */
    anonymizeTrialInvite(customerId, token) {
      if (!exists()) return;
      run("UPDATE trial_invites SET customer_id = ? WHERE customer_id = ?", `forgotten:${token}`, String(customerId));
    },
  };
}
