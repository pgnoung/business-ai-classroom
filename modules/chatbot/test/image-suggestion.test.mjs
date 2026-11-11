// v1.3.4: รูป 5 จาก 7 ใบไม่มี pack entry ไหนอ้างถึงเลย (pack_hits = 0 ทั้งหมด)
// ตั้งแต่เปิดระบบมาส่งจริงแค่ 2 key — บริการอย่าง Private / In-house / Consult
// จึงไม่มีวันมีภาพประกอบไม่ว่าลูกค้าจะถามตรงแค่ไหน
//
// แก้โดยผูกภาพกับ "บริการที่กำลังคุยอยู่" แทนการพึ่งการจับคู่การ์ด ซึ่งตรวจสอบง่ายกว่า
// และไม่ต้อง rebuild แพ็กที่ผ่านการอนุมัติแล้ว
import test from "node:test";
import assert from "node:assert/strict";

import { suggestImageKey, imageOfferRule, namedServicePoster, explicitPosterAsk, explicitPosterNegated } from "../src/imageSuggestion.mjs";
import { resolveClassRouting } from "../src/salesMotion.mjs";

const ALL_KEYS = new Set([
  "ai-agent-for-business", "ai-agent-workflow-automation", "online-custom-gpts",
  "private-class", "in-house-training", "monthly-consult", "flash-consult",
]);

function routedKey(text, history = []) {
  const { product } = resolveClassRouting({ text, history });
  return suggestImageKey(text, product, ALL_KEYS);
}

test("ทั้ง 7 บริการต้องมีทางที่ภาพของตัวเองถูกเสนอได้จริง", () => {
  const reachable = new Set([
    routedKey("ขอรายละเอียดหน่อยครับ", [{ role: "user", content: "ระดับ 2 ครับ" }]),
    routedKey("เนื้อหาสอนอะไรบ้าง", [{ role: "user", content: "ระดับ 5 ครับ" }]),
    routedKey("ราคาเท่าไหร่", [{ role: "user", content: "มา 12 คนครับ" }]),
    routedKey("ราคาเท่าไหร่", [{ role: "user", content: "5 คนครับ" }]),
    routedKey("มีคลาสออนไลน์ไหมครับ"),
    routedKey("สนใจที่ปรึกษารายเดือนครับ"),
    routedKey("ปรึกษารายครั้งได้ไหม"),
  ].filter(Boolean));
  assert.deepEqual([...ALL_KEYS].filter((key) => !reachable.has(key)), [],
    "ต้องไม่มีรูปใบไหนที่ไม่มีทางถูกเสนอเลย");
});

test("ลูกค้าเอ่ยชื่อบริการเอง ต้องชนะผลคัดกรองจากระดับ/จำนวนคน", () => {
  // ลูกค้าระดับ 2 (ปกติชี้ไปคลาสพื้นฐาน) แต่ถามถึงคลาสออนไลน์ตรง ๆ
  const history = [{ role: "user", content: "ระดับ 2 ครับ" }];
  assert.equal(routedKey("มีคลาสออนไลน์แบบดูย้อนหลังไหมครับ", history), "online-custom-gpts");
  assert.equal(routedKey("อยากจัดอบรมทั้งทีมที่ออฟฟิศ", history), "in-house-training");
});

test("ไม่รู้ว่าคุยเรื่องอะไร = ไม่เสนอรูป", () => {
  assert.equal(routedKey("ครับ"), "");
  assert.equal(routedKey("ขอบคุณครับ"), "");
});

test("เสนอได้ครั้งละหนึ่งใบเท่านั้น และห้ามเสนอ key ที่ไม่ได้อนุมัติ", () => {
  const only = new Set(["ai-agent-for-business"]);
  assert.equal(suggestImageKey("สนใจ workflow automation ครับ", null, only), "",
    "key ที่ไม่อยู่ในชุดที่อนุมัติต้องไม่ถูกเสนอ");
  assert.equal(suggestImageKey("อะไรก็ได้", null, new Set()), "", "ไม่มีรูปที่อนุมัติ = ไม่เสนอ");

  const rule = imageOfferRule("private-class");
  assert.match(rule, /\[IMAGE:private-class\]/u);
  assert.match(rule, /ห้ามใส่ marker เกินหนึ่งใบ/u);
  assert.equal(imageOfferRule(""), "", "ไม่มี key = ไม่มีกฎ");
});

test("ลูกค้าขอรูปเอง ถ้อยคำต้องต่างจากการเสนอเชิงรุก", () => {
  assert.match(imageOfferRule("flash-consult", { explicitAsk: true }), /ลูกค้าขอรูปเอง/u);
  assert.match(imageOfferRule("flash-consult"), /ไม่ต้องรอให้ลูกค้าขอ/u);
});

test("v1.3.5: คำกำกวมต้องประกบบริบทเรียนก่อนเสนอรูป", () => {
  // ตรวจปรปักษ์: "ขายออนไลน์" เคยได้รูปคลาสออนไลน์ / "ธุรกิจส่วนตัว" ได้รูป Private Class
  const keys = new Set(["online-custom-gpts", "private-class"]);
  for (const text of ["ผมขายออนไลน์ครับ", "โอนออนไลน์ได้ไหม", "ทำธุรกิจส่วนตัวครับ", "เรื่องส่วนตัวนิดหน่อย"]) {
    assert.equal(suggestImageKey(text, null, keys), "", `ต้องไม่เสนอรูป: ${text}`);
  }
  assert.equal(suggestImageKey("มีคลาสออนไลน์ไหมครับ", null, keys), "online-custom-gpts");
  assert.equal(suggestImageKey("อยากได้คลาสส่วนตัวครับ", null, keys), "private-class");
});

// v1.4.1 (เคสจริง 2026-08-14): ประโยคไทยที่ลูกค้าใช้จริงต้องผ่านทั้ง gate และ pattern บริการ
test("v1.4.1: 'สอนที่บริษัท' เข้าเส้นรูป in-house / บริบททำงานไม่ติด", async () => {
  const { IMAGE_WORTHY_TURN } = await import("../src/pipeline.mjs");
  for (const text of ["แล้วให้ไปสอนที่บริษัท มีไหม", "มีแบบ สอนสด อย่างเดียวเหรอครับ", "สนใจ inhouse", "มีเนื้อหาการสอนมั้ยครับ"]) {
    assert.ok(IMAGE_WORTHY_TURN.test(text), `gate ต้องเปิด: ${text}`);
  }
  for (const text of ["โอนแล้วครับ", "ขอบคุณครับ"]) {
    assert.ok(!IMAGE_WORTHY_TURN.test(text), `gate ต้องปิด: ${text}`);
  }
  const keys = new Set(["in-house-training"]);
  assert.equal(suggestImageKey("แล้วให้ไปสอนที่บริษัท มีไหม", null, keys), "in-house-training");
  assert.equal(suggestImageKey("อยากให้มาอบรมที่ออฟฟิศ", null, keys), "in-house-training");
  assert.equal(suggestImageKey("ผมทำงานที่บริษัทแห่งหนึ่ง", null, keys), "", "บริบททำงานห้ามได้รูปบริการ");
});

// v1.4.1: dedupe รูปจำกัดใน session — รูปจาก session เทรนเก่าห้ามบล็อกบทสนทนาใหม่
test("v1.4.1: recentImageKeys จำกัดต่อ session เมื่อส่ง sessionId", async (t) => {
  const { memoryDb } = await import("./helpers.mjs");
  const db = memoryDb();
  t.after(() => db.close());
  db.upsertCustomer("U-img", {});
  db.insertMessage({ id: "img-old", customerId: "U-img", direction: "out", msgType: "image", content: "[image:ai-agent-for-business] https://x/1.png", sessionId: "S-old" });
  db.insertMessage({ id: "img-new", customerId: "U-img", direction: "out", msgType: "image", content: "[image:private-class] https://x/2.png", sessionId: "S-new" });
  assert.deepEqual(db.recentImageKeys("U-img", 0).sort(), ["ai-agent-for-business", "private-class"], "ไม่ส่ง sessionId = พฤติกรรมเดิม");
  assert.deepEqual(db.recentImageKeys("U-img", 0, "S-new"), ["private-class"], "ส่ง sessionId = เห็นเฉพาะ session นั้น");
});

// ---- v1.4.5 (คำสั่งพี่ง้วง 2026-08-15): ภาพชุดใหม่ + โปสเตอร์คลาสภาคบังคับ ----

test("v1.4.5: จังหวะชำระเงินได้การ์ดบัญชี — จังหวะคุยราคายังไม่ได้", () => {
  const keys = new Set(["payment-kbank", "ai-agent-for-business"]);
  assert.equal(suggestImageKey("โอนยังไงครับ ขอเลขบัญชีหน่อย", null, keys), "payment-kbank");
  assert.equal(suggestImageKey("ชำระเงินยังไงได้บ้างคะ", null, keys), "payment-kbank");
  assert.equal(suggestImageKey("ราคาเท่าไหร่ครับ", null, keys), "", "คุยราคาห้ามได้การ์ดบัญชี");
});

test("v1.4.5: ถามบรรยากาศได้ภาพคลาสจริง และสลับใบที่ยังไม่เคยส่ง", () => {
  const keys = new Set(["classroom-atmosphere-1", "classroom-atmosphere-2"]);
  assert.equal(suggestImageKey("บรรยากาศการเรียนเป็นยังไงคะ", null, keys), "classroom-atmosphere-1");
  assert.equal(
    suggestImageKey("ขอดูห้องเรียนอีกหน่อยค่ะ", null, keys, { sentKeys: ["classroom-atmosphere-1"] }),
    "classroom-atmosphere-2",
    "ใบแรกส่งแล้วต้องเสนอใบที่สอง",
  );
});

test("v1.4.5: เทิร์นแนะนำคลาส = โปสเตอร์ภาคบังคับ (ภาษาปล่อยเลือกทำโมเดลข้ามรูป)", () => {
  assert.match(imageOfferRule("ai-agent-for-business", { mustAttach: true }), /ต้องใส่ marker นี้ในคำตอบเสมอ ห้ามข้าม/u);
  assert.match(imageOfferRule("ai-agent-for-business"), /ไม่ต้องรอให้ลูกค้าขอ/u);
});

// 2026-10-02 (โปสเตอร์จริงชุดใหม่): หัวโปสเตอร์ที่ปรึกษารายเดือนคือ "MONTHLY PRIVATE CONSULT" และพี่ง้วงเรียกว่า
// "Private consult" — คำว่า private เดี่ยว ๆ เคยชนะไปก่อน ลูกค้าที่ถามถึง private consult จึงได้โปสเตอร์ Private Class ผิดใบ
test("2026-10-02: 'private consult' ได้โปสเตอร์ที่ปรึกษารายเดือน ไม่ใช่ Private Class", () => {
  assert.equal(suggestImageKey("สนใจ Private Consult ค่ะ", null, ALL_KEYS), "monthly-consult");
  assert.equal(suggestImageKey("ขอรายละเอียด monthly private consult หน่อยครับ", null, ALL_KEYS), "monthly-consult");
  assert.equal(suggestImageKey("private consulting ราคาเท่าไหร่", null, ALL_KEYS), "monthly-consult");
  // Private Class และ Flash Consult ยังได้ภาพของตัวเองเหมือนเดิม
  assert.equal(suggestImageKey("สนใจ private class ครับ", null, ALL_KEYS), "private-class");
  assert.equal(suggestImageKey("อยากได้คลาสส่วนตัวครับ", null, ALL_KEYS), "private-class");
  assert.equal(suggestImageKey("สนใจ flash consult ครับ", null, ALL_KEYS), "flash-consult");
});

// 2026-10-03 (พี่ง้วงทดลองจริงจาก LINE "สนใจ Private Class" แล้วได้แต่ข้อความ ไม่มีโปสเตอร์):
// โปสเตอร์บริการถูกเสนอแบบ "ทางเลือก" และเทิร์นงาน project ยังสั่งห้ามตัวเลขราคา โมเดลจึงข้ามรูปทุกครั้ง
// ลูกค้าเอ่ยชื่อบริการเองแบบไม่กำกวม = โปสเตอร์ของบริการนั้นเป็นภาคบังคับ (แบบเดียวกับโปสเตอร์คลาส v1.4.5)
test("2026-10-03: ลูกค้าเอ่ยชื่อบริการเอง โปสเตอร์ของบริการนั้นเป็นภาคบังคับ", async () => {
  const { baseRules } = await import("../src/pipeline.mjs");
  const allowed = { approvedImageKeys: new Set([...ALL_KEYS]) };
  // ไม่ใช่ข้อความแรก (กันกติกาบันได 7 Stage ปนผล)
  const history = [{ role: "user", content: "สวัสดีค่ะ" }, { role: "assistant", content: "สวัสดีค่ะ ยินดีให้ข้อมูลนะคะ" }];
  const mustOffer = (key) => new RegExp(`\\[IMAGE:${key}\\][^\\n]*ต้องใส่ marker นี้ในคำตอบเสมอ ห้ามข้าม`, "u");
  for (const [text, key] of [
    ["สนใจ Private Class", "private-class"],
    ["มี in-house ไหมคะ", "in-house-training"],
    ["สนใจที่ปรึกษารายเดือนค่ะ", "monthly-consult"],
    ["สนใจ Private Consult ค่ะ", "monthly-consult"],
    ["Flash consult คืออะไรคะ", "flash-consult"],
  ]) {
    assert.match(baseRules("general", [], { currentText: text, history, ...allowed }), mustOffer(key), text);
  }
  const MUST = /ต้องใส่ marker นี้ในคำตอบเสมอ ห้ามข้าม/u;
  // รีวิว 2026-10-03: คำหลวม ๆ ห้ามบังคับรูป — ชื่อขนส่ง/รายงาน/ลูกค้าเก่าถามซัพพอร์ต/ขอบคุณ/ขอเลื่อน/ขอไม่เอารูป
  // และโปสเตอร์คลาสออนไลน์ (4,900) ไม่บังคับเลย ให้โมเดลตัดสินจากบริบท (กัน downgrade)
  for (const text of [
    "ร้านผมส่งของด้วย Flash Express ครับ สนใจคลาส AI",
    "อยากให้ AI ทำ monthly report ค่ะ",
    "ซื้อคลาสออนไลน์ไปแล้วค่ะ เข้าดูที่ไหนคะ",
    "ขอบคุณมากค่ะ ได้ข้อมูล in-house ครบแล้วค่ะ",
    "ขอเลื่อน private class ค่ะ",
    "ไม่ต้องส่งรูปนะคะ ขอข้อมูล Private Class เป็นข้อความ",
    "มีคลาสออนไลน์ไหมครับ",
    "สนใจ private-consult ค่ะ",
  ]) {
    assert.doesNotMatch(baseRules("general", [], { currentText: text, history, ...allowed }), /\[IMAGE:(?:private-class|in-house-training|flash-consult|online-custom-gpts)\][^\n]*ต้องใส่ marker/u, text);
  }
  // ปฏิเสธบริการนั้น = ห้ามบังคับรูป
  assert.doesNotMatch(baseRules("general", [], { currentText: "ไม่สนใจ private class ค่ะ ขอคลาสปกติ", history, ...allowed }), MUST);
  // "ที่ปรึกษา" เดี่ยว ๆ กำกวม (ลูกค้าเป็นที่ปรึกษาเอง) = ห้ามบังคับโปสเตอร์ที่ปรึกษารายเดือน
  assert.doesNotMatch(baseRules("general", [], { currentText: "สนใจคลาส AI ครับ ผมเป็นที่ปรึกษาด้านการเงิน", history, ...allowed }), MUST);
  // เดาบริการจากจำนวนคน (ลูกค้าไม่ได้เอ่ยชื่อ) = ยังเป็นทางเลือกเหมือนเดิม
  assert.doesNotMatch(baseRules("general", [], {
    currentText: "ราคาเท่าไหร่ครับ", history: [...history, { role: "user", content: "มากัน 5 คนครับ" }], ...allowed,
  }), MUST);
});

// โปสเตอร์คลาสออนไลน์ของจริงมี 4,900 ตัวใหญ่ — ลูกค้าที่คุยเส้นสอนสดมาแล้ว (บอทเสนอ 12,900) ห้ามได้รูปนี้
// เพราะคือการเทราคาออนไลน์เดี่ยวให้ downgrade เอง (กติกา v1.4.9 เคสเสียเงินจริง 2026-08-17) เว้นแต่ขอรูปเอง
test("2026-10-03: เส้นสอนสดมาแล้ว ห้ามเสนอโปสเตอร์คลาสออนไลน์ (กัน downgrade) เว้นแต่ลูกค้าขอรูปเอง", async () => {
  const { baseRules } = await import("../src/pipeline.mjs");
  const allowed = { approvedImageKeys: new Set([...ALL_KEYS]) };
  const livePath = [
    { role: "user", content: "สนใจคลาส AI Agent for Business ค่ะ" },
    { role: "assistant", content: "คลาสสอนสด AI Agent for Business ราคา Early Bird 12,900 บาท/ท่านค่ะ" },
  ];
  assert.doesNotMatch(baseRules("general", [], { currentText: "มีคลาสออนไลน์ไหมคะ", history: livePath, ...allowed }), /\[IMAGE:online-custom-gpts\]/u);
  assert.doesNotMatch(baseRules("general", [], { currentText: "คลาสออนไลน์ราคาเท่าไหร่คะ", history: livePath, ...allowed }), /\[IMAGE:online-custom-gpts\]/u);
  assert.match(baseRules("general", [], { currentText: "ขอรูปคลาสออนไลน์หน่อยค่ะ", history: livePath, ...allowed }), /\[IMAGE:online-custom-gpts\]/u);
  // รีวิว 2026-10-03: ต้นกรวยยังไม่มีตัวเลขราคาสอนสดในประวัติ แต่ลูกค้าเพิ่งพูดถึงคลาสสอนสดเอง = เส้นสอนสดเหมือนกัน
  const earlyLive = [
    { role: "user", content: "สนใจ AI Agent for Business สอนสดที่สถาบันค่ะ" },
    { role: "assistant", content: "ได้เลยค่ะ ตอนนี้ใช้ AI ช่วยงานด้านไหนอยู่บ้างคะ" },
  ];
  assert.doesNotMatch(baseRules("general", [], { currentText: "คลาสออนไลน์ราคาเท่าไหร่คะ", history: earlyLive, ...allowed }), /\[IMAGE:online-custom-gpts\]/u);
  assert.doesNotMatch(baseRules("general", [], { currentText: "คลาสออนไลน์กับที่ไปนั่งเรียนสด เนื้อหาเหมือนกันมั้ยคะ", history: [], ...allowed }), /\[IMAGE:online-custom-gpts\]/u);
  // "ภาพรวม" ไม่ใช่การขอรูป — ห้ามปลดด่านกัน downgrade
  assert.doesNotMatch(baseRules("general", [], { currentText: "ขอภาพรวมคลาสออนไลน์หน่อยค่ะ", history: livePath, ...allowed }), /\[IMAGE:online-custom-gpts\]/u);
  assert.doesNotMatch(baseRules("general", [], { currentText: "ขอรูปแบบคลาสออนไลน์หน่อยค่ะ ราคาเท่าไหร่", history: livePath, ...allowed }), /\[IMAGE:online-custom-gpts\]/u);
});

// รีวิว 2026-10-03 รอบ 3 (HIGH): โปสเตอร์ที่ระบบแนบเองเรียกคืนไม่ได้ — คำปฏิเสธรูปทุกแบบต้องหยุดมัน
test("2026-10-03 (รอบ 3): ลูกค้าไม่เอารูป / ลูกค้าเก่าที่จองแล้ว / ขอย้ายรอบ -> ไม่บังคับโปสเตอร์", () => {
  for (const text of [
    "ไม่ต้องแนบรูปนะคะ สนใจ Private Class",
    "อย่าส่งโปสเตอร์นะคะ ขอรายละเอียด Flash consult",
    "ไม่อยากดูรูปค่ะ ขอข้อมูลที่ปรึกษารายเดือน",
    "ขอเป็นข้อความอย่างเดียวนะคะ in-house มีแบบไหนบ้าง",
    "ขอแค่ข้อความพอค่ะ Private Class ราคาเท่าไหร่",
    "ลงทะเบียน private class ไว้แล้วค่ะ ต้องเตรียมอะไรบ้าง",
    "จอง in-house ไว้แล้วนะคะ วันไหนทีมจะโทรมา",
    "ขอเปลี่ยนวัน private class ได้ไหมคะ",
    "ขอย้ายรอบ private class ค่ะ",
  ]) {
    assert.equal(namedServicePoster(text, ALL_KEYS), "", text);
  }
  // "อย่าลืมส่งรูป" คือการขอ ไม่ใช่ปฏิเสธ
  assert.equal(explicitPosterNegated("อย่าลืมส่งรูป Private Class ให้ด้วยนะคะ"), false);
  assert.equal(namedServicePoster("อย่าลืมส่งรายละเอียด Private Class ให้ด้วยนะคะ", ALL_KEYS), "private-class");
  assert.equal(explicitPosterNegated("ไม่ต้องส่งรูปนะคะ"), true);
});

// รีวิว 2026-10-03 รอบ 3 (HIGH): คำนามลอย ๆ ไม่ใช่การขอรูป — ปลดด่านกัน downgrade ได้เฉพาะคำขอจริง
test("2026-10-03 (รอบ 3): explicitPosterAsk ต้องมีกริยาขอ/ดู/ส่ง/มี และไม่ปฏิเสธรูป", () => {
  for (const text of ["ขอรูปคลาสออนไลน์หน่อยค่ะ", "มีโปสเตอร์คลาสออนไลน์ไหมคะ", "ขอดูภาพคลาสออนไลน์ค่ะ", "ส่งรูปให้ดูหน่อย", "อยากเห็นรูปคลาสออนไลน์ค่ะ"]) {
    assert.equal(explicitPosterAsk(text), true, text);
  }
  for (const text of [
    "ภาพรวมคลาสออนไลน์เป็นยังไงคะ",
    "รูปแบบคลาสออนไลน์เป็นยังไงคะ",
    "โปสเตอร์คลาสสอนสดสวยดีค่ะ คลาสออนไลน์ล่ะคะ",
    "อยากเห็นภาพว่าคลาสออนไลน์เอาไปใช้ยังไง",
    "ไม่ต้องส่งรูปนะคะ ขอข้อมูลคลาสออนไลน์",
  ]) {
    assert.equal(explicitPosterAsk(text), false, text);
  }
});

// รีวิว 2026-10-03 รอบ 3 (LOW): "ขอรูปคลาสออนไลน์" เคยได้รูปบรรยากาศห้องเรียนสดแทนโปสเตอร์คลาสออนไลน์
test("2026-10-03 (รอบ 3): ขอรูปคลาสออนไลน์ = โปสเตอร์คลาสออนไลน์ ไม่ใช่รูปบรรยากาศ", () => {
  const withAtmosphere = new Set([...ALL_KEYS, "classroom-atmosphere-1", "classroom-atmosphere-2"]);
  assert.equal(suggestImageKey("ขอรูปคลาสออนไลน์หน่อยค่ะ", null, withAtmosphere), "online-custom-gpts");
  assert.equal(suggestImageKey("ขอรูปคลาส online หน่อยค่ะ", null, withAtmosphere), "online-custom-gpts");
  assert.equal(suggestImageKey("ขอรูปคลาสหน่อยค่ะ", null, withAtmosphere), "classroom-atmosphere-1");
});

// รีวิว 2026-10-03 รอบ 3 (MEDIUM): "ขอภาพรวม" / "ไม่ต้องส่งรูป" เคยถูกนับเป็น "ลูกค้าขอรูปเอง"
test("2026-10-03 (รอบ 3): customerAsksForImage — ภาพรวมและคำปฏิเสธรูปไม่ใช่การขอรูป", async () => {
  const { customerAsksForImage, decideImageOffer } = await import("../src/pipeline.mjs");
  assert.equal(customerAsksForImage("ขอรูปหน่อยค่ะ"), true);
  assert.equal(customerAsksForImage("ขอดูโปสเตอร์ private class ค่ะ"), true);
  assert.equal(customerAsksForImage("ขอภาพรวมคลาส AI Agent หน่อยค่ะ"), false);
  assert.equal(customerAsksForImage("ไม่ต้องส่งรูปซ้ำนะคะ ขอราคา private class"), false);
  // เคยส่งโปสเตอร์ไปแล้ว + ลูกค้าแค่ขอภาพรวม = ไม่ส่งซ้ำ (ไม่ปลดตัวกันรูปซ้ำ)
  const history = [{ role: "user", content: "สวัสดีค่ะ" }, { role: "assistant", content: "สวัสดีค่ะ" }];
  const offer = decideImageOffer({
    currentText: "ขอภาพรวมรายละเอียดคลาส AI Agent for Business หน่อยค่ะ", history,
    allowedImages: ALL_KEYS, sentImageKeys: ["ai-agent-for-business"],
  });
  assert.equal(offer, null);
});

// รีวิว 2026-10-03 รอบ 4: NO_MEDIA ผิดสองทาง ("ตัวอย่างรูป" = ปฏิเสธ / "ไม่อยากให้ส่งรูป" = ไม่ปฏิเสธ),
// ลูกค้าที่จอง/สมัคร/โอนแล้วโดยไม่มี "ไว้/ไป" ยังโดนบังคับโปสเตอร์, "คุณภาพ" นับเป็นขอรูป, ปฏิเสธรูปแล้วพรอมต์ยังเสนอรูป
test("2026-10-03 (รอบ 4): คำปฏิเสธรูป / ลูกค้าที่ซื้อแล้ว / คำที่มี ภาพ แต่ไม่ใช่รูป", async () => {
  const { customerAsksForImage, decideImageOffer } = await import("../src/pipeline.mjs");
  // "ตัวอย่าง" ไม่ใช่ "อย่า"
  for (const text of ["ขอดูตัวอย่างรูป Private Class หน่อยค่ะ", "ขอตัวอย่างโปสเตอร์ Private Class ค่ะ", "มีตัวอย่างภาพ Private Class ไหมคะ"]) {
    assert.equal(explicitPosterNegated(text), false, text);
    assert.equal(customerAsksForImage(text), true, text);
    assert.equal(namedServicePoster(text, ALL_KEYS), "private-class", text);
  }
  // คำปฏิเสธที่มีคำคั่นยาวกว่าเดิม — แต่ไม่ข้ามช่องว่าง ("ไม่ต้องรอ ขอรูป" คือการขอ)
  for (const text of [
    "ไม่อยากให้ส่งรูปค่ะ ขอข้อมูล Private Class", "ไม่ต้องส่งเป็นรูป Private Class ค่ะ", "อย่าส่งเป็นรูปนะคะ Private Class",
    "ไม่ต้องรบกวนส่งรูป Private Class ค่ะ", "ไม่จำเป็นต้องส่งรูป Private Class ค่ะ", "ขอเฉพาะข้อความ Private Class ค่ะ",
    "Private Class ส่งเป็นข้อความพอค่ะ",
  ]) {
    assert.equal(explicitPosterNegated(text), true, text);
    assert.equal(customerAsksForImage(text), false, text);
    assert.equal(namedServicePoster(text, ALL_KEYS), "", text);
  }
  assert.equal(explicitPosterNegated("ไม่ต้องรอ ขอรูป Private Class เลยค่ะ"), false);
  // ลูกค้าที่จอง/สมัคร/โอน/ชำระแล้ว หรือขอเปลี่ยน/ย้าย/สลับรอบ = ไม่ใช่จังหวะยื่นโปสเตอร์
  for (const text of [
    "จอง Private Class แล้วค่ะ", "สมัคร Private Class แล้วค่ะ ต้องเตรียมอะไรบ้าง", "โอนเงินค่า Private Class แล้วค่ะ ส่งสลิปตรงไหนคะ",
    "ชำระเงินค่า Private Class แล้วนะคะ", "ขอเปลี่ยนรอบ private class ค่ะ", "ขอย้ายวัน private class ได้ไหมคะ", "ขอสลับรอบ private class ค่ะ",
  ]) {
    assert.equal(namedServicePoster(text, ALL_KEYS), "", text);
  }
  // คุณภาพ/ประสิทธิภาพ/สุขภาพ/ภาพลักษณ์ ไม่ใช่การขอรูป — ห้ามปลดตัวกันรูปซ้ำ
  for (const text of ["ขอเรียน Private Class ที่เน้นคุณภาพนะคะ", "อยากเพิ่มประสิทธิภาพทีม", "ดูแลสุขภาพ", "สร้างภาพลักษณ์แบรนด์"]) {
    assert.equal(customerAsksForImage(text), false, text);
  }
  const history = [{ role: "user", content: "สวัสดีค่ะ" }, { role: "assistant", content: "สวัสดีค่ะ" }];
  assert.equal(decideImageOffer({ currentText: "ขอเรียน Private Class ที่เน้นคุณภาพนะคะ", history, allowedImages: ALL_KEYS, sentImageKeys: ["private-class"] }), null);
  // ลูกค้าบอกไม่เอารูป = พรอมต์ไม่เสนอรูปเลย (เดิมยังบอกโมเดลว่าแนบได้)
  assert.equal(decideImageOffer({ currentText: "ไม่ต้องแนบรูปนะคะ สนใจ Private Class", history, allowedImages: ALL_KEYS }), null);
});

// รีวิว 2026-10-03 รอบ 5: "แล้ว" ที่เป็นคำเชื่อม ("จองยังไง แล้วต้องจ่ายเลยไหม") ไม่ใช่ "ซื้อแล้ว" ·
// "ไม่ต้องส่งรูปสลิป" คือสลิปของลูกค้า ไม่ใช่ปฏิเสธรูปของเรา — การ์ดช่องทางชำระเงินต้องยังเสนอได้
test("2026-10-03 (รอบ 5): แล้ว-คำเชื่อมยังเป็นลูกค้าใหม่ · รูปสลิปของลูกค้าไม่ใช่คำปฏิเสธรูป", async () => {
  const { decideImageOffer } = await import("../src/pipeline.mjs");
  for (const text of [
    "สนใจ Private Class ค่ะ จองยังไงแล้วต้องจ่ายเลยไหม", "อยากจอง Private Class ค่ะ แล้วราคาเท่าไหร่",
    "Private Class สมัครยังไงคะ แล้วต้องเตรียมอะไร",
  ]) {
    assert.equal(namedServicePoster(text, ALL_KEYS), "private-class", text);
  }
  for (const text of ["จอง Private Class แล้วค่ะ", "โอนเงินค่า Private Class แล้วค่ะ", "ชำระค่า Private Class ไปแล้วครับ", "สมัคร Private Class แล้ว ต้องเตรียมอะไรคะ"]) {
    assert.equal(namedServicePoster(text, ALL_KEYS), "", text);
  }
  const keys = new Set([...ALL_KEYS, "payment-kbank"]);
  const history = [{ role: "user", content: "สวัสดีค่ะ" }, { role: "assistant", content: "สวัสดีค่ะ" }];
  assert.equal(explicitPosterNegated("โอนแล้วไม่ต้องส่งรูปสลิปใช่ไหมคะ ขอเลขบัญชีค่ะ"), false);
  assert.equal(decideImageOffer({ currentText: "โอนแล้วไม่ต้องส่งรูปสลิปใช่ไหมคะ ขอเลขบัญชีค่ะ", history, allowedImages: keys })?.key, "payment-kbank");
});
