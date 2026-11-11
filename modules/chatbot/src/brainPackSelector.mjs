// brainPackSelector.mjs — selects a small fact context from the pinned
// LuKprae JSON pack. Ordinary brand packs remain byte-compatible.
// Answer examples are treated as facts, not customer-ready scripts.

import { truncateCodePoints, wellFormedText } from "./unicodeText.mjs";

const START = "LUKPRAE_BRAIN_PACK_JSON_V1";
const END = "END_LUKPRAE_BRAIN_PACK_JSON_V1";
const STOP_WORDS = new Set([
  "ครับ", "ค่ะ", "คะ", "นะคะ", "อยาก", "ขอ", "ช่วย", "เรื่อง", "ข้อมูล",
  "แบบ", "ยังไง", "อย่างไร", "ให้", "หน่อย", "บ้าง", "แต่ละ", "อัน",
  "มี", "ไหม", "มั้ย", "เหรอ", "หรอ", "หรือ", "ได้", "เลย", "ด้วย",
  "คน", "เยอะ", "มาก", "น้อย", "ai",
  "รายละเอียด", "สอน", "เรียน", "คลาส", "คอร์ส", "รูป", "รีวิว", "ที่ไหน",
]);
const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/gu;
const GENERIC_FOLLOWUP = /(?:รายละเอียด|สอน|เรียน|คลาส|คอร์ส|รูป|รีวิว|ที่ไหน|เมื่อไหร่|กี่คน|ต่อยังไง|อันนี้|อันไหน)/iu;
// v1.2.1 (เคสลูกแพร): pipeline ใช้ regex เดียวกันตัดสิน "ลูกค้าขอรูปเอง" — export แหล่งเดียว
// รวมสำนวนขอดูซ้ำ ("ขอดูอีกที/อีกครั้ง/อีกรอบ") — หลังส่งรูปไปแล้ว ลูกค้ามักไม่พิมพ์คำว่า "รูป" ซ้ำ
export const IMAGE_REQUEST = /(?:รูป(?!แบบ)|ภาพ|บรรยากาศ|โปสเตอร์|การ์ด|photo|image|ขอดูอีก|ดูอีก(?:ที|ครั้ง|รอบ))/iu;
const COURSE_TOPIC = /(?:คลาส|คอร์ส|เรียน|สอน)/iu;
const segmenter = typeof Intl?.Segmenter === "function"
  ? new Intl.Segmenter("th", { granularity: "word" })
  : null;

function normalize(value) {
  return wellFormedText(value)
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .toLocaleLowerCase("th-TH")
    .trim();
}

function tokens(value) {
  const normalized = normalize(value);
  const parts = segmenter
    ? [...segmenter.segment(normalized)].filter((part) => part.isWordLike).map((part) => part.segment)
    // Keep Unicode marks attached to their base token in the fallback.  A
    // mark-only split produced broken Thai fragments and false retrieval hits.
    : normalized.match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  return [...new Set(parts
    .map((item) => item.trim())
    .filter((item) => [...item].length >= 2 && !/^\p{M}/u.test(item) && !STOP_WORDS.has(item)))];
}

function cleanAnswer(value) {
  const raw = String(value || "");
  // `[ต่อ]` separates the approved factual answer from a canned next-turn
  // script. The latter must never be promoted into the live reply prompt.
  const factual = raw.split("[ต่อ]", 1)[0].replace(/\s{2,}/gu, " ").trim();
  return factual || raw.replace(/\s*\[ต่อ\]\s*/gu, " ").trim();
}

function parsePack(value) {
  const raw = String(value || "");
  const start = raw.indexOf(START);
  const end = raw.indexOf(END);
  if (start < 0 || end <= start) return null;
  const jsonText = raw.slice(start + START.length, end).trim();
  try {
    const parsed = JSON.parse(jsonText);
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [], suffix: raw.slice(end + END.length).trim() };
  } catch {
    return null;
  }
}

function entryScore(entry, queryTokens, query) {
  const fields = [
    { value: entry.titleTh, weight: 5 },
    ...(entry.tags || []).map((value) => ({ value, weight: 4 })),
    ...(entry.questionPatterns || []).map((value) => ({ value, weight: 3 })),
  ].filter((field) => String(field.value || "").trim());
  const fieldTokens = fields.map((field) => ({
    ...field,
    normalized: normalize(field.value),
    tokens: new Set(tokens(field.value)),
  }));
  let score = 0;
  for (const token of queryTokens) {
    for (const field of fieldTokens) {
      if (field.tokens.has(token)) score += field.weight;
    }
  }
  for (const field of fieldTokens) {
    if (field.normalized.length < 3) continue;
    if (query.includes(field.normalized)) score += field.weight * 3;
    else if (query.length >= 4 && field.normalized.includes(query)) score += field.weight * 2;
  }
  return score;
}

function boundedContext(recentContext, { maxItems = 4, maxItemChars = 300, maxChars = 900 } = {}) {
  const source = Array.isArray(recentContext)
    ? recentContext.filter((item) => typeof item === "string" || item?.role === "user").slice(-maxItems)
    : [];
  let used = 0;
  const picked = [];
  for (const item of source) {
    const raw = typeof item === "string" ? item : item?.content;
    const value = truncateCodePoints(normalize(raw), maxItemChars);
    if (!value || used >= maxChars) continue;
    const remaining = maxChars - used;
    picked.push(truncateCodePoints(value, remaining));
    used += Math.min([...value].length, remaining);
  }
  return picked.join("\n");
}

function approvedKeysFor(entry, approvedImageKeys) {
  if (!(approvedImageKeys instanceof Set) && !Array.isArray(approvedImageKeys)) return [];
  const allowed = approvedImageKeys instanceof Set ? approvedImageKeys : new Set(approvedImageKeys);
  return [...new Set(Array.isArray(entry.approvedImageKeys) ? entry.approvedImageKeys : [])]
    .map((key) => String(key || "").trim())
    .filter((key) => key && allowed.has(key));
}

export function selectRelevantBrandPack(brandPack, userText, {
  maxEntries = 2,
  maxChars = 4000,
  recentContext = [],
  approvedImageKeys = null,
  // F2 (handoff 2026-08-12): คำรับสั้น ("ครับ") ไม่มี token ให้ดึงการ์ด —
  // continuationResolver ส่ง "ข้อความข้อเสนอเดิม" มาเป็น query สำรอง
  // ใช้เฉพาะเมื่อ query หลักเลือกอะไรไม่ได้เลย (ห้ามแทรกแซงเส้นทางปกติ)
  fallbackQuery = "",
  // v1.3.4: เดิมโมเดลเห็น [IMAGE:key] เฉพาะตอนลูกค้าพิมพ์คำว่า "รูป" เท่านั้น จึงส่งรูป
  // ได้ 1 ใบจากบทสนทนา 49 ข้อความ และเฉพาะตอนลูกค้าขอเอง — จังหวะที่ควรมีภาพประกอบ
  // (แนะนำคลาส / อธิบายรายละเอียด / แจ้งราคา) ไม่เคยมีสิทธิ์เลย
  // ตัวตัดสินว่า "เทิร์นนี้ควรเสนอภาพไหม" อยู่ที่ไปป์ไลน์ ที่นี่แค่เปิดให้โมเดลเห็นตัวเลือก
  offerImages = false,
} = {}) {
  const parsed = parsePack(brandPack);
  if (!parsed) return wellFormedText(brandPack);
  const query = normalize(userText);
  const queryTokens = tokens(query);
  const context = GENERIC_FOLLOWUP.test(query) ? boundedContext(recentContext) : "";
  const contextTokens = tokens(context);
  const contextHasCourseTopic = COURSE_TOPIC.test(context);
  const scored = parsed.entries.map((entry) => ({
    entry,
    currentScore: entryScore(entry, queryTokens, query),
    contextScore: context ? entryScore(entry, contextTokens, context) + (
      contextHasCourseTopic && (entry.kind === "course" || entry.kind === "course_router") ? 20 : 0
    ) : 0,
  }));
  const hasCurrentMatch = scored.some((item) => item.currentScore > 0);
  const topContextScore = Math.max(0, ...scored.map((item) => item.contextScore));
  let picked = scored
    // Context may recover a terse generic follow-up only when the current
    // query has no direct match.  Otherwise it can break ties but can never
    // pull an unrelated prior topic into the selected set.  A context-only
    // match must also be reasonably close to the best match so a generic token
    // such as "AI" does not fill the second slot with another course.
    .filter((item) => item.currentScore > 0 || (
      !hasCurrentMatch
      && item.contextScore > 0
      && item.contextScore >= topContextScore * 0.5
    ))
    .map((item) => ({ ...item, score: item.currentScore * 4 + item.contextScore }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, maxEntries));

  const wantsImage = IMAGE_REQUEST.test(query);
  const mayShowImages = wantsImage || offerImages === true;

  // F1 (handoff 2026-08-12): คำขอรูปที่ไม่เอ่ยชื่อคอร์ส ("มีรูปคลาสมั้ย") — คำสำคัญ
  // ล้วนเป็น stopword จึงเลือกการ์ดไม่ได้ แล้ว Sol ตกไปตอบ "ต้องให้ทีมยืนยัน" ทั้งที่รูป
  // อนุมัติมีอยู่ — ทุกสำนวนขอรูปต้องจบที่ "การ์ดที่มีรูปอนุมัติ" ชุดเดียวกันเสมอ:
  // เลือกจากการ์ดที่มีรูปใน approved set (held/unknown ถูกกรองอยู่แล้ว = fail-closed เดิม)
  // เรียงด้วยบริบทล่าสุดถ้ามี — ไม่มีบริบทก็เสนอการ์ดรูปตามลำดับ pack ใน budget เดิม
  if (!picked.length && wantsImage) {
    const imageContext = boundedContext(recentContext);
    const imageContextTokens = tokens(imageContext);
    picked = scored
      .filter(({ entry }) => approvedKeysFor(entry, approvedImageKeys).length > 0)
      .map((item) => ({
        ...item,
        score: imageContext ? entryScore(item.entry, imageContextTokens, imageContext) : 0,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(0, maxEntries));
  }

  // F2: query หลักไม่ได้อะไรเลย + มีข้อเสนอค้างจาก resolver -> ดึงด้วยข้อเสนอเดิมรอบเดียว
  if (!picked.length && String(fallbackQuery || "").trim()) {
    return selectRelevantBrandPack(brandPack, fallbackQuery, {
      maxEntries, maxChars, recentContext, approvedImageKeys, offerImages, fallbackQuery: "",
    });
  }
  const blocks = picked.map(({ entry }) => {
    const imageKeys = approvedKeysFor(entry, mayShowImages ? approvedImageKeys : null);
    return [
      `[${String(entry.titleTh || entry.id || "ข้อมูล")}]`,
      cleanAnswer(entry.answerTh),
      ...(imageKeys.length
        ? [`รูปที่อนุมัติสำหรับหัวข้อนี้: ${imageKeys.map((key) => `[IMAGE:${key}]`).join(" ")} ${wantsImage
            ? "ลูกค้าขอรูปเอง: ส่งรูปด้วย marker นี้"
            : "ถ้าภาพช่วยให้ลูกค้าเห็นภาพชัดขึ้นในเทิร์นนี้ ให้ใส่ marker ได้เลย ไม่ต้องรอให้ลูกค้าขอ"} แล้วจบข้อความด้วยคำถามเดียวที่เป็นประโยชน์ตามกฎการส่งรูป`]
        : []),
    ].join("\n");
  });
  const safety = parsed.suffix ? `\n\n${parsed.suffix}` : "";
  if (!blocks.length) return safety.trim();
  // TODO (release แยก "ปลด tail truncation + addendum เป็น block ของตัวเอง" — แบบแปลน §11 P2):
  // ตัวตัดท้ายตรงนี้กิน `safety` (channel addendum) ทิ้งเมื่อการ์ดยาวชนเพดาน ซึ่งคือความรู้
  // ที่ทีมงานตั้งใจให้อยู่ทุกเทิร์น การแก้ต้องมาพร้อม parity test บน block อื่น + eval subset
  // + ป้าย "เปลี่ยนพฤติกรรม" — เฟส 2 (ทางอ่านสมอง) จงใจ **ไม่แตะ** เพราะมันเปลี่ยนไบต์จริง
  return truncateCodePoints(`ข้อมูลอ้างอิงที่เกี่ยวข้อง (ใช้เป็นข้อเท็จจริง ห้ามลอกจังหวะหรือคำถามท้ายตัวอย่าง):\n${blocks.join("\n\n")}${safety}`, maxChars);
}
