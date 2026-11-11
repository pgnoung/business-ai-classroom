// blueprint-replay-harness.mjs — ตัวเล่นซ้ำข้อความขาเข้าชุดตัวแทน ผ่าน webhook ที่ลงลายเซ็นจริง แล้วถ่าย "ทุกอย่างที่ระบบทำ"
// (คำขอถึง LINE ทั้งก้อน · คำขอถึงโมเดลแบบ sha256 ของทั้งก้อน · ผลเทิร์น · ทุกตารางในฐานแบบ normalize)
//
// ใช้สองที่: (1) สคริปต์บันทึกค่าอ้างอิงที่รันบนซอร์สของคอมมิต f0ac79dc (ก่อนมีแคมเปญ #AIAGENT)
//            (2) test/blueprint-zero-impact.test.mjs ที่รันบนซอร์สปัจจุบันแล้วเทียบกับค่าอ้างอิง
// ฟังก์ชันของระบบถูกฉีดเข้ามา (deps) เพื่อให้ตัวเล่นตัวเดียวกันวิ่งได้กับซอร์สทั้งสองรุ่น
// ไฟล์นี้ไม่มีเทสต์ของตัวเอง (node --test โหลดแล้วจบเฉย ๆ)
import { createHash } from "node:crypto";

export const REPLAY_BASE_MS = Date.parse("2026-10-11T14:00:00.000+07:00");
export const REPLAY_SECRET = "test-line-secret";
export const CAMPAIGN_CUSTOMER = "U-replay-13";
export const CAMPAIGN_TEXT = "#AIAGENT IESA6\nธุรกิจ: ร้านกาแฟสองสาขา\nอยากให้ผู้ช่วย AI ทำก่อน: ตอบแชทลูกค้าเรื่องเมนู\n(ขอรับไอเดียการวางระบบ AI Agent ภายใน 24 ชม.)";

// ข้อความตัวแทนของทุกเส้นที่ต้องไม่เปลี่ยน — แต่ละรายการคนละห้อง (ยกเว้นที่ตั้งใจให้ห้องเดียวกัน)
export const PHASE1_STEPS = Object.freeze([
  { id: "r01", customerId: "U-replay-01", text: "สวัสดีค่ะ สนใจคลาส AI Agent ค่ะ" },
  { id: "r02", customerId: "U-replay-02", text: "เรียนออนไลน์ได้ไหมคะ" },
  { id: "r03", customerId: "U-replay-03", text: "#online" }, // คีย์เวิร์ดธุรกิจที่ตั้งไว้ (เส้น seeded)
  { id: "r04", customerId: "U-replay-04", text: "#horeca" }, // # ที่ไม่รู้จัก = เงียบให้ auto-response ของ OA
  { id: "r05", customerId: "U-replay-05", text: "@class" }, // @ ที่ไม่รู้จัก = คุยปกติ
  { id: "r06", customerId: "U-replay-06", text: "#AIAGENTX สวัสดีค่ะ" },
  { id: "r07", customerId: "U-replay-07", text: "AIAGENT ธุรกิจ: ร้านอาหาร" },
  { id: "r08", customerId: "U-replay-08", text: "ไม่ต้องส่งข้อความมาแล้วค่ะ" },
  { id: "r09", customerId: "U-replay-09", text: "ขอคุยกับเจ้าหน้าที่หน่อยค่ะ" },
  { id: "r10", customerId: "U-replay-10", text: "ขอคิดดูก่อนนะครับ" },
  { id: "r11", customerId: "U-replay-11", text: "โอนเงินแล้วค่ะ" },
  { id: "r12", customerId: "U-replay-12", text: "สนใจ #AIAGENT ค่ะ" },
  { id: "fb1", customerId: "facebook:replay-psid", text: CAMPAIGN_TEXT, via: "facebook" },
]);
export const CAMPAIGN_STEP = Object.freeze({ id: "r13", customerId: CAMPAIGN_CUSTOMER, text: CAMPAIGN_TEXT });
export const PHASE3_STEPS = Object.freeze([
  { id: "r14", customerId: "U-replay-14", text: "สวัสดีค่ะ" },
  { id: "r15", customerId: "U-replay-15", text: "#horeca" },
  { id: "r16", customerId: CAMPAIGN_CUSTOMER, text: "สวัสดีค่ะ ขอสอบถามคลาสถัดไปค่ะ" },
]);

const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const EPOCH_MS_RE = /\b1[6-9]\d{11}\b/gu;
const ISO_RE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z\b/gu;

// นาฬิกาปลอม: เริ่มที่ REPLAY_BASE_MS เดินทีละ 1 ms ต่อการอ่าน (นาทีไม่เปลี่ยนตลอดการเล่น → ข้อความวันเวลาในพรอมต์ตรงกันทุกรอบ)
function installClock(base) {
  const RealDate = globalThis.Date;
  let tick = 0;
  const nowFn = () => base + (tick++);
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(nowFn());
      else super(...args);
    }
    static now() { return nowFn(); }
  }
  globalThis.Date = FakeDate;
  return () => { globalThis.Date = RealDate; };
}

function installRandom(seed) {
  const real = Math.random;
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let x = state;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  return () => { Math.random = real; };
}

export function normalizeValue(value) {
  if (typeof value === "number") return value >= 1.6e12 && value < 2e12 ? "<ts>" : value;
  if (typeof value === "bigint") return normalizeValue(Number(value));
  if (value instanceof Uint8Array) return `<blob:${createHash("sha256").update(value).digest("hex").slice(0, 16)}>`;
  if (typeof value !== "string") return value;
  return value.replace(UUID_RE, "<uuid>").replace(ISO_RE, "<iso>").replace(EPOCH_MS_RE, "<ts>");
}

function normalizeDeep(value) {
  if (Array.isArray(value)) return value.map(normalizeDeep);
  if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalizeDeep(value[key])]));
  }
  return normalizeValue(value);
}

export function snapshotTables(db) {
  const tables = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const out = {};
  for (const { name } of tables) {
    let rows;
    try {
      rows = db.raw.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    } catch {
      rows = db.raw.prepare(`SELECT * FROM "${name}"`).all();
    }
    out[name] = rows.map((row) => normalizeDeep({ ...row }));
  }
  return out;
}

function hashBody(body) {
  return createHash("sha256").update(JSON.stringify(normalizeDeep(body))).digest("hex");
}

async function quiesce(app, line, hermes, sleepReal) {
  let stable = 0;
  let last = "";
  for (let i = 0; i < 400 && stable < 4; i += 1) {
    try { await app.pipeline.idle?.(); } catch { /* ไม่มี idle = รอด้วยการนับอย่างเดียว */ }
    await sleepReal(15);
    const mark = `${line.calls.length}:${hermes.calls.length}`;
    stable = mark === last ? stable + 1 : 0;
    last = mark;
  }
}

/**
 * @param deps ฟังก์ชันของซอร์สรุ่นที่จะเล่น: { createApp, memoryDb, testConfig, lineFetchStub, hermesFetchStub, signLine, httpRequest, listen }
 * @param options.beforeApp(db) ตั้งค่าในฐานก่อนบูต (เช่น ใส่ค่าตั้งแคมเปญ)
 * @param options.overrides ส่งต่อให้ createApp
 */
export async function runReplay(deps, { beforeApp = null, overrides = {} } = {}) {
  const { createApp, memoryDb, testConfig, lineFetchStub, hermesFetchStub, signLine, httpRequest, listen } = deps;
  const realSetTimeout = globalThis.setTimeout;
  const sleepReal = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
  const restoreClock = installClock(REPLAY_BASE_MS);
  const restoreRandom = installRandom(20261011);
  const db = memoryDb();
  let app = null;
  try {
    db.setSetting("hashtag_business_keywords", JSON.stringify({ "#online": "สนใจคลาสออนไลน์ค่ะ" }));
    if (beforeApp) beforeApp(db);
    const line = lineFetchStub();
    const hermes = hermesFetchStub("ยินดีดูแลค่ะ สนใจคลาสไหนเป็นพิเศษไหมคะ");
    app = createApp({
      config: testConfig(), db,
      overrides: { lineFetch: line, hermesFetch: hermes, sleep: async () => {}, processId: "replay", ...overrides },
      logger: silent,
    });
    await listen(app.server);
    await quiesce(app, line, hermes, sleepReal);
    const turn = (id) => db.raw.prepare("SELECT status, reason FROM inbound_turn_outcomes WHERE message_id = ?").get(`in:${id}`);

    async function play(step) {
      const lineBefore = line.calls.length;
      const hermesBefore = hermes.calls.length;
      let verdict = null;
      if (step.via === "facebook") {
        if (!db.getCustomer(step.customerId)) db.upsertCustomer(step.customerId, { channelId: "facebook" });
        verdict = normalizeDeep(await app.pipeline.handleInboundText({ customerId: step.customerId, text: step.text }));
      } else {
        const raw = JSON.stringify({ events: [{
          type: "message", webhookEventId: `w-${step.id}`, replyToken: `rt-${step.id}`, timestamp: REPLAY_BASE_MS,
          source: { type: "user", userId: step.customerId }, message: { id: step.id, type: "text", text: step.text, quoteToken: `qt-${step.id}` },
        }] });
        const res = await httpRequest(app.server, {
          method: "POST", path: "/webhooks/line",
          headers: { "content-type": "application/json", "x-line-signature": signLine(raw, REPLAY_SECRET) }, body: raw,
        });
        if (res.status !== 200) throw new Error(`webhook ${step.id} -> ${res.status}`);
        for (let i = 0; i < 400; i += 1) {
          const row = turn(step.id);
          if (row && row.status !== "owed" && row.status !== "sending") break;
          await sleepReal(10);
        }
      }
      await quiesce(app, line, hermes, sleepReal);
      return {
        id: step.id,
        outcome: step.via === "facebook" ? null : normalizeDeep({ ...(turn(step.id) || {}) }),
        verdict,
        line: line.calls.slice(lineBefore).map((call) => normalizeDeep({ path: new URL(call.url).pathname, body: call.body })),
        hermes: hermes.calls.slice(hermesBefore).map((call) => ({ path: new URL(call.url).pathname, model: call.body?.model ?? null, sha256: hashBody(call.body) })),
      };
    }

    const steps = [];
    for (const step of PHASE1_STEPS) steps.push(await play(step));
    const tablesBeforeCampaign = snapshotTables(db);
    steps.push(await play(CAMPAIGN_STEP));
    for (const step of PHASE3_STEPS) steps.push(await play(step));
    const tablesAfter = snapshotTables(db);
    return { steps, tablesBeforeCampaign, tablesAfter };
  } finally {
    try { app?.learning?.stop?.(); } catch { /* ปิดของเทสต์ */ }
    try { app?.server?.close?.(); } catch { /* ปิดของเทสต์ */ }
    restoreRandom();
    restoreClock();
    // รอคิวที่ค้างให้จบก่อนปิดฐาน (ตัวให้คะแนนวิ่งหลังตอบ)
    await sleepReal(30);
    try { db.close(); } catch { /* ปิดแล้ว */ }
  }
}
