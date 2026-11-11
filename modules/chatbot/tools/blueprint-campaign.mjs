#!/usr/bin/env node
// blueprint-campaign.mjs — คุมแคมเปญ #AIAGENT จากเครื่อง (ทางสำรองของหน้าคอนโซลที่เปิดให้ Super Admin เท่านั้น)
//
// dry-run เป็นค่าตั้งต้นเสมอ — ต้องใส่ --apply ถึงจะเขียน · รันด้วยบัญชี service เหมือน tools อื่น (ไฟล์ WAL ต้องเป็นของ service)
// ไม่มีคำสั่งไหนส่งข้อความถึงลูกค้า: การส่งเป็นงานของ server (blueprintSender) ตามสวิตช์ blueprint_send_mode เท่านั้น
// ผลที่พิมพ์ออกเป็นตัวเลขรวม ไม่มีรหัสลูกค้า/สิ่งที่ลูกค้าพิมพ์
//
//   node tools/blueprint-campaign.mjs --db <chassis.sqlite> status
//   node tools/blueprint-campaign.mjs --db <chassis.sqlite> seed [--apply]                 ลงแคมเปญตั้งต้น (เหมือนตอนบูต)
//   node tools/blueprint-campaign.mjs --db <chassis.sqlite> mode off|pregenerate|on [--apply]
//   node tools/blueprint-campaign.mjs --db <chassis.sqlite> cap <บาทต่อวัน> [--apply]
//   node tools/blueprint-campaign.mjs --db <chassis.sqlite> enable|disable <campaignId> [--apply]
//   node tools/blueprint-campaign.mjs --db <chassis.sqlite> model <campaignId> <model|-> [--apply]   "-" = ตามโมเดลตอบแชท
//       โมเดลต้องอยู่ใน HERMES_ALLOWED_MODELS ของเครื่อง (ไม่อยู่ = สร้างไม่ผ่านทุกคน แล้วเป็น failed หลัง 3 ครั้ง)
//   node tools/blueprint-campaign.mjs --db <chassis.sqlite> release-holds <campaignId> [--apply]
//       ทางถอย: คืน FU ที่แคมเปญพักไว้ทันที — ต้องทำ "ก่อน" ถอยกลับไป release ที่ไม่มีตัวเดินรอบของแคมเปญ
//       ไม่งั้นห้องที่พักไว้จะปิด FU ค้างตลอด (release เก่าไม่รู้ว่าต้องคืน)
//   node tools/blueprint-campaign.mjs --db <chassis.sqlite> rollback-check
//       ด่านก่อนถอย release: ยังมีห้องที่พัก FU ค้าง = ออกด้วยรหัส 1 พร้อมคำสั่งคืน · 0 ห้อง = รหัส 0 (ถอยได้)
//   node tools/blueprint-campaign.mjs --db <chassis.sqlite> backfill <campaignId> --since <ISO> [--until <ISO>] [--apply]
//       เก็บคำขอ #AIAGENT ที่ลูกค้าส่งมา "ก่อน deploy" (ตอนนั้นเส้นเดิมเงียบให้ # แต่ข้อความอยู่ในตาราง messages)
//       ไม่ส่งใบตอบรับย้อนหลัง — ได้ของจริงตามเวลาแคมเปญ · คนที่มีคำขออยู่แล้วข้าม · ทำซ้ำได้ไม่นับซ้ำ
//       ป้ายผ่านกรอบป้ายเดียวกับ server เมื่อรันพร้อม env ของ service (TAG_FRAMEWORK_FILE)
//   node tools/blueprint-campaign.mjs --db <chassis.sqlite> render <campaignId> --out <dir> [--sample <blueprint.json>]
//       เขียน ack.json / delivery.json (รูป { messages } ของ /v2/bot/message/validate/reply|push) ไว้ให้ตรวจกับ LINE
//       ก่อนเปิดส่งจริง — ไม่ยิง LINE เอง · ไม่มี --sample = ใช้ร่างแรกที่สร้างเสร็จในฐาน (ไฟล์มีเนื้อหาลูกค้า ห้ามแชร์ออก)
//   node tools/blueprint-campaign.mjs --db <chassis.sqlite> import-drafts <campaignId> --from <drafts.json> [--apply]
//       ลงแผนที่เจ้าของตรวจแล้วเป็นร่างพร้อมส่ง (ready) — ของที่ส่งจริง = ของที่ตรวจทุกตัวอักษร ไม่สร้างใหม่ตอนส่ง
//       ไฟล์ = [{ business, answer, blueprint }] จับคู่กับคำขอล่าสุดของลูกค้าด้วยข้อความธุรกิจ+คำตอบตรงกันทุกตัว
//       ทับได้เฉพาะ pending/ready/failed · ลูกค้าส่งใหม่หลังอ่าน (rev เปลี่ยน) = ไม่ทับ · ผ่าน schema และประกอบการ์ดได้ก่อนเขียน
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.mjs";
import {
  BLUEPRINT_MODES, DAILY_CAP_KEY, MAX_DAILY_CAP_THB, SEND_MODE_KEY,
  readCampaign, readCampaigns, readDailyCapThb, readSendMode, saveCampaign, seedCampaigns,
} from "../src/blueprintCampaignConfig.mjs";
import { countByStatus, listEntries, readSpendThb, updateEntry } from "../src/blueprintStore.mjs";
import { createBlueprintCampaign, releaseFollowupHold } from "../src/blueprintCampaign.mjs";
import { blueprintContent, blueprintContentError } from "../src/blueprintContent.mjs";
import { createBlueprintSender } from "../src/blueprintSender.mjs";
import { bangkokDay } from "../src/lineSendLedger.mjs";
import { loadTagFramework } from "../src/tagFramework.mjs";

const OPERATOR = "cli:blueprint-campaign";

export function parseArgs(argv) {
  const out = { file: "", apply: false, businessId: "pngoung-tidkradum", rest: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--apply") out.apply = true;
    else if (flag === "--db" || flag === "--file") out.file = String(argv[++i] || "");
    else if (flag === "--business-id") out.businessId = String(argv[++i] || "");
    else out.rest.push(flag);
  }
  return out;
}

export function status(db, nowMs = Date.now()) {
  const entries = listEntries(db);
  return {
    mode: readSendMode(db),
    capThb: readDailyCapThb(db),
    thbToday: Math.round(readSpendThb(db, bangkokDay(nowMs)) * 100) / 100,
    campaigns: readCampaigns(db).map((c) => ({
      campaignId: c.campaignId, keyword: c.keyword, enabled: c.enabled, sendAt: c.sendAt,
      active: c.enabled && nowMs < c.expiresAtMs,
      counts: countByStatus(entries.filter((e) => e.campaignId === c.campaignId)),
      holdsActive: entries.filter((e) => e.campaignId === c.campaignId && e.hold?.applied && !e.hold.releasedAt).length,
    })),
  };
}

/** ค่าของ option แบบ "--name value" ในอาร์กิวเมนต์ที่เหลือ ("" = ไม่มี) */
export function optionOf(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? String(args[index + 1] || "") : "";
}

function activeHolds(db, campaignId = "") {
  return listEntries(db, campaignId).filter((e) => e.hold?.applied && !e.hold.releasedAt);
}

const SILENT = { log() {}, warn() {}, error() {}, debug() {}, info() {} };

/** @returns {{ ok: boolean, message: string, changed?: number }} */
export function runCommand(db, { command, args = [], apply = false, businessId = "", nowMs = Date.now(), tagFramework = null, logger = SILENT }) {
  const audit = (action, target, detail) => db.addAudit({ operator: OPERATOR, action, target, detail });
  if (command === "status" || !command) return { ok: true, message: JSON.stringify(status(db, nowMs), null, 2) };
  if (command === "seed") {
    if (!apply) return { ok: true, message: `(dry-run) จะลงแคมเปญตั้งต้นถ้ายังไม่มีแถว · businessId=${businessId}` };
    const seeded = seedCampaigns(db, { businessId, nowMs });
    return { ok: true, message: seeded.length ? `ลงแล้ว: ${seeded.join(", ")}` : "ไม่มีอะไรต้องลง (มีแถวอยู่แล้ว/ไม่ใช่เครื่องลูกแพร/พ้นช่วงแคมเปญ)" };
  }
  if (command === "mode") {
    const mode = String(args[0] || "").toLowerCase();
    if (!BLUEPRINT_MODES.includes(mode)) return { ok: false, message: `mode ต้องเป็น ${BLUEPRINT_MODES.join(" / ")}` };
    if (!apply) return { ok: true, message: `(dry-run) ${readSendMode(db)} → ${mode}` };
    db.setSetting(SEND_MODE_KEY, mode);
    audit("blueprint_mode", "", mode);
    return { ok: true, message: `blueprint_send_mode = ${mode}` };
  }
  if (command === "cap") {
    const thb = Number(args[0]);
    if (!Number.isFinite(thb) || thb < 0 || thb > MAX_DAILY_CAP_THB) return { ok: false, message: `เพดานต้องเป็น 0-${MAX_DAILY_CAP_THB} บาท` };
    if (!apply) return { ok: true, message: `(dry-run) ฿${readDailyCapThb(db)} → ฿${thb} ต่อวัน` };
    db.setSetting(DAILY_CAP_KEY, String(thb));
    audit("blueprint_cap", "", `฿${thb}/วัน`);
    return { ok: true, message: `blueprint_daily_cap_thb = ${thb}` };
  }
  if (command === "enable" || command === "disable") {
    const campaign = readCampaign(db, String(args[0] || ""));
    if (!campaign) return { ok: false, message: "ไม่พบแคมเปญนี้" };
    const enabled = command === "enable";
    if (!apply) return { ok: true, message: `(dry-run) ${campaign.campaignId} enabled ${campaign.enabled} → ${enabled}` };
    const { sendAtMs, holdDays, expiresAtMs, ...stored } = campaign;
    const saved = saveCampaign(db, { ...stored, enabled });
    if (!saved.ok) return { ok: false, message: saved.errors.join(" · ") };
    audit("blueprint_campaign", campaign.campaignId, `${enabled ? "เปิด" : "ปิด"} (CLI)`);
    return { ok: true, message: `${campaign.campaignId} enabled = ${enabled}` };
  }
  if (command === "model") {
    const campaign = readCampaign(db, String(args[0] || ""));
    if (!campaign) return { ok: false, message: "ไม่พบแคมเปญนี้" };
    const model = String(args[1] || "") === "-" ? "" : String(args[1] || "");
    if (!apply) return { ok: true, message: `(dry-run) ${campaign.campaignId} model "${campaign.model}" → "${model}"` };
    const { sendAtMs, holdDays, expiresAtMs, ...stored } = campaign;
    const saved = saveCampaign(db, { ...stored, model });
    if (!saved.ok) return { ok: false, message: saved.errors.join(" · ") };
    audit("blueprint_campaign", campaign.campaignId, `model=${model || "(ตามโมเดลตอบแชท)"} (CLI)`);
    return { ok: true, message: `${campaign.campaignId} model = ${model || "(ตามโมเดลตอบแชท)"}` };
  }
  if (command === "release-holds") {
    const campaignId = String(args[0] || "");
    const pending = listEntries(db, campaignId).filter((e) => e.hold?.applied && !e.hold.releasedAt);
    if (!apply) return { ok: true, message: `(dry-run) จะคืน FU ${pending.length} ห้องของ ${campaignId || "ทุกแคมเปญ"}`, changed: pending.length };
    let restored = 0;
    for (const entry of pending) {
      const result = releaseFollowupHold(db, entry.customerId, entry.hold, { at: nowMs });
      const write = updateEntry(db, entry.campaignId, entry.customerId, (current) => (current?.hold && !current.hold.releasedAt
        ? { ...current, hold: { ...current.hold, releasedAt: nowMs, result, releasedBy: OPERATOR } } : null));
      if (write.changed && result === "restored") restored += 1;
    }
    audit("blueprint_release_holds", campaignId, `คืน FU ${restored} ห้อง (CLI)`);
    return { ok: true, message: `คืน FU แล้ว ${restored}/${pending.length} ห้อง (ที่เหลือ = ทีม/ลูกค้าเปลี่ยนเองระหว่างพัก)`, changed: restored };
  }
  if (command === "rollback-check") {
    const holds = activeHolds(db);
    if (!holds.length) return { ok: true, message: "ไม่มีห้องที่แคมเปญพัก FU ค้างอยู่ — ถอย release ได้โดยไม่ทิ้ง FU ปิดค้าง", changed: 0 };
    const ids = [...new Set(holds.map((e) => e.campaignId))];
    return {
      ok: false, changed: holds.length,
      message: `ยังมีห้องที่แคมเปญพัก FU ไว้ ${holds.length} ห้อง (${ids.join(", ")}) — ห้ามถอยกลับ release เก่าก่อนคืน:\n`
        + ids.map((id) => `  node tools/blueprint-campaign.mjs --db <ฐาน> release-holds ${id} --apply`).join("\n"),
    };
  }
  if (command === "backfill") {
    const campaign = readCampaign(db, String(args[0] || ""));
    if (!campaign) return { ok: false, message: "ไม่พบแคมเปญนี้" };
    const since = optionOf(args, "--since");
    const sinceMs = /(?:Z|[+-]\d{2}:\d{2})$/u.test(since) ? Date.parse(since) : Number.NaN;
    if (!Number.isFinite(sinceMs)) return { ok: false, message: "ต้องระบุ --since เป็นเวลา ISO ที่มีโซนเวลา เช่น 2026-10-11T12:00:00+07:00" };
    const until = optionOf(args, "--until");
    const untilMs = until ? Date.parse(until) : nowMs;
    if (!Number.isFinite(untilMs) || untilMs < sinceMs) return { ok: false, message: "--until ต้องเป็นเวลา ISO หลัง --since" };
    const intake = createBlueprintCampaign({ db, tagFramework, logger, now: () => nowMs });
    const result = intake.backfill({ campaign, sinceMs, untilMs, apply });
    if (apply) audit("blueprint_backfill", campaign.campaignId, `เก็บย้อนหลัง ${result.recorded} ราย (พบ ${result.matched} · มีอยู่แล้ว ${result.existing} · Facebook ${result.facebook})`);
    return {
      ok: true, changed: apply ? result.recorded : result.wouldRecord,
      message: `${apply ? "" : "(dry-run) "}${campaign.campaignId}: พบข้อความ ${campaign.keyword} ${result.matched} ราย`
        + ` · ${apply ? `เก็บแล้ว ${result.recorded}` : `จะเก็บ ${result.wouldRecord}`} · มีคำขออยู่แล้ว ${result.existing} · Facebook ข้าม ${result.facebook}`
        + " · ไม่ส่งใบตอบรับย้อนหลัง",
    };
  }
  if (command === "render") {
    const campaign = readCampaign(db, String(args[0] || ""));
    if (!campaign) return { ok: false, message: "ไม่พบแคมเปญนี้" };
    const content = blueprintContent();
    if (!content) return { ok: false, message: `โมดูลเนื้อหาโหลดไม่ได้ (${blueprintContentError() || "unknown"})` };
    const out = optionOf(args, "--out");
    if (!out) return { ok: false, message: "ต้องระบุ --out <โฟลเดอร์>" };
    const sample = optionOf(args, "--sample");
    let blueprint = null;
    let source = "";
    if (sample) {
      let parsed;
      try {
        // รับได้ทั้งแบบวางระบบเปล่า ๆ และไฟล์ตัวอย่างที่ห่อไว้ใน { blueprint } (samples/*.json ของคลาส)
        const raw = readFileSync(sample, "utf8");
        const wrapped = JSON.parse(raw);
        parsed = content.parseBlueprintText(wrapped?.blueprint && typeof wrapped.blueprint === "object" ? JSON.stringify(wrapped.blueprint) : raw);
      } catch (err) { return { ok: false, message: `อ่าน ${sample} ไม่ได้ (${err?.message || err})` }; }
      if (!parsed.ok) return { ok: false, message: `ตัวอย่างไม่ผ่าน schema: ${(parsed.errors || []).slice(0, 3).join(" | ")}` };
      blueprint = parsed.value;
      source = "sample";
    } else {
      const drafted = listEntries(db, campaign.campaignId).find((e) => e.draft?.blueprint);
      if (!drafted) return { ok: false, message: "ยังไม่มีร่างที่สร้างเสร็จในฐาน — ใส่ --sample <ไฟล์ JSON ของแบบวางระบบ>" };
      blueprint = drafted.draft.blueprint;
      source = "db";
    }
    const sender = createBlueprintSender({ db, logger });
    const delivery = sender.renderMessages(blueprint, campaign, null);
    const ack = content.buildAckMessages({ campaign, business: "ร้านกาแฟสองสาขา", submissions: 1, now: nowMs });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "ack.json"), `${JSON.stringify({ messages: ack }, null, 2)}\n`);
    writeFileSync(join(out, "delivery.json"), `${JSON.stringify({ messages: delivery.messages }, null, 2)}\n`);
    return {
      ok: true,
      message: `เขียน ${join(out, "ack.json")} (${ack.length} ก้อน) และ ${join(out, "delivery.json")} (${delivery.messages.length} ก้อน · ${delivery.format} · จาก ${source})`
        + " — ตรวจด้วย POST https://api.line.me/v2/bot/message/validate/reply และ /validate/push (ไม่ส่งถึงใคร)",
    };
  }
  if (command === "import-drafts") return importDrafts(db, { args, apply, nowMs, audit, logger });
  return { ok: false, message: `ไม่รู้จักคำสั่ง "${command}"` };
}

const IMPORTABLE_STATUSES = new Set(["pending", "ready", "failed"]);
const sameText = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();

function importDrafts(db, { args, apply, nowMs, audit, logger }) {
  const campaign = readCampaign(db, String(args[0] || ""));
  if (!campaign) return { ok: false, message: "ไม่พบแคมเปญนี้" };
  const content = blueprintContent();
  if (!content) return { ok: false, message: `โมดูลเนื้อหาโหลดไม่ได้ (${blueprintContentError() || "unknown"})` };
  const from = optionOf(args, "--from");
  if (!from) return { ok: false, message: "ต้องระบุ --from <ไฟล์ JSON>" };
  let items;
  try {
    items = JSON.parse(readFileSync(from, "utf8"));
  } catch (err) { return { ok: false, message: `อ่าน ${from} ไม่ได้ (${err?.message || err})` }; }
  if (!Array.isArray(items) || !items.length) return { ok: false, message: "ไฟล์ต้องเป็นอาร์เรย์ [{ business, answer, blueprint }]" };

  const sender = createBlueprintSender({ db, logger });
  const prepared = [];
  for (const [index, item] of items.entries()) {
    const parsed = content.parseBlueprintText(JSON.stringify(item?.blueprint ?? null));
    if (!parsed.ok) return { ok: false, message: `รายการที่ ${index + 1} ไม่ผ่าน schema: ${(parsed.errors || []).slice(0, 3).join(" | ")}` };
    const rendered = sender.renderMessages(parsed.value, campaign, null);
    if (rendered.format !== "flex") return { ok: false, message: `รายการที่ ${index + 1} ประกอบการ์ดไม่ได้ (ได้ ${rendered.format})` };
    prepared.push({ index: index + 1, business: item.business, answer: item.answer, blueprint: parsed.value, model: String(item.model || ""), format: rendered.format });
  }

  const entries = listEntries(db, campaign.campaignId);
  const lines = [];
  let imported = 0;
  let wouldImport = 0;
  for (const item of prepared) {
    const matches = entries.filter((e) => sameText(e.business, item.business) && sameText(e.answer, item.answer));
    const open = matches.filter((e) => IMPORTABLE_STATUSES.has(e.status));
    if (!matches.length) { lines.push(`#${item.index}: ไม่พบคำขอที่ข้อความตรงกัน`); continue; }
    if (!open.length) { lines.push(`#${item.index}: ข้าม (สถานะ ${matches.map((e) => e.status).join(",")})`); continue; }
    if (!apply) {
      wouldImport += open.length;
      lines.push(`#${item.index}: จะลง ${open.length} ราย (จาก ${open.map((e) => e.status).join(",")})`);
      continue;
    }
    let done = 0;
    for (const entry of open) {
      const write = updateEntry(db, entry.campaignId, entry.customerId, (current) => {
        if (!current || current.rev !== entry.rev || !IMPORTABLE_STATUSES.has(current.status)) return null;
        return {
          ...current, status: "ready", lastError: "", attempts: 0,
          draft: {
            blueprint: item.blueprint, model: item.model, generatedAt: nowMs, forRev: current.rev,
            format: item.format, costThb: 0, importedBy: OPERATOR,
          },
        };
      });
      if (!write.changed) continue;
      done += 1;
      audit("blueprint_draft_imported", entry.customerId, `${entry.campaignId} ร่างที่ตรวจแล้ว #${item.index} (CLI)`);
    }
    imported += done;
    lines.push(`#${item.index}: ลงแล้ว ${done}/${open.length} ราย`);
  }
  const unmatched = entries.filter((e) => IMPORTABLE_STATUSES.has(e.status)
    && !prepared.some((item) => sameText(e.business, item.business) && sameText(e.answer, item.answer))).length;
  return {
    ok: true, changed: apply ? imported : wouldImport,
    message: `${apply ? "" : "(dry-run) "}${campaign.campaignId}: ${apply ? `ลงร่างแล้ว ${imported}` : `จะลงร่าง ${wouldImport}`} ราย`
      + ` · คำขอที่ไม่มีในไฟล์ ${unmatched} ราย (สร้างตามปกติ)\n${lines.join("\n")}`,
  };
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error("ต้องระบุ --db <ไฟล์ฐานข้อมูลของ chassis>");
    process.exit(2);
  }
  const db = openDb({ file: args.file });
  try {
    const [command, ...rest] = args.rest;
    let tagFramework = null;
    if (command === "backfill" && process.env.TAG_FRAMEWORK_FILE) tagFramework = loadTagFramework(process.env.TAG_FRAMEWORK_FILE);
    const result = runCommand(db, { command, args: rest, apply: args.apply, businessId: args.businessId, tagFramework, logger: console });
    (result.ok ? console.log : console.error)(result.message);
    process.exitCode = result.ok ? 0 : 1;
  } finally {
    db.close();
  }
}
