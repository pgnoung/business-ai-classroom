// follow-up ส่งทั้งชุดในคำขอเดียว
//
// คำสั่งเจ้าของ 2026-08-28: ตอนคุยสด ลูกค้าอยู่หน้าจอ การเว้นช่องไฟแบบคนพิมพ์จึงมีค่า
// แต่ตอน follow-up ลูกค้าไม่ได้อยู่ จำลองการพิมพ์ให้ใครดูก็ไม่มี
//
// ผลที่ลูกค้าเห็นเหมือนเดิมทุกอย่าง (ยังเป็นหลายบับเบิลในแชท) แต่ได้ความน่าเชื่อถือกลับมา:
// ยิงคำขอเดียว ถ้าล้มก็ล้มทั้งชุด ไม่มีกรณีลูกค้าได้ข้อความครึ่งเดียวแบบตอนโควตาหมด
// กลางลูป (เคสจริง 2026-08-15) และปล่อยล็อกเร็วขึ้น 8-16 วินาทีต่อรอบ
import test from "node:test";
import assert from "node:assert/strict";
import { createLineClient } from "../src/lineClient.mjs";
import { poisonGlobalFetch, testConfig, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeClient({ fetchImpl } = {}) {
  const sleeps = [];
  const client = createLineClient({
    config: testConfig(),
    fetchImpl: fetchImpl ?? lineFetchStub(),
    sleep: async (ms) => sleeps.push(ms),
    logger: silent,
  });
  return { client, sleeps };
}

test("follow-up: สามบับเบิลออกไปในคำขอเดียว ไม่ใช่สามคำขอ", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options?.body || "{}") });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { client, sleeps } = makeClient({ fetchImpl });
  const result = await client.sendBubbles({
    to: "U1", batch: true,
    bubbles: [{ text: "หนึ่ง", pauseSec: 2 }, { text: "สอง", pauseSec: 4 }, { text: "สาม", pauseSec: 3 }],
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, "ต้องยิงคำขอเดียว");
  assert.deepEqual(calls[0].body.messages.map((m) => m.text), ["หนึ่ง", "สอง", "สาม"],
    "ลูกค้ายังเห็นสามบับเบิลเหมือนเดิม");
  assert.equal(sleeps.length, 0, "ไม่ต้องเว้นช่องไฟ ลูกค้าไม่ได้อยู่หน้าจอ");
});

test("follow-up: เกิน 5 บับเบิลต้องแบ่งก้อน (เพดานของ LINE)", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options?.body || "{}"));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { client } = makeClient({ fetchImpl });
  const bubbles = Array.from({ length: 7 }, (_, i) => ({ text: `บับเบิล ${i + 1}`, pauseSec: 2 }));
  const result = await client.sendBubbles({ to: "U1", batch: true, bubbles });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2, "7 บับเบิล = 2 คำขอ (5 + 2)");
  assert.equal(calls[0].messages.length, 5);
  assert.equal(calls[1].messages.length, 2);
});

test("follow-up: ล้มแล้วต้องล้มทั้งชุด ไม่ทิ้งข้อความครึ่งเดียวไว้กับลูกค้า", async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({ message: "quota" }) });
  const { client } = makeClient({ fetchImpl });
  const result = await client.sendBubbles({
    to: "U1", batch: true,
    bubbles: [{ text: "หนึ่ง", pauseSec: 2 }, { text: "สอง", pauseSec: 2 }],
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.delivered, [], "ไม่มีอะไรถึงมือลูกค้า = ต้องไม่บันทึกว่าส่งแล้ว");
});

test("คุยสด: ยังยิงทีละบับเบิลพร้อมช่องไฟเหมือนเดิม — ห้ามกระทบ", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options?.body || "{}"));
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { client, sleeps } = makeClient({ fetchImpl });
  await client.sendBubbles({
    to: "U1",
    bubbles: [{ text: "หนึ่ง", pauseSec: 2 }, { text: "สอง", pauseSec: 4 }],
  });
  assert.equal(calls.length, 2, "ตอนคุยสดยังทีละบับเบิล");
  assert.equal(sleeps.length, 1, "และยังเว้นช่องไฟระหว่างบับเบิล");
});

test("ตอบสด (มี reply token) ไม่เกี่ยวกับโหมดนี้ — คำขอเดียวอยู่แล้ว", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options?.body || "{}") });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { client } = makeClient({ fetchImpl });
  await client.sendBubbles({
    to: "U1", replyToken: "rt-1",
    bubbles: [{ text: "หนึ่ง", pauseSec: 2 }, { text: "สอง", pauseSec: 2 }],
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.endsWith("/v2/bot/message/reply"));
});
