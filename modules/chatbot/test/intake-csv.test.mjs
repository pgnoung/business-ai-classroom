import test from "node:test";
import assert from "node:assert/strict";
import { parseIntakeCsv, rowsFromIntakeCsv, suggestedIntakeColumns } from "../public/console/intakeCsv.mjs";

test("intake CSV accepts UTF-8 BOM, quotes, escaped quotes and embedded newlines", () => {
  const parsed = parseIntakeCsv("\uFEFFหัวข้อ,คำถาม,คำตอบ\r\n\"เรื่อง, หนึ่ง\",\"ถาม\nต่อ\",\"ตอบ \"\"ได้\"\"\"");
  assert.deepEqual(parsed.headers, ["หัวข้อ", "คำถาม", "คำตอบ"]);
  assert.deepEqual(parsed.rows[0], { "หัวข้อ": "เรื่อง, หนึ่ง", "คำถาม": "ถาม\nต่อ", "คำตอบ": "ตอบ \"ได้\"" });
  const mapping = suggestedIntakeColumns(parsed.headers);
  assert.deepEqual(rowsFromIntakeCsv(parsed, mapping), [{ title: "เรื่อง, หนึ่ง", question: "ถาม\nต่อ", answer: "ตอบ \"ได้\"" }]);
});

test("intake CSV rejects duplicate headers, malformed rows and oversized input", () => {
  assert.throws(() => parseIntakeCsv("title,TITLE\na,b"), /ซ้ำ/u);
  assert.throws(() => parseIntakeCsv("title,question\na"), /จำนวนคอลัมน์/u);
  assert.throws(() => parseIntakeCsv("title\n\"a\"x"), /ผิดรูปแบบ/u);
  assert.throws(() => parseIntakeCsv("title\na", { maxBytes: 2 }), /ใหญ่เกิน/u);
});
