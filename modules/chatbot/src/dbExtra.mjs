// dbExtra.mjs — เมธอด DB ส่วนขยาย (คลังความรู้ + ผลตรวจสลิป + overview stats)
// แยกไฟล์จาก db.mjs เพื่อคุมขนาดไฟล์ <800 บรรทัด — ตารางอยู่ใน schema.mjs เหมือนเดิม
import { randomUUID } from "node:crypto";
import { isReviewCatalogTitle, REVIEW_CATALOG_MAX_CHARS } from "./knowledgePack.mjs";
import { NON_HUMAN_NOTE_AUTHORS_SQL } from "./lineOaContext.mjs";
import { NEEDS_HUMAN_SLA_PERSON_REASONS } from "./needsPersonReason.mjs";
import { NOT_SPAM_SQL } from "./spamTag.mjs";
import { AD_REFERRAL_ORPHAN_RETENTION_DAYS, ORPHAN_AD_REFERRALS_DELETE_SQL } from "./dbAdReferrals.mjs";


// ขอบบนของช่วงเวลา — null/undefined/"" = ไม่มีขอบ
// ระวัง Number(null) === 0 ซึ่งเป็นตัวเลข finite: ถ้าเช็คด้วย Number.isFinite เฉย ๆ
// "ไม่มีขอบบน" จะกลายเป็น "created_at < 0" แล้วคิวรีคืนศูนย์แถวเงียบ ๆ
// (เกิดจริงแล้วหนึ่งรอบ: ยอดขายกลายเป็น 0 ทุกช่วงที่ไม่ระบุวันเดียว)
function upperBound(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const KNOWLEDGE_TITLE_MAX = 200;
export const KNOWLEDGE_CONTENT_MAX = 20000;
// 19 ต.ค. 2026: การ์ดคลังรีวิว ("รีวิวนักเรียนจริง") มีงบของตัวเอง 40,000 — เดิมแถวนี้ถูกตัดเงียบ ๆ ที่ 20,000
// (slice ด้านล่าง) ทั้งที่ฟอร์มคลังรีวิวรับได้ถึงเพดานคลังความรู้ = รายการท้ายคลังหายโดยไม่มีใครรู้
// การ์ดอื่นยังเพดานเดิม · ด่านงบจริงอยู่ที่คอนโซล (knowledgeCapError) ซึ่งปฏิเสธก่อนถึงตรงนี้
export const knowledgeContentMaxFor = (title) => (isReviewCatalogTitle(title)
  ? Math.max(KNOWLEDGE_CONTENT_MAX, REVIEW_CATALOG_MAX_CHARS) : KNOWLEDGE_CONTENT_MAX);
// v1.3.4: ผู้สมัครสำหรับตัวเฝ้า "ดีลร้อนค้าง" — คัดหยาบใน SQL ให้เหลือน้อยที่สุดก่อน
// แล้วค่อยตัดสินด้วยตรรกะบริสุทธิ์ใน hotLeadWatch (ทดสอบได้โดยไม่ต้องมี DB)
export const HOT_LEAD_SCAN_LIMIT = 200;
// 2026-09-02: ผู้สมัครสำหรับนาฬิกา SLA ของคิว "รอคน" — คัดใน SQL ให้เหลือเฉพาะห้องที่
// "ต้องใช้คน" และยังไม่มีใครตอบ แล้วตัดสินเงื่อนไขเวลาใน needsHumanSla.mjs
export const NEEDS_HUMAN_SLA_SCAN_LIMIT = 200;
// เหตุที่ยอมจ่ายค่า push — แหล่งเดียวคือ needsPersonReason.mjs (token คงที่ [a-z_] ล้วน)
const PERSON_REASON_IN_SQL = NEEDS_HUMAN_SLA_PERSON_REASONS.map((r) => `'${r}'`).join(", ");
// "_" เป็น wildcard ของ LIKE — escape ก่อน ไม่งั้น human_requested จะไปแมตช์ humanXrequested
const PERSON_REASON_SUMMARY_SQL = NEEDS_HUMAN_SLA_PERSON_REASONS
  .map((r) => `c.handoff_summary LIKE '%${r.replace(/_/gu, "\\_")}%' ESCAPE '\\'`)
  .join("\n                  OR ");

// "บอทรับปากว่าทีมงานจะดูแล แต่ยังไม่มีคนทำตาม" — กติกาเดียวกับ unkeptPromiseSql
// ใน db.mjs (สำเนาที่นี่เพราะ db.mjs เป็นฝ่าย import ไฟล์นี้ ย้อนกลับไม่ได้)
// แก้ที่หนึ่งต้องแก้อีกที่เสมอ ไม่งั้นคิวในคอนโซลกับตัวเตือนจะมองห้องไม่ตรงกัน
const unkeptPromiseSql = (customerCol) => `EXISTS (
          SELECT 1 FROM handoff_notes promise
          WHERE promise.customer_id = ${customerCol} AND promise.author = 'ai_promise'
            AND promise.created_at > COALESCE((
                  SELECT MAX(human_note.created_at) FROM handoff_notes human_note
                  WHERE human_note.customer_id = ${customerCol}
                    AND human_note.author NOT IN (${NON_HUMAN_NOTE_AUTHORS_SQL})), 0)
            AND promise.created_at > COALESCE((
                  SELECT MAX(human_out.created_at) FROM messages human_out
                  WHERE human_out.customer_id = ${customerCol} AND human_out.direction = 'out'
                    AND human_out.operator NOT IN (${NON_HUMAN_NOTE_AUTHORS_SQL})), 0)
        )`;

// dayStartMs = bangkokDayStartMs จาก db.mjs (ส่งเข้ามาแทน import — กัน circular import)
export function createExtraDbMethods({ db, run, all, get, now, dayStartMs = () => 0 }) {
  return {
    // v1.3.4: ผู้สมัคร "ดีลร้อนค้าง" — คัดหยาบด้วย SQL ให้เหลือน้อยที่สุด
    // การตัดสินจริงอยู่ใน hotLeadWatch เพื่อให้ทดสอบตรรกะได้โดยไม่ต้องมี DB
    listStalledHotLeadCandidates(minScore = 8, limit = HOT_LEAD_SCAN_LIMIT) {
      return all(
        `SELECT line_user_id, last_score, human_owner, last_seen_by_operator_at, updated_at
         FROM customers
         WHERE last_score >= ? AND line_user_id NOT LIKE 'canary:%'
         ORDER BY updated_at DESC LIMIT ?`,
        Math.trunc(Number(minScore) || 8), Math.min(1000, Math.max(1, Math.trunc(Number(limit)) || HOT_LEAD_SCAN_LIMIT))
      );
    },

    /* ------------------------------- overview ------------------------------- */

    // สถิติหน้า "ภาพรวม" — นับจาก SQL ล้วน (ห้ามนับจาก list บางส่วนฝั่ง client)
    // ลูกค้าสังเคราะห์ของ canary (id ขึ้นต้น 'canary:') ไม่ปนในตัวเลขของคนจริง
    // W3: channel = null คือทุกสาขา (query เดิมทุกตัวอักษร) / ระบุ = scope ต่อสาขา
    // (ตารางที่ไม่มี channel_id — corrections/followups/slip_checks — scope ผ่าน
    // join customers; metric สะสม noQuestionLowScore เป็น global เสมอ)
    overviewStats(channel = null) {
      const dayStart = dayStartMs(now());
      const n = (sql, ...params) => get(sql, ...params)?.n ?? 0;
      const ch = channel ? String(channel) : null;
      const chWhere = ch ? " AND channel_id = ?" : "";
      const chParams = ch ? [ch] : [];
      // scope ผ่าน customers สำหรับตารางลูกที่ไม่มี channel_id ของตัวเอง
      const viaCustomer = (table, alias, extra) => ch
        ? `SELECT COUNT(*) AS n FROM ${table} ${alias}
           JOIN customers c ON c.line_user_id = ${alias}.customer_id
           WHERE ${extra} AND c.channel_id = ?`
        : `SELECT COUNT(*) AS n FROM ${table} ${alias} WHERE ${extra}`;
      return {
        dayStartMs: dayStart,
        channel: ch,
        inboundToday: n(
          `SELECT COUNT(*) AS n FROM messages
           WHERE direction = 'in' AND created_at >= ? AND customer_id NOT LIKE 'canary:%'${chWhere}`,
          dayStart, ...chParams
        ),
        newCustomersToday: n(
          `SELECT COUNT(*) AS n FROM customers
           WHERE created_at >= ? AND line_user_id NOT LIKE 'canary:%'${chWhere}`,
          dayStart, ...chParams
        ),
        // 28 ก.ย. 2026 (ภาพรวมแบบ CEO): "วันนี้คุยกับลูกค้า N คน" ต้องนับ "คน" ไม่ใช่ "ข้อความ"
        // — ลูกค้าคนเดียวพิมพ์ 10 บรรทัดต้องนับเป็น 1 · ไม่มีตัวเลขเงิน จึงใช้สิทธิ์เดียวกับภาพรวมเดิม
        activeCustomersToday: n(
          `SELECT COUNT(DISTINCT customer_id) AS n FROM messages
           WHERE direction = 'in' AND created_at >= ? AND customer_id NOT LIKE 'canary:%'${chWhere}`,
          dayStart, ...chParams
        ),
        needsHuman: n(
          `SELECT COUNT(*) AS n FROM customers
           WHERE state = 'NEEDS_HUMAN' AND line_user_id NOT LIKE 'canary:%'${chWhere}`,
          ...chParams
        ),
        guardBlockedToday: n(
          viaCustomer("corrections", "co", "co.status = 'candidate' AND co.created_at >= ?"),
          dayStart, ...chParams
        ),
        guardBlockedTotal: n(
          viaCustomer("corrections", "co", "co.status = 'candidate'"),
          ...chParams
        ),
        imagesSentToday: n(
          `SELECT COUNT(*) AS n FROM messages
           WHERE direction = 'out' AND msg_type = 'image' AND created_at >= ?
             AND customer_id NOT LIKE 'canary:%'${chWhere}`,
          dayStart, ...chParams
        ),
        aiOffCustomers: n(
          `SELECT COUNT(*) AS n FROM customers
           WHERE ai_enabled = 0 AND line_user_id NOT LIKE 'canary:%'${chWhere}`,
          ...chParams
        ),
        totalCustomers: n(
          `SELECT COUNT(*) AS n FROM customers WHERE line_user_id NOT LIKE 'canary:%'${chWhere}`,
          ...chParams
        ),
        // G2a: ลูกค้า hot (score >= 8) + นัด follow-up ค้าง + metric ไม่จบด้วยคำถาม
        hotCustomers: n(
          `SELECT COUNT(*) AS n FROM customers
           WHERE last_score >= 8 AND line_user_id NOT LIKE 'canary:%'${chWhere}`,
          ...chParams
        ),
        pendingFollowups: n(
          viaCustomer("followups", "f", "f.status = 'pending'"),
          ...chParams
        ),
        // G3: สลิปที่ตรวจแล้วน่าสงสัยวันนี้ — ให้แอดมินรีบเปิดดูก่อนยืนยันยอด
        suspectSlipsToday: n(
          viaCustomer("slip_checks", "sc", "sc.status = 'suspect' AND sc.created_at >= ?"),
          dayStart, ...chParams
        ),
        noQuestionLowScore: Number(
          get("SELECT value FROM settings WHERE key = ?", "metric:no_question_low_score")?.value ?? 0
        ) || 0,
      };
    },

    // v1.2 (revamp ภาพรวม): อนุกรมรายวันย้อนหลังสำหรับกราฟ — เขตวันเวลาไทย (UTC+7)
    // คืน array ครบทุกวัน (วันเงียบ = 0) เรียงเก่า -> ใหม่; channel = null คือทุกสาขา
    dailySeries({ channel = null, days = 14 } = {}) {
      const d = Math.min(60, Math.max(7, Math.trunc(Number(days)) || 14));
      const since = dayStartMs(now()) - (d - 1) * 86_400_000;
      const ch = channel ? String(channel) : null;
      const chWhere = ch ? " AND channel_id = ?" : "";
      const chParams = ch ? [ch] : [];
      const dayExpr = "strftime('%Y-%m-%d', (created_at/1000) + 25200, 'unixepoch')";
      const inbound = all(
        `SELECT ${dayExpr} AS day, COUNT(*) AS n FROM messages
         WHERE direction = 'in' AND created_at >= ? AND customer_id NOT LIKE 'canary:%'${chWhere}
         GROUP BY day`,
        since, ...chParams
      );
      const revenue = all(
        `SELECT ${dayExpr} AS day, SUM(total) AS s, COUNT(*) AS n FROM orders
         WHERE created_at >= ? AND status IN ('confirmed','paid','shipped','done')
           AND customer_id NOT LIKE 'canary:%'${chWhere}
         GROUP BY day`,
        since, ...chParams
      );
      const newCustomers = all(
        `SELECT ${dayExpr} AS day, COUNT(*) AS n FROM customers
         WHERE created_at >= ? AND line_user_id NOT LIKE 'canary:%'${chWhere}
         GROUP BY day`,
        since, ...chParams
      );
      const mapOf = (rows, field) => new Map(rows.map((r) => [r.day, Number(r[field]) || 0]));
      const im = mapOf(inbound, "n");
      const rs = mapOf(revenue, "s");
      const rn = mapOf(revenue, "n");
      const nm = mapOf(newCustomers, "n");
      const series = [];
      for (let i = 0; i < d; i += 1) {
        const ts = since + i * 86_400_000;
        const day = new Date(ts + 25_200_000).toISOString().slice(0, 10);
        series.push({
          day, ts,
          inbound: im.get(day) || 0,
          revenue: rs.get(day) || 0,
          orders: rn.get(day) || 0,
          newCustomers: nm.get(day) || 0,
        });
      }
      return series;
    },

    // 2026-09-02: ผู้สมัครของนาฬิกา SLA "รอคน" — เฉพาะห้องที่ "ต้องใช้คน" และยังไม่มีใครตอบ
    //
    // บั๊กของจริงวันเปิดใช้: WHERE เดิมกว้างแค่ `ai_enabled != 1` ซึ่งบนเครื่องจริงมีห้อง
    // customer_handover (ลูกค้าเก่า) อยู่ ~818 ห้อง ห้องเก่าที่สุด 200 ห้องกิน LIMIT
    // จนหมด ทุกห้องตกด่านตอนตัดสินใน JS แล้วห้องที่ต้องใช้คนจริงไม่เคยถูกเห็นเลยสักรอบ
    // (dry-run พิมพ์ "200 ห้อง · จะปิดบันไดเตือน 0 · ข้าม 200") ตัวกรองจึงต้องอยู่ใน SQL
    //
    // เรียงคนรอนานสุดขึ้นก่อน — LIMIT ตัดคนที่เพิ่งรอ ไม่ใช่คนที่รอนานที่สุด
    listNeedsHumanSlaCandidates(limit = NEEDS_HUMAN_SLA_SCAN_LIMIT) {
      const NON_HUMAN = NON_HUMAN_NOTE_AUTHORS_SQL;
      return all(
        `SELECT * FROM (
           SELECT c.line_user_id, c.display_name, c.known_name, c.state, c.handoff_summary,
                  c.ai_enabled, c.ai_off_reason, c.money_seen_at, c.human_owner, c.channel_id,
                  (SELECT status FROM slip_checks sc WHERE sc.customer_id = c.line_user_id
                    ORDER BY sc.created_at DESC, sc.rowid DESC LIMIT 1) AS last_slip_status,
                  (SELECT MAX(m.created_at) FROM messages m
                    WHERE m.customer_id = c.line_user_id AND m.direction = 'in') AS last_inbound_at,
                  -- "คนตอบ" เท่านั้น: ข้อความของบอท/ระบบ/ตัวนำเข้าไม่นับว่ามีคนดูแลแล้ว
                  (SELECT MAX(m.created_at) FROM messages m
                    WHERE m.customer_id = c.line_user_id AND m.direction = 'out'
                      AND m.operator NOT IN (${NON_HUMAN})) AS last_operator_outbound_at,
                  CASE WHEN ${unkeptPromiseSql("c.line_user_id")} THEN 1 ELSE 0 END AS unkept_promise,
                  -- F9 (ตรวจย้อนหลัง ก.ย. 2026): ข้อความขาเข้าล่าสุด 12 แถว (ตัดเนื้อความสั้น) ให้ตัวเลือก
                  -- แยก "ข้อความที่ควรทวง" ออกจากแฮชแท็ก/สติกเกอร์/คำรับสั้น ๆ — อ่านในหน่วยความจำเท่านั้น
                  (SELECT json_group_array(json_object('at', r.created_at, 'type', r.msg_type, 'text', substr(r.content, 1, 160)))
                     FROM (SELECT created_at, msg_type, content FROM messages m
                            WHERE m.customer_id = c.line_user_id AND m.direction = 'in'
                            ORDER BY m.created_at DESC, m.rowid DESC LIMIT 12) r) AS recent_inbound_json,
                  -- หมุด "คนเปิด AI คืน/รีเซ็ตห้อง" ตัวเดียวกับใบ้ส่งไม้ต่อ (pipeline.handoffHintResetKey)
                  (SELECT CAST(s.value AS INTEGER) FROM settings s
                    WHERE s.key = 'handoff_hint_reset:' || c.line_user_id) AS ai_reopened_at
           FROM customers c
           WHERE c.line_user_id NOT LIKE 'canary:%'
             -- 28 ก.ย. 2026: ห้องสแปม (ป้าย null) ไม่มีใครต้องตอบ — ห้ามทวงทีมซ้ำ
             AND ${NOT_SPAM_SQL("c.line_user_id")}
             AND (
                  -- AI ปิดถาวรด้วยเหตุของคน (ลูกค้าเก่า customer_handover ไม่เข้าข่าย)
                  (c.ai_enabled != 1 AND c.ai_off_reason IN (${PERSON_REASON_IN_SQL}))
                  -- ห้องส่งต่อ: เหตุอยู่ใน handoff_summary — กรองหยาบด้วย LIKE ที่นี่
                  -- แล้ว needsPersonReason อ่าน token หัวบรรทัดตัดสินอีกชั้น
                  OR (c.state = 'NEEDS_HUMAN' AND (${PERSON_REASON_SUMMARY_SQL}))
             )
         ) candidate
         WHERE candidate.last_inbound_at IS NOT NULL
           -- ยังไม่มีใครตอบเท่านั้น: ห้องที่คนตอบแล้วไม่มีวันถึงกำหนด อย่าให้กิน LIMIT
           AND candidate.last_inbound_at > COALESCE(candidate.last_operator_outbound_at, 0)
         ORDER BY candidate.last_inbound_at ASC
         LIMIT ?`,
        Math.max(1, Math.min(NEEDS_HUMAN_SLA_SCAN_LIMIT, Number(limit) || NEEDS_HUMAN_SLA_SCAN_LIMIT)),
      );
    },

    // G7.1: ตัวเลขสรุปสำหรับ Owner Daily Digest — ทุกตัวจาก SQL ล้วน, ตัดลูกค้า canary
    // sinceMs = จุดเริ่มช่วงสรุป (ตั้งแต่ digest ที่ส่งจริงครั้งก่อน); needsHuman = สถานะปัจจุบัน
    // ลูกค้าที่ทักมาแล้วยังไม่มีใครตอบ เรียงคนรอนานสุดขึ้นก่อน
    //
    // 2026-08-28: วันที่เจอ มีลูกค้ารอคำตอบ 4 คน นานสุด 89 ชั่วโมง โดยไม่มีใครรู้ทั้งวัน
    // ข้อมูลอยู่ในคอนโซลมาตลอด แต่ไม่มีอะไรมาสะกิด สรุปเช้าจึงต้องนำด้วยเรื่องนี้
    // รวมห้องที่บอทรับปากลูกค้าว่าทีมงานจะติดต่อกลับแล้วยังไม่มีใครทำตามด้วย
    digestWaitingRooms(limit = 5) {
      const NON_HUMAN = NON_HUMAN_NOTE_AUTHORS_SQL;
      const rows = all(
        `SELECT c.line_user_id, c.display_name, c.known_name,
                (SELECT MAX(created_at) FROM messages
                  WHERE customer_id = c.line_user_id AND direction = 'in') AS last_inbound_at
         FROM customers c
         WHERE c.line_user_id NOT LIKE 'canary:%'
           -- 28 ก.ย. 2026: ห้องสแปม (ป้าย null) ไม่ขึ้นในสรุปเจ้าของว่า "ลูกค้ารอคำตอบ"
           AND ${NOT_SPAM_SQL("c.line_user_id")}
           AND (c.state = 'NEEDS_HUMAN' OR ${unkeptPromiseSql("c.line_user_id")})
           AND (SELECT MAX(created_at) FROM messages
                 WHERE customer_id = c.line_user_id AND direction = 'in') >
               COALESCE((SELECT MAX(created_at) FROM messages
                 WHERE customer_id = c.line_user_id AND direction = 'out'), 0)
         ORDER BY last_inbound_at ASC
         LIMIT ?`,
        Math.max(1, Math.min(20, Number(limit) || 5)),
      );
      return rows.map((r) => ({
        customerId: r.line_user_id,
        name: r.known_name || r.display_name || `ลูกค้า …${String(r.line_user_id).slice(-4)}`,
        lastInboundAt: Number(r.last_inbound_at) || 0,
      }));
    },

    digestStats(sinceMs = 0) {
      const since = Number(sinceMs) || 0;
      const n = (sql, ...params) => get(sql, ...params)?.n ?? 0;
      return {
        inbound: n(
          `SELECT COUNT(*) AS n FROM messages
           WHERE direction = 'in' AND created_at >= ? AND customer_id NOT LIKE 'canary:%'`,
          since
        ),
        inboundCustomers: n(
          `SELECT COUNT(DISTINCT customer_id) AS n FROM messages
           WHERE direction = 'in' AND created_at >= ? AND customer_id NOT LIKE 'canary:%'`,
          since
        ),
        newCustomers: n(
          `SELECT COUNT(*) AS n FROM customers
           WHERE created_at >= ? AND line_user_id NOT LIKE 'canary:%'`,
          since
        ),
        needsHuman: n(
          "SELECT COUNT(*) AS n FROM customers WHERE state = 'NEEDS_HUMAN' AND line_user_id NOT LIKE 'canary:%'"
        ),
        suspectSlips: n(
          `SELECT COUNT(*) AS n FROM slip_checks
           WHERE status = 'suspect' AND created_at >= ? AND customer_id NOT LIKE 'canary:%'`,
          since
        ),
        // 🔥 top 3 ลูกค้าใกล้ปิดการขาย — score มากก่อน แล้วค่อยความสดของแถว
        hotTop: all(
          `SELECT line_user_id, display_name, known_name, last_score FROM customers
           WHERE last_score >= 8 AND line_user_id NOT LIKE 'canary:%'
           ORDER BY last_score DESC, updated_at DESC LIMIT 3`
        ),
      };
    },

    // W3: mapping destination (bot user id ใน webhook) -> channel id ที่ verify แล้ว
    // เก็บใน settings key "line_dest:<destination>" — หน้า "ตั้งค่า" ใช้โชว์ read-only
    listDestinationMappings() {
      return all("SELECT key, value FROM settings WHERE key LIKE 'line_dest:%'")
        .map((row) => ({ destination: String(row.key).slice("line_dest:".length), channelId: row.value }));
    },
    /* ------------------------------ ROAS ------------------------------ */
    // ค่าแอดรายวันจาก Make — ยิงซ้ำวันเดิม = ทับ ไม่ใช่บวกเพิ่ม (day เป็น primary key)
    // ป้องกันเคสที่ Make รันซ้ำหรือ retry แล้วยอดบานขึ้นเรื่อย ๆ โดยไม่มีใครรู้
    upsertAdsSpend({ day, spendThb, accountId = "", source = "make", raw = "" } = {}) {
      run(
        `INSERT INTO ads_spend (day, spend_thb, account_id, source, raw_json, updated_at)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(day) DO UPDATE SET
           spend_thb = excluded.spend_thb, account_id = excluded.account_id,
           source = excluded.source, raw_json = excluded.raw_json, updated_at = excluded.updated_at`,
        String(day), Math.max(0, Number(spendThb) || 0), String(accountId),
        String(source), String(raw).slice(0, 4000), now()
      );
      return get("SELECT * FROM ads_spend WHERE day = ?", String(day)) ?? null;
    },

    // รวมค่าแอดของช่วงที่เลือก — ขอบเป็นวันแบบเวลาไทย (fromDay ถึง toDay รวมปลายทั้งสอง)
    // ท่ออัตโนมัติเคยยิงข้อมูลเข้ามาแล้วหรือยัง — ใช้ตัดสินว่ายังตกกลับไปใช้ค่ากรอกมือได้ไหม
    hasAnyAdsSpend() {
      return Number(get("SELECT COUNT(*) AS n FROM ads_spend")?.n) > 0;
    },

    adsSpendBetween(fromDay, toDay) {
      const row = get(
        "SELECT SUM(spend_thb) AS total, COUNT(*) AS days FROM ads_spend WHERE day >= ? AND day <= ?",
        String(fromDay), String(toDay)
      );
      return { totalThb: Number(row?.total) || 0, days: Number(row?.days) || 0 };
    },

    listAdsSpend(limit = 40) {
      return all(
        "SELECT day, spend_thb, account_id, source, updated_at FROM ads_spend ORDER BY day DESC LIMIT ?",
        Math.min(400, Math.max(1, Math.trunc(Number(limit)) || 40))
      );
    },

    // ยอดขายที่นับเป็นเงินจริงแล้ว แยกตามช่องทางที่คุยกับลูกค้า
    // (ช่องทางนี้คือ "ห้องที่คุย" ไม่ใช่ "ที่มาของลีด" — คนเห็นแอด FB แล้วไปทักไลน์จะนับเป็น LINE)
    revenueByChannelSince(sinceMs, untilMs = null) {
      const until = upperBound(untilMs);
      const capped = until !== null;
      return all(
        `SELECT channel_id, COUNT(*) AS orders, SUM(COALESCE(total, 0)) AS revenue
         FROM orders
         WHERE status IN ('confirmed','paid','shipped','done') AND created_at >= ?
           ${capped ? "AND created_at < ?" : ""}
           AND customer_id NOT LIKE 'canary:%'
         GROUP BY channel_id ORDER BY revenue DESC`,
        Number(sinceMs) || 0, ...(capped ? [until] : [])
      );
    },

    // ข้อความที่ระบบเราส่งออกทาง LINE ในช่วงเวลาหนึ่ง — ใช้หักออกจากยอดโควตารวมของ OA
    // เพื่อหาว่าส่วนที่เหลือคือบรอดแคสที่พี่ง้วงยิงจาก manager.line.biz กี่ข้อความ
    // นับทั้ง reactive และ proactive เพราะทั้งคู่คือ "ข้อความที่บอทส่ง" ในสายตาเจ้าของ
    lineOutboundCount(sinceMs, untilMs = null) {
      const until = upperBound(untilMs);
      return get(
        `SELECT COUNT(*) AS n FROM messages
         WHERE direction = 'out' AND channel_id = 'default'
           AND customer_id NOT LIKE 'canary:%'
           AND created_at >= ?${until !== null ? " AND created_at < ?" : ""}`,
        Number(sinceMs) || 0, ...(until !== null ? [until] : [])
      )?.n ?? 0;
    },

    /* ------------------------------ KPI (คน vs ลูกแพร) ------------------------------ */
    // ดึงเฉพาะคอลัมน์ที่ใช้คำนวณ ไม่ดึง content — หน้า KPI ไม่ต้องเห็นเนื้อความลูกค้า
    // และก้อนข้อมูลเล็กพอจะคำนวณใน JS ได้ทั้งหมด (นับตั้งแต่บอทขึ้นระบบเท่านั้น)
    kpiMessagesSince(sinceMs, channelId = null) {
      const cols = "customer_id, direction, operator, agent_mode, message_class, created_at,\n        CASE WHEN content LIKE '#%' THEN 1 ELSE 0 END AS is_hashtag";
      return channelId
        ? all(
            `SELECT ${cols} FROM messages WHERE created_at >= ? AND channel_id = ? ORDER BY customer_id, created_at`,
            Number(sinceMs) || 0, String(channelId)
          )
        : all(`SELECT ${cols} FROM messages WHERE created_at >= ? ORDER BY customer_id, created_at`, Number(sinceMs) || 0);
    },

    kpiCustomers(channelId = null) {
      const cols = "line_user_id, channel_id, ai_enabled, ai_off_reason, deal_status, state";
      return channelId
        ? all(`SELECT ${cols} FROM customers WHERE channel_id = ?`, String(channelId))
        : all(`SELECT ${cols} FROM customers`);
    },

    // Step 0 "ทำไมลูกแพรตอบแบบนี้" + จอสอนที่เปิดจากห้องแชท (เฟส 3)
    //
    // brain_version_id เป็นสัญญาณเดียวที่ซื่อสัตย์ว่า "เทิร์นนี้สมองรุ่นไหนเสิร์ฟ" —
    // ว่าง = ตอบจากตารางเดิม ต้องพูดตรง ๆ ห้ามเดารุ่นจาก pointer ปัจจุบัน
    //
    // `content` มีมาด้วยเพราะจอสอนต้องแสดง "ลูกแพรตอบไว้ว่าอะไร" แต่ผู้เรียกต้องใช้มัน
    // เฉพาะแถว direction='out' (คำพูดของบอทเอง) เท่านั้น — ข้อความขาเข้าเป็นของลูกค้า
    // และไม่มีเหตุผลใดที่จอสอนต้องคัดลอกมันมา (แบบแปลน §6 Step 3 sandbox)
    messageBrainContext(messageId) {
      return get(
        `SELECT id, customer_id, direction, message_class, operator, agent_mode,
                brain_version_id, content, created_at
           FROM messages WHERE id = ?`,
        String(messageId),
      ) ?? null;
    },

    // บอทเริ่มติดป้าย agent_mode ตอนขึ้นระบบจริง — แถวก่อนหน้านั้นเป็นของระบบเก่า
    // ที่แยกไม่ออกว่าใครตอบ ใช้เวลานี้เป็นขอบล่างของทุก KPI เพื่อไม่ให้ของเก่าปนจนอ่านผิด
    kpiAttributionStartMs() {
      const row = get("SELECT MIN(created_at) AS first FROM messages WHERE agent_mode IS NOT NULL");
      return Number(row?.first) || 0;
    },

    /* --------------------------- knowledge (คลังความรู้) --------------------------- */

    // G6 (P1): channelId = null คือสมองกลาง / = channel id คือความรู้เฉพาะสาขา (โหมดสมองแยก)
    addKnowledge({
      title = "", content = "", updatedBy = "", channelId = null,
      source = "human_console", provenance = {}, supersedesId = null, version = 1,
    } = {}) {
      const id = randomUUID();
      const t = now();
      run(
        `INSERT INTO knowledge_entries
          (id,title,content,active,updated_by,channel_id,source,provenance_json,
           supersedes_id,version,created_at,updated_at)
         VALUES (?,?,?,1,?,?,?,?,?,?,?,?)`,
        id, String(title).slice(0, KNOWLEDGE_TITLE_MAX), String(content).slice(0, knowledgeContentMaxFor(String(title).slice(0, KNOWLEDGE_TITLE_MAX))),
        String(updatedBy), channelId == null ? null : String(channelId), String(source || "human_console"),
        JSON.stringify(provenance && typeof provenance === "object" ? provenance : {}),
        supersedesId == null ? null : String(supersedesId), Math.max(1, Number(version) || 1), t, t
      );
      return this.getKnowledge(id);
    },

    getKnowledge(id) {
      return get("SELECT * FROM knowledge_entries WHERE id = ? AND deleted_at IS NULL", String(id)) ?? null;
    },

    getKnowledgeIncludingDeleted(id) {
      return get("SELECT * FROM knowledge_entries WHERE id = ?", String(id)) ?? null;
    },

    // หน้า console: ใหม่สุดขึ้นก่อน (แถวที่เพิ่งเพิ่ม/แก้เจอง่าย)
    listKnowledge() {
      return all("SELECT * FROM knowledge_entries WHERE deleted_at IS NULL ORDER BY created_at DESC, rowid DESC");
    },

    // สำหรับ prompt: เฉพาะ active เรียงเก่า -> ใหม่ (ตัวตัดเพดานทิ้งของเก่าสุดก่อน)
    // G6 (P1): scope null = สมองกลาง (channel_id IS NULL — แถวเดิมทุกแถวเข้ากรณีนี้) /
    // = channel id คือ "เฉพาะความรู้ของสาขานั้น" (สมองแยกไม่อ่านกลาง — true separation)
    listActiveKnowledge(channelId = null) {
      return channelId
        ? all(
            "SELECT * FROM knowledge_entries WHERE active = 1 AND deleted_at IS NULL AND channel_id = ? ORDER BY created_at ASC, rowid ASC",
            String(channelId)
          )
        : all("SELECT * FROM knowledge_entries WHERE active = 1 AND deleted_at IS NULL AND channel_id IS NULL ORDER BY created_at ASC, rowid ASC");
    },

    // field ที่ไม่ส่งมา = คงค่าเดิม — updated_at/updated_by อัปเดตเสมอ
    updateKnowledge(id, { title, content, active, updatedBy = "", provenance } = {}) {
      const row = this.getKnowledge(id);
      if (!row) return null;
      // provenance เป็นซองข้อมูลหลายเจ้าของ (lineage / source / retrieval เป็นต้น)
      // ผู้เรียกที่ไม่ได้แตะมันต้องได้ JSON เดิมทุกไบต์; ผู้เรียกที่แตะส่งทั้ง object
      // ที่รวม key เก่าแล้วมาให้ เพื่อไม่ให้ metadata ชุดหนึ่งลบ lineage ของอีกชุดหนึ่ง.
      const nextProvenance = provenance === undefined
        ? row.provenance_json
        : JSON.stringify(provenance && typeof provenance === "object" ? provenance : {});
      run(
        `UPDATE knowledge_entries SET title = ?, content = ?, active = ?, updated_by = ?, provenance_json = ?, updated_at = ?
         WHERE id = ? AND deleted_at IS NULL`,
        typeof title === "string" ? title.slice(0, KNOWLEDGE_TITLE_MAX) : row.title,
        typeof content === "string"
          ? content.slice(0, knowledgeContentMaxFor(typeof title === "string" ? title.slice(0, KNOWLEDGE_TITLE_MAX) : row.title))
          : row.content,
        typeof active === "boolean" ? (active ? 1 : 0) : row.active,
        String(updatedBy || row.updated_by), nextProvenance, now(), String(id)
      );
      return this.getKnowledge(id);
    },

    deleteKnowledge(id) {
      const t = now();
      return run(
        "UPDATE knowledge_entries SET active=0,deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL",
        t, t, String(id),
      ).changes === 1;
    },

    /* --------------------------- retention pruning (M4) --------------------------- */

    // ลบข้อมูลเก่ากว่ากรอบ retention หนึ่งรอบ — คืนจำนวนแถวที่ลบต่อตาราง (เส้นแบ่ง strict:
    // แถวที่เก่ากว่า cutoff เท่านั้นที่ถูกลบ แถวที่อายุเท่ากรอบพอดียังอยู่)
    // schedule_ack:<id> เก็บ epoch ms ของจุดเริ่มช่วงปิด (scheduleGate) ใน value —
    // ตัดสินอายุจากค่านั้น ไม่ใช่เวลาเขียนแถว; parse ไม่ได้ = แถวขยะ ลบทิ้ง
    pruneRetention({ now: t = now(), days = {} } = {}) {
      const cutoff = (d) => t - Math.max(0, Number(d) || 0) * 86_400_000;
      const pruned = {
        eventsDedupe: run("DELETE FROM events_dedupe WHERE seen_at < ?", cutoff(days.eventsDedupe ?? 30)).changes,
        llmUsage: run("DELETE FROM llm_usage WHERE created_at < ?", cutoff(days.llmUsage ?? 180)).changes,
        scoreHistory: run("DELETE FROM score_history WHERE created_at < ?", cutoff(days.scoreHistory ?? 180)).changes,
        adminAudit: run("DELETE FROM admin_audit WHERE created_at < ?", cutoff(days.adminAudit ?? 365)).changes,
        // audit 2026-08-25: web_push_events เก็บ line_user_id ดิบ แต่ตัวลบเดิมอยู่ใน
        // pruneWebPush ซึ่งทุกผู้เรียกกั้นด้วย available (= ต้องมี VAPID + WEB_PUSH_ENABLED)
        // ผลคือขณะ Web Push ปิด แถวหมดอายุไม่เคยถูกลบเลย — ย้ายครึ่งที่เป็น PII มาที่
        // retention รายวัน ให้ทำงานเสมอไม่ว่าฟีเจอร์จะเปิดหรือปิด
        expiredWebPushEvents: run("DELETE FROM web_push_events WHERE expires_at <= ?", t).changes,
        scheduleAck: 0,
        opportunityHandoff: 0,
        trainingCandidate: 0,
        messageAttachments: 0,
        orphanMessageAttachments: 0,
        attachmentDownloadTokens: 0,
        queuedMediaDeletes: 0,
        operatorOutboundAttempts: 0,
      };
      pruned.attachmentDownloadTokens += run(
        "DELETE FROM attachment_download_tokens WHERE expires_at < ?", t,
      ).changes;
      // 6 ต.ค. 2026: referral ของแอดที่ไม่มีห้อง (เธรดเดิมกดแอดแล้วไม่เคยพิมพ์) ไม่มีหน้าจอไหนเห็น
      // และปุ่มลืมในคอนโซลเข้าไม่ถึง — กวาดตามอายุเสมอ ไม่ว่าสวิตช์เก็บจะเปิดหรือปิด (dbAdReferrals.mjs)
      pruned.orphanAdReferrals = run(
        ORPHAN_AD_REFERRALS_DELETE_SQL, cutoff(days.orphanAdReferrals ?? AD_REFERRAL_ORPHAN_RETENTION_DAYS),
      ).changes;
      pruned.operatorOutboundAttempts += run(
        "DELETE FROM operator_outbound_attempts WHERE status IN ('accepted','partial','rejected') AND created_at < ?",
        cutoff(days.operatorOutboundAttempts ?? 365),
      ).changes;
      // บัญชีผลลัพธ์เทิร์นขาเข้าที่ "ปิดแล้ว" เป็นของชั่วคราวสำหรับตามงานค้าง ไม่ใช่ประวัติแชท
      // (ประวัติจริงอยู่ในตาราง messages ซึ่งไม่มีการลบตามอายุ) — เก็บไว้ 30 วันพอ
      pruned.inboundTurnOutcomes = run(
        `DELETE FROM inbound_turn_outcomes
         WHERE status NOT IN ('owed','sending') AND created_at < ?`,
        cutoff(30),
      ).changes;
      const ackCutoff = cutoff(days.scheduleAck ?? 30);
      for (const row of all("SELECT key, value FROM settings WHERE key LIKE 'schedule_ack:%'")) {
        const start = Number(row.value);
        if (!Number.isFinite(start) || start < ackCutoff) {
          pruned.scheduleAck += run("DELETE FROM settings WHERE key = ?", row.key).changes;
        }
      }
      // Pipeline idempotence entries are JSON containing createdAt. Old/plain
      // or malformed entries cannot be aged safely, so remove them rather than
      // retaining customer-linked state indefinitely.
      const handoffCutoff = cutoff(days.opportunityHandoff ?? 180);
      for (const row of all("SELECT key, value FROM settings WHERE key LIKE 'opportunity_handoff:%'")) {
        let createdAt = NaN;
        try {
          createdAt = Number(JSON.parse(row.value)?.createdAt);
        } catch {
          // invalid or legacy value: pruned below
        }
        if (!Number.isFinite(createdAt) || createdAt < handoffCutoff) {
          pruned.opportunityHandoff += run("DELETE FROM settings WHERE key = ?", row.key).changes;
        }
      }
      // An upload is only staging until it is linked to an accepted operator
      // message. Expire abandoned rows/bytes and any grants atomically; the
      // durable queue performs the physical deletion after commit.
      const orphanCutoff = cutoff(days.messageMediaOrphan ?? 1);
      const orphanAttachments = all(
        `SELECT id,customer_id,storage_key FROM message_attachments
         WHERE source='operator_upload' AND (message_id IS NULL OR message_id='') AND created_at < ?`,
        orphanCutoff,
      );
      if (orphanAttachments.length) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const attachment of orphanAttachments) {
            if (attachment.storage_key) {
              pruned.queuedMediaDeletes += run(
                `INSERT OR IGNORE INTO message_media_deletion_queue (storage_key,customer_id,reason,created_at,updated_at)
                 VALUES (?, ?, 'orphan_upload_retention', ?, ?)`,
                attachment.storage_key, attachment.customer_id, t, t,
              ).changes;
            }
            pruned.attachmentDownloadTokens += run(
              "DELETE FROM attachment_download_tokens WHERE attachment_id=?", attachment.id,
            ).changes;
            pruned.orphanMessageAttachments += run(
              "DELETE FROM message_attachments WHERE id=?", attachment.id,
            ).changes;
          }
          db.exec("COMMIT");
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
          throw error;
        }
      }
      // Training snapshots are private owner-review material, not business
      // records. Expiry removes only the review artifact (candidate + feedback).
      // Customer chat history and conversation sessions are retained indefinitely:
      // a training reset is a prompt boundary, never a retention boundary.
      // 0/negative = retain training artifacts indefinitely.
      pruned.trainingFeedbackOrphans = run(
        `DELETE FROM training_feedback
         WHERE session_id NOT IN (SELECT id FROM conversation_sessions)`,
      ).changes;
      const candidateRetentionDays = days.trainingCandidate ?? 30;
      const candidateCutoff = candidateRetentionDays > 0 ? cutoff(candidateRetentionDays) : null;
      const expiredCandidates = candidateCutoff === null ? [] : all(
        `SELECT id, customer_id, session_id FROM training_candidates
         WHERE created_at < ? ORDER BY created_at ASC`,
        candidateCutoff,
      );
      if (expiredCandidates.length) {
        db.exec("BEGIN IMMEDIATE");
        try {
          for (const candidate of expiredCandidates) {
            // Training feedback may contain review-only notes and follows the
            // candidate's lifecycle. Do not cascade into message attachments,
            // messages, or sessions: those are the permanent customer record.
            run("DELETE FROM training_feedback WHERE session_id = ?", candidate.session_id);
            pruned.trainingCandidate += run("DELETE FROM training_candidates WHERE id = ?", candidate.id).changes;
          }
          db.exec("COMMIT");
        } catch (error) {
          try { db.exec("ROLLBACK"); } catch { /* no open transaction */ }
          throw error;
        }
      }
      return pruned;
    },

    /* ----------------------------- slip checks (ตรวจสลิป) ---------------------------- */

    addSlipCheck({ customerId, messageId = "", status = "pending", amount = null, transRef = "", payloadJson = "" } = {}) {
      const id = randomUUID();
      run(
        `INSERT INTO slip_checks (id, customer_id, message_id, status, amount, trans_ref, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, String(customerId), String(messageId), String(status),
        amount == null ? null : Number(amount), String(transRef), String(payloadJson), now()
      );
      return id;
    },

    updateSlipCheck(id, { status, amount = null, transRef = "", payloadJson = "" } = {}) {
      return run(
        "UPDATE slip_checks SET status = ?, amount = ?, trans_ref = ?, payload_json = ? WHERE id = ?",
        String(status), amount == null ? null : Number(amount), String(transRef), String(payloadJson), String(id)
      ).changes === 1;
    },

    getSlipCheck(id) {
      return get("SELECT * FROM slip_checks WHERE id = ?", String(id)) ?? null;
    },

    listSlipChecksFor(customerId, limit = 20) {
      return all(
        "SELECT * FROM slip_checks WHERE customer_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
        String(customerId), Math.min(100, Math.max(1, Number(limit) || 20))
      );
    },
  };
}
