// สำเนารูปแอดในฐานข้อมูล (พี่ง้วง 6 ต.ค. 2026 ค่ำ: "ให้รูปอยู่ตลอดดีกว่า เพราะจะได้เช็ค และทำ analytic ใดๆง่าย")
// ลิงก์ CDN ของ Meta หมดอายุไม่กี่วัน → โหลดเก็บครั้งเดียวต่อแอด แล้วคอนโซลเสิร์ฟจากฐานข้อมูลเอง
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { AD_THUMB_MAX_BYTES, createAdThumbKeeper, fetchAdThumb, sniffImageType } from "../src/adThumbs.mjs";
import { adReferralCardView } from "../src/adReferralView.mjs";
import { createFacebookWebhook } from "../src/facebookWebhook.mjs";
import { AD_REFERRAL_CAPTURE_KEY } from "../src/adReferral.mjs";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { httpRequest, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const AD = "120200000000000401";
const CDN = "https://scontent.fbkk22-3.fna.fbcdn.net/v/t39.30808-6/ad.jpg?oe=6720";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const T0 = Date.parse("2026-10-06T20:45:00+07:00");

const imageResponse = (bytes, { status = 200, headers = {} } = {}) => new Response(bytes, { status, headers });
function stubFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  fn.calls = calls;
  return fn;
}
function record(db, customerId, over = {}) {
  return db.recordAdReferral({
    customerId, channelId: "facebook", source: "ADS", type: "OPEN_THREAD", adId: AD,
    adTitle: "C | ได้ทุกสูตร | make flow - 2 (โพสต์เดิม)", eventKind: "referral", firstContact: true,
    referralAt: T0, photoUrl: CDN, mediaType: "photo", postId: "100000000000101_100000000000501", ...over,
  });
}

test("ชนิดรูปดูจากไบต์หัวไฟล์ ไม่เชื่อ header", () => {
  assert.equal(sniffImageType(JPEG), "image/jpeg");
  assert.equal(sniffImageType(PNG), "image/png");
  assert.equal(sniffImageType(new TextEncoder().encode("RIFF1234WEBPVP8 ")), "image/webp");
  assert.equal(sniffImageType(new TextEncoder().encode("GIF89a")), "image/gif");
  assert.equal(sniffImageType(new TextEncoder().encode("<html><script>")), "");
  assert.equal(sniffImageType(new Uint8Array()), "");
});

test("โหลดรูป: รับเฉพาะ CDN Meta · ไม่ตามเปลี่ยนทาง · ไม่ใช่รูป/ใหญ่เกิน/CDN ตอบพัง = throw", async () => {
  const ok = stubFetch(() => imageResponse(JPEG, { headers: { "content-type": "text/plain" } }));
  const got = await fetchAdThumb(CDN, { fetchImpl: ok });
  assert.equal(got.contentType, "image/jpeg", "ชนิดมาจากไบต์ ไม่ใช่ header");
  assert.equal(ok.calls[0].init.redirect, "error");

  const never = stubFetch(() => { throw new Error("ห้ามถูกเรียก"); });
  await assert.rejects(fetchAdThumb("https://evil.example/x.jpg", { fetchImpl: never }), /CDN ของ Meta/u);
  await assert.rejects(fetchAdThumb("http://scontent.fbcdn.net/x.jpg", { fetchImpl: never }), /CDN ของ Meta/u);
  assert.equal(never.calls.length, 0);

  await assert.rejects(fetchAdThumb(CDN, { fetchImpl: stubFetch(() => imageResponse(new TextEncoder().encode("<html>"))) }), /ไม่ใช่รูป/u);
  await assert.rejects(fetchAdThumb(CDN, { fetchImpl: stubFetch(() => imageResponse(JPEG, { status: 403 })) }), /403/u);
  const huge = new Uint8Array(AD_THUMB_MAX_BYTES + 10); huge.set(JPEG);
  await assert.rejects(fetchAdThumb(CDN, { fetchImpl: stubFetch(() => imageResponse(huge)) }), /ใหญ่เกิน/u);
  await assert.rejects(
    fetchAdThumb(CDN, { fetchImpl: stubFetch(() => imageResponse(JPEG, { headers: { "content-length": String(AD_THUMB_MAX_BYTES + 1) } })) }),
    /ใหญ่เกิน/u,
  );
});

test("ตัวเก็บรูป: เก็บแอดที่ยังไม่มีสำเนาครั้งเดียว · ลิงก์ล่าสุดของแอด · ล้มแล้วพักแอดนั้นไว้ ไม่ยิงซ้ำทุกครั้ง", async () => {
  let clock = T0;
  const db = memoryDb({ now: () => clock });
  record(db, "facebook:u1", { photoUrl: `${CDN}&old=1`, referralAt: T0 });
  record(db, "facebook:u2", { referralAt: T0 + 1000 });
  record(db, "facebook:u3", { adId: "120200000000000402", photoUrl: "https://scontent.fbcdn.net/expired.jpg" });
  const fetchImpl = stubFetch((url) => (url.includes("expired") ? imageResponse(JPEG, { status: 403 }) : imageResponse(PNG)));
  const keeper = createAdThumbKeeper({ db, fetchImpl, logger: silent, now: () => clock });

  const first = await keeper.kick({ force: true });
  assert.deepEqual(first, { saved: 1, failed: 1 });
  assert.equal(fetchImpl.calls.find((c) => !c.url.includes("expired")).url, CDN, "ใช้ลิงก์ล่าสุดของแอด");
  const thumb = db.adThumbFor(AD);
  assert.equal(thumb.content_type, "image/png");
  assert.equal(thumb.byte_size, PNG.length);
  assert.equal(db.adsMissingThumb().length, 1, "เหลือแอดที่ลิงก์หมดอายุ");

  clock += 120_000;
  const second = await keeper.kick({ force: true });
  assert.deepEqual(second, { saved: 0, failed: 0 }, "แอดที่เพิ่งล้มถูกพักไว้ 6 ชม.");
  assert.equal(keeper.kick(), null, "ไม่ force = เว้นระยะ 1 นาที");
  db.close();
});

test("ตัวเก็บรูป: ปลุกซ้ำระหว่างวิ่ง = วิ่งอีกรอบหลังจบ (แอดที่เพิ่งคลิกไม่ตกหล่น)", async () => {
  const db = memoryDb();
  record(db, "facebook:u1");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = stubFetch(async () => { await gate; return imageResponse(JPEG); });
  const keeper = createAdThumbKeeper({ db, fetchImpl, logger: silent });
  const running = keeper.kick({ force: true });
  record(db, "facebook:u2", { adId: "120200000000000403", photoUrl: `${CDN}&b=1` });
  assert.equal(keeper.kick({ force: true }), running, "ระหว่างวิ่งคืนงานเดิม");
  release();
  const total = await running;
  assert.equal(total.saved, 2);
  assert.equal(db.adsMissingThumb().length, 0);
  db.close();
});

test("view: มีสำเนาแล้วใช้ที่อยู่ในคอนโซล (ไม่หมดอายุ) · ยังไม่มี = ลิงก์ CDN ไปพลาง + ปลุกตัวเก็บรูป", () => {
  const db = memoryDb();
  record(db, "facebook:u1");
  let kicks = 0;
  const before = adReferralCardView(db, "facebook:u1", { logger: silent, onMissingThumb: () => { kicks += 1; } });
  assert.equal(before.ads[0].photoUrl, CDN);
  assert.equal(kicks, 1);

  const saved = db.saveAdThumb({ adId: AD, contentType: "image/jpeg", bytes: JPEG, sourceUrl: CDN });
  const after = adReferralCardView(db, "facebook:u1", { logger: silent, onMissingThumb: () => { kicks += 1; } });
  assert.equal(after.ads[0].photoUrl, `/console/api/ad-thumbs/${AD}?v=${saved.sha256.slice(0, 16)}`);
  assert.equal(after.ads[0].mediaType, "photo");
  assert.equal(kicks, 1, "มีสำเนาแล้วไม่ต้องปลุก");
  db.close();
});

test("webhook: จดที่มาจากแอดได้ = ปลุกตัวเก็บรูป · ไม่มี referral / สวิตช์ปิด = ไม่ปลุก · ตัวปลุกพังข้อความยังเข้า", async () => {
  const APP_SECRET = "thumb-app-secret";
  const db = memoryDb();
  db.setSetting(AD_REFERRAL_CAPTURE_KEY, "on");
  let kicks = 0;
  let explode = false;
  const pipelineCalls = [];
  const webhook = createFacebookWebhook({
    config: { lineWebhookBodyTimeoutMs: 1000 }, db,
    pipeline: { handleEvent: async (event) => { pipelineCalls.push(event); } },
    lineRegistry: {
      forChannel: () => ({ getProfile: async () => ({ displayName: "ลีด", pictureUrl: "" }) }),
      channels: [{ id: "facebook", credentials: () => ({ appSecret: APP_SECRET, verifyToken: "v", pageAccessToken: "t" }) }],
    },
    readBody: async (req) => req._raw,
    json: (res, status, body) => { res.result = { status, body }; },
    logger: silent,
    onAdReferralCaptured: () => { kicks += 1; if (explode) throw new Error("keeper down"); },
  });
  const post = async (events) => {
    const raw = Buffer.from(JSON.stringify({ object: "page", entry: [{ id: "100000000000101", messaging: events }] }));
    const res = {};
    await webhook.handleWebhook({ method: "POST", headers: { "x-hub-signature-256": `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}` }, _raw: raw }, res);
    return res.result;
  };
  const ref = { source: "ADS", ad_id: AD, ads_context_data: { ad_title: "x", photo_url: CDN } };
  await post([{ sender: { id: "p1" }, recipient: { id: "page" }, timestamp: T0, message: { mid: "m1", text: "สนใจ", referral: ref } }]);
  assert.equal(kicks, 1);
  await post([{ sender: { id: "p2" }, recipient: { id: "page" }, timestamp: T0, message: { mid: "m2", text: "สวัสดี" } }]);
  assert.equal(kicks, 1, "ข้อความธรรมดาไม่ปลุก");
  explode = true;
  const result = await post([{ sender: { id: "p3" }, recipient: { id: "page" }, timestamp: T0 + 5, message: { mid: "m3", text: "สนใจ", referral: ref } }]);
  assert.equal(result.status, 200);
  assert.equal(kicks, 2);
  assert.equal(pipelineCalls.length, 3, "ตัวปลุกพังข้อความลูกค้ายังเข้าไปป์ไลน์ครบ");
  db.close();
});

// ---------------------------------------------------------------- เส้นเสิร์ฟรูป

const PASSWORD = ["thumb", "pass", "123", "x"].join("-");
const SESSION_KEY = ["thumb", "fixture", "0123456789"].join("-");
const PASS_HASH = hashPassword(PASSWORD);

test("เส้นเสิร์ฟรูป: ต้องล็อกอิน · ทีมงานเปิดได้ · ชนิด/ETag/nosniff ถูก · 304 เมื่อรูปเดิม · ไม่มีรูป/เลขแอดผิด = 404", async (t) => {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: PASS_HASH, displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chompoo", passHash: PASS_HASH, displayName: "ชมพู่", role: "operator" });
  const saved = db.saveAdThumb({ adId: AD, contentType: "image/jpeg", bytes: JPEG, sourceUrl: CDN });
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_KEY }), db, logger: silent,
    overrides: { adThumbFetch: stubFetch(() => imageResponse(JPEG)) },
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const anon = await httpRequest(app.server, { path: `/console/api/ad-thumbs/${AD}` });
  assert.notEqual(anon.status, 200, "ไม่ล็อกอินต้องไม่ได้รูป");

  const login = await httpRequest(app.server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "chompoo", password: PASSWORD }),
  });
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const res = await httpRequest(app.server, { path: `/console/api/ad-thumbs/${AD}?v=x`, headers: { cookie } });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.headers["content-type"], "image/jpeg");
  assert.equal(res.headers["x-content-type-options"], "nosniff");
  assert.equal(res.headers.etag, `"${saved.sha256}"`);
  assert.equal(Number(res.headers["content-length"]), JPEG.length);

  const again = await httpRequest(app.server, { path: `/console/api/ad-thumbs/${AD}`, headers: { cookie, "if-none-match": `"${saved.sha256}"` } });
  assert.equal(again.status, 304);
  assert.equal((await httpRequest(app.server, { path: "/console/api/ad-thumbs/120000000000000001", headers: { cookie } })).status, 404);
  assert.equal((await httpRequest(app.server, { path: "/console/api/ad-thumbs/..%2Fetc", headers: { cookie } })).status, 404);
});

test("แอดที่โหลดพังถาวรไม่กินคิวแอดใหม่ · หาลิงก์ล่าสุดใช้ดัชนี ad_id (รีวิว 6 ต.ค. ค่ำ)", async () => {
  let clock = T0;
  const db = memoryDb({ now: () => clock });
  for (let i = 0; i < 3; i += 1) {
    record(db, `facebook:dead${i}`, { adId: `12000000000000000${i}`, photoUrl: `https://scontent.fbcdn.net/expired${i}.jpg`, referralAt: T0 + i });
  }
  const fetchImpl = stubFetch((url) => (url.includes("expired") ? imageResponse(JPEG, { status: 403 }) : imageResponse(JPEG)));
  const keeper = createAdThumbKeeper({ db, fetchImpl, logger: silent, now: () => clock, batch: 2 });
  await keeper.kick({ force: true });
  record(db, "facebook:fresh", { adId: "120000000000000009", referralAt: T0 - 5000 }); // คลิกเก่ากว่า แต่ยังไม่เคยลอง
  clock += 120_000;
  const result = await keeper.kick({ force: true });
  assert.equal(result.saved, 1, "แอดใหม่ได้คิวแม้มีแอดพังค้างเต็มหน้าต่าง");
  assert.ok(db.adThumbFor("120000000000000009"));

  const plan = db.raw.prepare(`EXPLAIN QUERY PLAN SELECT photo_url FROM customer_ad_referrals
    WHERE ad_id = ? AND photo_url <> '' ORDER BY referral_at DESC, rowid DESC LIMIT 1`).all("1").map((r) => r.detail).join(" | ");
  assert.match(plan, /idx_customer_ad_referrals_ad/u);
  db.close();
});

test("stop(): หลังเริ่มปิดบริการ ไม่เริ่มรอบใหม่และไม่โหลดรูปเพิ่ม", async () => {
  const db = memoryDb();
  record(db, "facebook:u1");
  const fetchImpl = stubFetch(() => imageResponse(JPEG));
  const keeper = createAdThumbKeeper({ db, fetchImpl, logger: silent });
  keeper.stop();
  assert.equal(keeper.kick({ force: true }), null);
  assert.equal(fetchImpl.calls.length, 0);
  db.close();
});
