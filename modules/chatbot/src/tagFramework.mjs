// tagFramework.mjs — กรอบป้ายลูกค้าชุดเดียว (พี่ง้วงอนุมัติ 28 ก.ย. 2026 ~17:40)
//
// ปัญหาที่แก้: scorer เคยถูกสั่งให้ "ติดป้ายอิสระ สูงสุด 5 ป้าย" ผลคือป้าย AI ~1,680 แบบ
// ใน 1,012 ห้อง (28 ก.ย. 2026 · 7 วันล่าสุดมี ~510 แบบ) — ถามราคา / สอบถามราคา / ถามค่าเรียน /
// ถามค่าใช้จ่าย คือเรื่องเดียวกันแต่คนละป้าย จึงเลือกเป็นกลุ่มบรอดแคสต์ไม่ได้เลย
//
// หลักของกรอบ (ค่าจริงอยู่ในไฟล์ของแต่ละธุรกิจ เช่น tag-framework.json ของลูกแพร):
// - ป้ายทุกใบเขียนแบบ "มิติ: ค่า" และค่าในมิติที่ AI ติดได้เป็น "รายการปิด"
//   ของที่ไม่อยู่ในรายการ = ทิ้ง (หรือแปลงเข้ากรอบถ้ากฎแปลงป้ายเก่าจับได้) AI สร้างค่าใหม่ไม่ได้
// - แต่ละมิติมีเจ้าของชัด: ai / human / system — มิติของคน (ของแจก กิจกรรม ติดต่อ รุ่น) AI ห้ามแตะ
//   มิติของระบบ (ซื้อครั้งที่ ซื้อล่าสุด ซื้อแล้ว) ทั้ง AI และคนติดเองไม่ได้ — ระบบคำนวณจากออเดอร์/ประวัติ
// - การจำ: สนใจ/ใช้ทำ/ข้อกังวล สะสม (มีเพดาน) · ขั้น เดินหน้าอย่างเดียวเว้นแต่ลูกค้าบอก
//   ขอคิดก่อน/ไม่สนใจ · ระดับAI/อาชีพ เอาหลักฐานล่าสุด แต่ไม่มีหลักฐานใหม่ = คงค่าเดิม
//   มิติ dynamic (ซื้อครั้งที่/ซื้อล่าสุด) ไม่จำ — ค่าเดียวที่คำนวณใหม่ทุกครั้งตามการซื้อรอบล่าสุด (purchaseHistory.mjs)
// - ค่า archived = เก็บไว้ในไฟล์ แต่ AI/คนเลือกไม่ได้ ป้ายเดิมที่เจอถูกนับเป็นค่า replacedBy แทน
//
// โมดูลนี้บริสุทธิ์ทั้งหมด (ไม่มี I/O นอกจาก loadTagFramework) เพื่อเทสต์ทุกกรณีขอบได้
import { existsSync, readFileSync } from "node:fs";

export const TAG_FRAMEWORK_SEPARATOR = ": ";
const SET_BY = new Set(["ai", "human", "system"]);
// ที่มาของ facts ตาม dbLifecycle.FACT_SOURCES — ค่าตั้งต้นเชื่อเฉพาะที่คนยืนยัน
// (28 ก.ย. 2026: ai_level แบบ deterministic 77 จาก 89 ห้อง LINE ที่อ่านว่า "ระดับ 5"
//  มาจากข้อความ seed ของคีย์เวิร์ด # ไม่ใช่คำตอบของลูกค้า — ห้ามให้ค่าแบบนั้นชนะจนกว่าตัวจับจะแก้)
const FACT_SOURCES = new Set(["human", "deterministic", "scorer"]);
const MERGES = new Set(["accumulate", "funnel", "latest"]);
const ROOT_KEYS = new Set([
  "schemaVersion", "businessId", "frameworkId", "status", "updatedAt", "_readme",
  "dimensions", "systemTags", "buyerMarkers", "purchaseTags", "segments", "legacyRules", "legacyHumanTags",
]);
// ป้ายที่ AI ติดได้ต้องสั้นพอให้ทีมอ่านในแผงลูกค้าและหน้าบรอดแคสต์ได้ในบรรทัดเดียว
const MAX_CLOSED_TAG_CHARS = 40;
// scorer ตอบป้ายมาเกินนี้ = ผิดคำสั่งแน่นอน ตัดทิ้งก่อนตรวจ (กันงานเปล่าจากคำตอบยาวผิดปกติ)
const MAX_RAW_TAGS = 20;
const ID = /^[a-z][a-z0-9_-]{1,63}$/u;
const ZERO_WIDTH = /[\u200b-\u200d\u2060\ufeff]/gu;
const DIM_SPLIT = /^([^:：]{1,24})[:：]\s*(.+)$/u;

function fail(message) {
  throw new Error(`Invalid tag framework: ${message}`);
}

/** ทำความสะอาดข้อความป้าย: NFC, ตัดอักขระล่องหน, ยุบช่องว่าง */
export function cleanTagText(value) {
  return String(value ?? "").normalize("NFC").replace(ZERO_WIDTH, "").replace(/\s+/gu, " ").trim();
}

// กุญแจเทียบ: ไม่สนตัวพิมพ์ละติน และช่องว่างรอบ "/" (ป้ายเดียวกันต้องเจอกันเสมอ)
const compareKey = (value) => cleanTagText(value).toLowerCase().replace(/\s*\/\s*/gu, "/");
const dimensionKey = (value) => compareKey(value).replace(/\s+/gu, "");

export function formatFrameworkTag(dimension, value) {
  return `${dimension}${TAG_FRAMEWORK_SEPARATOR}${value}`;
}

function text(value, label, { max = 200, required = true } = {}) {
  if (typeof value !== "string") {
    if (!required && value == null) return "";
    fail(`${label} must be a string`);
  }
  const clean = cleanTagText(value);
  if (required && !clean) fail(`${label} must not be empty`);
  if (clean.length > max) fail(`${label} exceeds ${max} characters`);
  return clean;
}

function compile(pattern, label) {
  const source = text(pattern, label, { max: 4000 });
  try {
    return new RegExp(source, "iu");
  } catch (error) {
    fail(`${label} is not a valid regular expression (${error.message})`);
  }
  return null;
}

function validateValue(raw, dim, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`${dim.key}.values[${index}] must be an object`);
  const value = text(raw.value, `${dim.key}.values[${index}].value`, { max: 32 });
  if (/[:：]/u.test(value)) fail(`${dim.key}.values[${index}].value must not contain ":"`);
  const tag = formatFrameworkTag(dim.key, value);
  if (tag.length > MAX_CLOSED_TAG_CHARS) fail(`tag "${tag}" exceeds ${MAX_CLOSED_TAG_CHARS} characters`);
  const setBy = raw.setBy == null ? dim.setBy : raw.setBy;
  if (!SET_BY.has(setBy)) fail(`${tag}.setBy must be ai, human or system`);
  const rank = raw.rank == null ? null : Number(raw.rank);
  const parked = raw.parked == null ? null : Number(raw.parked);
  const level = raw.level == null ? null : Number(raw.level);
  for (const [name, number] of [["rank", rank], ["parked", parked], ["level", level]]) {
    if (number !== null && (!Number.isInteger(number) || number < 1 || number > 9)) fail(`${tag}.${name} must be 1-9`);
  }
  if (dim.merge === "funnel" && (rank === null) === (parked === null)) fail(`${tag} needs exactly one of rank or parked`);
  const persona = Array.isArray(raw.persona) ? raw.persona.map((code, i) => text(code, `${tag}.persona[${i}]`, { max: 64 })) : [];
  if (raw.archived != null && typeof raw.archived !== "boolean") fail(`${tag}.archived must be a boolean`);
  const archived = raw.archived === true;
  const replacedBy = text(raw.replacedBy, `${tag}.replacedBy`, { max: 32, required: false });
  if (archived && !replacedBy) fail(`${tag} is archived and needs replacedBy (the live value that counts instead)`);
  if (!archived && replacedBy) fail(`${tag}.replacedBy is only for archived values`);
  if (archived && (persona.length || level !== null)) fail(`${tag}: an archived value cannot own a persona or level`);
  return Object.freeze({
    value, tag, setBy, rank, parked, level,
    persona: Object.freeze(persona),
    hint: text(raw.hint, `${tag}.hint`, { max: 160, required: false }),
    confirm: text(raw.confirm, `${tag}.confirm`, { max: 160, required: false }),
    archived,
    // ป้ายเต็มของค่าที่ใช้แทน (ผูกตอนตรวจทั้งมิติ — ต้องเป็นค่าที่ยังใช้งานในมิติเดียวกัน)
    replacedBy: archived ? formatFrameworkTag(dim.key, replacedBy) : "",
  });
}

function checkArchivedLinks(key, values) {
  const live = new Set(values.filter((v) => !v.archived).map((v) => compareKey(v.tag)));
  if (!live.size) fail(`${key} needs at least one live (not archived) value`);
  for (const value of values) {
    if (value.archived && !live.has(compareKey(value.replacedBy))) {
      fail(`${value.tag}.replacedBy must be a live value of ${key}`);
    }
  }
}

function validateDimension(raw, index) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail(`dimensions[${index}] must be an object`);
  const key = text(raw.key, `dimensions[${index}].key`, { max: 16 });
  if (/[:：/]/u.test(key)) fail(`dimension key "${key}" must not contain ":" or "/"`);
  if (!SET_BY.has(raw.setBy)) fail(`${key}.setBy must be ai, human or system`);
  const open = raw.open === true;
  if (raw.dynamic != null && typeof raw.dynamic !== "boolean") fail(`${key}.dynamic must be a boolean`);
  // dynamic = ค่าเดียวที่ระบบคำนวณใหม่ทุกครั้ง (ไม่จำ) — มีได้เฉพาะมิติของระบบ
  if (raw.dynamic === true && raw.setBy !== "system") fail(`${key}: only a system dimension can be dynamic`);
  const dim = {
    key,
    label: text(raw.label, `${key}.label`, { max: 80, required: false }) || key,
    setBy: raw.setBy,
    open,
    dynamic: raw.dynamic === true,
    guide: text(raw.guide, `${key}.guide`, { max: 240, required: false }),
    factKey: text(raw.factKey, `${key}.factKey`, { max: 40, required: false }),
    factSources: Object.freeze(Array.isArray(raw.factSources) ? raw.factSources.map((source) => {
      if (!FACT_SOURCES.has(source)) fail(`${key}.factSources has unknown source ${source}`);
      return source;
    }) : ["human"]),
  };
  if (open) {
    if (raw.setBy === "ai") fail(`${key}: an AI dimension cannot be open — AI may only choose from a closed list`);
    return Object.freeze({ ...dim, max: null, merge: null, values: Object.freeze([]) });
  }
  const max = Number(raw.max);
  if (!Number.isInteger(max) || max < 1 || max > 5) fail(`${key}.max must be 1-5`);
  if (!MERGES.has(raw.merge)) fail(`${key}.merge must be accumulate, funnel or latest`);
  if ((raw.merge === "funnel" || raw.merge === "latest") && max !== 1) fail(`${key}: ${raw.merge} dimensions hold exactly one value`);
  if (!Array.isArray(raw.values) || !raw.values.length) fail(`${key}.values must be a non-empty array`);
  const partial = { ...dim, max, merge: raw.merge };
  const values = raw.values.map((value, i) => validateValue(value, partial, i));
  checkArchivedLinks(key, values);
  const seen = new Set();
  for (const value of values) {
    const k = compareKey(value.value);
    if (seen.has(k)) fail(`${key} has duplicate value "${value.value}"`);
    seen.add(k);
  }
  return Object.freeze({ ...partial, values: Object.freeze(values) });
}

// ดัชนีค้นป้าย: ชื่อมิติ → มิติ, ป้ายเต็ม → ค่า, persona ของ scorer → ป้าย, ขั้นบันได → ป้าย
function indexDimensions(dimensions) {
  const byDimension = new Map();
  const byTag = new Map();
  const personaToTag = new Map();
  const levelToTag = new Map();
  for (const dim of dimensions) {
    const k = dimensionKey(dim.key);
    if (byDimension.has(k)) fail(`duplicate dimension ${dim.key}`);
    byDimension.set(k, dim);
    for (const value of dim.values) {
      if (value.archived) continue;
      byTag.set(compareKey(value.tag), { dim, entry: value });
      for (const code of value.persona) {
        if (personaToTag.has(code)) fail(`persona ${code} maps to more than one value`);
        personaToTag.set(code, value.tag);
      }
      if (!dim.factKey || value.level === null) continue;
      if (levelToTag.has(value.level)) fail(`level ${value.level} maps to more than one value`);
      levelToTag.set(value.level, value.tag);
    }
    // ป้ายของค่า archived ชี้ไปค่าที่ใช้แทน (ทุกเส้นทางที่อ่านป้ายนับเป็นค่านั้น) + จำไว้ว่ามาจากค่าที่พักแล้ว
    for (const value of dim.values) {
      if (!value.archived) continue;
      byTag.set(compareKey(value.tag), { ...byTag.get(compareKey(value.replacedBy)), archived: value });
    }
  }
  return { byDimension, byTag, personaToTag, levelToTag };
}

// ป้ายที่กฎอ้างถึงต้องเป็นค่าในรายการปิดจริง (กันพิมพ์ผิดในไฟล์กรอบ)
function closedTagResolver(byTag) {
  return (tag, label, { aiOnly = false } = {}) => {
    const hit = byTag.get(compareKey(tag));
    if (!hit) fail(`${label} "${tag}" is not a value of the framework`);
    // กฎที่ชี้ค่า archived = ไฟล์ค้างชื่อเก่า — ต้องชี้ค่าที่ใช้แทนตรง ๆ
    if (hit.archived) fail(`${label} "${tag}" is archived — point it at "${hit.archived.replacedBy}"`);
    if (aiOnly && hit.entry.setBy !== "ai") fail(`${label} "${tag}" is not settable by ai`);
    return hit.entry.tag;
  };
}

function validateLegacyRules(list, requireClosedTag) {
  const rules = (Array.isArray(list) ? list : []).map((raw, index) => {
    if (!raw || typeof raw !== "object") fail(`legacyRules[${index}] must be an object`);
    const id = text(raw.id, `legacyRules[${index}].id`, { max: 64 });
    const kinds = [Array.isArray(raw.tags) && raw.tags.length > 0, typeof raw.drop === "string", typeof raw.block === "string"];
    if (kinds.filter(Boolean).length !== 1) fail(`legacyRules ${id} needs exactly one of tags, drop or block`);
    return Object.freeze({
      id,
      re: compile(raw.pattern, `legacyRules ${id}.pattern`),
      unless: raw.unless == null ? null : compile(raw.unless, `legacyRules ${id}.unless`),
      // ป้ายเก่าเป็นของ AI จึงแปลงได้เฉพาะเป็นค่าที่ AI ติดได้
      tags: Object.freeze((raw.tags || []).map((tag, i) => requireClosedTag(tag, `legacyRules ${id}.tags[${i}]`, { aiOnly: true }))),
      drop: typeof raw.drop === "string" ? text(raw.drop, `legacyRules ${id}.drop`) : null,
      block: typeof raw.block === "string" ? text(raw.block, `legacyRules ${id}.block`) : null,
    });
  });
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) fail("legacyRules ids must be unique");
  return Object.freeze(rules);
}

function validateHumanRules(list, requireClosedTag) {
  return Object.freeze((Array.isArray(list) ? list : []).map((raw, index) => Object.freeze({
    re: compile(raw?.match, `legacyHumanTags[${index}].match`),
    kind: text(raw?.kind, `legacyHumanTags[${index}].kind`, { max: 32 }),
    to: Object.freeze((raw?.to || []).map((tag, i) => requireClosedTag(tag, `legacyHumanTags[${index}].to[${i}]`))),
    confirm: raw?.confirm === true,
    note: text(raw?.note, `legacyHumanTags[${index}].note`, { max: 240, required: false }),
  })));
}

const textList = (value, label) => Object.freeze((Array.isArray(value) ? value : []).map((tag, i) => text(tag, `${label}[${i}]`, { max: 60 })));

function validateSegments(list) {
  return Object.freeze((Array.isArray(list) ? list : []).map((raw, index) => {
    const id = text(raw?.id, `segments[${index}].id`, { max: 64 });
    const include = textList(raw.include, `segments ${id}.include`);
    if (!include.length) fail(`segments ${id}.include must not be empty`);
    return Object.freeze({
      id,
      name: text(raw.name, `segments ${id}.name`, { max: 120 }),
      use: text(raw.use, `segments ${id}.use`, { max: 200, required: false }),
      include,
      exclude: textList(raw.exclude, `segments ${id}.exclude`),
    });
  }));
}

/**
 * มิติการซื้อของระบบ (คำสั่งพี่ง้วง 28 ก.ย. 2026 — "ซื้อครั้งที่เท่าไหร่" + "ซื้อเมื่อไหร่" แบบ dynamic)
 * ไม่มีหัวข้อนี้ = RFM ทำงานแบบเดิม · มี = ต้องชี้มิติของระบบที่เป็น dynamic ทั้งสองตัว
 */
function validatePurchaseTags(raw, byDimension) {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) fail("purchaseTags must be an object");
  const dimOf = (name) => {
    const key = text(raw[name], `purchaseTags.${name}`, { max: 16 });
    const dim = byDimension.get(dimensionKey(key));
    if (!dim || dim.setBy !== "system" || !dim.open || !dim.dynamic) {
      fail(`purchaseTags.${name} "${key}" must name an open, dynamic system dimension`);
    }
    return dim.key;
  };
  const countDimension = dimOf("countDimension");
  const lastDimension = dimOf("lastDimension");
  if (countDimension === lastDimension) fail("purchaseTags needs two different dimensions");
  const countTags = new Map();
  const legacy = raw.legacyCountTags ?? {};
  if (typeof legacy !== "object" || Array.isArray(legacy)) fail("purchaseTags.legacyCountTags must be an object");
  for (const [tag, n] of Object.entries(legacy)) {
    const clean = text(tag, "purchaseTags.legacyCountTags key", { max: 40 });
    if (!Number.isInteger(n) || n < 1 || n > 99) fail(`purchaseTags.legacyCountTags "${clean}" must be 1-99`);
    countTags.set(clean, n);
  }
  if (raw.legacyMonthTags != null && typeof raw.legacyMonthTags !== "boolean") fail("purchaseTags.legacyMonthTags must be a boolean");
  return Object.freeze({ countDimension, lastDimension, countTags, legacyMonthTags: raw.legacyMonthTags === true });
}

/**
 * ตรวจ + แช่แข็งกรอบป้ายของธุรกิจ — ไฟล์ผิดรูป = โยนทันที (ห้ามรันด้วยกรอบเพี้ยนแบบเงียบ)
 * @returns {Readonly<object>} กรอบที่ใช้กับฟังก์ชันอื่นในไฟล์นี้
 */
export function validateTagFramework(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("root must be an object");
  for (const key of Object.keys(input)) if (!ROOT_KEYS.has(key)) fail(`root has unknown key ${key}`);
  if (input.schemaVersion !== 1) fail("schemaVersion must be 1");
  const businessId = text(input.businessId, "businessId", { max: 64 });
  if (!ID.test(businessId)) fail("businessId must be a lowercase identifier");
  if (!Array.isArray(input.dimensions) || !input.dimensions.length) fail("dimensions must be a non-empty array");

  const dimensions = input.dimensions.map(validateDimension);
  if (!dimensions.some((dim) => dim.setBy === "ai")) fail("at least one dimension must be settable by ai");
  const index = indexDimensions(dimensions);
  const requireClosedTag = closedTagResolver(index.byTag);
  const buyer = input.buyerMarkers || {};
  const humanRules = validateHumanRules(input.legacyHumanTags, requireClosedTag);
  const buyerExact = textList(buyer.exact, "buyerMarkers.exact");
  const purchaseBase = validatePurchaseTags(input.purchaseTags, index.byDimension);
  // 28 ก.ย. 2026 (พี่ง้วง: คนที่ซื้อแล้ว "ยังไงก็ต้องมีว่า ซื้อครั้งที่เท่าไหร่"): ป้ายคลาสที่เคยซื้อจาก LINE OA เดิม
  // (กฎชนิด purchase) และป้าย customer = หลักฐานว่าซื้อแล้ว — ใช้เป็นขั้นต่ำ ซื้อครั้งที่: 1 เมื่อไม่มีเลขครั้ง/เดือน/ออเดอร์
  const purchase = purchaseBase && Object.freeze({
    ...purchaseBase,
    buyerTagRes: Object.freeze(humanRules.filter((rule) => rule.kind === "purchase").map((rule) => rule.re)),
    buyerExact: Object.freeze([...buyerExact]),
  });
  return Object.freeze({
    schemaVersion: 1,
    businessId,
    frameworkId: text(input.frameworkId, "frameworkId", { max: 64, required: false }),
    status: text(input.status, "status", { max: 64, required: false }),
    dimensions: Object.freeze(dimensions),
    ...index,
    rules: validateLegacyRules(input.legacyRules, requireClosedTag),
    humanRules,
    systemTags: Object.freeze(new Set(textList(input.systemTags, "systemTags"))),
    buyerMarkers: Object.freeze({
      exact: buyerExact,
      prefixes: textList(buyer.prefixes, "buyerMarkers.prefixes"),
    }),
    purchase,
    segments: validateSegments(input.segments),
  });
}

/** ไม่ตั้งค่า = ปิดทั้งระบบ (พฤติกรรมเดิมทุกไบต์) · ตั้งแล้วไฟล์พัง = ล้มตอนบูต ไม่รันเงียบ */
export function loadTagFramework(file) {
  if (!file) return null;
  if (!existsSync(file)) fail(`configured file does not exist (${file})`);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`cannot parse ${file} (${error.message})`);
  }
  return validateTagFramework(parsed);
}

/* ------------------------------ อ่านป้าย ------------------------------ */

function splitDimension(tag, framework) {
  const match = DIM_SPLIT.exec(cleanTagText(tag));
  if (!match) return null;
  const dim = framework.byDimension.get(dimensionKey(match[1]));
  return dim ? { dim, body: cleanTagText(match[2]) } : null;
}

/**
 * ป้ายนี้เป็นค่าในรายการปิดของกรอบไหม — รับความคลาดเคลื่อนที่ไม่เปลี่ยนความหมาย
 * (ช่องว่าง ตัวพิมพ์ละติน โคลอนเต็มความกว้าง และเลขขั้นของบันได เช่น "ระดับAI: 3")
 * @returns {{ dim: object, entry: object } | null}
 */
export function lookupFrameworkTag(tag, framework) {
  const direct = framework.byTag.get(compareKey(tag));
  if (direct) return direct;
  const split = splitDimension(tag, framework);
  if (!split || split.dim.open) return null;
  const body = compareKey(split.body);
  const exact = split.dim.values.find((value) => compareKey(value.value) === body);
  // ค่า archived คืนค่าที่ใช้แทน (พร้อมธง archived) — เหมือนเส้นทางป้ายเต็มด้านบน
  if (exact) return framework.byTag.get(compareKey(exact.tag)) || null;
  // เลขล้วน = อ้างขั้นของบันได ("ระดับAI: 3") — คำอื่นห้ามเดาจากคำขึ้นต้น ("สนใจ: AI Agent" ต้องผ่านกฎแปลง)
  if (!/^\d+$/u.test(body)) return null;
  const prefixed = split.dim.values.filter((value) => !value.archived && compareKey(value.value).startsWith(`${body} `));
  return prefixed.length === 1 ? { dim: split.dim, entry: prefixed[0] } : null;
}

/* ----------------------- แปลงป้ายข้อความอิสระรุ่นเก่า ----------------------- */

/**
 * แปลงป้าย AI แบบข้อความอิสระหนึ่งใบเข้ากรอบ
 * disposition: framework (เป็นค่าในกรอบอยู่แล้ว) · mapped · system (ป้ายระบบ คงไว้ตามเดิม)
 *              dropped (ตัดสินแล้วว่าไม่มีข้อมูลพอแบ่งกลุ่ม) · blocked (ข้อมูลอ่อนไหว ห้ามเป็นป้าย)
 *              unmapped (ยังไม่มีกฎรองรับ) · empty
 */
export function normalizeLegacyTag(tag, framework) {
  const cleaned = cleanTagText(tag);
  if (!cleaned) return { tags: [], disposition: "empty", ruleIds: [] };
  if (framework.systemTags.has(cleaned)) return { tags: [], disposition: "system", ruleIds: [] };
  const known = lookupFrameworkTag(cleaned, framework);
  if (known) return { tags: [known.entry.tag], disposition: "framework", ruleIds: [] };

  // "สนใจ: AI Agent" = ผู้ตอบตั้งใจมิติไหนมาแล้ว — แปลเฉพาะส่วนค่า และให้ผลอยู่ในมิตินั้นเท่านั้น
  const split = splitDimension(cleaned, framework);
  const body = split && !split.dim.open ? split.body : cleaned;
  const onlyDimension = split && !split.dim.open ? split.dim.key : null;

  const tags = [];
  const ruleIds = [];
  let dropped = false;
  for (const rule of framework.rules) {
    if (!rule.re.test(body)) continue;
    if (rule.unless && rule.unless.test(body)) continue;
    if (rule.block) return { tags: [], disposition: "blocked", ruleIds: [rule.id] };
    ruleIds.push(rule.id);
    if (rule.drop) { dropped = true; continue; }
    for (const out of rule.tags) {
      if (onlyDimension && framework.byTag.get(compareKey(out))?.dim.key !== onlyDimension) continue;
      if (!tags.includes(out)) tags.push(out);
    }
  }
  if (tags.length) return { tags, disposition: "mapped", ruleIds };
  return { tags: [], disposition: dropped ? "dropped" : "unmapped", ruleIds };
}

/* ------------------------- ยุบค่าในแต่ละมิติให้ถูกกติกา ------------------------- */

// found: [{ tag, weight }] (weight = ความถี่ หรือ 1 เมื่อเป็นคำตอบของ scorer) — คืนป้ายที่ผ่านเพดาน
function collapse(found, framework) {
  const perDim = new Map();
  found.forEach((item, order) => {
    const hit = framework.byTag.get(compareKey(item.tag));
    if (!hit) return;
    const list = perDim.get(hit.dim.key) || [];
    const existing = list.find((x) => x.entry.tag === hit.entry.tag);
    if (existing) existing.weight += item.weight ?? 1;
    else list.push({ entry: hit.entry, weight: item.weight ?? 1, order });
    perDim.set(hit.dim.key, list);
  });
  const out = [];
  for (const dim of framework.dimensions) {
    const list = perDim.get(dim.key);
    if (!list?.length) continue;
    out.push(...pickForDimension(dim, list).map((x) => x.entry.tag));
  }
  return out;
}

function pickForDimension(dim, list) {
  if (dim.merge === "funnel") {
    // ขอคิดก่อน/ไม่สนใจ ในชุดเดียวกัน = ขั้นล่าสุดของเขา (ถามราคาแล้วบอกขอคิดก่อน)
    const parked = list.filter((x) => x.entry.parked !== null);
    if (parked.length) return [parked.reduce((a, b) => (b.entry.parked > a.entry.parked ? b : a))];
    return [list.reduce((a, b) => (b.entry.rank > a.entry.rank ? b : a))];
  }
  if (dim.max === 1 && list.some((x) => x.entry.level !== null)) {
    // หลักฐานระดับที่สูงกว่าชนะ (บันไดสะสม: ใช้ประจำแล้วย่อมเคยลอง)
    return [list.reduce((a, b) => ((b.entry.level ?? 0) > (a.entry.level ?? 0) ? b : a))];
  }
  const valueOrder = (entry) => dim.values.indexOf(entry);
  return [...list]
    .sort((a, b) => b.weight - a.weight || a.order - b.order || valueOrder(a.entry) - valueOrder(b.entry))
    .slice(0, dim.max);
}

/** ยุบป้ายเก่าทั้งชุดของลูกค้าหนึ่งคนเข้ากรอบ (ความถี่ของหลักฐานเป็นตัวเรียงลำดับ) */
export function normalizeLegacyTagSet(tags, framework) {
  const found = [];
  const dispositions = {};
  for (const tag of Array.isArray(tags) ? tags : []) {
    const result = normalizeLegacyTag(tag, framework);
    dispositions[result.disposition] = (dispositions[result.disposition] || 0) + 1;
    for (const out of result.tags) found.push({ tag: out, weight: 1 });
  }
  return { tags: collapse(found, framework), dispositions };
}

/* ------------------------ ตัวตรวจคำตอบของ scorer ------------------------ */

const aiSettable = (hit) => hit.dim.setBy === "ai" && hit.entry.setBy === "ai";

/**
 * รับเฉพาะป้ายในรายการปิดที่ AI ติดได้ — นอกนั้นทิ้ง (rescue = ลองแปลงผ่านกฎป้ายเก่าก่อนทิ้ง)
 * @returns {{ tags: string[], kept: number, rescued: number, dropped: number }}
 */
export function pickFrameworkTags(raw, framework, { rescue = true } = {}) {
  const found = [];
  let kept = 0;
  let rescued = 0;
  let dropped = 0;
  for (const item of (Array.isArray(raw) ? raw : []).slice(0, MAX_RAW_TAGS)) {
    if (typeof item !== "string" || !cleanTagText(item)) { dropped += 1; continue; }
    const hit = lookupFrameworkTag(item, framework);
    if (hit) {
      if (aiSettable(hit)) { found.push({ tag: hit.entry.tag, weight: 1 }); kept += 1; } else dropped += 1;
      continue;
    }
    // ขึ้นต้นด้วยมิติของคน/ระบบ (ของแจก: … / ซื้อแล้ว: …) = scorer ละเมิดเจ้าของมิติ — ทิ้งเลย ไม่แปลงต่อ
    const split = splitDimension(item, framework);
    const ownedByOthers = split && (split.dim.open || split.dim.setBy !== "ai");
    const legacy = rescue && !ownedByOthers ? normalizeLegacyTag(item, framework) : { tags: [] };
    const usable = legacy.tags.filter((tag) => aiSettable(framework.byTag.get(compareKey(tag))));
    if (usable.length) {
      for (const tag of usable) found.push({ tag, weight: 1 });
      rescued += 1;
    } else {
      dropped += 1;
    }
  }
  return { tags: collapse(found, framework), kept, rescued, dropped };
}

/* ------------------------ รวมกับป้ายเดิมก่อนเขียนลงฐาน ------------------------ */

function frameworkValuesOf(tags, framework, { legacy = false } = {}) {
  const found = [];
  const leftovers = [];
  for (const tag of tags) {
    const hit = lookupFrameworkTag(tag, framework);
    if (hit) found.push({ tag: hit.entry.tag, weight: 1 });
    else leftovers.push(tag);
  }
  if (legacy && leftovers.length) {
    // ป้ายเก่าที่ยังค้างในห้อง = แปลงครั้งเดียวตอน scorer แตะห้องนี้ครั้งแรก ไม่ทิ้งข้อมูลที่ใช้ได้
    for (const tag of normalizeLegacyTagSet(leftovers, framework).tags) found.push({ tag, weight: 1 });
  }
  const perDim = new Map();
  for (const tag of collapse(found, framework)) {
    const hit = framework.byTag.get(compareKey(tag));
    if (!hit) continue;
    perDim.set(hit.dim.key, [...(perDim.get(hit.dim.key) || []), hit.entry]);
  }
  return perDim;
}

function mergeFunnel(previous, next) {
  const [prev] = previous;
  const [nxt] = next;
  if (!nxt) return prev ? [prev] : [];
  if (!prev || nxt.parked !== null || prev.parked !== null) return [nxt];
  return [nxt.rank >= prev.rank ? nxt : prev];
}

/**
 * ป้าย AI ชุดใหม่ที่จะเขียนแทนชุดเดิม (ใช้กับ db.replaceSourceTags(customerId, "ai", …))
 * - humanTags: ป้ายที่คนติดไว้ — มิติค่าเดียวที่คนตั้งค่าแล้ว AI ไม่ติดทับ (คนแก้ AI ได้ด้วยการติดป้ายเอง)
 * - personaType: ผล persona_type ของ scorer รอบนี้ ใช้เมื่อ scorer ไม่ได้ให้ป้ายอาชีพ
 * - facts: { [factKey]: { value, source } } เช่น ai_level — ชนะคำเดาเมื่อ source อยู่ใน factSources ของมิติ
 * - factSources: ใช้แทน factSources ของมิติ (สำหรับการซ้อม "ถ้าแก้ตัวจับแล้ว" เท่านั้น)
 */
export function mergeFrameworkTags({ framework, previous = [], next = [], humanTags = [], personaType = "", facts = {}, factSources = null } = {}) {
  const prev = frameworkValuesOf(previous.filter((tag) => !framework.systemTags.has(cleanTagText(tag))), framework, { legacy: true });
  const nextFound = [...next];
  const personaTag = framework.personaToTag.get(String(personaType || ""));
  const personaDim = personaTag ? framework.byTag.get(compareKey(personaTag)).dim : null;
  const nextHasPersonaDim = next.some((tag) => lookupFrameworkTag(tag, framework)?.dim === personaDim);
  if (personaTag && !nextHasPersonaDim) nextFound.push(personaTag);
  const nxt = frameworkValuesOf(nextFound, framework);
  const human = frameworkValuesOf(humanTags, framework);

  const out = [];
  for (const dim of framework.dimensions) {
    if (dim.setBy !== "ai" || dim.open) continue;
    if (dim.max === 1 && human.get(dim.key)?.length) continue;
    const before = prev.get(dim.key) || [];
    const now = (nxt.get(dim.key) || []).filter((entry) => entry.setBy === "ai");
    let chosen;
    if (dim.merge === "funnel") chosen = mergeFunnel(before.filter((e) => e.setBy === "ai"), now);
    else if (dim.merge === "latest") chosen = now.length ? now : before;
    else {
      // หลักฐานรอบนี้มาก่อนเสมอ ส่วนค่าเก่าเรียงตามลำดับในไฟล์กรอบ (ความสำคัญที่พี่ง้วงกำหนด)
      // ไม่พึ่งลำดับที่ฐานคืนมา: ป้าย AI ทั้งชุดถูกเขียนใหม่ด้วยเวลาเดียวกันทุกรอบ
      // ลำดับจากฐานจึงเป็นลำดับตัวอักษร ไม่ใช่ความเก่า-ใหม่
      const older = before.filter((entry) => !now.includes(entry))
        .sort((a, b) => dim.values.indexOf(a) - dim.values.indexOf(b));
      chosen = [...now, ...older].slice(0, dim.max);
    }
    const fact = dim.factKey ? facts?.[dim.factKey] : null;
    const level = Number(fact?.value);
    const trusted = Array.isArray(factSources) ? factSources : dim.factSources;
    if (fact && trusted.includes(fact.source) && framework.levelToTag.has(level)) {
      chosen = [framework.byTag.get(compareKey(framework.levelToTag.get(level))).entry];
    }
    for (const entry of chosen) out.push(entry.tag);
  }
  return out;
}

/* --------------------------- ส่วนของ prompt scorer --------------------------- */

/**
 * บล็อกคงที่ของ system prompt (ไม่มีข้อมูลลูกค้า) — วางก่อนส่วนที่เปลี่ยนตามห้อง
 * เพื่อให้ prompt caching ของผู้ให้บริการโมเดลใช้ซ้ำได้ทุกห้อง
 */
export function renderTagFrameworkPrompt(framework) {
  const lines = [
    "ป้ายลูกค้า (tags) = รายการปิดสำหรับแบ่งกลุ่มบรอดแคสต์ของทีม:",
    "- ใส่ได้เฉพาะป้ายในรายการนี้ คัดลอกให้ตรงทุกตัวอักษรรวม \"มิติ: \" ข้างหน้า ห้ามแต่งป้ายใหม่ ห้ามเติมชื่อคน ชื่อบริษัท วันที่ หรือตัวเลขเอง",
    "- ใส่เฉพาะมิติที่มีหลักฐานจากสิ่งที่ลูกค้าพิมพ์เองหรือบันทึกทีมงาน ไม่แน่ใจ = ไม่ต้องใส่มิตินั้น (ระบบจำป้ายเดิมไว้ให้แล้ว ไม่ต้องใส่ซ้ำ)",
    "- ข้อความของแอดมิน/บอท และการกดปุ่มสำเร็จรูปอย่างเดียว ไม่ใช่หลักฐานของป้าย",
  ];
  for (const dim of framework.dimensions) {
    if (dim.setBy !== "ai" || dim.open) continue;
    const values = dim.values.filter((value) => value.setBy === "ai" && !value.archived);
    if (!values.length) continue;
    const count = dim.max === 1 ? "1 ป้าย" : `สูงสุด ${dim.max} ป้าย`;
    lines.push(`[${dim.key}] (${count})${dim.guide ? ` ${dim.guide}` : ""}`);
    for (const value of values) lines.push(`  "${value.tag}"${value.hint ? ` = ${value.hint}` : ""}`);
  }
  return lines.join("\n");
}

/* ------------------------- ป้ายที่คนติดเองในคอนโซล ------------------------- */

const liveValues = (dim) => dim.values.filter((value) => !value.archived);

function systemDimensionReason(dim) {
  return `ป้าย "${dim.key}: …" ระบบติดเองจากออเดอร์และประวัติการซื้อ (คำนวณใหม่ทุกครั้งที่ออเดอร์ขยับ) — ทีมไม่ต้องติดเอง ถ้าลูกค้าซื้อนอกระบบ ให้สร้างออเดอร์ในคอนโซลแทน`;
}

/**
 * ตรวจป้ายที่คนจะติด (พี่ง้วง 28 ก.ย. 2026: "ทีมคน ติดได้ครับ"):
 * ป้ายอิสระติดได้เสมอ · มิติที่มีรายการ = ต้องเป็นค่าในรายการ (ค่าใหม่ต้องให้พี่ง้วงอนุมัติแล้วเพิ่มในไฟล์กรอบก่อน)
 * · ค่า archived = ชี้ค่าที่ใช้แทน · มิติของระบบ = ติดเองไม่ได้
 * @returns {{ ok: true, inFramework: boolean, tag: string } | { ok: false, reason: string }}
 *   tag = รูปมาตรฐาน (เว้นวรรคหลังโคลอน ตัวพิมพ์ตามไฟล์กรอบ) ให้ป้ายเดียวกันเป็นชื่อเดียวกันเสมอ
 */
export function checkHumanTag(tag, framework) {
  const cleaned = cleanTagText(tag);
  if (!cleaned) return { ok: false, reason: "ป้ายว่าง" };
  const hit = lookupFrameworkTag(cleaned, framework);
  if (hit) {
    if (hit.dim.setBy === "system") return { ok: false, reason: systemDimensionReason(hit.dim) };
    if (hit.archived) {
      return { ok: false, reason: `"${hit.archived.tag}" พักไว้แล้วตามที่พี่ง้วงสั่ง — ใช้ "${hit.entry.tag}" แทน` };
    }
    return { ok: true, inFramework: true, tag: hit.entry.tag };
  }
  const split = splitDimension(cleaned, framework);
  if (!split) return { ok: true, inFramework: false, tag: cleaned };
  if (split.dim.setBy === "system") return { ok: false, reason: systemDimensionReason(split.dim) };
  if (split.dim.open) return { ok: true, inFramework: true, tag: formatFrameworkTag(split.dim.key, split.body) };
  const choices = liveValues(split.dim).map((value) => value.value).join(" · ");
  return {
    ok: false,
    reason: `"${split.body}" ไม่อยู่ในรายการของมิติ "${split.dim.key}" — เลือกได้: ${choices} (ค่าใหม่ต้องให้พี่ง้วงอนุมัติก่อน)`,
  };
}

/**
 * กรอบในรูปที่คอนโซลใช้ได้ (ไม่มี regex/กฎแปลง) — แผงป้ายจัดกลุ่มตามมิติและทำตัวเลือกจากรายการปิด
 * canAdd = คนเลือกมิตินี้ในแผงได้ไหม (มิติของระบบ = ไม่ได้)
 */
export function frameworkView(framework) {
  return {
    frameworkId: framework.frameworkId,
    dimensions: framework.dimensions.map((dim) => ({
      key: dim.key,
      label: dim.label,
      setBy: dim.setBy,
      open: dim.open,
      dynamic: dim.dynamic,
      max: dim.max,
      merge: dim.merge,
      guide: dim.guide,
      canAdd: dim.setBy !== "system",
      values: liveValues(dim).map((value) => ({ value: value.value, tag: value.tag, setBy: value.setBy, hint: value.hint })),
      archived: dim.values.filter((value) => value.archived).map((value) => ({ value: value.value, tag: value.tag, replacedBy: value.replacedBy })),
    })),
    systemTags: [...framework.systemTags],
  };
}

/** ป้าย LINE OA เดิม (ทีมติดเอง) ควรไปอยู่ตรงไหน — ข้อเสนอเท่านั้น ระบบไม่ย้ายเอง */
export function classifyHumanTag(tag, framework) {
  const cleaned = cleanTagText(tag);
  if (lookupFrameworkTag(cleaned, framework)) return { kind: "framework", to: [], confirm: false, note: "" };
  const rule = framework.humanRules.find((item) => item.re.test(cleaned));
  if (rule) return { kind: rule.kind, to: [...rule.to], confirm: rule.confirm, note: rule.note };
  if (framework.systemTags.has(cleaned)) return { kind: "system", to: [], confirm: false, note: "" };
  return { kind: "unknown", to: [], confirm: true, note: "" };
}

/** ป้ายนี้บอกว่าซื้อแล้วไหม (ใช้ตัดคนซื้อออกจากกลุ่มบรอดแคสต์) */
export function isBuyerMarker(tag, framework) {
  const cleaned = cleanTagText(tag);
  return framework.buyerMarkers.exact.includes(cleaned)
    || framework.buyerMarkers.prefixes.some((prefix) => cleaned.startsWith(prefix));
}

/**
 * ความครอบคลุมของกฎแปลงป้ายเก่า — ถ่วงด้วยจำนวนครั้งที่ป้ายถูกใช้จริง
 * @param {Array<{tag: string, n: number}>} rows
 */
export function legacyCoverage(rows, framework) {
  const byDisposition = {};
  const unmapped = [];
  let total = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const n = Number(row?.n) || 0;
    if (n <= 0) continue;
    total += n;
    const { disposition } = normalizeLegacyTag(row.tag, framework);
    byDisposition[disposition] = (byDisposition[disposition] || 0) + n;
    if (disposition === "unmapped") unmapped.push({ tag: cleanTagText(row.tag), n });
  }
  const count = (key) => byDisposition[key] || 0;
  const toFramework = count("mapped") + count("framework");
  const decided = toFramework + count("system") + count("dropped") + count("blocked");
  const pct = (value) => (total ? Math.round((value / total) * 1000) / 10 : 0);
  return {
    total,
    byDisposition,
    toFrameworkPct: pct(toFramework),
    decidedPct: pct(decided),
    unmapped: unmapped.sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag, "th")),
  };
}
