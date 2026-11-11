// consoleIntroApi.mjs — สวิตช์เมนู "Intro · จักรวาลลูกแพร" ของคอนโซล (28 ก.ย. 2026)
//
// พี่ง้วงสั่ง: ทำหน้า intro ไว้ก่อน "เดี๋ยวเราค่อยเอาขึ้นเว็บ" — ค่าเริ่มต้นจึงปิดเสมอ
// เปิดได้คนเดียวคือเจ้าของ (role owner) ผ่าน POST /console/api/intro แล้วเมนูขวาสุด
// จะโผล่ให้ทุกบทบาทเห็นผ่าน features.intro ของ /console/api/me
//
// เนื้อหาหน้านี้เป็นจักรวาลของลูกแพรโดยเฉพาะ instance อื่น (Airdog ฯลฯ) จึงเปิดไม่ได้เลย
// ต่อให้มีค่าใน DB ค้างอยู่ (theme ต้องเป็น lukprae)
// เส้นนี้ไม่อยู่ใน STAFF_ROUTE_ROOTS โดยตั้งใจ: Staff ถูกกันตั้งแต่ด่าน route (deny by default)
// Admin ผ่านด่าน route ได้แต่ตกด่าน owner ในไฟล์นี้ — เหมือนเส้น /operators
import { statSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./config.mjs";

export const CONSOLE_INTRO_SETTING = "console_intro_enabled";
// ไฟล์วิดีโออินโทรยังไม่มี (กำลังผลิต) — หน้าเว็บต้องรู้ก่อนว่ามีไฟล์ไหม จะได้ไม่ยิงคำขอ
// ที่ได้ 404 ขึ้นแดงใน console ของเบราว์เซอร์ทุกครั้งที่เปิดหน้า Intro
const INTRO_MEDIA_DIR = join(APP_ROOT, "public", "console", "brand", "lukprae", "intro");
export const INTRO_VIDEO_FILE = "lukprae-universe-intro.mp4";
export const INTRO_POSTER_FILE = "lukprae-universe-intro-poster.webp";

// 28 ก.ย. 2026: รีโปมีกติกา "media diet" — ห้ามไฟล์วิดีโอเข้า git (.gitignore outputs/**/*.mp4)
// release สร้างจาก git จึงพกวิดีโอไปไม่ได้ วิดีโอจริงจึงวางที่ <DATA_DIR>/console-media/ บนเครื่อง
// (นอก release, ไม่หายตอนสลับรุ่น) แล้วค่อยถอยมาดูโฟลเดอร์ static สำหรับ dev/preview
export function introMediaDirs(config = null) {
  return [config?.dataDir ? join(config.dataDir, "console-media") : null, INTRO_MEDIA_DIR].filter(Boolean);
}

export function resolveIntroMediaFile(name, { dirs = [INTRO_MEDIA_DIR] } = {}) {
  for (const dir of dirs) {
    const path = join(dir, name);
    try { if (statSync(path).isFile()) return path; } catch { /* ไม่มีในโฟลเดอร์นี้ ลองโฟลเดอร์ถัดไป */ }
  }
  return null;
}

export function consoleIntroMedia({ dir = null, dirs = null } = {}) {
  const lookIn = dirs ?? [dir ?? INTRO_MEDIA_DIR];
  return {
    video: resolveIntroMediaFile(INTRO_VIDEO_FILE, { dirs: lookIn }) !== null,
    // โปสเตอร์เป็นภาพเล็ก (webp) อยู่ใน release ได้ตามปกติ
    poster: resolveIntroMediaFile(INTRO_POSTER_FILE, { dirs: lookIn }) !== null,
  };
}

export function consoleIntroEnabled({ db, branding } = {}) {
  if (branding?.theme !== "lukprae") return false;
  try {
    return String(db?.getSetting?.(CONSOLE_INTRO_SETTING) ?? "") === "1";
  } catch {
    return false; // อ่านค่าไม่ได้ = ปิด (หน้านี้ไม่ใช่งานประจำ ปิดไว้ปลอดภัยกว่า)
  }
}

export function createConsoleIntroRoutes({ db, branding, config = null }) {
  async function handle(req, res, route, ctx) {
    if (route[0] !== "intro" || route.length !== 1) return false;
    const { readJson, json, username, operator, requireCsrf } = ctx;
    const available = branding?.theme === "lukprae";
    if (req.method === "GET") {
      json(res, 200, {
        ok: true, available,
        enabled: consoleIntroEnabled({ db, branding }),
        canManage: available && operator?.role === "owner",
        media: available ? consoleIntroMedia({ dirs: introMediaDirs(config) }) : { video: false, poster: false },
      });
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    if (operator?.role !== "owner") {
      json(res, 403, { ok: false, error: "เฉพาะเจ้าของเปิดหรือซ่อนเมนู Intro ได้" });
      return true;
    }
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }
    if (!available) {
      json(res, 404, { ok: false, error: "instance นี้ไม่มีหน้า Intro" });
      return true;
    }
    const body = await readJson(req);
    if (typeof body?.enabled !== "boolean") {
      json(res, 400, { ok: false, error: "enabled ต้องเป็น true หรือ false" });
      return true;
    }
    db.setSetting(CONSOLE_INTRO_SETTING, body.enabled ? "1" : "0");
    db.addAudit({ operator: username, action: "console_intro_toggle", detail: body.enabled ? "on" : "off" });
    json(res, 200, { ok: true, enabled: consoleIntroEnabled({ db, branding }) });
    return true;
  }

  return { handle };
}
