// แคมเปญ #AIAGENT — พิสูจน์ "ไม่กระทบระบบเดิม" (คำสั่งพี่ง้วง 11 ต.ค. 2026 04:15)
//
// ค่าอ้างอิง test/fixtures/blueprint-zero-impact-golden.json ถูกบันทึกจากซอร์สของคอมมิต 882ba78a (13 ต.ค. คำถามชวนสุภาพ/ห้ามถามติดเรื่องเงิน — ขึ้น production ต่อจากนี้)
// ด้วยตัวเล่นซ้ำตัวเดียวกัน (fixtures/blueprint-replay-harness.mjs) — บันทึกซ้ำได้ด้วย
//   scripts/record-blueprint-zero-impact-golden.mjs (ดูวิธีในหัวไฟล์นั้น)
// ตัวเล่นส่งข้อความตัวแทนผ่าน webhook ที่ลงลายเซ็นจริง แล้วเก็บทุกคำขอถึง LINE (ทั้งก้อน) ทุกคำขอถึงโมเดล (sha256 ทั้งก้อน)
// ผลเทิร์น และทุกตารางในฐาน — เทียบแบบ deep-equal หลัง normalize แค่ uuid/เวลา
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/server.mjs";
import { saveCampaign } from "../src/blueprintCampaignConfig.mjs";
import * as helpers from "./helpers.mjs";
import { CAMPAIGN_CUSTOMER, runReplay } from "./fixtures/blueprint-replay-harness.mjs";

helpers.poisonGlobalFetch();
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/blueprint-zero-impact-golden.json", import.meta.url), "utf8"));
const deps = { createApp, ...helpers };
const IESA6 = { campaignId: "IESA6", keyword: "#AIAGENT", title: "IESA S-Curve MBA รุ่น 6", sendAt: "2026-10-12T10:00:00+07:00", followupOffDays: 7 };

function withoutBlueprintSettings(tables) {
  return { ...tables, settings: tables.settings.filter((row) => !String(row.key).startsWith("blueprint_")) };
}

// ตัดเฉพาะของห้องที่ส่ง #AIAGENT จริง (+ ค่าตั้งของแคมเปญ) ออก — ที่เหลือต้องเหมือนเดิมทุกแถว
function withoutCampaignRoom(tables) {
  const out = {};
  for (const [name, rows] of Object.entries(withoutBlueprintSettings(tables))) {
    if (name === "line_send_ledger") continue; // ตัวนับรวมต่อวัน ไม่มีรหัสห้อง — ตรวจแยกด้านล่าง
    out[name] = rows.filter((row) => !JSON.stringify(row).includes(CAMPAIGN_CUSTOMER));
  }
  return out;
}

test("ไม่มีแคมเปญในฐาน (สภาพหลัง deploy ก่อนลงค่าตั้ง) = เหมือนคอมมิต production 882ba78a ทุกไบต์", async () => {
  assert.equal(GOLDEN.commit, "882ba78a2dd49882508efe14f4570046cfb2c8b7");
  const run = await runReplay(deps);
  assert.deepEqual(run.steps, GOLDEN.steps);
  assert.deepEqual(run.tablesBeforeCampaign, GOLDEN.tablesBeforeCampaign);
  assert.deepEqual(run.tablesAfter, GOLDEN.tablesAfter);
});

test("ไม่ส่งตัวรับคำขอให้ pipeline (blueprintCampaign = null) = เหมือนคอมมิต production 882ba78a ทุกไบต์", async () => {
  const run = await runReplay(deps, { overrides: { blueprintCampaign: null } });
  assert.deepEqual(run.steps, GOLDEN.steps);
  assert.deepEqual(run.tablesAfter, GOLDEN.tablesAfter);
});

test("แคมเปญปิด (enabled:false) แม้สวิตช์ส่งเป็น on = เหมือนคอมมิต production 882ba78a (ต่างแค่แถวค่าตั้งของแคมเปญเอง)", async () => {
  const run = await runReplay(deps, { beforeApp: (db) => {
    saveCampaign(db, { ...IESA6, enabled: false });
    db.setSetting("blueprint_send_mode", "on");
  } });
  assert.deepEqual(run.steps, GOLDEN.steps);
  assert.deepEqual(withoutBlueprintSettings(run.tablesBeforeCampaign), GOLDEN.tablesBeforeCampaign);
  assert.deepEqual(withoutBlueprintSettings(run.tablesAfter), GOLDEN.tablesAfter);
});

test("แคมเปญเปิด + สวิตช์ on: ทุกข้อความที่ไม่ใช่ #AIAGENT และทุกห้องอื่น = เหมือนคอมมิต production 882ba78a ทุกไบต์", async () => {
  const run = await runReplay(deps, { beforeApp: (db) => {
    saveCampaign(db, { ...IESA6, enabled: true });
    db.setSetting("blueprint_send_mode", "on");
  } });
  const byId = (steps) => Object.fromEntries(steps.map((step) => [step.id, step]));
  const got = byId(run.steps);
  const want = byId(GOLDEN.steps);
  // ห้องอื่นทุกห้อง รวมถึงหลังจากมีคำขอ #AIAGENT เข้ามาแล้ว (r14, r15) และห้อง Facebook ที่พิมพ์ #AIAGENT (fb1)
  for (const id of Object.keys(want).filter((key) => key !== "r13" && key !== "r16")) {
    assert.deepEqual(got[id], want[id], id);
  }
  assert.deepEqual(withoutBlueprintSettings(run.tablesBeforeCampaign), GOLDEN.tablesBeforeCampaign);
  assert.deepEqual(withoutCampaignRoom(run.tablesAfter), withoutCampaignRoom(GOLDEN.tablesAfter));

  // ห้องที่พิมพ์ #AIAGENT: จากเงียบ → ตอบรับครั้งเดียว (ไม่เรียกโมเดล)
  assert.deepEqual(want.r13.outcome, { reason: "hashtag_auto_response", status: "silent_by_design" });
  assert.deepEqual(got.r13.outcome, { reason: "", status: "answered" });
  assert.equal(got.r13.hermes.length, 0);
  assert.equal(got.r13.line.length, 1);
  assert.equal(got.r13.line[0].path, "/v2/bot/message/reply");
  assert.deepEqual(got.r13.line[0].body.messages.map((m) => m.type), ["text", "flex"]);
  // ข้อความถัดไปของห้องเดียวกัน = ลูกแพรตอบตามปกติ (เรียกโมเดลตอบแชท + ตอบด้วย reply token ของข้อความนั้น)
  assert.equal(got.r16.outcome.status, "answered");
  assert.equal(got.r16.hermes.length, want.r16.hermes.length);
  assert.equal(got.r16.line.at(-1).path, "/v2/bot/message/reply");
  assert.equal(got.r16.line.at(-1).body.replyToken, "rt-r16");

  // ตัวนับการส่งรายวัน: ต่างจากเดิมแค่ใบตอบรับหนึ่งคำขอ (reply ฟรี 1 ผู้รับ 2 ก้อน) ที่เหลือเท่าเดิมทุกแถว
  const key = (row) => `${row.method}|${row.purpose}|${row.detail}`;
  const ledger = (tables) => Object.fromEntries(tables.line_send_ledger.map((row) => [key(row), row]));
  const before = ledger(GOLDEN.tablesAfter);
  const after = ledger(run.tablesAfter);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort());
  for (const [k, row] of Object.entries(after)) {
    if (k === "reply|customer_reply|") {
      assert.equal(row.sends, before[k].sends + 1);
      assert.equal(row.requests, before[k].requests + 1);
      assert.equal(row.recipients, before[k].recipients + 1);
      assert.equal(row.message_objects, before[k].message_objects + 2);
      assert.equal(row.counts_quota, 0);
    } else {
      assert.deepEqual(row, before[k], k);
    }
  }
});
