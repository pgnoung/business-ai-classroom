// Read-only access to completed retrospective reports. Customer text never
// belongs in these files; current customer/channel permissions are rechecked.
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { isJevAuditExpired } from "./jevAuditRetention.mjs";
import { readAuditFeedback, writeAuditFeedback } from "./jevAuditFeedback.mjs";

const BATCH_ID = /^[a-z0-9][a-z0-9_-]{0,79}$/u;
const MAX_BYTES = 16 * 1024 * 1024;
const str = (value, length = 100) => typeof value === "string" ? value.slice(0, length) : "";
const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const pick = (value, options, fallback = "unknown") => options.includes(value) ? value : fallback;
const comparison = value => pick(value, ["agree", "disagree", "unknown", "not_applicable"]);

function publicCheck(check, choices) {
  const confidence = finite(check?.confidence10);
  return {
    choice: pick(check?.choice, choices, "unclear"),
    confidence10: confidence != null && confidence >= 0 && confidence <= 10 ? confidence : null,
  };
}

function publicCase(row, customer) {
  return {
    id: str(row.id), customerId: str(row.customerId, 180), channelId: str(row.channelId, 100),
    displayName: customer?.known_name || customer?.display_name || "ไม่มีชื่อ",
    atMs: finite(row.atMs), eventKinds: Array.isArray(row.eventKinds) ? row.eventKinds.map(value => str(value)).slice(0, 40) : [],
    original: {
      stop: pick(row.original?.stop, ["permanent", "temporary", "none", "unknown"]),
      notify: pick(row.original?.notify, ["provider_accepted", "attempted", "not_observed", "unknown"]),
    },
    jev: {
      status: pick(row.jev?.status, ["reviewed", "uncertain", "unavailable", "pending", "excluded"], "unavailable"),
      model: str(row.jev?.model),
      stop: publicCheck(row.jev?.stop, ["stop", "continue", "unclear"]),
      notify: publicCheck(row.jev?.notify, ["notify", "not_needed", "unclear"]),
      complaint: publicCheck(row.jev?.complaint, ["none", "elsewhere", "frustration", "complaint", "unclear"]),
      reason: str(row.jev?.reason?.choice || row.jev?.errorCode, 100),
    },
    comparison: { stop: comparison(row.comparison?.stop), notify: comparison(row.comparison?.notify) },
    coverage: {
      messageCount: finite(row.evidenceCoverage?.messagesSeen ?? row.evidenceCoverage?.messageCount),
      omittedCount: finite(row.evidenceCoverage?.omitted ?? row.evidenceCoverage?.omittedMessages),
      imageUnreviewed: row.evidenceCoverage?.imageUnreviewed === true,
      redactionAmbiguous: row.evidenceCoverage?.redactionAmbiguous === true,
    },
  };
}

export function summarizeAuditCases(rows) {
  return {
    cases: rows.length,
    customers: new Set(rows.map(row => row.customerId).filter(Boolean)).size,
    reviewed: rows.filter(row => row.jev.status === "reviewed").length,
    uncertain: rows.filter(row => row.jev.status === "uncertain").length,
    unavailable: rows.filter(row => row.jev.status === "unavailable").length,
    stopDisagreements: rows.filter(row => row.comparison.stop === "disagree").length,
    notifyDisagreements: rows.filter(row => row.comparison.notify === "disagree").length,
    providerAccepted: rows.filter(row => row.original.notify === "provider_accepted").length,
  };
}

export function createConsoleJevAuditRoutes({ config, db, channels = [] }) {
  const cache = new Map();
  function readBatch(id) {
    if (!BATCH_ID.test(id)) return null;
    const configuredDir = resolve(String(config.jevAuditDir));
    // Refuse redirected report roots and individual files, including symlinks.
    if (lstatSync(configuredDir).isSymbolicLink()) throw new Error("audit_directory_invalid");
    const dir = realpathSync(configuredDir);
    const file = join(dir, `${id}.json`);
    let stat;
    try { stat = lstatSync(file); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error("audit_report_invalid");
    const cacheKey = `${stat.mtimeMs}:${stat.size}`;
    const cached = cache.get(id);
    if (cached?.cacheKey === cacheKey) return isJevAuditExpired(cached.batch) || cached.batch.runtime?.execute === false ? null : cached.batch;
    const batch = JSON.parse(readFileSync(file, "utf8"));
    if (batch.schemaVersion !== 1 || batch.batchId !== id || !Array.isArray(batch.cases) || batch.cases.length > 20000) throw new Error("audit_report_invalid");
    if (isJevAuditExpired(batch) || batch.runtime?.execute === false) return null;
    cache.set(id, { cacheKey, batch });
    while (cache.size > 8) cache.delete(cache.keys().next().value);
    return batch;
  }

  function visibleCases(batch, operator, username) {
    const elevated = operator.role === "owner" || operator.role === "admin";
    const assigned = new Set(db.listOperatorChannels(username));
    const configured = channels.map(channel => String(channel.id));
    // Preserve the established single-channel instance behaviour; multi-channel
    // staff receive only assigned channels, even when a channel is inactive.
    if (!elevated && configured.length === 1) assigned.add(configured[0]);
    if (!elevated && configured.length === 0) assigned.add("default");
    const customers = new Map();
    const anchorExists = db.raw.prepare("SELECT 1 FROM messages WHERE id=? AND customer_id=?");
    const historyExists = db.raw.prepare("SELECT 1 FROM messages WHERE customer_id=? AND created_at<=? LIMIT 1");
    return batch.cases.flatMap(row => {
      if (!row || typeof row !== "object" || !row.customerId) return [];
      if (!customers.has(row.customerId)) customers.set(row.customerId, db.getCustomer(row.customerId));
      const customer = customers.get(row.customerId);
      // Forgotten customers and stale/mismatched channel references cannot be
      // resurrected through an audit artifact.
      if (!customer || String(customer.channel_id || "default") !== String(row.channelId || "default")) return [];
      if (!elevated && !assigned.has(String(row.channelId || "default"))) return [];
      if (row.anchorMessageId ? !anchorExists.get(row.anchorMessageId, row.customerId) : !historyExists.get(row.customerId, Number(row.atMs) || 0)) return [];
      const item = publicCase(row, customer);
      Object.defineProperty(item, "_source", { value: row, enumerable: false });
      return [item];
    });
  }

  function durableFeedbackCases(batchId, operator, username) {
    const elevated = operator.role === "owner" || operator.role === "admin";
    const assigned = new Set(db.listOperatorChannels(username));
    if (!elevated && channels.length <= 1) assigned.add(String(channels[0]?.id || "default"));
    const rows = db.raw.prepare("SELECT * FROM jev_audit_feedback WHERE batch_id=? ORDER BY event_at DESC,case_id ASC").all(batchId);
    const customer = db.raw.prepare("SELECT line_user_id,display_name,known_name,channel_id FROM customers WHERE line_user_id=?");
    const anchor = db.raw.prepare("SELECT 1 FROM messages WHERE id=? AND customer_id=?");
    const history = db.raw.prepare("SELECT 1 FROM messages WHERE customer_id=? AND created_at<=? LIMIT 1");
    return rows.flatMap(row => {
      const current = customer.get(row.customer_id);
      const evidenceExists = row.anchor_message_id ? anchor.get(row.anchor_message_id, row.customer_id) : history.get(row.customer_id, row.event_at);
      if (!current || String(current.channel_id || "default") !== String(row.channel_id || "default") || !evidenceExists || (!elevated && !assigned.has(String(row.channel_id || "default")))) return [];
      let comparison = {}; try { comparison = JSON.parse(row.comparison_json || "{}"); } catch { return []; }
      return [{ id: row.case_id, customerId: row.customer_id, channelId: row.channel_id, displayName: current.known_name || current.display_name || "ไม่มีชื่อ", atMs: Number(row.event_at) || 0, eventKinds: [], original: { stop: row.original_stop, notify: row.original_notify }, jev: { status: "reviewed", model: row.model, stop: { choice: row.stop_choice, confidence10: row.stop_confidence_10 }, notify: { choice: row.notify_choice, confidence10: row.notify_confidence_10 }, complaint: { choice: row.complaint_choice, confidence10: row.complaint_confidence_10 }, reason: row.reason_choice }, comparison: { stop: comparison.stop || "unknown", notify: comparison.notify || "unknown" }, feedback: { stop: row.stop_label, notify: row.notify_label, note: row.note, reviewer: row.reviewer, reviewedAt: row.reviewed_at, revision: row.revision }, canReview: operator.role === "owner" }];
    });
  }

  function metadata(batch, rows) {
    return {
      batchId: batch.batchId, startMs: finite(batch.startMs), cutoffMs: finite(batch.cutoffMs),
      createdAt: finite(batch.createdAt), completedAt: finite(batch.completedAt), policy: str(batch.policy, 160),
      counts: summarizeAuditCases(rows),
      notice: "ประเมินด้วยกติกาปัจจุบันและข้อมูลก่อนเหตุการณ์ คะแนนคือความมั่นใจของ JEV ผลต่างยังไม่ใช่ข้อผิดพลาดที่คนยืนยัน และไม่เปลี่ยนสถานะ AI",
    };
  }

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "jev-audits") return false;
    const { json, operator, username } = ctx;
    if (!config.chatHistoryEnabled || !config.jevAuditDir) { json(res, 404, { ok: false, error: "ยังไม่เปิดผลตรวจย้อนหลัง" }); return true; }
    if (!hasOperatorCapability(operator, "operations.use")) { json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ดูประวัติ" }); return true; }
    if (req.method !== "GET" && req.method !== "PUT") { json(res, 405, { ok: false, error: "ไม่รองรับคำขอนี้" }); return true; }
    try {
      if (route.length === 1) {
        let names;
        try { names = readdirSync(config.jevAuditDir); } catch (error) { if (error.code === "ENOENT") names = []; else throw error; }
        const batches = [];
        for (const name of names.filter(name => name.endsWith(".json")).slice(0, 100)) {
          const batch = readBatch(name.slice(0, -5));
          if (!batch) continue;
          const rows = visibleCases(batch, operator, username);
          if (rows.length) batches.push(metadata(batch, rows));
        }
        // Labels outlive the 30-day raw report.  Offer their batch selector
        // only when at least one current, authorized anchored case remains.
        for (const row of db.raw.prepare("SELECT batch_id,MAX(reviewed_at) AS latest_reviewed_at FROM jev_audit_feedback GROUP BY batch_id ORDER BY latest_reviewed_at DESC LIMIT 100").all()) {
          if (batches.some(batch => batch.batchId === row.batch_id)) continue;
          const saved = durableFeedbackCases(row.batch_id, operator, username);
          if (saved.length) batches.push({ batchId: row.batch_id, startMs: null, cutoffMs: null, createdAt: null, completedAt: null, policy: "retained_owner_feedback", counts: { cases: saved.length, customers: new Set(saved.map(item => item.customerId)).size, reviewed: saved.length }, retainedFeedback: true, notice: "ไฟล์ผลตรวจหมดอายุแล้ว เหลือเฉพาะ feedback ที่ owner ยืนยัน" });
        }
        batches.sort((a, b) => (b.cutoffMs || 0) - (a.cutoffMs || 0));
        json(res, 200, { ok: true, batches }); return true;
      }
      if (req.method === "PUT" && route.length === 5 && route[2] === "cases" && route[4] === "review" && BATCH_ID.test(route[1])) {
        if (operator.role !== "owner") { json(res, 403, { ok: false, error: "เฉพาะ owner ที่บันทึกผลตรวจได้" }); return true; }
        if (!ctx.requireCsrf?.()) { json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" }); return true; }
        const batch = readBatch(route[1]); if (!batch) { json(res, 404, { ok: false, error: "ไม่พบชุดตรวจ" }); return true; }
        const selected = visibleCases(batch, operator, username).find(row => row.id === route[3]);
        const source = selected?._source;
        const validVerdict = source && /^[a-f0-9]{64}$/u.test(String(source.evidenceHash || "")) && source.jev?.model === "jev-1.13.0" && ["stop", "continue", "unclear"].includes(source.jev?.stop?.choice) && ["notify", "not_needed", "unclear"].includes(source.jev?.notify?.choice);
        if (!selected || !validVerdict || selected.jev.status !== "reviewed") { json(res, 404, { ok: false, error: "ไม่พบเคสที่ตรวจได้" }); return true; }
        const body = await ctx.readJson(req, 4096);
        if ((body?.stop != null && source.jev.stop.choice === "unclear") || (body?.notify != null && source.jev.notify.choice === "unclear")) { json(res, 400, { ok: false, error: "เลือกป้ายได้เฉพาะผล JEV ที่ชัดเจน" }); return true; }
        const saved = writeAuditFeedback({ db, batchId: batch.batchId, caseRow: selected._source, reviewer: username, input: body });
        if (!saved.ok) { json(res, saved.code === "review_conflict" ? 409 : 400, { ok: false, error: saved.code, currentRevision: saved.currentRevision }); return true; }
        db.addAudit({ operator: username, action: "jev_audit_feedback", target: `${batch.batchId}:${source.id}`, detail: `revision=${saved.row.revision}; labels_saved=true; owner_learning=${config.jevOwnerLearningEnabled === true}; no_knowledge_publication=true` });
        json(res, 200, { ok: true, review: { stop: saved.row.stop_label, notify: saved.row.notify_label, note: saved.row.note, reviewer: saved.row.reviewer, reviewedAt: saved.row.reviewed_at, revision: saved.row.revision } }); return true;
      }
      if (route.length === 3 && route[2] === "threads" && BATCH_ID.test(route[1])) {
        const batch = readBatch(route[1]);
        let visible = batch ? visibleCases(batch, operator, username) : durableFeedbackCases(route[1], operator, username);
        if (!visible.length) { json(res, 404, { ok: false, error: "ไม่พบชุดตรวจ" }); return true; }
        const requestedChannel = url.searchParams.get("channel") || "";
        if (requestedChannel) visible = visible.filter(row => row.channelId === requestedChannel);
        const filter = url.searchParams.get("filter") || "all";
        const valid = new Set(["all", "agreement", "disagreement", "uncertain", "unreviewed", "reviewed"]); if (!valid.has(filter)) { json(res, 400, { ok:false,error:"ตัวกรองไม่ถูกต้อง" }); return true; }
        const feedback = batch ? readAuditFeedback(db, batch.batchId, visible.map(row => row.id)) : new Map(visible.map(row => [`${row.id}:saved`, row.feedback]));
        const q = str(url.searchParams.get("q"), 160).toLowerCase(); const grouped = new Map();
        for (const row of visible) { const f = batch ? feedback.get(`${row.id}:${row._source.evidenceHash}`) : row.feedback; const agreement = row.comparison.stop === "agree" && row.comparison.notify === "agree"; const disagreement = row.comparison.stop === "disagree" || row.comparison.notify === "disagree"; const matches = filter === "all" || (filter === "agreement" && agreement) || (filter === "disagreement" && disagreement) || (filter === "uncertain" && !agreement && !disagreement) || (filter === "reviewed" && Boolean(f)) || (filter === "unreviewed" && !f); if (!matches || (q && !`${row.displayName} ${row.customerId}`.toLowerCase().includes(q))) continue; const prior = grouped.get(row.customerId) || { customerId: row.customerId, customerName: row.displayName, channelId: row.channelId, latestAt: row.atMs || 0, firstCaseId: row.id, counts: { cases: 0, agreement: 0, disagreement: 0, uncertain: 0, reviewed: 0 } }; prior.counts.cases++; prior.counts.agreement += agreement ? 1 : 0; prior.counts.disagreement += disagreement ? 1 : 0; prior.counts.uncertain += !agreement && !disagreement ? 1 : 0; prior.counts.reviewed += f ? 1 : 0; if ((row.atMs || 0) > prior.latestAt) { prior.latestAt = row.atMs || 0; prior.firstCaseId = row.id; } grouped.set(row.customerId, prior); }
        const rawLimit = url.searchParams.get("limit") || "30"; const rawCursor = url.searchParams.get("cursor") || "0";
        if (!/^\d{1,2}$/u.test(rawLimit) || !/^\d{1,6}$/u.test(rawCursor) || Number(rawLimit) < 1 || Number(rawLimit) > 30) { json(res, 400, { ok:false,error:"หน้าข้อมูลไม่ถูกต้อง" }); return true; }
        const threads = [...grouped.values()].sort((a,b) => b.latestAt-a.latestAt || a.customerId.localeCompare(b.customerId)); const offset=Number(rawCursor), limit=Number(rawLimit), page=threads.slice(offset, offset+limit), hasMore=offset+limit<threads.length; json(res, 200, { ok:true,batch:batch ? metadata(batch,visible) : { batchId:route[1],retainedFeedback:true },threads:page,hasMore,nextCursor:hasMore?String(offset+limit):null }); return true;
      }
      if (route.length !== 3 || route[2] !== "cases" || !BATCH_ID.test(route[1])) { json(res, 404, { ok: false, error: "ไม่พบชุดตรวจ" }); return true; }
      const batch = readBatch(route[1]);
      const durable = !batch;
      const visible = durable ? durableFeedbackCases(route[1], operator, username) : visibleCases(batch, operator, username);
      if (!visible.length) { json(res, 404, { ok: false, error: "ไม่พบชุดตรวจ" }); return true; }
      const customerId = url.searchParams.get("customerId") || "";
      const channelId = url.searchParams.get("channel") || "";
      const filter = url.searchParams.get("filter") || "all";
      if (!["all", "agreement", "disagreement", "uncertain", "unavailable", "reviewed", "unreviewed"].includes(filter)) { json(res, 400, { ok: false, error: "ตัวกรองไม่ถูกต้อง" }); return true; }
      const rawCursor = url.searchParams.get("cursor") || "0";
      const rawLimit = url.searchParams.get("limit") || "50";
      if (!/^\d{1,6}$/u.test(rawCursor) || !/^\d{1,3}$/u.test(rawLimit)) { json(res, 400, { ok: false, error: "หน้าข้อมูลไม่ถูกต้อง" }); return true; }
      const cursor = Number(rawCursor), limit = Math.min(100, Math.max(1, Number(rawLimit)));
      const allFeedback = durable ? new Map(visible.map(row => [`${row.id}:saved`, row.feedback])) : readAuditFeedback(db, batch.batchId, visible.map(row => row.id));
      const filtered = visible.filter(row => { const saved=durable ? row.feedback : allFeedback.get(`${row.id}:${row._source.evidenceHash}`); const agreement=row.comparison.stop === "agree" && row.comparison.notify === "agree"; const disagreement=Object.values(row.comparison).includes("disagree"); const matched=filter === "all" || (filter === "agreement" && agreement) || (filter === "disagreement" && disagreement) || (filter === "uncertain" && !agreement && !disagreement) || (filter === "reviewed" && Boolean(saved)) || (filter === "unreviewed" && !saved) || (filter === "unavailable" && row.jev.status === "unavailable"); return (!customerId || row.customerId === customerId) && (!channelId || row.channelId === channelId) && matched; })
        .sort((a, b) => (b.atMs || 0) - (a.atMs || 0) || a.id.localeCompare(b.id));
      const feedback = durable ? new Map(filtered.map(row => [`${row.id}:saved`, row.feedback])) : readAuditFeedback(db, batch.batchId, filtered.map(row => row.id));
      const rows = filtered.slice(cursor, cursor + limit).map(row => {
        const saved = durable ? row.feedback : feedback.get(`${row.id}:${row._source.evidenceHash}`);
        const value = durable ? saved : (saved ? { stop: saved.stop_label, notify: saved.notify_label, note: saved.note, reviewer: saved.reviewer, reviewedAt: saved.reviewed_at, revision: saved.revision } : null);
        return { ...row, feedback: value, ownerLearningEnabled: config.jevOwnerLearningEnabled === true && config.jevReviewMode === "enforce", canReview: !durable && operator.role === "owner" && row.jev.status === "reviewed" };
      });
      const hasMore = cursor + limit < filtered.length;
      json(res, 200, { ok: true, batch: durable ? { batchId: route[1], retainedFeedback: true, notice: "ไฟล์ผลตรวจหมดอายุแล้ว เป็นประวัติ feedback แบบอ่านอย่างเดียว" } : metadata(batch, visible), rows, total: filtered.length, hasMore, nextCursor: hasMore ? String(cursor + limit) : null });
      return true;
    } catch {
      json(res, 503, { ok: false, error: "อ่านผลตรวจย้อนหลังไม่สำเร็จ กรุณาตรวจไฟล์รายงานบนเซิร์ฟเวอร์" }); return true;
    }
  }
  return { handle };
}
