// consoleStatic.mjs — HTML/static allowlist ของ Operator Console
//
// แยกจาก consoleApi.mjs เพื่อคุมขนาด route หลัก และให้ browser revalidate asset เดิม
// ด้วย ETag แทนการดาวน์โหลด JS/CSS ทั้งชุดใหม่ทุกครั้งที่ reload
import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { APP_ROOT } from "./config.mjs";

const STATIC_DIR = join(APP_ROOT, "public", "console");
const STATIC_TYPES = {
  css: "text/css; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  // 28 ก.ย. 2026 ธีมลูกแพร: ฟอนต์ IBM Plex Sans Thai (OFL) โฮสต์เอง — CSP ห้ามฟอนต์จาก CDN
  woff2: "font/woff2",
  mp4: "video/mp4",
};
const STATIC_FILES = Object.fromEntries([
  "console.css", "instance-scope.css", "broadcast.css", "workspace.css", "console.js", "dom.mjs", "ui.mjs", "overview.mjs",
  "inbox.mjs", "chat.mjs", "chatMedia.mjs", "context.mjs", "settings.mjs", "settingsClaude.mjs", "knowledge.mjs", "exportUi.mjs",
  "orders.mjs", "broadcast.mjs", "training.mjs", "rounds.mjs", "backup.mjs", "scrollKeeper.mjs", "login.js",
  "reviews.mjs", "kpi.mjs",
  // 6 ต.ค. 2026 ค่ำ: แถบ "มาจากโฆษณา" ในห้องแชท + ป้าย AD บนรายการ (chat.mjs/inbox.mjs import)
  "adReferral.mjs", "ad-referral.css",
  // 7 ต.ค. 2026: การ์ดค่าแอดใบใหญ่บนหน้าแรก (overview.mjs import)
  "overviewAdSpend.mjs",
  "photoEditor.mjs", "photoAdjustments.mjs",
  "guide-tags.css", "guide-tags.js", "manifest.webmanifest", "app-icon.svg",
  "app-icon-180.png", "app-icon-192.png", "app-icon-512.png",
  "company-logo-2026.png",
  "brand/lukprae/icon-60.png", "brand/lukprae/icon-192.png", "brand/lukprae/icon-512.png",
  "brand/lukprae/apple-touch-icon-180.png", "brand/lukprae/character-watermark.webp",
  "brand/lukprae/app.webmanifest",
  // Android ใช้ภาพนี้เป็นหน้ากากขาวดำบนแถบสถานะ ไอคอนแอปสีเต็มจะกลายเป็นก้อนทึบ
  "app-badge-72.png",
  "webPushUi.mjs",
  // Package K (2 ก.ย. 2026): แผงคิวขออนุมัติ — ลืมใส่ที่นี่ = คอนโซลทั้งหน้าค้าง "กำลังโหลด..."
  // (settings.mjs import ไฟล์นี้ แล้วเซิร์ฟเวอร์ตอบ 404 → module graph ทั้งก้อนล้ม) เกิดจริง 22:48–23:1x
  "publishQueue.mjs",
  // เฟส 1b: แผงรุ่นสมอง (settings.mjs import ไฟล์นี้ — ลืมใส่ = หน้าค้าง "กำลังโหลด...")
  "brainVersions.mjs",
  // เฟส 3: กล่องตรวจ + จอสอน (console.js import ทั้งคู่ตอน boot — ลืมใส่ = คอนโซลทั้งหน้าค้าง
  // เหมือนเหตุการณ์ 2 ก.ย. 2026 ที่ publishQueue.mjs ตกจากรายชื่อนี้)
  "review.mjs", "teach.mjs", "whyPanel.mjs", "teachDrafts.mjs",
  "trainingIntake.mjs", "intakeCsv.mjs", "trainingIntake.css", "training-intake-sample.csv",
  "readiness.mjs", "readiness.css",
  // 18 ต.ค. 2026 (ขั้นที่ 2 ของแผน soul): หน้า #/soul อ่านอย่างเดียว (console.js import ตอน boot — ลืมใส่ = หน้าค้าง)
  "soul.mjs", "soul.css",
  "history.mjs", "history.css", "historyAudit.mjs", "historyAudit.css",
  // เฟส 3 (ด่านเล่นซ้ำ): brainVersions.mjs import ไฟล์นี้ — ลืมใส่ = หน้าตั้งค่าค้าง "กำลังโหลด..."
  "evalFailures.mjs",
  // 2026-09-28: สอนลูกแพรจากแผง "ทำไมตอบแบบนี้" (whyPanel.mjs import whyTeach.mjs · console.js import lessons.mjs)
  "whyTeach.mjs", "lessons.mjs", "lessons.css",
  // 28 ก.ย. 2026 ธีมลูกแพรรุ่นพี่สาวคนโต + ภาพรวมแบบ CEO + หน้า Intro
  // (overview.mjs/kpi.mjs/console.js import ไฟล์กลุ่มนี้ตอน boot — ขาดตัวเดียว = หน้าค้าง "กำลังโหลด...")
  "theme-lukprae.css", "theme-lukprae-pages.css", "theme-starter.css", "overview.css", "kpi.css", "intro.css",
  "charts.mjs", "icons.mjs", "lukpraeArt.mjs", "overviewCeo.mjs", "overviewTeam.mjs", "overviewRoas.mjs", "overviewAdReferrals.mjs", "kpiVisual.mjs", "intro.mjs",
  "brand/lukprae/mood/smile.webp", "brand/lukprae/mood/wink.webp", "brand/lukprae/mood/thinking.webp",
  "brand/lukprae/mood/surprised.webp", "brand/lukprae/mood/pout.webp",
  "brand/lukprae/lukprae-front.webp", "brand/lukprae/intro/nongkao.webp", "brand/lukprae/intro/nongkao-face.webp",
  "brand/lukprae/fonts/plex-thai-thai-400.woff2", "brand/lukprae/fonts/plex-thai-thai-600.woff2",
  "brand/lukprae/fonts/plex-thai-latin-400.woff2", "brand/lukprae/fonts/plex-thai-latin-600.woff2",
  // 2026-09-28: YOLO (chat.mjs import) + Telegram สั่งงาน (settings.mjs import) — ลืมใส่ = คอนโซลค้าง "กำลังโหลด..."
  "yolo.mjs", "yoloHandoffPanel.mjs", "yolo.css", "telegramSettings.mjs",
  // 2026-09-28: กล่องคำถามต้อนรับในโฆษณา Facebook (settings.mjs import — ลืมใส่ = หน้าตั้งค่าค้าง)
  "settingsAdWelcome.mjs",
  // 28 ก.ย. 2026: แผงสวิตช์พฤติกรรมลูกแพร (settings.mjs import)
  "settingsBehaviorSwitches.mjs",
  // 28 ก.ย. 2026: คัดห้อง — คิวรอตอบ/สแปม/AI ปิดเพราะใคร (chat.mjs/inbox.mjs/overviewCeo.mjs import · index.html โหลด css)
  "triage.mjs", "triage.css",
  // 28 ก.ย. 2026: การ์ด "LINE OA เดือนนี้" (overview.mjs import · index.html โหลด css) — ลืมใส่ = หน้าภาพรวมค้าง
  "lineUsage.mjs", "lineUsage.css",
  // 28 ก.ย. 2026: แผงป้ายจัดกลุ่มตามมิติ (context.mjs import · index.html โหลด css) — ลืมใส่ = ห้องแชทค้าง
  "contextTags.mjs", "tagEditor.css",
  // ข้อ 8: คีย์เวิร์ด # → ป้าย (settings.mjs import — ลืมใส่ = หน้าตั้งค่าค้าง "กำลังโหลด...")
  "settingsHashtagTags.mjs",
  // 28 ก.ย. 2026: แผง "ช่องทางอื่นของลูกค้าคนนี้" (context.mjs import · index.html โหลด css) — ลืมใส่ = ห้องแชทค้าง
  "identityLinks.mjs", "identityLinks.css",
  // 28 ก.ย. 2026 (ค่ำ): ข้อความหลังเชื่อม LINE แยกตามคลาส (settings.mjs import — ลืมใส่ = หน้าตั้งค่าค้าง)
  "settingsIdentityLink.mjs",
  // 28 ก.ย. 2026: สตูดิโอบรอดแคสต์ + ข้อความตามขั้น (broadcast.mjs import ทั้งชุด · index.html โหลด studio.css)
  // ขาดตัวเดียว = หน้าบรอดแคสต์ค้าง "กำลังโหลด..." (module graph ล้มทั้งก้อน)
  "broadcastState.mjs", "broadcastCreate.mjs", "broadcastAudience.mjs", "broadcastComposer.mjs",
  "broadcastResults.mjs", "broadcastBlocks.mjs", "stepMessages.mjs", "stepEditor.mjs", "stepActivation.mjs", "studio.css", "steps.css",
  // 12 ต.ค. 2026 ค่ำ: ห้องตรวจของพี่ง้วง (console.js + overview.mjs import · index.html โหลด css) — ขาดตัวเดียว = คอนโซลค้าง "กำลังโหลด..."
  "ownerReview.mjs", "ownerReviewCard.mjs", "ownerReviewSheet.mjs", "ownerReview.css",
  // 12 ต.ค. 2026: แท็บ "ตรวจแชทวันนี้" (ownerReview.mjs import · index.html โหลด css) — ขาดตัวเดียว = คอนโซลค้าง "กำลังโหลด..."
  "ownerReviewDaily.mjs", "ownerReviewDailyCard.mjs", "ownerReviewDailySheet.mjs", "ownerReviewDailyState.mjs", "ownerReviewDaily.css",
  "ownerReviewDailyScroll.mjs",
  // 8 พ.ย. 2026: หน้า "Usage วันนี้" ของเจ้าของ (console.js import · index.html โหลด css)
  "usage.mjs", "usage.css",
].map((file) => [file, { file, type: STATIC_TYPES[file.split(".").pop()] }]));

// วิดีโอเสิร์ฟแบบสตรีม + HTTP Range แยกจากไฟล์ static ปกติ (ที่อ่านทั้งไฟล์เข้าหน่วยความจำเพื่อทำ ETag)
// Safari เล่น <video> ไม่ได้เลยถ้าเซิร์ฟเวอร์ไม่ตอบ 206 ให้คำขอ "bytes=0-1" ตอนเริ่ม
// 28 ก.ย. 2026: ภาพปกอินโทรย้ายมาอยู่กลุ่มนี้ด้วย — ทั้งคู่ต้องล็อกอินก่อนดู (consoleApi) และไฟล์จริง
// วางที่ <DATA_DIR>/console-media/ นอก git/release (กติกา media diet) หน้า Intro รู้จาก /me ว่ามีหรือยัง
const MEDIA_FILES = Object.fromEntries([
  "brand/lukprae/intro/lukprae-universe-intro.mp4",
  "brand/lukprae/intro/lukprae-universe-intro-poster.webp",
].map((file) => [file, { file, type: STATIC_TYPES[file.split(".").pop()] }]));
export function consoleMediaType(name) {
  return MEDIA_FILES[name]?.type ?? null;
}
export const CONSOLE_MEDIA_FILE_NAMES = Object.freeze(Object.keys(MEDIA_FILES));

// ให้เทสต์ตรวจได้ว่าทุกไฟล์ที่หน้าคอนโซล import กันเอง อยู่ในรายชื่อนี้ครบ
export const CONSOLE_STATIC_FILE_NAMES = Object.freeze(Object.keys(STATIC_FILES));

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https:; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function htmlHeaders() {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": CSP,
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cache-control": "no-store",
  };
}

const STATIC_CACHE = new Map();

export function sendConsoleHtml(res, status, body, extraHeaders = {}) {
  res.writeHead(status, { ...htmlHeaders(), ...extraHeaders });
  res.end(body);
}

// White-label: หน้าคอนโซลของร้านที่ติดตั้งเอง (โปรไฟล์ generic หรือธีม starter) ห้ามใช้โลโก้/manifest ของลูกแพร-พี่ง้วง
// ธีม lukprae ใช้ชุดของตัวเองเสมอ · airdog/pngoung แบบ course = หัวหน้าเดิมทุกตัวอักษร
export function usesGeneratedManifest(branding = {}) {
  return branding?.theme !== "lukprae" && (branding?.profile === "generic" || branding?.theme === "starter");
}

export const GENERATED_MANIFEST_PATH = "/console/brand.webmanifest";

/** manifest ที่สร้างจากแบรนด์ (ไม่มีชื่อลูกแพร/พี่ง้วง) — ใช้เมื่อ usesGeneratedManifest() */
export function brandManifest(branding = {}) {
  const name = String(branding?.name || "Front Desk");
  const agent = String(branding?.agentName || branding?.agent || "").trim();
  const business = String(branding?.businessName || name).trim();
  return {
    name: `${name} Console`,
    short_name: (agent || name).slice(0, 24),
    description: `คอนโซลดูแลลูกค้าของ ${business}`,
    lang: "th",
    start_url: "/console/",
    scope: "/console/",
    display: "standalone",
    background_color: "#F6F8F8",
    theme_color: "#0F766E",
    icons: [
      { src: "/console/static/app-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/console/static/app-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  };
}

function brandPageHtml(body, branding = {}) {
  const theme = branding?.theme === "lukprae"
    ? "lukprae"
    : branding?.theme === "pngoung" ? "pngoung" : branding?.theme === "starter" ? "starter" : "airdog";
  const themeClass = theme === "airdog" ? "" : ` class="theme-${theme}"`;
  const defaultHead = body.match(/<!-- CONSOLE_BRAND_HEAD_START -->([\s\S]*?)<!-- CONSOLE_BRAND_HEAD_END -->/u)?.[1] || "";
  const generatedHead = [
    '<meta name="theme-color" content="#F6F8F8">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    `<link rel="manifest" href="${GENERATED_MANIFEST_PATH}">`,
    '<link rel="icon" type="image/png" sizes="192x192" href="/console/static/app-icon-192.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/console/static/app-icon-180.png">',
  ].join("\n");
  const brandHead = theme !== "lukprae" && usesGeneratedManifest(branding) ? generatedHead : theme === "lukprae" ? [
    '<meta name="theme-color" content="#D13868">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '<link rel="manifest" href="/console/static/brand/lukprae/app.webmanifest">',
    '<link rel="icon" type="image/png" sizes="192x192" href="/console/static/brand/lukprae/icon-192.png">',
    '<link rel="apple-touch-icon" sizes="180x180" href="/console/static/brand/lukprae/apple-touch-icon-180.png">',
    // ฟอนต์ตัวอักษรไทยน้ำหนักปกติเป็นตัวเดียวที่ทุกหน้าใช้ทันที — preload เฉพาะตัวนี้
    '<link rel="preload" href="/console/static/brand/lukprae/fonts/plex-thai-thai-400.woff2" as="font" type="font/woff2" crossorigin>',
  ].join("\n") : defaultHead.trim();
  // 28 ก.ย. 2026: CSS ธีมลูกแพรฉีดเฉพาะ instance ลูกแพร และวางหลัง stylesheet กลางทุกไฟล์
  // (instance อื่นไม่ต้องดาวน์โหลดเลย และลำดับ cascade ให้ธีมชนะของกลางเสมอ)
  const themeCss = theme === "lukprae" ? LUKPRAE_THEME_CSS
    : theme === "starter" ? '<link rel="stylesheet" href="/console/static/theme-starter.css">' : "";
  return body
    .replace('<html lang="th">', `<html lang="th"${themeClass}>`)
    .replace(/<!-- CONSOLE_BRAND_HEAD_START -->[\s\S]*?<!-- CONSOLE_BRAND_HEAD_END -->/u, brandHead)
    .replace("<!-- CONSOLE_THEME_CSS -->", themeCss);
}

const LUKPRAE_THEME_CSS = [
  '<link rel="stylesheet" href="/console/static/theme-lukprae.css">',
  '<link rel="stylesheet" href="/console/static/theme-lukprae-pages.css">',
].join("\n");

export function serveConsolePage(res, name, logger = console, branding = {}) {
  try {
    const body = readFileSync(join(STATIC_DIR, name), "utf8");
    sendConsoleHtml(res, 200, brandPageHtml(body, branding));
  } catch (err) {
    logger.error?.(`console: อ่านไฟล์ ${name} ไม่ได้ (${err?.message || err})`);
    sendConsoleHtml(res, 500, "<h1>500</h1>");
  }
}

// "bytes=a-b" | "bytes=a-" | "bytes=-n" ตัวเดียวเท่านั้น — หลายช่วง/รูปแบบแปลก = ไม่สนใจ Range
// แล้วส่งทั้งไฟล์ (RFC 9110 อนุญาต) · คืน null = ไม่มี Range, "unsatisfiable" = 416
export function parseByteRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(String(header || "").trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!(suffix > 0) || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isSafeInteger(start) || start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

// เสิร์ฟไฟล์ใหญ่แบบสตรีม + Range (แยก export ไว้ให้เทสต์ยิงกับไฟล์ชั่วคราวได้)
export function serveRangeFile(req, res, { path, type }, json) {
  let stat;
  try {
    stat = statSync(path);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
    return;
  }
  const size = stat.size;
  // ETag แบบ weak จากขนาด+เวลาแก้ไข — ไม่อ่านวิดีโอทั้งไฟล์มาทำ hash ทุกครั้งที่มีคนเปิด
  const etag = `W/"${size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}"`;
  const base = {
    "content-type": type,
    "accept-ranges": "bytes",
    "x-content-type-options": "nosniff",
    "cache-control": "private, max-age=0, must-revalidate",
    "last-modified": stat.mtime.toUTCString(),
    etag,
  };
  if (req.headers["if-none-match"] === etag) {
    res.writeHead(304, base);
    res.end();
    return;
  }
  // If-Range ไม่ตรงกับไฟล์ปัจจุบัน (ไฟล์ถูกแทนระหว่างดู) = ส่งทั้งไฟล์ใหม่ ห้ามต่อชิ้นผิดไฟล์
  const ifRange = req.headers["if-range"];
  const range = ifRange && ifRange !== etag ? null : parseByteRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...base, "content-range": `bytes */${size}`, "content-length": 0 });
    res.end();
    return;
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  const headers = { ...base, "content-length": size === 0 ? 0 : end - start + 1 };
  if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

export function serveConsoleStatic(req, res, name, json) {
  const media = MEDIA_FILES[name];
  if (media) {
    serveRangeFile(req, res, { path: join(STATIC_DIR, media.file), type: media.type }, json);
    return;
  }
  const entry = STATIC_FILES[name];
  if (!entry) {
    json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
    return;
  }
  try {
    // perf 2026-08-24: เดิมอ่านไฟล์ + sha256 ใหม่ทุก request (JS/CSS ~16 ไฟล์ต่อ page load)
    // — cache ต่อไฟล์ ตรวจ mtime+size ด้วย stat ก่อนใช้ ไฟล์ถูก deploy ทับ = cache หลุดเอง
    const path = join(STATIC_DIR, entry.file);
    const stat = statSync(path);
    const cacheKey = `${entry.file}|${stat.mtimeMs}|${stat.size}`;
    let cached = STATIC_CACHE.get(entry.file);
    if (!cached || cached.key !== cacheKey) {
      const bytes = readFileSync(path);
      cached = { key: cacheKey, content: bytes, etag: `"${createHash("sha256").update(bytes).digest("hex")}"` };
      STATIC_CACHE.set(entry.file, cached);
    }
    const { content, etag } = cached;
    const headers = {
      "content-type": entry.type,
      "content-length": content.length,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=0, must-revalidate",
      etag,
    };
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ...headers, "content-length": 0 });
      res.end();
      return;
    }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : content);
  } catch {
    json(res, 404, { ok: false, error: "ไม่พบไฟล์" });
  }
}

export function serveConsoleWorker(req, res, logger = console) {
  try {
    const content = readFileSync(join(STATIC_DIR, "sw.js"));
    res.writeHead(200, {
      "content-type": STATIC_TYPES.js,
      "content-length": content.length,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "service-worker-allowed": "/console/",
    });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch (error) {
    logger.error?.(`console: อ่าน service worker ไม่ได้ (${error?.message || error})`);
    res.writeHead(404, { "cache-control": "no-store" });
    res.end();
  }
}
