// ป้าย "สรุปจาก LINE OA" — ชั้น SQL
//
// เทสต์ line-oa-context.test.mjs คุมกติกาตัดสินสี ส่วนไฟล์นี้คุมสิ่งที่พังเงียบกว่า:
// ชื่อคอลัมน์ที่ listConversations ต้องส่งออกมา ถ้าพิมพ์ผิดสักตัว lineOaContextState
// จะได้ undefined แล้วคืน null ทุกห้อง = ป้ายไม่ขึ้นเลย โดยไม่มี error ให้เห็น
import test from "node:test";
import assert from "node:assert/strict";
import { openDb } from "../src/db.mjs";
import { lineOaContextState } from "../src/lineOaContext.mjs";

const HOUR = 3_600_000;
// ทุกเคสตรึง "ตอนนี้" ไว้ใกล้เหตุการณ์ ให้อยู่ในหน้าต่าง 30 วันเสมอ
const NOW = 1_700_000_000_000 + 5 * 24 * HOUR;

function fixture(t) {
  let clock = 1_700_000_000_000;
  const db = openDb({ file: ":memory:", now: () => clock });
  t.after(() => db.close?.());
  return {
    db,
    at: (ms) => { clock = ms; },
    now: () => clock,
    rowFor(customerId) {
      return db.listConversations({ limit: 50 })
        .find((row) => row.line_user_id === customerId);
    },
  };
}

test("listConversations ส่งคอลัมน์ครบสามตัวที่ป้ายต้องใช้", (t) => {
  const f = fixture(t);
  f.db.upsertCustomer("U-plain", { displayName: "ลูกค้าใหม่" });
  f.db.insertMessage({ customerId: "U-plain", direction: "in", content: "สวัสดีค่ะ" });

  const row = f.rowFor("U-plain");
  assert.ok(row, "ต้องเจอห้องใน listConversations");
  // มีคอลัมน์จริง (ค่าอาจเป็น null ได้ แต่ต้องไม่ undefined = สะกดชื่อผิด)
  for (const column of ["customer_tag_at", "last_human_note_at", "last_operator_outbound_at"]) {
    assert.notEqual(row[column], undefined, `ขาดคอลัมน์ ${column}`);
  }
  assert.equal(row.customer_tag_at, null);
  assert.equal(row.last_human_note_at, null);
  assert.equal(row.last_operator_outbound_at, null);
});

test("ห้อง AI เปิดปกติ = ไม่ติดป้าย · ติดป้าย customer แล้วลูกค้าทัก = ส้ม", (t) => {
  const f = fixture(t);
  f.db.upsertCustomer("U-tag", { displayName: "ลูกค้าเก่า" });

  f.at(1_700_000_000_000);
  f.db.insertMessage({ customerId: "U-tag", direction: "in", content: "ทักครั้งแรก" });
  assert.equal(lineOaContextState(f.rowFor("U-tag"), NOW), null, "AI ยังเปิด = ไม่ติดป้าย");

  f.at(1_700_000_000_000 + HOUR);
  f.db.addTag("U-tag", "customer");
  assert.equal(
    lineOaContextState(f.rowFor("U-tag"), NOW)?.synced, false,
    "ติดป้ายทีหลังข้อความล่าสุด ต้องยังติดป้าย — เวลาติดป้ายไม่ใช่จุดยึดอีกแล้ว",
  );

  f.at(1_700_000_000_000 + 2 * HOUR);
  f.db.insertMessage({ customerId: "U-tag", direction: "in", content: "ทักใหม่หลังส่งต่อ" });
  const pending = lineOaContextState(f.rowFor("U-tag"), NOW);
  assert.equal(pending?.synced, false, "ลูกค้าทักหลังส่งต่อแล้วไม่มีใครสรุป = ส้ม");
});

test("โน้ตของคนทำให้เขียว · โน้ต ai_auto ไม่ทำ", (t) => {
  const f = fixture(t);
  const base = 1_700_000_000_000;
  f.db.upsertCustomer("U-note");
  f.at(base);
  f.db.addTag("U-note", "customer");
  f.at(base + HOUR);
  f.db.insertMessage({ customerId: "U-note", direction: "in", content: "ขอสอบถามค่ะ" });

  f.at(base + 2 * HOUR);
  f.db.addHandoffNote({ customerId: "U-note", author: "ai_auto", text: "สรุปอัตโนมัติ" });
  assert.equal(
    lineOaContextState(f.rowFor("U-note"), NOW)?.synced, false,
    "โน้ตของ ai_auto ต้องถูกคัดออกที่ชั้น SQL",
  );
  assert.equal(f.rowFor("U-note").last_human_note_at, null);

  f.at(base + 3 * HOUR);
  f.db.addHandoffNote({ customerId: "U-note", author: "chomphu", text: "คุยใน LINE OA แล้ว ลูกค้าขอเลื่อนรอบ" });
  const synced = lineOaContextState(f.rowFor("U-note"), NOW);
  assert.equal(synced?.synced, true);
  assert.equal(synced?.reason, "note");
});

test("ข้อความขาออกของลูกแพรไม่ทำให้เขียว — ต้องเป็นของคนกดส่งเท่านั้น", (t) => {
  const f = fixture(t);
  const base = 1_700_000_000_000;
  f.db.upsertCustomer("U-out");
  f.at(base);
  f.db.addTag("U-out", "customer");
  f.at(base + HOUR);
  f.db.insertMessage({ customerId: "U-out", direction: "in", content: "สนใจคอร์สค่ะ" });

  f.at(base + 2 * HOUR);
  f.db.insertMessage({ customerId: "U-out", direction: "out", content: "ตอบอัตโนมัติ", operator: "" });
  assert.equal(f.rowFor("U-out").last_operator_outbound_at, null, "operator ว่าง = ไม่ใช่คน");
  f.db.insertMessage({ customerId: "U-out", direction: "out", content: "ระบบส่ง", operator: "system" });
  assert.equal(f.rowFor("U-out").last_operator_outbound_at, null, "operator=system = ไม่ใช่คน");
  assert.equal(lineOaContextState(f.rowFor("U-out"), NOW)?.synced, false);

  f.at(base + 3 * HOUR);
  f.db.insertMessage({ customerId: "U-out", direction: "out", content: "สวัสดีค่ะ เดี๋ยวส่งรายละเอียดให้นะคะ", operator: "chomphu" });
  const synced = lineOaContextState(f.rowFor("U-out"), NOW);
  assert.equal(synced?.synced, true);
  assert.equal(synced?.reason, "console_reply");
});

test("ปิด AI โดยไม่ติดป้าย customer ก็ติดป้ายได้ (ห้องที่คนรับช่วงชั่วคราว)", (t) => {
  const f = fixture(t);
  const base = 1_700_000_000_000;
  f.db.upsertCustomer("U-aioff");
  f.at(base);
  f.db.insertMessage({ customerId: "U-aioff", direction: "in", content: "ขอคุยกับคนค่ะ" });
  f.db.setAiEnabled("U-aioff", false, { reason: "manual" });

  const state = lineOaContextState(f.rowFor("U-aioff"), NOW);
  assert.equal(state?.synced, false);
  assert.equal(f.rowFor("U-aioff").customer_tag_at, null, "ไม่ได้ติดป้าย customer");
});

test("โน้ตปักหมุดเยอะ ต้องไม่ดันโน้ตใหม่หลุดจนป้ายค้างส้ม", (t) => {
  // listHandoffNotes เรียง pinned ก่อนแล้วตัดที่ LIMIT — ถ้าหัวห้องถอดเวลาโน้ตล่าสุด
  // จาก list นั้น ห้องที่ปักหมุดไว้เยอะจะไม่มีวันเขียว ทั้งที่ชมพู่สรุปแล้ว
  const f = fixture(t);
  const base = 1_700_000_000_000;
  f.db.upsertCustomer("U-pin");
  f.at(base);
  f.db.addTag("U-pin", "customer");
  for (let i = 0; i < 55; i += 1) {
    f.at(base - (100 - i) * 60_000);
    const note = f.db.addHandoffNote({ customerId: "U-pin", author: "chomphu", text: `โน้ตเก่า ${i}` });
    f.db.setHandoffNotePinned(note.id, true);
  }
  f.at(base + HOUR);
  f.db.insertMessage({ customerId: "U-pin", direction: "in", content: "ทักใหม่" });
  f.at(base + 2 * HOUR);
  f.db.addHandoffNote({ customerId: "U-pin", author: "chomphu", text: "สรุปล่าสุดจาก LINE OA" });

  // โน้ตใหม่หลุดออกจาก list ที่หัวห้องแสดงจริง แต่ต้องไม่หลุดจากการตัดสินป้าย
  const listed = f.db.listHandoffNotes("U-pin", 50);
  assert.ok(!listed.some((note) => note.text === "สรุปล่าสุดจาก LINE OA"),
    "ตั้งฉากให้ตรงกับเคสจริง: โน้ตใหม่ต้องหลุดจาก list ที่ถูกตัด");
  assert.equal(f.db.lastHumanHandoffNoteAt("U-pin"), base + 2 * HOUR);
  assert.equal(lineOaContextState(f.rowFor("U-pin"), NOW)?.synced, true, "ต้องเขียว");
});


test("โน้ตจากตอนย้ายข้อมูลถูกกรองที่ชั้น SQL — ห้องต้องไม่เขียวหลอก", (t) => {
  // ของจริง 2026-08-26: handoff_notes มี 6,412 ใบจาก author นี้ เขียนรวดเดียวตอน import
  // ถ้าหลุดเข้ามานับเป็นคน ห้องเกือบทั้งฐานจะเขียวทั้งที่ไม่มีใครสรุปอะไรเลย
  const f = fixture(t);
  const base = 1_700_000_000_000;
  f.db.upsertCustomer("U-mig");
  f.at(base);
  f.db.addTag("U-mig", "customer");
  f.at(base + HOUR);
  f.db.insertMessage({ customerId: "U-mig", direction: "in", content: "ทักมา" });

  f.at(base + 2 * HOUR);
  f.db.addHandoffNote({ customerId: "U-mig", author: "LINE OA (ย้ายข้อมูล)", text: "สรุปตอนย้าย" });
  f.db.addHandoffNote({ customerId: "U-mig", author: "ระบบ (โยงระบบเก่าด้วยชื่อ)", text: "โยงห้อง" });
  assert.equal(f.rowFor("U-mig").last_human_note_at, null, "ทั้งสอง author ต้องถูกกรองที่ SQL");
  assert.equal(lineOaContextState(f.rowFor("U-mig"), NOW)?.synced, false, "ต้องยังส้ม");

  f.at(base + 3 * HOUR);
  f.db.addHandoffNote({ customerId: "U-mig", author: "chomphu", text: "คุยใน LINE OA มาแล้ว" });
  assert.equal(lineOaContextState(f.rowFor("U-mig"), NOW)?.synced, true, "คนเขียนจริงถึงจะเขียว");
});

test("ห้องที่เงียบเกินหน้าต่างเวลา ไม่ติดป้าย แม้จะยังไม่มีใครสรุป", (t) => {
  const f = fixture(t);
  const base = 1_700_000_000_000;
  f.db.upsertCustomer("U-old");
  f.at(base);
  f.db.addTag("U-old", "customer");
  f.at(base + HOUR);
  f.db.insertMessage({ customerId: "U-old", direction: "in", content: "ทักไว้นานแล้ว" });

  const muchLater = base + HOUR + 60 * 24 * HOUR;
  assert.equal(lineOaContextState(f.rowFor("U-old"), muchLater), null, "60 วันผ่านไป = เงียบ");
  assert.equal(lineOaContextState(f.rowFor("U-old"), base + 2 * HOUR)?.synced, false, "แต่ตอนนั้นติดป้าย");
});
