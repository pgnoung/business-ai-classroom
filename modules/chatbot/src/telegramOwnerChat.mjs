// telegramOwnerChat.mjs — ข้อต่อระหว่างช่อง Telegram ของเจ้าของกับ "คุยกับลูกแพร" (28 ก.ย. 2026)
//
// แยกจาก telegramControl.mjs (ไฟล์นั้นคุมความปลอดภัยของคำสั่ง: เจ้าของเท่านั้น, offset, ปุ่มใช้ครั้งเดียว)
// ไฟล์นี้ทำเฉพาะส่วนของการคุย:
//   · "กำลังพิมพ์…" ระหว่างรอ (Telegram ลบสถานะเองใน ~5 วิ จึงยิงซ้ำทุก 4.5 วิ จนกว่าจะตอบ)
//   · ส่งคำตอบที่ยาวเกินหนึ่งข้อความเป็นหลายข้อความ (splitTelegramText) แทนการตัดท้ายทิ้ง
//   · โมเดลล้ม/พังทุกแบบ = ข้อความขอโทษอบอุ่นหนึ่งข้อความ (คำสั่งยังใช้ได้ตามปกติ)
//   · จำว่าเพิ่งคุยกันอยู่ 30 นาที — ช่วงนี้พี่ง้วงพิมพ์เลขเดี่ยว ๆ ("3") = ตอบคำถามของลูกแพร ไม่ใช่เลือกห้อง
//   · บทเรียนที่ลูกแพรเสนอ: ตรวจด่านก่อน (ownerChatLessons.prepare) แล้วค่อยให้ผู้เรียกโชว์ปุ่มยืนยัน
import { splitTelegramText } from "./telegramClient.mjs";
import { OWNER_CHAT_FALLBACK_TEXT } from "./ownerChat.mjs";
import { looksLikeCommand } from "./ownerChatLookupCatalog.mjs";
import { confirmKeyboard, lessonOfferText, lessonRefusedText, lessonSavedText } from "./telegramReplies.mjs";

export const CHAT_CONTEXT_OPEN_MS = 30 * 60_000;
export const TYPING_EVERY_MS = 4_500;

// บอกลูกแพรว่ามีอะไรรอพี่ง้วงกดอยู่ (จะได้เตือนได้ถ้าเกี่ยว) — ไม่ใส่ชื่อลูกค้า
export function pendingHintText(pending, nowMs) {
  if (!pending || !(Number(pending.expiresAt) > nowMs)) return "";
  if (pending.kind === "lesson") return `ตอนนี้มีบทเรียนรอพี่ง้วงกดยืนยันอยู่: "${pending.lesson?.topic || pending.lesson?.teaching || ""}" (กดปุ่มด้านบน หรือพิมพ์ "ยืนยัน"/"ยกเลิก")`;
  if (pending.kind === "pick") return "ตอนนี้มีรายการห้องลูกค้ารอพี่ง้วงเลือกอยู่ (กดปุ่มเลขในรายการด้านบน หรือพิมพ์ \"ยกเลิก\")";
  return "ตอนนี้มีคำสั่งรอพี่ง้วงกดยืนยันอยู่ (กดปุ่มด้านบน หรือพิมพ์คำว่า \"ยืนยัน\"/\"ยกเลิก\" ตรง ๆ)";
}

export function createTelegramChatBridge({ ownerChat = null, lessons = null, client, now = Date.now, logger = console, nextSeq = null }) {
  let openUntil = 0;
  let lastReplySeq = 0;
  let localSeq = 0;
  const stamp = () => (typeof nextSeq === "function" ? nextSeq() : (localSeq += 1));

  function startTyping(chatId) {
    let stopped = false;
    const tick = () => {
      if (!stopped) client.sendChatAction({ chatId }).catch(() => {});
    };
    tick();
    const timer = setInterval(tick, TYPING_EVERY_MS);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async function send(chatId, text) {
    for (const chunk of splitTelegramText(text)) {
      const sent = await client.sendMessage({ chatId, text: chunk });
      if (!sent?.ok) break; // ส่งไม่ถึงชิ้นหนึ่ง = หยุด ไม่ยิงชิ้นถัดไปที่อ่านไม่รู้เรื่องตามไป
    }
  }

  /**
   * คุยหนึ่งข้อความ: ตอบ (หรือขอโทษ) แล้วคืนบทเรียนที่ผ่านด่านแล้ว (ถ้ามี) ให้ผู้เรียกโชว์ปุ่มยืนยัน
   * @returns {Promise<{offer: object|null}>}
   */
  async function converse({ chatId, owner, text, pendingHint = "", focus = null, lookup = null }) {
    let result = null;
    try {
      result = await ownerChat.reply({ text, owner, pendingHint, lessons: Boolean(lessons?.enabled?.()), focus, lookup });
    } catch (err) {
      logger.error?.(`telegramOwnerChat: ตอบแชทไม่สำเร็จ (${err?.name || "Error"})`);
      result = null;
    }
    // ลิงก์เปิดห้องต่อท้ายเฉพาะข้อความที่ส่ง Telegram (ไม่อยู่ในความจำแชท — ในลิงก์มีรหัสลูกค้า)
    const links = result?.ok && Array.isArray(result.links) && result.links.length ? `\n\n${result.links.join("\n")}` : "";
    await send(chatId, `${result?.text || OWNER_CHAT_FALLBACK_TEXT}${links}`);
    if (!result?.ok) return { offer: null };
    lastReplySeq = stamp();
    openUntil = now() + CHAT_CONTEXT_OPEN_MS;
    if (!result.lesson || !lessons) return { offer: null };
    const prepared = lessons.prepare(result.lesson, { owner, customerNames: result.customerNames || [] });
    if (prepared.ok) return { offer: prepared.lesson };
    await send(chatId, lessonRefusedText(prepared.error));
    return { offer: null };
  }

  // ไม่ใช่คำสั่ง = คุยกับลูกแพร แล้วถ้าลูกแพรเสนอบทเรียนที่ผ่านด่าน ให้ผู้เรียกโชว์ปุ่มยืนยัน
  // (ask ของ telegramControl = pending ใช้ครั้งเดียว หมดอายุ 10 นาที แบบเดียวกับคำสั่ง yolo)
  async function talk({ chatId, owner, text, pending = null, ask, focus = null, lookup = null }) {
    const { offer } = await converse({ chatId, owner, text, pendingHint: pendingHintText(pending, now()), focus, lookup });
    if (offer) await ask(chatId, "lesson", lessonOfferText(offer), (nonce) => confirmKeyboard(nonce, "✅ บันทึกบทเรียน"), { lesson: offer });
  }

  function saveLesson(lesson, owner) {
    let result = null;
    try { result = lessons?.save(lesson, { owner }); } catch (err) {
      logger.error?.(`telegramOwnerChat: บันทึกบทเรียนไม่สำเร็จ (${err?.name || "Error"})`);
    }
    return result?.ok ? lessonSavedText(result) : lessonRefusedText(result?.error || "");
  }

  return {
    enabled: () => Boolean(ownerChat?.enabled?.()),
    // mini AI อ่านเป็น "สถานะ" + เจอห้องเดียว = ให้ลูกแพรตอบพร้อมห้องนั้น (ownerChat.focusRoom)
    focus: (command) => ownerChat?.focusRoom?.(command) ?? null,
    // เริ่มวางแผนค้นพร้อมกับ mini AI (ประหยัดเวลารอ ~2 วิ) — ถ้าข้อความกลายเป็นคำสั่ง ผลนี้ถูกทิ้ง
    // สัญญา: ไม่มีวัน reject (ห้ามเกิด unhandled rejection ตอนถูกทิ้ง) · ไม่ต้องค้น = null
    // ข้อความรูปคำสั่ง (yolo / เปิด-ปิด AI / สถานะ) ไม่เริ่มล่วงหน้า — ถ้าไม่ใช่คำสั่งจริง ownerChat.reply วางแผนเองทีหลัง
    prefetch: ({ text, owner }) => (typeof ownerChat?.plan === "function" && !looksLikeCommand(text)
      ? ownerChat.plan({ text, owner }).catch(() => ({ status: "failed", queries: [] }))
      : null),
    contextOpen: () => now() < openUntil,
    lastReplySeq: () => lastReplySeq,
    closeContext: () => { openUntil = 0; },
    startTyping,
    converse,
    talk,
    saveLesson,
  };
}
