// B3: ข้อความเสียง — createTranscriber (unit) + เส้นทาง pipeline เต็ม (integration)
// กติกาเหล็ก: ห้ามแตะ network จริง — stub fetch ทุกจุด
import test from "node:test";
import assert from "node:assert/strict";
import { createTranscriber } from "../src/transcribe.mjs";
import { createApp } from "../src/server.mjs";
import { AUDIO_FALLBACK_TEMPLATE } from "../src/pipeline.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

// stub fetch ของ transcriber: แยกทางด้วย URL — LINE content vs OpenAI transcription
function transcribeFetchStub({
  audioBytes = new Uint8Array([1, 2, 3, 4]),
  audioStatus = 200,
  audioHeaders = { "content-type": "audio/m4a", "content-length": "4" },
  openaiStatus = 200,
  openaiText = "สวัสดีค่ะ สนใจเครื่องฟอกอากาศรุ่นเล็กค่ะ",
} = {}) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (u.includes("/v2/bot/message/") && u.endsWith("/content")) {
      return {
        ok: audioStatus >= 200 && audioStatus < 300,
        status: audioStatus,
        headers: { get: (k) => audioHeaders[k.toLowerCase()] ?? null },
        arrayBuffer: async () => audioBytes.buffer.slice(0),
      };
    }
    if (u.endsWith("/audio/transcriptions")) {
      return {
        ok: openaiStatus >= 200 && openaiStatus < 300,
        status: openaiStatus,
        json: async () => ({ text: openaiText }),
      };
    }
    throw new Error(`URL ไม่คาดคิดในเทสต์: ${u}`);
  };
  fn.calls = calls;
  fn.lineCalls = () => calls.filter((c) => c.url.includes("/v2/bot/message/"));
  fn.openaiCalls = () => calls.filter((c) => c.url.endsWith("/audio/transcriptions"));
  return fn;
}

const keyedConfig = (overrides = {}) => testConfig({ OPENAI_API_KEY: "sk-test", ...overrides });

/* ---------------------------------- unit ----------------------------------- */

test("B3 unit: happy path — โหลดจาก LINE mock -> multipart -> ได้ text ถอดความ", async () => {
  const fetchImpl = transcribeFetchStub();
  const tx = createTranscriber({ config: keyedConfig(), fetchImpl, logger: silent });
  assert.equal(tx.enabled, true);

  const result = await tx.transcribe({ messageId: "aud-1" });
  assert.equal(result.ok, true);
  assert.equal(result.text, "สวัสดีค่ะ สนใจเครื่องฟอกอากาศรุ่นเล็กค่ะ");

  const lineCall = fetchImpl.lineCalls()[0];
  assert.ok(lineCall.url.startsWith("http://line.mock/v2/bot/message/aud-1/content"), "mock URL แทน api-data");
  const openaiCall = fetchImpl.openaiCalls()[0];
  assert.equal(openaiCall.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(openaiCall.opts.headers.authorization, "Bearer sk-test");
  assert.ok(openaiCall.opts.headers["content-type"].startsWith("multipart/form-data; boundary="));
  const body = openaiCall.opts.body.toString("utf8");
  assert.ok(body.includes('name="model"') && body.includes("whisper-1"), "field model");
  assert.ok(body.includes('name="language"') && body.includes("th"), "field language th");
  assert.ok(body.includes('name="file"'), "field file");
});

test("B3 unit: TRANSCRIBE_MODEL + OPENAI_BASE override ได้จาก env", async () => {
  const fetchImpl = transcribeFetchStub();
  const tx = createTranscriber({
    config: keyedConfig({ TRANSCRIBE_MODEL: "whisper-large-v3", OPENAI_BASE: "http://openai.mock/v1/" }),
    fetchImpl, logger: silent,
  });
  await tx.transcribe({ messageId: "aud-2" });
  const openaiCall = fetchImpl.openaiCalls()[0];
  assert.equal(openaiCall.url, "http://openai.mock/v1/audio/transcriptions");
  assert.ok(openaiCall.opts.body.toString("utf8").includes("whisper-large-v3"));
});

test("B3 unit: ไม่มี OPENAI_API_KEY -> no_api_key โดยไม่ fetch เลย", async () => {
  const fetchImpl = transcribeFetchStub();
  const tx = createTranscriber({ config: testConfig(), fetchImpl, logger: silent });
  assert.equal(tx.enabled, false);
  const result = await tx.transcribe({ messageId: "aud-3" });
  assert.deepEqual(result, { ok: false, reason: "no_api_key" });
  assert.equal(fetchImpl.calls.length, 0);
});

test("B3 unit: fail-closed — ไม่มี mock + live ปิด -> line_blocked โดยไม่ fetch", async () => {
  const fetchImpl = transcribeFetchStub();
  const tx = createTranscriber({
    config: keyedConfig({ LINE_MOCK_URL: "", LINE_LIVE_SEND: "false" }),
    fetchImpl, logger: silent,
  });
  const result = await tx.transcribe({ messageId: "aud-4" });
  assert.equal(result.reason, "line_blocked");
  assert.equal(fetchImpl.calls.length, 0);
});

test("B3 unit: ทุกโหมดล้มเหลวคืน reason ชัด — download 500 / ไฟล์ใหญ่ / openai 500 / text ว่าง", async () => {
  const cases = [
    [{ audioStatus: 500 }, "download_http_500"],
    [{ audioHeaders: { "content-type": "audio/m4a", "content-length": String(20 * 1024 * 1024) } }, "audio_too_large"],
    [{ audioBytes: new Uint8Array(0), audioHeaders: { "content-type": "audio/m4a" } }, "audio_empty"],
    [{ openaiStatus: 500 }, "transcribe_http_500"],
    [{ openaiText: "   " }, "empty_transcript"],
  ];
  for (const [options, reason] of cases) {
    const tx = createTranscriber({ config: keyedConfig(), fetchImpl: transcribeFetchStub(options), logger: silent });
    const result = await tx.transcribe({ messageId: "aud-x" });
    assert.equal(result.ok, false, reason);
    assert.equal(result.reason, reason);
  }
});

test("B3 unit: network พัง (fetch โยน) -> download_failed ไม่มี throw หลุด", async () => {
  const tx = createTranscriber({
    config: keyedConfig(),
    fetchImpl: async () => { throw new TypeError("fetch failed"); },
    logger: silent,
  });
  const result = await tx.transcribe({ messageId: "aud-err" });
  assert.equal(result.reason, "download_failed");
});

/* ------------------------------- integration -------------------------------- */

function makeVoiceApp({ configOverrides = {}, transcribeFetch, hermesFetch, lineFetch } = {}) {
  const config = testConfig({ OPENAI_API_KEY: "sk-test", ...configOverrides });
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  const hermes = hermesFetch ?? hermesFetchStub();
  const line = lineFetch ?? lineFetchStub();
  const app = createApp({
    config, db,
    overrides: {
      hermesFetch: hermes, lineFetch: line, sleep: async () => {},
      transcribeFetch: transcribeFetch ?? transcribeFetchStub(),
    },
    logger: silent,
  });
  return { app, db, hermesFetch: hermes, lineFetch: line };
}

const audioEvent = (userId, messageId) => ({
  type: "message", replyToken: `rt-${messageId}`,
  source: { userId },
  message: { id: messageId, type: "audio" },
});

test("B3: happy path — เสียงถูกถอดความ log inbound แล้ววิ่ง pipeline text ปกติ", async () => {
  const { app, db, hermesFetch, lineFetch } = makeVoiceApp();
  const result = await app.pipeline.handleEvent(audioEvent("U-voice", "aud-10"));
  assert.equal(result.sent, true, "ต้องได้ reply ปกติ");

  const inbound = db.messagesFor("U-voice").filter((m) => m.direction === "in");
  assert.ok(inbound.some((m) => m.content.startsWith("[เสียงถอดความ] สวัสดีค่ะ")), "transcript ต้องถูก log");
  // pipeline วิ่งด้วยข้อความถอดความ (ไม่ใช่ template)
  const userText = hermesFetch.calls[0].body.messages.at(-1).content;
  assert.equal(userText, "สวัสดีค่ะ สนใจเครื่องฟอกอากาศรุ่นเล็กค่ะ");
  assert.ok(lineFetch.sends.length >= 1);
  const allText = lineFetch.sends.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(!allText.includes("ยังฟังข้อความเสียงไม่ชัด"), "ห้ามส่ง template ล้มเหลว");
  db.close();
});

test("B3: ถอดความพัง (openai 500) -> template สุภาพ + ธง audio_review", async () => {
  const { app, db, hermesFetch, lineFetch } = makeVoiceApp({
    transcribeFetch: transcribeFetchStub({ openaiStatus: 500 }),
  });
  const result = await app.pipeline.handleEvent(audioEvent("U-voice-f", "aud-11"));
  assert.equal(result.sent, true);
  assert.equal(result.route, "audio_fallback");
  assert.equal(hermesFetch.calls.length, 0, "ห้ามเรียก Hermes เมื่อไม่มี transcript");

  const allText = lineFetch.sends.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(allText.includes("ยังฟังข้อความเสียงไม่ชัด"));
  const customer = db.getCustomer("U-voice-f");
  assert.equal(customer.state, "NEEDS_HUMAN");
  assert.ok(customer.handoff_summary.includes("audio_review"));
  // template ที่ log ต้องเป็น agent_mode ai
  const out = db.messagesFor("U-voice-f").filter((m) => m.direction === "out");
  assert.equal(out[0].content, AUDIO_FALLBACK_TEMPLATE);
  assert.equal(out[0].agent_mode, "ai");
  db.close();
});

test("B3: ไม่มี OPENAI_API_KEY -> template + ธง โดยไม่ยิง transcribe fetch เลย", async () => {
  const transcribeFetch = transcribeFetchStub();
  const { app, db, lineFetch } = makeVoiceApp({
    configOverrides: { OPENAI_API_KEY: "" },
    transcribeFetch,
  });
  const result = await app.pipeline.handleEvent(audioEvent("U-voice-nk", "aud-12"));
  assert.equal(result.sent, true);
  assert.equal(transcribeFetch.calls.length, 0);
  const allText = lineFetch.sends.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(allText.includes("ยังฟังข้อความเสียงไม่ชัด"));
  assert.equal(db.getCustomer("U-voice-nk").state, "NEEDS_HUMAN");
  db.close();
});

test("B3: AI ปิดอยู่ -> ไม่ส่ง template แต่ธง audio_review ยังติด", async () => {
  const { app, db, lineFetch } = makeVoiceApp({
    transcribeFetch: transcribeFetchStub({ openaiStatus: 500 }),
  });
  db.upsertCustomer("U-voice-off", {});
  db.setAiEnabled("U-voice-off", false);
  const result = await app.pipeline.handleEvent(audioEvent("U-voice-off", "aud-13"));
  assert.equal(result.suppressed, "ai_disabled");
  assert.equal(lineFetch.calls.length, 0, "AI ปิด = เงียบ (Fern control gate)");
  assert.equal(db.getCustomer("U-voice-off").state, "NEEDS_HUMAN", "ธงรอคนต้องติดเสมอ");
  db.close();
});
