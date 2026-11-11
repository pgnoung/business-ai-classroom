import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { attachmentByteSize, attachmentDisplayName, attachmentFileType, attachmentKind, attachmentRenderMode, attachmentsForMessageRender, buildComposerReplyPayload, friendlyUnavailableReason, lineEmojiSegments, messageBody, stickerVisual, stripRepresentedMediaMarkers } from "../public/console/chatMedia.mjs";

function withFakeDocument(run) {
  const previous = globalThis.document;
  globalThis.document = {
    createElement(tagName) {
      return {
        nodeType: 1,
        tagName,
        className: "",
        hidden: false,
        attributes: {},
        children: [],
        listeners: {},
        parent: null,
        setAttribute(key, value) { this.attributes[key] = value; },
        // เก็บ listener ไว้จริง เพื่อให้เทสต์ยิง error ใส่ภาพแล้วดูว่าตกกลับเป็นข้อความไหม
        addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
        dispatch(type) { for (const fn of this.listeners[type] || []) fn(); },
        append(...children) {
          for (const child of children) { if (child?.nodeType === 1) child.parent = this; }
          this.children.push(...children);
        },
        prepend(...children) {
          for (const child of children) { if (child?.nodeType === 1) child.parent = this; }
          this.children.unshift(...children);
        },
        remove() {
          const siblings = this.parent?.children;
          if (!siblings) return;
          const at = siblings.indexOf(this);
          if (at >= 0) siblings.splice(at, 1);
        },
      };
    },
    createTextNode(value) {
      return { nodeType: 3, textContent: String(value) };
    },
  };
  try {
    return run();
  } finally {
    globalThis.document = previous;
  }
}

function findNode(node, predicate) {
  if (predicate(node)) return node;
  for (const child of node?.children || []) {
    const found = findNode(child, predicate);
    if (found) return found;
  }
  return null;
}

test("console media: unknown attachment type is a safe file card, not executable content", () => {
  assert.equal(attachmentKind({ kind: "script" }), "file");
  assert.equal(attachmentDisplayName({ kind: "file", original_name: "invoice.pdf" }), "invoice.pdf");
});

test("console media: sticker keeps a safe local label, and only standard ids get artwork", () => {
  // คำสั่งพี่ง้วง 2026-08-26: ต้องเห็นภาพสติกเกอร์ ไม่งั้นชมพู่ไม่รู้ว่าลูกค้าส่งอะไรมา
  // ข้อความยังเป็นพื้นฐานที่รับประกันเสมอ ภาพเป็นของแถมที่พังได้โดยไม่ทำให้อ่านไม่รู้เรื่อง
  // สติกเกอร์ที่ลูกค้าส่งมา: ไม่มีป้ายชื่อที่เราคัดไว้ ใช้ keywords จาก LINE
  // และต้องได้ภาพต้นฉบับมาแสดง
  const inbound = stickerVisual({ packageId: "11537", stickerId: "52002739", keywords: ["รับทราบ"] });
  assert.equal(inbound.label, "สติกเกอร์ (รับทราบ)");
  assert.equal(inbound.imageUrl, "https://stickershop.line-scdn.net/stickershop/v1/sticker/52002739/ANDROID/sticker.png");
  // URL ต้องมีแค่รหัสสติกเกอร์ ห้ามมีอะไรที่ระบุตัวลูกค้าติดไปกับคำขอออกนอกเครื่อง
  assert.doesNotMatch(inbound.imageUrl, /U[0-9a-f]{32}/u);
  assert.equal(inbound.imageUrl.includes("11537"), false, "package id ไม่จำเป็นต้องส่งออกไป");
  // ป้ายชื่อที่ "ผิดไม่ตรงภาพ" ต้องไม่มีเหลืออยู่เลย — กดผิดแล้วส่งรูปผิดความหมายให้ลูกค้า
  assert.equal(stickerVisual({ packageId: "446", stickerId: "1992" }).label, "สติกเกอร์ LINE",
    "446:1992 เคยเขียนว่า รับทราบ แต่ภาพจริงคือคนยกแก้วเบียร์ — ต้องไม่มีป้ายนั้นอีก");

  // ค่าที่ปลอมเป็น URL/สคริปต์ ต้องถูกทิ้งก่อนถึงขั้นสร้างลิงก์
  assert.equal(stickerVisual({ stickerId: "javascript:1" }).stickerId, "");
  assert.equal(stickerVisual({ stickerId: "javascript:1" }).imageUrl, "");
  assert.equal(stickerVisual({ provider_meta: { sticker: { packageId: "999", stickerId: "12345" } } }).symbol, "☺");

  // สติกเกอร์ที่ผู้ใช้ซื้อ/ทำเอง (id ยาว) ไม่มีภาพให้ดึง ต้องไม่ยิงคำขอเปล่า ๆ
  const custom = stickerVisual({ stickerId: "628569911308583033", keywords: ["ขอบคุณ", "ดีใจ"] });
  assert.equal(custom.label, "สติกเกอร์ (ขอบคุณ, ดีใจ)");
  assert.equal(custom.imageUrl, "", "id ยาวเกินชุดมาตรฐาน ต้องไม่ลองโหลดภาพ");
  // สติกเกอร์แบบข้อความ ก็ไม่มีภาพต้นฉบับเช่นกัน
  assert.equal(stickerVisual({ stickerId: "1988", stickerResourceType: "MESSAGE" }).imageUrl, "");
});

test("console media: imported Thai placeholders disappear only when their attachment is present", () => {
  assert.equal(stripRepresentedMediaMarkers("[รูปภาพ]\nรายละเอียดจริง", [{ kind: "image" }]), "รายละเอียดจริง");
  assert.equal(stripRepresentedMediaMarkers("[ไฟล์ ใบเสนอราคา.pdf]\nอ่านแล้วค่ะ", [{ kind: "file" }]), "อ่านแล้วค่ะ");
  assert.equal(stripRepresentedMediaMarkers("[สติกเกอร์]\nรับทราบ", [{ kind: "image" }]), "[สติกเกอร์]\nรับทราบ");
});

test("console media: unavailable reason is operator Thai copy, never raw internal code", () => {
  assert.equal(friendlyUnavailableReason("not_captured"), "ระบบยังไม่ได้เก็บไฟล์ต้นฉบับ");
  assert.equal(friendlyUnavailableReason("internal_storage_failed"), "ไม่สามารถเปิดไฟล์ต้นฉบับได้");
  assert.equal(friendlyUnavailableReason("legacy_recovery_queued"), "กำลังกู้/เตรียมไฟล์จาก LINE");
  assert.equal(friendlyUnavailableReason("LINE content retry (2/4)"), "กำลังกู้/เตรียมไฟล์จาก LINE");
});

test("console media: failed attachment is unavailable; only safe MIME audio/video get native players", () => {
  assert.equal(attachmentRenderMode({ id: "a1", kind: "file", status: "failed", mime: "application/pdf" }), "unavailable");
  assert.equal(attachmentRenderMode({ id: "a2", kind: "audio", status: "ready", mime: "audio/mpeg" }), "audio");
  assert.equal(attachmentRenderMode({ id: "a3", kind: "video", status: "ready", mime: "video/mp4" }), "video");
  assert.equal(attachmentRenderMode({ id: "a4", kind: "video", status: "ready", mime: "text/html" }), "file");
});

test("console media: queued provider content is a pending tile, never a broken download link", () => {
  const queued = { id: "queued-one", kind: "file", status: "queued", original_name: "กำลังมา.pdf" };
  assert.equal(attachmentRenderMode(queued), "unavailable");
  assert.equal(friendlyUnavailableReason("pending"), "กำลังเตรียมไฟล์ให้เปิด");
});

test("console media: generic business file card derives a readable type and size without trusting content", () => {
  assert.equal(attachmentFileType({ original_name: "price-list.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "XLSX");
  assert.equal(attachmentFileType({ original_name: "archive.zip", mime: "application/zip" }), "ZIP");
  assert.equal(attachmentByteSize({ byte_size: 1_572_864 }), "1.5 MB");
});

test("console media: image and files stay recipient-scoped attachment ids", () => {
  const body = buildComposerReplyPayload({
    text: "ส่งให้ค่ะ",
    attachments: [
      { kind: "image", id: "01e2d3c4-b5a6-4789-9012-3456789abcde" },
      { kind: "file", id: "f1e2d3c4-b5a6-4789-9012-3456789abcde" },
      { kind: "file", id: "a1e2d3c4-b5a6-4789-9012-3456789abcde" },
      { kind: "audio", id: "b1e2d3c4-b5a6-4789-9012-3456789abcde" },
      { kind: "video", id: "c1e2d3c4-b5a6-4789-9012-3456789abcde" },
      { kind: "file", id: "d1e2d3c4-b5a6-4789-9012-3456789abcde" },
    ],
  });
  assert.equal(body.text, "ส่งให้ค่ะ");
  assert.equal(body.attachmentIds.length, 6);
  assert.deepEqual(body.attachmentIds.slice(0, 2), ["01e2d3c4-b5a6-4789-9012-3456789abcde", "f1e2d3c4-b5a6-4789-9012-3456789abcde"]);
});

test("console media: outbound sticker metadata creates one virtual sticker renderer input", () => {
  const attachments = attachmentsForMessageRender([], "sticker", { packageId: "11537", stickerId: "52002739" });
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].kind, "sticker");
  assert.equal(stickerVisual(attachments[0]).label, "สติกเกอร์ LINE");
});

test("console media: legacy sticker id remnant fills the sticker card and never leaks as bubble text", () => {
  withFakeDocument(() => {
    const nodes = messageBody("[sticker] id=1988", [{ kind: "sticker", provider_meta: {} }]);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].className, "message-sticker");
    // ข้อความเก่ายังพก id จริงมาด้วย จึงดึงภาพต้นฉบับมาแสดงได้
    const image = findNode(nodes[0], (node) => node?.tagName === "img");
    assert.ok(image, "id ที่กู้ได้จากข้อความเก่า ต้องแสดงภาพสติกเกอร์");
    assert.equal(image.attributes.src, "https://stickershop.line-scdn.net/stickershop/v1/sticker/1988/ANDROID/sticker.png");
    assert.equal(image.attributes.referrerPolicy, "no-referrer", "ห้ามส่ง referrer ของ Console ออกไปกับคำขอภาพ");
    // คำอธิบายเป็นตัวอักษรต้องอยู่คู่กันเสมอ ไม่ใช่มีแต่ภาพลอย ๆ
    assert.ok(findNode(nodes[0], (node) => node?.className === "message-sticker-copy"));
    assert.equal(findNode(nodes[0], (node) => node?.className === "bubble-text"), null);

    // หัวใจ: ภาพโหลดไม่ขึ้น (LINE ปิด CDN, เน็ตล่ม) ต้องกลับไปเป็นสัญลักษณ์+ข้อความ
    // ห้ามเหลือกล่องว่าง เพราะชมพู่จะไม่รู้เลยว่าลูกค้าส่งอะไรมา
    image.dispatch("error");
    assert.equal(findNode(nodes[0], (node) => node?.tagName === "img"), null, "ภาพที่พังต้องถูกถอดออก");
    assert.ok(findNode(nodes[0], (node) => node?.className === "message-sticker-symbol"), "ต้องมีสัญลักษณ์มาแทน");
    assert.ok(findNode(nodes[0], (node) => node?.className === "message-sticker-copy"), "และข้อความต้องยังอยู่");

    // ไม่มี id เลย = ต้องได้สัญลักษณ์+ข้อความ ไม่ใช่กล่องว่างหรือรูปแตก
    const noId = messageBody("[sticker]", [{ kind: "sticker", provider_meta: {} }]);
    assert.equal(findNode(noId[0], (node) => node?.tagName === "img"), null);
    assert.ok(findNode(noId[0], (node) => node?.className === "message-sticker-symbol"));
  });
});

test("console media: ordinary id text without a sticker card remains visible", () => {
  withFakeDocument(() => {
    const nodes = messageBody("id=1988", []);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].className, "bubble-text");
    assert.equal(nodes[0].children[0]?.textContent, "id=1988");
  });
});

test("console media: inbound quota skip becomes an honest unavailable tile", () => {
  const attachments = attachmentsForMessageRender([], "image", {
    mediaAttachmentSkipped: true,
    mediaUnavailableReason: "คลังสื่อถึงเพดาน",
  });
  assert.equal(attachments.length, 1);
  assert.equal(attachments[0].status, "unavailable");
  assert.equal(friendlyUnavailableReason(attachments[0].unavailable_reason), "คลังสื่อเต็ม จึงไม่ได้เก็บไฟล์ต้นฉบับ");
});

test("console media: LINE emoji keeps validated provider metadata but renders the original placeholder", () => {
  assert.deepEqual(lineEmojiSegments("สวัสดี (hello)", { emojis: [{ index: 7, length: 7, productId: "5ac1bfd5040ab15980c9b435", emojiId: "001" }] }), [
    { type: "text", value: "สวัสดี " },
    { type: "emoji", value: "(hello)", productId: "5ac1bfd5040ab15980c9b435", emojiId: "001" },
  ]);
});

test("console media: composer keeps the business-file picker and the guards that matter", () => {
  const source = readFileSync(new URL("../public/console/chat.mjs", import.meta.url), "utf8");
  const renderer = readFileSync(new URL("../public/console/chatMedia.mjs", import.meta.url), "utf8");
  assert.match(source, /capabilities\?\.includes\("media\.send"\)/u);
  assert.match(source, /\.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.md,.json,.zip,.mp4,.mov,.m4a,.mp3/u);
  assert.match(source, /private recipient-scoped store/u);
  // คำสั่งพี่ง้วง 2026-08-26: ถอดคำอธิบายเรื่องลิงก์ชั่วคราวออกจากหน้าแชท
  // ใช้กันแค่สองคนที่รู้ระบบดีอยู่แล้ว ข้อความยาวเบียดพื้นที่แชทโดยไม่ช่วยอะไร
  // สิ่งที่ต้องคงไว้คือ "พฤติกรรม" ไม่ใช่ "คำอธิบาย" — เส้นทางอัปโหลดยังต้องอยู่ครบ
  assert.doesNotMatch(source, /รูปเก็บแบบ private/u, "คำอธิบายถูกถอดออกตามคำสั่งเจ้าของ");
  assert.match(source, /conversations\/\$\{encodeURIComponent\(customerId\)\}\/attachments/u);
  assert.match(source, /clipboardData\?\.files/u);
  assert.match(source, /ondrop/u);
  assert.match(source, /metaKey \|\| e\.ctrlKey/u);
  assert.match(source, /\/2000/u);
  // ภาพสติกเกอร์ต้องเป็น "ของแถมที่พังได้" — ต้องมี onerror สลับกลับเป็นข้อความเสมอ
  // ถ้าวันหนึ่ง LINE ปิด CDN นี้ ชมพู่ต้องยังอ่านออกว่าลูกค้าส่งสติกเกอร์อะไรมา
  assert.match(renderer, /stickershop\.line-scdn\.net/u, "สติกเกอร์ชุดมาตรฐานต้องแสดงภาพจริง");
  assert.match(renderer, /onerror/u, "โหลดภาพไม่ขึ้นต้องมีทางกลับไปเป็นข้อความ");
  assert.match(renderer, /referrerPolicy/u, "ห้ามส่ง referrer ของ Console ออกไปกับคำขอภาพ");
});
