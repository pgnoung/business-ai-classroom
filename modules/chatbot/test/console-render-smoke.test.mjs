// เรนเดอร์หน้าเว็บจริงด้วย DOM จำลอง เพื่อจับ ReferenceError/TypeError ที่การอ่านซอร์สจับไม่ได้
//
// ที่มา (2026-08-26): `roomData is not defined` — อ้างตัวแปรผิดชื่อในฟังก์ชันที่รับ `data`
// หลุดขึ้น production ทั้งที่เทสต์ผ่าน 1417 ตัว เพราะไม่มีเทสต์ไหนรันโค้ดหน้าเว็บเลย
// เทสต์เดิมอ่านซอร์สเป็นข้อความแล้ว match regex ซึ่งมองไม่เห็นความผิดแบบนี้
// คนแรกที่เจอคือพี่ง้วงตอนกดเข้าห้องแชท — ไม่ควรเป็นแบบนั้น
import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./console-dom.mjs";
import { installPhotoBrowser, flushPhoto, firePhoto } from "./photo-browser.mjs";

test("photo composer: review before upload; choosing original attaches only, never sends", async t => {
  const ui = installPhotoBrowser(t);
  const { deps, calls } = makeDeps(ui.doc);
  const uploaded = [];
  deps.uploadMedia = async (path, file) => { uploaded.push({path,file});return {attachment:{id:"reviewed-photo",kind:"image"}}; };
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  await createChatWorkspace(deps)({customerId:CUSTOMER});
  const source = new File(["synthetic"],"class.jpg",{type:"image/jpeg"});
  const picker = ui.doc.querySelectorAll("input").find(n=>n.attributes.type==="file");
  await firePhoto(picker,"change",{target:{files:[source],value:"class.jpg"}});await flushPhoto();
  assert.equal(uploaded.length,0);assert.equal(deps.state.chat.uploading,1);
  await firePhoto(ui.button("ใช้ต้นฉบับ"));await flushPhoto();
  assert.equal(uploaded.length,1);assert.equal(uploaded[0].file,source);
  assert.ok(uploaded[0].path.startsWith(`/console/api/conversations/${CUSTOMER}/attachments?`));
  assert.equal(deps.state.chat.attachments.length,1);assert.equal(deps.state.chat.uploading,0);
  assert.equal(calls.some(p=>p.includes("/reply")),false);
});

test("photo composer: cancel or switch room during review never uploads into either room", async t => {
  const ui = installPhotoBrowser(t); const {deps} = makeDeps(ui.doc);
  let uploads=0;deps.uploadMedia=async()=>{uploads++;return{attachment:{id:"must-not-upload"}};};
  const {createChatWorkspace}=await import("../public/console/chat.mjs");
  await createChatWorkspace(deps)({customerId:CUSTOMER});
  const picker=ui.doc.querySelectorAll("input").find(n=>n.attributes.type==="file");
  const select=async()=>{await firePhoto(picker,"change",{target:{files:[new File(["x"],"x.jpg",{type:"image/jpeg"})],value:"x.jpg"}});await flushPhoto();};
  await select();await firePhoto(ui.button("ยกเลิก"));await flushPhoto();assert.equal(uploads,0);
  const oldRoom=deps.state.chat;
  await select();deps.state.chat={id:"different-synthetic-room",attachments:[],uploading:0};
  await firePhoto(ui.button("ใช้ต้นฉบับ"));await flushPhoto();
  assert.equal(uploads,0);assert.deepEqual(oldRoom.attachments,[]);assert.equal(oldRoom.uploading,0);
  assert.deepEqual(deps.state.chat.attachments,[]);
});

const CUSTOMER = "U00000000000000000000000000000a02";

function inboxPayload() {
  return {
    ok: true,
    conversations: [{
      line_user_id: CUSTOMER, display_name: "Somsak", last_message: "สนใจคอร์สค่ะ",
      last_at: Date.now(), unread: 2, last_score: 8, ai_enabled: 0, state: "OPEN",
      ai_off_reason: "customer_handover", channel_id: "default",
    }],
    hasMore: false, counts: { all: 1, hot: 1, warm: 0 },
  };
}

function roomPayload(overrides = {}) {
  return {
    ok: true,
    customer: {
      line_user_id: CUSTOMER, display_name: "Somsak", known_name: "", ai_enabled: 0,
      state: "OPEN", last_score: 8, ai_off_reason: "customer_handover",
      operator_active_until: 0, do_not_disturb: 0, legacy_link: "", human_owner: "",
    },
    messages: [
      { id: "m1", direction: "in", msg_type: "text", content: "สนใจคอร์สค่ะ", created_at: Date.now() - 60000 },
      { id: "m2", direction: "out", msg_type: "text", content: "ยินดีค่ะ", created_at: Date.now() - 30000, operator: "" },
    ],
    hasMoreOlder: false, score: { score: 8, trend: "up" }, followups: [], followupGlobal: false,
    followupAppointmentArmed: false, handoffNotes: [], aiCost: { thb: 67 }, orders: [],
    tags: [{ tag: "สนใจ AI Agent for Business" }], lifecycle: { stage: "sales", dealStatus: "awaiting_payment" },
    lifecycleEvents: [], slipChecks: [], pendingDraft: null, aiPaused: true,
    quickReplies: [], attachments: [], ...overrides,
  };
}

function makeDeps(doc, { room = roomPayload(), inbox = inboxPayload() } = {}) {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.startsWith("/console/api/inbox")) return inbox;
    if (path.includes("/messages")) return room;
    if (path.startsWith("/console/api/overview")) {
      return {
        ok: true,
        stats: {
          todayChats: 3, pendingFollowups: 2, hot: 1, warm: 0, cold: 5, total: 5524,
          needsHuman: 1, aiOff: 824, unread: 3, resolvedToday: 2,
        },
        orders: { todayCount: 1, monthRevenue: 23800, openCount: 2 },
        quota: { value: 15000, totalUsage: 1200, type: "limited" },
        quotas: [{ channelId: "default", label: "หลัก", value: 15000, totalUsage: 1200, type: "limited" }],
        series: [{ day: "2026-08-26", inbound: 12, outbound: 10, newCustomers: 2 }],
        channel: null,
        aiCost: {
          today: { thb: 67, tokensIn: 1000, tokensOut: 500 },
          month: {
            thb: 1200, tokensIn: 20000, tokensOut: 9000,
            breakdown: [{ model: "gpt-5.6-sol", kind: "reply", tokensIn: 100, tokensOut: 50, thb: 3 }],
          },
        },
        followupGlobal: false, followupAppointmentArmed: false,
        roomsAwaitingLegacyConfirm: 17, lastInboundAt: Date.now() - 20 * 60000, aiPaused: true,
        canary: { enabled: false, lastProbeAt: null }, corrections: [], learning: { enabled: false },
        backup: { enabled: true },
      };
    }
    if (path.startsWith("/console/api/class-rounds")) {
      return { ok: true, rounds: [
        { date: "2026-09-05", thai: "5 ก.ย. 2026", classKey: "basic", label: "Classroom AI Agent for Business",
          capacity: 15, enrolled: 7, seatsLeft: 8, overbooked: 0, unlimited: false },
        { date: "2026-09-12", thai: "12 ก.ย. 2026", classKey: "online", label: "คลาสออนไลน์",
          capacity: null, enrolled: null, seatsLeft: null, overbooked: 0, unlimited: true },
      ] };
    }
    return { ok: true };
  };
  const mounted = [];
  return {
    calls, mounted,
    deps: {
      api,
      uploadMedia: async () => ({ ok: true }),
      toast: () => {},
      mount: (...nodes) => { mounted.length = 0; mounted.push(...nodes.filter(Boolean)); doc.body.replaceChildren(...nodes.filter(Boolean)); },
      pageHeader: (title) => { const n = doc.createElement("header"); n.textContent = title; return n; },
      tabBar: () => doc.createElement("nav"),
      stopPolling: () => {},
      setView: () => {},
      channelName: () => "default",
      state: {
        me: { username: "pilot-owner", role: "owner", capabilities: ["media.send", "operations.use"] },
        csrf: "t", branding: { name: "พี่ง้วง", mark: "พง", agent: "ลูกแพร", theme: "airdog" },
        pollTimer: null, draft: null, routeGen: 0, channels: [], channel: null, settingsChannel: null,
        operators: [],
        features: { broadcast: true, classRounds: true, imageUpload: true, fileUpload: true, stickers: true, webPush: false },
        webPushPublicKey: "",
        ui: { salesOpen: false, fuOpen: false, notesOpen: false, exportOpen: false, contextOpen: null, theme: "light" },
        inbox: { filter: null, q: "", extra: [], hasMore: false },
        chat: { id: null, head: [], older: [], hasMoreOlder: false, atBottom: true, keepFromBottom: null },
        chatDrafts: new Map(),
        chatUncertain: new Map(),
      },
    },
  };
}

test("หน้าแชท: เปิดห้องลูกค้าจริงต้องเรนเดอร์จนจบ ไม่โยน error", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps } = makeDeps(doc);
  const renderChat = createChatWorkspace(deps);

  await renderChat({ customerId: CUSTOMER });

  // ต้องมีของจริงบนหน้า ไม่ใช่แค่ไม่ throw
  assert.ok(doc.querySelector(".chat-workspace"), "ต้องมี workspace");
  assert.ok(doc.querySelector(".reply-input"), "ต้องมีกล่องพิมพ์");
  assert.equal(doc.querySelector(".reply-input").dataset.room, CUSTOMER,
    "กล่องพิมพ์ต้องรู้ว่าเป็นของห้องไหน (กันข้อความข้ามห้อง)");
});

test("หน้าแชท: ลูกแพรหยุดทั้งระบบ ต้องไม่ขึ้นว่า AI ตอบอยู่", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const room = roomPayload({ customer: { ...roomPayload().customer, ai_enabled: 1 }, aiPaused: true });
  const { deps } = makeDeps(doc, { room });
  await createChatWorkspace(deps)({ customerId: CUSTOMER });

  const text = JSON.stringify(doc.body, (key, value) => (key === "parent" ? undefined : value));
  assert.match(text, /ลูกแพรหยุดทั้งระบบ/u, "สวิตช์ห้องเปิดแต่ระบบหยุด ต้องบอกตรง ๆ");
  assert.doesNotMatch(text, /AI ตอบอยู่/u, "ห้ามบอกว่ามีคนดูแลอยู่ทั้งที่ไม่มีใครตอบ");
});

test("หน้าแชท: เปิดหน้ารายการอย่างเดียว (ไม่มีห้อง) ต้องเรนเดอร์ได้", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/chat" });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps } = makeDeps(doc);
  await createChatWorkspace(deps)({ customerId: null });
  assert.ok(doc.querySelector(".convo-pane") || doc.body.children.length > 0);
});

test("หน้าภาพรวม: เรนเดอร์จนจบ และเตือนเรื่องที่ต้องเตือน", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/" });
  const { createOverviewPage } = await import("../public/console/overview.mjs");
  const { deps } = makeDeps(doc);
  await createOverviewPage(deps)();

  const text = JSON.stringify(doc.body, (key, value) => (key === "parent" ? undefined : value));
  assert.match(text, /รอยืนยันห้องระบบเก่า/u, "ต้องเตือนห้องที่ถูกปิด AI เองไว้");
  assert.match(text, /ลูกค้าทักล่าสุด/u, "ต้องมีตัวชี้วัดว่าระบบยังรับข้อความอยู่");
  assert.match(text, /ระบบนัดหมายยังไม่ติดเครื่อง/u, "นัดที่ยังส่งไม่ได้ ต้องบอกตรง ๆ");
});

test("หน้าที่นั่ง: เรนเดอร์ได้ และรอบไม่จำกัดต้องไม่โชว์ตัวเลขที่นั่ง", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/rounds" });
  const { createRoundsPage } = await import("../public/console/rounds.mjs");
  const { deps } = makeDeps(doc);
  await createRoundsPage(deps)();

  const text = JSON.stringify(doc.body, (key, value) => (key === "parent" ? undefined : value));
  assert.match(text, /เพิ่มรอบเรียน/u, "ต้องมีช่องเพิ่มรอบเอง");
  assert.match(text, /เหลือ 8 ที่/u, "รอบจำกัดที่นั่งยังบอกตัวเลขได้");
  assert.match(text, /ราคาพิเศษมีจำนวนจำกัด/u, "รอบไม่จำกัดต้องใช้ข้อความนี้");
  assert.doesNotMatch(text, /ไม่จำกัดที่นั่ง"/u, "ห้ามโชว์คำว่าไม่จำกัดเป็นสถานะให้ลูกค้าเห็น");
});

// ทุกหน้าที่เหลือ — เป้าหมายคือ "เรนเดอร์จนจบโดยไม่โยน" ไม่ใช่ตรวจเนื้อหา
// เพราะสิ่งที่หลุดขึ้น production คือ ReferenceError/TypeError ไม่ใช่ข้อความผิด
const PAGES = [
  ["settings", "createSettingsPage"],
  ["knowledge", "createKnowledgePage"],
  ["orders", "createOrdersPage"],
  ["broadcast", "createBroadcastPage"],
  ["training", "createTrainingReviewPage"],
  ["backup", "createBackupPage"],
];

for (const [file, factory] of PAGES) {
  test(`หน้า ${file}: เรนเดอร์จนจบ ไม่โยน error`, async (t) => {
    const { doc } = installBrowserGlobals(t, { hash: `#/${file}` });
    const mod = await import(`../public/console/${file}.mjs`);
    if (typeof mod[factory] !== "function") {
      assert.fail(`${file}.mjs ต้อง export ${factory} — ถ้าเปลี่ยนชื่อ ให้แก้รายการ PAGES ด้วย`);
    }
    const { deps } = makeDeps(doc);
    await mod[factory](deps)();
    assert.ok(doc.body.children.length > 0, "ต้องมีอะไรถูกวางลงหน้า");
  });
}

// ---- ป้าย "สรุปจาก LINE OA" (คำสั่งพี่ง้วง 2026-08-26) ----
// ป้ายนี้เป็นสัญญาณเดียวที่บอกว่าห้องนี้ AI ยังไม่มี context ของเรื่องที่ไปคุยในแอป LINE OA
// ถ้าหายไปเงียบ ๆ ชมพู่จะไม่มีทางรู้ว่าต้องเขียนโน้ตส่งต่อ — จึงต้องมีเทสต์ที่เห็นของจริงบนหน้า

const bodyText = (doc) => JSON.stringify(doc.body, (key, value) => (key === "parent" ? undefined : value));

test("หน้าแชท: ห้องที่ยังไม่มีใครสรุปกลับ ต้องขึ้นป้ายส้ม", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const room = roomPayload({
    lineOaContext: { synced: false, reason: "pending", lastInboundAt: Date.now(), contextAt: null },
  });
  const { deps } = makeDeps(doc, { room });
  await createChatWorkspace(deps)({ customerId: CUSTOMER });

  const badge = doc.querySelector(".chat-head-sub .badge-orange");
  assert.ok(badge, "ต้องมีป้ายสีส้มในหัวห้อง");
  assert.match(bodyText(doc), /รอสรุป/u);
});

test("หน้าแชท: สรุปแล้วต้องเป็นเขียว ไม่ใช่ส้ม", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const room = roomPayload({
    lineOaContext: { synced: true, reason: "note", lastInboundAt: Date.now() - 1000, contextAt: Date.now() },
  });
  const { deps } = makeDeps(doc, { room });
  await createChatWorkspace(deps)({ customerId: CUSTOMER });

  assert.ok(doc.querySelector(".chat-head-sub .badge-green"), "ต้องเป็นป้ายเขียว");
  assert.equal(doc.querySelector(".chat-head-sub .badge-orange"), null, "ห้ามส้มพร้อมกัน");
  assert.match(bodyText(doc), /สรุปแล้ว/u);
});

test("หน้าแชท: ห้องที่ AI ยังตอบอยู่ (context = null) ต้องไม่มีป้ายนี้เลย", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps } = makeDeps(doc, { room: roomPayload({ lineOaContext: null }) });
  await createChatWorkspace(deps)({ customerId: CUSTOMER });

  const text = bodyText(doc);
  assert.doesNotMatch(text, /รอสรุป/u);
  assert.doesNotMatch(text, /สรุปแล้ว/u);
});

test("หัวห้อง: ข้อความยาวต้องยุบด้วย ellipsis แต่ป้ายต้องไม่โดนตัดหาย", async (t) => {
  // .chat-head-sub เดิมเป็น nowrap+ellipsis ทั้งก้อน — ป้ายที่ต่อท้ายจะหายบนจอมือถือ
  // ซึ่งเป็นจอที่ชมพู่ใช้จริง จึงต้องแยกข้อความออกเป็น .chat-head-sub-text
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const room = roomPayload({
    lineOaContext: { synced: false, reason: "pending", lastInboundAt: Date.now(), contextAt: null },
  });
  const { deps } = makeDeps(doc, { room });
  await createChatWorkspace(deps)({ customerId: CUSTOMER });

  const sub = doc.querySelector(".chat-head-sub");
  assert.ok(sub.querySelector(".chat-head-sub-text"), "ข้อความต้องอยู่ในกล่องยุบได้ของตัวเอง");
  assert.ok(sub.querySelector(".badge"), "ป้ายต้องเป็นลูกโดยตรงของ .chat-head-sub ไม่ใช่อยู่ในกล่องที่ถูก ellipsis");
});

test("รายการแชท: ป้ายส้ม/เขียวต้องขึ้นบนแถวห้อง ไม่ใช่แค่ในห้อง", async (t) => {
  // ชมพู่กวาดตาดูรายการซ้ายก่อนกดเข้าห้อง — ถ้าป้ายขึ้นแต่ในห้อง ก็ต้องเปิดทีละห้องถึงจะรู้
  const { doc } = installBrowserGlobals(t, { hash: "#/chat" });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const base = inboxPayload();
  const inbox = {
    ...base,
    conversations: [
      { ...base.conversations[0], line_user_id: "U-pending",
        line_oa_context: { synced: false, reason: "pending", lastInboundAt: Date.now(), contextAt: null } },
      { ...base.conversations[0], line_user_id: "U-synced", display_name: "ลูกค้าที่สรุปแล้ว",
        line_oa_context: { synced: true, reason: "note", lastInboundAt: Date.now() - 1000, contextAt: Date.now() } },
      { ...base.conversations[0], line_user_id: "U-ai", display_name: "ห้อง AI ปกติ",
        ai_enabled: 1, line_oa_context: null },
    ],
    counts: { all: 3, hot: 3, warm: 0 },
  };
  await createChatWorkspace(makeDeps(doc, { inbox }).deps)({ customerId: null });

  const rows = doc.querySelectorAll(".convo-row");
  assert.equal(rows.length, 3, "ต้องเรนเดอร์ครบทุกแถว");
  assert.equal(rows[0].querySelectorAll(".badge-orange").length, 1, "แถวแรกต้องมีป้ายส้ม");
  assert.equal(rows[1].querySelectorAll(".badge-green").length, 1, "แถวสองต้องมีป้ายเขียว");
  assert.equal(rows[2].querySelectorAll(".badge-orange").length
    + rows[2].querySelectorAll(".badge-green").length, 0, "ห้อง AI ปกติต้องไม่มีป้ายนี้");
});

test("คิวรอคน: แถวต้องบอกเวลารอและป้ายเส้นเงิน โดยไม่ไปรกแถวที่บอทดูแลอยู่", async (t) => {
  // เหตุจริง 2026-09-02: ห้องเส้นเงินรอ 30 ชม. และ 169 ชม. โดยไม่มีอะไรบนรายการบอกเลย
  // ว่ารอนานแค่ไหน คนกวาดตาดูคิวจึงไม่มีทางรู้ว่าใครควรได้รับการตอบก่อน
  const { doc } = installBrowserGlobals(t, { hash: "#/chat/needs" });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const base = inboxPayload();
  const now = Date.now();
  const inbox = {
    ...base,
    conversations: [
      { ...base.conversations[0], line_user_id: "U-money-wait", state: "NEEDS_HUMAN",
        last_inbound_at: now - 3 * 60 * 60 * 1000, last_operator_outbound_at: null, money_seen_at: 1 },
      { ...base.conversations[0], line_user_id: "U-answered", state: "NEEDS_HUMAN",
        last_inbound_at: now - 5 * 60 * 60 * 1000, last_operator_outbound_at: now - 60 * 60 * 1000,
        money_seen_at: 0, last_slip_status: null },
    ],
    counts: { all: 2, needs: 2 },
  };
  const { deps } = makeDeps(doc, { inbox });
  deps.state.inbox.filter = "needs";
  await createChatWorkspace(deps)({ customerId: null });

  const rows = doc.querySelectorAll(".convo-row");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelectorAll(".badge-wait").length, 1, "ห้องที่ยังไม่มีใครตอบต้องบอกเวลารอ");
  assert.equal(rows[0].querySelectorAll(".badge-money").length, 1, "ห้องเส้นเงินต้องมีป้ายของตัวเอง");
  assert.equal(rows[1].querySelectorAll(".badge-wait").length, 0, "ห้องที่คนตอบไปแล้วไม่ได้รออยู่");

  // แถวปกติในรายการรวมต้องไม่มีป้ายพวกนี้ ไม่งั้นทุกแถวจะติดป้ายจนคนเลิกมอง
  const { doc: doc2 } = installBrowserGlobals(t, { hash: "#/chat" });
  const plain = {
    ...base,
    conversations: [{ ...base.conversations[0], line_user_id: "U-plain", state: "OPEN",
      last_inbound_at: now - 3 * 60 * 60 * 1000, last_operator_outbound_at: null, money_seen_at: 1 }],
  };
  const { deps: deps2 } = makeDeps(doc2, { inbox: plain });
  await createChatWorkspace(deps2)({ customerId: null });
  assert.equal(doc2.querySelectorAll(".badge-wait").length, 0, "รายการรวมต้องไม่ติดป้ายเวลารอทุกแถว");
  assert.equal(doc2.querySelectorAll(".badge-money").length, 0);
});

/* ---- บั๊กมือถือ 2026-08-27 (ชมพู่/พี่ง้วงเจอเอง) ---- */
// 1) กด i เปิดแผงข้อมูลแล้วออกไม่ได้ ค้างไปเลย
//    ต้นเหตุ: .context-pane เป็นที่เดียวในเว็บที่ลืมเผื่อ safe area ของ iPhone
//    ปุ่ม ✕ อยู่บนสุดของแผงจึงไปอยู่ใต้รอยบาก กดไม่โดน และไม่มีทางออกทางอื่นเลย
// 2) หน้าที่นั่งล้นจอ กดปุ่มไม่ได้ — ตาราง 5 คอลัมน์ + nowrap 3 คอลัมน์

test("แผงข้อมูล: ต้องมีทางออกมากกว่าปุ่ม ✕ ทางเดียว", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps } = makeDeps(doc);
  deps.state.ui.contextOpen = true;
  await createChatWorkspace(deps)({ customerId: CUSTOMER });

  assert.ok(doc.querySelector(".ctx-close"), "ต้องมีปุ่ม ✕");
  assert.ok(doc.querySelector(".ctx-backdrop"), "ต้องมีพื้นที่แตะนอกแผงเพื่อปิด");
  assert.ok(doc.querySelector(".chat-workspace.ctx-open"), "แผงต้องเปิดอยู่");
});

test("แผงข้อมูล: แตะนอกแผงแล้วต้องปิดจริง", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps } = makeDeps(doc);
  deps.state.ui.contextOpen = true;
  await createChatWorkspace(deps)({ customerId: CUSTOMER });

  const backdrop = doc.querySelector(".ctx-backdrop");
  backdrop.dispatch("click", { type: "click" });
  assert.equal(deps.state.ui.contextOpen, false, "สถานะต้องถูกปิด");
  assert.equal(doc.querySelector(".chat-workspace.ctx-open"), null, "คลาส ctx-open ต้องถูกถอด");
});

test("แผงข้อมูล: กด Escape แล้วต้องปิด", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps } = makeDeps(doc);
  deps.state.ui.contextOpen = true;
  await createChatWorkspace(deps)({ customerId: CUSTOMER });

  const handlers = doc.listeners?.keydown || [];
  assert.ok(handlers.length > 0, "ต้องมีตัวดัก keydown");
  for (const fn of handlers) fn({ key: "Escape" });
  assert.equal(deps.state.ui.contextOpen, false, "Escape ต้องปิดแผง");
});

// สลับห้องแล้วค่าในแผงขวาต้องไม่ติดตามไปด้วย
//
// เหตุการณ์จริง 2026-08-28: พี่ง้วงเปิดห้องไหนก็เห็นคำว่า "เกรซ" ในช่องชื่อจริงทุกห้อง
// ฐานข้อมูลไม่ได้เสีย — มีลูกค้าคนเดียวที่ชื่อจริงเป็น "เกรซ" จริง ๆ
//
// ต้นเหตุ: renderChat เก็บค่าช่อง .keep-focus ไว้ก่อน re-render แล้วยัดกลับหลัง render
// เพื่อไม่ให้สิ่งที่กำลังพิมพ์หาย แต่กุญแจที่ใช้เก็บคือ "ชื่อคลาสของช่อง" ซึ่งเหมือนกัน
// ทุกห้อง พอสลับห้อง ค่าของห้องเก่าจึงไหลเข้าห้องใหม่ เงื่อนไข "คืนเฉพาะช่องที่ว่าง"
// ไม่ช่วย เพราะช่องว่างคือสถานะปกติของลูกค้าที่ยังไม่มีใครกรอกชื่อจริงให้
//
// อันตรายจริงคือถ้าแอดมินกด "บันทึก" ตอนเห็นชื่อค้าง = เขียนชื่อผิดคนลงฐานทันที
const CUSTOMER_B = "U9999999999999999999999999999abcd";

test("หน้าแชท: สลับห้องแล้ว ชื่อจริงของห้องเก่าต้องไม่ติดมาโผล่ในห้องใหม่", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps } = makeDeps(doc);
  const base = roomPayload().customer;
  deps.api = async (path) => {
    if (path.startsWith("/console/api/inbox")) return inboxPayload();
    if (path.includes(CUSTOMER_B)) {
      return roomPayload({
        customer: { ...base, line_user_id: CUSTOMER_B, display_name: "KENG", known_name: "" },
      });
    }
    if (path.includes("/messages")) {
      return roomPayload({ customer: { ...base, display_name: "GRACE", known_name: "เกรซ" } });
    }
    return { ok: true };
  };
  const renderChat = createChatWorkspace(deps);

  await renderChat({ customerId: CUSTOMER });
  assert.equal(doc.querySelector(".name-input")?.value, "เกรซ",
    "ห้องที่มีชื่อจริงต้องแสดงชื่อของตัวเอง");

  globalThis.location.hash = `#/c/${CUSTOMER_B}`;
  await renderChat({ customerId: CUSTOMER_B });
  assert.equal(doc.querySelector(".name-input")?.value, "",
    "ห้องที่ยังไม่มีชื่อจริงต้องว่าง ไม่ใช่ได้ชื่อของห้องก่อนหน้ามา");
});

test("หน้าแชท: อยู่ห้องเดิม สิ่งที่พิมพ์ค้างไว้ต้องไม่หาย", async (t) => {
  // ด่านกันพลาด: การผูก snapshot กับห้อง ต้องไม่ทำลายเหตุผลเดิมที่ keep-focus มีอยู่
  // (audit 2026-08-26: กดอะไรก็ได้ในแผงขวาแล้วโน้ตที่เขียนค้างหายทันทีโดยไม่เตือน)
  const { doc } = installBrowserGlobals(t, { hash: `#/c/${CUSTOMER}` });
  const { createChatWorkspace } = await import("../public/console/chat.mjs");
  const { deps } = makeDeps(doc);
  const renderChat = createChatWorkspace(deps);

  await renderChat({ customerId: CUSTOMER });
  // เลือกช่องที่ยังว่างอยู่ช่องใดก็ได้ในแผงขวา — ไม่ผูกกับชื่อคลาสใดคลาสหนึ่ง
  const blank = doc.querySelectorAll(".chat-workspace .keep-focus")
    .find((node) => typeof node.value === "string" && node.value === "");
  assert.ok(blank, "ต้องมีช่องที่ยังว่างอย่างน้อยหนึ่งช่องให้ทดสอบ");
  const key = String(blank.className);
  blank.value = "โทรหาลูกค้าแล้ว รอเขายืนยันวันเรียน";

  await renderChat({ customerId: CUSTOMER });
  const again = doc.querySelectorAll(".chat-workspace .keep-focus")
    .find((node) => String(node.className) === key);
  assert.equal(again?.value, "โทรหาลูกค้าแล้ว รอเขายืนยันวันเรียน",
    "ห้องเดิม re-render แล้วสิ่งที่เขียนค้างต้องยังอยู่");
});
