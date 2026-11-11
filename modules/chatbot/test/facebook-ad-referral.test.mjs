// facebookWebhook + referral ของแอด (คำสั่งพี่ง้วง 6 ต.ค. 2026: "แอดตัวไหนพาคนแบบไหนมา")
//
// กติกาที่เทสต์นี้คุม:
// 1. เก็บที่มาจากแอดได้ทั้งข้อความแรกหลังคลิกแอด (message.referral) ปุ่มเริ่มต้น (postback.referral)
//    และเธรดเดิมที่กดแอดเข้ามาใหม่ (event referral ล้วน ๆ ที่ไม่มีข้อความ)
// 2. ห้ามเปลี่ยนวิธีตอบ: ไปป์ไลน์ต้องได้ event หน้าตาเดิมเป๊ะ เกตลูกค้าเก่ายังทำงานเหมือนเดิม
//    event referral ล้วนต้องไม่สร้างแถวลูกค้า (ไม่งั้นข้อความแรกจริงจะข้ามเกต !existing)
// 3. สวิตช์ปิด (ค่าเริ่มต้น) = ไม่เขียนอะไรเลย · เก็บพังต้องไม่ทำให้ข้อความลูกค้าหาย
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memoryDb } from "./helpers.mjs";
import { createFacebookWebhook, AI_OFF_FB_UNVERIFIED, FB_KNOWN_CUSTOMERS_KEY } from "../src/facebookWebhook.mjs";
import { AD_REFERRAL_CAPTURE_KEY } from "../src/adReferral.mjs";

const APP_SECRET = "test-app-secret";
const sign = (raw) => `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;
const AD_ID = "120210000000000777";

function harness({ db, profile = { displayName: "ลีดจากแอด", pictureUrl: "" }, knownCustomers = null, draining = false } = {}) {
  if (knownCustomers) db.setSetting(FB_KNOWN_CUSTOMERS_KEY, JSON.stringify(knownCustomers));
  const pipelineCalls = [];
  const logs = [];
  const webhook = createFacebookWebhook({
    config: { lineWebhookBodyTimeoutMs: 1000 },
    db,
    pipeline: { handleEvent: async (event, ctx) => { pipelineCalls.push({ event, ctx }); } },
    lineRegistry: {
      forChannel: () => ({ getProfile: async () => profile }),
      channels: [{ id: "facebook", credentials: () => ({ appSecret: APP_SECRET, verifyToken: "v", pageAccessToken: "t" }) }],
    },
    readBody: async (req) => req._raw,
    json: (res, status, body) => { res.result = { status, body }; },
    logger: { error: (l) => logs.push(l), warn: (l) => logs.push(l), debug: () => {} },
    isDraining: () => draining,
  });
  const post = async (payload) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const res = {};
    await webhook.handleWebhook({ method: "POST", headers: { "x-hub-signature-256": sign(raw) }, _raw: raw }, res);
    return res.result;
  };
  return { post, pipelineCalls, logs };
}

const referral = (over = {}) => ({
  ref: "qmsg_a", source: "ADS", type: "OPEN_THREAD", ad_id: AD_ID,
  ads_context_data: { ad_title: "คลาส AI เจ้าของธุรกิจ", post_id: "1048_1" }, ...over,
});
const page = (...events) => ({ object: "page", entry: [{ id: "100000000000101", messaging: events }] });
const textEvent = (psid, mid, text, extra = {}) => ({
  sender: { id: psid }, recipient: { id: "page" }, timestamp: 1_790_000_000_000, message: { mid, text, ...extra },
});

test("สวิตช์ปิด (ค่าเริ่มต้น): ข้อความจากแอดเดินเหมือนเดิมทุกอย่าง และไม่มีแถว referral", async () => {
  const db = memoryDb();
  const { post, pipelineCalls } = harness({ db });
  const result = await post(page(textEvent("p-off", "m-off", "สนใจค่ะ", { referral: referral() })));
  assert.equal(result.status, 200);
  assert.equal(pipelineCalls.length, 1);
  assert.equal(db.listAdReferrals("facebook:p-off").length, 0);
  db.close();
});

test("ข้อความแรกหลังคลิกแอด: เก็บ ad_id/source/type/ref/เวลา + ไปป์ไลน์ได้ event เดิมเป๊ะ", async () => {
  const withRef = memoryDb();
  withRef.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  const plain = memoryDb();
  plain.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  const a = harness({ db: withRef });
  const b = harness({ db: plain });
  await a.post(page(textEvent("p-ad", "m-1", "สนใจคลาสค่ะ", { referral: referral() })));
  await b.post(page(textEvent("p-ad", "m-1", "สนใจคลาสค่ะ")));

  const rows = withRef.listAdReferrals("facebook:p-ad");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ad_id, AD_ID);
  assert.equal(rows[0].source, "ADS");
  assert.equal(rows[0].type, "OPEN_THREAD");
  assert.equal(rows[0].ref, "qmsg_a");
  assert.equal(rows[0].referral_at, 1_790_000_000_000);
  assert.equal(rows[0].event_kind, "message");
  assert.equal(rows[0].first_contact, 1, "ห้องนี้ไม่เคยมีมาก่อน = ห้องใหม่จากแอด");
  assert.equal(plain.listAdReferrals("facebook:p-ad").length, 0);

  // พฤติกรรมการตอบต้องเหมือนไม่มี referral ทุกไบต์ (event ที่ไปป์ไลน์เห็น + บริบท + สถานะห้อง)
  // session id เป็น UUID สุ่มต่อฐาน — เทียบว่ามี session เหมือนกัน ส่วนที่เหลือต้องตรงทุกไบต์
  const shape = (calls) => JSON.stringify(calls.map(({ event, ctx }) => ({
    event, ctx: { ...ctx, expectedSessionId: Boolean(ctx.expectedSessionId) },
  })));
  assert.equal(shape(a.pipelineCalls), shape(b.pipelineCalls));
  const pick = (c) => ({ ai: c.ai_enabled, reason: c.ai_off_reason, state: c.state, name: c.display_name });
  assert.deepEqual(pick(withRef.getCustomer("facebook:p-ad")), pick(plain.getCustomer("facebook:p-ad")));
  withRef.close();
  plain.close();
});

test("ปุ่มเริ่มต้น (postback.referral) ของเธรดใหม่ = เก็บเป็น kind postback", async () => {
  const db = memoryDb();
  db.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  const { post, pipelineCalls } = harness({ db });
  await post(page({
    sender: { id: "p-gs" }, recipient: { id: "page" }, timestamp: 1_790_000_100_000,
    postback: { title: "เริ่มต้นใช้งาน", payload: "GET_STARTED", referral: referral({ ref: "" }) },
  }));
  const rows = db.listAdReferrals("facebook:p-gs");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_kind, "postback");
  assert.equal(rows[0].ref, "");
  assert.equal(pipelineCalls.length, 1);
  db.close();
});

test("เธรดเดิมกดแอด (event referral ล้วน): เก็บที่มา แต่ไม่สร้างห้อง ไม่เข้าไปป์ไลน์ ข้อความแรกยังผ่านเกตลูกค้าเก่า", async () => {
  const db = memoryDb();
  db.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  // ตั้งรายชื่อลูกค้าเก่า + ดึงชื่อไม่ได้ = เกตต้องปิด AI ตอนข้อความแรกจริง (fail-closed)
  const { post, pipelineCalls } = harness({ db, profile: null, knownCustomers: ["สมชาย ใจดี"] });
  const result = await post(page({
    sender: { id: "p-old" }, recipient: { id: "page" }, timestamp: 1_790_000_200_000, referral: referral(),
  }));
  assert.equal(result.status, 200);
  assert.equal(result.body.accepted, 0, "event referral ล้วนไม่ใช่ข้อความ — ตัวนับเดิมไม่ขยับ");
  assert.equal(pipelineCalls.length, 0);
  assert.equal(db.getCustomer("facebook:p-old"), null, "ห้ามสร้างแถวลูกค้า ไม่งั้นข้อความแรกจะข้ามเกต");
  const rows = db.listAdReferrals("facebook:p-old");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_kind, "referral");
  assert.equal(rows[0].first_contact, 1, "ยังไม่มีห้องในระบบ ณ ตอนคลิก");

  await post(page(textEvent("p-old", "m-old-1", "สวัสดีครับ")));
  const customer = db.getCustomer("facebook:p-old");
  assert.equal(customer.ai_enabled, 0);
  assert.equal(customer.ai_off_reason, AI_OFF_FB_UNVERIFIED, "เกตลูกค้าเก่าต้องทำงานเหมือนไม่มี referral");
  assert.equal(pipelineCalls.length, 1);
  db.close();
});

test("ห้องที่มีอยู่แล้วกดแอดใหม่ = first_contact 0 · แอดคนละตัวเก็บแยกแถว", async () => {
  const db = memoryDb();
  db.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  const { post } = harness({ db });
  await post(page(textEvent("p-back", "m-b1", "สวัสดีค่ะ")));
  await post(page({
    sender: { id: "p-back" }, recipient: { id: "page" }, timestamp: 1_790_000_300_000,
    referral: referral({ ad_id: "120210000000000888" }),
  }));
  const rows = db.listAdReferrals("facebook:p-back");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ad_id, "120210000000000888");
  assert.equal(rows[0].first_contact, 0);
  db.close();
});

test("Meta ส่ง webhook ซ้ำ = แถวเดียว · echo ของเพจที่มี referral ไม่ถูกเก็บ", async () => {
  const db = memoryDb();
  db.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  const { post } = harness({ db });
  const payload = page(textEvent("p-dup", "m-dup", "ราคาเท่าไหร่", { referral: referral() }));
  await post(payload);
  await post(payload);
  assert.equal(db.listAdReferrals("facebook:p-dup").length, 1);
  await post(page({
    sender: { id: "page" }, recipient: { id: "p-echo" }, timestamp: 9,
    message: { mid: "m-echo", is_echo: true, text: "ทีมตอบ", referral: referral() },
  }));
  assert.equal(db.listAdReferrals("facebook:p-echo").length, 0);
  db.close();
});

test("เก็บ referral พัง = ข้อความลูกค้ายังบันทึกและเข้าไปป์ไลน์ครบ (ไม่ตอบ 500 ให้ Meta ส่งซ้ำ)", async () => {
  const db = memoryDb();
  db.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  db.recordAdReferral = () => { throw new Error("database is locked"); };
  const { post, pipelineCalls, logs } = harness({ db });
  const result = await post(page(textEvent("p-err", "m-err", "สนใจค่ะ", { referral: referral() })));
  assert.equal(result.status, 200);
  assert.equal(pipelineCalls.length, 1);
  const stored = db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id = ?").get("facebook:p-err").n;
  assert.equal(stored, 1);
  assert.ok(logs.some((line) => String(line).includes("referral")));
  db.close();
});

test("ระหว่างระบบกำลังปิด: ยังเก็บที่มาจากแอดของข้อความที่บันทึกไว้", async () => {
  const db = memoryDb();
  db.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  const { post, pipelineCalls } = harness({ db, draining: true });
  await post(page(textEvent("p-drain", "m-drain", "สนใจค่ะ", { referral: referral() })));
  assert.equal(pipelineCalls.length, 0);
  assert.equal(db.listAdReferrals("facebook:p-drain").length, 1);
  db.close();
});
