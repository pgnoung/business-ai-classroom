// helpers.mjs — เครื่องมือกลางของเทสต์
// กติกาเหล็ก: เทสต์ห้ามแตะ network/LINE/Hermes จริง — stub globalThis.fetch ทุกไฟล์
import { createHmac } from "node:crypto";
import { request } from "node:http";
import { createConfig } from "../src/config.mjs";
import { openDb } from "../src/db.mjs";

// ระเบิดถ้าโค้ดไหนหลุดไปเรียก fetch จริง — เรียกที่หัวไฟล์เทสต์ทุกไฟล์
export function poisonGlobalFetch() {
  globalThis.fetch = () => {
    throw new Error("network ถูกปิดในเทสต์ — ต้อง inject stub fetch เท่านั้น");
  };
}

// config สำหรับเทสต์: mock ครบ ไม่มี secret จริง ไม่มี delay
export function testConfig(overrides = {}) {
  return createConfig({
    DASHBOARD_API_KEY: "test-dashboard-key",
    LINE_CHANNEL_SECRET: "test-line-secret",
    LINE_MOCK_URL: "http://line.mock",
    LINE_LIVE_SEND: "false",
    HERMES_BASE: "http://hermes.test/v1",
    // Default fixture identity for the optional Pngoung sales policy. Tests for
    // a missing/mismatched identity override this deliberately.
    BUSINESS_ID: "pngoung-tidkradum",
    BROADCAST_ENABLED: "true",
    // Training controls are an explicit channel capability. Most historical
    // training tests use the legacy `default` OA; production remains fail-
    // closed unless its own env names an allowed channel.
    TRAINING_COMMANDS_CHANNELS: "default",
    BURST_DEBOUNCE_MS: "0",
    SEND_DELAY_SCALE: "0",
    DB_FILE: ":memory:",
    ...overrides,
  });
}

// `now` ฉีดนาฬิกาเข้า DB ได้ เทสต์ที่ตรึงเวลาไว้ (เช่น B-13 ตั้งเวลาบรอดแคส)
// ต้องส่งนาฬิกาตัวเดียวกับที่ส่งให้ scheduler ไม่งั้น lease/cooldown ใน SQL จะ
// เทียบกับ wall clock แล้วเน่าเองเมื่อวันจริงเดินผ่านวันที่ฮาร์ดโค้ดไว้
// teachHashSecret ส่งได้ แต่ค่าเริ่มต้นยังเป็น "" เหมือนเดิมโดยเจตนา — เทสต์ที่เทียบ
// hash ของ teach_json คำนวณค่าคาดหวังจากกุญแจที่ตัวเองรู้ ถ้าที่นี่แอบใส่กุญแจให้
// เทสต์พวกนั้นจะเทียบกับกุญแจคนละดอกแล้วแดงโดยไม่มีใครแตะโค้ดจริงเลย
// (เทสต์ที่เขียน golden_turns ต้องส่งกุญแจมาเอง — คลังนั้นปฏิเสธการเขียนแบบไม่มีกุญแจ)
export function memoryDb({ now, teachHashSecret = "" } = {}) {
  const db = openDb({ file: ":memory:", teachHashSecret, ...(now ? { now } : {}) });
  const createOperator = db.createOperator.bind(db);
  // Production seed ทำบัญชีแรกเป็น owner เสมอ เทสต์เก่าที่ไม่ระบุ role จึงหมายถึง
  // primary console account เช่นกัน; permission tests ที่ต้องการ staff ระบุ
  // role:"operator" ชัดเจนและไม่ผ่าน shortcut นี้
  db.createOperator = (input) => createOperator({
    ...input,
    role: input?.role ?? (db.countOperators() === 0 ? "owner" : "operator"),
  });
  return db;
}

export function signLine(rawBody, secret) {
  return createHmac("sha256", secret).update(rawBody).digest("base64");
}

// stub fetch ฝั่ง LINE: บันทึกทุก call แล้วตอบ 200
// - fn.calls = call ขาส่งข้อความ/loading (พฤติกรรมเดิม — GET โปรไฟล์/โควตาแยกไปอีกถัง)
// - fn.sends = เฉพาะ call ส่งข้อความจริง (reply/push) — ใช้ assert ลำดับ/จำนวนข้อความ
// - fn.profileCalls / fn.quotaCalls = GET ของ G2a (F1/F7) — ตั้ง options เพื่อให้ตอบสำเร็จ
//   options: { profile: {displayName,...}, quota: {type,value}, consumption: {totalUsage} }
export function lineFetchStub({ profile = null, quota = null, consumption = null } = {}) {
  const calls = [];
  const profileCalls = [];
  const quotaCalls = [];
  const fn = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/v2/bot/profile/")) {
      profileCalls.push({ url: u });
      if (!profile) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => profile };
    }
    if (u.includes("/v2/bot/message/quota")) {
      quotaCalls.push({ url: u });
      const isConsumption = u.endsWith("/consumption");
      const payload = isConsumption ? consumption : quota;
      if (!payload) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => payload };
    }
    calls.push({ url: u, body: opts.body ? JSON.parse(opts.body) : null });
    return { ok: true, status: 200, json: async () => ({}) };
  };
  fn.calls = calls;
  fn.profileCalls = profileCalls;
  fn.quotaCalls = quotaCalls;
  Object.defineProperty(fn, "sends", {
    get: () => calls.filter((c) => !c.url.includes("/v2/bot/chat/loading/")),
  });
  fn.loadingCalls = () => calls.filter((c) => c.url.includes("/v2/bot/chat/loading/"));
  return fn;
}

// stub fetch ฝั่ง Hermes: ตอบ choices ปกติ (หรือ custom ผ่าน onCall)
export function hermesFetchStub(replyText = "สวัสดีค่ะ ยินดีดูแลนะคะ", { onCall } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    const parsed = { url: String(url), body: JSON.parse(opts.body) };
    calls.push(parsed);
    if (onCall) await onCall(parsed);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: replyText } }],
        usage: { prompt_tokens: 805, completion_tokens: 72 },
      }),
    };
  };
  fn.calls = calls;
  return fn;
}

// HTTP client เล็ก ๆ ยิงเข้า server ที่ listen แล้ว (ใช้ node:http เพราะ fetch โดน poison)
export function httpRequest(server, { method = "GET", path = "/", headers = {}, body = null } = {}) {
  const address = server.address();
  return new Promise((resolve, reject) => {
    const req = request(
      // agent:false = ไม่ใช้ keep-alive pool — socket ปิดหลังจบ ไม่ค้าง event loop ของเทสต์
      { host: "127.0.0.1", port: address.port, method, path, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          const text = buffer.toString("utf8");
          let parsed = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            // ไม่ใช่ JSON — ปล่อย null
          }
          resolve({ status: res.statusCode, headers: res.headers, buffer, text, json: parsed });
        });
      }
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

export function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function waitFor(fn, { timeout = 3000, interval = 10 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error("waitFor: หมดเวลารอเงื่อนไข");
    await sleep(interval);
  }
}

// v1.4.27: system prompt เดินทางเป็น "บล็อกข้อความ" แล้ว เพราะต้องปัก cache breakpoint
// ท้ายส่วนคงที่ (ไม่ปัก = cache ติดแค่ 2%, ปักแล้วติด 64% วัดจริง 2026-08-19)
// เทสต์ที่สนใจ "เนื้อความที่โมเดลเห็น" ให้ผ่านตัวนี้ — ได้ข้อความเดียวกันทุกตัวอักษร
// ทั้งทรงสตริงเดิมและทรงบล็อก
export function promptText(content) {
  return Array.isArray(content)
    ? content.map((block) => String(block?.text ?? "")).join("")
    : String(content ?? "");
}
