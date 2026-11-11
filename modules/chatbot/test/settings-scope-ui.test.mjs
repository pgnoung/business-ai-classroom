// Settings context regression tests: Business -> Brain -> LINE OA must not
// cause settings.mjs to rebuild the other OA forms while an operator has a draft.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { businessDisplayName, productRulesStarter, selectedChannelId } from "../public/console/settings.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const settingsSource = readFileSync(join(ROOT, "public", "console", "settings.mjs"), "utf8");
const cssSource = readFileSync(join(ROOT, "public", "console", "instance-scope.css"), "utf8");

test("settings OA selector: keeps a valid chosen OA and falls back deterministically", () => {
  const channels = [{ id: "main", name: "Main" }, { id: "class", name: "Class" }];
  assert.equal(selectedChannelId(channels, "class"), "class");
  assert.equal(selectedChannelId(channels, "removed-oa"), "main");
  assert.equal(selectedChannelId([], "class"), null);
  assert.equal(selectedChannelId(null, "class"), null);
});

test("settings product rules starter is business-neutral", () => {
  const starter = productRulesStarter();
  assert.match(starter, /สินค้า\/บริการ/);
  assert.match(starter, /ข้อเสนอ/);
  assert.doesNotMatch(starter, /Airdog|ไส้กรอง|เครื่องฟอกอากาศ/i);
});

test("settings business identity reads branding at render time, not module construction time", () => {
  const state = { branding: { name: "Front Desk" } };
  assert.equal(businessDisplayName(state), "Front Desk");
  state.branding = { name: "พี่ง้วง - ติดกระดุม" };
  assert.equal(businessDisplayName(state), "พี่ง้วง - ติดกระดุม");
});

test("settings OA switching uses hidden rows, not a selector-driven render", () => {
  assert.match(settingsSource, /node\.hidden\s*=\s*!visible/);
  assert.match(settingsSource, /classList\.toggle\("is-oa-hidden",\s*!visible\)/);
  assert.match(settingsSource, /settings-oa-row/);
  assert.doesNotMatch(settingsSource, /select\.addEventListener\("change",\s*renderSettings/);
  assert.match(cssSource, /\.settings-oa-row\.is-oa-hidden\s*\{\s*display:\s*none;/);
  assert.match(cssSource, /@media \(max-width: 520px\)[\s\S]*\.settings-oa-select \{ font-size: 14px;/);
});

test("settings states the scope explicitly and never renders channel secrets", () => {
  assert.match(settingsSource, /Business/);
  assert.match(settingsSource, /Brain/);
  assert.match(settingsSource, /LINE OA/);
  assert.match(settingsSource, /ใช้ร่วมทุก LINE OA ภายใต้/);
  assert.match(settingsSource, /ไม่มี access token หรือ secret แสดงใน console/);
});

test("settings notify chips never pass null into native replaceChildren", () => {
  assert.match(settingsSource, /if \(!children\.length\) children\.push/);
  assert.match(settingsSource, /chipList\.replaceChildren\(\.\.\.children\)/);
  assert.doesNotMatch(settingsSource, /chipList\.replaceChildren\([\s\S]{0,800}ids\.length \? null/);
});
