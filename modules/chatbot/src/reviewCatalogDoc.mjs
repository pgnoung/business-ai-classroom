// reviewCatalogDoc.mjs — อ่าน/เขียน "คลังรีวิวนักเรียนจริง" ให้คอนโซลแก้เป็นฟอร์มได้
//
// ทำไมไม่ทำตารางใหม่ (คำสั่งพี่ง้วง 1 ก.ย. 2026): รีวิวถูกเก็บเป็นข้อความในคลังความรู้
// และตัวเลือกรีวิวใน stagedFollowups อ่านจากที่นั่นด้วย regex เดิม พร้อมจับคู่ persona
// จากข้อความบรรยายผู้รีวิว (PERSONA_REVIEW_HINTS) — ย้ายที่เก็บ = ต้องรื้อทั้งเส้นและมี
// แหล่งความจริงสองที่ โมดูลนี้จึงเป็น "ฟอร์มครอบข้อความเดิม" ไม่ใช่ที่เก็บใหม่
//
// กฎเหล็กของไฟล์นี้: render(parse(x)) ต้องได้ x กลับมาเป๊ะ ถ้าเพี้ยนแม้ตัวเดียว
// แปลว่าการกดบันทึกจากคอนโซลจะทำคลังรีวิวพัง — เทสต์ round-trip คือด่านนั้น

export const REVIEW_ENTRY_TITLE_MATCH = "รีวิวนักเรียนจริง";
import { activeBrand } from "./brand.mjs";
import { reviewSiteHosts, reviewUrlKey } from "./reviewSelection.mjs";

// รูปแบบบรรทัดรายการ ตรงกับ parseReviewCatalog ใน stagedFollowups.mjs
const SECTION_LINE = /^\[(.+)\]\s*$/u;
const ITEM_LINE = /^-\s*(.+?)\s*\|\s*รีวิว:\s*(\S+)\s*$/u;

/**
 * แยกเอกสารรีวิวเป็นส่วนหัว (คำอธิบายวิธีใช้) + กลุ่ม + รายการ
 * บรรทัดที่ไม่เข้าทั้งสองแบบหลังหัวข้อแรก = เก็บไว้ท้ายกลุ่มนั้นตามเดิม (ไม่ทิ้งของใคร)
 */
export function parseReviewDoc(content = "") {
  const lines = String(content ?? "").split("\n");
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const head = line.match(SECTION_LINE);
    if (head) {
      current = { name: head[1].trim(), items: [], extras: [] };
      sections.push(current);
      continue;
    }
    if (!current) { preamble.push(line); continue; }
    const item = line.match(ITEM_LINE);
    if (item) {
      current.items.push({ who: item[1].trim(), url: item[2].trim() });
      continue;
    }
    if (line.trim()) current.extras.push(line);
  }
  // ตัดบรรทัดว่างท้ายส่วนหัวออก เพราะ render ใส่คืนเองเป็นมาตรฐาน
  while (preamble.length && !preamble[preamble.length - 1].trim()) preamble.pop();
  return { preamble: preamble.join("\n"), sections };
}

/** ประกอบกลับเป็นข้อความรูปแบบเดิม — ต้องอ่านได้ด้วย parseReviewCatalog เสมอ */
export function renderReviewDoc({ preamble = "", sections = [] } = {}) {
  const blocks = (Array.isArray(sections) ? sections : []).map((section) => {
    const rows = (section.items || []).map((item) => `- ${String(item.who).trim()} | รีวิว: ${String(item.url).trim()}`);
    return [`[${String(section.name).trim()}]`, ...rows, ...(section.extras || [])].join("\n");
  });
  const head = String(preamble ?? "").replace(/\s+$/u, "");
  return [head, ...blocks].filter((part) => part !== "").join("\n\n") + "\n";
}

// ต้องตรงกับ REVIEW_URL_PATTERN ใน stagedFollowups.mjs — ถ้าคอนโซลยอมให้บันทึกลิงก์ที่
// ตัวอ่านของบอทรับไม่ได้ รีวิวใบนั้นจะตกคลังเงียบ ๆ (เคยเกิดจริงกับลิงก์ /reel/)
const ALLOWED_REVIEW_HOSTS = Object.freeze(["facebook.com", "www.facebook.com", "web.facebook.com"]);
const ALLOWED_REVIEW_PATHS = /^\/(?:share|reel|watch|videos|posts)\//u;
// 24 ก.ย. 2026: หน้ารีวิวบนเว็บ Academy (คลิปอยู่บน Bunny ของเรา ใช้ได้แม้ reel หาย)
// 19 ต.ค. 2026: + หน้าตัวอย่างระบบที่ทำด้วย AI Agent /showcase/apps/<id> (ตัวตรวจคือ reviewUrlKey ตัวเดียวกับบอท)
// Review hosts are derived from the active business profile below.

/**
 * ตรวจรายการก่อนบันทึก — คืนรายการข้อความผิดพลาด (ว่าง = ผ่าน)
 * ลิงก์ต้องเป็นรีวิวบน Facebook หรือหน้ารีวิวบน pngoungacademy.com เท่านั้น เพราะลิงก์
 * แปลกปลอมจะถูกส่งตรงถึงลูกค้าโดยไม่มีใครตรวจอีกชั้น
 */
export function validateReviewDoc({ sections = [] } = {}) {
  const errors = [];
  const SITE_REVIEW_HOSTS = reviewSiteHosts();
  const siteDomains = activeBrand().reviewDomains || [];
  const seenUrl = new Map();
  if (!Array.isArray(sections) || !sections.length) errors.push("ต้องมีอย่างน้อยหนึ่งกลุ่ม");
  for (const [sIndex, section] of (sections || []).entries()) {
    const name = String(section?.name ?? "").trim();
    if (!name) errors.push(`กลุ่มที่ ${sIndex + 1}: ต้องมีชื่อกลุ่ม`);
    if (name.includes("]") || name.includes("[")) errors.push(`กลุ่ม "${name}": ห้ามมีวงเล็บเหลี่ยมในชื่อกลุ่ม`);
    for (const [iIndex, item] of (section?.items || []).entries()) {
      const where = `กลุ่ม "${name}" รายการที่ ${iIndex + 1}`;
      const who = String(item?.who ?? "").trim();
      const url = String(item?.url ?? "").trim();
      if (!who) errors.push(`${where}: ต้องกรอกว่าใครรีวิว (ระบบใช้ข้อความนี้จับคู่กับธุรกิจของลูกค้า)`);
      if (who.includes("|")) errors.push(`${where}: ห้ามมีเครื่องหมาย | ในคำอธิบาย`);
      if (/[\r\n]/u.test(who)) errors.push(`${where}: คำอธิบายต้องอยู่บรรทัดเดียว`);
      if (!url) { errors.push(`${where}: ต้องมีลิงก์รีวิว`); continue; }
      if (/\s/u.test(url)) errors.push(`${where}: ลิงก์ต้องไม่มีช่องว่าง`);
      let parsed = null;
      try { parsed = new URL(url); } catch { /* แจ้งด้านล่าง */ }
      if (!parsed || parsed.protocol !== "https:") errors.push(`${where}: ลิงก์ต้องขึ้นต้นด้วย https://`);
      else if (SITE_REVIEW_HOSTS.includes(parsed.hostname)) {
        if (!reviewUrlKey(url)) {
          errors.push(`${where}: ลิงก์ ${parsed.hostname} ต้องเป็นหน้ารีวิว เช่น https://${siteDomains[0]}/reviews/1CA8LYunLR `
            + `หรือหน้าตัวอย่างระบบ เช่น https://${siteDomains[0]}/showcase/apps/restaurant (id ตัวเล็ก ตัวเลข ขีด 2–40 ตัว)`);
        }
      } else if (!ALLOWED_REVIEW_HOSTS.includes(parsed.hostname)) {
        errors.push(siteDomains.length
          ? `${where}: รับเฉพาะลิงก์ Facebook หรือหน้ารีวิวบน ${siteDomains.join(" / ")} (${parsed.hostname} ใช้ไม่ได้)`
          : `${where}: รับเฉพาะลิงก์ Facebook (${parsed.hostname} ใช้ไม่ได้)`);
      } else if (!ALLOWED_REVIEW_PATHS.test(parsed.pathname)) {
        errors.push(`${where}: ลิงก์แบบนี้บอทหยิบไปใช้ไม่ได้ — ต้องเป็นลิงก์แชร์โพสต์/รีล/วิดีโอ (/share/, /reel/, /watch/, /videos/, /posts/)`);
      }
      const key = reviewUrlKey(url);
      if (parsed && parsed.protocol === "https:" && ALLOWED_REVIEW_HOSTS.includes(parsed.hostname) && !key) {
        errors.push(`${where}: ลิงก์ต้องระบุคลิปชัดเจนและไม่มีข้อมูลเข้าสู่ระบบหรือพอร์ตพิเศษ`);
      }
      const prev = seenUrl.get(key || url);
      if (prev) errors.push(`${where}: ลิงก์ซ้ำกับ ${prev}`);
      else seenUrl.set(key || url, where);
    }
  }
  return errors;
}
