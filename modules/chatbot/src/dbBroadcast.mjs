// dbBroadcast.mjs — เมธอด DB ของระบบบรอดแคส (v1.2) — แยกไฟล์คุม db.mjs <800 บรรทัด
// audience = ลูกค้าของสาขา ที่ตรง include/exclude tag — กติกาเหล็กที่บังคับใน SQL เสมอ:
// - do_not_disturb = 1 (ลูกค้าขอหยุดการทักไป F5) ไม่มีวันติด audience ไม่ว่า filter อะไร
// - ลูกค้า canary ไม่ปน
// include ว่าง = ลูกค้าทั้งสาขา; มี include = ต้องมี "อย่างน้อยหนึ่ง" ป้ายใน include;
// exclude = มีป้ายไหนใน exclude แม้ป้ายเดียว ก็หลุดจาก audience
import { createHash, randomUUID } from "node:crypto";
import { NOT_SPAM_SQL } from "./spamTag.mjs";

const AUDIENCE_MAX = 10_000;

// 28 ก.ย. 2026 (สตูดิโอบรอดแคสต์): ตัวเลือกป้ายแบบ "ทั้งมิติ" และ "ทุกคนที่ระบบรู้จัก"
//   "มิติ:*"  = ป้ายใดก็ได้ที่ขึ้นต้นด้วย "มิติ:" (เช่น "ซื้อครั้งที่:*" ครอบ "ซื้อครั้งที่: 2") — กรอบป้าย มิติ: ค่า
//   "*"       = (ฝั่ง include เท่านั้น) ทุกคนในแชทที่ส่งถึงได้ — ต้องเลือกเองชัด ๆ ไม่ใช่ค่าว่าง (ด่าน B-1 เดิมคงอยู่)
export const TAG_FILTER_ALL = "*";
const DIMENSION_WILDCARD_RE = /^(.+?)\s*:\s*\*$/u;

export function splitTagFilters(tags = []) {
  const exact = [];
  const prefixes = [];
  let all = false;
  for (const raw of tags) {
    const tag = String(raw || "").trim();
    if (!tag) continue;
    if (tag === TAG_FILTER_ALL) {
      all = true;
      continue;
    }
    const wildcard = DIMENSION_WILDCARD_RE.exec(tag);
    if (wildcard) prefixes.push(`${wildcard[1].trim()}:`);
    else exact.push(tag);
  }
  return { exact, prefixes, all };
}

// เงื่อนไข "มีป้ายตรงชุดนี้" — exact ตรงตัว (ฝั่ง include) หรือไม่สนตัวพิมพ์ (ฝั่ง exclude: ตัดมากไว้ก่อน)
// prefix เทียบด้วย substr/length ของ SQLite (นับตัวอักษร ไม่ใช่ไบต์) — ไม่ใช้ LIKE เพราะ % _ ในชื่อป้ายจะกลายเป็น wildcard
function tagMatchSql(alias, { exact, prefixes }, { caseInsensitive = false } = {}) {
  const parts = [];
  const params = [];
  if (exact.length) {
    parts.push(caseInsensitive
      ? `lower(${alias}.tag) IN (${tagPlaceholders(exact)})`
      : `${alias}.tag IN (${tagPlaceholders(exact)})`);
    params.push(...(caseInsensitive ? exact.map((tag) => tag.toLowerCase()) : exact));
  }
  for (const prefix of prefixes) {
    parts.push(`substr(${alias}.tag, 1, length(?)) = ?`);
    params.push(prefix, prefix);
  }
  return { sql: parts.length ? `(${parts.join(" OR ")})` : "", params };
}

// ใครคือ "ผู้รับบรอดแคสจริง" — ตัวนับกับตัวส่งต้องใช้ชุดนี้ชุดเดียวกันเสมอ
//
// 2026-08-28: เดิมสองฟังก์ชันเขียนเงื่อนไขแยกกัน และตัวนับขาดเงื่อนไขห้องที่ย้ายมาจาก
// LINE OA เดิม ตัวเลขที่คนเห็นก่อนกดส่งจึงพองกว่าความจริงมาก — วันที่เจอ ตัวนับบอก
// 5,551 คน แต่คนที่ได้รับจริงมี 79 คน (ห้องที่เหลือเป็นบันทึกประวัติจากระบบเดิม
// ซึ่ง userId คนละชุดกับ Messaging API ส่งไปก็ไม่ถึง)
//
// การตัดสินใจว่าจะส่งถึงกลุ่มไหน (เช่นป้าย customer) เป็นเรื่องของแต่ละแคมเปญ
// ผ่าน includeTags/excludeTags — ที่นี่กันเฉพาะคนที่ "ส่งไปก็ไม่ถึง" หรือ "ห้ามส่ง" เท่านั้น
function broadcastAudienceWhere({ channelId, include = [], exclude = [], recipients = null }) {
  const where = [
    "c.channel_id = ?",
    "c.line_user_id NOT LIKE 'canary:%'",
    "c.do_not_disturb = 0", // ลูกค้า opt-out ไม่มีวันโดนบรอดแคส
    // REVIEW FIX: กติกา consent เดียวกับ follow-up (PLAYBOOK §PDPA):
    // marketing_consent < 0 = ลูกค้าปฏิเสธ marketing ชัดเจน — ห้ามส่งเด็ดขาด
    "c.marketing_consent >= 0",
    // audit 2026-08-26: ห้องอ้างอิงที่นำเข้ามาจาก LINE OA เดิมไม่ใช่ผู้ติดตามของ OA
    // ปัจจุบัน ส่งไปก็ถึงไม่ได้ กินโควตาเปล่า และทำให้ใบเสร็จ "ส่งแล้ว N คน" ผิดโดยเงียบ
    `NOT EXISTS (SELECT 1 FROM customer_tags lt
                  WHERE lt.customer_id = c.line_user_id AND lt.tag = 'ย้ายจาก LINE OA')`,
    // 28 ก.ย. 2026 (พี่ง้วงอนุมัติ "ตัดห้องสแปม (null) ออกจากบรอดแคสต์อัตโนมัติ" → "โอเคครับ"):
    // ห้องป้าย null ทุกตัวพิมพ์ไม่ใช่ลูกค้า — ไม่มีวันติดกลุ่มผู้รับ ไม่ว่าเลือกป้ายอะไร (นับและส่งใช้ชุดนี้ชุดเดียว)
    NOT_SPAM_SQL("c.line_user_id"),
    // 28 ก.ย. 2026: คนที่บล็อก OA อยู่ (webhook unfollow ล่าสุด) ส่งไปก็ไม่ถึง — ตัดออกทั้งตัวนับและตัวส่ง
    `NOT EXISTS (SELECT 1 FROM line_follow_state fs
                  WHERE fs.customer_id = c.line_user_id AND fs.state = 'unfollowed')`,
  ];
  const params = [String(channelId || "default")];
  if (recipients !== null) {
    where.push(`c.line_user_id IN (${tagPlaceholders(recipients)})`);
    params.push(...recipients);
  }
  const includeFilter = splitTagFilters(include);
  if (!includeFilter.all && (includeFilter.exact.length || includeFilter.prefixes.length)) {
    const match = tagMatchSql("t", includeFilter);
    where.push(`EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id = c.line_user_id AND ${match.sql})`);
    params.push(...match.params);
  }
  const excludeFilter = splitTagFilters(exclude);
  if (excludeFilter.exact.length || excludeFilter.prefixes.length) {
    const match = tagMatchSql("t", excludeFilter, { caseInsensitive: true });
    where.push(`NOT EXISTS (SELECT 1 FROM customer_tags t WHERE t.customer_id = c.line_user_id AND ${match.sql})`);
    params.push(...match.params);
  }
  return { sql: where.join(" AND "), params };
}

function tagPlaceholders(tags) {
  return tags.map(() => "?").join(",");
}

function recipientFingerprint(lineUserIds) {
  return createHash("sha256")
    .update([...new Set((lineUserIds || []).map(String).filter(Boolean))].sort().join("\n"))
    .digest("base64url");
}

// deployment เก่าที่ยังไม่มี owner: บัญชีเก่าสุดเป็น bootstrap owner หนึ่งคน
export function ensureBroadcastPermissionOwner({ get, run, now }) {
  if (get("SELECT username FROM operators WHERE role IN ('owner', 'admin') LIMIT 1")) return;
  const bootstrap = get("SELECT username FROM operators WHERE disabled = 0 ORDER BY created_at, rowid LIMIT 1");
  if (bootstrap) run("UPDATE operators SET role = 'owner', updated_at = ? WHERE username = ?", now(), bootstrap.username);
}

export function createBroadcastDbMethods({ db, run, all, get, now }) {
  return {
    grantOperatorChannel(username, channelId) {
      return run(
        `INSERT INTO operator_channels (username, channel_id, created_at) VALUES (?, ?, ?)
         ON CONFLICT(username, channel_id) DO NOTHING`,
        String(username), String(channelId), now(),
      ).changes === 1;
    },

    revokeOperatorChannel(username, channelId) {
      return run(
        "DELETE FROM operator_channels WHERE username = ? AND channel_id = ?",
        String(username), String(channelId),
      ).changes === 1;
    },

    listOperatorChannels(username) {
      return all(
        "SELECT channel_id FROM operator_channels WHERE username = ? ORDER BY channel_id",
        String(username),
      ).map((row) => row.channel_id);
    },

    listOperatorsForPermissions() {
      return all(
        `SELECT username, display_name, role, disabled
         FROM operators ORDER BY disabled, created_at, username`,
      );
    },

    // B-12: endpoint/UI may reveal only the boolean state and verification time.
    // The LINE user id is intentionally never selected by any Console route.
    broadcastSelfTestStatus({ operatorUsername, sessionHash, channelId = "default" } = {}) {
      const row = get(
        `SELECT verified_at FROM broadcast_self_test_destinations
         WHERE operator_username = ? AND channel_id = ? AND session_hash = ?`,
        String(operatorUsername || ""), String(channelId || "default"), String(sessionHash || ""),
      );
      return row ? { verified: true, verifiedAt: Number(row.verified_at) || 0 } : { verified: false, verifiedAt: null };
    },

    createBroadcastSelfTestChallenge({ operatorUsername, sessionHash, channelId = "default", challenge = "", expiresAt = 0 } = {}) {
      const username = String(operatorUsername || "");
      const session = String(sessionHash || "");
      const channel = String(channelId || "default");
      const token = String(challenge || "");
      const t = now();
      const expiry = Number(expiresAt);
      if (!username || !session || !token || !Number.isSafeInteger(expiry) || expiry <= t || expiry - t > 5 * 60_000) {
        throw new Error("broadcast self-test challenge ไม่ถูกต้อง");
      }
      const hash = createHash("sha256").update(token).digest("hex");
      db.exec("BEGIN IMMEDIATE");
      try {
        // A newer request supersedes an old code for exactly this logged-in operator/OA.
        run(
          `UPDATE broadcast_self_test_challenges SET consumed_at = ?, consumed_by = 'superseded'
           WHERE operator_username = ? AND channel_id = ? AND consumed_at IS NULL`,
          t, username, channel,
        );
        run(
          `INSERT INTO broadcast_self_test_challenges
            (id, operator_username, session_hash, channel_id, challenge_hash, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          randomUUID(), username, session, channel, hash, t, expiry,
        );
        db.exec("COMMIT");
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        throw error;
      }
      return { expiresAt: expiry };
    },

    // Called only from signed webhook ingress after the inbound row is durable.
    // Exact text matching is SHA-256 based; no raw operator/session/user id appears
    // in a Console response or audit record. BEGIN IMMEDIATE makes the code single-use.
    consumeBroadcastSelfTestChallenge({ channelId = "default", lineUserId = "", text = "" } = {}) {
      const channel = String(channelId || "default");
      const userId = String(lineUserId || "");
      const message = String(text || "");
      if (!userId || !message) return { matched: false };
      const hash = createHash("sha256").update(message).digest("hex");
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const challenge = get(
          `SELECT id, operator_username, session_hash FROM broadcast_self_test_challenges
           WHERE channel_id = ? AND challenge_hash = ? AND consumed_at IS NULL AND expires_at >= ?
           ORDER BY created_at DESC LIMIT 1`,
          channel, hash, t,
        );
        if (!challenge) {
          db.exec("ROLLBACK");
          return { matched: false };
        }
        const consumed = run(
          `UPDATE broadcast_self_test_challenges SET consumed_at = ?, consumed_by = 'verified'
           WHERE id = ? AND consumed_at IS NULL`,
          t, challenge.id,
        );
        if (consumed.changes !== 1) {
          db.exec("ROLLBACK");
          return { matched: false };
        }
        run(
          `INSERT INTO broadcast_self_test_destinations (operator_username, channel_id, session_hash, line_user_id, verified_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(operator_username, channel_id) DO UPDATE SET
             session_hash = excluded.session_hash,
             line_user_id = excluded.line_user_id,
             verified_at = excluded.verified_at`,
          challenge.operator_username, channel, challenge.session_hash, userId, t,
        );
        db.exec("COMMIT");
        return { matched: true, operatorUsername: challenge.operator_username };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already closed */ }
        throw error;
      }
    },

    getBroadcastSelfTestDestination({ operatorUsername, sessionHash, channelId = "default" } = {}) {
      // Private server-only accessor. Never pass this row to a Console payload/audit.
      return get(
        `SELECT line_user_id, verified_at FROM broadcast_self_test_destinations
         WHERE operator_username = ? AND channel_id = ? AND session_hash = ?`,
        String(operatorUsername || ""), String(channelId || "default"), String(sessionHash || ""),
      ) ?? null;
    },

    removeBroadcastSelfTestDestination({ operatorUsername, sessionHash, channelId = "default" } = {}) {
      return run(
        `DELETE FROM broadcast_self_test_destinations
         WHERE operator_username = ? AND channel_id = ? AND session_hash = ?`,
        String(operatorUsername || ""), String(channelId || "default"), String(sessionHash || ""),
      ).changes === 1;
    },

    // นับ + ดึงรายชื่อ audience — ใช้ WHERE เดียวกันเป๊ะทั้ง preview, queue และ revalidation ก่อนส่ง (ห้ามเพี้ยนกัน)
    broadcastAudience({ channelId = "default", includeTags = [], excludeTags = [], recipientIds = null, limit = AUDIENCE_MAX } = {}) {
      const include = (includeTags || []).map(String).filter(Boolean).slice(0, 20);
      const exclude = (excludeTags || []).map(String).filter(Boolean).slice(0, 20);
      const recipients = recipientIds === null
        ? null
        : [...new Set((recipientIds || []).map(String).filter(Boolean))];
      if (recipients !== null && !recipients.length) return [];
      const { sql: whereSql, params } = broadcastAudienceWhere({ channelId, include, exclude, recipients });
      return all(
        `SELECT c.line_user_id, c.display_name, c.known_name FROM customers c
         WHERE ${whereSql}
         ORDER BY c.updated_at DESC LIMIT ?`,
        ...params, Math.min(AUDIENCE_MAX, Math.max(1, Number(limit) || AUDIENCE_MAX))
      );
    },

    broadcastAudienceCount({ channelId = "default", includeTags = [], excludeTags = [] } = {}) {
      const include = (includeTags || []).map(String).filter(Boolean).slice(0, 20);
      const exclude = (excludeTags || []).map(String).filter(Boolean).slice(0, 20);
      const { sql: whereSql, params } = broadcastAudienceWhere({ channelId, include, exclude });
      return Number(get(
        `SELECT COUNT(*) AS n FROM customers c WHERE ${whereSql}`,
        ...params,
      )?.n) || 0;
    },

    createBroadcast({ channelId = "default", messages = [], includeTags = [], excludeTags = [], audienceCount = 0, createdBy = "" } = {}) {
      const id = randomUUID();
      const t = now();
      run(
        `INSERT INTO broadcasts (id, channel_id, messages_json, include_tags_json, exclude_tags_json,
           audience_count, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?)`,
        id, String(channelId || "default"), JSON.stringify(messages ?? []),
        JSON.stringify(includeTags ?? []), JSON.stringify(excludeTags ?? []),
        Number(audienceCount) || 0, String(createdBy), t, t
      );
      return this.getBroadcast(id);
    },

    // SQLite BEGIN IMMEDIATE serializes this whole check+create+claim across
    // chassis processes sharing the DB. A JavaScript mutex would not protect a
    // second process during deploy/recovery, so never replace this with memory state.
    claimBroadcast({ channelId = "default", messages = [], includeTags = [], excludeTags = [], audience = null, audienceCount = 0, createdBy = "", cooldownMs = 0, ownerToken = "", leaseDurationMs = 0, manual = false, scheduleId = "", scheduleOwnerToken = "" } = {}) {
      const id = randomUUID();
      const channel = String(channelId || "default");
      const owner = String(ownerToken || "");
      const t = now();
      const leaseMs = Number(leaseDurationMs);
      const audienceIdsProven = Array.isArray(audience) && audience.length > 0 &&
        audience.every((row) => typeof row?.line_user_id === "string" && row.line_user_id.trim().length > 0);
      const recipients = Array.isArray(audience)
        ? [...new Set(audience.map((row) => String(row?.line_user_id || "")).filter(Boolean))]
        : [];
      const exactAudienceCount = recipients.length || Number(audienceCount) || 0;
      if (!owner || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000) throw new Error("broadcast claim owner/lease ไม่ถูกต้อง");
      db.exec("BEGIN IMMEDIATE");
      try {
        // A due schedule has already passed a separate human confirmation gate.
        // A manual click must not overtake it in the same OA. Keep this check in
        // the same BEGIN IMMEDIATE transaction as the channel claim so a second
        // chassis process cannot win a check-then-create race.
        if (manual === true) {
          const dueSchedule = get(
            `SELECT id, scheduled_at FROM broadcast_schedules
             WHERE channel_id = ? AND status IN ('scheduled','preparing') AND scheduled_at <= ?
             ORDER BY scheduled_at, created_at LIMIT 1`,
            channel, t,
          );
          if (dueSchedule) {
            db.exec("ROLLBACK");
            return { ok: false, reason: "schedule_due", schedule: dueSchedule };
          }
        }
        if (scheduleId) {
          const schedule = get(
            `SELECT id FROM broadcast_schedules
             WHERE id = ? AND channel_id = ? AND status = 'preparing'
               AND preparing_owner_token = ? AND preparing_lease_expires_at > ?
               AND broadcast_id IS NULL AND cancel_requested_at IS NULL`,
            String(scheduleId), channel, String(scheduleOwnerToken || ""), t,
          );
          if (!schedule) {
            db.exec("ROLLBACK");
            return { ok: false, reason: "schedule_not_preparing" };
          }
        }
        // An exact whole-audience fingerprint is insufficient: tag drift can
        // produce a subset/superset whose unknown recipients overlap. Compare
        // candidate IDs against every unresolved unknown ledger row while the
        // same BEGIN IMMEDIATE lock is held. Keep raw IDs internal and return
        // only the aggregate quarantine handle. A caller without exact IDs
        // cannot prove disjointness, so it remains blocked at the whole-OA gate.
        let quarantine = null;
        if (audienceIdsProven) {
          const candidateIds = new Set(recipients);
          const unresolvedUnknown = all(
            `SELECT q.id, q.broadcast_id, q.created_at, unknown.line_user_id
             FROM broadcast_delivery_quarantines q
             JOIN broadcast_delivery_unknown_recipients unknown ON unknown.quarantine_id = q.id
             WHERE q.channel_id = ? AND q.resolved_at IS NULL
             ORDER BY q.created_at, q.id`,
            channel,
          );
          const overlap = unresolvedUnknown.find((row) => candidateIds.has(String(row.line_user_id)));
          if (overlap) {
            quarantine = {
              id: overlap.id,
              broadcast_id: overlap.broadcast_id,
              created_at: overlap.created_at,
            };
          }
          // 28 ก.ย. 2026: การส่งฝั่ง LINE (เพื่อนทุกคน/กลุ่มเป้าหมาย) ที่ผลยังไม่ชัด อาจถึงทุกคนใน OA แล้ว —
          // ไม่มีรายชื่อให้เทียบ จึงกันทุกการส่งของ OA นี้จนผู้ดูแลตรวจและ resolve
          quarantine ||= get(
            `SELECT id, broadcast_id, created_at FROM broadcast_delivery_quarantines
             WHERE channel_id = ? AND resolved_at IS NULL AND substr(audience_fingerprint, 1, 5) = 'line:'
             ORDER BY created_at LIMIT 1`,
            channel,
          ) ?? null;
        } else {
          quarantine = get(
            `SELECT id, broadcast_id, created_at FROM broadcast_delivery_quarantines
             WHERE channel_id = ? AND resolved_at IS NULL ORDER BY created_at LIMIT 1`,
            channel,
          );
        }
        if (quarantine) {
          db.exec("ROLLBACK");
          return { ok: false, reason: "delivery_quarantined", quarantine };
        }
        // Expired lease is the only safe reclaim boundary. Mark its old sending
        // job terminal before allowing a successor claim on the same channel.
        run(`UPDATE broadcasts SET status = 'failed',
               last_error = 'lease งานส่งหมดอายุ — ไม่ส่งต่ออัตโนมัติ กันข้อความเบิ้ล', updated_at = ?
             WHERE status = 'sending' AND id IN (
               SELECT broadcast_id FROM broadcast_channel_claims WHERE channel_id = ? AND lease_expires_at <= ?
             )`, t, channel, t);
        run(`DELETE FROM broadcast_channel_claims
             WHERE channel_id = ? AND (
               lease_expires_at <= ? OR broadcast_id IN (SELECT id FROM broadcasts WHERE status != 'sending')
             )`, channel, t);
        const active = get(
          "SELECT rowid AS broadcast_no, * FROM broadcasts WHERE channel_id = ? AND status = 'sending' ORDER BY created_at DESC LIMIT 1",
          channel,
        );
        if (active) {
          db.exec("ROLLBACK");
          return { ok: false, reason: "active", active };
        }
        const lastAt = Number(get("SELECT MAX(created_at) AS t FROM broadcasts WHERE channel_id = ?", channel)?.t) || 0;
        if (cooldownMs > 0 && t - lastAt < cooldownMs) {
          db.exec("ROLLBACK");
          return { ok: false, reason: "cooldown", sinceLast: t - lastAt };
        }
        run(
          `INSERT INTO broadcasts (id, channel_id, messages_json, include_tags_json, exclude_tags_json,
             audience_count, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?, ?)`,
          id, channel, JSON.stringify(messages ?? []), JSON.stringify(includeTags ?? []), JSON.stringify(excludeTags ?? []),
          exactAudienceCount, String(createdBy), t, t,
        );
        if (recipients.length) {
          const insertRecipient = db.prepare(
            `INSERT INTO broadcast_recipients
              (broadcast_id, line_user_id, batch_no, status, error, created_at, updated_at)
             VALUES (?, ?, -1, 'queued', '', ?, ?)`,
          );
          for (const lineUserId of recipients) insertRecipient.run(id, lineUserId, t, t);
        }
        const claimed = run(
          `INSERT INTO broadcast_channel_claims
             (channel_id, broadcast_id, owner_token, claimed_at, lease_expires_at)
           VALUES (?, ?, ?, ?, ?)`,
          channel, id, owner, t, t + leaseMs,
        );
        if (claimed.changes !== 1) {
          db.exec("ROLLBACK");
          return { ok: false, reason: "active" };
        }
        if (scheduleId) {
          const linked = run(
            `UPDATE broadcast_schedules SET status = 'dispatched', broadcast_id = ?, dispatched_at = ?,
               preparing_owner_token = '', preparing_lease_expires_at = 0, updated_at = ?
             WHERE id = ? AND status = 'preparing' AND preparing_owner_token = ?
               AND preparing_lease_expires_at > ? AND broadcast_id IS NULL AND cancel_requested_at IS NULL`,
            id, t, t, String(scheduleId), String(scheduleOwnerToken || ""), t,
          );
          if (linked.changes !== 1) {
            db.exec("ROLLBACK");
            return { ok: false, reason: "schedule_not_preparing" };
          }
        }
        db.exec("COMMIT");
        return { ok: true, row: this.getBroadcast(id) };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
        throw error;
      }
    },

    renewBroadcastClaim(channelId, broadcastId, ownerToken, leaseDurationMs) {
      const leaseMs = Number(leaseDurationMs);
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000) return false;
      const t = now();
      return run(
        `UPDATE broadcast_channel_claims SET lease_expires_at = ?
         WHERE channel_id = ? AND broadcast_id = ? AND owner_token = ? AND lease_expires_at > ?`,
        t + leaseMs, String(channelId || "default"), String(broadcastId), String(ownerToken || ""), t,
      ).changes === 1;
    },

    releaseBroadcastClaim(channelId, broadcastId, ownerToken) {
      return run(
        "DELETE FROM broadcast_channel_claims WHERE channel_id = ? AND broadcast_id = ? AND owner_token = ?",
        String(channelId || "default"), String(broadcastId), String(ownerToken || ""),
      ).changes === 1;
    },

    // Terminal status and claim release are one durability boundary. If either
    // statement fails, rollback leaves the live claim intact so lease-expiry
    // recovery can safely terminalize/reclaim it later.
    finalizeBroadcastClaim(channelId, broadcastId, ownerToken, { sentCount = 0, failedCount = 0, lastSentIndex = -1, status = "failed", lastError = "" } = {}) {
      const terminal = String(status);
      if (!new Set(["done", "partial", "failed"]).has(terminal)) throw new Error("broadcast terminal status ไม่ถูกต้อง");
      const channel = String(channelId || "default");
      const id = String(broadcastId);
      const owner = String(ownerToken || "");
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const claim = get(
          `SELECT 1 AS ok FROM broadcast_channel_claims
           WHERE channel_id = ? AND broadcast_id = ? AND owner_token = ? AND lease_expires_at > ?`,
          channel, id, owner, t,
        );
        if (!claim) {
          db.exec("ROLLBACK");
          return false;
        }
        const updated = run(
          `UPDATE broadcasts SET sent_count = ?, failed_count = ?, last_sent_index = ?,
             status = ?, last_error = ?, updated_at = ? WHERE id = ? AND channel_id = ?`,
          Number(sentCount), Number(failedCount), Number(lastSentIndex), terminal,
          String(lastError || "").slice(0, 300), t, id, channel,
        );
        if (updated.changes !== 1) throw new Error("broadcast terminal update ไม่สำเร็จ");
        const released = run(
          `DELETE FROM broadcast_channel_claims
           WHERE channel_id = ? AND broadcast_id = ? AND owner_token = ?`,
          channel, id, owner,
        );
        if (released.changes !== 1) throw new Error("broadcast claim release ไม่สำเร็จ");
        db.exec("COMMIT");
        return true;
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
        throw error;
      }
    },

    // Persist the exact attempted recipients before crossing the provider
    // boundary. If the process dies or the post-provider transition fails,
    // this unresolved row survives lease recovery and keeps later claims
    // fail-closed. It is removed only by a durable known-outcome settlement or
    // by an explicit owner/admin reconciliation.
    armBroadcastDeliveryQuarantine(channelId, broadcastId, ownerToken, {
      lineUserIds = [], batchNo = -1, retryKey = "",
    } = {}) {
      const channel = String(channelId || "default");
      const id = String(broadcastId || "");
      const owner = String(ownerToken || "");
      const attemptedIds = [...new Set((lineUserIds || []).map(String).filter(Boolean))];
      const t = now();
      if (!id || !owner || !attemptedIds.length) throw new Error("broadcast delivery guard payload ไม่ถูกต้อง");
      db.exec("BEGIN IMMEDIATE");
      try {
        const claim = get(
          `SELECT 1 AS ok FROM broadcast_channel_claims
           WHERE channel_id = ? AND broadcast_id = ? AND owner_token = ? AND lease_expires_at > ?`,
          channel, id, owner, t,
        );
        if (!claim) {
          db.exec("ROLLBACK");
          return null;
        }
        const ledgerIds = all(
          "SELECT line_user_id FROM broadcast_recipients WHERE broadcast_id = ? ORDER BY line_user_id",
          id,
        ).map((row) => String(row.line_user_id));
        if (!ledgerIds.length) throw new Error("broadcast delivery guard requires durable recipient ledger");
        const queued = new Set(all(
          "SELECT line_user_id FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'queued'",
          id,
        ).map((row) => String(row.line_user_id)));
        if (attemptedIds.some((lineUserId) => !queued.has(lineUserId))) {
          throw new Error("broadcast delivery guard attempted recipients ไม่ตรงกับ ledger");
        }
        const quarantineId = randomUUID();
        run(
          `INSERT INTO broadcast_delivery_quarantines
            (id, channel_id, audience_fingerprint, broadcast_id, batch_no, retry_key_hash,
             provider_status, failure_kind, attempted_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 'ambiguous', ?, ?)`,
          quarantineId, channel, recipientFingerprint(ledgerIds), id, Number(batchNo),
          createHash("sha256").update(String(retryKey || "")).digest("hex"),
          attemptedIds.length, t,
        );
        const insertUnknown = db.prepare(
          `INSERT INTO broadcast_delivery_unknown_recipients
            (quarantine_id, broadcast_id, line_user_id, batch_no, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (const lineUserId of attemptedIds) {
          insertUnknown.run(quarantineId, id, lineUserId, Number(batchNo), t);
        }
        db.exec("COMMIT");
        return this.getBroadcastDeliveryQuarantine(quarantineId);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
        throw error;
      }
    },

    // Known provider outcomes settle the recipient ledger and remove the
    // pre-provider guard in one transaction. Any failure rolls back to the
    // durable unresolved guard instead of inviting an automatic replay.
    settleBroadcastDeliveryAttempt(channelId, broadcastId, ownerToken, {
      quarantineId = "", lineUserIds = [], batchNo = -1, status = "failed", error = "",
    } = {}) {
      const channel = String(channelId || "default");
      const id = String(broadcastId || "");
      const owner = String(ownerToken || "");
      const guardId = String(quarantineId || "");
      const attemptedIds = [...new Set((lineUserIds || []).map(String).filter(Boolean))];
      const nextStatus = String(status);
      const t = now();
      if (!id || !owner || !guardId || !attemptedIds.length || !new Set(["sent", "failed"]).has(nextStatus)) {
        throw new Error("broadcast delivery settlement payload ไม่ถูกต้อง");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const claim = get(
          `SELECT 1 AS ok FROM broadcast_channel_claims
           WHERE channel_id = ? AND broadcast_id = ? AND owner_token = ? AND lease_expires_at > ?`,
          channel, id, owner, t,
        );
        if (!claim) throw new Error("broadcast delivery settlement claim ไม่พร้อม");
        const guard = get(
          `SELECT id FROM broadcast_delivery_quarantines
           WHERE id = ? AND channel_id = ? AND broadcast_id = ? AND resolved_at IS NULL`,
          guardId, channel, id,
        );
        if (!guard) throw new Error("broadcast delivery settlement guard ไม่พร้อม");
        const guardedIds = all(
          `SELECT line_user_id FROM broadcast_delivery_unknown_recipients
           WHERE quarantine_id = ? ORDER BY line_user_id`,
          guardId,
        ).map((row) => String(row.line_user_id));
        if (guardedIds.length !== attemptedIds.length ||
            guardedIds.some((lineUserId) => !attemptedIds.includes(lineUserId))) {
          throw new Error("broadcast delivery settlement recipients ไม่ตรงกับ guard");
        }
        const updateRecipient = db.prepare(
          `UPDATE broadcast_recipients SET batch_no = ?, status = ?, error = ?, updated_at = ?
           WHERE broadcast_id = ? AND line_user_id = ? AND status = 'queued'`,
        );
        let changed = 0;
        for (const lineUserId of attemptedIds) {
          changed += updateRecipient.run(
            Number(batchNo), nextStatus, String(error || "").slice(0, 300), t, id, lineUserId,
          ).changes;
        }
        if (changed !== attemptedIds.length) throw new Error("broadcast delivery settlement ledger ไม่ครบ");
        const deletedUnknown = run(
          "DELETE FROM broadcast_delivery_unknown_recipients WHERE quarantine_id = ?",
          guardId,
        );
        if (deletedUnknown.changes !== attemptedIds.length) throw new Error("broadcast delivery settlement guard ledger ลบไม่ครบ");
        const deletedGuard = run(
          `DELETE FROM broadcast_delivery_quarantines
           WHERE id = ? AND channel_id = ? AND broadcast_id = ? AND resolved_at IS NULL`,
          guardId, channel, id,
        );
        if (deletedGuard.changes !== 1) throw new Error("broadcast delivery settlement guard ลบไม่สำเร็จ");
        db.exec("COMMIT");
        return changed;
      } catch (settleError) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
        throw settleError;
      }
    },

    // A provider-ambiguous batch and the channel-claim release are one atomic
    // boundary. If persistence fails, the live claim remains in place and the
    // caller must not make another provider call or finalize it as rejected.
    quarantineBroadcastClaim(channelId, broadcastId, ownerToken, {
      lineUserIds = [], batchNo = -1, retryKey = "", providerStatus = 0,
      failureKind = "ambiguous", sentCount = 0, failedCount = 0,
      lastSentIndex = -1, lastError = "", quarantineId = "",
    } = {}) {
      const channel = String(channelId || "default");
      const id = String(broadcastId || "");
      const owner = String(ownerToken || "");
      const attemptedIds = [...new Set((lineUserIds || []).map(String).filter(Boolean))];
      const allowedKinds = new Set(["status_0", "server_error", "exception", "ambiguous"]);
      const kind = String(failureKind || "ambiguous");
      const t = now();
      if (!id || !owner || !attemptedIds.length || !allowedKinds.has(kind)) {
        throw new Error("broadcast quarantine payload ไม่ถูกต้อง");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const claim = get(
          `SELECT 1 AS ok FROM broadcast_channel_claims
           WHERE channel_id = ? AND broadcast_id = ? AND owner_token = ? AND lease_expires_at > ?`,
          channel, id, owner, t,
        );
        if (!claim) {
          db.exec("ROLLBACK");
          return null;
        }
        let guardId = String(quarantineId || "");
        if (guardId) {
          const guard = get(
            `SELECT id FROM broadcast_delivery_quarantines
             WHERE id = ? AND channel_id = ? AND broadcast_id = ? AND resolved_at IS NULL`,
            guardId, channel, id,
          );
          if (!guard) throw new Error("broadcast quarantine durable guard ไม่พร้อม");
          const guardedIds = all(
            `SELECT line_user_id FROM broadcast_delivery_unknown_recipients
             WHERE quarantine_id = ? ORDER BY line_user_id`,
            guardId,
          ).map((row) => String(row.line_user_id));
          if (guardedIds.length !== attemptedIds.length ||
              guardedIds.some((lineUserId) => !attemptedIds.includes(lineUserId))) {
            throw new Error("broadcast quarantine attempted recipients ไม่ตรงกับ guard");
          }
          const updatedGuard = run(
            `UPDATE broadcast_delivery_quarantines SET provider_status = ?, failure_kind = ?, attempted_count = ?
             WHERE id = ? AND channel_id = ? AND broadcast_id = ? AND resolved_at IS NULL`,
            Number(providerStatus) || 0, kind, attemptedIds.length, guardId, channel, id,
          );
          if (updatedGuard.changes !== 1) throw new Error("broadcast quarantine durable guard update ไม่สำเร็จ");
        } else {
          const ledgerIds = all(
            "SELECT line_user_id FROM broadcast_recipients WHERE broadcast_id = ? ORDER BY line_user_id",
            id,
          ).map((row) => String(row.line_user_id));
          if (!ledgerIds.length) throw new Error("broadcast quarantine requires durable recipient ledger");
          const queued = new Set(all(
            "SELECT line_user_id FROM broadcast_recipients WHERE broadcast_id = ? AND status = 'queued'",
            id,
          ).map((row) => String(row.line_user_id)));
          if (attemptedIds.some((lineUserId) => !queued.has(lineUserId))) {
            throw new Error("broadcast quarantine attempted recipients ไม่ตรงกับ ledger");
          }
          guardId = randomUUID();
          run(
            `INSERT INTO broadcast_delivery_quarantines
              (id, channel_id, audience_fingerprint, broadcast_id, batch_no, retry_key_hash,
               provider_status, failure_kind, attempted_count, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            guardId, channel, recipientFingerprint(ledgerIds), id, Number(batchNo),
            createHash("sha256").update(String(retryKey || "")).digest("hex"),
            Number(providerStatus) || 0, kind, attemptedIds.length, t,
          );
          const insertUnknown = db.prepare(
            `INSERT INTO broadcast_delivery_unknown_recipients
              (quarantine_id, broadcast_id, line_user_id, batch_no, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          );
          for (const lineUserId of attemptedIds) {
            insertUnknown.run(guardId, id, lineUserId, Number(batchNo), t);
          }
        }
        const updated = run(
          `UPDATE broadcasts SET sent_count = ?, failed_count = ?, last_sent_index = ?,
             status = 'failed', last_error = ?, updated_at = ?
           WHERE id = ? AND channel_id = ? AND status = 'sending'`,
          Number(sentCount), Number(failedCount), Number(lastSentIndex),
          String(lastError || "").slice(0, 300), t, id, channel,
        );
        if (updated.changes !== 1) throw new Error("broadcast quarantine terminal update ไม่สำเร็จ");
        const released = run(
          `DELETE FROM broadcast_channel_claims
           WHERE channel_id = ? AND broadcast_id = ? AND owner_token = ?`,
          channel, id, owner,
        );
        if (released.changes !== 1) throw new Error("broadcast quarantine claim release ไม่สำเร็จ");
        db.exec("COMMIT");
        return this.getBroadcastDeliveryQuarantine(guardId);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
        throw error;
      }
    },

    getBroadcastDeliveryQuarantine(id) {
      return get(
        `SELECT id, channel_id, audience_fingerprint, broadcast_id, batch_no,
                provider_status, failure_kind, attempted_count, created_at,
                resolved_at, resolved_by, resolution
         FROM broadcast_delivery_quarantines WHERE id = ?`,
        String(id || ""),
      ) ?? null;
    },

    listUnresolvedBroadcastDeliveryQuarantines({ channel = null, limit = 50 } = {}) {
      const where = channel ? "AND q.channel_id = ?" : "";
      const params = channel ? [String(channel)] : [];
      return all(
        `SELECT q.id, q.channel_id, q.broadcast_id, q.batch_no, q.provider_status,
                q.failure_kind, q.attempted_count AS recipient_count, q.created_at,
                q.audience_fingerprint, b.status AS broadcast_status
         FROM broadcast_delivery_quarantines q
         JOIN broadcasts b ON b.id = q.broadcast_id
         WHERE q.resolved_at IS NULL ${where}
         ORDER BY q.created_at, q.id LIMIT ?`,
        ...params, Math.min(100, Math.max(1, Number(limit) || 50)),
      );
    },

    unresolvedBroadcastDeliveryQuarantine(channelId, audience = []) {
      const ids = (audience || []).map((row) => String(row?.line_user_id || row || "")).filter(Boolean);
      if (!ids.length) return null;
      return get(
        `SELECT id, channel_id, audience_fingerprint, broadcast_id, batch_no,
                provider_status, failure_kind, attempted_count, created_at
         FROM broadcast_delivery_quarantines
         WHERE channel_id = ? AND audience_fingerprint = ? AND resolved_at IS NULL LIMIT 1`,
        String(channelId || "default"), recipientFingerprint(ids),
      ) ?? null;
    },

    resolveBroadcastDeliveryQuarantine({
      id = "", channelId = "", resolvedBy = "", resolution = "", reason = "",
    } = {}) {
      const quarantineId = String(id || "");
      const channel = String(channelId || "");
      const operator = String(resolvedBy || "").trim();
      const decision = String(resolution || "");
      const operatorReason = String(reason || "").trim();
      if (!quarantineId || !channel || !operator ||
          !new Set(["confirmed_delivered", "confirmed_not_delivered"]).has(decision) ||
          operatorReason.length < 5 || operatorReason.length > 300) {
        throw new Error("broadcast quarantine resolution ต้องระบุผู้ตรวจ ผลยืนยัน และเหตุผล 5-300 ตัวอักษร");
      }
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = get(
          `SELECT q.*, b.audience_count FROM broadcast_delivery_quarantines q
           JOIN broadcasts b ON b.id = q.broadcast_id
           WHERE q.id = ? AND q.channel_id = ?`,
          quarantineId, channel,
        );
        if (!row) {
          db.exec("ROLLBACK");
          return { outcome: "missing", row: null };
        }
        if (row.resolved_at !== null) {
          db.exec("ROLLBACK");
          return { outcome: "already_resolved", row: this.getBroadcastDeliveryQuarantine(quarantineId) };
        }
        const activeClaim = get(
          `SELECT 1 AS ok FROM broadcast_channel_claims
           WHERE broadcast_id = ? AND channel_id = ? AND lease_expires_at > ?`,
          row.broadcast_id, channel, t,
        );
        if (activeClaim) {
          db.exec("ROLLBACK");
          return { outcome: "delivery_active", row: this.getBroadcastDeliveryQuarantine(quarantineId) };
        }
        const attemptedStatus = decision === "confirmed_delivered" ? "sent" : "failed";
        const attemptedError = decision === "confirmed_delivered"
          ? "ผู้ดูแลยืนยันผลส่งจากหลักฐานภายนอก"
          : "ผู้ดูแลยืนยันว่า provider ไม่ส่งถึง";
        run(
          `UPDATE broadcast_recipients
           SET status = ?,
               batch_no = COALESCE((
                 SELECT unknown.batch_no FROM broadcast_delivery_unknown_recipients unknown
                 WHERE unknown.quarantine_id = ? AND unknown.line_user_id = broadcast_recipients.line_user_id
               ), batch_no),
               error = ?, updated_at = ?
           WHERE broadcast_id = ? AND status = 'queued' AND line_user_id IN (
             SELECT line_user_id FROM broadcast_delivery_unknown_recipients WHERE quarantine_id = ?
           )`,
          attemptedStatus, quarantineId, attemptedError, t, row.broadcast_id, quarantineId,
        );
        // The process deliberately stopped after the ambiguous batch. These rows
        // were never attempted and must never be replayed as part of this job.
        run(
          `UPDATE broadcast_recipients SET status = 'cancelled',
             error = 'หยุดก่อนส่งเพราะ batch ก่อนหน้าผลไม่แน่ชัด', updated_at = ?
           WHERE broadcast_id = ? AND status = 'queued'`,
          t, row.broadcast_id,
        );
        const counts = get(
          `SELECT
             SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
           FROM broadcast_recipients WHERE broadcast_id = ?`,
          row.broadcast_id,
        ) || {};
        const sent = Number(counts.sent) || 0;
        const failed = Number(counts.failed) || 0;
        const cancelled = Number(counts.cancelled) || 0;
        const terminal = sent === Number(row.audience_count) && failed === 0 && cancelled === 0
          ? "done"
          : sent > 0
            ? "partial"
            : "failed";
        run(
          `UPDATE broadcasts SET sent_count = ?, failed_count = ?, status = ?,
             last_error = ?, updated_at = ? WHERE id = ?`,
          sent, failed, terminal,
          `quarantine resolved: ${decision}; remaining_cancelled=${cancelled}`.slice(0, 300),
          t, row.broadcast_id,
        );
        const resolved = run(
          `UPDATE broadcast_delivery_quarantines
           SET resolved_at = ?, resolved_by = ?, resolution = ?
           WHERE id = ? AND channel_id = ? AND resolved_at IS NULL`,
          t, operator, decision, quarantineId, channel,
        );
        if (resolved.changes !== 1) throw new Error("broadcast quarantine resolution race");
        const reasonHash = createHash("sha256").update(operatorReason).digest("hex").slice(0, 16);
        run(
          `INSERT INTO admin_audit (id, operator, action, target, detail, created_at)
           VALUES (?, ?, 'broadcast_delivery_quarantine_resolved', ?, ?, ?)`,
          randomUUID(), operator, channel,
          `quarantine=${quarantineId}; resolution=${decision}; recipient_count=${Number(row.attempted_count) || 0}; reason_recorded=true; reason_sha256=${reasonHash}`.slice(0, 500),
          t,
        );
        db.exec("COMMIT");
        return { outcome: "resolved", row: this.getBroadcastDeliveryQuarantine(quarantineId) };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
        throw error;
      }
    },

    getBroadcast(id) {
      return get("SELECT rowid AS broadcast_no, * FROM broadcasts WHERE id = ?", String(id)) ?? null;
    },

    requestBroadcastCancel(id, requestedBy = "") {
      const t = now();
      const changed = run(
        `UPDATE broadcasts SET cancel_requested_at = ?, cancel_requested_by = ?, updated_at = ?
         WHERE id = ? AND status = 'sending' AND cancel_requested_at IS NULL`,
        t, String(requestedBy), t, String(id),
      ).changes;
      return changed === 1 ? this.getBroadcast(id) : null;
    },

    broadcastCancelRequest(id) {
      return get(
        "SELECT cancel_requested_at, cancel_requested_by FROM broadcasts WHERE id = ? AND cancel_requested_at IS NOT NULL",
        String(id),
      ) ?? null;
    },

    markBroadcastRecipients(broadcastId, lineUserIds, status, { batchNo = -1, error = "" } = {}) {
      const allowed = new Set(["sent", "failed", "skipped", "cancelled"]);
      const nextStatus = String(status);
      if (!allowed.has(nextStatus)) throw new Error("broadcast recipient status ไม่ถูกต้อง");
      const ids = [...new Set((lineUserIds || []).map(String).filter(Boolean))];
      if (!ids.length) return 0;
      const t = now();
      const statement = db.prepare(
        `UPDATE broadcast_recipients
         SET batch_no = ?, status = ?, error = ?, updated_at = ?
         WHERE broadcast_id = ? AND line_user_id = ? AND status = 'queued'`,
      );
      let changed = 0;
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const lineUserId of ids) {
          changed += statement.run(
            Number(batchNo), nextStatus, String(error || "").slice(0, 300), t,
            String(broadcastId), lineUserId,
          ).changes;
        }
        db.exec("COMMIT");
        return changed;
      } catch (err) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
        throw err;
      }
    },

    broadcastRecipientSummary(broadcastId) {
      const summary = { queued: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0 };
      for (const row of all(
        "SELECT status, COUNT(*) AS n FROM broadcast_recipients WHERE broadcast_id = ? GROUP BY status",
        String(broadcastId),
      )) {
        if (Object.hasOwn(summary, row.status)) summary[row.status] = Number(row.n) || 0;
      }
      const unknown = Number(get(
        `SELECT COUNT(*) AS n FROM broadcast_delivery_unknown_recipients unknown
         JOIN broadcast_delivery_quarantines quarantine ON quarantine.id = unknown.quarantine_id
         WHERE unknown.broadcast_id = ? AND quarantine.resolved_at IS NULL`,
        String(broadcastId),
      )?.n) || 0;
      if (unknown) {
        summary.queued = Math.max(0, summary.queued - unknown);
        summary.unknown = unknown;
      }
      return summary;
    },

    updateBroadcastProgress(id, { sentCount, failedCount, lastSentIndex, status, lastError } = {}) {
      const row = this.getBroadcast(id);
      if (!row) return false;
      return run(
        "UPDATE broadcasts SET sent_count = ?, failed_count = ?, last_sent_index = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?",
        sentCount === undefined ? row.sent_count : Number(sentCount),
        failedCount === undefined ? row.failed_count : Number(failedCount),
        lastSentIndex === undefined ? row.last_sent_index : Number(lastSentIndex),
        status === undefined ? row.status : String(status),
        lastError === undefined ? (row.last_error || "") : String(lastError).slice(0, 300),
        now(), String(id)
      ).changes === 1;
    },

    // REVIEW FIX: lock กันส่งซ้อน — บรอดแคสของสาขาที่ยัง 'sending' อยู่ + เวลาส่งล่าสุด (cooldown)
    activeBroadcastFor(channelId) {
      return get(
        "SELECT rowid AS broadcast_no, * FROM broadcasts WHERE channel_id = ? AND status = 'sending' ORDER BY created_at DESC LIMIT 1",
        String(channelId)
      ) ?? null;
    },
    lastBroadcastAt(channelId) {
      return Number(get(
        "SELECT MAX(created_at) AS t FROM broadcasts WHERE channel_id = ?",
        String(channelId)
      )?.t) || 0;
    },

    listBroadcasts({ channel = null, limit = 20 } = {}) {
      const params = [];
      let chWhere = "";
      if (channel) {
        chWhere = " WHERE channel_id = ?";
        params.push(String(channel));
      }
      return all(
        `SELECT rowid AS broadcast_no, * FROM broadcasts${chWhere}
         ORDER BY created_at DESC LIMIT ?`,
        ...params, Math.min(100, Math.max(1, Number(limit) || 20))
      );
    },

    /* -------------------------- broadcast schedules ------------------------- */

    createBroadcastSchedule({ channelId = "default", messages = [], includeTags = [], excludeTags = [], scheduledAt = 0, previewCount = 0, audienceFingerprint = "", confirmationHash = "", confirmationExpiresAt = 0, createdBy = "" } = {}) {
      const id = randomUUID();
      const t = now();
      try {
        run(
          `INSERT INTO broadcast_schedules
            (id, channel_id, messages_json, include_tags_json, exclude_tags_json,
             scheduled_at, preview_count, audience_fingerprint, confirmation_hash,
             confirmation_expires_at, status, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)`,
          id, String(channelId || "default"), JSON.stringify(messages ?? []),
          JSON.stringify(includeTags ?? []), JSON.stringify(excludeTags ?? []),
          Number(scheduledAt), Number(previewCount), String(audienceFingerprint),
          String(confirmationHash), Number(confirmationExpiresAt), String(createdBy), t, t,
        );
      } catch (error) {
        if (/broadcast_schedules\.confirmation_hash|idx_broadcast_schedules_confirmation_hash/u.test(String(error?.message || error))) {
          const replay = new Error("broadcast schedule confirmation ถูกใช้ไปแล้ว");
          replay.code = "BROADCAST_SCHEDULE_CONFIRMATION_REPLAY";
          throw replay;
        }
        throw error;
      }
      return this.getBroadcastSchedule(id);
    },

    getBroadcastSchedule(id) {
      return get(
        `SELECT s.*, b.status AS broadcast_status, b.sent_count AS broadcast_sent_count,
                b.failed_count AS broadcast_failed_count, b.audience_count AS broadcast_audience_count,
                b.last_error AS broadcast_last_error
         FROM broadcast_schedules s LEFT JOIN broadcasts b ON b.id = s.broadcast_id
         WHERE s.id = ?`,
        String(id),
      ) ?? null;
    },

    listBroadcastSchedules({ channel = null, limit = 50 } = {}) {
      const where = channel ? "WHERE s.channel_id = ?" : "";
      const params = channel ? [String(channel)] : [];
      return all(
        `SELECT s.*, b.status AS broadcast_status, b.sent_count AS broadcast_sent_count,
                b.failed_count AS broadcast_failed_count, b.audience_count AS broadcast_audience_count,
                b.last_error AS broadcast_last_error
         FROM broadcast_schedules s LEFT JOIN broadcasts b ON b.id = s.broadcast_id
         ${where} ORDER BY s.scheduled_at DESC, s.created_at DESC LIMIT ?`,
        ...params, Math.min(100, Math.max(1, Number(limit) || 50)),
      );
    },

    dueBroadcastScheduleForChannel(channelId, at = now()) {
      return get(
        `SELECT id, channel_id, scheduled_at, status FROM broadcast_schedules
         WHERE channel_id = ? AND status IN ('scheduled','preparing') AND scheduled_at <= ?
         ORDER BY scheduled_at, created_at LIMIT 1`,
        String(channelId || "default"), Number(at),
      ) ?? null;
    },

    claimDueBroadcastSchedule({ ownerToken = "", leaseDurationMs = 60_000, at = now() } = {}) {
      const owner = String(ownerToken || "");
      const leaseMs = Number(leaseDurationMs);
      const t = Number(at);
      if (!owner || !Number.isSafeInteger(leaseMs) || leaseMs < 15_000 || !Number.isSafeInteger(t)) {
        throw new Error("broadcast schedule claim owner/lease ไม่ถูกต้อง");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = get(
          `SELECT id FROM broadcast_schedules
           WHERE status = 'scheduled' AND scheduled_at <= ?
           ORDER BY scheduled_at, created_at LIMIT 1`,
          t,
        );
        if (!row) {
          db.exec("ROLLBACK");
          return null;
        }
        const claimed = run(
          `UPDATE broadcast_schedules SET status = 'preparing', preparing_owner_token = ?,
             preparing_lease_expires_at = ?, preparing_at = ?, updated_at = ?
           WHERE id = ? AND status = 'scheduled'`,
          owner, t + leaseMs, t, t, row.id,
        );
        if (claimed.changes !== 1) {
          db.exec("ROLLBACK");
          return null;
        }
        db.exec("COMMIT");
        return this.getBroadcastSchedule(row.id);
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
        throw error;
      }
    },

    recoverStalePreparingBroadcastSchedules(at = now()) {
      const t = Number(at);
      return run(
        `UPDATE broadcast_schedules SET status = 'failed', failed_at = ?,
           last_failure_phase = 'startup_recovery',
           last_error = 'งานตั้งเวลาค้างจาก process ก่อนหน้า — ปิดเป็น failed และไม่ส่งซ้ำอัตโนมัติ',
           preparing_owner_token = '', preparing_lease_expires_at = 0, updated_at = ?
         WHERE status = 'preparing' AND preparing_lease_expires_at <= ?`,
        t, t, t,
      ).changes;
    },

    deferPreparingBroadcastSchedule(id, ownerToken, { scheduledAt, reason = "quiet_hours", at = now() } = {}) {
      const t = Number(at);
      return run(
        `UPDATE broadcast_schedules SET status = 'scheduled', scheduled_at = ?,
           quiet_deferred_count = quiet_deferred_count + 1, last_quiet_deferred_at = ?,
           last_failure_phase = ?, last_error = ?, preparing_owner_token = '',
           preparing_lease_expires_at = 0, updated_at = ?
         WHERE id = ? AND status = 'preparing' AND preparing_owner_token = ?`,
        Number(scheduledAt), t, String(reason), "เลื่อนไป 09:00 Asia/Bangkok เพราะถึง quiet hours", t,
        String(id), String(ownerToken || ""),
      ).changes === 1 ? this.getBroadcastSchedule(id) : null;
    },

    failPreparingBroadcastSchedule(id, ownerToken, { phase = "pre_provider", error = "", at = now() } = {}) {
      const t = Number(at);
      const changed = run(
        `UPDATE broadcast_schedules SET status = 'failed', failed_at = ?, last_failure_phase = ?,
           last_error = ?, preparing_owner_token = '', preparing_lease_expires_at = 0, updated_at = ?
         WHERE id = ? AND status = 'preparing' AND preparing_owner_token = ?`,
        t, String(phase).slice(0, 80), String(error || "").slice(0, 300), t,
        String(id), String(ownerToken || ""),
      ).changes;
      return changed === 1 ? this.getBroadcastSchedule(id) : null;
    },

    cancelBroadcastSchedule(id, requestedBy = "") {
      const scheduleId = String(id);
      const t = now();
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = get("SELECT * FROM broadcast_schedules WHERE id = ?", scheduleId);
        if (!row) {
          db.exec("ROLLBACK");
          return { outcome: "missing", row: null };
        }
        if (row.status === "scheduled" || row.status === "preparing") {
          const changed = run(
            `UPDATE broadcast_schedules SET status = 'cancelled', cancel_requested_at = ?,
               cancel_requested_by = ?, cancelled_at = ?, preparing_owner_token = '',
               preparing_lease_expires_at = 0, updated_at = ?
             WHERE id = ? AND status IN ('scheduled','preparing')`,
            t, String(requestedBy), t, t, scheduleId,
          );
          if (changed.changes !== 1) throw new Error("broadcast schedule cancel race");
          db.exec("COMMIT");
          return { outcome: "cancelled", row: this.getBroadcastSchedule(scheduleId) };
        }
        db.exec("ROLLBACK");
        return { outcome: row.status, row: this.getBroadcastSchedule(scheduleId) };
      } catch (error) {
        try { db.exec("ROLLBACK"); } catch { /* transaction already rolled back */ }
        throw error;
      }
    },

    /* --------------------------- broadcast media --------------------------- */

    createMediaAsset({ id, assetKey, filename, label = "", mime, byteSize, width, height, sha256, createdBy = "" }) {
      run(
        `INSERT INTO media_assets
          (id, asset_key, filename, label, mime, byte_size, width, height, sha256, status, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        String(id), String(assetKey), String(filename), String(label).slice(0, 120), String(mime),
        Number(byteSize), Number(width), Number(height), String(sha256), String(createdBy), now(),
      );
      return this.getMediaAsset(id);
    },

    getMediaAsset(id) {
      return get("SELECT * FROM media_assets WHERE id = ?", String(id)) ?? null;
    },

    getMediaAssetByKey(key) {
      return get("SELECT * FROM media_assets WHERE asset_key = ?", String(key)) ?? null;
    },

    getMediaAssetByFilename(filename) {
      return get("SELECT * FROM media_assets WHERE filename = ?", String(filename)) ?? null;
    },

    getMediaAssetBySha(sha256) {
      return get("SELECT * FROM media_assets WHERE sha256 = ?", String(sha256)) ?? null;
    },

    listMediaAssets({ status = "active", limit = 100 } = {}) {
      return all(
        "SELECT * FROM media_assets WHERE status = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        String(status), Math.min(500, Math.max(1, Math.trunc(Number(limit)) || 100)),
      );
    },

    mediaAssetUsage() {
      return get(
        `SELECT COUNT(*) AS active_count, COALESCE(SUM(byte_size), 0) AS total_bytes
         FROM media_assets WHERE status = 'active'`,
      ) ?? { active_count: 0, total_bytes: 0 };
    },

    mediaUploadsByOperatorSince(operator, since) {
      return Number(get(
        "SELECT COUNT(*) AS n FROM media_assets WHERE created_by = ? AND created_at >= ?",
        String(operator), Number(since) || 0,
      )?.n) || 0;
    },
  };
}
