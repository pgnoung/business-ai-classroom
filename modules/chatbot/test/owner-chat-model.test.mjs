// owner-chat-model — แชทเจ้าของใช้ Luna เป็นค่าตั้งต้น + วงค้นข้อมูลก่อนตอบ (28 ก.ย. 2026 บ่าย)
// "ลองปรับ telegram เป็น luna ได้ไหม · แล้ว สามารถลิ้งค์ไวๆ กับ สมองลูกแพร เพื่อดูข้อมูล พี่ง้วง สอบถาม วิเคราะห์ ได้ไหม"
// · hermes: draftWithModel ยิงโมเดล/effort/งบที่ขอ รูปข้อความเดียวกับ draftReply · ไม่แตะโมเดลตอบลูกค้า
// · คุยเล่นไม่วางแผนค้น · ถามข้อมูล = ค้นก่อนแล้วตอบจาก "ผลค้นข้อมูล" · ลิงก์ห้องแนบเฉพาะห้องที่เอ่ยถึง
// · sol = ทางเดิม · luna ไม่ตอบ = ถอยไป sol หนึ่งครั้ง · เพดานนับทุกครั้งที่เรียกโมเดล
import test from "node:test";
import assert from "node:assert/strict";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createOwnerChat, ownerChatRef, OWNER_CHAT_CAP_TEXT, OWNER_CHAT_DAILY_CAP, OWNER_CHAT_FALLBACK_TEXT } from "../src/ownerChat.mjs";
import { memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const NOON = Date.UTC(2026, 8, 28, 5, 0, 0);
const HOUR = 3_600_000;
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const OWNER = { userId: "434343" };
const PLANNER_MARK = "read-only database lookups";

/* ------------------------------- hermes bridge ------------------------------- */

function gateway({ failFirst = 0 } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url: String(url), headers: { ...opts.headers }, body: JSON.parse(opts.body) });
    if (calls.length <= failFirst) return { ok: false, status: 502, json: async () => ({}) };
    return { ok: true, status: 200, headers: { get: () => "" }, json: async () => ({ choices: [{ message: { content: "ค่ะพี่ง้วง" } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) };
  };
  fn.calls = calls;
  return fn;
}

test("hermes.draftWithModel: โมเดล/effort/งบตามที่ขอ · รูปข้อความเดียวกับ draftReply · ไม่มีหัว mirror · โมเดลนอกรายการระบบ = ไม่ยิง", async () => {
  const config = testConfig({
    HERMES_API_KEY: "test-key", HERMES_ALLOWED_MODELS: "gpt-5.6-sol,gpt-5.6-luna", HERMES_REPLY_ALLOWED_MODELS: "gpt-5.6-sol",
  });
  const fetchImpl = gateway();
  const bridge = createHermesBridge({ config, fetchImpl, logger: silent, getReplyModel: () => "gpt-5.6-luna" });
  const parts = { persona: "บุคลิก", knowledge: "ความรู้", brandPack: "", rules: "ข้อมูลสด", history: [{ role: "user", content: "ก่อนหน้า" }], userText: "ยอดวันนี้" };

  const luna = await bridge.draftWithModel({ ...parts, model: "gpt-5.6-luna", reasoningEffort: "low", maxCompletionTokens: 4000, retryMaxCompletionTokens: 8000, brainVersionId: "v42" });
  assert.equal(luna.text, "ค่ะพี่ง้วง");
  assert.equal(luna.model, "gpt-5.6-luna");
  const [owner] = fetchImpl.calls;
  assert.equal(owner.body.model, "gpt-5.6-luna");
  assert.equal(owner.body.reasoning_effort, "low");
  assert.equal(owner.body.max_completion_tokens, 4000);
  assert.match(owner.body.prompt_cache_key, /-v42$/u, "คีย์แคชผูกกับรุ่นสมอง");
  assert.ok(!Object.keys(owner.headers).some((key) => key.startsWith("x-lukprae")), "ไม่ใช่ห้องลูกค้า = ไม่มีหัว mirror");

  const sol = await bridge.draftReply({ ...parts, brainVersionId: "v42" });
  const [, customer] = fetchImpl.calls;
  assert.deepEqual(owner.body.messages, customer.body.messages, "ข้อความที่โมเดลเห็นเหมือนกันทุกไบต์");
  assert.equal(owner.body.prompt_cache_key, customer.body.prompt_cache_key, "คีย์แคชเดียวกับเส้นลูกค้าของรุ่นนี้ (ความรู้ก้อนเดียวกัน)");
  assert.equal(customer.body.model, "gpt-5.6-sol", "เส้นตอบลูกค้ายังใช้รายการของตัวเอง (luna ไม่อยู่ใน reply allowlist)");
  assert.equal(customer.body.reasoning_effort, undefined);
  assert.equal(sol.model, "gpt-5.6-sol");

  assert.equal(await bridge.draftWithModel({ ...parts, model: "gpt-4o" }), null);
  assert.equal(await bridge.draftWithModel({ ...parts, model: "" }), null);
  assert.equal(fetchImpl.calls.length, 2, "โมเดลที่ไม่อนุญาต = ไม่ยิงอะไรเลย");
});

test("hermes.draftWithModel: ยกแรกล้ม 5xx = ลองอีกครั้งด้วยงบสำรอง · ล้มทั้งสองยก = null", async () => {
  const config = testConfig({ HERMES_ALLOWED_MODELS: "gpt-5.6-sol,gpt-5.6-luna" });
  const once = gateway({ failFirst: 1 });
  const bridge = createHermesBridge({ config, fetchImpl: once, logger: silent });
  const result = await bridge.draftWithModel({ userText: "x", model: "gpt-5.6-luna", reasoningEffort: "low", maxCompletionTokens: 4000, retryMaxCompletionTokens: 8000 });
  assert.equal(result.attempt, "retry_full_budget");
  assert.deepEqual(once.calls.map((call) => call.body.max_completion_tokens), [4000, 8000]);
  const always = gateway({ failFirst: 5 });
  const broken = createHermesBridge({ config, fetchImpl: always, logger: silent });
  assert.equal(await broken.draftWithModel({ userText: "x", model: "gpt-5.6-luna" }), null);
  assert.equal(always.calls.length, 2);
});

/* --------------------------------- owner chat --------------------------------- */

function world(t, { plan = () => "{\"queries\":[]}", luna = () => "รับทราบค่ะพี่ง้วง", sol = () => "รับทราบค่ะพี่ง้วง (sol)", env = {}, fx = null } = {}) {
  const clock = { now: NOON };
  const db = memoryDb({ now: () => clock.now });
  t.after(() => db.close());
  const config = testConfig({ CONSOLE_PUBLIC_BASE_URL: "https://console.example/console", ...env });
  const at = (ms, fn) => { const saved = clock.now; clock.now = ms; try { return fn(); } finally { clock.now = saved; } };
  // ลีดร้อนหนึ่งห้อง: ลูกค้าพิมพ์คนสุดท้าย ยังไม่มีใครตอบ
  at(NOON - 30 * 24 * HOUR, () => db.upsertCustomer("U-a", { displayName: "สมชาย ใจดี" }));
  at(NOON - 2 * HOUR, () => db.insertMessage({ customerId: "U-a", direction: "in", content: "ราคาเท่าไหร่คะ โทร 0812345678" }));
  at(NOON - 2 * HOUR, () => db.recordScore("U-a", 9, "{}"));
  const calls = { plans: [], luna: [], sol: [] };
  const usage = { prompt_tokens: 900, completion_tokens: 60 };
  const hermes = {
    scoreCustomer: async (args) => {
      assert.ok(String(args.system).includes(PLANNER_MARK), "ในแชทเจ้าของ scoreCustomer มีแค่งานวางแผนค้น");
      calls.plans.push(args);
      const text = plan(args);
      return text == null ? null : { text, usage: { prompt_tokens: 50, completion_tokens: 10 }, model: "gpt-5.6-luna" };
    },
    draftWithModel: async (args) => {
      calls.luna.push(args);
      const text = luna(args);
      return text == null ? null : { text, usage, model: args.model };
    },
    draftReply: async (args) => {
      calls.sol.push(args);
      const text = sol(args);
      return text == null ? null : { text, usage, model: "gpt-5.6-sol" };
    },
  };
  const chat = createOwnerChat({ config, db, hermes, fx, logger: silent, now: () => clock.now });
  const usageRows = () => db.raw.prepare("SELECT kind, customer_id, model FROM llm_usage ORDER BY rowid").all().map((row) => ({ ...row }));
  const calledToday = () => db.getSetting("owner_chat_day_count");
  return { db, clock, config, chat, calls, usageRows, calledToday };
}

test("คุยเล่น = ไม่วางแผนค้น (ไม่เสียค่า/เวลา) · ตอบด้วย Luna effort ต่ำ งบ 4,000/8,000 · ค่าใช้จ่ายบันทึกโมเดลจริง", async (t) => {
  const w = world(t);
  const out = await w.chat.reply({ text: "ขอบคุณมากนะลูกแพร", owner: OWNER });
  assert.equal(out.ok, true);
  assert.equal(out.text, "รับทราบค่ะพี่ง้วง");
  assert.equal(out.model, "gpt-5.6-luna");
  assert.deepEqual(out.lookups, []);
  assert.equal(w.calls.plans.length, 0);
  assert.equal(w.calls.sol.length, 0);
  const [args] = w.calls.luna;
  assert.deepEqual([args.model, args.reasoningEffort, args.maxCompletionTokens, args.retryMaxCompletionTokens], ["gpt-5.6-luna", "low", 4000, 8000]);
  assert.equal(args.role, "reply");
  assert.deepEqual(w.usageRows(), [{ kind: "draft", customer_id: "", model: "gpt-5.6-luna" }]);
  assert.equal(w.calledToday(), "2026-09-28:1");
});

test("ถามข้อมูล = วางแผน → ค้น → ตอบจากผลค้น: ผลอยู่ส่วนที่ไม่แคช · ตัววางแผนไม่เห็นข้อมูลลูกค้า · ลิงก์ห้องที่เอ่ยถึง · ความจำไม่มีลิงก์/id", async (t) => {
  const w = world(t, {
    plan: () => "{\"queries\":[{\"name\":\"leads\",\"args\":{\"waitingReply\":true}},{\"name\":\"shell\",\"args\":{\"cmd\":\"rm -rf /\"}}]}",
    luna: () => "ลีดร้อนที่ยังรอคำตอบมีห้องเดียวค่ะ คือ สมช*** (LINE) ถามราคาไว้ 2 ชม. แล้วค่ะ",
  });
  const out = await w.chat.reply({ text: "ลีดร้อนที่ยังไม่มีใครตอบมีใครบ้าง", owner: OWNER });
  assert.equal(out.ok, true);
  assert.deepEqual(out.lookups, ["leads"], "คิวรีนอกรายการถูกทิ้ง");
  assert.deepEqual(out.links, ["🔗 สมช*** (LINE) https://console.example/console/#/c/U-a"]);

  const [planArgs] = w.calls.plans;
  assert.match(planArgs.transcript, /ข้อความใหม่ของพี่ง้วง: ลีดร้อนที่ยังไม่มีใครตอบมีใครบ้าง$/u);
  assert.ok(!planArgs.transcript.includes("สมชาย") && !planArgs.system.includes("สมชาย"), "ตัววางแผนไม่เห็นข้อมูลลูกค้า");

  const [args] = w.calls.luna;
  assert.match(args.rules, /ผลค้นข้อมูลสำหรับคำถามนี้ \(ระบบค้นจากฐานข้อมูลจริงตอนนี้/u);
  assert.match(args.rules, /【รายชื่อลีด】คะแนน 8–10 · คุยใน 7 วัน · ทุกช่องทาง · ลูกค้าพิมพ์ล่าสุดและยังไม่มีใครตอบ/u);
  assert.match(args.rules, /เข้าเงื่อนไข 1 ห้อง\n· สมช\*\*\* \(LINE\) — 9\/10 สนใจสูง/u);
  assert.ok(!`${args.persona}${args.knowledge}`.includes("ผลค้นข้อมูลสำหรับคำถามนี้"), "ส่วนคงที่ (แคช) ไม่เปลี่ยนตามผลค้น");
  assert.ok(!args.rules.includes("สมชาย ใจดี") && !args.rules.includes("0812345678") && !args.rules.includes("U-a"));

  const memory = w.db.recentOwnerChatTurns(ownerChatRef(OWNER));
  assert.equal(memory.at(-1).content, "ลีดร้อนที่ยังรอคำตอบมีห้องเดียวค่ะ คือ สมช*** (LINE) ถามราคาไว้ 2 ชม. แล้วค่ะ");
  assert.ok(!memory.some((turn) => /https?:|U-a/u.test(turn.content)));
  assert.deepEqual(w.usageRows().map((row) => `${row.kind}:${row.model}`), ["score:gpt-5.6-luna", "draft:gpt-5.6-luna"]);
  assert.equal(w.calledToday(), "2026-09-28:2", "วางแผน + ตอบ = สองครั้ง");
});

test("วางแผนล้ม = ตอบจากข้อมูลสดพร้อมบอกว่าค้นเพิ่มไม่สำเร็จ · แผนอ่านไม่ออก = ไม่ค้น (ไม่แต่งข้อมูล)", async (t) => {
  const failed = world(t, { plan: () => null });
  await failed.chat.reply({ text: "เมื่อวานกับวันนี้ต่างกันยังไง", owner: OWNER });
  assert.match(failed.calls.luna[0].rules, /ผลค้นข้อมูล: รอบนี้ค้นข้อมูลเพิ่มไม่สำเร็จ/u);
  assert.match(failed.calls.luna[0].rules, /ข้อมูลสดจากระบบ/u);

  const junk = world(t, { plan: () => "ค้นกิจกรรมเมื่อวานค่ะ" });
  const out = await junk.chat.reply({ text: "เมื่อวานกับวันนี้ต่างกันยังไง", owner: OWNER });
  assert.equal(out.ok, true);
  assert.deepEqual(out.lookups, []);
  assert.doesNotMatch(junk.calls.luna[0].rules, /ผลค้นข้อมูล/u);
});

test("สวิตช์ sol = ทางเดิม (draftReply) · luna ไม่ตอบ = ถอยไป sol หนึ่งครั้ง · ระบบไม่อนุญาต luna = sol ทันที", async (t) => {
  const solMode = world(t);
  solMode.db.setSetting("owner_chat_model", "sol");
  const a = await solMode.chat.reply({ text: "สวัสดีจ้า", owner: OWNER });
  assert.equal(a.model, "gpt-5.6-sol");
  assert.equal(solMode.calls.luna.length, 0);
  assert.equal(solMode.calls.sol.length, 1);
  assert.equal(solMode.calls.sol[0].model, undefined, "ทางเดิมไม่ส่งโมเดล (ให้ draftReply เลือกตามบทบาทตอบ)");

  const lunaDown = world(t, { luna: () => null });
  const b = await lunaDown.chat.reply({ text: "สวัสดีจ้า", owner: OWNER });
  assert.equal(b.ok, true);
  assert.equal(b.text, "รับทราบค่ะพี่ง้วง (sol)");
  assert.equal(lunaDown.calls.luna.length, 1);
  assert.equal(lunaDown.calls.sol.length, 1);
  assert.deepEqual(lunaDown.usageRows().map((row) => row.model), ["gpt-5.6-sol"]);
  assert.equal(lunaDown.calledToday(), "2026-09-28:2", "สำรองก็นับโควตา");

  const notAllowed = world(t, { env: { HERMES_ALLOWED_MODELS: "gpt-5.6-sol" } });
  await notAllowed.chat.reply({ text: "สวัสดีจ้า", owner: OWNER });
  assert.equal(notAllowed.calls.luna.length, 0);
  assert.equal(notAllowed.calls.sol.length, 1);

  const allDown = world(t, { luna: () => null, sol: () => null });
  const c = await allDown.chat.reply({ text: "สวัสดีจ้า", owner: OWNER });
  assert.deepEqual([c.ok, c.text], [false, OWNER_CHAT_FALLBACK_TEXT]);
});

test("เพดาน 300 ครั้งต่อวันนับทุกครั้งที่เรียกโมเดล: วางแผนใช้ช่องสุดท้าย = ไม่ตอบต่อ · luna ล้มตอนโควตาหมด = ไม่ถอยไป sol", async (t) => {
  const w = world(t, { plan: () => "{\"queries\":[{\"name\":\"waiting\",\"args\":{}}]}" });
  w.db.setSetting("owner_chat_day_count", `2026-09-28:${OWNER_CHAT_DAILY_CAP - 1}`);
  const out = await w.chat.reply({ text: "ห้องไหนรอตอบบ้าง", owner: OWNER });
  assert.deepEqual([out.ok, out.text], [false, OWNER_CHAT_CAP_TEXT]);
  assert.equal(w.calls.plans.length, 1);
  assert.equal(w.calls.luna.length, 0);
  assert.equal(w.calledToday(), `2026-09-28:${OWNER_CHAT_DAILY_CAP}`);

  const last = world(t, { luna: () => null });
  last.db.setSetting("owner_chat_day_count", `2026-09-28:${OWNER_CHAT_DAILY_CAP - 1}`);
  const tail = await last.chat.reply({ text: "สวัสดีจ้า", owner: OWNER });
  assert.deepEqual([tail.ok, tail.text], [false, OWNER_CHAT_FALLBACK_TEXT]);
  assert.equal(last.calls.sol.length, 0);
});

test("ค่า AI ในผลค้นใช้อัตราแลกเปลี่ยนเดียวกับคอนโซล (fx) · ไม่มี fx = ค่าใน config", async (t) => {
  const plan = () => "{\"queries\":[{\"name\":\"aiCost\",\"args\":{}}]}";
  const withFx = world(t, { plan, fx: { current: () => ({ thbPerUsd: 32.5 }) } });
  await withFx.chat.reply({ text: "เดือนนี้ค่า AI เท่าไหร่", owner: OWNER });
  assert.match(withFx.calls.luna[0].rules, /อัตรา 32\.5 บาท\/ดอลลาร์/u);
  const noFx = world(t, { plan, env: { THB_PER_USD: "34" } });
  await noFx.chat.reply({ text: "เดือนนี้ค่า AI เท่าไหร่", owner: OWNER });
  assert.match(noFx.calls.luna[0].rules, /อัตรา 34 บาท\/ดอลลาร์/u);
});
