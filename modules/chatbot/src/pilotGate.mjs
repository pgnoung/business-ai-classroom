// pilotGate.mjs — narrow live-pilot boundary for a single explicitly enrolled LINE user.
//
// This is intentionally independent from the normal customer database.  A blocked
// webhook event is acknowledged to LINE but never becomes a customer/message row,
// never reaches the pipeline, and cannot cause an outbound API call.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, chmodSync, closeSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

const LEGACY_STATE_VERSION = 2;
export const PILOT_STATE_VERSION = 3;
export const DEFAULT_PILOT_MAX_ENROLLED_SUBJECTS = 25;
// v1.4.7 (คำสั่งพี่ง้วง 2026-08-16 "ให้ AI ทำงานกับทุกคนที่ add LINE มาได้เลย"):
// เพดานบนสุดที่ยอมให้ตั้งผ่าน env เมื่อเปิด open enrollment — ยังเป็นเพดานปิดเสมอ
// (ห้าม unbounded) และ default เดิม 25 ไม่เปลี่ยนสำหรับ instance ที่ไม่ได้ตั้งค่า
export const PILOT_MAX_SUBJECT_CEILING = 500;
const MAX_PILOT_AUDIT_ENTRIES = 64;
const ENROLLMENT_PREFIX = "/pilot ";

function sha256(value) {
  return createHash("sha256").update(String(value), "utf8").digest("hex");
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/iu.test(String(left)) || !/^[a-f0-9]{64}$/iu.test(String(right))) return false;
  const a = Buffer.from(String(left).toLowerCase(), "hex");
  const b = Buffer.from(String(right).toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function subjectHash(channelId, userId) {
  // Channel is included so an allowlist entry cannot escape into another OA.
  return sha256(`line-pilot-v1\u0000${String(channelId)}\u0000${String(userId)}`);
}

function bindingHash(businessId, identityHash) {
  return sha256(`line-pilot-binding-v1\u0000${String(businessId)}\u0000${String(identityHash).toLowerCase()}`);
}

function privateDirectory(path) {
  try {
    const details = lstatSync(path);
    return details.isDirectory()
      && !details.isSymbolicLink()
      && details.uid === process.getuid?.()
      && (details.mode & 0o777) === 0o700;
  } catch {
    return false;
  }
}

function readPrivateFile(path) {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const details = fstatSync(fd);
      if (!details.isFile() || details.uid !== process.getuid?.() || (details.mode & 0o777) !== 0o600) return null;
      return readFileSync(fd, "utf8");
    } finally { closeSync(fd); }
  } catch {
    return null;
  }
}

function boundedAudit(audit, entry) {
  // The first receipt binds this state to the exact OA/business and is part of
  // the validator contract. Never age it out while bounding later events.
  const bindingReceipt = audit[0];
  return [bindingReceipt, ...[...audit.slice(1), entry].slice(-(MAX_PILOT_AUDIT_ENTRIES - 1))];
}

function withStateLock(path, callback) {
  const directory = dirname(path);
  if (!privateDirectory(directory)) throw new Error("pilot_state_directory_not_private");
  const lockPath = join(directory, `.${basename(path)}.lock`);
  let fd;
  try {
    fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const details = fstatSync(fd);
    if (!details.isFile() || details.uid !== process.getuid?.() || (details.mode & 0o777) !== 0o600) throw new Error("pilot_state_lock_not_private");
    return callback();
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("pilot_state_locked");
    throw error;
  } finally {
    if (fd != null) {
      closeSync(fd);
      try { unlinkSync(lockPath); } catch { /* fail closed on the next writer */ }
    }
  }
}

function validHash(value) { return /^[a-f0-9]{64}$/iu.test(String(value)); }

function validBindingState(state, { businessId, identityHash } = {}) {
  return state && state.businessId === businessId && state.lineIdentityHash === identityHash
    && state.bindingSha256 === bindingHash(businessId, identityHash)
    && Array.isArray(state.allowedSubjectHashes)
    && state.allowedSubjectHashes.every(validHash)
    && new Set(state.allowedSubjectHashes.map((value) => String(value).toLowerCase())).size === state.allowedSubjectHashes.length
    && (state.enrollmentUsedAt == null || Number.isFinite(Number(state.enrollmentUsedAt)))
    && Array.isArray(state.audit) && state.audit.length >= 1 && state.audit.length <= MAX_PILOT_AUDIT_ENTRIES
    && state.audit[0]?.event === "provider_identity_bound"
    && state.audit[0]?.businessId === businessId && state.audit[0]?.identityHash === identityHash
    && state.audit[0]?.bindingSha256 === state.bindingSha256;
}

function readState(path, { businessId, identityHash, maxEnrolledSubjects = DEFAULT_PILOT_MAX_ENROLLED_SUBJECTS } = {}) {
  if (!privateDirectory(dirname(path))) return { ok: false, reason: "state_directory_missing_or_not_0700" };
  const raw = readPrivateFile(path);
  if (raw == null) return { ok: false, reason: "state_file_missing_or_not_0600" };
  try {
    const state = JSON.parse(raw);
    if (!validBindingState(state, { businessId, identityHash })) return { ok: false, reason: "state_file_malformed_or_wrong_binding" };
    if (state.version === LEGACY_STATE_VERSION) {
      if (state.allowedSubjectHashes.length > 1 || state.audit.length > 2 || (state.audit.length === 2 && state.audit[1]?.event !== "first_user_enrolled")) return { ok: false, reason: "state_file_malformed_or_wrong_binding" };
    } else if (state.version === PILOT_STATE_VERSION) {
      if (state.allowedSubjectHashes.length > maxEnrolledSubjects || !Array.isArray(state.invites) || state.invites.length > maxEnrolledSubjects) return { ok: false, reason: "state_file_malformed_or_wrong_binding" };
      if (!state.invites.every((invite) => validHash(invite?.codeSha256) && Number.isFinite(Number(invite?.createdAt)) && (invite.consumedAt == null || Number.isFinite(Number(invite.consumedAt))) && (invite.consumedSubjectHash == null || validHash(invite.consumedSubjectHash)))) return { ok: false, reason: "state_file_malformed_or_wrong_binding" };
      if (new Set(state.invites.map((invite) => String(invite.codeSha256).toLowerCase())).size !== state.invites.length) return { ok: false, reason: "state_file_malformed_or_wrong_binding" };
      const consumed = state.invites.filter((invite) => invite.consumedAt != null);
      if (state.invites.some((invite) => (invite.consumedAt == null) !== (invite.consumedSubjectHash == null)) || consumed.some((invite) => !state.allowedSubjectHashes.some((subject) => safeEqualHex(subject, invite.consumedSubjectHash))) || new Set(consumed.map((invite) => String(invite.consumedSubjectHash).toLowerCase())).size !== consumed.length) return { ok: false, reason: "state_file_malformed_or_wrong_binding" };
    } else return { ok: false, reason: "state_file_malformed_or_wrong_binding" };
    return { ok: true, state };
  } catch { return { ok: false, reason: "state_file_malformed_or_wrong_binding" }; }
}

function upgradeState(state) {
  if (state.version === PILOT_STATE_VERSION) return state;
  // Keep the existing enrolled owner and provider binding intact. The legacy
  // bootstrap hash remains outside this file, exactly as before.
  return { ...state, version: PILOT_STATE_VERSION, invites: [], audit: state.audit.map(({ bootstrapCodeHash, ...entry }) => entry) };
}

function safeMax(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= PILOT_MAX_SUBJECT_CEILING
    ? parsed : DEFAULT_PILOT_MAX_ENROLLED_SUBJECTS;
}

// Control-plane helper. The caller receives the raw command only to put it in
// an owner-only 0600 delivery file; this module never logs it.
export function createPilotInvite({ config, now = Date.now, randomBytesImpl = randomBytes } = {}) {
  const stateFile = String(config?.linePilotAllowlistFile || "");
  const businessId = String(config?.linePilotBusinessId || "");
  const identityHash = String(config?.linePilotIdentityHash || "").toLowerCase();
  const maxEnrolledSubjects = safeMax(config?.linePilotMaxEnrolledSubjects);
  if (!isAbsolute(stateFile) || !/^[a-z0-9][a-z0-9-]{2,80}$/u.test(businessId) || !/^sha256:[a-f0-9]{64}$/u.test(identityHash)) throw new Error("pilot_config_missing_or_invalid");
  return withStateLock(stateFile, () => {
    const result = readState(stateFile, { businessId, identityHash, maxEnrolledSubjects });
    if (!result.ok) throw new Error(result.reason);
    const state = upgradeState(result.state);
    if (state.allowedSubjectHashes.length + state.invites.filter((invite) => invite.consumedAt == null).length >= maxEnrolledSubjects) throw new Error("pilot_enrollment_cap_reached");
    const bytes = Buffer.from(randomBytesImpl(32));
    if (bytes.length !== 32) throw new Error("pilot_invite_randomness_invalid");
    const code = bytes.toString("base64url");
    if (!/^[A-Za-z0-9_-]{40,}$/u.test(code)) throw new Error("pilot_invite_randomness_invalid");
    const createdAt = Number(now());
    const next = { ...state, invites: [...state.invites, { codeSha256: sha256(code), createdAt, consumedAt: null, consumedSubjectHash: null }], audit: boundedAudit(state.audit, { event: "staff_invite_created", at: createdAt }) };
    writeState(stateFile, next);
    return { command: `/pilot ${code}`, createdAt, maxEnrolledSubjects, availableSlots: maxEnrolledSubjects - next.allowedSubjectHashes.length - next.invites.filter((invite) => invite.consumedAt == null).length };
  });
}

function writeState(path, state) {
  const directory = dirname(path);
  if (!privateDirectory(directory)) throw new Error("pilot_state_directory_not_private");
  const temp = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    chmodSync(temp, 0o600); fsyncSync(fd);
  } finally { closeSync(fd); }
  renameSync(temp, path);
  const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

function enrollmentCodeFrom(event) {
  if (event?.type !== "message" || event?.message?.type !== "text") return "";
  const text = String(event.message.text || "");
  if (!text.startsWith(ENROLLMENT_PREFIX)) return "";
  const code = text.slice(ENROLLMENT_PREFIX.length);
  // Exact command, exact code: whitespace/newlines/extra arguments cannot enroll.
  return code && !/[\r\n]/u.test(code) ? code : "";
}

function isEnrollmentCommand(event) {
  if (event?.type !== "message" || event?.message?.type !== "text") return false;
  const text = String(event.message.text || "");
  return text === "/pilot" || text.startsWith(ENROLLMENT_PREFIX);
}

export function createPilotGate({ config, logger = console, now = Date.now } = {}) {
  const enabled = config?.linePilotMode === true;
  // v1.4.7: open enrollment — ทุกคนที่ทักเข้ามาถูกลงทะเบียนอัตโนมัติในข้อความแรก
  // (จนถึงเพดาน) แทนที่จะต้องมี /pilot invite; allowlist ยังเป็นรายชื่อปิดที่ audit ได้
  // และขาออกทุกชนิด (reply/push/broadcast) ยังจำกัดที่คนในรายชื่อเหมือนเดิม
  const openEnrollment = config?.linePilotOpenEnrollment === true;
  const stateFile = String(config?.linePilotAllowlistFile || "");
  const bootstrapCodeHash = String(config?.linePilotBootstrapCodeSha256 || "").toLowerCase();
  const businessId = String(config?.linePilotBusinessId || "");
  const identityHash = String(config?.linePilotIdentityHash || "").toLowerCase();
  const maxEnrolledSubjects = safeMax(config?.linePilotMaxEnrolledSubjects);
  // A relative location risks accidentally putting pilot identity state in a
  // checkout or service working directory. Require an explicitly external path.
  const configured = Boolean(isAbsolute(stateFile) && /^[a-f0-9]{64}$/u.test(bootstrapCodeHash) && /^[a-z0-9][a-z0-9-]{2,80}$/u.test(businessId) && /^sha256:[a-f0-9]{64}$/u.test(identityHash));

  function stateResult() {
    if (!enabled) return { ok: true, state: null };
    if (!configured) return { ok: false, reason: "pilot_config_missing_or_invalid" };
    return readState(stateFile, { businessId, identityHash, maxEnrolledSubjects });
  }

  function isAllowed(channelId, userId) {
    if (!enabled) return true;
    const result = stateResult();
    if (!result.ok) return false;
    const hash = subjectHash(channelId, userId);
    return result.state.allowedSubjectHashes.some((candidate) => safeEqualHex(candidate, hash));
  }

  function authorizeInbound({ channelId, event } = {}) {
    if (!enabled) return { allowed: true, mode: "off" };
    const userId = event?.source?.type === "user" ? String(event.source.userId || "") : "";
    if (!userId) return { allowed: false, reason: "pilot_requires_user_source" };
    const result = stateResult();
    if (!result.ok) return { allowed: false, reason: result.reason };
    const hash = subjectHash(channelId, userId);
    // Bootstrap material is control-plane input, never customer content. This
    // remains suppressed after enrollment and on LINE redelivery.
    if (isEnrollmentCommand(event) && result.state.allowedSubjectHashes.some((candidate) => safeEqualHex(candidate, hash))) {
      return { allowed: false, reason: "enrollment_command_suppressed" };
    }
    if (result.state.allowedSubjectHashes.some((candidate) => safeEqualHex(candidate, hash))) {
      return { allowed: true, mode: "allowlisted" };
    }

    const code = enrollmentCodeFrom(event);
    if (!code && openEnrollment && !isEnrollmentCommand(event)) {
      // ลงทะเบียนอัตโนมัติแล้ว "ปล่อยข้อความแรกผ่านเลย" — ผู้ทดสอบใหม่ต้องได้คำทัก
      // จากลูกแพรทันที ไม่ใช่ความเงียบ (ต่างจากเส้น invite ที่กลืนข้อความโค้ด)
      try {
        return withStateLock(stateFile, () => {
          const current = readState(stateFile, { businessId, identityHash, maxEnrolledSubjects });
          if (!current.ok) return { allowed: false, reason: current.reason };
          if (current.state.allowedSubjectHashes.some((candidate) => safeEqualHex(candidate, hash))) {
            return { allowed: true, mode: "allowlisted" };
          }
          if (current.state.allowedSubjectHashes.length >= maxEnrolledSubjects) {
            return { allowed: false, reason: "pilot_enrollment_cap_reached" };
          }
          const upgraded = upgradeState(current.state);
          const enrolledAt = Number(now());
          writeState(stateFile, {
            ...upgraded,
            allowedSubjectHashes: [...upgraded.allowedSubjectHashes, hash],
            audit: boundedAudit(upgraded.audit, { event: "open_enrollment", at: enrolledAt, subjectHash: hash }),
          });
          // ห้าม log raw userId — ใช้ hash ตัดสั้นเหมือนเส้น invite
          logger.info?.(`pilot: open-enrolled channel=${sha256(channelId).slice(0, 12)} subject=${hash.slice(0, 12)}`);
          return { allowed: true, mode: "open_enrolled" };
        });
      } catch {
        return { allowed: false, reason: "state_file_write_failed" };
      }
    }
    if (!code) return { allowed: false, reason: "not_allowlisted" };
    try {
      return withStateLock(stateFile, () => {
        // Re-read under the cross-process lock. The owner CLI may have created
        // an invite while this webhook was waiting, and a consumed invite must
        // never be reopened by a stale read/write pair.
        const current = readState(stateFile, { businessId, identityHash, maxEnrolledSubjects });
        if (!current.ok) return { allowed: false, reason: current.reason };
        if (current.state.allowedSubjectHashes.some((candidate) => safeEqualHex(candidate, hash))) return { allowed: false, reason: "enrollment_command_suppressed" };
        const enrolledAt = Number(now());
        let state;
        if (current.state.allowedSubjectHashes.length === 0 && current.state.enrollmentUsedAt == null && safeEqualHex(sha256(code), bootstrapCodeHash)) {
          const upgraded = upgradeState(current.state);
          state = { ...upgraded, allowedSubjectHashes: [hash], enrollmentUsedAt: enrolledAt, audit: boundedAudit(upgraded.audit, { event: "first_user_enrolled", at: enrolledAt, subjectHash: hash }) };
        } else if (current.state.version === PILOT_STATE_VERSION && current.state.allowedSubjectHashes.length < maxEnrolledSubjects) {
          const inviteIndex = current.state.invites.findIndex((invite) => invite.consumedAt == null && safeEqualHex(invite.codeSha256, sha256(code)));
          if (inviteIndex < 0) return { allowed: false, reason: "not_allowlisted" };
          const invites = current.state.invites.map((invite, index) => index === inviteIndex ? { ...invite, consumedAt: enrolledAt, consumedSubjectHash: hash } : invite);
          state = { ...current.state, allowedSubjectHashes: [...current.state.allowedSubjectHashes, hash], invites, audit: boundedAudit(current.state.audit, { event: "staff_invite_consumed", at: enrolledAt }) };
        } else return { allowed: false, reason: "not_allowlisted" };
        writeState(stateFile, state);
        // Never log a raw userId, enrollment code, or full subject hash.
        logger.info?.(`pilot: enrolled channel=${sha256(channelId).slice(0, 12)} subject=${hash.slice(0, 12)}`);
        return { allowed: false, enrolled: true, reason: "enrolled_wait_for_next_message" };
      });
    } catch {
      return { allowed: false, reason: "state_file_write_failed" };
    }
  }

  function allowOutbound({ channelId, to } = {}) {
    return isAllowed(channelId || "default", to || "");
  }

  return { enabled, authorizeInbound, allowOutbound, status: stateResult };
}
