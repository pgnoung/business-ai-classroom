// showcaseArrival.mjs — ลูกค้ากดปุ่ม "ทักไลน์" จากหน้าเคสหรือหน้ารีวิวบน pngoungacademy.com (19 ต.ค. 2026)
//
// พี่ง้วง: "เคสรีวิว เคส workflow มีปุ่มที่ติดต่อ LINE OA ได้ง่าย ๆ และให้กดปุ๊บ เหมือนเค้าพิมพ์ข้อความมาแล้ว
//          ... พร้อมให้ลูกแพร AI เข้าใจบริบทเรื่องนั้นไว้เลย"
// ปุ่มเปิด https://line.me/R/oaMessage/@pngoung/?<ข้อความ> (รูปแบบลิงก์ตามเอกสาร LINE เดียวกับ identityLinkCodes.mjs)
// ข้อความมีรหัส "เคส WF-<id>" หรือ "รหัส RV-<key>" — ไฟล์นี้แปลงรหัสเป็นบริบทหนึ่งบรรทัดให้พรอมต์ (ทั้งเครื่อง v3 และเครื่องเดิม)
//
// แหล่งข้อมูลเคส: การ์ดความรู้ชื่อมี "รหัสเคสจากหน้าเว็บ" (แก้ในคอนโซลได้ ไม่ต้อง deploy) — บรรทัดละเคส:
//   - WF-<id> | <ชื่อระบบ> | <ธุรกิจ> | <ประโยชน์หนึ่งบรรทัด>            (เคสปกติ)
//   - WF-<id> | <ชื่อระบบ> | <ธุรกิจ> | <ประโยชน์หนึ่งบรรทัด> | เดโม     (หน้าเดโม เช่น clinic/beauty — พี่ง้วง 19 ต.ค.:
//     หน้าเว็บติดป้ายเดโม ไม่อยู่ในกลุ่มที่ลูกแพรส่งเอง แต่ลูกค้าที่กดมาต้องได้บริบท + ข้อห้ามพูดผลการรักษา/รับประกันผล)
// ไม่มีการ์ด/ไม่มีเคสนี้ในการ์ด = ใช้แถวในกลุ่มตัวอย่างระบบของคลังรีวิว ("ธุรกิจ — ประโยชน์") · ไม่มีทั้งคู่ = บริบทกลาง ๆ ไม่เดาชื่อเคส
// แหล่งข้อมูลรีวิว: คลัง "รีวิวนักเรียนจริง" ตัวเดิม (ชื่อ/บทบาทตามคลังเป๊ะ) · ไม่พบ = บอกแค่ว่าดูรีวิวผู้เรียนบนเว็บมา
// ไฟล์นี้เป็นฟังก์ชันบริสุทธิ์ (ไม่อ่าน DB ไม่ยิงเน็ต) · regex ทุกตัวมีเพดาน
import { lineOaMessageUrl } from "./identityLinkCodes.mjs";
import { parseCatalogText, reviewUrlKey } from "./reviewSelection.mjs";
import { SHOWCASE_CLASS_CLAIM, SYSTEM_SHOWCASE_LABEL, arrivalCodesIn, arrivalUrlOf, isSystemShowcase } from "./showcaseCases.mjs";
import { truncateCodePoints } from "./unicodeText.mjs";

export const ARRIVAL_CARD_TITLE_MATCH = "รหัสเคสจากหน้าเว็บ";
export const LINE_OA_ID = "@pngoung";
const CASE_LINE = /^-\s*WF-([a-z0-9-]{2,40})\s*\|([^|\n]{1,80})\|([^|\n]{1,80})\|([^|\n]{1,240})(?:\|\s*(เดโม)\s*)?$/u;
const LIMITS = Object.freeze({ title: 60, business: 60, benefit: 200 });
const clip = (text, n) => truncateCodePoints(String(text || "").replace(/\s+/gu, " ").trim(), n);
const HISTORY_LOOKBACK = 6;

/** แถวเคสจากข้อความการ์ด (บรรทัดที่ไม่ตรงรูปแบบถูกข้าม — ตัวตรวจในคอนโซลคือ validateArrivalCard) */
export function parseArrivalCard(content = "") {
  const rows = new Map();
  for (const line of String(content || "").split("\n")) {
    const m = CASE_LINE.exec(line.trim());
    if (!m || rows.has(m[1])) continue;
    const [title, business, benefit] = [m[2], m[3], m[4]].map((v) => v.trim());
    if (!title || !business || !benefit) continue;
    rows.set(m[1], { id: m[1], title: clip(title, LIMITS.title), business: clip(business, LIMITS.business), benefit: clip(benefit, LIMITS.benefit),
      demo: m[5] === "เดโม" });
  }
  return rows;
}

/** ตรวจการ์ดก่อนบันทึก — คืนรายการข้อความผิดพลาด (ว่าง = ผ่าน) */
export function validateArrivalCard(content = "") {
  const errors = [];
  const seen = new Set();
  let count = 0;
  for (const [i, raw] of String(content || "").split("\n").entries()) {
    const line = raw.trim();
    if (!/^-\s*WF/iu.test(line)) continue;
    count += 1;
    const where = `บรรทัดที่ ${i + 1}`;
    const m = CASE_LINE.exec(line);
    if (!m) { errors.push(`${where}: ต้องเป็น "- WF-<id> | ชื่อระบบ | ธุรกิจ | ประโยชน์" (ต่อท้าย "| เดโม" ได้) — id ตัวเล็ก ตัวเลข ขีด 2–40 ตัว`); continue; }
    if (seen.has(m[1])) errors.push(`${where}: รหัส WF-${m[1]} ซ้ำ`);
    seen.add(m[1]);
    const fields = { title: m[2].trim(), business: m[3].trim(), benefit: m[4].trim() };
    for (const [name, value] of Object.entries(fields)) {
      if (!value) errors.push(`${where}: ช่อง ${name} ว่าง`);
      else if ([...value].length > LIMITS[name]) errors.push(`${where}: ช่อง ${name} ยาวเกิน ${LIMITS[name]} ตัวอักษร`);
    }
    const all = Object.values(fields).join(" ");
    if (/https?:\/\/|www\.|@\w/iu.test(all)) errors.push(`${where}: ห้ามใส่ลิงก์หรือ @ (ลิงก์ของเคสมาจากรหัสเอง)`);
    if (/รีวิว|ลูกค้าจริง|เดโม|demo|สมมติ|สร้างด้วย\s?AI|สร้างโดย\s?AI/iu.test(all)) {
      errors.push(`${where}: ตัวอย่างระบบไม่ใช่รีวิว/ลูกค้าจริง และไม่ใส่คำว่าเดโม/สมมติ/สร้างด้วย AI ในสามช่องแรก (หน้าเดโมใช้ช่องท้าย "| เดโม")`);
    }
    if (m[5] && /หายขาด|ได้ผลจริง|ผลลัพธ์|การันตี|รับประกัน|ฟันตรง|ลดริ้วรอย|หน้าใส|ผิวขาว/u.test(all)) {
      errors.push(`${where}: เคสเดโมห้ามมีคำอ้างผลการรักษา/ผลลัพธ์ (เล่าแค่ว่าระบบช่วยงานเอกสารหรือรายงานแบบไหน)`);
    }
  }
  if (!count) errors.push("ต้องมีอย่างน้อยหนึ่งเคส");
  return errors;
}

function arrivalCardRows({ entries = [], knowledgeText = "" } = {}) {
  const card = (Array.isArray(entries) ? entries : [])
    .find((entry) => String(entry?.title || "").includes(ARRIVAL_CARD_TITLE_MATCH) && entry?.active !== 0);
  return parseArrivalCard(card ? card.content : knowledgeText);
}
function reviewRows({ entries = [], knowledgeText = "" } = {}) {
  const card = (Array.isArray(entries) ? entries : [])
    .find((entry) => String(entry?.title || "").includes("รีวิวนักเรียนจริง") && entry?.active !== 0);
  const rows = card ? parseCatalogText(card.content) : [];
  return rows.length ? rows : parseCatalogText(String(knowledgeText || ""));
}

/** รหัสล่าสุดที่ลูกค้าพิมพ์มา: ข้อความนี้ก่อน แล้วย้อนข้อความลูกค้าไม่เกิน 6 ข้อความ — { code, current } | null */
export function latestArrivalCode({ text = "", history = [] } = {}) {
  const now = arrivalCodesIn(text);
  if (now.length) return { code: now.at(-1), current: true };
  const users = (Array.isArray(history) ? history : []).filter((t) => t?.role === "user").slice(-HISTORY_LOOKBACK);
  for (let i = users.length - 1; i >= 0; i -= 1) {
    const codes = arrivalCodesIn(String(users[i]?.content || ""));
    if (codes.length) return { code: codes.at(-1), current: false };
  }
  return null;
}

/** ข้อมูลของรหัสจากการ์ด/คลัง — { kind, id|key, known, title?, business?, benefit?, who?, section? } */
export function resolveArrival(code, sources = {}) {
  if (code?.kind === "case") {
    const card = arrivalCardRows(sources).get(code.id);
    if (card) return { kind: "case", id: code.id, known: true, ...card };
    const key = reviewUrlKey(arrivalUrlOf(code));
    const row = reviewRows(sources).find((r) => isSystemShowcase(r) && reviewUrlKey(r.url) === key);
    if (row) {
      const [business, ...rest] = String(row.who).split(" — ");
      return { kind: "case", id: code.id, known: true, title: "", business: clip(business, LIMITS.business), benefit: clip(rest.join(" — ") || row.who, LIMITS.benefit) };
    }
    return { kind: "case", id: code.id, known: false };
  }
  if (code?.kind === "review") {
    const key = reviewUrlKey(arrivalUrlOf(code));
    const row = key ? reviewRows(sources).find((r) => r.kind === "testimonial" && reviewUrlKey(r.url) === key) : null;
    return row ? { kind: "review", key: code.key, known: true, who: clip(row.who, 90), section: clip(row.section, 60) }
      : { kind: "review", key: code.key, known: false };
  }
  return null;
}

const CLASS_NOTE = () => (SHOWCASE_CLASS_CLAIM ? ` · ${SHOWCASE_CLASS_CLAIM}` : "");
/**
 * บริบทหนึ่งบรรทัดสำหรับพรอมต์ ("" = ลูกค้าไม่ได้กดมาจากหน้าเว็บ)
 * ข้อความนี้มีรหัส = ตอบรับเรื่องที่เขาดูมา + ชวนเล่าธุรกิจ · รหัสอยู่ในข้อความก่อน ๆ = บริบทเงียบ ๆ ไม่ทวนซ้ำ
 */
export function arrivalNoteFor({ text = "", history = [], entries = [], knowledgeText = "" } = {}) {
  const found = latestArrivalCode({ text, history });
  if (!found) return "";
  const info = resolveArrival(found.code, { entries, knowledgeText });
  if (!info) return "";
  if (info.kind === "case") {
    const what = info.known
      ? `${info.title ? `${info.title} · ` : ""}ธุรกิจ: ${info.business} · ช่วยได้: ${info.benefit}${CLASS_NOTE()}`
        + (info.demo ? " · หน้านี้เป็นระบบเดโมประกอบการสอน: ห้ามพูดผลการรักษา ผลทางการแพทย์หรือความงาม ห้ามรับประกันผลลัพธ์ "
          + "เล่าได้แค่ว่าระบบช่วยจัดงานเอกสาร/รายงานให้ทีมและผู้เชี่ยวชาญตรวจก่อนถึงมือคนไข้ และชวนคุยเรื่องการสร้างระบบในคลาส" : "")
      : "ระบบไม่มีรายละเอียดของเคสนี้ ห้ามเดาชื่อหรือรายละเอียดเคส";
    const head = `ลูกค้ากดปุ่มทักไลน์มาจากหน้า${SYSTEM_SHOWCASE_LABEL} บนเว็บ (เคส WF-${info.id}): ${what}`;
    if (!found.current) return `${head} — ใช้เป็นบริบทเงียบ ๆ ไม่ทวนซ้ำ ไม่ส่งลิงก์หน้านี้กลับ`;
    return `${head} — ตอบรับสั้น ๆ ว่าเห็นว่าสนใจระบบนี้ ถามธุรกิจและงานของเขาที่อยากทำแบบนี้`
      + (SHOWCASE_CLASS_CLAIM ? " แล้วเชื่อมว่าคลาส AI Agent Workflow Automation ได้ลงมือสร้างระบบแนวนี้" : "")
      + ` · ไม่ส่งลิงก์หน้านี้กลับ (เขาเพิ่งดูมา) · เรียกว่า${SYSTEM_SHOWCASE_LABEL} ไม่ใช่รีวิวหรือลูกค้าจริง ไม่แต่งผลลัพธ์`;
  }
  const what = info.known ? `รีวิวของ "${info.who}" (กลุ่ม ${info.section})` : "รีวิวผู้เรียน (ระบบไม่พบรายการนี้ในคลัง ห้ามเดาชื่อผู้รีวิว)";
  const head = `ลูกค้ากดปุ่มทักไลน์มาจากหน้ารีวิวผู้เรียนบนเว็บ (รหัส RV-${info.key}): ${what}`;
  if (!found.current) return `${head} — ใช้เป็นบริบทเงียบ ๆ ไม่ทวนซ้ำ ไม่ส่งรีวิวนี้กลับ`;
  return `${head} — ขอบคุณที่เขาสละเวลาดูรีวิวสั้น ๆ แล้วถามว่าสนใจเรื่องไหนหรือทำธุรกิจอะไร · ไม่ส่งรีวิวนี้กลับ · ไม่แต่งคำพูดหรือผลลัพธ์ของผู้รีวิว`;
}

// ---- ข้อความ/ลิงก์ของปุ่มบนหน้าเว็บ (ให้ทีมเว็บใช้สูตรเดียวกับตัวจับ) ----
/** ข้อความในช่องพิมพ์ของปุ่มหน้าเคส — ไม่ขึ้นต้นด้วย # และไม่มีคำลงท้ายเพศ (ลูกค้าแก้ก่อนส่งได้) */
export function casePrefill(id, title = "") {
  const name = String(title || "").replace(/^ระบบ\s*/u, "").trim();
  return `สนใจระบบ${name ? name : "แบบนี้"} (เคส WF-${id}) อยากทำแบบนี้กับธุรกิจของเรา`;
}
/** ข้อความในช่องพิมพ์ของปุ่มหน้ารีวิว */
export const reviewPrefill = (key) => `ดูรีวิว (รหัส RV-${key}) แล้วสนใจคลาส`;
/** ลิงก์ปุ่ม: https://line.me/R/oaMessage/%40pngoung/?<ข้อความ> (LINE บน iOS/Android เท่านั้น — PC ไม่รองรับ) */
export const lineOaPrefillUrl = (text, basicId = LINE_OA_ID) => lineOaMessageUrl(basicId, text);
