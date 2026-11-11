// openai-key-failover-gateway.test.mjs — กุญแจ OpenAI สองชุดในเกตเวย์ (พี่ง้วง 8 พ.ย. 2026 "ถ้าอันไหนหมด ให้ fallback ไปอีกอัน")
//
// สิ่งที่ด่านนี้ล็อก:
//   1. ชุด 1 เครดิตหมด/ถูกปฏิเสธ/ติดเพดาน (401 402 403 429) = ลองชุด 2 ในคำขอเดียวกัน แล้วชุด 2 เป็นชุดหลักต่อจนกว่าจะหมดบ้าง
//   2. 400 (คำขอผิด) และล่ม/หมดเวลา = ไม่สลับกุญแจ (ชุดอื่นก็ได้ผลเดียวกัน ไม่ให้ลูกค้ารอนานขึ้น)
//   3. ไม่มีชุด 2 = พฤติกรรมเดิมทุกอย่าง · health บอกเลขชุดเท่านั้น ไม่มีค่ากุญแจ
//   4. Claude หมดทั้งสองชุด = ตอบด้วยรุ่นหลักของ OpenAI ผ่านกุญแจ OpenAI ที่ใช้ได้
//   5. รูปข้อมูลเริ่มต้นจาก stdin และตัวเปิดเกตเวย์ส่งกุญแจชุด 2 ต่อได้
import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_FALLBACK_MODEL, ANTHROPIC_MESSAGES_URL, OPENAI_CHAT_COMPLETIONS_URL, OPENAI_KEY_SWITCH_STATUSES,
  createOpenAiStatelessGateway, readStartupCredentials,
} from "../openai-stateless-gateway.mjs";

const LOCAL = ["fixture", "local", "access"].join("-");
const KEY_1 = ["fixture", "openai", "main"].join("-");
const KEY_2 = ["fixture", "openai", "backup"].join("-");
const CLAUDE_1 = ["fixture", "anthropic", "first"].join("-");
const CLAUDE_2 = ["fixture", "anthropic", "second"].join("-");
const ALLOWED = ["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "claude-sonnet-5-5"];
const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const reply = (text = "ตอบจาก 6.1 ค่ะ") => respond(200, { choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 } });
const quota = () => respond(429, { error: { type: "insufficient_quota", code: "insufficient_quota", message: "x" } });
const bearerOf = (init) => String(init?.headers?.authorization || "").replace(/^Bearer /u, "");
const REQUEST = { model: "gpt-6.1-sol", messages: [{ role: "user", content: "ราคาเท่าไหร่คะ" }] };

async function withGateway(options, run) {
  const gateway = createOpenAiStatelessGateway({ upstreamApiKey: KEY_1, localBearerToken: LOCAL, providerModelsVerified: true,
    providerInferenceVerified: true, allowedModels: ALLOWED, ...options });
  const address = await gateway.listen({ port: 0 });
  try { await run(`http://${address.address}:${address.port}`); } finally { await gateway.close(); }
}
const post = (base, body = REQUEST) => fetch(`${base}/v1/chat/completions`, { method: "POST",
  headers: { authorization: `Bearer ${LOCAL}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const health = async (base) => (await fetch(`${base}/v1/models/health`, { headers: { authorization: `Bearer ${LOCAL}` } })).json();

test("ชุด 1 เครดิตหมด → ชุด 2 ในคำขอเดียวกัน แล้วใช้ชุด 2 ต่อ · ชุด 2 หมด → กลับชุด 1 · ลูกค้าได้คำตอบทุกครั้ง", async () => {
  const keys = [];
  const exhausted = new Set([KEY_1]);
  await withGateway({ upstreamApiKey2: KEY_2, fetchImpl: async (url, init) => {
    assert.equal(url, OPENAI_CHAT_COMPLETIONS_URL);
    keys.push(bearerOf(init));
    return exhausted.has(bearerOf(init)) ? quota() : reply();
  } }, async (base) => {
    const first = await post(base);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-lukprae-openai-key-slot"), "2");
    const state = await health(base);
    assert.deepEqual(state.openaiKeys, [{ slot: 1, active: false }, { slot: 2, active: true }]);
    assert.ok(state.openaiKeyLastSwitchAt);
    assert.ok(!JSON.stringify(state).includes(KEY_1) && !JSON.stringify(state).includes(KEY_2), "health ไม่มีค่ากุญแจ");
    assert.equal((await post(base)).headers.get("x-lukprae-openai-key-slot"), "2", "ชุด 2 เป็นชุดหลักแล้ว ไม่ชนชุด 1 ซ้ำ");
    exhausted.clear(); exhausted.add(KEY_2);
    assert.equal((await post(base)).headers.get("x-lukprae-openai-key-slot"), "1");
  });
  assert.deepEqual(keys, [KEY_1, KEY_2, KEY_2, KEY_2, KEY_1]);
});

for (const status of OPENAI_KEY_SWITCH_STATUSES) {
  test(`ชุด 1 ตอบ ${status} = ลองชุด 2`, async () => {
    const keys = [];
    await withGateway({ upstreamApiKey2: KEY_2, fetchImpl: async (url, init) => {
      keys.push(bearerOf(init));
      return bearerOf(init) === KEY_1 ? respond(status, { error: { type: "x", code: "x", message: "x" } }) : reply();
    } }, async (base) => {
      const res = await post(base);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-lukprae-openai-key-slot"), "2");
    });
    assert.deepEqual(keys, [KEY_1, KEY_2]);
  });
}

for (const [label, upstream] of [
  ["400 คำขอผิด", () => respond(400, { error: { type: "invalid_request_error", code: "x", message: "x" } })],
  ["500 ผู้ให้บริการล่ม", () => respond(500, { error: { type: "server_error", message: "x" } })],
]) {
  test(`${label} = ไม่สลับกุญแจ ส่งผลเดิมกลับ`, async () => {
    const keys = [];
    await withGateway({ upstreamApiKey2: KEY_2, fetchImpl: async (url, init) => { keys.push(bearerOf(init)); return upstream(); } }, async (base) => {
      assert.notEqual((await post(base)).status, 200);
    });
    assert.deepEqual(keys, [KEY_1]);
  });
}

test("หมดทั้งสองชุด = ส่ง 429 กลับแบบเดิม (ลองครบสองชุดในคำขอเดียว)", async () => {
  const keys = [];
  await withGateway({ upstreamApiKey2: KEY_2, fetchImpl: async (url, init) => { keys.push(bearerOf(init)); return quota(); } }, async (base) => {
    const res = await post(base);
    assert.equal(res.status, 429);
    assert.equal((await health(base)).modelFailures["gpt-6.1-sol"].code, "insufficient_quota");
  });
  assert.deepEqual(keys, [KEY_1, KEY_2]);
});

test("ไม่มีชุด 2 = พฤติกรรมเดิม: ยิงชุดเดียว · health มีชุดเดียว", async () => {
  const keys = [];
  await withGateway({ fetchImpl: async (url, init) => { keys.push(bearerOf(init)); return quota(); } }, async (base) => {
    assert.equal((await post(base)).status, 429);
    assert.deepEqual((await health(base)).openaiKeys, [{ slot: 1, active: true }]);
  });
  assert.deepEqual(keys, [KEY_1]);
});

test("Claude หมดทั้งสองชุด = ตอบด้วยรุ่นหลัก 6.1 Sol ผ่านกุญแจ OpenAI ที่ใช้ได้ (ชุด 1 หมดก็ไปชุด 2)", async () => {
  const calls = [];
  await withGateway({ upstreamApiKey2: KEY_2, anthropicApiKey: CLAUDE_1, anthropicApiKey2: CLAUDE_2, allowedModels: ALLOWED,
    fetchImpl: async (url, init) => {
      calls.push(url === ANTHROPIC_MESSAGES_URL ? `claude:${init.headers["x-api-key"]}` : `openai:${bearerOf(init)}`);
      if (url === ANTHROPIC_MESSAGES_URL) return respond(400, { type: "error", error: { type: "invalid_request_error", message: "credit balance too low" } });
      return bearerOf(init) === KEY_1 ? quota() : reply();
    } }, async (base) => {
    const res = await post(base, { ...REQUEST, model: "claude-sonnet-5-5" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-lukprae-fallback-from"), "claude-sonnet-5-5");
    assert.equal(res.headers.get("x-lukprae-served-model"), "gpt-6.1-sol");
  });
  assert.equal(ANTHROPIC_FALLBACK_MODEL, "gpt-6.1-sol");
  assert.deepEqual(calls, [`claude:${CLAUDE_1}`, `claude:${CLAUDE_2}`, `openai:${KEY_1}`, `openai:${KEY_2}`]);
});

test("ข้อมูลเริ่มต้นจาก stdin: กุญแจ OpenAI ชุด 2 มาหรือไม่มาก็ได้ · คีย์แปลกยังถูกปฏิเสธ", async () => {
  const read = (value) => readStartupCredentials([Buffer.from(JSON.stringify(value))]);
  assert.deepEqual(await read({ upstreamApiKey: KEY_1, localBearerToken: LOCAL }), { upstreamApiKey: KEY_1, localBearerToken: LOCAL });
  assert.deepEqual(await read({ upstreamApiKey: KEY_1, upstreamApiKey2: KEY_2, localBearerToken: LOCAL }),
    { upstreamApiKey: KEY_1, upstreamApiKey2: KEY_2, localBearerToken: LOCAL });
  assert.deepEqual(await read({ upstreamApiKey: KEY_1, upstreamApiKey2: KEY_2, localBearerToken: LOCAL, anthropicApiKey: CLAUDE_1, anthropicWorkspaceId: "" }),
    { upstreamApiKey: KEY_1, upstreamApiKey2: KEY_2, localBearerToken: LOCAL, anthropicApiKey: CLAUDE_1, anthropicWorkspaceId: "" });
  await assert.rejects(read({ upstreamApiKey: KEY_1, upstreamApiKey3: KEY_2, localBearerToken: LOCAL }), /unexpected keys/u);
});
