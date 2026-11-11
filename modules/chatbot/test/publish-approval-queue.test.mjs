// publish-approval-queue (Package K) — คำสั่งพี่ง้วง 2 ก.ย. 2026:
// "ชมพู่เสนอได้ พี่ง้วงกดอนุมัติ" — ของที่ Package C ทำเป็น 403 เปล่า ๆ ตอนนี้ต้องกลาย
// เป็นคำขอที่ถูกเก็บไว้จริง แล้ววันที่เจ้าของกดอนุมัติ ระบบเล่นคำขอนั้นซ้ำให้เอง
//
// ทำไมต้องยิง HTTP จริงและมีครบสามบทบาท (เหตุผลเดียวกับ owner-only-brain-publishing):
//   1) ปุ่มที่หายไปจากหน้าเว็บไม่ใช่การป้องกัน — เปิด DevTools ยิง fetch เองได้
//   2) helpers.memoryDb() เลื่อนบัญชีแรกเป็น owner อัตโนมัติ เทสต์ที่ไม่เขียน role
//      จึงล็อกอินเป็นเจ้าของทั้งไฟล์และไม่เคยพิสูจน์เรื่องสิทธิ์เลย
//   3) admin ต้องเข้าคิวเท่ากับ staff โดยเจตนา — admin แจกจาก dropdown ได้
//
// สิ่งที่ต้องไม่เพี้ยน: "อนุมัติแล้วของต้องเปลี่ยนจริง" — เทสต์ทุกเส้นอ่านผลจาก DB
// หรือจาก GET เส้นเดิมเสมอ ไม่เคยเชื่อแค่ status 200 ของเส้นอนุมัติ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { REVIEW_ENTRY_TITLE_MATCH } from "../src/reviewCatalogDoc.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {} };
const SECRET = "publish-queue-console-secret-0123456789";
const PASSWORD = "publish-queue-pass-1234";
const DENY = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";
const QUEUED = "ส่งให้พี่ง้วงอนุมัติแล้ว";
const PRICE_MAIN = "%E0%B8%84%E0%B8%AD%E0%B8%A3%E0%B9%8C%E0%B8%AA%E0%B8%AB%E0%B8%A5%E0%B8%B1%E0%B8%81"; // "คอร์สหลัก"

async function boot(t, { notifier = null } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: SECRET });
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "hua", passHash: hashPassword(PASSWORD), displayName: "หัวหน้า", role: "admin" });
  db.createOperator({ username: "chompoo", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  db.setApprovedPrice("คอร์สหลัก", 9900);
  const app = createApp({
    config, db,
    overrides: {
      hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {},
      ...(notifier ? { notifier } : {}),
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
    body: body === undefined ? null : JSON.stringify(body),
  });
}
const post = (server, path, body, headers) => send(server, "POST", path, body, headers);
const put = (server, path, body, headers) => send(server, "PUT", path, body, headers);
const del = (server, path, headers = {}) => httpRequest(server, { method: "DELETE", path, headers });
const get = (server, path, cookie) => httpRequest(server, { path, headers: { cookie } });

async function login(server, username) {
  const res = await post(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, `ล็อกอิน ${username} ต้องผ่านก่อน — ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}
const auth = (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });

function assertQueued(res, where) {
  assert.equal(res.status, 202, `${where} ต้องเข้าคิว (202) — ได้ ${res.status} ${res.text}`);
  assert.equal(res.json?.queued, true, `${where} ต้องบอกว่า queued`);
  assert.equal(res.json?.message, QUEUED, `${where} ต้องตอบข้อความเดียวกันทุกเส้น`);
  assert.ok(res.json?.requestId, `${where} ต้องคืน requestId ให้หน้าเว็บอ้างอิงได้`);
  return res.json.requestId;
}

/* ------------------------ ก. เส้นทางหลัก: เสนอ -> อนุมัติ ------------------------ */

test("ราคา: staff เสนอได้ 202 · ของจริงยังไม่ขยับ · เจ้าของอนุมัติแล้วมีผลจริง", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const queued = await post(app.server, "/console/api/prices", { label: "คอร์สเสริม", amount: 1500 }, auth(staff));
  const requestId = assertQueued(queued, "staff เพิ่มราคา");

  // ข้อสำคัญที่สุด: 202 ต้องแปลว่า "ยังไม่ได้ทำ" — เขียนของลงไปแล้วคือช่องโหว่
  assert.equal(db.getApprovedPrice("คอร์สเสริม"), null, "คำขอที่ยังไม่อนุมัติต้องไม่แตะตารางราคาเลย");
  const row = db.getPublishRequest(requestId);
  assert.equal(row.status, "pending");
  assert.equal(row.kind, "price_add");
  assert.equal(row.proposed_by, "chompoo");
  assert.deepEqual(JSON.parse(row.route_json), ["prices"]);
  assert.deepEqual(JSON.parse(row.body_json), { label: "คอร์สเสริม", amount: 1500 });
  assert.ok(row.summary.includes("คอร์สเสริม"), "หัวข้อคำขอต้องอ่านรู้เรื่องโดยไม่ต้องเปิด JSON");

  // เจ้าของเปิดคิวต้องเห็นคำขอนี้
  const list = await get(app.server, "/console/api/publish-requests?status=pending", owner.cookie);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.json.canApprove, true, "เจ้าของต้องได้ธงว่าอนุมัติได้");
  assert.equal(list.json.pending, 1);
  assert.equal(list.json.requests[0].id, requestId);
  assert.equal(list.json.requests[0].proposedBy, "chompoo");

  const approve = await post(app.server, `/console/api/publish-requests/${requestId}/approve`, {}, auth(owner));
  assert.equal(approve.status, 200, approve.text);
  assert.equal(approve.json.applied, true, `อนุมัติแล้วต้องลงมือทำจริง — ${approve.text}`);
  assert.equal(approve.json.request.status, "approved");

  // อ่านผลจากของจริง ไม่ใช่จาก response ของเส้นอนุมัติ
  assert.equal(db.getApprovedPrice("คอร์สเสริม")?.amount, 1500, "อนุมัติแล้วราคาต้องเข้าตารางจริง");
  const prices = await get(app.server, "/console/api/prices", staff.cookie);
  assert.ok(prices.json.prices.some((p) => p.label === "คอร์สเสริม"), "ทีมงานต้องเห็นราคาใหม่ผ่านเส้นเดิม");

  // audit ต้องมีทั้งตอนเข้าคิวและตอนอนุมัติ — ไม่งั้นไล่ไม่ได้ว่าใครเสนอและใครกด
  const actions = db.listAudit(50).map((a) => a.action);
  assert.ok(actions.includes("publish_request_queued"), "ต้องมี audit ตอนเข้าคิว");
  assert.ok(actions.includes("publish_request_approved"), "ต้องมี audit ตอนอนุมัติ");
  assert.ok(actions.includes("price_add"), "audit ของการทำจริงต้องยังถูกเขียนด้วยชื่อเดิม");
});

test("อนุมัติซ้ำใบเดิมไม่ได้ — กดสองครั้งต้องไม่เขียนของสองรอบ", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const id = assertQueued(
    await post(app.server, `/console/api/prices/${PRICE_MAIN}`, { amount: 8900 }, auth(staff)),
    "staff แก้ยอด",
  );
  assert.equal((await post(app.server, `/console/api/publish-requests/${id}/approve`, {}, auth(owner))).status, 200);
  assert.equal(db.getApprovedPrice("คอร์สหลัก")?.amount, 8900);

  const again = await post(app.server, `/console/api/publish-requests/${id}/approve`, {}, auth(owner));
  assert.equal(again.status, 409, `อนุมัติซ้ำต้องถูกปฏิเสธ — ได้ ${again.status} ${again.text}`);
  assert.equal(db.getPublishRequest(id).status, "approved", "สถานะต้องไม่ถูกเขียนทับจากการกดซ้ำ");
});

test("ปฏิเสธ: บันทึกการตัดสินอย่างเดียว ห้ามแตะของจริง และอนุมัติต่อไม่ได้", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const id = assertQueued(
    await post(app.server, "/console/api/settings/product-rules", { rules: "ห้ามขายซ้ำ" }, auth(staff)),
    "staff เสนอกติกาสินค้า",
  );
  const rejected = await post(app.server, `/console/api/publish-requests/${id}/reject`,
    { note: "ยังไม่ตรงกับที่คุยไว้" }, auth(owner));
  assert.equal(rejected.status, 200, rejected.text);
  assert.equal(rejected.json.applied, false);
  assert.equal(rejected.json.request.status, "rejected");
  assert.equal(rejected.json.request.decisionNote, "ยังไม่ตรงกับที่คุยไว้");
  assert.ok(!db.getSetting("product_rules"), "ปฏิเสธแล้วกติกาต้องไม่ถูกเขียนลงไปเลย");

  const late = await post(app.server, `/console/api/publish-requests/${id}/approve`, {}, auth(owner));
  assert.equal(late.status, 409, "ใบที่ปฏิเสธไปแล้วต้องอนุมัติย้อนหลังไม่ได้");
  assert.ok(db.listAudit(50).some((a) => a.action === "publish_request_rejected"), "ต้องมี audit ตอนปฏิเสธ");
});

/* ---------------------- ข. คลังความรู้ (ของใหม่รอบนี้) ---------------------- */

test("คลังความรู้: staff เพิ่ม/แก้/ลบ เข้าคิวหมด · เจ้าของอนุมัติแล้วเข้าคลังจริง", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const addId = assertQueued(
    await post(app.server, "/console/api/knowledge",
      { title: "โปรเดือนนี้", content: "รายละเอียดโปรโมชั่น" }, auth(staff)),
    "staff เพิ่มความรู้",
  );
  assert.equal(db.listKnowledge().length, 0, "คำขอที่ยังไม่อนุมัติต้องไม่สร้างรายการในคลัง");

  const approve = await post(app.server, `/console/api/publish-requests/${addId}/approve`, {}, auth(owner));
  assert.equal(approve.json.applied, true, approve.text);
  const entry = db.listKnowledge().find((row) => row.title === "โปรเดือนนี้");
  assert.ok(entry, "อนุมัติแล้วความรู้ต้องเข้าคลังจริง");
  assert.equal(entry.updated_by, "ngoung", "ของที่เผยแพร่ต้องบันทึกว่าเจ้าของเป็นคนเผยแพร่");

  // แก้และลบต้องเข้าคิวเหมือนกัน — ไม่ใช่กันแค่ตอนเพิ่ม
  const editId = assertQueued(
    await post(app.server, `/console/api/knowledge/${encodeURIComponent(entry.id)}`,
      { content: "ราคาใหม่" }, auth(staff)),
    "staff แก้ความรู้",
  );
  assert.equal(db.getKnowledge(entry.id).content, "รายละเอียดโปรโมชั่น", "ยังไม่อนุมัติ = เนื้อหาเดิมต้องไม่ขยับ");
  await post(app.server, `/console/api/publish-requests/${editId}/approve`, {}, auth(owner));
  assert.equal(db.getKnowledge(entry.id).content, "ราคาใหม่", "อนุมัติแล้วต้องแก้จริง");

  const delId = assertQueued(
    await del(app.server, `/console/api/knowledge/${encodeURIComponent(entry.id)}`, auth(staff)),
    "staff ลบความรู้",
  );
  assert.ok(db.getKnowledge(entry.id), "ยังไม่อนุมัติ = ห้ามหาย");
  await post(app.server, `/console/api/publish-requests/${delId}/approve`, {}, auth(owner));
  assert.equal(db.getKnowledge(entry.id), null, "อนุมัติแล้วต้องลบจริง");
});

test("คลังความรู้: GET ยังเปิดให้ทีมอ่านครบเหมือนเดิม", async (t) => {
  const { app, db } = await boot(t);
  db.addKnowledge({ title: "คู่มือคลาส", content: "เนื้อหา", updatedBy: "ngoung" });
  const staff = await login(app.server, "chompoo");
  const res = await get(app.server, "/console/api/knowledge", staff.cookie);
  assert.equal(res.status, 200, `ทีมงานต้องยังอ่านคลังความรู้ได้ — ${res.text}`);
  assert.equal(res.json.knowledge.length, 1);
});

/* ------------------- ค. เส้นที่ต้องไม่โดนลูกหลง (ยังเขียนได้) ------------------- */

test("คลังรีวิวกับที่นั่ง: ยังเป็นงานของทีม เขียนได้ตรง ๆ ห้ามเข้าคิว", async (t) => {
  const { app, db } = await boot(t);
  db.addKnowledge({
    title: `${REVIEW_ENTRY_TITLE_MATCH} แยกตามคลาส`,
    content: "วิธีใช้: หยิบรีวิวให้ตรงคลาส\n\n[Classroom : AI Agent For Business]\n- คุณเอ เจ้าของร้าน | รีวิว: https://www.facebook.com/reel/100000000000757\n",
    updatedBy: "ngoung",
  });
  const staff = await login(app.server, "chompoo");

  const write = await put(app.server, "/console/api/reviews", {
    sections: [{
      name: "Classroom : AI Agent For Business",
      items: [{ who: "คุณบี คลินิกความงาม", url: "https://www.facebook.com/share/v/1TstVb02Bb/" }],
    }],
  }, auth(staff));
  assert.equal(write.status, 200, `ฟอร์มรีวิวทำมาให้ชมพู่กรอกเอง ห้ามเข้าคิว — ${write.text}`);
  assert.equal(db.countPendingPublishRequests(), 0, "การกรอกรีวิวต้องไม่สร้างคำขอสักใบ");
  const saved = db.listKnowledge().find((row) => String(row.title).includes(REVIEW_ENTRY_TITLE_MATCH));
  assert.ok(saved.content.includes("คุณบี คลินิกความงาม"), "ต้องเขียนลงคลังจริง ไม่ใช่แค่ตอบ 200");
});

/* --------------------------- ง. ด่านสิทธิ์ของตัวคิวเอง --------------------------- */

test("คิว: staff กับ admin อนุมัติเองไม่ได้ และเห็นเฉพาะคำขอของตัวเอง", async (t) => {
  const { app } = await boot(t);
  const staff = await login(app.server, "chompoo");
  const admin = await login(app.server, "hua");

  const staffId = assertQueued(
    await post(app.server, "/console/api/prices", { label: "ของชมพู่", amount: 100 }, auth(staff)),
    "staff เสนอราคา",
  );
  const adminId = assertQueued(
    await post(app.server, "/console/api/prices", { label: "ของหัวหน้า", amount: 200 }, auth(admin)),
    "admin เสนอราคา (admin ต้องโดนเท่ากับ staff)",
  );

  for (const [who, session] of [["staff", staff], ["admin", admin]]) {
    const denied = await post(app.server, `/console/api/publish-requests/${staffId}/approve`, {}, auth(session));
    assert.equal(denied.status, 403, `${who} ต้องอนุมัติไม่ได้ — ได้ ${denied.status} ${denied.text}`);
    assert.equal(denied.json.error, DENY, `${who} ต้องได้ข้อความปฏิเสธกลาง ๆ ตัวเดียวกัน`);
    const rejected = await post(app.server, `/console/api/publish-requests/${staffId}/reject`, {}, auth(session));
    assert.equal(rejected.status, 403, `${who} ต้องปฏิเสธคำขอไม่ได้เช่นกัน`);
  }

  // เห็นเฉพาะของตัวเอง — คิวของคนอื่นต้องไม่ติดมือไปกับ response แม้แต่ใบเดียว
  const mine = await get(app.server, "/console/api/publish-requests?status=pending", staff.cookie);
  assert.equal(mine.status, 200, mine.text);
  assert.equal(mine.json.canApprove, false);
  assert.deepEqual(mine.json.requests.map((r) => r.id), [staffId], "ทีมงานต้องเห็นเฉพาะคำขอของตัวเอง");
  assert.ok(!mine.text.includes("ของหัวหน้า"), "รายละเอียดคำขอของคนอื่นห้ามหลุดออกไป");
  assert.equal(mine.json.pending, 1, "ตัวเลขค้างของทีมงานต้องนับเฉพาะของตัวเอง");
  assert.ok(adminId, "คำขอของ admin ต้องถูกเก็บไว้จริง (ไว้ให้เจ้าของเห็น)");
});

test("คนนอกระบบยังโดน 401 เหมือนเดิม — คิวไม่ใช่ประตูหลัง", async (t) => {
  const { app, db } = await boot(t);
  for (const [method, path, body] of [
    ["POST", "/console/api/prices", { label: "x", amount: 1 }],
    ["POST", "/console/api/knowledge", { title: "x", content: "y" }],
    ["GET", "/console/api/publish-requests", undefined],
  ]) {
    const res = method === "GET"
      ? await get(app.server, path, "")
      : await send(app.server, method, path, body, {});
    assert.ok([401, 403].includes(res.status), `${method} ${path} ต้องไม่ให้คนไม่ล็อกอินผ่าน — ได้ ${res.status}`);
  }
  assert.equal(db.countPendingPublishRequests(), 0, "คนนอกระบบต้องสร้างคำขอไม่ได้เลยสักใบ");
});

test("ไม่ส่ง CSRF = ส่งคำขอไม่ได้ (คิวก็ยังเป็นการเขียน)", async (t) => {
  const { app, db } = await boot(t);
  const staff = await login(app.server, "chompoo");
  const only = { cookie: staff.cookie }; // จงใจไม่ส่ง x-csrf-token

  for (const [path, body] of [
    ["/console/api/prices", { label: "x", amount: 1 }],
    ["/console/api/settings/product-rules", { rules: "x" }],
    ["/console/api/knowledge", { title: "x", content: "y" }],
  ]) {
    const res = await post(app.server, path, body, only);
    assert.equal(res.status, 403, `${path} ไม่มี CSRF ต้องไม่ผ่าน — ได้ ${res.status} ${res.text}`);
  }
  assert.equal(db.countPendingPublishRequests(), 0, "คำขอที่ไม่ผ่าน CSRF ต้องไม่ถูกเก็บ");
});

/* ------------------------ จ. เล่นซ้ำแล้วล้ม ต้องไม่พาระบบล้ม ------------------------ */

test("คำขอที่ข้อมูลไม่ผ่านด่านตรวจ: อนุมัติแล้วจบที่ failed พร้อมเหตุผล ไม่โยน error", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  // ด่านตรวจ amount อยู่ "หลัง" ด่านสิทธิ์ คำขอที่ข้อมูลผิดจึงเข้าคิวได้ตามปกติ
  // แล้วไปล้มตอนเล่นซ้ำ — นี่คือเส้นที่ต้องไม่ทำให้เจ้าของเจอ 500
  const badId = assertQueued(
    await post(app.server, "/console/api/prices", { label: "ของพัง", amount: -5 }, auth(staff)),
    "staff เสนอยอดติดลบ",
  );
  const res = await post(app.server, `/console/api/publish-requests/${badId}/approve`, {}, auth(owner));
  assert.equal(res.status, 200, `เล่นซ้ำล้มต้องยังตอบ 200 พร้อมเหตุผล ไม่ใช่ 500 — ${res.text}`);
  assert.equal(res.json.applied, false);
  assert.equal(res.json.request.status, "failed");
  assert.ok(res.json.error, "ต้องบอกเหตุผลว่าทำไมทำไม่ได้");
  assert.equal(db.getApprovedPrice("ของพัง"), null, "คำขอที่ล้มต้องไม่เขียนอะไรลงไปเลย");
  assert.ok(db.getPublishRequest(badId).decision_note, "เหตุผลต้องถูกเก็บไว้ให้ย้อนดูได้");

  // ระบบยังทำงานต่อได้ตามปกติหลังเจอคำขอพัง
  assert.equal((await get(app.server, "/console/api/prices", owner.cookie)).status, 200);
});

test("คำขอที่ปลายทางหายไปแล้ว: จบที่ failed ไม่ใช่เขียนของผิดที่", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");

  const id = assertQueued(
    await post(app.server, `/console/api/prices/${PRICE_MAIN}`, { amount: 7000 }, auth(staff)),
    "staff แก้ยอดคอร์สหลัก",
  );
  // เจ้าของลบรายการนั้นทิ้งก่อนจะกดอนุมัติ
  assert.equal((await del(app.server, `/console/api/prices/${PRICE_MAIN}`, auth(owner))).status, 200);

  const res = await post(app.server, `/console/api/publish-requests/${id}/approve`, {}, auth(owner));
  assert.equal(res.json.applied, false, `ของที่หายไปแล้วต้องอนุมัติไม่สำเร็จ — ${res.text}`);
  assert.equal(res.json.request.status, "failed");
  assert.equal(db.getApprovedPrice("คอร์สหลัก"), null, "ห้ามปั้นรายการที่ถูกลบไปแล้วกลับมา");
});

/* ------------------ ฉ. /console/api/me ต้องประกาศสิทธิ์ให้ตรงด่านจริง ------------------ */

test("/console/api/me: เจ้าของได้ knowledge.publish และ publish.approve · คนอื่นต้องไม่ได้", async (t) => {
  const { app } = await boot(t);
  for (const [username, expected] of [["ngoung", true], ["hua", false], ["chompoo", false]]) {
    const session = await login(app.server, username);
    const me = await get(app.server, "/console/api/me", session.cookie);
    assert.equal(me.status, 200);
    for (const cap of ["knowledge.publish", "publish.approve"]) {
      assert.equal(
        me.json.operator.capabilities.includes(cap), expected,
        `${username} ต้อง${expected ? "" : "ไม่"}มี ${cap} ใน /me (สิทธิ์ที่ประกาศต้องตรงกับด่านจริง)`,
      );
    }
    // knowledge.manage ยังต้องมีครบทุกบทบาท ไม่งั้นเมนู "ความรู้" หายไปจากจอทีมงาน
    assert.ok(me.json.operator.capabilities.includes("knowledge.manage"),
      `${username} ต้องยังเข้าหน้าความรู้ได้ (อ่านอย่างเดียวก็ต้องเข้าได้)`);
  }
});

/* --------------------- ช. เจ้าของต้องถูกปลุก ไม่ใช่บังเอิญเปิดเจอ --------------------- */

// สายไฟเส้นนี้ขาดง่ายและขาดแบบเงียบที่สุด: createSettingsRoutes ไม่เคยรับ notifier มาก่อน
// ถ้าใครลืมส่งต่อ คำขอจะถูกเก็บครบทุกใบ เทสต์อื่นเขียวหมด แต่พี่ง้วงไม่เคยรู้ว่ามีคำขอ
test("มีคำขอใหม่ = ปลุกเจ้าของทาง LINE ทันที (ไม่ใช่รอให้บังเอิญเปิดหน้าตั้งค่า)", async (t) => {
  const fired = [];
  const notifier = { fire: async () => ({ ok: true }), fireLater: (args) => fired.push(args) };
  const { app } = await boot(t, { notifier });
  const staff = await login(app.server, "chompoo");

  assertQueued(
    await post(app.server, "/console/api/prices", { label: "คอร์สเสริม", amount: 1500 }, auth(staff)),
    "staff เสนอราคา",
  );
  assert.equal(fired.length, 1, "คำขอใหม่ต้องยิงแจ้งเตือนหนึ่งครั้ง");
  const [call] = fired;
  assert.equal(call.reason, "publish_request");
  assert.equal(call.customerId, "ops:publish", "เรื่องระบบต้องใช้ ops: เพื่อไม่ให้แนบลิงก์ห้องแชทลูกค้า");
  assert.equal(call.force, true, "คิวยิงนาน ๆ ครั้ง ถ้าโดน cooldown กลืน ใบที่สองจะเงียบหาย");
  assert.ok(call.reasonTextOverride.includes("chompoo"), "ต้องบอกว่าใครเป็นคนขอ");
  assert.ok(call.reasonTextOverride.includes("คอร์สเสริม"), "ต้องบอกว่าขอเปลี่ยนอะไร");
  assert.ok(/รออนุมัติทั้งหมด 1 รายการ/u.test(call.reasonTextOverride), "ต้องบอกจำนวนที่ค้างอยู่");
});

/* ------------- ซ. K2: ผลการตัดสินต้องเดินทางกลับไปถึงคนเสนอ ------------- */

// ช่องโหว่ที่ปิดรอบนี้: ใบที่เล่นซ้ำแล้วล้ม หลุดจาก ?status=pending ทันที คนเสนอเห็นแค่ว่า
// คำขอหายไป ไม่เคยรู้ว่าไม่ผ่านเพราะอะไร แล้วก็ไม่ส่งใหม่ — เหตุผลถูกเก็บไว้ครบตั้งแต่
// Package K แล้ว สิ่งที่ขาดคือเส้นให้หน้าเว็บอ่านมันกลับมา
test("?status=decided: staff เห็นใบที่ล้มของตัวเองพร้อมเหตุผล · ของคนอื่นห้ามติดมือมา", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");
  const admin = await login(app.server, "hua");

  // ก. ใบของชมพู่ที่ข้อมูลไม่ผ่านด่านตรวจ -> อนุมัติแล้วจบที่ failed พร้อมเหตุผล
  const badId = assertQueued(
    await post(app.server, "/console/api/prices", { label: "ของชมพู่พัง", amount: -5 }, auth(staff)),
    "staff เสนอยอดติดลบ",
  );
  const approved = await post(app.server, `/console/api/publish-requests/${badId}/approve`, {}, auth(owner));
  assert.equal(approved.json.request.status, "failed", `ต้องจบที่ failed — ${approved.text}`);

  // ข. ใบของหัวหน้าที่ถูกปฏิเสธ — ต้องไม่โผล่ในรายการของชมพู่เลยสักฟิลด์
  const otherId = assertQueued(
    await post(app.server, "/console/api/prices", { label: "ของหัวหน้า", amount: 200 }, auth(admin)),
    "admin เสนอราคา",
  );
  assert.equal(
    (await post(app.server, `/console/api/publish-requests/${otherId}/reject`,
      { note: "ยังไม่ถึงเวลา" }, auth(owner))).status,
    200,
  );

  // ค. ใบที่ล้มหายไปจากคิวรออนุมัติจริง (นี่คือต้นเหตุที่คนเสนอไม่เคยเห็นผล)
  const pending = await get(app.server, "/console/api/publish-requests?status=pending", staff.cookie);
  assert.deepEqual(pending.json.requests.map((r) => r.id), [], "ใบที่ตัดสินแล้วต้องไม่ค้างในคิวรออนุมัติ");

  const decided = await get(app.server, "/console/api/publish-requests?status=decided", staff.cookie);
  assert.equal(decided.status, 200, decided.text);
  assert.equal(decided.json.canApprove, false, "ทีมงานต้องไม่ได้สิทธิ์อนุมัติมาพร้อมรายการ");
  assert.deepEqual(decided.json.requests.map((r) => r.id), [badId],
    "ทีมงานต้องเห็นเฉพาะผลการตัดสินของคำขอตัวเอง");
  const [mine] = decided.json.requests;
  assert.equal(mine.status, "failed");
  assert.ok(mine.decisionNote, "เหตุผลต้องเดินทางมาถึงหน้าเว็บ ไม่ใช่ค้างอยู่ใน DB");
  assert.ok(mine.decidedAt > 0, "ต้องรู้ว่าตัดสินเมื่อไร ไม่งั้นเรียงใหม่สุดก่อนไม่ได้");
  assert.ok(!decided.text.includes("ของหัวหน้า"), "คำขอของคนอื่นห้ามหลุดออกไปแม้แต่ชื่อ");
  assert.ok(!decided.text.includes("ยังไม่ถึงเวลา"), "เหตุผลที่เจ้าของเขียนถึงคนอื่นก็ห้ามหลุด");
});

test("?status=decided: เจ้าของเห็นผลการตัดสินของทุกคน · since ตัดของนอกหน้าต่างออกจริง", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");
  const admin = await login(app.server, "hua");

  const staffId = assertQueued(
    await post(app.server, "/console/api/prices", { label: "ของชมพู่", amount: 100 }, auth(staff)),
    "staff เสนอราคา",
  );
  const adminId = assertQueued(
    await post(app.server, "/console/api/prices", { label: "ของหัวหน้า", amount: 200 }, auth(admin)),
    "admin เสนอราคา",
  );
  assert.equal((await post(app.server, `/console/api/publish-requests/${staffId}/approve`, {}, auth(owner))).status, 200);
  assert.equal(
    (await post(app.server, `/console/api/publish-requests/${adminId}/reject`, { note: "ราคาไม่ตรงรอบนี้" }, auth(owner))).status,
    200,
  );

  const all = await get(app.server, "/console/api/publish-requests?status=decided", owner.cookie);
  assert.equal(all.status, 200, all.text);
  assert.deepEqual(
    [...all.json.requests].map((r) => r.status).sort(),
    ["approved", "rejected"],
    "เจ้าของต้องเห็นทั้งใบที่อนุมัติและใบที่ปฏิเสธ",
  );
  assert.ok(all.text.includes("ราคาไม่ตรงรอบนี้"), "เหตุผลที่เจ้าของเขียนต้องอ่านย้อนได้");

  // หน้าต่างเวลา: since ในอนาคต = ต้องว่าง (พิสูจน์ว่ากรองด้วยเวลาที่ "ตัดสิน" จริง
  // ไม่ใช่รับ query มาแล้วโยนทิ้ง ซึ่งเทสต์ที่ดูแค่ "ยังคืน 200" จะไม่มีวันจับได้)
  const future = await get(
    app.server, `/console/api/publish-requests?status=decided&since=${Date.now() + 60_000}`, owner.cookie);
  assert.deepEqual(future.json.requests, [], "ของที่ตัดสินก่อนหน้าต่างต้องถูกตัดออก");

  const past = await get(
    app.server, `/console/api/publish-requests?status=decided&since=${Date.now() - 60_000}`, owner.cookie);
  assert.equal(past.json.requests.length, 2, "ของที่เพิ่งตัดสินต้องยังอยู่ในหน้าต่าง 7 วัน");

  // ใบที่ยังรออนุมัติต้องไม่ปนเข้ามาในกองผลการตัดสิน
  assertQueued(
    await post(app.server, "/console/api/prices", { label: "ใบใหม่", amount: 300 }, auth(staff)),
    "staff เสนอเพิ่ม",
  );
  const again = await get(app.server, "/console/api/publish-requests?status=decided", owner.cookie);
  assert.equal(again.json.requests.length, 2, "ใบที่ยัง pending ต้องไม่โผล่ในผลการตัดสิน");
  assert.ok(!again.text.includes("ใบใหม่"), "ใบที่ยังไม่ถูกตัดสินห้ามปนมา");
});

test("status ที่ไม่รู้จักยังโดน 400 เหมือนเดิม — decided ต้องไม่เปิดช่องให้ค่ามั่ว", async (t) => {
  const { app } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const bad = await get(app.server, "/console/api/publish-requests?status=decide", owner.cookie);
  assert.equal(bad.status, 400, `status มั่วต้องไม่ผ่าน — ได้ ${bad.status} ${bad.text}`);
});
