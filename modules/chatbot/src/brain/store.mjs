// brain/store.mjs — ทางเขียน/อ่านเดียวของตารางสมอง (brain_item_revs / brain_versions / redactions)
//
// กติกาเหล็กสองข้อของไฟล์นี้:
//   1. ไม่ export ฟังก์ชัน update/delete revision เลย — append-only เป็น "สิ่งที่ทำไม่ได้"
//      ไม่ใช่ "สิ่งที่ต้องระวัง" (ชั้นล่างมี trigger ใน brain/schema.mjs กันไว้อีกชั้น)
//   2. เฟส 1a ไม่มีใครอ่านตารางพวกนี้ในเส้นตอบลูกค้า — ตัวช่วยที่นี่มีไว้ให้ importer,
//      คอมไพเลอร์ และเทสต์ใช้เท่านั้น
import { randomUUID } from "node:crypto";
import { sha256, stableJson } from "./text.mjs";
import { canaryKindConflicts, canaryRefusalMessage } from "./canary.mjs";
import { createBrainRedactionMethods } from "./redactStore.mjs";

// 5 ชนิดที่เปิดตัวจริงตามแบบแปลน §5 (อีก 5 ชนิดอยู่ใน CHECK ของตารางแล้วเพื่อไม่ต้อง
// rebuild ตอน P4 แต่ที่นี่ปฏิเสธไว้ก่อน — ชนิดที่ยังไม่มีคอมไพเลอร์รองรับต้องเข้าไม่ได้)
export const LAUNCH_KINDS = Object.freeze(["product", "fact", "price", "schedule", "policy"]);
export const INJECT_MODES = Object.freeze(["pin", "retrieve", "never"]);
export const CONFIDENCE_LEVELS = Object.freeze(["confirmed", "seen_once", "needs_owner_confirm"]);
export const VERSION_STATUSES = Object.freeze([
  "draft", "checking", "proposed", "rejected", "validated",
  "canary", "live", "retired", "rolled_back", "failed",
]);
// แบบแปลน §5 "เวอร์ชัน, pointer, และ fallback": pointer ตั้งได้เฉพาะเวอร์ชันที่ผ่านด่านแล้ว
export const POINTABLE_STATUSES = Object.freeze(["validated", "canary", "live"]);
export const POINTABLE_VERDICTS = Object.freeze(["pass", "needs_ack"]);

// "revision ปัจจุบันของการ์ด" มีนิยามเดียวทั้งไฟล์ ห้ามมีสองแบบ
// (MAX(rowid) กับ ORDER BY created_at DESC ให้คนละคำตอบเมื่อ created_at เท่ากัน)
const CURRENT_REV_ORDER = "ORDER BY created_at DESC, rowid DESC";

// tree_sha256 = sha ของคู่ item_id:body_sha256 ที่เรียงแล้ว — จงใจไม่รวม rev_id (uuid)
// และไม่รวมเนื้อ body เพื่อให้ (ก) เนื้อหาชุดเดียวกันบนสองเครื่องได้ tree เท่ากัน
// (ข) การลบเนื้อตาม PDPA ไม่ทำให้ tree ของเวอร์ชันเก่าเปลี่ยน
export function treeSha256(revs = []) {
  return sha256(stableJson([...revs].map((rev) => `${rev.item_id}:${rev.body_sha256}`).sort()));
}

export function bodySha256(body) {
  return sha256(stableJson(body ?? {}));
}

/**
 * ทำงานทั้งก้อนหรือไม่ทำเลย
 *
 * SQLite ไม่มี nested transaction: BEGIN ซ้อนจะ throw แล้วลาก rollback ทั้งก้อน จึงต้องรู้
 * ให้ได้ว่า "ตอนนี้อยู่ในธุรกรรมของใครอยู่หรือเปล่า" — `db.isTransaction` ตอบได้ตรง ๆ แต่มี
 * เฉพาะ Node >= 22.16 (VPS ของจริงรัน 22.18 แต่ engines เคยประกาศ >= 22.5 ไว้ ซึ่งแปลว่า
 * เคยมีสัญญาว่ารันบนรุ่นที่ไม่มีคุณสมบัตินี้ได้) รุ่นเก่ากว่าจึงตกไปใช้ SAVEPOINT ซึ่ง
 * ทำงานถูกทั้งสองกรณีอยู่แล้ว: อยู่นอกธุรกรรม SAVEPOINT จะเปิดธุรกรรมให้เอง และการ
 * RELEASE ของ savepoint นอกสุดคือการ commit
 */
export function createTransactionRunner(db) {
  const canAsk = typeof db.isTransaction === "boolean";
  let depth = 0;
  return function atomically(fn) {
    if (canAsk && db.isTransaction) return fn();
    if (!canAsk && depth > 0) return fn();
    const savepoint = !canAsk;
    depth += 1;
    db.exec(savepoint ? "SAVEPOINT brain_tx" : "BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec(savepoint ? "RELEASE brain_tx" : "COMMIT");
      return out;
    } catch (err) {
      try {
        if (savepoint) db.exec("ROLLBACK TO brain_tx; RELEASE brain_tx;");
        else db.exec("ROLLBACK");
      } catch { /* ธุรกรรมถูกปิดไปแล้วโดย SQLite */ }
      throw err;
    } finally {
      depth -= 1;
    }
  };
}

export function createBrainDbMethods({ db, run, all, get, now }) {
  const atomically = createTransactionRunner(db);

  return {
    brainTransaction(fn) { return atomically(fn); },

    // ทางเขียนของ PDPA (ลบเนื้อการ์ด/ทะเบียนการลบ) อยู่ไฟล์ข้าง ๆ เพื่อคุมขนาดไฟล์นี้
    // แต่ยังเป็น object เดียวกัน — ยังไม่มีทางเขียนตารางสมองที่อยู่นอกสองไฟล์นี้
    ...createBrainRedactionMethods({ run, all, now, atomically }),

    /* ------------------------------ การ์ด (revision) ----------------------------- */

    // เขียน revision ใหม่หนึ่งแถว — ทางเขียนเดียวที่มี ไม่มีคู่ update/delete โดยเจตนา
    appendBrainRev({
      itemId, kind, key, body, scope = {}, inject = "pin", priority = 50, locked = false,
      confidence = "confirmed", validFrom = null, validUntil = null, supersedesRev = null,
      provenance = {}, createdBy = "system", createdAt = null, revId = null,
    } = {}) {
      if (!LAUNCH_KINDS.includes(kind)) {
        throw new Error(`brain: kind "${kind}" ยังไม่เปิดใช้ในเฟสนี้ (ใช้ได้: ${LAUNCH_KINDS.join(", ")})`);
      }
      if (!INJECT_MODES.includes(inject)) throw new Error(`brain: inject "${inject}" ไม่ถูกต้อง`);
      if (!CONFIDENCE_LEVELS.includes(confidence)) throw new Error(`brain: confidence "${confidence}" ไม่ถูกต้อง`);
      if (!itemId || !key) throw new Error("brain: ต้องมี itemId และ key");
      const id = String(revId || randomUUID());
      const bodyJson = stableJson(body ?? {});
      run(
        `INSERT INTO brain_item_revs
           (rev_id, item_id, kind, key, scope_json, body_json, body_sha256, redacted, inject,
            priority, locked, confidence, valid_from, valid_until, supersedes_rev,
            provenance_json, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, String(itemId), String(kind), String(key), stableJson(scope ?? {}),
        bodyJson, sha256(bodyJson), String(inject),
        Number.isInteger(priority) ? priority : 50, locked ? 1 : 0, String(confidence),
        validFrom ?? null, validUntil ?? null, supersedesRev ?? null,
        stableJson(provenance ?? {}), String(createdBy), Number(createdAt ?? now()),
      );
      return this.getBrainRev(id);
    },

    getBrainRev(revId) {
      return get("SELECT * FROM brain_item_revs WHERE rev_id = ?", String(revId)) ?? null;
    },

    listBrainRevs(revIds = []) {
      // อ่านทีละแถวโดยเจตนา: จำนวน rev ต่อเวอร์ชันหลักร้อย และ prepared statement
      // ตัวเดียวถูก cache ไว้แล้ว (ดู db.mjs) — ถูกกว่าการต่อ SQL ยาวแบบ IN (?,?,...)
      const out = [];
      for (const id of revIds) {
        const row = this.getBrainRev(id);
        if (row) out.push(row);
      }
      return out;
    },

    // revision ปัจจุบันของการ์ดหนึ่งใบ — นิยามเดียวกับ latestBrainRevs
    currentBrainRev(itemId) {
      return get(`SELECT * FROM brain_item_revs WHERE item_id = ? ${CURRENT_REV_ORDER} LIMIT 1`, String(itemId)) ?? null;
    },

    // revision ที่ยัง "ใช้ซ้ำได้" ของการ์ดใบหนึ่ง — เทียบกับ **ใบปัจจุบัน** เท่านั้น
    //
    // เทียบกับทั้งประวัติ (content-addressed) ดูประหยัดกว่า แต่ทำให้ประวัติงอ: ค่าที่
    // เปลี่ยนไปแล้วเปลี่ยนกลับ (A -> B -> A) จะดึง rev ตัวแรกกลับเข้า manifest ใหม่
    // แล้ว "ใบปัจจุบันตามเวลา" (B) กับ "ใบที่ live ใช้" (A) จะเป็นคนละใบ ซึ่งอ่านประวัติ
    // ไม่ออกและทำให้ supersedes_rev โกหก แบบแปลนสั่งไว้ว่าประวัติต้องเป็นเส้นตรง
    //
    // เนื้อ ขอบเขต และโหมดฉีดต้องตรงกันหมด และต้องยังไม่ถูก redact (การ์ดที่ถูกลบเนื้อ
    // แล้วห้ามถูกดึงกลับเข้า manifest ไม่งั้นเวอร์ชันถัดไปจะคอมไพล์ไม่ได้ตลอดกาล)
    reusableBrainRev({ itemId, bodySha256: sha, inject = "pin", scope = {} } = {}) {
      const current = this.currentBrainRev(itemId);
      if (!current || current.redacted === 1) return null;
      const same = current.body_sha256 === String(sha)
        && current.inject === String(inject)
        && current.scope_json === stableJson(scope ?? {});
      return same ? current : null;
    },

    // revision ล่าสุดของทุกการ์ด (ใช้ตอนสร้างเวอร์ชันใหม่จากสถานะปัจจุบัน)
    latestBrainRevs() {
      const items = all("SELECT DISTINCT item_id FROM brain_item_revs ORDER BY item_id");
      return items
        .map((row) => this.currentBrainRev(row.item_id))
        .filter(Boolean)
        .sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    },

    countBrainRevs() {
      return Number(get("SELECT COUNT(*) AS n FROM brain_item_revs")?.n ?? 0);
    },

    /* -------------------------------- เวอร์ชัน --------------------------------- */

    createBrainVersion({
      versionId = null, parentId = null, label = "", status = "draft",
      revIds = [], pinnedFiles = {}, lintAllowlist = [], counts = {}, codeContract = "",
      compiledSha256 = null, gateReport = null, teach = {},
      createdBy = "system", createdAt = null,
    } = {}) {
      if (!VERSION_STATUSES.includes(status)) throw new Error(`brain: status "${status}" ไม่ถูกต้อง`);
      return atomically(() => {
        const id = String(versionId || randomUUID());
        const at = Number(createdAt ?? now());
        const seq = Number(get("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM brain_versions")?.next ?? 1);
        const revs = this.listBrainRevs(revIds);
        if (revs.length !== revIds.length) throw new Error("brain: manifest อ้าง revision ที่ไม่มีอยู่จริง");
        // เวอร์ชันที่มีการ์ดถูกลบเนื้อแล้ว คอมไพล์ไม่ได้ตลอดกาล — ห้ามสร้างตั้งแต่แรก
        const redacted = revs.filter((rev) => rev.redacted === 1).map((rev) => rev.item_id);
        if (redacted.length) {
          throw new Error(`brain: manifest มีการ์ดที่ถูกลบตามคำขอลูกค้า (${redacted.join(", ")}) — ต้องนำเข้าใหม่ก่อน`);
        }
        run(
          `INSERT INTO brain_versions
             (version_id, parent_id, seq, label, status, pointer, canary_json, manifest_json,
              tree_sha256, compiled_sha256, code_contract, gate_report_json, gate_acks_json,
              teach_json, created_by, created_at, validated_at, published_at, retired_at)
           VALUES (?, ?, ?, ?, ?, NULL, '{}', ?, ?, ?, ?, ?, '[]', ?, ?, ?, NULL, NULL, NULL)`,
          id, parentId ?? null, seq, String(label), String(status),
          stableJson({
            revIds: [...revIds], pinnedFiles: pinnedFiles ?? {},
            lintAllowlist: [...(lintAllowlist ?? [])].sort(), counts: counts ?? {},
          }),
          treeSha256(revs), compiledSha256 ?? null, String(codeContract),
          gateReport ? stableJson(gateReport) : null, stableJson(teach ?? {}),
          String(createdBy), at,
        );
        return this.getBrainVersion(id);
      });
    },

    getBrainVersion(versionId) {
      return get("SELECT * FROM brain_versions WHERE version_id = ?", String(versionId)) ?? null;
    },

    listBrainVersions(limit = 50) {
      return all(
        "SELECT * FROM brain_versions ORDER BY seq DESC LIMIT ?",
        Math.min(500, Math.max(1, Number(limit) || 50)),
      );
    },

    setBrainVersionCompiledSha(versionId, compiledSha256) {
      return run(
        "UPDATE brain_versions SET compiled_sha256 = ? WHERE version_id = ?",
        compiledSha256 ? String(compiledSha256) : null, String(versionId),
      ).changes === 1;
    },

    setBrainVersionGateReport(versionId, gateReport) {
      return run(
        "UPDATE brain_versions SET gate_report_json = ? WHERE version_id = ?",
        gateReport ? stableJson(gateReport) : null, String(versionId),
      ).changes === 1;
    },

    // "ทุก needs_ack ต้องมี ack" (แบบแปลน §5) — เก็บว่าใครรับทราบอะไรไว้
    setBrainVersionGateAcks(versionId, acks = []) {
      return run(
        "UPDATE brain_versions SET gate_acks_json = ? WHERE version_id = ?",
        stableJson(Array.isArray(acks) ? acks : []), String(versionId),
      ).changes === 1;
    },

    // teach_json ของรุ่น — เขียนทับได้ทางเดียวคือ "ล้างข้อความที่คนพิมพ์ตอนเผยแพร่"
    // (แบบแปลน §5 PDPA ข้อ 3: correct_text หายไปเหลือแค่ตัวชี้การ์ด) ผู้เรียกส่ง object
    // ที่ล้างแล้วมาเท่านั้น — ไม่มีเส้นทางไหนเติมข้อความกลับเข้าไปได้หลังเผยแพร่
    setBrainVersionTeach(versionId, teach = {}) {
      return run(
        "UPDATE brain_versions SET teach_json = ? WHERE version_id = ?",
        stableJson(teach ?? {}), String(versionId),
      ).changes === 1;
    },

    // กลุ่มทดลองของเวอร์ชัน canary (แบบแปลน §7 "Canary / shadow")
    // เก็บเป็น JSON บนแถวเวอร์ชัน ไม่ใช่ settings กลาง — กลุ่มทดลองเป็นสมบัติของ "รุ่นนั้น"
    // ถ้าเก็บแยก การย้าย pointer จะทิ้งกลุ่มเก่าค้างไว้แล้วรุ่นถัดไปรับมรดกไปโดยไม่มีใครสั่ง
    setBrainVersionCanary(versionId, canary = {}) {
      return run(
        "UPDATE brain_versions SET canary_json = ? WHERE version_id = ?",
        stableJson(canary ?? {}), String(versionId),
      ).changes === 1;
    },

    setBrainVersionStatus(versionId, status, { at = null } = {}) {
      if (!VERSION_STATUSES.includes(status)) throw new Error(`brain: status "${status}" ไม่ถูกต้อง`);
      const when = Number(at ?? now());
      const stamp = status === "validated" ? "validated_at" : status === "retired" ? "retired_at" : null;
      return run(
        `UPDATE brain_versions SET status = ?${stamp ? `, ${stamp} = COALESCE(${stamp}, ?)` : ""} WHERE version_id = ?`,
        ...(stamp ? [String(status), when, String(versionId)] : [String(status), String(versionId)]),
      ).changes === 1;
    },

    /* --------------------------------- pointer -------------------------------- */

    getBrainPointer(role = "live") {
      return get("SELECT * FROM brain_versions WHERE pointer = ?", String(role)) ?? null;
    },

    // ย้าย pointer — "ใครสลับเมื่อไร" ลง admin_audit เดิม (แบบแปลนตัดตาราง pointer_history ทิ้ง)
    // เฟส 1a: ตั้ง live ได้จาก importer เท่านั้น และยังไม่มีโค้ดใดอ่าน pointer นี้ตอนตอบลูกค้า
    // retiredStatus = สถานะที่จะให้กับรุ่นที่หลุดจาก live (ค่าเริ่มต้น 'retired')
    // ต้องตั้งได้ในธุรกรรมเดียวกับการย้าย pointer: การย้อนกลับที่ตั้งป้าย "ถูกถอน" ทีหลัง
    // แล้วล้มระหว่างทาง จะรายงานว่าไม่สำเร็จ ทั้งที่ live ย้ายไปแล้วจริง
    setBrainPointer(role, versionId, { changedBy = "system", at = null, retiredStatus = "retired" } = {}) {
      if (!["live", "canary"].includes(role)) throw new Error(`brain: pointer "${role}" ไม่ถูกต้อง`);
      return atomically(() => {
        const target = versionId ? this.getBrainVersion(versionId) : null;
        if (versionId && !target) throw new Error("brain: ตั้ง pointer ไปยังเวอร์ชันที่ไม่มีอยู่จริงไม่ได้");
        if (target) assertPointable(target, role);
        // ทดลองกับบางห้องได้เฉพาะของที่เป็น "คำพูด" — ราคา/สินค้า/รอบ/คำต้องห้าม/กติกาที่
        // บังคับใช้จริง ต้องเป็นค่าเดียวต่อธุรกิจ (แบบแปลน §7) ด่านนี้อยู่ในทางเขียนเดียว
        // ที่มี ไม่ใช่ใน UI — คอนโซล สคริปต์ และเทสต์จึงข้ามไม่ได้เหมือนกันหมด
        if (target && role === "canary") assertCanaryAllowed(this, target);
        const when = Number(at ?? now());
        // เลื่อนขั้น canary -> live คือทางเดินปกติของแบบแปลน (§6 Step 5): รุ่นที่ทดลอง
        // แล้วสัญญาณปกติจะถูกยกเป็นตัวจริง ต้องปล่อย canary ในธุรกรรมเดียวกัน ไม่ใช่
        // โยน "ถือสองบทบาท" ใส่หน้า ซึ่งบังคับให้คนต้องยกเลิก canary มือเปล่าก่อน
        const promoting = role === "live" && target?.pointer === "canary";
        if (promoting) {
          run("UPDATE brain_versions SET pointer = NULL WHERE version_id = ?", String(versionId));
          this.addAudit?.({
            operator: String(changedBy), action: "brain_pointer_promote", target: String(versionId),
            detail: "canary -> live",
          });
        }
        const previous = this.getBrainPointer(role);
        if (previous && previous.version_id !== versionId) {
          run("UPDATE brain_versions SET pointer = NULL WHERE pointer = ?", String(role));
          // เวอร์ชันที่หลุดจาก live ไม่ใช่ "live ที่ไม่มี pointer" — มันคือรุ่นที่ปลดระวางแล้ว
          if (role === "live") {
            if (!VERSION_STATUSES.includes(retiredStatus)) {
              throw new Error(`brain: retiredStatus "${retiredStatus}" ไม่ถูกต้อง`);
            }
            run(
              "UPDATE brain_versions SET status = ?, retired_at = COALESCE(retired_at, ?) WHERE version_id = ?",
              retiredStatus, when, previous.version_id,
            );
          }
        }
        if (versionId) {
          run(
            `UPDATE brain_versions SET pointer = ?, status = ?, published_at = COALESCE(published_at, ?)
              WHERE version_id = ?`,
            String(role), role === "live" ? "live" : "canary", when, String(versionId),
          );
        }
        this.addAudit?.({
          operator: String(changedBy),
          action: `brain_pointer_${role}`,
          target: versionId ? String(versionId) : "",
          detail: `${previous?.version_id || "-"} -> ${versionId || "-"}`,
        });
        return versionId ? this.getBrainVersion(versionId) : null;
      });
    },
  };
}

// เวอร์ชันหนึ่งถือได้บทบาทเดียว: ถ้า live กับ canary ชี้ใบเดียวกัน "การทดลอง" ก็ไม่มีอยู่จริง
// แต่ผลกลับถูกอ่านเหมือนมีการทดลอง — เป็นด่านที่โกหกในทิศที่สบายใจ (แบบแปลน §12)
//
// ข้อยกเว้นทางเดียว: canary -> live คือการ "เลื่อนขั้น" ตามแบบแปลน §6 Step 5 ไม่ใช่การ
// ถือสองบทบาท (setBrainPointer ปล่อย canary ให้ในธุรกรรมเดียวกัน)
// เทียบชุดการ์ด "ชนิดที่ทดลองไม่ได้" ของรุ่นที่จะทดลอง กับรุ่น live ปัจจุบัน
// ไม่มี live = ยังไม่มีอะไรให้เทียบ ⇒ การทดลองบนความว่างเปล่าไม่ใช่การทดลอง ปฏิเสธเช่นกัน
function assertCanaryAllowed(store, target) {
  const live = store.getBrainPointer("live");
  if (!live) throw new Error("brain: ตั้ง canary โดยยังไม่มีรุ่น live ให้เทียบไม่ได้");
  const revsOf = (version) => {
    let ids = [];
    try { ids = JSON.parse(String(version.manifest_json || "{}"))?.revIds ?? []; } catch { ids = []; }
    return store.listBrainRevs(ids);
  };
  const conflicts = canaryKindConflicts(revsOf(target), revsOf(live));
  if (conflicts.length) throw new Error(canaryRefusalMessage(conflicts));
}

function assertPointable(version, role) {
  if (role === "canary" && version.pointer === "live") {
    throw new Error(`brain: เวอร์ชัน ${version.version_id} เป็น live อยู่แล้ว ถือสองบทบาทพร้อมกันไม่ได้`);
  }
  if (!POINTABLE_STATUSES.includes(version.status)) {
    throw new Error(`brain: ตั้ง pointer ให้เวอร์ชันสถานะ "${version.status}" ไม่ได้ (ต้องเป็น ${POINTABLE_STATUSES.join("/")})`);
  }
  let verdict = null;
  try { verdict = JSON.parse(String(version.gate_report_json || "null"))?.verdict ?? null; } catch { verdict = null; }
  if (!POINTABLE_VERDICTS.includes(verdict)) {
    throw new Error(`brain: ตั้ง pointer ไม่ได้ ผลด่านของเวอร์ชันนี้คือ "${verdict ?? "ยังไม่มี"}" (ต้องเป็น ${POINTABLE_VERDICTS.join("/")})`);
  }
  // needs_ack ที่ไม่มีใครรับทราบ = "ผ่านแบบเงียบ ๆ" ซึ่งคือสิ่งที่ ack ถูกคิดขึ้นมาเพื่อกัน
  if (verdict === "needs_ack") {
    let acks = [];
    try { acks = JSON.parse(String(version.gate_acks_json || "[]")); } catch { acks = []; }
    if (!Array.isArray(acks) || acks.length === 0) {
      throw new Error(`brain: เวอร์ชัน ${version.version_id} มีข้อที่ต้องรับทราบ แต่ยังไม่มีใครรับทราบ — ตั้ง pointer ไม่ได้`);
    }
  }
}
