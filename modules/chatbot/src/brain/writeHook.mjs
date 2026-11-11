// brain/writeHook.mjs — จุดคอขวดเดียวของ "การเขียนที่เปลี่ยนสมองลูกแพร" (เฟส 1b)
//
// ทุกเส้นในคอนโซลที่แตะข้อมูลตั้งต้นของ AI เดินผ่านฟังก์ชันเดียวที่นี่ ไม่มีตรรกะชุดที่สอง
// ต่อ endpoint (คิว Package K ที่เล่นคำขอซ้ำก็เดินผ่านตัวเดียวกัน เพราะมันยิงเข้า handler เดิม)
//
// ลำดับในธุรกรรมเดียว:
//   1. SAVEPOINT
//   2. เขียนตารางเดิมเหมือนวันนี้ทุกตัวอักษร (apply ของ handler)
//   3. อ่านการ์ดจากตารางเดิม "หลังเขียน" -> นี่คือเนื้อของเวอร์ชันใหม่
//   4. คอมไพล์ + เดินบันไดด่าน G0–G4
//   5. ตัดสิน:
//        block/error -> โยน = ธุรกรรมทั้งก้อนถูกยกเลิก ตารางเดิมไม่ขยับแม้แต่ไบต์เดียว
//        needs_ack   -> ROLLBACK ตารางเดิม + บันทึกเวอร์ชันสถานะ proposed รอเจ้าของรับทราบ
//        pass + คนกดเผยแพร่เองได้ -> คงตารางเดิมไว้ + ชี้ pointer live
//        pass + สิทธิ์ที่มอบมา     -> ROLLBACK ตารางเดิม + ชี้ pointer canary
//
// ทำไม "ROLLBACK ตารางเดิม" ถึงถูกต้องสำหรับ canary/needs_ack: จนกว่าจะถึง P2 runtime ยัง
// อ่านตารางเดิมอยู่ ถ้าปล่อยให้ตารางเดิมเปลี่ยนโดยที่ pointer live ไม่ขยับ = ลูกค้าได้ของ
// ที่ยังไม่มีใครอนุมัติ (และ parity แตกทันที) รุ่นทดลองจึงต้องอยู่ในสมองอย่างเดียว
//
// ทำไมเนื้อของเวอร์ชันถูก "อ่านกลับจากตารางเดิม" แทนที่จะสร้างจาก payload ของ endpoint:
// เพราะ parity คือของศักดิ์สิทธิ์ของเฟสนี้ ถ้ามีตัวสร้างการ์ดชุดที่สอง มันจะเดินออกจาก
// ตัวแรกวันไหนก็ได้แล้วไม่มีใครรู้ — อ่านกลับทำให้ "ตรงกัน" เป็นเรื่องที่ผิดไม่ได้โดยโครงสร้าง
import { collectCurrentSourceCards } from "./sources.mjs";
import { brainParityReport } from "./parity.mjs";
import { compileCards, sourceCardToCard } from "./compile.mjs";
import { runBrainGates } from "./gate.mjs";
import { treeSha256 } from "./store.mjs";
import { appendCardRevisions, BRAIN_CODE_CONTRACT, todayInBangkok } from "./import.mjs";
import { delegationAllows } from "./delegation.mjs";
import { liveLintAllowlist } from "./lintAllowlist.mjs";
import { sanitizeTeachContext, teachJsonAfterPublish } from "./teach.mjs";
import {
  legacyOnly, writeAudit, auditLabel, diffTouched, refusalMessage, needsAckMessage,
  pendingChildOf, safeJson, safeArray, BRAIN_SILENT_OUTCOMES,
} from "./writeHookHelpers.mjs";
import { hasOperatorCapability } from "../operatorRoles.mjs";
import {
  BRAIN_WRITE_KINDS, BrainWriteRefused, DELEGATED_PUBLISH_ENABLED,
  DELEGATED_PUBLISH_CLOSED_MESSAGE, CANARY_FORBIDDEN_KINDS,
} from "./writeKinds.mjs";

export {
  BRAIN_WRITE_KINDS, BrainWriteRefused, CANARY_FORBIDDEN_KINDS,
  DELEGATED_PUBLISH_ENABLED, DELEGATED_PUBLISH_CLOSED_MESSAGE,
} from "./writeKinds.mjs";
export { BRAIN_SILENT_OUTCOMES, pendingChildOf } from "./writeHookHelpers.mjs";

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {object} deps.config  ใช้ config.knowledgeVersioned (แฟล็ก KNOWLEDGE_VERSIONED) และ classRoundsFile
 * @returns {{enabled: boolean, apply: Function}}
 */
export function createBrainWriteHook({ db, config = {}, logger = console, notifier = null, now = Date.now, bannedWords = null, safetyRules = null }) {
  const enabled = config.knowledgeVersioned === true;
  const classRoundsFile = config.classRoundsFile || null;
  const QUIET = { warn() {}, debug() {}, log() {}, error() {} };

  /**
   * @param {object} input
   * @param {string} input.kind    คีย์ในทะเบียนข้างบน
   * @param {object} input.operator แถวผู้ใช้ (ใช้ดูสิทธิ์)
   * @param {string} input.username ชื่อที่จะลง audit
   * @param {{action: string, target?: string, detail?: string}} input.audit
   * @param {Function} input.apply  การเขียนตารางเดิม "เหมือนวันนี้" — ต้องไม่เขียน audit เอง
   * @param {object|null} [input.teach] บริบทของจอสอน (เฟส 3) — ถูกกรองด้วยทะเบียนใน brain/teach.mjs
   *   ก่อนลง teach_json เสมอ ข้อความของลูกค้าไม่มีช่องให้อยู่ และ correct_text ถูกล้างตอนเผยแพร่
   * @returns {{ok: boolean, outcome: string, applied?: any, versionId?: string, seq?: number,
   *            status?: number, error?: string, findings?: object[]}}
   */
  function apply({ kind, operator = null, username = "system", audit = null, apply: applyLegacy, teach = null }) {
    const spec = BRAIN_WRITE_KINDS[kind];
    // แฟล็กปิด / ไม่รู้จักชนิด / ยังไม่เคยนำเข้าสมอง = ทำเหมือนวันนี้ทุกตัวอักษร
    // (นี่คือทางถอยของเฟสนี้: ปิดแฟล็กแล้วคอนโซลกลับไปเขียนตารางเดิมตรง ๆ ทันที)
    // ทางเดิมล้วนก็ต้องแปลงคำปฏิเสธเป็นคำตอบให้คนกดอ่านออกเหมือนกัน (เช่น "ไม่พบรายการนี้"
    // เมื่อแถวหายไประหว่างทาง) — ไม่ใช่ปล่อยเป็น 500 เพราะบังเอิญอยู่นอก try
    if (!enabled || !spec) return guarded(() => legacyOnly(db, username, applyLegacy, audit, "off"));
    let live = null;
    try { live = db.getBrainPointer("live"); } catch { live = null; }
    if (!live) return guarded(() => legacyOnly(db, username, applyLegacy, audit, "no_brain_version"));

    const at = Number(typeof now === "function" ? now() : now);
    const todayIso = todayInBangkok(at);
    const manifest = safeJson(live.manifest_json);
    const inheritedAcks = safeArray(live.gate_acks_json);
    const canPublishLive = hasOperatorCapability(operator, spec.capability);
    const delegated = !canPublishLive && delegationAllows(db, {
      role: operator?.role, cardKinds: spec.cardKinds, now: at,
    });
    try {
      if (!canPublishLive && delegated && !DELEGATED_PUBLISH_ENABLED) {
        throw new BrainWriteRefused(DELEGATED_PUBLISH_CLOSED_MESSAGE, { outcome: "delegation_closed" });
      }
      if (!canPublishLive && !delegated) {
        // ถึงตรงนี้แปลว่าด่านสิทธิ์ของ handler ปล่อยผ่านมาโดยที่คนกดไม่มีสิทธิ์จริง —
        // เป็นบั๊กของด่านชั้นบน ไม่ใช่กรณีปกติ ต้องดังทันทีแทนที่จะเผยแพร่ให้เงียบ ๆ
        throw new BrainWriteRefused("บัญชีนี้ไม่มีสิทธิ์เผยแพร่ของชิ้นนี้", { outcome: "blocked" });
      }

      return db.brainTransaction(() => {
        // ก่อนแตะอะไร: ตารางเดิม ณ วินาทีนี้ ต้องตรงกับรุ่นที่ pointer live ชี้อยู่
        //
        // ถ้ามีใครแก้ตารางเดิมลับหลัง (ตอนแฟล็กยังปิด, สคริปต์ที่ไม่ผ่าน hook, แก้ฐานตรง ๆ)
        // แล้วเราเขียนต่อ รุ่นใหม่จะกลืนความต่างนั้นเข้าไปเป็น "ของที่เจ้าของอนุมัติ" ทั้งที่
        // ไม่มีใครเคยเห็น — และประวัติจะโกหกว่าการแก้ครั้งนี้เป็นคนทำ ต้องหยุดและนำเข้าใหม่
        const parity = brainParityReport(db, { todayIso, classRoundsFile, logger: QUIET });
        if (!parity.ok) {
          logger.warn?.(`[chassis] brain: ตารางเดิมไม่ตรงกับรุ่น live (${parity.mismatches.map((m) => m.part).join(", ")})`);
          throw new BrainWriteRefused(
            `สมองไม่ตรงกับตารางเดิม — ต้องนำเข้าใหม่ก่อน (ต่างที่: ${parity.mismatches.map((m) => m.part).join(", ") || parity.reason})`,
            { outcome: "blocked" },
          );
        }
        // อ่านการ์ดไม่ได้ = ประกอบเวอร์ชันไม่ได้ = รักษา parity ไม่ได้ ต้องปฏิเสธพร้อมบอกว่า
        // ต้องไปแก้อะไรที่ไหน (เช่น รอบเรียนซ้ำกันทุกฟิลด์) ไม่ใช่ปล่อย 500 ให้คนกดงง
        const before = readCards("ก่อนแก้");
        db.raw.exec("SAVEPOINT brain_write");
        let applied;
        try {
          applied = applyLegacy();
        } catch (err) {
          db.raw.exec("ROLLBACK TO brain_write");
          db.raw.exec("RELEASE brain_write");
          throw err;
        }
        const after = readCards("หลังแก้");
        const touched = diffTouched(before, after);
        if (!touched.length) {
          db.raw.exec("RELEASE brain_write");
          writeAudit(db, username, audit, "สมองไม่เปลี่ยน", { kind, outcome: "unchanged" });
          return { ok: true, outcome: "unchanged", applied, versionId: live.version_id };
        }

        const cards = after.map(sourceCardToCard);
        const tree = treeSha256(after.map((card) => ({ item_id: card.itemId, body_sha256: card.bodySha256 })));
        let bundle;
        try {
          bundle = compileCards({
            cards, versionId: "candidate", treeSha256: tree, codeContract: BRAIN_CODE_CONTRACT,
            pinnedFiles: manifest.pinnedFiles ?? {}, lintAllowlist: manifest.lintAllowlist ?? [],
            db, todayIso, logger: QUIET,
          });
        } catch (err) {
          throw new BrainWriteRefused(`ประกอบสมองจากข้อมูลนี้ไม่ได้: ${err?.message || err}`, { outcome: "blocked" });
        }
        // คอมไพล์ "ของเดิมก่อนแก้" ด้วย (การ์ดอยู่ในหน่วยความจำแล้ว ไม่แตะฐานเพิ่ม) เพื่อให้
        // ด่านแยกออกว่างบตัวอักษรที่ล้น เกิดจากการแก้ครั้งนี้หรือล้นอยู่ก่อนแล้ว — ถ้าไม่แยก
        // คลังความรู้ที่ล้นวันนี้จะล็อกไม่ให้ใครแก้อะไรได้อีกเลย แม้แต่การลบเนื้อออกให้เล็กลง
        let previousBundle = null;
        try {
          previousBundle = compileCards({
            cards: before.map(sourceCardToCard), versionId: live.version_id,
            treeSha256: live.tree_sha256, codeContract: BRAIN_CODE_CONTRACT,
            pinnedFiles: manifest.pinnedFiles ?? {}, lintAllowlist: manifest.lintAllowlist ?? [],
            db, todayIso, logger: QUIET,
          });
        } catch { previousBundle = null; }
        // เฟส 3: ด่านเล่นซ้ำต้องได้ของครบสี่อย่างถึงจะทำงาน — โหมด, คลังเทิร์น, ตารางคำต้องห้าม
        // และกฎฉุกเฉินของ runtime ถ้าขาดอย่างใดอย่างหนึ่ง gate.mjs จะปฏิเสธเสียงดัง
        // ไม่ใช่รายงานว่า "ไม่เกี่ยวกับการแก้นี้" ซึ่งอ่านได้ว่าปลอดภัย
        const report = runBrainGates({
          cards, bundle, touched, inheritedAcks, todayIso, previousBundle, delegated,
          allowlist: liveLintAllowlist(db, manifest.lintAllowlist ?? []),
          gateMode: config.brainGates ?? "", db,
          goldenTurns: safeGoldenTurns(db),
          bannedPhrases: bannedWords, extraRules: safetyRules,
          versionId: "candidate",
          // การ์ดที่ถูกลบไม่อยู่ใน `cards` แล้ว — ส่งชุดก่อนแก้ไปด้วยเพื่อให้ตัวเลือกเห็นว่ามีอะไรหายไป
          previousCards: before.map(sourceCardToCard),
        });
        const touchedKinds = [...new Set(
          [...cards, ...before.map(sourceCardToCard)]
            .filter((c) => touched.includes(c.itemId)).map((c) => c.kind),
        )];

        if (report.verdict === "error" || report.verdict === "block") {
          throw new BrainWriteRefused(refusalMessage(report), {
            outcome: "blocked", findings: report.blocking, gates: report.gates,
          });
        }
        // สิทธิ์ที่มอบมาเผยแพร่ได้แค่ canary — และมีชนิดที่ canary ไม่รองรับเลยแม้แต่ใบเดียว
        // ต้องหยุด ไม่ใช่ปล่อยขึ้น canary แบบครึ่ง ๆ กลาง ๆ
        const forbidden = touchedKinds.filter((k) => CANARY_FORBIDDEN_KINDS.includes(k));
        if (delegated && (spec.liveOnly === true || forbidden.length)) {
          throw new BrainWriteRefused(
            `${spec.label}เผยแพร่แบบทดลองไม่ได้ (canary_not_supported_for_kind) — ต้องให้พี่ง้วงกดเอง`,
            { outcome: "blocked" },
          );
        }

        // ข้อที่เฟสนี้ยังไม่รองรับ: รุ่นค้างหลายใบพร้อมกัน ทุกรุ่นถูกสร้างจาก "ตารางเดิม ณ
        // ตอนนั้น + สิ่งที่แก้" ใบที่สองจึงไม่มีของในใบแรกอยู่เลย เอาไปใช้เมื่อไรของในใบแรก
        // หายเงียบ — ต้องหยุดที่ใบที่สอง พร้อมบอกว่าใบที่ค้างคือใบไหนและต้องทำอะไรกับมัน
        const wouldPark = report.verdict === "needs_ack" || !canPublishLive;
        if (wouldPark) {
          if (spec.liveOnly === true) {
            throw new BrainWriteRefused(
              `${spec.label}ต้องมีผลทันทีเท่านั้น แต่สมองยังมีข้อค้างที่ต้องรับทราบก่อน`
              + " — เคลียร์ข้อค้างในแผงรุ่นสมองแล้วกดใหม่อีกครั้ง",
              { outcome: "blocked", findings: report.needsAck },
            );
          }
          const pending = pendingChildOf(db, live.version_id);
          if (pending) {
            throw new BrainWriteRefused(
              `ยังมีรุ่นสมอง ${pending.seq} ค้างอยู่ (${pending.pointer === "canary" ? "รุ่นทดลอง" : "รอรับทราบ"})`
              + " — ใช้งานหรือปัดตกรุ่นนั้นในแผงรุ่นสมองก่อน แล้วค่อยส่งของชิ้นนี้",
              { outcome: "blocked" },
            );
          }
        }
        const target = report.verdict === "needs_ack" ? null : (canPublishLive ? "live" : "canary");
        // ทุกทางที่ไม่ใช่ live ต้องคืนตารางเดิมให้เหมือนก่อนกด — ของที่ยังไม่ผ่านต้องไม่ถึงลูกค้า
        if (target !== "live") db.raw.exec("ROLLBACK TO brain_write");
        db.raw.exec("RELEASE brain_write");

        const { revIds } = appendCardRevisions(db, after, { createdBy: username, createdAt: at });
        const counts = after.reduce((acc, card) => ({ ...acc, [card.kind]: (acc[card.kind] ?? 0) + 1 }), {});
        const version = db.createBrainVersion({
          parentId: live.version_id,
          label: auditLabel(audit, spec),
          status: target === null ? "proposed" : "draft",
          revIds, pinnedFiles: manifest.pinnedFiles ?? {}, lintAllowlist: manifest.lintAllowlist ?? [],
          counts, codeContract: BRAIN_CODE_CONTRACT, createdBy: username, createdAt: at,
          // delegated ต้องติดไปกับรุ่น ไม่ใช่ดูจาก pointer ตอนนั้น: รุ่นที่ทีมงานเขียนแล้ว
          // ค้างเป็น proposed ถ้าเจ้าของกดรับทราบทีหลัง มันต้องไป canary ไม่ใช่ live
          //
          // เฟส 3: บริบทของจอสอน (ที่มา, ชิปเหตุผล, คำตอบที่ควรเป็น) ผ่านทะเบียนกรองก่อนเสมอ
          // — ทางเขียนเดิมที่ไม่ส่ง teach มา ยังได้ teach_json รูปเดิมทุกฟิลด์ (source=console)
          teach: { ...sanitizeTeachContext(teach ?? {}), kind, touched, by: username, delegated },
        });
        // checksum ที่ไม่ผูกกับวันที่ (เวอร์ชันเดิมต้องได้ sha เดิมทุกวัน — ดู import.mjs)
        const timeless = compileCards({
          cards, versionId: version.version_id, treeSha256: tree, codeContract: BRAIN_CODE_CONTRACT,
          pinnedFiles: manifest.pinnedFiles ?? {}, lintAllowlist: manifest.lintAllowlist ?? [],
          db, todayIso: null, logger: QUIET,
        });
        db.setBrainVersionCompiledSha(version.version_id, timeless.checksum);
        db.setBrainVersionGateReport(version.version_id, {
          verdict: report.verdict, kind: `console:${kind}`, compilerVersion: bundle.compilerVersion,
          todayIso, touched,
          // เก็บเหตุผลของด่านที่ "ไม่ได้ทำงาน" ไว้ด้วย — ป้ายเทาที่ไม่บอกว่าทำไม
          // ทำให้คนอ่านว่า "ผ่าน" ได้เท่า ๆ กับอ่านว่า "ปิดอยู่" ซึ่งคนละเรื่องกันสิ้นเชิง
          gates: report.gates.map((g) => ({
            id: g.id, verdict: g.verdict,
            ...(g.verdict === "not_applicable" || g.verdict === "error"
              ? { reason: g.detail?.reason ?? (g.detail?.missing ? `ยังต่อไม่ถึง: ${g.detail.missing.join(" · ")}` : "") }
              : {}),
          })),
          findings: report.verdict === "needs_ack" ? report.needsAck : bundle.lints,
        });
        db.setBrainVersionGateAcks(version.version_id, report.acks);

        if (target === null) {
          writeAudit(db, username, audit, `รุ่นสมอง ${version.seq} รอรับทราบก่อนใช้งาน`,
            { kind, outcome: "needs_ack", seq: version.seq });
          // คนที่กดอาจไม่มีสิทธิ์รับทราบเอง (ทีมงาน) — ถ้าไม่ปลุกเจ้าของ ของจะค้างอยู่
          // ในสถานะที่ไม่มีใครเห็นและไม่มีใครกดได้ ซึ่งคือ "งานหาย" แบบเดียวกับก่อนมีคิว K
          try {
            notifier?.fireLater({
              customerId: "ops:brain", channelId: "default", reason: "brain_needs_ack", force: true,
              reasonTextOverride: `${username} แก้${spec.label}แล้ว แต่สมองยังมีข้อค้างที่ต้องรับทราบก่อนใช้งาน`
                + `\nรุ่นสมอง ${version.seq} · ${auditLabel(audit, spec)}`
                + "\nเปิดหน้าตั้งค่า > รุ่นสมองลูกแพร เพื่อดูข้อค้างแล้วกดรับทราบ",
            });
          } catch (err) { logger.debug?.(`brain: ปลุกเจ้าของไม่สำเร็จ (${err?.message || err})`); }
          return {
            ok: false, status: 409, outcome: "needs_ack",
            versionId: version.version_id, seq: version.seq,
            error: needsAckMessage(report, version.seq),
            findings: report.needsAck,
          };
        }
        db.setBrainVersionStatus(version.version_id, "validated", { at });
        db.setBrainPointer(target, version.version_id, { changedBy: username, at });
        // PDPA (แบบแปลน §5 ข้อ 3): เผยแพร่แล้ว = คำตอบที่คนพิมพ์ไว้ในจอสอนหมดหน้าที่
        // เหลือแค่ตัวชี้ว่ามันกลายเป็นการ์ดใบไหน — ต้องอยู่ในธุรกรรมเดียวกับการย้าย pointer
        // ไม่ใช่งานกวาดทีหลัง (ล้มระหว่างทาง = ข้อความค้างอยู่โดยไม่มีใครรู้ว่าค้าง)
        if (target === "live") {
          db.setBrainVersionTeach(version.version_id, teachJsonAfterPublish(
            { ...sanitizeTeachContext(teach ?? {}), kind, touched, by: username, delegated },
            { cardRefs: touched },
          ));
        }
        writeAudit(db, username, audit, target === "live"
          ? `รุ่นสมอง ${version.seq} (ใช้งานจริง)`
          : `รุ่นสมอง ${version.seq} (ทดลอง — ยังไม่ถึงลูกค้า)`,
          { kind, outcome: target, seq: version.seq });
        return {
          ok: true, outcome: target, applied: target === "live" ? applied : null,
          versionId: version.version_id, seq: version.seq,
        };
      });
    } catch (err) {
      return refusalOf(err, { db, username, kind });
    }

    function guarded(fn) {
      try {
        return fn();
      } catch (err) {
        return refusalOf(err, { db, username, kind });
      }
    }
  }

  // แปลงคำปฏิเสธของ hook เป็นผลลัพธ์ที่ handler ตอบกลับได้ — ใช้ทั้งทางแฟล็กเปิดและทางเดิมล้วน
  function refusalOf(err, { db: handle, username, kind }) {
    if (err instanceof BrainWriteRefused) {
      // ธุรกรรมถูกยกเลิกไปแล้ว ตารางเดิมไม่ขยับ — แต่ต้องไม่เงียบ
      // ยกเว้น silent: กรณีที่ "ไม่มีของให้ทำ" (แถวหายไประหว่างทาง) ไม่ใช่การถูกด่านบล็อก
      // การทิ้ง audit ไว้จะทำให้สมุดเต็มไปด้วยเหตุการณ์ที่ไม่มีใครทำอะไรผิด
      if (err.silent !== true) {
        try {
          handle.addAudit({
            operator: username, action: "brain_write_blocked", target: kind,
            detail: String(err.message).slice(0, 200),
          });
        } catch { /* audit ล้มไม่ใช่เหตุให้กลืน error ของจริง */ }
      }
      return {
        ok: false, status: err.status ?? 409, outcome: err.outcome,
        error: err.message, findings: err.findings,
      };
    }
    throw err;
  }

  return { enabled, apply };

  // คลังเทิร์นอ่านไม่ได้ (ฐานเก่าที่ยังไม่มีตาราง) ต้องไม่ทำให้การเขียนล้ม — แต่ต้องคืน null
  // ไม่ใช่ [] เพราะ [] แปลว่า "คลังว่างจริง" ส่วน null แปลว่า "ยังต่อไม่ถึงคลัง"
  function safeGoldenTurns(handle) {
    // includeRetired: เคส irreversible ที่ถูกปิดยังต้องบล็อกอยู่ (ตัวเลือกใน gate5select
    // เป็นคนกรองเคสที่ปิดแล้วและไม่ใช่ floor ออก ไม่ใช่ตรงนี้)
    try { return handle.listGoldenTurns({ includeRetired: true }); } catch { return null; }
  }

  function readCards(when) {
    try {
      return collectCurrentSourceCards(db, { classRoundsFile, logger: QUIET });
    } catch (err) {
      throw new BrainWriteRefused(`อ่านข้อมูลตั้งต้นของสมอง (${when}) ไม่ได้: ${err?.message || err}`, { outcome: "blocked" });
    }
  }
}
