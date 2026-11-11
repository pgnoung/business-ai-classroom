// One selector for reactive chat and staged follow-ups. Catalog remains owner-editable knowledge.
import { activeBrand } from "./brand.mjs";
import { planReviewJourney, reviewJourneyRules } from "./reviewJourney.mjs";
import { SITE_SHOWCASE_PATH, arrivalUrlsIn, isSystemShowcase, showcaseKeyFor } from "./showcaseCases.mjs";

const FACEBOOK_HOSTS = ["facebook.com", "www.facebook.com", "web.facebook.com"];
// White-label: โดเมนหน้ารีวิวของร้าน (BRAND_REVIEW_DOMAINS · ค่าเริ่มต้น pngoungacademy.com = พฤติกรรมเดิม)
export function reviewSiteHosts(brand = activeBrand()) {
  return (brand?.reviewDomains || []).flatMap((domain) => [domain, `www.${domain}`]);
}
const SITE_REVIEW_PATH = /^\/reviews\/([^/]+)\/?$/u;
const SITE_VIDEO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SITE_SOURCE_ID = /^[A-Za-z0-9_-]{5,40}$/u;

export function reviewUrlKey(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
    if (reviewSiteHosts().includes(u.hostname)) {
      // 19 ต.ค. 2026: ตัวอย่างระบบที่ทำด้วย AI Agent (หน้า /showcase/apps/<id>) — id เข้ม ตัวเล็กเท่านั้น
      const showcaseId = SITE_SHOWCASE_PATH.exec(u.pathname)?.[1];
      if (showcaseId) return showcaseKeyFor(showcaseId);
      // 2026-09-24: review pages on the Academy site. An imported review is named after its
      // Facebook source (share code or reel number) and keeps that identity, so a customer
      // who already received the reel is not sent the same review again as a site link.
      const id = SITE_REVIEW_PATH.exec(u.pathname)?.[1];
      if (!id) return null;
      if (SITE_VIDEO_ID.test(id)) return `https://${u.hostname.replace(/^www\./u, "")}/reviews/${id.toLowerCase()}`;
      if (!SITE_SOURCE_ID.test(id)) return null;
      return /^\d+$/u.test(id) ? `https://www.facebook.com/reel/${id}` : `https://www.facebook.com/share/r/${id}`;
    }
    if (!FACEBOOK_HOSTS.includes(u.hostname)
      || !/^(?:\/(?:share|reel|videos|posts)\/|\/watch\/?$)/u.test(u.pathname)) return null;
    // Facebook share/reel identity lives in the path; tracking parameters are not a new review.
    if (/^\/watch\/?$/u.test(u.pathname)) {
      const id = u.searchParams.get("v");
      return id && /^\d+$/u.test(id) ? `https://www.facebook.com/watch?v=${id}` : null;
    }
    // /share/v/<code> and /share/r/<code> are one share code; a site link carries only the code.
    return `https://www.facebook.com${u.pathname.replace(/\/+$/u, "").replace(/^\/share\/v\//u, "/share/r/")}`;
  } catch { return null; }
}

export function reviewKind(section = "") {
  if (/สำนักข่าว|แนะนำพี่ง้วง|news/iu.test(section)) return "profile";
  if (/ตัวอย่าง|บรรยากาศ|ตัดต่อ|showcase|demo/iu.test(section)) return "showcase";
  return "testimonial";
}

const ITEM = /^-\s*(.+?)\s*\|\s*รีวิว:\s*(\S+)\s*$/u;
export function parseCatalogText(content = "") {
  let section = "";
  const rows = [], seen = new Set();
  for (const line of String(content).split("\n")) {
    const heading = /^\[(.+)\]\s*$/u.exec(line);
    if (heading) { section = heading[1]; continue; }
    const item = ITEM.exec(line);
    const key = item && reviewUrlKey(item[2]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({ section, who: item[1], url: item[2], kind: reviewKind(section) });
  }
  return rows;
}

const SECTORS = [
  /ร้านอาหาร|ร้านกาแฟ|คาเฟ่|เบเกอรี|ภัตตาคาร|ร้านชา/u,
  /คลินิก|แพทย์|เภสัช|โรงพยาบาล|สุขภาพ|ความงาม/u,
  /โรงงาน|ผลิต|อุตสาหกรรม|วิศวกร|เครื่องมือ/u,
  /บัญชี|การเงิน|ประกัน|finance/iu,
  /บุคคล|พัฒนาคน|\bhr\b|\bhrd\b|learning.*development/iu,
  /คอนเทนต์|content|creator|influencer|การตลาด|marketing|agency/iu,
  /ออนไลน์|ขายของ|e-?commerce|ค้าปลีก|ค้าส่ง/iu,
  /ครู|อาจารย์|โรงเรียน|โค้ช|coach/iu,
  /ขนส่ง|โลจิสติก|คลังสินค้า|logistic/iu,
  /พนักงาน|เลขา|ธุรการ|office/iu,
  /ท่องเที่ยว|tour|travel/iu,
  /อสังหา|ก่อสร้าง|real\s*estate/iu,
  /โปรแกรม|developer|\bit\b|เทคโนโลยี/iu,
];
// 19 ต.ค. 2026: คำธุรกิจเพิ่มของตัวอย่างระบบ — ใช้เฉพาะตอนเลือกตัวอย่าง (kind showcase) เท่านั้น
// รีวิวผู้เรียนยังใช้ SECTORS ชุดเดิม (ลูกค้าที่พูดคำในชุดนี้ยังได้ทางสำรองจากกลุ่มลูกค้าที่ระบบอ่านเหมือนเดิม)
const SHOWCASE_SECTORS = [
  /โรงแรม|รีสอร์ท|รีสอร์ต|ที่พัก|โฮมสเตย์|โฮสเทล|hotel|resort/iu,
  /อู่ซ่อม|อู่รถ|เปิดอู่|ทำอู่|ซ่อมรถ|ศูนย์บริการรถ|ศูนย์ซ่อม|คาร์แคร์|ประดับยนต์|garage/iu,
  /ประกัน(?!ไม่)|ตัวแทน(?:ขาย|ประกัน)|เอเจนซี่ประกัน|ผู้จัดการหน่วย|โบรกเกอร์ประกัน|insurance/iu,
  /สต็อก|สต๊อก|สต้อก|stock|\bpos\b|คลังสินค้า|เช็กของ|inventory/iu,
  /เดลิเวอรี|delivery|ส่งของ|จัดส่ง|จัดรถ|ไรเดอร์|rider|แมสเซนเจอร์|messenger|ขนส่ง/iu,
  /รับสมัครงาน|สมัครงาน|สรรหา|คัดใบสมัคร|สัมภาษณ์งาน|recruit|hiring/iu,
  /ทีมขาย|เซลส์|\bsales\b|\bcrm\b|pipeline|ไปป์ไลน์|ปิดการขาย|ติดตามลูกค้า/iu,
  /ออกแบบภายใน|ตกแต่งภายใน|อินทีเรีย|interior|ใบเสนอราคา|\bboq\b|ผู้รับเหมา|สถาปนิก|แปลน/iu,
  /แฟชั่น|เสื้อผ้า|เช่าชุด|ชุดแต่งงาน|ชุดราตรี|บูติก|boutique|fashion/iu,
  /สถาบันสอน|โรงเรียนสอน|ติวเตอร์|ออกใบประกาศ|เกียรติบัตร|จัดสัมมนา|จัดอบรม|จัดอีเวนต์|ผู้จัดงาน|organizer/iu,
  /องค์กร|บริษัทใหญ่|corporate|ทั้งบริษัท|กลุ่มบริษัท|จัดซื้อ|ฝ่ายการเงิน|สายอนุมัติ|ขั้นอนุมัติ|อนุมัติซื้อ/iu,
  /น้ำท่วม|หมู่บ้าน|นิติบุคคล|โกดัง|กล้องวงจรปิด|cctv/iu,
];
const SHOWCASE_GROUPS = [...SECTORS, ...SHOWCASE_SECTORS];
const VIDEO_TALK = /วิดีโอ|วิดิโอ|ตัดต่อ|คอนเทนต์/u;
const PERSONA = { online_seller: 6, clinic_health: 1, manufacturing: 2, finance_accounting: 3, hr_people: 4,
  freelance_agency: 5, educator: 7, logistics: 8, office_worker: 9, restaurant_cafe: 0, it_developer: 12 };
const formatOf = text => /in[- ]?house|อบรมพนักงาน|อบรมในบริษัท/iu.test(text) ? "inhouse"
  : /private|ส่วนตัว|เฉพาะกลุ่ม/iu.test(text) ? "private"
  : /guest|วิทยากร|บรรยาย/iu.test(text) ? "speaker" : /classroom|คลาสรวม|ห้องเรียน/iu.test(text) ? "classroom" : null;
const courseOf = text => /ไม่(?:เอา|สนใจ|อยาก).{0,20}(?:workflow|automation)/iu.test(text) ? "not_workflow"
  : /customiz(?:e|ed)|คลาสออกแบบเฉพาะ/iu.test(text) ? "custom"
  : /workflow|automation|คลาสต่อยอด/iu.test(text) ? "workflow"
  : /AI\s*Agent\s*(?:for\s*)?Business|คลาสพื้นฐาน/iu.test(text) ? "business" : null;

// scope "system" = เฉพาะตัวอย่างระบบที่ทำด้วย AI Agent (คำถาม "ทำอะไรได้บ้าง / ใช้ได้จริงไหม") — ไม่มีในคลัง = null
export function selectReview(reviews, { sentUrls = new Set(), history = [], text = "", personaType = "", kind = "testimonial", course = null, scope = "" } = {}) {
  const sent = new Set([...sentUrls].map(reviewUrlKey).filter(Boolean));
  for (const t of history) if (t?.role === "assistant") {
    for (const url of String(t.content || "").match(/https:\/\/[^\s<>]+/gu) || []) {
      const key = reviewUrlKey(url); if (key) sent.add(key);
    }
  }
  // 19 ต.ค. 2026: ลูกค้ากดปุ่มทักไลน์มาจากหน้าเคส/หน้ารีวิว (รหัสในข้อความ) = หน้านั้นเขาดูมาแล้ว ไม่ส่งกลับ
  const typed = [...history.filter(t => t?.role === "user").map(t => String(t.content || "")), String(text)];
  for (const url of arrivalUrlsIn(typed)) { const key = reviewUrlKey(url); if (key) sent.add(key); }
  let pool = reviews.filter(r => reviewUrlKey(r.url) && !sent.has(reviewUrlKey(r.url)) && (r.kind || reviewKind(r.section)) === kind);
  if (!pool.length) return null;
  const userTexts = [...history.filter(t => t?.role === "user").map(t => String(t.content || "")), String(text)];
  const requestedFormat = [...userTexts].reverse().map(formatOf).find(Boolean);
  const requestedCourse = course || [...userTexts].reverse().map(courseOf).find(Boolean);
  if (kind !== "profile") {
    if (requestedFormat) pool = pool.filter(r => formatOf(r.section) === requestedFormat || (kind === "showcase" && !formatOf(r.section)));
    if (requestedCourse === "not_workflow") pool = pool.filter(r => courseOf(r.section) !== "workflow");
    else if (requestedCourse) pool = pool.filter(r => courseOf(r.section) === requestedCourse || (kind === "showcase" && !courseOf(r.section)));
  }
  if (kind === "showcase") {
    // Unscoped editing clips are not workflow demos or classroom-atmosphere evidence.
    if (scope === "system") pool = pool.filter(isSystemShowcase);
    else if (/บรรยากาศ/u.test(text)) pool = pool.filter(r => /บรรยากาศ/u.test(r.section + " " + r.who));
    else if (/ระบบ|workflow|automation|อัตโนมัติ/iu.test(text) && !VIDEO_TALK.test(text)) {
      pool = pool.filter(r => /workflow|automation|ระบบ|อัตโนมัติ/iu.test(r.section + " " + r.who));
    } else pool = pool.filter(r => !isSystemShowcase(r)); // ขอดูตัวอย่างการสอน/คลิป/คอนเทนต์ = คลิปเดิม ไม่ใช่หน้าตัวอย่างระบบ (เล่นซ้ำแชทจริง 19 ต.ค.)
  }
  if (!pool.length) return null; // no unrelated class substitution after exhausting the relevant pool
  const context = userTexts.slice(-4).join("\n");
  const groups = kind === "showcase" ? SHOWCASE_GROUPS : SECTORS;
  const sectors = groups.map((pattern, i) => pattern.test(context) ? i : -1).filter(i => i >= 0);
  if (!sectors.length && PERSONA[personaType] !== undefined) sectors.push(PERSONA[personaType]);
  const score = r => sectors.reduce((n, i) => n + (groups[i].test(r.who) ? 8 : 0), 0)
    + (!requestedFormat && formatOf(r.section) === "classroom" ? 2 : 0)
    + (!requestedCourse && courseOf(r.section) === "business" ? 1 : 0)
    + (/หลากหลาย|รวมรีวิว/u.test(r.who) ? 1 : 0);
  return pool.map((r, index) => ({ r, index, score: score(r) })).sort((a, b) => b.score - a.score || a.index - b.index)[0].r;
}

// กลุ่มใน SECTORS ที่เป็นตำแหน่ง/สายงาน ไม่ใช่ธุรกิจ (HR · การตลาด/คอนเทนต์ · ครู/โค้ช · พนักงานออฟฟิศ/เลขา · โปรแกรมเมอร์/IT)
const ROLE_SECTORS = new Set([4, 5, 7, 9, 12]);
/**
 * 12 ต.ค. 2026 (พี่ง้วง "รีวิวที่ตรงกับลูกค้า"): รีวิวที่ selectReview เลือกตรงกับลูกค้าด้วยเหตุอะไร — ใช้เขียนคำนำสั้น ๆ ตามจริง
 * "sector" = ธุรกิจที่ลูกค้าเล่าเองตรงกับป้ายรีวิว (ตัวจับชุดเดียวกับตอนเลือก) · "role" = ตรงด้วยตำแหน่ง/สายงาน หรือด้วยกลุ่มลูกค้าที่ระบบอ่าน
 * (ผู้ตรวจ 12 ต.ค.: ครูได้รีวิวโค้ช · HR ได้รีวิวเลขา แล้วคำนำบอกว่า "ทำธุรกิจใกล้เคียงกัน" = ไม่จริง)
 * · "course" = คลาสเดียวกับที่คุยอยู่ · "" = รีวิวทั่วไป
 */
export function reviewFitOf(review, { history = [], text = "", personaType = "", course = null } = {}) {
  if (!review?.who) return "";
  const userTexts = [...(Array.isArray(history) ? history : []).filter(t => t?.role === "user").map(t => String(t.content || "")), String(text)];
  const context = userTexts.slice(-4).join("\n");
  const told = SECTORS.map((pattern, i) => pattern.test(context) ? i : -1).filter(i => i >= 0);
  const sectors = told.length ? told : PERSONA[personaType] !== undefined ? [PERSONA[personaType]] : [];
  const matched = sectors.filter(i => SECTORS[i].test(review.who));
  if (matched.length) return told.length && matched.some(i => !ROLE_SECTORS.has(i)) ? "sector" : "role";
  if (course && courseOf(review.section || "") === course) return "course";
  return "";
}

export function selectJourneyEvidence(reviews, context = {}) {
  const plan = planReviewJourney(context);
  const selected = [], sentUrls = new Set(context.sentUrls || []);
  for (let i = 0; i < plan.maxItems; i++) {
    const kindOrder = plan.kinds.length > 1 && i > 0 ? [...plan.kinds].reverse() : plan.kinds;
    const course = plan.compareCourses ? (i === 0 ? "business" : "workflow") : null;
    let chosen = null;
    for (const kind of kindOrder) {
      chosen = selectReview(reviews, { ...context, sentUrls, kind, course, scope: kind === "showcase" ? plan.showcaseScope || "" : "" });
      if (chosen) break;
    }
    if (!chosen) continue;
    selected.push(chosen); sentUrls.add(chosen.url);
  }
  return { plan, selected };
}

// 19 ต.ค. 2026: ตัดรายการคลังรีวิวที่โค้ดไม่ได้เลือกออกจากข้อความที่จะส่งเข้าโมเดล (คลังเต็มยังอยู่ให้โค้ดอ่าน)
// keep = ลิงก์/แถวที่เลือก (เทียบด้วย reviewUrlKey — ลิงก์ซ้ำในคลังคงไว้แค่บรรทัดแรก) · บรรทัดอื่นทุกบรรทัดคงเดิม
// หัวกลุ่ม "[...]" ที่รายการถูกตัดหมดและไม่มีบรรทัดอื่นเหลือ = ตัดหัวกลุ่ม + บรรทัดว่างที่ปิดกลุ่มนั้นทิ้งด้วย
// (กลุ่มของการ์ดอื่น เช่น "[ราคาและความคุ้มค่า]" ไม่มีรายการรีวิว จึงไม่ถูกแตะ)
const HEADING = /^\[.+\]\s*$/u;
export function stripCatalogItems(knowledge = "", keep = []) {
  const keys = new Set([...(keep || [])].map((v) => reviewUrlKey(typeof v === "string" ? v : v?.url)).filter(Boolean));
  const out = [], kept = new Set();
  let group = null;
  const flush = () => {
    if (!group) return false;
    const drop = group.removed > 0 && !group.body.some((line) => line.trim());
    if (!drop) out.push(group.heading, ...group.body);
    group = null;
    return drop;
  };
  for (const line of String(knowledge).split("\n")) {
    if (HEADING.test(line)) { flush(); group = { heading: line, body: [], removed: 0 }; continue; }
    const item = ITEM.exec(line);
    if (item) {
      const key = reviewUrlKey(item[2]);
      const keepIt = key && keys.has(key) && !kept.has(key);
      if (keepIt) kept.add(key);
      if (!keepIt) { if (group) group.removed += 1; continue; }
    } else if (!line.trim() && group) {
      if (!flush()) out.push(line); // กลุ่มที่ถูกตัดทิ้ง = ทิ้งบรรทัดว่างที่ปิดกลุ่มไปด้วย
      continue;
    }
    if (group) group.body.push(line); else out.push(line);
  }
  flush();
  return out.join("\n");
}

// pruneHeadings (แบบใหม่ 19 ต.ค.): ตัดหัวกลุ่มคลังรีวิวที่ไม่มีรายการเหลือ — false = ข้อความเดิมทุกไบต์
export function focusReviewKnowledge(knowledge = "", context = {}, { pruneHeadings = false } = {}) {
  const catalog = parseCatalogText(knowledge);
  if (!catalog.length) return knowledge;
  const { plan, selected } = selectJourneyEvidence(catalog, context);
  const keys = new Set(selected.map(r => reviewUrlKey(r.url)));
  const kept = new Set();
  const focused = pruneHeadings ? stripCatalogItems(knowledge, selected) : String(knowledge).split("\n").filter(line => {
    const item = ITEM.exec(line);
    if (!item) return true;
    const key = reviewUrlKey(item[2]);
    if (kept.has(key) || !keys.has(key)) return false;
    kept.add(key); return true;
  }).join("\n");
  return focused + "\n[ข้อกำกับหลักฐานที่เลือกในเทิร์นนี้]\n"
    + reviewJourneyRules(plan, selected) + "\n";
}

// รีวิวชุดเดียวกับ focusReviewKnowledge แต่แยกเป็นสองก้อน: ความรู้ที่ตัดรายการรีวิวออกทั้งหมด (เหมือนกันทุกเทิร์น)
// กับรีวิวที่เลือกให้เทิร์นนี้พร้อมหัวหมวด — แคชของ Claude จำทีละบล็อก ถ้าตัดรีวิวต่างกันแค่บรรทัดเดียว
// ทั้งก้อนความรู้+persona ก็พลาดแคช (วัด 4 ต.ค.: สองเทิร์นเหมือนกันแค่ 10.7k จาก 64k ตัวอักษร)
export function splitReviewKnowledge(knowledge = "", context = {}, { pruneHeadings = false } = {}) {
  const catalog = parseCatalogText(knowledge);
  if (!catalog.length) return { knowledge, focus: "" };
  const { plan, selected } = selectJourneyEvidence(catalog, context);
  const keys = new Set(selected.map(r => reviewUrlKey(r.url)));
  const stable = [], picked = [], kept = new Set();
  let heading = "", shown = "";
  for (const line of String(knowledge).split("\n")) {
    const item = ITEM.exec(line);
    if (!item) {
      stable.push(line);
      if (/^\[.+\]\s*$/u.test(line)) heading = line.trim();
      continue;
    }
    const key = reviewUrlKey(item[2]);
    if (kept.has(key) || !keys.has(key)) continue;
    kept.add(key);
    if (heading && heading !== shown) { picked.push(heading); shown = heading; }
    picked.push(line);
  }
  const reviews = picked.length
    ? `[รีวิวผู้เรียนที่เลือกให้เทิร์นนี้ จากคลังรีวิวในความรู้ — ใช้ลิงก์ตามนี้เป๊ะ ๆ]\n${picked.join("\n")}\n` : "";
  return { knowledge: pruneHeadings ? stripCatalogItems(knowledge, []) : stable.join("\n"),
    focus: `${reviews}[ข้อกำกับหลักฐานที่เลือกในเทิร์นนี้]\n${reviewJourneyRules(plan, selected)}\n` };
}
