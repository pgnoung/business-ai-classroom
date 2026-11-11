// soul/index.mjs — ช่อง soul ของ chassis: ตัวตนของร้านมาจากไฟล์ instance ที่เดียว (ขั้นที่ 1 ของแผน soul, 18 ต.ค. 2026)
//
// ก่อนหน้านี้ตัวตนของร้านกระจาย 7 จุดในโค้ดกลาง (ธรรมนูญ v3 · น้ำเสียงเครื่องเก่า · persona ทักตาม · owner chat ·
// ตัวปิดแชทนอกเรื่อง · ห้องตรวจ · ตัวคัดกรอง) — ไฟล์นี้คือทางอ่านเดียว: soulBlock(เส้น)
//
//   loadSoul({ file, expectedSha256 })  อ่านไฟล์ + ตรวจ hash + แยกส่วน + ตรวจสัญญา C1/C2 (ผิด = Error ตอนบูต)
//   installSoul(soul | null)             ตั้ง soul ของโปรเซส (createApp เรียกครั้งเดียวตอนบูต — หนึ่งโปรเซส = หนึ่งร้าน)
//   soulBlock(path, { slots, fallback }) ข้อความของเส้นนั้น · ไม่มี soul = ค่ากลางที่ไม่มีชื่อแบรนด์ (หรือ fallback)
//   soulMeta()                           { soulVersion, soulSha } ที่จดลง meta ของข้อความขาออกทุกฟองที่ AI เขียน
//   soulInfo()                           ข้อมูลอ่านอย่างเดียวของหน้า #/soul ในคอนโซล
//
// ขั้นที่ 1 เปิดใช้ได้เฉพาะ soul แบบแยกต่อเส้น (ฉบับ parity: ทุกเส้นได้ข้อความเดิมตรงตัว)
// ขั้นที่ 3 (20 ต.ค. 2026): soul ที่เขียนแก่นครั้งเดียวติดตั้งได้เมื่อมีส่วน P (สูตรประกอบต่อเส้น — ดู parse.mjs)
//   และติดตั้งได้สองรุ่นพร้อมกัน: รุ่นหลัก (ที่ใช้อยู่) + รุ่นทดลอง (candidate) — ใครได้รุ่นไหนตัดสินที่ตัวเลือก (soulRollout.mjs)
//   installCandidateSoul(soul | null)    ติดตั้งรุ่นทดลอง (ไม่มี = ทุกห้องได้รุ่นหลักเหมือนขั้นที่ 1 ทุกไบต์)
//   setSoulSelector(fn)                  fn({ customerId }) → "candidate" | อื่น ๆ · เรียกด้วย {} = เส้นที่ไม่ผูกห้อง (owner chat ห้องตรวจ ตัวคัดกรอง)
//   withRoomSoul(customerId, work)       ทำงานของห้องนั้นด้วยรุ่นของห้อง (AsyncLocalStorage — soulBlock/soulMeta ข้างในอ่านรุ่นนี้)
//   scopedPersona(bootPersona)           persona ทักตาม/YOLO ของงานที่กำลังทำ — รุ่นหลัก = ค่าที่บูตไว้ตรงตัว (รวมไฟล์ persona ของ fork)
// ตัวเลือกพัง/โยน Error = รุ่นหลัก (ไม่มีทางที่ห้องจะได้รุ่นทดลองเพราะอ่านค่าตั้งผิด)
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { soulContract } from "./contract.mjs";
import { DEFAULT_SOUL_BLOCKS } from "./defaults.mjs";
import { fillSlots, parseSoul, SLOT_MARK, SOUL_PATHS } from "./parse.mjs";

export { SOUL_PATHS } from "./parse.mjs";
export { DEFAULT_SOUL_BLOCKS } from "./defaults.mjs";
export { soulContract } from "./contract.mjs";
export { parseSoul } from "./parse.mjs";

// ป้ายของแต่ละเส้นในหน้า #/soul — บอกว่าข้อความไปถึงงานไหนจริง (ไม่มีชื่อแบรนด์)
export const SOUL_PATH_LABELS = Object.freeze({
  v3: "เครื่องตอบ v3 — บล็อกแคชแรก ส่วนธรรมนูญ (ต่อท้ายด้วยรูปแบบคำตอบที่ล็อกในโค้ด)",
  v3Business: "เครื่องตอบ v3 — บล็อกแคชแรก ส่วนข้อมูลธุรกิจ",
  legacy: "เครื่องเก่า (เส้นปิดการขาย ส่งต่อ โปรเจกต์ ดูแลใจ ฯลฯ) เมื่อเปิดน้ำเสียงคนคุยแชท",
  followup: "persona ของทักตาม 5 ขั้น · followupEngine · YOLO · เครื่องเก่าเมื่อปิดน้ำเสียงคนคุยแชท",
  ownerChat: "แชทกับเจ้าของทาง Telegram (ส่วนตัวตนและวิธีพูด)",
  offtopic: "ผู้ตรวจแชทนอกเรื่อง (บรรทัดตัวตน)",
  ownerReview: "ห้องตรวจ: เสนอปิดห้อง + คิวตรวจรายวัน (บรรทัดตัวตน)",
  qualify: "ตัวคัดกรองลูกค้า (บรรทัดตัวตน)",
});

// ลำดับชั้นที่ชนะกัน (สูง → ต่ำ) — หน้า #/soul แสดงให้เห็นว่า soul อยู่ตรงไหน
export const SOUL_LAYERS = Object.freeze([
  { id: "chassis", label: "ด่านของระบบ (เงิน ตัวตน PDPA ส่งต่อคน รูปแบบคำตอบ)", editable: false },
  { id: "soul", label: "soul ของร้าน (ไฟล์นี้)", editable: false },
  { id: "knowledge", label: "ความรู้ ราคา รอบเรียนที่อนุมัติ", editable: true },
  { id: "stage", label: "งานของจังหวะ (โค้ดของเครื่องตอบ)", editable: false },
  { id: "lessons", label: "บทเรียนที่เจ้าของสอน", editable: true },
]);

export const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

let active = null;
let candidate = null;
let selector = null;
const roomScope = new AsyncLocalStorage();

/**
 * โหลด soul ของ instance — ไม่ตั้ง file = null (ใช้ค่ากลาง)
 * ตั้ง file แล้วอ่านไม่ได้ / hash ไม่ตรง / รูปแบบผิด / สัญญาไม่ผ่าน = Error (fail closed ตอนบูต ไม่ตกไปใช้ค่ากลางเงียบ ๆ)
 */
export function loadSoul({ file = "", expectedSha256 = "", allowGeneric = false } = {}) {
  if (!file) {
    if (expectedSha256) throw new Error("Soul integrity check failed: SOUL_SHA256 is set but SOUL_FILE is empty.");
    return null;
  }
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`Soul integrity check failed: configured soul file is unreadable (${error?.code || "read_error"}).`);
  }
  const actual = sha256(raw);
  if (expectedSha256) {
    if (!/^[a-f0-9]{64}$/u.test(expectedSha256)) throw new Error("Soul integrity check failed: SOUL_SHA256 must be 64 lowercase hex characters.");
    if (actual !== expectedSha256) throw new Error("Soul integrity check failed: soul content does not match SOUL_SHA256.");
  }
  const parsed = parseSoul(raw);
  if (!Object.keys(parsed.paths).length && !allowGeneric) {
    throw new Error("Soul format not activatable: add per-path blocks (<!-- soul:path=…:start -->) in part A, or a part P compile recipe.");
  }
  const contract = soulContract(parsed);
  if (!contract.ok) throw new Error(`Soul contract failed: ${contract.failures.join(" · ")}`);
  const fm = parsed.frontMatter;
  return Object.freeze({
    file, fileName: basename(file), sha256: actual,
    soulId: fm.soul_id || "", version: fm.version || "", status: fm.status || "",
    approvedBy: fm.approved_by || fm.owner || "", activatedAt: fm.activated || "",
    frontMatter: Object.freeze({ ...fm }),
    parts: Object.freeze({ ...parsed.parts }), paths: Object.freeze({ ...parsed.paths }), compiled: Boolean(parsed.compiled),
    bItems: Object.freeze(parsed.bItems.map((item) => Object.freeze(item))),
    contract, loadedAt: new Date().toISOString(),
  });
}

/** ตั้ง soul ของโปรเซส — คืนตัวเดิม (เทสต์ใช้คืนค่า) */
export function installSoul(soul) {
  if (soul && !Object.keys(soul.paths || {}).length) throw new Error("installSoul: soul has no per-path blocks (part A blocks or part P recipe).");
  const previous = active;
  active = soul || null;
  return previous;
}

/** รุ่นทดลอง — ต้องมีรุ่นหลักก่อน (fork ที่ไม่มี soul ทดลองรุ่นไม่ได้) และต้องต่างจากรุ่นหลัก */
export function installCandidateSoul(soul) {
  if (soul && !Object.keys(soul.paths || {}).length) throw new Error("installCandidateSoul: soul has no per-path blocks.");
  if (soul && !active) throw new Error("installCandidateSoul: install the primary soul first.");
  if (soul && soul.sha256 === active.sha256) throw new Error("installCandidateSoul: candidate is the same file as the primary soul.");
  const previous = candidate;
  candidate = soul || null;
  return previous;
}

/** ตัวเลือกรุ่นต่อห้อง — null = ทุกห้องได้รุ่นหลัก */
export function setSoulSelector(fn) {
  const previous = selector;
  selector = typeof fn === "function" ? fn : null;
  return previous;
}

export function activeSoul() {
  return active;
}

export function candidateSoul() {
  return candidate;
}

function choose(context) {
  if (!candidate || !selector) return active;
  try {
    return selector(context) === "candidate" ? candidate : active;
  } catch {
    return active;
  }
}

/** รุ่นของห้องนี้ (ไม่มีรุ่นทดลอง/ตัวเลือก = รุ่นหลัก) */
export function soulForRoom(customerId) {
  return choose({ customerId: String(customerId ?? "") });
}

/** soul ที่งานตอนนี้ใช้ — ในงานของห้อง = รุ่นของห้อง · นอกนั้น = รุ่นของเส้นที่ไม่ผูกห้อง */
export function currentSoul() {
  const scoped = roomScope.getStore();
  if (scoped) return scoped.soul;
  return choose({});
}

/** ทำงานของห้องด้วยรุ่นของห้อง — งานซ้อนในห้องเดียวกันใช้รุ่นเดิม (ไม่ตัดสินใหม่กลางเทิร์น) */
export function withRoomSoul(customerId, work) {
  const scoped = roomScope.getStore();
  const id = String(customerId ?? "");
  if (scoped && scoped.customerId === id) return work();
  return roomScope.run({ customerId: id, soul: soulForRoom(id) }, work);
}

/** persona ของทักตาม/YOLO/followupEngine — รุ่นหลัก = ค่าที่บูตไว้ตรงตัว · รุ่นทดลอง = เส้น followup ของรุ่นนั้น */
export function scopedPersona(bootPersona = "") {
  const soul = currentSoul();
  if (!soul || soul === active) return bootPersona;
  return String(soul.paths.followup ?? "");
}

// 7 พ.ย. 2026 (งานแคช): persona เส้นตอบแชทเครื่องเดิมกับเส้นทักตามเหมือนกันถึงส่วน A แล้วค่อยแยก
// จุดตัดอยู่ท้ายย่อหน้าสุดท้ายที่ร่วมกัน · แคชต่อ soul เพราะคำนวณจากข้อความราว 80k ตัวอักษร
const sharedPersonaCache = new WeakMap();
function sharedPersonaOf(soul) {
  if (sharedPersonaCache.has(soul)) return sharedPersonaCache.get(soul);
  const a = String(soul.paths?.legacy ?? "");
  const b = String(soul.paths?.followup ?? "");
  let end = 0;
  while (end < a.length && end < b.length && a[end] === b[end]) end += 1;
  const shared = a.slice(0, end);
  const boundary = shared.lastIndexOf("\n\n");
  const text = boundary < 0 ? "" : shared.slice(0, boundary + 2);
  sharedPersonaCache.set(soul, text);
  return text;
}

/**
 * ความยาวส่วนต้นของ persona ที่เส้นตอบแชทกับเส้นทักตามใช้ร่วมกัน เอาไว้ปักหมุดแคชก้อนเดียวให้สองเส้น
 * ไม่มี soul หรือ persona ไม่ได้ขึ้นต้นด้วยส่วนร่วม = 0 คือไม่ต้องแบ่ง
 */
export function sharedPersonaLength(persona = "") {
  const soul = currentSoul();
  if (!soul) return 0;
  const shared = sharedPersonaOf(soul);
  return shared && String(persona).startsWith(shared) ? shared.length : 0;
}

function rawBlock(path, fallback) {
  if (!SOUL_PATHS.includes(path)) throw new Error(`soulBlock: unknown path ${path}`);
  const soul = currentSoul();
  if (soul) return String(soul.paths[path] ?? "");
  if (typeof fallback === "function") return String(fallback() ?? "");
  if (fallback !== undefined) return String(fallback ?? "");
  return DEFAULT_SOUL_BLOCKS[path];
}

/**
 * ข้อความของเส้นนั้นตามที่ส่งเข้าโมเดล — slots = ค่าที่ chassis เติมแทนบรรทัด <!-- soul:slot=… -->
 * fallback (ค่าหรือฟังก์ชัน) ใช้แทนค่ากลางเมื่อไม่มี soul เช่น persona ไฟล์เดิมของ instance
 */
export function soulBlock(path, { slots = {}, fallback } = {}) {
  return fillSlots(rawBlock(path, fallback), slots);
}

/** meta ที่จดลงข้อความขาออก — ไม่มี soul = null (ไม่แตะ meta เลย) */
export function soulMeta() {
  const soul = currentSoul();
  if (!soul) return null;
  return { soulVersion: `${soul.soulId || "soul"}@${soul.version || "unversioned"}`, soulSha: soul.sha256.slice(0, 12) };
}

const SLOT_DISPLAY = (line) => {
  const match = SLOT_MARK.exec(line.trim());
  return match ? `⟪ชั้นที่ล็อกในโค้ด: ${match[1]}⟫` : line;
};

/** ข้อมูลอ่านอย่างเดียวของหน้า #/soul (ไม่มีข้อมูลลูกค้า ไม่มีความลับ — มีแต่ข้อความที่ส่งเข้าโมเดลอยู่แล้ว) */
function soulSummary(soul) {
  return soul ? {
    soulId: soul.soulId, version: soul.version, status: soul.status, fileName: soul.fileName, sha256: soul.sha256,
    chars: Object.fromEntries(SOUL_PATHS.map((path) => [path, [...String(soul.paths[path] ?? "")].length])),
    partAChars: [...String(soul.parts?.A || "")].length,
    contract: { ok: soul.contract.ok, checked: soul.contract.checked, unchecked: soul.contract.unchecked },
  } : null;
}

export function soulInfo({ followupFallback = "", rollout = null } = {}) {
  const soul = active;
  const paths = SOUL_PATHS.map((path) => {
    const fromSoul = Boolean(soul);
    const raw = fromSoul ? String(soul.paths[path] ?? "") : (path === "followup" && followupFallback ? followupFallback : DEFAULT_SOUL_BLOCKS[path]);
    return {
      path, label: SOUL_PATH_LABELS[path],
      source: fromSoul ? "soul" : (path === "followup" && followupFallback ? "persona_file" : "chassis_default"),
      sha256: sha256(raw), chars: [...raw].length,
      text: raw.split("\n").map(SLOT_DISPLAY).join("\n"),
    };
  });
  return {
    installed: Boolean(soul),
    soulId: soul?.soulId || "", version: soul?.version || "", status: soul?.status || "",
    approvedBy: soul?.approvedBy || "", activatedAt: soul?.activatedAt || "",
    fileName: soul?.fileName || "", sha256: soul?.sha256 || "", loadedAt: soul?.loadedAt || "",
    meta: soulMeta(),
    contract: soul ? { ok: soul.contract.ok, checked: soul.contract.checked, unchecked: soul.contract.unchecked } : null,
    partB: (soul?.bItems || []).map((item) => ({ id: item.id, topics: item.topics, chars: [...item.text].length })),
    layers: SOUL_LAYERS,
    paths,
    // รุ่นทดลอง + สถานะการเปิดใช้ (rollout มาจาก soulRollout.mjs — ไม่มี = ยังไม่ต่อสวิตช์)
    candidate: soulSummary(candidate),
    rollout,
  };
}
