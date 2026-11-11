// console-overview-attention — "เงินรั่วตรงไหนตอนนี้" บนหน้าภาพรวม (28 ก.ย. 2026)
//   waiting  = ลูกค้าพูดคนสุดท้ายแล้วยังไม่มีใครตอบ (30 วันล่าสุด)
//   hotQuiet = คะแนน 8+ ลูกแพรตอบแล้วเกิน 1 วัน ลูกค้าเงียบ และหลังข้อความล่าสุดของลูกค้ายังไม่มีคนจริงทัก (ค้างจนกว่าคนจะทัก)
// + activeCustomersToday ("วันนี้คุยกับลูกค้า N คน" ต้องนับคน ไม่ใช่ข้อความ)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  ATTENTION_LIST_MAX, attentionPreview, attentionValue, summarizeHotQuiet, summarizeWaiting,
} from "../src/consoleAttentionApi.mjs";
import { httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const PASSWORD = "attention-pass-123";
const silent = { log() {}, warn() {}, error() {} };

// นาฬิกาเลื่อนได้: เขียนประวัติด้วยเวลาในอดีตจริง แล้วให้เส้น API อ่านด้วยเวลาปัจจุบัน
function clockDb() {
  let fixed = null;
  const db = memoryDb({ now: () => fixed ?? Date.now() });
  const at = (ms, fn) => { fixed = ms; try { return fn(); } finally { fixed = null; } };
  return { db, at };
}

function seed(db, at) {
  const now = Date.now();
  const room = (id, { score = null, name = id, createdAgo = 20 * DAY, channelId = "default" } = {}) => {
    at(now - createdAgo, () => db.upsertCustomer(id, { displayName: name, channelId }));
    if (score != null) at(now - createdAgo + MIN, () => db.recordScore(id, score, "{}"));
  };
  const msg = (id, direction, ago, content, extra = {}) => at(now - ago, () => db.insertMessage({
    customerId: id, direction, content, ...extra,
  }));
  // ---- waiting ----
  room("W-money", { score: 6, name: "ลูกค้าโอนแล้ว" });
  msg("W-money", "in", 1 * DAY, "โอนมัดจำแล้วนะคะ");
  db.markMoneySeen("W-money");
  room("W-hot", { score: 9, name: "ลูกค้าคอนซัล" });
  msg("W-hot", "in", 11 * DAY, "สนใจคอนซัลแบบรายเดือนค่ะ รบกวนติดต่อกลับด้วยนะคะ ขอเป็นช่วงบ่ายได้ไหมคะ");
  room("W-plain", { name: "ลูกค้าทั่วไป" });
  msg("W-plain", "in", 2 * DAY, "ขอรายละเอียดหน่อยครับ");
  room("W-proactive", { name: "ได้แต่ข้อความทวง" });
  msg("W-proactive", "in", 3 * DAY, "ยังไม่ได้คำตอบเลยค่ะ");
  msg("W-proactive", "out", 2 * DAY, "follow-up อัตโนมัติ", { messageClass: "proactive", agentMode: "ai" });
  room("X-fresh", { name: "เพิ่งทัก" });
  msg("X-fresh", "in", 1 * MIN, "สวัสดีค่ะ");
  room("X-answered", { score: 9, name: "ตอบแล้ว" });
  msg("X-answered", "in", 2 * DAY, "มีรอบไหนบ้างคะ");
  msg("X-answered", "out", 2 * DAY - 30_000, "มีรอบปลายเดือนค่ะ", { agentMode: "ai" });
  room("X-hashtag", { name: "แฮชแท็ก" });
  msg("X-hashtag", "in", 1 * DAY, "#สนใจคลาส");
  room("canary:probe", { name: "canary" });
  msg("canary:probe", "in", 1 * DAY, "[canary] ping");
  room("X-old", { name: "เงียบนานเกินหน้าต่าง", createdAgo: 60 * DAY });
  msg("X-old", "in", 40 * DAY, "ยังมีคลาสไหมคะ");
  room("X-resolved", { name: "ปิดเคสแล้ว" });
  msg("X-resolved", "in", 2 * DAY, "ขอบคุณค่ะ");
  db.setConversationResolved("X-resolved", true);
  // ---- hot quiet ----
  room("H-quiet", { score: 9, name: "ร้อนแต่เงียบ" });
  msg("H-quiet", "in", 3 * DAY + HOUR, "สนใจคลาสค่ะ");
  msg("H-quiet", "out", 3 * DAY, "มีรอบปลายเดือนค่ะ", { agentMode: "ai" });
  room("X-human", { score: 8, name: "คนเคยทักแล้ว" });
  msg("X-human", "in", 3 * DAY + HOUR, "สนใจค่ะ");
  msg("X-human", "out", 3 * DAY, "ชมพู่ส่งรายละเอียดให้นะคะ", { operator: "chompoo", agentMode: "operator_ai_on" });
  room("X-too-quiet", { score: 9, name: "เงียบเกินเจ็ดวัน" });
  msg("X-too-quiet", "in", 9 * DAY + HOUR, "สนใจค่ะ");
  msg("X-too-quiet", "out", 9 * DAY, "ยินดีค่ะ", { agentMode: "ai" });
  room("X-too-fresh", { score: 9, name: "เพิ่งคุย" });
  // 3 พ.ย. 2026 ไม้ต่อ: ลูกแพรเพิ่งจบไม่ถึง 2 ชม. (นาฬิกาจริง ≥ เวลาทำการเสมอ — ไม่ขึ้นกับวัน/เวลาที่รันเทสต์)
  msg("X-too-fresh", "in", 1 * HOUR + MIN, "สนใจค่ะ");
  msg("X-too-fresh", "out", 1 * HOUR, "ยินดีค่ะ", { agentMode: "ai" });
  room("X-paid", { score: 9, name: "จ่ายแล้ว" });
  msg("X-paid", "in", 3 * DAY + HOUR, "จ่ายแล้วค่ะ");
  msg("X-paid", "out", 3 * DAY, "ขอบคุณค่ะ", { agentMode: "ai" });
  db.setDealStatus("X-paid", "paid");
  room("X-tagged", { score: 9, name: "ลูกค้าเก่า" });
  msg("X-tagged", "in", 3 * DAY + HOUR, "สวัสดีค่ะ");
  msg("X-tagged", "out", 3 * DAY, "สวัสดีค่ะ", { agentMode: "ai" });
  assert.equal(db.addTag("X-tagged", "customer", "human"), true);
  // ---- 29 ก.ย. 2026: ค้างจนกว่าคนจริงจะทัก ----
  // เคยคุยกับทีมแล้ว แต่ลูกค้ากลับมาพูดใหม่ ลูกแพรตอบรอบล่าสุด แล้วเงียบ = จบที่ AI อีกรอบ → ขึ้น
  room("X-human-earlier", { score: 8, name: "เคยคุยกับทีม" });
  msg("X-human-earlier", "in", 6 * DAY, "สนใจค่ะ");
  msg("X-human-earlier", "out", 6 * DAY - HOUR, "ชมพู่ส่งรายละเอียดให้นะคะ", { operator: "chompoo", agentMode: "operator_ai_on" });
  msg("X-human-earlier", "in", 2 * DAY + HOUR, "ขอคิดก่อนนะคะ");
  msg("X-human-earlier", "out", 2 * DAY, "ได้เลยค่ะ", { agentMode: "ai" });
  // Facebook ที่ลูกค้าเงียบเกิน 7 วัน ตอบไม่ได้แล้วแม้ใน Business Suite → ไม่ขึ้น
  room("X-fb-gone", { score: 9, name: "เฟซบุ๊กหลุดเวลา", channelId: "facebook" });
  msg("X-fb-gone", "in", 8 * DAY, "สนใจค่ะ");
  msg("X-fb-gone", "out", 8 * DAY - MIN, "ยินดีค่ะ", { agentMode: "ai" });
  // คนกด YOLO หลังลูกค้าพูดล่าสุด = ทีมทักแล้ว → หาย
  room("X-yolo", { score: 9, name: "กด YOLO แล้ว" });
  msg("X-yolo", "in", 3 * DAY, "สนใจค่ะ");
  msg("X-yolo", "out", 3 * DAY - MIN, "ยินดีค่ะ", { agentMode: "ai" });
  msg("X-yolo", "out", 1 * DAY, "ทักต่อจาก YOLO", { messageClass: "proactive", agentMode: "ai", metadata: { yolo: true } });
  // บรอดแคสต์ที่คนกดส่ง ไม่ใช่การทักรายคน → ยังค้าง
  room("X-broadcast", { score: 9, name: "ได้แค่บรอดแคสต์" });
  msg("X-broadcast", "in", 4 * DAY, "สนใจค่ะ");
  msg("X-broadcast", "out", 4 * DAY - MIN, "ยินดีค่ะ", { agentMode: "ai" });
  msg("X-broadcast", "out", 1 * DAY, "โปรโมชันเดือนนี้", { messageClass: "proactive", operator: "chompoo", agentMode: "operator_ai_on" });
  // ห้องประวัติจาก LINE OA เดิม ส่งไม่ถึงแล้ว → ไม่ขึ้น
  room("X-legacy", { score: 9, name: "ประวัติ OA เดิม" });
  msg("X-legacy", "in", 30 * DAY, "สนใจค่ะ");
  msg("X-legacy", "out", 30 * DAY - MIN, "ยินดีค่ะ", { agentMode: "ai" });
  assert.equal(db.addTag("X-legacy", "ย้ายจาก LINE OA", "human"), true);
  // 30 ก.ย. 2026 (พี่ง้วง: "อยากให้หายได้ทางเดียวคือต้องพิมพ์คุยจริง ๆ"): กดเสร็จสิ้นแล้วก็ยังค้าง
  room("X-closed", { score: 9, name: "กดเสร็จสิ้นแต่ยังไม่ได้คุย" });
  msg("X-closed", "in", 3 * DAY, "ขอบคุณค่ะ");
  msg("X-closed", "out", 3 * DAY - MIN, "ยินดีค่ะ", { agentMode: "ai" });
  at(now - 2 * DAY, () => db.setConversationResolved("X-closed", true));
  // รีวิวโค้ด 29 ก.ย.: ข้อความทวงอย่างเดียวไม่ใช่ "ลูกแพรตอบ" — ลูกค้าร้อนที่ยังไม่ได้คำตอบอยู่คิวรอตอบที่เดียว
  room("W-hot-fu", { score: 9, name: "ร้อนแต่ได้แค่ข้อความทวง" });
  msg("W-hot-fu", "in", 3 * DAY, "ขอราคาคลาสหน่อยค่ะ");
  msg("W-hot-fu", "out", 2 * DAY, "follow-up อัตโนมัติ", { messageClass: "proactive", agentMode: "ai" });
  // ลูกค้าส่ง "ขอบคุณ" ตามหลังคำตอบ = ไม่ใช่คำถามใหม่ ห้องยังค้างให้ทีมทักต่อ (ตัวอย่างบนแถว = คำถามเดิม)
  room("X-ack-after", { score: 9, name: "ขอบคุณแล้วเงียบ" });
  msg("X-ack-after", "in", 3 * DAY, "สนใจรอบเสาร์นี้ค่ะ");
  msg("X-ack-after", "out", 3 * DAY - MIN, "มีที่ว่างค่ะ", { agentMode: "ai" });
  msg("X-ack-after", "in", 1.5 * DAY, "ขอบคุณค่ะ");
}

async function start(t) {
  const { db, at } = clockDb();
  const passHash = hashPassword(PASSWORD);
  db.createOperator({ username: "owner", passHash, role: "owner" });
  db.createOperator({ username: "staff", passHash, role: "operator" });
  seed(db, at);
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "attention-secret-123" }), db,
    overrides: { lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server, username) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  return res.headers["set-cookie"][0].split(";")[0];
}

test("attention: ลูกค้ารอคนตอบ — นับเฉพาะคนที่พูดคนสุดท้ายจริง เรียงเรื่องเงิน > ร้อน > อื่น แล้วรอนานสุดก่อน", async (t) => {
  const { app } = await start(t);
  const cookie = await login(app.server, "owner");
  const res = await httpRequest(app.server, { path: "/console/api/overview/attention", headers: { cookie } });
  assert.equal(res.status, 200);
  const ids = res.json.waiting.rooms.map((room) => room.id);
  assert.deepEqual(ids, ["W-money", "W-hot", "W-hot-fu", "W-proactive", "W-plain"],
    "เงินก่อน → ร้อน → ที่เหลือเรียงรอนานสุด · ข้อความทวงอัตโนมัติไม่นับว่าตอบ");
  assert.equal(res.json.waiting.total, 5);
  for (const excluded of ["X-fresh", "X-answered", "X-hashtag", "canary:probe", "X-old", "X-resolved"]) {
    assert.ok(!ids.includes(excluded), `${excluded} ต้องไม่อยู่ในรายการรอคนตอบ`);
  }
  assert.ok(res.json.waiting.oldestWaitMs >= 11 * DAY - MIN, "รอนานสุดต้องเป็น 11 วันของลูกค้าคอนซัล");
  const hot = res.json.waiting.rooms.find((room) => room.id === "W-hot");
  assert.equal(hot.value, "hot");
  assert.equal(hot.channelName, "LINE", "โหมด OA เดียวต้องขึ้นชื่อช่องทาง ไม่ใช่คำว่า default");
  assert.ok(Array.from(new Intl.Segmenter("th", { granularity: "grapheme" }).segment(hot.preview)).length <= 40);
  assert.ok(hot.preview.endsWith("…"), "ข้อความยาวต้องถูกตัดพร้อมจุดไข่ปลา");
});

test("attention: ไม้ต่อจากลูกแพร — ลูกแพรจบแล้วเกิน 2 ชม.ทำการ ค้างจนกว่าคนจริงจะทัก ไม่ซ้ำกับรายการรอคนตอบ", async (t) => {
  const { app } = await start(t);
  const cookie = await login(app.server, "staff");
  const res = await httpRequest(app.server, { path: "/console/api/overview/attention?limit=20", headers: { cookie } });
  assert.equal(res.status, 200, "ทีมงานใช้หน้าภาพรวมทุกวัน — ต้องอ่านได้");
  // X-answered: ลูกแพรตอบแล้ว (ไม่ใช่คนรอ) แต่ลูกค้าเงียบไป 2 วันโดยยังไม่มีคนจริงทัก = ถึงตาทีมต่อ
  // X-too-quiet (LINE เงียบ 9 วัน คะแนน 9) ยังค้างอยู่ — พี่ง้วง 29 ก.ย.: "อยากให้ขึ้นค้างไว้" จนกว่าคนจะไปคุย
  // 3 พ.ย. 2026 (พี่ง้วง "ทุกห้อง"): ห้องจ่ายแล้ว/ลูกค้าเก่าที่ลูกแพรคุยด้วยก็ต้องมีคนต่อ → X-paid, X-tagged ขึ้นด้วย
  // ทุกห้องในชุดนี้ลูกแพรจบมา ≥ 2 วัน = เกินเส้นตาย 6 ชม.ทำการแล้วทุกวันในสัปดาห์ (ไม่มีวันหยุดในเทสต์)
  // เรียงคะแนนมากก่อน แล้วลูกค้าที่พูดล่าสุดใหม่กว่าขึ้นก่อน (ยังสนใจอยู่) · เวลาเท่ากันเรียงตามรหัสห้อง
  assert.deepEqual(res.json.hotQuiet.rooms.map((room) => room.id),
    ["X-ack-after", "X-answered", "X-closed", "H-quiet", "X-paid", "X-tagged", "X-broadcast", "X-too-quiet", "X-human-earlier"]);
  assert.equal(res.json.hotQuiet.total, 9);
  assert.equal(res.json.hotQuiet.overdue, 9);
  assert.ok(res.json.hotQuiet.rooms.every((room) => room.relayStatus === "overdue" && room.workElapsedMs >= 6 * HOUR));
  assert.match(res.json.hotQuiet.rooms[0].preview, /สนใจรอบเสาร์นี้/u, "ตัวอย่างบนแถว = คำถามที่ลูกแพรตอบ ไม่ใช่คำขอบคุณ");
  for (const gone of ["W-hot", "W-hot-fu", "X-human", "X-too-fresh", "X-fb-gone", "X-yolo", "X-legacy"]) {
    assert.ok(!res.json.hotQuiet.rooms.some((room) => room.id === gone), `${gone} ต้องไม่อยู่ในรายการรอทีมทักต่อ`);
  }
  const room = res.json.hotQuiet.rooms[1]; // X-answered
  assert.ok(room.silentMs >= 2 * DAY - MIN && room.silentMs < 3 * DAY, "เงียบนับจากลูกค้าพูดล่าสุด");
  assert.equal(room.score, 9);
  assert.equal(room.teamTalkedBefore, false);
  const earlier = res.json.hotQuiet.rooms.find((item) => item.id === "X-human-earlier");
  assert.equal(earlier.teamTalkedBefore, true, "เคยคุยกับทีมแล้ว แต่รอบล่าสุดจบที่ลูกแพร");
  assert.ok(res.json.hotQuiet.teamRate && res.json.hotQuiet.teamRate.windowDays === 7, "มีตัวชี้วัดไม้ต่อ 7 วัน");
  assert.ok(res.json.hotQuiet.teamRate.relay.decided >= 1, "ไม้ที่เลยเส้นตายแล้วนับเป็นไม้ที่ตัดสินแล้ว");
  // ไม่มีตัวเลขเงินหลุดมากับรายการ (เงินระดับบริษัทเป็นของเจ้าของเท่านั้น)
  const text = JSON.stringify(res.json);
  assert.doesNotMatch(text, /thb|revenue|amount|profit|roas/iu);
});

test("หน้าแชท: คิว hotfollow = รายการ/ลำดับ/จำนวนชุดเดียวกับการ์ดหน้าภาพรวม + ลำดับทั้งคิวให้ปุ่มห้องถัดไป", async (t) => {
  const { app } = await start(t);
  const cookie = await login(app.server, "staff");
  const overview = await httpRequest(app.server, { path: "/console/api/overview/attention?limit=20", headers: { cookie } });
  const chip = await httpRequest(app.server, { path: "/console/api/inbox?segment=hotfollow", headers: { cookie } });
  assert.equal(chip.status, 200);
  const ids = chip.json.conversations.map((row) => row.line_user_id);
  assert.deepEqual(ids, overview.json.hotQuiet.rooms.map((room) => room.id), "ลำดับเดียวกันเป๊ะ");
  assert.deepEqual(chip.json.waitingOrder, ids, "ลำดับทั้งคิวสำหรับปุ่มห้องถัดไป/เปิดห้องถัดไปเอง");
  assert.equal(chip.json.counts.hotfollow, overview.json.hotQuiet.total);
  const first = chip.json.conversations[0];
  assert.equal(first.hot_follow.aiReplies >= 1, true);
  assert.ok(first.hot_follow.silentMs > 0);
  const all = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } });
  assert.equal(all.json.counts.hotfollow, 9, "ชิปนับได้จากทุกหน้า");
  assert.equal(all.json.waitingOrder, undefined, "ชิปอื่นไม่ต้องแบกลำดับคิว");
});

test("attention: ต้องล็อกอิน · channel ต้องอยู่ในรายการ · รายการที่ส่งกลับมีเพดาน", async (t) => {
  const { app } = await start(t);
  const anonymous = await httpRequest(app.server, { path: "/console/api/overview/attention" });
  assert.equal(anonymous.status, 401);
  const cookie = await login(app.server, "owner");
  const badChannel = await httpRequest(app.server, { path: "/console/api/overview/attention?channel=nope", headers: { cookie } });
  assert.equal(badChannel.status, 400);
  const bounded = await httpRequest(app.server, { path: "/console/api/overview/attention?limit=999", headers: { cookie } });
  assert.equal(bounded.status, 200);
  assert.ok(bounded.json.waiting.rooms.length <= ATTENTION_LIST_MAX);
  const one = await httpRequest(app.server, { path: "/console/api/overview/attention?limit=1", headers: { cookie } });
  assert.equal(one.json.waiting.rooms.length, 1);
  assert.equal(one.json.waiting.total, 5, "ตัวเลขรวมต้องนับทุกห้อง แม้ส่งรายชื่อกลับแค่ห้องเดียว");
});

test("attention: ตัดข้อความ/จัดมูลค่า/เรียงลำดับ เป็นฟังก์ชันบริสุทธิ์ที่ทดสอบได้ตรง ๆ", () => {
  assert.equal(attentionPreview("image", "[image] https://x"), "ส่งรูปภาพ");
  assert.equal(attentionPreview("text", "[image:abc]   สวัสดี   ค่ะ"), "สวัสดี ค่ะ");
  const long = "ก่".repeat(60);
  const preview = attentionPreview("text", long);
  assert.equal(Array.from(new Intl.Segmenter("th", { granularity: "grapheme" }).segment(preview)).length, 40,
    "ห้ามตัดกลางวรรณยุกต์ — นับเป็นตัวอักษรที่มองเห็น");
  assert.equal(attentionValue({ money_seen_at: 5, last_score: 2 }), "money");
  assert.equal(attentionValue({ ai_off_reason: "bank_sent" }), "money");
  assert.equal(attentionValue({ last_score: 8 }), "hot");
  assert.equal(attentionValue({ last_score: 6 }), "warm");
  assert.equal(attentionValue({ last_score: null }), "other");
  const now = 1_000 * DAY;
  const waiting = summarizeWaiting([
    { line_user_id: "a", last_score: 3, last_in_at: now - 9 * DAY },
    { line_user_id: "b", last_score: 9, last_in_at: now - 1 * DAY },
    { line_user_id: "c", last_score: 9, last_in_at: now - 4 * DAY },
  ], { now, limit: 2 });
  assert.deepEqual(waiting.rooms.map((room) => room.id), ["c", "b"]);
  assert.equal(waiting.total, 3);
  assert.equal(waiting.oldestWaitMs, 9 * DAY);
  const hot = summarizeHotQuiet([
    { line_user_id: "x", last_score: 8, last_at: now - 6 * DAY, last_in_at: now - 6 * DAY - HOUR },
    { line_user_id: "y", last_score: 9, last_at: now - 2 * DAY, last_in_at: now - 2 * DAY - HOUR },
  ], { now });
  assert.deepEqual(hot.rooms.map((room) => room.id), ["y", "x"], "คะแนนสูงก่อน");
});

test("overview: วันนี้คุยกับลูกค้ากี่ \"คน\" — พิมพ์กี่บรรทัดก็นับหนึ่ง ไม่นับ canary/เมื่อวาน", async (t) => {
  const { db, at } = clockDb();
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), role: "owner" });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: "attention-secret-123" }), db,
    overrides: { lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  db.upsertCustomer("U-a", {});
  db.upsertCustomer("U-b", {});
  db.upsertCustomer("U-old", {});
  db.upsertCustomer("canary:x", {});
  for (let i = 0; i < 5; i += 1) db.insertMessage({ customerId: "U-a", direction: "in", content: `ข้อความ ${i}` });
  db.insertMessage({ customerId: "U-b", direction: "in", content: "สวัสดีค่ะ" });
  db.insertMessage({ customerId: "U-b", direction: "out", content: "ยินดีค่ะ" });
  db.insertMessage({ customerId: "canary:x", direction: "in", content: "[canary] ping" });
  at(Date.now() - 2 * DAY, () => db.insertMessage({ customerId: "U-old", direction: "in", content: "เมื่อวานซืน" }));
  const cookie = await login(app.server, "owner");
  const res = await httpRequest(app.server, { path: "/console/api/overview", headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(res.json.stats.activeCustomersToday, 2);
  assert.equal(res.json.stats.inboundToday, 6);
});
