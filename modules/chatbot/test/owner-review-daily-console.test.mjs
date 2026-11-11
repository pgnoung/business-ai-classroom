// owner-review-daily-console — API แท็บ "ตรวจแชทวันนี้" ของห้องตรวจ (เฟส B · คำสั่งพี่ง้วง 12 ต.ค. 2026)
//   · คิว (น่าห่วงก่อน · ไม่มีข้อความแชท) · รายละเอียดเป็นฟอง [mN] ปิดชื่อ/เบอร์ + ปัญหาผูกฟอง
//   · ป้าย CAS (revision) + ย้อน 10 วิ · ต้องปรับ → บทเรียน (เจ้าของใช้ทันที / ชมพู่รออนุมัติ — คำตอบบอกตรง ๆ)
//   · เห็นด้วย/ไม่เห็นด้วยต่อปัญหา · ดีที่เหลือทั้งหมด (ต้องตรวจห้องน่าห่วงครบก่อน · ห้องสุ่มวัดผลไม่รวม) · ปักระดับ = owner เท่านั้น
//   · /push/pending ของ owner มี "คิวตรวจแชทวันนี้พร้อม N ห้อง (น่าห่วง M)" นับอย่างเดียว (ทีมไม่มี)
// ข้อความลูกค้าเป็นประโยคสังเคราะห์ · ไม่มีการเรียก provider จริง
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { LESSON_SAVED_ACTIVE } from "../src/ownerLessonStore.mjs";
import { bangkokDayKey } from "../src/ownerReviewTaper.mjs";
import { OWNER_REVIEW_CLAIM_MS, createOwnerReviewDailyRoutes } from "../src/consoleOwnerReviewDailyApi.mjs";
import { hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const PASSWORD = "owner-review-daily-console-pass";
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const DAY = 24 * 60 * 60_000;
const PRICE = `U${"a1".repeat(16)}`;
const GOOD1 = `U${"b2".repeat(16)}`;
const GOOD2 = `U${"c3".repeat(16)}`;
const SAMPLED = `U${"d4".repeat(16)}`;

async function start(t, { teach = true } = {}) {
  const db = memoryDb();
  for (const [username, role, displayName] of [["nok", "owner", "พี่ง้วง"], ["admin", "admin", "แอดมิน"], ["chom", "operator", "ชมพู่"]]) {
    db.createOperator({ username, passHash: hashPassword(PASSWORD), displayName, role });
  }
  const notices = [];
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "owner-review-daily-console-secret-0123", TEACH_ENABLED: teach ? "true" : "false" }),
    db,
    overrides: {
      hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {},
      notifier: { fireLater: (args) => notices.push(args), fire: async () => ({}) },
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, notices };
}

async function login(server, username) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200, res.text);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

const get = (server, path, auth) => httpRequest(server, { path, headers: { cookie: auth.cookie } });
const post = (server, path, body, auth, { csrf = true } = {}) => httpRequest(server, {
  method: "POST", path, body: JSON.stringify(body),
  headers: { "content-type": "application/json", cookie: auth.cookie, ...(csrf ? { "x-csrf-token": auth.csrf } : {}) },
});

/** ข้อความ ณ เวลาที่กำหนด (ฐานใช้นาฬิกาจริง — เลื่อน created_at หลังเขียน) */
function msg(db, customerId, direction, content, at, extra = {}) {
  const id = String(db.insertMessage({ customerId, direction, content, agentMode: direction === "out" && !extra.operator ? "ai" : null, ...extra }));
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(at, id);
  return id;
}

/** คิวรายวันที่พร้อมแล้ว: ห้องราคาผิด (น่าห่วง) + ห้องดี 2 ห้อง + ห้องที่ถูกสุ่มวัดผล */
function seedDaily(db) {
  const t = Date.now();
  const slot = t + 60_000;
  const ids = {};
  db.upsertCustomer(PRICE, { displayName: "สมชาย ใจดีมาก" });
  ids.context = msg(db, PRICE, "in", "เมื่อวานถามไว้ครับ", slot - DAY - 3_600_000);
  ids.priceIn = msg(db, PRICE, "in", "ราคาคลาสเท่าไหร่ครับ ผมสมชาย ใจดีมาก โทร 0812345678", t - 3 * 3_600_000);
  ids.priceOut = msg(db, PRICE, "out", "คลาสละ 990 บาทค่ะ", t - 3 * 3_600_000 + 60_000);
  ids.team = msg(db, PRICE, "out", "ชมพู่ขอเช็กให้นะคะ", t - 3 * 3_600_000 + 120_000, { operator: "chom" });
  for (const [id, name] of [[GOOD1, "สมหญิง ตั้งใจ"], [GOOD2, "มานี มีนา"], [SAMPLED, "ปิติ ใจดี"]]) {
    db.upsertCustomer(id, { displayName: name });
    msg(db, id, "in", "สนใจคลาส AI ค่ะ", t - 2 * 3_600_000);
    ids[id] = msg(db, id, "out", "ยินดีค่ะ เล่าให้ฟังนะคะ", t - 2 * 3_600_000 + 60_000);
  }
  const batch = db.claimOwnerReviewBatch({ kind: "daily", slotMs: slot, windowStartMs: slot - DAY, windowEndMs: slot });
  db.insertOwnerReviewItemsForBatch(batch, { dayKey: bangkokDayKey(slot) });
  const items = Object.fromEntries(db.ownerReviewItemsForBatch(batch.id).map((item) => [item.customer_id, item]));
  db.saveOwnerReviewItemReview(items[PRICE].id, {
    aiStatus: "done", risk: 85, summary: "ลูกค้าถามราคา ลูกแพรตอบราคาผิด",
    issues: [{ code: "wrong_price", messageId: ids.priceOut, note: "ราคาไม่ตรงกับรอบนี้" }, { code: "over_long", messageId: "", note: "ยาว" }],
  });
  db.setOwnerReviewItemInclusion(items[PRICE].id, { flagged: true, sampled: false, included: "all" });
  for (const id of [GOOD1, GOOD2, SAMPLED]) {
    db.saveOwnerReviewItemReview(items[id].id, { aiStatus: "done", risk: 10, summary: "ตอบดี", issues: [] });
    db.setOwnerReviewItemInclusion(items[id].id, { flagged: false, sampled: id === SAMPLED, included: "all" });
  }
  db.updateOwnerReviewBatch(batch.id, { status: "ready", readyAt: t, counts: { rooms: 4, taper: { level: 0 } } });
  return { batch, items: Object.fromEntries(Object.entries(items).map(([id, item]) => [id, db.ownerReviewItem(item.id)])), ids };
}

test("คิว: owner/admin/staff ดูได้ · น่าห่วงก่อน · ไม่มีข้อความแชทในคิว · summary มีตัวเลขรายวัน/ระดับ/วันที่ N", async (t) => {
  const { app, db } = await start(t);
  const { batch, items } = seedDaily(db);
  db.setSetting("owner_review_started_day", bangkokDayKey(Date.now()));
  for (const username of ["nok", "admin", "chom"]) {
    const auth = await login(app.server, username);
    const queue = await get(app.server, "/console/api/owner-review/daily", auth);
    assert.equal(queue.status, 200, username);
    assert.equal(queue.json.batch.id, batch.id);
    assert.equal(queue.json.items.length, 4);
    assert.equal(queue.json.items[0].customerId, PRICE, "น่าห่วงก่อน");
    assert.equal(queue.json.items[0].riskLabel, "น่าห่วง");
    assert.equal(queue.json.items[1].riskLabel, "ปกติ");
    assert.deepEqual(queue.json.progress, { total: 4, labelled: 0, remaining: 4, flagged: 1, flaggedRemaining: 1, good: 0, needsFix: 0, rooms: 4 });
    assert.deepEqual(queue.json.bulkGood, { eligible: 2, allowed: false, flaggedRemaining: 1 });
    assert.equal(queue.json.items.find((item) => item.customerId === SAMPLED).mustReview, true);
    assert.equal(queue.json.chips.length, 7);
    assert.equal(queue.json.codes.wrong_price.severity, "high");
    assert.equal(queue.json.canPin, username === "nok");
    assert.doesNotMatch(JSON.stringify(queue.json), /0812345678|คลาสละ 990|ราคาคลาสเท่าไหร่/u, "คิวไม่มีข้อความแชท");
  }
  const auth = await login(app.server, "nok");
  const summary = await get(app.server, "/console/api/owner-review/summary", auth);
  assert.equal(summary.json.tabs[1].count, 4);
  assert.equal(summary.json.daily.progress.remaining, 4);
  assert.equal(summary.json.daily.taper.dayNumber, 1);
  assert.equal(summary.json.daily.taper.warmupDays, 7);
  assert.equal(summary.json.daily.taper.level, 0);
  assert.equal(summary.json.daily.dailyTime, "20:00");
  assert.equal(summary.json.costToday.capThb, 80);
  assert.equal((await get(app.server, `/console/api/owner-review/daily?batch=${items[PRICE].id}`, auth)).status, 404, "batch ต้องเป็นรอบ daily");
  assert.equal((await httpRequest(app.server, { path: "/console/api/owner-review/daily" })).status, 401);
});

test("รายละเอียดห้อง: ฟอง [mN] เรียงเวลา ปิดชื่อ/เบอร์ · ลูกค้า/ลูกแพร/ทีม · ปัญหาผูกฟอง · แตะแก้ได้เฉพาะฟองของลูกแพรในช่วงนั้น", async (t) => {
  const { app, db } = await start(t);
  const { items, ids } = seedDaily(db);
  const auth = await login(app.server, "nok");
  const detail = await get(app.server, `/console/api/owner-review/daily/items/${items[PRICE].id}`, auth);
  assert.equal(detail.status, 200);
  const bubbles = detail.json.bubbles;
  assert.deepEqual(bubbles.map((bubble) => [bubble.ref, bubble.speaker, bubble.inWindow]), [
    ["m1", "customer", false], ["m2", "customer", true], ["m3", "ai", true], ["m4", "team", true],
  ]);
  assert.doesNotMatch(JSON.stringify(detail.json.bubbles), /0812345678|สมชาย ใจดีมาก/u);
  const aiBubble = bubbles.find((bubble) => bubble.id === ids.priceOut);
  assert.equal(aiBubble.fixable, true);
  assert.deepEqual(aiBubble.issueKeys, [`wrong_price@${ids.priceOut}`]);
  assert.equal(bubbles.find((bubble) => bubble.id === ids.team).fixable, false);
  assert.deepEqual(detail.json.unanchoredIssueKeys, ["over_long@"]);
  assert.equal(detail.json.item.issues[0].label, "ราคาผิด");
  assert.equal(detail.json.item.customer.displayName, "สมชาย ใจดีมาก", "ชื่อเต็มไว้จำห้อง (แบบเฟส A)");
  assert.equal(detail.json.lessonsApplyNow, true);
  assert.equal(detail.json.canTeach, true);
  assert.equal(detail.json.room.conversationHash, `#/c/${PRICE}`);
  const chom = await login(app.server, "chom");
  assert.equal((await get(app.server, `/console/api/owner-review/daily/items/${items[PRICE].id}`, chom)).json.lessonsApplyNow, false);
  assert.equal((await get(app.server, "/console/api/owner-review/daily/items/nope", auth)).status, 404);
});

test("ป้าย: ดีแล้ว (revision ต้องตรง) · กดซ้ำด้วย revision เก่า = 409 · ย้อนได้เฉพาะคนกดใน 10 วิ · CSRF/ค่าผิด = ปฏิเสธ", async (t) => {
  const { app, db } = await start(t);
  const { items } = seedDaily(db);
  const nok = await login(app.server, "nok");
  const chom = await login(app.server, "chom");
  const path = `/console/api/owner-review/daily/items/${items[GOOD1].id}`;
  assert.equal((await post(app.server, `${path}/label`, { label: "good", revision: 0 }, nok, { csrf: false })).status, 403);
  assert.equal((await post(app.server, `${path}/label`, { label: "great", revision: 0 }, nok)).status, 400);
  assert.equal((await post(app.server, `${path}/label`, { label: "good" }, nok)).status, 400);
  const labelled = await post(app.server, `${path}/label`, { label: "good", revision: 0 }, nok);
  assert.equal(labelled.status, 200, labelled.text);
  assert.equal(labelled.json.item.label, "good");
  assert.equal(labelled.json.item.labelledByName, "พี่ง้วง");
  assert.equal(labelled.json.item.revision, 1);
  assert.ok(labelled.json.undoUntil > Date.now());
  const stale = await post(app.server, `${path}/label`, { label: "needs_fix", revision: 0 }, chom);
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, "stale_revision");
  assert.equal((await post(app.server, `${path}/undo`, { revision: 1 }, chom)).json.code, "not_undoable");
  const undone = await post(app.server, `${path}/undo`, { revision: 1 }, nok);
  assert.equal(undone.status, 200);
  assert.equal(undone.json.item.label, null);
  const again = await post(app.server, `${path}/label`, { label: "good", revision: 2 }, chom);
  assert.equal(again.json.item.labelledByName, "ชมพู่");
  db.raw.prepare("UPDATE owner_review_items SET labelled_at = labelled_at - 20000 WHERE id = ?").run(items[GOOD1].id);
  assert.equal((await post(app.server, `${path}/undo`, { revision: 3 }, chom)).json.code, "undo_expired");
  const progress = await get(app.server, "/console/api/owner-review/daily", nok);
  assert.equal(progress.json.progress.labelled, 1);
});

test("ต้องปรับ → บทเรียน: พี่ง้วงสอน = ใช้ทันที (คำตอบบอกตรง ๆ) · ชมพู่สอน = รอพี่ง้วงอนุมัติ · ย้อนใน 10 วิ ถอนบทเรียนที่เพิ่งสร้าง", async (t) => {
  const { app, db, notices } = await start(t);
  const { items, ids } = seedDaily(db);
  const nok = await login(app.server, "nok");
  const path = `/console/api/owner-review/daily/items/${items[PRICE].id}`;
  const fixed = await post(app.server, `${path}/fix`, {
    messageId: ids.priceOut, reasonChips: ["wrong_fact", "tell_price"], betterReply: "คลาสนี้ 12,900 บาทค่ะ ได้เรียนสด 2 วันพร้อมใบประกาศฯ", revision: 0,
  }, nok);
  assert.equal(fixed.status, 200, fixed.text);
  assert.equal(fixed.json.lessonStatus, "active");
  assert.equal(fixed.json.appliesNow, true);
  assert.equal(fixed.json.message, LESSON_SAVED_ACTIVE);
  assert.equal(fixed.json.item.label, "needs_fix");
  assert.equal(fixed.json.item.labelVia, "fix");
  const lesson = db.getOwnerLesson(fixed.json.lesson.id);
  assert.equal(lesson.status, "active");
  assert.match(lesson.teaching, /ห้ามเดาตัวเลขหรือรายละเอียดเอง[\s\S]*ควรตอบประมาณว่า: คลาสนี้ 12,900 บาท/u);
  assert.equal(lesson.source_message_id, ids.priceOut);
  assert.doesNotMatch(lesson.customer_text, /0812345678|สมชาย ใจดีมาก/u);
  assert.deepEqual(fixed.json.item.lessons.map((entry) => [entry.id, entry.created]), [[lesson.id, true]]);
  const undone = await post(app.server, `${path}/undo`, { revision: 1 }, nok);
  assert.equal(undone.json.lessonsWithdrawn, 1);
  assert.equal(db.getOwnerLesson(lesson.id), null, "บทเรียนที่เพิ่งสร้างถูกถอน");
  assert.equal(undone.json.item.label, null);

  const chom = await login(app.server, "chom");
  const pending = await post(app.server, `${path}/fix`, { messageId: ids.priceOut, reasonChips: ["curt"], betterReply: "", revision: 2 }, chom);
  assert.equal(pending.status, 200, pending.text);
  assert.equal(pending.json.lessonStatus, "pending");
  assert.equal(pending.json.appliesNow, false);
  assert.match(pending.json.message, /รอ|อนุมัติ/u);
  assert.equal(db.getOwnerLesson(pending.json.lesson.id).status, "pending");
  assert.ok(notices.some((notice) => notice.reason === "lesson_pending"), "ปลุกพี่ง้วงให้อนุมัติ (ทางเดิมของบทเรียน)");
});

test("ต้องปรับ: ฟองที่ไม่ใช่ของลูกแพร = 400 · ไม่มีเหตุผล = 400 · คำสอนมีเบอร์โทร = ปฏิเสธและไม่ติดป้าย · ระบบสอนปิด = ติดป้ายอย่างเดียว", async (t) => {
  const { app, db } = await start(t);
  const { items, ids } = seedDaily(db);
  const nok = await login(app.server, "nok");
  const path = `/console/api/owner-review/daily/items/${items[PRICE].id}/fix`;
  assert.equal((await post(app.server, path, { messageId: ids.team, reasonChips: ["curt"], revision: 0 }, nok)).json.code, "not_fixable");
  assert.equal((await post(app.server, path, { messageId: ids.priceIn, reasonChips: ["curt"], revision: 0 }, nok)).json.code, "not_fixable");
  assert.equal((await post(app.server, path, { messageId: ids[GOOD1], reasonChips: ["curt"], revision: 0 }, nok)).json.code, "not_fixable", "ฟองของห้องอื่น");
  assert.equal((await post(app.server, path, { messageId: ids.priceOut, reasonChips: [], betterReply: "  ", revision: 0 }, nok)).json.code, "fix_empty");
  assert.equal((await post(app.server, path, { messageId: ids.priceOut, reasonChips: ["nope"], revision: 0 }, nok)).status, 400);
  const refused = await post(app.server, path, { messageId: ids.priceOut, reasonChips: [], betterReply: "โทรหาเราที่ 0899999999 ค่ะ", revision: 0 }, nok);
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, "lesson_refused");
  assert.equal(db.ownerReviewItem(items[PRICE].id).label, null, "ปฏิเสธบทเรียน = ไม่ติดป้าย");

  const off = await start(t, { teach: false });
  const seeded = seedDaily(off.db);
  const auth = await login(off.app.server, "nok");
  const result = await post(off.app.server, `/console/api/owner-review/daily/items/${seeded.items[PRICE].id}/fix`,
    { messageId: seeded.ids.priceOut, reasonChips: ["curt"], revision: 0 }, auth);
  assert.equal(result.status, 200);
  assert.equal(result.json.lessonStatus, "teach_off");
  assert.equal(result.json.lesson, null);
  assert.equal(result.json.item.label, "needs_fix");
});

test("เห็นด้วย/ไม่เห็นด้วยกับปัญหาที่ AI ชี้ → ตัวเลขความแม่นต่อรหัส · ปัญหาที่ไม่มี = 404", async (t) => {
  const { app, db } = await start(t);
  const { items, ids } = seedDaily(db);
  const nok = await login(app.server, "nok");
  const path = `/console/api/owner-review/daily/items/${items[PRICE].id}`;
  const agreed = await post(app.server, `${path}/verdict`, { issueKey: `wrong_price@${ids.priceOut}`, verdict: "agree" }, nok);
  assert.equal(agreed.status, 200);
  assert.equal(agreed.json.item.issues[0].verdict, "agree");
  assert.equal((await post(app.server, `${path}/verdict`, { issueKey: "pushy@x", verdict: "agree" }, nok)).status, 404);
  assert.equal((await post(app.server, `${path}/verdict`, { issueKey: "over_long@", verdict: "maybe" }, nok)).status, 400);
  await post(app.server, `${path}/label`, { label: "needs_fix", revision: 0 }, nok);
  const summary = await get(app.server, "/console/api/owner-review/summary?peek=1", nok);
  assert.deepEqual(summary.json.daily.taper.perCode7d, { wrong_price: { agree: 1, disagree: 0 } });
  assert.equal(summary.json.daily.taper.labels7d, 1);
  assert.equal(summary.json.daily.taper.agreement7d, 1);
});

test("ดีที่เหลือทั้งหมด: ต้องตรวจห้องน่าห่วงครบก่อน · ไม่รวมห้องที่ถูกสุ่มวัดผล · ย้อนได้ 10 วิ", async (t) => {
  const { app, db } = await start(t);
  const { batch, items } = seedDaily(db);
  const nok = await login(app.server, "nok");
  const path = `/console/api/owner-review/daily/batches/${batch.id}/good-rest`;
  const early = await post(app.server, path, {}, nok);
  assert.equal(early.status, 409);
  assert.equal(early.json.code, "flagged_remaining");
  await post(app.server, `/console/api/owner-review/daily/items/${items[PRICE].id}/label`, { label: "needs_fix", revision: 0 }, nok);
  const bulk = await post(app.server, path, {}, nok);
  assert.equal(bulk.status, 200, bulk.text);
  assert.equal(bulk.json.labelled, 2);
  assert.equal(bulk.json.progress.remaining, 1, "ห้องสุ่มวัดผลยังรอตรวจทีละห้อง");
  assert.equal(db.ownerReviewItem(items[SAMPLED].id).label, null);
  assert.equal(db.ownerReviewItem(items[GOOD1].id).label_via, "bulk");
  assert.equal((await post(app.server, path, {}, nok)).json.code, "nothing_left");
  const chom = await login(app.server, "chom");
  assert.equal((await post(app.server, `${path}/undo`, { bulkId: bulk.json.bulkId }, chom)).status, 409, "ย้อนได้เฉพาะคนกด");
  const undone = await post(app.server, `${path}/undo`, { bulkId: bulk.json.bulkId }, nok);
  assert.equal(undone.json.reverted, 2);
  assert.equal(undone.json.progress.remaining, 3);
});

test("ดีที่เหลือทั้งหมด: ห้องที่ AI ยังไม่ได้อ่าน (failed/skipped) ไม่รวม — ต้องมีคนอ่านทีละห้อง ไม่ใช่ป้ายดีแล้วที่ไม่มีใครอ่าน", async (t) => {
  const { app, db } = await start(t);
  const { batch, items } = seedDaily(db);
  db.raw.prepare("UPDATE owner_review_items SET ai_status = 'failed', risk = NULL, ai_summary = '' WHERE id = ?").run(items[GOOD2].id);
  const nok = await login(app.server, "nok");
  await post(app.server, `/console/api/owner-review/daily/items/${items[PRICE].id}/label`, { label: "needs_fix", revision: 0 }, nok);
  const queue = await get(app.server, "/console/api/owner-review/daily", nok);
  const unread = queue.json.items.find((item) => item.customerId === GOOD2);
  assert.equal(unread.riskLabel, "AI ยังไม่ได้อ่าน");
  assert.equal(unread.bulkEligible, false);
  assert.deepEqual(queue.json.bulkGood, { eligible: 1, allowed: true, flaggedRemaining: 0 });
  const bulk = await post(app.server, `/console/api/owner-review/daily/batches/${batch.id}/good-rest`, {}, nok);
  assert.equal(bulk.json.labelled, 1, "เฉพาะห้องปกติที่ AI อ่านแล้ว");
  assert.equal(db.ownerReviewItem(items[GOOD2].id).label, null, "ห้องที่ AI ไม่ได้อ่านยังรอคนตรวจ");
  assert.equal(bulk.json.progress.remaining, 2, "ห้องสุ่มวัดผล + ห้องที่ AI ไม่ได้อ่าน");
});

test("ปักระดับการตรวจ: owner เท่านั้น · ปัก 1 = summary แสดงระดับ 1 · null = กลับอัตโนมัติ", async (t) => {
  const { app, db } = await start(t);
  seedDaily(db);
  const chom = await login(app.server, "chom");
  assert.equal((await post(app.server, "/console/api/owner-review/daily/taper", { pin: 1 }, chom)).status, 403);
  const nok = await login(app.server, "nok");
  assert.equal((await post(app.server, "/console/api/owner-review/daily/taper", { pin: 5 }, nok)).status, 400);
  const pinned = await post(app.server, "/console/api/owner-review/daily/taper", { pin: 1 }, nok);
  assert.equal(pinned.status, 200);
  assert.deepEqual([pinned.json.taper.level, pinned.json.taper.pinned], [1, true]);
  assert.equal(JSON.parse(db.getSetting("owner_review_taper_policy")).pin, 1);
  const auto = await post(app.server, "/console/api/owner-review/daily/taper", { pin: null }, nok);
  assert.deepEqual([auto.json.taper.level, auto.json.taper.pinned], [0, false]);
});

test("/push/pending: owner ได้ 'คิวตรวจแชทวันนี้พร้อม N ห้อง (น่าห่วง M)' นับอย่างเดียว · ทีมไม่มี · เปิดห้องตรวจแล้วหาย · staff เห็นเฉพาะสาขาที่ได้รับมอบ", async (t) => {
  const { app, db } = await start(t);
  const { batch, items } = seedDaily(db);
  db.queueWebPushEvent({ id: "ev-daily", operatorUsername: "nok", customerId: "", channelId: "default", reason: "owner_review_daily",
    dedupeKey: "daily-1", expiresAt: Date.now() + 3_600_000 });
  const nok = await login(app.server, "nok");
  const pending = await get(app.server, "/console/api/push/pending", nok);
  const item = pending.json.events.find((event) => event.tag === "lukprae-owner-review-daily");
  assert.ok(item, JSON.stringify(pending.json));
  assert.equal(item.body, "คิวตรวจแชทวันนี้พร้อม 4 ห้อง (น่าห่วง 1)");
  assert.doesNotMatch(JSON.stringify(pending.json), /สมชาย|สมหญิง|0812345678|ราคาคลาส/u);
  const chom = await login(app.server, "chom");
  assert.equal((await get(app.server, "/console/api/push/pending", chom)).json.events.some((event) => event.tag === "lukprae-owner-review-daily"), false);
  await get(app.server, "/console/api/owner-review/summary", nok);
  assert.equal((await get(app.server, "/console/api/push/pending", nok)).json.events.some((event) => event.tag === "lukprae-owner-review-daily"), false);
  // สาขา: ห้องนอกสาขาที่ผู้ดูเห็นได้ = ไม่มีในคิว/ตัวเลข
  db.raw.prepare("UPDATE customers SET channel_id = 'facebook' WHERE line_user_id = ?").run(GOOD2);
  assert.equal(db.ownerReviewItemScoped(items[GOOD2].id, ["default"]), null);
  assert.equal(db.ownerReviewBatchItemCounts(batch.id, { channels: ["default"] }).included, 3);
  assert.equal(db.listOwnerReviewQueue(batch.id, { channels: ["facebook"] }).length, 1);
  assert.equal(db.listOwnerReviewQueue(batch.id, { channels: [] }).length, 0);
});

test("ต่อสายจริง (createApp): 20:05 ตัวเดินรอบใน chassis → Luna ผ่าน hermes bridge คีย์แคช -daily ห้องละครั้ง → คิวพร้อมให้ API อ่าน", async (t) => {
  const bkk = (hour, minute = 0, day = 12) => Date.UTC(2026, 9, day, hour - 7, minute);
  const clock = { t: bkk(10, 0) };
  const db = memoryDb({ now: () => clock.t });
  db.createOperator({ username: "nok", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.upsertCustomer(PRICE, { displayName: "สมชาย ใจดีมาก" });
  db.insertMessage({ customerId: PRICE, direction: "in", content: "ราคาคลาสเท่าไหร่ครับ" });
  clock.t = bkk(10, 1);
  const out = String(db.insertMessage({ customerId: PRICE, direction: "out", content: "คลาสละ 990 บาทค่ะ", agentMode: "ai" }));
  const scan = db.claimOwnerReviewBatch({ kind: "scan", slotMs: bkk(19), windowStartMs: bkk(15), windowEndMs: bkk(19) });
  db.updateOwnerReviewBatch(scan.id, { status: "ready" });
  clock.t = bkk(20, 5);
  const keys = [];
  const hermesFetch = async (_url, opts = {}) => {
    const body = JSON.parse(opts.body);
    keys.push(body.prompt_cache_key);
    const content = JSON.stringify({ risk: 77, summary: "ตอบราคาไม่ครบ", issues: [{ code: "no_value_before_price", ref: "m2", note: "ไม่บอกว่าได้อะไร" }], offtopic: { category: null } });
    return { ok: true, status: 200, headers: { get: () => "" },
      json: async () => ({ choices: [{ message: { content } }], usage: { prompt_tokens: 1500, completion_tokens: 120 } }) };
  };
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: "owner-review-daily-wiring-secret-0123" }), db, logger: silent,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {}, now: () => clock.t } });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const run = await app.ownerReviewScheduler.runDue();
  assert.equal(run.kind, "daily", JSON.stringify(run));
  assert.equal(run.status, "ready");
  assert.deepEqual(keys, ["lukprae-hermes-owner-review-daily"]);
  const [item] = db.ownerReviewItemsForBatch(db.latestOwnerReviewBatch("daily").id);
  assert.deepEqual(JSON.parse(item.issues_json), [{ code: "no_value_before_price", messageId: out, note: "ไม่บอกว่าได้อะไร" }]);
  assert.equal(db.llmUsageSummary(bkk(0)).find((row) => row.kind === "owner_review")?.tokens_in > 0, true, "ต้นทุนนับเข้าเพดานรวม owner_review");
  const health = await httpRequest(app.server, { path: "/health" });
  assert.equal(health.json.ownerReview.daily.lastBatch.counts.included, 1);
  assert.doesNotMatch(JSON.stringify(health.json.ownerReview), /สมชาย|U[a1]{8}|990/u);
});

/* ------------------------------- รีวิว 13 ต.ค. ------------------------------- */

test("รีวิว 13 ต.ค.: 'ควรตอบว่า…' ที่ว่าง/สั้นจนไม่ใช่คำสอน ('.', 'ok', ช่องว่าง, อีโมจิล้วน) ไม่กลายเป็นบทเรียน — ทั้งพี่ง้วงและชมพู่ · มีชิป = จำแค่ชิป", async (t) => {
  const { app, db } = await start(t);
  const { items, ids } = seedDaily(db);
  const path = `/console/api/owner-review/daily/items/${items[PRICE].id}/fix`;
  const lessons = () => Number(db.raw.prepare("SELECT COUNT(*) AS n FROM owner_lessons").get().n);
  for (const username of ["nok", "chom"]) {
    const auth = await login(app.server, username);
    for (const junk of [".", "ok", "   ", "😀😀😀😀😀😀😀", "โอเค", "ได้ค่ะ"]) {
      const res = await post(app.server, path, { messageId: ids.priceOut, reasonChips: [], betterReply: junk, revision: 0 }, auth);
      assert.equal(res.status, 400, `${username} ${JSON.stringify(junk)}`);
      assert.equal(res.json.code, "fix_empty");
      if (junk.trim()) assert.match(res.json.error, /สั้นไป/u);
    }
  }
  assert.equal(lessons(), 0, "ไม่มีบทเรียนจากคำตอบขยะ");
  assert.equal(db.ownerReviewItem(items[PRICE].id).label, null, "และไม่ติดป้าย");
  const nok = await login(app.server, "nok");
  const chipOnly = await post(app.server, path, { messageId: ids.priceOut, reasonChips: ["tell_price"], betterReply: "ok", revision: 0 }, nok);
  assert.equal(chipOnly.status, 200, chipOnly.text);
  assert.equal(chipOnly.json.replyDropped, true);
  const lesson = db.getOwnerLesson(chipOnly.json.lesson.id);
  assert.equal(lesson.teaching, "ลูกค้าถามราคาตรง ๆ ให้ตอบราคาได้เลย พร้อมบอกว่าได้อะไรและคุ้มยังไง", "จำแค่ชิป ไม่มี 'ควรตอบประมาณว่า: ok'");
  assert.equal(chipOnly.json.item.labelNote, "ควรบอกราคา");
});

test("รีวิว 13 ต.ค.: ข้อความอัตโนมัติ/คำลาหลังปิด แตะแก้ไม่ได้ (ทั้งหน้าเว็บและด่าน fix) · รูปจากคลังที่ลูกแพรส่งมีชื่อ+ลิงก์ · รูปลูกค้า/รูปที่อัปโหลดไม่มี", async (t) => {
  const { app, db } = await start(t);
  const { items, ids } = seedDaily(db);
  const at = Date.now() - 3 * 3_600_000;
  const step = msg(db, PRICE, "out", "ข้อความต้อนรับที่ตั้งไว้", at + 180_000, { messageClass: "proactive", agentMode: "step_message" });
  const bye = msg(db, PRICE, "out", "ขอบคุณที่ทักมานะคะ", at + 240_000, { messageClass: "proactive", metadata: { ownerClose: { proposalId: "p1" } } });
  const poster = msg(db, PRICE, "out", "[image:poster-ai-agent] https://cdn.example.test/poster.jpg", at + 300_000, { msgType: "image" });
  const upload = msg(db, PRICE, "out", "[image:upload_abc] https://cdn.example.test/u.jpg", at + 360_000, { msgType: "image" });
  const slip = msg(db, PRICE, "in", "https://line.example.test/slip.jpg", at + 420_000, { msgType: "image" });
  const nok = await login(app.server, "nok");
  const detail = await get(app.server, `/console/api/owner-review/daily/items/${items[PRICE].id}`, nok);
  const byId = new Map(detail.json.bubbles.map((bubble) => [bubble.id, bubble]));
  assert.deepEqual([byId.get(step).fixable, byId.get(step).automated], [false, true]);
  assert.deepEqual([byId.get(bye).fixable, byId.get(bye).automated], [false, true]);
  assert.deepEqual([byId.get(ids.priceOut).fixable, byId.get(ids.priceOut).automated], [true, false]);
  assert.deepEqual(byId.get(poster).image, { key: "poster-ai-agent", url: "https://cdn.example.test/poster.jpg" });
  assert.equal(byId.get(poster).text, "[ส่งรูป: poster-ai-agent]");
  assert.equal(byId.get(upload).image, undefined, "รูปอัปโหลด (upload_) ไม่โชว์");
  assert.equal(byId.get(slip).image, undefined, "รูปของลูกค้าเป็นป้ายเหมือนเดิม");
  assert.equal(byId.get(slip).text, "[ส่งรูป]");
  assert.doesNotMatch(JSON.stringify(detail.json), /slip\.jpg/u);
  const path = `/console/api/owner-review/daily/items/${items[PRICE].id}/fix`;
  for (const messageId of [step, bye]) {
    const res = await post(app.server, path, { messageId, reasonChips: ["curt"], revision: 0 }, nok);
    assert.equal(res.json.code, "not_fixable", "ข้อความที่เจ้าของเขียนไว้เองต้องไม่กลายเป็นบทเรียนให้ลูกแพรเลิกพูด");
  }
  assert.equal((await post(app.server, path, { messageId: poster, reasonChips: ["no_media"], revision: 0 }, nok)).status, 200, "รูปที่ลูกแพรเลือกส่งสอนได้");
});

test("รีวิว 13 ต.ค.: ดีที่เหลือทั้งหมด ไม่รวมห้องที่ AI ชี้จุด (แม้จุดเล็ก) และการ์ดที่เปิดอยู่ (exceptId)", async (t) => {
  const { app, db } = await start(t);
  const { batch, items, ids } = seedDaily(db);
  db.raw.prepare("UPDATE owner_review_items SET issues_json = ? WHERE id = ?")
    .run(JSON.stringify([{ code: "curt_or_robotic", messageId: ids[GOOD2], note: "ห้วน" }]), items[GOOD2].id);
  const nok = await login(app.server, "nok");
  await post(app.server, `/console/api/owner-review/daily/items/${items[PRICE].id}/label`, { label: "needs_fix", revision: 0 }, nok);
  const queue = await get(app.server, "/console/api/owner-review/daily", nok);
  assert.equal(queue.json.items.find((item) => item.customerId === GOOD2).bulkEligible, false);
  assert.deepEqual(queue.json.bulkGood, { eligible: 1, allowed: true, flaggedRemaining: 0 });
  const path = `/console/api/owner-review/daily/batches/${batch.id}/good-rest`;
  assert.equal((await post(app.server, path, { exceptId: "../bad id" }, nok)).status, 400);
  const onScreen = await post(app.server, path, { exceptId: items[GOOD1].id }, nok);
  assert.equal(onScreen.status, 409, "ห้องเดียวที่เหลือคือการ์ดบนจอ = ไม่มีอะไรให้ติดป้าย");
  assert.equal(onScreen.json.code, "nothing_left");
  assert.equal(db.ownerReviewItem(items[GOOD1].id).label, null);
  const bulk = await post(app.server, path, { exceptId: items[GOOD2].id }, nok);
  assert.equal(bulk.json.labelled, 1);
  assert.equal(db.ownerReviewItem(items[GOOD1].id).label_via, "bulk");
  assert.equal(db.ownerReviewItem(items[GOOD2].id).label, null, "ห้องที่ AI ว่าห้วนยังรอคนดู");
});

test("รีวิว 13 ต.ค.: 'กำลังดูห้องนี้' — พี่ง้วงเปิดห้อง = คิวของชมพู่บอกชื่อ · ชมพู่ขอห้องเดียวกัน = ได้ชื่อคนที่ดูอยู่ · ติดป้ายแล้วปล่อย", async (t) => {
  const { app, db } = await start(t);
  const { items } = seedDaily(db);
  const nok = await login(app.server, "nok");
  const chom = await login(app.server, "chom");
  const claimPath = (id) => `/console/api/owner-review/daily/items/${id}/claim`;
  assert.equal((await post(app.server, claimPath(items[PRICE].id), {}, nok, { csrf: false })).status, 403, "ต้องมี CSRF");
  const mine = await post(app.server, claimPath(items[PRICE].id), {}, nok);
  assert.deepEqual([mine.status, mine.json.claimed, mine.json.viewingBy], [200, true, null]);
  const chomQueue = await get(app.server, "/console/api/owner-review/daily", chom);
  assert.equal(chomQueue.json.items.find((item) => item.customerId === PRICE).viewingBy, "พี่ง้วง");
  assert.equal(chomQueue.json.items.find((item) => item.customerId === GOOD1).viewingBy, null);
  const nokQueue = await get(app.server, "/console/api/owner-review/daily", nok);
  assert.equal(nokQueue.json.items.find((item) => item.customerId === PRICE).viewingBy, null, "ห้องที่ตัวเองดูอยู่ไม่นับ");
  const clash = await post(app.server, claimPath(items[PRICE].id), {}, chom);
  assert.deepEqual([clash.json.claimed, clash.json.viewingBy], [false, "พี่ง้วง"]);
  // พี่ง้วงไปห้องถัดไป = ปล่อยห้องเดิม (ถือได้ทีละห้อง)
  await post(app.server, claimPath(items[GOOD1].id), {}, nok);
  assert.equal((await post(app.server, claimPath(items[PRICE].id), {}, chom)).json.claimed, true);
  const labelled = await post(app.server, `/console/api/owner-review/daily/items/${items[PRICE].id}/label`, { label: "good", revision: 0 }, chom);
  assert.equal(labelled.status, 200);
  const after = await get(app.server, "/console/api/owner-review/daily", nok);
  assert.equal(after.json.items.find((item) => item.customerId === PRICE).viewingBy, null, "ติดป้ายแล้ว = ไม่มีใครถือ");
  assert.doesNotMatch(JSON.stringify(after.json), /คลาสละ 990/u);
});

test("รีวิว 13 ต.ค.: 'กำลังดูห้องนี้' หมดอายุเอง 3 นาที (ปิดแอปแล้วห้องคืนคิว) · ห้องที่ติดป้ายแล้วขอไม่ได้", async () => {
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chom", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  const { items } = seedDaily(db);
  let clock = Date.now();
  const routes = createOwnerReviewDailyRoutes({ db, logger: silent, now: () => clock });
  async function call(username, method, route, path = "/console/api/owner-review/daily") {
    let out = null;
    const operator = { username, role: username === "nok" ? "owner" : "operator" };
    await routes.handle({ method }, {}, new URL(`http://x${path}`), route, {
      json: (_res, status, body) => { out = { status, body }; }, readJson: async () => ({}), username, operator,
      requireCsrf: () => true, scope: null,
    });
    return out;
  }
  const claim = (username, id) => call(username, "POST", ["owner-review", "daily", "items", id, "claim"]);
  const viewing = async (username, customerId) => (await call(username, "GET", ["owner-review", "daily"])).body.items
    .find((item) => item.customerId === customerId).viewingBy;
  assert.equal((await claim("nok", items[PRICE].id)).body.claimed, true);
  clock += OWNER_REVIEW_CLAIM_MS - 1_000;
  assert.equal(await viewing("chom", PRICE), "พี่ง้วง");
  clock += 2_000;
  assert.equal(await viewing("chom", PRICE), null, "เลย 3 นาที = ห้องว่าง");
  assert.equal((await claim("chom", items[PRICE].id)).body.claimed, true);
  db.casOwnerReviewItemLabel(items[GOOD1].id, { expectedRevision: 0, label: "good", via: "single", by: "nok", at: clock });
  assert.deepEqual((await claim("nok", items[GOOD1].id)).body, { ok: true, claimed: false, viewingBy: null });
  db.close();
});
