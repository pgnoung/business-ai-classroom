// brain/goldenStore.mjs — ทางเขียน/อ่านเดียวของคลังเทิร์นตรวจซ้ำ (เฟส 3)
//
// สามตาราง หนึ่งความคิด: "ของที่ตรวจซ้ำได้" ต้องมีที่อยู่ที่เดียว
//   golden_turns    เทิร์นที่เราเล่นซ้ำได้ (เคส eval + ป้ายจริงจาก ledger/คน)
//   eval_baselines  ผลทุกรอบต่อ (เคส, รุ่น) + คะแนนความไม่นิ่ง — วัตถุดิบของ G8
//   gate_runs       ใบเสร็จของด่านที่มีต้นทุน (เวลา/เงิน)
//
// กติกาเหล็กของไฟล์นี้:
//   1. ข้อความลูกค้าจริง **ไม่เคย** ถูกเก็บที่นี่ เก็บได้แค่ `message_ref` (ตัวชี้ที่ลบตาม
//      cascade) กับ `text_hmac` — และ HMAC ต้องมีกุญแจของ instance เสมอ ไม่มีกุญแจ =
//      ปฏิเสธการเขียน ไม่ใช่ตกกลับไปใช้ sha เปล่า (sha ของข้อความสั้นย้อนกลับได้ด้วย
//      dictionary ในไม่กี่วินาที ซึ่งทำให้ "ไม่เก็บข้อความ" กลายเป็นคำพูดที่ไม่จริง)
//   2. เทิร์นสังเคราะห์เก็บข้อความได้ตรง ๆ (`synthetic_text`) เพราะไม่ใช่ของใคร แต่ยัง
//      ต้องมีกุญแจเหมือนกัน: ถ้ายอมให้เขียนแบบไม่มีกุญแจ วันหนึ่งจะมีคนเขียนแถวของจริง
//      ผ่านทางนั้น (ทางถอยที่อ่อนกว่า คือทางที่คนใช้ตอนรีบ)
import { createHmac, randomUUID } from "node:crypto";
import { normalizeThai, stableJson } from "./text.mjs";

const HMAC_DOMAIN = "lukprae-golden-turn-v1\0";

export const GOLDEN_SEVERITIES = Object.freeze(["irreversible", "lead", "style"]);
export const GATE_RUN_VERDICTS = Object.freeze(["pass", "block", "needs_ack", "error", "not_applicable"]);

/**
 * ลายนิ้วมือของข้อความหนึ่งเทิร์น — normalize ก่อนเสมอ (แบบแปลน §5 "ทุกข้อความที่เข้าระบบ
 * เทียบ ผ่าน normalizeThai ก่อนบันทึกและก่อนเทียบ") ไม่งั้นข้อความเดียวกันที่ต่างกันแค่
 * อักขระความกว้างศูนย์จะได้ลายนิ้วมือคนละตัว แล้วคลังจะมีของซ้ำที่มองไม่เห็นว่าซ้ำ
 */
export function goldenTextHmac(text, secret = "") {
  const key = String(secret || "");
  if (!key) throw new Error("golden: ต้องมีกุญแจของ instance (CONSOLE_SESSION_SECRET) ก่อนทำลายนิ้วมือข้อความ");
  return createHmac("sha256", key).update(HMAC_DOMAIN).update(normalizeThai(text)).digest("hex");
}

function assertSeverity(severity) {
  if (!GOLDEN_SEVERITIES.includes(severity)) {
    throw new Error(`golden: severity "${severity}" ไม่ถูกต้อง (ใช้ได้: ${GOLDEN_SEVERITIES.join(", ")})`);
  }
}

export function createGoldenDbMethods({ run, all, get, now, hmacSecret = "" }) {
  return {
    /* ------------------------------- golden_turns ------------------------------ */

    /**
     * เขียน/ทับเทิร์นหนึ่งแถว — คีย์คือ turn_id ที่ผู้เรียกกำหนด (เช่น "probe-price-01#1")
     * seeder จึงรันซ้ำได้โดยไม่เกิดของซ้ำ และการนำเข้าใหม่ทับของเดิมได้อย่างตั้งใจ
     *
     * ต้องมี message_ref หรือ synthetic_text อย่างน้อยหนึ่ง — แถวที่ไม่มีทั้งคู่คือแถวที่
     * เล่นซ้ำไม่ได้ ซึ่งเป็นสิ่งเดียวที่ตารางนี้มีไว้ทำ
     */
    upsertGoldenTurn({
      turnId = null, caseId, title = "", turnNo = 1, messageRef = null, syntheticText = null,
      routeInputs = {}, expected = [], recordedModelOutput = null, recordedAt = null, recordedFrom = null,
      severity = "style",
      origin = "unknown", scope = {}, labelledBy = null, labelledAt = null, text = null,
    } = {}) {
      if (!caseId) throw new Error("golden: ต้องมี caseId");
      assertSeverity(severity);
      const ref = messageRef ? String(messageRef) : null;
      const synthetic = syntheticText === null || syntheticText === undefined ? null : String(syntheticText);
      if (!ref && synthetic === null) {
        throw new Error("golden: เทิร์นต้องมี messageRef (ของจริง) หรือ syntheticText (สังเคราะห์) อย่างน้อยหนึ่ง");
      }
      // ลายนิ้วมือทำจากข้อความจริงที่ผู้เรียกถืออยู่ (ของจริงอ่านจาก messages ก่อนเรียก)
      // ไม่ใช่จาก synthetic_text เสมอ — เทิร์นจริงไม่มี synthetic_text ให้ใช้
      const source = text === null || text === undefined ? synthetic ?? "" : String(text);
      const id = String(turnId || `${caseId}#${turnNo}`);
      run(
        `INSERT INTO golden_turns
           (turn_id, case_id, title, turn_no, message_ref, synthetic_text, text_hmac, route_inputs_json,
            expected_json, recorded_model_output, recorded_at, recorded_from, severity, origin, scope_json,
            retired_by, retired_reason, retired_at, labelled_by, labelled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
         ON CONFLICT(turn_id) DO UPDATE SET
           case_id = excluded.case_id, title = excluded.title, turn_no = excluded.turn_no,
           message_ref = excluded.message_ref, synthetic_text = excluded.synthetic_text,
           text_hmac = excluded.text_hmac, route_inputs_json = excluded.route_inputs_json,
           expected_json = excluded.expected_json, recorded_model_output = excluded.recorded_model_output,
           recorded_at = excluded.recorded_at, recorded_from = excluded.recorded_from,
           severity = excluded.severity, origin = excluded.origin, scope_json = excluded.scope_json,
           labelled_by = excluded.labelled_by, labelled_at = excluded.labelled_at`,
        id, String(caseId), String(title ?? "").slice(0, 200), Math.max(1, Number(turnNo) || 1), ref, synthetic,
        goldenTextHmac(source, hmacSecret), stableJson(routeInputs ?? {}),
        stableJson(Array.isArray(expected) ? expected : []),
        recordedModelOutput === null || recordedModelOutput === undefined ? null : String(recordedModelOutput),
        recordedAt ?? null, recordedFrom ? String(recordedFrom) : null,
        String(severity), String(origin), stableJson(scope ?? {}),
        labelledBy ? String(labelledBy) : null, labelledAt ?? null,
      );
      return this.getGoldenTurn(id);
    },

    getGoldenTurn(turnId) {
      return get("SELECT * FROM golden_turns WHERE turn_id = ?", String(turnId)) ?? null;
    },

    /**
     * @param {{includeRetired?: boolean, limit?: number}} [options]
     * includeRetired ต้องขอเอง — ทางอ่านปกติของด่านต้องไม่เห็นเคสที่เจ้าของปิดไปแล้ว
     * ยกเว้นเคส irreversible ซึ่งด่านดึงกลับมาเองอีกที (ดู gate5.mjs) ไม่ใช่ที่นี่
     */
    listGoldenTurns({ includeRetired = false, limit = 2000 } = {}) {
      return all(
        `SELECT * FROM golden_turns${includeRetired ? "" : " WHERE retired_at IS NULL"}
          ORDER BY case_id, turn_no LIMIT ?`,
        Math.min(20000, Math.max(1, Number(limit) || 2000)),
      );
    },

    countGoldenTurns() {
      return Number(get("SELECT COUNT(*) AS n FROM golden_turns")?.n ?? 0);
    },

    /**
     * เจ้าของปิดเคสที่ล้าสมัย — ระดับ "เคส" ไม่ใช่ระดับเทิร์น เพราะเกณฑ์ที่ล้าสมัยเป็น
     * สมบัติของบทสนทนาทั้งเส้น ไม่ใช่ของประโยคเดียวกลางเส้น
     */
    retireGoldenCase(caseId, { by = "owner", reason = "", at = null } = {}) {
      const text = String(reason || "").trim();
      if (text.length < 8) throw new Error("golden: ต้องเขียนเหตุผลอย่างน้อย 8 ตัวอักษรว่าเกณฑ์นี้ล้าสมัยยังไง");
      return run(
        "UPDATE golden_turns SET retired_by = ?, retired_reason = ?, retired_at = ? WHERE case_id = ? AND retired_at IS NULL",
        String(by), text.slice(0, 500), Number(at ?? now()), String(caseId),
      ).changes;
    },

    restoreGoldenCase(caseId) {
      return run(
        "UPDATE golden_turns SET retired_by = NULL, retired_reason = NULL, retired_at = NULL WHERE case_id = ?",
        String(caseId),
      ).changes;
    },

    /**
     * PDPA: ลบเทิร์นที่ชี้ไปยังข้อความของลูกค้าคนหนึ่ง — เรียกจาก resetCustomer **ก่อน**
     * ลบแถว messages ไม่งั้น subquery จะหาไม่เจอแล้วตัวชี้ค้างอยู่ตลอดกาล
     */
    deleteGoldenTurnsForCustomer(customerId) {
      return run(
        "DELETE FROM golden_turns WHERE message_ref IN (SELECT id FROM messages WHERE customer_id = ?)",
        String(customerId),
      ).changes;
    },

    /* ------------------------------ eval_baselines ----------------------------- */

    /**
     * บันทึกผลหนึ่งรอบของเคสหนึ่งบนรุ่นหนึ่ง แล้วคิดคะแนนความไม่นิ่งใหม่ทุกครั้ง
     *
     * flake_score = สัดส่วนของ "เสียงข้างน้อย" ในผลทั้งหมดที่บันทึกไว้ (0 = ทุกรอบตรงกัน,
     * 0.5 = เถียงกันครึ่งต่อครึ่ง) เคสที่เถียงกับตัวเองไม่ควรได้สิทธิ์บล็อกการเผยแพร่
     */
    recordEvalResult({ caseId, versionId, verdict, fails = [], at = null, keep = 9 } = {}) {
      if (!caseId || !versionId) throw new Error("golden: ต้องมี caseId และ versionId");
      const previous = this.getEvalBaseline(caseId, versionId);
      const history = [...(previous?.results ?? []), {
        at: Number(at ?? now()), verdict: String(verdict),
        fails: (Array.isArray(fails) ? fails : []).map((f) => ({ rule: String(f.rule || ""), detail: String(f.detail || "") })),
      }].slice(-Math.max(2, Number(keep) || 9));
      const score = flakeScore(history.map((row) => row.verdict));
      run(
        `INSERT INTO eval_baselines (case_id, version_id, results_json, flake_score, recorded_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(case_id, version_id) DO UPDATE SET
           results_json = excluded.results_json, flake_score = excluded.flake_score,
           recorded_at = excluded.recorded_at`,
        String(caseId), String(versionId), stableJson(history), score, Number(at ?? now()),
      );
      return { caseId: String(caseId), versionId: String(versionId), results: history, flakeScore: score };
    },

    getEvalBaseline(caseId, versionId) {
      const row = get("SELECT * FROM eval_baselines WHERE case_id = ? AND version_id = ?", String(caseId), String(versionId));
      return row ? decodeBaseline(row) : null;
    },

    listEvalBaselines(versionId, { limit = 2000 } = {}) {
      return all(
        "SELECT * FROM eval_baselines WHERE version_id = ? ORDER BY case_id LIMIT ?",
        String(versionId), Math.min(20000, Math.max(1, Number(limit) || 2000)),
      ).map(decodeBaseline);
    },

    // ใบเสร็จของ "รอบที่เจ้าของตัดสินใจปิดเคส" — ไม่ใช่แหล่งความจริงของการปิด (ดู schema)
    stampEvalRetirement({ caseId, versionId, by = "owner", reason = "" } = {}) {
      return run(
        "UPDATE eval_baselines SET retired_by = ?, retired_reason = ? WHERE case_id = ? AND version_id = ?",
        String(by), String(reason).slice(0, 500), String(caseId), String(versionId),
      ).changes;
    },

    /* -------------------------------- gate_runs -------------------------------- */

    recordGateRun({
      runId = null, versionId = null, releaseId = null, kind, snapshotSha256 = null,
      startedAt = null, finishedAt = null, verdict = "pass", report = {}, costThb = 0,
    } = {}) {
      if (!kind) throw new Error("golden: gate_runs ต้องมี kind");
      if (!GATE_RUN_VERDICTS.includes(verdict)) throw new Error(`golden: verdict "${verdict}" ไม่ถูกต้อง`);
      const id = String(runId || randomUUID());
      run(
        `INSERT INTO gate_runs (run_id, version_id, release_id, kind, snapshot_sha256,
             started_at, finished_at, verdict, report_json, cost_thb)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, versionId ? String(versionId) : null, releaseId ? String(releaseId) : null,
        String(kind), snapshotSha256 ? String(snapshotSha256) : null,
        startedAt ?? now(), finishedAt ?? now(), String(verdict),
        stableJson(report ?? {}), Number(costThb) || 0,
      );
      return get("SELECT * FROM gate_runs WHERE run_id = ?", id) ?? null;
    },

    listGateRuns(versionId, { limit = 20 } = {}) {
      return all(
        "SELECT * FROM gate_runs WHERE version_id = ? ORDER BY finished_at DESC LIMIT ?",
        String(versionId), Math.min(200, Math.max(1, Number(limit) || 20)),
      );
    },

    // ค่าใช้จ่ายรวมของด่านในหน้าต่างเวลาหนึ่ง — การ์ดค่าโมเดลของคอนโซลอ่านตัวนี้
    gateCostSince(sinceMs = 0) {
      return Number(get("SELECT COALESCE(SUM(cost_thb), 0) AS thb FROM gate_runs WHERE finished_at >= ?",
        Number(sinceMs) || 0)?.thb ?? 0);
    },
  };
}

/**
 * สัดส่วนเสียงข้างน้อย: [pass,pass,pass] = 0 · [pass,fail,pass] = 1/3 · [pass,fail] = 1/2
 * ประวัติสั้นกว่าสองรอบยังไม่มีอะไรให้เถียงกัน = 0
 */
export function flakeScore(verdicts = []) {
  const list = verdicts.map(String);
  if (list.length < 2) return 0;
  const counts = new Map();
  for (const verdict of list) counts.set(verdict, (counts.get(verdict) ?? 0) + 1);
  const majority = Math.max(...counts.values());
  return Number(((list.length - majority) / list.length).toFixed(4));
}

function decodeBaseline(row) {
  let results = [];
  try { results = JSON.parse(String(row.results_json || "[]")); } catch { results = []; }
  return {
    caseId: row.case_id, versionId: row.version_id,
    results: Array.isArray(results) ? results : [],
    flakeScore: Number(row.flake_score) || 0,
    retiredBy: row.retired_by ?? null, retiredReason: row.retired_reason ?? null,
    recordedAt: row.recorded_at ?? null,
  };
}
