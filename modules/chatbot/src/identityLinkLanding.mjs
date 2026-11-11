// identityLinkLanding.mjs — หน้า "ยืนยันการลงทะเบียนผ่าน LINE" ของลิงก์เชิญจาก Facebook: GET /r/line#LK-XXXXX-XXXXX (30 ก.ย. 2026)
//
// พี่ง้วงทดลองส่งจริงหลายรอบ: ลิงก์ line.me (oaMessage / ti/p / lin.ee เพิ่มเพื่อน) ที่กดจาก Messenger เปิดในเบราว์เซอร์ของแอป
// Facebook แล้วค้างหน้า "Open LINE" — ปุ่มเปิดแอปใช้ไม่ได้ (x-safari-https ก็ถูกบล็อก) ต้องกด ⋯ → เปิดในเบราว์เซอร์ ก่อนเสมอ
// พี่ง้วง 30 ก.ย. 08:56: "ทำหน้าจูงใจว่าเพื่อเข้ากลุ่ม support หลังเรียน และยืนยันการลงทะเบียนสำเร็จ · ถ้ากดไม่ได้ให้เปิดผ่าน web
// browser ทำภาพประกอบอย่างง่าย คนแก่ดูก็เข้าใจทันที · หน้าตาแบรนด์พี่ง้วง ปุ่มเด่น น้อยคำ เปิดมาก็รู้ว่าต้องทำยังไง
// · ย้ำว่ารับคลาสออนไลน์ทบทวนหลังเรียนทาง LINE OA · ทำรูป mascot พี่ง้วงแนะนำ"
//   · ในแอป Facebook/Messenger/Instagram → ขั้น ① แตะ ⋯ มุมขวาบน ② เปิดในเบราว์เซอร์ ③ กดปุ่มเขียว (ภาพประกอบ SVG ในหน้า)
//     พี่ง้วงมาสคอตชี้ขึ้นมุมขวาบน = ชี้ไปที่ปุ่ม ⋯ จริงของเบราว์เซอร์ · Android ในแอปลอง intent:// เปิด LINE ก่อน
//   · เบราว์เซอร์ปกติ (Safari/Chrome) → ปุ่มเขียวเป็นลิงก์ line.me ตรง แตะแล้วแอป LINE เปิดพร้อมรหัสในช่องพิมพ์ แค่กดส่ง
//   · ทางสำรองเสมอ: รหัส + ปุ่มคัดลอก + ค้นหาไอดี
// มาสคอต = พี่ง้วงอนิเมะท่าชี้ (ชุดเดียวกับหน้า pngoungacademy.com ที่พี่ง้วงอนุมัติ 29 ก.ย.) · โลโก้ = ไฟล์ทางการแบบโปร่งใส
// รหัสอยู่หลัง # เท่านั้น — เบราว์เซอร์ไม่ส่งส่วนนี้มาที่เซิร์ฟเวอร์ (ไม่มีรหัสใน log) · หน้าไม่อ่านฐานข้อมูล ไม่มีข้อมูลลูกค้า
// CSP: รูปจากโดเมนเดียวกันเท่านั้น · สคริปต์/สไตล์ในหน้าใช้ nonce ต่อคำขอ · ไม่มีฟอนต์/สคริปต์ภายนอก
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLineBasicId } from "./identityLinkCodes.mjs";

export const IDENTITY_LANDING_PATH = "/r/line";
const ASSET_PREFIX = `${IDENTITY_LANDING_PATH}/a/`;
const ASSET_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "landing");
const ASSETS = Object.freeze({
  "pngoung-point.webp": "image/webp",
  "pngoung-logo.png": "image/png",
});

const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/gu, (ch) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[ch]);

/** ลิงก์หน้านี้พร้อมรหัส — ฐานต้องเป็น https origin (ไม่มี = ใช้ลิงก์ line.me ตรงแทน) */
export function identityLandingUrl(baseOrigin, code) {
  const base = String(baseOrigin || "").replace(/\/+$/u, "");
  if (!/^https:\/\/[^/]+$/u.test(base)) return "";
  return `${base}${IDENTITY_LANDING_PATH}#${String(code || "")}`;
}

// ภาพประกอบ "แตะ ⋯ มุมขวาบน" — แถบบนของเบราว์เซอร์ในแอป (✕ · ที่อยู่เว็บ · ⋯) มีวงเรืองแสงที่ ⋯
const SVG_DOTS = `<svg class="ill" viewBox="0 0 320 76" role="img" aria-label="แถบด้านบนของหน้าจอ มีปุ่มสามจุดที่มุมขวา">
<rect x="1" y="1" width="318" height="74" rx="14" fill="#ffffff" stroke="#c9d3e3"/>
<path d="M26 28 l20 20 M46 28 l-20 20" stroke="#1f2a3d" stroke-width="4" stroke-linecap="round"/>
<rect x="76" y="27" width="150" height="22" rx="11" fill="#eef2f8"/>
<text x="151" y="43" text-anchor="middle" font-size="13" fill="#51607a" font-family="sans-serif">lukprae…com</text>
<circle class="pulse" cx="280" cy="38" r="24" fill="none" stroke="#ffd43b" stroke-width="5"/>
<circle cx="268" cy="38" r="4.5" fill="#1f2a3d"/><circle cx="280" cy="38" r="4.5" fill="#1f2a3d"/><circle cx="292" cy="38" r="4.5" fill="#1f2a3d"/>
</svg>`;

// ภาพประกอบ "เลือก เปิดในเบราว์เซอร์" — เมนูที่เด้งขึ้นมา แถวที่ต้องแตะเป็นแถบเหลือง
const SVG_MENU = `<svg class="ill" viewBox="0 0 320 132" role="img" aria-label="เมนูที่เด้งขึ้นมา มีแถวเปิดในเบราว์เซอร์ถูกไฮไลต์">
<rect x="1" y="1" width="318" height="130" rx="14" fill="#ffffff" stroke="#c9d3e3"/>
<text x="24" y="34" font-size="15" fill="#8792a6" font-family="sans-serif">คัดลอกลิงก์</text>
<rect class="pulse-row" x="10" y="48" width="300" height="38" rx="10" fill="#fff3bf" stroke="#ffd43b" stroke-width="3"/>
<text x="24" y="73" font-size="17" font-weight="700" fill="#1f2a3d" font-family="sans-serif">🌐 เปิดในเบราว์เซอร์</text>
<text x="24" y="114" font-size="15" fill="#8792a6" font-family="sans-serif">แชร์</text>
</svg>`;

/** HTML ของหน้า (pure) — lineId = LINE ID ของ OA ปลายทาง (เช่น @pngoung) · nonce ต่อคำขอ · baseUrl ใช้ทำการ์ดพรีวิว */
export function renderIdentityLanding({ lineId = "", nonce = "", baseUrl = "" } = {}) {
  const id = normalizeLineBasicId(lineId);
  const idText = escapeHtml(id || "ของพี่ง้วง");
  const idJson = JSON.stringify(id).replace(/</gu, "\\u003c");
  const n = escapeHtml(nonce);
  const base = /^https:\/\/[^/]+$/u.test(String(baseUrl || "")) ? String(baseUrl) : "";
  const ogImage = base ? `<meta property="og:image" content="${escapeHtml(`${base}${ASSET_PREFIX}pngoung-point.webp`)}">` : "";
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#030815">
<title>ยืนยันการลงทะเบียนผ่าน LINE — พี่ง้วง ติดกระดุม</title>
<meta property="og:title" content="อีก 1 ขั้น ยืนยันการลงทะเบียนผ่าน LINE ✅">
<meta property="og:description" content="แอดไลน์ ${idText} รับยืนยันลงทะเบียน กลุ่ม Support และคลาสออนไลน์ทบทวนหลังเรียน">
${ogImage}
<style nonce="${n}">
:root { --navy: #030815; --deep: #081326; --panel: #192c4e; --blue: #2d8cff; --cyan: #62b8ff; --silver: #e0e0e5;
  --gray: #9b9eaa; --white: #ffffff; --green: #06c755; --gold: #d4a843; --yellow: #ffd43b; }
* { box-sizing: border-box; }
html { background: var(--navy); }
body { margin: 0; min-height: 100vh; color: var(--white);
  background: radial-gradient(120% 60% at 85% 0%, rgba(45,140,255,.28), transparent 60%), linear-gradient(180deg, var(--deep), var(--navy) 55%);
  font: 17px/1.5 "Prompt", "Kanit", "Noto Sans Thai", "Sukhumvit Set", -apple-system, "Segoe UI", sans-serif; }
main { max-width: 440px; margin: 0 auto; padding: 14px 18px 36px; }
.top { position: relative; display: flex; align-items: flex-start; justify-content: space-between; min-height: 150px; }
.logo { width: 104px; height: auto; margin-top: 2px; }
.guide img { display: block; width: 122px; height: auto; margin-right: -6px; filter: drop-shadow(0 8px 18px rgba(45,140,255,.35)); }
/* คำพูดของมาสคอตอยู่ใต้โลโก้ หางชี้ไปทางพี่ง้วงด้านขวา */
.bubble { position: absolute; left: 0; top: 84px; max-width: calc(100% - 136px); background: var(--white); color: #0b1a33;
  font-weight: 800; font-size: 16px; line-height: 1.35; padding: 10px 12px; border-radius: 14px 14px 4px 14px;
  box-shadow: 0 6px 18px rgba(0,0,0,.35); }
h1 { font-size: 30px; line-height: 1.2; margin: 6px 0 4px; font-weight: 800; letter-spacing: -.3px; }
h1 b { color: var(--green); }
.lead { color: var(--silver); margin: 0 0 16px; font-size: 18px; }
.lead b { color: var(--white); }
.gets { list-style: none; margin: 0 0 20px; padding: 14px 16px; background: rgba(25,44,78,.72); border: 1px solid rgba(98,184,255,.28);
  border-radius: 16px; display: grid; gap: 8px; }
.gets li { display: flex; gap: 10px; align-items: center; font-size: 18px; font-weight: 700; }
.gets i { font-style: normal; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center;
  background: rgba(6,199,85,.16); flex: none; }
.steps { margin: 0 0 18px; padding: 0; list-style: none; display: grid; gap: 12px; }
.steps > li { background: rgba(8,19,38,.8); border: 1px solid rgba(255,212,59,.45); border-radius: 16px; padding: 12px 12px 14px; }
.steps h2 { margin: 0 0 8px; font-size: 19px; font-weight: 800; display: flex; gap: 10px; align-items: center; }
.num { width: 30px; height: 30px; border-radius: 50%; background: var(--yellow); color: #1b1b1b; display: grid; place-items: center;
  font-weight: 800; flex: none; }
.ill { display: block; width: 100%; height: auto; }
.pulse { transform-origin: 280px 38px; animation: ring 1.4s ease-in-out infinite; }
.pulse-row { animation: glow 1.4s ease-in-out infinite; }
@keyframes ring { 0%, 100% { opacity: .35; transform: scale(.9); } 50% { opacity: 1; transform: scale(1.06); } }
@keyframes glow { 0%, 100% { opacity: .75; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .pulse, .pulse-row { animation: none; } }
.go { display: flex; align-items: center; justify-content: center; gap: 10px; text-decoration: none; background: var(--green); color: var(--white);
  font-weight: 800; font-size: 21px; padding: 18px 14px; border-radius: 16px; box-shadow: 0 10px 24px rgba(6,199,85,.35); }
.go:active { transform: translateY(2px); box-shadow: 0 5px 14px rgba(6,199,85,.35); }
.go-note { text-align: center; color: var(--silver); margin: 10px 0 0; font-size: 15px; }
.inapp-only { display: none; }
body.inapp .inapp-only { display: block; }
body.inapp .browser-only { display: none; }
.manual { margin-top: 26px; padding: 14px 16px 16px; border-radius: 16px; background: rgba(25,44,78,.55); border: 1px dashed rgba(155,158,170,.55); }
.manual h3 { margin: 0 0 10px; font-size: 16px; color: var(--silver); font-weight: 700; }
.code { display: flex; gap: 8px; }
.code output { flex: 1; min-width: 0; white-space: nowrap; font: 800 clamp(16px, 4.9vw, 21px)/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--white);
  padding: 11px 12px; border-radius: 12px; background: var(--navy); border: 1px solid rgba(98,184,255,.35);
  user-select: all; -webkit-user-select: all; }
.code button { font: inherit; font-weight: 800; padding: 10px 16px; border-radius: 12px; border: 0; background: var(--cyan); color: #04142e; }
.manual p { margin: 10px 0 0; color: var(--silver); font-size: 15px; }
.missing { display: none; }
.missing.show { display: block; }
</style>
</head>
<body>
<main>
<div class="top">
<img class="logo" src="${ASSET_PREFIX}pngoung-logo.png" width="194" height="129" alt="พี่ง้วง ติดกระดุม">
<div class="bubble" aria-hidden="true"><span class="inapp-only">แตะ ⋯ มุมขวาบน<br>ก่อนนะครับ 👆</span><span class="browser-only">กดปุ่มเขียว<br>ได้เลยครับ! 👇</span></div>
<div class="guide" aria-hidden="true"><img src="${ASSET_PREFIX}pngoung-point.webp" width="320" height="544" alt=""></div>
</div>
<h1>อีก 1 ขั้น<br><b>ยืนยันลงทะเบียน</b></h1>
<p class="lead">แอดไลน์ <b>${idText}</b> แล้วรับเลย</p>
<ul class="gets">
<li><i>✅</i>ยืนยันลงทะเบียนสำเร็จ</li>
<li><i>👥</i>เข้ากลุ่ม Support หลังเรียน</li>
<li><i>🎬</i>คลาสออนไลน์ทบทวนหลังเรียน</li>
</ul>
<ol class="steps inapp-only">
<li><h2><span class="num">1</span>แตะ ⋯ มุมขวาบน</h2>${SVG_DOTS}</li>
<li><h2><span class="num">2</span>เลือก “เปิดในเบราว์เซอร์”</h2>${SVG_MENU}</li>
<li><h2><span class="num">3</span>กดปุ่มเขียวด้านล่าง</h2></li>
</ol>
<a class="go" id="go" href="#">เปิด LINE ยืนยันเลย</a>
<p class="go-note">LINE จะเปิดพร้อมรหัส แค่กด <b>ส่ง</b> ✨</p>
<section class="manual">
<h3>กดไม่ได้? พิมพ์รหัสเองใน LINE</h3>
<div class="code"><output id="code">—</output><button type="button" id="copy">คัดลอก</button></div>
<p>เปิด LINE → ค้นหา <b>${idText}</b> → เพิ่มเพื่อน → วางรหัส แล้วกดส่ง</p>
<p class="missing" id="missing">ไม่เห็นรหัส? ใช้รหัสในข้อความ Messenger ได้เลยครับ</p>
</section>
</main>
<script nonce="${n}">
(function () {
  var id = ${idJson};
  var code = decodeURIComponent((location.hash || "").slice(1)).trim().toUpperCase();
  if (!/^LK-[0-9A-Z]{5}-[0-9A-Z]{5}$/.test(code)) code = "";
  var enc = encodeURIComponent;
  var ua = navigator.userAgent || "";
  var inApp = /FBAN|FBAV|FB_IAB|FBIOS|Messenger|Instagram/i.test(ua);
  var android = /Android/i.test(ua);
  if (inApp) document.body.classList.add("inapp");
  var go = document.getElementById("go");
  var path = code ? "oaMessage/" + enc(id) + "/?" + enc(code) : "ti/p/" + enc(id);
  go.href = id ? "https://line.me/R/" + path : "#";
  document.getElementById("code").textContent = code || "—";
  if (!code) document.getElementById("missing").classList.add("show");
  go.addEventListener("click", function (event) {
    // Android ในแอป Facebook: intent เปิดแอป LINE ได้ (ไม่มีแอป = กลับไปหน้า line.me) · iPhone ในแอป: ต้องเปิดในเบราว์เซอร์ก่อน (ขั้น 1–2)
    if (inApp && android && id) {
      event.preventDefault();
      location.href = "intent://" + path + "#Intent;scheme=line;package=jp.naver.line.android;S.browser_fallback_url=" + enc(go.href) + ";end";
    }
  });
  document.getElementById("copy").addEventListener("click", function () {
    var button = this;
    if (!code) return;
    var done = function () { button.textContent = "คัดลอกแล้ว ✓"; };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, selectCode);
    else selectCode();
  });
  function selectCode() {
    var range = document.createRange();
    range.selectNodeContents(document.getElementById("code"));
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
})();
</script>
</body>
</html>
`;
}

function sendAsset(req, res, name) {
  const type = ASSETS[name];
  const file = type ? join(ASSET_DIR, name) : "";
  if (!file || !existsSync(file)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
    res.end("ไม่พบไฟล์");
    return;
  }
  const body = readFileSync(file);
  res.writeHead(200, {
    "content-type": type, "content-length": body.length,
    "cache-control": "public, max-age=86400", "x-content-type-options": "nosniff",
  });
  res.end(req.method === "HEAD" ? undefined : body);
}

/**
 * ตัวจัดการ GET/HEAD /r/line และรูปของหน้า /r/line/a/<ไฟล์> (มีรายชื่อไฟล์ตายตัว)
 * getLineId() = LINE ID ปัจจุบันของ OA ปลายทาง · getBaseUrl() = โดเมนสาธารณะ (ทำการ์ดพรีวิว) — อ่านสดทุกคำขอ
 */
export function createIdentityLanding({ getLineId = () => "", getBaseUrl = () => "" } = {}) {
  return function handleIdentityLanding(req, res, pathname = IDENTITY_LANDING_PATH) {
    if (pathname.startsWith(ASSET_PREFIX)) return sendAsset(req, res, pathname.slice(ASSET_PREFIX.length));
    const nonce = randomBytes(16).toString("base64");
    let lineId = "";
    let baseUrl = "";
    try { lineId = getLineId() || ""; } catch { lineId = ""; }
    try { baseUrl = getBaseUrl() || ""; } catch { baseUrl = ""; }
    const html = renderIdentityLanding({ lineId, nonce, baseUrl });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    });
    res.end(req.method === "HEAD" ? undefined : html);
  };
}

/** เส้นทางนี้เป็นของหน้าเปิด LINE ไหม (หน้า + รูปของหน้า) */
export function isIdentityLandingPath(pathname) {
  const value = String(pathname || "");
  return value === IDENTITY_LANDING_PATH || value.startsWith(ASSET_PREFIX);
}
