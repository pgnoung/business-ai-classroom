// brain/gate5select.mjs — "การแก้ครั้งนี้ไปแตะบทสนทนาไหนบ้าง"
//
// แยกไฟล์จาก gate5.mjs เพื่อคุมขนาด (< 400 บรรทัด) — เนื้อหาและเจตนาเหมือนเดิมทุกบรรทัด
import { normalizeThai } from "./text.mjs";
import { parseGoldenJson as parseJson } from "./goldenJson.mjs";

/**
 * เลือกบทสนทนาที่ "การแก้ครั้งนี้ไปแตะ" — ต้องไม่ใช่ทั้งคลัง และต้องไม่น้อยเกินไป
 *
 * สี่ทางเลือก รวมกันแล้วตัดซ้ำ:
 *   1. floor — เคส severity=irreversible ถูกเลือก **เสมอ** ไม่ว่าจะแก้อะไร
 *      (ai_off / needs_human / team_notified / price_not_approved คือของที่พังแล้วกู้ไม่ได้
 *       ลูกค้าโอนเงินไปแล้วไม่มีใครรู้ — ไม่มีเหตุผลใดที่ยอมข้าม)
 *   2. ราคา — ถ้าแตะการ์ด price เลือกทุกเคสที่พูดเรื่องเงิน เพราะ `approvedAmounts`
 *      ของเฟสนี้เป็นชุดเดียวทั้งธุรกิจ (ไม่ได้แยกตามสินค้า) การแก้ราคาใบเดียวจึงเปลี่ยน
 *      สิ่งที่ด่านราคายอมรับ "ทุกห้อง" — เลือกเฉพาะสินค้าเดียวกันคือเลือกน้อยเกินไป
 *   3. ขอบเขต — เคสที่ scope.product ทับกับการ์ดที่แตะ ("*" ทับได้ทุกอย่าง)
 *   4. จับคำ — เคสที่ข้อความมีวลีเด่นของการ์ดที่แตะ (ชื่อสินค้า/หัวข้อความรู้/ป้ายราคา)
 *      ซื่อสัตย์ว่านี่คือ "น่าจะเกี่ยว" ไม่ใช่ "โมเดลใช้การ์ดใบนี้" — ไม่มีใครรู้ข้อหลัง
 *      เพราะทุกการ์ดถูกปักหมุดเข้า prompt พร้อมกัน (แบบแปลน §1)
 *
 * ที่จงใจ **ไม่** เลือก: เคสคนละสินค้า ที่ไม่มีคำร่วม และไม่ใช่ floor — เช่นเพิ่มรอบเรียน
 * ของคลาสออนไลน์ ไม่ต้องลากบทสนทนาเรื่องที่จอดรถของคลาสสดมาตรวจทั้งชุด
 *
 * @returns {Map<string, {turns: object[], reasons: string[]}>} คีย์ = case_id
 */
export function selectGoldenCases({ turns = [], cards = [], touched = [] } = {}) {
  const touchedIds = new Set(touched.map(String));
  const touchedCards = cards.filter((card) => touchedIds.has(String(card.itemId)));
  const touchedKinds = new Set(touchedCards.map((card) => card.kind));
  const products = productScopeOf(touchedCards);
  const phrases = salientPhrases(touchedCards);

  const selected = new Map();
  const add = (turn, reason) => {
    const caseId = String(turn.case_id);
    const entry = selected.get(caseId) ?? { turns: [], reasons: [] };
    if (!entry.turns.some((row) => row.turn_id === turn.turn_id)) entry.turns.push(turn);
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    selected.set(caseId, entry);
  };

  // เลือกทั้งเคสเมื่อเทิร์นใดเทิร์นหนึ่งเข้าเงื่อนไข — บทสนทนาตัดครึ่งแล้วตรวจไม่ได้
  const byCase = new Map();
  for (const turn of turns) {
    const list = byCase.get(String(turn.case_id)) ?? [];
    list.push(turn);
    byCase.set(String(turn.case_id), list);
  }

  for (const [caseId, list] of byCase) {
    const sorted = [...list].sort((a, b) => Number(a.turn_no) - Number(b.turn_no));
    const expects = sorted.flatMap((turn) => parseJson(turn.expected_json, []));
    const text = normalizeThai(sorted.map(caseTextOf).join("\n"));
    const scopeProducts = productsOf(sorted);

    // floor = เคสที่พังแล้วกู้ไม่ได้ (ลูกค้าโอนเงินแล้วไม่มีใครรู้) ถูกเลือกเสมอ
    // **รวมถึงเคสที่เจ้าของปิดไปแล้ว** — ปุ่ม "เกณฑ์นี้ล้าสมัย" ปิดเกณฑ์ที่ไม่ทันสมัยได้
    // แต่ปิดด่านที่กันเรื่องกู้ไม่ได้ไม่ได้ (สัญญาข้อนี้เขียนไว้ทั้งใน schema, store, API และบนจอ)
    if (sorted.some((turn) => turn.severity === "irreversible")) {
      for (const turn of sorted) add(turn, sorted.some((row) => row.retired_at) ? "floor_retired" : "floor");
      continue;
    }
    // เคสที่ถูกปิดและไม่ใช่ floor ไม่ต้องตรวจ — นั่นคือความหมายของการปิด
    if (sorted.some((turn) => turn.retired_at)) continue;
    if (touchedKinds.has("price") && mentionsMoney(expects, text)) {
      for (const turn of sorted) add(turn, "price_table");
      continue;
    }
    if (scopeOverlaps(products, scopeProducts)) {
      for (const turn of sorted) add(turn, "scope");
      continue;
    }
    if (phrases.some((phrase) => text.includes(phrase))) {
      for (const turn of sorted) add(turn, "keyword");
      continue;
    }
    void caseId;
  }
  return selected;
}

function caseTextOf(turn) {
  return [turn.synthetic_text ?? "", turn.recorded_model_output ?? ""].join("\n");
}

function productsOf(turns) {
  const out = new Set();
  for (const turn of turns) {
    const scope = parseJson(turn.scope_json, {});
    const product = scope?.product;
    if (product === "*" || product === undefined || product === null) out.add("*");
    else for (const value of Array.isArray(product) ? product : [product]) out.add(String(value));
  }
  return out;
}

/**
 * สินค้าที่การ์ดที่ถูกแตะ "ระบุชื่อ" — จงใจทิ้ง "*" ทิ้ง
 *
 * เหตุผลสำคัญ: การ์ดความรู้ทั่วไป (เช่น "ที่จอดรถ") ไม่มี scope.product ซึ่งในสายตา
 * คอมไพเลอร์แปลว่า "ใช้กับทุกสินค้า" ถ้าเอาความหมายนั้นมาใช้เลือกบทสนทนาด้วย
 * กฎข้อนี้จะเลือก **ทั้งคลัง** ทุกครั้งที่มีคนแก้ความรู้ใบใดใบหนึ่ง = ด่านที่ช้าและ
 * ส่งเสียงดังจนไม่มีใครฟัง การ์ดที่ไม่ระบุสินค้าจึงตกไปให้กฎ "จับคำ" ตัดสินแทน
 */
function productScopeOf(cards) {
  const out = new Set();
  for (const card of cards) {
    const product = card?.scope?.product;
    if (product !== "*" && product !== undefined && product !== null) {
      for (const value of Array.isArray(product) ? product : [product]) out.add(String(value));
    }
    // ราคา/สินค้าเก็บชื่อสินค้าไว้ในเนื้อ ไม่ใช่ใน scope เสมอไป
    const key = card?.body?.product_key ?? card?.body?.name_th;
    if (key) out.add(String(key));
  }
  return out;
}

/**
 * ทับกันเฉพาะเมื่อ **ทั้งสองฝั่งระบุชื่อสินค้า** และชื่อตรงกัน
 *
 * เดิมฝั่งเคสที่เป็น "*" ถูกอ่านว่า "เข้ากับทุกอย่าง" ซึ่งทำให้กฎข้อนี้เลือกทั้งคลังทุกครั้ง
 * ที่มีการแก้การ์ดที่ระบุสินค้า — ตรงข้ามกับสิ่งที่คำอธิบายของมันเองบอกไว้ และเคสในคลัง
 * วันนี้เป็น "*" หมดทุกใบ (ไฟล์ scenario ไม่เคยเก็บสินค้า) กฎจึงกลายเป็น "เลือกทุกอย่าง"
 * ตอนนี้ "*" แปลว่า "ไม่ได้ผูกสินค้า" และให้กฎจับคำเป็นคนตัดสินแทน ซึ่งซื่อสัตย์กว่า
 */
function scopeOverlaps(cardProducts, caseProducts) {
  if (!cardProducts.size) return false;
  for (const value of cardProducts) if (value !== "*" && caseProducts.has(value)) return true;
  return false;
}

// วลีที่ยาวพอจะมีความหมาย — ภาษาไทยไม่มีเว้นวรรค การตัดคำแบบเดาจึงแย่กว่าการเทียบวลีตรง ๆ
const PHRASE_MIN = 4;
function salientPhrases(cards) {
  const out = new Set();
  const push = (value) => {
    const text = normalizeThai(String(value ?? "")).trim();
    if (text.length >= PHRASE_MIN && text.length <= 60) out.add(text);
  };
  for (const card of cards) {
    push(card?.body?.title);
    push(card?.body?.name_th);
    push(card?.body?.name_en);
    push(card?.body?.label_th);
    for (const alias of card?.body?.aliases ?? []) push(alias);
    for (const question of card?.body?.question_th ?? []) push(question);
  }
  return [...out];
}

const MONEY_EXPECTS = new Set(["no_price", "must_have_price"]);
const MONEY_RE = /(?<![\d.])(\d{1,3}(?:,\d{3})+|\d{4,6})(?![\d.])/u;
function mentionsMoney(expects, text) {
  return expects.some((expect) => MONEY_EXPECTS.has(expect?.type)) || MONEY_RE.test(text);
}
