// transcribe.mjs — B3: ข้อความเสียงลูกค้า -> ตัวอักษร (LINE content -> transcription API)
//
// กติกาเหล็ก:
// - fail-closed แบบเดียวกับ lineClient: LINE_MOCK_URL = ยิง mock ได้เสมอ /
//   live ต้องเปิด LINE_LIVE_SEND + มี access token เท่านั้น
// - ไม่มี OPENAI_API_KEY = ฟีเจอร์ปิด (transcribeEnabled=false) — คืน { ok:false } ทันที
// - เสียงอยู่ใน memory buffer เท่านั้น ห้ามเขียน temp file ห้ามเก็บ binary ลง DB
// - ทุก fetch มี AbortSignal.timeout (download 30s / transcribe 60s) + เพดานไฟล์ 15MB
// - multipart ประกอบเองด้วย boundary (zero-dep — ไม่มี form-data ให้ใช้)
import { randomUUID } from "node:crypto";

const LINE_DATA_API_BASE = "https://api-data.line.me"; // host คนละตัวกับ api.line.me
const DOWNLOAD_TIMEOUT_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

export function createTranscriber({ config, fetchImpl = (...args) => globalThis.fetch(...args), logger = console }) {
  const usingMock = Boolean(config.lineMockUrl);
  const lineBase = (config.lineMockUrl || LINE_DATA_API_BASE).replace(/\/+$/, "");
  const openaiBase = (config.openaiBase || "https://api.openai.com/v1").replace(/\/+$/, "");
  const enabled = config.transcribeEnabled === true;

  // GET เนื้อไฟล์เสียงจาก LINE — ทุกความล้มเหลวคืน { ok:false, reason } ห้าม throw
  // W3: accessToken (token ของสาขา) ชนะ env — ไม่ส่งมา = ใช้ env (พฤติกรรมเดิม)
  async function downloadAudio(messageId, accessToken = null) {
    const token = accessToken || config.lineChannelAccessToken;
    if (!usingMock && !(config.lineLiveSend === true && token)) {
      return { ok: false, reason: "line_blocked" };
    }
    let res;
    try {
      res = await fetchImpl(`${lineBase}/v2/bot/message/${encodeURIComponent(String(messageId))}/content`, {
        method: "GET",
        headers: { authorization: `Bearer ${token || "mock-token"}` },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn?.(`transcribe: ดาวน์โหลดเสียงล้มเหลว (${err?.name || "Error"}: ${err?.message || err})`);
      return { ok: false, reason: "download_failed" };
    }
    if (!res?.ok) return { ok: false, reason: `download_http_${res?.status ?? "?"}` };

    const declared = Number(res.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
      return { ok: false, reason: "audio_too_large" };
    }
    let buffer;
    try {
      buffer = Buffer.from(await res.arrayBuffer());
    } catch {
      return { ok: false, reason: "download_read_failed" };
    }
    if (buffer.length === 0) return { ok: false, reason: "audio_empty" };
    if (buffer.length > MAX_AUDIO_BYTES) return { ok: false, reason: "audio_too_large" };
    const contentType = res.headers?.get?.("content-type") || "audio/m4a";
    return { ok: true, buffer, contentType };
  }

  // multipart/form-data แบบประกอบมือ: model + language=th + file
  function buildMultipart({ buffer, contentType }) {
    const boundary = `----chassis-${randomUUID()}`;
    const field = (name, value) =>
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
    const fileHead = Buffer.from(
      `--${boundary}\r\ncontent-disposition: form-data; name="file"; filename="voice.m4a"\r\n` +
      `content-type: ${contentType}\r\n\r\n`
    );
    const body = Buffer.concat([
      field("model", config.transcribeModel || "whisper-1"),
      field("language", "th"),
      fileHead,
      buffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return { body, boundary };
  }

  async function requestTranscript(audio) {
    const { body, boundary } = buildMultipart(audio);
    let res;
    try {
      res = await fetchImpl(`${openaiBase}/audio/transcriptions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${config.openaiApiKey}`,
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        body,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
      });
    } catch (err) {
      logger.warn?.(`transcribe: เรียก transcription ล้มเหลว (${err?.name || "Error"}: ${err?.message || err})`);
      return { ok: false, reason: "transcribe_failed" };
    }
    if (!res?.ok) return { ok: false, reason: `transcribe_http_${res?.status ?? "?"}` };
    let data;
    try {
      data = await res.json();
    } catch {
      return { ok: false, reason: "transcribe_bad_json" };
    }
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    if (!text) return { ok: false, reason: "empty_transcript" };
    return { ok: true, text };
  }

  // จุดเข้าเดียว: คืน { ok:true, text } หรือ { ok:false, reason } เสมอ (ไม่มี throw)
  async function transcribe({ messageId, accessToken = null } = {}) {
    if (!enabled) return { ok: false, reason: "no_api_key" };
    if (!messageId) return { ok: false, reason: "no_message_id" };
    const audio = await downloadAudio(messageId, accessToken);
    if (!audio.ok) return audio;
    return requestTranscript(audio); // buffer ตายพร้อม scope นี้ — ไม่เก็บที่ไหนต่อ
  }

  return { transcribe, enabled };
}
