// owner-chat-lookup-catalog — ตัวตรวจแผนค้นของ "ถามอะไรก็ค้นให้" (28 ก.ย. 2026 บ่าย)
// โมเดลเลือกได้แค่ "ชื่อคิวรีในรายการปิด + ค่าที่ตรวจชนิด/ขอบเขตแล้ว" — ไม่มีทางส่ง SQL/คำสั่งใด ๆ
// JSON พัง = ไม่ค้น · ชื่อไม่รู้จัก = ทิ้ง · อาร์กิวเมนต์แปลก = ไม่สน · เกินขอบ = ตัดเข้าขอบพร้อมจดไว้
// · ชื่อลูกค้าต้องอยู่ในข้อความพี่ง้วงจริง · ไม่เกิน 3 คิวรี · คุยเล่นไม่เรียกตัววางแผนเลย
import test from "node:test";
import assert from "node:assert/strict";
import {
  LOOKUP_CATALOG, LOOKUP_MAX_QUERIES, looksLikeCommand, lookupPlannerSystem, lookupPlannerTranscript, needsLookup, validateLookupPlan,
} from "../src/ownerChatLookupCatalog.mjs";

// จันทร์ 28 ก.ย. 2026 เวลา 12:00 น. (เวลาไทย) · 90 วันย้อนหลังเริ่ม 1 ก.ค. · ต้นเดือน 1 ก.ย.
const NOW = Date.UTC(2026, 8, 28, 5, 0, 0);
const TODAY = "2026-09-28";
const OLDEST = "2026-07-01";
const plan = (queries, ownerText = "") => validateLookupPlan(JSON.stringify({ queries }), { ownerText, nowMs: NOW });

test("แผน: JSON พัง / ไม่ใช่ object / ไม่มี queries = ไม่ค้นอะไร · มีคำอธิบายรอบ JSON ยังอ่านได้", () => {
  for (const raw of ["", "ไม่ต้องค้นค่ะ", "{bad json", "[1,2,3]", "{\"queries\":\"activity\"}", "null", "{\"q\":[]}", undefined]) {
    assert.deepEqual(validateLookupPlan(raw, { nowMs: NOW }), { queries: [], dropped: [] }, String(raw));
  }
  const wrapped = validateLookupPlan("ค้นแบบนี้ค่ะ ```json\n{\"queries\":[{\"name\":\"topics\",\"args\":{\"days\":7}}]}\n```", { nowMs: NOW });
  assert.deepEqual(wrapped.queries, [{ name: "topics", args: { days: 7, channel: "all" }, notes: [] }]);
});

test("แผน: ชื่อคิวรีไม่รู้จัก (รวมชื่อใน prototype) = ทิ้ง · อาร์กิวเมนต์แปลก = ไม่สน · args ผิดรูป = ใช้ค่าตั้งต้น", () => {
  const out = plan([
    { name: "drop_table", args: {} },
    { name: "constructor", args: {} },
    { name: "__proto__", args: {} },
    { name: 42, args: {} },
    { name: "topics", args: { days: 3, sql: "DELETE FROM customers", channel: "LINE" } },
    { name: "waiting", args: ["freshHours", 1] },
  ]);
  assert.deepEqual(out.dropped.map((d) => [d.name, d.reason]), [
    ["drop_table", "unknown_query"], ["constructor", "unknown_query"], ["__proto__", "unknown_query"], ["?", "unknown_query"],
  ]);
  assert.deepEqual(out.queries, [
    { name: "topics", args: { days: 3, channel: "LINE" }, notes: [] },
    { name: "waiting", args: { freshHours: 48, limit: 8 }, notes: [] },
  ]);
});

test("แผน: ตัวเลขเกินขอบ = ตัดเข้าขอบพร้อมจดให้ลูกแพรบอกพี่ง้วง · ผิดชนิด = ค่าตั้งต้น · enum/bool ไม่ตรง = ค่าตั้งต้น", () => {
  const out = plan([
    { name: "topics", args: { days: 400 } },
    { name: "search", args: { keyword: "ราคา", days: 0, channel: "line" } },
    { name: "followups", args: { days: "14", replyHours: "7 ชม.", channel: "tiktok" } },
    { name: "leads", args: { minScore: 9, maxScore: 5, dealStatus: "PAID_CONFIRMED", waitingReply: "true", noTeamContact: "yes", limit: 99, sort: "random" } },
  ]);
  assert.equal(out.queries.length, 3, "เพดาน 3 คิวรี");
  assert.deepEqual(out.queries[0], { name: "topics", args: { days: 90, channel: "all" }, notes: ["ขอ 400 — ใช้ 90 (ขอบเขต 1–90)"] });
  assert.deepEqual(out.queries[1], { name: "search", args: { keyword: "ราคา", days: 1, channel: "LINE" }, notes: ["ขอ 0 — ใช้ 1 (ขอบเขต 1–90)"] });
  assert.deepEqual(out.queries[2], { name: "followups", args: { days: 14, channel: "all", replyHours: 24 }, notes: [] });
  assert.deepEqual(out.dropped, [{ name: "leads", reason: "over_limit" }]);

  const leads = plan([{ name: "leads", args: { minScore: 9, maxScore: 5, dealStatus: "PAID_CONFIRMED", waitingReply: "true", noTeamContact: "yes", limit: 99, sort: "random", aiState: "OFF" } }]);
  assert.deepEqual(leads.queries[0].args, {
    minScore: 5, maxScore: 9, activeDays: 7, channel: "all", dealStatus: "paid_confirmed", waitingReply: true,
    noTeamContact: false, aiState: "off", sort: "score", limit: 10,
  }, "ช่วงคะแนนกลับหัว = สลับให้");
  assert.deepEqual(leads.queries[0].notes, ["ขอ 99 — ใช้ 10 (ขอบเขต 1–10)"]);
});

test("แผน: วันที่ — อนาคต = วันนี้ · เกิน 90 วัน = เริ่มวันแรกที่ค้นได้ · กลับหัว = สลับ · วันที่ไม่มีจริง/ผิดรูปของช่องบังคับ = ทิ้งคิวรี", () => {
  const future = plan([{ name: "activity", args: { from: "2026-10-05" } }]);
  assert.deepEqual(future.queries[0].args, { from: TODAY, to: TODAY, channel: "all", byDay: true });
  assert.deepEqual(future.queries[0].notes, ["ขอวันที่ 2026-10-05 (อนาคต) — ใช้วันนี้แทน"]);

  const old = plan([{ name: "activity", args: { from: "2026-01-01", to: "2026-09-27", byDay: false } }]);
  assert.deepEqual(old.queries[0].args, { from: OLDEST, to: "2026-09-27", channel: "all", byDay: false });
  assert.match(old.queries[0].notes[0], /ค้นได้ไม่เกิน 90 วัน จึงเริ่มที่ 2026-07-01/u);

  const swapped = plan([{ name: "activity", args: { from: "2026-09-27", to: "2026-09-20" } }]);
  assert.deepEqual([swapped.queries[0].args.from, swapped.queries[0].args.to], ["2026-09-20", "2026-09-27"]);

  const bad = plan([
    { name: "activity", args: { from: "2026-02-30" } },
    { name: "activity", args: { from: "28/09/2026" } },
    { name: "activity", args: {} },
    { name: "aiCost", args: { from: "เมื่อวาน", to: "2026-09-31" } },
  ]);
  assert.deepEqual(bad.dropped, [
    { name: "activity", reason: "bad_from" }, { name: "activity", reason: "bad_from" }, { name: "activity", reason: "bad_from" },
  ]);
  assert.deepEqual(bad.queries, [{ name: "aiCost", args: { from: "2026-09-01", to: TODAY, byDay: false }, notes: [] }],
    "ช่องไม่บังคับที่ใช้ไม่ได้ = ค่าตั้งต้น (ค่า AI เริ่มต้นเดือน)");
});

test("แผน: ชื่อลูกค้า (room) ต้องอยู่ในข้อความของพี่ง้วงจริง — โมเดลแต่งชื่อ/เติมนามสกุลเอง = ทิ้ง · คำค้นสั้น/ยาว/ไม่ใช่ข้อความ = ทิ้ง", () => {
  const ownerText = "เคสคุณสมชาย ใจดี ตอนนี้เป็นไงบ้าง";
  const ok = plan([{ name: "room", args: { name: "คุณสมชาย" } }, { name: "room", args: { name: "สมชายใจดี" } }], ownerText);
  assert.deepEqual(ok.queries.map((q) => q.args.name), ["คุณสมชาย", "สมชายใจดี"]);
  const invented = plan([
    { name: "room", args: { name: "วิภาวดี" } },
    { name: "room", args: { name: "สมชาย ใจดีมาก" } },
    { name: "room", args: { name: "ส" } },
    { name: "search", args: { keyword: 123 } },
    { name: "search", args: { keyword: "ก".repeat(41) } },
    { name: "search", args: { keyword: "  ราคา   คลาส " } },
  ], ownerText);
  assert.deepEqual(invented.dropped.map((d) => d.reason), ["name_not_in_text", "name_not_in_text", "bad_name", "bad_keyword", "bad_keyword"]);
  assert.deepEqual(invented.queries, [{ name: "search", args: { keyword: "ราคา คลาส", days: 30, channel: "all" }, notes: [] }]);
});

test("แผน: คิวรีซ้ำนับครั้งเดียว (ไม่กินโควตา 3) · เกิน 3 ทิ้งพร้อมเหตุ · อ่านไม่เกิน 10 รายการจากโมเดล", () => {
  const dup = plan([{ name: "waiting", args: {} }, { name: "waiting", args: { freshHours: 48 } }, { name: "funnel", args: {} }]);
  assert.deepEqual(dup.queries.map((q) => q.name), ["waiting", "funnel"]);
  assert.deepEqual(dup.dropped, []);
  const many = plan(Array.from({ length: 30 }, (_, i) => ({ name: "topics", args: { days: i + 1 } })));
  assert.equal(many.queries.length, LOOKUP_MAX_QUERIES);
  assert.equal(many.dropped.length, 7, "อ่านแค่ 10 รายการแรก — ที่เหลือไม่แตะเลย");
  assert.ok(many.dropped.every((d) => d.reason === "over_limit"));
});

test("คุยเล่น/ขอบคุณ/ร่างแคปชั่น = ไม่เรียกตัววางแผน · คำถามเรื่องข้อมูล = เรียก", () => {
  for (const text of ["ขอบคุณมากนะ", "555", "ok", "ฝันดีนะลูกแพร", "ร่างแคปชั่นโปรโมทให้หน่อย", "", "   ", "👍👍"]) {
    assert.equal(needsLookup(text), false, text);
  }
  for (const text of [
    "สัปดาห์นี้ลูกค้าถามเรื่องอะไรมากสุด", "ห้องที่ทักตามแล้วลูกค้าตอบกลับมีกี่ห้อง", "เดือนนี้ค่า AI เท่าไหร่",
    "ลีดร้อนที่ยังไม่มีใครตอบมีใครบ้าง", "เมื่อวานกับวันนี้ต่างกันยังไง", "เคสคุณเอเป็นไงบ้าง", "ช่วยวิเคราะห์ยอดขายหน่อย",
  ]) {
    assert.equal(needsLookup(text), true, text);
  }
});

test("system ของตัววางแผน: วันที่เวลาไทย + ช่วงที่ค้นได้ + ทุกคิวรีในรายการ · ข้อความที่เห็น = แชทล่าสุด 4 เทิร์นย่อ + ข้อความใหม่เท่านั้น", () => {
  const system = lookupPlannerSystem({ nowMs: NOW });
  assert.match(system, /Monday 2026-09-28, time 12:00/u);
  assert.match(system, /Allowed dates: 2026-07-01 to 2026-09-28/u);
  assert.match(system, /\{"queries":\[\]\} for small talk/u);
  for (const name of Object.keys(LOOKUP_CATALOG)) assert.match(system, new RegExp(`^${name} \\{`, "mu"), name);
  assert.match(system, /room\.name must be copied exactly/u);
  assert.match(system, /never invent a filter or window he did not mention/u, "รอบทดสอบจริง: ตัววางแผนเคยใส่ replyHours 72 เอง");

  const history = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `เทิร์น ${i} ${"ย".repeat(400)}` }));
  const transcript = lookupPlannerTranscript({ text: "เมื่อวานเป็นไง", history });
  assert.doesNotMatch(transcript, /เทิร์น [0-3] /u);
  assert.match(transcript, /^แชทล่าสุด \(เก่า→ใหม่\):\nพี่ง้วง: เทิร์น 4/u);
  assert.ok(transcript.split("\n").every((line) => [...line].length <= 310));
  assert.match(transcript, /ข้อความใหม่ของพี่ง้วง: เมื่อวานเป็นไง$/u);
  assert.equal(lookupPlannerTranscript({ text: "ยอดวันนี้" }), "ข้อความใหม่ของพี่ง้วง: ยอดวันนี้");
});

test("รูปคำสั่ง (yolo / เปิด-ปิด AI / สถานะ) ไม่วางแผนค้นล่วงหน้า · คำถามที่มีคำว่าปิดการขาย/เปิดรับไม่ใช่คำสั่ง", () => {
  for (const text of ["yolo LINE คุณเอ ถามต่อ", "ช่วยปิด AI ห้องคุณเอหน่อย", "เปิดai คุณบีด้วย", "สถานะ คุณเอ", "ปิดบอทห้องนี้"]) {
    assert.equal(looksLikeCommand(text), true, text);
  }
  for (const text of ["เดือนนี้ปิดการขายได้กี่คน", "รอบหน้าเปิดรับกี่ที่", "สถานะการขายเดือนนี้เป็นไง", "ลีดร้อนมีใครบ้าง"]) {
    assert.equal(looksLikeCommand(text), false, text);
  }
});
