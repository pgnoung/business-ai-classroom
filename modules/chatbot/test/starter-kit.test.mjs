// เทสต์ของชุดติดตั้ง (starter/): ตัวช่วยบนเครื่องนักเรียน + สคริปต์ฝั่งเซิร์ฟเวอร์
// ไม่แตะ VPS/LINE/OpenAI จริง — ส่วน "ลองแชท" ใช้ AI จำลองบน 127.0.0.1
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPack } from "../starter/lib/pack.mjs";
import { isHostname, isIPv4, sslipHost } from "../starter/lib/ssh.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "starter", "cli.mjs");

test("ที่อยู่ VPS และชื่อโดเมน", () => {
  assert.equal(isIPv4("203.0.113.5"), true);
  assert.equal(isIPv4("203.0.113.256"), false);
  assert.equal(isIPv4("example.com"), false);
  assert.equal(sslipHost("203.0.113.5"), "203-0-113-5.sslip.io");
  assert.equal(isHostname("admin.shop.co.th"), true);
  assert.equal(isHostname("bad host"), false);
});

test("ข้อมูลร้านตัวอย่างผ่านการตรวจ", () => {
  const r = checkPack(join(ROOT, "business-example"));
  assert.equal(r.ok, true, r.problems.join("\n"));
  assert.ok(r.summary.products >= 3);
});

test("ข้อมูลร้านที่ผิดถูกจับได้พร้อมบอกจุด", () => {
  const dir = mkdtempSync(join(tmpdir(), "pack-"));
  try {
    writeFileSync(join(dir, "business.json"), JSON.stringify({ businessId: "Bad Id", businessName: "ร้าน", agentName: "", ownerName: "x", agentGender: "robot" }));
    writeFileSync(join(dir, "products.json"), JSON.stringify([
      { id: "a", name: "ก", price: -5 },
      { id: "a", name: "ข", price: 10, image: "images/missing.jpg" },
    ]));
    const r = checkPack(dir);
    assert.equal(r.ok, false);
    const text = r.problems.join("\n");
    for (const want of ["businessId", "agentName", "agentGender", "price", "id ซ้ำ", "ไม่พบรูป"]) assert.match(text, new RegExp(want));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("คำสั่งที่ต้องพิมพ์ค่าลับ ปฏิเสธเมื่อไม่ได้รันในหน้าต่างของผู้ใช้", () => {
  for (const cmd of ["secrets", "owner", "key-upload"]) {
    const r = spawnSync(process.execPath, [CLI, cmd], { input: "", encoding: "utf8" });
    assert.equal(r.status, 3, `${cmd}: ${r.stderr}`);
    assert.match(r.stderr, /พิมพ์เองในหน้าต่าง Terminal/);
  }
});

test("help ใช้ได้ และคำสั่งที่ไม่รู้จักออกด้วยรหัส 2", () => {
  assert.equal(spawnSync(process.execPath, [CLI, "help"]).status, 0);
  assert.equal(spawnSync(process.execPath, [CLI, "nope"]).status, 2);
});

test("สคริปต์ฝั่งเซิร์ฟเวอร์ไวยากรณ์ถูกต้อง", () => {
  for (const f of ["bootstrap.sh", "ai-admin-ctl.sh"]) {
    const r = spawnSync("bash", ["-n", join(ROOT, "starter", "remote", f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
  for (const f of ["try-chat.mjs", "line-setup.mjs", "set-owner.mjs", "harness.mjs", "purge-test-chats.mjs"]) {
    const r = spawnSync(process.execPath, ["--check", join(ROOT, "starter", "remote", f)], { encoding: "utf8" });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

function freePort() {
  return new Promise((resolve) => {
    const s = http.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

test("ลองแชท: ข้อความลูกค้าเข้าระบบจริง แล้ว AI ตอบผ่าน LINE จำลอง", { timeout: 90_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "starter-e2e-"));
  const ai = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.endsWith("/models")) return res.end('{"data":[]}');
      const model = JSON.parse(body || "{}").model;
      res.end(JSON.stringify({ id: "t", model, choices: [{ index: 0, message: { role: "assistant", content: "สวัสดีค่ะ ยินดีต้อนรับค่ะ" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    });
  });
  await new Promise((r) => ai.listen(0, "127.0.0.1", r));
  const [port, sinkPort] = [await freePort(), await freePort()];
  const env = {
    ...process.env,
    PORT: String(port), BIND_HOST: "127.0.0.1", DATA_DIR: work, DB_FILE: join(work, "chassis.sqlite"),
    BUSINESS_PROFILE: "generic", CHASSIS_SKIP_ENV_FILES: "true",
    HERMES_BASE: `http://127.0.0.1:${ai.address().port}/v1`, HERMES_API_KEY: "test", HERMES_MODEL: "gpt-6.1-sol", HERMES_SCORER_MODEL: "gpt-6-luna",
    LINE_CHANNEL_SECRET: "0123456789abcdef0123456789abcdef", LINE_LIVE_SEND: "false", LINE_MOCK_URL: `http://127.0.0.1:${sinkPort}`,
    CONSOLE_SESSION_SECRET: "x".repeat(64), DASHBOARD_API_KEY: "k".repeat(48), SEND_DELAY_SCALE: "0", BURST_DEBOUNCE_MS: "300", BURST_MAX_WAIT_MS: "1500",
  };
  const server = spawn(process.execPath, [join(ROOT, "src", "server.mjs")], { env, cwd: ROOT, stdio: "ignore" });
  try {
    for (let i = 0; i < 50; i += 1) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* ยังไม่ขึ้น */ }
      await new Promise((r) => setTimeout(r, 200));
    }
    const out = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(ROOT, "starter", "remote", "try-chat.mjs"), "--new", "สวัสดีค่ะ"], { env, cwd: ROOT });
      let text = "";
      child.stdout.on("data", (d) => (text += d));
      child.stderr.on("data", (d) => (text += d));
      child.on("close", (code) => resolve({ code, text }));
    });
    assert.equal(out.code, 0, out.text);
    assert.match(out.text, /🤖 AI: สวัสดีค่ะ/);
  } finally {
    server.kill();
    ai.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("ฮาร์เนส: ตรวจไฟล์เคสก่อนเสียเงิน และตัดสินผ่าน/ไม่ผ่านถูก", async () => {
  const { validateCases, judgeCase } = await import("../starter/remote/harness.mjs");
  assert.match(validateCases([]).join(), /อย่างน้อย 1 เคส/);
  const bad = validateCases([{ name: "a", turns: [] }, { name: "a", turns: ["x"], expect: { handoff: "yes" } }]).join("\n");
  assert.match(bad, /turns/); assert.match(bad, /name ซ้ำ/); assert.match(bad, /handoff/);
  assert.equal(validateCases(Array.from({ length: 31 }, (_, i) => ({ name: `c${i}`, turns: ["x"] }))).length, 1);
  const c = { name: "p", turns: ["x"], expect: { mustInclude: ["65"], mustNotInclude: ["ส่วนลด"], handoff: false } };
  assert.equal(judgeCase(c, { replies: ["65 บาทค่ะ"], handoff: false }).pass, true);
  const f = judgeCase(c, { replies: ["มีส่วนลดค่ะ"], handoff: true });
  assert.equal(f.pass, false); assert.equal(f.fails.length, 3);
  assert.equal(judgeCase({ name: "n", turns: ["x"] }, { replies: ["hi"], handoff: false }).checked, false);
});

test("ฮาร์เนส: จำลองเป็นชุดบนสำเนาฐานข้อมูล ไม่แตะฐานจริง และได้รายงาน", { timeout: 120_000 }, async () => {
  const work = mkdtempSync(join(tmpdir(), "harness-e2e-"));
  const ai = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d)).on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url.endsWith("/models")) return res.end('{"data":[]}');
      res.end(JSON.stringify({ id: "t", model: JSON.parse(body || "{}").model, choices: [{ index: 0, message: { role: "assistant", content: "ลาเต้ร้อนหอมกรุ่นค่ะ" }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10 } }));
    });
  });
  await new Promise((r) => ai.listen(0, "127.0.0.1", r));
  try {
    const { openDb } = await import("../src/db.mjs");
    const liveFile = join(work, "live.sqlite");
    const live = openDb({ file: liveFile });
    live.close?.();
    const { statSync } = await import("node:fs");
    const before = statSync(liveFile).mtimeMs;
    const { runHarness } = await import("../starter/remote/harness.mjs");
    const report = await runHarness({
      cases: [{ name: "ลาเต้", turns: ["มีลาเต้ไหม"], expect: { mustInclude: ["ลาเต้"] } }, { name: "ควรตก", turns: ["มีเค้กไหม"], expect: { mustInclude: ["เค้ก"] } }],
      outDir: join(work, "out"), appRoot: ROOT, log: () => {},
      env: { DB_FILE: liveFile, BUSINESS_PROFILE: "generic", HERMES_BASE: `http://127.0.0.1:${ai.address().port}/v1`, HERMES_API_KEY: "t", HERMES_MODEL: "gpt-6.1-sol", HERMES_SCORER_MODEL: "gpt-6-luna" },
    });
    assert.equal(report.cases, 2);
    assert.equal(report.passed, 1);
    assert.equal(report.failed, 1);
    assert.match(report.results[0].transcript.map((t) => t.text).join(" "), /ลาเต้ร้อนหอมกรุ่น/);
    assert.equal(statSync(liveFile).mtimeMs, before, "ฐานข้อมูลจริงต้องไม่ถูกแตะ");
    const { existsSync } = await import("node:fs");
    assert.ok(existsSync(join(work, "out", "report.md")));
  } finally {
    ai.close();
    rmSync(work, { recursive: true, force: true });
  }
});

test("สกัดแชท: ปิดข้อมูลส่วนตัวแต่เก็บราคาไว้", async () => {
  const { redactText, run } = await import("../starter/line-export/redact.mjs");
  assert.equal(redactText("โทร 081-234-5678 นะคะ"), "โทร [เบอร์โทร] นะคะ");
  assert.equal(redactText("somchai@example.com"), "[อีเมล]");
  assert.equal(redactText("บ้านเลขที่ 99/9 ถ.ทดสอบ 10110"), "[ที่อยู่ลูกค้า]");
  assert.equal(redactText("โอนเข้า 123-4-56789-0"), "โอนเข้า [เลขบัญชี]");
  assert.equal(redactText("คลาส 12,900 บาท หรือ 12900"), "คลาส 12,900 บาท หรือ 12900");
  const dir = mkdtempSync(join(tmpdir(), "redact-"));
  try {
    const raw = join(dir, "raw"); mkdirSync(raw);
    writeFileSync(join(raw, "U00000000000000000000000000000a01.json"), JSON.stringify({ chatId: "U00000000000000000000000000000a01", messages: [{ from: "customer", type: "text", text: "ขอเบอร์ร้านหน่อย ฉันชื่อ 0812345678" }, { from: "shop", type: "text", text: "ได้ค่ะ" }] }));
    const r = run({ rawDir: raw, outDir: join(dir, "clean") });
    assert.equal(r.rooms, 1);
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(join(dir, "clean", "conversations.md"), "utf8");
    assert.doesNotMatch(text, /0812345678|U0000/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("สกัดแชท: ตัวรับในเครื่องต้องมีรหัสรอบ และรับเฉพาะจาก chat.line.biz", async () => {
  const { createSink } = await import("../starter/line-export/sink.mjs");
  const dir = mkdtempSync(join(tmpdir(), "sink-"));
  const sink = createSink({ dir, token: "t".repeat(32), log: () => {} });
  const { port } = await sink.listen(0);
  try {
    const url = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${url}/done`)).status, 401);
    assert.equal((await fetch(`${url}/done`, { headers: { "x-sink-token": "t".repeat(32), origin: "https://evil.example" } })).status, 403);
    const bad = await fetch(`${url}/chat`, { method: "POST", headers: { "x-sink-token": "t".repeat(32) }, body: JSON.stringify({ chatId: "../../etc", messages: [] }) });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${url}/chat`, { method: "POST", headers: { "x-sink-token": "t".repeat(32), origin: "https://chat.line.biz" }, body: JSON.stringify({ chatId: "U00000000000000000000000000000a01", messages: [] }) });
    assert.equal(ok.status, 200);
  } finally { await sink.close(); rmSync(dir, { recursive: true, force: true }); }
});
