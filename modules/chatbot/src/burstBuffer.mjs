// burstBuffer.mjs — รอลูกค้าพิมพ์จบก่อนตอบ (พอร์ตจาก LuKprae ปรับเข้าโครง zero-dep ใหม่)
//
// คนไทยพิมพ์แชทเป็นชุด 3-5 ข้อความสั้น ๆ แอดมินจริงอ่านทั้งชุดแล้วตอบครั้งเดียว
// โมดูลนี้ทำให้บอททำแบบเดียวกัน:
// - ข้อความที่ไม่ใช่ตัวสุดท้าย resolve เป็น { role: "absorbed" } (ไม่มี reply ของตัวเอง)
// - ข้อความสุดท้าย (ไม่มีข้อความใหม่ภายใน debounce) resolve เป็น
//   { role: "leader", combinedText, parts } แล้วขับ reply รวมครั้งเดียว
//
// SPEC G1a: debounce default 4000ms (LINE), ขยาย x2 (เพดาน 10s) เมื่อข้อความดูยังไม่จบ,
// maxWait 12s กัน burst ยืดไม่รู้จบ

const EXTENDED_CAP_MS = 10000;

// สัญญาณว่า "ยังพิมพ์ไม่จบ": ลงท้ายด้วยคำเชื่อมไทย / จุลภาค / จุดไข่ปลา
const UNFINISHED_ENDINGS = /(?:และ|กับ|แล้วก็|คือ|เช่น|อีกอย่าง|แต่|เพราะ|ก็|,|\.\.\.|…)\s*$/u;
// คำที่บอกว่าเป็นคำถามแล้ว (จบประโยคได้) — ใช้แบบคำเต็ม ไม่ใช่ char class
const QUESTION_MARKERS = /(?:\?|ไหม|มั้ย|เหรอ|หรอ|รึเปล่า|หรือเปล่า|กี่|เท่าไหร่|เท่าไร)/u;

export function looksUnfinished(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (UNFINISHED_ENDINGS.test(value)) return true;
  // เศษประโยคสั้นมาก เช่น "พี่คะ", "คือ" — ถ้าไม่ใช่คำถาม ให้รอต่อ
  if ([...value].length <= 6 && !QUESTION_MARKERS.test(value)) return true;
  return false;
}

export function suggestDebounceMs({ text, baseMs }) {
  const base = Math.max(0, Number(baseMs) || 0);
  if (base === 0) return 0;
  return looksUnfinished(text) ? Math.min(base * 2, EXTENDED_CAP_MS) : base;
}

export function createBurstBuffer({ debounceMs = 4000, maxWaitMs = 12000 } = {}) {
  const buffers = new Map();

  // v1.2.1: quoteToken ของข้อความล่าสุดใน burst — ให้ reply ของบอท quote ข้อความลูกค้า
  function push({ key, text, quoteToken = "" }) {
    const k = String(key || "default");
    const value = String(text || "");
    if (debounceMs <= 0) {
      // ปิด debounce = ทุกข้อความเป็น leader ทันที (โหมดเทสต์/ดีบัก)
      return Promise.resolve({ role: "leader", combinedText: value, parts: [value], quoteToken: String(quoteToken || "") });
    }

    let entry = buffers.get(k);
    if (!entry) {
      entry = { parts: [], resolvers: [], timer: null, firstAt: Date.now(), quoteToken: "" };
      buffers.set(k, entry);
    }
    entry.parts.push(value);
    if (quoteToken) entry.quoteToken = String(quoteToken);

    if (entry.timer) clearTimeout(entry.timer);
    const promise = new Promise((resolve) => entry.resolvers.push(resolve));
    const elapsed = Date.now() - entry.firstAt;
    const wanted = suggestDebounceMs({ text: value, baseMs: debounceMs });
    // เพดานรวม maxWait: ยิ่งรอมานาน delay ที่เหลือยิ่งสั้นลง
    const delay = Math.max(5, Math.min(wanted, maxWaitMs - elapsed));
    // หมายเหตุ: ห้าม unref timer — promise ของ burst ต้องได้ resolve เสมอ
    // แม้ event loop เหลือแค่งานนี้ (ไม่งั้นข้อความลูกค้าหายเงียบตอน process กำลังปิด)
    entry.timer = setTimeout(() => flush(k), delay);
    return promise;
  }

  function flush(key) {
    const k = String(key || "default");
    const entry = buffers.get(k);
    if (!entry) return null;
    buffers.delete(k);
    if (entry.timer) clearTimeout(entry.timer);
    const parts = [...entry.parts];
    const combinedText = parts.join("\n");
    const quoteToken = entry.quoteToken || "";
    const leaderResolver = entry.resolvers.pop();
    for (const resolve of entry.resolvers) resolve({ role: "absorbed", parts });
    if (leaderResolver) leaderResolver({ role: "leader", combinedText, parts, quoteToken });
    return { combinedText, parts, quoteToken };
  }

  function pendingSize(key) {
    return buffers.get(String(key || "default"))?.parts.length || 0;
  }

  // flush ทุกห้องทันทีโดยไม่รอ debounce — ใช้ตอนระบบกำลังปิด
  // ปลอดภัยเพราะ flush(k) ทำ buffers.delete(k) ก่อน resolve และ clearTimeout ให้
  // timer เดิมที่ยิงตามมาจะเจอ entry ว่างแล้ว return null — burst ก้อนเดียวได้ leader ตัวเดียวเสมอ
  function flushAll() {
    const keys = [...buffers.keys()];
    for (const key of keys) flush(key);
    return keys.length;
  }

  return { push, flush, pendingSize, flushAll };
}
