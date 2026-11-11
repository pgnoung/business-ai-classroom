// คุยกับ VPS ผ่าน OpenSSH ที่มากับเครื่อง (macOS / Linux / Windows 10+) — ไม่มี dependency เพิ่ม
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const STATE_FILE = join(ROOT, "starter", ".state.json");
export const DEFAULT_KEY = join(homedir(), ".ssh", "ai_admin_vps");

export function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try { return JSON.parse(readFileSync(STATE_FILE, "utf8")); } catch { return {}; }
}

export function saveState(next) {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function isIPv4(v) {
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(v || ""));
}

/** โดเมนฟรีที่ชี้มาที่ IP นี้ได้ทันที ไม่ต้องซื้อโดเมน (203.0.113.5 → 203-0-113-5.sslip.io) */
export function sslipHost(ip) {
  return `${String(ip).replace(/\./g, "-")}.sslip.io`;
}

export function isHostname(v) {
  return /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(String(v || ""));
}

export function which(cmd) {
  const probe = process.platform === "win32" ? spawnSync("where", [cmd]) : spawnSync("sh", ["-c", `command -v ${cmd}`]);
  return probe.status === 0;
}

function baseOpts(state) {
  const key = state.keyPath || DEFAULT_KEY;
  const opts = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ServerAliveInterval=15", "-o", "ConnectionAttempts=3"];
  if (existsSync(key)) opts.unshift("-i", key, "-o", "IdentitiesOnly=yes");
  return opts;
}

function target(state) {
  if (!state.ip) throw new Error("ยังไม่ได้บอกที่อยู่ VPS — ใช้คำสั่ง connect <IP> ก่อน");
  return `${state.user || "root"}@${state.ip}`;
}

/** รันคำสั่งบน VPS — stdin (ถ้ามี) ส่งเข้าไปตรง ๆ ไม่ผ่าน argv จึงไม่ค้างใน process list */
export function ssh(state, remoteCmd, { input, inherit = true, batch = true, tty = false } = {}) {
  const args = [...baseOpts(state)];
  if (batch) args.push("-o", "BatchMode=yes");
  if (tty) args.push("-t");
  args.push(target(state), remoteCmd);
  return new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: [input === undefined ? (inherit ? "inherit" : "ignore") : "pipe", inherit ? "inherit" : "pipe", inherit ? "inherit" : "pipe"] });
    let out = "";
    let err = "";
    if (!inherit) {
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
    }
    if (input !== undefined) { child.stdin.end(input); }
    child.on("close", (code) => resolve({ code, out, err }));
    child.on("error", (e) => resolve({ code: 127, out, err: String(e.message || e) }));
  });
}

export function scp(state, localPath, remotePath) {
  const args = [...baseOpts(state), "-o", "BatchMode=yes", "-q", localPath, `${target(state)}:${remotePath}`];
  return new Promise((resolve) => {
    const child = spawn("scp", args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(127));
  });
}

export function scpFrom(state, remotePath, localPath) {
  const args = [...baseOpts(state), "-o", "BatchMode=yes", "-q", `${target(state)}:${remotePath}`, localPath];
  return new Promise((resolve) => {
    const child = spawn("scp", args, { stdio: "inherit" });
    child.on("close", (code) => resolve(code));
    child.on("error", () => resolve(127));
  });
}
