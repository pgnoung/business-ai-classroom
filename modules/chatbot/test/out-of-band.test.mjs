// G7.2 Out-of-band admin reply detection — mitigation ของ "OA Manager blindness":
// scorer contract (out_of_band_reply, strong default false), trigger -> pause 30 นาที +
// ธง NEEDS_HUMAN + โน้ต ai_auto + audit, cooldown 24 ชม., reply path ไม่กระทบ,
// console โชว์เหตุผล pause, PDPA reset ล้าง cooldown key — ทุกอย่าง mock
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { buildScorerSystem, parseScorePayload } from "../src/scoring.mjs";
import {
  OUT_OF_BAND_PAUSE_MS, OUT_OF_BAND_COOLDOWN_MS, OUT_OF_BAND_NOTE, oobLastKey,
} from "../src/pipeline.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, lineFetchStub, hermesFetchStub,
  httpRequest, listen, waitFor, promptText} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function scorerPayload(overrides = {}) {
  return JSON.stringify({
    score: 5, trend: "flat", buying_signals: [],
    persona_read: { disc: "unknown", bank: "unknown", reason: "" },
    next_move: "เติมบริบทที่หายไปก่อนคุยต่อ", suggested_question: "",
    context_summary: "ลูกค้าอ้างถึงข้อตกลงที่ไม่อยู่ในแชท",
    ...overrides,
  });
}

// stub Hermes สองบท: draft ปกติ / scorer ตอบ JSON ที่กำหนด
function dualHermesStub({ reply = "รับทราบค่ะ เดี๋ยวดูแลต่อให้นะคะ มีอะไรถามเพิ่มไหมคะ", scorer = scorerPayload() } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    const body = JSON.parse(opts.body);
    const system = body.messages?.[0]?.role === "system" ? promptText(body.messages[0].content) : "";
    const isScorer = system.includes("ระบบวิเคราะห์ความสนใจซื้อ");
    calls.push({ url: String(url), body, isScorer });
    return {
      ok: true, status: 200,
      json: async () => ({ choices: [{ message: { content: isScorer ? scorer : reply } }] }),
    };
  };
  fn.calls = calls;
  return fn;
}

function makeApp({ scorer, configOverrides = {} } = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  const hermesFetch = dualHermesStub({ scorer });
  const lineFetch = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch, lineFetch, sleep: async () => {} },
    logger: silent,
  });
  return { app, db, config, hermesFetch, lineFetch };
}

function seedTurns(db, customerId) {
  db.upsertCustomer(customerId, {});
  db.insertMessage({ customerId, direction: "in", content: "ได้ครับตามนั้น โอนตามที่แอดมินบอกเมื่อกี้เลยนะ" });
}

/* ------------------------------ scorer contract ------------------------------ */

test("OOB: scorer prompt มีคำสั่ง out_of_band_reply + ตัวอย่าง + default false", () => {
  const system = buildScorerSystem({});
  assert.ok(system.includes("out_of_band_reply"));
  assert.ok(system.includes("ตามที่แอดมินบอกเมื่อกี้"), "ต้องมีตัวอย่างประโยคจริง");
  assert.ok(system.includes("ได้ครับตามนั้น"));
  assert.ok(system.includes("ไม่แน่ใจ = false"), "strong default false ต้องอยู่ใน prompt");
});

test("v1.4.12d: scorer prompt บังคับน้ำเสียงผู้หญิง (ค่ะ/คะ) ใน next_move + suggested_question", () => {
  const system = buildScorerSystem({});
  assert.ok(system.includes("แอดมินผู้ตอบแชทเป็นผู้หญิง"), "ต้องประกาศเพศผู้ตอบ");
  assert.ok(system.includes("ห้ามใช้ ครับ"), "ต้องห้ามคำลงท้ายผู้ชายตรง ๆ");
});

test("OOB: parseScorePayload — boolean true เท่านั้น, ค่าอื่น/ไม่มี field = false", () => {
  const base = { score: 5, trend: "flat" };
  assert.equal(parseScorePayload(JSON.stringify({ ...base, out_of_band_reply: true })).out_of_band_reply, true);
  assert.equal(parseScorePayload(JSON.stringify({ ...base, out_of_band_reply: false })).out_of_band_reply, false);
  assert.equal(parseScorePayload(JSON.stringify({ ...base, out_of_band_reply: "true" })).out_of_band_reply, false, "string ไม่นับ");
  assert.equal(parseScorePayload(JSON.stringify({ ...base, out_of_band_reply: 1 })).out_of_band_reply, false, "เลขไม่นับ");
  assert.equal(parseScorePayload(JSON.stringify(base)).out_of_band_reply, false, "ไม่มี field = false");
});

/* ------------------------------- trigger path ------------------------------- */

test("OOB: scorer ชี้ true -> pause 30 นาที + ธง out_of_band + โน้ต ai_auto + audit + cooldown key", async () => {
  const { app, db } = makeApp({ scorer: scorerPayload({ out_of_band_reply: true }) });
  seedTurns(db, "U-oob");

  const before = Date.now();
  const payload = await app.pipeline.scoreBurst("U-oob");
  assert.equal(payload.out_of_band_reply, true);

  const customer = db.getCustomer("U-oob");
  const until = Number(customer.operator_active_until);
  assert.ok(until >= before + OUT_OF_BAND_PAUSE_MS - 1000 && until <= Date.now() + OUT_OF_BAND_PAUSE_MS,
    "AI ต้องพัก ~30 นาทีนับจากตอน trigger");
  assert.equal(customer.state, "NEEDS_HUMAN");
  assert.ok(customer.handoff_summary.includes("out_of_band"), "ธงต้องบอกเหตุผล out_of_band");

  const notes = db.listHandoffNotes("U-oob", 20);
  assert.ok(notes.some((n) => n.author === "ai_auto" && n.text === OUT_OF_BAND_NOTE), "ต้องมีโน้ต ai_auto บอกให้คนเติมบริบท");

  const audits = db.listAudit().filter((a) => a.action === "out_of_band_pause");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].operator, "system");
  assert.equal(audits[0].target, "U-oob");

  const marked = Number(db.getSetting(oobLastKey("U-oob")));
  assert.ok(Number.isFinite(marked) && marked >= before, "cooldown key ต้องถูกตั้ง");
  db.close();
});

test("OOB: scorer ตอบ false / ไม่มี field -> ไม่มีอะไรเปลี่ยน", async () => {
  for (const scorer of [scorerPayload({ out_of_band_reply: false }), scorerPayload()]) {
    const { app, db } = makeApp({ scorer });
    seedTurns(db, "U-clean");
    await app.pipeline.scoreBurst("U-clean");
    const customer = db.getCustomer("U-clean");
    assert.equal(Number(customer.operator_active_until), 0, "ห้าม pause");
    assert.equal(customer.state, "AI_ACTIVE", "ห้ามติดธง");
    assert.equal(db.getSetting(oobLastKey("U-clean")), null);
    assert.equal(db.listAudit().filter((a) => a.action === "out_of_band_pause").length, 0);
    db.close();
  }
});

test("OOB: conservative — trigger ได้ครั้งเดียวต่อลูกค้าต่อ 24 ชม.", async () => {
  const { app, db } = makeApp({ scorer: scorerPayload({ out_of_band_reply: true }) });
  seedTurns(db, "U-cool");
  await app.pipeline.scoreBurst("U-cool");
  assert.equal(db.listAudit().filter((a) => a.action === "out_of_band_pause").length, 1);

  // เคลียร์ pause แล้วให้ scorer ชี้ true อีกรอบภายใน 24 ชม. — ต้องเงียบ
  db.setOperatorActiveUntil("U-cool", 0);
  await app.pipeline.scoreBurst("U-cool");
  assert.equal(db.listAudit().filter((a) => a.action === "out_of_band_pause").length, 1, "ภายใน 24 ชม. ห้าม trigger ซ้ำ");
  assert.equal(Number(db.getCustomer("U-cool").operator_active_until), 0, "รอบสองต้องไม่ pause ใหม่");

  // ย้อน cooldown key ให้เก่ากว่า 24 ชม. = trigger ได้อีกครั้ง
  db.setSetting(oobLastKey("U-cool"), String(Date.now() - OUT_OF_BAND_COOLDOWN_MS - 1000));
  await app.pipeline.scoreBurst("U-cool");
  assert.equal(db.listAudit().filter((a) => a.action === "out_of_band_pause").length, 2, "พ้น 24 ชม. = trigger ใหม่ได้");
  db.close();
});

test("OOB: ลูกค้า canary ไม่ trigger แม้ scorer ชี้ true", async () => {
  const { app, db } = makeApp({ scorer: scorerPayload({ out_of_band_reply: true }) });
  seedTurns(db, "canary:synthetic");
  await app.pipeline.scoreBurst("canary:synthetic");
  assert.equal(db.listAudit().filter((a) => a.action === "out_of_band_pause").length, 0);
  db.close();
});

/* --------------------------- reply path ไม่กระทบ --------------------------- */

test("OOB: reply ของ burst ที่ trigger ยังส่งปกติ (advisory หลังตอบ) — burst ถัดไปค่อยพัก", async () => {
  const { app, db, lineFetch } = makeApp({ scorer: scorerPayload({ out_of_band_reply: true }) });
  // Mirror real inbound persistence; assistant-only text is not customer evidence.
  db.upsertCustomer("U-flow", {});
  db.insertMessage({ customerId: "U-flow", direction: "in", content: "ได้ครับตามนั้น โอนเลยนะ" });

  const first = await app.pipeline.handleInboundText({
    customerId: "U-flow", text: "ได้ครับตามนั้น โอนเลยนะ", replyToken: "",
  });
  assert.equal(first.sent, true, "reply ของ burst นี้ต้องออกตามปกติ — OOB ห้ามยกเลิก reply ที่กำลังส่ง");
  assert.ok(lineFetch.sends.length >= 1);

  // scorer เป็น fire-and-forget — รอผล OOB แล้วค่อยยิง burst ถัดไป
  await waitFor(() => db.listAudit().some((a) => a.action === "out_of_band_pause"));
  const second = await app.pipeline.handleInboundText({
    customerId: "U-flow", text: "สรุปนัดกี่โมงนะ", replyToken: "",
  });
  assert.equal(second.suppressed, "operator_active", "burst ถัดไประหว่าง pause ต้องเงียบ");
  db.close();
});

/* ----------------------- console: เหตุผล pause + PDPA ----------------------- */

const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";

async function startConsole(t) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: hashPassword(PASSWORD), displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nok", password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

test("OOB: messages endpoint แนบ outOfBand ตอน pause ยัง active — หมดเวลาแล้ว = null", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("U-ui", {});
  const { cookie } = await login(app.server);

  // ยังไม่มี OOB = null
  let res = await httpRequest(app.server, { path: "/console/api/conversations/U-ui/messages", headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json.outOfBand, null);

  // จำลอง OOB เพิ่ง trigger — ต้องเห็น detectedAt + until = +30 นาที
  const detectedAt = Date.now() - 60_000;
  db.setSetting(oobLastKey("U-ui"), String(detectedAt));
  db.setOperatorActiveUntil("U-ui", detectedAt + OUT_OF_BAND_PAUSE_MS);
  res = await httpRequest(app.server, { path: "/console/api/conversations/U-ui/messages", headers: { cookie } });
  assert.deepEqual(res.json.outOfBand, { detectedAt, until: detectedAt + OUT_OF_BAND_PAUSE_MS });

  // พ้นหน้าต่าง 30 นาทีแล้ว (cooldown key ยังอยู่) = null — แบนเนอร์กลับเป็นข้อความปกติ
  db.setSetting(oobLastKey("U-ui"), String(Date.now() - OUT_OF_BAND_PAUSE_MS - 1000));
  res = await httpRequest(app.server, { path: "/console/api/conversations/U-ui/messages", headers: { cookie } });
  assert.equal(res.json.outOfBand, null);
});

test("OOB: PDPA reset ล้าง cooldown key oob_last:<id> ด้วย", async () => {
  const db = memoryDb();
  db.upsertCustomer("U-pdpa", {});
  db.setSetting(oobLastKey("U-pdpa"), String(Date.now()));
  db.resetCustomer("U-pdpa");
  assert.equal(db.getSetting(oobLastKey("U-pdpa")), null, "reset ต้องล้าง oob_last");
  db.close();
});
