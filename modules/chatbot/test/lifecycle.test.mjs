// v1.4 Lifecycle เฟส 1 (shadow) — ตาม ARCHITECTURE_LIFECYCLE_PROFILES.md
// สัญญาสำคัญที่สุดของเฟสนี้: ลูกค้าเห็นพฤติกรรมเดิม 100% (prompt byte-identical)
// และข้อมูลใหม่รอด /reset แต่หายเกลี้ยงเมื่อ PDPA ลบ
import test from "node:test";
import assert from "node:assert/strict";

import { createLifecycle, lifecycleMode, LIFECYCLE_MODE_KEY } from "../src/lifecycle.mjs";
import { FACT_KEYS, SALES_DEAL_FLOW } from "../src/dbLifecycle.mjs";
import { createApp } from "../src/server.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, signLine, listen, sleep } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const COURSES_POLICY = Object.freeze({
  courses: [
    { id: "ai-agent-business", name: "AI Agent for Business", aliases: ["AI Basic"] },
    { id: "ai-workflow", name: "AI Agent Automation Workflow", aliases: ["AI Advance"] },
  ],
});

function shadowDb() {
  const db = memoryDb();
  db.setSetting(LIFECYCLE_MODE_KEY, "shadow");
  return db;
}

test("lifecycle mode: default off, ค่าขยะ = off (fail-closed), ค่า valid อ่านตรง", () => {
  const db = memoryDb();
  assert.equal(lifecycleMode(db), "off");
  db.setSetting(LIFECYCLE_MODE_KEY, "banana");
  assert.equal(lifecycleMode(db), "off", "ค่านอกรายการต้องเป็น off ห้ามเดา");
  db.setSetting(LIFECYCLE_MODE_KEY, "shadow");
  assert.equal(lifecycleMode(db), "shadow");
  assert.equal(lifecycleMode({ getSetting() { throw new Error("db พัง"); } }), "off", "อ่านพัง = off");
  db.close();
});

test("facts: precedence human > deterministic > scorer และชั้นเดียวกันเขียนครั้งแรกชนะ", () => {
  const db = memoryDb();
  db.upsertCustomer("U-f", {});
  assert.throws(() => db.setCustomerFact({ customerId: "U-f", factKey: "ไม่มีจริง", value: "x", source: "human" }),
    /fact_key นอกรายการ/u);
  assert.throws(() => db.setCustomerFact({ customerId: "U-f", factKey: "ai_level", value: "3", source: "robot" }),
    /source นอกรายการ/u);

  assert.equal(db.setCustomerFact({ customerId: "U-f", factKey: "ai_level", value: "3", source: "scorer" }).written, true);
  assert.equal(db.setCustomerFact({ customerId: "U-f", factKey: "ai_level", value: "5", source: "scorer" }).written, false,
    "scorer เติมได้เฉพาะคีย์ว่าง");
  assert.equal(db.setCustomerFact({ customerId: "U-f", factKey: "ai_level", value: "4", source: "deterministic" }).written, true,
    "deterministic ทับของ scorer ได้");
  assert.equal(db.setCustomerFact({ customerId: "U-f", factKey: "ai_level", value: "2", source: "deterministic" }).written, false,
    "ชั้นเดียวกันเขียนครั้งแรกชนะ — detector แกว่งค่าไม่ได้");
  assert.equal(db.setCustomerFact({ customerId: "U-f", factKey: "ai_level", value: "1", source: "human" }).written, true,
    "คนชนะทุกชั้น");
  assert.equal(db.setCustomerFact({ customerId: "U-f", factKey: "ai_level", value: "9", source: "deterministic" }).written, false,
    "ระบบห้ามทับค่าที่คนตั้ง");
  assert.equal(db.getCustomerFact("U-f", "ai_level").value, "1");
  assert.equal(FACT_KEYS.length, 15, "คีย์ปิดตามแบบบันทึกคู่มือ 5.1");
  db.close();
});

test("shadow ขาเข้า: จับ facts จาก detector เดิม + new -> collecting_info + idempotent", () => {
  const db = shadowDb();
  db.upsertCustomer("U-in", {});
  const lifecycle = createLifecycle({ db, salesPolicy: COURSES_POLICY, logger: silent });

  const result = lifecycle.applyInbound({ customerId: "U-in", text: "ระดับ 3 ครับ ทีมมา 12 คน" });
  assert.equal(result.captured, 2);
  assert.equal(db.getCustomerFact("U-in", "ai_level").value, "3");
  assert.equal(db.getCustomerFact("U-in", "ai_level").source, "deterministic");
  assert.equal(db.getCustomerFact("U-in", "headcount").value, "12");
  assert.equal(db.getLifecycle("U-in").dealStatus, "collecting_info", "ให้ข้อมูลแล้ว = พ้น new");

  // ข้อความเดิมซ้ำ (redelivery/burst) = no-op ทั้ง facts และ event log
  const events = db.listLifecycleEvents("U-in").length;
  const replay = lifecycle.applyInbound({ customerId: "U-in", text: "ระดับ 3 ครับ ทีมมา 12 คน" });
  assert.equal(replay.captured, 0);
  assert.equal(db.listLifecycleEvents("U-in").length, events, "replay ห้ามงอก event");

  // บริบทลบของ detector เดิมต้องยังคุ้มครองอยู่ (ผ่าน detectRoundInterest)
  db.upsertCustomer("U-neg", {});
  lifecycle.applyInbound({ customerId: "U-neg", text: "ขอยกเลิกรอบวันที่ 15 ค่ะ" });
  assert.equal(db.getCustomerFact("U-neg", "chosen_round"), null, "ยกเลิกรอบ ≠ เลือกรอบ");
  db.close();
});

test("shadow ขาออก: price_sent เฉพาะเลขตรงราคาอนุมัติ, class_recommended จากชื่อ/alias, เดินหน้าเท่านั้น", () => {
  const db = shadowDb();
  db.upsertCustomer("U-out", {});
  db.setApprovedPrice("AI Agent for Business — Early Bird", 12900);
  db.setApprovedPrice("ส่วนลดมาเรียน 2 ท่านขึ้นไป", 1000);
  const lifecycle = createLifecycle({ db, salesPolicy: COURSES_POLICY, logger: silent });

  // เลขที่ไม่ใช่ราคาอนุมัติ + ไม่มีชื่อคลาส = ไม่เลื่อนอะไร
  lifecycle.applyOutbound({ customerId: "U-out", text: "รอบเรียนวันที่ 22 เริ่ม 10:00 น. มี 12,345 อย่างให้ลองค่ะ" });
  assert.equal(db.getLifecycle("U-out").dealStatus, "new");

  // ชื่อคลาส (ผ่าน alias) = class_recommended
  lifecycle.applyOutbound({ customerId: "U-out", text: "แนะนำคลาส AI Basic ค่ะ เหมาะกับพื้นฐานเลย" });
  assert.equal(db.getLifecycle("U-out").dealStatus, "class_recommended");

  // เลขส่วนลด (1,000) ไม่ใช่การแจ้งราคา
  lifecycle.applyOutbound({ customerId: "U-out", text: "มา 2 ท่านลดเพิ่มท่านละ 1,000 บาทค่ะ" });
  assert.equal(db.getLifecycle("U-out").dealStatus, "class_recommended", "ตัวปรับราคาไม่ใช่ price_sent");

  // ราคาอนุมัติจริง = price_sent
  lifecycle.applyOutbound({ customerId: "U-out", text: "Early Bird เหลือ 12,900 บาทค่ะ" });
  assert.equal(db.getLifecycle("U-out").dealStatus, "price_sent");

  // ถอยหลังไม่ได้ — เอ่ยชื่อคลาสอีกครั้งหลังแจ้งราคาแล้ว สถานะต้องไม่ถอย
  lifecycle.applyOutbound({ customerId: "U-out", text: "AI Agent for Business สอนตั้งแต่พื้นฐานค่ะ" });
  assert.equal(db.getLifecycle("U-out").dealStatus, "price_sent", "เดินหน้าเท่านั้น");

  // ลูกค้าเลือกรอบหลังเห็นราคา = awaiting_payment
  lifecycle.applyInbound({ customerId: "U-out", text: "สนใจรอบวันที่ 22 ค่ะ" });
  assert.equal(db.getLifecycle("U-out").dealStatus, "awaiting_payment");
  assert.equal(db.getCustomerFact("U-out", "chosen_round").value, "วันที่ 22");

  // เลือกรอบก่อนเห็นราคา = ยังไม่ใช่ awaiting_payment (แค่ความสนใจ)
  db.upsertCustomer("U-early", {});
  lifecycle.applyInbound({ customerId: "U-early", text: "สนใจรอบวันที่ 22 ค่ะ" });
  assert.equal(db.getLifecycle("U-early").dealStatus, "collecting_info");
  db.close();
});

test("mode=off: ไม่เขียนอะไรเลยทั้งขาเข้าขาออก", () => {
  const db = memoryDb(); // default off
  db.upsertCustomer("U-off", {});
  const lifecycle = createLifecycle({ db, salesPolicy: COURSES_POLICY, logger: silent });
  assert.equal(lifecycle.applyInbound({ customerId: "U-off", text: "ระดับ 3 ครับ" }).applied, false);
  assert.equal(lifecycle.applyOutbound({ customerId: "U-off", text: "AI Basic 12,900 บาท" }).applied, false);
  assert.equal(db.getCustomerFacts("U-off").length, 0);
  assert.equal(db.listLifecycleEvents("U-off").length, 0);
  assert.equal(db.getLifecycle("U-off").dealStatus, "new");
  db.close();
});

test("ข้ามแกน lifecycle_stage: ระบบทำไม่ได้ คนทำได้ + event log ครบ", () => {
  const db = shadowDb();
  db.upsertCustomer("U-stage", {});
  assert.throws(
    () => db.applyLifecycleTransition({ customerId: "U-stage", toStage: "enrolled", actor: "system" }),
    /คนกดเท่านั้น/u,
    "การข้ามเส้นเงินเป็นสิทธิ์คน — invariant อยู่ในชั้น DB",
  );
  const moved = db.applyLifecycleTransition({
    customerId: "U-stage", toStage: "enrolled", toStatus: "paid_confirmed",
    trigger: "confirm_payment", actor: "human", evidence: "operator: chompoo",
  });
  assert.equal(moved.changed, true);
  assert.deepEqual(db.getLifecycle("U-stage"), { stage: "enrolled", dealStatus: "paid_confirmed" });
  const event = db.listLifecycleEvents("U-stage")[0];
  assert.equal(event.from_stage, "sales");
  assert.equal(event.to_stage, "enrolled");
  assert.equal(event.actor, "human");
  assert.throws(() => db.applyLifecycleTransition({ customerId: "U-stage", toStatus: "ไม่มีจริง", actor: "human" }),
    /deal_status นอกรายการ/u);
  db.close();
});

test("/reset (rotate) คง facts+สถานะ; PDPA resetCustomer ลบเกลี้ยงทั้ง 4 ตาราง + คอลัมน์กลับ default", () => {
  const db = shadowDb();
  db.upsertCustomer("U-keep", {});
  db.insertMessage({ customerId: "U-keep", direction: "in", content: "ระดับ 4" });
  db.setCustomerFact({ customerId: "U-keep", factKey: "ai_level", value: "4", source: "deterministic" });
  db.applyLifecycleTransition({ customerId: "U-keep", toStatus: "price_sent", trigger: "test", actor: "system" });
  db.addEnrollment({ customerId: "U-keep", courseId: "ai-agent-business", confirmedBy: "chompoo" });

  db.rotateTrainingSession({ customerId: "U-keep", resetEventId: "re-1" });
  assert.equal(db.getCustomerFact("U-keep", "ai_level").value, "4", "ความจำโครงสร้างต้องรอด /reset");
  assert.equal(db.getLifecycle("U-keep").dealStatus, "price_sent", "สถานะดีลรอด /reset");
  assert.equal(db.listEnrollments("U-keep").length, 1);

  db.resetCustomer("U-keep");
  assert.equal(db.getCustomerFacts("U-keep").length, 0, "PDPA: facts มีข้อมูลส่วนตัว ลบเกลี้ยง");
  assert.equal(db.listLifecycleEvents("U-keep").length, 0);
  assert.equal(db.listEnrollments("U-keep").length, 0);
  assert.deepEqual(db.getLifecycle("U-keep"), { stage: "sales", dealStatus: "new" });
  db.close();
});

test("schema idempotence: SCHEMA + ensureColumn รันซ้ำบน DB เดิมไม่พัง ข้อมูลอยู่ครบ", async (t) => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb } = await import("../src/db.mjs");
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "test.sqlite");
  const first = openDb({ file });
  first.upsertCustomer("U-s", {});
  first.setCustomerFact({ customerId: "U-s", factKey: "headcount", value: "5", source: "deterministic" });
  first.close();
  const second = openDb({ file }); // เปิดซ้ำ = migration ทุกตัวรันซ้ำ
  assert.equal(second.getCustomerFact("U-s", "headcount").value, "5");
  assert.deepEqual(second.getLifecycle("U-s"), { stage: "sales", dealStatus: "new" });
  second.close();
});

// สัญญาใหญ่ที่สุดของเฟส 1: เปิด shadow แล้ว prompt ที่โมเดลเห็นต้องเหมือน off ทุก byte
test("shadow ไม่เปลี่ยน system prompt แม้แต่ byte เดียว (off vs shadow)", async (t) => {
  async function promptFor(mode) {
    const db = memoryDb();
    t.after(() => db.close());
    if (mode !== "off") db.setSetting(LIFECYCLE_MODE_KEY, mode);
    db.setApprovedPrice("AI Agent for Business — Early Bird", 12900);
    const hermesFetch = hermesFetchStub("แนะนำ AI Agent for Business ค่ะ Early Bird 12,900 บาทค่ะ");
    const config = testConfig({ LINE_CHANNEL_SECRET: "s".repeat(32), BURST_DEBOUNCE_MS: "5", BURST_MAX_WAIT_MS: "10", SEND_DELAY_SCALE: "0" });
    const app = createApp({
      config, db,
      overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
      logger: silent,
    });
    await listen(app.server);
    t.after(() => app.server.close());
    // สองเทิร์น: เทิร์นสองเกิดหลัง shadow เขียน facts/สถานะจากเทิร์นแรกแล้ว —
    // ถ้ามีเส้นทางไหนอ่านของใหม่เข้า prompt จะโผล่ที่นี่ก่อนที่อื่น
    // นับเฉพาะ call ฝั่งตอบลูกค้า — v1.4.2 ทั้ง draft และ scorer ประกาศงบโทเคนแล้ว
    // จึงแยกด้วยรูปแบบข้อความแทน: scorer ส่ง transcript ที่ทุกบรรทัดขึ้น "ลูกค้า:/แอดมิน:"
    // และรอเทิร์นแรกตอบจบก่อนยิงเทิร์นสอง — ยิงติดกันใต้โหลดจะโดน burst รวมเป็น
    // ก้อนเดียวแล้วเหลือ call เดียว ทำให้เทสต์ flaky
    const draftCalls = () => hermesFetch.calls.filter((call) =>
      !String(call.body?.messages?.at(-1)?.content ?? "").startsWith("ลูกค้า:"));
    const turns = ["ระดับ 3 ครับ ทีม 12 คน", "ราคาเท่าไหร่ครับ"];
    for (const [turnIndex, text] of turns.entries()) {
      const body = JSON.stringify({
        destination: "x",
        events: [{ type: "message", mode: "active", timestamp: 1700000000000, webhookEventId: `we-${text}`,
          deliveryContext: { isRedelivery: false }, replyToken: `rt-${text}`,
          source: { type: "user", userId: "U-prompt" },
          message: { id: `m-${text}`, type: "text", text } }],
      });
      await httpRequest(app.server, {
        method: "POST", path: "/webhooks/line",
        headers: { "content-type": "application/json", "x-line-signature": signLine(body, config.lineChannelSecret) },
        body,
      });
      for (let i = 0; i < 1000 && draftCalls().length < turnIndex + 1; i += 1) await sleep(10);
    }
    assert.ok(draftCalls().length >= 2, "ต้องมี call ถึงโมเดลครบสองเทิร์น");
    return draftCalls()
      .slice(0, 2)
      .map((call) => call.body?.messages?.[0]?.content ?? "")
      .join("\n=====\n");
  }

  const off = await promptFor("off");
  const shadow = await promptFor("shadow");
  assert.equal(shadow, off, "shadow ต้อง byte-identical กับ off — เฟส 1 ห้ามมีใครอ่านข้อมูลใหม่");
  assert.equal(SALES_DEAL_FLOW[0], "new", "ลำดับ flow เริ่มที่ new");
});
