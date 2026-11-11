import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { previewStagedFollowup } from "../src/stagedFollowups.mjs";
import { classifyServiceIntent, nextServiceState, serviceBoundaryReply, serviceBoundaryState, serviceFollowupPaused } from "../src/serviceBoundary.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };
const row = state => ({ service_boundary_json: JSON.stringify(state) });

test("explicit creative requests are bounded, not inferred from retirement, budget or generic learning", () => {
  for (const text of ["ช่วยแต่งเพลงให้หน่อย", "เขียนบทละครสิบตอนให้หน่อยค่ะ", "สอนแต่งเพลงหน่อย", "สอนการแต่งละคร", "ช่วยสอนวิธีแต่งเพลง", "ทำคอนเทนต์ให้หน่อย", "ช่วยเขียนบทความทั้งเรื่อง", "ช่วยแต่งเพลงให้หน่อยได้ไหม"]) {
    assert.equal(classifyServiceIntent(text, {})?.kind, "work", text);
  }
  for (const text of ["เกษียณแล้ว อยากหารายได้", "ไม่มีงบค่ะ", "ไม่ต้องแต่งเพลงให้", "อยากใช้ AI เขียนบทละคร", "ช่วยแต่งเพลงในคลาสได้ไหม", "แต่งเพลงทำได้ไหม", "ทำเพลงได้ไหม", "เขียนบทละครได้มั้ย", 'ลูกค้าถามว่า "ช่วยแต่งเพลงให้หน่อย"', "บริษัทมีทีมทำคอนเทนต์ค่ะ"]) {
    assert.equal(classifyServiceIntent(text, {}), null, text);
  }
  for (const text of ["อยากเรียนแต่งเพลงค่ะ", "สนใจคลาสค่ะ", "คอร์สนี้ราคาเท่าไหร่", "ค่าเรียนกี่บาท", "เรียนวันไหน", "ขอสมัครเรียนค่ะ"]) {
    assert.equal(classifyServiceIntent(text, {})?.kind, "learning", text);
  }
});

test("only real current learning interest resumes; buttons/negation do not", () => {
  const customer = row({ topic: "song", paused: true, used: { song: true } });
  assert.equal(classifyServiceIntent("ขออีกเพลง", customer)?.topic, "song");
  assert.equal(classifyServiceIntent("ขออีกเพลง", {}), null);
  assert.equal(classifyServiceIntent("สนใจคลาส", customer, { preset: true }), null);
  assert.equal(classifyServiceIntent("ราคาเท่าไหร่", customer), null, "ambiguous service price is not proof of course interest");
  assert.equal(classifyServiceIntent("ไม่สนใจคลาส อยากให้แต่งเพลงฟรี", customer), null);
  const resumed = nextServiceState(customer, { kind: "learning" });
  assert.equal(resumed.paused, false);
  assert.equal(resumed.used.song, true, "resume does not reset the example budget");
});

test("state is bounded and holds no raw customer text; malformed state is tolerated", () => {
  assert.deepEqual(serviceBoundaryState({ service_boundary_json: "not json" }), { topic: "", paused: false, used: {} });
  assert.deepEqual(serviceBoundaryState(row({ topic: "song", paused: true, used: { song: true, injected: true }, customer: "private" })), { topic: "song", paused: true, used: { song: true } });
});

test("one short example then boundary without repeating qualification question", () => {
  const intent = { kind: "work", topic: "song" };
  const first = serviceBoundaryReply(intent, {});
  assert.match(first.text, /ตัวอย่าง/);
  assert.ok(Array.from(first.text).length < 550);
  const second = serviceBoundaryReply(intent, row({ used: { song: true } }));
  assert.doesNotMatch(second.text, /เช้าวันพรุ่งนี้|\?/);
  assert.match(second.text, /อยู่นอกขอบเขต/);
});

function world({ enabled = true, lineFetch = lineFetchStub(), env = {} } = {}) {
  const db = memoryDb();
  const hermesFetch = hermesFetchStub("คลาสช่วยฝึกใช้ AI กับโจทย์งานค่ะ สนใจหัวข้อไหนคะ?");
  const app = createApp({ config: testConfig({ SERVICE_BOUNDARY_ENABLED: String(enabled), ...env }), db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {} }, logger: silent });
  return { db, app, hermesFetch, lineFetch };
}

test("pipeline: example and repeat use no model; new learning resumes without losing budget", async () => {
  const w = world();
  try {
    const id = "service-fixture";
    const send = text => w.app.pipeline.handleInboundText({ customerId: id, text, replyToken: "fixture" });
    assert.equal((await send("ช่วยแต่งเพลงให้หน่อย")).sent, true);
    assert.equal(w.hermesFetch.calls.length, 0);
    assert.equal(w.db.getCustomer(id).ai_enabled, 1);
    assert.equal(serviceFollowupPaused(w.db.getCustomer(id)), true);
    assert.equal(serviceBoundaryState(w.db.getCustomer(id)).used.song, true);
    assert.equal((await send("ขออีกเพลง")).sent, true);
    assert.equal(w.hermesFetch.calls.length, 0);
    assert.deepEqual(previewStagedFollowup({ customer: w.db.getCustomer(id) }), { blocked: "service_boundary" });
    assert.equal((await send("สนใจคลาสค่ะ")).sent, true);
    assert.equal(serviceFollowupPaused(w.db.getCustomer(id)), false);
    assert.ok(w.hermesFetch.calls.length > 0);
    assert.equal(serviceBoundaryState(w.db.getCustomer(id)).used.song, true);
  } finally { w.db.close(); }
});

test("feature default/off preserves old path", async () => {
  assert.equal(testConfig().serviceBoundaryEnabled, false);
  const w = world({ enabled: false });
  try {
    await w.app.pipeline.handleInboundText({ customerId: "off-fixture", text: "ช่วยแต่งเพลงให้หน่อย", replyToken: "rt" });
    assert.ok(w.hermesFetch.calls.length > 0);
    assert.equal(serviceFollowupPaused(w.db.getCustomer("off-fixture")), false);
  } finally { w.db.close(); }
});

test("AI-off and manual follow-up-off survive resuming class interest", async () => {
  const w = world();
  try {
    const id = "human-owned-fixture";
    w.db.upsertCustomer(id, {});
    w.db.setAiEnabled(id, false);
    w.db.setFollowupEnabled(id, false);
    w.db.setServiceBoundaryState(id, { topic: "song", paused: true, used: { song: true } });
    const result = await w.app.pipeline.handleInboundText({ customerId: id, text: "สนใจคลาสค่ะ" });
    assert.equal(result.sent, undefined);
    assert.equal(w.db.getCustomer(id).ai_enabled, 0);
    assert.equal(w.db.getCustomer(id).followup_enabled, 0);
    assert.equal(serviceFollowupPaused(w.db.getCustomer(id)), false);
    assert.equal(w.lineFetch.calls.length, 0);
  } finally { w.db.close(); }
});

test("no delivery does not consume an example", async () => {
  const failedLine = async () => ({ ok: false, status: 429, json: async () => ({ message: "fixture" }), text: async () => "fixture" });
  const w = world({ lineFetch: failedLine });
  try {
    await w.app.pipeline.handleInboundText({ customerId: "failed-fixture", text: "ช่วยแต่งเพลงให้หน่อย", replyToken: "rt" });
    assert.equal(serviceBoundaryState(w.db.getCustomer("failed-fixture")).used.song, undefined);
  } finally { w.db.close(); }
});

test("operator can release this hold explicitly without resetting examples", () => {
  const db = memoryDb();
  try {
    db.upsertCustomer("operator-fixture", {});
    db.setServiceBoundaryState("operator-fixture", { topic: "song", paused: true, used: { song: true } });
    db.setFollowupEnabled("operator-fixture", true);
    assert.equal(serviceFollowupPaused(db.getCustomer("operator-fixture")), false);
    assert.equal(serviceBoundaryState(db.getCustomer("operator-fixture")).used.song, true);
  } finally { db.close(); }
});

test("customer reset clears the example budget and hold", () => {
  const db = memoryDb();
  try {
    db.upsertCustomer("reset-fixture", {});
    db.setServiceBoundaryState("reset-fixture", { topic: "song", paused: true, used: { song: true } });
    db.resetCustomer("reset-fixture");
    assert.deepEqual(serviceBoundaryState(db.getCustomer("reset-fixture")), { topic: "", paused: false, used: {} });
  } finally { db.close(); }
});

test("training reset clears state without leaking the old budget into a new session", () => {
  const db = memoryDb();
  try {
    db.upsertCustomer("training-fixture", {});
    db.setServiceBoundaryState("training-fixture", { topic: "story", paused: true, used: { story: true } });
    db.rotateTrainingSession({ customerId: "training-fixture", resetEventId: "reset-service-fixture" });
    assert.deepEqual(serviceBoundaryState(db.getCustomer("training-fixture")), { topic: "", paused: false, used: {} });
  } finally { db.close(); }
});

test("Facebook channel uses the same bounded reply and follow-up hold", async () => {
  const w = world({ env: { FB_ENABLED: "true", FB_MOCK_URL: "http://facebook.mock", FB_LIVE_SEND: "false" } });
  try {
    const id = "facebook:service-fixture";
    w.db.upsertCustomer(id, { channelId: "facebook" });
    w.db.insertMessage({ customerId: id, direction: "in", content: "ช่วยแต่งเพลงให้หน่อย" });
    const result = await w.app.pipeline.handleInboundText({ customerId: id, text: "ช่วยแต่งเพลงให้หน่อย" });
    assert.equal(result.sent, true);
    assert.equal(w.hermesFetch.calls.length, 0);
    assert.equal(serviceFollowupPaused(w.db.getCustomer(id)), true);
    assert.ok(w.lineFetch.calls.some(call => call.url.startsWith("http://facebook.mock")));
    assert.equal(serviceBoundaryState(w.db.getCustomer(id)).used.song, true);
  } finally { w.db.close(); }
});

test("partial text delivery consumes the example; never repeat it after a later push fails", async () => {
  let pushes = 0;
  const w = world({ lineFetch: async url => {
    const ok = !String(url).includes("/message/push") || ++pushes === 1;
    return { ok, status: ok ? 200 : 429, json: async () => ({}), text: async () => "fixture" };
  } });
  try {
    await w.app.pipeline.handleInboundText({ customerId: "partial-fixture", text: "ช่วยแต่งเพลงให้หน่อย" });
    assert.ok(pushes >= 2);
    assert.equal(serviceBoundaryState(w.db.getCustomer("partial-fixture")).used.song, true);
  } finally { w.db.close(); }
});

test("request for a human takes precedence over the creative-help example", async () => {
  const w = world();
  try {
    const id = "handoff-service-fixture";
    await w.app.pipeline.handleInboundText({ customerId: id, text: "ช่วยแต่งเพลงให้หน่อย ขอคุยกับคนจริง", replyToken: "rt" });
    assert.equal(serviceBoundaryState(w.db.getCustomer(id)).used.song, undefined);
    assert.equal(w.hermesFetch.calls.length, 0);
    assert.doesNotMatch(JSON.stringify(w.lineFetch.sends), /เช้าวันพรุ่งนี้/);
    assert.equal(w.db.getCustomer(id).state, "NEEDS_HUMAN");
  } finally { w.db.close(); }
});

test("budget write failure after delivery never loses the sent-message record", async () => {
  const w = world();
  try {
    const original = w.db.setServiceBoundaryState.bind(w.db);
    w.db.setServiceBoundaryState = (id, state) => {
      if (state.used?.song) throw new Error("fixture auxiliary write failure");
      return original(id, state);
    };
    const id = "budget-write-fixture";
    const result = await w.app.pipeline.handleInboundText({ customerId: id, text: "ช่วยแต่งเพลงให้หน่อย", replyToken: "rt" });
    assert.equal(result.sent, true);
    assert.ok(w.db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id = ? AND direction = 'out'").get(id).n > 0);
  } finally { w.db.close(); }
});
