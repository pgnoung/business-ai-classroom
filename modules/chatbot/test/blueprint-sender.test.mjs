// แคมเปญ #AIAGENT — ตัวเดินรอบ: โหมด off/pregenerate/on · เวลาไทย · กันส่งซ้ำ · ส่งไม่ถึง · เพดานเงิน · คืน FU
// หนึ่งเทสต์ = หนึ่งนาฬิกา (ฐานข้อมูลกับตัวเดินรอบใช้นาฬิกาเดียวกัน)
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createComplianceGuard, loadBannedWords } from "../src/complianceGuard.mjs";
import { createBlueprintCampaign } from "../src/blueprintCampaign.mjs";
import { saveCampaign } from "../src/blueprintCampaignConfig.mjs";
import { createBlueprintSender } from "../src/blueprintSender.mjs";
import { listEntries, readEntry } from "../src/blueprintStore.mjs";
import * as blueprintFlex from "../src/blueprint/blueprintFlex.mjs";
import { memoryDb, testConfig } from "./helpers.mjs";
import { SAMPLE_BLUEPRINT } from "./blueprint-fixtures.mjs";

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const HERE = fileURLToPath(new URL(".", import.meta.url));
const SUNDAY_CLASS = Date.parse("2026-10-11T15:05:00+07:00");
const SEND_AT = Date.parse("2026-10-12T10:00:00+07:00");
const { FLEX_CONTENTS_MAX_BYTES } = blueprintFlex;
// โมดูลเนื้อหามีคำสั่งตั้งต้น (v2) = การส่งหนึ่งครั้งมีสองข้อความ: การ์ด + คำสั่งตั้งต้น (ข้อความธรรมดา) ในคำขอเดียว
const PER_DELIVERY = typeof blueprintFlex.buildAgentBriefText === "function" ? 2 : 1;
const MIN = 60_000;
const DAY = 86_400_000;
const TEMPLATE = (business) => `#AIAGENT IESA6\nธุรกิจ: ${business}\nอยากให้ผู้ช่วย AI ทำก่อน: ตอบแชทลูกค้า\n(ขอรับไอเดียการวางระบบ AI Agent ภายใน 24 ชม.)`;

function harness(t, { push = null, hermesText = JSON.stringify(SAMPLE_BLUEPRINT), usage = { prompt_tokens: 3000, completion_tokens: 2000 }, campaign = {} } = {}) {
  const state = { clock: SUNDAY_CLASS };
  const now = () => state.clock;
  const db = memoryDb({ now });
  t.after(() => db.close());
  saveCampaign(db, {
    campaignId: "IESA6", keyword: "#AIAGENT", title: "IESA S-Curve MBA รุ่น 6",
    sendAt: "2026-10-12T10:00:00+07:00", followupOffDays: 7, enabled: true, ...campaign,
  });
  const pushes = [];
  const line = {
    replyMessages: async () => ({ ok: true, mode: "reply" }),
    pushMessages: async (args) => {
      pushes.push({ ...args, at: state.clock });
      return (push && await push(args, pushes.length)) || { ok: true, status: 200, duplicate: false };
    },
  };
  const hermesCalls = [];
  const hermes = {
    draftWithModel: async (args) => {
      hermesCalls.push(args);
      return typeof hermesText === "function" ? hermesText(args, hermesCalls.length) : { text: hermesText, usage, model: args.model };
    },
  };
  const notes = [];
  const notifier = { fire: (args) => { notes.push(args.reasonTextOverride); return { ok: true }; } };
  const sleeps = [];
  const guard = createComplianceGuard({ bannedWords: loadBannedWords(join(HERE, "..", "config", "clinic-banned.json"), { logger: silent }), logger: silent });
  const config = testConfig();
  const intake = createBlueprintCampaign({ db, config, line, guard, now, logger: silent });
  const makeSender = () => createBlueprintSender({
    db, config, hermes, line, guard, notifier, now, logger: silent, processId: "test", sleep: async (ms) => { sleeps.push(ms); },
  });
  const sender = makeSender();
  async function submit(customerId, business = "ร้านกาแฟสองสาขา", turnId = null) {
    if (!db.getCustomer(customerId)) db.upsertCustomer(customerId, {});
    const text = TEMPLATE(business);
    const hit = intake.match({ customerId, text });
    assert.ok(hit, "ต้องจับคีย์เวิร์ดได้");
    return intake.intake({ ...hit, customerId, text, replyToken: `rt-${customerId}-${business.length}`, turnId });
  }
  return { state, db, sender, makeSender, submit, pushes, hermesCalls, notes, sleeps };
}

const status = (db, id) => readEntry(db, "IESA6", id)?.status;

test("โหมด off (ค่าเริ่มต้น): ไม่เรียกโมเดล ไม่ส่งอะไร", async (t) => {
  const h = harness(t);
  await h.submit("U1");
  h.state.clock = SEND_AT + MIN;
  const result = await h.sender.runOnce();
  assert.equal(result.mode, "off");
  assert.equal(h.hermesCalls.length, 0);
  assert.equal(h.pushes.length, 0);
  assert.equal(status(h.db, "U1"), "pending");
});

test("pregenerate: สร้าง+เก็บ ไม่ส่ง · ต้นทุนลง llm_usage และยอดรายวัน · แจ้งทีมให้ดูตัวอย่างครั้งเดียว", async (t) => {
  const h = harness(t);
  await h.submit("U1");
  await h.submit("U2", "โรงงานผลิตชิ้นส่วน");
  h.db.setSetting("blueprint_send_mode", "pregenerate");
  h.state.clock += 10 * MIN;
  await h.sender.runOnce();
  assert.equal(h.hermesCalls.length, 2);
  assert.equal(h.hermesCalls[0].label, "hermes-blueprint");
  assert.match(h.hermesCalls[0].userText, /ร้านกาแฟสองสาขา/u);
  assert.equal(status(h.db, "U1"), "ready");
  assert.deepEqual(readEntry(h.db, "IESA6", "U1").draft.blueprint, SAMPLE_BLUEPRINT);
  assert.equal(h.pushes.length, 0);
  const usage = h.db.raw.prepare("SELECT kind, customer_id FROM llm_usage ORDER BY customer_id").all();
  assert.deepEqual(usage.map((row) => [row.kind, row.customer_id]), [["followup", "U1"], ["followup", "U2"]]);
  assert.ok(h.sender.stats().thbToday > 0);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /สร้างเสร็จ 2 ราย/u);
  assert.match(h.notes[0], /สวิตช์ส่งตอนนี้ pregenerate/u, "บอกทีมว่ายังต้องเปิด on");
  assert.doesNotMatch(h.notes[0], /เปิดดูตัวอย่างในคอนโซล/u, "ไม่ชี้ไปหน้าที่ยังไม่มีในคอนโซล");
  h.state.clock = SEND_AT + MIN;
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 0, "pregenerate ไม่ส่งแม้ถึงเวลา");
  assert.equal(h.notes.length, 2, "เลยเวลาส่งแล้วสวิตช์ยังไม่ on = แจ้งทีมหนึ่งครั้ง");
  assert.match(h.notes[1], /เลยเวลาส่ง .* แต่สวิตช์ส่งยังเป็น pregenerate/u);
  await h.sender.runOnce();
  assert.equal(h.notes.length, 2);
});

test("on: ก่อน 10:00 จันทร์ไม่ส่ง · 10:00 ส่งทีละคนห่าง 2 วิ พร้อม retry key · สรุปให้ทีมครั้งเดียว", async (t) => {
  const h = harness(t);
  for (const id of ["U1", "U2", "U3"]) await h.submit(id);
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  assert.equal(listEntries(h.db, "IESA6").filter((e) => e.status === "ready").length, 3);
  h.state.clock = SEND_AT - 1000; // 09:59:59
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 0);
  h.state.clock = SEND_AT;
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 3);
  assert.deepEqual(h.sleeps, [2000, 2000], "เว้นจังหวะระหว่าง push");
  for (const push of h.pushes) {
    assert.match(push.retryKey, /^[0-9a-f-]{36}$/u);
    assert.equal(push.purpose, "campaign_delivery");
    assert.equal(push.messages.length, PER_DELIVERY);
    assert.equal(push.messages[0].type, "flex");
    if (PER_DELIVERY === 2) assert.equal(push.messages[1].type, "text");
    assert.ok(Buffer.byteLength(JSON.stringify(push.messages[0].contents)) <= FLEX_CONTENTS_MAX_BYTES);
  }
  assert.equal(new Set(h.pushes.map((p) => p.retryKey)).size, 3);
  for (const id of ["U1", "U2", "U3"]) {
    assert.equal(status(h.db, id), "sent");
    const rows = h.db.raw.prepare("SELECT message_class, agent_mode FROM messages WHERE customer_id = ? AND direction = 'out' AND message_class = 'proactive'").all(id).map((row) => ({ ...row }));
    assert.deepEqual(rows, Array.from({ length: PER_DELIVERY }, () => ({ message_class: "proactive", agent_mode: "blueprint" })));
  }
  const summaries = h.notes.filter((n) => /ส่งแบบวางระบบ/u.test(n));
  assert.equal(summaries.length, 1);
  assert.match(summaries[0], /แล้ว 3 ราย/u);
  h.state.clock += 5 * MIN;
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 3, "รอบถัดไปไม่ส่งซ้ำ");
  assert.equal(h.notes.filter((n) => /ส่งแบบวางระบบ/u.test(n)).length, 1);
});

test("กันส่งซ้ำ: รอบซ้อนในโปรเซสเดียว + สองโปรเซสพร้อมกัน → ทุกคนได้ครั้งเดียว", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const h = harness(t, { push: async () => { await gate; return null; } });
  for (const id of ["U1", "U2"]) await h.submit(id);
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  h.state.clock = SEND_AT;
  const other = h.makeSender();
  const runs = [h.sender.runOnce(), h.sender.runOnce(), other.runOnce()];
  setTimeout(release, 20);
  const results = await Promise.all(runs);
  assert.equal(results[1].skipped, "run_in_flight");
  assert.equal(h.pushes.length, 2);
  assert.equal(new Set(h.pushes.map((p) => p.to)).size, 2);
  assert.ok(["U1", "U2"].every((id) => status(h.db, id) === "sent"));
});

test("โปรเซสตายกลางการส่ง → รอบหลังยิงซ้ำด้วย retry key เดิม · LINE ตอบ 409 = รับไปแล้ว ไม่บันทึกประวัติซ้ำ", async (t) => {
  const h = harness(t);
  await h.submit("U1");
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  // จำลอง: จองแล้ว (sending + retryKey) แต่ตายก่อนจดผล
  const key = "blueprint_req:IESA6:U1";
  const entry = JSON.parse(h.db.getSetting(key));
  h.db.setSetting(key, JSON.stringify({ ...entry, status: "sending", send: { retryKey: "6f1c2b9e-0a4d-4c3e-9b1a-2d3e4f5a6b7c", firstClaimAt: SEND_AT, claimedAt: SEND_AT, owner: "dead", attempts: 1 } }));
  h.state.clock = SEND_AT + 30_000;
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 0, "ยังไม่ค้างนานพอ ห้ามยิงซ้ำ (อาจกำลังส่งอยู่)");
  h.state.clock = SEND_AT + 3 * MIN;
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 1);
  assert.equal(h.pushes[0].retryKey, "6f1c2b9e-0a4d-4c3e-9b1a-2d3e4f5a6b7c");
  assert.equal(status(h.db, "U1"), "sent");
});

test("ผลกำกวม (5xx/timeout) → ค้าง sending แล้วลองซ้ำด้วย key เดิมไม่เกิน 3 ครั้ง · 409 = สำเร็จ", async (t) => {
  const h = harness(t, { push: async (args, n) => (n === 1 ? { ok: false, status: 500, ambiguous: true } : { ok: true, status: 409, duplicate: true }) });
  await h.submit("U1");
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  h.state.clock = SEND_AT;
  await h.sender.runOnce();
  assert.equal(status(h.db, "U1"), "sending");
  h.state.clock = SEND_AT + 3 * MIN;
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 2);
  assert.equal(h.pushes[0].retryKey, h.pushes[1].retryKey);
  assert.equal(status(h.db, "U1"), "sent");
  const delivered = h.db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id = 'U1' AND message_class = 'proactive'").get();
  assert.equal(delivered.n, PER_DELIVERY, "409 = LINE รับคำขอเดิมไปแล้ว — รอบกำกวมไม่เคยจดประวัติ จึงจดครั้งเดียวตอนนี้ (ลูกแพรต้องเห็นแผนที่ลูกค้าได้)");
  h.state.clock += 5 * MIN;
  await h.sender.runOnce();
  assert.equal(h.db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id = 'U1' AND message_class = 'proactive'").get().n, PER_DELIVERY);
});

test("กำกวมครบ 3 ครั้ง → failed ไม่ยิงต่อ", async (t) => {
  const h = harness(t, { push: async () => ({ ok: false, status: 0, ambiguous: true }) });
  await h.submit("U1");
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  for (let i = 0; i < 6; i += 1) {
    h.state.clock = SEND_AT + i * 3 * MIN;
    await h.sender.runOnce();
  }
  assert.equal(h.pushes.length, 3);
  assert.equal(status(h.db, "U1"), "failed");
});

test("ส่งไม่ถึง: บล็อก OA → undeliverable ไม่ยิง · LINE 400 (การ์ดแล้วข้อความก็ 400) → undeliverable ไม่ลองซ้ำ · DND → ข้าม", async (t) => {
  const h = harness(t, { push: async (args) => (args.to === "U-400" ? { ok: false, status: 400 } : null) });
  for (const id of ["U-blocked", "U-400", "U-dnd", "U-ok"]) await h.submit(id);
  h.db.recordLineFollow({ customerId: "U-blocked", followed: false });
  h.db.raw.prepare("UPDATE customers SET do_not_disturb = 1 WHERE line_user_id = 'U-dnd'").run();
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  h.state.clock = SEND_AT;
  await h.sender.runOnce();
  h.state.clock = SEND_AT + 10 * MIN;
  await h.sender.runOnce();
  assert.deepEqual(h.pushes.map((p) => p.to).sort(), ["U-400", "U-400", "U-ok"], "400 ตอนส่งการ์ด = ลองข้อความอีกครั้งเดียว");
  const to400 = h.pushes.filter((p) => p.to === "U-400");
  assert.deepEqual(to400.map((p) => p.messages[0].type), ["flex", "text"]);
  assert.notEqual(to400[0].retryKey, to400[1].retryKey, "เนื้อหาใหม่ = retry key ใหม่");
  assert.equal(readEntry(h.db, "IESA6", "U-400").lastError, "line_400");
  assert.equal(status(h.db, "U-blocked"), "undeliverable");
  assert.equal(readEntry(h.db, "IESA6", "U-blocked").lastError, "unfollowed");
  assert.equal(status(h.db, "U-400"), "undeliverable");
  assert.equal(status(h.db, "U-dnd"), "skipped");
  assert.equal(status(h.db, "U-ok"), "sent");
});

test("ด่านของเราเอง (ปิดส่งจริง) → กลับเป็น ready หยุดรอบ แจ้งทีมวันละครั้ง ไม่เสียโอกาสส่ง", async (t) => {
  const h = harness(t, { push: async () => ({ ok: false, blocked: true, reason: "live_send_disabled" }) });
  for (const id of ["U1", "U2"]) await h.submit(id);
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  h.state.clock = SEND_AT;
  await h.sender.runOnce();
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 2, "หยุดหลังคนแรกในแต่ละรอบ");
  assert.ok(["U1", "U2"].every((id) => status(h.db, id) === "ready"));
  assert.equal(h.notes.filter((n) => /หยุดชั่วคราว/u.test(n)).length, 1);
});

test("เพดานเงินรายวัน: ถึงเพดาน = ไม่เรียกโมเดล แจ้งทีมครั้งเดียว · ขึ้นวันใหม่ทำต่อ", async (t) => {
  const h = harness(t);
  await h.submit("U1");
  h.db.setSetting("blueprint_daily_cap_thb", "0.01");
  h.db.setSetting("blueprint_send_mode", "pregenerate");
  await h.sender.runOnce();
  await h.sender.runOnce();
  assert.equal(h.hermesCalls.length, 0);
  assert.equal(h.notes.filter((n) => /เพดาน/u.test(n)).length, 1);
  h.db.setSetting("blueprint_daily_cap_thb", "150");
  await h.sender.runOnce();
  assert.equal(h.hermesCalls.length, 1);
  assert.equal(status(h.db, "U1"), "ready");
});

test("คำตอบโมเดลผิดรูป/มีชื่อค่ายโมเดล → ลองใหม่ได้ 3 ครั้งแล้ว failed (ไม่ส่งของที่ไม่ผ่าน)", async (t) => {
  const bad = { ...SAMPLE_BLUEPRINT, toolsHint: "ใช้ ChatGPT ต่อกับ LINE" };
  const h = harness(t, { hermesText: (args, n) => ({ text: n === 1 ? "ขอโทษค่ะ" : JSON.stringify(bad), usage: { prompt_tokens: 10, completion_tokens: 10 }, model: args.model }) });
  await h.submit("U1");
  h.db.setSetting("blueprint_send_mode", "on");
  for (let i = 0; i < 4; i += 1) await h.sender.runOnce();
  assert.equal(h.hermesCalls.length, 3);
  assert.equal(status(h.db, "U1"), "failed");
  assert.match(readEntry(h.db, "IESA6", "U1").lastError, /invalid/u);
  h.state.clock = SEND_AT;
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 0);
});

test("ส่งใหม่ระหว่างสร้าง = ทิ้งร่างเก่า สร้างจากข้อมูลล่าสุด · หลังได้แล้วส่งใหม่ (ไม่เกินจำนวนที่ให้) = ได้ฉบับใหม่", async (t) => {
  let h;
  h = harness(t, { hermesText: (args, n) => {
    if (n === 1) {
      // ลูกค้าแก้ข้อความแล้วส่งใหม่ระหว่างที่โมเดลกำลังร่างฉบับแรก
      return h.submit("U1", "โรงแรมบูทีค").then(() => ({ text: JSON.stringify(SAMPLE_BLUEPRINT), usage: null, model: args.model }));
    }
    return { text: JSON.stringify(SAMPLE_BLUEPRINT), usage: null, model: args.model };
  } });
  await h.submit("U1");
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  assert.equal(status(h.db, "U1"), "pending", "ร่างของข้อมูลเก่าถูกทิ้ง ไม่กลายเป็น ready");
  await h.sender.runOnce();
  assert.equal(h.hermesCalls.length, 2);
  assert.match(h.hermesCalls[1].userText, /โรงแรมบูทีค/u);
  assert.equal(status(h.db, "U1"), "ready");
  h.state.clock = SEND_AT;
  await h.sender.runOnce();
  assert.equal(status(h.db, "U1"), "sent");
  await h.submit("U1", "คลินิกทันตกรรม");
  assert.equal(status(h.db, "U1"), "pending");
  h.state.clock += 5 * MIN;
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 2);
  assert.equal(readEntry(h.db, "IESA6", "U1").sendCount, 2);
});

test("คำขอหลังเวลาส่ง: ส่งเมื่อสร้างเสร็จ แต่ไม่ส่งช่วงพักเสียง 21:00–09:00 (เลื่อนไป 09:00)", async (t) => {
  const h = harness(t);
  h.db.setSetting("blueprint_send_mode", "on");
  h.state.clock = Date.parse("2026-10-12T21:30:00+07:00");
  await h.submit("U-late");
  await h.sender.runOnce();
  assert.equal(status(h.db, "U-late"), "ready");
  assert.equal(h.pushes.length, 0);
  h.state.clock = Date.parse("2026-10-13T08:59:00+07:00");
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 0);
  h.state.clock = Date.parse("2026-10-13T09:00:00+07:00");
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 1);
  assert.equal(status(h.db, "U-late"), "sent");
});

test("คืน FU: ครบกำหนด = คืนค่าเดิม (ทุกโหมด แม้ off) · ทีม/ลูกค้าเปลี่ยนเองระหว่างพัก = ไม่คืน", async (t) => {
  const h = harness(t);
  await h.submit("U-restore");
  await h.submit("U-human");
  await h.submit("U-considering");
  h.db.setFollowupEnabled("U-human", false); // ทีมกดปิดเองระหว่างพัก (choice=1, enabled=0 — แยกไม่ออกจากของเรา)
  h.db.setFollowupEnabled("U-human", true); // แล้วกดเปิดคืน
  h.db.suppressFollowupsForCustomer("U-considering", "customer_considering");
  assert.equal(h.db.getCustomer("U-restore").followup_enabled, 0);
  h.state.clock = SEND_AT + 7 * DAY - 1;
  await h.sender.runOnce();
  assert.equal(h.db.getCustomer("U-restore").followup_enabled, 0);
  h.state.clock = SEND_AT + 7 * DAY;
  await h.sender.runOnce();
  assert.equal(h.db.getCustomer("U-restore").followup_enabled, 1);
  assert.equal(h.db.getCustomer("U-restore").followup_choice_by_human, 0);
  assert.equal(readEntry(h.db, "IESA6", "U-restore").hold.result, "restored");
  assert.equal(h.db.getCustomer("U-considering").followup_enabled, 0, "ลูกค้าบอกขอคิดก่อน = ไม่คืน");
  assert.equal(readEntry(h.db, "IESA6", "U-considering").hold.result, "kept_later_change");
  assert.equal(h.db.getCustomer("U-human").followup_enabled, 1);
  await h.sender.runOnce();
  assert.equal(h.db.listAudit().filter((a) => a.action === "blueprint_followup_release").length, 3, "คืนครั้งเดียวต่อคน");
});

test("พ้นช่วงแคมเปญ: ที่ยังไม่ได้ส่ง = expired ไม่ส่ง · /health ไม่มีรหัสลูกค้า", async (t) => {
  const h = harness(t);
  await h.submit("U-exp");
  h.db.setSetting("blueprint_send_mode", "on");
  h.state.clock = SEND_AT + 8 * DAY;
  await h.sender.runOnce();
  assert.equal(status(h.db, "U-exp"), "expired");
  assert.equal(h.hermesCalls.length, 0);
  const stats = h.sender.stats();
  assert.equal(stats.requests.expired, 1);
  assert.doesNotMatch(JSON.stringify(stats), /U-exp/u);
});

test("พักทั้งระบบ = ไม่สร้าง ไม่ส่ง (คืน FU ยังเดิน)", async (t) => {
  const h = harness(t);
  await h.submit("U1");
  h.db.setSetting("blueprint_send_mode", "on");
  h.db.setSetting("ai_paused", "1");
  h.state.clock = SEND_AT;
  const result = await h.sender.runOnce();
  assert.equal(result.skipped, "ai_paused");
  assert.equal(h.hermesCalls.length, 0);
  assert.equal(h.pushes.length, 0);
});

/* --------------------- รีวิวก่อนขึ้นจริง 11 ต.ค. (ข้อ major/minor ของฝั่งลูกแพร) --------------------- */

test("LINE 400 ตอนส่งการ์ด → ส่งเป็นข้อความแทนครั้งเดียว (retry key ใหม่) สำเร็จ = sent · จดเหตุผลจาก LINE ไว้ให้ทีม", async (t) => {
  const h = harness(t, { push: async (args) => (args.messages[0].type === "flex"
    ? { ok: false, status: 400, errorDetail: "A message (messages[0]) in the request body is invalid" } : null) });
  await h.submit("U1");
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  h.state.clock = SEND_AT;
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 2);
  assert.ok(h.pushes.every((p) => p.includeErrorDetail === true), "ขอเหตุผลจาก LINE เฉพาะเส้นแคมเปญ");
  assert.equal(h.pushes[1].messages[0].type, "text");
  assert.match(h.pushes[1].messages[0].text, /การวางระบบ AI Agent ของคุณ/u);
  const entry = readEntry(h.db, "IESA6", "U1");
  assert.equal(entry.status, "sent");
  assert.equal(entry.lastSent.format, "text");
  assert.match(entry.lastError, /^line_400_flex:A message/u);
  assert.equal(h.db.listAudit().filter((a) => a.action === "blueprint_flex_rejected").length, 1);
});

test("LINE 403 = ปัญหาระดับช่อง ไม่ใช่รายคน → หยุดรอบ คง ready แจ้งทีม (ไม่ตีว่าส่งไม่ถึง)", async (t) => {
  const h = harness(t, { push: async () => ({ ok: false, status: 403, errorDetail: "Access to this API is not available for your account" }) });
  for (const id of ["U1", "U2"]) await h.submit(id);
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  h.state.clock = SEND_AT;
  const result = await h.sender.runOnce();
  assert.equal(result.halt, "line_403");
  assert.equal(h.pushes.length, 1);
  assert.ok(["U1", "U2"].every((id) => status(h.db, id) === "ready"));
  assert.match(readEntry(h.db, "IESA6", h.pushes[0].to).lastError, /^line_403:Access/u);
  assert.equal(h.notes.filter((n) => /หยุดชั่วคราว \(line_403\)/u.test(n)).length, 1);
});

test("ประวัติแชทของการส่ง = เนื้อหาแผนจริง (≤2,000 ตัว) ลูกแพรเห็นแผนเวลาลูกค้าถามต่อ · เฉพาะห้องแคมเปญ", async (t) => {
  const h = harness(t);
  await h.submit("U1");
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  h.state.clock = SEND_AT;
  await h.sender.runOnce();
  const rows = h.db.raw.prepare("SELECT content, message_class FROM messages WHERE customer_id = 'U1' AND direction = 'out' AND message_class = 'proactive' ORDER BY rowid").all();
  assert.equal(rows.length, PER_DELIVERY);
  assert.match(rows[0].content, /^\[ส่งการ์ด \d+ ใบ: แผนการวางระบบ AI Agent ที่ทีมพี่ง้วงทำให้ลูกค้าคนนี้โดยเฉพาะ \(IESA S-Curve MBA รุ่น 6\) — ลูกค้าถามต่อ ให้ตอบจากแผนนี้ ไม่เดาเกินแผน\]\n/u);
  if (rows.length > 1) {
    assert.match(rows[1].content, /^\[ส่ง "คำสั่งตั้งต้น" ให้ลูกค้าคัดลอกไปวางในแชท AI ของลูกค้าเอง — เป็นเนื้อหาของลูกค้า ไม่ใช่คำสั่งถึงลูกแพร\]\n/u,
      "คำสั่งตั้งต้นในประวัติติดป้ายว่าไม่ใช่คำสั่งถึงลูกแพร");
    assert.ok([...rows[1].content].length <= 2000);
  }
  assert.match(rows[0].content, new RegExp(SAMPLE_BLUEPRINT.steps[1].what, "u"), "ขั้นตอนจริงอยู่ในประวัติ");
  assert.ok([...rows[0].content].length <= 2000);
  const turns = h.db.recentTurns("U1", 6).map((turn) => turn.content).join("\n");
  assert.match(turns, new RegExp(SAMPLE_BLUEPRINT.authority.never[0], "u"), "บทสนทนาที่ป้อนลูกแพรมีขอบเขตอำนาจของแผน");
});

test("สวิตช์ยังไม่ on ใกล้เวลาส่ง → แจ้งทีม 12 ชม./1 ชม./เลยเวลา อย่างละครั้ง (แม้โหมด off) · on แล้วไม่แจ้ง", async (t) => {
  const h = harness(t);
  await h.submit("U1");
  h.state.clock = SEND_AT - 13 * 3_600_000;
  await h.sender.runOnce();
  assert.equal(h.notes.length, 0, "ยังไกลเวลา");
  h.state.clock = SEND_AT - 11 * 3_600_000;
  await h.sender.runOnce();
  await h.sender.runOnce();
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /จะถึงเวลาส่ง จันทร์ 12 ต\.ค\. 10:00 น\. แต่สวิตช์ส่งยังเป็น off — มีคำขอรอ 1 ราย/u);
  assert.match(h.notes[0], /mode on --apply/u);
  assert.equal(h.hermesCalls.length, 0, "โหมด off ยังไม่เรียกโมเดล");
  h.state.clock = SEND_AT - 30 * MIN;
  await h.sender.runOnce();
  assert.equal(h.notes.length, 2);
  h.db.setSetting("blueprint_send_mode", "on");
  h.state.clock = SEND_AT - 20 * MIN;
  await h.sender.runOnce();
  h.state.clock = SEND_AT + 30 * MIN;
  await h.sender.runOnce();
  assert.equal(h.notes.filter((n) => /สวิตช์ส่งยังเป็น/u.test(n)).length, 2, "เปิด on แล้วไม่แจ้งเรื่องสวิตช์อีก");
});

test("เพดานเรียกโมเดลต่อคน: ส่งข้อความใหม่ซ้ำ ๆ + โมเดลตอบผิดรูป = เรียกได้ไม่เกิน 6 ครั้งตลอดแคมเปญ แล้ว failed", async (t) => {
  const h = harness(t, { hermesText: (args) => ({ text: "ขอโทษค่ะ", usage: { prompt_tokens: 10, completion_tokens: 10 }, model: args.model }) });
  h.db.setSetting("blueprint_send_mode", "pregenerate");
  for (let round = 0; round < 4; round += 1) {
    await h.submit("U1", `ร้านที่ ${round}`);
    for (let i = 0; i < 4; i += 1) await h.sender.runOnce();
  }
  assert.equal(h.hermesCalls.length, 6);
  const entry = readEntry(h.db, "IESA6", "U1");
  assert.equal(entry.status, "failed");
  assert.equal(entry.lastError, "model_call_cap");
});

test("ข้อความเดิมเป๊ะส่งซ้ำระหว่างรอส่ง = ไม่ทิ้งร่าง ไม่เรียกโมเดลใหม่ (ยังตอบรับ)", async (t) => {
  const h = harness(t);
  await h.submit("U1", "ร้านกาแฟสองสาขา", "in:t1");
  h.db.setSetting("blueprint_send_mode", "pregenerate");
  await h.sender.runOnce();
  assert.equal(status(h.db, "U1"), "ready");
  const again = await h.submit("U1", "ร้านกาแฟสองสาขา", "in:t2");
  assert.equal(again.sent, true, "ยังตอบรับให้คนที่กดส่งซ้ำ (ข้อความใหม่จาก webhook)");
  const replay = await h.submit("U1", "ร้านกาแฟสองสาขา");
  assert.equal(replay.suppressed, "blueprint_duplicate", "เส้นเดิมเล่นข้อความค้างซ้ำ (ไม่มี turnId) = ไม่ใช่คำขอใหม่");
  await h.sender.runOnce();
  assert.equal(h.hermesCalls.length, 1);
  const entry = readEntry(h.db, "IESA6", "U1");
  assert.equal(entry.status, "ready");
  assert.equal(entry.submissions, 2);
  assert.ok(entry.draft?.blueprint);
});

test("เงินที่ provider อาจคิดไปแล้ว: ได้ null หลังทำงานนาน = นับค่าประมาณ · null ทันที (ไม่ได้ยิง) = ไม่นับ", async (t) => {
  let h;
  h = harness(t, { hermesText: (args, n) => {
    if (n === 1) h.state.clock += 6_000; // 5xx แล้วลองซ้ำจนหมด ใช้เวลา 6 วิ
    return null;
  } });
  await h.submit("U1");
  h.db.setSetting("blueprint_send_mode", "pregenerate");
  await h.sender.runOnce();
  const afterSlow = h.sender.stats().thbToday;
  assert.ok(afterSlow > 0, "นับค่าประมาณเข้าเพดาน");
  await h.sender.runOnce();
  assert.equal(h.sender.stats().thbToday, afterSlow, "null ทันทีไม่นับ");
});

test("ส่งใหม่ระหว่างกำลังส่ง แต่ครบจำนวนที่แคมเปญให้แล้ว → จบที่ sent ไม่สร้าง/ไม่ส่งรอบใหม่", async (t) => {
  let h;
  h = harness(t, {
    campaign: { maxSendsPerPerson: 1 },
    push: async () => { await h.submit("U1", "โรงแรมบูทีค"); return null; },
  });
  await h.submit("U1");
  h.db.setSetting("blueprint_send_mode", "on");
  await h.sender.runOnce();
  h.state.clock = SEND_AT;
  await h.sender.runOnce();
  h.state.clock += 10 * MIN;
  await h.sender.runOnce();
  await h.sender.runOnce();
  assert.equal(h.pushes.length, 1);
  assert.equal(h.hermesCalls.length, 1);
  const entry = readEntry(h.db, "IESA6", "U1");
  assert.equal(entry.status, "sent");
  assert.equal(entry.lastError, "max_sends_resubmit_ignored");
});

test("โมดูลเนื้อหามีคำสั่งตั้งต้น (buildAgentBriefText) → ส่งต่อท้ายการ์ดในคำขอเดียว · ไม่มี = การ์ดอย่างเดียว", async (t) => {
  const h = harness(t);
  const { blueprintContent } = await import("../src/blueprintContent.mjs");
  const base = blueprintContent();
  const withBrief = { ...base, buildAgentBriefText: (bp) => `คำสั่งตั้งต้นสำหรับผู้ช่วย AI ของคุณ (กดค้างเพื่อคัดลอก)\nคุณคือ${bp.agentName}` };
  const sender = createBlueprintSender({ db: h.db, config: testConfig(), line: { pushMessages: async () => ({ ok: true }) }, content: withBrief, logger: silent });
  const rendered = sender.renderMessages(SAMPLE_BLUEPRINT, { title: "x", sendAt: "2026-10-12T10:00:00+07:00" }, null);
  assert.deepEqual(rendered.messages.map((m) => m.type), ["flex", "text"]);
  assert.match(rendered.messages[1].text, /คุณคือผู้ช่วยตอบแชทหน้าร้าน/u);
  const textOnly = sender.renderMessages(SAMPLE_BLUEPRINT, { title: "x" }, null, { textOnly: true });
  assert.deepEqual(textOnly.messages.map((m) => m.type), ["text", "text"]);
  const plain = h.sender.renderMessages(SAMPLE_BLUEPRINT, { title: "x" }, null);
  assert.equal(plain.messages.length, typeof base.buildAgentBriefText === "function" ? 2 : 1);
});
