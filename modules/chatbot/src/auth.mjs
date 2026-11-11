// auth.mjs — auth ของ Operator Console (G1b) แบบ zero-dep
//
// องค์ประกอบ (รายละเอียด threat model ใน AUTH_DESIGN.md):
// 1. รหัสผ่าน: scrypt (node:crypto) เก็บเป็น scrypt$N$r$p$salt$hash — ไม่มี plaintext ทุกกรณี
// 2. session: cookie HttpOnly ลงลายเซ็น HMAC-SHA256 ด้วย CONSOLE_SESSION_SECRET
//    payload = { u, sid, iat, exp } อายุ default 7 วัน — stateless ฝั่ง server
// 3. CSRF: token ผูกกับ sid (HMAC จาก secret เดียวกัน) — mutating POST ต้องส่ง x-csrf-token
// 4. rate limit login: ตัวนับใน memory ต่อ key (username / ip) — เกินโควตา = ล็อกชั่วคราว
// กติกา fail-closed: parse/verify พังทุกแบบ = ปฏิเสธ ไม่มีทาง "เดาว่าผ่าน"
import { scryptSync, randomBytes, randomUUID, timingSafeEqual, createHmac } from "node:crypto";

/* ------------------------------- password hash ----------------------------- */

// ค่าแนะนำ OWASP สำหรับ scrypt interactive login (N=2^15 หนักไป ~100ms/ครั้งบนเครื่องเล็ก
// จึงใช้ 2^14 + r=8 — ยังแพงพอกัน offline brute force ในสเกลธุรกิจนี้)
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

export function hashPassword(password) {
  const pass = String(password ?? "");
  if (!pass) throw new Error("password ว่างไม่ได้");
  const salt = randomBytes(16);
  const hash = scryptSync(pass, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [, nStr, rStr, pStr, saltB64, hashB64] = parts;
    const N = Number(nStr), r = Number(rStr), p = Number(pStr);
    if (![N, r, p].every((v) => Number.isInteger(v) && v > 0)) return false;
    const salt = Buffer.from(saltB64, "base64");
    const expected = Buffer.from(hashB64, "base64");
    if (salt.length < 8 || expected.length < 16) return false;
    const actual = scryptSync(String(password ?? ""), salt, expected.length, { N, r, p, maxmem: 128 * 1024 * 1024 });
    return timingSafeEqual(actual, expected);
  } catch {
    return false; // format พัง/พารามิเตอร์เพี้ยน = ปฏิเสธ
  }
}

/* --------------------------------- sessions -------------------------------- */

export const SESSION_COOKIE = "chassis_session";
const TOKEN_VERSION = "v1";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function hmac(secret, value) {
  return createHmac("sha256", secret).update(value).digest();
}

export function createSessions({ secret, ttlMs = 7 * 24 * 60 * 60 * 1000, now = Date.now }) {
  if (!secret) throw new Error("createSessions ต้องมี secret (fail-closed)");

  function sign(payloadB64) {
    return b64url(hmac(secret, `${TOKEN_VERSION}.${payloadB64}`));
  }

  // ออก session ใหม่ — คืน token + csrf token คู่กัน
  // M1: v = token_version ของ operator ณ ตอนออก token — เปลี่ยนรหัสผ่านจะ bump เวอร์ชัน
  // ทำให้ token เก่าทุกใบ (เวอร์ชันเดิม) ถูกปฏิเสธที่ currentSession โดยไม่ต้องมี session store
  function issue(username, { at = now(), tokenVersion = 1 } = {}) {
    const sid = randomUUID();
    const payload = { u: String(username), sid, iat: at, exp: at + ttlMs, v: Number(tokenVersion) || 1 };
    const payloadB64 = b64url(JSON.stringify(payload));
    const token = `${TOKEN_VERSION}.${payloadB64}.${sign(payloadB64)}`;
    return { token, csrf: csrfFor(sid), ...payload };
  }

  // คืน payload เมื่อ (1) ลายเซ็นตรงแบบ timing-safe (2) ยังไม่หมดอายุ — นอกนั้น null
  function verify(token) {
    try {
      const parts = String(token || "").split(".");
      if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
      const [, payloadB64, sig] = parts;
      const expected = Buffer.from(sign(payloadB64), "utf8");
      const actual = Buffer.from(String(sig), "utf8");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
      const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
      if (typeof payload?.u !== "string" || typeof payload?.sid !== "string") return null;
      if (typeof payload.exp !== "number" || payload.exp <= now()) return null; // หมดอายุ
      return payload;
    } catch {
      return null;
    }
  }

  // CSRF token ผูกกับ sid — stateless double-submit: client ได้จาก /me แล้วส่งกลับใน header
  function csrfFor(sid) {
    return b64url(hmac(secret, `csrf.${sid}`));
  }

  function verifyCsrf(sid, token) {
    try {
      const expected = Buffer.from(csrfFor(sid), "utf8");
      const actual = Buffer.from(String(token || ""), "utf8");
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
      return false;
    }
  }

  return { issue, verify, csrfFor, verifyCsrf, ttlMs };
}

/* --------------------------------- cookies --------------------------------- */

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx < 1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

// 2026-09-02: Strict → Lax เพราะกดลิงก์ห้องแชทจากแอป LINE แล้วคุกกี้ไม่ถูกแนบ
// ทีมงานจึงเจอหน้า login ทุกครั้ง Lax แนบคุกกี้เฉพาะการกดลิงก์ (GET ระดับบนสุด)
// ส่วน POST ข้ามเว็บยังไม่แนบเหมือนเดิม + มี CSRF token และด่าน Origin ซ้อนอีกชั้น
// ห้ามใช้ SameSite=None เด็ดขาด (นั่นคือแนบคุกกี้ให้ทุกเว็บ)
export function sessionCookie(token, { ttlMs, secure = false } = {}) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/console",
    "SameSite=Lax",
    `Max-Age=${Math.floor((ttlMs ?? 0) / 1000)}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie({ secure = false } = {}) {
  const attrs = [`${SESSION_COOKIE}=`, "HttpOnly", "Path=/console", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

/* ------------------------------ login limiter ------------------------------ */

// ตัวนับใน memory (รีเซ็ตเมื่อ restart — ยอมรับได้เพราะ scrypt ทำ brute force ช้าอยู่แล้ว)
export function createLoginLimiter({ maxFails = 5, windowMs = 15 * 60_000, now = Date.now } = {}) {
  const buckets = new Map(); // key -> { fails, firstAt }

  function bucket(key) {
    const k = String(key);
    const b = buckets.get(k);
    if (b && now() - b.firstAt > windowMs) {
      buckets.delete(k); // window เก่าหมดอายุ
      return null;
    }
    return b ?? null;
  }

  return {
    // ล็อกอยู่ไหม — เรียกก่อน verify ทุกครั้ง
    isLocked(key) {
      const b = bucket(key);
      if (!b || b.fails < maxFails) return { locked: false };
      return { locked: true, retryAfterMs: Math.max(0, b.firstAt + windowMs - now()) };
    },
    fail(key) {
      const k = String(key);
      const b = bucket(k);
      if (b) b.fails += 1;
      else buckets.set(k, { fails: 1, firstAt: now() });
    },
    clear(key) {
      buckets.delete(String(key));
    },
  };
}

/* ------------------------------ operator seed ------------------------------ */

// OPERATOR_SEED="username:password" — ใช้ bootstrap บัญชีแรกเท่านั้น
// (มีบัญชีอยู่แล้ว = ข้าม ไม่ทับรหัสเดิม) — hash ทันที ไม่ log และไม่เก็บ plaintext
export function seedOperators({ db, seed, logger = console }) {
  const raw = String(seed || "").trim();
  if (!raw) return { seeded: 0 };
  let seeded = 0;
  for (const entry of raw.split(",")) {
    const idx = entry.indexOf(":");
    if (idx < 1) continue;
    const username = entry.slice(0, idx).trim();
    const password = entry.slice(idx + 1).trim();
    if (!username || password.length < 8) {
      logger.warn?.(`auth: seed "${username || "?"}" ถูกข้าม (รหัสต้องยาว >= 8 ตัวอักษร)`);
      continue;
    }
    if (db.getOperator(username)) continue; // ไม่ทับบัญชีเดิม
    // บัญชีแรกเป็น owner เพื่อ bootstrap permission ได้; บัญชีถัดไป fail-closed เป็น operator
    const role = db.countOperators() === 0 ? "owner" : "operator";
    db.createOperator({ username, passHash: hashPassword(password), displayName: username, role });
    seeded += 1;
    logger.log?.(`auth: seed operator "${username}" แล้ว (เก็บเฉพาะ scrypt hash)`);
  }
  return { seeded };
}
