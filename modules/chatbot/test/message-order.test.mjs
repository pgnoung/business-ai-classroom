// FEEDBACK 2026-08-10: จบด้วยรูปแล้วลูกค้าเงียบ — คำถามต้องเป็นข้อความสุดท้ายเสมอ
import test from "node:test";
import assert from "node:assert/strict";
import { createLineClient } from "../src/lineClient.mjs";
import { poisonGlobalFetch, testConfig, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function client(lineFetch) {
  return createLineClient({
    config: testConfig({ LINE_MOCK_URL: "http://mock.local" }),
    fetchImpl: lineFetch,
    sleep: async () => {},
    logger: silent,
  });
}

const IMAGES = [
  { url: "https://img.local/a.jpg", previewUrl: "https://img.local/a_p.jpg" },
  { url: "https://img.local/b.jpg", previewUrl: "https://img.local/b_p.jpg" },
];

test("ลำดับส่ง: bubble สุดท้ายเป็นคำถาม -> รูปมาก่อน คำถามปิดท้าย", async () => {
  const lineFetch = lineFetchStub();
  await client(lineFetch).sendBubbles({
    to: "U1", replyToken: "rt",
    bubbles: ["X3Pro เหมาะกับห้อง 30 ตร.ม. ค่ะ", "สนใจรับโปรนี้ไหมคะ"],
    images: IMAGES,
  });
  const types = lineFetch.sends[0].body.messages.map((m) => m.type);
  assert.deepEqual(types, ["text", "image", "image", "text"]);
  assert.match(lineFetch.sends[0].body.messages.at(-1).text, /ไหมคะ$/u);
});

test("ลำดับส่ง: ไม่ได้จบด้วยคำถาม -> ลำดับเดิม text แล้วรูป", async () => {
  const lineFetch = lineFetchStub();
  await client(lineFetch).sendBubbles({
    to: "U1", replyToken: "rt",
    bubbles: ["ส่งรูปให้ดูก่อนนะคะ"],
    images: IMAGES,
  });
  const types = lineFetch.sends[0].body.messages.map((m) => m.type);
  assert.deepEqual(types, ["text", "image", "image"]);
});
