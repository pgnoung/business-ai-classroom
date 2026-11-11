// reviewCatalogPrompt.mjs — คลังรีวิวออกจากพรอมต์ (คำสั่งพี่ง้วง 19 ต.ค. 2026
// "เตรียมแก้โค้ดเอาคลังรีวิวออกจาก prompt ใน branch แยกก่อน พร้อมเทสต์ ยังไม่ deploy")
//
// ข้อความเต็มของการ์ด "รีวิวนักเรียนจริง" ยังอยู่ในก้อนความรู้ที่โค้ดอ่าน (ตัวเลือกรีวิว/ตัวอย่างระบบ ·
// รหัส WF-/RV- จากปุ่ม LINE · กันส่งซ้ำ · เพดาน 4 ต่อห้อง) — ไฟล์นี้ตัดเฉพาะ "สิ่งที่โมเดลเห็น" ก่อนส่ง:
//   - เส้นที่โค้ดเลือกเอง (ทักตาม/ด่านตรวจ) = กติกาการใช้ของคลัง + รายการที่โค้ดเลือก (หรือที่อยู่ในร่างแล้ว)
//   - เส้นที่โมเดลเป็นคนเลือก (YOLO · ทักตามที่คนอนุมัติ) = กติกาการใช้ + รายชื่อสั้นที่โค้ดจัดอันดับให้ ≤3
// สวิตช์ settings.review_catalog_in_prompt = "on" = คืนข้อความเดิมทุกไบต์ (ถอยกลับไม่ต้อง deploy)
import { catalogOutOfPrompt } from "./knowledgePack.mjs";
import { parseCatalogText, reviewUrlKey, selectReview, stripCatalogItems } from "./reviewSelection.mjs";
import { capabilityAsk } from "./showcaseCases.mjs";

export const CATALOG_SHORTLIST_MAX = 3;

const URLS = /https:\/\/[^\s<>]+/gu;
const SHOW_HINT = /ตัวอย่าง|ผลงาน|บรรยากาศ|คลิป|วิดีโอ|วิดิโอ|ระบบ|workflow|automation|อัตโนมัติ/iu;
const SYSTEM_HINT = /ระบบ|workflow|automation|อัตโนมัติ/iu;
const TRUST_HINT = /สำนักข่าว|รู้จักพี่ง้วง|ใครสอน|ผู้สอน|น่าเชื่อถือ|ประวัติพี่ง้วง/u;

/** ลิงก์ในข้อความ (ร่างที่โค้ดประกอบแล้ว) ที่เป็นรายการในคลัง — ด่านตรวจต้องเห็นหลักฐานของลิงก์ที่จะส่งจริง */
export function catalogUrlsIn(text = "") {
  return (String(text || "").match(URLS) || []).filter((url) => reviewUrlKey(url));
}

/** เส้นที่โค้ดเลือกรายการเอง: คงเฉพาะรายการ keep · สวิตช์ on = ข้อความเดิม */
export function knowledgeForPrompt({ db, knowledge = "", keep = [] } = {}) {
  if (!catalogOutOfPrompt(db)) return knowledge;
  return stripCatalogItems(knowledge, keep);
}

/** ด่านตรวจร่าง (JEV) ของเส้นเชิงรุก: เห็นเฉพาะรายการที่ร่างนี้ส่งจริง */
export function knowledgeForDraftReview({ db, knowledge = "", draftText = "" } = {}) {
  return knowledgeForPrompt({ db, knowledge, keep: catalogUrlsIn(draftText) });
}

/**
 * รายชื่อสั้นที่โค้ดจัดอันดับให้ (ตัวเลือกเดียวกับเส้นตอบแชท: ธุรกิจ/บทบาท/คลาส · ไม่ซ้ำที่ห้องเคยได้ ·
 * รหัสหน้าเว็บที่ลูกค้าเพิ่งดูมาไม่ส่งกลับ · ตัวอย่างระบบไม่เรียกรีวิว · เดโมที่ไม่อยู่ในคลังไม่มีทางถูกเลือก)
 */
export function catalogShortlist(rows = [], { text = "", history = [], sentUrls = new Set(), personaType = "", max = CATALOG_SHORTLIST_MAX } = {}) {
  const kinds = TRUST_HINT.test(text) ? ["profile", "testimonial", "showcase"]
    : SHOW_HINT.test(text) ? ["showcase", "testimonial"] : ["testimonial", "showcase"];
  const scope = capabilityAsk(text) || SYSTEM_HINT.test(text) ? "system" : "";
  const sent = new Set(sentUrls instanceof Set ? sentUrls : []);
  const picked = [];
  for (let progress = true; progress && picked.length < max;) {
    progress = false;
    for (const kind of kinds) {
      if (picked.length >= max) break;
      const row = selectReview(rows, { sentUrls: sent, history, text, personaType, kind, scope: kind === "showcase" ? scope : "" });
      if (!row) continue;
      picked.push(row); sent.add(row.url); progress = true;
    }
  }
  return picked;
}

/** เส้นที่โมเดลเป็นคนเลือกเอง: กติกาการใช้ + รายชื่อสั้น ≤3 · สวิตช์ on = ข้อความเดิม */
export function knowledgeWithCatalogShortlist({ db, knowledge = "", context = {} } = {}) {
  if (!catalogOutOfPrompt(db)) return knowledge;
  const rows = parseCatalogText(knowledge);
  if (!rows.length) return knowledge;
  return stripCatalogItems(knowledge, catalogShortlist(rows, context));
}

/** บริบทของรายชื่อสั้นในเส้นเชิงรุก: โน้ต/คำสั่งของทีม + ข้อความล่าสุดของลูกค้า · ห้องเคยได้อะไรแล้ว · กลุ่มลูกค้าที่ระบบอ่าน — อ่านพัง = ค่าว่าง */
export function catalogShortlistContext({ db, customerId = "", history = [], note = "" } = {}) {
  const turns = Array.isArray(history) ? history : [];
  const lastUser = [...turns].reverse().find((turn) => turn?.role === "user")?.content || "";
  let sentUrls = new Set();
  try { sentUrls = db?.sentReviewUrls?.(customerId) ?? new Set(); } catch { sentUrls = new Set(); }
  let personaType = "";
  try { personaType = String(JSON.parse(db?.scoreHistory?.(customerId, 1)?.[0]?.payload_json || "{}")?.persona_type || ""); } catch { personaType = ""; }
  return { text: [String(note || ""), String(lastUser)].filter((value) => value.trim()).join("\n"), history: turns, sentUrls, personaType };
}
