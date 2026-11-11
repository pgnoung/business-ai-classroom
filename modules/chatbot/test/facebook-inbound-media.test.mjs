// รูปที่ลูกค้าส่งมาทาง Facebook ต้องเห็นในคอนโซล (เคสจริง 2026-08-30: คุณ Amarit ส่งสลิป
// แล้วคอนโซลขึ้นแค่ "[image]")
//
// Facebook ต่างจาก LINE: ไฟล์แนบมาเป็น "URL ชั่วคราวบน CDN ของ Meta" ในตัว webhook เอง
// ไม่ใช่ content API ที่ต้องยิงด้วย message id — เดิมโค้ดทิ้ง URL นั้นแล้วเก็บแค่ข้อความ
// "[image]" ทำให้ไม่มีแถว attachment ให้คอนโซลแสดง และสลิป (หลักฐานการเงิน) ก็หายไปด้วย
//
// ที่ต้องระวัง: URL จาก webhook = ข้อมูลภายนอก ห้ามให้เซิร์ฟเวอร์ยิงไปโฮสต์อะไรก็ได้ (SSRF)
// จึงจำกัดเฉพาะโดเมน CDN ของ Meta เท่านั้น
import test from "node:test";
import assert from "node:assert/strict";
import { createFacebookClient } from "../src/facebookClient.mjs";

const baseConfig = { fbApiVersion: "v23.0", fbLiveSend: true, lineTimeoutMs: 5000 };
const IMG = "https://scontent-bkk1-1.xx.fbcdn.net/v/t1.0/slip.jpg?token=abc";

function clientWith(fetchImpl, extra = {}) {
  return createFacebookClient({
    config: { ...baseConfig, ...extra },
    credentials: () => ({ pageAccessToken: "tok" }),
    fetchImpl,
  });
}

const okResponse = (bytes, mime = "image/jpeg") => ({
  ok: true, status: 200,
  headers: { get: (k) => (k === "content-length" ? String(bytes.length) : mime) },
  body: {
    getReader() {
      let done = false;
      return {
        read: async () => (done ? { done: true } : ((done = true), { done: false, value: bytes })),
        cancel: async () => {},
        releaseLock() {},
      };
    },
  },
});

test("ดาวน์โหลดรูปจาก URL ของ Meta CDN ได้ และคืนรูปแบบเดียวกับฝั่ง LINE", async () => {
  const payload = Buffer.from("fake-jpeg-bytes");
  let asked = "";
  const client = clientWith(async (url) => { asked = String(url); return okResponse(payload); });
  const got = await client.getMessageContent(IMG, { maxBytes: 1_000_000 });
  assert.equal(got.ok, true);
  assert.equal(got.status, 200);
  assert.equal(got.mime, "image/jpeg");
  assert.deepEqual(got.bytes, payload);
  assert.equal(asked, IMG, "ต้องยิงไปที่ URL เดิมที่ Meta ให้มา ไม่แต่งเพิ่ม");
});

test("ปฏิเสธโฮสต์นอก CDN ของ Meta — กัน SSRF จาก payload ปลอม", async () => {
  let called = 0;
  const client = clientWith(async () => { called += 1; return okResponse(Buffer.from("x")); });
  for (const bad of [
    "https://evil.example.com/a.jpg",
    "http://scontent.xx.fbcdn.net/a.jpg",       // ต้องเป็น https เท่านั้น
    "https://fbcdn.net.evil.com/a.jpg",          // โดเมนหลอก
    "https://127.0.0.1/a.jpg",
    "file:///etc/passwd",
    "",
  ]) {
    const got = await client.getMessageContent(bad, { maxBytes: 1000 });
    assert.equal(got.ok, false, `ต้องปฏิเสธ ${bad}`);
  }
  assert.equal(called, 0, "fail-closed: ห้ามมี network call แม้แต่ครั้งเดียว");
});

test("ไฟล์ใหญ่เกินเพดานต้องไม่ถูกเก็บ", async () => {
  const big = Buffer.alloc(50);
  const client = clientWith(async () => okResponse(big));
  const got = await client.getMessageContent(IMG, { maxBytes: 10 });
  assert.equal(got.ok, false);
  assert.equal(got.reason, "content_too_large");
});

test("โหมด mock ห้ามยิงออกเน็ตจริง", async () => {
  let called = 0;
  const client = clientWith(async () => { called += 1; return okResponse(Buffer.from("x")); },
    { fbMockUrl: "http://mock" });
  const got = await client.getMessageContent(IMG, { maxBytes: 1000 });
  assert.equal(got.ok, false);
  assert.equal(called, 0);
});
