// owner-close-service — พี่ง้วง/ชมพู่กดยืนยัน · ปิดเงียบ · ไม่ปิด ห้องที่ AI เสนอ (คำสั่งพี่ง้วง 12 ต.ค. 2026 ค่ำ)
// ด่านก่อนส่ง (ตัวกวาดต้อง on · ลูกค้าพิมพ์ใหม่ · Facebook 24 ชม.) · กดซ้ำสองเครื่อง · คำลาตายตัวผ่าน push · ห้องเหลือง ·
// ส่งไม่สำเร็จ → ปิดเงียบได้ · ไม่ปิด → จำ 30 วัน + ย้อนได้ 10 วิ · ค้างยืนยัน → กู้จากรั้วส่ง
import test from "node:test";
import assert from "node:assert/strict";
import { OWNER_CLOSE_LANE, OWNER_CLOSE_UNDO_MS, createOwnerCloseService } from "../src/ownerCloseService.mjs";
import { offtopicFallbackText, offtopicOwnerKept } from "../src/offtopicClose.mjs";
import { NOT_QUALIFIED_REASON, QUALIFY_SWEEP_MODE_KEY, qualifyHoldKey, qualifyStateKey } from "../src/notQualified.mjs";
import { SEND_PURPOSE } from "../src/lineSendLedger.mjs";
import { bkk, fakeLineRegistry, makeWorld, silentLogger } from "./ownerReviewFixture.mjs";

const ROOM = `U${"e7".repeat(16)}`;
const FB_ROOM = "facebook:2468013579";

function setup({ sweep = "on", fail = false, channelId = "default", id = ROOM, lastInboundAt = bkk(8, 30) } = {}) {
  const world = makeWorld({ start: bkk(9, 10), sweep });
  const baseline = world.room(id, { channelId, turns: [["out", "สวัสดีค่ะ ลูกแพรดูแลคลาสเรียน AI ค่ะ", bkk(8)], ["in", "พี่ครับ ขอยืมเงินหน่อยได้ไหมครับ", lastInboundAt]] });
  const proposal = world.db.insertOwnerCloseProposal({
    customerId: id, channelId, source: "cue_luna", category: "ask_money", cue: "ask_money", aiReason: "ขอยืมเงินจากเรา", baselineInboundId: baseline,
  });
  const line = fakeLineRegistry({ fail });
  const queue = [];
  const pipeline = { runExclusive: async (customerId, work) => { queue.push(customerId); return work(); } };
  const service = createOwnerCloseService({ db: world.db, closer: world.closer, pipeline, lineRegistry: line, logger: silentLogger, now: () => world.clock.t });
  const decide = (input) => service.decide({ proposalId: proposal.id, operator: { username: "chom" }, revision: 0, seenMessageId: baseline, ...input });
  return { ...world, proposal, baseline, line, queue, service, decide };
}

test("ยืนยัน: คำลาตายตัวตามหมวดทาง push (purpose owner_close · ในคิวของห้อง) → บันทึกข้อความ → ห้องเหลือง not_qualified → audit ด้วยชื่อผู้กด", async () => {
  const s = setup();
  const result = await s.decide({ action: "confirm" });
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.sent, true);
  assert.equal(result.body.closed, true);
  assert.equal(result.body.proposal.status, "confirmed");
  assert.equal(result.body.proposal.decidedBy, "chom");
  assert.deepEqual(s.queue, [ROOM], "ส่งในคิวเดียวกับเส้นตอบลูกค้า");
  assert.equal(s.line.sends.length, 1);
  const sent = s.line.sends[0];
  assert.equal(sent.purpose, SEND_PURPOSE.ownerClose);
  assert.equal(sent.replyToken, "");
  assert.deepEqual(sent.bubbles.map((b) => b.text), [offtopicFallbackText("ask_money")]);
  const out = s.db.raw.prepare("SELECT * FROM messages WHERE customer_id = ? AND direction = 'out' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(ROOM);
  assert.equal(out.content, offtopicFallbackText("ask_money"));
  assert.equal(out.message_class, "proactive");
  assert.equal(out.operator, "", "เสียงของลูกแพร ไม่ใช่ข้อความที่ทีมพิมพ์เอง");
  assert.equal(JSON.parse(out.metadata_json).ownerClose.confirmedBy, "chom");
  const row = s.db.getCustomer(ROOM);
  assert.equal(row.ai_enabled, 0);
  assert.equal(row.ai_off_reason, NOT_QUALIFIED_REASON);
  assert.ok(Number(s.db.getSetting(qualifyHoldKey(ROOM))) > 0, "คิวรอตอบซ่อนห้องจนลูกค้าทักใหม่");
  const audit = s.db.listAudit().find((a) => a.action === "owner_close_confirm");
  assert.equal(audit.operator, "chom");
  assert.doesNotMatch(audit.detail, /ขอยืมเงินหน่อย/u, "audit ไม่มีข้อความลูกค้า");
  assert.equal(s.db.getProactiveAttempt(ROOM, OWNER_CLOSE_LANE, s.proposal.id).status, "settled");
  s.db.close();
});

test("กดซ้ำสองเครื่อง: revision เดิมครั้งที่สอง = 409 stale_revision/already_decided · ส่งคำลาครั้งเดียว", async () => {
  const s = setup();
  const [a, b] = await Promise.all([s.decide({ action: "confirm" }), s.decide({ action: "confirm" })]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  assert.ok(["stale_revision", "already_decided"].includes((a.status === 409 ? a : b).body.code));
  assert.equal(s.line.sends.length, 1);
  const again = await s.decide({ action: "reject", revision: 0 });
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "already_decided");
  s.db.close();
});

test("ตัวกวาดคัดกรองไม่ on = ปฏิเสธก่อนส่ง (ลูกค้าไม่ได้คำลาโดยห้องไม่ปิด) · ข้อเสนอกลับเป็น pending", async () => {
  for (const sweep of ["off", "shadow", ""]) {
    const s = setup({ sweep });
    const result = await s.decide({ action: "confirm" });
    assert.equal(result.status, 409, sweep);
    assert.equal(result.body.code, "sweep_not_on");
    assert.equal(s.line.sends.length, 0);
    assert.equal(s.db.ownerCloseProposal(s.proposal.id).status, "pending");
    assert.equal(s.db.getCustomer(ROOM).ai_enabled, 1);
    const silent = await s.decide({ action: "silent", revision: s.db.ownerCloseProposal(s.proposal.id).revision });
    assert.equal(silent.body.code, "sweep_not_on", "ปิดเงียบก็ต้องให้ตัวกวาด on");
    s.db.close();
  }
});

test("ลูกค้าพิมพ์ใหม่หลังที่คนตรวจเห็น = 409 'ลูกค้าพิมพ์ใหม่' · ไม่ส่ง · pending พร้อมจุดอ้างอิงใหม่ · ยืนยันอีกครั้งด้วยจุดใหม่ได้", async () => {
  const s = setup();
  const fresh = s.say(ROOM, "in", "อ่อ จริง ๆ อยากถามเรื่องคลาสครับ", bkk(9, 9));
  const result = await s.decide({ action: "confirm" });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "customer_typed");
  assert.match(result.body.error, /ลูกค้าพิมพ์ใหม่/u);
  assert.equal(result.body.latestInboundId, fresh);
  assert.equal(s.line.sends.length, 0);
  const row = s.db.ownerCloseProposal(s.proposal.id);
  assert.equal(row.status, "pending");
  assert.equal(row.baseline_inbound_id, fresh);
  const retry = await s.decide({ action: "confirm", revision: row.revision, seenMessageId: fresh });
  assert.equal(retry.status, 200);
  s.db.close();
});

test("ห้องเปลี่ยนไประหว่างรอ: คนรับห้อง/จ่ายเงิน = 409 blocked + หมดอายุ · AI ปิดไปแล้ว = room_changed · ไม่ส่งอะไร", async () => {
  const s = setup();
  s.db.raw.prepare("UPDATE customers SET money_seen_at = 7 WHERE line_user_id = ?").run(ROOM);
  const result = await s.decide({ action: "confirm" });
  assert.equal(result.body.code, "blocked");
  assert.equal(result.body.blockReason, "money");
  assert.equal(s.db.ownerCloseProposal(s.proposal.id).status, "expired");
  assert.equal(s.line.sends.length, 0);
  s.db.close();
  const t = setup();
  t.db.raw.prepare("UPDATE customers SET ai_enabled = 0 WHERE line_user_id = ?").run(ROOM);
  assert.equal((await t.decide({ action: "silent" })).body.code, "room_changed");
  t.db.close();
});

test("Facebook นอกหน้าต่าง 24 ชม. = 409 fb_window_closed (ส่งไม่ได้) → 'ปิดเงียบ' = ห้องเหลืองโดยไม่ส่งข้อความ", async () => {
  const s = setup({ channelId: "facebook", id: FB_ROOM, lastInboundAt: bkk(8, 0, 10) });
  const result = await s.decide({ action: "confirm" });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, "fb_window_closed");
  assert.equal(result.body.canSilent, true);
  assert.equal(s.line.sends.length, 0);
  const pending = s.db.ownerCloseProposal(s.proposal.id);
  const silent = await s.decide({ action: "silent", revision: pending.revision });
  assert.equal(silent.status, 200);
  assert.equal(silent.body.sent, false);
  assert.equal(silent.body.proposal.status, "closed_silent");
  assert.equal(s.line.sends.length, 0);
  assert.equal(s.db.getCustomer(FB_ROOM).ai_off_reason, NOT_QUALIFIED_REASON);
  assert.ok(s.db.listAudit().some((a) => a.action === "owner_close_silent" && a.operator === "chom"));
  s.db.close();
  // ในหน้าต่าง 24 ชม. = ส่งคำลาได้ตามปกติ
  const inside = setup({ channelId: "facebook", id: FB_ROOM, lastInboundAt: bkk(8, 30) });
  assert.equal((await inside.decide({ action: "confirm" })).status, 200);
  assert.equal(inside.line.sends.length, 1);
  inside.db.close();
});

test("provider ไม่รับ = 502 send_failed (ห้องยังไม่ปิด) · ห้ามยืนยันส่งซ้ำ · ปิดเงียบ/ไม่ปิดได้", async () => {
  const s = setup({ fail: true });
  const result = await s.decide({ action: "confirm" });
  assert.equal(result.status, 502);
  assert.equal(result.body.code, "send_failed");
  assert.equal(result.body.canSilent, true);
  const row = s.db.ownerCloseProposal(s.proposal.id);
  assert.equal(row.status, "send_failed");
  assert.equal(s.db.getCustomer(ROOM).ai_enabled, 1);
  assert.equal((await s.decide({ action: "confirm", revision: row.revision })).body.code, "already_decided", "ไม่ยิงซ้ำเอง");
  // ปิดเงียบถูกปฏิเสธ (ตัวกวาดถูกปิดชั่วคราว) = คืนสถานะเดิม send_failed ไม่ใช่ pending (ไม่เปิดทางยิงซ้ำ)
  s.db.setSetting(QUALIFY_SWEEP_MODE_KEY, "off");
  assert.equal((await s.decide({ action: "silent", revision: row.revision })).body.code, "sweep_not_on");
  const restored = s.db.ownerCloseProposal(s.proposal.id);
  assert.equal(restored.status, "send_failed");
  s.db.setSetting(QUALIFY_SWEEP_MODE_KEY, "on");
  const silent = await s.decide({ action: "silent", revision: restored.revision });
  assert.equal(silent.status, 200);
  assert.equal(silent.body.proposal.status, "closed_silent");
  assert.equal(s.line.sends.length, 1);
  s.db.close();
});

test("ไม่ปิด: จำห้องนี้+หมวดนี้ 30 วัน + เหตุสั้น (ปิดชื่อ/เบอร์) · ย้อนได้ใน 10 วิ (ความจำถูกลบ) · เลย 10 วิย้อนไม่ได้ · ยืนยันแล้วย้อนไม่ได้", async () => {
  const s = setup();
  const result = await s.decide({ action: "reject", reason: "เขาเป็นเจ้าของร้าน สมชาย ใจดีมาก โทร 0812345678" });
  assert.equal(result.status, 200);
  assert.equal(result.body.proposal.status, "rejected");
  assert.equal(result.body.undoUntil, s.clock.t + OWNER_CLOSE_UNDO_MS);
  assert.doesNotMatch(result.body.proposal.note, /สมชาย ใจดีมาก|0812345678/u);
  assert.match(result.body.proposal.note, /เจ้าของร้าน/u);
  assert.ok(offtopicOwnerKept(s.db, ROOM, s.clock.t).ask_money);
  assert.equal(s.closer.blockReason(ROOM, s.db.getCustomer(ROOM), "ask_money"), "owner_kept");
  assert.equal(s.line.sends.length, 0);
  assert.ok(s.db.listAudit().some((a) => a.action === "owner_close_reject" && a.operator === "chom"));
  // ย้อน
  s.clock.t += 5_000;
  const back = s.service.undo({ proposalId: s.proposal.id, operator: { username: "chom" }, revision: result.body.proposal.revision });
  assert.equal(back.status, 200);
  assert.equal(back.body.proposal.status, "pending");
  assert.deepEqual(offtopicOwnerKept(s.db, ROOM, s.clock.t), {});
  // ไม่ปิดอีกรอบ แล้วรอเกิน 10 วิ
  const again = await s.decide({ action: "reject", revision: back.body.proposal.revision });
  s.clock.t += OWNER_CLOSE_UNDO_MS + 1;
  const late = s.service.undo({ proposalId: s.proposal.id, operator: { username: "chom" }, revision: again.body.proposal.revision });
  assert.equal(late.body.code, "undo_expired");
  assert.equal(s.service.undo({ proposalId: s.proposal.id, operator: { username: "chom" }, revision: "x" }).status, 400);
  s.db.close();
  const confirmed = setup();
  const ok = await confirmed.decide({ action: "confirm" });
  const undo = confirmed.service.undo({ proposalId: confirmed.proposal.id, operator: { username: "nok" }, revision: ok.body.proposal.revision });
  assert.equal(undo.body.code, "not_undoable");
  confirmed.db.close();
});

test("คำขอผิดรูป = 400 (ไม่แตะข้อเสนอ) · ไม่พบ = 404", async () => {
  const s = setup();
  assert.equal((await s.decide({ action: "close_it" })).status, 400);
  assert.equal((await s.decide({ action: "confirm", revision: "abc" })).body.field, "revision");
  assert.equal((await s.decide({ action: "confirm", revision: undefined })).status, 400);
  assert.equal((await s.decide({ action: "confirm", seenMessageId: "" })).body.field, "seenMessageId");
  assert.equal((await s.decide({ action: "reject", reason: "ก".repeat(201) })).body.field, "reason");
  assert.equal((await s.service.decide({ proposalId: "nope", action: "reject", operator: { username: "x" }, revision: 0 })).status, 404);
  assert.equal(s.db.ownerCloseProposal(s.proposal.id).revision, 0);
  s.db.close();
});

test("ค้าง confirming (โปรเซสตายกลางยืนยัน): ยังไม่ข้ามเส้น provider = คืน pending · ข้ามแล้ว = send_failed (ห้ามส่งซ้ำ) · ยืนยันที่ถูกกู้ไปแล้วไม่ส่ง", async () => {
  const s = setup();
  const claimed = s.db.casOwnerCloseProposal(s.proposal.id, { from: ["pending"], expectedRevision: 0, patch: { status: "confirming" } });
  s.clock.t += 6 * 60_000;
  assert.equal(s.service.recoverStuck(s.clock.t), 1);
  assert.equal(s.db.ownerCloseProposal(s.proposal.id).status, "pending");
  s.db.close();

  const t = setup();
  t.db.casOwnerCloseProposal(t.proposal.id, { from: ["pending"], expectedRevision: 0, patch: { status: "confirming" } });
  t.db.claimProactiveAttempt(ROOM, OWNER_CLOSE_LANE, t.proposal.id, t.clock.t);
  t.db.fenceProactiveSend(ROOM, OWNER_CLOSE_LANE, t.proposal.id, t.clock.t);
  t.clock.t += 6 * 60_000;
  t.service.recoverStuck(t.clock.t);
  const row = t.db.ownerCloseProposal(t.proposal.id);
  assert.equal(row.status, "send_failed");
  assert.equal(row.outcome, "interrupted_after_send");
  // รั้วส่งยังปิดอยู่ = แม้คนกดยืนยันซ้ำก็ไม่ยิงอีก (ต้องเลือกปิดเงียบ/ไม่ปิด)
  assert.equal((await t.decide({ action: "confirm", revision: row.revision })).body.code, "already_decided");
  t.db.close();
  void claimed;
});

test("ลูกค้าพิมพ์แทรกระหว่างยิงคำลา (p1-race): ห้องยังเหลือง — ปิดเทียบข้อความที่คนตรวจเห็น · ข้อความใหม่ให้เส้นห้องเหลืองตัดสินต่อ · ไม่มีคำลาซ้ำ", async () => {
  const s = setup();
  let typed = "";
  // provider ปลอม: ระหว่างคำขอยิงคำลา ลูกค้าพิมพ์ข้อความใหม่เข้ามา (บันทึกลงฐานก่อน provider ตอบ)
  const client = s.line.forChannel();
  const realSend = client.sendBubbles;
  client.sendBubbles = async (args) => {
    typed = s.say(ROOM, "in", "เดี๋ยวครับ จริง ๆ อยากถามเรื่องคลาสด้วย", s.clock.t + 1);
    return realSend(args);
  };
  const result = await s.decide({ action: "confirm" });
  assert.equal(result.status, 200);
  assert.equal(result.body.sent, true);
  assert.equal(result.body.closed, true, "ลาแล้วต้องปิด — ไม่งั้นลูกแพรตอบต่อท้ายคำลา");
  assert.equal(result.body.customerTypedDuringSend, true);
  assert.equal(result.body.outcome, "yellow:customer_typed_during_send");
  assert.equal(result.body.proposal.status, "confirmed");
  const row = s.db.getCustomer(ROOM);
  assert.equal(row.ai_enabled, 0);
  assert.equal(row.ai_off_reason, NOT_QUALIFIED_REASON);
  // จุดอ้างอิงของห้องเหลือง = ข้อความที่คนตรวจเห็น → ตัวกวาดเห็นว่ามีข้อความใหม่หลังคำตัดสิน (ตัดสินซ้ำตามปกติ)
  const state = JSON.parse(s.db.getSetting(qualifyStateKey(ROOM)));
  assert.equal(state.lastInboundId, s.baseline);
  assert.notEqual(state.lastInboundId, typed);
  assert.equal(state.confirmedBy, "chom");
  const baselineAt = s.db.raw.prepare("SELECT created_at FROM messages WHERE id = ?").get(s.baseline).created_at;
  assert.equal(Number(s.db.getSetting(qualifyHoldKey(ROOM))), Number(baselineAt), "คิวรอตอบเห็นข้อความใหม่ (hold = ข้อความที่เห็น)");
  assert.ok(s.db.listAudit().some((a) => a.action === "offtopic_close" && /newer_inbound/u.test(a.detail)));
  assert.equal(s.line.sends.length, 1);
  // ข้อเสนอจบแล้ว + ห้องเหลือง = ยืนยันซ้ำไม่ได้ (ไม่มีคำลาครั้งที่สอง)
  const again = await s.decide({ action: "confirm", revision: result.body.proposal.revision, seenMessageId: typed });
  assert.equal(again.body.code, "already_decided");
  assert.equal(s.line.sends.length, 1);
  s.db.close();
});

test("applyClose: นอกเส้นเจ้าของ (ตีจบในเทิร์น) / ปิดเงียบ — ลูกค้าพิมพ์ใหม่ยังเป็น changed เหมือนเดิม · anchorSeen ต้องเป็นข้อความขาเข้าของห้องนี้", () => {
  const s = setup();
  s.say(ROOM, "in", "อีกข้อความหนึ่งครับ", bkk(9, 9));
  const plan = { category: "ask_money", cue: "ask_money", reason: "" };
  assert.equal(s.closer.applyClose({ customerId: ROOM, plan, inboundId: s.baseline, owner: { username: "chom", silent: true } }).outcome, "changed");
  assert.equal(s.closer.applyClose({ customerId: ROOM, plan, inboundId: s.baseline, owner: { username: "chom" } }).outcome, "changed");
  const outbound = s.db.raw.prepare("SELECT id FROM messages WHERE customer_id = ? AND direction = 'out' LIMIT 1").get(ROOM).id;
  assert.equal(s.closer.applyClose({ customerId: ROOM, plan, inboundId: outbound, owner: { username: "chom", anchorSeen: true } }).outcome, "changed");
  assert.equal(s.closer.applyClose({ customerId: ROOM, plan, inboundId: "missing", owner: { username: "chom", anchorSeen: true } }).outcome, "changed");
  assert.equal(s.db.getCustomer(ROOM).ai_enabled, 1);
  s.db.close();
});
