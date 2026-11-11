// config.mjs — โหลด env + ตรวจความพร้อมตอน start
//
// หลัก fail-closed (SPEC ข้อ 3):
// - ไม่มี DASHBOARD_API_KEY  -> ไม่เสิร์ฟ /api/* (503)
// - ไม่มี LINE_CHANNEL_SECRET -> ไม่รับ /webhooks/line (503)
// - LINE_LIVE_SEND default = false -> ไม่มีการยิง LINE จริงจนกว่าจะเปิดเอง
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeHttpsOrigin } from "./messageMedia.mjs";
import { brandFromEnv } from "./brand.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = join(HERE, "..");

// Console branding is deliberately presentation-only. Keep this small, bounded
// and separate from BRAND_PACK so an instance cannot accidentally expose prompt
// content or other operational configuration through the public console shell.
// "starter" = ธีมกลางสะอาด ๆ สำหรับร้านที่ติดตั้งเอนจินเอง (white-label) — ค่าเริ่มต้นยังเป็น airdog เหมือนเดิม
const CONSOLE_THEMES = new Set(["airdog", "pngoung", "lukprae", "starter"]);
// Same grammar as configured multi-OA ids. Training controls are a narrow
// capability: malformed values never widen access, and "canary" is not a
// provider channel a real webhook may use.
// เพดานอายุสิทธิ์เข้าถึงสื่อขาออก — ยาวพอที่ลูกค้าจะเลื่อนกลับมาดูรูปเก่าได้เสมอ
// เหตุผลเต็มอยู่ตรงจุดที่ใช้ค่านี้ (outboundImageLinkTtlMs / outboundFileLinkTtlMs)
export const OUTBOUND_LINK_TTL_CAP_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const CHANNEL_ID_RE = /^[a-zA-Z0-9_-]{1,50}$/;
const RESERVED_CHANNEL_IDS = new Set(["canary"]);
const DEFAULT_CONSOLE_BRANDING = Object.freeze({
  name: "Front Desk",
  mark: "FD",
  agent: "",
  theme: "airdog",
});

function safeBrandText(value, fallback, maxLength) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim();
  // Controls, markup delimiters and overlong values are configuration errors;
  // fail safe to the stable default instead of truncating a surprising label.
  if (!text || text.length > maxLength || /[\u0000-\u001F\u007F<>]/.test(text)) return fallback;
  return text;
}

// ทางอ่านสมองของ runtime (แบบแปลน §11 P2) — enum ปิด ไม่ใช่ flag
// ค่าที่พิมพ์ผิด ("version", "true", "on") ต้องดังตอนบูต ไม่ใช่ตกไปเป็น legacy เงียบ ๆ
// แล้วเจ้าของเชื่อว่าเปิดสมองไปแล้วทั้งที่ยังอ่านตารางเดิมอยู่ (คลาสความล้มเหลว C4)
export const BRAIN_READ_LEGACY = "legacy";
export const BRAIN_READ_VERSIONED = "versioned";
export const BRAIN_READ_MODES = Object.freeze([BRAIN_READ_LEGACY, BRAIN_READ_VERSIONED]);

export const BRAIN_GATES_OFF = "";
export const BRAIN_GATES_OFFLINE = "offline";
export const BRAIN_GATES_HEAVY = "heavy";
export const BRAIN_GATES_MODES = Object.freeze([BRAIN_GATES_OFFLINE, BRAIN_GATES_HEAVY]);

/**
 * โหมดของบันไดด่านที่แพงกว่า ms — ปฏิเสธค่าที่ไม่รู้จัก **เสียงดัง** เหมือน BRAIN_READ
 *
 * ทำไมห้ามเงียบ: เดิมค่าที่ไม่รู้จักถูกปัดเป็น "ปิด" เงียบ ๆ แปลว่าพิมพ์ "HEAVY" หรือ
 * "offline " (มีช่องว่างท้าย) ลงไฟล์ env แล้วเจ้าของเชื่อว่าตาข่ายเปิดอยู่ ทั้งที่ไม่มีอะไรทำงาน
 * — ด่านที่ถูกปิดโดยที่คนคิดว่าเปิด แย่กว่าด่านที่ปิดแล้วบอกว่าปิด
 */
export function brainGatesMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "") return BRAIN_GATES_OFF;
  if (!BRAIN_GATES_MODES.includes(mode)) {
    throw new Error(
      `BRAIN_GATES ต้องเป็น ${BRAIN_GATES_MODES.join(" หรือ ")} หรือเว้นว่าง เท่านั้น (ได้ "${value}")`
    );
  }
  return mode;
}

export function brainReadMode(value) {
  const mode = String(value ?? "").trim().toLowerCase();
  if (mode === "") return BRAIN_READ_LEGACY;
  if (!BRAIN_READ_MODES.includes(mode)) {
    throw new Error(
      `BRAIN_READ ต้องเป็น ${BRAIN_READ_MODES.join(" หรือ ")} เท่านั้น (ได้ "${value}")`
    );
  }
  return mode;
}

export function trainingCommandChannels(value) {
  return [...new Set(String(value || "").split(",")
    .map((item) => item.trim())
    .filter((id) => CHANNEL_ID_RE.test(id) && !RESERVED_CHANNEL_IDS.has(id.toLowerCase())))];
}

export function consoleBranding(source = {}) {
  const theme = String(source.CONSOLE_BRAND_THEME || "").trim().toLowerCase();
  return {
    name: safeBrandText(source.CONSOLE_BRAND_NAME, DEFAULT_CONSOLE_BRANDING.name, 60),
    mark: safeBrandText(source.CONSOLE_BRAND_MARK, DEFAULT_CONSOLE_BRANDING.mark, 12),
    // CONSOLE_BRAND_AGENT ไม่ได้ตั้ง = ใช้ BRAND_AGENT_NAME เฉพาะเมื่อ "ตั้งไว้จริง" เท่านั้น
    // (ไม่ตั้งทั้งคู่ = "" เหมือนเดิมทุกตัวอักษร — production ไม่เปลี่ยน)
    agent: safeBrandText(source.CONSOLE_BRAND_AGENT,
      safeBrandText(source.BRAND_AGENT_NAME, DEFAULT_CONSOLE_BRANDING.agent, 60), 60),
    theme: CONSOLE_THEMES.has(theme) ? theme : DEFAULT_CONSOLE_BRANDING.theme,
    // โปรไฟล์ generic เท่านั้นที่มีคีย์เพิ่ม — course (ค่าเริ่มต้น) รูปทรงเดิม 4 คีย์ทุกตัวอักษร
    ...genericBrandingFields(source),
  };
}

function genericBrandingFields(source) {
  const brand = brandFromEnv(source);
  if (brand.profile !== "generic") return {};
  return {
    profile: brand.profile,
    agentName: brand.agentName,
    ownerName: brand.ownerName,
    businessName: brand.businessName,
  };
}

function parseEnvFile(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// .env.local ชนะ .env และ process.env ชนะทั้งคู่ — ทั้งสองไฟล์อยู่ใน .gitignore
export function defaultEnvSource() {
  // Isolated instances can opt out of the shared chassis .env/.env.local files.
  // This must be decided from the real process environment before either file is
  // read, otherwise a second business could inherit the first business's secrets.
  if (/^(?:1|true)$/iu.test(String(process.env.CHASSIS_SKIP_ENV_FILES || ""))) {
    return { ...process.env };
  }
  return {
    ...parseEnvFile(join(APP_ROOT, ".env")),
    ...parseEnvFile(join(APP_ROOT, ".env.local")),
    ...process.env,
  };
}

// สร้าง config จาก source ที่กำหนด (เทสต์ส่ง object ตรง ๆ ได้ ไม่แตะ env จริง)
export function createConfig(source = defaultEnvSource()) {
  const env = (key, fallback = "") => {
    const v = source[key];
    return v === undefined || v === "" ? fallback : String(v);
  };
  const flag = (key, def = false) => {
    const v = env(key, def ? "true" : "false").toLowerCase();
    return v === "true" || v === "1";
  };
  const num = (key, def) => {
    const n = Number(env(key, String(def)));
    return Number.isFinite(n) && n >= 0 ? n : def;
  };

  const dataDir = env("DATA_DIR", join(APP_ROOT, "data"));
  // ต้องรู้ก่อนสร้าง object เพราะทางอ่านสมองบังคับเปิดตัวเฝ้าสมองเงาไปด้วย (ดู brainShadowParity)
  const brainRead = brainReadMode(env("BRAIN_READ", "legacy"));
  const config = {
    port: num("PORT", 4850),
    // ว่าง = รักษาพฤติกรรมเดิมของ Node (ทุก interface). Instance ที่เป็น local
    // mock ต้องตั้ง 127.0.0.1 ชัดเจนเพื่อไม่เปิด console ออก LAN โดยไม่ตั้งใจ
    bindHost: env("BIND_HOST"),
    dataDir,
    dbFile: env("DB_FILE", join(dataDir, "chassis.sqlite")),

    // LINE
    lineChannelSecret: env("LINE_CHANNEL_SECRET"),
    lineChannelAccessToken: env("LINE_CHANNEL_ACCESS_TOKEN"),
    // Display-only label for legacy single-channel mode. Provider identity is
    // still established separately; this value never proves an OA binding.
    lineChannelName: safeBrandText(source.LINE_CHANNEL_NAME, "", 100),
    lineMockUrl: env("LINE_MOCK_URL"),
    lineLiveSend: flag("LINE_LIVE_SEND", false), // fail-closed: ต้องเปิดเองเท่านั้น
    lineTimeoutMs: num("LINE_TIMEOUT_MS", 15000),

    // Facebook Messenger (v1.5 — ช่องทางที่สอง, คำสั่งเจ้าของ 2026-08-30)
    // fail-closed ทุกชั้นเหมือน LINE: FB_ENABLED เปิด channel, FB_LIVE_SEND เปิดยิงจริง
    // โทเคน/secret ทางหลักคือกรอกในคอนโซล (เก็บใน DB settings — เปลี่ยนได้ไม่ต้อง restart)
    // env ด้านล่างเป็น bootstrap/override สำหรับเทสต์และกู้ระบบ
    fbEnabled: flag("FB_ENABLED", false),
    fbPageAccessToken: env("FB_PAGE_ACCESS_TOKEN"),
    fbAppSecret: env("FB_APP_SECRET"),
    fbVerifyToken: env("FB_VERIFY_TOKEN"),
    fbMockUrl: env("FB_MOCK_URL"),
    fbLiveSend: flag("FB_LIVE_SEND", false),
    fbApiVersion: env("FB_API_VERSION", "v24.0"),
    // Public webhook reads raw bytes before HMAC; bound slow/incomplete bodies so
    // unauthenticated clients cannot hold connections indefinitely.
    lineWebhookBodyTimeoutMs: Math.max(1_000, num("LINE_WEBHOOK_BODY_TIMEOUT_MS", 15000)),
    // Narrow test-user pilot. Off by default. When on, a 0600 JSON state file and
    // a SHA-256 bootstrap code from a secret source are both mandatory.
    linePilotMode: flag("LINE_PILOT_MODE", false),
    linePilotAllowlistFile: env("LINE_PILOT_ALLOWLIST_FILE"),
    linePilotBootstrapCodeSha256: env("LINE_PILOT_BOOTSTRAP_CODE_SHA256", "").toLowerCase(),
    // The one-user pilot state is additionally bound to this business and to
    // the provider-readback identity that the launcher pinned before start.
    // These are control-plane values, not customer supplied values.
    linePilotBusinessId: env("LINE_PILOT_BUSINESS_ID", "").trim(),
    linePilotIdentityHash: env("LINE_PILOT_IDENTITY_HASH", "").toLowerCase(),
    // Bounded internal training roster. Invalid values deliberately fall back
    // to the source-reviewed ceiling in pilotGate rather than widening access.
    linePilotMaxEnrolledSubjects: num("LINE_PILOT_MAX_ENROLLED_SUBJECTS", 25),
    // v1.4.7 (คำสั่งพี่ง้วง 2026-08-16): เปิดให้ทุกคนที่ add OA ลงทะเบียนอัตโนมัติ
    // ในข้อความแรก (จนถึงเพดาน) — fail-closed default false; ขาออกยังจำกัดรายชื่อเดิม
    linePilotOpenEnrollment: flag("LINE_PILOT_OPEN_ENROLLMENT", false),

    // Whole HTTP server ceilings cover console/API routes too. Endpoint-specific
    // limits (webhook/media upload) remain stricter where needed.
    httpRequestTimeoutMs: Math.max(1_000, num("HTTP_REQUEST_TIMEOUT_MS", 60000)),
    httpHeadersTimeoutMs: Math.max(1_000, num("HTTP_HEADERS_TIMEOUT_MS", 15000)),

    // Multi-OA (หลายสาขาของธุรกิจเดียวกัน): ไฟล์ JSON [{id,name,channelSecret,
    // channelAccessToken,active}] chmod 600 นอก git — ไม่ตั้ง = โหมด legacy channel
    // เดียว "default" จาก LINE_CHANNEL_SECRET/TOKEN ด้านบน (ดู src/channels.mjs)
    channelsFile: env("CHANNELS_FILE"),

    // Hermes (stateless drafting engine — /chat/completions เท่านั้น ห้าม /v1/responses)
    hermesBase: env("HERMES_BASE"),
    hermesApiKey: env("HERMES_API_KEY"),
    hermesModel: env("HERMES_MODEL", "gpt-5.6-sol"),
    // v1.4.48: จำแนกรูปก่อนตัดสินว่าเป็นเรื่องเงิน — ปิดโดยค่าเริ่มต้นโดยตั้งใจ
    // วันที่เปิดคือวันแรกที่รูปของลูกค้า (รวมสลิปที่มีเลขบัญชี/ยอดเงิน) ออกไปที่ผู้ให้บริการโมเดล
    // จึงให้เป็นการกดเปิดเอง ไม่ติดไปกับ deploy เงียบ ๆ
    // v1.4.49: ฐาน URL ของคอนโซล — ใส่แล้วข้อความแจ้งเตือน LINE จะมีลิงก์กดเข้าห้องแชทตรง ๆ
    consolePublicBaseUrl: env("CONSOLE_PUBLIC_BASE_URL", "").replace(/\/+$/, ""),
    imageClassifyEnabled: flag("IMAGE_CLASSIFY_ENABLED", false),
    imageClassifyModel: env("IMAGE_CLASSIFY_MODEL", ""),
    // 2026-10-01: ตัวหลักล้มชั่วคราว (HTTP 5xx/429/หมดเวลา) → ลองซ้ำด้วยรุ่นนี้หนึ่งครั้ง · ว่าง = ไม่ลองซ้ำ (พฤติกรรมเดิม)
    imageClassifyFallbackModel: env("IMAGE_CLASSIFY_FALLBACK_MODEL", "").trim(),
    // รอไฟล์ดาวน์โหลดจาก LINE ให้เสร็จก่อนจำแนก — สั้นกว่า BURST_DEBOUNCE_MS เสมอ
    // เพื่อไม่ให้ไปกินเวลาที่ระบบใช้รอลูกค้าพิมพ์จบ
    imageClassifyWaitMs: num("IMAGE_CLASSIFY_WAIT_MS", 8000),
    // Scoring may use a cheaper analytical model without changing the
    // customer-facing reply route. Empty preserves the historical single-model
    // default for every existing instance.
    hermesScorerModel: env("HERMES_SCORER_MODEL", "").trim(),
    // Optional instance-owned closed model policy. Empty keeps legacy model
    // picker behavior; a configured list also constrains stale DB overrides.
    hermesAllowedModels: env("HERMES_ALLOWED_MODELS", "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    hermesReplyAllowedModels: env("HERMES_REPLY_ALLOWED_MODELS", "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    hermesScorerAllowedModels: env("HERMES_SCORER_ALLOWED_MODELS", "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    // v1.4.12 (คำสั่งพี่ง้วง 2026-08-18): ข้อความขึ้นต้น # = คีย์เวิร์ดกิจกรรม ให้
    // LINE OA auto-response ตอบเอง ลูกแพรเงียบเฉพาะข้อความนั้น (ปิดได้ต่อ instance)
    // คำสั่งพี่ง้วง 2026-08-25: ไบต์สื่อของลูกค้าที่สั่ง "ลืมข้อมูล" ให้ "เก็บไว้เป็น
    // ข้อมูลอ้างอิง" ไม่ใช่ลบทิ้ง (เผื่อมีประเด็นภายหลัง) — แถวใน DB ยังถูกลบตามเดิม
    // ค่าที่รับได้: "retain_reference" (ตามคำสั่งเจ้าของ) | "delete" (ลบไบต์เมื่อระบายคิวได้)
    // หมายเหตุกฎหมาย: คำขอลบตาม PDPA ที่แท้จริงต้องใช้ "delete" — โหมด retain เป็นการ
    // เก็บหลักฐานทางธุรกิจโดยเจตนาของเจ้าของ และถูกบันทึกให้ตรวจสอบย้อนหลังได้
    erasedMediaPolicy: ["delete", "retain_reference"].includes(String(env("ERASED_MEDIA_POLICY", "retain_reference")))
      ? String(env("ERASED_MEDIA_POLICY", "retain_reference"))
      : "retain_reference",
    hashtagAutoResponseSilence: flag("HASHTAG_SILENCE", true),
    // v1.4.50: รายการคีย์เวิร์ดธุรกิจที่ลูกแพรตอบเอง (JSON: {"#online":"ประโยคเจตนา"})
    // ค่าเริ่มต้นว่าง = พฤติกรรม # เดิมทุกประการ; ค่าใน DB (หน้า Settings) ชนะ env
    hashtagBusinessKeywords: (() => {
      try { return JSON.parse(env("HASHTAG_BUSINESS_KEYWORDS", "") || "{}"); } catch { return {}; }
    })(),
    // v1.4.9: เส้น follow-up (sub-agent ทักตามสเตจ) เลือกโมเดลแยกจากตัวหลักได้ —
    // ค่าว่าง = ตามตัวหลัก (reply model ปัจจุบัน) เพื่อคงพฤติกรรมเดิมทุกไบต์
    hermesFollowupModel: env("HERMES_FOLLOWUP_MODEL", "").trim(),
    // 2026-09-30: ระดับการคิดของร่างตอบลูกค้า + ข้อความติดตาม ("" = ไม่ส่ง = ค่าเริ่มต้นของโมเดล)
    hermesReplyReasoningEffort: env("HERMES_REPLY_REASONING_EFFORT", "").trim().toLowerCase(),
    // 7 พ.ย. 2026: คลังคำตอบจริงของครู (Opus) สำหรับสวิตช์ reply_style_bank — ไฟล์ใน instance ไม่อยู่ใน git · ว่าง = ไม่มีคลัง
    replyStyleBankFile: env("REPLY_STYLE_BANK_FILE", "").trim(),
    // 8 พ.ย. 2026: คลังข้อความทักตามจริงของ Opus (สวิตช์ followup_style_bank) · ไฟล์ส่วนตัวนอก git
    followupStyleBankFile: env("FOLLOWUP_STYLE_BANK_FILE", "").trim(),
    hermesFollowupAllowedModels: env("HERMES_FOLLOWUP_ALLOWED_MODELS", "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    // Optional local gateway health path. Empty preserves the historical
    // configured-only health contract; a configured path is queried without
    // customer content before /health can report Hermes ready.
    hermesHealthPath: env("HERMES_HEALTH_PATH", "").trim(),
    hermesTimeoutMs: num("HERMES_TIMEOUT_MS", 90000),
    // Optional scorer-only recovery route. It is deliberately separate from
    // reply_model so a failed analytical call can never create a second
    // customer-facing draft. Empty keeps legacy behaviour exactly unchanged.
    hermesScorerFallbackModel: env("HERMES_SCORER_FALLBACK_MODEL", "").trim(),
    hermesScorerFallbackReasoningEffort: env("HERMES_SCORER_FALLBACK_REASONING_EFFORT", "").trim().toLowerCase(),

    // G2b (B3): ถอดความข้อความเสียง — ไม่มี OPENAI_API_KEY = ฟีเจอร์ปิด (fail-closed)
    openaiApiKey: env("OPENAI_API_KEY"),
    openaiBase: env("OPENAI_BASE", "https://api.openai.com/v1"),
    transcribeModel: env("TRANSCRIBE_MODEL", "whisper-1"),

    // G3/W2: ตรวจสลิปอัตโนมัติ (pre-check ให้แอดมิน) — ระบบ provider (fail-closed):
    // SLIP_PROVIDER = slipok | webhook | off — ไม่ตั้ง = อนุมานแบบ legacy:
    // มี SLIP_CHECK_URL = webhook (พฤติกรรมเดิม 100%), ไม่มี = off
    // slipok ต้องมีทั้ง SLIPOK_API_KEY + SLIPOK_BRANCH_ID ไม่งั้นปิดสนิท
    slipProvider: env("SLIP_PROVIDER"),
    slipCheckUrl: env("SLIP_CHECK_URL"),
    slipCheckToken: env("SLIP_CHECK_TOKEN"),
    slipokApiKey: env("SLIPOK_API_KEY"),
    slipokBranchId: env("SLIPOK_BRANCH_ID"),

    // G6 (P2): integration hook ระบบออเดอร์ — POST JSON ตอนสถานะเปลี่ยนเป็น
    // confirmed/paid (สะพานไป Make/Sheets/ระบบลูกค้า) — ไม่มี URL = ปิดสนิท (fail-closed)
    orderWebhookUrl: env("ORDER_WEBHOOK_URL"),
    orderWebhookToken: env("ORDER_WEBHOOK_TOKEN"),

    // G2b (B8): ตารางราคาโมเดล + อัตราแลกเปลี่ยนโชว์ค่าใช้จ่ายเป็นบาท
    modelPricingFile: env("MODEL_PRICING_FILE", join(APP_ROOT, "config", "model-pricing.json")),
    // THB_PER_USD = ค่า fallback/override มือ — rate สดจาก fxRate ชนะเมื่อดึงได้
    thbPerUsd: num("THB_PER_USD", 36),
    // FX_LIVE=false = ปิดการดึง rate สด ใช้ THB_PER_USD อย่างเดียว (escape hatch)
    fxLive: flag("FX_LIVE", true),

    // Operator API
    dashboardApiKey: env("DASHBOARD_API_KEY"),

    // Operator Console (G1b) — fail-closed: ไม่มี secret = /console ทั้งหมดตอบ 503
    consoleSessionSecret: env("CONSOLE_SESSION_SECRET"),
    // seed บัญชีแรก: "username:password" (ใช้ครั้งแรกตอนตารางว่าง — hash ทันที ไม่เก็บ plaintext)
    operatorSeed: env("OPERATOR_SEED"),
    // default TRUE — session cookie ต้องมี Secure (ส่งเฉพาะ https) เว้นแต่ตั้ง
    // CONSOLE_COOKIE_SECURE=false ชัดเจน (escape hatch สำหรับทดสอบ localhost http)
    consoleCookieSecure: flag("CONSOLE_COOKIE_SECURE", true),
    consoleSessionTtlMs: num("CONSOLE_SESSION_TTL_MS", 7 * 24 * 60 * 60 * 1000),
    // Complete operator chat history is read-only and deliberately opt-in.
    // A deployed instance must name the flag before it exposes the new route.
    chatHistoryEnabled: flag("CHAT_HISTORY_ENABLED", false),
    // Directory is validated by the audit reader before use; an empty value
    // keeps retrospective files unavailable rather than guessing a location.
    jevAuditDir: env("JEV_AUDIT_DIR", "").trim(),
    // Internal admin Web Push. All four values are required at runtime; a
    // partial setup remains unavailable and never sends a provider request.
    webPushEnabled: flag("WEB_PUSH_ENABLED", false),
    webPushVapidPublicKey: env("WEB_PUSH_VAPID_PUBLIC_KEY", "").trim(),
    webPushVapidPrivateKey: env("WEB_PUSH_VAPID_PRIVATE_KEY", "").trim(),
    webPushVapidSubject: env("WEB_PUSH_VAPID_SUBJECT", "").trim(),
    webPushTimeoutMs: Math.min(30_000, Math.max(1_000, num("WEB_PUSH_TIMEOUT_MS", 10_000))),
    // Shared chassis visual identity. This is the only console branding surface
    // available to the unauthenticated login page; it never contains secrets.
    consoleBranding: consoleBranding(source),
    // White-label (8 ต.ค. 2026): ชื่อแอดมิน AI / เจ้าของ / ธุรกิจ + โปรไฟล์ธุรกิจ
    // ไม่ตั้ง env = แบรนด์ลูกแพร/พี่ง้วง ติดกระดุม + โปรไฟล์ course (พฤติกรรมวันนี้ทุกตัวอักษร)
    brand: brandFromEnv(source),
    // โมเดลที่เคยฮาร์ดโค้ด — ค่าเริ่มต้นคือค่าเดิมเป๊ะ
    hermesQualifyModel: env("HERMES_QUALIFY_MODEL", "gpt-6.1-sol").trim(),
    ownerChatModel: env("OWNER_CHAT_MODEL", "gpt-5.6-luna").trim(),

    // Synthetic canary (G1b) — 0 = ปิด; เปิดแล้วยิงข้อความสังเคราะห์ผ่าน pipeline เป็นรอบ ๆ
    canaryIntervalMs: num("CANARY_INTERVAL_MS", 0),
    canaryTimeoutMs: num("CANARY_TIMEOUT_MS", 30000),
    canaryUserId: env("CANARY_USER_ID", "canary:synthetic"),
    canaryAlertWebhookUrl: env("CANARY_ALERT_WEBHOOK_URL"),

    // G2a (F3): จำนวน turn ล่าสุดที่ส่งให้ interest scorer อ่าน
    // v1.5.1: 10 -> 16 คู่กับ historyTurns ใหม่ — สรุปสถานะ (context_summary) เขียนทับ
    // ทุกรอบ ถ้า scorer มองเห็นสั้นกว่าเส้นตอบ ข้อตกลงเก่าจะหายจากสรุปก่อนหายจากตาบอท
    scoreTurns: num("SCORE_TURNS", 16),
    // v1.2.3: scorer อ่านบทสนทนาทั้งบทก่อนสรุป JSON — โมเดล reasoning หักโทเคนที่ใช้คิด
    // จากงบก้อนเดียวกับข้อความที่ตอบออกมา งบของเส้นตอบลูกค้า (สั้น) จึงไม่พอเสมอ
    // 0 = ไม่ส่งค่านี้ ให้ provider/gateway ใช้ค่า default ของตัวเอง
    scorerMaxTokens: num("HERMES_SCORER_MAX_TOKENS", 3000),

    // G2a (F5): Follow-up engine — fail-closed: FOLLOWUP_ENABLED default false
    // (สวิตช์ runtime ใน console เก็บใน DB ชนะค่า env นี้)
    followupEnabled: flag("FOLLOWUP_ENABLED", false),
    // Customer language can disable proactive follow-up for the current room.
    // Keep the classifier/action path unavailable unless the instance enables it.
    customerFollowupSuppressionEnabled: flag("CUSTOMER_FOLLOWUP_SUPPRESSION_ENABLED", false),
    // The course-consultation scope is not a policy for unrelated businesses.
    serviceBoundaryEnabled: brandFromEnv(source).profile !== "generic" && flag("SERVICE_BOUNDARY_ENABLED", false),
    jevShadowEnabled: flag("JEV_SHADOW_ENABLED", false),
    // Jev is advisory by default. `enforce` only exposes a verdict to the
    // pipeline; the pipeline remains the sole owner of any customer action.
    jevReviewMode: ["off", "shadow", "enforce"].includes(env("JEV_REVIEW_MODE", "off").trim().toLowerCase())
      ? env("JEV_REVIEW_MODE", "off").trim().toLowerCase() : "off",
    jevReviewThreshold: Math.min(10, Math.max(0, num("JEV_REVIEW_MIN_CONFIDENCE", 9))),
    jevOwnerLearningEnabled: flag("JEV_OWNER_LEARNING_ENABLED", false),
    jevReviewDailyLimit: Math.min(2000, Math.max(1, num("JEV_REVIEW_DAILY_LIMIT", 250))),
    jevReviewMaxConcurrent: Math.min(2, Math.max(1, num("JEV_REVIEW_MAX_CONCURRENT", 2))),
    jevReviewTimeoutMs: Math.min(30_000, Math.max(1_000, num("JEV_REVIEW_TIMEOUT_MS", 8_000))),
    salesDecisionGuardEnabled: flag("SALES_DECISION_GUARD_ENABLED", false),
    typesafeApiKey: env("TYPESAFE_API_KEY"),
    jevShadowDailyLimit: Math.min(250, Math.max(1, Number(env("JEV_SHADOW_DAILY_LIMIT", "250")) || 250)),
    // v1.4.47: หยุด AI ทั้งระบบแบบยังรับข้อมูล (คอนโซลสลับได้ ชนะ env) — ใช้ช่วง cutover
    aiPaused: flag("AI_PAUSED", false),
    // ใช้คู่กับ AI_PAUSED: paused + draft mode = คิดและเก็บร่างให้แอดมิน แต่ไม่ส่ง (ค่า DB ชนะ)
    aiPausedDraftMode: flag("AI_PAUSED_DRAFT_MODE", false),
    // ระหว่าง pause อนุญาต reactive text ได้หนึ่ง customer จาก domain-separated hash เท่านั้น
    aiPausedReactiveCanarySha256: env("AI_PAUSED_REACTIVE_CANARY_SHA256").trim().toLowerCase(),
    // scheduler tick — 0 = ไม่ arm interval เลย (เช็คสวิตช์ global สดทุกรอบตอนเดิน)
    followupIntervalMs: num("FOLLOWUP_INTERVAL_MS", 60000),

    // 2026-09-02: นาฬิกา SLA ของคิว "รอคน" — ห้อง NEEDS_HUMAN ที่ไม่มีใครตอบต้องถูก
    // ทวงซ้ำ (ของจริงวันนี้: 28 ห้องรอคน 11 ห้องไม่เคยมีคนตอบ นานสุด 169 ชม.)
    // ค่าที่ตั้งผิดรูป = ปิดงานนี้ (flag คืน false ทุกค่าที่ไม่ใช่ true/1) — เงียบไว้ก่อน
    // ปลอดภัยกว่าปลุกทีมงานผิดจังหวะ
    needsHumanSlaEnabled: flag("NEEDS_HUMAN_SLA_ENABLED", true),
    needsHumanSlaMinutes: num("NEEDS_HUMAN_SLA_MINUTES", 30),
    needsHumanSlaMaxReminders: num("NEEDS_HUMAN_SLA_MAX", 3),
    // เวลาทำการของ "การทวง" (เวลาไทย, รองรับข้ามคืน) — นอกเวลาไม่ยิงเลย
    needsHumanSlaHours: env("NEEDS_HUMAN_SLA_HOURS", "08:00-20:00"),
    needsHumanSlaTickMs: num("NEEDS_HUMAN_SLA_TICK_MS", 300000),

    // v1.4.6: Staged follow-up (sub-agent ตามสเตจ — คำสั่งพี่ง้วง 2026-08-16)
    // fail-closed ทุกชั้น: enabled default false + tick 0 = ไม่ arm + สวิตช์ DB ชนะ env
    stagedFollowupEnabled: flag("STAGED_FOLLOWUP_ENABLED", false),
    stagedFollowupTickMs: num("STAGED_FOLLOWUP_TICK_MS", 0),
    stagedColdDelayMs: num("STAGED_COLD_DELAY_MS", 3_600_000),
    stagedWarmDelayMs: num("STAGED_WARM_DELAY_MS", 1_800_000),
    stagedHotDelayMs: num("STAGED_HOT_DELAY_MS", 1_800_000),
    // 28 ก.ย. 2026: ข้อความตามขั้น — รอบตรวจทุก 60 วิ (arm เมื่อเปิดบรอดแคสต์ · 0 = ปิดตัวจับเวลา)
    // ส่งจริงเฉพาะลำดับที่คนกดเปิดใช้ + สวิตช์ settings.step_messages_mode (ไม่มีแถว = on) — ปิดได้ทันทีจากหน้าตั้งค่า
    stepMessagesTickMs: num("STEP_MESSAGES_TICK_MS", 60_000),

    // G7.1: Owner Daily Digest — สรุปหน้าร้าน push ถึงเจ้าของทาง LINE (fail-closed
    // หลายชั้น): ไม่มี DIGEST_LINE_USER_ID = ปิดสนิททุกกรณี; DIGEST_ENABLED default
    // false (สวิตช์ runtime `digest_enabled` ในหน้า console ชนะ env)
    digestLineUserId: env("DIGEST_LINE_USER_ID"),
    digestChannelId: env("DIGEST_CHANNEL_ID", "default"),
    digestTimes: env("DIGEST_TIMES", "08:30,20:00"),
    digestEnabled: flag("DIGEST_ENABLED", false),

    // 29 ก.ย. 2026 (คำสั่งพี่ง้วง): push แจ้งทีม "ลูกค้าร้อนรอทีมทักต่อ" วันละ 3 รอบ (เวลาไทย, HH:MM คั่นจุลภาค)
    // ผู้รับ = รายชื่อแจ้งเตือนทีมชุดเดิม (escalate_notify:*) · ปิดได้ทันทีด้วยสวิตช์ hot_followup_push_mode ในหน้าตั้งค่า
    // HOT_FOLLOWUP_PUSH_TICK_MS=0 = ไม่ arm ตัวจับเวลาเลย
    hotFollowupPushTimes: env("HOT_FOLLOWUP_PUSH_TIMES", "09:10,13:10,18:10"),
    hotFollowupPushTickMs: num("HOT_FOLLOWUP_PUSH_TICK_MS", 60_000),

    // Daily learning is proposal-only and fail-closed. Deterministic Stage A is
    // always local. Stage B needs both this explicit switch and an injected
    // scorer; default startup therefore performs zero learning network calls.
    learningDigestEnabled: flag("LEARNING_DIGEST_ENABLED", false),
    learningDigestIntervalMs: num("LEARNING_DIGEST_INTERVAL_MS", 86_400_000),
    learningModelEnabled: flag("LEARNING_MODEL_ENABLED", false),
    learningModel: env("LEARNING_MODEL", env("HERMES_SCORER_MODEL", env("HERMES_MODEL", "gpt-5.6-sol"))).trim(),
    learningMaxClusters: Math.min(10, Math.max(1, num("LEARNING_MAX_CLUSTERS", 10))),
    learningMaxTokensOut: Math.min(1500, Math.max(1, num("LEARNING_MAX_TOKENS_OUT", 1500))),
    learningDailyUsdCap: Math.min(0.5, Math.max(0, num("LEARNING_DAILY_USD_CAP", 0.5))),

    // v1.1 (bug 5): fallback ผู้รับ push แจ้งทีมเมื่อลูกค้าต้องการคน (comma list ของ LINE user id)
    // — ค่าต่อสาขาใน console (settings `escalate_notify:<ch>`) ชนะ env นี้; ไม่มีทั้งคู่ = ปิด
    escalateNotifyIds: env("ESCALATE_NOTIFY_IDS", "").split(",").map((s) => s.trim()).filter(Boolean),

    // M4: retention pruning รายวัน (ลบข้อมูลเก่าเกินกรอบ) — default เปิด
    // ปิดทั้งงานด้วย RETENTION_ENABLED=false; ปรับอายุรายตารางได้ผ่าน env วัน
    retentionEnabled: flag("RETENTION_ENABLED", true),
    retentionDays: {
      eventsDedupe: num("RETENTION_EVENTS_DEDUPE_DAYS", 30),
      llmUsage: num("RETENTION_LLM_USAGE_DAYS", 180),
      scoreHistory: num("RETENTION_SCORE_HISTORY_DAYS", 180),
      adminAudit: num("RETENTION_ADMIN_AUDIT_DAYS", 365),
      operatorOutboundAttempts: num("RETENTION_OPERATOR_OUTBOUND_ATTEMPTS_DAYS", 365),
      scheduleAck: num("RETENTION_SCHEDULE_ACK_DAYS", 30),
      opportunityHandoff: num("RETENTION_OPPORTUNITY_HANDOFF_DAYS", 180),
      // `/reset` snapshots contain chat content. Keep the training-review
      // queue deliberately short-lived, even when other operational ledgers
      // have longer statutory/business windows.
      // Owner policy 2026-08-23: temporary training/lab artifacts expire at
      // 90 days; customer and chat history has no automatic age deletion.
      trainingCandidate: num("RETENTION_TRAINING_CANDIDATE_DAYS", 90),
      // Operator uploads that were never sent are temporary staging material,
      // not business records. Bound abandoned bytes even when no chat session
      // later rotates.
      messageMediaOrphan: Math.min(30, Math.max(1, num("RETENTION_MESSAGE_MEDIA_ORPHAN_DAYS", 1))),
    },

    // Burst buffer (SPEC: debounce 4000ms LINE, maxWait 12s)
    burstDebounceMs: num("BURST_DEBOUNCE_MS", 4000),
    burstMaxWaitMs: num("BURST_MAX_WAIT_MS", 12000),

    // ปิดอย่างเรียบร้อย (Drain-to-Finish) — เพดาน 3 วินาทีเดิมสั้นกว่าหน้าต่าง burst เสมอ
    // จึงตัดกลาง debounce ทุกครั้งที่ deploy ค่าทั้งชุดนี้ต้องน้อยกว่า TimeoutStopSec ของ
    // systemd unit บนเครื่องจริง ไม่งั้นโดน SIGKILL ระหว่าง drain แล้วเสียประโยชน์ทั้งหมด
    shutdownDrainMs: num("SHUTDOWN_DRAIN_MS", 20000),
    shutdownDraftAbortMs: num("SHUTDOWN_DRAFT_ABORT_MS", 12000),
    shutdownHardExitMs: num("SHUTDOWN_HARD_EXIT_MS", 25000),
    // ระหว่าง drain ส่งเป็นก้อนเดียว: ตัดหน่วงจังหวะพิมพ์ และลบคลาสความผิดพลาด
    // "ลูกค้าได้บอลลูนครึ่งชุด" ทิ้ง — แลกกับจังหวะพิมพ์ที่เสียไปหนึ่งครั้งต่อการ deploy
    shutdownFastSend: flag("SHUTDOWN_FAST_SEND", true),
    // ด่านอายุคำตอบ — 0 = ปิด (ค่าเริ่มต้นโดยเจตนา ห้ามตั้งค่าเริ่มต้นเป็นตัวเลขอีก)
    // ค่าเดิม 90 วินาทีสั้นกว่างบเวลาคิดจริง (HERMES_TIMEOUT_MS 90 วิ × retry 2 ยก + redraft)
    // จึงทิ้งคำตอบที่คิดสำเร็จแล้วทั้งก้อน = สร้างห้องเงียบแบบใหม่แทนที่จะกันห้องเงียบ
    // เหตุผลเต็มอยู่ที่ pipeline.mjs ตรงด่านนี้ — เปิดเองได้เมื่อเจอเคสค้างผิดปกติจริง
    replyMaxAgeMs: num("REPLY_MAX_AGE_MS", 0),
    // เทิร์นค้างที่เก่ากว่านี้ = บันทึกไว้เฉย ๆ ไม่ปลุกคน (กันเสียงรบกวนตอน boot)
    strandedEscalateWithinMs: num("STRANDED_ESCALATE_WITHIN_MS", 24 * 60 * 60_000),

    // Humanizer pacing — เทสต์ตั้ง 0 เพื่อไม่รอจริง
    sendDelayScale: num("SEND_DELAY_SCALE", 1),

    // v1.5.1 (feedback ชมพู่ 3 วันแรก + journey eval): 6 คู่สนทนาสั้นเกินสำหรับงานขายจริง
    // ที่ยาว 20-30 เทิร์น — ข้อตกลงที่แอดมินคุยไว้ (เลื่อนวันเรียน ราคาที่เสนอ ชื่อแบรนด์)
    // หลุดหน้าต่างแล้วบอทตอบขัดกับที่ตกลง ยก 6->12 (=24 ข้อความ) ต้นทุนต่อ call เพิ่มเล็กน้อย
    // แต่ prompt ส่วนหน้า (persona/knowledge) ยัง cache ได้เหมือนเดิม
    historyTurns: num("HISTORY_TURNS", 12),
    // Training controls are a separate, explicit OA allowlist. Empty is
    // deliberately fail-closed so /reset and /fb remain ordinary customer text
    // on a live OA unless its exact channel id is configured here.
    trainingCommandChannels: trainingCommandChannels(env("TRAINING_COMMANDS_CHANNELS", "")),
    // v1.2.3: โหมดเทรนภายใน (instance ที่ยิงเข้า allowlist ของตัวเองเท่านั้น) —
    // อนุญาตให้ผู้ช่วยตอบด้วย "ข้อมูลตัวอย่าง" ที่ติดป้ายชัดเจน เพื่อให้เห็นเส้นทาง
    // บทสนทนาทั้งเส้นก่อนข้อมูลจริงจะครบ. ห้ามเปิดกับ instance ที่คุยกับลูกค้าจริง
    trainingMockMode: flag("TRAINING_MOCK_MODE", false),
    // Brain เฟส 1a (shadow store): พิมพ์บรรทัดเดียวตอนบูตว่า "สมองที่คอมไพล์แล้วตรงกับ
    // ตารางเดิมไหม" — อ่านอย่างเดียว ไม่แตะ prompt ไม่แตะ guard ไม่เขียนอะไรทั้งสิ้น
    // ค่าเริ่มต้นปิด: ยังไม่มีเวอร์ชันสมองบนเครื่องจริง เปิดแล้วจะได้แค่ "ยังไม่มีเวอร์ชัน"
    // เปิดทางอ่านสมองเมื่อไร ตัวเฝ้าสมองเงาต้องเดินด้วยเสมอ — มันคือตัวเดียวที่จับได้ว่า
    // "สมองที่กำลังเสิร์ฟ" เริ่มไม่ตรงกับตารางที่ระบบใช้จริง แล้วสั่งให้ถอยกลับทางเดิม
    // (แบบแปลน §11 P1b: เปิดแฟล็กกลับต้องมี import-diff = ∅) ปิดเองไม่ได้เมื่อ versioned
    brainShadowParity: flag("BRAIN_SHADOW_PARITY", false) || brainRead === "versioned",
    // จังหวะตรวจสมองเงาซ้ำระหว่างวัน (ตัวเฝ้าใน src/brain/parityWatch.mjs) — ด่านเฟส 1a
    // คือ "ตรงติดกัน N คืน" ซึ่งบรรทัดตอนบูตอย่างเดียวนับให้ไม่ได้ · 0 = ไม่ตั้งตัวเฝ้า
    // (บรรทัดตอนบูตยังพิมพ์เหมือนเดิม) · เดินเฉพาะเมื่อ BRAIN_SHADOW_PARITY=true
    brainParityTickMs: num("BRAIN_PARITY_TICK_MS", 6 * 60 * 60_000),
    // Brain เฟส 1b (versioned writes): ทุกการเขียนในคอนโซลที่เปลี่ยนข้อมูลตั้งต้นของ AI
    // สร้าง "เวอร์ชันสมอง" ใหม่ ผ่านบันไดด่าน G0–G4 แล้วจึงย้าย pointer
    // ปิดโดยค่าเริ่มต้น = คอนโซลเขียนตารางเดิมตรง ๆ เหมือนเดิมทุกตัวอักษร (ทางถอยของเฟสนี้)
    // ต้องมีเวอร์ชันสมองที่ pointer live ชี้อยู่แล้วเท่านั้น ไม่งั้นแฟล็กนี้ไม่มีผลอะไรเลย
    // เฟส 2 อ่านค่านี้ด้วย: BRAIN_READ=versioned โดยไม่มีตัวนี้ = ตารางเดิมยังมีทางเขียนอื่น
    // แล้วสมองกับตารางจะเดินคนละทางโดยไม่มีใครเห็น (แบบแปลน §5) จึงเป็นด่านบูตที่ fatal
    knowledgeVersioned: flag("KNOWLEDGE_VERSIONED", false),
    // Brain เฟส 2: ทางอ่านของ runtime
    //   legacy    = อ่านตารางเดิมทุกไบต์ (ค่าเริ่มต้น — ไม่มีอะไรเปลี่ยนเลย)
    //   versioned = อ่านจากเวอร์ชันสมองที่ pointer ชี้ (ต้องเปิด KNOWLEDGE_VERSIONED ด้วย)
    brainRead,
    // Query-scoped knowledge requires the approved, versioned read path.
    // Keep off until the tenant's authored metadata and regression checks pass.
    brainRetrievalEnabled: flag("BRAIN_RETRIEVAL_ENABLED", false),
    // ตกกลับทางเดิมติดกันกี่เทิร์นถึงปลุกทีม — ตกครั้งเดียวคือเสียงรบกวน ตกติดกันคืออาการ
    brainFallbackAlertStreak: num("BRAIN_FALLBACK_ALERT_STREAK", 5),
    // อาการที่ยังไม่หายต้องดังซ้ำได้ — ปลุกครั้งเดียวตลอดกาลคือวิธีที่แน่นอนที่สุดที่จะทำให้
    // outage รอบที่สองเงียบสนิท (ตัวนับเคลียร์เองเมื่ออ่านสมองกลับมาได้)
    brainFallbackAlertCooldownMs: num("BRAIN_FALLBACK_ALERT_COOLDOWN_MS", 30 * 60_000),
    // หน้าต่างเฝ้าดูหลังรุ่นสมองเปลี่ยน (แบบแปลน §11 P2 "contract fallback + soak 15 นาที")
    // — /health ต้องบอกได้ว่า "เพิ่งสลับรุ่นเมื่อกี้" ไม่ใช่ให้คนเดาจากเวลา deploy
    brainReadSoakMs: num("BRAIN_READ_SOAK_MS", 15 * 60_000),
    // Brain เฟส 3 (ฝั่งคน): กล่องตรวจ #/review + จอสอน #/teach + บรรทัด "ทำไมตอบแบบนี้"
    // ปิดเป็นค่าเริ่มต้น = คอนโซลไม่มีเมนูและทุกเส้น /console/api/teach/* ตอบ 404 เหมือนไม่มีอยู่
    // (ทางถอยของเฟสนี้คือปิดแฟล็ก — ข้อมูลที่กล่องตรวจอ่านล้วนเป็นตารางที่มีอยู่ก่อนแล้ว
    //  ไม่มีตารางใหม่ให้ต้องล้าง และไม่มีการเขียนทางไหนที่หายไปตอนปิด)
    teachEnabled: flag("TEACH_ENABLED", false),
    // Curated team Q&A creates proposals only; activation remains explicit.
    trainingIntakeEnabled: flag("TRAINING_INTAKE_ENABLED", false),
    // Brain เฟส 3 (ฝั่งด่าน): บันไดด่านที่แพงกว่า ms
    //   ""        ปิดหมด (ค่าเริ่มต้น) = บันไดตัดสินเหมือนเฟส 1b ทุกไบต์
    //   offline   G5 + G8 เล่นซ้ำบทสนทนาจริง ไม่เรียกโมเดล ไม่มีค่าใช้จ่าย
    //   heavy     offline + เปิดสิทธิ์ให้ G5b ทำงานได้ (ยังต้องยืนยันรายครั้ง + แสดงยอดก่อน)
    // ค่าที่ระบบไม่รู้จัก = ล้มตั้งแต่บูตพร้อมบอกว่าพิมพ์อะไรผิด ไม่ใช่ปัดเป็นปิดเงียบ ๆ
    brainGates: brainGatesMode(env("BRAIN_GATES", "")),
    personaFile: env("PERSONA_FILE", join(APP_ROOT, "config", "persona.example.md")),
    // Optional integrity gate for isolated customer instances. Legacy instances
    // retain their existing fail-open behaviour when no hash is configured;
    // a configured pin makes missing/drifted persona content a startup error.
    personaSha256: env("PERSONA_SHA256", "").toLowerCase(),
    // 18 ต.ค. 2026 (ขั้นที่ 1 ของแผน soul): ตัวตนของร้านทุกเส้นมาจากไฟล์นี้ (src/soul/) · ว่าง = ค่ากลางที่ไม่มีชื่อแบรนด์
    // ตั้งแล้วอ่านไม่ได้ / hash ไม่ตรง SOUL_SHA256 / สัญญาส่วน C ไม่ผ่าน = บูตไม่ขึ้น (ไม่ตกไปใช้ค่ากลางเงียบ ๆ)
    soulFile: env("SOUL_FILE", ""),
    soulSha256: env("SOUL_SHA256", "").toLowerCase(),
    // 20 ต.ค. 2026 (ขั้นที่ 3 ของแผน soul): soul รุ่นทดลองที่มากับ release เดียวกัน — ว่าง = ไม่มีรุ่นทดลอง (ทุกห้องรุ่นหลัก)
    // ห้องไหนได้รุ่นนี้ตัดสินที่สวิตช์ soul_candidate_mode (soulRollout.mjs) ไม่ใช่ที่ env · hash ไม่ตรง/สัญญาไม่ผ่าน = บูตไม่ขึ้น
    soulCandidateFile: env("SOUL_CANDIDATE_FILE", ""),
    soulCandidateSha256: env("SOUL_CANDIDATE_SHA256", "").toLowerCase(),
    // 5 ต.ค. 2026 (พี่ง้วง "เพิ่มด่านกันคำว่าครับให้หน่อย"): ด่านคำลงท้ายของตัวละครผู้หญิง (personaParticles.mjs)
    // แก้ ครับ/คับ/ฮะ ที่โมเดลหลุดให้เป็น ค่ะ/คะ ก่อน humanize — chassis มีหลายร้าน จึงปิดเป็นค่าตั้งต้น
    // รับค่าเดียวคือ "female" ค่าอื่น/ว่าง = ปิด (ข้อความขาออกเหมือนเดิมทุกไบต์)
    personaParticles: env("PERSONA_PARTICLES", "").trim().toLowerCase() === "female" ? "female" : "",
    bannedWordsFile: env("BANNED_WORDS_FILE", join(APP_ROOT, "config", "clinic-banned.json")),
    // Image catalog: allowlist รูปที่ส่งได้ — model เลือกได้เฉพาะ key ผ่าน [IMAGE:key]
    // ไม่มีไฟล์ = ฟีเจอร์รูปปิด (แคตตาล็อกว่าง) — ไม่ใช่ error
    imageCatalogFile: env("IMAGE_CATALOG_FILE", join(APP_ROOT, "config", "image-catalog.json")),
    // โฟลเดอร์รูป self-host เสิร์ฟที่ GET/HEAD /img/<name>.{jpg,png}
    // ต้นฉบับขนาดใหญ่ใช้คู่กับ preview_url ที่เล็กกว่าได้ตาม LINE image-message contract
    imageDir: env("IMAGE_DIR", ""),
    // Optional fail-closed integrity manifest for /img. A configured manifest
    // limits hosting to reviewed names and pins every file by size + SHA-256.
    imageHostingManifestFile: env("IMAGE_HOSTING_MANIFEST_FILE", ""),
    imageMaxPerReply: num("IMAGE_MAX_PER_REPLY", 6),
    // Optional instance policies. Empty/missing path keeps legacy behaviour;
    // a configured malformed file is rejected at app construction.
    replyDeliveryPolicyFile: env("REPLY_DELIVERY_POLICY_FILE", ""),
    salesPolicyFile: env("SALES_POLICY_FILE", ""),
    // Sales-policy routing is business-scoped. server.mjs requires this to
    // exactly match the policy businessId before assembling the application.
    businessId: env("BUSINESS_ID", "").trim(),
    // Manual broadcast is a separate high-impact outbound capability. Keep its
    // routes and engine absent unless the instance opts in explicitly.
    broadcastEnabled: flag("BROADCAST_ENABLED", false),
    // B-13: future broadcasts are a second, independent high-impact capability.
    // Tick is clamped to >=15s so a typo cannot create a hot polling loop.
    broadcastScheduleEnabled: flag("BROADCAST_SCHEDULE_ENABLED", false),
    broadcastScheduleTickMs: Math.min(5 * 60_000, Math.max(15_000, num("BROADCAST_SCHEDULE_TICK_MS", 30_000))),
    // รูปที่ operator อัปโหลดเพื่อใช้ใน broadcast — ปิดเป็นค่าเริ่มต้นและต้องมี
    // public HTTPS origin ที่ LINE ดึงได้จริง (ห้าม derive จาก Host header)
    mediaUploadEnabled: flag("MEDIA_UPLOAD_ENABLED", false),
    mediaDir: env("MEDIA_DIR", ""),
    mediaPublicBaseUrl: env("MEDIA_PUBLIC_BASE_URL", ""),
    // ใช้ไฟล์เดียวเป็น original + preview จึงล็อก hard ceiling จริงไว้ที่ 1 MB ใน store
    mediaUploadMaxBytes: num("MEDIA_UPLOAD_MAX_BYTES", 1_000_000),
    mediaUploadMaxWidth: num("MEDIA_UPLOAD_MAX_WIDTH", 8192),
    mediaUploadMaxHeight: num("MEDIA_UPLOAD_MAX_HEIGHT", 8192),
    mediaUploadMaxPixels: num("MEDIA_UPLOAD_MAX_PIXELS", 20_000_000),
    mediaUploadMaxActive: num("MEDIA_UPLOAD_MAX_ACTIVE", 100),
    mediaUploadTotalBytes: num("MEDIA_UPLOAD_TOTAL_BYTES", 100_000_000),
    mediaUploadsPerOperatorHour: num("MEDIA_UPLOADS_PER_OPERATOR_HOUR", 20),
    // Private conversation media is intentionally separate from public broadcast media.
    // All capabilities ship OFF; turning one on additionally needs a private directory.
    messageMediaEnabled: flag("MESSAGE_MEDIA_ENABLED", false),
    inboundLineContentCapture: flag("INBOUND_LINE_CONTENT_CAPTURE", false),
    operatorFileUploadEnabled: flag("OPERATOR_FILE_UPLOAD_ENABLED", false),
    outboundFileLinkEnabled: flag("OUTBOUND_FILE_LINK_ENABLED", false),
    // Accept only a literal HTTPS origin. File links are capability URLs; never
    // derive this from a request Host header or accept a deployment path/query.
    outboundFilePublicBaseUrl: normalizeHttpsOrigin(env("OUTBOUND_FILE_PUBLIC_BASE_URL", "")),
    // audit 2026-08-25: consoleApi.mjs อ่านสองคีย์นี้อยู่แล้วแต่ไม่เคยถูกนิยาม —
    // outboundFilePublicOrigin เป็น undefined เสมอ (ตกไปใช้ BaseUrl โดยบังเอิญ) และ
    // เพดานไบต์ต่อ operator ต่อชั่วโมงถูกตรึงที่ messageMediaMaxBytes*2 ปรับไม่ได้จริง
    outboundFilePublicOrigin: normalizeHttpsOrigin(env("OUTBOUND_FILE_PUBLIC_ORIGIN", "")),
    stickerPickerEnabled: flag("STICKER_PICKER_ENABLED", false),
    messageMediaDir: env("MESSAGE_MEDIA_DIR", ""),
    // A legacy PDF is 54.3 MiB, so the safe default is 64 MiB. Clamp ceilings
    // protect operators from accidentally turning a chat attachment path into a
    // bulk-storage endpoint.
    messageMediaMaxBytes: Math.min(128 * 1024 * 1024, Math.max(1 * 1024 * 1024, num("MESSAGE_MEDIA_MAX_BYTES", 64 * 1024 * 1024))),
    messageMediaImageMaxBytes: Math.min(64 * 1024 * 1024, Math.max(1 * 1024 * 1024, num("MESSAGE_MEDIA_IMAGE_MAX_BYTES", 10 * 1024 * 1024))),
    messageMediaTotalBytes: Math.min(100 * 1024 * 1024 * 1024, Math.max(256 * 1024 * 1024, num("MESSAGE_MEDIA_TOTAL_BYTES", 4 * 1024 * 1024 * 1024))),
    messageMediaMaxActive: Math.min(100_000, Math.max(1, num("MESSAGE_MEDIA_MAX_ACTIVE", 10_000))),
    // เพดานไบต์อัปโหลดต่อ operator ต่อชั่วโมง — consoleApi.mjs อ่านคีย์นี้อยู่แล้ว
    // ค่าเริ่มต้นคงพฤติกรรมเดิมเป๊ะ (messageMediaMaxBytes * 2 = 128 MiB จาก default 64 MiB)
    messageMediaOperatorHourlyBytes: Math.min(8 * 1024 * 1024 * 1024, Math.max(1 * 1024 * 1024, num("MESSAGE_MEDIA_OPERATOR_HOURLY_BYTES", 128 * 1024 * 1024))),
    messageMediaUploadsPerOperatorHour: Math.min(500, Math.max(1, num("MESSAGE_MEDIA_UPLOADS_PER_OPERATOR_HOUR", 30))),
    messageMediaMaxConcurrentUploads: Math.min(16, Math.max(1, num("MESSAGE_MEDIA_MAX_CONCURRENT_UPLOADS", 4))),
    messageMediaMaxConcurrentPerOperator: Math.min(4, Math.max(1, num("MESSAGE_MEDIA_MAX_CONCURRENT_PER_OPERATOR", 2))),
    messageMediaUploadBodyTimeoutMs: Math.min(5 * 60_000, Math.max(1_000, num("MESSAGE_MEDIA_UPLOAD_BODY_TIMEOUT_MS", 60_000))),
    messageMediaMinFreeBytes: Math.min(100 * 1024 * 1024 * 1024, Math.max(100 * 1024 * 1024, num("MESSAGE_MEDIA_MIN_FREE_BYTES", 1 * 1024 * 1024 * 1024))),
    // อายุสิทธิ์เข้าถึงสื่อขาออก (ลิงก์ที่เครื่องลูกค้าใช้ดึงไฟล์จากเรา)
    //
    // เดิมรูปตั้งไว้ 15 นาที ด้วยสมมติฐานว่า "LINE ดึงรูปทันทีแล้วจบ" ซึ่งไม่จริง —
    // เครื่องลูกค้าดึงซ้ำเมื่อเลื่อนกลับมาดูแชทเก่า พอสิทธิ์หมดอายุ รูปในแชทของลูกค้า
    // จึงกลายเป็นกรอบดำถาวร (พี่ง้วงเจอเอง 2026-08-27: รูปที่ส่ง 21:26 พังตอน 01:08)
    //
    // ตัวไฟล์ไม่เคยหายไปไหน ยังอยู่ครบบนดิสก์ — หายแค่ "สิทธิ์เข้าถึง" อย่างเดียว
    // และเส้น /line-media ตั้งใจให้ดึงซ้ำได้อยู่แล้ว (ดู consumeAttachmentDownloadToken
    // ใน db.mjs) เพดานเวลาจึงเป็นตัวเดียวที่ทำให้พัง
    //
    // พี่ง้วงสั่ง 2026-08-27: "ให้รูป มีเดีย อยู่ได้ยาว ๆ เลย" และเคยระบุก่อนหน้าว่า
    // ลิงก์หมดอายุไม่จำเป็นเพราะระบบนี้ใช้กันสองคน จึงยืดเป็น 10 ปีทั้งรูปและไฟล์
    //
    // ยังคงเป็นค่าจำกัดโดยเจตนา ไม่ใช่ "ไม่มีวันหมด": เส้นลบข้อมูลตาม PDPA ลบทั้ง grant
    // และไฟล์จริงอยู่แล้ว การคงคอลัมน์ expires_at ไว้ทำให้กลไกเพิกถอนทำงานเหมือนเดิม
    // และย่นกลับได้ทันทีผ่าน env ถ้าวันหนึ่งนโยบายเปลี่ยน
    outboundImageLinkTtlMs: Math.min(OUTBOUND_LINK_TTL_CAP_MS, Math.max(60_000, num("OUTBOUND_IMAGE_LINK_TTL_MS", OUTBOUND_LINK_TTL_CAP_MS))),
    outboundFileLinkTtlMs: Math.min(OUTBOUND_LINK_TTL_CAP_MS, Math.max(60_000, num("OUTBOUND_FILE_LINK_TTL_MS", OUTBOUND_LINK_TTL_CAP_MS))),
    messageMediaIngestIntervalMs: Math.max(1_000, num("MESSAGE_MEDIA_INGEST_INTERVAL_MS", 15_000)),
    messageMediaIngestBatch: Math.min(10, Math.max(1, num("MESSAGE_MEDIA_INGEST_BATCH", 2))),
    messageMediaIngestMaxAttempts: Math.min(12, Math.max(1, num("MESSAGE_MEDIA_INGEST_MAX_ATTEMPTS", 6))),
    safetyRulesFile: env("SAFETY_RULES_FILE", ""),
    // v1.4.31: ไฟล์รอบเรียน (อ่านอย่างเดียว) — ไม่ตั้ง = ปิดเมนูที่นั่งคงเหลือทั้งหมด
    // ตัวเลขที่นั่งไม่ได้อยู่ในไฟล์นี้ แต่อยู่ใน DB เพราะแก้บ่อยกว่ากันมาก
    classRoundsFile: env("CLASS_ROUNDS_FILE", ""),
    // Optional per-instance wording for the deterministic identity route.
    // safetyRouter validates an override and legacy instances retain its default.
    identityTemplate: env("IDENTITY_TEMPLATE", ""),
    // 20 ต.ค. 2026 (คำตอบ C4 ข้อ 12 ของ soul ลูกแพร): ถ้อยคำตอบตอนลูกค้าแจ้งโอนของร้าน — ว่าง = ค่ากลางของ safetyRouter (PAYMENT_TEMPLATE)
    paymentTemplate: env("PAYMENT_TEMPLATE", ""),
    brandPack: env("BRAND_PACK", ""),
    // กรอบป้ายลูกค้าชุดเดียว (tag-framework.json ของแต่ละธุรกิจ) — ว่าง = ป้าย AI แบบเดิม
    // วางท้ายสุดโดยเจตนา: ทะเบียนคีย์ของ instance จดเลขบรรทัด การแทรกกลางทำให้ diff ของทะเบียนบวม
    tagFrameworkFile: env("TAG_FRAMEWORK_FILE", ""),

    // 28 ก.ย. 2026: ดึงสถิติทางการรายวันของ LINE (บรอดแคสต์จาก OA Manager ฯลฯ) มาแยกที่มาของโควตา
    // อ่านอย่างเดียว วันละคำขอต่อ OA (บูตแรกเติมทั้งเดือน) · arm เฉพาะ LINE_LIVE_SEND=true ที่ไม่ใช่ mock · 0 = ปิด
    // ขั้นต่ำ 10 นาที · รอบละไม่เกิน 20 คำขอต่อ OA และวันเดิมลองซ้ำไม่ถี่กว่า 3 ชม. — ต่ำกว่าเพดาน 60 คำขอ/ชม. ของ endpoint นี้
    // (วางท้ายก้อนโดยเจตนา: ทะเบียนคีย์ของ instance จดเลขบรรทัด — เพิ่มกลางไฟล์ = เลขบรรทัดคีย์อื่นเลื่อนทั้งไฟล์)
    lineInsightTickMs: (() => {
      const ms = num("LINE_INSIGHT_TICK_MS", 60 * 60_000);
      return ms > 0 ? Math.max(10 * 60_000, ms) : 0;
    })(),
    // 28 ก.ย. 2026: LINE ID ของ OA (โหมด channel เดียว) — ลิงก์ "ต่อแชทใน LINE" ที่ส่งให้ลูกค้า Facebook
    // (identityLink.mjs) ค่าว่าง/ผิดรูป = ปุ่มส่งลิงก์ใช้ไม่ได้ ไม่เดาค่าเอง (ตรวจรูปแบบที่ channels.mjs)
    // วางท้ายก้อนด้วยเหตุผลเดียวกับบรรทัดบน (เลขบรรทัดในทะเบียนคีย์ของ instance)
    lineBasicId: env("LINE_BASIC_ID"),

    schemaVersion: 1,
  };
  // B3: สวิตช์ transcribe ผูกกับการมี key เท่านั้น (SPEC G2b)
  config.transcribeEnabled = Boolean(config.openaiApiKey);

  // degraded = ส่วนที่ต้องปฏิเสธ endpoint ที่เกี่ยว (503) ไม่ใช่แค่เตือน
  // console: ไม่มี session secret = ปฏิเสธ /console ทั้งหมด (เช็คบัญชี operator เพิ่มตอน runtime)
  config.degraded = {
    dashboard: !config.dashboardApiKey,
    lineWebhook: !config.lineChannelSecret,
    hermes: !config.hermesBase,
    console: !config.consoleSessionSecret,
  };
  return config;
}

// รายงานตอน start ให้คนเห็นชัดว่าอะไรพร้อม/ไม่พร้อม
export function startupReport(config) {
  const lines = [];
  lines.push(`host=${config.bindHost || "all"} port=${config.port} db=${config.dbFile}`);
  if (config.degraded.lineWebhook) {
    lines.push("DEGRADED: ไม่มี LINE_CHANNEL_SECRET — /webhooks/line จะตอบ 503");
  }
  if (config.degraded.dashboard) {
    lines.push("DEGRADED: ไม่มี DASHBOARD_API_KEY — /api/* จะตอบ 503");
  }
  if (config.degraded.hermes) {
    lines.push("DEGRADED: ไม่มี HERMES_BASE — AI path จะใช้ rule fallback + mark human review");
  }
  if (config.degraded.console) {
    lines.push("DEGRADED: ไม่มี CONSOLE_SESSION_SECRET — /console จะตอบ 503");
  }
  lines.push(
    config.canaryIntervalMs > 0
      ? `Canary: ON ทุก ${config.canaryIntervalMs}ms (user=${config.canaryUserId})`
      : "Canary: OFF (ตั้ง CANARY_INTERVAL_MS > 0 เพื่อเปิด)"
  );
  lines.push(
    `ปิดอย่างเรียบร้อย: drain ${Math.round(config.shutdownDrainMs / 1000)}s / abort draft ${Math.round(config.shutdownDraftAbortMs / 1000)}s / hard exit ${Math.round(config.shutdownHardExitMs / 1000)}s`
    + "  ** ต้องน้อยกว่า TimeoutStopSec ของ systemd unit บนเครื่องจริง **"
  );
  lines.push(
    config.lineLiveSend
      ? "LINE live send: ON (ยิง LINE จริง)"
      : `LINE live send: OFF (fail-closed)${config.lineMockUrl ? ` — mock: ${config.lineMockUrl}` : ""}`
  );
  lines.push(
    config.lineInsightTickMs > 0 && config.lineLiveSend && !config.lineMockUrl
      ? `LINE usage: ดึงสถิติรายวันของ LINE ทุก ${config.lineInsightTickMs}ms (อ่านอย่างเดียว · การ์ด "LINE OA เดือนนี้")`
      : "LINE usage: สถิติรายวันของ LINE OFF (ต้องยิง LINE จริง และ LINE_INSIGHT_TICK_MS > 0) — บัญชีการส่งของระบบยังบันทึกตามปกติ"
  );
  lines.push(
    config.followupIntervalMs > 0
      ? `Follow-up: scheduler ทุก ${config.followupIntervalMs}ms — env default ${config.followupEnabled ? "ON" : "OFF"} (สวิตช์ runtime ใน console ชนะ)`
      : "Follow-up: OFF (FOLLOWUP_INTERVAL_MS=0)"
  );
  lines.push(
    config.transcribeEnabled
      ? `Transcribe เสียง: ON (model=${config.transcribeModel})`
      : "Transcribe เสียง: OFF (ไม่มี OPENAI_API_KEY — ข้อความเสียงจะได้ template ขอโทษ + รอคน)"
  );
  {
    // ตรรกะเดียวกับ resolveSlipProvider ใน slipCheck.mjs — แก้ที่หนึ่งต้องแก้อีกที่
    const p = (config.slipProvider || "").toLowerCase();
    const provider =
      p === "off" ? "off"
      : p === "slipok" ? (config.slipokApiKey && config.slipokBranchId ? "slipok" : "off")
      : config.slipCheckUrl ? "webhook" : "off";
    lines.push(
      provider === "off"
        ? "Slip check: OFF (ตั้ง SLIP_PROVIDER=slipok + SLIPOK_API_KEY/SLIPOK_BRANCH_ID หรือ SLIP_CHECK_URL เพื่อเปิด)"
        : `Slip check: ON provider=${provider} (pre-check ให้แอดมิน — บอทไม่ยืนยันยอดกับลูกค้าเสมอ)`
    );
  }
  if (config.channelsFile) {
    lines.push(`Multi-OA: CHANNELS_FILE=${config.channelsFile} (รายละเอียดตอนโหลดจริงใน src/channels.mjs)`);
  }
  lines.push(
    config.orderWebhookUrl
      ? "Order webhook: ON (ยิงตอนออเดอร์ confirmed/paid — ล้มเหลว log อย่างเดียว ไม่ block)"
      : "Order webhook: OFF (ตั้ง ORDER_WEBHOOK_URL เพื่อเชื่อม Make/Sheets/ระบบลูกค้า)"
  );
  lines.push(
    config.mediaUploadEnabled && config.mediaDir && config.mediaPublicBaseUrl
      ? "Broadcast media upload: configured (runtime จะตรวจ HTTPS origin + directory อีกชั้น)"
      : "Broadcast media upload: OFF (ตั้ง MEDIA_UPLOAD_ENABLED=true + MEDIA_DIR + MEDIA_PUBLIC_BASE_URL เพื่อเปิด)"
  );
  lines.push(
    config.broadcastScheduleEnabled
      ? `Broadcast schedule: armed every ${config.broadcastScheduleTickMs}ms (Asia/Bangkok quiet 21:00-09:00)`
      : "Broadcast schedule: OFF (BROADCAST_SCHEDULE_ENABLED=false)"
  );
  lines.push(
    config.needsHumanSlaEnabled && config.needsHumanSlaTickMs > 0
      ? `SLA คิวรอคน: ON — เตือนเมื่อรอเกิน ${config.needsHumanSlaMinutes} นาที สูงสุด ${config.needsHumanSlaMaxReminders} ครั้ง เฉพาะช่วง ${config.needsHumanSlaHours} (ตรวจทุก ${config.needsHumanSlaTickMs}ms)`
        + "\n           push เฉพาะห้องที่ต้องใช้คน (ร้องเรียน/ขอให้หยุดทัก/ขอคุยกับคนจริง/private class-in-house/opportunity/วิกฤตสุขภาพจิต)"
        + " — ห้องรอคนทั่วไปไม่ push แต่ยังเห็นในคิวคอนโซลและสรุปรายวัน"
      : "SLA คิวรอคน: OFF (NEEDS_HUMAN_SLA_ENABLED=false หรือ NEEDS_HUMAN_SLA_TICK_MS=0 — ห้องที่รอคนจะไม่มีอะไรทวงซ้ำ)"
  );
  lines.push(
    config.retentionEnabled
      ? "Retention: ON (ลบข้อมูลเก่ารายวัน — events_dedupe/llm_usage/score_history/admin_audit/schedule_ack)"
      : "Retention: OFF (RETENTION_ENABLED=false — ตารางโตไม่จำกัด)"
  );
  lines.push(
    config.digestLineUserId
      ? `Owner digest: armed เวลา ${config.digestTimes} — env default ${config.digestEnabled ? "ON" : "OFF"} (สวิตช์ runtime ใน console ชนะ)`
      : "Owner digest: OFF (ตั้ง DIGEST_LINE_USER_ID เพื่อเปิดสรุปรายวันถึงเจ้าของ)"
  );
  lines.push(
    `Daily learning: ${config.learningDigestEnabled ? "ON" : "OFF"} ` +
    `(proposal-only, human approval required, Stage B ${config.learningModelEnabled ? `model=${config.learningModel}` : "OFF"}, cap $${config.learningDailyUsdCap.toFixed(2)}/day)`
  );
  return lines;
}

// โหลด persona จากไฟล์. Legacy instance ที่ไม่ตั้ง hash ยังคงคืนค่าว่างเมื่อ
// ไม่มีไฟล์; isolated instance ที่ตั้ง PERSONA_SHA256 ต้อง fail closed ที่จุด
// อ่านจริง เพื่อไม่ให้เกิดช่องว่างระหว่าง preflight กับ chassis startup.
export function loadPersona(config) {
  let persona;
  try {
    persona = readFileSync(config.personaFile, "utf8");
  } catch (error) {
    if (config.personaSha256) {
      throw new Error(`Persona integrity check failed: configured persona file is unreadable (${error?.code || "read_error"}).`);
    }
    return "";
  }
  if (!config.personaSha256) return persona;
  if (!/^[a-f0-9]{64}$/u.test(config.personaSha256)) {
    throw new Error("Persona integrity check failed: PERSONA_SHA256 must be 64 lowercase hex characters.");
  }
  const actual = createHash("sha256").update(persona).digest("hex");
  if (actual !== config.personaSha256) {
    throw new Error("Persona integrity check failed: persona content does not match PERSONA_SHA256.");
  }
  return persona;
}
