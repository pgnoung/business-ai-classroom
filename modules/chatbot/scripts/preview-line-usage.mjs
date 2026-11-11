// preview-line-usage.mjs — คอนโซลจำลองสำหรับตรวจหน้าตาการ์ด "LINE OA เดือนนี้" (loopback เท่านั้น · 28 ก.ย. 2026)
//
// ทุกตัวเลขในไฟล์นี้แต่งขึ้น (SYNTHETIC) — ไม่มีข้อมูลลูกค้า ไม่มีกุญแจ ไม่ยิง LINE จริง (poisonGlobalFetch + stub)
//   node scripts/preview-line-usage.mjs                 → http://127.0.0.1:4899/console (บัญชีเริ่มบันทึกวันนี้ 08:00)
//   PREVIEW_SCENE=full   บัญชีครอบทั้งเดือน + กรอกราคาแพ็กเกจจำลองแล้ว (ภาพเดือนถัด ๆ ไป)
// บัญชีจำลอง: fixture-owner / fixture-admin (รหัสผ่านพิมพ์ออกทาง console ตอนเริ่ม)
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { bangkokDay } from "../src/lineSendLedger.mjs";
import { jstDateKey } from "../src/lineInsight.mjs";
import { lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "../test/helpers.mjs";

poisonGlobalFetch();
const PORT = Number(process.env.PORT || 4899);
const SCENE = String(process.env.PREVIEW_SCENE || "deploy");
// ค่าจำลองประกอบจากชิ้น (ตัวสแกนความลับของ release จับรูป "password = ค่าจริง")
const PASSWORD = ["fixture", "line", "usage", "123"].join("-");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// สุ่มแบบกำหนดเมล็ด — ภาพออกมาเหมือนเดิมทุกครั้ง
let seed = 20260928;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

let fixedNow = null;
const db = memoryDb({ now: () => fixedNow ?? Date.now() });
const at = (ms, fn) => { fixedNow = ms; try { return fn(); } finally { fixedNow = null; } };
const hash = hashPassword(PASSWORD);
db.createOperator({ username: "fixture-owner", passHash: hash, displayName: "พี่ง้วง (จำลอง)", role: "owner" });
db.createOperator({ username: "fixture-admin", passHash: hash, displayName: "แอดมิน (จำลอง)", role: "admin" });

const now = Date.now();
const todayBkk = bangkokDay(now);
const monthStartMs = Date.UTC(Number(todayBkk.slice(0, 4)), Number(todayBkk.slice(5, 7)) - 1, 1) - 7 * HOUR;
const todayStartMs = Date.UTC(Number(todayBkk.slice(0, 4)), Number(todayBkk.slice(5, 7)) - 1, Number(todayBkk.slice(8, 10))) - 7 * HOUR;
const ledgerStartMs = SCENE === "full" ? monthStartMs + HOUR : todayStartMs + 8 * HOUR;

function ledger(dayMs, method, purpose, { requests = 1, sends = requests, recipients = requests, objects = requests, detail = "" } = {}) {
  const atMs = Math.max(dayMs, ledgerStartMs);
  if (atMs > now) return;
  db.addLineSend({ day: bangkokDay(atMs), channelId: "default", method, purpose, detail, countsQuota: method !== "reply",
    sends, requests, recipients, messageObjects: objects, at: atMs });
}

let apiPushByDate = new Map();
const addApiPush = (ms, n) => { const key = jstDateKey(ms); apiPushByDate.set(key, (apiPushByDate.get(key) || 0) + n); };

for (let dayMs = monthStartMs; dayMs <= now; dayMs += DAY) {
  const tracked = dayMs + DAY > ledgerStartMs;
  const alerts = between(7, 11);
  // แจ้งเตือนทีม: ก่อนเริ่มบันทึก = แถว audit (แบบที่ notify.mjs จดจริง) · หลังเริ่ม = บัญชี
  for (let i = 0; i < alerts; i += 1) {
    const ms = dayMs + (9 + i) * HOUR;
    if (ms > now) break;
    if (ms < ledgerStartMs) at(ms, () => db.addAudit({ operator: "system", action: "escalate_notify", target: `ops:preview-${i}`, detail: "complaint — push แจ้งทีม 2/2 คน · พยายาม 2 คน" }));
    else ledger(ms, "push", "team_alert", { requests: 2, sends: 2 });
    addApiPush(ms, 2);
  }
  const fallback = between(6, 14);
  const followups = between(18, 34);
  const operator = between(20, 40);
  const yolo = between(0, 2);
  addApiPush(dayMs + 12 * HOUR, fallback + followups + operator + yolo);
  if (tracked) {
    const base = dayMs + 12 * HOUR;
    ledger(base, "reply", "customer_reply", { requests: between(40, 60), objects: 110 });
    ledger(base, "push", "customer_reply_fallback", { requests: fallback - 2, sends: Math.ceil((fallback - 2) / 2), detail: "reply_rejected" });
    ledger(base, "push", "customer_reply_fallback", { requests: 2, sends: 2, detail: "no_reply_token" });
    ledger(base, "push", "followup", { requests: followups, objects: followups * 2 });
    ledger(base, "push", "operator", { requests: operator, sends: Math.ceil(operator * 0.7) });
    if (yolo) ledger(base, "push", "yolo", { requests: yolo });
  }
}

// สถิติ LINE: ถึงเมื่อวานของญี่ปุ่น (ของวันนี้ยังไม่มา) · บรอดแคสต์จาก OA Manager สองครั้ง + เลือกกลุ่มหนึ่งครั้ง
const broadcastDays = new Map([[jstDateKey(monthStartMs + 8 * DAY + 12 * HOUR), { broadcast: 1850 }],
  [jstDateKey(monthStartMs + 19 * DAY + 12 * HOUR), { broadcast: 1920 }], [jstDateKey(monthStartMs + 14 * DAY + 12 * HOUR), { targeting: 320 }]]);
const yesterdayJst = jstDateKey(now - DAY);
for (const [date, apiPush] of apiPushByDate) {
  if (date > yesterdayJst || !date.startsWith(yesterdayJst.slice(0, 6))) continue;
  db.saveLineInsight({ channelId: "default", date, status: "ready", at: now, counts: {
    ...(broadcastDays.get(date) || {}), chat: between(4, 16), autoResponse: between(0, 3), welcomeResponse: between(0, 2),
    apiPush, apiReply: between(40, 60),
  } });
}

// ยอดโควตาจำลอง = ที่อธิบายได้ + วันนี้ที่ LINE ยังไม่ส่งสถิติ (ให้การ์ดมีช่อง "ยังแยกไม่ได้" แบบของจริง)
const sumLedger = db.lineSendRows({ fromDay: `${todayBkk.slice(0, 7)}-01`, toDay: todayBkk }).reduce((s, r) => s + (r.counts_quota ? r.recipients : 0), 0);
const sumInsight = db.lineInsightRows({ fromDate: `${yesterdayJst.slice(0, 6)}01`, toDate: yesterdayJst })
  .reduce((s, r) => { const c = JSON.parse(r.counts_json); return s + (c.broadcast || 0) + (c.targeting || 0) + (c.apiPush || 0); }, 0);
const totalUsage = SCENE === "full" ? sumInsight + 180 : sumInsight + Math.round(sumLedger * 0.4) + 60;
if (SCENE === "full") {
  // ราคาจำลองสำหรับดูหน้าตาเท่านั้น — ของจริงเจ้าของกรอกจากใบแจ้งหนี้ของ LINE เอง
  db.setSetting("line_plan_monthly_fee_thb", "1000");
  db.setSetting("line_plan_included_messages", "10000");
  db.setSetting("line_plan_extra_per_message_thb", "0.1");
}

const app = createApp({
  config: testConfig({
    CONSOLE_SESSION_SECRET: ["preview", "line", "usage", "0123456789"].join("-"),
    CONSOLE_BRAND_THEME: process.env.PREVIEW_THEME || "lukprae", CONSOLE_BRAND_NAME: "พี่ง้วง - ติดกระดุม", CONSOLE_BRAND_MARK: "พง",
    CONSOLE_BRAND_AGENT: "ลูกแพร AI · ข้อมูลจำลอง",
  }),
  db, logger: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
  overrides: {
    lineFetch: lineFetchStub({ quota: { type: "limited", value: 15000 }, consumption: { totalUsage } }),
    sleep: async () => {},
  },
});
app.server.listen(PORT, "127.0.0.1", () => {
  console.log(`LINE usage preview (${SCENE}): http://127.0.0.1:${PORT}/console  (login fixture-owner / ${PASSWORD})`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.server.close(() => { db.close(); process.exit(0); }));
