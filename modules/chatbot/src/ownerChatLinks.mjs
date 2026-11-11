// ownerChatLinks.mjs — ลิงก์เปิดห้องในคอนโซลท้ายคำตอบของลูกแพร (28 ก.ย. 2026 บ่าย)
//
// พี่ง้วงขอ "ลิ้งค์ไวๆ" — ห้องไหนที่ลูกแพรเอ่ยถึงในคำตอบ แตะแล้วเข้าห้องแชทในคอนโซลได้ทันที
// ระบบแนบเองหลังคำตอบ (โมเดลไม่เคยเห็น/พิมพ์ id หรือ URL — กันลิงก์มั่ว/รหัสลูกค้าหลุดเข้าข้อความ):
//   ห้องที่อยู่ในบริบทของข้อความนี้ (ข้อมูลสด · ห้องที่เอ่ยถึง · ผลค้น) → ชื่อปิดบัง ("สมช***") ตัวไหนโผล่ในคำตอบ
//   = แนบลิงก์ห้องนั้น (ชื่อปิดบังซ้ำกันหลายห้อง = แนบทุกห้อง พร้อมช่องทางให้แยกออก)
// ลิงก์ไม่ถูกเก็บในความจำแชท (owner_chat_turns) — ในลิงก์มีรหัสลูกค้า ความจำต้องไม่มีรหัสใคร
// ไม่มี CONSOLE_PUBLIC_BASE_URL = ไม่มีลิงก์ (roomLink คืนค่าว่าง)
import { roomLink } from "./telegramReplies.mjs";

export const ROOM_LINKS_MAX = 5;

/** รวมห้องจากทุกแหล่งของข้อความนี้เป็นรายการเดียว (ไม่ซ้ำ id) */
export function collectRooms(...sources) {
  const seen = new Map();
  for (const list of sources) {
    for (const room of Array.isArray(list) ? list : []) {
      const id = String(room?.id || "");
      const mask = String(room?.mask || "");
      if (!id || !mask || seen.has(id)) continue;
      seen.set(id, { id, mask, channel: String(room.channel || "LINE") });
    }
  }
  return [...seen.values()];
}

/** บรรทัดลิงก์ของห้องที่ชื่อปิดบังโผล่ในคำตอบ — ไม่มีห้องไหนโผล่/ไม่มีฐาน URL = [] */
export function roomLinkLines(reply, rooms, config, { max = ROOM_LINKS_MAX } = {}) {
  const text = String(reply || "");
  const lines = [];
  for (const room of Array.isArray(rooms) ? rooms : []) {
    // "ลูกค้า***" = ชื่อสำรองของห้องที่ไม่มีชื่อ — คำทั่วไปเกินไปที่จะผูกกับห้องใดห้องหนึ่ง
    if (room.mask.startsWith("ลูกค้า") || !text.includes(room.mask)) continue;
    const link = roomLink(config, room.id);
    if (!link) continue;
    lines.push(`${link.replace(/^🔗\s*/u, `🔗 ${room.mask} (${room.channel}) `)}`);
    if (lines.length >= max) break;
  }
  return lines;
}
