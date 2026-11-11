// console-layout.test.mjs — regression guard ของบั๊ก layout (2026-08-10):
// "เดสก์ท็อปเปิดห้องแชทแล้วห้องไปกองใต้รายการแชท"
//
// สาเหตุจริง: กฎ desktop `.chat-workspace { grid-template-columns: 360px 1fr }`
// เคยอยู่ใน console.css ซึ่งโหลด "ก่อน" workspace.css — media query ไม่เพิ่ม
// specificity ดังนั้นกฎ base คอลัมน์เดียวใน workspace.css (specificity เท่ากัน
// แต่มาทีหลังใน cascade) ทับกฎ desktop เสมอ เหลือรอดแค่ `.chat-workspace.ctx-open`
// (0,2,0) — split view เลยพังทุกสถานะที่ไม่มี class ctx-open
//
// เทสต์นี้ล็อก invariant เชิงโครงสร้าง (ไม่มี browser ใน suite นี้):
// 1. console.css ต้องไม่มี selector .chat-workspace เลย (เจ้าของเดียว = workspace.css)
// 2. workspace.css ต้องมีกฎ base คอลัมน์เดียว และกฎ desktop >=2 คอลัมน์
//    โดยกฎ desktop อยู่ "หลัง" กฎ base ในไฟล์เดียวกัน (cascade ในไฟล์เดียว
//    deterministic — จะไม่โดนทับข้ามไฟล์อีก)
// 3. ctx-open บนเดสก์ท็อปได้ 3 คอลัมน์ (list | room | context)
// 4. index.html ยังโหลดทั้งสองไฟล์ (workspace.css อยู่หลัง console.css)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "console");

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

// เดิน CSS แบบเบา ๆ: คืนรายการ { selector, body, media, index } ทุก rule
// (รองรับ media ซ้อน 1 ชั้น — พอสำหรับไฟล์ console ซึ่งไม่ซ้อนลึกกว่านั้น)
function parseRules(css) {
  const text = stripComments(css);
  const rules = [];
  const stack = []; // media context ปัจจุบัน
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open === -1) break;
    const head = text.slice(i, open).trim();
    if (head.startsWith("@media")) {
      stack.push(head);
      i = open + 1;
      continue;
    }
    // rule ปกติ: หา } ปิดของ body (body ของ console ไม่มี brace ซ้อน)
    const close = text.indexOf("}", open);
    if (close === -1) break;
    rules.push({
      selector: head,
      body: text.slice(open + 1, close).trim(),
      media: stack[stack.length - 1] || null,
      index: open,
    });
    i = close + 1;
    // ข้าม } ปิด media block ที่ตามมา
    while (text[i] === "}" || text[i] === "\n" || text[i] === " " || text[i] === "\t" || text[i] === "\r") {
      if (text[i] === "}") stack.pop();
      i += 1;
    }
  }
  return rules;
}

const countColumns = (body) => {
  const m = /grid-template-columns\s*:\s*([^;]+)/.exec(body);
  if (!m) return 0;
  // นับจำนวน track: minmax(...) นับเป็น 1 — ตัดวงเล็บออกก่อนแล้วนับคำ
  const flat = m[1].replace(/\([^)]*\)/g, "()").trim();
  return flat.split(/\s+/).length;
};

test("W1 layout: console.css ไม่มี selector .chat-workspace (เจ้าของเดียวคือ workspace.css)", () => {
  const consoleCss = stripComments(readFileSync(join(STATIC_DIR, "console.css"), "utf8"));
  assert.ok(
    !consoleCss.includes(".chat-workspace"),
    "พบ .chat-workspace ใน console.css — ห้ามย้ายกลับ: ไฟล์นี้โหลดก่อน workspace.css แล้วกฎ base จะทับกฎ desktop (บั๊กห้องแชทกองใต้รายการแชทจะกลับมา)"
  );
});

test("W1 layout: workspace.css มี base 1 คอลัมน์ + desktop >=2 คอลัมน์ และ desktop มาทีหลังใน cascade", () => {
  const rules = parseRules(readFileSync(join(STATIC_DIR, "workspace.css"), "utf8"));
  const workspaceRules = rules.filter((r) => r.selector === ".chat-workspace");

  const base = workspaceRules.find((r) => !r.media && countColumns(r.body) === 1);
  assert.ok(base, "ต้องมีกฎ base มือถือ .chat-workspace คอลัมน์เดียวใน workspace.css");

  const desktop = workspaceRules.filter(
    (r) => r.media?.includes("min-width: 1024px") && countColumns(r.body) >= 2
  );
  assert.ok(desktop.length >= 1, "ต้องมีกฎ desktop .chat-workspace แบบ >=2 คอลัมน์ใน workspace.css");
  for (const rule of desktop) {
    assert.ok(
      rule.index > base.index,
      "กฎ desktop ต้องอยู่หลังกฎ base ในไฟล์เดียวกัน — ไม่งั้นโดน base ทับ (specificity เท่ากัน)"
    );
  }
});

test("W1 layout: ctx-open บนเดสก์ท็อปได้ 3 คอลัมน์ (list | room | context)", () => {
  const rules = parseRules(readFileSync(join(STATIC_DIR, "workspace.css"), "utf8"));
  const ctxOpen = rules.filter(
    (r) => r.selector === ".chat-workspace.ctx-open" && r.media?.includes("min-width: 1024px")
  );
  assert.ok(ctxOpen.length >= 1, "ต้องมีกฎ desktop .chat-workspace.ctx-open");
  for (const rule of ctxOpen) {
    assert.equal(countColumns(rule.body), 3, "ctx-open เดสก์ท็อปต้องเป็น 3 คอลัมน์");
  }
});

test("W1 layout: index.html โหลด console.css ก่อน workspace.css (ลำดับที่ invariant นี้อิง)", () => {
  const html = readFileSync(join(STATIC_DIR, "index.html"), "utf8");
  const consoleAt = html.indexOf("console.css");
  const workspaceAt = html.indexOf("workspace.css");
  assert.ok(consoleAt !== -1 && workspaceAt !== -1, "index.html ต้องลิงก์ทั้งสองไฟล์");
  assert.ok(consoleAt < workspaceAt, "console.css (token) ต้องมาก่อน workspace.css");
});
