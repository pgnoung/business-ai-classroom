// priceFacts.mjs — ตัวเลขค่าเรียนของช่อง {{ราคา}} / {{ดีล}} (spec v3.1 §B6)
// โมเดลไม่พิมพ์ตัวเลขเงินเองเลย: อ่านจากการ์ดราคา/ส่วนลดที่อนุมัติ แล้วเทียบกับชุดราคาที่อนุมัติทุกตัว
// ตัวไหนไม่อยู่ในชุดอนุมัติ = null (ช่องนั้นเติมไม่ได้ → เทิร์นนั้นกลับไปเครื่องเดิม)
const PIN = "\u{1F4CC}";
export const CLASS_NAMES = Object.freeze({
  business: "AI Agent for Business",
  workflow: "AI Agent Workflow Automation",
});
const SECTION_TEST = Object.freeze({ business: /AI Agent for Business/u, workflow: /Workflow Automation/u });
const PRICE_LINE = /ราคาปกติ\s*([\d,]+)\s*บาท.*?(?:โปรโมชั่น|Early Bird)\D*([\d,]+)/u;
const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const toNumber = (raw) => {
  const value = Number(String(raw || "").replace(/,/gu, ""));
  return Number.isFinite(value) && value > 0 ? value : null;
};
const approvedOrNull = (value, approved) => (value !== null && approved.has(value) ? value : null);
export const formatBaht = (value) => Number(value).toLocaleString("en-US");

function sectionsOf(content) {
  return String(content || "").split(/^(?=\d\)\s)/mu);
}

function classPrices(entry, approved) {
  const out = {};
  for (const [key, test] of Object.entries(SECTION_TEST)) {
    const section = entry ? sectionsOf(entry.content).find((part) => /^\d\)\s/u.test(part) && test.test(part)) : null;
    const match = section ? PRICE_LINE.exec(section) : null;
    out[key] = {
      name: CLASS_NAMES[key],
      normal: approvedOrNull(toNumber(match?.[1]), approved),
      promo: approvedOrNull(toNumber(match?.[2]), approved),
    };
  }
  return out;
}

function pairPrices(entry, approved) {
  const section = entry ? sectionsOf(entry.content).find((part) => /^\d\)\s/u.test(part) && /2 ท่าน/u.test(part)) : null;
  const out = {};
  for (const [key, name] of Object.entries(CLASS_NAMES)) {
    const match = section ? new RegExp(`${escapeRegex(name)} จาก [\\d,]+ เหลือท่านละ ([\\d,]+)`, "u").exec(section) : null;
    out[key] = approvedOrNull(toNumber(match?.[1]), approved);
  }
  return out;
}

/**
 * @param {Array<{title: string, content: string}>} entries
 * @param {Set<number>} approvedAmounts ชุดราคาต่อท่านที่อนุมัติ (ตัวเดียวกับที่ไปป์ไลน์ใช้ตัดสินจังหวะราคา)
 */
export function priceFactsFromKnowledge(entries = [], approvedAmounts = null) {
  const approved = approvedAmounts instanceof Set ? approvedAmounts : new Set();
  const list = Array.isArray(entries) ? entries : [];
  const catalog = list.find((entry) => /ราคา/u.test(entry?.title || "") && /คลาส|บริการ/u.test(entry?.title || ""));
  const discount = list.find((entry) => /ส่วนลด/u.test(entry?.title || ""));
  const classes = classPrices(catalog, approved);
  const pair = pairPrices(discount, approved);
  const ok = Boolean(catalog) && Object.values(classes).some((item) => item.normal !== null);
  return { ok, classes, pair };
}

/** ช่อง {{ราคา}} — คลาสตามลำดับที่ขอ คั่นด้วยบรรทัดว่าง · ตัวเลขขาด = null */
export function renderPriceSlot(pf, { products = ["business"], withPromo = true } = {}) {
  const blocks = [];
  for (const product of products) {
    const item = pf?.classes?.[product];
    if (!item || item.normal === null || (withPromo && item.promo === null)) return null;
    blocks.push(withPromo
      ? `${PIN} ${item.name}\nราคาปกติ ${formatBaht(item.normal)} บาท\nโปรโมชั่น Early Bird ${formatBaht(item.promo)} บาท/ท่าน`
      : `${PIN} ${item.name}\nราคา ${formatBaht(item.normal)} บาท/ท่าน`);
  }
  return blocks.length ? blocks.join("\n\n") : null;
}

/** ช่อง {{ดีล}} — ไม่พิมพ์ส่วนต่าง 1,000 โดยเจตนา (อาจไม่อยู่ในตารางอนุมัติ) */
export function renderDealSlot(pf, { product = "business", n = 2 } = {}) {
  const item = pf?.classes?.[product];
  const pair = pf?.pair?.[product];
  const count = Number(n);
  if (!item || item.promo === null || !pair || !Number.isInteger(count) || count < 2) return null;
  return `${PIN} ${item.name} มาเรียน ${count} ท่าน\nจากโปรโมชั่น ${formatBaht(item.promo)} บาท เหลือท่านละ ${formatBaht(pair)} บาท\n`
    + `รวม ${count} ท่าน ${formatBaht(pair * count)} บาท\nเงื่อนไขคือชำระเงินและออกเอกสารในบิลเดียวกันนะคะ`;
}
