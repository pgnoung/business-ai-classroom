// Web Push for authenticated LuKprae operators. V1 deliberately sends an empty
// provider payload: the service worker fetches a privacy-minimal same-origin
// event after waking, so customer text and identity never leave in push bytes.
import { brandText } from "./brand.mjs";
import { createECDH, createHash, createPrivateKey, randomUUID, sign } from "node:crypto";
import { hasOperatorCapability } from "./operatorRoles.mjs";

const BURST_MS = 10_000;
// อายุของเคสที่รอแจ้ง — ตัวนี้กำหนด TTL ที่ส่งให้ผู้ให้บริการด้วย
// 12 ชั่วโมง เพราะ Console จะใช้แทน LINE OA: มือถือที่ไม่มีสัญญาณตอนประชุม
// หรือปิดเครื่องข้ามคืน ต้องยังได้รู้ว่ามีลูกค้ารออยู่เมื่อกลับมาออนไลน์
// ของเดิม 10 นาที = หายไปเลย ซึ่งรับไม่ได้ถ้าจะเลิกใช้ LINE OA
// เคสที่มีคนจริงตอบไปแล้วจะถูกกรองออกตอนดึง ไม่เด้งย้อนหลังให้รำคาญ
const EVENT_TTL_MS = 12 * 60 * 60_000;
// เกินจำนวนนี้ ให้ยุบเป็นข้อความสรุปอันเดียว ไม่ถล่มจอตอนเปิดเครื่องเช้า
const SUMMARY_THRESHOLD = 5;
// เพดานจำนวนเคสที่ดึงมาต่อครั้ง กันคิวรีบานตอนมีลูกค้าค้างเยอะ
const PENDING_LIMIT = 50;
const ENDPOINT_MAX = 4096;

const b64 = (value) => Buffer.from(value).toString("base64url");
const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

function decodedKeys(config) {
  try {
    const publicBytes = Buffer.from(String(config.webPushVapidPublicKey || ""), "base64url");
    const privateBytes = Buffer.from(String(config.webPushVapidPrivateKey || ""), "base64url");
    if (publicBytes.length !== 65 || publicBytes[0] !== 4 || privateBytes.length !== 32) return null;
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(privateBytes);
    if (!publicBytes.equals(ecdh.getPublicKey(undefined, "uncompressed"))) return null;
    const subject = String(config.webPushVapidSubject || "").trim();
    if (!(subject.startsWith("mailto:") || /^https:\/\/[^/]+$/u.test(subject))) return null;
    const x = publicBytes.subarray(1, 33).toString("base64url");
    const y = publicBytes.subarray(33, 65).toString("base64url");
    const privateKey = createPrivateKey({
      key: { kty: "EC", crv: "P-256", x, y, d: privateBytes.toString("base64url") },
      format: "jwk",
    });
    return { publicBytes, privateKey, subject };
  } catch {
    return null;
  }
}

export function validWebPushEndpoint(value) {
  try {
    const raw = String(value || "");
    if (!raw || raw.length > ENDPOINT_MAX) return { ok: false };
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return { ok: false };
    const host = url.hostname.toLowerCase();
    const allowed = host === "fcm.googleapis.com"
      || host === "updates.push.services.mozilla.com"
      || host.endsWith(".push.apple.com");
    return allowed ? { ok: true, endpoint: url.href, origin: url.origin } : { ok: false };
  } catch {
    return { ok: false };
  }
}

function vapidAuthorization(keys, audience, nowMs) {
  const head = b64(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64(JSON.stringify({
    aud: audience,
    exp: Math.floor(nowMs / 1000) + 12 * 60 * 60,
    sub: keys.subject,
  }));
  const input = `${head}.${payload}`;
  const signature = sign("sha256", Buffer.from(input), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return `vapid t=${input}.${signature}, k=${keys.publicBytes.toString("base64url")}`;
}

// 13 ต.ค. 2026 (พี่ง้วง: "ให้เด้งเฉพาะห้องตรวจ หรือข้อความแจ้งเตือนแอดมินใด ๆ"): เลือกได้ต่อบัญชีว่าจะให้มือถือเด้งเรื่องอะไร
//   all    = ทุกแชทใหม่ที่ยังไม่มีคนตอบ (ค่าเดิม — ไม่มีแถว = all) + ห้องตรวจ (เฉพาะ owner)
//   admin  = เฉพาะห้องที่รอคนดูแล (state NEEDS_HUMAN: ขอคุยกับคน · ส่งสลิป/ไฟล์ · ร้องเรียน · จอง/โอน …) + เตือนระบบ + ห้องตรวจ
//   review = เฉพาะห้องตรวจ (รอยืนยันปิด · คิวตรวจแชท 20:00)
export const WEB_PUSH_SCOPES = Object.freeze(["all", "admin", "review"]);
export const webPushScopeKey = (username) => `web_push_scope:${String(username || "")}`;
// ห้องที่ระบบรู้ว่าไม่ใช่ลูกค้า/ไม่ผ่านคัดกรอง ไม่ใช่งานแอดมินแม้สถานะจะเป็น NEEDS_HUMAN
const NOT_ADMIN_OFF_REASONS = new Set(["not_a_customer", "not_qualified"]);

export function createWebPushService({ db, config = {}, fetchImpl = globalThis.fetch, logger = console, now = Date.now } = {}) {
  const keys = decodedKeys(config);
  const available = config.webPushEnabled === true && Boolean(keys) && typeof fetchImpl === "function";
  const timeoutMs = Math.min(30_000, Math.max(1_000, Number(config.webPushTimeoutMs) || 10_000));

  const status = () => ({
    enabled: config.webPushEnabled === true,
    available,
    publicKey: available ? String(config.webPushVapidPublicKey) : "",
  });

  function scopeFor(operatorUsername) {
    try {
      const value = String(db.getSetting?.(webPushScopeKey(operatorUsername)) ?? "").trim();
      return WEB_PUSH_SCOPES.includes(value) ? value : "all";
    } catch {
      return "all"; // อ่านไม่ได้ = แบบเดิม (เด้งเกินดีกว่าเงียบ)
    }
  }

  function setScope(operatorUsername, scope) {
    if (!WEB_PUSH_SCOPES.includes(scope)) return { ok: false, error: "invalid_scope" };
    db.setSetting(webPushScopeKey(operatorUsername), scope);
    return { ok: true, scope };
  }

  // ห้องที่ต้องให้แอดมินดู = สถานะ NEEDS_HUMAN (ไม่นับห้องที่ทีมชี้ว่าไม่ใช่ลูกค้า) · อ่านไม่ได้ = นับว่าใช่ (ไม่ให้งานแอดมินเงียบ)
  function needsAdmin(customerId) {
    try {
      const row = db.getCustomer?.(String(customerId));
      if (!row) return true;
      return row.state === "NEEDS_HUMAN" && !NOT_ADMIN_OFF_REASONS.has(String(row.ai_off_reason || ""));
    } catch {
      return true;
    }
  }

  // เครื่องที่ควรปลุกสำหรับเหตุการณ์ห้องแชทนี้ · force = เตือนระบบ (เทิร์นค้าง ฯลฯ) นับเป็นงานแอดมิน
  function wantsChatEvent(operatorUsername, customerId, force) {
    const scope = scopeFor(operatorUsername);
    if (scope === "all") return true;
    if (scope === "review") return false;
    return force === true || needsAdmin(customerId);
  }

  function statusFor(operatorUsername) {
    let activeDeviceCount = 0;
    try {
      if (available) {
        db.pruneWebPush(now());
        activeDeviceCount = db.activeWebPushSubscriptionCount(operatorUsername, now());
      }
    } catch { activeDeviceCount = 0; }
    return { ...status(), activeDeviceCount, scope: scopeFor(operatorUsername) };
  }

  function subscribe({ operator, endpoint, sessionId, sessionExpiresAt, userAgent = "" }) {
    if (!available) return { ok: false, error: "web_push_unavailable" };
    if (!hasOperatorCapability(operator, "notifications.manage")) {
      return { ok: false, error: "notifications_forbidden" };
    }
    const parsed = validWebPushEndpoint(endpoint);
    if (!parsed.ok) return { ok: false, error: "invalid_endpoint" };
    const exp = Number(sessionExpiresAt);
    if (!sessionId || !Number.isFinite(exp) || exp <= now()) return { ok: false, error: "invalid_session" };
    const saved = db.upsertWebPushSubscription({
      id: randomUUID(), operatorUsername: operator.username,
      endpoint: parsed.endpoint, endpointHash: sha256(parsed.endpoint),
      sessionIdHash: sha256(sessionId), sessionExpiresAt: exp,
      tokenVersion: Number(operator.token_version) || 1,
      userAgent: String(userAgent || "").replace(/[\u0000-\u001F\u007F]/gu, " ").slice(0, 160),
    });
    return { ok: true, id: saved.id };
  }

  // "เครื่องนี้ยังส่งถึงจริงไหม" — ผ่านทุกเงื่อนไขเดียวกับตอนส่งจริง
  function isEndpointActive(operatorUsername, endpoint) {
    if (!available) return false;
    const parsed = validWebPushEndpoint(endpoint);
    if (!parsed.ok) return false;
    try {
      db.pruneWebPush(now());
      const hash = sha256(parsed.endpoint);
      return db.activeWebPushSubscriptions(now())
        .some((row) => row.operator_username === operatorUsername && row.endpoint_hash === hash);
    } catch {
      return false;
    }
  }

  function unsubscribe({ operatorUsername, endpoint }) {
    const parsed = validWebPushEndpoint(endpoint);
    if (!parsed.ok) return { ok: false, error: "invalid_endpoint" };
    return { ok: true, disabled: db.disableWebPushEndpoint(operatorUsername, sha256(parsed.endpoint)) };
  }

  // เปลี่ยนรหัสผ่านตัวเอง = ออก session ใหม่ + เลื่อน token_version ทันที
  // ต้องย้ายเครื่องที่เปิดแจ้งเตือนไว้มาผูกกับชุดใหม่ ไม่งั้นแจ้งเตือนตายถาวรโดยไม่มีใครรู้
  function rebindSession({ operatorUsername, sessionId, sessionExpiresAt, tokenVersion }) {
    if (!sessionId || typeof db.rebindWebPushSessions !== "function") return 0;
    const exp = Number(sessionExpiresAt);
    if (!Number.isFinite(exp) || exp <= now()) return 0;
    try {
      return db.rebindWebPushSessions({
        operatorUsername, sessionIdHash: sha256(sessionId),
        sessionExpiresAt: exp, tokenVersion,
      });
    } catch {
      return 0;
    }
  }

  function disableSession({ operatorUsername, sessionId }) {
    if (!sessionId) return 0;
    return db.disableWebPushSession(operatorUsername, sha256(sessionId));
  }

  async function send(subscription) {
    const parsed = validWebPushEndpoint(subscription.endpoint);
    if (!parsed.ok) {
      db.recordWebPushResult(subscription.id, { status: 0, retire: true });
      return { sent: 0, retired: 1 };
    }
    let response;
    try {
      response = await fetchImpl(parsed.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: vapidAuthorization(keys, parsed.origin, now()),
          // TTL ต้องยาวเท่าอายุของ event ที่มันชี้ไป (EVENT_TTL_MS) ห้ามสั้นกว่า
          // ของเดิมตั้ง 60 วินาที แปลว่ามือถือที่หลับ/ไม่มีสัญญาณนานกว่านั้น
          // ผู้ให้บริการจะ "ทิ้ง" การปลุกไปเลย ไม่มีการส่งซ้ำ และเราเรียก fire()
          // ครั้งเดียวต่อข้อความ → ลูกค้าทักตอนกลางคืนแล้วไม่มีแจ้งเตือนเกิดขึ้นเลย
          TTL: String(Math.floor(EVENT_TTL_MS / 1000)),
          Urgency: "high",
          // Topic คงที่ต่อเครื่อง ไม่ใช่ต่อเหตุการณ์ — การปลุกทุกครั้งทำสิ่งเดียวกัน
          // (ตื่นแล้วไปดึงรายการที่ค้างทั้งหมด) จึงแทนกันได้หมด ถ้าใช้ Topic ไม่ซ้ำ
          // ผู้ให้บริการจะเก็บคิวไว้ทีละหลายอันแล้วอาจทิ้งทั้งกองเมื่อเกินโควตาต่อเครื่อง
          // ค่าคงที่ทำให้เหลือค้างอันเดียวเสมอ และเครื่องสั่นครั้งเดียวตอนกลับมาออนไลน์
          Topic: sha256(subscription.id).slice(0, 24),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      db.recordWebPushResult(subscription.id, { status: 0 });
      logger.debug?.(`web push: provider call failed (${error?.name || "error"})`);
      return { sent: 0, retired: 0 };
    }
    if (response.ok) {
      db.recordWebPushResult(subscription.id, { ok: true, status: response.status });
      return { sent: 1, retired: 0 };
    }
    // 403 = ลายเซ็น VAPID ไม่ตรงกับที่เครื่องสมัครไว้ (เกิดตอนหมุนกุญแจ)
    // ถ้าไม่ปลดออก แถวนี้จะพยายามส่งไปตลอดกาลและ Console ยังนับว่าเครื่องนี้เปิดอยู่
    const retire = response.status === 403 || response.status === 404 || response.status === 410;
    db.recordWebPushResult(subscription.id, { status: response.status, retire });
    return { sent: 0, retired: retire ? 1 : 0 };
  }

  // ปลุกทุกเครื่องที่ยังใช้งานได้ ไม่มีเงื่อนไขกันซ้ำมาขวาง
  // การปลุกซ้ำไม่มีโทษ (payload ว่าง, tag ต่อเคส, ตื่นแล้วดึงรายการใหม่ทั้งชุด)
  // แต่การ "ข้ามการปลุก" มีโทษเสมอ เพราะอันที่ข้ามอาจเป็นอันเดียวที่จะเกิดขึ้น
  async function wakeAll(subscriptions) {
    const results = await Promise.all(subscriptions.map((row) => send(row)));
    return {
      ok: true,
      sent: results.reduce((sum, row) => sum + row.sent, 0),
      retired: results.reduce((sum, row) => sum + row.retired, 0),
    };
  }

  function liveSubscriptions() {
    try {
      db.pruneWebPush(now());
      return db.activeWebPushSubscriptions(now());
    } catch {
      return null;
    }
  }

  async function fire({ customerId, channelId = "default", reason = "inbound", force = false } = {}) {
    if (!available) return { skipped: "disabled" };
    if (!customerId || String(customerId).startsWith("canary:")) return { skipped: "invalid_customer" };
    // 28 ก.ย. 2026: ห้องที่ทีมย้ายไปสแปม (ป้าย null) ทักมากี่ครั้งก็ไม่ปลุกมือถือทีม — ถ้าปลุกแล้ว
    // รายการรอแจ้งว่าง เครื่องจะขึ้นแจ้งเตือนสำรอง "แตะเพื่อเปิด Console" ให้รำคาญเปล่า ๆ (sw.js)
    // อ่านป้ายไม่ได้ = ยังปลุก (ไม่แจ้งเตือนแย่กว่าแจ้งเกินเสมอในระบบนี้)
    try {
      if (db.isSpamCustomer?.(customerId)) return { skipped: "spam" };
    } catch { /* อ่านป้ายพัง = ปลุกตามเดิม */ }
    const live = liveSubscriptions();
    if (live === null) return { skipped: "db_error" };
    if (!live.length) return { skipped: "no_active_subscriptions" };
    // 13 ต.ค.: บัญชีที่เลือกเด้งเฉพาะงานแอดมิน/ห้องตรวจ ไม่ถูกปลุกด้วยแชททั่วไป
    const subscriptions = live.filter((row) => wantsChatEvent(row.operator_username, customerId, force));
    if (!subscriptions.length) return { skipped: "scope_filtered" };
    // แถวนี้เป็นบันทึกว่า "เราพยายามแจ้งแล้ว" ไว้ไล่ย้อนหลังเวลามีปัญหา
    // ไม่ใช่แหล่งความจริงของ "ใครยังรออยู่" อีกต่อไป — อันนั้นมาจากตาราง messages
    // ความล้มเหลวตรงนี้จึงห้ามขวางการปลุกเครื่องเด็ดขาด
    try {
      const bucket = Math.floor(now() / BURST_MS);
      for (const operatorUsername of new Set(subscriptions.map((row) => row.operator_username))) {
        db.queueWebPushEvent({
          id: randomUUID(), operatorUsername, customerId, channelId, reason,
          dedupeKey: sha256(`${operatorUsername}\u0000${reason}\u0000${customerId}\u0000${bucket}`),
          expiresAt: now() + EVENT_TTL_MS,
        });
      }
    } catch { /* บันทึกไม่ได้ก็ยังต้องปลุก */ }
    return wakeAll(subscriptions);
  }

  // ตัวกวาด: การส่งที่ล้มเหลว (502/503/timeout) ไม่มีอะไรลองใหม่ให้เลย
  // ถ้าไม่มีตัวนี้ ลูกค้าที่ทักตอนดึกแล้วบังเอิญเจอ FCM สะดุดครั้งเดียว จะเงียบยาว
  // จนกว่าจะมีลูกค้าคนอื่นทักมา — คืนที่เงียบ ๆ ก็คือไม่มีใครรู้เลยจนเช้า
  // เงื่อนไขปลุกซ้ำ: ยังมีคนรออยู่ และเครื่องนั้นยังไม่เคยส่งสำเร็จหลังข้อความที่เก่าที่สุด
  async function sweep() {
    if (!available) return { skipped: "disabled" };
    const subscriptions = liveSubscriptions();
    if (subscriptions === null) return { skipped: "db_error" };
    if (!subscriptions.length) return { skipped: "no_active_subscriptions" };
    let waiting;
    try {
      waiting = db.unansweredCustomers(now() - EVENT_TTL_MS, PENDING_LIMIT);
    } catch {
      return { skipped: "db_error" };
    }
    if (!waiting.length) return { skipped: "nobody_waiting" };
    // 13 ต.ค.: ปลุกซ้ำตามขอบเขตของแต่ละบัญชี — เด้งเฉพาะห้องตรวจ = ไม่ปลุกซ้ำเรื่องแชท · งานแอดมิน = นับเฉพาะห้องที่รอคนดูแล
    const adminWaiting = waiting.filter((row) => needsAdmin(row.customer_id));
    const stale = subscriptions.filter((row) => {
      const scope = scopeFor(row.operator_username);
      const rows = scope === "all" ? waiting : scope === "admin" ? adminWaiting : [];
      if (!rows.length) return false; // ไม่มีเรื่องในขอบเขตของบัญชีนี้ = ไม่ปลุกซ้ำ
      return Number(row.last_success_at || 0) < (Number(rows[0].last_inbound_at) || 0);
    });
    if (!stale.length) return { skipped: "all_devices_current" };
    return { ...(await wakeAll(stale)), retried: stale.length };
  }

  // 12 ต.ค. 2026 ค่ำ (ห้องตรวจของพี่ง้วง): ปลุกเฉพาะเครื่องของบัญชี owner — ทีม/admin ไม่ถูกปลุก
  // payload ว่างเหมือนเดิม · เครื่องตื่นแล้วดึง /push/pending ซึ่งเติมรายการ "รอยืนยันปิด N ห้อง" ให้ owner เท่านั้น
  // (นับจำนวนอย่างเดียว ไม่มีชื่อ/ข้อความลูกค้า) · แถว web_push_events (customer_id ว่าง) = ตัวบอกว่ามีเรื่องให้แสดง 12 ชม.
  async function notifyOwner({ kind = "close" } = {}) {
    if (!available) return { skipped: "disabled" };
    const reason = `owner_review_${String(kind).replace(/[^a-z]/gu, "").slice(0, 20) || "close"}`;
    let subscriptions;
    try {
      db.pruneWebPush(now());
      subscriptions = db.activeOwnerWebPushSubscriptions(now());
    } catch {
      return { skipped: "db_error" };
    }
    if (!subscriptions.length) return { skipped: "no_owner_device" };
    try {
      const bucket = Math.floor(now() / BURST_MS);
      for (const operatorUsername of new Set(subscriptions.map((row) => row.operator_username))) {
        db.queueWebPushEvent({
          id: randomUUID(), operatorUsername, customerId: "", channelId: "default", reason,
          dedupeKey: sha256(`${operatorUsername}\u0000${reason}\u0000${bucket}`),
          expiresAt: now() + EVENT_TTL_MS,
        });
      }
    } catch { /* บันทึกไม่ได้ก็ยังต้องปลุก */ }
    return wakeAll(subscriptions);
  }

  function fireLater(args) {
    const timer = setTimeout(() => {
      fire(args).catch((error) => logger.debug?.(`web push: ${error?.message || "failed"}`));
    }, 0);
    timer.unref?.();
  }

  // ข้อความบนหน้าจอล็อกต้องไม่มีชื่อลูกค้า ไม่มีเนื้อความ ไม่มีจำนวนเงิน
  // ข้อความบนหน้าจอล็อกต้องไม่มีชื่อลูกค้า ไม่มีเนื้อความ ไม่มีจำนวนเงิน
  // tag ผูกกับ "ห้องแชท" ไม่ใช่กับเหตุการณ์ — ลูกค้าคนเดิมทักซ้ำจึงเขียนทับอันเดิม
  // แทนที่จะกองซ้อนกันเป็นสิบอันของคนเดียว
  function waitingView(row, admin = false) {
    const customerId = String(row.customer_id);
    return {
      id: `waiting-${sha256(`${customerId}\u0000${row.last_inbound_at}`).slice(0, 24)}`,
      title: admin ? "มีห้องรอแอดมินดูแล" : brandText("มีข้อความใหม่ในลูกแพร"),
      body: "แตะเพื่อเปิดห้องแชท",
      url: `/console/#/c/${encodeURIComponent(customerId)}`,
      tag: `lukprae-c-${sha256(customerId).slice(0, 24)}`,
      createdAt: Number(row.last_inbound_at) || 0,
    };
  }

  // "ใครยังรออยู่" อ่านจากตาราง messages ตรง ๆ ไม่ผ่านตารางเหตุการณ์
  // เหตุผล: messages ถูกบันทึกในธุรกรรมเดียวกับข้อความลูกค้า จึงไม่มีทางหาย
  // แม้เครื่องจะถูกรีสตาร์ทระหว่างนั้น และไม่ต้องมีใครคอยล้างแถวให้ถูกจังหวะ
  // รายการนี้ "หด" เองเมื่อมีคนจริงตอบ และ "โต" เองเมื่อลูกค้าทักมาใหม่
  function pendingListFor(operatorUsername) {
    if (!available) return [];
    let rows;
    try {
      rows = db.unansweredCustomers(now() - EVENT_TTL_MS, PENDING_LIMIT);
    } catch {
      return [];
    }
    const scope = scopeFor(operatorUsername);
    if (scope === "review") return [];
    if (scope === "admin") rows = rows.filter((row) => needsAdmin(row.customer_id));
    if (!rows.length) return [];
    const admin = scope === "admin";
    if (rows.length <= SUMMARY_THRESHOLD) return rows.map((row) => waitingView(row, admin));
    // เปิดเครื่องตอนเช้าแล้วเจอ 20 การแจ้งเตือนพร้อมกันคือใช้งานไม่ได้จริง
    // ยุบเป็นอันเดียวที่บอกจำนวน แล้วพาไปหน้ารวมให้ไล่เอง — ไม่มีเคสไหนหาย
    // เพราะทุกเคสยังอยู่ในหน้ารวมและยังนับอยู่ในตัวเลขนี้จนกว่าจะมีคนตอบ
    const newest = rows[rows.length - 1];
    return [{
      id: `summary-${rows.length}-${newest.last_inbound_at}`,
      title: admin ? "มีห้องรอแอดมินดูแล" : brandText("มีลูกค้ารอในลูกแพร"),
      body: `${rows.length} เคสที่ยังไม่มีใครตอบ — แตะเพื่อเปิดรายการ`,
      url: "/console/#/",
      tag: "lukprae-summary",
      createdAt: Number(newest.last_inbound_at) || 0,
    }];
  }

  // คงรูปแบบเดิมไว้ให้ service worker รุ่นก่อนที่ยังค้างบนเครื่องอ่านได้
  function pendingFor(operatorUsername) {
    const list = pendingListFor(operatorUsername);
    return list.length ? list[list.length - 1] : null;
  }

  return { status, statusFor, scopeFor, setScope, subscribe, unsubscribe, isEndpointActive, disableSession, rebindSession, fire, fireLater, sweep, pendingFor, pendingListFor, notifyOwner };
}
