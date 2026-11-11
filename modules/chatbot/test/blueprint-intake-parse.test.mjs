// แคมเปญ #AIAGENT — ตัวแยกข้อความ + คีย์เวิร์ด + ค่าตั้งแคมเปญ (pure ล้วน)
import test from "node:test";
import assert from "node:assert/strict";
import { ANSWER_MAX, BUSINESS_MAX, RAW_MAX, parseBlueprintSubmission } from "../src/blueprintIntakeParse.mjs";
import {
  SEED_CAMPAIGNS, campaignForText, keywordRegex, readCampaigns, readDailyCapThb, readSendMode, saveCampaign,
  seedCampaigns, thaiShortDateTime, validateCampaignConfig,
} from "../src/blueprintCampaignConfig.mjs";
import { CAMPAIGN_KEYWORD } from "../src/pipeline.mjs";
import { memoryDb } from "./helpers.mjs";

const CAMPAIGN = { campaignId: "IESA6", keyword: "#AIAGENT" };
const TEMPLATE = "#AIAGENT IESA6\nธุรกิจ: ร้านกาแฟสองสาขา\nอยากให้ผู้ช่วย AI ทำก่อน: ตอบแชทลูกค้าเรื่องเมนูและเวลาเปิด\n(ขอรับไอเดียการวางระบบ AI Agent ภายใน 24 ชม.)";

test("ข้อความตามแบบฟอร์ม → แยกธุรกิจและคำตอบครบ ตัดบรรทัดท้ายของหน้าเว็บทิ้ง", () => {
  const parsed = parseBlueprintSubmission(TEMPLATE, CAMPAIGN);
  assert.equal(parsed.business, "ร้านกาแฟสองสาขา");
  assert.equal(parsed.answer, "ตอบแชทลูกค้าเรื่องเมนูและเวลาเปิด");
  assert.equal(parsed.labelled, true);
  assert.equal(parsed.rawText, TEMPLATE);
});

test("แก้ข้อความก่อนส่ง: สลับลำดับ ตัวพิมพ์เล็ก คำตอบหลายบรรทัด ไม่มีรหัสคลาส", () => {
  const parsed = parseBlueprintSubmission("#aiagent\nอยากให้ผู้ช่วย AI ทำก่อน : สรุปยอดขาย\nทุกเย็นส่งเข้ากลุ่ม\nธุรกิจ - โรงงานผลิตชิ้นส่วน", CAMPAIGN);
  assert.equal(parsed.business, "โรงงานผลิตชิ้นส่วน");
  assert.equal(parsed.answer, "สรุปยอดขาย\nทุกเย็นส่งเข้ากลุ่ม");
});

test("ไม่มีป้ายเลย = ทั้งก้อนเป็นคำตอบ · มีแค่ป้ายคำตอบ = ข้อความลอยก่อนหน้าเป็นธุรกิจ", () => {
  const free = parseBlueprintSubmission("#AIAGENT อยากให้ช่วยตามลูกค้าที่ค้างจ่าย", CAMPAIGN);
  assert.equal(free.business, "");
  assert.equal(free.answer, "อยากให้ช่วยตามลูกค้าที่ค้างจ่าย");
  assert.equal(free.labelled, false);
  const partial = parseBlueprintSubmission("#AIAGENT IESA6 คลินิกทันตกรรม\nอยากให้ผู้ช่วย AI ทำก่อน: นัดคิวคนไข้", CAMPAIGN);
  assert.equal(partial.business, "คลินิกทันตกรรม");
  assert.equal(partial.answer, "นัดคิวคนไข้");
});

test("ช่องหายไป = ว่าง ไม่เดา · คีย์เวิร์ดเปล่า = ว่างทั้งคู่", () => {
  const onlyBusiness = parseBlueprintSubmission("#AIAGENT IESA6\nธุรกิจ: ขายส่งวัสดุก่อสร้าง", CAMPAIGN);
  assert.equal(onlyBusiness.business, "ขายส่งวัสดุก่อสร้าง");
  assert.equal(onlyBusiness.answer, "");
  const bare = parseBlueprintSubmission("#AIAGENT", CAMPAIGN);
  assert.deepEqual([bare.business, bare.answer], ["", ""]);
});

test("อีโมจิคงไว้ ตัวควบคุม/zero-width/bidi ถูกตัด", () => {
  const parsed = parseBlueprintSubmission("#AIAGENT\nธุรกิจ: ร้านเค้ก 🎂​‮\u0007\nอยากให้ผู้ช่วย AI ทำก่อน: รับออเดอร์ 🍰", CAMPAIGN);
  assert.equal(parsed.business, "ร้านเค้ก 🎂");
  assert.equal(parsed.answer, "รับออเดอร์ 🍰");
  assert.doesNotMatch(parsed.rawText, /[​‮\u0007]/u);
});

test("ข้อความยาว 2,000+ ตัวอักษร (สแปม) ถูกตัดตามเพดาน ไม่หั่นอีโมจิกลางตัว", () => {
  const spam = `#AIAGENT\nธุรกิจ: ${"ก".repeat(500)}\nอยากให้ผู้ช่วย AI ทำก่อน: ${"😀".repeat(3000)}`;
  const parsed = parseBlueprintSubmission(spam, CAMPAIGN);
  assert.equal([...parsed.business].length, BUSINESS_MAX);
  assert.equal([...parsed.answer].length, ANSWER_MAX);
  assert.ok([...parsed.rawText].length <= RAW_MAX);
  assert.ok([...parsed.answer].every((ch) => ch === "😀"));
});

test("คีย์เวิร์ดต้องอยู่ต้นข้อความ ไม่สนตัวพิมพ์ ช่องว่างแทรกได้ แต่ห้ามมีตัวอักษรต่อท้าย", () => {
  const re = keywordRegex("#AIAGENT");
  for (const text of ["#AIAGENT", "  #aiagent IESA6", "#AiAgent\nธุรกิจ: x", "#AI AGENT ร้าน", "#AIAGENT,"]) assert.ok(re.test(text), text);
  for (const text of ["#AIAGENTX", "#AIAGENT2", "AIAGENT ธุรกิจ", "สนใจ #AIAGENT", "@AIAGENT", "#AIAGENTธุรกิจ"]) assert.ok(!re.test(text), text);
});

test("ข้อความที่ hook ตรวจได้ต้องผ่าน CAMPAIGN_KEYWORD เดิมก่อนเสมอ (# ติดตัวอักษร)", () => {
  assert.ok(CAMPAIGN_KEYWORD.test("#AIAGENT"));
  assert.ok(!CAMPAIGN_KEYWORD.test("# AIAGENT"), "มีช่องว่างหลัง # = ไม่ใช่คีย์เวิร์ดตั้งแต่ด่านเดิม");
});

test("ค่าตั้งแคมเปญ: ค่าตั้งต้น IESA6 ผ่าน · ช่องผิดถูกปฏิเสธ · campaignId ห้ามมี :", () => {
  const ok = validateCampaignConfig(SEED_CAMPAIGNS[0]);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.tag, "ที่มา: IESA6 · AI Agent");
  assert.equal(ok.value.maxSendsPerPerson, 2);
  assert.match(ok.value.note, /จันทร์ 12 ต\.ค\. 10:00 น\./u);
  assert.ok([...ok.value.note].length <= 300);
  for (const bad of [
    { ...SEED_CAMPAIGNS[0], campaignId: "IE:SA" },
    { ...SEED_CAMPAIGNS[0], keyword: "AIAGENT" },
    { ...SEED_CAMPAIGNS[0], sendAt: "2026-10-12 10:00" },
    { ...SEED_CAMPAIGNS[0], followupOffDays: 99 },
    { ...SEED_CAMPAIGNS[0], enabled: "yes" },
  ]) assert.equal(validateCampaignConfig(bad).ok, false, JSON.stringify(bad));
  assert.equal(thaiShortDateTime(Date.parse("2026-10-12T10:00:00+07:00")), "จันทร์ 12 ต.ค. 10:00 น.");
});

test("seed: ลงเฉพาะเครื่องลูกแพร · มีแถวแล้วไม่ทับ · พ้นช่วงแคมเปญแล้วไม่ลง", () => {
  const db = memoryDb();
  const before = Date.parse("2026-10-11T05:00:00+07:00");
  assert.deepEqual(seedCampaigns(db, { businessId: "airdog", nowMs: before }), []);
  assert.equal(readCampaigns(db).length, 0);
  assert.deepEqual(seedCampaigns(db, { businessId: "pngoung-tidkradum", nowMs: before }), ["IESA6"]);
  saveCampaign(db, { ...SEED_CAMPAIGNS[0], enabled: false });
  assert.deepEqual(seedCampaigns(db, { businessId: "pngoung-tidkradum", nowMs: before }), []);
  assert.equal(readCampaigns(db)[0].enabled, false, "ค่าที่แก้จากคอนโซลชนะ seed เสมอ");
  const late = memoryDb();
  assert.deepEqual(seedCampaigns(late, { businessId: "pngoung-tidkradum", nowMs: Date.parse("2026-10-20T00:00:00+07:00") }), []);
  db.close();
  late.close();
});

test("โหมด/เพดาน: ไม่มีแถว = off/150 · ค่าแปลก = off · แคมเปญที่ปิดไม่จับคีย์เวิร์ด", () => {
  const db = memoryDb();
  assert.equal(readSendMode(db), "off");
  db.setSetting("blueprint_send_mode", "ON ");
  assert.equal(readSendMode(db), "on");
  db.setSetting("blueprint_send_mode", "yes");
  assert.equal(readSendMode(db), "off");
  assert.equal(readDailyCapThb(db), 150);
  db.setSetting("blueprint_daily_cap_thb", "abc");
  assert.equal(readDailyCapThb(db), 150);
  db.setSetting("blueprint_campaign:BROKEN", "{not json");
  saveCampaign(db, { ...SEED_CAMPAIGNS[0], enabled: false });
  const campaigns = readCampaigns(db);
  assert.equal(campaigns.length, 1);
  assert.equal(campaignForText("#AIAGENT", campaigns), null);
  db.close();
});
