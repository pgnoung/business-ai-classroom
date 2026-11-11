// business-suite-link.test.mjs — ลิงก์เปิดห้อง Facebook ใน Meta Business Suite (28 ก.ย. 2026)
// พี่ง้วง: "ถ้าเคสไหนเกิน 24 ชม.แล้วตอบไม่ได้แล้ว ให้คุณลิ้งค์ business suite ห้องนั้นไว้หน่อยได้ไหม"
import test from "node:test";
import assert from "node:assert/strict";
import { businessSuiteInboxUrl, createFacebookPageIdResolver } from "../src/businessSuiteLink.mjs";
import { createFacebookClient } from "../src/facebookClient.mjs";
import { roomTriage } from "../src/consoleTriageApi.mjs";
import { memoryDb } from "./helpers.mjs";

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const PAGE = "100000000000102";
const PSID = "10000000000000202";

test("ลิงก์กล่องข้อความ Messenger ของเพจ: ต้องรู้รหัสเพจ (ตัวเลข) ไม่งั้นไม่มีลิงก์ — ไม่ใส่ PSID (Business Suite เปิดห้องตรงไม่ได้)", () => {
  assert.equal(businessSuiteInboxUrl(PAGE), `https://business.facebook.com/latest/inbox/messenger?asset_id=${PAGE}&mailbox_id=${PAGE}`);
  assert.equal(businessSuiteInboxUrl(""), "");
  assert.equal(businessSuiteInboxUrl(`${PAGE}&x=1`), "");
  assert.ok(!businessSuiteInboxUrl(PAGE).includes(PSID));
});

test("รหัสเพจ: ถาม Graph ครั้งเดียวแล้วจำ · ล้มแล้วเว้นช่วงก่อนถามใหม่ · เรียนรู้จาก webhook ได้", async () => {
  let calls = 0;
  let answer = null;
  let clock = 1_000_000;
  const resolver = createFacebookPageIdResolver({
    getClient: () => ({ getPageInfo: async () => { calls += 1; return answer; } }),
    logger: silent, now: () => clock,
  });
  assert.equal(resolver.current(), "");
  assert.equal(await resolver.resolve(), "", "Graph ไม่ตอบ = ยังไม่มี");
  assert.equal(await resolver.resolve(), "", "ยังไม่ครบช่วงพัก ไม่ถามซ้ำ");
  assert.equal(calls, 1);
  answer = { id: PAGE, name: "พี่ง้วง" };
  clock += 11 * 60_000;
  assert.equal(await resolver.resolve(), PAGE);
  assert.equal(await resolver.resolve(), PAGE);
  assert.equal(calls, 2, "ได้แล้วไม่ถามซ้ำ");
  const learned = createFacebookPageIdResolver({ getClient: () => null, logger: silent });
  learned.learn("not-a-page");
  assert.equal(learned.current(), "");
  learned.learn(PAGE);
  assert.equal(learned.current(), PAGE);
});

test("facebookClient.getPageInfo: GET /me?fields=id,name ด้วยโทเคนเพจ · ตอบผิดรูป = null", async () => {
  const seen = [];
  const ok = createFacebookClient({
    config: { fbMockUrl: "http://fb.mock" },
    credentials: () => ({ pageAccessToken: "page-token" }),
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), method: init?.method });
      return new Response(JSON.stringify({ id: PAGE, name: "เพจพี่ง้วง" }), { status: 200 });
    },
    logger: silent,
  });
  assert.deepEqual(await ok.getPageInfo(), { id: PAGE, name: "เพจพี่ง้วง" });
  assert.match(seen[0].url, /\/me\?fields=id%2Cname$|\/me\?fields=id,name$/u);
  assert.equal(seen[0].method, "GET");
  const odd = createFacebookClient({
    config: { fbMockUrl: "http://fb.mock" }, credentials: () => ({ pageAccessToken: "t" }),
    fetchImpl: async () => new Response(JSON.stringify({ id: "me" }), { status: 200 }), logger: silent,
  });
  assert.equal(await odd.getPageInfo(), null);
  const down = createFacebookClient({
    config: { fbMockUrl: "http://fb.mock" }, credentials: () => ({ pageAccessToken: "t" }),
    fetchImpl: async () => { throw new Error("offline"); }, logger: silent,
  });
  assert.equal(await down.getPageInfo(), null);
});

test("หัวห้องแชท: ห้อง Facebook ได้ลิงก์กล่องข้อความใน Business Suite เมื่อรู้รหัสเพจ · ห้อง LINE ไม่มี", () => {
  const db = memoryDb();
  db.upsertCustomer(`facebook:${PSID}`, { displayName: "คุณเต๋", channelId: "facebook" });
  db.upsertCustomer("Uline0001", { displayName: "ลูกค้า LINE" });
  const fb = roomTriage({ db, customer: db.getCustomer(`facebook:${PSID}`), facebookPageId: PAGE });
  assert.equal(fb.businessSuiteUrl, businessSuiteInboxUrl(PAGE));
  const unknownPage = roomTriage({ db, customer: db.getCustomer(`facebook:${PSID}`) });
  assert.equal(unknownPage.businessSuiteUrl, "");
  const line = roomTriage({ db, customer: db.getCustomer("Uline0001"), facebookPageId: PAGE });
  assert.equal(line.businessSuiteUrl, "");
});
