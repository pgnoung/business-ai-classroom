// customerAddress.mjs — เรียกชื่อลูกค้าแบบคน ไม่ใช่แบบระบบ CRM (audit ก.ย. 2026 §4.2)
//
// ตั้งแต่ดึงชื่อโปรไฟล์ Messenger (10 ก.ย.) ข้อความ AI 32.5% มีชื่อ-นามสกุลเต็มหรือ handle
// และบางห้องโดนเรียกชื่อเต็ม 24 ครั้งในวันเดียว — แอดมินคนจริงเรียกชื่อต้นครั้งเดียวตอนทัก
// แล้วใช้ "คุณ" หรือไม่เรียกชื่อเลย ไฟล์นี้มีสองหน้าที่ (ฟังก์ชันบริสุทธิ์ ไม่แตะ DB):
//   planCustomerAddress   = ชื่อที่เรียกได้ (customerAddressLabel) + "เทิร์นนี้เรียกชื่อได้ไหม"
//                           (เรียกไปแล้วใน NAME_COOLDOWN_AI_TURNS เทิร์นล่าสุดของลูกแพร = ไม่ได้)
//   enforceCustomerAddress = ด่านหลังร่าง ก่อน humanizer: ชื่อเต็ม/handle → ชื่อต้น และตัดการเรียกชื่อ
//                           ที่เกินโควตา (เทิร์นละไม่เกินหนึ่งครั้ง) — เพราะโมเดลลอกชื่อเต็มจาก
//                           ข้อความเก่าของตัวเองในประวัติได้เสมอ แม้พรอมต์จะให้แค่ชื่อต้น
// ข้อความถึงทีมงาน (notify / handoff ping) ไม่ผ่านไฟล์นี้ — ทีมงานต้องเห็นชื่อเต็มตามเดิม
import { customerAddressLabel, GENERIC_ADDRESS_LABEL, normalizeForAddress, shortAddressName } from "./customerName.mjs";

// เรียกชื่อได้ไม่เกินหนึ่งครั้งต่อ 4 เทิร์นของลูกแพร — เทิร์นทักทาย (ยังไม่เคยตอบ) เรียกได้เสมอ
export const NAME_COOLDOWN_AI_TURNS = 3;
const OPERATOR_PREFIX = /^\[แอดมินทีมงานพิมพ์เอง\]/u;
// คำที่ต้องมีสรรพนามตามหลัง ("ของคุณ" "ให้คุณ" "ว่าคุณ") — ตัดชื่อทิ้งแล้วเหลือ "คุณ" แทนการตัดทั้งก้อน
// รีวิว 2026-10-03 รอบ 3: "เพื่อ/จากทาง/โดย/แทน…" ตัดทิ้งแล้วประโยคขาด ("ขอข้อมูลจากทางเพิ่มเติม")
const NEEDS_PRONOUN_BEFORE = /(?:ของ|ให้|กับ|สำหรับ|ถึง|แด่|หา|ว่า|และ|เชิญ|ชวน|เพื่อ|แก่|ต่อ|จาก|ทาง|โดย|แทน|เป็น|คือ)\s*$/u;
// คำเรียกเป็นประธานร่วม/ถามกลับ ("คุณมินและทีม…" "คุณมินเอง…" "แล้วคุณมินล่ะคะ") — เก็บ "คุณ" ไว้
// ไม่งั้นเหลือ "และทีม…" / "แล้วล่ะคะ" · ต้องติดกันเท่านั้น: เว้นวรรคก่อน "และ" คือขึ้นประโยคใหม่
const PRONOUN_CONTINUES = /^(?:และ|หรือ|เอง|ล่ะ)/u;
// ประโยคก่อนชื่อยังไม่มีหางเสียงของตัวเอง ("สวัสดีคุณมินค่ะ" "สะดวกรอบไหน คุณมินคะ") = คำลงท้ายหลังชื่อเป็นของประโยคนั้น
// ตัดชื่อแล้วต้องคืนคำลงท้ายให้ประโยค (รีวิวรอบ 4: เดิมเหลือ "สวัสดี" แล้ว humanizer เติม "ค่ะ" ผิดชนิดให้คำถาม)
const SENTENCE_CONTINUES = /[\p{L}\p{M}\p{N}]$/u;
const ENDS_WITH_PARTICLE = /(?:ค่ะ|คะ|ค่า|ครับ|คับ|ฮะ|จ้ะ|จ้า|จ๊ะ|นะ|น้า)$/u;
// ตัดชื่อท้ายบรรทัดแล้วต่อบรรทัดถัดไปเข้ามา เฉพาะประโยคคำถามแบบบันได "ไม่ทราบว่า คุณ{ชื่อ}⏎เคยใช้ AI…"
// (บรรทัดอื่น เช่น "…สำหรับคุณ⏎มีอะไรถามได้เลย" ต่อกันแล้วอ่านไม่รู้เรื่อง)
const JOINS_NEXT_LINE = /ว่า\s*$/u;

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

// เทิร์นของลูกแพร = แถว assistant ที่ติดกัน (หนึ่งเทิร์นหลายบอลลูน) — ข้อความทีมงานไม่นับ
function aiTurnTexts(history) {
  const turns = [];
  let current = null;
  for (const row of Array.isArray(history) ? history : []) {
    const content = String(row?.content || "");
    if (row?.role !== "assistant" || OPERATOR_PREFIX.test(content)) {
      current = null;
      continue;
    }
    if (!current) {
      current = [];
      turns.push(current);
    }
    current.push(content);
  }
  return turns.map((parts) => parts.join("\n"));
}

// รูปยาวของชื่อที่โมเดลอาจลอกมาจากประวัติ (ชื่อโปรไฟล์ดิบ / ถอดของตกแต่งแล้ว / ชื่อที่ลูกค้าบอก)
function longFormsOf({ knownName, displayName }, { label, name }) {
  const forms = new Set();
  for (const raw of [displayName, knownName]) {
    const value = String(raw || "").replace(/\s+/gu, " ").trim();
    if (!value) continue;
    forms.add(value);
    forms.add(normalizeForAddress(value));
  }
  return [...forms]
    .filter((form) => [...form].length >= 3 && form !== name && form !== label)
    .sort((a, b) => [...b].length - [...a].length);
}

/**
 * @param {{knownName?: string, displayName?: string, history?: Array<{role: string, content: string}>}} input
 */
export function planCustomerAddress({ knownName = "", displayName = "", history = [] } = {}) {
  const label = customerAddressLabel({ knownName, displayName });
  const short = shortAddressName({ knownName, displayName });
  if (!short) {
    return { label, generic: true, name: "", pronoun: "คุณ", mayUseName: true, mention: null,
      longForms: longFormsOf({ knownName, displayName }, { label, name: "" }) };
  }
  const pronoun = short.honorific || "คุณ";
  // ชื่อละติน "Bo" ห้ามไปแมตช์ครึ่งหน้าของ "Book" — ชื่อไทยไม่มีขอบคำให้เช็ค (โมเดลเขียนชื่อติดคำอื่นไม่ได้อยู่แล้ว)
  const tail = /\p{Script=Latin}$/u.test(short.name) ? "(?!\\p{Script=Latin})" : "";
  const mention = new RegExp(`${escapeRegex(pronoun)}\\s?${escapeRegex(short.name)}${tail}`, "gu");
  const usedRecently = aiTurnTexts(history).slice(-NAME_COOLDOWN_AI_TURNS).some((text) => {
    mention.lastIndex = 0;
    return mention.test(text);
  });
  mention.lastIndex = 0;
  return {
    label, generic: false, name: short.name, pronoun, mayUseName: !usedRecently, mention,
    longForms: longFormsOf({ knownName, displayName }, { label, name: short.name }),
  };
}

// บรรทัดที่ถูกแก้ชื่อ: ช่องว่างซ้ำ / ช่องว่างหน้าเครื่องหมาย / ช่องว่างหัวบรรทัดที่เหลือจากการตัดชื่อ
// (บรรทัดที่ไม่ได้แตะคงไว้ทุกไบต์)
function tidyLine(line) {
  return line.replace(/[ \t]{2,}/gu, " ").replace(/[ \t]+([,.!?])/gu, "$1").replace(/^[ \t]+/u, "").replace(/[ \t]+$/u, "");
}

const URL_IN_LINE = /https?:\/\/|www\./iu;

// บรรทัดลิงก์และบรรทัดชื่อ-ตำแหน่งที่อยู่เหนือลิงก์ (บล็อกรีวิวนักเรียนจริง "เกริ่น / ชื่อ ตำแหน่ง / ลิงก์")
// ต้องตรงตามคลังเป๊ะ — ชื่อผู้รีวิวอาจชนกับชื่อต้นของลูกค้า ห้ามแตะสองบรรทัดนี้เด็ดขาด
function protectedLines(lines) {
  const locked = new Set();
  lines.forEach((line, index) => {
    if (!URL_IN_LINE.test(line)) return;
    locked.add(index);
    for (let prev = index - 1; prev >= 0; prev -= 1) {
      if (!lines[prev].trim()) continue;
      locked.add(prev);
      break;
    }
  });
  return locked;
}

// ชื่อเต็ม/handle ที่โมเดลลอกมาจากประวัติ -> ชื่อที่เรียกได้ (ยังไม่นับโควตา)
function normalizeLongForms(line, plan) {
  let value = line;
  const bare = plan.generic || plan.pronoun !== "คุณ" ? plan.label : plan.name;
  for (const form of plan.longForms || []) {
    const escaped = escapeRegex(form);
    value = value.replace(new RegExp(`(?:คุณ|พี่|น้อง)\\s?${escaped}`, "gu"), plan.label);
    // รูปยาวที่ไม่มีคำนำหน้า แทนได้เฉพาะชื่อหลายคำ ("ชื่อ นามสกุล") — คำเดี่ยวอย่าง "Line"
    // อาจเป็นคำธรรมดาในคำตอบ (LINE OA) การแทนทุกที่จะทำลายเนื้อความ
    if (/\s/u.test(form)) value = value.replace(new RegExp(escaped, "gu"), bare);
  }
  return value;
}

// เรียกชื่อได้ครั้งเดียว — เลือกตำแหน่งท้ายบรรทัดก่อน (2026-09-28, eval จริง): บันไดเปิดบทสนทนาของพี่ง้วง
// วางชื่อไว้ท้ายบรรทัดเสมอ "ไม่ทราบว่า คุณ{ชื่อ}⏎เคยใช้ AI…" ถ้าเก็บชื่อในคำทักแล้วตัดชื่อในบันได
// จะเหลือ "คุณ" ห้อยท้ายบรรทัด — เก็บชื่อในบันได (สำนวนต้นฉบับ) แล้วตัดชื่อในคำทักแทน
function pickKeptMention(docs, plan) {
  let first = null;
  for (const [docIndex, doc] of docs.entries()) {
    for (const [lineIndex, line] of doc.normalized.entries()) {
      if (doc.locked.has(lineIndex)) continue;
      let index = 0;
      for (const match of line.matchAll(plan.mention)) {
        const spot = { docIndex, lineIndex, index };
        first ??= spot;
        const before = line.slice(0, match.index).trim();
        const after = line.slice(match.index + match[0].length);
        if (before && !after.trim()) return spot;
        index += 1;
      }
    }
  }
  return first;
}

// ตัดการเรียกชื่อที่เกินโควตา — คืน dangling = ตัดชื่อท้ายบรรทัดแล้วเหลือสรรพนามห้อยอยู่
function capMentions(line, plan, keepIndex) {
  let index = -1;
  let dangling = false;
  // "คุณมินคะ, ถ้า..." เป็นคำเรียกขานก้อนเดียวกัน: เมื่อตัดชื่อ ต้องตัดคำลงท้าย
  // และเครื่องหมายคั่นนี้ด้วย ไม่อย่างนั้นลูกค้าจะเห็นประโยคขึ้นต้นลอย ๆ ว่า "คะ, ถ้า..."
  // รีวิว 2026-10-03 รอบ 3–4: จับช่องว่างหน้าชื่อ (lead) และคำลงท้ายหลังชื่อ (tail) แยกกลุ่ม แล้วตัดสินตามบริบท —
  //   ชื่อเป็นกรรม ("สำหรับคุณมินค่ะ") = เหลือ "คุณ" + คำลงท้าย · ประโยคก่อนชื่อยังไม่มีหางเสียง = คืนคำลงท้ายให้ประโยค ·
  //   ประโยคมีหางเสียงแล้ว/ขึ้นต้นบรรทัด ("สวัสดีค่ะ คุณมินคะ" "คุณมินคะ ถ้า…") = ตัดทิ้งทั้งก้อน
  const mentionWithVocative = new RegExp(
    `(?<lead>[ \t]*)${plan.mention.source}(?<tail>(?:[ \t]*(?:คะ|ค่ะ|ครับ)(?=(?:[ \t]+|[,，!?？…][ \t]*)\\S|[,，!?？…]?[ \t]*$)(?:[,，!?？…](?=[ \t]*\\S))?)?)`,
    plan.mention.flags,
  );
  const value = line.replace(mentionWithVocative, (...args) => {
    // อ่านกลุ่มตามชื่อจากอาร์กิวเมนต์ท้ายสุด — ไม่ผูกกับตำแหน่ง เผื่อ plan.mention มีวงเล็บจับของตัวเองในอนาคต
    const [match] = args;
    const groups = args.at(-1);
    const whole = args.at(-2);
    const offset = args.at(-3);
    const lead = groups.lead || "";
    const tail = groups.tail || "";
    index += 1;
    if (index === keepIndex) return match;
    const before = whole.slice(0, offset);
    const after = whole.slice(offset + match.length);
    // "คุณลูกค้าที่ลงทะเบียนแล้ว…" = คำนามทั่วไป ไม่ใช่การเรียก — เหลือ "ลูกค้าที่…" (เฉพาะแผนที่ระบุ relativeNoun)
    if (plan.relativeNoun && /^ที่/u.test(after)) return lead + plan.relativeNoun;
    if (NEEDS_PRONOUN_BEFORE.test(before) || (!tail && PRONOUN_CONTINUES.test(after))) {
      if (!tail && !after.trim() && JOINS_NEXT_LINE.test(before)) dangling = true;
      return lead + plan.pronoun + tail;
    }
    if (tail && SENTENCE_CONTINUES.test(before) && !ENDS_WITH_PARTICLE.test(before)) {
      // คำลงท้ายติดคำไทยได้เลย แต่หลังคำอังกฤษ/ตัวเลขต้องเว้นวรรค ("ChatGPT คะ" ไม่ใช่ "ChatGPTคะ")
      return (/[A-Za-z0-9]$/u.test(before) ? " " : "") + tail.trimStart();
    }
    // ตัดทิ้ง: คืนช่องว่างที่กลืนมาหนึ่งช่องเมื่อคำถัดไปติดอยู่ (รีวิวรอบ 5: "ขอบคุณค่ะ คุณมินสนใจ…" เคยเหลือ
    // "ขอบคุณค่ะสนใจ…" และบรรทัดรายการ "- คุณมินเลือก…" เหลือ "-เลือก…")
    return lead && after && !/^\s/u.test(after) ? " " : "";
  });
  return { value, dangling };
}

function enforceTexts(texts, plan) {
  const docs = texts.map((text) => {
    const original = String(text ?? "");
    const lines = original.split("\n");
    const locked = protectedLines(lines);
    const normalized = lines.map((line, index) => (!plan || locked.has(index) ? line : normalizeLongForms(line, plan)));
    return { original, lines, locked, normalized };
  });
  if (!plan) return docs.map((doc) => doc.original);
  const capping = !plan.generic && plan.mention;
  const keep = capping && plan.mayUseName ? pickKeptMention(docs, plan) : null;
  return docs.map((doc, docIndex) => {
    if (!doc.original) return doc.original;
    const capped = doc.normalized.map((line, lineIndex) => {
      if (!capping || doc.locked.has(lineIndex)) return { value: line, dangling: false };
      const keepIndex = keep && keep.docIndex === docIndex && keep.lineIndex === lineIndex ? keep.index : -1;
      return capMentions(line, plan, keepIndex);
    });
    let changed = false;
    const next = [];
    for (let index = 0; index < doc.lines.length; index += 1) {
      const line = doc.lines[index];
      const value = capped[index].value;
      // "ไม่ทราบว่า คุณ⏎เคยใช้ AI…" -> "ไม่ทราบว่า คุณเคยใช้ AI…" (บรรทัดถัดไปคือประโยคเดียวกัน)
      // บรรทัดที่ต่อเข้ามาไม่ถูกแตะ จึงไม่ผ่าน tidyLine (คงวรรค "แล้วคะ ?" ของต้นฉบับ)
      let tail = "";
      const follower = capped[index + 1];
      if (capped[index].dangling && follower && follower.value.trim() && !doc.locked.has(index + 1)) {
        const untouched = follower.value === doc.lines[index + 1];
        tail = untouched ? follower.value.replace(/^[ \t]+/u, "") : tidyLine(follower.value);
        index += 1;
      }
      if (value === line && !tail) {
        next.push(line);
        continue;
      }
      changed = true;
      const tidied = `${tidyLine(value)}${tail}`;
      // บรรทัดที่เหลือแต่ชื่อ แล้วชื่อถูกตัด = ลบทั้งบรรทัด ไม่ทิ้งบรรทัดว่างเกิน
      if (tidied || !line.trim()) next.push(tidied);
    }
    return changed ? next.join("\n").replace(/\n{3,}/gu, "\n\n").trim() : doc.original;
  });
}

/**
 * ด่านชื่อหลังร่าง — ชื่อเต็ม/handle เป็นชื่อต้นเสมอ และเรียกชื่อได้ไม่เกินหนึ่งครั้งต่อข้อความ
 * (ไม่เรียกเลยเมื่ออยู่ในช่วงพักการเรียกชื่อ) ข้อความที่ไม่มีชื่อผ่านไปทุกไบต์
 */
export function enforceCustomerAddress(text, plan) {
  return enforceTexts([text], plan)[0];
}

// หลายบอลลูนของเทิร์นเดียว (follow-up: บอลลูนรีวิว + บอลลูนคำถาม) ใช้โควตาเรียกชื่อก้อนเดียวกัน
export function enforceCustomerAddressAll(texts, plan) {
  return enforceTexts(Array.isArray(texts) ? texts : [], plan);
}

// 2026-10-03 (พี่ง้วง: 6.1 Sol "ตอบแชทแข็งเกินไป"): ห้องที่ไม่มีชื่อเรียกได้ โมเดลเรียก "คุณลูกค้า" กลางแชท
// (ครึ่งหนึ่งของคำตอบในชุด blind test 2 ต.ค.) ฟังเหมือนระบบตอบอัตโนมัติ — แอดมินคนจริงไม่เรียกเลย
// ตัดคำนี้ออกจากร่างของโมเดลด้วยกลไกเดียวกับการตัดชื่อเกินโควตา (โควตา 0): หลังคำเชื่อม (ให้/ของ/สำหรับ/ว่า ...)
// เหลือ "คุณ" · บรรทัดลิงก์/บล็อกรีวิวไม่แตะ · "ขอบคุณลูกค้า" / "บุญคุณลูกค้า" ไม่ใช่การเรียก
// ใช้กับข้อความที่โมเดลเขียนเท่านั้น — template ตายตัวบางชุดตั้งใจใช้คำนี้ (ผู้เรียกเป็นคนเลือก)
const GENERIC_MENTION_PLAN = Object.freeze({
  generic: false,
  label: GENERIC_ADDRESS_LABEL,
  name: GENERIC_ADDRESS_LABEL,
  pronoun: "คุณ",
  mayUseName: false,
  mention: new RegExp(`(?<!ขอบ)(?<!บุญ)(?<!พระ)${escapeRegex(GENERIC_ADDRESS_LABEL)}`, "gu"),
  longForms: [],
  relativeNoun: "ลูกค้า",
});
// บันไดเปิดบทสนทนาที่โมเดลลอกมาพร้อม "คุณลูกค้า" ท้ายบรรทัด — persona ห้องไม่มีชื่อใช้ "ไม่ทราบว่าเคยใช้ AI…" ตรงตัว
// ไม่กลืน "คุณลูกค้าที่…/และ…" (คำนามทั่วไป/ประธานร่วม ให้ capMentions ตัดสิน) · กลืนคำลงท้ายที่ห้อยท้ายบรรทัดไปด้วย
const GENERIC_LADDER_ADDRESS = /ไม่ทราบว่า[ \t]*คุณลูกค้า(?!ที่|และ|หรือ|เอง)(?:[ \t]*(?:คะ|ค่ะ|ครับ)(?=[\s,!?]|$))?[ \t]*(?:\n[ \t]*)?/gu;

export function dropGenericAddress(text, plan) {
  const value = String(text ?? "");
  if (!plan?.generic || !value.includes(GENERIC_ADDRESS_LABEL)) return value;
  const dropped = enforceTexts([value.replace(GENERIC_LADDER_ADDRESS, "ไม่ทราบว่า")], GENERIC_MENTION_PLAN)[0];
  if (dropped === value) return value;
  // วงเล็บ/เครื่องหมายคำพูดที่เหลือว่างหลังตัดคำ ("(คุณลูกค้า)") และช่องว่างซ้อนกลางบรรทัด
  // (เครื่องหมายคำพูดตรงเอาเฉพาะคู่ที่ว่างจริง — '"Basic" "Pro"' ต้องไม่ถูกรวบ)
  return dropped.replace(/[(（][ \t]*[)）]|“[ \t]*”|""/gu, "").replace(/(\S)[ \t]{2,}(?=\S)/gu, "$1 ").trim();
}

// บรรทัดพรอมต์ของห้องที่ไม่มีชื่อเรียกได้ — ไม่สั่งให้เรียก "คุณลูกค้า" (ด่านหลังร่างตัดให้อีกชั้น)
export function genericAddressRule() {
  return "- ยังไม่มีชื่อที่ใช้เรียกลูกค้าคนนี้ได้ (ชื่อโปรไฟล์ไม่เหมาะเอามาเรียก): ไม่ต้องเรียกชื่อ และไม่เรียกว่า \"คุณลูกค้า\" กลางบทสนทนา "
    + "(ฟังเหมือนระบบตอบอัตโนมัติ) — ภาษาไทยในแชทละการเรียกได้ ถ้าจำเป็นต้องเอ่ยถึงให้ใช้ \"คุณ\" "
    + "และห้ามถามชื่อลูกค้าเพื่อหาเรื่องคุยต่อ";
}

// บรรทัดพรอมต์ของเทิร์นที่อยู่ในช่วงพักการเรียกชื่อ (เทิร์นอื่นใช้บรรทัดเดิมทุกไบต์)
export function nameRestRule(plan) {
  return "- ข้อความนี้ไม่ต้องเรียกชื่อลูกค้า เพราะเพิ่งเรียกไปในข้อความก่อน ๆ (เรียกถี่แล้วเหมือนระบบส่งอัตโนมัติ) "
    + `ถ้าต้องเอ่ยถึงให้ใช้ "${plan?.pronoun || "คุณ"}" หรือละไว้ ห้ามใช้ชื่อ-นามสกุลเต็ม และห้ามถามชื่อลูกค้าเพื่อหาเรื่องคุยต่อ`;
}

export { GENERIC_ADDRESS_LABEL };
