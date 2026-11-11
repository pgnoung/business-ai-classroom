// identity-link-basic-id.test.mjs — LINE ID ของ OA มาจากตัว LINE เองเมื่อไม่ได้ตั้งค่า (28 ก.ย. 2026)
// เดิมต้องตั้ง LINE_BASIC_ID ใน env บนเซิร์ฟเวอร์ก่อน ปุ่ม "ส่งลิงก์ไลน์ให้ลูกค้า" ถึงจะใช้ได้ — ตอนนี้ถาม
// GET /v2/bot/info ด้วยโทเคนของช่องนั้น (อ่านอย่างเดียว) · LINE ไม่ตอบ = ยังส่งไม่ได้ ห้ามเดา
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, testConfig } from "./helpers.mjs";
import { createIdentityLink } from "../src/identityLink.mjs";
import { IDENTITY_LINK_MODE_KEY } from "../src/identityLinkCodes.mjs";
import { createLineClient } from "../src/lineClient.mjs";

const SECRET = ["identity", "basic", "id", "key"].join("-");
const FB = "facebook:psid-777";
const START = Date.UTC(2026, 8, 28, 5, 0, 0);
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };

function harness({ botInfo = { basicId: "@lukprae", displayName: "ลูกแพร" }, configured = "" } = {}) {
  const now = () => START;
  const db = memoryDb({ now });
  db.setSetting(IDENTITY_LINK_MODE_KEY, "manual");
  const sends = [];
  let infoCalls = 0;
  const client = (channelId) => ({
    sendAllowed: () => true,
    sendBubbles: async (args) => { sends.push({ channelId, ...args }); return { ok: true, mode: "push" }; },
    getBotInfo: async () => {
      if (channelId !== "default") return null;
      infoCalls += 1;
      return botInfo;
    },
  });
  const lineRegistry = {
    channels: [
      { id: "default", name: "พี่ง้วง", active: true, basicId: configured },
      { id: "facebook", name: "Facebook", provider: "facebook", active: true },
    ],
    forChannel: (id) => client(id),
    rawUserId: (key) => String(key).replace(/^facebook:/u, ""),
  };
  const link = createIdentityLink({
    config: { consoleSessionSecret: SECRET }, db, lineRegistry, now,
    pipeline: { runExclusive: (id, work) => work() },
    notifier: { fireLater() {} },
    logger: silent,
  });
  db.upsertCustomer(FB, { displayName: "ทดสอบ", channelId: "facebook" });
  db.insertMessage({ customerId: FB, direction: "in", channelId: "facebook", content: "สนใจคลาสค่ะ" });
  return { db, link, sends, infoCalls: () => infoCalls };
}

test("OA มี premium ID: ลิงก์และข้อความเชิญใช้ @pngoung แทน basic ID สุ่ม (พี่ง้วง 30 ก.ย.)", async () => {
  const { link, sends } = harness({ botInfo: { basicId: "@093kafsy", premiumId: "@pngoung", displayName: "พี่ง้วง" } });
  const result = await link.sendInvite({ customerId: FB, operator: "owner", classType: "online" });
  assert.equal(result.ok, true, JSON.stringify(result));
  const [invite, linkBubble] = sends[0].bubbles.map((bubble) => bubble.text);
  assert.match(invite, /แอดไลน์ @pngoung แล้วส่งรหัสนี้มาในแชทนะคะ\nรหัส: LK-[0-9A-Z]{5}-[0-9A-Z]{5}\n/u);
  assert.doesNotMatch(invite, /093kafsy/u);
  assert.match(linkBubble, /^https:\/\/line\.me\/R\/oaMessage\/%40pngoung\/\?LK-[0-9A-Z]{5}-[0-9A-Z]{5}$/u, "ลิงก์ล้วนอีกบอลลูน");
  assert.equal(link.targetLineChannel().basicId, "@pngoung");
});

test("ไม่ได้ตั้ง LINE ID: ถาม LINE เองตอนกดส่งลิงก์ แล้วจำไว้ ไม่ถามซ้ำ", async () => {
  const { link, sends, infoCalls } = harness();
  assert.equal(link.targetLineChannel(), null, "ก่อนถาม LINE ยังไม่รู้ LINE ID");
  const result = await link.sendInvite({ customerId: FB, operator: "owner", classType: "live_business" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(sends.length, 1);
  assert.match(sends[0].bubbles[1].text, /https:\/\/line\.me\/R\/oaMessage\/%40lukprae\//u);
  assert.equal(link.targetLineChannel().basicId, "@lukprae");
  await link.resolveBasicIds();
  assert.equal(infoCalls(), 1, "ได้แล้วไม่ถาม LINE ซ้ำ");
});

test("LINE ไม่ตอบ LINE ID = ยังส่งลิงก์ไม่ได้ (ห้ามเดา) และลองใหม่ได้รอบหน้า", async () => {
  const { link, sends, infoCalls } = harness({ botInfo: null });
  const result = await link.sendInvite({ customerId: FB, operator: "owner", classType: "live_business" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_basic_id");
  assert.equal(sends.length, 0);
  await link.resolveBasicIds();
  assert.equal(infoCalls(), 2, "ล้มแล้วไม่จำผลว่างไว้ — รอบหน้าถามใหม่");
});

test("ตั้ง LINE ID ไว้แล้ว = ใช้ค่าที่ตั้ง ไม่ถาม LINE", async () => {
  const { link, sends, infoCalls } = harness({ configured: "@pngoung" });
  const result = await link.sendInvite({ customerId: FB, operator: "owner", classType: "live_business" });
  assert.equal(result.ok, true);
  assert.match(sends[0].bubbles[1].text, /oaMessage\/%40pngoung\//u);
  assert.equal(infoCalls(), 0);
});

test("lineClient.getBotInfo: อ่าน basicId จาก GET /v2/bot/info · ตอบผิด/ล้ม = null", async () => {
  const calls = [];
  const fetchOk = async (url, init) => {
    calls.push({ url: String(url), method: init?.method });
    return new Response(JSON.stringify({ userId: "Uxxxx", basicId: "@abc1234", displayName: "OA" }), { status: 200 });
  };
  const client = createLineClient({ config: testConfig(), fetchImpl: fetchOk, logger: silent });
  assert.deepEqual(await client.getBotInfo(), { basicId: "@abc1234", premiumId: "", displayName: "OA" });
  // 30 ก.ย. 2026: OA ที่มี premium ID (@pngoung) ส่งกลับด้วย — ลิงก์/ข้อความเชิญใช้ไอดีที่ลูกค้าค้นหาเองได้ง่าย
  const premium = createLineClient({
    config: testConfig(), logger: silent,
    fetchImpl: async () => new Response(JSON.stringify({ basicId: "@093kafsy", premiumId: "@pngoung", displayName: "OA" }), { status: 200 }),
  });
  assert.deepEqual(await premium.getBotInfo(), { basicId: "@093kafsy", premiumId: "@pngoung", displayName: "OA" });
  assert.equal(calls[0].method, "GET");
  assert.match(calls[0].url, /\/v2\/bot\/info$/u);
  const missing = createLineClient({ config: testConfig(), fetchImpl: async () => new Response("{}", { status: 404 }), logger: silent });
  assert.equal(await missing.getBotInfo(), null);
  const odd = createLineClient({ config: testConfig(), fetchImpl: async () => new Response(JSON.stringify({ basicId: 42 }), { status: 200 }), logger: silent });
  assert.equal(await odd.getBotInfo(), null);
});
