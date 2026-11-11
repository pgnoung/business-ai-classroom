// hermes bridge (fallback ครบ 5 กรณี) + humanizer + line client
import test from "node:test";
import assert from "node:assert/strict";
import { createHermesBridge, IMAGE_CLASSIFY_FALLBACK_MAX_WAIT_MS } from "../src/hermesBridge.mjs";
import { createHumanizer, stripAiTells, splitIntoBubbles, pauseSecondsForBubble, isComplexMaterial, formatLeadQuestion, ensurePoliteEnding, restoreKeycapLineBreaks } from "../src/humanizer.mjs";
import { createLineClient, verifyLineSignature } from "../src/lineClient.mjs";
import { hasMaleParticle } from "../src/personaParticles.mjs";
import { createHash } from "node:crypto";
import { poisonGlobalFetch, testConfig, hermesFetchStub, lineFetchStub, signLine } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { warn: () => {}, error: () => {} };

/* ------------------------------- hermes bridge ----------------------------- */

test("hermes: กรณีปกติ — คืน text + usage และยิงเข้า /chat/completions เท่านั้น", async () => {
  const fetchStub = hermesFetchStub("สวัสดีค่ะ ยินดีดูแลนะคะ");
  const bridge = createHermesBridge({ config: testConfig(), fetchImpl: fetchStub, logger: silent });
  const result = await bridge.draftReply({
    persona: "persona",
    history: [{ role: "user", content: "ก่อนหน้า" }],
    userText: "สวัสดีครับ",
  });
  assert.equal(result.text, "สวัสดีค่ะ ยินดีดูแลนะคะ");
  assert.ok(result.usage);
  assert.equal(fetchStub.calls.length, 1);
  assert.equal(fetchStub.calls[0].url, "http://hermes.test/v1/chat/completions"); // ห้าม /responses
  const body = fetchStub.calls[0].body;
  assert.equal(body.messages.at(-1).content, "สวัสดีครับ");
  assert.equal(body.messages[0].role, "system"); // inject brand+persona+กติกา
});

test("hermes: ระดับการคิดของร่างตอบ/ติดตามมาจาก HERMES_REPLY_REASONING_EFFORT — ว่าง = ไม่ส่ง (พรอมต์เดิมทุกไบต์)", async () => {
  const plain = hermesFetchStub();
  await createHermesBridge({ config: testConfig(), fetchImpl: plain, logger: silent }).draftReply({ userText: "x" });
  assert.equal(Object.hasOwn(plain.calls[0].body, "reasoning_effort"), false);
  const high = hermesFetchStub();
  const bridge = createHermesBridge({ config: { ...testConfig(), hermesReplyReasoningEffort: "high" }, fetchImpl: high, logger: silent });
  await bridge.draftReply({ userText: "x" });
  await bridge.draftReply({ userText: "y", role: "followup" });
  assert.deepEqual(high.calls.map((call) => call.body.reasoning_effort), ["high", "high"]);
});

// 2026-10-01: 6.1 Sol ตอบ 500 กับรูปราว 6% — ต้องลองซ้ำด้วยรุ่นสำรองหนึ่งครั้ง ไม่งั้นรูปธรรมดาปิด AI ทั้งห้อง
function imageFetchSequence(responses) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next === "throw") throw new Error("socket hang up");
    return typeof next === "number"
      ? { ok: false, status: next, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: next } }], usage: { prompt_tokens: 900, completion_tokens: 20 } }) };
  };
  fn.calls = calls;
  return fn;
}
const IMAGE_MESSAGES = [{ role: "user", content: [{ type: "text", text: "รูปนี้คืออะไร" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==" } }] }];
const imageConfig = (overrides = {}) => testConfig({
  IMAGE_CLASSIFY_MODEL: "gpt-6.1-sol", IMAGE_CLASSIFY_FALLBACK_MODEL: "gpt-5.6-sol",
  HERMES_ALLOWED_MODELS: "gpt-6.1-sol,gpt-5.6-sol", ...overrides,
});
const OTHER = JSON.stringify({ kind: "other", description: "ภาพเมนูอาหาร" });

test("image-classify: ตัวหลักตอบได้ = ยิงครั้งเดียวด้วยตัวหลัก", async () => {
  const stub = imageFetchSequence([OTHER]);
  const bridge = createHermesBridge({ config: imageConfig(), fetchImpl: stub, logger: silent });
  assert.equal(await bridge.classifyImageMessages(IMAGE_MESSAGES), OTHER);
  assert.deepEqual(stub.calls.map((c) => [c.body.model, c.body.max_completion_tokens]), [["gpt-6.1-sol", 300]]);
});

test("image-classify: ตัวหลักล้มชั่วคราว (500/429/เน็ตหลุด) = ลองซ้ำด้วยรุ่นสำรองหนึ่งครั้ง", async () => {
  for (const failure of [500, 502, 429, "throw"]) {
    const stub = imageFetchSequence([failure, OTHER]);
    const bridge = createHermesBridge({ config: imageConfig(), fetchImpl: stub, logger: silent });
    assert.equal(await bridge.classifyImageMessages(IMAGE_MESSAGES), OTHER, String(failure));
    assert.deepEqual(stub.calls.map((c) => c.body.model), ["gpt-6.1-sol", "gpt-5.6-sol"], String(failure));
    assert.equal(stub.calls[1].body.max_completion_tokens, 300);
  }
});

test("image-classify: ไม่ลองซ้ำเมื่อถูกปฏิเสธถาวร / ไม่มีรุ่นสำรอง / รุ่นสำรองซ้ำตัวหลักหรือไม่อยู่ในรายการ — fail-closed เหมือนเดิม", async () => {
  const cases = [
    [imageConfig(), [400, OTHER]],
    [imageConfig({ IMAGE_CLASSIFY_FALLBACK_MODEL: "" }), [500, OTHER]],
    [imageConfig({ IMAGE_CLASSIFY_FALLBACK_MODEL: "gpt-6.1-sol" }), [500, OTHER]],
    [imageConfig({ HERMES_ALLOWED_MODELS: "gpt-6.1-sol,gpt-5.6-luna" }), [500, OTHER]],
  ];
  for (const [config, responses] of cases) {
    const stub = imageFetchSequence(responses);
    const bridge = createHermesBridge({ config, fetchImpl: stub, logger: silent });
    assert.equal(await bridge.classifyImageMessages(IMAGE_MESSAGES), "");
    assert.equal(stub.calls.length, 1);
  }
  // คำตอบมาแต่ว่าง = ไม่ใช่ความล้มของผู้ให้บริการ ไม่ลองซ้ำ
  const empty = imageFetchSequence(["", OTHER]);
  assert.equal(await createHermesBridge({ config: imageConfig(), fetchImpl: empty, logger: silent }).classifyImageMessages(IMAGE_MESSAGES), "");
  assert.equal(empty.calls.length, 1);
});

test("image-classify: ตัวหลักล้มหลังรอนาน (เกิน IMAGE_CLASSIFY_FALLBACK_MAX_WAIT_MS) = ไม่ลองซ้ำ ห้องไม่ต้องรอสองเท่า", async () => {
  const realNow = Date.now;
  const start = realNow();
  const stub = imageFetchSequence([504, OTHER]);
  const slow = async (url, opts) => { Date.now = () => start + IMAGE_CLASSIFY_FALLBACK_MAX_WAIT_MS + 1; return stub(url, opts); };
  try {
    Date.now = () => start;
    const bridge = createHermesBridge({ config: imageConfig(), fetchImpl: slow, logger: silent });
    assert.equal(await bridge.classifyImageMessages(IMAGE_MESSAGES), "");
  } finally {
    Date.now = realNow;
  }
  assert.equal(stub.calls.length, 1);
});

test("image-classify: รุ่นสำรองล้มด้วย = คืนว่าง (ตัวจำแนก fail-closed เป็น unknown) และไม่ลองรอบสาม", async () => {
  const stub = imageFetchSequence([500, 500, OTHER]);
  const bridge = createHermesBridge({ config: imageConfig(), fetchImpl: stub, logger: silent });
  assert.equal(await bridge.classifyImageMessages(IMAGE_MESSAGES), "");
  assert.equal(stub.calls.length, 2);
});

test("hermes: HTTP error (500) -> null", async () => {
  const bridge = createHermesBridge({
    config: testConfig(),
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    logger: silent,
  });
  assert.equal(await bridge.draftReply({ userText: "x" }), null);
});

test("hermes: bad JSON -> null", async () => {
  const bridge = createHermesBridge({
    config: testConfig(),
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("unexpected token");
      },
    }),
    logger: silent,
  });
  assert.equal(await bridge.draftReply({ userText: "x" }), null);
});

test("hermes: network down (fetch reject) -> null", async () => {
  const bridge = createHermesBridge({
    config: testConfig(),
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
    logger: silent,
  });
  assert.equal(await bridge.draftReply({ userText: "x" }), null);
});

test("hermes: timeout (AbortSignal.timeout) -> null", async () => {
  const config = testConfig({ HERMES_TIMEOUT_MS: "30" });
  const bridge = createHermesBridge({
    config,
    // stub ที่แขวนจนโดน abort — เคารพ signal เหมือน fetch จริง
    fetchImpl: (url, opts) =>
      new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () => reject(opts.signal.reason));
      }),
    logger: silent,
  });
  // AbortSignal.timeout ใช้ timer แบบ unref — ต้องมี timer จริงถือ event loop ไว้ระหว่างรอ
  const keepAlive = setTimeout(() => {}, 5000);
  const start = Date.now();
  assert.equal(await bridge.draftReply({ userText: "x" }), null);
  assert.ok(Date.now() - start < 2000, "ต้อง abort ที่ ~30ms ไม่ใช่แขวนยาว");
  clearTimeout(keepAlive);
});

test("hermes: caller abort signal preempts the provider timeout", async () => {
  const config = testConfig({ HERMES_TIMEOUT_MS: "80" });
  let providerSignal = null;
  const warnings = [];
  const bridge = createHermesBridge({
    config,
    fetchImpl: (url, opts) => {
      providerSignal = opts.signal;
      return new Promise((_, reject) => {
        opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
      });
    },
    logger: { ...silent, warn: (message) => warnings.push(message), debug: () => {} },
  });
  const controller = new AbortController();
  const reason = new Error("priority safety message arrived");
  const keepAlive = setTimeout(() => {}, 1000);
  const pending = bridge.draftReply({ userText: "x", signal: controller.signal });
  controller.abort(reason);

  try {
    assert.equal(await pending, null);
    assert.equal(providerSignal?.reason, reason, "provider fetch must observe the caller abort, not wait for timeout");
    assert.deepEqual(warnings, [], "intentional cancellation must not look like provider instability");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("hermes: JSON ไม่มี choices ที่ใช้ได้ -> null", async () => {
  const bridge = createHermesBridge({
    config: testConfig(),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [] }) }),
    logger: silent,
  });
  assert.equal(await bridge.draftReply({ userText: "x" }), null);
});

test("hermes: ไม่มี HERMES_BASE -> null โดยไม่ยิง fetch (fail-closed)", async () => {
  let called = 0;
  const bridge = createHermesBridge({
    config: testConfig({ HERMES_BASE: "" }),
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200, json: async () => ({}) };
    },
    logger: silent,
  });
  assert.equal(await bridge.draftReply({ userText: "x" }), null);
  assert.equal(called, 0);
});

test("hermes: final outbound boundary ซ่อม malformed surrogate ทุกข้อความก่อน JSON", async () => {
  const loneSurrogate = "\uD83D";
  const fetchStub = hermesFetchStub("ได้ค่ะ");
  const bridge = createHermesBridge({ config: testConfig(), fetchImpl: fetchStub, logger: silent });
  await bridge.draftReply({
    knowledge: loneSurrogate,
    persona: loneSurrogate,
    brandPack: loneSurrogate,
    rules: loneSurrogate,
    history: [{ role: "user", content: loneSurrogate }],
    userText: loneSurrogate,
  });
  const body = fetchStub.calls[0].body;
  for (const message of body.messages) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) assert.equal(block.text.isWellFormed(), true);
    } else {
      assert.equal(message.content.isWellFormed(), true);
    }
  }
});

test("hermes learning: uses scorer allowlist and caps completion at 1,500 tokens", async () => {
  const fetchStub = hermesFetchStub('{"clusters":[]}');
  const bridge = createHermesBridge({
    config: testConfig({
      HERMES_ALLOWED_MODELS: "gpt-learning-safe,gpt-other",
      HERMES_SCORER_ALLOWED_MODELS: "gpt-learning-safe",
    }),
    fetchImpl: fetchStub,
    logger: silent,
  });
  const result = await bridge.scoreLearning({
    system: "JSON only", transcript: "signals", model: "gpt-learning-safe", maxCompletionTokens: 9_999,
  });
  assert.equal(result.text, '{"clusters":[]}');
  assert.equal(fetchStub.calls.length, 1);
  assert.equal(fetchStub.calls[0].body.model, "gpt-learning-safe");
  assert.equal(fetchStub.calls[0].body.max_completion_tokens, 1_500);
  assert.equal(fetchStub.calls[0].body.prompt_cache_key, "lukprae-hermes-learning");

  const blocked = await bridge.scoreLearning({
    system: "x", transcript: "y", model: "gpt-other", maxCompletionTokens: 100,
  });
  assert.equal(blocked, null);
  assert.equal(fetchStub.calls.length, 1, "disallowed learning model must not reach provider");
});

/* -------------------------------- humanizer -------------------------------- */

test("humanizer: ตัด markdown / bullet / เลขข้อ ออกหมด", () => {
  const cleaned = stripAiTells("### หัวข้อ\n**สำคัญมาก** นะคะ\n- ข้อหนึ่ง\n- ข้อสอง\n1. ข้อสาม");
  assert.ok(!cleaned.includes("**"));
  assert.ok(!cleaned.includes("###"));
  assert.ok(!/^\s*-\s/m.test(cleaned));
  assert.ok(!/^\s*1\.\s/m.test(cleaned));
});

test("humanizer: ภาษาราชการถูกแปลงเป็นภาษาแชท", () => {
  const cleaned = stripAiTells("กรุณารอสักครู่ หากมีข้อสงสัยเพิ่มเติมไม่ต้องลังเลที่จะสอบถาม");
  assert.ok(!cleaned.includes("กรุณา"));
  assert.ok(cleaned.includes("รบกวน"));
  assert.ok(cleaned.includes("ทักมาได้เลย"));
});

test("humanizer: ข้อความยาวแตกไม่เกิน 3 bubbles", () => {
  const longText =
    "ขอบคุณที่สอบถามเข้ามานะคะ สำหรับคอร์สดูแลผิวของทางเรามีให้เลือกหลายแบบเลยค่ะ " +
    "แต่ละแบบเหมาะกับสภาพผิวไม่เหมือนกันนะคะ แนะนำให้เข้ามาปรึกษาก่อนได้ค่ะ " +
    "ทีมงานจะช่วยประเมินสภาพผิวให้ก่อนเริ่มโปรแกรมค่ะ ไม่มีค่าใช้จ่ายในการปรึกษานะคะ " +
    "สะดวกช่วงไหนแจ้งได้เลยค่ะ เดี๋ยวเช็คคิวให้นะคะ";
  const bubbles = splitIntoBubbles(longText);
  assert.ok(bubbles.length >= 2, "ข้อความยาวควรแตกหลาย bubble");
  assert.ok(bubbles.length <= 3, `ต้องไม่เกิน 3 bubbles ได้ ${bubbles.length}`);
});

test("humanizer: ข้อความสั้นอยู่ bubble เดียว", () => {
  assert.deepEqual(splitIntoBubbles("ได้เลยค่ะ"), ["ได้เลยค่ะ"]);
});

test("humanizer: acknowledgement สั้นไม่ถูกแยกเป็น bubble เปล่า ๆ ก่อนคำตอบ", () => {
  const text = "ได้ค่ะ รายละเอียดส่วนนี้แพรจะสรุปให้เห็นภาพแบบใช้งานจริงก่อนนะคะ จากนั้นค่อยเลือกวิธีที่เหมาะกับงานของทีมโดยไม่ต้องรีบตัดสินใจค่ะ ขั้นแรกดูจากงานที่ทำซ้ำบ่อยที่สุดได้เลยค่ะ";
  const bubbles = splitIntoBubbles(text);
  assert.ok(bubbles.length >= 1 && bubbles.length <= 3);
  assert.notEqual(bubbles[0], "ได้ค่ะ");
  assert.match(bubbles[0], /^ได้ค่ะ\s+รายละเอียด/u);
});

test("humanizer: opener ไม่ซ้ำกับ reply ก่อนหน้า (ต่อ customer)", () => {
  const humanizer = createHumanizer();
  const first = humanizer.humanize({ customerId: "U1", text: "ได้เลยค่ะ เดี๋ยวจัดการให้นะคะ" });
  assert.ok(first[0].text.startsWith("ได้เลยค่ะ"));
  const second = humanizer.humanize({ customerId: "U1", text: "ได้เลยค่ะ เดี๋ยวเช็คคิวให้นะคะ" });
  assert.ok(!second[0].text.startsWith("ได้เลยค่ะ"), `เปิดซ้ำ: ${second[0].text}`);
  // คนละ customer ไม่กระทบกัน
  const other = humanizer.humanize({ customerId: "U2", text: "ได้เลยค่ะ เดี๋ยวจัดการให้นะคะ" });
  assert.ok(other[0].text.startsWith("ได้เลยค่ะ"));
});

test("humanizer: bubble สุดท้ายลงท้ายสุภาพ + pause อยู่ในกรอบ 2-9 วิ", () => {
  const humanizer = createHumanizer();
  const bubbles = humanizer.humanize({ customerId: "U9", text: "โอเค เดี๋ยวส่งรายละเอียดให้" });
  assert.ok(/[ค่ะคะครับ]$/u.test(bubbles.at(-1).text.trim()));
  for (const bubble of bubbles) {
    assert.ok(bubble.pauseSec >= 2 && bubble.pauseSec <= 9);
  }
  assert.equal(pauseSecondsForBubble("", 0) >= 2, true);
});

test("humanizer: ช่องว่างก่อน ? ในคำถามไทยไม่ทำให้ ? หลุดเป็นบับเบิลเดี่ยว", () => {
  const humanizer = createHumanizer();
  const bubbles = humanizer.humanize({
    customerId: "synthetic-spaced-question",
    text: "มีเรื่องไหนอยากให้ลูกแพรช่วยอธิบายเพิ่มเติมคะ ?",
  });
  assert.deepEqual(bubbles.map((bubble) => bubble.text), [
    "มีเรื่องไหนอยากให้ลูกแพรช่วยอธิบายเพิ่มเติมคะ?",
  ]);
  assert.ok(bubbles.every((bubble) => !/^[?？]$/u.test(bubble.text)));
});

/* -------------------------------- line client ------------------------------ */

test("line: verify HMAC จาก raw body — ถูก/ผิด", () => {
  const raw = Buffer.from(JSON.stringify({ events: [] }));
  const good = signLine(raw, "secret-1");
  assert.equal(verifyLineSignature(raw, good, "secret-1"), true);
  assert.equal(verifyLineSignature(raw, good, "secret-2"), false);
  assert.equal(verifyLineSignature(raw, "ปลอม", "secret-1"), false);
  assert.equal(verifyLineSignature(raw, good, ""), false);
});

test("line: fail-closed — LINE_LIVE_SEND=false และไม่มี mock = ไม่ยิงอะไรเลย", async () => {
  let called = 0;
  const client = createLineClient({
    config: testConfig({ LINE_MOCK_URL: "", LINE_LIVE_SEND: "false" }),
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200 };
    },
    logger: silent,
  });
  const result = await client.sendBubbles({ to: "U1", bubbles: [{ text: "ทดสอบ" }] });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "live_send_disabled");
  assert.equal(called, 0);
});

test("line: มี replyToken + <=5 bubbles = ใช้ reply ครั้งเดียว", async () => {
  const fetchStub = lineFetchStub();
  const client = createLineClient({ config: testConfig(), fetchImpl: fetchStub, logger: silent });
  const result = await client.sendBubbles({
    to: "U1",
    replyToken: "rt-1",
    bubbles: [{ text: "หนึ่ง" }, { text: "สอง" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "reply");
  assert.deepEqual(result.acceptedRequestMessages.map((message) => message.type), ["text", "text"]);
  assert.equal(fetchStub.calls.length, 1);
  assert.ok(fetchStub.calls[0].url.endsWith("/v2/bot/message/reply"));
  assert.equal(fetchStub.calls[0].body.messages.length, 2);
});

test("line: เกิน 5 bubbles = push รายบับเบิล (reply จำกัด 5/call)", async () => {
  const fetchStub = lineFetchStub();
  const sleeps = [];
  const client = createLineClient({
    config: testConfig(),
    fetchImpl: fetchStub,
    sleep: async (ms) => sleeps.push(ms),
    logger: silent,
  });
  const bubbles = Array.from({ length: 6 }, (_, i) => ({ text: `บับเบิล ${i + 1}`, pauseSec: 3 }));
  const result = await client.sendBubbles({ to: "U1", replyToken: "rt-1", bubbles });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "push");
  assert.equal(result.calls, 6);
  assert.equal(result.acceptedRequestMessages.length, 6);
  assert.ok(fetchStub.calls.every((c) => c.url.endsWith("/v2/bot/message/push")));
  assert.equal(sleeps.length, 5, "ต้องมี send-delay ระหว่าง bubble");
});

test("line: ไม่มี replyToken = push พร้อม delay ระหว่าง bubble", async () => {
  const fetchStub = lineFetchStub();
  const sleeps = [];
  const client = createLineClient({
    config: testConfig(),
    fetchImpl: fetchStub,
    sleep: async (ms) => sleeps.push(ms),
    logger: silent,
  });
  const result = await client.sendBubbles({
    to: "U1",
    bubbles: [{ text: "หนึ่ง", pauseSec: 2 }, { text: "สอง", pauseSec: 4 }],
  });
  assert.equal(result.mode, "push");
  assert.deepEqual(result.acceptedRequestMessages.map((message) => message.text), ["หนึ่ง", "สอง"]);
  assert.equal(sleeps.length, 1);
  assert.equal(sleeps[0], 0); // SEND_DELAY_SCALE=0 ในเทสต์ — สูตร pauseSec*1000*scale
});

test("line: reply ล้ม (token หมดอายุ) -> fallback เป็น push ไม่ทิ้งข้อความ", async () => {
  const calls = [];
  const client = createLineClient({
    config: testConfig(),
    fetchImpl: async (url, opts) => {
      calls.push(String(url));
      if (String(url).endsWith("/reply")) return { ok: false, status: 400 };
      return { ok: true, status: 200, json: async () => ({}) };
    },
    sleep: async () => {},
    logger: silent,
  });
  const result = await client.sendBubbles({ to: "U1", replyToken: "rt-เก่า", bubbles: [{ text: "ข้อความ" }] });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "push");
  assert.ok(calls.some((u) => u.endsWith("/reply")));
  assert.ok(calls.some((u) => u.endsWith("/push")));
});

test("line: reply timeout/5xx เป็นผลลัพธ์กำกวม -> ห้าม push ซ้ำ", async () => {
  for (const failure of ["timeout", "server_error"]) {
    const calls = [];
    const client = createLineClient({
      config: testConfig(),
      fetchImpl: async (url) => {
        calls.push(String(url));
        if (failure === "timeout") throw new DOMException("timed out", "TimeoutError");
        return { ok: false, status: 500 };
      },
      sleep: async () => {},
      logger: silent,
    });
    const result = await client.sendBubbles({ to: "U1", replyToken: "rt-ambiguous", bubbles: [{ text: "ข้อความ" }] });
    assert.equal(result.ok, false);
    assert.equal(result.mode, "reply");
    assert.equal(result.ambiguous, true);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].endsWith("/reply"));
  }
});

test("line: push ล้มกลางทาง = รายงาน failedAt ไม่โกหกว่าส่งครบ", async () => {
  let pushCount = 0;
  const client = createLineClient({
    config: testConfig(),
    fetchImpl: async (url) => {
      if (String(url).endsWith("/push")) {
        pushCount += 1;
        return pushCount === 2 ? { ok: false, status: 500 } : { ok: true, status: 200 };
      }
      return { ok: true, status: 200 };
    },
    sleep: async () => {},
    logger: silent,
  });
  const result = await client.sendBubbles({
    to: "U1",
    bubbles: [{ text: "หนึ่ง" }, { text: "สอง" }, { text: "สาม" }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.failedAt, 1);
  assert.equal(result.calls, 1);
});

/* --------------------------- loading animation ----------------------------- */
// BUG 3 (Airdog trial): ลูกค้าไม่เห็น "กำลังพิมพ์..." ระหว่างรอ AI — เพิ่ม startLoading
// best-effort ตาม pattern ที่พิสูจน์แล้วจากงาน Fern

test("loading: startLoading ยิง /v2/bot/chat/loading/start ด้วย chatId + loadingSeconds", async () => {
  const fetchStub = lineFetchStub();
  const client = createLineClient({ config: testConfig(), fetchImpl: fetchStub, logger: silent });
  const result = await client.startLoading({ to: "U1", seconds: 20 });
  assert.equal(result.ok, true);
  assert.equal(fetchStub.calls.length, 1);
  assert.ok(fetchStub.calls[0].url.endsWith("/v2/bot/chat/loading/start"));
  assert.deepEqual(fetchStub.calls[0].body, { chatId: "U1", loadingSeconds: 20 });
});

test("loading: seconds ถูกปัดเป็นทวีคูณของ 5 และหนีบในช่วง 5-60 ตามสเปค LINE", async () => {
  const fetchStub = lineFetchStub();
  const client = createLineClient({ config: testConfig(), fetchImpl: fetchStub, logger: silent });
  await client.startLoading({ to: "U1", seconds: 7 });   // ปัดเป็น 5
  await client.startLoading({ to: "U1", seconds: 23 });  // ปัดเป็น 25
  await client.startLoading({ to: "U1", seconds: 0 });   // หนีบขึ้นเป็น 5
  await client.startLoading({ to: "U1", seconds: 999 }); // หนีบลงเป็น 60
  const secs = fetchStub.calls.map((c) => c.body.loadingSeconds);
  assert.deepEqual(secs, [5, 25, 5, 60]);
  assert.ok(secs.every((s) => s % 5 === 0 && s >= 5 && s <= 60));
});

test("loading: fail-closed เดิมคุมด้วย — ไม่มี mock + LINE_LIVE_SEND=false = ไม่ยิงอะไรเลย", async () => {
  let called = 0;
  const client = createLineClient({
    config: testConfig({ LINE_MOCK_URL: "", LINE_LIVE_SEND: "false" }),
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200 };
    },
    logger: silent,
  });
  const result = await client.startLoading({ to: "U1", seconds: 20 });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "live_send_disabled");
  assert.equal(called, 0);
});

test("loading: fetch พัง/ตอบ error = คืน ok:false เงียบ ๆ (debug log) ไม่ throw", async () => {
  const debugs = [];
  const logger = { ...silent, debug: (msg) => debugs.push(String(msg)) };
  const boom = createLineClient({
    config: testConfig(),
    fetchImpl: async () => { throw new Error("network พัง"); },
    logger,
  });
  const failed = await boom.startLoading({ to: "U1", seconds: 20 });
  assert.equal(failed.ok, false);

  const rejected = createLineClient({
    config: testConfig(),
    fetchImpl: async () => ({ ok: false, status: 400 }),
    logger,
  });
  const notOk = await rejected.startLoading({ to: "U1", seconds: 20 });
  assert.equal(notOk.ok, false);
  assert.equal(notOk.status, 400);
  assert.equal(debugs.length, 2, "ความล้มเหลวของ loading ต้อง log แค่ระดับ debug");
});

/* -------- LuKprae training handoff 2026-08-12: F3 balloon composition -------- */

test("F3: คำตอบข้อมูลปกติ (~300 ตัวอักษร ไม่มีย่อหน้า) = ไม่เกิน 2 บับเบิล", () => {
  const humanizer = createHumanizer();
  const text = "คลาส AI Agent for Business เหมาะกับผู้เริ่มต้นค่ะ เรียนการใช้ ChatGPT และการเขียน prompt แบบมีโครงสร้างนะคะ " +
    "มีเวิร์กช็อปให้ลองทำงานจริงทั้งงานข้อความ งานภาพ และงานนำเสนอค่ะ " +
    "ส่วนคลาสต่อยอดจะพาไปทำระบบอัตโนมัติด้วย Make และเชื่อมต่อ LINE OA ได้เลยนะคะ ถ้าสนใจแบบไหนบอกแพรได้เลยค่ะ";
  const bubbles = humanizer.humanize({ customerId: "f3-normal", text });
  assert.ok(bubbles.length <= 2, `คำตอบปกติต้อง 1-2 บับเบิล (ได้ ${bubbles.length})`);
});

test("F3: เนื้อหาซับซ้อนจริง (ยาว + 3 ย่อหน้า) ยังใช้ 3 บับเบิลได้", () => {
  const humanizer = createHumanizer();
  const paragraph = "คลาสแรกปูพื้นฐานการใช้ AI ช่วยงานเอกสาร งานภาพ และงานนำเสนอสำหรับคนไม่มีพื้นฐานเลยค่ะ เรียนเป็นกลุ่มเล็กแบบลงมือทำจริงทุกหัวข้อนะคะ";
  const text = [paragraph, paragraph.replace("คลาสแรก", "คลาสที่สอง"), paragraph.replace("คลาสแรก", "ช่วงท้าย")].join("\n\n");
  assert.equal(isComplexMaterial(text), true);
  const bubbles = humanizer.humanize({ customerId: "f3-complex", text });
  assert.ok(bubbles.length >= 2 && bubbles.length <= 3, `เนื้อหาซับซ้อนได้ถึง 3 บับเบิล (ได้ ${bubbles.length})`);
});

test("F3: คำรับสั้นต้องไม่กลายเป็นบับเบิลเดี่ยว (merge เข้ากับประโยคถัดไป)", () => {
  const humanizer = createHumanizer();
  const text = "ได้เลยค่ะ " + "คลาสนี้มีเวิร์กช็อปให้ลองสร้างผู้ช่วย AI ของตัวเองตั้งแต่ต้นจนใช้งานได้จริงเลยนะคะ เหมาะกับคนเพิ่งเริ่มมาก ๆ ค่ะ " +
    "ถ้าอยากเห็นบรรยากาศคลาสบอกแพรได้เลยค่ะ";
  const bubbles = humanizer.humanize({ customerId: "f3-ack", text });
  assert.ok([...bubbles[0].text].length > 16, "บับเบิลแรกห้ามเป็นคำรับสั้นโดด ๆ");
});

// ---- v1.2.1 (feedback สดพี่ง้วง 2026-08-12): จังหวะ + การจัดรูปแบบ ----

test("v1.2.1: บอลลูนถัดไปของบอทตามไวภายใน 5 วินาทีเสมอ", () => {
  const longBubble = "คลาสนี้ออกแบบมาสำหรับทีมที่อยากลดงานซ้ำในแต่ละวัน โดยเริ่มจากการสำรวจขั้นตอนที่กินเวลามากที่สุดของทีมก่อน แล้วค่อยออกแบบระบบอัตโนมัติที่เข้ากับเครื่องมือที่ใช้อยู่จริง";
  for (const text of [longBubble, "สั้น ๆ ค่ะ", longBubble + longBubble]) {
    const pause = pauseSecondsForBubble(text, 1);
    assert.ok(pause >= 2 && pause <= 5, `pause ${pause} ต้องอยู่ใน 2-5 วิ`);
  }
});

test("v1.2.1: คำถามนำท้ายข้อความถูกเคาะขึ้นบรรทัดใหม่และปิดด้วย ?", () => {
  const out = formatLeadQuestion("คลาสนี้เหมาะกับทีมที่อยากลดงานซ้ำค่ะ ตอนนี้ใช้ AI ตัวไหนอยู่บ้างคะ");
  assert.equal(out, "คลาสนี้เหมาะกับทีมที่อยากลดงานซ้ำค่ะ\nตอนนี้ใช้ AI ตัวไหนอยู่บ้างคะ?");
});

test("v1.2.1: ข้อความที่ไม่จบด้วยคำถามไม่ถูกแตะ", () => {
  const plain = "ขอบคุณมากเลยนะคะ ทีมงานดูแลต่อให้ค่ะ";
  assert.equal(formatLeadQuestion(plain), plain);
});

test("v1.2.1: คำถามที่มี ? อยู่แล้วไม่ถูกเติมซ้ำ", () => {
  const out = formatLeadQuestion("สนใจแบบไหนคะ?");
  assert.equal(out, "สนใจแบบไหนคะ?");
});

test("v1.2.1: emoji นำหน้าบรรทัด (bullet หัวข้อ) ไม่โดนตัด แต่ emoji แทรกกลางประโยคยังจำกัด", () => {
  const input = "หัวข้อที่สอนค่ะ\n🤖 สร้าง AI Agent\n📊 ทำ Dashboard\n✅ Workflow อัตโนมัติ\n🎯 ลงมือทำจริง";
  const out = stripAiTells(input);
  for (const emoji of ["🤖", "📊", "✅", "🎯"]) assert.ok(out.includes(emoji), `bullet ${emoji} ต้องอยู่`);
  const inline = stripAiTells("สนุกมาก 😊 ครบ 🚀 จัดเต็ม 🎉 แน่นอน 💯 ค่ะ");
  const count = [...inline.matchAll(/\p{Extended_Pictographic}/gu)].length;
  assert.ok(count <= 2, `emoji กลางประโยคต้องไม่เกิน 2 (ได้ ${count})`);
});

// ---- v1.2.4: เคสจริง 2026-08-13 (ลูกค้าพิมพ์ "สวัสดีครับ" แล้วได้ template ทางตัน) ----
// ดราฟต์จริงที่ถูกบล็อก เก็บไว้เป็นข้อสอบถาวร ห้ามพังอีก
const REAL_BLOCKED_DRAFT =
  "สวัสดีค่ะ ลูกแพรเป็นผู้ช่วยของพี่ง้วง ดูแลให้คำปรึกษาข้อมูลคลาสเรียนค่ะ\n\n" +
  "ตอนนี้เคยใช้ AI ช่วยงานอะไรบ้างแล้วคะ เช่น เขียนงาน สรุปเอกสาร หรือสร้างภาพ?";

test("v1.2.4: ห้ามต่อคำลงท้ายหลังเครื่องหมายคำถาม (เคยได้ '...สร้างภาพ?ค่ะ')", () => {
  const out = ensurePoliteEnding("เช่น เขียนงาน สรุปเอกสาร หรือสร้างภาพ?");
  assert.doesNotMatch(out, /\?\s*(?:ค่ะ|คะ|ครับ)/u, "คำลงท้ายต้องอยู่ก่อนเครื่องหมายคำถาม");
  assert.match(out, /คะ\?$/u);
  assert.equal(ensurePoliteEnding("ใช้ Notion?"), "ใช้ Notion คะ?", "คำอังกฤษต้องเว้นวรรคก่อนคำลงท้าย");
  assert.equal(ensurePoliteEnding("ขอบคุณมากค่ะ"), "ขอบคุณมากค่ะ", "ข้อความที่สุภาพอยู่แล้วห้ามถูกแตะ");
});

test("v1.2.4: ส่วนขยาย 'เช่น ...' ต้องอยู่กับประโยคเดิม ไม่ใช่บับเบิลลอย", () => {
  const bubbles = createHumanizer().humanize({ customerId: "u", text: REAL_BLOCKED_DRAFT });
  const dangling = bubbles.find((bubble) => /^เช่น/u.test(bubble.text));
  assert.equal(dangling, undefined, "'เช่น ...' ห้ามกลายเป็นบับเบิลของตัวเอง");
  assert.match(bubbles.at(-1).text, /อะไรบ้างแล้วคะ เช่น/u, "คำถามกับตัวอย่างต้องอยู่ด้วยกัน");
});

test("v1.2.4: ดราฟต์จริงที่เคยถูกบล็อก ต้องผ่านกติกาการส่งได้แล้ว", () => {
  const bubbles = createHumanizer().humanize({ customerId: "u", text: REAL_BLOCKED_DRAFT });
  for (const bubble of bubbles) {
    assert.doesNotMatch(bubble.text, /\?\s*(?:ค่ะ|คะ|ครับ)/u, "ห้ามมีข้อความพังหลุดออกไป");
    assert.doesNotMatch(bubble.text, /\?{2,}|\?[^\s]*\?/u);
  }
});

/* ---- v1.3.3: คำถามปิดท้ายแยกบอลลูน + emoji ไม่พัง (เคสจริง 2026-08-13) ---- */

test("คำถามปิดท้ายต้องเป็นบอลลูนของตัวเอง ไม่ติดท้ายก้อนเนื้อหา", () => {
  const humanizer = createHumanizer();
  // ข้อความจริงที่ลูกค้าเห็นแล้วเจ้าของบ่นว่า "ดูติดเป็นพรืด"
  const out = humanizer.humanize({
    customerId: "U-split",
    text: "สำหรับคุณ Somsak เหมาะกับคลาส AI Agent for Business เพราะเริ่มจากพื้นฐาน"
      + "และทำ Workshop สร้างผู้ช่วยเฉพาะงานได้ เช่น ช่วยร่างคำตอบ แยกลูกค้าตามความสนใจ"
      + " เก็บข้อมูลเป็นระบบ และต่อยอดไอเดียคอนเทนต์สำหรับโพสต์กับโฆษณาค่ะ"
      + " คุณ Somsak จะมาเรียนเองหรือพาทีมที่ดูแลแชทและคอนเทนต์มาด้วยคะ",
  });
  assert.ok(out.length >= 2, `ต้องมีอย่างน้อย 2 บอลลูน ได้ ${out.length}`);
  const last = out.at(-1).text;
  assert.match(last, /\?$/u, "บอลลูนสุดท้ายต้องเป็นคำถามล้วนและลงท้ายด้วย ?");
  assert.doesNotMatch(last, /\n/u, "คำถามต้องอยู่ลำพัง ไม่มีเนื้อหาปนในบอลลูนเดียวกัน");
  assert.ok(out.slice(0, -1).every((b) => !/\?$/u.test(b.text)), "บอลลูนเนื้อหาต้องไม่จบด้วยคำถาม");
});

test("แยกคำถามแล้วต้องไม่ทะลุเพดานบอลลูนจนโดนรวมกลับ", () => {
  const humanizer = createHumanizer();
  const out = humanizer.humanize({
    customerId: "U-cap",
    text: "คลาสสอนสดเรียน 1 วัน เวลา 10:00-17:00 น. ที่สถาบันพี่ง้วงติดกระดุม อาคาร EZ Space"
      + " ถนนเทพารักษ์ค่ะ ส่วนคนที่ไม่สะดวกเดินทาง มีคลาสออนไลน์แบบวิดีโอดูย้อนหลังได้"
      + " ไม่จำกัดเวลาค่ะ ทั้งสองแบบได้กลุ่ม LINE Support 1 ปีเหมือนกันค่ะ"
      + " ไม่ทราบว่าคุณลูกค้าสะดวกแบบไหนมากกว่ากันคะ",
  });
  assert.ok(out.length <= 3, `ห้ามเกิน 3 บอลลูน ได้ ${out.length}`);
  assert.match(out.at(-1).text, /\?$/u);
});

test("ข้อความที่ไม่ได้จบด้วยคำถาม ต้องไม่ถูกแยกบอลลูนเพิ่มโดยไม่จำเป็น", () => {
  const humanizer = createHumanizer();
  const out = humanizer.humanize({ customerId: "U-plain", text: "รับทราบค่ะ เดี๋ยวลูกแพรส่งรายละเอียดให้นะคะ" });
  assert.equal(out.length, 1);
});

test("emoji เน้นราคาต้องไม่ถูกต่อท้ายด้วยคำลงท้ายจนกลายเป็นข้อความพัง", () => {
  // เคสจริงที่จะเกิดทันทีที่เจ้าของให้ใส่ emoji เน้นโปร Early Bird
  assert.equal(ensurePoliteEnding("โปร Early Bird เหลือ 12,900 บาท 🔥"), "โปร Early Bird เหลือ 12,900 บาทค่ะ 🔥");
  assert.doesNotMatch(ensurePoliteEnding("ราคา 15,900 บาท ⏰"), /⏰\s*(ค่ะ|คะ|ครับ)/u);
  assert.equal(ensurePoliteEnding("ราคาปกติ 19,900 บาทค่ะ 💰"), "ราคาปกติ 19,900 บาทค่ะ 💰");
});

test("emoji หลาย code point ต้องไม่ถูกตัดกลางลำดับจนเหลือเศษ", () => {
  // 🙏🏻 = emoji + สีผิว, 👩‍💻 = ZWJ sequence — ของเดิมนับทีละ code point แล้วตัดพัง
  const many = stripAiTells("ขอบคุณค่ะ 🙏🏻 ทีมงาน 👩‍💻 ดูแลเต็มที่ 🌟 พร้อมช่วยค่ะ ✨ ยินดีค่ะ 🎉");
  assert.doesNotMatch(many, /(?<!\p{Extended_Pictographic})\p{Emoji_Modifier}/u, "ห้ามเหลือสีผิวลอย ๆ");
  assert.doesNotMatch(many, /‍(?!\p{Extended_Pictographic})/u, "ห้ามเหลือ ZWJ ค้างท้าย");
});

test("โควตา emoji เป็นต่อบรรทัด ตามที่วัดจากคู่มือของแอดมินคนจริง", () => {
  // หลักฐาน: คู่มือชมพู่มี 60 บรรทัดที่มี emoji และ "ทุกบรรทัดมีตัวเดียวพอดี"
  // ไม่มีบรรทัดไหนใช้สองตัวเลย (style profile ที่สกัดจากแชทจริงก็ระบุ emojiMaximum = 1)
  const countEmoji = (value) => (value.match(/(?:\p{Extended_Pictographic}(?:\uFE0F)?|[0-9#*]\uFE0F?\u20E3)/gu) || []).length;

  // ยัดหลายตัวในบรรทัดเดียว = เหลือตัวเดียว
  assert.equal(countEmoji(stripAiTells("ดีมากเลยค่ะ 🎉 ขอบคุณนะคะ ✨ ยินดีค่ะ 😊")), 1);

  // ตัวเน้นราคาหนึ่งตัวต้องรอด (สิ่งที่เจ้าของขอไว้)
  assert.match(stripAiTells("โปร Early Bird เหลือ 12,900 บาทค่ะ 🔥"), /🔥/u);

  // emoji นำหน้าบรรทัดคือโครงสร้าง ไม่ใช่น้ำเสียง — ต้องรอดครบทุกบรรทัด
  const bullets = stripAiTells("📌 คลาสสอนสด 1 วัน\n🎯 กลุ่มเล็กไม่เกิน 15 ท่าน\n✅ มีทีม TA ดูแล");
  assert.equal(countEmoji(bullets), 3);

  // บันได 5 ระดับของคำถามคัดกรองต้องไม่โดนตัด
  const ladder = stripAiTells("ใช้ AI ระดับไหนคะ?\n1️⃣ ยังไม่เคยใช้\n2️⃣ เคยลองบ้าง\n3️⃣ ใช้ช่วยงานจริง\n4️⃣ ใช้ประจำ\n5️⃣ เคยสร้าง Custom AI");
  for (const keycap of ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"]) {
    assert.ok(ladder.includes(keycap), `บันไดระดับต้องครบ ขาด ${keycap}`);
  }
});

test("บรรทัดรายการต้องไม่ถูกเติมคำลงท้าย", () => {
  // เจอจริงตอนเทสต์บันได 5 ระดับ: "5️⃣ เคยสร้าง Custom AI, Workflow หรือ Automation แล้วค่ะ"
  // บรรทัดรายการเป็นโครงสร้าง ไม่ใช่ประโยค เติม "ค่ะ" เข้าไปแล้วอ่านเหมือนบอท
  const ladder = "ใช้ AI ระดับไหนคะ?\n1️⃣ ยังไม่เคยใช้\n5️⃣ เคยสร้าง Custom AI, Workflow หรือ Automation แล้ว";
  assert.equal(ensurePoliteEnding(ladder).split("\n").at(-1), "5️⃣ เคยสร้าง Custom AI, Workflow หรือ Automation แล้ว");
  assert.equal(ensurePoliteEnding("หัวข้อ\n📌 คลาสสอนสด 1 วัน").split("\n").at(-1), "📌 คลาสสอนสด 1 วัน");
  assert.equal(ensurePoliteEnding("รายการ\n- ข้อแรก").split("\n").at(-1), "- ข้อแรก");

  // ประโยคปกติยังต้องได้คำลงท้ายเหมือนเดิม
  assert.equal(ensurePoliteEnding("ราคา 12,900 บาท"), "ราคา 12,900 บาทค่ะ");
  assert.equal(ensurePoliteEnding("สนใจรอบไหนคะ"), "สนใจรอบไหนคะ");
});

// ---- v1.4.1 (feedback พี่ง้วง 2026-08-14): ลิงก์ต้องรอด และบันไดต้องตรงบรรทัด ----

test("v1.4.1: ลิงก์จบบอลลูนต้องไม่โดนเติมคำลงท้าย (เคสจริง .../ค่ะ ลิงก์ตาย)", () => {
  const url = "https://www.facebook.com/share/v/1TstVf06Ff/";
  assert.equal(ensurePoliteEnding(url), url, "ห้ามแตะบอลลูนที่จบด้วยลิงก์");
  assert.equal(
    ensurePoliteEnding(`ดูรีวิวได้เลยค่ะ\n${url}`),
    `ดูรีวิวได้เลยค่ะ\n${url}`,
    "บรรทัดสุดท้ายเป็นลิงก์ = ห้ามเติม"
  );
});

test("v1.4.1: อักษรไทยติด URL ถูกคั่นด้วยวรรคตั้งแต่ stripAiTells (ลิงก์ไม่ตายไม่ว่าต้นทางไหน)", () => {
  const cleaned = stripAiTells("ตามนี้เลยนะคะ https://www.facebook.com/share/v/1TstVf06Ff/ค่ะ");
  assert.match(cleaned, /1TstVf06Ff\/ ค่ะ/u, "ต้องมีวรรคคั่นระหว่างลิงก์กับ ค่ะ");
});

test("v1.4.4: รีวิว = บอลลูนเดียว เกริ่น+ลิงก์บรรทัดสุดท้าย / คำถามแยกตาม (คำสั่งพี่ง้วง)", () => {
  const h = createHumanizer();
  const bubbles = h.humanize({
    customerId: "U-review",
    text: "ขออนุญาตส่งรีวิวจากผู้เรียนที่ใกล้เคียงกับงานคอนเทนต์ของคุณลูกค้านะคะ\nคุณทดสอบสอง เจ้าของธุรกิจส่วนตัว\nhttps://www.facebook.com/share/v/1TstVf06Ff/ อยากดูกำหนดรอบเรียนที่เปิดรับอยู่ไหมคะ",
  }).map((bubble) => bubble.text);
  const reviewBubble = bubbles.find((bubble) => bubble.includes("1TstVf06Ff"));
  assert.ok(reviewBubble, "ต้องมีก้อนรีวิว");
  assert.match(reviewBubble, /ขออนุญาตส่งรีวิว/u, "เกริ่นต้องอยู่ก้อนเดียวกับลิงก์");
  assert.match(reviewBubble, /https:\/\/www\.facebook\.com\/share\/v\/1TstVf06Ff\/$/u,
    "ลิงก์ต้องเป็นบรรทัดสุดท้ายของก้อน ไม่มีอะไรตามหลัง");
  const questionBubble = bubbles.at(-1);
  assert.match(questionBubble, /ไหมคะ\?$/u, "คำถามปิดท้ายแยกเป็นบอลลูนถัดไป");
  assert.ok(!questionBubble.includes("http"), "คำถามห้ามพ่วงลิงก์");
});

test("v1.4.1: บันได 5 ระดับ — 1️⃣ ต้องขึ้นบรรทัดใหม่เสมอ ไม่ติดท้ายคำถาม (เคสจริง)", () => {
  const h = createHumanizer();
  const draft = "สวัสดีค่ะคุณSomsak ลูกแพรเป็นผู้ช่วยของพี่ง้วง ดูแลให้คำปรึกษาข้อมูลคลาสเรียนค่ะ\n\nไม่ทราบว่าคุณSomsak ปกติใช้ AI แบบ ChatGPT, Gemini หรือเคยใช้แบบ AI agent มาก่อนไหมคะ?\n1️⃣ ยังไม่เคยใช้ แต่สนใจอยากเริ่ม\n2️⃣ เคยลองบ้าง เช่น ถามข้อมูล แปลภาษา หาไอเดีย\n3️⃣ ใช้ช่วยงานจริง เช่น สรุปข้อมูล เขียนอีเมล เขียนคอนเทนต์\n4️⃣ ใช้ประจำ อยากได้เทคนิคที่สูงขึ้น\n5️⃣ เคยสร้าง Custom AI, Workflow หรือ Automation แล้ว";
  const bubbles = h.humanize({ customerId: "U-ladder", text: draft }).map((bubble) => bubble.text);
  const ladderBubble = bubbles.find((bubble) => bubble.includes("1️⃣"));
  assert.ok(ladderBubble, "ต้องมีบอลลูนบันได");
  for (const line of ladderBubble.split("\n")) {
    if (line.includes("1️⃣")) assert.match(line, /^1️⃣/u, `1️⃣ ต้องขึ้นต้นบรรทัด: "${line}"`);
  }
  // โมเดลพิมพ์ "? 1️⃣" ติดกันมาเองก็ต้องซ่อมได้
  const inline = h.humanize({
    customerId: "U-inline",
    text: "ใช้ AI ระดับไหนคะ? 1️⃣ ยังไม่เคยใช้\n2️⃣ เคยลองบ้าง\n3️⃣ ใช้ช่วยงานจริง",
  }).map((bubble) => bubble.text).join("\n");
  assert.ok(!/\?[ \t]+1️⃣/u.test(inline), "1️⃣ ห้ามติดท้ายคำถามแม้โมเดลพิมพ์มาเอง (ต้องเป็น \\n เท่านั้น)");
});

test("v1.4.1: เรื่องซับซ้อน+ลิงก์ใช้ได้ถึง 4 บอลลูน และ overflow ต่อกันด้วยบรรทัดใหม่", () => {
  const paragraphs = [
    "คลาสนี้ปูพื้นฐานการใช้ AI อย่างเป็นระบบตั้งแต่ Prompting จนถึงการวางขั้นตอนทำงานจริงค่ะ เนื้อหาถูกออกแบบมาสำหรับเจ้าของธุรกิจโดยเฉพาะเลยนะคะ",
    "ในคลาสมี Workshop ให้ลงมือทำจริงทุกช่วง มีทีม TA คอยดูแลใกล้ชิด และทบทวนออนไลน์ได้ไม่จำกัดเวลาค่ะ กลุ่มเล็กไม่เกิน 15 ท่านต่อรอบค่ะ",
    "ดูรีวิวจากผู้เรียนจริงได้ที่นี่ค่ะ\nhttps://www.facebook.com/share/r/1TstRg07Gg/",
    "สนใจรอบเรียนวันไหนดีคะ",
  ].join("\n\n");
  const h = createHumanizer();
  const bubbles = h.humanize({ customerId: "U-four", text: paragraphs }).map((bubble) => bubble.text);
  assert.ok(bubbles.length >= 3 && bubbles.length <= 4, `ต้องได้ 3-4 บอลลูน ได้ ${bubbles.length}`);
  // v1.4.4: ลิงก์อยู่ท้ายก้อนของมัน (เกริ่นอยู่ก้อนเดียวกันได้) — ห้ามมีอะไรตามหลัง
  assert.ok(bubbles.some((bubble) => /https:\/\/www\.facebook\.com\/share\/r\/1TstRg07Gg\/$/u.test(bubble)),
    "ลิงก์ต้องเป็นบรรทัดสุดท้ายของก้อน");
});

// ---- v1.4.2 (เคสจริง 2026-08-16 ตี 1): งบโทเคนเส้นตอบลูกค้า + retry เมื่อโมเดลคิดจนงบหมด ----

test("v1.4.2: draft ประกาศงบเอง และ retry หนึ่งครั้งด้วยเพดานเต็มเมื่อโดน 502 (content ว่าง)", async () => {
  const calls = [];
  let failFirst = true;
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (failFirst && calls.length === 1) {
      return { ok: false, status: 502, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "ตอบได้แล้วค่ะ" } }], usage: {} }) };
  };
  const bridge = createHermesBridge({
    config: testConfig({ HERMES_BASE: "http://127.0.0.1:9/v1", HERMES_MODEL: "gpt-5.6-sol" }),
    fetchImpl, logger: { warn() {} },
  });
  const result = await bridge.draftReply({ persona: "p", userText: "ราคาเท่าไหร่" });
  assert.equal(result.text, "ตอบได้แล้วค่ะ");
  assert.equal(calls.length, 2, "502 = retry หนึ่งครั้ง");
  // v1.4.5 (คำสั่งพี่ง้วง 2026-08-15): ขยับงบเป็น 6000/10000 — คุณภาพมาก่อนต้นทุน
  assert.equal(calls[0].max_completion_tokens, 6000, "ยกแรกงบมาตรฐาน — ห้ามพึ่ง default เกตเวย์");
  assert.equal(calls[1].max_completion_tokens, 10000, "ยกสองงบเพดานเต็ม");

  // timeout/transport = ไม่ retry (ลูกค้ารอ 3 นาทีแย่กว่า fallback ที่มีธงคนดูแล)
  const timeoutCalls = [];
  const timeoutBridge = createHermesBridge({
    config: testConfig({ HERMES_BASE: "http://127.0.0.1:9/v1", HERMES_MODEL: "gpt-5.6-sol" }),
    fetchImpl: async (url, init) => {
      timeoutCalls.push(JSON.parse(init.body));
      const err = new Error("timeout");
      err.name = "TimeoutError";
      throw err;
    },
    logger: { warn() {} },
  });
  assert.equal(await timeoutBridge.draftReply({ persona: "p", userText: "x" }), null);
  assert.equal(timeoutCalls.length, 1, "transport ล้ม = จบเลย ไม่ลากลูกค้ารอ");
});

// ---- v1.4.5 (เคสจริง 2026-08-15): บันไดทั้งก้อนถูกพ่นเป็นบรรทัดเดียว ----

test("v1.4.5: บันได inline ทั้งก้อน (ไม่มี \\n เลย) ต้องถูกคืนบรรทัดว่างระหว่างข้อ", () => {
  const inline = "ไม่ทราบว่า คุณสมชาย เคยใช้ AI มาประมาณ ระดับที่เท่าไหร่แล้วคะ ? 1️⃣ ยังไม่เคยใช้เลย 2️⃣ เคยลองเล่นนิดหน่อย 3️⃣ ใช้ช่วยงานจริงบ้างแล้ว 4️⃣ ใช้ประจำ 5️⃣ สร้าง AI ขององค์กรเอง";
  const restored = restoreKeycapLineBreaks(inline);
  for (const keycap of ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣"]) {
    assert.match(restored, new RegExp(`\\n\\n${keycap}`, "u"), `${keycap} ต้องขึ้นบรรทัดใหม่พร้อมบรรทัดว่าง`);
  }
  // prose ที่เอ่ยถึง keycap แค่สองตัวห้ามโดนแตก
  const prose = "ตอบ 1️⃣ หรือ 2️⃣ ก็ได้เลยค่ะ";
  assert.equal(restoreKeycapLineBreaks(prose), prose);
  // ก้อนที่มีโครงบรรทัดอยู่แล้ว ยังซ่อมแบบบรรทัดเดียวตามเดิม
  assert.equal(restoreKeycapLineBreaks("เลือกได้เลยค่ะ\n1️⃣ ก 2️⃣ ข"), "เลือกได้เลยค่ะ\n1️⃣ ก\n2️⃣ ข");
});

/* -------- v1.4.9 (2026-08-17): outline ยาวแตกตามหัวข้อ ไม่ใช่พืดก้อนเดียว -------- */

const OUTLINE_DRAFT = [
  "ได้เลยค่ะคุณSomsak เนื้อหาคลาสนี้ตรงกับการนำ AI ไปช่วยงาน ลงมือทำ Workshop บน Laptop ค่ะ",
  "",
  "Outline AI Agent for Business นะคะ",
  "",
  "AI Agent for Business: คลาสสอนสด สร้างกองทัพ AI ของคุณเอง ด้วย Custom GPTs + AI Agent",
  "",
  "📑 หัวข้อที่สอน (workshop ใช้ laptop)",
  "",
  "🔴 ปู Prompting framework",
  "🔴 การใช้ Chain of thought สำหรับปรับ AI",
  "🟠 Prompting flow, Text-image, Image-VDO",
  "🟡 สร้าง Custom AI จาก Knowledge สู่ Full Instruction",
  "🟢 การสร้าง AI OS COMPANY",
  "🟢 การทำ automated tasks",
  "",
  "🎯 เป้าหมายของคลาสนี้ คือ การทำให้ผู้เรียนมี AI Workforce ของตัวเอง",
  "",
  "พร้อมเปลี่ยน AI ให้กลายเป็นทีมงานดิจิทัลที่ช่วยขับเคลื่อนธุรกิจได้จริงหลังเรียนจบค่ะ 🚀",
  "",
  "🎯 สิ่งที่จะได้รับ",
  "",
  "✅ ใช้ AI ได้อย่างถูกวิธีและมีประสิทธิภาพ",
  "✅ สร้าง Custom GPTs สำหรับงานของตัวเองและทีมงาน",
  "✅ สร้าง AI Assistant ที่ตอบตามข้อมูลบริษัทได้จริง",
  "✅ วางระบบ AI OS สำหรับช่วยงานในองค์กร",
  "✅ เปลี่ยนงานซ้ำ ๆ ให้เป็นระบบอัตโนมัติด้วย AI Agent ค่ะ",
].join("\n");

test("v1.4.9: outline แตกเป็นบอลลูนตามหัวข้อ section (ไม่พืดก้อนเดียว)", () => {
  const humanizer = createHumanizer();
  const bubbles = humanizer.humanize({ customerId: "outline-test", text: OUTLINE_DRAFT });
  // เดิม: บอลลูนเดียว 22 บรรทัด — ต้องไม่มีบอลลูนไหนเกิน 12 บรรทัด
  const maxLines = Math.max(...bubbles.map((b) => b.text.split("\n").length));
  assert.ok(maxLines <= 12, `บอลลูนยาวสุด ${maxLines} บรรทัด (ต้อง <=12)`);
  // แต่ละหัวข้อ section ต้องเป็นบรรทัดแรกของบอลลูนใดบอลลูนหนึ่ง
  const heads = bubbles.map((b) => b.text.trimStart().split("\n")[0]);
  assert.ok(heads.some((h) => h.startsWith("📑 หัวข้อที่สอน")), "📑 หัวข้อที่สอน ต้องขึ้นบอลลูนของตัวเอง");
  assert.ok(heads.some((h) => h.startsWith("🎯 สิ่งที่จะได้รับ")), "🎯 สิ่งที่จะได้รับ ต้องขึ้นบอลลูนของตัวเอง");
  assert.ok(bubbles.length >= 3 && bubbles.length <= 4, `จำนวนบอลลูน ${bubbles.length} (ต้อง 3-5)`);
});

test("v1.4.9: บล็อกที่มีหัวข้อ emoji <2 (ราคา/ลงทะเบียน) ไม่ถูกซอยรายบรรทัด", () => {
  // บล็อกราคา — ไม่มีหัวข้อ section emoji เลย ต้องคงเป็นก้อนเดียว
  const priceBlock = "สรุปรายการสมัครนะคะ\n\nคลาส: Online Class\nจำนวนคน: 1 ท่าน\nยอดรวมที่ต้องชำระ: 4,900 บาท";
  const priceBubbles = splitIntoBubbles(priceBlock);
  assert.ok(priceBubbles.length <= 2, `บล็อกราคาถูกซอยเป็น ${priceBubbles.length} บอลลูน (ควร <=2)`);
  // บล็อกลงทะเบียน — หัวข้อ emoji 🖋️ เพียง 1 อัน = ไม่เข้าเส้น outline
  const regBlock = "🖋️ ข้อมูลลงทะเบียน\nชื่อ-นามสกุล* :\nอีเมล* :\nเบอร์โทร* :";
  assert.ok(splitIntoBubbles(regBlock).length <= 2);
});

/* ---- ด่านคำลงท้ายผู้หญิง (คำสั่งพี่ง้วง 5 ต.ค. 2026 "เพิ่มด่านกันคำว่าครับให้หน่อย") ---- */

// ชุดข้อความจากเทสต์ humanizer ข้างบนทั้งหมด + ข้อความที่มีคำลงท้ายผู้ชาย ยิงผ่าน humanizer ตัวเดียว
// ตามลำดับ (opener ต่อ customer มีผลข้ามข้อความ) — ปิดสวิตช์แล้วต้องได้ผลเท่า production a5005211 ทุกไบต์
const PARTICLE_FLAG_OFF_CORPUS = () => [
  ["U1", "ได้เลยค่ะ เดี๋ยวจัดการให้นะคะ"],
  ["U1", "ได้เลยค่ะ เดี๋ยวเช็คคิวให้นะคะ"],
  ["U1", "ได้เลยค่ะ เดี๋ยวส่งรายละเอียดให้นะคะ"],
  ["U2", "ได้เลยค่ะ เดี๋ยวจัดการให้นะคะ"],
  ["U3", "สวัสดีค่ะ ยินดีต้อนรับนะคะ"],
  ["U3", "สวัสดีค่ะ มีอะไรให้ลูกแพรช่วยไหมคะ"],
  ["U9", "โอเค เดี๋ยวส่งรายละเอียดให้"],
  ["U9", "### หัวข้อ\n**สำคัญมาก** นะคะ\n- ข้อหนึ่ง\n- ข้อสอง\n1. ข้อสาม"],
  ["U9", "กรุณารอสักครู่ หากมีข้อสงสัยเพิ่มเติมไม่ต้องลังเลที่จะสอบถาม"],
  ["sq", "มีเรื่องไหนอยากให้ลูกแพรช่วยอธิบายเพิ่มเติมคะ ?"],
  ["skin", "ขอบคุณที่สอบถามเข้ามานะคะ สำหรับคอร์สดูแลผิวของทางเรามีให้เลือกหลายแบบเลยค่ะ แต่ละแบบเหมาะกับสภาพผิวไม่เหมือนกันนะคะ แนะนำให้เข้ามาปรึกษาก่อนได้ค่ะ ทีมงานจะช่วยประเมินสภาพผิวให้ก่อนเริ่มโปรแกรมค่ะ ไม่มีค่าใช้จ่ายในการปรึกษานะคะ สะดวกช่วงไหนแจ้งได้เลยค่ะ เดี๋ยวเช็คคิวให้นะคะ"],
  ["f3-normal", "คลาส AI Agent for Business เหมาะกับผู้เริ่มต้นค่ะ เรียนการใช้ ChatGPT และการเขียน prompt แบบมีโครงสร้างนะคะ มีเวิร์กช็อปให้ลองทำงานจริงทั้งงานข้อความ งานภาพ และงานนำเสนอค่ะ ส่วนคลาสต่อยอดจะพาไปทำระบบอัตโนมัติด้วย Make และเชื่อมต่อ LINE OA ได้เลยนะคะ ถ้าสนใจแบบไหนบอกแพรได้เลยค่ะ"],
  ["f3-complex", ["คลาสแรกปูพื้นฐานการใช้ AI ช่วยงานเอกสาร งานภาพ และงานนำเสนอสำหรับคนไม่มีพื้นฐานเลยค่ะ เรียนเป็นกลุ่มเล็กแบบลงมือทำจริงทุกหัวข้อนะคะ", "คลาสที่สองปูพื้นฐานการใช้ AI ช่วยงานเอกสาร งานภาพ และงานนำเสนอสำหรับคนไม่มีพื้นฐานเลยค่ะ", "ช่วงท้ายเรียนเป็นกลุ่มเล็กแบบลงมือทำจริงทุกหัวข้อนะคะ"].join("\n\n")],
  ["f3-ack", "ได้เลยค่ะ คลาสนี้มีเวิร์กช็อปให้ลองสร้างผู้ช่วย AI ของตัวเองตั้งแต่ต้นจนใช้งานได้จริงเลยนะคะ เหมาะกับคนเพิ่งเริ่มมาก ๆ ค่ะ ถ้าอยากเห็นบรรยากาศคลาสบอกแพรได้เลยค่ะ"],
  ["blocked", REAL_BLOCKED_DRAFT],
  ["U-split", "สำหรับคุณ Somsak เหมาะกับคลาส AI Agent for Business เพราะเริ่มจากพื้นฐานและทำ Workshop สร้างผู้ช่วยเฉพาะงานได้ เช่น ช่วยร่างคำตอบ แยกลูกค้าตามความสนใจ เก็บข้อมูลเป็นระบบ และต่อยอดไอเดียคอนเทนต์สำหรับโพสต์กับโฆษณาค่ะ คุณ Somsak จะมาเรียนเองหรือพาทีมที่ดูแลแชทและคอนเทนต์มาด้วยคะ"],
  ["U-cap", "คลาสสอนสดเรียน 1 วัน เวลา 10:00-17:00 น. ที่สถาบันพี่ง้วงติดกระดุม อาคาร EZ Space ถนนเทพารักษ์ค่ะ ส่วนคนที่ไม่สะดวกเดินทาง มีคลาสออนไลน์แบบวิดีโอดูย้อนหลังได้ ไม่จำกัดเวลาค่ะ ทั้งสองแบบได้กลุ่ม LINE Support 1 ปีเหมือนกันค่ะ ไม่ทราบว่าคุณลูกค้าสะดวกแบบไหนมากกว่ากันคะ"],
  ["U-plain", "รับทราบค่ะ เดี๋ยวลูกแพรส่งรายละเอียดให้นะคะ"],
  ["emoji", "ดีมากเลยค่ะ 🎉 ขอบคุณนะคะ ✨ ยินดีค่ะ 😊"],
  ["emoji", "ขอบคุณค่ะ 🙏🏻 ทีมงาน 👩‍💻 ดูแลเต็มที่ 🌟 พร้อมช่วยค่ะ ✨ ยินดีค่ะ 🎉"],
  ["price", "โปร Early Bird เหลือ 12,900 บาท 🔥"],
  ["price", "ราคา 12,900 บาท"],
  ["bullets", "📌 คลาสสอนสด 1 วัน\n🎯 กลุ่มเล็กไม่เกิน 15 ท่าน\n✅ มีทีม TA ดูแล"],
  ["link", "ตามนี้เลยนะคะ https://www.facebook.com/share/v/1TstVf06Ff/ค่ะ"],
  ["U-review", "ขออนุญาตส่งรีวิวจากผู้เรียนที่ใกล้เคียงกับงานคอนเทนต์ของคุณลูกค้านะคะ\nคุณทดสอบสอง เจ้าของธุรกิจส่วนตัว\nhttps://www.facebook.com/share/v/1TstVf06Ff/ อยากดูกำหนดรอบเรียนที่เปิดรับอยู่ไหมคะ"],
  ["U-ladder", "สวัสดีค่ะคุณSomsak ลูกแพรเป็นผู้ช่วยของพี่ง้วง ดูแลให้คำปรึกษาข้อมูลคลาสเรียนค่ะ\n\nไม่ทราบว่าคุณSomsak ปกติใช้ AI แบบ ChatGPT, Gemini หรือเคยใช้แบบ AI agent มาก่อนไหมคะ?\n1️⃣ ยังไม่เคยใช้ แต่สนใจอยากเริ่ม\n2️⃣ เคยลองบ้าง เช่น ถามข้อมูล แปลภาษา หาไอเดีย\n3️⃣ ใช้ช่วยงานจริง เช่น สรุปข้อมูล เขียนอีเมล เขียนคอนเทนต์\n4️⃣ ใช้ประจำ อยากได้เทคนิคที่สูงขึ้น\n5️⃣ เคยสร้าง Custom AI, Workflow หรือ Automation แล้ว"],
  ["U-inline", "ใช้ AI ระดับไหนคะ? 1️⃣ ยังไม่เคยใช้\n2️⃣ เคยลองบ้าง\n3️⃣ ใช้ช่วยงานจริง"],
  ["U-inline2", "ไม่ทราบว่า คุณสมชาย เคยใช้ AI มาประมาณ ระดับที่เท่าไหร่แล้วคะ ? 1️⃣ ยังไม่เคยใช้เลย 2️⃣ เคยลองเล่นนิดหน่อย 3️⃣ ใช้ช่วยงานจริงบ้างแล้ว 4️⃣ ใช้ประจำ 5️⃣ สร้าง AI ขององค์กรเอง"],
  ["U-four", ["คลาสนี้ปูพื้นฐานการใช้ AI อย่างเป็นระบบตั้งแต่ Prompting จนถึงการวางขั้นตอนทำงานจริงค่ะ เนื้อหาถูกออกแบบมาสำหรับเจ้าของธุรกิจโดยเฉพาะเลยนะคะ", "ในคลาสมี Workshop ให้ลงมือทำจริงทุกช่วง มีทีม TA คอยดูแลใกล้ชิด และทบทวนออนไลน์ได้ไม่จำกัดเวลาค่ะ กลุ่มเล็กไม่เกิน 15 ท่านต่อรอบค่ะ", "ดูรีวิวจากผู้เรียนจริงได้ที่นี่ค่ะ\nhttps://www.facebook.com/share/r/1TstRg07Gg/", "สนใจรอบเรียนวันไหนดีคะ"].join("\n\n")],
  ["outline", OUTLINE_DRAFT],
  ["price-block", "สรุปรายการสมัครนะคะ\n\nคลาส: Online Class\nจำนวนคน: 1 ท่าน\nยอดรวมที่ต้องชำระ: 4,900 บาท"],
  ["reg", "🖋️ ข้อมูลลงทะเบียน\nชื่อ-นามสกุล* :\nอีเมล* :\nเบอร์โทร* :"],
  ["male", "ได้เลยครับ ลูกแพรช่วยดูให้นะครับ สนใจรอบไหนครับ"],
  ["male", "ยินดีครับ... เอ่อ ยินดีค่ะ 😊 ถ้าลองใช้แล้วติดตรงไหนบอกได้นะคะ"],
  ["male", "ได้เลยครับผม"],
  ["male", "สนใจไหมครับ"],
  ["male", "ไม่บังคับครับ เรียนออนไลน์ก็ได้ครับ"],
  ["male", "ร้านตัดผมของคุณเอใช้ AI ตอบแชทได้เลยค่ะ"],
  ["male", "ได้ค้าบ เดี๋ยวส่งให้นะคับ"],
  ["male", "โอเคฮะ ราคา 4,900 บาทครับ 🔥"],
  ["male", "ผมขอแนะนำคลาสออนไลน์ครับ\nhttps://pngoungacademy.com/class ครับ"],
  ["", ""],
  ["null", null],
];
// sha256 ของ JSON ผลลัพธ์ทั้งชุด จาก src/humanizer.mjs ที่ commit a5005211 (ก่อนเพิ่มด่าน) — ห้ามแก้เลขนี้
// เพื่อให้เทสต์ผ่าน: ตกแปลว่าพฤติกรรมตอนปิดสวิตช์เปลี่ยน ซึ่งกระทบทุกร้านที่ไม่ได้เปิด
// 2026-10-08 (privacy scrub): ชื่อ/ลิงก์จริงในชุดข้อความถูกแทนด้วยค่าสังเคราะห์ — ตรวจแล้วว่าข้อความออก
// ตรงกับของ a5005211 ทุกตัวหลังแทนชื่อ ต่างแค่ pauseSec ที่ jitter ตาม hash ข้อความ จึงคำนวณเลขใหม่ครั้งเดียว
const A5005211_FLAG_OFF_DIGEST = "401eab0faf26f199f45812f25eb0e774336c36170c17fd5909d0f125b1c7173d";
const runCorpus = (humanizer, items = PARTICLE_FLAG_OFF_CORPUS()) =>
  items.map(([customerId, text]) => humanizer.humanize({ customerId, text }));
const digestOf = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("ครับ guard: ปิดสวิตช์ (ค่าเริ่มต้น) = ผลเท่า production a5005211 ทุกไบต์ และไม่เรียก onParticleFix", () => {
  const calls = [];
  const variants = {
    default: createHumanizer(),
    emptyOptions: createHumanizer({}),
    explicitOff: createHumanizer({ femaleParticles: false, onParticleFix: (...args) => calls.push(args) }),
  };
  for (const [name, humanizer] of Object.entries(variants)) {
    const outputs = runCorpus(humanizer);
    assert.equal(digestOf(outputs), A5005211_FLAG_OFF_DIGEST, `${name} เปลี่ยนจาก a5005211:\n${JSON.stringify(outputs)}`);
  }
  assert.deepEqual(calls, [], "สวิตช์ปิดห้ามเรียก callback");
  // ปิดสวิตช์ = ครับ ยังอยู่เหมือนเดิม (ร้านอื่นที่ผู้ช่วยเป็นผู้ชายต้องไม่โดนเปลี่ยนเสียง)
  const male = createHumanizer().humanize({ customerId: "m", text: "ได้เลยครับ สนใจรอบไหนครับ" });
  assert.match(male.map((bubble) => bubble.text).join(" "), /ครับ/u);
});

test("ครับ guard: เปิดสวิตช์กับข้อความที่ไม่มีคำลงท้ายผู้ชาย = ผลเท่าปิดสวิตช์ทุกไบต์", () => {
  const femaleOnly = PARTICLE_FLAG_OFF_CORPUS().filter(([, text]) => !hasMaleParticle(text) && !/ผม/u.test(String(text ?? "")));
  assert.ok(femaleOnly.length >= 30, `ชุดข้อความผู้หญิงล้วนต้องใหญ่พอ (ได้ ${femaleOnly.length})`);
  const calls = [];
  const on = runCorpus(createHumanizer({ femaleParticles: true, onParticleFix: (...args) => calls.push(args) }), femaleOnly);
  const off = runCorpus(createHumanizer(), femaleOnly);
  assert.deepEqual(on, off);
  assert.deepEqual(calls, [], "ไม่มีอะไรให้แก้ = ไม่เรียก callback");
});

test("ครับ guard: เปิดสวิตช์ = ข้อความ legacy ที่มี ครับ ออกมาเป็น ค่ะ/คะ ถูกชนิดประโยค", () => {
  const calls = [];
  const humanizer = createHumanizer({ femaleParticles: true, onParticleFix: (...args) => calls.push(args) });
  const bubbles = humanizer.humanize({ customerId: "U-male", text: "ได้เลยครับ ลูกแพรช่วยดูให้นะครับ สนใจรอบไหนครับ" });
  const texts = bubbles.map((bubble) => bubble.text);
  assert.doesNotMatch(texts.join("\n"), /ครับ/u);
  assert.match(texts.at(-1), /สนใจรอบไหนคะ\?$/u, "คำถามต้องได้ คะ แล้ว humanizer เติม ? ได้เหมือนข้อความของลูกแพรเอง");
  assert.equal(calls.length, 1);
  const [customerId, fixes, residual] = calls[0];
  assert.equal(customerId, "U-male");
  assert.deepEqual(fixes.map((item) => item.kind), ["khrap", "na_khrap", "khrap_question"]);
  assert.deepEqual(residual, []);
});

test("ครับ guard: เคสจริง production 'ยินดีครับ... เอ่อ ยินดีค่ะ 😊' ถึงลูกค้าเป็น 'ยินดีค่ะ 😊 …'", () => {
  const calls = [];
  const humanizer = createHumanizer({ femaleParticles: true, onParticleFix: (...args) => calls.push(args) });
  const bubbles = humanizer.humanize({
    customerId: "case-038",
    text: "ยินดีครับ... เอ่อ ยินดีค่ะ 😊 ถ้าลองใช้แล้วติดตรงไหนบอกลูกแพรได้นะคะ",
  });
  assert.deepEqual(bubbles.map((bubble) => bubble.text), ["ยินดีค่ะ 😊 ถ้าลองใช้แล้วติดตรงไหนบอกลูกแพรได้นะคะ"]);
  assert.deepEqual(calls[0][1].map((item) => item.kind), ["self_correction"]);
});

test("ครับ guard: ทำงานก่อน varyOpening — 'ได้เลยครับ' ซ้ำ opener ก่อนหน้าก็ถูกสลับคำเปิดเหมือนข้อความของลูกแพร", () => {
  const humanizer = createHumanizer({ femaleParticles: true });
  const first = humanizer.humanize({ customerId: "U-open", text: "ได้เลยค่ะ เดี๋ยวจัดการให้นะคะ" });
  assert.ok(first[0].text.startsWith("ได้เลยค่ะ"));
  const second = humanizer.humanize({ customerId: "U-open", text: "ได้เลยครับ เดี๋ยวเช็คคิวให้นะครับ" });
  assert.doesNotMatch(second[0].text, /ครับ/u);
  assert.ok(!second[0].text.startsWith("ได้เลยค่ะ"), `opener ซ้ำ: ${second[0].text}`);
  // PHRASE_SOFTENERS ที่จับ "แน่นอนค่ะ" ก็ทำงานกับข้อความที่เดิมเป็น "แน่นอนครับ"
  const softened = humanizer.humanize({ customerId: "U-soft", text: "แน่นอนครับ คลาสนี้มีเวิร์กช็อปค่ะ" });
  assert.equal(softened[0].text, "คลาสนี้มีเวิร์กช็อปค่ะ");
});

test("ครับ guard: protect ส่งต่อถึงด่าน / 'ผม' แจ้งอย่างเดียว / หลายบอลลูน / ลิงก์ไม่ตาย", () => {
  const calls = [];
  const humanizer = createHumanizer({ femaleParticles: true, onParticleFix: (...args) => calls.push(args) });
  const label = "คุณบี CEO ร้านตัดผม";
  const review = humanizer.humanize({
    customerId: "U-rev",
    text: `ขออนุญาตส่งรีวิวจาก${label}ครับ\nhttps://www.facebook.com/share/v/1TstVf06Ff/ อยากดูรอบเรียนไหมครับ`,
    protect: [label],
  }).map((bubble) => bubble.text);
  assert.ok(review.some((bubble) => bubble.endsWith("https://www.facebook.com/share/v/1TstVf06Ff/")), "ลิงก์ต้องจบก้อนเหมือนเดิม");
  assert.match(review.join("\n"), new RegExp(`${label}ค่ะ`, "u"));
  assert.match(review.at(-1), /อยากดูรอบเรียนไหมคะ\?$/u);
  assert.doesNotMatch(review.join("\n"), /ครับ/u);
  assert.deepEqual(calls.at(-1)[2], [], "ป้ายรีวิวที่มี 'ผม' (ร้านตัดผม) ต้องไม่ถูกแจ้ง");

  const pronoun = humanizer.humanize({ customerId: "U-phom", text: "ผมขอแนะนำคลาสออนไลน์ค่ะ" });
  assert.equal(pronoun[0].text, "ผมขอแนะนำคลาสออนไลน์ค่ะ", "ห้ามแก้ 'ผม' เอง");
  assert.deepEqual(calls.at(-1)[1], [], "ไม่มีอะไรถูกแก้");
  assert.deepEqual(calls.at(-1)[2].map((item) => item.kind), ["male_pronoun"], "แต่ต้องแจ้งให้ชั้นนอกเขียน audit");
});

test("ครับ guard: onParticleFix พัง (throw หรือ promise reject) ห้ามทำให้ข้อความหาย", async () => {
  const warnings = [];
  const logger = { warn: (line) => warnings.push(line) };
  const throwing = createHumanizer({ femaleParticles: true, logger, onParticleFix: () => { throw new Error("db locked"); } });
  assert.deepEqual(throwing.humanize({ customerId: "U-x", text: "ได้เลยครับ" }).map((bubble) => bubble.text), ["ได้เลยค่ะ"]);
  const rejecting = createHumanizer({ femaleParticles: true, logger, onParticleFix: async () => { throw new Error("audit down"); } });
  assert.deepEqual(rejecting.humanize({ customerId: "U-y", text: "สนใจไหมครับ" }).map((bubble) => bubble.text), ["สนใจไหมคะ?"]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((line) => line.includes("onParticleFix failed")));
  // callback ไม่ใช่ฟังก์ชัน = ข้ามเงียบ ๆ ไม่พัง
  const odd = createHumanizer({ femaleParticles: true, onParticleFix: "not-a-function" });
  assert.deepEqual(odd.humanize({ customerId: "U-z", text: "ได้ครับ" }).map((bubble) => bubble.text), ["ได้ค่ะ"]);
});
