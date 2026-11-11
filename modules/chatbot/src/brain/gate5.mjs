// brain/gate5.mjs — G5: เล่นซ้ำบทสนทนาจริงกับสมองรุ่นใหม่ โดยไม่เรียกโมเดลเลย
//
// นี่คือด่านที่ตอบคำถาม "สอนใหม่แล้วพังของเก่าไหม" ในราคาศูนย์บาท และเป็นตาข่ายประจำวัน
//
// วิธีคิด: เราไม่ต้องถามโมเดลใหม่เพื่อรู้ว่าคำตอบเก่าจะพัง — คำตอบเก่ามีอยู่แล้ว
// สิ่งที่เปลี่ยนคือ **ตารางของรุ่น** (ชุดตัวเลขที่อนุมัติ คำต้องห้าม กติกาเส้นทาง)
// เอาคำตอบเดิมมาวัดด้วยตารางใหม่ ก็เห็นทันทีว่าประโยคที่เคยผ่านกลายเป็นผิดกฎ
// ตัวอย่างที่เกิดจริงในโครงการนี้: แก้ราคา 11,900 -> 12,900 แล้วคำตอบที่บันทึกไว้ 8 ใบ
// ยังพูด 11,900 — ด่านราคาจะตัดประโยคนั้นทิ้งตอนตอบลูกค้า โดยไม่มีใครรู้จนลูกค้าถาม
//
// สิ่งที่ด่านนี้ทำไม่ได้ และต้องพูดตรง ๆ (แบบแปลน §3 ข้อ 5 "ห้ามติ๊กเขียวเมื่อไม่มีอะไรให้ตรวจ"):
//   - เคสที่ยังไม่มีคำตอบบันทึกไว้ ตรวจได้แค่ "เส้นทาง" ไม่ใช่เนื้อคำตอบ
//   - ถ้าการแก้ครั้งนี้แตะราคา/ข้อเท็จจริง แต่ไม่มีเคสไหนมีคำตอบให้เล่นซ้ำเลย
//     ผลของด่านคือ not_applicable (เทา) **ไม่ใช่ pass** — ไม่งั้นมันคือด่านที่โกหก
import { routeMessage } from "../safetyRouter.mjs";
import { checkTurn, failThai } from "./goldenAssert.mjs";
import { selectGoldenCases } from "./gate5select.mjs";
import { BLOCK } from "./lint.mjs";
import { parseGoldenJson as parseJson } from "./goldenJson.mjs";

export { selectGoldenCases } from "./gate5select.mjs";

export const GATE5_ID = "G5";

// กฎที่เห็นผลได้จาก "เส้นทาง/สถานะ" อย่างเดียว ไม่ต้องมีคำตอบของโมเดล
const ROUTE_ONLY_RULES = Object.freeze(["ai_off", "needs_human", "team_notified"]);

/**
 * กฎที่ "การเปลี่ยนสมอง" ทำให้ผลพลิกได้จริง — ทุกข้อที่เหลือพลิกไม่ได้โดยโครงสร้าง
 *
 * เหตุผลเป็นตรรกะล้วน ไม่ใช่ความเห็น: G5 เล่นซ้ำ **คำตอบที่แช่แข็งไว้แล้ว** สิ่งเดียวที่
 * ต่างกันระหว่างสองรุ่นคือ "ตาราง" ที่ส่งเข้าเครื่องตรวจ — วันนี้คือชุดตัวเลขที่อนุมัติ
 * กับรายการคำต้องห้าม กฎที่ไม่อ่านสองอย่างนี้ (จำนวนบอลลูน จำนวนคำถาม ต้องมีคำว่าอะไร
 * เปิดหัวยังไง เส้นทาง/สถานะ) จึงให้ผลเท่ากันเป๊ะทั้งสองรุ่นเสมอ
 *
 * ถ้านับมันเป็น finding ทุกการเผยแพร่ราคาจะลากหนี้เก่าที่ไม่เกี่ยวข้องมาให้คนรับทราบ
 * — วัดจริงบนคลัง 493 เทิร์น: ตกทั้งหมด 35 ข้อ แต่มีเพียง 2 ข้อที่ตารางของรุ่นทำให้พลิกได้
 * อีก 33 ข้อคือหนี้ของ "ข้อความ/เส้นทาง" ซึ่งเป็นงานของ G5b กับ corpus gate ไม่ใช่ของ G5
 *
 * พิสูจน์ด้วยการวัด (test/brain-gate5.test.mjs): ถอด 11,900 ออกจากตาราง แล้วดูว่ากฎข้อไหน
 * เปลี่ยนผลบ้าง — คำตอบคือ price_not_approved ข้อเดียว
 */
export const BUNDLE_SENSITIVE_RULES = Object.freeze(["price_not_approved", "must_have_price", "banned_phrase"]);

/* --------------------------------- การเล่นซ้ำ -------------------------------- */

/**
 * เล่นซ้ำหนึ่งเทิร์นด้วยตารางของ bundle ที่ให้มา — ไม่มีการเรียกโมเดลในฟังก์ชันนี้เลย
 *
 * @returns {{turnId, caseId, status: "checked"|"route_only"|"unresolvable",
 *            verdict: "pass"|"fail", fails: object[], route: object|null}}
 */
export function replayGoldenTurn(turn, bundle, { db = null, extraRules = [], bannedPhrases = [] } = {}) {
  const caseId = String(turn.case_id);
  const turnId = String(turn.turn_id);
  const text = resolveTurnText(turn, db);
  if (text === null) {
    return { turnId, caseId, status: "unresolvable", verdict: "pass", fails: [], route: null };
  }
  const inputs = parseJson(turn.route_inputs_json, {});
  const route = routeMessage({
    text,
    msgType: inputs.msgType ?? "text",
    paymentStarted: inputs.paymentStarted !== false,
    botAskedDocQuestion: inputs.botAskedDocQuestion === true,
    imageKind: String(inputs.imageKind ?? ""),
    // กฎฉุกเฉินเฉพาะธุรกิจ (safety-rules.json) เป็นอินพุตของ router ตัวจริง — ถ้าไม่ส่งมา
    // การเล่นซ้ำจะได้เส้นทางที่ "ใจดีกว่าของจริง" ซึ่งเป็นทิศที่ทำให้สบายใจ
    extraRules: Array.isArray(extraRules) ? extraRules : [],
  });
  const expects = parseJson(turn.expected_json, []);
  const bubbles = recordedBubbles(turn);
  if (bubbles === null) {
    // ไม่มีคำตอบให้เล่นซ้ำ — ตรวจได้เฉพาะกฎที่อ่านจากเส้นทาง/สถานะ
    const routeExpects = expects.filter((expect) => ROUTE_ONLY_RULES.includes(expect?.type));
    const fails = routeExpects.length ? checkTurn(routeActual(route), routeExpects, tablesOf(bundle, bannedPhrases)) : [];
    return { turnId, caseId, status: "route_only", verdict: fails.length ? "fail" : "pass", fails, route };
  }
  const fails = checkTurn({ ...routeActual(route), bubbles }, expects, tablesOf(bundle, bannedPhrases));
  return { turnId, caseId, status: "checked", verdict: fails.length ? "fail" : "pass", fails, route };
}

// สถานะห้องที่ "เส้นทาง" สั่งให้เป็น — ใช้แทนแถวลูกค้าจริง เพราะเราเล่นซ้ำ ไม่ได้คุยจริง
// `escalate` ที่ไม่เป็น null คือสัญญาณเดียวที่ router ใช้บอกว่า "ต้องมีคนจริงรับช่วง"
export function routeActual(route) {
  const escalated = route?.escalate !== null && route?.escalate !== undefined;
  return {
    bubbles: [], images: [],
    customer: {
      ai_enabled: escalated ? 0 : 1,
      state: escalated ? "NEEDS_HUMAN" : "AI_ACTIVE",
      ai_off_reason: String(route?.escalate?.reason ?? ""),
    },
    teamNotes: escalated ? 1 : 0,
  };
}

// คำต้องห้ามยังไม่ใช่การ์ดจนถึง P4 (`bundle.guardTables.bannedPhrases` จึงว่าง) — ผู้เรียก
// ส่งรายการที่ complianceGuard ตัวจริงใช้อยู่เข้ามา ไม่ใช่ปล่อยให้ด่านตรวจด้วยลิสต์ว่าง
// แล้วรายงานว่า "ไม่พบคำต้องห้าม" ซึ่งจริงแต่ไร้ความหมาย
function tablesOf(bundle, bannedPhrases = []) {
  return {
    approvedAmounts: new Set((bundle?.guardTables?.approvedAmounts ?? []).map(Number)),
    bannedPhrases: [
      ...(bundle?.guardTables?.bannedPhrases ?? []),
      ...(Array.isArray(bannedPhrases) ? bannedPhrases : []),
    ],
  };
}

function recordedBubbles(turn) {
  const raw = turn.recorded_model_output;
  if (raw === null || raw === undefined || String(raw).trim() === "") return null;
  const parsed = parseJson(raw, null);
  if (Array.isArray(parsed)) return parsed.map((text) => ({ text: String(text) }));
  return [{ text: String(raw) }];
}

// ข้อความของเทิร์น: สังเคราะห์เก็บตรง ๆ · ของจริงอ่านสดจาก messages (หายไปตาม PDPA ได้)
function resolveTurnText(turn, db) {
  if (turn.synthetic_text !== null && turn.synthetic_text !== undefined) return String(turn.synthetic_text);
  if (!turn.message_ref || !db?.messageBrainContext) return null;
  const row = db.messageBrainContext(turn.message_ref);
  return row?.content === undefined || row?.content === null ? null : String(row.content);
}

export { parseGoldenJson } from "./goldenJson.mjs";
export { ROUTE_ONLY_RULES };

/* ---------------------------------- ตัวด่าน ---------------------------------- */

/**
 * G5 เต็มรูป: เลือก -> เล่นซ้ำสองรุ่น -> เทียบ -> ออกเป็น finding
 *
 * การระบุความรับผิดชอบ (ใครต้องแก้) ไม่ได้เดาจากชื่อการ์ด แต่วัดจากผลตรง ๆ:
 *   ตกบนรุ่นใหม่ แต่ผ่านบนรุ่นเดิม  -> การแก้ครั้งนี้ทำพัง          -> block
 *   ตกทั้งสองรุ่น                    -> หนี้เก่าที่เพิ่งมีคนส่องเห็น -> needs_ack
 *   ผ่านบนรุ่นใหม่ แต่ตกบนรุ่นเดิม   -> การแก้ครั้งนี้ซ่อมให้        -> รายงานเป็นข่าวดี
 * นี่คือเส้นแบ่งเดียวกับ G3/G4 แต่วัดได้แม่นกว่า เพราะไม่ต้องเดาว่าการ์ดใบไหนผลิตประโยคไหน
 *
 * @returns {{id, verdict, applicable, blocking, needsAck, fixed, summary, cases}}
 */
export function runGate5({
  turns = [], cards = [], bundle = null, previousBundle = null, touched = [],
  db = null, extraRules = [], bannedPhrases = [], previousCards = [],
} = {}) {
  // การ์ดที่ "การแก้ครั้งนี้ลบทิ้ง" ไม่อยู่ใน cards ของรุ่นใหม่แล้ว ถ้าเลือกจากรุ่นใหม่
  // อย่างเดียว การลบราคาหนึ่งใบ — ซึ่งเป็นการแก้ที่อันตรายที่สุด เพราะทำให้ทุกคำตอบที่
  // เคยพูดราคานั้นผิดกฎทันที — จะเลือกได้แค่เคส floor แล้วรายงานว่าปลอดภัย
  // (เจอตอนเอารายงานจริงมาเล่นซ้ำ: ลบ 11,900 ทิ้ง แล้วด่านเลือก 35/116 แทนที่จะเป็น 88)
  const selectFrom = [
    ...cards,
    ...[...(previousBundle?.cards ?? []), ...previousCards]
      .filter((card) => touched.includes(String(card.itemId))
        && !cards.some((row) => String(row.itemId) === String(card.itemId))),
  ];
  const selected = selectGoldenCases({ turns, cards: selectFrom, touched });
  const options = { db, extraRules, bannedPhrases };
  const cases = [];
  let checked = 0;
  let routeOnly = 0;
  let unresolvable = 0;

  for (const [caseId, entry] of selected) {
    const now = entry.turns.map((turn) => replayGoldenTurn(turn, bundle, options));
    const before = previousBundle
      ? entry.turns.map((turn) => replayGoldenTurn(turn, previousBundle, options))
      : null;
    checked += now.filter((row) => row.status === "checked").length;
    routeOnly += now.filter((row) => row.status === "route_only").length;
    unresolvable += now.filter((row) => row.status === "unresolvable").length;
    const nowFails = ruleMap(now);
    const beforeFails = before ? ruleMap(before) : null;
    const severity = entry.turns.some((turn) => turn.severity === "irreversible") ? "irreversible"
      : entry.turns.some((turn) => turn.severity === "lead") ? "lead" : "style";
    cases.push({
      caseId, severity, reasons: entry.reasons,
      // ชื่อที่คนอ่านออก ใช้ได้เฉพาะเคสสังเคราะห์ (ของเราเอง) — เคสที่ผูกห้องลูกค้าจริง
      // ห้ามฝังชื่อลงรายงานที่เก็บถาวร เพราะคนติดป้ายอาจเขียนชื่อลูกค้าไว้ในนั้น
      title: entry.turns.every((turn) => !turn.message_ref) ? String(entry.turns[0]?.title ?? "") : "",
      turns: entry.turns.length,
      status: now.every((row) => row.status === "unresolvable") ? "unresolvable"
        : now.some((row) => row.status === "checked") ? "checked" : "route_only",
      // ตกใหม่ = กฎที่รุ่นใหม่ตกแต่รุ่นเดิมไม่ตก · ไม่มีรุ่นเดิมให้เทียบ = ถือว่าใหม่ทั้งหมด
      newFails: [...nowFails.keys()].filter((rule) => !beforeFails || !beforeFails.has(rule))
        .map((rule) => ({ rule, detail: nowFails.get(rule) })),
      oldFails: [...nowFails.keys()].filter((rule) => beforeFails && beforeFails.has(rule))
        .map((rule) => ({ rule, detail: nowFails.get(rule) })),
      fixedFails: beforeFails ? [...beforeFails.keys()].filter((rule) => !nowFails.has(rule)) : [],
      outOfScope: outOfScopeRules(now),
    });
  }

  const blocking = [];
  const needsAck = [];
  const fixed = [];
  for (const row of cases) {
    for (const fail of row.newFails) blocking.push(finding(row, fail, true));
    for (const fail of row.oldFails) needsAck.push(finding(row, fail, false));
    for (const rule of row.fixedFails) fixed.push({ caseId: row.caseId, rule });
  }

  // "ไม่มีอะไรให้ตรวจ" ต้องเป็นสีเทา ไม่ใช่ติ๊กเขียว — แบบแปลน §3 ข้อ 5
  // การแก้ที่เปลี่ยนเนื้อคำตอบ (ราคา/ข้อเท็จจริง) โดยไม่มีคำตอบเก่าให้เล่นซ้ำเลย
  // แปลว่าด่านนี้ยังตรวจแทนไม่ได้ ห้ามรายงานว่าปลอดภัย
  // เคสที่ "ต้องมีคำตอบถึงจะตัดสินได้" = เคสที่มีเกณฑ์เรื่องเงิน/คำต้องห้ามอยู่ในนั้น
  // ถ้ามีเคสแบบนั้นถูกเลือกมา แต่ไม่มีเทิร์นไหนตรวจได้เลย ด่านนี้ตอบแทนไม่ได้ — จบ
  // (เดิมผูกกับ "ชนิดการ์ดที่แตะ" ซึ่งพลาดเคสที่ touched ว่าง เช่นเส้นย้อนกลับและแผงในหน้าตั้งค่า
  //  ผลคือหน้าจอขึ้นว่า "บทสนทนาในคลังยังผ่านหมด" ทั้งที่ตรวจไปศูนย์เทิร์น)
  const needsAnswer = cases.some((row) => row.status !== "checked");
  const applicable = cases.length > 0 && checked > 0;
  const outOfScope = [...new Set(cases.flatMap((row) => row.outOfScope))];
  // อายุของหลักฐาน: คำตอบที่เล่นซ้ำถูกผลิตเมื่อไร — ไม่ใช่เพื่อกันของเก่า (ของเก่ายัง
  // เป็นหลักฐานที่จริงอยู่ว่า "ห้องนั้นเคยพูดเลขนี้") แต่เพื่อให้คนอ่านรู้ว่ากำลังเชื่ออะไร
  // ถ้าคลังยังเป็นของเดือนที่แล้ว เจ้าของควรเห็นตัวเลขนั้นก่อนกดผ่าน
  const stamps = [...selected.values()]
    .flatMap((entry) => entry.turns.map((turn) => Number(turn.recorded_at) || 0))
    .filter((value) => value > 0);
  const summary = {
    cases: cases.length, checkedTurns: checked, routeOnlyTurns: routeOnly, unresolvableTurns: unresolvable,
    newFails: blocking.length, oldFails: needsAck.length, fixed: fixed.length,
    // ต้องแสดงบนหน้าจอ: "ด่านนี้ดูให้ 3 เรื่อง ส่วนอีก N เรื่องมันตัดสินแทนไม่ได้"
    // ไม่ใช่ปล่อยให้คนเข้าใจว่าเขียวแล้วแปลว่าทุกอย่างเรียบร้อย
    judged: BUNDLE_SENSITIVE_RULES,
    outOfScope,
    evidenceOldestAt: stamps.length ? Math.min(...stamps) : null,
    evidenceNewestAt: stamps.length ? Math.max(...stamps) : null,
    reason: cases.length === 0
      ? "การแก้ครั้งนี้ไม่แตะบทสนทนาไหนในคลังเลย"
      : applicable ? "" : "ยังไม่มีคำตอบที่บันทึกไว้ให้เล่นซ้ำ — ด่านนี้ยังตรวจเนื้อคำตอบแทนไม่ได้",
    // ตัวเลขที่ต้องอยู่บนจอเสมอ: ตรวจได้กี่เทิร์นจากทั้งหมดกี่เทิร์นที่เลือกมา
    selectedTurns: checked + routeOnly + unresolvable,
    partial: needsAnswer,
  };
  if (!applicable) {
    return { id: GATE5_ID, verdict: "not_applicable", applicable, blocking: [], needsAck: [], fixed, summary, cases };
  }
  return {
    id: GATE5_ID,
    verdict: blocking.length ? "block" : needsAck.length ? "needs_ack" : "pass",
    applicable, blocking, needsAck, fixed, summary, cases,
  };
}

/**
 * กฎที่ตก -> รายละเอียดสั้น ๆ (กฎเดียวกันในหลายเทิร์นนับครั้งเดียว: คนแก้ต้องเห็น "ปัญหา"
 * ไม่ใช่จำนวนครั้งที่มันปรากฏ)
 *
 * นับเฉพาะ (ก) เทิร์นที่มีคำตอบให้เล่นซ้ำ และ (ข) กฎที่ตารางของรุ่นทำให้พลิกได้จริง
 * ทุกข้อที่เหลือให้ผลเท่ากันเป๊ะทั้งสองรุ่นโดยโครงสร้าง ถ้านับเป็น finding การเผยแพร่
 * ราคาทุกครั้งจะเรียกให้คนรับทราบข้อที่การแก้นั้นไม่มีทางทำให้เกิดหรือแก้ได้เลย
 * — คือด่านที่ร้องหมาป่าจนไม่มีใครฟัง (04 §5: 71% ของเคสที่ตกไม่ใช่บั๊ก)
 * ข้อที่ถูกกันออกไปถูกนับไว้ในสรุปเป็น "ความครอบคลุม" ไม่ใช่หายไปเงียบ ๆ
 */
function ruleMap(rows) {
  const out = new Map();
  for (const row of rows) {
    if (row.status !== "checked") continue;
    for (const fail of row.fails) {
      if (!BUNDLE_SENSITIVE_RULES.includes(fail.rule)) continue;
      if (!out.has(fail.rule)) out.set(fail.rule, String(fail.detail ?? ""));
    }
  }
  return out;
}

// ข้อที่ด่านนี้ตัดสินแทนไม่ได้ (เป็นเรื่องของข้อความหรือเส้นทาง ไม่ใช่ของตาราง)
function outOfScopeRules(rows) {
  const out = new Set();
  for (const row of rows) {
    for (const fail of row.fails) if (!BUNDLE_SENSITIVE_RULES.includes(fail.rule)) out.add(fail.rule);
  }
  return [...out];
}

/**
 * finding ที่เก็บลง gate_report_json ได้อย่างปลอดภัย
 *
 * PDPA: รายงานด่านถูกเก็บถาวรบนแถวเวอร์ชัน และ `brain_versions` **ไม่อยู่ใน cascade**
 * ของสิทธิ์ให้ลืม (มีแค่ teach_json ที่ถูกล้างเป็นกรณีพิเศษ) จึงห้ามฝังข้อความของลูกค้า
 * ลงไปเด็ดขาด — เก็บแค่ตัวชี้ (caseId) กับชื่อกฎ แล้วให้หน้าจอไปดึงข้อความสดเอง
 * ผ่านเส้นที่อ่านจาก golden_turns -> messages (ซึ่งหายไปพร้อมลูกค้าตามกติกา)
 */
function finding(row, fail, attributed) {
  const who = row.title
    ? `บทสนทนา “${row.title.slice(0, 60)}”`
    : `บทสนทนาจริงในห้องลูกค้า (${row.caseId})`;
  return {
    code: GATE5_ID,
    severity: BLOCK,
    cardId: row.caseId,
    detail: fail.rule,
    caseSeverity: row.severity,
    attributed,
    message: `${who} จะพังข้อ “${failThai({ rule: fail.rule })}”`
      + (attributed ? " — เกิดจากการแก้ครั้งนี้" : " — ค้างอยู่ก่อนแล้ว"),
  };
}
