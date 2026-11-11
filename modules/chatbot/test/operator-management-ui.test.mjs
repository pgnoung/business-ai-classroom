import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url);

test("console UI แสดง user management เฉพาะ capability และซ่อนหน้าสำคัญจาก staff", () => {
  const settings = readFileSync(new URL("public/console/settings.mjs", ROOT), "utf8");
  const shell = readFileSync(new URL("public/console/console.js", ROOT), "utf8");
  const css = readFileSync(new URL("public/console/console.css", ROOT), "utf8");

  assert.match(settings, /can\("users\.manage"\)/);
  assert.match(settings, /\/console\/api\/operators/);
  assert.match(settings, /Super Admin สร้างบัญชีได้/);
  assert.match(settings, /Admin — ตั้งค่าระบบได้/);
  assert.match(settings, /Staff — แชท\/ลูกค้า\/ออเดอร์/);
  assert.match(shell, /capability: "knowledge\.manage"/);
  assert.match(shell, /capability: "corrections\.review"/);
  assert.match(shell, /capability: "training\.review"/);
  assert.match(css, /\.settings-user-create/);
});
