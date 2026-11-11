#!/usr/bin/env node
// ตัวรับแชทจาก LINE OA Manager ลงเครื่องตัวเอง (อ่านอย่างเดียว)
//
// ทำไมต้องมี: หน้า chat.line.biz ที่เจ้าของร้านล็อกอินอยู่เท่านั้นที่อ่านประวัติแชทได้ แต่แชทหลักร้อยห้อง
// ส่งผ่านหน้าจอ AI ไม่ได้ (ใหญ่ + เป็นข้อมูลส่วนบุคคล) ตัวนี้จึงเปิดพอร์ตในเครื่องให้หน้าเว็บส่งข้อมูลมาเก็บเป็นไฟล์
//
//   node starter/line-export/sink.mjs          (หรือ bash ai-admin.sh chat-sink)
//
// กติกา: ฟังเฉพาะ 127.0.0.1 · ต้องมีรหัสรอบ (token) · รับจาก https://chat.line.biz เท่านั้น ·
// เก็บใน chat-export/ (อยู่ใน .gitignore ห้ามแชร์) · กลับมาเก็บต่อได้ (GET /done)
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_DIR = join(ROOT, "chat-export", "raw");
const ALLOWED_ORIGIN = "https://chat.line.biz";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const CHAT_ID = /^U[0-9a-f]{32}$/u; // ชื่อไฟล์มาจากภายนอก — บังคับรูปแบบก่อนใช้ กัน ../ ในชื่อ

export function createSink({ dir = DEFAULT_DIR, token, log = console.log } = {}) {
  if (typeof token !== "string" || token.length < 16) throw new Error("ต้องมี token อย่างน้อย 16 ตัว");
  const chats = join(dir, "chats");
  mkdirSync(chats, { recursive: true });
  const done = () => (existsSync(chats) ? readdirSync(chats) : []).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));

  const send = (res, status, body) => {
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-headers": "content-type, x-sink-token",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-private-network": "true", // Chrome ถามก่อนให้เว็บจริงคุยกับเครื่องตัวเอง
    });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((ok, bad) => {
    const parts = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= MAX_BODY_BYTES) parts.push(c); });
    req.once("end", () => {
      if (size > MAX_BODY_BYTES) return bad(new Error("too_large"));
      try { ok(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}")); } catch { bad(new Error("bad_json")); }
    });
    req.once("error", bad);
  });

  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return send(res, 204, {});
    if (req.headers.origin && req.headers.origin !== ALLOWED_ORIGIN) return send(res, 403, { error: "origin" });
    if (req.headers["x-sink-token"] !== token) return send(res, 401, { error: "bad_token" });
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/done") return send(res, 200, { ok: true, done: done() });
    if (req.method === "POST" && url.pathname === "/chat") {
      const body = await readBody(req).catch(() => null);
      const chatId = String(body?.chatId || "");
      if (!body || !CHAT_ID.test(chatId)) return send(res, 400, { error: "invalid_chat" });
      writeFileSync(join(chats, `${chatId}.json`), JSON.stringify(body), { mode: 0o600 });
      const total = done().length;
      if (total % 25 === 0) log(`เก็บแล้ว ${total} ห้อง`);
      return send(res, 200, { ok: true, total });
    }
    if (req.method === "POST" && url.pathname === "/finish") {
      log(`✅ เบราว์เซอร์แจ้งว่าเก็บครบแล้ว — รวม ${done().length} ห้อง กด Ctrl+C เพื่อปิด แล้วรัน redact ต่อ`);
      return send(res, 200, { ok: true, total: done().length });
    }
    return send(res, 404, { error: "not_found" });
  });

  return {
    server, chats,
    listen: (port = 8791) => new Promise((ok, bad) => { server.once("error", bad); server.listen(port, "127.0.0.1", () => ok(server.address())); }),
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const token = randomBytes(16).toString("hex");
  const sink = createSink({ token });
  const port = Number(process.env.SINK_PORT || 8791);
  await sink.listen(port);
  // token เป็นรหัสของรอบนี้เท่านั้น (ไม่ใช่รหัส LINE) — AI ต้องใช้ใส่ในสคริปต์ฝั่งเบราว์เซอร์
  console.log(`พร้อมรับแชทที่ http://127.0.0.1:${port}`);
  console.log(`SINK_TOKEN=${token}`);
  console.log(`เก็บลง ${sink.chats} (มีอยู่แล้ว ${readdirSync(sink.chats).filter((f) => f.endsWith(".json")).length} ห้อง)`);
}
