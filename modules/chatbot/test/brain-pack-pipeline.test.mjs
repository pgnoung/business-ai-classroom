import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import {
  hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig, promptText} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const pack = [
  "LUKPRAE_BRAIN_PACK_JSON_V1",
  JSON.stringify({ entries: [
    {
      id: "agent", titleTh: "AI Agent for Business", answerTh: "รายละเอียดคลาส Agent ค่ะ",
      tags: ["AI Agent for Business"], questionPatterns: [], approvedImageKeys: ["agent-card"],
    },
    {
      id: "workflow", titleTh: "AI Workflow Automation", answerTh: "รายละเอียดคลาส Workflow ค่ะ",
      tags: ["AI Workflow Automation"], questionPatterns: [], approvedImageKeys: ["workflow-card"],
    },
    {
      id: "rice", titleTh: "RICE", answerTh: "ข้อมูล RICE จาก session เก่าค่ะ",
      tags: ["RICE"], questionPatterns: [],
    },
  ] }),
  "END_LUKPRAE_BRAIN_PACK_JSON_V1",
].join("\n");

test("pipeline passes active-session context and only verified image keys to LuKprae retrieval", async () => {
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("รับทราบค่ะ");
  const app = createApp({
    config: testConfig({ BRAND_PACK: pack, HISTORY_TURNS: "6" }),
    db,
    overrides: {
      hermesFetch,
      lineFetch: lineFetchStub(),
      sleep: async () => {},
      imageCatalog: [
        { key: "agent-card", url: "https://img.test/agent.jpg", needsVerification: false },
        { key: "workflow-card", url: "https://img.test/workflow.jpg", needsVerification: true },
      ],
    },
    logger: silent,
  });

  db.upsertCustomer("U-course", {});
  db.insertMessage({ customerId: "U-course", direction: "in", content: "RICE คืออะไร" });
  db.rotateTrainingSession({ customerId: "U-course", resetEventId: "reset-old-rice" });
  db.insertMessage({
    customerId: "U-course", direction: "in",
    content: "สนใจ AI Agent for Business กับ AI Workflow Automation ค่ะ",
  });
  db.insertMessage({ customerId: "U-course", direction: "out", content: "ได้เลยค่ะ" });

  await app.pipeline.handleInboundText({ customerId: "U-course", text: "ส่งรูปคลาสให้ดูหน่อย", replyToken: "rt" });
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.match(system, /รายละเอียดคลาส Agent/u);
  assert.match(system, /รายละเอียดคลาส Workflow/u);
  assert.match(system, /\[IMAGE:agent-card\]/u);
  assert.doesNotMatch(system, /\[IMAGE:workflow-card\]/u, "needsVerification=true must never enter the prompt");
  assert.doesNotMatch(system, /ข้อมูล RICE จาก session เก่า/u, "rotated training session must not affect retrieval");
  db.close();
});

/* -------- LuKprae training handoff 2026-08-12: F2 pending-action end-to-end -------- */

// fixture 2+6: ผู้ช่วยเสนอ "สรุป Workshop ไหมคะ" -> ลูกค้าตอบ "ครับ" ->
// prompt ต้องได้ทั้งการ์ดคอร์สที่ถูกต้อง (ผ่าน fallback retrieval) และกติกาทำต่อทันที
test("F2: 'ครับ' หลังข้อเสนอ -> Sol ได้การ์ดคอร์ส + กติกาทำต่อ ไม่ใช่ context ว่างเปล่า", async () => {
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("สรุปกิจกรรมในคลาสให้เลยนะคะ");
  const app = createApp({
    config: testConfig({ BRAND_PACK: pack, HISTORY_TURNS: "6" }),
    db,
    overrides: {
      hermesFetch,
      lineFetch: lineFetchStub(),
      sleep: async () => {},
      imageCatalog: [{ key: "agent-card", url: "https://img.test/agent.jpg", needsVerification: false }],
    },
    logger: silent,
  });

  db.upsertCustomer("U-ack", {});
  db.insertMessage({ customerId: "U-ack", direction: "in", content: "สนใจคลาส AI Agent for Business ค่ะ ทำ Workshop อะไรบ้าง" });
  db.insertMessage({
    customerId: "U-ack", direction: "out",
    content: "ส่งรูปคลาสให้แล้วนะคะ อยากให้สรุปกิจกรรม Workshop ในคลาส AI Agent for Business ไหมคะ",
  });

  await app.pipeline.handleInboundText({ customerId: "U-ack", text: "ครับ", replyToken: "rt-ack" });
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.match(system, /รายละเอียดคลาส Agent/u, "การ์ดคอร์สต้องเข้า prompt ผ่าน fallback retrieval");
  assert.match(system, /ตอบรับข้อเสนอล่าสุด/u, "กติกา continuation ต้องอยู่ใน rules");
  assert.match(system, /ห้ามบอกให้ลูกค้าเลื่อนกลับไปดูข้อความเก่า/u);
  assert.doesNotMatch(system, /ข้อมูล RICE จาก session เก่า/u, "ห้ามลากเรื่องไม่เกี่ยว");
  db.close();
});

// fixture 3 end-to-end: ผู้ช่วยแค่ยืนยันข้อมูล (ไม่มีข้อเสนอค้าง) -> "ครับ" ต้องได้กติกา
// acknowledge_only — ไม่มีการ์ดคอร์ส/รูป/คำถามคัดกรองแปลกปลอม
test("F2: 'ครับ' หลังประโยคบอกเล่า -> acknowledge_only ไม่มีการ์ด/หัวข้อใหม่", async () => {
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("ยินดีค่ะ");
  const app = createApp({
    config: testConfig({ BRAND_PACK: pack, HISTORY_TURNS: "6" }),
    db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {}, imageCatalog: [] },
    logger: silent,
  });
  db.upsertCustomer("U-ack2", {});
  db.insertMessage({ customerId: "U-ack2", direction: "in", content: "ขอบคุณสำหรับข้อมูลครับ" });
  db.insertMessage({ customerId: "U-ack2", direction: "out", content: "ยินดีค่ะ ทีมงานบันทึกข้อมูลเรียบร้อยแล้วนะคะ" });

  await app.pipeline.handleInboundText({ customerId: "U-ack2", text: "โอเคครับ", replyToken: "rt-ack2" });
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.match(system, /ตอบรับ\/ขอบคุณเฉย ๆ/u, "กติกา acknowledge_only ต้องอยู่");
  assert.doesNotMatch(system, /รายละเอียดคลาส Agent|รายละเอียดคลาส Workflow/u, "ห้ามเดา topic คอร์สใหม่");
  db.close();
});

/* -------- v1.2.1 (เคสลูกแพร): ลูกค้าขอดูรูปซ้ำ = ต้องส่ง ไม่ใช่ปฏิเสธ -------- */

test("ลูกค้าขอรูปอีกครั้ง -> dedupe ปลดล็อก รูปที่เคยส่งแล้วถูกส่งซ้ำได้", async () => {
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("ส่งรูปให้อีกครั้งเลยค่ะ [IMAGE:agent-card]");
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig({ BRAND_PACK: pack, HISTORY_TURNS: "6" }),
    db,
    overrides: {
      hermesFetch, lineFetch, sleep: async () => {},
      imageCatalog: [{ key: "agent-card", url: "https://img.test/agent.jpg", needsVerification: false }],
    },
    logger: silent,
  });
  db.upsertCustomer("U-resend", {});
  // เคยส่งรูปนี้ไปแล้ว (อยู่ในหน้าต่าง dedupe 7 วัน)
  db.insertMessage({ customerId: "U-resend", direction: "out", msgType: "image", content: "[image:agent-card] https://img.test/agent.jpg" });

  const result = await app.pipeline.handleInboundText({ customerId: "U-resend", text: "ขอดูรูปคลาสอีกครั้งได้ไหมคะ", replyToken: "rt-img" });
  assert.equal(result.sent, true);
  assert.deepEqual(result.imageKeys, ["agent-card"], "ขอเอง = ส่งซ้ำได้");
  // กติกาใน prompt ต้องบอกชัดว่าห้ามปฏิเสธ
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.match(system, /ห้ามตอบว่าเคยส่งไปแล้ว/u);
  db.close();
});

test("โมเดลใส่รูปซ้ำเองโดยลูกค้าไม่ได้ขอ -> dedupe ยังตัดเหมือนเดิม", async () => {
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("รายละเอียดเพิ่มเติมค่ะ [IMAGE:agent-card]");
  const app = createApp({
    config: testConfig({ BRAND_PACK: pack, HISTORY_TURNS: "6" }),
    db,
    overrides: {
      hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {},
      imageCatalog: [{ key: "agent-card", url: "https://img.test/agent.jpg", needsVerification: false }],
    },
    logger: silent,
  });
  db.upsertCustomer("U-noresend", {});
  db.insertMessage({ customerId: "U-noresend", direction: "out", msgType: "image", content: "[image:agent-card] https://img.test/agent.jpg" });

  const result = await app.pipeline.handleInboundText({ customerId: "U-noresend", text: "แล้วคลาสนี้เหมาะกับใครคะ", replyToken: "rt-noimg" });
  assert.equal(result.sent, true);
  assert.deepEqual(result.imageKeys, [], "ไม่ได้ขอ = กันรูปซ้ำตามเดิม");
  db.close();
});
