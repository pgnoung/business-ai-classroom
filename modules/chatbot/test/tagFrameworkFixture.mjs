// tagFrameworkFixture.mjs — กรอบป้ายขนาดเล็กสำหรับเทสต์ (ไม่ผูกกับไฟล์กรอบจริงของธุรกิจใด)
// สร้างวัตถุใหม่ทุกครั้ง — เทสต์ที่แก้ fixture เพื่อทดสอบไฟล์พังต้องไม่รั่วไปเทสต์อื่น
const levels = () => ["1 มือใหม่", "2 เคยลอง", "3 ใช้ช่วยงาน", "4 ใช้ประจำ", "5 สร้างระบบ"].map((value, i) => ({ value, level: i + 1 }));

export function fixtureInput(overrides = {}) {
  return {
    schemaVersion: 1,
    businessId: "pngoung-tidkradum",
    frameworkId: "fixture",
    dimensions: [
      { key: "สนใจ", setBy: "ai", max: 3, merge: "accumulate", values: [
        { value: "AI Agent for Business" }, { value: "AI Workflow Automation" },
        { value: "คลาสออนไลน์ Custom GPTs" }, { value: "In-house" },
      ] },
      { key: "ขั้น", setBy: "ai", max: 1, merge: "funnel", values: [
        { value: "สอบถามข้อมูล", rank: 1 }, { value: "ถามราคา", rank: 2 }, { value: "ถามรอบเรียน", rank: 3 },
        { value: "พร้อมสมัคร", rank: 4 }, { value: "ขอคิดก่อน", parked: 1 }, { value: "ยังไม่สนใจ", parked: 2 },
        { value: "รอโอน", rank: 5, setBy: "human" },
      ] },
      { key: "ระดับAI", setBy: "ai", max: 1, merge: "latest", factKey: "ai_level", values: levels() },
      { key: "อาชีพ", setBy: "ai", max: 1, merge: "latest", values: [
        { value: "ร้านอาหาร/คาเฟ่", persona: ["restaurant_cafe"] },
        { value: "เจ้าของกิจการ/SME", persona: ["sme_owner", "senior_owner"] },
      ] },
      { key: "ใช้ทำ", setBy: "ai", max: 2, merge: "accumulate", values: [
        { value: "คอนเทนต์/การตลาด" }, { value: "รูป/วิดีโอ" }, { value: "ข้อมูล/Excel" },
      ] },
      { key: "ของแจก", setBy: "human", open: true },
    ],
    systemTags: ["customer", "null", "ดีลร้อนค้าง", "คลาสฟรี"],
    buyerMarkers: { exact: ["customer", "ลงทะเบียนแล้ว"], prefixes: ["ซื้อแล้ว"] },
    segments: [{ id: "basic", name: "สนใจคลาสเริ่มต้น", include: ["สนใจ: AI Agent for Business"], exclude: ["@buyers"] }],
    legacyRules: [
      { id: "block", block: "ข้อมูลอ่อนไหว", pattern: "(ป่วย|พิการ)" },
      { id: "price", tags: ["ขั้น: ถามราคา"], pattern: "(ราคา|ค่าเรียน)" },
      { id: "inquiry", tags: ["ขั้น: สอบถามข้อมูล"], pattern: "(ถาม|สอบถาม)" },
      { id: "basic", tags: ["สนใจ: AI Agent for Business"], pattern: "(ai\\s*agent)", unless: "(workflow)" },
      { id: "advance", tags: ["สนใจ: AI Workflow Automation"], pattern: "(workflow)" },
      { id: "video", tags: ["ใช้ทำ: รูป/วิดีโอ"], pattern: "(คลิป|วิดีโอ)" },
      { id: "content", tags: ["ใช้ทำ: คอนเทนต์/การตลาด"], pattern: "(คอนเทนต์)" },
      { id: "data", tags: ["ใช้ทำ: ข้อมูล/Excel"], pattern: "(excel)" },
      { id: "noise", drop: "ไม่มีข้อมูลแบ่งกลุ่ม", pattern: "(^ai$|^chatgpt$)" },
    ],
    legacyHumanTags: [
      { match: "^สนใจGEN AI Classroom$", kind: "interest", to: ["สนใจ: AI Agent for Business"], confirm: true },
      { match: "^รอโอน$", kind: "status", to: ["ขั้น: รอโอน"] },
    ],
    ...overrides,
  };
}

/**
 * กรอบที่เปิดใช้จริงแบบย่อ (พี่ง้วงตอบ 28 ก.ย.): ค่า archived · มิติปิดของทีม · มิติการซื้อ dynamic ของระบบ
 * customer = ป้ายซื้อแล้วใบเดียว + ซื้อครั้งที่: = เคยซื้อ
 */
export function fixtureWithPurchase(overrides = {}) {
  const base = fixtureInput();
  return {
    ...base,
    dimensions: [
      ...base.dimensions.map((dim) => (dim.key !== "สนใจ" ? dim : {
        ...dim, values: [...dim.values, { value: "คลาส LINE OA", archived: true, replacedBy: "In-house" }],
      })),
      { key: "ติดต่อ", setBy: "human", max: 3, merge: "accumulate", values: [{ value: "งานรีวิว" }] },
      { key: "ซื้อครั้งที่", setBy: "system", open: true, dynamic: true },
      { key: "ซื้อล่าสุด", setBy: "system", open: true, dynamic: true },
      { key: "ซื้อแล้ว", setBy: "system", open: true },
    ],
    buyerMarkers: { exact: ["customer"], prefixes: ["ซื้อครั้งที่:"] },
    purchaseTags: {
      countDimension: "ซื้อครั้งที่", lastDimension: "ซื้อล่าสุด",
      legacyCountTags: { "ซื้อครั้งแรก": 1, "ซื้อครั้งที่สอง": 2, "ซื้อครั้งที่สาม": 3 }, legacyMonthTags: true,
    },
    legacyHumanTags: [
      { match: "^สนใจGEN AI Classroom$", kind: "interest", to: ["สนใจ: AI Agent for Business"] },
      { match: "^รอโอน$", kind: "status", to: ["ขั้น: รอโอน"] },
      { match: "^ซื้อครั้ง(แรก|ที่สอง|ที่สาม)$", kind: "purchase_count" },
      { match: "^(AI Class|GEN AI Class room)$", kind: "purchase" },
      { match: "^ติดต่อ ?งานรีวิว$", kind: "contact", to: ["ติดต่อ: งานรีวิว"] },
    ],
    ...overrides,
  };
}

