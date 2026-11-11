// ป้าย "สรุปจาก LINE OA" — กติกาตัดสินสีป้าย (src/lineOaContext.mjs)
//
// ป้ายนี้เป็นสิ่งเดียวที่บอกชมพู่ว่า "เรื่องที่ไปคุยในแอป LINE OA ยังไม่ได้พากลับเข้าระบบ"
// ถ้ากติกาพลาดฝั่งเขียว = ห้องที่ AI ไม่มี context จะดูเหมือนเรียบร้อย ซึ่งอันตรายกว่า
// ป้ายส้มเกินจริง เทสต์ชุดนี้จึงเน้นด้าน "ห้ามเขียวผิด" เป็นหลัก
import { test } from "node:test";
import assert from "node:assert/strict";
import { isHumanNoteAuthor, lineOaContextState, NON_HUMAN_NOTE_AUTHORS, NON_HUMAN_NOTE_AUTHORS_SQL, RECENT_WINDOW_MS } from "../src/lineOaContext.mjs";

const HOUR = 3_600_000;
const T0 = 1_700_000_000_000;
// ตรึงเวลา "ตอนนี้" ไว้ 2 วันหลังเหตุการณ์ — ทุกเคสจึงอยู่ในหน้าต่าง 30 วันเสมอ
const NOW = T0 + 2 * 24 * HOUR;

// ห้องมาตรฐาน: ติดป้าย customer ตอน T0 ลูกค้าทักตอน T0+1ชม. ยังไม่มีใครสรุปกลับ
const pendingRoom = (extra = {}) => ({
  ai_enabled: 0,
  customer_tag_at: T0,
  last_inbound_at: T0 + HOUR,
  last_human_note_at: null,
  last_operator_outbound_at: null,
  ...extra,
});

test("ห้องที่ AI ยังทำงานอยู่ ไม่ติดป้าย — ลูกแพรตอบในคอนโซล บทสนทนาครบเอง", () => {
  assert.equal(lineOaContextState({
    ai_enabled: 1, customer_tag_at: null,
    last_inbound_at: T0 + HOUR, last_human_note_at: null, last_operator_outbound_at: null,
  }, NOW), null);
});

test("ห้องที่คนดูแลเองและยังไม่มีใครสรุปกลับ = ส้ม", () => {
  const state = lineOaContextState(pendingRoom(), NOW);
  assert.equal(state.synced, false);
  assert.equal(state.reason, "pending");
  assert.equal(state.contextAt, null);
});

test("ป้าย customer ทำให้ติดป้ายได้แม้ ai_enabled ยังเป็น 1", () => {
  // ป้าย customer = บอทเงียบถาวร (pipeline.mjs) — สวิตช์ในคอนโซลอาจยังไม่ถูกปิดตาม
  const state = lineOaContextState(pendingRoom({ ai_enabled: 1 }), NOW);
  assert.equal(state?.synced, false);
});

test("โน้ตส่งต่อที่คนเขียนหลังข้อความล่าสุด = เขียว", () => {
  const state = lineOaContextState(pendingRoom({ last_human_note_at: T0 + 2 * HOUR }), NOW);
  assert.equal(state.synced, true);
  assert.equal(state.reason, "note");
  assert.equal(state.contextAt, T0 + 2 * HOUR);
});

test("แอดมินตอบในคอนโซลหลังข้อความล่าสุด = เขียว (กันป้ายส้มขึ้นทุกครั้งที่ตอบตามปกติ)", () => {
  const state = lineOaContextState(pendingRoom({ last_operator_outbound_at: T0 + 2 * HOUR }), NOW);
  assert.equal(state.synced, true);
  assert.equal(state.reason, "console_reply");
});

test("โน้ตชนะเมื่อผ่านเกณฑ์ทั้งคู่ — เป็นหลักฐานที่ตั้งใจเล่าเรื่อง", () => {
  const state = lineOaContextState(pendingRoom({
    last_human_note_at: T0 + 2 * HOUR,
    last_operator_outbound_at: T0 + 3 * HOUR,
  }), NOW);
  assert.equal(state.reason, "note");
  assert.equal(state.contextAt, T0 + 3 * HOUR);
});

test("โน้ตเก่ากว่าข้อความล่าสุด = ส้ม (นี่คือเคสหลักของบั๊กแบบเงียบ)", () => {
  // ชมพู่สรุปไว้เมื่อวาน ลูกค้าทักใหม่วันนี้ — context เก่าใช้ไม่ได้กับเรื่องใหม่
  const state = lineOaContextState(pendingRoom({ last_human_note_at: T0 - HOUR }), NOW);
  assert.equal(state.synced, false);
  assert.equal(state.reason, "pending");
});

test("โน้ตตรงเวลาข้อความล่าสุดพอดี = เขียว (>= ไม่ใช่ >)", () => {
  const state = lineOaContextState(pendingRoom({ last_human_note_at: T0 + HOUR }), NOW);
  assert.equal(state.synced, true);
});

test("ห้องที่เงียบเกิน 30 วัน = ไม่ติดป้าย (กันป้ายรกห้องเก่าหลายร้อยห้อง)", () => {
  const stale = T0 - RECENT_WINDOW_MS - HOUR;
  assert.equal(lineOaContextState(pendingRoom({ customer_tag_at: stale - HOUR, last_inbound_at: stale }), T0), null);
});

test("ป้ายติดทีหลังข้อความล่าสุด ต้องยังติดป้ายอยู่ (บทเรียนจากข้อมูลจริง 2026-08-26)", () => {
  // เคยใช้เวลาติดป้ายเป็นจุดยึด แล้วซ่อนไป 584 ห้องเพราะป้ายถูกติดรวดเดียวหลังคุยจบ
  const state = lineOaContextState(pendingRoom({ customer_tag_at: T0 + 90 * 60_000 }), NOW);
  assert.notEqual(state, null, "ห้ามซ่อนเพียงเพราะป้ายติดทีหลัง");
  assert.equal(state.synced, false);
});

test("ห้องที่ยังไม่เคยมีข้อความเข้า = ไม่ติดป้าย", () => {
  assert.equal(lineOaContextState(pendingRoom({ last_inbound_at: null }), NOW), null);
});

test("row ว่าง/undefined ไม่ล้ม", () => {
  assert.equal(lineOaContextState(null, NOW), null);
  assert.equal(lineOaContextState(undefined, NOW), null);
});

test("โน้ตที่โค้ดเขียนเอง ไม่ทำให้เขียว — ทั้ง ai_auto, ย้ายข้อมูล และโยงระบบเก่า", () => {
  assert.equal(isHumanNoteAuthor("ai_auto"), false);
  assert.equal(isHumanNoteAuthor("system"), false);
  assert.equal(isHumanNoteAuthor(""), false);
  assert.equal(isHumanNoteAuthor("   "), false);
  assert.equal(isHumanNoteAuthor(null), false);
  // ของจริงบน production 2026-08-26: 6,412 ใบจาก import + 34 ใบจาก legacyLink
  // ถ้านับเป็นคน ห้องเกือบทั้งฐานจะเขียวทั้งที่ไม่มีใครสรุปอะไรเลย
  assert.equal(isHumanNoteAuthor("LINE OA (ย้ายข้อมูล)"), false);
  assert.equal(isHumanNoteAuthor("ระบบ (โยงระบบเก่าด้วยชื่อ)"), false);
  // ai_promise = ใบสั่งงานที่บอทเขียนเองตอนรับปากลูกค้า — คำพูดของบอทไม่ใช่การสรุปของคน
  assert.equal(isHumanNoteAuthor("ai_promise"), false);
  assert.equal(isHumanNoteAuthor("chomphu"), true);
  assert.equal(isHumanNoteAuthor("pilot-owner"), true);
});

test("โน้ตจากตอนย้ายข้อมูลต้องไม่ทำให้ห้องเป็นเขียว", () => {
  // จำลองห้องที่มีแต่โน้ต import (ถูกกรองที่ SQL จึงมาเป็น null) — ต้องยังส้ม
  const state = lineOaContextState(pendingRoom({ last_human_note_at: null }), NOW);
  assert.equal(state.synced, false);
});

test("รายชื่อผู้เขียนที่ไม่ใช่คน ประกอบเป็น SQL ได้ตรงกับฝั่ง JS", () => {
  // db.mjs แปะสตริงนี้ลง SQL ตรง ๆ — ถ้าเพี้ยน คอลัมน์ last_human_note_at จะนับผิด
  assert.equal(
    NON_HUMAN_NOTE_AUTHORS_SQL,
    "'ai_auto', 'system', '', 'LINE OA (ย้ายข้อมูล)', 'ระบบ (โยงระบบเก่าด้วยชื่อ)', 'ai_promise', 'ระบบ (เชื่อมช่องทาง)'",
  );
  // ทุกชื่อในลิสต์ต้องถูก isHumanNoteAuthor ปฏิเสธด้วย — สองทางต้องตรงกันเสมอ
  for (const author of NON_HUMAN_NOTE_AUTHORS) {
    assert.equal(isHumanNoteAuthor(author), false, `${author} ต้องไม่ถูกนับเป็นคน`);
  }
});
