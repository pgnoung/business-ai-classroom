// Small, deliberately boring CSV reader for the training intake screen.
// It parses text already selected by the operator; it never fetches or uploads a file.
export const INTAKE_CSV_MAX_BYTES = 1024 * 1024;

function byteLength(text) {
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}

export function parseIntakeCsv(input, { maxBytes = INTAKE_CSV_MAX_BYTES } = {}) {
  if (typeof input !== "string") throw new Error("CSV ต้องเป็นข้อความ UTF-8");
  if (byteLength(input) > maxBytes) throw new Error("ไฟล์ CSV ใหญ่เกิน 1 MiB");
  const text = input.replace(/^\uFEFF/u, "");
  const rows = [];
  let row = [], field = "", quoted = false, atStart = true, justClosed = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else { quoted = false; justClosed = true; }
      } else field += char;
      continue;
    }
    if (justClosed && char !== "," && char !== "\n" && char !== "\r") throw new Error(`CSV ผิดรูปแบบที่แถว ${rows.length + 1}`);
    if (char === '"') {
      if (!atStart) throw new Error(`CSV ผิดรูปแบบที่แถว ${rows.length + 1}`);
      quoted = true;
      atStart = false;
    } else if (char === ",") {
      row.push(field); field = ""; atStart = true; justClosed = false;
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = ""; atStart = true; justClosed = false;
      // A final trailing newline is not a data row.
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
    } else {
      field += char;
      atStart = false;
    }
  }
  if (quoted) throw new Error("CSV มีเครื่องหมายคำพูดเปิดค้างอยู่");
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) throw new Error("CSV ว่าง");
  const headers = rows.shift().map((value) => value.trim());
  if (!headers.length || headers.some((value) => !value)) throw new Error("หัวคอลัมน์ CSV ว่าง");
  const unique = new Set(headers.map((value) => value.toLocaleLowerCase()));
  if (unique.size !== headers.length) throw new Error("หัวคอลัมน์ CSV ซ้ำกัน");
  const width = headers.length;
  if (rows.some((values) => values.length !== width)) throw new Error("จำนวนคอลัมน์ของบางแถวไม่ตรงกับหัวตาราง");
  return { headers, rows: rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]]))) };
}

export function suggestedIntakeColumns(headers = []) {
  const choose = (words) => headers.find((header) => words.includes(String(header).trim().toLocaleLowerCase())) || "";
  return {
    title: choose(["title", "หัวข้อ", "topic", "เรื่อง"]),
    question: choose(["question", "คำถาม", "question text", "ข้อความลูกค้า"]),
    answer: choose(["answer", "คำตอบ", "reply", "คำตอบทีม"]),
  };
}

export function rowsFromIntakeCsv(parsed, mapping) {
  const required = ["title", "question", "answer"];
  if (required.some((key) => !mapping?.[key] || !parsed.headers.includes(mapping[key]))) {
    throw new Error("เลือกคอลัมน์หัวข้อ คำถาม และคำตอบให้ครบก่อน");
  }
  return parsed.rows.map((row) => ({
    title: String(row[mapping.title] ?? ""),
    question: String(row[mapping.question] ?? ""),
    answer: String(row[mapping.answer] ?? ""),
  }));
}
