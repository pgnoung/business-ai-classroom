// console-not-qualified-ui — ห้องเหลือง "AI off (not qualify)" บนคอนโซล (5 ต.ค. 2026)
//
// คำสั่งพี่ง้วง: "ทุกชั่วโมง (เวลาทำการ) ให้มี AI อีกตัวคอยกวาดแชทของวันนั้น ... ให้ AI ตัวนี้ปิด AI mode ของแชทนั้นได้เลย
// แล้วเพิ่มเป็น icon สีเหลือง ประมาณว่า AI off (not qualify) ... ถ้า sense ได้ว่ามีศักยภาพขึ้นมา ให้กลับมาเปิดสีเขียว"
// เทสต์นี้คุมฝั่งหน้าจอ: ป้ายเหลืองทุกจุดที่โชว์สถานะ AI (แถวรายการ · แถวคิว · หัวห้อง · แถบคิว) · ชิป "ไม่เข้าเกณฑ์"
// ที่ทนตัวเลขที่เซิร์ฟเวอร์ยังไม่ส่ง · เส้นทาง/รายการ segment · CSS ไม่มี inline style · คำอธิบายสวิตช์ภาษาไทย
// (การตัดสินเหลือง/เขียวจริงอยู่ test/qualify-sweep.test.mjs · SQL ของชิปอยู่ฝั่ง db)
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installBrowserGlobals } from "./console-dom.mjs";
import {
  NOT_QUALIFIED_BY, NOT_QUALIFIED_LABEL, NOT_QUALIFIED_REASON, NOT_QUALIFIED_REASON_TEXT, QUALIFY_SWEEP_MODES, QUALIFY_SWEEP_MODE_KEY,
} from "../src/notQualified.mjs";
import { aiOffInfo } from "../src/aiOffActor.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const DAY = 86_400_000;

function findAll(node, predicate, out = []) {
  for (const child of node.children || []) {
    if (child?.nodeType !== 1) continue;
    if (predicate(child)) out.push(child);
    findAll(child, predicate, out);
  }
  return out;
}
const textOf = (node) => (node?.nodeType === 3 ? node.textContent : (node?.children || []).map(textOf).join(""));
const byClass = (root, cls) => findAll(root, (n) => n._classes().has(cls));
const click = async (node) => {
  for (const fn of node.listeners.click || []) await fn({ currentTarget: node, preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
};

// ข้อมูลป้ายจากเซิร์ฟเวอร์ตัวจริง (aiOffActor) — หน้าจอกับเซิร์ฟเวอร์ต้องพูดชุดเดียวกัน ไม่ใช่ fixture ที่เขียนเอง
const QUALIFY_OFF = aiOffInfo({ ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON }, { qualifyReason: "บอกว่าตกงาน หาวิธีหาเงินฟรี" });
const HUMAN_OFF = aiOffInfo({ ai_enabled: 0, ai_off_reason: "manual" });
const SYSTEM_OFF = aiOffInfo({ ai_enabled: 0, ai_off_reason: "bank_sent" });
const UNKNOWN_OFF = aiOffInfo({ ai_enabled: 0, ai_off_reason: "" });

function row(id, extra = {}) {
  return {
    line_user_id: id, display_name: `ชื่อ ${id}`, known_name: "", ai_enabled: 0, state: "AI_ACTIVE", last_score: 3,
    last_message: "ข้อความล่าสุด", last_message_at: Date.now() - DAY, channel_id: "default", unread: 0, ai_off: null,
    ...extra,
  };
}

function inboxPayload({ counts = {}, conversations = null } = {}) {
  return {
    ok: true,
    conversations: conversations ?? [
      row("U-yellow", { ai_off: QUALIFY_OFF, ai_off_reason: NOT_QUALIFIED_REASON }),
      row("U-human", { ai_off: HUMAN_OFF, ai_off_reason: "manual" }),
      row("U-system", { ai_off: SYSTEM_OFF, ai_off_reason: "bank_sent" }),
      row("U-unknown", { ai_off: UNKNOWN_OFF }),
      row("U-legacy-shape", { ai_off: null }),
      row("U-on", { ai_enabled: 1, ai_off: null }),
    ],
    hasMore: false,
    counts: { all: 6, hot: 0, warm: 0, cold: 6, needs: 0, aioff: 5, resolved: 0, mine: 0, customer: 0, spam: 0, waiting: 0, waiting24: 0, hotfollow: 0, ...counts },
  };
}

function makeDeps(doc, { filter = null, inbox = inboxPayload() } = {}) {
  const calls = [];
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body });
    if (path.startsWith("/console/api/inbox")) return inbox;
    return { ok: true };
  };
  return {
    calls,
    deps: {
      api, uploadMedia: async () => ({ ok: true }), toast: () => {},
      mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
      pageHeader: (title) => { const n = doc.createElement("header"); n.textContent = title; return n; },
      tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {}, channelName: () => "LINE",
      state: {
        me: { username: "owner", role: "owner", capabilities: ["operations.use"] },
        csrf: "t", branding: { name: "พี่ง้วง", mark: "พง", agent: "ลูกแพร", theme: "lukprae" },
        pollTimer: null, draft: null, routeGen: 0, channels: [], channel: null, settingsChannel: null, operators: [],
        features: {}, webPushPublicKey: "",
        ui: { salesOpen: false, fuOpen: false, notesOpen: false, exportOpen: false, contextOpen: false, theme: "light" },
        inbox: { filter, q: "", extra: [], hasMore: false },
        chat: { id: null, head: [], older: [], hasMoreOlder: false, atBottom: true, keepFromBottom: null },
        chatDrafts: new Map(), chatUncertain: new Map(),
      },
    },
  };
}

test("สัญญากลาง: ค่า by ของคอนโซลตรงกับเซิร์ฟเวอร์ · สีจำกัดชุด · บรรทัดเหตุของห้องเหลืองนำด้วยชื่อป้าย", async () => {
  const { AI_OFF_QUALIFY_BY, aiOffBy, aiOffWhyText, isNotQualifiedOff } = await import("../public/console/triage.mjs");
  assert.equal(AI_OFF_QUALIFY_BY, NOT_QUALIFIED_BY, "คอนโซล import ไฟล์ฝั่งเซิร์ฟเวอร์ไม่ได้ — ค่าต้องตรงกันด้วยเทสต์");
  assert.equal(QUALIFY_OFF.label, NOT_QUALIFIED_LABEL);
  assert.equal(aiOffBy(QUALIFY_OFF), "qualify");
  assert.equal(aiOffBy(HUMAN_OFF), "human");
  assert.equal(aiOffBy(SYSTEM_OFF), "system");
  for (const odd of [UNKNOWN_OFF, null, undefined, {}, { by: "screen" }, { by: "__proto__" }]) assert.equal(aiOffBy(odd), "unknown");
  assert.equal(isNotQualifiedOff(QUALIFY_OFF), true);
  assert.equal(isNotQualifiedOff(SYSTEM_OFF), false);
  assert.equal(aiOffWhyText(QUALIFY_OFF), "AI off (not qualify) — บอกว่าตกงาน หาวิธีหาเงินฟรี");
  assert.equal(aiOffWhyText(SYSTEM_OFF), "AI ปิดเพราะ: ส่งเลขบัญชีแล้ว รอทีมดูแลเรื่องเงิน", "ห้องอื่นถ้อยคำเดิม");
  assert.equal(aiOffWhyText({ by: "qualify", label: NOT_QUALIFIED_LABEL, reasonText: "" }), null);
  // ไม่ส่งเหตุของคำตัดสิน = คำอธิบายกลาง (ไม่ใช่ช่องว่าง)
  assert.equal(aiOffInfo({ ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON }).reasonText, NOT_QUALIFIED_REASON_TEXT);
});

test("ป้ายเหลืองในคิวรอตอบ/หน้าภาพรวม (aiStateBadge): ป้าย + เหตุสีเหลือง · ห้องเปิด/พักหน้าตาเดิม", async (t) => {
  installBrowserGlobals(t, { hash: "#/" });
  const { aiStateBadge, aiOffBadge } = await import("../public/console/triage.mjs");
  const [badge, reason] = aiStateBadge({ aiOff: QUALIFY_OFF, aiOn: false }, { withReason: true });
  assert.equal(badge.className, "badge ai-off-badge by-qualify");
  assert.equal(textOf(badge), "AI off (not qualify)");
  assert.equal(badge.attributes.title, "AI off (not qualify) — บอกว่าตกงาน หาวิธีหาเงินฟรี");
  assert.equal(reason.className, "ai-off-reason by-qualify");
  assert.equal(textOf(reason), "บอกว่าตกงาน หาวิธีหาเงินฟรี");
  assert.equal(aiOffBadge(QUALIFY_OFF, { withReason: true }).className, "badge ai-off-badge by-qualify");
  // สถานะอื่นไม่ถูกแตะ
  assert.equal(aiOffBadge(HUMAN_OFF).className, "badge ai-off-badge by-human");
  assert.equal(aiOffBadge(SYSTEM_OFF).className, "badge ai-off-badge by-system");
  assert.equal(aiOffBadge(UNKNOWN_OFF).className, "badge ai-off-badge by-unknown");
  assert.equal(aiStateBadge({ aiOn: true, aiPaused: true }).className, "badge ai-on-badge is-paused");
  assert.equal(textOf(aiStateBadge({ aiOn: true, aiPaused: true })), "AI พัก");
  assert.equal(aiStateBadge({ aiOn: true }).className, "badge ai-on-badge");
});

test("รายการแชทปกติ: ห้องเหลืองขึ้นป้าย AI off (not qualify) · ห้องปิดเหตุอื่นสีเดิม · ห้องเปิดไม่มีป้าย · ไม่มี inline style", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/chat" });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps } = makeDeps(doc);
  await createChatWorkspace(deps)({});
  const rows = findAll(doc.body, (n) => n.tagName === "a" && n._classes().has("convo-row"));
  const rowOf = (id) => rows.find((n) => n.attributes.href === `#/c/${id}`);
  const badgeOf = (id) => byClass(rowOf(id), "ai-off-badge")[0];
  assert.equal(badgeOf("U-yellow").className, "badge ai-off-badge by-qualify");
  assert.equal(textOf(badgeOf("U-yellow")), "AI off (not qualify)");
  assert.match(badgeOf("U-yellow").attributes.title, /บอกว่าตกงาน/u, "เหตุอยู่ใน tooltip เหมือนป้ายอื่น");
  assert.equal(badgeOf("U-human").className, "badge ai-off-badge by-human");
  assert.equal(badgeOf("U-system").className, "badge ai-off-badge by-system");
  assert.equal(badgeOf("U-unknown").className, "badge ai-off-badge by-unknown");
  // แถวจากเซิร์ฟเวอร์รุ่นเก่าที่ไม่มี ai_off = ป้ายเทาเดิม
  assert.ok(byClass(rowOf("U-legacy-shape"), "badge-gray").some((n) => textOf(n) === "AI ปิด"));
  assert.equal(byClass(rowOf("U-on"), "ai-off-badge").length, 0);
  // CSP style-src 'self': ห้ามมี style= บน element ไหนเลย
  assert.deepEqual(findAll(doc.body, (n) => Object.hasOwn(n.attributes || {}, "style")).map((n) => n.className), []);
});

test("ชิป ไม่เข้าเกณฑ์: อยู่ถัดจาก AI ปิด · ลิงก์ #/chat/notqualify · เซิร์ฟเวอร์ยังไม่นับ = ไม่ขึ้นตัวเลข (ไม่ใช่ 0)", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/chat" });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps } = makeDeps(doc);
  await createChatWorkspace(deps)({});
  const chips = findAll(doc.body, (n) => n.tagName === "a" && n._classes().has("fchip"));
  const labels = chips.map((n) => n.children.find((c) => c?.nodeType === 3)?.textContent);
  assert.equal(labels[labels.indexOf("AI ปิด") + 1], "ไม่เข้าเกณฑ์", "ชิปเหลืองอยู่ติดชิป AI ปิด");
  const chip = chips.find((n) => n._classes().has("fchip-notqualify"));
  assert.equal(chip.attributes.href, "#/chat/notqualify");
  assert.match(chip.attributes.title, /AI off \(not qualify\)/u);
  assert.equal(byClass(chip, "fchip-count").length, 0, "ยังไม่มีตัวเลขจากเซิร์ฟเวอร์ = ไม่เดาว่า 0");
  // ชิปอื่นที่ไม่มีตัวเลขยังขึ้น 0 แบบเดิม
  const delete_ = inboxPayload();
  delete delete_.counts.hotfollow;
  const again = makeDeps(doc, { inbox: delete_ });
  await createChatWorkspace(again.deps)({});
  const hot = findAll(doc.body, (n) => n.tagName === "a" && n._classes().has("fchip-hotfollow"))[0];
  assert.equal(textOf(byClass(hot, "fchip-count")[0]), "0");
});

test("ชิป ไม่เข้าเกณฑ์: รับตัวเลขได้ทั้ง counts.notqualify และ counts.notqualify_n · เลือกแล้วขอ segment=notqualify", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/chat/notqualify" });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { chipCount, FILTERS } = await import("../public/console/inbox.mjs");
  const filter = FILTERS.find((f) => f.key === "notqualify");
  assert.ok(/^\w+$/u.test(filter.key), "คีย์ต้องผ่าน regex เส้นทาง #/chat/(\\w+)");
  assert.equal(chipCount({ notqualify: 4 }, filter), 4);
  assert.equal(chipCount({ notqualify_n: 2 }, filter), 2);
  assert.equal(chipCount({ notqualify: 0 }, filter), 0, "นับแล้วได้ 0 = ขึ้น 0 ได้");
  assert.equal(chipCount({}, filter), null);
  assert.equal(chipCount(null, filter), null);
  assert.equal(chipCount({ notqualify: "x" }, filter), null);
  assert.equal(chipCount({}, FILTERS.find((f) => f.key === "aioff")), 0, "ชิปเดิมไม่มีตัวเลข = 0 แบบเดิม");
  assert.equal(chipCount({ aioff: 7 }, FILTERS.find((f) => f.key === "aioff")), 7);

  const yellowOnly = inboxPayload({ counts: { notqualify: 1 }, conversations: [row("U-yellow", { ai_off: QUALIFY_OFF })] });
  const { deps, calls } = makeDeps(doc, { filter: "notqualify", inbox: yellowOnly });
  await createChatWorkspace(deps)({ filter: "notqualify" });
  assert.ok(calls.some((c) => c.path.startsWith("/console/api/inbox") && c.path.includes("segment=notqualify")));
  const chip = findAll(doc.body, (n) => n.tagName === "a" && n._classes().has("fchip-notqualify"))[0];
  assert.ok(chip._classes().has("is-active"));
  assert.equal(chip.attributes["aria-current"], "true");
  assert.equal(textOf(byClass(chip, "fchip-count")[0]), "1");
  assert.match(textOf(byClass(doc.body, "filter-explain")[0]), /ตัวกวาดรายชั่วโมงปิด AI เอง และเปิดคืนเองเมื่อเห็นศักยภาพ/u);
  // ห้องเหลืองเปิดจากชิปนี้ = ลิงก์ห้องแบบปกติ (ไม่ใช่คิว)
  assert.ok(findAll(doc.body, (n) => n.tagName === "a" && n.attributes.href === "#/c/U-yellow").length >= 1);

  const empty = makeDeps(doc, { filter: "notqualify", inbox: inboxPayload({ counts: { notqualify: 0 }, conversations: [] }) });
  await createChatWorkspace(empty.deps)({ filter: "notqualify" });
  assert.match(textOf(byClass(doc.body, "empty")[0]), /ไม่มีห้องที่ AI คัดกรองว่ายังไม่เข้าเกณฑ์/u);
});

test("เส้นทาง + รายการ segment: notqualify อยู่ทั้งฝั่ง router คอนโซลและ allowlist ของ API (ข้อความ error บอกครบ)", () => {
  const consoleJs = read("public/console/console.js");
  const routes = consoleJs.match(/const SEGMENT_ROUTES = new Set\(\[([^\]]+)\]\)/u);
  assert.ok(routes, "SEGMENT_ROUTES");
  assert.ok(JSON.parse(`[${routes[1]}]`).includes("notqualify"));
  const api = read("src/consoleApi.mjs");
  const segments = api.match(/const INBOX_SEGMENTS = new Set\(\[([^\]]+)\]\)/u);
  assert.ok(segments, "INBOX_SEGMENTS");
  const list = JSON.parse(`[${segments[1]}]`);
  assert.ok(list.includes("notqualify"));
  // ทุกคีย์ของชิปที่ API รับ ต้องเปิดได้จาก router ด้วย (ไม่งั้นกดชิปแล้วตกไปหน้า #/chat เฉย ๆ)
  const routeList = JSON.parse(`[${routes[1]}]`);
  assert.deepEqual(list.filter((key) => !routeList.includes(key)), []);
  assert.match(api, /segment ต้องเป็น [^"]*\bnotqualify\b/u);
});

test("CSS: ห้องเหลืองมีกฎครบทุกจุด ใช้ token เหลืองของตัวเอง (ไม่ยืม --warm ของ AI พัก) · ธีมลูกแพรมีชิปที่เลือกอยู่สีเหลือง", () => {
  const css = read("public/console/triage.css");
  const rule = (selector) => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const m = css.match(new RegExp(`${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, "u"));
    assert.ok(m, `missing CSS rule ${selector}`);
    return m[1];
  };
  for (const selector of [".ai-off-badge.by-qualify", ".ai-toggle.is-off.by-qualify", ".fchip-notqualify.is-active", ".fchip-notqualify .fchip-count"]) {
    const body = rule(selector);
    assert.match(body, /background:\s*var\(--qualify\)/u, `${selector} พื้นเหลืองสด`);
    assert.match(body, /color:\s*var\(--qualify-ink\)/u, `${selector} ตัวหนังสือเข้ม`);
  }
  for (const selector of [".ai-off-reason.by-qualify", ".triage-bar-why.by-qualify"]) {
    assert.match(rule(selector), /background:\s*var\(--qualify-soft\)/u, `${selector} พื้นเหลืองอ่อน`);
  }
  const qualifyRules = [...css.matchAll(/([^{}]*qualify[^{}]*)\{([^}]*)\}/gu)].map((m) => m[2]).join("\n");
  assert.doesNotMatch(qualifyRules, /--warm/u, "เหลืองของห้องคัดกรองต้องไม่ใช้ token ของ AI พัก");
  assert.doesNotMatch(qualifyRules, /#[0-9a-f]{3,8}\b/iu, "ใช้ token เท่านั้น");
  const lk = read("public/console/theme-lukprae.css");
  assert.match(lk, /:root\.theme-lukprae \.fchip-notqualify\.is-active,\s*:root\.theme-lukprae\.theme-dark \.fchip-notqualify\.is-active \{[^}]*background:\s*var\(--qualify\)/u);
  // ไม่มีไฟล์คอนโซลใหม่ = allowlist ไฟล์ static ไม่ต้องแก้ (ถ้าเพิ่มไฟล์ต้องเพิ่มใน src/consoleStatic.mjs)
  assert.match(read("src/consoleStatic.mjs"), /triage\.css/u);
});

test("สวิตช์ตัวกวาดคัดกรอง: คำอธิบายภาษาไทยครบ ปิด/ทดลอง/เปิด · แตะวน ปิด → ทดลอง → เปิด", async (t) => {
  installBrowserGlobals(t, { hash: "#/settings" });
  const { BEHAVIOR_SWITCH_COPY, behaviorSwitchesBlock } = await import("../public/console/settingsBehaviorSwitches.mjs");
  const copy = BEHAVIOR_SWITCH_COPY[QUALIFY_SWEEP_MODE_KEY];
  assert.ok(copy?.title);
  for (const value of QUALIFY_SWEEP_MODES) assert.ok(copy[value], `ไม่มีคำอธิบาย ${value}`);
  // รีวิวปรปักษ์ 5 ต.ค.: ปิด/ทดลอง = คืน AI ให้ห้องสีเหลือง — ถ้อยคำต้องบอกตรง ๆ (เดิม "ปิด — ไม่กวาด" อ่านเหมือนถอยกลับสะอาด)
  // รวมงาน: ถ้อยคำต้องตรงกับที่ตัวกวาดทำจริง — คืนทุกนาที และห้องที่รอทีม/มีเรื่องเงินไม่ถูกเปิดทับ
  assert.match(copy.off, /^ปิด — หยุดคัดกรอง และคืน AI ให้ห้องสีเหลืองภายใน 1 นาที \(ห้องที่รอทีมตรวจ ทีมรับไว้แล้ว หรือมีเรื่องเงิน คงปิดไว้ให้ทีม\)/u);
  assert.match(copy.shadow, /^ทดลอง — ประเมินอย่างเดียว ไม่ปิด AI \(ห้องสีเหลืองเดิมได้ AI คืน\)/u);
  // รีวิวปรปักษ์รอบ 2 5 ต.ค.: การคืนห้องไม่ตอบข้อความค้างย้อนหลัง (ตั้งใจ ไม่ส่งรัวตอนสลับสวิตช์) — ถ้อยคำต้องบอกก่อนกด
  // ไม่งั้น "คืน AI ภายใน 1 นาที" อ่านเหมือน AI จะตามตอบ แล้วคิวรอตอบ/KPI กระโดดพร้อมกันโดยไม่มีใครคาด
  for (const value of ["off", "shadow"]) {
    assert.match(copy[value], /ข้อความที่ค้างอยู่ AI ไม่ตอบย้อนหลัง — ขึ้นคิวรอตอบให้ทีม/u, value);
  }
  assert.doesNotMatch(copy.on, /ไม่ตอบย้อนหลัง/u, "โหมดเปิดตอบข้อความค้างเมื่อเปิดเขียว");
  // 8 พ.ย. 2026: บอกเกณฑ์คะแนนต่ำ (0–5) และว่าทักตามหยุดด้วย
  assert.match(copy.on, /^เปิด — ปิด AI ห้องคะแนน 0–5 ที่ไม่เข้าเกณฑ์.*ทักตามหยุดด้วย.*เปิดคืนเองเมื่อมีศักยภาพ/u);
  assert.match(copy.on, /AI off \(not qualify\)/u);

  const posts = [];
  const toasts = [];
  const api = async (path, options = {}) => {
    if (options.method === "POST") { posts.push(options.body); return { ok: true }; }
    return { ok: true, canEdit: true, switches: [{ key: QUALIFY_SWEEP_MODE_KEY, values: [...QUALIFY_SWEEP_MODES], value: "off" }] };
  };
  const block = await behaviorSwitchesBlock({ api, toast: (m) => toasts.push(m), refresh: async () => {} });
  const line = byClass(block, "switch-line")[0];
  assert.equal(textOf(byClass(line, "switch-state")[0]), `${copy.title}: ปิด`);
  assert.equal(textOf(byClass(line, "switch-line-hint")[0]), copy.off);
  await click(line);
  assert.deepEqual(posts, [{ key: QUALIFY_SWEEP_MODE_KEY, value: "shadow" }], "ปิด → ทดลองก่อนเสมอ ไม่ข้ามไปเปิดจริง");
  assert.match(toasts.at(-1), /: ทดลอง/u);

  const view = async () => ({ ok: true, canEdit: false, switches: [{ key: QUALIFY_SWEEP_MODE_KEY, values: [...QUALIFY_SWEEP_MODES], value: "shadow" }] });
  const readOnly = await behaviorSwitchesBlock({ api: view, toast: () => {} });
  assert.match(textOf(readOnly), /ทดลอง/u);
  assert.match(textOf(readOnly), /ไม่ปิด AI \(ห้องสีเหลืองเดิมได้ AI คืน\)/u);
  assert.match(textOf(readOnly), /ไม่ตอบย้อนหลัง/u);
});

// รีวิวปรปักษ์รอบ 2 5 ต.ค.: ห้องเหลืองที่รอทีม (NEEDS_HUMAN) เคยขึ้น "เปิดคืนเองเมื่อเห็นศักยภาพ" ในคิวรอตอบ — ทีมอ่านว่าปล่อยได้
test("ห้องเหลืองที่รอทีม: ป้าย/บรรทัดเหตุบอกว่ารอทีม ไม่ใช่เปิดคืนเอง · ห้องเหลืองปกติถ้อยคำเดิม", async (t) => {
  installBrowserGlobals(t, { hash: "#/" });
  const { NOT_QUALIFIED_WAITING_TEAM_TEXT } = await import("../src/aiOffActor.mjs");
  const { aiOffWhyText, aiStateBadge } = await import("../public/console/triage.mjs");
  const waitingTeam = aiOffInfo({ ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON, state: "NEEDS_HUMAN" }, { qualifyReason: "บอกว่าตกงาน" });
  assert.equal(waitingTeam.by, "qualify", "ยังเป็นป้ายเหลือง (ห้องยังเป็นของตัวกวาด)");
  assert.equal(waitingTeam.reasonText, NOT_QUALIFIED_WAITING_TEAM_TEXT);
  assert.match(waitingTeam.reasonText, /รอทีม/u);
  assert.doesNotMatch(waitingTeam.reasonText, /เปิดคืนเองเมื่อเห็นศักยภาพ/u);
  assert.equal(aiOffWhyText(waitingTeam), `AI off (not qualify) — ${NOT_QUALIFIED_WAITING_TEAM_TEXT}`);
  const [, reason] = aiStateBadge({ aiOff: waitingTeam, aiOn: false }, { withReason: true });
  assert.equal(textOf(reason), NOT_QUALIFIED_WAITING_TEAM_TEXT, "มือถือเห็นบนแถว");
  for (const state of ["AI_ACTIVE", "RESOLVED", "", undefined]) {
    assert.equal(aiOffInfo({ ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON, state }).reasonText, NOT_QUALIFIED_REASON_TEXT, String(state));
  }
});

// รีวิวปรปักษ์รอบ 3 5 ต.ค.: ห้องเหลือง AI_ACTIVE ที่ทีมรับไปแล้ว (ทีมตอบหลังเหลือง/ถือห้อง/เริ่มจ่ายเงิน) — เซิร์ฟเวอร์ส่ง teamBlocked
// หน้าจอต้องขึ้นข้อความรอทีม ไม่ใช่ "เปิดคืนเองเมื่อเห็นศักยภาพ" (เทสต์ DB จริงอยู่ test/waiting-rooms.test.mjs)
test("ห้องเหลืองที่ทีมรับไปแล้ว (teamBlocked): แถวคิว/หัวห้องขึ้นข้อความรอทีม · ไม่ส่ง = ถ้อยคำเดิม", async (t) => {
  installBrowserGlobals(t, { hash: "#/" });
  const { NOT_QUALIFIED_WAITING_TEAM_TEXT } = await import("../src/aiOffActor.mjs");
  const { aiOffWhyText, aiStateBadge } = await import("../public/console/triage.mjs");
  const taken = aiOffInfo({ ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON, state: "AI_ACTIVE" }, { qualifyReason: "บอกว่าตกงาน", teamBlocked: true });
  assert.equal(taken.by, NOT_QUALIFIED_BY);
  assert.equal(taken.reasonText, NOT_QUALIFIED_WAITING_TEAM_TEXT);
  assert.equal(aiOffWhyText(taken), `${NOT_QUALIFIED_LABEL} — ${NOT_QUALIFIED_WAITING_TEAM_TEXT}`);
  const [, reason] = aiStateBadge({ aiOff: taken, aiOn: false }, { withReason: true });
  assert.equal(textOf(reason), NOT_QUALIFIED_WAITING_TEAM_TEXT);
  for (const teamBlocked of [false, undefined, "true", 1]) {
    assert.equal(aiOffInfo({ ai_enabled: 0, ai_off_reason: NOT_QUALIFIED_REASON, state: "AI_ACTIVE" }, { teamBlocked }).reasonText,
      NOT_QUALIFIED_REASON_TEXT, `teamBlocked=${String(teamBlocked)} ต้องเป็น true เท่านั้น`);
  }
});
