// facebookClient — fail-closed ทุกชั้นเหมือน LINE + สัญญา interface ตรงกับ registry
import test from "node:test";
import assert from "node:assert/strict";
import { createFacebookClient, verifyFacebookSignature, FB_OUTBOUND_METADATA } from "../src/facebookClient.mjs";
import { createHmac } from "node:crypto";

const baseConfig = { fbMockUrl: "", fbLiveSend: false, fbApiVersion: "v24.0", lineTimeoutMs: 1000, sendDelayScale: 0 };

test("live ปิด (ค่าเริ่มต้น) = ไม่ยิงอะไรออกเลย ทุก method", async () => {
  let fetched = 0;
  const client = createFacebookClient({
    config: baseConfig,
    credentials: () => ({ pageAccessToken: "tok" }),
    fetchImpl: async () => { fetched += 1; return { ok: true, status: 200 }; },
  });
  assert.equal((await client.sendBubbles({ to: "psid1", bubbles: ["สวัสดีค่ะ"] })).blocked, true);
  assert.equal((await client.startLoading({ to: "psid1" })).blocked, true);
  assert.equal(await client.getProfile({ userId: "psid1" }), null);
  assert.equal(fetched, 0, "fail-closed: ห้ามมี network call แม้แต่ครั้งเดียว");
});

test("mock mode ส่งได้ + metadata ของบอทติดทุกข้อความรวมทั้งรูป (กุญแจแยก echo)", async () => {
  const sent = [];
  const client = createFacebookClient({
    config: { ...baseConfig, fbMockUrl: "http://mock" },
    credentials: () => ({ pageAccessToken: "" }),
    fetchImpl: async (url, opts) => { sent.push(JSON.parse(opts.body)); return { ok: true, status: 200 }; },
  });
  const result = await client.sendBubbles({ to: "psid1", bubbles: ["หนึ่ง", { text: "สอง", pauseSec: 0 }], images: [{ url: "https://img/x.jpg" }] });
  assert.equal(result.ok, true);
  assert.equal(result.calls, 3);
  assert.equal(sent[0].message.metadata, FB_OUTBOUND_METADATA);
  assert.equal(sent[1].message.metadata, FB_OUTBOUND_METADATA);
  assert.equal(sent[2].message.attachment.type, "image", "รูปส่งเป็น attachment url");
  assert.equal(sent[2].message.metadata, FB_OUTBOUND_METADATA,
    "รูปต้องติด metadata ด้วย — 30 ส.ค. echo รูปที่ไม่มีลายเซ็นทำ AI off ห้องลูกค้าจริง (fb_human_replying)");
  assert.equal(sent[0].messaging_type, "RESPONSE");
});

test("ล้มกลางลูปต้องรายงาน delivered (บทเรียนโควตา LINE 2026-08-15)", async () => {
  let call = 0;
  const client = createFacebookClient({
    config: { ...baseConfig, fbMockUrl: "http://mock" },
    credentials: () => ({ pageAccessToken: "" }),
    fetchImpl: async () => { call += 1; return call <= 1 ? { ok: true, status: 200 } : { ok: false, status: 500 }; },
  });
  const result = await client.sendBubbles({ to: "p", bubbles: [{ text: "a", pauseSec: 0 }, { text: "b", pauseSec: 0 }] });
  assert.equal(result.ok, false);
  assert.equal(result.delivered.length, 1, "ข้อความที่ออกไปแล้วต้องถูกรายงานให้ caller บันทึก");
});

test("batch rechecks relevance before every Messenger call and preserves delivered images", async () => {
  let calls = 0;
  let relevant = true;
  const client = createFacebookClient({
    config: { ...baseConfig, fbMockUrl: "http://mock" },
    credentials: () => ({ pageAccessToken: "" }),
    fetchImpl: async () => {
      calls += 1;
      relevant = false;
      return { ok: true, status: 200 };
    },
  });
  const first = { url: "https://img.example/first.jpg", previewUrl: "https://img.example/first-preview.jpg" };
  const result = await client.sendBubbles({
    to: "psid1", batch: true, images: [first, { url: "https://img.example/second.jpg" }],
    stillRelevant: () => relevant,
  });

  assert.equal(calls, 1, "relevance loss after first provider call must block the second");
  assert.equal(result.stoppedEarly, true);
  assert.deepEqual(result.delivered, [{
    type: "image", originalContentUrl: first.url, previewImageUrl: first.previewUrl,
  }]);
});

test("multicast = blocked เสมอ — นโยบายกันแบน ไม่มีบรอดแคสฝั่ง Facebook", async () => {
  const client = createFacebookClient({
    config: { ...baseConfig, fbMockUrl: "http://mock", fbLiveSend: true },
    credentials: () => ({ pageAccessToken: "tok" }),
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  const result = await client.multicast({ to: ["a", "b"], messages: [{ type: "text", text: "x" }] });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "facebook_no_multicast");
});

test("verifyFacebookSignature — ถูก/ผิด/ไม่มี secret", () => {
  const raw = Buffer.from('{"object":"page"}');
  const good = `sha256=${createHmac("sha256", "topsecret").update(raw).digest("hex")}`;
  assert.equal(verifyFacebookSignature(raw, good, "topsecret"), true);
  assert.equal(verifyFacebookSignature(raw, good, "wrong"), false);
  assert.equal(verifyFacebookSignature(raw, "sha256=zzz", "topsecret"), false);
  assert.equal(verifyFacebookSignature(raw, good, ""), false, "ไม่มี secret = ปฏิเสธเสมอ");
  assert.equal(verifyFacebookSignature(raw, "", "topsecret"), false);
});

test("interface ครบทุก method ที่ registry สัญญาไว้ (เสียบแทน lineClient ได้)", () => {
  const client = createFacebookClient({ config: baseConfig });
  for (const method of ["sendBubbles", "multicast", "startLoading", "getProfile", "getQuota", "getDeliveryInsight", "getMessageContent", "sendAllowed"]) {
    assert.equal(typeof client[method], "function", `ขาด ${method}`);
  }
});

// รีวิวรอบ 4 (12 ต.ค.): Facebook เคยส่ง [ข้อความทั้งหมด, รูป] เสมอ — ทักตามรูปบรรยากาศ (imageAfter) ได้รูปหลังคำถามปิดท้าย ห่างจากคำนำของมัน
// และรูปที่เครื่อง v3 วางก่อนย่อหน้าสุดท้ายในแชทก็ออกหลังคำถาม · ตอนนี้ใช้กติกาเดียวกับ LINE (bubbleOrder.mjs)
function orderClient() {
  const sent = [];
  const client = createFacebookClient({
    config: { ...baseConfig, fbMockUrl: "http://mock" },
    credentials: () => ({ pageAccessToken: "" }),
    fetchImpl: async (url, opts) => { sent.push(JSON.parse(opts.body).message); return { ok: true, status: 200 }; },
  });
  const order = () => sent.map((message) => (message.attachment ? "IMAGE" : message.text));
  return { client, order };
}
const CAPTION = "ส่งรูปบรรยากาศคลาสจริงให้ดูนะคะ พี่ง้วงสอนกลุ่มเล็กดูแลใกล้ชิดเลยค่ะ";
const INVITE = "ถ้าอยากลองดูก่อน ลูกแพรมีสิทธิ์ชวนทดลองเรียนฟรีวันนี้ค่ะ\nhttps://example.invalid/trial";
const QUESTION = "ร้านกาแฟตอนนี้โพสต์ช่องทางไหนบ่อยที่สุดคะ?";
const PHOTO = { url: "https://img.example/a1.jpg" };

test("รอบ 4: imageAfter = รูปต่อจากคำนำของมัน แล้วคำชวน แล้วคำถาม · delivered/acceptedRequestMessages ตามลำดับที่ส่งจริง", async () => {
  const { client, order } = orderClient();
  const result = await client.sendBubbles({ to: "psid1", bubbles: [CAPTION, INVITE, QUESTION], images: [PHOTO], batch: true, imageAfter: 1 });
  assert.equal(result.ok, true);
  assert.deepEqual(order(), [CAPTION, "IMAGE", INVITE, QUESTION]);
  assert.deepEqual(result.acceptedRequestMessages.map((message) => message.type === "image" ? "IMAGE" : message.text), [CAPTION, "IMAGE", INVITE, QUESTION]);
});

test("รอบ 4: ไม่มี imageAfter และบอลลูนสุดท้ายเป็นคำถาม = รูปก่อนคำถาม (ปิดท้ายด้วยคำถามเสมอ) · ไม่ใช่คำถาม = รูปท้ายเหมือนเดิม", async () => {
  const asked = orderClient();
  await asked.client.sendBubbles({ to: "psid1", bubbles: ["ดีเลยค่ะ ลูกแพรส่งรูปบรรยากาศให้ดูนะคะ", QUESTION], images: [PHOTO], batch: true });
  assert.deepEqual(asked.order(), ["ดีเลยค่ะ ลูกแพรส่งรูปบรรยากาศให้ดูนะคะ", "IMAGE", QUESTION]);
  const plain = orderClient();
  await plain.client.sendBubbles({ to: "psid1", bubbles: ["ขอบคุณค่ะ", "แล้วเจอกันในคลาสนะคะ"], images: [PHOTO], batch: true });
  assert.deepEqual(plain.order(), ["ขอบคุณค่ะ", "แล้วเจอกันในคลาสนะคะ", "IMAGE"]);
  // imageAfter ผิดรูป (เกินจำนวนข้อความ) = กติกาคำถามปิดท้าย
  const bad = orderClient();
  await bad.client.sendBubbles({ to: "psid1", bubbles: [CAPTION, QUESTION], images: [PHOTO], batch: true, imageAfter: 5 });
  assert.deepEqual(bad.order(), [CAPTION, "IMAGE", QUESTION]);
});
