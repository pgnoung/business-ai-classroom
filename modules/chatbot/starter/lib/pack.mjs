// ตรวจ "ข้อมูลร้าน" (โฟลเดอร์ business/) บนเครื่องนักเรียนก่อนอัปโหลด
// ตัวตรวจตัวจริงอยู่บนเซิร์ฟเวอร์ (tools/starter-import.mjs) — ตัวนี้จับเรื่องพื้น ๆ ให้แก้เร็ว
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png"]); // LINE ส่งรูปได้เฉพาะ jpg/png
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

function readJson(dir, name, problems) {
  const file = join(dir, name);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    problems.push(`${name}: อ่าน JSON ไม่ได้ (${err.message})`);
    return undefined;
  }
}

export function checkPack(dir) {
  const problems = [];
  const warnings = [];
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return { ok: false, problems: [`ไม่พบโฟลเดอร์ ${dir}`], warnings, summary: {} };

  const biz = readJson(dir, "business.json", problems);
  if (biz === undefined && !problems.length) problems.push("business.json: ยังไม่มีไฟล์นี้ (ข้อมูลร้าน ชื่อ AI ช่องทางติดต่อ)");
  if (biz) {
    for (const f of ["businessId", "businessName", "agentName", "ownerName"]) {
      if (!String(biz[f] || "").trim()) problems.push(`business.json: ต้องมี ${f}`);
    }
    for (const f of ["businessName", "agentName", "ownerName"]) {
      if (/["'\\$`]/.test(String(biz[f] || ""))) problems.push(`business.json: ${f} ห้ามมีเครื่องหมาย " ' \\ $ \` (ระบบตั้งค่าอ่านไม่ได้) — ตัดออกหรือใช้คำอื่น`);
    }
    if (biz.businessId && !/^[a-z0-9][a-z0-9-]{1,40}$/.test(biz.businessId)) problems.push("business.json: businessId ใช้ a-z 0-9 และ - เท่านั้น เช่น cafe-mali");
    if (biz.agentGender && !["female", "male", "neutral"].includes(biz.agentGender)) problems.push("business.json: agentGender ต้องเป็น female, male หรือ neutral");
    if (biz.agentGender && biz.agentGender !== "female") warnings.push("business.json: ตอนนี้ข้อความสำเร็จรูปบางข้อความของระบบลงท้ายด้วย ค่ะ/คะ — AI แบบผู้ชายจะใช้ ครับ ได้เฉพาะคำตอบที่ AI เขียนเอง");
  }

  const products = readJson(dir, "products.json", problems) ?? [];
  if (!Array.isArray(products)) problems.push("products.json: ต้องเป็นรายการ [ ... ]");
  const ids = new Set();
  let images = 0;
  (Array.isArray(products) ? products : []).forEach((p, i) => {
    const at = `products.json ชิ้นที่ ${i + 1}${p?.name ? ` (${p.name})` : ""}`;
    if (!p || typeof p !== "object") return problems.push(`${at}: รูปแบบไม่ถูก`);
    if (!/^[a-z0-9][a-z0-9-]{0,60}$/.test(String(p.id || ""))) problems.push(`${at}: id ต้องเป็น a-z 0-9 - เช่น latte-hot`);
    else if (ids.has(p.id)) problems.push(`${at}: id ซ้ำกับชิ้นก่อนหน้า`);
    ids.add(p.id);
    if (!String(p.name || "").trim()) problems.push(`${at}: ต้องมี name`);
    if (p.price !== null && p.price !== undefined && !(typeof p.price === "number" && p.price > 0)) {
      problems.push(`${at}: price ต้องเป็นตัวเลขมากกว่า 0 (ไม่มีราคาตายตัวให้ใส่ null)`);
    }
    if (p.price === null || p.price === undefined) warnings.push(`${at}: ไม่มีราคา — AI จะไม่บอกราคาและส่งให้ทีมตอบ`);
    if (p.image) {
      const img = join(dir, p.image);
      if (!existsSync(img)) problems.push(`${at}: ไม่พบรูป ${p.image}`);
      else if (!IMAGE_EXT.has(extname(img).toLowerCase())) problems.push(`${at}: รูปต้องเป็น jpg หรือ png (แปลงไฟล์ webp/heic ก่อน)`);
      else if (statSync(img).size > MAX_IMAGE_BYTES) problems.push(`${at}: รูปใหญ่เกิน 5 MB`);
      else images += 1;
    }
  });

  const faq = readJson(dir, "faq.json", problems) ?? [];
  if (!Array.isArray(faq)) problems.push("faq.json: ต้องเป็นรายการ [ ... ]");
  (Array.isArray(faq) ? faq : []).forEach((q, i) => {
    if (!String(q?.question || "").trim() || !String(q?.answer || "").trim()) problems.push(`faq.json ข้อที่ ${i + 1}: ต้องมีทั้ง question และ answer`);
  });

  const kdir = join(dir, "knowledge");
  const notes = existsSync(kdir) ? readdirSync(kdir).filter((f) => f.endsWith(".md")) : [];
  if (!products.length && !faq.length && !notes.length) problems.push("ยังไม่มีข้อมูลให้ AI ตอบเลย — ใส่สินค้า (products.json) หรือคำถามที่พบบ่อย (faq.json) อย่างน้อยหนึ่งอย่าง");

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    summary: { products: Array.isArray(products) ? products.length : 0, faq: Array.isArray(faq) ? faq.length : 0, notes: notes.length, images },
  };
}
