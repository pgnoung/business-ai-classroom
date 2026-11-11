// chat.mjs — chat workspace: รายการแชท (inbox.mjs) + ห้องแชท + แผงข้อมูล (context.mjs)
// เดสก์ท็อป ≥1024px: split view [รายการ 360px | ห้องแชท | ข้อมูล 340px พับได้]
// มือถือ: ทีละหน้า — #/chat = รายการ, #/c/<id> = ห้องแชท (แผงข้อมูลเป็นแผ่นเลื่อน)
// G4: ฟองแชทมีตัวคั่นวัน, โหลดข้อความเก่ากว่า (keyset), ปุ่ม "↓ ล่าสุด" ตอนเลื่อนขึ้น
import { el, fmtTime } from "./dom.mjs";
import { whyPanel } from "./whyPanel.mjs";
import { customerLabel, avatarEl, slipCard, segmentOf, SEGMENT_META, emptyArt, followupSuppressionBadge } from "./ui.mjs";
import { createConvoPane, revealActiveChip } from "./inbox.mjs";
import { createContextPane } from "./context.mjs";
import { attachmentsForMessageRender, buildComposerReplyPayload, messageBody, stickerVisual } from "./chatMedia.mjs";
import { openPhotoEditor } from "./photoEditor.mjs";
import { yoloEvidenceChip, yoloHeadControl } from "./yolo.mjs";
import { adReferralBanner } from "./adReferral.mjs";
import {
  aiOffBy, aiOffWhyText, fbClosedBadge, isAdvanceQueue, isHotFollowFilter, isNotQualifiedOff, isWaitingFilter, nextWaitingId,
  resolveRoom, roomHash, setSpam, spanLabel,
} from "./triage.mjs";

// v1.4.33: จำนวนข้อความที่โหลดต่อครั้ง — ตั้งจากข้อมูลจริงของ pilot ไม่ได้เดา
// ลูกค้าที่คุยเยอะสุดมี 786 ข้อความใน 8 วัน (~98/วัน) และหนึ่งช่วงคุยเฉลี่ย ~34 ข้อความ
// 80 = เปิดห้องแล้วเห็นย้อนหลังประมาณวันล่าสุดเต็ม ๆ โดยยังเปิดไวอยู่
// กดดูเก่ากว่าอีกครั้งได้ 80 ต่อครั้ง -> ย้อนถึงข้อความแรกสุดใน ~10 ครั้ง
// ประวัติไม่มีวันหาย: ย้อนได้จนถึงข้อความแรกที่เคยคุยกันเสมอ (ข้ามช่วง /reset ด้วย)
const CHAT_PAGE = 80;

// perf 2026-08-24: cache ผล inbox ระหว่างเปิดห้อง — รายละเอียดที่จุดใช้ใน renderChat
const INBOX_TTL_IN_ROOM_MS = 30_000;
let inboxCache = { at: 0, key: "", data: null };

const BUSINESS_FILE_EXTENSIONS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "txt", "md", "json", "zip", "mp4", "mov", "m4a", "mp3"]);
const BUSINESS_FILE_MIMES = new Set([
  "application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "text/csv", "text/plain", "text/markdown", "application/json", "application/zip",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "video/mp4", "video/quicktime", "audio/mp4", "audio/mpeg",
]);

function fileExtension(file = {}) {
  return String(file.name || "").match(/\.([a-z0-9]{1,10})$/iu)?.[1]?.toLowerCase() || "";
}

function isSupportedBusinessFile(file = {}) {
  return BUSINESS_FILE_MIMES.has(String(file.type || "").toLowerCase()) || BUSINESS_FILE_EXTENSIONS.has(fileExtension(file));
}

function fileKind(file = {}) {
  const type = String(file.type || "").toLowerCase();
  if (type.startsWith("audio/") || ["m4a", "mp3"].includes(fileExtension(file))) return "audio";
  if (type.startsWith("video/") || ["mp4", "mov"].includes(fileExtension(file))) return "video";
  return "file";
}

function attachmentTypeLabel(attachment = {}) {
  const type = String(attachment.mime || "").toLowerCase();
  const extension = fileExtension({ name: attachment.label || "" }).toUpperCase();
  if (type === "application/pdf" || extension === "PDF") return "PDF";
  if (attachment.kind === "audio") return "เสียง";
  if (attachment.kind === "video") return "วิดีโอ";
  return extension || "ไฟล์";
}

// พัก full re-render เฉพาะตอนมีข้อมูลที่ผู้ใช้ยังไม่บันทึกจริง ๆ เท่านั้น
// ช่องตอบที่ว่างแต่ยัง focus อยู่ต้อง poll ต่อ — เป็นสถานะปกติหลังสลับกลับจาก LINE
// และถ้าหยุดเพราะ focus อย่างเดียว ข้อความลูกค้า/AI จะค้างจนกด refresh มือ
// v1.4.13 (audit จับ): "รูปที่แนบไว้/กำลังอัปโหลด/กำลังส่ง" ก็คืองานค้างในช่องตอบเหมือน
// ข้อความที่พิมพ์ค้าง — ถ้า re-render ทับระหว่างนั้น ปุ่ม/ชิปจะกลายเป็น DOM ที่ถูกถอดแล้ว
// (รูปล่องหนแต่ยังถูกส่งจริง / ปุ่มส่งกลับมากดได้ = ส่งซ้ำ) จึงต้องพัก full re-render ด้วย
export function shouldDeferChatRefresh({ replyInput = null, activeElement = null, composerBusy = false } = {}) {
  return chatRefreshMode({ replyInput, activeElement, composerBusy }) !== "full";
}

// audit 2026-08-26 (วิกฤต): เดิม "มีข้อความพิมพ์ค้าง" = หยุดอัปเดตทั้งหน้า ทั้งห้องแชท
// และรายการซ้าย โดยไม่มีอะไรบอกผู้ใช้เลย พิมพ์ค้างไว้แล้วไปทำอย่างอื่น 25 นาที
// = ลูกค้าคนอื่นทักเข้ามาแล้วไม่ขึ้นสักคน หน้าจอดูเงียบเหมือนไม่มีใครทัก
//
// แยกเป็นสามระดับแทน:
//   skip      = กำลังส่งอยู่จริง ๆ หรือโฟกัสอยู่ในตัวควบคุมที่ห้ามถูกถอด — ห้ามแตะอะไรเลย
//   list-only = มีข้อความ/ไฟล์แนบค้าง — ห้าม rebuild ห้อง (ชิปจะกลายเป็น DOM ที่ถูกถอดแล้ว
//               เสี่ยงส่งซ้ำ) แต่ "รายการซ้ายต้องอัปเดตต่อ" เพื่อให้เห็นว่ามีคนทักเข้ามา
//   full      = ปกติ
export function chatRefreshMode({ replyInput = null, activeElement = null, composerBusy = false, pendingAttachments = 0 } = {}) {
  if (composerBusy === true) return "skip";
  if (activeElement?.classList?.contains("keep-focus")) return "skip";
  if (Boolean(replyInput?.value?.trim()) || Number(pendingAttachments) > 0) return "list-only";
  return "full";
}

// ใช้ร่วมกันทั้ง timer และ visibilitychange เพื่อไม่ให้สองเส้นทางตีความ focus ต่างกัน
// คืน true เฉพาะเมื่อได้เรียก render จริง — ทำให้ regression test ตรวจ lifecycle ได้โดยไม่แตะ LINE
export async function refreshChatIfReady({
  documentRef,
  render,
  customerId = null,
  filter = null,
  requireVisible = false,
  requireWorkspace = false,
}) {
  const visibility = documentRef.visibilityState;
  if (requireVisible ? visibility !== "visible" : visibility === "hidden") return false;
  if (requireWorkspace && !documentRef.querySelector(".chat-workspace")) return false;
  const replyInput = documentRef.querySelector(".reply-input");
  const composerBusy = Boolean(documentRef.querySelector(".reply-bar.is-busy"));
  // documentRef อาจเป็น document ปลอมในเทสต์ หรือเบราว์เซอร์เก่าที่ไม่มีเมธอดนี้
  // ห้ามให้การนับไฟล์แนบทำให้ทั้ง poll ล้ม — นับไม่ได้ = ถือว่าไม่มี
  const pendingAttachments = typeof documentRef.querySelectorAll === "function"
    ? documentRef.querySelectorAll(".attach-chips .attach-chip").length
    : 0;
  const mode = chatRefreshMode({ replyInput, activeElement: documentRef.activeElement, composerBusy, pendingAttachments });
  if (mode === "skip") return false;
  await render({ customerId, filter, poll: true, listOnly: mode === "list-only" });
  return true;
}

export function captureChatLoadScope(state, customerId) {
  return {
    customerId,
    routeGen: state.routeGen ?? 0,
    chatRef: state.chat,
  };
}

export function isChatLoadScopeCurrent(state, scope) {
  return state.chat === scope.chatRef &&
    state.chat?.id === scope.customerId &&
    (state.routeGen ?? 0) === scope.routeGen;
}

export function applyOlderPageIfCurrent(state, scope, response) {
  if (!isChatLoadScopeCurrent(state, scope)) return false;
  state.chat.older = [...(response.messages || []), ...state.chat.older];
  state.chat.hasMoreOlder = response.hasMoreOlder === true;
  return true;
}

// LINE Messaging API has no per-user/per-message customer read receipt.
// These chips deliberately separate provider acceptance from a later customer
// interaction so the Console never manufactures an "อ่านแล้ว" state.
export function messageEvidenceChips(message = {}) {
  const chips = [];
  const image = message.direction === "in" ? message.imageClassification : null;
  if (image) {
    const kind = { slip: "สลิป", document: "เอกสาร", other: "ภาพทั่วไป", unknown: "ยังไม่ทราบ" }[String(image.classified_kind)] || "ยังไม่ทราบ";
    const observed = String(image.classification_state) === "classified";
    const diagnostic = {
      disabled: "การตรวจรูปปิดอยู่",
      no_file: "ไม่พบไฟล์รูปให้ตรวจ",
      read_error: "อ่านไฟล์รูปไม่ได้",
      no_bytes: "ไม่พบข้อมูลรูปให้ตรวจ",
      too_large: "รูปใหญ่เกินกว่าจะตรวจ",
      bad_mime: "ชนิดไฟล์รูปไม่รองรับ",
      no_model: "ระบบตรวจรูปยังไม่พร้อม",
      model_error: "ตรวจรูปไม่สำเร็จ",
      unparsable: "ผลตรวจรูปอ่านไม่ได้",
      invalid_response: "ผลตรวจรูปไม่สมบูรณ์",
      unavailable: "ยังไม่มีผลตรวจรูป",
    }[String(image.diagnostic_code)] || "ยังไม่มีผลตรวจรูป";
    const planned = image.action === "text_pipeline" ? "ประมวลผลข้อความ" : "ให้คนตรวจ";
    chips.push({
      kind: "image-classification",
      tone: observed ? "interaction" : "ambiguous",
      label: observed ? `👁 ตรวจพบ: ${kind}` : `👁 ${diagnostic}`,
      title: observed
        ? `ข้อมูลที่สังเกตได้: ระบบจัดเป็น ${kind}; แผนเส้นทางที่เลือก: ${planned}. ไม่ใช่สถานะส่งหรือตอบแล้ว`
        : `ข้อมูลที่สังเกตได้: ${diagnostic}; แผนเส้นทางที่เลือก: ${planned}. ไม่ใช่สถานะส่งหรือตอบแล้ว`,
    });
  }
  if (message.direction !== "out") return chips;
  const yolo = yoloEvidenceChip(message); // 2026-09-28: ข้อความที่ลูกแพรส่งตามคำสั่ง YOLO
  if (yolo) chips.push(yolo);
  const state = String(message.delivery_status?.state || "");
  const delivery = {
    accepted: {
      tone: "accepted",
      label: "✓ LINE รับคำขอแล้ว",
      title: "LINE รับคำขอส่งข้อความแล้ว แต่ไม่ใช่หลักฐานว่าลูกค้าเปิดหรืออ่านข้อความ",
    },
    partial: {
      tone: "partial",
      label: "⚠ LINE รับได้บางส่วน",
      title: "LINE รับเพียงบางส่วนของชุดส่ง กรุณาตรวจห้องก่อนส่งซ้ำ และไม่ใช่สถานะอ่าน",
    },
    ambiguous: {
      tone: "ambiguous",
      label: "? ผลส่งไม่ยืนยัน",
      title: "ยังยืนยันผลจาก LINE ไม่ได้ กรุณาตรวจห้องก่อนส่งซ้ำ",
    },
    rejected: {
      tone: "rejected",
      label: "! LINE ปฏิเสธการส่ง",
      title: "LINE ปฏิเสธคำขอส่งข้อความนี้",
    },
  }[state];
  if (delivery) chips.push({ kind: "delivery", ...delivery });
  if (message.customer_interaction_after?.type === "reply") {
    chips.push({
      kind: "interaction",
      tone: "interaction",
      label: "↩ ลูกค้าตอบกลับหลังส่ง",
      title: "ลูกค้ามีปฏิสัมพันธ์หลังข้อความนี้ แต่ไม่ใช่หลักฐานว่าอ่านทุกข้อความในชุด",
    });
  }
  return chips;
}

export function createChatWorkspace(deps) {
  const { api, uploadMedia, toast, mount, pageHeader, tabBar, stopPolling, state, setView, channelName } = deps;
  const canSendMedia = () => state.me?.capabilities?.includes("media.send") === true;
  const canSendImages = () => canSendMedia() && state.features?.imageUpload === true;
  const canSendFiles = () => canSendMedia() && state.features?.fileUpload === true;
  const canSendStickers = () => canSendMedia() && state.features?.stickers === true;
  const convoPane = createConvoPane(deps);
  const contextPane = createContextPane(deps);
  let olderLoadGen = 0;

  // รูปส่ง LINE ใช้เฉพาะ JPEG/PNG ผ่าน HTTPS; ย่อฝั่งเบราว์เซอร์ให้โหลดไว
  // และต่ำกว่า hard ceiling ฝั่ง private store เสมอ
  const ATTACH_MAX_BYTES = 950_000;
  async function prepareImageForUpload(file) {
    if ((file.type === "image/jpeg" || file.type === "image/png") && file.size <= ATTACH_MAX_BYTES) return file;
    let bitmap = null;
    try { bitmap = await createImageBitmap(file); } catch { bitmap = null; }
    if (!bitmap) throw new Error("อ่านไฟล์ไม่ได้ — รองรับเฉพาะไฟล์รูปภาพ (JPEG/PNG/WebP) ค่ะ");
    let scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff"; // PNG โปร่งใส -> JPEG ต้องมีพื้นหลัง
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
      if (blob && blob.size <= ATTACH_MAX_BYTES) {
        const name = `${(file.name || "photo").replace(/\.[^.]*$/u, "")}.jpg`;
        return new File([blob], name, { type: "image/jpeg" });
      }
      scale *= 0.72;
    }
    throw new Error("ย่อรูปให้เล็กพอไม่สำเร็จ — ลองรูปที่เล็กกว่านี้ค่ะ");
  }

  /* ------------------------------- ฟองแชท ------------------------------- */

  // B7d: สีฟองตามคนส่งจริง — แถวเก่า (agent_mode = null) เดาจากคอลัมน์ operator
  function bubbleModeClass(m) {
    if (m.direction !== "out") return "";
    const mode = m.agent_mode || (m.operator ? "operator_ai_on" : "ai");
    if (mode === "operator_ai_off") return " mode-op-off";
    if (mode === "operator_ai_on") return " mode-op-on";
    return " mode-ai";
  }

  // ตัวคั่นวัน: วันนี้ / เมื่อวาน / วันที่แบบไทย (เวลาเครื่องแอดมิน — ทีมอยู่ไทย)
  function dayLabel(ts) {
    const d = new Date(Number(ts));
    const today = new Date();
    const key = d.toDateString();
    if (key === today.toDateString()) return "วันนี้";
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (key === yesterday.toDateString()) return "เมื่อวาน";
    return d.toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  }

  // วันเวลาเต็มของฟอง (ชี้ที่เวลาในฟองเพื่อดู) — เช่น "จ. 22 ก.ย. 2569 19:05"
  function fullDateTime(ts) {
    const t = Number(ts);
    if (!Number.isFinite(t) || t <= 0) return "";
    return `${new Date(t).toLocaleDateString("th-TH", { weekday: "short", day: "numeric", month: "short", year: "numeric" })} ${fmtTime(t)}`;
  }

  function buildBubbles(messages, slipByMsgId, customerId) {
    const children = [];
    const canReachLegacy = state.chat.legacyId && !state.chat.legacyExhausted;
    if (state.chat.hasMoreOlder || canReachLegacy) {
      children.push(el("button", {
        class: "btn btn-outline btn-mini chat-older",
        onclick: () => loadOlder(customerId),
      }, state.chat.hasMoreOlder ? "ดูข้อความเก่ากว่า" : "ดูประวัติจากระบบเก่า"));
    }
    let lastDay = "";
    let inLegacySection = false;
    for (const m of messages) {
      // เส้นคั่นประวัติระบบเก่า: ก้อน _legacy อยู่หน้าสุดเสมอ (เก่ากว่าห้องจริงทั้งหมด)
      if (m._legacy && !inLegacySection) {
        inLegacySection = true;
        children.push(el("div", { class: "day-sep legacy-sep" }, el("span", {}, "📜 ประวัติจากระบบเก่า (อ่านอย่างเดียว)")));
      } else if (!m._legacy && inLegacySection) {
        inLegacySection = false;
        children.push(el("div", { class: "day-sep legacy-sep" }, el("span", {}, "⬇ ห้องปัจจุบัน")));
        lastDay = ""; // ให้วันที่ของห้องจริงขึ้นตัวคั่นวันใหม่เสมอหลังสลับก้อน
      }
      const day = new Date(Number(m.created_at)).toDateString();
      if (day !== lastDay) {
        lastDay = day;
        // 28 ก.ย. 2026 (เจ้าของถามว่าประวัติแชทมีวันที่ไหม): ป้ายวันเกาะหัวแชทขณะเลื่อน (is-sticky) — อ่านเวลาในฟองได้ว่าเป็นวันไหนเสมอ
        children.push(el("div", { class: "day-sep is-sticky" }, el("span", {}, dayLabel(m.created_at))));
      }
      const slip = m.direction === "in" && m.msg_type === "image" ? slipByMsgId.get(m.id) : null;
      // Outgoing native sticker is stored as a message metadata row (no binary attachment).
      // Give it the same safe renderer as historical sticker attachments rather than showing `[sticker]`.
      const messageAttachments = attachmentsForMessageRender(m.attachments, m.msg_type, m.metadata);
      // legacy รูปขาออก (content = "[image:key] url") โชว์เป็นรูปจริงแทนข้อความ marker
      const outImage = m.direction === "out" && m.msg_type === "image"
        ? String(m.content || "").match(/^\[image:[^\]]+\]\s*(https?:\/\/\S+)/u)
        : null;
      const evidenceChips = messageEvidenceChips(m);
      children.push(el("div", { class: `bubble-row ${m.direction === "in" ? "from-them" : "from-us"}` },
        el("div", { class: "bubble-stack" },
          el("div", { class: `bubble${bubbleModeClass(m)}` },
            outImage && !messageAttachments.length
              ? el("a", { href: outImage[1], target: "_blank", rel: "noopener" },
                  el("img", { class: "bubble-img", src: outImage[1], alt: "รูปที่ส่งให้ลูกค้า", loading: "lazy", referrerpolicy: "no-referrer" }))
              : messageBody(m.content, messageAttachments, m.metadata),
            el("span", { class: "bubble-meta", title: fullDateTime(m.created_at) },
              m.direction === "out" ? (m.operator ? `โดย ${m.operator}` : "AI") : null,
              " ", fmtTime(m.created_at),
            ),
          ),
          String(m.content || "").trim()
            ? el("button", {
                class: "bubble-copy", title: "คัดลอกข้อความ", "aria-label": "คัดลอกข้อความนี้",
                onclick: async () => {
                  try { await navigator.clipboard.writeText(String(m.content || "")); toast("คัดลอกข้อความแล้ว"); }
                  catch { window.prompt("คัดลอกข้อความ:", String(m.content || "")); }
                },
              }, "คัดลอก")
            : null,
          // เฟส 3 Step 0: "ทำไมตอบแบบนี้" ใต้ฟองของ AI เท่านั้น (คนตอบเองไม่มีที่มาให้อธิบาย)
          // โหลดตอนกางเท่านั้น — ห้องหนึ่งมีหลายสิบฟอง ยิงพร้อมกันทุกฟองคือการคอมไพล์
          // สมองหลายสิบรอบเพื่อสิ่งที่ไม่มีใครกาง
          state.features?.teach && m.direction === "out" && !m.operator && !m._legacy
            ? whyPanel({ api, message: m })
            : null,
          evidenceChips.length
            ? el("span", { class: "bubble-evidence", "aria-label": "สถานะการส่ง" },
                evidenceChips.map((chip) => el("span", {
                  class: `bubble-evidence-chip evidence-${chip.tone}`,
                  title: chip.title,
                }, chip.label)))
            : null,
          slip ? slipCard(slip) : null, // การ์ดผลตรวจสลิปใต้รูปนั้น ๆ
        ),
      ));
    }
    const bubbles = el("div", { class: "bubbles" }, children);
    bubbles.addEventListener("scroll", () => {
      state.chat.atBottom = bubbles.scrollTop + bubbles.clientHeight >= bubbles.scrollHeight - 48;
      bubbles.closest(".chat-pane")?.classList.toggle("is-scrolled-up", !state.chat.atBottom);
    }, { passive: true });
    return bubbles;
  }

  // โหลดหน้าเก่ากว่า — cursor คือข้อความเก่าสุดที่มีบนจอ, ค้าง viewport ไว้ที่เดิมหลัง render
  async function loadOlder(customerId) {
    const scope = captureChatLoadScope(state, customerId);
    if (!isChatLoadScopeCurrent(state, scope)) return;
    const oldest = state.chat.older[0] || state.chat.head[0];
    if (!oldest) return;
    const loadGen = ++olderLoadGen;
    try {
      let resp;
      if (state.chat.hasMoreOlder) {
        const params = new URLSearchParams({
          limit: String(CHAT_PAGE),
          beforeAt: String(oldest.created_at),
          beforeRid: String(oldest.rid ?? 0),
        });
        resp = await api(`/console/api/conversations/${encodeURIComponent(customerId)}/messages?${params}`);
        if (loadGen !== olderLoadGen || !applyOlderPageIfCurrent(state, scope, resp)) return;
      } else if (state.chat.legacyId && !state.chat.legacyExhausted) {
        // 2026-08-24: หน้าห้องจริงหมดแล้ว — ไหลต่อเข้าประวัติห้องระบบเก่า (อ่านอย่างเดียว)
        // ก้อน _legacy อยู่หน้าสุดของ older เสมอ (เก่ากว่าห้องจริงทุกข้อความ)
        const params = new URLSearchParams({ limit: String(CHAT_PAGE) });
        if (oldest._legacy) {
          params.set("beforeAt", String(oldest.created_at));
          params.set("beforeRid", String(oldest.rid ?? 0));
        }
        resp = await api(`/console/api/conversations/${encodeURIComponent(state.chat.legacyId)}/messages?${params}`);
        if (loadGen !== olderLoadGen || !isChatLoadScopeCurrent(state, scope)) return;
        const legacyMessages = (resp.messages || []).map((m) => ({ ...m, _legacy: true }));
        state.chat.older = [...legacyMessages, ...state.chat.older];
        state.chat.legacyExhausted = resp.hasMoreOlder !== true;
      } else {
        return;
      }
      const bubbles = document.querySelector(".bubbles");
      if (bubbles) state.chat.keepFromBottom = bubbles.scrollHeight - bubbles.scrollTop;
      await renderChat({ customerId, filter: state.inbox.filter });
    } catch (err) {
      if (loadGen === olderLoadGen && isChatLoadScopeCurrent(state, scope)) toast(err.message);
    }
  }

  /* ------------------------------- ห้องแชท ------------------------------- */

  // ป้ายเดียวกับรายการแชทซ้าย (คำสั่งเจ้าของ 2026-08-26) — เข้ามาในห้องแล้วต้องเห็นด้วยว่า
  // เรื่องยังไม่ถูกสรุปกลับ ไม่งั้นแอดมินจะไม่รู้ว่าต้องเขียนโน้ตส่งต่อตอนไหน
  // กติกาอยู่ที่ src/lineOaContext.mjs ฝั่งเซิร์ฟเวอร์ ตรงนี้แค่วาด
  function lineOaContextTag(context) {
    if (!context) return null;
    if (!context.synced) {
      return el("span", {
        class: "badge badge-orange",
        title: "ห้องนี้คุณดูแลเอง และยังไม่มีใครสรุปเรื่องกลับเข้าคอนโซลหลังข้อความล่าสุด"
          + " — ถ้าเพิ่งไปคุยในแอป LINE OA มา ให้เขียนโน้ตส่งต่อในแผงข้อมูลด้านขวา",
      }, "🟠 รอสรุป");
    }
    return el("span", {
      class: "badge badge-green",
      title: context.reason === "note"
        ? "มีโน้ตส่งต่อหลังข้อความล่าสุดของลูกค้า — ลูกแพรได้ context ครบแล้ว"
        : "คุณตอบในคอนโซลหลังข้อความล่าสุดแล้ว — บทสนทนาอยู่ในระบบครบ",
    }, "🟢 สรุปแล้ว");
  }

  // 28 ก.ย. 2026: onDone(kind) = หลังกด ✓ เสร็จสิ้น/สแปม สำเร็จ — ในคิวรอตอบพาไปห้องถัดไป ที่อื่นแค่รีเฟรช
  function chatHead(customerId, customer, aiOn, refresh, { legacyReadonly = false, aiPaused = false, lineOaContext = null, triage = null, onDone = refresh } = {}) {
    const seg = segmentOf(customer);
    const backHash = state.inbox.filter ? `#/chat/${state.inbox.filter}` : "#/chat";
    // AI ปิดเพราะใคร (src/aiOffActor.mjs): ม่วง = คนปิดเอง · แดง = ระบบปิด · เทา = ห้องเก่าไม่มีบันทึก
    // · เหลือง = ตัวกวาดคัดกรองว่ายังไม่เข้าเกณฑ์ (5 ต.ค. 2026)
    const off = aiOn ? null : (triage?.aiOff || null);
    const offBy = aiOffBy(off);
    // ห้องเหลือง: คนกดเปิด AI ทับผลคัดกรองได้เหมือนห้องอื่น — เซิร์ฟเวอร์จดไว้ว่าคนตัดสินแล้ว ตัวกวาดจะไม่ปิดห้องนี้อีก
    // (คำสั่งเจ้าของ: ระบบสลับเหลือง↔เขียวเอง แต่คนชนะเสมอ) จึงบอกผลนี้ก่อนกดและหลังกด
    const qualifyOff = isNotQualifiedOff(off);
    const spam = triage?.spam === true;
    // ห้องที่ปิดเคสแล้วแต่ลูกค้าทักกลับมา = อยู่ในคิวรอตอบอีกครั้ง → ปุ่มต้องเป็น "✓ เสร็จสิ้น" (ปิดรอบใหม่)
    const resolvedNow = customer.state === "RESOLVED" && !triage?.waiting;
    // กดรัว = คำขอเดียว (แบบเดียวกับปุ่มลัดบนแถว) — ไม่งั้น audit ซ้ำ และคิวรอตอบกระโดดสองห้อง
    const once = (fn) => async (event) => {
      const button = event?.currentTarget;
      if (button?.disabled) return;
      if (button) button.disabled = true;
      try { await fn(); } finally { if (button) button.disabled = false; }
    };
    return el("header", { class: "chat-head" },
      el("a", { class: "icon-btn chat-back", href: backHash, "aria-label": "กลับรายการแชท" }, "‹"),
      avatarEl(customer, { size: "sm" }),
      el("span", { class: "chat-head-main" },
        el("strong", { class: "chat-head-name" }, customerLabel(customer)),
        el("span", { class: "chat-head-sub" },
          // ตัวอักษรอยู่ในกล่องของตัวเองเพื่อให้ ellipsis กินเฉพาะข้อความ — ป้ายต้องไม่ถูก
          // ตัดหายบนจอมือถือ เพราะมือถือคือที่ที่แอดมินใช้จริง
          el("span", { class: "chat-head-sub-text" },
            // W3: หลายสาขา = บอกด้วยว่าห้องนี้คือ OA สาขาไหน
            (state.channels?.length ?? 0) > 1 && customer.channel_id
              ? `${channelName?.(customer.channel_id) || customer.channel_id} · `
              : "",
            `${SEGMENT_META[seg].icon} ${SEGMENT_META[seg].label}`,
            // ห้องที่ติดป้ายเงียบไม่ต้องโชว์คะแนนความสนใจ — ไม่ได้อยู่ในกระบวนการขาย
            seg === "null"
              ? ""
              : (Number.isInteger(customer.last_score) ? ` · score ${customer.last_score}/10` : " · ยังไม่มี score")),
          followupSuppressionBadge(customer),
          lineOaContextTag(lineOaContext)),
      ),
      // 2026-09-28: ⚡ YOLO — กล่องสั่งอยู่ใน yolo.mjs (null เมื่อไม่มีสิทธิ์ yolo.send)
      legacyReadonly ? null : yoloHeadControl({ api, toast, state, customerId, customer, aiOn, refresh }),
      legacyReadonly ? null : el("button", {
        class: `ai-toggle ${aiOn ? "is-on" : `is-off by-${offBy}`}`,
        onclick: async () => {
          try {
            await api(`/console/api/customers/${encodeURIComponent(customerId)}/ai`, {
              method: "POST", body: { enabled: !aiOn },
            });
            toast(!aiOn
              ? (qualifyOff ? "เปิด AI แล้ว — ตัวกวาดคัดกรองจะไม่ปิดห้องนี้อีก" : "เปิด AI แล้ว")
              : "ปิด AI แล้ว — คุณดูแลห้องนี้เอง");
            await refresh();
          } catch (err) {
            toast(err.message);
          }
        },
        "aria-pressed": aiOn ? "true" : "false",
        // audit 2026-08-26: เดิมขึ้น "AI ตอบอยู่" ทุกห้องแม้ลูกแพรจะถูกหยุดทั้งระบบ
        // ทำให้เข้าใจว่ามีคนดูแลห้องนั้นอยู่ ทั้งที่ไม่มีใครตอบเลย — อันตรายที่สุด
        // ในช่วงที่คนต้องตอบเองทุกห้อง
        title: aiPaused && aiOn
          ? "สวิตช์ของห้องนี้เปิดอยู่ แต่ลูกแพรถูกหยุดทั้งระบบ จึงยังไม่มีใครตอบให้"
          : !aiOn && off
            ? `${off.label} — ${off.reasonText} · แตะเพื่อเปิด AI${qualifyOff ? " (ตัวกวาดคัดกรองจะไม่ปิดห้องนี้อีก)" : ""}`
            : undefined,
      }, aiOn ? (aiPaused ? "ลูกแพรหยุดทั้งระบบ" : "AI ตอบอยู่") : (off?.label || "AI ปิด")),
      el("button", {
        class: "icon-btn", title: "ทำเป็นยังไม่อ่าน", "aria-label": "ทำบทสนทนานี้เป็นยังไม่อ่าน",
        onclick: async () => {
          try {
            await api(`/console/api/customers/${encodeURIComponent(customerId)}/unread`, { method: "POST", body: {} });
            toast("ทำเป็นยังไม่อ่านแล้ว");
            location.hash = backHash;
          } catch (err) { toast(err.message); }
        },
      }, "●"),
      el("button", {
        class: `btn btn-mini ${resolvedNow ? "btn-outline" : "btn-ghost"}`,
        title: resolvedNow ? "เปิดเคสนี้อีกครั้ง" : "ปิดเคสว่าเสร็จสิ้น",
        onclick: once(async () => {
          if (!resolvedNow) {
            if (await resolveRoom({ api, toast, customerId })) await onDone("resolved");
            return;
          }
          try {
            await api(`/console/api/customers/${encodeURIComponent(customerId)}/resolve`, { method: "POST", body: { resolved: false } });
            toast("เปิดเคสใหม่แล้ว");
            await refresh();
          } catch (err) { toast(err.message); }
        }),
      }, resolvedNow ? "เปิดเคส" : "✓ เสร็จสิ้น"),
      // 28 ก.ย. 2026 (เจ้าของ: "ทำระบบ spam เพื่อ screen คนออกจาก inbox"): สแปม = ป้าย null · ยืนยันด้วยกล่องก่อนเสมอ
      // ห้องที่อยู่ในสแปมแล้วไม่มีปุ่มนี้ — แถบสแปมใต้หัวห้องมี "ไม่ใช่สแปม" อยู่แล้ว (ปุ่มเดียวกันสองที่ = รก)
      legacyReadonly || spam ? null : el("button", {
        class: "btn btn-mini spam-btn",
        title: "ย้ายห้องนี้ไปสแปม — AI ปิด ไม่ทักตาม หายจากทุกคิว",
        "aria-label": "ย้ายไปสแปม",
        onclick: once(async () => {
          if (await setSpam({ api, toast, customerId, name: customerLabel(customer), spam: true })) await onDone("spam");
        }),
      }, el("span", { class: "spam-btn-icon", "aria-hidden": "true" }, "🚫"),
        el("span", { class: "btn-label" }, "สแปม")),
      el("button", {
        class: `icon-btn ctx-toggle${state.ui.contextOpen ? " is-active" : ""}`,
        "aria-label": "เปิด/ปิดแผงข้อมูลลูกค้า", title: "ข้อมูลลูกค้า",
        "aria-expanded": state.ui.contextOpen ? "true" : "false",
        onclick: () => {
          state.ui.contextOpen = !state.ui.contextOpen;
          document.querySelector(".chat-workspace")?.classList.toggle("ctx-open", state.ui.contextOpen);
          document.querySelector(".ctx-toggle")?.classList.toggle("is-active", state.ui.contextOpen);
          document.querySelector(".ctx-toggle")?.setAttribute("aria-expanded", state.ui.contextOpen ? "true" : "false");
        },
      }, "ⓘ"),
    );
  }

  // 28 ก.ย. 2026 (เจ้าของ: กดแชทค้างแล้ว "เคสอื่นต้อง back กลับมา มันไม่ค่อยสะดวก"): แถบคิวใต้หัวห้อง
  // เปิดห้องจากคิวรอตอบ = รู้ว่าห้องนี้ลำดับเท่าไรจากกี่ห้อง รอมานานเท่าไร และมี "ห้องถัดไป →" ให้กดข้าม
  // ห้องที่อยู่ในสแปม (เปิดจากที่ไหนก็ได้) = บอกสถานะให้ชัด พร้อมทางคืน
  function triageStrip({ customerId, customer, triage }) {
    const filter = state.inbox.filter;
    // ห้องสแปมมาก่อนเสมอ — เปิดจากลิงก์คิวเก่าก็ยังต้องเห็นสถานะและทางคืน (หัวห้องไม่มีปุ่มสแปมซ้ำ)
    if (triage?.spam) {
      return el("div", { class: "triage-bar is-spam" },
        el("span", { class: "triage-bar-status" },
          el("strong", {}, "🚫 ห้องนี้อยู่ในสแปม"),
          el("span", { class: "triage-bar-pos" }, "AI ปิด ไม่ทักตาม ไม่ขึ้นในคิวไหนและไม่แจ้งเตือนทีม"),
        ),
        el("button", {
          type: "button", class: "btn btn-mini triage-unspam",
          onclick: async (event) => {
            const button = event?.currentTarget;
            if (button?.disabled) return;
            if (button) button.disabled = true;
            try {
              if (await setSpam({ api, toast, customerId, name: customerLabel(customer), spam: false })) {
                inboxCache.at = 0;
                await renderChat({ customerId, filter: state.inbox.filter });
              }
            } finally {
              if (button) button.disabled = false;
            }
          },
        }, "↩ ไม่ใช่สแปม"),
      );
    }
    if (isHotFollowFilter(filter)) return hotFollowStrip(customerId);
    if (!isWaitingFilter(filter)) return null;
    const order = Array.isArray(state.inbox.waitingOrder) ? state.inbox.waitingOrder : [];
    const at = order.indexOf(String(customerId));
    const next = nextWaitingId({ order, fresh: order, currentId: customerId });
    const since = Number(triage?.waiting?.since) || 0;
    // ไม่ใส่ role="status": ข้อความเวลารอเปลี่ยนทุกนาที โปรแกรมอ่านหน้าจอจะพูดซ้ำทุกรอบ poll
    return el("div", { class: `triage-bar${triage?.waiting ? " is-waiting" : " is-clear"}` },
      el("span", { class: "triage-bar-status" },
        triage?.waiting
          ? el("strong", { class: "triage-bar-wait" }, `⏳ รอตอบ ${spanLabel(Date.now() - since)}`)
          : el("strong", { class: "triage-bar-done" }, "✓ ไม่อยู่ในคิวรอตอบแล้ว"),
        el("span", { class: "triage-bar-pos" }, at >= 0
          ? `ห้อง ${at + 1} จาก ${order.length}${filter === "waiting24" ? " · ค้างเกิน 24 ชม." : ""}`
          : `เหลือในคิว ${order.length} ห้อง`),
        // มือถือไม่มี tooltip — เหตุที่ AI ปิดต้องอ่านได้ตรงนี้ (ตัดสินได้ว่าจะตอบเอง/เปิด AI/ปิดเคส)
        // ห้องเหลืองขึ้นชื่อป้าย "AI off (not qualify)" นำหน้าเหตุ (aiOffWhyText) ห้องอื่นถ้อยคำเดิม
        triage?.aiOff?.reasonText
          ? el("span", { class: `triage-bar-why by-${aiOffBy(triage.aiOff)}` }, aiOffWhyText(triage.aiOff))
          : null,
      ),
      triage?.waiting?.fbReplyClosed ? fbClosedBadge() : null,
      next
        ? el("a", { class: "btn btn-mini triage-next", href: roomHash(filter, next), title: "ข้ามไปห้องถัดไปในคิว (ห้องนี้ยังอยู่ในคิว)" }, "ห้องถัดไป →")
        : el("span", { class: "triage-next is-last" }, order.length ? "ห้องสุดท้ายของคิว" : "คิวว่างแล้ว"),
    );
  }

  // 30 ก.ย. 2026 (เจ้าของ: "ไล่ทักทีละห้อง" แบบคิวรอตอบ): แถบคิวลูกค้าร้อนรอทีมทักต่อ — ห้องนี้ลำดับเท่าไร
  // และบอกให้ชัดว่าห้องออกจากคิวได้ทางเดียวคือพิมพ์คุยกับลูกค้า (ตอบใน Business Suite ก็นับ — กด "ห้องถัดไป" ต่อเอง)
  function hotFollowStrip(customerId) {
    const filter = state.inbox.filter;
    const order = Array.isArray(state.inbox.waitingOrder) ? state.inbox.waitingOrder : [];
    const at = order.indexOf(String(customerId));
    const next = nextWaitingId({ order, fresh: order, currentId: customerId });
    return el("div", { class: `triage-bar${at >= 0 ? " is-hotfollow" : " is-clear"}` },
      el("span", { class: "triage-bar-status" },
        at >= 0
          ? el("strong", { class: "triage-bar-hot" }, "🤝 ไม้ต่อจากลูกแพร — ลูกแพรคุยจบแล้ว ถึงตาทีมคุยต่อ")
          : el("strong", { class: "triage-bar-done" }, "✓ ทีมทักแล้ว — ห้องนี้ออกจากคิวแล้ว"),
        el("span", { class: "triage-bar-pos" }, at >= 0 ? `ห้อง ${at + 1} จาก ${order.length}` : `เหลือในคิว ${order.length} ห้อง`),
        at >= 0
          ? el("span", { class: "triage-bar-pos" }, "พิมพ์คุยกับลูกค้าแล้วห้องถัดไปเปิดเอง · ตอบใน Business Suite แล้วกด \"ห้องถัดไป\"")
          : null,
      ),
      next
        ? el("a", { class: "btn btn-mini triage-next", href: roomHash(filter, next), title: "ข้ามไปห้องถัดไปในคิว (ห้องนี้ยังอยู่ในคิวจนกว่าจะมีคนทัก)" }, "ห้องถัดไป →")
        : el("span", { class: "triage-next is-last" }, order.length ? "ห้องสุดท้ายของคิว" : "คิวว่างแล้ว"),
    );
  }

  // หลังจัดการห้องที่เปิดจากคิวรอตอบเสร็จ (ตอบ/✓ เสร็จสิ้น/สแปม) — ห้องนั้นหลุดคิวแล้ว เปิดห้องถัดไปให้เลย
  // ใช้คิวล่าสุดจากเซิร์ฟเวอร์ (ห้องที่คนอื่น/ลูกแพรตอบไประหว่างนี้หลุดไปด้วย) ถ้าอ่านไม่ได้ใช้คิวที่เห็นอยู่
  async function advanceWaiting(customerId, doneText) {
    const filter = state.inbox.filter;
    const order = Array.isArray(state.inbox.waitingOrder) ? state.inbox.waitingOrder : [];
    inboxCache.at = 0;
    let fresh = null;
    try {
      const params = new URLSearchParams({ segment: filter, limit: "1" });
      if (state.channel) params.set("channel", state.channel);
      // ค้นหาในคิวอยู่ = ห้องถัดไปต้องมาจากผลค้นเดียวกัน (พารามิเตอร์ชุดเดียวกับรายการซ้าย)
      if (state.inbox.q) {
        params.set("q", state.inbox.q);
        if (state.inbox.q.length >= 2) params.set("deep", "1");
      }
      const data = await api(`/console/api/inbox?${params}`);
      fresh = Array.isArray(data?.waitingOrder) ? data.waitingOrder : null;
    } catch { fresh = null; }
    const next = nextWaitingId({ order, fresh: fresh ?? order, currentId: customerId });
    toast(next ? `${doneText} · เปิดห้องถัดไปให้แล้ว` : `${doneText} · คิวนี้ไม่เหลือห้องแล้ว`);
    const target = next ? roomHash(filter, next) : `#/chat/${filter}`;
    if ((location.hash || "") !== target) location.hash = target;
    else await renderChat({ customerId: next, filter });
  }

  function buildChatPane({ customerId, data, refresh }) {
    const { customer, pendingDraft, slipChecks } = data;
    const triage = data.triage || null;
    // ปิดเคส/สแปมสำเร็จ: คิวรอตอบ = ไปห้องถัดไป · ที่อื่น = รีเฟรชห้องเดิม (setSpam บอกผลเองแล้ว)
    const onDone = async (kind) => {
      const doneText = kind === "resolved" ? "ปิดเคสเป็นเสร็จสิ้นแล้ว" : kind === "spam" ? "ย้ายไปสแปมแล้ว" : "";
      if (isWaitingFilter(state.inbox.filter) && (kind === "resolved" || kind === "spam")) return advanceWaiting(customerId, doneText);
      // คิวรอทีมทักต่อ: สแปมออกจากคิว (ไม่ใช่ลูกค้า) · เสร็จสิ้นไม่ทำให้ออก — ต้องพิมพ์คุยจริง (เจ้าของ 30 ก.ย.)
      if (isHotFollowFilter(state.inbox.filter) && kind === "spam") return advanceWaiting(customerId, doneText);
      if (isHotFollowFilter(state.inbox.filter) && kind === "resolved") {
        toast(`${doneText} · ห้องนี้ยังอยู่ในคิวไม้ต่อจนกว่าจะพิมพ์คุยกับลูกค้า`);
        return refresh();
      }
      if (kind === "resolved") toast(doneText);
      return refresh();
    };
    const aiOn = customer.ai_enabled === 1;
    const legacyReadonly = (data.tags || []).some((row) => row.tag === "ย้ายจาก LINE OA");
    // G3: ผลตรวจสลิปเทียบกับ message id ของรูปขาเข้า (แถว DB = "in:<LINE message id>")
    const slipByMsgId = new Map((slipChecks || []).map((s) => [`in:${s.message_id}`, s]));

    // รวมหน้าเก่าที่โหลดไว้ + หัวห้องสด (dedupe ด้วย id — หัวห้องชนะ)
    const seen = new Set();
    const messages = [];
    for (const m of [...state.chat.older, ...state.chat.head]) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      messages.push(m);
    }

    const bubbles = buildBubbles(messages, slipByMsgId, customerId);

    const textarea = el("textarea", {
      // audit 2026-08-26 (วิกฤต): ประทับรหัสห้องไว้บนกล่องพิมพ์ เพื่อให้ตอนกู้ข้อความ
      // ที่พิมพ์ค้างรู้ได้ว่า "ของห้องไหน" — เดิมกู้ข้ามห้องได้ ทำให้ข้อความที่พิมพ์ให้
      // ลูกค้าคนหนึ่ง (เช่น เลขบัญชีกับยอดเงิน) ไปโผล่ในกล่องพิมพ์ของลูกค้าอีกคน
      "data-room": String(customerId || ""),
      class: "reply-input", rows: "1", placeholder: "พิมพ์ตอบลูกค้า… (⌘/Ctrl+Enter ส่ง)",
      oninput: (e) => {
        e.target.style.height = "auto";
        e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
        updateComposerCount();
      },
      onkeydown: (e) => {
        if (e.isComposing) return;
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          send();
        }
      },
      onpaste: (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (!files.length) return;
        e.preventDefault();
        ingestFiles(files);
      },
    });
    const charCount = el("span", { class: "composer-count", "aria-live": "polite" }, "0/2000");

    // ร่าง AI ที่ถูกบล็อกล่าสุด — แตะเดียวดึงลงกล่องตอบ แก้แล้วส่ง = เข้า Correction Loop
    // v1.4.12c (feedback เจ้าของ 2026-08-18): ร่างยาวเคยแบเต็มจอเหมือน error ยักษ์ค้าง —
    // พับเก็บเป็นแถบเล็กก่อนเสมอ แตะค่อยกางดู (กางแล้วสูงสุด 240px เลื่อนในตัวเอง)
    state.draft = null;
    const draftCard = pendingDraft
      ? (() => {
          const preview = String(pendingDraft.ai_draft || "").replace(/\s+/gu, " ").trim().slice(0, 90);
          const card = el("div", { class: "draft-card is-collapsed" },
            el("button", {
              class: "draft-toggle",
              onclick: () => card.classList.toggle("is-collapsed"),
            },
              // v1.4.33 (เจ้าของ 2026-08-19): ตอนปิดให้เหลือชิปเล็กที่สุดเท่าที่ยัง "เห็นว่ามี"
              // — ซ่อนจนมองไม่เห็นเลยไม่ได้ เพราะร่างที่ถูกบล็อกคือสิ่งที่ต้องมีคนตัดสินใจ
              // ถ้าลืมไป เท่ากับลูกค้าไม่ได้รับคำตอบโดยไม่มีใครรู้
              el("span", { class: "draft-label" }, "🚫 ร่างที่ถูกบล็อก"),
              el("span", { class: "draft-caret", "aria-hidden": "true" }, "▾"),
              el("span", { class: "draft-preview" }, `${preview}…`),
            ),
            el("p", { class: "draft-text" }, pendingDraft.ai_draft),
            // v1.4.33b (feedback เจ้าของ 2026-08-19 จากมือถือ): ปุ่มย่อต้องอยู่ "ท้ายร่าง"
            // ไม่ใช่แค่หัวการ์ด — ร่างยาวเต็มจอ พออ่านจบอยู่ล่างสุดแล้วต้องเลื่อนกลับขึ้นไป
            // บนสุดเพื่อกดปิด ซึ่งบนมือถือคือการเลื่อนยาวมากด้วยนิ้วโป้ง
            // วางคู่กับ "ใช้ร่างนี้" เพราะสองปุ่มนี้คือทางออกสองทางของการอ่านร่างจบ:
            // เอาไปใช้ หรือ เก็บทิ้งไป
            el("div", { class: "draft-actions" },
              el("button", {
                class: "btn btn-outline btn-mini draft-use-btn",
                onclick: () => {
                  textarea.value = pendingDraft.ai_draft;
                  textarea.dispatchEvent(new Event("input"));
                  state.draft = pendingDraft;
                  textarea.focus();
                },
              }, "ใช้ร่างนี้ (แก้ได้)"),
              el("button", {
                class: "btn btn-ghost btn-mini draft-collapse-btn",
                onclick: () => {
                  card.classList.add("is-collapsed");
                  // เลื่อนชิปที่ยุบแล้วให้เห็นด้วย — ไม่งั้นหน้าจอกระโดดจนหาไม่เจอว่าอยู่ไหน
                  card.scrollIntoView({ block: "nearest" });
                },
              }, "ย่อเก็บ ▴"),
            ),
          );
          return card;
        })()
      : null;
    // บันทึก "ส่งแล้วแต่ไม่แน่ใจว่าถึงไหม" ต้องอยู่ข้ามการสลับห้อง
    if (!state.chat.failedDraft && customerId && state.chatUncertain.has(String(customerId))) {
      state.chat.failedDraft = state.chatUncertain.get(String(customerId));
    }
    const uncertainCard = state.chat.failedDraft
      ? (() => {
          const failed = state.chat.failedDraft;
          const copyText = [failed.text, ...(failed.files || []).map((name) => `[ไฟล์: ${name}]`), failed.sticker ? "[สติกเกอร์]" : ""].filter(Boolean).join("\n");
          return el("div", { class: "draft-card uncertain-draft" },
            el("strong", {}, "ผลส่งไม่ยืนยัน — เก็บร่างไว้ให้ตรวจ"),
            el("p", { class: "draft-text" }, failed.text || "(ไม่มีข้อความตัวอักษร)"),
            (failed.files || []).length ? el("p", { class: "panel-sub" }, `ไฟล์: ${failed.files.join(", ")}`) : null,
            el("div", { class: "draft-actions" },
              el("button", {
                class: "btn btn-outline btn-mini",
                onclick: async () => {
                  try { await navigator.clipboard.writeText(copyText); toast("คัดลอกร่างแล้ว — ตรวจห้อง LINE ก่อนพิมพ์ใหม่ค่ะ"); }
                  catch { window.prompt("คัดลอกร่าง:", copyText); }
                },
              }, "คัดลอกร่าง"),
              el("button", {
                class: "btn btn-ghost btn-mini",
                onclick: () => {
                  state.chat.failedDraft = null;
                  state.chatUncertain.delete(String(customerId));
                  uncertainCard.remove();
                },
              }, "รับทราบและปิด"),
            ),
          );
        })()
      : null;

    // แนบรูป/ไฟล์ในช่องแชท — ทั้งคู่เก็บใน private recipient-scoped store;
    // รูปใช้ provider-fetch capability ชั่วคราว ส่วนไฟล์ใช้ลิงก์ดาวน์โหลดที่หมดอายุ
    // แล้วค้างเป็น chip รอไปกับปุ่ม "ส่ง" เดียวกับข้อความ (ยกเลิกได้ก่อนส่ง)
    // สถานะ "งานค้างในช่องตอบ" อยู่บน state.chat (อยู่รอด re-render) — ปุ่ม/ชิปเป็นของ
    // render รอบนั้น ๆ จึงห้ามให้ตรรกะกันซ้ำอาศัย element (audit จับเคส poll ทับ)
    if (!Array.isArray(state.chat.attachments)) state.chat.attachments = [];
    if (typeof state.chat.uploading !== "number") state.chat.uploading = 0;
    state.chat.sending = state.chat.sending === true;
    let replyBar = null;
    function syncComposerBusy() {
      const busy = state.chat.uploading > 0 || state.chat.sending;
      replyBar?.classList.toggle("is-busy", busy);
    }
    const attachChips = el("div", { class: "attach-chips" });
    function renderAttachChips() {
      attachChips.replaceChildren(...state.chat.attachments.map((a) =>
        el("span", { class: "attach-chip" },
          a.kind === "image"
            ? el("img", { class: "attach-thumb", src: a.consoleUrl || a.url || `/console/api/attachments/${encodeURIComponent(a.id)}/content`, alt: "" })
            : el("span", { class: "attach-file-icon", "aria-hidden": "true" }, attachmentTypeLabel(a)),
          el("span", { class: "attach-name" }, a.label),
          el("button", {
            class: "attach-remove", "aria-label": `เอา ${a.label} ออก`,
            onclick: () => {
              state.chat.attachments = state.chat.attachments.filter((x) => (x.id || x.key) !== (a.id || a.key));
              renderAttachChips();
            },
          }, "✕"),
        )));
      attachChips.classList.toggle("is-empty", state.chat.attachments.length === 0);
    }
    renderAttachChips();

    async function ingestFiles(files = []) {
        const selected = [...files];
        if (!selected.length) return;
        if (selected.some((file) => String(file.type || "").startsWith("image/")) && !canSendImages()) {
          toast("การแนบรูปยังไม่เปิดสำหรับบัญชีหรือระบบนี้ค่ะ");
          return;
        }
        if (selected.some((file) => !String(file.type || "").startsWith("image/")) && !canSendFiles()) {
          toast("การแนบไฟล์ยังไม่เปิดสำหรับบัญชีหรือระบบนี้ค่ะ");
          return;
        }
        // จับห้อง ณ ตอนเลือกไฟล์ — สลับห้องระหว่างอัปโหลดแล้ว ห้ามให้รูปไปเข้าคิวห้องใหม่
        // (คิวรูปผูกกับลูกค้า ส่งผิดคนคืออุบัติเหตุที่ยอมไม่ได้)
        const roomScope = state.chat;
        if (roomScope.uploading > 0) { toast("รอเตรียมรูปชุดนี้ให้เสร็จก่อนค่ะ"); return; }
        // ตั้งธง "กำลังอัปโหลด" ก่อน await ตัวแรกเสมอ — poll ต้องพัก re-render ตั้งแต่วินาทีนี้
        roomScope.uploading += 1;
        syncComposerBusy();
        try {
          for (const raw of selected) {
            if (roomScope.attachments.length >= 6) { toast("แนบได้สูงสุด 6 รายการต่อการส่งค่ะ"); break; }
            attachBtn.disabled = true;
            attachBtn.textContent = "⏳";
            try {
              const isImage = raw.type.startsWith("image/");
              const reviewed = isImage ? await openPhotoEditor(raw, { isCurrent: () => state.chat === roomScope && canSendImages() }) : raw;
              if (!reviewed) { if (state.chat !== roomScope) break; continue; }
              if (state.chat !== roomScope || (isImage ? !canSendImages() : !canSendFiles())) break;
              const file = isImage ? await prepareImageForUpload(reviewed) : reviewed;
              if (state.chat !== roomScope) break;
              if (!isImage && !isSupportedBusinessFile(raw)) throw new Error("รองรับ PDF, Office, ตาราง, ข้อความ, ZIP, วิดีโอ และเสียงค่ะ");
              const uploadPath = `/console/api/conversations/${encodeURIComponent(customerId)}/attachments?name=${encodeURIComponent(file.name)}`;
              const resp = await uploadMedia(uploadPath, file);
              const media = resp.attachment || resp.media;
              if (!media?.id && !media?.key) throw new Error("ระบบไม่ได้ยืนยันไฟล์ที่อัปโหลดค่ะ");
              if (state.chat !== roomScope) { toast("สลับห้องระหว่างอัปโหลด — รูปไม่ถูกแนบ แนบใหม่ในห้องที่ต้องการค่ะ"); break; }
              if (!roomScope.attachments.some((x) => (x.id || x.key) === (media.id || media.key))) {
                roomScope.attachments.push({ id: media.id, key: media.key, kind: media.kind || (isImage ? "image" : fileKind(file)), label: media.label || file.name, mime: media.mime || file.type, byte_size: media.byte_size || file.size, consoleUrl: media.consoleUrl, url: media.url });
              }
              renderAttachChips();
            } catch (err) {
              toast(err.message);
            } finally {
              attachBtn.disabled = false;
              attachBtn.textContent = "📎";
            }
          }
        } finally {
          roomScope.uploading = Math.max(0, roomScope.uploading - 1);
          syncComposerBusy();
        }
    }

    const fileInput = el("input", {
      type: "file",
      accept: [canSendImages() ? "image/jpeg,image/png,image/webp" : "", canSendFiles() ? "application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.md,.json,.zip,.mp4,.mov,.m4a,.mp3" : ""].filter(Boolean).join(","),
      multiple: true, hidden: true, disabled: !(canSendImages() || canSendFiles()),
      onchange: (e) => {
        const files = [...(e.target.files || [])];
        e.target.value = "";
        ingestFiles(files);
      },
    });
    const attachBtn = el("button", {
      class: "btn btn-outline btn-attach", title: "แนบรูปหรือไฟล์แบบส่วนตัว (ลิงก์หมดอายุอัตโนมัติ)", hidden: !(canSendImages() || canSendFiles()),
      onclick: () => fileInput.click(),
    }, "📎");

    // สติกเกอร์เป็นชุดที่ระบบอนุมัติไว้เท่านั้น: UI ไม่รับ package/sticker id อิสระจากผู้ใช้
    if (!state.chat.stickerCatalog) state.chat.stickerCatalog = null;
    if (state.chat.sticker === undefined) state.chat.sticker = null;
    const stickerChip = el("div", { class: "sticker-chip" });
    const stickerMenu = el("div", { class: "sticker-picker", hidden: true, role: "dialog", "aria-label": "เลือกสติกเกอร์" });
    function renderStickerChoice() {
      const sticker = state.chat.sticker;
      stickerChip.replaceChildren();
      if (!sticker) { stickerChip.hidden = true; return; }
      stickerChip.hidden = false;
      const visual = stickerVisual(sticker);
      stickerChip.append(
        visual.imageUrl
          ? el("img", { class: "sticker-choice-img", src: visual.imageUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
          : el("span", { class: "sticker-symbol", "aria-hidden": "true" }, visual.symbol),
        el("span", {}, `${visual.label} · สติกเกอร์ที่จะส่ง`),
        el("button", { class: "attach-remove", "aria-label": "เอาสติกเกอร์ออก", onclick: () => { state.chat.sticker = null; renderStickerChoice(); } }, "✕"),
      );
    }
    function renderStickerMenu() {
      const catalog = Array.isArray(state.chat.stickerCatalog) ? state.chat.stickerCatalog : [];
      stickerMenu.replaceChildren(...catalog.map((sticker) => {
        const visual = stickerVisual(sticker);
        return el("button", {
          class: "sticker-option", title: sticker.label || "สติกเกอร์ LINE",
          "aria-label": sticker.label || `สติกเกอร์ LINE หมายเลข ${sticker.stickerId}`,
          onclick: () => { state.chat.sticker = sticker; stickerMenu.hidden = true; renderStickerChoice(); },
        }, visual.imageUrl
          ? el("img", { class: "sticker-option-img", src: visual.imageUrl, alt: "", loading: "lazy", referrerpolicy: "no-referrer" })
          : el("span", { class: "sticker-option-symbol", "aria-hidden": "true" }, visual.symbol),
          // มี 40 ตัวแล้ว ถ้าใส่ป้ายทุกตัวจะรกจนเลือกยาก — โชว์เฉพาะตัวที่มีคำอธิบายจริง
          // ที่เหลือเลือกด้วยภาพเหมือนใน LINE (aria-label ยังอยู่ครบสำหรับ screen reader)
          sticker.label ? el("small", {}, visual.label) : null);
      }));
      if (!catalog.length) stickerMenu.replaceChildren(el("p", { class: "sticker-empty" }, "ยังไม่มีชุดสติกเกอร์ที่เปิดใช้"));
    }
    const stickerBtn = el("button", {
      class: "btn btn-outline btn-attach", title: "เลือกสติกเกอร์ LINE", "aria-expanded": "false", hidden: !canSendStickers(),
      onclick: async () => {
        if (!state.chat.stickerCatalog) {
          try {
            const response = await api("/console/api/stickers");
            state.chat.stickerCatalog = response.enabled === true && Array.isArray(response.stickers) ? response.stickers : [];
          } catch (err) { toast(err.message); return; }
        }
        renderStickerMenu();
        stickerMenu.hidden = !stickerMenu.hidden;
        stickerBtn.setAttribute("aria-expanded", stickerMenu.hidden ? "false" : "true");
      },
    }, "☺");
    renderStickerChoice();

    const sendBtn = el("button", { class: "btn btn-primary btn-send", onclick: send }, "ส่ง");
    function updateComposerCount() {
      const count = textarea.value.length;
      charCount.textContent = `${count}/2000`;
      charCount.classList.toggle("is-over", count > 2000);
      sendBtn.disabled = count > 2000 || state.chat.sending;
    }
    updateComposerCount();
    // 2026-08-24 (คำสั่งเจ้าของ): ถอดแถบข้อความสำเร็จรูป (/ราคา /บัญชี ...) ออกจากหน้าแชท —
    // กลับไปใช้ suggestion แบบเดิมของ chassis คือ draftCard (ร่างของลูกแพร + "ใช้ร่างนี้")
    // และ "ถามต่อ:" จาก scorer ในแผงขวา (context.mjs) เท่านั้น
    // API /console/api/quick-replies คงไว้ (มีเทสต์คุม) เผื่อเปิดใช้ใหม่ภายหลัง
    async function send() {
      // กันส่งซ้ำที่ระดับ state ไม่ใช่ระดับปุ่ม — re-render ระหว่างส่งจะได้ปุ่มใหม่ที่กดได้
      // (audit จับ: ลูกค้าจริงเคยเสี่ยงได้ข้อความ/รูปสองชุด)
      if (state.chat.sending) return;
      if (state.chat.uploading > 0) return toast("ไฟล์ยังอัปโหลดไม่เสร็จ รอสักครู่นะคะ");
      const text = textarea.value.trim();
      if (textarea.value.length > 2000) return toast("ข้อความต้องไม่เกิน 2,000 ตัวอักษรค่ะ");
      const attachments = state.chat.attachments;
      const sticker = state.chat.sticker;
      if (!text && !attachments.length && !sticker) return;
      const body = buildComposerReplyPayload({ text, attachments, sticker });
      if (state.draft) {
        body.draftId = state.draft.id;
        body.aiDraft = state.draft.ai_draft;
      }
      // audit 2026-08-26: ทุกบรรทัดหลัง await ในนี้เขียนลง state.chat ซึ่งเป็น "ห้องปัจจุบัน"
      // ไม่ใช่ "ห้องที่กดส่ง" ถ้าแอดมินสลับห้องระหว่างที่คำขอยังค้างอยู่ ผลลัพธ์จะไปล้าง
      // ไฟล์แนบที่เตรียมไว้ในห้องใหม่ และสั่ง refresh ที่ผูกกับห้องเก่า = เขียนทับห้องที่ดูอยู่
      // เส้นทางแนบไฟล์ผูกห้องไว้ถูกแล้ว (roomScope) เส้นทางส่งข้อความยังไม่มี
      const roomScope = state.chat;
      const sameRoom = () => state.chat === roomScope;
      state.chat.sending = true;
      syncComposerBusy();
      sendBtn.disabled = true;
      sendBtn.textContent = "…";
      try {
        const resp = await api(`/console/api/conversations/${encodeURIComponent(customerId)}/reply`, { method: "POST", body });
        if (resp.droppedAttachmentIds?.length) {
          toast("มีไฟล์บางรายการไม่อยู่ในห้องนี้ จึงไม่ได้ส่งค่ะ");
        }
        if (resp.overflowImageKeys?.length) {
          toast(`ส่งได้สูงสุด 6 รูปต่อครั้ง — ${resp.overflowImageKeys.length} รูปสุดท้ายไม่ได้ส่ง ส่งรอบถัดไปนะคะ`);
        }
        if (resp.historyPending) {
          toast("LINE รับข้อความแล้ว แต่ประวัติกำลังซ่อมอัตโนมัติ — ห้ามส่งซ้ำค่ะ");
        }
        state.chatDrafts.delete(String(customerId));
        roomScope.sending = false;
        roomScope.failedDraft = null;
        roomScope.attachments = [];
        roomScope.sticker = null;
        roomScope.atBottom = true;
        if (!sameRoom()) return; // ย้ายห้องไปแล้ว — ห้ามแตะ DOM หรือ refresh ทับห้องที่ดูอยู่
        textarea.value = "";
        textarea.style.height = "auto";
        updateComposerCount();
        state.draft = null;
        renderAttachChips();
        renderStickerChoice();
        syncComposerBusy();
        // 28 ก.ย. 2026: ตอบจากคิวรอตอบ = ห้องนี้หลุดคิวแล้ว เปิดห้องถัดไปให้เลย
        // ยกเว้นมีเรื่องต้องดูต่อในห้องนี้: ประวัติยังซ่อมอยู่ หรือมีไฟล์/รูปที่ไม่ได้ส่ง (คำเตือนต้องไม่หายไปกับการย้ายห้อง)
        const needsSecondLook = resp.historyPending || resp.droppedAttachmentIds?.length || resp.overflowImageKeys?.length;
        if (isAdvanceQueue(state.inbox.filter) && !needsSecondLook) {
          await advanceWaiting(customerId, "ส่งแล้ว");
          return;
        }
        await refresh();
      } catch (err) {
        // ส่งล้มแบบ "ถึงลูกค้าบางส่วนแล้ว" — เคลียร์คิวรูปกันกดซ้ำแล้วให้คนตรวจห้องแชทเอง
        toast(err.message);
        if (Number(err?.data?.partiallyDelivered || 0) > 0 || /ส่งได้บางส่วน/u.test(String(err.message || ""))) {
          // LINE confirmed at least one bubble. Empty the composer so a second
          // click cannot duplicate the confirmed prefix while history recovers.
          state.chatDrafts.delete(String(customerId));
          roomScope.attachments = [];
          roomScope.sticker = null;
          roomScope.sending = false;
          if (!sameRoom()) return;
          textarea.value = "";
          textarea.style.height = "auto";
          updateComposerCount();
          state.draft = null;
          renderAttachChips();
          renderStickerChoice();
          syncComposerBusy();
          await refresh();
          return;
        }
        if (err?.data?.ambiguous) {
          // The first provider call may already be visible. Require a room
          // check and explicit retype instead of leaving a one-click retry.
          const record = {
            text,
            files: attachments.map((item) => item.label || item.original_name || "ไฟล์แนบ"),
            sticker: Boolean(sticker),
            at: Date.now(),
          };
          roomScope.failedDraft = record;
          // audit 2026-08-26: เดิมบันทึกนี้อยู่บน state.chat ซึ่งถูกสร้างใหม่ทุกครั้งที่เปลี่ยนห้อง
          // แตะไปห้องอื่นแล้วกลับมา = หลักฐานว่า "ส่งไปแล้วหรือยังไม่รู้" หายเกลี้ยง
          // ทั้งที่นี่คือกรณีที่ห้ามส่งซ้ำโดยไม่ตรวจก่อน เก็บแยกตามห้องให้อยู่ข้ามการสลับ
          state.chatUncertain.set(String(customerId), record);
          state.chatDrafts.delete(String(customerId));
          roomScope.attachments = [];
          roomScope.sticker = null;
          roomScope.sending = false;
          if (!sameRoom()) return;
          textarea.value = "";
          textarea.style.height = "auto";
          updateComposerCount();
          state.draft = null;
          renderAttachChips();
          renderStickerChoice();
          syncComposerBusy();
          await refresh();
          return;
        }
      } finally {
        roomScope.sending = false;
        state.chat.sending = false;
        syncComposerBusy();
        sendBtn.disabled = false;
        sendBtn.textContent = "ส่ง";
      }
    }

    // B2: AI เปิดอยู่แต่แอดมินเพิ่งตอบเอง -> แบนเนอร์ "AI พักชั่วคราว" + ปุ่มปลดทันที
    // G7.2: pause ที่มาจาก out-of-band detection ต้องบอก "เหตุผล" ให้ชัด — ถ้าแอดมิน
    // ตอบจาก console ทีหลัง pause จะถูกต่ออายุเกินหน้าต่าง oob = กลับไปใช้ข้อความปกติ
    const pauseUntil = Number(customer.operator_active_until) || 0;
    const oob = data.outOfBand;
    const isOobPause = oob && pauseUntil > 0 && pauseUntil <= Number(oob.until);
    const pauseBanner = aiOn && pauseUntil > Date.now()
      ? el("div", { class: "pause-banner" },
          el("span", {}, isOobPause
            ? `AI พักชั่วคราว — ระบบสงสัยว่าแอดมินคุยกับลูกค้านอกระบบ (OA Manager) ตรวจสอบและเติมบริบทด้วย (ถึง ${fmtTime(pauseUntil)})`
            : `AI พักชั่วคราว — แอดมินกำลังดูแล (ถึง ${fmtTime(pauseUntil)})`),
          el("button", {
            class: "btn btn-mini btn-resume",
            onclick: async () => {
              try {
                await api(`/console/api/customers/${encodeURIComponent(customerId)}/operator-clear`, { method: "POST", body: {} });
                toast("ให้ AI ตอบต่อแล้ว");
                await refresh();
              } catch (err) {
                toast(err.message);
              }
            },
          }, "ให้ AI ตอบต่อเลย"),
        )
      : null;

    const legacyBanner = legacyReadonly
      ? el("div", { class: "legacy-readonly-banner", role: "status" },
          el("strong", {}, "ประวัติจาก LINE OA เดิม · อ่านอย่างเดียว"),
          el("span", {}, "ห้องอ้างอิงนี้ส่งผ่าน Messaging API ไม่ได้ กรุณาตอบในห้องจริงที่โยงแล้ว"),
        )
      : null;
    // 2026-08-24 (คำสั่งเจ้าของ): ห้องที่โยงประวัติเก่าแล้ว ให้แอดมินสรุปบริบทเก่าเข้าโน้ต
    // ได้จากแถบเดียวกัน — คนเขียนสรุปเอง (ไม่ใช่ AI) และโน้ตนี้ทั้ง AI/follow-up เห็นก่อนตอบ
    const legacyHistory = data.legacyHistory
      ? (() => {
          const summaryInput = el("input", {
            class: "legacy-note-input keep-focus", type: "text", maxlength: "300",
            placeholder: "สรุปบริบทเก่าสั้น ๆ เช่น เคยเรียน AI Basic สนใจต่อยอด Automation",
          });
          let savingLegacyNote = false;
          return el("div", { class: "legacy-history-strip" },
            el("a", {
              class: "legacy-history-link",
              href: `#/c/${encodeURIComponent(data.legacyHistory.id)}`,
            }, `ประวัติเดิมจาก LINE OA · โยงด้วยชื่อแล้ว · ดู ${Number(data.legacyHistory.count || 0).toLocaleString("th-TH")} ข้อความเก่า ›`),
            el("form", {
              class: "legacy-note-form",
              onsubmit: async (e) => {
                e.preventDefault();
                const summary = summaryInput.value.trim();
                if (!summary) return toast("พิมพ์สรุปบริบทเก่าก่อนบันทึกนะคะ");
                if (savingLegacyNote) return;
                savingLegacyNote = true;
                try {
                  const saved = await api(`/console/api/customers/${encodeURIComponent(customerId)}/notes`, {
                    method: "POST",
                    body: { text: `📜 บริบทจากระบบเก่า (${Number(data.legacyHistory.count || 0).toLocaleString("th-TH")} ข้อความ): ${summary}` },
                  });
                  // ปักหมุดเสมอ — AI อ่านแค่ 10 โน้ตล่าสุด (pinned ก่อน) ถ้าไม่ปัก
                  // บริบทเก่าจะหลุดจากสายตา AI เมื่อโน้ตใหม่ทับ (verifier จับ 2026-08-24)
                  if (saved?.note?.id) {
                    await api(`/console/api/notes/${encodeURIComponent(saved.note.id)}/pin`, {
                      method: "POST", body: { pinned: true },
                    }).catch(() => {});
                  }
                  toast("บันทึกบริบทเก่าเข้าโน้ตแล้ว (📌 ปักหมุด) — AI และ follow-up จะเห็นก่อนตอบทุกครั้ง");
                  summaryInput.value = "";
                  refresh();
                } catch (err) {
                  toast(err?.message || "บันทึกโน้ตไม่สำเร็จ");
                } finally {
                  savingLegacyNote = false;
                }
              },
            }, summaryInput, el("button", { class: "btn btn-outline btn-mini", type: "submit" }, "เข้าโน้ต")),
          );
        })()
      : null;

    const jumpBtn = el("button", {
      class: "jump-latest",
      "aria-label": "เลื่อนไปข้อความล่าสุด",
      onclick: () => {
        bubbles.scrollTop = bubbles.scrollHeight;
        state.chat.atBottom = true;
      },
    }, "↓ ล่าสุด");

    const dropOverlay = el("div", { class: "chat-drop-overlay", hidden: true },
      el("strong", {}, `วางไฟล์ตรงนี้เพื่อแนบในแชทกับ ${customerLabel(customer)}`),
      el("span", {}, "ตรวจรายการก่อนกดส่งทุกครั้ง"),
    );
    let dragDepth = 0;
    const pane = el("section", {
      class: "chat-pane",
      ondragenter: (e) => {
        if (!(canSendImages() || canSendFiles()) || !e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        dragDepth += 1;
        dropOverlay.hidden = false;
      },
      ondragover: (e) => {
        if (!(canSendImages() || canSendFiles()) || !e.dataTransfer?.types?.includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      },
      ondragleave: () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) dropOverlay.hidden = true;
      },
      ondrop: (e) => {
        e.preventDefault();
        dragDepth = 0;
        dropOverlay.hidden = true;
        ingestFiles([...(e.dataTransfer?.files || [])]);
      },
    },
      chatHead(customerId, customer, aiOn, refresh, {
        legacyReadonly,
        aiPaused: data?.aiPaused === true,
        lineOaContext: data?.lineOaContext ?? null,
        triage,
        onDone,
      }),
      legacyReadonly ? null : triageStrip({ customerId, customer, triage }),
      // 6 ต.ค. 2026 ค่ำ (เจ้าของ): ห้องนี้มาจากแอดไหน — แบบกล่องข้อความ Meta ("แชทนี้มีข้อความตอบกลับต่อโฆษณา")
      adReferralBanner(data?.adReferral, { roomId: customerId }),
      legacyBanner,
      legacyHistory,
      pauseBanner,
      bubbles,
      jumpBtn,
      legacyReadonly ? null : (replyBar = el("footer", { class: "reply-bar" }, uncertainCard, draftCard,
        // 28 ก.ย. 2026: Facebook ให้คอนโซลตอบ (RESPONSE) ได้ภายใน 24 ชม. หลังข้อความล่าสุดของลูกค้า — บอกก่อนพิมพ์
        triage?.fbReplyClosed
          ? el("div", { class: "fb-window-banner", role: "note" },
              el("strong", {}, "Facebook เกิน 24 ชม. แล้ว"),
              el("span", {}, "คอนโซลส่งข้อความหาลูกค้าคนนี้ไม่ได้ — ตอบใน Meta Business Suite ได้ถึง 7 วันหลังข้อความล่าสุดของลูกค้า"),
              el("div", { class: "fb-suite-actions" },
                // 28 ก.ย. 2026: Business Suite เปิดห้องตรงด้วยรหัสลูกค้าไม่ได้ — ปุ่มเดียวเปิดกล่องข้อความของเพจ + คัดลอกชื่อ Facebook ไว้วางค้นหา
                (() => {
                  const name = String(customer?.display_name || customer?.known_name || "").trim();
                  const copyName = async () => {
                    if (!name) return;
                    try { await navigator.clipboard.writeText(name); toast(`คัดลอกชื่อ "${name}" แล้ว — วางในช่องค้นหาของ Business Suite`); }
                    catch { toast(`คัดลอกไม่ได้ — ค้นชื่อ "${name}" ใน Business Suite`); }
                  };
                  const url = /^https:\/\/business\.facebook\.com\//u.test(String(triage?.businessSuiteUrl || "")) ? triage.businessSuiteUrl : "";
                  if (url) {
                    return el("a", { class: "btn btn-outline btn-mini fb-suite-link", href: url, target: "_blank", rel: "noopener noreferrer", onclick: () => { void copyName(); } },
                      name ? "เปิด Business Suite + คัดลอกชื่อ ↗" : "เปิด Business Suite ↗");
                  }
                  return name ? el("button", { type: "button", class: "btn btn-outline btn-mini fb-suite-copy", onclick: () => { void copyName(); } }, "คัดลอกชื่อไว้ค้นหา") : null;
                })()))
          : null,
        attachChips, stickerChip, stickerMenu,
        // คำสั่งเจ้าของ 2026-08-26: ถอดคำอธิบายเรื่องลิงก์ชั่วคราวออก
        // ใช้กันแค่สองคน (เจ้าของ + แอดมิน) รู้อยู่แล้วว่าระบบทำงานยังไง
        // ข้อความยาว ๆ เหนือช่องพิมพ์เบียดพื้นที่แชทโดยไม่ได้ช่วยอะไร
        el("div", { class: "reply-line" }, fileInput, attachBtn, stickerBtn, textarea, charCount, sendBtn))),
      dropOverlay,
    );
    syncComposerBusy(); // render ใหม่ระหว่างมีงานค้าง ต้องติดธง busy กลับมาทันที
    return { pane, bubbles, textarea };
  }

  /* ------------------------------ workspace ------------------------------ */

  // REVIEW FIX 2026-08-10 (stale-render race): render ที่เริ่มก่อนแต่ fetch เสร็จทีหลัง
  // ห้าม mount ทับห้องใหม่/ห้าม arm timer ของห้องเก่า — ทุก render จับเลขรุ่นของตัวเอง
  // แล้วเช็คหลัง await: ถ้ามี render ใหม่กว่าแซงไปแล้ว = ทิ้งผลตัวเองเงียบ ๆ ทันที
  let renderGen = 0;
  let lastRendered = { key: "", sigInbox: "", sigRoom: "" };

  async function renderChat({ customerId = null, filter = null, poll = false, listOnly = false } = {}) {
    const gen = ++renderGen;
    const routeGen = state.routeGen;
    const expectedHash = location.hash || "#/";
    stopPolling();
    if ((state.inbox.filter ?? null) !== (filter ?? null)) {
      state.inbox.filter = filter ?? null;
      state.inbox.extra = [];
    }
    if (customerId !== state.chat.id) {
      olderLoadGen += 1;
      state.chat = { id: customerId, head: [], older: [], hasMoreOlder: false, atBottom: true, keepFromBottom: null };
    }
    // BUGFIX 2026-08-10 (เจ้าของเจอ: เลื่อนดูแชทเก่าแล้วโดนดึงกลับล่างทุกรอบ poll):
    // เก็บ "ระยะจากก้นจอ" ของจริงก่อน re-render — ไม่ใช่เดาตำแหน่งใหม่เอง
    // (loadOlder ตั้ง keepFromBottom มาก่อนแล้ว = ของเขาชนะ ห้ามทับ)
    const prevBubbles = document.querySelector(".bubbles");
    if (prevBubbles && !state.chat.atBottom && state.chat.keepFromBottom == null) {
      state.chat.keepFromBottom = prevBubbles.scrollHeight - prevBubbles.scrollTop;
    }
    // ตัดสิน default ของแผงข้อมูลตอนเปิดห้องแรก (ไม่ใช่ตอน boot — ขนาดจอตอนนั้นเชื่อถือได้กว่า):
    // เดสก์ท็อปเปิดไว้เลย, มือถือเป็นแผ่นเลื่อนเริ่มปิด
    if (customerId && state.ui.contextOpen == null) {
      state.ui.contextOpen = window.matchMedia("(min-width: 1024px)").matches;
    }

    // BUGFIX เดิม (2026-08-10): เก็บ draft/โฟกัสสดก่อน await — กัน race ระหว่าง fetch
    // audit 2026-08-26 (วิกฤต): ต้องรู้ด้วยว่าข้อความที่ค้างอยู่เป็น "ของห้องไหน"
    // ตอนกดสลับห้อง DOM ยังเป็นห้องเก่า ถ้ากู้ข้ามห้องจะกลายเป็นส่งของคนหนึ่งไปให้อีกคน
    const prevInput = document.querySelector(".reply-input");
    const draftCarried = (prevInput && prevInput.value) || "";
    const draftRoom = prevInput ? String(prevInput.dataset?.room || "") : "";
    // เก็บลงกระเป๋าแยกตามห้อง กลับมาห้องเดิมแล้วได้ข้อความคืน ไม่ใช่หายไปเฉย ๆ
    if (draftRoom) {
      if (draftCarried) state.chatDrafts.set(draftRoom, draftCarried);
      else state.chatDrafts.delete(draftRoom);
    }
    const replyFocused = prevInput && document.activeElement === prevInput;
    // audit 2026-08-26: renderChat กู้แค่กล่องพิมพ์กับช่องค้นหา ทุกช่องในแผงขวา
    // (โน้ตส่งต่อ, ป้าย, ชื่อจริง, โน้ตนัด) ถูกสร้างใหม่เป็นค่าว่างทุกครั้ง
    // กดอะไรก็ได้ในแผงเดียวกันแล้วโน้ตที่เขียนค้างไว้หายทันที โดยไม่มีคำเตือน
    // keep-focus กันได้แค่ตอนที่ช่องนั้น "ถือโฟกัสอยู่" เท่านั้น
    // 2026-08-28: กุญแจของ snapshot คือ "ชื่อคลาสของช่อง" ซึ่งเหมือนกันทุกห้อง
    // พอสลับห้อง ค่าของห้องเก่าจึงถูกยัดลงห้องใหม่ — ชื่อจริงของลูกค้าคนหนึ่งไปโผล่
    // ในช่องของอีกคนทั้งระบบ (เจ้าของเห็นคำว่า "เกรซ" ในทุกห้องที่เปิด) ยังไม่มีใคร
    // กดบันทึกทับ แต่ถ้ากดคือเขียนชื่อผิดคนลงฐานทันที
    //
    // ใช้กติกาเดียวกับกล่องพิมพ์ตอบด้านบน (audit 2026-08-26): กู้ได้เฉพาะห้องเดิม
    const keepFocusRoom = draftRoom;
    const keepFocusSnapshot = new Map();
    for (const node of document.querySelectorAll(".chat-workspace .keep-focus")) {
      const key = String(node.className || "");
      if (key && typeof node.value === "string" && node.value !== "") keepFocusSnapshot.set(key, node.value);
    }
    const prevSearch = document.querySelector(".convo-search-input");
    const searchFocused = prevSearch && document.activeElement === prevSearch;

    const inboxParams = new URLSearchParams({ limit: "30" });
    if (state.inbox.filter) inboxParams.set("segment", state.inbox.filter);
    if (state.inbox.q) {
      inboxParams.set("q", state.inbox.q);
      // audit 2026-08-26: ช่องค้นหาเขียนว่า "ค้นหาชื่อ หรือทุกข้อความ" แต่หน้าที่ผู้ใช้
      // เห็นจริง (การโหลดครั้งแรก) ไม่เคยส่ง deep=1 จึงค้นได้แค่ชื่อ
      // ฝั่งเซิร์ฟเวอร์รองรับอยู่แล้วและมีการ์ดกันสแกนกว้างเกิน (ต้องยาว >= 2 ตัวอักษร)
      if (state.inbox.q.length >= 2) inboxParams.set("deep", "1");
    }
    if (state.channel) inboxParams.set("channel", state.channel); // W3: สาขาที่เลือกอยู่
    // perf 2026-08-24 (วินิจฉัย "แชทช้า"): query inbox คือตัวหนักสุดของ server (สแกน 5,478 ราย)
    // เดิมห้องแชทต้องรอ inbox ทุกครั้งทั้งตอนเปิดห้องและทุก poll 7 วิ —
    // ตอนอยู่ในห้อง ให้ใช้ inbox ล่าสุดภายใน 30 วิแทน (รายการซ้ายช้ากว่าห้องได้ ไม่มีผลงานแอดมิน)
    // หน้ารายการ (ไม่มี customerId) ยังสดทุกครั้งเหมือนเดิม
    const inboxKey = inboxParams.toString();
    const inboxFresh = customerId && inboxCache.data && inboxCache.key === inboxKey &&
      (Date.now() - inboxCache.at) < INBOX_TTL_IN_ROOM_MS;
    const [inboxData, roomData] = await Promise.all([
      inboxFresh
        ? Promise.resolve(inboxCache.data)
        : api(`/console/api/inbox?${inboxKey}`).then((data) => {
            inboxCache = { at: Date.now(), key: inboxKey, data };
            return data;
          }),
      customerId
        ? api(`/console/api/conversations/${encodeURIComponent(customerId)}/messages?limit=${CHAT_PAGE}${poll ? "&seen=0" : ""}`)
        : Promise.resolve(null),
    ]);
    // stale guard: มี render ใหม่กว่าเริ่มไประหว่างรอ fetch — ผลชุดนี้เป็นของเก่า ทิ้งทันที
    // (render ตัวใหม่เป็นเจ้าของ DOM + timer แล้ว — ห้ามแตะอะไรทั้งนั้น)
    if (gen !== renderGen || routeGen !== state.routeGen || (location.hash || "#/") !== expectedHash) return;

    // Poll เดิมเคยสร้าง workspace ทั้งใบใหม่ทุก 7 วิแม้ข้อมูลไม่เปลี่ยน ทำให้ mobile
    // layout/scroll/GC หนักโดยไม่จำเป็น — response เดิมให้คง DOM จริงไว้และ rearm อย่างเดียว
    const renderKey = `${customerId || "list"}|${state.channel || "all"}|${state.inbox.filter || "all"}|${state.inbox.q || ""}`;
    const sigInbox = JSON.stringify(inboxData);
    const sigRoom = JSON.stringify(roomData);
    if (poll && lastRendered.key === renderKey && lastRendered.sigInbox === sigInbox &&
        lastRendered.sigRoom === sigRoom && document.querySelector(".chat-workspace")) {
      armPoll(customerId);
      return;
    }

    // การกระทำของแอดมิน (ส่งข้อความ/สลับ AI/โน้ต/ป้าย) เรียก refresh ตรง ๆ —
    // ต้องเห็นผลที่รายการซ้ายทันที จึงล้าง cache inbox ก่อน render ใหม่เสมอ
    const refresh = () => { inboxCache.at = 0; return renderChat({ customerId, filter: state.inbox.filter }); };
    const rerender = refresh;
    // 28 ก.ย. 2026: ลำดับทั้งคิวรอตอบ (ไม่ใช่แค่หน้าที่โหลด) — ปุ่ม "ห้องถัดไป" กับการเปิดห้องถัดไปอัตโนมัติใช้ตัวนี้
    state.inbox.waitingOrder = Array.isArray(inboxData?.waitingOrder) ? inboxData.waitingOrder.map(String) : null;
    // ปุ่มลัดบนแถว (✓ เสร็จสิ้น/สแปม) กับห้องที่เปิดอยู่ในคิวรอตอบ = ไปห้องถัดไปเหมือนกดในหัวห้อง
    const onRowDone = async (room) => {
      if (customerId && room?.id === customerId && isWaitingFilter(state.inbox.filter)) return advanceWaiting(customerId, "เรียบร้อย");
      return refresh();
    };

    // perf 2026-08-24: ห้องไม่เปลี่ยนแต่รายการซ้ายเปลี่ยน (ลูกค้าคนอื่นทัก/นับ unread ขยับ)
    // — เดิม rebuild ทั้ง workspace ทำให้ฟองแชท+รูป+วิดีโอถูกสร้างใหม่ทุก 7-10 วิ
    // เปลี่ยนเป็นสลับเฉพาะแผงรายการซ้าย DOM ห้องเดิมอยู่ครบ (รูปไม่โหลดซ้ำ ไม่กระพริบ)
    if (poll && customerId && (listOnly || (lastRendered.key === renderKey && lastRendered.sigRoom === sigRoom))) {
      const existingConvo = document.querySelector(".chat-workspace .convo-pane");
      if (existingConvo) {
        existingConvo.replaceWith(convoPane.build({ data: inboxData, activeId: customerId, rerender, onRowDone }));
        revealActiveChip();
        // listOnly = ห้องยังไม่ถูก re-render จึงห้ามจำ sigRoom ว่าเป็นของใหม่
        // ไม่งั้นพอพิมพ์เสร็จแล้ว ห้องจะไม่ถูกอัปเดตเพราะระบบคิดว่าอัปเดตไปแล้ว
        lastRendered = listOnly
          ? { ...lastRendered, sigInbox }
          : { key: renderKey, sigInbox, sigRoom };
        armPoll(customerId);
        return;
      }
    }

    let chatPaneEl = null;
    let contextEl = null;
    let bubbles = null;
    let textarea = null;
    if (roomData) {
      state.chat.head = roomData.messages || [];
      if (!state.chat.older.length) state.chat.hasMoreOlder = roomData.hasMoreOlder === true;
      // 2026-08-24 (คำสั่งเจ้าของ "ดูได้หมด"): จำห้องระบบเก่าที่โยงแล้ว เพื่อให้
      // "ดูข้อความเก่ากว่า" ไหลต่อเข้าประวัติเก่าในห้องเดียวกันเมื่อหน้าห้องจริงหมด
      if (roomData.legacyHistory?.id) state.chat.legacyId = roomData.legacyHistory.id;
      else if (state.chat.legacyId === undefined) state.chat.legacyId = null;
      const built = buildChatPane({ customerId, data: roomData, refresh });
      chatPaneEl = built.pane;
      bubbles = built.bubbles;
      textarea = built.textarea;
      contextEl = contextPane.build({
        customerId,
        customer: roomData.customer,
        followupAppointmentArmed: roomData.followupAppointmentArmed !== false,
        score: roomData.score,
        followups: roomData.followups,
        followupGlobal: roomData.followupGlobal,
        handoffNotes: roomData.handoffNotes,
        aiCost: roomData.aiCost,
        orders: roomData.orders, // G6: ออเดอร์ค้างในแผงข้อมูล
        tags: roomData.tags, // v1.1 (item 7): chat tags
        lifecycle: roomData.lifecycle,
        lifecycleEvents: roomData.lifecycleEvents,
        identityLinks: roomData.identityLinks ?? null, // 28 ก.ย. 2026: ช่องทางอื่นของลูกค้าคนนี้
        textarea,
        refresh,
        closeContext: () => {
          state.ui.contextOpen = false;
          document.querySelector(".chat-workspace")?.classList.remove("ctx-open");
        },
      });
    } else {
      // เดสก์ท็อปยังไม่เลือกห้อง — ช่องกลางเป็น empty state ที่สอนวิธีใช้
      // 28 ก.ย. 2026: อยู่ในคิวรอตอบ = ปุ่มเปิดห้องบนสุดเลย (ไล่ทีละห้อง ห้องถัดไปเปิดเอง)
      const firstWaiting = isAdvanceQueue(state.inbox.filter) ? (state.inbox.waitingOrder || [])[0] : null;
      chatPaneEl = el("section", { class: "chat-pane chat-empty" },
        el("div", { class: "chat-empty-box" },
          emptyArt(),
          firstWaiting
            ? [
                el("p", { class: "chat-empty-title" }, "เริ่มจากห้องบนสุดของคิว"),
                el("p", { class: "chat-empty-sub" }, isHotFollowFilter(state.inbox.filter)
                  ? "พิมพ์คุยกับลูกค้าต่อจากลูกแพร แล้วห้องถัดไปจะเปิดให้เอง ไม่ต้องกลับมาที่รายการ"
                  : "ตอบ / ✓ เสร็จสิ้น / สแปม แล้วห้องถัดไปจะเปิดให้เอง ไม่ต้องกลับมาที่รายการ"),
                el("a", { class: "btn btn-primary chat-empty-go", href: roomHash(state.inbox.filter, firstWaiting) }, "เปิดห้องแรก →"),
              ]
            : [
                el("p", { class: "chat-empty-title" }, "เลือกบทสนทนาจากรายการ"),
                el("p", { class: "chat-empty-sub" }, "แถบ 🔥 สนใจสูง คือลูกค้าที่ใกล้ตัดสินใจที่สุด — เริ่มจากตรงนั้นได้เลย"),
              ],
        ),
      );
    }

    // ทางออกที่สองของแผงข้อมูลบนมือถือ (เคสจริง 2026-08-27: แอดมินกด i แล้วออกไม่ได้)
    // ปุ่ม ✕ อยู่บนสุดของแผงซึ่งไปชนรอยบาก iPhone — ผู้ใช้ต้องมีทางออกมากกว่าหนึ่งทางเสมอ
    // เดสก์ท็อปซ่อนด้วย CSS เพราะแผงเป็นคอลัมน์ปกติ ไม่ได้ทับอะไร
    const closePanel = () => {
      state.ui.contextOpen = false;
      document.querySelector(".chat-workspace")?.classList.remove("ctx-open");
    };
    const backdrop = el("div", { class: "ctx-backdrop", "aria-hidden": "true", onclick: closePanel });

    const workspace = el("div", {
      class: `chat-workspace${customerId && state.ui.contextOpen ? " ctx-open" : ""}`,
    },
      convoPane.build({ data: inboxData, activeId: customerId, rerender, onRowDone }),
      chatPaneEl,
      backdrop,
      contextEl,
    );

    mount(pageHeader("แชท"), workspace, tabBar());
    lastRendered = { key: renderKey, sigInbox, sigRoom };
    setView(customerId ? "room" : "list");
    // หลัง setView เท่านั้น — มือถือซ่อนรายการตอนอยู่ในห้อง (display:none) วัดตำแหน่งชิปไม่ได้
    revealActiveChip();

    // จัด scroll ฟองแชท: อยู่ก้นจอ = ตามล่าสุด / เลื่อนขึ้นอยู่ = ค้างตำแหน่งเดิมเป๊ะ
    if (bubbles) {
      if (state.chat.keepFromBottom != null) {
        bubbles.scrollTop = bubbles.scrollHeight - state.chat.keepFromBottom;
        state.chat.keepFromBottom = null;
        if (!state.chat.atBottom) chatPaneEl.classList.add("is-scrolled-up");
      } else if (state.chat.atBottom) {
        bubbles.scrollTop = bubbles.scrollHeight;
      } else {
        // ทางหนีสุดท้าย (ไม่มี DOM เดิมให้วัด เช่น เพิ่งกลับเข้าห้อง) — ใกล้ล่างสุดพอเห็นบริบท
        bubbles.scrollTop = Math.max(0, bubbles.scrollHeight - bubbles.clientHeight - 200);
        chatPaneEl.classList.add("is-scrolled-up");
      }
    }

    // คืนข้อความที่พิมพ์ค้าง + โฟกัส (reply กับช่องค้นหา)
    // กู้ได้เฉพาะข้อความของห้องนี้เท่านั้น — ข้ามห้องคือบั๊กที่ทำให้ส่งผิดคน
    const restored = String(customerId || "") ? state.chatDrafts.get(String(customerId)) || "" : "";
    if (textarea && restored && !textarea.value) {
      textarea.value = restored;
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
    }
    // คืนค่าที่พิมพ์ค้างในแผงขวา — เฉพาะช่องที่ยังว่างอยู่ ไม่ทับของที่ระบบเพิ่งเติมมา
    // และต้องเป็นห้องเดิมเท่านั้น ห้องใหม่ต้องเห็นข้อมูลของตัวเองล้วน ๆ เสมอ
    if (keepFocusRoom && keepFocusRoom === String(customerId || "")) {
      for (const [key, value] of keepFocusSnapshot) {
        const node = document.querySelector(`.chat-workspace .${key.trim().split(/\s+/u).join(".")}`);
        if (node && typeof node.value === "string" && node.value === "") node.value = value;
      }
    }
    if (textarea && replyFocused) {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }
    if (searchFocused) {
      const search = document.querySelector(".convo-search-input");
      if (search) {
        search.focus();
        search.setSelectionRange(search.value.length, search.value.length);
      }
    }

    // refresh เบา ๆ — ห้อง 7 วิ / รายการ 10 วิ; กำลังพิมพ์ที่ไหนก็ห้าม re-render ทับ
    armPoll(customerId);
  }

  // BUGFIX 2026-08-10 (เจ้าของเจอ: แชทหยุดอัพเดทจนต้อง refresh มือ): เดิมใช้ setInterval
  // ที่ renderChat ล้มกลางทาง (เน็ตสะดุด/เครื่องพัก) แล้ว timer ถูก stopPolling เคลียร์
  // โดยไม่มีตัวใหม่มาแทน = polling ตายถาวร — เปลี่ยนเป็น setTimeout ลูกโซ่ที่ rearm
  // ตัวเองเสมอไม่ว่ารอบนั้นสำเร็จ ล้ม หรือถูกข้าม (กำลังพิมพ์อยู่)
  function armPoll(customerId) {
    stopPolling();
    state.pollTimer = setTimeout(async () => {
      state.pollTimer = null;
      // ผู้ใช้เปลี่ยนห้องไปแล้ว — REVIEW FIX: ห้ามจบเฉย ๆ (polling จะตายถาวร)
      // arm ต่อให้ห้องปัจจุบันแทน (renderGen กันซ้อนกับ timer ของ nav อยู่แล้วชั้นหนึ่ง)
      if ((state.chat.id ?? null) !== (customerId ?? null)) {
        if (!state.pollTimer) armPoll(state.chat.id ?? null);
        return;
      }
      try {
        await refreshChatIfReady({
          documentRef: document,
          render: renderChat,
          customerId,
          filter: state.inbox.filter,
        });
      } catch { /* เงียบ — rearm ด้านล่างเสมอ */ }
      finally {
        // renderChat ที่สำเร็จจะ arm รอบใหม่เองตอนจบ; ถ้า throw/ถูกข้าม ให้ arm ตรงนี้
        if (!state.pollTimer) armPoll(customerId);
      }
    }, customerId ? 7_000 : 10_000);
  }

  // ทางออกที่สามของแผงข้อมูล — คีย์บอร์ด (เดสก์ท็อป/แท็บเล็ตที่ต่อคีย์บอร์ด)
  // รวมกับปุ่ม ✕ และการแตะนอกแผง = มีทางออกสามทาง ไม่มีทางติดค้างอีก
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!state.ui.contextOpen) return;
    state.ui.contextOpen = false;
    document.querySelector(".chat-workspace")?.classList.remove("ctx-open");
  });

  // กลับมาที่แท็บ (จากพับเครื่อง/สลับแอป) = refresh ทันที ไม่ต้องรอรอบ poll
  // — browser throttle timer ตอน tab ซ่อนอยู่ ทำให้ข้อความค้างนานกว่าที่ตั้งไว้มาก
  document.addEventListener("visibilitychange", () => {
    refreshChatIfReady({
      documentRef: document,
      render: renderChat,
      customerId: state.chat.id,
      filter: state.inbox.filter,
      requireVisible: true,
      requireWorkspace: true,
    }).catch(() => {});
  });

  return renderChat;
}
