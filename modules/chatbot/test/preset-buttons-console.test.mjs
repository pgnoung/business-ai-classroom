// preset-buttons-console.test.mjs — รายการปุ่มคำถามสำเร็จรูปแก้ได้จากคอนโซล ด้วยด่านเดียวกับคีย์เวิร์ด #
//
// 2026-09-04: เจ้าของต้องแก้รายการวลีปุ่มเองได้เมื่อเพจ/rich menu เปลี่ยนปุ่ม (แก้ฝั่งแอดยาก แก้ฝั่งเรา
// ต้องง่าย) — อยู่บนเส้น /settings/hashtag เส้นเดียวกับคีย์เวิร์ด # เพราะเป็นของประเภทเดียวกัน
// (ข้อความที่ไม่ได้ออกมาจากนิ้วลูกค้า) จึงได้สิทธิ์ rules.manage · คิวขออนุมัติ · CSRF · audit ชุดเดิม
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { PRESET_BUTTON_DEFAULTS, PRESET_BUTTON_PHRASES_KEY, presetButtonPhrases } from "../src/presetButtons.mjs";
import { hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const PASSWORD = "correct-horse-battery-staple";
const SECRET = "test-console-session-secret-0123456789";

async function boot(t) {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chompoo", passHash: hashPassword(PASSWORD), displayName: "ชมพู่", role: "operator" });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: SECRET }), db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

const post = (server, path, body, headers = {}) => httpRequest(server, {
  method: "POST", path, headers: { "content-type": "application/json", ...headers },
  body: body === undefined ? null : JSON.stringify(body),
});
const get = (server, path, cookie) => httpRequest(server, { path, headers: { cookie } });

async function login(server, username) {
  const res = await post(server, "/console/api/login", { username, password: PASSWORD });
  assert.equal(res.status, 200, `ล็อกอิน ${username} ต้องผ่านก่อน — ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: res.json.csrf };
}
const auth = (s) => ({ cookie: s.cookie, "x-csrf-token": s.csrf });
const PATH = "/console/api/settings/hashtag";

test("GET: ทุกบทบาทเห็นรายการปุ่มที่ใช้อยู่ ค่ามาตรฐาน และรู้ว่าตั้งเองหรือยัง", async (t) => {
  const { app } = await boot(t);
  const staff = await login(app.server, "chompoo");
  const res = await get(app.server, PATH, staff.cookie);
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.presetButtons, [...PRESET_BUTTON_DEFAULTS]);
  assert.deepEqual(res.json.presetButtonDefaults, [...PRESET_BUTTON_DEFAULTS]);
  assert.equal(res.json.presetButtonsConfigured, false);
  assert.ok(Number(res.json.presetButtonMax) > 0);
});

test("เจ้าของบันทึกรายการได้ทันที: ทำสะอาด · เก็บลง settings · audit หนึ่งแถว · ไปป์ไลน์อ่านค่าใหม่", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const res = await post(app.server, PATH, {
    presetButtons: [" จองคิว ได้ไหม ", "คิดค่าบริการเท่าไหร่?", "คิดค่าบริการเท่าไหร่", 42, ""],
  }, auth(owner));
  assert.equal(res.status, 200, res.text);
  assert.deepEqual(res.json.presetButtons, ["จองคิว ได้ไหม", "คิดค่าบริการเท่าไหร่"]);
  assert.equal(res.json.presetButtonsConfigured, true);
  assert.deepEqual(JSON.parse(db.getSetting(PRESET_BUTTON_PHRASES_KEY)), ["จองคิว ได้ไหม", "คิดค่าบริการเท่าไหร่"]);
  assert.deepEqual(presetButtonPhrases({ db }), ["จองคิว ได้ไหม", "คิดค่าบริการเท่าไหร่"], "ตัวอ่านของไปป์ไลน์เห็นค่าเดียวกัน");
  const audits = db.listAudit(50).filter((row) => row.action === "preset_buttons_update");
  assert.equal(audits.length, 1, "การเปลี่ยนรายการต้องมี audit หนึ่งแถว");
  assert.equal(audits[0].operator, "ngoung");
  assert.match(String(audits[0].detail), /จองคิว ได้ไหม \| คิดค่าบริการเท่าไหร่/u);
  // สวิตช์ # และคีย์เวิร์ดธุรกิจต้องไม่ถูกแตะเพราะส่งมาแค่ presetButtons
  assert.equal(db.getSetting("hashtag_silence"), null);
  assert.equal(db.getSetting("hashtag_business_keywords"), null);

  // null = กลับไปใช้ค่ามาตรฐาน (ตัวอ่านถือว่าไม่มีแถว)
  const reset = await post(app.server, PATH, { presetButtons: null }, auth(owner));
  assert.equal(reset.status, 200, reset.text);
  assert.deepEqual(reset.json.presetButtons, [...PRESET_BUTTON_DEFAULTS]);
  assert.equal(reset.json.presetButtonsConfigured, false);
  assert.deepEqual(presetButtonPhrases({ db }), [...PRESET_BUTTON_DEFAULTS]);
  assert.equal(db.listAudit(50).filter((row) => row.action === "preset_buttons_update").length, 2);

  // [] ที่ตั้งใจ = ปิดการจับปุ่ม (ไม่ใช่ค่ามาตรฐาน)
  const off = await post(app.server, PATH, { presetButtons: [] }, auth(owner));
  assert.equal(off.status, 200, off.text);
  assert.deepEqual(off.json.presetButtons, []);
  assert.deepEqual(presetButtonPhrases({ db }), []);
});

test("ทีมงานที่ไม่มี rules.manage: คำขอเข้าคิว (202) และรายการจริงไม่ขยับ · ไม่มี CSRF = 403", async (t) => {
  const { app, db } = await boot(t);
  const staff = await login(app.server, "chompoo");
  const queued = await post(app.server, PATH, { presetButtons: ["สนใจคลาสสอนสด"] }, auth(staff));
  assert.equal(queued.status, 202, `ต้องเข้าคิวรออนุมัติ — ได้ ${queued.status} ${queued.text}`);
  assert.equal(queued.json?.queued, true);
  assert.equal(db.getSetting(PRESET_BUTTON_PHRASES_KEY), null, "รายการต้องไม่ถูกเขียนจากคนที่ไม่มีสิทธิ์");
  assert.equal(db.listAudit(50).filter((row) => row.action === "preset_buttons_update").length, 0);

  const noCsrf = await post(app.server, PATH, { presetButtons: ["x"] }, { cookie: staff.cookie });
  assert.equal(noCsrf.status, 403, noCsrf.text);
  assert.equal(db.countPendingPublishRequests(), 1, "คำขอที่ไม่ผ่าน CSRF ต้องไม่ถูกเก็บเพิ่ม");
});

test("ค่าที่ไม่ใช่รายการ = 400 และไม่เขียนอะไร", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  for (const bad of ["คิดค่าบริการเท่าไหร่", 7, { a: 1 }, true]) {
    const res = await post(app.server, PATH, { presetButtons: bad }, auth(owner));
    assert.equal(res.status, 400, `${JSON.stringify(bad)} ต้องถูกปฏิเสธ — ได้ ${res.status} ${res.text}`);
  }
  assert.equal(db.getSetting(PRESET_BUTTON_PHRASES_KEY), null);
  // ส่งมาแต่ presetButtons อย่างเดียวถือว่าครบ (ไม่ต้องมี enabled/businessKeywords)
  const ok = await post(app.server, PATH, { presetButtons: ["สนใจคลาสสอนสด"] }, auth(owner));
  assert.equal(ok.status, 200, ok.text);
  // body ว่างเปล่ายัง 400 เหมือนเดิม
  const empty = await post(app.server, PATH, {}, auth(owner));
  assert.equal(empty.status, 400);
});
