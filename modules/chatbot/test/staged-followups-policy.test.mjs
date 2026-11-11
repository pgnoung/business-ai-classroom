// staged-followups-policy.test.mjs — รีวิวเคสจริง 6–7 ต.ค. (รอบรีวิว 8 · นโยบายทักตามที่เจนเคาะ) ผ่านเครื่องทักตามจริง (สมองจำลอง ไม่มี network)
// จำลองช่วงเงียบทีละชั่วโมง 8 วันของห้อง hot/warm/cold: ปฏิเสธ/ปิดห้อง/เงินตึง/รู้สึกโดนตื๊อ/ดูแลใจ = 0 · ขอเวลาคิด = 1 (วันถัดไป/วันที่ 3)
// · รอปรึกษา = 1 (วันที่ 2–3) · รอเงินเดือน = 1 (วันที่ 3–7) · เงียบเฉย ๆ = ไม่เกิน 2 (ห่าง ≥20 ชม. ครั้งที่สองคนละเรื่อง)
// · badge คอนโซลบอกเวลาเดียวกับที่ยิงจริง · ร่างกว้าง ๆ ไม่ค้างบันได · ขั้นสมัคร = คำถามอย่างเดียว — ข้อความทุกบรรทัดเป็นประโยคสังเคราะห์
import test from "node:test";
import assert from "node:assert/strict";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createStagedFollowups, followupThreadPickFor, previewStagedFollowup } from "../src/stagedFollowups.mjs";
import { inQuietHours } from "../src/followupEngine.mjs";
import { poisonGlobalFetch, testConfig, memoryDb } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 0, 13, 4, 0, 0); // อังคาร 11:00 เวลาไทย
const CARD = "📌 AI Agent for Business\nราคาปกติ 19,900 บาท\nโปรโมชั่น Early Bird 12,900 บาท/ท่าน";
const LADDER = "สวัสดีค่ะ ลูกแพรเป็นผู้ช่วยของพี่ง้วงค่ะ\n\nไม่ทราบว่าเคยใช้ AI มาประมาณ ระดับที่เท่าไหร่แล้วคะ ?\n\n1️⃣ ยังไม่เคยใช้เลย\n\n2️⃣ เคยลองเล่นนิดหน่อย";
const v3 = (stage, extra = {}) => ({ replyEngine: { engine: "v3", promptVersion: "v3.6", stage, stageReason: extra.reason || "x", modifiers: extra.modifiers || [],
  ...(extra.stop ? { followupStop: extra.stop } : {}) } });
const REVIEWS = "[Classroom : AI Agent for Business]\n- ผู้เรียนหลากหลายธุรกิจ | รีวิว: https://www.facebook.com/share/r/general1/\n- เจ้าของร้านออนไลน์ | รีวิว: https://www.facebook.com/share/r/shop2/";

function world({ score, drafts = null, replyEngine = "v3", channelId = "default", t0 = START }) {
  const clock = { now: t0 };
  const config = testConfig({ STAGED_FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_TICK_MS: "0" });
  const db = memoryDb({ now: () => clock.now });
  if (replyEngine) db.setSetting("reply_engine", replyEngine);
  const calls = [];
  const hermesFetch = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const text = drafts ? drafts[Math.min(calls.length - 1, drafts.length - 1)] : `ระหว่างรอบที่ลูกแพรบอกไว้ รอบไหนสะดวกกว่ากันคะ (${calls.length})`;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }) };
  };
  const hermes = createHermesBridge({ config, fetchImpl: hermesFetch, logger: silent, getReplyModel: () => config.hermesModel, getFollowupModel: () => "" });
  const pushes = [];
  const lineCh = { sendBubbles: async (args) => { pushes.push({ at: clock.now, bubbles: args.bubbles.map((b) => b.text), images: args.images || [] }); return { ok: true }; } };
  const engine = createStagedFollowups({ config, db, hermes, lineRegistry: { forChannel: () => lineCh, rawUserId: (id) => id },
    guard: createComplianceGuard({ bannedWords: [], getApprovedPrices: () => db.approvedPrices() }), humanizer: createHumanizer(), logger: silent,
    now: () => clock.now, imageCatalog: [{ key: "classroom-atmosphere-1", url: "https://x.invalid/a1.jpg", preview_url: "https://x.invalid/a1p.jpg" }] });
  const id = channelId === "facebook" ? "facebook:policy" : "U-policy";
  db.upsertCustomer(id, { displayName: "", channelId });
  db.setFollowupEnabled(id, true);
  db.recordScore(id, score, "{}");
  db.addKnowledge({ title: "รีวิวนักเรียนจริง", updatedBy: "fixture", content: REVIEWS });
  const msg = (direction, content, atMs, metadata = {}, operator = "") => {
    const mid = `m-${Math.random().toString(36).slice(2)}`;
    db.insertMessage({ id: mid, customerId: id, direction, msgType: "text", content, metadata, messageClass: "reactive", operator });
    db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(atMs, mid);
  };
  const preview = () => {
    const customer = { ...db.getCustomer(id), line_user_id: id };
    return previewStagedFollowup({
      customer, state: db.getFollowupState(id), lastInboundAt: db.lastInboundAt(id), lastOutboundAt: db.lastOutboundAt(id), nowMs: clock.now,
      delays: { cold: config.stagedColdDelayMs ?? HOUR, warm: config.stagedWarmDelayMs ?? 30 * MIN, hot: config.stagedHotDelayMs ?? 30 * MIN },
      threadPick: ({ history }) => followupThreadPickFor({ db, config, customer, history, nowMs: clock.now }),
    });
  };
  return { clock, db, engine, pushes, calls, id, msg, preview, config, t0 };
}

// ห้องที่เห็นราคาแล้ว + ชวนเลือกรอบ ตามด้วยคำตอบลูกค้า (หรือไม่มี) และคำตอบของลูกแพร
const SCENES = {
  silent: (w) => {
    w.msg("in", "ค่าเรียนเท่าไหร่คะ", w.t0 - 30 * MIN);
    w.msg("out", `ค่าเรียนรวม Workshop และทีม TA แล้วค่ะ\n${CARD}\nสะดวกรอบ เสาร์ 10 ต.ค. หรือ เสาร์ 17 ต.ค. ดีคะ?`, w.t0 - 29 * MIN, v3("PRICE", { reason: "money_ask" }));
  },
  defer: (w) => {
    w.msg("in", "ค่าเรียนเท่าไหร่คะ", w.t0 - 40 * MIN);
    w.msg("out", `ค่าเรียนรวม Workshop และทีม TA แล้วค่ะ\n${CARD}\nสะดวกรอบ เสาร์ 10 ต.ค. หรือ เสาร์ 17 ต.ค. ดีคะ?`, w.t0 - 39 * MIN, v3("PRICE"));
    w.msg("in", "ขอคิดดูก่อนนะคะ", w.t0 - 30 * MIN);
    w.msg("out", "ได้เลยค่ะ ค่อย ๆ คิดได้เลยนะคะ 😊", w.t0 - 29 * MIN, v3("GOODBYE", { reason: "closing_words", stop: "defer" }));
  },
  consult: (w) => {
    w.msg("in", "ค่าเรียนเท่าไหร่คะ", w.t0 - 40 * MIN);
    w.msg("out", `ค่าเรียนรวม Workshop และทีม TA แล้วค่ะ\n${CARD}\nสะดวกรอบ เสาร์ 10 ต.ค. หรือ เสาร์ 17 ต.ค. ดีคะ?`, w.t0 - 39 * MIN, v3("PRICE"));
    w.msg("in", "ขอปรึกษาแฟนก่อนนะคะ", w.t0 - 30 * MIN);
    w.msg("out", "ได้เลยค่ะ ปรึกษากันให้สบายใจก่อนนะคะ 😊", w.t0 - 29 * MIN, v3("GOODBYE", { reason: "care_moment", stop: "care:waiting" }));
  },
  money_wait: (w) => {
    w.msg("in", "ค่าเรียนเท่าไหร่คะ", w.t0 - 40 * MIN);
    w.msg("out", `ค่าเรียนรวม Workshop และทีม TA แล้วค่ะ\n${CARD}\nสะดวกรอบ เสาร์ 10 ต.ค. หรือ เสาร์ 17 ต.ค. ดีคะ?`, w.t0 - 39 * MIN, v3("PRICE"));
    w.msg("in", "รอเงินเดือนออกก่อนนะคะ", w.t0 - 30 * MIN);
    w.msg("out", "ได้เลยค่ะ ไม่ต้องรีบนะคะ 😊", w.t0 - 29 * MIN, v3("GOODBYE", { reason: "care_moment", stop: "care:waiting" }));
  },
  decline: (w) => {
    w.msg("in", "ค่าเรียนเท่าไหร่คะ", w.t0 - 40 * MIN);
    w.msg("out", `ค่าเรียนรวม Workshop และทีม TA แล้วค่ะ\n${CARD}\nสะดวกรอบ เสาร์ 10 ต.ค. หรือ เสาร์ 17 ต.ค. ดีคะ?`, w.t0 - 39 * MIN, v3("PRICE"));
    w.msg("in", "ไม่สนใจค่ะ", w.t0 - 30 * MIN);
    w.msg("out", "ไม่เป็นไรเลยค่ะ ขอบคุณที่สนใจนะคะ", w.t0 - 29 * MIN, v3("OBJECTION", { stop: "declined" }));
  },
  exit: (w) => {
    w.msg("in", "กดผิดค่ะ", w.t0 - 30 * MIN);
    w.msg("out", "ไม่เป็นไรเลยค่ะ วันไหนอยากรู้เรื่องคลาส AI ทักลูกแพรมาได้เลยค่ะ", w.t0 - 29 * MIN, v3("EXIT", { reason: "wrong_click", stop: "exit:wrong_click" }));
  },
  hardship: (w) => {
    w.msg("in", "ค่าเรียนเท่าไหร่คะ", w.t0 - 40 * MIN);
    w.msg("out", `ค่าเรียนรวม Workshop และทีม TA แล้วค่ะ\n${CARD}\nสะดวกรอบ เสาร์ 10 ต.ค. หรือ เสาร์ 17 ต.ค. ดีคะ?`, w.t0 - 39 * MIN, v3("PRICE"));
    w.msg("in", "ตอนนี้ต้องยืมเงินมาเรียนค่ะ", w.t0 - 30 * MIN);
    w.msg("out", "เข้าใจเลยค่ะ ไม่อยากให้ฝืนนะคะ", w.t0 - 29 * MIN, v3("OBJECTION", { modifiers: ["money_hardship"], stop: "money_hardship" }));
  },
  pushed: (w) => {
    w.msg("in", "ค่าเรียนเท่าไหร่คะ", w.t0 - 40 * MIN);
    w.msg("out", `ค่าเรียนรวม Workshop และทีม TA แล้วค่ะ\n${CARD}\nสะดวกรอบ เสาร์ 10 ต.ค. หรือ เสาร์ 17 ต.ค. ดีคะ?`, w.t0 - 39 * MIN, v3("PRICE"));
    w.msg("in", "รู้สึกโดนตื๊อเลยค่ะ", w.t0 - 30 * MIN);
    w.msg("out", "ขอโทษนะคะ ลูกแพรจะไม่ทักรบกวนค่ะ", w.t0 - 29 * MIN, v3("GOODBYE", { reason: "care_moment", stop: "care:pressure" }));
  },
  crisis: (w) => {
    w.msg("in", "ตอนนี้คุณแม่ป่วยเข้าโรงพยาบาลค่ะ", w.t0 - 30 * MIN);
    w.msg("out", "ขอให้คุณแม่หายไว ๆ นะคะ", w.t0 - 29 * MIN, v3("GOODBYE", { reason: "care_moment", stop: "care:crisis" }));
  },
};

async function simulate(scene, score, { days = 8, drafts = null, channelId = "default", t0 = START, stepMs = HOUR } = {}) {
  const w = world({ score, drafts, channelId, t0 });
  SCENES[scene](w);
  const mismatches = [];
  let promised = null;
  for (let h = 0; h < days * 24 * HOUR / stepMs; h += 1) {
    w.clock.now = t0 + h * stepMs;
    const before = w.pushes.length;
    const badge = w.preview();
    await w.engine.processCustomer(w.db.getCustomer(w.id), w.clock.now);
    if (w.pushes.length > before && promised !== null && w.clock.now + 1 < promised) mismatches.push(`ยิง ${h}h ก่อนเวลาที่ badge บอก`);
    if (badge?.dueAt) promised = badge.dueAt;
  }
  return { w, mismatches };
}
const hoursOf = (w) => w.pushes.map((p) => (p.at - w.t0) / HOUR);

test("ปฏิเสธ · ปิดห้อง · เงินตึง · รู้สึกโดนตื๊อ · ดูแลใจ = ไม่ทักเลย และไม่เรียกโมเดล (hot/warm/cold)", async () => {
  for (const scene of ["decline", "exit", "hardship", "pushed", "crisis"]) {
    for (const score of [9, 6, 3]) {
      const { w } = await simulate(scene, score);
      assert.equal(w.pushes.length, 0, `${scene} score ${score}`);
      assert.equal(w.calls.length, 0, `${scene} score ${score}: ไม่เสียค่าโมเดล`);
      assert.match(JSON.stringify(w.preview()), /followup_stop/u, `${scene} score ${score}: badge บอกว่าหยุดตามลูกค้า`);
      w.db.close();
    }
  }
});

test("ขอเวลาคิด = ทักครั้งเดียว ข้ามไม้เร็ว (hot เช้าวันถัดไป · warm วันที่ 3 · cold วันถัดไป) คำถามอย่างเดียว ผูกกับรอบที่ยังเปิด", async () => {
  const want = { 9: [18, 30], 6: [70, 80], 3: [24, 32] };
  for (const score of [9, 6, 3]) {
    const { w, mismatches } = await simulate("defer", score);
    assert.equal(w.pushes.length, 1, `score ${score}: ${JSON.stringify(hoursOf(w))}`);
    const [h] = hoursOf(w);
    assert.ok(h >= want[score][0] && h <= want[score][1], `score ${score}: ทักที่ +${h} ชม.`);
    assert.equal(w.pushes[0].bubbles.length, 1, "คำถามอย่างเดียว ไม่มีรีวิว/รูป");
    assert.equal(w.pushes[0].images.length, 0);
    assert.match(JSON.stringify(w.calls[0].messages), /ลูกค้าขอเวลาคิดไว้ ข้อความนี้เป็นการทักครั้งเดียว/u);
    assert.deepEqual(mismatches, []);
    assert.ok(w.db.listAudit().some((a) => a.action === "staged_followup_wait"), "ข้ามไม้เร็วโดยไม่ร่าง");
    w.db.close();
  }
});

test("รอปรึกษาคนที่บ้าน = เช็กอินครั้งเดียววันที่ 2–3 (เสนอสรุปให้ส่งต่อ ไม่ชวนรอบ) · รอเงินเดือน = ครั้งเดียววันที่ 3–7", async () => {
  for (const score of [9, 6, 3]) {
    const consult = await simulate("consult", score);
    assert.equal(consult.w.pushes.length, 1, `consult ${score}: ${JSON.stringify(hoursOf(consult.w))}`);
    const [h] = hoursOf(consult.w);
    assert.ok(h >= 44 && h < 4 * 24, `consult ${score}: +${h} ชม.`);
    const prompt = JSON.stringify(consult.w.calls[0].messages);
    assert.match(prompt, /ขอปรึกษาแฟนก่อน[^"]*สรุปข้อมูลคลาสสั้น ๆ[^"]*ส่งต่อ/u);
    assert.deepEqual(consult.mismatches, []);
    consult.w.db.close();
    const money = await simulate("money_wait", score);
    assert.equal(money.w.pushes.length, 1, `money ${score}: ${JSON.stringify(hoursOf(money.w))}`);
    const [m] = hoursOf(money.w);
    assert.ok(m >= 3 * 24 - 4 && m <= 7 * 24 + 12, `money ${score}: +${m} ชม.`);
    assert.match(JSON.stringify(money.w.calls[0].messages), /ไม่เร่ง ไม่พูดเรื่องเงินหรือเงินเดือน/u);
    money.w.db.close();
  }
});

// 12 ต.ค. 2026 (พี่ง้วง "ห้องที่ได้ราคาแล้ว ทักครั้งเดียวในเช้าวันถัดไป")
test("เงียบเฉย ๆ หลังเห็นราคา: ทักครั้งเดียว เช้าวันถัดไป (09:00–10:30) ไม่ถามรอบซ้ำ · badge ตรงกับเวลายิงจริง", async () => {
  for (const score of [9, 6, 3]) {
    const { w, mismatches } = await simulate("silent", score);
    const hours = hoursOf(w);
    assert.equal(w.pushes.length, 1, `score ${score}: ${JSON.stringify(hours)}`);
    const bkk = new Date(w.pushes[0].at + 7 * HOUR);
    assert.equal(bkk.getUTCDate(), new Date(START + 7 * HOUR).getUTCDate() + 1, `score ${score}: เช้าวันถัดไป`);
    assert.ok(bkk.getUTCHours() * 60 + bkk.getUTCMinutes() >= 9 * 60 && bkk.getUTCHours() * 60 + bkk.getUTCMinutes() <= 10 * 60 + 31, `score ${score}: ${bkk.toISOString()}`);
    const history = JSON.parse(w.db.getFollowupState(w.id).history_json).filter((item) => item.thread);
    assert.deepEqual(history.map((item) => item.thread), ["round_choice"], `score ${score}`);
    assert.match(JSON.stringify(w.calls[0].messages), /ไม่ถามซ้ำว่ารอบไหน/u);
    for (const push of w.pushes) assert.ok(!inQuietHours(push.at), "ไม่ทักช่วงเงียบ");
    assert.deepEqual(mismatches, []);
    w.db.close();
  }
});

test("ร่างกว้าง ๆ (ไม่ส่ง) = ไม้นี้จบ ขยับบันได ไม่ค้าง delivery_fenced ทุกรอบ · badge ไม่ค้างไม้เดิม", async (t) => {
  const w = world({ score: 3, drafts: ["เรื่องเรียน AI ค่อย ๆ พิจารณาตามจังหวะที่สะดวกนะคะ ถ้ามีส่วนไหนอยากทราบเพิ่ม บอกลูกแพรได้เสมอค่ะ 😊"] });
  t.after(() => w.db.close());
  w.msg("in", "สนใจค่ะ", START - 4 * HOUR);
  w.msg("out", LADDER, START - 4 * HOUR + 30_000, v3("FIRST_CONTACT", { reason: "ladder_rule" }));
  const first = await w.engine.processCustomer(w.db.getCustomer(w.id), w.clock.now);
  assert.equal(first.skipped, "no_send:generic_draft");
  assert.equal(w.db.getFollowupState(w.id).ladder_stage, 1, "ขยับไปไม้ถัดไป");
  const again = await w.engine.processCustomer(w.db.getCustomer(w.id), w.clock.now + MIN);
  assert.notEqual(again.skipped, "delivery_fenced");
  const badge = w.preview();
  assert.equal(badge.step, 2);
  assert.ok(badge.dueAt > w.clock.now + 12 * HOUR, "badge บอกไม้วันถัดไป ไม่ใช่ไม้เดิม");
});

test("ไม่มีเรื่องค้าง: badge บอก 'ไม่มีเรื่องค้าง' ตั้งแต่ก่อนถึงเวลา (ไม่โชว์เวลาของไม้ที่จะไม่ยิง) และหลังจบไม่ขึ้นว่าทักครบ", async (t) => {
  const w = world({ score: 3 });
  t.after(() => w.db.close());
  w.msg("in", "เรียนกี่โมงคะ", START - 20 * MIN);
  w.msg("out", "เรียนสด 1 วัน 10:00–17:00 น. ค่ะ", START - 19 * MIN, v3("LOGISTICS"));
  assert.deepEqual(w.preview(), { blocked: "no_thread" });
  w.clock.now = START + 3 * HOUR;
  const out = await w.engine.processCustomer(w.db.getCustomer(w.id), w.clock.now);
  assert.equal(out.skipped, "no_thread:no_open_thread");
  assert.deepEqual(w.preview(), { blocked: "no_thread" });
  assert.equal(w.calls.length, 0);
});

test("ขั้นสมัคร (เลือกรอบแล้ว ลูกแพรถามชื่อออกใบเสร็จ) = คำถามอย่างเดียว ไม่มีรีวิว · ใช้ไม้หลัง ครั้งเดียว", async (t) => {
  const w = world({ score: 9, drafts: ["สะดวกใช้ชื่อส่วนตัวหรือชื่อบริษัทออกใบเสร็จคะ?"] });
  t.after(() => w.db.close());
  w.msg("in", "ค่าเรียนเท่าไหร่คะ", START - 50 * MIN);
  w.msg("out", `ค่าเรียนรวม Workshop แล้วค่ะ\n${CARD}\nสะดวกรอบ เสาร์ 10 ต.ค. หรือ เสาร์ 17 ต.ค. ดีคะ?`, START - 49 * MIN, v3("PRICE"));
  w.msg("in", "17 ค่ะ", START - 40 * MIN);
  w.msg("out", "รับทราบรอบเสาร์ 17 ต.ค. ค่ะ ทีมงานจะเป็นผู้ยืนยันที่นั่งให้นะคะ\n\nต้องการออกใบเสร็จในนามบุคคลธรรมดาหรือบริษัทคะ?", START - 39 * MIN,
    v3("LOGISTICS", { reason: "accepted_round_pick" }));
  for (let h = 0; h < 4 * 24; h += 1) {
    w.clock.now = START + h * HOUR;
    await w.engine.processCustomer(w.db.getCustomer(w.id), w.clock.now);
  }
  assert.equal(w.pushes.length, 1);
  assert.ok((w.pushes[0].at - START) / HOUR >= 18, "ไม่ใช่ไม้เร็ว +45 นาที");
  assert.deepEqual(w.pushes[0].bubbles, ["สะดวกใช้ชื่อส่วนตัวหรือชื่อบริษัทออกใบเสร็จคะ?"]);
  assert.match(JSON.stringify(w.calls[0].messages), /ลูกค้าอยู่ขั้นสมัครแล้ว/u);
});

test("ห้องที่ไม่ใช่ v3 = บันไดเดิมทุกไม้ (ไม่มีแผนเรื่องค้าง ไม่มีป้ายใหม่บน badge)", async (t) => {
  const w = world({ score: 6, replyEngine: "legacy" });
  t.after(() => w.db.close());
  SCENES.decline(w);
  for (let h = 0; h < 8 * 24; h += 1) {
    w.clock.now = START + h * HOUR;
    await w.engine.processCustomer(w.db.getCustomer(w.id), w.clock.now);
  }
  assert.ok(w.pushes.length >= 2, `บันไดเดิมยังทักห้องที่ปฏิเสธ (พฤติกรรม production) — ได้ ${w.pushes.length} ไม้`);
  for (const call of w.calls) assert.doesNotMatch(JSON.stringify(call.messages), /เรื่องที่ค้างอยู่ในห้องนี้/u);
  assert.ok(!w.db.listAudit().some((a) => ["staged_followup_no_thread", "staged_followup_wait"].includes(a.action)));
});

test("C3: badge หน้ารายการแชท (คอนโซล) ห้อง v3 ใช้แผนเดียวกับเส้นยิงจริง — ไม่มีเรื่องค้าง/ลูกค้าปิด = บอกเหตุ · ขอเวลาคิด = ไม้วันถัดไป · ห้องเครื่องเดิมเหมือนเดิม", async (t) => {
  const { createApp } = await import("../src/server.mjs");
  const { hashPassword } = await import("../src/auth.mjs");
  const { httpRequest, lineFetchStub, listen } = await import("./helpers.mjs");
  const db = memoryDb();
  db.createOperator({ username: "owner", passHash: hashPassword("policy-pass-123456"), displayName: "เจ้าของ", role: "owner" });
  const app = createApp({ config: testConfig({ CONSOLE_SESSION_SECRET: "policy-secret", STAGED_FOLLOWUP_TICK_MS: "60000", STAGED_FOLLOWUP_ENABLED: "true" }),
    db, overrides: { lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  const login = await httpRequest(app.server, { method: "POST", path: "/console/api/login", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "owner", password: "policy-pass-123456" }) });
  const cookie = login.headers["set-cookie"][0].split(";")[0];
  const badges = async () => Object.fromEntries((await httpRequest(app.server, { path: "/console/api/inbox?limit=100", headers: { cookie } })).json.conversations
    .map((row) => [row.line_user_id, row.staged_followup_preview]));
  const now = Date.now();
  const room = (id, turns) => {
    db.upsertCustomer(id, { displayName: id });
    db.setFollowupEnabled(id, true);
    db.recordScore(id, 9, "{}");
    turns.forEach(([direction, content, meta], i) => {
      const mid = `${id}-${i}`;
      db.insertMessage({ id: mid, customerId: id, direction, msgType: "text", content, metadata: meta || {}, agentMode: direction === "out" ? "ai" : null });
      db.raw.prepare("UPDATE messages SET created_at = ? WHERE id = ?").run(now - 30 * MIN + i * 60_000, mid);
    });
  };
  room("U-none", [["in", "เรียนกี่โมงคะ"], ["out", "เรียนสด 1 วัน 10:00–17:00 น. ค่ะ", v3("LOGISTICS")]]);
  room("U-bye", [["in", "ขอบคุณค่ะ"], ["out", "ยินดีค่ะ ขอให้ขายดีนะคะ", v3("GOODBYE", { reason: "closing_words", stop: "goodbye" })]]);
  room("U-defer", [["in", "ค่าเรียนเท่าไหร่คะ"], ["out", `ค่าเรียนค่ะ\n${CARD}\nสะดวกรอบ เสาร์ 10 ต.ค. หรือ เสาร์ 17 ต.ค. ดีคะ?`, v3("PRICE")],
    ["in", "ขอคิดดูก่อนนะคะ"], ["out", "ได้เลยค่ะ ค่อย ๆ คิดได้เลยนะคะ", v3("GOODBYE", { reason: "closing_words", stop: "defer" })]]);
  db.setSetting("reply_engine", "v3");
  const on = await badges();
  assert.deepEqual(on["U-none"], { blocked: "no_thread" });
  assert.deepEqual(on["U-bye"], { blocked: "followup_stop" });
  assert.equal(on["U-defer"].step, 2, JSON.stringify(on["U-defer"]));
  assert.equal(on["U-defer"].kind, "question");
  assert.equal(on["U-defer"].mode, "defer");
  const { nextQuietEnd } = await import("../src/followupEngine.mjs");
  const deferAnchor = now - 30 * MIN + 2 * 60_000;
  assert.ok(on["U-defer"].dueAt >= nextQuietEnd(deferAnchor + 45 * MIN), "ไม้เช้าวันถัดไป ไม่ใช่ไม้เร็ว +45 นาที");
  db.setSetting("reply_engine", "legacy");
  const off = await badges();
  assert.equal(off["U-none"].step, 1, "ห้องเครื่องเดิม = บันไดเดิม");
  assert.equal(off["U-defer"].step, 1);
  assert.equal("mode" in off["U-defer"], false);
});

/* ------------------------------ Facebook: ทุกไม้ต้องอยู่ในหน้าต่าง 24 ชม. ------------------------------ */

test("Facebook: เงียบเฉย ๆ หลังเห็นราคา = ครั้งเดียว เช้าวันถัดไปที่ยังทันหน้าต่าง (ไม่ทัน = ช่องกลางวันท้ายสุดก่อนเส้นตาย) · ขอเวลาคิด/รอปรึกษา = ครั้งเดียว · รอเงินเดือน/ปฏิเสธ/ปิดห้อง = 0", async () => {
  const T15 = Date.UTC(2026, 0, 13, 8, 0, 0); // 15:00 เวลาไทย (ลูกค้าเงียบตั้งแต่ 14:30)
  for (const t0 of [T15, START]) {
    for (const score of [9, 6, 3]) {
      const silentRun = await simulate("silent", score, { channelId: "facebook", t0, days: 2, stepMs: 10 * MIN });
      const lastIn = silentRun.w.db.lastInboundAt(silentRun.w.id);
      const at = silentRun.w.pushes.map((p) => p.at);
      assert.equal(at.length, 1, `silent ${score} ${new Date(t0).toISOString()}: ${JSON.stringify(hoursOf(silentRun.w))}`);
      assert.ok(at.every((x) => x - lastIn <= 23 * HOUR && x - lastIn < 24 * HOUR - 5 * MIN), "ในหน้าต่าง และไม่เกิน +23 ชม.");
      assert.ok(at[0] - lastIn >= 12 * HOUR, "ไม่ใช่ไม้เร็ว");
      // ลูกค้าเงียบตั้งแต่บ่าย = เช้าวันถัดไป 09:00–10:30 อยู่ในหน้าต่าง
      if (t0 === T15) {
        const bkk = new Date(at[0] + 7 * HOUR);
        assert.ok(bkk.getUTCHours() >= 9 && bkk.getUTCHours() * 60 + bkk.getUTCMinutes() <= 10 * 60 + 31, bkk.toISOString());
      }
      const threads = JSON.parse(silentRun.w.db.getFollowupState(silentRun.w.id).history_json).filter((item) => item.thread).map((item) => item.thread);
      assert.deepEqual(threads, ["round_choice"]);
      assert.deepEqual(silentRun.mismatches, []);
      silentRun.w.db.close();
      for (const scene of ["defer", "consult"]) {
        const run = await simulate(scene, score, { channelId: "facebook", t0, days: 2, stepMs: 10 * MIN });
        const inbound = run.w.db.lastInboundAt(run.w.id);
        assert.equal(run.w.pushes.length, 1, `${scene} ${score}: ${JSON.stringify(hoursOf(run.w))}`);
        const gap = run.w.pushes[0].at - inbound;
        assert.ok(gap >= 12 * HOUR && gap <= 23 * HOUR, `${scene} +${(gap / HOUR).toFixed(2)}`);
        // ขอเวลาคิดหลังเห็นราคา = เช้าวันถัดไป (12 ต.ค. 2026) · รอปรึกษา = ช่อง "ช้า" +20–22 ชม. เดิม
        if (t0 === T15 && scene === "consult") assert.ok(gap >= 20 * HOUR && gap <= 22 * HOUR, `${scene} +${(gap / HOUR).toFixed(2)}`);
        if (t0 === T15 && scene === "defer") {
          const bkk = new Date(run.w.pushes[0].at + 7 * HOUR);
          assert.ok(bkk.getUTCHours() >= 9 && bkk.getUTCHours() * 60 + bkk.getUTCMinutes() <= 10 * 60 + 31, `${scene} ${bkk.toISOString()}`);
        }
        assert.equal(run.w.pushes[0].bubbles.length, 1, "คำถามอย่างเดียว");
        assert.deepEqual(run.mismatches, []);
        run.w.db.close();
      }
      for (const scene of ["money_wait", "decline", "exit", "hardship", "pushed", "crisis"]) {
        const run = await simulate(scene, score, { channelId: "facebook", t0, days: 2, stepMs: 30 * MIN });
        assert.equal(run.w.pushes.length, 0, `${scene} ${score}`);
        assert.equal(run.w.calls.length, 0, `${scene} ${score}: ไม่เสียค่าโมเดล`);
        run.w.db.close();
      }
    }
  }
});
