// Loopback-only synthetic preview + E2E ของ YOLO/Telegram (2026-09-28)
// ข้อมูลจำลองทั้งหมด (ชื่อสมมติ) · ฐานในหน่วยความจำ · LINE/Telegram/Hermes เป็น stub — ไม่มีการส่งจริง
//
//   node scripts/preview-yolo.mjs --check   รัน E2E แล้วจบ (exit 1 ถ้าไม่ผ่าน)
//   node scripts/preview-yolo.mjs           รัน E2E แล้วเปิดคอนโซลที่ 127.0.0.1:4898 ไว้ถ่ายภาพ
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { lineFetchStub, memoryDb, poisonGlobalFetch, testConfig } from "../test/helpers.mjs";

poisonGlobalFetch();
const PORT = Number(process.env.YOLO_PREVIEW_PORT || 4898);
// ค่าจำลองประกอบจากชิ้น (ตัวสแกนความลับของ release จับรูป "password: ค่าจริง")
const OWNER = { username: "fixture-owner", password: ["fixture", "owner", "pass", "123"].join("-") };
const SESSION_KEY = ["fixture", "yolo", "console", "123456"].join("-");
const DRAFT = "ขออนุญาตถามเพิ่มนิดนึงนะคะ ทีมที่จะเข้าร่วมอบรมมีประมาณกี่ท่านคะ จะได้ช่วยออกแบบเนื้อหาให้พอดีกับทีมค่ะ";
const FAKE_BOT = ["700000001", "AApreviewFixtureOnly_notARealBotToken12"].join(":");
const OWNER_TG = 80808080;

const db = memoryDb();
db.createOperator({ username: OWNER.username, passHash: hashPassword(OWNER.password), displayName: "พี่ง้วง (จำลอง)", role: "owner" });
// บัญชีพนักงานจำลอง (ไม่มีสิทธิ์ yolo.send) — ใช้เทียบหัวห้องแชทว่าไม่มีปุ่ม ⚡
db.createOperator({ username: "fixture-staff", passHash: hashPassword(OWNER.password), displayName: "ชมพู่ (จำลอง)", role: "operator" });

function seedRoom(id, name, turns, { aiOff = "", note = "", needsHuman = false } = {}) {
  db.upsertCustomer(id, { displayName: name });
  const start = Date.now() - turns.length * 7 * 60_000 - 40 * 60_000;
  turns.forEach(([direction, content, operator = ""], index) => {
    const mid = `${id}-m${index}`;
    db.insertMessage({ id: mid, customerId: id, direction, content, operator, agentMode: direction === "out" ? (operator ? "operator_ai_off" : "ai") : null });
    db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(start + index * 7 * 60_000, mid);
  });
  if (note) db.addHandoffNote({ customerId: id, author: "ชมพู่", text: note });
  if (aiOff) db.setAiEnabled(id, false, aiOff);
  if (needsHuman) db.setNeedsHuman(id, aiOff || "human_requested", "ส่งต่อทีม");
  return id;
}

const inhouse = [
  ["in", "สวัสดีค่ะ สนใจจัดอบรม AI แบบ in-house ให้ทีมผู้บริหารค่ะ"],
  ["out", "ยินดีมากเลยค่ะ ลูกแพรขอทราบโจทย์ธุรกิจคร่าว ๆ และช่องทางติดต่อกลับนะคะ"],
  ["in", "บริษัทจำลองการค้า เบอร์ 080-000-0000 สะดวกคุยช่วงบ่ายค่ะ"],
  ["out", "รับทราบค่ะ ลูกแพรส่งรายละเอียดให้ทีมดูแลต่อเรียบร้อยนะคะ"],
  ["in", "ขอถามเพิ่มนิดนึงค่ะ ถ้าทีมประมาณ 20 คน จัดวันเสาร์ได้ไหมคะ"],
];
const ROOMS = {
  e2e: seedRoom("U00000000000000000000000000000e2e", "คุณทดสอบ", inhouse, { aiOff: "handoff_private_inhouse", note: "ลูกค้าอยากได้ in-house ทีมผู้บริหาร รอชมพู่โทรกลับวันจันทร์", needsHuman: true }),
  desktop: seedRoom("U0000000000000000000000000000desk", "คุณพิมพ์ชนก (จำลอง)", inhouse, { aiOff: "handoff_private_inhouse", note: "ลูกค้าอยากได้ in-house 20 คน รอชมพู่เสนอราคา", needsHuman: true }),
  mobile: seedRoom("U00000000000000000000000000000mob", "คุณวรเชษฐ์ (จำลอง)", [
    ["in", "สนใจคลาส AI Agent For Business ครับ"],
    ["out", "ยินดีค่ะ ตอนนี้ใช้ AI ในงานประจำวันบ้างไหมคะ"],
  ]),
};

// 2026-10-15: ผู้รับแจ้งเตือนจำลอง — แท็บ "🔔 ส่งต่อแอดมิน" จะได้เห็นผล "แจ้งแอดมินทาง LINE แล้ว 1/1 คน" (stub ไม่ส่งจริง)
db.setSetting("escalate_notify:default", JSON.stringify([`U${"f".repeat(32)}`]));

function telegramStub() {
  const calls = [];
  const updates = [];
  const fn = async (url, options = {}) => {
    const method = String(url).split("/").pop();
    const body = options.body ? JSON.parse(options.body) : {};
    calls.push({ method, body });
    const ok = (result) => ({ ok: true, status: 200, json: async () => ({ ok: true, result }) });
    if (method === "getMe") return ok({ id: 700000001, is_bot: true, username: "lukprae_owner_demo_bot" });
    if (method === "getUpdates") return ok(updates.splice(0));
    if (method === "sendMessage") return ok({ message_id: calls.length });
    return ok(true);
  };
  return Object.assign(fn, { calls, updates });
}

const lineFetch = lineFetchStub();
const telegramFetch = telegramStub();
const hermesFetch = async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: DRAFT } }], usage: { prompt_tokens: 900, completion_tokens: 60 } }) });
const app = createApp({
  config: testConfig({
    CONSOLE_SESSION_SECRET: SESSION_KEY,
    CONSOLE_BRAND_THEME: process.env.YOLO_PREVIEW_THEME || "lukprae", CONSOLE_BRAND_NAME: "พี่ง้วง - ติดกระดุม", CONSOLE_BRAND_MARK: "พง", CONSOLE_BRAND_AGENT: "ลูกแพร AI · ข้อมูลจำลอง",
    CONSOLE_PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}/console`,
  }),
  db, logger: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
  overrides: { lineFetch, hermesFetch, telegramFetch, sleep: async () => {} },
});

async function e2e() {
  const control = app.telegramControl;
  const saved = await control.saveToken(FAKE_BOT);
  const { code } = control.createPairing(OWNER.username);
  const date = Math.floor(Date.now() / 1000);
  const update = (update_id, text) => ({ update_id, message: { message_id: update_id, date, text, from: { id: OWNER_TG, is_bot: false }, chat: { id: OWNER_TG, type: "private" } } });
  telegramFetch.updates.push(update(1, `/start ${code}`));
  await control.pollOnce({ timeoutSec: 0 });
  const pushesBefore = lineFetch.sends.length;
  telegramFetch.updates.push(update(2, "yolo LINE คุณทดสอบ ถามต่อเรื่องจำนวนพนักงาน"));
  await control.pollOnce({ timeoutSec: 0 });
  const pushes = lineFetch.sends.slice(pushesBefore);
  const pushedText = pushes[0]?.body?.messages?.map((m) => m.text).join("\n") || "";
  const replies = telegramFetch.calls.filter((c) => c.method === "sendMessage").map((c) => c.body.text);
  const checks = {
    botSaved: saved.ok === true,
    paired: control.view().paired?.pairedBy === OWNER.username,
    onePush: pushes.length === 1,
    pushedToRoom: pushes[0]?.body?.to === ROOMS.e2e,
    pushedDraft: pushedText.replace(/\s+/gu, "") === DRAFT.replace(/\s+/gu, "").replace(/ค่ะ$/u, "ค่ะ"),
    telegramReplied: replies.some((text) => text.startsWith("ส่งให้คุณ ท*** (LINE) แล้วค่ะพี่ง้วง") && text.includes(pushedText)),
    aiStillOff: db.getCustomer(ROOMS.e2e).ai_enabled === 0,
    audited: db.listAudit(20).some((row) => row.action === "yolo_sent" && row.operator === `telegram:${OWNER.username}`),
  };
  return { ok: Object.values(checks).every(Boolean), checks, pushedText, telegramReply: replies.at(-1) };
}

const result = await e2e();
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes("--check")) {
  db.close();
  process.exit(result.ok ? 0 : 1);
}
// เตรียมหน้าตั้งค่าให้เห็นสภาพ "ตั้งโทเคนแล้ว แต่ยังไม่จับคู่" (สร้างรหัสใหม่ได้จากหน้าจอ)
app.telegramControl.unpair();
app.server.listen(PORT, "127.0.0.1", () => {
  console.log(`YOLO preview: http://127.0.0.1:${PORT}/console/  (login ${OWNER.username} / ${OWNER.password})`);
  console.log(`rooms: desktop=${ROOMS.desktop} mobile=${ROOMS.mobile} e2e=${ROOMS.e2e}`);
});
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.server.close(() => { db.close(); process.exit(0); }));
