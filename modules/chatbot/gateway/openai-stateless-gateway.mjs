#!/usr/bin/env node
// A deliberately narrow, local-only OpenAI-compatible drafting boundary.
// It owns no conversation state and never accepts provider credentials from a client.
import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const LOCAL_HOST = "127.0.0.1";
export const DEFAULT_PORT = 8650;
export const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";
export const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
// v1.4.9 (คำสั่งพี่ง้วง 2026-08-17): เปิดรายการโมเดลผ่าน env ได้ — แกนหลัก 3 ตัว
// อยู่เสมอ (default/probe ของระบบพึ่งมัน) ส่วนรายการเพิ่มมาจาก GATEWAY_ALLOWED_MODELS
// ที่ launcher สร้างจากไฟล์ราคาโมเดลของ chassis (แหล่งความจริงเดียวกับ console)
// 2026-09-30: ตอบแชท/ติดตาม = gpt-6.1-sol (blind test 308 เคส) · 2026-10-11 ค่ำ กลับเป็น 5.6 Sol ทุกบทบาท (คำสั่งพี่ง้วง) · 6.1 คงไว้เป็นทางถอยกลับ
// ห้ามเรียง/ลบรายการนี้: ใบอนุญาตรุ่น (lukprae-gateway.mjs CAPABILITY_MODELS) เป็น HMAC ของรายการเรียงเดียวกัน
export const CORE_MODELS = Object.freeze(["gpt-6.1-sol", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.6-terra"]);
export function gatewayAllowedModels(env = process.env) {
  const extra = String(env?.GATEWAY_ALLOWED_MODELS || "")
    .split(",").map((value) => value.trim()).filter(Boolean);
  return Object.freeze([...new Set([...CORE_MODELS, ...extra])]);
}
export const ALLOWED_MODELS = gatewayAllowedModels();

// 2026-10-04 (พี่ง้วงเลือกเองแบบไม่รู้ชื่อรุ่น: Sonnet 9 · Opus 8 · 5.6 2 · 6.1 0 → "ทุกมิติ ใช้ sonnet 5.5 ก่อนเลย"):
// Claude ผ่าน Anthropic Messages API — เปิดเฉพาะเมื่อ gateway.env มีกุญแจ Anthropic ทั้งระบบยังคุยรูป OpenAI
// chat/completions เกตเวย์แปลงไป-กลับที่ขอบนี้ที่เดียว · Claude ล้มทุกแบบ (กุญแจหมดอายุ/ล่ม/ปฏิเสธ/คำตอบว่าง)
// = ตอบด้วยรุ่นสำรอง (ANTHROPIC_FALLBACK_MODEL) แทนในคำขอเดียวกัน ลูกค้าไม่เงียบ
export const ANTHROPIC_MESSAGES_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_MODELS = Object.freeze(["claude-sonnet-5-5", "claude-opus-5-5"]);
// 2026-10-11 ค่ำ: ตัวสำรองของ Claude ย้ายตาม 5.6 Sol (คำสั่งพี่ง้วงกลับ 5.6 ทุกอย่าง) — อยู่ใน CORE_MODELS และใบอนุญาตแล้ว
// 8 พ.ย. 2026: รุ่นหลักของลูกแพรเป็น 6.1 Sol แล้ว (พี่ง้วง "Claude ชุดไหนหมด fallback ไปที่ api หลักของ chatgpt") — ตัวสำรองย้ายตามรุ่นหลัก
export const ANTHROPIC_FALLBACK_MODEL = "gpt-6.1-sol";
export const isAnthropicModel = (model) => ANTHROPIC_MODELS.includes(String(model || ""));
// chassis ยกเลิกคำขอที่ 90 วิ — Claude ได้ 60 วิ แล้วตัวสำรองใช้เวลาที่เหลือ (ราว 25 วิ) ภายในเส้นตาย 85 วิ
// 1 พ.ย. 2026 (พี่ง้วง "เอาเคส opus worse case เป็นฐาน"): เทส 80 ห้อง Opus 5.5 ครั้งเดียวนานสุด 24.5 วิ ทั้งเทิร์นนานสุด 45.7 วิ
// 60 วิครอบเคสนั้นทั้งเทิร์น และเหลือเวลาตอบด้วยรุ่นสำรองก่อน FALLBACK_DEADLINE_MS (Sol ช้าสุดราว 9 วิ)
export const ANTHROPIC_TIMEOUT_MS = 60_000;
export const FALLBACK_DEADLINE_MS = 85_000;
const providerOf = (model) => (isAnthropicModel(model) ? "anthropic" : "openai");
const ANTHROPIC_IMAGE = /^data:(image\/(?:jpeg|png));base64,(.*)$/su;
const ANTHROPIC_WORKSPACE = /^wrkspc_[A-Za-z0-9]{8,64}$/u;
// 5 พ.ย. 2026 (พี่ง้วง "ใส่ api key claude อีกชุดนึง ... ให้ทำวนไป ถ้า ชุด 1 หมด ให้ไปชุด 2, แล้ว เมื่อชุด 2 หมด
// ให้กลับไปชุด 1 ... fall back 5.6 sol"): กุญแจ Claude ได้สองชุด ใช้ชุดที่ตอบได้ล่าสุดไปเรื่อย ๆ
// ชุดนั้นตอบ 4xx ที่เป็นเรื่องของกุญแจ/บัญชี (เครดิตหมด เพดาน ปฏิเสธกุญแจ ถูกจำกัดอัตรา) = ลองอีกชุดในคำขอเดียวกัน
// แล้วอีกชุดกลายเป็นชุดหลักต่อไป (วนกลับมาเมื่อชุดนั้นหมดบ้าง) · หมดทั้งสองชุด = ตัวสำรอง 5.6 Sol
// ล่ม/ค้าง/คำตอบใช้ไม่ได้ ไม่ใช่เรื่องกุญแจ = ไม่ลองซ้ำ ไปตัวสำรอง 5.6 Sol ทันทีเหมือนเดิม (กันเวลารอนาน)
export const ANTHROPIC_KEY_SWITCH_STATUSES = Object.freeze([400, 401, 402, 403, 429]);
// 8 พ.ย. 2026 (พี่ง้วง "OpenAI ถ้าอันไหนหมด ให้ fallback ไปอีกอัน"): กุญแจ OpenAI สองชุด วนแบบเดียวกับ Claude —
// เครดิตหมด/ถูกปฏิเสธ/ติดเพดาน (401 402 403 429) = ลองอีกชุดในคำขอเดียวกัน · 400 เป็นเรื่องของคำขอ ไม่สลับ (ชุดอื่นก็ได้ 400 เหมือนกัน)
export const OPENAI_KEY_SWITCH_STATUSES = Object.freeze([401, 402, 403, 429]);

function anthropicBlocks(content) {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [];
  return content.flatMap((block) => {
    if (block.type === "image_url") {
      const image = ANTHROPIC_IMAGE.exec(block.image_url.url);
      return image ? [{ type: "image", source: { type: "base64", media_type: image[1], data: image[2] } }] : [];
    }
    if (!block.text.trim()) return [];
    // หมุดของผู้เรียก = ก้อนความรู้+persona ของเส้นตอบแชท (~45k token) — แชทจริงตอบห่างกันเกิน 5 นาทีบ่อย
    // จึงจำ 1 ชั่วโมง (เขียน 2 เท่าของราคาปกติ แต่ไม่ต้องเขียนใหม่ทุกช่วงเงียบ) · หมุดที่ปักให้เองข้างล่างคง 5 นาที
    return [{ type: "text", text: block.text, ...(block.prompt_cache_breakpoint ? { cache_control: { type: "ephemeral", ttl: "1h" } } : {}) }];
  });
}

// คำขอที่ผ่าน sanitizeChatRequest แล้ว -> Anthropic: system เป็นบล็อก (หมุดแคช explicit -> cache_control) ·
// บทบาทเดียวกันติดกันรวมเป็นข้อความเดียว · ไม่มีหมุดจากผู้เรียก (เช่น ตัวให้คะแนน) ปักท้าย system ให้เอง ·
// การคิดแบบ adaptive ตามระดับที่ผู้เรียกขอ (ค่าเดียวกับชุดทดสอบที่พี่ง้วงเลือก)
export function toAnthropicRequest(payload) {
  const system = [];
  const messages = [];
  for (const message of payload.messages) {
    const blocks = anthropicBlocks(message.content);
    if (!blocks.length) continue;
    if (message.role === "system") { system.push(...blocks.filter((block) => block.type === "text")); continue; }
    const last = messages.at(-1);
    if (last?.role === message.role) last.content.push(...blocks);
    else messages.push({ role: message.role, content: blocks });
  }
  if (system.length && !system.some((block) => block.cache_control)) {
    system[system.length - 1] = { ...system[system.length - 1], cache_control: { type: "ephemeral" } };
  }
  return {
    model: payload.model,
    max_tokens: payload.max_completion_tokens,
    ...(system.length ? { system } : {}),
    messages,
    thinking: { type: "adaptive" },
    output_config: { effort: payload.reasoning_effort || "medium" },
  };
}

// คำตอบ Anthropic -> รูป chat/completions ที่ chassis อ่าน · ตัวเลขแคชลงช่องเดียวกับที่เครื่องคิดเงินใช้
// (prompt_tokens รวมทั้งส่วนที่อ่าน/เขียนแคช เหมือน OpenAI)
export function fromAnthropicResponse(body, model) {
  const blocks = Array.isArray(body?.content) ? body.content : [];
  const text = blocks.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n").trim();
  const usage = body?.usage || {};
  const read = Number(usage.cache_read_input_tokens) || 0;
  const write = Number(usage.cache_creation_input_tokens) || 0;
  const promptTokens = (Number(usage.input_tokens) || 0) + read + write;
  const completionTokens = Number(usage.output_tokens) || 0;
  return {
    id: String(body?.id || ""),
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: body?.stop_reason === "max_tokens" ? "length" : "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens,
      prompt_tokens_details: { cached_tokens: read, cache_write_tokens: write } },
  };
}
export const ALLOWED_REASONING_EFFORTS = Object.freeze(["low", "medium", "high"]);
// v1.4.27: คีย์ routing ของ prompt cache — สั้น อักขระปลอดภัย ไม่ใช่ช่องส่งเนื้อหา
export const PROMPT_CACHE_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/u;
// 128 KiB เคยพอ แต่ภาษาไทยกิน 3 ไบต์ต่อตัวอักษร: brand pack + persona + ความรู้
// รวมกันแค่ 53,800 ตัวอักษรก็เป็น 141 KB แล้ว พอเกินเพดาน readBody จะโยน
// body_too_large -> ตอบ 400 -> ลูกค้าเห็นข้อความ error ทุกครั้งโดยไม่มีใครรู้สาเหตุ
// 1 MiB ยังคุมพฤติกรรมหลุดกรอบได้ แต่ไม่บีบ prompt ที่ตั้งใจให้ยาวตามธุรกิจ
// 2026-09-05 (เคสจริง): รูปจากลูกค้า 1,067,264 ไบต์ กลายเป็น data URI ~1.42MB แล้วชนเพดาน 1 MiB
// ตรงนี้ -> 400 -> ตัวจำแนกรูปตอบ unknown -> ห้องถูกปิด AI ทั้งที่ไม่ใช่สลิป ข้อความล้วนยังถูกคุมด้วย
// MAX_MESSAGE_CHARS (200k ตัวอักษร ≈ 600KB) ส่วนรูปถูกคุมด้วย MAX_IMAGE_BYTES (4,000,000) แยกอยู่แล้ว
// เพดาน body รวมจึงต้องใหญ่พอให้ "ข้อความ + รูปหนึ่งใบเต็มเพดาน" ผ่านได้: 6 MiB (MAX_INFLIGHT 4 = บัฟเฟอร์สูงสุด 24MB)
export const MAX_REQUEST_BYTES = 6 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 512 * 1024;
export const MAX_INFLIGHT = 4;
// เพดานนี้ต้องรับ "ความจำตลอดชีพ" ที่เจ้าของสั่งไว้: HISTORY_TURNS=60 = ประวัติ 120
// ข้อความ + system + ข้อความล่าสุด = 122 ใบ ค่าเดิม 32 ทำให้ทุกบทสนทนาที่ยาวเกิน
// 15 เทิร์นถูกปฏิเสธเป็น 400 ทั้งที่ขนาด body ยังไม่ถึงครึ่งเพดานไบต์ด้วยซ้ำ
export const MAX_MESSAGES = 160;
// The approved LuKprae brain, persona, team knowledge and rules share one system
// message. It was 40k chars in July and 54k in August — a ceiling that sits close
// to real usage turns every content addition into a silent outage, so keep real
// headroom. The whole request remains bounded separately by MAX_REQUEST_BYTES.
export const MAX_MESSAGE_CHARS = 200_000;
export const MAX_COMPLETION_TOKENS = 1_024;
// v1.4.2 (เคสจริง 2026-08-16: ลูกค้าถามคลาส+ราคา -> finish_reason=length + content
// ว่าง 3 เทิร์นติด): 800 พอสำหรับ sol ยุคกติกาบาง — พอกติกาใน prompt หนาขึ้น
// โมเดลใช้โทเคน "คิด" จนหมดงบก่อนพิมพ์ ค่านี้เป็นตาข่ายกันตกสำหรับผู้เรียกที่
// ไม่ประกาศงบเอง (เส้นตอบลูกค้าตอนนี้ประกาศงบเองแล้วที่ 3,000)
export const DEFAULT_COMPLETION_TOKENS = 2_000;
// v1.2.2 (เคสจริง 2026-08-12: scorer 502 ทุกเทิร์น -> lead score ค้างที่เดิม):
// โมเดล reasoning หัก "โทเคนที่ใช้คิด" จากงบ completion ก้อนเดียวกับข้อความที่ตอบออกมา
// งบ 800 ของเส้นตอบลูกค้า (sol เขียนสั้น) จึงไม่พอสำหรับ scorer ที่ต้องอ่านทรานสคริปต์
// ทั้งบทแล้วคิดก่อนสรุป JSON — ผลคือ finish_reason=length พร้อม content ว่าง
// v1.2.3: บทบาท (ตอบลูกค้า vs ให้คะแนน) ไม่ใช่ชื่อโมเดล คือสิ่งที่กำหนดว่าต้องใช้งบเท่าไร
// — โมเดลตัวเดียวกันถูกใช้ได้ทั้งสองบทบาท ผู้เรียกจึงต้องส่งงบมาเองเมื่อต้องการมากกว่าค่าปกติ
// เพดานจึงเป็นค่าเดียวทั้งระบบ ส่วนค่า default ยังแยกไว้กันเคสที่ผู้เรียกไม่ส่งอะไรมา
export const SCORER_MODELS = Object.freeze(["gpt-5.6-luna", "gpt-5.6-terra"]);
export const SCORER_DEFAULT_COMPLETION_TOKENS = 3_000;
// v1.4.5 (คำสั่งพี่ง้วง 2026-08-15): ยกเพดานทั้งระบบเป็น 10,000 — เส้นตอบลูกค้า
// ประกาศงบเอง 6,000/10,000 แล้ว เพดานเกตเวย์ต้องไม่กลายเป็นคอขวดเงียบอีกชั้น
export const SCORER_MAX_COMPLETION_TOKENS = 10_000;

export function completionTokenBudget(model) {
  return {
    fallback: SCORER_MODELS.includes(model) ? SCORER_DEFAULT_COMPLETION_TOKENS : DEFAULT_COMPLETION_TOKENS,
    ceiling: SCORER_MAX_COMPLETION_TOKENS,
  };
}
export const DEFAULT_TIMEOUT_MS = 60_000; // reasoning model p95 เกิน 30s ได้ — chassis รอ 90s
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

// เหตุ 27 ก.ย. 2026 (เครดิต OpenAI หมด 40 นาที): log เห็นแค่ "upstream_status_429" แยกไม่ออกว่า
// เครดิตหมดหรือโดน rate limit จนต้อง probe เองบน VPS — อ่าน error body แค่พอได้ type/code
// (ตัวระบุสั้น ๆ ของ provider) ส่วน message ทิ้งเสมอ เพราะอาจสะท้อนเนื้อหาคำขอของลูกค้ากลับมา
export const MAX_UPSTREAM_ERROR_BYTES = 4 * 1024;
export const UPSTREAM_ERROR_READ_TIMEOUT_MS = 2_000;
const SAFE_ERROR_ID = /^[A-Za-z0-9_.-]{1,64}$/u;
// เครดิตหมดเป็นเรื่องของทั้งบัญชี ไม่ใช่ของโมเดลใดโมเดลหนึ่ง
const PROVIDER_CREDIT_ERROR_IDS = new Set(["insufficient_quota", "credit_balance_exhausted"]);

function safeErrorId(value) {
  if (value === undefined || value === null || value === "") return null;
  // ไม่ผ่าน allowlist = รู้แค่ว่ามีค่า แต่ห้ามพิมพ์ออก (กันบรรทัด log ปลอม/ข้อมูลแปลกปลอม)
  return typeof value === "string" && SAFE_ERROR_ID.test(value) ? value : "unrecognized";
}

function isProviderCreditFailure(failure) {
  return PROVIDER_CREDIT_ERROR_IDS.has(failure?.type) || PROVIDER_CREDIT_ERROR_IDS.has(failure?.code);
}

export async function readUpstreamErrorIds(response, {
  maxBytes = MAX_UPSTREAM_ERROR_BYTES,
  timeoutMs = UPSTREAM_ERROR_READ_TIMEOUT_MS,
} = {}) {
  const unknown = { type: null, code: null };
  const reader = response?.body?.getReader?.();
  if (!reader) return unknown;
  let timer;
  const expired = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs, null); });
  try {
    const chunks = [];
    let size = 0;
    while (true) {
      const next = await Promise.race([reader.read(), expired]);
      if (!next) return unknown; // body ช้า: ห้ามถือคำตอบของ chassis ไว้เพียงเพื่อเขียน log
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) return unknown; // ใหญ่เกินกว่าจะเป็น error object ของ provider
      chunks.push(next.value);
    }
    const failure = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.error;
    if (!failure || typeof failure !== "object") return unknown;
    return { type: safeErrorId(failure.type), code: safeErrorId(failure.code) };
  } catch {
    return unknown;
  } finally {
    clearTimeout(timer);
    reader.cancel().catch(() => {});
  }
}

function json(res, status, body, extraHeaders = {}) {
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

function error(res, status, code) {
  json(res, status, { error: { message: "Gateway request failed.", type: "gateway_error", code } });
}

function bearer(req) {
  const value = String(req.headers.authorization || "");
  const match = value.match(/^Bearer ([^\s]+)$/u);
  return match ? match[1] : "";
}

function readBody(req, maxBytes = MAX_REQUEST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    req.once("end", () => {
      if (size > maxBytes) return reject(new Error(`body_too_large:${size}>${maxBytes}`));
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch { reject(new Error("invalid_json")); }
    });
    req.once("error", () => reject(new Error("body_read_failed")));
  });
}

async function readResponseText(response, maxBytes) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("upstream_response_too_large");
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("upstream_response_invalid");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new Error("upstream_response_too_large");
    }
    chunks.push(value);
  }
  const text = new TextDecoder().decode(Buffer.concat(chunks));
  try { return JSON.parse(text); } catch { throw new Error("upstream_response_invalid"); }
}

// v1.4.27: เนื้อความรับได้ 2 ทรง — สตริงเดิม (ทุกเส้นที่ไม่ต้องการ cache) กับบล็อกข้อความ
// ที่ปัก cache breakpoint ได้ (เส้นตอบลูกค้า ซึ่งมีของคงที่ก้อนใหญ่แล้วตามด้วยของที่
// เปลี่ยนทุกเทิร์น — เอกสาร OpenAI แนะนำ explicit breakpoint กับรูปทรงนี้ตรง ๆ)
//
// ที่นี่คือด่านกรอง ไม่ใช่ที่ส่งของ: อนุญาตเฉพาะ type "text" · จำกัดจำนวนบล็อก ·
// นับความยาว "รวมทุกบล็อก" ไม่ใช่ทีละบล็อก (ไม่งั้นเลี่ยงเพดานด้วยการซอยบล็อกได้) ·
// breakpoint รับเฉพาะรูปแบบเดียวเป๊ะ ห้ามมีคีย์แปลกปลอมติดขึ้นไปกับ upstream
export const MAX_CONTENT_BLOCKS = 8;
// v1.4.48: รูปเข้ามาเพื่อ "จำแนกว่าเป็นสลิป/เอกสารหรือไม่" เท่านั้น จึงคุมให้แคบที่สุด
// data: URI เท่านั้น — ห้าม http/https เด็ดขาด เพราะลิงก์ภายนอกเท่ากับให้ผู้เรียก
// เลือกโฮสต์ปลายทางเอง (ทั้ง SSRF ฝั่งเรา และสั่งให้ upstream ไปดึงไฟล์ที่เราไม่ได้เลือก)
export const MAX_IMAGE_BYTES = 4_000_000;
export const MAX_IMAGES_PER_MESSAGE = 1;
const IMAGE_DATA_URI = /^data:image\/(?:jpeg|png);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
export function sanitizeContent(content) {
  if (typeof content === "string") {
    // JSON.stringify can preserve a lone UTF-16 surrogate as an escape, but the
    // provider requires Unicode scalar text and rejects that body as invalid_json.
    // Repair at this final outbound boundary so every caller is protected, even
    // if a legacy DB value or an unsafe String#slice reaches the gateway.
    const text = content.toWellFormed();
    if (text.length > MAX_MESSAGE_CHARS) throw new Error(`invalid_request:message_too_long:${text.length}>${MAX_MESSAGE_CHARS}`);
    return text;
  }
  if (!Array.isArray(content) || content.length < 1 || content.length > MAX_CONTENT_BLOCKS) {
    throw new Error("invalid_request:message_shape");
  }
  let total = 0;
  let images = 0;
  return content.map((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) throw new Error("invalid_request:message_shape");
    if (block.type === "image_url") {
      const holder = block.image_url;
      if (!holder || typeof holder !== "object" || Array.isArray(holder)) throw new Error("invalid_request:message_shape");
      // คีย์เดียวเป๊ะ — กติกาเดียวกับ prompt_cache_breakpoint ห้ามมีอะไรแปลกปลอมขึ้น upstream
      if (Object.keys(holder).length !== 1 || typeof holder.url !== "string") throw new Error("invalid_request:message_shape");
      if (holder.url.length > MAX_IMAGE_BYTES) throw new Error(`invalid_request:image_too_large:${holder.url.length}>${MAX_IMAGE_BYTES}`);
      if (!IMAGE_DATA_URI.test(holder.url)) throw new Error("invalid_request:message_shape:image_url");
      images += 1;
      if (images > MAX_IMAGES_PER_MESSAGE) throw new Error("invalid_request:too_many_images");
      return { type: "image_url", image_url: { url: holder.url } };
    }
    if (block.type !== "text" || typeof block.text !== "string") throw new Error("invalid_request:message_shape");
    const text = block.text.toWellFormed();
    total += text.length;
    if (total > MAX_MESSAGE_CHARS) throw new Error(`invalid_request:message_too_long:${total}>${MAX_MESSAGE_CHARS}`);
    if (block.prompt_cache_breakpoint === undefined) return { type: "text", text };
    const breakpoint = block.prompt_cache_breakpoint;
    if (!breakpoint || typeof breakpoint !== "object" || Array.isArray(breakpoint)
      || Object.keys(breakpoint).length !== 1 || breakpoint.mode !== "explicit") {
      throw new Error("invalid_request:cache_breakpoint");
    }
    return { type: "text", text, prompt_cache_breakpoint: { mode: "explicit" } };
  });
}

export function sanitizeChatRequest(body, allowedModels = ALLOWED_MODELS) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("invalid_request");
  const model = typeof body.model === "string" ? body.model : "";
  if (!allowedModels.includes(model)) throw new Error("invalid_request");
  const reasoningEffort = body.reasoning_effort === undefined ? "" : body.reasoning_effort;
  if (reasoningEffort && !ALLOWED_REASONING_EFFORTS.includes(reasoningEffort)) throw new Error("invalid_request");
  // v1.4.27: prompt_cache_key — ตัวเดียวที่ทำให้ cache ของ GPT-5.6 ติดจริง
  // (เอกสาร OpenAI: "For GPT-5.6, you must set prompt_cache_key") เป็นแค่คีย์ routing
  // ไม่ใช่เนื้อหา จึงจำกัดเป็นสตริงสั้น ๆ อักขระปลอดภัยเท่านั้น ห้ามปล่อยยาวหรือมั่วรูปแบบ
  const promptCacheKey = body.prompt_cache_key === undefined ? "" : body.prompt_cache_key;
  if (promptCacheKey !== "" && (typeof promptCacheKey !== "string" || !PROMPT_CACHE_KEY_PATTERN.test(promptCacheKey))) {
    throw new Error("invalid_request:prompt_cache_key");
  }
  const cacheOptions = body.prompt_cache_options;
  if (cacheOptions !== undefined && (
    !cacheOptions || typeof cacheOptions !== "object" || Array.isArray(cacheOptions)
    || Object.keys(cacheOptions).length !== 1 || !["explicit", "implicit"].includes(cacheOptions.mode)
  )) {
    throw new Error("invalid_request:prompt_cache_options");
  }
  const budget = completionTokenBudget(model);
  const maxCompletionTokens = body.max_completion_tokens === undefined ? budget.fallback : body.max_completion_tokens;
  if (!Number.isInteger(maxCompletionTokens) || maxCompletionTokens < 1 || maxCompletionTokens > budget.ceiling) throw new Error("invalid_request");
  if (!Array.isArray(body.messages) || body.messages.length < 1) throw new Error("invalid_request:messages_missing");
  if (body.messages.length > MAX_MESSAGES) throw new Error(`invalid_request:too_many_messages:${body.messages.length}>${MAX_MESSAGES}`);
  const messages = body.messages.map((message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) throw new Error("invalid_request");
    if (!["system", "user", "assistant"].includes(message.role)) throw new Error("invalid_request:message_shape");
    return { role: message.role, content: sanitizeContent(message.content) };
  });
  return {
    model,
    ...(promptCacheKey ? { prompt_cache_key: promptCacheKey } : {}),
    ...(cacheOptions ? { prompt_cache_options: { mode: cacheOptions.mode } } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
    max_completion_tokens: maxCompletionTokens,
    service_tier: "default", // Keep Standard pricing during the model rollback.
    store: false,
    stream: false,
    messages,
  };
}

// v1.4.9b (รีวิว 2026-08-17): แกน 3 ตัวหาย = ตายดัง (ระบบพึ่งมันเป็น default/probe)
// แต่ตัวขยายจาก roster ที่ provider ไม่มี = ตัดทิ้ง + เตือน — ห้ามให้ id เก็งกำไร
// ในไฟล์ราคากลายเป็นสวิตช์ฆ่า boot ของ pilot ทั้งตัวตอน restart
export async function verifyProviderModels({
  upstreamApiKey,
  fetchImpl = fetch,
  timeoutMs = 10_000,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  allowedModels = ALLOWED_MODELS,
} = {}) {
  if (typeof upstreamApiKey !== "string" || !upstreamApiKey.trim()) throw new Error("provider_key_required");
  let response;
  try {
    response = await fetchImpl(OPENAI_MODELS_URL, {
      method: "GET",
      headers: { authorization: `Bearer ${upstreamApiKey}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error("provider_models_unavailable");
  }
  if (!response?.ok) throw new Error("provider_models_rejected");
  const body = await readResponseText(response, maxResponseBytes);
  const available = new Set(Array.isArray(body?.data) ? body.data.map((entry) => String(entry?.id || "")) : []);
  const coreInScope = CORE_MODELS.filter((model) => allowedModels.includes(model));
  if (!coreInScope.every((model) => available.has(model))) throw new Error("provider_models_missing");
  const missing = allowedModels.filter((model) => !available.has(model));
  if (missing.length) {
    // ห้าม log เนื้อหาลูกค้า/credential — ชื่อโมเดลเป็น public id ปลอดภัย
    console.error(`[gateway] provider ไม่มีโมเดลขยาย ${missing.join(", ")} — ตัดออกจากรายการรอบนี้ (แก้ที่ model-pricing.json ของ chassis)`);
  }
  return { ok: true, models: allowedModels.filter((model) => available.has(model)), missing };
}

function hasChatContent(body) {
  return typeof body?.choices?.[0]?.message?.content === "string"
    && body.choices[0].message.content.trim().length > 0;
}

export async function verifyProviderInference({
  upstreamApiKey,
  fetchImpl = fetch,
  timeoutMs = 20_000,
  maxResponseBytes = MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof upstreamApiKey !== "string" || !upstreamApiKey.trim()) throw new Error("provider_key_required");
  // FIX 2026-08-12 (root cause ของ hermes=degraded ถาวร): โมเดลสาย reasoning ใช้
  // completion budget "คิดในใจ" ก่อนเขียนคำตอบ — cap 24 ทำ terra(effort=high) โดน
  // OpenAI ปฏิเสธ 400 ("could not finish within max_tokens") ทุกครั้งแบบ deterministic
  // -> boot verification ไม่มีทางผ่าน -> readiness เริ่ม false ตลอด -> /models/health
  // ok=false -> chassis โชว์ degraded ตั้งแต่เกิด (พิสูจน์ด้วย upstream call จริงแล้ว)
  // งบต่อโมเดลตามพฤติกรรมจริง: sol ตอบตรง, luna reasoning เบา, terra effort สูงคิดเยอะ
  const probes = [
    // 6.1 Sol ไม่รองรับ reasoning none/minimal — low + งบพอให้คิดสั้น ๆ แล้วตอบ OK
    { model: "gpt-6.1-sol", reasoning_effort: "low", max_completion_tokens: 256 },
    { model: "gpt-5.6-sol", max_completion_tokens: 64 },
    { model: "gpt-5.6-luna", max_completion_tokens: 256 },
    { model: "gpt-5.6-terra", reasoning_effort: "high", max_completion_tokens: 1024 },
  ];
  for (const probe of probes) {
    let response;
    try {
      response = await fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${upstreamApiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          ...probe,
          service_tier: "default",
          store: false,
          stream: false,
          messages: [{ role: "user", content: "Synthetic readiness probe. Reply only OK." }],
        }),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new Error("provider_inference_unavailable");
    }
    if (!response?.ok) throw new Error("provider_inference_rejected");
    const body = await readResponseText(response, maxResponseBytes);
    if (!hasChatContent(body)) throw new Error("provider_inference_invalid");
  }
  return { ok: true, models: probes.map((probe) => probe.model) };
}

export function createOpenAiStatelessGateway({
  upstreamApiKey,
  upstreamApiKey2 = "",
  localBearerToken,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  providerModelsVerified = false,
  providerInferenceVerified = false,
  allowedModels = ALLOWED_MODELS,
  readinessModels = null,
  requireAnthropicKey = false,
  anthropicApiKey = "",
  anthropicWorkspaceId = "",
  anthropicApiKey2 = "",
  anthropicWorkspaceId2 = "",
  anthropicTimeoutMs = ANTHROPIC_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  if (typeof upstreamApiKey !== "string" || !upstreamApiKey.trim() || typeof localBearerToken !== "string" || !localBearerToken.trim()) {
    throw new Error("Blocked: gateway credentials must be supplied in memory at startup.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new Error("Blocked: gateway limits are invalid.");
  }
  // กุญแจ OpenAI ตามลำดับ (ชุด 1 = หลัก) · ชุดหลักตอนนี้ = ชุดที่ตอบได้ล่าสุด เหมือนกุญแจ Claude
  const openAiKeys = [[1, upstreamApiKey], [2, upstreamApiKey2]]
    .filter(([, key]) => typeof key === "string" && key.trim() !== "")
    .map(([slot, key]) => ({ slot, key: key.trim() }));
  let activeOpenAiSlot = 1;
  let lastOpenAiSwitchAt = null;
  const openAiKeyOrder = () => [...openAiKeys.filter((entry) => entry.slot === activeOpenAiSlot), ...openAiKeys.filter((entry) => entry.slot !== activeOpenAiSlot)];
  // ส่งไป OpenAI ทีละกุญแจ: ชุดที่ตอบไม่ได้เพราะกุญแจ (401 402 403 429) = ลองชุดถัดไปด้วยเวลาที่เหลือ (อย่างน้อย 1 วิ)
  // คืน { upstream, keySlot } ของคำตอบสุดท้าย หรือโยน error ของ fetch (หมดเวลา/ต่อไม่ได้) จากชุดสุดท้ายที่ลอง
  async function forwardOpenAi(payload, budgetMs) {
    const startedAt = Date.now();
    const order = openAiKeyOrder();
    let lastError = null;
    for (const [index, entry] of order.entries()) {
      const remainingMs = budgetMs - (Date.now() - startedAt);
      if (index > 0 && remainingMs < 1_000) break;
      let upstream;
      try {
        upstream = await fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${entry.key}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(Math.max(1_000, remainingMs)),
        });
      } catch (caught) {
        lastError = caught;
        break;
      }
      const hasNext = index < order.length - 1;
      if (!upstream.ok && OPENAI_KEY_SWITCH_STATUSES.includes(Number(upstream.status)) && hasNext) {
        const { type, code } = await readUpstreamErrorIds(upstream);
        console.error(`[gateway] ${payload.model} openai-key#${entry.slot} -> upstream_status_${upstream.status}${type ? ` type=${type}` : ""}${code ? ` code=${code}` : ""} — ลองกุญแจ OpenAI ชุดถัดไป`);
        continue;
      }
      if (upstream.ok && entry.slot !== activeOpenAiSlot) {
        console.error(`[gateway] OpenAI ใช้กุญแจชุด ${entry.slot} เป็นชุดหลักแทนชุด ${activeOpenAiSlot}`);
        activeOpenAiSlot = entry.slot;
        lastOpenAiSwitchAt = new Date(now()).toISOString();
      }
      return { upstream, keySlot: entry.slot };
    }
    throw lastError || Object.assign(new Error("openai keys exhausted"), { name: "TimeoutError" });
  }
  // กุญแจที่ใช้ได้ตามลำดับ (ชุดที่ 1 ก่อน) · ชุดที่ workspace รูปแบบผิดถูกตัดทิ้งเฉพาะชุดนั้น
  const anthropicKeys = [[1, anthropicApiKey, anthropicWorkspaceId], [2, anthropicApiKey2, anthropicWorkspaceId2]]
    .filter(([, key, workspace]) => typeof key === "string" && key.trim() !== "" && (!workspace || ANTHROPIC_WORKSPACE.test(workspace)))
    .map(([slot, key, workspace]) => ({ slot, key, workspace: workspace || "" }));
  const anthropicReady = anthropicKeys.length > 0;
  // ชุดหลักตอนนี้ = ชุดที่ตอบได้ล่าสุด (เริ่มที่ชุดแรกที่ตั้งไว้) · ชุดอื่นต่อท้ายตามลำดับ
  let activeKeySlot = anthropicKeys[0]?.slot ?? null;
  let lastKeySwitchAt = null;
  function anthropicKeyOrder() {
    return [...anthropicKeys.filter((entry) => entry.slot === activeKeySlot), ...anthropicKeys.filter((entry) => entry.slot !== activeKeySlot)];
  }
  // Claude ส่งต่อไป Anthropic · ทุกความล้มเหลวคืน { ok:false } (ผู้เรียกตอบด้วยรุ่นสำรอง) — ไม่ log เนื้อหา
  async function forwardAnthropic(payload) {
    if (!anthropicReady) return { ok: false, kind: "anthropic_not_configured" };
    const startedAt = now();
    const budgetMs = Math.min(timeoutMs, anthropicTimeoutMs);
    const switched = [];
    let last = null;
    for (const entry of anthropicKeyOrder()) {
      const remainingMs = budgetMs - (now() - startedAt);
      // ชุดถัดไปต้องเหลือเวลาพอ (อย่างน้อย 1 วิ) ไม่งั้นไปตัวสำรองเลย · ชุดแรกได้เวลาเต็มเหมือนเดิม
      if (switched.length && remainingMs < 1_000) break;
      const result = await forwardAnthropicWith(entry, payload, remainingMs);
      if (result.ok) {
        // ชุดหลักหมดแล้วชุดนี้ตอบได้ = ชุดนี้เป็นชุดหลักต่อไปจนกว่าจะหมดบ้าง
        if (entry.slot !== activeKeySlot) {
          console.error(`[gateway] Claude ใช้กุญแจชุด ${entry.slot} เป็นชุดหลักแทนชุด ${activeKeySlot}`);
          activeKeySlot = entry.slot;
          lastKeySwitchAt = new Date(now()).toISOString();
        }
        return { ...result, keySlot: entry.slot };
      }
      last = { ...result, keySlot: entry.slot };
      if (result.kind !== "upstream_status" || !ANTHROPIC_KEY_SWITCH_STATUSES.includes(result.status)) break;
      switched.push({ slot: entry.slot, status: result.status });
      if (anthropicKeys.length > switched.length) {
        console.error(`[gateway] ${payload.model} key#${entry.slot} -> upstream_status_${result.status}${result.type ? ` type=${result.type}` : ""} — ลองกุญแจชุดถัดไป`);
      }
    }
    return last || { ok: false, kind: "upstream_timeout" };
  }
  async function forwardAnthropicWith({ key, workspace }, payload, timeoutBudgetMs) {
    let upstream;
    try {
      upstream = await fetchImpl(ANTHROPIC_MESSAGES_URL, {
        method: "POST",
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json", accept: "application/json",
          ...(workspace ? { "anthropic-workspace-id": workspace } : {}) },
        body: JSON.stringify(toAnthropicRequest(payload)), redirect: "error", signal: AbortSignal.timeout(timeoutBudgetMs),
      });
    } catch (caught) {
      const timedOut = caught?.name === "AbortError" || caught?.name === "TimeoutError";
      return { ok: false, kind: timedOut ? "upstream_timeout" : "upstream_unreachable" };
    }
    if (!upstream.ok) {
      const { type, code } = await readUpstreamErrorIds(upstream);
      return { ok: false, kind: "upstream_status", status: Number(upstream.status), type, code };
    }
    let body;
    try { body = await readResponseText(upstream, maxResponseBytes); } catch { return { ok: false, kind: "upstream_response_unreadable", status: Number(upstream.status) }; }
    // ตัดกลางประโยค (ชนเพดาน token) หรือปฏิเสธ = ไม่ส่งให้ลูกค้า — ตอบด้วยตัวสำรองแทน
    const stopReason = String(body?.stop_reason || "");
    if (stopReason === "max_tokens" || stopReason === "refusal") return { ok: false, kind: `stop_${stopReason}`, status: Number(upstream.status) };
    const converted = fromAnthropicResponse(body, payload.model);
    if (!hasChatContent(converted)) return { ok: false, kind: "empty_content", status: Number(upstream.status) };
    return { ok: true, body: converted };
  }
  let inflight = 0;
  const modelReadiness = new Map(allowedModels.map((model) => [model, providerInferenceVerified === true]));
  // 27 ก.ย. 2026: ความล้มเหลวที่ยังค้างของแต่ละโมเดล (หายเมื่อโมเดลนั้นสำเร็จ) = คำตอบของ "ทำไมยังไม่พร้อม"
  // ต้องเก็บรายโมเดล: ช่อง lastUpstreamError ช่องเดียวถูกความล้มเหลวเรื่องอื่นของโมเดลอื่นทับได้
  // เครดิตหมดเป็นเรื่องทั้งบัญชี จึงหายได้ด้วยความสำเร็จของโมเดลไหนก็ได้ ส่วนเหตุอื่นต้องรอโมเดลนั้นสำเร็จเอง
  const modelFailures = new Map();
  let lastUpstreamError = null;
  function markFailed(model, kind, { status = null, type = null, code = null } = {}) {
    const failure = { model, kind, status, type, code, at: new Date().toISOString() };
    modelReadiness.set(model, false);
    modelFailures.set(model, failure);
    lastUpstreamError = failure;
  }
  function markReady(model) {
    modelReadiness.set(model, true);
    modelFailures.delete(model);
    // บัญชีเรียกได้แล้ว = เติมเครดิตแล้ว — ไม่งั้นตัวสำรองอย่าง terra ที่แทบไม่ถูกเรียก
    // จะค้าง false และลาก health ให้ degraded ต่อไปทั้งที่ระบบหายแล้ว
    // เครดิตเป็นเรื่องของบัญชีผู้ให้บริการเดียวกัน — Claude ตอบได้ไม่ได้แปลว่าเครดิต OpenAI กลับมาแล้ว
    for (const [other, failure] of modelFailures) {
      if (!isProviderCreditFailure(failure) || providerOf(other) !== providerOf(model)) continue;
      modelReadiness.set(other, true);
      modelFailures.delete(other);
    }
  }
  // v1.4.9b: ความพร้อมรวม (ok) ผูกกับแกน 3 ตัวเท่านั้น — โมเดลขยายที่เงียบไป
  // (เช่นถูกเลือกใช้ชั่วคราวแล้วเลิก) ห้าม pin health ทั้งระบบเป็น degraded ถาวร
  // แต่สถานะรายตัวยังรายงานครบใน modelReadiness ให้คนอ่านเห็น
  const defaultReadiness = CORE_MODELS.filter((model) => allowedModels.includes(model));
  const readinessScope = readinessModels ?? (defaultReadiness.length ? defaultReadiness : allowedModels);
  const server = createServer(async (req, res) => {
    if (bearer(req) !== localBearerToken) return error(res, 401, "local_auth_required");
    if (req.method === "GET" && req.url === "/v1/models/health") {
      const modelReadinessObject = Object.fromEntries(allowedModels.map((model) => [model, modelReadiness.get(model) === true]));
      const providerInferenceReady = readinessScope.length > 0 && readinessScope.every((model) => modelReadiness.get(model) === true);
      return json(res, 200, {
        ok: providerModelsVerified === true && providerInferenceReady,
        providerModelsVerified: providerModelsVerified === true,
        providerInferenceReady,
        modelReadiness: modelReadinessObject,
        models: allowedModels,
        // ความล้มเหลวล่าสุดของทั้งเกตเวย์ (ประวัติสำหรับคนอ่าน ยังอยู่แม้ฟื้นแล้ว)
        lastUpstreamError,
        // ความล้มเหลวที่ยังค้าง เฉพาะโมเดลที่ยังไม่พร้อม — chassis ใช้แยก "เครดิตหมด" ออกจากเหตุอื่น
        modelFailures: Object.fromEntries(modelFailures),
        // กุญแจ Claude ที่ตั้งไว้ (เลขชุดเท่านั้น ไม่มีค่ากุญแจ) · ชุดหลักตอนนี้ · สลับครั้งล่าสุดเมื่อไร
        anthropicKeys: anthropicKeys.map(({ slot }) => ({ slot, active: slot === activeKeySlot })),
        anthropicKeyLastSwitchAt: lastKeySwitchAt,
        // กุญแจ OpenAI ที่ตั้งไว้ (เลขชุดเท่านั้น) · ชุดหลักตอนนี้ · สลับครั้งล่าสุดเมื่อไร
        openaiKeys: openAiKeys.map(({ slot }) => ({ slot, active: slot === activeOpenAiSlot })),
        openaiKeyLastSwitchAt: lastOpenAiSwitchAt,
      });
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") return error(res, 404, "not_found");
    if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return error(res, 415, "content_type_required");
    if (inflight >= MAX_INFLIGHT) return error(res, 429, "gateway_busy");

    let payload;
    try {
      payload = sanitizeChatRequest(await readBody(req), allowedModels);
    } catch (err) {
      // เดิม catch เปล่า ๆ ยุบทุกเหตุเป็น "invalid_request" เงียบ ๆ ทำให้เหตุ 2026-08-13
      // ใช้เวลาเป็นชั่วโมงกว่าจะรู้ว่าเพราะจำนวนข้อความ ไม่ใช่ขนาด body — log เหตุผล
      // อย่างเดียว ไม่ log เนื้อหา เพราะ payload มีข้อมูลลูกค้า
      console.error(`[gateway] local_reject: ${String(err?.message ?? "unknown")}`);
      return error(res, 400, "invalid_request");
    }
    inflight += 1;
    const startedAt = Date.now();
    let fallbackFrom = "";
    try {
      if (isAnthropicModel(payload.model)) {
        if (requireAnthropicKey && !anthropicKeys.length) {
          markFailed(payload.model, "provider_not_configured");
          return error(res, 503, "provider_not_configured");
        }
        const claude = await forwardAnthropic(payload);
        if (claude.ok) {
          markReady(payload.model);
          return json(res, 200, claude.body, { "x-lukprae-gateway-receipt": "stateless-forwarded", "x-lukprae-provider": "anthropic",
            "x-lukprae-served-model": payload.model, "x-lukprae-anthropic-key-slot": String(claude.keySlot) });
        }
        markFailed(payload.model, claude.kind, { status: claude.status ?? null, type: claude.type ?? null, code: claude.code ?? null });
        console.error(`[gateway] ${payload.model} -> ${claude.kind}${claude.status ? `_${claude.status}` : ""}${claude.type ? ` type=${claude.type}` : ""} — ตอบด้วย ${ANTHROPIC_FALLBACK_MODEL} แทน`);
        if (!allowedModels.includes(ANTHROPIC_FALLBACK_MODEL)) return error(res, 503, "fallback_not_allowed");
        fallbackFrom = payload.model;
        payload = { ...payload, model: ANTHROPIC_FALLBACK_MODEL };
      }
      let upstream;
      let openAiKeySlot = activeOpenAiSlot;
      // ตัวสำรองหลัง Claude ล้มใช้เวลาที่เหลือของเส้นตายเดียวกัน (อย่างน้อย 1 วิ)
      const openAiTimeoutMs = fallbackFrom
        ? Math.max(1_000, Math.min(timeoutMs, FALLBACK_DEADLINE_MS - (Date.now() - startedAt))) : timeoutMs;
      try {
        ({ upstream, keySlot: openAiKeySlot } = await forwardOpenAi(payload, openAiTimeoutMs));
      } catch (caught) {
        const timedOut = caught?.name === "AbortError" || caught?.name === "TimeoutError";
        markFailed(payload.model, timedOut ? "upstream_timeout" : "upstream_unreachable");
        // FIX 2026-08-12: log เหตุล้มเหลวเสมอ (model + เหตุ เท่านั้น — ไม่มีเนื้อหา/PII)
        // ก่อนหน้านี้ 502 โผล่ใน log ฝั่ง chassis โดยไม่มีทางรู้ว่า upstream เกิดอะไร
        console.error(`[gateway] ${payload.model} -> ${timedOut ? "upstream_timeout" : "upstream_unreachable"} (${caught?.name || "Error"})`);
        return error(res, timedOut ? 504 : 502, "upstream_unavailable");
      }
      if (!upstream.ok) {
        const upstreamStatus = Number(upstream.status);
        const { type, code } = await readUpstreamErrorIds(upstream);
        markFailed(payload.model, "upstream_status", { status: upstreamStatus, type, code });
        const definitive = upstreamStatus >= 400 && upstreamStatus < 500 && ![408, 429].includes(upstreamStatus);
        // type/code ผ่าน allowlist ตัวระบุแล้ว — ใน log ไม่มีข้อความ error หรือเนื้อหาคำขอ
        console.error(`[gateway] ${payload.model} -> upstream_status_${upstreamStatus}${definitive ? " (definitive)" : ""}${type ? ` type=${type}` : ""}${code ? ` code=${code}` : ""}`);
        return error(res, definitive ? (upstreamStatus === 401 || upstreamStatus === 403 ? upstreamStatus : 400) : (upstreamStatus === 429 ? 429 : 502), definitive ? "upstream_definitive_rejection" : "upstream_rejected");
      }
      let responseBody;
      try { responseBody = await readResponseText(upstream, maxResponseBytes); } catch {
        markFailed(payload.model, "upstream_response_unreadable", { status: Number(upstream.status) });
        console.error(`[gateway] ${payload.model} -> upstream_response_unreadable`);
        return error(res, 502, "upstream_response_invalid");
      }
      if (!hasChatContent(responseBody)) {
        markFailed(payload.model, "empty_content", { status: Number(upstream.status) });
        // เคสคลาสสิกของโมเดล reasoning: ใช้งบคิดจนหมด content ว่าง — log finish_reason ให้เห็น
        const finishReason = responseBody?.choices?.[0]?.finish_reason || "unknown";
        console.error(`[gateway] ${payload.model} -> empty_content (finish_reason=${finishReason})`);
        return error(res, 502, "upstream_response_invalid");
      }
      markReady(payload.model);
      return json(res, 200, responseBody, { "x-lukprae-gateway-receipt": "stateless-forwarded",
        "x-lukprae-served-model": payload.model, "x-lukprae-openai-key-slot": String(openAiKeySlot),
        ...(fallbackFrom ? { "x-lukprae-fallback-from": fallbackFrom } : {}) });
    } finally {
      inflight = Math.max(0, inflight - 1);
    }
  });
  // Bound incomplete local requests as well as the upstream model call.
  server.requestTimeout = requestTimeoutMs;
  server.headersTimeout = Math.min(requestTimeoutMs, 10_000);

  return {
    server,
    async listen({ host = LOCAL_HOST, port = DEFAULT_PORT } = {}) {
      if (host !== LOCAL_HOST) throw new Error("Blocked: gateway may bind only 127.0.0.1.");
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolve(); }); });
      return server.address();
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close((caught) => caught ? reject(caught) : resolve()));
    },
  };
}

export async function readStartupCredentials(stdin = process.stdin) {
  let raw = "";
  for await (const chunk of stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 16 * 1024) throw new Error("Blocked: startup credential payload is too large.");
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Blocked: stdin must contain one JSON credential object."); }
  // กุญแจ Claude แต่ละชุดมาเป็นคู่ (กุญแจ + workspace ซึ่งว่างได้) · ชุดที่ 2 มาได้โดยไม่มีชุดที่ 1
  const keys = Object.keys(parsed || {}).sort().join(",");
  const base = ["localBearerToken", "upstreamApiKey"];
  const pair1 = ["anthropicApiKey", "anthropicWorkspaceId"];
  const pair2 = ["anthropicApiKey2", "anthropicWorkspaceId2"];
  // 8 พ.ย. 2026: กุญแจ OpenAI ชุด 2 (upstreamApiKey2) มาหรือไม่มาก็ได้ ทุกรูป
  const allowed = [base, [...base, ...pair1], [...base, ...pair2], [...base, ...pair1, ...pair2]]
    .flatMap((set) => [set, [...set, "upstreamApiKey2"]]).map((set) => [...set].sort().join(","));
  if (!parsed || !allowed.includes(keys)) {
    throw new Error("Blocked: stdin credential object has unexpected keys.");
  }
  return { upstreamApiKey: parsed.upstreamApiKey, localBearerToken: parsed.localBearerToken,
    ...(parsed.upstreamApiKey2 ? { upstreamApiKey2: parsed.upstreamApiKey2 } : {}),
    ...(parsed.anthropicApiKey ? { anthropicApiKey: parsed.anthropicApiKey, anthropicWorkspaceId: parsed.anthropicWorkspaceId || "" } : {}),
    ...(parsed.anthropicApiKey2 ? { anthropicApiKey2: parsed.anthropicApiKey2, anthropicWorkspaceId2: parsed.anthropicWorkspaceId2 || "" } : {}) };
}

// Public distribution has one supported launcher; it performs no paid startup probes.
if (process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  console.error("Start gateway/serve.mjs instead.");
  process.exitCode = 2;
}
