// Privacy boundary for Claude-facing chat exports. This module never opens a
// database itself; the CLI supplies a SQLite read-only handle explicitly.
import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export const CLAUDE_EXPORT_TESTERS_KEY = "claude_export_testers";
export const CLAUDE_EXPORT_TESTERS_MAX = 50;
export const CLAUDE_EXPORT_RETENTION_DAYS = 90;
const LINE_ID_RE = /^U[0-9a-f]{32}$/iu;
const DAY_MS = 86_400_000;

const THAI_NAMES = Object.freeze([
  "กานต์", "ขวัญ", "ชล", "ณิชา", "ธนา", "ปริม", "พิม", "ภัทร", "มิน", "วิน",
  "ศศิ", "อิง", "อ้อม", "เมย์", "แพรว", "นนท์", "ต้น", "ฝน", "นัท", "พลอย",
]);
const THAI_SURNAMES = Object.freeze([
  "ใจดี", "มั่นคง", "รุ่งเรือง", "สุขสันต์", "แสงทอง", "ก้าวไกล", "วัฒนา", "ศรีสุข",
]);
const FAKE_COMPANIES = Object.freeze([
  "บริษัท แสงใหม่ จำกัด", "บริษัท ก้าวดี จำกัด", "บริษัท บ้านอุ่น จำกัด",
  "บริษัท ฟ้าคราม จำกัด", "บริษัท งานดี จำกัด", "บริษัท พร้อมโต จำกัด",
]);

function digest(value) {
  return createHash("sha256").update(String(value)).digest();
}

export function stableLineAlias(lineUserId) {
  return `lp_${digest(lineUserId).toString("hex").slice(0, 12)}`;
}

export function validClaudeExportTesterIds(value) {
  if (!Array.isArray(value) || value.length > CLAUDE_EXPORT_TESTERS_MAX) return null;
  const ids = [];
  for (const item of value) {
    const id = String(item || "").trim();
    if (!LINE_ID_RE.test(id)) return null;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

export function parseClaudeExportTesterIds(raw) {
  try {
    return validClaudeExportTesterIds(JSON.parse(String(raw || "[]"))) || [];
  } catch {
    return [];
  }
}

function closestStable(list, sourceLength, byte) {
  const ranked = list.map((value, index) => ({ value, index, distance: Math.abs([...value].length - sourceLength) }));
  const bestDistance = Math.min(...ranked.map((item) => item.distance));
  const closest = ranked.filter((item) => item.distance === bestDistance);
  return closest[byte % closest.length].value;
}

export function pseudonymFor(lineUserId, originalName = "") {
  const bytes = digest(lineUserId);
  const length = Math.max(2, [...String(originalName || "")].length);
  const first = closestStable(THAI_NAMES, length, bytes[0]);
  const surname = THAI_SURNAMES[bytes[1] % THAI_SURNAMES.length];
  const company = FAKE_COMPANIES[bytes[2] % FAKE_COMPANIES.length];
  return { name: `${first} ${surname}`, shortName: first, company };
}

const ADDRESS_START_RE = /(ที่อยู่|บ้านเลขที่|หมู่ที่|หมู่\s*\d|หมู่บ้าน|ซอย|ถนน|ตำบล|ต\.|แขวง|อำเภอ|อ\.|เขต|จังหวัด|จ\.|รหัสไปรษณีย์|ส่งของที่|ที่อยู่จัดส่ง|สถานที่จัดส่ง|ข้อมูลจัดส่ง|จัดส่ง\s*[:：]|จัดส่ง(?:ไป)?(?:ที่|ถึง)|ส่ง(?:ไป)?(?:ที่|ถึง)|ข้อมูลผู้รับ|ชื่อผู้รับ|ผู้รับ(?:สินค้า|พัสดุ)|อาคาร|ชั้น|ห้อง|\baddress\b|\bship(?:ping)?\s+to\b|\bshipping\s+address\b|\bdeliver(?:y)?\s+(?:to|address)\b|\brecipient\s+address\b|\bstreet\b|\bst\.?\b|\broad\b|\bavenue\b|\blane\b|\bdistrict\b|\bprovince\b|\bbuilding\b|\bfloor\b|\broom\b|\bsuite\b|\bunit\b|\bpostal(?:\s+code)?\b|\bpostcode\b|\bbangkok\b|\bthailand\b)/iu;
const STRUCTURED_HOUSE_NUMBER_RE = /^\s*\d{1,5}(?:[/.-]\d{1,5})+(?:\s|$)/u;
const HIGH_ENTROPY_TOKEN_RE = /(?<![A-Za-z0-9+/_=-])[A-Za-z0-9+/_=-]{32,}(?![A-Za-z0-9+/_=-])/gu;

function maskAddressBlocks(value) {
  let insideAddressBlock = false;
  return String(value ?? "").split(/\r?\n/u).map((line) => {
    if (ADDRESS_START_RE.test(line) || STRUCTURED_HOUSE_NUMBER_RE.test(line)) {
      insideAddressBlock = true;
      return "[ADDRESS-REDACTED]";
    }
    if (!line.trim()) {
      insideAddressBlock = false;
      return line;
    }
    if (insideAddressBlock) return "[ADDRESS-REDACTED]";
    return line;
  }).join("\n");
}

function maskSecrets(value) {
  let text = String(value ?? "");
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/giu, "Bearer [SECRET-REDACTED]");
  text = text.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}\b/giu, "[SECRET-REDACTED]");
  text = text.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, "[SECRET-REDACTED]");
  text = text.replace(
    /((?:api[_ -]?key|access[_ -]?token|channel[_ -]?access[_ -]?token|reply[_ -]?token|authorization|password|passwd|secret|cookie|session[_ -]?token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1[SECRET-REDACTED]",
  );
  return text;
}

export function maskFixedPii(value) {
  let text = maskSecrets(value);
  text = text.replace(/(?<![A-Za-z0-9])[UCR][0-9a-f]{32}(?![A-Za-z0-9])/giu, "[LINE-ID-REDACTED]");
  text = text.replace(/(?<![0-9a-f])[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}(?![0-9a-f])/giu, "[IDENTIFIER-REDACTED]");
  text = text.replace(/(?<!\d)(?:\d{13}|\d-\d{4}-\d{5}-\d{2}-\d)(?!\d)/gu, "[THAI-ID-REDACTED]");
  text = text.replace(/(?<!\d)(?:\+?66|0)[\s.-]?[1-9](?:[\s.-]?\d){7,8}(?!\d)/gu, "08X-XXX-XXXX");
  text = text.replace(/(?<!\d)\d(?:[\s.-]?\d){9,11}(?!\d)/gu, "XXX-X-XXXXX-X");
  text = text.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[EMAIL-REDACTED]");
  text = text.replace(/https?:\/\/[^\s<>()\[\]{}"']+/giu, "[URL-REDACTED]");
  text = text.replace(/(?<![\p{L}\p{N}])[\p{L}\p{N}_. -]{1,100}\.(?:pdf|docx?|xlsx?|csv|zip|jpe?g|png|gif|webp|heic|mp4|mov|m4a|mp3)(?![\p{L}\p{N}])/giu, "[FILE-NAME-REDACTED]");
  text = text.replace(HIGH_ENTROPY_TOKEN_RE, "[TOKEN-REDACTED]");
  return maskAddressBlocks(text);
}

function replaceLiteral(text, source, replacement) {
  const needle = String(source || "").trim();
  if (!needle) return text;
  return text.split(needle).join(replacement);
}

function transformText(value, identity) {
  let text = maskFixedPii(value);
  if (identity.mode !== "pseudonymized") return text;
  for (const realName of identity.realNames) text = replaceLiteral(text, realName, identity.pseudonym.shortName);
  for (const company of identity.realCompanies) text = replaceLiteral(text, company, identity.pseudonym.company);
  return text;
}

function safeJson(value, identity, depth = 0) {
  if (depth > 6) return "[TRUNCATED]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return transformText(value, identity);
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => safeJson(item, identity, depth + 1));
  if (typeof value !== "object") return String(value);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    // JSON keys are data too. Dropping a key whose masked form differs prevents
    // raw LINE IDs, tokens, filenames, or contact details from leaking through
    // an otherwise innocuous value.
    if (maskFixedPii(key) !== key) continue;
    const canonical = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
    const sensitive = canonical === "id" || canonical.endsWith("id") ||
      /(?:filename|originalname|filepath|storagekey|picture|avatar|url|uri|href|link|token|secret|cookie|password|passwd|authorization|credential|signature|webhook|apikey|accesskey|phone|address|tax|bank|email|accountnumber)/u.test(canonical);
    if (sensitive) continue;
    out[key] = safeJson(item, identity, depth + 1);
  }
  return out;
}

function parseJson(raw, fallback) {
  try {
    return JSON.parse(String(raw || ""));
  } catch {
    return fallback;
  }
}

function exactCustomer(rawDb, selector) {
  const query = String(selector || "").trim();
  if (!query) throw new Error("customer selector is required");
  if (LINE_ID_RE.test(query) || /^(?:[^:]+:)?U[0-9a-f]{32}$/iu.test(query)) {
    throw new Error("raw LINE user ID is not accepted; use an exact name or stable alias");
  }
  const customers = rawDb.prepare(
    "SELECT line_user_id,display_name,known_name FROM customers WHERE line_user_id NOT LIKE 'canary:%'",
  ).all();
  const queryLower = query.toLocaleLowerCase("th-TH");
  const matches = customers.filter((row) => {
    if (stableLineAlias(row.line_user_id) === queryLower) return true;
    return [row.display_name, row.known_name].some((name) => String(name || "").trim().toLocaleLowerCase("th-TH") === queryLower);
  });
  if (matches.length !== 1) throw new Error(matches.length ? "customer selector is ambiguous" : "customer not found");
  return matches[0].line_user_id;
}

function attachmentMarker(kind, isSlip) {
  if (isSlip) return "[SLIP-IMAGE-REDACTED]";
  const labels = { image: "IMAGE", file: "FILE", sticker: "STICKER", audio: "AUDIO", video: "VIDEO" };
  return `[${labels[kind] || "ATTACHMENT"}-OMITTED]`;
}

function rows(rawDb, sql, customerId) {
  return rawDb.prepare(sql).all(customerId);
}

export function buildClaudeChatExport(rawDb, { customer, generatedAt = Date.now() } = {}) {
  if (!rawDb?.prepare) throw new Error("read-only SQLite handle is required");
  const customerId = exactCustomer(rawDb, customer);
  const customerRow = rawDb.prepare("SELECT * FROM customers WHERE line_user_id=?").get(customerId);
  if (!customerRow) throw new Error("customer not found");
  const testers = parseClaudeExportTesterIds(
    rawDb.prepare("SELECT value FROM settings WHERE key=?").get(CLAUDE_EXPORT_TESTERS_KEY)?.value,
  );
  const isTester = testers.includes(customerId);
  const facts = rows(rawDb, "SELECT fact_key,value FROM customer_facts WHERE customer_id=?", customerId);
  const companyNames = facts.filter((row) => row.fact_key === "company_name").map((row) => row.value).filter(Boolean);
  const pseudonym = pseudonymFor(customerId, customerRow.known_name || customerRow.display_name);
  const identity = {
    mode: isTester ? "tester_masked" : "pseudonymized",
    pseudonym,
    realNames: [customerRow.known_name, customerRow.display_name].filter(Boolean).sort((a, b) => b.length - a.length),
    realCompanies: companyNames,
  };

  const attachmentRows = rows(
    rawDb,
    "SELECT message_id,kind,status FROM message_attachments WHERE customer_id=? ORDER BY created_at,rowid",
    customerId,
  );
  const attachmentsByMessage = new Map();
  for (const attachment of attachmentRows) {
    if (!attachment.message_id) continue;
    const list = attachmentsByMessage.get(attachment.message_id) || [];
    list.push({ kind: attachment.kind, status: attachment.status });
    attachmentsByMessage.set(attachment.message_id, list);
  }
  const slipMessages = new Set(rows(rawDb, "SELECT message_id FROM slip_checks WHERE customer_id=? AND message_id!=''", customerId).map((row) => row.message_id));
  const messages = rows(
    rawDb,
    `SELECT id,direction,channel,msg_type,content,message_class,operator,agent_mode,metadata_json,created_at
       FROM messages WHERE customer_id=? ORDER BY created_at,rowid`,
    customerId,
  ).map((message, index) => {
    const metadata = parseJson(message.metadata_json, {});
    const silentReason = metadata.silent_reason || metadata.silentReason || metadata.blocked_reason || metadata.blockedReason || "";
    const linked = attachmentsByMessage.get(message.id) || [];
    const markers = linked.map((attachment) => attachmentMarker(attachment.kind, slipMessages.has(message.id)));
    if (!markers.length && message.msg_type !== "text") markers.push(attachmentMarker(message.msg_type, slipMessages.has(message.id)));
    return {
      sequence: index + 1,
      createdAt: Number(message.created_at),
      direction: message.direction,
      channel: message.channel,
      msgType: message.msg_type,
      messageClass: message.message_class,
      operator: maskFixedPii(message.operator || ""),
      agentMode: message.agent_mode || null,
      content: markers.length ? markers.join(" ") : transformText(message.content, identity),
      silentTurnReason: silentReason ? transformText(silentReason, identity) : null,
      attachments: linked.map((attachment) => ({ kind: attachment.kind, status: attachment.status, marker: attachmentMarker(attachment.kind, slipMessages.has(message.id)) })),
    };
  });

  const scoreHistory = rows(
    rawDb,
    "SELECT score,payload_json,created_at FROM score_history WHERE customer_id=? ORDER BY created_at,rowid",
    customerId,
  ).map((row) => ({ score: row.score, createdAt: row.created_at, payload: safeJson(parseJson(row.payload_json, {}), identity) }));
  const handoffNotes = rows(
    rawDb,
    "SELECT author,text,created_at FROM handoff_notes WHERE customer_id=? ORDER BY created_at,rowid",
    customerId,
  ).map((row) => ({ author: maskFixedPii(row.author), text: transformText(row.text, identity), createdAt: row.created_at }));
  const followups = rows(
    rawDb,
    "SELECT scheduled_at,status,created_by,note,detail,created_at,updated_at FROM followups WHERE customer_id=? ORDER BY created_at,rowid",
    customerId,
  ).map((row) => ({
    scheduledAt: row.scheduled_at, status: row.status, createdBy: maskFixedPii(row.created_by),
    note: transformText(row.note, identity), blockedBadgeReason: transformText(row.detail, identity),
    createdAt: row.created_at, updatedAt: row.updated_at,
  }));
  const followupStateRow = rawDb.prepare("SELECT * FROM followup_state WHERE customer_id=?").get(customerId);
  const followupState = followupStateRow
    ? safeJson({ ...followupStateRow, customer_id: undefined, history_json: parseJson(followupStateRow.history_json, []) }, identity)
    : null;
  const tags = rows(rawDb, "SELECT tag,source,created_at FROM customer_tags WHERE customer_id=? ORDER BY created_at,rowid", customerId)
    .map((row) => ({ tag: transformText(row.tag, identity), source: row.source, createdAt: row.created_at }));

  return {
    schemaVersion: 1,
    generatedAt: Number(generatedAt),
    policy: {
      identityMode: identity.mode,
      pseudonymScope: "profile_and_known_company_names_only",
      fixedPiiMasking: "deterministic_pattern_projection",
      source: "manifest_bound_read_only_sqlite_snapshot",
      retentionDays: CLAUDE_EXPORT_RETENTION_DAYS,
    },
    customer: {
      alias: stableLineAlias(customerId),
      displayName: isTester ? maskFixedPii(customerRow.display_name) : pseudonym.name,
      knownName: isTester ? maskFixedPii(customerRow.known_name) : pseudonym.shortName,
      aiEnabled: Boolean(customerRow.ai_enabled),
      aiOffReason: transformText(customerRow.ai_off_reason, identity),
      state: customerRow.state,
      lifecycleStage: customerRow.lifecycle_stage,
      dealStatus: customerRow.deal_status,
      doNotDisturb: Boolean(customerRow.do_not_disturb),
      marketingConsent: Boolean(customerRow.marketing_consent),
    },
    messages,
    tags,
    handoffNotes,
    scoreHistory,
    followups,
    followupState,
  };
}

export function sweepExpiredClaudeExports(directory, { now = Date.now(), days = CLAUDE_EXPORT_RETENTION_DAYS, dryRun = false } = {}) {
  const root = resolve(directory);
  if (root.split("/").at(-1) !== ".claude-exports") throw new Error("export sweep is confined to .claude-exports");
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("refusing symlinked or non-directory .claude-exports root");
  }
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) throw new Error("refusing symlink inside .claude-exports");
  const cutoff = Number(now) - Math.max(1, Number(days) || CLAUDE_EXPORT_RETENTION_DAYS) * DAY_MS;
  const expired = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = resolve(root, entry.name);
    if (!path.startsWith(`${root}/`)) throw new Error("export path escaped .claude-exports");
    if (lstatSync(path).mtimeMs < cutoff) expired.push(path);
  }
  if (!dryRun && expired.length) {
    for (const path of expired) rmSync(path);
    const fd = openSync(root, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return { scanned: entries.length, expired: expired.length, deleted: dryRun ? 0 : expired.length };
}
