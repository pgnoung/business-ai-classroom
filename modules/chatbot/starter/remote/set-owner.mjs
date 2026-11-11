// ตั้ง/เปลี่ยนรหัสบัญชีเจ้าของ (owner) ของหน้า console — รันตอนบริการหยุดเท่านั้น (SQLite มีเจ้าของได้ process เดียว)
// stdin: บรรทัด 1 = ชื่อผู้ใช้, บรรทัด 2 = รหัสผ่าน — ไม่พิมพ์รหัสออกจอ
import { readFileSync } from "node:fs";
import { openDb } from "../src/db.mjs";
import { hashPassword } from "../src/auth.mjs";

const [username = "", password = ""] = readFileSync(0, "utf8").split(/\r?\n/);
if (!/^[a-zA-Z0-9._-]{3,32}$/.test(username) || password.length < 10) {
  console.error("❌ ชื่อผู้ใช้หรือรหัสผ่านไม่ผ่านเงื่อนไข");
  process.exit(2);
}
const db = openDb({ file: process.env.DB_FILE, teachHashSecret: process.env.CONSOLE_SESSION_SECRET || "" });
try {
  if (db.getOperator(username)) {
    db.changeOperatorPassword(username, hashPassword(password));
    console.log(`✅ เปลี่ยนรหัสของ ${username} แล้ว`);
  } else {
    const role = db.countOperators() === 0 ? "owner" : "operator";
    db.createOperator({ username, passHash: hashPassword(password), displayName: username, role });
    console.log(`✅ สร้างบัญชี ${username} (${role === "owner" ? "เจ้าของ" : "ทีมงาน"}) แล้ว`);
  }
} finally {
  db.close?.();
}
