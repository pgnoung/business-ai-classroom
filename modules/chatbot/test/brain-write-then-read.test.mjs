// brain-write-then-read.test.mjs — เฟส 1b + เฟส 2 ต้องประกอบกันได้จริง
//
// นี่คือเหตุผลทั้งหมดของสองเฟสรวมกัน และเป็นสิ่งที่เทสต์ของแต่ละเฟสพิสูจน์แยกกันไม่ได้:
//   1b พิสูจน์ว่า "เขียนจากคอนโซล -> เกิดรุ่นใหม่ + ตารางเดิมยังตรง"
//   2  พิสูจน์ว่า "runtime อ่านรุ่นที่ pointer ชี้"
// แต่ไม่มีใครพิสูจน์ว่า **เทิร์นถัดไปได้ยินสิ่งที่เพิ่งแก้** โดยไม่ต้อง deploy โค้ด
// ซึ่งเป็นข้อเดียวที่พี่ง้วงสนใจ (แบบแปลน §1: "แก้ราคาแล้วถึงลูกค้าโดยไม่ต้องรอช่าง")
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import {
  hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, promptText, testConfig,
} from "./helpers.mjs";
import { importCurrentSourcesAsVersion1 } from "../src/brain/import.mjs";
import { PRODUCT_RULES_KEY } from "../src/tags.mjs";

poisonGlobalFetch();

const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };
const SECRET = "brain-compose-session-secret-0123456789";
const PASSWORD = "brain-compose-pass-1234";
const OLD_FACT = "จอดฟรี 2 ชั่วโมงที่อาคาร B";
const NEW_FACT = "จอดฟรี 4 ชั่วโมงที่อาคาร B";

async function boot(t) {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.addKnowledge({ title: "ที่จอดรถ", content: OLD_FACT, updatedBy: "ngoung" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  db.setSetting(PRODUCT_RULES_KEY, "ลูกค้าองค์กรให้ส่งต่อทีมงานเสมอ");
  const imported = importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: silent });
  assert.equal(imported.created, true);

  const hermesFetch = hermesFetchStub("รับทราบค่ะ");
  const app = createApp({
    // สองแฟล็กพร้อมกัน: 1b เขียนเป็นเวอร์ชัน · 2 ให้ runtime อ่านเวอร์ชันนั้น
    config: testConfig({
      CONSOLE_SESSION_SECRET: SECRET,
      KNOWLEDGE_VERSIONED: "true",
      BRAIN_READ: "versioned",
    }),
    db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  const login = await httpRequest(app.server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "ngoung", password: PASSWORD }),
  });
  assert.equal(login.status, 200, `ล็อกอินต้องผ่าน — ${login.text}`);
  const owner = { cookie: (login.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: login.json.csrf };
  return { app, db, hermesFetch, imported, owner };
}

const lastCall = (hermesFetch) => hermesFetch.calls.at(-1);
const systemOf = (call) => promptText(call.body.messages[0].content);

test("เขียนจากคอนโซล -> รุ่นใหม่ -> เทิร์นถัดไปได้ยินของใหม่ทันที (ไม่ต้อง deploy)", async (t) => {
  const { app, db, hermesFetch, imported, owner } = await boot(t);

  // เทิร์นที่ 1 — ยังเป็นรุ่นแรก และ prompt ยังเป็นข้อความเดิม
  db.upsertCustomer("U-compose", {});
  await app.pipeline.handleInboundText({ customerId: "U-compose", text: "ที่จอดรถเป็นยังไงคะ", replyToken: "rt1" });
  const before = lastCall(hermesFetch);
  assert.match(systemOf(before), new RegExp(OLD_FACT, "u"));
  assert.equal(before.body.prompt_cache_key, `pngoung-tidkradum-${imported.versionId}`);
  assert.equal(db.lastBrainVersionFor("U-compose"), imported.versionId);

  // เจ้าของแก้ความรู้จากคอนโซล (เส้นทางจริง ผ่าน handler ตัวเดียวกับที่คิวอนุมัติเล่นซ้ำ)
  const knowledgeId = db.listKnowledge()[0].id;
  const write = await httpRequest(app.server, {
    method: "POST", path: `/console/api/knowledge/${knowledgeId}`,
    headers: { "content-type": "application/json", cookie: owner.cookie, "x-csrf-token": owner.csrf },
    body: JSON.stringify({ content: NEW_FACT }),
  });
  assert.equal(write.status, 200, `เขียนต้องสำเร็จ — ${write.text}`);
  assert.equal(write.json.brain.outcome, "live", "เจ้าของเขียน = เผยแพร่เป็นรุ่นใช้งานจริงทันที");
  const nextVersion = write.json.brain.versionId;
  assert.notEqual(nextVersion, imported.versionId, "ต้องเป็นรุ่นใหม่ ไม่ใช่ทับรุ่นเดิม");
  assert.equal(db.getBrainPointer("live").version_id, nextVersion, "pointer live ต้องย้ายมาที่รุ่นใหม่");

  // เทิร์นที่ 2 — ต้องได้ยินของใหม่ โดยไม่มีการรีสตาร์ทหรือ deploy อะไรทั้งสิ้น
  await app.pipeline.handleInboundText({ customerId: "U-compose", text: "แล้วจอดได้กี่ชั่วโมงคะ", replyToken: "rt2" });
  const after = lastCall(hermesFetch);
  assert.match(systemOf(after), new RegExp(NEW_FACT, "u"), "เทิร์นถัดไปต้องเห็นข้อความที่เพิ่งแก้");
  assert.doesNotMatch(systemOf(after), new RegExp(OLD_FACT, "u"), "ของเก่าต้องหายไปจริง ไม่ใช่ค้างใน cache");
  assert.equal(after.body.prompt_cache_key, `pngoung-tidkradum-${nextVersion}`, "รุ่นใหม่ต้องหมุนคีย์ cache");
  assert.equal(db.lastBrainVersionFor("U-compose"), nextVersion, "แถวขาออกต้องปั๊มรุ่นใหม่");
  assert.equal(app.brainRuntime.snapshot().versionId, nextVersion);
  assert.equal(app.brainRuntime.snapshot().ok, true, "ทางเดิมไม่ควรถูกใช้เลยตลอดเทสต์นี้");
  assert.equal(app.brainRuntime.snapshot().fallbacks, 0);
});

test("ปิด BRAIN_READ ไว้ = เขียนแล้วเกิดรุ่นใหม่เหมือนเดิม แต่ runtime ยังอ่านตารางเดิม", async (t) => {
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง", role: "owner" });
  db.addKnowledge({ title: "ที่จอดรถ", content: OLD_FACT, updatedBy: "ngoung" });
  db.setApprovedPrice("AI Agent for Business", 19900);
  importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: silent });
  const hermesFetch = hermesFetchStub("รับทราบค่ะ");
  const app = createApp({
    config: testConfig({ CONSOLE_SESSION_SECRET: SECRET, KNOWLEDGE_VERSIONED: "true" }),
    db,
    overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
    logger: silent,
  });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });

  db.upsertCustomer("U-legacy", {});
  await app.pipeline.handleInboundText({ customerId: "U-legacy", text: "ที่จอดรถคะ", replyToken: "rt" });
  // 1b ยังทำงานเต็มที่ (ตารางเดิมถูกเขียนโดย brain store) แต่แถวไม่ถูกปั๊มรุ่น
  // และคีย์ cache ยังเป็นของเดิม — ทางถอยของเฟส 2 คือแฟล็กเดียว ไม่ต้องถอย 1b ตาม
  assert.equal(lastCall(hermesFetch).body.prompt_cache_key, "lukprae-hermes");
  assert.equal(db.lastBrainVersionFor("U-legacy"), null);
  assert.equal(app.brainRuntime.snapshot().mode, "legacy");
});
