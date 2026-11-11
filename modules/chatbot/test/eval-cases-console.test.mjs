// eval-cases-console.test.mjs — "การเผยแพร่ถูกบล็อกเพราะบทสนทนาไหน" + ปุ่มปิดเกณฑ์ล้าสมัย
//
// สิ่งที่ต้องกันไว้ให้ได้:
//   - แฟล็กปิด = เส้นนี้เหมือนไม่มีอยู่ (404) ไม่ใช่ 403 ซึ่งแปลว่า "มีอยู่แต่คุณห้ามดู"
//   - ทีมงานอ่านได้ แต่ปิดเกณฑ์ไม่ได้ (เจ้าของเท่านั้น)
//   - ปิดเกณฑ์ต้องเขียนเหตุผล และต้องเปิดตั๋วให้ช่าง ไม่ใช่โน้ตที่หายไป
//   - เคส irreversible ที่ถูกปิดแล้ว **ยังบล็อกอยู่** และ assertion ต้องอ่านเป็นภาษาไทยได้
//   - ข้อความของลูกค้าอ่านสดจาก messages เสมอ — ห้องที่ถูกลบตามคำขอลืมต้องอ่านไม่ได้
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";
import { caseDetail, standingFailures, createEvalRoutes } from "../src/consoleEvalApi.mjs";
import { assertionThai } from "../src/brain/goldenAssert.mjs";

poisonGlobalFetch();

// คลังเทิร์นตรวจซ้ำปฏิเสธการเขียนเมื่อไม่มีกุญแจของ instance (sha เปล่าย้อนกลับได้)
const GOLDEN_DB = { teachHashSecret: "test-instance-secret" };

function seedCases(db) {
  db.upsertGoldenTurn({
    caseId: "probe-price-01", title: "คุณเอ๋ เจ้าของโรงงาน", turnNo: 1,
    syntheticText: "ราคาเท่าไหร่คะ",
    recordedModelOutput: JSON.stringify(["คลาสราคา 11,900 บาทค่ะ สนใจดูรอบไหมคะ"]),
    expected: [{ type: "must_have_price" }, { type: "max_questions", value: 1 }],
    severity: "lead", origin: "eval_case", scope: { product: "*" },
  });
  db.upsertGoldenTurn({
    caseId: "ledger-money-01", title: "ลูกค้าแจ้งโอนเงิน", turnNo: 1,
    syntheticText: "โอนแล้วค่ะ", expected: [{ type: "ai_off" }],
    severity: "irreversible", origin: "ledger_payment", scope: { product: "*" },
  });
}

// ctx ปลอมแบบเดียวกับที่ consoleSettingsApi ส่งให้ route (พอสำหรับเส้นที่เทสต์นี้แตะ)
function ctxFor({ operator, body = {}, csrf = true }) {
  const sent = [];
  return {
    sent,
    ctx: {
      operator, username: operator?.username ?? "someone",
      json: (_res, status, payload) => sent.push({ status, payload }),
      requireCsrf: () => csrf,
      readJson: async () => body,
    },
  };
}

const OWNER = { username: "pngoung", role: "owner" };
const STAFF = { username: "chompoo", role: "operator" };

async function call(db, { config = { teachEnabled: true }, operator, method, path, body, csrf = true, notifier = null }) {
  const routes = createEvalRoutes({ db, config, logger: { warn() {}, debug() {} }, notifier });
  const { ctx, sent } = ctxFor({ operator, body, csrf });
  const route = path.split("?")[0].split("/").filter(Boolean);
  const url = new URL(`http://x/${path}`);
  const handled = await routes.handle({ method }, {}, url, route, ctx);
  return { handled, ...(sent[0] ?? {}) };
}

test("แฟล็กปิด = 404 เหมือนไม่มีเส้นนี้อยู่จริง", async () => {
  const db = memoryDb(GOLDEN_DB);
  seedCases(db);
  const res = await call(db, {
    config: { teachEnabled: false }, operator: OWNER, method: "GET", path: "eval/failing",
  });
  assert.equal(res.status, 404);
  db.close();
});

test("รายละเอียดบทสนทนา: ลูกค้าพูดอะไร ลูกแพรตอบว่าอะไร เกณฑ์เป็นภาษาไทย", () => {
  const db = memoryDb(GOLDEN_DB);
  seedCases(db);
  const detail = caseDetail(db, "probe-price-01");
  assert.equal(detail.title, "คุณเอ๋ เจ้าของโรงงาน");
  assert.equal(detail.turns[0].customerSaid, "ราคาเท่าไหร่คะ");
  assert.match(detail.turns[0].lukpraeAnswered, /11,900/u);
  assert.deepEqual(detail.turns[0].expectations, [
    "ต้องบอกราคาที่อยู่ในตารางอนุมัติ",
    "ถามได้ไม่เกิน 1 คำถามในเทิร์นเดียว",
  ]);
  assert.equal(detail.blocksEvenWhenRetired, false);
  assert.equal(caseDetail(db, "ledger-money-01").blocksEvenWhenRetired, true,
    "เคสที่พังแล้วกู้ไม่ได้ ต้องบอกว่าปิดแล้วก็ยังบล็อก");
  db.close();
});

test("ทุกเกณฑ์ที่ระบบรู้จัก แปลเป็นภาษาไทยได้ ไม่มีข้อไหนโผล่เป็นชื่อกฎดิบ", () => {
  const types = [
    "silent", "must_not_include", "must_include_any", "must_include_all", "no_negative_opener",
    "max_bubbles", "max_questions", "ends_with_question", "no_price", "must_have_price",
    "image_sent", "ai_off", "team_notified", "needs_human",
  ];
  for (const type of types) {
    const text = assertionThai({ type, values: ["ก"], value: 1 });
    assert.doesNotMatch(text, /ยังไม่มีคำอธิบายภาษาไทย/u, `เกณฑ์ ${type} ต้องอ่านออก`);
    assert.match(text, /[฀-๿]/u, `เกณฑ์ ${type} ต้องเป็นภาษาไทย`);
  }
});

test("ทีมงานอ่านได้ แต่ปิดเกณฑ์ไม่ได้", async () => {
  const db = memoryDb(GOLDEN_DB);
  seedCases(db);
  const read = await call(db, { operator: STAFF, method: "GET", path: "eval/cases?ids=probe-price-01" });
  assert.equal(read.status, 200);
  assert.equal(read.payload.canRetire, false, "หน้าเว็บต้องไม่วาดปุ่มที่กดแล้วเด้ง 403");

  const write = await call(db, {
    operator: STAFF, method: "POST", path: "eval/cases/probe-price-01/retire",
    body: { reason: "ราคาเปลี่ยนตั้งแต่ 1 ก.ย." },
  });
  assert.equal(write.status, 403);
  assert.equal(db.getGoldenTurn("probe-price-01#1").retired_at, null);
  db.close();
});

test("เจ้าของปิดเกณฑ์ได้ ต้องเขียนเหตุผล และเปิดตั๋วให้ช่างอัตโนมัติ", async () => {
  const db = memoryDb(GOLDEN_DB);
  seedCases(db);
  const tickets = [];
  const notifier = { fireLater: (args) => tickets.push(args) };

  const short = await call(db, {
    operator: OWNER, method: "POST", path: "eval/cases/probe-price-01/retire",
    body: { reason: "เก่า" }, notifier,
  });
  assert.equal(short.status, 400, "เหตุผลสั้นเกินไปต้องไม่ผ่าน");

  const ok = await call(db, {
    operator: OWNER, method: "POST", path: "eval/cases/probe-price-01/retire",
    body: { reason: "ราคาเปลี่ยนเป็น 12,900 ตั้งแต่ 1 ก.ย. เกณฑ์เดิมจึงล้าสมัย" }, notifier,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.case.retired.by, "pngoung");

  const audits = db.listAudit ? db.listAudit(20) : db.raw.prepare("SELECT * FROM admin_audit ORDER BY rowid DESC LIMIT 5").all();
  assert.ok(audits.some((row) => row.action === "eval_case_retired"), "ต้องมีแถว audit ว่าใครปิดและเพราะอะไร");
  assert.equal(tickets.length, 1, "ต้องเปิดตั๋วให้ช่าง ไม่ใช่โน้ตที่หายไป");
  assert.match(tickets[0].reasonTextOverride, /เขียนเคสใหม่/u);

  // ปิดแล้วต้องหายจากทางอ่านของด่าน แต่ยังเปิดกลับได้
  assert.equal(db.listGoldenTurns().some((row) => row.case_id === "probe-price-01"), false);
  const back = await call(db, { operator: OWNER, method: "POST", path: "eval/cases/probe-price-01/restore" });
  assert.equal(back.status, 200);
  assert.equal(db.listGoldenTurns().some((row) => row.case_id === "probe-price-01"), true);
  db.close();
});

test("PDPA: ปิดเคสของห้องจริง ต้องไม่เขียนชื่อห้องลง audit หรือ push", async () => {
  const db = memoryDb(GOLDEN_DB);
  const id = "U-eval-privacy";
  db.upsertCustomer(id, { displayName: "ลูกค้า" });
  const messageId = db.insertMessage({ customerId: id, direction: "in", content: "โอนแล้วค่ะ" });
  db.upsertGoldenTurn({
    caseId: "real-02", title: "คุณเอ๋ ร้านเสื้อผ้า", messageRef: messageId, text: "โอนแล้วค่ะ",
    expected: [{ type: "team_notified" }], severity: "lead", origin: "staff_label",
  });
  const pushes = [];
  const res = await call(db, {
    operator: OWNER, method: "POST", path: "eval/cases/real-02/retire",
    body: { reason: "ห้องนี้ปิดการขายไปแล้ว เกณฑ์เดิมใช้ไม่ได้" },
    notifier: { fireLater: (a) => pushes.push(a) },
  });
  assert.equal(res.status, 200, res.text);
  const audit = db.raw.prepare("SELECT * FROM admin_audit WHERE action = 'eval_case_retired'").get();
  assert.doesNotMatch(String(audit.detail), /คุณเอ๋/u, "ชื่อห้องจริงห้ามลง audit (อยู่นอก cascade)");
  assert.match(String(audit.detail), /real-02/u, "ต้องอ้างด้วยรหัสเคสแทน");
  assert.doesNotMatch(String(pushes[0].reasonTextOverride), /คุณเอ๋/u, "และห้ามหลุดไปกับ LINE push");
  // ชื่อจริงยังอ่านได้บนจอ (อ่านสดจากฐาน) — นั่นคือที่ที่มันควรอยู่
  assert.equal(caseDetail(db, "real-02").title, "คุณเอ๋ ร้านเสื้อผ้า");
  db.close();
});

test("PDPA: ห้องที่ถูกลบตามคำขอลืม ต้องอ่านข้อความไม่ได้ ไม่ใช่แสดงเป็นช่องว่างเงียบ ๆ", () => {
  const db = memoryDb(GOLDEN_DB);
  const id = "U-eval-console";
  db.upsertCustomer(id, { displayName: "ลูกค้า" });
  const messageId = db.insertMessage({ customerId: id, direction: "in", content: "โอนแล้วค่ะ" });
  db.upsertGoldenTurn({
    caseId: "real-01", title: "ห้องจริง", messageRef: messageId, text: "โอนแล้วค่ะ",
    expected: [{ type: "team_notified" }], severity: "irreversible", origin: "ledger_payment",
  });
  assert.equal(caseDetail(db, "real-01").turns[0].customerSaid, "โอนแล้วค่ะ");
  assert.equal(caseDetail(db, "real-01").turns[0].fromRealRoom, true);

  db.resetCustomer(id, { forget: true });
  assert.equal(caseDetail(db, "real-01"), null, "แถวที่ชี้ห้องนั้นต้องหายไปทั้งใบตาม cascade");
  db.close();
});

test("แฟล็กด่านปิด = แผงบอกว่าปิดอยู่ ไม่ใช่บอกว่า 'ผ่านหมด'", () => {
  const db = memoryDb(GOLDEN_DB);
  seedCases(db);
  const off = standingFailures(db, { brainGates: "" });
  assert.equal(off.enabled, false);
  assert.match(off.reason, /ยังปิดอยู่/u);
  const on = standingFailures(db, { brainGates: "offline" });
  assert.equal(on.enabled, true);
  assert.match(on.reason, /ยังไม่มีรุ่นสมอง|ยังไม่มีคำตอบ|^$/u);
  db.close();
});
