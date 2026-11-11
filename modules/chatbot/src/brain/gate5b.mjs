// brain/gate5b.mjs — G5b: ด่านเดียวในบันไดที่ **เสียเงินจริงของเจ้าของ**
//
// ทำไมต้องมีทั้งที่ G5 ฟรี: การเล่นซ้ำกฎตรวจ "ข้อเท็จจริงที่ผิด" ไม่ได้เลย (แบบแปลน §1)
// ถ้าพี่ง้วงแก้ความรู้ว่า "ที่จอดรถ 2 ชม. -> 4 ชม." คำตอบเก่ายังพูด 2 ชม. อยู่ดี และไม่มีกฎ
// deterministic ข้อไหนรู้ว่ามันผิด — ต้องถามโมเดลด้วยสมองรุ่นใหม่จริง ๆ แล้วเทียบคู่คำตอบ
//
// ═══ สามกุญแจที่ทำให้ด่านนี้ "กดโดนโดยบังเอิญ" ไม่ได้ ═══
//
//   1. แฟล็กรันไทม์: ต้อง BRAIN_GATES=heavy เท่านั้น (ค่าเริ่มต้นว่าง = ปิด)
//   2. คำยืนยันรายครั้ง: token ที่ผูกกับ tree_sha256 ของรุ่นนั้น + ยอดเงินที่แสดงไป
//      — ยืนยันของรุ่นหนึ่งเอาไปใช้กับอีกรุ่นไม่ได้ และยืนยันเก่าหมดอายุใน 10 นาที
//   3. **ไม่มี client เริ่มต้นในโมดูลนี้เลย** ผู้เรียกต้องฉีด askModel เข้ามาเอง
//      โค้ดที่ต่อสายจริงอยู่ที่เดียว (ฝั่ง server) และอยู่หลังกุญแจข้อ 1
//      => เทสต์ที่ลืม stub จะได้ error ไม่ใช่ใบเรียกเก็บเงิน
//
//   และกุญแจที่สี่ซึ่งเป็นกติกาของ COST.md: ต้องเรียก onEstimate (แสดงยอดเป็นบาท)
//   **ก่อน** ยิงคำขอแรกเสมอ ไม่มี onEstimate = ปฏิเสธทำงาน
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { estimateG5bCost, usdPerPrompt, G5B_CAPS, MEASURED } from "./gate5bCost.mjs";

const THB_PER_USD = MEASURED.thbPerUsd;
import { normalizeThai } from "./text.mjs";
import { selectGoldenCases } from "./gate5select.mjs";
import { BLOCK } from "./lint.mjs";

export const GATE5B_ID = "G5b";
export const HEAVY_GATE_MODE = "heavy";
export const CONFIRM_TTL_MS = 10 * 60 * 1000;

const CONFIRM_DOMAIN = "lukprae-g5b-confirm-v1\0";

export class G5bRefused extends Error {
  constructor(message, reason) {
    super(message);
    this.name = "G5bRefused";
    this.reason = reason;
  }
}

/**
 * ตั๋วยืนยันหนึ่งใบ ใช้ได้กับรุ่นเดียว ยอดเดียว และหมดอายุใน 10 นาที
 * (ทรงเดียวกับ /ptb: ตั๋วที่ใช้ซ้ำได้คือตั๋วที่ไม่ได้ยืนยันอะไรเลย)
 */
export function g5bConfirmToken({ treeSha256, thb, issuedAt, secret, nonce = randomUUID() }) {
  if (!secret) throw new Error("G5b: ต้องมีกุญแจของ instance ก่อนออกตั๋วยืนยัน");
  const payload = `${treeSha256}|${Math.round(Number(thb))}|${Number(issuedAt)}|${nonce}`;
  const mac = createHmac("sha256", secret).update(CONFIRM_DOMAIN).update(payload).digest("hex");
  return `${Number(issuedAt)}.${nonce}.${mac}`;
}

/**
 * ตั๋วใช้ได้ครั้งเดียว — nonce อยู่ในลายเซ็น และถูก "กิน" ก่อนยิงคำขอแรกเสมอ
 *
 * เดิมตั๋วใบเดียวใช้ซ้ำได้ตลอด 10 นาที แปลว่ายืนยันหนึ่งครั้งเรียกเก็บเงินได้หลายครั้ง
 * (ยิงซ้ำ 20 รอบใน 10 นาที = จ่าย 20 เท่าโดยเจ้าของอนุมัติครั้งเดียว)
 */
export function verifyG5bConfirm({ token, treeSha256, thb, secret, now = Date.now(), nonceStore = null }) {
  const [stamp, nonce, mac] = String(token || "").split(".");
  const issuedAt = Number(stamp);
  if (!mac || !nonce || !Number.isFinite(issuedAt)) return { ok: false, reason: "รูปแบบคำยืนยันไม่ถูกต้อง" };
  if (now - issuedAt > CONFIRM_TTL_MS) return { ok: false, reason: "คำยืนยันหมดอายุแล้ว (เกิน 10 นาที) — กดดูยอดใหม่อีกครั้ง" };
  if (issuedAt > now + 60_000) return { ok: false, reason: "คำยืนยันมาจากอนาคต" };
  let expected;
  try { expected = g5bConfirmToken({ treeSha256, thb, issuedAt, secret, nonce }); } catch { return { ok: false, reason: "ไม่มีกุญแจของ instance" }; }
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  const same = a.length === b.length && timingSafeEqual(a, b);
  if (!same) return { ok: false, reason: "คำยืนยันไม่ตรงกับรุ่นหรือยอดที่แสดงไว้" };
  if (!nonceStore) {
    // ไม่มีที่เก็บตั๋วที่ใช้ไปแล้ว = พิสูจน์ "ใช้ครั้งเดียว" ไม่ได้ -> ปฏิเสธ (fail closed)
    // ยอมไม่ให้ด่านทำงาน ดีกว่ายอมให้ตั๋วใบเดียวเรียกเก็บเงินซ้ำได้
    return { ok: false, reason: "ระบบบันทึกตั๋วที่ใช้แล้วไม่พร้อม — ยังยิงโมเดลไม่ได้" };
  }
  let consumed;
  try { consumed = nonceStore.consume(nonce, issuedAt + CONFIRM_TTL_MS); } catch { consumed = false; }
  if (!consumed) return { ok: false, reason: "คำยืนยันใบนี้ถูกใช้ไปแล้ว — กดดูยอดใหม่อีกครั้ง" };
  return { ok: true };
}

/* ------------------------------ สิ่งที่จะเอาไปถาม ------------------------------ */

/**
 * แผนการยิง: (ก) เทิร์นที่ scope ตรงกับการ์ดที่แก้ (ข) probe จาก question_th ของการ์ดที่แก้
 * (ค) probe ขัดแย้ง — ถามผ่านการ์ดอื่นที่มี noun phrase ร่วมกัน (แบบแปลน §7 G5b ข้อ c)
 *
 * บริสุทธิ์ ไม่ยิงอะไร ไม่แตะเครือข่าย — ใช้คำนวณยอดเงินก่อนถามคน
 */
export function planG5b({ turns = [], cards = [], touched = [] } = {}) {
  const touchedIds = new Set(touched.map(String));
  const touchedCards = cards.filter((card) => touchedIds.has(String(card.itemId)));
  // เลือกเฉพาะเทิร์นที่การแก้ครั้งนี้ไปแตะ (กติกาเดียวกับ G5) ไม่ใช่หยิบใบล่าสุดของทั้งคลัง
  // — ด่านที่เสียเงินต้องยิงเฉพาะของที่เกี่ยว ไม่งั้นจ่ายเพื่อถามเรื่องที่ไม่มีใครแก้
  const scoped = new Set([...selectGoldenCases({ turns, cards, touched }).values()]
    .flatMap((entry) => entry.turns.map((turn) => String(turn.turn_id))));
  const replay = [...turns]
    .filter((turn) => scoped.has(String(turn.turn_id)))
    .filter((turn) => turn.synthetic_text || turn.message_ref)
    .sort((a, b) => (b.labelled_at ?? 0) - (a.labelled_at ?? 0))
    .slice(0, G5B_CAPS.replayTurns)
    .map((turn) => ({ kind: "replay", turnId: turn.turn_id, caseId: turn.case_id, text: turn.synthetic_text ?? null, turn }));

  const probes = [];
  for (const card of touchedCards) {
    for (const question of card?.body?.question_th ?? []) {
      probes.push({ kind: "probe", cardId: card.itemId, text: String(question) });
    }
    // ไม่มี question_th (การ์ดที่นำเข้ามาส่วนใหญ่ยังไม่มี) -> ถามจากหัวข้อตรง ๆ
    const topic = card?.body?.title ?? card?.body?.label_th ?? card?.body?.name_th;
    if (topic) probes.push({ kind: "probe", cardId: card.itemId, text: `${topic} เป็นยังไงคะ` });
    // probe ขัดแย้ง: ถามเรื่องเดียวกันผ่านการ์ดอื่นที่ scope เดียวกันและมีคำร่วม
    const neighbour = contradictionNeighbour(card, cards);
    if (neighbour) {
      probes.push({
        kind: "contradiction", cardId: card.itemId, against: neighbour.itemId,
        text: `${neighbour.body?.title ?? neighbour.key} กับ ${topic ?? card.key} ตกลงยังไงแน่คะ`,
      });
    }
  }
  return {
    replay,
    probes: dedupeByText(probes).slice(0, G5B_CAPS.probes),
    // **เซ็นยอดแย่ที่สุดเสมอ** (รันซ้ำเต็มเพดาน) — ห้ามเซ็นยอดที่ฟังก์ชันเดียวกันทำเกินได้
    // เจ้าของจึงเห็นเพดานก่อนกด แล้วค่อยเห็นยอดจริงที่ถูกกว่าหลังรัน
    estimate: estimateG5bCost({
      replayTurns: replay.length,
      probes: Math.min(dedupeByText(probes).length, G5B_CAPS.probes),
      rerunPairs: G5B_CAPS.rerunPairs,
    }),
  };
}

function dedupeByText(rows) {
  const seen = new Set();
  return rows.filter((row) => {
    const key = normalizeThai(row.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// การ์ดอื่นที่ scope เดียวกันและมีคำร่วมยาว >= 4 — คือที่ที่ "ความขัดแย้งเชิงความหมาย" ซ่อนอยู่
function contradictionNeighbour(card, cards) {
  const mine = normalizeThai(String(card?.body?.title ?? card?.body?.label_th ?? ""));
  if (mine.length < 4) return null;
  const needle = mine.slice(0, 6);
  return cards.find((other) => other.itemId !== card.itemId
    && other.kind === card.kind
    && normalizeThai(JSON.stringify(other.body ?? {})).includes(needle)) ?? null;
}

/* ---------------------------------- ตัวด่าน ---------------------------------- */

/**
 * @param {object} input
 * @param {string} input.gateMode        ต้องเป็น "heavy" เท่านั้น
 * @param {string} input.confirm         ตั๋วยืนยันของรุ่นนี้ (ดู g5bConfirmToken)
 * @param {string} input.treeSha256      ลายเซ็นเนื้อของรุ่นที่กำลังจะเผยแพร่
 * @param {string} input.secret          กุญแจของ instance
 * @param {Function} input.askModel      **ต้องฉีดเข้ามา** — ({versionId, text}) => Promise<string>
 * @param {Function} input.onEstimate    **ต้องฉีดเข้ามา** — เรียกก่อนยิงคำขอแรกเสมอ
 * @returns {Promise<object>}
 */
export async function runGate5b({
  gateMode = "", confirm = "", treeSha256 = "", secret = "", now = Date.now(),
  turns = [], cards = [], touched = [], liveVersionId = "live", candidateVersionId = "candidate",
  askModel = null, onEstimate = null, nonceStore = null,
} = {}) {
  // กุญแจ 1 — แฟล็กรันไทม์
  if (gateMode !== HEAVY_GATE_MODE) {
    return notApplicable("ด่านทดสอบกับโมเดลจริงยังปิดอยู่ (BRAIN_GATES ไม่ใช่ heavy)");
  }
  const plan = planG5b({ turns, cards, touched });
  if (!plan.replay.length && !plan.probes.length) {
    return notApplicable("การแก้ครั้งนี้ไม่มีอะไรให้ถามโมเดล");
  }
  // กุญแจ 2 — คำยืนยันรายครั้ง ผูกกับรุ่นและยอดเงิน
  const verdictOfConfirm = verifyG5bConfirm({ token: confirm, treeSha256, thb: plan.estimate.thb, secret, now, nonceStore });
  if (!verdictOfConfirm.ok) {
    throw new G5bRefused(
      `ด่านทดสอบกับโมเดลจริงต้องยืนยันก่อน (${plan.estimate.thaiSummary}) — ${verdictOfConfirm.reason}`,
      "confirm_required",
    );
  }
  // กุญแจ 3 — ไม่มี client เริ่มต้น
  if (typeof askModel !== "function") {
    throw new G5bRefused("G5b ไม่มีทางต่อโมเดลของตัวเอง ผู้เรียกต้องฉีด askModel เข้ามา", "no_client");
  }
  // กุญแจ 4 — ต้องแสดงยอดก่อนยิง ไม่ใช่หลังจ่าย
  if (typeof onEstimate !== "function") {
    throw new G5bRefused("ต้องรายงานค่าใช้จ่ายก่อนเรียกโมเดลเสมอ (กติกา eval/COST.md)", "no_cost_report");
  }
  await onEstimate(plan.estimate);

  const asks = [...plan.replay, ...plan.probes];
  const pairs = [];
  let calls = 0;
  const ask = async (versionId, text) => {
    calls += 1;
    return String(await askModel({ versionId, text }) ?? "");
  };
  for (const item of asks) {
    const text = item.text ?? "";
    if (!text) continue;
    const live = await ask(liveVersionId, text);
    const candidate = await ask(candidateVersionId, text);
    pairs.push({ ...item, live, candidate, differs: differs(live, candidate) });
  }
  // ทุกความต่างถูกรันซ้ำหนึ่งครั้งก่อนนับ (แบบแปลน §7 G5b) — โมเดลไม่นิ่งเท่ากันทุกรอบ
  const disagreements = pairs.filter((pair) => pair.differs).slice(0, G5B_CAPS.rerunPairs);
  for (const pair of disagreements) {
    const live = await ask(liveVersionId, pair.text);
    const candidate = await ask(candidateVersionId, pair.text);
    pair.confirmed = differs(live, candidate);
    pair.rerun = { live, candidate };
  }
  // ความต่างที่เกินเพดานการรันซ้ำ **ยังไม่ได้ยืนยัน** — ห้ามติดป้ายว่ายืนยันแล้ว
  // (เดิมถูกตั้งเป็น confirmed = true ทั้งที่ไม่เคยถูกรันซ้ำเลย = อ้างการพิสูจน์ที่ไม่ได้ทำ)
  for (const pair of pairs) if (pair.differs && pair.confirmed === undefined) pair.confirmed = null;

  const real = pairs.filter((pair) => pair.differs && pair.confirmed === true);
  const unverified = pairs.filter((pair) => pair.differs && pair.confirmed === null);
  const findings = real.map((pair) => ({
    code: GATE5B_ID,
    severity: BLOCK,
    cardId: pair.cardId ?? pair.caseId ?? null,
    detail: pair.kind,
    // คู่คำตอบไม่ลง gate_report (อาจมีชื่อลูกค้าอยู่ในคำตอบของเทิร์นจริง) — เก็บแยกใน gate_runs
    message: pair.kind === "contradiction"
      ? `ถามข้ามการ์ดแล้วคำตอบสองรุ่นไม่ตรงกัน (${pair.cardId} vs ${pair.against}) — ต้องอ่านคู่คำตอบก่อนเผยแพร่`
      : `คำตอบของรุ่นใหม่ต่างจากรุ่นที่ใช้อยู่ในคำถาม “${String(pair.text).slice(0, 40)}” — ต้องอ่านคู่คำตอบก่อนเผยแพร่`,
  }));
  // ยอดจริงคิดจาก "จำนวนคำขอที่เกิดขึ้นจริง" ไม่ใช่จากแผน — แผนคือความตั้งใจ ตัวนับคือความจริง
  const actual = costOfCalls(calls);
  return {
    id: GATE5B_ID,
    verdict: findings.length || unverified.length ? "needs_ack" : "pass",
    applicable: true,
    findings,
    // ความต่างที่ยังไม่ได้ยืนยัน ไม่ถือเป็นข้อบล็อก แต่ต้องขึ้นจอแยกถัง ไม่ใช่หายไป
    unverified: unverified.map((pair) => ({
      cardId: pair.cardId ?? pair.caseId ?? null, kind: pair.kind,
      message: `คำตอบต่างกันในคำถาม “${String(pair.text).slice(0, 40)}” แต่ยังไม่ได้รันซ้ำเพื่อยืนยัน`
        + " (เกินเพดานการรันซ้ำของรอบนี้) — ยังสรุปไม่ได้ว่าเป็นความต่างจริงหรือโมเดลไม่นิ่ง",
    })),
    pairs,
    calls,
    estimate: plan.estimate,
    cost: actual,
  };
}

/**
 * ยอดจริงจากตัวนับคำขอ: คำขอแรกของแต่ละรุ่น cache miss ที่เหลือ hit
 * (รูปทรงเดียวกับที่ estimateG5bCost ใช้ แต่คิดจากจำนวนที่เกิดขึ้นจริง)
 */
export function costOfCalls(calls) {
  const total = Math.max(0, Number(calls) || 0);
  const miss = Math.min(total, G5B_CAPS.versions);
  const hit = total - miss;
  const usd = miss * usdPerPrompt({ cached: false }) + hit * usdPerPrompt({ cached: true });
  return { prompts: total, missPrompts: miss, hitPrompts: hit, usd: Number(usd.toFixed(4)), thb: Number((usd * THB_PER_USD).toFixed(2)) };
}

function notApplicable(reason) {
  return {
    id: GATE5B_ID, verdict: "not_applicable", applicable: false, findings: [], pairs: [],
    calls: 0, estimate: null, cost: { thb: 0, usd: 0, prompts: 0 }, reason,
  };
}

/**
 * "ต่างกัน" ของด่านนี้ไม่ใช่ diff ตัวอักษร — โมเดลเรียบเรียงใหม่ทุกครั้งอยู่แล้ว
 * นับเฉพาะสิ่งที่เป็นข้อเท็จจริง: ชุดตัวเลข วันที่ และการมี/ไม่มีคำปฏิเสธ (แบบแปลน §7 G5b)
 */
export function differs(a, b) {
  const numbersA = numbersIn(a);
  const numbersB = numbersIn(b);
  if (numbersA !== numbersB) return true;
  return negation(a) !== negation(b);
}

function numbersIn(text) {
  return [...String(text).matchAll(/\d[\d,.]*/gu)].map((m) => m[0].replaceAll(",", "")).sort().join("|");
}

function negation(text) {
  return /ไม่|ยังไม่|ไม่ได้|ไม่มี/u.test(normalizeThai(text));
}
