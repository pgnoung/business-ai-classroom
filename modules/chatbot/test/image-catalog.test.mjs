// image catalog + marker protocol + LINE image send
// กติกาเหล็ก (prior art Fern): model เลือกรูปได้เฉพาะ key จาก allowlist ผ่าน [IMAGE:key]
// — URL ห้ามมาจาก model เด็ดขาด; key แปลกหน้า = ทิ้ง; draft โดนบล็อก = รูปห้ามหลุดตาม
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadImageCatalog, extractImageMarkers } from "../src/imageCatalog.mjs";
import { createLineClient } from "../src/lineClient.mjs";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub,
  httpRequest, listen,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };

function warnCollector() {
  const warns = [];
  return { warns, logger: { log: () => {}, error: () => {}, warn: (msg) => warns.push(String(msg)) } };
}

// แคตตาล็อกรูปสำหรับเทสต์ (shape หลังผ่าน loader แล้ว) — key ห้ามมีตัวเลข
// เพราะ guard ตรวจ raw draft รวม marker (SPEC: marker ไม่มีเลข = ไม่ชน price guard)
const CATALOG = [
  { key: "menu", url: "https://img.test/menu.jpg", previewUrl: "https://img.test/menu-s.jpg" },
  { key: "map", url: "https://img.test/map.jpg", previewUrl: "https://img.test/map.jpg" },
  { key: "promo-a", url: "https://img.test/promo-a.jpg", previewUrl: "https://img.test/promo-a.jpg" },
  { key: "promo-b", url: "https://img.test/promo-b.jpg", previewUrl: "https://img.test/promo-b.jpg" },
  { key: "promo-c", url: "https://img.test/promo-c.jpg", previewUrl: "https://img.test/promo-c.jpg" },
];

/* ------------------------------ catalog loader ----------------------------- */

function writeCatalog(t, content) {
  const dir = mkdtempSync(join(tmpdir(), "imgcat-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "catalog.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

test("catalog: โหลดไฟล์ปกติ — previewUrl default เป็น url, field เสริมครบ", (t) => {
  const file = writeCatalog(t, [
    { key: "menu", url: "https://cdn.test/menu.jpg", description: "เมนูรวม" },
    { key: "map", url: "https://cdn.test/map.jpg", preview_url: "https://cdn.test/map-s.jpg", needs_verification: true },
  ]);
  const entries = loadImageCatalog(file, { logger: silent });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], {
    key: "menu", url: "https://cdn.test/menu.jpg", previewUrl: "https://cdn.test/menu.jpg",
    description: "เมนูรวม", needsVerification: false,
  });
  assert.equal(entries[1].previewUrl, "https://cdn.test/map-s.jpg");
  assert.equal(entries[1].needsVerification, true);
});

test("catalog: url ไม่ใช่ https:// -> ทิ้ง entry + warn (http/relative ห้ามหมด)", (t) => {
  const { warns, logger } = warnCollector();
  const file = writeCatalog(t, [
    { key: "ok", url: "https://cdn.test/ok.jpg" },
    { key: "insecure", url: "http://cdn.test/bad.jpg" },
    { key: "relative", url: "/images/bad.jpg" },
  ]);
  const entries = loadImageCatalog(file, { logger });
  assert.deepEqual(entries.map((e) => e.key), ["ok"]);
  assert.equal(warns.filter((w) => w.includes("https://")).length, 2);
});

test("catalog: preview_url ไม่ใช่ https:// -> ใช้ url หลักแทน + warn", (t) => {
  const { warns, logger } = warnCollector();
  const file = writeCatalog(t, [
    { key: "menu", url: "https://cdn.test/menu.jpg", preview_url: "http://cdn.test/menu-s.jpg" },
  ]);
  const entries = loadImageCatalog(file, { logger });
  assert.equal(entries[0].previewUrl, "https://cdn.test/menu.jpg");
  assert.ok(warns.some((w) => w.includes("preview_url")));
});

test("catalog: key ซ้ำ -> ตัวแรกชนะ, key ว่าง/หาย -> ทิ้ง", (t) => {
  const { warns, logger } = warnCollector();
  const file = writeCatalog(t, [
    { key: "menu", url: "https://cdn.test/first.jpg" },
    { key: "menu", url: "https://cdn.test/second.jpg" },
    { key: "  ", url: "https://cdn.test/blank.jpg" },
    { url: "https://cdn.test/nokey.jpg" },
  ]);
  const entries = loadImageCatalog(file, { logger });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].url, "https://cdn.test/first.jpg");
  assert.ok(warns.some((w) => w.includes("ซ้ำ")));
});

test("catalog: ไฟล์ JSON พัง -> [] + warn ไม่ throw", (t) => {
  const { warns, logger } = warnCollector();
  const file = writeCatalog(t, "{ พังแน่นอน ");
  assert.deepEqual(loadImageCatalog(file, { logger }), []);
  assert.equal(warns.length, 1);
});

test("catalog: ไฟล์ไม่มีอยู่ -> [] เงียบ ๆ (ฟีเจอร์ปิด ไม่ใช่ error)", () => {
  const { warns, logger } = warnCollector();
  assert.deepEqual(loadImageCatalog("/no/such/dir/catalog.json", { logger }), []);
  assert.deepEqual(loadImageCatalog("", { logger }), []);
  assert.equal(warns.length, 0);
});

test("catalog: JSON ไม่ใช่ array -> [] + warn", (t) => {
  const { warns, logger } = warnCollector();
  const file = writeCatalog(t, { key: "menu", url: "https://cdn.test/menu.jpg" });
  assert.deepEqual(loadImageCatalog(file, { logger }), []);
  assert.equal(warns.length, 1);
});

/* ---------------------------- marker extraction ---------------------------- */

test("marker: ดึง [IMAGE:key] และ [image:key] ตามลำดับที่เจอ + ลอก marker ออกหมด", () => {
  const { text, images } = extractImageMarkers(
    "ดูเมนูตรงนี้ได้เลยค่ะ [IMAGE:menu] ส่วนแผนที่ตามนี้นะคะ [image:map]",
    { catalog: CATALOG, logger: silent }
  );
  assert.deepEqual(images.map((i) => i.key), ["menu", "map"]);
  assert.equal(images[0].url, "https://img.test/menu.jpg");
  assert.equal(images[0].previewUrl, "https://img.test/menu-s.jpg");
  assert.ok(!text.includes("["), `marker ต้องถูกลอกออกหมด: ${text}`);
  assert.equal(text, "ดูเมนูตรงนี้ได้เลยค่ะ ส่วนแผนที่ตามนี้นะคะ");
});

test("marker: needsVerification=true ต้องถูกทิ้ง ห้ามส่งก่อน smoke-test ผ่าน", () => {
  const { warns, logger } = warnCollector();
  const result = extractImageMarkers("รูปนี้ค่ะ [IMAGE:pending]", {
    catalog: [{ key: "pending", url: "https://img.test/pending.jpg", needsVerification: true }],
    logger,
  });
  assert.deepEqual(result.images, []);
  assert.deepEqual(result.dropped, ["pending"]);
  assert.equal(result.text, "รูปนี้ค่ะ");
  assert.ok(warns.some((message) => message.includes("needs_verification")));
});

test("marker: key แปลกหน้า -> ทิ้งพร้อม warn แต่ marker ยังถูกลอกออก (ห้ามเดา URL)", () => {
  const { warns, logger } = warnCollector();
  const { text, images } = extractImageMarkers("นี่ค่ะ [IMAGE:ghost] และ [IMAGE:menu]", {
    catalog: CATALOG, logger,
  });
  assert.deepEqual(images.map((i) => i.key), ["menu"]);
  assert.ok(!text.includes("ghost"));
  assert.ok(warns.some((w) => w.includes("ghost")));
});

test("marker: key ซ้ำ -> ส่งรูปเดียว, marker ว่าง [IMAGE:] -> ลอกทิ้งเฉย ๆ", () => {
  const { text, images } = extractImageMarkers(
    "[IMAGE:menu] ซ้ำอีกรอบ [image:menu] และตัวว่าง [IMAGE:]",
    { catalog: CATALOG, logger: silent }
  );
  assert.deepEqual(images.map((i) => i.key), ["menu"]);
  assert.ok(!text.includes("["));
});

test("marker: เกินเพดาน maxImages -> ตัดตามลำดับที่เจอ + warn", () => {
  const { warns, logger } = warnCollector();
  const { text, images } = extractImageMarkers(
    "[IMAGE:menu] [IMAGE:map] [IMAGE:promo-a] [IMAGE:promo-b]",
    { catalog: CATALOG, maxImages: 2, logger }
  );
  assert.deepEqual(images.map((i) => i.key), ["menu", "map"]);
  assert.ok(warns.some((w) => w.includes("เพดาน")));
  assert.equal(text, "", "marker ทุกตัวรวมตัวที่โดนตัดต้องถูกลอกออก");
});

/* ------------------------------- line client ------------------------------- */

test("line: text + images รวม <=5 + replyToken -> reply เดียว โครง image message ถูกต้อง", async () => {
  const fetchStub = lineFetchStub();
  const client = createLineClient({ config: testConfig(), fetchImpl: fetchStub, logger: silent });
  const result = await client.sendBubbles({
    to: "U1", replyToken: "rt-1",
    bubbles: [{ text: "หนึ่ง" }, { text: "สอง" }],
    images: [
      { url: "https://img.test/menu.jpg", previewUrl: "https://img.test/menu-s.jpg" },
      { url: "https://img.test/map.jpg" }, // ไม่มี previewUrl -> ใช้ url หลัก
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "reply");
  assert.equal(fetchStub.calls.length, 1);
  const messages = fetchStub.calls[0].body.messages;
  assert.equal(messages.length, 4);
  assert.deepEqual(messages.map((m) => m.type), ["text", "text", "image", "image"]);
  assert.deepEqual(messages[2], {
    type: "image",
    originalContentUrl: "https://img.test/menu.jpg",
    previewImageUrl: "https://img.test/menu-s.jpg",
  });
  assert.equal(messages[3].previewImageUrl, "https://img.test/map.jpg");
});

test("line: text + images รวม >5 -> reply แบ่งไม่ได้ ส่งทั้งหมดเป็น push พร้อม delay เดิม", async () => {
  const fetchStub = lineFetchStub();
  const sleeps = [];
  const client = createLineClient({
    config: testConfig(), fetchImpl: fetchStub,
    sleep: async (ms) => sleeps.push(ms), logger: silent,
  });
  const result = await client.sendBubbles({
    to: "U1", replyToken: "rt-1",
    bubbles: [{ text: "หนึ่ง", pauseSec: 3 }, { text: "สอง", pauseSec: 3 }, { text: "สาม", pauseSec: 3 }],
    images: CATALOG.slice(0, 3).map(({ url, previewUrl }) => ({ url, previewUrl })),
  });
  assert.equal(result.ok, true);
  assert.equal(result.mode, "push");
  assert.equal(result.calls, 6);
  assert.ok(fetchStub.calls.every((c) => c.url.endsWith("/v2/bot/message/push")));
  const types = fetchStub.calls.map((c) => c.body.messages[0].type);
  assert.deepEqual(types, ["text", "text", "text", "image", "image", "image"], "text ก่อนรูปเสมอ");
  assert.equal(sleeps.length, 5, "ต้องมี send-delay ระหว่างทุก message เหมือนเดิม");
});

test("line: ส่งรูปอย่างเดียว (ไม่มี text bubble) ได้ ไม่นับเป็น empty", async () => {
  const fetchStub = lineFetchStub();
  const client = createLineClient({ config: testConfig(), fetchImpl: fetchStub, logger: silent });
  const result = await client.sendBubbles({
    to: "U1", replyToken: "rt-1", bubbles: [],
    images: [{ url: "https://img.test/menu.jpg", previewUrl: "https://img.test/menu.jpg" }],
  });
  assert.equal(result.ok, true);
  assert.equal(fetchStub.calls[0].body.messages[0].type, "image");
  // ว่างทั้งคู่ = empty เหมือนเดิม
  const empty = await client.sendBubbles({ to: "U1", bubbles: [], images: [] });
  assert.equal(empty.reason, "empty");
});

test("line: fail-closed เดิมคุมรูปด้วย — LINE_LIVE_SEND=false ไม่มี mock = ไม่ยิงอะไรเลย", async () => {
  let called = 0;
  const client = createLineClient({
    config: testConfig({ LINE_MOCK_URL: "", LINE_LIVE_SEND: "false" }),
    fetchImpl: async () => {
      called += 1;
      return { ok: true, status: 200 };
    },
    logger: silent,
  });
  const result = await client.sendBubbles({
    to: "U1", bubbles: [],
    images: [{ url: "https://img.test/menu.jpg", previewUrl: "https://img.test/menu.jpg" }],
  });
  assert.equal(result.blocked, true);
  assert.equal(result.reason, "live_send_disabled");
  assert.equal(called, 0);
});

/* ------------------------------- pipeline e2e ------------------------------ */

function makeApp({ hermesFetch, approved = [2500], configOverrides = {} } = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  for (const amount of approved) db.setApprovedPrice(`ราคา-${amount}`, amount);
  const hermes = hermesFetch ?? hermesFetchStub();
  const line = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermes, lineFetch: line, sleep: async () => {}, imageCatalog: CATALOG },
    logger: silent,
  });
  return { app, db, config, hermesFetch: hermes, lineFetch: line };
}

test("pipeline: 2 marker จริง + 1 แปลกหน้า -> text ไร้ marker + ส่ง 2 รูป + log DB ครบ (reply mode)", async () => {
  const { app, db, lineFetch } = makeApp({
    hermesFetch: hermesFetchStub(
      "รายละเอียดตามนี้เลยนะคะ [IMAGE:menu] ส่วนแผนที่ร้านดูตรงนี้ได้เลยค่ะ [image:map] [IMAGE:ghost]"
    ),
  });
  const result = await app.pipeline.handleInboundText({
    customerId: "U-img", text: "ขอดูเมนูกับแผนที่หน่อยค่ะ", replyToken: "rt-img",
  });
  assert.equal(result.sent, true);
  assert.equal(result.sendResult.mode, "reply", "text 1 bubble + 2 รูป = 3 <= 5 ต้องเป็น reply เดียว");
  assert.deepEqual(result.imageKeys, ["menu", "map"]);

  const messages = lineFetch.sends[0].body.messages;
  assert.deepEqual(messages.map((m) => m.type), ["text", "image", "image"]);
  assert.ok(!/\[image:/iu.test(messages[0].text), `text bubble ห้ามมี marker หลงเหลือ: ${messages[0].text}`);
  assert.equal(messages[1].originalContentUrl, "https://img.test/menu.jpg");
  assert.equal(messages[1].previewImageUrl, "https://img.test/menu-s.jpg");
  assert.equal(messages[2].originalContentUrl, "https://img.test/map.jpg");
  assert.ok(!JSON.stringify(lineFetch.calls).includes("ghost"), "key แปลกหน้าห้ามหลุดทุกช่องทาง");

  const outbound = db.messagesFor("U-img").filter((m) => m.direction === "out");
  const imageRows = outbound.filter((m) => m.msg_type === "image");
  assert.equal(imageRows.length, 2, "รูปขาออกต้องถูก log เป็นแถว msg_type=image");
  assert.equal(imageRows[0].content, "[image:menu] https://img.test/menu.jpg");
  assert.equal(imageRows[1].content, "[image:map] https://img.test/map.jpg");
  assert.ok(imageRows.every((m) => m.message_class === "reactive"));
  db.close();
});

test("pipeline: text + รูปรวมเกิน 5 -> ส่งทั้งหมดเป็น push (reply แบ่งไม่ได้)", async () => {
  const { app, db, lineFetch } = makeApp({
    hermesFetch: hermesFetchStub(
      "จัดรูปให้ครบทุกใบเลยนะคะ [IMAGE:menu] [IMAGE:map] [IMAGE:promo-a] [IMAGE:promo-b] [IMAGE:promo-c]"
    ),
  });
  const result = await app.pipeline.handleInboundText({
    customerId: "U-many", text: "ขอรูปทั้งหมดเลยค่ะ", replyToken: "rt-many",
  });
  assert.equal(result.sent, true);
  assert.equal(result.imageKeys.length, 5);
  assert.equal(result.sendResult.mode, "push", "1 bubble + 5 รูป = 6 > 5 ต้อง push ทั้งหมด");
  assert.equal(result.sendResult.calls, 6);
  assert.ok(lineFetch.sends.every((c) => c.url.endsWith("/v2/bot/message/push")));
  db.close();
});

test("pipeline: เกิน IMAGE_MAX_PER_REPLY -> ตัดจำนวนรูปตาม env", async () => {
  const { app, db } = makeApp({
    configOverrides: { IMAGE_MAX_PER_REPLY: "2" },
    hermesFetch: hermesFetchStub("ตามนี้ค่ะ [IMAGE:menu] [IMAGE:map] [IMAGE:promo-a]"),
  });
  const result = await app.pipeline.handleInboundText({
    customerId: "U-cap", text: "ขอรูปหน่อยค่ะ", replyToken: "rt-cap",
  });
  assert.deepEqual(result.imageKeys, ["menu", "map"]);
  db.close();
});

test("pipeline: guard บล็อกราคาแม้มี marker -> ส่ง fallback และรูปของ draft ที่โดนบล็อกห้ามหลุดตาม", async () => {
  const { app, db, lineFetch } = makeApp({
    hermesFetch: hermesFetchStub("คอร์สนี้ลดเหลือ 1,990 บาทค่ะ สนใจดูรูปเพิ่มไหมคะ [IMAGE:menu] [image:map]"),
    approved: [2500],
  });
  const result = await app.pipeline.handleInboundText({
    customerId: "U-blocked", text: "ราคาเท่าไหร่คะ", replyToken: "rt-b",
  });
  assert.equal(result.blockedDraft, true, "guard ต้องเห็นราคาแปลกใน raw draft (รวม marker) แล้วบล็อก");
  assert.equal(result.sent, true, "ลูกค้าต้องไม่เจอความเงียบ — ได้ fallback");
  assert.deepEqual(result.imageKeys, [], "รูปของ draft ที่โดนบล็อกห้ามติดไปกับ fallback");

  const payload = JSON.stringify(lineFetch.calls);
  assert.ok(!payload.includes("1,990"), "เลขต้องห้ามหลุด");
  assert.ok(!payload.includes('"image"'), "ห้ามมี image message หลุดไปกับ fallback");
  assert.ok(!payload.includes("img.test"), "URL รูปห้ามหลุดทุกช่องทาง");
  // v1.3.4: กู้ประโยคที่ปลอดภัยไว้ได้ แต่ต้องบอกเสมอว่ากำลังเช็คตัวเลข และรูปห้ามติดไปด้วย
  assert.ok(/ขอเช็ค|ขอลูกแพรเช็ค/u.test(payload), "ต้องบอกลูกค้าว่ากำลังเช็คตัวเลข");
  assert.ok(!/\[\s*image\s*:/iu.test(payload), "marker รูปห้ามหลุดไปกับข้อความที่กู้มา");

  const outbound = db.messagesFor("U-blocked").filter((m) => m.direction === "out");
  assert.equal(outbound.filter((m) => m.msg_type === "image").length, 0, "DB ห้ามมีแถวรูปขาออก");
  assert.equal(db.listCorrections("candidate").length, 1, "draft ที่โดนบล็อกยังเข้า correction queue");
  db.close();
});

test("pipeline: model ตอบ marker ล้วน (ไม่มี text เหลือ) -> ยังส่งรูปได้ ไม่นับเป็น empty", async () => {
  const { app, db, lineFetch } = makeApp({ hermesFetch: hermesFetchStub("[IMAGE:menu]") });
  const result = await app.pipeline.handleInboundText({
    customerId: "U-only-img", text: "ขอรูปเมนูค่ะ", replyToken: "rt-o",
  });
  assert.equal(result.sent, true);
  assert.equal(result.bubbles, 0);
  assert.deepEqual(result.imageKeys, ["menu"]);
  assert.equal(lineFetch.sends[0].body.messages[0].type, "image");
  db.close();
});

/* ----------------------------- operator console ---------------------------- */

test("console: conversation JSON มีแถวรูปขาออกแล้วไม่พัง — คืน msg_type=image ตามปกติ", async (t) => {
  const config = testConfig({ CONSOLE_SESSION_SECRET: "test-console-secret-0123456789" });
  const db = memoryDb();
  db.createOperator({ username: "nok", passHash: hashPassword("operator-pass-123"), displayName: "พี่นก" });
  db.upsertCustomer("U-conv", {});
  db.insertMessage({ customerId: "U-conv", direction: "in", msgType: "text", content: "ขอดูรูปหน่อยค่ะ" });
  db.insertMessage({
    customerId: "U-conv", direction: "out", msgType: "image",
    content: "[image:menu] https://img.test/menu.jpg",
  });
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => {
    app.server.close();
    db.close();
  });

  const login = await httpRequest(app.server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nok", password: "operator-pass-123" }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers["set-cookie"]?.[0] || "").split(";")[0];

  const res = await httpRequest(app.server, {
    path: "/console/api/conversations/U-conv/messages",
    headers: { cookie },
  });
  assert.equal(res.status, 200);
  const imageRow = res.json.messages.find((m) => m.msg_type === "image");
  assert.ok(imageRow, "แถวรูปขาออกต้องโผล่ใน conversation JSON");
  assert.equal(imageRow.direction, "out");
  assert.equal(imageRow.content, "[image:menu] https://img.test/menu.jpg");
});

/* ------------------------ catalog loader: object form ----------------------- */
// BUG 1 (Airdog trial): ไฟล์แคตตาล็อกจริงเป็น object {generated, images:[...], excluded:[...]}
// loader เดิมรับแค่ bare array -> โหลดได้ 0 key เงียบ ๆ -> รูปหายทั้งระบบ

test("catalog: object form { images: [...] } โหลดได้ — key อื่น (generated/excluded) ถูกข้าม", (t) => {
  const file = writeCatalog(t, {
    generated: "2026-08-09",
    source: "airdog-data.xlsx",
    note: "หมายเหตุอะไรก็ได้",
    images: [
      { key: "x3pro_sku_1", url: "https://cdn.test/x3pro-1.jpg", description: "SKU หลัก" },
      { key: "x3pro_sku_2", url: "https://cdn.test/x3pro-2.jpg", needs_verification: true },
      { key: "insecure", url: "http://cdn.test/bad.jpg" }, // กติกา https เดิมยังคุม
    ],
    excluded: [{ key: "room_scene", reason: "ไม่มี URL" }],
  });
  const { warns, logger } = warnCollector();
  const entries = loadImageCatalog(file, { logger });
  assert.deepEqual(entries.map((e) => e.key), ["x3pro_sku_1", "x3pro_sku_2"]);
  assert.equal(entries[0].url, "https://cdn.test/x3pro-1.jpg");
  assert.equal(entries[0].previewUrl, "https://cdn.test/x3pro-1.jpg");
  assert.equal(entries[1].needsVerification, true);
  assert.ok(warns.some((w) => w.includes("https://")), "entry ไม่ใช่ https ยังโดนทิ้ง + warn เหมือนเดิม");
  assert.ok(!JSON.stringify(entries).includes("room_scene"), "excluded ต้องไม่หลุดเข้าแคตตาล็อก");
});

test("catalog: object ที่ images ไม่ใช่ array -> [] + warn (ไม่เดาโครงสร้าง)", (t) => {
  const { warns, logger } = warnCollector();
  const file = writeCatalog(t, { images: { key: "menu", url: "https://cdn.test/menu.jpg" } });
  assert.deepEqual(loadImageCatalog(file, { logger }), []);
  assert.equal(warns.length, 1);
});

test("catalog: log ตอนโหลดบอกจำนวน key เสมอ — โหลดได้ 0 ก็ต้องมองเห็น", (t) => {
  const logs = [];
  const logger = { log: (msg) => logs.push(String(msg)), warn: () => {}, error: () => {} };

  const okFile = writeCatalog(t, { images: [{ key: "menu", url: "https://cdn.test/menu.jpg" }] });
  loadImageCatalog(okFile, { logger });
  assert.ok(logs.some((l) => l.includes("1 key")), `ต้อง log จำนวน key ที่โหลดได้: ${logs}`);

  logs.length = 0;
  const emptyFile = writeCatalog(t, []);
  loadImageCatalog(emptyFile, { logger });
  assert.ok(logs.some((l) => l.includes("0 key")), "โหลดได้ 0 key ต้องเห็นใน log ไม่ใช่เงียบ");
});
