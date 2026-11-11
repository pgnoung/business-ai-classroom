// brain/runtime.mjs — ทางอ่านสมองของเส้นตอบลูกค้า (แบบแปลน §11 P2)
//
// หน้าที่เดียว: ตอบให้ได้ว่า "เทิร์นนี้ใช้สมองรุ่นไหน และรุ่นนั้นหน้าตาอย่างไร"
// แล้วส่ง bundle ที่คอมไพล์แล้วกลับไป — ตัวประกอบ prompt กับ guard เป็นคนใช้ต่อ
//
// กติกาเหล็ก:
//   1. พังทางไหนก็คืน null: ผู้เรียกใช้ทางเดิมเมื่อ retrieval ปิด และพักการร่างเมื่อเปิด
//      — ห้ามใช้ความรู้ทั้งคลังแทนชุดที่เลือกไม่ได้ ต้องนับและปลุกทีมตามอาการ
//   2. ห้องเดียวกันห้ามสลับฝั่ง canary กลางบทสนทนา: ฝั่งมาจาก hash ของ customer_id ล้วน
//      (กติกาอยู่ใน brain/canary.mjs พร้อมชนิดที่ทดลองไม่ได้)
//   3. คอมไพล์ deterministic -> cache ในหน่วยความจำตาม tree_sha256
//   4. code_contract ที่ใหม่กว่าโค้ดที่รันอยู่ = ถอยไปรุ่นที่โหลดได้ ไม่ใช่ "ไม่มีสมอง"
//   5. "ข้อมูลยังไม่พร้อม" (ไม่มีรุ่น live / สมองไม่ตรงตารางจริง) ห้ามทำให้บริการล่ม —
//      ดังให้สุด แล้ววิ่งทางเดิมต่อ (mode = legacy_forced) ลูกค้าต้องได้คำตอบเสมอ
import { createHash } from "node:crypto";
import { compileBrain, expiredRevIdsAt } from "./compile.mjs";
import { BRAIN_CODE_CONTRACT } from "./import.mjs";
import { inCanaryCohort } from "./canary.mjs";
import { brainParityReport } from "./parity.mjs";
import { BRAIN_PARITY_QUIET_REASONS } from "./parityWatch.mjs";

export { customerBucket, inCanaryCohort } from "./canary.mjs";

// contract ที่โค้ดชุดนี้ประกอบเป็น prompt ได้จริง — เพิ่มชื่อใหม่เมื่อคอมไพเลอร์รองรับจริง
export const SUPPORTED_CODE_CONTRACTS = Object.freeze([BRAIN_CODE_CONTRACT]);
// รุ่นที่ยอมถอยไปใช้เมื่อรุ่นที่ pointer ชี้โหลดไม่ได้ — ต้องเคยถึงมือลูกค้ามาแล้วเท่านั้น
// เรียงตามความชอบ: live ปัจจุบัน > รุ่นที่ย้อนกลับไว้ > รุ่นที่ปลดระวางแล้ว
const FALLBACK_STATUS_RANK = Object.freeze({ live: 0, rolled_back: 1, retired: 2 });
const BUNDLE_CACHE_MAX = 6;
const QUIET_PARITY = new Set(BRAIN_PARITY_QUIET_REASONS);
// ไม่มีรุ่น live ตอนบูต = ตรวจซ้ำได้เอง (นำเข้าเสร็จแล้วไม่ต้องรีสตาร์ท) แต่ไม่ถี่จนเปลือง
const LIVE_RECHECK_MS = 60_000;

/**
 * ด่านตอนบูตส่วนที่ "ตั้งค่าผิด" — อันนี้ fatal จริง เพราะแก้ได้ด้วยการแก้ไฟล์ env เท่านั้น
 * และไม่มีทางที่การรันต่อจะถูก (BRAIN_READ=versioned โดยตารางเดิมยังมีทางเขียนอื่น
 * = สมองกับตารางเดินคนละทางโดยไม่มีใครเห็น — แบบแปลน §5)
 *
 * ส่วนที่เป็น "ข้อมูลยังไม่พร้อม" (ไม่มีรุ่น live) **ไม่** อยู่ที่นี่โดยเจตนา: มันเป็น
 * เงื่อนไขที่กู้ได้ และการไม่ยอมบูตเพราะเรื่องนี้ = ลูกค้าไม่ได้รับคำตอบเลยทั้งระบบ
 */
export function assertBrainReadConfig({ config = {} } = {}) {
  if (config.brainRetrievalEnabled === true && config.brainRead !== "versioned") {
    throw new Error("BRAIN_RETRIEVAL_ENABLED ต้องใช้ BRAIN_READ=versioned และ KNOWLEDGE_VERSIONED=true");
  }
  if (config.brainRead !== "versioned") return { ok: true, reason: "legacy" };
  if (config.knowledgeVersioned !== true) {
    throw new Error(
      "BRAIN_READ=versioned ต้องเปิด KNOWLEDGE_VERSIONED ด้วย — ไม่งั้นตารางเดิมยังมีทางเขียนอื่น"
      + " แล้วสมองที่ลูกค้าได้ยินกับตารางที่คอนโซลแสดงจะเดินคนละทางโดยไม่มีใครเห็น"
    );
  }
  return { ok: true, reason: "versioned" };
}

/**
 * @param {{db: object, config: object, logger?: object, notifier?: object|null, now?: Function}} deps
 */
export function createBrainRuntime({ db, config = {}, logger = console, notifier = null, now = Date.now } = {}) {
  assertBrainReadConfig({ config });
  const enabled = config.brainRead === "versioned";
  const retrievalEnabled = config.brainRetrievalEnabled === true;
  const alertStreak = Math.max(1, Math.trunc(Number(config.brainFallbackAlertStreak) || 5));
  const alertCooldownMs = Math.max(60_000, Number(config.brainFallbackAlertCooldownMs) || 30 * 60_000);
  const soakMs = Math.max(0, Number(config.brainReadSoakMs) || 0);

  const bundles = new Map();   // cacheKey -> bundle
  const windows = new Map();   // versionId -> [{rev_id, valid_from, valid_until}]
  const contracts = new Map(); // versionId ที่โหลดไม่ได้ -> เวอร์ชันที่ถอยไปใช้ (หรือ null)
  const pointers = new Map();  // "live"|"canary" -> สถานะของฝั่งนั้น
  const totals = { fallbacks: 0, contractFallbacks: 0 };
  let forcedLegacy = null;     // {reason, since, nextCheckAt}
  let parityHold = null;       // {reason, since, signature}

  const clock = () => (typeof now === "function" ? Number(now()) : Number(now));

  function stateOf(role) {
    const key = role || "live";
    if (!pointers.has(key)) {
      pointers.set(key, {
        role: key, versionId: null, seq: null, soakUntil: 0,
        consecutive: 0, fallbacks: 0, alerted: false, alertedAt: 0,
        lastOkAt: null, lastFailureAt: null,
      });
    }
    return pointers.get(key);
  }

  function alertOps(reason, text, detail) {
    logger.error?.(`[brainRuntime] ${text}`);
    // ops: = เรื่องระบบ ไม่ผูกกับลูกค้า · force เพราะ cooldown ของ notify ผูกกับลูกค้า
    notifier?.fireLater?.({
      customerId: "ops:brain", channelId: "default", reason,
      reasonTextOverride: text, force: true,
    });
    try {
      db.addAudit?.({ operator: "system", action: reason, target: "ops:brain", detail: String(detail || "") });
    } catch { /* audit ล้มไม่กระทบเส้นทางตอบ */ }
  }

  /* ------------------------------ ตัวคอมไพล์ + cache ----------------------------- */

  function validityWindows(version) {
    const cached = windows.get(version.version_id);
    if (cached) return cached;
    const manifest = safeJson(version.manifest_json);
    const rows = db.listBrainRevs(manifest.revIds ?? [])
      .map((rev) => ({ rev_id: rev.rev_id, valid_from: rev.valid_from, valid_until: rev.valid_until }));
    if (windows.size >= BUNDLE_CACHE_MAX) windows.delete(windows.keys().next().value);
    windows.set(version.version_id, rows);
    return rows;
  }

  function bundleFor(version, at) {
    const expired = expiredRevIdsAt(validityWindows(version), at);
    const cacheKey = `${version.tree_sha256}|${expired.length ? sha(expired.join(",")) : ""}`;
    const cached = bundles.get(cacheKey);
    if (cached) return cached;
    const bundle = compileBrain(db, version.version_id, { activeAt: at, logger });
    if (bundles.size >= BUNDLE_CACHE_MAX) bundles.delete(bundles.keys().next().value);
    bundles.set(cacheKey, bundle);
    return bundle;
  }

  /**
   * ตารางราคาของสองรุ่นต่างกันไหม — ใช้ตัดสินว่าห้องที่กำลังคุยเรื่องเงินอยู่
   * "ถูกเปลี่ยนตัวเลขใต้เท้า" หรือเปล่าเมื่อรุ่นที่ห้องนั้นใช้เปลี่ยนไป
   * @returns {boolean|null} null = พิสูจน์ไม่ได้ (ผู้เรียกต้องถือว่าเปลี่ยน)
   */
  function priceDriftBetween(fromVersionId, toVersionId, atMs = null) {
    if (!fromVersionId || !toVersionId || fromVersionId === toVersionId) return false;
    const at = atMs === null ? clock() : Number(atMs);
    try {
      const before = bundleFor(db.getBrainVersion(fromVersionId), at);
      const after = bundleFor(db.getBrainVersion(toVersionId), at);
      return stableList(before.guardTables.approvedPrices) !== stableList(after.guardTables.approvedPrices);
    } catch {
      return null;
    }
  }

  /* --------------------------------- pointer --------------------------------- */

  function pickVersion(customerId, channelId, atMs) {
    let canary = null;
    try { canary = db.getBrainPointer("canary"); } catch { canary = null; }
    if (canary && inCanaryCohort(safeJson(canary.canary_json), { customerId, channelId, atMs })) return canary;
    return db.getBrainPointer("live");
  }

  // รุ่นที่ pointer ชี้โหลดไม่ได้ ห้ามแปลว่า "ไม่มีสมอง" — ถอยไปรุ่นที่เคยถึงลูกค้าและ
  // contract ยังโหลดได้ · จำคำตอบไว้ต่อ version id (ไม่ไล่ 50 แถวทุกเทิร์น) และดังครั้งเดียว
  function contractFallback(version) {
    if (contracts.has(version.version_id)) return contracts.get(version.version_id);
    const rows = db.listBrainVersions?.(50) ?? [];
    const usable = rows
      .filter((row) => row.version_id !== version.version_id
        && Object.hasOwn(FALLBACK_STATUS_RANK, String(row.status))
        && SUPPORTED_CODE_CONTRACTS.includes(String(row.code_contract)))
      .sort((a, b) => (FALLBACK_STATUS_RANK[a.status] - FALLBACK_STATUS_RANK[b.status])
        || (Number(b.seq) - Number(a.seq)))[0] ?? null;
    contracts.set(version.version_id, usable);
    totals.contractFallbacks += 1;
    alertOps(
      "brain_contract_fallback",
      `สมองรุ่น ${version.seq} ต้องใช้โค้ดรุ่น "${version.code_contract}" ซึ่งเครื่องนี้ยังไม่มี`
      + (usable
        ? ` — ถอยไปใช้รุ่น ${usable.seq} ให้อัตโนมัติแล้ว ลูกค้ายังได้คำตอบตามปกติ แต่การแก้ล่าสุดยังไม่ถึงลูกค้า`
        : " — และไม่มีรุ่นเก่าที่โหลดได้เลย ระบบวิ่งด้วยตารางเดิมไปก่อน"),
      `${version.version_id} -> ${usable?.version_id || "-"}`,
    );
    return usable;
  }

  /* ------------------------------ นับ + ปลุกทีม ------------------------------ */

  function noteFailure(role, reason, err, at) {
    const state = stateOf(role);
    totals.fallbacks += 1;
    state.fallbacks += 1;
    state.consecutive += 1;
    state.lastFailureAt = at;
    logger.warn?.(`brainRuntime: อ่านสมอง (${state.role}) ไม่สำเร็จ (${reason}${err ? `: ${err.message || err}` : ""}) — ${retrievalEnabled ? "พักการร่างที่ต้องเลือกความรู้" : "เทิร์นนี้ใช้ทางเดิม"}`);
    if (state.consecutive < alertStreak) return;
    // ปลุกซ้ำได้เมื่อพ้น cooldown — อาการที่ยังไม่หายต้องดังต่อ ไม่ใช่เงียบไปตลอดกาล
    if (state.alerted && at - state.alertedAt < alertCooldownMs) return;
    state.alerted = true;
    state.alertedAt = at;
    alertOps(
      "brain_read_fallback",
      `ลูกแพรอ่าน "สมองที่มีเวอร์ชัน" (${state.role}) ไม่ได้ ${state.consecutive} เทิร์นติด —`
      + (retrievalEnabled ? " ระบบพักการร่างคำตอบและข้อความติดตามที่ต้องเลือกความรู้แล้ว" : " ระบบตกกลับไปอ่านตารางเดิมให้แล้ว ลูกค้ายังได้รับคำตอบตามปกติ")
      + " แต่การแก้ข้อมูลรุ่นใหม่จะยังไม่มีผลจนกว่าจะแก้เรื่องนี้ค่ะ",
      `${state.role}: ${state.consecutive} เทิร์นติด (รวม ${state.fallbacks})`,
    );
  }

  function noteSuccess(role, version, at) {
    const state = stateOf(role);
    if (state.consecutive > 0) logger.log?.(`[brainRuntime] อ่านสมอง (${state.role}) กลับมาปกติแล้ว`);
    state.consecutive = 0;
    state.alerted = false;   // หายแล้ว = ล้างธง อาการรอบหน้าต้องปลุกได้ใหม่
    state.lastOkAt = at;
    if (state.versionId !== version.version_id) {
      state.versionId = version.version_id;
      state.seq = Number(version.seq) || null;
      state.soakUntil = soakMs > 0 ? at + soakMs : 0;
      logger.log?.(`[brainRuntime] ${state.role} อ่านสมองรุ่น ${version.seq} (${version.version_id})`);
    }
  }

  /* ------------------------- โหมดถอยทั้งระบบ (ไม่ล่ม) ------------------------- */

  function liveMissing(at, { boot = false } = {}) {
    forcedLegacy = { reason: "no_live_pointer", since: at, nextCheckAt: at + LIVE_RECHECK_MS };
    alertOps(
      "brain_read_fallback",
      "เปิดให้ลูกแพรอ่านสมองที่มีเวอร์ชันไว้ แต่ยังไม่มีรุ่นไหนถูกตั้งเป็น live —"
      + (retrievalEnabled ? " ระบบพักการร่างคำตอบและข้อความติดตามที่ต้องเลือกความรู้แล้ว" : " ระบบวิ่งด้วยตารางเดิมไปก่อน ลูกค้ายังได้คำตอบตามปกติ")
      + " รบกวนนำเข้าและเผยแพร่รุ่นแรก แล้วระบบจะสลับมาเองภายในหนึ่งนาทีค่ะ",
      boot ? "boot: ไม่มี pointer live" : "runtime: pointer live หายไป",
    );
  }

  // ยังไม่มีรุ่น live -> ตรวจซ้ำเป็นระยะ เผื่อ importer เพิ่งทำงานเสร็จ (ไม่ต้องรีสตาร์ท)
  function liveReturned(at) {
    if (at < forcedLegacy.nextCheckAt) return false;
    forcedLegacy.nextCheckAt = at + LIVE_RECHECK_MS;
    let live = null;
    try { live = db.getBrainPointer("live"); } catch { live = null; }
    if (!live) return false;
    logger.log?.(`[brainRuntime] พบรุ่น live แล้ว (${live.seq}) — กลับมาอ่านสมองตามที่ตั้งไว้`);
    forcedLegacy = null;
    return true;
  }

  /**
   * ผลตรวจ "สมองที่คอมไพล์ตรงกับตารางที่ระบบใช้จริงไหม" — เรียกตอนบูตและทุก tick ของ
   * ตัวเฝ้า (แบบแปลน §11 P1b: เปิดแฟล็กกลับต้องมี import-diff = ∅) ไม่ตรง = **ไม่เสิร์ฟ
   * สมองที่ล้าสมัย** วิ่งทางเดิมแล้วดังไว้ ดีกว่าตอบลูกค้าด้วยข้อมูลที่รู้อยู่ว่าเพี้ยน
   */
  function noteParity(record) {
    if (!enabled || !record) return;
    // ถือเป็น "สมองล้าสมัย" เฉพาะเมื่อคอมไพล์ได้แต่ **ได้ของคนละชุด** กับตารางที่ระบบใช้จริง
    // ส่วน compile_failed / ตารางยังไม่มี เป็นเรื่องของเส้น resolve ซึ่งนับและปลุกเองอยู่แล้ว
    // (ถ้าเหมาว่าเป็น drift ด้วย ตัวนับ per-turn จะเงียบไปเลยแล้วเราจะมองไม่เห็นความถี่จริง)
    const quiet = record.ok === true || record.reason !== "mismatch" || QUIET_PARITY.has(String(record.reason));
    if (quiet) {
      if (parityHold) {
        logger.log?.("[brainRuntime] สมองกลับมาตรงกับตารางจริงแล้ว — อ่านสมองต่อได้");
        parityHold = null;
      }
      return;
    }
    const parts = (record.mismatches ?? []).map((item) => item.part ?? item).join(" · ") || record.reason;
    if (parityHold?.signature === parts) return;
    parityHold = { reason: record.reason, since: clock(), signature: parts };
    alertOps(
      "brain_read_fallback",
      `สมองที่จะเสิร์ฟให้ลูกค้าไม่ตรงกับตารางที่ระบบใช้จริง (ส่วนที่ต่าง: ${parts}) —`
      + (retrievalEnabled ? " ระบบพักการร่างคำตอบและข้อความติดตามที่ต้องเลือกความรู้แล้ว" : " ระบบหยุดอ่านสมองแล้ววิ่งด้วยตารางเดิมไปก่อน ลูกค้ายังได้คำตอบตามปกติ")
      + " รบกวนนำเข้าใหม่หรือตรวจก่อนเปิดอีกครั้งค่ะ",
      `parity: ${parts}`,
    );
  }

  function bootCheck() {
    const at = clock();
    let live = null;
    try { live = db.getBrainPointer("live"); } catch { live = null; }
    if (!live) { liveMissing(at, { boot: true }); return; }
    try {
      noteParity(brainParityReport(db, {
        todayIso: todayInBangkok(at), classRoundsFile: config.classRoundsFile ?? null, logger: QUIET_LOGGER,
      }));
    } catch (err) {
      logger.warn?.(`brainRuntime: ตรวจสมองเทียบตารางจริงตอนบูตไม่สำเร็จ (${err?.message || err})`);
    }
  }

  /* ---------------------------------- resolve ---------------------------------- */

  /**
   * @returns {{versionId: string, seq: number|null, pointer: string|null, bundle: object}|null}
   *   null = ใช้ทางเดิมเมื่อ retrieval ปิด; เมื่อเปิด ผู้เรียกต้องพักการร่าง
   */
  function resolve(customerId, channelId = "default", atMs = null) {
    if (!enabled) return null;
    const at = atMs === null || atMs === undefined ? clock() : Number(atMs);
    if (parityHold) return null;
    if (forcedLegacy && !liveReturned(at)) return null;

    let role = "live";
    try {
      let version = pickVersion(customerId, channelId, at);
      role = version?.pointer || "live";
      if (!version) { liveMissing(at); noteFailure(role, "no_pointer", null, at); return null; }
      if (!SUPPORTED_CODE_CONTRACTS.includes(String(version.code_contract))) {
        if (retrievalEnabled) {
          noteFailure(role, "contract_unsupported", null, at);
          return null;
        }
        version = contractFallback(version);
        if (!version) { noteFailure(role, "contract_unsupported", null, at); return null; }
        role = version.pointer || role;
      }
      const bundle = bundleFor(version, at);
      noteSuccess(role, version, at);
      return { versionId: version.version_id, seq: Number(version.seq) || null, pointer: version.pointer ?? null, bundle };
    } catch (err) {
      noteFailure(role, "resolve_failed", err, at);
      return null;
    }
  }

  /** สรุปสำหรับ /health — อ่านสถานะที่นับไว้ ไม่ตรวจใหม่ (ห้ามคอมไพล์ในเส้น health) */
  function snapshot() {
    const at = clock();
    // อ่านแบบไม่สร้าง: /health ต้องไม่ "เกิดฝั่ง live ขึ้นมาเอง" ทั้งที่ยังไม่เคย resolve เลย
    const live = pointers.get("live") ?? EMPTY_POINTER;
    const detail = Object.fromEntries([...pointers.values()].map((state) => [state.role, {
      versionId: state.versionId, seq: state.seq, consecutive: state.consecutive,
      fallbacks: state.fallbacks, lastOkAt: state.lastOkAt, lastFailureAt: state.lastFailureAt,
      soakUntil: state.soakUntil > at ? state.soakUntil : null,
    }]));
    const consecutive = Math.max(0, ...[...pointers.values()].map((state) => state.consecutive));
    return {
      mode: !enabled ? "legacy" : (forcedLegacy || parityHold ? "legacy_forced" : "versioned"),
      // ok = อ่านสมองได้จริงอยู่ตอนนี้ · false ทั้งตอนถอยทั้งระบบและตอนตกติดกันอยู่
      ok: enabled ? Boolean(!forcedLegacy && !parityHold && consecutive === 0) : true,
      holdReason: forcedLegacy?.reason ?? parityHold?.reason ?? null,
      versionId: live.versionId, seq: live.seq, pointer: live.versionId ? "live" : null,
      consecutive, fallbacks: totals.fallbacks, contractFallbacks: totals.contractFallbacks,
      lastOkAt: live.lastOkAt, lastFailureAt: live.lastFailureAt,
      soakUntil: live.soakUntil > at ? live.soakUntil : null,
      pointers: detail,
    };
  }

  if (enabled) bootCheck();

  return { enabled, resolve, snapshot, noteParity, priceDriftBetween };
}

const QUIET_LOGGER = Object.freeze({ warn() {}, debug() {}, log() {}, error() {} });
const todayInBangkok = (atMs) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date(atMs));

const EMPTY_POINTER = Object.freeze({
  role: "live", versionId: null, seq: null, soakUntil: 0,
  consecutive: 0, fallbacks: 0, lastOkAt: null, lastFailureAt: null,
});

function sha(text) {
  return createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

function stableList(rows) {
  return JSON.stringify((rows ?? []).map((row) => [String(row.label), Number(row.amount)]));
}

function safeJson(text) {
  try {
    const parsed = JSON.parse(String(text ?? "{}"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}
