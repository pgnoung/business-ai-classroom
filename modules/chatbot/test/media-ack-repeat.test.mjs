// media-ack-repeat.test.mjs — รีวิวเคสจริง 6–7 ต.ค.: ลูกค้าส่งไฟล์ 7 ไฟล์ติดกัน ได้ "ได้รับไฟล์แล้วนะคะ…" ข้อความเดิมเป๊ะ 7 ครั้ง
// ตอบรับครั้งเดียวต่อชุด (ข้อความตอบรับเดียวกันภายใน 10 นาที และไม่มีใครพิมพ์อะไรคั่น) — ไฟล์ที่ตามมาเงียบโดยเจตนาพร้อมเหตุที่อ่านออก
// ธงคิวรอคน โน้ตทีม การแจ้งเตือน และพฤติกรรมห้องเงิน/ห้องของทีม เหมือนเดิมทุกไฟล์ · ข้อความลูกค้าในไฟล์นี้เป็นประโยคสังเคราะห์
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { FILE_ACK_TEMPLATE, IMAGE_ACK_TEMPLATE, MEDIA_ACK_REPEAT_WINDOW_MS } from "../src/pipeline.mjs";
import { stampInboundOutcome } from "../src/inboundOutcome.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };

// ไปป์ไลน์อ่านนาฬิกาจริง (Date.now) — เทสต์ใช้นาฬิกาจริงเหมือนกัน แล้วย้อนเวลาแถวข้อความเองเมื่อต้องการ "ผ่านไปนาน"
function makeApp({ imageClassify = null } = {}) {
  const db = memoryDb();
  const notices = [];
  const line = lineFetchStub();
  const app = createApp({
    db, logger: silent, config: testConfig({}),
    overrides: {
      notifier: { fireLater: (n) => notices.push(n) }, hermesFetch: hermesFetchStub("ได้เลยค่ะ ลูกแพรช่วยดูให้นะคะ"), lineFetch: line,
      sleep: async () => {}, ...(imageClassify ? { imageClassify } : {}),
    },
  });
  return { app, db, notices, line };
}
const sentTexts = (line) => line.sends.flatMap((s) => (s.body?.messages || []).map((m) => m.text || ""));
// เหมือน webhook จริง: แถวขาเข้าของไฟล์ถูกจดก่อนถึงไปป์ไลน์
async function sendFile(ctx, customerId, n) {
  ctx.db.insertMessage({ id: `in:file-${n}`, customerId, direction: "in", msgType: "file", content: `[file] id=file-${n}` });
  return ctx.app.pipeline.handleEvent({ type: "message", replyToken: `rt-file-${n}`, source: { userId: customerId }, message: { type: "file", id: `file-${n}`, fileName: `doc-${n}.pdf` } });
}
async function sendImage(ctx, customerId, n) {
  ctx.db.insertMessage({ id: `in:img-${n}`, customerId, direction: "in", msgType: "image", content: `[image] id=img-${n}` });
  return ctx.app.pipeline.handleEvent({ type: "message", replyToken: `rt-img-${n}`, source: { userId: customerId }, message: { type: "image", id: `img-${n}` } });
}

test("ไฟล์เดียว = ตอบรับหนึ่งครั้งเหมือนเดิม", async (t) => {
  const ctx = makeApp();
  t.after(() => ctx.db.close());
  ctx.db.upsertCustomer("U-one-file", {});
  const result = await sendFile(ctx, "U-one-file", 1);
  assert.equal(result.sent, true);
  assert.deepEqual(sentTexts(ctx.line), [FILE_ACK_TEMPLATE]);
});

test("7 ไฟล์ติดกัน = ตอบรับครั้งเดียว · ไฟล์ที่ตามมาเงียบโดยเจตนา (file_ack_repeat) · ธงคิว/โน้ตทีมครบทุกไฟล์", async (t) => {
  const ctx = makeApp();
  t.after(() => ctx.db.close());
  const id = "U-seven-files";
  ctx.db.upsertCustomer(id, {});
  const results = [];
  for (let n = 1; n <= 7; n += 1) results.push(await sendFile(ctx, id, n));
  assert.deepEqual(sentTexts(ctx.line), [FILE_ACK_TEMPLATE], "ลูกค้าได้ข้อความตอบรับข้อความเดียว");
  assert.equal(results[0].sent, true);
  for (const result of results.slice(1)) assert.deepEqual(result, { suppressed: "file_ack_repeat", route: "file_review" });
  const row = ctx.db.getCustomer(id);
  assert.equal(row.ai_enabled, 1, "ห้องที่ไม่มีเรื่องเงินยังคุยต่อ");
  assert.equal(row.state, "NEEDS_HUMAN");
  assert.equal(ctx.db.listHandoffNotes(id, 20).filter((n) => n.author === "ai_auto").length, 7, "โน้ตให้ทีมเปิดดูไฟล์ยังจดทุกไฟล์เหมือนเดิม");
  assert.equal(ctx.notices.filter((n) => n.reason === "file_review").length, 0, "ห้องไม่มีเรื่องเงิน = ไม่ปลุกทีมเหมือนเดิม");
  assert.equal(ctx.db.listAudit().filter((a) => a.action === "file_review" && a.target === id).length, 7);
  // บัญชีเทิร์น: ไฟล์ที่ตามมาจดเป็นเงียบโดยเจตนาพร้อมเหตุผลที่อ่านออก
  const calls = [];
  stampInboundOutcome({ closeInboundTurnWithEarlier: (messageId, outcome) => calls.push({ messageId, ...outcome }) }, "in:file-2", results[1], silent);
  assert.deepEqual(calls, [{ messageId: "in:file-2", status: "silent_by_design", reason: "file_ack_repeat" }]);
});

test("ไฟล์ → ลูกค้าพิมพ์ → ไฟล์ = ตอบรับใหม่ได้ (มีคนพิมพ์คั่น) · พ้นหน้าต่าง 10 นาที = ตอบรับใหม่", async (t) => {
  const ctx = makeApp();
  t.after(() => ctx.db.close());
  const id = "U-file-text-file";
  ctx.db.upsertCustomer(id, {});
  await sendFile(ctx, id, 1);
  ctx.db.insertMessage({ customerId: id, direction: "in", content: "ไฟล์นี้คืองานที่อยากให้ AI ช่วยค่ะ" });
  await ctx.app.pipeline.handleInboundText({ customerId: id, text: "ไฟล์นี้คืองานที่อยากให้ AI ช่วยค่ะ", replyToken: "rt-text" });
  const again = await sendFile(ctx, id, 2);
  assert.equal(again.sent, true, "มีข้อความคั่น = ตอบรับไฟล์ใหม่");
  assert.equal(sentTexts(ctx.line).filter((text) => text === FILE_ACK_TEMPLATE).length, 2);

  const late = makeApp();
  t.after(() => late.db.close());
  late.db.upsertCustomer("U-file-late", {});
  await sendFile(late, "U-file-late", 1);
  late.db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ? AND direction = 'out'")
    .run(Date.now() - MEDIA_ACK_REPEAT_WINDOW_MS - 60_000, "U-file-late");
  assert.equal((await sendFile(late, "U-file-late", 2)).sent, true, "ชุดใหม่หลังหน้าต่าง = ตอบรับใหม่");
  assert.equal(sentTexts(late.line).length, 2);
});

test("รูปหลายรูปติดกัน (จำแนกไม่ได้ ห้องไม่มีเรื่องเงิน) = ตอบรับรูปครั้งเดียว · ยังปลุกคนตรวจทุกรูปเหมือนเดิม", async (t) => {
  const noFile = { kind: "unknown", reason: "ไม่มีไฟล์รูปให้จำแนกทัน", reasonCode: "no_file" };
  const ctx = makeApp({ imageClassify: { enabled: true, classify: async () => noFile } });
  t.after(() => ctx.db.close());
  const id = "U-three-images";
  ctx.db.upsertCustomer(id, {});
  const results = [];
  for (let n = 1; n <= 3; n += 1) results.push(await sendImage(ctx, id, n));
  assert.deepEqual(sentTexts(ctx.line), [IMAGE_ACK_TEMPLATE]);
  assert.deepEqual(results.slice(1).map((r) => r.suppressed), ["image_ack_repeat", "image_ack_repeat"]);
  assert.equal(ctx.notices.filter((n) => n.reason === "image_review").length, 3, "การแจ้งคนตรวจรูปเดินทุกรูปเหมือนเดิม");
});

test("รอบรีวิว 8 (C7): ไฟล์กับรูปสลับกัน (ไฟล์ รูป ไฟล์ รูป) = ตอบรับครั้งเดียว — ข้อความตอบรับไฟล์หรือรูปตัวใดตัวหนึ่งก็นับ", async (t) => {
  const noFile = { kind: "unknown", reason: "ไม่มีไฟล์รูปให้จำแนกทัน", reasonCode: "no_file" };
  const ctx = makeApp({ imageClassify: { enabled: true, classify: async () => noFile } });
  t.after(() => ctx.db.close());
  const id = "U-mixed-media";
  ctx.db.upsertCustomer(id, {});
  const results = [await sendFile(ctx, id, 1), await sendImage(ctx, id, 2), await sendFile(ctx, id, 3), await sendImage(ctx, id, 4)];
  assert.deepEqual(sentTexts(ctx.line), [FILE_ACK_TEMPLATE], "ลูกค้าได้ข้อความตอบรับข้อความเดียว");
  assert.deepEqual(results.slice(1).map((r) => r.suppressed), ["image_ack_repeat", "file_ack_repeat", "image_ack_repeat"]);
  assert.equal(ctx.notices.filter((n) => n.reason === "image_review").length, 2, "การแจ้งคนตรวจรูปยังเดินทุกรูป");
});

test("รอบรีวิว 8 (C7): ตัวตรวจย้อนหลังของ JEV เห็นไฟล์/รูปที่เงียบโดยเจตนาแบบเดียวกับไฟล์แรก", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { enumerateRetrospectiveCases } = await import("../src/jevRetrospectiveAudit.mjs");
  const sql = new DatabaseSync(":memory:");
  sql.exec("CREATE TABLE admin_audit (id TEXT,action TEXT,target TEXT,detail TEXT,created_at INTEGER); CREATE TABLE customers (line_user_id TEXT,display_name TEXT,known_name TEXT,channel_id TEXT); CREATE TABLE messages (id TEXT,customer_id TEXT,direction TEXT,channel TEXT,msg_type TEXT,content TEXT,message_class TEXT,operator TEXT,session_id TEXT,created_at INTEGER,channel_id TEXT); CREATE TABLE inbound_turn_outcomes (message_id TEXT,customer_id TEXT,channel_id TEXT,status TEXT,reason TEXT,created_at INTEGER,updated_at INTEGER);");
  sql.prepare("INSERT INTO customers VALUES (?,?,?,?)").run("m", "M", "M", "line");
  for (const [n, reason] of [[1, "file_ack_repeat"], [2, "image_ack_repeat"]]) {
    sql.prepare("INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(`in-${n}`, "m", "in", "line", "file", "[file]", "reactive", "", null, 500 + n, "default");
    sql.prepare("INSERT INTO inbound_turn_outcomes VALUES (?,?,?,?,?,?,?)").run(`in-${n}`, "m", "line", "silent_by_design", reason, 500 + n, 600 + n);
  }
  const kinds = enumerateRetrospectiveCases(sql, { startMs: 0, cutoffMs: 700 }).flatMap((c) => c.eventKinds);
  assert.ok(kinds.includes("outcome:file_ack_repeat") && kinds.includes("outcome:image_ack_repeat"), JSON.stringify(kinds));
  sql.close();
});

test("ห้องที่มีเรื่องเงิน = ไม่ตอบรับไฟล์ ปิด AI ปลุกทีมทุกไฟล์ (พฤติกรรมเดิม)", async (t) => {
  const ctx = makeApp();
  t.after(() => ctx.db.close());
  const id = "U-money-files";
  ctx.db.upsertCustomer(id, {});
  ctx.db.markMoneySeen(id);
  for (let n = 1; n <= 3; n += 1) assert.equal((await sendFile(ctx, id, n)).suppressed, "file_review");
  assert.equal(ctx.line.sends.length, 0);
  assert.equal(ctx.db.getCustomer(id).ai_off_reason, "file_review");
});
