// ทักเบา ๆ หนึ่งครั้งหลังส่งเลขบัญชี (คำสั่งพี่ง้วง 28 ก.ย. 2026 "ขอแบบละมุนที่สุดครับ") — ส่วนที่เป็น pure
import test from "node:test";
import assert from "node:assert/strict";
import {
  PAYMENT_GENTLE_NUDGE_KEY, classifyAfterBank, evaluatePaymentNudge, paymentGentleNudgeEnabled,
  paymentGentleNudgeMode, paymentNudgeText, planPaymentNudge,
} from "../src/paymentGentleNudge.mjs";
import { FB_MESSAGING_WINDOW_MS } from "../src/db.mjs";
import { inQuietHours } from "../src/followupEngine.mjs";
import { bangkokIsoDate } from "../src/followupTiming.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const bkk = (day, hour, minute = 0) => Date.UTC(2026, 8, day, hour - 7, minute, 0); // ก.ย. 2026 เวลาไทย
const hm = (ts) => new Date(ts + 7 * HOUR).toISOString().slice(11, 16);
const LINE = "U0123456789abcdef0123456789abcdef";
const FB = "facebook:112233445566";

test("สวิตช์ payment_gentle_nudge: ไม่มีแถว = on · off = ปิด · อ่านพัง = off", () => {
  const dbWith = (value) => ({ getSetting: (key) => (key === PAYMENT_GENTLE_NUDGE_KEY ? value : null) });
  assert.equal(paymentGentleNudgeMode(dbWith(null)), "on");
  assert.equal(paymentGentleNudgeMode(dbWith("OFF")), "off");
  assert.equal(paymentGentleNudgeMode({ getSetting: () => { throw new Error("db"); } }), "off");
  assert.equal(paymentGentleNudgeEnabled(dbWith(null)), true);
  assert.equal(paymentGentleNudgeEnabled(dbWith("off")), false);
});

test("ข้อความหลังส่งบัญชี: ตอบรับ/บอกวันโอน = ยังทักได้ · สลิป/บอกว่าโอนแล้ว/ถาม/คนตอบ = ไม่ทัก", () => {
  const inbound = (content, msgType = "text") => ({ direction: "in", msg_type: msgType, content, created_at: bkk(28, 11) });
  assert.equal(classifyAfterBank(inbound("ขอบคุณค่ะ")), "ack");
  assert.equal(classifyAfterBank(inbound("[sticker]", "sticker")), "ack");
  assert.equal(classifyAfterBank(inbound("ได้ค่ะ พรุ่งนี้โอนนะคะ")), "pay_timing");
  assert.equal(classifyAfterBank(inbound("โอนแล้วค่ะ")), "payment_evidence");
  assert.equal(classifyAfterBank(inbound("แนบสลิปให้แล้วนะคะ")), "payment_evidence");
  assert.equal(classifyAfterBank(inbound("[image]", "image")), "payment_evidence");
  assert.equal(classifyAfterBank(inbound("[file]", "file")), "payment_evidence");
  assert.equal(classifyAfterBank(inbound("ต้องโอนภายในวันไหนคะ")), "other", "ถามอะไรมา = เส้นตอบปกติดูแล");
  assert.equal(classifyAfterBank(inbound("ขอใบกำกับภาษีด้วยค่ะ")), "other");
  assert.equal(classifyAfterBank({ direction: "out", message_class: "reactive", agent_mode: "ai", content: "ยินดีค่ะ" }), "ai");
  assert.equal(classifyAfterBank({ direction: "out", message_class: "reactive", agent_mode: "operator_ai_on", operator: "admin-a", content: "ได้ค่ะ" }), "human");
  assert.equal(classifyAfterBank({ direction: "out", message_class: "reactive", agent_mode: null, operator: "ทีมงาน (Business Suite)", content: "ได้ค่ะ" }), "human");
  assert.equal(classifyAfterBank({ direction: "out", message_class: "proactive", agent_mode: "ai", content: "x" }), "proactive");
});

test("LINE: ไม่มีวันโอน = วันถัดไปช่วงสาย ๆ อย่างน้อย 18 ชม. หลังส่งบัญชี (ห้ามตกช่วงเงียบ)", () => {
  const morning = planPaymentNudge({ channelId: "default", customerId: LINE, bankAt: bkk(28, 9), lastInboundAt: bkk(28, 9), lastActivityAt: bkk(28, 9) });
  assert.equal(bangkokIsoDate(morning.dueAt), "2026-09-29");
  assert.ok(hm(morning.dueAt) >= "10:00" && hm(morning.dueAt) <= "11:30");
  const afternoon = planPaymentNudge({ channelId: "default", customerId: LINE, bankAt: bkk(28, 17), lastInboundAt: bkk(28, 17), lastActivityAt: bkk(28, 17) });
  assert.equal(bangkokIsoDate(afternoon.dueAt), "2026-09-29");
  assert.ok(afternoon.dueAt - bkk(28, 17) >= 18 * HOUR && hm(afternoon.dueAt) <= "11:30");
  const evening = planPaymentNudge({ channelId: "default", customerId: LINE, bankAt: bkk(28, 20), lastInboundAt: bkk(28, 20), lastActivityAt: bkk(28, 20) });
  assert.equal(bangkokIsoDate(evening.dueAt), "2026-09-30", "ส่งบัญชีตอนหัวค่ำ = ไม่ทักเช้าพรุ่งนี้ (ยังไม่ถึง 18 ชม.)");
  for (let minute = 0; minute < 24 * 60; minute += 30) {
    const at = bkk(28, 0, minute);
    const plan = planPaymentNudge({ channelId: "default", customerId: LINE, bankAt: at, lastInboundAt: at, lastActivityAt: at });
    assert.ok(plan.dueAt - at >= 18 * HOUR && plan.dueAt - at <= 2 * DAY, `ส่งบัญชี ${hm(at)}`);
    assert.equal(inQuietHours(plan.dueAt), false);
  }
});

test("LINE: ลูกค้าบอกวันโอน = วันถัดจากวันนั้น · เกิน 7 วันนับจากส่งบัญชี = ไม่ทัก", () => {
  const base = { channelId: "default", customerId: LINE, bankAt: bkk(28, 10), lastInboundAt: bkk(28, 10), lastActivityAt: bkk(28, 10) };
  assert.equal(bangkokIsoDate(planPaymentNudge({ ...base, payHintIso: "2026-09-29" }).dueAt), "2026-09-30");
  assert.equal(bangkokIsoDate(planPaymentNudge({ ...base, payHintIso: "2026-09-30" }).dueAt), "2026-10-01", "สิ้นเดือน = วันที่ 1");
  assert.deepEqual(planPaymentNudge({ ...base, payHintIso: "2026-10-10" }), { skip: "pay_date_beyond_7_days" });
});

test("FB: 5–8 ชม. หลังข้อความล่าสุดของลูกค้าในช่วง 09:00–20:30 ไม่งั้นไม่ทัก — ทุกเวลาต้องอยู่ในหน้าต่าง 24 ชม.", () => {
  let planned = 0;
  for (let minute = 0; minute < 24 * 60; minute += 30) {
    const at = bkk(28, 0, minute);
    const plan = planPaymentNudge({ channelId: "facebook", customerId: FB, bankAt: at, lastInboundAt: at, lastActivityAt: at });
    if (plan.skip) {
      assert.equal(plan.skip, "fb_no_daytime_slot", `เงียบ ${hm(at)}`);
      continue;
    }
    planned += 1;
    assert.ok(plan.dueAt - at >= 5 * HOUR && plan.dueAt - at <= 8 * HOUR, `เงียบ ${hm(at)} → ${hm(plan.dueAt)}`);
    assert.ok(plan.dueAt - at < FB_MESSAGING_WINDOW_MS - 30 * MIN);
    assert.equal(inQuietHours(plan.dueAt), false, `เงียบ ${hm(at)} → ${hm(plan.dueAt)}`);
    assert.ok(hm(plan.dueAt) <= "20:30");
  }
  assert.ok(planned >= 20, "ช่วงกลางวันส่วนใหญ่ต้องได้ช่อง");
  assert.deepEqual(planPaymentNudge({ channelId: "facebook", customerId: FB, bankAt: bkk(28, 17), lastInboundAt: bkk(28, 17), lastActivityAt: bkk(28, 17) }),
    { skip: "fb_no_daytime_slot" }, "ลูกค้าเงียบตอน 17:00 = ช่วง 5–8 ชม. ตกกลางคืนทั้งหมด = ไม่ตาม");
  assert.deepEqual(planPaymentNudge({ channelId: "facebook", customerId: FB, bankAt: bkk(28, 10), lastInboundAt: bkk(28, 10), lastActivityAt: bkk(28, 10), payHintIso: "2026-09-30" }),
    { skip: "customer_named_later_date" }, "บอกวันโอนที่ไกลกว่าหน้าต่าง = ไม่ทักก่อนวันของเขา");
});

const BANNED = /รีบ|ด่วน|ใกล้เต็ม|เหลือน้อย|เหลือ\s*\d+\s*ที่|หมดเขต|ภายใน(?:วัน|วันที่)|ก่อนวันที่|จอง(?:ที่)?ไว้ให้|กันที่|ล็อกที่|ทวง|ค้างชำระ|ยอด|บาท|เลข(?:ที่)?บัญชี|พร้อมเพย์|\d{3,}/u;

test("ข้อความ: หนึ่งข้อความ คำถามนุ่มข้อเดียว ไม่มียอด/เลขบัญชี/เส้นตาย/คำเร่ง ไม่อ้างว่ากันที่นั่ง", () => {
  for (const customerId of [LINE, FB, "U-a", "U-b", "U-c", "U-d"]) {
    for (const roundShort of ["", "10 ต.ค."]) {
      for (const name of ["", "คุณเอ"]) {
        const text = paymentNudgeText({ customerId, bankAt: bkk(28, 10), name, roundShort });
        assert.doesNotMatch(text, BANNED, text);
        assert.match(text, /ช่วยเพิ่มเติมเรื่องการสมัคร/u);
        assert.match(text, /สลิป/u);
        assert.match(text, /ทีมงาน(?:จะ)?ยืนยันที่นั่ง/u, "ทีมงานเป็นคนยืนยัน ไม่ใช่ลูกแพร");
        assert.equal((text.match(/ไหมคะ|\?/gu) || []).length, 1, text);
        assert.equal(text.includes("\n"), false, "ข้อความเดียว");
        if (roundShort) assert.match(text, /รอบ 10 ต\.ค\./u);
        if (name) assert.match(text, /คุณเอ/u); else assert.doesNotMatch(text, /คุณ/u);
      }
    }
  }
});

const customer = (extra = {}) => ({
  line_user_id: LINE, channel_id: "default", ai_enabled: 1, deal_status: "awaiting_payment", do_not_disturb: 0, followup_enabled: 0,
  marketing_consent: 0, followup_suppression_reason: "", handoff_summary: "", service_boundary_json: "", ai_off_reason: "", ...extra,
});
const BANK_AT = bkk(28, 10);
const bankBlock = { direction: "out", message_class: "reactive", agent_mode: "ai", msg_type: "text", created_at: BANK_AT - 5_000,
  content: "สรุปคลาส AI Agent for Business รอบ 10 ต.ค. ค่ะ\nโอนได้ที่บัญชีบริษัทตามนี้ค่ะ" };
const ROUNDS = [{ date: "2026-10-10", classKey: "basic", label: "Classroom AI Agent for Business", product: "AI Agent for Business", fileStatus: "open", thai: "10 ต.ค. 2026", seatsLeft: null }];
const evaluate = (extra = {}) => evaluatePaymentNudge({
  customer: customer(extra.customer), bankAt: BANK_AT, nowMs: extra.nowMs ?? bkk(29, 12),
  messages: [bankBlock, ...(extra.messages ?? [])], attempt: extra.attempt ?? null,
  tagSilenced: extra.tagSilenced ?? false, holdActive: extra.holdActive ?? false, rounds: ROUNDS,
});

test("ประเมิน: ถึงเวลา = due พร้อมรอบจากบล็อกบัญชี · ยังไม่ถึง = wait · ทำไปแล้ว = done", () => {
  const due = evaluate();
  assert.equal(due.status, "due");
  assert.equal(due.roundShort, "10 ต.ค.");
  assert.equal(bangkokIsoDate(due.dueAt), "2026-09-29");
  assert.equal(evaluate({ nowMs: bkk(28, 20) }).status, "wait");
  assert.equal(evaluate({ attempt: { status: "settled" } }).status, "done");
  assert.equal(evaluate({ attempt: { status: "sending" } }).status, "done");
  const afterAck = evaluate({ messages: [{ direction: "in", msg_type: "text", content: "ขอบคุณค่ะ พรุ่งนี้โอนนะคะ", created_at: BANK_AT + 5 * MIN },
    { direction: "out", message_class: "reactive", agent_mode: "ai", msg_type: "text", content: "ยินดีค่ะ", created_at: BANK_AT + 6 * MIN }], nowMs: bkk(30, 12) });
  assert.equal(afterAck.status, "due");
  assert.equal(bangkokIsoDate(afterAck.dueAt), "2026-09-30", "บอกวันโอนหลังรับบัญชี = วันถัดจากวันนั้น");
});

// ผู้ตรวจโค้ด 28 ก.ย.: ห้องที่ช่องเวลาผ่านไปนานแล้ว (ส่งบัญชีก่อนเปิดฟีเจอร์ / เปิดสวิตช์กลับหลังปิดหลายวัน /
// เซิร์ฟเวอร์ดับนาน) ต้องไม่ถูกยิงรวดเดียวตอนเปิด — เลยช่องเกิน 2 ชม. = ข้ามถาวร ไม่ใช่ทักผิดเวลา
test("ประเมิน: เลยเวลาที่วางไว้เกิน 2 ชม. = ข้าม (slot_missed) ไม่ยิงย้อนหลังเป็นกอง", () => {
  const due = evaluate();
  assert.equal(evaluate({ nowMs: due.dueAt + 2 * HOUR - MIN }).status, "due", "ช้าเล็กน้อย (เช่น restart) ยังส่งได้");
  const late = evaluate({ nowMs: due.dueAt + 2 * HOUR + MIN });
  assert.equal(late.status, "skip");
  assert.equal(late.reason, "slot_missed");
  assert.equal(evaluate({ nowMs: BANK_AT + 3 * 24 * HOUR }).reason, "slot_missed", "ห้องค้างก่อนเปิดฟีเจอร์ = ไม่ทัก");
});

test("ประเมิน: เหตุไม่ทักถาวร (ลูกค้าถาม · คนตอบ · หลักฐานโอน · ดีลเปลี่ยน · AI ปิด · ขอพัก · ป้ายเงียบ · รอบผ่านไป)", () => {
  const skip = (extra) => { const out = evaluate(extra); assert.equal(out.status, "skip"); return out.reason; };
  assert.equal(skip({ messages: [{ direction: "in", msg_type: "text", content: "ต้องโอนภายในวันไหนคะ", created_at: BANK_AT + MIN }] }), "customer_replied");
  assert.equal(skip({ messages: [{ direction: "out", message_class: "reactive", agent_mode: "operator_ai_on", operator: "admin-a", msg_type: "text", content: "ได้ค่ะ", created_at: BANK_AT + MIN }] }), "human_replied");
  assert.equal(skip({ messages: [{ direction: "in", msg_type: "image", content: "[image]", created_at: BANK_AT + MIN }] }), "payment_evidence");
  assert.equal(skip({ customer: { deal_status: "paid_confirmed" } }), "deal_moved");
  assert.equal(skip({ customer: { ai_enabled: 0 } }), "ai_off");
  assert.equal(skip({ customer: { do_not_disturb: 1 } }), "opted_out");
  assert.equal(skip({ customer: { marketing_consent: -1 } }), "opted_out");
  assert.equal(skip({ customer: { followup_suppression_reason: "customer_considering" } }), "customer_deferred");
  assert.equal(skip({ tagSilenced: true }), "tag_silenced");
  assert.equal(skip({ customer: { followup_enabled: 1 } }), "regular_followup_on", "ทีมเปิดบันไดปกติกลับเอง = ไม่ทักซ้อน");
  assert.equal(skip({ holdActive: true }), "payment_in_human_review");
  const withNotes = (notes) => evaluatePaymentNudge({ customer: customer(), bankAt: BANK_AT, nowMs: bkk(29, 12), messages: [bankBlock],
    attempt: null, tagSilenced: false, holdActive: false, rounds: ROUNDS, notes });
  assert.equal(withNotes([{ author: "admin-a", created_at: BANK_AT + HOUR }]).reason, "human_note", "ทีมจดโน้ตหลังคุยใน LINE OA = คนดูแลอยู่");
  assert.equal(withNotes([{ author: "ai_promise", created_at: BANK_AT + HOUR }]).status, "due", "โน้ตของระบบไม่นับ");
  assert.equal(withNotes([{ author: "admin-a", created_at: BANK_AT - HOUR }]).status, "due", "โน้ตก่อนส่งบัญชีไม่นับ");
  const passed = evaluatePaymentNudge({ customer: customer(), bankAt: BANK_AT, nowMs: bkk(29, 12), messages: [bankBlock], attempt: null,
    tagSilenced: false, holdActive: false, rounds: [{ ...ROUNDS[0], date: "2026-09-29", thai: "29 ก.ย. 2026" }] });
  assert.equal(passed.status, "due", "รอบในบล็อกไม่อยู่ในรายการรอบปัจจุบัน = ไม่ระบุรอบ (ข้อความทั่วไป)");
  assert.equal(passed.roundShort, "");
  const roundToday = { ...bankBlock, content: "สรุปคลาสรอบ 29 ก.ย. ค่ะ โอนได้ตามนี้ค่ะ" };
  const sameDay = evaluatePaymentNudge({ customer: customer(), bankAt: BANK_AT, nowMs: bkk(29, 12), messages: [roundToday], attempt: null,
    tagSilenced: false, holdActive: false, rounds: [{ ...ROUNDS[0], date: "2026-09-29", thai: "29 ก.ย. 2026" }] });
  assert.equal(sameDay.status, "skip");
  assert.equal(sameDay.reason, "round_passed", "รอบเรียนคือวันทักพอดี = ไม่ทักเรื่องสมัคร");
});
