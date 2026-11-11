// G2b pipeline — B1 กันรูปซ้ำ, B2 operator-active pause, B4 known_name จาก scorer,
// B6 บันทึกส่งต่อเข้า prompt + โน้ต ai_auto, B7d agent_mode ฝั่ง AI
// (ทุกอย่าง mock — ห้ามแตะ network จริง)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { parseScorePayload } from "../src/scoring.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, promptText} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const CATALOG = [
  { key: "x5pro", url: "https://img.mock/x5.jpg" },
  { key: "x3", url: "https://img.mock/x3.jpg" },
];

function makeApp({ configOverrides = {}, hermesFetch, lineFetch, imageCatalog = CATALOG } = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  const hermes = hermesFetch ?? hermesFetchStub();
  const line = lineFetch ?? lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermes, lineFetch: line, sleep: async () => {}, imageCatalog },
    logger: silent,
  });
  return { app, db, config, hermesFetch: hermes, lineFetch: line };
}

const imageMessagesIn = (calls) =>
  calls.flatMap((c) => c.body.messages || []).filter((m) => m.type === "image");

/* ------------------------------ B1: image dedupe ---------------------------- */

// v1.2.1 (สเปคเปลี่ยนตามคำสั่งพี่ง้วง — เคสจริงลูกแพร): dedupe กัน "บอทยัดรูปซ้ำเอง"
// เท่านั้น; ลูกค้าขอดูซ้ำ (รวมสำนวน "ขอดูอีกที") = ส่งซ้ำได้เสมอ ห้ามปฏิเสธ
test("B1: ลูกค้าขอดูอีกที -> รูปเดิมส่งซ้ำได้ (dedupe ปลดเมื่อลูกค้าขอเอง)", async () => {
  const hermesFetch = hermesFetchStub("รุ่นนี้ขายดีค่ะ [IMAGE:x5pro] สนใจรุ่นนี้ไหมคะ");
  const { app, db, lineFetch } = makeApp({ hermesFetch });

  const first = await app.pipeline.handleInboundText({ customerId: "U-img", text: "ขอดูรุ่นแนะนำค่ะ", replyToken: "rt1" });
  assert.deepEqual(first.imageKeys, ["x5pro"], "รอบแรกส่งรูปปกติ");
  assert.equal(imageMessagesIn(lineFetch.sends).length, 1);

  const second = await app.pipeline.handleInboundText({ customerId: "U-img", text: "ขอดูอีกทีค่ะ", replyToken: "rt2" });
  assert.equal(second.sent, true);
  assert.deepEqual(second.imageKeys, ["x5pro"], "ขอดูซ้ำ = ส่งรูปเดิมได้ ไม่ใช่ปฏิเสธ");
  assert.equal(imageMessagesIn(lineFetch.sends).length, 2);

  // prompt รอบสองยังต้องบอก model ว่ารูปไหนเคยส่งแล้ว (ไม่ยัดซ้ำเอง แต่ขอแล้วส่งได้)
  const secondSystem = promptText(hermesFetch.calls[1].body.messages[0].content);
  assert.ok(secondSystem.includes("รูปที่เคยส่งให้ลูกค้าแล้ว"), "ต้องบอกรายการ key ที่เคยส่ง");
  assert.ok(secondSystem.includes("x5pro"), "ต้องระบุ key ที่เคยส่ง");
  assert.ok(secondSystem.includes("ห้ามตอบว่าเคยส่งไปแล้ว"), "ต้องห้ามปฏิเสธคำขอดูซ้ำ");
  // รอบแรกยังไม่เคยส่ง — ห้ามมีบรรทัดนี้
  assert.ok(!promptText(hermesFetch.calls[0].body.messages[0].content).includes("รูปที่เคยส่งให้ลูกค้าแล้ว"));
  db.close();
});

test("B1: โมเดลยัดรูปซ้ำเองโดยลูกค้าไม่ได้ขอ -> ยังถูกตัดตามเดิม (กันสแปมรูป)", async () => {
  const hermesFetch = hermesFetchStub("รุ่นนี้เหมาะกับห้องใหญ่ค่ะ [IMAGE:x5pro] มีคำถามเพิ่มไหมคะ");
  const { app, db, lineFetch } = makeApp({ hermesFetch });
  db.insertMessage({
    customerId: "U-img", direction: "out", msgType: "image",
    content: "[image:x5pro] https://img.mock/x5.jpg",
  });

  // ลูกค้าถามเรื่องอื่น (ไม่มีคำขอรูป) — โมเดลใส่ marker ซ้ำเอง = ตัดทิ้ง
  const result = await app.pipeline.handleInboundText({ customerId: "U-img", text: "แล้วเหมาะกับห้องแบบไหนคะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  assert.deepEqual(result.imageKeys, [], "ไม่ได้ขอ = กันรูปซ้ำตามเดิม");
  assert.equal(imageMessagesIn(lineFetch.sends).length, 0);
  db.close();
});

test("B1: ขอรูปชุดใหม่ -> key เก่าที่ลูกค้าขอรวมอยู่ด้วยส่งซ้ำได้ทั้งชุด", async () => {
  const hermesFetch = hermesFetchStub("เทียบสองรุ่นนี้ค่ะ [IMAGE:x5pro] [IMAGE:x3] ชอบแบบไหนคะ");
  const { app, db, lineFetch } = makeApp({ hermesFetch });
  // จำลองว่า x5pro เคยส่งไปแล้วเมื่อวาน
  db.insertMessage({
    customerId: "U-img2", direction: "out", msgType: "image",
    content: "[image:x5pro] https://img.mock/x5.jpg",
  });

  const result = await app.pipeline.handleInboundText({ customerId: "U-img2", text: "ขอรูปเทียบรุ่นค่ะ", replyToken: "rt" });
  assert.deepEqual(result.imageKeys, ["x5pro", "x3"], "ลูกค้าขอรูปเอง = ทั้งชุดส่งได้รวมรูปที่เคยส่ง");
  const images = imageMessagesIn(lineFetch.sends);
  assert.equal(images.length, 2);
  db.close();
});

/* --------------------------- B2: operator-active pause ---------------------- */

test("B2: แอดมินเพิ่งตอบเอง -> AI เงียบ (ไม่มี loading ไม่มี Hermes ไม่มี reply)", async () => {
  const { app, db, lineFetch, hermesFetch } = makeApp();
  db.upsertCustomer("U-op", {});
  db.setOperatorActiveUntil("U-op", Date.now() + 10 * 60_000);

  const result = await app.pipeline.handleInboundText({ customerId: "U-op", text: "สวัสดีค่ะ", replyToken: "" });
  assert.equal(result.suppressed, "operator_active");
  assert.equal(hermesFetch.calls.length, 0);
  assert.equal(lineFetch.calls.length, 0, "ห้ามยิงทั้ง loading และข้อความ");
  db.close();
});

test("B2: หน้าต่างหมดอายุแล้ว -> AI ตอบปกติ", async () => {
  const { app, db } = makeApp();
  db.upsertCustomer("U-op-old", {});
  db.setOperatorActiveUntil("U-op-old", Date.now() - 1000);
  const result = await app.pipeline.handleInboundText({ customerId: "U-op-old", text: "สวัสดีค่ะ", replyToken: "" });
  assert.equal(result.sent, true);
  db.close();
});

test("B2: urgent ยังยิง template 1669 แม้อยู่ในหน้าต่าง operator-active", async () => {
  const { app, db, lineFetch, hermesFetch } = makeApp();
  db.upsertCustomer("U-op-urgent", {});
  db.setOperatorActiveUntil("U-op-urgent", Date.now() + 10 * 60_000);

  const result = await app.pipeline.handleInboundText({
    customerId: "U-op-urgent", text: "แน่นหน้าอกมาก หายใจไม่ออกค่ะ", replyToken: "rt",
  });
  assert.equal(result.sent, true, "เส้นทาง safety deterministic ต้องยังทำงาน");
  assert.equal(result.route, "urgent");
  assert.equal(hermesFetch.calls.length, 0);
  const allText = lineFetch.sends.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(allText.includes("1669"));
  assert.equal(db.getCustomer("U-op-urgent").state, "NEEDS_HUMAN");
  db.close();
});

test("B2: identity template (ไม่ escalate) ถูกพักด้วย — แอดมินตอบเองได้", async () => {
  const { app, db, lineFetch } = makeApp();
  db.upsertCustomer("U-op-id", {});
  db.setOperatorActiveUntil("U-op-id", Date.now() + 10 * 60_000);
  const result = await app.pipeline.handleInboundText({ customerId: "U-op-id", text: "นี่บอทหรือเปล่าคะ", replyToken: "" });
  assert.equal(result.suppressed, "operator_active");
  assert.equal(lineFetch.calls.length, 0);
  db.close();
});

/* ------------------------- B4: known_name จาก scorer ------------------------ */

const scorerJson = (extra = {}) => JSON.stringify({
  score: 7, trend: "up", buying_signals: [],
  persona_read: { disc: "D", bank: "Action", reason: "" },
  next_move: "ชวนปิดการขาย", suggested_question: "สะดวกวันไหนคะ",
  ...extra,
});

test("B4: scorer จับชื่อได้ + ช่องชื่อว่าง -> บันทึก + audit ai_auto (เฉพาะชื่อผู้พิมพ์เอง)", async () => {
  // v1.4.8 (เคสคุณมนตรี): ชื่อผู้รับของ/บุคคลที่สาม ห้ามกลายเป็นชื่อลูกค้า —
  // เดิมเทสต์นี้เข้ารหัสพฤติกรรมผิด (จับ "คุณบี" จากที่อยู่จัดส่ง)
  const third = hermesFetchStub(scorerJson({ known_name: "คุณบี" }));
  const world1 = makeApp({ hermesFetch: third });
  world1.db.upsertCustomer("U-nm", {});
  world1.db.insertMessage({ customerId: "U-nm", direction: "in", content: "ส่งไปให้ คุณบี บ้านเลขที่ 99 นะคะ" });
  await world1.app.pipeline.scoreBurst("U-nm");
  assert.equal(world1.db.getCustomer("U-nm").known_name, "", "ชื่อผู้รับของ = บุคคลที่สาม ห้ามบันทึก");
  world1.db.close();

  const self = hermesFetchStub(scorerJson({ known_name: "บี" }));
  const world2 = makeApp({ hermesFetch: self });
  world2.db.upsertCustomer("U-nm-b", {});
  world2.db.insertMessage({ customerId: "U-nm-b", direction: "in", content: "สวัสดีค่ะ ดิฉันชื่อบีค่ะ สนใจคลาสค่ะ" });
  const payload = await world2.app.pipeline.scoreBurst("U-nm-b");
  assert.equal(payload.known_name, "บี");
  assert.equal(world2.db.getCustomer("U-nm-b").known_name, "บี", "แนะนำตัวเองต้องบันทึกเหมือนเดิม");
  const audit = world2.db.listAudit().find((a) => a.action === "name_auto");
  assert.equal(audit.operator, "ai_auto");
  assert.equal(audit.target, "U-nm-b");
  world2.db.close();
});

test("B4: ชื่อที่คนตั้งไว้แล้วห้ามถูก ai_auto ทับ", async () => {
  const hermesFetch = hermesFetchStub(scorerJson({ known_name: "ชื่อจากบอท" }));
  const { app, db } = makeApp({ hermesFetch });
  db.upsertCustomer("U-nm2", {});
  db.setKnownName("U-nm2", "พี่นก");
  db.insertMessage({ customerId: "U-nm2", direction: "in", content: "สนใจค่ะ" });

  await app.pipeline.scoreBurst("U-nm2");
  assert.equal(db.getCustomer("U-nm2").known_name, "พี่นก", "human edit ชนะเสมอ");
  assert.ok(!db.listAudit().some((a) => a.action === "name_auto"));
  db.close();
});

test("B4: parseScorePayload กรอง known_name — เกิน 50/ตัวเลขล้วน/ไม่ใช่ string = ทิ้ง", () => {
  const base = { score: 5, trend: "flat" };
  assert.equal(parseScorePayload(JSON.stringify({ ...base, known_name: "บี" })).known_name, "บี");
  assert.equal(parseScorePayload(JSON.stringify({ ...base, known_name: "Somchai P." })).known_name, "Somchai P.");
  assert.equal(parseScorePayload(JSON.stringify({ ...base, known_name: "ก".repeat(51) })).known_name, "");
  assert.equal(parseScorePayload(JSON.stringify({ ...base, known_name: "12345" })).known_name, "");
  assert.equal(parseScorePayload(JSON.stringify({ ...base, known_name: null })).known_name, "");
  assert.equal(parseScorePayload(JSON.stringify({ ...base })).known_name, "");
});

/* --------------------- B6: notes เข้า prompt + โน้ต ai_auto ------------------ */

test("B6: บันทึกส่งต่อถูก inject เข้า draft prompt (เก่า -> ใหม่)", async () => {
  const hermesFetch = hermesFetchStub("รับทราบค่ะ สนใจรุ่นไหนเพิ่มเติมไหมคะ");
  const { app, db } = makeApp({ hermesFetch });
  db.upsertCustomer("U-note", {});
  db.addHandoffNote({ customerId: "U-note", author: "nok", text: "ลูกค้าเคยโทรมาถามเรื่องผ่อน" });
  db.addHandoffNote({ customerId: "U-note", author: "bee", text: "รอใบเสนอราคาจากทีมขาย" });

  await app.pipeline.handleInboundText({ customerId: "U-note", text: "ตามเรื่องหน่อยค่ะ", replyToken: "" });
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.ok(system.includes("บันทึกจากทีมงาน:"));
  assert.ok(system.includes("[nok] ลูกค้าเคยโทรมาถามเรื่องผ่อน"));
  assert.ok(system.includes("[bee] รอใบเสนอราคาจากทีมขาย"));
  assert.ok(
    system.indexOf("โทรมาถามเรื่องผ่อน") < system.indexOf("รอใบเสนอราคา"),
    "เรียงเก่า -> ใหม่"
  );
  db.close();
});

test("B6: scorer อัปเดตโน้ต ai_auto แถวเดียว — รอบใหม่แทนของเก่า โน้ตคนไม่แตะ", async () => {
  let round = 0;
  const hermesFetch = async (url, opts) => {
    round += 1;
    const body = JSON.parse(opts.body);
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: scorerJson({ context_summary: `สรุปรอบที่ ${round}` }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
      _body: body,
    };
  };
  const { app, db } = makeApp({ hermesFetch });
  db.upsertCustomer("U-auto", {});
  db.addHandoffNote({ customerId: "U-auto", author: "nok", text: "โน้ตของคน" });
  db.insertMessage({ customerId: "U-auto", direction: "in", content: "สนใจค่ะ" });

  await app.pipeline.scoreBurst("U-auto");
  await app.pipeline.scoreBurst("U-auto");
  const notes = db.listHandoffNotes("U-auto");
  const autoNotes = notes.filter((n) => n.author === "ai_auto");
  assert.equal(autoNotes.length, 1, "โน้ต ai_auto ต้องมีแถวเดียว");
  assert.equal(autoNotes[0].text, "สรุปรอบที่ 2", "ต้องเป็นสรุปรอบล่าสุด");
  assert.ok(notes.some((n) => n.author === "nok" && n.text === "โน้ตของคน"), "โน้ตคนต้องอยู่ครบ");
  db.close();
});

test("B6: listHandoffNotes จำกัดจำนวน — เอา N ล่าสุด เรียงเก่า -> ใหม่", () => {
  const db = memoryDb();
  db.upsertCustomer("U-many", {});
  for (let i = 1; i <= 12; i += 1) {
    db.addHandoffNote({ customerId: "U-many", author: "nok", text: `โน้ต ${i}` });
  }
  const notes = db.listHandoffNotes("U-many", 10);
  assert.equal(notes.length, 10);
  assert.equal(notes[0].text, "โน้ต 3", "ตัวเก่าสุดใน 10 ล่าสุด");
  assert.equal(notes[9].text, "โน้ต 12");
  db.close();
});

test("B6: pinned note เก่ายังคงอยู่ใน limit และแต่ละกลุ่มเรียง deterministic", () => {
  const db = memoryDb();
  db.upsertCustomer("U-pinned-many", {});
  const rows = [];
  for (let i = 1; i <= 5; i += 1) {
    rows.push(db.addHandoffNote({ customerId: "U-pinned-many", author: "nok", text: `โน้ต ${i}` }));
  }
  db.setHandoffNotePinned(rows[0].id, true);
  assert.deepEqual(
    db.listHandoffNotes("U-pinned-many", 3).map((row) => row.text),
    ["โน้ต 1", "โน้ต 4", "โน้ต 5"],
  );
  db.close();
});

/* ------------------------------ B7d: agent_mode ----------------------------- */

test("B7d: reply จาก AI ถูกบันทึก agent_mode='ai' ทั้ง text และรูป", async () => {
  const hermesFetch = hermesFetchStub("จัดให้เลยค่ะ [IMAGE:x3] สนใจไหมคะ");
  const { app, db } = makeApp({ hermesFetch });
  await app.pipeline.handleInboundText({ customerId: "U-mode", text: "ขอรูปหน่อยค่ะ", replyToken: "rt" });
  const out = db.messagesFor("U-mode").filter((m) => m.direction === "out");
  assert.ok(out.length >= 2, "ต้องมีทั้ง text และรูป");
  for (const row of out) assert.equal(row.agent_mode, "ai");
  db.close();
});
