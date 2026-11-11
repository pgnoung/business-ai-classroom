// brain-gate-wiring.test.mjs — ด่านเล่นซ้ำต้อง "ทำงานจริงตอนเผยแพร่จริง"
//
// เหตุผลที่ไฟล์นี้ต้องมี: เทสต์ก่อนหน้าเรียก runGate5 ตรง ๆ ซึ่งพิสูจน์ได้แค่ว่า
// ตัวด่านคิดถูก **ไม่ได้พิสูจน์ว่ามันถูกต่อสาย** — และมันไม่ได้ถูกต่อจริง ๆ อยู่พักหนึ่ง
// (config.brainGates กับ golden_turns ไม่เคยถูกส่งเข้า runBrainGates เลย ผลคือ G5/G8
// เป็น not_applicable ตลอดกาลแม้เปิดแฟล็ก) ไฟล์นี้จึงยิง HTTP จริงผ่านเส้นเขียนจริง
//
// ไม่มีการเรียกโมเดลในไฟล์นี้ — poisonGlobalFetch วางยาไว้ และ hermes ถูก stub
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen,
} from "./helpers.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";
import { runBrainGates } from "../src/brain/gate.mjs";
import { BRAIN_CODE_CONTRACT } from "../src/brain/import.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const SECRET = "gate-wiring-console-secret-0123456789";
const PASSWORD = "gate-wiring-pass-1234";
const TODAY = todayInBangkok(Date.now());
const QUIET = { warn() {}, debug() {}, log() {} };

async function boot(t, { gates = "offline", withGolden = true, banned = ["ดีที่สุด"] } = {}) {
  const config = testConfig({
    CONSOLE_SESSION_SECRET: SECRET, KNOWLEDGE_VERSIONED: "true", BRAIN_GATES: gates,
  });
  const db = memoryDb({ teachHashSecret: SECRET });
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.addKnowledge({ title: "แคตตาล็อกคลาส", content: "คลาส AI Agent for Business สอนสด", updatedBy: "ngoung" });
  db.setApprovedPrice("AI Agent for Business", 11900);
  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ");
  if (withGolden) {
    // บทสนทนาที่ลูกแพรเคยตอบไว้แล้ว และคำตอบนั้นพูดราคา 11,900
    db.upsertGoldenTurn({
      caseId: "probe-price-01", title: "คุณเอ๋ เจ้าของโรงงาน", syntheticText: "ราคาเท่าไหร่คะ",
      recordedModelOutput: JSON.stringify(["คลาสราคา 11,900 บาทค่ะ สนใจดูรอบเรียนไหมคะ"]),
      expected: [{ type: "ends_with_question" }], severity: "lead",
      origin: "eval_case", scope: { product: "*" },
    });
  }
  assert.equal(importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: TODAY }).created, true);
  const app = createApp({
    config, db,
    overrides: {
      hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {},
      bannedWords: banned, safetyRules: [],
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

function send(server, method, path, body, headers = {}) {
  return httpRequest(server, {
    method, path,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function login(server) {
  const res = await send(server, "POST", "/console/api/login", { username: "ngoung", password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], "x-csrf-token": res.json.csrf };
}

function gateOf(db, id) {
  const live = db.getBrainPointer("live");
  const newest = db.listBrainVersions(5)[0];
  const report = JSON.parse(String((newest ?? live).gate_report_json || "{}"));
  return (report.gates ?? []).find((g) => g.id === id) ?? null;
}

test("เปิดแฟล็กแล้วเผยแพร่จริง -> G5 ต้องทำงาน ไม่ใช่ not_applicable", async (t) => {
  const { app, db } = await boot(t);
  const auth = await login(app.server);
  // เพิ่มราคาอีกใบ = การแก้ที่แตะตารางของ guard จริง ๆ (ตัวเลือกจึงหยิบบทสนทนาเรื่องเงินมา)
  const res = await send(app.server, "POST", "/console/api/prices",
    { label: "AI Agent Workshop", amount: 15900 }, auth);
  assert.equal(res.status, 200, res.text);
  const g5 = gateOf(db, "G5");
  assert.ok(g5, "รายงานด่านต้องมี G5");
  assert.notEqual(g5.verdict, "not_applicable",
    `G5 ต้องได้ทำงานจริงตอนเปิดแฟล็ก — ได้ ${JSON.stringify(g5)}`);
  assert.ok(gateOf(db, "G8"), "G8 ต้องอยู่ในรายงานด้วย");
});

test("ปิดแฟล็ก -> G5 เป็นเทา และเหตุผลบอกว่า 'ปิดอยู่' ไม่ใช่เหตุผลอื่น", async (t) => {
  const { app, db } = await boot(t, { gates: "" });
  const auth = await login(app.server);
  const res = await send(app.server, "POST", "/console/api/prices",
    { label: "AI Agent Workshop", amount: 15900 }, auth);
  assert.equal(res.status, 200, res.text);
  const g5 = gateOf(db, "G5");
  assert.equal(g5.verdict, "not_applicable");
  assert.match(String(g5.reason ?? ""), /ยังปิดอยู่/u, JSON.stringify(g5));
});

test("เปิดแฟล็กแต่ยังไม่ได้ต่อตาราง -> ล้มเสียงดัง ไม่ใช่รายงานว่าไม่เกี่ยว", () => {
  // เส้นจริงต่อสายให้ครบเสมอแล้ว (createApp ส่ง bannedWords/safetyRules ให้เอง) เทสต์นี้จึง
  // ล็อก "สัญญาของด่าน" ไว้ตรง ๆ: เปิดแล้วได้ของไม่ครบ = error ห้ามเป็น not_applicable
  const report = runBrainGates({
    cards: [], bundle: { codeContract: BRAIN_CODE_CONTRACT, checksum: "x", budget: { cardCount: 0 } },
    touched: [], todayIso: TODAY, gateMode: "offline", goldenTurns: [], bannedPhrases: null, extraRules: [],
  });
  assert.equal(report.verdict, "error", JSON.stringify(report.gates));
  assert.match(report.error, /ยังต่อไม่ถึง/u);
  assert.equal(report.gates.find((g) => g.id === "G5").verdict, "error");
});

test("ราคาที่แก้ทำให้คำตอบเก่าพัง -> การเผยแพร่ถูกบล็อกด้วยข้อความภาษาไทยที่ชี้ห้อง", async (t) => {
  const { app, db } = await boot(t);
  const auth = await login(app.server);
  const res = await send(app.server, "POST", "/console/api/prices/AI%20Agent%20for%20Business",
    { amount: 12900 }, auth);
  assert.equal(res.status, 409, `ต้องถูกบล็อก — ${res.text}`);
  assert.match(res.json.error, /คุณเอ๋ เจ้าของโรงงาน/u, res.text);
  assert.match(res.json.error, /ตารางราคา/u);
  // ของศักดิ์สิทธิ์: ถูกบล็อก = ตารางเดิมต้องไม่ขยับแม้แต่ไบต์เดียว
  assert.equal(db.approvedPrices().find((p) => p.label === "AI Agent for Business").amount, 11900);
});
