// สคริปต์ฝั่งเบราว์เซอร์: อ่านแชทจาก LINE OA Manager แล้วส่งไปเก็บที่ sink ในเครื่องตัวเอง (อ่านอย่างเดียว)
//
// ใช้อย่างไร (AI ทำให้): เปิดแท็บ https://chat.line.biz/<botId> ที่เจ้าของร้านล็อกอินไว้แล้ว
// แก้ CONFIG 3 บรรทัด แล้วรันโค้ดนี้ทั้งก้อนในแท็บนั้น (เครื่องมือ javascript ของ Claude in Chrome / Codex browser)
//
// สิ่งที่สคริปต์นี้ "ไม่ทำ" เด็ดขาด: เปิดห้องแชท (ทำให้ข้อความกลายเป็นอ่านแล้ว) · ส่งข้อความ · ติด/ลบแท็ก · แก้อะไรก็ตาม
// เก็บเฉพาะข้อความ (ใครพูด/ชนิด/ตัวอักษร/เวลา) — ไม่เก็บชื่อ รูปโปรไฟล์ หรือโน้ตของลูกค้า
(async () => {
  const CONFIG = {
    SINK: "http://127.0.0.1:8791",
    TOKEN: "ใส่ SINK_TOKEN ที่ sink พิมพ์ออกมา",
    SINCE_DAYS: 180,            // เอาเฉพาะห้องที่คุยล่าสุดภายในกี่วัน
    MAX_ROOMS: 300,             // เพดานจำนวนห้อง
    MAX_MESSAGES_PER_ROOM: 150, // เพดานข้อความต่อห้อง (ย้อนจากล่าสุด)
    DELAY_MS: 180,              // เดินช้าแบบคน กัน session โดนตัด
  };
  const bot = location.pathname.split("/").find((p) => /^U[0-9a-f]{32}$/.test(p));
  if (!bot) return "❌ เปิดหน้า https://chat.line.biz/<botId> ก่อน (ต้องเห็น U... บน URL)";
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = async (path) => {
    await sleep(CONFIG.DELAY_MS);
    const res = await fetch(`/api/${path}`, { credentials: "include" });
    const type = res.headers.get("content-type") || "";
    // session หมดอายุบางทีตอบ 200 เป็นหน้า HTML — ต้องเช็กว่าเป็น JSON จริง
    if (!res.ok || !type.includes("json")) throw new Error(`อ่าน ${path} ไม่ได้ (HTTP ${res.status}) — ล็อกอินใหม่แล้วรันอีกครั้ง`);
    return res.json();
  };
  const sink = (path, body) => fetch(`${CONFIG.SINK}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json", "x-sink-token": CONFIG.TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());

  const doneList = await sink("/done").catch(() => null);
  if (!doneList?.ok) return "❌ ติดต่อ sink ไม่ได้ — เปิด sink ในเครื่องก่อน และเช็ก TOKEN";
  const done = new Set(doneList.done);
  const since = Date.now() - CONFIG.SINCE_DAYS * 86400000;

  // 1) รายชื่อห้อง (หน้าละ 25 — เพดานของ LINE)
  const rooms = [];
  let next = "";
  while (rooms.length < CONFIG.MAX_ROOMS) {
    const page = await api(`v2/bots/${bot}/chats?folderType=ALL&limit=25${next ? `&next=${encodeURIComponent(next)}` : ""}`);
    const list = page.list || page.chats || [];
    let older = false;
    for (const c of list) {
      const last = Number(c.lastTalkedAt || c.updatedAt || 0);
      if (last && last < since) { older = true; continue; }
      if (c.spam) continue;
      rooms.push(c.chatId);
    }
    next = page.next || "";
    if (!next || older || !list.length) break;
  }

  // 2) ประวัติข้อความทีละห้อง (หน้าละ 50 ย้อนหลังด้วย backward)
  let saved = 0; let skipped = 0;
  for (const chatId of rooms.slice(0, CONFIG.MAX_ROOMS)) {
    if (done.has(chatId)) { skipped += 1; continue; }
    const messages = [];
    let backward = "";
    for (let pageNo = 0; pageNo < 20 && messages.length < CONFIG.MAX_MESSAGES_PER_ROOM; pageNo += 1) {
      const page = await api(`v3/bots/${bot}/chats/${chatId}/messages${backward ? `?backward=${encodeURIComponent(backward)}` : ""}`);
      for (const ev of page.list || page.messages || []) {
        if (ev.type !== "message" && ev.type !== "messageSent") continue; // ทิ้ง event อ่านแล้ว/ระบบ
        const m = ev.message || {};
        messages.push({ from: ev.type === "message" ? "customer" : "shop", type: m.type || "unknown", text: m.type === "text" ? String(m.text || "") : "", at: Number(ev.timestamp || ev.createdAt || 0) });
      }
      backward = page.backward || "";
      if (!backward) break;
    }
    messages.sort((a, b) => a.at - b.at);
    await sink("/chat", { chatId, messages: messages.slice(-CONFIG.MAX_MESSAGES_PER_ROOM) });
    saved += 1;
  }
  await sink("/finish", { saved, skipped });
  return `✅ เก็บใหม่ ${saved} ห้อง · ข้ามที่เก็บแล้ว ${skipped} ห้อง · รวมห้องที่เข้าเกณฑ์ ${rooms.length}`;
})();
