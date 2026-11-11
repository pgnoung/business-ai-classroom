// owner-lessons-api.test.mjs — เส้น /console/api/lessons/* + ส่วนบทเรียนของ /teach/why
//
// ยิง HTTP จริง เพราะด่านจริงอยู่ที่ handler (หน้าเว็บแค่ไม่วาดปุ่ม) — ข้อมูลสังเคราะห์ทั้งหมด
// สิ่งที่กัน:
//   1. สิทธิ์: เจ้าของสอน = ใช้ทันที · แอดมิน/ทีมงานสอน = รออนุมัติ · ปุ่มของเจ้าของกันด้วย lessons.approve
//   2. แฟล็กจอสอนปิด = เส้นนี้ไม่มีอยู่จริง (404) และเมนูไม่ขึ้น
//   3. สอนเรื่องเดิมซ้ำ = เก็บแถวเดียว และผลลัพธ์ขึ้นกับว่าใครสอนซ้ำ
//   4. คำลูกค้า/คำตอบเดิมเก็บแบบลบข้อมูลระบุตัว · สิทธิ์ให้ลืมล้างทิ้งแต่คำสอนอยู่ต่อ
//   5. แผง "ทำไมตอบแบบนี้" บอกบทเรียนที่เทิร์นนั้นใช้จริง (จาก metadata) ไม่ใช่เดา
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen,
} from "./helpers.mjs";
import { LESSON_SAVED_ACTIVE, LESSON_SAVED_PENDING } from "../src/consoleLessonsApi.mjs";
import { OWNER_LESSONS_PAUSED_KEY } from "../src/ownerLessons.mjs";
import { brainModeKey } from "../src/knowledgePack.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const SECRET = "owner-lessons-console-secret-0123456789";
const PASSWORD = "owner-lessons-pass-1234";
const CUSTOMER = "U-lesson-fixture-001";

async function boot(t, { teach = true, channels = null } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: SECRET, TEACH_ENABLED: teach ? "true" : "false" });
  let clock = 1_790_000_000_000;
  const db = memoryDb({ now: () => (clock += 1000) });
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "nok", passHash: hashPassword(PASSWORD), displayName: "นก", role: "admin" });
  db.createOperator({ username: "chompoo", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  db.createOperator({ username: "ploy", passHash: hashPassword(PASSWORD), displayName: "พลอย", role: "operator" });
  db.upsertCustomer(CUSTOMER, { displayName: "ลูกค้าสังเคราะห์" });
  db.setKnownName(CUSTOMER, "สมศรีทดสอบ");
  db.insertMessage({ customerId: CUSTOMER, direction: "out", content: "สวัสดีค่ะ", agentMode: "ai" });
  db.insertMessage({ customerId: CUSTOMER, direction: "in", content: "คุณสมศรีทดสอบค่ะ อยากถามว่า" });
  db.insertMessage({ customerId: CUSTOMER, direction: "in", content: "มีที่จอดรถไหมคะ โทร 081-234-5678 ได้ค่ะ" });
  const aiReply = db.insertMessage({
    customerId: CUSTOMER, direction: "out", content: "มีค่ะคุณสมศรีทดสอบ จอดได้ 2 ชั่วโมงนะคะ", agentMode: "ai",
  });
  const aiSecondBubble = db.insertMessage({ customerId: CUSTOMER, direction: "out", content: "มากี่ท่านคะ", agentMode: "ai" });
  const humanReply = db.insertMessage({ customerId: CUSTOMER, direction: "out", content: "เดี๋ยวชมพู่ดูให้ค่ะ", operator: "chompoo" });
  const notices = [];
  const app = createApp({
    config, db,
    overrides: {
      hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {},
      notifier: { fireLater: (args) => notices.push(args), fire: async () => ({}) },
      ...(channels ? { channels } : {}),
    },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db, aiReply, aiSecondBubble, humanReply, notices };
}

const send = (server, method, path, body, headers = {}) => httpRequest(server, {
  method, path, headers: { "content-type": "application/json", ...headers },
  body: body === undefined ? null : JSON.stringify(body),
});
async function login(server, username) {
  const res = await send(server, "POST", "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, res.text);
  const cookie = (res.headers["set-cookie"]?.[0] || "").split(";")[0];
  return { cookie, csrf: res.json.csrf };
}
function client(server, session) {
  const headers = { cookie: session.cookie, "x-csrf-token": session.csrf };
  return {
    get: (path) => httpRequest(server, { path, headers }),
    post: (path, body = {}) => send(server, "POST", path, body, headers),
    del: (path) => send(server, "DELETE", path, undefined, headers),
  };
}
const teach = (as, messageId, teaching, topic = "ที่จอดรถ") => as.post("/console/api/lessons", { messageId, teaching, topic });

/* ---------------------------------- แฟล็ก ---------------------------------- */

test("แฟล็กจอสอนปิด = เส้นบทเรียนเหมือนไม่มีอยู่จริง (404) และเมนูไม่ขึ้น", async (t) => {
  const { app, aiReply } = await boot(t, { teach: false });
  const owner = client(app.server, await login(app.server, "ngoung"));
  assert.equal((await owner.get("/console/api/lessons")).status, 404);
  assert.equal((await teach(owner, aiReply, "ตอบสั้น ๆ")).status, 404);
  assert.equal((await owner.get("/console/api/me")).json.features.lessons, false);
});

test("แฟล็กเปิด: เมนูบทเรียนขึ้นทั้งเจ้าของและทีมงาน (ทีมงานสอนได้ รออนุมัติ)", async (t) => {
  const { app } = await boot(t);
  for (const username of ["ngoung", "nok", "chompoo"]) {
    const me = await client(app.server, await login(app.server, username)).get("/console/api/me");
    assert.equal(me.json.features.lessons, true, username);
    assert.ok(me.json.operator.capabilities.includes("lessons.teach"), username);
    assert.equal(me.json.operator.capabilities.includes("lessons.approve"), username === "ngoung", username);
  }
});

/* ------------------------------- สอนจากข้อความ ------------------------------- */

test("เจ้าของสอน = ใช้ทันที และเก็บบริบทแบบลบข้อมูลระบุตัวแล้ว", async (t) => {
  const { app, db, aiReply, notices } = await boot(t);
  const owner = client(app.server, await login(app.server, "ngoung"));
  const res = await teach(owner, aiReply, "บอกว่าจอดได้ที่อาคารเรียน แล้วถามว่ามากี่ท่าน");
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.status, "active");
  assert.equal(res.json.message, LESSON_SAVED_ACTIVE);
  const row = db.getOwnerLesson(res.json.lesson.id);
  assert.equal(row.status, "active");
  assert.equal(row.decided_by, "ngoung");
  assert.equal(row.channel_id, null, "สมองกลาง = ใช้ทุกช่องทาง");
  assert.equal(row.source_message_id, aiReply);
  assert.equal(row.customer_id, CUSTOMER);
  assert.equal(row.topic, "ที่จอดรถ");
  assert.match(row.customer_text, /มีที่จอดรถไหมคะ/u, "คำลูกค้าที่นำไปสู่คำตอบต้องถูกเก็บ");
  assert.doesNotMatch(row.customer_text, /สวัสดีค่ะ/u, "คำตอบรอบก่อนไม่ใช่คำลูกค้า");
  for (const pii of ["สมศรีทดสอบ", "081-234-5678"]) {
    assert.ok(!row.customer_text.includes(pii) && !row.ai_text.includes(pii), `ต้องลบ ${pii} ออกก่อนเก็บ`);
  }
  assert.match(row.ai_text, /จอดได้ 2 ชั่วโมง/u);
  assert.equal(notices.length, 0, "เจ้าของสอนเองไม่ต้องปลุกใคร");
  const audit = db.listAudit(20).find((entry) => entry.action === "lesson_saved");
  assert.ok(audit && !String(audit.detail).includes("081"), "audit เก็บแค่หัวข้อ ไม่เก็บคำลูกค้า");
});

test("สอนจากฟองที่สองของคำตอบเดียวกัน ต้องได้คำลูกค้าชุดเดียวกับฟองแรก", async (t) => {
  const { app, db, aiSecondBubble } = await boot(t);
  const owner = client(app.server, await login(app.server, "ngoung"));
  const res = await teach(owner, aiSecondBubble, "ถามจำนวนคนทีหลังได้ ไม่ต้องรีบ");
  assert.equal(res.status, 200, res.text);
  assert.match(db.getOwnerLesson(res.json.lesson.id).customer_text, /มีที่จอดรถไหมคะ/u);
});

test("แอดมินและทีมงานสอน = รอเจ้าของอนุมัติ ยังไม่เข้าพรอมต์ และปลุกเจ้าของ", async (t) => {
  const { app, db, aiReply, notices } = await boot(t);
  for (const username of ["nok", "chompoo"]) {
    const as = client(app.server, await login(app.server, username));
    const res = await teach(as, aiReply, `บทเรียนของ ${username}: ตอบสั้นก่อน`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.status, "pending", username);
    assert.equal(res.json.message, LESSON_SAVED_PENDING);
  }
  assert.deepEqual(db.activeOwnerLessons("default"), [], "ของที่รออนุมัติห้ามถูกหยิบไปร่างคำตอบ");
  assert.equal(notices.length, 2);
  assert.equal(notices[0].customerId, "ops:lessons");
  assert.match(notices[1].reasonTextOverride, /รออนุมัติทั้งหมด 2 เรื่อง/u);
  assert.equal(notices[0].force, undefined, "ไม่ force — สอนรัว ๆ ได้แจ้งเตือนเดียวต่อรอบ cooldown");
});

test("สอนได้จากคำตอบของ AI เท่านั้น และตรวจความยาว/ความเป็นส่วนตัวที่เซิร์ฟเวอร์", async (t) => {
  const { app, db, aiReply, humanReply } = await boot(t);
  const owner = client(app.server, await login(app.server, "ngoung"));
  const inbound = db.messagesFor(CUSTOMER).find((row) => row.direction === "in").id;
  assert.equal((await teach(owner, inbound, "ตอบสั้น")).status, 400, "ข้อความลูกค้าไม่ใช่สิ่งที่ลูกแพรพูด");
  assert.equal((await teach(owner, humanReply, "ตอบสั้น")).status, 400, "ข้อความที่คนตอบเองไม่ใช่ของลูกแพร");
  assert.equal((await teach(owner, "no-such-message", "ตอบสั้น")).status, 404);
  assert.equal((await teach(owner, aiReply, " ")).status, 400);
  assert.equal((await teach(owner, aiReply, "...!?")).status, 400, "จุด/เครื่องหมายล้วนไม่ใช่คำสอน");
  const tooLong = await teach(owner, aiReply, "ก".repeat(601));
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.json.error, /ไม่เกิน 600/u);
  const named = await teach(owner, aiReply, "ถ้าสมศรีทดสอบถามอีก ให้ตอบว่าจอดฟรี");
  assert.equal(named.status, 400);
  assert.match(named.json.error, /ชื่อลูกค้าห้องนี้/u);
  assert.equal((await teach(owner, aiReply, "ให้โทรหา 081-234-5678")).status, 400);
  assert.equal((await teach(owner, aiReply, "ตอบสั้น", "คุณสมศรีทดสอบ")).status, 400, "หัวข้อก็ต้องผ่านด่านเดียวกัน");
  assert.equal((await owner.post("/console/api/lessons", { messageId: aiReply, teaching: { text: "x" } })).status, 400,
    "ช่องข้อความที่ไม่ใช่สตริงต้องถูกปฏิเสธ ไม่ใช่กลายเป็น [object Object]");
  assert.equal((await owner.post("/console/api/lessons", { messageId: aiReply, teaching: "ตอบสั้น", topic: 5 })).status, 400);
  assert.equal(db.countOwnerLessonsTotal(), 0, "ทุกกรณีข้างบนต้องไม่มีแถวเกิดขึ้นเลย");
  const noCsrf = await send(app.server, "POST", "/console/api/lessons", { messageId: aiReply, teaching: "ตอบสั้น" },
    { cookie: (await login(app.server, "ngoung")).cookie });
  assert.equal(noCsrf.status, 403);
});

/* ---------------------------------- กันซ้ำ ---------------------------------- */

test("สอนเรื่องเดิมซ้ำ = เก็บแถวเดียว และผลลัพธ์ขึ้นกับว่าใครสอนซ้ำ", async (t) => {
  const { app, db, aiReply } = await boot(t);
  const owner = client(app.server, await login(app.server, "ngoung"));
  const staff = client(app.server, await login(app.server, "chompoo"));
  const first = await teach(owner, aiReply, "ตอบสั้น ๆ ก่อน แล้วค่อยถาม");
  const again = await teach(owner, aiReply, "  ตอบสั้น ๆ  ก่อน แล้วค่อยถาม. ");
  assert.equal(again.json.duplicate, true);
  assert.equal(again.json.lesson.id, first.json.lesson.id);
  assert.match(again.json.message, /มีบทเรียนนี้อยู่แล้ว/u);
  assert.equal((await teach(staff, aiReply, "ตอบสั้น ๆ ก่อน แล้วค่อยถาม")).json.lesson.id, first.json.lesson.id);

  const proposed = await teach(staff, aiReply, "ห้ามใช้คำว่าจัดให้");
  assert.equal(proposed.json.status, "pending");
  assert.match((await teach(staff, aiReply, "ห้ามใช้คำว่าจัดให้")).json.message, /รอพี่ง้วงอนุมัติอยู่แล้ว/u);
  const ownerSame = await teach(owner, aiReply, "ห้ามใช้คำว่าจัดให้");
  assert.equal(ownerSame.json.status, "active", "เจ้าของสอนเรื่องที่รออยู่ = อนุมัติเรื่องนั้น");
  assert.equal(ownerSame.json.lesson.id, proposed.json.lesson.id);

  await owner.post(`/console/api/lessons/${first.json.lesson.id}/enable`, { enabled: false });
  const requeued = await teach(staff, aiReply, "ตอบสั้น ๆ ก่อน แล้วค่อยถาม");
  assert.equal(requeued.json.status, "pending", "ทีมงานสอนเรื่องที่เจ้าของปิดไว้ = กลับเข้าคิวให้เจ้าของตัดสิน");
  assert.equal(requeued.json.lesson.createdBy, "chompoo", "คำขอรอบใหม่เป็นของคนที่ส่ง — เขาต้องเห็นและถอนเองได้");
  assert.ok((await staff.get("/console/api/lessons")).json.lessons.some((row) => row.id === first.json.lesson.id));
  assert.equal((await staff.del(`/console/api/lessons/${first.json.lesson.id}`)).status, 200, "ถอนคำขอของตัวเองได้");
  await teach(owner, aiReply, "ตอบสั้น ๆ ก่อน แล้วค่อยถาม");
  assert.equal(db.countOwnerLessonsTotal(), 2);
});

/* ---------------------------------- สิทธิ์ ---------------------------------- */

test("สิทธิ์: ทีมงานแก้/ถอนได้เฉพาะของตัวเองที่รออยู่ · ปุ่มอนุมัติ/ปิด/หยุดเป็นของเจ้าของ", async (t) => {
  const { app, db, aiReply } = await boot(t);
  const owner = client(app.server, await login(app.server, "ngoung"));
  const staff = client(app.server, await login(app.server, "chompoo"));
  const other = client(app.server, await login(app.server, "ploy"));
  const admin = client(app.server, await login(app.server, "nok"));
  const active = (await teach(owner, aiReply, "ตอบสั้นก่อนเสมอ")).json.lesson;
  const mine = (await teach(staff, aiReply, "ชวนดูรีวิวก่อนบอกราคา")).json.lesson;
  const theirs = (await teach(other, aiReply, "ถามจำนวนผู้เรียนก่อน")).json.lesson;

  for (const as of [staff, admin]) {
    for (const [method, path, body] of [
      ["post", `/console/api/lessons/${mine.id}/approve`, {}],
      ["post", `/console/api/lessons/${mine.id}/decline`, {}],
      ["post", `/console/api/lessons/${active.id}/enable`, { enabled: false }],
      ["post", "/console/api/lessons/pause", { paused: true }],
      ["post", `/console/api/lessons/${active.id}`, { teaching: "แก้ของเจ้าของ" }],
      ["del", `/console/api/lessons/${active.id}`],
    ]) {
      const res = method === "del" ? await as.del(path) : await as.post(path, body);
      assert.equal(res.status, 403, `${method} ${path} ต้องถูกกัน — ${res.text}`);
    }
  }
  assert.equal((await staff.post(`/console/api/lessons/${theirs.id}`, { teaching: "แก้ของคนอื่น" })).status, 403);
  assert.equal((await staff.del(`/console/api/lessons/${theirs.id}`)).status, 403);
  const edited = await staff.post(`/console/api/lessons/${mine.id}`, { teaching: "ชวนดูรีวิวก่อน แล้วค่อยบอกราคา", topic: "รีวิว" });
  assert.equal(edited.status, 200, edited.text);
  assert.equal(edited.json.lesson.status, "pending", "ทีมงานแก้ของตัวเองแล้วยังต้องรออนุมัติ");
  assert.equal((await staff.post(`/console/api/lessons/${mine.id}`, { channelId: "elsewhere" })).json.lesson.channelId, null,
    "ทีมงานเปลี่ยนขอบเขตช่องทางไม่ได้ (ค่าถูกทิ้ง)");

  // รายการ: ทีมงานเห็นของที่ใช้อยู่ + ของตัวเอง · เจ้าของเห็นทั้งหมด
  const staffList = await staff.get("/console/api/lessons");
  assert.deepEqual(staffList.json.lessons.map((row) => row.id).sort(), [active.id, mine.id].sort());
  assert.equal(staffList.json.canApprove, false);
  assert.deepEqual(staffList.json.counts, { all: 2, active: 1, pending: 1, disabled: 0 });
  const ownerList = await owner.get("/console/api/lessons?status=pending");
  assert.deepEqual(ownerList.json.lessons.map((row) => row.id).sort(), [mine.id, theirs.id].sort());
  assert.equal(ownerList.json.counts.all, 3);

  assert.equal((await staff.del(`/console/api/lessons/${mine.id}`)).status, 200, "ถอนคำขอของตัวเองได้");
  assert.equal(db.getOwnerLesson(mine.id), null);
});

test("เจ้าของ: อนุมัติ/ไม่อนุมัติ/ปิด-เปิด/แก้/ลบ/หยุดชั่วคราว ทำงานครบและจด audit", async (t) => {
  const { app, db, aiReply } = await boot(t);
  const owner = client(app.server, await login(app.server, "ngoung"));
  const staff = client(app.server, await login(app.server, "chompoo"));
  const a = (await teach(staff, aiReply, "เรื่องที่หนึ่ง ตอบสั้น")).json.lesson;
  const b = (await teach(staff, aiReply, "เรื่องที่สอง ถามกลับข้อเดียว")).json.lesson;

  const approved = await owner.post(`/console/api/lessons/${a.id}/approve`);
  assert.equal(approved.json.lesson.status, "active");
  assert.equal(db.getOwnerLesson(a.id).decided_by, "ngoung");
  assert.equal((await owner.post(`/console/api/lessons/${a.id}/approve`)).status, 409, "ตัดสินซ้ำไม่ได้");
  assert.equal((await owner.post(`/console/api/lessons/${b.id}/decline`)).status, 200);
  assert.equal(db.getOwnerLesson(b.id), null, "ไม่อนุมัติ = ทิ้งคำขอ");

  assert.equal((await owner.post(`/console/api/lessons/${a.id}/enable`, { enabled: false })).json.lesson.status, "disabled");
  assert.deepEqual(db.activeOwnerLessons("default"), []);
  assert.equal((await owner.post(`/console/api/lessons/${a.id}/enable`, { enabled: true })).json.lesson.status, "active");

  const edit = await owner.post(`/console/api/lessons/${a.id}`, { teaching: "เรื่องที่หนึ่ง ตอบสั้นและสุภาพ", topic: "น้ำเสียง" });
  assert.equal(edit.json.lesson.teaching, "เรื่องที่หนึ่ง ตอบสั้นและสุภาพ");
  assert.equal(edit.json.lesson.topic, "น้ำเสียง");
  const other = (await teach(owner, aiReply, "เรื่องที่สาม")).json.lesson;
  assert.equal((await owner.post(`/console/api/lessons/${other.id}`, { teaching: "เรื่องที่หนึ่ง ตอบสั้นและสุภาพ" })).status, 409,
    "แก้จนซ้ำกับอีกเรื่อง = ปฏิเสธ");
  assert.equal((await owner.post(`/console/api/lessons/${a.id}`, { teaching: "โทร 0812345678" })).status, 400);
  assert.equal((await owner.post(`/console/api/lessons/${a.id}`, { channelId: "no-such-oa" })).status, 400);

  assert.equal((await owner.post("/console/api/lessons/pause", { paused: true })).json.paused, true);
  assert.equal(db.getSetting(OWNER_LESSONS_PAUSED_KEY), "1");
  assert.equal((await owner.get("/console/api/lessons")).json.paused, true);
  await owner.post("/console/api/lessons/pause", { paused: false });

  assert.equal((await owner.del(`/console/api/lessons/${other.id}`)).status, 200);
  assert.equal((await owner.del(`/console/api/lessons/${other.id}`)).status, 404);
  const actions = new Set(db.listAudit(50).map((row) => row.action));
  for (const action of ["lesson_proposed", "lesson_approved", "lesson_declined", "lesson_disabled", "lesson_enabled",
    "lesson_edited", "lessons_paused", "lessons_resumed", "lesson_deleted"]) {
    assert.ok(actions.has(action), `ต้องมี audit ${action}`);
  }
});

test("ค้นหาและกรองสถานะในรายการบทเรียน", async (t) => {
  const { app, aiReply } = await boot(t);
  const owner = client(app.server, await login(app.server, "ngoung"));
  await teach(owner, aiReply, "จอดรถได้ที่อาคารเรียน", "ที่จอดรถ");
  await teach(owner, aiReply, "ตอบเรื่องรอบเรียนตามตาราง", "รอบเรียน");
  const found = await owner.get(`/console/api/lessons?q=${encodeURIComponent("รอบเรียน")}`);
  assert.deepEqual(found.json.lessons.map((row) => row.topic), ["รอบเรียน"]);
  assert.equal((await owner.get("/console/api/lessons?status=disabled")).json.lessons.length, 0);
  assert.equal((await owner.get("/console/api/lessons?q=%25")).json.lessons.length, 0, "อักขระพิเศษของ LIKE ต้องถูก escape");
  const staff = client(app.server, await login(app.server, "chompoo"));
  await teach(staff, aiReply, "เรื่องที่รออนุมัติ ต้องขึ้นก่อน");
  await teach(owner, aiReply, "เรื่องใหม่สุดของเจ้าของ");
  assert.deepEqual((await owner.get("/console/api/lessons")).json.lessons.map((row) => row.status),
    ["pending", "active", "active", "active"], "รออนุมัติขึ้นก่อน ที่เหลือใหม่สุดก่อน");
});

test("สาขาโหมดสมองแยก: บทเรียนจากห้องสาขานั้นผูกสาขานั้นเท่านั้น", async (t) => {
  const channels = [
    { id: "default", name: "OA หลัก", channelSecret: "s-a", channelAccessToken: "t-a", active: true },
    { id: "cnx", name: "OA เชียงใหม่", channelSecret: "s-b", channelAccessToken: "t-b", active: true },
  ];
  const { app, db } = await boot(t, { channels });
  db.upsertCustomer("cnx:U-branch", { displayName: "ลูกค้าสาขา" });
  db.raw.prepare("UPDATE customers SET channel_id = 'cnx' WHERE line_user_id = ?").run("cnx:U-branch");
  db.setSetting(brainModeKey("cnx"), "separate");
  db.insertMessage({ customerId: "cnx:U-branch", direction: "in", content: "จอดรถตรงไหนคะ" });
  const reply = db.insertMessage({ customerId: "cnx:U-branch", direction: "out", content: "จอดหน้าร้านค่ะ", agentMode: "ai" });
  const owner = client(app.server, await login(app.server, "ngoung"));
  const res = await teach(owner, reply, "สาขานี้ให้บอกว่าจอดข้างร้านได้");
  assert.equal(res.json.lesson.channelId, "cnx");
  assert.equal(db.activeOwnerLessons("default").length, 0);
  assert.equal(db.activeOwnerLessons("cnx").length, 1);
  const list = await owner.get("/console/api/lessons");
  assert.deepEqual(list.json.channels.map((channel) => channel.id), ["default", "cnx"]);
  const widened = await owner.post(`/console/api/lessons/${res.json.lesson.id}`, { channelId: null });
  assert.equal(widened.json.lesson.channelId, null, "เจ้าของขยายเป็นทุกช่องทางได้");
});

/* ------------------------------- แผงทำไมตอบแบบนี้ ------------------------------- */

test("แผงทำไมตอบแบบนี้: บอกบทเรียนที่เทิร์นนั้นใช้จริง + ที่สอนจากข้อความนี้ + หัวข้อที่เดาให้", async (t) => {
  const { app, db, aiReply } = await boot(t);
  const owner = client(app.server, await login(app.server, "ngoung"));
  const staff = client(app.server, await login(app.server, "chompoo"));
  const before = await owner.get(`/console/api/teach/why?messageId=${aiReply}`);
  assert.equal(before.status, 200, before.text);
  assert.equal(before.json.why.messageId, aiReply, "ส่วนเดิมของแผงต้องอยู่ครบ");
  assert.deepEqual(before.json.lessons.used, []);
  assert.equal(before.json.lessons.canTeach, true);
  assert.equal(before.json.lessons.canApprove, true);
  assert.equal(before.json.lessons.teachable, true);
  assert.equal(before.json.lessons.suggestedTopic, "มีที่จอดรถไหม",
    "หัวข้อที่เดาให้คือวลีคำถามล่าสุดของลูกค้า — ไม่พ่วงเบอร์/ส่วนที่ถูกลบข้อมูลระบุตัว");
  assert.deepEqual(before.json.lessons.limits, { teaching: 600, topic: 60 });

  const saved = (await teach(owner, aiReply, "จอดได้ที่อาคารเรียน", "ที่จอดรถ")).json.lesson;
  const gone = (await teach(owner, aiReply, "ลบทีหลัง", "จะถูกลบ")).json.lesson;
  // pipeline จดบทเรียนที่ใช้ไว้ใน metadata ตอนส่งสำเร็จ — จำลองแถวแบบเดียวกัน
  const used = db.insertMessage({
    customerId: CUSTOMER, direction: "out", content: "จอดที่อาคารเรียนได้เลยค่ะ", agentMode: "ai",
    metadata: { ownerLessons: [saved.id, gone.id] },
  });
  await owner.del(`/console/api/lessons/${gone.id}`);
  const after = await staff.get(`/console/api/teach/why?messageId=${used}`);
  assert.deepEqual(after.json.lessons.used, [
    { id: saved.id, title: "ที่จอดรถ", status: "active", missing: false },
    { id: gone.id, title: "", status: "deleted", missing: true },
  ], "บทเรียนที่ถูกลบไปแล้วต้องบอกตรง ๆ ว่าลบแล้ว ไม่ใช่หายเงียบ");
  assert.equal(after.json.lessons.canApprove, false);
  const source = await owner.get(`/console/api/teach/why?messageId=${aiReply}`);
  assert.deepEqual(source.json.lessons.taughtHere.map((row) => row.id), [saved.id]);
  assert.equal(source.json.lessons.taughtHere[0].teaching, "จอดได้ที่อาคารเรียน");
});

/* ------------------------------ สิทธิ์ให้ลืม (PDPA) ------------------------------ */

for (const forget of [true, false]) {
  test(`สิทธิ์ให้ลืม (forget=${forget}): คำลูกค้า/คำตอบเดิม/ตัวชี้ห้องหาย แต่คำสอนอยู่ต่อ`, async (t) => {
    const { app, db, aiReply } = await boot(t);
    const owner = client(app.server, await login(app.server, "ngoung"));
    const lesson = (await teach(owner, aiReply, "บอกว่าจอดได้ที่อาคารเรียน")).json.lesson;
    db.upsertCustomer("U-lesson-neighbour", { displayName: "ลูกค้าคนอื่น" });
    db.insertMessage({ customerId: "U-lesson-neighbour", direction: "in", content: "ขอรอบเรียนค่ะ" });
    const neighbourReply = db.insertMessage({ customerId: "U-lesson-neighbour", direction: "out", content: "มีรอบเดือนหน้าค่ะ", agentMode: "ai" });
    const neighbourLesson = (await teach(owner, neighbourReply, "บอกรอบเรียนตามตาราง")).json.lesson;

    db.resetCustomer(CUSTOMER, { forget });
    const kept = db.getOwnerLesson(lesson.id);
    assert.equal(kept.teaching, "บอกว่าจอดได้ที่อาคารเรียน", "คำสอนเป็นของธุรกิจ อยู่ต่อ");
    assert.equal(kept.status, "active", "ลูกแพรยังใช้บทเรียนนี้ต่อได้");
    for (const column of ["customer_text", "ai_text", "customer_id", "source_message_id"]) {
      assert.equal(kept[column], "", `${column} ต้องถูกล้าง`);
    }
    const neighbour = db.getOwnerLesson(neighbourLesson.id);
    assert.equal(neighbour.customer_id, "U-lesson-neighbour", "บทเรียนจากลูกค้าคนอื่นห้ามโดนหางเลข");
    assert.match(neighbour.customer_text, /ขอรอบเรียน/u);
    const listed = await owner.get("/console/api/lessons");
    assert.ok(!listed.text.includes(CUSTOMER), "รายการบทเรียนต้องไม่เหลือ id ของคนที่ถูกลืม");
  });
}
