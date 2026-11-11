#!/usr/bin/env node
// starter-import.mjs — นำเข้า "ชุดข้อมูลร้าน" (business pack) ของนักเรียนเข้าเอนจิน white-label
//
// อ่านโฟลเดอร์ pack (business.json / products.json / faq.json / knowledge/*.md / images/*)
// แล้วเขียนคลังความรู้ + ตารางราคา ผ่าน "ทางเขียนเดียวกับคอนโซล" (src/brain/writeHook.mjs)
// เพื่อให้ด่านสมอง (G0–G4 / parity / versioned brain) เห็นการนำเข้าครั้งนี้เหมือนเจ้าของกดเอง
//
// กติกาสำคัญ:
//   - ตรวจทุกอย่างก่อน รวบ error ทั้งหมดในรอบเดียว ไม่ผ่าน = exit 1 และไม่เขียนอะไรเลย
//   - ค่าตั้งต้นคือซ้อม (dry-run) ใส่ --apply ถึงจะเขียนจริง
//   - นำเข้าซ้ำได้ (idempotent): key คงที่จาก businessId + product id / ชื่อไฟล์ / hash คำถาม
//   - สินค้าที่หายไปจาก products.json หรือ active:false = ปิดการ์ด (ไม่ลบ) + ถอดราคาออกจาก
//     ตารางราคา (approved_prices ไม่มีคอลัมน์ active — ถอดแถว = ปิดราคา เหมือนปุ่มลบในคอนโซล)
//   - แตะเฉพาะแถวที่ source='starter-import' ของ businessId เดียวกันเท่านั้น
//
// !!! ต้องหยุดเซอร์วิสก่อนรัน --apply !!!
// กติกา "SQLite มีเจ้าของได้โปรเซสเดียว": เซิร์ฟเวอร์ที่รันอยู่ถือฐานไว้ในหน่วยความจำ
// (แคช/สมองเวอร์ชัน live) การเขียนจากโปรเซสอื่นระหว่างนั้น = parity แตก/ข้อมูลไม่ตรงกัน
// codebase ยังไม่มีกลไก lease ที่ตรวจได้ว่ามีโปรเซสถือฐานอยู่ เครื่องมือนี้จึงเตือนเสียงดังเท่านั้น
//
// วิธีใช้:
//   node tools/starter-import.mjs --pack ./my-shop --db ./data/chassis.sqlite
//   node tools/starter-import.mjs --pack ./my-shop --db ./data/chassis.sqlite --apply \
//     --image-dir ./data/img --public-base https://shop.example.com \
//     --catalog-out ./data/image-catalog.json --persona-out ./data/persona.md --env-out ./data/starter.env
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, readFileSync, realpathSync, renameSync, writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.mjs";
import { openBrainReadOnly } from "../src/brain/readonly.mjs";
import { createBrainWriteHook } from "../src/brain/writeHook.mjs";
import { normalizedPriceLabel } from "../src/brain/teach.mjs";
import { knowledgeUsage, KNOWLEDGE_MAX_CHARS } from "../src/knowledgePack.mjs";
import { KNOWLEDGE_CONTENT_MAX, KNOWLEDGE_TITLE_MAX } from "../src/dbExtra.mjs";
import { createConfig, defaultEnvSource } from "../src/config.mjs";
import { loadBannedWords } from "../src/complianceGuard.mjs";
import { loadSafetyRules } from "../src/safetyRouter.mjs";

export const STARTER_SOURCE = "starter-import";
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const NAME_MAX = 60; // = brand.mjs cleanName
const BAD_NAME_CHARS = /[\u0000-\u001F\u007F<>{}`$\\]/u; // = brand.mjs cleanName
const PRICE_LABEL_MAX = 100; // = consoleSettingsApi PRICE_LABEL_MAX
const PRICE_MAX = 10_000_000;
const IMAGE_MAX_BYTES = 10 * 1024 * 1024; // เพดานรูปต้นฉบับของ LINE image message
const LIMITS = Object.freeze({
  text: 4000, short: 300, tone: 500, list: 30, products: 500, faq: 300, aliases: 20, alias: 60,
  unit: 30, category: 60, fileName: 100,
});
const IMAGE_TYPES = Object.freeze({ ".jpg": "jpg", ".jpeg": "jpg", ".png": "png", ".webp": "webp" });
const FEMALE = "female", MALE = "male", NEUTRAL = "neutral";

/* --------------------------------- โหลด pack --------------------------------- */

function readJsonFile(dir, name, { required }, errors) {
  const file = join(dir, name);
  if (!existsSync(file)) {
    if (required) errors.push(`${name}: ไม่พบไฟล์`);
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    errors.push(`${name}: อ่าน JSON ไม่ได้ (${String(err?.message || err).slice(0, 120)})`);
    return undefined;
  }
}

function readKnowledgeFiles(dir, errors) {
  const folder = join(dir, "knowledge");
  if (!existsSync(folder)) return [];
  const out = [];
  for (const name of readdirSync(folder).sort()) {
    if (!name.toLowerCase().endsWith(".md")) continue;
    const where = `knowledge/${name}`;
    const stat = lstatSync(join(folder, name));
    if (!stat.isFile()) { errors.push(`${where}: ต้องเป็นไฟล์ธรรมดา (ไม่รับ symlink/โฟลเดอร์)`); continue; }
    if (name.length > LIMITS.fileName || BAD_NAME_CHARS.test(name)) {
      errors.push(`${where}: ชื่อไฟล์ยาวเกิน ${LIMITS.fileName} ตัวหรือมีอักขระต้องห้าม`);
      continue;
    }
    const text = readFileSync(join(folder, name), "utf8").replace(/^﻿/u, "").replace(/\r\n?/gu, "\n");
    const lines = text.split("\n");
    const at = lines.findIndex((line) => /^# \S/u.test(line));
    if (at < 0) { errors.push(`${where}: ต้องมีหัวข้อบรรทัด "# ชื่อหัวข้อ"`); continue; }
    const title = lines[at].slice(2).trim();
    const content = [...lines.slice(0, at), ...lines.slice(at + 1)].join("\n").trim();
    out.push({ file: name, title, content });
  }
  return out;
}

/** อ่าน pack จากดิสก์ — error ระดับไฟล์ (JSON พัง/ไม่มีไฟล์) อยู่ใน `loadErrors` */
export function loadPack(dir) {
  const root = resolve(String(dir || ""));
  const loadErrors = [];
  if (!dir || !existsSync(root) || !lstatSync(root).isDirectory()) {
    return { dir: root, business: undefined, products: undefined, faq: [], knowledge: [], loadErrors: [`--pack: ไม่พบโฟลเดอร์ ${root}`] };
  }
  const business = readJsonFile(root, "business.json", { required: true }, loadErrors);
  const products = readJsonFile(root, "products.json", { required: true }, loadErrors);
  const faq = readJsonFile(root, "faq.json", { required: false }, loadErrors) ?? [];
  const knowledge = readKnowledgeFiles(root, loadErrors);
  return { dir: root, business, products, faq, knowledge, loadErrors };
}

/* --------------------------------- ตรวจ pack --------------------------------- */

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function checkText(errors, where, value, { required = false, max = LIMITS.text } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) errors.push(`${where}: ต้องมีค่า`);
    return;
  }
  if (typeof value !== "string") { errors.push(`${where}: ต้องเป็นข้อความ`); return; }
  if (required && !value.trim()) errors.push(`${where}: ต้องมีค่า`);
  if (value.length > max) errors.push(`${where}: ยาวเกิน ${max} ตัวอักษร`);
}

function checkName(errors, where, value) {
  checkText(errors, where, value, { required: true, max: NAME_MAX });
  if (typeof value === "string" && BAD_NAME_CHARS.test(value)) {
    errors.push(`${where}: มีอักขระต้องห้าม (ขึ้นบรรทัดใหม่ < > { } \` $ \\)`);
  }
}

function checkList(errors, where, value, { max = LIMITS.list, itemMax = LIMITS.short } = {}) {
  if (value === undefined) return;
  if (!Array.isArray(value)) { errors.push(`${where}: ต้องเป็น array`); return; }
  if (value.length > max) errors.push(`${where}: มีได้ไม่เกิน ${max} รายการ`);
  value.forEach((item, i) => checkText(errors, `${where}[${i}]`, item, { required: true, max: itemMax }));
}

function validateBusiness(errors, b) {
  if (!isObj(b)) { errors.push("business.json: ต้องเป็น object"); return; }
  if (typeof b.businessId !== "string" || !SLUG_RE.test(b.businessId)) {
    errors.push("business.json.businessId: ต้องเป็น slug ตัวเล็ก a-z 0-9 และ - (ยาวไม่เกิน 64 ขึ้นต้นด้วยตัวอักษร/ตัวเลข)");
  }
  checkName(errors, "business.json.businessName", b.businessName);
  checkName(errors, "business.json.agentName", b.agentName);
  if (b.ownerName !== undefined && b.ownerName !== "") checkName(errors, "business.json.ownerName", b.ownerName);
  if (b.agentGender !== undefined && ![FEMALE, MALE, NEUTRAL].includes(b.agentGender)) {
    errors.push("business.json.agentGender: ต้องเป็น female, male หรือ neutral");
  }
  checkText(errors, "business.json.businessType", b.businessType, { max: LIMITS.category });
  checkText(errors, "business.json.tone", b.tone, { max: LIMITS.tone });
  checkText(errors, "business.json.about", b.about);
  for (const [group, fields] of [
    ["contact", ["phone", "lineId", "hours", "address", "website"]],
    ["shipping", ["areas", "fee", "days"]],
    ["policies", ["returns", "warranty", "other"]],
    ["payment", ["notes"]],
  ]) {
    if (b[group] === undefined) continue;
    if (!isObj(b[group])) { errors.push(`business.json.${group}: ต้องเป็น object`); continue; }
    for (const f of fields) checkText(errors, `business.json.${group}.${f}`, b[group][f], { max: LIMITS.short * 3 });
  }
  if (isObj(b.payment)) checkList(errors, "business.json.payment.methods", b.payment.methods, { itemMax: LIMITS.category });
  checkList(errors, "business.json.handoffRules", b.handoffRules);
  checkList(errors, "business.json.forbidden", b.forbidden);
}

/** แปลง path รูปให้เป็นไฟล์จริงข้างใน pack — คืน null พร้อม error เมื่อไม่ผ่าน */
function resolvePackImage(errors, dir, where, value) {
  if (typeof value !== "string" || !value.trim()) { errors.push(`${where}: ต้องเป็น path ของรูป`); return null; }
  if (isAbsolute(value) || value.includes("\0") || value.split(/[\\/]/u).includes("..")) {
    errors.push(`${where}: path ต้องอยู่ในโฟลเดอร์ pack (ห้าม .. หรือ path เต็ม)`);
    return null;
  }
  const ext = extname(value).toLowerCase();
  if (!IMAGE_TYPES[ext]) { errors.push(`${where}: รับเฉพาะไฟล์ .jpg .jpeg .png .webp`); return null; }
  const file = resolve(dir, value);
  if (!existsSync(file)) { errors.push(`${where}: ไม่พบไฟล์ ${value}`); return null; }
  let real;
  try { real = realpathSync(file); } catch { errors.push(`${where}: อ่านไฟล์ไม่ได้`); return null; }
  const rel = relative(realpathSync(dir), real);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    errors.push(`${where}: ไฟล์ต้องอยู่ในโฟลเดอร์ pack (symlink ชี้ออกนอก pack ไม่ได้)`);
    return null;
  }
  const stat = lstatSync(real);
  if (!stat.isFile()) { errors.push(`${where}: ต้องเป็นไฟล์`); return null; }
  if (stat.size > IMAGE_MAX_BYTES) { errors.push(`${where}: ใหญ่เกิน 10MB`); return null; }
  const type = IMAGE_TYPES[ext];
  if (sniffImage(readFileSync(real).subarray(0, 12)) !== type) {
    errors.push(`${where}: เนื้อไฟล์ไม่ใช่รูป ${type} ตามนามสกุล`);
    return null;
  }
  return { source: real, type, rel: value };
}

function sniffImage(head) {
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return "";
}

function validateProducts(errors, pack) {
  const list = pack.products;
  const images = new Map();
  if (list === undefined) return images;
  if (!Array.isArray(list)) { errors.push("products.json: ต้องเป็น array"); return images; }
  if (list.length > LIMITS.products) errors.push(`products.json: มีได้ไม่เกิน ${LIMITS.products} รายการ`);
  const ids = new Set();
  const labels = new Map();
  list.forEach((p, i) => {
    const at = `products.json[${i}]`;
    if (!isObj(p)) { errors.push(`${at}: ต้องเป็น object`); return; }
    if (typeof p.id !== "string" || !SLUG_RE.test(p.id)) errors.push(`${at}.id: ต้องเป็น slug ตัวเล็ก a-z 0-9 และ -`);
    else if (ids.has(p.id)) errors.push(`${at}.id: "${p.id}" ซ้ำกับสินค้าก่อนหน้า`);
    else ids.add(p.id);
    checkText(errors, `${at}.name`, p.name, { required: true, max: PRICE_LABEL_MAX });
    if (typeof p.name === "string" && p.name.trim()) {
      const norm = normalizedPriceLabel(p.name);
      if (labels.has(norm)) errors.push(`${at}.name: ชื่อ "${p.name}" ซ้ำกับ products.json[${labels.get(norm)}] (ตารางราคาแยกด้วยชื่อ)`);
      else labels.set(norm, i);
    }
    // price: null = ไม่มีราคาตายตัว (ทีมประเมิน) — ไม่เข้าตารางราคา AI จึงบอกราคาไม่ได้และส่งให้ทีม
    if (p.price === null || p.price === undefined) {
      // ok — แผนนำเข้าแสดงสินค้านี้ว่า "ไม่มีราคาตายตัว"
    } else if (typeof p.price !== "number" || !Number.isFinite(p.price) || p.price < 0) {
      errors.push(`${at}.price: ต้องเป็นตัวเลขมากกว่าหรือเท่ากับ 0 (ไม่มีราคาตายตัวใส่ null)`);
    } else if (p.price > PRICE_MAX) errors.push(`${at}.price: เกิน ${PRICE_MAX.toLocaleString("en-US")}`);
    checkText(errors, `${at}.unit`, p.unit, { max: LIMITS.unit });
    checkText(errors, `${at}.category`, p.category, { max: LIMITS.category });
    checkText(errors, `${at}.description`, p.description);
    checkList(errors, `${at}.aliases`, p.aliases, { max: LIMITS.aliases, itemMax: LIMITS.alias });
    if (p.active !== undefined && typeof p.active !== "boolean") errors.push(`${at}.active: ต้องเป็น true หรือ false`);
    if (p.image !== undefined && p.image !== "") {
      const img = resolvePackImage(errors, pack.dir, `${at}.image`, p.image);
      if (img && typeof p.id === "string") images.set(p.id, img);
    }
  });
  return images;
}

function validateFaq(errors, faq) {
  if (!Array.isArray(faq)) { errors.push("faq.json: ต้องเป็น array"); return; }
  if (faq.length > LIMITS.faq) errors.push(`faq.json: มีได้ไม่เกิน ${LIMITS.faq} ข้อ`);
  const seen = new Map();
  faq.forEach((item, i) => {
    const at = `faq.json[${i}]`;
    if (!isObj(item)) { errors.push(`${at}: ต้องเป็น object`); return; }
    checkText(errors, `${at}.question`, item.question, { required: true, max: LIMITS.short });
    checkText(errors, `${at}.answer`, item.answer, { required: true });
    if (typeof item.question === "string" && item.question.trim()) {
      const key = faqHash(item.question);
      if (seen.has(key)) errors.push(`${at}.question: ซ้ำกับ faq.json[${seen.get(key)}]`);
      else seen.set(key, i);
    }
  });
}

function validateKnowledge(errors, files) {
  for (const k of files) {
    const at = `knowledge/${k.file}`;
    if (k.title.length > KNOWLEDGE_TITLE_MAX) errors.push(`${at}: หัวข้อยาวเกิน ${KNOWLEDGE_TITLE_MAX} ตัวอักษร`);
    if (!k.content) errors.push(`${at}: ไม่มีเนื้อหาใต้หัวข้อ`);
    if (k.content.length > KNOWLEDGE_CONTENT_MAX) errors.push(`${at}: เนื้อหายาวเกิน ${KNOWLEDGE_CONTENT_MAX} ตัวอักษร`);
  }
}

/** ตรวจทั้ง pack — คืน { errors, images } (images: product id -> ไฟล์รูปที่ตรวจแล้ว) */
export function validatePack(pack) {
  const errors = [...(pack.loadErrors ?? [])];
  if (pack.business !== undefined) validateBusiness(errors, pack.business);
  const images = validateProducts(errors, pack);
  validateFaq(errors, pack.faq ?? []);
  validateKnowledge(errors, pack.knowledge ?? []);
  return { errors, images };
}

/* ------------------------------ การ์ดที่อยากได้ ------------------------------ */

export function faqHash(question) {
  const norm = String(question).normalize("NFC").trim().replace(/\s+/gu, " ").toLowerCase();
  return createHash("sha256").update(norm).digest("hex").slice(0, 16);
}

const baht = (n) => `${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })} บาท`;
const lines = (...parts) => parts.filter((p) => p !== null && p !== undefined && String(p).trim() !== "").join("\n");
const labeled = (label, value) => (value === undefined || value === null || String(value).trim() === "" ? null : `${label}: ${String(value).trim()}`);

function productContent(p, image) {
  return lines(
    labeled("สินค้า", p.name),
    labeled("รหัสสินค้า", p.id),
    p.price === null || p.price === undefined
      ? "ราคา: ไม่มีราคาตายตัว ทีมงานประเมินให้ (ห้ามบอกตัวเลขเอง ส่งต่อให้ทีม)"
      : p.price === 0 ? "ราคา: ฟรี" : `ราคา: ${baht(p.price)}${p.unit ? ` / ${p.unit}` : ""}`,
    labeled("หมวด", p.category),
    Array.isArray(p.aliases) && p.aliases.length ? `ชื่อที่ลูกค้าอาจเรียก: ${p.aliases.join(", ")}` : null,
    labeled("รายละเอียด", p.description),
    image && image.type !== "webp" ? `มีรูปสินค้า (รหัสรูป ${p.id})` : null,
  );
}

function businessContent(b) {
  const c = isObj(b.contact) ? b.contact : {};
  const pay = isObj(b.payment) ? b.payment : {};
  const ship = isObj(b.shipping) ? b.shipping : {};
  const pol = isObj(b.policies) ? b.policies : {};
  return lines(
    labeled("ชื่อร้าน", b.businessName),
    labeled("ประเภทธุรกิจ", b.businessType),
    labeled("เกี่ยวกับร้าน", b.about),
    labeled("โทร", c.phone), labeled("LINE ID", c.lineId), labeled("เวลาทำการ", c.hours),
    labeled("ที่อยู่", c.address), labeled("เว็บไซต์", c.website),
    Array.isArray(pay.methods) && pay.methods.length ? `ช่องทางชำระเงิน: ${pay.methods.join(", ")}` : null,
    labeled("หมายเหตุการชำระเงิน", pay.notes),
    labeled("พื้นที่จัดส่ง", ship.areas), labeled("ค่าจัดส่ง", ship.fee), labeled("ระยะเวลาจัดส่ง", ship.days),
    labeled("การคืนสินค้า", pol.returns), labeled("การรับประกัน", pol.warranty), labeled("นโยบายอื่น", pol.other),
  ) || `ชื่อร้าน: ${b.businessName}`;
}

/** การ์ดที่ pack นี้ต้องการให้ "เปิดอยู่" — คีย์คงที่ข้ามรอบนำเข้า */
export function desiredCards(pack, images = new Map()) {
  const b = pack.business;
  const id = b.businessId;
  const cards = [{
    key: `${id}:business`, kind: "business",
    title: `ข้อมูลร้าน ${b.businessName}`.slice(0, KNOWLEDGE_TITLE_MAX), content: businessContent(b), priceLabel: null,
  }];
  for (const p of pack.products ?? []) {
    if (p.active === false) continue;
    cards.push({
      key: `${id}:product:${p.id}`, kind: "product", productId: p.id,
      title: `สินค้า: ${p.name}`.slice(0, KNOWLEDGE_TITLE_MAX), content: productContent(p, images.get(p.id)),
      priceLabel: p.price > 0 ? p.name.trim() : null, priceAmount: p.price,
    });
  }
  for (const f of pack.faq ?? []) {
    cards.push({
      key: `${id}:faq:${faqHash(f.question)}`, kind: "faq",
      title: `คำถามที่พบบ่อย: ${f.question.trim()}`.slice(0, KNOWLEDGE_TITLE_MAX),
      content: lines(`ถาม: ${f.question.trim()}`, `ตอบ: ${f.answer.trim()}`), priceLabel: null,
    });
  }
  for (const k of pack.knowledge ?? []) {
    cards.push({ key: `${id}:knowledge:${k.file}`, kind: "knowledge", title: k.title, content: k.content, priceLabel: null });
  }
  return cards;
}

/* ----------------------------------- แผน ----------------------------------- */

function starterMeta(row) {
  try {
    const prov = JSON.parse(String(row.provenance_json ?? "{}"));
    return isObj(prov?.starterImport) ? { prov, meta: prov.starterImport } : null;
  } catch { return null; }
}

function provenanceFor(existingProv, card, businessId) {
  const base = isObj(existingProv) ? existingProv : {};
  return {
    ...base,
    starterImport: { businessId, key: card.key, kind: card.kind, priceLabel: card.priceLabel ?? null },
  };
}

/** เทียบ pack กับฐาน -> แผนที่ applyImport จะทำ (ไม่เขียนอะไร) */
export function planImport(db, pack, images = new Map()) {
  const businessId = pack.business.businessId;
  const errors = [];
  const warnings = [];
  const owned = new Map();
  for (const row of db.listKnowledge()) {
    if (row.source !== STARTER_SOURCE) continue;
    const found = starterMeta(row);
    if (!found || found.meta.businessId !== businessId || owned.has(found.meta.key)) continue;
    owned.set(found.meta.key, { row, prov: found.prov, meta: found.meta });
  }
  const cards = { add: [], update: [], deactivate: [], unchanged: 0 };
  const desired = desiredCards(pack, images);
  const desiredKeys = new Set(desired.map((c) => c.key));
  for (const card of desired) {
    const have = owned.get(card.key);
    const provenance = provenanceFor(have?.prov, card, businessId);
    if (!have) { cards.add.push({ ...card, provenance }); continue; }
    const same = have.row.title === card.title && have.row.content === card.content && have.row.active === 1
      && (have.meta.priceLabel ?? null) === (card.priceLabel ?? null) && have.meta.kind === card.kind;
    if (same) cards.unchanged += 1;
    else cards.update.push({ ...card, id: have.row.id, provenance });
  }
  for (const [key, have] of owned) {
    if (desiredKeys.has(key)) continue;
    if (have.row.active !== 1 && (have.meta.priceLabel ?? null) === null) { cards.unchanged += 1; continue; }
    cards.deactivate.push({
      id: have.row.id, key, title: have.row.title,
      provenance: { ...have.prov, starterImport: { ...have.meta, priceLabel: null } },
    });
  }

  // ราคา: แถวที่ "เป็นของเรา" = label ที่การ์ดสินค้าของ starter-import บันทึกไว้
  const ownedLabels = new Set([...owned.values()].map((h) => h.meta.priceLabel).filter(Boolean));
  const current = new Map(db.approvedPrices().map((r) => [r.label, Number(r.amount)]));
  const prices = { add: [], update: [], remove: [], unchanged: 0 };
  const wanted = new Map(desired.filter((c) => c.priceLabel).map((c) => [c.priceLabel, c.priceAmount]));
  for (const [label, amount] of wanted) {
    if (current.has(label)) {
      if (!ownedLabels.has(label)) {
        errors.push(`products.json: ราคา "${label}" มีอยู่แล้วในตารางราคา (ไม่ได้มาจาก starter-import) — ลบหรือเปลี่ยนชื่อในคอนโซลก่อน`);
      } else if (current.get(label) !== amount) prices.update.push({ label, from: current.get(label), amount });
      else prices.unchanged += 1;
      continue;
    }
    const clash = [...current.keys()].find((l) => normalizedPriceLabel(l) === normalizedPriceLabel(label) && !ownedLabels.has(l));
    if (clash) errors.push(`products.json: ชื่อ "${label}" ชนกับราคาเดิม "${clash}" (ต่างกันแค่ช่องว่าง/ตัวพิมพ์)`);
    else prices.add.push({ label, amount });
  }
  for (const label of ownedLabels) {
    if (!wanted.has(label) && current.has(label)) prices.remove.push({ label, amount: current.get(label) });
  }

  // เพดานคลังความรู้: กติกาเดียวกับคอนโซล (เกินได้เฉพาะเมื่อไม่ทำให้แย่ลง)
  const changedIds = new Set([...cards.update, ...cards.deactivate].map((c) => c.id));
  const before = db.listActiveKnowledge(null);
  const after = [
    ...before.filter((r) => !changedIds.has(r.id)),
    ...cards.update, ...cards.add,
  ];
  const usageAfter = knowledgeUsage(after).totalChars;
  if (usageAfter > KNOWLEDGE_MAX_CHARS && usageAfter > knowledgeUsage(before).totalChars) {
    errors.push(`คลังความรู้จะเต็ม (${usageAfter.toLocaleString("en-US")} จาก ${KNOWLEDGE_MAX_CHARS.toLocaleString("en-US")} ตัวอักษร) — ย่อคำอธิบาย/FAQ ก่อน`);
  }
  for (const [pid, img] of images) {
    if (img.type === "webp") warnings.push(`products.json (${pid}): รูป webp ส่งผ่าน LINE/หน้า /img ไม่ได้ — ไม่ใส่ในแคตตาล็อก แปลงเป็น jpg/png ก่อน`);
  }
  const changes = cards.add.length + cards.update.length + cards.deactivate.length
    + prices.add.length + prices.update.length + prices.remove.length;
  return { businessId, cards, prices, errors, warnings, changes, knowledgeChars: usageAfter };
}

/* ---------------------------------- เขียน ---------------------------------- */

const STARTER_OPERATOR = Object.freeze({ username: STARTER_SOURCE, role: "owner" });

/**
 * เขียนแผนผ่าน brain write hook ตัวเดียวกับคอนโซล — การนำเข้าทั้งก้อนเป็น "หนึ่งรุ่นสมอง"
 * (แฟล็ก KNOWLEDGE_VERSIONED ปิด = ทางเดิมล้วนในธุรกรรมเดียว เหมือนคอนโซล)
 */
export function applyImport(db, pack, images, { config = {}, logger = console, bannedWords = null, safetyRules = null, now } = {}) {
  const plan = planImport(db, pack, images);
  if (plan.errors.length) return { ok: false, plan, error: plan.errors.join("\n") };
  if (plan.changes === 0) return { ok: true, outcome: "unchanged", plan };
  const hook = createBrainWriteHook({ db, config, logger, bannedWords, safetyRules, ...(now ? { now } : {}) });
  const by = STARTER_SOURCE;
  const result = hook.apply({
    kind: "knowledge_edit",
    operator: STARTER_OPERATOR,
    username: by,
    audit: {
      action: "starter_import", target: plan.businessId,
      detail: `การ์ด +${plan.cards.add.length} ~${plan.cards.update.length} ปิด${plan.cards.deactivate.length} · ราคา +${plan.prices.add.length} ~${plan.prices.update.length} ถอด${plan.prices.remove.length}`,
    },
    apply: () => {
      for (const c of plan.cards.add) {
        db.addKnowledge({ title: c.title, content: c.content, updatedBy: by, source: STARTER_SOURCE, provenance: c.provenance });
      }
      for (const c of plan.cards.update) {
        db.updateKnowledge(c.id, { title: c.title, content: c.content, active: true, updatedBy: by, provenance: c.provenance });
      }
      for (const c of plan.cards.deactivate) {
        db.updateKnowledge(c.id, { active: false, updatedBy: by, provenance: c.provenance });
      }
      for (const p of [...plan.prices.add, ...plan.prices.update]) db.setApprovedPrice(p.label, p.amount);
      for (const p of plan.prices.remove) db.deleteApprovedPrice(p.label);
      return plan.changes;
    },
  });
  if (!result.ok) return { ok: false, plan, outcome: result.outcome, error: result.error || "ด่านสมองไม่ผ่าน" };
  return { ok: true, outcome: result.outcome, versionId: result.versionId, seq: result.seq, plan };
}

/* --------------------------------- ไฟล์ขาออก --------------------------------- */

function writeAtomic(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

const imageName = (pid, img) => `${pid}.${img.type}`;

export function catalogFor(pack, images, publicBase) {
  const base = String(publicBase).replace(/\/+$/u, "");
  return (pack.products ?? [])
    .filter((p) => p.active !== false && images.has(p.id) && images.get(p.id).type !== "webp")
    .map((p) => ({ key: p.id, url: `${base}/img/${imageName(p.id, images.get(p.id))}`, description: p.name }));
}

const PARTICLES = Object.freeze({
  [FEMALE]: "เป็นผู้หญิง ลงท้ายด้วย ค่ะ (บอกเล่า) / คะ (คำถาม) / นะคะ ตามธรรมชาติ ไม่ยัดทุกประโยค ห้ามใช้ ครับ เด็ดขาด",
  [MALE]: "เป็นผู้ชาย ลงท้ายด้วย ครับ / นะครับ ตามธรรมชาติ ไม่ยัดทุกประโยค ห้ามใช้ ค่ะ/คะ เด็ดขาด",
  [NEUTRAL]: "ใช้ภาษาสุภาพที่ไม่ระบุเพศ ไม่ต้องใส่ ครับ/ค่ะ ทุกประโยค (ลงท้ายแบบกลาง ๆ เช่น นะ / ได้เลย) ถ้าจำเป็นต้องใช้ให้เลือกแบบเดียวแล้วคงที่ตลอดบทสนทนา ห้ามสลับ ครับ กับ ค่ะ",
});

/** persona markdown จาก business.json — รูปแบบเดียวกับ config/persona.example.md ไม่มีชื่อแบรนด์ของใคร */
export function personaMarkdown(b) {
  const gender = b.agentGender || NEUTRAL;
  const bullet = (items) => items.map((x) => `- ${String(x).trim()}`).join("\n");
  return [
    `# Persona — ${b.agentName} แอดมินของ ${b.businessName}`,
    "",
    `คุณชื่อ ${b.agentName} เป็นผู้ช่วย AI ตอบแชทลูกค้าของ ${b.businessName}${b.businessType ? ` (${b.businessType})` : ""} ด้วยภาษาไทยแบบคนจริง`,
    ...(b.about ? ["", `เกี่ยวกับร้าน: ${b.about.trim()}`] : []),
    "",
    "นิสัยการตอบ:",
    "",
    bullet([
      PARTICLES[gender],
      b.tone ? `น้ำเสียง: ${b.tone.trim()}` : "สุภาพ อบอุ่น เป็นกันเอง",
      "ตอบสั้นกระชับแบบแชท ไม่ใช่เรียงความ ไม่ใช้หัวข้อ ไม่ใช้ bullet ไม่ใช้ markdown",
      "ถามกลับได้ครั้งละ 1 คำถามเท่านั้น เมื่อข้อมูลไม่พอ",
      "ไม่กดดันการขาย ไม่ปิดท้ายทุกข้อความด้วยประโยคเสนอบริการ",
    ]),
    "",
    "กติกาที่ห้ามละเมิด (ระบบมี guard ซ้ำอีกชั้น แต่ให้ยึดตั้งแต่ร่าง):",
    "",
    bullet([
      "ราคาใช้จากตารางราคาที่อนุมัติแล้วเท่านั้น ห้ามแต่งตัวเลขราคา ส่วนลด หรือคำนวณราคาใหม่เอง ถ้าไม่มีให้บอกว่าขอเช็คกับทีมก่อน",
      `ถ้าลูกค้าถามว่าเป็นบอทไหม เป็น AI ไหม หรือเป็นคนจริงไหม ให้ตอบตามจริงว่าเป็นผู้ช่วย AI ของ ${b.businessName} และเสนอต่อแอดมินคนจริงให้`,
      "ไม่แน่ใจหรือไม่มีข้อมูล ให้บอกตรง ๆ แล้วส่งต่อทีมงาน ห้ามเดา",
      "เรื่องเงิน สลิปโอน ใบเสร็จ การคืนเงิน ให้ส่งต่อทีมงานคนจริงเสมอ",
    ]),
    ...(Array.isArray(b.handoffRules) && b.handoffRules.length ? ["", "ส่งต่อทีมงานทันทีเมื่อ:", "", bullet(b.handoffRules)] : []),
    ...(Array.isArray(b.forbidden) && b.forbidden.length ? ["", "ห้ามพูดหรือทำ:", "", bullet(b.forbidden)] : []),
    "",
  ].join("\n");
}

function envLine(key, value) {
  const text = String(value ?? "");
  if (/[\r\n\0]/u.test(text)) throw new Error(`--env-out: ค่า ${key} มีขึ้นบรรทัดใหม่ — เขียนเป็นไฟล์ env ไม่ได้`);
  if (text !== text.trim()) throw new Error(`--env-out: ค่า ${key} มีช่องว่างหัว/ท้าย (ตัว parser ของเอนจินตัดทิ้ง)`);
  return `${key}=${text}`;
}

/** env snippet — ค่าถูกอ่านตามตัวอักษร (src/config.mjs parseEnvFile) จึงไม่ใส่เครื่องหมายคำพูด */
export function envSnippet(b, { personaOut = null, catalogOut = null, imageDir = null } = {}) {
  const rows = [
    ["BRAND_AGENT_NAME", b.agentName], ["BRAND_OWNER_NAME", b.ownerName ?? ""],
    ["BRAND_BUSINESS_NAME", b.businessName], ["BUSINESS_ID", b.businessId], ["BUSINESS_PROFILE", "generic"],
    ["PERSONA_PARTICLES", b.agentGender === FEMALE ? "female" : ""],
    ["CONSOLE_BRAND_NAME", b.businessName], ["CONSOLE_BRAND_AGENT", b.agentName], ["CONSOLE_BRAND_THEME", "starter"],
    ...(personaOut ? [["PERSONA_FILE", resolve(personaOut)]] : []),
    ...(catalogOut ? [["IMAGE_CATALOG_FILE", resolve(catalogOut)]] : []),
    ...(imageDir ? [["IMAGE_DIR", resolve(imageDir)]] : []),
  ];
  return `# starter-import: ${b.businessId} — ค่าอ่านตามตัวอักษร ห้ามใส่เครื่องหมายคำพูด\n${rows.map(([k, v]) => envLine(k, v)).join("\n")}\n`;
}

/** เขียนไฟล์ขาออก (เรียกหลังเขียนฐานสำเร็จเท่านั้น) — คืนรายการไฟล์ที่เขียน */
export function writeOutputs(pack, images, opts) {
  const written = [];
  const b = pack.business;
  const env = opts.envOut ? envSnippet(b, opts) : null; // ตรวจค่าก่อนเขียนอะไรสักไฟล์
  if (opts.imageDir) {
    mkdirSync(opts.imageDir, { recursive: true });
    for (const p of pack.products ?? []) {
      const img = images.get(p.id);
      if (p.active === false || !img || img.type === "webp") continue;
      const target = join(opts.imageDir, imageName(p.id, img));
      copyFileSync(img.source, target);
      written.push(target);
    }
  }
  if (opts.catalogOut) {
    writeAtomic(opts.catalogOut, `${JSON.stringify(catalogFor(pack, images, opts.publicBase), null, 2)}\n`);
    written.push(opts.catalogOut);
  }
  if (opts.personaOut) { writeAtomic(opts.personaOut, personaMarkdown(b)); written.push(opts.personaOut); }
  if (env) { writeAtomic(opts.envOut, env); written.push(opts.envOut); }
  return written;
}

/* ----------------------------------- CLI ----------------------------------- */

export const USAGE = `ใช้: node tools/starter-import.mjs --pack <dir> --db <sqlite> [--apply]
         [--image-dir <dir>] [--public-base <https://…>] [--catalog-out <file>]
         [--persona-out <file>] [--env-out <file>]
  ค่าตั้งต้น = ซ้อม (ไม่เขียนอะไร) · --apply = เขียนจริง (หยุดเซอร์วิสก่อนเสมอ)
  --catalog-out ต้องมี --public-base (https:// หรือ http://localhost สำหรับทดสอบ)`;

export function parseArgs(argv) {
  const flags = new Set(["--apply", "--help", "-h"]);
  const valued = ["--pack", "--db", "--image-dir", "--public-base", "--persona-out", "--env-out", "--catalog-out"];
  const out = { apply: false, help: false, errors: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (flags.has(a)) { if (a === "--apply") out.apply = true; else out.help = true; continue; }
    if (valued.includes(a)) {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) out.errors.push(`${a}: ต้องตามด้วยค่า`);
      else { out[a.slice(2).replace(/-([a-z])/gu, (_, c) => c.toUpperCase())] = v; i += 1; }
      continue;
    }
    out.errors.push(`ไม่รู้จักตัวเลือก ${a}`);
  }
  if (out.publicBase !== undefined) {
    let url = null;
    try { url = new URL(out.publicBase); } catch { url = null; }
    const local = url && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
    if (!url || (url.protocol !== "https:" && !local) || url.search || url.hash) {
      out.errors.push("--public-base: ต้องเป็น https://… (หรือ http://localhost สำหรับทดสอบ) ไม่มี ? หรือ #");
    }
  }
  if (out.catalogOut && !out.publicBase) out.errors.push("--catalog-out: ต้องระบุ --public-base ด้วย");
  return out;
}

function printPlan(out, plan, pack, images, args) {
  const c = plan.cards, p = plan.prices;
  out(`[starter-import] ${args.apply ? "เขียนจริง" : "ซ้อม (ยังไม่เขียนอะไร)"} — ร้าน ${pack.business.businessName} (${plan.businessId})`);
  out(`  การ์ดความรู้: เพิ่ม ${c.add.length} · แก้ ${c.update.length} · ปิด ${c.deactivate.length} · เหมือนเดิม ${c.unchanged}`);
  for (const x of c.add) out(`    + ${x.title}`);
  for (const x of c.update) out(`    ~ ${x.title}`);
  for (const x of c.deactivate) out(`    - ${x.title} (ปิด ไม่ลบ)`);
  out(`  ตารางราคา: เพิ่ม ${p.add.length} · แก้ ${p.update.length} · ถอด ${p.remove.length} · เหมือนเดิม ${p.unchanged}`);
  for (const x of p.add) out(`    + ${x.label} = ${baht(x.amount)}`);
  for (const x of p.update) out(`    ~ ${x.label}: ${baht(x.from)} -> ${baht(x.amount)}`);
  for (const x of p.remove) out(`    - ${x.label} (${baht(x.amount)})`);
  out(`  รูปสินค้า: ${images.size} ไฟล์ · คลังความรู้หลังนำเข้า ~${plan.knowledgeChars.toLocaleString("en-US")}/${KNOWLEDGE_MAX_CHARS.toLocaleString("en-US")} ตัวอักษร`);
  const outputs = [
    args.imageDir && `คัดลอกรูปไป ${args.imageDir}`, args.catalogOut && `แคตตาล็อกรูป ${args.catalogOut}`,
    args.personaOut && `persona ${args.personaOut}`, args.envOut && `env ${args.envOut}`,
  ].filter(Boolean);
  if (outputs.length) out(`  ไฟล์ขาออก${args.apply ? "" : " (จะเขียนเมื่อ --apply)"}: ${outputs.join(" · ")}`);
  for (const w of plan.warnings) out(`  [เตือน] ${w}`);
}

/**
 * ซ้อมเต็มรูปแบบ: คัดลอกฐานด้วย VACUUM INTO (ใช้ได้กับการเปิดแบบอ่านอย่างเดียว) ไปไฟล์ชั่วคราว
 * แล้วเดินทางเขียนจริง + ด่านสมองบนสำเนา — ฐานจริงไม่ถูกแตะแม้แต่ไบต์เดียว
 */
export function rehearseImport(dbFile, pack, images, applyOpts) {
  const dir = mkdtempSync(join(tmpdir(), "starter-import-rehearse-"));
  const copy = join(dir, "rehearse.sqlite");
  try {
    if (existsSync(dbFile)) {
      const src = openBrainReadOnly(dbFile);
      try { src.raw.prepare("VACUUM INTO ?").run(copy); } finally { src.raw.close(); }
    }
    const db = openDb({ file: copy });
    try { return applyImport(db, pack, images, applyOpts); } finally { db.close(); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function applyDeps(deps, err) {
  const config = deps.config ?? createConfig(defaultEnvSource());
  const logger = deps.logger ?? { log() {}, debug() {}, warn: (s) => err(String(s)), error: (s) => err(String(s)) };
  return {
    config, logger,
    bannedWords: deps.bannedWords ?? loadBannedWords(config.bannedWordsFile, { logger }),
    safetyRules: deps.safetyRules ?? loadSafetyRules(config.safetyRulesFile, { logger }),
  };
}

function openForPlan(file, apply) {
  if (apply) return openDb({ file });
  if (!existsSync(file)) {
    return { listKnowledge: () => [], listActiveKnowledge: () => [], approvedPrices: () => [], close() {}, missing: true };
  }
  return openBrainReadOnly(file);
}

/**
 * @param {string[]} argv
 * @param {object} [deps] เทสต์ฉีด config/logger/stdout ได้ — ค่าตั้งต้นอ่าน env ของ instance เหมือนเซิร์ฟเวอร์
 * @returns {number} exit code
 */
export function main(argv = process.argv.slice(2), deps = {}) {
  const out = deps.stdout ?? ((s) => console.log(s));
  const err = deps.stderr ?? ((s) => console.error(s));
  const args = parseArgs(argv);
  if (args.help || (!args.pack && !args.db && !args.errors.length)) { out(USAGE); return args.help ? 0 : 1; }
  if (!args.pack) args.errors.push("--pack: ต้องระบุโฟลเดอร์ pack");
  if (!args.db) args.errors.push("--db: ต้องระบุไฟล์ฐานข้อมูล");
  if (args.errors.length) { for (const e of args.errors) err(`[starter-import] ${e}`); err(USAGE); return 1; }

  const pack = loadPack(args.pack);
  const { errors, images } = validatePack(pack);
  if (errors.length) {
    err(`[starter-import] ตรวจไม่ผ่าน ${errors.length} ข้อ — ยังไม่ได้เขียนอะไร`);
    for (const e of errors) err(`  - ${e}`);
    return 1;
  }
  if (args.apply) {
    err("[starter-import] คำเตือน: ต้องหยุดเซอร์วิสก่อน --apply (SQLite มีเจ้าของได้โปรเซสเดียว) — เครื่องมือนี้ตรวจไม่ได้ว่าเซิร์ฟเวอร์ยังถือฐานอยู่");
  }
  let db;
  try { db = openForPlan(args.db, args.apply); } catch (e) { err(`[starter-import] เปิดฐานไม่ได้: ${e?.message || e}`); return 1; }
  try {
    const plan = planImport(db, pack, images);
    printPlan(out, plan, pack, images, args);
    if (db.missing) out(`  (ยังไม่มีไฟล์ฐาน ${args.db} — --apply จะสร้างให้)`);
    if (plan.errors.length) {
      err(`[starter-import] นำเข้าไม่ได้ ${plan.errors.length} ข้อ — ยังไม่ได้เขียนอะไร`);
      for (const e of plan.errors) err(`  - ${e}`);
      return 1;
    }
    const applyOpts = applyDeps(deps, err);
    if (!args.apply) {
      if (plan.changes > 0) {
        const trial = rehearseImport(args.db, pack, images, applyOpts);
        if (!trial.ok) {
          err(`[starter-import] ซ้อมเขียนบนสำเนาแล้วไม่ผ่าน (${trial.outcome ?? "error"}): ${trial.error}`);
          return 1;
        }
        out(`  ซ้อมเขียนบนสำเนาฐาน: ผ่าน (${trial.outcome})`);
      }
      out("[starter-import] ใส่ --apply เพื่อเขียนจริง");
      return 0;
    }
    const result = applyImport(db, pack, images, applyOpts);
    if (!result.ok) {
      err(`[starter-import] เขียนไม่สำเร็จ (${result.outcome ?? "error"}): ${result.error}`);
      return 1;
    }
    out(`[starter-import] เขียนฐานแล้ว — ผล: ${result.outcome}${result.seq ? ` (รุ่นสมอง ${result.seq})` : ""}`);
    const written = writeOutputs(pack, images, args);
    for (const f of written) out(`  เขียน ${f}`);
    return 0;
  } catch (e) {
    err(`[starter-import] ล้ม: ${e?.message || e}`);
    return 1;
  } finally {
    db.close?.();
  }
}

function isMainModule(metaUrl) {
  try { return realpathSync(process.argv[1]) === fileURLToPath(metaUrl); } catch { return false; }
}

if (isMainModule(import.meta.url)) process.exitCode = main();
