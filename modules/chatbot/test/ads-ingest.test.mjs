// ปลายทางรับค่าแอดต้องปลอดภัยและไม่ยอมรับตัวเลขมั่ว (คำสั่งพี่ง้วง 1 ก.ย. 2026)
//
// เส้นนี้อยู่นอก session คอนโซล (Make ยิงเข้ามาเอง) จึงเป็นประตูที่เปิดสู่อินเทอร์เน็ต
// ถ้าหลุด คนนอกเขียนค่าแอดได้ = ตัวเลขกำไรของบริษัทถูกปลอมได้
import test from "node:test";
import assert from "node:assert/strict";
import {
  keyMatches, parseAdsPayload, createAdsIngest, yesterdayBangkok, ADS_KEY_SETTING,
} from "../src/adsIngest.mjs";

test("เทียบกุญแจ: ตรงเท่านั้นถึงผ่าน และค่าว่างต้องไม่ผ่านเด็ดขาด", () => {
  assert.equal(keyMatches("abc123", "abc123"), true);
  assert.equal(keyMatches("abc123", "abc124"), false);
  assert.equal(keyMatches("", ""), false, "กุญแจว่างเทียบกับว่างต้องไม่ผ่าน ไม่งั้นระบบที่ยังไม่ตั้งค่าจะเปิดโล่ง");
  assert.equal(keyMatches(null, "abc"), false);
  assert.equal(keyMatches("abc", null), false);
  assert.equal(keyMatches("abcd", "abc"), false, "ความยาวต่างกันต้องไม่โยน error");
});

test("payload ที่ดีต้องผ่าน และอ่านชื่อฟิลด์ได้ทั้งสองแบบ", () => {
  const a = parseAdsPayload({ day: "2026-08-31", spend: 3210.5, accountId: "act_1" });
  assert.equal(a.ok, true);
  assert.deepEqual(a.value, { day: "2026-08-31", spendThb: 3210.5, accountId: "act_1", source: "make" });
  const b = parseAdsPayload({ day: "2026-08-31", spend_thb: "1200", account_id: "act_2", source: "manual" });
  assert.equal(b.value.spendThb, 1200);
  assert.equal(b.value.accountId, "act_2");
  assert.equal(b.value.source, "manual");
});

test("ปัดข้อมูลที่จะทำให้ ROAS เพี้ยนตั้งแต่ประตู", () => {
  assert.match(parseAdsPayload({ day: "31/08/2026", spend: 1 }).error, /YYYY-MM-DD/u);
  assert.match(parseAdsPayload({ day: "2026-08-31" }).error, /ต้องส่ง spend/u);
  assert.match(parseAdsPayload({ day: "2026-08-31", spend: "ไม่ใช่ตัวเลข" }).error, /ตัวเลข/u);
  assert.match(parseAdsPayload({ day: "2026-08-31", spend: -5 }).error, /ติดลบ/u);
  assert.match(parseAdsPayload({ day: "2026-08-31", spend: 99_000_000 }).error, /สูงผิดปกติ/u,
    "พิมพ์ผิดหลักเดียวทำให้กำไรทั้งเดือนเพี้ยน ต้องกันที่ประตู");
});

/* ---- ทดสอบ handler จริง ---- */
function makeWorld({ key = "secret-key-123" } = {}) {
  const settings = new Map(key ? [[ADS_KEY_SETTING, key]] : []);
  const rows = new Map();
  const audits = [];
  const db = {
    getSetting: (k) => settings.get(k) ?? "",
    upsertAdsSpend: (r) => { rows.set(r.day, { day: r.day, spend_thb: r.spendThb }); return rows.get(r.day); },
    addAudit: (a) => audits.push(a),
  };
  const sent = [];
  const json = (_res, status, body) => sent.push({ status, body });
  const ingest = createAdsIngest({ db, json, readJson: async (req) => req.body, logger: { warn() {}, log() {} } });
  return { ingest, sent, rows, audits, settings };
}
const post = (body, headers = {}) => ({ method: "POST", headers, body });

test("ยิงถูกกุญแจ = บันทึกและลง audit", async () => {
  const w = makeWorld();
  await w.ingest.handle(post({ day: "2026-08-31", spend: 3210 }, { "x-ads-key": "secret-key-123" }), {});
  assert.equal(w.sent[0].status, 200);
  assert.equal(w.rows.get("2026-08-31").spend_thb, 3210);
  assert.equal(w.audits[0].action, "ads_spend_ingest");
});

test("กุญแจผิด = 401 และห้ามเขียนอะไรลงฐานข้อมูล", async () => {
  const w = makeWorld();
  await w.ingest.handle(post({ day: "2026-08-31", spend: 999999 }, { "x-ads-key": "wrong" }), {});
  assert.equal(w.sent[0].status, 401);
  assert.equal(w.rows.size, 0, "คนนอกต้องเขียนตัวเลขกำไรของบริษัทไม่ได้");
});

test("ไม่ส่งกุญแจมาเลย = 401", async () => {
  const w = makeWorld();
  await w.ingest.handle(post({ day: "2026-08-31", spend: 1 }, {}), {});
  assert.equal(w.sent[0].status, 401);
});

test("ยังไม่ได้ตั้งกุญแจ = ปิดสนิท ไม่ใช่เปิดรับทุกคน (fail-closed)", async () => {
  const w = makeWorld({ key: "" });
  await w.ingest.handle(post({ day: "2026-08-31", spend: 1 }, { "x-ads-key": "" }), {});
  assert.equal(w.sent[0].status, 503);
  assert.equal(w.rows.size, 0);
});

test("ยิงซ้ำวันเดิม = ทับ ไม่ใช่บวกเพิ่ม (กัน Make retry แล้วยอดบาน)", async () => {
  const w = makeWorld();
  const h = { "x-ads-key": "secret-key-123" };
  await w.ingest.handle(post({ day: "2026-08-31", spend: 3000 }, h), {});
  await w.ingest.handle(post({ day: "2026-08-31", spend: 3210 }, h), {});
  assert.equal(w.rows.get("2026-08-31").spend_thb, 3210, "ต้องเป็นยอดล่าสุด ไม่ใช่ 6,210");
});

test("GET ไม่รองรับ", async () => {
  const w = makeWorld();
  await w.ingest.handle({ method: "GET", headers: {} }, {});
  assert.equal(w.sent[0].status, 405);
});

/* ---- ไม่ส่งวันมา = เมื่อวานตามเวลาไทย (แก้ 1 ก.ย. 2026) ----
 * สูตร formatDate ใน Make ต้องใส่เครื่องหมายคำพูดซ้อนกันในบอดี้ JSON ซึ่งพังเงียบ ๆ
 * ย้ายมาคิดฝั่งเซิร์ฟเวอร์แทน ตรงกับที่ Make ตั้งไว้อยู่แล้ว (รัน 05:00 ดึงยอดของเมื่อวาน)
 */
test("ไม่ส่ง day มา = ใช้เมื่อวานตามเวลาไทย", () => {
  // 1 ก.ย. 2026 05:00 เวลาไทย -> เมื่อวานคือ 31 ส.ค.
  const at0500 = Date.UTC(2026, 7, 31, 22, 0, 0);
  assert.equal(yesterdayBangkok(at0500), "2026-08-31");
  const r = parseAdsPayload({ spend: 3210 }, at0500);
  assert.equal(r.ok, true);
  assert.equal(r.value.day, "2026-08-31");
});

test("ข้ามเที่ยงคืนไทยแล้วยังนับวันถูก (ไม่ใช้เวลา UTC)", () => {
  // 1 ก.ย. 2026 00:30 เวลาไทย = 31 ส.ค. 17:30 UTC -> เมื่อวานต้องเป็น 31 ส.ค. ไม่ใช่ 30
  assert.equal(yesterdayBangkok(Date.UTC(2026, 7, 31, 17, 30, 0)), "2026-08-31");
});

test("ส่ง day มาผิดรูป ต้องบอกด้วยว่าได้รับอะไรมา จะได้ไล่ปัญหาได้", () => {
  const r = parseAdsPayload({ day: "2026-08-31T17:00:00.000Z", spend: 1 });
  assert.equal(r.ok, false);
  assert.match(r.error, /2026-08-31T17/u, "ของเดิมบอกแค่ว่าผิดรูป ไม่บอกว่าได้อะไรมา");
});
