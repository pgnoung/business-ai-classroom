// owner-chat-bridge — ข้อต่อ Telegram ของ "คุยกับลูกแพร": กำลังพิมพ์… ยิงซ้ำระหว่างรอและหยุดเสมอ (รวมตอนพัง)
// · ส่งหลายชิ้นแล้วชิ้นหนึ่งส่งไม่ถึง = หยุด ไม่ยิงชิ้นที่เหลือ · สมองแชทโยน error = ขอโทษอบอุ่นหนึ่งข้อความ
import test from "node:test";
import assert from "node:assert/strict";
import { createTelegramChatBridge, pendingHintText, TYPING_EVERY_MS } from "../src/telegramOwnerChat.mjs";
import { OWNER_CHAT_FALLBACK_TEXT } from "../src/ownerChat.mjs";
import { poisonGlobalFetch } from "./helpers.mjs";

poisonGlobalFetch();

function fakeClient({ failAt = 0 } = {}) {
  const calls = [];
  return {
    calls,
    sendChatAction: async (args) => { calls.push(["typing", args]); return { ok: true }; },
    sendMessage: async (args) => {
      calls.push(["send", args.text]);
      return { ok: calls.filter(([kind]) => kind === "send").length !== failAt };
    },
  };
}

test("กำลังพิมพ์…: ยิงทันที · ยิงซ้ำตามรอบ · หยุดแล้วไม่ยิงอีก", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const client = fakeClient();
  const bridge = createTelegramChatBridge({ ownerChat: null, client });
  const stop = bridge.startTyping(42);
  assert.equal(client.calls.length, 1);
  t.mock.timers.tick(TYPING_EVERY_MS * 2);
  assert.equal(client.calls.length, 3);
  stop();
  t.mock.timers.tick(TYPING_EVERY_MS * 3);
  assert.equal(client.calls.length, 3, "หยุดแล้วต้องเงียบ");
});

test("สมองแชทโยน error = ขอโทษอบอุ่นหนึ่งข้อความ ไม่ล้มเส้นคำสั่ง · ชิ้นส่งไม่ถึง = หยุดส่งชิ้นที่เหลือ", async () => {
  const client = fakeClient();
  const logs = [];
  const broken = createTelegramChatBridge({
    client, logger: { error: (m) => logs.push(m) },
    ownerChat: { enabled: () => true, reply: async () => { throw new TypeError("secret detail"); } },
  });
  const out = await broken.converse({ chatId: 1, owner: { userId: "9" }, text: "สวัสดี" });
  assert.deepEqual(out, { offer: null });
  assert.deepEqual(client.calls, [["send", OWNER_CHAT_FALLBACK_TEXT]]);
  assert.ok(!logs.join(" ").includes("secret detail"), "log แค่ชนิด error");
  assert.equal(broken.contextOpen(), false, "ตอบไม่สำเร็จ = ไม่นับว่ากำลังคุยกันอยู่");

  const failing = fakeClient({ failAt: 1 });
  const long = createTelegramChatBridge({
    client: failing, ownerChat: { enabled: () => true, reply: async () => ({ ok: true, text: `${"ก".repeat(3000)}\n\n${"ข".repeat(3000)}` }) },
  });
  await long.converse({ chatId: 1, owner: { userId: "9" }, text: "ยาว ๆ" });
  assert.equal(failing.calls.filter(([kind]) => kind === "send").length, 1, "ชิ้นแรกส่งไม่ถึง = ไม่ยิงชิ้นที่สอง");
  assert.equal(long.contextOpen(), true);
});

test("บอกลูกแพรว่ามีอะไรรอกดอยู่ (หมดอายุแล้ว = ไม่บอก)", () => {
  assert.equal(pendingHintText(null, 0), "");
  assert.equal(pendingHintText({ kind: "pick", expiresAt: 5 }, 10), "");
  assert.match(pendingHintText({ kind: "lesson", expiresAt: 50, lesson: { topic: "ที่จอดรถ" } }, 10), /บทเรียนรอพี่ง้วงกดยืนยันอยู่: "ที่จอดรถ"/u);
  assert.match(pendingHintText({ kind: "pick", expiresAt: 50 }, 10), /รอพี่ง้วงเลือกอยู่/u);
  assert.match(pendingHintText({ kind: "confirm", expiresAt: 50 }, 10), /คำสั่งรอพี่ง้วงกดยืนยัน/u);
});
