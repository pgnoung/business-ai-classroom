// Regression 2026-09-16: แจ้งความต้องการ in a project brief is not a police report.
// Synthetic wording only; no customer identifiers or copied private project brief.
import test from "node:test";
import assert from "node:assert/strict";
import { routeMessage } from "../src/safetyRouter.mjs";
import { createApp } from "../src/server.mjs";
import { runNeedsHumanSla } from "../src/needsHumanSla.mjs";
import { needsPersonReason } from "../src/needsPersonReason.mjs";
import { poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub } from "./helpers.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };
const PROJECT_BRIEF = "โครงการผู้ช่วยฝ่ายบุคคล\nพนักงานพิมพ์คำถามหรือแจ้งความต้องการกับ AI\nระบบรวบรวมข้อมูลสำหรับงานอบรมและสวัสดิการ";

for (const text of [
  PROJECT_BRIEF,
  "พนักงานแจ้งความต้องการอบรมกับผู้ช่วยฝ่ายบุคคล",
  "แจ้งความประสงค์เข้ารับการอบรมค่ะ",
  "ระบบแจ้งความคืบหน้าของเอกสารให้พนักงาน",
  "พนักงานแจ้งความ\u200bต้องการอบรม", // router already normalizes zero-width copy/paste
]) {
  test(`complaint word boundary: ordinary communication stays AI — ${text.slice(0, 30)}`, () => {
    assert.equal(routeMessage({ text }).route, "ai");
    assert.equal(routeMessage({ text }).escalate, null);
  });
}

for (const text of [
  "แจ้งความ",
  "จะไปแจ้งความครับ",
  "แจ้งความแล้วค่ะ",
  "แจ้งความดำเนินคดีแล้ว",
  "แจ้งความที่สถานีตำรวจ",
  "แจ้งความ ต้องการเอาเรื่องให้ถึงที่สุด",
  "แจ้งความต้องการแล้ว แต่บริการแย่มาก",
  "แจ้งความประสงค์แล้ว แต่จะไปแจ้งความครับ",
  "จะไปแจ้งความครับ ส่วนระบบแจ้งความคืบหน้าก็ไม่ทำงาน",
]) {
  test(`complaint word boundary: real complaint still escalates — ${text}`, () => {
    assert.equal(routeMessage({ text }).route, "complaint");
    assert.equal(routeMessage({ text }).escalate.reason, "complaint");
  });
}

for (const channel of ["default", "facebook"]) {
  for (const complaint of [false, true]) {
    test(`complaint word boundary: ${channel} pipeline + AI state + SLA (${complaint ? "real complaint" : "project brief"})`, async (t) => {
      const db = memoryDb();
      t.after(() => db.close());
      const notices = [];
      const notifier = { fireLater: (notice) => notices.push(notice) };
      const hermesFetch = hermesFetchStub("ผู้ช่วยฝ่ายบุคคลช่วยจัดการคำขอได้ค่ะ อยากเริ่มจากงานอบรมหรือสวัสดิการคะ?");
      const app = createApp({
        db, logger: silent,
        config: testConfig({ FB_ENABLED: "true", FB_MOCK_URL: "http://facebook.mock", FB_APP_SECRET: "test-app-secret", FB_PAGE_ACCESS_TOKEN: "test-page-token" }),
        overrides: { notifier, hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} },
      });
      const customerId = channel === "facebook" ? "facebook:synthetic-hr-project" : "U-synthetic-hr-project";
      db.upsertCustomer(customerId, { channelId: channel });
      const text = complaint ? "แจ้งความประสงค์ไปแล้ว แต่จะไปแจ้งความครับ" : PROJECT_BRIEF;
      const turnId = db.insertMessage({ customerId, direction: "in", channelId: channel, content: text });
      const result = await app.pipeline.handleInboundText({ customerId, text, turnId, replyToken: channel === "default" ? "rt" : "" });

      assert.equal(result.route, complaint ? "complaint" : "ai");
      assert.equal(result.sent, true, "the affected reactive path must actually finish");
      const row = db.getCustomer(customerId);
      assert.equal(row.channel_id, channel);
      assert.equal(row.ai_enabled, complaint ? 0 : 1);
      assert.equal(row.ai_off_reason, complaint ? "complaint" : "");
      assert.equal(row.state === "NEEDS_HUMAN", complaint);
      assert.equal(needsPersonReason(row), complaint ? "complaint" : null);
      assert.equal(db.listAudit().some((r) => r.action === "ai_off_complaint"), complaint);
      assert.equal(notices.filter((n) => n.reason === "complaint").length, complaint ? 1 : 0);
      assert.equal(hermesFetch.calls.length, complaint ? 0 : 1, "normal brief reaches the mock brain; complaints do not");

      const incomingAt = db.messagesFor(customerId).find((m) => m.direction === "in").created_at;
      // Next UTC day at 03:00 = 10:00 Bangkok, always overdue and inside office hours.
      const slaAt = (Math.floor(incomingAt / 86_400_000) + 1) * 86_400_000 + 3 * 60 * 60_000;
      const countBefore = notices.length;
      const sla = runNeedsHumanSla({
        db, notifier, logger: silent, now: slaAt,
        config: { needsHumanSlaEnabled: true, needsHumanSlaMinutes: 30, needsHumanSlaMaxReminders: 3, needsHumanSlaHours: "08:00-20:00" },
      });
      assert.equal(sla.notified, complaint ? 1 : 0, "only a real complaint should produce a waiting-for-human reminder");
      assert.equal(notices.length - countBefore, complaint ? 1 : 0);
    });
  }
}
