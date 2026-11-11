// chat-poll-regression.test.mjs — guard การ refresh ห้องแชทขณะ operator ใช้ฟอร์ม
import test from "node:test";
import assert from "node:assert/strict";

import { refreshChatIfReady, shouldDeferChatRefresh } from "../public/console/chat.mjs";
import { readFileSync } from "node:fs";

function input({ value = "", classes = [] } = {}) {
  return {
    value,
    classList: { contains: (name) => classes.includes(name) },
  };
}

function documentStub({ replyInput = null, activeElement = null, visibilityState = "visible", workspace = true, composerBusy = false } = {}) {
  return {
    activeElement,
    visibilityState,
    querySelector(selector) {
      if (selector === ".reply-input") return replyInput;
      if (selector === ".chat-workspace") return workspace ? {} : null;
      if (selector === ".reply-bar.is-busy") return composerBusy ? {} : null;
      return null;
    },
  };
}

test("chat poll: ช่องตอบว่างแม้ยัง focus ต้อง refresh เพื่อเห็นลูกค้าและ AI รอบถัดไป", () => {
  const replyInput = input({ value: "   " });
  assert.equal(shouldDeferChatRefresh({ replyInput, activeElement: replyInput }), false);
});

test("chat poll: ร่างคำตอบที่ยังไม่ส่งต้องพัก full refresh เพื่อไม่ทำข้อความหาย", () => {
  const replyInput = input({ value: "กำลังพิมพ์ตอบ" });
  assert.equal(shouldDeferChatRefresh({ replyInput, activeElement: replyInput }), true);
});

test("chat poll: ฟอร์มย่อย keep-focus ที่กำลังแก้ต้องพัก full refresh", () => {
  const replyInput = input();
  const protectedInput = input({ classes: ["keep-focus"] });
  assert.equal(shouldDeferChatRefresh({ replyInput, activeElement: protectedInput }), true);
});

test("chat poll: ไม่มี draft และไม่ได้แก้ฟอร์มต้อง refresh ตามปกติ", () => {
  assert.equal(shouldDeferChatRefresh({ replyInput: null, activeElement: null }), false);
});

// v1.4.13 (audit จับ): ระหว่างอัปโหลด/ส่งรูป ถ้า re-render ทับ ชิป+ปุ่มจะกลายเป็น DOM
// ที่ถูกถอดแล้ว = รูปล่องหนแต่ยังถูกส่งจริง / ปุ่มส่งกลับมากดได้ = ลูกค้าได้สองชุด
test("chat poll: กำลังอัปโหลด/ส่งรูป (reply-bar.is-busy) ต้องพัก full refresh แม้ช่องตอบว่าง", () => {
  assert.equal(shouldDeferChatRefresh({ replyInput: input(), activeElement: null, composerBusy: true }), true);
});

test("chat poll lifecycle: reply-bar ติดธง busy -> timer ต้องไม่ render ทับช่องตอบ", async () => {
  let calls = 0;
  const refreshed = await refreshChatIfReady({
    documentRef: documentStub({ replyInput: input(), composerBusy: true }),
    render: async () => { calls += 1; },
    customerId: "customer-scratch",
  });
  assert.equal(refreshed, false);
  assert.equal(calls, 0, "ห้าม render ระหว่างมีงานค้างในช่องตอบ");
});

test("chat poll lifecycle: timer ต้องเรียก render เมื่อช่องตอบว่างแต่ยัง focus", async () => {
  const replyInput = input();
  const calls = [];
  const refreshed = await refreshChatIfReady({
    documentRef: documentStub({ replyInput, activeElement: replyInput }),
    render: async (args) => calls.push(args),
    customerId: "customer-scratch",
    filter: "hot",
  });

  assert.equal(refreshed, true);
  assert.deepEqual(calls, [{ customerId: "customer-scratch", filter: "hot", poll: true, listOnly: false }]);
});

test("chat poll lifecycle: visibilitychange ต้อง refresh ทันทีเมื่อกลับมาและช่องตอบว่าง", async () => {
  const replyInput = input({ value: "   " });
  let calls = 0;
  const refreshed = await refreshChatIfReady({
    documentRef: documentStub({ replyInput, activeElement: replyInput, visibilityState: "visible", workspace: true }),
    render: async () => { calls += 1; },
    customerId: "customer-scratch",
    requireVisible: true,
    requireWorkspace: true,
  });

  assert.equal(refreshed, true);
  assert.equal(calls, 1);
});

test("chat poll lifecycle: keep-focus/แท็บซ่อน/ไม่มี workspace ยังต้องกัน render ทั้งหมด", async () => {
  const cases = [
    documentStub({ replyInput: input(), activeElement: input({ classes: ["keep-focus"] }) }),
    documentStub({ replyInput: input(), visibilityState: "hidden" }),
    documentStub({ replyInput: input(), workspace: false }),
  ];
  let calls = 0;
  for (const documentRef of cases) {
    const refreshed = await refreshChatIfReady({
      documentRef,
      render: async () => { calls += 1; },
      requireVisible: true,
      requireWorkspace: true,
    });
    assert.equal(refreshed, false);
  }
  assert.equal(calls, 0);
});

// audit 2026-08-26 (วิกฤต): เดิม "มีข้อความพิมพ์ค้าง" = หยุดอัปเดตทั้งหน้าเงียบ ๆ
// พิมพ์ค้างไว้แล้วไปทำอย่างอื่น 25 นาที = ลูกค้าคนอื่นทักเข้ามาแล้วไม่ขึ้นสักคน
// หน้าจอดูเงียบเหมือนไม่มีใครทัก และไม่มีอะไรบอกว่าหยุดอัปเดตอยู่
test("chat poll: ร่างที่ยังไม่ส่งต้องอัปเดตรายการซ้ายต่อ แต่ห้าม rebuild ห้อง", async () => {
  const calls = [];
  const refreshed = await refreshChatIfReady({
    documentRef: documentStub({ replyInput: input({ value: "กำลังพิมพ์ตอบ" }) }),
    render: async (args) => calls.push(args),
    customerId: "customer-typing",
  });
  assert.equal(refreshed, true, "ต้องยัง refresh เพื่อให้เห็นลูกค้าที่ทักเข้ามาใหม่");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].listOnly, true, "ต้องเป็นโหมดรายการอย่างเดียว ห้ามสร้างห้องใหม่ทับกล่องพิมพ์");
});

test("chat poll: กำลังส่งอยู่จริงต้องไม่แตะอะไรเลย แม้จะเป็นโหมดรายการ", async () => {
  let calls = 0;
  const refreshed = await refreshChatIfReady({
    documentRef: documentStub({ replyInput: input({ value: "ข้อความ" }), composerBusy: true }),
    render: async () => { calls += 1; },
    customerId: "customer-sending",
  });
  assert.equal(refreshed, false);
  assert.equal(calls, 0);
});

// audit 2026-08-26 (วิกฤตที่สุด): ข้อความที่พิมพ์ค้างเคยถูกกู้ "ข้ามห้อง"
// ตอนกดสลับห้อง DOM ยังเป็นห้องเก่า ตัวกู้จึงหยิบข้อความของลูกค้าคนก่อนมาใส่กล่องของคนใหม่
// สถานการณ์จริง: พิมพ์เลขบัญชีกับยอดเงินให้ลูกค้า ก. ค้างไว้ แล้วกดดูห้องลูกค้า ข.
// ข้อความนั้นโผล่ในกล่องของ ข. ดูเหมือนตัวเองพิมพ์ค้างไว้ พอกดส่ง = เลขบัญชีไปผิดคน
// LINE เรียกข้อความคืนไม่ได้
test("chat draft: โค้ดกู้ข้อความค้างต้องผูกกับห้อง ไม่ใช่หยิบอะไรก็ได้ที่อยู่ในหน้า", () => {
  const source = readFileSync(new URL("../public/console/chat.mjs", import.meta.url), "utf8");
  // กล่องพิมพ์ต้องประทับรหัสห้องไว้ เพื่อให้รู้ว่าข้อความที่ค้างเป็นของใคร
  assert.match(source, /"data-room":\s*String\(customerId/u, "กล่องพิมพ์ต้องรู้ว่าตัวเองเป็นของห้องไหน");
  // เก็บแยกตามห้อง
  assert.match(source, /state\.chatDrafts\.set\(/u);
  // กู้ต้องอ่านจากกระเป๋าของห้องปัจจุบันเท่านั้น
  assert.match(source, /state\.chatDrafts\.get\(String\(customerId\)\)/u);
  // ต้องไม่มีการกู้จากตัวแปรที่หยิบมาจาก DOM ตรง ๆ อีก
  assert.doesNotMatch(source, /textarea\.value\s*=\s*draftCarried/u,
    "ห้ามกู้จากข้อความที่หยิบมาจาก DOM โดยไม่เช็คว่าเป็นห้องเดียวกัน");
  // ส่งสำเร็จแล้วต้องล้างกระเป๋า ไม่งั้นข้อความที่ส่งไปแล้วจะเด้งกลับมา
  assert.match(source, /state\.chatDrafts\.delete\(String\(customerId\)\)/u);
});
