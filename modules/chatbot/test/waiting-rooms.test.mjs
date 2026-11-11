// waiting-rooms — นิยาม "รอตอบ" ชุดเดียวของคอนโซล (28 ก.ย. 2026)
//
// พี่ง้วงเห็น "ลูกค้ารอคนตอบตอนนี้ 52 ห้อง · นานสุด 29 วัน" แล้วบอกว่าบางห้องจบไปแล้ว — แถวหนึ่งข้อความล่าสุดคือ
// "(thumbs up)(hands together)" (LINE emoji) หลายแถวเป็น "ส่งรูปภาพ · รอ 24 วัน" ฝั่ง Facebook (ปุ่มไลก์ที่ก่อน 5 ก.ย.
// ถูกเก็บเป็นรูป) · เทสต์นี้คุมว่าห้องแบบนั้นหลุดคิว แต่ห้องที่ยังมีเรื่องให้ตอบ (รวม AI ปิด) อยู่ครบ
import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import {
  FB_REPLY_WINDOW_MS, WAITING_LONG_MS, isAckOnlyInbound, listWaitingRooms, stripLineEmoji, summarizeWaiting,
  waitingRoomFor, waitingSignal,
} from "../src/waitingRooms.mjs";
import { AI_OFF_BY_HUMAN_REASONS, NOT_QUALIFIED_WAITING_TEAM_TEXT, aiOffInfo, notQualifiedTeamBlocked } from "../src/aiOffActor.mjs";
import { NOT_QUALIFIED_BY, NOT_QUALIFIED_REASON, NOT_QUALIFIED_REASON_TEXT, qualifyStateKey } from "../src/notQualified.mjs";
import { roomTriage } from "../src/consoleTriageApi.mjs";
import { aiOffReasonText } from "../src/yoloText.mjs";
import { MANUAL_AI_OFF_REASON } from "../src/aiPausePolicy.mjs";
import { SILENT_TAG_REASON } from "../src/pipeline.mjs";
import { LEGACY_AUTO_CUSTOMER_NOTE, SYSTEM_LINK_AUTHOR } from "../src/legacyAutoTag.mjs";
import { memoryDb } from "./helpers.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const FB_LIKE_URL = "https://scontent.xx.fbcdn.net/v/t39.1997-6/39178562_1505197616293642_5411344281094848512_n.png?stp=dst-jpg";
const FB_PHOTO_URL = "https://scontent.xx.fbcdn.net/v/t1.15752-9/461234567_1234_5678_n.jpg?_nc_cat=1";

test("รับทราบล้วน: สติกเกอร์ · LINE emoji · ขอบคุณ/โอเค · อีโมจิ · แฮชแท็ก · ปุ่มไลก์ Messenger ที่ถูกเก็บเป็นรูป", () => {
  // แถวจริงบนภาพหน้าจอของพี่ง้วง 28 ก.ย. — ไม่มี metadata (ข้อความเก่า) ก็ต้องจับได้
  assert.equal(isAckOnlyInbound({ type: "text", text: "(thumbs up)(hands together)" }), true);
  assert.equal(isAckOnlyInbound({
    type: "text", text: "(thumbs up)(hands together)",
    emojis: [{ index: 0, length: 11 }, { index: 11, length: 16 }],
  }), true);
  assert.equal(isAckOnlyInbound({ type: "sticker", text: "[sticker]" }), true);
  for (const text of ["ขอบคุณค่ะ", "ขอบคุณมากค่ะ 🙏", "โอเคค่ะ ขอบคุณค่ะ", "ok ครับ", "ได้ค่ะ", "👍", "🙏🏻❤️", "555", "รับทราบค่ะ", "#สนใจคลาส"]) {
    assert.equal(isAckOnlyInbound({ type: "text", text }), true, `"${text}" ไม่มีเรื่องให้ตอบ`);
  }
  // ปุ่มไลก์ของ Messenger ก่อน 5 ก.ย. ถูกเก็บเป็น "รูป" — ไฟล์มาจาก CDN สติกเกอร์ (path /t39.1997-6/)
  assert.equal(isAckOnlyInbound({ type: "image", url: FB_LIKE_URL }), true);
  assert.equal(isAckOnlyInbound({ type: "image", url: FB_PHOTO_URL }), false, "รูปถ่ายจริง/สลิป = ต้องมีคนเปิดดู");
  assert.equal(isAckOnlyInbound({ type: "image" }), false, "รูปที่ไม่รู้ที่มา = ต้องมีคนเปิดดู");
  for (const type of ["file", "audio", "video", "location"]) assert.equal(isAckOnlyInbound({ type }), false);
  // มีเรื่องให้ตอบ
  for (const text of ["Stage 4", "(Stage 4)", "ขอบคุณค่ะ แล้วรอบหน้าเมื่อไหร่คะ", "สนใจค่ะ (smile)", "โอนแล้วนะคะ", "ok?"]) {
    assert.equal(isAckOnlyInbound({ type: "text", text }), false, `"${text}" ต้องมีคนตอบ`);
  }
});

test("ตัด LINE emoji ตามตำแหน่งใน metadata ก่อน แล้วค่อยตัดชื่อในวงเล็บของข้อความเก่า", () => {
  assert.equal(stripLineEmoji("สวัสดี (hello)", [{ index: 7, length: 7 }]).trim(), "สวัสดี");
  assert.equal(stripLineEmoji("ราคา (moon smile) เท่าไร").replace(/\s+/gu, " ").trim(), "ราคา เท่าไร");
  assert.equal(stripLineEmoji("(Stage 4)"), "(Stage 4)", "ตัวพิมพ์ใหญ่/ตัวเลข = ข้อความที่ลูกค้าพิมพ์เอง");
  assert.equal(stripLineEmoji("x", [{ index: 5, length: 3 }]), "x", "ตำแหน่งเกินข้อความ = ไม่ตัด");
});

test("ห้องที่ยังไม่มีคนตอบหลายข้อความ: มีข้อความที่มีเรื่องอย่างน้อยหนึ่งข้อความ = รอตอบ (ตัวอย่างข้อความคือข้อความนั้น)", () => {
  const json = (items) => JSON.stringify(items);
  const question = waitingSignal({
    last_in_type: "sticker", last_in_text: "[sticker]", unanswered_count: 2,
    unanswered_json: json([{ type: "sticker", text: "[sticker]" }, { type: "text", text: "มีรอบเสาร์ไหมคะ" }]),
  });
  assert.equal(question.waiting, true);
  assert.equal(question.preview.text, "มีรอบเสาร์ไหมคะ", "ตัวอย่างต้องเป็นคำถาม ไม่ใช่สติกเกอร์ที่ส่งตามมา");
  const thanks = waitingSignal({ unanswered_count: 2, unanswered_json: json([{ type: "text", text: "ขอบคุณค่ะ" }, { type: "sticker" }]) });
  assert.equal(thanks.waiting, false);
  // อ่านมา 2 จาก 12 ข้อความที่ยังไม่มีใครตอบ = ไม่ซ่อนลูกค้าเพราะอ่านไม่ครบ
  assert.equal(waitingSignal({ unanswered_count: 12, unanswered_json: json([{ type: "sticker" }, { type: "sticker" }]) }).waiting, true);
  // ผู้เรียกเดิมที่ไม่มีคอลัมน์นี้ (ownerChatSnapshot) = เชื่อ SQL เหมือนเดิม
  assert.equal(waitingSignal({ last_in_type: "text", last_in_text: "ขอบคุณ" }).waiting, true);
});

test("AI ปิดเพราะใคร: ม่วง = คนปิด (manual · ป้าย customer · ป้าย null) · แดง = ระบบ · เทา = ไม่มีบันทึก", () => {
  assert.equal(aiOffInfo({ ai_enabled: 1 }), null);
  for (const reason of ["manual", "customer_handover", "not_a_customer"]) {
    const info = aiOffInfo({ ai_enabled: 0, ai_off_reason: reason });
    assert.equal(info.by, "human", reason);
    assert.equal(info.label, "AI ปิด · โดยคน");
  }
  for (const reason of ["bank_sent", "money_line", "human_requested", "booking_handoff", "complaint", "file_review", "urgent_mental"]) {
    const info = aiOffInfo({ ai_enabled: 0, ai_off_reason: reason });
    assert.equal(info.by, "system", reason);
    assert.equal(info.label, "AI ปิด · โดยระบบ");
    assert.ok(info.reasonText && info.reasonText !== reason, `${reason} ต้องมีคำอธิบายภาษาคน`);
  }
  assert.equal(aiOffInfo({ ai_enabled: 0, ai_off_reason: "customer_handover", ai_off_system_tag: 1 }).by, "system",
    "ป้าย customer ที่ระบบติดเองจากชื่อซ้ำห้องลูกค้าเก่า = ระบบตัดสิน ไม่ใช่คน");
  assert.equal(aiOffInfo({ ai_enabled: 0, ai_off_reason: "" }).by, "unknown");
  for (const reason of ["customer_asked_quiet", "legacy_candidate", "fb_gate_pending", "jev_review_stop"]) {
    assert.doesNotMatch(aiOffInfo({ ai_enabled: 0, ai_off_reason: reason }).reasonText, /^[a-z_]+$/u, `${reason} ต้องไม่ขึ้นรหัสดิบ`);
  }
  // รหัสเหตุของคนต้องตรงกับที่ต้นทางเขียนจริง — เปลี่ยนชื่อที่ต้นทางแล้วลืมที่นี่ = ห้องคนปิดขึ้นแดง
  assert.equal(MANUAL_AI_OFF_REASON, "manual");
  assert.deepEqual([...AI_OFF_BY_HUMAN_REASONS].sort(), ["manual", ...Object.values(SILENT_TAG_REASON)].sort());
});

// 5 ต.ค. 2026 (คำสั่งพี่ง้วง "icon สีเหลือง ประมาณว่า AI off (not qualify)"): ห้องที่ตัวกวาดรายชั่วโมงปิดเอง
// ต้องไม่ขึ้นแดง "โดยระบบ" (= สัญญาณเสี่ยงต้องรีบดู) และไม่ใช่ม่วง (คนไม่ได้ตัดสิน — ตัวกวาดเปิดคืนเองได้)
test("AI ปิดเพราะไม่เข้าเกณฑ์: เหลือง by qualify · ป้าย AI off (not qualify) · เหตุจากคำตัดสินล่าสุดถ้ามี", () => {
  const info = aiOffInfo({ ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON });
  assert.deepEqual(info, {
    by: NOT_QUALIFIED_BY, reason: "not_qualified", label: "AI off (not qualify)", reasonText: NOT_QUALIFIED_REASON_TEXT,
  });
  assert.equal(NOT_QUALIFIED_BY, "qualify");
  assert.ok(!AI_OFF_BY_HUMAN_REASONS.includes(NOT_QUALIFIED_REASON), "ห้ามนับเป็นคนปิด — ตัวกวาดต้องเปิดคืนเองได้");
  // ช่องว่าง/เว้นวรรคหัวท้ายในคอลัมน์ไม่ทำให้หลุดเป็นแดง
  assert.equal(aiOffInfo({ ai_enabled: 0, ai_off_reason: " not_qualified " }).by, "qualify");
  // AI เปิดอยู่ = ไม่มีป้าย (คอลัมน์ค้างจากรอบก่อนไม่นับ)
  assert.equal(aiOffInfo({ ai_enabled: 1, ai_off_reason: NOT_QUALIFIED_REASON }), null);
  // เหตุจากคำตัดสินล่าสุดของตัวกวาด (qualifyStateKey) แทนคำอธิบายกลาง — ยุบช่องว่าง และตัดที่ 120 ตัว
  const reasoned = aiOffInfo({ ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON }, { qualifyReason: "  บอกว่าตกงาน\nหาวิธีหาเงินฟรี  " });
  assert.equal(reasoned.reasonText, "บอกว่าตกงาน หาวิธีหาเงินฟรี");
  assert.equal(reasoned.label, "AI off (not qualify)");
  const long = aiOffInfo({ ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON }, { qualifyReason: "ก".repeat(300) });
  assert.equal(long.reasonText.length, 120);
  assert.ok(long.reasonText.endsWith("…"));
  // อาร์กิวเมนต์ที่สองพัง/ว่าง/เป็นเลขลำดับจาก .map() = คำอธิบายกลาง ไม่ล้ม
  for (const options of [null, undefined, 0, 3, { qualifyReason: 42 }, { qualifyReason: "   " }]) {
    assert.equal(aiOffInfo({ ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON }, options).reasonText, NOT_QUALIFIED_REASON_TEXT);
  }
  assert.deepEqual([{ ai_enabled: 0, ai_off_reason: "manual" }].map(aiOffInfo).map((row) => row.by), ["human"]);
  // เหตุอื่นหน้าตาเดิมทุกตัวอักษร — qualifyReason ใช้กับห้องเหลืองเท่านั้น
  assert.deepEqual(aiOffInfo({ ai_enabled: 0, ai_off_reason: "bank_sent" }, { qualifyReason: "x" }),
    { by: "system", reason: "bank_sent", label: "AI ปิด · โดยระบบ", reasonText: "ส่งเลขบัญชีแล้ว รอทีมดูแลเรื่องเงิน" });
  // Telegram (yoloText) กับคอนโซลพูดเหตุเดียวกัน — ไม่ขึ้นรหัสดิบ
  assert.equal(aiOffReasonText(NOT_QUALIFIED_REASON), NOT_QUALIFIED_REASON_TEXT);
});

// นาฬิกาเลื่อนได้: เขียนประวัติด้วยเวลาในอดีตจริง แล้วอ่านคิวด้วยเวลาปัจจุบัน
function world() {
  let fixed = null;
  const db = memoryDb({ now: () => fixed ?? Date.now() });
  const at = (ms, fn) => { fixed = ms; try { return fn(); } finally { fixed = null; } };
  const now = Date.now();
  const room = (id, { channel = "default", score = null } = {}) => {
    at(now - 40 * DAY, () => db.upsertCustomer(id, { displayName: id, channelId: channel }));
    if (score != null) at(now - 40 * DAY, () => db.recordScore(id, score, "{}"));
  };
  let seq = 0;
  const msg = (id, direction, ago, content, extra = {}) => {
    const messageId = `${direction}:${id}:${seq += 1}`;
    at(now - ago, () => db.insertMessage({ id: messageId, customerId: id, direction, content, ...extra }));
    return messageId;
  };
  return { db, at, now, room, msg };
}

function seedQueue(w) {
  const { db, at, now, room, msg } = w;
  // ---- ไม่ใช่รอตอบ ----
  room("X-line-emoji");
  msg("X-line-emoji", "in", 2 * DAY + HOUR, "สนใจคลาสค่ะ");
  msg("X-line-emoji", "out", 2 * DAY, "ยินดีค่ะ มีรอบ 10 ต.ค.", { agentMode: "ai" });
  msg("X-line-emoji", "in", 2 * DAY - MIN, "(thumbs up)(hands together)", { metadata: { emojis: [{ index: 0, length: 11, productId: "5ac1bfd5040ab15980c9b435", emojiId: "001" }, { index: 11, length: 16, productId: "5ac1bfd5040ab15980c9b435", emojiId: "002" }] } });
  room("X-sticker");
  msg("X-sticker", "in", DAY, "[sticker]", { msgType: "sticker" });
  room("X-thanks");
  msg("X-thanks", "in", 3 * DAY, "ขอบคุณมากค่ะ 🙏");
  room("X-fb-like", { channel: "facebook" });
  const like = msg("X-fb-like", "in", 24 * DAY, "[image]", { msgType: "image" });
  db.addMessageAttachment({ messageId: like, customerId: "X-fb-like", direction: "in", source: "facebook", kind: "image", providerMeta: { contentProvider: "facebook", url: FB_LIKE_URL } });
  room("X-spam");
  msg("X-spam", "in", 5 * DAY, "โปรโมทเพจให้ไหมคะ ราคาถูก");
  db.addTag("X-spam", "NULL", "human");
  room("X-resolved");
  msg("X-resolved", "in", 4 * DAY, "ขอใบเสนอราคาหน่อยค่ะ");
  at(now - 3 * DAY, () => db.setConversationResolved("X-resolved", true));
  room("X-legacy-resolved"); // ปิดเคสก่อนมีคอลัมน์เวลา (resolved_at = 0) = ยังปิดอยู่เหมือนพฤติกรรมเดิม
  msg("X-legacy-resolved", "in", 2 * DAY, "ขอรายละเอียดค่ะ");
  db.raw.prepare("UPDATE customers SET state = 'RESOLVED', resolved_at = 0 WHERE line_user_id = 'X-legacy-resolved'").run();
  room("X-fresh");
  msg("X-fresh", "in", MIN, "สวัสดีค่ะ");
  room("X-answered");
  msg("X-answered", "in", DAY, "ราคาเท่าไหร่คะ");
  msg("X-answered", "out", DAY - MIN, "9,900 บาทค่ะ", { operator: "chompoo", agentMode: "operator_ai_on" });
  // ---- รอตอบ ----
  room("W-money", { score: 6 });
  msg("W-money", "in", 6 * HOUR, "โอนแล้วนะคะ");
  at(now - 6 * HOUR, () => db.setAiEnabled("W-money", false, "bank_sent"));
  room("W-q-sticker", { score: 9 });
  msg("W-q-sticker", "in", 3 * DAY, "มีรอบเสาร์ไหมคะ");
  msg("W-q-sticker", "in", 3 * DAY - MIN, "[sticker]", { msgType: "sticker" });
  room("W-manual");
  msg("W-manual", "in", 2 * HOUR, "Stage 4");
  db.setAiEnabled("W-manual", false, "manual");
  room("W-fb-photo", { channel: "facebook" });
  const photo = msg("W-fb-photo", "in", 2 * DAY, "[image]", { msgType: "image" });
  db.addMessageAttachment({ messageId: photo, customerId: "W-fb-photo", direction: "in", source: "facebook", kind: "image", providerMeta: { contentProvider: "facebook", url: FB_PHOTO_URL } });
  room("W-returned");
  msg("W-returned", "in", 5 * DAY, "ขอบคุณค่ะ");
  at(now - 5 * DAY + HOUR, () => db.setConversationResolved("W-returned", true));
  msg("W-returned", "in", 10 * HOUR, "กลับมาถามอีกรอบค่ะ คลาสออนไลน์มีไหม");
}

test("คิวรอตอบ: ตัดห้องรับทราบล้วน/สแปม/ปิดเคสแล้ว · เก็บห้อง AI ปิดพร้อมเหตุ · ทักกลับหลังปิดเคส = รอตอบอีกครั้ง", () => {
  const w = world();
  seedQueue(w);
  const queue = listWaitingRooms({ db: w.db, now: w.now });
  const ids = queue.rooms.map((room) => room.id);
  assert.deepEqual(ids, ["W-money", "W-q-sticker", "W-fb-photo", "W-returned", "W-manual"],
    "เงินก่อน → ร้อน → ที่เหลือรอนานสุดก่อน");
  assert.equal(queue.total, 5);
  for (const excluded of ["X-line-emoji", "X-sticker", "X-thanks", "X-fb-like", "X-spam", "X-resolved", "X-legacy-resolved", "X-fresh", "X-answered"]) {
    assert.ok(!ids.includes(excluded), `${excluded} ต้องไม่อยู่ในคิวรอตอบ`);
  }
  const byId = new Map(queue.rooms.map((room) => [room.id, room]));
  assert.equal(byId.get("W-q-sticker").preview, "มีรอบเสาร์ไหมคะ", "ตัวอย่างคือเรื่องที่ต้องตอบ ไม่ใช่สติกเกอร์");
  assert.equal(byId.get("W-money").aiOff.by, "system");
  assert.equal(byId.get("W-money").value, "money");
  assert.equal(byId.get("W-manual").aiOff.by, "human");
  assert.equal(byId.get("W-manual").aiOff.label, "AI ปิด · โดยคน");
  assert.equal(byId.get("W-returned").preview, "กลับมาถามอีกรอบค่ะ คลาสออนไลน์มีไหม");
  // Facebook เกิน 24 ชม. = คอนโซลตอบไม่ได้แล้ว
  assert.equal(byId.get("W-fb-photo").fbReplyClosed, true);
  assert.equal(byId.get("W-manual").fbReplyClosed, false, "LINE ไม่มีหน้าต่าง 24 ชม.");
  assert.ok(FB_REPLY_WINDOW_MS === DAY);
  // ค้าง >24 ชม. = เซ็ตย่อยของคิว นับจากทุกห้อง
  assert.equal(queue.over24, queue.rooms.filter((room) => room.waitMs >= WAITING_LONG_MS).length);
  assert.equal(queue.over24, 2, "W-q-sticker 3 วัน + W-fb-photo 2 วัน");
  assert.equal(queue.oldestWaitMs >= 3 * DAY - MIN, true);
});

test("คิวรอตอบ: limit ตัดเฉพาะรายละเอียด — ยอดรวม/ค้างเกินวัน/รอนานสุดนับทุกห้องเสมอ · ห้องเดียวใช้นิยามเดียวกัน", () => {
  const w = world();
  seedQueue(w);
  const all = listWaitingRooms({ db: w.db, now: w.now });
  const two = listWaitingRooms({ db: w.db, now: w.now, limit: 2 });
  assert.equal(two.rooms.length, 2);
  assert.equal(two.total, all.total);
  assert.equal(two.over24, all.over24);
  assert.equal(two.oldestWaitMs, all.oldestWaitMs);
  assert.equal(waitingRoomFor({ db: w.db, customerId: "W-manual", now: w.now })?.id, "W-manual");
  assert.equal(waitingRoomFor({ db: w.db, customerId: "X-line-emoji", now: w.now }), null);
  assert.equal(waitingRoomFor({ db: w.db, customerId: "X-spam", now: w.now }), null);
  // ผลลัพธ์ต้องเป็นฟังก์ชันบริสุทธิ์ของแถว — summarizeWaiting บนแถวชุดเดียวกันได้ลำดับเดียวกัน
  const rows = w.db.attentionWaitingCandidates({ sinceMs: w.now - 30 * DAY, beforeMs: w.now - 3 * MIN });
  assert.deepEqual(summarizeWaiting(rows, { now: w.now, limit: 99 }).rooms.map((room) => room.id), all.rooms.map((room) => room.id));
});

test("ป้าย customer ที่ระบบติดเองจากชื่อซ้ำห้องลูกค้าเก่า = AI ปิด · โดยระบบ (คนติดเอง = โดยคน)", () => {
  const w = world();
  w.room("U-auto");
  w.msg("U-auto", "in", 5 * HOUR, "สนใจคลาสค่ะ");
  w.db.addTag("U-auto", "customer", "human");
  w.db.addHandoffNote({ customerId: "U-auto", author: SYSTEM_LINK_AUTHOR, text: LEGACY_AUTO_CUSTOMER_NOTE });
  w.db.setAiEnabled("U-auto", false, "customer_handover");
  w.room("U-human");
  w.msg("U-human", "in", 5 * HOUR, "สนใจคลาสค่ะ");
  w.db.addTag("U-human", "customer", "human");
  w.db.setAiEnabled("U-human", false, "customer_handover");
  const byId = new Map(listWaitingRooms({ db: w.db, now: w.now }).rooms.map((room) => [room.id, room]));
  assert.equal(byId.get("U-auto").aiOff.by, "system");
  assert.equal(byId.get("U-human").aiOff.by, "human");
  const listed = new Map(w.db.listConversations({ limit: 10 }).map((row) => [row.line_user_id, row]));
  assert.equal(listed.get("U-auto").ai_off_system_tag, 1, "รายการแชทต้องตัดสินแบบเดียวกัน");
  assert.equal(listed.get("U-human").ai_off_system_tag, 0);
});

test("ห้องที่ปิดเคสไว้ก่อนมีคอลัมน์ resolved_at: เปิด DB ใหม่แล้วใช้เวลากดปิดล่าสุดจาก audit", (t) => {
  const file = `${process.env.TMPDIR || "/tmp"}/waiting-backfill-${process.pid}-${Date.now()}.sqlite`;
  t.after(async () => {
    const { rmSync } = await import("node:fs");
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${file}${suffix}`, { force: true });
  });
  const first = openDb({ file });
  first.upsertCustomer("U-old", {});
  first.upsertCustomer("U-noaudit", {});
  first.raw.prepare("UPDATE customers SET state = 'RESOLVED', resolved_at = 0, updated_at = 5000 WHERE line_user_id IN ('U-old', 'U-noaudit')").run();
  first.raw.prepare("INSERT INTO admin_audit (id, operator, action, target, detail, created_at) VALUES ('a1', 'chom', 'conversation_resolved', 'U-old', '', 1000), ('a2', 'chom', 'conversation_resolved', 'U-old', '', 2000)").run();
  first.close();
  const second = openDb({ file });
  assert.equal(second.getCustomer("U-old").resolved_at, 2000, "เวลากดปิดครั้งล่าสุด");
  assert.equal(second.getCustomer("U-noaudit").resolved_at, 5000, "ไม่มีร่องรอย = updated_at (เอนไปทางยังปิดอยู่)");
  second.close();
});

// รีวิวปรปักษ์รอบ 3 5 ต.ค. (f9-stuck-label): ห้องเหลืองที่ทีมตอบหลังเป็นเหลือง / มีคนถือห้อง / เริ่มขั้นจ่ายเงิน / รอคนตรวจ
// ตัวกวาดไม่เปิดเขียวเองและการคืนห้องทั้งหมดก็คงไว้ — คิวรอตอบและหัวห้องเคยบอกทีมว่า "เปิดคืนเองเมื่อเห็นศักยภาพ"
test("คิวรอตอบ + หัวห้อง: ห้องเหลืองที่มีแต่ทีมปลดได้ = ข้อความรอทีม · บรอดแคสต์/ห้องปกติ = ถ้อยคำเดิม", () => {
  const w = world();
  const offAt = w.now - 3 * HOUR;
  const cases = {
    "Y-staff": () => w.msg("Y-staff", "out", 2 * HOUR, "ทีมดูแลต่อนะคะ", { operator: "nok", agentMode: "operator_ai_off" }),
    "Y-owner": () => w.db.raw.prepare("UPDATE customers SET human_owner = 'nok' WHERE line_user_id = 'Y-owner'").run(),
    "Y-money": () => w.db.raw.prepare("UPDATE customers SET deal_status = 'awaiting_payment' WHERE line_user_id = 'Y-money'").run(),
    "Y-needs": () => w.db.raw.prepare("UPDATE customers SET state = 'NEEDS_HUMAN' WHERE line_user_id = 'Y-needs'").run(),
    "Y-broadcast": () => w.msg("Y-broadcast", "out", 2 * HOUR, "โปรเดือนตุลา", { operator: "nok", messageClass: "proactive", agentMode: "operator_ai_on" }),
    "Y-plain": () => {},
  };
  for (const [id, touch] of Object.entries(cases)) {
    w.room(id);
    w.msg(id, "in", 4 * HOUR, "ตกงานค่ะ");
    w.msg(id, "out", 4 * HOUR - MIN, "เข้าใจค่ะ", { agentMode: "ai" });
    w.db.setAiEnabled(id, false, NOT_QUALIFIED_REASON);
    w.db.setSetting(qualifyStateKey(id), JSON.stringify({ verdict: "not_qualified", confidence: 0.9, reason: "ตกงาน", lastInboundId: "x", at: offAt, mode: "on", offAt }));
    touch();
    w.msg(id, "in", HOUR, "ตอนนี้มีร้านกาแฟสองสาขาแล้วค่ะ");
  }
  const byId = new Map(listWaitingRooms({ db: w.db, now: w.now }).rooms.map((room) => [room.id, room]));
  for (const id of ["Y-staff", "Y-owner", "Y-money", "Y-needs"]) {
    assert.equal(notQualifiedTeamBlocked(w.db, w.db.getCustomer(id)), true, id);
    assert.equal(byId.get(id)?.aiOff?.by, NOT_QUALIFIED_BY, `${id}: ยังเป็นป้ายเหลือง`);
    assert.equal(byId.get(id).aiOff.reasonText, NOT_QUALIFIED_WAITING_TEAM_TEXT, `${id}: คิวรอตอบบอกว่ารอทีม`);
    const header = roomTriage({ db: w.db, customer: w.db.getCustomer(id), now: w.now });
    assert.equal(header.aiOff.reasonText, NOT_QUALIFIED_WAITING_TEAM_TEXT, `${id}: หัวห้องบอกว่ารอทีม`);
  }
  for (const id of ["Y-broadcast", "Y-plain"]) {
    assert.equal(notQualifiedTeamBlocked(w.db, w.db.getCustomer(id)), false, id);
    assert.equal(byId.get(id).aiOff.reasonText, NOT_QUALIFIED_REASON_TEXT, `${id}: ตัวกวาดยังเปิดคืนเองได้`);
    assert.equal(roomTriage({ db: w.db, customer: w.db.getCustomer(id), now: w.now }).aiOff.reasonText, "ตกงาน", `${id}: หัวห้องใช้เหตุของคำตัดสิน`);
  }
  // ห้องไม่เหลือง = ไม่อ่านอะไร · อ่านพัง = รอทีม (ด้านปลอดภัย) · summarizeWaiting ไม่มี DB = ถ้อยคำเดิม
  assert.equal(notQualifiedTeamBlocked(w.db, { line_user_id: "Y-plain", ai_enabled: 0, ai_off_reason: "manual" }), false);
  assert.equal(notQualifiedTeamBlocked({ getCustomer() { throw new Error("SQLITE_BUSY"); } }, { line_user_id: "Y-x", ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON }), true);
  const rows = w.db.attentionWaitingCandidates({ customerId: "Y-staff", sinceMs: w.now - 30 * DAY, beforeMs: w.now - 3 * MIN });
  assert.equal(summarizeWaiting(rows, { now: w.now }).rooms[0].aiOff.reasonText, NOT_QUALIFIED_REASON_TEXT);
  assert.equal(aiOffInfo({ ai_enabled: 0, ai_off_reason: "manual" }, { teamBlocked: true }).reasonText, aiOffInfo({ ai_enabled: 0, ai_off_reason: "manual" }).reasonText,
    "teamBlocked ใช้กับห้องเหลืองเท่านั้น");
});
