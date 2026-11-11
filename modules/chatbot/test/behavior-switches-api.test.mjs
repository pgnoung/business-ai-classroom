// แผงสวิตช์พฤติกรรมลูกแพร (28 ก.ย. 2026) — เจ้าของเปลี่ยนได้คนเดียว ทีมเห็นสถานะ ค่าแปลกถูกปฏิเสธ
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { coachingBrakeMode } from "../src/coachingBrake.mjs";
import { replyClosingQuestionMode } from "../src/replyClosingQuestion.mjs";
import { pauseResumeMode } from "../src/pauseHeld.mjs";
import { paymentGentleNudgeMode } from "../src/paymentGentleNudge.mjs";
import { scheduleCheckFollowupMode } from "../src/scheduleCheck.mjs";
import { ownerChatMode } from "../src/ownerChat.mjs";
import { ownerChatModelMode, ownerChatModelPlan } from "../src/ownerChatModel.mjs";
import { lessonDigestMode } from "../src/telegramLessonDigest.mjs";
import { BEHAVIOR_SWITCHES } from "../src/consoleBehaviorSwitchesApi.mjs";
import { qualifySweepMode } from "../src/notQualified.mjs";
import { BEHAVIOR_SWITCH_COPY } from "../public/console/settingsBehaviorSwitches.mjs";
import { httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();
const PASSWORD = "switch-pass-123456";
const silent = { log() {}, warn() {}, error() {}, info() {}, debug() {} };

async function start(t) {
  const db = memoryDb();
  const passHash = hashPassword(PASSWORD);
  db.createOperator({ username: "owner", passHash, displayName: "เจ้าของ", role: "owner" });
  db.createOperator({ username: "admin", passHash, displayName: "แอดมิน", role: "admin" });
  db.createOperator({ username: "staff", passHash, displayName: "ทีมงาน", role: "operator" });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: "behavior-switch-secret" }), db,
    overrides: { lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server, username) {
  const res = await httpRequest(server, { method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: PASSWORD }) });
  assert.equal(res.status, 200);
  return { cookie: res.headers["set-cookie"][0].split(";")[0], csrf: res.json.csrf };
}

const PATH = "/console/api/settings/behavior-switches";
const post = (server, s, body) => httpRequest(server, { method: "POST", path: PATH,
  headers: { cookie: s.cookie, "content-type": "application/json", "x-csrf-token": s.csrf }, body: JSON.stringify(body) });

test("สวิตช์พฤติกรรม: ค่าเริ่มต้น = เปิดทั้งหมด และทีมงานเห็นสถานะแต่เปลี่ยนไม่ได้", async (t) => {
  const { app } = await start(t);
  const staff = await login(app.server, "staff");
  const view = await httpRequest(app.server, { path: PATH, headers: { cookie: staff.cookie } });
  assert.equal(view.status, 200);
  assert.equal(view.json.canEdit, false);
  assert.deepEqual(view.json.switches.map((s) => [s.key, s.value]), [
    ["coaching_brake_mode", "on"], ["reply_closing_question", "on"], ["pause_resume_answer", "on"],
    ["payment_gentle_nudge", "on"], ["schedule_check_followup", "on"], ["owner_chat_mode", "on"], ["owner_chat_model", "luna"],
    ["lesson_digest_mode", "on"],
    // 28 ก.ย. 2026: ส่งลิงก์ต่อแชท LINE ให้ลูกค้า Facebook — ค่าเริ่มต้น "ปิด" (ข้อความถึงลูกค้าต้องรอเจ้าของอนุมัติถ้อยคำ)
    ["identity_link_mode", "off"],
    // 28 ก.ย. 2026: สวิตช์รวมข้อความตามขั้น — ไม่มีแถว = on (ส่งเฉพาะลำดับที่คนกดเปิดใช้)
    ["step_messages_mode", "on"],
    ["hot_followup_push_mode", "on"],
    // 4 ต.ค. 2026: น้ำเสียงคนคุยแชท — ไม่มีแถว = off (เปลี่ยนวิธีพูดกับลูกค้าจริง เปิดเมื่อเจ้าของอนุมัติ)
    ["natural_voice_mode", "off"],
    // 5 ต.ค. 2026: ตัวกวาดคัดกรองรายชั่วโมง (ห้องสีเหลือง) — ไม่มีแถว = off (ไม่เรียกโมเดล ไม่ปิดห้องใด)
    ["qualify_sweep_mode", "off"],
    // 12 ต.ค. 2026 ค่ำ: ตีจบแชทนอกเรื่อง — ไม่มีแถว = propose (พี่ง้วง: ไม่มีอะไรปิดเอง — AI เสนอ คนยืนยัน)
    ["offtopic_close_mode", "propose"],
    // 12 ต.ค. 2026 ค่ำ: รอบตรวจเสนอปิดห้อง — ไม่มีแถว = on (ปลุกมือถือพี่ง้วงคนเดียว) · ขอบเขต = ทุกห้อง (สัปดาห์แรก)
    ["owner_review_mode", "on"],
    ["owner_review_scan_scope", "all"],
    // 3 พ.ย. 2026: Luna ตรวจคำตอบของทีมหลัง 20:00 — ไม่มีแถว = on (พี่ง้วงสั่ง "ใช้ luna" · ผลเห็นเฉพาะเจ้าของ)
    ["team_reply_review_mode", "on"],
    // 4 ต.ค. 2026: เครื่องตอบแชท v3 — ไม่มีแถว = legacy (เครื่องตอบเดิมทุกไบต์)
    ["reply_engine", "legacy"],
    // 6 ต.ค. 2026: จดที่มาของห้องจากแอด Meta — ไม่มีแถว = off (จดอย่างเดียว ไม่แตะการตอบ)
    ["ad_referral_capture", "off"],
    // 7 ต.ค. 2026: โหมดออเดอร์ — ไม่มีแถว = ร้านส่งของ (เหมือนเดิม)
    ["order_mode", "shipping"],
    // 7 ต.ค. 2026: ส่ง Purchase เข้า Meta — ไม่มีแถว = off
    ["meta_capi_mode", "off"],
    // 19 ต.ค. 2026: คลังรีวิวนอกพรอมต์ — ไม่มีแถว = off (แบบใหม่) · on = แนบทั้งคลังแบบเดิม (ปุ่มถอยกลับ)
    ["review_catalog_in_prompt", "off"],
    // 5 พ.ย. 2026: การ์ดสไตล์ลูกแพร (สอนรุ่นที่ถูกกว่าให้เขียนแบบ Opus) — ไม่มีแถว = off (พรอมต์เดิมทุกไบต์)
    ["reply_style_card", "off"],
    // 7 พ.ย. 2026: คลังคำตอบจริงของครู — ไม่มีแถว = off = พรอมต์เดิม
    ["reply_style_bank", "off"],
    // 8 พ.ย. 2026: คลังข้อความทักตามของครู — ไม่มีแถว = off = กติกาเดิม
    ["followup_style_bank", "off"],
    // 8 พ.ย. 2026: ทักตามแบบครู — ไม่มีแถว = off = กติกาเดิม
    ["followup_teacher_rules", "off"],
    // 7 พ.ย. 2026: แคชข้อมูลธุรกิจแยกชั้น — ไม่มีแถว = ปิด = พรอมต์เดิมทุกไบต์
    ["reply_cache_layer", "off"],
  ]);
  assert.equal((await post(app.server, staff, { key: "coaching_brake_mode", value: "off" })).status, 403);
  const admin = await login(app.server, "admin");
  assert.equal((await post(app.server, admin, { key: "coaching_brake_mode", value: "off" })).status, 403, "admin แจกได้จาก dropdown จึงเปลี่ยนวิธีพูดกับลูกค้าไม่ได้");
});

test("สวิตช์พฤติกรรม: เจ้าของปิด/เปิดได้ มีผลกับตัวอ่านของแต่ละโมดูลทันที และมีแถว audit", async (t) => {
  const { app, db } = await start(t);
  const owner = await login(app.server, "owner");
  const off = await post(app.server, owner, { key: "coaching_brake_mode", value: "off" });
  assert.equal(off.status, 200);
  assert.equal(coachingBrakeMode(db), "off");
  assert.equal((await post(app.server, owner, { key: "reply_closing_question", value: "off" })).status, 200);
  assert.equal(replyClosingQuestionMode(db), "off");
  assert.equal((await post(app.server, owner, { key: "pause_resume_answer", value: "facebook" })).status, 200);
  assert.equal(pauseResumeMode(db), "facebook");
  assert.equal((await post(app.server, owner, { key: "coaching_brake_mode", value: "on" })).status, 200);
  assert.equal(coachingBrakeMode(db), "on");
  // 28 ก.ย. 2026: ทักเบา ๆ หลังส่งบัญชี + ทักครั้งเดียวหลัง "ขอเช็คคิวก่อน"
  assert.equal((await post(app.server, owner, { key: "payment_gentle_nudge", value: "off" })).status, 200);
  assert.equal(paymentGentleNudgeMode(db), "off");
  assert.equal((await post(app.server, owner, { key: "schedule_check_followup", value: "off" })).status, 200);
  assert.equal(scheduleCheckFollowupMode(db), "off");
  assert.equal((await post(app.server, owner, { key: "schedule_check_followup", value: "facebook" })).status, 400, "มีแค่ on/off");
  // 28 ก.ย. 2026 บ่าย: คุยกับลูกแพรทาง Telegram
  assert.equal((await post(app.server, owner, { key: "owner_chat_mode", value: "off" })).status, 200);
  assert.equal(ownerChatMode(db), "off");
  // บ่าย 28 ก.ย.: โมเดลของแชทเจ้าของ (luna/sol เท่านั้น)
  assert.equal((await post(app.server, owner, { key: "owner_chat_model", value: "sol" })).status, 200);
  assert.equal(ownerChatModelMode(db), "sol");
  assert.equal((await post(app.server, owner, { key: "owner_chat_model", value: "terra" })).status, 400, "มีแค่ luna/sol");
  // เย็น 28 ก.ย.: สรุปบทเรียนรออนุมัติทาง Telegram 22:00
  assert.equal((await post(app.server, owner, { key: "lesson_digest_mode", value: "off" })).status, 200);
  assert.equal(lessonDigestMode(db), "off");
  const audits = db.raw.prepare("SELECT target, detail FROM admin_audit WHERE action = 'behavior_switch'").all().map((row) => `${row.target}: ${row.detail}`);
  assert.equal(audits.length, 9);
  for (const line of ["coaching_brake_mode: on → off", "reply_closing_question: on → off", "pause_resume_answer: on → facebook", "coaching_brake_mode: off → on",
    "payment_gentle_nudge: on → off", "schedule_check_followup: on → off", "owner_chat_mode: on → off", "owner_chat_model: luna → sol", "lesson_digest_mode: on → off"]) {
    assert.ok(audits.includes(line), line);
  }
});

test("สวิตช์พฤติกรรม: key/value แปลกถูกปฏิเสธ ไม่มีอะไรถูกเขียน · ไม่มี CSRF = 403", async (t) => {
  const { app, db } = await start(t);
  const owner = await login(app.server, "owner");
  for (const body of [{ key: "ai_paused", value: "1" }, { key: "coaching_brake_mode", value: "maybe" }, { key: "reply_closing_question", value: "facebook" }, {}]) {
    assert.equal((await post(app.server, owner, body)).status, 400, JSON.stringify(body));
  }
  assert.equal(db.getSetting("coaching_brake_mode"), null);
  const noCsrf = await httpRequest(app.server, { method: "POST", path: PATH,
    headers: { cookie: owner.cookie, "content-type": "application/json" }, body: JSON.stringify({ key: "coaching_brake_mode", value: "off" }) });
  assert.equal(noCsrf.status, 403);
});

test("แผงสวิตช์: ทุกสวิตช์ในเซิร์ฟเวอร์มีคำอธิบายภาษาไทยครบทุกค่า (สวิตช์ใหม่ต้องไม่โผล่เป็นรหัสดิบ)", () => {
  for (const item of BEHAVIOR_SWITCHES) {
    const copy = BEHAVIOR_SWITCH_COPY[item.key];
    assert.ok(copy?.title, `ไม่มีชื่อ: ${item.key}`);
    for (const value of item.values) assert.ok(copy[value], `ไม่มีคำอธิบาย ${item.key}=${value}`);
  }
  assert.match(BEHAVIOR_SWITCH_COPY.owner_chat_mode.on, /ส่งหาลูกค้าเองไม่ได้/u);
});

test("สวิตช์คุยกับลูกแพร: ไม่มีแถว = เปิด · off = ปิด · อ่านพัง = ปิด (กลับไปรับแต่คำสั่ง)", () => {
  const db = memoryDb();
  assert.equal(ownerChatMode(db), "on");
  db.setSetting("owner_chat_mode", "off");
  assert.equal(ownerChatMode(db), "off");
  db.setSetting("owner_chat_mode", "anything");
  assert.equal(ownerChatMode(db), "on");
  assert.equal(ownerChatMode({ getSetting() { throw new Error("db down"); } }), "off");
  db.close();
});

test("สวิตช์โมเดลแชทเจ้าของ: ไม่มีแถว = luna · sol = ทางเดิม · ค่าแปลก/อ่านพัง = sol · ระบบไม่อนุญาต luna = sol", () => {
  const db = memoryDb();
  assert.equal(ownerChatModelMode(db), "luna");
  assert.deepEqual(ownerChatModelPlan({ db, config: { hermesAllowedModels: [] } }), {
    mode: "luna", model: "gpt-5.6-luna", reasoningEffort: "low", maxCompletionTokens: 4000, retryMaxCompletionTokens: 8000,
  });
  assert.equal(ownerChatModelPlan({ db, config: { hermesAllowedModels: ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"] } }).mode, "luna");
  assert.deepEqual(ownerChatModelPlan({ db, config: { hermesAllowedModels: ["gpt-5.6-sol"] } }), { mode: "sol", reason: "luna_not_allowed" });
  db.setSetting("owner_chat_model", "sol");
  assert.equal(ownerChatModelPlan({ db, config: {} }).mode, "sol");
  db.setSetting("owner_chat_model", "gpt-4o");
  assert.equal(ownerChatModelMode(db), "sol", "ค่าแปลก = ทางที่พิสูจน์แล้ว");
  db.setSetting("owner_chat_model", " LUNA ");
  assert.equal(ownerChatModelMode(db), "luna");
  assert.equal(ownerChatModelMode({ getSetting() { throw new Error("db down"); } }), "sol");
  db.close();
});

// 5 ต.ค. 2026 (คำสั่งพี่ง้วง): สวิตช์ตัวกวาดคัดกรอง — เจ้าของคนเดียวเปลี่ยนได้ (ปิด AI ห้องลูกค้าจริงได้)
// ตัวอ่านปิดไว้ก่อนเสมอ: ไม่มีแถว/ค่าแปลก/อ่านพัง = off
test("สวิตช์ตัวกวาดคัดกรอง: เจ้าของตั้ง shadow/on/off ได้ · admin/staff ไม่ได้ · ค่าแปลก 400 · ตัวอ่าน fail closed", async (t) => {
  const { app, db } = await start(t);
  const admin = await login(app.server, "admin");
  assert.equal((await post(app.server, admin, { key: "qualify_sweep_mode", value: "on" })).status, 403);
  assert.equal(db.getSetting("qualify_sweep_mode"), null);
  const owner = await login(app.server, "owner");
  assert.equal((await post(app.server, owner, { key: "qualify_sweep_mode", value: "auto" })).status, 400);
  for (const value of ["shadow", "on", "off"]) {
    const res = await post(app.server, owner, { key: "qualify_sweep_mode", value });
    assert.equal(res.status, 200);
    assert.equal(qualifySweepMode(db), value);
    assert.equal(res.json.switches.find((s) => s.key === "qualify_sweep_mode").value, value);
  }
  const audits = db.raw.prepare("SELECT detail FROM admin_audit WHERE action = 'behavior_switch' AND target = 'qualify_sweep_mode'").all().map((row) => row.detail);
  assert.deepEqual(audits, ["off → shadow", "shadow → on", "on → off"]);
  db.setSetting("qualify_sweep_mode", "ON");
  assert.equal(qualifySweepMode(db), "off", "ค่าแปลก = off");
  assert.equal(qualifySweepMode({ getSetting() { throw new Error("db down"); } }), "off");
});
