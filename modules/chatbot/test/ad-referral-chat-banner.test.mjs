// แถบ "มาจากโฆษณา" ในหน้าแชท + ป้าย AD บนรายการ (พี่ง้วง 6 ต.ค. 2026 ค่ำ: "ads id ให้อยู่ในหน้าแชทของลูกค้า
// เหมือน facebook ... มองง่ายเห็นง่าย ว่ามาจาก ads ไหน") — ขาเข้าเก็บโพสต์/รูปแอด · DB รวมแถวเป็นแอด ·
// API ส่งให้ทุกคนที่เปิดห้องได้ (ลิงก์ตัวจัดการโฆษณาเฉพาะเจ้าของ) · หน้าเว็บเรนเดอร์จริงด้วย DOM จำลอง
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractAdReferral } from "../src/adReferral.mjs";
import { openDb } from "../src/db.mjs";
import { adPostUrl, adReferralCardView, adsManagerUrl } from "../src/adReferralView.mjs";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";
import { httpRequest, listen, memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const AD_A = "120200000000000404";
const AD_B = "120200000000000405";
const PHOTO = "https://scontent.fbkk5-1.fna.fbcdn.net/v/t45.1600-4/ad.jpg?oh=abc&oe=6720";
const T0 = Date.parse("2026-10-06T21:15:00+07:00");

function record(db, customerId, over = {}) {
  return db.recordAdReferral({
    customerId, channelId: "facebook", source: "ADS", type: "OPEN_THREAD", adId: AD_A,
    adTitle: "A | ได้ทุกสูตร | make flow - 2 (โพสต์เดิม)", eventKind: "referral", firstContact: true,
    referralAt: T0, ...over,
  });
}

// ---------------------------------------------------------------- ขาเข้า

test("ขาเข้า: เก็บ post_id + รูปแอดจาก CDN ของ Meta · ไม่มีรูปแล้วใช้ภาพปกวิดีโอ", () => {
  const photo = extractAdReferral({
    timestamp: T0,
    referral: { source: "ADS", ad_id: AD_A, ads_context_data: { ad_title: "x", photo_url: PHOTO, post_id: "100000000000101_1234" } },
  });
  assert.equal(photo.postId, "100000000000101_1234");
  assert.equal(photo.photoUrl, PHOTO);
  assert.equal(photo.mediaType, "photo");

  const video = extractAdReferral({
    referral: { source: "ADS", ad_id: AD_A, ads_context_data: { video_url: "https://video.xx.fbcdn.net/thumb.jpg" } },
  });
  assert.equal(video.photoUrl, "https://video.xx.fbcdn.net/thumb.jpg");
  assert.equal(video.mediaType, "video");
});

test("ขาเข้า: รูปนอก Meta / http / javascript: / มีช่องว่าง / ยาวเกิน = ไม่เก็บ · post_id ผิดรูป = ไม่เก็บ", () => {
  const bad = [
    "http://scontent.fbcdn.net/x.jpg",
    "https://evil.example/x.jpg",
    "https://fbcdn.net.evil.example/x.jpg",
    "javascript:alert(1)",
    "https://scontent.fbcdn.net/x .jpg",
    "https://user:pw@scontent.fbcdn.net/x.jpg",
    `https://scontent.fbcdn.net/${"a".repeat(2100)}`,
  ];
  for (const url of bad) {
    const got = extractAdReferral({ referral: { source: "ADS", ad_id: AD_A, ads_context_data: { photo_url: url } } });
    assert.equal(got.photoUrl, "", url);
    assert.equal(got.mediaType, "", url);
  }
  // เรียกซ้ำหลายรอบต้องได้ผลเดิม (regex ธง g เคยทำให้ผลสลับ)
  for (let i = 0; i < 3; i += 1) {
    assert.equal(extractAdReferral({ referral: { source: "ADS", ads_context_data: { photo_url: PHOTO } } }).photoUrl, PHOTO);
  }
  for (const postId of ["1048_99<script>", "abc", "1_2_3", 1048]) {
    assert.equal(extractAdReferral({ referral: { source: "ADS", ads_context_data: { post_id: postId } } }).postId, "", String(postId));
  }
});

// ---------------------------------------------------------------- DB

test("DB เก่าที่สร้างตารางก่อนมีคอลัมน์รูป: เปิดแล้วเติมคอลัมน์ให้ แถวเดิมยังอ่านได้", () => {
  const dir = mkdtempSync(join(tmpdir(), "adref-mig-"));
  const file = join(dir, "old.sqlite");
  try {
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE customer_ad_referrals (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT 'facebook',
      source TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT '', ad_id TEXT NOT NULL DEFAULT '',
      ref TEXT NOT NULL DEFAULT '', ad_title TEXT NOT NULL DEFAULT '',
      event_kind TEXT NOT NULL DEFAULT '' CHECK (event_kind IN ('', 'message', 'postback', 'referral')),
      first_contact INTEGER NOT NULL DEFAULT 0, referral_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
      INSERT INTO customer_ad_referrals (id, customer_id, ad_id, ad_title, source, referral_at, created_at)
        VALUES ('r1', 'facebook:old', '${AD_A}', 'แอดเก่า', 'ADS', ${T0}, ${T0});`);
    old.close();
    const db = openDb({ file });
    const columns = db.raw.prepare("PRAGMA table_info(customer_ad_referrals)").all().map((c) => c.name);
    for (const column of ["post_id", "photo_url", "media_type"]) assert.ok(columns.includes(column), column);
    const card = db.adReferralCardFor("facebook:old");
    assert.equal(card.ads[0].adTitle, "แอดเก่า");
    assert.equal(card.ads[0].photoUrl, "");
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DB: คลิกเดียว 2 event (referral + message) = แอดเดียว · ใหม่สุดก่อน · ชื่อ/รูปใช้ค่าล่าสุดที่ไม่ว่าง", () => {
  const db = memoryDb();
  record(db, "facebook:u1", { eventKind: "referral", referralAt: T0 });
  record(db, "facebook:u1", { eventKind: "message", referralAt: T0 + 400, photoUrl: PHOTO, mediaType: "photo", postId: "1048_1" });
  record(db, "facebook:u1", {
    adId: AD_B, adTitle: "B | ได้ทุกสูตร", eventKind: "referral", firstContact: false, referralAt: T0 + 86_400_000,
  });
  const card = db.adReferralCardFor("facebook:u1");
  assert.equal(card.adCount, 2);
  assert.equal(card.firstContact, true, "ห้องเปิดครั้งแรกจากแอด A = ลูกค้าใหม่จากแอด");
  assert.equal(card.ads[0].adId, AD_B, "แอดที่กดล่าสุดขึ้นก่อน");
  assert.equal(card.ads[1].adId, AD_A);
  assert.equal(card.ads[1].photoUrl, PHOTO);
  assert.equal(card.ads[1].mediaType, "photo");
  assert.equal(card.ads[1].postId, "1048_1");
  assert.equal(card.firstAt, T0);
  assert.equal(db.adReferralCardFor("facebook:none"), null);

  // ไม่มีรูป = media_type ว่างเสมอ (กันป้าย ▶ ลอยบนภาพสำรอง)
  record(db, "facebook:u2", { mediaType: "video" });
  assert.equal(db.listAdReferrals("facebook:u2")[0].media_type, "");
  db.close();
});

test("DB: ป้ายรายการอ่านทั้งหน้าในคิวรีเดียว — แอดล่าสุดต่อห้อง + จำนวนแอดที่เคยกด", () => {
  const db = memoryDb();
  record(db, "facebook:u1");
  record(db, "facebook:u1", { eventKind: "message", referralAt: T0 + 300 });
  record(db, "facebook:u2", { adId: AD_B, adTitle: "B", referralAt: T0 });
  record(db, "facebook:u2", { adId: AD_A, referralAt: T0 + 1000 });
  const ids = ["facebook:u1", "facebook:u2", "facebook:none", ...Array.from({ length: 900 }, (_, i) => `facebook:x${i}`)];
  const chips = db.latestAdReferralsFor(ids);
  assert.equal(chips.size, 2);
  assert.deepEqual(
    { ...chips.get("facebook:u1") },
    { adId: AD_A, source: "ADS", ref: "", adTitle: "A | ได้ทุกสูตร | make flow - 2 (โพสต์เดิม)", lastAt: T0 + 300, adCount: 1 },
  );
  assert.equal(chips.get("facebook:u2").adId, AD_A);
  assert.equal(chips.get("facebook:u2").adCount, 2);
  assert.equal(db.latestAdReferralsFor([]).size, 0);
  db.close();
});

// ---------------------------------------------------------------- view

test("ลิงก์: ตัวจัดการโฆษณาต้องรู้บัญชี + เลขแอดตัวเลขล้วน · โพสต์ต้องเป็นเลขโพสต์", () => {
  assert.equal(
    adsManagerUrl("act_100000000000001", AD_A),
    `https://adsmanager.facebook.com/adsmanager/manage/ads?act=100000000000001&selected_ad_ids=${AD_A}`,
  );
  assert.equal(adsManagerUrl("100000000000001", AD_A)?.includes("act=100000000000001"), true);
  assert.equal(adsManagerUrl("", AD_A), null);
  assert.equal(adsManagerUrl("act_1", "12a"), null);
  assert.equal(adPostUrl("100000000000101_1234"), "https://www.facebook.com/100000000000101_1234");
  assert.equal(adPostUrl("x"), null);
});

test("view: อ่าน DB พัง = ไม่มีแถบ (ห้องแชทยังเปิดได้)", () => {
  const warnings = [];
  const db = { adReferralCardFor() { throw new Error("database is locked"); } };
  assert.equal(adReferralCardView(db, "facebook:u1", { logger: { warn: (m) => warnings.push(m) } }), null);
  assert.equal(warnings.length, 1);
});

// ---------------------------------------------------------------- API

const PASSWORD = ["ad", "chip", "pass", "123"].join("-");
const SESSION_KEY = ["ad", "chip", "fixture", "0123456789"].join("-");
const PASS_HASH = hashPassword(PASSWORD);

async function start(t) {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: PASS_HASH, displayName: "พี่ง้วง", role: "owner" });
  db.createOperator({ username: "chompoo", passHash: PASS_HASH, displayName: "ชมพู่", role: "operator" });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: SESSION_KEY }), db, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server, username) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: PASSWORD }),
  });
  assert.equal(res.status, 200, res.text);
  return { cookie: res.headers["set-cookie"][0].split(";")[0] };
}

function seedRooms(db) {
  db.upsertCustomer("facebook:ad-room", { displayName: "ลูกค้าจากแอด", channelId: "facebook" });
  db.insertMessage({ customerId: "facebook:ad-room", direction: "in", content: "สนใจคลาสค่ะ" });
  record(db, "facebook:ad-room", { photoUrl: PHOTO, mediaType: "photo", postId: "100000000000101_1234" });
  db.upsertCustomer("facebook:plain", { displayName: "ลูกค้าธรรมดา", channelId: "facebook" });
  db.insertMessage({ customerId: "facebook:plain", direction: "in", content: "สวัสดีค่ะ" });
  db.upsertAdsSpend({ day: "2026-10-06", spendThb: 2500, accountId: "act_100000000000001", source: "make" });
}

test("API: ห้องจากแอดได้ adReferral · เจ้าของได้ลิงก์ตัวจัดการโฆษณา · ทีมงานเห็นชื่อแอดแต่ไม่ได้ลิงก์นั้น", async (t) => {
  const { app, db } = await start(t);
  seedRooms(db);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");
  const path = `/console/api/conversations/${encodeURIComponent("facebook:ad-room")}/messages`;

  const mine = await httpRequest(app.server, { path, headers: { cookie: owner.cookie } });
  assert.equal(mine.status, 200, mine.text);
  const ad = mine.json.adReferral.ads[0];
  assert.equal(ad.adId, AD_A);
  assert.equal(ad.adTitle, "A | ได้ทุกสูตร | make flow - 2 (โพสต์เดิม)");
  assert.equal(ad.photoUrl, PHOTO);
  assert.equal(ad.postUrl, "https://www.facebook.com/100000000000101_1234");
  assert.match(ad.adsManagerUrl, /act=100000000000001&selected_ad_ids=120200000000000404$/u);
  assert.equal(mine.json.adReferral.firstContact, true);

  const theirs = await httpRequest(app.server, { path, headers: { cookie: staff.cookie } });
  assert.equal(theirs.status, 200, theirs.text);
  assert.equal(theirs.json.adReferral.ads[0].adTitle, "A | ได้ทุกสูตร | make flow - 2 (โพสต์เดิม)");
  assert.equal(theirs.json.adReferral.ads[0].adsManagerUrl, null);

  const plain = await httpRequest(app.server, {
    path: `/console/api/conversations/${encodeURIComponent("facebook:plain")}/messages`, headers: { cookie: owner.cookie },
  });
  assert.equal(plain.json.adReferral, null);

  const inbox = await httpRequest(app.server, { path: "/console/api/inbox", headers: { cookie: staff.cookie } });
  assert.equal(inbox.status, 200, inbox.text);
  const byId = Object.fromEntries(inbox.json.conversations.map((row) => [row.line_user_id, row]));
  assert.equal(byId["facebook:ad-room"].ad_referral.adId, AD_A);
  assert.equal(byId["facebook:ad-room"].ad_referral.adCount, 1);
  assert.equal(byId["facebook:plain"].ad_referral, null);
});

// ---------------------------------------------------------------- หน้าเว็บ

function findAll(node, predicate, out = []) {
  for (const child of node?.children || []) {
    if (child?.nodeType !== 1) continue;
    if (predicate(child)) out.push(child);
    findAll(child, predicate, out);
  }
  return out;
}
const textOf = (node) => (node?.nodeType === 3 ? node.textContent : (node?.children || []).map(textOf).join(""));
const byClass = (root, cls) => findAll(root, (n) => n._classes().has(cls));

const card = (over = {}) => ({
  firstContact: true, firstAt: T0, lastAt: T0, adCount: 1,
  ads: [{
    key: `ad:${AD_A}`, adId: AD_A, source: "ADS", ref: "", adTitle: "A | ได้ทุกสูตร | make flow - 2 (โพสต์เดิม)",
    postId: "1048_1", photoUrl: PHOTO, mediaType: "photo", firstAt: T0, lastAt: T0,
    postUrl: "https://www.facebook.com/1048_1",
    adsManagerUrl: `https://adsmanager.facebook.com/adsmanager/manage/ads?act=1&selected_ad_ids=${AD_A}`,
  }],
  ...over,
});

test("หน้าเว็บ: แถบโชว์ชื่อแอดเต็ม + ad_id + รูป + ปุ่มโพสต์/ตัวจัดการโฆษณา · ห้องไม่มีแอด = ไม่มีแถบ", async (t) => {
  installBrowserGlobals(t);
  const { adReferralBanner } = await import("../public/console/adReferral.mjs");
  assert.equal(adReferralBanner(null), null);
  assert.equal(adReferralBanner({ ads: [] }), null);

  const banner = adReferralBanner(card(), { now: T0 + 60_000, roomId: "facebook:u1" });
  const text = textOf(banner);
  assert.match(text, /มาจากโฆษณา/u);
  assert.match(text, /A \| ได้ทุกสูตร \| make flow - 2 \(โพสต์เดิม\)/u);
  assert.match(text, /ad_id 120200000000000404/u);
  assert.match(text, /ลูกค้าใหม่จากแอด/u);
  assert.match(text, /วันนี้ 21:15/u);
  const links = findAll(banner, (n) => n.tagName === "a");
  assert.deepEqual(links.map((a) => a.attributes.target), ["_blank", "_blank"]);
  assert.ok(links.every((a) => a.attributes.rel === "noopener noreferrer"));
  const img = findAll(banner, (n) => n.tagName === "img")[0];
  assert.equal(img.attributes.src, PHOTO);
  assert.equal(img.attributes.referrerpolicy, "no-referrer");
  assert.ok(banner._classes().has("is-entering"));
  // ห้องเดิมสร้างใหม่ (มีข้อความเข้า) — แอนิเมชันไม่เล่นซ้ำ
  assert.ok(!adReferralBanner(card(), { roomId: "facebook:u1" })._classes().has("is-entering"));
});

test("หน้าเว็บ: รูปโหลดไม่ขึ้น → ภาพสำรองตัวชุดแอด · ไม่มีลิงก์ตัวจัดการ (ทีมงาน) = ปุ่มนั้นไม่โผล่ · แอดอื่นอยู่ในรายการพับ", async (t) => {
  installBrowserGlobals(t);
  const { adReferralBanner, adMonogram } = await import("../public/console/adReferral.mjs");
  assert.equal(adMonogram("B | ได้ทุกสูตร"), "B");
  assert.equal(adMonogram("in house Wink white"), "📣");

  const base = card();
  const staffCard = card({
    firstContact: false, adCount: 2,
    ads: [
      { ...base.ads[0], adsManagerUrl: null },
      { ...base.ads[0], key: `ad:${AD_B}`, adId: AD_B, adTitle: "Class 7 Dec", photoUrl: "", adsManagerUrl: null, lastAt: T0 - 86_400_000 },
    ],
  });
  const banner = adReferralBanner(staffCard, { now: T0 });
  const host = document.createElement("div");
  host.append(banner);
  const img = findAll(banner, (n) => n.tagName === "img")[0];
  for (const fn of img.listeners.error || []) fn();
  const tile = byClass(banner, "adref-thumb-fallback")[0];
  assert.ok(tile, "รูปแตกต้องกลายเป็นภาพสำรอง");
  assert.equal(textOf(tile), "A");
  const labels = findAll(banner, (n) => n.tagName === "a").map(textOf);
  assert.deepEqual(labels, ["ดูโพสต์ ↗"]);
  assert.match(textOf(banner), /ลูกค้าเดิมกดแอดกลับมา/u);
  assert.match(textOf(byClass(banner, "adref-others")[0]), /เคยกดแอดอื่นด้วย 1 ตัว.*Class 7 Dec/u);
});

test("หน้าเว็บ: ปุ่มย่อจำไว้ในเครื่อง · ป้าย AD บนแถวรายการบอกชื่อแอด + ad_id ใน tooltip", async (t) => {
  installBrowserGlobals(t);
  const store = new Map();
  const previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  t.after(() => { globalThis.localStorage = previous; });
  const { adReferralBanner, adReferralChip } = await import("../public/console/adReferral.mjs");

  const banner = adReferralBanner(card());
  const toggle = byClass(banner, "adref-toggle")[0];
  for (const fn of toggle.listeners.click || []) fn();
  assert.ok(banner._classes().has("is-compact"));
  assert.equal(toggle.attributes["aria-expanded"], "false");
  assert.ok(adReferralBanner(card())._classes().has("is-compact"), "เปิดห้องถัดไปยังย่ออยู่");

  assert.equal(adReferralChip(null), null);
  const chip = adReferralChip({ adId: AD_A, adTitle: "A | ได้ทุกสูตร", adCount: 2, lastAt: T0 });
  assert.match(textOf(chip), /AD.*A \| ได้ทุกสูตร/u);
  assert.match(chip.attributes.title, /ad_id 120200000000000404 · กดแอด 2 ตัว/u);
});

test("หน้าเว็บ: มือถือที่ยังไม่เคยกดเลือก เริ่มแบบย่อ · เคยกดขยายไว้แล้วต้องเคารพค่าที่จำไว้", async (t) => {
  installBrowserGlobals(t);
  const store = new Map();
  const previous = { localStorage: globalThis.localStorage, matchMedia: globalThis.matchMedia };
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) };
  globalThis.matchMedia = (query) => ({ matches: query === "(max-width: 720px)" });
  t.after(() => { globalThis.localStorage = previous.localStorage; globalThis.matchMedia = previous.matchMedia; });
  const { adReferralBanner } = await import("../public/console/adReferral.mjs");

  assert.ok(adReferralBanner(card())._classes().has("is-compact"), "มือถือ: เริ่มแบบย่อ");
  store.set("lk.adBanner.compact", "0");
  assert.ok(!adReferralBanner(card())._classes().has("is-compact"), "เคยกดขยาย = แบบเต็ม");
});

test("ลิงก์ m.me?ref= (SHORTLINK) ไม่ใช่แอด: ไม่ขึ้นแถบ/ป้าย AD และไม่ทับแอดจริงที่ลูกค้ากดมาก่อน (รีวิว 6 ต.ค. ค่ำ)", () => {
  const db = memoryDb();
  db.recordAdReferral({ customerId: "facebook:link-only", source: "SHORTLINK", ref: "bio_link", eventKind: "referral", referralAt: T0 });
  assert.equal(db.adReferralCardFor("facebook:link-only"), null);
  assert.equal(db.latestAdReferralsFor(["facebook:link-only"]).size, 0);

  record(db, "facebook:ad-then-link");
  db.recordAdReferral({ customerId: "facebook:ad-then-link", source: "SHORTLINK", ref: "anything", eventKind: "referral", referralAt: T0 + 5000 });
  assert.equal(db.adReferralCardFor("facebook:ad-then-link").ads[0].adId, AD_A);
  assert.equal(db.adReferralCardFor("facebook:ad-then-link").adCount, 1);
  assert.equal(db.latestAdReferralsFor(["facebook:ad-then-link"]).get("facebook:ad-then-link").adId, AD_A);
  db.close();
});

test("view: รูปที่เก็บไว้แต่ไม่ได้อยู่บน CDN Meta ไม่ถูกส่งถึงเบราว์เซอร์ (ตรวจซ้ำตอนอ่าน)", () => {
  const db = memoryDb();
  record(db, "facebook:u1", { photoUrl: "https://evil.example/x.jpg", mediaType: "video" });
  const view = adReferralCardView(db, "facebook:u1", { operator: null, logger: silent });
  assert.equal(view.ads[0].photoUrl, "");
  assert.equal(view.ads[0].mediaType, "");
  db.close();
});
