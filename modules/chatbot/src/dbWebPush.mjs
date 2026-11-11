// Durable Web Push state. Subscription endpoints are bearer capabilities and
// never leave this module through console responses or audit text.
import { rolesWithCapability } from "./operatorRoles.mjs";
import { NOT_SPAM_SQL } from "./spamTag.mjs";

// บทบาทที่ "ส่งของจริงถึง" ต้องมาจากตารางสิทธิ์ชุดเดียวกับที่ใช้ตอนกดเปิด
// ห้าม hardcode รายชื่อบทบาทซ้ำที่นี่ เพราะจะเพี้ยนออกจากกันเงียบ ๆ อีก
const NOTIFY_ROLES = rolesWithCapability("notifications.manage");
const NOTIFY_ROLE_SQL = NOTIFY_ROLES.map(() => "?").join(",");

export function createWebPushDbMethods({ run, all, get, now }) {
  return {
    upsertWebPushSubscription({
      id, operatorUsername, endpoint, endpointHash, sessionIdHash,
      sessionExpiresAt, tokenVersion, userAgent = "",
    }) {
      const t = now();
      run(
        `INSERT INTO web_push_subscriptions
          (id,operator_username,endpoint,endpoint_hash,session_id_hash,session_expires_at,
           token_version,user_agent,enabled,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,1,?,?)
         ON CONFLICT(endpoint_hash) DO UPDATE SET
           operator_username=excluded.operator_username,
           endpoint=excluded.endpoint,
           session_id_hash=excluded.session_id_hash,
           session_expires_at=excluded.session_expires_at,
           token_version=excluded.token_version,
           user_agent=excluded.user_agent,
           enabled=1,
           updated_at=excluded.updated_at`,
        String(id), String(operatorUsername), String(endpoint), String(endpointHash),
        String(sessionIdHash), Number(sessionExpiresAt), Number(tokenVersion) || 1,
        String(userAgent).slice(0, 160), t, t,
      );
      return get("SELECT * FROM web_push_subscriptions WHERE endpoint_hash=?", String(endpointHash));
    },

    activeWebPushSubscriptions(at = now()) {
      return all(
        `SELECT s.* FROM web_push_subscriptions s
         JOIN operators o ON o.username=s.operator_username
         WHERE s.enabled=1 AND s.session_expires_at>? AND o.disabled=0
           AND o.role IN (${NOTIFY_ROLE_SQL})
           AND o.token_version=s.token_version
         ORDER BY s.created_at ASC`,
        Number(at), ...NOTIFY_ROLES,
      );
    },

    // 12 ต.ค. 2026 ค่ำ (พี่ง้วง: "แจ้งเตือนห้องตรวจไปที่พี่ง้วงคนเดียว"): เครื่องของบัญชี owner เท่านั้น
    // (owner มีบัญชีเดียวโดยธรรมชาติ — auth.mjs seed บัญชีแรก) · เงื่อนไข session/token ชุดเดียวกับ activeWebPushSubscriptions
    activeOwnerWebPushSubscriptions(at = now()) {
      return all(
        `SELECT s.* FROM web_push_subscriptions s
         JOIN operators o ON o.username=s.operator_username
         WHERE s.enabled=1 AND s.session_expires_at>? AND o.disabled=0
           AND o.role='owner' AND o.role IN (${NOTIFY_ROLE_SQL})
           AND o.token_version=s.token_version
         ORDER BY s.created_at ASC`,
        Number(at), ...NOTIFY_ROLES,
      );
    },

    // เหตุการณ์ห้องตรวจของเจ้าของที่ยังไม่หมดอายุ (reason ขึ้นต้น owner_review_) — /push/pending ใช้ตัดสินว่าจะแสดงรายการไหม
    // reason = เจาะจงชนิด (owner_review_close | owner_review_daily — เฟส B) · ว่าง = ชนิดใดก็ได้
    latestOwnerReviewPushEvent(operatorUsername, at = now(), reason = "") {
      return get(
        `SELECT * FROM web_push_events
         WHERE operator_username=? AND expires_at>? AND substr(reason,1,13)='owner_review_' AND (?='' OR reason=?)
         ORDER BY created_at DESC,rowid DESC LIMIT 1`,
        String(operatorUsername), Number(at), String(reason || ""), String(reason || ""),
      ) || null;
    },

    // เจ้าของเปิดห้องตรวจแล้ว = เห็นแล้ว — เครื่องไม่ต้องเด้ง "รอยืนยันปิด" ซ้ำทุกครั้งที่ลูกค้าทัก
    clearOwnerReviewPushEvents(operatorUsername) {
      return run(
        "DELETE FROM web_push_events WHERE operator_username=? AND substr(reason,1,13)='owner_review_'",
        String(operatorUsername),
      ).changes;
    },

    activeWebPushSubscriptionCount(operatorUsername, at = now()) {
      return Number(get(
        `SELECT COUNT(*) AS n FROM web_push_subscriptions s
         JOIN operators o ON o.username=s.operator_username
         WHERE s.operator_username=? AND s.enabled=1 AND s.session_expires_at>?
           AND o.disabled=0 AND o.role IN (${NOTIFY_ROLE_SQL}) AND o.token_version=s.token_version`,
        String(operatorUsername), Number(at), ...NOTIFY_ROLES,
      )?.n || 0);
    },

    // ผูกเครื่องที่ยังเปิดอยู่เข้ากับ session/token ชุดใหม่
    // ใช้ตอนเปลี่ยนรหัสผ่านตัวเอง ซึ่งเลื่อน token_version และออก session ใหม่ทันที
    // ถ้าไม่ทำ แถวเดิมจะถือ token เก่าตลอดไป → เงื่อนไข o.token_version=s.token_version
    // ตัดทิ้งถาวร แจ้งเตือนบนมือถือเครื่องที่เพิ่งเปลี่ยนรหัสจะตายเงียบ ๆ
    rebindWebPushSessions({ operatorUsername, sessionIdHash, sessionExpiresAt, tokenVersion }) {
      return run(
        `UPDATE web_push_subscriptions
            SET session_id_hash=?, session_expires_at=?, token_version=?, updated_at=?
          WHERE operator_username=? AND enabled=1`,
        String(sessionIdHash), Number(sessionExpiresAt), Number(tokenVersion) || 1, now(),
        String(operatorUsername),
      ).changes;
    },

    disableWebPushEndpoint(operatorUsername, endpointHash) {
      return run(
        "UPDATE web_push_subscriptions SET enabled=0,updated_at=? WHERE operator_username=? AND endpoint_hash=?",
        now(), String(operatorUsername), String(endpointHash),
      ).changes;
    },

    disableWebPushSession(operatorUsername, sessionIdHash) {
      return run(
        "UPDATE web_push_subscriptions SET enabled=0,updated_at=? WHERE operator_username=? AND session_id_hash=?",
        now(), String(operatorUsername), String(sessionIdHash),
      ).changes;
    },

    recordWebPushResult(id, { ok = false, status = 0, retire = false } = {}) {
      const t = now();
      if (retire) {
        return run(
          "UPDATE web_push_subscriptions SET enabled=0,last_failure_at=?,last_status=?,updated_at=? WHERE id=?",
          t, Number(status) || 0, t, String(id),
        ).changes;
      }
      return run(
        ok
          ? "UPDATE web_push_subscriptions SET last_success_at=?,last_status=?,updated_at=? WHERE id=?"
          : "UPDATE web_push_subscriptions SET last_failure_at=?,last_status=?,updated_at=? WHERE id=?",
        t, Number(status) || 0, t, String(id),
      ).changes;
    },

    queueWebPushEvent({ id, operatorUsername, customerId, channelId = "default", reason = "inbound", dedupeKey, expiresAt }) {
      const result = run(
        `INSERT OR IGNORE INTO web_push_events
          (id,operator_username,customer_id,channel_id,reason,dedupe_key,created_at,expires_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        String(id), String(operatorUsername), String(customerId), String(channelId),
        String(reason), String(dedupeKey), now(), Number(expiresAt),
      );
      return result.changes === 1
        ? get("SELECT * FROM web_push_events WHERE id=?", String(id))
        : null;
    },

    // ===== ความจริงของ "ใครยังรออยู่" มาจากตาราง messages ไม่ใช่ตารางเหตุการณ์ =====
    // ตาราง web_push_events ถูกเขียนหลังจากตอบ 200 ให้ LINE ไปแล้ว ถ้ากระบวนการถูก
    // รีสตาร์ทในจังหวะนั้น แถวจะหายถาวร และ LINE ส่งซ้ำก็กู้ไม่ได้เพราะติด dedupe
    // ส่วน messages ถูกบันทึกในธุรกรรมเดียวกับข้อความลูกค้า จึงไม่มีวันหาย
    //
    // นิยาม "ยังรอ" = ข้อความล่าสุดของลูกค้า ใหม่กว่า ทั้งสองอย่างนี้
    //   (ก) เวลาที่แอดมิน "เปิดห้องนั้นดู" (customers.last_seen_by_operator_at)
    //   (ข) คำตอบล่าสุดจาก "คนจริง"
    //
    // (ก) คือหัวใจ — เหมือน LINE OA ที่ลบตัวเลขแดงตอนเราแค่กดเข้าไปดู ไม่ต้องตอบ
    // ถ้าไม่มีข้อนี้ พอเปิดลูกแพรให้ตอบเอง ทุกห้องที่ลูกแพรคุยจบแล้วจะค้างในคิว "รอ"
    // ยาว 12 ชั่วโมงเพราะไม่มีคนจริงเข้าไปตอบ แล้วรายการจะบวมจนใช้งานไม่ได้
    // ใช้คอลัมน์เดียวกับที่หน้ารายการใช้นับ unread (db.mjs:1293) การแจ้งเตือนกับ
    // ตัวเลขแดงในหน้ารายการจึงตรงกันเสมอโดยไม่ต้องซิงก์อะไรเพิ่ม
    //
    // (ข) คนจริง = ขาออก + reactive + มีชื่อผู้ใช้ + ไม่ใช่ system
    //   - broadcast กับ follow-up เป็น proactive จึงไม่นับ (ไม่งั้นบรอดแคสต์ตอนเช้า
    //     จะกลบเคสที่ค้างมาทั้งคืนหายหมด ซึ่งคือความล้มเหลวที่แย่ที่สุดของระบบนี้)
    //   - คำตอบของ AI ไม่มีชื่อผู้ใช้ จึงไม่นับ (ตอบแล้วแต่ยังไม่มีใครดู = ยังเด้ง
    //     ตรงกับที่พี่ง้วงสั่งว่า "ทุกแชทควรมี noti" เหมือน LINE OA)
    //
    // เทียบกับ "ข้อความล่าสุด" ไม่ใช่ทีละเหตุการณ์ ลูกค้าที่ทักมาอีกหลังแอดมินดู/ตอบแล้ว
    // จึงกลับเข้าคิวรออีกครั้งเสมอ
    unansweredCustomers(sinceMs, limit = 50) {
      return all(
        `SELECT m.customer_id AS customer_id, MAX(m.created_at) AS last_inbound_at
           FROM messages m
           -- LEFT JOIN โดยตั้งใจ: ถ้าแถวลูกค้าหายไปด้วยเหตุใดก็ตาม ต้องยัง "เด้ง"
           -- ไม่ใช่เงียบ — การไม่แจ้งเตือนแย่กว่าการแจ้งเตือนเกินเสมอในระบบนี้
           LEFT JOIN customers c ON c.line_user_id=m.customer_id
          WHERE m.direction='in' AND m.created_at>?
            -- 28 ก.ย. 2026: ห้องสแปม (ป้าย null) ไม่ใช่เคสที่ต้องปลุกใคร (ไม่มีแถวป้าย = ยังเด้งตามเดิม)
            AND ${NOT_SPAM_SQL("m.customer_id")}
          GROUP BY m.customer_id
         HAVING last_inbound_at > MAX(
                  COALESCE(c.last_seen_by_operator_at, 0),
                  COALESCE((
                    SELECT MAX(h.created_at) FROM messages h
                     WHERE h.customer_id=m.customer_id
                       AND h.direction='out'
                       AND h.message_class='reactive'
                       AND h.operator<>'' AND h.operator<>'system'
                  ), 0)
                )
          ORDER BY last_inbound_at ASC
          LIMIT ?`,
        Number(sinceMs), Number(limit) || 50,
      );
    },

    latestWebPushEvent(operatorUsername, at = now()) {
      return get(
        `SELECT * FROM web_push_events
         WHERE operator_username=? AND expires_at>?
         ORDER BY created_at DESC,rowid DESC LIMIT 1`,
        String(operatorUsername), Number(at),
      ) || null;
    },

    // หมายเหตุ 2026-08-25: การลบ event ที่หมดอายุถูกทำซ้ำใน db.pruneRetention ด้วย
    // (เส้นนั้นทำงานทุกวันแม้ Web Push ปิด) ตรงนี้คงไว้เพื่อให้สถานะสดทันทีตอนเปิดใช้งาน
    pruneWebPush(at = now()) {
      const expiredEvents = run("DELETE FROM web_push_events WHERE expires_at<=?", Number(at)).changes;
      const expiredSubscriptions = run(
        "UPDATE web_push_subscriptions SET enabled=0,updated_at=? WHERE enabled=1 AND session_expires_at<=?",
        Number(at), Number(at),
      ).changes;
      return { expiredEvents, expiredSubscriptions };
    },
  };
}
