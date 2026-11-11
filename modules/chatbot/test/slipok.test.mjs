// slipok.test.mjs — W2: SlipOK provider จริงของระบบตรวจสลิป (fail-closed ทุกทาง)
// ครอบ: provider resolution, happy valid, สลิปซ้ำ (HTTP 400 + JSON success:false = suspect),
// HTTP พังจริง = error, amount cross-check "ยอดตรง/ยอดไม่ตรง (คาด X ได้ Y)", off = ไม่มี call
// (webhook provider เดิมถูกพิสูจน์โดย test/slip-check.test.mjs ทั้งไฟล์ — ห้ามแตะ)
import test from "node:test";
import assert from "node:assert/strict";
import {
  createSlipChecker, resolveSlipProvider, findRecentQuotedTotal, summarizeSlipResult,
} from "../src/slipCheck.mjs";
import { poisonGlobalFetch, testConfig, memoryDb } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const SLIPOK_ENV = { SLIP_PROVIDER: "slipok", SLIPOK_API_KEY: "sk-slipok", SLIPOK_BRANCH_ID: "BR123" };

// stub fetch: ขา download รูป (LINE mock) + ขา SlipOK
function slipokFetchStub({ slipokRes } = {}) {
  const downloads = [];
  const slipokCalls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/v2/bot/message/")) {
      downloads.push({ url: u, opts });
      return {
        ok: true, status: 200,
        headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "image/jpeg" : null) },
        arrayBuffer: async () => Buffer.from("fake-slip-image"),
      };
    }
    slipokCalls.push({ url: u, headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : null });
    return slipokRes(u, opts);
  };
  fn.downloads = downloads;
  fn.slipokCalls = slipokCalls;
  return fn;
}

function makeChecker({ slipokRes, configOverrides = {} } = {}) {
  const config = testConfig({ ...SLIPOK_ENV, ...configOverrides });
  const db = memoryDb();
  const fetchImpl = slipokFetchStub({ slipokRes });
  const checker = createSlipChecker({ config, db, fetchImpl, logger: silent });
  return { config, db, fetchImpl, checker };
}

/* ---------------------------- provider resolution ---------------------------- */

test("resolveSlipProvider: fail-closed ทุกทาง + อนุมาน legacy จาก SLIP_CHECK_URL", () => {
  const cfg = (o) => testConfig(o);
  assert.equal(resolveSlipProvider(cfg({})), "off", "ไม่ตั้งอะไรเลย = off");
  assert.equal(resolveSlipProvider(cfg({ SLIP_CHECK_URL: "http://x" })), "webhook", "legacy: มี URL = webhook");
  assert.equal(resolveSlipProvider(cfg({ SLIP_PROVIDER: "off", SLIP_CHECK_URL: "http://x" })), "off", "off ชนะทุกอย่าง");
  assert.equal(resolveSlipProvider(cfg(SLIPOK_ENV)), "slipok");
  assert.equal(resolveSlipProvider(cfg({ SLIP_PROVIDER: "slipok", SLIPOK_API_KEY: "k" })), "off", "ไม่มี branch id = off");
  assert.equal(resolveSlipProvider(cfg({ SLIP_PROVIDER: "slipok", SLIPOK_BRANCH_ID: "b" })), "off", "ไม่มี api key = off");
  assert.equal(resolveSlipProvider(cfg({ SLIP_PROVIDER: "webhook" })), "off", "webhook แต่ไม่มี URL = off");
});

test("provider off: enabled=false และ checkImage ไม่ยิง network ใด ๆ", async () => {
  const { checker, fetchImpl } = makeChecker({
    configOverrides: { SLIP_PROVIDER: "", SLIPOK_API_KEY: "", SLIPOK_BRANCH_ID: "" },
  });
  assert.equal(checker.enabled, false);
  const result = await checker.checkImage({ customerId: "U1", messageId: "m1" });
  assert.deepEqual(result, { skipped: "disabled" });
  assert.equal(fetchImpl.downloads.length, 0);
  assert.equal(fetchImpl.slipokCalls.length, 0);
});

/* --------------------------------- happy path -------------------------------- */

test("slipok valid: URL/branch/header/body ถูกต้อง + บันทึก valid + summary ✅ ลง handoff", async () => {
  const { checker, db, fetchImpl } = makeChecker({
    slipokRes: () => ({
      ok: true, status: 200,
      json: async () => ({
        success: true,
        data: {
          transRef: "TR-2026-001", amount: 3990,
          sender: { displayName: "คุณลูกค้า เอ" }, receiver: { displayName: "บริษัท แอร์ด็อก" },
          transDate: "2026-08-10", transTime: "14:22:00",
        },
      }),
    }),
  });
  db.upsertCustomer("U-ok", {});
  const result = await checker.checkImage({ customerId: "U-ok", messageId: "msg-1", accessToken: "branch-token" });
  assert.equal(result.status, "valid");

  // request ไป SlipOK ถูก spec: path มี branch id, header x-authorization, body {data, log:true}
  const call = fetchImpl.slipokCalls[0];
  assert.ok(call.url.includes("api.slipok.com/api/line/apikey/BR123"), call.url);
  assert.equal(call.headers["x-authorization"], "sk-slipok");
  assert.equal(call.body.log, true);
  assert.equal(call.body.data, Buffer.from("fake-slip-image").toString("base64"));
  // W3: download รูปใช้ token ของสาขาที่ส่งเข้ามา
  assert.equal(fetchImpl.downloads[0].opts.headers.authorization, "Bearer branch-token");

  const rows = db.listSlipChecksFor("U-ok", 5);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "valid");
  assert.equal(rows[0].amount, 3990);
  assert.equal(rows[0].trans_ref, "TR-2026-001");
  const payload = JSON.parse(rows[0].payload_json);
  assert.equal(payload.sender, "คุณลูกค้า เอ");
  assert.equal(payload.timestamp, "2026-08-10 14:22:00");

  const customer = db.getCustomer("U-ok");
  assert.ok(customer.handoff_summary.includes("✅ ยอด 3,990 ตรง"));
  assert.equal(customer.state, "NEEDS_HUMAN", "ผลตรวจเป็นตัวช่วยแอดมิน — คนยังต้องยืนยันเสมอ");
});

test("slipok สลิปซ้ำ: HTTP 400 + JSON success:false = suspect พร้อมเหตุผลจาก message", async () => {
  const { checker, db } = makeChecker({
    slipokRes: () => ({
      ok: false, status: 400,
      json: async () => ({ success: false, code: 1012, message: "สลิปซ้ำ" }),
    }),
  });
  db.upsertCustomer("U-dup", {});
  const result = await checker.checkImage({ customerId: "U-dup", messageId: "msg-2" });
  assert.equal(result.status, "suspect");
  const row = db.listSlipChecksFor("U-dup", 5)[0];
  assert.equal(row.status, "suspect");
  assert.equal(JSON.parse(row.payload_json).reason, "สลิปซ้ำ");
  assert.equal(JSON.parse(row.payload_json).code, 1012);
  assert.ok(db.getCustomer("U-dup").handoff_summary.includes("⚠️ สลิปน่าสงสัย: สลิปซ้ำ"));
});

test("slipok HTTP พังจริง (5xx ไม่มี JSON) = error — ให้คนตรวจ ไม่เดาผล", async () => {
  const { checker, db } = makeChecker({
    slipokRes: () => ({ ok: false, status: 502, json: async () => { throw new Error("no body"); } }),
  });
  db.upsertCustomer("U-err", {});
  const result = await checker.checkImage({ customerId: "U-err", messageId: "msg-3" });
  assert.equal(result.status, "error");
  assert.equal(result.reason, "check_http_502");
  assert.equal(db.listSlipChecksFor("U-err", 5)[0].status, "error");
  assert.ok(db.getCustomer("U-err").handoff_summary.includes("สลิปตรวจอัตโนมัติไม่ได้"));
});

/* ------------------------------ amount cross-check ---------------------------- */

test("findRecentQuotedTotal: จับยอด approved ล่าสุดใน outbound 24 ชม. (ตัวเลขมี comma ก็เจอ)", () => {
  const db = memoryDb();
  db.upsertCustomer("U-q", {});
  db.setApprovedPrice("เครื่องฟอก X5", 3990);
  db.setApprovedPrice("เครื่องฟอก X7", 7990);
  db.insertMessage({ customerId: "U-q", direction: "out", content: "รุ่น X7 ราคา 7,990 บาทค่ะ" });
  db.insertMessage({ customerId: "U-q", direction: "out", content: "ถ้ารุ่น X5 อยู่ที่ 3,990 บาท สนใจรุ่นไหนดีคะ" });
  db.insertMessage({ customerId: "U-q", direction: "in", content: "เอา X5 ค่ะ เลขห้อง 555" });
  assert.equal(findRecentQuotedTotal({ db, customerId: "U-q" }), 3990, "เอา outbound ล่าสุดที่มียอด approved");
  assert.equal(findRecentQuotedTotal({ db, customerId: "U-none" }), null, "ไม่มีข้อความ = null");
  db.close();
});

test("findRecentQuotedTotal: ยอดที่แจ้งเกิน 24 ชม. = หมดอายุ ไม่เอามาเทียบ (best effort)", async () => {
  const { openDb } = await import("../src/db.mjs");
  const clock = { value: Date.now() };
  const db = openDb({ file: ":memory:", now: () => clock.value });
  db.upsertCustomer("U-old", {});
  db.setApprovedPrice("เครื่องฟอกอากาศ X5", 3990);
  clock.value -= 30 * 3_600_000; // ย้อนไป 30 ชม. แล้วค่อยแจ้งยอด
  db.insertMessage({ customerId: "U-old", direction: "out", content: "รุ่น X5 ราคา 3,990 บาทค่ะ" });
  clock.value += 30 * 3_600_000;
  assert.equal(findRecentQuotedTotal({ db, customerId: "U-old", nowMs: clock.value }), null);
  db.close();
});

test("summarizeSlipResult: suspect ที่รู้ทั้งยอดสลิปและยอดที่แจ้ง = ต่อท้ายผลเทียบยอดด้วย", () => {
  assert.equal(
    summarizeSlipResult("suspect", { reason: "สลิปซ้ำ", amount: 3500, expectedAmount: 3990 }),
    "⚠️ สลิปน่าสงสัย: สลิปซ้ำ · ยอดไม่ตรง (คาด 3,990 ได้ 3,500)"
  );
  // ไม่รู้ยอดใดยอดหนึ่ง = ข้อความเดิม (backward compatible)
  assert.equal(summarizeSlipResult("suspect", { reason: "สลิปซ้ำ" }), "⚠️ สลิปน่าสงสัย: สลิปซ้ำ");
});

test("amount mismatch: summary ต้องมี 'ยอดไม่ตรง (คาด X ได้ Y)' / ตรงกัน = 'ยอดตรง'", async () => {
  const { checker, db } = makeChecker({
    slipokRes: () => ({
      ok: true, status: 200,
      json: async () => ({ success: true, data: { transRef: "TR-9", amount: 3500 } }),
    }),
  });
  db.upsertCustomer("U-mis", {});
  db.setApprovedPrice("เครื่องฟอก X5", 3990);
  db.insertMessage({ customerId: "U-mis", direction: "out", content: "สรุปยอดรุ่น X5 ทั้งหมด 3,990 บาทนะคะ" });

  const result = await checker.checkImage({ customerId: "U-mis", messageId: "msg-4" });
  assert.equal(result.status, "valid");
  assert.equal(result.data.expectedAmount, 3990);
  const summary = db.getCustomer("U-mis").handoff_summary;
  assert.ok(summary.includes("ยอดไม่ตรง (คาด 3,990 ได้ 3,500)"), summary);

  // เคสยอดตรง — summarize ต้องบอก "ยอดตรง"
  assert.ok(
    summarizeSlipResult("valid", { amount: 3990, expectedAmount: 3990 }).includes("ยอดตรง")
  );
  // ไม่รู้ expected = ข้อความเดิมทุกตัวอักษร (backward compatible)
  assert.equal(summarizeSlipResult("valid", { amount: 38500 }), "สลิปตรวจแล้ว: ✅ ยอด 38,500 ตรง");
});
