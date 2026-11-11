// ownerReviewDailyUiFixture.mjs — ของใช้ร่วมของเทสต์หน้าเว็บ "ตรวจแชทวันนี้" (owner-review-daily-ui*.test.mjs) — ไม่มีเทสต์ในไฟล์นี้
// DOM จำลอง + เซิร์ฟเวอร์ปลอมที่ถือป้าย/revision แบบเดียวกับ consoleOwnerReviewDailyApi.mjs · ข้อความทุกบรรทัดเป็นประโยคสังเคราะห์
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./console-dom.mjs";

export const NOW = Date.now();
export const HOUR = 3_600_000;
const realSetTimeout = globalThis.setTimeout;
export const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

/* --------------------------------- ตัวช่วย DOM --------------------------------- */

export function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (node.nodeType === 3) return String(node.textContent ?? "");
  return (node.children || []).map(textOf).join("");
}
export function all(root, predicate, out = []) {
  for (const child of root?.children || []) {
    if (child?.nodeType !== 1) continue;
    if (predicate(child)) out.push(child);
    all(child, predicate, out);
  }
  return out;
}
export const hasClass = (node, name) => String(node?.className || "").split(/\s+/u).includes(name);
export const byClass = (root, name) => all(root, (node) => hasClass(node, name));
export const visible = (node) => {
  for (let cur = node; cur; cur = cur.parent) if (cur.hidden) return false;
  return true;
};
export function button(root, label) {
  const found = all(root, (node) => node.tagName === "button" && visible(node))
    .find((node) => textOf(node).includes(label) || String(node.attributes?.["aria-label"] || "").includes(label));
  assert.ok(found, `ต้องมีปุ่ม "${label}"`);
  return found;
}
export async function flush(rounds = 14) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}
export async function click(node) {
  node.dispatch("click", { preventDefault() {}, target: node });
  await flush();
}

/* --------------------------------- เซิร์ฟเวอร์ปลอม --------------------------------- */

export const CHIPS = [
  ["curt", "ห้วนไป"], ["missed_question", "ไม่ตอบคำถาม"], ["tell_price", "ควรบอกราคา"], ["no_media", "ไม่ควรส่งรูป/รีวิว"],
  ["repeated", "ถามซ้ำ"], ["too_long", "ยาวไป"], ["wrong_fact", "ข้อมูลผิด"],
].map(([key, label]) => ({ key, label }));
export const TAPER = {
  level: 0, levelLabel: "ตรวจทุกห้อง", pinned: false, pin: null, dayNumber: 3, warmupDays: 7, inWarmup: true, startedDay: "2026-10-10",
  flagRisk: 60, agreement7d: 0.88, missRate7d: 0.04, labels7d: 120, sampleLabels7d: 20, perCode7d: { wrong_price: { agree: 3, disagree: 1 } },
  promoteNeeds: { minAgreement: 0.9, minLabels: 150, maxMissRate: 0.05, minSampleLabels: 30 },
};
export const LEVEL_LABELS = ["ตรวจทุกห้อง", "ห้องน่าห่วง + สุ่ม 20%", "ห้องน่าห่วง + สุ่ม 10%"];
export const issue = (code, label, severity, messageId, note, verdict = null) => ({ key: `${code}@${messageId}`, code, label, severity, messageId, note, verdict });

export function qItem(id, over = {}) {
  return {
    id, batchId: "b1", dayKey: "2026-10-12", customerId: `U-${id}`,
    customer: { displayName: `ลูกค้า ${id}`, displayNameMasked: "ล•••", channelLabel: "LINE", aiEnabled: true },
    aiStatus: "done", aiMessages: 2, risk: 10, riskLevel: "normal", riskLabel: "ปกติ", flagged: false, sampled: false, included: "all",
    summary: "ตอบเรียบร้อย", issues: [], issueCount: 0, offtopicHint: null,
    label: null, labelVia: "", labelNote: "", labelledBy: "", labelledByName: "", labelledAt: null,
    revision: 0, mustReview: false, bulkEligible: true, lessons: [], lastMessageId: `${id}2`, ...over,
  };
}

export function baseItems() {
  return [
    qItem("A", {
      customer: { displayName: "สมชาย ใจดี", displayNameMasked: "ส•••ี", channelLabel: "LINE", aiEnabled: true },
      risk: 85, riskLevel: "high", riskLabel: "น่าห่วง", flagged: true, mustReview: true, bulkEligible: false,
      summary: "ลูกค้าถามราคา ลูกแพรตอบราคาผิด", issueCount: 2,
      issues: [issue("wrong_price", "ราคาผิด", "high", "a3", "ราคาไม่ตรงกับรอบนี้"), issue("over_long", "ยาวไป", "normal", "", "ตอบยาวเกินแชท")],
    }),
    qItem("B", { aiStatus: "failed", risk: null, riskLevel: "unknown", riskLabel: "AI ยังไม่ได้อ่าน", summary: "", bulkEligible: false }),
    qItem("C", { sampled: true, mustReview: true, bulkEligible: false }),
    qItem("D"),
    qItem("E"),
  ];
}

export function bubblesOf(id) {
  if (id === "A") {
    return [
      { id: "a1", ref: "m1", speaker: "customer", direction: "in", msgType: "text", text: "เมื่อวานถามไว้ครับ", at: NOW - 30 * HOUR, proactive: false, inWindow: false, fixable: false, issueKeys: [] },
      { id: "a2", ref: "m2", speaker: "customer", direction: "in", msgType: "text", text: "<img src=x onerror=alert(1)> ราคาเท่าไหร่ครับ", at: NOW - 3 * HOUR, proactive: false, inWindow: true, fixable: false, issueKeys: [] },
      { id: "a3", ref: "m3", speaker: "ai", direction: "out", msgType: "text", text: "คลาสละ 990 บาทค่ะ", at: NOW - 3 * HOUR + 60_000, proactive: false, inWindow: true, fixable: true, issueKeys: ["wrong_price@a3"] },
      { id: "a4", ref: "m4", speaker: "team", direction: "out", msgType: "text", text: "ชมพู่ขอเช็กให้นะคะ", at: NOW - 3 * HOUR + 120_000, proactive: false, inWindow: true, fixable: false, issueKeys: [] },
    ];
  }
  const lower = id.toLowerCase();
  return [
    { id: `${lower}1`, ref: "m1", speaker: "customer", direction: "in", msgType: "text", text: "สนใจคลาส AI ค่ะ", at: NOW - 2 * HOUR, proactive: false, inWindow: true, fixable: false, issueKeys: [] },
    { id: `${lower}2`, ref: "m2", speaker: "ai", direction: "out", msgType: "text", text: "ยินดีค่ะ เล่าให้ฟังนะคะ", at: NOW - 2 * HOUR + 60_000, proactive: false, inWindow: true, fixable: true, issueKeys: [] },
  ];
}

export function apiError(status, data) {
  const error = new Error(data?.error || `เกิดข้อผิดพลาด (${status})`);
  error.status = status;
  error.data = data;
  return error;
}

/**
 * เซิร์ฟเวอร์ปลอมที่ถือสถานะป้าย/revision เหมือนของจริง (CAS) · handlers["METHOD /path"] ทับทีละเส้น
 * role owner = บทเรียนใช้ทันที + ปักระดับได้ · operator (ชมพู่) = รออนุมัติ
 */
export function makeServer({ items = baseItems(), role = "owner", queue = {}, detail = {}, handlers = {}, summary = {} } = {}) {
  const server = { items: new Map(items.map((item) => [item.id, item])), calls: [], bulk: [] };
  const who = role === "owner" ? { labelledBy: "nok", labelledByName: "พี่ง้วง" } : { labelledBy: "chom", labelledByName: "ชมพู่" };
  // เกณฑ์เดียวกับเซิร์ฟเวอร์: ไม่น่าห่วง ไม่ถูกสุ่ม AI อ่านแล้ว และ AI ไม่ได้ชี้จุดใด
  const bulkOk = (item) => !item.label && !item.flagged && !item.sampled && item.aiStatus === "done" && !(item.issues || []).length;
  const bump = (id, patch) => {
    const next = { ...server.items.get(id), ...patch };
    next.revision += 1;
    next.bulkEligible = bulkOk(next);
    server.items.set(id, next);
    return { ...next };
  };
  const list = () => [...server.items.values()].map((item) => ({ ...item }));
  const queueOf = () => ({
    ok: true,
    batch: { id: "b1", dayKey: "2026-10-12", dayLabel: "12 ต.ค.", status: "ready", cutoffAt: NOW - HOUR, windowStartAt: NOW - 25 * HOUR, windowEndAt: NOW - HOUR, readyAt: NOW - 0.5 * HOUR, level: 0, levelLabel: "ตรวจทุกห้อง", overflow: 0 },
    items: list(), backlog: [{ batchId: "b0", dayKey: "2026-10-11", dayLabel: "11 ต.ค.", remaining: 3, included: 9 }], building: null,
    taper: TAPER, nextDailyAt: NOW + 3 * HOUR, chips: CHIPS,
    codes: { wrong_price: { label: "ราคาผิด", severity: "high" }, over_long: { label: "ยาวไป", severity: "normal" } },
    undoMs: 10_000, betterReplyMax: 500, canPin: role === "owner", ...queue,
  });
  const detailOf = (id) => ({
    ok: true, item: { ...server.items.get(id) }, bubbles: bubblesOf(id), truncated: false,
    unanchoredIssueKeys: id === "A" ? ["over_long@"] : [], continuedAfterCutoff: false,
    room: { aiEnabled: true, yellow: false, channelLabel: "LINE", conversationHash: `#/c/U-${id}` },
    canTeach: true, teachEnabled: true, lessonsApplyNow: role === "owner", lessonsPaused: false, ...(detail[id] || detail["*"] || {}),
  });
  const api = async (path, { method = "GET", body = null } = {}) => {
    server.calls.push({ path, method, body });
    const custom = handlers[`${method} ${path}`];
    if (custom) return custom({ body, server, bump });
    if (path.startsWith("/console/api/owner-review/summary")) {
      return {
        ok: true, mode: "on", sweepOn: true, counts: { pending: 2, sendFailed: 0, today: {} }, nextScanAt: NOW + HOUR, undoMs: 10_000,
        tabs: [{ key: "close", label: "รอยืนยันปิด", count: 2, available: true }, { key: "daily", label: "ตรวจแชทวันนี้", count: 5, available: true }],
        ...summary,
      };
    }
    const itemMatch = /^\/console\/api\/owner-review\/daily\/items\/([^/?]+)(?:\/(\w+))?$/u.exec(path);
    if (itemMatch) {
      const [, id, action] = itemMatch;
      const current = server.items.get(id);
      if (!current) throw apiError(404, { ok: false, code: "not_found", error: "ไม่พบห้องนี้ในคิวตรวจ" });
      if (!action) return detailOf(id);
      if (action === "label") {
        if (body.revision !== current.revision) throw apiError(409, { ok: false, code: "stale_revision", error: "มีคนตรวจห้องนี้ไปก่อนแล้ว", item: { ...current } });
        return { ok: true, item: bump(id, { label: body.label, labelNote: body.note || "", labelVia: "single", ...who }), undoUntil: Date.now() + 10_000 };
      }
      if (action === "undo") {
        const withdrawn = current.labelVia === "fix" ? 1 : 0;
        return { ok: true, item: bump(id, { label: null, labelVia: "", labelledBy: "", labelledByName: "", lessons: withdrawn ? [] : current.lessons }), lessonsWithdrawn: withdrawn };
      }
      if (action === "fix") {
        const owner = role === "owner";
        return {
          ok: true, item: bump(id, { label: "needs_fix", labelVia: "fix", ...who, lessons: [...current.lessons, { id: "L1", created: true, messageId: body.messageId }] }),
          lesson: { id: "L1", title: "ข้อมูลผิด", status: owner ? "active" : "pending" }, lessonStatus: owner ? "active" : "pending", appliesNow: owner, duplicate: false,
          message: owner ? "บันทึกแล้ว — ลูกแพรจะใช้กับเรื่องคล้ายกันตั้งแต่ข้อความถัดไป" : "ส่งให้พี่ง้วงอนุมัติแล้ว — ลูกแพรจะใช้เมื่อพี่ง้วงอนุมัติ",
          undoUntil: Date.now() + 10_000,
        };
      }
      if (action === "verdict") {
        server.items.set(id, { ...current, issues: current.issues.map((row) => (row.key === body.issueKey ? { ...row, verdict: body.verdict } : row)) });
        return { ok: true, item: { ...server.items.get(id) } };
      }
    }
    if (path === "/console/api/owner-review/daily/batches/b1/good-rest") {
      const flaggedLeft = list().filter((item) => item.flagged && !item.label).length;
      if (flaggedLeft) throw apiError(409, { ok: false, code: "flagged_remaining", error: "ยังมีห้องน่าห่วงที่ยังไม่ได้ตรวจ", flaggedRemaining: flaggedLeft });
      server.bulk = list().filter((item) => bulkOk(item) && item.id !== body?.exceptId).map((item) => item.id);
      for (const id of server.bulk) bump(id, { label: "good", labelVia: "bulk", ...who });
      return { ok: true, labelled: server.bulk.length, bulkId: "bulk-12345678", undoUntil: Date.now() + 10_000 };
    }
    if (path === "/console/api/owner-review/daily/batches/b1/good-rest/undo") {
      for (const id of server.bulk) bump(id, { label: null, labelVia: "", labelledBy: "", labelledByName: "" });
      const reverted = server.bulk.length;
      server.bulk = [];
      return { ok: true, reverted };
    }
    if (path === "/console/api/owner-review/daily/taper") {
      const pin = body.pin;
      return { ok: true, taper: { ...TAPER, pinned: pin !== null, pin, level: pin ?? 0, levelLabel: LEVEL_LABELS[pin ?? 0] } };
    }
    if (path.startsWith("/console/api/owner-review/daily")) return queueOf();
    return { ok: true };
  };
  // "กำลังดูห้องนี้" (POST …/claim) เป็นสัญญาณตำแหน่ง ไม่ใช่การตัดสิน — posts() นับเฉพาะการกระทำ · claims() ดูแยก
  return {
    server, api,
    posts: () => server.calls.filter((call) => call.method === "POST" && !call.path.endsWith("/claim")),
    claims: () => server.calls.filter((call) => call.method === "POST" && call.path.endsWith("/claim")).map((call) => call.path.split("/").at(-2)),
  };
}

export async function renderDaily(t, { hash = "#/owner-review/daily", armMs = 0, role = "owner", ...serverOptions } = {}) {
  const { doc } = installBrowserGlobals(t, { hash });
  const { createOwnerReviewPage } = await import("../public/console/ownerReview.mjs");
  const { el } = await import("../public/console/dom.mjs");
  const fake = makeServer({ role, ...serverOptions });
  const toasts = [];
  const state = { routeGen: 0, pollTimer: null, features: { ownerReview: true }, me: { username: role === "owner" ? "nok" : "chom", role } };
  const render = createOwnerReviewPage({
    api: fake.api,
    toast: (message) => toasts.push(String(message)),
    mount: (...nodes) => doc.body.replaceChildren(...nodes.flat(Infinity).filter(Boolean)),
    pageHeader: (title) => el("header", { class: "topbar" }, el("h1", {}, title)),
    tabBar: () => el("nav", { class: "tabbar" }),
    stopPolling: () => { clearTimeout(state.pollTimer); state.pollTimer = null; },
    setView: () => {},
    state,
    armMs,
  });
  await render({ tab: "daily" });
  await flush();
  const body = doc.body;
  return {
    doc, body, toasts, state, ...fake, calls: fake.server.calls,
    text: () => textOf(body),
    card: () => byClass(body, "odr-card")[0] ?? null,
    sheet: () => byClass(body, "odr-fix").find((node) => !hasClass(node.parent, "is-closing")) ?? null,
    undoToast: () => byClass(body, "orv-undo")[0] ?? null,
    bubble: (id) => all(body, (node) => hasClass(node, "odr-msg") && node.attributes["data-msg"] === id)[0] ?? null,
  };
}
