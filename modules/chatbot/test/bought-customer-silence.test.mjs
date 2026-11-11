// ห้องที่ติดป้าย "customer" (ซื้อแล้ว) บอทต้องเงียบถาวร
//
// เหตุการณ์จริง 2026-08-28: ทีมงานติดป้าย customer ให้ห้องหนึ่งตอน 08-27 13:31
// แล้ว staged follow-up ยังยิงข้อความไปหาลูกค้ารายนั้นอีกสองข้อความตอน 08-28 09:01
// (นาทีแรกที่หน้าต่าง FU เปิด) — ตัวคัดห้องคัดแค่ ai_enabled กับความเคลื่อนไหว
// รายการด่านก่อนส่งก็ไม่มีป้ายนี้อยู่ในนั้นเลย
//
// ตอนนั้นมีห้องติดป้าย customer อยู่ 815 ห้อง ที่ยังเปิดรับ follow-up 2 ห้อง
// ถ้าไม่ปิดรูนี้ ห้องเก่าที่ถูกให้คะแนนใหม่จะทยอยกลับมาเปิด FU แล้วโดนทักเพิ่มเรื่อย ๆ
import test from "node:test";
import assert from "node:assert/strict";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createStagedFollowups } from "../src/stagedFollowups.mjs";
import { poisonGlobalFetch, testConfig, memoryDb } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const NOON_BKK = Date.UTC(2026, 0, 15, 5, 0, 0); // เที่ยงตรงเวลาไทย = อยู่ในหน้าต่าง FU
const HOUR = 60 * 60 * 1000;

function makeWorld({ onHermesCall = null } = {}) {
  const clock = { now: NOON_BKK };
  const config = testConfig({ STAGED_FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_TICK_MS: "0" });
  // นาฬิกาเดียวทั้งเทสต์: ฐานข้อมูลกับ engine ต้องอ่านเวลาเดียวกัน ไม่งั้น lease/cooldown
  // ใน SQL จะเทียบกับ wall clock แล้วเน่าเองเมื่อวันจริงเดินผ่านวันที่ตรึงไว้
  const db = memoryDb({ now: () => clock.now });
  let drafts = 0;
  const hermesFetch = async () => {
    if (onHermesCall) await onHermesCall();
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { content: `ชวนคุยต่อรอบที่ ${drafts += 1} ค่ะ สนใจด้านไหนคะ?` } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    };
  };
  const hermes = createHermesBridge({
    config, fetchImpl: hermesFetch, logger: silent,
    getReplyModel: () => config.hermesModel, getFollowupModel: () => "",
  });
  const pushes = [];
  const lineCh = { sendBubbles: async (args) => { pushes.push(args); return { ok: true }; } };
  const engine = createStagedFollowups({
    config, db, hermes,
    lineRegistry: { forChannel: () => lineCh, rawUserId: (id) => id },
    guard: createComplianceGuard({ bannedWords: [], getApprovedPrices: () => [] }),
    humanizer: createHumanizer(),
    logger: silent,
    now: () => clock.now,
    imageCatalog: [],
  });
  return { engine, db, clock, pushes, config };
}

// ลูกค้าที่เข้าเกณฑ์ถูกทักทุกประการ — เงียบมานานพอ คะแนนพอ FU เปิด
function seedDueCustomer(db, id) {
  db.upsertCustomer(id, { displayName: "ลูกค้าที่ซื้อแล้ว" });
  db.setFollowupEnabled(id, true);
  db.recordScore(id, 6, "{}");
  const at = NOON_BKK - 6 * HOUR;
  const mid = `m-${id}`;
  db.insertMessage({ id: mid, customerId: id, direction: "in", msgType: "text", content: "สนใจค่ะ" });
  db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(at, mid);
  return id;
}

test("ตัวคัดห้องต้องไม่หยิบห้องที่ติดป้าย customer มาตั้งแต่ต้น", () => {
  const { db } = makeWorld();
  const tagged = seedDueCustomer(db, "U-bought");
  const plain = seedDueCustomer(db, "U-plain");
  db.addTag(tagged, "customer", "human");

  const ids = db.listStagedFollowupCandidates({ nowMs: NOON_BKK, activeWithinMs: 14 * 24 * HOUR })
    .map((r) => r.line_user_id);
  assert.ok(ids.includes(plain), "ห้องปกติต้องยังถูกหยิบมาพิจารณา");
  assert.ok(!ids.includes(tagged), "ห้องที่ซื้อแล้วต้องไม่ถูกหยิบมาเลย");
});

test("บอทต้องไม่ยิงข้อความไปหาห้องที่ติดป้าย customer", async () => {
  const { engine, db, pushes } = makeWorld();
  const id = seedDueCustomer(db, "U-bought");
  db.addTag(id, "customer", "human");

  await engine.runOnce();
  assert.equal(pushes.length, 0, "ต้องไม่มีข้อความออกไปหาลูกค้าที่ซื้อแล้ว");
});

test("ห้องปกติยังถูกทักตามเดิม — ด่านใหม่ต้องไม่ปิดทั้งระบบ", async () => {
  const { engine, db, pushes } = makeWorld();
  seedDueCustomer(db, "U-plain");

  await engine.runOnce();
  assert.equal(pushes.length, 1, "ห้องที่ไม่ได้ติดป้ายต้องยังได้รับ follow-up ปกติ");
});

test("ติดป้ายระหว่างที่บอทกำลังร่างอยู่ ต้องหยุดก่อนยิง", async () => {
  // เคสแข่งกันจริง: ทีมงานกดป้ายตอนบอทเรียกโมเดลอยู่ ซึ่งกินเวลาเป็นนาทีได้
  let db = null;
  const world = makeWorld({
    onHermesCall: async () => { db.addTag("U-bought", "customer", "human"); },
  });
  db = world.db;
  seedDueCustomer(db, "U-bought");

  const result = await world.engine.runOnce();
  assert.equal(world.pushes.length, 0, "ต้องไม่ยิงออกไป แม้ SQL จะคัดมาแล้วตอนยังไม่มีป้าย");
  const skipped = JSON.stringify(result);
  assert.ok(skipped.includes("tag_silenced"), `ต้องบอกเหตุว่าหยุดเพราะป้าย: ${skipped}`);
});


/* ---------------------------- ป้าย "null" ---------------------------- */
//
// เจ้าของสั่งเพิ่ม 2026-08-28: พนักงานบัญชีที่มาตามเอกสาร หรือเจ้าของบริษัทที่ส่งทีม
// มาเรียน ไม่ได้มาคุยกับเรา บอทไม่ควรตอบและไม่ควรทักตามเลย

test("ป้าย null: ตัวคัดห้องต้องไม่หยิบมาตั้งแต่ต้น", () => {
  const { db } = makeWorld();
  const muted = seedDueCustomer(db, "U-null");
  const plain = seedDueCustomer(db, "U-plain");
  db.addTag(muted, "null", "human");

  const ids = db.listStagedFollowupCandidates({ nowMs: NOON_BKK, activeWithinMs: 14 * HOUR * 24 })
    .map((r) => r.line_user_id);
  assert.ok(ids.includes(plain));
  assert.ok(!ids.includes(muted), "ห้องที่ติดป้าย null ต้องไม่ถูกหยิบมาพิจารณา");
});

test("ป้าย null: บอทต้องไม่ยิงข้อความออกไป", async () => {
  const { engine, db, pushes } = makeWorld();
  const id = seedDueCustomer(db, "U-null");
  db.addTag(id, "null", "human");

  await engine.runOnce();
  assert.equal(pushes.length, 0, "ห้องที่ไม่ได้มาคุย ต้องไม่ได้รับ follow-up");
});

test("ป้าย null: พิมพ์ตัวใหญ่ก็ต้องเงียบเหมือนกัน", async () => {
  // ตาราง customer_tags ไม่มี COLLATE NOCASE — "NULL" กับ "null" เป็นคนละแถว
  // ถ้าเทียบแบบสนตัวพิมพ์ ใครพิมพ์ตัวใหญ่จะได้ห้องที่บอทยังทักอยู่โดยไม่รู้ตัว
  const { engine, db, pushes } = makeWorld();
  const id = seedDueCustomer(db, "U-NULL-upper");
  db.addTag(id, "NULL", "human");

  await engine.runOnce();
  assert.equal(pushes.length, 0, "ป้ายตัวใหญ่ต้องกันได้เหมือนกัน");
});
