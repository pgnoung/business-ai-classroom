import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATIC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "console");
const read = (name) => readFileSync(join(STATIC_DIR, name), "utf8");

function tokenBlock(css, selector) {
  const match = css.match(new RegExp(`${selector.replaceAll(".", "\\.")}\\s*\\{([\\s\\S]*?)\\n\\}`, "u"));
  assert.ok(match, `missing ${selector} token block`);
  return match[1];
}

test("console theme tokens: Pngoung light and dark scopes define every semantic token consumed by workspace", () => {
  const css = read("instance-scope.css");
  const tokens = ["--danger", "--danger-soft", "--danger-line", "--brand-ink", "--muted", "--on-brand", "--green-line", "--orange-line", "--purple-line", "--neutral-soft", "--chart-inbound", "--chart-revenue",
    "--qualify", "--qualify-soft", "--qualify-ink"];
  for (const block of [tokenBlock(css, ":root.theme-pngoung"), tokenBlock(css, ":root.theme-pngoung.theme-dark")]) {
    for (const token of tokens) assert.match(block, new RegExp(`${token}:`, "u"), `${token} must be defined in both themes`);
  }
  assert.match(css, /:root\.theme-pngoung\s*\{[\s\S]*?color-scheme:\s*light/u);
  assert.match(css, /:root\.theme-pngoung\.theme-dark\s*\{[\s\S]*?color-scheme:\s*dark/u);
});

test("console theme tokens: scoped UI uses semantic tokens instead of audited legacy palette literals", () => {
  // 28 ก.ย. 2026: หน้าภาพรวมแยกเป็นหลายไฟล์ (กราฟย้ายไป charts.mjs) — ทุกไฟล์ที่ทุก instance ใช้ร่วมกัน
  // ต้องพึ่ง token เท่านั้น สีประจำแบรนด์ลูกแพรอยู่ได้เฉพาะใน theme-lukprae*.css
  const scoped = ["console.css", "workspace.css", "overview.mjs", "overviewCeo.mjs", "overviewTeam.mjs", "overviewRoas.mjs", "overviewAdReferrals.mjs",
    "charts.mjs", "kpiVisual.mjs", "ui.mjs", "overview.css", "kpi.css", "lineUsage.mjs", "lineUsage.css",
    "contextTags.mjs", "tagEditor.css", "settingsHashtagTags.mjs"].map(read).join("\n");
  for (const literal of ["#fdf4f1", "#d13868", "#c94f6d", "#8b5fbf", "#f6ebee", "#f1e7e9", "#7c3aed", "#a855f7", "#ff7fa5"]) {
    assert.ok(!scoped.toLowerCase().includes(literal), `legacy literal ${literal} must not remain in scoped UI`);
  }
  assert.ok(!/var\(--(?:danger|brand-ink|muted)\s*,/u.test(scoped), "semantic tokens must not rely on hidden fallback colors");
  assert.match(read("charts.mjs"), /var\(--chart-inbound\)/u);
  assert.match(read("charts.mjs"), /var\(--chart-revenue\)/u);
  // สีตายตัวในไฟล์ร่วมทั้งหมดต้องไม่มีเลย (ยกเว้น rgba เงา/ขาวโปร่งที่ไม่ใช่สีแบรนด์)
  for (const name of ["overview.css", "kpi.css", "lineUsage.css", "tagEditor.css"]) {
    assert.doesNotMatch(read(name), /#[0-9a-f]{3,8}\b/iu, `${name} must use theme tokens only`);
  }
  assert.match(read("ui.mjs"), /getComputedStyle\(document\.documentElement\)/u);
});

test("console theme tokens: installed default browser chrome is light", () => {
  assert.match(read("index.html"), /name="theme-color" content="#f4f7fc"/u);
});

test("console theme tokens: LuKprae light and dark scopes define every semantic token and a real dark color-scheme", () => {
  const css = read("theme-lukprae.css");
  const tokens = ["--bg", "--surface", "--surface-2", "--ink", "--ink-2", "--ink-3", "--line", "--line-2",
    "--brand", "--brand-700", "--brand-50", "--brand-100", "--brand-ink", "--on-brand",
    "--danger", "--danger-soft", "--danger-line", "--green", "--green-soft", "--orange", "--orange-soft",
    "--purple", "--purple-soft", "--hot", "--hot-ink", "--hot-soft", "--warm", "--warm-ink", "--warm-soft",
    "--cold", "--cold-ink", "--cold-soft", "--neutral-soft", "--chart-inbound", "--chart-revenue", "--shadow-1", "--shadow-2",
    "--qualify", "--qualify-soft", "--qualify-ink"];
  const light = tokenBlock(css, ":root.theme-lukprae");
  const dark = tokenBlock(css, ":root.theme-lukprae.theme-dark");
  for (const token of tokens) {
    assert.match(light, new RegExp(`${token}:`, "u"), `${token} missing in LuKprae light`);
    assert.match(dark, new RegExp(`${token}:`, "u"), `${token} missing in LuKprae dark`);
  }
  assert.match(light, /color-scheme:\s*light/u);
  assert.match(dark, /color-scheme:\s*dark/u);
  // โหมดมืด: ช่องกรอกทุกชนิดต้องได้สีพื้นและสีตัวอักษรของตัวเอง (บทเรียนตัวหนังสือขาวบนพื้นขาว)
  assert.match(css, /:root\.theme-lukprae\.theme-dark textarea, :root\.theme-lukprae\.theme-dark input,\s*:root\.theme-lukprae\.theme-dark select \{[^}]*background-color:[^}]*color:/u);
  // ฟอนต์โฮสต์เองเท่านั้น (CSP ห้ามฟอนต์ภายนอก) และสลับฟอนต์แบบไม่บังข้อความ
  assert.doesNotMatch(css, /https?:\/\//u, "theme must not reference external hosts");
  assert.equal((css.match(/font-display:\s*swap/gu) || []).length, 4);
});

// WCAG 2.x contrast จากค่า hex ของ token จริง — กันใครปรับสีธีมแล้วตัวหนังสือจางต่ำกว่า 4.5:1 (28 ก.ย. 2026)
function relativeLuminance(hex) {
  const raw = hex.replace("#", "");
  const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test("console theme tokens: LuKprae text/background pairs pass WCAG AA 4.5:1 in light and dark", () => {
  const css = read("theme-lukprae.css");
  const parse = (text, base = {}) => {
    const out = { ...base };
    for (const m of text.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) out[m[1]] = m[2].trim();
    return out;
  };
  const light = parse(tokenBlock(css, ":root.theme-lukprae"));
  const dark = parse(tokenBlock(css, ":root.theme-lukprae.theme-dark"), light);
  const resolve = (tokens, value, depth = 0) => {
    const ref = /^var\((--[\w-]+)\)$/u.exec(value ?? "");
    return ref && depth < 5 ? resolve(tokens, tokens[ref[1]], depth + 1) : value;
  };
  // คู่ที่หน้าจอใช้จริง: ตัวหนังสือหลัก/รอง/จาง บนพื้นทุกชั้น, ปุ่มหลัก, ป้ายสถานะ hot/warm/cold, สีสถานะบนพื้นอ่อน
  const pairs = [
    ["--ink", "--bg"], ["--ink", "--surface"], ["--ink", "--surface-2"],
    ["--ink-2", "--bg"], ["--ink-2", "--surface"], ["--ink-2", "--surface-2"], ["--ink-2", "--neutral-soft"],
    ["--ink-3", "--bg"], ["--ink-3", "--surface"], ["--ink-3", "--surface-2"],
    ["--on-brand", "--brand"], ["--brand-ink", "--bg"], ["--brand-ink", "--surface"], ["--brand-ink", "--brand-50"],
    ["--brand-ink", "--brand-100"], ["--lk-rose-ink", "--surface"], ["--lk-plum-ink", "--surface"],
    ["--hot-ink", "--hot-soft"], ["--warm-ink", "--warm-soft"], ["--cold-ink", "--cold-soft"],
    ["--green", "--green-soft"], ["--red", "--red-soft"], ["--orange", "--orange-soft"], ["--purple", "--purple-soft"],
    // 5 ต.ค. 2026: ป้ายเหลือง AI off (not qualify) — ตัวหนังสือบนพื้นเหลืองสด + เหตุบนพื้นเหลืองอ่อน
    ["--qualify-ink", "--qualify"], ["--ink", "--qualify-soft"],
  ];
  for (const [mode, tokens] of [["light", light], ["dark", dark]]) {
    for (const [fg, bg] of pairs) {
      const a = resolve(tokens, tokens[fg]);
      const b = resolve(tokens, tokens[bg]);
      assert.match(a ?? "", /^#[0-9a-f]{3,6}$/iu, `${mode} ${fg} must be a solid hex color`);
      assert.match(b ?? "", /^#[0-9a-f]{3,6}$/iu, `${mode} ${bg} must be a solid hex color`);
      const ratio = contrast(a, b);
      assert.ok(ratio >= 4.5, `${mode}: ${fg} ${a} on ${bg} ${b} = ${ratio.toFixed(2)}:1 (< 4.5)`);
    }
  }
});

// 5 ต.ค. 2026 (คำสั่งพี่ง้วง "เพิ่มเป็น icon สีเหลือง ประมาณว่า AI off (not qualify)"): token เหลืองของห้องที่ตัวกวาด
// คัดกรองปิด ต้องมีครบทั้ง 5 ชุด (ค่ากลาง · Pngoung สว่าง/มืด · LuKprae สว่าง/มืด) อ่านออก และต้องไม่ใช่เหลืองอำพัน
// ชุดเดียวกับ "AI พัก" (--warm-soft/--warm-ink) หรือ "กำลังพิจารณา" — ไม่งั้นทีมแยกห้องที่ AI พักกับห้องที่ AI คัดออกไม่ได้
test("console theme tokens: yellow AI off (not qualify) tokens exist in all five theme blocks, pass 4.5:1 and stay distinct from warm", () => {
  const parse = (text, base = {}) => {
    const out = { ...base };
    for (const m of text.matchAll(/(--[\w-]+):\s*([^;]+);/gu)) out[m[1]] = m[2].trim();
    return out;
  };
  const scope = read("instance-scope.css");
  const lk = read("theme-lukprae.css");
  const pngLight = parse(tokenBlock(scope, ":root.theme-pngoung"));
  const lkLight = parse(tokenBlock(lk, ":root.theme-lukprae"));
  const blocks = [
    ["console.css :root", parse(tokenBlock(read("console.css"), ":root"))],
    ["pngoung light", pngLight],
    ["pngoung dark", parse(tokenBlock(scope, ":root.theme-pngoung.theme-dark"), pngLight)],
    ["lukprae light", lkLight],
    ["lukprae dark", parse(tokenBlock(lk, ":root.theme-lukprae.theme-dark"), lkLight)],
  ];
  const rgb = (hex) => {
    const raw = hex.replace("#", "");
    const full = raw.length === 3 ? [...raw].map((c) => c + c).join("") : raw;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const hue = (hex) => {
    const [r, g, b] = rgb(hex);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return 0;
    const h = max === r ? ((g - b) / (max - min)) % 6 : max === g ? (b - r) / (max - min) + 2 : (r - g) / (max - min) + 4;
    return (h * 60 + 360) % 360;
  };
  const distance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
  for (const [name, tokens] of blocks) {
    for (const token of ["--qualify", "--qualify-soft", "--qualify-ink", "--warm", "--warm-soft", "--warm-ink", "--ink"]) {
      assert.match(tokens[token] ?? "", /^#[0-9a-f]{3,6}$/iu, `${name}: ${token} must be a solid hex color`);
    }
    // ป้าย/ปุ่ม/ชิปที่เลือกอยู่: ตัวหนังสือเข้มบนเหลืองสด · เหตุ: ตัวหนังสือหลักบนเหลืองอ่อน
    for (const [fg, bg] of [["--qualify-ink", "--qualify"], ["--ink", "--qualify-soft"]]) {
      const ratio = contrast(tokens[fg], tokens[bg]);
      assert.ok(ratio >= 4.5, `${name}: ${fg} ${tokens[fg]} on ${bg} ${tokens[bg]} = ${ratio.toFixed(2)}:1 (< 4.5)`);
    }
    // เหลืองแท้ (มะนาว) ไม่ใช่อำพัน และห่างจากโทน --warm ชัดเจน
    const qualifyHue = hue(tokens["--qualify"]);
    assert.ok(qualifyHue >= 48 && qualifyHue <= 62, `${name}: --qualify hue ${qualifyHue.toFixed(1)}° must be a true yellow`);
    assert.ok(qualifyHue - hue(tokens["--warm"]) >= 8, `${name}: --qualify must not read as the amber --warm`);
    // พื้นป้ายเหลืองต้องต่างจากพื้นป้าย "AI พัก" (--warm-soft) และพื้นชิป "กำลังพิจารณา" ที่เลือกอยู่ (--warm-ink)
    for (const other of ["--warm-soft", "--warm-ink"]) {
      assert.ok(distance(tokens["--qualify"], tokens[other]) >= 100, `${name}: --qualify too close to ${other}`);
    }
    assert.notEqual(tokens["--qualify-soft"].toLowerCase(), tokens["--warm-soft"].toLowerCase(), `${name}: --qualify-soft must not reuse --warm-soft`);
  }
});

test("console theme tokens: every LuKprae rule is scoped so other instances keep their look", () => {
  for (const name of ["theme-lukprae.css", "theme-lukprae-pages.css"]) {
    const css = read(name).replace(/\/\*[\s\S]*?\*\//gu, "");
    const selectors = [...css.matchAll(/(^|\})\s*([^{}@]+)\{/gu)].map((m) => m[2].trim()).filter(Boolean);
    // แยก selector list ด้วยคอมมาที่อยู่นอกวงเล็บเท่านั้น (:is(a, b) คือ selector เดียว)
    const splitTop = (sel) => {
      const parts = []; let depth = 0; let cur = "";
      for (const ch of sel) {
        if (ch === "(") depth += 1;
        if (ch === ")") depth -= 1;
        if (ch === "," && depth === 0) { parts.push(cur); cur = ""; } else cur += ch;
      }
      return [...parts, cur];
    };
    const loose = selectors.filter((sel) => !sel.startsWith("from") && !sel.startsWith("to")
      && splitTop(sel).some((part) => !/theme-lukprae|^\.lk-muse|^\.empty-muse|^\.chat-empty-box \.empty-muse|^\.login-stage$/u.test(part.trim())));
    assert.deepEqual(loose, [], `${name} has selectors that would leak into other instances`);
  }
});
