// ai-pause-policy — นโยบาย "AI พักเมื่อไหร่ / เงียบถาวรเมื่อไหร่" (คำสั่งเจ้าของ 2026-09-02)
//
// สามเรื่องที่ตัดสินวันนี้ และเป็นเหตุที่ไฟล์นี้มีอยู่:
//   1. คนตอบเองจากคอนโซล = AI พัก 15 นาทีแล้วกลับมาเอง (ไม่ใช่ปิดถาวร)
//   2. คนกดสวิตช์ปิด AI เอง = sticky — ไม่มีเส้นทางอัตโนมัติใดเปิดคืนได้
//   3. เคสที่ต้องรอคนจริงจริง ๆ (in-house handoff / ร้องเรียน / ขอให้หยุดทัก /
//      ถามว่าเป็นบอทไหม) = ปิดถาวร ไม่ใช่พักตามเวลาแล้วบอทโผล่มาเอง
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createApp } from "../src/server.mjs";
import {
  OPERATOR_PAUSE_MS, MANUAL_AI_OFF_REASON, isStickyAiOffReason, canAutoEnableAi,
} from "../src/aiPausePolicy.mjs";
import { OPERATOR_ACTIVE_MS } from "../src/pipeline.mjs";
import { previewStagedFollowup } from "../src/stagedFollowups.mjs";
import {
  createFacebookWebhook, FB_HUMAN_OPERATOR, FB_KNOWN_CUSTOMERS_KEY, AI_OFF_FB_GATE_PENDING,
} from "../src/facebookWebhook.mjs";
import { FB_AD_GREETING_IDLE_MS, isAdGreetingEcho, looksLikeAdGreeting } from "../src/fbAdGreeting.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function makeApp({ configOverrides = {}, hermesFetch, lineFetch, approved = [2500] } = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  for (const amount of approved) db.setApprovedPrice(`ราคา-${amount}`, amount);
  const hermes = hermesFetch ?? hermesFetchStub();
  const line = lineFetch ?? lineFetchStub();
  const app = createApp({ config, db, overrides: { hermesFetch: hermes, lineFetch: line, sleep: async () => {} }, logger: silent });
  return { app, db, config, hermesFetch: hermes, lineFetch: line };
}

/* ---------------- 1. คนตอบเอง = พัก 15 นาที แล้ว AI กลับมาเอง ---------------- */

test("นโยบายที่ 1: หน้าต่างพัก AI หลังคนตอบเอง = 15 นาที และเป็นค่าเดียวทั้งระบบ", () => {
  assert.equal(OPERATOR_PAUSE_MS, 15 * 60_000, "เจ้าของสั่ง 15 นาที");
  assert.equal(OPERATOR_ACTIVE_MS, OPERATOR_PAUSE_MS, "pipeline ต้องใช้ค่าเดียวกัน ห้ามมีสองแหล่ง");
});

test("นโยบายที่ 1: พักแล้วครบเวลา AI กลับมาตอบเอง (พักคือพัก ไม่ใช่ปิด)", async () => {
  const { app, db, lineFetch } = makeApp();
  db.upsertCustomer("U-resume", {});
  db.setOperatorActiveUntil("U-resume", Date.now() + OPERATOR_PAUSE_MS);
  const paused = await app.pipeline.handleInboundText({ customerId: "U-resume", text: "สนใจคลาสค่ะ", replyToken: "" });
  assert.equal(paused.suppressed, "operator_active");

  db.setOperatorActiveUntil("U-resume", Date.now() - 1000); // หน้าต่างหมดอายุ
  const sends = lineFetch.sends.length;
  const resumed = await app.pipeline.handleInboundText({ customerId: "U-resume", text: "สนใจคลาสค่ะ", replyToken: "" });
  assert.equal(resumed.sent, true, "หมดหน้าต่างแล้ว AI ต้องกลับมาตอบเอง ไม่ต้องให้คนไปกดเปิด");
  assert.equal(lineFetch.sends.length, sends + 1);
  assert.equal(db.getCustomer("U-resume").ai_enabled, 1, "พักห้ามแตะสวิตช์ ai_enabled");
  db.close();
});

/* ---------------- 2. คนกดปิดเอง = sticky ---------------- */

test("นโยบายที่ 2: สวิตช์ปิดจากคอนโซลบันทึกเหตุ manual และถือเป็น sticky", async (t) => {
  const config = testConfig({ CONSOLE_SESSION_SECRET: "test-console-secret-0123456789" });
  const db = memoryDb();
  db.setApprovedPrice("ราคา-2500", 2500);
  db.createOperator({ username: "nok", passHash: hashPassword("operator-pass-123"), displayName: "พี่นก" });
  db.upsertCustomer("U-manual", {});
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const post = (path, body, headers = {}) => httpRequest(app.server, {
    method: "POST", path, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const auth = await post("/console/api/login", { username: "nok", password: "operator-pass-123" });
  const cookie = (auth.headers["set-cookie"]?.[0] || "").split(";")[0];
  const head = { cookie, "x-csrf-token": auth.json.csrf };

  const off = await post("/console/api/customers/U-manual/ai", { enabled: false }, head);
  assert.equal(off.status, 200);
  assert.equal(off.json.customer.ai_enabled, 0);
  assert.equal(off.json.customer.ai_off_reason, MANUAL_AI_OFF_REASON, "ปิดด้วยมือต้องทิ้งเหตุไว้ ไม่ใช่ค่าว่าง");
  assert.equal(isStickyAiOffReason(MANUAL_AI_OFF_REASON), true);
  assert.equal(canAutoEnableAi(db.getCustomer("U-manual")), false, "ห้ามเส้นทางอัตโนมัติเปิดคืน");

  const on = await post("/console/api/customers/U-manual/ai", { enabled: true }, head);
  assert.equal(on.json.customer.ai_enabled, 1);
  assert.equal(on.json.customer.ai_off_reason, "", "เปิดคืนต้องล้างเหตุเหมือนเดิม");
});

test("นโยบายที่ 2: เหตุที่คนต้องเปิดคืนเองครบทุกตัว / เหตุชั่วคราวไม่ sticky", () => {
  for (const reason of [
    "manual", "money_line", "bank_sent", "human_requested", "booking_handoff", "urgent_mental",
    "customer_handover", "not_a_customer", "handoff_private_inhouse",
    "complaint", "optout", "identity_question",
  ]) {
    assert.equal(isStickyAiOffReason(reason), true, reason);
  }
  assert.equal(isStickyAiOffReason(AI_OFF_FB_GATE_PENDING), false, "เกตที่เลื่อนไว้ต้องปลดเองได้");
  assert.equal(isStickyAiOffReason(""), false);
  assert.equal(canAutoEnableAi({ ai_enabled: 1, ai_off_reason: "" }), true, "ห้องที่เปิดอยู่ = เปิดต่อได้");
});

/* ---------------- 3. เคสที่ต้องปิดถาวร ---------------- */

test("นโยบายที่ 3ข: ร้องเรียน -> ส่ง template ขออภัยแล้วปิด AI ถาวร (ไม่ใช่พัก 60 นาที)", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  const result = await app.pipeline.handleInboundText({
    customerId: "U-comp2", text: "ไม่พอใจมากเลยค่ะ บริการแย่มาก", replyToken: "rt",
  });
  assert.equal(result.sent, true, "template ขออภัยของเทิร์นนี้ยังต้องส่ง");
  const customer = db.getCustomer("U-comp2");
  assert.equal(customer.ai_enabled, 0, "ร้องเรียน = คนจริงรับช่วง ไม่ใช่รอ 60 นาทีแล้วบอทกลับมา");
  assert.equal(customer.ai_off_reason, "complaint");
  assert.ok(db.listAudit().some((row) => row.action === "ai_off_complaint" && row.target === "U-comp2"));

  const sends = lineFetch.sends.length;
  const calls = hermesFetch.calls.length;
  const next = await app.pipeline.handleInboundText({ customerId: "U-comp2", text: "ราคาเท่าไหร่คะ", replyToken: "" });
  assert.equal(next.suppressed, "ai_disabled", "ห้ามกลับมาตอบเองเมื่อเวลาผ่านไป");
  assert.equal(lineFetch.sends.length, sends);
  assert.equal(hermesFetch.calls.length, calls);
  db.close();
});

test("นโยบายที่ 3ค: ลูกค้าขอให้หยุดทัก -> ตอบรับแล้วปิด AI ถาวร เหตุ optout", async () => {
  const { app, db } = makeApp();
  const result = await app.pipeline.handleInboundText({
    customerId: "U-opt", text: "ไม่ต้องทักมาอีกนะคะ รำคาญแล้ว", replyToken: "rt",
  });
  assert.equal(result.sent, true, "ต้องตอบรับคำขอก่อน ห้ามเงียบใส่คนที่กำลังหงุดหงิด");
  const customer = db.getCustomer("U-opt");
  assert.equal(customer.do_not_disturb, 1, "ธง DND เดิมต้องยังติด");
  assert.equal(customer.ai_enabled, 0, "ขอให้หยุด = หยุดจริง ไม่ใช่หยุดแค่ follow-up");
  assert.equal(customer.ai_off_reason, "optout");
  const next = await app.pipeline.handleInboundText({ customerId: "U-opt", text: "ราคาเท่าไหร่คะ", replyToken: "" });
  assert.equal(next.suppressed, "ai_disabled");
  db.close();
});

// คำสั่งพี่ง้วง 2026-09-28 (F10): เดิมปิด AI ถาวรทันที ทั้งที่แม่แบบชวนให้ "แจ้งได้เลย" แล้วลูกแพรไม่ได้ยินอีก
test("นโยบายที่ 3ง (28 ก.ย.): ถามว่าเป็นบอทไหม -> ตอบความจริงตาม template แล้วคุยต่อ ไม่ปิด AI ไม่ตั้งธงรอคน", async () => {
  const { app, db, lineFetch } = makeApp();
  const result = await app.pipeline.handleInboundText({
    customerId: "U-idn3", text: "นี่บอทหรือเปล่าคะ", replyToken: "rt",
  });
  assert.equal(result.sent, true);
  assert.equal(result.route, "identity");
  const sentText = JSON.stringify(lineFetch.sends.map((c) => c.body));
  assert.ok(/AI|เอไอ|ผู้ช่วย/u.test(sentText), "คำตอบต้องเปิดเผยว่าเป็น AI เสมอ (กฎเหล็ก)");
  const customer = db.getCustomer("U-idn3");
  assert.equal(customer.ai_enabled, 1, "ถามว่าเป็นบอทไม่ใช่การขอคน — ต้องคุยต่อได้");
  assert.notEqual(customer.state, "NEEDS_HUMAN");
  assert.ok(!lineFetch.sends.some((call) => call.url.endsWith("/v2/bot/message/push")), "ไม่ปลุกทีม");
  const audits = db.raw.prepare("SELECT action FROM admin_audit WHERE target = ?").all("U-idn3").map((row) => row.action);
  assert.ok(audits.includes("identity_disclosed"));
  assert.ok(!audits.includes("ai_off_identity_question"));
  // ขอคนจริงในข้อความถัดไป = ส่งต่อตามปกติ (ปิดเฉพาะตอนนี้)
  const next = await app.pipeline.handleInboundText({ customerId: "U-idn3", text: "ขอคุยกับคนจริงครับ", replyToken: "rt2" });
  assert.equal(next.route, "human_handoff");
  assert.equal(db.getCustomer("U-idn3").ai_enabled, 0);
  db.close();
});

test("นโยบายที่ 3ก: opportunity handoff (in-house/ผู้บรรยาย) ปิดถาวรและ follow-up ต้องไม่ปลุกห้องนี้", () => {
  const db = memoryDb();
  db.upsertCustomer("U-inhouse", {});
  db.setAiEnabled("U-inhouse", false, "handoff_private_inhouse");
  db.setNeedsHuman("U-inhouse", "opportunity_handoff", "ข้อมูลครบ ให้ทีมรับช่วง");
  assert.equal(isStickyAiOffReason("handoff_private_inhouse"), true);
  assert.equal(canAutoEnableAi(db.getCustomer("U-inhouse")), false);
  db.close();
});

// ทุกเหตุที่ "ปิดถาวร" ต้องหยุด follow-up ด้วย ไม่งั้นบอทเงียบในแชทแต่ยังไปทักเองอยู่ดี
//
// 2026-09-05 (คำสั่งพี่ง้วง): ข้อยกเว้น bank_sent ของ v1.4.11 ถูกยกเลิกแล้ว —
// "ส่งให้ชมพู่ handle ต่อเอง ไม่ต้อง follow up" ตอนนี้จึงไม่มีข้อยกเว้นเหลืออยู่เลย
test("นโยบายที่ 3: เหตุปิดถาวรทุกตัวต้องหยุด staged follow-up (ไม่มีข้อยกเว้นแล้ว)", () => {
  const db = memoryDb();
  const preview = (reason) => previewStagedFollowup({
    customer: {
      line_user_id: "U-fu", ai_enabled: reason ? 0 : 1, ai_off_reason: reason,
      do_not_disturb: 0, followup_enabled: 1, marketing_consent: 0, last_score: 80,
    },
    lastInboundAt: 1_000, nowMs: 10_000_000,
  });
  for (const reason of [
    "handoff_private_inhouse", "complaint", "optout", "identity_question", "manual",
    "bank_sent", "booking_handoff",
  ]) {
    assert.equal(preview(reason), null, `${reason} ต้องไม่มีนัดทัก`);
  }
  // ห้องที่ AI ยังเปิดอยู่ต้องมีนัดตามปกติ — ไม่งั้นเทสต์นี้เขียวเพราะทุกอย่างตายหมด
  assert.notEqual(preview(""), null, "ห้องที่บอทยังดูแลอยู่ต้องมีนัดทักตามปกติ");
  db.close();
});

/* ---------------- 4. Facebook: แอดมินพิมพ์ใน Business Suite = พัก ไม่ใช่ปิด ---------------- */

const APP_SECRET = "test-app-secret";
const sign = (raw) => `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;

function fbHarness({ db, profile = undefined, knownCustomers = null, draining = false } = {}) {
  if (knownCustomers) db.setSetting(FB_KNOWN_CUSTOMERS_KEY, JSON.stringify(knownCustomers));
  const pipelineCalls = [];
  const webhook = createFacebookWebhook({
    config: { lineWebhookBodyTimeoutMs: 1000 },
    db,
    pipeline: { handleEvent: async (event, ctx) => { pipelineCalls.push({ event, ctx }); } },
    lineRegistry: {
      forChannel: () => ({ getProfile: async () => profile ?? null }),
      channels: [{ id: "facebook", credentials: () => ({ appSecret: APP_SECRET, verifyToken: "vtok", pageAccessToken: "tok" }) }],
    },
    notifier: { fire: async () => ({ ok: true }) },
    readBody: async (req) => req._raw,
    json: (res, status, body) => { res.result = { status, body }; },
    logger: silent,
    isDraining: () => draining,
  });
  const post = async (payload) => {
    const raw = Buffer.from(JSON.stringify(payload));
    await webhook.handleWebhook({ method: "POST", headers: { "x-hub-signature-256": sign(raw) }, _raw: raw }, {});
  };
  return { post, pipelineCalls };
}

const fbEcho = (psid, text, mid) => ({
  object: "page",
  entry: [{ messaging: [{ sender: { id: "page1" }, recipient: { id: psid }, timestamp: 3, message: { mid, text, is_echo: true } }] }],
});

test("นโยบายที่ 4: echo ของแอดมิน = พัก AI 15 นาทีเหมือนคอนโซล ห้ามปิดถาวร", async () => {
  const db = memoryDb();
  const { post } = fbHarness({ db });
  const before = Date.now();
  await post(fbEcho("psid-pause", "เดี๋ยวชมพู่ดูแลนะคะ", "m-echo-pause"));

  const customer = db.getCustomer("facebook:psid-pause");
  assert.equal(customer.ai_enabled, 1, "แอดมินตอบ = พัก ไม่ใช่ปิดถาวร");
  assert.notEqual(customer.ai_off_reason, "fb_human_replying");
  assert.ok(customer.operator_active_until >= before + OPERATOR_PAUSE_MS - 2000, "ต้อง ~ now+15 นาที");
  assert.ok(customer.operator_active_until <= Date.now() + OPERATOR_PAUSE_MS + 2000);

  const msg = db.raw.prepare("SELECT * FROM messages WHERE customer_id=?").get("facebook:psid-pause");
  assert.equal(msg.direction, "out");
  assert.equal(msg.operator, FB_HUMAN_OPERATOR, "ยังต้องเก็บเป็นข้อความของทีมเหมือนเดิม");
  db.close();
});

// 8 พ.ย. 2026 (พี่ง้วง "แก้เลย"): แอด Click-to-Messenger ทักลูกค้าในนามเพจ จึงมาเป็น echo เหมือนแอดมินพิมพ์ —
// ของเดิมพักบอท 15 นาที ห้องจากแอดเลยรอคำตอบแรก ~16 นาทีทุกห้อง · ข้อความคนจริงทุกแบบต้องพักเหมือนเดิม
const AD_GREETING = "สวัสดีค่ะ คุณทดสอบ! ลูกแพร นะคะ\nไม่ทราบว่า ปกติเคยใช้ AI Agents และสั่งให้เปิด คอมพิวเตอร์ ทำงานแทนเรา มาก่อนมั้ยคะ ?";
const fbInbound = (psid, text, mid) => ({
  object: "page",
  entry: [{ messaging: [{ sender: { id: psid }, recipient: { id: "page1" }, timestamp: 4, message: { mid, text } }] }],
});

test("ข้อความทักของแอดในห้องเงียบ = ไม่พัก AI ไม่จดว่าทีมรับห้อง แต่ยังเก็บในประวัติเหมือนเดิม", async () => {
  const db = memoryDb();
  const { post } = fbHarness({ db });
  await post(fbEcho("psid-ad", AD_GREETING, "m-ad-1"));

  const customer = db.getCustomer("facebook:psid-ad");
  assert.equal(Number(customer.operator_active_until) || 0, 0, "แอดไม่ใช่คนพิมพ์ ห้ามพักบอท");
  assert.equal(customer.ai_enabled, 1);
  assert.equal(db.listAudit(10).filter((row) => row.action === "fb_human_takeover").length, 0);
  const msg = db.raw.prepare("SELECT * FROM messages WHERE customer_id=?").get("facebook:psid-ad");
  assert.equal(msg.content, AD_GREETING, "ลูกแพรต้องยังเห็นว่าแอดถามอะไรไป");
  assert.equal(msg.operator, FB_HUMAN_OPERATOR, "แถวในประวัติต้องเหมือนเดิมทุกช่อง บริบทคำตอบจะได้ไม่เปลี่ยน");
  db.close();
});

test("ลูกค้าตอบคำถามแอดต่อทันที = เข้าไปป์ไลน์โดยไม่มีหน้าต่างพักค้าง", async () => {
  const db = memoryDb();
  const { post, pipelineCalls } = fbHarness({ db, profile: { displayName: "ทดสอบ" } });
  await post(fbEcho("psid-ad2", AD_GREETING, "m-ad-2"));
  await post(fbInbound("psid-ad2", "ไม่เคยใช้ค่ะ", "m-ad-2-in"));
  assert.equal(pipelineCalls.length, 1);
  assert.equal(Number(db.getCustomer("facebook:psid-ad2").operator_active_until) || 0, 0);
  db.close();
});

test("ข้อความรูปเดียวกับแอดในห้องที่เพิ่งคุยกันภายใน 1 ชม. = คนพิมพ์ พัก 15 นาทีเหมือนเดิม", async () => {
  const db = memoryDb();
  const { post } = fbHarness({ db });
  db.upsertCustomer("facebook:psid-live", { channelId: "facebook" });
  db.insertMessage({ customerId: "facebook:psid-live", direction: "in", content: "สนใจค่ะ", channelId: "facebook" });
  const before = Date.now();
  await post(fbEcho("psid-live", AD_GREETING, "m-ad-3"));
  assert.ok(db.getCustomer("facebook:psid-live").operator_active_until >= before + OPERATOR_PAUSE_MS - 2000);
  assert.equal(db.listAudit(10).filter((row) => row.action === "fb_human_takeover").length, 1);
  db.close();
});

test("ห้องเก่าที่เงียบเกิน 1 ชม. แล้วกดแอดเข้ามาใหม่ = ข้อความทักของแอด ไม่พัก", async () => {
  const db = memoryDb();
  const { post } = fbHarness({ db });
  db.upsertCustomer("facebook:psid-old", { channelId: "facebook" });
  db.insertMessage({ customerId: "facebook:psid-old", direction: "out", content: "ทักตามเมื่อวานค่ะ", agentMode: "ai", channelId: "facebook" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(Date.now() - FB_AD_GREETING_IDLE_MS - 60_000, "facebook:psid-old");
  await post(fbEcho("psid-old", AD_GREETING, "m-ad-4"));
  assert.equal(Number(db.getCustomer("facebook:psid-old").operator_active_until) || 0, 0);
  db.close();
});

// รีวิวโค้ด 8 พ.ย.: แอดมินเพิ่งมาตอบห้องที่ลูกค้ารออยู่หลายชั่วโมง ก็ขึ้นต้นรูปเดียวกับแอดได้
test("ลูกค้ารอคำตอบอยู่แล้วแอดมินมาทักด้วยรูปเดียวกับแอด = คนพิมพ์ พัก 15 นาที แม้ห้องเงียบเกิน 1 ชม.", async () => {
  const db = memoryDb();
  const { post } = fbHarness({ db });
  db.upsertCustomer("facebook:psid-wait", { channelId: "facebook" });
  db.insertMessage({ customerId: "facebook:psid-wait", direction: "in", content: "ขอราคาหน่อยค่ะ", channelId: "facebook" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE customer_id = ?").run(Date.now() - 3 * FB_AD_GREETING_IDLE_MS, "facebook:psid-wait");
  const before = Date.now();
  await post(fbEcho("psid-wait", "สวัสดีค่ะ คุณเอ! ไม่ทราบว่าสะดวกคุยตอนนี้ไหมคะ", "m-ad-6"));
  assert.ok(db.getCustomer("facebook:psid-wait").operator_active_until >= before + OPERATOR_PAUSE_MS - 2000);
  db.close();
});

test("เส้นแบ่งห้องเงียบ: ครบ 1 ชม. พอดี = แอด · ขาดไป 1 มิลลิวินาที = คนพิมพ์", () => {
  const db = memoryDb();
  db.upsertCustomer("facebook:psid-edge", { channelId: "facebook" });
  db.insertMessage({ customerId: "facebook:psid-edge", direction: "out", content: "ทักตามค่ะ", agentMode: "ai", channelId: "facebook" });
  const at = Number(db.raw.prepare("SELECT created_at FROM messages WHERE customer_id = ?").get("facebook:psid-edge").created_at);
  assert.equal(isAdGreetingEcho(db, "facebook:psid-edge", AD_GREETING, at + FB_AD_GREETING_IDLE_MS), true);
  assert.equal(isAdGreetingEcho(db, "facebook:psid-edge", AD_GREETING, at + FB_AD_GREETING_IDLE_MS - 1), false);
  db.close();
});

test("อ่านฐานข้อมูลไม่ได้ = ถือเป็นคนพิมพ์", () => {
  const broken = { raw: { prepare: () => { throw new Error("db closed"); } } };
  assert.equal(isAdGreetingEcho(broken, "facebook:x", AD_GREETING), false);
});

test("แอดมินพิมพ์ทักห้องเงียบแบบไม่มีรูปข้อความของแอด = ยังพัก 15 นาที", async () => {
  const db = memoryDb();
  const { post } = fbHarness({ db });
  const before = Date.now();
  await post(fbEcho("psid-admin", "สวัสดีค่ะ คุณเอ สะดวกคุยตอนนี้ไหมคะ", "m-ad-5"));
  assert.ok(db.getCustomer("facebook:psid-admin").operator_active_until >= before + OPERATOR_PAUSE_MS - 2000);
  db.close();
});

test("รูปข้อความทักของแอด: จับเฉพาะ สวัสดี + คุณชื่อ + ! + ไม่ทราบว่า (ตัวอย่างจริงจาก echo 90 วัน)", () => {
  for (const text of [
    AD_GREETING,
    "สวัสดีค่ะ คุณทดสอบ! ไม่ทราบว่า ทราบเนื้อหาการสอน AI ของพี่ง้วง หรือยังคะ ?",
    "สวัสดีค่ะ คุณ Mocha Latte! ลูกแพร นะคะ\nไม่ทราบว่า ปกติเคยใช้ Chatgpt มาก่อนมั้ยคะ ?",
  ]) assert.equal(looksLikeAdGreeting(text), true, text);
  for (const text of [
    "สวัสดีค่ะ", "สวัสดีค่ะ คุณเอ สะดวกคุยไหมคะ", "สวัสดีค่ะ คุณเอ! ขอโทษที่ให้รอนะคะ", "คุณเอ! ไม่ทราบว่าสนใจไหมคะ", "ขอบคุณค่ะ คุณเอ!", "[image]", "", null, undefined,
    `สวัสดีค่ะ คุณ${"ก".repeat(41)}! ไม่ทราบว่า`, "สวัสดีค่ะ คุณเอ\nไม่ทราบว่ามีอะไรให้ช่วยไหมคะ!",
  ]) assert.equal(looksLikeAdGreeting(text), false, String(text));
});

test("นโยบายที่ 4: ห้องที่คนกดปิด AI เองไว้ ห้าม echo ไปเปิดคืนหรือแตะสวิตช์", async () => {
  const db = memoryDb();
  const { post } = fbHarness({ db });
  db.upsertCustomer("facebook:psid-off", { channelId: "facebook" });
  db.setAiEnabled("facebook:psid-off", false, MANUAL_AI_OFF_REASON);
  await post(fbEcho("psid-off", "ทีมงานดูแลต่อค่ะ", "m-echo-off"));
  const customer = db.getCustomer("facebook:psid-off");
  assert.equal(customer.ai_enabled, 0, "ปิดอยู่แล้วต้องปิดต่อ");
  assert.equal(customer.ai_off_reason, MANUAL_AI_OFF_REASON, "ห้ามเขียนเหตุทับของคนจริง");
  db.close();
});

// audit ของ echo ต้องเป็น "ต่อหนึ่งหน้าต่างพัก" ไม่ใช่ต่อหนึ่ง echo — ของจริงมี echo
// ราว 120 ครั้ง/วัน ส่วน listAudit อ่านได้แค่ 500 แถวล่าสุดของทั้งระบบ ถ้าจดทุกครั้ง
// ร่องรอยเส้นเงิน/การปิด AI/ปุ่มที่คนกด จะถูกดันหลุดหน้าต่างภายในไม่กี่วัน
test("นโยบายที่ 4: audit จดครั้งเดียวตอนเริ่มพัก — echo ที่ต่ออายุห้ามท่วม audit", async () => {
  const db = memoryDb();
  const { post } = fbHarness({ db });
  const key = "facebook:psid-audit";
  const takeoverRows = () => db.listAudit(500)
    .filter((row) => row.action === "fb_human_takeover" && row.target === key);

  await post(fbEcho("psid-audit", "สวัสดีค่ะ ทีมงานดูแลต่อนะคะ", "m-audit-1"));
  assert.equal(takeoverRows().length, 1, "echo แรก = เริ่มหน้าต่างพัก ต้องจด 1 แถว");
  assert.match(takeoverRows()[0].detail, /พัก AI 15 นาที/u, "ข้อความไทยเดิมต้องคงอยู่");
  const firstUntil = db.getCustomer(key).operator_active_until;

  // อีก 1 นาทีต่อมา: หน้าต่างเดิมยังเปิดอยู่ = ต่ออายุ แต่ห้ามจดซ้ำ
  await post(fbEcho("psid-audit", "เดี๋ยวเช็คให้นะคะ", "m-audit-2"));
  assert.equal(takeoverRows().length, 1, "ต่ออายุหน้าต่างที่เปิดอยู่ ห้ามเพิ่มแถว audit");
  assert.ok(db.getCustomer(key).operator_active_until >= firstUntil, "แต่การต่ออายุต้องเกิดขึ้นจริง");

  // 16 นาทีหลัง echo ล่าสุด: หน้าต่างที่ปิดไปตอนนาทีที่ 15 หมดอายุแล้ว = เริ่มรอบใหม่
  db.setOperatorActiveUntil(key, Date.now() - 60_000);
  await post(fbEcho("psid-audit", "กลับมาแล้วค่ะ", "m-audit-3"));
  assert.equal(takeoverRows().length, 2, "ตอบใหม่หลังหน้าต่างหมดอายุ = เริ่มหน้าต่างใหม่ ต้องจด");
  assert.ok(db.getCustomer(key).operator_active_until > Date.now(), "และต้องพักใหม่จริง");
  db.close();
});
