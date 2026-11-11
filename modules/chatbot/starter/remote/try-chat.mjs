// ลองแชทแบบลูกค้า โดยไม่ต้องมีมือถือ: สร้างข้อความ LINE ปลอมที่เซ็นถูกต้อง ส่งเข้าระบบบนเครื่องนี้
// แล้วรับคำตอบของ AI ด้วย "LINE จำลอง" (127.0.0.1:4899) — เห็นข้อความเดียวกับที่ลูกค้าจะได้รับจริง
//   node try-chat.mjs "ข้อความ"           ลูกค้าทดสอบคนเดิม (คุยต่อเนื่องได้)
//   node try-chat.mjs --new "ข้อความ"     เริ่มลูกค้าทดสอบคนใหม่
// ระหว่างที่ LINE_LIVE_SEND=false ระบบจะไม่ส่งอะไรออก LINE จริง
import http from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { TEST_USER_PREFIX } from "./test-user.mjs";

const args = process.argv.slice(2);
const fresh = args[0] === "--new";
const text = (fresh ? args.slice(1) : args).join(" ").trim();
if (!text) {
  console.error('ใช้: chat "ข้อความ" (หรือ chat --new "ข้อความ")');
  process.exit(2);
}
const port = process.env.PORT || "4850";
const secret = process.env.LINE_CHANNEL_SECRET || "";
const mockUrl = process.env.LINE_MOCK_URL || "";
if (!secret) {
  console.error("❌ ระบบยังไม่ได้ตั้งค่าครบ (ไม่มีกุญแจ webhook/dashboard) — รัน deploy ใหม่");
  process.exit(2);
}
if (!mockUrl.startsWith("http://127.0.0.1:")) {
  console.error("❌ ตอนนี้ต่อ LINE จริงแล้ว — ทดสอบด้วยการทักแชทจากมือถือแทนนะคะ");
  process.exit(2);
}
const sinkPort = Number(new URL(mockUrl).port);

const stateFile = join(process.env.DATA_DIR || ".", "starter-chat-test.json");
let state = existsSync(stateFile) && !fresh ? JSON.parse(readFileSync(stateFile, "utf8")) : null;
if (!state) {
  state = { userId: TEST_USER_PREFIX + randomBytes(9).toString("hex").slice(0, 33 - TEST_USER_PREFIX.length) };
  writeFileSync(stateFile, JSON.stringify(state));
}
const customerId = state.userId;

const replies = [];
let lastAt = 0;
const sink = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d)).on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "GET" && req.url.includes("/profile")) {
      return res.end(JSON.stringify({ userId: customerId, displayName: "ลูกค้าทดสอบ" }));
    }
    res.end("{}");
    try {
      const body = JSON.parse(raw || "{}");
      for (const m of body.messages || []) {
        if (m.type === "text") replies.push(m.text);
        else if (m.type === "image") replies.push(`[รูป] ${m.originalContentUrl}`);
        else if (m.type === "sticker") replies.push("[สติกเกอร์]");
        else if (m.type === "flex") replies.push(`[การ์ด] ${m.altText || ""}`);
        else replies.push(`[${m.type}]`);
        lastAt = Date.now();
      }
    } catch { /* ไม่ใช่ JSON = ไม่ใช่ข้อความตอบ */ }
  });
});
await new Promise((resolve, reject) => {
  sink.once("error", (err) => reject(err.code === "EADDRINUSE"
    ? new Error("มีการทดลองแชทอีกตัวค้างอยู่ — รอสักครู่แล้วลองใหม่") : err));
  sink.listen(sinkPort, "127.0.0.1", resolve);
});

const sentAt = Date.now();
const body = JSON.stringify({
  destination: "Ustartertestdestination00000000000",
  events: [{
    type: "message",
    mode: "active",
    timestamp: sentAt,
    webhookEventId: "01STARTER" + randomBytes(10).toString("hex").toUpperCase(),
    deliveryContext: { isRedelivery: false },
    source: { type: "user", userId: customerId },
    replyToken: randomBytes(16).toString("hex"),
    message: { id: String(Date.now()) + String(Math.floor(Math.random() * 1000)), type: "text", quoteToken: randomBytes(8).toString("hex"), text },
  }],
});
const signature = createHmac("sha256", secret).update(body).digest("base64");
const res = await fetch(`http://127.0.0.1:${port}/webhooks/line`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-line-signature": signature },
  body,
});
if (!res.ok) {
  console.error(`❌ ระบบไม่รับข้อความ (HTTP ${res.status}) ${await res.text().catch(() => "")}`);
  sink.close();
  process.exit(1);
}
console.log(`👤 ลูกค้า: ${text}`);
process.stdout.write("⏳ รอ AI ตอบ (ระบบรอให้ลูกค้าพิมพ์จบก่อนราว 4–10 วินาที)");

const deadline = Date.now() + 120_000;
let printed = 0;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  if (!replies.length) { process.stdout.write("."); continue; }
  if (!printed) process.stdout.write("\n");
  while (printed < replies.length) console.log(`🤖 AI: ${replies[printed++]}`);
  if (Date.now() - lastAt > 8000) break;
}
sink.close();
if (!printed) {
  console.log("\n⚠️  ยังไม่มีคำตอบใน 2 นาที — อาจถูกส่งต่อให้คน (ห้องขึ้น 'ต้องการคน' ในหน้า console) หรือ AI ถูกปิดอยู่ ดูต่อด้วยคำสั่ง logs");
  process.exit(1);
}
process.exit(0);
