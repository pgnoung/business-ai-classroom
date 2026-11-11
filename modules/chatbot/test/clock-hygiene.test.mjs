// clock-hygiene.test.mjs — ด่านกัน "สองนาฬิกา" ในชุดเทสต์กลับมาอีก
//
// อาการที่ด่านนี้จับ (ของจริง 28 ส.ค.–3 ก.ย. 2026): เทสต์ตรึงเวลาให้ "ตัวที่กำลังเทสต์"
// ด้วย now: () => CLOCK แต่สร้างฐานข้อมูลด้วย memoryDb()/openDb() ที่เดินตาม wall clock
// SQL ใน db (lease/cooldown/ความเงียบ) จึงเทียบกับเวลาจริงของเครื่อง ส่วนโค้ดเทียบกับ CLOCK
// พอวันจริงเดินผ่านวันที่ที่ตรึงไว้ เทสต์ก็พลิกผลเอง แล้วแดงค้างจนคนเลิกอ่านผล
// (claimBroadcast เทียบ preparing_lease_expires_at > now() แดงอยู่หลายสัปดาห์แบบนี้)
//
// กติกา: ในบล็อกเดียวกัน ถ้าฉีดนาฬิกาที่ "ตรึงไว้" ให้อะไรสักอย่าง ต้องฉีดตัวเดียวกันให้ db ด้วย
// นาฬิกาที่อ้างถึง Date.now (ตรง ๆ หรือผ่านตัวแปร) ไม่นับว่าตรึง — นั่นคือนาฬิกาเดียวกับ db อยู่แล้ว
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = "clock-hygiene.test.mjs";

// เปิดฐานข้อมูลโดยไม่มีคีย์ now (รับ object ซ้อนได้หนึ่งชั้น พอสำหรับทรงที่ใช้จริงในชุดนี้)
const DB_OPEN = /\b(?:memoryDb|openDb)\(\s*(\)|\{(?:[^{}]|\{[^{}]*\})*\})/gu;
// ฉีดนาฬิกาให้ตัวอื่น: `now: <expr>` (ไม่ใช่ชื่อคีย์อื่นที่ลงท้ายด้วย now)
const NOW_ARG = /(?<![\w$])now\s*:\s*([^,\n}]+)/gu;
// หัวบล็อกที่คอลัมน์ 0 = ขอบเขตที่ถือว่า "เรื่องเดียวกัน" (เทสต์หนึ่งตัว หรือ helper หนึ่งตัว)
const BLOCK_HEAD = /^(?:test\(|function |async function |const \w+ = (?:async )?\()/u;
const DECLARATION = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/gu;

const word = (name) => new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w$])`, "u");
const hasNowKey = (args) => /(?<![\w$])now(?![\w$])/u.test(args);

// ชื่อตัวแปรที่ค่าสุดท้ายมาจาก Date.now — ตามโซ่ต่อได้สองสามชั้น (เช่น const now = Date.now())
function wallClockNames(source) {
  const names = new Set();
  for (let pass = 0; pass < 3; pass += 1) {
    for (const [, name, init] of source.matchAll(DECLARATION)) {
      if (init.includes("Date.now") || [...names].some((n) => word(n).test(init))) names.add(name);
    }
  }
  return names;
}

function violations(fileName, source) {
  const walls = wallClockNames(source);
  const lines = source.split("\n");
  const heads = lines.flatMap((line, index) => (BLOCK_HEAD.test(line) ? [index] : []));
  const bounds = [...heads, lines.length];
  const found = [];
  for (let i = 0; i < heads.length; i += 1) {
    const from = bounds[i];
    const block = lines.slice(from, bounds[i + 1]).join("\n");
    const bareDb = [...block.matchAll(DB_OPEN)].some(([, args]) => args === ")" || !hasNowKey(args));
    if (!bareDb) continue;
    for (const [match, expression] of block.matchAll(NOW_ARG)) {
      const expr = expression.trim();
      if (expr.includes("Date.now")) continue;
      if ([...walls].some((name) => word(name).test(expr))) continue;
      const line = from + 1 + block.slice(0, block.indexOf(match)).split("\n").length - 1;
      found.push(`${fileName}:${line} — ฉีด now: ${expr} ให้ตัวที่กำลังเทสต์ แต่เปิด db ในบล็อกเดียวกันโดยไม่ส่ง now ตัวเดียวกัน`);
      break; // รายงานบล็อกละหนึ่งครั้งพอ — แก้ที่ db ตัวเดียวก็หายทั้งบล็อก
    }
  }
  return found;
}

test("ชุดเทสต์ห้ามมีสองนาฬิกา: ตรึงเวลาให้ตัวที่กำลังเทสต์แล้วต้องตรึงให้ db ด้วย", () => {
  const files = readdirSync(TEST_DIR).filter((name) => name.endsWith(".test.mjs") && name !== SELF);
  assert.ok(files.length > 100, `ต้องสแกนเจอไฟล์เทสต์ทั้งชุด (เจอ ${files.length}) — ไม่งั้นด่านนี้ผ่านฟรี`);
  const found = files.flatMap((name) => violations(name, readFileSync(join(TEST_DIR, name), "utf8")));
  assert.deepEqual(found, [], `พบเทสต์ที่เดินสองนาฬิกา:\n${found.join("\n")}\n\nวิธีแก้: ส่งนาฬิกาตัวเดียวกันให้ db ด้วย เช่น memoryDb({ now: () => CLOCK })`);
});

// ด่านต้องจับของจริงได้ ไม่ใช่ผ่านเพราะ regex ไม่เคยแมตช์อะไรเลย
test("ด่านสองนาฬิกา: จับทรงที่เคยเน่าได้ และปล่อยทรงที่ถูกต้องผ่าน", () => {
  const rotted = [
    'test("x", () => {',
    "  const db = memoryDb();",
    "  const engine = createEngine({ db, now: () => CLOCK });",
    "});",
  ].join("\n");
  assert.equal(violations("rotted.mjs", rotted).length, 1, "ทรงสองนาฬิกาต้องถูกจับ");

  const fixed = rotted.replace("memoryDb()", "memoryDb({ now: () => CLOCK })");
  assert.deepEqual(violations("fixed.mjs", fixed), [], "ฉีดนาฬิกาให้ db แล้วต้องผ่าน");

  const wallClock = [
    'test("x", () => {',
    "  const db = memoryDb();",
    "  const now = Date.now();",
    "  const tags = compute(db, { now: () => now });",
    "});",
  ].join("\n");
  assert.deepEqual(violations("wall.mjs", wallClock), [], "นาฬิกาเดียวกับ db (wall clock) ต้องไม่ถูกจับ");
});
