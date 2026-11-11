// "ขอเช็คคิวก่อน" ในไปป์ไลน์จริง (คำสั่งพี่ง้วง 28 ก.ย. 2026): หมุดของห้อง + บรรทัดสั่งงานของเทิร์นตอบ
// ลูกค้าสังเคราะห์ · Hermes/LINE เป็น stub ทั้งหมด
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server.mjs";
import { QUESTION_ENDING } from "../src/replyClosingQuestion.mjs";
import { thaiShortDate } from "../src/classRounds.mjs";
import { SCHEDULE_CHECK_FOLLOWUP_KEY } from "../src/scheduleCheck.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const DAY = 86_400_000;
const isoIn = (days) => new Date(Date.now() + 7 * 3_600_000 + days * DAY).toISOString().slice(0, 10);
const esc = (value) => JSON.stringify(value).slice(1, -1);

function roundsFile() {
  const dir = mkdtempSync(join(tmpdir(), "sched-pipe-"));
  const file = join(dir, "class-rounds.json");
  writeFileSync(file, JSON.stringify({
    classes: { basic: { label: "Classroom AI Agent for Business", product: "AI Agent for Business" } },
    rounds: [
      { date: isoIn(-3), class: "basic", status: "open" },
      { date: isoIn(12), class: "basic", status: "open" },
      { date: isoIn(19), class: "basic", status: "full" },
      { date: isoIn(26), class: "basic", status: "open" },
    ],
  }));
  return file;
}

function world({ mode = null } = {}) {
  const db = memoryDb();
  if (mode) db.setSetting(SCHEDULE_CHECK_FOLLOWUP_KEY, mode);
  const hermesFetch = hermesFetchStub("ได้เลยค่ะ ไม่ต้องรีบนะคะ");
  const app = createApp({
    config: testConfig({ HISTORY_TURNS: "12", CLASS_ROUNDS_FILE: roundsFile() }), db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  let seq = 0;
  const send = async (customerId, text, { agoMs = 0 } = {}) => {
    db.upsertCustomer(customerId, {});
    const id = `in:sched-${customerId}-${seq += 1}`;
    db.insertMessage({ id, customerId, direction: "in", msgType: "text", content: text });
    if (agoMs) db.raw.prepare("UPDATE messages SET created_at = created_at + ? WHERE id = ?").run(agoMs, id);
    await app.pipeline.handleInboundText({ customerId, text, replyToken: "rt" });
  };
  const prompts = () => hermesFetch.calls.filter((call) => Array.isArray(call.body?.messages))
    .map((call) => JSON.stringify(call.body.messages));
  const marker = (customerId) => {
    const raw = db.getFollowupState(customerId)?.defer_json || "";
    return raw ? JSON.parse(raw) : null;
  };
  return { db, send, prompts, marker };
}

test("ไปป์ไลน์: ขอเช็คคิว = ตั้งหมุด + บรรทัดสั่งงานพร้อมรอบที่เปิดจริง + ไม่มีคำถามปิดท้าย", async (t) => {
  const w = world();
  t.after(() => w.db.close());
  await w.send("U-sched-pipe", "สนใจคลาส AI Agent for Business ค่ะ");
  await w.send("U-sched-pipe", "ขอเช็คคิวก่อน เดี๋ยวพรุ่งนี้แจ้งนะคะ");
  const marker = w.marker("U-sched-pipe");
  assert.equal(marker.kind, "schedule_check");
  assert.equal(marker.hint, isoIn(1));
  assert.ok(w.db.listAudit(20).some((row) => row.action === "schedule_check_deferral" && row.target === "U-sched-pipe"));

  const [first, second] = w.prompts();
  assert.doesNotMatch(first, /ขอเช็คคิว\/วัน\/ตารางของตัวเองก่อน/u, "เทิร์นปกติไม่ได้บรรทัดนี้");
  assert.match(second, /ขอเช็คคิว\/วัน\/ตารางของตัวเองก่อน/u);
  assert.match(second, /ไม่ต้องรีบนะคะ/u);
  const section = second.slice(second.indexOf("รอบที่เปิดรับตอนนี้"));
  assert.ok(section.includes(`${thaiShortDate(isoIn(12))} — Classroom AI Agent for Business`), "รอบที่เปิดอยู่จริง");
  assert.ok(section.includes(`${thaiShortDate(isoIn(26))} — Classroom AI Agent for Business`));
  assert.ok(!section.includes(thaiShortDate(isoIn(-3))), "รอบที่ผ่านไปแล้วต้องไม่อยู่ในรายการ");
  assert.ok(!section.includes(thaiShortDate(isoIn(19))), "รอบที่เต็มแล้วต้องไม่อยู่ในรายการ");
  assert.ok(first.includes(esc(QUESTION_ENDING.general.on)), "เทิร์นปกติยังได้คำถามปิดท้าย");
  assert.ok(!second.includes(esc(QUESTION_ENDING.general.on)), "เทิร์นขอเช็คคิวต้องไม่ถูกสั่งให้ถามปิดท้าย");
});

test("ไปป์ไลน์: ตอบรับสั้น ๆ คงหมุด · พิมพ์เรื่องใหม่ภายหลังล้างหมุด", async (t) => {
  const w = world();
  t.after(() => w.db.close());
  await w.send("U-sched-keep", "ขอเช็ควันก่อนนะคะ");
  const at = w.marker("U-sched-keep").at;
  await w.send("U-sched-keep", "ขอบคุณค่ะ", { agoMs: 10 * 60_000 });
  assert.equal(w.marker("U-sched-keep").at, at, "ขอบคุณ = คงหมุดเดิม");
  await w.send("U-sched-keep", "แล้วคลาสออนไลน์มีไหมคะ", { agoMs: 60 * 60_000 });
  assert.equal(w.marker("U-sched-keep"), null, "เรื่องใหม่ = ล้างหมุด กลับสู่บันไดปกติ");
});

test("ไปป์ไลน์: สวิตช์ปิด = ไม่ตั้งหมุด และพรอมต์ไม่มีบรรทัดนี้", async (t) => {
  const w = world({ mode: "off" });
  t.after(() => w.db.close());
  await w.send("U-sched-off", "ขอเช็คคิวก่อนนะคะ");
  assert.equal(w.marker("U-sched-off"), null);
  assert.doesNotMatch(w.prompts()[0], /ขอเช็คคิว\/วัน\/ตารางของตัวเองก่อน/u);
});
