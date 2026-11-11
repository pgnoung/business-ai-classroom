// chatMedia.mjs — renderer ที่ปลอดภัยสำหรับ media ในห้องแชท
// ข้อมูลจาก LINE/DB เป็น untrusted เสมอ: ใช้ el() เท่านั้น และไม่ fetch URL จาก metadata
import { el, rawText } from "./dom.mjs";

// ป้ายชื่อของสติกเกอร์ที่ "เรา" ส่งเอง — ต้องตรงกับภาพจริงเสมอ
// สามตัวเดิม (446:1988/1990/1992) ถูกถอดออกเพราะป้ายไม่ตรงภาพเลยสักตัว
// (ดูเหตุผลเต็มใน src/messageMedia.mjs) พอเปิดให้แสดงภาพจริงแล้ว ป้ายที่ผิด
// จะกลายเป็นการส่งรูปผิดความหมายให้ลูกค้า ไม่ใช่แค่คำอธิบายที่คลาดเคลื่อน
//
// สติกเกอร์ที่ "ลูกค้า" ส่งเข้ามาไม่ต้องมีในนี้ — ใช้ keywords จาก LINE
// และตอนนี้แสดงภาพต้นฉบับได้แล้ว
const BASIC_STICKER_VISUALS = Object.freeze({});

export function attachmentKind(attachment = {}) {
  const kind = String(attachment.kind || attachment.msg_type || attachment.type || "file").toLowerCase();
  return ["image", "file", "video", "audio", "sticker", "pdf"].includes(kind) ? kind : "file";
}

export function attachmentDisplayName(attachment = {}) {
  const name = String(attachment.original_name || attachment.fileName || attachment.label || "").trim();
  return name || (attachmentKind(attachment) === "image" ? "รูปภาพ" : "ไฟล์แนบ");
}

export function attachmentByteSize(attachment = {}) {
  const bytes = Number(attachment.byte_size ?? attachment.byteSize ?? attachment.size ?? 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function attachmentFileType(attachment = {}) {
  const mime = String(attachment.mime || attachment.content_type || "").toLowerCase();
  const name = attachmentDisplayName(attachment);
  const extension = name.match(/\.([a-z0-9]{1,10})$/iu)?.[1]?.toUpperCase() || "";
  if (mime === "application/pdf" || extension === "PDF") return "PDF";
  if (/spreadsheet|excel|csv/u.test(mime) || ["XLS", "XLSX", "CSV"].includes(extension)) return extension || "SHEET";
  if (/word|document|rtf/u.test(mime) || ["DOC", "DOCX", "RTF"].includes(extension)) return extension || "DOC";
  if (/presentation|powerpoint/u.test(mime) || ["PPT", "PPTX"].includes(extension)) return extension || "PPT";
  if (/zip|compressed|archive/u.test(mime) || ["ZIP", "RAR", "7Z"].includes(extension)) return extension || "ZIP";
  if (attachmentKind(attachment) === "audio") return "เสียง";
  if (attachmentKind(attachment) === "video") return "วิดีโอ";
  return extension || "ไฟล์";
}

function canPlayAttachment(attachment, kind) {
  const mime = String(attachment.mime || attachment.content_type || "").toLowerCase();
  return (kind === "audio" && mime.startsWith("audio/")) || (kind === "video" && mime.startsWith("video/"));
}

export function attachmentRenderMode(attachment = {}) {
  const kind = attachmentKind(attachment);
  const status = String(attachment.status || "ready").toLowerCase();
  if (status !== "ready" || !attachmentUrl(attachment)) return "unavailable";
  if (kind === "image") return "image";
  if (canPlayAttachment(attachment, kind)) return kind;
  return "file";
}

export function friendlyUnavailableReason(reason) {
  const code = String(reason || "").trim().toLowerCase();
  const labels = {
    expired: "ไฟล์ต้นฉบับหมดอายุแล้ว",
    unavailable: "ไม่มีไฟล์ต้นฉบับให้เปิด",
    not_captured: "ระบบยังไม่ได้เก็บไฟล์ต้นฉบับ",
    pending: "กำลังเตรียมไฟล์ให้เปิด",
    "คลังสื่อถึงเพดาน": "คลังสื่อเต็ม จึงไม่ได้เก็บไฟล์ต้นฉบับ",
    "line ไม่ให้ดาวน์โหลดภาพสติกเกอร์ผ่าน content api": "LINE ไม่อนุญาตให้ดึงภาพสติกเกอร์ต้นฉบับ",
    "ยังไม่ได้เปิดเก็บไฟล์จาก line": "ช่วงเวลานั้นระบบยังไม่ได้เปิดเก็บไฟล์ต้นฉบับ",
  };
  if (code.includes("รอดาวน์โหลดจาก line") || code === "legacy_recovery_queued" || code.startsWith("line content retry")) {
    return "กำลังกู้/เตรียมไฟล์จาก LINE";
  }
  return labels[code] || "ไม่สามารถเปิดไฟล์ต้นฉบับได้";
}

// Import เก่าเก็บ marker ภาษาไทยไว้ใน content; ถ้ามี attachment ที่แทน marker นั้นแล้ว
// ต้องซ่อน marker เฉพาะตัวนั้น ไม่เช่นนั้นทีมจะเห็น "[รูปภาพ]" ซ้ำหน้าการ์ดรูป
export function stripRepresentedMediaMarkers(content, attachments = []) {
  let text = String(content || "");
  const kinds = new Set((Array.isArray(attachments) ? attachments : []).map(attachmentKind));
  const patterns = [];
  if (kinds.has("image")) patterns.push(/\[(?:รูปภาพ|image)(?::[^\]]*)?\]/giu);
  if (kinds.has("sticker")) patterns.push(/\[(?:สติกเกอร์|sticker)(?::[^\]]*)?\]/giu);
  if (kinds.has("file") || kinds.has("pdf")) patterns.push(/\[(?:ไฟล์|file)(?:\s+[^\]]*)?\]/giu);
  if (kinds.has("video")) patterns.push(/\[(?:วิดีโอ|video)(?::[^\]]*)?\]/giu);
  if (kinds.has("audio")) patterns.push(/\[(?:เสียง|audio)(?::[^\]]*)?\]/giu);
  for (const pattern of patterns) text = text.replace(pattern, "");
  return text.replace(/\n{3,}/gu, "\n\n").trim();
}

function attachmentUrl(attachment) {
  if (typeof attachment.consoleUrl === "string" && attachment.consoleUrl.startsWith("/")) return attachment.consoleUrl;
  if (typeof attachment.contentUrl === "string" && attachment.contentUrl.startsWith("/")) return attachment.contentUrl;
  const id = String(attachment.id || "");
  return /^[a-zA-Z0-9_-]{1,128}$/u.test(id) ? `/console/api/attachments/${encodeURIComponent(id)}/content` : "";
}

function stickerIdentifiers(attachment) {
  const meta = attachment.provider_meta || attachment.providerMeta || attachment.metadata || attachment;
  // historical importer keeps sticker data under provider_meta.sticker; live rows are flat.
  const sticker = meta?.sticker && typeof meta.sticker === "object" ? meta.sticker : meta;
  const packageId = String(sticker?.packageId || sticker?.package_id || "");
  const stickerId = String(sticker?.stickerId || sticker?.sticker_id || "");
  return {
    packageId: /^\d{1,20}$/u.test(packageId) ? packageId : "",
    stickerId: /^\d{1,20}$/u.test(stickerId) ? stickerId : "",
    resourceType: String(sticker?.stickerResourceType || sticker?.sticker_resource_type || "STATIC").toUpperCase(),
  };
}

function stickerDescription(attachment = {}) {
  const meta = attachment.provider_meta || attachment.providerMeta || attachment.metadata || attachment;
  const sticker = meta?.sticker && typeof meta.sticker === "object" ? meta.sticker : meta;
  const keywords = Array.isArray(sticker?.keywords)
    ? sticker.keywords.map((value) => String(value || "").trim()).filter(Boolean).slice(0, 15)
    : [];
  const text = String(sticker?.text || "").trim().slice(0, 200);
  if (keywords.length) return `สติกเกอร์ (${keywords.join(", ")})`;
  if (text) return `สติกเกอร์ (${text})`;
  return "สติกเกอร์ LINE";
}

function validEmojiIdentifiers(emoji) {
  const productId = String(emoji?.productId || emoji?.product_id || "");
  const emojiId = String(emoji?.emojiId || emoji?.emoji_id || "");
  return /^[a-zA-Z0-9_-]{1,80}$/u.test(productId) && /^\d{1,20}$/u.test(emojiId)
    ? { productId, emojiId }
    : null;
}

// คำสั่งพี่ง้วง 2026-08-26: "เอาให้มี sticker ด้วย ไม่อย่างนั้นชมพู่จะรู้ได้ยังไงว่าคืออะไร"
//
// Messaging API ให้แค่ id กับ keywords ไม่ให้ไบต์ของภาพ แต่ Sticker Shop เปิดภาพ
// สติกเกอร์ชุดมาตรฐานให้ดึงตรงได้ เราจึงลองโหลดภาพจริงมาแสดง และถ้าโหลดไม่ขึ้น
// (สติกเกอร์ที่ผู้ใช้ซื้อ/ทำเอง, ชุดที่ถูกถอด, เน็ตมีปัญหา) ให้ตกกลับไปเป็นข้อความเดิม
// ทันที — คำอธิบายเป็นตัวอักษรยังเป็นพื้นฐานที่รับประกัน ภาพเป็นของแถมที่พังได้
//
// เงื่อนไขที่ยอมให้ลองโหลด: id เป็นตัวเลขล้วนและไม่ยาวเกิน 12 หลัก
// สติกเกอร์แบบข้อความ/แบบกำหนดเอง ใช้ id 18 หลักซึ่งไม่มีภาพให้ดึง จึงไม่ต้องลองให้เสียเวลา
const STICKER_CDN_MAX_ID_DIGITS = 12;
const STICKER_IMAGE_UNSUPPORTED = new Set(["MESSAGE", "NAME_TEXT", "PER_STICKER_TEXT", "CUSTOM"]);

export function stickerImageUrl(ids = {}) {
  const stickerId = String(ids.stickerId || "");
  if (!/^\d{1,20}$/u.test(stickerId) || stickerId.length > STICKER_CDN_MAX_ID_DIGITS) return "";
  if (STICKER_IMAGE_UNSUPPORTED.has(String(ids.resourceType || "").toUpperCase())) return "";
  return `https://stickershop.line-scdn.net/stickershop/v1/sticker/${stickerId}/ANDROID/sticker.png`;
}

export function stickerVisual(attachment = {}) {
  const ids = stickerIdentifiers(attachment);
  const curated = BASIC_STICKER_VISUALS[`${ids.packageId}:${ids.stickerId}`];
  return {
    ...ids,
    label: curated?.label || String(attachment.label || stickerDescription(attachment)),
    symbol: curated?.symbol || String(attachment.symbol || "☺"),
    imageUrl: stickerImageUrl(ids),
  };
}

// LINE emoji เก็บ index/length ในข้อความจริง; ถ้าข้อมูลไม่ครบ ให้แสดงข้อความเดิมอย่างปลอดภัย
export function lineEmojiSegments(content, metadata = {}) {
  const text = String(content || "");
  const emojis = Array.isArray(metadata?.emojis) ? metadata.emojis : [];
  const valid = emojis
    .map((emoji) => ({ ...emoji, index: Number(emoji.index), length: Number(emoji.length), ids: validEmojiIdentifiers(emoji) }))
    .filter((emoji) => Number.isInteger(emoji.index) && Number.isInteger(emoji.length) && emoji.index >= 0 && emoji.length > 0 && emoji.index + emoji.length <= text.length && emoji.ids)
    .sort((a, b) => a.index - b.index);
  if (!valid.length) return [{ type: "text", value: text }];
  const segments = [];
  let cursor = 0;
  for (const emoji of valid) {
    if (emoji.index < cursor) continue;
    if (emoji.index > cursor) segments.push({ type: "text", value: text.slice(cursor, emoji.index) });
    const placeholder = text.slice(emoji.index, emoji.index + emoji.length);
    segments.push({ type: "emoji", value: placeholder, productId: emoji.ids.productId, emojiId: emoji.ids.emojiId });
    cursor = emoji.index + emoji.length;
  }
  if (cursor < text.length) segments.push({ type: "text", value: text.slice(cursor) });
  return segments;
}

export function textWithLineEmoji(content, metadata = {}) {
  // ข้อความแชทคือคำพูดของคนจริง — แสดงตามจริงเสมอ ไม่ผ่านตัวแปลงชื่อแบรนด์ (rawText)
  return lineEmojiSegments(content, metadata).map((segment) => segment.type === "text"
    ? rawText(segment.value)
    : el("span", {
        class: "line-emoji-token", title: "LINE emoji (แสดงข้อความแทนภาพ)",
        "aria-label": `LINE emoji ${segment.value}`,
      }, segment.value));
}

export function attachmentCard(attachment) {
  const kind = attachmentKind(attachment);
  const name = attachmentDisplayName(attachment);
  const url = attachmentUrl(attachment);
  const mode = attachmentRenderMode(attachment);
  const unavailable = mode === "unavailable";
  if (kind === "sticker") {
    const visual = stickerVisual(attachment);
    const card = el("div", { class: "message-sticker", role: "img", "aria-label": visual.label });
    const symbol = el("span", { class: "message-sticker-symbol", "aria-hidden": "true" }, visual.symbol);
    const copy = el("span", { class: "message-sticker-copy" },
      el("strong", {}, visual.label),
      el("small", {}, visual.imageUrl ? "สติกเกอร์จากลูกค้า" : "สติกเกอร์แบบกำหนดเอง — LINE ไม่ให้ภาพต้นฉบับ"));
    if (!visual.imageUrl) {
      card.append(symbol, copy);
      return card;
    }
    // ขึ้นภาพก่อน ถ้าโหลดไม่สำเร็จค่อยสลับกลับเป็นสัญลักษณ์+ข้อความ
    // ห้ามปล่อยให้เหลือกล่องว่าง เพราะคนอ่านจะไม่รู้เลยว่าลูกค้าส่งอะไรมา
    const image = el("img", {
      class: "message-sticker-img", src: visual.imageUrl, alt: visual.label,
      loading: "lazy", referrerPolicy: "no-referrer", decoding: "async",
      onerror: () => { image.remove(); card.prepend(symbol); },
    });
    card.append(image, copy);
    return card;
  }
  if (unavailable) {
    const status = String(attachment.status || "").toLowerCase();
    const reason = attachment.unavailable_reason || (status === "queued" ? "pending" : status);
    return el("div", { class: "media-unavailable", role: "note" }, friendlyUnavailableReason(reason));
  }
  if (mode === "image") {
    return el("a", { class: "media-image-link", href: url, target: "_blank", rel: "noopener", title: "เปิดรูปขนาดเต็ม" },
      el("img", { class: "bubble-img media-image", src: url, alt: name, loading: "lazy" }));
  }
  if (mode === "audio" || mode === "video") {
    const media = mode === "audio"
      ? el("audio", { class: "media-player media-audio", src: url, controls: true, preload: "metadata" })
      : el("video", { class: "media-player media-video", src: url, controls: true, preload: "metadata" });
    return el("div", { class: "media-playable" },
      el("div", { class: "media-playable-head" },
        el("span", { class: "media-file-icon", "aria-hidden": "true" }, attachmentFileType(attachment)),
        el("span", { class: "media-file-main" }, el("strong", {}, name), el("small", {}, attachmentByteSize(attachment) || "ไฟล์จาก LINE"))),
      media,
      el("a", { class: "media-download-link", href: url, target: "_blank", rel: "noopener", download: name }, "เปิดหรือดาวน์โหลด"),
    );
  }
  const icon = attachmentFileType(attachment);
  const size = attachmentByteSize(attachment);
  return el("a", { class: "media-file-card", href: url, target: "_blank", rel: "noopener", title: `เปิด ${name}` },
    el("span", { class: "media-file-icon", "aria-hidden": "true" }, icon),
    el("span", { class: "media-file-main" },
      el("strong", {}, name),
      el("small", {}, [attachmentFileType(attachment), size, "เปิดหรือดาวน์โหลด"].filter(Boolean).join(" · ")),
    ));
}

// 2026-08-24 (คำสั่งพี่ง้วง "sticker ที่มองไม่เห็น"): แถวเก่าก่อน backend เก็บ metadata
// ถูกบันทึกเป็นข้อความดิบ "[sticker] id=..." — แปลงเป็นตัวเรนเดอร์สติกเกอร์ปกติ
// (id ≤ 12 หลักได้ภาพจาก CDN; id ยาว = สติกเกอร์ custom ที่ LINE ไม่ให้ภาพ → การ์ด label)
const LEGACY_STICKER_TEXT_RE = /^\[(?:sticker|สติกเกอร์)\](?:\s+id=(\d{1,20}))?$/u;
// เศษ id หลัง marker ถูก strip แล้ว (แถว msg_type=sticker เก่า: การ์ดถูก synthesize จาก
// metadata ว่าง ๆ ส่วน id จริงค้างอยู่ในข้อความ) — จับเฉพาะเมื่อมีการ์ดสติกเกอร์อยู่แล้ว
// เพื่อไม่กินข้อความลูกค้าที่พิมพ์ "id=..." เองจริง ๆ
const STICKER_ID_REMNANT_RE = /^id=(\d{1,20})$/u;

export function messageBody(content, attachments = [], metadata = {}) {
  const nodes = [];
  let list = Array.isArray(attachments) ? attachments : [];
  let text = stripRepresentedMediaMarkers(content, list);
  const hasStickerCard = list.some((a) => String(a?.kind || "") === "sticker");
  const remnant = text && hasStickerCard ? STICKER_ID_REMNANT_RE.exec(text.trim()) : null;
  if (remnant) {
    // เติม id เข้าการ์ดสติกเกอร์ที่ยังไม่มี id — id สั้นจะได้ภาพจาก CDN, id ยาวได้การ์ด label
    list = list.map((a) => {
      if (String(a?.kind || "") !== "sticker") return a;
      const meta = a.provider_meta && typeof a.provider_meta === "object" ? a.provider_meta : {};
      return meta.stickerId || meta.sticker_id ? a : { ...a, provider_meta: { ...meta, stickerId: remnant[1] } };
    });
    text = "";
  }
  const legacySticker = text && !list.length ? LEGACY_STICKER_TEXT_RE.exec(text.trim()) : null;
  if (legacySticker) {
    nodes.push(attachmentCard({ kind: "sticker", provider_meta: legacySticker[1] ? { stickerId: legacySticker[1] } : {} }));
  } else if (text) {
    nodes.push(el("p", { class: "bubble-text" }, textWithLineEmoji(text, metadata)));
  }
  for (const attachment of list) nodes.push(attachmentCard(attachment));
  if (!nodes.length) nodes.push(el("p", { class: "bubble-text bubble-empty" }, "[ข้อความไม่มีเนื้อหา]"));
  return nodes;
}

// Every operator upload, including images, is a recipient-scoped private
// attachment. The server mints a short-lived provider capability only while
// sending; the browser never receives or persists that bearer URL.
export function buildComposerReplyPayload({ text = "", attachments = [], sticker = null } = {}) {
  const list = Array.isArray(attachments) ? attachments : [];
  const attachmentIds = list
    .filter((attachment) => /^[a-zA-Z0-9_-]{1,128}$/u.test(String(attachment.id || "")))
    .map((attachment) => attachment.id);
  const body = { text: String(text || "").trim(), attachmentIds };
  if (sticker) body.sticker = { packageId: sticker.packageId, stickerId: sticker.stickerId };
  return body;
}

// Native outbound stickers have no binary attachment row. Turn their persisted
// message metadata into a renderer input so `[sticker]` never leaks to operators.
export function attachmentsForMessageRender(attachments = [], msgType = "", metadata = {}) {
  const list = Array.isArray(attachments) ? [...attachments] : [];
  if (metadata?.mediaAttachmentSkipped && !list.length && ["image", "file", "audio", "video"].includes(String(msgType))) {
    list.push({
      kind: String(msgType),
      status: "unavailable",
      unavailable_reason: String(metadata.mediaUnavailableReason || "คลังสื่อถึงเพดาน"),
    });
  }
  if (String(msgType) === "sticker" && !list.some((attachment) => attachmentKind(attachment) === "sticker")) {
    list.push({ kind: "sticker", provider_meta: metadata && typeof metadata === "object" ? metadata : {} });
  }
  return list;
}
