// ลบลูกค้าทดสอบที่สร้างจากคำสั่ง chat (ใช้ตอน golive on) — กันงานทักตาม/บรอดแคสต์ยิงไปหา id ปลอม
// รันตอนบริการหยุดเท่านั้น (SQLite มีเจ้าของได้ process เดียว)
import { openDb } from "../src/db.mjs";
import { TEST_USER_PREFIX } from "./test-user.mjs";

const db = openDb({ file: process.env.DB_FILE, teachHashSecret: process.env.CONSOLE_SESSION_SECRET || "" });
try {
  const rows = db.raw.prepare("SELECT line_user_id FROM customers WHERE substr(line_user_id, 1, ?) = ?")
    .all(TEST_USER_PREFIX.length, TEST_USER_PREFIX);
  for (const { line_user_id: id } of rows) db.resetCustomer(id, { forget: true, forgetReason: "starter_test_chat" });
  console.log(`✅ ล้างห้องทดสอบ ${rows.length} ห้อง`);
} finally {
  db.close?.();
}
