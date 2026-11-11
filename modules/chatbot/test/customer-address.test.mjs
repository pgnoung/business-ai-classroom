// customer-address.test.mjs — เรียกชื่อลูกค้าแบบคน: ชื่อต้นคำเดียว ไม่ถี่ ไม่มีนามสกุล/handle
//
// ที่มา (audit ก.ย. 2026 §4.2, บัญชีคำติ #16): ตั้งแต่ดึงชื่อโปรไฟล์ Messenger (10 ก.ย.) ข้อความ AI
// 32.5% มี "คุณชื่อ นามสกุล" เต็ม ๆ หรือ handle ("คุณ::: A :::" / "คุณMr.…" / "นาย…") สูงสุด 24 ครั้ง
// ต่อห้องต่อวัน — ชื่อทุกชื่อในไฟล์นี้เป็นชื่อสังเคราะห์ ไม่มีชื่อลูกค้าจริง
import test from "node:test";
import assert from "node:assert/strict";
import { customerAddressLabel, shortAddressName } from "../src/customerName.mjs";
import {
  enforceCustomerAddress, enforceCustomerAddressAll, NAME_COOLDOWN_AI_TURNS, planCustomerAddress,
} from "../src/customerAddress.mjs";
import { baseRules } from "../src/pipeline.mjs";
import { buildConversationStyleRules } from "../src/conversationStyle.mjs";
import { createApp } from "../src/server.mjs";
import { hermesFetchStub, lineFetchStub, memoryDb, poisonGlobalFetch, promptText, testConfig } from "./helpers.mjs";

poisonGlobalFetch();

const bot = (content) => ({ role: "assistant", content });
const user = (content) => ({ role: "user", content });
const silent = { log() {}, info() {}, warn() {}, error() {}, debug() {} };

/* ----------------------------- ตารางชื่อ -> คำเรียก ----------------------------- */

const LABELS = [
  // [ชื่อโปรไฟล์ (สังเคราะห์), คำเรียกที่ต้องได้, เหตุผล]
  ["Somchai Jaidee", "คุณSomchai", "ชื่อ-นามสกุลอังกฤษ: ตัดนามสกุล"],
  ["สมชาย ใจดี", "คุณสมชาย", "ชื่อ-นามสกุลไทย: ตัดนามสกุล"],
  ["Mr. Somchai Jaidee", "คุณSomchai", "Mr. แยกคำ"],
  ["Mr.Somchai", "คุณSomchai", "Mr. ติดชื่อ"],
  ["Mrs.Jane Doe", "คุณJane", "Mrs. ติดชื่อ + นามสกุล"],
  ["Miss Jane", "คุณJane", "Miss"],
  ["Dr Somchai", "คุณSomchai", "Dr"],
  ["นายสมชาย ใจดี", "คุณสมชาย", "นาย ติดชื่อ"],
  ["นางสาวสมหญิง ใจงาม", "คุณสมหญิง", "นางสาว ติดชื่อ"],
  ["นางสมศรี ใจดี", "คุณสมศรี", "นาง ตามด้วยนามสกุล = คำนำหน้า"],
  ["นางฟ้า", "คุณนางฟ้า", "นาง คำเดียว = ชื่อเล่นจริง ห้ามตัด"],
  ["ดร.สมชาย ใจดี", "คุณสมชาย", "ดร."],
  ["น.ส.สมหญิง", "คุณสมหญิง", "น.ส."],
  ["คุณ แอน", "คุณแอน", "คุณ แยกคำ ห้ามเป็น คุณคุณ"],
  ["::: Anna :::", "คุณAnna", "handle ครอบด้วยสัญลักษณ์"],
  ["🌸 ปุ๊กกี้ 🌸", "คุณปุ๊กกี้", "emoji รอบชื่อ"],
  ["Suriya ⚡️ ⚡️", "คุณSuriya", "emoji ท้ายชื่อ"],
  ["ปุ๊ก!!!", "คุณปุ๊ก", "เครื่องหมายซ้ำ"],
  ["Pattaraporn (Kate)", "คุณPattaraporn", "วงเล็บไม่ใช่ชื่อต้น"],
  ["Ar-ngun At Huta", "คุณAr-ngun", "ขีดกลางชื่อ"],
  ["Bo Testname", "คุณBo", "ชื่อสองตัวอักษรที่มีสระ"],
  ["Dk Earthslur", "คุณลูกค้า", "อักษรย่อไม่มีสระ = ไม่ใช่ชื่อ"],
  ["Toy2020", "คุณลูกค้า", "มีตัวเลข = handle"],
  ["P a c h i", "คุณลูกค้า", "ตัวอักษรเว้นวรรค = handle"],
  ["J. Somchai", "คุณลูกค้า", "อักษรย่อนำหน้า"],
  ["Admin Somchai", "คุณลูกค้า", "คำทั่วไปนำหน้า"],
  ["ร้านขายของชำลุงหมี", "คุณลูกค้า", "ชื่อร้าน"],
  ["🍁", "คุณลูกค้า", "emoji ล้วน"],
  ["", "คุณลูกค้า", "ไม่มีชื่อ"],
];

for (const [displayName, label, why] of LABELS) {
  test(`คำเรียกจากชื่อโปรไฟล์ "${displayName}" -> ${label} (${why})`, () => {
    assert.equal(customerAddressLabel({ displayName }), label);
  });
}

test("คำนำหน้าเชิงความสัมพันธ์คงไว้ และชื่อที่ลูกค้าบอกเองมาก่อนชื่อโปรไฟล์", () => {
  assert.equal(customerAddressLabel({ knownName: "พี่เบียร์" }), "พี่เบียร์");
  assert.equal(customerAddressLabel({ knownName: "อาจารย์แดง ใจดี" }), "อาจารย์แดง");
  assert.equal(customerAddressLabel({ knownName: "อา แดง" }), "อา แดง");
  assert.equal(customerAddressLabel({ knownName: "โต้ง", displayName: "Somchai Jaidee" }), "คุณโต้ง");
  // ด่าน 31 ส.ค. ("ชื่อต่ออะไร…") ยังอยู่: ชื่อที่จับผิดต้องหลีกทางให้ชื่อโปรไฟล์ที่ใช้ได้
  assert.equal(customerAddressLabel({ knownName: "ต่ออะไรไแอีกนอกจากline oa", displayName: "Somchai Jaidee" }), "คุณSomchai");
  assert.deepEqual(shortAddressName({ displayName: "Somchai Jaidee" }), { name: "Somchai", honorific: "", spaced: false });
});

/* ------------------------------- ความถี่การเรียกชื่อ ------------------------------- */

const FB = { displayName: "Somchai Jaidee" };

test("เทิร์นทักทายเรียกชื่อได้ · เพิ่งเรียกไปใน 3 เทิร์นล่าสุดของลูกแพร = พักการเรียกชื่อ", () => {
  assert.equal(planCustomerAddress({ ...FB, history: [] }).mayUseName, true, "ข้อความแรกต้องทักด้วยชื่อ");
  const greeted = [user("สนใจค่ะ"), bot("สวัสดีค่ะ คุณSomchai Jaidee ยินดีดูแลค่ะ")];
  assert.equal(planCustomerAddress({ ...FB, history: greeted }).mayUseName, false, "ชื่อเต็มในประวัติก็นับ");
  const later = [...greeted];
  for (let i = 0; i < NAME_COOLDOWN_AI_TURNS; i += 1) later.push(user(`คำถามที่ ${i}`), bot("ตอบโดยไม่เรียกชื่อค่ะ"));
  assert.equal(planCustomerAddress({ ...FB, history: later }).mayUseName, true, "ครบรอบพักแล้วเรียกได้อีกครั้ง");
  // ทีมงานเรียกชื่อ ไม่ใช่ลูกแพร — ไม่นับเป็นโควตาของลูกแพร
  const operator = [user("สนใจค่ะ"), bot("[แอดมินทีมงานพิมพ์เอง] สวัสดีค่ะ คุณSomchai")];
  assert.equal(planCustomerAddress({ ...FB, history: operator }).mayUseName, true);
  // ชื่อละติน "Bo" ห้ามนับ "Book" ในประวัติเป็นการเรียกชื่อ
  assert.equal(planCustomerAddress({ displayName: "Bo Testname", history: [bot("คุณBook เล่มนี้ดีค่ะ")] }).mayUseName, true);
});

test("ด่านหลังร่าง: ชื่อเต็ม -> ชื่อต้น และเรียกชื่อได้ครั้งเดียวต่อข้อความ", () => {
  const plan = planCustomerAddress({ ...FB, history: [] });
  const draft = "สวัสดีค่ะ คุณSomchai Jaidee ลูกแพรดูแลให้ค่ะ\nไม่ทราบว่า คุณ Somchai Jaidee เคยใช้ AI ไหมคะ\nของคุณSomchai พร้อมแล้วค่ะ";
  assert.equal(enforceCustomerAddress(draft, plan),
    "สวัสดีค่ะ คุณSomchai ลูกแพรดูแลให้ค่ะ\nไม่ทราบว่า คุณ เคยใช้ AI ไหมคะ\nของคุณ พร้อมแล้วค่ะ");
});

test("ด่านหลังร่าง: ช่วงพักการเรียกชื่อ = ตัดชื่อทุกจุด (หลังคำเชื่อมเหลือสรรพนาม)", () => {
  const plan = planCustomerAddress({ ...FB, history: [bot("ยินดีค่ะคุณSomchai")] });
  assert.equal(plan.mayUseName, false);
  assert.equal(enforceCustomerAddress("ดีมากค่ะคุณSomchai 😊 ลองเริ่มจากงานเล็กก่อนนะคะ\nคุณSomchai Jaidee\nรีวิวนี้สำหรับคุณSomchai ค่ะ", plan),
    "ดีมากค่ะ 😊 ลองเริ่มจากงานเล็กก่อนนะคะ\nรีวิวนี้สำหรับคุณ ค่ะ");
});

test("ด่านหลังร่าง: handle / คำนำหน้าทางการ / ไม่มีชื่อ", () => {
  const handle = planCustomerAddress({ displayName: "::: Anna :::", history: [] });
  assert.equal(enforceCustomerAddress("สวัสดีค่ะคุณ::: Anna ::: ยินดีค่ะ", handle), "สวัสดีค่ะคุณAnna ยินดีค่ะ");
  const titled = planCustomerAddress({ displayName: "Mr.Somchai", history: [] });
  assert.equal(enforceCustomerAddress("ขอบคุณค่ะ คุณMr.Somchai", titled), "ขอบคุณค่ะ คุณSomchai");
  const shop = planCustomerAddress({ displayName: "ร้านขายของชำลุงหมี", history: [] });
  assert.equal(shop.label, "คุณลูกค้า");
  assert.equal(enforceCustomerAddress("สวัสดีค่ะ คุณร้านขายของชำลุงหมี", shop), "สวัสดีค่ะ คุณลูกค้า");
});

test("ด่านหลังร่างไม่ทำลายเนื้อความ: ข้อความไม่มีชื่อเหมือนเดิมทุกไบต์ · คำธรรมดาไม่ถูกแทน · บล็อกรีวิวไม่ถูกแตะ", () => {
  const plan = planCustomerAddress({ ...FB, history: [bot("ยินดีค่ะคุณSomchai")] });
  const plain = "ตอบได้เลยค่ะ  เว้นวรรคสองที ? ต้องคงไว้";
  assert.equal(enforceCustomerAddress(plain, plan), plain);
  const line = planCustomerAddress({ displayName: "Line", history: [] });
  assert.equal(line.label, "คุณลูกค้า");
  assert.equal(enforceCustomerAddress("เชื่อม LINE OA กับ Line ได้ค่ะ", line), "เชื่อม LINE OA กับ Line ได้ค่ะ");
  // ผู้รีวิวชื่อต้นเดียวกับลูกค้า — บรรทัดชื่อ-ตำแหน่งเหนือลิงก์ต้องตรงตามคลังเป๊ะ (กติกาเหล็กรีวิว)
  const review = "ฝากรีวิวไว้ประกอบการเลือกนะคะ\nคุณSomchai Wongthai  CEO บริษัทตัวอย่าง\nhttps://www.facebook.com/share/r/example";
  assert.equal(enforceCustomerAddress(review, plan), review);
});

// eval กับสมองจริง 2026-09-28: บันไดเปิดบทสนทนาของพี่ง้วงวางชื่อไว้ท้ายบรรทัด ("ไม่ทราบว่า คุณ{ชื่อ}⏎เคยใช้ AI…")
// ของเดิมเก็บชื่อในคำทักแล้วตัดชื่อในบันได ลูกค้าได้ "ไม่ทราบว่า คุณ⏎เคยใช้ AI…" (คุณห้อยท้ายบรรทัด)
const LADDER = "ไม่ทราบว่า คุณพิมพ์ลดา\nเคยใช้ AI มาประมาณ ระดับที่เท่าไหร่แล้วคะ ?\n\n1️⃣ ยังไม่เคยใช้เลย (แต่สนใจมากๆ อยากรู้ว่าใช้ยังไง)";

test("บันไดเปิดบทสนทนา: เก็บชื่อในบันได (สำนวนต้นฉบับ) ตัดชื่อในคำทัก — ไม่มี คุณ ห้อยท้ายบรรทัด", () => {
  const plan = planCustomerAddress({ displayName: "นางสาว พิมพ์ลดา ทดสอบระบบ 🌸", history: [] });
  const draft = `สวัสดีค่ะคุณพิมพ์ลดา ลูกแพรเป็นผู้ช่วยของพี่ง้วงค่ะ 😊\n\n${LADDER}`;
  assert.equal(enforceCustomerAddress(draft, plan), `สวัสดีค่ะ ลูกแพรเป็นผู้ช่วยของพี่ง้วงค่ะ 😊\n\n${LADDER}`);
  // โมเดลลอกชื่อโปรไฟล์เต็มมาใส่บันได: ย่อเป็นชื่อต้นแล้วยังอยู่ตำแหน่งเดิม
  const copied = `สวัสดีค่ะคุณนางสาว พิมพ์ลดา ทดสอบระบบ 🌸 ยินดีค่ะ\n\n${LADDER.replace("คุณพิมพ์ลดา", "คุณนางสาว พิมพ์ลดา ทดสอบระบบ 🌸")}`;
  assert.equal(enforceCustomerAddress(copied, plan), `สวัสดีค่ะ ยินดีค่ะ\n\n${LADDER}`);
});

test("บันไดเปิดบทสนทนาในช่วงพักการเรียกชื่อ: ต่อ คุณ เข้ากับบรรทัดถัดไปเป็นประโยคเดียว", () => {
  const plan = planCustomerAddress({ displayName: "พิมพ์ลดา ทดสอบระบบ", history: [bot("ยินดีค่ะคุณพิมพ์ลดา")] });
  assert.equal(plan.mayUseName, false);
  assert.equal(enforceCustomerAddress(LADDER, plan),
    "ไม่ทราบว่า คุณเคยใช้ AI มาประมาณ ระดับที่เท่าไหร่แล้วคะ ?\n\n1️⃣ ยังไม่เคยใช้เลย (แต่สนใจมากๆ อยากรู้ว่าใช้ยังไง)");
  // ชื่อท้ายบรรทัดที่ตามด้วยบรรทัดว่าง ไม่มีอะไรให้ต่อ — เหลือสรรพนามตามเดิม ไม่ดึงย่อหน้าถัดไปขึ้นมา
  assert.equal(enforceCustomerAddress("ลูกแพรเตรียมข้อมูลไว้ให้ คุณพิมพ์ลดา\n\nสนใจรอบไหนคะ", plan),
    "ลูกแพรเตรียมข้อมูลไว้ให้ คุณ\n\nสนใจรอบไหนคะ");
});

test("ด่านหลังร่าง: ตัดชื่อพร้อมคำลงท้ายเรียกขาน ไม่ทิ้ง คะ ไว้ต้นประโยค", () => {
  const resting = planCustomerAddress({ displayName: "มิน ทดสอบ", history: [bot("ยินดีค่ะคุณมิน")] });
  assert.equal(enforceCustomerAddress("คุณมินคะ ถ้าอยากเริ่มจากหัวข้อไหนบอกลูกแพรได้เลยค่ะ", resting),
    "ถ้าอยากเริ่มจากหัวข้อไหนบอกลูกแพรได้เลยค่ะ");
  assert.equal(enforceCustomerAddress("สวัสดีค่ะคุณมิน คะ ถ้าพร้อมเริ่มได้เลยค่ะ", resting),
    "สวัสดีค่ะ ถ้าพร้อมเริ่มได้เลยค่ะ");
  for (const [draft, expected] of [
    ["คุณมินคะ, ถ้าอยากเริ่มบอกได้เลยค่ะ", "ถ้าอยากเริ่มบอกได้เลยค่ะ"],
    ["คุณมินคะ? ถ้าอยากเริ่มบอกได้เลยค่ะ", "ถ้าอยากเริ่มบอกได้เลยค่ะ"],
    ["คุณมินค่ะ… ถ้าอยากเริ่มบอกได้เลยค่ะ", "ถ้าอยากเริ่มบอกได้เลยค่ะ"],
  ]) {
    assert.equal(enforceCustomerAddress(draft, resting), expected, draft);
  }

  const fresh = planCustomerAddress({ displayName: "มิน ทดสอบ", history: [] });
  assert.equal(enforceCustomerAddress("คุณมินคะ ถ้าอยากเริ่มจากหัวข้อไหนบอกลูกแพรได้เลยค่ะ", fresh),
    "คุณมินคะ ถ้าอยากเริ่มจากหัวข้อไหนบอกลูกแพรได้เลยค่ะ");
  assert.equal(enforceCustomerAddress("คุณมินคะ, ถ้าอยากเริ่มบอกได้เลยค่ะ", fresh),
    "คุณมินคะ, ถ้าอยากเริ่มบอกได้เลยค่ะ");
  assert.equal(enforceCustomerAddress("รายละเอียดพร้อมแล้วค่ะ ถ้าอยากเริ่มบอกได้เลยค่ะ", resting),
    "รายละเอียดพร้อมแล้วค่ะ ถ้าอยากเริ่มบอกได้เลยค่ะ");
});

// รีวิว 2026-10-03 รอบ 3: ตัดชื่อในช่วงพักแล้วประโยคต้องไม่ขาด (เพื่อ/จากทาง/คำลงท้ายท้ายบรรทัด/ประธานร่วม)
test("ด่านหลังร่าง: ช่วงพักการเรียกชื่อ ตัดแล้วประโยคยังอ่านรู้เรื่อง", () => {
  const resting = planCustomerAddress({ displayName: "มิน ทดสอบ", history: [bot("ยินดีค่ะคุณมิน")] });
  for (const [draft, expected] of [
    ["ออกแบบเพื่อคุณมินโดยเฉพาะค่ะ", "ออกแบบเพื่อคุณโดยเฉพาะค่ะ"],
    ["ขอข้อมูลจากทางคุณมินอีกนิดนะคะ", "ขอข้อมูลจากทางคุณอีกนิดนะคะ"],
    ["สวัสดีค่ะ คุณมินคะ", "สวัสดีค่ะ"],
    ["ส่งรายละเอียดให้คุณมินค่ะ ถ้าสนใจทักได้เลยนะคะ", "ส่งรายละเอียดให้คุณค่ะ ถ้าสนใจทักได้เลยนะคะ"],
    ["คุณมินและทีมเรียนด้วยกันได้ค่ะ", "คุณและทีมเรียนด้วยกันได้ค่ะ"],
    ["เตรียมไว้ให้คุณมิน\nสนใจรอบไหนคะ", "เตรียมไว้ให้คุณ\nสนใจรอบไหนคะ"],
    // รีวิวรอบ 4: คำลงท้ายเป็นของประโยค (ก่อนชื่อยังไม่มีหางเสียง) — คืนให้ประโยค
    ["ขอบคุณคุณมินครับ", "ขอบคุณครับ"],
    ["ขอเบอร์คุณมินค่ะ", "ขอเบอร์ค่ะ"],
    ["สะดวกรอบไหน คุณมินคะ", "สะดวกรอบไหนคะ"],
    ["แล้วคุณมินล่ะคะ สนใจแบบไหน", "แล้วคุณล่ะคะ สนใจแบบไหน"],
    ["คุณมินเองก็ใช้ได้ค่ะ", "คุณเองก็ใช้ได้ค่ะ"],
  ]) {
    assert.equal(enforceCustomerAddress(draft, resting), expected, draft);
  }
});

test("follow-up หลายบอลลูนใช้โควตาเรียกชื่อก้อนเดียว", () => {
  const plan = planCustomerAddress({ ...FB, history: [] });
  assert.deepEqual(enforceCustomerAddressAll(["ฝากรีวิวไว้ของคุณSomchai นะคะ", "คุณSomchai Jaidee สนใจรอบไหนคะ"], plan),
    ["ฝากรีวิวไว้ของคุณSomchai นะคะ", "สนใจรอบไหนคะ"]);
});

/* ------------------------------------ พรอมต์ ------------------------------------ */

const NAME_LINE_TAIL = "\n- ต้องเรียกชื่อลูกค้าในจังหวะทักทาย จังหวะเสนอทางเลือก และจังหวะชวนตัดสินใจ "
  + "ส่วนประโยคอื่น ๆ ไม่ต้องเรียกซ้ำ และห้ามถามชื่อลูกค้าเพื่อหาเรื่องคุยต่อ";

test("พรอมต์: ชื่อโปรไฟล์เต็มไม่เข้าพรอมต์ · พักการเรียกชื่อเมื่อเพิ่งเรียก · ห้องปกติได้บรรทัดเดิมทุกไบต์", () => {
  const customer = { display_name: "Somchai Jaidee", known_name: "" };
  const fresh = baseRules("general", [], { customer, currentText: "สนใจคลาสค่ะ", history: [] });
  assert.match(fresh, /ชื่อที่ใช้เรียกลูกค้าคนนี้คือ "คุณSomchai"/u);
  assert.ok(!fresh.includes("Jaidee"), "นามสกุลห้ามเข้าพรอมต์");
  assert.ok(fresh.includes(NAME_LINE_TAIL), "เทิร์นที่เรียกชื่อได้ใช้บรรทัดเดิมทุกไบต์");
  const resting = baseRules("general", [], {
    customer, currentText: "ราคาเท่าไหร่คะ", history: [user("สนใจค่ะ"), bot("สวัสดีค่ะ คุณSomchai Jaidee")],
  });
  assert.match(resting, /ข้อความนี้ไม่ต้องเรียกชื่อลูกค้า เพราะเพิ่งเรียกไปในข้อความก่อน ๆ/u);
  assert.ok(!resting.includes(NAME_LINE_TAIL));
  // ลูกค้าที่ไม่มีชื่อใช้ได้ (2026-10-03 พี่ง้วง: แชทแข็งเกินไป): ไม่สั่งให้เรียก "คุณลูกค้า" อีก
  const generic = baseRules("general", [], { customer: { display_name: "" }, currentText: "สนใจค่ะ", history: [bot("สวัสดีค่ะคุณลูกค้า")] });
  assert.ok(!generic.includes('ชื่อที่ใช้เรียกลูกค้าคนนี้คือ "คุณลูกค้า"'));
  assert.match(generic, /ยังไม่มีชื่อที่ใช้เรียกลูกค้าคนนี้ได้/u);
  assert.ok(!generic.includes(NAME_LINE_TAIL), "ไม่มีชื่อ = ไม่มีจังหวะที่ต้องเรียกชื่อ");
});

test("พรอมต์: ชื่อที่ลูกค้าบอกเองส่งเป็นชื่อต้น และข้อความที่ด่าน 31 ส.ค. ปฏิเสธห้ามหลุดเข้าพรอมต์", () => {
  const full = buildConversationStyleRules({ text: "สนใจค่ะ", customer: { known_name: "สมชาย ใจดี" } });
  assert.match(full, /ลูกค้าเคยบอกชื่อเองว่า สมชาย;/u);
  assert.ok(!full.includes("ใจดี;"));
  const single = buildConversationStyleRules({ text: "สนใจค่ะ", customer: { known_name: "โต้ง" } });
  assert.match(single, /ลูกค้าเคยบอกชื่อเองว่า โต้ง; ใช้ชื่อได้เฉพาะจังหวะที่เป็นธรรมชาติ/u);
  const relational = buildConversationStyleRules({ text: "สนใจค่ะ", customer: { known_name: "พี่เบียร์" } });
  assert.match(relational, /ลูกค้าเคยบอกชื่อเองว่า พี่เบียร์;/u);
  const rejected = buildConversationStyleRules({ text: "สนใจค่ะ", customer: { known_name: "ต่ออะไรไแอีกนอกจากline oa" } });
  assert.doesNotMatch(rejected, /ลูกค้าเคยบอกชื่อเองว่า/u);
});

/* ---------------------------------- ไปป์ไลน์จริง ---------------------------------- */

test("ไปป์ไลน์: โมเดลลอกชื่อเต็มมา -> ลูกค้าได้ชื่อต้นครั้งเดียว ไม่มีนามสกุล", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const hermesFetch = hermesFetchStub("สวัสดีค่ะ คุณSomchai Jaidee ลูกแพรยินดีดูแลค่ะ 😊\n\nคุณSomchai Jaidee อยากให้ AI ช่วยงานด้านไหนเป็นอย่างแรกคะ");
  const lineFetch = lineFetchStub();
  const app = createApp({
    config: testConfig(), db, overrides: { hermesFetch, lineFetch, sleep: async () => {} }, logger: silent,
  });
  const customerId = "facebook:psid-name";
  db.upsertCustomer(customerId, { channelId: "facebook", displayName: "Somchai Jaidee" });
  const result = await app.pipeline.handleInboundText({ customerId, text: "สนใจค่ะ", replyToken: "" });
  assert.equal(result.sent, true);
  const system = promptText(hermesFetch.calls[0].body.messages[0].content);
  assert.ok(!system.includes("Jaidee"), "นามสกุลห้ามเข้าพรอมต์");
  const sent = db.messagesFor(customerId, 20).filter((m) => m.direction === "out").map((m) => m.content).join("\n");
  assert.ok(!sent.includes("Jaidee"), `ลูกค้าต้องไม่เห็นนามสกุล: ${sent}`);
  assert.equal((sent.match(/คุณSomchai/gu) || []).length, 1, "เรียกชื่อได้ครั้งเดียวต่อข้อความ");
});

test("ไปป์ไลน์: ข้อความแรกแบบบันไดของพี่ง้วง -> ชื่ออยู่ในบันไดครั้งเดียว ไม่มี คุณ ห้อยท้ายบรรทัด", async (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  const hermesFetch = hermesFetchStub(`สวัสดีค่ะคุณพิมพ์ลดา ลูกแพรเป็นผู้ช่วยของพี่ง้วงค่ะ 😊\n\n${LADDER}`);
  const app = createApp({
    config: testConfig(), db, overrides: { hermesFetch, lineFetch: lineFetchStub(), sleep: async () => {} }, logger: silent,
  });
  const customerId = "U-ladder-name";
  db.upsertCustomer(customerId, { displayName: "นางสาว พิมพ์ลดา ทดสอบระบบ 🌸" });
  const result = await app.pipeline.handleInboundText({ customerId, text: "สนใจคลาส AI สำหรับเจ้าของธุรกิจค่ะ", replyToken: "" });
  assert.equal(result.sent, true);
  const sent = db.messagesFor(customerId, 20).filter((m) => m.direction === "out").map((m) => m.content).join("\n");
  assert.match(sent, /ไม่ทราบว่า คุณพิมพ์ลดา\nเคยใช้ AI มาประมาณ ระดับที่เท่าไหร่แล้วคะ \?/u, sent);
  assert.equal((sent.match(/คุณพิมพ์ลดา/gu) || []).length, 1, sent);
  assert.doesNotMatch(sent, /คุณ[ \t]*\n/u, "ห้ามมี คุณ ห้อยท้ายบรรทัด");
  assert.ok(!sent.includes("ทดสอบระบบ") && !sent.includes("นางสาว"), sent);
});
