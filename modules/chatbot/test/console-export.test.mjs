// Export ประวัติแชทเป็น CSV (GET /console/api/export) — auth, BOM, escaping,
// scope ลูกค้า, ขอบเขตเดือนกรุงเทพ (anchor จากเวลาปัจจุบัน — ห้าม hardcode วันที่),
// canary ไม่ปน, audit row, keyset pagination ชุดใหญ่กว่า batch
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { openDb, bangkokMonthStartMs } from "../src/db.mjs";
import { csvField, bangkokMonthRangeMs } from "../src/exportCsv.mjs";
import { poisonGlobalFetch, testConfig, hermesFetchStub, lineFetchStub, httpRequest, listen } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const CONSOLE_SECRET = "test-console-secret-0123456789";
const PASSWORD = "operator-pass-123";
// scrypt ช้าโดยตั้งใจ — hash ครั้งเดียวใช้ทุกเทสต์
const PASS_HASH = hashPassword(PASSWORD);

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
const pad = (n) => String(n).padStart(2, "0");

// epoch ms -> "YYYY-MM" ตามเวลาไทย (ใช้สร้างพารามิเตอร์ month แบบ anchor จากเวลาจริง)
function bangkokMonthStr(ms) {
  const d = new Date(ms + BANGKOK_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

// server + DB ที่คุมนาฬิกาได้ — ใช้ตั้ง created_at ของ message แบบ deterministic
async function startExport(t) {
  const clock = { value: Date.now() };
  const config = testConfig({ CONSOLE_SESSION_SECRET: CONSOLE_SECRET });
  const db = openDb({ file: ":memory:", now: () => clock.value });
  db.createOperator({ username: "nok", passHash: PASS_HASH, displayName: "พี่นก", role: "owner" });
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
  return { app, db, clock };
}

async function login(server) {
  const res = await httpRequest(server, {
    method: "POST", path: "/console/api/login",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "nok", password: PASSWORD }),
  });
  assert.equal(res.status, 200, `login ต้องผ่าน: ${res.text}`);
  return { cookie: (res.headers["set-cookie"]?.[0] || "").split(";")[0] };
}

function getCsv(server, query, cookie) {
  return httpRequest(server, { path: `/console/api/export${query}`, headers: { cookie } });
}

// บรรทัดข้อมูล (ตัด BOM + header + บรรทัดว่างท้ายไฟล์) — ใช้นับแถวแบบไม่สน escaping
// หมายเหตุ: field ที่มี \n ภายใน quote จะถูก split ด้วย — เทสต์ที่ใช้ตัวนับนี้ต้องไม่มี newline ใน content
function dataLines(text) {
  return text.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean).slice(1);
}

/* --------------------------------- unit ----------------------------------- */

test("exportCsv: csvField escape ถูกต้อง + ขอบเขตเดือนกรุงเทพตรง UTC+7", () => {
  assert.equal(csvField("สวัสดีค่ะ"), "สวัสดีค่ะ");
  assert.equal(csvField('a,"b"\nc'), '"a,""b""\nc"');
  assert.equal(csvField(null), "");

  const range = bangkokMonthRangeMs("2026-08");
  assert.equal(new Date(range.sinceMs).toISOString(), "2026-07-31T17:00:00.000Z");
  assert.equal(new Date(range.untilMs).toISOString(), "2026-08-31T17:00:00.000Z");
  assert.equal(bangkokMonthRangeMs("2026-13"), null);
  assert.equal(bangkokMonthRangeMs("2026-8"), null);
  assert.equal(bangkokMonthRangeMs("abc"), null);
});

// H1: CSV formula injection — เนื้อหาที่ลูกค้าส่งมาเองแล้วขึ้นต้นด้วย = + - @ (หรือ tab/CR)
// ต้องถูกนำหน้าด้วย ' ทุกเซลล์ ไม่ให้ Excel/Sheets รันเป็นสูตร (เช่น =HYPERLINK ดูดข้อมูล)
test("exportCsv: csvField กัน formula injection — เซลล์อันตรายขึ้นต้นด้วย '", () => {
  assert.equal(csvField("+cmd"), "'+cmd");
  assert.equal(csvField("@x"), "'@x");
  assert.equal(csvField("-2+3"), "'-2+3");
  assert.equal(csvField("\t=1"), "'\t=1");
  // =HYPERLINK(...) มี comma ในตัว -> prefix ' ก่อน แล้วครอบ quote ตามปกติ (คงเริ่มด้วย ')
  const hyperlink = csvField('=HYPERLINK("http://evil","x")');
  assert.ok(hyperlink.startsWith(`"'=HYPERLINK`), hyperlink);
  // สูตรที่ไม่มี comma/quote ในตัว -> prefix ' อย่างเดียว ไม่ต้องครอบ quote
  assert.equal(csvField("=SUM(A1)"), "'=SUM(A1)");
  // ค่าปกติ (ไม่ได้ขึ้นต้นด้วยตัวอันตราย) ต้องไม่ถูกแตะ
  assert.equal(csvField("สวัสดีค่ะ"), "สวัสดีค่ะ");
  assert.equal(csvField("2+2"), "2+2");
});

/* --------------------------------- auth ----------------------------------- */

test("export: ไม่มี session -> 401 (deny by default)", async (t) => {
  const { app } = await startExport(t);
  const res = await httpRequest(app.server, { path: "/console/api/export?scope=all" });
  assert.equal(res.status, 401);
});

/* ------------------------------- all scope --------------------------------- */

test("export all: BOM + header ไทย + สองลูกค้า + escaping + โหมด/ผู้ตอบ + audit", async (t) => {
  const { app, db } = await startExport(t);
  db.upsertCustomer("U1", { displayName: "คุณเอ" });
  db.upsertCustomer("U2", { displayName: "คุณบีโปรไฟล์" });
  db.setKnownName("U2", "พี่บี"); // ชื่อจริงต้องชนะ display_name
  // ข้อความมีทั้ง comma + quote + newline — ต้องรอดใน Excel
  db.insertMessage({ customerId: "U1", direction: "in", content: 'สวัสดี, "ทดสอบ"\nบรรทัดสอง' });
  db.insertMessage({ customerId: "U1", direction: "out", content: "AI ตอบค่ะ", agentMode: "ai" });
  db.insertMessage({ customerId: "U2", direction: "out", content: "แอดมินตอบเอง", operator: "nok", agentMode: "operator_ai_off" });

  const { cookie } = await login(app.server);
  const res = await getCsv(app.server, "?scope=all", cookie);
  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/csv; charset=utf-8");
  assert.match(res.headers["content-disposition"], /^attachment; filename="airdog-chat-all-all-\d{8}\.csv"$/);

  // BOM ต้องนำหน้า (Excel ไทย) แล้วตามด้วย header ตามสเปก
  assert.ok(res.text.startsWith("\uFEFF"), "ต้องมี UTF-8 BOM นำหน้า");
  const headerLine = res.text.slice(1).split("\r\n")[0];
  // W3: คอลัมน์ "สาขา" ต่อท้าย (multi-OA) — โหมด legacy ค่าในคอลัมน์เป็น "default"
  assert.equal(headerLine, "วันที่เวลา,ลูกค้า,user_id,ทิศทาง,ผู้ตอบ,โหมด,ประเภท,ข้อความ,สาขา");

  // escaping: quote ถูก double, ทั้ง field ถูกครอบ, newline ภายในคงอยู่
  assert.ok(res.text.includes('"สวัสดี, ""ทดสอบ""\nบรรทัดสอง"'));
  // ลูกค้าครบสองคน + ชื่อจริงชนะโปรไฟล์
  assert.ok(res.text.includes("คุณเอ"));
  assert.ok(res.text.includes("พี่บี"));
  assert.ok(!res.text.includes("คุณบีโปรไฟล์"));
  // ทิศทาง + ผู้ตอบ + โหมด
  assert.ok(res.text.includes("คุณเอ,U1,ลูกค้า,,,text,")); // ขาเข้า: ผู้ตอบ/โหมดว่าง
  assert.ok(res.text.includes("คุณเอ,U1,ร้าน,AI,AI,text,AI ตอบค่ะ,default"));
  assert.ok(res.text.includes("พี่บี,U2,ร้าน,nok,แอดมิน-AIปิด,text,แอดมินตอบเอง,default"));

  // audit row ล่าสุดต้องเป็น export พร้อม scope/month
  const audit = db.listAudit()[0];
  assert.equal(audit.action, "export");
  assert.equal(audit.operator, "nok");
  assert.ok(audit.detail.includes("scope=all"));
  assert.ok(audit.detail.includes("month=all"));
  assert.ok(audit.detail.includes("rows=3"));
});

/* ----------------------------- customer scope ------------------------------ */

test("export customer: กรองเฉพาะลูกค้าคนเดียว + audit target", async (t) => {
  const { app, db } = await startExport(t);
  db.upsertCustomer("U1", { displayName: "คุณเอ" });
  db.upsertCustomer("U2", { displayName: "คุณบี" });
  db.insertMessage({ customerId: "U1", direction: "in", content: "ROW-OF-U1" });
  db.insertMessage({ customerId: "U2", direction: "in", content: "ROW-OF-U2" });

  const { cookie } = await login(app.server);
  const res = await getCsv(app.server, "?scope=customer&customerId=U1", cookie);
  assert.equal(res.status, 200);
  assert.match(res.headers["content-disposition"], /filename="airdog-chat-customer-all-\d{8}\.csv"/);
  assert.ok(res.text.includes("ROW-OF-U1"));
  assert.ok(!res.text.includes("ROW-OF-U2"));
  assert.equal(dataLines(res.text).length, 1);

  const audit = db.listAudit()[0];
  assert.equal(audit.action, "export");
  assert.equal(audit.target, "U1");
});

/* ------------------------------ month filter ------------------------------- */

test("export month: ขอบเขตเดือนตามเที่ยงคืนกรุงเทพ (anchor จากเวลาปัจจุบัน)", async (t) => {
  const { app, db, clock } = await startExport(t);
  db.upsertCustomer("U1", { displayName: "คุณเอ" });

  // anchor รอบเส้นแบ่งเดือนปัจจุบัน: 1 นาทีหลังเที่ยงคืนวันที่ 1 อยู่เดือนนี้ / 1 นาทีก่อน = เดือนก่อน
  const monthStart = bangkokMonthStartMs(Date.now());
  const curMonth = bangkokMonthStr(monthStart);
  const prevMonth = bangkokMonthStr(monthStart - 1);
  assert.notEqual(curMonth, prevMonth);

  clock.value = monthStart + 60_000;
  db.insertMessage({ customerId: "U1", direction: "in", content: "IN-MONTH-ROW" });
  clock.value = monthStart - 60_000;
  db.insertMessage({ customerId: "U1", direction: "in", content: "PREV-MONTH-ROW" });
  clock.value = Date.now();

  const { cookie } = await login(app.server);

  const cur = await getCsv(app.server, `?scope=all&month=${curMonth}`, cookie);
  assert.equal(cur.status, 200);
  assert.match(cur.headers["content-disposition"], new RegExp(`filename="airdog-chat-all-${curMonth}-\\d{8}\\.csv"`));
  assert.ok(cur.text.includes("IN-MONTH-ROW"));
  assert.ok(!cur.text.includes("PREV-MONTH-ROW"));

  const prev = await getCsv(app.server, `?scope=all&month=${prevMonth}`, cookie);
  assert.equal(prev.status, 200);
  assert.ok(prev.text.includes("PREV-MONTH-ROW"));
  assert.ok(!prev.text.includes("IN-MONTH-ROW"));

  const audit = db.listAudit()[0];
  assert.ok(audit.detail.includes(`month=${prevMonth}`));
});

/* --------------------------------- canary ---------------------------------- */

test("export: ลูกค้า canary ไม่ปนในไฟล์", async (t) => {
  const { app, db } = await startExport(t);
  db.upsertCustomer("U1", { displayName: "คุณเอ" });
  db.upsertCustomer("canary:probe", {});
  db.insertMessage({ customerId: "U1", direction: "in", content: "REAL-ROW" });
  db.insertMessage({ customerId: "canary:probe", direction: "in", content: "CANARY-ROW" });

  const { cookie } = await login(app.server);
  const res = await getCsv(app.server, "?scope=all", cookie);
  assert.ok(res.text.includes("REAL-ROW"));
  assert.ok(!res.text.includes("CANARY-ROW"));
  assert.equal(dataLines(res.text).length, 1);
});

/* ------------------------------- validation -------------------------------- */

test("export: พารามิเตอร์ผิด -> 400/404 ไม่มีไฟล์หลุด", async (t) => {
  const { app } = await startExport(t);
  const { cookie } = await login(app.server);
  assert.equal((await getCsv(app.server, "?scope=weird", cookie)).status, 400);
  assert.equal((await getCsv(app.server, "?scope=customer", cookie)).status, 400);
  assert.equal((await getCsv(app.server, "?scope=customer&customerId=ghost", cookie)).status, 404);
  assert.equal((await getCsv(app.server, "?scope=all&month=2026-13", cookie)).status, 400);
  assert.equal((await getCsv(app.server, "?scope=all&month=abc", cookie)).status, 400);
});

/* ------------------------------- pagination -------------------------------- */

test("export: ชุดใหญ่กว่า batch (500) — keyset pagination เก็บครบทุกแถว", async (t) => {
  const { app, db } = await startExport(t);
  db.upsertCustomer("U1", { displayName: "คุณเอ" });
  const TOTAL = 1203; // เกิน 2 batch + เศษ และ created_at ซ้ำกันหมด — บังคับใช้ tie-break rowid
  for (let i = 0; i < TOTAL; i += 1) {
    db.insertMessage({ customerId: "U1", direction: "in", content: `ROW-${i}` });
  }

  const { cookie } = await login(app.server);
  const res = await getCsv(app.server, "?scope=customer&customerId=U1", cookie);
  assert.equal(res.status, 200);
  const lines = dataLines(res.text);
  assert.equal(lines.length, TOTAL);
  assert.ok(lines[0].includes("ROW-0"));
  assert.ok(lines[TOTAL - 1].includes(`ROW-${TOTAL - 1}`));
});
