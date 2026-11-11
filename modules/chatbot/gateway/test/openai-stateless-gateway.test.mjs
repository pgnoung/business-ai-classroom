import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_COMPLETION_TOKENS,
  SCORER_MAX_COMPLETION_TOKENS,
  completionTokenBudget,
  OPENAI_CHAT_COMPLETIONS_URL,
  OPENAI_MODELS_URL,
  createOpenAiStatelessGateway,
  readStartupCredentials,
  verifyProviderInference,
  verifyProviderModels,
} from "../openai-stateless-gateway.mjs";

const TEST_UPSTREAM_ACCESS = ["fixture", "upstream", "access"].join("-");
const TEST_LOCAL_ACCESS = ["fixture", "local", "access"].join("-");
const TEST_PROVIDER_ACCESS = ["fixture", "provider", "access"].join("-");

async function withGateway(options, run) {
  const gateway = createOpenAiStatelessGateway({
    upstreamApiKey: TEST_UPSTREAM_ACCESS,
    localBearerToken: TEST_LOCAL_ACCESS,
    providerModelsVerified: true,
    providerInferenceVerified: true,
    ...options,
  });
  const address = await gateway.listen({ port: 0 });
  try {
    await run(`http://${address.address}:${address.port}`);
  } finally {
    await gateway.close();
  }
}

function localHeaders() {
  return { authorization: `Bearer ${TEST_LOCAL_ACCESS}`, "content-type": "application/json" };
}

test("requires local bearer auth and exposes only the fixed model health inventory", async () => {
  let upstreamCalls = 0;
  await withGateway({ fetchImpl: async () => { upstreamCalls += 1; throw new Error("must not call"); } }, async (base) => {
    const denied = await fetch(`${base}/v1/models/health`);
    assert.equal(denied.status, 401);

    const health = await fetch(`${base}/v1/models/health`, { headers: { authorization: `Bearer ${TEST_LOCAL_ACCESS}` } });
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.ok, true);
    assert.equal(body.providerInferenceReady, true);
    assert.deepEqual(body.modelReadiness, { "gpt-6.1-sol": true, "gpt-5.6-sol": true, "gpt-5.6-luna": true, "gpt-5.6-terra": true });
    assert.deepEqual(body.models, ["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]);
    assert.equal(upstreamCalls, 0);
  });
});

test("synthetic capability verification probes 6.1 Sol-low, 5.6 Sol, Luna and Terra-high exactly once", async () => {
  const bodies = [];
  const result = await verifyProviderInference({
    upstreamApiKey: TEST_PROVIDER_ACCESS,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" } }] }), { status: 200 });
    },
  });
  assert.deepEqual(result.models, ["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]);
  assert.deepEqual(bodies.map((body) => body.model), result.models);
  // 6.1 Sol ไม่รองรับ reasoning none/minimal — probe ต้องส่ง low
  assert.equal(bodies[0].reasoning_effort, "low");
  assert.equal(Object.hasOwn(bodies[1], "reasoning_effort"), false);
  assert.equal(Object.hasOwn(bodies[2], "reasoning_effort"), false);
  assert.equal(bodies[3].reasoning_effort, "high");
  assert.equal(bodies.every((body) => body.store === false && body.stream === false), true);
});

test("synthetic large business context fits the bounded system-message contract", async () => {
  const parts = ["ข้อมูลสินค้าและเงื่อนไขร้านตัวอย่าง\n".repeat(2500), "ผู้ช่วยร้านตัวอย่าง", "ราคาตามตารางที่อนุมัติ"];
  let forwarded;
  await withGateway({ fetchImpl: async (_url, init) => {
    forwarded = JSON.parse(init.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: "รับทราบค่ะ" } }] }), { status: 200 });
  } }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: localHeaders(),
      body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "system", content: parts.join("\n\n") }, { role: "user", content: "สวัสดีค่ะ" }] }),
    });
    assert.equal(response.status, 200);
  });
  assert.equal(forwarded.messages[0].content, parts.join("\n\n"));
});

test("provider preflight requires all three approved model ids without exposing the key", async () => {
  const calls = [];
  const result = await verifyProviderModels({
    upstreamApiKey: TEST_PROVIDER_ACCESS,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ data: [
        { id: "gpt-5.6-luna" }, { id: "gpt-5.6-sol" }, { id: "gpt-5.6-terra" }, { id: "gpt-6.1-sol" },
      ] }), { status: 200 });
    },
  });
  assert.deepEqual(result, { ok: true, models: ["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"], missing: [] });
  assert.equal(calls[0].url, OPENAI_MODELS_URL);
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TEST_PROVIDER_ACCESS}`);
  await assert.rejects(verifyProviderModels({
    upstreamApiKey: TEST_PROVIDER_ACCESS,
    fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "gpt-5.6-sol" }] }), { status: 200 }),
  }), /provider_models_missing/u);
});

test("forwards only an allowlisted stateless Terra-high request to the fixed upstream", async () => {
  const calls = [];
  await withGateway({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "chatcmpl_test", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: localHeaders(),
      body: JSON.stringify({
        model: "gpt-5.6-terra", reasoning_effort: "high", max_completion_tokens: 700,
        store: true, stream: true, service_tier: "priority", api_key: "client-attempt", base_url: "https://other.example",
        messages: [{ role: "system", content: "safe system" }, { role: "user", content: "hello" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-lukprae-gateway-receipt"), "stateless-forwarded");
    assert.equal((await response.json()).id, "chatcmpl_test");
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, OPENAI_CHAT_COMPLETIONS_URL);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${TEST_UPSTREAM_ACCESS}`);
  const forwarded = JSON.parse(calls[0].init.body);
  assert.deepEqual(forwarded, {
    model: "gpt-5.6-terra", reasoning_effort: "high", max_completion_tokens: 700,
    store: false, stream: false, service_tier: "default",
    messages: [{ role: "system", content: "safe system" }, { role: "user", content: "hello" }],
  });
});

test("omits reasoning_effort when Luna primary does not request it", async () => {
  let forwarded;
  await withGateway({
    fetchImpl: async (_url, init) => {
      forwarded = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "{}" } }] }), { status: 200 });
    },
  }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: localHeaders(),
      body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "score" }] }),
    });
    assert.equal(response.status, 200);
  });
  assert.equal(Object.hasOwn(forwarded, "reasoning_effort"), false);
});

test("completed requests release the inflight slot instead of accumulating gateway_busy state", async () => {
  let upstreamCalls = 0;
  await withGateway({
    fetchImpl: async () => {
      upstreamCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }), { status: 200 });
    },
  }, async (base) => {
    for (let index = 0; index < 8; index += 1) {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: localHeaders(),
        body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: `request ${index}` }] }),
      });
      assert.equal(response.status, 200);
    }
  });
  assert.equal(upstreamCalls, 8);
});

test("rejects unsupported models, reasoning levels, oversized token budgets and malformed message content without upstream calls", async () => {
  let upstreamCalls = 0;
  await withGateway({ fetchImpl: async () => { upstreamCalls += 1; return new Response("{}", { status: 200 }); } }, async (base) => {
    const cases = [
      { model: "other", messages: [{ role: "user", content: "x" }] },
      { model: "gpt-5.6-terra", reasoning_effort: "xhigh", messages: [{ role: "user", content: "x" }] },
      { model: "gpt-5.6-sol", max_completion_tokens: SCORER_MAX_COMPLETION_TOKENS + 1, messages: [{ role: "user", content: "x" }] },
      // v1.4.27: บล็อก type "text" อนุญาตแล้ว (ต้องใช้ปัก cache breakpoint) แต่ชนิดอื่น
      // ยังต้องถูกปฏิเสธเหมือนเดิม — ด่านนี้ห้ามกว้างขึ้นเกินที่ตั้งใจ
      { model: "gpt-5.6-luna", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "http://x" } }] }] },
      { model: "gpt-5.6-luna", messages: [{ role: "user", content: [] }] },
    ];
    for (const body of cases) {
      const response = await fetch(`${base}/v1/chat/completions`, { method: "POST", headers: localHeaders(), body: JSON.stringify(body) });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, "invalid_request");
    }
    assert.equal(upstreamCalls, 0);
  });
});

test("bounds upstream response bytes and maps timeout without exposing prompts or credentials", async () => {
  await withGateway({
    timeoutMs: 10,
    fetchImpl: async (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
  }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: localHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "private prompt" }] }),
    });
    assert.equal(response.status, 504);
    const body = await response.text();
    assert.doesNotMatch(body, /private prompt|fixture-upstream-access|fixture-local-access/u);
  });

  await withGateway({
    maxResponseBytes: 32,
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "this response is deliberately much longer than thirty two bytes" } }] }), { status: 200 }),
  }, async (base) => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: localHeaders(), body: JSON.stringify({ model: "gpt-5.6-sol", messages: [{ role: "user", content: "x" }] }),
    });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "upstream_response_invalid");
  });
});

test("provider failure degrades only the failed model and definitive rejection remains typed", async () => {
  await withGateway({ fetchImpl: async () => new Response("", { status: 401 }) }, async (base) => {
    const failed = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: localHeaders(),
      body: JSON.stringify({ model: "gpt-5.6-luna", messages: [{ role: "user", content: "score" }] }),
    });
    assert.equal(failed.status, 401);
    assert.equal((await failed.json()).error.code, "upstream_definitive_rejection");
    const health = await fetch(`${base}/v1/models/health`, { headers: { authorization: `Bearer ${TEST_LOCAL_ACCESS}` } });
    const body = await health.json();
    assert.equal(body.ok, false);
    assert.equal(body.modelReadiness["gpt-5.6-sol"], true);
    assert.equal(body.modelReadiness["gpt-5.6-luna"], false);
    assert.equal(body.modelReadiness["gpt-5.6-terra"], true);
  });
});

test("accepts startup credentials only as the exact stdin JSON shape", async () => {
  async function* source(value) { yield value; }
  assert.deepEqual(await readStartupCredentials(source('{"upstreamApiKey":"a","localBearerToken":"b"}')), {
    upstreamApiKey: "a", localBearerToken: "b",
  });
  await assert.rejects(readStartupCredentials(source('{"upstreamApiKey":"a","localBearerToken":"b","extra":"x"}')), /unexpected keys/u);
});

// FIX 2026-08-12 (regression กัน hermes=degraded ถาวรกลับมา): boot probe ต้องให้
// งบ completion พอสำหรับโมเดล reasoning — cap จิ๋ว (24) ทำ terra(effort=high) โดน
// upstream 400 แบบ deterministic -> verification ไม่มีวันผ่าน -> degraded ตั้งแต่เกิด
test("boot probes carry per-model completion budgets (reasoning headroom)", async () => {
  const seen = [];
  const fetchImpl = async (_url, init) => {
    seen.push(JSON.parse(init.body));
    return new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] }),
      { status: 200 },
    );
  };
  await verifyProviderInference({ upstreamApiKey: "sk-test", fetchImpl });
  assert.equal(seen.length, 4);
  const byModel = Object.fromEntries(seen.map((b) => [b.model, b]));
  assert.ok(byModel["gpt-6.1-sol"].max_completion_tokens >= 256, "6.1 Sol คิดก่อนตอบเสมอ ต้องมี headroom");
  assert.equal(byModel["gpt-6.1-sol"].reasoning_effort, "low", "6.1 Sol ไม่รองรับ none");
  assert.ok(byModel["gpt-5.6-sol"].max_completion_tokens >= 64);
  assert.ok(byModel["gpt-5.6-luna"].max_completion_tokens >= 256, "luna เป็น reasoning เบา ต้องมี headroom");
  assert.ok(byModel["gpt-5.6-terra"].max_completion_tokens >= 1024, "terra effort=high คิดเยอะ งบต้องพอ");
  assert.equal(byModel["gpt-5.6-terra"].reasoning_effort, "high", "role pinning เดิมห้ามเปลี่ยน");
  for (const b of seen) {
    assert.equal(b.store, false);
    assert.equal(b.stream, false);
  }
});

// v1.2.2 (เคสจริง 2026-08-12: scorer 502 ทุกเทิร์น -> คะแนนความสนใจค้างที่เดิม):
// โมเดล reasoning หักโทเคนที่ใช้คิดจากงบ completion ก้อนเดียวกับข้อความที่ตอบออกมา
test("v1.2.3: โมเดล scorer ได้งบคิดแยกจากเส้นตอบลูกค้า", () => {
  // v1.4.2: default 2,000 — 800 เดิมทำให้โมเดล reasoning คิดจนงบหมด content ว่าง
  assert.deepEqual(completionTokenBudget("gpt-5.6-sol"), { fallback: 2_000, ceiling: SCORER_MAX_COMPLETION_TOKENS });
  for (const model of ["gpt-5.6-luna", "gpt-5.6-terra"]) {
    const budget = completionTokenBudget(model);
    assert.equal(budget.ceiling, SCORER_MAX_COMPLETION_TOKENS);
    assert.ok(budget.fallback > 2_000, `${model} ต้องมี headroom มากกว่าเส้นตอบลูกค้า`);
    assert.ok(budget.fallback <= budget.ceiling);
  }
});

// v1.2.3: โมเดลตัวเดียวถูกใช้ได้ทั้งตอบลูกค้าและให้คะแนน เพดานจึงต้องไม่ผูกกับชื่อโมเดล
// (บั๊กจริง: ย้าย scorer มาใช้ sol แล้วคำขอ budget 3000 ถูกปฏิเสธเป็น invalid_request)
test("v1.2.3: ผู้เรียกขอ budget ของ scorer ได้กับทุกโมเดลที่อนุญาต", async () => {
  const seen = [];
  await withGateway({
    fetchImpl: async (_url, init) => {
      seen.push(JSON.parse(init.body).max_completion_tokens);
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  }, async (base) => {
    for (const model of ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]) {
      const response = await fetch(`${base}/v1/chat/completions`, {
        method: "POST", headers: localHeaders(),
        body: JSON.stringify({ model, max_completion_tokens: 3000, messages: [{ role: "user", content: "x" }] }),
      });
      assert.equal(response.status, 200, `${model} ต้องรับงบของ scorer ได้`);
    }
  });
  assert.deepEqual(seen, [3000, 3000, 3000]);
});

/* ---- v1.4.9: เปิดรายการโมเดลผ่าน GATEWAY_ALLOWED_MODELS (roster จากไฟล์ราคา chassis) ---- */

test("v1.4.9: gatewayAllowedModels = แกนหลักเสมอ + รายการเพิ่มจาก env (trim/dedupe)", async () => {
  const { gatewayAllowedModels, CORE_MODELS } = await import("../openai-stateless-gateway.mjs");
  assert.deepEqual([...gatewayAllowedModels({})], [...CORE_MODELS], "ไม่มี env = แกน 3 ตัวเดิมเป๊ะ");
  const opened = gatewayAllowedModels({ GATEWAY_ALLOWED_MODELS: " gpt-5.5 ,gpt-5.4-nano,gpt-5.6-sol,,gpt-5.5 " });
  assert.deepEqual([...opened], ["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5", "gpt-5.4-nano"]);
});

test("v1.4.9: gateway ที่เปิด roster ยอมรับโมเดลขยาย แต่โมเดลนอกรายการยังโดน 400 เหมือนเดิม", async () => {
  const { gatewayAllowedModels } = await import("../openai-stateless-gateway.mjs");
  const allowedModels = gatewayAllowedModels({ GATEWAY_ALLOWED_MODELS: "gpt-5.5,gpt-5.4-nano" });
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(JSON.parse(options.body).model);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await withGateway({ allowedModels, fetchImpl }, async (base) => {
    const good = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: localHeaders(),
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "ping" }] }),
    });
    assert.equal(good.status, 200, "โมเดลขยายใน roster ต้องผ่าน");
    const bad = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: localHeaders(),
      body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "ping" }] }),
    });
    assert.equal(bad.status, 400, "โมเดลนอก roster ต้องโดนปฏิเสธโดยไม่ยิง upstream");
    const health = await (await fetch(`${base}/v1/models/health`, { headers: { authorization: localHeaders().authorization } })).json();
    assert.deepEqual(health.models, [...allowedModels], "health ต้องรายงาน roster ที่เปิดจริง");
  });
  assert.deepEqual(calls, ["gpt-5.5"], "upstream ต้องเห็นเฉพาะโมเดลที่ผ่านด่าน");
});

test("v1.4.9b: verifyProviderModels — แกนหลักหาย = ตายดัง / ตัวขยายหาย = ตัดทิ้ง+รายงาน ไม่ฆ่า boot", async () => {
  const { gatewayAllowedModels } = await import("../openai-stateless-gateway.mjs");
  const allowedModels = gatewayAllowedModels({ GATEWAY_ALLOWED_MODELS: "gpt-5.5,gpt-5.4-nano" });
  const providerList = (ids) => async () => new Response(
    JSON.stringify({ data: ids.map((id) => ({ id })) }),
    { status: 200, headers: { "content-type": "application/json" } });

  // ตัวขยายหาย (gpt-5.4-nano) — pilot ต้องยังขึ้นด้วยรายการที่เหลือ (บั๊ก high จากรีวิว:
  // id เก็งกำไรในไฟล์ราคาห้ามกลายเป็นสวิตช์ฆ่า boot ตอน restart)
  const partial = await verifyProviderModels({
    upstreamApiKey: TEST_PROVIDER_ACCESS, allowedModels,
    fetchImpl: providerList(["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5"]),
  });
  assert.deepEqual(partial.models, ["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.5"]);
  assert.deepEqual(partial.missing, ["gpt-5.4-nano"]);

  // แกนหลักหาย (terra) = ระบบพึ่งมันเป็น default/probe — ต้องไม่ผ่านเหมือนเดิม
  await assert.rejects(
    () => verifyProviderModels({ upstreamApiKey: TEST_PROVIDER_ACCESS, allowedModels, fetchImpl: providerList(["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4-nano"]) }),
    /provider_models_missing/);

  const ok = await verifyProviderModels({ upstreamApiKey: TEST_PROVIDER_ACCESS, allowedModels, fetchImpl: providerList([...allowedModels]) });
  assert.deepEqual(ok.models, [...allowedModels]);
  assert.deepEqual(ok.missing, []);
});

test("v1.4.9b: health ok ผูกกับแกน 3 ตัวเท่านั้น — โมเดลขยายพังห้าม pin ระบบ degraded", async () => {
  const { gatewayAllowedModels } = await import("../openai-stateless-gateway.mjs");
  const allowedModels = gatewayAllowedModels({ GATEWAY_ALLOWED_MODELS: "gpt-5.5" });
  // upstream ล้มเฉพาะ call ของ gpt-5.5 → latch เป็น false — ok รวมต้องยังเป็น true
  const fetchImpl = async (_url, options) => {
    const model = JSON.parse(options.body).model;
    if (model === "gpt-5.5") return new Response("bad", { status: 500 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  await withGateway({ allowedModels, fetchImpl }, async (base) => {
    await fetch(`${base}/v1/chat/completions`, {
      method: "POST", headers: localHeaders(),
      body: JSON.stringify({ model: "gpt-5.5", messages: [{ role: "user", content: "ping" }] }),
    });
    const health = await (await fetch(`${base}/v1/models/health`, { headers: { authorization: localHeaders().authorization } })).json();
    assert.equal(health.modelReadiness["gpt-5.5"], false, "รายตัวต้องรายงานตามจริง");
    assert.equal(health.providerInferenceReady, true, "แกน 3 ตัวยังพร้อม = ระบบพร้อม");
    assert.equal(health.ok, true, "โมเดลขยายพังห้ามดึง health ทั้งระบบลง");
  });
});

// ---- v1.4.27: prompt_cache_key ----
// เหตุ (วัดจริง 2026-08-19): prompt prefix เหมือนกันข้ามเทิร์น 98.2% แล้ว แต่ cache hit
// ยังได้แค่ 6% (draft 18 ครั้ง ติด 0% ทุกครั้ง) เพราะเกตเวย์ประกอบ body ใหม่แบบ allowlist
// จึงตัดฟิลด์นี้ทิ้ง — เอกสาร OpenAI: "For GPT-5.6, you must set prompt_cache_key"
// คีย์นี้เป็นแค่ตัว routing ไม่ใช่ช่องส่งเนื้อหา จึงต้องคุมรูปแบบให้แคบเสมอ
test("prompt_cache_key ผ่านได้เมื่อรูปแบบถูก และถูกปฏิเสธเมื่อมั่ว", async () => {
  const { sanitizeChatRequest } = await import("../openai-stateless-gateway.mjs");
  const base = { model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] };

  const passed = sanitizeChatRequest({ ...base, prompt_cache_key: "lukprae-hermes" });
  assert.equal(passed.prompt_cache_key, "lukprae-hermes", "คีย์ที่ถูกต้องต้องถูกส่งต่อขึ้น upstream");

  assert.equal(sanitizeChatRequest(base).prompt_cache_key, undefined, "ไม่ส่งมา = ไม่ต้องแนบ");

  for (const bad of ["มีภาษาไทย", "เว้น วรรค", "x".repeat(65), "quote\"inject", 12345, { a: 1 }]) {
    assert.throws(
      () => sanitizeChatRequest({ ...base, prompt_cache_key: bad }),
      /invalid_request/u,
      `ต้องปฏิเสธคีย์รูปแบบผิด: ${JSON.stringify(bad)}`,
    );
  }
});

// ---- v1.4.27: บล็อกข้อความ + cache breakpoint ----
// ด่านนี้คือที่เดียวที่กันของแปลกปลอมขึ้น upstream — เปิดทรงใหม่แล้วต้องแคบเท่าเดิม
test("เนื้อความรับได้ทั้งสตริงเดิมและบล็อกข้อความ แต่กันของแปลกปลอมทุกทาง", async () => {
  const { sanitizeChatRequest, MAX_CONTENT_BLOCKS } = await import("../openai-stateless-gateway.mjs");
  const wrap = (content) => sanitizeChatRequest({
    model: "gpt-5.6-sol",
    messages: [{ role: "system", content }, { role: "user", content: "hi" }],
  }).messages[0].content;

  assert.equal(wrap("ข้อความเดิม"), "ข้อความเดิม", "ทรงสตริงเดิมต้องไม่เปลี่ยนพฤติกรรม");

  const blocks = wrap([
    { type: "text", text: "ส่วนคงที่", prompt_cache_breakpoint: { mode: "explicit" } },
    { type: "text", text: "ส่วนที่เปลี่ยนทุกเทิร์น" },
  ]);
  assert.deepEqual(blocks, [
    { type: "text", text: "ส่วนคงที่", prompt_cache_breakpoint: { mode: "explicit" } },
    { type: "text", text: "ส่วนที่เปลี่ยนทุกเทิร์น" },
  ], "บล็อกที่ถูกต้องต้องผ่านครบและไม่มีคีย์งอก");

  // คีย์แปลกปลอมในบล็อกต้องถูกตัดทิ้ง ไม่ใช่ส่งต่อขึ้น upstream
  const stripped = wrap([{ type: "text", text: "a", image_url: "http://evil", extra: 1 }]);
  assert.deepEqual(stripped, [{ type: "text", text: "a" }], "ต้องเหลือเฉพาะ type/text");

  const bad = [
    [],                                                        // ว่าง
    [{ type: "image_url", image_url: { url: "http://x" } }],    // ชนิดที่ไม่อนุญาต
    [{ type: "text", text: 1 }],                                // text ไม่ใช่สตริง
    [{ type: "text", text: "a", prompt_cache_breakpoint: {} }],  // breakpoint ผิดรูป
    [{ type: "text", text: "a", prompt_cache_breakpoint: { mode: "implicit" } }],
    [{ type: "text", text: "a", prompt_cache_breakpoint: { mode: "explicit", extra: 1 } }],
    Array.from({ length: MAX_CONTENT_BLOCKS + 1 }, () => ({ type: "text", text: "a" })),
    123,
  ];
  for (const content of bad) {
    assert.throws(() => wrap(content), /invalid_request/u, `ต้องปฏิเสธ: ${JSON.stringify(content).slice(0, 60)}`);
  }

  // เพดานความยาวต้องนับ "รวมทุกบล็อก" ไม่งั้นซอยบล็อกเลี่ยงเพดานได้
  assert.throws(
    () => wrap([{ type: "text", text: "x".repeat(150_000) }, { type: "text", text: "y".repeat(150_000) }]),
    /message_too_long/u,
    "ซอยบล็อกต้องเลี่ยงเพดานไม่ได้",
  );
});

test("gateway ซ่อม Unicode ครึ่งตัวก่อนส่ง provider ทั้ง string และ content block", async () => {
  const { sanitizeChatRequest } = await import("../openai-stateless-gateway.mjs");
  // จำลอง String#slice ตรงกลาง emoji ซึ่งเป็นต้นเหตุ upstream invalid_json ใน FU จริง
  const broken = `${"ก".repeat(159)}😊`.slice(0, 160);
  assert.equal(broken.isWellFormed(), false, "fixture ต้องมี lone high surrogate จริง");

  const sanitized = sanitizeChatRequest({
    model: "gpt-5.6-sol",
    messages: [
      { role: "system", content: [{ type: "text", text: broken }] },
      { role: "user", content: broken },
    ],
  });

  assert.equal(sanitized.messages[0].content[0].text.isWellFormed(), true);
  assert.equal(sanitized.messages[1].content.isWellFormed(), true);
});

test("prompt_cache_options รับเฉพาะ mode ที่รู้จัก", async () => {
  const { sanitizeChatRequest } = await import("../openai-stateless-gateway.mjs");
  const base = { model: "gpt-5.6-sol", messages: [{ role: "user", content: "hi" }] };
  assert.deepEqual(sanitizeChatRequest({ ...base, prompt_cache_options: { mode: "explicit" } }).prompt_cache_options, { mode: "explicit" });
  assert.equal(sanitizeChatRequest(base).prompt_cache_options, undefined);
  for (const bad of [{ mode: "always" }, { mode: "explicit", ttl: "30m" }, "explicit", []]) {
    assert.throws(() => sanitizeChatRequest({ ...base, prompt_cache_options: bad }), /invalid_request/u);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// v1.4.48 (คำสั่งเจ้าของ 2026-08-29): ลูกแพรต้องดูรูปก่อนตัดสินว่าเป็นเรื่องเงินไหม
// เพราะลูกค้าส่งรูปโพสต์ของพี่ง้วงมาถามว่า "สอนอันนี้ไหม" บ่อยกว่าส่งสลิป
// แต่ระบบเดิมตีทุกรูปเป็นเรื่องเงิน ปิดปากบอท + ปักธงถาวรที่ปลดไม่ได้
//
// เกตเวย์นี้เป็นด่านสุดท้ายก่อนออกไป OpenAI จึงต้องคุมให้แคบที่สุดเท่าที่ใช้งานได้:
//   - รับเฉพาะ data: URI — ห้าม http/https เด็ดขาด ไม่งั้นกลายเป็นช่องให้ยิงไปโฮสต์อื่น
//     (ทั้ง SSRF ฝั่งเรา และการสั่งให้ OpenAI ไปดึงไฟล์จากที่ที่เราไม่ได้เลือก)
//   - รับเฉพาะ jpeg/png · 1 รูปต่อคำขอ · จำกัดขนาด
//   - ห้ามมีคีย์แปลกปลอมติดขึ้นไป (กติกาเดิมของไฟล์นี้)
import { MAX_IMAGE_BYTES, sanitizeContent as sanitizeContentImg } from "../openai-stateless-gateway.mjs";

const tinyPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("v1.4.48: รับบล็อกรูปแบบ data URI ได้ และไม่แตะข้อความเดิม", () => {
  const out = sanitizeContentImg([
    { type: "text", text: "รูปนี้คืออะไร" },
    { type: "image_url", image_url: { url: tinyPng } },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { type: "text", text: "รูปนี้คืออะไร" });
  assert.equal(out[1].type, "image_url");
  assert.equal(out[1].image_url.url, tinyPng);
  assert.deepEqual(Object.keys(out[1].image_url).sort(), ["url"], "ห้ามมีคีย์อื่นติดขึ้น upstream");
});

test("v1.4.48: ปฏิเสธรูปที่เป็นลิงก์ภายนอก — ห้ามให้ผู้เรียกเลือกโฮสต์ปลายทางเอง", () => {
  for (const url of [
    "https://example.com/a.jpg",
    "http://127.0.0.1:8080/a.png",
    "//evil.example/a.png",
    "file:///etc/passwd",
  ]) {
    assert.throws(() => sanitizeContentImg([{ type: "image_url", image_url: { url } }]),
      /message_shape|image/u, `ต้องปฏิเสธ: ${url}`);
  }
});

test("v1.4.48: รับเฉพาะ jpeg/png และต้องเป็น base64 จริง", () => {
  for (const url of [
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:image/gif;base64,R0lGODlhAQABAAAAACw=",
    "data:text/html;base64,PGgxPmhpPC9oMT4=",
    "data:image/png,notbase64",
  ]) {
    assert.throws(() => sanitizeContentImg([{ type: "image_url", image_url: { url } }]),
      /message_shape|image/u, `ต้องปฏิเสธ: ${url.slice(0, 40)}`);
  }
});

test("v1.4.48: จำกัดขนาดรูป และห้ามเกิน 1 รูปต่อข้อความ", () => {
  const huge = `data:image/jpeg;base64,${"A".repeat(MAX_IMAGE_BYTES + 4)}`;
  assert.throws(() => sanitizeContentImg([{ type: "image_url", image_url: { url: huge } }]), /image_too_large/u);
  assert.throws(() => sanitizeContentImg([
    { type: "image_url", image_url: { url: tinyPng } },
    { type: "image_url", image_url: { url: tinyPng } },
  ]), /too_many_images/u, "จำแนกรูปใช้ทีละใบ — หลายใบคือสัญญาณว่าใช้ผิดทาง");
});

test("v1.4.48: บล็อกรูปที่รูปทรงผิดต้องถูกปฏิเสธ", () => {
  for (const block of [
    { type: "image_url" },
    { type: "image_url", image_url: tinyPng },
    { type: "image_url", image_url: { url: tinyPng, detail: "high" } },
    { type: "image_url", image_url: { url: 123 } },
  ]) {
    assert.throws(() => sanitizeContentImg([block]), /message_shape/u);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// เหตุ 27 ก.ย. 2026 15:34–16:14: เครดิต OpenAI หมด ทุกคำขอได้ 429 insufficient_quota /
// credit_balance_exhausted แต่ log มีแค่ "upstream_status_429" แยกไม่ออกว่าเครดิตหมดหรือโดน
// rate limit ต้อง probe เองบน VPS — เกตเวย์ต้องบอก type/code (ตัวระบุสั้น ๆ เท่านั้น ห้ามข้อความ)
// และเก็บความล้มเหลวล่าสุดไว้ให้ /v1/models/health รายงาน
import { readUpstreamErrorIds } from "../openai-stateless-gateway.mjs";

const PRIVATE_MARKERS = /credits remaining|สมชาย|0812345678|ข้อความลับของลูกค้า/u;

function upstreamError(status, errorBody) {
  return new Response(JSON.stringify({ error: errorBody }), { status, headers: { "content-type": "application/json" } });
}

function creditExhausted() {
  return upstreamError(429, {
    // ข้อความจาก provider ถือว่าไม่ปลอดภัย (อาจสะท้อนเนื้อหาคำขอ) — ต้องไม่หลุดไปไหนเลย
    message: "You have no credits remaining. ลูกค้าชื่อสมชาย 0812345678",
    type: "insufficient_quota", param: null, code: "credit_balance_exhausted",
  });
}

function captureGatewayLog(t) {
  const lines = [];
  t.mock.method(console, "error", (...args) => { lines.push(args.map(String).join(" ")); });
  return lines;
}

async function postChat(base, model = "gpt-5.6-sol") {
  return fetch(`${base}/v1/chat/completions`, {
    method: "POST", headers: localHeaders(),
    body: JSON.stringify({ model, messages: [{ role: "user", content: "ข้อความลับของลูกค้า" }] }),
  });
}

async function readHealth(base) {
  return (await fetch(`${base}/v1/models/health`, { headers: { authorization: `Bearer ${TEST_LOCAL_ACCESS}` } })).json();
}

test("27 ก.ย.: เครดิตหมด — log บอก type/code, สถานะตอบกลับคงเดิม, ไม่มีข้อความจาก provider หลุด", async (t) => {
  const lines = captureGatewayLog(t);
  await withGateway({ fetchImpl: async () => creditExhausted() }, async (base) => {
    const fresh = await readHealth(base);
    assert.equal(fresh.lastUpstreamError, null, "ยังไม่มีอะไรล้ม = null");
    assert.deepEqual(fresh.modelFailures, {}, "ยังไม่มีโมเดลไหนค้าง");
    const response = await postChat(base);
    assert.equal(response.status, 429, "mapping เดิม: 429 -> 429");
    assert.equal((await response.json()).error.code, "upstream_rejected");
    const health = await readHealth(base);
    assert.equal(health.ok, false);
    assert.equal(health.modelReadiness["gpt-5.6-sol"], false);
    const { at, ...failure } = health.lastUpstreamError;
    assert.deepEqual(failure, {
      model: "gpt-5.6-sol", kind: "upstream_status", status: 429,
      type: "insufficient_quota", code: "credit_balance_exhausted",
    });
    assert.equal(new Date(at).toISOString(), at, "at ต้องเป็นเวลา ISO");
    assert.deepEqual(health.modelFailures, { "gpt-5.6-sol": health.lastUpstreamError }, "ค้างรายโมเดลตรงกับความล้มเหลวล่าสุด");
    assert.doesNotMatch(JSON.stringify(health), PRIVATE_MARKERS);
  });
  assert.deepEqual(lines, [
    "[gateway] gpt-5.6-sol -> upstream_status_429 type=insufficient_quota code=credit_balance_exhausted",
  ]);
  assert.doesNotMatch(lines.join("\n"), PRIVATE_MARKERS);
});

test("27 ก.ย.: mapping สถานะเดิมคงเดิมทุกตัว และ log มี type/code ต่อท้ายเมื่อ provider ให้มา", async (t) => {
  const lines = captureGatewayLog(t);
  const cases = [
    { status: 429, body: { type: "requests", code: "rate_limit_exceeded" }, expectStatus: 429, expectCode: "upstream_rejected",
      log: "[gateway] gpt-5.6-sol -> upstream_status_429 type=requests code=rate_limit_exceeded" },
    { status: 400, body: { type: "invalid_request_error", code: null }, expectStatus: 400, expectCode: "upstream_definitive_rejection",
      log: "[gateway] gpt-5.6-sol -> upstream_status_400 (definitive) type=invalid_request_error" },
    { status: 401, body: { type: "invalid_request_error", code: "invalid_api_key" }, expectStatus: 401, expectCode: "upstream_definitive_rejection",
      log: "[gateway] gpt-5.6-sol -> upstream_status_401 (definitive) type=invalid_request_error code=invalid_api_key" },
    { status: 500, body: { type: "server_error" }, expectStatus: 502, expectCode: "upstream_rejected",
      log: "[gateway] gpt-5.6-sol -> upstream_status_500 type=server_error" },
  ];
  for (const item of cases) {
    await withGateway({ fetchImpl: async () => upstreamError(item.status, { message: "ข้อความลับของลูกค้า", ...item.body }) }, async (base) => {
      const response = await postChat(base);
      assert.equal(response.status, item.expectStatus, `upstream ${item.status}`);
      assert.equal((await response.json()).error.code, item.expectCode);
    });
  }
  assert.deepEqual(lines, cases.map((item) => item.log));
  assert.doesNotMatch(lines.join("\n"), PRIVATE_MARKERS);
});

test("27 ก.ย.: type/code ที่ไม่ใช่ตัวระบุปลอดภัยถูกแทนด้วย unrecognized — กันฉีดบรรทัด log ปลอม", async (t) => {
  const lines = captureGatewayLog(t);
  await withGateway({ fetchImpl: async () => upstreamError(429, {
    message: "x", type: "insufficient quota\n[gateway] forged line", code: "ลูกค้า".repeat(20),
  }) }, async (base) => {
    await postChat(base);
    const failure = (await readHealth(base)).lastUpstreamError;
    assert.equal(failure.type, "unrecognized");
    assert.equal(failure.code, "unrecognized");
  });
  assert.deepEqual(lines, ["[gateway] gpt-5.6-sol -> upstream_status_429 type=unrecognized code=unrecognized"]);
});

test("27 ก.ย.: อ่าน error body แบบมีเพดาน — ใหญ่เกิน/ไม่ใช่ JSON/ช้าเกิน = ไม่รู้ ไม่ใช่พัง", async () => {
  const unknown = { type: null, code: null };
  const big = JSON.stringify({ error: { message: "x".repeat(5_000), type: "insufficient_quota", code: "credit_balance_exhausted" } });
  assert.deepEqual(await readUpstreamErrorIds(new Response(big, { status: 429 })), unknown, "เกิน 4 KB ต้องไม่ parse");
  assert.deepEqual(await readUpstreamErrorIds(new Response("<html>bad gateway</html>", { status: 502 })), unknown);
  assert.deepEqual(await readUpstreamErrorIds(new Response("", { status: 503 })), unknown);
  assert.deepEqual(await readUpstreamErrorIds(new Response(JSON.stringify({ error: "flat string" }), { status: 400 })), unknown);
  assert.deepEqual(
    await readUpstreamErrorIds(new Response(JSON.stringify({ error: { type: "insufficient_quota", code: 12 } }), { status: 429 })),
    { type: "insufficient_quota", code: "unrecognized" },
  );
  let cancelled = false;
  const stalled = new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; } }), { status: 429 });
  const startedAt = Date.now();
  assert.deepEqual(await readUpstreamErrorIds(stalled, { timeoutMs: 30 }), unknown, "body ค้างต้องไม่ถือคำตอบไว้");
  assert.ok(Date.now() - startedAt < 1_000);
  assert.equal(cancelled, true, "ต้องยกเลิกสตรีมที่ค้าง ไม่ทิ้ง socket ไว้");
});

test("27 ก.ย.: ความล้มเหลวที่ไม่มี HTTP status ก็ถูกบันทึกพร้อมชนิด", async () => {
  await withGateway({
    timeoutMs: 10,
    fetchImpl: async (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
  }, async (base) => {
    assert.equal((await postChat(base)).status, 504);
    const { at, ...failure } = (await readHealth(base)).lastUpstreamError;
    assert.deepEqual(failure, { model: "gpt-5.6-sol", kind: "upstream_timeout", status: null, type: null, code: null });
    assert.equal(typeof at, "string");
  });
  await withGateway({
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }), { status: 200 }),
  }, async (base) => {
    assert.equal((await postChat(base, "gpt-5.6-luna")).status, 502);
    const { at: _at, ...failure } = (await readHealth(base)).lastUpstreamError;
    assert.deepEqual(failure, { model: "gpt-5.6-luna", kind: "empty_content", status: 200, type: null, code: null });
  });
});

test("27 ก.ย.: เครดิตหมดเป็นเรื่องทั้งบัญชี — คำขอแรกที่สำเร็จคืนความพร้อมให้โมเดลที่ล้มเพราะเครดิตด้วย", async () => {
  // เคสจริงที่เป็นไปได้: เครดิตหมดตอน scorer ทำงาน -> luna ล้ม -> fallback terra ล้ม -> sol ล้ม
  // เติมเงินแล้ว ลูกค้าทักมา sol สำเร็จ + luna สำเร็จ แต่ terra (ตัวสำรอง) ไม่ถูกเรียกอีกเลย
  // ถ้าไม่คืนให้ health จะค้าง degraded ตลอดไปทั้งที่ระบบหายแล้ว
  let credit = false;
  await withGateway({ fetchImpl: async () => (credit
    ? new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 })
    : creditExhausted()) }, async (base) => {
    for (const model of ["gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6.1-sol"]) await postChat(base, model);
    const down = await readHealth(base);
    assert.deepEqual(down.modelReadiness, { "gpt-6.1-sol": false, "gpt-5.6-sol": false, "gpt-5.6-luna": false, "gpt-5.6-terra": false });
    credit = true;
    assert.equal((await postChat(base, "gpt-5.6-sol")).status, 200);
    const up = await readHealth(base);
    assert.deepEqual(up.modelReadiness, { "gpt-6.1-sol": true, "gpt-5.6-sol": true, "gpt-5.6-luna": true, "gpt-5.6-terra": true });
    assert.equal(up.ok, true);
    assert.equal(up.lastUpstreamError.code, "credit_balance_exhausted", "ประวัติความล้มเหลวล่าสุดยังอ่านได้");
    assert.deepEqual(up.modelFailures, {}, "หายค้างทุกตัวที่ล้มเพราะเครดิต");
  });
});

test("27 ก.ย.: ความล้มเหลวเฉพาะโมเดล (ไม่ใช่เครดิต) ห้ามถูกคืนความพร้อมเพราะโมเดลอื่นสำเร็จ", async () => {
  let phase = "terra_bad_request";
  await withGateway({ fetchImpl: async (_url, init) => {
    const model = JSON.parse(init.body).model;
    if (phase === "terra_bad_request" && model === "gpt-5.6-terra") return upstreamError(400, { type: "invalid_request_error", code: "unsupported_parameter" });
    if (phase === "no_credit") return creditExhausted();
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  } }, async (base) => {
    await postChat(base, "gpt-5.6-terra");
    phase = "no_credit";
    await postChat(base, "gpt-5.6-luna");
    phase = "credit_back";
    await postChat(base, "gpt-5.6-sol");
    const health = await readHealth(base);
    assert.equal(health.modelReadiness["gpt-5.6-sol"], true);
    assert.equal(health.modelReadiness["gpt-5.6-luna"], true, "luna ล้มเพราะเครดิต -> คืนได้");
    assert.equal(health.modelReadiness["gpt-5.6-terra"], false, "terra ล้มเพราะคำขอผิด -> ต้องค้างจนกว่าจะสำเร็จเอง");
    assert.equal(health.ok, false);
    assert.deepEqual(Object.keys(health.modelFailures), ["gpt-5.6-terra"]);
    assert.equal(health.modelFailures["gpt-5.6-terra"].code, "unsupported_parameter");
  });
});

test("27 ก.ย. (รีวิว): ความล้มเหลวเรื่องอื่นของโมเดลอื่นต้องไม่ลบร่องรอยเครดิตหมดของโมเดลที่ยังค้าง", async () => {
  // luna ล้มเพราะเครดิต แล้ว sol ต่อ upstream ไม่ได้ตามมา — ช่อง lastUpstreamError ช่องเดียวจะถูกทับ
  // chassis จึงต้องมีรายการค้างรายโมเดลให้อ่าน ไม่งั้นบอกเหตุเครดิตหมดไม่ได้ทั้งที่ luna ยังค้างเพราะเครดิต
  await withGateway({ fetchImpl: async (_url, init) => {
    if (JSON.parse(init.body).model === "gpt-5.6-luna") return creditExhausted();
    throw new TypeError("fetch failed");
  } }, async (base) => {
    await postChat(base, "gpt-5.6-luna");
    assert.equal((await postChat(base, "gpt-5.6-sol")).status, 502);
    const health = await readHealth(base);
    assert.equal(health.lastUpstreamError.model, "gpt-5.6-sol", "ประวัติล่าสุดคือ sol");
    assert.equal(health.lastUpstreamError.kind, "upstream_unreachable");
    assert.deepEqual(Object.keys(health.modelFailures).sort(), ["gpt-5.6-luna", "gpt-5.6-sol"]);
    assert.equal(health.modelFailures["gpt-5.6-luna"].code, "credit_balance_exhausted", "ร่องรอยเครดิตของ luna ต้องยังอยู่");
    assert.equal(health.modelFailures["gpt-5.6-sol"].kind, "upstream_unreachable");
  });
});
