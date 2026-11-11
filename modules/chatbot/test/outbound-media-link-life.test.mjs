// รูปที่ส่งไปหาลูกค้าต้องเปิดดูได้ตลอด ไม่ใช่พังกลายเป็นกรอบดำ
//
// เหตุการณ์จริง 2026-08-27: พี่ง้วงเปิดแชทฝั่งลูกค้าแล้วเห็นรูปที่ส่งตอน 21:26
// กลายเป็นกรอบดำตอน 01:08 — สาเหตุคือสิทธิ์เข้าถึงลิงก์ตั้งไว้ 15 นาที
// ไฟล์ไม่ได้หายไปไหนเลย (13 ไฟล์ 5.7MB ยังอยู่ครบบนดิสก์) หายแค่สิทธิ์
//
// สมมติฐานเดิมที่ผิด: "LINE ดึงรูปทันทีแล้วจบ" — ของจริงคือเครื่องลูกค้าดึงซ้ำ
// ทุกครั้งที่เลื่อนกลับมาดูแชทเก่า เพดาน 15 นาทีจึงแปลว่ารูปทุกใบพังภายในวันเดียว
import test from "node:test";
import assert from "node:assert/strict";
import { createConfig } from "../src/config.mjs";

const DAY = 24 * 60 * 60 * 1000;
const base = (extra = {}) => ({
  LINE_CHANNEL_ACCESS_TOKEN: "t".repeat(40),
  LINE_CHANNEL_SECRET: "s".repeat(32),
  HERMES_BASE_URL: "https://hermes.example.test",
  CONSOLE_SESSION_SECRET: "c".repeat(32),
  ...extra,
});

test("อายุลิงก์รูปต้องยาวเป็นปี ไม่ใช่นาที", () => {
  const config = createConfig(base());
  assert.ok(
    config.outboundImageLinkTtlMs >= 365 * DAY,
    `ต้องอย่างน้อย 1 ปี (ได้ ${Math.round(config.outboundImageLinkTtlMs / DAY)} วัน)`,
  );
});

test("อายุลิงก์ไฟล์ต้องยาวเป็นปีเช่นกัน", () => {
  const config = createConfig(base());
  assert.ok(
    config.outboundFileLinkTtlMs >= 365 * DAY,
    `ต้องอย่างน้อย 1 ปี (ได้ ${Math.round(config.outboundFileLinkTtlMs / DAY)} วัน)`,
  );
});

test("เพดาน 15 นาทีของเดิมต้องไม่กลับมาอีก", () => {
  // ล็อกไว้ตรง ๆ: ถ้าใครเผลอย่อกลับ เทสต์นี้ต้องดังทันที ไม่ใช่ไปรู้ตอนลูกค้าเห็นกรอบดำ
  const config = createConfig(base());
  assert.notEqual(config.outboundImageLinkTtlMs, 15 * 60 * 1000);
  assert.ok(config.outboundImageLinkTtlMs > 24 * 60 * 60 * 1000, "ต้องเกินหนึ่งวันแน่นอน");
});

test("ย่นกลับได้ด้วย env ถ้านโยบายเปลี่ยน", () => {
  // ยังต้องปรับสั้นลงได้ — กลไกเพิกถอนตาม PDPA พึ่งคอลัมน์ expires_at อยู่
  const config = createConfig(base({ OUTBOUND_IMAGE_LINK_TTL_MS: String(30 * 60 * 1000) }));
  assert.equal(config.outboundImageLinkTtlMs, 30 * 60 * 1000);
});

test("ค่าต่ำกว่าพื้นถูกดันขึ้นเป็น 1 นาที", () => {
  const config = createConfig(base({ OUTBOUND_IMAGE_LINK_TTL_MS: "1000" }));
  assert.equal(config.outboundImageLinkTtlMs, 60_000);
});

test("ค่าเกินเพดานถูกกดลงมาที่เพดาน ไม่ใช่ไม่มีวันหมดอายุ", () => {
  const config = createConfig(base({ OUTBOUND_IMAGE_LINK_TTL_MS: String(Number.MAX_SAFE_INTEGER) }));
  assert.ok(Number.isFinite(config.outboundImageLinkTtlMs));
  assert.ok(config.outboundImageLinkTtlMs <= 10 * 365 * DAY);
});
