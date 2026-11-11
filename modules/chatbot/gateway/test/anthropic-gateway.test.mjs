// anthropic-gateway.test.mjs — Claude ผ่านเกตเวย์ (พี่ง้วง 4 ต.ค. 2026 "ทุกมิติ ใช้ sonnet 5.5 ก่อนเลย")
//
// สิ่งที่ด่านนี้ล็อก:
//   1. แปลงคำขอ chat/completions -> Anthropic Messages: system เป็นบล็อก + หมุดแคช · บทบาทซ้ำรวมกัน · รูป data URI · ระดับการคิด
//   2. แปลงคำตอบกลับ: ข้อความ + usage ช่องเดียวกับที่เครื่องคิดเงินอ่าน (cached_tokens / cache_write_tokens)
//   3. ส่งกุญแจ/เวอร์ชัน/workspace ถูกหัว · ไปปลายทาง Anthropic เท่านั้น
//   4. Claude ล้มทุกแบบ (ปฏิเสธ/ล่ม/คำตอบว่าง/ไม่มีกุญแจ) = ตอบด้วย 6.1 Sol ในคำขอเดียวกัน พร้อมหัวบอกว่าถอย
//   5. รูปข้อมูลเริ่มต้นจาก stdin รับแบบมีกุญแจ Anthropic ได้ · คีย์แปลกยังถูกปฏิเสธ
import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTHROPIC_FALLBACK_MODEL, ANTHROPIC_MESSAGES_URL, OPENAI_CHAT_COMPLETIONS_URL, createOpenAiStatelessGateway,
  fromAnthropicResponse, readStartupCredentials, sanitizeChatRequest, toAnthropicRequest,
} from "../openai-stateless-gateway.mjs";

const LOCAL = ["fixture", "local", "access"].join("-");
const UPSTREAM = ["fixture", "upstream", "access"].join("-");
const CLAUDE_KEY = ["fixture", "anthropic", "access"].join("-");
const WORKSPACE = "wrkspc_FIXTURE123456";
const ALLOWED = ["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "claude-sonnet-5-5"];
const PNG = "data:image/png;base64,iVBORw0KGgo=";

async function withGateway(options, run) {
  const gateway = createOpenAiStatelessGateway({ upstreamApiKey: UPSTREAM, localBearerToken: LOCAL, providerModelsVerified: true,
    providerInferenceVerified: true, allowedModels: ALLOWED, ...options });
  const address = await gateway.listen({ port: 0 });
  try { await run(`http://${address.address}:${address.port}`); } finally { await gateway.close(); }
}
const post = (base, body) => fetch(`${base}/v1/chat/completions`, { method: "POST",
  headers: { authorization: `Bearer ${LOCAL}`, "content-type": "application/json" }, body: JSON.stringify(body) });
const claudeReply = (text = "ดีเลยค่ะ อยากนำ AI ไปช่วยงานอะไรก่อนคะ?") => ({ id: "msg_1", type: "message", role: "assistant", stop_reason: "end_turn",
  content: [{ type: "thinking", thinking: "..." }, { type: "text", text }],
  usage: { input_tokens: 1200, cache_creation_input_tokens: 0, cache_read_input_tokens: 60000, output_tokens: 180 } });
const openAiReply = (text = "ตอบจาก 6.1 ค่ะ") => ({ choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5 } });
const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const BASE_REQUEST = {
  model: "claude-sonnet-5-5", max_completion_tokens: 6000,
  messages: [
    { role: "system", content: [{ type: "text", text: "ความรู้ + persona\n\n", prompt_cache_breakpoint: { mode: "explicit" } }, { type: "text", text: "กติกาเทิร์นนี้" }] },
    { role: "assistant", content: "ไม่ทราบว่าเคยใช้ AI ระดับไหนคะ?" },
    { role: "assistant", content: "[IMAGE:ai-stage-ladder]" },
    { role: "user", content: "3 ค่ะ" },
  ],
};

test("แปลงคำขอ: system เป็นบล็อกพร้อมหมุดแคช · บทบาทซ้ำรวมเป็นข้อความเดียว · ระดับการคิดเริ่มต้น medium", () => {
  const out = toAnthropicRequest(sanitizeChatRequest(BASE_REQUEST, ALLOWED));
  assert.equal(out.model, "claude-sonnet-5-5");
  assert.equal(out.max_tokens, 6000);
  assert.deepEqual(out.system, [{ type: "text", text: "ความรู้ + persona\n\n", cache_control: { type: "ephemeral", ttl: "1h" } }, { type: "text", text: "กติกาเทิร์นนี้" }]);
  assert.deepEqual(out.messages.map((m) => [m.role, m.content.length]), [["assistant", 2], ["user", 1]]);
  assert.deepEqual(out.thinking, { type: "adaptive" });
  assert.deepEqual(out.output_config, { effort: "medium" });
  assert.equal(toAnthropicRequest(sanitizeChatRequest({ ...BASE_REQUEST, reasoning_effort: "low" }, ALLOWED)).output_config.effort, "low");
});

// 7 พ.ย. 2026 (งานแคช): ชั้นแคชหลายหมุด = cache_control 1 ชม. ตามลำดับ ข้อความไม่เปลี่ยน · บล็อกไม่มีหมุดไม่มี cache_control
test("หลายหมุดใน system เดินทางครบ ข้อความเท่าเดิม และไม่เกิน 4 จุด", () => {
  const pin = { mode: "explicit" };
  const out = toAnthropicRequest(sanitizeChatRequest({ model: "claude-sonnet-5-5", messages: [
    { role: "system", content: [{ type: "text", text: "A", prompt_cache_breakpoint: pin }, { type: "text", text: "B", prompt_cache_breakpoint: pin },
      { type: "text", text: "C", prompt_cache_breakpoint: pin }, { type: "text", text: "D" }] },
    { role: "user", content: "ถาม" },
  ] }, ALLOWED));
  assert.deepEqual(out.system.map((block) => block.text), ["A", "B", "C", "D"]);
  assert.deepEqual(out.system.slice(0, 3).map((block) => block.cache_control), Array(3).fill({ type: "ephemeral", ttl: "1h" }));
  assert.equal(out.system[3].cache_control, undefined);
});

test("แปลงคำขอ: ไม่มีหมุดจากผู้เรียก (ตัวให้คะแนน) ปักท้าย system ให้เอง · รูป data URI เป็นบล็อก image base64 · ข้อความว่างถูกตัด", () => {
  const out = toAnthropicRequest(sanitizeChatRequest({ model: "claude-sonnet-5-5", messages: [
    { role: "system", content: "ให้คะแนนเป็น JSON" },
    { role: "user", content: [{ type: "text", text: "รูปนี้คือสลิปไหม" }, { type: "image_url", image_url: { url: PNG } }] },
    { role: "assistant", content: "   " },
    { role: "user", content: "ช่วยดูหน่อย" },
  ] }, ALLOWED));
  assert.deepEqual(out.system, [{ type: "text", text: "ให้คะแนนเป็น JSON", cache_control: { type: "ephemeral" } }]);
  assert.deepEqual(out.messages[0].content[1], { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } });
  assert.deepEqual(out.messages.map((m) => m.role), ["user"], "ข้อความว่างหาย แล้ว user สองข้อความรวมกัน");
  assert.equal(out.messages[0].content.length, 3);
});

test("แปลงคำตอบ: เอาเฉพาะข้อความ (ไม่เอาความคิด) · usage รวมแคชและลงช่องที่เครื่องคิดเงินอ่าน", () => {
  const out = fromAnthropicResponse(claudeReply(), "claude-sonnet-5-5");
  assert.equal(out.choices[0].message.content, "ดีเลยค่ะ อยากนำ AI ไปช่วยงานอะไรก่อนคะ?");
  assert.equal(out.choices[0].finish_reason, "stop");
  assert.deepEqual(out.usage, { prompt_tokens: 61200, completion_tokens: 180, total_tokens: 61380,
    prompt_tokens_details: { cached_tokens: 60000, cache_write_tokens: 0 } });
  assert.equal(fromAnthropicResponse({ ...claudeReply(), stop_reason: "max_tokens" }, "x").choices[0].finish_reason, "length");
});

test("Claude: ไปปลายทาง Anthropic ด้วยกุญแจ/เวอร์ชัน/workspace และคืนรูป chat/completions", async () => {
  const calls = [];
  await withGateway({ anthropicApiKey: CLAUDE_KEY, anthropicWorkspaceId: WORKSPACE,
    fetchImpl: async (url, init) => { calls.push({ url, init }); return respond(200, claudeReply()); } }, async (base) => {
    const res = await post(base, BASE_REQUEST);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-lukprae-provider"), "anthropic");
    assert.equal(res.headers.get("x-lukprae-served-model"), "claude-sonnet-5-5");
    const body = await res.json();
    assert.equal(body.choices[0].message.content, "ดีเลยค่ะ อยากนำ AI ไปช่วยงานอะไรก่อนคะ?");
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 60000);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ANTHROPIC_MESSAGES_URL);
  assert.equal(calls[0].init.headers["x-api-key"], CLAUDE_KEY);
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  assert.equal(calls[0].init.headers["anthropic-workspace-id"], WORKSPACE);
  assert.ok(!("authorization" in calls[0].init.headers), "กุญแจ OpenAI ห้ามไปฝั่ง Anthropic");
});

for (const [label, claude] of [
  ["Claude ปฏิเสธกุญแจ (หมดอายุ)", () => respond(401, { type: "error", error: { type: "authentication_error", message: "x" } })],
  ["Claude ล่ม", () => respond(529, { type: "error", error: { type: "overloaded_error", message: "x" } })],
  ["Claude คำตอบว่าง", () => respond(200, { ...claudeReply(""), content: [] })],
  ["เครือข่ายไป Anthropic ไม่ได้", () => { throw new TypeError("fetch failed"); }],
  // ข้อความครึ่งประโยคห้ามถึงลูกค้า (รีวิว 4 ต.ค.)
  ["Claude ชนเพดาน token กลางประโยค", () => respond(200, { ...claudeReply("ดีเลยค่ะ คลาสนี้จะพา"), stop_reason: "max_tokens" })],
  ["Claude ปฏิเสธตอบ", () => respond(200, { ...claudeReply("ขอโทษค่ะ"), stop_reason: "refusal" })],
]) {
  test(`${label} = ตอบด้วย 6.1 Sol ในคำขอเดียวกัน พร้อมหัวบอกว่าถอย`, async () => {
    const calls = [];
    await withGateway({ anthropicApiKey: CLAUDE_KEY, anthropicWorkspaceId: WORKSPACE,
      fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return url === ANTHROPIC_MESSAGES_URL ? claude() : respond(200, openAiReply()); } },
    async (base) => {
      const res = await post(base, BASE_REQUEST);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-lukprae-fallback-from"), "claude-sonnet-5-5");
      assert.equal(res.headers.get("x-lukprae-served-model"), ANTHROPIC_FALLBACK_MODEL, "chassis จดรุ่นที่ตอบจริงจากหัวนี้");
      assert.equal((await res.json()).choices[0].message.content, "ตอบจาก 6.1 ค่ะ");
      const health = await (await fetch(`${base}/v1/models/health`, { headers: { authorization: `Bearer ${LOCAL}` } })).json();
      assert.equal(health.modelReadiness["claude-sonnet-5-5"], false);
      assert.equal(health.ok, true, "Claude ไม่ใช่แกน — health รวมไม่ล้ม");
    });
    assert.deepEqual(calls.map((c) => c.url), [ANTHROPIC_MESSAGES_URL, OPENAI_CHAT_COMPLETIONS_URL]);
    assert.equal(calls[1].body.model, ANTHROPIC_FALLBACK_MODEL);
  });
}

test("ไม่มีกุญแจ Anthropic = ไม่เรียก Anthropic เลย ตอบด้วย 6.1 Sol", async () => {
  const urls = [];
  await withGateway({ fetchImpl: async (url) => { urls.push(url); return respond(200, openAiReply()); } }, async (base) => {
    const res = await post(base, BASE_REQUEST);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-lukprae-fallback-from"), "claude-sonnet-5-5");
  });
  assert.deepEqual(urls, [OPENAI_CHAT_COMPLETIONS_URL]);
});

test("โมเดล OpenAI เดิมไม่แตะ Anthropic เลย", async () => {
  const urls = [];
  await withGateway({ anthropicApiKey: CLAUDE_KEY, fetchImpl: async (url) => { urls.push(url); return respond(200, openAiReply()); } }, async (base) => {
    const res = await post(base, { ...BASE_REQUEST, model: "gpt-6.1-sol" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-lukprae-fallback-from"), null);
    assert.equal(res.headers.get("x-lukprae-served-model"), "gpt-6.1-sol");
    assert.equal(res.headers.get("x-lukprae-provider"), null);
  });
  assert.deepEqual(urls, [OPENAI_CHAT_COMPLETIONS_URL]);
});

test("ข้อมูลเริ่มต้นจาก stdin: รับแบบมีกุญแจ Anthropic ได้ · คีย์แปลกถูกปฏิเสธ", async () => {
  const read = (value) => readStartupCredentials([Buffer.from(JSON.stringify(value))]);
  assert.deepEqual(await read({ upstreamApiKey: UPSTREAM, localBearerToken: LOCAL }), { upstreamApiKey: UPSTREAM, localBearerToken: LOCAL });
  assert.deepEqual(await read({ upstreamApiKey: UPSTREAM, localBearerToken: LOCAL, anthropicApiKey: CLAUDE_KEY, anthropicWorkspaceId: WORKSPACE }),
    { upstreamApiKey: UPSTREAM, localBearerToken: LOCAL, anthropicApiKey: CLAUDE_KEY, anthropicWorkspaceId: WORKSPACE });
  await assert.rejects(read({ upstreamApiKey: UPSTREAM, localBearerToken: LOCAL, anthropicApiKey: CLAUDE_KEY }), /unexpected keys/u);
  await assert.rejects(read({ upstreamApiKey: UPSTREAM, localBearerToken: LOCAL, extra: "x" }), /unexpected keys/u);
});

// ---- กุญแจ Claude สองชุด (พี่ง้วง 5 พ.ย. 2026 "ใส่ api key claude อีกชุดนึง ... สลับไปมา ในกรณีที่หมด") ----
const CLAUDE_KEY_2 = ["fixture", "anthropic", "second"].join("-");
const WORKSPACE_2 = "wrkspc_FIXTURE654321";
const CREDIT_LOW = () => respond(400, { type: "error", error: { type: "invalid_request_error", message: "credit balance too low" } });
const health = async (base) => (await fetch(`${base}/v1/models/health`, { headers: { authorization: `Bearer ${LOCAL}` } })).json();

test("วนกุญแจ: ชุด 1 หมด → ใช้ชุด 2 ไปเรื่อย ๆ · ชุด 2 หมด → กลับมาชุด 1 · ลูกค้าได้ Claude ตลอด ไม่ตกไป Sol", async () => {
  const calls = [];
  const exhausted = new Set([CLAUDE_KEY]);
  await withGateway({ anthropicApiKey: CLAUDE_KEY, anthropicWorkspaceId: WORKSPACE, anthropicApiKey2: CLAUDE_KEY_2, anthropicWorkspaceId2: WORKSPACE_2,
    fetchImpl: async (url, init) => {
      calls.push({ url, key: init.headers["x-api-key"], workspace: init.headers["anthropic-workspace-id"] });
      if (url !== ANTHROPIC_MESSAGES_URL) return respond(200, openAiReply());
      return exhausted.has(init.headers["x-api-key"]) ? CREDIT_LOW() : respond(200, claudeReply());
    } }, async (base) => {
    const first = await post(base, BASE_REQUEST);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-lukprae-fallback-from"), null, "ไม่ถอยไป Sol");
    assert.equal(first.headers.get("x-lukprae-served-model"), "claude-sonnet-5-5");
    assert.equal(first.headers.get("x-lukprae-anthropic-key-slot"), "2");
    assert.deepEqual((await health(base)).anthropicKeys, [{ slot: 1, active: false }, { slot: 2, active: true }]);
    await post(base, BASE_REQUEST); // ชุด 2 เป็นชุดหลักแล้ว: ไม่ไปชนชุด 1 ซ้ำ
    exhausted.clear(); exhausted.add(CLAUDE_KEY_2); // ชุด 1 เติมแล้ว ชุด 2 หมด
    const back = await post(base, BASE_REQUEST);
    assert.equal(back.headers.get("x-lukprae-anthropic-key-slot"), "1");
    await post(base, BASE_REQUEST); // ชุด 1 เป็นชุดหลักอีกครั้ง
  });
  assert.deepEqual(calls.map((c) => c.key), [CLAUDE_KEY, CLAUDE_KEY_2, CLAUDE_KEY_2, CLAUDE_KEY_2, CLAUDE_KEY, CLAUDE_KEY]);
  assert.equal(calls[1].workspace, WORKSPACE_2, "workspace ของชุด 2 ไปกับกุญแจชุด 2");
  assert.equal(calls[0].workspace, WORKSPACE, "workspace ของชุด 1 ไปกับกุญแจชุด 1");
  assert.ok(calls.every((c) => c.url === ANTHROPIC_MESSAGES_URL), "ไม่มีคำขอไป OpenAI เลย");
});

for (const status of [401, 403, 429]) {
  test(`กุญแจชุด 1 ตอบ ${status} = ลองชุด 2`, async () => {
    const keys = [];
    await withGateway({ anthropicApiKey: CLAUDE_KEY, anthropicApiKey2: CLAUDE_KEY_2,
      fetchImpl: async (url, init) => {
        keys.push(init.headers["x-api-key"] || "openai");
        return init.headers["x-api-key"] === CLAUDE_KEY ? respond(status, { type: "error", error: { type: "x", message: "x" } }) : respond(200, claudeReply());
      } }, async (base) => {
      const res = await post(base, BASE_REQUEST);
      assert.equal(res.headers.get("x-lukprae-anthropic-key-slot"), "2");
    });
    assert.deepEqual(keys, [CLAUDE_KEY, CLAUDE_KEY_2]);
  });
}

test("กุญแจสองชุดหมดทั้งคู่ = ตอบด้วย 5.6 Sol ในคำขอเดียวกัน · health บอกว่า Claude ไม่พร้อม", async () => {
  const urls = [];
  await withGateway({ anthropicApiKey: CLAUDE_KEY, anthropicApiKey2: CLAUDE_KEY_2,
    fetchImpl: async (url) => { urls.push(url); return url === ANTHROPIC_MESSAGES_URL ? CREDIT_LOW() : respond(200, openAiReply()); } }, async (base) => {
    const res = await post(base, BASE_REQUEST);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-lukprae-fallback-from"), "claude-sonnet-5-5");
    assert.equal(res.headers.get("x-lukprae-served-model"), ANTHROPIC_FALLBACK_MODEL);
    const state = await health(base);
    assert.equal(state.modelReadiness["claude-sonnet-5-5"], false);
    assert.equal(state.modelFailures["claude-sonnet-5-5"].status, 400);
  });
  assert.deepEqual(urls, [ANTHROPIC_MESSAGES_URL, ANTHROPIC_MESSAGES_URL, OPENAI_CHAT_COMPLETIONS_URL]);
});

for (const [label, claude] of [
  ["Claude ล่ม (529)", () => respond(529, { type: "error", error: { type: "overloaded_error", message: "x" } })],
  ["Claude คำตอบว่าง", () => respond(200, { ...claudeReply(""), content: [] })],
]) {
  test(`${label} ไม่ใช่เรื่องกุญแจ = ไม่ลองชุด 2 ไป Sol ทันที (ไม่ให้ลูกค้ารอนาน)`, async () => {
    const urls = [];
    await withGateway({ anthropicApiKey: CLAUDE_KEY, anthropicApiKey2: CLAUDE_KEY_2,
      fetchImpl: async (url) => { urls.push(url); return url === ANTHROPIC_MESSAGES_URL ? claude() : respond(200, openAiReply()); } }, async (base) => {
      assert.equal((await post(base, BASE_REQUEST)).headers.get("x-lukprae-fallback-from"), "claude-sonnet-5-5");
    });
    assert.deepEqual(urls, [ANTHROPIC_MESSAGES_URL, OPENAI_CHAT_COMPLETIONS_URL]);
  });
}

test("มีแต่กุญแจชุด 2 ก็ใช้ได้ · workspace ชุด 2 ผิดรูปแบบ = ตัดเฉพาะชุดนั้น", async () => {
  const keys = [];
  await withGateway({ anthropicApiKey2: CLAUDE_KEY_2, fetchImpl: async (url, init) => { keys.push(init.headers["x-api-key"]); return respond(200, claudeReply()); } },
    async (base) => assert.equal((await post(base, BASE_REQUEST)).headers.get("x-lukprae-anthropic-key-slot"), "2"));
  await withGateway({ anthropicApiKey: CLAUDE_KEY, anthropicApiKey2: CLAUDE_KEY_2, anthropicWorkspaceId2: "bad-workspace",
    fetchImpl: async (url, init) => { keys.push(init.headers["x-api-key"] || "openai"); return url === ANTHROPIC_MESSAGES_URL ? CREDIT_LOW() : respond(200, openAiReply()); } },
  async (base) => {
    assert.equal((await post(base, BASE_REQUEST)).headers.get("x-lukprae-fallback-from"), "claude-sonnet-5-5");
    assert.deepEqual((await health(base)).anthropicKeys.map((k) => k.slot), [1]);
  });
  assert.deepEqual(keys, [CLAUDE_KEY_2, CLAUDE_KEY, "openai"]);
});

test("ข้อมูลเริ่มต้นจาก stdin: รับกุญแจชุด 2 เป็นคู่ · ชุด 2 อย่างเดียวได้ · ขาดครึ่งคู่ถูกปฏิเสธ", async () => {
  const read = (value) => readStartupCredentials([Buffer.from(JSON.stringify(value))]);
  const base = { upstreamApiKey: UPSTREAM, localBearerToken: LOCAL };
  assert.deepEqual(await read({ ...base, anthropicApiKey: CLAUDE_KEY, anthropicWorkspaceId: WORKSPACE, anthropicApiKey2: CLAUDE_KEY_2, anthropicWorkspaceId2: "" }),
    { ...base, anthropicApiKey: CLAUDE_KEY, anthropicWorkspaceId: WORKSPACE, anthropicApiKey2: CLAUDE_KEY_2, anthropicWorkspaceId2: "" });
  assert.deepEqual(await read({ ...base, anthropicApiKey2: CLAUDE_KEY_2, anthropicWorkspaceId2: WORKSPACE_2 }),
    { ...base, anthropicApiKey2: CLAUDE_KEY_2, anthropicWorkspaceId2: WORKSPACE_2 });
  await assert.rejects(read({ ...base, anthropicApiKey: CLAUDE_KEY, anthropicWorkspaceId: WORKSPACE, anthropicApiKey2: CLAUDE_KEY_2 }), /unexpected keys/u);
});

test("Claude ค้าง = ตัดที่เพดานของ Claude แล้วตอบด้วย 6.1 ทันเวลา (ไม่รอ 60 วิเต็ม)", async () => {
  const startedAt = Date.now();
  await withGateway({ anthropicApiKey: CLAUDE_KEY, anthropicWorkspaceId: WORKSPACE, anthropicTimeoutMs: 50,
    fetchImpl: (url, init) => url === ANTHROPIC_MESSAGES_URL
      ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))
      : Promise.resolve(respond(200, openAiReply())) }, async (base) => {
    const res = await post(base, BASE_REQUEST);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-lukprae-fallback-from"), "claude-sonnet-5-5");
  });
  assert.ok(Date.now() - startedAt < 5_000);
});

test("Claude ตอบได้ ไม่ล้างสถานะเครดิต OpenAI หมด (เครดิตเป็นของคนละบัญชี)", async () => {
  await withGateway({ anthropicApiKey: CLAUDE_KEY, anthropicWorkspaceId: WORKSPACE,
    fetchImpl: async (url) => url === ANTHROPIC_MESSAGES_URL ? respond(200, claudeReply())
      : respond(429, { error: { type: "insufficient_quota", code: "insufficient_quota", message: "x" } }) }, async (base) => {
    assert.equal((await post(base, { ...BASE_REQUEST, model: "gpt-6.1-sol" })).status >= 400, true);
    assert.equal((await post(base, BASE_REQUEST)).status, 200);
    const health = await (await fetch(`${base}/v1/models/health`, { headers: { authorization: `Bearer ${LOCAL}` } })).json();
    assert.equal(health.modelReadiness["gpt-6.1-sol"], false);
    assert.equal(health.modelReadiness["claude-sonnet-5-5"], true);
  });
});

// 7 พ.ย. 2026 (งานแคช): ชั้นแคชทำให้คำขอมีหลายหมุด เส้นสำรองตอน Claude ล้มต้องส่งถึง 5.6 Sol ครบ ไม่งั้นลูกค้าไม่ได้คำตอบ
// ยิงจริงกับ OpenAI แล้ว 8 คำขอ (2 หมุด 3 หมุด ตรงและผ่านเส้นสำรอง) ได้ 200 ทั้งหมด เทสต์นี้ล็อกรูปคำขอไว้
const PIN = { mode: "explicit" };
const MULTI_PIN_SYSTEM = [
  { type: "text", text: "ความรู้ + persona ส่วนร่วม\n\n", prompt_cache_breakpoint: PIN },
  { type: "text", text: "ท้าย persona\n\n", prompt_cache_breakpoint: PIN },
  { type: "text", text: "การ์ดแบรนด์\n\n", prompt_cache_breakpoint: PIN },
  { type: "text", text: "กติกาของเทิร์น" },
];
const MULTI_PIN_REQUEST = { model: "claude-sonnet-5-5", max_completion_tokens: 6000, prompt_cache_key: "pngoung-tidkradum-bv-1", prompt_cache_options: { mode: "explicit" },
  messages: [{ role: "system", content: MULTI_PIN_SYSTEM }, { role: "user", content: "สนใจคลาสค่ะ" }] };

for (const [name, claudeStatus, keys] of [["Claude ล่ม 500", 500, { anthropicApiKey: CLAUDE_KEY }], ["เครดิตหมดทั้งสองกุญแจ 402", 402, { anthropicApiKey: CLAUDE_KEY, anthropicApiKey2: `${CLAUDE_KEY}-2` }]]) {
  test(`${name}: คำขอหลายหมุดถึง 5.6 Sol ครบทุกบล็อกและทุกหมุด`, async () => {
    const sentToOpenAi = [];
    let claudeCalls = 0;
    const fetchImpl = async (url, opts) => {
      if (String(url) === ANTHROPIC_MESSAGES_URL) { claudeCalls += 1; return respond(claudeStatus, { type: "error", error: { type: "api_error" } }); }
      assert.equal(String(url), OPENAI_CHAT_COMPLETIONS_URL);
      sentToOpenAi.push(JSON.parse(opts.body));
      return respond(200, openAiReply("ตอบจาก 5.6 ค่ะ"));
    };
    await withGateway({ fetchImpl, ...keys }, async (base) => {
      const res = await post(base, MULTI_PIN_REQUEST);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-lukprae-served-model"), ANTHROPIC_FALLBACK_MODEL);
      assert.equal(res.headers.get("x-lukprae-fallback-from"), "claude-sonnet-5-5");
      assert.equal((await res.json()).choices[0].message.content, "ตอบจาก 5.6 ค่ะ");
    });
    assert.equal(claudeCalls, claudeStatus === 402 ? 2 : 1);
    assert.equal(sentToOpenAi.length, 1);
    const [body] = sentToOpenAi;
    assert.equal(body.model, ANTHROPIC_FALLBACK_MODEL);
    assert.deepEqual(body.messages[0].content, MULTI_PIN_SYSTEM, "บล็อกและหมุดต้องเดินทางครบ ข้อความเท่าเดิม");
    assert.deepEqual(body.prompt_cache_options, { mode: "explicit" });
    assert.equal(body.prompt_cache_key, "pngoung-tidkradum-bv-1");
  });
}

test("คำขอหลายหมุดยิงตรงไป 5.6 Sol ผ่านด่านของเกตเวย์ และไม่มีคีย์ของ Claude ปนไป", async () => {
  const sentToOpenAi = [];
  const fetchImpl = async (url, opts) => { assert.equal(String(url), OPENAI_CHAT_COMPLETIONS_URL); sentToOpenAi.push(JSON.parse(opts.body)); return respond(200, openAiReply()); };
  await withGateway({ fetchImpl, allowedModels: [...ALLOWED, ANTHROPIC_FALLBACK_MODEL] }, async (base) => {
    const res = await post(base, { ...MULTI_PIN_REQUEST, model: ANTHROPIC_FALLBACK_MODEL });
    assert.equal(res.status, 200);
  });
  assert.deepEqual(sentToOpenAi[0].messages[0].content, MULTI_PIN_SYSTEM);
  assert.ok(!JSON.stringify(sentToOpenAi[0]).includes("cache_control"), "cache_control เป็นรูปของ Anthropic ห้ามถึง OpenAI");
});
