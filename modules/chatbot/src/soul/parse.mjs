// soul/parse.mjs — อ่านไฟล์ soul.md ของ instance ให้เป็นโครงสร้าง (ฟังก์ชันบริสุทธิ์ ไม่แตะไฟล์ ไม่แตะ state)
//
// รูปแบบไฟล์ (ดู SOUL_INTEGRATION_PLAN.md ขั้นที่ 1):
//   front matter  --- key: value --- ที่หัวไฟล์ (ไม่ส่งเข้าโมเดล)
//   ส่วน A        <!-- soul:part=A:start --> … <!-- soul:part=A:end -->   ตัวตนที่ส่งทุกข้อความ
//   ส่วน B        <!-- soul:part=B:start --> … <!-- soul:part=B:end -->   คู่มือที่หยิบตามบริบท (<!-- soul:B id=… topics=… -->)
//   ส่วน C        <!-- soul:part=C:start --> … <!-- soul:part=C:end -->   สัญญาที่เทสต์ตรวจ (ไม่ส่งเข้าโมเดล)
// ในส่วน A มีบล็อกต่อเส้นได้: <!-- soul:path=v3:start --> … <!-- soul:path=v3:end -->
//   ข้อความในบล็อกคือ "ทุกไบต์ระหว่างบรรทัดตัวแบ่ง" — ไม่ตัดช่องว่าง ไม่ตัดหัวข้อ (ฉบับ parity ต้องตรงตัวกับพรอมต์เดิม)
//   ในบล็อกมีช่องเติมได้: บรรทัด <!-- soul:slot=output-format --> ทั้งบรรทัดถูกแทนด้วยข้อความที่ chassis ส่งมา
// ขั้นที่ 3 (20 ต.ค. 2026) — soul ที่เขียนแก่นครั้งเดียว (ฉบับ v1.1): ส่วน A เป็นข้อความล้วน แล้ว "ส่วน P" บอกว่าแต่ละเส้นได้อะไร
//   ส่วน P        <!-- soul:part=P:start --> … <!-- soul:part=P:end -->   สูตรประกอบต่อเส้น (บล็อก soul:path เหมือนเดิม)
//   ในบล็อกของส่วน P ใช้บรรทัดดึงข้อความได้: <!-- soul:include=A --> = ส่วน A ทั้งหมด (หลังคอมไพล์)
//                                          <!-- soul:include=B:<id> --> = หัวข้อนั้นของส่วน B
//   ถ้อยคำห่อหัว/ท้ายของแต่ละเส้นอยู่ในไฟล์ instance เอง — chassis ไม่มีชื่อแบรนด์
//   บล็อกต่อเส้นอยู่ได้ที่เดียว: ในส่วน A (ฉบับ parity) หรือในส่วน P (ฉบับคอมไพล์) ห้ามปนกัน
// ตัวแบ่งทุกตัวต้องอยู่บรรทัดของตัวเอง · ไฟล์ต้องเป็น LF (CR ทำให้ byte-parity เพี้ยนเงียบ ๆ จึงปฏิเสธ)

// เส้นที่ตัวตนไปถึงโมเดล (audit 17–18 ต.ค. 2026: 7 จุด — v3 แยกเป็นธรรมนูญกับข้อมูลธุรกิจ)
export const SOUL_PATHS = Object.freeze([
  "v3", // ธรรมนูญของเครื่องตอบ v3 (มีช่องเติม output-format)
  "v3Business", // ข้อมูลธุรกิจที่ตามหลังธรรมนูญในบล็อกแคชแรกของ v3
  "legacy", // น้ำเสียงคนคุยแชทของเครื่องเก่า (natural_voice_mode=on) — ว่าง = ไม่เปลี่ยนน้ำเสียง
  "followup", // persona ที่ทักตาม/YOLO/followupEngine/เครื่องเก่าใช้
  "ownerChat", // ตัวตนตอนคุยกับเจ้าของทาง Telegram
  "offtopic", // บรรทัดตัวตนของผู้ตรวจแชทนอกเรื่อง
  "ownerReview", // บรรทัดตัวตนของห้องตรวจ (เสนอปิด + คิวรายวัน)
  "qualify", // บรรทัดตัวตนของตัวคัดกรอง
]);
export const SOUL_PARTS = Object.freeze(["A", "B", "C", "P"]);

const PART_MARK = /^<!--\s*soul:part=([ABCP]):(start|end)\b[^>]*-->$/u;
const PATH_MARK = /^<!--\s*soul:path=([A-Za-z0-9]+):(start|end)\s*-->$/u;
const B_MARK = /^<!--\s*soul:B\s+([^>]*?)\s*-->$/u;
export const SLOT_MARK = /^<!--\s*soul:slot=([a-z0-9-]+)\s*-->$/u;
const INCLUDE_MARK = /^<!--\s*soul:include=(A|B:[a-z0-9-]+)\s*-->$/u;
const PART_HEADING = /^#{1,3}\s*ส่วน\s*[ABCP]\b/u;

function fail(message) {
  throw new Error(`soul: ${message}`);
}

/** front matter แบบ key: value บรรทัดเดียว (พอสำหรับ soul — ไม่ใช่ YAML เต็ม) */
export function splitFrontMatter(raw) {
  if (!raw.startsWith("---\n")) return { frontMatter: {}, body: raw, bodyStartLine: 0 };
  const end = raw.indexOf("\n---\n", 4);
  if (end < 0) fail("front matter ไม่มีบรรทัดปิด ---");
  const frontMatter = {};
  for (const line of raw.slice(4, end).split("\n")) {
    const match = /^([A-Za-z0-9_]+):\s*(.*)$/u.exec(line);
    if (match) frontMatter[match[1]] = match[2].trim();
  }
  const body = raw.slice(end + 5);
  return { frontMatter, body, bodyStartLine: raw.slice(0, end + 5).split("\n").length - 1 };
}

function parseBAttrs(text) {
  const attrs = {};
  for (const match of String(text).matchAll(/([a-z]+)=(\S+)/gu)) attrs[match[1]] = match[2];
  return { id: attrs.id || "", topics: attrs.topics ? attrs.topics.split(",").map((t) => t.trim()).filter(Boolean) : [] };
}

/** ข้อความของส่วน (ไม่รวมบล็อกต่อเส้น) หลังตัดหัวข้อส่วนและตัวแบ่ง — ยุบบรรทัดว่างซ้อนเหลือบรรทัดเดียว */
function compileLines(lines) {
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (PART_HEADING.test(trimmed) || /^<!--\s*soul:/u.test(trimmed)) continue;
    if (!trimmed && (!kept.length || !kept[kept.length - 1].trim())) continue;
    kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  return kept.join("\n");
}

/**
 * แยก soul.md เป็นโครงสร้าง — โยน Error เมื่อรูปแบบผิด (ตัวแบ่งซ้อน/ขาด/ชื่อเส้นที่ระบบไม่รู้จัก)
 * คืน { frontMatter, parts: {A,B,C} (ข้อความหลังคอมไพล์), paths: {ชื่อ: ข้อความดิบ}, bItems: [{id,topics,text}] }
 */
export function parseSoul(raw) {
  if (typeof raw !== "string" || !raw.trim()) fail("ไฟล์ว่าง");
  if (raw.includes("\r")) fail("ไฟล์ต้องเป็น LF (เจอ CR)");
  const { frontMatter, body } = splitFrontMatter(raw);
  const partLines = { A: [], B: [], C: [], P: [] };
  const seenParts = new Set();
  const paths = {};
  const pathParts = new Set();
  const bItems = [];
  let part = null;
  let path = null;
  let pathLines = [];
  let bItem = null;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    const partMark = PART_MARK.exec(trimmed);
    const pathMark = PATH_MARK.exec(trimmed);
    if (path) {
      if (pathMark) {
        if (pathMark[2] !== "end" || pathMark[1] !== path) fail(`บล็อก ${path} ปิดด้วย ${trimmed}`);
        paths[path] = pathLines.join("\n");
        path = null;
        pathLines = [];
      } else if (partMark) {
        fail(`บล็อก ${path} ยังไม่ปิดก่อน ${trimmed}`);
      } else {
        pathLines.push(line);
      }
      continue;
    }
    if (partMark) {
      const [, name, edge] = partMark;
      if (edge === "start") {
        if (part) fail(`ส่วน ${part} ยังไม่ปิดก่อนเปิดส่วน ${name}`);
        if (seenParts.has(name)) fail(`ส่วน ${name} ซ้ำ`);
        seenParts.add(name);
        part = name;
      } else {
        if (part !== name) fail(`ปิดส่วน ${name} ทั้งที่เปิดส่วน ${part || "-"} อยู่`);
        part = null;
        bItem = null;
      }
      continue;
    }
    if (pathMark) {
      if (part !== "A" && part !== "P") fail(`บล็อกต่อเส้น ${pathMark[1]} ต้องอยู่ในส่วน A หรือส่วน P`);
      pathParts.add(part);
      if (pathMark[2] !== "start") fail(`ปิดบล็อก ${pathMark[1]} โดยไม่ได้เปิด`);
      if (!SOUL_PATHS.includes(pathMark[1])) fail(`ไม่รู้จักเส้น ${pathMark[1]} (มี ${SOUL_PATHS.join(", ")})`);
      if (Object.hasOwn(paths, pathMark[1])) fail(`บล็อก ${pathMark[1]} ซ้ำ`);
      path = pathMark[1];
      continue;
    }
    if (!part) continue; // นอกส่วน = คำอธิบายสำหรับคนอ่าน ไม่ส่งเข้าโมเดล
    const bMark = part === "B" ? B_MARK.exec(trimmed) : null;
    if (bMark) {
      bItem = { ...parseBAttrs(bMark[1]), lines: [] };
      bItems.push(bItem);
      continue;
    }
    partLines[part].push(line);
    if (bItem) bItem.lines.push(line);
  }
  if (path) fail(`บล็อก ${path} ไม่มีบรรทัดปิด`);
  if (part) fail(`ส่วน ${part} ไม่มีบรรทัดปิด`);
  if (!seenParts.has("A")) fail("ไม่มีส่วน A");
  if (pathParts.size > 1) fail("บล็อกต่อเส้นอยู่ทั้งในส่วน A และส่วน P — เลือกที่เดียว");
  const definedPaths = Object.keys(paths);
  if (definedPaths.length && definedPaths.length !== SOUL_PATHS.length) {
    // soul ที่แยกต่อเส้นต้องครบทุกเส้น — เส้นที่ขาดจะตกไปใช้ค่ากลางแบบเงียบ ๆ (พฤติกรรมเปลี่ยนโดยไม่มีใครรู้)
    fail(`soul แบบแยกต่อเส้นต้องมีครบ ${SOUL_PATHS.length} เส้น (ขาด ${SOUL_PATHS.filter((p) => !definedPaths.includes(p)).join(", ")})`);
  }
  const parts = { A: compileLines(partLines.A), B: compileLines(partLines.B), C: compileLines(partLines.C), P: compileLines(partLines.P) };
  const compiledItems = bItems.map(({ id, topics, lines }) => ({ id, topics, text: compileLines(lines) }));
  const compiled = pathParts.has("P");
  return {
    frontMatter,
    parts,
    paths: compiled ? expandIncludes(paths, parts.A, compiledItems) : paths,
    bItems: compiledItems,
    compiled,
  };
}

/**
 * ประกอบบล็อกของส่วน P — บรรทัด include ถูกแทนด้วยส่วน A / หัวข้อในส่วน B (หลังคอมไพล์)
 * ดึงสิ่งที่ไม่มี (ส่วน A ว่าง · id ของส่วน B ที่ไม่มี) = Error · บรรทัด include ในส่วน A ไม่ถูกแตะ (ฉบับ parity ไม่มี)
 */
function expandIncludes(paths, partA, bItems) {
  const byId = new Map(bItems.map((item) => [item.id, item.text]));
  const out = {};
  for (const [name, text] of Object.entries(paths)) {
    out[name] = text.split("\n").map((line) => {
      const match = INCLUDE_MARK.exec(line.trim());
      if (!match) return line;
      if (match[1] === "A") {
        if (!partA.trim()) fail(`บล็อก ${name} ดึงส่วน A แต่ส่วน A ว่าง`);
        return partA;
      }
      const id = match[1].slice(2);
      if (!byId.has(id)) fail(`บล็อก ${name} ดึงส่วน B "${id}" ที่ไม่มีในไฟล์`);
      return byId.get(id);
    }).join("\n");
  }
  return out;
}

/** แทนบรรทัดช่องเติมด้วยข้อความของ chassis — ช่องที่ไม่มีค่าส่งมา = Error (กันพรอมต์ที่มีตัวแบ่งหลุดถึงโมเดล) */
export function fillSlots(text, slots = {}) {
  return String(text).split("\n").map((line) => {
    const match = SLOT_MARK.exec(line.trim());
    if (!match) return line;
    if (!Object.hasOwn(slots, match[1])) fail(`ช่องเติม ${match[1]} ไม่มีค่า`);
    return String(slots[match[1]]);
  }).join("\n");
}

export function slotNames(text) {
  return String(text).split("\n").map((line) => SLOT_MARK.exec(line.trim())?.[1]).filter(Boolean);
}
