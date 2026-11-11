// เกตเวย์ตอบด้วยรุ่นสำรองแทน Claude (4 ต.ค. 2026) — llm_usage ต้องจดรุ่นที่ตอบจริง ไม่งั้นค่าใช้จ่ายคิดเป็นราคา Claude
import test from "node:test";
import assert from "node:assert/strict";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { testConfig } from "./helpers.mjs";

const silent = { log() {}, warn() {}, debug() {}, error() {}, info() {} };
const fetchWith = (headers) => async () => ({
  ok: true, status: 200, headers: new Headers(headers),
  json: async () => ({ choices: [{ message: { content: "{\"score\":5}" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
});
const bridge = (headers) => createHermesBridge({ config: testConfig({ HERMES_SCORER_MODEL: "claude-sonnet-5-5" }), fetchImpl: fetchWith(headers), logger: silent });

test("ตอบด้วยรุ่นสำรอง = คืนรุ่นที่ตอบจริงให้จดค่าใช้จ่าย", async () => {
  const result = await bridge({ "x-lukprae-fallback-from": "claude-sonnet-5-5", "x-lukprae-served-model": "gpt-6.1-sol" })
    .scoreCustomer({ system: "s", transcript: "t" });
  assert.equal(result.model, "gpt-6.1-sol");
});

test("หัว served-model ที่ถูกต้องชนะรุ่นที่ขอเสมอ; หัวแปลกคงรุ่นที่ขอ", async () => {
  const requested = (await bridge({}).scoreCustomer({ system: "s", transcript: "t" })).model;
  assert.equal((await bridge({ "x-lukprae-served-model": "gpt-6.1-sol" }).scoreCustomer({ system: "s", transcript: "t" })).model, "gpt-6.1-sol");
  assert.equal((await bridge({ "x-lukprae-fallback-from": "claude-sonnet-5-5", "x-lukprae-served-model": "GPT 6.1 <x>" })
    .scoreCustomer({ system: "s", transcript: "t" })).model, requested);
});
