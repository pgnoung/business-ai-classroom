// owner-lessons-ui.test.mjs — เรนเดอร์กล่อง "สอนลูกแพร" ในแผงทำไมตอบแบบนี้ และหน้า #/lessons
// ด้วย DOM จำลอง (เหตุผลเดียวกับ teach-ui.test.mjs: node --check ไม่เห็น ReferenceError)
//
// สิ่งที่กัน:
//   1. กดบันทึกแล้วอยู่หน้าเดิม และพิมพ์ข้อความที่เซิร์ฟเวอร์บอก (ใช้ทันที / รออนุมัติ) ไม่ใช่เดาเอง
//   2. ห้องแชท re-render ทั้งห้อง — แผงที่กางอยู่ต้องกางต่อ และสิ่งที่พิมพ์ค้างต้องไม่หาย
//   3. แผงที่กางพร้อมกันหลายฟองต้องไม่แย่งค่ากัน (คลาส keep-focus ต้องไม่ซ้ำกันข้ามข้อความ)
//   4. หน้า #/lessons วาดปุ่มตามสิทธิ์ และไม่มีอะไรบังคับความกว้างที่ 375 px
//   5. ไฟล์ใหม่ไม่มี inline style (CSP style-src 'self') และช่องพิมพ์ตั้งสีเองสำหรับธีมมืด
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installBrowserGlobals } from "./console-dom.mjs";

const textOf = (node) => JSON.stringify(node, (key, value) => (key === "parent" ? undefined : value));
async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

const WHY = {
  messageId: "m-ai-1", at: 1_790_000_000_000,
  route: { answeredBy: "AI", operator: "", agentMode: "ai", messageClass: "reactive" },
  unknown: ["ระบบไม่รู้ว่าโมเดลหยิบการ์ดใบไหนไปใช้"],
  brain: { known: false, label: "อ่านจากตารางเดิม", why: "ปกติค่ะ", sources: [] },
};

function lessonsPayload(overrides = {}) {
  return {
    canTeach: true, canApprove: true, teachable: true, paused: false,
    used: [
      { id: "l1", title: "ที่จอดรถ", status: "active", missing: false },
      { id: "l2", title: "", status: "deleted", missing: true },
    ],
    taughtHere: [], suggestedTopic: "มีที่จอดรถไหม", limits: { teaching: 600, topic: 60 },
    ...overrides,
  };
}

function whyApi({ lessons = lessonsPayload(), saveResult = null, saveError = null } = {}) {
  const calls = [];
  let current = lessons;
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith("/console/api/teach/why")) return { ok: true, why: WHY, lessons: current };
    if (path === "/console/api/lessons" && options.method === "POST") {
      if (saveError) throw new Error(saveError);
      current = { ...current, taughtHere: [{ id: "l9", title: options.body.topic || "ใหม่", teaching: options.body.teaching, status: saveResult?.status || "active" }] };
      return saveResult ?? { ok: true, status: "active", message: "บันทึกแล้ว — ลูกแพรจะใช้กับเรื่องคล้ายกันตั้งแต่ข้อความถัดไป" };
    }
    return { ok: true };
  };
  return { api, calls };
}

async function openPanel(doc, api, id = "m-ai-1") {
  const { whyPanel } = await import("../public/console/whyPanel.mjs");
  const panel = whyPanel({ api, message: { id } });
  doc.body.replaceChildren(panel);
  panel.open = true;
  panel.dispatch("toggle");
  await flush();
  return panel;
}

/* --------------------------- กล่องสอนในแผงทำไมตอบแบบนี้ --------------------------- */

test("แผง: บอกบทเรียนที่เทิร์นนี้ใช้ + กล่องสอนพร้อมหัวข้อที่เดาให้ + ทางรองไปจอสอนแบบละเอียด", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/c/U-fixture" });
  const { api } = whyApi();
  const panel = await openPanel(doc, api);
  const text = textOf(panel);
  assert.match(text, /ใช้บทเรียน /u);
  assert.match(text, /2 เรื่อง/u);
  assert.match(text, /ที่จอดรถ · \(บทเรียนที่ถูกลบไปแล้ว\)/u);
  const topic = panel.querySelector(".why-lesson-topic");
  const input = panel.querySelector(".why-lesson-input");
  assert.equal(topic.value, "มีที่จอดรถไหม", "หัวข้อเติมให้จากคำถามของลูกค้า");
  assert.equal(input.getAttribute("placeholder"), "สอนลูกแพร: เรื่องแบบนี้ควรตอบยังไง / อะไรที่ไม่ควรพูด");
  assert.equal(input.getAttribute("maxlength"), "600");
  assert.equal(panel.querySelector(".why-lesson-save").disabled, true, "ยังไม่พิมพ์ = กดบันทึกไม่ได้");
  const deep = panel.querySelector(".why-teach");
  assert.equal(deep.getAttribute("href"), "#/teach/message/m-ai-1");
  assert.match(textOf(deep), /สอนแบบละเอียด \(เป็นความรู้ถาวร\)/u);
  assert.equal(panel.querySelector(".why-lessons-link").getAttribute("href"), "#/lessons");
  assert.doesNotMatch(text, /บทเรียนของทีมจะเริ่มใช้หลังพี่ง้วงอนุมัติ/u, "เจ้าของไม่ต้องเห็นคำเตือนรออนุมัติ");
});

test("แผง: เจ้าของกดบันทึก = อยู่หน้าเดิม ขึ้นข้อความจากเซิร์ฟเวอร์ ล้างช่อง และโชว์ว่าสอนจากข้อความนี้แล้ว", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/c/U-fixture" });
  const { api, calls } = whyApi();
  const panel = await openPanel(doc, api);
  const input = panel.querySelector(".why-lesson-input");
  input.value = "บอกว่าจอดได้ที่อาคารเรียน แล้วถามว่ามากี่ท่าน";
  input.dispatch("input");
  assert.equal(panel.querySelector(".why-lesson-save").disabled, false);
  panel.querySelector(".why-lesson-save").dispatch("click");
  await flush();
  const post = calls.find((call) => call.options.method === "POST");
  assert.deepEqual(post.options.body, { messageId: "m-ai-1", teaching: "บอกว่าจอดได้ที่อาคารเรียน แล้วถามว่ามากี่ท่าน", topic: "มีที่จอดรถไหม" });
  const status = panel.querySelector(".why-lesson-status");
  assert.equal(status.textContent, "บันทึกแล้ว — ลูกแพรจะใช้กับเรื่องคล้ายกันตั้งแต่ข้อความถัดไป");
  assert.ok(status.className.includes("is-active"));
  assert.equal(panel.querySelector(".why-lesson-input").value, "", "บันทึกแล้วช่องต้องว่างพร้อมสอนเรื่องถัดไป");
  assert.equal(calls.filter((call) => call.path.startsWith("/console/api/teach/why")).length, 2, "ดึงแผงใหม่หลังบันทึก");
  assert.match(textOf(panel), /บอกว่าจอดได้ที่อาคารเรียน แล้วถามว่ามากี่ท่าน/u, "สิ่งที่เพิ่งสอนต้องขึ้นในรายการของข้อความนี้");
  assert.ok(!calls.some((call) => call.path.startsWith("#/")), "ไม่มีการเปลี่ยนหน้า");
});

test("แผง: ทีมงานบันทึก = ขึ้นว่าส่งให้พี่ง้วงอนุมัติแล้ว และมีคำอธิบายว่ายังไม่ใช้จนกว่าจะอนุมัติ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/c/U-fixture" });
  const { api } = whyApi({
    lessons: lessonsPayload({ canApprove: false, used: [] }),
    saveResult: { ok: true, status: "pending", message: "ส่งให้พี่ง้วงอนุมัติแล้ว" },
  });
  const panel = await openPanel(doc, api);
  assert.match(textOf(panel), /บทเรียนของทีมจะเริ่มใช้หลังพี่ง้วงอนุมัติ/u);
  assert.doesNotMatch(textOf(panel), /ใช้บทเรียน /u, "เทิร์นที่ไม่ได้ใช้บทเรียน ไม่พิมพ์บรรทัดนี้เลย");
  const input = panel.querySelector(".why-lesson-input");
  input.value = "ชวนดูรีวิวก่อนบอกราคา";
  input.dispatch("input");
  panel.querySelector(".why-lesson-save").dispatch("click");
  await flush();
  const status = panel.querySelector(".why-lesson-status");
  assert.equal(status.textContent, "ส่งให้พี่ง้วงอนุมัติแล้ว");
  assert.ok(status.className.includes("is-pending"));
});

test("แผง: บันทึกไม่สำเร็จ = บอกเหตุผลจากเซิร์ฟเวอร์ ข้อความที่พิมพ์ยังอยู่ และกดใหม่ได้", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/c/U-fixture" });
  const { api } = whyApi({ saveError: "บทเรียนมีชื่อลูกค้าห้องนี้" });
  const panel = await openPanel(doc, api);
  const input = panel.querySelector(".why-lesson-input");
  input.value = "ข้อความทดสอบ";
  input.dispatch("input");
  panel.querySelector(".why-lesson-save").dispatch("click");
  await flush();
  assert.equal(panel.querySelector(".why-lesson-status").textContent, "บทเรียนมีชื่อลูกค้าห้องนี้");
  assert.equal(panel.querySelector(".why-lesson-input").value, "ข้อความทดสอบ");
  assert.equal(panel.querySelector(".why-lesson-save").disabled, false);
});

test("แผง: ห้องแชทสร้างฟองใหม่ = แผงกางต่อ ข้อความที่พิมพ์ค้างไม่หาย และไม่ยิงเส้นซ้ำ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/c/U-fixture" });
  const { api, calls } = whyApi();
  const first = await openPanel(doc, api);
  const input = first.querySelector(".why-lesson-input");
  input.value = "ยังพิมพ์ไม่เสร็จ";
  input.dispatch("input");
  const topic = first.querySelector(".why-lesson-topic");
  topic.value = "หัวข้อที่แก้เอง";
  topic.dispatch("input");
  const before = calls.length;

  const { whyPanel } = await import("../public/console/whyPanel.mjs");
  const rebuilt = whyPanel({ api, message: { id: "m-ai-1" } }); // เหมือน renderChat สร้างฟองใหม่ทั้งห้อง
  assert.equal(rebuilt.open, true, "แผงที่กางอยู่ต้องกางต่อหลัง re-render");
  assert.equal(rebuilt.querySelector(".why-lesson-input").value, "ยังพิมพ์ไม่เสร็จ");
  assert.equal(rebuilt.querySelector(".why-lesson-topic").value, "หัวข้อที่แก้เอง");
  assert.equal(calls.length, before, "วาดจากผลรอบก่อน ไม่ยิงเส้นใหม่ทุกครั้งที่ห้อง re-render");

  const other = whyPanel({ api, message: { id: "m-ai-2" } });
  assert.equal(other.open, undefined, "ฟองอื่นต้องไม่กางตาม");
  const classA = rebuilt.querySelector(".why-lesson-input").className;
  other.open = true;
  other.dispatch("toggle");
  await flush();
  const classB = other.querySelector(".why-lesson-input").className;
  assert.ok(classA.includes("keep-focus") && classB.includes("keep-focus"), "พิมพ์อยู่ = poll ต้องพัก");
  assert.notEqual(classA, classB, "คลาสต้องไม่ซ้ำข้ามข้อความ ไม่งั้นตัวกู้ค่าของห้องแชทจะยัดข้อความผิดฟอง");
  assert.equal(other.querySelector(".why-lesson-input").value, "", "ฟองอื่นเริ่มจากช่องว่าง");

  // ห้องที่มีคำตอบของ AI เป็นร้อยฟอง: วาดใหม่ทั้งห้องต้องไม่ดันความจำของแผงที่กำลังพิมพ์ตกไป
  for (let i = 0; i < 150; i += 1) whyPanel({ api, message: { id: `m-bulk-${i}` } });
  const again = whyPanel({ api, message: { id: "m-ai-1" } });
  assert.equal(again.open, true);
  assert.equal(again.querySelector(".why-lesson-input").value, "ยังพิมพ์ไม่เสร็จ");
});

test("แผง: ไม่มีสิทธิ์สอน / ข้อความที่สอนไม่ได้ = ไม่มีกล่องสอน แต่ส่วนอื่นของแผงอยู่ครบ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/c/U-fixture" });
  for (const lessons of [{ canTeach: false, used: [] }, lessonsPayload({ teachable: false })]) {
    const { api } = whyApi({ lessons });
    const panel = await openPanel(doc, api, `m-${Math.random()}`);
    assert.equal(panel.querySelector(".why-lesson"), null);
    assert.match(textOf(panel), /อ่านจากตารางเดิม/u);
  }
  const { whyNodes } = await import("../public/console/whyPanel.mjs");
  const legacy = doc.createElement("div");
  legacy.replaceChildren(...whyNodes(WHY, { messageId: "m-old" })); // ผู้เรียกเดิมที่ไม่รู้จักบทเรียน
  assert.equal(legacy.querySelector(".why-lesson"), null);
  assert.equal(legacy.querySelector(".why-teach").getAttribute("href"), "#/teach/message/m-old");
});

/* ---------------------------------- หน้า #/lessons ---------------------------------- */

function lessonRow(overrides = {}) {
  return {
    id: "l-1", title: "ที่จอดรถ", topic: "ที่จอดรถ", teaching: "บอกว่าจอดได้ที่อาคารเรียน", customerText: "มีที่จอดรถไหมคะ",
    aiText: "มีค่ะ", status: "active", channelId: null, createdBy: "ngoung", createdByName: "พี่ง้วง",
    decidedBy: "ngoung", createdAt: Date.now() - 3_600_000, updatedAt: Date.now(), decidedAt: Date.now(),
    useCount: 12, lastUsedAt: Date.now() - 60_000, sourceMessageId: "m-1", customerId: "U-fixture", ...overrides,
  };
}

function pageDeps(doc, payload) {
  const calls = [];
  const toasts = [];
  const api = async (path, options = {}) => {
    calls.push({ path, options });
    if (path.startsWith("/console/api/lessons") && !options.method) return payload;
    return { ok: true };
  };
  return {
    calls, toasts,
    deps: {
      api, toast: (message) => toasts.push(message),
      mount: (...nodes) => doc.body.replaceChildren(...nodes.flat(Infinity).filter(Boolean)),
      pageHeader: (title) => { const node = doc.createElement("header"); node.textContent = title; return node; },
      tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {},
      state: { me: { role: "owner" }, features: { lessons: true } },
    },
  };
}

function listPayload(overrides = {}) {
  return {
    ok: true, canApprove: true, username: "ngoung", paused: false, hasMore: false, offset: 0,
    counts: { all: 3, active: 1, pending: 1, disabled: 1 },
    channels: [{ id: "default", name: "OA หลัก" }], limits: { teaching: 600, topic: 60 },
    lessons: [
      lessonRow(),
      lessonRow({ id: "l-2", title: "รีวิว", teaching: "ชวนดูรีวิวก่อน", status: "pending", createdBy: "chompoo", createdByName: "ชมพู่", useCount: 0, lastUsedAt: null }),
      lessonRow({ id: "l-3", title: "น้ำเสียง", teaching: "ห้ามพูดว่าจัดให้", status: "disabled", customerText: "", aiText: "", customerId: "" }),
    ],
    ...overrides,
  };
}

const buttonsIn = (node) => node.querySelectorAll("button").map((button) => textOf(button).replace(/^.*"textContent":"([^"]*)".*$/u, "$1"));

test("หน้าบทเรียน (เจ้าของ): สถานะ/การใช้/ต้นเรื่อง ครบ และปุ่มตามสถานะ", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/lessons" });
  const { createLessonsPage } = await import("../public/console/lessons.mjs");
  const { deps, calls } = pageDeps(doc, listPayload());
  await createLessonsPage(deps)();
  const text = textOf(doc.body);
  for (const expected of ["บทเรียนที่สอนลูกแพร", "ลูกแพรใช้บทเรียนตอนตอบอยู่", "หยุดใช้ชั่วคราว", "ทั้งหมด", "รออนุมัติ",
    "ลูกแพรใช้แล้ว 12 ครั้ง", "เปิดห้องแชทต้นเรื่อง", "ไม่มีข้อความต้นเรื่อง", "ใช้ทุกช่องทาง"]) {
    assert.ok(text.includes(expected), `ต้องมี "${expected}"`);
  }
  const cards = doc.body.querySelectorAll(".lesson-card");
  assert.equal(cards.length, 3);
  assert.ok(cards[0].className.includes("is-active") && cards[1].className.includes("is-pending"));
  const pendingText = textOf(cards[1]);
  assert.match(pendingText, /อนุมัติ/u);
  assert.match(pendingText, /ไม่อนุมัติ/u);
  assert.match(textOf(cards[0]), /ปิดใช้/u);
  assert.match(textOf(cards[2]), /เปิดใช้/u);
  const approve = cards[1].querySelectorAll("button").find((button) => textOf(button).includes("\"อนุมัติ\""));
  approve.dispatch("click");
  await flush();
  assert.ok(calls.some((call) => call.path === "/console/api/lessons/l-2/approve" && call.options.method === "POST"));
});

test("หน้าบทเรียน (ทีมงาน): ไม่มีปุ่มของเจ้าของ แก้/ถอนได้เฉพาะคำขอของตัวเอง", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/lessons" });
  const { createLessonsPage } = await import("../public/console/lessons.mjs");
  const payload = listPayload({
    canApprove: false, username: "chompoo", paused: true, counts: { all: 2, active: 1, pending: 1, disabled: 0 },
    lessons: [lessonRow(), lessonRow({ id: "l-2", title: "รีวิว", status: "pending", createdBy: "chompoo" })],
  });
  const { deps } = pageDeps(doc, payload);
  await createLessonsPage(deps)();
  const text = textOf(doc.body);
  assert.doesNotMatch(text, /หยุดใช้ชั่วคราว|กลับมาใช้บทเรียน/u, "ทีมงานไม่เห็นสวิตช์ของเจ้าของ");
  assert.match(text, /ตอนนี้พี่ง้วงหยุดใช้บทเรียนชั่วคราว/u);
  const [active, mine] = doc.body.querySelectorAll(".lesson-card");
  assert.equal(active.querySelectorAll("button").length, 0, "บทเรียนที่ใช้อยู่เป็นของเจ้าของ ไม่มีปุ่มให้ทีมงาน");
  assert.match(textOf(mine), /ถอนคำขอ/u);
  assert.match(textOf(mine), /แก้ไข/u);
  assert.doesNotMatch(textOf(mine), /"อนุมัติ"/u);
});

test("หน้าบทเรียน: แก้ไขในที่ แล้วส่งค่าที่แก้ไปเซิร์ฟเวอร์", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/lessons" });
  const { createLessonsPage } = await import("../public/console/lessons.mjs");
  const payload = listPayload({ channels: [{ id: "default", name: "OA หลัก" }, { id: "cnx", name: "OA เชียงใหม่" }] });
  const { deps, calls } = pageDeps(doc, payload);
  await createLessonsPage(deps)();
  const card = doc.body.querySelectorAll(".lesson-card")[0];
  card.querySelectorAll("button").find((button) => textOf(button).includes("แก้ไข")).dispatch("click");
  await flush();
  const editing = doc.body.querySelector(".lesson-card.is-editing");
  assert.ok(editing, "ต้องเข้าโหมดแก้ไขในการ์ดเดิม");
  editing.querySelector(".lesson-edit-teaching").value = "บอกว่าจอดได้ที่อาคาร B";
  editing.querySelector(".lesson-edit-scope").value = "cnx";
  editing.querySelectorAll("button").find((button) => textOf(button).includes("บันทึก")).dispatch("click");
  await flush();
  const save = calls.find((call) => call.path === "/console/api/lessons/l-1" && call.options.method === "POST");
  assert.deepEqual(save.options.body, { topic: "ที่จอดรถ", teaching: "บอกว่าจอดได้ที่อาคาร B", channelId: "cnx" });
});

test("หน้าบทเรียน: ว่าง = บอกวิธีสอนจากห้องแชท", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/lessons" });
  const { createLessonsPage } = await import("../public/console/lessons.mjs");
  const { deps } = pageDeps(doc, listPayload({ lessons: [], counts: { all: 0, active: 0, pending: 0, disabled: 0 } }));
  await createLessonsPage(deps)();
  assert.match(textOf(doc.body), /ยังไม่มีบทเรียน/u);
  assert.match(textOf(doc.body), /กด \\"ทำไมตอบแบบนี้\\" ใต้คำตอบของลูกแพร/u);
});

/* ------------------------------- มือถือ + CSP + ธีมมืด ------------------------------- */

function fixedWidthOffenders(node, out = []) {
  for (const child of node.children || []) {
    if (child?.nodeType !== 1) continue;
    if (child.getAttribute?.("style")) out.push(`${child.tagName} style=${child.getAttribute("style")}`);
    if (child.tagName === "table") out.push("table");
    fixedWidthOffenders(child, out);
  }
  return out;
}

test("มือถือ 375 px: แผงสอนและหน้าบทเรียนไม่มี inline style หรือตารางที่บังคับความกว้าง", async (t) => {
  const { doc, window } = installBrowserGlobals(t, { hash: "#/lessons" });
  window.innerWidth = 375;
  const { api } = whyApi();
  const panel = await openPanel(doc, api, "m-mobile");
  assert.deepEqual(fixedWidthOffenders(panel), []);
  const { createLessonsPage } = await import("../public/console/lessons.mjs");
  await createLessonsPage(pageDeps(doc, listPayload()).deps)();
  assert.deepEqual(fixedWidthOffenders(doc.body), []);
});

test("ไฟล์ใหม่ของคอนโซล: ไม่มี inline style/innerHTML และช่องพิมพ์ตั้งสีเองสำหรับธีมมืด", () => {
  for (const file of ["whyPanel.mjs", "whyTeach.mjs", "lessons.mjs"]) {
    const source = readFileSync(new URL(`../public/console/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\.style\b|style\s*[:=]\s*["'`{]|innerHTML|insertAdjacentHTML/u, `${file} ห้ามมี inline style/HTML`);
  }
  const css = readFileSync(new URL("../public/console/lessons.css", import.meta.url), "utf8");
  const inputRule = css.match(/\.why-lesson-topic,[^{]*\{([^}]*)\}/u)?.[1] || "";
  assert.match(inputRule, /color:\s*var\(--ink\)/u);
  assert.match(inputRule, /background:\s*var\(--surface\)/u);
  assert.match(inputRule, /color-scheme/u);
  assert.match(css, /::placeholder\s*\{\s*color:\s*var\(--ink-3\)/u);
  const html = readFileSync(new URL("../public/console/index.html", import.meta.url), "utf8");
  assert.match(html, /<link rel="stylesheet" href="\/console\/static\/lessons\.css">/u);
});
