// hot-followup-rate.test.mjs — ตัวชี้วัด "ทีมทักต่อลูกค้าร้อนกี่ %" (29 ก.ย. 2026)
// พี่ง้วง: "แอดมินจริง ๆ ได้ขุดลูกค้าบ่อยมั้ย % rate กี่ %" — ของจริง 30 วัน: ห้อง HOT ที่ทีมเคยพิมพ์ "สักครั้ง" 50%
// แต่หลังลูกแพรตอบแล้วลูกค้าเงียบเกินวัน ทีมกลับไปทักต่อแค่ 5% → ตัวชี้วัดต้องวัดหลัง AI จบ ไม่ใช่ "เคยพิมพ์"
import test from "node:test";
import assert from "node:assert/strict";
import { summarizeHotFollowupRate } from "../src/hotFollowupRate.mjs";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const now = Date.UTC(2026, 8, 30, 2, 0, 0);

function build(spec) {
  const rooms = [];
  const messages = [];
  const scores = [];
  for (const [id, { channel = "default", score = 9, tagAgo = null, resolvedAgo = null, deal = "", msgs }] of Object.entries(spec)) {
    rooms.push({
      id, channel_id: channel, last_score: score, state: resolvedAgo == null ? "AI_ACTIVE" : "RESOLVED", deal_status: deal,
      resolved_at: resolvedAgo == null ? 0 : now - resolvedAgo, customer_tag_at: tagAgo == null ? null : now - tagAgo,
    });
    scores.push({ customer_id: id, score, created_at: now - 20 * DAY });
    // [ทิศทาง, กี่นาทีก่อน, คน(1)/ลูกแพร(0), ชนิด] — ขาเข้าปกติ = คำถาม · "ack" = ขอบคุณ · "proactive" = ข้อความทวงของลูกแพร
    for (const [direction, ago, human = 0, kind = ""] of msgs) {
      messages.push({
        customer_id: id, direction, created_at: now - ago, human,
        reactive: direction === "out" && kind !== "proactive" ? 1 : 0,
        type: direction === "in" ? "text" : null,
        text: direction === "in" ? (kind === "ack" ? "ขอบคุณค่ะ" : "สนใจคลาสค่ะ มีรอบไหนบ้าง") : null,
      });
    }
  }
  messages.sort((a, b) => a.customer_id.localeCompare(b.customer_id) || a.created_at - b.created_at);
  return { rooms, messages, scores };
}

test("นับเฉพาะห้องร้อนที่ 'จบที่ลูกแพร' แล้วค้างครบวัน — ผลแยก ทีมทัก/ลูกค้ากลับมาเอง/FB หลุด/ยังค้าง (กดเสร็จสิ้นไม่มีผล)", () => {
  const data = build({
    A_touched: { msgs: [["in", 5 * DAY], ["out", 5 * DAY - MIN], ["out", 3 * DAY, 1]] },
    B_fb_lost: { channel: "facebook", msgs: [["in", 7.5 * DAY], ["out", 7.5 * DAY - MIN]] },
    C_came_back: { msgs: [["in", 4 * DAY], ["out", 4 * DAY - MIN], ["in", 5 * HOUR], ["out", 5 * HOUR - MIN]] },
    D_same_day_human: { msgs: [["in", 3 * DAY], ["out", 3 * DAY - MIN], ["out", 2.9 * DAY, 1]] },
    E_closed: { resolvedAgo: 0.5 * DAY, msgs: [["in", 2 * DAY], ["out", 2 * DAY - MIN]] },
    F_warm: { score: 6, msgs: [["in", 2 * DAY], ["out", 2 * DAY - MIN]] },
    G_buyer: { tagAgo: 10 * DAY, msgs: [["in", 3 * DAY], ["out", 3 * DAY - MIN]] },
    H_pending: { msgs: [["in", 1.5 * DAY], ["out", 1.5 * DAY - MIN]] },
    I_too_fresh: { msgs: [["in", 10 * HOUR], ["out", 10 * HOUR - MIN]] },
    J_human_first: { msgs: [["in", 3 * DAY], ["out", 3 * DAY - MIN, 1]] },
    // รีวิวโค้ด 29 ก.ย.: ข้อความทวงอย่างเดียวไม่ใช่ "ลูกแพรตอบ" (= คิวรอตอบ) · ขอบคุณหลังคำตอบยังค้าง
    // · 30 ก.ย. กดเสร็จสิ้นไม่ทำให้ห้องหาย = ยังค้าง · ยังค้างแต่ตอนนี้ซื้อแล้ว = หลุดรายการ ไม่ใช่ห้องที่ทีมพลาด
    K_proactive_only: { msgs: [["in", 4 * DAY], ["out", 2 * DAY, 0, "proactive"]] },
    L_ack_after: { msgs: [["in", 3 * DAY], ["out", 3 * DAY - MIN], ["in", 2 * DAY, 0, "ack"]] },
    M_closed_same_day: { resolvedAgo: 2.5 * DAY, msgs: [["in", 3 * DAY], ["out", 3 * DAY - MIN]] },
    N_paid_now: { deal: "paid", msgs: [["in", 3 * DAY], ["out", 3 * DAY - MIN]] },
  });
  const rate = summarizeHotFollowupRate(data, { now });
  assert.deepEqual(
    { entered: rate.entered, touched: rate.touched, cameBack: rate.cameBack, lost: rate.lost, pending: rate.pending },
    { entered: 7, touched: 1, cameBack: 1, lost: 1, pending: 4 },
    "C: ลูกค้ากลับมาเองเมื่อ 5 ชม. ก่อน รอบใหม่ยังไม่ครบวัน = นับรอบก่อน (กลับมาเอง) · D/J: คนเข้ามาทันในวันนั้น ไม่เคยเข้ารายการ",
  );
  assert.equal(rate.ratePct, 14, "1 จาก 7 ห้อง (E กดเสร็จสิ้น + H + L + M กดเสร็จสิ้นวันแรก ยังค้างทั้งหมด)");
  assert.equal(rate.closed, undefined, "ไม่มีผล 'ปิดเคส' แล้ว — ห้องออกได้ทางเดียวคือคนทัก");
  assert.equal(rate.windowDays, 7);
});

test("ห้องเดียวหลายรอบในช่วง = นับครั้งเดียวตามรอบล่าสุด · ไม่มีห้องเข้ารายการ = ไม่มีเปอร์เซ็นต์", () => {
  const twice = build({
    R: { msgs: [["in", 6 * DAY], ["out", 6 * DAY - MIN], ["out", 4.5 * DAY, 1], ["in", 3 * DAY], ["out", 3 * DAY - MIN]] },
  });
  const rate = summarizeHotFollowupRate(twice, { now });
  assert.equal(rate.entered, 1);
  assert.equal(rate.pending, 1, "รอบล่าสุดยังไม่มีใครทัก");
  const empty = summarizeHotFollowupRate({ rooms: [], messages: [], scores: [] }, { now });
  assert.equal(empty.entered, 0);
  assert.equal(empty.ratePct, null);
});
