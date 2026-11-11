// customerResolver.mjs — หา "ห้องลูกค้า" จากชื่อที่พี่ง้วงพิมพ์ (YOLO / เปิด-ปิด AI / สถานะ)
//
// กติกาที่ออกแบบไว้ (2026-09-28, งาน YOLO):
// - โมเดลไม่เคยเป็นคนเลือกลูกค้า — ตัวนี้ตัดสินจากข้อมูลในฐานเท่านั้น ถ้าไม่แน่ใจ = ถามกลับ
// - ส่งผิดคนแพงที่สุดในระบบนี้ (ลูกค้าระดับ CEO ได้ข้อความของคนอื่น) จึงแยกผลสามแบบชัด ๆ
//     unique    = เจอคนเดียวแน่นอน (ชื่อตรงเป๊ะคนเดียว หรือมีผู้เข้าเค้าแค่คนเดียว)
//     ambiguous = หลายคน → ผู้เรียกต้องให้พี่ง้วงเลือกเลข
//     none      = ไม่เจอ → เสนอชื่อใกล้เคียง
// - ชื่อตรงเป๊ะคนเดียวแต่มีชื่อคล้ายอยู่ด้วย ติดธง hasSimilar ให้ผู้เรียกตัดสิน (YOLO ขอให้เลือกก่อน)
// - ไม่มีชื่อตรงเลย เจอแค่ "ขึ้นต้น/มีอยู่ในชื่อ" คนเดียว = unique แต่ติดธง loose ให้ผู้เรียกถามก่อนทำ
//   คำสั่งที่เปลี่ยนสถานะ (code review 2026-09-28: ชื่อสั้น 2 ตัวอักษรไปเข้ากลางชื่อคนผิดได้)
// - เทียบทั้ง known_name (ชื่อจริงที่ลูกค้าบอก) และ display_name (ชื่อโปรไฟล์) + คำแรกของแต่ละชื่อ
import { nameKey } from "./yoloText.mjs";

export const MAX_CHOICES = 5;
const MIN_QUERY_CHARS = 2;
const MAX_LEADING_TOKENS = 5;

// ชื่อหลายรูปของห้องหนึ่ง: ชื่อเต็มสองแบบ + คำแรกของแต่ละแบบ (พี่ง้วงมักพิมพ์แค่ชื่อต้น)
export function nameVariants(row) {
  const out = new Set();
  for (const raw of [row?.known_name, row?.display_name]) {
    const key = nameKey(raw);
    if (!key) continue;
    out.add(key);
    const first = key.split(" ")[0];
    if (first && first.length >= MIN_QUERY_CHARS) out.add(first);
  }
  return [...out];
}

const compact = (value) => String(value || "").replace(/ /gu, "");

// 1 = ตรงเป๊ะ · 2 = ขึ้นต้นด้วย · 3 = มีอยู่ในชื่อ · 0 = ไม่เกี่ยว
// เทียบทั้งรูปมีช่องว่างและรูปไม่มีช่องว่าง ("สมชาย ใจดี" = "สมชายใจดี")
export function matchTier(query, variants) {
  const q = String(query || "");
  const qc = compact(q);
  if (!qc) return 0;
  let best = 0;
  for (const variant of variants) {
    const vc = compact(variant);
    let tier = 0;
    if (variant === q || vc === qc) tier = 1;
    else if (variant.startsWith(q) || vc.startsWith(qc)) tier = 2;
    else if (variant.includes(q) || vc.includes(qc)) tier = 3;
    if (tier && (!best || tier < best)) best = tier;
  }
  return best;
}

function bigrams(value) {
  const chars = [...compact(value)];
  const grams = new Map();
  for (let i = 0; i < chars.length - 1; i += 1) {
    const gram = chars[i] + chars[i + 1];
    grams.set(gram, (grams.get(gram) || 0) + 1);
  }
  return grams;
}

// ความคล้ายแบบ Dice บน bigram — พอสำหรับพิมพ์ผิดหนึ่งสองตัว ไม่ต้องพึ่งไลบรารี
export function similarity(a, b) {
  const x = bigrams(a);
  const y = bigrams(b);
  const total = [...x.values()].reduce((s, n) => s + n, 0) + [...y.values()].reduce((s, n) => s + n, 0);
  if (!total) return 0;
  let shared = 0;
  for (const [gram, n] of x) shared += Math.min(n, y.get(gram) || 0);
  return (2 * shared) / total;
}

function describe(db, row, tier = 0) {
  let activity = { lastInboundAt: null, lastMessageAt: null, lastMessage: "", lastDirection: "" };
  try { activity = db.yoloRoomActivity(row.line_user_id); } catch { /* อ่านไม่ได้ = จัดอันดับท้ายสุด */ }
  return {
    id: row.line_user_id,
    displayName: String(row.display_name || ""),
    knownName: String(row.known_name || ""),
    label: String(row.known_name || row.display_name || "").trim() || "ลูกค้า",
    channelId: String(row.channel_id || "default"),
    tier,
    ...activity,
  };
}

// เรียงห้องที่ "เพิ่งคุย" ขึ้นก่อน — ในชั้นความตรงเดียวกัน
const byRecency = (a, b) => (a.tier - b.tier) || (Number(b.lastMessageAt || 0) - Number(a.lastMessageAt || 0));

function listRooms(db, channel) {
  try { return db.listYoloRooms({ channel }); } catch { return []; }
}

function suggestionsFor(db, rooms, query) {
  const scored = [];
  for (const row of rooms) {
    const score = Math.max(0, ...nameVariants(row).map((variant) => similarity(query, variant)));
    if (score >= 0.34) scored.push({ row, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 3).map(({ row }) => describe(db, row));
}

// หาจาก "ชื่อล้วน" (สถานะ / เปิด-ปิด AI / ชื่อที่ถูกครอบวงเล็บ / ผลจาก mini AI)
export function resolveCustomer(db, { query = "", channel = "" } = {}) {
  const key = nameKey(query);
  if (compact(key).length < MIN_QUERY_CHARS) return { status: "invalid", query: String(query || ""), matches: [], suggestions: [] };
  const rooms = listRooms(db, channel);
  const hits = [];
  for (const row of rooms) {
    const tier = matchTier(key, nameVariants(row));
    if (tier) hits.push({ row, tier });
  }
  const exact = hits.filter((hit) => hit.tier === 1);
  const loose = hits.filter((hit) => hit.tier > 1);
  if (exact.length === 1) {
    return {
      status: "unique", query: key, matches: [describe(db, exact[0].row, 1)], loose: false,
      hasSimilar: loose.length > 0,
      similar: loose.map((hit) => describe(db, hit.row, hit.tier)).sort(byRecency).slice(0, MAX_CHOICES - 1),
      suggestions: [],
    };
  }
  const pool = exact.length > 1 ? exact : loose;
  // pool คนเดียวเกิดได้เฉพาะตอนไม่มีชื่อตรงเลย (exact ≥ 2 ไปทาง ambiguous) = เดาจากชื่อบางส่วน
  if (pool.length === 1) {
    return { status: "unique", query: key, matches: [describe(db, pool[0].row, pool[0].tier)], loose: true, hasSimilar: false, similar: [], suggestions: [] };
  }
  if (pool.length > 1) {
    const matches = pool.map((hit) => describe(db, hit.row, hit.tier)).sort(byRecency);
    return { status: "ambiguous", query: key, matches: matches.slice(0, MAX_CHOICES), total: matches.length, suggestions: [] };
  }
  return { status: "none", query: key, matches: [], suggestions: suggestionsFor(db, rooms, key) };
}

const HONORIFIC_RAW = /^\s*(?:(?:คุณ|คุน)(?![\u0E30-\u0E3A\u0E45\u0E47-\u0E4E])|khun\s+|k\.\s*|k\s+)\s*/iu;
// ตัวคั่นชัด: วงเล็บ/อัญประกาศ = ชื่ออยู่ข้างในแน่นอน (ตัวอย่างของพี่ง้วงเองคือ "yolo (FB) (ชื่อลูกค้า) ...")
const STRONG_DELIMITED = [
  /^\(\s*([^()]{1,80}?)\s*\)\s*(.*)$/su,
  /^\[\s*([^[\]]{1,80}?)\s*\]\s*(.*)$/su,
  /^["“”]\s*([^"“”]{1,80}?)\s*["“”]\s*(.*)$/su,
  /^'\s*([^']{1,80}?)\s*'\s*(.*)$/su,
];
// โคลอนเป็นตัวคั่นที่อ่อนกว่า: ห้ามมีตัวเลขฝั่งชื่อ และห้ามตามด้วยตัวเลข (กัน "นัด 10:00" ถูกตัดเป็นชื่อ)
const COLON_DELIMITED = /^([^:：\n\d]{1,40}?)\s*[:：]\s*(?!\d)(.*)$/su;
// ICU แบ่งคำไทยได้จริง ("คุณเอถามต่อ" → คุณ|เอ|ถาม|ต่อ, "เอกสารส่ง" → เอกสาร|ส่ง) — ใช้หาขอบชื่อ
// ที่พิมพ์ติดกับคำสั่ง โดยไม่ตัดกลางคำ (ตัดแบบนับตัวอักษรจะอ่าน "เอกสาร" เป็นลูกค้าชื่อ "เอ")
const WORD_SEGMENTER = typeof Intl?.Segmenter === "function" ? new Intl.Segmenter("th", { granularity: "word" }) : null;

// ตำแหน่งจบของแต่ละ "คำ" (ไม่นับช่องว่าง) — สำรองแบบแยกด้วยช่องว่างถ้าไม่มี Segmenter
function tokenEnds(text) {
  const ends = [];
  if (WORD_SEGMENTER) {
    for (const part of WORD_SEGMENTER.segment(text)) {
      if (part.segment.trim()) ends.push(part.index + part.segment.length);
    }
    return ends;
  }
  const pattern = /\S+/gu;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) ends.push(match.index + match[0].length);
  return ends;
}

// "ชื่อ + สิ่งที่ให้ทำ" ติดกัน (yolo LINE คุณเอ ถามต่อเรื่อง...) — หาขอบชื่อจากฐานเอง
// 1) มีวงเล็บ/อัญประกาศ → ใช้ตามนั้น · โคลอน → ใช้ถ้าหาเจอ ไม่เจอค่อยลองวิธีถัดไป
// 2) ไล่จาก "คำมากสุด" ลงมา (สูงสุด 5 คำ): ชุดแรกที่ตรงชื่อเป๊ะของห้องไหนสักห้อง = ชื่อ
//    ใช้ขอบคำจาก ICU จึงครอบทั้งแบบเว้นวรรคและแบบพิมพ์ติดกัน
// 3) ไม่เข้าเลย → คำแรก (ก่อนช่องว่าง) คือชื่อ ให้ resolveCustomer หาแบบขึ้นต้น/มีอยู่ในชื่อ
export function resolveLeadingName(db, { text = "", channel = "" } = {}) {
  const raw = String(text || "").normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!raw) return { status: "invalid", query: "", instruction: "", matches: [], suggestions: [] };
  for (const pattern of STRONG_DELIMITED) {
    const matched = pattern.exec(raw);
    if (matched) return { ...resolveCustomer(db, { query: matched[1], channel }), instruction: String(matched[2] || "").trim() };
  }
  const colon = COLON_DELIMITED.exec(raw);
  if (colon) {
    const resolution = resolveCustomer(db, { query: colon[1], channel });
    if (resolution.status === "unique" || resolution.status === "ambiguous") {
      return { ...resolution, instruction: String(colon[2] || "").trim() };
    }
  }
  const body = raw.replace(HONORIFIC_RAW, "");
  const ends = tokenEnds(body).slice(0, MAX_LEADING_TOKENS);
  const rooms = listRooms(db, channel);
  const variantsByRoom = rooms.map((row) => nameVariants(row));
  const split = { body, ends, prefixKey: (k) => nameKey(body.slice(0, ends[k - 1])) };
  for (let k = ends.length; k >= 1; k -= 1) {
    const key = split.prefixKey(k);
    if (compact(key).length < MIN_QUERY_CHARS) continue;
    if (!variantsByRoom.some((variants) => matchTier(key, variants) === 1)) continue;
    const resolution = { ...resolveCustomer(db, { query: key, channel }), instruction: body.slice(ends[k - 1]).trim() };
    return withSplitRivals(db, resolution, rooms, { ...split, k });
  }
  const space = body.indexOf(" ");
  const first = space < 0 ? body : body.slice(0, space);
  return { ...resolveCustomer(db, { query: first, channel }), instruction: space < 0 ? "" : body.slice(space + 1).trim() };
}

// "คุยกับลูกแพร" (28 ก.ย. 2026): พี่ง้วงเอ่ยชื่อลูกค้ากลางประโยค ("คุณสมชายเป็นไงบ้าง") — ต่างจาก
// resolveLeadingName ตรงที่รับเฉพาะชุดคำที่ "ตรงชื่อเป๊ะ" เท่านั้น ไม่มีขั้นเดาจากคำแรก/ชื่อบางส่วน
// เพราะผลลัพธ์ไปอยู่ในบริบทของโมเดล: แนบห้องผิดคน = ลูกแพรเล่าเรื่องลูกค้าผิดคนอย่างมั่นใจ
// คืน unique (ตรงเป๊ะห้องเดียว) · ambiguous (ตรงเป๊ะหลายห้อง) · null (ไม่แน่ใจ = ไม่แนบอะไร)
export function resolveExactLeadingName(db, { text = "", rooms = null } = {}) {
  const raw = String(text || "").normalize("NFC").replace(/\s+/gu, " ").trim();
  if (!raw) return null;
  const exactOnly = (resolution) => {
    if (resolution.status === "unique" && resolution.loose !== true) return resolution;
    if (resolution.status === "ambiguous" && resolution.matches.every((match) => match.tier === 1)) return resolution;
    return null;
  };
  for (const pattern of STRONG_DELIMITED) {
    const matched = pattern.exec(raw);
    if (matched) return exactOnly(resolveCustomer(db, { query: matched[1] }));
  }
  const body = raw.replace(HONORIFIC_RAW, "");
  const ends = tokenEnds(body).slice(0, MAX_LEADING_TOKENS);
  const variantsByRoom = (Array.isArray(rooms) ? rooms : listRooms(db, "")).map((row) => nameVariants(row));
  for (let k = ends.length; k >= 1; k -= 1) {
    const key = nameKey(body.slice(0, ends[k - 1]));
    if (compact(key).length < MIN_QUERY_CHARS) continue;
    if (!variantsByRoom.some((variants) => matchTier(key, variants) === 1)) continue;
    return exactOnly(resolveCustomer(db, { query: key }));
  }
  return null;
}

const fullNameKeys = (row) => [row?.known_name, row?.display_name].map((raw) => compact(nameKey(raw))).filter(Boolean);

// ชื่อยาวสุดที่ตรงเป๊ะอาจ "กลืน" คำแรกของคำสั่ง: ลูกค้า A ชื่อ "สมชาย" กับ B ชื่อ "สมชาย ใจดี"
// แล้วพี่ง้วงพิมพ์ "สมชาย ใจดีมาก ขอบคุณที่ทัก" หมายถึง A (code review 2026-09-28) — ถ้าชุดคำที่สั้นกว่า
// ตรง "ชื่อเต็ม" ของห้องอื่น ให้เป็น ambiguous ทุกครั้ง และแต่ละตัวเลือกพกคำสั่งตามขอบชื่อของตัวเอง
// ตรงแค่ "คำแรก" ของห้องอื่นไม่นับ ("สมชาย ใจดี ..." ไม่ต้องถามถึง "สมชาย รักดี" ทุกครั้ง)
function withSplitRivals(db, resolution, rooms, { body, ends, k, prefixKey }) {
  if (resolution.status !== "unique" && resolution.status !== "ambiguous") return resolution;
  const taken = new Set(resolution.matches.map((match) => match.id));
  const rivals = [];
  for (let shorter = k - 1; shorter >= 1; shorter -= 1) {
    const key = compact(prefixKey(shorter));
    if (key.length < MIN_QUERY_CHARS) continue;
    for (const row of rooms) {
      if (taken.has(row.line_user_id) || !fullNameKeys(row).includes(key)) continue;
      taken.add(row.line_user_id);
      rivals.push({ ...describe(db, row, 1), instruction: body.slice(ends[shorter - 1]).trim() });
    }
  }
  if (!rivals.length) return resolution;
  const own = resolution.matches.map((match) => ({ ...match, instruction: resolution.instruction }));
  return {
    status: "ambiguous", split: true, query: resolution.query, instruction: resolution.instruction,
    matches: [...own, ...rivals].slice(0, MAX_CHOICES),
    total: Number(resolution.total || own.length) + rivals.length, suggestions: [],
  };
}
