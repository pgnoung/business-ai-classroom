#!/usr/bin/env node
// AI Admin Starter — ตัวช่วยบนเครื่องนักเรียน: ติดตั้งและดูแลระบบบน VPS ผ่าน SSH
// ทุกคำสั่งพิมพ์ผลเป็นภาษาไทย และไม่พิมพ์ค่าลับออกจอ
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createTerminalIO } from "./lib/ui.mjs";
import { checkPack } from "./lib/pack.mjs";
import {
  DEFAULT_KEY, ROOT, isHostname, isIPv4, loadState, saveState, scp, scpFrom, ssh, sslipHost, which,
} from "./lib/ssh.mjs";

const RELEASE_PATHS = ["src", "public", "config", "tools", "package.json"];
const say = (t = "") => process.stdout.write(`${t}\n`);
class CliError extends Error { constructor(message, code = 1) { super(message); this.code = code; } }
// โยน error แทน process.exit เพื่อให้ finally ลบไฟล์ชั่วคราว (ซึ่งอาจมีข้อมูลร้าน) ทุกครั้ง
const fail = (t, code = 1) => { throw new CliError(t, code); };
const CTL = "/usr/local/sbin/ai-admin-ctl";

function needState() {
  const s = loadState();
  if (!s.ip) fail("ยังไม่ได้บอกที่อยู่ VPS — รัน: connect <IP ของ VPS>");
  return s;
}

function needTty(what) {
  if (!process.stdin.isTTY) {
    fail(`${what} ต้องพิมพ์เองในหน้าต่าง Terminal ของคุณ (ค่าลับห้ามพิมพ์ในแชทกับ AI)\n` +
      `   เปิด Terminal ที่โฟลเดอร์นี้แล้วพิมพ์:  ${launcherHint()} ${process.argv[2]}`, 3);
  }
}

function launcherHint() {
  return process.platform === "win32" ? "powershell -ExecutionPolicy Bypass -File ai-admin.ps1" : "bash ai-admin.sh";
}

async function ctl(state, args, opts = {}) {
  const r = await ssh(state, `${CTL} ${args}`, opts);
  return r;
}

/* ---------------------------------- คำสั่ง --------------------------------- */

async function cmdCheck() {
  let bad = 0;
  const line = (ok, text) => { say(`${ok ? "✅" : "❌"} ${text}`); if (!ok) bad += 1; };
  const major = Number(process.versions.node.split(".")[0]);
  line(major >= 22, `Node.js ${process.versions.node}${major >= 22 ? "" : " (ต้อง 22 ขึ้นไป)"}`);
  line(which("ssh"), "ssh (มากับเครื่อง)");
  line(which("scp"), "scp (มากับเครื่อง)");
  line(which("tar"), "tar (มากับเครื่อง)");
  line(existsSync(DEFAULT_KEY), `กุญแจ SSH ของชุดนี้ (${DEFAULT_KEY})${existsSync(DEFAULT_KEY) ? "" : " — สร้างด้วยคำสั่ง keygen"}`);
  const s = loadState();
  say(s.ip ? `ℹ️  VPS: ${s.user || "root"}@${s.ip} · เว็บ https://${s.host}` : "ℹ️  ยังไม่ได้บอกที่อยู่ VPS (คำสั่ง connect)");
  process.exit(bad ? 1 : 0);
}

function cmdKeygen() {
  if (existsSync(DEFAULT_KEY)) return say(`✅ มีกุญแจอยู่แล้ว: ${DEFAULT_KEY}`);
  mkdirSync(join(DEFAULT_KEY, ".."), { recursive: true });
  const r = spawnSync("ssh-keygen", ["-t", "ed25519", "-f", DEFAULT_KEY, "-N", "", "-C", "ai-admin-starter"], { stdio: "inherit" });
  if (r.status !== 0) fail("สร้างกุญแจไม่สำเร็จ");
  say(`✅ สร้างกุญแจแล้ว: ${DEFAULT_KEY} (ไฟล์ .pub คือส่วนที่ส่งให้ VPS ได้ ส่วนอีกไฟล์ห้ามให้ใคร)`);
}

async function cmdConnect(args) {
  const ip = args[0];
  if (!isIPv4(ip)) fail("ใส่ IP ของ VPS แบบตัวเลข เช่น connect 203.0.113.5");
  const userIdx = args.indexOf("--user");
  const domainIdx = args.indexOf("--domain");
  const user = userIdx >= 0 ? String(args[userIdx + 1] || "") : "root";
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) fail("ชื่อผู้ใช้ VPS ไม่ถูกต้อง (ปกติคือ root)");
  const domain = domainIdx >= 0 ? String(args[domainIdx + 1] || "").toLowerCase() : "";
  if (domain && !isHostname(domain)) fail("ชื่อโดเมนไม่ถูกต้อง เช่น shop.example.com");
  const prev = loadState();
  const state = saveState({ ...prev, ip, user, host: domain || prev.host && prev.ip === ip && prev.host || sslipHost(ip), keyPath: DEFAULT_KEY });
  say(`ℹ️  VPS ${user}@${ip} · เว็บจะอยู่ที่ https://${state.host}`);
  const r = await ssh(state, "echo ok && (. /etc/os-release; echo $PRETTY_NAME)", { inherit: false });
  if (r.code === 0) {
    say(`✅ เข้า VPS ด้วยกุญแจได้แล้ว (${r.out.split("\n")[1] || "Linux"})`);
    if (user !== "root") say("⚠️  ผู้ใช้ไม่ใช่ root — ตัวติดตั้งต้องใช้ root (หรือ sudo แบบไม่ถามรหัส)");
    return;
  }
  const why = sshProblem(r.err, ip);
  if (why) fail(why);
  say("🔑 ยังเข้าด้วยกุญแจไม่ได้ — ต้องส่งกุญแจไปไว้ที่ VPS หนึ่งครั้ง (ใช้รหัส root ที่ได้ตอนเช่า VPS)");
  say(`   ให้เจ้าของเครื่องพิมพ์เองใน Terminal:  ${launcherHint()} key-upload`);
  process.exitCode = 4;
}

/** แปลข้อความ error ของ ssh เป็นภาษาคน — คืน null เมื่อสาเหตุคือยังไม่ได้ส่งกุญแจ */
function sshProblem(err, ip) {
  const e = String(err || "");
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(e)) {
    return `VPS ที่ ${ip} เปลี่ยนเครื่องไปแล้ว (เช่น ติดตั้งใหม่) — รัน  ssh-keygen -R ${ip}  แล้ว connect ใหม่`;
  }
  if (/timed out|Operation timed out/i.test(e)) return `ติดต่อ ${ip} ไม่ได้ (หมดเวลา) — เช็ก IP, รอเครื่องพร้อม 2–3 นาที, หรือเปิดพอร์ต 22 ในไฟร์วอลล์ของผู้ให้บริการ`;
  if (/Connection refused/i.test(e)) return `${ip} ปฏิเสธการเชื่อมต่อ — เครื่องอาจยังบูตไม่เสร็จ หรือ SSH ไม่ได้เปิดที่พอร์ต 22`;
  if (/Could not resolve|No route to host|Network is unreachable/i.test(e)) return `ไปไม่ถึง ${ip} — เช็กอินเทอร์เน็ตและ IP อีกครั้ง`;
  if (/Permission denied/i.test(e)) return null;
  return e.trim() ? null : null;
}

async function cmdKeyUpload() {
  needTty("การส่งกุญแจ (ต้องพิมพ์รหัส root ของ VPS)");
  const state = needState();
  if (!existsSync(`${DEFAULT_KEY}.pub`)) cmdKeygen();
  const pub = readFileSync(`${DEFAULT_KEY}.pub`, "utf8").trim();
  say("พิมพ์รหัสผ่าน root ของ VPS เมื่อถูกถาม (พิมพ์แล้วจะไม่ขึ้นบนจอ เป็นเรื่องปกติ)");
  // ปิดการใช้กุญแจรอบนี้ เพื่อให้ ssh ถามรหัส root บนหน้าจอของเจ้าของเครื่องเอง · กุญแจส่งทาง stdin (ไม่ฝังในคำสั่ง)
  const add = spawnSync("ssh", ["-o", "StrictHostKeyChecking=accept-new", "-o", "PubkeyAuthentication=no",
    "-o", "PreferredAuthentications=password,keyboard-interactive",
    `${state.user || "root"}@${state.ip}`,
    "umask 077; mkdir -p ~/.ssh; touch ~/.ssh/authorized_keys; k=$(cat); grep -qxF \"$k\" ~/.ssh/authorized_keys || { [ -s ~/.ssh/authorized_keys ] && [ -n \"$(tail -c1 ~/.ssh/authorized_keys)\" ] && echo >> ~/.ssh/authorized_keys; printf '%s\\n' \"$k\" >> ~/.ssh/authorized_keys; }"],
  { input: `${pub}\n`, stdio: ["pipe", "inherit", "inherit"] });
  if (add.status !== 0) fail("ส่งกุญแจไม่สำเร็จ — เช็ก IP และรหัส root แล้วลองใหม่");
  const test = await ssh(state, "echo ok", { inherit: false });
  if (test.code !== 0) fail("ยังเข้าด้วยกุญแจไม่ได้ — ลองอีกครั้ง หรือดู references/vps.md");
  say("✅ ส่งกุญแจแล้ว ต่อไปนี้ไม่ต้องใช้รหัส root อีก — กลับไปบอก AI ว่า \"ส่งกุญแจแล้ว\" ได้เลย");
}

function buildRelease() {
  const stage = mkdtempSync(join(tmpdir(), "ai-admin-rel-"));
  const app = join(stage, "app");
  mkdirSync(app);
  for (const p of RELEASE_PATHS) {
    const from = join(ROOT, p);
    if (!existsSync(from)) fail(`ไฟล์โปรแกรมไม่ครบ (ไม่พบ ${p}) — ดาวน์โหลดชุดใหม่`);
    cpSync(from, join(app, p), { recursive: true });
  }
  cpSync(join(ROOT, "starter", "remote"), join(app, "starter-remote"), { recursive: true });
  const tarball = join(stage, "release.tgz");
  const r = spawnSync("tar", ["-czf", tarball, "-C", app, "."], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (r.status !== 0) fail("แพ็กไฟล์ไม่สำเร็จ");
  return { stage, tarball };
}

async function cmdDeploy() {
  const state = needState();
  const ping = await ssh(state, "id -u", { inherit: false });
  if (ping.code !== 0) fail("เข้า VPS ด้วยกุญแจไม่ได้ — รัน connect อีกครั้ง");
  if (ping.out.trim() !== "0") fail("ต้องเข้า VPS ด้วย root");
  say(`📦 แพ็กโปรแกรม…`);
  const { stage, tarball } = buildRelease();
  try {
    say("⬆️  อัปโหลดไป VPS…");
    if (await scp(state, tarball, "/root/ai-admin-release.tgz")) fail("อัปโหลดไม่สำเร็จ");
    if (await scp(state, join(ROOT, "starter", "remote", "bootstrap.sh"), "/root/ai-admin-bootstrap.sh")) fail("อัปโหลดไม่สำเร็จ");
    say("🛠️  ติดตั้งบน VPS (ครั้งแรกราว 2–4 นาที)…");
    const r = await ssh(state, `bash /root/ai-admin-bootstrap.sh /root/ai-admin-release.tgz ${state.host} && rm -f /root/ai-admin-release.tgz`);
    if (r.code !== 0) fail("ติดตั้งไม่สำเร็จ — ดูข้อความด้านบน แล้วบอก AI ให้ช่วยอ่าน");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  saveState({ ...state, deployedAt: new Date().toISOString() });
  await checkHttps(state);
}

async function checkHttps(state) {
  const url = `https://${state.host}/health`;
  for (let i = 0; i < 20; i += 1) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        say(`✅ เปิดจากอินเทอร์เน็ตได้แล้ว: https://${state.host}/console`);
        return true;
      }
    } catch { /* ใบรับรองอาจยังออกไม่เสร็จ */ }
    await new Promise((r) => setTimeout(r, 6000));
  }
  say(`⚠️  ยังเปิด https://${state.host} จากข้างนอกไม่ได้ — ใบรับรองอาจกำลังออก (รอ 1–2 นาทีแล้วรัน status) หรือผู้ให้บริการ VPS ปิดพอร์ต 80/443 ไว้`);
  return false;
}

async function cmdSecrets() {
  needTty("การใส่คีย์และโทเคน");
  const state = needState();
  const io = createTerminalIO();
  say("🔐 ใส่ค่าลับทีละตัว — พิมพ์/วางแล้วจะไม่ขึ้นบนจอ · กด Enter เฉย ๆ = ข้ามตัวนั้น (ใช้ค่าเดิม)");
  const lines = [];
  const openai = await io.secret("openai", "OpenAI API key (ขึ้นต้น sk-)");
  if (openai) {
    if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(openai)) fail("รูปแบบ OpenAI key ไม่ถูก (ต้องขึ้นต้น sk-)");
    lines.push(`OPENAI_API_KEY=${openai}`);
  }
  const secret = await io.secret("line_secret", "LINE Channel secret (32 ตัวอักษร จากแท็บ Basic settings)");
  if (secret) {
    if (!/^[0-9a-f]{32}$/i.test(secret)) fail("Channel secret ต้องเป็นตัวอักษร 0-9 a-f ยาว 32 ตัว");
    lines.push(`LINE_CHANNEL_SECRET=${secret}`);
  }
  const token = await io.secret("line_token", "LINE Channel access token (long-lived จากแท็บ Messaging API)");
  if (token) {
    if (token.length < 100 || /\s/.test(token)) fail("Channel access token สั้นหรือมีช่องว่าง — คัดลอกใหม่ทั้งหมด");
    lines.push(`LINE_CHANNEL_ACCESS_TOKEN=${token}`);
  }
  if (!lines.length) return say("ไม่ได้เปลี่ยนอะไรค่ะ");
  const r = await ctl(state, "set-env", { input: `${lines.join("\n")}\n` });
  if (r.code !== 0) fail("บันทึกไม่สำเร็จ");
  await ctl(state, "restart");
  if (openai) {
    const check = await ctl(state, "check-openai", { inherit: false });
    const code = check.out.trim().split("\n").pop();
    say(code === "200" ? "✅ OpenAI key ใช้ได้"
      : code === "401" ? "❌ OpenAI ไม่รับคีย์นี้ (401) — สร้างคีย์ใหม่แล้วรัน secrets อีกครั้ง"
        : `⚠️  OpenAI ตอบ ${code || "?"} — คีย์อาจผิด หรือบัญชียังไม่ได้เติมเครดิต`);
  }
  say("✅ เรียบร้อย กลับไปบอก AI ว่า \"ใส่คีย์แล้ว\" ได้เลย");
}

async function cmdOwner() {
  needTty("การตั้งรหัสเข้าหน้า console");
  const state = needState();
  const io = createTerminalIO();
  const user = (await io.ask("user", "ชื่อผู้ใช้สำหรับเข้าหน้า console (อังกฤษ/ตัวเลข)", { defaultValue: "owner" })).trim();
  if (!/^[a-zA-Z0-9._-]{3,32}$/.test(user)) fail("ชื่อผู้ใช้ใช้ได้เฉพาะอังกฤษ ตัวเลข . _ - ยาว 3–32 ตัว");
  const pass = await io.secret("pass", "รหัสผ่าน (อย่างน้อย 10 ตัว)");
  const again = await io.secret("pass2", "พิมพ์รหัสผ่านอีกครั้ง");
  if (pass.length < 10) fail("รหัสผ่านสั้นเกินไป");
  if (pass !== again) fail("รหัสผ่านสองครั้งไม่ตรงกัน");
  const r = await ctl(state, "set-owner", { input: `${user}\n${pass}\n` });
  if (r.code !== 0) fail("ตั้งรหัสไม่สำเร็จ");
  say(`✅ เข้าได้ที่ https://${state.host}/console ด้วยชื่อ ${user}`);
}

async function cmdImport(args) {
  const state = needState();
  const apply = args.includes("--apply");
  const dir = resolve(ROOT, args.find((a) => !a.startsWith("--")) || "business");
  const check = checkPack(dir);
  for (const w of check.warnings) say(`⚠️  ${w}`);
  if (!check.ok) {
    for (const p of check.problems) say(`❌ ${p}`);
    fail("ข้อมูลร้านยังไม่ครบ — แก้ตามรายการด้านบนก่อน");
  }
  const s = check.summary;
  say(`📋 ข้อมูลร้าน: สินค้า ${s.products} · คำถามที่พบบ่อย ${s.faq} · บันทึกความรู้ ${s.notes} · รูป ${s.images}`);
  const stage = mkdtempSync(join(tmpdir(), "ai-admin-pack-"));
  const tarball = join(stage, "pack.tgz");
  try {
    const t = spawnSync("tar", ["-czf", tarball, "-C", dir, "."], { stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" } });
    if (t.status !== 0) fail("แพ็กข้อมูลร้านไม่สำเร็จ");
    if (await scp(state, tarball, "/root/ai-admin-pack.tgz")) fail("อัปโหลดไม่สำเร็จ");
    const r = await ctl(state, `import /root/ai-admin-pack.tgz ${apply ? "--apply" : ""}`);
    await ssh(state, "rm -f /root/ai-admin-pack.tgz", { inherit: false });
    if (r.code !== 0) fail("นำเข้าไม่สำเร็จ — ดูข้อความด้านบน");
    if (!apply) say("ℹ️  นี่คือแผน (ยังไม่ได้เขียนอะไร) — ถ้าถูกต้องให้รัน import --apply");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function cmdHarness(args) {
  const state = needState();
  const file = args.find((a) => !a.startsWith("--"));
  if (!file || !existsSync(resolve(ROOT, file))) fail("ระบุไฟล์เคส เช่น harness harness-cases.json (ดูตัวอย่างใน harness-cases.example.json)");
  const onlyIdx = args.indexOf("--only");
  const only = onlyIdx >= 0 ? String(args[onlyIdx + 1] || "") : "";
  if (await scp(state, resolve(ROOT, file), "/root/ai-admin-cases.json")) fail("อัปโหลดไฟล์เคสไม่สำเร็จ");
  say("🧪 จำลองแชทบน VPS (ใช้สมองจริง เสียค่า AI จริงเล็กน้อย · ไม่มีอะไรส่งถึงลูกค้า)…");
  const quote = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
  const r = await ssh(state, `${CTL} harness /root/ai-admin-cases.json ${only ? `--only ${quote(only)}` : ""}; rc=$?; rm -f /root/ai-admin-cases.json; exit $rc`, { inherit: false });
  process.stdout.write(r.out);
  if (r.err.trim()) process.stderr.write(r.err);
  const out = (r.out.match(/HARNESS_OUT=(\S+)/) || [])[1];
  if (!out) fail("ไม่ได้ผลจำลอง — ดูข้อความด้านบน");
  const localDir = join(ROOT, "harness-reports", out.split("/").pop());
  mkdirSync(localDir, { recursive: true });
  for (const f of ["report.md", "report.json"]) {
    if (await scpFrom(state, `${out}/${f}`, join(localDir, f))) fail(`ดาวน์โหลด ${f} ไม่สำเร็จ`);
  }
  say(`📄 ผลอยู่ที่ ${join(localDir, "report.md")}`);
  if (r.code) process.exitCode = 1;
}

async function cmdBackup() {
  const state = needState();
  const r = await ctl(state, "backup", { inherit: false });
  if (r.code !== 0) fail(`สำรองไม่สำเร็จ ${r.err}`);
  const remote = r.out.trim().split("\n").pop();
  const localDir = join(ROOT, "backups");
  mkdirSync(localDir, { recursive: true });
  const local = join(localDir, remote.split("/").pop());
  if (await scpFrom(state, remote, local)) fail("ดาวน์โหลดไฟล์สำรองไม่สำเร็จ");
  say(`✅ สำรองไว้ที่ ${local} (มีข้อมูลลูกค้า — เก็บไว้ในเครื่องเท่านั้น ห้ามแชร์)`);
}

async function cmdUpdate() {
  if (existsSync(join(ROOT, ".git"))) {
    const r = spawnSync("git", ["-C", ROOT, "pull", "--ff-only"], { stdio: "inherit" });
    if (r.status !== 0) fail("ดึงเวอร์ชันใหม่ไม่สำเร็จ (มีไฟล์ที่แก้เองค้างอยู่หรือไม่?)");
  }
  await cmdDeploy();
}

const HELP = `AI Admin Starter — คำสั่ง (${launcherHint()} <คำสั่ง>)
  check                      ตรวจเครื่องนี้พร้อมไหม
  keygen                     สร้างกุญแจ SSH ของชุดนี้
  connect <IP> [--domain d]  บอกที่อยู่ VPS (ไม่มีโดเมนก็ได้)
  key-upload                 ส่งกุญแจไป VPS (เจ้าของพิมพ์เอง ใช้รหัส root ครั้งเดียว)
  deploy                     ติดตั้ง/อัปเดตโปรแกรมบน VPS + HTTPS
  secrets                    ใส่ OpenAI key / LINE secret / LINE token (เจ้าของพิมพ์เอง)
  owner                      ตั้งชื่อผู้ใช้+รหัสเข้าหน้า console (เจ้าของพิมพ์เอง)
  import [business] [--apply] นำข้อมูลร้านเข้า (ไม่มี --apply = ดูแผนก่อน)
  chat [--new] "ข้อความ"      ลองแชทแบบลูกค้า (ก่อนต่อ LINE จริง)
  harness <cases.json>       จำลองแชทเป็นชุด ตรวจผ่าน/ไม่ผ่าน (ใช้ได้ทุกเวลา ไม่ส่งถึงลูกค้า)
  chat-sink | chat-redact    สกัดแชทเก่าจาก LINE OA ลงเครื่อง / ปิดข้อมูลส่วนตัว
  line                       ต่อ LINE OA: ตั้ง webhook + ทดสอบ
  golive on|off              เปิด/ปิดการตอบ LINE จริง
  status | logs | restart | backup | rollback | update`;

const [cmd = "help", ...args] = process.argv.slice(2);
const quote = (a) => `'${String(a).replace(/'/g, "'\\''")}'`;
try {
  switch (cmd) {
    case "check": await cmdCheck(); break;
    case "keygen": cmdKeygen(); break;
    case "connect": await cmdConnect(args); break;
    case "key-upload": await cmdKeyUpload(); break;
    case "deploy": await cmdDeploy(); break;
    case "update": await cmdUpdate(); break;
    case "secrets": await cmdSecrets(); break;
    case "owner": await cmdOwner(); break;
    case "import": await cmdImport(args); break;
    case "backup": await cmdBackup(); break;
    case "harness": await cmdHarness(args); break;
    case "chat-sink": spawnSync(process.execPath, [join(ROOT, "starter", "line-export", "sink.mjs")], { stdio: "inherit" }); break;
    case "chat-redact": process.exitCode = spawnSync(process.execPath, [join(ROOT, "starter", "line-export", "redact.mjs")], { stdio: "inherit" }).status ?? 1; break;
    case "chat": process.exitCode = (await ctl(needState(), `chat ${args.map(quote).join(" ")}`)).code; break;
    case "line": process.exitCode = (await ctl(needState(), `line ${args.includes("--check") ? "--check" : ""}`)).code; break;
    case "golive": {
      if (!["on", "off"].includes(args[0])) fail("ใช้ golive on หรือ golive off");
      process.exitCode = (await ctl(needState(), `golive ${args[0]}`)).code; break;
    }
    case "status": case "logs": case "restart": case "rollback": {
      const s = needState();
      process.exitCode = (await ctl(s, `${cmd} ${cmd === "logs" ? Number(args[0]) || 80 : ""}`)).code;
      if (cmd === "status") await checkHttps(s);
      break;
    }
    case "help": case "--help": case "-h": say(HELP); break;
    default: say(HELP); process.exitCode = 2;
  }
} catch (err) {
  if (!(err instanceof CliError)) throw err;
  process.stderr.write(`❌ ${err.message}\n`);
  process.exitCode = err.code;
}
