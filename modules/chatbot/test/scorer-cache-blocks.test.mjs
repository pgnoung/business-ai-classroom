// ตัวให้คะแนนแคชได้ข้ามห้อง (4 ต.ค. 2026): ข้อมูลของห้องอยู่ท้ายสุด ส่วนบนเหมือนกันทุกห้องและปักหมุดแคช
import test from "node:test";
import assert from "node:assert/strict";
import { buildScorerSystem, scorerSystemBlocks, SCORER_CUSTOMER_MARKER } from "../src/scoring.mjs";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { testConfig } from "./helpers.mjs";

const silent = { log() {}, warn() {}, debug() {}, error() {}, info() {} };
const roomA = buildScorerSystem({ displayName: "ลูกค้าเอ", knownName: "เอ", lastScore: 4, handoffNotes: [] });
const roomB = buildScorerSystem({ displayName: "ลูกค้าบี", lastScore: null });

test("ข้อมูลของห้องอยู่ท้ายสุด — ส่วนบนเหมือนกันทุกห้อง", () => {
  const cut = (s) => s.slice(0, s.indexOf(`\n${SCORER_CUSTOMER_MARKER}`));
  assert.equal(cut(roomA), cut(roomB));
  assert.ok(roomA.length - cut(roomA).length < 200, "ส่วนที่เปลี่ยนตามห้องต้องสั้น");
  assert.match(roomA, /JSON object เดียว[\s\S]*ข้อมูลลูกค้า: display name = ลูกค้าเอ/u);
});

test("แยกบล็อกแล้วต่อกลับได้ข้อความเดิมทุกตัวอักษร · บล็อกแรกปักหมุดแคชและเหมือนกันทุกห้อง", () => {
  const [a1, a2] = scorerSystemBlocks(roomA), [b1] = scorerSystemBlocks(roomB);
  assert.equal(a1.text + a2.text, roomA);
  assert.deepEqual(a1.prompt_cache_breakpoint, { mode: "explicit" });
  assert.equal(a1.text, b1.text);
  assert.equal(scorerSystemBlocks("ไม่มีข้อมูลลูกค้า"), "ไม่มีข้อมูลลูกค้า");
});

test("bridge ส่ง system แบบบล็อกไปเกตเวย์ตรง ๆ และขอแคชแบบ explicit", async () => {
  const bodies = [];
  const hermes = createHermesBridge({ config: testConfig(), logger: silent, fetchImpl: async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content: "{\"score\":4}" } }], usage: {} }) };
  } });
  await hermes.scoreCustomer({ system: scorerSystemBlocks(roomA), transcript: "ลูกค้า: สนใจคลาส" });
  assert.deepEqual(bodies[0].messages[0].content, scorerSystemBlocks(roomA));
  assert.deepEqual(bodies[0].prompt_cache_options, { mode: "explicit" });
  await hermes.scoreCustomer({ system: roomA, transcript: "x" });
  assert.equal(bodies[1].messages[0].content, roomA, "สตริงเดิมยังใช้ได้");
});
