// inbox-volume.test.mjs — G4 console v2: volume-ready inbox + brain transparency
// ครอบคลุม: pagination inbox (limit/offset/hasMore), segment HOT/WARM/COLD/needs/aioff
// + counts + การเรียง, ค้นหา q (ชื่อ/ชื่อจริง/ข้อความล่าสุด + escape wildcard),
// unread lifecycle (เปิดห้อง = seen), pagination ข้อความ (keyset beforeAt/beforeRid),
// GET /console/api/brain (auth + เนื้อหาครบ + knowledge stats), CSP img-src https,
// static allowlist ไฟล์ใหม่ chat.mjs/context.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { KNOWLEDGE_MAX_CHARS } from "../src/knowledgePack.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen, promptText} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
const PASS_HASH = hashPassword(PASSWORD);

async function startConsole(t, { configOverrides = {}, overrides = {} } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET, ...configOverrides });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก" });
  const app = createApp({
    config, db,
    overrides: {
      hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {},
      ...overrides,
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });
  return { app, db, config };
}

function postJson(server, path, body, headers = {}) {
  return httpRequest(server, {
    method: "POST", path,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function login(server) {
  const res = await postJson(server, "/console/api/login", { username: "nok", password: PASSWORD });
  assert.equal(res.status, 200, `login ต้องผ่าน: ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}

// สร้างลูกค้า + ข้อความล่าสุด + score — updated_at ไล่ตาม i (คนหลังใหม่กว่า)
function seedCustomer(db, i, { score = null, state = null, aiOff = false, name = null } = {}) {
  const id = `U-vol-${String(i).padStart(3, "0")}`;
  db.upsertCustomer(id, { displayName: name || `ลูกค้า${i}` });
  db.insertMessage({ customerId: id, direction: "in", content: `สวัสดี ${i}` });
  if (score != null) db.recordScore(id, score, "{}");
  if (state) db.raw.prepare("UPDATE customers SET state = ? WHERE line_user_id = ?").run(state, id);
  if (aiOff) db.setAiEnabled(id, false);
  return id;
}

/* ------------------------------- pagination ------------------------------- */

test("inbox: default 30 แถว + hasMore + offset ไล่หน้าจนครบไม่ซ้ำ", async (t) => {
  const { app, db } = await startConsole(t);
  for (let i = 0; i < 37; i += 1) seedCustomer(db, i);
  const { cookie } = await login(app.server);

  const p1 = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } });
  assert.equal(p1.status, 200);
  assert.equal(p1.json.conversations.length, 30, "default หน้าละ 30");
  assert.equal(p1.json.hasMore, true);
  assert.equal(p1.json.counts.all, 37);

  const p2 = await httpRequest(app.server, { path: "/console/api/inbox?offset=30", headers: { cookie } });
  assert.equal(p2.json.conversations.length, 7);
  assert.equal(p2.json.hasMore, false);

  const ids = new Set([...p1.json.conversations, ...p2.json.conversations].map((c) => c.line_user_id));
  assert.equal(ids.size, 37, "สองหน้ารวมกันครบไม่ซ้ำ");
  // หน้าแรกต้องเรียงใหม่สุดก่อน (updated_at ล่าสุดอยู่บน)
  assert.equal(p1.json.conversations[0].line_user_id, "U-vol-036");
});

test("inbox: limit เกิน 100 ถูก clamp และ limit ตั้งเองได้", async (t) => {
  const { app, db } = await startConsole(t);
  for (let i = 0; i < 12; i += 1) seedCustomer(db, i);
  const { cookie } = await login(app.server);
  const res = await httpRequest(app.server, { path: "/console/api/inbox?limit=5", headers: { cookie } });
  assert.equal(res.json.conversations.length, 5);
  assert.equal(res.json.hasMore, true);
  const big = await httpRequest(app.server, { path: "/console/api/inbox?limit=9999", headers: { cookie } });
  assert.equal(big.status, 200); // clamp เงียบ ๆ ไม่ error
});

/* -------------------------------- segments -------------------------------- */

test("inbox: segment hot/warm/cold/needs/aioff กรองถูก + counts นับทั้งร้าน", async (t) => {
  const { app, db } = await startConsole(t);
  seedCustomer(db, 1, { score: 9 });                       // hot
  seedCustomer(db, 2, { score: 8 });                       // hot
  seedCustomer(db, 3, { score: 6 });                       // warm
  seedCustomer(db, 4, { score: 2 });                       // cold (score ต่ำ)
  seedCustomer(db, 5);                                     // cold (ไม่มี score)
  seedCustomer(db, 6, { score: 10, state: "NEEDS_HUMAN" }); // hot + needs
  seedCustomer(db, 7, { aiOff: true });                    // cold + aioff
  const { cookie } = await login(app.server);

  const get = async (seg) =>
    (await httpRequest(app.server, { path: `/console/api/inbox?segment=${seg}`, headers: { cookie } })).json;

  const hot = await get("hot");
  assert.deepEqual(
    hot.conversations.map((c) => c.line_user_id).sort(),
    ["U-vol-001", "U-vol-002", "U-vol-006"].sort(),
  );
  // hot เรียง score มาก -> น้อย
  assert.equal(hot.conversations[0].last_score, 10);

  const warm = await get("warm");
  assert.deepEqual(warm.conversations.map((c) => c.line_user_id), ["U-vol-003"]);

  const cold = await get("cold");
  assert.deepEqual(
    cold.conversations.map((c) => c.line_user_id).sort(),
    ["U-vol-004", "U-vol-005", "U-vol-007"].sort(),
  );

  const needs = await get("needs");
  assert.deepEqual(needs.conversations.map((c) => c.line_user_id), ["U-vol-006"]);

  const aioff = await get("aioff");
  assert.deepEqual(aioff.conversations.map((c) => c.line_user_id), ["U-vol-007"]);

  // counts เท่ากันทุก segment (นับทั้งร้าน ไม่ใช่นับเฉพาะหน้า)
  // v1.4.33: เพิ่ม customer (ห้องที่ติดป้าย "customer" = ลูกค้าที่ซื้อแล้ว ทีมงานดูแลเอง)
  // 28 ก.ย. 2026: เพิ่ม spam (ป้าย null) + waiting/waiting24 (คิวรอตอบชุดเดียวกับหน้าภาพรวม)
  // ห้อง seed เพิ่งทักไม่ถึง 3 นาที (ช่วงผ่อนผันให้ลูกแพรตอบ) = ยังไม่นับว่ารอตอบ
  assert.deepEqual(hot.counts, {
    all: 7, hot: 3, warm: 1, cold: 3, needs: 1, aioff: 1, notqualify: 0, resolved: 0, mine: 0, customer: 0,
    spam: 0, waiting: 0, waiting24: 0, hotfollow: 0,
  });
});

// 5 ต.ค. 2026 (พี่ง้วง): ชิป "ไม่เข้าเกณฑ์" = เฉพาะห้องสีเหลืองที่ตัวกวาดคัดกรองปิดเอง
// ห้อง AI ปิดเหตุอื่น (คนปิด/เส้นเงิน) ต้องไม่ปน และห้องสีเหลืองยังนับใน "AI ปิด" ตามเดิม
test("inbox: segment notqualify = เฉพาะห้อง ai_off_reason not_qualified + count notqualify", async (t) => {
  const { app, db } = await startConsole(t);
  seedCustomer(db, 1, { score: 3 });
  const manual = seedCustomer(db, 2);
  db.setAiEnabled(manual, false, "manual");
  const money = seedCustomer(db, 3);
  db.setAiEnabled(money, false, "money_line");
  const yellow = seedCustomer(db, 4);
  db.setAiEnabled(yellow, false, "not_qualified");
  // เปิดคืนแล้ว = ไม่ใช่ห้องสีเหลือง (setAiEnabled ล้างเหตุ)
  const reopened = seedCustomer(db, 5);
  db.setAiEnabled(reopened, false, "not_qualified");
  db.setAiEnabled(reopened, true);
  const { cookie } = await login(app.server);
  const res = (await httpRequest(app.server, { path: "/console/api/inbox?segment=notqualify", headers: { cookie } })).json;
  assert.deepEqual(res.conversations.map((c) => c.line_user_id), [yellow]);
  assert.equal(res.counts.notqualify, 1);
  assert.equal(res.counts.aioff, 3, "ห้องสีเหลืองยังนับใน AI ปิด");
  const aioff = (await httpRequest(app.server, { path: "/console/api/inbox?segment=aioff", headers: { cookie } })).json;
  assert.deepEqual(aioff.conversations.map((c) => c.line_user_id).sort(), [manual, money, yellow].sort());
});

// v1.4.33 (พี่ง้วงสั่ง 2026-08-19): ตัวกรอง Customer ต้องผูกกับ "ป้ายที่ทีมงานกดเอง"
// ไม่ใช่สถานะที่เดาเอา — ห้องกลุ่มนี้บอทเงียบถาวร คนคุยเอง จึงต้องแยกออกจากรายการ
// ที่ใช้ไล่งานขายประจำวัน
test("inbox: segment customer = เฉพาะห้องที่ติดป้าย customer เท่านั้น", async (t) => {
  const { app, db } = await startConsole(t);
  seedCustomer(db, 3, { score: 6 });
  seedCustomer(db, 5);
  const { cookie } = await login(app.server);
  db.addTag("U-vol-003", "customer", "human");
  db.addTag("U-vol-005", "hot", "ai"); // ป้ายอื่นต้องไม่ถูกนับ

  const res = await httpRequest(app.server, { path: "/console/api/inbox?segment=customer", headers: { cookie } });
  assert.deepEqual(res.json.conversations.map((c) => c.line_user_id), ["U-vol-003"]);
  assert.equal(res.json.counts.customer, 1);
});

test("inbox: segment มั่ว -> 400", async (t) => {
  const { app } = await startConsole(t);
  const { cookie } = await login(app.server);
  const res = await httpRequest(app.server, { path: "/console/api/inbox?segment=vip", headers: { cookie } });
  assert.equal(res.status, 400);
});

/* --------------------------------- search --------------------------------- */

test("inbox: q ค้นได้ทั้ง display_name, known_name และข้อความล่าสุด", async (t) => {
  const { app, db } = await startConsole(t);
  seedCustomer(db, 1, { name: "คุณสมชาย" });
  seedCustomer(db, 2, { name: "คุณสมหญิง" });
  db.setKnownName("U-vol-002", "ปุ๊กกี้");
  const id3 = seedCustomer(db, 3, { name: "ลูกค้าทั่วไป" });
  db.insertMessage({ customerId: id3, direction: "in", content: "สนใจรุ่น X5Pro ครับ" });
  const { cookie } = await login(app.server);

  const byName = await httpRequest(app.server, {
    path: `/console/api/inbox?q=${encodeURIComponent("สมชาย")}`, headers: { cookie },
  });
  assert.deepEqual(byName.json.conversations.map((c) => c.line_user_id), ["U-vol-001"]);

  const byKnown = await httpRequest(app.server, {
    path: `/console/api/inbox?q=${encodeURIComponent("ปุ๊กกี้")}`, headers: { cookie },
  });
  assert.deepEqual(byKnown.json.conversations.map((c) => c.line_user_id), ["U-vol-002"]);

  const byMessage = await httpRequest(app.server, {
    path: `/console/api/inbox?q=${encodeURIComponent("X5Pro")}`, headers: { cookie },
  });
  assert.deepEqual(byMessage.json.conversations.map((c) => c.line_user_id), ["U-vol-003"]);

  const none = await httpRequest(app.server, {
    path: `/console/api/inbox?q=${encodeURIComponent("ไม่มีทางเจอ")}`, headers: { cookie },
  });
  assert.equal(none.json.conversations.length, 0);
});

test("inbox: q ที่มี % หรือ _ เป็น literal ไม่ใช่ wildcard", async (t) => {
  const { app, db } = await startConsole(t);
  seedCustomer(db, 1, { name: "โปร 100%" });
  seedCustomer(db, 2, { name: "โปร 100บาท" });
  const { cookie } = await login(app.server);
  const res = await httpRequest(app.server, {
    path: `/console/api/inbox?q=${encodeURIComponent("100%")}`, headers: { cookie },
  });
  assert.deepEqual(res.json.conversations.map((c) => c.line_user_id), ["U-vol-001"]);
});

test("inbox: deep=1 ค้นข้อความเก่าที่ไม่ใช่ข้อความล่าสุดได้ และ escape wildcard เหมือนเดิม", async (t) => {
  const { app, db } = await startConsole(t);
  const id = seedCustomer(db, 1, { name: "ลูกค้าทั่วไป" });
  db.insertMessage({ customerId: id, direction: "in", content: "คีย์เวิร์ดเก่า DEEP-100%_ONLY" });
  db.insertMessage({ customerId: id, direction: "out", content: "ข้อความล่าสุดไม่มีคำที่ค้น" });
  const { cookie } = await login(app.server);

  const shallow = await httpRequest(app.server, {
    path: `/console/api/inbox?q=${encodeURIComponent("DEEP-100%_ONLY")}`, headers: { cookie },
  });
  assert.deepEqual(shallow.json.conversations, [], "default API ยัง backwards-compatible กับการค้นข้อความล่าสุด");
  assert.equal(shallow.json.deepSearch, false);

  const deep = await httpRequest(app.server, {
    path: `/console/api/inbox?deep=1&q=${encodeURIComponent("DEEP-100%_ONLY")}`, headers: { cookie },
  });
  assert.deepEqual(deep.json.conversations.map((c) => c.line_user_id), [id]);
  assert.equal(deep.json.deepSearch, true);
});

test("inbox: deep ค่าไม่ถูกต้องถูก reject และคำค้นหนึ่งตัวไม่สแกนประวัติทั้งหมด", async (t) => {
  const { app, db } = await startConsole(t);
  const id = seedCustomer(db, 1, { name: "ลูกค้าทั่วไป" });
  db.insertMessage({ customerId: id, direction: "in", content: "Z อยู่ในข้อความเก่า" });
  db.insertMessage({ customerId: id, direction: "out", content: "ล่าสุด" });
  const { cookie } = await login(app.server);

  const invalid = await httpRequest(app.server, { path: "/console/api/inbox?deep=yes&q=abc", headers: { cookie } });
  assert.equal(invalid.status, 400);
  const tooShort = await httpRequest(app.server, { path: "/console/api/inbox?deep=1&q=Z", headers: { cookie } });
  assert.deepEqual(tooShort.json.conversations, []);
  assert.equal(tooShort.json.deepSearch, false);
});

test("inbox: deep search ยังคงบังคับ channel และ segment ก่อนคืนผล", async (t) => {
  const { app, db } = await startConsole(t, { overrides: { channels: [
    { id: "oa-a", name: "OA A", channelSecret: "secret-a", channelAccessToken: "token-a", active: true },
    { id: "oa-b", name: "OA B", channelSecret: "secret-b", channelAccessToken: "token-b", active: true },
  ] } });
  const hotA = seedCustomer(db, 21, { score: 9, name: "Hot A" });
  const coldA = seedCustomer(db, 22, { score: 2, name: "Cold A" });
  const hotB = seedCustomer(db, 23, { score: 10, name: "Hot B" });
  for (const id of [hotA, coldA, hotB]) {
    db.insertMessage({ customerId: id, direction: "in", content: "ข้อความเก่า NEEDLE-CHANNEL" });
    db.insertMessage({ customerId: id, direction: "out", content: "ข้อความล่าสุด" });
  }
  db.raw.prepare("UPDATE customers SET channel_id = 'oa-a' WHERE line_user_id IN (?, ?)").run(hotA, coldA);
  db.raw.prepare("UPDATE customers SET channel_id = 'oa-b' WHERE line_user_id = ?").run(hotB);
  const { cookie } = await login(app.server);

  const result = await httpRequest(app.server, {
    path: `/console/api/inbox?deep=1&segment=hot&channel=oa-a&q=${encodeURIComponent("NEEDLE-CHANNEL")}`,
    headers: { cookie },
  });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.conversations.map((c) => c.line_user_id), [hotA]);
});

test("inbox: deep search ใช้ message-first subquery ไม่ผูก scan ซ้ำกับลูกค้าแต่ละแถว", () => {
  const db = memoryDb();
  try {
    seedCustomer(db, 31, { name: "Performance guard" });
    const originalPrepare = db.raw.prepare.bind(db.raw);
    let executedSql = "";
    db.raw.prepare = (sql) => {
      if (String(sql).includes("search_message")) executedSql = String(sql);
      return originalPrepare(sql);
    };
    db.listConversations({ q: "needle", deep: true, limit: 30 });
    assert.match(executedSql, /line_user_id\s+IN\s*\(\s*SELECT\s+search_message\.customer_id/iu);
    assert.doesNotMatch(executedSql, /search_message\.customer_id\s*=\s*searched\.line_user_id/iu);
  } finally {
    db.close();
  }
});

/* --------------------------------- unread ---------------------------------- */

test("unread: inbound ใหม่ = unread 1, เปิดห้องแล้วดับ, ทักมาใหม่ติดอีกรอบ (updated_at ไม่ขยับตอน seen)", async (t) => {
  const { app, db } = await startConsole(t);
  const id = seedCustomer(db, 1);
  const { cookie } = await login(app.server);

  const before = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } });
  assert.equal(before.json.conversations[0].unread, 1, "ยังไม่เคยเปิด = unread");
  const updatedBefore = db.getCustomer(id).updated_at;

  // เปิดห้อง (GET messages หัวห้อง) = mark seen
  const room = await httpRequest(app.server, {
    path: `/console/api/conversations/${id}/messages`, headers: { cookie },
  });
  assert.equal(room.status, 200);
  assert.equal(db.getCustomer(id).updated_at, updatedBefore, "mark seen ห้ามขยับ updated_at");

  const after = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } });
  assert.equal(after.json.conversations[0].unread, 0, "เปิดห้องแล้วต้องหาย unread");

  // ลูกค้าทักใหม่ -> unread กลับมา
  await new Promise((r) => setTimeout(r, 3));
  db.insertMessage({ customerId: id, direction: "in", content: "ทักใหม่" });
  const again = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie } });
  assert.equal(again.json.conversations[0].unread, 1);

  // แต่โหลดย้อนอดีต (beforeAt) ต้องไม่ mark seen
  db.insertMessage({ customerId: id, direction: "in", content: "อีกข้อความ" });
  const seenAt = db.getCustomer(id).last_seen_by_operator_at;
  await httpRequest(app.server, {
    path: `/console/api/conversations/${id}/messages?beforeAt=${Date.now() + 1000}&beforeRid=999999`,
    headers: { cookie },
  });
  assert.equal(db.getCustomer(id).last_seen_by_operator_at, seenAt, "โหลดย้อนอดีตห้าม mark seen");
});

/* --------------------------- chat history pagination ------------------------ */

test("messages: default 50 ล่าสุด + hasMoreOlder + ไล่หน้าเก่าด้วย beforeAt/beforeRid จนครบ", async (t) => {
  const { app, db } = await startConsole(t);
  const id = "U-long";
  db.upsertCustomer(id, { displayName: "แชทยาว" });
  const t0 = Date.now() - 200_000;
  for (let i = 0; i < 120; i += 1) {
    db.raw.prepare(
      `INSERT INTO messages (id, customer_id, direction, channel, msg_type, content, message_class, operator, created_at)
       VALUES (?, ?, 'in', 'line', 'text', ?, 'reactive', '', ?)`
    ).run(`m-${i}`, id, `ข้อความ ${i}`, t0 + i * 1000);
  }
  const { cookie } = await login(app.server);

  const head = await httpRequest(app.server, {
    path: `/console/api/conversations/${id}/messages`, headers: { cookie },
  });
  assert.equal(head.json.messages.length, 50, "หัวห้อง = 50 ล่าสุด");
  assert.equal(head.json.hasMoreOlder, true);
  assert.equal(head.json.messages.at(-1).content, "ข้อความ 119", "ท้าย list = ใหม่สุด");
  assert.equal(promptText(head.json.messages[0].content), "ข้อความ 70", "หัว list = เก่าสุดของหน้า");
  assert.ok(Number.isInteger(head.json.messages[0].rid), "ทุกแถวมี rid สำหรับ cursor");

  // หน้า 2 (เก่ากว่า)
  const oldest = head.json.messages[0];
  const p2 = await httpRequest(app.server, {
    path: `/console/api/conversations/${id}/messages?beforeAt=${oldest.created_at}&beforeRid=${oldest.rid}`,
    headers: { cookie },
  });
  assert.equal(p2.json.messages.length, 50);
  assert.equal(p2.json.hasMoreOlder, true);
  assert.equal(p2.json.messages.at(-1).content, "ข้อความ 69", "หน้า 2 ต่อเนื่องไม่ขาดไม่ซ้ำ");
  assert.equal(promptText(p2.json.messages[0].content), "ข้อความ 20");
  assert.equal(p2.json.customer, undefined, "โหลดย้อนอดีต = payload เบา ไม่แนบโปรไฟล์");

  // หน้า 3 (สุดทาง)
  const oldest2 = p2.json.messages[0];
  const p3 = await httpRequest(app.server, {
    path: `/console/api/conversations/${id}/messages?beforeAt=${oldest2.created_at}&beforeRid=${oldest2.rid}`,
    headers: { cookie },
  });
  assert.equal(p3.json.messages.length, 20);
  assert.equal(p3.json.hasMoreOlder, false);
  assert.equal(promptText(p3.json.messages[0].content), "ข้อความ 0");
});

test("messages: beforeAt ไม่ใช่ตัวเลข -> 400", async (t) => {
  const { app, db } = await startConsole(t);
  seedCustomer(db, 1);
  const { cookie } = await login(app.server);
  const res = await httpRequest(app.server, {
    path: "/console/api/conversations/U-vol-001/messages?beforeAt=abc", headers: { cookie },
  });
  assert.equal(res.status, 400);
});

/* ------------------------------- brain (G4) -------------------------------- */

const BRAIN_OVERRIDES = {
  safetyRules: [
    { keywords: ["ไฟไหม้", "ควันออก"], template: "หยุดใช้งานทันที ถอดปลั๊ก แล้วทีมงานจะรีบติดต่อกลับค่ะ", reason: "device_fire" },
  ],
  imageCatalog: [
    { key: "x5pro-main", url: "https://img.example.com/x5.jpg", previewUrl: "https://img.example.com/x5-s.jpg", description: "Airdog X5Pro", needsVerification: false },
    { key: "x8-main", url: "https://img.example.com/x8.jpg", previewUrl: "https://img.example.com/x8.jpg", description: "", needsVerification: true },
  ],
};

test("brain: ไม่มี session -> 401 (deny by default)", async (t) => {
  const { app } = await startConsole(t);
  const res = await httpRequest(app.server, { path: "/console/api/brain" });
  assert.equal(res.status, 401);
});

test("brain: คืน brandPack/persona/ราคา approve/รูป/กฎ safety/โมเดล/knowledge stats ครบ", async (t) => {
  const { app, db } = await startConsole(t, {
    configOverrides: { BRAND_PACK: "ร้าน Airdog ตัวแทนไทย ดูแลเครื่องฟอกอากาศ", HERMES_MODEL: "gpt-5.6-sol" },
    overrides: { ...BRAIN_OVERRIDES, persona: "น้องแอร์ ผู้ช่วยใจดี" },
  });
  db.setApprovedPrice("X5Pro ราคาเต็ม", 25900);
  db.setApprovedPrice("ค่าส่ง", 0);
  db.addKnowledge({ title: "โปรเดือนนี้", content: "ผ่อน 0% 10 เดือน", updatedBy: "nok" });
  const off = db.addKnowledge({ title: "ความรู้ที่ปิด", content: "x".repeat(100), updatedBy: "nok" });
  db.updateKnowledge(off.id, { active: false });
  const { cookie } = await login(app.server);

  const res = await httpRequest(app.server, { path: "/console/api/brain", headers: { cookie } });
  assert.equal(res.status, 200);
  const b = res.json;
  assert.ok(b.brandPack.includes("Airdog"), "brandPack ต้องเป็นข้อความที่โหลดจริง");
  assert.equal(b.persona, "น้องแอร์ ผู้ช่วยใจดี");
  assert.equal(b.approvedPrices.length, 2);
  assert.ok(b.approvedPrices.some((p) => p.label === "X5Pro ราคาเต็ม" && p.amount === 25900));
  assert.equal(b.images.length, 2);
  const img = b.images.find((i) => i.key === "x5pro-main");
  assert.equal(img.previewUrl, "https://img.example.com/x5-s.jpg");
  assert.equal(b.images.find((i) => i.key === "x8-main").needsVerification, true);
  assert.equal(b.safetyRules.length, 1);
  assert.deepEqual(b.safetyRules[0].keywords, ["ไฟไหม้", "ควันออก"]);
  assert.equal(b.safetyRules[0].reason, "device_fire");
  assert.equal(b.models.replyModel, "gpt-5.6-sol");
  // knowledge stats: นับเฉพาะ active เข้า inject
  assert.equal(b.knowledge.total, 2);
  assert.equal(b.knowledge.active, 1);
  assert.equal(b.knowledge.maxChars, KNOWLEDGE_MAX_CHARS);
  assert.ok(b.knowledge.injectedChars > 0 && b.knowledge.injectedChars < 200,
    "รายการ active เดียวสั้น ๆ — injectedChars ต้องไม่รวมรายการที่ปิด");
  assert.ok(b.knowledge.approxTokens > 0);
});

test("brain: โมเดล runtime ที่สลับใน DB ต้องสะท้อนใน brain ทันที", async (t) => {
  const { app, db } = await startConsole(t);
  db.setSetting("reply_model", "terra-mini");
  const { cookie } = await login(app.server);
  const res = await httpRequest(app.server, { path: "/console/api/brain", headers: { cookie } });
  assert.equal(res.json.models.replyModel, "terra-mini");
});

/* --------------------------- static + CSP (G4) ----------------------------- */

test("static: ไฟล์แยกของ chat/broadcast อยู่ใน allowlist และเสิร์ฟได้", async (t) => {
  const { app } = await startConsole(t);
  for (const name of ["chat.mjs", "chatMedia.mjs", "context.mjs", "inbox.mjs"]) {
    const res = await httpRequest(app.server, { path: `/console/static/${name}` });
    assert.equal(res.status, 200, `${name} ต้องเสิร์ฟได้`);
    assert.ok(res.headers["content-type"].includes("javascript"));
  }
  const css = await httpRequest(app.server, { path: "/console/static/workspace.css" });
  assert.equal(css.status, 200);
  assert.ok(css.headers["content-type"].includes("text/css"));
  const instanceCss = await httpRequest(app.server, { path: "/console/static/instance-scope.css" });
  assert.equal(instanceCss.status, 200);
  assert.ok(instanceCss.headers["content-type"].includes("text/css"));
  const broadcastCss = await httpRequest(app.server, { path: "/console/static/broadcast.css" });
  assert.equal(broadcastCss.status, 200);
  assert.ok(broadcastCss.headers["content-type"].includes("text/css"));
});

test("CSP: img-src เปิด https: (โปรไฟล์ LINE + thumbnail) แต่ script/connect ยังล็อก self", async (t) => {
  const { app } = await startConsole(t);
  const page = await httpRequest(app.server, { path: "/console/login" });
  const csp = page.headers["content-security-policy"];
  assert.ok(csp.includes("img-src 'self' data: https:"), `img-src ต้องมี https: (ได้ ${csp})`);
  assert.ok(csp.includes("script-src 'self';"), "script-src ต้องยังเป็น self เท่านั้น");
  assert.ok(csp.includes("connect-src 'self';"), "connect-src ต้องยังเป็น self เท่านั้น");
});

// delta-audit regressions (2026-08-10): limit ติดลบ/ทศนิยม + inboxCounts กัน canary
test("delta-audit: limit ติดลบ/ทศนิยม ไม่ dump ทั้งประวัติ และไม่ 500", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("Ubig", {});
  for (let i = 0; i < 30; i++) {
    db.insertMessage({ customerId: "Ubig", direction: "in", msgType: "text", content: `ข้อความ ${i}` });
  }
  const { cookie } = await login(app.server);
  const neg = await httpRequest(app.server, { path: "/console/api/conversations/Ubig/messages?limit=-2", headers: { cookie } });
  assert.equal(neg.status, 200);
  assert.ok((neg.json.messages || []).length <= 1, `limit ติดลบต้องถูก clamp เป็น 1 (ได้ ${(neg.json.messages || []).length})`);
  const frac = await httpRequest(app.server, { path: "/console/api/conversations/Ubig/messages?limit=2.5", headers: { cookie } });
  assert.equal(frac.status, 200, "limit ทศนิยมห้าม 500");
  const fracInbox = await httpRequest(app.server, { path: "/console/api/inbox?limit=2.5", headers: { cookie } });
  assert.equal(fracInbox.status, 200, "inbox limit ทศนิยมห้าม 500");
});

test("delta-audit: inboxCounts ไม่นับ canary", async (t) => {
  const { app, db } = await startConsole(t);
  db.upsertCustomer("Ureal", {});
  db.insertMessage({ customerId: "Ureal", direction: "in", msgType: "text", content: "สวัสดี" });
  db.upsertCustomer("canary:synthetic", {});
  db.insertMessage({ customerId: "canary:synthetic", direction: "in", msgType: "text", content: "[canary] ping" });
  const counts = db.inboxCounts();
  assert.equal(counts.all, 1, `canary ห้ามโผล่ใน counts (ได้ ${JSON.stringify(counts)})`);
});
