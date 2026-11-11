import test from "node:test";
import assert from "node:assert/strict";
import { createHermesBridge } from "../src/hermesBridge.mjs";
import { createLineClient } from "../src/lineClient.mjs";
import { createComplianceGuard } from "../src/complianceGuard.mjs";
import { createHumanizer } from "../src/humanizer.mjs";
import { createFollowupEngine } from "../src/followupEngine.mjs";
import { createStagedFollowups } from "../src/stagedFollowups.mjs";
import {
  FOLLOWUP_NO_SEND_PREFIX,
  parseFollowupDraftDecision,
} from "../src/followupDraftDecision.mjs";
import {
  hermesFetchStub,
  lineFetchStub,
  memoryDb,
  poisonGlobalFetch,
  promptText,
  testConfig,
} from "./helpers.mjs";

poisonGlobalFetch();

const NOW = Date.UTC(2026, 0, 15, 5, 0, 0); // 12:00 Bangkok
const HOUR = 3_600_000;
const silent = { log() {}, warn() {}, error() {}, debug() {} };

function manualWorld({ draftText, onDraft = null } = {}) {
  const config = testConfig({ FOLLOWUP_ENABLED: "true" });
  const db = memoryDb({ now: () => NOW });
  const hermesFetch = hermesFetchStub(draftText, { onCall: onDraft });
  const lineFetch = lineFetchStub();
  const engine = createFollowupEngine({
    config,
    db,
    hermes: createHermesBridge({ config, fetchImpl: hermesFetch, logger: silent }),
    line: createLineClient({ config, fetchImpl: lineFetch, sleep: async () => {}, logger: silent }),
    guard: createComplianceGuard({ bannedWords: [], getApprovedPrices: () => db.approvedPrices() }),
    humanizer: createHumanizer(),
    logger: silent,
    now: () => NOW,
  });
  const customerId = "U-followup-decision-manual";
  db.upsertCustomer(customerId, {});
  db.setFollowupEnabled(customerId, true);
  const followup = db.createFollowup({ customerId, scheduledAt: NOW - 1, createdBy: "test", note: "ทักต่ออย่างสุภาพ" });
  return { db, engine, hermesFetch, lineFetch, customerId, followup };
}

function stagedWorld({ draftText, onDraft = null } = {}) {
  const config = testConfig({ STAGED_FOLLOWUP_ENABLED: "true", STAGED_FOLLOWUP_TICK_MS: "0" });
  const db = memoryDb({ now: () => NOW });
  const hermesFetch = hermesFetchStub(draftText, { onCall: onDraft });
  const pushes = [];
  const line = { sendBubbles: async (args) => { pushes.push(args); return { ok: true }; } };
  const engine = createStagedFollowups({
    config,
    db,
    hermes: createHermesBridge({ config, fetchImpl: hermesFetch, logger: silent }),
    lineRegistry: { forChannel: () => line, rawUserId: (id) => id },
    guard: createComplianceGuard({ bannedWords: [], getApprovedPrices: () => db.approvedPrices() }),
    humanizer: createHumanizer(),
    logger: silent,
    now: () => NOW,
    imageCatalog: [],
  });
  const customerId = "U-followup-decision-staged";
  db.upsertCustomer(customerId, {});
  db.setFollowupEnabled(customerId, true);
  db.recordScore(customerId, 6, "{}");
  const inbound = db.insertMessage({ customerId, direction: "in", content: "สนใจคลาสค่ะ" });
  const outbound = db.insertMessage({ customerId, direction: "out", content: "อยากใช้ AI ระดับไหนคะ", operator: "system" });
  db.raw.prepare("UPDATE messages SET created_at=? WHERE id=?").run(NOW - 25 * HOUR, inbound);
  db.raw.prepare("UPDATE messages SET created_at=? WHERE id=?").run(NOW - 25 * HOUR + 1_000, outbound);
  return { db, engine, hermesFetch, pushes, customerId };
}

test("decision parser separates exact no-send contract and internal rationale from customer copy", () => {
  assert.deepEqual(parseFollowupDraftDecision(`${FOLLOWUP_NO_SEND_PREFIX}customer_pause]]`), {
    action: "skip", reason: "customer_pause",
  });
  assert.deepEqual(parseFollowupDraftDecision("ควรพักการทักต่อค่ะ เพราะลูกแพรรับปากว่าจะพักการติดตามแล้วค่ะ"), {
    action: "skip", reason: "customer_pause",
  });
  assert.deepEqual(parseFollowupDraftDecision("หากอยากพักก่อนก็ได้เลยนะคะ พร้อมเมื่อไหร่ทักลูกแพรได้เสมอค่ะ"), {
    action: "send", text: "หากอยากพักก่อนก็ได้เลยนะคะ พร้อมเมื่อไหร่ทักลูกแพรได้เสมอค่ะ",
  });
});

for (const [lane, make, run] of [
  ["scheduled", manualWorld, async (world) => world.engine.runDue()],
  ["staged", stagedWorld, async (world) => world.engine.runOnce()],
]) {
  test(`${lane}: exact no-send token and internal rationale never cross provider boundary`, async () => {
    for (const [draftText, expectedReason] of [
      ["[[NO_SEND:already_answered]]", "already_answered"],
      ["[[NO_SEND:unknown_reason]] extra explanation", "internal_rationale"],
      ["ควรพักการทักต่อค่ะ เพราะลูกแพรรับปากว่าจะพักการติดตามแล้วค่ะ", "customer_pause"],
    ]) {
      const world = make({ draftText });
      try {
        const result = await run(world);
        const item = result.results[0];
        assert.equal(item.status === "skipped" ? item.detail : item.skipped, `no_send:${expectedReason}`);
        const sends = world.lineFetch?.sends ?? world.pushes;
        assert.equal(sends.length, 0);
        const audit = world.db.listAudit(20).find((row) => row.action.includes("followup_no_send"));
        assert.equal(audit?.detail, `reason=${expectedReason}`);
        assert.doesNotMatch(audit?.detail || "", /รับปาก|พักการติดตาม/u, "audit stores enum only, never raw draft");
        if (lane === "staged") {
          assert.equal(world.db.getProactiveAttempt(world.customerId, "staged")?.status, "settled");
          await run(world);
          assert.equal(world.hermesFetch.calls.length, 1, "settled no-send decision must not buy another draft");
        }
      } finally {
        world.db.close();
      }
    }
  });

  test(`${lane}: ordinary gentle customer copy still sends`, async () => {
    const world = make({ draftText: "ไม่ต้องรีบนะคะ หากอยากให้ลูกแพรช่วยสรุปข้อมูลเพิ่ม บอกได้เสมอค่ะ" });
    try {
      await run(world);
      const sends = world.lineFetch?.sends ?? world.pushes;
      assert.equal(sends.length, 1);
    } finally {
      world.db.close();
    }
  });

  test(`${lane}: operator takeover during draft still wins over a send decision`, async () => {
    let world;
    world = make({
      draftText: "ลูกแพรช่วยสรุปเพิ่มให้ได้นะคะ สนใจให้ช่วยส่วนไหนคะ",
      onDraft: () => world.db.setAiEnabled(world.customerId, false, "manual_takeover"),
    });
    try {
      await run(world);
      const sends = world.lineFetch?.sends ?? world.pushes;
      assert.equal(sends.length, 0);
    } finally {
      world.db.close();
    }
  });
}

test("both follow-up prompts treat later user/admin resolution as current and forbid reopening answered discovery", async () => {
  for (const [make, run] of [
    [manualWorld, async (world) => world.engine.runDue()],
    [stagedWorld, async (world) => world.engine.runOnce()],
  ]) {
    const world = make({ draftText: "ไม่ต้องรีบนะคะ พร้อมเมื่อไหร่บอกลูกแพรได้เสมอค่ะ" });
    try {
      const answerId = world.db.insertMessage({ customerId: world.customerId, direction: "in", content: "เคยใช้ AI ระดับเริ่มต้นค่ะ" });
      const resolutionId = world.db.insertMessage({ customerId: world.customerId, direction: "out", content: "รับทราบระดับเริ่มต้นแล้วค่ะ เดี๋ยวทีมสรุปให้", operator: "admin" });
      world.db.raw.prepare("UPDATE messages SET created_at=? WHERE id=?").run(NOW - 24 * HOUR, answerId);
      world.db.raw.prepare("UPDATE messages SET created_at=? WHERE id=?").run(NOW - 24 * HOUR + 1_000, resolutionId);
      await run(world);
      const system = promptText(world.hermesFetch.calls[0].body.messages[0].content);
      const request = JSON.stringify(world.hermesFetch.calls[0].body.messages);
      assert.match(system, /สถานะล่าสุด.*ชนะ/u);
      assert.match(system, /คำถามที่.*ตอบ.*แล้ว.*ห้าม.*เปิด/u);
      assert.match(request, /เคยใช้ AI ระดับเริ่มต้น/u);
      assert.match(request, /\[แอดมินทีมงานพิมพ์เอง\].*รับทราบระดับเริ่มต้นแล้ว/u);
    } finally {
      world.db.close();
    }
  }
});

test("เหตุผลภายในของ Sonnet ที่เล่าก่อนตัวข้อความ = ไม่ส่ง · ข้อความปกติที่มีคำคล้ายกันยังส่งได้ (4 ต.ค. 2026)", () => {
  for (const leaked of [
    "ลูกค้าบอกระดับ 4 ค่อนไป 5 แล้ว และลูกแพรถามไปล่าสุดว่าอยากนำ AI ไปช่วยงานอะไร ลูกค้ายังไม่ได้ตอบ ข้อความนี้จึงชวนคุยต่อจากจุดนั้น\n\nได้เลยค่ะ ร่างข้อความนี้ค่ะ\n\nถ้ามีงานที่ทำซ้ำ ๆ เล่าให้ลูกแพรฟังได้เลยนะคะ",
    "ก่อนอื่นต้องดูว่าลูกค้าตอบอะไรมาบ้าง: ลูกค้าส่งแค่รูปมา\n\nข้อความที่ร่าง:\n\nไม่รีบเลยนะคะ ลูกแพรช่วยดูให้ได้ค่ะ 😊",
    "ชวนคุยเบา ๆ โดยไม่พูดถึงราคา\n\nไม่รีบเลยนะคะ 😊",
  ]) {
    assert.equal(parseFollowupDraftDecision(leaked).action, "skip", leaked.slice(0, 30));
  }
  for (const fine of [
    "คุณลูกค้ายังไม่ได้เล่าว่าทำ Digital Product ประเภทไหน ลูกแพรเลยอยากรู้ว่างานส่วนไหนใช้เวลามากที่สุดคะ 😊",
    "ลองต่อยอดไปช่วยงานเล็ก ๆ ได้ค่ะ เช่น ร่างข้อความหรือสรุปเอกสาร ถ้าสะดวกเล่าให้ลูกแพรฟังได้นะคะ",
    "ลูกค้าหลายท่านเริ่มจากงานตอบแชทก่อนค่ะ ตอนนี้งานไหนกินเวลาที่สุดคะ?",
  ]) {
    assert.equal(parseFollowupDraftDecision(fine).action, "send", fine.slice(0, 30));
  }
});
