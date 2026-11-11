// identity-link-classes — คลาสที่ลูกค้าซื้อ (ตามคำตอบพี่ง้วง 28 ก.ย. ~21:30) · ฟังก์ชันบริสุทธิ์ล้วน
// ข้อความเชิญแยกออนไลน์/สอนสด · ชื่อแบบสั้น · ข้อความหลังเชื่อม = "สวัสดีค่ะ คุณ{ชื่อ} 🙏" + ข้อความของคลาส
// ข้อความของคลาสแตกบับเบิลไม่เกิน 5 ตามขีดจำกัด LINE · ค่าเริ่มต้นมาจากคลังที่อนุมัติ ไม่มีราคา
import test from "node:test";
import assert from "node:assert/strict";
import {
  IDENTITY_CLASSES, IDENTITY_CLASS_TYPES, IDENTITY_TEMPLATE_DEFAULTS, IDENTITY_TEMPLATE_LIMITS,
  classTypeFromText, identityInviteBubbles, identityInviteText, identityWelcomeBubbles, normalizeClassType, splitTemplateBubbles,
  validateTemplateText, welcomeFallbackText,
} from "../src/identityLinkClasses.mjs";
import * as codes from "../src/identityLinkCodes.mjs";
import { MAX_BUBBLES_PER_REPLY } from "../src/lineClient.mjs";

const URL = "https://line.me/R/oaMessage/%40lukprae/?LK-7KQ9M-4XW2P";
const CODE = "LK-7KQ9M-4XW2P";

test("ชนิดคลาส: หกแบบตามที่ทีมเลือก (ออนไลน์ FB/LINE รุ่นเก่าอยู่ท้าย) · ค่าอื่น = ว่าง", () => {
  assert.deepEqual([...IDENTITY_CLASS_TYPES], ["online", "live_business", "live_workflow", "live_private", "online_fb", "online_line"]);
  for (const type of ["online", "online_fb", "online_line"]) assert.equal(IDENTITY_CLASSES[type].format, "online");
  for (const type of ["live_business", "live_workflow", "live_private"]) assert.equal(IDENTITY_CLASSES[type].format, "live");
  assert.match(IDENTITY_CLASSES.online.hint, /สร้างกองทัพ AI ด้วย Custom GPTs/u, "การ์ดที่อนุมัติยังเรียกคอร์สออนไลน์ชื่อนี้");
  assert.equal(normalizeClassType("live_business"), "live_business");
  assert.equal(normalizeClassType(" LIVE_business "), "", "ไม่เดา — ต้องเป็นค่าตรงตัว");
  assert.equal(normalizeClassType("lead"), "");
});

test("อ่านคลาสจากชื่อสินค้า/ป้าย (ของจริงในฐาน): เรียงความสำคัญ private > workflow > online > business · consult/ส่วนลด/โบนัสไม่ใช่คลาส", () => {
  const cases = [
    ["Classroom AI Agent for business", "live_business"],
    ["Classroom AI Agent For Business", "live_business"],
    ["Classroom AI Agent Workflow Automation", "live_workflow"],
    ["In-house training: AI Agent for Business", "live_private"],
    ["In-house training: 2Day", "live_private"],
    ["Online Custom GPTs — Early Bird", "online"],
    ["สนใจ: AI Agent for Business Online", "online"],
    ["สนใจ: AI Agent for Business", "live_business"],
    ["สนใจ: AI Workflow Automation", "live_workflow"],
    ["สนใจ: Private Class", "live_private"],
    ["สนใจ: In-house", "live_private"],
    ["สนใจ AI Agent", "live_business"],
    ["สนใจเรียนออนไลน์", "online"],
    ["คลาสออนไลน์", "online"],
    ["Workflow Automation", "live_workflow"],
    ["ซื้อแล้ว: Classroom AI Agent Workflow Automation", "live_workflow"],
    // ป้ายราคาที่อนุมัติจริง (approved_prices) — ชื่อที่ scorer/ทีมใช้บนออเดอร์
    ["AI Agent Workflow Automation — หลังส่วนลดนักเรียนเก่า Online", "live_workflow"],
    ["AI Agent Workflow Automation — Early Bird", "live_workflow"],
    ["Re-learn เรียนเอง AI Agent for Business (50% จาก Early Bird 12,900)", "live_business"],
    ["Online Custom GPTs — ราคาปกติ", "online"],
    ["Private Class — โปรโมชั่น (ไม่เกิน 4 ท่านแรก/วัน)", "live_private"],
    ["In-house Training — โปรโมชั่น (ไม่เกิน 10 ท่านแรก/วัน)", "live_private"],
    ["สนใจGEN AI Classroom", "live_business"],
    ["สนใจAIAdvance stage6", "live_workflow"],
    ["สนใจ GEN AI Online", "online"],
    ["สนใจ Make", "live_workflow"],
    ["สนใจ Line Private", "live_private"],
    // 30 ก.ย. 2026 (พี่ง้วง: ออนไลน์อาจมี fb หรือ LINE นิดหน่อย): คอร์สออนไลน์รุ่นเก่าเป็นคลาสของตัวเอง ไม่ใช่ออนไลน์ AI
    ["สนใจ Line Online", "online_line"],
    ["Line Online 23", "online_line"],
    ["สนใจ FB Online", "online_fb"],
    ["คอร์สออนไลน์ยิงแอด", "online_fb"],
    ["Facebook Ads Online", "online_fb"],
    ["LINE OA Online", "online_line"],
  ];
  for (const [text, want] of cases) assert.equal(classTypeFromText(text), want, text);
  for (const text of ["ค่าเดินทาง", "สนใจ: Consult", "สนใจ: วิทยากร", "ยังไม่สนใจคลาส", "customer", "ซื้อครั้งที่: 1",
    "Bundle 2 คลาสรูมพร้อมกัน", "คลาสฟรี", "",
    "Monthly Private Consult 1 เดือน", "Flash Consult 2 ชั่วโมง", "สนใจ monthly consult", "มูลค่าโบนัส 100 Prompts",
    "ส่วนลดนักเรียนเก่า / Re-learn กรณีส่งทีมงานมาเรียน", "Classroom (ทั้ง 2 คลาส) — ราคาปกติ", "Bundle — ราคารวมก่อนลด"]) {
    assert.equal(classTypeFromText(text), "", `ไม่ใช่หลักฐานคลาส: "${text}"`);
  }
});

// 30 ก.ย. 2026 (พี่ง้วง: "ปรับคำพูดให้เหมาะกับการที่ให้ลูกค้าจะแอดไลน์เข้าไป"): บอกชื่อคลาส · ทำไมต้องไป LINE · ทำตามสองขั้น
test("ข้อความเชิญ: ชื่อคลาสที่ซื้อ · ออนไลน์ = ลงทะเบียนเข้าเรียนที่ LINE · สอนสด = เตรียมตัว/เอกสาร/กลุ่ม support · สองขั้นตอนชัด", () => {
  const online = identityInviteText({ classType: "online", code: CODE, basicId: "@lukprae", displayName: "Malee Sukjai" });
  assert.equal(online, [
    "ขอบคุณที่ลงทะเบียนคลาส AI Agent for Business Online กับพี่ง้วงนะคะ 🙏",
    "ขั้นตอนลงทะเบียนเข้าเรียนและกลุ่ม support อยู่ที่ LINE ค่ะ",
    "",
    "👉 รบกวนคุณMalee แอดไลน์ @lukprae แล้วส่งรหัสนี้มาในแชทนะคะ",
    `รหัส: ${CODE}`,
    "",
    "หรือกดลิงก์ด้านล่าง ระบบใส่รหัสให้แล้ว กด \"ส่ง\" ได้เลยค่ะ",
  ].join("\n"));
  // 30 ก.ย. 2026 เช้า (พี่ง้วง: "ยาวไป คนไม่สังเกต ไม่ดู ... ส่งเป็น 2 บอลลูน"): คำเชิญสั้นที่มีรหัส + ลิงก์ล้วนอีกบอลลูน
  assert.deepEqual(identityInviteBubbles(online, URL), [online, URL]);
  const live = identityInviteText({ classType: "live_workflow", code: CODE, basicId: "@lukprae", knownName: "นางสาวมาลี ใจดี" });
  const lines = live.split("\n");
  assert.equal(lines[0], "ขอบคุณที่ลงทะเบียนคลาส AI Agent Workflow Automation กับพี่ง้วงนะคะ 🙏");
  assert.equal(lines[1], "รายละเอียดการเตรียมตัวก่อนเรียนและกลุ่ม support อยู่ที่ LINE ค่ะ");
  assert.equal(lines[3], "👉 รบกวนคุณมาลี แอดไลน์ @lukprae แล้วส่งรหัสนี้มาในแชทนะคะ", "ชื่อต้นคำเดียว ไม่มีคำนำหน้า/นามสกุล");
  const fb = identityInviteText({ classType: "online_fb", code: CODE, basicId: "@lukprae", knownName: "มาลี" });
  assert.match(fb, /^ขอบคุณที่ลงทะเบียนคลาส Facebook Ads Online กับพี่ง้วงนะคะ/u);
  assert.match(fb, /ขั้นตอนลงทะเบียนเข้าเรียนและกลุ่ม support/u);
  const line = identityInviteText({ classType: "online_line", code: CODE, basicId: "@lukprae", knownName: "มาลี" });
  assert.match(line, /^ขอบคุณที่ลงทะเบียนคลาส LINE OA Online กับพี่ง้วงนะคะ/u);
  const relational = identityInviteText({ classType: "live_private", code: CODE, basicId: "@lukprae", displayName: "พี่ต้น" });
  assert.match(relational, /รบกวนพี่ต้น แอดไลน์/u);
  assert.match(relational, /^ขอบคุณที่ลงทะเบียน Private Class \/ In-house กับพี่ง้วงนะคะ/u);
  const anonymous = identityInviteText({ classType: "live_business", code: CODE, basicId: "@lukprae", displayName: "Shop Official 2024" });
  assert.match(anonymous, /\n👉 รบกวนแอดไลน์ @lukprae แล้วส่งรหัสนี้มาในแชทนะคะ\n/u, "ไม่รู้ชื่อ = ตัด \"คุณ{ชื่อ}\" ออกแบบเป็นธรรมชาติ");
  assert.doesNotMatch(anonymous, /คุณลูกค้า|คุณ\s|undefined/u);
  for (const text of [online, live, fb, line, relational, anonymous]) {
    // ชื่อคลาสมีคำว่า AI ได้ — แต่ข้อความจากเพจห้ามเร่ง และห้ามพูดถึงบอท
    assert.doesNotMatch(text, /ด่วน|รีบ|ภายในวันนี้|หมดเขต|ลูกแพร|บอท/u);
    assert.ok(text.length < 360, "บอลลูนแรกสั้น อ่านจบในหนึ่งจอ (พี่ง้วง: ยาวไป คนไม่ดู)");
    assert.ok(text.includes(`รหัส: ${CODE}`) && !text.includes("http"), "รหัสอยู่บอลลูนแรก · ลิงก์ไปอยู่บอลลูนที่สอง");
  }
  assert.equal(identityInviteText({ classType: "lead", url: URL, code: CODE, basicId: "@lukprae" }), "", "ไม่มีข้อความเชิญลูกค้าที่ยังไม่ซื้ออีกแล้ว");
  assert.equal(codes.identityLinkInviteText, undefined, "ข้อความเชิญแบบเดิม (buyer/lead) ถูกถอดออก");
  assert.equal(codes.IDENTITY_LINK_CONFIRM_TEXT, undefined);
  assert.equal(codes.IDENTITY_LINK_RETRY_TEXT, undefined, "รหัสใช้ไม่ได้ = ไม่ตอบลูกค้าเลย");
});

test("แตกบับเบิล: --- = บับเบิลใหม่ · ยาวเกินแตกตามย่อหน้า · เกิน 5 บับเบิล = บันทึกไม่ได้", () => {
  assert.deepEqual(splitTemplateBubbles("ก\n---\nข\n\n---\n\n  ค  "), ["ก", "ข", "ค"]);
  assert.deepEqual(splitTemplateBubbles("  \n---\n "), []);
  const para = "ย่อหน้า ".repeat(150).trim();
  const long = [para, para, para].join("\n\n");
  const parts = splitTemplateBubbles(long);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((part) => part.length <= IDENTITY_TEMPLATE_LIMITS.bubbleChars));
  assert.equal(parts.join("\n\n"), long, "แตกตามย่อหน้า ไม่ตัดกลางคำ");
  assert.deepEqual(validateTemplateText("ก\u0000ข\r\nค"), { ok: true, text: "กข\nค", bubbles: ["กข\nค"], error: "" });
  const six = Array.from({ length: 6 }, (_, i) => `ข้อ ${i + 1}`).join("\n---\n");
  const tooMany = validateTemplateText(six);
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error, /5 ข้อความ/u);
  const huge = validateTemplateText("ก".repeat(IDENTITY_TEMPLATE_LIMITS.totalChars + 1));
  assert.equal(huge.ok, false);
  assert.deepEqual(validateTemplateText("   "), { ok: true, text: "", bubbles: [], error: "" }, "ว่าง = ยังไม่มีข้อความ (บันทึกได้)");
});

test("หลังเชื่อม: \"สวัสดีค่ะ คุณ{ชื่อ} 🙏\" + ข้อความของคลาส · ว่าง = บอกว่าทีมงานจะส่งให้ในแชทนี้", () => {
  const withTemplate = identityWelcomeBubbles({ classType: "live_business", template: "รายละเอียดค่ะ\n---\nข้อสอง", knownName: "มาลี" });
  assert.deepEqual(withTemplate, { bubbles: ["สวัสดีค่ะ คุณมาลี 🙏\nรายละเอียดค่ะ", "ข้อสอง"], usedTemplate: true });
  const online = identityWelcomeBubbles({ classType: "online", template: "", displayName: "Malee Sukjai" });
  assert.deepEqual(online, { bubbles: ["สวัสดีค่ะ คุณMalee 🙏\nทีมงานจะส่งขั้นตอนลงทะเบียนให้ในแชทนี้นะคะ"], usedTemplate: false });
  const live = identityWelcomeBubbles({ classType: "live_workflow", template: "", displayName: "" });
  assert.deepEqual(live.bubbles, ["สวัสดีค่ะ 🙏\nทีมงานจะส่งรายละเอียดการเตรียมตัวก่อนเรียนให้ในแชทนี้นะคะ"]);
  assert.equal(welcomeFallbackText(""), "ทีมงานจะส่งรายละเอียดให้ในแชทนี้นะคะ", "ไม่รู้คลาส = บอกกลาง ๆ");
  assert.equal(IDENTITY_TEMPLATE_LIMITS.maxBubbles, MAX_BUBBLES_PER_REPLY, "เพดานบับเบิลต้องเท่ากับที่ lineClient ส่งแบบ reply ได้ในครั้งเดียว");
  const five = identityWelcomeBubbles({ classType: "live_private", template: Array.from({ length: 5 }, (_, i) => `ข้อ ${i + 1}`).join("\n---\n") });
  assert.equal(five.bubbles.length, 5, "คำทักทายรวมอยู่บับเบิลแรก — ไม่กินที่บับเบิลที่หก");
  const seven = identityWelcomeBubbles({ classType: "live_private", template: Array.from({ length: 7 }, (_, i) => `ข้อ ${i + 1}`).join("\n---\n") });
  assert.equal(seven.bubbles.length, 5, "ข้อความเก่าที่ยาวเกิน (บันทึกก่อนมีเพดาน) ต้องไม่เกินขีดจำกัดของ reply");
  assert.ok(seven.bubbles.every((text) => text.length <= IDENTITY_TEMPLATE_LIMITS.lineChars));
});

test("ค่าเริ่มต้น: ออนไลน์ = ต้อนรับ + ลงทะเบียน + สิ่งที่ควรเตรียม ตามคลาส · สอนสดมีเวลา/สถานที่/การเดินทาง/สิ่งที่ต้องเตรียม · ไม่มีราคา", () => {
  // 30 ก.ย. 2026: พี่ง้วงให้ร่างข้อความคลาสออนไลน์เอง — ข้อเท็จจริงจากคู่มือแชทของชมพู่ (VDO on demand ~6 ชม. · ข้อมูลลงทะเบียน)
  const online = IDENTITY_TEMPLATE_DEFAULTS.online;
  for (const fact of ["AI Agent for Business Online", "Custom GPTs", "on demand", "6 ชั่วโมง", "ชื่อ-นามสกุล", "E-mail", "เบอร์โทร",
    "อีเมลยืนยันการลงทะเบียนสำเร็จให้ภายใน 2 ชั่วโมง", "ช่วงดึกอาจช้า", "ChatGPT แนะนำแบบ Plus", "LINE Support",
    "ทีมงานจะส่งลิงก์เข้ากลุ่ม"]) {
    assert.ok(online.includes(fact), `online: ${fact}`);
  }
  assert.match(IDENTITY_TEMPLATE_DEFAULTS.online_fb, /Facebook Ads Online[\s\S]*ลงทะเบียนเข้าเรียน[\s\S]*เพจ Facebook/u);
  assert.match(IDENTITY_TEMPLATE_DEFAULTS.online_line, /LINE OA Online[\s\S]*ลงทะเบียนเข้าเรียน[\s\S]*บัญชี LINE OA/u);
  for (const type of ["online", "online_fb", "online_line"]) {
    assert.equal(validateTemplateText(IDENTITY_TEMPLATE_DEFAULTS[type]).bubbles.length, 3, `${type}: ต้อนรับ · ลงทะเบียน · เตรียมตัว`);
  }
  for (const type of ["live_business", "live_workflow"]) {
    const text = IDENTITY_TEMPLATE_DEFAULTS[type];
    for (const fact of ["10:00-17:00", "EZ Space", "เทพารักษ์", "จอดฟรี", "BTS ศรีเทพา", "Grab", "LINE Support 1 ปี", "Codex desktop"]) {
      assert.ok(text.includes(fact), `${type}: ${fact}`);
    }
  }
  assert.match(IDENTITY_TEMPLATE_DEFAULTS.live_business, /ChatGPT แนะนำแบบ Plus/u);
  assert.match(IDENTITY_TEMPLATE_DEFAULTS.live_workflow, /LINE Developer Console[\s\S]*OpenAI Platform[\s\S]*Make/u);
  assert.match(IDENTITY_TEMPLATE_DEFAULTS.live_private, /ทีมผู้ดูแลจะยืนยันวันเรียน สถานที่ และหลักสูตร/u);
  for (const [type, text] of Object.entries(IDENTITY_TEMPLATE_DEFAULTS)) {
    assert.doesNotMatch(text, /บาท|฿|US\$|USD|\d{1,3},\d{3}|ส่วนลด|โปรโมชั่น|Early Bird/iu, `${type}: ห้ามมีราคา/โปร`);
    assert.equal(validateTemplateText(text).ok, true, `${type}: ค่าเริ่มต้นต้องผ่านเพดานของตัวเอง`);
    assert.ok(identityWelcomeBubbles({ classType: type, template: text, knownName: "มาลี" }).bubbles.length <= 5);
  }
});
