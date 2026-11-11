// consoleEvalApi.mjs — เส้นทาง /console/api/eval/* ของเฟส 3
//
// หน้าที่เดียว: ทำให้ "การเผยแพร่ถูกบล็อก" อ่านออกโดยไม่ต้องเปิด log
//   GET  /eval/cases?ids=a,b        บทสนทนาที่พัง: ลูกค้าพูดอะไร ลูกแพรตอบว่าอะไร ผิดกฎข้อไหน
//   GET  /eval/failing              รายการเคสที่ค้างอยู่บนรุ่นที่ใช้งานจริง (แผงในหน้าตั้งค่า)
//   POST /eval/cases/:id/retire     เจ้าของปิดเกณฑ์ที่ล้าสมัย (ต้องเขียนเหตุผล + เปิดตั๋วให้ช่าง)
//   POST /eval/cases/:id/restore    เปิดเคสกลับ
//
// PDPA: ข้อความของลูกค้า **ไม่เคยถูกเก็บ** ใน golden_turns หรือ gate_report — เส้นนี้ไป
// อ่านสดจาก messages ทุกครั้ง ห้องที่ถูกลบตามคำขอลืมจึงหายจากหน้าจอเองโดยอัตโนมัติ
// และแถวที่ชี้ห้องนั้นก็ถูกลบไปแล้วด้วย (db.resetCustomer)
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { assertionThai, failThai } from "./brain/goldenAssert.mjs";
import { offlineGatesOn } from "./brain/gate.mjs";
import { runGate5 } from "./brain/gate5.mjs";
import { compileBrain } from "./brain/compile.mjs";
import { todayInBangkok } from "./brain/import.mjs";

export const EVAL_READ_CAPABILITY = "corrections.review";
export const EVAL_RETIRE_CAPABILITY = "brain.publish";
const QUIET = Object.freeze({ warn() {}, debug() {}, log() {}, error() {} });
const CASE_LIMIT = 40;
const SNIPPET = 140;

export function createEvalRoutes({ db, config = {}, logger = console, notifier = null, denyMessage = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้" }) {
  const enabled = config.teachEnabled === true;

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "eval") return false;
    const { json, operator, username, requireCsrf } = ctx;
    // แฟล็กปิด = เส้นนี้ต้องเหมือนไม่มีอยู่จริง (กติกาเดียวกับ /console/api/teach/*)
    if (!enabled) {
      json(res, 404, { ok: false, error: "ไม่พบเส้นทางนี้" });
      return true;
    }
    if (!hasOperatorCapability(operator, EVAL_READ_CAPABILITY)) {
      json(res, 403, { ok: false, error: denyMessage });
      return true;
    }
    const canRetire = hasOperatorCapability(operator, EVAL_RETIRE_CAPABILITY);

    /* ---- GET /eval/cases?ids=... — "บทสนทนาไหนพัง และพังยังไง" ---- */
    if (req.method === "GET" && route[1] === "cases" && route.length === 2) {
      const ids = String(url.searchParams.get("ids") || "").split(",").map((id) => id.trim()).filter(Boolean);
      json(res, 200, {
        ok: true, canRetire,
        cases: ids.slice(0, CASE_LIMIT).map((id) => caseDetail(db, id)).filter(Boolean),
      });
      return true;
    }

    /* ---- GET /eval/failing — ของที่ค้างอยู่บนรุ่นที่ใช้งานจริง ---- */
    if (req.method === "GET" && route[1] === "failing" && route.length === 2) {
      json(res, 200, { ok: true, canRetire, ...standingFailures(db, config, logger) });
      return true;
    }

    /* ---- POST /eval/cases/:id/(retire|restore) — เจ้าของเท่านั้น ---- */
    const action = route.length === 4 && route[1] === "cases" && req.method === "POST" ? route[3] : "";
    if (!["retire", "restore"].includes(action)) return false;
    if (!canRetire) {
      json(res, 403, { ok: false, error: denyMessage });
      return true;
    }
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }
    let caseId = null;
    try { caseId = decodeURIComponent(route[2]); } catch { caseId = null; }
    const detail = caseId ? caseDetail(db, caseId, { includeRetired: true }) : null;
    if (!detail) {
      json(res, 404, { ok: false, error: "ไม่พบบทสนทนานี้ในคลัง" });
      return true;
    }
    try {
      // ชื่อบทสนทนาเป็นของที่คนติดป้ายพิมพ์เอง — ห้องจริงอาจมีชื่อลูกค้าอยู่ในนั้น
      // audit และ LINE push อยู่นอก cascade ของสิทธิ์ให้ลืม จึงใช้ได้แค่ "ป้ายกลาง ๆ"
      // ชื่อจริงยังอยู่บนจอ (อ่านสดจาก golden_turns -> messages) ซึ่งหายไปพร้อมลูกค้าเอง
      const safeLabel = detail.turns.some((row) => row.fromRealRoom)
        ? `บทสนทนาจริงในห้องลูกค้า (${caseId})`
        : `“${detail.title}” (${caseId})`;
      if (action === "restore") {
        db.restoreGoldenCase(caseId);
        db.addAudit({ operator: username, action: "eval_case_restore", target: caseId, detail: safeLabel });
        json(res, 200, { ok: true, applied: true, case: caseDetail(db, caseId, { includeRetired: true }) });
        return true;
      }
      const body = await ctx.readJson(req).catch(() => ({}));
      const reason = String(body?.reason || "").trim();
      const changed = db.retireGoldenCase(caseId, { by: username, reason });
      if (!changed) {
        json(res, 409, { ok: false, error: "บทสนทนานี้ถูกปิดไปแล้ว" });
        return true;
      }
      // ปิดเกณฑ์ = เปิดตั๋วงานให้ช่างเขียนเคสใหม่ ไม่ใช่โน้ตที่หายไป (แบบแปลน §6 Step 4)
      db.addAudit({
        operator: username, action: "eval_case_retired", target: caseId,
        detail: `${safeLabel} · เหตุผล: ${reason.slice(0, 160)} · ต้องเขียนเคสใหม่แทน`,
      });
      try {
        notifier?.fireLater({
          customerId: "ops:eval", channelId: "default", reason: "eval_case_retired", force: true,
          reasonTextOverride: `${username} ปิดเกณฑ์ทดสอบ ${safeLabel} เพราะล้าสมัย`
            + `\nเหตุผล: ${reason.slice(0, 160)}`
            + "\nงานที่ค้าง: ช่างต้องเขียนเคสใหม่มาแทน ไม่งั้นเรื่องนี้จะไม่มีใครตรวจอีกเลย",
        });
      } catch (err) { logger.debug?.(`eval: เปิดตั๋วให้ช่างไม่สำเร็จ (${err?.message || err})`); }
      json(res, 200, { ok: true, applied: true, case: caseDetail(db, caseId, { includeRetired: true }) });
      return true;
    } catch (err) {
      json(res, 400, { ok: false, error: String(err?.message || err) });
      return true;
    }
  }

  return { handle };
}

/* --------------------------------- ตัวช่วย --------------------------------- */

/**
 * บทสนทนาหนึ่งเคส แปลงเป็นสิ่งที่คนอ่านออก
 *
 * เกณฑ์ทุกข้อถูกแปลเป็นภาษาไทย เพราะเจ้าของต้องตัดสินได้ว่า "ข้อนี้ล้าสมัยจริงไหม"
 * โดยไม่ต้องอ่านโค้ด — และเคส irreversible ยังบล็อกต่อไปแม้ถูกปิด จึงยิ่งต้องอ่านออก
 */
export function caseDetail(db, caseId, { includeRetired = true } = {}) {
  const rows = safe(() => db.listGoldenTurns({ includeRetired, limit: 20000 }), [])
    .filter((row) => String(row.case_id) === String(caseId))
    .sort((a, b) => Number(a.turn_no) - Number(b.turn_no));
  if (!rows.length) return null;
  const head = rows[0];
  return {
    caseId: String(caseId),
    title: String(head.title || caseId),
    origin: String(head.origin || ""),
    severity: String(head.severity || "style"),
    // irreversible = พังแล้วกู้ไม่ได้ (ลูกค้าโอนเงินแล้วไม่มีใครรู้) — ปิดเกณฑ์แล้วยังบล็อกอยู่
    blocksEvenWhenRetired: rows.some((row) => row.severity === "irreversible"),
    retired: head.retired_at
      ? { by: head.retired_by, reason: head.retired_reason, at: head.retired_at }
      : null,
    // เทิร์นจริงอ่านข้อความสดจาก messages เสมอ — ห้องที่ถูกลบตามคำขอลืมจะไม่มีอะไรให้อ่าน
    turns: rows.map((row) => ({
      turnId: row.turn_id,
      turnNo: row.turn_no,
      fromRealRoom: Boolean(row.message_ref),
      customerSaid: customerText(db, row),
      lukpraeAnswered: answerSnippet(row),
      expectations: parse(row.expected_json, []).map((expect) => assertionThai(expect)),
    })),
  };
}

function customerText(db, row) {
  if (row.synthetic_text !== null && row.synthetic_text !== undefined) return String(row.synthetic_text).slice(0, SNIPPET);
  if (!row.message_ref) return null;
  const message = safe(() => db.messageBrainContext(row.message_ref), null);
  // ห้องหายไปตามคำขอลืม = ไม่มีอะไรให้อ่าน และต้องพูดตรง ๆ ไม่ใช่แสดงเป็นช่องว่าง
  return message?.content ? String(message.content).slice(0, SNIPPET) : null;
}

function answerSnippet(row) {
  const raw = row.recorded_model_output;
  if (!raw) return null;
  const parsed = parse(raw, null);
  const text = Array.isArray(parsed) ? parsed.join("\n") : String(raw);
  return text.slice(0, SNIPPET);
}

/**
 * เคสที่ยังพังอยู่บนรุ่นที่ใช้งานจริง — คิดสด ไม่ใช่ค่าที่ค้างจากตอนเผยแพร่
 * (รอบเรียนที่ผ่านไปแล้ว/โปรที่หมดอายุ ทำให้ของที่เคยผ่านกลายเป็นตกได้เอง)
 */
export function standingFailures(db, config = {}, logger = console) {
  const gateMode = String(config.brainGates || "");
  if (!offlineGatesOn(gateMode)) {
    return { enabled: false, reason: "ด่านเล่นซ้ำยังปิดอยู่ (BRAIN_GATES)", cases: [] };
  }
  const live = safe(() => db.getBrainPointer("live"), null);
  if (!live) return { enabled: true, reason: "ยังไม่มีรุ่นสมองที่ใช้งานจริง", cases: [] };
  try {
    const todayIso = todayInBangkok(Date.now());
    const bundle = compileBrain(db, live.version_id, { todayIso, logger: QUIET });
    // touched ว่าง = "เอาทั้งรุ่นมาตรวจ" ซึ่งเลือกเฉพาะเคส floor ตามกติกาของ G5
    const report = runGate5({
      turns: db.listGoldenTurns({ includeRetired: true }), cards: bundle.cards, bundle,
      previousBundle: bundle, touched: [], db, bannedPhrases: [], extraRules: [],
    });
    const failing = report.cases.filter((row) => row.newFails.length || row.oldFails.length);
    return {
      enabled: true,
      reason: report.applicable ? "" : report.summary.reason,
      summary: report.summary,
      // ด่านนี้ตัดสินให้แค่บางเรื่อง และเชื่อหลักฐานที่มีอายุ — ต้องเขียนไว้บนหน้าจอ
      // ไม่ใช่ปล่อยให้ "เขียว" ถูกอ่านว่า "ทุกอย่างเรียบร้อย"
      judged: report.summary.judged ?? [],
      outOfScope: report.summary.outOfScope ?? [],
      evidenceOldestAt: report.summary.evidenceOldestAt ?? null,
      evidenceNewestAt: report.summary.evidenceNewestAt ?? null,
      // แนบรายละเอียดเต็มมาเลย (ลูกค้าพูดอะไร ลูกแพรตอบว่าอะไร เกณฑ์คืออะไร) — หน้าเว็บ
      // จะได้ไม่ต้องยิงเส้นที่สองต่อการ์ดหนึ่งใบ ซึ่งบนมือถือแปลว่ารอสองรอบเต็ม ๆ
      cases: failing.slice(0, CASE_LIMIT).map((row) => ({
        ...(caseDetail(db, row.caseId) ?? { caseId: row.caseId, title: row.caseId, turns: [] }),
        severity: row.severity,
        broke: [...row.newFails, ...row.oldFails].map((fail) => failThai(fail)),
      })),
    };
  } catch (err) {
    logger.warn?.(`eval: อ่านรายการเคสที่ค้างไม่ได้ (${err?.message || err})`);
    return { enabled: true, reason: `อ่านรายการไม่ได้: ${err?.message || err}`, cases: [] };
  }
}

function parse(text, fallback) {
  try {
    const value = JSON.parse(String(text ?? ""));
    return value ?? fallback;
  } catch { return fallback; }
}

function safe(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}
