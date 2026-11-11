#!/usr/bin/env node
// ฮาร์เนสจำลองแชทเป็นชุด (batch) — คุยกับ AI แอดมินของร้านด้วย "สมองจริง" หลายบทสนทนาในรอบเดียว
//
//   ของจริงทั้งหมด : โมเดล · persona · คลังความรู้ · ราคา · กติกา · โค้ดทั้งเส้น (ผ่าน webhook จริง)
//   ของปลอม 2 จุด : LINE (ดักไว้ในเครื่อง ไม่มีอะไรออกถึงลูกค้า) · ฐานข้อมูล (สำเนา ไม่แตะของจริง)
//
//   node harness.mjs <cases.json> --out <โฟลเดอร์ผล> [--only ชื่อเคส] [--max-cases 30]
//
// รันบน VPS ผ่าน `ai-admin-ctl harness` (ใช้ค่าตั้งของร้านจาก env ของบริการ) — ยิงโมเดลจริง = เสียเงินจริง
// cases.json: [{ "name": "...", "turns": ["ข้อความ 1", "ข้อความ 2"],
//                "expect": { "mustInclude": ["65"], "mustNotInclude": ["ส่วนลด"], "handoff": false } }]
import http from "node:http";
import { spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TEST_USER_PREFIX } from "./test-user.mjs";

const MAX_CASES_DEFAULT = 30;
const MAX_TURNS_PER_CASE = 12;
const FIRST_REPLY_TIMEOUT_MS = 90_000;
const QUIET_AFTER_REPLY_MS = 7_000;
const SILENT_TURN_MS = 45_000; // ไม่มีคำตอบเลยนานเท่านี้ = เงียบ (อาจส่งต่อคนแล้ว)

// ค่าตั้งของร้านที่ "เป็นสมอง" — เอามาจากบริการจริงทุกตัว ที่เหลือใช้ค่าเริ่มต้นซึ่งปิดงานเบื้องหลังอยู่แล้ว
const KEEP_ENV = /^(HERMES_|OPENAI_|BRAND_|BUSINESS_|PERSONA_|CONSOLE_BRAND_|BRAIN_|IMAGE_CATALOG_FILE$|IMAGE_DIR$|IMAGE_MAX_PER_REPLY$|IMAGE_CLASSIFY_|MODEL_PRICING_FILE$|TRANSCRIBE_MODEL$|KNOWLEDGE_VERSIONED$|SAFETY_RULES_FILE$|BANNED_WORDS_FILE$|SALES_POLICY_FILE$|TAG_FRAMEWORK_FILE$|CLASS_ROUNDS_FILE$|IDENTITY_TEMPLATE$|BRAND_PACK$|REPLY_DELIVERY_POLICY_FILE$|THB_PER_USD$|HISTORY_TURNS$|SCORE_TURNS$|SALES_DECISION_GUARD_ENABLED$|SERVICE_BOUNDARY_ENABLED$|CUSTOMER_FOLLOWUP_SUPPRESSION_ENABLED$|HASHTAG_|MEDIA_PUBLIC_BASE_URL$|CONSOLE_PUBLIC_BASE_URL$)/;

export function parseArgs(argv) {
  const out = { casesFile: "", outDir: "", only: "", maxCases: MAX_CASES_DEFAULT };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out") out.outDir = argv[++i] || "";
    else if (a === "--only") out.only = argv[++i] || "";
    else if (a === "--max-cases") out.maxCases = Number(argv[++i]) || MAX_CASES_DEFAULT;
    else if (!out.casesFile) out.casesFile = a;
  }
  return out;
}

/** ตรวจไฟล์เคสก่อนเสียเงินสักบาท — คืนรายการปัญหาภาษาไทย */
export function validateCases(cases, { maxCases = MAX_CASES_DEFAULT } = {}) {
  const problems = [];
  if (!Array.isArray(cases) || !cases.length) return ["ไฟล์เคสต้องเป็นรายการ [ ... ] อย่างน้อย 1 เคส"];
  if (cases.length > maxCases) problems.push(`มี ${cases.length} เคส เกินเพดาน ${maxCases} (กันค่าใช้จ่ายบานปลาย — แบ่งรัน หรือใส่ --max-cases)`);
  const names = new Set();
  cases.forEach((c, i) => {
    const at = `เคสที่ ${i + 1}${c?.name ? ` (${c.name})` : ""}`;
    if (!String(c?.name || "").trim()) problems.push(`${at}: ต้องมี name`);
    else if (names.has(c.name)) problems.push(`${at}: name ซ้ำ`);
    names.add(c?.name);
    if (!Array.isArray(c?.turns) || !c.turns.length) problems.push(`${at}: turns ต้องเป็นรายการข้อความลูกค้าอย่างน้อย 1 ข้อความ`);
    else if (c.turns.length > MAX_TURNS_PER_CASE) problems.push(`${at}: เกิน ${MAX_TURNS_PER_CASE} ข้อความ`);
    else if (c.turns.some((t) => typeof t !== "string" || !t.trim())) problems.push(`${at}: ทุกข้อความต้องเป็นตัวอักษร ไม่ว่าง`);
    const e = c?.expect;
    if (e !== undefined && (typeof e !== "object" || Array.isArray(e))) problems.push(`${at}: expect ต้องเป็น { ... }`);
    for (const k of ["mustInclude", "mustNotInclude"]) {
      if (e?.[k] !== undefined && (!Array.isArray(e[k]) || e[k].some((x) => typeof x !== "string"))) problems.push(`${at}: expect.${k} ต้องเป็นรายการคำ`);
    }
    if (e?.handoff !== undefined && typeof e.handoff !== "boolean") problems.push(`${at}: expect.handoff ต้องเป็น true หรือ false`);
  });
  return problems;
}

/** ตรวจผลหนึ่งเคสตามที่คาดไว้ — คำตอบทุกบับเบิลถึงลูกค้ารวมกันเป็นข้อความเดียว */
export function judgeCase(c, { replies, handoff }) {
  const text = replies.join("\n");
  const fails = [];
  for (const w of c.expect?.mustInclude || []) if (!text.includes(w)) fails.push(`ควรมีคำว่า "${w}" แต่ไม่มี`);
  for (const w of c.expect?.mustNotInclude || []) if (text.includes(w)) fails.push(`ไม่ควรมีคำว่า "${w}" แต่มี`);
  if (typeof c.expect?.handoff === "boolean" && c.expect.handoff !== handoff) {
    fails.push(c.expect.handoff ? "ควรส่งต่อให้คน แต่ AI ยังตอบเอง" : "ไม่ควรส่งต่อให้คน แต่ถูกส่งต่อ");
  }
  if (!replies.length && c.expect?.handoff !== true) fails.push("ไม่มีคำตอบถึงลูกค้าเลย");
  const checked = Boolean(c.expect && (c.expect.mustInclude?.length || c.expect.mustNotInclude?.length || typeof c.expect.handoff === "boolean"));
  return { pass: fails.length === 0, checked, fails };
}

function freePort() {
  return new Promise((done) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => done(port)); });
  });
}

function startSink(port, onMessage) {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d)).on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.method === "GET" && req.url.includes("/profile")) {
        const id = decodeURIComponent(req.url.split("/profile/")[1] || "");
        return res.end(JSON.stringify({ userId: id, displayName: "ลูกค้าจำลอง" }));
      }
      res.end("{}");
      try {
        const body = JSON.parse(raw || "{}");
        const kind = req.url.includes("/reply") ? "reply" : req.url.includes("/push") ? "push" : req.url.includes("/multicast") ? "multicast" : "other";
        for (const m of body.messages || []) onMessage({ kind, to: body.to || "", message: m, at: Date.now() });
      } catch { /* ไม่ใช่ข้อความ */ }
    });
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

function describe(m) {
  if (m.type === "text") return m.text;
  if (m.type === "image") return `[รูป] ${m.originalContentUrl || ""}`;
  if (m.type === "sticker") return "[สติกเกอร์]";
  if (m.type === "flex") return `[การ์ด] ${m.altText || ""}`;
  return `[${m.type}]`;
}

function snapshotDb(liveFile, copyFile) {
  const db = new DatabaseSync(liveFile);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.prepare("VACUUM INTO ?").run(copyFile);
  } finally { db.close(); }
}

function costSince(dbFile, sinceMs, appRoot) {
  const pricingFile = process.env.MODEL_PRICING_FILE || join(appRoot, "config", "model-pricing.json");
  let pricing = [];
  try { pricing = JSON.parse(readFileSync(pricingFile, "utf8")); } catch { /* ไม่มีราคา = รายงาน token อย่างเดียว */ }
  const price = new Map(pricing.map((m) => [m.id, m]));
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const rows = db.prepare("SELECT model, SUM(tokens_in) tin, SUM(tokens_out) tout, SUM(COALESCE(cached_in,0)) cin FROM llm_usage WHERE created_at >= ? GROUP BY model").all(sinceMs);
    let usd = 0; let tin = 0; let cin = 0; let tout = 0; let priced = true;
    for (const r of rows) {
      tin += r.tin; cin += r.cin; tout += r.tout;
      const m = price.get(r.model);
      if (!m?.in_usd_per_m) { priced = false; continue; }
      const cachedRate = m.cached_in_usd_per_m ?? m.in_usd_per_m * 0.1;
      usd += (Math.max(0, r.tin - r.cin) / 1e6) * m.in_usd_per_m + (r.cin / 1e6) * cachedRate + (r.tout / 1e6) * m.out_usd_per_m;
    }
    return { usd, tin, cin, tout, priced, cacheHitPct: tin ? Math.round((cin / tin) * 100) : 0 };
  } finally { db.close(); }
}

function readJson(url, key) {
  return fetch(url, { headers: { "x-dashboard-key": key } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

export async function runHarness({ cases, outDir, appRoot = process.cwd(), env = process.env, log = console.log }) {
  const liveDb = env.DB_FILE;
  if (!liveDb || !existsSync(liveDb)) throw new Error("ไม่พบฐานข้อมูลของร้าน (DB_FILE) — ติดตั้งระบบก่อน");
  mkdirSync(outDir, { recursive: true });
  const work = join(outDir, "data");
  mkdirSync(work, { recursive: true });
  const dbCopy = join(work, "chassis.sqlite");
  snapshotDb(liveDb, dbCopy);

  const [port, sinkPort] = [await freePort(), await freePort()];
  const secret = randomBytes(16).toString("hex");
  const dashKey = randomBytes(24).toString("hex");
  const team = `${TEST_USER_PREFIX}${"f".repeat(33 - TEST_USER_PREFIX.length)}`;
  const childEnv = {};
  for (const [k, v] of Object.entries(env)) if (KEEP_ENV.test(k)) childEnv[k] = v;
  Object.assign(childEnv, {
    PORT: String(port), BIND_HOST: "127.0.0.1", DATA_DIR: work, DB_FILE: dbCopy, CHASSIS_SKIP_ENV_FILES: "true",
    LINE_CHANNEL_SECRET: secret, LINE_MOCK_URL: `http://127.0.0.1:${sinkPort}`, LINE_LIVE_SEND: "false",
    CONSOLE_SESSION_SECRET: randomBytes(32).toString("hex"), DASHBOARD_API_KEY: dashKey, CONSOLE_COOKIE_SECURE: "false",
    SEND_DELAY_SCALE: "0", BURST_DEBOUNCE_MS: "600", BURST_MAX_WAIT_MS: "2500", FX_LIVE: "false",
    ESCALATE_NOTIFY_IDS: team,
    RETENTION_ENABLED: "false", FOLLOWUP_ENABLED: "false", STAGED_FOLLOWUP_ENABLED: "false", DIGEST_ENABLED: "false",
    NEEDS_HUMAN_SLA_ENABLED: "false", BROADCAST_ENABLED: "false", BROADCAST_SCHEDULE_ENABLED: "false",
    WEB_PUSH_ENABLED: "false", LEARNING_DIGEST_ENABLED: "false", LEARNING_MODEL_ENABLED: "false",
    JEV_SHADOW_ENABLED: "false", JEV_OWNER_LEARNING_ENABLED: "false", FB_ENABLED: "false", LINE_PILOT_MODE: "false",
    MEDIA_UPLOAD_ENABLED: "false", CANARY_INTERVAL_MS: "0",
  });

  const events = [];
  const sink = await startSink(sinkPort, (e) => events.push(e));
  const child = spawn(process.execPath, [join(appRoot, "src", "server.mjs")], { env: childEnv, cwd: appRoot, stdio: ["ignore", "ignore", "pipe"] });
  let childErr = "";
  child.stderr.on("data", (d) => { childErr = (childErr + d).slice(-4000); });
  const stop = async () => {
    child.kill("SIGTERM");
    await new Promise((done) => { child.once("exit", done); setTimeout(done, 15_000); });
    sink.close();
  };

  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) {
      try { up = (await fetch(`${base}/health`)).ok; } catch { /* ยังไม่ขึ้น */ }
      if (!up) await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error(`ระบบจำลองเปิดไม่ขึ้น: ${childErr.slice(-600)}`);

    const startedAt = Date.now();
    const results = [];
    for (const [ci, c] of cases.entries()) {
      const userId = TEST_USER_PREFIX + randomBytes(9).toString("hex").slice(0, 33 - TEST_USER_PREFIX.length);
      const transcript = [];
      log(`\n▶ เคส ${ci + 1}/${cases.length}: ${c.name}`);
      for (const text of c.turns) {
        const mark = events.length;
        const sentAt = Date.now();
        const body = JSON.stringify({
          destination: "Uharnessdestination000000000000000",
          events: [{
            type: "message", mode: "active", timestamp: sentAt,
            webhookEventId: `01HARNESS${randomBytes(10).toString("hex").toUpperCase()}`,
            deliveryContext: { isRedelivery: false }, source: { type: "user", userId },
            replyToken: randomBytes(16).toString("hex"),
            message: { id: `${sentAt}${Math.floor(Math.random() * 1e6)}`, type: "text", quoteToken: randomBytes(8).toString("hex"), text },
          }],
        });
        const sig = createHmac("sha256", secret).update(body).digest("base64");
        const res = await fetch(`${base}/webhooks/line`, { method: "POST", headers: { "content-type": "application/json", "x-line-signature": sig }, body });
        transcript.push({ who: "customer", text });
        log(`  👤 ${text}`);
        if (!res.ok) { transcript.push({ who: "system", text: `ระบบไม่รับข้อความ (HTTP ${res.status})` }); continue; }

        const deadline = sentAt + FIRST_REPLY_TIMEOUT_MS;
        let lastAt = 0;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          const fresh = events.slice(mark);
          if (fresh.length) lastAt = fresh[fresh.length - 1].at;
          if (lastAt && Date.now() - lastAt > QUIET_AFTER_REPLY_MS) break;
          if (!lastAt && Date.now() - sentAt > SILENT_TURN_MS) break;
        }
        for (const e of events.slice(mark)) {
          const toCustomer = e.kind === "reply" || e.to === userId;
          const line = { who: toCustomer ? "ai" : "internal", to: toCustomer ? "" : e.to, text: describe(e.message) };
          transcript.push(line);
          log(toCustomer ? `  🤖 ${line.text}` : `  📣 [แจ้งทีม] ${line.text}`);
        }
        if (events.length === mark) { transcript.push({ who: "system", text: "(ไม่มีคำตอบถึงลูกค้า)" }); log("  … (ไม่มีคำตอบถึงลูกค้า)"); }
      }
      const customer = (await readJson(`${base}/api/customers/${encodeURIComponent(userId)}`, dashKey))?.customer || {};
      const handoff = customer.ai_enabled === 0 || customer.ai_enabled === false || /NEEDS_HUMAN|HUMAN/.test(String(customer.state || ""));
      const replies = transcript.filter((t) => t.who === "ai").map((t) => t.text);
      const verdict = judgeCase(c, { replies, handoff });
      log(`  ${verdict.checked ? (verdict.pass ? "✅ ผ่าน" : `❌ ไม่ผ่าน: ${verdict.fails.join(" · ")}`) : "• ไม่ได้ตั้งเกณฑ์ (อ่านเอง)"}${handoff ? " · ส่งต่อให้คนแล้ว" : ""}`);
      results.push({ name: c.name, turns: c.turns, expect: c.expect || null, transcript, handoff, state: customer.state || "", ...verdict });
    }
    await new Promise((r) => setTimeout(r, 3000)); // ให้งานให้คะแนนที่ยิงแล้วลืมเขียน token ก่อนปิด
    await stop();
    const cost = costSince(dbCopy, startedAt, appRoot);
    const thb = Number(env.THB_PER_USD) || 36;
    const report = {
      ranAt: new Date(startedAt).toISOString(), cases: results.length,
      checked: results.filter((r) => r.checked).length, passed: results.filter((r) => r.checked && r.pass).length,
      failed: results.filter((r) => r.checked && !r.pass).length,
      cost: { ...cost, thb: Math.round(cost.usd * thb * 100) / 100 }, results,
    };
    writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    writeFileSync(join(outDir, "report.md"), renderMarkdown(report));
    return report;
  } catch (err) {
    await stop().catch(() => {});
    throw err;
  }
}

export function renderMarkdown(r) {
  const lines = [`# ผลจำลองแชท ${r.ranAt}`, "",
    `เคส ${r.cases} · ตั้งเกณฑ์ ${r.checked} · ผ่าน ${r.passed} · ไม่ผ่าน ${r.failed}`,
    `ค่าใช้จ่ายรอบนี้ ≈ ${r.cost.priced ? `${r.cost.thb} บาท ($${r.cost.usd.toFixed(3)})` : "(ไม่มีราคาโมเดลบางตัว)"} · token เข้า ${r.cost.tin} (cache ${r.cost.cacheHitPct}%) ออก ${r.cost.tout}`, ""];
  for (const c of r.results) {
    lines.push(`## ${c.checked ? (c.pass ? "✅" : "❌") : "•"} ${c.name}`, "");
    if (c.fails.length) lines.push(...c.fails.map((f) => `- ${f}`), "");
    for (const t of c.transcript) {
      const who = t.who === "customer" ? "👤 ลูกค้า" : t.who === "ai" ? "🤖 AI" : t.who === "internal" ? "📣 แจ้งทีม" : "⚙️";
      lines.push(`- **${who}:** ${String(t.text).replace(/\n/g, " ⏎ ")}`);
    }
    lines.push("", c.handoff ? "_ห้องนี้ถูกส่งต่อให้คนแล้ว_" : "_AI ยังดูแลห้องนี้_", "");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.casesFile || !args.outDir) {
    console.error("ใช้: node harness.mjs <cases.json> --out <โฟลเดอร์ผล> [--only ชื่อเคส] [--max-cases N]");
    process.exit(2);
  }
  let cases;
  try { cases = JSON.parse(readFileSync(args.casesFile, "utf8")); } catch (err) { console.error(`❌ อ่านไฟล์เคสไม่ได้: ${err.message}`); process.exit(2); }
  if (args.only) cases = (Array.isArray(cases) ? cases : []).filter((c) => c?.name === args.only);
  const problems = validateCases(cases, { maxCases: args.maxCases });
  if (problems.length) { for (const p of problems) console.error(`❌ ${p}`); process.exit(2); }
  const turns = cases.reduce((n, c) => n + c.turns.length, 0);
  console.log(`จำลอง ${cases.length} เคส ${turns} ข้อความ — ยิงโมเดลจริง (เสียเงินจริง ประมาณ 1–3 บาทต่อเคส) · ไม่มีอะไรส่งถึงลูกค้าจริง`);
  const report = await runHarness({ cases, outDir: resolve(args.outDir), appRoot: process.cwd() });
  console.log(`\nสรุป: ${report.cases} เคส · ผ่าน ${report.passed}/${report.checked} ที่ตั้งเกณฑ์ · ค่าใช้จ่าย ≈ ${report.cost.thb} บาท · cache ${report.cost.cacheHitPct}%`);
  console.log(`ผลเต็ม: ${join(resolve(args.outDir), "report.md")}`);
  process.exit(report.failed ? 1 : 0);
}

// เทียบแบบคลาย symlink — บน VPS เรียกผ่าน /opt/ai-admin/current (symlink) ถ้าเทียบตรง ๆ
// สคริปต์จะไม่ทำอะไรเลยแล้วจบด้วยรหัส 0 เหมือนสำเร็จ
const isMain = (() => { try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  main().catch((err) => { console.error(`❌ ${err.message}`); process.exit(1); });
}
