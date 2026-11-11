// ownerReviewFixture.mjs — ของใช้ร่วมของเทสต์ห้องตรวจของพี่ง้วง (owner-review-*.test.mjs) — ไม่มีเทสต์ในไฟล์นี้
// ข้อความลูกค้าทุกบรรทัดเป็นประโยคสังเคราะห์ · ไม่มีการเรียก provider จริง (Luna/LINE เป็นของปลอมทั้งหมด)
import { memoryDb } from "./helpers.mjs";
import { createOfftopicCloser } from "../src/offtopicClose.mjs";
import { QUALIFY_SWEEP_MODE_KEY } from "../src/notQualified.mjs";

export const LUNA_PRICING = Object.freeze([{ id: "gpt-5.6-luna", inUsdPerM: 0.4, outUsdPerM: 1.6, verified: true }]);
export const silentLogger = Object.freeze({ info() {}, warn() {}, log() {}, error() {}, debug() {} });

/** เวลาไทย (+7) ของวันที่ 12 ต.ค. 2026 → epoch ms */
export const bkk = (hour, minute = 0, day = 12) => Date.UTC(2026, 9, day, hour - 7, minute);

const USAGE = Object.freeze({ prompt_tokens: 900, completion_tokens: 40 });

/**
 * Luna ปลอม — offtopicCheck = ดอกที่ 2 (judge) · ownerReviewCheck = อ่านท่าที
 * judge/screen เป็นค่าคงที่หรือฟังก์ชัน (args) => verdict · ส่ง { failed: true } = ล้ม
 */
export function fakeHermes({ judge = { close: true, category: "ask_money", reason: "ขอเงินจากเรา ไม่ได้มาเรียน" },
  screen = { propose: false, category: "", reason: "" } } = {}) {
  const calls = { judge: [], screen: [] };
  const answer = (value, args) => {
    const verdict = typeof value === "function" ? value(args) : value;
    if (verdict && verdict.failed) return { failed: true, retryable: true, failureClass: "http_5xx" };
    return { text: JSON.stringify(verdict), usage: USAGE, model: "gpt-5.6-luna" };
  };
  return {
    calls,
    offtopicCheck: async (args) => { calls.judge.push(args); return answer(judge, args); },
    ownerReviewCheck: async (args) => { calls.screen.push(args); return answer(screen, args); },
  };
}

/** LINE/Facebook ปลอม — เก็บทุกคำขอส่ง · fail = provider ไม่รับ */
export function fakeLineRegistry({ fail = false } = {}) {
  const sends = [];
  const client = {
    async sendBubbles(args) {
      sends.push(args);
      if (fail) return { ok: false, status: 500, reason: "http_500" };
      return { ok: true, mode: "push", calls: 1, acceptedRequestMessages: args.bubbles.map((bubble) => ({ type: "text", text: bubble.text })) };
    },
  };
  return { sends, forChannel: () => client, rawUserId: (id) => String(id).split(":").at(-1) };
}

/** โลกทดสอบ: ฐาน + นาฬิกา + ตัวตีจบจริง (Luna ปลอม) · ตัวกวาดคัดกรอง on เป็นค่าเริ่มต้น */
export function makeWorld({ start = bkk(9, 5), sweep = "on", judge, screen } = {}) {
  const clock = { t: start };
  const db = memoryDb({ now: () => clock.t });
  if (sweep) db.setSetting(QUALIFY_SWEEP_MODE_KEY, sweep);
  const hermes = fakeHermes({ judge, screen });
  const closer = createOfftopicCloser({ config: {}, db, hermes, logger: silentLogger, now: () => clock.t, modelPricing: LUNA_PRICING });
  // ข้อความ ณ เวลาที่ระบุ (ฐานใช้นาฬิกาเดียวกัน)
  const say = (customerId, direction, content, at = clock.t, extra = {}) => {
    const keep = clock.t;
    clock.t = at;
    try {
      return String(db.insertMessage({ customerId, direction, content, agentMode: direction === "out" ? "ai" : null, ...extra }));
    } finally {
      clock.t = keep;
    }
  };
  const room = (id, { name = "สมชาย ใจดีมาก", channelId = "default", turns = [] } = {}) => {
    db.upsertCustomer(id, { displayName: name, channelId });
    let last = "";
    for (const [direction, content, at] of turns) last = say(id, direction, content, at);
    return last;
  };
  return { clock, db, hermes, closer, say, room };
}
