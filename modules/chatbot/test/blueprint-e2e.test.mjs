// แคมเปญ #AIAGENT — ทั้งเส้นบนแอปจริง (stub เฉพาะ LINE/โมเดล): webhook → ตอบรับ → สร้างผ่านสะพานโมเดลจริง → ส่งจันทร์ 10:00
import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.mjs";
import { saveCampaign } from "../src/blueprintCampaignConfig.mjs";
import { readEntry } from "../src/blueprintStore.mjs";
import { hermesFetchStub, httpRequest, lineFetchStub, listen, memoryDb, poisonGlobalFetch, signLine, testConfig, waitFor } from "./helpers.mjs";
import { SAMPLE_BLUEPRINT } from "./blueprint-fixtures.mjs";

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {}, info() {} };
const TEMPLATE = "#AIAGENT IESA6\nธุรกิจ: ร้านกาแฟสองสาขา โทร 081-234-5678\nอยากให้ผู้ช่วย AI ทำก่อน: ตอบแชทลูกค้าเรื่องเมนู\n(ขอรับไอเดียการวางระบบ AI Agent ภายใน 24 ชม.)";

test("webhook → ตอบรับ → pregenerate → on: ส่งการ์ดวางระบบหนึ่งครั้ง นับเป็นการส่งของแคมเปญ", async (t) => {
  const state = { clock: Date.parse("2026-10-11T15:05:00+07:00") };
  const db = memoryDb({ now: () => state.clock });
  const line = lineFetchStub();
  const hermes = hermesFetchStub(JSON.stringify(SAMPLE_BLUEPRINT));
  saveCampaign(db, { campaignId: "IESA6", keyword: "#AIAGENT", title: "IESA S-Curve MBA รุ่น 6", sendAt: "2026-10-12T10:00:00+07:00", followupOffDays: 7, enabled: true });
  const app = createApp({
    config: testConfig(), db, logger: silent,
    overrides: { lineFetch: line, hermesFetch: hermes, sleep: async () => {}, now: () => state.clock, blueprintSleep: async () => {} },
  });
  t.after(() => { app.learning.stop(); app.server.close(); db.close(); });
  await listen(app.server);
  const raw = JSON.stringify({ events: [{
    type: "message", webhookEventId: "w-e2e", replyToken: "rt-e2e",
    source: { type: "user", userId: "U-e2e" }, message: { id: "m-e2e", type: "text", text: TEMPLATE },
  }] });
  const res = await httpRequest(app.server, {
    method: "POST", path: "/webhooks/line",
    headers: { "content-type": "application/json", "x-line-signature": signLine(raw, "test-line-secret") }, body: raw,
  });
  assert.equal(res.status, 200);
  await waitFor(() => readEntry(db, "IESA6", "U-e2e")?.ackedAt);
  const ack = line.sends.find((c) => c.url.endsWith("/reply"));
  assert.doesNotMatch(JSON.stringify(ack.body), /081-234-5678/u, "ไม่สะท้อนเบอร์โทรที่ลูกค้าพิมพ์มา");
  assert.equal(hermes.calls.length, 0);

  db.setSetting("blueprint_send_mode", "pregenerate");
  await app.blueprintSender.runOnce();
  assert.equal(hermes.calls.length, 1);
  const body = hermes.calls[0].body;
  assert.equal(body.model, "gpt-5.6-sol", "ค่าเริ่มต้น = โมเดลตอบแชทของร้าน (อยู่ในรายการอนุญาตแน่นอน)");
  assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
  assert.doesNotMatch(JSON.stringify(body.messages), /081-234-5678/u, "เบอร์โทรไม่ถึงโมเดล");
  assert.equal(readEntry(db, "IESA6", "U-e2e").status, "ready");
  assert.equal(line.sends.filter((c) => c.url.endsWith("/push")).length, 0);

  db.setSetting("blueprint_send_mode", "on");
  state.clock = Date.parse("2026-10-12T10:00:30+07:00");
  await app.blueprintSender.runOnce();
  const pushes = line.sends.filter((c) => c.url.endsWith("/push"));
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].body.to, "U-e2e");
  assert.equal(pushes[0].body.messages[0].type, "flex");
  assert.equal(readEntry(db, "IESA6", "U-e2e").status, "sent");
  const ledger = db.raw.prepare("SELECT method, purpose, counts_quota, sends FROM line_send_ledger WHERE purpose = 'campaign_delivery'").all().map((row) => ({ ...row }));
  assert.deepEqual(ledger, [{ method: "push", purpose: "campaign_delivery", counts_quota: 1, sends: 1 }]);
  await app.blueprintSender.runOnce();
  assert.equal(line.sends.filter((c) => c.url.endsWith("/push")).length, 1, "ไม่ส่งซ้ำ");
});
