// console-overview-ceo — หน้าภาพรวมแบบ CEO + หน้าผลงาน + หน้า Intro เรนเดอร์จริงด้วย DOM จำลอง (28 ก.ย. 2026)
// เป้าหมาย: ลูกแพรพูดเรื่องที่เสียเงินที่สุดก่อน, รายชื่อเงินรั่วกดเข้าห้องได้ทันที,
// ตัวเลขเงินระดับบริษัทไม่หลุดถึงจอพนักงาน และหน้าใหม่ไม่โยน error
import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./console-dom.mjs";

const OWNER_CAPS = ["operations.use", "knowledge.manage", "finance.view", "integrations.manage"];
const STAFF_CAPS = ["operations.use", "knowledge.manage"];
const DAY = 86_400_000;

const bodyText = (doc) => JSON.stringify(doc.body, (key, value) => (key === "parent" ? undefined : value));
function findAll(node, predicate, out = []) {
  for (const child of node.children || []) {
    if (child?.nodeType !== 1) continue;
    if (predicate(child)) out.push(child);
    findAll(child, predicate, out);
  }
  return out;
}

function attentionPayload(now = Date.now()) {
  const room = (id, name, extra) => ({
    id, name, pictureUrl: "", channelId: "default", channelName: "LINE", score: 9, value: "hot",
    aiOn: false, owner: "", preview: "สนใจคอนซัลแบบรายเดือนค่ะ", ...extra,
  });
  return {
    ok: true, generatedAt: now, windowDays: 30, hotQuietDays: [1, 7],
    waiting: {
      total: 7, oldestWaitMs: 11 * DAY,
      rooms: [
        room("U-money", "วิภา · ร้านเบเกอรี่", { value: "money", score: 6, since: now - DAY, waitMs: DAY }),
        room("U-hot", "ชนิดา · อสังหาฯ", { since: now - 11 * DAY, waitMs: 11 * DAY }),
        ...Array.from({ length: 5 }, (_, i) => room(`U-${i}`, `ลูกค้า ${i}`, { value: "other", score: 3, since: now - DAY, waitMs: DAY })),
      ],
    },
    // 3 พ.ย. 2026: คีย์ hotQuiet = ไม้ต่อจากลูกแพร (สถานะตามเวลาทำการ + อัตราต่อทัน 3/6 ชม.)
    hotQuiet: {
      total: 1, overdue: 1, due: 0, ontrack: 0,
      rooms: [room("U-quiet", "คุณเอ · ขนส่ง", {
        lastAt: now - 5 * DAY, silentMs: 5 * DAY, aiReplies: 3, teamTalkedBefore: true,
        relayStatus: "overdue", workElapsedMs: 9 * 3_600_000,
      })],
      teamRate: { windowDays: 7, relay: { decided: 20, touched: 3, within3Pct: 10, within6Pct: 15 } },
    },
  };
}

async function renderOverview(t, { capabilities = OWNER_CAPS, theme = "lukprae", attention = attentionPayload(), aiPaused = false } = {}) {
  const { doc } = installBrowserGlobals(t, { hash: "#/" });
  if (theme === "lukprae") doc.documentElement.classList.add("theme-lukprae");
  const { createOverviewPage } = await import("../public/console/overview.mjs");
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.startsWith("/console/api/overview/attention")) {
      if (attention instanceof Error) throw attention;
      return attention;
    }
    if (path.startsWith("/console/api/overview")) {
      return {
        ok: true,
        stats: { inboundToday: 33, activeCustomersToday: 32, newCustomersToday: 4, needsHuman: 2, hotCustomers: 12 },
        orders: { todayCount: 2, monthRevenue: 83300, monthConfirmedCount: 4, openDrafts: 1 },
        quota: null, quotas: null, series: [{ day: "2026-09-27", inbound: 12 }, { day: "2026-09-28", inbound: 20 }],
        channel: null, aiCost: null, followupGlobal: true, followupAppointmentArmed: true,
        roomsAwaitingLegacyConfirm: 0, roomsAwaitingLegacyConfirmList: [], lastInboundAt: Date.now() - 7 * 60_000,
        aiPaused, canary: { enabled: false, status: "off" },
      };
    }
    if (path.startsWith("/console/api/inbox")) return { ok: true, conversations: [], counts: { all: 109, cold: 84, warm: 13, hot: 12, needs: 2 } };
    if (path.startsWith("/console/api/kpi")) {
      return {
        ok: true, window: { days: 7, attributionStartMs: 0 }, holidays: [],
        speed: { workingDays: { ai: { medianMs: 13_000, count: 9 }, human: { medianMs: 420_000, count: 4 } }, all: {}, workingHours: {} },
        backlog: { total: 3, waitingForHuman: 1 }, closing: { hybrid: { ratePct: 20, closed: 1, rooms: 5 }, fullyAi: { ratePct: 10, closed: 1, rooms: 10 } },
        days: { excluded: [] },
      };
    }
    if (path.startsWith("/console/api/roas")) {
      return { ok: true, window: { days: 30 }, missing: [], costs: { adsThb: 1, aiThb: 1, lineThb: 1, miscThb: 0 }, line: {}, roas: 3.5, profitThb: 70000, revenueThb: 100000 };
    }
    return { ok: true };
  };
  await createOverviewPage({
    api, toast: () => {},
    mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: (title) => Object.assign(doc.createElement("header"), { textContent: title }),
    tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {},
    state: {
      me: { username: "owner", displayName: "พี่ง้วง", role: "owner", capabilities },
      branding: { name: "พี่ง้วง - ติดกระดุม", mark: "พง", agent: "ลูกแพร AI", theme },
      channels: [], channel: null, routeGen: 0, features: {}, pollTimer: null,
    },
  })();
  return { doc, text: bodyText(doc), calls };
}

test("ภาพรวม CEO: ลูกแพรพูดเรื่องลูกค้ารอนานก่อน พร้อมหน้าตกใจ และรายชื่อกดเข้าห้องได้ทันที", async (t) => {
  const { doc, text, calls } = await renderOverview(t);
  assert.ok(calls.some((p) => p.startsWith("/console/api/overview/attention")));
  assert.match(text, /มีลูกค้ารอคนตอบ 7 ห้อง นานสุด 11 วันค่ะ/u);
  const mood = findAll(doc.body, (n) => n.tagName === "img" && /\/mood\/surprised\.webp$/u.test(n.attributes.src || ""));
  assert.equal(mood.length, 1, "หน้าลูกแพรต้องเป็นสีหน้าตกใจเมื่อมีคนรอนาน");
  // เรียงตามที่ API ส่งมา (เงินก่อน) โชว์ 5 ห้องแรก + ปุ่มดูเพิ่ม
  const rows = findAll(doc.body, (n) => n.tagName === "a" && n._classes().has("ov-q-row"));
  // 28 ก.ย. 2026 (พี่ง้วง): แถวรอตอบพาเข้าหน้าแชทแบบคิวรอตอบ — ชิปรอตอบเปิดค้าง ห้องนั้นเปิดอยู่
  assert.equal(rows[0].attributes.href, "#/chat/waiting/U-money");
  // 30 ก.ย. 2026: แถวลูกค้าร้อนพาเข้าคิว "รอทีมทักต่อ" ในหน้าแชท (พิมพ์คุยเสร็จ ห้องถัดไปเปิดเอง)
  assert.ok(rows.some((n) => n.attributes.href === "#/chat/hotfollow/U-quiet"), "ลูกค้าร้อนที่รอทีมทักต่อต้องกดเข้าห้องในคิวได้");
  assert.match(text, /ไล่ต่อทีละห้องในหน้าแชท/u);
  assert.match(text, /ลูกค้ารอคนตอบตอนนี้/u);
  // 29 ก.ย. 2026: ชื่อเดิม "ยังไม่มีคนทัก" ผิดความหมาย (ลูกแพรตอบห้องเหล่านี้แล้ว) · 3 พ.ย. 2026: เป็น "ไม้ต่อจากลูกแพร"
  assert.match(text, /ไม้ต่อจากลูกแพร — ถึงตาทีมคุยต่อ/u);
  assert.match(text, /1 ห้อง · เกินเวลา 1 · ควรต่อแล้ว 0 · ยังทัน 0/u);
  assert.match(text, /เกินเวลาแล้ว · 9\u00a0ชม\./u, "สถานะตามเวลาทำการหลังลูกแพรจบ");
  assert.doesNotMatch(text, /ยังไม่มีคนทัก/u);
  // ทีมต่อทันกี่ % (เป้า 3 ชม. เส้นตาย 6 ชม.) + ห้องที่เคยคุยกับทีมแล้วบอกไว้บนแถว
  assert.match(text, /ทีมต่อทัน 6 ชม\. 15% · ทัน 3 ชม\. 10% \(ต่อแล้ว 3\/20 ไม้ · 7 วัน\)/u);
  assert.match(text, /เคยคุยกับทีมแล้ว · รอบล่าสุด ลูกแพรตอบ \+ ทักตามแล้ว 3 ข้อความ/u);
  assert.match(text, /ดูอีก 2 ห้อง/u);
  assert.match(text, /วันนี้คุยกับลูกค้า/u);
  assert.match(text, /3\.50x/u, "เจ้าของเห็นแถบ ROAS บรรทัดเดียว");
});

test("ภาพรวม CEO: กดดูเพิ่มแล้วรายชื่อกางในหน้าเดิม ไม่ยิงเซิร์ฟเวอร์ใหม่", async (t) => {
  const { doc, calls } = await renderOverview(t);
  const before = calls.length;
  const more = findAll(doc.body, (n) => n.tagName === "button" && n._classes().has("ov-more"))[0];
  assert.ok(more);
  more.dispatch("click");
  const waitingSection = findAll(doc.body, (n) => n.attributes?.id === "ov-waiting")[0];
  const rows = findAll(waitingSection, (n) => n.tagName === "a" && n._classes().has("ov-q-row"));
  assert.equal(rows.length, 7);
  assert.equal(calls.length, before);
});

test("ภาพรวม CEO ของพนักงาน: เห็นเงินรั่วครบ แต่ไม่มี ROAS/กำไร", async (t) => {
  const { text, calls } = await renderOverview(t, { capabilities: STAFF_CAPS });
  assert.ok(!calls.some((p) => p.startsWith("/console/api/roas")));
  assert.doesNotMatch(text, /ROAS|กำไร/u);
  assert.match(text, /ลูกค้ารอคนตอบตอนนี้/u);
});

test("ภาพรวม CEO: ลูกแพรถูกพักทั้งระบบ = ทำปากยื่นและบอกตรง ๆ แม้มีคนรอ", async (t) => {
  const { doc, text } = await renderOverview(t, { aiPaused: true });
  assert.match(text, /ถูกพักการตอบทั้งระบบ/u);
  assert.ok(findAll(doc.body, (n) => n.tagName === "img" && /\/mood\/pout\.webp$/u.test(n.attributes.src || "")).length === 1);
  assert.match(text, /พักอยู่/u);
});

test("ภาพรวม CEO: เส้นรายชื่อพัง = บอกว่าอ่านไม่ได้ ไม่ใช่บอกว่าไม่มีใครรอ", async (t) => {
  const { text } = await renderOverview(t, { attention: new Error("500") });
  assert.match(text, /ยังอ่านรายชื่อไม่ได้ในรอบนี้/u);
  assert.doesNotMatch(text, /ไม่มีลูกค้าค้างรอคำตอบค่ะ/u);
});

test("ภาพรวม CEO instance อื่น: ไม่มีภาพลูกแพร ใช้ตรายี่ห้อของตัวเองแทน", async (t) => {
  const { doc } = await renderOverview(t, { theme: "airdog" });
  assert.equal(findAll(doc.body, (n) => n.tagName === "img" && /\/mood\//u.test(n.attributes.src || "")).length, 0);
  assert.equal(findAll(doc.body, (n) => n._classes().has("ov-mark")).length, 1);
});

test("สีหน้าลูกแพรเลือกเรื่องที่เสียเงินที่สุดก่อน และระยะเวลาไม่ตัดบรรทัดกลางตัวเลข", async () => {
  const { pickMood, spanLabel, greetingFor } = await import("../public/console/overviewCeo.mjs");
  assert.equal(pickMood({ aiPaused: true, waiting: 5, oldestWaitMs: DAY }).mood, "pout");
  assert.equal(pickMood({ suspectSlips: 1, waiting: 5, oldestWaitMs: DAY }).mood, "surprised");
  assert.equal(pickMood({ waiting: 2, oldestWaitMs: 45 * 60_000 }).mood, "surprised");
  assert.equal(pickMood({ waiting: 2, oldestWaitMs: 5 * 60_000 }).mood, "thinking");
  assert.equal(pickMood({ hotQuiet: 3 }).mood, "thinking");
  assert.equal(pickMood({ ordersToday: 1 }).mood, "wink");
  assert.equal(pickMood({}).mood, "smile");
  assert.equal(spanLabel(11 * DAY), "11 วัน");
  assert.equal(spanLabel(3 * 3_600_000), "3 ชม.");
  assert.match(greetingFor(Date.parse("2026-09-28T02:00:00Z"), "พี่ง้วง"), /^สวัสดีตอนเช้าค่ะ พี่ง้วง$/u);
});

test("หน้าผลงาน: ภาพสรุปสามเรื่องมาก่อนตาราง และ 0% ไม่วาดจุดหลอกบนวงแหวน", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/kpi" });
  const { createKpiPage } = await import("../public/console/kpi.mjs");
  const bucket = (key, label, rooms) => ({ key, label, rooms });
  const entry = (medianMs, count) => ({ medianMs, p90Ms: medianMs * 2, count });
  const api = async () => ({
    ok: true, window: { days: 30, attributionStartMs: Date.now() - 20 * DAY }, holidays: [],
    speed: { all: { ai: entry(24_000, 89), human: entry(480_000, 19) }, workingHours: { ai: entry(16_000, 20), human: entry(720_000, 7) }, workingDays: { ai: entry(13_000, 7), human: entry(420_000, 4) } },
    days: { counted: 9, excluded: [] },
    backlog: { total: 3, waitingForHuman: 1, excluded: { maxAgeHours: 48, endedRooms: 0, hashtagRooms: 0 }, top: [],
      buckets: [bucket("under30m", "ไม่เกิน 30 นาที", 2), bucket("under2h", "30 นาที – 2 ชม.", 1), bucket("under8h", "2 – 8 ชม.", 0), bucket("over8h", "เกิน 8 ชม.", 0)] },
    closing: { hybrid: { rooms: 16, closed: 0, ratePct: 0 }, fullyAi: { rooms: 22, closed: 3, ratePct: 13.6 }, humanOnlyRooms: 1, humanOnlyClosed: 0, noReplyRooms: 0 },
    totals: { rooms: 39, inboundTurns: 108 },
  });
  await createKpiPage({
    api, mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"),
    stopPolling: () => {}, setView: () => {}, state: { me: { capabilities: [] } },
  })();
  const text = bodyText(doc);
  assert.ok(text.indexOf("ใครตอบเร็วแค่ไหน") < text.indexOf("① ความเร็วในการตอบ"), "ภาพสรุปต้องมาก่อนตาราง");
  assert.match(text, /ลูกค้ารอคำตอบตอนนี้/u);
  const rings = findAll(doc.body, (n) => n._classes().has("kv-ring"));
  assert.equal(rings.length, 2);
  // วงแหวนเป็น SVG (setAttribute("class")) — DOM จำลองเก็บคลาสไว้ใน attributes
  const ringValue = (n) => n.attributes?.class === "kv-ring-value";
  assert.equal(findAll(rings[0], ringValue).length, 0, "0% = วงว่างจริง");
  assert.equal(findAll(rings[1], ringValue).length, 1);
  assert.ok(rings[0]._classes().has("is-thin"), "16 ห้องยังน้อย ต้องมีป้ายตัวอย่างน้อย");
});

test("หน้า Intro: ยังไม่มีวิดีโอ = กรอบรอที่ตั้งใจ, มีวิดีโอ = <video> เล่นได้, น้องฝนยังไม่ใช้ภาพตัวละคร", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/intro" });
  doc.documentElement.classList.add("theme-lukprae");
  const { createIntroPage } = await import("../public/console/intro.mjs");
  const state = { introMedia: { video: false, poster: false } };
  const deps = {
    mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"),
    stopPolling: () => {}, setView: () => {}, state,
  };
  await createIntroPage(deps)();
  let text = bodyText(doc);
  assert.match(text, /อินโทร 60 วินาที กำลังมาเร็ว ๆ นี้/u);
  assert.equal(findAll(doc.body, (n) => n.tagName === "video").length, 0);
  for (const name of ["ลูกแพร", "น้องเก้า", "น้องฝน", "พี่สาวคนโต", "คนกลาง", "คนเล็ก"]) assert.match(text, new RegExp(name, "u"));
  const fon = findAll(doc.body, (n) => n._classes().has("is-nongfon"))[0];
  assert.equal(findAll(fon, (n) => n.tagName === "img").length, 0, "ภาพน้องฝนยังรออนุมัติ — ใช้ลายหยดฝนแทน");
  state.introMedia = { video: true, poster: false };
  await createIntroPage(deps)();
  const video = findAll(doc.body, (n) => n.tagName === "video")[0];
  assert.ok(video, "มีไฟล์แล้วต้องเล่นได้ทันที");
  assert.equal(video.attributes.poster, undefined, "ไม่มีภาพปกก็ไม่ใส่ poster ที่จะได้ 404");
  assert.equal(findAll(video, (n) => n.tagName === "source")[0].attributes.src, "/console/static/brand/lukprae/intro/lukprae-universe-intro.mp4");
  text = bodyText(doc);
  assert.match(text, /อินโทร 60 วินาที · จักรวาลลูกแพร/u);
});
