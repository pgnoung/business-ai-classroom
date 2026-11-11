// console-ui-state.test.mjs — pure regression tests ของ scroll + Broadcast state
import test from "node:test";
import assert from "node:assert/strict";
import { captureScroll, restoreScroll } from "../public/console/scrollKeeper.mjs";
import {
  broadcastCanSend,
  broadcastScheduleUiMode,
  broadcastSkippedCount,
  createBroadcastSegmentStore,
  quarantineResolutionConfirmationText,
} from "../public/console/broadcast.mjs";
import {
  captureInboxLoadScope,
  createConvoPane,
  FU_BLOCKED_LABEL,
  humanQueueStatus,
  isInboxLoadScopeCurrent,
  waitingForHumanSince,
} from "../public/console/inbox.mjs";
import { DAILY_PROACTIVE_CAP, FACEBOOK_DAILY_PROACTIVE_CAP } from "../src/stagedFollowups.mjs";
import {
  applyOlderPageIfCurrent,
  captureChatLoadScope,
  isChatLoadScopeCurrent,
} from "../public/console/chat.mjs";

const node = (top, key = "") => ({
  scrollTop: top,
  dataset: { scrollKey: key },
  getAttribute(name) { return name === "data-scroll-key" ? key : null; },
});
const root = (mapping) => ({ querySelectorAll: (selector) => mapping[selector] || [] });

test("follow-up badge: urgent_mental ต้องบอกชัดว่าหยุดทักและส่งต่อคนดูแล", () => {
  assert.deepEqual(FU_BLOCKED_LABEL.urgent_mental, [
    "⏱ FU ส่งต่อคนดูแล",
    "พบสัญญาณวิกฤตสุขภาพจิต — ระบบหยุดทักอัตโนมัติและให้คนจริงดูแลต่อ",
  ]);
});

test("follow-up badge: ทักหลังส่งบัญชีบอกทีมว่าทักแล้ว/ตั้งใจไม่ทัก (28 ก.ย. 2026)", () => {
  assert.match(FU_BLOCKED_LABEL.payment_nudge_done[0], /ทักหลังส่งบัญชีแล้ว/u);
  assert.match(FU_BLOCKED_LABEL.payment_nudge_skipped[0], /ไม่ทักเรื่องโอน/u);
});

test("follow-up badge: ครบเพดานรายวันไม่อ้างว่าเป็น 1/วัน ทุกช่องทาง (Facebook ได้วันละ 3)", () => {
  const [label, title] = FU_BLOCKED_LABEL.daily_cap;
  assert.doesNotMatch(label, /1\/วัน/u);
  // ป้ายต้องตรงกับเพดานจริงที่ตัวทักตามใช้ — เปลี่ยนเพดานแล้วลืมแก้ป้าย เทสต์นี้ต้องแดง
  assert.ok(title.includes(`LINE วันละ ${DAILY_PROACTIVE_CAP}`), title);
  assert.ok(title.includes(`Facebook วันละ ${FACEBOOK_DAILY_PROACTIVE_CAP}`), title);
});

test("follow-up badge: บันได Facebook จบเพราะไม้ถัดไปไม่ทันหน้าต่าง 24 ชม. ต้องมีป้ายบอก ไม่หายเงียบ (28 ก.ย. 2026)", () => {
  const [label, title] = FU_BLOCKED_LABEL.fb_window_ends;
  assert.match(label, /FU/u);
  assert.match(title, /24 ชม\./u);
  assert.match(title, /Facebook/u);
});

test("สถานะคิวคน: แยกต้องตอบ คนตอบแล้ว และ AI ตอบต่อจากหลักฐานที่มี", () => {
  const now = 1_000_000;
  const base = { state: "NEEDS_HUMAN", ai_enabled: 1, last_inbound_at: now - 100, last_operator_outbound_at: 0 };

  assert.equal(humanQueueStatus(base, { now }).key, "needs_action",
    "ข้อความลูกค้าใหม่กว่า human reply ต้องขึ้นต้องตอบ แม้ AI ยังเปิด");
  assert.equal(humanQueueStatus({ ...base, last_operator_outbound_at: now - 50 }, { now }).key, "human_answered",
    "ต้องเรียกคนตอบแล้วได้เฉพาะเมื่อมีข้อความจากคนจริงหลังลูกค้าทัก");
  const staleAiReply = { ...base, last_outbound_at: now - 50 };
  assert.equal(humanQueueStatus(staleAiReply, { now }).key, "ai_continues",
    "ธงเก่าที่ AI ตอบแล้วต้องเป็นข้อมูล ไม่หลอกว่าเป็นหนี้ตอบของคน");
  assert.equal(waitingForHumanSince(staleAiReply), 0,
    "ป้ายเวลารอต้องใช้หลักฐานเดียวกับสถานะ AI ตอบต่อ");
  const freshAfterAi = { ...staleAiReply, last_inbound_at: now - 10 };
  assert.equal(humanQueueStatus(freshAfterAi, { now }).key, "needs_action",
    "ลูกค้าทักใหม่หลัง AI ตอบ ต้องกลับเป็นต้องตอบ");
  assert.equal(waitingForHumanSince(freshAfterAi), now - 10,
    "ลูกค้าทักใหม่หลัง AI ตอบต้องกลับขึ้นเวลารอ");
  assert.equal(humanQueueStatus({ ...staleAiReply, money_seen_at: now - 1 }, { now }).key, "needs_review",
    "สัญญาณเส้นเงินไม่ถูกกลบด้วย AI ตอบต่อ");
  assert.equal(humanQueueStatus({ ...base, last_inbound_at: 0 }, { now }).key, "ai_continues",
    "ธงแจ้งทีมที่ไม่มีหนี้ตอบและ AI เปิด ไม่อ้างว่าคนกำลังดูแล");
  assert.equal(humanQueueStatus({ ...base, last_inbound_at: 0, operator_active_until: now + 1 }, { now }).key, "ai_paused",
    "AI ที่พักชั่วคราวต้องระบุว่าต้องตรวจคนดูแล ไม่เดาว่ามีคนทำงานอยู่");
  assert.equal(humanQueueStatus({ ...base, ai_enabled: 0, last_inbound_at: 0 }, { now }).key, "owner_unknown",
    "AI ปิดอย่างเดียวไม่ใช่หลักฐานว่ามีคนรับช่วงแล้ว");
});

test("สถานะคิวคน: ห้องคำสัญญาค้างที่ AI_ACTIVE ยังเห็นว่าต้องติดตาม", () => {
  assert.equal(humanQueueStatus({ state: "AI_ACTIVE", ai_enabled: 1 }, { inNeedsQueue: true, now: 1 }).key,
    "needs_followup");
});

test("scroll keeper: เก็บ scrollTop=0 ทับค่ารอบเก่า ไม่ดึงผู้ใช้กลับตำแหน่งเดิม", () => {
  const kept = new Map();
  const oldContext = node(320, "customer:U1");
  captureScroll(root({ ".ctx-scroll": [oldContext] }), "#/c/U1", kept);
  oldContext.scrollTop = 0;
  captureScroll(root({ ".ctx-scroll": [oldContext] }), "#/c/U1", kept);
  const rebuilt = node(999, "customer:U1");
  restoreScroll(root({ ".ctx-scroll": [rebuilt] }), "#/c/U1", kept);
  assert.equal(rebuilt.scrollTop, 0);
});

test("scroll keeper: ไม่แชร์ตำแหน่งข้ามลูกค้าหรือข้ามหน้า", () => {
  const kept = new Map();
  captureScroll(root({
    ".ctx-scroll": [node(240, "customer:U1")],
    ".page-scroll": [node(500)],
  }), "#/c/U1", kept);
  const otherCustomer = node(12, "customer:U2");
  const settings = node(7);
  restoreScroll(root({ ".ctx-scroll": [otherCustomer], ".page-scroll": [settings] }), "#/settings", kept);
  assert.equal(otherCustomer.scrollTop, 12);
  assert.equal(settings.scrollTop, 7);
});

test("scroll keeper: หน้า overview มี scope จริงและคืนตำแหน่งหลัง re-render", () => {
  const kept = new Map();
  captureScroll(root({ ".page-scroll": [node(640)] }), "#/", kept);
  const rebuilt = node(0);
  restoreScroll(root({ ".page-scroll": [rebuilt] }), "#/", kept);
  assert.equal(rebuilt.scrollTop, 640);
});

test("broadcast segments: state แยกต่อ OA และ tag เดียวสลับ include/exclude ได้ทันที", () => {
  const store = createBroadcastSegmentStore();
  store.toggle("oa-a", "include", "VIP");
  assert.deepEqual(store.snapshot("oa-a"), { channelId: "oa-a", includeTags: ["VIP"], excludeTags: [] });
  store.toggle("oa-a", "exclude", "VIP");
  assert.deepEqual(store.snapshot("oa-a"), { channelId: "oa-a", includeTags: [], excludeTags: ["VIP"] });
  assert.deepEqual(store.snapshot("oa-b"), { channelId: "oa-b", includeTags: [], excludeTags: [] });
  assert.deepEqual(store.snapshot("oa-a").excludeTags, ["VIP"], "สลับกลับ OA เดิมต้องจำ draft ของ OA นั้น");
});

test("broadcast segments: tag ที่ไม่มีใน OA ปัจจุบันถูก sanitize ก่อน preview/send", () => {
  const store = createBroadcastSegmentStore();
  store.toggle("oa-a", "include", "VIP");
  store.toggle("oa-a", "exclude", "เก่า");
  store.sanitize("oa-a", ["VIP", "ใหม่"]);
  assert.deepEqual(store.snapshot("oa-a"), { channelId: "oa-a", includeTags: ["VIP"], excludeTags: [] });
});

test("broadcast send gate: ต้องมี include, ข้อความ, preview ล่าสุด และห้ามส่งซ้อน", () => {
  const ready = {
    includeCount: 1,
    messageCount: 2,
    preview: {
      count: 10, loading: false, segmentKey: "segment-a",
      currentSegmentKey: "segment-a", messageCount: 2,
      quota: { type: "unlimited" }, audienceConfirmation: "preview-token",
    },
  };
  assert.equal(broadcastCanSend(ready), true);
  assert.equal(broadcastCanSend({ ...ready, includeCount: 0 }), false);
  assert.equal(broadcastCanSend({ ...ready, messageCount: 0 }), false);
  assert.equal(broadcastCanSend({ ...ready, sending: true }), false);
  assert.equal(broadcastCanSend({ ...ready, preview: { ...ready.preview, overAudienceCap: true } }), false);
  assert.equal(broadcastCanSend({ ...ready, preview: { ...ready.preview, segmentKey: "stale" } }), false);
  assert.equal(broadcastCanSend({ ...ready, preview: { ...ready.preview, messageCount: 1 } }), false);
});

test("broadcast quarantine review: typed confirmation ผูก exact id และคำตัดสิน", () => {
  assert.equal(
    quarantineResolutionConfirmationText("q-123", "confirmed_delivered"),
    "RESOLVE:q-123:confirmed_delivered",
  );
  assert.notEqual(
    quarantineResolutionConfirmationText("q-123", "confirmed_delivered"),
    quarantineResolutionConfirmationText("q-123", "confirmed_not_delivered"),
  );
  assert.notEqual(
    quarantineResolutionConfirmationText("q-123", "confirmed_delivered"),
    quarantineResolutionConfirmationText("q-456", "confirmed_delivered"),
  );
});

test("broadcast schedule UI: ปิด scheduler แล้วยังเห็นรายการ/ยกเลิกได้ แต่สร้างใหม่ไม่ได้", () => {
  assert.deepEqual(
    broadcastScheduleUiMode({ canSend: true, schedulingEnabled: false }),
    { visible: true, canCreate: false },
  );
  assert.deepEqual(
    broadcastScheduleUiMode({ canSend: true, schedulingEnabled: true }),
    { visible: true, canCreate: true },
  );
  assert.deepEqual(
    broadcastScheduleUiMode({ canSend: false, schedulingEnabled: true }),
    { visible: false, canCreate: false },
  );
});

test("inbox load-more: ล็อก channel/filter/query ตอนยิง request และทิ้งผลเมื่อสลับ OA กลางทาง", async () => {
  const state = {
    channel: "oa-a",
    routeGen: 4,
    inbox: { filter: "hot", q: "vip", extra: [], hasMore: true },
  };
  let requested = "";
  let resolveRequest;
  let rerenders = 0;
  const pending = new Promise((resolve) => { resolveRequest = resolve; });
  const pane = createConvoPane({
    state,
    toast: () => assert.fail("stale response ต้องไม่ toast"),
    api: (path) => {
      requested = path;
      return pending;
    },
  });

  const load = pane.loadMore(async () => { rerenders += 1; });
  const query = new URL(requested, "https://console.test").searchParams;
  assert.equal(query.get("channel"), "oa-a");
  assert.equal(query.get("segment"), "hot");
  assert.equal(query.get("q"), "vip");
  assert.equal(query.get("deep"), "1", "UI ต้อค้นประวัติแชททั้งหมดเมื่อคำค้นยาวอย่างน้อย 2 ตัว");

  const requestScope = captureInboxLoadScope(state);
  state.channel = "oa-b";
  assert.equal(isInboxLoadScopeCurrent(state, requestScope), false);
  resolveRequest({ conversations: [{ line_user_id: "from-oa-a" }], hasMore: false });
  await load;

  assert.deepEqual(state.inbox.extra, [], "แถว OA เก่าห้ามปน OA ใหม่");
  assert.equal(rerenders, 0, "stale response ห้ามสั่ง render ซ้ำ");
});

test("chat load-older: scope เก่าหมดสิทธิ์ทันทีเมื่อ route หรือ state.chat เปลี่ยนห้อง", () => {
  const chatA = { id: "A", head: [], older: [] };
  const state = { routeGen: 8, chat: chatA };
  const scope = captureChatLoadScope(state, "A");
  assert.equal(isChatLoadScopeCurrent(state, scope), true);

  state.routeGen += 1;
  state.chat = { id: "B", head: [], older: [] };
  assert.equal(isChatLoadScopeCurrent(state, scope), false, "response ห้อง A ห้ามเขียนทับห้อง B");
  assert.equal(applyOlderPageIfCurrent(state, scope, {
    messages: [{ id: "old-A" }], hasMoreOlder: false,
  }), false);
  assert.deepEqual(state.chat.older, [], "ข้อความเก่าของ A ห้ามปน state ห้อง B");

  state.chat = { id: "A", head: [], older: [] };
  assert.equal(isChatLoadScopeCurrent(state, scope), false, "กลับห้อง A ใหม่ก็ห้ามรับ request จาก state เก่า");
});

test("broadcast history: แยกคนถูกตัดสิทธิ์ก่อนส่งออกจาก LINE failure", () => {
  assert.equal(broadcastSkippedCount({
    status: "done", audience_count: 152, sent_count: 148, failed_count: 1,
  }), 3);
  assert.equal(broadcastSkippedCount({
    status: "sending", audience_count: 152, sent_count: 20, failed_count: 0,
  }), 0, "ระหว่างส่ง ส่วนที่ยังไม่ประมวลผลไม่ใช่ skipped");
});
