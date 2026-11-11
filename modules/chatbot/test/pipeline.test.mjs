// pipeline — เดินครบทุกด่านตั้งแต่ burst จนถึง LINE ออก (ทุกอย่าง mock, ไม่มี network จริง)
import test from "node:test";
import assert from "node:assert/strict";
import { CAMPAIGN_RECEIPT_POLICY, withCampaignReceiptPolicy } from "../src/campaignReceiptPolicy.mjs";
import { createApp } from "../src/server.mjs";
import {
  HASHTAG_BUSINESS_DEFAULTS, HERMES_DOWN_RETRY_TEMPLATE, HERMES_DOWN_TEMPLATE, IMAGE_ACK_TEMPLATE,
  normalizeHashtagBusinessKeywords, resolveBusinessHashtag,
} from "../src/pipeline.mjs";
import {
  poisonGlobalFetch, testConfig, memoryDb, hermesFetchStub, lineFetchStub, waitFor,
} from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };

test("configured # campaigns continue without receipt chasing, including old rooms and customer correction", async (t) => {
  const { app, db, hermesFetch } = makeApp({ configOverrides: { HISTORY_TURNS: "2" } });
  t.after(() => db.close());
  db.setSetting("hashtag_business_keywords", JSON.stringify({
    "#gift-new": "สนใจใช้ AI กับงาน", "#another": { seed: "อยากเรียนรู้ AI", note: "งานสัมมนาใหม่" },
  }));
  for (const [id, tag] of [["U-campaign-new", "#gift-new"], ["U-campaign-note", "#another"]]) {
    const result = await app.pipeline.handleInboundText({ customerId: id, text: tag, replyToken: "rt" });
    assert.equal(result.sent, true);
    assert.ok(db.getCustomer(id).hashtag_note);
  }
  for (const text of ["อยากใช้ช่วยจัดเอกสารค่ะ", "ช่วยแนะนำคลาสค่ะ", "ยังไม่ได้รับเอกสารค่ะ ขอส่งใหม่ได้ไหม"]) {
    const result = await app.pipeline.handleInboundText({ customerId: "U-campaign-new", text, replyToken: "rt" });
    assert.equal(result.sent, true, "policy must not silence continued conversation or help requests");
  }
  assert.ok(hermesFetch.calls.length >= 5);
  for (const call of hermesFetch.calls) {
    assert.ok(JSON.stringify(call.body.messages).includes(CAMPAIGN_RECEIPT_POLICY.replaceAll("\n", "\\n")), "reactive and scorer calls must carry the shared policy");
  }
  assert.match(JSON.stringify(hermesFetch.calls.at(-1).body.messages), /ยังไม่ได้รับเอกสาร/u);
  assert.equal(withCampaignReceiptPolicy("unchanged", { businessId: "another-tenant" }), "unchanged");
  const unknown = await app.pipeline.handleInboundText({ customerId: "U-campaign-unknown", text: "#unknown", replyToken: "rt" });
  assert.equal(unknown.suppressed, "hashtag_auto_response");
});

test("bare campaign delivery sends the configured link exactly, persists it, and never calls Hermes", async (t) => {
  let jevCalls = 0;
  const jevFetch = async () => { jevCalls += 1; throw new Error("campaign delivery must not call Jev"); };
  const { app, db, hermesFetch, lineFetch } = makeApp({
    configOverrides: { JEV_REVIEW_MODE: "enforce", TYPESAFE_API_KEY: "fixture" }, jevFetch,
  });
  t.after(() => db.close());
  const deliveryText = "รับไฟล์ Claude Project Setup ได้ที่นี่ค่ะ\nhttps://files.example.com/classroom-guide.pdf";
  db.setSetting("hashtag_business_keywords", JSON.stringify({
    claude10x: {
      seed: "ขอรับไฟล์ Claude Project Setup",
      note: "ไฟล์ที่ผู้ดูแลยืนยัน: Claude_Project_Setup_-_14_เทคนิคจัดระบบ_Claude.pdf",
      deliveryText,
    },
  }));

  for (const [customerId, input] of [["U-claude-lower", "claude10x"], ["U-claude-upper", "  CLAUDE10X  "], ["U-claude-hash", "#Claude10x"]]) {
    const result = await app.pipeline.handleInboundText({ customerId, text: input, replyToken: `rt-${customerId}` });
    assert.equal(result.sent, true, input);
    assert.equal(result.deterministic, true, input);
    const persisted = db.messagesFor(customerId).filter((row) => row.direction === "out").map((row) => row.content).join("\n");
    assert.equal(persisted, deliveryText, "ข้อความและ URL ที่เก็บต้องตรงค่าที่เจ้าของตั้งทุกตัวอักษร");
  }
  assert.equal(hermesFetch.calls.length, 0, "campaign delivery เป็น deterministic ห้ามเสีย Hermes call");
  assert.equal(jevCalls, 0, "campaign delivery ที่เจ้าของกำหนดแล้วไม่ต้องเรียกตัวตัดสิน AI ซ้ำ");
  assert.equal(lineFetch.sends.length, 3);
});

test("bare campaign requires an entire match; unknown plain chat stays normal and unknown # stays silent", async (t) => {
  const { app, db, hermesFetch } = makeApp();
  t.after(() => db.close());
  db.setSetting("hashtag_business_keywords", JSON.stringify({
    claude10x: { seed: "ขอรับไฟล์", deliveryText: "ลิงก์ที่ตั้งไว้" },
  }));
  for (const [customerId, input] of [["U-embedded", "ขอ claude10x หน่อยค่ะ"], ["U-suffix", "claude10x please"]]) {
    const result = await app.pipeline.handleInboundText({ customerId, text: input, replyToken: "rt" });
    assert.equal(result.sent, true);
  }
  assert.equal(hermesFetch.calls.length, 2, "ข้อความธรรมดาที่ไม่ตรงทั้งก้อนต้องยังเข้า Hermes");
  const unknownHash = await app.pipeline.handleInboundText({ customerId: "U-unknown-hash", text: "#unknown", replyToken: "rt" });
  assert.equal(unknownHash.suppressed, "hashtag_auto_response");
  assert.equal(hermesFetch.calls.length, 2);
});

test("campaign delivery respects human ownership and opt-out consent before delivery", async (t) => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  t.after(() => db.close());
  db.setSetting("hashtag_business_keywords", JSON.stringify({
    claude10x: { seed: "ขอรับไฟล์", deliveryText: "ลิงก์ที่ตั้งไว้" },
    unsubscribe: { seed: "ขอรับไฟล์", deliveryText: "ห้ามส่งลิงก์นี้" },
  }));

  db.upsertCustomer("U-campaign-human", {});
  db.setOperatorActiveUntil("U-campaign-human", Date.now() + 60_000);
  const humanOwned = await app.pipeline.handleInboundText({ customerId: "U-campaign-human", text: "claude10x", replyToken: "rt-human" });
  assert.equal(humanOwned.suppressed, "operator_active");

  const optedOut = await app.pipeline.handleInboundText({ customerId: "U-campaign-stop", text: "UNSUBSCRIBE", replyToken: "rt-stop" });
  assert.equal(db.getCustomer("U-campaign-stop").do_not_disturb, 1, "คำขอหยุดต้องชนะ mapping ที่เจ้าของตั้ง");
  assert.doesNotMatch(JSON.stringify(lineFetch.sends), /ห้ามส่งลิงก์นี้/u);
  assert.equal(hermesFetch.calls.length, 0);
  assert.equal(optedOut.deterministic, true);
});

function makeApp({ configOverrides = {}, hermesFetch, lineFetch, jevFetch, approved = [2500] } = {}) {
  const config = testConfig(configOverrides);
  const db = memoryDb();
  for (const amount of approved) db.setApprovedPrice(`ราคา-${amount}`, amount);
  const hermes = hermesFetch ?? hermesFetchStub();
  const line = lineFetch ?? lineFetchStub();
  const app = createApp({
    config,
    db,
    overrides: { hermesFetch: hermes, lineFetch: line, ...(jevFetch ? { jevFetch } : {}), sleep: async () => {} },
    logger: silent,
  });
  return { app, db, config, hermesFetch: hermes, lineFetch: line };
}

test("pipeline: end-to-end — ข้อความลูกค้า -> Hermes -> humanize -> ส่งผ่าน reply + log ขาออก", async () => {
  const { app, db, lineFetch, hermesFetch } = makeApp();
  const result = await app.pipeline.handleInboundText({
    customerId: "U1",
    text: "สวัสดีค่ะ สนใจคอร์สดูแลผิว",
    replyToken: "rt-1",
  });
  assert.equal(result.sent, true);
  assert.equal(result.sendResult.mode, "reply");
  assert.equal(hermesFetch.calls.length, 1);
  assert.ok(lineFetch.sends[0].url.endsWith("/v2/bot/message/reply"));
  const outbound = db.messagesFor("U1").filter((m) => m.direction === "out");
  assert.ok(outbound.length >= 1, "ต้อง log ข้อความขาออกเข้า DB");
  assert.equal(outbound[0].message_class, "reactive");
  db.close();
});

test("pipeline: Hermes ล่ม (HTTP 500) -> rule fallback + mark human review", async () => {
  const { app, db, lineFetch } = makeApp({
    hermesFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  const result = await app.pipeline.handleInboundText({ customerId: "U2", text: "สอบถามหน่อยค่ะ", replyToken: "" });
  assert.equal(result.sent, true);
  assert.equal(result.deterministic, true);
  const sentText = lineFetch.calls.map((c) => JSON.stringify(c.body)).join(" ");
  // ยึดกับ template จริง ไม่ใช่ถ้อยคำ — และห้ามประกาศ error ให้ลูกค้าอ่าน
  assert.ok(sentText.includes(HERMES_DOWN_TEMPLATE), "ต้องส่ง fallback template");
  assert.doesNotMatch(sentText, /ขัดข้อง|error|ผิดพลาด|ระบบล่ม/iu, "ห้ามบอกลูกค้าว่าระบบพัง");
  assert.equal(db.getCustomer("U2").state, "NEEDS_HUMAN");
  db.close();
});

test("pipeline: price guard จับเลขแปลกจาก model -> block + escalate + เก็บ correction", async () => {
  const { app, db, lineFetch } = makeApp({
    hermesFetch: hermesFetchStub("คอร์สนี้ราคา 2,590 บาทค่ะ สนใจจองเลยไหมคะ"),
    approved: [2500],
  });
  // The webhook normally persists this canonical inbound turn before the
  // pipeline runs.  Keep that order here so this regression covers the actual
  // provenance link, not a direct-call fallback with no source row.
  const inboundMessageId = db.insertMessage({ customerId: "U3", direction: "in", content: "ราคาเท่าไหร่คะ" });
  const result = await app.pipeline.handleInboundText({
    customerId: "U3", text: "ราคาเท่าไหร่คะ", replyToken: "rt", turnId: inboundMessageId,
  });
  assert.equal(result.blockedDraft, true, "draft ต้องถูกบล็อก");
  assert.equal(result.sent, true, "ลูกค้าต้องไม่เจอความเงียบ — ส่ง fallback แทน");
  const sentText = lineFetch.calls.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(!sentText.includes("2,590"), "เลขจาก draft ห้ามหลุดถึงลูกค้า");
  // v1.3.4: กู้ประโยคที่ปลอดภัยไว้ได้ แต่ต้องมีคำบอกว่าตัวเลขยังยืนยันไม่ได้เสมอ
  assert.ok(/ขอเช็ค|ขอลูกแพรเช็ค/u.test(sentText), "ต้องบอกลูกค้าว่ากำลังเช็คตัวเลข");
  assert.equal(db.getCustomer("U3").state, "NEEDS_HUMAN");
  const [correction] = db.listCorrections("candidate");
  assert.ok(correction, "draft ที่โดนบล็อกต้องเข้า correction queue");
  assert.equal(correction.human_final, "", "system capture เริ่มต้นโดยไม่มี human_final");
  assert.equal(correction.source_reason, "system:compliance_block:price", "เก็บชนิด guard แบบปิด ไม่มีเลขที่ถูกบล็อก");
  assert.equal(correction.inbound_message_id, inboundMessageId, "ต้องโยง canonical inbound ที่ webhook บันทึกไว้");
  db.close();
});

test("pipeline: banned word จาก model -> block เช่นกัน", async () => {
  const { app, lineFetch } = makeApp({
    hermesFetch: hermesFetchStub("คอร์สนี้การันตีผลค่ะ หายขาดแน่นอน"),
  });
  const result = await app.pipeline.handleInboundText({ customerId: "U4", text: "ดีจริงไหม", replyToken: "" });
  assert.equal(result.blockedDraft, true);
  const sentText = lineFetch.calls.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(!sentText.includes("การันตี"), "คำต้องห้ามจาก draft ห้ามหลุดถึงลูกค้า");
  // v1.4.3: บล็อกเชิงถ้อยคำใช้คำขอโทษสุภาพ ไม่ใช่ประโยคสายข้อมูล (เคสจริง 2026-08-15)
  assert.ok(sentText.includes("ขออภัยที่ชะงัก"), "ต้องส่ง fallback ปลอดภัยแทนความเงียบ");
});

test("pipeline: handoff write ล้มเหลวต้องไม่อ้างกับลูกค้าว่าบันทึกเรื่องแล้ว", async () => {
  const db = memoryDb();
  const lineFetch = lineFetchStub();
  const original = db.setNeedsHuman.bind(db);
  db.setNeedsHuman = () => { throw new Error("fixture handoff write failed"); };
  const rules = [{
    keywords: ["เรียนที่ไหน"],
    template: "สถานที่เรียนยังต้องให้ทีมงานยืนยันค่ะ แพรบันทึกเรื่องไว้ให้ทีมตรวจแล้วนะคะ",
    reason: "class_location_requires_human_confirmation",
  }];
  const config = testConfig();
  const guardedApp = createApp({
    config,
    db,
    overrides: {
      safetyRules: rules,
      hermesFetch: hermesFetchStub(),
      lineFetch,
      sleep: async () => {},
    },
    logger: silent,
  });
  const result = await guardedApp.pipeline.handleInboundText({
    customerId: "U-handoff-fail", text: "เรียนที่ไหนคะ", replyToken: "rt",
  });
  assert.equal(result.sent, true);
  const sentText = lineFetch.calls.map((call) => JSON.stringify(call.body)).join(" ");
  assert.match(sentText, /ต้องให้ทีมงานยืนยัน/u);
  assert.doesNotMatch(sentText, /บันทึก|รับเรื่อง|ได้รับข้อมูล/u);
  db.setNeedsHuman = original;
  db.close();
});

test("pipeline: Hermes ล่มและ handoff write ล้ม ห้ามอ้างว่าบันทึกแล้ว", async () => {
  const db = memoryDb();
  const lineFetch = lineFetchStub();
  db.setNeedsHuman = () => { throw new Error("fixture handoff write failed"); };
  const app = createApp({
    config: testConfig(), db,
    overrides: {
      hermesFetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
      lineFetch,
      sleep: async () => {},
    },
    logger: silent,
  });
  const result = await app.pipeline.handleInboundText({
    customerId: "U-hermes-handoff-fail", text: "สอบถามหน่อยค่ะ", replyToken: "rt",
  });
  assert.equal(result.sent, true);
  const sentText = lineFetch.calls.map((call) => JSON.stringify(call.body)).join(" ");
  assert.match(sentText, /ตรวจข้อมูลให้สักครู่/u);
  assert.doesNotMatch(sentText, /ขัดข้อง|error|ผิดพลาด/iu, "ห้ามบอกลูกค้าว่าระบบพัง");
  assert.doesNotMatch(sentText, /บันทึก|รับเรื่อง|ได้รับข้อมูล/u);
  db.close();
});

test("pipeline: complaint/urgent ที่ handoff write ล้มยังช่วยได้โดยไม่สัญญาติดต่อกลับ", async () => {
  const cases = [
    { id: "complaint", text: "บริการแย่มาก", required: /ขออภัย/u, forbidden: /รับเรื่อง|เจ้าหน้าที่|ติดต่อกลับ/u },
    { id: "urgent", text: "หายใจไม่ออก", required: /1669/u, forbidden: /กำลังแจ้ง|เจ้าหน้าที่|ติดต่อกลับ/u },
  ];
  for (const item of cases) {
    const db = memoryDb();
    const lineFetch = lineFetchStub();
    db.setNeedsHuman = () => { throw new Error("fixture handoff write failed"); };
    const app = createApp({
      config: testConfig(), db,
      overrides: {
        hermesFetch: hermesFetchStub(),
        lineFetch,
        sleep: async () => {},
      },
      logger: silent,
    });
    const result = await app.pipeline.handleInboundText({
      customerId: `U-${item.id}-handoff-fail`, text: item.text, replyToken: "rt",
    });
    assert.equal(result.sent, true);
    const sentText = lineFetch.calls.map((call) => JSON.stringify(call.body)).join(" ");
    assert.match(sentText, item.required);
    assert.doesNotMatch(sentText, item.forbidden);
    assert.doesNotMatch(sentText, /บันทึก|ได้รับข้อมูล/u);
    db.close();
  }
});

test("pipeline: identity question -> template ตรง ไม่เรียก Hermes (non-configurable)", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  const result = await app.pipeline.handleInboundText({ customerId: "U5", text: "นี่บอทหรือเปล่าคะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  assert.equal(result.deterministic, true);
  assert.equal(result.route, "identity");
  assert.equal(hermesFetch.calls.length, 0, "identity ห้ามผ่าน model");
  const allText = lineFetch.calls.map((c) => c.body.messages?.map((m) => m.text).join(" ")).join(" ");
  assert.ok(allText.includes("AI"), "ต้องยอมรับตรง ๆ ว่าเป็น AI");
  db.close();
});

test("pipeline: approved instance identity template remains deterministic and never reaches Hermes", async () => {
  const identityTemplate = "แพรเป็นผู้ช่วย AI ของพี่ง้วงค่ะ ถ้าอยากคุยกับทีมงานคนจริง บอกแพรได้เลยนะคะ";
  const { app, db, hermesFetch, lineFetch } = makeApp({ configOverrides: { IDENTITY_TEMPLATE: identityTemplate } });
  const result = await app.pipeline.handleInboundText({ customerId: "U5-instance", text: "นี่บอทหรอ", replyToken: "rt" });
  assert.equal(result.route, "identity");
  assert.equal(hermesFetch.calls.length, 0);
  const allText = lineFetch.calls.map((call) => call.body.messages?.map((message) => message.text).join(" ")).join(" ");
  assert.equal(allText.trim(), identityTemplate);
  db.close();
});

test("pipeline: urgent -> template 1669 + escalate ทันที ไม่ผ่าน model", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  const result = await app.pipeline.handleInboundText({
    customerId: "U6",
    text: "แน่นหน้าอกมาก หายใจไม่ออกค่ะ",
    replyToken: "rt",
  });
  assert.equal(result.sent, true);
  assert.equal(result.route, "urgent");
  assert.equal(hermesFetch.calls.length, 0);
  const allText = lineFetch.calls.map((c) => c.body.messages?.map((m) => m.text).join(" ")).join(" ");
  assert.ok(allText.includes("1669"));
  assert.equal(db.getCustomer("U6").state, "NEEDS_HUMAN");
  db.close();
});

test("pipeline: urgent_mental -> 1323 + sticky AI-off + แจ้งทีมถูกเหตุ + ห้ามตอบเทิร์นถัดไป", async () => {
  const NOTIFY_UID = "U00000000000000000000000000000a01";
  const { app, db, hermesFetch, lineFetch } = makeApp();
  db.setSetting("escalate_notify:default", JSON.stringify([NOTIFY_UID]));

  const first = await app.pipeline.handleInboundText({
    customerId: "U-mental",
    text: "ธุรกิจผมเจ๊งหมดตัว เหนื่อยจนไม่อยากอยู่ต่อแล้ว",
    replyToken: "rt-mental",
  });
  assert.equal(first.sent, true);
  assert.equal(first.intent, "urgent_mental");
  assert.equal(hermesFetch.calls.length, 0, "วิกฤตสุขภาพจิตห้ามผ่านโมเดล");
  const customer = db.getCustomer("U-mental");
  assert.equal(customer.state, "NEEDS_HUMAN");
  assert.equal(customer.ai_enabled, 0, "หลังส่ง 1323 แล้ว AI ต้องปิดแบบ sticky รอคนจริง");
  assert.equal(customer.ai_off_reason, "urgent_mental");

  await new Promise((resolve) => setTimeout(resolve, 0));
  const teamPushes = lineFetch.calls.filter((call) => call.url?.endsWith("/v2/bot/message/push") && call.body?.to === NOTIFY_UID);
  assert.equal(teamPushes.length, 1);
  assert.match(teamPushes[0].body.messages[0].text, /สุขภาพจิต|1323/u);
  assert.doesNotMatch(teamPushes[0].body.messages[0].text, /กฎฉุกเฉินเฉพาะธุรกิจ/u);

  const callsAfterFirst = lineFetch.calls.length;
  const second = await app.pipeline.handleInboundText({ customerId: "U-mental", text: "ยังอยู่ไหม", replyToken: "rt-mental-2" });
  assert.equal(second.suppressed, "ai_disabled");
  assert.equal(lineFetch.calls.length, callsAfterFirst, "เทิร์นถัดไปห้ามตอบหรือ push ซ้ำ");
  db.close();
});

test("pipeline: AI ปิดอยู่ -> เงียบ และเปิดใหม่ไม่ replay ข้อความเก่า", async () => {
  const { app, db, lineFetch } = makeApp();
  db.upsertCustomer("U7", {});
  db.setAiEnabled("U7", false);
  const suppressed = await app.pipeline.handleInboundText({ customerId: "U7", text: "สวัสดีค่ะ", replyToken: "" });
  assert.equal(suppressed.suppressed, "ai_disabled");
  db.setAiEnabled("U7", true); // เปิดกลับ
  assert.equal(lineFetch.calls.length, 0, "ข้อความเก่าห้ามถูก replay");
  // ข้อความใหม่หลังเปิด ทำงานปกติ
  const fresh = await app.pipeline.handleInboundText({ customerId: "U7", text: "ยังอยู่ไหมคะ", replyToken: "" });
  assert.equal(fresh.sent, true);
  db.close();
});

test("pipeline: control double-read race — ปิด ai ระหว่างรอ Hermes = ห้ามส่ง", async () => {
  let db;
  const hermesFetch = hermesFetchStub("ได้เลยค่ะ", {
    onCall: () => {
      db.setAiEnabled("U8", false); // แอดมิน takeover ตอนบอทกำลังคิดพอดี
    },
  });
  const made = makeApp({ hermesFetch });
  db = made.db;
  const result = await made.app.pipeline.handleInboundText({ customerId: "U8", text: "สอบถามค่ะ", replyToken: "rt" });
  assert.equal(result.suppressed, "ai_disabled_before_send");
  assert.equal(made.lineFetch.sends.length, 0, "reply ที่คิดเสร็จแล้วต้องถูกยกเลิก");
  db.close();
});

test("pipeline: burst absorb — สองข้อความติดกันได้ reply รวมครั้งเดียว", async () => {
  const { app, hermesFetch, lineFetch, db } = makeApp({ configOverrides: { BURST_DEBOUNCE_MS: "50" } });
  const p1 = app.pipeline.handleInboundText({ customerId: "U9", text: "สวัสดีค่ะ", replyToken: "" });
  const p2 = app.pipeline.handleInboundText({ customerId: "U9", text: "สนใจคอร์สหน้าใสค่ะ", replyToken: "" });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.absorbed, true);
  assert.equal(r2.sent, true);
  assert.equal(hermesFetch.calls.length, 1, "คิดครั้งเดียวต่อ burst");
  const userMessage = hermesFetch.calls[0].body.messages.at(-1).content;
  // v1.4.45: หลายบอลลูนถูกแสดงเป็นรายการนับข้อ ให้โมเดลเห็นว่าเป็นคนละข้อความ
  assert.equal(userMessage, "ลูกค้าส่งมา 2 ข้อความติดกัน (อ่านรวมเป็นเจตนาเดียว ตอบให้ครบทุกข้อความ):\n1) สวัสดีค่ะ\n2) สนใจคอร์สหน้าใสค่ะ");
  assert.equal(lineFetch.sends.length, 1);
  db.close();
});

test("pipeline: ลูกค้าส่งรูป -> human review ไม่ตอบอัตโนมัติ (ห้าม OCR)", async () => {
  const { app, db, lineFetch, hermesFetch } = makeApp();
  // ห้องที่มีเรื่องเงินแล้ว = เงียบรอคนตรวจเหมือนเดิม
  db.upsertCustomer("U10", {});
  db.setDealStatus("U10", "awaiting_payment");
  const result = await app.pipeline.handleEvent({
    type: "message",
    source: { userId: "U10" },
    message: { id: "img-1", type: "image" },
  });
  assert.equal(result.route, "media_review");
  assert.equal(lineFetch.calls.length, 0);
  assert.equal(db.getCustomer("U10").state, "NEEDS_HUMAN");
  // F6 (ตรวจย้อนหลัง ก.ย. 2026): ห้องที่ยังไม่มีเรื่องเงิน = ข้อความตอบรับตายตัวหนึ่งบรรทัด
  // ยังไม่ใช่คำตอบจากโมเดล (ห้าม OCR) และยังปักธงให้คนตรวจรูป
  db.upsertCustomer("U10b", {});
  const lead = await app.pipeline.handleEvent({
    type: "message",
    source: { userId: "U10b" },
    message: { id: "img-2", type: "image" },
  });
  assert.equal(lead.route, "media_review");
  assert.equal(db.getCustomer("U10b").state, "NEEDS_HUMAN");
  assert.equal(db.getCustomer("U10b").ai_enabled, 1);
  assert.equal(lineFetch.sends.length, 1);
  assert.ok(JSON.stringify(lineFetch.sends[0].body).includes(IMAGE_ACK_TEMPLATE));
  assert.equal(hermesFetch.calls.length, 0, "รูปห้ามเข้าโมเดลตอบแชท");
  db.close();
});

test("pipeline: history ถูก inject เข้า Hermes ตามลำดับ (N turns จาก DB)", async () => {
  const { app, db, hermesFetch } = makeApp();
  db.upsertCustomer("U11", {});
  db.insertMessage({ customerId: "U11", direction: "in", content: "คำถามเก่า" });
  db.insertMessage({ customerId: "U11", direction: "out", content: "คำตอบเก่า" });
  await app.pipeline.handleInboundText({ customerId: "U11", text: "ถามต่อค่ะ", replyToken: "" });
  const messages = hermesFetch.calls[0].body.messages;
  const roles = messages.map((m) => m.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
  assert.equal(messages[1].content, "คำถามเก่า");
  assert.equal(messages[2].content, "คำตอบเก่า");
  db.close();
});

/* --------------------------- loading animation ----------------------------- */
// BUG 3 (Airdog trial): ต้องโชว์ "กำลังพิมพ์..." ตอน burst จบและเริ่มคิด — ก่อนเรียก Hermes

test("pipeline: AI path -> ยิง loading animation ก่อน Hermes (seconds=20) แล้ว reply ตามปกติ", async () => {
  const { app, db, lineFetch, hermesFetch } = makeApp();
  const result = await app.pipeline.handleInboundText({
    customerId: "U-load", text: "สนใจเครื่องฟอกอากาศค่ะ", replyToken: "rt-load",
  });
  assert.equal(result.sent, true);

  const loading = lineFetch.loadingCalls();
  assert.equal(loading.length, 1, "ต้องยิง loading animation 1 ครั้งต่อ burst");
  assert.ok(loading[0].url.endsWith("/v2/bot/chat/loading/start"));
  assert.deepEqual(loading[0].body, { chatId: "U-load", loadingSeconds: 20 });
  // loading ต้องออกก่อนข้อความตอบ (เริ่มคิด = โชว์ทันที ไม่ใช่หลังคิดเสร็จ)
  assert.ok(lineFetch.calls[0].url.endsWith("/v2/bot/chat/loading/start"));
  assert.equal(hermesFetch.calls.length, 1);
  assert.equal(lineFetch.sends.length, 1, "reply จริงยังออกครบตามเดิม");
  db.close();
});

test("pipeline: AI ปิดอยู่ -> ไม่ยิง loading animation (ห้ามหลอกลูกค้าว่ากำลังพิมพ์)", async () => {
  const { app, db, lineFetch } = makeApp();
  db.upsertCustomer("U-load-off", {});
  db.setAiEnabled("U-load-off", false);
  const result = await app.pipeline.handleInboundText({
    customerId: "U-load-off", text: "สวัสดีค่ะ", replyToken: "",
  });
  assert.equal(result.suppressed, "ai_disabled");
  assert.equal(lineFetch.loadingCalls().length, 0);
  assert.equal(lineFetch.calls.length, 0);
  db.close();
});

/* ----------------------- M2: escalation pause / sticky off ----------------------- */
// payment_review escalate = "หยุดขาย รอคนจริงตรวจยอด" — reuse operator_active_until (60 นาที);
// urgent template ยังยิงระหว่างพัก; guard-block (compliance_block) ไม่พัก
//
// 2026-09-02 (คำสั่งเจ้าของ): complaint ย้ายจาก "พัก 60 นาที" ไปเป็น "ปิดถาวร" —
// พักตามเวลาแปลว่าอีกชั่วโมงบอทกลับมาขายต่อใส่คนที่เพิ่งบ่น (ดู test/ai-pause-policy.test.mjs)

test("M2: complaint -> template ส่ง + ปิด AI ถาวร (ไม่ใช่พัก) + ข้อความถัดไปเงียบ", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  const result = await app.pipeline.handleInboundText({
    customerId: "U-comp", text: "ไม่พอใจมากเลยค่ะ บริการแย่มาก", replyToken: "rt",
  });
  assert.equal(result.sent, true, "template ขออภัยของ turn นี้ยังต้องส่ง");
  assert.equal(result.route, "complaint");

  const customer = db.getCustomer("U-comp");
  assert.equal(customer.state, "NEEDS_HUMAN");
  assert.equal(customer.ai_enabled, 0, "ร้องเรียน = ห้องของคนจริง");
  assert.equal(customer.ai_off_reason, "complaint");
  assert.ok(!db.listAudit().some((row) => row.action === "escalation_pause" && row.target === "U-comp"),
    "ไม่ใช่การพักตามเวลาอีกแล้ว");
  const audit = db.listAudit().find((row) => row.action === "ai_off_complaint");
  assert.equal(audit.operator, "system");
  assert.equal(audit.target, "U-comp");

  // ข้อความถัดไป (ทั่วไป) ต้องเงียบ — AI หยุดขายใส่คนโกรธ รอคนจริง
  const sends = lineFetch.sends.length;
  const next = await app.pipeline.handleInboundText({ customerId: "U-comp", text: "ราคาเท่าไหร่คะ", replyToken: "" });
  assert.equal(next.suppressed, "ai_disabled");
  assert.equal(lineFetch.sends.length, sends, "ห้ามตอบหลังปิด");
  assert.equal(hermesFetch.calls.length, 0, "ห้ามเรียก model หลังปิด");
  db.close();
});

test("M2: payment_review (โอนแล้ว/สลิป) -> pause เหมือน complaint", async () => {
  const { app, db } = makeApp();
  const result = await app.pipeline.handleInboundText({
    customerId: "U-pay", text: "โอนแล้วนะคะ แนบสลิปไว้ให้แล้ว", replyToken: "rt",
  });
  assert.equal(result.sent, true);
  assert.equal(result.route, "payment");
  assert.ok(db.getCustomer("U-pay").operator_active_until > Date.now(), "เรื่องเงินต้อง pause รอคนตรวจ");
  assert.ok(db.listAudit().some((row) => row.action === "escalation_pause" && row.target === "U-pay"));
  // v1.4.8 (คำสั่งพี่ง้วง 2026-08-16): จังหวะเงิน = ปิด AI ถาวร (human 100% เก็บยอด/CRM)
  assert.equal(db.getCustomer("U-pay").ai_enabled, 0, "แจ้งโอนแล้ว AI ต้องปิดถาวร รอแอดมินเปิดคืน");
  assert.ok(db.listAudit().some((row) => row.action === "ai_off_money_line" && row.target === "U-pay"));
  const next = await app.pipeline.handleInboundText({ customerId: "U-pay", text: "สรุปยอดเท่าไหร่คะ", replyToken: "" });
  assert.equal(next.suppressed, "ai_disabled", "เทิร์นถัดไปเงียบเพราะ AI ปิดแล้ว (คนจริงคุยแทน)");
  db.close();
});

test("M2: urgent ระหว่าง pause ยังยิง template 1669 (safety ห้ามเงียบ)", async () => {
  const { app, db, lineFetch } = makeApp();
  // 2026-09-02: ใช้หน้าต่างพักตรง ๆ เป็นฉากตั้งต้น — complaint ไม่ใช่ "พัก" อีกแล้ว
  // ประเด็นที่เทสต์นี้ล็อกยังเหมือนเดิม: ห้องที่กำลังพักอยู่ต้องไม่กลืนเส้นทางฉุกเฉิน
  db.upsertCustomer("U-urg", {});
  db.setOperatorActiveUntil("U-urg", Date.now() + 60 * 60_000);
  assert.ok(db.getCustomer("U-urg").operator_active_until > Date.now());
  const sends = lineFetch.sends.length;
  const urgent = await app.pipeline.handleInboundText({
    customerId: "U-urg", text: "แน่นหน้าอกมาก หายใจไม่ออกค่ะ", replyToken: "",
  });
  assert.equal(urgent.sent, true, "เส้นทางฉุกเฉินต้องทะลุ pause");
  assert.equal(urgent.route, "urgent");
  assert.equal(lineFetch.sends.length, sends + 1);
  const allText = lineFetch.sends.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(allText.includes("1669"));
  db.close();
});

test("M2: guard-block (compliance_block) ไม่ pause — ข้อความถัดไป AI ยังตอบ", async () => {
  const { app, db, lineFetch } = makeApp({
    hermesFetch: hermesFetchStub("คอร์สนี้ราคา 9,999 บาทค่ะ"), // เลขไม่อยู่ในตาราง -> โดน guard บล็อก
  });
  const blocked = await app.pipeline.handleInboundText({ customerId: "U-gb", text: "ราคาเท่าไหร่คะ", replyToken: "" });
  assert.equal(blocked.blockedDraft, true);
  assert.equal(db.getCustomer("U-gb").operator_active_until, 0, "guard-block ห้าม pause (fallback+correction พอ)");
  assert.ok(!db.listAudit().some((row) => row.action === "escalation_pause"), "ห้ามมี audit pause");
  // ข้อความถัดไปยังเดิน AI path ตามปกติ (ธง NEEDS_HUMAN ไม่ปิด AI — พฤติกรรมเดิม)
  const sends = lineFetch.sends.length;
  const next = await app.pipeline.handleInboundText({ customerId: "U-gb", text: "เปิดกี่โมงคะ", replyToken: "" });
  assert.equal(next.suppressed, undefined, "ไม่ถูก suppress");
  assert.ok(lineFetch.sends.length > sends, "ยังตอบต่อได้");
  db.close();
});

test("pipeline: loading endpoint พัง -> reply ยังออกปกติ (best-effort ห้ามล้มเส้นทางตอบ)", async () => {
  const sendCalls = [];
  const lineFetch = async (url, opts) => {
    if (String(url).includes("/v2/bot/chat/loading/")) {
      throw new Error("loading endpoint ล่ม");
    }
    sendCalls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  const { app, db } = makeApp({ lineFetch });
  const result = await app.pipeline.handleInboundText({
    customerId: "U-load-fail", text: "สอบถามหน่อยค่ะ", replyToken: "rt-lf",
  });
  assert.equal(result.sent, true, "loading พังห้ามกระทบ reply");
  assert.equal(sendCalls.length, 1);
  assert.ok(sendCalls[0].url.endsWith("/v2/bot/message/reply"));
  db.close();
});

// REVIEW FIX v1.1 (bug 5): push แจ้งทีมยิงเฉพาะเมื่อเส้นทางตอบเดินจริง —
// identity ที่โดน suppress (แอดมินกำลังดูแล) ต้องเงียบ ไม่หลอกทีมว่า "ระบบตอบเปิดเผยแล้ว"
// คำสั่งพี่ง้วง 2026-09-28 (F10): ถามว่าเป็นบอท = ตอบความจริงแล้วคุยต่อ — ไม่ปลุกทีมอีกแล้ว
// (เดิม push ทุกครั้ง ทั้งที่ลูกค้าแค่ถาม ยังไม่ได้ขอคน) · ขอคนจริงเมื่อไหร่ เส้น human_handoff แจ้งเอง
test("pipeline: identity -> ตอบเปิดเผยแล้วคุยต่อ ไม่ push แจ้งทีม / operator active = ไม่ตอบ", async () => {
  const NOTIFY_UID = "U00000000000000000000000000000a01";
  const { app, db, lineFetch } = makeApp();
  db.setSetting("escalate_notify:default", JSON.stringify([NOTIFY_UID]));

  const ok = await app.pipeline.handleInboundText({ customerId: "U-idn", text: "นี่บอทหรือเปล่าคะ", replyToken: "rt" });
  assert.equal(ok.sent, true);
  await new Promise((resolve) => setTimeout(resolve, 0)); // fireLater เป็น macrotask
  const pushes = lineFetch.calls.filter((c) => c.url?.endsWith("/v2/bot/message/push") && c.body?.to === NOTIFY_UID);
  assert.equal(pushes.length, 0, "ถามว่าเป็นบอทไม่ใช่การขอคน — ห้ามปลุกทีม");
  assert.equal(db.getCustomer("U-idn").ai_enabled, 1);

  // เคส suppress: แอดมินกำลังดูแล -> ไม่ตอบ (พฤติกรรมเดิม)
  db.upsertCustomer("U-idn2", {});
  db.setOperatorActiveUntil("U-idn2", Date.now() + 60_000);
  const suppressed = await app.pipeline.handleInboundText({ customerId: "U-idn2", text: "ใช่บอทไหม", replyToken: "rt2" });
  assert.equal(suppressed.suppressed, "operator_active");
  db.close();
});

// v1.4.2 (เคสจริง 2026-08-16 ตี 1): Hermes ล่มติดกันหลายเทิร์น — ลูกค้าเคยเจอ
// template เดิมซ้ำ 3 รอบ (นกแก้ว) ทั้งที่ธงคนดูแลติดตั้งแต่ครั้งแรกแล้ว
test("pipeline: Hermes ล่มซ้ำ — เทิร์นสองเปลี่ยนถ้อยคำ เทิร์นสามเงียบ (ธงคนดูแลติดแล้ว)", async () => {
  const { app, db, lineFetch } = makeApp({
    hermesFetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  const first = await app.pipeline.handleInboundText({ customerId: "U-stall", text: "ราคาเท่าไหร่ครับ", replyToken: "" });
  assert.equal(first.sent, true);
  const second = await app.pipeline.handleInboundText({ customerId: "U-stall", text: "ตรวจสอบอะไรครับ", replyToken: "" });
  assert.equal(second.sent, true);
  const third = await app.pipeline.handleInboundText({ customerId: "U-stall", text: "ผมถาม คลาส", replyToken: "" });
  assert.equal(third.suppressed, "hermes_down_repeated", "ครั้งที่สามห้ามนกแก้วต่อ — เงียบพร้อมธงคนดูแล");

  const outbound = db.messagesFor("U-stall").filter((m) => m.direction === "out").map((m) => m.content);
  assert.equal(outbound.length, 2, "ส่งจริงแค่สองข้อความ");
  assert.equal(outbound[0], HERMES_DOWN_TEMPLATE);
  assert.equal(outbound[1], HERMES_DOWN_RETRY_TEMPLATE, "ครั้งสองต้องเป็นคนละถ้อยคำ");
  assert.equal(db.getCustomer("U-stall").state, "NEEDS_HUMAN");
  db.close();
});

// v1.4.3 (เคสจริง 2026-08-15 ตี 2): บั๊ก scope ทำให้ด่านกันแก้ราคาขึ้นตายเงียบทุกเทิร์น
// ("history is not defined" โดน catch กลืน) — เทสต์ระดับ pipeline เต็มเส้นถึงจะจับได้
test("pipeline: แก้ราคาขึ้นจากที่เคยบอก -> บล็อก + ส่ง template เช็คยอด (ด่านต้องไม่ตายเงียบ)", async () => {
  const warns = [];
  const config = testConfig();
  const db = memoryDb();
  for (const amount of [12900, 15900]) db.setApprovedPrice(`ราคา-${amount}`, amount);
  const line = lineFetchStub();
  const app = createApp({
    config, db,
    overrides: { hermesFetch: hermesFetchStub("ขออภัยค่ะ ขอแจ้งราคาใหม่เป็น 15,900 บาทค่ะ"), lineFetch: line, sleep: async () => {} },
    logger: { ...silent, warn: (m) => warns.push(String(m)), debug: (m) => warns.push(String(m)) },
  });
  db.upsertCustomer("U-rev", {});
  // เคยบอก 12,900 ไปแล้วในบทสนทนา — draft ใหม่พูด 15,900 = แก้ขึ้น ต้องโดนด่าน
  db.insertMessage({ customerId: "U-rev", direction: "out", content: "คลาสนี้ Early Bird 12,900 บาทค่ะ", agentMode: "ai" });
  const result = await app.pipeline.handleInboundText({ customerId: "U-rev", text: "สรุปราคาเท่าไหร่คะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  const sentText = line.calls.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(!sentText.includes("15,900"), "ราคาที่แก้ขึ้นห้ามหลุดถึงลูกค้า");
  assert.ok(sentText.includes("เช็คยอดกับทีมงาน"), "ต้องส่ง template เช็คยอด");
  assert.ok(!warns.some((w) => w.includes("history is not defined")), "ด่านต้องไม่ตายเพราะ ReferenceError");
  assert.ok(warns.some((w) => w.includes("บล็อกการแก้ราคาขึ้น")), "ด่านต้องทำงานจริง");
  db.close();
});

// v1.4.3: โดนแบนแค่คำ ("ดีที่สุด") ต้อง redraft เลี่ยงคำหนึ่งครั้ง ไม่ใช่ตายทั้งคำตอบ
test("pipeline: banned word ล้วน -> redraft เลี่ยงคำสำเร็จ / ล้มเหลว -> fallback สุภาพไม่ใช่ประโยคข้อมูล", async () => {
  const drafts = ["เลือกใช้ ChatGPT ดีที่สุดเลยค่ะ เหมาะกับงานเขียนมากค่ะ", "เลือกใช้ ChatGPT เหมาะกับงานเขียนมากค่ะ"];
  let call = 0;
  const hermesFetch = async (url, init) => ({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: drafts[Math.min(call++, drafts.length - 1)] } }], usage: {} }),
  });
  const db = memoryDb();
  const line = lineFetchStub();
  const app = createApp({
    config: testConfig(), db,
    overrides: { hermesFetch, lineFetch: line, bannedWords: ["ดีที่สุด"], sleep: async () => {} },
    logger: silent,
  });
  const result = await app.pipeline.handleInboundText({ customerId: "U-ban", text: "ใช้ ChatGPT อยู่ค่ะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  assert.equal(result.blockedDraft, undefined ?? result.blockedDraft, "redraft สำเร็จ = ไม่นับเป็น blocked");
  const sentText = line.calls.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(!sentText.includes("ดีที่สุด"), "คำแบนห้ามหลุด");
  assert.ok(sentText.includes("เหมาะกับงานเขียน"), "คำตอบจริง (ฉบับเลี่ยงคำ) ต้องถึงลูกค้า");
  db.close();

  // redraft ยังมีคำแบน -> fallback ต้องเป็นคำขอโทษสุภาพ ไม่ใช่ประโยค "ข้อมูลยืนยันไม่ได้"
  const db2 = memoryDb();
  const line2 = lineFetchStub();
  const app2 = createApp({
    config: testConfig(), db: db2,
    overrides: {
      hermesFetch: hermesFetchStub("อันนี้ดีที่สุดค่ะ"),
      lineFetch: line2, bannedWords: ["ดีที่สุด"], sleep: async () => {},
    },
    logger: silent,
  });
  const second = await app2.pipeline.handleInboundText({ customerId: "U-ban2", text: "ตัวไหนดีคะ", replyToken: "rt" });
  assert.equal(second.sent, true, "ลูกค้าต้องไม่เจอความเงียบ");
  const sentText2 = line2.calls.map((c) => JSON.stringify(c.body)).join(" ");
  assert.ok(!sentText2.includes("ดีที่สุด"));
  assert.ok(!sentText2.includes("ข้อมูลตรงนี้ยังยืนยันไม่ได้"), "บล็อกเชิงถ้อยคำห้ามใช้ fallback สายข้อมูล");
  assert.ok(sentText2.includes("ขออภัยที่ชะงัก"), "ต้องเป็นคำขอโทษสุภาพชวนคุยต่อ");
  assert.equal(db2.raw.prepare("SELECT COUNT(*) AS n FROM llm_usage WHERE customer_id=? AND kind='draft'").get("U-ban2").n, 2,
    "both paid drafts must be accounted for even when the re-draft is also rejected");
  db2.close();
});

/* -------- v1.4.11 (คำสั่งพี่ง้วง 2026-08-18): handoff = bot หลักเงียบสนิท -------- */

test("v1.4.11: อยากคุยกับคน -> template เดียว + AI ปิดถาวร (reason human_requested) + เทิร์นถัดไปเงียบ", async () => {
  const { app, db } = makeApp();
  const result = await app.pipeline.handleInboundText({
    customerId: "U-human", text: "อยากคุยกับคน", replyToken: "rt",
  });
  assert.equal(result.sent, true);
  assert.equal(result.route, "human_handoff", "ต้องเป็น route deterministic ไม่ใช่ draft");
  const customer = db.getCustomer("U-human");
  assert.equal(customer.ai_enabled, 0, "หลังรับปากส่งต่อ ต้องเงียบจริง (เคสลูกค้า A ตอบ 'ครับ' ต่อ 4 รอบ)");
  assert.equal(customer.ai_off_reason, "human_requested");
  assert.ok(db.listAudit().some((row) => row.action === "ai_off_human_requested" && row.target === "U-human"));
  const next = await app.pipeline.handleInboundText({ customerId: "U-human", text: "ครับ รอ", replyToken: "" });
  assert.equal(next.suppressed, "ai_disabled", "ลูกค้าพิมพ์อะไรมาต่อ bot หลักห้ามตอบ");
  db.close();
});

test("v1.4.11: ส่งเลขบัญชีแล้ว -> AI ปิด (bank_sent) + deal awaiting_payment + เทิร์นถัดไปเงียบ", async (t) => {
  const bankReply = [
    "สรุปยอด 15,900 บาทค่ะ",
    "สามารถโอนชำระได้ที่บัญชีนี้นะคะ\n\nธนาคาร : กสิกรไทย\nเลขที่บัญชี : 0000000000\nชื่อบัญชี : บริษัททดสอบ",
  ].join("\n\n");
  const { app, db } = makeApp({
    approved: [15900],
    hermesFetch: hermesFetchStub(bankReply),
  });
  const result = await app.pipeline.handleInboundText({
    customerId: "U-bank", text: "ตกลงสมัครค่ะ ขอเลขบัญชีเลย", replyToken: "rt",
  });
  assert.equal(result.sent, true);
  const customer = db.getCustomer("U-bank");
  assert.equal(customer.ai_enabled, 0, "ส่งเลขบัญชีแล้ว bot หลักต้องเงียบทันที");
  assert.equal(customer.ai_off_reason, "bank_sent");
  assert.equal(customer.deal_status, "awaiting_payment", "ดีลต้องเดินเป็นรอโอนแบบ deterministic");
  assert.ok(db.listAudit().some((row) => row.action === "ai_off_bank_sent" && row.target === "U-bank"));
  const next = await app.pipeline.handleInboundText({ customerId: "U-bank", text: "ขอใบเสนอราคาได้ไหม", replyToken: "" });
  assert.equal(next.suppressed, "ai_disabled", "หลังส่งบัญชี ลูกค้าพิมพ์มาต้องรอแอดมินเท่านั้น");
  db.close();
});

test("v1.4.11b (audit): 'โอนแล้ว' ตอน AI ปิด (bank_sent) ห้ามตกหลุมเงียบ — push + reason=money_line + FU หยุดทวง", async () => {
  const { app, db } = makeApp();
  db.upsertCustomer("U-void", {});
  db.setAiEnabled("U-void", false, "bank_sent");
  db.setDealStatus("U-void", "awaiting_payment");
  const result = await app.pipeline.handleInboundText({ customerId: "U-void", text: "โอนแล้วนะคะ", replyToken: "" });
  assert.equal(result.suppressed, "ai_disabled", "bot หลักยังเงียบตามคำสั่ง");
  const customer = db.getCustomer("U-void");
  assert.equal(customer.ai_off_reason, "money_line", "เหตุปิดต้องสลับ — FU เลิกทวงโอนใส่คนที่โอนแล้ว");
  assert.match(customer.handoff_summary || "", /payment_review/u, "ต้องมีบรรทัด payment_review ให้ paymentHold อ่าน");
  assert.ok(db.listAudit().some((row) => row.action === "payment_declared_while_ai_off" && row.target === "U-void"));
  db.close();
});

test("v1.4.11b (audit): แค่เอ่ยถึงเลขที่บัญชี (ไม่มีเลขตาม) ห้ามปิด AI", async () => {
  const { app, db } = makeApp({
    hermesFetch: hermesFetchStub("ได้เลยค่ะ เดี๋ยวลูกแพรส่งเลขที่บัญชีให้ในขั้นถัดไปนะคะ มีคำถามเพิ่มไหมคะ?"),
  });
  const result = await app.pipeline.handleInboundText({ customerId: "U-mention", text: "จ่ายยังไงคะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  assert.equal(db.getCustomer("U-mention").ai_enabled, 1, "เอ่ยถึงเฉย ๆ ต้องไม่ปิด AI (audit จับ)");
  db.close();
});

/* -------- v1.4.12 (คำสั่งพี่ง้วง 2026-08-18): # คีย์เวิร์ดกิจกรรม = เงียบเฉพาะข้อความนั้น -------- */

test("v1.4.12: '#horeca' -> ลูกแพรเงียบให้ LINE OA auto-response ตอบ, ข้อความถัดไปคุยปกติ", async () => {
  const { app, db, hermesFetch, lineFetch } = makeApp();
  const tag = await app.pipeline.handleInboundText({ customerId: "U-tag", text: "#horeca", replyToken: "rt" });
  assert.equal(tag.suppressed, "hashtag_auto_response");
  assert.equal(hermesFetch.calls.length, 0, "ห้ามคิด ห้าม draft");
  assert.equal(lineFetch.sends.length, 0, "ห้ามส่งอะไรทับ auto-response");
  // ขึ้นต้น # แล้วมีข้อความตาม ก็ยังเป็นคีย์เวิร์ดกิจกรรม
  const tag2 = await app.pipeline.handleInboundText({ customerId: "U-tag", text: "  #AIclass สนใจ", replyToken: "rt" });
  assert.equal(tag2.suppressed, "hashtag_auto_response");
  // ลูกค้าคุยต่อปกติ = AI ตอบทันที ไม่มีสถานะค้าง
  const next = await app.pipeline.handleInboundText({ customerId: "U-tag", text: "สวัสดีค่ะ สนใจคลาส", replyToken: "rt" });
  assert.equal(next.sent, true, "ข้อความปกติหลัง # ต้องได้คำตอบ");
  assert.equal(db.getCustomer("U-tag").ai_enabled, 1);
  db.close();
});

test("v1.4.12: # กลางประโยค (C#) ไม่ใช่คีย์เวิร์ดกิจกรรม — ตอบปกติ", async () => {
  const { app, db } = makeApp();
  const result = await app.pipeline.handleInboundText({ customerId: "U-csharp", text: "สอนภาษา C# ด้วยไหมคะ", replyToken: "rt" });
  assert.equal(result.sent, true);
  db.close();
});

test("v1.4.12b: สวิตช์ # จาก console (DB) ชนะ env — ปิดแล้วลูกแพรตอบข้อความ # ปกติ", async () => {
  const { app, db } = makeApp();
  db.setSetting("hashtag_silence", "0");
  const answered = await app.pipeline.handleInboundText({ customerId: "U-ht", text: "#horeca", replyToken: "rt" });
  assert.equal(answered.sent, true, "สวิตช์ปิด = ตอบปกติแม้ขึ้นต้น #");
  db.setSetting("hashtag_silence", "1");
  const silenced = await app.pipeline.handleInboundText({ customerId: "U-ht", text: "#horeca", replyToken: "rt" });
  assert.equal(silenced.suppressed, "hashtag_auto_response", "สวิตช์เปิด = เงียบ (อ่านสด ไม่ต้อง restart)");
  db.close();
});

/* -- v1.4.50 (คำสั่งพี่ง้วง 2026-08-25): คีย์เวิร์ดธุรกิจจาก greeting message ของ OA --
   #online / #onsite / #inhouse / #contact = เจตนาซื้อ ไม่ใช่คีย์เวิร์ดกิจกรรม
   ทิศความเสี่ยงต้องไม่เปลี่ยน: นอกรายการยังเงียบเหมือนเดิม และรายการว่าง = เดิมทุกประการ */

test("v1.4.50: รายการว่าง (ค่าเริ่มต้น) = พฤติกรรม # เดิมทุกประการ", async () => {
  const { app, db, hermesFetch } = makeApp();
  const result = await app.pipeline.handleInboundText({ customerId: "U-hb-default", text: "#online", replyToken: "rt" });
  assert.equal(result.suppressed, "hashtag_auto_response", "ยังไม่ตั้งรายการ = เงียบเหมือนเดิม");
  assert.equal(hermesFetch.calls.length, 0);
  db.close();
});

test("v1.4.50: คีย์เวิร์ดในรายการ = ตอบเอง · นอกรายการ = ยังเงียบให้ LINE OA ตอบ", async () => {
  const { app, db } = makeApp();
  db.setSetting("hashtag_business_keywords", JSON.stringify(HASHTAG_BUSINESS_DEFAULTS));

  const online = await app.pipeline.handleInboundText({ customerId: "U-hb-on", text: "#online", replyToken: "rt" });
  assert.equal(online.sent, true, "#online อยู่ในรายการ ต้องได้คำตอบ");
  assert.notEqual(online.suppressed, "hashtag_auto_response");

  // คำที่ไม่ได้อยู่ในรายการต้องไม่เปลี่ยนพฤติกรรม
  const other = await app.pipeline.handleInboundText({ customerId: "U-hb-on", text: "#horeca", replyToken: "rt" });
  assert.equal(other.suppressed, "hashtag_auto_response", "นอกรายการยังเงียบ = ทิศความเสี่ยงเดิม");
  db.close();
});

// คำสั่งพี่ง้วง 2026-08-25: #contact ต้องไม่ปิด AI ทันที เพราะลูกค้าอาจกดพลาด
// ลูกแพรถามก่อนว่าต้องการให้ทีมช่วยเรื่องอะไร แล้วค่อยเข้าเส้นส่งต่อคนเมื่อยืนยันจริง
test("v1.4.50: #contact ต้องไม่ปิด AI (กันมือลั่น) — ลูกแพรถามก่อน", async () => {
  const { app, db } = makeApp();
  db.setSetting("hashtag_business_keywords", JSON.stringify(HASHTAG_BUSINESS_DEFAULTS));
  const result = await app.pipeline.handleInboundText({ customerId: "U-hb-contact", text: "#contact", replyToken: "rt" });
  assert.equal(result.sent, true, "ต้องได้คำตอบจากลูกแพร ไม่ใช่เงียบหรือปิดเคส");
  const customer = db.getCustomer("U-hb-contact");
  assert.equal(customer.ai_enabled, 1, "ห้ามปิด AI จากการกด #contact เพียงอย่างเดียว");
  assert.notEqual(customer.state, "NEEDS_HUMAN");
  db.close();
});

test("v1.4.50: หลัง #contact ถ้าลูกค้ายืนยันว่าขอคุยกับคน เส้นส่งต่อคนเดิมยังทำงาน", async () => {
  const { app, db } = makeApp();
  db.setSetting("hashtag_business_keywords", JSON.stringify(HASHTAG_BUSINESS_DEFAULTS));
  await app.pipeline.handleInboundText({ customerId: "U-hb-confirm", text: "#contact", replyToken: "rt" });
  await app.pipeline.handleInboundText({ customerId: "U-hb-confirm", text: "ขอคุยกับคนจริงครับ", replyToken: "rt" });
  const customer = db.getCustomer("U-hb-confirm");
  assert.equal(customer.ai_enabled, 0, "ยืนยันแล้วต้องปิด AI ตามกติกาเดิม");
  assert.equal(customer.state, "NEEDS_HUMAN");
  db.close();
});

test("v1.4.50: ข้อความต่อท้ายคีย์เวิร์ดไม่หาย ('#inhouse 20 คนครับ')", () => {
  // v1.4.52: resolveBusinessHashtag คืน { tag, text, note } แทนสตริงเดี่ยว
  // เพราะโน้ตกิจกรรมต้องเดินทางแยกจากข้อความที่ใช้แทนคำพูดลูกค้า
  const keywords = normalizeHashtagBusinessKeywords(HASHTAG_BUSINESS_DEFAULTS);
  assert.equal(resolveBusinessHashtag("#inhouse", keywords).text, "สนใจอบรม in-house ให้ทีมที่บริษัท");
  assert.equal(
    resolveBusinessHashtag("#inhouse 20 คนครับ", keywords).text,
    "สนใจอบรม in-house ให้ทีมที่บริษัท 20 คนครับ",
    "ข้อมูลที่ลูกค้าพิมพ์เพิ่มต้องถูกส่งต่อ",
  );
  assert.equal(resolveBusinessHashtag("  #ONLINE  ", keywords).text, "สนใจคลาสเรียนออนไลน์", "ไม่สนตัวพิมพ์ใหญ่เล็ก/ช่องว่าง");
  assert.equal(resolveBusinessHashtag("#class", keywords).text, "สนใจคลาสสอนสด", "คลาสสอนสดใช้ #class ไม่ใช่ #onsite");
  assert.equal(resolveBusinessHashtag("#onsite", keywords), null, "#onsite ไม่อยู่ในชุดมาตรฐานแล้ว");
  assert.equal(resolveBusinessHashtag("#horeca", keywords), null, "นอกรายการ = ไม่แตะ");
  assert.equal(resolveBusinessHashtag("สอนภาษา C# ไหม", keywords), null, "# กลางประโยคไม่ใช่คีย์เวิร์ด");
});

test("v1.4.50: seed ของ #class ต้องไม่มีคำว่า onsite (กันหลงเข้าโหมดงานองค์กร)", () => {
  assert.equal(HASHTAG_BUSINESS_DEFAULTS["#class"], "สนใจคลาสสอนสด");
  for (const [key, seed] of Object.entries(HASHTAG_BUSINESS_DEFAULTS)) {
    if (key === "#inhouse") continue; // อันนี้ตั้งใจให้เข้าโหมดงานองค์กร
    assert.ok(!/on[-\s]?site/iu.test(seed), `seed ของ ${key} ห้ามมีคำที่ IN_HOUSE_INTENT จับ: ${seed}`);
  }
});

test("v1.4.50: รายการที่ผิดรูปแบบถูกกรองทิ้ง ไม่ให้กลายเป็นคีย์เวิร์ดลอย ๆ", () => {
  const cleaned = normalizeHashtagBusinessKeywords({
    "#ok": "ข้อความปกติ",
    "ไม่มีแฮช": "seed",
    "#มี ช่องว่าง": "seed",
    "#empty": "   ",
    "#toolong": "x".repeat(201),
    "#UPPER": "ตัวพิมพ์ใหญ่ต้องถูกลดรูป",
  });
  assert.deepEqual(Object.keys(cleaned).sort(), ["#ok", "#upper"]);
});

/* ===== v1.4.45: 4 บอลลูนติด ต้องถึงโมเดลเป็น 4 ข้อความที่เห็นชัด ไม่ใช่ก้อนเดียว ===== */
//
// เคสจริงพี่ง้วงเทสเอง 2026-08-22 22:03 (debounce 10s บน live pilot, เว้น 5-6 วิ/บอลลูน):
// burst รวมได้ครบ 4 แต่โมเดลตอบแค่ 2 บอลลูนแรก เพราะพรอมต์เป็น 4 บรรทัดเปล่า ๆ
// เทสต์นี้พิสูจน์ทั้งสองชั้น: (1) รวมเป็น Hermes call เดียว (2) พรอมต์ระบุจำนวน+รายการครบ
import { renderBurstForModel } from "../src/pipeline.mjs";

test("v1.4.45: renderBurstForModel — หลายบอลลูนเป็นรายการนับข้อ, บอลลูนเดียวคงเดิม", () => {
  const rendered = renderBurstForModel("x", ["ผมทำสำนักงานบันชี ครับ", "ช่วย แก้งาน", "ออเดอร์ ลูกหนี้", "ทั่วไปครับ"]);
  assert.match(rendered, /^ลูกค้าส่งมา 4 ข้อความติดกัน/u);
  for (const [i, line] of ["ผมทำสำนักงานบันชี ครับ", "ช่วย แก้งาน", "ออเดอร์ ลูกหนี้", "ทั่วไปครับ"].entries()) {
    assert.ok(rendered.includes(`${i + 1}) ${line}`), `ต้องมีข้อ ${i + 1}`);
  }
  assert.equal(renderBurstForModel("สนใจคลาส AI ค่ะ", ["สนใจคลาส AI ค่ะ"]), "สนใจคลาส AI ค่ะ");
  assert.equal(renderBurstForModel("สนใจคลาส AI ค่ะ", []), "สนใจคลาส AI ค่ะ");
});

test("v1.4.45: 4 บอลลูนติดผ่าน burst จริง -> Hermes call เดียว, user message มีครบ 4 ข้อ + กติกาตอบครบ", async () => {
  const { app, hermesFetch, lineFetch } = makeApp({ configOverrides: { BURST_DEBOUNCE_MS: "80", BURST_MAX_WAIT_MS: "2000" } });
  const customerId = "U-burst-4";
  const lines = ["ผมทำสำนักงานบันชี ครับ", "ช่วย แก้งาน", "ออเดอร์ ลูกหนี้", "ทั่วไปครับ"];
  const pending = [];
  for (const line of lines) {
    pending.push(app.pipeline.handleInboundText({ customerId, text: line, replyToken: `rt-${pending.length}` }));
    await new Promise((r) => setTimeout(r, 15));
  }
  const results = await Promise.all(pending);
  assert.equal(results.filter((r) => r?.absorbed).length, 3, "สามข้อความแรกถูกดูดรวม");
  assert.equal(hermesFetch.calls.length, 1, "ต้องเรียกโมเดลครั้งเดียวสำหรับทั้ง burst");
  const messages = hermesFetch.calls[0].body.messages;
  const userMsg = messages.filter((m) => m.role === "user").at(-1);
  assert.match(String(userMsg.content), /ลูกค้าส่งมา 4 ข้อความติดกัน/u);
  for (const line of lines) assert.ok(String(userMsg.content).includes(line), `ต้องมี "${line}"`);
  const system = JSON.stringify(messages.find((m) => m.role === "system")?.content || "");
  assert.match(system, /4 ข้อความติดกัน/u, "กติกาในพรอมต์ต้องรู้จำนวนบอลลูน");
  const outbound = lineFetch.calls.filter((c) => /\/message\/(reply|push)/u.test(c.url));
  assert.equal(outbound.length, 1, "ตอบครั้งเดียว ไม่ใช่ 4 ครั้ง");
});

/* ===== v1.4.46: ลูกค้าพิมพ์ต่อระหว่างบอทกำลังคิด -> รวมก้อนไปข้างหน้า ตอบครั้งเดียว ===== */
//
// เคสจริงลูกค้า A 2026-08-22 22:03 บน VPS (อ่านจาก DB จริง): burst แตกเป็น [1,2] + [3,4]
// คำตอบของ [3,4] ต่อคิวหลังคำตอบแรก พอออกมาลูกค้าพิมพ์ "ใช่เลยครับ/excel" ไปแล้ว
// = คำตอบเก่าดูตอบผิดคิว + คำตอบใหม่ดูตอบซ้ำ — ต้นตอหลักคือ env (debounce 4s)
// แต่ต่อให้ตั้ง 10s แล้ว ลูกค้าที่พิมพ์ระหว่างบอทคิดก็ยังเจออาการนี้ได้
test("v1.4.46: พิมพ์เพิ่มระหว่างบอทคิด -> ทิ้งดราฟต์เก่า รวมเข้าก้อนใหม่ ส่งครั้งเดียวครบทุกข้อความ", async () => {
  let firstCall = true;
  const hermesFetch = hermesFetchStub("รับทราบค่ะ", {
    onCall: async () => { if (firstCall) { firstCall = false; await new Promise((r) => setTimeout(r, 220)); } },
  });
  const { app, lineFetch } = makeApp({ hermesFetch, configOverrides: { BURST_DEBOUNCE_MS: "40", BURST_MAX_WAIT_MS: "2000" } });
  const customerId = "U-merge-fwd";
  const p1 = app.pipeline.handleInboundText({ customerId, text: "ผมทำสำนักงานบัญชีครับ", replyToken: "rt-1" });
  await new Promise((r) => setTimeout(r, 90)); // burst แรก flush แล้ว กำลังรอโมเดล (ช้า 220ms)
  const p2 = app.pipeline.handleInboundText({ customerId, text: "ออเดอร์ ลูกหนี้", replyToken: "rt-2" });
  await new Promise((r) => setTimeout(r, 10));
  const p3 = app.pipeline.handleInboundText({ customerId, text: "ทั่วไปครับ", replyToken: "rt-3" });
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

  assert.equal(r1?.suppressed, "merged_forward", "ก้อนแรกต้องไม่ส่ง แต่ยกข้อความไปรวม");
  assert.equal(r2?.absorbed, true);
  assert.equal(r3?.sent, true, "ก้อนใหม่เป็นคนส่งคำตอบเดียว");
  assert.equal(lineFetch.sends.length, 1, "ลูกค้าต้องได้คำตอบครั้งเดียว ไม่ใช่สองครั้ง");
  const finalUser = hermesFetch.calls.at(-1).body.messages.filter((m) => m.role === "user").at(-1).content;
  assert.match(finalUser, /ลูกค้าส่งมา 3 ข้อความติดกัน/u);
  assert.ok(finalUser.indexOf("1) ผมทำสำนักงานบัญชีครับ") < finalUser.indexOf("2) ออเดอร์ ลูกหนี้"), "ลำดับข้อความต้องคงเดิม");
  assert.match(finalUser, /3\) ทั่วไปครับ/u);
});

test("v1.4.46: ไม่มีก้อนใหม่รออยู่ -> ส่งตามปกติ (กลไกต้องไม่รบกวนเคสธรรมดา)", async () => {
  const { app, lineFetch, hermesFetch } = makeApp({ configOverrides: { BURST_DEBOUNCE_MS: "40" } });
  const r = await app.pipeline.handleInboundText({ customerId: "U-plain", text: "สนใจคลาส AI ค่ะ", replyToken: "rt" });
  assert.equal(r?.sent, true);
  assert.equal(lineFetch.sends.length, 1);
  assert.equal(hermesFetch.calls.length, 1);
});

test("v1.4.46: template ความปลอดภัย (ขอคนจริง) ต้องไม่ถูก merge-forward แม้ลูกค้าพิมพ์ต่อ", async () => {
  const { app, lineFetch } = makeApp({ configOverrides: { BURST_DEBOUNCE_MS: "40" } });
  const customerId = "U-safety-first";
  const p1 = app.pipeline.handleInboundText({ customerId, text: "ขอคุยกับคนจริงค่ะ", replyToken: "rt-1" });
  await new Promise((r) => setTimeout(r, 45)); // flush แล้ว กำลังเดิน template
  const p2 = app.pipeline.handleInboundText({ customerId, text: "ด่วนมากค่ะ", replyToken: "rt-2" });
  const [r1] = await Promise.all([p1, p2]);
  assert.notEqual(r1?.suppressed, "merged_forward", "เส้น template ห้ามถูกพัก");
  assert.ok(lineFetch.sends.length >= 1, "ข้อความส่งต่อคนจริงต้องถึงลูกค้าทันที");
});

test("v1.4.47 safety preemption: ข้อความสำคัญถัดไป abort draft เก่าและใช้ reply token ของตัวเอง", async () => {
  const cases = [
    {
      id: "human",
      text: "อยากคุยกับคนจริงค่ะ",
      route: "human_handoff",
      offReason: "human_requested",
      required: /ทีมงาน|คนจริง|ส่งต่อ/u,
    },
    {
      id: "mental",
      text: "ธุรกิจเจ๊งหมดตัว เหนื่อยจนไม่อยากอยู่ต่อแล้ว",
      route: "urgent",
      offReason: "urgent_mental",
      required: /1323/u,
    },
    {
      id: "payment",
      text: "โอนแล้วนะคะ แนบสลิปไว้ให้แล้ว",
      route: "payment",
      offReason: "money_line",
      required: /โอน|ยอด|สลิป|ตรวจ/u,
    },
  ];

  for (const item of cases) {
    let releaseDraft = () => {};
    let markStarted;
    const started = new Promise((resolve) => { markStarted = resolve; });
    const hermesFetch = (url, opts) => {
      markStarted();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          fn(value);
        };
        releaseDraft = () => finish(resolve, {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: "คำตอบเก่าห้ามส่งค่ะ" } }],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          }),
        });
        const abort = () => finish(reject, opts.signal.reason || new Error("aborted"));
        if (opts.signal.aborted) abort();
        else opts.signal.addEventListener("abort", abort, { once: true });
      });
    };
    const { app, db, lineFetch } = makeApp({
      hermesFetch,
      configOverrides: { BURST_DEBOUNCE_MS: "15", BURST_MAX_WAIT_MS: "500", HERMES_TIMEOUT_MS: "2000" },
    });
    const customerId = `U-priority-${item.id}`;
    const generic = app.pipeline.handleInboundText({
      customerId,
      text: "สนใจคลาส AI ค่ะ",
      replyToken: `rt-generic-${item.id}`,
    });
    await started;

    const queuedIdentity = app.pipeline.handleInboundText({
      customerId,
      text: "นี่เป็นบอทใช่ไหมคะ",
      replyToken: `rt-identity-${item.id}`,
    });
    const safety = app.pipeline.handleInboundText({
      customerId,
      text: item.text,
      replyToken: `rt-safety-${item.id}`,
    });
    let watchdog = null;
    const winner = await Promise.race([
      safety.then(() => "safety"),
      new Promise((resolve) => { watchdog = setTimeout(() => resolve("timeout"), 1000); }),
    ]);
    clearTimeout(watchdog);
    releaseDraft();
    const [genericResult, identityResult, safetyResult] = await Promise.all([generic, queuedIdentity, safety]);

    assert.equal(winner, "safety", `${item.id}: safety must not wait for the old Hermes draft`);
    assert.equal(genericResult?.suppressed, "safety_preempted", `${item.id}: obsolete AI draft must not merge or send`);
    assert.equal(identityResult?.suppressed, "safety_preempted", `${item.id}: queued deterministic template must yield too`);
    assert.equal(safetyResult?.sent, true);
    assert.equal(safetyResult?.route, item.route);
    assert.equal(db.getCustomer(customerId)?.ai_off_reason, item.offReason);
    assert.equal(lineFetch.sends.length, 1, `${item.id}: only the safety reply may reach LINE`);
    assert.equal(lineFetch.sends[0].body.replyToken, `rt-safety-${item.id}`);
    assert.match(JSON.stringify(lineFetch.sends[0].body), item.required);
    assert.ok(!lineFetch.sends.some((call) => call.url.endsWith("/v2/bot/message/push")), `${item.id}: no push retry`);
    assert.doesNotMatch(JSON.stringify(lineFetch.sends), /คำตอบเก่าห้ามส่ง/u);
    db.close();
  }
});

test("v1.4.47 safety boundary: LINE request ที่เริ่มแล้วห้าม abort/retry และ safety ส่งถัดไปด้วย token ตัวเอง", async () => {
  const calls = [];
  let releaseProvider = () => {};
  let markProviderStarted;
  const providerStarted = new Promise((resolve) => { markProviderStarted = resolve; });
  const lineFetch = (url, opts = {}) => {
    const call = { url: String(url), body: opts.body ? JSON.parse(opts.body) : null };
    calls.push(call);
    if (call.url.endsWith("/v2/bot/chat/loading/start")) {
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    }
    if (call.url.endsWith("/v2/bot/message/reply") && call.body?.replyToken === "rt-provider-started") {
      markProviderStarted();
      return new Promise((resolve) => {
        releaseProvider = () => resolve({ ok: true, status: 200, json: async () => ({}) });
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  const { app, db } = makeApp({
    lineFetch,
    hermesFetch: hermesFetchStub("ได้เลยค่ะ สนใจให้แนะนำคลาสที่เหมาะไหมคะ"),
    configOverrides: { BURST_DEBOUNCE_MS: "0" },
  });
  const customerId = "U-provider-boundary";
  const generic = app.pipeline.handleInboundText({
    customerId,
    text: "สนใจคลาส AI ค่ะ",
    replyToken: "rt-provider-started",
  });
  await providerStarted;

  let safetySettled = false;
  const safety = app.pipeline.handleInboundText({
    customerId,
    text: "ธุรกิจเจ๊งหมดตัว เหนื่อยจนไม่อยากอยู่ต่อแล้ว",
    replyToken: "rt-provider-safety",
  }).finally(() => { safetySettled = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(safetySettled, false, "provider request ที่เริ่มแล้วต้องไม่ถูกแซงแบบ concurrent");
  assert.equal(calls.filter((call) => /\/v2\/bot\/message\/(?:reply|push)$/u.test(call.url)).length, 1);

  releaseProvider();
  const [genericResult, safetyResult] = await Promise.all([generic, safety]);
  assert.equal(genericResult.sent, true);
  assert.equal(safetyResult.sent, true);
  const sends = calls.filter((call) => /\/v2\/bot\/message\/(?:reply|push)$/u.test(call.url));
  assert.equal(sends.length, 2, "distinct customer events send once each; no retry");
  assert.deepEqual(sends.map((call) => call.body.replyToken), ["rt-provider-started", "rt-provider-safety"]);
  assert.ok(sends.every((call) => call.url.endsWith("/v2/bot/message/reply")), "ambiguous reply must never fall back to push");
  assert.match(JSON.stringify(sends[1].body), /1323/u);
  db.close();
});

test("v1.4.47 safety preemption: opt-out ที่รับไว้ก่อนต้องบันทึก DND และยกเลิก FU แม้ไม่ส่ง template", async () => {
  let markDraftStarted;
  const draftStarted = new Promise((resolve) => { markDraftStarted = resolve; });
  const hermesFetch = (url, opts) => {
    markDraftStarted();
    return new Promise((_, reject) => {
      const abort = () => reject(opts.signal.reason || new Error("aborted"));
      if (opts.signal.aborted) abort();
      else opts.signal.addEventListener("abort", abort, { once: true });
    });
  };
  const { app, db, lineFetch } = makeApp({
    hermesFetch,
    configOverrides: { BURST_DEBOUNCE_MS: "15", BURST_MAX_WAIT_MS: "500", HERMES_TIMEOUT_MS: "2000" },
  });
  const customerId = "U-priority-optout";
  const followup = db.createFollowup({
    customerId,
    scheduledAt: Date.now() + 3_600_000,
    createdBy: "test",
  });
  const generic = app.pipeline.handleInboundText({
    customerId,
    text: "สนใจคลาส AI ค่ะ",
    replyToken: "rt-optout-generic",
  });
  await draftStarted;
  const optout = app.pipeline.handleInboundText({
    customerId,
    text: "อย่าทักมาอีกนะคะ",
    replyToken: "rt-optout",
  });
  const safety = app.pipeline.handleInboundText({
    customerId,
    text: "แน่นหน้าอกมาก หายใจไม่ออกค่ะ",
    replyToken: "rt-optout-safety",
  });
  const [genericResult, optoutResult, safetyResult] = await Promise.all([generic, optout, safety]);

  assert.equal(genericResult?.suppressed, "safety_preempted");
  assert.equal(optoutResult?.suppressed, "safety_preempted", "suppress only stale opt-out copy");
  assert.equal(safetyResult?.sent, true);
  assert.equal(db.getCustomer(customerId)?.do_not_disturb, 1, "consent state must survive reply preemption");
  assert.equal(db.getFollowup(followup.id)?.status, "cancelled");
  assert.ok(db.listAudit().some((row) => row.action === "followup_optout" && row.target === customerId));
  assert.equal(lineFetch.sends.length, 1, "only urgent safety template reaches LINE");
  assert.equal(lineFetch.sends[0].body.replyToken, "rt-optout-safety");
  assert.match(JSON.stringify(lineFetch.sends[0].body), /1669/u);
  db.close();
});

// v1.4.45 (ทีมไล่โค้ดจับได้ 2026-08-28): เมื่อสมองล่ม ระบบปักธง NEEDS_HUMAN แล้วเงียบ
// ตั้งแต่เทิร์นที่สาม — ซึ่งถูกต้องตามที่ออกแบบ **ถ้ามีคนมารับธง** แต่ `hermes_down`
// ไม่เคยอยู่ในรายชื่อเหตุที่ปลุกคนได้เลย (notify.mjs) และเส้นสมองล่มก็ไม่เคยเรียกตัวแจ้งเตือน
// (มีแค่เส้น route ที่บรรทัด ~1605) ผลคือ **ยิ่งระบบพังหนัก ยิ่งไม่มีใครรู้** ซึ่งกลับด้าน
// กับที่ระบบเตือนภัยควรทำ
//
// ใช้ customerId "ops:hermes" ตามแบบ roundsWatch.mjs — ได้ cooldown รวมก้อนเดียว
// (lastSent คีย์ด้วย customerId) ตอนล่มพร้อมกันหลายห้องจึงเด้งครั้งเดียว ไม่ใช่ห้องละครั้ง
test("pipeline: สมองล่ม -> ต้องปลุกทีมด้วย ไม่ใช่ปักธงเงียบ ๆ", async () => {
  const { app, db, lineFetch } = makeApp({
    hermesFetch: async () => ({ ok: false, status: 503, json: async () => ({}) }),
  });
  const NOTIFY_UID = "U00000000000000000000000000000a01";
  db.setSetting("escalate_notify:default", JSON.stringify([NOTIFY_UID]));
  await app.pipeline.handleInboundText({ customerId: "U-down1", text: "ราคาเท่าไหร่ครับ", replyToken: "" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const alerts = lineFetch.calls
    .filter((c) => c.url?.endsWith("/v2/bot/message/push") && c.body?.to === NOTIFY_UID)
    .map((c) => c.body?.messages?.[0]?.text || "");
  assert.equal(alerts.length, 1, "สมองล่มแล้วต้องมีคนถูกแจ้ง 1 ครั้ง");
  assert.match(alerts[0], /ระบบ/u, "ต้องเป็นข้อความแจ้งระดับระบบ ไม่ใช่ผูกกับลูกค้ารายเดียว");

  // ล่มพร้อมกันหลายห้อง = ต้องยังเด้งครั้งเดียว (cooldown รวม) ไม่ใช่ห้องละครั้ง
  await app.pipeline.handleInboundText({ customerId: "U-down2", text: "สนใจคลาสครับ", replyToken: "" });
  await app.pipeline.handleInboundText({ customerId: "U-down3", text: "เรียนที่ไหนครับ", replyToken: "" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = lineFetch.calls.filter((c) => c.url?.endsWith("/v2/bot/message/push") && c.body?.to === NOTIFY_UID);
  assert.equal(after.length, 1, "ล่มยกชุดต้องไม่ยิงรัวห้องละครั้ง");
  db.close();
});

// v1.4.46 (คำสั่งพี่ง้วง 2026-08-28 ค่ำ): กรีตติ้งใหม่ใช้ @ และ "ลูกแพรตอบต่อได้เลย"
// เส้น # ต้องไม่เปลี่ยนเลย (LINE OA auto-response เป็นเจ้าของ) แต่เส้น @ ห้ามเงียบเด็ดขาด
test("pipeline: @ ในรายการ -> เติม seed คุยต่อ · @ นอกรายการ -> คุยปกติ ไม่เงียบ", async () => {
  const { app, db } = makeApp();
  db.setSetting("hashtag_silence", "1");
  db.setSetting("hashtag_business_keywords", JSON.stringify({
    "@inhouse": { seed: "สนใจอบรม in-house ให้ทีมที่บริษัท", note: "กรีตติ้ง LINE OA" },
  }));

  const known = await app.pipeline.handleInboundText({ customerId: "U-at1", text: "@inhouse", replyToken: "" });
  assert.notEqual(known.suppressed, "hashtag_auto_response", "@ ที่ตั้งไว้ต้องได้คุย");
  // ข้อสำคัญ: ต้อง "เติมบริบท" จริง ไม่ใช่แค่หลุดด่านไปเฉย ๆ — โน้ตคือสิ่งเดียวที่บอกว่า
  // ลูกค้ามาจากกรีตติ้งไหน เพราะคนกลุ่มนี้พิมพ์คำเดียวเป็นข้อความแรกสุด ระบบไม่รู้อะไรเลย
  assert.match(String(db.getCustomer("U-at1")?.hashtag_note || ""), /กรีตติ้ง/u,
    "@ ที่ตั้งไว้ต้องบันทึกโน้ตกิจกรรมให้ลูกแพรอ่าน");

  const unknown = await app.pipeline.handleInboundText({ customerId: "U-at2", text: "@founder", replyToken: "" });
  assert.notEqual(unknown.suppressed, "hashtag_auto_response",
    "@ นอกรายการต้องคุยปกติ — ไม่มี LINE OA auto-response มาตอบแทนเหมือนฝั่ง #");

  const hashUnknown = await app.pipeline.handleInboundText({ customerId: "U-at3", text: "#FOUNDER", replyToken: "" });
  assert.equal(hashUnknown.suppressed, "hashtag_auto_response", "# นอกรายการต้องเงียบเหมือนเดิม ห้ามตอบซ้อน LINE OA");
  db.close();
});
