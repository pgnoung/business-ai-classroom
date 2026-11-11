// auth — scrypt hash, session HMAC + expiry, CSRF, rate limiter, operator seed
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hashPassword, verifyPassword, createSessions, parseCookies,
  sessionCookie, clearSessionCookie, createLoginLimiter, seedOperators, SESSION_COOKIE,
} from "../src/auth.mjs";
import { openDb } from "../src/db.mjs";
import { poisonGlobalFetch, memoryDb } from "./helpers.mjs";

poisonGlobalFetch();

const silent = { log: () => {}, warn: () => {}, error: () => {} };
const SECRET = "test-session-secret-0123456789";

/* ------------------------------ password hash ------------------------------ */

test("password: hash เป็น scrypt$... และ verify ถูก/ผิดได้ตรง", () => {
  const stored = hashPassword("รหัสลับ-mypass-123");
  assert.ok(stored.startsWith("scrypt$"));
  assert.ok(!stored.includes("รหัสลับ-mypass-123"), "ห้ามมี plaintext ใน hash");
  assert.equal(verifyPassword("รหัสลับ-mypass-123", stored), true);
  assert.equal(verifyPassword("รหัสผิด", stored), false);
});

test("password: hash สองครั้งได้ค่าไม่ซ้ำ (random salt)", () => {
  assert.notEqual(hashPassword("same-pass"), hashPassword("same-pass"));
});

test("password: stored format พัง/ว่าง -> false เสมอ (fail-closed)", () => {
  assert.equal(verifyPassword("x", ""), false);
  assert.equal(verifyPassword("x", null), false);
  assert.equal(verifyPassword("x", "plaintext-not-hash"), false);
  assert.equal(verifyPassword("x", "scrypt$abc$8$1$c2FsdA==$aGFzaA=="), false); // N ไม่ใช่เลข
  assert.equal(verifyPassword("x", "bcrypt$10$whatever"), false);
});

test("password: ว่าง hash ไม่ได้", () => {
  assert.throws(() => hashPassword(""));
});

/* --------------------------------- sessions -------------------------------- */

test("session: issue -> verify ครบวงจร + csrf ผูกกับ sid", () => {
  const sessions = createSessions({ secret: SECRET });
  const s = sessions.issue("nok");
  const payload = sessions.verify(s.token);
  assert.equal(payload.u, "nok");
  assert.equal(payload.sid, s.sid);
  assert.equal(sessions.verifyCsrf(s.sid, s.csrf), true);
  assert.equal(sessions.verifyCsrf(s.sid, "forged-token"), false);
  assert.equal(sessions.verifyCsrf("other-sid", s.csrf), false);
});

test("session: token ถูกแก้ -> null", () => {
  const sessions = createSessions({ secret: SECRET });
  const { token } = sessions.issue("nok");
  const [v, payload, sig] = token.split(".");
  // แก้ payload ให้เป็น user อื่นแต่ใช้ sig เดิม
  const forged = Buffer.from(JSON.stringify({ u: "admin", sid: "x", iat: 0, exp: Date.now() + 9e9 })).toString("base64url");
  assert.equal(sessions.verify(`${v}.${forged}.${sig}`), null);
  assert.equal(sessions.verify(`${v}.${payload}.AAAA${sig.slice(4)}`), null);
  assert.equal(sessions.verify("garbage"), null);
  assert.equal(sessions.verify(""), null);
});

test("session: หมดอายุ -> null (7 วัน default, เทสต์ใช้ ttl สั้น)", () => {
  let clock = 1_000_000;
  const sessions = createSessions({ secret: SECRET, ttlMs: 1000, now: () => clock });
  const { token } = sessions.issue("nok");
  assert.ok(sessions.verify(token), "ยังไม่หมดอายุต้องผ่าน");
  clock += 1001;
  assert.equal(sessions.verify(token), null, "เกิน ttl ต้องปฏิเสธ");
});

test("session: คนละ secret verify กันไม่ได้", () => {
  const a = createSessions({ secret: "secret-a" });
  const b = createSessions({ secret: "secret-b" });
  assert.equal(b.verify(a.issue("nok").token), null);
});

test("session: ไม่มี secret = สร้างไม่ได้ (fail-closed)", () => {
  assert.throws(() => createSessions({ secret: "" }));
});

/* --------------------------------- cookies --------------------------------- */

test("cookie: sessionCookie มี HttpOnly + SameSite=Lax + Path=/console", () => {
  const c = sessionCookie("tok123", { ttlMs: 7 * 86400_000 });
  assert.ok(c.startsWith(`${SESSION_COOKIE}=tok123`));
  assert.ok(c.includes("HttpOnly"));
  assert.ok(c.includes("SameSite=Lax"));
  assert.ok(c.includes("Path=/console"));
  assert.ok(c.includes("Max-Age=604800"));
  assert.ok(!c.includes("Secure"), "default ไม่บังคับ Secure (local dev)");
  assert.ok(sessionCookie("t", { ttlMs: 1000, secure: true }).includes("Secure"));
  assert.ok(clearSessionCookie().includes("Max-Age=0"));
});

test("cookie: parseCookies แยกค่าถูกและทนรูปแบบเพี้ยน", () => {
  const parsed = parseCookies(`a=1; ${SESSION_COOKIE}=tok.x.y; junk; =bad; b=2`);
  assert.equal(parsed[SESSION_COOKIE], "tok.x.y");
  assert.equal(parsed.a, "1");
  assert.equal(parsed.b, "2");
  assert.deepEqual(parseCookies(undefined), {});
});

/* ------------------------------ login limiter ------------------------------ */

test("limiter: ผิดครบ 5 ครั้ง = ล็อก, clear ปลดได้", () => {
  let clock = 0;
  const limiter = createLoginLimiter({ maxFails: 5, windowMs: 60_000, now: () => clock });
  for (let i = 0; i < 4; i += 1) limiter.fail("u:nok");
  assert.equal(limiter.isLocked("u:nok").locked, false, "4 ครั้งยังไม่ล็อก");
  limiter.fail("u:nok");
  const lock = limiter.isLocked("u:nok");
  assert.equal(lock.locked, true);
  assert.ok(lock.retryAfterMs > 0);
  assert.equal(limiter.isLocked("u:other").locked, false, "key อื่นไม่โดนหางเลข");
  limiter.clear("u:nok");
  assert.equal(limiter.isLocked("u:nok").locked, false);
});

test("limiter: พ้น window แล้วปลดล็อกเอง", () => {
  let clock = 0;
  const limiter = createLoginLimiter({ maxFails: 2, windowMs: 1000, now: () => clock });
  limiter.fail("k");
  limiter.fail("k");
  assert.equal(limiter.isLocked("k").locked, true);
  clock = 1500;
  assert.equal(limiter.isLocked("k").locked, false);
});

/* ------------------------------ operator seed ------------------------------ */

test("seed: สร้างบัญชีจาก OPERATOR_SEED — hash เท่านั้น ไม่ทับบัญชีเดิม", () => {
  const db = memoryDb();
  const r1 = seedOperators({ db, seed: "nok:password-123", logger: silent });
  assert.equal(r1.seeded, 1);
  const op = db.getOperator("nok");
  assert.equal(op.role, "owner", "บัญชี bootstrap แรกต้องจัด permission ต่อได้");
  assert.ok(op.pass_hash.startsWith("scrypt$"));
  assert.ok(!op.pass_hash.includes("password-123"));
  assert.equal(verifyPassword("password-123", op.pass_hash), true);

  // seed ซ้ำด้วยรหัสใหม่ -> ข้าม ไม่ทับรหัสเดิม
  const r2 = seedOperators({ db, seed: "nok:new-password-9", logger: silent });
  assert.equal(r2.seeded, 0);
  assert.equal(verifyPassword("password-123", db.getOperator("nok").pass_hash), true);
  db.close();
});

test("seed: รหัสสั้นกว่า 8 ตัว/รูปแบบพัง = ข้าม, หลายบัญชีคั่นด้วย comma", () => {
  const db = memoryDb();
  const r = seedOperators({ db, seed: "a:short,ok1:long-enough-1,broken-entry,ok2:long-enough-2", logger: silent });
  assert.equal(r.seeded, 2);
  assert.equal(db.getOperator("a"), null);
  assert.ok(db.getOperator("ok1"));
  assert.ok(db.getOperator("ok2"));
  assert.equal(db.getOperator("ok1").role, "owner");
  assert.equal(db.getOperator("ok2").role, "operator");
  assert.equal(db.countOperators(), 2);
  assert.deepEqual(seedOperators({ db, seed: "" , logger: silent }), { seeded: 0 });
  db.close();
});

test("permission migration: DB เดิมที่ยังไม่มี owner โปรโมตบัญชีเก่าสุดเพียงคนเดียว", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "afl-owner-migration-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "legacy.sqlite");
  let clock = 1;
  const first = openDb({ file, now: () => clock });
  first.createOperator({ username: "first", passHash: "test-hash", role: "operator" });
  clock = 2;
  first.createOperator({ username: "second", passHash: "test-hash", role: "operator" });
  first.close();

  const reopened = openDb({ file, now: () => 3 });
  assert.equal(reopened.getOperator("first").role, "owner");
  assert.equal(reopened.getOperator("second").role, "operator");
  reopened.close();
});
