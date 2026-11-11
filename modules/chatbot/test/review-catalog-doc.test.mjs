// คลังรีวิวแก้จากคอนโซลได้โดยไม่ทำของเดิมพัง (คำสั่งพี่ง้วง 1 ก.ย. 2026)
//
// ชมพู่จะเพิ่มรีวิวเรื่อย ๆ จึงต้องมีฟอร์มให้กรอก แต่รีวิวเก็บเป็นข้อความในคลังความรู้
// และ stagedFollowups อ่านด้วย regex เดิม — ถ้าการบันทึกจากฟอร์มทำรูปแบบเพี้ยนแม้บรรทัดเดียว
// รีวิวใบนั้นจะหายไปจากคลังเงียบ ๆ ลูกค้าก็จะไม่เคยได้เห็น
import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewDoc, renderReviewDoc, validateReviewDoc } from "../src/reviewCatalogDoc.mjs";
import { parseReviewCatalog } from "../src/stagedFollowups.mjs";

// ตัวอย่างที่ครอบรูปแบบแปลก ๆ ที่มีจริงในคลัง: ขีดยาว, ท้ายลิงก์มี query, ลิงก์ /reel/,
// คำอธิบายที่ว่างหลังขีด, และชื่อกลุ่มที่มีเครื่องหมาย :
const DOC = `รีวิวนักเรียนจริง — ใช้เสริมความมั่นใจตอนลูกค้ากำลังตัดสินใจ

วิธีใช้ (logic ของแอดมินคนจริง):
- เลือกรีวิวที่ตรงกับธุรกิจของลูกค้ามากที่สุดเพียงหนึ่งรายการต่อครั้ง
- ถ้าไม่มีรีวิวที่ตรงบริบทลูกค้า ไม่ต้องส่ง — ห้ามฝืนยัด

[Classroom : AI Agent For Business]
- คุณทดสอบหนึ่ง — CEO at Test Print Studio | รีวิว: https://www.facebook.com/share/r/1TstRa01Aa/
- ผู้เรียนจริงจาก Classroom — หลากหลายธุรกิจ | รีวิว: https://www.facebook.com/reel/100000000000757

[Private Class : Customize]
- คุณเอ — CEO ร้านตัดผม | รีวิว: https://www.facebook.com/share/v/1TstVb02Bb/?mibextid=wwXIfr
- ทีมงาน ร้านทดสอบ A —  | รีวิว: https://www.facebook.com/share/r/1TstRc03Cc/
`;

test("อ่านเอกสารรีวิวแยกเป็นส่วนหัว กลุ่ม และรายการได้ถูก", () => {
  const doc = parseReviewDoc(DOC);
  assert.match(doc.preamble, /^รีวิวนักเรียนจริง/u);
  assert.match(doc.preamble, /ห้ามฝืนยัด$/u, "ส่วนหัวต้องเก็บกติกาการใช้ไว้ครบ");
  assert.equal(doc.sections.length, 2);
  assert.equal(doc.sections[0].name, "Classroom : AI Agent For Business");
  assert.equal(doc.sections[0].items.length, 2);
  assert.equal(doc.sections[0].items[0].who, "คุณทดสอบหนึ่ง — CEO at Test Print Studio");
  assert.equal(doc.sections[0].items[0].url, "https://www.facebook.com/share/r/1TstRa01Aa/");
  assert.equal(doc.sections[1].items[1].who, "ทีมงาน ร้านทดสอบ A —", "คำอธิบายที่ว่างหลังขีดต้องไม่ทำให้แถวหาย");
});

test("เขียนกลับแล้วต้องไม่มีรีวิวหาย และบันทึกซ้ำอีกกี่รอบก็ไม่ขยับอีก", () => {
  const once = renderReviewDoc(parseReviewDoc(DOC));
  const twice = renderReviewDoc(parseReviewDoc(once));
  assert.equal(twice, once, "บันทึกรอบสองต้องไม่เปลี่ยนอะไรอีก ไม่งั้นไฟล์จะขยับทุกครั้งที่กด");
  const before = parseReviewCatalog([{ title: "รีวิวนักเรียนจริง", content: DOC, active: 1 }]);
  const after = parseReviewCatalog([{ title: "รีวิวนักเรียนจริง", content: once, active: 1 }]);
  assert.deepEqual(after, before, "รายการที่บอทหยิบได้ต้องเหมือนเดิมทุกใบ");
  // ต่างจากต้นฉบับได้เฉพาะช่องว่างซ้ำที่ถูกยุบ ห้ามต่างที่ตัวอักษรอื่น
  assert.equal(once.replace(/[ \t]+/gu, " "), DOC.replace(/[ \t]+/gu, " "));
});

test("ลิงก์ /reel/ ต้องใช้ได้จริง (เคสจริง: อยู่ในคลังแต่บอทหยิบไม่ได้)", () => {
  const reviews = parseReviewCatalog([{ title: "รีวิวนักเรียนจริง", content: DOC, active: 1 }]);
  assert.ok(reviews.some((r) => r.url === "https://www.facebook.com/reel/100000000000757"),
    "รีวิวที่ใส่เป็นลิงก์รีลต้องอยู่ในคลังที่บอทเลือกได้");
  assert.deepEqual(
    validateReviewDoc({ sections: [{ name: "ก", items: [{ who: "คุณเอ", url: "https://www.facebook.com/reel/123" }] }] }),
    [], "คอนโซลต้องยอมรับลิงก์รีลด้วย ไม่งั้นชมพู่จะใส่ไม่ได้");
  assert.ok(
    validateReviewDoc({ sections: [{ name: "ก", items: [{ who: "คุณเอ", url: "https://www.facebook.com/profile.php?id=1" }] }] })
      .some((e) => e.includes("บอทหยิบไปใช้ไม่ได้")),
    "ลิงก์ที่ตัวอ่านของบอทรับไม่ได้ ต้องเตือนตั้งแต่ตอนกรอก");
});

test("ตัวอ่านของ follow-up ต้องยังอ่านผลลัพธ์จากฟอร์มได้ครบทุกใบ", () => {
  const rebuilt = renderReviewDoc(parseReviewDoc(DOC));
  const reviews = parseReviewCatalog([{ title: "รีวิวนักเรียนจริง แยกตามคลาส", content: rebuilt, active: 1 }]);
  assert.equal(reviews.length, 4, "รีวิวต้องครบทุกใบหลังบันทึกจากฟอร์ม");
  assert.equal(reviews[0].section, "Classroom : AI Agent For Business");
  assert.equal(reviews[2].url, "https://www.facebook.com/share/v/1TstVb02Bb/?mibextid=wwXIfr",
    "query ท้ายลิงก์ห้ามหาย — เป็นลิงก์คนละอันถ้าตัดทิ้ง");
});

test("เพิ่มรีวิวใหม่แล้ว follow-up ต้องเห็นทันที", () => {
  const doc = parseReviewDoc(DOC);
  doc.sections[0].items.push({ who: "คุณทดสอบสี่ — เจ้าของคลินิกความงาม", url: "https://www.facebook.com/share/r/1TstRd04Dd/" });
  const reviews = parseReviewCatalog([{ title: "รีวิวนักเรียนจริง", content: renderReviewDoc(doc), active: 1 }]);
  assert.equal(reviews.length, 5);
  assert.ok(reviews.some((r) => r.who.includes("คลินิกความงาม")), "รีวิวใหม่ต้องอยู่ในคลังที่บอทหยิบได้");
});

test("ตรวจก่อนบันทึก: ลิงก์นอก Facebook ลิงก์ซ้ำ และคำอธิบายว่าง ต้องถูกปัด", () => {
  const bad = {
    sections: [{
      name: "กลุ่มทดสอบ",
      items: [
        { who: "", url: "https://www.facebook.com/share/r/1/" },
        { who: "คุณเอ", url: "https://evil.example.com/x" },
        { who: "คุณบี", url: "http://www.facebook.com/share/r/2/" },
        { who: "คุณซี", url: "https://www.facebook.com/share/r/1/" },
        { who: "คุณดี | แทรกท่อ", url: "https://www.facebook.com/share/r/3/" },
      ],
    }],
  };
  const errors = validateReviewDoc(bad);
  assert.ok(errors.some((e) => e.includes("ใครรีวิว")), "คำอธิบายว่างต้องไม่ผ่าน — ระบบใช้จับคู่ธุรกิจลูกค้า");
  assert.ok(errors.some((e) => e.includes("evil.example.com")), "ลิงก์นอก Facebook ต้องไม่ผ่าน");
  assert.ok(errors.some((e) => e.includes("https://")), "ลิงก์ http ต้องไม่ผ่าน");
  assert.ok(errors.some((e) => e.includes("ซ้ำ")), "ลิงก์ซ้ำต้องไม่ผ่าน");
  assert.ok(errors.some((e) => e.includes("|")), "เครื่องหมาย | ทำให้บรรทัดถูกอ่านผิด");
});

test("ของที่ถูกต้องต้องผ่านฉลุย", () => {
  assert.deepEqual(validateReviewDoc(parseReviewDoc(DOC)), []);
});
