// console-role-ui-hiding — เรนเดอร์หน้าเว็บจริงด้วย DOM จำลอง เพื่อพิสูจน์ว่า
// พนักงานไม่เห็น "ปุ่มที่กดไม่ได้" และไม่เห็นแผงแดงที่ประกาศชื่อของที่กันไว้
//
// ย้ำให้ชัด: การซ่อนบนหน้าเว็บไม่ใช่การป้องกัน ด่านจริงอยู่ฝั่งเซิร์ฟเวอร์
// (owner-only-money-and-webhooks.test.mjs) ไฟล์นี้คุมเรื่องเดียว — จอของชมพู่ต้องสะอาด
// ไม่มีการ์ดเงิน ไม่มีกล่องต่อ webhook และไม่มีข้อความ error ที่บอกใบ้ว่ามีอะไรถูกกันไว้
import test from "node:test";
import assert from "node:assert/strict";
import { installBrowserGlobals } from "./console-dom.mjs";

// ชุดสิทธิ์จริงจาก operatorRoles.mjs (ตัดมาเฉพาะที่หน้าภาพรวม/ตั้งค่าใช้ตัดสินใจ)
const OWNER_CAPS = [
  "operations.use", "settings.manage", "knowledge.manage", "notifications.manage",
  "finance.view", "integrations.manage",
  // 2 ก.ย. 2026: สิทธิ์ "เผยแพร่ของที่เปลี่ยนสมองลูกแพร" — ราคา สมองต่อสาขา และกติกา
  "prices.manage", "brain.publish", "rules.manage",
  // Package K (วันเดียวกัน): คลังความรู้เป็นของเจ้าของด้วย + สิทธิ์กดอนุมัติคำขอของทีม
  "knowledge.publish", "publish.approve",
];
const STAFF_CAPS = ["operations.use", "settings.manage", "knowledge.manage", "notifications.manage"];

function overviewPayload() {
  return {
    ok: true,
    stats: { todayChats: 3, needsHuman: 1, hotCustomers: 1, totalCustomers: 10 },
    orders: { todayCount: 1, monthRevenue: 23800, monthConfirmedCount: 4, openDrafts: 0 },
    quota: { value: 15000, totalUsage: 1200, type: "limited" },
    quotas: null,
    series: [{ day: "2026-08-31", inbound: 12, outbound: 10, revenue: 100 }],
    channel: null,
    aiCost: {
      thbPerUsd: 40, fxSource: "env", fxFetchedAt: Date.now(),
      today: { thb: 67, usd: 1.6, tokensIn: 1000, tokensOut: 500, breakdown: [] },
      month: { thb: 1200, usd: 30, tokensIn: 20000, tokensOut: 9000, breakdown: [] },
    },
    followupGlobal: false, followupAppointmentArmed: true,
    roomsAwaitingLegacyConfirm: 0, roomsAwaitingLegacyConfirmList: [],
    lastInboundAt: Date.now() - 60000,
  };
}

// ต้องมี window และ missing ให้ครบ ไม่งั้น roasPanel จะ bail ไปวาด "แผงแดง" ตั้งแต่
// บรรทัดแรก (overview.mjs: if (!r?.ok || !r.window || !r.costs || !r.line ||
// !Array.isArray(r.missing))) แล้วเทสต์ฝั่งเจ้าของจะผ่านเพราะหัวข้อแผงแดงมีคำว่า ROAS
// อยู่ด้วย — กลายเป็น positive control ปลอมที่ไม่เคยเดินเข้าตัวแผงจริงเลยสักบรรทัด
function roasPayload() {
  return {
    ok: true, days: 30,
    window: { days: 30, sinceMs: 0, untilMs: null, date: null, monthStartMs: 0 },
    missing: [],
    revenueThb: 100000, totalCostThb: 30000, profitThb: 70000, roas: 3.5,
    revenueByChannel: { default: 100000 },
    costs: { adsThb: 20000, miscPercent: 0, miscThb: 0 },
    ads: {
      source: "manual", thb: 20000, daysWithData: 0, estimated: false,
      recent: [], ingestReady: true, ingestUrl: "https://example.invalid/webhooks/ads-spend",
    },
    line: { thb: 1000, ratePerMsg: 0.2, windowMsgsUsed: 5000, estimated: false, coverage: "window" },
    ai: { thb: 9000 },
    settings: {},
  };
}

// เรนเดอร์หน้าภาพรวมด้วยชุดสิทธิ์ที่กำหนด แล้วคืนข้อความทั้งหน้า + เส้นที่ถูกยิงจริง
async function renderOverview(t, capabilities) {
  const { doc } = installBrowserGlobals(t, { hash: "#/" });
  const { createOverviewPage } = await import("../public/console/overview.mjs");
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.startsWith("/console/api/overview")) return overviewPayload();
    if (path.startsWith("/console/api/roas")) return roasPayload();
    if (path.startsWith("/console/api/kpi")) {
      return {
        ok: true,
        window: { days: 7, sinceMs: 0, nowMs: Date.now(), attributionStartMs: 0 },
        holidays: [],
        speed: {
          workingDays: { ai: { medianMs: 4000, count: 12 }, human: { medianMs: 90000, count: 5 } },
          all: {}, workingHours: {},
        },
        backlog: { total: 2, waitingForHuman: 1 },
        closing: {
          hybrid: { ratePct: 40, closed: 2, rooms: 5 },
          fullyAi: { ratePct: 20, closed: 1, rooms: 5 },
        },
        days: { excluded: [] },
      };
    }
    return { ok: true };
  };
  await createOverviewPage({
    api,
    toast: () => {},
    mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: (title) => { const n = doc.createElement("header"); n.textContent = title; return n; },
    tabBar: () => doc.createElement("nav"),
    stopPolling: () => {},
    setView: () => {},
    state: {
      me: { username: "u", role: "x", capabilities },
      csrf: "t", branding: { name: "พี่ง้วง" }, channels: [], channel: null,
      pollTimer: null, routeGen: 0, features: {},
      ui: { exportOpen: false },
    },
  })();
  const text = JSON.stringify(doc.body, (key, value) => (key === "parent" ? undefined : value));
  return { text, calls };
}

test("หน้าภาพรวม: เจ้าของยังเห็นการ์ดเงินครบเหมือนเดิม", async (t) => {
  const { text, calls } = await renderOverview(t, OWNER_CAPS);
  assert.ok(calls.some((p) => p.startsWith("/console/api/roas")), "เจ้าของต้องยังยิงเส้น ROAS");
  // ต้องพิสูจน์ว่าแผงตัวจริงเรนเดอร์ ไม่ใช่แผงแดง — ไม่งั้น assert ฝั่งพนักงานข้างล่าง
  // ไม่มี positive control และจะเขียวต่อไปแม้ roasPanel ตัวจริงพังทั้งอัน
  assert.doesNotMatch(text, /โหลดไม่สำเร็จ/u, "แผง ROAS ต้องเรนเดอร์ตัวจริง ไม่ใช่แผงแดง");
  assert.match(text, /3\.50x/u, "ตัวเลข ROAS ของจริงต้องขึ้นจอ");
  assert.match(text, /กำไร/u, "เจ้าของต้องเห็นกำไร");
  assert.match(text, /ค่าแอด/u, "เจ้าของต้องเห็นค่าแอด");
  assert.match(text, /กุญแจ/u, "เจ้าของต้องเห็นกล่องกุญแจให้ Make ยิงค่าแอด");
  assert.match(text, /ค่าใช้จ่าย AI/u, "การ์ดค่า AI ต้องอยู่");
});

test("หน้าภาพรวมของพนักงาน: ไม่มีการ์ดเงิน ไม่มีกล่องกุญแจ และไม่มีแผงแดงบอกใบ้", async (t) => {
  const { text, calls } = await renderOverview(t, STAFF_CAPS);

  assert.ok(!calls.some((p) => p.startsWith("/console/api/roas")),
    "ต้องไม่ยิงเส้น ROAS เลย — ยิงแล้วกลืน 403 จะได้แผงแดงประกาศชื่อฟีเจอร์ที่กันไว้");
  assert.doesNotMatch(text, /ROAS/u, "ห้ามมีคำว่า ROAS บนจอพนักงาน");
  assert.doesNotMatch(text, /กำไร/u, "ห้ามมีกำไร");
  assert.doesNotMatch(text, /ค่าแอด/u, "ห้ามมีค่าแอด");
  assert.doesNotMatch(text, /ค่าใช้จ่าย AI/u, "ห้ามมีการ์ดต้นทุน AI (รวมทรง 'ยังอ่านค่าไม่ได้')");
  assert.doesNotMatch(text, /กุญแจ/u, "ห้ามมีกล่องกุญแจให้ Make ยิงค่าแอด");
  assert.doesNotMatch(text, /โหลดไม่สำเร็จ/u, "ห้ามมีแผงแดงบอกว่ามีอะไรโหลดไม่ได้");

  // งานประจำวันต้องยังอยู่ครบ — กันเกินคือความล้มเหลวอีกแบบหนึ่ง
  assert.match(text, /ยอดขายเดือนนี้/u, "ยอดขายที่ชมพู่กรอกเองต้องยังเห็น");
  assert.match(text, /ออเดอร์วันนี้/u, "ออเดอร์วันนี้ต้องยังเห็น");
  assert.match(text, /เคสรอคน/u, "งานที่ต้องรีบตอบต้องยังเห็น");
});

/* ------------------------- หน้าตั้งค่า: กันเกินคือความล้มเหลวอีกแบบ ------------------------- */

// เรนเดอร์หน้าตั้งค่าจริงด้วยชุดสิทธิ์ที่กำหนด แล้วคืนข้อความทั้งหน้า + เส้นที่ถูกยิงจริง
async function renderSettings(t, capabilities) {
  const { doc } = installBrowserGlobals(t, { hash: "#/settings" });
  const { createSettingsPage } = await import("../public/console/settings.mjs");
  const calls = [];
  const canFinance = capabilities.includes("finance.view");
  const api = async (path) => {
    calls.push(path);
    if (path.startsWith("/console/api/settings/facebook")) {
      return {
        ok: true, enabled: true, liveSend: false,
        // เซิร์ฟเวอร์ตัด has* ออกให้คนที่ไม่มีสิทธิ์ต่อสาย — จำลองให้ตรงกับของจริง
        ...(canFinance ? { hasPageAccessToken: true, hasAppSecret: true, hasVerifyToken: true } : {}),
        knownCustomers: ["คุณเอ ร้านกาแฟ"],
      };
    }
    if (path.startsWith("/console/api/settings/notify")) {
      return { ok: true, channels: [{ id: "default", ids: [] }], envDefault: [], maxRecipients: 5 };
    }
    if (path.startsWith("/console/api/channels")) {
      return { ok: true, multi: false, channels: [{ id: "default", name: "OA หลัก", active: true }] };
    }
    // ของที่ "เผยแพร่แล้วเปลี่ยนสมองลูกแพร" — ต้องมีค่าจริงทุกตัว ไม่งั้นบล็อกจะ bail
    // เป็น null แล้วเทสต์ฝั่งพนักงานจะเขียวเพราะบล็อกไม่ถูกวาดเลย (positive control ปลอม)
    if (path.startsWith("/console/api/prices")) {
      return { ok: true, prices: [{ label: "คอร์สหลัก", amount: 9900 }] };
    }
    if (path.startsWith("/console/api/settings/brain")) {
      return {
        ok: true, multi: false,
        channels: [{ id: "default", name: "OA หลัก", active: true, mode: "separate", addendum: "สาขาหลัก" }],
      };
    }
    if (path.startsWith("/console/api/settings/product-rules")) {
      return { ok: true, rules: "ห้ามขายซ้ำข้อเสนอเดิม", maxChars: 4000, tagSummary: [] };
    }
    if (path.startsWith("/console/api/settings/hashtag")) {
      return {
        ok: true, enabled: true, envDefault: false, runtimeOverride: "1",
        businessKeywords: { "#horeca": { seed: "สนใจคลาส AI", note: "งานสัมมนา" } },
        businessKeywordDefaults: {},
      };
    }
    if (path.startsWith("/console/api/settings/freeclass")) {
      return { ok: true, patterns: ["pngoung.com/p/free"] };
    }
    // Package K: คิวคำขอ — เซิร์ฟเวอร์กรองให้แล้วว่าใครเห็นอะไร หน้าเว็บอ่าน canApprove
    // K2: แผงเดียวยิงสองเส้น (pending / decided) mock ต้องแยกให้เหมือนของจริง ไม่งั้น
    // ประวัติจะกลายเป็นสำเนาของคิวที่ยังค้าง แล้วเทสต์จะเขียวทั้งที่หน้าเว็บวาดผิด
    if (path.startsWith("/console/api/publish-requests")) {
      const canApprove = capabilities.includes("publish.approve");
      if (path.includes("status=decided")) {
        return {
          ok: true,
          canApprove,
          pending: 1,
          requests: [{
            id: "req-0", kind: "price_add", method: "POST", route: ["prices"],
            body: { label: "คอร์สเสริม", amount: -5 },
            // ห้ามมีคำว่า "เพิ่มราคา"/"บันทึกกติกา" ในหัวข้อ — เทสต์ปุ่มของเจ้าของจับคำ
            // พวกนั้นทั้งหน้าอยู่ ประวัติที่บังเอิญมีคำเดียวกันจะทำให้เทสต์นั้นแดงแบบงง ๆ
            summary: "เสนอราคาใหม่ คอร์สเสริม",
            proposedBy: "chompoo", status: "failed",
            decidedBy: "ngoung", decidedAt: Date.now() - 3600000,
            decisionNote: "ยอดต้องมากกว่าศูนย์",
            result: { status: 400, error: "ยอดต้องมากกว่าศูนย์", payload: null },
            createdAt: Date.now() - 7200000,
          }],
        };
      }
      return {
        ok: true,
        canApprove,
        pending: 1,
        requests: [{
          id: "req-1", kind: "knowledge_add", method: "POST", route: ["knowledge"],
          body: { title: "โปรเดือนนี้", content: "รายละเอียดโปรโมชั่น" },
          // จงใจไม่มีอัญประกาศคู่: DOM จำลองถูกอ่านผ่าน JSON.stringify ซึ่ง escape " เป็น \"
          // แล้ว assert ด้วยสตริงดิบจะไม่มีวันเจอ (กับดักที่เสียเวลาไปแล้วหนึ่งรอบ)
          summary: "เสนอความรู้ใหม่ โปรเดือนนี้ 20 ตัวอักษร",
          proposedBy: "chompoo", status: "pending",
          decidedBy: "", decidedAt: null, decisionNote: "", result: null,
          createdAt: Date.now() - 60000,
        }],
      };
    }
    return { ok: true };
  };
  await createSettingsPage({
    api,
    toast: () => {},
    mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: (title) => { const n = doc.createElement("header"); n.textContent = title; return n; },
    tabBar: () => doc.createElement("nav"),
    stopPolling: () => {},
    setView: () => {},
    state: {
      me: { username: "u", role: "x", capabilities },
      csrf: "t", branding: { name: "พี่ง้วง" }, channels: [], channel: null,
      pollTimer: null, routeGen: 0, features: {}, ui: {},
    },
  })();
  const text = JSON.stringify(doc.body, (key, value) => (key === "parent" ? undefined : value));
  return { text, calls, doc };
}

test("หน้าตั้งค่าของพนักงาน: ไม่มีกล่องต่อสาย แต่ของที่ทีมต้องใช้ทุกวันต้องอยู่ครบ", async (t) => {
  const { text, calls } = await renderSettings(t, STAFF_CAPS);

  // ก. ของที่พี่ง้วงสั่งให้ซ่อน
  assert.ok(!calls.some((p) => p.startsWith("/console/api/models")), "ต้องไม่ยิงเส้นโมเดล/ราคาโมเดล");
  assert.ok(!calls.some((p) => p.startsWith("/console/api/settings/digest")), "ต้องไม่ยิงเส้นสรุปรายวันของเจ้าของ");
  assert.doesNotMatch(text, /Page Access Token/u, "ห้ามมีกล่องโทเคนเพจ");
  assert.doesNotMatch(text, /Verify Token/u, "ห้ามมีกล่อง verify token");
  assert.doesNotMatch(text, /ยังไม่เคยรับ webhook/u, "ห้ามมีสถานะการต่อ webhook ของ OA");

  // ข. ของที่เป็นงานหน้างานของทีม — กันไปด้วยคือพัง
  assert.match(text, /รายชื่อลูกค้าเก่า/u,
    "ลูกค้าเก่าทักเข้าเพจแล้วบอทต้องเงียบ — ชมพู่ต้องเติมชื่อเองได้");
  assert.match(text, /คุณเอ ร้านกาแฟ/u, "รายชื่อที่มีอยู่ต้องขึ้นให้เห็นด้วย ไม่ใช่กล่องเปล่า");
  assert.ok(calls.some((p) => p.startsWith("/console/api/settings/notify")),
    "ผู้รับแจ้งเตือน 'ลูกค้าขอคุยกับคน' เป็นของทีม ต้องยังโหลด");
});

test("หน้าตั้งค่าของเจ้าของ: กล่องต่อสายทั้งหมดต้องยังอยู่", async (t) => {
  const { text, calls } = await renderSettings(t, OWNER_CAPS);
  assert.ok(calls.some((p) => p.startsWith("/console/api/models")), "เจ้าของต้องยังยิงเส้นโมเดล");
  assert.match(text, /Page Access Token/u, "เจ้าของต้องยังเห็นกล่องโทเคนเพจ");
  assert.match(text, /รายชื่อลูกค้าเก่า/u, "เจ้าของต้องเห็นรายชื่อลูกค้าเก่าด้วย");
});

/* ---- สิทธิ์เผยแพร่ (2 ก.ย. 2026): อ่านได้ทุกคน กดเผยแพร่ได้คนเดียว ---- */

// ปุ่มที่มีเฉพาะในกล่อง "เผยแพร่" แต่ละกล่อง — ใช้เป็นตัวชี้วัดที่ไม่ชนกับปุ่มบล็อกอื่น
// (บนหน้าตั้งค่ามีคำว่า "บันทึก" อยู่หลายที่ ถ้าจับคำกว้าง ๆ เทสต์จะโกหกทั้งสองทาง)
const OWNER_PUBLISH_BUTTONS = [
  ["เพิ่มราคา", "ปุ่มเพิ่มรายการราคา"],
  ["บันทึกกติกา", "ปุ่มบันทึกกติกาสินค้า"],
  ["บันทึกข้อความเสริม", "ปุ่มบันทึกข้อความเสริมของสมองสาขา"],
];

const SUBMIT = "ส่งให้พี่ง้วงอนุมัติ";

test("หน้าตั้งค่าของพนักงาน: แก้ได้ทุกช่อง แต่ปุ่มเป็น 'ส่งให้พี่ง้วงอนุมัติ'", async (t) => {
  const { text, doc } = await renderSettings(t, STAFF_CAPS);

  // ก. ต้อง "ไม่ซ่อน" — ชมพู่เปิดดูราคาปัจจุบันระหว่างคุยกับลูกค้าอยู่ทุกวัน
  for (const [needle, why] of [
    ["ตารางราคา (guard)", "หัวข้อตารางราคา"],
    ["คอร์สหลัก", "ชื่อรายการราคาที่มีอยู่จริง"],
    ["9900", "ยอดปัจจุบันต้องอ่านได้"],
    ["กติกาสินค้า", "หัวข้อกติกาสินค้า"],
    ["ห้ามขายซ้ำข้อเสนอเดิม", "เนื้อกติกาปัจจุบัน"],
    ["สมอง AI ต่อ LINE OA", "หัวข้อสมองต่อสาขา"],
    ["คีย์เวิร์ดกิจกรรม", "หัวข้อคีย์เวิร์ด #"],
    ["ลิงก์คลาสฟรี", "หัวข้อลิงก์คลาสฟรี"],
  ]) {
    assert.ok(text.includes(needle), `${why} ต้องยังอยู่บนจอพนักงาน — ซ่อนไปเท่ากับทำงานไม่ได้`);
  }

  // ข. Package K: ปุ่มต้อง "มี" แต่บอกตรง ๆ ว่ากดแล้วกลายเป็นคำขอ
  // ปุ่มที่เขียนว่า "บันทึก" แต่จริง ๆ ส่งคำขอ = คนกดคิดว่าบันทึกแล้วแล้วเดินจากไป
  assert.ok(text.includes(SUBMIT), `ต้องมีปุ่ม "${SUBMIT}" บนจอพนักงาน`);
  for (const [label, why] of OWNER_PUBLISH_BUTTONS) {
    assert.ok(!text.includes(label), `${why} ต้องไม่ขึ้นคำเดิมบนจอพนักงาน (จะเข้าใจผิดว่าบันทึกแล้ว)`);
  }
  assert.ok(doc.querySelectorAll(".publish-request-hint").length >= 4,
    "ทุกกล่องที่กลายเป็นคำขอต้องมีบรรทัดบอกว่ายังไม่มีผลจนกว่าจะอนุมัติ");
  assert.ok(!text.includes("ส่งให้พี่ง้วงกดเผยแพร่"), "ข้อความล็อกของ Package C ต้องหายไปแล้ว");

  // ค. ช่องกรอกต้องพิมพ์ได้จริง — ไม่งั้นจะเสนออะไรไม่ได้เลย
  const amounts = doc.querySelectorAll(".price-amount");
  assert.ok(amounts.length >= 1, "ต้องยังเห็นช่องยอดของรายการที่มีอยู่");
  for (const input of amounts) assert.notEqual(input.disabled, true, "ช่องยอดราคาต้องพิมพ์ได้");
  assert.notEqual(doc.querySelector(".product-rules-input")?.disabled, true, "ช่องกติกาสินค้าต้องพิมพ์ได้");
  assert.notEqual(doc.querySelector(".ht-seed")?.disabled, true, "ช่องคีย์เวิร์ดกิจกรรมต้องพิมพ์ได้");
});

test("หน้าตั้งค่าของเจ้าของ: ปุ่มเผยแพร่ต้องอยู่ครบและกรอกได้ตามปกติ", async (t) => {
  const { text, doc } = await renderSettings(t, OWNER_CAPS);

  for (const [label, why] of OWNER_PUBLISH_BUTTONS) {
    assert.ok(text.includes(label), `${why} ต้องยังอยู่ให้เจ้าของกด`);
  }
  assert.ok(!text.includes(SUBMIT), "เจ้าของไม่ต้องเห็นปุ่มขออนุมัติ (ตัวเองคือปลายทาง)");
  assert.equal(doc.querySelectorAll(".publish-request-hint").length, 0, "เจ้าของต้องไม่มีบรรทัดขออนุมัติเลย");
  for (const input of doc.querySelectorAll(".price-amount")) {
    assert.notEqual(input.disabled, true, "ช่องยอดราคาของเจ้าของต้องยังพิมพ์ได้");
  }
});

/* ------------------- Package K: แผงคิวคำขออนุมัติ ------------------- */

test("หน้าตั้งค่าของเจ้าของ: มีแผงคำขอรออนุมัติพร้อมปุ่มอนุมัติ/ปฏิเสธ", async (t) => {
  const { text, doc } = await renderSettings(t, OWNER_CAPS);
  assert.ok(text.includes("คำขอรออนุมัติ"), "หัวข้อแผงคิวต้องอยู่");
  assert.ok(text.includes("เสนอความรู้ใหม่ โปรเดือนนี้"), "หัวข้อคำขอต้องอ่านรู้เรื่องโดยไม่ต้องเปิด JSON");
  assert.ok(text.includes("chompoo"), "ต้องบอกว่าใครเป็นคนเสนอ");
  assert.ok(text.includes("อนุมัติ") && text.includes("ปฏิเสธ"), "ต้องมีปุ่มตัดสินทั้งสองทาง");
  assert.ok(doc.querySelector(".pq-block"), "แผงคิวต้องถูกวาดจริง");
  assert.ok(doc.querySelector(".pq-note"), "ช่องเหตุผลของเจ้าของต้องมี");
});

test("หน้าตั้งค่าของพนักงาน: เห็นคำขอของตัวเองแบบอ่านอย่างเดียว ไม่มีปุ่มตัดสิน", async (t) => {
  const { text, doc } = await renderSettings(t, STAFF_CAPS);
  assert.ok(text.includes("คำขอของฉันที่รออนุมัติ"), "ทีมงานต้องรู้ว่าคำขอที่ส่งไปยังค้างอยู่");
  assert.ok(doc.querySelector(".pq-block"), "แผงคิวของทีมงานต้องถูกวาด");
  assert.equal(doc.querySelector(".pq-note"), null, "ทีมงานต้องไม่มีช่องเหตุผลของคนตัดสิน");
  // จับที่ "ปุ่ม" ไม่ใช่คำว่าปฏิเสธทั้งหน้า — K2 ทำให้ป้ายสถานะ "ปฏิเสธ" ขึ้นได้จริง
  // ในประวัติผลการตัดสิน การจับคำกว้าง ๆ จะกลายเป็นด่านที่ห้ามของที่ควรมี
  assert.equal(doc.querySelector(".pq-actions"), null, "ทีมงานต้องไม่มีแถบปุ่มตัดสินเลย");
  const buttons = doc.querySelectorAll("button").map((b) => b.children.map((c) => c.textContent).join(""));
  assert.ok(!buttons.includes("ปฏิเสธ"), "ทีมงานต้องไม่มีปุ่มปฏิเสธ (กดแล้วเด้ง 403)");
  assert.ok(!buttons.includes("อนุมัติ"), "ทีมงานต้องไม่มีปุ่มอนุมัติเช่นกัน");
});

/* ------------- K2: ผลการตัดสินล่าสุด ต้องกลับมาถึงตาคนเสนอ ------------- */

test("หน้าตั้งค่าของพนักงาน: ใบที่ทำรายการไม่สำเร็จต้องบอกสาเหตุ ไม่ใช่หายไปเงียบ ๆ", async (t) => {
  const { text, doc } = await renderSettings(t, STAFF_CAPS);

  const section = doc.querySelector(".pq-decided");
  assert.ok(section, "ต้องมีแผงผลการตัดสินล่าสุด");
  assert.equal(section.tagName, "details", "ต้องเป็น <details> เพื่อให้ยุบ/กางได้เอง");
  assert.equal(section.getAttribute("open"), null,
    "ต้องยุบไว้เป็นค่าเริ่มต้น — ประวัติห้ามบังคิวที่ยังต้องตัดสิน");
  assert.ok(text.includes("ผลการตัดสินล่าสุด"), "หัวข้อแผงต้องอ่านออกโดยไม่ต้องกาง");

  const card = doc.querySelector(".pq-decided-card");
  assert.ok(card, "ต้องมีการ์ดของใบที่ตัดสินแล้ว");
  // ค้นจากใต้การ์ดโดยตรง: DOM จำลองเทียบแค่ token สุดท้ายของ selector
  // ".pq-decided-card .badge" จึงกวาดป้ายทั้งหน้ามาด้วย (console-dom.mjs: matchesSelector)
  const chips = card.querySelectorAll(".badge")
    .map((n) => n.children.map((c) => c.textContent).join(""));
  assert.deepEqual(chips, ["ทำรายการไม่สำเร็จ"], "ป้ายสถานะต้องบอกตรง ๆ ว่าทำรายการไม่สำเร็จ");

  assert.ok(text.includes("ยอดต้องมากกว่าศูนย์"),
    "สาเหตุที่ทำไม่สำเร็จต้องขึ้นบนจอ ไม่ใช่ค้างอยู่ใน decision_note");
  assert.ok(text.includes("สาเหตุที่ทำไม่สำเร็จ"), "ต้องมีคำนำหน้าเป็นภาษาคน ไม่ใช่ชื่อสถานะดิบ");
  assert.ok(text.includes("แก้แล้วส่งใหม่ได้จากหน้าเดิม"), "ต้องบอกทางไปต่อ ไม่ใช่ทิ้งไว้ให้เดา");
  assert.ok(text.includes("ตัดสินโดย ngoung"), "ต้องรู้ว่าใครเป็นคนตัดสิน");

  // ของที่ต้องไม่เพี้ยน: ใบที่ยังรออนุมัติต้องไม่ถูกประวัติกลืน
  assert.ok(text.includes("เสนอความรู้ใหม่ โปรเดือนนี้"), "คำขอที่ยังค้างต้องยังอยู่ครบ");
});

test("หน้าตั้งค่าของเจ้าของ: เห็นผลการตัดสินย้อนหลังได้เหมือนกัน", async (t) => {
  const { text, doc } = await renderSettings(t, OWNER_CAPS);
  assert.ok(doc.querySelector(".pq-decided"), "เจ้าของต้องมีแผงผลการตัดสินด้วย");
  assert.ok(text.includes("ยอดต้องมากกว่าศูนย์"), "เจ้าของต้องย้อนดูเหตุผลที่ตัวเองเคยให้ไว้ได้");
  assert.ok(text.includes("โดย chompoo"), "เจ้าของต้องรู้ว่าใบนั้นใครเป็นคนเสนอ");
});

/* -------------------------- หน้าที่นั่ง (#/rounds) -------------------------- */

async function renderRounds(t, capabilities) {
  const { doc } = installBrowserGlobals(t, { hash: "#/rounds" });
  const { createRoundsPage } = await import("../public/console/rounds.mjs");
  const api = async () => ({
    ok: true,
    rounds: [{
      date: "2099-09-05", thai: "5 ก.ย. 2099", classKey: "basic",
      label: "Classroom AI Agent for Business",
      capacity: 15, enrolled: 7, seatsLeft: 8, overbooked: 0, unlimited: false,
    }],
  });
  await createRoundsPage({
    api,
    toast: () => {},
    mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: (title) => { const n = doc.createElement("header"); n.textContent = title; return n; },
    tabBar: () => doc.createElement("nav"),
    stopPolling: () => {},
    state: { me: { username: "u", role: "x", capabilities } },
  })();
  const text = JSON.stringify(doc.body, (key, value) => (key === "parent" ? undefined : value));
  return { text, doc };
}

test("หน้าที่นั่งของพนักงาน: กรอกที่นั่งได้เหมือนเดิม · เพิ่ม/ลบรอบกลายเป็นคำขอ", async (t) => {
  const { text, doc } = await renderRounds(t, STAFF_CAPS);

  // งานประจำวันต้องครบ — ชมพู่กรอกเลขนี้ระหว่างคุยกับลูกค้าอยู่ในอีกจอ
  const seat = doc.querySelector(".seat-input");
  assert.ok(seat, "ช่องกรอกจำนวนคนลงทะเบียนต้องยังอยู่");
  assert.notEqual(seat.disabled, true, "ช่องที่นั่งต้องยังพิมพ์ได้");
  assert.ok(text.includes("บันทึก"), "ปุ่มบันทึกที่นั่งต้องยังอยู่");
  assert.ok(text.includes("เหลือ 8 ที่"), "ตัวเลขที่นั่งต้องยังอ่านได้");

  // Package K: กรอกรอบใหม่ได้เต็มฟอร์ม แต่ปุ่มบอกตรง ๆ ว่ากดแล้วเป็นคำขอ
  assert.ok(text.includes("เพิ่มรอบเรียน"), "หัวข้อกล่องเพิ่มรอบต้องไม่ถูกซ่อน");
  assert.ok(!text.includes("เพิ่มรอบ\""), "ปุ่มต้องไม่เขียนว่า 'เพิ่มรอบ' เฉย ๆ (จะเข้าใจผิดว่าเพิ่มแล้ว)");
  assert.ok(text.includes(SUBMIT), "ปุ่มต้องบอกว่าเป็นการส่งขออนุมัติ");
  assert.ok(text.includes("ขอให้ลบ"), "ปุ่มลบรอบต้องยังมี แต่บอกว่าเป็นคำขอ");
  assert.ok(doc.querySelector(".publish-request-hint"), "ต้องมีบรรทัดบอกว่ายังไม่มีผลจนกว่าจะอนุมัติ");
  assert.notEqual(doc.querySelector(".round-add-row input")?.disabled, true, "ช่องกรอกรอบใหม่ต้องพิมพ์ได้");
});

test("หน้าที่นั่งของเจ้าของ: เพิ่มและลบรอบได้ครบเหมือนเดิม", async (t) => {
  const { text, doc } = await renderRounds(t, OWNER_CAPS);
  assert.ok(text.includes("เพิ่มรอบ\""), "ปุ่มเพิ่มรอบต้องอยู่");
  assert.ok(doc.querySelector(".btn-ghost"), "ปุ่มลบรอบต้องอยู่");
  assert.ok(!text.includes(SUBMIT), "เจ้าของไม่ต้องเห็นปุ่มขออนุมัติ");
  assert.equal(doc.querySelectorAll(".publish-request-hint").length, 0, "เจ้าของต้องไม่มีบรรทัดขออนุมัติ");
  assert.notEqual(doc.querySelector(".round-add-row input")?.disabled, true, "ช่องกรอกรอบใหม่ต้องพิมพ์ได้");
});

/* --------------------- หน้าคลังความรู้ (#/knowledge) --------------------- */

// Package K: คลังความรู้ต่อตรงเข้า system prompt — การ "เปลี่ยน" เป็นของเจ้าของ
// แต่ทีมงานต้องยังเปิดอ่านและเสนอได้ ไม่ใช่โดนกันทั้งหน้า
async function renderKnowledge(t, capabilities) {
  const { doc } = installBrowserGlobals(t, { hash: "#/knowledge" });
  const { createKnowledgePage } = await import("../public/console/knowledge.mjs");
  const api = async (path) => {
    if (path.startsWith("/console/api/knowledge")) {
      return {
        ok: true,
        knowledge: [{
          id: "k1", title: "คู่มือคลาส", content: "เนื้อหาคู่มือ", active: 1,
          channel_id: null, updated_by: "ngoung", updated_at: Date.now() - 60000,
        }],
      };
    }
    if (path.startsWith("/console/api/settings/brain")) return { ok: true, multi: false, channels: [] };
    if (path.startsWith("/console/api/brain")) {
      return {
        ok: true, brandPack: "", persona: "", safetyRules: [], approvedPrices: [], images: [],
        models: {}, knowledge: { total: 1, active: 1, injectedChars: 10, maxChars: 100, approxTokens: 3 },
      };
    }
    return { ok: true };
  };
  await createKnowledgePage({
    api,
    toast: () => {},
    mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: (title) => { const n = doc.createElement("header"); n.textContent = title; return n; },
    tabBar: () => doc.createElement("nav"),
    stopPolling: () => {},
    setView: () => {},
    state: { me: { username: "u", role: "x", capabilities } },
  })();
  return { text: JSON.stringify(doc.body, (key, value) => (key === "parent" ? undefined : value)), doc };
}

test("หน้าคลังความรู้ของพนักงาน: อ่านและกรอกได้ครบ แต่ปุ่มบอกว่าเป็นคำขอ", async (t) => {
  const { text, doc } = await renderKnowledge(t, STAFF_CAPS);
  assert.ok(text.includes("คู่มือคลาส"), "ความรู้ที่มีอยู่ต้องยังอ่านได้");
  assert.ok(text.includes(SUBMIT), `ปุ่มบันทึกต้องเปลี่ยนเป็น "${SUBMIT}"`);
  assert.ok(!text.includes("บันทึกความรู้"), "ห้ามเขียนว่าบันทึก ทั้งที่จริง ๆ เป็นการส่งคำขอ");
  assert.ok(doc.querySelector(".publish-request-hint"), "ต้องบอกว่ายังไม่มีผลจนกว่าจะอนุมัติ");
  assert.notEqual(doc.querySelector(".kn-content")?.disabled, true, "ช่องเนื้อหาต้องพิมพ์ได้");
});

test("หน้าคลังความรู้ของเจ้าของ: ปุ่มบันทึกเหมือนเดิม ไม่มีบรรทัดขออนุมัติ", async (t) => {
  const { text, doc } = await renderKnowledge(t, OWNER_CAPS);
  assert.ok(text.includes("บันทึกความรู้"), "เจ้าของต้องเห็นปุ่มบันทึกตามเดิม");
  assert.ok(!text.includes(SUBMIT), "เจ้าของไม่ต้องเห็นปุ่มขออนุมัติ");
  assert.equal(doc.querySelectorAll(".publish-request-hint").length, 0, "เจ้าของต้องไม่มีบรรทัดขออนุมัติ");
});
