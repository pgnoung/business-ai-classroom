// whitelabel-generic.test.mjs — เอนจินโปรไฟล์ generic ต้องไม่หลุดชื่อแบรนด์ของพี่ง้วง/ลูกแพรสักตัว
//
// ร้านของนักเรียนติดตั้งเอนจินด้วยชื่อแอดมิน AI ของตัวเอง ("น้องมะลิ") — ทุกข้อความที่ถึงลูกค้า ทีม
// คอนโซล และพรอมต์ที่ส่งให้สมอง ห้ามมี ลูกแพร / LuKprae / พี่ง้วง / Pngoung / ติดกระดุม / Airdog / ชื่อคลาส-ราคาคอร์ส
// และชื่อของร้านต้องโผล่ในจุดที่ควรโผล่ · โปรไฟล์ course (ค่าเริ่มต้น) ต้องเหมือนเดิมทุกตัวอักษร
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { createConfig } from "../src/config.mjs";
import { hashPassword } from "../src/auth.mjs";
import { activeBrand, brandText, DEFAULT_BRAND, makeBrand, setActiveBrand } from "../src/brand.mjs";
import {
  HERMES_DOWN_RETRY_TEMPLATE, HERMES_DOWN_TEMPLATE, hashtagBusinessDefaults, looksLikeSelfPromise,
} from "../src/pipeline.mjs";
import { NOTIFY_REASON_TEXT, notifyReasonText, createEscalationNotifier } from "../src/notify.mjs";
import { stagedRules } from "../src/stagedFollowups.mjs";
import { closingStatement } from "../src/handoffClosing.mjs";
import { paymentNudgeText } from "../src/paymentGentleNudge.mjs";
import { scheduleCheckInText } from "../src/scheduleCheckIn.mjs";
import { exportFilename } from "../src/exportCsv.mjs";
import { ownerChatMode } from "../src/ownerChat.mjs";
import { replyEngineMode } from "../src/replyEngineV3/mode.mjs";
import { qualifySweepMode } from "../src/notQualified.mjs";
import { identityLinkMode } from "../src/identityLinkCodes.mjs";
import { naturalVoiceMode } from "../src/writerVoice.mjs";
import { metaCapiMode } from "../src/metaCapi.mjs";
import { adReferralCaptureMode } from "../src/adReferral.mjs";
import { lessonDigestMode } from "../src/telegramLessonDigest.mjs";
import { coachingBrakeMode } from "../src/coachingBrake.mjs";
import { routeMessage } from "../src/safetyRouter.mjs";
import { validateReviewDoc } from "../src/reviewCatalogDoc.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, promptText, testConfig,
} from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, info() {}, debug() {} };

const AGENT = "น้องมะลิ";
const OWNER = "เจ้าของร้าน";
const BUSINESS = "ร้านทดสอบ";
const GENERIC_ENV = Object.freeze({
  BUSINESS_PROFILE: "generic",
  BRAND_AGENT_NAME: AGENT,
  BRAND_OWNER_NAME: OWNER,
  BRAND_BUSINESS_NAME: BUSINESS,
  BUSINESS_ID: "test-shop",
  CONSOLE_BRAND_NAME: BUSINESS,
  CONSOLE_BRAND_THEME: "starter",
});
// ชื่อแบรนด์ของ production + ชื่อ/ราคาคอร์สของพี่ง้วง — ห้ามโผล่ในโปรไฟล์ generic เลย
const FORBIDDEN = /ลูกแพร|LuKprae|Lukprae|พี่ง้วง|Pngoung|pngoung|ติดกระดุม|Airdog|airdog|ชมพู่|AI Agent for Business|Workflow Automation|4,900|12,900/u;

function assertClean(text, where) {
  const value = typeof text === "string" ? text : JSON.stringify(text);
  const hit = value.match(FORBIDDEN);
  assert.equal(hit, null, `${where}: พบ "${hit?.[0]}" ใน ${value.slice(Math.max(0, (hit?.index ?? 0) - 60), (hit?.index ?? 0) + 60)}`);
}

const outbound = (db, id) => db.messagesFor(id).filter((m) => m.direction === "out").map((m) => m.content);

function genericApp(t, { hermesFetch = hermesFetchStub(`สวัสดีค่ะ ${AGENT}ยินดีดูแลค่ะ`), env = {}, notifier = { fireLater() {} } } = {}) {
  const db = memoryDb();
  const line = lineFetchStub();
  const app = createApp({
    db, logger: silent, config: testConfig({ ...GENERIC_ENV, ...env }),
    overrides: { hermesFetch, lineFetch: line, notifier, sleep: async () => {} },
  });
  t.after(() => { try { app.server.close(); } catch { /* ไม่ได้ listen */ } db.close(); setActiveBrand(DEFAULT_BRAND); });
  return { app, db, line };
}

/* ------------------------------- แบรนด์ / config ------------------------------- */

test("whitelabel: ไม่ตั้ง env ใหม่ = แบรนด์เริ่มต้น และ brandText ไม่แตะข้อความเลย", () => {
  const config = createConfig({});
  assert.equal(config.brand.agentName, "ลูกแพร");
  assert.equal(config.brand.profile, "course");
  assert.equal(config.hermesQualifyModel, "gpt-6.1-sol");
  assert.equal(config.ownerChatModel, "gpt-5.6-luna");
  assert.deepEqual(config.consoleBranding, { name: "Front Desk", mark: "FD", agent: "", theme: "airdog" });
  assert.equal(brandText(HERMES_DOWN_TEMPLATE, config.brand), HERMES_DOWN_TEMPLATE);
});

test("whitelabel: BUSINESS_PROFILE ผิดรูป = บูตไม่ขึ้น (ห้ามเงียบกลับเป็น course)", () => {
  assert.throws(() => createConfig({ BUSINESS_PROFILE: "Generic-ish" }), /BUSINESS_PROFILE/u);
});

test("whitelabel: ชื่อที่มีคำต้นทางอยู่ข้างใน (แทนซ้ำแล้วงอก) ถูกปฏิเสธ", () => {
  const brand = makeBrand({ agentName: "น้องลูกแพร", profile: "generic" });
  assert.equal(brand.agentName, "แอดมิน");
  const generic = makeBrand({ agentName: AGENT, ownerName: OWNER, businessName: BUSINESS, profile: "generic" });
  const once = brandText("ลูกแพรขอเช็คกับทีมงานพี่ง้วง (คุณชมพู่)", generic);
  assert.equal(brandText(once, generic), once, "brandText ต้อง idempotent");
});

test("whitelabel: createApp ตั้งแบรนด์ของ instance และแอปค่าเริ่มต้นตั้งกลับ", (t) => {
  genericApp(t);
  assert.equal(activeBrand().agentName, AGENT);
  const db = memoryDb();
  t.after(() => db.close());
  createApp({ db, logger: silent, config: testConfig(), overrides: { lineFetch: lineFetchStub(), sleep: async () => {} } });
  assert.equal(activeBrand().agentName, "ลูกแพร");
  assert.equal(activeBrand().profile, "course");
});

/* ------------------------------- ข้อความถึงลูกค้า ------------------------------- */

test("whitelabel: คำตอบปกติ — พรอมต์ที่ส่งให้สมองไม่มีชื่อแบรนด์ production และคำตอบถึงลูกค้า", async (t) => {
  const hermes = hermesFetchStub(`สวัสดีค่ะ ${AGENT}ยินดีดูแลค่ะ`);
  const { app, db } = genericApp(t, { hermesFetch: hermes });
  const result = await app.pipeline.handleInboundText({ customerId: "U-wl-normal", text: "สวัสดีครับ มีสินค้าอะไรบ้าง", replyToken: "" });
  assert.equal(result.sent, true);
  const sent = outbound(db, "U-wl-normal");
  assert.ok(sent.join("\n").includes(AGENT));
  for (const text of sent) assertClean(text, "คำตอบปกติ");
  assert.ok(hermes.calls.length >= 1);
  const replyCall = hermes.calls[0];
  for (const message of replyCall.body.messages) assertClean(promptText(message.content), `พรอมต์ ${message.role}`);
});

test("whitelabel: สมองล่ม + ครั้งที่สอง — ข้อความขอเวลาใช้ชื่อแอดมินของร้าน", async (t) => {
  const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const { app, db } = genericApp(t, { hermesFetch: down });
  await app.pipeline.handleInboundText({ customerId: "U-wl-down", text: "ราคาเท่าไหร่ครับ", replyToken: "" });
  await app.pipeline.handleInboundText({ customerId: "U-wl-down", text: "ยังอยู่ไหมครับ", replyToken: "" });
  const sent = outbound(db, "U-wl-down");
  assert.equal(sent.length, 2);
  assert.notEqual(sent[0], HERMES_DOWN_TEMPLATE);
  assert.notEqual(sent[1], HERMES_DOWN_RETRY_TEMPLATE);
  for (const text of sent) {
    assertClean(text, "สมองล่ม");
    assert.ok(text.includes(AGENT), text);
  }
  const third = await app.pipeline.handleInboundText({ customerId: "U-wl-down", text: "ว่าไงครับ", replyToken: "" });
  assert.equal(third.suppressed, "hermes_down_repeated", "ข้อความขอเวลาที่แทนชื่อแล้วต้องยังนับเป็นการขอเวลา");
});

test("whitelabel: ตัวกันราคาบล็อก — ข้อความแทนไม่มีชื่อแบรนด์ production", async (t) => {
  const hermes = hermesFetchStub("ราคา 99,999 บาทค่ะ ส่วนลดพิเศษ 77,777 บาทนะคะ");
  const { app, db } = genericApp(t, { hermesFetch: hermes });
  db.setApprovedPrice("กาแฟคั่วกลาง 250 กรัม", 350);
  await app.pipeline.handleInboundText({ customerId: "U-wl-price", text: "ราคาเท่าไหร่ครับ", replyToken: "" });
  const sent = outbound(db, "U-wl-price");
  assert.ok(sent.length >= 1);
  for (const text of sent) {
    assertClean(text, "บล็อกราคา");
    assert.doesNotMatch(text, /99,999|77,777/u);
  }
});

test("whitelabel: วิกฤตสุขภาพจิต + ขอคุยกับคน — template ใช้ชื่อแอดมินของร้าน", async (t) => {
  const { app, db } = genericApp(t);
  await app.pipeline.handleInboundText({ customerId: "U-wl-mental", text: "ไม่อยากมีชีวิตอยู่แล้ว อยากตาย", replyToken: "" });
  const mental = outbound(db, "U-wl-mental");
  assert.equal(mental.length, 1);
  assertClean(mental[0], "urgent_mental");
  assert.ok(mental[0].includes(AGENT));
  assert.match(mental[0], /1323/u);

  await app.pipeline.handleInboundText({ customerId: "U-wl-human", text: "ขอคุยกับทีมงาน", replyToken: "" });
  const human = outbound(db, "U-wl-human");
  assert.equal(human.length, 1);
  assertClean(human[0], "human_handoff");
  assert.ok(human[0].includes(AGENT));
  assert.equal(db.getCustomer("U-wl-human").ai_enabled, 0);
});

test("whitelabel: routeMessage ตรง ๆ — template/สรุปเหตุ ไม่มีชื่อแบรนด์ production", (t) => {
  genericApp(t);
  for (const text of ["ขอคุยกับทีมงาน", "ไม่อยากคุยกับบอท", "อยากตาย", "ไม่ต้องตอบแล้ว"]) {
    const route = routeMessage({ text });
    assertClean(route.template || "", `route ${text}`);
    assertClean(route.escalate?.summary || "", `summary ${text}`);
  }
});

test("whitelabel: คีย์เวิร์ด # ตั้งต้นของ generic ไม่มีคลาส/อบรม/ชื่อเจ้าของ", (t) => {
  genericApp(t);
  const defaults = hashtagBusinessDefaults();
  assert.deepEqual(Object.keys(defaults).sort(), ["#contact", "@contact"]);
  assertClean(defaults, "hashtag defaults");
  assert.doesNotMatch(JSON.stringify(defaults), /คลาส|อบรม|in-house/u);
  assert.equal(hashtagBusinessDefaults(DEFAULT_BRAND)["#class"], "สนใจคลาสสอนสด", "course ยังเหมือนเดิม");
});

test("whitelabel: ข้อความทักตาม/พรอมต์ทักตาม/ข้อความส่งไม้ต่อ ไม่มีชื่อแบรนด์ production", (t) => {
  genericApp(t);
  for (const stage of ["cold", "warm", "hot"]) {
    const rules = stagedRules({ stage, previousTexts: [], dealStatus: "awaiting_payment", paymentNudge: true });
    assertClean(rules, `stagedRules ${stage}`);
    assert.ok(rules.includes(AGENT), `stagedRules ${stage} ต้องเอ่ยชื่อแอดมินของร้าน`);
    assert.doesNotMatch(rules, /ที่นั่ง|ระดับการใช้ AI/u, "generic ไม่มีที่นั่ง/ระดับการใช้ AI");
  }
  for (const kind of ["booking", "contact_team", "project"]) assertClean(closingStatement(kind), `closing ${kind}`);
  assert.ok(closingStatement("contact_team").includes(AGENT));
  assert.doesNotMatch(closingStatement("booking"), /ที่นั่ง|คุณ/u);
  assertClean(paymentNudgeText({ customerId: "U1", bankAt: 1, name: "คุณเอ" }), "payment nudge");
  assertClean(scheduleCheckInText({ customerId: "U1", anchorMs: 1 }), "schedule check-in");
});

test("whitelabel: บอทรับปากในนามตัวเอง — ตัวจับรู้จักชื่อแอดมินของร้าน", (t) => {
  genericApp(t);
  assert.equal(looksLikeSelfPromise(`${AGENT}จองให้เรียบร้อยแล้วค่ะ`), true);
});

/* ------------------------------- แจ้งทีม ------------------------------- */

test("whitelabel: ข้อความแจ้งทีมทุกเหตุ ไม่มีชื่อแบรนด์ production", async (t) => {
  genericApp(t);
  for (const reason of Object.keys(NOTIFY_REASON_TEXT)) assertClean(notifyReasonText(reason), `notify ${reason}`);
  assert.ok(notifyReasonText("hermes_down").includes(AGENT));
  // ยิงจริงผ่าน notifier ถึง LINE stub — ข้อความที่ทีมได้รับ
  const db = memoryDb();
  t.after(() => db.close());
  const line = lineFetchStub();
  db.setSetting("escalate_notify:default", JSON.stringify([`U${"a".repeat(32)}`]));
  const notifier = createEscalationNotifier({
    db, config: testConfig(GENERIC_ENV), logger: silent,
    line: { sendBubbles: async ({ bubbles }) => { line.calls.push({ url: "push", body: bubbles }); return { ok: true }; } },
  });
  for (const reason of ["booking_handoff", "hermes_down", "customer_asked_quiet", "promise_self_action"]) {
    await notifier.fire({ customerId: `U-wl-n-${reason}`, reason, force: true });
  }
  assert.ok(line.calls.length >= 1, "ต้องมีข้อความแจ้งทีมออกไปจริง");
  for (const call of line.calls) assertClean(call.body, "ข้อความแจ้งทีม");
});

/* ------------------------------- export / switches ------------------------------- */

test("whitelabel: ชื่อไฟล์ CSV ใช้ slug ของร้าน ไม่ใช่ airdog", (t) => {
  genericApp(t);
  const name = exportFilename("all", "2026-10", Date.UTC(2026, 9, 8));
  assert.match(name, /^test-shop-chat-all-2026-10-20261008\.csv$/u);
  setActiveBrand(DEFAULT_BRAND);
  assert.match(exportFilename("all", "2026-10", Date.UTC(2026, 9, 8)), /^airdog-chat-/u, "course = ชื่อเดิม");
});

test("whitelabel: สวิตช์ฟีเจอร์คอร์สถูกล็อกปิดใน runtime แม้ DB เขียนว่าเปิด", (t) => {
  const { db } = genericApp(t);
  for (const [key, value] of [["owner_chat_mode", "on"], ["reply_engine", "v3"], ["qualify_sweep_mode", "on"],
    ["identity_link_mode", "auto"], ["natural_voice_mode", "on"], ["meta_capi_mode", "on"], ["ad_referral_capture", "on"],
    ["lesson_digest_mode", "on"], ["coaching_brake_mode", "on"]]) db.setSetting(key, value);
  assert.equal(ownerChatMode(db), "off");
  assert.equal(replyEngineMode(db), "legacy");
  assert.equal(qualifySweepMode(db), "off");
  assert.equal(identityLinkMode(db), "off");
  assert.equal(naturalVoiceMode(db), "off");
  assert.equal(metaCapiMode(db), "off");
  assert.equal(adReferralCaptureMode(db), "off");
  assert.equal(lessonDigestMode(db), "off");
  assert.equal(coachingBrakeMode(db), "off");
});

test("whitelabel: ลิงก์รีวิวรับเฉพาะโดเมนของร้าน (BRAND_REVIEW_DOMAINS)", (t) => {
  genericApp(t, { env: { BRAND_REVIEW_DOMAINS: "shop.example.com" } });
  const ok = validateReviewDoc({ sections: [{ name: "ลูกค้าจริง", items: [{ who: "คุณเอ", url: "https://shop.example.com/reviews/abcde12345" }] }] });
  assert.deepEqual(ok, []);
  const bad = validateReviewDoc({ sections: [{ name: "ลูกค้าจริง", items: [{ who: "คุณเอ", url: "https://pngoungacademy.com/reviews/abcde12345" }] }] });
  assert.equal(bad.length, 1);
  assert.match(bad[0], /shop\.example\.com/u);
});

/* ------------------------------- คอนโซล ------------------------------- */

const PASSWORD = "whitelabel-pass-123";

async function consoleApp(t) {
  const { app, db } = genericApp(t, { env: { CONSOLE_SESSION_SECRET: "whitelabel-console-secret" } });
  db.createOperator({ username: "owner", passHash: hashPassword(PASSWORD), displayName: "เจ้าของ", role: "owner" });
  await listen(app.server);
  const login = await httpRequest(app.server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "owner", password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  return { app, db, cookie: login.headers["set-cookie"][0].split(";")[0], csrf: login.json.csrf };
}

test("whitelabel: คอนโซล — branding/manifest/หน้า login ใช้แบรนด์ของร้าน", async (t) => {
  const { app, cookie } = await consoleApp(t);
  const branding = await httpRequest(app.server, { path: "/console/api/branding" });
  assert.equal(branding.status, 200);
  assert.deepEqual(branding.json.branding, {
    name: BUSINESS, mark: "FD", agent: AGENT, theme: "starter",
    profile: "generic", agentName: AGENT, ownerName: OWNER, businessName: BUSINESS,
  });
  for (const path of ["/console/brand.webmanifest", "/console/static/manifest.webmanifest"]) {
    const manifest = await httpRequest(app.server, { path });
    assert.equal(manifest.status, 200, path);
    assert.match(manifest.headers["content-type"], /manifest\+json/u);
    assertClean(manifest.text, path);
    assert.equal(manifest.json.short_name, AGENT);
    assert.ok(manifest.json.description.includes(BUSINESS));
  }
  const loginPage = await httpRequest(app.server, { path: "/console/login" });
  assert.equal(loginPage.status, 200);
  assert.match(loginPage.text, /<html lang="th" class="theme-starter">/u);
  assert.match(loginPage.text, /theme-starter\.css/u);
  assert.match(loginPage.text, /\/console\/brand\.webmanifest/u);
  assert.doesNotMatch(loginPage.text, /company-logo-2026|brand\/lukprae/u);
  const css = await httpRequest(app.server, { path: "/console/static/theme-starter.css" });
  assert.equal(css.status, 200);

  const me = await httpRequest(app.server, { path: "/console/api/me", headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal(me.json.features.classRounds, false);
  assert.equal(me.json.features.intro, false);
  assertClean(me.json.branding, "/me branding");
  const quick = await httpRequest(app.server, { path: "/console/api/quick-replies", headers: { cookie } });
  assertClean(quick.json, "quick replies");
  assert.ok(!quick.json.quickReplies.some((row) => row.key === "/เตรียมตัว"));
});

test("whitelabel: คอนโซล — เส้นของฟีเจอร์คอร์สตอบ 404 และสวิตช์ที่ล็อกเปลี่ยนไม่ได้", async (t) => {
  const { app, cookie, csrf } = await consoleApp(t);
  for (const path of ["/console/api/intro", "/console/api/class-rounds", "/console/api/reviews",
    "/console/api/settings/telegram", "/console/api/settings/claude-export-testers", "/console/api/roas/ad-summary",
    "/console/api/customers/U1/identity", "/console/api/customers/U1/yolo"]) {
    const res = await httpRequest(app.server, { path, headers: { cookie } });
    assert.equal(res.status, 404, path);
  }
  const switches = await httpRequest(app.server, { path: "/console/api/settings/behavior-switches", headers: { cookie } });
  assert.equal(switches.status, 200);
  const keys = switches.json.switches.map((s) => s.key);
  for (const locked of ["owner_chat_mode", "reply_engine", "qualify_sweep_mode", "identity_link_mode", "natural_voice_mode",
    "meta_capi_mode", "ad_referral_capture", "lesson_digest_mode", "coaching_brake_mode"]) {
    assert.ok(!keys.includes(locked), `${locked} ต้องไม่โผล่ใน generic`);
  }
  const refused = await httpRequest(app.server, {
    method: "POST", path: "/console/api/settings/behavior-switches",
    headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify({ key: "reply_engine", value: "v3" }),
  });
  assert.equal(refused.status, 403);
});

test("whitelabel: โปรไฟล์ course (ค่าเริ่มต้น) — template/คอนโซลเหมือนเดิมทุกตัวอักษร", async (t) => {
  const db = memoryDb();
  const down = async () => ({ ok: false, status: 503, json: async () => ({}) });
  const app = createApp({ db, logger: silent, config: testConfig(),
    overrides: { hermesFetch: down, lineFetch: lineFetchStub(), notifier: { fireLater() {} }, sleep: async () => {} } });
  t.after(() => db.close());
  await app.pipeline.handleInboundText({ customerId: "U-course-down", text: "ราคาเท่าไหร่ครับ", replyToken: "" });
  assert.deepEqual(outbound(db, "U-course-down"), [HERMES_DOWN_TEMPLATE]);
  assert.equal(notifyReasonText("hermes_down"), NOTIFY_REASON_TEXT.hermes_down);
  assert.equal(closingStatement("booking"), "ทีมงาน (คุณชมพู่) จะติดต่อกลับในแชทนี้เพื่อยืนยันที่นั่งและขั้นตอนต่อไปนะคะ");
});
