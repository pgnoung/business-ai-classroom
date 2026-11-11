// จำแนกรูปก่อนตัดสินว่าเป็นเรื่องเงินไหม (คำสั่งเจ้าของ 2026-08-29)
//
// ทิศทางความเสียหายไม่สมมาตร และเป็นหัวใจของไฟล์นี้:
//   พลาดจับสลิป -> บอทอาจคุยเรื่องยอดเงินเอง เงินผิดกู้คืนไม่ได้
//   จับเกิน      -> เสียลีด ซึ่งคนแก้ได้
// ดังนั้นทุกความไม่แน่นอนต้องออกมาเป็น "unknown" ซึ่งฝั่งตัวตัดสินใจถือเป็นเรื่องเงิน
// ห้ามมีเส้นทางไหนที่ความล้มเหลวกลายเป็น "other" เด็ดขาด
import test from "node:test";
import assert from "node:assert/strict";
import { classifyImage, MAX_CLASSIFY_BYTES } from "../src/imageClassifier.mjs";

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const reply = (obj) => async () => JSON.stringify(obj);

test("จำแนกได้ว่าเป็นสลิป", async () => {
  const r = await classifyImage({ bytes: png, mime: "image/png", callModel: reply({ kind: "slip", description: "สลิปโอนเงิน" }), logger: silent });
  assert.equal(r.kind, "slip");
});

test("จำแนกได้ว่าไม่ใช่เรื่องเงิน พร้อมคำอธิบายสั้นให้บอทใช้คุยต่อ", async () => {
  const r = await classifyImage({ bytes: png, mime: "image/png", callModel: reply({ kind: "other", description: "ภาพโพสต์โฆษณาคลาสสอน AI" }), logger: silent });
  assert.equal(r.kind, "other");
  assert.match(r.description, /คลาสสอน AI/u);
});

test("เอกสารนับเป็นเรื่องเงิน", async () => {
  const r = await classifyImage({ bytes: png, mime: "image/png", callModel: reply({ kind: "document", description: "ใบเสร็จ" }), logger: silent });
  assert.equal(r.kind, "document");
});

test("โมเดลตอบเพี้ยน / ไม่ใช่ JSON / ค่านอกรายการ ต้องได้ unknown", async () => {
  for (const bad of ["ไม่ใช่ JSON", JSON.stringify({ kind: "ไม่รู้" }), JSON.stringify({ kind: 5 }), JSON.stringify({}), "", null]) {
    const r = await classifyImage({ bytes: png, mime: "image/png", callModel: async () => bad, logger: silent });
    assert.equal(r.kind, "unknown", `ต้อง unknown เมื่อโมเดลตอบ: ${String(bad).slice(0, 20)}`);
  }
});

test("โมเดลล้ม / หมดเวลา ต้องได้ unknown ไม่ใช่ other", async () => {
  const r = await classifyImage({ bytes: png, mime: "image/png", callModel: async () => { throw new Error("timeout"); }, logger: silent });
  assert.equal(r.kind, "unknown");
});

// เคสจริง 2026-09-05: รูปลูกค้า 1,067,264 ไบต์ (PNG 960x1280) โดนเกตเวย์ของเราตอบ HTTP 400
// (data URI พองเป็น ~1.42MB ชนเพดาน body 1 MiB เดิม) วันเดียวกันยกเพดาน body เกตเวย์เป็น 6 MiB
// เพดานฝั่งนี้จึงต้อง (ก) รับรูปจริงใบนั้นได้ และ (ข) ไม่ผลิต data URI เกิน MAX_IMAGE_BYTES ของเกตเวย์
test("เพดานขนาดรูปต้องรับรูปจริงที่เคยถูกปฏิเสธ และไม่ล้นเพดานรูปต่อใบของเกตเวย์", () => {
  // data URI = ไบต์ดิบ × ~1.37 (base64 + หัว data:image/png;base64,) ต้องไม่เกิน MAX_IMAGE_BYTES ของเกตเวย์ (4,000,000)
  assert.ok(Math.ceil(MAX_CLASSIFY_BYTES * 4 / 3) + 40 <= 4_000_000, `เพดาน ${MAX_CLASSIFY_BYTES} ทำให้ data URI เกิน 4,000,000 ที่เกตเวย์รับ`);
  assert.ok(MAX_CLASSIFY_BYTES >= 1_067_264, `รูปจริง 1,067,264 ไบต์ที่เคยถูกปฏิเสธ 2026-09-05 ต้องจำแนกได้แล้ว (เพดาน ${MAX_CLASSIFY_BYTES})`);
});

test("ทุกทางที่ออกมาเป็น unknown ต้องพก reason ให้ ops อ่านออกว่าเพราะอะไร", async () => {
  const huge = await classifyImage({ bytes: Buffer.alloc(MAX_CLASSIFY_BYTES + 1), mime: "image/png", callModel: async () => "x", logger: silent });
  assert.equal(huge.kind, "unknown");
  assert.match(huge.reason, /รูปใหญ่เกิน/u);
  assert.match(huge.reason, /ไบต์/u, "ต้องบอกขนาดจริงด้วย — ops ใช้แยกว่าเกตเวย์ปฏิเสธหรือสวิตช์ปิด");

  const down = await classifyImage({ bytes: png, mime: "image/png", callModel: async () => { throw new Error("HTTP 400"); }, logger: silent });
  assert.equal(down.kind, "unknown");
  assert.match(down.reason, /HTTP 400/u);

  const ok = await classifyImage({ bytes: png, mime: "image/png", callModel: reply({ kind: "other", description: "โพสต์" }), logger: silent });
  assert.equal(ok.reason, "", "จำแนกสำเร็จต้องไม่มีเหตุผลค้างไว้ให้สับสน");
});

test("รูปใหญ่เกิน หรือชนิดไม่รองรับ ต้องได้ unknown โดยไม่เรียกโมเดลเลย", async () => {
  let called = 0;
  const spy = async () => { called += 1; return JSON.stringify({ kind: "other" }); };
  const huge = Buffer.alloc(MAX_CLASSIFY_BYTES + 1);
  assert.equal((await classifyImage({ bytes: huge, mime: "image/png", callModel: spy, logger: silent })).kind, "unknown");
  assert.equal((await classifyImage({ bytes: png, mime: "image/gif", callModel: spy, logger: silent })).kind, "unknown");
  assert.equal((await classifyImage({ bytes: null, mime: "image/png", callModel: spy, logger: silent })).kind, "unknown");
  assert.equal(called, 0, "ห้ามเสียเงินเรียกโมเดลกับรูปที่ใช้ไม่ได้");
});

test("ส่งรูปเป็น data URI ให้โมเดล และส่งทีละใบเท่านั้น", async () => {
  let seen = null;
  await classifyImage({ bytes: png, mime: "image/png", logger: silent,
    callModel: async (messages) => { seen = messages; return JSON.stringify({ kind: "other" }); } });
  const blocks = seen.at(-1).content;
  const imgs = blocks.filter((b) => b.type === "image_url");
  assert.equal(imgs.length, 1);
  assert.match(imgs[0].image_url.url, /^data:image\/png;base64,/u);
  assert.ok(blocks.some((b) => b.type === "text"), "ต้องมีคำสั่งเป็นข้อความคู่ไปด้วย");
});

// ตรวจปรปักษ์ 2026-09-05: ตัวแกะคำตอบเชื่อ field "kind" อย่างเดียว ถ้าโมเดลขัดกันเอง
// ({"kind":"other","description":"สลิปโอนเงิน…"}) รูปสลิปจะกลายเป็นข้อความคุยต่อ
// และ safetyRouter ปิดด่านคำนามสำหรับข้อความสังเคราะห์ชุดนั้นไว้พอดี = ไม่มีชั้นไหนรับเลย
test("คำบรรยายที่พูดถึงหลักฐานการเงิน ต้องชนะ kind ที่โมเดลตอบมา", async () => {
  for (const description of ["สลิปโอนเงินธนาคาร", "ใบเสร็จรับเงิน", "หลักฐานการโอน", "bank slip screenshot"]) {
    const v = await classifyImage({ bytes: png, mime: "image/png", callModel: reply({ kind: "other", description }), logger: silent });
    assert.equal(v.kind, "document", `คำบรรยาย "${description}" หลุดเป็น other`);
  }
});

test("คำบรรยายรูปธรรมดา ยังต้องเป็น other เหมือนเดิม (อย่ากันเกินจนลีดตาย)", async () => {
  for (const description of ["โพสต์โฆษณาคลาสสอน AI", "ภาพหน้าจอเว็บไซต์", "รูปถ่ายหน้าร้าน"]) {
    const v = await classifyImage({ bytes: png, mime: "image/png", callModel: reply({ kind: "other", description }), logger: silent });
    assert.equal(v.kind, "other", `กันเกิน: "${description}"`);
  }
});

// reasonCode คือคำตอบของคำถามเดียว: "ระบบเคยเห็นไบต์ของรูปใบนี้จริงไหม" — ไปป์ไลน์ใช้มัน
// ตัดสินว่าจะปักธงเงินถาวรหรือไม่ (ดู IMAGE_NO_ATTEMPT_CODES) สัญญา fail-closed ไม่เปลี่ยน
test("ทุกทางออก unknown ต้องพก reasonCode ที่แยก 'เคยเห็นไบต์' ออกจาก 'ไม่เคยแตะ'", async () => {
  const big = await classifyImage({ bytes: Buffer.alloc(MAX_CLASSIFY_BYTES + 1), mime: "image/png", callModel: reply({}), logger: silent });
  assert.equal(big.kind, "unknown");
  assert.equal(big.reasonCode, "too_large");
  const bad = await classifyImage({ bytes: png, mime: "image/gif", callModel: reply({}), logger: silent });
  assert.equal(bad.reasonCode, "bad_mime");
  const boom = await classifyImage({ bytes: png, mime: "image/png", callModel: async () => { throw new Error("HTTP 400"); }, logger: silent });
  assert.equal(boom.reasonCode, "model_error");
  const junk = await classifyImage({ bytes: png, mime: "image/png", callModel: async () => "ไม่ใช่ JSON", logger: silent });
  assert.equal(junk.reasonCode, "unparsable");
  const ok = await classifyImage({ bytes: png, mime: "image/png", callModel: reply({ kind: "other", description: "โพสต์" }), logger: silent });
  assert.equal(ok.reasonCode, "", "จำแนกสำเร็จ = ไม่มีเหตุขัดข้อง");
});
