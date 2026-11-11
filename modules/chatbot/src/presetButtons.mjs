// presetButtons.mjs — "ข้อความจากปุ่มสำเร็จรูป" ต้องถูกอ่านเป็นการกดปุ่ม ไม่ใช่การพิมพ์
//
// เคสจริง (Facebook, 2026-09-04 12:14 UTC): ลูกค้าเคยตอบ "ยังไม่เคยครับ" / "งานประจำ" ไว้
// ผ่านไปหลายชั่วโมง มีข้อความขาเข้าสามแถวภายในสองวินาที เนื้อความเหมือนกันทุกตัวอักษร
// "คิดค่าบริการเท่าไหร่" — คือลูกค้ากดปุ่มคำถามสำเร็จรูปของ Facebook สามครั้งติด
// คำตัดสินจังหวะราคาถูกต้อง (defer คะแนน 4 ไม่มีหมุด) แต่โมเดลเห็นสามบรรทัดเหมือนกัน
// อ่านเป็น "ลูกค้าทวง" แล้วเขียน "ขออภัยที่ยังไม่ได้ตอบราคาให้ตรง ๆ นะคะ" — ขอโทษกับการ
// เลี่ยงที่ไม่เคยเกิดขึ้น — แล้วเทราคาเต็มพร้อม Early Bird ใส่คนที่เรายังไม่รู้จัก
//
// คำสั่งเจ้าของ: แก้ที่ตรรกะของเรา ไม่ใช่ที่ปุ่มของ Facebook (แก้ฝั่งแอดยาก) และให้ถือ
// ทุกวลีในตระกูลปุ่มสำเร็จรูปเป็น "ปุ่ม" ทั้งหมด — LINE rich menu / quick reply ก็ส่งข้อความ
// ตายตัวแบบเดียวกัน กลไกนี้จึงต้องไม่ผูกกับช่องทางใดช่องทางหนึ่ง
//
// หลักสองข้อของไฟล์นี้:
//   1. ปุ่มส่งข้อความ "ตรงตามที่ตั้งค่าไว้เป๊ะ" ไม่มีคำลงท้าย — คนที่พิมพ์เอง
//      "คิดค่าบริการเท่าไหร่ครับ" คือคำถามจริง การจับคู่แบบเป๊ะหลัง normalize จึงเป็น
//      ความแม่นยำที่ถูกต้อง ห้ามตัด ค่ะ/ครับ/คะ/นะ ทิ้งเด็ดขาด (คำลงท้าย = มีคนพิมพ์)
//   2. แถว messages ที่เก็บไว้เป็นความจริงของ audit — ไฟล์นี้สร้าง "มุมมอง" ใหม่เท่านั้น
//      ไม่แตะแถวเดิม ไม่แตะอาร์เรย์ที่รับเข้ามา (pure function ทุกตัว)
//
// สิ่งที่พรอมต์ Facebook (brain_addendum:facebook หัวข้อ 【ข้อความจากปุ่มอัตโนมัติ】) เคยบอก
// โมเดลไว้เป็นร้อยแก้ว ตอนนี้กลายเป็นกลไกที่ตัดสินได้แน่นอน ใช้ได้ทุกช่องทาง และรู้เรื่อง
// "การกดซ้ำ" ซึ่งร้อยแก้วนั้นไม่เคยพูดถึง

// วลีปุ่มสำเร็จรูปตั้งต้น — ทุกวลีมีที่มาที่ยืนยันได้ ไม่มีวลีที่เดาเอา:
//   · "จองคิวได้ไหม" / "คุณให้บริการอะไรบ้าง" / "คิดค่าบริการเท่าไหร่" คือสามปุ่มที่โผล่จริง
//     ในเคส 2026-09-03 (สี่แถวในสามวินาที: จองคิวได้ไหม / คุณให้บริการอะไรบ้าง /
//     คิดค่าบริการเท่าไหร่ / คุณให้บริการอะไรบ้าง)
//   · "คิดค่าบริการเท่าไหร่" คือเคสจริง 2026-09-04 ข้างบน
//   · "ราคาเทอมละเท่าไหร่" คือวลีที่ addendum ของ Facebook ระบุชื่อไว้แล้ว
//   · "เทอมละเท่าไหร่" / "คุณมีบริการอะไรบ้าง" คือวลีในรายการที่เจ้าของไล่ให้ (2026-09-04)
export const PRESET_BUTTON_DEFAULTS = Object.freeze([
  "คุณให้บริการอะไรบ้าง",
  "คุณมีบริการอะไรบ้าง",
  "คิดค่าบริการเท่าไหร่",
  "จองคิวได้ไหม",
  "เทอมละเท่าไหร่",
  "ราคาเทอมละเท่าไหร่",
]);

// แถว settings ที่เจ้าของแก้ได้จากคอนโซล (JSON array ของสตริง) — ตั้งชื่อตามแบบ
// hashtag_business_keywords · ไม่มีแถว / แถวว่าง / แปลงไม่ได้ = ใช้ค่าตั้งต้นข้างบน
export const PRESET_BUTTON_PHRASES_KEY = "preset_button_phrases";
export const PRESET_BUTTON_PHRASE_MAX = 120;
export const PRESET_BUTTON_LIST_MAX = 200;

// หน้าต่างที่ถือว่าเป็น "การกดชุดเดียวกัน" — กว้างกว่า maxWait ของ burst buffer (12 วิ)
// เล็กน้อย เพื่อให้ก้อนที่ buffer เคยรวมมาแล้วจริง ถูกอ่านเป็นก้อนเดียวกันในประวัติด้วย
export const PRESET_BURST_WINDOW_MS = 15_000;

// ท้ายข้อความที่ปุ่มไม่มีวันส่งมาแต่คนอาจเผลอใส่: เครื่องหมายวรรคตอน สัญลักษณ์ อีโมจิ
// (รวม variation selector / ZWJ ที่ตามอีโมจิมา) และช่องว่าง — ตัดเฉพาะ "ท้าย" เท่านั้น
// ตัวอักษรไทยทั้งหมดอยู่นอกชุดนี้ (ค่ะ/ครับ/คะ/นะ/ๆ/ฯ ไม่ถูกแตะ)
const TRAILING_NOISE = /[\p{P}\p{S}\p{Extended_Pictographic}\uFE0F\u200D\s]+$/u;

/**
 * รูปมาตรฐานของข้อความไว้เทียบกับรายการปุ่ม: NFC · ตัดหัวท้าย · ยุบช่องว่างภายใน ·
 * ตัดเครื่องหมาย/อีโมจิท้ายข้อความ — **ไม่** ตัดคำลงท้ายภาษาไทย
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeButtonText(text) {
  return String(text ?? "")
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(TRAILING_NOISE, "");
}

/**
 * ทำรายการวลีให้สะอาด: สตริงเท่านั้น · normalize · ตัดว่าง/ยาวเกิน · ไม่ซ้ำ · มีเพดาน
 * รับอะไรก็ได้ ไม่โยน — ของที่ไม่ใช่อาร์เรย์คืนรายการว่าง (ผู้เรียกตัดสินเองว่าจะใช้ค่าตั้งต้นไหม)
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizePresetButtonPhrases(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const phrase = normalizeButtonText(item);
    if (!phrase || phrase.length > PRESET_BUTTON_PHRASE_MAX) continue;
    if (out.includes(phrase)) continue;
    out.push(phrase);
    if (out.length >= PRESET_BUTTON_LIST_MAX) break;
  }
  return out;
}

/**
 * รายการปุ่มที่ใช้อยู่จริง — แถว settings ชนะ ค่าตั้งต้นเป็นทางถอย · ห้ามโยนทุกกรณี
 * (อ่านฐานพัง / JSON เพี้ยน / ไม่ใช่อาร์เรย์ = ค่าตั้งต้น ไม่ใช่ปิดกลไกทั้งชุดเงียบ ๆ)
 * อาร์เรย์ว่างที่ตั้งใจเก็บ (`[]`) = เจ้าของปิดการจับปุ่มเอง ซึ่งต่างจาก "ไม่มีแถว"
 * @param {{db?: {getSetting?: (key: string) => unknown}}} args
 * @returns {string[]}
 */
export function presetButtonPhrases({ db = null } = {}) {
  try {
    const stored = db?.getSetting?.(PRESET_BUTTON_PHRASES_KEY);
    if (!stored) return [...PRESET_BUTTON_DEFAULTS];
    const parsed = JSON.parse(String(stored));
    if (!Array.isArray(parsed)) return [...PRESET_BUTTON_DEFAULTS];
    return normalizePresetButtonPhrases(parsed);
  } catch {
    return [...PRESET_BUTTON_DEFAULTS];
  }
}

/** แถว settings มีอยู่จริงไหม (คอนโซลใช้บอกว่า "ใช้ค่ามาตรฐานอยู่" หรือ "เจ้าของตั้งเอง") */
export function presetButtonPhrasesConfigured({ db = null } = {}) {
  try {
    const stored = db?.getSetting?.(PRESET_BUTTON_PHRASES_KEY);
    if (!stored) return false;
    return Array.isArray(JSON.parse(String(stored)));
  } catch {
    return false;
  }
}

function buttonSetOf(list) {
  const phrases = Array.isArray(list) ? list : PRESET_BUTTON_DEFAULTS;
  const set = new Set();
  for (const item of phrases) {
    const phrase = normalizeButtonText(item);
    if (phrase) set.add(phrase);
  }
  return set;
}

/**
 * ข้อความนี้คือ "การกดปุ่ม" หรือเปล่า — จับคู่แบบเป๊ะหลัง normalize ทั้งสองฝั่ง
 * @param {unknown} text
 * @param {string[]} [list]
 */
export function isPresetButtonTap(text, list = PRESET_BUTTON_DEFAULTS) {
  const key = normalizeButtonText(text);
  return Boolean(key) && buttonSetOf(list).has(key);
}

function timestampOf(row) {
  const value = Number(row?.created_at);
  return Number.isFinite(value) ? value : null;
}

// แถวนี้ต่อจากกลุ่มเดิมได้ไหม: (ก) ยังอยู่ในหน้าต่างเวลา — เทียบกับแถวแรกของกลุ่ม ไม่ใช่
// แถวก่อนหน้า ไม่งั้นการกดห่างกัน 14 วิ ไปเรื่อย ๆ จะกลายเป็น burst ไม่รู้จบ · แถวที่ไม่มี
// เวลา (มุมมองประวัติจาก db.recentTurns มีแค่ role/content) ให้ความติดกันตัดสินแทน
// (ข) ปุ่มต่อปุ่ม (จะเป็นปุ่มเดียวกันหรือไม่ก็ได้) หรือข้อความพิมพ์เองที่เหมือนกันเป๊ะ
function joinsGroup(group, { key, isButton, at }, windowMs) {
  if (group.at !== null && at !== null && at - group.at > windowMs) return false;
  if (group.isButton) return isButton;
  return !isButton && Boolean(key) && key === group.key;
}

function renderGroup(group) {
  const [first] = group.rows;
  if (group.isButton) {
    return {
      ...first,
      content: group.keys.join("\n"),
      fromPresetButton: true,
      tapCount: group.rows.length,
      distinctButtons: [...group.keys],
    };
  }
  if (group.rows.length === 1) return first;
  return { ...first, fromPresetButton: false, tapCount: group.rows.length, distinctButtons: [] };
}

/**
 * มุมมองของข้อความขาเข้าที่ "ยุบการกดปุ่ม" แล้ว — ใช้กับทั้งก้อนปัจจุบันและประวัติ
 *
 *   (ก) ข้อความขาเข้าที่ติดกันและเหมือนกันเป๊ะภายในหน้าต่าง -> เหลือหนึ่ง
 *   (ข) ข้อความจากปุ่มที่ติดกันภายในหน้าต่าง (เหมือนหรือต่างปุ่มก็ตาม) -> เหลือหนึ่งเทิร์น
 *       ที่ไล่ชื่อปุ่มที่ต่างกันทีละบรรทัดตามลำดับ โมเดลจึงยังเห็นทุกเจตนาที่ลูกค้ากด
 *       พร้อมป้าย { fromPresetButton: true, tapCount, distinctButtons }
 *
 * แถวที่มี role และไม่ใช่ "user" ผ่านไปตามเดิมและตัดกลุ่ม (คำตอบของเราคือขอบเขตของ burst)
 * แถวที่ไม่ถูกยุบถูกส่งกลับเป็นอ็อบเจกต์เดิม · อินพุตไม่ถูกแก้ · ไม่โยนกับอินพุตเพี้ยน
 *
 * @param {Array<{role?: string, content?: unknown, created_at?: number}>} messages
 * @param {{windowMs?: number, list?: string[]}} [options]
 */
export function collapsePresetBurst(messages, { windowMs = PRESET_BURST_WINDOW_MS, list = PRESET_BUTTON_DEFAULTS } = {}) {
  const rows = Array.isArray(messages) ? messages : [];
  const buttons = buttonSetOf(list);
  const window = Number.isFinite(Number(windowMs)) ? Number(windowMs) : PRESET_BURST_WINDOW_MS;
  const out = [];
  let group = null;
  const flush = () => {
    if (group) out.push(renderGroup(group));
    group = null;
  };
  for (const row of rows) {
    if (!row || typeof row !== "object" || (row.role && row.role !== "user")) {
      flush();
      out.push(row);
      continue;
    }
    const key = normalizeButtonText(row.content);
    const isButton = Boolean(key) && buttons.has(key);
    const at = timestampOf(row);
    if (group && joinsGroup(group, { key, isButton, at }, window)) {
      group.rows.push(row);
      if (isButton && !group.keys.includes(key)) group.keys.push(key);
      continue;
    }
    flush();
    group = { rows: [row], isButton, key, keys: isButton ? [key] : [], at };
  }
  flush();
  return out;
}

/**
 * มุมมองของ "ก้อนปัจจุบัน" (ข้อความหลายบอลลูนที่ burst buffer รวมมา) หลังยุบปุ่ม —
 * ก้อนหนึ่งอยู่ในหน้าต่างเดียวกันเสมอโดยโครงสร้าง (buffer รอไม่เกิน 12 วิ) จึงไม่ต้องมีเวลา
 *
 * @param {{text?: unknown, parts?: unknown[], list?: string[]}} args
 * @returns {{text: string, parts: string[], view: Array<object>}}
 */
export function collapseInboundBurst({ text = "", parts = [], list = PRESET_BUTTON_DEFAULTS } = {}) {
  const raw = (Array.isArray(parts) ? parts : []).map((part) => String(part ?? ""));
  const rows = (raw.length ? raw : [String(text ?? "")]).map((content) => ({ content }));
  const view = collapsePresetBurst(rows, { list });
  const collapsed = view.map((row) => String(row?.content ?? ""));
  return { text: collapsed.join("\n"), parts: collapsed, view };
}

/**
 * ข้อเท็จจริงของเทิร์นนี้ที่ตัวประกอบพรอมต์และคำตัดสินจังหวะราคาต้องรู้:
 *   fromPresetButton  มีส่วนที่มาจากปุ่มอย่างน้อยหนึ่งส่วน
 *   tapCount          จำนวนครั้งที่กดปุ่มรวมกันในก้อนนี้
 *   distinctButtons   ปุ่มที่ต่างกัน เรียงตามลำดับที่กด
 *   typedAlongside    ในก้อนเดียวกันมีข้อความที่ลูกค้าพิมพ์เองปนอยู่ด้วย
 *   buttonsOnlySoFar  ทุกอย่างที่ลูกค้าเคยส่งมาในหน้าต่างประวัติ + เทิร์นนี้ คือปุ่มล้วน —
 *                     "เรายังไม่รู้อะไรเกี่ยวกับเขาเลย" แบบที่หนักแน่นที่สุด
 *
 * @param {Array<object>} view   ผลของ collapseInboundBurst().view
 * @param {Array<{role?: string, fromPresetButton?: boolean}>} [history] มุมมองประวัติที่ยุบแล้ว
 */
export function presetButtonFact(view, history = []) {
  const rows = Array.isArray(view) ? view : [];
  const buttonRows = rows.filter((row) => row?.fromPresetButton === true);
  const distinctButtons = [];
  let tapCount = 0;
  for (const row of buttonRows) {
    tapCount += Math.max(1, Number(row.tapCount) || 1);
    for (const button of Array.isArray(row.distinctButtons) ? row.distinctButtons : []) {
      if (!distinctButtons.includes(button)) distinctButtons.push(button);
    }
  }
  const fromPresetButton = buttonRows.length > 0;
  const typedAlongside = fromPresetButton && rows.some((row) => row && row.fromPresetButton !== true);
  const turns = Array.isArray(history) ? history : [];
  const historyButtonsOnly = turns.every((turn) => !turn || turn.role !== "user" || turn.fromPresetButton === true);
  return Object.freeze({
    fromPresetButton,
    tapCount,
    distinctButtons: Object.freeze(distinctButtons),
    typedAlongside,
    buttonsOnlySoFar: fromPresetButton && !typedAlongside && historyButtonsOnly,
  });
}
