// slots.mjs — ช่องเติมที่ระบบเติมเอง {{บันได}} {{ราคา}} {{ดีล}} {{รีวิว}} (spec v3.1 §B6 / §F ข้อ 4)
// บันไดคัดเลือกจาก persona ตรงตัว (น้ำเสียงเส้น legacy ใน soul ของลูกแพร) — เทสต์ล็อกว่าทุกบรรทัดเป็นส่วนหนึ่งของน้ำเสียงนั้น
export const LADDER_IMAGE_KEY = "ai-stage-ladder";
export const LADDER_QUESTION_TAIL = "เคยใช้ AI มาประมาณ ระดับที่เท่าไหร่แล้วคะ ?";
export const LADDER_QUESTION_GENERIC = `ไม่ทราบว่า${LADDER_QUESTION_TAIL}`;
export const LADDER_LINES = Object.freeze([
  "1️⃣ ยังไม่เคยใช้เลย (แต่สนใจมากๆ อยากรู้ว่าใช้ยังไง)",
  "2️⃣ เคยลองเล่นนิดหน่อย (ถามเล่น, แปลภาษา, ฯลฯ)",
  "3️⃣ ใช้ช่วยงานจริงบ้างแล้ว (สรุป, เขียนอีเมล, เขียนแคปชั่น ฯลฯ)",
  "4️⃣ ใช้ประจำ และอยากรู้จักเทคนิคใหม่ๆ เพิ่มเติม",
  "5️⃣ สร้าง AI ขององค์กรเอง (สร้าง Custom GPT ของตัวเอง หรือของแต่ละแผนกได้)",
]);
export const SLOT_NAMES = Object.freeze(["บันได", "ราคา", "ดีล", "รีวิว"]);
const TOKEN = /\{\{([^{}\n]{1,16})\}\}/gu;

/** address = แผนการเรียกชื่อจาก planCustomerAddress · ชื่อเรียกได้ = แบบสองบรรทัดของ persona */
export function renderLadder(address = null, { withImage = false } = {}) {
  const named = address && !address.generic && address.mayUseName && address.label;
  const question = named ? `ไม่ทราบว่า ${address.label}\n${LADDER_QUESTION_TAIL}` : LADDER_QUESTION_GENERIC;
  return `${withImage ? `[IMAGE:${LADDER_IMAGE_KEY}]\n\n` : ""}${question}\n\n${LADDER_LINES.join("\n\n")}`;
}

export function renderReviewSlot(review) {
  return review?.who && review?.url ? `${review.who}\n${review.url}` : null;
}

/** ชื่อช่องที่โผล่ในข้อความ (ซ้ำได้) */
export function slotTokens(text = "") {
  return [...String(text).matchAll(TOKEN)].map((match) => match[1].trim());
}

export function stripTokens(text = "", keep = new Set()) {
  return String(text).replace(TOKEN, (whole, name) => (keep.has(name.trim()) ? whole : ""));
}

// ช่องที่วางกลางประโยค -> ย้ายออกมาเป็นย่อหน้าของตัวเอง (ช่องหนึ่งช่องคือก้อนหลายบรรทัด)
function isolateToken(paragraph, token) {
  const marker = `{{${token}}}`;
  const lines = paragraph.split("\n");
  const out = [];
  let moved = false;
  for (const line of lines) {
    if (!line.includes(marker) || line.trim() === marker) { out.push(line); continue; }
    const [before, ...rest] = line.split(marker);
    if (before.trim()) out.push(before.trimEnd());
    out.push("", marker, "");
    const after = rest.join(marker).trim();
    if (after) out.push(after);
    moved = true;
  }
  return { text: out.join("\n").replace(/\n{3,}/gu, "\n\n"), moved };
}

/**
 * แทนช่องที่เปิดด้วยค่าที่ระบบเติม · ช่องที่ไม่ได้เปิดไม่แตะ (postCheck ตัดเองก่อนหน้านี้)
 * @returns {{text: string, used: string[], missing: string[], inline: string[]}}
 */
export function expandSlots(text = "", values = {}, { required = [] } = {}) {
  let value = String(text);
  const present = new Set(slotTokens(value));
  const inline = [];
  for (const name of Object.keys(values)) {
    if (!present.has(name)) continue;
    const isolated = isolateToken(value, name);
    if (isolated.moved) inline.push(name);
    value = isolated.text;
  }
  const missing = required.filter((name) => !present.has(name) && values[name]);
  const used = [];
  value = value.replace(TOKEN, (whole, raw) => {
    const name = raw.trim();
    if (!values[name]) return whole;
    // ช่องเดียวกันซ้ำสองที่ = เติมที่แรกที่เดียว
    if (used.includes(name)) return "";
    used.push(name);
    return values[name];
  });
  return { text: value.replace(/\n{3,}/gu, "\n\n").trim(), used, missing, inline };
}

/** วางช่องบังคับที่โมเดลลืม: "end" = ท้ายข้อความ · "beforeLast" = ก่อนย่อหน้าสุดท้าย */
export function insertSlot(text = "", name, where = "beforeLast") {
  const marker = `{{${name}}}`;
  const paragraphs = String(text).split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  if (where === "end" || paragraphs.length < 2) return [...paragraphs, marker].join("\n\n");
  return [...paragraphs.slice(0, -1), marker, paragraphs.at(-1)].join("\n\n");
}
