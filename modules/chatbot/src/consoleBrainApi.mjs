// consoleBrainApi.mjs — เส้นทาง /console/api/brain/* ของเฟส 1b: ประวัติรุ่น, รับทราบ,
// เลื่อนขั้นรุ่นทดลอง, ย้อนกลับ, และการมอบสิทธิ์สีเขียว
//
// ทุกเส้นที่ย้าย pointer ต้อง "เขียนตารางเดิมตาม" ในธุรกรรมเดียวกันเสมอ (brain/project.mjs)
// เพราะจนถึง P2 runtime ยังอ่านตารางเดิม — ปุ่มย้อนกลับที่ขยับแค่ตัวเลขบนหน้าจอ คือปุ่มที่
// โกหกในทิศที่สบายใจที่สุด (ลูกค้ายังได้ยินของเดิมทุกคำ แต่หน้าจอบอกว่าย้อนแล้ว)
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { compileBrain } from "./brain/compile.mjs";
import { projectVersionToLegacy, BrainProjectionFailed } from "./brain/project.mjs";
import { todayInBangkok } from "./brain/import.mjs";
import { findingKey, runBrainGates } from "./brain/gate.mjs";
import { runBrainLints } from "./brain/lint.mjs";
import {
  liveLintAllowlist, readOwnerAllowlist, writeOwnerAllowlist, BRAIN_LINT_ALLOWLIST_MAX,
} from "./brain/lintAllowlist.mjs";
import {
  brainDelegationState, writeBrainDelegation,
  DELEGATABLE_KINDS, DELEGATABLE_ROLES, DELEGATION_MAX_DAYS,
} from "./brain/delegation.mjs";
import { teachJsonAfterPublish } from "./brain/teach.mjs";
import { stripTeachIdentity } from "./brain/teachIdentity.mjs";
import { brainReadiness } from "./brain/readiness.mjs";

// สิทธิ์เดียวที่ใช้ทั้งไฟล์: คนที่เผยแพร่สมองได้ = คนที่เลื่อนขั้น/ย้อนกลับ/รับทราบ/มอบสิทธิ์ได้
export const BRAIN_MANAGE_CAPABILITY = "brain.publish";
const QUIET = Object.freeze({ warn() {}, debug() {}, log() {}, error() {} });
const VERSION_LIST_MAX = 50;

export function createBrainVersionRoutes({ db, config = {}, logger = console, denyMessage = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้", bannedWords = null, safetyRules = null }) {
  const classRoundsFile = config.classRoundsFile || null;

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "brain" || route.length < 2) return false;
    const { json, username, operator, requireCsrf } = ctx;
    const canManage = hasOperatorCapability(operator, BRAIN_MANAGE_CAPABILITY);
    // ทุก POST ในไฟล์นี้ย้าย pointer แล้วเขียนตารางเดิมตาม (ย้อนกลับ/เลื่อนขั้น/รับทราบ)
    // ถ้าแฟล็กยังปิด แปลว่าเฟสนี้ยังไม่เปิด และรุ่นสมองที่มีอยู่คือของที่ยกเข้ามาเฉย ๆ —
    // ปล่อยให้กดได้เท่ากับให้คนแตะปุ่มเดียวแล้วเขียนคลังความรู้/ตารางราคาทับจากรุ่นที่
    // ไม่มีใครตรวจ ทั้งที่คืนนี้ระบบต้องเหมือนก่อนมีเฟสนี้ทุกตัวอักษร GET ยังอ่านได้ตามเดิม
    // URL ที่ encode มาไม่ถูก (%zz) ทำให้ decodeURIComponent โยน — เดิมกลายเป็น 500
    // ถอดครั้งเดียวตรงนี้ แล้วเส้นที่เหลือใช้ค่าที่ถอดแล้ว
    let routeVersionId = null;
    if (route.length >= 3 && route[1] === "versions") {
      try { routeVersionId = decodeURIComponent(route[2]); } catch { routeVersionId = null; }
      if (routeVersionId === null) {
        json(res, 404, { ok: false, error: "ไม่พบรุ่นสมองนี้" });
        return true;
      }
    }
    const versionedOn = config.knowledgeVersioned === true;
    const refuseWhileOff = () => {
      json(res, 409, {
        ok: false,
        error: "แฟล็กสมองยังปิดอยู่ (KNOWLEDGE_VERSIONED) — ปุ่มของรุ่นสมองยังใช้ไม่ได้",
      });
      return true;
    };

    /* ---- GET /brain/readiness — owner-only, read-only even while versioning is off ---- */
    if (req.method === "GET" && route[1] === "readiness" && route.length === 2) {
      if (operator?.role !== "owner") {
        json(res, 403, { ok: false, error: denyMessage });
        return true;
      }
      try {
        json(res, 200, { ok: true, readiness: brainReadiness({ db, config, todayIso: todayInBangkok(Date.now()), classRoundsFile }) });
      } catch {
        json(res, 503, { ok: false, error: "ยังตรวจความพร้อมสมองไม่ได้ กรุณาลองใหม่" });
      }
      return true;
    }

    /* ---- GET /brain/versions — ประวัติรุ่น + ผลตรวจของรุ่นที่ใช้งานอยู่ ---- */
    if (req.method === "GET" && route[1] === "versions" && route.length === 2) {
      const versions = safeCall(() => db.listBrainVersions(VERSION_LIST_MAX), []);
      const live = versions.find((row) => row.pointer === "live") ?? null;
      const canary = versions.find((row) => row.pointer === "canary") ?? null;
      json(res, 200, {
        ok: true,
        canManage,
        enabled: config.knowledgeVersioned === true,
        delegation: safeCall(() => brainDelegationState(db), null),
        versions: versions.map(publicVersion),
        // จำนวนรุ่นที่ค้าง = ตัวเลขที่บอกว่ามีของรอการตัดสินอยู่กี่ใบ (คิว K ผูกอยู่กับมัน)
        pending: versions.filter((row) => row.pointer === "canary" || row.status === "proposed").length,
        // ผลตรวจของรุ่นที่ใช้งานอยู่จริง — คอมไพล์สดเพื่อให้เห็นข้อที่ผูกกับ "วันนี้" ด้วย
        // (รอบที่เพิ่งผ่านไปเมื่อคืน ต้องขึ้นในวันถัดมาเอง ไม่ใช่รอให้มีคนกดเผยแพร่ก่อน)
        // คอมไพล์เพื่อหาผลตรวจเฉพาะตอนแฟล็กเปิด — แฟล็กปิดแปลว่าไม่มีใครกดอะไรได้อยู่แล้ว
        // การคอมไพล์สมองทุกครั้งที่มีคนเปิดหน้าตั้งค่าจึงเป็นงานที่ไม่มีใครได้ใช้
        findings: versionedOn
          ? {
            live: live ? lintsOf(db, live.version_id) : [],
            canary: canary ? lintsOf(db, canary.version_id) : [],
          }
          : { live: [], canary: [] },
      });
      return true;
    }

    /* ---- GET /brain/versions/:id/diff — เทียบรุ่นเป้าหมายกับรุ่นที่ใช้อยู่ ---- */
    if (req.method === "GET" && route[1] === "versions" && route.length === 4 && route[3] === "diff") {
      // เส้นนี้คอมไพล์สมองสองใบต่อการเรียกหนึ่งครั้ง และมีความหมายเฉพาะกับคนที่กดปุ่มได้จริง
      if (!canManage) {
        json(res, 403, { ok: false, error: denyMessage });
        return true;
      }
      if (!versionedOn) return refuseWhileOff();
      const target = safeCall(() => db.getBrainVersion(routeVersionId), null);
      const current = safeCall(() => db.getBrainPointer("live"), null);
      if (!target || !current) {
        json(res, 404, { ok: false, error: "ไม่พบรุ่นสมองที่จะเทียบ" });
        return true;
      }
      json(res, 200, { ok: true, diff: safeCall(() => versionDiff(db, current, target), null) });
      return true;
    }

    /* ---- GET/POST /brain/lint-allowlist — ช่องทางติดต่อของร้านที่ L15 ต้องไม่ฟ้อง ---- */
    // ทำไมต้องแก้ได้: ความรู้ใบหนึ่งอาจมีเบอร์ร้านหรือ LINE id ของ OA ตัวเอง ถ้ารายการนี้
    // ถูกแช่ไว้ตอนนำเข้าอย่างเดียว วันที่เบอร์เปลี่ยนหรือมี OA ตัวที่สอง ใบนั้นจะแก้ไม่ได้อีกเลย
    if (route[1] === "lint-allowlist" && route.length === 2) {
      if (!canManage) {
        json(res, 403, { ok: false, error: denyMessage });
        return true;
      }
      if (req.method === "GET") {
        json(res, 200, { ok: true, values: readOwnerAllowlist(db), max: BRAIN_LINT_ALLOWLIST_MAX });
        return true;
      }
      if (req.method === "POST") {
        if (!versionedOn) return refuseWhileOff();
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await ctx.readJson(req).catch(() => ({}));
        const result = writeOwnerAllowlist(db, body?.values ?? []);
        if (!result.ok) {
          json(res, 400, { ok: false, error: result.error });
          return true;
        }
        db.addAudit({
          operator: username, action: "brain_lint_allowlist_set", target: "",
          detail: `${result.values.length} รายการ`,
        });
        json(res, 200, { ok: true, values: result.values });
        return true;
      }
    }

    /* ---- GET/POST /brain/delegation — สิทธิ์สีเขียวที่เจ้าของมอบให้ทีมงาน ---- */
    if (route[1] === "delegation" && route.length === 2) {
      if (!canManage) {
        json(res, 403, { ok: false, error: denyMessage });
        return true;
      }
      if (req.method === "GET") {
        json(res, 200, {
          ok: true,
          delegation: brainDelegationState(db),
          allowedKinds: DELEGATABLE_KINDS, allowedRoles: DELEGATABLE_ROLES, maxDays: DELEGATION_MAX_DAYS,
        });
        return true;
      }
      if (req.method === "POST") {
        if (!versionedOn) return refuseWhileOff();
        if (!requireCsrf()) {
          json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
          return true;
        }
        const body = await ctx.readJson(req).catch(() => ({}));
        const result = writeBrainDelegation(db, {
          roles: body?.roles ?? [], kinds: body?.kinds ?? [],
          days: body?.days ?? 0, by: username,
        });
        if (!result.ok) {
          json(res, 400, { ok: false, error: result.error });
          return true;
        }
        db.addAudit({
          operator: username, action: "brain_delegation_set", target: "",
          detail: result.revoked
            ? "ยกเลิกสิทธิ์เผยแพร่ของทีมงาน"
            : `${result.state.roles.join(",")} · ${result.state.kinds.join(",")} · หมดอายุ ${new Date(result.state.expiresAt).toISOString().slice(0, 10)}`,
        });
        json(res, 200, { ok: true, delegation: result.state });
        return true;
      }
    }

    /* ---- POST /brain/versions/:id/(ack|promote|rollback) ---- */
    const action = route.length === 4 && route[1] === "versions" && req.method === "POST" ? route[3] : "";
    // reject = ชื่อที่หน้าเว็บใช้ · discard = ชื่อเดิม ทั้งคู่ทำอย่างเดียวกัน
    if (!["ack", "promote", "rollback", "discard", "reject"].includes(action)) return false;
    if (!canManage) {
      json(res, 403, { ok: false, error: denyMessage });
      return true;
    }
    if (!versionedOn) return refuseWhileOff();
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }
    // กวาดรุ่นที่แตกจากรุ่นเก่าทิ้งตรงนี้ ไม่ใช่ตอน GET: การกวาดคือการเขียน และ GET ไม่มีทั้ง
    // ด่านสิทธิ์และ CSRF — เส้นนี้มีครบทั้งคู่แล้ว และเป็นจังหวะที่คนกำลังตัดสินใจเรื่องรุ่นพอดี
    safeCall(() => sweepStaleProposed(db), 0);
    const versionId = routeVersionId;
    const version = safeCall(() => db.getBrainVersion(versionId), null);
    if (!version) {
      json(res, 404, { ok: false, error: "ไม่พบรุ่นสมองนี้" });
      return true;
    }
    const live = db.getBrainPointer("live");
    const todayIso = todayInBangkok(Date.now());

    try {
      if (action === "discard" || action === "reject") {
        if (version.status === "live" || version.pointer === "live") {
          json(res, 409, { ok: false, error: "ปัดตกรุ่นที่ใช้งานอยู่ไม่ได้ — ใช้ปุ่มย้อนกลับแทน" });
          return true;
        }
        if (version.pointer !== "canary" && version.status !== "proposed") {
          json(res, 409, { ok: false, error: "รุ่นนี้ไม่ได้ค้างอยู่" });
          return true;
        }
        db.brainTransaction(() => {
          if (version.pointer === "canary") db.setBrainPointer("canary", null, { changedBy: username });
          db.setBrainVersionStatus(version.version_id, "rejected");
          // ปัดตก = รุ่นนี้จบชีวิตแล้ว ข้อความที่คนพิมพ์ไว้ในจอสอนหมดหน้าที่เหมือนตอนเผยแพร่
          // (เดิมล้างเฉพาะทางที่ถึงลูกค้า รุ่นที่ถูกปัดตกจึงถือข้อความไว้ตลอดกาล — PDPA §5 ข้อ 3)
          scrubTeach(db, version.version_id);
          db.addAudit({
            operator: username, action: "brain_discard", target: version.version_id,
            detail: `รุ่น ${version.seq} · ${version.label}`,
          });
          // คำขอในคิวที่ผูกอยู่กับรุ่นนี้ต้องถูกปิดด้วย ไม่ใช่ค้างรอรุ่นที่ไม่มีแล้ว
          db.releaseParkedPublishRequests?.(version.version_id, {
            status: "rejected", decidedBy: username, note: `ปัดตกรุ่นสมอง ${version.seq}`,
          });
        });
        json(res, 200, { ok: true, applied: true, version: publicVersion(db.getBrainVersion(versionId)) });
        return true;
      }

      if (action === "ack") {
        if (version.status !== "proposed") {
          json(res, 409, { ok: false, error: "รุ่นนี้ไม่ได้รออยู่ในสถานะ 'รอรับทราบ'" });
          return true;
        }
        if (live && version.parent_id !== live.version_id) {
          json(res, 409, { ok: false, error: staleMessage(version, live) });
          return true;
        }
        // รุ่นที่ทีมงานเขียนด้วยสิทธิ์ที่มอบมา ต้องไปได้แค่รุ่นทดลองเสมอ — การกดรับทราบ
        // เป็นการยอมรับ "ข้อค้างของสมอง" ไม่ใช่การเลื่อนขั้นสิทธิ์ของคนเขียนเป็นเจ้าของ
        const authoredByDelegate = safeJson(version.teach_json)?.delegated === true;
        const result = publish(version, {
          role: authoredByDelegate ? "canary" : "live",
          acks: [...safeArray(version.gate_acks_json), {
            by: username, at: Date.now(),
            items: findingItems(version),
          }],
        });
        db.releaseParkedPublishRequests?.(version.version_id, {
          status: "approved", decidedBy: username, note: `รับทราบและใช้งานรุ่นสมอง ${version.seq}`,
        });
        json(res, 200, {
          ok: true, applied: true, pointer: authoredByDelegate ? "canary" : "live",
          version: publicVersion(db.getBrainVersion(versionId)), ...result,
        });
        return true;
      }

      if (action === "promote") {
        if (version.pointer !== "canary") {
          json(res, 409, { ok: false, error: "รุ่นนี้ไม่ได้อยู่ในสถานะทดลอง (canary)" });
          return true;
        }
        if (live && version.parent_id !== live.version_id) {
          json(res, 409, { ok: false, error: staleMessage(version, live) });
          return true;
        }
        const result = publish(version, {});
        json(res, 200, { ok: true, applied: true, version: publicVersion(db.getBrainVersion(versionId)), ...result });
        return true;
      }

      // rollback: ย้อน pointer live ไปยังรุ่นเก่าที่เคยผ่านด่านแล้ว
      if (version.pointer === "live") {
        json(res, 409, { ok: false, error: "รุ่นนี้ใช้งานอยู่แล้ว" });
        return true;
      }
      // ย้อนกลับได้เฉพาะรุ่นที่ "เคยถูกใช้จริง" เท่านั้น (retired / rolled_back) — รุ่นทดลองที่
      // ไม่เคยถึงลูกค้าเลย ถ้าย้อนมาได้ มันจะเป็นทางลัดข้ามด่านความสดของปุ่มเลื่อนขั้น
      // (ปุ่มนั้นปฏิเสธรุ่นที่แตกมาจากรุ่นเก่า ปุ่มนี้จะยอมรับให้เงียบ ๆ = ของที่แก้ทีหลังหาย)
      if (version.pointer) {
        json(res, 409, { ok: false, error: "รุ่นนี้ถูกใช้งานอยู่ (live หรือรุ่นทดลอง) — ย้อนกลับมาที่ตัวเองไม่ได้" });
        return true;
      }
      if (!["retired", "rolled_back", "validated"].includes(version.status)) {
        json(res, 409, {
          ok: false,
          error: `ย้อนกลับไปรุ่นสถานะ "${version.status}" ไม่ได้ — ย้อนได้เฉพาะรุ่นที่ผ่านด่านและไม่ได้ถูกปัดตก`,
        });
        return true;
      }
      // เดินด่านกับ "รุ่นที่กำลังจะเอามาใช้" ไม่ใช่เชื่อผลตอนที่มันถูกสร้าง: เวลาผ่านไปแล้ว
      // (รอบเรียนที่เคยเปิดอาจผ่านไปแล้ว โปรอาจหมดอายุ) รุ่นเก่าที่เคยผ่านจึงอาจไม่ผ่านวันนี้
      const targetGate = safeCall(() => gateOfVersion(db, version, todayIso), null);
      if (targetGate && (targetGate.verdict === "block" || targetGate.verdict === "error")) {
        json(res, 409, {
          ok: false,
          error: `รุ่น ${version.seq} ใช้วันนี้ไม่ได้ — ${targetGate.blocking[0]?.message || targetGate.error || "ด่านไม่ผ่าน"}`,
          findings: targetGate.blocking.map((f) => ({ code: f.code, message: f.message })),
        });
        return true;
      }
      const body = await ctx.readJson(req).catch(() => ({}));
      if (targetGate && targetGate.verdict === "needs_ack" && body?.ack !== true) {
        json(res, 409, {
          ok: false, needsAck: true,
          error: `รุ่น ${version.seq} ยังมีข้อค้าง ${targetGate.needsAck.length} ข้อ — ยืนยันรับทราบก่อนจึงจะใช้ได้`,
          findings: targetGate.needsAck.map((f) => ({ code: f.code, message: f.message })),
        });
        return true;
      }
      const rolledFrom = live?.version_id ?? null;
      // รุ่นที่ถูกย้อนออกไป ไม่ใช่ "ปลดระวางตามอายุ" แต่คือรุ่นที่ถูกถอน — ตั้งป้ายในธุรกรรม
      // เดียวกับการย้าย pointer ไม่ใช่หลังจากนั้น (ล้มตรงกลางแล้วรายงาน 409 ทั้งที่ live ย้ายแล้ว)
      const result = publish(version, {
        restoreStatus: true, retiredStatus: "rolled_back",
        acks: targetGate?.verdict === "needs_ack"
          ? [...safeArray(version.gate_acks_json), {
            by: username, at: Date.now(), items: targetGate.needsAck.map(findingKey),
          }]
          : null,
      });
      json(res, 200, {
        ok: true, applied: true, rolledFrom,
        version: publicVersion(db.getBrainVersion(versionId)), ...result,
      });
      return true;
    } catch (err) {
      if (err instanceof BrainProjectionFailed) {
        logger.warn?.(`brain: projection ล้ม (${err.message})`);
        json(res, 409, { ok: false, error: err.message, mismatches: err.mismatches.map((m) => m.part) });
        return true;
      }
      logger.warn?.(`brain: ${action} ล้ม (${err?.message || err})`);
      json(res, 409, { ok: false, error: String(err?.message || err) });
      return true;
    }

    /* ------------------------------- ตัวช่วยภายใน ------------------------------- */

    // ย้าย pointer live + เขียนตารางเดิมตาม + พิสูจน์ parity — ทั้งหมดในธุรกรรมเดียว
    function publish(target, { acks = null, restoreStatus = false, role = "live", retiredStatus = "retired" }) {
      return db.brainTransaction(() => {
        if (acks) db.setBrainVersionGateAcks(target.version_id, acks);
        // pointer ตั้งได้เฉพาะสถานะ validated/canary/live (brain/store.mjs) — รุ่นที่รอรับทราบ
        // หรือรุ่นเก่าที่ปลดระวางไปแล้ว ต้องถูกยกกลับเป็น validated ก่อนอย่างเปิดเผย
        if (acks || restoreStatus) db.setBrainVersionStatus(target.version_id, "validated");
        db.setBrainPointer(role, target.version_id, { changedBy: username, retiredStatus });
        // PDPA (แบบแปลน §5 ข้อ 3): รุ่นที่ถึงลูกค้าจริงแล้ว ต้องไม่เหลือ "คำตอบที่ควรเป็น"
        // ที่คนพิมพ์ไว้ในจอสอน เหลือแค่ตัวชี้การ์ด — ทางเผยแพร่มีสองทาง (hook ตอนกดบันทึก
        // กับที่นี่ตอนเจ้าของกดรับทราบ/เลื่อนขั้น/ย้อนกลับ) ทั้งสองทางต้องล้างเหมือนกัน
        if (role === "live") {
          const teach = safeJson(db.getBrainVersion(target.version_id)?.teach_json) ?? {};
          db.setBrainVersionTeach(target.version_id, teachJsonAfterPublish(teach, {
            cardRefs: Array.isArray(teach.touched) ? teach.touched : [],
          }));
        }
        // ฉายลงตารางเดิมเฉพาะตอนไป live — รุ่นทดลองต้องไม่ไปถึงลูกค้าโดยนิยาม
        const projected = role === "live"
          ? projectVersionToLegacy(db, target.version_id, { todayIso, classRoundsFile, updatedBy: username })
          : { cards: 0, knowledgeUpserted: 0, knowledgeRetired: 0 };
        db.addAudit({
          operator: username, action: `brain_${action}`, target: target.version_id,
          detail: `รุ่น ${target.seq} -> ${role} · ${projected.cards} การ์ด · ความรู้ ${projected.knowledgeUpserted} ปิด ${projected.knowledgeRetired}`,
        });
        return { projected };
      });
    }
  }

  // ด่านของ "รุ่นที่กำลังจะเอามาใช้ทั้งใบ": ไม่มีการ์ดไหนถูก "แตะ" จึงไม่มีอะไรถูกบล็อกด้วย
  // เหตุผลว่าใครทำ — ทุกข้อที่ค้างกลายเป็นของที่คนกดต้องรับทราบ ซึ่งตรงกับความหมายของปุ่มนี้
  function gateOfVersion(db_, version, today) {
    const bundle = compileBrain(db_, version.version_id, { todayIso: today, logger: QUIET });
    const manifest = safeJson(version.manifest_json) ?? {};
    return runBrainGates({
      cards: bundle.cards, bundle, touched: [], todayIso: today, previousBundle: bundle,
      inheritedAcks: safeArray(version.gate_acks_json),
      allowlist: liveLintAllowlist(db_, manifest.lintAllowlist ?? []),
      // เส้นย้อนกลับก็ต้องเดินด่านเล่นซ้ำเหมือนกัน ไม่งั้นการ "ใช้รุ่นเก่าแทน" กลายเป็น
      // ทางลัดที่ข้ามตาข่ายได้ทั้งใบ (เส้นนี้เลือกเฉพาะเคส floor เพราะไม่มีการ์ดไหนถูกแตะ)
      gateMode: config.brainGates ?? "", db: db_,
      goldenTurns: safeCall(() => db_.listGoldenTurns({ includeRetired: true }), null),
      bannedPhrases: bannedWords, extraRules: safetyRules,
      versionId: version.version_id,
    });
  }

  function lintsOf(db_, versionId) {
    try {
      const version = db_.getBrainVersion(versionId);
      const bundle = compileBrain(db_, versionId, { todayIso: todayInBangkok(Date.now()), logger: QUIET });
      // คอมไพเลอร์ใช้ allowlist ที่แช่ไว้ใน manifest — แผงต้องแสดงผลของ allowlist "ตัวที่ด่านใช้จริง"
      // ไม่งั้นเจ้าของเพิ่งเติมช่องทางของร้านเข้าไป แล้วแผงยังฟ้องข้อเดิมอยู่ทั้งที่แก้ได้แล้ว
      const manifest = safeJson(version?.manifest_json) ?? {};
      return runBrainLints({
        cards: bundle.cards, bundle, todayIso: bundle.todayIso,
        allowlist: liveLintAllowlist(db_, manifest.lintAllowlist ?? []),
      })
        .map((finding) => ({
          code: finding.code, severity: finding.severity, message: finding.message,
          cardId: finding.cardId ?? null, grandfathered: finding.grandfathered === true,
        }));
    } catch (err) {
      return [{ code: "compile", severity: "block", message: `คอมไพล์รุ่นนี้ไม่ได้: ${err?.message || err}`, cardId: null }];
    }
  }

  return { handle };
}

/* ---------------------------------- ตัวช่วย ---------------------------------- */

function publicVersion(row) {
  if (!row) return null;
  const report = safeJson(row.gate_report_json);
  return {
    versionId: row.version_id,
    // ข้อค้างของรุ่นที่รอรับทราบ มาจาก gate_report ที่บันทึกไว้ตอนสร้าง (ไม่ต้องคอมไพล์ใหม่)
    // ถ้าไม่ส่งมา ปุ่ม "รับทราบและใช้งาน" คือปุ่มที่ขอให้คนยอมรับสิ่งที่เขามองไม่เห็น
    findings: row.status === "proposed"
      ? (Array.isArray(safeJson(row.gate_report_json)?.findings) ? safeJson(row.gate_report_json).findings : [])
        .map((finding) => ({ code: finding.code, severity: finding.severity, message: finding.message }))
      : [],
    parentId: row.parent_id,
    seq: row.seq,
    label: row.label,
    status: row.status,
    pointer: row.pointer,
    verdict: report?.verdict ?? null,
    gates: Array.isArray(report?.gates) ? report.gates : [],
    findingCount: Array.isArray(report?.findings) ? report.findings.length : 0,
    ackCount: safeArray(row.gate_acks_json).length,
    createdBy: row.created_by,
    createdAt: row.created_at,
    publishedAt: row.published_at,
    retiredAt: row.retired_at,
    compiledSha256: row.compiled_sha256,
  };
}

function findingItems(version) {
  const report = safeJson(version.gate_report_json);
  return (Array.isArray(report?.findings) ? report.findings : []).map(findingKey);
}

// รุ่นที่แตกมาจากรุ่นเก่า: เนื้อของมันคือ "ตารางเดิม ณ ตอนนั้น + สิ่งที่แก้" ดังนั้นการเอามาใช้
// จะลบทุกอย่างที่ถูกแก้หลังจากนั้นทิ้งไปเงียบ ๆ — ต้องหยุดตรงนี้ ไม่ใช่ให้คนมาค้นทีหลังว่า
// ราคาที่เพิ่งแก้เมื่อเช้าหายไปไหน
function staleMessage(version, live) {
  return `รุ่น ${version.seq} แตกมาจากตอนที่ยังใช้รุ่นเก่ากว่านี้ แต่ตอนนี้ใช้งานรุ่น ${live.seq} อยู่`
    + " — ใช้รุ่นนี้จะทำให้ของที่แก้ทีหลังหายไป ให้แก้ใหม่จากรุ่นล่าสุดแทน";
}

/**
 * ความต่างระหว่างรุ่นที่ใช้อยู่กับรุ่นเป้าหมาย — สรุปเป็นของที่คนตัดสินใจเป็น ไม่ใช่ sha
 *
 * จงใจไม่ครอบ "โหมดสมอง/ข้อความเสริมต่อสาขา": สองอย่างนั้นยังไม่ใช่การ์ดในเฟสนี้ การย้อนรุ่น
 * จึงไม่แตะมันเลย และหน้าเว็บต้องบอกข้อนี้ตรง ๆ ไม่ใช่ปล่อยให้คนเดาว่าย้อนแล้วได้ทุกอย่างคืน
 */
export function versionDiff(db, currentVersion, targetVersion) {
  const QUIET_LOG = QUIET;
  const of = (version) => {
    const bundle = compileBrain(db, version.version_id, { logger: QUIET_LOG });
    return {
      prices: new Map(bundle.guardTables.approvedPrices.map((row) => [row.label, row.amount])),
      rounds: new Set(bundle.consoleViews.scheduleTable.map((row) => `${row.date} ${row.label}`)),
      knowledge: new Map(bundle.cards.filter((card) => card.kind === "fact")
        .map((card) => [card.itemId, `${card.body.title}${card.inject === "never" ? " (ปิดอยู่)" : ""}`])),
    };
  };
  const now = of(currentVersion);
  const next = of(targetVersion);
  const priceChanges = [];
  for (const [label, amount] of next.prices) {
    if (!now.prices.has(label)) priceChanges.push(`+ ${label} ${amount.toLocaleString("th-TH")}`);
    else if (now.prices.get(label) !== amount) {
      priceChanges.push(`~ ${label} ${now.prices.get(label).toLocaleString("th-TH")} → ${amount.toLocaleString("th-TH")}`);
    }
  }
  for (const label of now.prices.keys()) if (!next.prices.has(label)) priceChanges.push(`- ${label}`);
  return {
    fromSeq: currentVersion.seq,
    toSeq: targetVersion.seq,
    prices: priceChanges,
    rounds: [
      ...[...next.rounds].filter((key) => !now.rounds.has(key)).map((key) => `+ ${key}`),
      ...[...now.rounds].filter((key) => !next.rounds.has(key)).map((key) => `- ${key}`),
    ],
    knowledge: [
      ...[...next.knowledge].filter(([id, title]) => now.knowledge.get(id) !== title).map(([, title]) => `+ ${title}`),
      ...[...now.knowledge].filter(([id]) => !next.knowledge.has(id)).map(([, title]) => `- ${title}`),
    ],
    note: "การย้อนรุ่นไม่ครอบโหมดสมองและข้อความเสริมต่อสาขา (ยังไม่ใช่การ์ดในเฟสนี้)",
  };
}

// ล้างข้อความ/ตัวชี้ลูกค้าออกจาก teach_json ของรุ่นที่จบชีวิตแล้ว (ปัดตก/หมดอายุ)
// ต่างจาก teachJsonAfterPublish ตรงที่รุ่นนี้ไม่ได้กลายเป็นการ์ด จึงไม่มี card_ref ให้เหลือไว้
function scrubTeach(db, versionId) {
  const teach = safeJson(db.getBrainVersion(versionId)?.teach_json) ?? {};
  // ปลดคำแก้ที่ผูกกับรุ่นนี้ก่อนล้างตัวชี้ทิ้ง — รุ่นถูกปัดตก = ยังไม่มีใครสอนของชิ้นนั้นจริง
  // มันต้องกลับมาในกล่องตรวจเอง (ต้องอ่าน correction_ref ให้ได้ก่อน stripTeachIdentity ลบมัน)
  for (const row of safeCall(() => db.correctionsTaughtByVersion(versionId), [])) {
    safeCall(() => db.setCorrectionTaughtVersion(row.id, ""), false);
  }
  if (teach.correction_ref) safeCall(() => db.setCorrectionTaughtVersion(teach.correction_ref, ""), false);
  const { teach: next, changed } = stripTeachIdentity(teach);
  if (changed) db.setBrainVersionTeach(versionId, next);
}

function safeJson(text) {
  try { return JSON.parse(String(text || "null")); } catch { return null; }
}

function safeArray(text) {
  const parsed = safeJson(text);
  return Array.isArray(parsed) ? parsed : [];
}

// รุ่นที่รอรับทราบแต่ live เดินหน้าไปแล้ว ใช้ไม่ได้อีกตลอดกาล (เนื้อของมันคือตารางเดิม ณ
// ตอนนั้น) — ปิดให้เองพร้อมปลดคำขอในคิวที่ผูกอยู่ ไม่งั้นมันจะค้างอยู่ในแผงตลอดไป
// และไปกันไม่ให้ใครส่งของชิ้นถัดไปได้ด้วย (ด่าน "รุ่นค้าง" ใน writeHook)
export function sweepStaleProposed(db) {
  const live = db.getBrainPointer("live");
  if (!live) return 0;
  let swept = 0;
  for (const row of db.listBrainVersions(50)) {
    if (row.status !== "proposed" || row.parent_id === live.version_id) continue;
    db.brainTransaction(() => {
      db.setBrainVersionStatus(row.version_id, "rejected");
      // รุ่นที่หมดอายุเองก็จบชีวิตเหมือนกัน — ทางกวาดอัตโนมัติต้องล้างเท่ากับทางที่คนกด
      scrubTeach(db, row.version_id);
      db.addAudit({
        operator: "system", action: "brain_stale_rejected", target: row.version_id,
        detail: `รุ่น ${row.seq} แตกมาจากรุ่นก่อนหน้า และ live เดินไปแล้ว`,
      });
      db.releaseParkedPublishRequests?.(row.version_id, {
        status: "failed", decidedBy: "system",
        note: `รุ่นสมอง ${row.seq} ใช้ไม่ได้แล้วเพราะมีการแก้อย่างอื่นทับ — ส่งใหม่ได้เลย`,
      });
    });
    swept += 1;
  }
  return swept;
}

function safeCall(fn, fallback) {
  try { return fn(); } catch { return fallback; }
}
