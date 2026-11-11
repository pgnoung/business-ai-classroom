// Loopback-only synthetic preview of "สอนลูกแพรจากแผง 'ทำไมตอบแบบนี้'" (2026-09-28).
// In-memory DB, stubbed LINE/Hermes, poisoned global fetch — no provider key, customer data or live send.
//   node scripts/preview-lessons.mjs            → http://127.0.0.1:4898/console/#/lessons
//   PREVIEW_THEME=pngoung PREVIEW_PORT=4899 …   → same data on the pngoung theme (has a dark option)
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { testConfig, memoryDb, lineFetchStub, hermesFetchStub, poisonGlobalFetch } from "../test/helpers.mjs";
import { lessonTeachingKey } from "../src/ownerLessons.mjs";

poisonGlobalFetch();
const port = Number(process.env.PREVIEW_PORT || 4898);
const theme = process.env.PREVIEW_THEME === "pngoung" ? "pngoung" : "lukprae";
let clock = Date.now() - 3 * 86_400_000;
const db = memoryDb({ now: () => (clock += 45_000) });
db.createOperator({ username: "fixture-owner", passHash: hashPassword("fixture-owner-pass-123"), displayName: "เจ้าของ (จำลอง)", role: "owner" });
db.createOperator({ username: "fixture-staff", passHash: hashPassword("fixture-staff-pass-123"), displayName: "ทีมงาน (จำลอง)", role: "operator" });

const room = "fixture-lessons-room";
db.upsertCustomer(room, { displayName: "ลูกค้าตัวอย่าง — ข้อมูลจำลอง" });
const say = (direction, content, extra = {}) => db.insertMessage({ customerId: room, direction, content, ...(direction === "out" ? { agentMode: "ai" } : {}), ...extra });
say("in", "สวัสดีค่ะ สนใจคลาส AI สำหรับเจ้าของธุรกิจค่ะ");
say("out", "สวัสดีค่ะ ยินดีดูแลนะคะ ตอนนี้ใช้ AI ในงานระดับไหนอยู่คะ");
say("in", "มีที่จอดรถไหมคะ");
const parkingReply = say("out", "มีค่ะ จอดได้ที่ลานจอดด้านหน้าอาคารนะคะ");

const lesson = (row) => db.addOwnerLesson({ teachingKey: lessonTeachingKey(row.teaching), ...row });
const parking = lesson({
  topic: "ที่จอดรถ", teaching: "บอกว่าจอดได้ที่อาคารเรียนชั้น B1 ฟรี 3 ชั่วโมง แล้วถามต่อว่ามากันกี่ท่าน",
  customerText: "มีที่จอดรถไหมคะ", aiText: "มีค่ะ จอดได้ที่ลานจอดด้านหน้าอาคารนะคะ",
  status: "active", createdBy: "fixture-owner", sourceMessageId: parkingReply, customerId: room,
});
const onlinePrice = lesson({
  topic: "ถามราคาคลาสออนไลน์", teaching: "เล่าก่อนว่าคลาสออนไลน์ได้อะไร 2-3 ข้อ แล้วค่อยบอกราคาตามตารางที่อนุมัติ",
  customerText: "คลาสออนไลน์ราคาเท่าไหร่คะ", aiText: "ราคา 12,900 บาทค่ะ", status: "active", createdBy: "fixture-owner",
});
lesson({
  topic: "ขอส่วนลด", teaching: "ถ้าลูกค้าขอลดราคา ขอบคุณที่สนใจ แล้วบอกว่าราคาโปรเป็นราคาที่ดีที่สุดแล้ว ไม่ต้องขอโทษ",
  customerText: "ลดได้อีกไหมคะ", aiText: "ขอโทษนะคะ ลดเพิ่มไม่ได้แล้วค่ะ", status: "pending", createdBy: "fixture-staff",
});
const off = lesson({ topic: "คำลงท้าย", teaching: "ห้ามลงท้ายว่า นะจ๊ะ ให้ใช้ ค่ะ/นะคะ ตามปกติ", status: "active", createdBy: "fixture-owner" });
db.setOwnerLessonEnabled(off.id, false, "fixture-owner");
for (let i = 0; i < 14; i += 1) db.bumpOwnerLessonUse([parking.id]);
for (let i = 0; i < 6; i += 1) db.bumpOwnerLessonUse([onlinePrice.id]);

say("in", "แล้วคลาสออนไลน์ราคาเท่าไหร่คะ");
say("out", "คลาสออนไลน์เรียนสดผ่าน Zoom ได้ลงมือทำ AI Agent ของธุรกิจตัวเอง และดูคลิปย้อนหลังได้ค่ะ", { metadata: { ownerLessons: [onlinePrice.id, parking.id] } });
say("out", "ราคาตามตารางคือ 12,900 บาทค่ะ สนใจรอบไหนดีคะ", { metadata: { ownerLessons: [onlinePrice.id, parking.id] } });

const app = createApp({
  config: testConfig({
    CONSOLE_SESSION_SECRET: "fixture-lessons-console-secret-123456", TEACH_ENABLED: "true",
    CONSOLE_BRAND_NAME: "พี่ง้วง - ติดกระดุม", CONSOLE_BRAND_MARK: "พง", CONSOLE_BRAND_AGENT: "ลูกแพร AI", CONSOLE_BRAND_THEME: theme,
  }),
  db, logger: { log() {}, warn() {}, error() {}, debug() {} },
  overrides: { lineFetch: lineFetchStub(), hermesFetch: hermesFetchStub(), sleep: async () => {} },
});
app.server.listen(port, "127.0.0.1", () => console.log(`Synthetic lessons preview (${theme}): http://127.0.0.1:${port}/console/#/c/${room}`));
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => app.server.close(() => db.close()));
