// preview-broadcast-studio.mjs — คอนโซลจำลองสำหรับตรวจหน้าตาสตูดิโอบรอดแคสต์ + ข้อความตามขั้น (loopback เท่านั้น · 28 ก.ย. 2026)
//
// ทุกข้อมูลแต่งขึ้น (SYNTHETIC) — ไม่มีข้อมูลลูกค้าจริง ไม่มีกุญแจ ไม่ยิง LINE จริง (poisonGlobalFetch + stub ของ LINE mock)
//   node scripts/preview-broadcast-studio.mjs            → http://127.0.0.1:4897/console/#/broadcast
//   PREVIEW_THEME=pngoung / airdog   ดูธีมอื่น
// บัญชีจำลอง: fixture-owner (รหัสผ่านพิมพ์ออกทาง console ตอนเริ่ม)
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { hermesFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "../test/helpers.mjs";

poisonGlobalFetch();
const PORT = Number(process.env.PORT || 4897);
const PASSWORD = ["fixture", "studio", "view", "123"].join("-");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = Date.now();

// ภาพจำลอง (SVG data URI — CSP img-src อนุญาต data:) — URL ส่ง LINE เป็นโดเมนตัวอย่าง https (ไม่ถูกเรียกจริง)
const svg = (title, from, to) => `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="416" viewBox="0 0 640 416"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="640" height="416" fill="url(#g)"/><circle cx="520" cy="90" r="120" fill="rgba(255,255,255,0.12)"/><text x="40" y="340" font-family="sans-serif" font-size="46" font-weight="700" fill="#fff">${title}</text></svg>`)}`;
const imageCatalog = [
  { key: "class_ai_agent", label: "คลาส AI Agent for Business", url: "https://img.example/class-ai-agent.jpg", consoleUrl: svg("AI Agent Class", "#d13868", "#7a5cd6") },
  { key: "class_online", label: "คลาสออนไลน์", url: "https://img.example/class-online.jpg", consoleUrl: svg("Online Class", "#7a5cd6", "#2a1b2e") },
  { key: "atmosphere_room", label: "บรรยากาศห้องเรียน", url: "https://img.example/room.jpg", consoleUrl: svg("Classroom", "#b7836c", "#d13868") },
];

const db = memoryDb();
db.createOperator({ username: "fixture-owner", passHash: hashPassword(PASSWORD), displayName: "พี่ง้วง (จำลอง)", role: "owner" });

// ลูกค้าจำลอง + ป้ายกรอบใหม่ "มิติ: ค่า"
let seed = 20260928;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const names = ["คุณแพร", "คุณมิว", "คุณต้น", "คุณฝน", "คุณเก่ง", "คุณนุ่น", "คุณบีม", "คุณเจ", "คุณออม", "คุณกิ๊ฟ", "คุณแบงค์", "คุณพลอย"];
const interests = ["สนใจ: AI Agent for Business", "สนใจ: คลาสออนไลน์", "สนใจ: Excel + AI", "สนใจ: Make Automation"];
const stages = ["ขั้น: ถามราคา", "ขั้น: เลือกรอบ", "ขั้น: รอโอน", "ขั้น: ขอคิดก่อน"];
for (let i = 0; i < 48; i += 1) {
  const id = `U-fixture-${String(i).padStart(3, "0")}`;
  db.upsertCustomer(id, { displayName: `${names[i % names.length]} (จำลอง)` });
  db.addTag(id, interests[i % interests.length], i % 3 ? "ai" : "human");
  if (rand() > 0.35) db.addTag(id, stages[Math.floor(rand() * stages.length)], "ai");
  if (i % 7 === 0) { db.addTag(id, "customer", "human"); db.addTag(id, `ซื้อครั้งที่: ${1 + (i % 3)}`, "rfm"); db.addTag(id, "ซื้อล่าสุด: Sep2026", "rfm"); }
  if (i % 9 === 0) db.addTag(id, "กิจกรรม: MOS2026", "human");
  if (i % 11 === 0) db.addTag(id, "ของแจก: E-book Prompt 50 แบบ", "human");
  if (i % 13 === 0) db.addTag(id, "VIP", "human");
  if (i === 5) db.addTag(id, "null", "human");
}

// แคมเปญในอดีต (ผลลัพธ์) — แถว broadcasts + ข้อมูลแคมเปญ + ลิงก์นับคลิก
const insertCampaign = ({ id, at, mode, status, messages, include = [], exclude = [], audience = 0, sent = 0, target = {}, estimate = null, kind = "exact", phase = "", success = null, insight = null, clicks = [] }) => {
  db.raw.prepare(`INSERT INTO broadcasts (id, channel_id, messages_json, include_tags_json, exclude_tags_json, audience_count, sent_count, status, created_by, created_at, updated_at)
    VALUES (?, 'default', ?, ?, ?, ?, ?, ?, 'fixture-owner', ?, ?)`).run(id, JSON.stringify(messages), JSON.stringify(include), JSON.stringify(exclude), audience, sent, status, at, at);
  db.raw.prepare(`INSERT INTO broadcast_campaigns (broadcast_id, channel_id, mode, target_json, estimate, estimate_kind, line_request_id, line_phase, line_success_count, insight_json, insight_at, created_at, updated_at)
    VALUES (?, 'default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, mode, JSON.stringify(target), estimate, kind, mode === "tags" ? "" : "0b4a3e8f-1d2c-4e5f-8a9b-0c1d2e3f4a5b", phase, success, insight ? JSON.stringify(insight) : "", insight ? at + HOUR : null, at, at);
  clicks.forEach(([url, label, n], index) => db.raw.prepare(`INSERT INTO broadcast_links (token, owner_kind, owner_id, step_no, link_no, url, label, clicks, created_at) VALUES (?, 'broadcast', ?, 0, ?, ?, ?, ?, ?)`)
    .run(`Fixture${"ABCDEFGH"[Number(id.slice(-1)) || 0]}${"abcdefgh"[index]}qqq`, id, index, url, label, n, at));
};
insertCampaign({
  id: "bc-fixture-1", at: now - 2 * DAY, mode: "all", status: "done", estimate: 5310, kind: "line_estimate", phase: "accepted",
  messages: [{ type: "text", text: "รอบใหม่คลาส AI Agent for Business เปิดแล้วค่ะ 🎉 ดูรายละเอียดที่ https://pngoung.example/ai-agent" }, { type: "image", key: "class_ai_agent" }],
  insight: { overview: { delivered: 5288, uniqueImpression: 2140, uniqueClick: 212 }, messages: [], clicks: [] },
  clicks: [["https://pngoung.example/ai-agent", "", 187]],
});
insertCampaign({
  id: "bc-fixture-2", at: now - 5 * DAY, mode: "tags", status: "done", audience: 31, sent: 31,
  include: ["สนใจ:*"], exclude: ["customer", "ซื้อครั้งที่:*"],
  messages: [{ type: "card", altText: "", cards: [{ imageKey: "class_online", title: "คลาสออนไลน์ ต.ค.", text: "เรียนสดผ่าน Zoom ดูย้อนหลังได้", buttons: [{ label: "ดูรอบเรียน", kind: "uri", uri: "https://pngoung.example/online" }] }] }],
  clicks: [["https://pngoung.example/online", "ดูรอบเรียน", 9]],
});
insertCampaign({
  id: "bc-fixture-3", at: now - 9 * DAY, mode: "audience", status: "done", estimate: 640, kind: "line_estimate", phase: "succeeded", success: 612,
  target: { include: [4101], exclude: [] },
  messages: [{ type: "text", text: "ขอบคุณที่มางาน MOS2026 นะคะ ส่งสไลด์ให้ตามสัญญาค่ะ" }, { type: "sticker", packageId: "11537", stickerId: "52002734" }],
  insight: { overview: { delivered: 612, uniqueImpression: 401, uniqueClick: null }, messages: [], clicks: [] },
});
// ห้องที่ตอบกลับหลังแคมเปญตามป้าย (ตัวเลข "ตอบกลับใน 72 ชม.")
for (let i = 1; i <= 6; i += 1) {
  const id = `U-fixture-${String(i * 3).padStart(3, "0")}`;
  db.raw.prepare("INSERT INTO broadcast_recipients (broadcast_id, line_user_id, batch_no, status, created_at, updated_at) VALUES ('bc-fixture-2', ?, 0, 'sent', ?, ?)").run(id, now - 5 * DAY, now - 5 * DAY);
}

// ข้อความตามขั้น (จำลอง) — ลำดับทำงาน 2 ชุด · พักโดยระบบ 1 · ร่าง 1 + สถิติรายขั้น (แถวจำลอง ไม่มีการส่งจริง)
const makeSequence = ({ name, triggerType, triggerValue = "", stopOnReply = false, steps, status, pausedBy = "" }) => {
  const sequence = db.createStepSequence({ channelId: "default", name, triggerType, triggerValue, stopOnReply, steps, createdBy: "fixture-owner" });
  if (status === "active" || status === "paused") db.activateStepSequence(sequence.id, { version: sequence.version, activatedBy: "fixture-owner" });
  if (status === "paused") db.pauseStepSequence(sequence.id, { pausedBy });
  db.raw.prepare("UPDATE step_sequences SET activated_at = ?, trigger_since = ? WHERE id = ? AND activated_at IS NOT NULL").run(now - 14 * DAY, now - 14 * DAY, sequence.id);
  return sequence;
};
const seedStepStats = (sequenceId, plan) => {
  let n = 0;
  for (const { status, nextStep, sent = [], skipped = [], failed = [], stopReason = "" } of plan) {
    n += 1;
    const enrollmentId = `${sequenceId.slice(0, 8)}-enr-${n}`;
    const customerId = `U-fixture-${String(n % 48).padStart(3, "0")}`;
    const at = now - (15 - (n % 12)) * DAY;
    db.raw.prepare(`INSERT OR IGNORE INTO step_enrollments (id, sequence_id, customer_id, channel_id, status, next_step, next_due_at, anchor_at, enrolled_at, stop_reason, updated_at)
      VALUES (?, ?, ?, 'default', ?, ?, ?, ?, ?, ?, ?)`).run(enrollmentId, sequenceId, `${customerId}-${n}`, status, nextStep, status === "active" ? now + DAY : null, at, at, stopReason, at);
    const delivery = (stepNo, deliveryStatus) => db.raw.prepare(`INSERT INTO step_deliveries (enrollment_id, sequence_id, step_no, customer_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(enrollmentId, sequenceId, stepNo, `${customerId}-${n}`, deliveryStatus, at + (stepNo + 1) * HOUR, at + (stepNo + 1) * HOUR);
    sent.forEach((stepNo) => delivery(stepNo, "sent"));
    skipped.forEach((stepNo) => delivery(stepNo, "skipped"));
    failed.forEach((stepNo) => delivery(stepNo, "unknown"));
  }
};
const repeat = (count, row) => Array.from({ length: count }, () => row);
const welcome = makeSequence({
  name: "ต้อนรับเพื่อนใหม่", triggerType: "follow", status: "active",
  steps: [
    { delay: { kind: "hours", hours: 1 }, condition: null, messages: [{ type: "text", text: "ขอบคุณที่เพิ่มเพื่อนนะคะ 💗 ลูกแพรเป็นผู้ช่วยของพี่ง้วง ถามเรื่องคลาสได้ตลอดเลยค่ะ" }, { type: "image", key: "atmosphere_room" }] },
    { delay: { kind: "days", days: 1, at: "10:00" }, condition: null, messages: [{ type: "card", altText: "", cards: [{ imageKey: "class_ai_agent", title: "คลาส AI Agent for Business", text: "ทำผู้ช่วย AI ให้ธุรกิจตัวเองได้ในวันเดียว", buttons: [{ label: "ดูรายละเอียด", kind: "uri", uri: "https://pngoung.example/ai-agent" }, { label: "ถามลูกแพร", kind: "message", text: "สนใจคลาส AI Agent ค่ะ" }] }] }] },
    { delay: { kind: "days", days: 3, at: "19:00" }, condition: { hasTags: [], hasNotTags: ["สนใจ: AI Agent for Business"] }, messages: [{ type: "sticker", packageId: "11537", stickerId: "52002734" }, { type: "text", text: "มีคลาสออนไลน์ด้วยนะคะ เรียนจากบ้านได้ ดูรอบที่ https://pngoung.example/online" }] },
  ],
});
seedStepStats(welcome.id, [
  ...repeat(18, { status: "completed", nextStep: 3, sent: [0, 1, 2] }),
  ...repeat(7, { status: "completed", nextStep: 3, sent: [0, 1], skipped: [2] }),
  ...repeat(9, { status: "active", nextStep: 1, sent: [0] }),
  ...repeat(4, { status: "active", nextStep: 2, sent: [0, 1] }),
  ...repeat(5, { status: "stopped", nextStep: 1, sent: [0], stopReason: "purchased" }),
  ...repeat(2, { status: "stopped", nextStep: 2, sent: [0, 1], stopReason: "unfollowed" }),
  ...repeat(3, { status: "stopped", nextStep: 1, sent: [0], stopReason: "human_takeover" }),
  { status: "stopped", nextStep: 0, failed: [0], stopReason: "delivery_unknown" },
]);
const giveaway = makeSequence({
  name: "ส่งของแจก E-book Prompt 50 แบบ", triggerType: "keyword", triggerValue: "ของแจก", stopOnReply: true, status: "active",
  steps: [
    { delay: { kind: "hours", hours: 1 }, condition: null, messages: [{ type: "text", text: "นี่ค่ะ E-book Prompt 50 แบบ ดาวน์โหลดได้ที่ https://pngoung.example/ebook" }] },
    { delay: { kind: "days", days: 2, at: "10:00" }, condition: null, messages: [{ type: "text", text: "ลองใช้ Prompt ไปแล้วเป็นยังไงบ้างคะ ติดตรงไหนถามลูกแพรได้เลยค่ะ" }] },
  ],
});
seedStepStats(giveaway.id, [
  ...repeat(11, { status: "completed", nextStep: 2, sent: [0, 1] }),
  ...repeat(6, { status: "active", nextStep: 1, sent: [0] }),
  ...repeat(8, { status: "stopped", nextStep: 1, sent: [0], stopReason: "customer_replied" }),
]);
for (const [sequence, stepNo, url, clicks, token] of [
  [welcome, 1, "https://pngoung.example/ai-agent", 17, "StepFixtureA"], [welcome, 2, "https://pngoung.example/online", 3, "StepFixtureB"],
  [giveaway, 0, "https://pngoung.example/ebook", 21, "StepFixtureC"],
]) {
  db.raw.prepare(`INSERT INTO broadcast_links (token, owner_kind, owner_id, step_no, link_no, url, label, clicks, created_at)
    VALUES (?, 'step', ?, ?, 0, ?, '', ?, ?)`).run(token, `${sequence.id}:v1`, stepNo, url, clicks, now - 10 * DAY);
}
makeSequence({
  name: "ติดตามคนสนใจ Excel + AI", triggerType: "tag", triggerValue: "สนใจ: Excel + AI", status: "paused", pausedBy: "system:guard",
  steps: [{ delay: { kind: "days", days: 1, at: "11:00" }, condition: null, messages: [{ type: "text", text: "คลาส Excel + AI รอบหน้าเปิดจองแล้วนะคะ" }] }],
});
makeSequence({
  name: "เตรียมตัวก่อนเรียน", triggerType: "order_paid", status: "draft",
  steps: [
    { delay: { kind: "hours", hours: 1 }, condition: null, messages: [{ type: "text", text: "ขอบคุณที่ลงเรียนนะคะ เตรียมโน้ตบุ๊กและบัญชี Google ไว้ได้เลยค่ะ" }] },
    { delay: { kind: "days", days: 1, at: "10:00" }, condition: { hasTags: ["รอบ: ออนไลน์"], hasNotTags: [] }, messages: [{ type: "text", text: "ลิงก์ Zoom จะส่งให้ก่อนเรียน 1 วันนะคะ" }] },
  ],
});

// LINE mock: โควตา + จำนวนเพื่อน + กลุ่มเป้าหมายจาก OA Manager
const audiences = [
  { audienceGroupId: 4101, type: "CHAT_TAG", createRoute: "OA_MANAGER", description: "แท็กแชท: มางาน MOS2026", status: "READY", audienceCount: 640, created: Math.floor(now / 1000) - 30 * 86400, permission: "READ" },
  { audienceGroupId: 4102, type: "FRIEND_PATH", createRoute: "OA_MANAGER", description: "เพิ่มเพื่อนจากโฆษณา Facebook ก.ย.", status: "READY", audienceCount: 1280, created: Math.floor(now / 1000) - 12 * 86400, permission: "READ" },
  { audienceGroupId: 4103, type: "CLICK", createRoute: "OA_MANAGER", description: "คลิกลิงก์บรอดแคสต์ 1 ก.ย.", status: "READY", audienceCount: 0, created: Math.floor(now / 1000) - 26 * 86400, permission: "READ" },
  { audienceGroupId: 4104, type: "UPLOAD", createRoute: "MESSAGING_API", description: "ศิษย์เก่ารุ่น 1-5", status: "IN_PROGRESS", audienceCount: 0, created: Math.floor(now / 1000) - 3600, permission: "READ_WRITE" },
];
const headers = (map = {}) => ({ get: (name) => map[String(name).toLowerCase()] ?? null });
const lineFetch = async (url, opts = {}) => {
  const u = String(url);
  if ((opts.method || "GET") === "GET") {
    if (u.includes("/quota/consumption")) return { ok: true, status: 200, headers: headers(), json: async () => ({ totalUsage: 63_615 }) };
    if (u.includes("/v2/bot/message/quota")) return { ok: true, status: 200, headers: headers(), json: async () => ({ type: "limited", value: 92_000 }) };
    if (u.includes("/insight/followers")) return { ok: true, status: 200, headers: headers(), json: async () => ({ status: "ready", followers: 5_551, targetedReaches: 3_904, blocks: 241 }) };
    if (u.includes("/audienceGroup/list")) return { ok: true, status: 200, headers: headers(), json: async () => ({ audienceGroups: audiences, hasNextPage: false }) };
    return { ok: false, status: 404, headers: headers(), json: async () => ({}) };
  }
  return { ok: true, status: u.endsWith("/narrowcast") ? 202 : 200, headers: headers({ "x-line-request-id": "0b4a3e8f-1d2c-4e5f-8a9b-0c1d2e3f4a5b" }), json: async () => ({}) };
};

const app = createApp({
  config: testConfig({
    CONSOLE_SESSION_SECRET: ["preview", "studio", "secret", "0123456789"].join("-"),
    CONSOLE_BRAND_THEME: process.env.PREVIEW_THEME || "lukprae", CONSOLE_BRAND_NAME: "พี่ง้วง - ติดกระดุม", CONSOLE_BRAND_MARK: "พง",
    CONSOLE_BRAND_AGENT: "ลูกแพร AI · ข้อมูลจำลอง", MEDIA_PUBLIC_BASE_URL: "https://lukprae.example",
    BROADCAST_SCHEDULE_ENABLED: process.env.PREVIEW_SCHEDULE === "0" ? "false" : "true", STICKER_PICKER_ENABLED: "true",
  }),
  db, logger: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
  overrides: { lineFetch, hermesFetch: hermesFetchStub(), sleep: async () => {}, imageCatalog },
});
app.server.listen(PORT, "127.0.0.1", () => {
  console.log(`Broadcast studio preview: http://127.0.0.1:${PORT}/console/#/broadcast  (login fixture-owner / ${PASSWORD})`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.server.close(() => { db.close(); process.exit(0); }));
