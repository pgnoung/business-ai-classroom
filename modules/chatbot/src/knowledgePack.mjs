// knowledgePack.mjs — G3: ประกอบ "ความรู้เพิ่มเติมจากทีมงาน" เข้า prompt (ต่อท้าย brand pack)
//
// กติกา:
// - ใช้เฉพาะรายการ active — ปิดสวิตช์จาก console = หายจาก prompt ทันที
// - เพดานรวม KNOWLEDGE_MAX_CHARS: เกินแล้วตัดรายการเก่าสุดทิ้งก่อน (ความรู้ใหม่สำคัญกว่า)
// - ความรู้เป็นบริบทเท่านั้น — ราคายังคุมด้วย approved_prices + compliance guard เสมอ
// - อ่าน DB พัง = ไม่มี section (แชทต้องเดินต่อได้เสมอ)
import { codePointLength, truncateCodePoints, wellFormedText } from "./unicodeText.mjs";

export const KNOWLEDGE_HEADER = "ความรู้เพิ่มเติมจากทีมงาน:";
// เพดานนี้คือ "ความรู้ที่ทีมงานเขียนเอง" ที่ต่อท้าย brand pack ก่อนส่งเข้าโมเดล
// 8,000 เคยพอตอนมีความรู้ไม่กี่รายการ แต่พอคลังโตขึ้นมันแตะเพดานแล้วตัดรายการ
// "เก่าสุด" ทิ้งเงียบ ๆ ซึ่งเก่าสุดมักเป็นแคตตาล็อกคลาส+ราคา = ของสำคัญที่สุด
// ยกเป็น 24,000 (~8,000 token) ให้มีที่หายใจ และการตัดกลายเป็นเรื่องผิดปกติจริง ๆ
//
// v1.3.4: คลังจริงโตถึง 20,883 = 87% ของ 24,000 เหลือที่ว่างแค่ 3,117 ตัวอักษร
// เติมความรู้อีกใบเดียวขนาดปกติ รายการเก่าสุด (แคตตาล็อกคลาส+ราคา) จะถูกทิ้งเงียบ
// ตอนนี้ความรู้ไม่ผ่านตัวเลือกการ์ดแล้ว เพดานจึงคุมแค่ขนาด prompt ล้วน ๆ
// คำนวณจากของจริง: brand pack 18.6k + persona 14.5k + rules ~4k + ความรู้ 60k = 97k ตัวอักษร
// ยังไม่ถึงครึ่งของเพดานข้อความเดี่ยว 200,000 ที่เกตเวย์รับได้
// v1.4.49 (คำสั่งเจ้าของ 2026-08-29): 60000 -> 80000 — ของจริงชนเพดาน 99.0% แล้ว
// การยกเพดานเองไม่เสียเงิน (เงินเดินตามเนื้อหาที่ใส่จริง) แต่ต้องมาคู่กับด่านใน console
// ที่ปฏิเสธการเพิ่มตอนล้น — ไม่ใช่ปล่อยให้ตัดรายการเก่าสุด (แคตตาล็อกราคา!) ทิ้งเงียบ ๆ
// คำนวณใหม่: brand pack 18.6k + persona 14.5k + rules ~8k + ความรู้ 80k = 121k
// ยังห่างเพดานข้อความเดี่ยว 200,000 ของเกตเวย์
export const KNOWLEDGE_MAX_CHARS = 80000;

/* ---- 19 ต.ค. 2026: คลังรีวิวออกจากพรอมต์ + งบแยก (คำสั่งพี่ง้วง "เอาคลังรีวิวออกจาก prompt") ----
 * การ์ด "รีวิวนักเรียนจริง" (~17,000 ตัวอักษร · 117 รายการ) เคยกินงบ 80,000 ราว 21% ทั้งที่โค้ดเป็นคนเลือกรายการ
 * ที่จะส่งเองอยู่แล้ว (reviewSelection / socialProof / stagedFollowups / showcaseArrival) — ตอนนี้:
 * - ข้อความเต็มของการ์ดยังอยู่ในก้อนความรู้ที่ "โค้ด" อ่าน (ตัวเลือกรีวิว · รหัส WF-/RV- จากปุ่ม LINE)
 * - ก่อนส่งเข้าโมเดล ตัดรายการที่โค้ดไม่ได้เลือกทิ้ง (reviewCatalogPrompt.mjs) เหลือกติกาการใช้ + รายการที่เลือก
 * - งบ: การ์ดนี้ไม่นับใน 80,000 ของคลังความรู้ แต่มีงบของตัวเอง REVIEW_CATALOG_MAX_CHARS (คอนโซลบังคับ)
 * - ไม่ตัดรายการเก่าเงียบ ๆ เหมือนเดิม: การ์ดคลังรีวิวไม่ถูกทิ้งเพราะงบความรู้ และไม่ทำให้การ์ดอื่นถูกทิ้ง
 * สวิตช์ถอยกลับ (ไม่ต้อง deploy): settings.review_catalog_in_prompt = "on" = แนบทั้งคลัง + งบรวมแบบเดิมทุกไบต์
 * ไม่มีแถว/ค่าอื่น/อ่านพัง = "off" = แบบใหม่
 */
export const REVIEW_CATALOG_TITLE_MATCH = "รีวิวนักเรียนจริง";
export const REVIEW_CATALOG_MAX_CHARS = 40000;
export const REVIEW_CATALOG_IN_PROMPT_KEY = "review_catalog_in_prompt";
export const REVIEW_CATALOG_IN_PROMPT_MODES = Object.freeze(["off", "on"]);

export function reviewCatalogInPromptMode(db) {
  try {
    return String(db?.getSetting?.(REVIEW_CATALOG_IN_PROMPT_KEY) ?? "").trim().toLowerCase() === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

// true = แบบใหม่ (คลังรีวิวนอกพรอมต์ + งบแยก) · false = แบบเดิมทุกไบต์
export const catalogOutOfPrompt = (db) => reviewCatalogInPromptMode(db) !== "on";

export const isReviewCatalogTitle = (title) => String(title || "").includes(REVIEW_CATALOG_TITLE_MATCH);

// การ์ดคลังรีวิวคือใบแรกที่ชื่อตรง (ตัวเดียวกับที่ทุกตัวเลือกใช้ .find) — ใบที่สองขึ้นไปนับเป็นความรู้ปกติ
function catalogIndexOf(rows) {
  return rows.findIndex((e) => isReviewCatalogTitle(e?.title));
}

// entries เรียงเก่า -> ใหม่ (ตาม listActiveKnowledge) — เกินเพดานตัดของเก่าสุดทิ้งก่อน
// separateCatalog (แบบใหม่): การ์ดคลังรีวิวไม่กินงบ maxChars และไม่ถูกตัดทิ้ง (งบของมันคุมที่คอนโซล)
export function buildKnowledgeSection(entries, { maxChars = KNOWLEDGE_MAX_CHARS, logger = console, separateCatalog = false } = {}) {
  const rows = (entries || []).filter((e) => e && (e.title || e.content));
  if (!rows.length) return "";
  const blocks = rows.map((e) => `[${wellFormedText(e.title || "-")}]\n${wellFormedText(e.content)}`);
  const catalogAt = separateCatalog ? catalogIndexOf(rows) : -1;

  // เลือกจากใหม่สุดย้อนกลับจนเต็มเพดาน — คงลำดับเก่า -> ใหม่ในผลลัพธ์
  const picked = [];
  let used = 0;
  let budgeted = 0; // จำนวนบล็อกที่นับงบแล้ว (ตัวคั่นนับเฉพาะบล็อกที่นับงบ — เท่าเดิมเมื่อไม่มีคลังรีวิว)
  let stopped = false;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (i === catalogAt) { picked.unshift(blocks[i]); continue; }
    if (stopped) continue;
    const cost = codePointLength(blocks[i]) + (budgeted ? 2 : 0); // +2 = ตัวคั่น "\n\n"
    if (used + cost > maxChars) { stopped = true; if (catalogAt < 0) break; continue; }
    picked.unshift(blocks[i]);
    used += cost;
    budgeted += 1;
  }
  const budgetedTotal = blocks.length - (catalogAt >= 0 ? 1 : 0);
  if (!budgeted && budgetedTotal) {
    // รายการใหม่สุดตัวเดียวก็ยาวเกินเพดาน — ตัดเนื้อหาให้พอดี (ห้ามหายทั้งก้อน)
    const newest = blocks.length - 1 === catalogAt ? blocks.length - 2 : blocks.length - 1;
    const cut = truncateCodePoints(blocks[newest], maxChars);
    if (catalogAt >= 0) picked.splice(catalogAt < newest ? picked.length : 0, 0, cut);
    else picked.push(cut);
    // warn ไม่ใช่ debug: ความรู้หายจาก prompt เงียบ ๆ คือสาเหตุที่บอทตอบผิดแบบหาไม่เจอ
    logger.warn?.(`knowledge: รายการใหม่สุดยาวเกิน ${maxChars} ตัวอักษร — ตัดเนื้อหาให้พอดีเพดาน`);
  } else if (budgeted < budgetedTotal) {
    logger.warn?.(
      `knowledge: รวมเกินเพดาน ${maxChars} ตัวอักษร — ตัดรายการเก่าสุดทิ้ง ${budgetedTotal - budgeted} รายการ`
    );
  }
  return `${KNOWLEDGE_HEADER}\n${picked.join("\n\n")}`;
}

// v1.4.49: นับแบบเดียวกับ buildKnowledgeSection เป๊ะ (บล็อก [title]\ncontent + ตัวคั่น 2)
// ใช้สองที่: console ปฏิเสธการเพิ่มตอนล้น และ digest เตือนเมื่อมีรายการตกขอบอยู่จริง
// separateCatalog (แบบใหม่): totalChars/droppedCount ไม่นับการ์ดคลังรีวิว + มี catalogChars แยก (งบ REVIEW_CATALOG_MAX_CHARS)
export function knowledgeUsage(entries, { maxChars = KNOWLEDGE_MAX_CHARS, separateCatalog = false } = {}) {
  const all = (entries || []).filter((e) => e && (e.title || e.content));
  const catalogAt = separateCatalog ? catalogIndexOf(all) : -1;
  const sizeOf = (e) => codePointLength(`[${wellFormedText(e.title || "-")}]\n${wellFormedText(e.content)}`);
  const rows = catalogAt >= 0 ? all.filter((_, i) => i !== catalogAt) : all;
  const sizes = rows.map(sizeOf);
  const totalChars = sizes.reduce((sum, n) => sum + n, 0) + Math.max(0, sizes.length - 1) * 2;
  let used = 0, kept = 0;
  for (let i = sizes.length - 1; i >= 0; i -= 1) {
    const cost = sizes[i] + (kept ? 2 : 0);
    if (used + cost > maxChars) break;
    used += cost; kept += 1;
  }
  // entryCount = ทุกการ์ดที่เปิด (รวมคลังรีวิว) · การ์ดคลังรีวิวไม่มีวันถูกตัดเพราะงบความรู้ จึงไม่อยู่ใน droppedCount
  const usage = { totalChars, entryCount: all.length, droppedCount: rows.length - kept };
  if (separateCatalog) usage.catalogChars = catalogAt >= 0 ? sizeOf(all[catalogAt]) : 0;
  return usage;
}

// อ่านจาก DB (เฉพาะ active) — ทุกความล้มเหลวคืน "" เงียบ ๆ
// G6 (P1): scope null = สมองกลาง / = channel id เฉพาะสาขาโหมดสมองแยก
export function knowledgeSectionFromDb(db, { maxChars, logger, scope = null } = {}) {
  try {
    return buildKnowledgeSection(db.listActiveKnowledge(scope), { maxChars, logger, separateCatalog: catalogOutOfPrompt(db) });
  } catch {
    return "";
  }
}

// ต่อ section เข้าท้าย brand pack (spec: "append after brandPack")
export function appendKnowledge(brandPack, section) {
  if (!section) return brandPack;
  return brandPack ? `${brandPack}\n\n${section}` : section;
}

/* ------------------- G6 (P1): สมอง AI ต่อสาขา (brain mode) ------------------- */
// ความหมายที่จงใจให้เรียบง่ายที่สุด (ตัดสินใจแล้ว — เขียนไว้ใน HANDOFF ด้วย):
// - shared (ค่าเริ่มต้น)  = สาขาใช้สมองกลาง: Brand Pack กลาง + ความรู้กลาง
// - separate (สมองแยก)   = Brand Pack กลาง "ยังเป็นฐานเสมอ" + ข้อความเสริมของสาขา
//   (addendum) ต่อท้าย + ความรู้ "เฉพาะของสาขานั้นเท่านั้น" (ไม่อ่านความรู้กลาง —
//   แยกจริง จำง่าย: อยากให้สาขาเห็นอะไรก็เอาไปใส่ในคลังของสาขา)
// - ราคา (approved_prices) / รูป / กฎความปลอดภัย / persona ใช้กลางร่วมกันเสมอทุกโหมด
export const BRAIN_MODE_SHARED = "shared";
export const BRAIN_MODE_SEPARATE = "separate";
export const BRAIN_ADDENDUM_MAX = 4000;
export const ADDENDUM_HEADER = "ข้อมูลแนะนำตัว/บุคลิกเสริมของสาขานี้:";

export const brainModeKey = (channelId) => `brain_mode:${channelId}`;
export const brainAddendumKey = (channelId) => `brain_addendum:${channelId}`;

// อ่านโหมดของสาขา — ค่าอื่น/อ่านพัง = shared (fail-safe: พฤติกรรมเดิม)
export function brainModeOf(db, channelId) {
  try {
    return db.getSetting(brainModeKey(String(channelId || "default"))) === BRAIN_MODE_SEPARATE
      ? BRAIN_MODE_SEPARATE
      : BRAIN_MODE_SHARED;
  } catch {
    return BRAIN_MODE_SHARED;
  }
}

// v1.3.4: แยก "brand pack" ออกจาก "ความรู้ของทีมงาน" เป็นคนละก้อน
//
// เหตุ 2026-08-13: ความรู้ถูก appendKnowledge ต่อท้าย brand pack แล้วเดินทางเข้า
// selectRelevantBrandPack ซึ่งจบด้วย .slice(0, 4000) ผลคือเมื่อการ์ดแมตช์ (62% ของเทิร์นจริง)
// ความรู้เหลือ 0% ส่วนเมื่อไม่แมตช์ (38%) ความรู้เข้าครบ 100% — บทสนทนาเดียวจึงถือความรู้
// คนละชุดข้ามเทิร์น และโมเดลกลับคำตัวเองเรื่องส่วนลดอย่างมั่นใจ
//
// ความรู้ที่ทีมงานอนุมัติต้องไม่ผ่านตัวเลือกการ์ดและต้องไม่ถูกตัดกลางตัวอักษรอีก
export function composeKnowledgeForChannel({ db, channelId = "default", maxChars, logger } = {}) {
  const scope = brainModeOf(db, channelId) === BRAIN_MODE_SEPARATE ? String(channelId) : null;
  return knowledgeSectionFromDb(db, { scope, maxChars, logger });
}

// v1.5: addendum เป็นเรื่อง "ข้อความเสริมของช่องทาง" — orthogonal กับโหมดความรู้
// เดิมผูกกับ separate เพราะยังไม่มี use case ที่ต้องการ "คลังกลาง + คำแนะนำเฉพาะช่อง"
// Facebook คือ use case แรก: ความรู้ใช้กลางร่วมกับ LINE (คำสั่งเจ้าของ 2026-08-30 —
// "99% เหมือนเดิม") แต่ต้องมีภาคผนวกสอนเรื่องเฉพาะช่อง (สำนวน quick reply,
// วิธีคุยกับสายหางาน/สร้างรายได้) — channel "default" ไม่มี setting = ว่าง = เดิมทุกตัวอักษร
function channelAddendum(db, channelId) {
  try {
    return String(db.getSetting(brainAddendumKey(String(channelId || "default"))) || "").trim();
  } catch {
    return ""; // อ่านพัง = ไม่มี addendum (แชทต้องเดินต่อ)
  }
}

// ประกอบ brand pack + ความรู้ตามสมองของสาขาลูกค้า — จุดเดียวที่ pipeline/follow-up ใช้
// โหมด legacy channel เดียว ("default", ไม่มี setting) = ผลลัพธ์เดิมทุกตัวอักษร
export function composeBrandPackForChannel({ db, brandPack = "", channelId = "default", maxChars, logger } = {}) {
  let base = brandPack;
  const scope = brainModeOf(db, channelId) === BRAIN_MODE_SEPARATE ? String(channelId) : null;
  const addendum = channelAddendum(db, channelId);
  if (addendum) {
    const block = `${ADDENDUM_HEADER}\n${truncateCodePoints(addendum, BRAIN_ADDENDUM_MAX)}`;
    base = base ? `${base}\n\n${block}` : block;
  }
  return appendKnowledge(base, knowledgeSectionFromDb(db, { scope, maxChars, logger }));
}

// เหมือน composeBrandPackForChannel แต่ "ไม่ต่อความรู้" — ใช้กับเส้นที่ส่งความรู้แยก
export function composeBrandPackOnly({ db, brandPack = "", channelId = "default" } = {}) {
  const addendum = channelAddendum(db, channelId);
  if (!addendum) return brandPack;
  const block = `${ADDENDUM_HEADER}\n${truncateCodePoints(addendum, BRAIN_ADDENDUM_MAX)}`;
  return brandPack ? `${brandPack}\n\n${block}` : block;
}
