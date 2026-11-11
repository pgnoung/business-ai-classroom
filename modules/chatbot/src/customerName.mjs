// customerName.mjs — F2: ดึง "ชื่อจริงที่ลูกค้าแจ้ง" จากข้อความแชทแบบ deterministic
//
// หลักคิด: conservative ก่อนเสมอ — จับพลาด (ได้ชื่อผิด) แย่กว่าจับไม่ได้
// (แอดมินแก้เองได้จาก console) — regex ไทยล้วน ไม่มี AI เอี่ยวในเส้นนี้

const NAME_TOKEN = "[\\p{Script=Thai}A-Za-z][\\p{Script=Thai}A-Za-z0-9.]*";
const NAME_GROUP = `(${NAME_TOKEN}(?:[ \\t]${NAME_TOKEN})?)`;

// รูปประโยคที่ลูกค้าไทยใช้บอกชื่อ: "ผม/ดิฉัน/เราชื่อ X", "ชื่อ X ค่ะ", "เรียก X ก็ได้"
// v1.4.8 (เคสคุณมนตรี 2026-08-16): สรรพนามต้องอยู่ต้นคำจริง — "ภรรยาผมชื่อแดง" /
// "หัวหน้าเราชื่อสมชาย" คือชื่อบุคคลที่สาม ห้ามจับ (ขอบคำหน้าสรรพนามบังคับ)
const PATTERNS = [
  new RegExp(`(?:^|[\\s,])(?:ผม|ดิฉัน|ฉัน|เรา|หนู)ชื่อ(?:เล่น)?(?:ว่า)?[ \\t]*${NAME_GROUP}`, "mu"),
  new RegExp(`^[ \\t]*ชื่อ(?:เล่น)?(?:ว่า)?[ \\t]*${NAME_GROUP}`, "mu"),
  new RegExp(`เรียก(?:ว่า)?[ \\t]*${NAME_GROUP}[ \\t]*(?:ก็ได้|ได้เลย|ละกัน|แล้วกัน)`, "u"),
];

// v1.4.8: บริบทบุคคลที่สาม — ชื่อที่โผล่ใกล้คำพวกนี้คือ "คนที่ถูกพูดถึง" ไม่ใช่ผู้พิมพ์
// (ผู้ถูกส่งมาเรียน / ทีมงาน / ผู้ติดต่อ / คนในครอบครัว) — เคสจริง: บอทเรียกลูกค้าว่า
// "คุณมนตรี" ทั้งที่มนตรีคือหัวหน้าที่ลูกค้าจะส่งมาเรียน
const THIRD_PARTY_CONTEXT =
  /(?:(?:ส่ง|ให้|พา)[^\n]{0,25}(?:มาเรียน|ไปเรียน|เรียนแทน|มาแทน|เข้าเรียน)|มาเรียนแทน|เรียนแทน|ทีมงาน|หัวหน้า|ผู้จัดการ|เลขา(?:นุการ)?|ผู้ติดต่อ|ผู้ประสาน|ผู้รับ(?:ของ|เอกสาร)|ภรรยา|สามี|แฟน|ลูกชาย|ลูกสาว|ลูกน้อง|น้อง(?:ชาย|สาว)?|พนักงาน|เพื่อน(?:ร่วมงาน)?|ชื่อผู้เรียน|คนที่(?:จะ)?มาเรียน)/u;

/**
 * ชื่อนี้น่าจะเป็นบุคคลที่สาม (ไม่ใช่ผู้พิมพ์) ไหม — ดูบริบทรอบทุกตำแหน่งที่ชื่อโผล่
 * ใช้การ์ดตอนเขียน known_name ทั้งเส้น deterministic และเส้น scorer
 */
export function nameLooksThirdParty(name, contextText) {
  const value = String(name || "").trim();
  const text = String(contextText || "");
  if (!value || !text) return false;
  // คนไทยไม่เรียกตัวเองว่า "คุณX" — ชื่อที่ติดคำนำหน้ามาคือการพูดถึงคนอื่น
  if (/^(?:คุณ|พี่|ป้า|ลุง|น้า|อา)\s?/u.test(value)) return true;
  const bare = value.replace(/^(?:คุณ|พี่)\s?/u, "");
  let index = text.indexOf(bare);
  while (index !== -1) {
    const windowText = text.slice(Math.max(0, index - 45), index + bare.length + 25);
    if (THIRD_PARTY_CONTEXT.test(windowText)) return true;
    index = text.indexOf(bare, index + 1);
  }
  return false;
}

// ภาษาไทยไม่เว้นวรรค — คำลงท้าย/คำเชื่อมมักติดมากับชื่อ ต้องตัดทิ้งที่จุดแรกที่เจอ
const STOP_WORDS = [
  "ค่ะ", "คะ", "ค่า", "ครับ", "คับ", "ค้าบ", "ฮะ", "ฮ่ะ", "จ้า", "จ๊ะ", "จ้ะ",
  "นะ", "น้า", "เด้อ", "ก็ได้", "แล้วกัน", "ละกัน", "เลย", "สนใจ", "อยาก", "ขอ",
];

// 31 ส.ค. 2026: คำถามที่บังเอิญขึ้นต้นด้วย "ชื่อ" ("ชื่อคลาสนี้เรียนกี่วันครับ")
// ไม่ใช่การบอกชื่อ — คำเหล่านี้ไม่เคยอยู่ในชื่อคนไทย จึงตัดได้ทั้งก้อนอย่างปลอดภัย
// (จงใจไม่ใส่ "ไหม/มั้ย" เพราะ "ไหม" เป็นชื่อเล่นจริงที่พบบ่อย)
const QUESTION_WORDS = /(?:อะไร|ทำไม|ยังไง|อย่างไร|เท่าไหร่|เท่าไร|ที่ไหน|กี่)/u;

// คำที่บอกว่าสิ่งที่จับได้ไม่ใช่ชื่อคน (คำถาม/สินค้า/องค์กร)
const REJECT_PREFIX =
  /^(?:อะไร|ไร|หยัง|ไม่|ยัง|คือ|ว่า|เต็ม|จริง|เล่น|รุ่น|บริษัท|ร้าน|แบรนด์|สินค้า|เครื่อง|โมเดล|ลูกค้า|แอดมิน|ทีม)/u;

function cleanCapture(raw) {
  let value = String(raw || "").trim();
  // ตัดที่ stop word แรกที่โผล่ (เช่น "เบียร์นะครับสนใจX5" -> "เบียร์")
  let cut = value.length;
  for (const word of STOP_WORDS) {
    const idx = value.indexOf(word);
    if (idx > 0 && idx < cut) cut = idx;
  }
  value = value.slice(0, cut).trim();
  if (value.length < 2) return "";
  if (REJECT_PREFIX.test(value)) return "";
  if (QUESTION_WORDS.test(value)) return "";
  if (/^\d+$/.test(value)) return "";
  // 31 ส.ค. 2026: เพดาน 25 ตัวอักษรอย่างเดียวไม่พอ — "ชื่อต่ออะไรไแอีกนอกจากline oa"
  // ยาว 25 พอดีจึงรอดมาเป็นชื่อลูกค้า ต้องผ่านด่านรูปทรง "เหมือนชื่อคน" ชุดเดียวกับชื่อโปรไฟล์
  if (!looksLikePersonName(value)) return "";
  return value;
}

// คืนชื่อที่จับได้ (string) หรือ "" เมื่อไม่มั่นใจ
export function extractKnownName(text) {
  const value = String(text || "");
  if (!value.trim()) return "";
  for (const pattern of PATTERNS) {
    const match = pattern.exec(value);
    if (!match) continue;
    const name = cleanCapture(match[1]);
    if (name) return name;
  }
  return "";
}

/* --------------------- v1.2.3: ชื่อที่ใช้เรียกลูกค้าได้จริง --------------------- */
// คำสั่งพี่ง้วง 2026-08-12: ให้เรียกลูกค้าด้วยชื่อโปรไฟล์ LINE ได้ แต่ต้องถอด emoji ออก
// และถ้าชื่อนั้นไม่เหมือนชื่อคน (คำกลอน ประโยคยาว ชื่อร้าน เบอร์ ลิงก์ คำสุ่มเสี่ยง)
// ให้เรียกว่า "คุณลูกค้า" แทน — เรียกผิดครั้งเดียวเสียความน่าเชื่อถือทั้งบทสนทนา
const DECORATION = /[\p{Extended_Pictographic}️︎‍\p{Emoji_Modifier}⃣]|[|~•·♡♥★☆✦✧※＊*_=+^<>{}[\]]/gu;
const ADDRESSABLE_MAX_CHARS = 20;
const ADDRESSABLE_MAX_WORDS = 3;

// ชื่อร้าน/เพจ/โปรโมชัน = ไม่ใช่ชื่อคน; คำสุ่มเสี่ยงห้ามเอามาเรียกลูกค้าเด็ดขาด
const NOT_A_PERSON =
  /(?:ร้าน|บริษัท|หจก|บจก|ห้าง|shop|store|official|page|admin|แอดมิน|ขาย|รับสมัคร|โปรโมชั่น|ลดราคา|ฟรี|จำหน่าย|บริการ|คลินิก|สาขา|team|group|club|www|http|@|\.com|\.co\.th)/iu;

// emoji/สัญลักษณ์ตกแต่งออก + ยุบช่องว่างซ้ำ (รวมช่องว่างไทย U+0E4F/วรรคยาว) ให้เหลือชั้นเดียว
// (export 2026-09-28: ด่านชื่อหลังร่างใน customerAddress.mjs ต้องถอดของตกแต่งชุดเดียวกันเป๊ะ)
export function normalizeForAddress(raw) {
  return String(raw || "")
    .replace(DECORATION, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * ข้อความนี้ "รูปทรงเหมือนชื่อคน" พอจะเอาไปเรียกลูกค้าไหม
 * ใช้ร่วมกันทั้งชื่อจากโปรไฟล์และชื่อที่จับจากแชท — ด่านสุดท้ายก่อนเอ่ยชื่อกับลูกค้าจริง
 */
export function looksLikePersonName(raw) {
  const value = normalizeForAddress(raw);
  if (!value) return false;
  if ([...value].length > ADDRESSABLE_MAX_CHARS) return false;
  if (value.split(" ").length > ADDRESSABLE_MAX_WORDS) return false;
  if (NOT_A_PERSON.test(value)) return false;
  if ((value.match(/\d/gu) || []).length >= 3) return false;
  // ต้องมีตัวอักษรจริง ไม่ใช่สัญลักษณ์ล้วน
  return /[\p{Script=Thai}\p{Script=Latin}]{2,}/u.test(value);
}

export function addressableCustomerName({ knownName = "", displayName = "" } = {}) {
  // ชื่อที่ลูกค้าพิมพ์บอกเองในแชทน่าเชื่อถือที่สุด — แต่เคส 31 ส.ค. 2026 พิสูจน์ว่า
  // "เชื่อที่สุด" ไม่เท่ากับ "ไม่ต้องตรวจ": คำถามที่พิมพ์ผิดหลุดมาเป็นชื่อ แล้วบอทเรียก
  // ลูกค้าด้วยประโยคของเขาเอง 8 ครั้งกลางดีล — ด่านของชื่อโปรไฟล์ต้องครอบตรงนี้ด้วย
  const known = normalizeForAddress(knownName);
  if (known && looksLikePersonName(known)) return known;

  const cleaned = String(displayName || "")
    .replace(DECORATION, " ")
    .replace(/[\s ]+/gu, " ")
    .trim();
  return looksLikePersonName(cleaned) ? cleaned : "";
}

// ---- 2026-09-28 (audit ก.ย. §4.2): ชื่อที่เอาไปเรียกลูกค้า = ชื่อต้นคำเดียว ----
// ตั้งแต่ดึงชื่อโปรไฟล์ Messenger (6a1c5119, 10 ก.ย.) ข้อความ AI 32.5% มี "คุณชื่อ นามสกุล" เต็ม ๆ
// หรือ handle แปลก ๆ ("คุณ::: A :::" / "คุณMr.…" / "นาย…") สูงสุด 24 ครั้งต่อห้องต่อวัน
// แอดมินคนจริงเรียกชื่อต้นหรือชื่อเล่นคำเดียว ไม่มีนามสกุล ไม่มีคำนำหน้าทางการ
// ชื่อที่ดูไม่ใช่ชื่อคน = ไม่เรียกชื่อ (ใช้ "คุณลูกค้า") — ด่าน 31 ส.ค. (looksLikePersonName) ยังอยู่ครบ
//
// คำนำหน้าเชิงความสัมพันธ์ (พี่ น้อง ป้า ลุง น้า ครู อาจารย์ อ. หมอ) คงไว้ ห้ามเติม "คุณ" ซ้ำ
// ("คุณพี่เบียร์" อ่านแล้วเก้ ๆ กัง ๆ) — "อา" เป็นทั้งคำนำหน้าและต้นชื่อ (อาท/อาร์ต/อารีย์)
// จึงนับเป็นคำนำหน้าได้เฉพาะเมื่อมีวรรคคั่นชื่อ
// คำนำหน้าทางการ/วิชาชีพ (นาย นาง นางสาว ดร. Mr. Mrs. Ms. Dr. ...) ตัดทิ้งแล้วเรียก "คุณ" + ชื่อต้น
export const GENERIC_ADDRESS_LABEL = "คุณลูกค้า";
const RELATIONAL_TOKEN = /^(?:พี่|น้อง|ป้า|ลุง|น้า|อา|ครู|อาจารย์|อ\.|หมอ)$/u;
const RELATIONAL_PREFIX = /^(พี่|น้อง|ป้า|ลุง|น้า|ครู|อาจารย์|อ\.|หมอ)(?=\p{L})/u;
const FORMAL_TITLE_TOKEN = /^(?:คุณ|นาย|นาง|นางสาว|น\.ส\.?|ด\.ช\.?|ด\.ญ\.?|ดร\.?|นายแพทย์|แพทย์หญิง|นพ\.?|พญ\.?|ทพ\.?|ทพญ\.?|mr|mrs|ms|miss|mister|dr|khun|k)\.?$/iu;
const FORMAL_TITLE_PREFIX = /^(?:นายแพทย์|แพทย์หญิง|นางสาว|น\.ส\.|ด\.ช\.|ด\.ญ\.|ดร\.|นพ\.|พญ\.|ทพญ\.|ทพ\.|คุณ|นาย|mrs\.|mr\.|ms\.|dr\.|khun\.|k\.)(?=\p{L})/iu;
// "นาง" ติดชื่อกำกวมกับชื่อเล่นจริง (นางฟ้า) — ตัดเฉพาะชื่อทางการที่มีนามสกุลตามมา
const MRS_PREFIX_WITH_SURNAME = /^นาง(?=\p{L})/u;
// ชื่อต้น = อักษรไทยล้วน หรืออักษรละตินล้วน (ขีด/อะพอสทรอฟีกลางคำได้) — ปนสองภาษาในคำเดียว
// คือรูปของประโยค/handle ไม่ใช่ชื่อ (เคสจริง 31 ส.ค. "ต่ออะไรไแอีกนอกจากline") · มีตัวเลข = handle
// ชื่อละตินต้องมีสระ — "Dk" / "Tk" คืออักษรย่อหรือ handle ไม่ใช่ชื่อที่ใช้เรียกได้
const FIRST_NAME = /^(?:\p{Script=Thai}+|\p{Script=Latin}+(?:[-'’]\p{Script=Latin}+)*)$/u;
const LATIN_VOWEL = /[aeiouyàáâãäåæèéêëìíîïòóôõöøùúûüýÿ]/iu;
const FIRST_NAME_MAX = 14;
const NAME_MAX_TOKENS = 4;
// คำทั่วไปที่ขึ้นหน้าชื่อโปรไฟล์ได้แต่ไม่ใช่ชื่อคน — เรียก "คุณLine" แย่กว่าไม่เรียก
const NOT_A_FIRST_NAME = /^(?:admin|shop|store|official|page|team|group|club|support|online|line|facebook|ai|the|my|ลูกค้า|แอดมิน|ร้าน|เพจ|ทีม|บริษัท)$/iu;
const BRACKETED = /[(（[][^)）\]]*[)）\]]/gu;

function nameTokens(raw) {
  return normalizeForAddress(String(raw || "").replace(BRACKETED, " "))
    .split(" ")
    // สัญลักษณ์หัว-ท้ายคำ (":::", "!", "°") ไม่ใช่ส่วนของชื่อ — จุดท้ายคำเก็บไว้ก่อนเพื่อจับคำนำหน้า "Mr."
    .map((token) => token.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^\p{L}\p{M}\p{N}.]+$/u, ""))
    .filter((token) => /\p{L}/u.test(token));
}

function validFirstName(name) {
  const value = String(name || "");
  if (!FIRST_NAME.test(value) || [...value].length > FIRST_NAME_MAX) return false;
  if ((value.match(/\p{L}/gu) || []).length < 2) return false;
  if (/^\p{Script=Latin}/u.test(value) && !LATIN_VOWEL.test(value)) return false;
  return !NOT_A_FIRST_NAME.test(value);
}

function shortNameFrom(raw) {
  let tokens = nameTokens(raw);
  if (!tokens.length || tokens.length > NAME_MAX_TOKENS) return null;
  const joined = tokens.join(" ");
  if (NOT_A_PERSON.test(joined) || (joined.match(/\d/gu) || []).length >= 3) return null;
  for (let guard = 0; guard < 3 && tokens.length; guard += 1) {
    if (FORMAL_TITLE_TOKEN.test(tokens[0])) {
      tokens = tokens.slice(1);
      continue;
    }
    const prefix = FORMAL_TITLE_PREFIX.exec(tokens[0]) || (tokens.length >= 2 ? MRS_PREFIX_WITH_SURNAME.exec(tokens[0]) : null);
    if (prefix && [...tokens[0].slice(prefix[0].length)].length >= 2) {
      tokens = [tokens[0].slice(prefix[0].length), ...tokens.slice(1)];
      continue;
    }
    break;
  }
  if (!tokens.length) return null;
  let honorific = "";
  let spaced = false;
  if (tokens.length >= 2 && RELATIONAL_TOKEN.test(tokens[0])) {
    honorific = tokens[0];
    spaced = true;
    tokens = tokens.slice(1);
  } else {
    const relational = RELATIONAL_PREFIX.exec(tokens[0]);
    if (relational && [...tokens[0].slice(relational[0].length)].length >= 2) {
      honorific = relational[1];
      tokens = [tokens[0].slice(relational[0].length), ...tokens.slice(1)];
    }
  }
  const name = String(tokens[0] || "").replace(/\.+$/u, "");
  return validFirstName(name) ? { name, honorific, spaced } : null;
}

/**
 * ชื่อต้นคำเดียวที่ใช้เรียกลูกค้าได้ — ชื่อที่ลูกค้าบอกเองมาก่อน แล้วค่อยชื่อโปรไฟล์
 * @returns {{name: string, honorific: string, spaced: boolean}|null}
 */
export function shortAddressName({ knownName = "", displayName = "" } = {}) {
  return shortNameFrom(knownName) || shortNameFrom(displayName);
}

// ข้อความที่เอาไปเรียกลูกค้าได้ทันที — ไม่มีชื่อที่ใช้ได้ = "คุณลูกค้า"
export function customerAddressLabel(input = {}) {
  const short = shortAddressName(input);
  if (!short) return GENERIC_ADDRESS_LABEL;
  if (!short.honorific) return `คุณ${short.name}`;
  return short.spaced ? `${short.honorific} ${short.name}` : `${short.honorific}${short.name}`;
}
