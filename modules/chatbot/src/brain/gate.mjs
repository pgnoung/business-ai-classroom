// brain/gate.mjs — บันไดด่านตรวจของการเผยแพร่ (เฟส 1b: G0–G4 ตามแบบแปลน §7)
//
// กติกาของบันได: ถูก -> แพง, แดงหยุดบันได, ด่านที่ไม่เกี่ยวกับการแก้ครั้งนี้ = not_applicable
//
// เส้นแบ่งที่เป็นหัวใจของไฟล์นี้ และเป็นเหตุผลว่าทำไมด่านถึงไม่ทำให้งานประจำวันหยุด:
//
//   ปัญหาที่พบ ณ การ์ดที่ "การแก้ครั้งนี้แตะ"      -> block   (คนแก้ต้องแก้ให้ถูกก่อน)
//   ปัญหาที่พบ ณ การ์ดที่ "มีอยู่ก่อนแล้ว"          -> needs_ack (หนี้ความรู้ ต้องรับทราบ ไม่ใช่เงียบ)
//   รับทราบหนี้ก้อนเดิมไปแล้ว                      -> สืบทอด ack ไม่ถามซ้ำ
//
// ทำไมไม่ใช้ธง grandfathered ของ lint แทน: sources.mjs ติดป้าย provenance ว่า
// `import:knowledge_entries:<id>` ให้ทุกแถวความรู้ ไม่ว่าใครจะเพิ่งแก้ไปเมื่อสิบวินาทีก่อน
// ธงนั้นจึงยกเว้นให้ "การแก้ครั้งนี้" ด้วย ซึ่งกลับหัวเจตนาของกฎ (แบบแปลน §5: "รายการที่แก้
// หรือเพิ่มต้องผ่าน") ด่านจึงรัน lint โหมด `gate` (ไม่ยกเว้นให้ใคร) แล้วตัดสินด้วยชุด touched ของตัวเอง
import { findPriceViolations, multipliableAmounts, surchargeAmounts } from "../complianceGuard.mjs";
import { brainGateSelfTest } from "./gateSelfTest.mjs";
import { runBrainLints, BLOCK, cardLabel } from "./lint.mjs";
import { LAUNCH_KINDS } from "./store.mjs";
import { allowlistValues } from "./sources.mjs";
import { runGate8, GATE8_ID } from "./gate8.mjs";
import { GATE5_ID } from "./gate5.mjs";

export { brainGateSelfTest } from "./gateSelfTest.mjs";

export const GATE_VERDICTS = Object.freeze(["pass", "needs_ack", "block", "error"]);

/**
 * กุญแจของข้อที่ "รับทราบแล้ว" — ต้องแคบพอที่การรับทราบข้อหนึ่งจะไม่กลบข้ออื่น
 *
 * เดิมใช้ `code:cardId` ซึ่งพังสองทาง: G4 มี cardId = null ทุกข้อ ("G4:null" ใบเดียวปิดปาก
 * ทุกตัวเลขที่ด่านราคาจะตัดตลอดกาล) และ L07 ก็ผูกกับขอบเขต ไม่ใช่การ์ด — จึงต้องมีตัวที่สาม
 */
export function findingKey(finding) {
  const extra = finding?.detail ?? finding?.amountText ?? finding?.scope ?? "";
  return `${finding?.code}:${finding?.cardId ?? "null"}:${extra}`;
}
export const GATE_IDS = Object.freeze(["G0", "G1", "G2", "G3", "G4", "G5", "G8"]);
// ด่านที่แพงกว่า ms — เปิดด้วย BRAIN_GATES เท่านั้น (ค่าเริ่มต้นปิด = บันไดเหมือนเฟส 1b ทุกไบต์)
//   ""        ปิดหมด (ค่าเริ่มต้น)
//   offline   G5 + G8 — เล่นซ้ำบทสนทนาจริง ไม่เรียกโมเดล ไม่มีค่าใช้จ่าย
//   heavy     offline + เปิดสิทธิ์ให้ G5b ทำงานได้ (ยังต้องยืนยันรายครั้งอีกชั้น)
export const BRAIN_GATE_MODES = Object.freeze(["", "offline", "heavy"]);
export function offlineGatesOn(mode) {
  return mode === "offline" || mode === "heavy";
}

// สัญญาโค้ดที่คอมไพเลอร์ชุดนี้อ่านออก — เวอร์ชันที่ประกาศสัญญาอื่นคือของจากโค้ดคนละรุ่น
// (เกิดได้จริงเมื่อ deploy ถูก auto-revert หลังมีการเผยแพร่ — แบบแปลน §5 fallback)
export const SUPPORTED_CODE_CONTRACTS = Object.freeze(["brain-compat-1"]);

// L11 ฉบับย่อของเฟส 1b: `enforcement.ref` ต้องชี้ไปยังจุดบังคับใช้ที่มีอยู่จริงในโค้ดชุดนี้
// ทะเบียนนี้คือ "สิ่งที่โค้ดทำได้จริง" ไม่ใช่ "สิ่งที่ใครสักคนพิมพ์ไว้ในการ์ด"
export const BRAIN_CODE_CONTRACT_REGISTRY = Object.freeze([
  "tags.composeTagRules",
  "db.autoTagFreeClass",
  "pipeline.resolveBusinessHashtag",
]);

// ฟิลด์ที่ขาดไม่ได้ต่อชนิด — ตรงกับสิ่งที่คอมไพเลอร์อ่านจริง ไม่ใช่ schema ในฝัน
const REQUIRED_BODY_FIELDS = Object.freeze({
  product: ["name_th", "status"],
  fact: ["title", "content"],
  price: ["label_th", "amount"],
  schedule: ["date", "round_key", "label_th", "status"],
  policy: ["statement_th", "enforcement"],
});

/* ---------------------------------- บันได ---------------------------------- */

/**
 * @param {object} input
 * @param {object[]} input.cards การ์ดของเวอร์ชันที่กำลังจะเผยแพร่ (รูปเดียวกับคอมไพเลอร์)
 * @param {object} input.bundle ผลคอมไพล์ของการ์ดชุดนั้น
 * @param {string[]} [input.touched] item_id ที่ "การแก้ครั้งนี้" เพิ่ม/แก้/ลบ
 * @param {object[]} [input.inheritedAcks] ack ที่เวอร์ชัน live ปัจจุบันถืออยู่
 * @returns {{verdict: string, gates: object[], blocking: object[], needsAck: object[],
 *            warnings: object[], acks: object[], selfTest: object}}
 */
export function runBrainGates({
  cards = [], bundle = {}, touched = [], inheritedAcks = [], todayIso = null, allowlist = [],
  previousBundle = null, delegated = false,
  // เฟส 3 (ทั้งหมดเป็น opt-in: ไม่ส่งมา = บันไดเหมือนเฟส 1b ทุกไบต์)
  // ค่าเริ่มต้นเป็น null โดยเจตนา ไม่ใช่ [] — `[]` แปลว่า "ส่งมาแล้วและว่างจริง"
  // ส่วน null แปลว่า "ผู้เรียกยังไม่ได้ต่อสาย" สองอย่างนี้ต้องแยกกันให้ออก
  gateMode = "", goldenTurns = null, db = null, extraRules = null, bannedPhrases = null,
  gateRuns = undefined, versionId = "candidate", recordEvalRuns = true, previousCards = [],
} = {}) {
  const touchedIds = new Set(touched.map(String));
  const touchedKinds = new Set(cards.filter((card) => touchedIds.has(card.itemId)).map((card) => card.kind));
  const acked = new Set(inheritedAcks.flatMap((ack) => (Array.isArray(ack?.items) ? ack.items.map(String) : [])));
  const gates = [];
  const blocking = [];
  const needsAck = [];
  const warnings = [];
  let heavy = null;

  // ปัญหาหนึ่งข้อ -> ตกลงถังไหน: แตะครั้งนี้ = บล็อก · ของเก่าที่รับทราบแล้ว = เงียบได้ ·
  // ของเก่าที่ยังไม่รับทราบ = ต้องรับทราบ
  const route = (finding, attributed) => {
    if (attributed) { blocking.push(finding); return "block"; }
    if (acked.has(findingKey(finding))) { warnings.push({ ...finding, acked: true }); return "acked"; }
    needsAck.push(finding);
    return "needs_ack";
  };

  /* G0 — เครื่องมือตรวจตรวจตัวเองก่อน */
  const selfTest = brainGateSelfTest();
  gates.push({ id: "G0", verdict: selfTest.ok ? "pass" : "error", detail: selfTest.problems });
  if (!selfTest.ok) {
    return {
      verdict: "error", gates, blocking: [], needsAck: [], warnings, acks: [], selfTest,
      error: "เครื่องมือตรวจเสีย ห้ามเชื่อผลด่าน — หยุดการเผยแพร่ทั้งหมด",
    };
  }

  /* G1 — schema ต่อชนิด + code_contract + ทะเบียนจุดบังคับใช้ */
  const g1 = [];
  if (!SUPPORTED_CODE_CONTRACTS.includes(String(bundle.codeContract || ""))) {
    g1.push({
      code: "G1", severity: BLOCK, cardId: null,
      message: `เวอร์ชันนี้ประกาศสัญญาโค้ด "${bundle.codeContract}" ซึ่งโค้ดที่รันอยู่อ่านไม่ออก`
        + ` (รองรับ: ${SUPPORTED_CODE_CONTRACTS.join(", ")}) — อัปเดตโค้ดก่อนเผยแพร่`,
    });
  }
  for (const card of cards) {
    if (!LAUNCH_KINDS.includes(card.kind)) {
      g1.push({
        code: "G1", severity: BLOCK, cardId: card.itemId,
        message: `การ์ด "${cardLabel(card)}" เป็นชนิด "${card.kind}" ที่ยังไม่เปิดใช้ในเฟสนี้`,
      });
      continue;
    }
    for (const field of REQUIRED_BODY_FIELDS[card.kind] ?? []) {
      const value = card.body?.[field];
      if (value === undefined || value === null || value === "") {
        g1.push({
          code: "G1", severity: BLOCK, cardId: card.itemId,
          message: `การ์ด "${cardLabel(card)}" ไม่มีข้อมูลช่อง "${field}" ที่ชนิด ${card.kind} ต้องมี`,
        });
      }
    }
    const ref = card.kind === "policy" ? String(card.body?.enforcement?.ref || "") : "";
    if (ref && !BRAIN_CODE_CONTRACT_REGISTRY.includes(ref)) {
      g1.push({
        code: "G1", severity: BLOCK, cardId: card.itemId,
        message: `การ์ด "${cardLabel(card)}" อ้างจุดบังคับใช้ "${ref}" ที่ไม่มีอยู่ในโค้ดชุดนี้`,
      });
    }
  }
  // G1 บล็อกเสมอโดยไม่ดูว่าใครแตะ: เวอร์ชันที่อธิบายตัวเองไม่ได้ (ชนิดที่โค้ดไม่รู้จัก
  // ช่องที่ขาด สัญญาโค้ดคนละรุ่น จุดบังคับใช้ที่ไม่มีจริง) ไม่ใช่ "หนี้ความรู้ที่ค่อยเก็บ"
  // แต่คือของที่คอมไพเลอร์อ่านผิดได้ทันที — แบบแปลน §7 ให้ G1 เป็นบล็อกล้วน
  const g1Verdicts = g1.map((finding) => route(finding, true));
  gates.push({ id: "G1", verdict: verdictOf(g1Verdicts), detail: g1 });
  if (blocking.length) return finish("block");

  /* G2 — คอมไพล์ผ่านและครบ (ตัวคอมไพล์เองโยน error ก่อนถึงที่นี่ถ้าประกอบไม่ได้) */
  const g2 = [];
  if (!bundle.checksum) {
    g2.push({ code: "G2", severity: BLOCK, cardId: null, message: "คอมไพล์แล้วไม่ได้ checksum — ผลลัพธ์ใช้ไม่ได้" });
  }
  if (Number(bundle.budget?.cardCount ?? 0) !== cards.length) {
    g2.push({
      code: "G2", severity: BLOCK, cardId: null,
      message: `คอมไพเลอร์เห็นการ์ด ${bundle.budget?.cardCount} ใบ แต่เวอร์ชันนี้มี ${cards.length} ใบ`,
    });
  }
  const g2Verdicts = g2.map((finding) => route(finding, true));
  gates.push({ id: "G2", verdict: verdictOf(g2Verdicts), detail: g2 });
  if (blocking.length) return finish("block");

  /* G3 — lint ตามตาราง §5 (โหมด strict; การจัดว่าเป็นหนี้เก่าเป็นงานของ route ข้างบน) */
  const lints = runBrainLints({
    cards, bundle, todayIso: todayIso ?? bundle.todayIso ?? null,
    allowlist: allowlistValues(allowlist ?? []), mode: "gate",
  });
  const g3Verdicts = [];
  for (const finding of lints) {
    // L02b: คำเตือนที่กลายเป็นบล็อกเมื่อคนเขียนใช้สิทธิ์ที่มอบมา — ตัวกฎเขียนไว้เองว่า
    // "เผยแพร่แบบมอบสิทธิ์ไม่ได้" ถ้ายังปล่อยผ่านเป็นคำเตือน กฎข้อนี้ก็ไม่เคยกันอะไรเลย
    const attributed = isAttributed(finding, { touchedIds, touchedKinds, cards, bundle, previousBundle });
    if (finding.severity !== BLOCK) {
      if (delegated && finding.rule === "L02b" && attributed) {
        g3Verdicts.push(route({ ...finding, severity: BLOCK }, true));
      } else {
        warnings.push(finding);
      }
      continue;
    }
    g3Verdicts.push(route(finding, attributed));
  }
  gates.push({ id: "G3", verdict: verdictOf(g3Verdicts), detail: lints });
  if (blocking.length) return finish("block");

  /* G4 — ลองด่านราคากับข้อความของสมองเอง ด้วยชุดตัวเลขของเวอร์ชันนี้ */
  //
  // ตรวจบริบทจริงของใบที่แตะ ไม่เทียบ substring: เลขใน URL รีวิว/วันที่/metadata
  // ไม่ใช่ราคาผิดจากใบอื่น (15 ก.ย. 2026: ลิงก์ใหม่ถูกโยนหนี้เก่ามาบล็อกแปดข้อ)
  // ยังตรวจทั้งคลังและคง needs_ack สำหรับหนี้เก่า ไม่ปิดด่านหรือรับทราบแทนเจ้าของ
  const g4 = guardDryRun(bundle);
  const attributedAmounts = touchedGuardAmounts({ cards, bundle, touchedIds, previousBundle, findings: g4 });
  const g4Verdicts = g4.map((finding) => route(finding, attributedAmounts.has(finding.amountText)));
  gates.push({ id: "G4", verdict: verdictOf(g4Verdicts), detail: g4 });
  if (blocking.length) return finish("block");

  /* G5 + G8 — เล่นซ้ำบทสนทนาจริงด้วยตารางของรุ่นใหม่ (ไม่เรียกโมเดล) แล้วกันเคสที่เถียงกับตัวเอง
   *
   * ทั้งคู่อยู่หลัง G4 เพราะแพงกว่าเป็นมิลลิวินาที ๆ และเพราะถ้าตารางของรุ่นเองยังผิด
   * ผลของการเล่นซ้ำก็ไม่มีความหมาย — บันไดต้องหยุดที่ขั้นถูกที่สุดที่ตอบได้ก่อนเสมอ
   *
   * ผู้เรียกที่ไม่ส่ง goldenTurns มา (หรือแฟล็กปิด) ได้ not_applicable = เทา ไม่ใช่เขียว */
  if (offlineGatesOn(gateMode)) {
    // ด่านที่ถูกเปิดแล้วแต่ได้ของไม่ครบ ต้อง **ล้มเสียงดัง** ไม่ใช่รายงานว่าไม่เกี่ยว
    // (แบบแปลน §3 ข้อ 5 — เครื่องมือตรวจต้องพิสูจน์ตัวเองก่อน และห้ามติ๊กเขียวเมื่อไม่มีอะไรให้ตรวจ)
    const missing = [];
    if (!Array.isArray(bannedPhrases)) missing.push("รายการคำต้องห้ามของ runtime");
    if (!Array.isArray(extraRules)) missing.push("กฎฉุกเฉินเฉพาะธุรกิจ (safety-rules)");
    if (!Array.isArray(goldenTurns)) missing.push("คลังเทิร์นตรวจซ้ำ (golden_turns)");
    if (missing.length) {
      gates.push({ id: GATE5_ID, verdict: "error", detail: { missing } });
      gates.push({ id: GATE8_ID, verdict: "error", detail: { missing } });
      return {
        verdict: "error", gates, blocking: [], needsAck: [], warnings, acks: [], selfTest, heavy: null,
        error: `ด่านเล่นซ้ำถูกเปิดไว้ (BRAIN_GATES=${gateMode}) แต่ยังต่อไม่ถึง: ${missing.join(" · ")}`
          + " — หยุดการเผยแพร่ไว้ก่อน ดีกว่าปล่อยผ่านโดยที่ไม่มีใครตรวจอะไรเลย",
      };
    }
  }
  if (offlineGatesOn(gateMode) && Array.isArray(goldenTurns) && goldenTurns.length) {
    const g8 = runGate8({
      turns: goldenTurns, cards, bundle, previousBundle, touched, previousCards,
      db, extraRules, bannedPhrases, runs: gateRuns, versionId, record: recordEvalRuns,
    });
    for (const finding of g8.blocking) route(finding, finding.attributed !== false);
    for (const finding of g8.needsAck) route(finding, false);
    gates.push({ id: GATE5_ID, verdict: g8.verdict === "not_applicable" ? "not_applicable" : verdictOfG5(g8), detail: g8.summary });
    gates.push({ id: GATE8_ID, verdict: g8.verdict, detail: { quarantined: g8.quarantined, falsePositiveRate: g8.falsePositiveRate, runs: g8.runs } });
    heavy = g8;
  } else {
    gates.push({ id: GATE5_ID, verdict: "not_applicable", detail: { reason: gateReasonOf(gateMode, goldenTurns) } });
    gates.push({ id: GATE8_ID, verdict: "not_applicable", detail: { reason: gateReasonOf(gateMode, goldenTurns) } });
  }

  return finish(blocking.length ? "block" : needsAck.length ? "needs_ack" : "pass");

  function finish(verdict) {
    return {
      verdict, gates, blocking, needsAck, warnings, selfTest, heavy,
      // ack ที่ยัง "มีของให้รับทราบ" อยู่จริงเท่านั้นที่ถูกส่งต่อ — ack ของหนี้ที่ถูกแก้ไปแล้ว
      // ต้องหลุดออกจากสายเอง ไม่งั้นมันจะกลายเป็นใบผ่านตลอดกาลของโค้ดที่ไม่มีใครอ่าน
      acks: liveAcks(inheritedAcks, warnings),
    };
  }
}

// ปัญหาข้อนี้เกิดจาก "การแก้ครั้งนี้" หรือไม่
// - มี cardId: ดูตรง ๆ ว่าใบนั้นถูกแตะไหม
// - L07 (งบรวมของขอบเขต ไม่ผูกกับการ์ดใบเดียว): เทียบกับงบของรุ่นก่อนหน้า —
//   "การแก้ครั้งนี้ทำให้ล้นขึ้น" ต้องบล็อกที่คนแก้ แต่ "ล้นอยู่ก่อนแล้ว" ห้ามบล็อก
//   เพราะจะกลายเป็นว่าคลังความรู้ที่ล้นวันนี้ ล็อกไม่ให้ใครแก้อะไรได้อีกเลย
//   แม้แต่การลบเนื้อหาออกเพื่อให้เล็กลง ซึ่งคือทางแก้ทางเดียวที่มี
// - null อื่น ๆ: ถือว่าใช่ ถ้าการแก้ครั้งนี้แตะการ์ดชนิดที่ประกอบเป็นข้อความก้อนนั้น
function isAttributed(finding, { touchedIds, touchedKinds, cards = [], bundle = null, previousBundle = null } = {}) {
  if (finding.cardId) {
    if (!touchedIds.has(String(finding.cardId))) return false;
    // การ์ดที่ผลของการแก้ครั้งนี้คือ "ปิด" (inject never) หรือ "หายไป" ไม่ได้เข้า prompt อีกแล้ว
    // การบล็อกคนที่กำลังปิดของเสีย เพราะของชิ้นนั้นเสีย คือการล็อกวาล์วนิรภัยไว้กับตัวปัญหา
    // (ลบใบเดียวกันผ่านได้อยู่แล้ว การปิดจึงต้องผ่านด้วย ไม่งั้นกฎสอนให้คนลบทิ้งแทนที่จะปิด)
    // เฉพาะกฎที่พูดถึง "เนื้อที่ไปถึงลูกค้า" — L01/L03/L07 ยังผูกกับโครงสร้าง/งบรวมตามเดิม
    const card = cards.find((row) => row.itemId === String(finding.cardId));
    if (!card) return !PROMPT_CONTENT_CODES.includes(finding.code);
    if (card.inject === "never" && PROMPT_CONTENT_CODES.includes(finding.code)) return false;
    return true;
  }
  if (finding.code === "L07") return budgetGotWorse(finding.scope, bundle, previousBundle);
  return touchedKinds.has("fact");
}

function budgetGotWorse(scope, bundle, previousBundle) {
  if (!previousBundle) return true; // ไม่รู้ของเดิม = ระวังไว้ก่อน (ผู้เรียกที่รู้ต้องส่งมา)
  const now = bundle?.budget?.usage?.[scope] ?? null;
  const before = previousBundle?.budget?.usage?.[scope] ?? null;
  if (!now) return false;
  if (!before) return true; // ขอบเขตนี้เพิ่งเกิดจากการแก้ครั้งนี้
  return Number(now.totalChars ?? 0) > Number(before.totalChars ?? 0)
    || Number(now.droppedCount ?? 0) > Number(before.droppedCount ?? 0);
}

function touchedGuardAmounts({ cards, bundle, touchedIds, previousBundle, findings }) {
  const touched = cards.filter(card => touchedIds.has(card.itemId) && card.inject !== "never");
  const touchedKinds = new Set(touched.map(card => card.kind));
  const scoped = {
    guardTables: bundle.guardTables,
    promptBlocks: { knowledge: { central: touched.filter(card => card.kind === "fact")
      .map(card => `[${card.body.title}]\n${card.body.content}`).join("\n\n") } },
    rules: {
      productRulesLines: touched.some(card => card.key === "policy:product_rules") ? bundle.rules?.productRulesLines : [],
      seatRuleLines: touchedKinds.has("schedule") || touchedKinds.has("product") ? bundle.rules?.seatRuleLines : [],
    },
  };
  const amounts = new Set(guardDryRun(scoped).map(finding => finding.amountText));
  // การลด/ลบราคาที่อนุมัติ หรือเปลี่ยนบริบทคูณยอด อาจทำให้ใบที่ไม่ได้แตะมีปัญหาใหม่
  // เทียบผลทั้งคลังก่อน/หลังจึงยังบล็อกได้ แม้ไม่มีเลขนั้นใน payload ที่แก้ครั้งนี้
  if (previousBundle && touchedIds.size) {
    const previous = new Set(guardDryRun(previousBundle).map(finding => finding.amountText));
    for (const finding of findings) if (!previous.has(finding.amountText)) amounts.add(finding.amountText);
  } else if ([...touchedIds].some(id => id.startsWith("price:"))) {
    // ผู้เรียกไม่มี baseline ของการแก้ตารางราคา: ห้ามเดาว่าเป็นหนี้เก่า
    for (const finding of findings) amounts.add(finding.amountText);
  }
  return amounts;
}

// กฎที่พูดถึง "ข้อความที่ไปถึงลูกค้า" — การ์ดที่ถูกปิดหรือถูกลบ ไม่เข้าข่ายอีกต่อไป
const PROMPT_CONTENT_CODES = Object.freeze(["L02", "L05", "L12", "L15", "L16", "G4"]);

// G5 รายงานผลของตัวเอง (บล็อก/ต้องรับทราบ/ผ่าน) แยกจากผลรวมของ G8 ซึ่งรวมเรื่องกักตัวด้วย
function verdictOfG5(report) {
  if (report.blocking.length) return "block";
  if (report.needsAck.some((finding) => finding.code === GATE5_ID)) return "needs_ack";
  return "pass";
}

function gateReasonOf(mode, turns) {
  if (!offlineGatesOn(mode)) return "ด่านเล่นซ้ำยังปิดอยู่ (BRAIN_GATES)";
  if (!Array.isArray(turns)) return "ด่านเล่นซ้ำเปิดอยู่ แต่ผู้เรียกยังไม่ได้ต่อคลังเทิร์นให้";
  return "ยังไม่มีบทสนทนาในคลังให้เล่นซ้ำ (นำเข้าด้วย tools/golden-turns-seed.mjs)";
}

function verdictOf(routed) {
  if (routed.includes("block")) return "block";
  if (routed.includes("needs_ack")) return "needs_ack";
  return "pass";
}

function liveAcks(inherited, warnings) {
  const stillAcked = new Set(warnings.filter((w) => w.acked).map((w) => findingKey(w)));
  return inherited
    .map((ack) => ({ ...ack, items: (ack?.items ?? []).filter((item) => stillAcked.has(String(item))) }))
    .filter((ack) => ack.items.length > 0);
}

/**
 * G4: ยิงด่านราคาตัวจริงใส่ข้อความที่เวอร์ชันนี้จะฉีดเข้า prompt
 *
 * เหตุผลที่ต้องมีทั้งที่ L02 ก็ดูตัวเลขเหมือนกัน: L02 อ่าน "เนื้อการ์ดทีละใบ" ส่วนด่านจริง
 * อ่าน "ข้อความทั้งก้อน" พร้อมบริบท (ผ่อน/บัตรเครดิต/คูณจำนวนหัว) ตัวเลขที่ L02 ยอมเพราะ
 * อยู่ในตาราง แต่ด่านจริงตัดเพราะบริบทไม่ปลดล็อก คือคำตอบที่ลูกค้าจะได้แบบขาดประโยค
 */
export function guardDryRun(bundle) {
  const rows = bundle.guardTables?.approvedPrices ?? [];
  const approved = new Set(rows.map((row) => Number(row.amount)));
  const multipliable = multipliableAmounts(rows);
  const surcharges = surchargeAmounts(rows);
  const seen = new Set();
  const findings = [];
  for (const segment of promptSegments(bundle)) {
    for (const violation of findPriceViolations(segment, approved, multipliable, surcharges)) {
      // เลขเดียวกันโผล่หลายการ์ดคือหนี้ก้อนเดียว — รายงานซ้ำ = ผู้ใช้กด "รับทราบ" รัว ๆ
      if (seen.has(violation.detail)) continue;
      seen.add(violation.detail);
      findings.push({
        code: "G4", severity: BLOCK, cardId: null, amountText: violation.detail,
        message: `ข้อความที่สมองจะส่งให้ลูกแพรมีตัวเลข ${violation.detail}`
          + " ที่ด่านราคาจะตัดทิ้งตอนตอบลูกค้า — เพิ่มเข้าตารางราคาหรือเอาตัวเลขออก",
      });
    }
  }
  return findings;
}

/**
 * แบ่งข้อความของสมองเป็น "ก้อนเท่าที่ลูกค้าจะได้เห็นจริง" ก่อนยิงด่านราคา
 *
 * ทำไมต้องแบ่ง: inPriceContext อ่านบริบท ±20/+12 ตัวอักษรรอบเลข โดยไม่สนขอบบรรทัด ถ้าเอา
 * คลังความรู้ทั้งคลังมาต่อกันเป็นสตริงเดียว คำว่า "บาท" ท้ายการ์ดใบก่อนจะกลายเป็นบริบทราคา
 * ของเลขต้นการ์ดใบถัดไป — "…79,000 บาทค่ะ\n\n[ขั้นตอน]\nขั้นตอนที่ 1" ทำให้เลข 1 ถูกแจ้งว่า
 * เป็นราคาที่ไม่อนุมัติ (ยืนยันบนของจริง 3 ก.ย. 2026: 20 จาก 27 ข้อเป็นเลขอย่าง 1/2/17/2026)
 * ตอนตอบลูกค้าจริง ด่านเห็นข้อความสั้น ๆ ทีละคำตอบ ไม่เคยเห็นคลังทั้งคลังต่อกัน ด่านซ้อมจึง
 * ต้องแบ่งให้เท่าหน่วยนั้น ไม่งั้นมันเตือนเรื่องที่ไม่มีวันเกิด แล้วคนก็เลิกอ่านคำเตือน
 *
 * แบ่งตรงขอบการ์ดเป๊ะ ๆ: compile ต่อการ์ดด้วย "\n\n" และทุกใบขึ้นต้นด้วย "[หัวข้อ]" จึงตัด
 * เฉพาะบรรทัดว่างที่ตามด้วย "[" — บรรทัดว่างในเนื้อการ์ดใบเดียวกันยังอยู่ครบ บริบทหลายบรรทัด
 * (ผ่อน/บัตรเครดิต/คูณจำนวนหัว) ที่ G4 ต้องใช้จึงไม่หาย
 */
function promptSegments(bundle) {
  const segments = [];
  const sections = [
    bundle.promptBlocks?.knowledge?.central ?? "",
    ...Object.values(bundle.promptBlocks?.knowledge?.byChannel ?? {}),
  ];
  for (const section of sections) {
    if (section) segments.push(...String(section).split(/\n\n(?=\[)/u));
  }
  // บรรทัดกติกา/ที่นั่งเป็นข้อความอิสระอยู่แล้ว — ตรวจทีละบรรทัดตามที่ถูกฉีดเข้า prompt
  segments.push(...(bundle.rules?.productRulesLines ?? []), ...(bundle.rules?.seatRuleLines ?? []));
  return segments.filter(Boolean);
}
