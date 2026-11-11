// console-triage-ui — หน้าเว็บจริงด้วย DOM จำลอง (28 ก.ย. 2026)
// คิวรอตอบ: ชิป + แถว + ปุ่มลัด · หัวห้อง: AI ปิดโดยคน (ม่วง) / โดยระบบ (แดง) · ปุ่มสแปม · แถบคิว "ห้องถัดไป"
// · ทำเสร็จแล้ว (✓ เสร็จสิ้น / สแปม / ส่งข้อความ) เปิดห้องถัดไปเอง ไม่ต้องกดกลับมาที่รายการ
import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./console-dom.mjs";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const IDS = ["U-waiting-money", "U-waiting-fb", "U-waiting-manual"];

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
const byText = (root, tag, text) => findAll(root, (n) => n.tagName === tag && textOf(n).includes(text));
const click = async (node) => {
  for (const fn of node.listeners.click || []) await fn({ preventDefault() {}, stopPropagation() {} });
  await new Promise((resolve) => setImmediate(resolve));
};

function waitingRow(id, extra = {}) {
  const now = Date.now();
  return {
    line_user_id: id, display_name: `ชื่อ ${id}`, known_name: "", ai_enabled: 0, state: "AI_ACTIVE",
    last_score: 6, last_message: "ข้อความล่าสุด", channel_id: "default", unread: 0,
    ai_off: { by: "human", reason: "manual", label: "AI ปิด · โดยคน", reasonText: "ทีมกดปิดเอง" },
    waiting: { since: now - 2 * DAY, waitMs: 2 * DAY, over24: true, value: "warm", score: 6, fbReplyClosed: false, preview: "ขอรายละเอียดค่ะ", aiPaused: false },
    ...extra,
  };
}

function inboxPayload({ order = IDS } = {}) {
  return {
    ok: true,
    conversations: [
      waitingRow(IDS[0], {
        ai_off: { by: "system", reason: "bank_sent", label: "AI ปิด · โดยระบบ", reasonText: "ส่งเลขบัญชีแล้ว รอทีมดูแลเรื่องเงิน" },
        waiting: { since: Date.now() - DAY, waitMs: DAY, over24: true, value: "money", score: 6, fbReplyClosed: false, preview: "โอนแล้วค่ะ" },
      }),
      waitingRow(IDS[1], {
        channel_id: "facebook", ai_enabled: 1, ai_off: null,
        waiting: { since: Date.now() - 3 * DAY, waitMs: 3 * DAY, over24: true, value: "other", fbReplyClosed: true, preview: "ส่งรูปภาพ" },
      }),
      waitingRow(IDS[2]),
    ].filter((row) => order.includes(row.line_user_id)),
    hasMore: false,
    counts: { all: 40, hot: 3, warm: 5, cold: 32, needs: 2, aioff: 9, resolved: 1, mine: 0, customer: 1, spam: 4, waiting: order.length, waiting24: order.length },
    waitingOrder: order,
  };
}

function roomPayload(id, { aiOff = { by: "human", reason: "manual", label: "AI ปิด · โดยคน", reasonText: "ทีมกดปิดเอง" }, spam = false, fbReplyClosed = false } = {}) {
  return {
    ok: true,
    customer: {
      line_user_id: id, display_name: `ชื่อ ${id}`, known_name: "", ai_enabled: aiOff ? 0 : 1, state: "AI_ACTIVE",
      last_score: 6, ai_off_reason: aiOff?.reason || "", operator_active_until: 0, do_not_disturb: 0, legacy_link: "", human_owner: "",
      channel_id: fbReplyClosed ? "facebook" : "default",
    },
    messages: [{ id: "m1", direction: "in", msg_type: "text", content: "ขอรายละเอียดค่ะ", created_at: Date.now() - 2 * DAY }],
    hasMoreOlder: false, score: null, followups: [], followupGlobal: false, followupAppointmentArmed: true,
    handoffNotes: [], aiCost: null, orders: [], tags: [], lifecycle: null, lifecycleEvents: [], slipChecks: [],
    pendingDraft: null, aiPaused: false, attachments: [],
    triage: {
      spam, aiOff, fbReplyClosed, lastInboundAt: Date.now() - 2 * DAY,
      waiting: spam ? null : { since: Date.now() - 2 * DAY, waitMs: 2 * DAY, over24: true, value: "warm", score: 6, fbReplyClosed, preview: "ขอรายละเอียดค่ะ" },
    },
  };
}

function makeDeps(doc, { filter = "waiting", room = null, inbox = inboxPayload(), freshOrder = null } = {}) {
  const calls = [];
  const toasts = [];
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body });
    if (path.startsWith("/console/api/inbox")) {
      // หลังทำเสร็จ หน้าเว็บขอคิวล่าสุด — ห้องที่เพิ่งจัดการหลุดคิวแล้ว
      if (freshOrder && path.includes("limit=1")) return { ...inbox, waitingOrder: freshOrder };
      return inbox;
    }
    if (path.includes("/messages")) return room;
    return { ok: true, sent: true };
  };
  return {
    calls, toasts,
    deps: {
      api, uploadMedia: async () => ({ ok: true }), toast: (message) => toasts.push(message),
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

test("ห้องถัดไป: ถัดลงไปจากห้องเดิมที่ยังรออยู่ · ท้ายคิววนกลับบนสุด · คิวหมด = null", async () => {
  const { nextWaitingId, roomHash, spanLabel } = await import("../public/console/triage.mjs");
  const order = ["a", "b", "c", "d"];
  assert.equal(nextWaitingId({ order, fresh: ["a", "c", "d"], currentId: "b" }), "c");
  assert.equal(nextWaitingId({ order, fresh: ["a", "d"], currentId: "b" }), "d", "ห้อง c ถูกตอบไประหว่างนี้ = ข้าม");
  assert.equal(nextWaitingId({ order, fresh: ["a", "b"], currentId: "d" }), "a", "ท้ายคิว = วนกลับบนสุด");
  assert.equal(nextWaitingId({ order, fresh: ["x"], currentId: "zz" }), "x", "ห้องเดิมไม่อยู่ในคิว = บนสุดของคิวล่าสุด");
  assert.equal(nextWaitingId({ order, fresh: ["b"], currentId: "b" }), null);
  assert.equal(nextWaitingId({ order, currentId: "a" }), "b", "ปุ่มห้องถัดไป (ไม่ได้ทำอะไรกับห้องนี้) = ห้องถัดในคิวที่เห็นอยู่");
  assert.equal(roomHash("waiting", "U 1"), "#/chat/waiting/U%201");
  assert.equal(roomHash("spam", "U1"), "#/chat/spam/U1");
  assert.equal(roomHash("hot", "U1"), "#/c/U1", "ชิปอื่นใช้ลิงก์เดิม");
  const { spanLabel: overviewSpan } = await import("../public/console/overviewCeo.mjs");
  assert.equal(overviewSpan, spanLabel, "หน้าภาพรวมกับหน้าแชทพูดเวลาแบบเดียวกัน");
});

test("ชิปที่เลือกอยู่ต้องเลื่อนมาให้เห็นเสมอ (แถวชิป 12 ตัว ชิปท้ายแถวเคยถูกเลือกอยู่นอกจอ)", async () => {
  const { revealActiveChip } = await import("../public/console/inbox.mjs");
  const nav = { scrollLeft: 0, getBoundingClientRect: () => ({ left: 0, right: 390 }) };
  const chip = { closest: () => nav, getBoundingClientRect: () => ({ left: 900 - nav.scrollLeft, right: 1010 - nav.scrollLeft }) };
  let asked = "";
  revealActiveChip({ querySelector: (selector) => { asked = selector; return chip; } });
  assert.match(asked, /:not\(\.branch-filters\)/u, "ชิปสาขาไม่นับ");
  assert.equal(nav.scrollLeft, 888, "เลื่อนจนชิปอยู่ในจอ เว้นขอบ 12px");
  revealActiveChip({ querySelector: () => chip });
  assert.equal(nav.scrollLeft, 888, "อยู่ในจอแล้ว = ไม่ขยับอีก");
  revealActiveChip({ querySelector: () => null });
});

test("สแปม: ต้องยืนยันก่อนทุกครั้ง · ยกเลิก = ไม่ยิงเซิร์ฟเวอร์ · ถอนสแปมบอกว่า AI ยังปิดอยู่", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/chat/waiting" });
  const { confirmSpam, setSpam } = await import("../public/console/triage.mjs");
  const calls = [];
  const toasts = [];
  const api = async (path, options) => { calls.push({ path, body: options?.body }); return { ok: true, aiEnabled: false }; };
  assert.equal(await setSpam({ api, toast: (m) => toasts.push(m), customerId: "U1", name: "คุณเอ", confirmFn: async () => false }), false);
  assert.equal(calls.length, 0, "ยกเลิกในกล่องยืนยัน = ไม่มีอะไรเกิดขึ้น");
  assert.equal(await setSpam({ api, toast: (m) => toasts.push(m), customerId: "U1", name: "คุณเอ", confirmFn: async () => true }), true);
  assert.deepEqual(calls[0], { path: "/console/api/customers/U1/spam", body: { spam: true } });
  await setSpam({ api, toast: (m) => toasts.push(m), customerId: "U1", name: "คุณเอ", spam: false });
  assert.deepEqual(calls[1].body, { spam: false });
  assert.match(toasts.at(-1), /AI ยังปิดอยู่/u);
  // DOM ที่ไม่มี <dialog>.showModal ใช้ window.confirm แทน และถอดกล่องทิ้งเสมอ
  assert.equal(await confirmSpam({ name: "คุณเอ" }), true);
  assert.equal(byClass(doc.body, "spam-dialog").length, 0);
});

test("ชิปรอตอบ: ชิป + ตัวเลข · แถวบอกเวลารอ/มูลค่า/AI ปิดเพราะใคร/FB ตอบไม่ได้ · ปุ่มลัดอยู่นอกลิงก์", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/chat/waiting" });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps } = makeDeps(doc);
  await createChatWorkspace(deps)({ filter: "waiting" });
  const chips = findAll(doc.body, (n) => n.tagName === "a" && n._classes().has("fchip"));
  const chip = (label) => chips.find((n) => textOf(n).includes(label));
  assert.match(textOf(chip("รอตอบ")), /3$/u);
  assert.match(textOf(chip("ค้าง >24 ชม.")), /3$/u);
  assert.match(textOf(chip("สแปม")), /4$/u);
  assert.ok(chip("รอตอบ")._classes().has("is-active"));
  const rows = findAll(doc.body, (n) => n.tagName === "a" && n._classes().has("convo-row"));
  assert.deepEqual(rows.map((n) => n.attributes.href), IDS.map((id) => `#/chat/waiting/${id}`), "ลำดับคิวจากเซิร์ฟเวอร์ ห้ามเรียงใหม่");
  const system = byClass(rows[0], "ai-off-badge")[0];
  assert.ok(system._classes().has("by-system"));
  assert.match(system.attributes.title, /ส่งเลขบัญชีแล้ว/u, "เหตุที่ระบบปิดอยู่ใน tooltip");
  assert.ok(byClass(rows[2], "ai-off-badge")[0]._classes().has("by-human"));
  assert.match(textOf(rows[1]), /FB เกิน 24 ชม\. — ตอบใน Business Suite/u);
  assert.match(textOf(rows[0]), /เรื่องเงิน/u);
  assert.match(textOf(rows[0]), /รอ 24/u);
  // ปุ่มลัดเป็นพี่น้องของลิงก์ ไม่ใช่ลูก (ปุ่มในลิงก์ = กดแล้วพาเข้าห้องแทน)
  for (const row of rows) assert.equal(findAll(row, (n) => n.tagName === "button").length, 0);
  assert.equal(byText(doc.body, "button", "✓ เสร็จสิ้น").length, 3);
  assert.equal(byText(doc.body, "button", "สแปม").length, 3);
  // เดสก์ท็อปยังไม่เปิดห้อง: ปุ่มเปิดห้องบนสุดของคิว (ไล่ทีละห้องได้ทันที)
  const go = byClass(doc.body, "chat-empty-go")[0];
  assert.equal(go.attributes.href, `#/chat/waiting/${IDS[0]}`);
});

test("หัวห้อง: AI ปิดโดยคน = ม่วง · โดยระบบ = แดงพร้อมเหตุ · มีปุ่มสแปม · ห้องสแปมมีทางคืน", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${IDS[2]}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const human = makeDeps(doc, { filter: null, room: roomPayload(IDS[2]) });
  await createChatWorkspace(human.deps)({ customerId: IDS[2] });
  let toggle = byClass(doc.body, "ai-toggle")[0];
  assert.ok(toggle._classes().has("is-off") && toggle._classes().has("by-human"));
  assert.equal(textOf(toggle), "AI ปิด · โดยคน");
  assert.ok(byClass(doc.body, "spam-btn").length === 1);
  assert.equal(byClass(doc.body, "triage-bar").length, 0, "เปิดจากรายการปกติ = ไม่มีแถบคิว");

  const system = makeDeps(doc, {
    filter: null,
    room: roomPayload(IDS[0], { aiOff: { by: "system", reason: "human_requested", label: "AI ปิด · โดยระบบ", reasonText: "ลูกค้าขอคุยกับคน" } }),
  });
  await createChatWorkspace(system.deps)({ customerId: IDS[0] });
  toggle = byClass(doc.body, "ai-toggle")[0];
  assert.ok(toggle._classes().has("by-system"));
  assert.equal(textOf(toggle), "AI ปิด · โดยระบบ");
  assert.match(toggle.attributes.title, /ลูกค้าขอคุยกับคน/u);

  const spam = makeDeps(doc, { filter: null, room: roomPayload(IDS[1], { spam: true, fbReplyClosed: true }) });
  await createChatWorkspace(spam.deps)({ customerId: IDS[1] });
  assert.match(textOf(byClass(doc.body, "triage-bar")[0]), /ห้องนี้อยู่ในสแปม/u);
  assert.match(textOf(byClass(doc.body, "triage-unspam")[0]), /ไม่ใช่สแปม/u, "ทางคืนอยู่ในแถบสแปม");
  assert.equal(byClass(doc.body, "spam-btn").length, 0, "ห้องสแปมไม่มีปุ่มสแปมซ้ำในหัวห้อง");
  assert.match(textOf(byClass(doc.body, "fb-window-banner")[0]), /Facebook เกิน 24 ชม\. แล้ว/u, "บอกก่อนพิมพ์ว่าคอนโซลตอบไม่ได้");
});

// 5 ต.ค. 2026 (คำสั่งพี่ง้วง "icon สีเหลือง ประมาณว่า AI off (not qualify)"): ห้องที่ตัวกวาดคัดกรองปิด — ทุกจุดที่โชว์
// สถานะ AI ของห้องต้องเป็นเหลืองพร้อมเหตุ (แถวคิว · ปุ่มหัวห้อง + tooltip · แถบคิว) และห้องอื่นในคิวเดียวกันสีเดิม
test("ห้องเหลือง: แถวรอตอบ · ปุ่มหัวห้อง · แถบคิว ขึ้น AI off (not qualify) พร้อมเหตุ · กดเปิด AI ได้ · ห้องอื่นสีเดิม", async (t) => {
  const qualifyOff = { by: "qualify", reason: "not_qualified", label: "AI off (not qualify)", reasonText: "บอกว่าตกงาน กำลังหาวิธีหาเงินฟรี" };
  const { doc } = installBrowserGlobals(t, { hash: `#/chat/waiting/${IDS[2]}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const inbox = inboxPayload();
  inbox.conversations = inbox.conversations.map((row) => (row.line_user_id === IDS[2] ? { ...row, ai_off: qualifyOff } : row));
  const { deps, calls, toasts } = makeDeps(doc, { room: roomPayload(IDS[2], { aiOff: qualifyOff }), inbox });
  await createChatWorkspace(deps)({ customerId: IDS[2], filter: "waiting" });

  const rows = findAll(doc.body, (n) => n.tagName === "a" && n._classes().has("convo-row"));
  const badge = byClass(rows[2], "ai-off-badge")[0];
  assert.ok(badge._classes().has("by-qualify"), "ป้ายเหลือง");
  assert.equal(textOf(badge), "AI off (not qualify)");
  assert.match(badge.attributes.title, /^AI off \(not qualify\) — บอกว่าตกงาน/u);
  const reason = byClass(rows[2], "ai-off-reason")[0];
  assert.ok(reason._classes().has("by-qualify"));
  assert.equal(textOf(reason), qualifyOff.reasonText, "มือถือไม่มี tooltip — เหตุต้องอยู่บนแถว");
  assert.ok(byClass(rows[0], "ai-off-badge")[0]._classes().has("by-system"), "ห้องเส้นเงินยังแดงเหมือนเดิม");
  assert.equal(byClass(doc.body, "by-qualify").filter((n) => n._classes().has("ai-off-badge")).length, 1);

  const toggle = byClass(doc.body, "ai-toggle")[0];
  assert.ok(toggle._classes().has("is-off") && toggle._classes().has("by-qualify"));
  assert.equal(textOf(toggle), "AI off (not qualify)");
  assert.match(toggle.attributes.title, /^AI off \(not qualify\) — บอกว่าตกงาน กำลังหาวิธีหาเงินฟรี · แตะเพื่อเปิด AI \(ตัวกวาดคัดกรองจะไม่ปิดห้องนี้อีก\)$/u);
  const why = byClass(byClass(doc.body, "triage-bar")[0], "triage-bar-why")[0];
  assert.ok(why._classes().has("by-qualify"));
  assert.equal(textOf(why), "AI off (not qualify) — บอกว่าตกงาน กำลังหาวิธีหาเงินฟรี");

  // กดเปิด AI ทับผลคัดกรองได้เหมือนห้องอื่น (เซิร์ฟเวอร์จด qualify_release — Part D) และบอกผลให้ชัด
  await click(toggle);
  const post = calls.find((c) => c.path === `/console/api/customers/${IDS[2]}/ai`);
  assert.deepEqual(post && { method: post.method, body: post.body }, { method: "POST", body: { enabled: true } });
  assert.equal(toasts.at(-1), "เปิด AI แล้ว — ตัวกวาดคัดกรองจะไม่ปิดห้องนี้อีก");
});

test("ห้องคนปิด/ระบบปิด: แถบคิวและข้อความหลังกดเปิด AI ถ้อยคำเดิม (เหลืองไม่ไปแตะสถานะอื่น)", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/chat/waiting/${IDS[2]}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps, toasts } = makeDeps(doc, { room: roomPayload(IDS[2]) });
  await createChatWorkspace(deps)({ customerId: IDS[2], filter: "waiting" });
  const why = byClass(doc.body, "triage-bar-why")[0];
  assert.ok(why._classes().has("by-human"));
  assert.equal(textOf(why), "AI ปิดเพราะ: ทีมกดปิดเอง");
  const toggle = byClass(doc.body, "ai-toggle")[0];
  assert.equal(toggle.attributes.title, "AI ปิด · โดยคน — ทีมกดปิดเอง · แตะเพื่อเปิด AI");
  await click(toggle);
  assert.equal(toasts.at(-1), "เปิด AI แล้ว");
});

test("คิวรอตอบ: แถบบอกลำดับ + ห้องถัดไป · ✓ เสร็จสิ้น แล้วเปิดห้องถัดไปเอง (ไม่ต้อง back)", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/chat/waiting/${IDS[0]}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps, calls, toasts } = makeDeps(doc, { room: roomPayload(IDS[0]), freshOrder: [IDS[1], IDS[2]] });
  await createChatWorkspace(deps)({ customerId: IDS[0], filter: "waiting" });
  const bar = byClass(doc.body, "triage-bar")[0];
  assert.match(textOf(bar), /ห้อง 1 จาก 3/u);
  assert.equal(byClass(bar, "triage-next")[0].attributes.href, `#/chat/waiting/${IDS[1]}`);
  assert.equal(byClass(doc.body, "chat-back")[0].attributes.href, "#/chat/waiting", "ปุ่มกลับพากลับคิวเดิม");
  const done = byText(byClass(doc.body, "chat-head")[0], "button", "✓ เสร็จสิ้น")[0];
  await click(done);
  const resolve = calls.find((c) => c.path.endsWith(`/customers/${IDS[0]}/resolve`));
  assert.deepEqual(resolve.body, { resolved: true });
  assert.ok(calls.some((c) => c.path.startsWith("/console/api/inbox") && c.path.includes("segment=waiting") && c.path.includes("limit=1")),
    "ขอคิวล่าสุดก่อนเลือกห้องถัดไป");
  assert.equal(globalThis.location.hash, `#/chat/waiting/${IDS[1]}`);
  assert.match(toasts.at(-1), /ปิดเคสเป็นเสร็จสิ้นแล้ว · เปิดห้องถัดไปให้แล้ว/u);
});

test("หัวห้อง: กด ✓ เสร็จสิ้นรัวสองครั้ง = ยิงเซิร์ฟเวอร์ครั้งเดียว (ไม่ audit ซ้ำ ไม่กระโดดสองห้อง)", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/chat/waiting/${IDS[0]}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps, calls } = makeDeps(doc, { room: roomPayload(IDS[0]), freshOrder: [IDS[1], IDS[2]] });
  await createChatWorkspace(deps)({ customerId: IDS[0], filter: "waiting" });
  const done = byText(byClass(doc.body, "chat-head")[0], "button", "✓ เสร็จสิ้น")[0];
  const fire = () => Promise.all((done.listeners.click || []).map((fn) => fn({ currentTarget: done, preventDefault() {}, stopPropagation() {} })));
  await Promise.all([fire(), fire()]);
  assert.equal(calls.filter((c) => c.path.endsWith(`/customers/${IDS[0]}/resolve`)).length, 1);
  assert.equal(done.disabled, false, "ปุ่มกลับมากดได้หลังคำขอจบ");
});

test("คิวรอตอบ: ส่งข้อความตอบแล้วเปิดห้องถัดไปเอง · กดสแปม (ยืนยันแล้ว) ก็เช่นกัน · ห้องสุดท้าย = กลับหน้าคิว", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/chat/waiting/${IDS[1]}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const sent = makeDeps(doc, { room: roomPayload(IDS[1]), freshOrder: [IDS[0], IDS[2]] });
  await createChatWorkspace(sent.deps)({ customerId: IDS[1], filter: "waiting" });
  const input = byClass(doc.body, "reply-input")[0];
  input.value = "ได้เลยค่ะ ส่งรายละเอียดให้นะคะ";
  await click(byClass(doc.body, "btn-send")[0]);
  assert.ok(sent.calls.some((c) => c.path.endsWith(`/conversations/${IDS[1]}/reply`) && c.method === "POST"));
  assert.equal(globalThis.location.hash, `#/chat/waiting/${IDS[2]}`, "ห้องถัดลงไปที่ยังรออยู่");

  globalThis.location.hash = `#/chat/waiting/${IDS[2]}`;
  const spam = makeDeps(doc, { room: roomPayload(IDS[2]), freshOrder: [] });
  await createChatWorkspace(spam.deps)({ customerId: IDS[2], filter: "waiting" });
  await click(byClass(doc.body, "spam-btn")[0]);
  assert.ok(spam.calls.some((c) => c.path.endsWith(`/customers/${IDS[2]}/spam`) && c.body?.spam === true));
  assert.equal(globalThis.location.hash, "#/chat/waiting", "คิวหมด = กลับหน้าคิว (ว่าง)");
  assert.match(spam.toasts.at(-1), /คิวนี้ไม่เหลือห้องแล้ว/u);
});

// 30 ก.ย. 2026 (พี่ง้วง: "อยากให้หายได้ทางเดียวคือต้องพิมพ์คุยจริง ๆ" + ปุ่ม "ไล่ทักทีละห้อง" แบบคิวรอตอบ)
test("คิวรอทีมทักต่อ: ชิป + แถวบอกเงียบนาน/FB เหลือเวลา · พิมพ์คุยแล้วเปิดห้องถัดไปเอง · กดเสร็จสิ้นห้องยังอยู่ในคิว", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/chat/hotfollow/${IDS[0]}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const hotRow = (id, extra = {}) => ({
    ...waitingRow(id), waiting: undefined, ai_enabled: 1, ai_off: null, last_score: 9,
    hot_follow: { lastInAt: Date.now() - 3 * DAY, silentMs: 3 * DAY, aiReplies: 2, teamTalkedBefore: false, fbHumanUntil: null, value: "hot", score: 9, preview: "สนใจคลาสค่ะ" },
    ...extra,
  });
  const inbox = {
    ok: true,
    conversations: [
      hotRow(IDS[0], { channel_id: "facebook", hot_follow: { lastInAt: Date.now() - 6.5 * DAY, silentMs: 6.5 * DAY, aiReplies: 3, teamTalkedBefore: true, fbHumanUntil: Date.now() + 10.5 * 3_600_000, value: "hot", score: 9, preview: "ราคาเท่าไหร่คะ" } }),
      hotRow(IDS[1]), hotRow(IDS[2]),
    ],
    hasMore: false,
    counts: { all: 40, hot: 3, warm: 5, cold: 32, needs: 2, aioff: 9, resolved: 1, mine: 0, customer: 1, spam: 4, waiting: 0, waiting24: 0, hotfollow: 3 },
    waitingOrder: IDS,
  };
  const sent = makeDeps(doc, { filter: "hotfollow", room: roomPayload(IDS[0], { aiOff: null }), inbox, freshOrder: [IDS[1], IDS[2]] });
  await createChatWorkspace(sent.deps)({ customerId: IDS[0], filter: "hotfollow" });
  const chip = byClass(doc.body, "fchip-hotfollow")[0];
  assert.match(textOf(chip), /ไม้ต่อจากลูกแพร\s*3/u);
  const row = byClass(doc.body, "is-hotfollow")[0];
  assert.match(textOf(row), /FB ตอบได้อีก 10\u00a0ชม\./u, "ห้อง Facebook บอกเวลาที่เหลือตอบใน Business Suite");
  assert.match(textOf(row), /เคยคุยกับทีม · ลูกแพรตอบ \+ ทักตาม 3/u);
  assert.equal(byClass(doc.body, "row-actions").length, 0, "ไม่มีปุ่มลัดเสร็จสิ้น — ออกจากคิวได้ทางเดียวคือพิมพ์คุย");
  const bar = byClass(doc.body, "triage-bar")[0];
  assert.match(textOf(bar), /ไม้ต่อจากลูกแพร — ลูกแพรคุยจบแล้ว ถึงตาทีมคุยต่อ/u);
  assert.match(textOf(bar), /ห้อง 1 จาก 3/u);
  assert.equal(byClass(bar, "triage-next")[0].attributes.href, `#/chat/hotfollow/${IDS[1]}`);
  // กดเสร็จสิ้น = ปิดเคสได้ แต่ห้องยังอยู่ในคิว ไม่กระโดดไปห้องอื่น
  await click(byText(byClass(doc.body, "chat-head")[0], "button", "✓ เสร็จสิ้น")[0]);
  assert.equal(globalThis.location.hash, `#/chat/hotfollow/${IDS[0]}`);
  assert.match(sent.toasts.at(-1), /ยังอยู่ในคิวไม้ต่อจนกว่าจะพิมพ์คุยกับลูกค้า/u);
  // พิมพ์คุยกับลูกค้า = ห้องหลุดคิว เปิดห้องถัดไปเอง
  const input = byClass(doc.body, "reply-input")[0];
  input.value = "สวัสดีค่ะ ชมพู่จากทีมพี่ง้วงนะคะ";
  await click(byClass(doc.body, "btn-send")[0]);
  assert.ok(sent.calls.some((c) => c.path.endsWith(`/conversations/${IDS[0]}/reply`) && c.method === "POST"));
  assert.equal(globalThis.location.hash, `#/chat/hotfollow/${IDS[1]}`);
});

test("หน้าภาพรวม: แถวรอตอบมีปุ่มลัด ✓ เสร็จสิ้น / สแปม · แถวลูกค้าร้อนไม่มี · กดแล้ววาดหน้าใหม่", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/" });
  const { createOverviewPage } = await import("../public/console/overview.mjs");
  const calls = [];
  const room = (id, extra) => ({ id, name: id, pictureUrl: "", channelId: "default", channelName: "LINE", score: 6, value: "warm", aiOn: false, owner: "", preview: "ข้อความ", ...extra });
  const api = async (path, options = {}) => {
    calls.push({ path, method: options.method || "GET", body: options.body });
    if (path.startsWith("/console/api/overview/attention")) {
      return {
        ok: true,
        waiting: {
          total: 2, over24: 1, oldestWaitMs: 3 * DAY,
          rooms: [
            room("U-a", { since: Date.now() - 3 * DAY, waitMs: 3 * DAY, fbReplyClosed: true, aiOff: { by: "system", label: "AI ปิด · โดยระบบ", reasonText: "เส้นเงิน" } }),
            room("U-b", { since: Date.now() - HOUR, waitMs: HOUR, aiOn: true, aiOff: null }),
          ],
        },
        hotQuiet: { total: 1, rooms: [room("U-hot", { lastAt: Date.now() - 2 * DAY, silentMs: 2 * DAY, score: 9, value: "hot" })] },
      };
    }
    if (path.startsWith("/console/api/overview")) return { ok: true, stats: {}, orders: null, series: [], lastInboundAt: Date.now(), aiPaused: false };
    if (path.startsWith("/console/api/inbox")) return { ok: true, conversations: [], counts: {} };
    return { ok: true };
  };
  await createOverviewPage({
    api, toast: () => {}, mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {},
    state: { me: { username: "owner", role: "owner", capabilities: ["operations.use"] }, branding: {}, channels: [], channel: null, routeGen: 0, features: {}, pollTimer: null },
  })();
  const waiting = findAll(doc.body, (n) => n.attributes?.id === "ov-waiting")[0];
  const hot = findAll(doc.body, (n) => n.attributes?.id === "ov-hotquiet")[0];
  assert.equal(byClass(waiting, "row-actions").length, 2);
  assert.equal(byClass(hot, "row-actions").length, 0);
  assert.match(textOf(waiting), /FB เกิน 24 ชม\./u);
  assert.match(textOf(waiting), /AI ปิด · โดยระบบ/u);
  assert.match(textOf(waiting), /AI เปิด/u);
  assert.match(textOf(waiting), /ค้างเกินวัน 1/u);
  assert.ok(findAll(waiting, (n) => n.tagName === "a" && n.attributes.href === "#/chat/waiting/U-a").length === 2,
    "แถวบนสุด + ลิงก์ไล่ตอบทีละห้อง = เปิดห้องบนสุดของคิวในหน้าแชท");
  const before = calls.filter((c) => c.path.startsWith("/console/api/overview/attention")).length;
  await click(byText(waiting, "button", "✓ เสร็จสิ้น")[0]);
  assert.ok(calls.some((c) => c.path === "/console/api/customers/U-a/resolve" && c.body?.resolved === true));
  assert.equal(calls.filter((c) => c.path.startsWith("/console/api/overview/attention")).length, before + 1, "วาดหน้าใหม่ ห้องหลุดจากรายการ");
});
