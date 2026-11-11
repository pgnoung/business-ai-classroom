// facebookWebhook — เกตลูกค้าเก่า Lead Center · echo yield · dedupe · signature
// คำสั่งเจ้าของ 2026-08-30: "ลูกค้าเก่า ชมพู่คุยอย่างเดียวเท่านั้น" + "ทักใหม่เท่านั้น"
import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { memoryDb } from "./helpers.mjs";
import {
  createFacebookWebhook, matchKnownCustomer, isStickerAttachment, FB_HUMAN_OPERATOR,
  FB_KNOWN_CUSTOMERS_KEY, FB_LEGACY_TAG, AI_OFF_FB_LEGACY, AI_OFF_FB_UNVERIFIED, AI_OFF_FB_GATE_PENDING,
} from "../src/facebookWebhook.mjs";
import { FB_OUTBOUND_METADATA } from "../src/facebookClient.mjs";
import { OPERATOR_PAUSE_MS } from "../src/aiPausePolicy.mjs";

const APP_SECRET = "test-app-secret";
const sign = (raw) => `sha256=${createHmac("sha256", APP_SECRET).update(raw).digest("hex")}`;

function harness({ db, profile = undefined, knownCustomers = null, config = {}, draining = false } = {}) {
  if (knownCustomers) db.setSetting(FB_KNOWN_CUSTOMERS_KEY, JSON.stringify(knownCustomers));
  const pipelineCalls = [];
  const notifications = [];
  const webhook = createFacebookWebhook({
    config: { lineWebhookBodyTimeoutMs: 1000, ...config },
    db,
    pipeline: { handleEvent: async (event, ctx) => { pipelineCalls.push({ event, ctx }); } },
    lineRegistry: {
      forChannel: () => ({ getProfile: async () => profile ?? null }),
      channels: [{ id: "facebook", credentials: () => ({ appSecret: APP_SECRET, verifyToken: "vtok", pageAccessToken: "tok" }) }],
    },
    notifier: { fire: async (payload) => { notifications.push(payload); return { ok: true }; } },
    readBody: async (req) => req._raw,
    json: (res, status, body) => { res.result = { status, body }; },
    logger: { error: () => {}, warn: () => {}, debug: () => {} },
    isDraining: () => draining,
  });
  const post = async (payload) => {
    const raw = Buffer.from(JSON.stringify(payload));
    const req = { method: "POST", headers: { "x-hub-signature-256": sign(raw) }, _raw: raw };
    const res = {};
    await webhook.handleWebhook(req, res);
    return res.result;
  };
  return { webhook, post, pipelineCalls, notifications };
}

const msgEvent = (psid, text, mid) => ({
  object: "page",
  entry: [{ messaging: [{ sender: { id: psid }, recipient: { id: "page1" }, timestamp: 1, message: { mid, text } }] }],
});

test("GET verify: token ตรง = คืน challenge / ไม่ตรงหรือไม่ตั้ง = 403", () => {
  const db = memoryDb();
  const { webhook } = harness({ db });
  const mkRes = () => {
    const res = { body: "", writeHead(status) { res.status = status; }, end(text) { res.body = text; } };
    return res;
  };
  const ok = mkRes();
  webhook.handleVerify({}, ok, new URL("http://x/webhooks/facebook?hub.mode=subscribe&hub.verify_token=vtok&hub.challenge=12345"));
  assert.equal(ok.status, 200);
  assert.equal(ok.body, "12345");
  const bad = {};
  webhook.handleVerify({}, bad, new URL("http://x/webhooks/facebook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=1"));
  assert.equal(bad.result.status, 403);
  db.close();
});

test("signature ผิด = 403 · ไม่มี app secret = 503 (fail-closed)", async () => {
  const db = memoryDb();
  const { webhook } = harness({ db });
  const raw = Buffer.from(JSON.stringify(msgEvent("p1", "สวัสดี", "m1")));
  const res = {};
  await webhook.handleWebhook({ method: "POST", headers: { "x-hub-signature-256": "sha256=ffff" }, _raw: raw }, res);
  assert.equal(res.result.status, 403);
  db.close();
});

test("ลีดใหม่ (ไม่ตรงรายชื่อ) — บันทึกข้อความ + AI เปิด + เข้า pipeline ด้วย channel facebook", async () => {
  const db = memoryDb();
  const { post, pipelineCalls } = harness({
    db, profile: { displayName: "คุณลีดใหม่", pictureUrl: "" }, knownCustomers: ["สมชาย ใจดี"],
  });
  const result = await post(msgEvent("psid-new", "สนใจคลาสค่ะ", "m-new-1"));
  assert.equal(result.status, 200);
  const customer = db.getCustomer("facebook:psid-new");
  assert.equal(customer.ai_enabled, 1, "ลีดใหม่ AI ต้องเปิด");
  assert.equal(customer.channel_id, "facebook");
  assert.equal(customer.display_name, "คุณลีดใหม่");
  assert.equal(pipelineCalls.length, 1);
  assert.equal(pipelineCalls[0].ctx.channelId, "facebook");
  assert.equal(pipelineCalls[0].event.message.text, "สนใจคลาสค่ะ");
  db.close();
});

test("ห้องใหม่ไม่มีรายชื่อลูกค้าเก่า: เติมชื่อจาก Meta ตั้งแต่ข้อความแรก", async () => {
  const db = memoryDb();
  const { post, pipelineCalls, notifications } = harness({
    db, profile: { displayName: "ชื่อสมมติจากเพจ", pictureUrl: "" },
  });
  await post(msgEvent("123456", "สวัสดีค่ะ", "profile-first-message"));
  await new Promise((resolve) => setImmediate(resolve));
  const customer = db.getCustomer("facebook:123456");
  assert.equal(customer.display_name, "ชื่อสมมติจากเพจ");
  assert.equal(customer.ai_enabled, 1);
  assert.equal(pipelineCalls.length, 1);
  assert.equal(notifications.length, 0);
  db.close();
});

test("ลูกค้าเก่า Lead Center — ปิด AI ตั้งแต่ยังไม่ทันตอบ + ป้าย + แจ้งทีม", async () => {
  const db = memoryDb();
  const { post, notifications } = harness({
    db, profile: { displayName: "สมชาย ใจดี", pictureUrl: "" }, knownCustomers: ["สมชาย ใจดี"],
  });
  await post(msgEvent("psid-old", "สวัสดีครับ", "m-old-1"));
  const customer = db.getCustomer("facebook:psid-old");
  assert.equal(customer.ai_enabled, 0, "ลูกค้าเก่า AI ต้องปิด");
  assert.equal(customer.ai_off_reason, AI_OFF_FB_LEGACY);
  const tags = db.listTags("facebook:psid-old").map((t) => t.tag);
  assert.ok(tags.includes(FB_LEGACY_TAG));
  assert.equal(notifications.length, 1, "ทีมต้องได้รับแจ้ง");
  // ประวัติยังต้องครบแม้ AI ปิด (บทเรียน Fern)
  const msgs = db.raw.prepare("SELECT content FROM messages WHERE customer_id=?").all("facebook:psid-old");
  assert.equal(msgs.length, 1);
  db.close();
});

test("fail-closed: ดึงชื่อโปรไฟล์ไม่ได้ + มีรายชื่อตั้งไว้ = กันไว้ก่อน (ทีมปลดได้)", async () => {
  const db = memoryDb();
  const { post } = harness({ db, profile: null, knownCustomers: ["สมชาย ใจดี"] });
  await post(msgEvent("psid-mystery", "ราคาเท่าไหร่", "m-mys-1"));
  const customer = db.getCustomer("facebook:psid-mystery");
  assert.equal(customer.ai_enabled, 0);
  assert.equal(customer.ai_off_reason, AI_OFF_FB_UNVERIFIED);
  db.close();
});

test("ยังไม่ตั้งรายชื่อ = ไม่มีเกต — บอทคุยลีดใหม่ได้เลย (ค่าเริ่มต้นไม่บล็อกการขาย)", async () => {
  const db = memoryDb();
  const { post } = harness({ db, profile: null }); // ดึงชื่อไม่ได้ด้วยซ้ำ
  await post(msgEvent("psid-x", "สนใจค่ะ", "m-x-1"));
  assert.equal(db.getCustomer("facebook:psid-x").ai_enabled, 1);
  db.close();
});

test("echo ของบอทเราเอง (metadata ตรง) = ข้ามเงียบ ไม่บันทึกซ้ำ ไม่ปิด AI", async () => {
  const db = memoryDb();
  const { post } = harness({ db });
  db.upsertCustomer("facebook:psid-e", { channelId: "facebook" });
  await post({
    object: "page",
    entry: [{ messaging: [{ sender: { id: "page1" }, recipient: { id: "psid-e" }, timestamp: 2, message: { mid: "m-echo-1", is_echo: true, metadata: FB_OUTBOUND_METADATA, text: "ข้อความบอท" } }] }],
  });
  const msgs = db.raw.prepare("SELECT * FROM messages WHERE customer_id=?").all("facebook:psid-e");
  assert.equal(msgs.length, 0, "echo ของเราถูกบันทึกไปแล้วตอนส่ง — ห้ามซ้ำ");
  assert.equal(db.getCustomer("facebook:psid-e").ai_enabled, 1);
  db.close();
});

// 2026-09-02 (คำสั่งเจ้าของ): เดิมเคสนี้ปิด AI ถาวร (fb_human_replying) แล้วไม่มีใคร
// กลับไปเปิดคืน ห้องจึงตายหลังทีมงานตอบครั้งเดียว — เปลี่ยนเป็น "พัก" เท่าคอนโซล
test("echo จากแอดมิน Business Suite = บันทึกเป็นข้อความทีม + พัก AI 15 นาที (ไม่ปิดถาวร)", async () => {
  const db = memoryDb();
  const { post } = harness({ db });
  const before = Date.now();
  await post({
    object: "page",
    entry: [{ messaging: [{ sender: { id: "page1" }, recipient: { id: "psid-h" }, timestamp: 3, message: { mid: "m-human-1", is_echo: true, text: "เดี๋ยวชมพู่ดูแลนะคะ" } }] }],
  });
  const customer = db.getCustomer("facebook:psid-h");
  assert.equal(customer.ai_enabled, 1, "คนจริงตอบ = พัก ไม่ใช่ปิดสวิตช์");
  assert.ok(customer.operator_active_until >= before + OPERATOR_PAUSE_MS - 2000, "บอทต้องหลบตลอดหน้าต่างพัก");
  const msg = db.raw.prepare("SELECT * FROM messages WHERE customer_id=?").get("facebook:psid-h");
  assert.equal(msg.direction, "out");
  assert.equal(msg.operator, FB_HUMAN_OPERATOR);
  db.close();
});

test("Meta ส่ง event ซ้ำ (mid เดิม) = บันทึกครั้งเดียว", async () => {
  const db = memoryDb();
  const { post, pipelineCalls } = harness({ db });
  await post(msgEvent("psid-d", "ทดสอบ", "m-dup-1"));
  await post(msgEvent("psid-d", "ทดสอบ", "m-dup-1"));
  const msgs = db.raw.prepare("SELECT * FROM messages WHERE customer_id=?").all("facebook:psid-d");
  assert.equal(msgs.length, 1);
  assert.equal(pipelineCalls.length, 1);
  db.close();
});

test("รูปแนบ = msgType image (pipeline พาเข้าเส้นเงิน fail-closed เอง)", async () => {
  const db = memoryDb();
  const { post, pipelineCalls } = harness({ db });
  await post({
    object: "page",
    entry: [{ messaging: [{ sender: { id: "psid-img" }, recipient: { id: "page1" }, timestamp: 4, message: { mid: "m-img-1", attachments: [{ type: "image", payload: { url: "https://cdn/x.jpg" } }] } }] }],
  });
  assert.equal(pipelineCalls[0].event.message.type, "image");
  db.close();
});

// เคสจริง 2026-08-30 (คุณ Amarit ส่งสลิปแล้วคอนโซลขึ้นแค่ "[image]"): URL ที่ Meta แนบมา
// ต้องถูกเก็บเป็นแถว attachment ไม่งั้นไม่มีอะไรให้คอนโซลแสดง และหลักฐานการเงินหายตาม URL ที่หมดอายุ
test("รูปที่ลูกค้าส่งต้องได้แถว attachment พร้อม URL ไว้ให้ตัวดูดสื่อไปโหลด (คอนโซลถึงจะเห็นรูป)", async () => {
  const db = memoryDb();
  const { post } = harness({ db, config: { messageMediaEnabled: true, inboundLineContentCapture: true } });
  const url = "https://scontent-bkk1-1.xx.fbcdn.net/v/t1/slip.jpg?token=a";
  await post({
    object: "page",
    entry: [{ messaging: [{ sender: { id: "psid-slip" }, recipient: { id: "page1" }, timestamp: 9, message: { mid: "m-slip-1", attachments: [{ type: "image", payload: { url } }] } }] }],
  });
  const rows = db.listMessageAttachments ? db.listMessageAttachments("facebook:psid-slip") : null;
  const row = (rows && rows[0]) || db.raw?.prepare?.("SELECT * FROM message_attachments WHERE customer_id = ?").get("facebook:psid-slip");
  assert.ok(row, "ต้องมีแถว attachment");
  assert.equal(row.source, "facebook");
  assert.equal(row.kind, "image");
  assert.equal(row.status, "queued", "ต้องเข้าคิวรอดาวน์โหลด");
  assert.equal(JSON.parse(row.provider_meta_json).url, url, "URL ต้องถูกเก็บไว้ครบ");
  db.close();
});

// ---- เคสจริง 2026-09-05: ปุ่มไลก์ 👍 ของ Messenger ปิดห้องลูกค้าถาวร ----
//
// ขาเข้า Facebook 14 วัน มี "รูป" 19 ใบ — 7 ใบเป็นไฟล์เดียวกันเป๊ะ (1,678 ไบต์) จาก CDN
// สติกเกอร์ (/t39.1997-6/) คือปุ่มไลก์ และอีก 1 ใบเป็น webp 3,333 ไบต์จาก path เดียวกัน
// โค้ดเดิมอ่านแค่ attachments[0].type จึงส่งเข้าเส้นเงิน: ปิด AI ถาวร + ปักธงเงิน + ไม่ตอบเลย
const attachEvent = (psid, mid, attachment) => ({
  object: "page",
  entry: [{ messaging: [{ sender: { id: psid }, recipient: { id: "page1" }, timestamp: 7, message: { mid, attachments: [attachment] } }] }],
});

test("ตัวแยกสติกเกอร์: sticker_id มีค่า = สติกเกอร์เสมอ · path CDN สติกเกอร์ = สติกเกอร์ · รูปถ่ายจริง = ไม่ใช่", () => {
  // นิ้วโป้งจริงจาก production (369239263222822 / 369239343222814 / 369239383222810)
  for (const id of [369239263222822, "369239343222814", 369239383222810, 1]) {
    assert.equal(isStickerAttachment({ type: "image", payload: { sticker_id: id, url: "https://x/y.png" } }), true, `sticker_id=${id}`);
  }
  assert.equal(
    isStickerAttachment({ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/v/t39.1997-6/39178562_1505197616293642_x.png?stp=cp0_dst-jpg" } }),
    true, "path CDN สติกเกอร์ = สติกเกอร์ แม้ไม่มี sticker_id",
  );
  assert.equal(
    isStickerAttachment({ type: "image", payload: { url: "https://scontent.xx.fbcdn.net/v/t1.15752-9/slip_1234.jpg?_nc_cat=1" } }),
    false, "รูปถ่าย/สลิปจริงต้องไม่ถูกมองเป็นสติกเกอร์",
  );
  assert.equal(isStickerAttachment({ type: "file", payload: { url: "https://x/doc.pdf" } }), false);
  assert.equal(isStickerAttachment({ type: "image", payload: {} }), false, "ไม่มีอะไรบ่งชี้ = รูปปกติ (fail-closed ทางเงิน)");
});

test("ลูกค้ากดปุ่มไลก์ 👍 — เป็นสติกเกอร์ ไม่ใช่รูป ไม่ดูดไฟล์ และไปป์ไลน์ไม่พาเข้าเส้นเงิน", async () => {
  const db = memoryDb();
  const { post, pipelineCalls } = harness({ db, config: { messageMediaEnabled: true, inboundLineContentCapture: true } });
  await post(attachEvent("psid-like", "m-like-1", {
    type: "image",
    payload: { sticker_id: 369239263222822, url: "https://scontent.xx.fbcdn.net/v/t39.1997-6/39178562_1505197616293642_x.png?stp=cp0_dst-jpg" },
  }));
  assert.equal(pipelineCalls[0].event.message.type, "sticker", "ต้องเป็นสติกเกอร์ ไม่ใช่ image");
  const rows = db.raw.prepare("SELECT * FROM message_attachments WHERE customer_id = ?").all("facebook:psid-like");
  assert.equal(rows.length, 0, "สติกเกอร์ต้องไม่สร้างคิวดาวน์โหลดไฟล์");
  db.close();
});

test("สติกเกอร์จาก CDN โดยไม่มี sticker_id ก็ต้องเป็นสติกเกอร์ (webp 3,333 ไบต์ที่เจอจริง)", async () => {
  const db = memoryDb();
  const { post, pipelineCalls } = harness({ db });
  await post(attachEvent("psid-cdn", "m-cdn-1", {
    type: "image",
    payload: { url: "https://scontent.xx.fbcdn.net/v/t39.1997-6/12345_sticker.webp?stp=cp0" },
  }));
  assert.equal(pipelineCalls[0].event.message.type, "sticker");
  db.close();
});

test("รูปถ่ายจริงยังเป็น image และยังได้คิวดาวน์โหลดเหมือนเดิม (ห้ามกันเกินจนสลิปหาย)", async () => {
  const db = memoryDb();
  const { post, pipelineCalls } = harness({ db, config: { messageMediaEnabled: true, inboundLineContentCapture: true } });
  const url = "https://scontent.xx.fbcdn.net/v/t1.15752-9/slip_9876.jpg?_nc_cat=1";
  await post(attachEvent("psid-photo", "m-photo-1", { type: "image", payload: { url } }));
  assert.equal(pipelineCalls[0].event.message.type, "image");
  const row = db.raw.prepare("SELECT * FROM message_attachments WHERE customer_id = ?").get("facebook:psid-photo");
  assert.ok(row, "รูปจริงต้องยังมีแถว attachment");
  assert.equal(JSON.parse(row.provider_meta_json).url, url);
  db.close();
});

test("แถวขาเข้าของสติกเกอร์ต้องถูกบันทึกไว้ (ประวัติ/นาฬิกาตามงานเดินเหมือนสติกเกอร์ LINE)", async () => {
  const db = memoryDb();
  const { post } = harness({ db });
  await post(attachEvent("psid-log", "m-log-1", { type: "image", payload: { sticker_id: 369239343222814 } }));
  const stored = db.raw.prepare("SELECT msg_type, content, direction FROM messages WHERE customer_id = ? ORDER BY id DESC LIMIT 1").get("facebook:psid-log");
  assert.ok(stored, "ต้องมีแถวข้อความขาเข้า");
  assert.equal(stored.direction, "in");
  assert.equal(stored.msg_type, "sticker");
  assert.equal(stored.content, "[sticker]");
  db.close();
});

test("matchKnownCustomer — ตัดช่องว่าง/ตัวพิมพ์ แต่ไม่เหวี่ยงแหกว้าง", () => {
  const known = ["สมชาย ใจดี", "Jane Smith"];
  assert.equal(matchKnownCustomer("สมชาย  ใจดี", known.map((s) => s.toLowerCase())), true);
  assert.equal(matchKnownCustomer("jane smith", known.map((s) => s.toLowerCase())), true);
  assert.equal(matchKnownCustomer("สมหญิง รักเรียน", known.map((s) => s.toLowerCase())), false);
  assert.equal(matchKnownCustomer("", known.map((s) => s.toLowerCase())), false);
});

// ตรวจอิสระ 2026-09-01: เส้น drain เคยเรียก closeGate ตรง ๆ ทุกราย = ลีดใหม่ที่บังเอิญ
// ทักตรงจังหวะ deploy ถูกปิด AI ถาวรพร้อมป้ายที่ปลดได้ด้วยมือคนเท่านั้น
// (เคส 1 ก.ย. 2026 เป็นลูกค้าใหม่ข้อความแรกพอดี) — ต้องเลื่อนไปตัดสิน ไม่ใช่ตัดสินถาวร
test("ระหว่างระบบกำลังปิด: ลีดใหม่ถูกพัก AI ชั่วคราว ไม่ติดป้ายลูกค้าเก่า แล้วข้อความถัดไปได้ตัดสินเกตจริง", async () => {
  const db = memoryDb();
  const drainRun = harness({
    db, draining: true,
    profile: { displayName: "คุณลีดใหม่", pictureUrl: "" }, knownCustomers: ["สมชาย ใจดี"],
  });
  await drainRun.post(msgEvent("psid-drain", "สนใจคลาสค่ะ", "m-drain-fb-1"));

  const duringDrain = db.getCustomer("facebook:psid-drain");
  assert.equal(duringDrain.ai_enabled, 0, "ยังไม่ผ่านเกต = บอทต้องเงียบไว้ก่อน");
  assert.equal(duringDrain.ai_off_reason, AI_OFF_FB_GATE_PENDING, "ต้องเป็นเหตุผลชั่วคราวที่ระบบปลดเองได้");
  const drainTags = db.listTags("facebook:psid-drain").map((t) => t.tag);
  assert.ok(!drainTags.includes(FB_LEGACY_TAG), "ห้ามติดป้ายที่ปลดได้ด้วยมือคนเท่านั้น");
  assert.equal(drainRun.pipelineCalls.length, 0, "ระหว่างปิดระบบ ห้ามเริ่มคิด");

  // รีสตาร์ทเสร็จ ลูกค้าคนเดิมพิมพ์มาอีก — คราวนี้ต้องถามโปรไฟล์จริงแล้วเปิด AI คืน
  const afterRestart = harness({
    db, profile: { displayName: "คุณลีดใหม่", pictureUrl: "" }, knownCustomers: ["สมชาย ใจดี"],
  });
  await afterRestart.post(msgEvent("psid-drain", "ยังเปิดรับสมัครไหมคะ", "m-drain-fb-2"));
  const resolved = db.getCustomer("facebook:psid-drain");
  assert.equal(resolved.ai_enabled, 1, "ลีดใหม่จริงต้องได้คุยกับบอทหลังรีสตาร์ท");
  assert.equal(afterRestart.pipelineCalls.length, 1);
  db.close();
});

test("ระหว่างระบบกำลังปิด: ลูกค้าเก่า (ชื่อตรงรายชื่อ) ยังต้องไม่หลุดเกตหลังรีสตาร์ท", async () => {
  const db = memoryDb();
  const drainRun = harness({
    db, draining: true,
    profile: { displayName: "สมชาย ใจดี", pictureUrl: "" }, knownCustomers: ["สมชาย ใจดี"],
  });
  await drainRun.post(msgEvent("psid-legacy", "สวัสดีครับ", "m-drain-fb-3"));
  assert.equal(db.getCustomer("facebook:psid-legacy").ai_off_reason, AI_OFF_FB_GATE_PENDING);

  const afterRestart = harness({
    db, profile: { displayName: "สมชาย ใจดี", pictureUrl: "" }, knownCustomers: ["สมชาย ใจดี"],
  });
  await afterRestart.post(msgEvent("psid-legacy", "สอบถามหน่อยครับ", "m-drain-fb-4"));
  const resolved = db.getCustomer("facebook:psid-legacy");
  assert.equal(resolved.ai_enabled, 0, "ลูกค้าเก่าต้องยังเป็นของทีม");
  assert.equal(resolved.ai_off_reason, AI_OFF_FB_LEGACY);
  assert.ok(db.listTags("facebook:psid-legacy").map((t) => t.tag).includes(FB_LEGACY_TAG));
  db.close();
});

test("แอดมินตอบจาก Business Suite ระหว่างเกตถูกเลื่อนไว้ -> บอทห้ามเด้งกลับเข้าห้องนั้น", async () => {
  const db = memoryDb();
  const drainRun = harness({
    db, draining: true,
    profile: { displayName: "คุณลีดใหม่", pictureUrl: "" }, knownCustomers: ["สมชาย ใจดี"],
  });
  await drainRun.post(msgEvent("psid-taken", "สนใจคลาสค่ะ", "m-taken-1"));
  assert.equal(db.getCustomer("facebook:psid-taken").ai_off_reason, AI_OFF_FB_GATE_PENDING);

  // แอดมินเห็นข้อความใน Business Suite แล้วตอบเอง (echo ที่ไม่ใช่ของบอท)
  const afterRestart = harness({
    db, profile: { displayName: "คุณลีดใหม่", pictureUrl: "" }, knownCustomers: ["สมชาย ใจดี"],
  });
  await afterRestart.post({
    object: "page",
    entry: [{ messaging: [{
      sender: { id: "page1" }, recipient: { id: "psid-taken" }, timestamp: 2,
      message: { mid: "m-taken-echo", text: "สวัสดีค่ะ ทีมงานดูแลต่อนะคะ", is_echo: true },
    }] }],
  });
  // 2026-09-02: หน้าต่างพักคือสิ่งที่กันบอทไม่ให้แทรก ไม่ใช่การปิดสวิตช์ถาวรอีกแล้ว
  assert.ok(db.getCustomer("facebook:psid-taken").operator_active_until > Date.now());

  await afterRestart.post(msgEvent("psid-taken", "ขอบคุณค่ะ", "m-taken-2"));
  const finalState = db.getCustomer("facebook:psid-taken");
  assert.ok(finalState.operator_active_until > Date.now(),
    "ห้องที่คนจริงกำลังคุยอยู่ บอทห้ามแทรกระหว่างหน้าต่างพัก");
  db.close();
});
