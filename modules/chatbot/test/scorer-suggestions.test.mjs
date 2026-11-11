import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { buildScorerSystem } from "../src/scoring.mjs";
import { SCORER_SUGGESTIONS_KEY, scorerSuggestionsEnabled, withoutScorerSuggestions } from "../src/scorerSuggestions.mjs";
import { scorerSuggestionsControl } from "../public/console/settings.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, listen, httpRequest, promptText } from "./helpers.mjs";
poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };
const ADVICE = "คำแนะนำสังเคราะห์สำหรับทีมงานเท่านั้น";
const QUESTION = "คำถามสังเคราะห์สำหรับทีมงานค่ะ";
const PAYLOAD = { score: 7, trend: "flat", buying_signals: ["แจ้งเป้าหมาย"], persona_read: { disc: "unknown", bank: "unknown", reason: "" },
  persona_type: "office_worker", pain_point: "อยากใช้ AI ช่วยสรุปงาน", context_summary: "ผู้ทดสอบต้องการใช้ AI ช่วยสรุปงานค่ะ",
  next_move: ADVICE, suggested_question: QUESTION, tags: ["สนใจคลาส AI"] };
const PASSWORD = "synthetic-advice-test-password";
const PASS_HASH = hashPassword(PASSWORD);

function world(t, { onCall, fallback = false } = {}) {
  const db = memoryDb();
  const base = hermesFetchStub(JSON.stringify(PAYLOAD), { onCall: call => onCall?.({ db, call }) });
  let n = 0;
  const fetchImpl = async (...args) => {
    const response = await base(...args);
    if (fallback && n++ === 0) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "invalid score" } }] }) };
    return response;
  };
  const line = lineFetchStub();
  const app = createApp({ db, config: testConfig({ CONSOLE_SESSION_SECRET: "synthetic-suggestions-secret-long", CONSOLE_COOKIE_SECURE: "false",
    HERMES_SCORER_MODEL: "gpt-5.6-luna", HERMES_SCORER_FALLBACK_MODEL: fallback ? "gpt-5.6-terra" : "", HERMES_SCORER_ALLOWED_MODELS: "gpt-5.6-luna,gpt-5.6-terra" }),
    overrides: { hermesFetch: fetchImpl, lineFetch: line, sleep: async () => {} }, logger: silent });
  const id = "synthetic-advice-room";
  db.upsertCustomer(id, {});
  db.setKnownName(id, "ผู้ทดสอบ");
  db.insertMessage({ customerId: id, direction: "in", content: "ทำงานประจำ อยากใช้ AI สรุปงานค่ะ" });
  t.after(() => { app.server.close(); db.close(); });
  return { db, app, id, calls: base.calls, line };
}

test("advice defaults OFF; invalid/missing setting or read failure never enables it", t => {
  const db = memoryDb(); t.after(() => db.close());
  for (const value of ["", "0", "true", "yes", "garbage"]) {
    db.setSetting(SCORER_SUGGESTIONS_KEY, value);
    assert.equal(scorerSuggestionsEnabled(db), false);
  }
  db.setSetting(SCORER_SUGGESTIONS_KEY, "1");
  assert.equal(scorerSuggestionsEnabled(db), true);
  assert.equal(scorerSuggestionsEnabled({ getSetting() { throw Error("offline"); } }), false);
});

test("OFF removes advice instructions/schema, not scoring or customer memory", () => {
  const off = buildScorerSystem({ suggestionsEnabled: false });
  const on = buildScorerSystem({ suggestionsEnabled: true });
  assert.doesNotMatch(off, /next_move|suggested_question|neuro-marketing/);
  assert.match(on, /next_move/); assert.match(on, /suggested_question/);
  assert.ok(off.length < on.length);
  for (const key of ["score", "trend", "context_summary", "persona_type", "pain_point", "tags"]) assert.ok(off.includes(`"${key}"`));
  const stripped = withoutScorerSuggestions(PAYLOAD);
  assert.equal(stripped.next_move, undefined); assert.equal(stripped.suggested_question, undefined);
  assert.equal(stripped.context_summary, PAYLOAD.context_summary);
  assert.equal(PAYLOAD.next_move, ADVICE, "do not mutate historical rows");
});

for (const enabled of [false, true]) test(`real scoring pipeline: advice ${enabled ? "ON" : "OFF"}, one call and score/memory intact`, async t => {
  const w = world(t);
  if (enabled) w.db.setSetting(SCORER_SUGGESTIONS_KEY, "1");
  const result = await w.app.pipeline.scoreBurst(w.id);
  assert.equal(w.calls.length, 1);
  const prompt = promptText(w.calls[0].body.messages[0].content);
  assert.equal(prompt.includes('"suggested_question"'), enabled);
  assert.equal(result.next_move, enabled ? ADVICE : undefined);
  assert.equal(result.suggested_question, enabled ? QUESTION : undefined);
  assert.ok(Number.isInteger(result.score));
  assert.equal(result.context_summary, PAYLOAD.context_summary);
  assert.ok(w.db.listHandoffNotes(w.id).some(n => n.text === PAYLOAD.context_summary));
  const stored = JSON.parse(w.db.latestScoreRow(w.id).payload_json);
  assert.equal(stored.next_move, enabled ? ADVICE : undefined);
  assert.equal(w.db.llmUsageForCustomer(w.id).length, 1);
  assert.equal(w.line.sends.length, 0, "scoring never becomes a customer send");
});

for (const initiallyOn of [true, false]) test(`toggle during scoring (${initiallyOn}): no stale/unsolicited advice persists`, async t => {
  const w = world(t, { onCall: ({ db }) => db.setSetting(SCORER_SUGGESTIONS_KEY, initiallyOn ? "0" : "1") });
  w.db.setSetting(SCORER_SUGGESTIONS_KEY, initiallyOn ? "1" : "0");
  const result = await w.app.pipeline.scoreBurst(w.id);
  assert.equal(result.next_move, undefined); assert.equal(result.suggested_question, undefined);
  assert.equal(result.context_summary, PAYLOAD.context_summary);
});

test("fallback scoring inherits the OFF request, without an advice-only call", async t => {
  const w = world(t, { fallback: true });
  const result = await w.app.pipeline.scoreBurst(w.id);
  assert.equal(w.calls.length, 2);
  for (const call of w.calls) assert.doesNotMatch(promptText(call.body.messages[0].content), /next_move|suggested_question/);
  assert.equal(result.next_move, undefined);
  assert.equal(result.context_summary, PAYLOAD.context_summary);
});

for (const enabled of [false, true]) test(`advice ${enabled ? "ON" : "OFF"} does not disable normal customer replies`, async t => {
  const db = memoryDb();
  const hermes = hermesFetchStub("ช่วยแนะนำคลาสให้เหมาะกับงานได้ค่ะ อยากใช้ AI ช่วยงานด้านไหนคะ");
  const line = lineFetchStub();
  const app = createApp({ db, config: testConfig(), logger: silent,
    overrides: { hermesFetch: hermes, lineFetch: line, sleep: async () => {} } });
  t.after(() => { app.server.close(); db.close(); });
  db.setSetting(SCORER_SUGGESTIONS_KEY, enabled ? "1" : "0");
  const result = await app.pipeline.handleInboundText({ customerId: "synthetic-reply", text: "สนใจเรียน AI ค่ะ", replyToken: "synthetic-reply-token" });
  assert.equal(result.sent, true);
  assert.equal(hermes.calls.length, 1);
  assert.ok(line.sends.length > 0);
  assert.ok(db.messagesFor("synthetic-reply").some(m => m.direction === "out" && m.message_class === "reactive"));
});

async function request(server, method, path, body, auth = {}) {
  return httpRequest(server, { method, path, headers: { "content-type": "application/json", ...auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("settings API: owner/CSRF/validation/audit/readback; no model call; stale advice hidden from room API", async t => {
  const w = world(t);
  w.db.createOperator({ username: "owner-test", passHash: PASS_HASH, role: "owner", displayName: "Owner test" });
  w.db.createOperator({ username: "admin-test", passHash: PASS_HASH, role: "admin", displayName: "Admin test" });
  await listen(w.app.server);
  const login = async username => {
    const r = await request(w.app.server, "POST", "/console/api/login", { username, password: PASSWORD });
    assert.equal(r.status, 200);
    return { cookie: r.headers["set-cookie"][0].split(";")[0], "x-csrf-token": r.json.csrf };
  };
  const path = "/console/api/settings/suggestions", owner = await login("owner-test"), admin = await login("admin-test");
  assert.equal((await request(w.app.server, "GET", path)).status, 401);
  assert.equal((await request(w.app.server, "POST", path, { enabled: true }, admin)).status, 403);
  assert.equal((await request(w.app.server, "POST", path, { enabled: true }, { cookie: owner.cookie })).status, 403);
  for (const value of ["1", 1, null]) assert.equal((await request(w.app.server, "POST", path, { enabled: value }, owner)).status, 400);
  for (const body of [null, [], {}, "invalid"]) assert.equal((await request(w.app.server, "POST", path, body, owner)).status, 400);
  assert.equal((await request(w.app.server, "GET", path, undefined, owner)).json.enabled, false);
  w.db.recordScore(w.id, 7, JSON.stringify(PAYLOAD));
  const roomPath = `/console/api/conversations/${w.id}/messages`;
  assert.equal((await request(w.app.server, "GET", roomPath, undefined, owner)).json.score.payload.next_move, undefined);
  assert.equal((await request(w.app.server, "POST", path, { enabled: true }, owner)).json.enabled, true);
  assert.equal((await request(w.app.server, "GET", "/console/api/models", undefined, owner)).json.suggestionsEnabled, true);
  assert.equal((await request(w.app.server, "GET", roomPath, undefined, owner)).json.score.payload.suggested_question, QUESTION);
  assert.equal((await request(w.app.server, "POST", path, { enabled: false }, owner)).json.enabled, false);
  assert.equal((await request(w.app.server, "GET", roomPath, undefined, owner)).json.score.payload.next_move, undefined);
  assert.equal(JSON.parse(w.db.latestScoreRow(w.id).payload_json).next_move, ADVICE, "history not erased");
  assert.equal(w.db.listAudit().filter(a => a.action === "scorer_suggestions_toggle").length, 2);
  assert.equal(w.calls.length, 0); assert.equal(w.line.sends.length, 0);
  assert.equal(w.db.getSetting("reply_model"), null);
  assert.equal(w.db.getSetting("staged_followup_enabled"), null);
});

test("suggestion UI waits for readback and retains the same form; errors do not fake success", async t => {
  const { doc: document } = installBrowserGlobals(t);
  const calls = [], notices = []; let fail = false;
  const block = scorerSuggestionsControl({ api: async (url, options) => {
    calls.push({ url, ...options }); if (fail) throw Error("test unavailable"); return { enabled: options.body.enabled };
  }, toast: text => notices.push(text) });
  document.body.append(block);
  const button = block.querySelector("button");
  assert.equal(button.getAttribute("aria-checked"), "false");
  await button.listeners.click[0]();
  assert.equal(button.getAttribute("aria-checked"), "true");
  assert.equal(block.querySelector("button"), button);
  fail = true; await button.listeners.click[0]();
  assert.equal(button.getAttribute("aria-checked"), "true");
  assert.equal(notices.at(-1), "test unavailable");
  fail = false; await button.listeners.click[0]();
  assert.equal(button.getAttribute("aria-checked"), "false");
  assert.equal(button.disabled, false);
  assert.equal(calls[0].body.enabled, true);
});

test("visible settings placeholders and help contain no unrelated purifier examples", () => {
  const guide = readFileSync(new URL("../public/console/guide-tags.html", import.meta.url), "utf8");
  assert.doesNotMatch(guide, /airdog|x[358]\s*pro|ไส้กรอง|เครื่องฟอก|สัตว์เลี้ยง/iu);
  for (const name of ["settings.mjs", "context.mjs"]) {
    const source = readFileSync(new URL(`../public/console/${name}`, import.meta.url), "utf8");
    const placeholders = [...source.matchAll(/placeholder:\s*"([^"]*)"/gu)].map(m => m[1]).join("\n");
    assert.doesNotMatch(placeholders, /airdog|x[358]\s*pro/iu);
  }
});
