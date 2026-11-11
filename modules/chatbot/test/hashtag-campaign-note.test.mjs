// โน้ตกิจกรรมของ #hashtag — ให้ลูกแพรรู้ที่มาของลูกค้าตั้งแต่ข้อความแรก
//
// คำสั่งเจ้าของ 2026-08-28: พี่ง้วงไปสอนและออกงานบ่อย แล้วให้ผู้ฟังแอดไลน์พร้อมพิมพ์
// #horeca / #invisalign เข้ามา ลูกค้ากลุ่มนี้จึงพิมพ์แค่คำเดียวเป็นข้อความแรกสุด
// ระบบไม่มีอะไรให้อ้างอิงเลย และเคยตอบผิดบริบท
//
// จุดสำคัญของการออกแบบ: seed กับ note ต้องเป็นคนละช่อง
//   seed = ใช้ "แทนข้อความของลูกค้า" ระบบอ่านเหมือนลูกค้าพิมพ์เอง
//   note = บริบทที่ทีมงานเขียนไว้ ส่งเข้าไปในฐานะ "สิ่งที่รู้มา" ไม่ใช่คำพูดของลูกค้า
// ถ้าเอาคำอธิบายงานไปใส่ช่อง seed ลูกแพรจะเข้าใจว่าลูกค้าเป็นคนพูดประโยคนั้น แล้วตอบเพี้ยน
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeHashtagBusinessKeywords, resolveBusinessHashtag } from "../src/pipeline.mjs";
import { memoryDb } from "./helpers.mjs";

test("รับรูปแบบเดิม (สตริงล้วน) ได้เหมือนเดิม", () => {
  const out = normalizeHashtagBusinessKeywords({ "#online": "สนใจคลาสเรียนออนไลน์" });
  assert.equal(out["#online"], "สนใจคลาสเรียนออนไลน์", "ของเดิมต้องไม่พัง");
});

test("รับรูปแบบใหม่ที่มีโน้ตกิจกรรม", () => {
  const out = normalizeHashtagBusinessKeywords({
    "#horeca": { seed: "สนใจคลาส AI จากงาน HoReCa", note: "งานสัมมนา HoReCa 25 ส.ค. ผู้ฟังเป็นเจ้าของร้านอาหารและโรงแรม" },
  });
  assert.equal(out["#horeca"].seed, "สนใจคลาส AI จากงาน HoReCa");
  assert.match(out["#horeca"].note, /เจ้าของร้านอาหาร/u);
});

test("bare ASCII campaign เก็บ deliveryText แบบมีเพดาน", () => {
  const out = normalizeHashtagBusinessKeywords({
    " Claude10x ": {
      seed: "ขอรับไฟล์ Claude Project Setup",
      note: "ไฟล์ที่ผู้ดูแลยืนยัน",
      deliveryText: "รับไฟล์ได้ที่ https://drive.google.com/example",
    },
  });
  assert.deepEqual(out.claude10x, {
    seed: "ขอรับไฟล์ Claude Project Setup",
    note: "ไฟล์ที่ผู้ดูแลยืนยัน",
    deliveryText: "รับไฟล์ได้ที่ https://drive.google.com/example",
  });
  assert.deepEqual(normalizeHashtagBusinessKeywords({
    claude10x: { seed: "ขอไฟล์", deliveryText: "ก".repeat(2001) },
  }), {}, "ข้อความส่งที่เกินเพดานต้องไม่เปิด route แบบครึ่ง ๆ กลาง ๆ");
});

test("โน้ตยาวเกิน 600 ตัวอักษร ไม่รับ", () => {
  const out = normalizeHashtagBusinessKeywords({ "#x": { seed: "สนใจ", note: "ก".repeat(601) } });
  assert.equal(out["#x"], undefined, "ยาวเกินต้องไม่ถูกเก็บ ไม่ใช่ตัดทิ้งเงียบ ๆ");
});

test("ไม่มี seed = ใช้ไม่ได้ ต่อให้มีโน้ต", () => {
  const out = normalizeHashtagBusinessKeywords({ "#x": { seed: "", note: "งานสัมมนา" } });
  assert.equal(out["#x"], undefined);
});

test("อ่าน hashtag แล้วได้ทั้งข้อความแทนและโน้ต", () => {
  const keywords = normalizeHashtagBusinessKeywords({
    "#horeca": { seed: "สนใจคลาส AI", note: "มาจากงาน HoReCa" },
  });
  const got = resolveBusinessHashtag("#horeca", keywords);
  assert.equal(got.tag, "#horeca");
  assert.equal(got.text, "สนใจคลาส AI", "ข้อความที่ใช้แทนต้องเป็น seed ไม่ใช่โน้ต");
  assert.equal(got.note, "มาจากงาน HoReCa");
});

test("ลูกค้าพิมพ์ต่อท้าย hashtag ข้อความต่อท้ายต้องไม่หาย", () => {
  const keywords = normalizeHashtagBusinessKeywords({ "#horeca": { seed: "สนใจคลาส AI", note: "งาน HoReCa" } });
  const got = resolveBusinessHashtag("#horeca อยากทราบราคาค่ะ", keywords);
  assert.match(got.text, /สนใจคลาส AI อยากทราบราคาค่ะ/u);
});

test("hashtag นอกรายการยังเงียบเหมือนเดิม", () => {
  assert.equal(resolveBusinessHashtag("#ไม่รู้จัก", { "#horeca": "สนใจ" }), null);
});

test("bare keyword ตรงทั้งข้อความแบบไม่สนตัวพิมพ์ และ # เป็น alias ได้", () => {
  const keywords = normalizeHashtagBusinessKeywords({
    claude10x: {
      seed: "ขอรับไฟล์ Claude Project Setup",
      note: "ไฟล์ที่ผู้ดูแลยืนยัน",
      deliveryText: "รับไฟล์ได้ที่ https://drive.google.com/example",
    },
  });
  for (const input of ["claude10x", "  CLAUDE10X  ", "#Claude10x"]) {
    assert.deepEqual(resolveBusinessHashtag(input, keywords), {
      tag: "claude10x",
      text: "ขอรับไฟล์ Claude Project Setup",
      note: "ไฟล์ที่ผู้ดูแลยืนยัน",
      deliveryText: "รับไฟล์ได้ที่ https://drive.google.com/example",
    });
  }
  for (const input of ["ขอ claude10x", "claude10x please", "#claude10x please", "xclaude10x"]) {
    assert.equal(resolveBusinessHashtag(input, keywords), null, `ห้ามจับคำฝัง/คำต่อท้าย: ${input}`);
  }
});

test("รูปแบบเดิมยังอ่านได้ และไม่มีโน้ต", () => {
  const got = resolveBusinessHashtag("#online", { "#online": "สนใจคลาสเรียนออนไลน์" });
  assert.equal(got.text, "สนใจคลาสเรียนออนไลน์");
  assert.equal(got.note, "", "ของเดิมไม่มีโน้ต ต้องไม่ใช่ undefined");
});

test("campaign resolver only accepts own configured keys, never inherited properties", () => {
  for (const input of ["constructor", "#constructor"]) {
    assert.equal(resolveBusinessHashtag(input, {}), null, input);
  }
  const inherited = Object.create({ claude10x: { seed: "ขอไฟล์", deliveryText: "ลิงก์" } });
  assert.equal(resolveBusinessHashtag("claude10x", inherited), null);
  assert.equal(resolveBusinessHashtag("#claude10x", inherited), null);
  assert.equal(resolveBusinessHashtag("constructor", { constructor: "คำที่ผู้ดูแลตั้งไว้จริง" }).text,
    "คำที่ผู้ดูแลตั้งไว้จริง");
});

test("โน้ตถูกบันทึกครั้งแรกครั้งเดียว งานแรกที่พาเขามาคือบริบทที่ตรงที่สุด", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  db.upsertCustomer("U-h", {});
  assert.equal(db.setHashtagNote("U-h", "มาจากงาน HoReCa"), true);
  assert.equal(db.getCustomer("U-h").hashtag_note, "มาจากงาน HoReCa");
  assert.equal(db.setHashtagNote("U-h", "มาจากงานอื่น"), false, "ครั้งที่สองต้องไม่ทับ");
  assert.equal(db.getCustomer("U-h").hashtag_note, "มาจากงาน HoReCa");
});

test("โน้ตว่างไม่ต้องบันทึก", (t) => {
  const db = memoryDb();
  t.after(() => db.close());
  db.upsertCustomer("U-h2", {});
  assert.equal(db.setHashtagNote("U-h2", "   "), false);
  assert.equal(db.getCustomer("U-h2").hashtag_note, "");
});

// ─────────────────────────────────────────────────────────────────────────────
// คำสั่งเจ้าของ 2026-08-28 (ค่ำ): เปลี่ยนกรีตติ้งจาก # เป็น @ แล้ว "ลูกแพรตอบต่อได้เลย"
//
// เหตุผลที่ # กับ @ ต้องมีพฤติกรรมคนละแบบ — และเป็นหัวใจของการแก้ครั้งนี้:
//   #  LINE OA Manager มี auto-response เป็นเจ้าของคีย์เวิร์ดอยู่แล้ว ลูกแพรต้องหลบ
//      ไม่ให้ตอบซ้อน -> คำที่ไม่อยู่ในรายการ = เงียบ (ถูกต้องแล้ว คงไว้ทุกตัวอักษร)
//   @  ไม่มีใครตอบแทนเลย -> คำที่ไม่อยู่ในรายการ **ห้ามเงียบ** ต้องคุยต่อตามปกติ
//
// ถ้าลอกพฤติกรรมของ # มาใช้กับ @ จะเกิดซ้ำรอยที่ตรวจเจอคืนนี้พอดี: ลูกค้าพิมพ์
// #inhouse / #FOUNDER / #AI เข้ามาแล้วไม่ได้รับอะไรกลับเลย เพราะรายการมีคำเดียว
import { CAMPAIGN_KEYWORD, HASHTAG_KEYWORD, HASHTAG_BUSINESS_DEFAULTS } from "../src/pipeline.mjs";

test("@ ที่เจ้าของตั้งไว้ ต้องเติม seed ได้เหมือน #", () => {
  const kw = normalizeHashtagBusinessKeywords({
    "@inhouse": { seed: "สนใจอบรม in-house ให้ทีมที่บริษัท", note: "กรีตติ้ง LINE OA ก.ย. 2026" },
  });
  const got = resolveBusinessHashtag("@inhouse", kw);
  assert.equal(got.tag, "@inhouse");
  assert.equal(got.text, "สนใจอบรม in-house ให้ทีมที่บริษัท");
  assert.match(got.note, /กรีตติ้ง/u);
});

test("@ ตามด้วยข้อความ ต้องต่อท้าย seed เหมือนเดิม", () => {
  const kw = normalizeHashtagBusinessKeywords({ "@online": "สนใจคลาสเรียนออนไลน์" });
  assert.equal(resolveBusinessHashtag("@online ทีม 5 คนค่ะ", kw).text, "สนใจคลาสเรียนออนไลน์ ทีม 5 คนค่ะ");
});

test("@ ที่ไม่อยู่ในรายการ ต้องไม่เข้าด่านเงียบของ # (ห้ามเงียบใส่ลูกค้า)", () => {
  assert.equal(HASHTAG_KEYWORD.test("@founder"), false, "ด่านเงียบเป็นของ # เท่านั้น");
  assert.equal(HASHTAG_KEYWORD.test("#founder"), true, "ของ # ต้องไม่เปลี่ยน");
  assert.equal(CAMPAIGN_KEYWORD.test("@founder"), true, "แต่ยังต้องถูกมองว่าเป็นคีย์เวิร์ดกิจกรรม");
});

test("ค่าตั้งต้นต้องมีครบทั้ง 4 คำในกรีตติ้งใหม่", () => {
  for (const tag of ["@online", "@class", "@inhouse", "@contact"]) {
    assert.ok(HASHTAG_BUSINESS_DEFAULTS[tag], `ขาด ${tag} ในค่าตั้งต้น`);
  }
});

test("ข้อความปกติที่มี # หรือ @ กลางประโยค ต้องไม่ถูกจับ", () => {
  for (const t of ["สอน C# ไหมคะ", "อีเมลผม somchai@gmail.com ครับ", "ราคาเท่าไหร่คะ"]) {
    assert.equal(CAMPAIGN_KEYWORD.test(t), false, `ห้ามจับ: ${t}`);
    assert.equal(resolveBusinessHashtag(t, HASHTAG_BUSINESS_DEFAULTS), null);
  }
});
