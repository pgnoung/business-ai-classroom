// PDPA cascade — ไล่ตารางจาก schema เอง ไม่ใช่จากลิสต์ที่คนเขียนค้างไว้
//
// บทเรียนจริง: เทสต์เดิม (sales-intel.test.mjs) เทียบกับลิสต์ RESET_COVERED_TABLES
// ที่เขียนมือ และดูเฉพาะคอลัมน์ customer_id ตารางที่ผูกลูกค้าด้วย line_user_id
// จึงหลุดออกไปเงียบ ๆ สองตาราง (บัญชี "ไม่รู้ว่าถึงหรือไม่" ของบรอดแคสต์
// และปลายทางทดสอบส่งเอง) ไฟล์นี้อ่านตารางจาก sqlite_master + PRAGMA table_info
// ทุกครั้งที่รัน ตารางใหม่ที่มี customer_id หรือ line_user_id จะถูกจับได้เอง
//
// สิทธิ์ให้ลืม = ต้องไม่เหลือ id ของคนนั้นอยู่ที่ไหนเลย ยกเว้น customer_tombstones
// ที่เก็บแค่ hash ไว้พิสูจน์ว่าเคยลบ (คงไว้ตามนโยบาย และไม่มีคอลัมน์ id ดิบอยู่แล้ว)
//
// 2026-09-03 (เฟส 3): เพิ่มการไล่ **ตัวชี้ข้อความ** ด้วย — golden_turns.message_ref ชี้
// messages.id ตรง ๆ ตารางแบบนี้ไม่มีคอลัมน์ customer_id จึงหลุดจากการไล่แบบเดิมทั้งใบ
// (แบบแปลน §5 PDPA ข้อ 1 สั่งไว้ว่า cascade ต้องครอบ message_id/message_ref ด้วย)
// ไล่จาก PRAGMA เหมือนเดิม ตารางใหม่ในอนาคตที่ผูกข้อความจึงถูกจับได้เองโดยไม่ต้องแก้ไฟล์นี้
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb } from "./helpers.mjs";

const ID = "U-pdpa-synthetic";
const NEIGHBOUR = "U-pdpa-neighbour"; // ห้ามมี ID เป็นสตริงย่อย — ใช้ตรวจว่าลูกค้าคนอื่นไม่โดนหางเลข

// ค่าที่ต้องใส่เองเพราะติด CHECK constraint หรือชี้ไปตารางแม่ (foreign key)
const COLUMN_VALUES = {
  broadcast_delivery_unknown_recipients: { broadcast_id: "bc-1", quarantine_id: "q-1" },
  broadcast_recipients: { broadcast_id: "bc-1" },
  customer_facts: { source: "human" },
  // 28 ก.ย. 2026: ลูกค้าคนเดียวกันข้าม Facebook ↔ LINE (dbIdentityLinks.mjs) — CHECK บนที่มาของการเชื่อม/รหัส
  customer_identity_links: { linked_via: "team" },
  identity_link_codes: { issued_via: "console" },
  followup_suggestions: { status: "suggested" },
  inbound_image_classifications: {
    classification_state: "classified", classified_kind: "other",
    diagnostic_code: "valid", action: "text_pipeline",
  },
  llm_usage: { kind: "draft" },
  // 28 ก.ย. 2026: สถานะเพื่อนจาก webhook follow/unfollow (สตูดิโอบรอดแคสต์)
  line_follow_state: { state: "followed" },
  // 28 ก.ย. 2026: ข้อความตามขั้น — ชี้ลำดับ/คนในลำดับที่ seedParents สร้างไว้
  step_enrollments: { sequence_id: "seq-pdpa", status: "active" },
  step_deliveries: { enrollment_id: "enr-pdpa-parent", sequence_id: "seq-pdpa", status: "sent" },
  // storage_key ต้องว่าง ไม่งั้นด่านกันไฟล์ค้างจะปฏิเสธการลบทั้งก้อน (ตั้งใจ fail-closed)
  message_attachments: { direction: "in", kind: "image", storage_key: "" },
  messages: { direction: "in" },
  // golden_turns มี CHECK บน severity และคอลัมน์ที่ต้องมีค่าเฉพาะทาง
  golden_turns: { severity: "style", case_id: "pdpa-case", origin: "eval_case" },
  operator_outbound_attempts: { status: "sending" },
  proactive_attempts: { status: "sending" },
  slip_checks: { status: "pending" },
  web_push_events: { operator_username: "nok" },
};

// customers ใส่ผ่าน API ปกติ ส่วนคิวลบไฟล์เป็นด่านกันการลบ (จัดการแยกในเทสต์)
const SEEDED_BY_HAND = new Set(["customers", "message_media_deletion_queue", "inbound_image_classifications", "jev_shadow"]);

// คีย์ใน settings ที่ผูกกับลูกค้า ต้องเขียน id เป็น segment เต็ม ๆ คั่นด้วย ":" เสมอ
// (ทั้ง `<ชื่อ>:<id>` และ `<ชื่อ>:<id>:<อะไรต่อ>`) — resetCustomer กวาดตามรูปแบบนี้
// คีย์สุดท้ายจงใจเป็นชื่อที่ยังไม่มีใครลงทะเบียนไว้ เพื่อพิสูจน์ว่าคีย์ใหม่ในอนาคต
// ถูกกวาดด้วยโดยไม่ต้องกลับมาแก้ resetCustomer อีก
function settingsKeysFor(id) {
  return [`schedule_ack:${id}`, `oob_last:${id}`, `opportunity_handoff:${id}:x`, `future_thing:${id}`];
}

function customerKeyedTables(db) {
  return db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => {
      const columns = db.raw.prepare(`PRAGMA table_info(${row.name})`).all();
      const key = columns.find((col) => col.name === "customer_id" || col.name === "line_user_id");
      return key ? { table: row.name, keyColumn: key.name, columns } : null;
    })
    .filter(Boolean);
}

// ตารางที่ผูกกับ "ข้อความ" แทนที่จะผูกกับ "ลูกค้า" — id ของลูกค้าไม่ปรากฏในแถวเลย
// แต่ตัวชี้ยังบอกได้ว่าเคยมีข้อความของใครอยู่ตรงไหน สิทธิ์ให้ลืมจึงต้องกวาดด้วย
// ข้อยกเว้นเดียว และต้องมีเหตุผลเขียนไว้เสมอ: `events_dedupe.message_id` ไม่ใช่ตัวชี้
// `messages.id` ของเรา แต่เป็น id ของ **เหตุการณ์ webhook ฝั่ง LINE** (คนละ namespace)
// ถ้าลบตามลูกค้า การส่งเหตุการณ์เดิมซ้ำจะถูกประมวลผลอีกรอบ = ตอบซ้ำคนที่ขอให้ลืมไปแล้ว
// แถวนี้ถูกกวาดด้วยงาน retention รายวัน (30 วัน) ตามนโยบายเดิม ไม่ใช่ตามคำขอลืม
const FOREIGN_MESSAGE_ID_TABLES = new Set(["events_dedupe"]);

function messageKeyedTables(db) {
  return db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => {
      const columns = db.raw.prepare(`PRAGMA table_info(${row.name})`).all();
      if (columns.some((col) => col.name === "customer_id" || col.name === "line_user_id")) return null;
      if (FOREIGN_MESSAGE_ID_TABLES.has(row.name)) return null;
      const key = columns.find((col) => col.name === "message_ref" || col.name === "message_id");
      return key ? { table: row.name, keyColumn: key.name, columns } : null;
    })
    .filter(Boolean);
}

function seedRow(db, { table, keyColumn, columns }, id) {
  const values = { [keyColumn]: id, ...(COLUMN_VALUES[table] || {}) };
  for (const col of columns) {
    if (col.name in values) continue;
    const required = col.notnull === 1 || col.pk === 1;
    if (!required || col.dflt_value !== null) continue;
    values[col.name] = /INT|REAL/i.test(col.type) ? 1 : `pdpa-${col.name}`;
  }
  const names = Object.keys(values);
  db.raw
    .prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((name) => values[name]));
}

function countFor(db, { table, keyColumn }, id) {
  return Number(db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${keyColumn} = ?`).get(id).n);
}

function keysContaining(db, id) {
  return db.raw
    .prepare("SELECT key FROM settings")
    .all()
    .map((row) => row.key)
    .filter((key) => key.includes(id));
}

// ตารางแม่ที่แถวลูกอ้างถึง — ต้องมีก่อน ไม่งั้น foreign key ตีกลับ
function seedParents(db) {
  const t = Date.now();
  // 12 ต.ค. 2026 ค่ำ: ตารางห้องตรวจของพี่ง้วงสร้างตอนเขียนครั้งแรก (dbOwnerReview.mjs) — สร้างก่อนไล่ตาราง ไม่งั้นหลุดการตรวจ
  db.ensureOwnerReviewTables();
  db.raw.prepare(
    `INSERT INTO operators (username,pass_hash,display_name,role,disabled,created_at,updated_at,token_version)
     VALUES ('nok','not-a-real-hash','พี่นก','owner',0,?,?,1)`,
  ).run(t, t);
  db.raw.prepare("INSERT INTO broadcasts (id,created_at,updated_at) VALUES ('bc-1',?,?)").run(t, t);
  db.raw.prepare("INSERT INTO step_sequences (id,trigger_type,created_at,updated_at) VALUES ('seq-pdpa','follow',?,?)").run(t, t);
  db.raw.prepare(
    `INSERT INTO step_enrollments (id,sequence_id,customer_id,status,anchor_at,enrolled_at,updated_at)
     VALUES ('enr-pdpa-parent','seq-pdpa','U-pdpa-parent-only','active',?,?,?)`,
  ).run(t, t, t);
  db.raw.prepare(
    `INSERT INTO broadcast_delivery_quarantines
      (id,channel_id,audience_fingerprint,broadcast_id,batch_no,retry_key_hash,failure_kind,created_at)
     VALUES ('q-1','default','fp-1','bc-1',1,'rk-1','ambiguous',?)`,
  ).run(t);
}

function seedEverything(db, id) {
  const tables = customerKeyedTables(db);
  db.upsertCustomer(id, { displayName: "ลูกค้าสังเคราะห์" });
  for (const entry of tables) {
    if (SEEDED_BY_HAND.has(entry.table)) continue;
    seedRow(db, entry, id);
  }
  // JEV observations reference a real primary score; assert the FK cascade too.
  const score = db.latestScoreRow(id);
  db.raw.prepare(`INSERT INTO jev_shadow
    (id,customer_id,score_id,session_id,evidence_hash,policy,primary_model,primary_score,model,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(`shadow:${id}`, id, score.id, "fixture-session", "fixture-hash", "fixture-policy", "luna", 1, "jev", "pending", Date.now());
  // The evidence row is only valid when it points at a real inbound image.
  // Keep that FK in this exhaustive seed so the reset assertion checks the
  // same cascade relationship used by the runtime.
  const imageMessageId = `in:pdpa-image:${id}`;
  db.insertMessage({ id: imageMessageId, customerId: id, direction: "in", msgType: "image", content: "[image]" });
  db.raw.prepare(
    `INSERT INTO inbound_image_classifications
      (message_id,customer_id,provider_message_id,classification_state,classified_kind,diagnostic_code,action,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(imageMessageId, id, `provider:${id}`, "classified", "other", "valid", "text_pipeline", Date.now(), Date.now());
  for (const key of settingsKeysFor(id)) db.setSetting(key, "1");
  return tables;
}

// ทุกตารางที่ผูกกับข้อความ ต้องมีแถวที่ชี้ไปยัง "ข้อความจริงของคนที่จะถูกลืม" หนึ่งแถว
// คืนรายการตาราง + id ข้อความที่ใช้ ให้ผู้เรียกไปตรวจว่าหายจริงหลังลบ
function seedMessageKeyed(db, id) {
  const messageId = String(db.insertMessage({ customerId: id, direction: "in", content: "ข้อความที่กลายเป็นเทิร์นตรวจซ้ำ" }));
  const tables = messageKeyedTables(db);
  for (const entry of tables) seedRow(db, entry, messageId);
  return { tables, messageId };
}

test("PDPA: forget=true ต้องไม่เหลือแถวของลูกค้าในทุกตารางที่ schema ผูกกับลูกค้า", () => {
  const db = memoryDb();
  seedParents(db);
  const tables = seedEverything(db, ID);
  assert.ok(tables.length >= 25, `ต้องเจอตารางที่ผูกลูกค้าอย่างน้อย 25 ตาราง (เจอ ${tables.length})`);
  const messageKeyed = seedMessageKeyed(db, ID);
  assert.ok(messageKeyed.tables.length >= 1,
    "ต้องเจอตารางที่ผูกกับข้อความอย่างน้อยหนึ่งตาราง (golden_turns) — ถ้าเป็น 0 แปลว่าการไล่ตารางพัง");

  // ลูกค้าคนอื่น (และคีย์ settings ของเขา) ห้ามหายไปด้วย
  db.upsertCustomer(NEIGHBOUR, { displayName: "ลูกค้าคนอื่น" });
  db.insertMessage({ customerId: NEIGHBOUR, direction: "in", content: "อยู่ต่อ" });
  for (const key of settingsKeysFor(NEIGHBOUR)) db.setSetting(key, "1");

  // ด่านกันไฟล์ค้าง: ยังมีคิวลบไฟล์อยู่ = ห้ามลบข้อมูลใน DB (fail-closed)
  db.raw.prepare(
    "INSERT INTO message_media_deletion_queue (storage_key,customer_id,reason,created_at,updated_at) VALUES (?,?,?,?,?)",
  ).run("pdpa-storage-key", ID, "pdpa_cascade_test", Date.now(), Date.now());
  assert.throws(() => db.resetCustomer(ID, { forget: true }), /customer media deletion is incomplete/u);
  // จำลองว่าลบไฟล์จริงเสร็จแล้ว แล้วค่อยลบข้อมูล
  db.raw.prepare("DELETE FROM message_media_deletion_queue WHERE customer_id = ?").run(ID);

  assert.deepEqual(db.resetCustomer(ID, { forget: true }), { forgotten: true });

  for (const entry of tables) {
    assert.equal(countFor(db, entry, ID), 0, `ตาราง ${entry.table} ต้องไม่เหลือแถวของคนที่ขอให้ลืม`);
  }
  for (const entry of messageKeyed.tables) {
    assert.equal(countFor(db, entry, messageKeyed.messageId), 0,
      `ตาราง ${entry.table} ยังเหลือตัวชี้ข้อความของคนที่ขอให้ลืม (${entry.keyColumn})`);
  }
  assert.deepEqual(keysContaining(db, ID), [], "settings ต้องไม่เหลือคีย์ที่มี id ของลูกค้าอยู่เลย");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM attachment_download_tokens").get().n, 0,
    "สิทธิ์ดาวน์โหลดไฟล์ของลูกค้าต้องหายด้วย");
  assert.equal(db.listCustomerTombstones().length, 1, "ต้องเหลือ tombstone (hash) ไว้พิสูจน์ว่าเคยลบ");

  // ลูกค้าคนอื่นอยู่ครบ
  assert.ok(db.getCustomer(NEIGHBOUR), "ลูกค้าคนอื่นห้ามหาย");
  assert.equal(db.messagesFor(NEIGHBOUR).length, 1, "ข้อความของลูกค้าคนอื่นห้ามหาย");
  assert.equal(keysContaining(db, NEIGHBOUR).length, settingsKeysFor(NEIGHBOUR).length,
    "คีย์ settings ของลูกค้าคนอื่นห้ามหาย");
  db.close();
});

test("PDPA: forget=false ล้างทุกตารางเหมือนกัน แต่แถวลูกค้าอยู่ต่อในสถานะรีเซ็ต", () => {
  const db = memoryDb();
  seedParents(db);
  const tables = seedEverything(db, ID);
  db.setAiEnabled(ID, false, "manual");
  db.setNeedsHuman(ID, "test");
  db.setKnownName(ID, "บี");
  db.markPriceDeferred(ID);
  db.markPriceQuoted(ID);
  db.markCustomerContextKnown(ID);

  const customer = db.resetCustomer(ID, { forget: false });
  assert.ok(customer, "reset ธรรมดาต้องคืนแถวลูกค้า");
  assert.equal(customer.display_name, "ลูกค้าสังเคราะห์", "reset ธรรมดาคง display_name");
  assert.equal(customer.known_name, "");
  assert.equal(customer.ai_enabled, 1);
  assert.equal(customer.state, "AI_ACTIVE");
  assert.equal(customer.money_seen_at, 0);
  assert.equal(customer.price_deferred_at, 0, "หมุดจังหวะราคาเป็นสถานะรายลูกค้า — reset/PDPA ต้องล้างด้วย");
  assert.equal(customer.price_quoted_at, 0, "หมุด 'แจ้งราคาไปแล้ว' ก็เป็นสถานะรายลูกค้าเช่นกัน");
  assert.equal(customer.known_context_at, 0, "หมุด 'ลูกค้าเล่าบริบทของตัวเองแล้ว' เป็นข้อมูลของลูกค้า ต้องถูกล้าง");

  for (const entry of tables) {
    if (entry.table === "customers") continue; // แถวลูกค้าตั้งใจให้อยู่ต่อ
    assert.equal(countFor(db, entry, ID), 0, `ตาราง ${entry.table} ต้องไม่เหลือแถวของลูกค้า`);
  }
  // forget=false ลบ llm_usage ทิ้งจริง (ไม่ใช่แค่ตัดชื่อออกแบบเส้นทางลืม)
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM llm_usage").get().n, 0,
    "reset ธรรมดาต้องลบ llm_usage ของลูกค้าทิ้ง");
  assert.deepEqual(keysContaining(db, ID), [], "settings ต้องไม่เหลือคีย์ที่มี id ของลูกค้าอยู่เลย");
  assert.equal(db.listCustomerTombstones().length, 0, "reset ธรรมดาไม่ใช่การลืม จึงไม่มี tombstone");
  db.close();
});

test("PDPA: คีย์ settings ของลูกค้าที่ id ขึ้นต้นเหมือนกันห้ามโดนกวาดไปด้วย", () => {
  const db = memoryDb();
  db.upsertCustomer("U1", {});
  db.upsertCustomer("U10", {});
  db.setSetting("schedule_ack:U1", "1");
  db.setSetting("schedule_ack:U10", "1");
  db.setSetting("opportunity_handoff:U10:round-1", "1");

  db.resetCustomer("U1", { forget: true });

  assert.equal(db.getSetting("schedule_ack:U1"), null, "คีย์ของคนที่ขอให้ลืมต้องหาย");
  assert.equal(db.getSetting("schedule_ack:U10"), "1", "คีย์ของลูกค้าคนอื่นที่ id ขึ้นต้นเหมือนกันห้ามหาย");
  assert.equal(db.getSetting("opportunity_handoff:U10:round-1"), "1", "คีย์ย่อยของลูกค้าคนอื่นห้ามหาย");
  db.close();
});

test("PDPA: attempt ค้างคิวต้องปั้นข้อความกลับมาไม่ได้หลังลบลูกค้าแล้ว", () => {
  const db = memoryDb();
  const id = "U-pdpa-ledger";
  db.upsertCustomer(id, { displayName: "ลูกค้าค้างคิว" });
  const payload = {
    historyRows: [{ id: "ledger-msg-1", customerId: id, direction: "out", content: "ข้อความที่ provider รับแล้วแต่ยังไม่ลงประวัติ" }],
    operatorActiveUntil: Date.now() + 60_000,
  };
  const attempt = db.createOperatorOutboundAttempt({ customerId: id, operator: "nok", payload });
  assert.equal(
    db.setAcceptedOperatorOutboundAttemptProjection(attempt.id, { payload, providerStatus: 200 }),
    true,
    "ตั้งสถานะ accepted_pending ต้องสำเร็จ (จำลอง provider ตอบรับแล้ว process ตายก่อนเขียนประวัติ)",
  );
  assert.equal(db.listOperatorOutboundAttempts("accepted_pending").length, 1);

  db.resetCustomer(id, { forget: true });

  // เส้นทางกู้คืนตอน boot ต้องไม่มีอะไรให้กู้ — ถ้ามี ข้อความของคนที่ลบไปแล้วจะโผล่กลับมา
  assert.deepEqual(db.recoverAcceptedOperatorOutboundAttempts(), { attempted: 0, recovered: 0, failed: 0 });
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM operator_outbound_attempts WHERE customer_id = ?").get(id).n, 0,
    "ไม่เหลือ attempt ของลูกค้าที่ลบไปแล้ว");
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM messages WHERE customer_id = ?").get(id).n, 0,
    "ห้ามมีข้อความใหม่ถูกปั้นขึ้นมาหลังลบลูกค้า");
  db.close();
});
