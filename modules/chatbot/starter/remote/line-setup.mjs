// ต่อ LINE OA เข้ากับระบบ: อ่านข้อมูลบอท → ตั้ง Webhook URL → ให้ LINE ยิงทดสอบมาที่เซิร์ฟเวอร์นี้
// ใช้โทเคนที่อยู่บนเซิร์ฟเวอร์อยู่แล้ว (ไม่ต้องส่งค่าลับผ่านแชท)
//   node line-setup.mjs            ตรวจ + ตั้ง webhook + ทดสอบ
//   node line-setup.mjs --check    ตรวจอย่างเดียว ไม่แก้อะไร
import { readFileSync } from "node:fs";

const checkOnly = process.argv.includes("--check");
const token = process.env.LINE_CHANNEL_ACCESS_TOKEN || "";
if (!token) {
  console.error("❌ ยังไม่ได้ใส่ LINE Channel access token (ใช้คำสั่ง secrets บนเครื่องตัวเองก่อน)");
  process.exit(2);
}
if (process.env.LINE_SANDBOX) {
  console.error("❌ ยังไม่ได้ใส่ LINE Channel secret ของจริง (ใช้คำสั่ง secrets ก่อน)");
  process.exit(2);
}
const host = readFileSync("/etc/ai-admin/host", "utf8").trim();
const endpoint = `https://${host}/webhooks/line`;
const api = "https://api.line.me/v2/bot";
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

async function call(method, path, body) {
  const res = await fetch(`${api}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 200) }; }
  return { ok: res.ok, status: res.status, json };
}

const info = await call("GET", "/info");
if (!info.ok) {
  console.error(info.status === 401
    ? "❌ LINE ไม่รับโทเคนนี้ (401) — ออก Channel access token (long-lived) ใหม่ใน LINE Developers แล้วใส่ใหม่"
    : `❌ ติดต่อ LINE ไม่ได้ (HTTP ${info.status})`);
  process.exit(1);
}
console.log(`✅ เจอบัญชี LINE: ${info.json.displayName} (${info.json.basicId})`);

const current = await call("GET", "/channel/webhook/endpoint");
console.log(`   Webhook ตอนนี้: ${current.json.endpoint || "(ยังไม่ตั้ง)"} · เปิดใช้: ${current.json.active ? "ใช่" : "ยังไม่เปิด"}`);
if (checkOnly) process.exit(0);

if (current.json.endpoint !== endpoint) {
  const set = await call("PUT", "/channel/webhook/endpoint", { endpoint });
  if (!set.ok) {
    console.error(`❌ ตั้ง Webhook ไม่สำเร็จ (HTTP ${set.status}) ${JSON.stringify(set.json)}`);
    process.exit(1);
  }
  console.log(`✅ ตั้ง Webhook เป็น ${endpoint}`);
}

const test = await call("POST", "/channel/webhook/test", { endpoint });
if (test.ok && test.json.success) {
  console.log("✅ LINE ยิงทดสอบมาถึงเซิร์ฟเวอร์และลายเซ็นถูกต้อง");
} else {
  const code = test.json.statusCode;
  const why = code === 403
    ? "ลายเซ็นไม่ตรง = Channel secret ที่ใส่ไว้ไม่ใช่ของ channel นี้ ใส่ใหม่ด้วยคำสั่ง secrets"
    : code === 503 ? "ระบบยังไม่พร้อมรับ webhook — ดู status"
      : `${test.json.reason || ""} ${test.json.detail || ""}`.trim() || `HTTP ${test.status}`;
  console.error(`❌ ทดสอบ Webhook ไม่ผ่าน: ${why}`);
  process.exit(1);
}
if (!current.json.active) {
  console.log("⚠️  อย่าลืม: ใน LINE Official Account Manager → ตั้งค่า → การตอบกลับ เปิด 'Webhook' และปิด 'ข้อความตอบกลับอัตโนมัติ'");
}
console.log(`basicId=${info.json.basicId}`);
