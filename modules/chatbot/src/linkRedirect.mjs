// linkRedirect.mjs — ลิงก์นับคลิกของบรอดแคสต์/ข้อความตามขั้น: GET /r/<token> (28 ก.ย. 2026)
//
// ปลายทางอยู่ในฐานข้อมูลฝั่งเซิร์ฟเวอร์เท่านั้น (คนเขียนในคอนโซล + ตรวจ https/http แล้ว) — ไม่ใช่ open redirect
// token เป็นตัวอักษรล้วน 12 ตัว สุ่มต่อ "ลิงก์ในแคมเปญ" ไม่ใช่ต่อคน → ไม่มี id ลูกค้าใน URL และนับได้แค่ยอดรวม
// บอทพรีวิวลิงก์ (LINE/Facebook ฯลฯ ดึงหน้าไปทำการ์ดพรีวิว) และ HEAD ไม่ถูกนับ · คลิกซ้ำจากเครื่องเดิมใน 10 วิ นับครั้งเดียว
// (ตัวกันซ้ำอยู่ในหน่วยความจำ hash + เกลือของโปรเซส ไม่ถูกเขียนลงดิสก์)
import { createHash, randomBytes } from "node:crypto";
import { safeLinkUrl } from "./broadcastMessages.mjs";
import { isLinkToken } from "./broadcastStudio.mjs";

const BOT_UA_RE = /bot|crawl|spider|slurp|preview|facebookexternalhit|line-poker|embedly|whatsapp|telegram|discord|skype|curl|wget|python|headless|monitor/iu;
const DEDUPE_MS = 10_000;
const DEDUPE_MAX = 5_000;

function clientAddress(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || String(req.socket?.remoteAddress || "");
}

export function createLinkRedirect({ db, logger = console, now = Date.now } = {}) {
  const salt = randomBytes(16).toString("hex");
  const recent = new Map();

  function seenRecently(token, req) {
    const t = now();
    const key = createHash("sha256")
      .update(`${salt}|${token}|${clientAddress(req)}|${String(req.headers["user-agent"] || "")}`)
      .digest("base64url");
    const last = recent.get(key);
    recent.set(key, t);
    if (recent.size > DEDUPE_MAX) {
      for (const [entry, at] of recent) {
        if (t - at > DEDUPE_MS) recent.delete(entry);
        if (recent.size <= DEDUPE_MAX / 2) break;
      }
    }
    return last !== undefined && t - last < DEDUPE_MS;
  }

  function notFound(res) {
    res.writeHead(404, {
      "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
    });
    res.end("ไม่พบลิงก์นี้");
  }

  return function handleTrackedLink(req, res, url) {
    const token = url.pathname.slice("/r/".length);
    if (!isLinkToken(token)) return notFound(res);
    let link;
    try {
      link = db.getTrackedLink(token);
    } catch (error) {
      logger.warn?.(`linkRedirect: อ่านลิงก์ไม่สำเร็จ (${error?.message || error})`);
      return notFound(res);
    }
    const target = link ? safeLinkUrl(link.url) : "";
    if (!target) return notFound(res);
    const agent = String(req.headers["user-agent"] || "");
    const countable = req.method === "GET" && agent && !BOT_UA_RE.test(agent) && !seenRecently(token, req);
    if (countable) {
      try {
        db.recordLinkClick(token);
      } catch (error) {
        // นับพลาดไม่เป็นไร ลูกค้าต้องไปถึงปลายทางเสมอ
        logger.warn?.(`linkRedirect: นับคลิกไม่สำเร็จ (${error?.message || error})`);
      }
    }
    res.writeHead(302, {
      location: target,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'",
    });
    res.end();
  };
}
