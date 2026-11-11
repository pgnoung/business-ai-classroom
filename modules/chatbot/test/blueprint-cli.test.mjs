// tools/blueprint-campaign.mjs — ทางสำรองคุมแคมเปญจากเครื่อง: dry-run ค่าตั้งต้น · ไม่มีรหัสลูกค้าในผล · คืน FU ก่อนถอย release
import test from "node:test";
import assert from "node:assert/strict";
import { createBlueprintCampaign } from "../src/blueprintCampaign.mjs";
import { readCampaign, readSendMode } from "../src/blueprintCampaignConfig.mjs";
import { parseArgs, runCommand } from "../tools/blueprint-campaign.mjs";
import { memoryDb } from "./helpers.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readEntry, updateEntry } from "../src/blueprintStore.mjs";
import { SAMPLE_BLUEPRINT } from "./blueprint-fixtures.mjs";

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const NOW = Date.parse("2026-10-11T15:10:00+07:00");

test("CLI: seed/mode/cap/disable — dry-run ไม่เขียน · --apply เขียน + audit · ค่าผิดถูกปฏิเสธ", () => {
  const db = memoryDb({ now: () => NOW });
  assert.deepEqual(parseArgs(["--db", "x.sqlite", "mode", "on", "--apply"]), { file: "x.sqlite", apply: true, businessId: "pngoung-tidkradum", rest: ["mode", "on"] });
  assert.match(runCommand(db, { command: "seed", businessId: "pngoung-tidkradum", nowMs: NOW }).message, /dry-run/u);
  assert.equal(readCampaign(db, "IESA6"), null);
  assert.match(runCommand(db, { command: "seed", apply: true, businessId: "pngoung-tidkradum", nowMs: NOW }).message, /IESA6/u);
  assert.equal(readCampaign(db, "IESA6").enabled, true);
  assert.equal(runCommand(db, { command: "mode", args: ["on"], nowMs: NOW }).ok, true);
  assert.equal(readSendMode(db), "off", "dry-run ไม่เขียน");
  assert.equal(runCommand(db, { command: "mode", args: ["send"], apply: true }).ok, false);
  runCommand(db, { command: "mode", args: ["pregenerate"], apply: true });
  assert.equal(readSendMode(db), "pregenerate");
  assert.equal(runCommand(db, { command: "cap", args: ["-1"], apply: true }).ok, false);
  runCommand(db, { command: "cap", args: ["90"], apply: true });
  assert.equal(db.getSetting("blueprint_daily_cap_thb"), "90");
  assert.equal(runCommand(db, { command: "model", args: ["IESA6", "GPT 6"], apply: true }).ok, false);
  runCommand(db, { command: "model", args: ["IESA6", "gpt-6.1-sol"], apply: true });
  assert.equal(readCampaign(db, "IESA6").model, "gpt-6.1-sol");
  runCommand(db, { command: "model", args: ["IESA6", "-"], apply: true });
  assert.equal(readCampaign(db, "IESA6").model, "");
  runCommand(db, { command: "disable", args: ["IESA6"], apply: true });
  assert.equal(readCampaign(db, "IESA6").enabled, false);
  assert.equal(readCampaign(db, "IESA6").tag, "ที่มา: IESA6 · AI Agent", "ค่าอื่นของแคมเปญไม่หาย");
  assert.ok(db.listAudit().filter((row) => row.operator === "cli:blueprint-campaign").length >= 3);
  db.close();
});

test("CLI: release-holds คืน FU ที่พักไว้ (ทางถอยก่อนสลับ release) · status ไม่มีรหัสลูกค้า", async () => {
  const db = memoryDb({ now: () => NOW });
  runCommand(db, { command: "seed", apply: true, businessId: "pngoung-tidkradum", nowMs: NOW });
  const intake = createBlueprintCampaign({ db, line: { replyMessages: async () => ({ ok: true }) }, now: () => NOW, logger: silent });
  for (const id of ["U-cli-1", "U-cli-2"]) {
    db.upsertCustomer(id, {});
    const text = "#AIAGENT IESA6\nธุรกิจ: ร้านดอกไม้\nอยากให้ผู้ช่วย AI ทำก่อน: รับออเดอร์";
    await intake.intake({ ...intake.match({ customerId: id, text }), customerId: id, text, replyToken: "rt" });
  }
  assert.equal(db.getCustomer("U-cli-1").followup_enabled, 0);
  const report = runCommand(db, { command: "status", nowMs: NOW }).message;
  assert.match(report, /"holdsActive": 2/u);
  assert.doesNotMatch(report, /U-cli|ร้านดอกไม้/u);
  assert.equal(runCommand(db, { command: "release-holds", args: ["IESA6"], nowMs: NOW }).changed, 2);
  assert.equal(db.getCustomer("U-cli-1").followup_enabled, 0, "dry-run ไม่คืน");
  const done = runCommand(db, { command: "release-holds", args: ["IESA6"], apply: true, nowMs: NOW });
  assert.equal(done.changed, 2);
  assert.equal(db.getCustomer("U-cli-1").followup_enabled, 1);
  assert.equal(db.getCustomer("U-cli-2").followup_choice_by_human, 0);
  assert.equal(runCommand(db, { command: "release-holds", args: ["IESA6"], apply: true, nowMs: NOW }).changed, 0, "คืนครั้งเดียว");
  db.close();
});

test("CLI: import-drafts ลงแผนที่ตรวจแล้วเป็น ready — จับคู่ข้อความ · dry-run ไม่เขียน · ไม่ทับที่ส่งแล้ว · schema ผิดไม่เขียนสักราย", async () => {
  const db = memoryDb({ now: () => NOW });
  runCommand(db, { command: "seed", apply: true, businessId: "pngoung-tidkradum", nowMs: NOW });
  const intake = createBlueprintCampaign({ db, line: { replyMessages: async () => ({ ok: true }) }, now: () => NOW, logger: silent });
  const ask = (business, answer) => `#AIAGENT IESA6\nธุรกิจ: ${business}\nอยากให้ผู้ช่วย AI ทำก่อน: ${answer}`;
  for (const [id, business] of [["U-imp-1", "ร้านดอกไม้"], ["U-imp-2", "ร้านกาแฟ"], ["U-imp-3", "ร้านเบเกอรี่"]]) {
    db.upsertCustomer(id, {});
    const text = ask(business, "รับออเดอร์");
    await intake.intake({ ...intake.match({ customerId: id, text }), customerId: id, text, replyToken: "rt" });
  }
  updateEntry(db, "IESA6", "U-imp-3", (current) => ({ ...current, status: "sent" }));
  const dir = mkdtempSync(join(tmpdir(), "bp-import-"));
  const file = join(dir, "drafts.json");
  writeFileSync(file, JSON.stringify([
    { business: "ร้านดอกไม้", answer: "รับออเดอร์", model: "gpt-6.1-sol", blueprint: SAMPLE_BLUEPRINT },
    { business: "ร้านเบเกอรี่", answer: "รับออเดอร์", blueprint: SAMPLE_BLUEPRINT },
    { business: "ร้านที่ไม่มีใครส่ง", answer: "รับออเดอร์", blueprint: SAMPLE_BLUEPRINT },
  ]));

  const dry = runCommand(db, { command: "import-drafts", args: ["IESA6", "--from", file], nowMs: NOW });
  assert.equal(dry.ok, true, dry.message);
  assert.equal(dry.changed, 1);
  assert.match(dry.message, /dry-run/u);
  assert.match(dry.message, /#2: ข้าม \(สถานะ sent\)/u);
  assert.match(dry.message, /#3: ไม่พบคำขอ/u);
  assert.doesNotMatch(dry.message, /U-imp/u, "ผลไม่มีรหัสลูกค้า");
  assert.equal(readEntry(db, "IESA6", "U-imp-1").status, "pending", "dry-run ไม่เขียน");

  const done = runCommand(db, { command: "import-drafts", args: ["IESA6", "--from", file], apply: true, nowMs: NOW });
  assert.equal(done.changed, 1, done.message);
  assert.match(done.message, /คำขอที่ไม่มีในไฟล์ 1 ราย/u);
  const entry = readEntry(db, "IESA6", "U-imp-1");
  assert.equal(entry.status, "ready");
  assert.equal(entry.draft.importedBy, "cli:blueprint-campaign");
  assert.equal(entry.draft.model, "gpt-6.1-sol");
  assert.equal(entry.draft.forRev, entry.rev);
  assert.equal(entry.draft.format, "flex");
  assert.equal(readEntry(db, "IESA6", "U-imp-2").status, "pending", "คนที่ไม่มีในไฟล์สร้างตามปกติ");
  assert.equal(readEntry(db, "IESA6", "U-imp-3").status, "sent", "ส่งแล้วไม่ทับ");
  assert.equal(db.listAudit().filter((row) => row.action === "blueprint_draft_imported").length, 1);

  writeFileSync(file, JSON.stringify([
    { business: "ร้านกาแฟ", answer: "รับออเดอร์", blueprint: SAMPLE_BLUEPRINT },
    { business: "ร้านดอกไม้", answer: "รับออเดอร์", blueprint: { headline: "ไม่ครบ" } },
  ]));
  const bad = runCommand(db, { command: "import-drafts", args: ["IESA6", "--from", file], apply: true, nowMs: NOW });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /รายการที่ 2 ไม่ผ่าน schema/u);
  assert.equal(readEntry(db, "IESA6", "U-imp-2").status, "pending", "รายการผิดหนึ่งตัว = ไม่เขียนสักราย");
  db.close();
});
