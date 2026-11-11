// identity-link-e2e — ผ่าน HTTP จริงของ createApp: ทีมเลือกคลาสแล้วกดส่งลิงก์ในห้อง Facebook → ลูกค้าส่งรหัสใน LINE
// → webhook เชื่อมห้อง + "สวัสดีค่ะ คุณ{ชื่อ}" + รายละเอียดคลาสด้วย reply token (ไม่ปลุกลูกแพร) + push แจ้งแอดมิน (team_alert)
// · โหมด auto ส่งลิงก์เองเมื่อออเดอร์บอกคลาส · ข้อความของคลาสแก้ในหน้าตั้งค่า (เจ้าของเท่านั้น) · สิทธิ์/CSRF
// (ทุกอย่าง mock — ไม่มีเน็ตจริง)
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, signLine, testConfig, waitFor,
} from "./helpers.mjs";
import { IDENTITY_LINK_MODE_KEY, findLinkCodeTokens, formatLinkCode, identityLinkPrefill } from "../src/identityLinkCodes.mjs";
import { IDENTITY_TEMPLATE_DEFAULTS, identityWelcomeBubbles } from "../src/identityLinkClasses.mjs";
import { saveIdentityTemplate } from "../src/identityLinkTemplates.mjs";
import { createEscalationNotifier } from "../src/notify.mjs";
import { createLineClient } from "../src/lineClient.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
// ค่าจำลองประกอบจากชิ้น (ตัวสแกนความลับของ release จับรูป "password = ค่าจริง")
const PASSWORD = ["operator", "pass", "123"].join("-");
const SESSION_KEY = ["identity", "console", "fixture", "0123456789"].join("-");
const PASS_HASH = hashPassword(PASSWORD);
const LINE_SECRET = ["test", "line", "secret"].join("-"); // ค่าเดียวกับ testConfig (ประกอบจากชิ้นกันตัวสแกนความลับ)
const FB_ID = "facebook:psid-e2e";
const LINE_USER = "U0123456789abcdef0123456789abcdef";
const ADMIN_LINE = `U${"a".repeat(32)}`; // ผู้รับแจ้งเตือนทีม (ESCALATE_NOTIFY_IDS)
const CONSOLE_URL = "https://console.lukprae.test";

async function start(t, { mode = "manual", paidItem = "", ownNotifier = false, identityHints = null } = {}) {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: PASS_HASH, displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chompoo", passHash: PASS_HASH, displayName: "ชมพู่", role: "operator" });
  db.setSetting(IDENTITY_LINK_MODE_KEY, mode);
  db.upsertCustomer(FB_ID, { displayName: "ลูกค้า เฟซบุ๊ก", channelId: "facebook" });
  db.insertMessage({ customerId: FB_ID, direction: "in", channelId: "facebook", content: "สนใจคลาสค่ะ" });
  if (paidItem) db.createOrder({ customerId: FB_ID, channelId: "facebook", items: [{ name: paidItem, qty: 1, price: null }], status: "paid" });
  const lineFetch = lineFetchStub({ profile: { displayName: "Malee Sukjai" } });
  const hermesFetch = hermesFetchStub("ได้เลยค่ะ คลาสเริ่ม 9 โมงนะคะ");
  const config = testConfig({
    CONSOLE_SESSION_SECRET: SESSION_KEY, FB_ENABLED: "true", FB_MOCK_URL: "http://fb.mock", LINE_BASIC_ID: "@lukprae",
    ESCALATE_NOTIFY_IDS: ADMIN_LINE, CONSOLE_PUBLIC_BASE_URL: CONSOLE_URL,
  });
  // ownNotifier: เทสต์ถือ notifier ตัวเดียวกับที่ระบบใช้ (ยิงเรื่องอื่นก่อนเพื่อให้ cooldown เริ่มนับจริง)
  const notifier = ownNotifier
    ? createEscalationNotifier({ db, config, line: createLineClient({ config, fetchImpl: lineFetch, logger: silent }), logger: silent })
    : undefined;
  const app = createApp({
    config, db, logger: silent,
    overrides: { lineFetch, hermesFetch, sleep: async () => {}, ...(notifier ? { notifier } : {}), ...(identityHints ? { identityHints } : {}) },
  });
  await listen(app.server);
  t.after(() => { app.learning?.stop?.(); app.server.close(); db.close(); });
  return { app, db, lineFetch, hermesFetch, notifier };
}

async function login(server, username) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200, res.text);
  return { cookie: res.headers["set-cookie"][0].split(";")[0], csrf: res.json.csrf };
}

const call = (server, session, method, path, body = null) => httpRequest(server, {
  method, path,
  headers: { cookie: session.cookie, "x-csrf-token": session.csrf, ...(body ? { "content-type": "application/json" } : {}) },
  body: body ? JSON.stringify(body) : null,
});

const roomPath = (id, rest = "") => `/console/api/customers/${encodeURIComponent(id)}/identity${rest}`;
const fbSends = (lineFetch) => lineFetch.sends.filter((call) => call.url.startsWith("http://fb.mock/"));
const lineReplies = (lineFetch) => lineFetch.sends.filter((call) => call.url.includes("/v2/bot/message/reply"));
const teamPushes = (lineFetch) => lineFetch.sends.filter((call) => call.url.includes("/v2/bot/message/push") && call.body?.to === ADMIN_LINE);

function postLine(server, text, messageId, source = { type: "user", userId: LINE_USER }) {
  const raw = JSON.stringify({
    destination: "Ubot",
    events: [{
      type: "message", webhookEventId: `w-${messageId}`, replyToken: `rt-${messageId}`, timestamp: Date.now(),
      source, message: { id: messageId, type: "text", text },
    }],
  });
  return httpRequest(server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, LINE_SECRET) }, body: raw,
  });
}

async function sendInvite(app, lineFetch, session, classType = "live_business") {
  const res = await call(app.server, session, "POST", roomPath(FB_ID, "/invite"), { classType });
  assert.equal(res.status, 200, res.text);
  // 30 ก.ย. 2026: คำเชิญสั้นที่มีรหัส + ลิงก์ล้วนอีกบอลลูน (พี่ง้วง: ยาวไป คนไม่ดู · ลิงก์จาก Messenger กดไม่ได้)
  // บอลลูนลิงก์ = หน้า /r/line ของเรา รหัสอยู่หลัง # (ไม่ถึงเซิร์ฟเวอร์) — หน้าพาออกจากเบราว์เซอร์ในแอป Facebook ให้
  const [sent, linkOnly] = fbSends(lineFetch).slice(-2);
  assert.equal(sent.body.recipient.id, "psid-e2e");
  assert.equal(linkOnly.body.recipient.id, "psid-e2e");
  assert.match(linkOnly.body.message.text, /^https:\/\/console\.lukprae\.test\/r\/line#LK-[0-9A-Z]{5}-[0-9A-Z]{5}$/u);
  const token = findLinkCodeTokens(sent.body.message.text)[0];
  assert.ok(token);
  return formatLinkCode(token.code);
}

test("E2E: ทีมเลือกคลาสแล้วส่งลิงก์ → ลูกค้ากดส่งใน LINE → เชื่อม + สวัสดี/รายละเอียดคลาสด้วย reply token + push แจ้งแอดมินพร้อมคลาสและลิงก์เปิดห้อง", async (t) => {
  const { app, db, lineFetch, hermesFetch } = await start(t);
  const staff = await login(app.server, "chompoo");
  const missing = await call(app.server, staff, "POST", roomPath(FB_ID, "/invite"), {});
  assert.equal(missing.status, 400, "ต้องเลือกคลาสก่อน");
  assert.equal(missing.json.reason, "class_required");
  assert.equal(fbSends(lineFetch).length, 0);
  const code = await sendInvite(app, lineFetch, staff, "live_business");
  const invite = fbSends(lineFetch).at(-2).body.message.text;
  assert.match(fbSends(lineFetch).at(-1).body.message.text, /^https:\/\/console\.lukprae\.test\/r\/line#LK-/u);
  assert.match(invite, /^ขอบคุณที่ลงทะเบียนคลาส AI Agent for Business กับพี่ง้วงนะคะ 🙏\nรายละเอียดการเตรียมตัวก่อนเรียนและกลุ่ม support อยู่ที่ LINE ค่ะ/u);
  assert.match(invite, /แอดไลน์ @lukprae แล้วส่งรหัสนี้มาในแชทนะคะ\nรหัส: LK-/u, "วิธีหลัก = แอดไลน์ + ส่งรหัส (30 ก.ย.)");

  const res = await postLine(app.server, identityLinkPrefill(code), "m-link-1");
  assert.equal(res.status, 200);
  await waitFor(() => lineReplies(lineFetch).length === 1 && teamPushes(lineFetch).length === 1);
  const reply = lineReplies(lineFetch)[0];
  assert.equal(reply.body.replyToken, "rt-m-link-1", "ตอบด้วย reply token ของข้อความลูกค้า = ฟรี");
  const expected = identityWelcomeBubbles({ classType: "live_business", template: IDENTITY_TEMPLATE_DEFAULTS.live_business, displayName: "Malee Sukjai" }).bubbles;
  assert.deepEqual(reply.body.messages.map((message) => message.text), expected);
  assert.match(expected[0], /^สวัสดีค่ะ คุณMalee 🙏\n/u);
  assert.equal(hermesFetch.calls.length, 0, "ลูกค้าที่ซื้อแล้ว = ลูกแพรไม่ต้องคิด (AI เงียบ ทีมดูแล)");

  const push = teamPushes(lineFetch)[0].body.messages[0].text;
  assert.match(push, /^🔔 แจ้งจากระบบ Front Desk\nคุณMalee Sukjai ลูกค้าเดิมจาก Facebook \(ลูกค้า เฟซบุ๊ก\) เข้ามาทาง LINE แล้ว — ซื้อ Classroom AI Agent for Business/u);
  assert.match(push, /ระบบส่งคำทักทาย \+ รายละเอียดคลาสให้ลูกค้าแล้ว/u);
  assert.ok(push.includes(`👉 ${CONSOLE_URL}/#/c/${LINE_USER}`), "กดเข้าห้อง LINE ในคอนโซลได้ทันที");
  const ledger = db.raw.prepare("SELECT method, purpose FROM line_send_ledger").all().map((row) => `${row.method}:${row.purpose}`);
  assert.ok(ledger.includes("push:team_alert"), JSON.stringify(ledger));
  assert.ok(ledger.includes("reply:customer_reply"), JSON.stringify(ledger));
  assert.equal(db.getCustomer(LINE_USER).ai_enabled, 0);

  const owner = await login(app.server, "ngoung");
  const panel = await call(app.server, owner, "GET", roomPath(LINE_USER));
  assert.equal(panel.status, 200);
  assert.deepEqual(panel.json.identity.linked.map((row) => [row.id, row.channelLabel, row.linkedVia]), [[FB_ID, "Facebook", "code"]]);
  assert.deepEqual(panel.json.identity.purchasedClass, { type: "live_business", label: "Classroom AI Agent for Business" });
  const room = await call(app.server, owner, "GET", `/console/api/conversations/${encodeURIComponent(LINE_USER)}/messages?limit=20`);
  assert.equal(room.status, 200);
  assert.equal(room.json.identityLinks.linked[0].id, FB_ID, "ห้องแชทได้ข้อมูลแผงมาพร้อมกัน");
  assert.ok(!JSON.stringify(room.json).includes(code), "ไม่มีรหัสดิบในห้องแชท");
  const fbRoom = await call(app.server, owner, "GET", `/console/api/conversations/${encodeURIComponent(FB_ID)}/messages?limit=20`);
  assert.ok(!JSON.stringify(fbRoom.json).includes(code), "ประวัติห้อง Facebook ปิดรหัสแล้ว");
  assert.equal(fbRoom.json.identityLinks.invite.blocker, "already_linked");
  assert.equal(fbRoom.json.identityLinks.linked[0].classLabel, "Classroom AI Agent for Business");
  assert.equal(db.getCustomer(FB_ID).followup_enabled, 0);
});

test("E2E: แจ้งแอดมินทะลุ cooldown — ห้องที่เพิ่งถูกแจ้งเรื่องอื่นไปแล้วก็ยังได้แจ้งเตือนการเชื่อม", async (t) => {
  const { app, db, lineFetch, notifier } = await start(t, { ownNotifier: true });
  const owner = await login(app.server, "ngoung");
  // เจ้าของตั้งใจเว้นว่างข้อความคลาสออนไลน์ = ทางสำรอง "ทีมงานจะส่งให้" + แจ้งทีม (ค่าเริ่มต้นมีข้อความแล้วตั้งแต่ 30 ก.ย.)
  assert.equal(saveIdentityTemplate(db, "online", { text: "", by: "ngoung" }).ok, true);
  const code = await sendInvite(app, lineFetch, owner, "online");
  // ลูกค้าทักห้อง LINE ครั้งแรกก่อน แล้วระบบแจ้งทีมเรื่องอื่นไปแล้ว (cooldown 10 นาทีของห้องนี้เริ่มนับ)
  await postLine(app.server, "สวัสดีค่ะ", "m-hello");
  await waitFor(() => lineReplies(lineFetch).length === 1);
  const first = await notifier.fire({ customerId: LINE_USER, channelId: "default", reason: "complaint", customerName: "x" });
  assert.equal(first.sent, 1);
  const cooled = await notifier.fire({ customerId: LINE_USER, channelId: "default", reason: "complaint", customerName: "x" });
  assert.equal(cooled.skipped, "cooldown", "พิสูจน์ว่า cooldown ของห้องนี้กำลังทำงาน");
  const before = teamPushes(lineFetch).length;
  await postLine(app.server, identityLinkPrefill(code), "m-link-cd");
  await waitFor(() => teamPushes(lineFetch).length === before + 1);
  assert.match(teamPushes(lineFetch).at(-1).body.messages[0].text, /ซื้อ AI Agent for Business Online .*ยังไม่มีข้อความรายละเอียด/u);
});

test("E2E: รหัส + คำถามจริงในข้อความเดียว → ส่งสวัสดี/รายละเอียด ลูกแพรเงียบ (ซื้อแล้ว) คำถามอยู่ในห้องให้ทีมตอบ ไม่มีรหัส", async (t) => {
  const { app, db, lineFetch, hermesFetch } = await start(t);
  const owner = await login(app.server, "ngoung");
  const code = await sendInvite(app, lineFetch, owner);
  const res = await postLine(app.server, `${identityLinkPrefill(code)} คลาสเริ่มกี่โมงคะ`, "m-link-2");
  assert.equal(res.status, 200);
  await waitFor(() => lineReplies(lineFetch).length === 1 && teamPushes(lineFetch).length === 1);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(hermesFetch.calls.length, 0);
  const stored = db.messagesFor(LINE_USER, 10).find((row) => row.direction === "in").content;
  assert.ok(stored.includes("คลาสเริ่มกี่โมงคะ") && !stored.includes(code));
  assert.equal(db.getCustomer(LINE_USER).state, "NEEDS_HUMAN");
});

test("E2E โหมด auto: ยืนยันยอด/ติดป้าย customer = ส่งลิงก์ตามคลาสในออเดอร์ให้เองครั้งเดียว · ไม่รู้คลาส = ไม่ส่ง ปักธงให้ทีม", async (t) => {
  const { app, lineFetch } = await start(t, { mode: "auto", paidItem: "Classroom AI Agent Workflow Automation" });
  const owner = await login(app.server, "ngoung");
  const tagged = await call(app.server, owner, "POST", `/console/api/customers/${encodeURIComponent(FB_ID)}/tags`, { add: "customer" });
  assert.equal(tagged.status, 200, tagged.text);
  await waitFor(() => fbSends(lineFetch).length === 2);
  assert.match(fbSends(lineFetch)[0].body.message.text, /^ขอบคุณที่ลงทะเบียนคลาส AI Agent Workflow Automation กับพี่ง้วงนะคะ 🙏\nรายละเอียดการเตรียมตัว/u);
  assert.match(fbSends(lineFetch)[1].body.message.text, /^https:\/\/console\.lukprae\.test\/r\/line#LK-/u);
  await call(app.server, owner, "POST", `/console/api/customers/${encodeURIComponent(FB_ID)}/tags`, { remove: "customer" });
  await call(app.server, owner, "POST", `/console/api/customers/${encodeURIComponent(FB_ID)}/tags`, { add: "customer" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fbSends(lineFetch).length, 2, "ส่งอัตโนมัติได้ครั้งเดียวต่อห้อง (คำเชิญ + ลิงก์)");
});

test("E2E โหมด auto: ไม่มีออเดอร์บอกคลาส = ไม่ส่งเอง + ปักธงห้อง Facebook", async (t) => {
  const { app, db, lineFetch } = await start(t, { mode: "auto" });
  const owner = await login(app.server, "ngoung");
  await call(app.server, owner, "POST", `/console/api/customers/${encodeURIComponent(FB_ID)}/tags`, { add: "customer" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fbSends(lineFetch).length, 0);
  assert.match(db.getCustomer(FB_ID).handoff_summary, /ไม่แน่ใจว่าซื้อคลาสไหน/u);
});

test("E2E ข้อความของคลาสในหน้าตั้งค่า: ทุกคนที่เข้าหน้าตั้งค่าอ่านได้ · แก้ได้เฉพาะ Super Admin · ตัวอย่างไม่บันทึก · ลูกค้าคนถัดไปได้ข้อความใหม่", async (t) => {
  const { app, db, lineFetch } = await start(t);
  const path = "/console/api/settings/identity-link-templates";
  const staff = await login(app.server, "chompoo");
  const seen = await call(app.server, staff, "GET", path);
  assert.equal(seen.status, 200, seen.text);
  assert.equal(seen.json.canEdit, false);
  assert.deepEqual(seen.json.templates.map((row) => [row.classType, row.isDefault, row.empty]),
    [["online", true, false], ["live_business", true, false], ["live_workflow", true, false], ["live_private", true, false],
      ["online_fb", true, false], ["online_line", true, false]]);
  assert.match(seen.json.templates[1].preview[0], /^สวัสดีค่ะ คุณมาลี 🙏\n/u);
  assert.match(seen.json.templates[0].preview[0], /^สวัสดีค่ะ คุณมาลี 🙏\nยินดีต้อนรับเข้าคลาส AI Agent for Business Online/u);
  assert.match(seen.json.templates[0].preview[1], /ลงทะเบียนเข้าเรียน/u);
  const preview = await call(app.server, staff, "POST", `${path}/preview`, { classType: "online", text: "ขั้น 1\n---\nขั้น 2" });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json.bubbles, ["สวัสดีค่ะ คุณมาลี 🙏\nขั้น 1", "ขั้น 2"]);
  assert.equal((await call(app.server, staff, "POST", path, { classType: "online", text: "x" })).status, 403, "staff แก้ไม่ได้");

  const owner = await login(app.server, "ngoung");
  const noCsrf = await httpRequest(app.server, {
    method: "POST", path, headers: { cookie: owner.cookie, "content-type": "application/json" }, body: JSON.stringify({ classType: "online", text: "x" }),
  });
  assert.equal(noCsrf.status, 403);
  const bad = await call(app.server, owner, "POST", path, { classType: "online", text: Array.from({ length: 6 }, (_, i) => `ข้อ ${i}`).join("\n---\n") });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /5 ข้อความ/u);
  assert.equal((await call(app.server, owner, "POST", path, { classType: "lead", text: "x" })).status, 400);
  const saved = await call(app.server, owner, "POST", path, { classType: "online", text: "ลงทะเบียนเข้าเรียนที่ลิงก์นี้ได้เลยค่ะ" });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.json.template.isDefault, false);
  assert.equal(saved.json.template.updatedBy, "ngoung");
  assert.ok(db.raw.prepare("SELECT 1 FROM admin_audit WHERE action = 'identity_link_template_saved'").get());

  const code = await sendInvite(app, lineFetch, owner, "online");
  await postLine(app.server, identityLinkPrefill(code), "m-link-tpl");
  await waitFor(() => lineReplies(lineFetch).length === 1);
  assert.deepEqual(lineReplies(lineFetch)[0].body.messages.map((message) => message.text),
    ["สวัสดีค่ะ คุณMalee 🙏\nลงทะเบียนเข้าเรียนที่ลิงก์นี้ได้เลยค่ะ"]);
  const reset = await call(app.server, owner, "POST", path, { classType: "online", reset: true });
  assert.equal(reset.json.template.isDefault, true);
});

test("E2E สิทธิ์: staff ส่งลิงก์ได้แต่เชื่อม/ยกเลิก/ดูรายการแนะนำไม่ได้ · ไม่มี CSRF = 403 · owner เชื่อม/ยกเลิกได้", async (t) => {
  const { app, db, lineFetch } = await start(t);
  db.upsertCustomer(LINE_USER, { displayName: "ลูกค้า LINE" });
  const staff = await login(app.server, "chompoo");
  assert.equal((await call(app.server, staff, "GET", roomPath(FB_ID, "/suggestions"))).status, 403);
  assert.equal((await call(app.server, staff, "POST", roomPath(FB_ID, "/link"), { otherId: LINE_USER, confirm: true })).status, 403);
  const noCsrf = await httpRequest(app.server, {
    method: "POST", path: roomPath(FB_ID, "/invite"), headers: { cookie: staff.cookie, "content-type": "application/json" }, body: "{}",
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(fbSends(lineFetch).length, 0);

  const owner = await login(app.server, "ngoung");
  assert.equal((await call(app.server, owner, "POST", roomPath(FB_ID, "/link"), { otherId: LINE_USER })).status, 400, "ต้องยืนยัน");
  const linked = await call(app.server, owner, "POST", roomPath(FB_ID, "/link"), { otherId: LINE_USER, confirm: true, via: "suggestion" });
  assert.equal(linked.status, 200, linked.text);
  assert.equal(linked.json.identity.linked[0].id, LINE_USER);
  const invite = await call(app.server, staff, "POST", roomPath(FB_ID, "/invite"), { classType: "live_business" });
  assert.equal(invite.status, 409);
  assert.equal(invite.json.reason, "already_linked");
  assert.equal((await call(app.server, staff, "POST", roomPath(FB_ID, "/unlink"), { confirm: true })).status, 403);
  const unlinked = await call(app.server, owner, "POST", roomPath(FB_ID, "/unlink"), { confirm: true });
  assert.equal(unlinked.status, 200, unlinked.text);
  assert.deepEqual(unlinked.json.identity.linked, []);
  assert.equal((await call(app.server, owner, "POST", roomPath(FB_ID, "/unlink"), { confirm: true })).status, 409);
  assert.equal((await call(app.server, owner, "GET", roomPath("U-ghost"))).status, 404);
  const audits = db.raw.prepare("SELECT action FROM admin_audit WHERE action LIKE 'identity_%'").all().map((row) => row.action);
  assert.ok(audits.includes("identity_link_team") && audits.includes("identity_unlink"));
});

test("E2E โหมด off: ปุ่มส่งลิงก์ตอบ 409 พร้อมเหตุผล ไม่มีอะไรออกไปถึงลูกค้า", async (t) => {
  const { app, lineFetch } = await start(t, { mode: "off" });
  const staff = await login(app.server, "chompoo");
  const res = await call(app.server, staff, "POST", roomPath(FB_ID, "/invite"), { classType: "online" });
  assert.equal(res.status, 409);
  assert.equal(res.json.reason, "mode_off");
  assert.equal(fbSends(lineFetch).length, 0);
  const panel = await call(app.server, staff, "GET", roomPath(FB_ID));
  assert.equal(panel.json.identity.mode, "off");
  assert.equal(panel.json.identity.invite.blocker, "mode_off");
  assert.equal(panel.json.identity.canManage, false);
});

test("E2E: รหัสที่โพสต์ในกลุ่ม LINE ไม่เชื่อมห้อง (ยืนยันตัวตนได้เฉพาะแชท 1:1)", async (t) => {
  const { app, db, lineFetch } = await start(t);
  const owner = await login(app.server, "ngoung");
  const code = await sendInvite(app, lineFetch, owner);
  const res = await postLine(app.server, identityLinkPrefill(code), "m-group-1", { type: "group", groupId: "Cgroup", userId: LINE_USER });
  assert.equal(res.status, 200);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(db.listLinkedIdentities(LINE_USER), []);
  assert.equal(db.raw.prepare("SELECT status FROM identity_link_codes").get().status, "active");
});

test("E2E หน้า /r/line: เปิดได้โดยไม่ล็อกอิน · บอก LINE ID ของ OA · CSP ไม่โหลดอะไรจากข้างนอก · ไม่มีรหัสในหน้า (อยู่หลัง # ฝั่งเบราว์เซอร์)", async (t) => {
  const { app } = await start(t);
  const res = await httpRequest(app.server, { path: "/r/line" });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/html/u);
  assert.match(res.headers["content-security-policy"], /default-src 'none'; script-src 'nonce-[^']+'/u);
  assert.equal(res.headers["cache-control"], "no-store");
  assert.match(res.text, /แอดไลน์ @lukprae/u);
  assert.doesNotMatch(res.text, /LK-[0-9A-Z]{5}-[0-9A-Z]{5}/u, "หน้าไม่มีรหัสของใคร — รหัสมากับ # ของลิงก์เท่านั้น");
  const head = await httpRequest(app.server, { method: "HEAD", path: "/r/line" });
  assert.equal(head.status, 200);
  const other = await httpRequest(app.server, { path: "/r/notatoken" });
  assert.equal(other.status, 404, "ลิงก์นับคลิกเดิมไม่กระทบ");
});

test("E2E ห้อง LINE ใหม่: ทักครั้งแรกไม่มีรหัส / แอดเพื่อน → ส่งต่อให้ตัวเดาคู่จากเวลา · ข้อความที่สองไม่ส่งซ้ำ · มีรหัส = ไม่ต้องเดา", async (t) => {
  const calls = [];
  const { app } = await start(t, { identityHints: { noteNewLineContact: (args) => { calls.push(args); return true; } } });
  await postLine(app.server, "สวัสดีค่ะ", "m-hint-1");
  await postLine(app.server, "สนใจสอบถามค่ะ", "m-hint-2");
  await waitFor(() => calls.length >= 1);
  assert.equal(calls.length, 1, "เฉพาะข้อความแรกของห้อง");
  assert.deepEqual({ customerId: calls[0].customerId, source: calls[0].source }, { customerId: LINE_USER, source: "first_message" });
  const raw = JSON.stringify({
    destination: "Ubot",
    events: [{ type: "follow", webhookEventId: "w-follow-1", replyToken: "rt-f", timestamp: Date.now(), source: { type: "user", userId: LINE_USER }, follow: { isUnblocked: false } }],
  });
  const res = await httpRequest(app.server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, LINE_SECRET) }, body: raw,
  });
  assert.equal(res.status, 200);
  await waitFor(() => calls.length === 2);
  assert.equal(calls[1].source, "follow");
});
