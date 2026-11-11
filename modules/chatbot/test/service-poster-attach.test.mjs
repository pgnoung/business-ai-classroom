// 2026-10-03: พี่ง้วงทดลอง "สนใจ Private Class" จาก LINE แล้วได้แต่ข้อความ ไม่มีโปสเตอร์
// พรอมต์สั่ง "ต้องใส่ marker" แล้วก็ยังไม่พอ — วัดของจริง 30 วัน โปสเตอร์ที่สั่งด้วยถ้อยคำถูกแนบจริงแค่ 2 ใน 4
// ลูกค้าเอ่ยชื่อบริการเอง = ระบบแนบโปสเตอร์ให้เองเมื่อโมเดลลืม (ตรรกะเดียวกับพรอมต์ ผ่านตัวกันรูปซ้ำเดิม)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const CATALOG = ["private-class", "in-house-training", "monthly-consult", "flash-consult", "online-custom-gpts", "ai-agent-for-business"]
  .map((key) => ({ key, url: `https://img.test/${key}.png`, previewUrl: `https://img.test/${key}-preview.jpg`, needsVerification: false }));

function makeApp(draft) {
  const db = memoryDb();
  const app = createApp({
    config: testConfig({ HISTORY_TURNS: "6" }),
    db,
    overrides: { hermesFetch: hermesFetchStub(draft), lineFetch: lineFetchStub(), sleep: async () => {}, imageCatalog: CATALOG },
    logger: silent,
  });
  return { db, app };
}

// ห้องที่คุยกันมาแล้ว (ไม่ใช่ข้อความแรก — กันกติกาบันได 7 Stage ปนผล)
function seed(db, customerId, extra = []) {
  db.upsertCustomer(customerId, {});
  db.insertMessage({ customerId, direction: "in", content: "สวัสดีค่ะ" });
  db.insertMessage({ customerId, direction: "out", content: "สวัสดีค่ะ ยินดีให้ข้อมูลนะคะ" });
  for (const message of extra) db.insertMessage({ customerId, ...message });
}

const DRAFT_NO_IMAGE = "มี Private Class แบบสอนสดส่วนตัวค่ะ ทีมผู้ดูแลจะช่วยออกแบบรายละเอียดให้ค่ะ\nอยากให้เน้นเรื่องไหนเป็นพิเศษคะ?";

test("ลูกค้าเอ่ยชื่อบริการ แต่โมเดลลืมแนบโปสเตอร์ -> ระบบแนบให้เอง", async () => {
  const { db, app } = makeApp(DRAFT_NO_IMAGE);
  seed(db, "U-pc");
  const result = await app.pipeline.handleInboundText({ customerId: "U-pc", text: "สนใจ Private Class", replyToken: "rt-pc" });
  assert.equal(result.sent, true);
  assert.deepEqual(result.imageKeys, ["private-class"]);
  db.close();
});

test("บริการอื่นก็ได้โปสเตอร์ของตัวเอง (in-house / private consult / ที่ปรึกษารายเดือน / flash)", async () => {
  for (const [text, key] of [
    ["มี in-house ไหมคะ", "in-house-training"],
    ["สนใจ Private Consult ค่ะ", "monthly-consult"],
    ["สนใจที่ปรึกษารายเดือนค่ะ", "monthly-consult"],
    ["Flash consult คืออะไรคะ", "flash-consult"],
  ]) {
    const { db, app } = makeApp("ได้เลยค่ะ เดี๋ยวลูกแพรเล่ารายละเอียดให้นะคะ\nสนใจด้านไหนเป็นพิเศษคะ?");
    seed(db, "U-svc");
    const result = await app.pipeline.handleInboundText({ customerId: "U-svc", text, replyToken: "rt-svc" });
    assert.deepEqual(result.imageKeys, [key], text);
    db.close();
  }
});

test("โมเดลแนบเองแล้ว -> ไม่แนบซ้ำในเทิร์นเดียว", async () => {
  const { db, app } = makeApp(`${DRAFT_NO_IMAGE} [IMAGE:private-class]`);
  seed(db, "U-pc-own");
  const result = await app.pipeline.handleInboundText({ customerId: "U-pc-own", text: "สนใจ Private Class", replyToken: "rt-own" });
  assert.deepEqual(result.imageKeys, ["private-class"]);
  db.close();
});

test("เคยส่งโปสเตอร์นี้ไปแล้วใน 7 วัน -> ระบบไม่แนบซ้ำ (ตัวกันรูปซ้ำเดิมยังคุม)", async () => {
  const { db, app } = makeApp(DRAFT_NO_IMAGE);
  seed(db, "U-pc-sent", [{ direction: "out", msgType: "image", content: "[image:private-class] https://img.test/private-class.png" }]);
  const result = await app.pipeline.handleInboundText({ customerId: "U-pc-sent", text: "สนใจ Private Class", replyToken: "rt-sent" });
  assert.deepEqual(result.imageKeys, []);
  db.close();
});

test("ปฏิเสธบริการ / ระบบเดาบริการเอง -> ระบบไม่แนบให้", async () => {
  for (const [text, extra] of [
    ["ไม่สนใจ private class ค่ะ ขอคลาสปกติ", []],
    ["ราคาเท่าไหร่ครับ", [{ direction: "in", content: "มากัน 5 คนครับ" }]],
  ]) {
    const { db, app } = makeApp("ได้เลยค่ะ\nสนใจด้านไหนเป็นพิเศษคะ?");
    seed(db, "U-no", extra);
    const result = await app.pipeline.handleInboundText({ customerId: "U-no", text, replyToken: "rt-no" });
    assert.deepEqual(result.imageKeys, [], text);
    db.close();
  }
});

test("คุยเส้นสอนสดมาแล้ว ถามคลาสออนไลน์ -> ห้ามแนบโปสเตอร์ออนไลน์ 4,900 (กัน downgrade)", async () => {
  const { db, app } = makeApp("คลาสสอนสดได้สิทธิ์ทบทวนออนไลน์ด้วยค่ะ\nสนใจแบบสอนสดหรือออนไลน์ดีคะ?");
  seed(db, "U-live", [{ direction: "out", content: "คลาสสอนสด AI Agent for Business ราคา Early Bird 12,900 บาท/ท่านค่ะ" }]);
  const result = await app.pipeline.handleInboundText({ customerId: "U-live", text: "มีคลาสออนไลน์ไหมคะ", replyToken: "rt-live" });
  assert.deepEqual(result.imageKeys, []);
  db.close();
});

// รีวิว 2026-10-03 (HIGH): ระบบแนบให้เอง = รูปออกแน่นอน ส่งแล้วเรียกคืนไม่ได้ — ต้องใช้คำเรียกบริการแบบชัดเท่านั้น
test("คำหลวม ๆ / ลูกค้าเก่า / ขอบคุณ / ขอเลื่อน / ไม่เอารูป / คลาสออนไลน์ -> ระบบไม่แนบโปสเตอร์ให้", async () => {
  for (const text of [
    "ร้านผมส่งของด้วย Flash Express ครับ สนใจคลาส AI",
    "อยากให้ AI ทำ monthly report ค่ะ",
    "ซื้อคลาสออนไลน์ไปแล้วค่ะ เข้าดูที่ไหนคะ",
    "ขอบคุณมากค่ะ ได้ข้อมูล in-house ครบแล้วค่ะ",
    "ขอเลื่อน private class ค่ะ",
    "ไม่ต้องส่งรูปนะคะ ขอข้อมูล Private Class เป็นข้อความ",
    "มีคลาสออนไลน์ไหมครับ",
    // รีวิวรอบ 3: คำปฏิเสธรูปแบบอื่น / ลูกค้าที่จองแล้ว / ขอย้ายรอบ
    "ไม่ต้องแนบรูปนะคะ สนใจ Private Class",
    "ขอเป็นข้อความอย่างเดียวค่ะ in-house มีแบบไหนบ้าง",
    "ลงทะเบียน private class ไว้แล้วค่ะ ต้องเตรียมอะไรบ้าง",
    "ขอย้ายรอบ private class ค่ะ",
  ]) {
    const { db, app } = makeApp("ได้เลยค่ะ\nสนใจด้านไหนเป็นพิเศษคะ?");
    seed(db, "U-loose");
    const result = await app.pipeline.handleInboundText({ customerId: "U-loose", text, replyToken: "rt-loose" });
    assert.deepEqual(result.imageKeys, [], text);
    db.close();
  }
});

// รีวิว 2026-10-03 (MEDIUM): audit ต้องบอกสิ่งที่ส่งถึงลูกค้าจริง ไม่ใช่สิ่งที่ระบบตั้งใจแนบ
test("audit service_poster_attached จดเฉพาะเมื่อโปสเตอร์ที่ระบบแนบถูกส่งจริง", async () => {
  const { db, app } = makeApp(DRAFT_NO_IMAGE);
  seed(db, "U-audit");
  await app.pipeline.handleInboundText({ customerId: "U-audit", text: "สนใจ Private Class", replyToken: "rt-audit" });
  const rows = db.listAudit(200);
  const hits = rows.filter((row) => row.action === "service_poster_attached");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].detail, "private-class");

  const own = makeApp(`${DRAFT_NO_IMAGE} [IMAGE:private-class]`);
  seed(own.db, "U-audit-own");
  await own.app.pipeline.handleInboundText({ customerId: "U-audit-own", text: "สนใจ Private Class", replyToken: "rt-audit-own" });
  const ownRows = own.db.listAudit(200);
  assert.equal(ownRows.filter((row) => row.action === "service_poster_attached").length, 0, "โมเดลแนบเอง = ไม่ใช่ระบบแนบ");
  db.close();
  own.db.close();
});

// รีวิว 2026-10-03 รอบ 3: "ไม่ต้องส่งรูปซ้ำ" เคยถูกนับเป็น "ลูกค้าขอรูปเอง" แล้วปลดตัวกันรูปซ้ำ 7 วัน
test("ลูกค้าบอกไม่ต้องส่งรูปซ้ำ -> ตัวกันรูปซ้ำยังทำงาน (รูปที่โมเดลใส่มาซ้ำไม่ออก)", async () => {
  const { db, app } = makeApp(`${DRAFT_NO_IMAGE} [IMAGE:private-class]`);
  seed(db, "U-no-repeat", [{ direction: "out", msgType: "image", content: "[image:private-class] https://img.test/private-class.png" }]);
  const result = await app.pipeline.handleInboundText({ customerId: "U-no-repeat", text: "ไม่ต้องส่งรูปซ้ำนะคะ ขอราคา Private Class", replyToken: "rt-no-repeat" });
  assert.equal(result.sent, true);
  assert.deepEqual(result.imageKeys, []);
  db.close();
});
