// broadcastComposer.mjs — ตัวเขียนบับเบิล + ตัวอย่างหน้าจอ LINE (28 ก.ย. 2026)
// ใช้ร่วมกันระหว่างบรอดแคสต์และข้อความตามขั้น: ข้อความ · รูปจากคลัง · สติกเกอร์ชุดที่อนุมัติ · การ์ด/การ์ดเลื่อน
// ทุกค่าที่คนพิมพ์เข้า DOM ผ่าน el() (text node) เท่านั้น · ไม่มี inline style (CSP) · เซิร์ฟเวอร์ตรวจซ้ำทุกอย่าง
import { el } from "./dom.mjs";
import { put } from "./broadcastState.mjs";
import { stickerImageUrl } from "./chatMedia.mjs";

const URL_RE = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gu;
export const BUBBLE_TYPES = Object.freeze([
  { type: "text", label: "ข้อความ", glyph: "Aa" },
  { type: "image", label: "รูป", glyph: "▣" },
  { type: "sticker", label: "สติกเกอร์", glyph: "☺" },
  { type: "card", label: "การ์ด", glyph: "▤" },
]);

export function newBubble(type) {
  if (type === "image") return { type: "image", key: "" };
  if (type === "sticker") return { type: "sticker", packageId: "", stickerId: "" };
  if (type === "card") return { type: "card", altText: "", cards: [newCard()] };
  return { type: "text", text: "" };
}

export function newCard() {
  return { imageKey: "", title: "", text: "", buttons: [] };
}

/** บับเบิลนี้พร้อมส่งไหม (เซิร์ฟเวอร์ตรวจละเอียดอีกชั้น — ตรงนี้กันปุ่มกดได้ทั้งที่ยังว่าง) */
export function bubbleIsReady(bubble) {
  if (bubble?.type === "text") return String(bubble.text || "").trim().length > 0;
  if (bubble?.type === "image") return Boolean(bubble.key);
  if (bubble?.type === "sticker") return Boolean(bubble.packageId && bubble.stickerId);
  if (bubble?.type === "card") {
    return Array.isArray(bubble.cards) && bubble.cards.length > 0 && bubble.cards.every((card) =>
      (card.imageKey || String(card.title || "").trim() || String(card.text || "").trim())
      && (card.buttons || []).every((button) => String(button.label || "").trim()
        && (button.kind === "message" ? String(button.text || "").trim() : /^https:\/\//u.test(String(button.uri || "").trim()))));
  }
  return false;
}

/** ทรงที่ส่งให้เซิร์ฟเวอร์ (ตัดช่องว่างหัวท้าย) — เฉพาะบับเบิลที่พร้อม */
export function serializeBubbles(bubbles = []) {
  return bubbles.filter(bubbleIsReady).map((bubble) => {
    if (bubble.type === "text") return { type: "text", text: String(bubble.text).trim() };
    if (bubble.type === "image") return { type: "image", key: bubble.key };
    if (bubble.type === "sticker") return { type: "sticker", packageId: bubble.packageId, stickerId: bubble.stickerId };
    return {
      type: "card",
      altText: String(bubble.altText || "").trim(),
      cards: bubble.cards.map((card) => ({
        imageKey: card.imageKey || "",
        title: String(card.title || "").trim(),
        text: String(card.text || "").trim(),
        buttons: (card.buttons || []).map((button) => (button.kind === "message"
          ? { label: String(button.label).trim(), kind: "message", text: String(button.text).trim() }
          : { label: String(button.label).trim(), kind: "uri", uri: String(button.uri).trim() })),
      })),
    };
  });
}

/** แปลงข้อความที่เก็บไว้ (ประวัติ/แม่แบบ) กลับเป็นบับเบิลที่แก้ได้ */
export function bubblesFromStored(messages = []) {
  return (Array.isArray(messages) ? messages : []).slice(0, 5).map((m) => {
    if (m?.type === "image") return { type: "image", key: String(m.key || "") };
    if (m?.type === "sticker") return { type: "sticker", packageId: String(m.packageId || ""), stickerId: String(m.stickerId || "") };
    if (m?.type === "card") {
      return {
        type: "card", altText: String(m.altText || ""),
        cards: (Array.isArray(m.cards) ? m.cards : []).slice(0, 10).map((card) => ({
          imageKey: String(card?.imageKey || ""), title: String(card?.title || ""), text: String(card?.text || ""),
          buttons: (Array.isArray(card?.buttons) ? card.buttons : []).slice(0, 3).map((button) => ({
            label: String(button?.label || ""), kind: button?.kind === "message" ? "message" : "uri",
            uri: String(button?.uri || ""), text: String(button?.text || ""),
          })),
        })),
      };
    }
    return { type: "text", text: String(m?.text || "") };
  });
}

export function textHasLink(text) {
  URL_RE.lastIndex = 0;
  return URL_RE.test(String(text || ""));
}

/* ------------------------------- ตัวเขียน ------------------------------- */

function counter(value, max) {
  const length = Array.from(String(value || "")).length;
  return el("span", { class: `bs-count${length > max ? " is-over" : ""}` }, `${length}/${max}`);
}

function field(label, input, extra = null) {
  return el("label", { class: "bs-field" }, el("span", { class: "bs-field-label" }, label, extra), input);
}

/**
 * @param {{ meta, bubbles: Array, onChange: Function, toast: Function, uploadMedia?: Function, tracking?: boolean }} deps
 * bubbles คืออาร์เรย์ที่ผู้เรียกถือไว้ (แก้ในที่) — onChange({ structural }) บอกให้วาดตัวอย่าง/คำนวณใหม่
 */
export function createComposer({ meta = {}, bubbles, onChange = () => {}, toast = () => {}, uploadMedia = null, tracking = false, idPrefix = "bs" }) {
  const limits = meta.limits || {};
  const maxBubbles = Number(limits.maxBubbles) || 5;
  const images = [...(meta.images || [])];
  const stickers = meta.stickers || [];
  const root = el("div", { class: "bs-composer" });
  const list = el("ol", { class: "bs-bubbles", "aria-label": "บับเบิลที่จะส่ง" });

  // กรอบประของบับเบิลที่ยังไม่ครบ ต้องตามการพิมพ์ทันที (ไม่วาดรายการใหม่ทั้งชุด = ไม่เสียตำแหน่งเคอร์เซอร์)
  const syncCompleteness = () => {
    for (const [index, item] of [...list.children].entries()) {
      if (bubbles[index]) item.classList.toggle("is-incomplete", !bubbleIsReady(bubbles[index]));
    }
  };
  const changed = (structural = false) => {
    syncCompleteness();
    onChange({ structural });
  };
  const rerender = () => {
    renderList();
    changed(true);
  };

  function imagePicker(currentKey, onPick, { httpsOnly = false } = {}) {
    const choices = images.filter((image) => !httpsOnly || image.https !== false);
    if (!choices.length) {
      return el("p", { class: "block-hint" }, "ยังไม่มีรูปในคลัง — อัปโหลดรูป JPEG/PNG ก่อน (ปุ่มด้านล่าง)");
    }
    return el("div", { class: "bs-image-grid", role: "listbox", "aria-label": "เลือกรูปจากคลัง" },
      choices.map((image) => el("button", {
        type: "button", role: "option",
        class: `bs-image-choice${image.key === currentKey ? " is-selected" : ""}`,
        "aria-selected": image.key === currentKey ? "true" : "false",
        title: image.label || image.key,
        onclick: () => onPick(image.key),
      },
        el("img", { src: image.previewSrc, alt: image.label || image.key, loading: "lazy" }),
        image.uploaded ? el("span", { class: "bs-image-tag" }, "อัปโหลด") : null,
      )));
  }

  function uploadControl(onUploaded) {
    const upload = meta.mediaUpload || { enabled: false };
    const input = el("input", {
      class: "bs-file", type: "file", accept: "image/jpeg,image/png", tabindex: "-1", "aria-hidden": "true",
      onchange: async (event) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file || !uploadMedia) return;
        if (!(upload.formats || ["image/jpeg", "image/png"]).includes(file.type)) return toast("รองรับเฉพาะ JPEG หรือ PNG ค่ะ");
        if (file.size > (upload.maxBytes || 1_000_000)) return toast(`รูปต้องไม่เกิน ${(upload.maxBytes || 1_000_000).toLocaleString("en-US")} bytes`);
        button.disabled = true;
        button.textContent = "กำลังอัปโหลด…";
        try {
          const response = await uploadMedia(`/console/api/broadcast/media?label=${encodeURIComponent(file.name)}`, file);
          const media = response.media;
          const existing = images.findIndex((entry) => entry.key === media.key);
          if (existing >= 0) images.splice(existing, 1);
          images.unshift({ key: media.key, label: media.label, previewSrc: media.consoleUrl || media.url, uploaded: true, https: true });
          onUploaded(media.key);
          toast(response.deduplicated ? "รูปนี้มีในคลังแล้ว — เลือกให้แล้ว" : "อัปโหลดรูปแล้ว");
        } catch (error) {
          toast(error.message);
        } finally {
          button.disabled = false;
          button.textContent = "อัปโหลดรูปใหม่";
        }
      },
    });
    const button = el("button", {
      type: "button", class: "btn btn-outline btn-mini",
      disabled: upload.enabled && uploadMedia ? null : true,
      title: upload.enabled ? "JPEG/PNG ไม่เกิน 1 MB" : (upload.reason || "ยังไม่เปิดอัปโหลดรูป"),
      onclick: () => input.click(),
    }, "อัปโหลดรูปใหม่");
    return el("span", { class: "bs-upload" }, button, input);
  }

  function textEditor(bubble, index) {
    const max = Number(limits.textMax) || 1000;
    const count = el("span");
    const hint = el("p", { class: "bs-link-hint", hidden: true }, "มีลิงก์ในข้อความ — ระบบแปลงเป็นลิงก์นับคลิกให้อัตโนมัติ (ปลายทางเดิม)");
    const refresh = () => {
      put(count, counter(bubble.text, max));
      hint.hidden = !(tracking && textHasLink(bubble.text));
    };
    const area = el("textarea", {
      id: `${idPrefix}-text-${index}`, class: "order-in bs-textarea keep-focus", rows: "4", maxlength: String(max),
      placeholder: "พิมพ์ข้อความ… (ใส่ลิงก์ได้)",
      oninput: (event) => {
        const wasEmpty = !String(bubble.text || "").trim();
        bubble.text = event.target.value;
        refresh();
        changed(wasEmpty !== !String(bubble.text || "").trim());
      },
    });
    area.value = bubble.text || "";
    refresh();
    return el("div", { class: "bs-editor" }, field("ข้อความ", area, count), hint);
  }

  function imageEditor(bubble) {
    const pick = (key) => { bubble.key = key; rerender(); };
    return el("div", { class: "bs-editor" }, imagePicker(bubble.key, pick), el("div", { class: "bs-editor-actions" }, uploadControl(pick)));
  }

  function stickerEditor(bubble) {
    if (!stickers.length) return el("p", { class: "block-hint" }, "ยังไม่มีชุดสติกเกอร์ที่อนุมัติ");
    return el("div", { class: "bs-sticker-grid", role: "listbox", "aria-label": "เลือกสติกเกอร์" },
      stickers.map((sticker) => {
        const selected = bubble.packageId === sticker.packageId && bubble.stickerId === sticker.stickerId;
        const src = stickerImageUrl(sticker);
        return el("button", {
          type: "button", role: "option", class: `bs-sticker-choice${selected ? " is-selected" : ""}`,
          "aria-selected": selected ? "true" : "false", title: sticker.label,
          onclick: () => { bubble.packageId = sticker.packageId; bubble.stickerId = sticker.stickerId; rerender(); },
        },
          src ? el("img", { src, alt: sticker.label, loading: "lazy", referrerpolicy: "no-referrer" }) : el("span", { "aria-hidden": "true" }, sticker.symbol),
          el("span", { class: "bs-sticker-label" }, sticker.label));
      }));
  }

  function buttonEditor(card, button, buttonIndex) {
    const labelMax = Number(limits.cardLabelMax) || 20;
    const kind = el("select", {
      class: "order-in bs-select keep-focus", "aria-label": "ชนิดปุ่ม",
      onchange: (event) => { button.kind = event.target.value; rerender(); },
    }, el("option", { value: "uri" }, "เปิดลิงก์"), el("option", { value: "message" }, "ให้ลูกค้าพิมพ์ตอบ"));
    kind.value = button.kind === "message" ? "message" : "uri";
    const label = el("input", {
      class: "order-in bs-input keep-focus", maxlength: String(labelMax), placeholder: "ชื่อปุ่ม เช่น ดูรายละเอียด",
      "aria-label": `ชื่อปุ่มที่ ${buttonIndex + 1}`,
      oninput: (event) => { button.label = event.target.value; changed(); },
    });
    label.value = button.label || "";
    const valueInput = button.kind === "message"
      ? el("input", {
          class: "order-in bs-input keep-focus", maxlength: String(limits.cardMessageTextMax || 300),
          placeholder: "ข้อความที่ลูกค้าจะส่งกลับมา เช่น สนใจคลาสค่ะ", "aria-label": "ข้อความตอบกลับ",
          oninput: (event) => { button.text = event.target.value; changed(); },
        })
      : el("input", {
          class: "order-in bs-input keep-focus", type: "url", inputmode: "url", maxlength: "1000",
          placeholder: "https://…", "aria-label": "ลิงก์ของปุ่ม",
          oninput: (event) => { button.uri = event.target.value; changed(); },
        });
    valueInput.value = button.kind === "message" ? (button.text || "") : (button.uri || "");
    return el("div", { class: "bs-button-row" },
      kind, label, valueInput,
      el("button", {
        type: "button", class: "icon-del", "aria-label": "ลบปุ่มนี้",
        onclick: () => { card.buttons.splice(buttonIndex, 1); rerender(); },
      }, "✕"));
  }

  function cardEditor(bubble, card, cardIndex) {
    const titleMax = Number(limits.cardTitleMax) || 40;
    const textMax = Number(limits.cardTextMax) || 160;
    const titleCount = el("span");
    const textCount = el("span");
    const title = el("input", {
      class: "order-in bs-input keep-focus", maxlength: String(titleMax), placeholder: "หัวข้อการ์ด",
      oninput: (event) => { card.title = event.target.value; put(titleCount, counter(card.title, titleMax)); changed(); },
    });
    title.value = card.title || "";
    put(titleCount, counter(card.title, titleMax));
    const text = el("textarea", {
      class: "order-in bs-textarea keep-focus", rows: "2", maxlength: String(textMax), placeholder: "รายละเอียดสั้น ๆ",
      oninput: (event) => { card.text = event.target.value; put(textCount, counter(card.text, textMax)); changed(); },
    });
    text.value = card.text || "";
    put(textCount, counter(card.text, textMax));
    const buttonMax = Number(limits.cardButtonMax) || 3;
    return el("fieldset", { class: "bs-card-editor" },
      el("legend", {}, bubble.cards.length > 1 ? `การ์ดใบที่ ${cardIndex + 1}` : "การ์ด"),
      el("div", { class: "bs-card-image" },
        el("span", { class: "bs-field-label" }, "รูปหัวการ์ด (ไม่ใส่ก็ได้)"),
        imagePicker(card.imageKey, (key) => { card.imageKey = card.imageKey === key ? "" : key; rerender(); }, { httpsOnly: true })),
      field("หัวข้อ", title, titleCount),
      field("ข้อความ", text, textCount),
      el("div", { class: "bs-buttons" },
        el("span", { class: "bs-field-label" }, `ปุ่ม (สูงสุด ${buttonMax})`),
        (card.buttons || []).map((button, buttonIndex) => buttonEditor(card, button, buttonIndex)),
        el("button", {
          type: "button", class: "btn btn-outline btn-mini", disabled: (card.buttons || []).length >= buttonMax ? true : null,
          onclick: () => { card.buttons.push({ label: "", kind: "uri", uri: "", text: "" }); rerender(); },
        }, "+ ปุ่ม")),
      bubble.cards.length > 1
        ? el("button", { type: "button", class: "btn btn-ghost btn-mini bs-card-remove", onclick: () => { bubble.cards.splice(cardIndex, 1); rerender(); } }, "ลบการ์ดใบนี้")
        : null,
    );
  }

  function cardsEditor(bubble) {
    const cardMax = Number(limits.cardMax) || 10;
    return el("div", { class: "bs-editor" },
      bubble.cards.map((card, cardIndex) => cardEditor(bubble, card, cardIndex)),
      el("div", { class: "bs-editor-actions" },
        el("button", {
          type: "button", class: "btn btn-outline btn-mini", disabled: bubble.cards.length >= cardMax ? true : null,
          onclick: () => { bubble.cards.push(newCard()); rerender(); },
        }, `+ การ์ดใบถัดไป (เลื่อนดูได้ · สูงสุด ${cardMax})`),
        uploadControl((key) => { const last = bubble.cards.at(-1); if (last) last.imageKey = key; rerender(); })),
    );
  }

  function bubbleItem(bubble, index) {
    const meta = BUBBLE_TYPES.find((entry) => entry.type === bubble.type) || BUBBLE_TYPES[0];
    const move = (delta) => {
      const next = index + delta;
      if (next < 0 || next >= bubbles.length) return;
      [bubbles[index], bubbles[next]] = [bubbles[next], bubbles[index]];
      rerender();
    };
    const editor = bubble.type === "image" ? imageEditor(bubble)
      : bubble.type === "sticker" ? stickerEditor(bubble)
        : bubble.type === "card" ? cardsEditor(bubble)
          : textEditor(bubble, index);
    return el("li", { class: `bs-bubble bs-bubble-${bubble.type}${bubbleIsReady(bubble) ? "" : " is-incomplete"}` },
      el("div", { class: "bs-bubble-head" },
        el("span", { class: "bs-bubble-no", "aria-hidden": "true" }, String(index + 1)),
        el("span", { class: "bs-bubble-glyph", "aria-hidden": "true" }, meta.glyph),
        el("strong", {}, meta.label),
        el("span", { class: "bs-bubble-tools" },
          el("button", { type: "button", class: "icon-btn bs-tool", "aria-label": "เลื่อนขึ้น", disabled: index === 0 ? true : null, onclick: () => move(-1) }, "↑"),
          el("button", { type: "button", class: "icon-btn bs-tool", "aria-label": "เลื่อนลง", disabled: index === bubbles.length - 1 ? true : null, onclick: () => move(1) }, "↓"),
          el("button", {
            type: "button", class: "icon-btn bs-tool bs-tool-del", "aria-label": `ลบบับเบิลที่ ${index + 1}`,
            onclick: () => { bubbles.splice(index, 1); if (!bubbles.length) bubbles.push(newBubble("text")); rerender(); },
          }, "✕"))),
      editor,
    );
  }

  function renderList() {
    put(list, ...bubbles.map(bubbleItem));
    put(addBar, 
      el("span", { class: "bs-add-label" }, `เพิ่มบับเบิล (${bubbles.length}/${maxBubbles})`),
      ...BUBBLE_TYPES.map((entry) => el("button", {
        type: "button", class: "btn btn-outline btn-mini bs-add", disabled: bubbles.length >= maxBubbles ? true : null,
        onclick: () => { bubbles.push(newBubble(entry.type)); rerender(); },
      }, el("span", { class: "bs-add-glyph", "aria-hidden": "true" }, entry.glyph), entry.label)),
    );
  }

  const addBar = el("div", { class: "bs-add-bar" });
  renderList();
  root.append(list, addBar);
  return { node: root, render: renderList };
}

/* ------------------------------- ตัวอย่างหน้าจอ LINE ------------------------------- */

function previewText(text) {
  const nodes = [];
  let cursor = 0;
  URL_RE.lastIndex = 0;
  for (const match of String(text || "").matchAll(URL_RE)) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    nodes.push(el("span", { class: "bs-pv-link" }, match[0]));
    cursor = match.index + match[0].length;
  }
  if (cursor < String(text || "").length) nodes.push(String(text).slice(cursor));
  return el("p", { class: "bs-pv-text" }, nodes);
}

function previewCard(card, imagesByKey) {
  const image = card.imageKey ? imagesByKey.get(card.imageKey) : null;
  return el("article", { class: "bs-pv-card" },
    image ? el("img", { class: "bs-pv-card-hero", src: image.previewSrc, alt: "", loading: "lazy" }) : null,
    el("div", { class: "bs-pv-card-body" },
      card.title ? el("strong", { class: "bs-pv-card-title" }, card.title) : null,
      card.text ? el("span", { class: "bs-pv-card-text" }, card.text) : null),
    (card.buttons || []).length
      ? el("div", { class: "bs-pv-card-buttons" }, card.buttons.map((button, i) =>
          el("span", { class: `bs-pv-card-button${i === 0 ? " is-primary" : ""}` }, button.label || "ปุ่ม")))
      : null,
  );
}

/** หน้าจอแชท LINE จำลอง — แสดงเฉพาะบับเบิลที่มีเนื้อหา · เลียนแบบลำดับที่ลูกค้าเห็นจริง */
export function renderLinePreview({ bubbles = [], meta = {}, oaName = "LINE OA", when = "" } = {}) {
  const imagesByKey = new Map((meta.images || []).map((image) => [image.key, image]));
  const items = bubbles.filter(bubbleIsReady).map((bubble) => {
    if (bubble.type === "text") return el("div", { class: "bs-pv-bubble" }, previewText(bubble.text));
    if (bubble.type === "image") {
      const image = imagesByKey.get(bubble.key);
      return el("div", { class: "bs-pv-media" }, image ? el("img", { class: "bs-pv-image", src: image.previewSrc, alt: image.label || "", loading: "lazy" }) : "รูป");
    }
    if (bubble.type === "sticker") {
      const src = stickerImageUrl(bubble);
      return el("div", { class: "bs-pv-sticker" }, src ? el("img", { src, alt: "สติกเกอร์", loading: "lazy", referrerpolicy: "no-referrer" }) : "☺");
    }
    return el("div", { class: `bs-pv-cards${bubble.cards.length > 1 ? " is-carousel" : ""}` },
      bubble.cards.map((card) => previewCard(card, imagesByKey)));
  });
  return el("div", { class: "bs-phone", role: "img", "aria-label": "ตัวอย่างข้อความบนหน้าจอ LINE ของลูกค้า" },
    el("div", { class: "bs-phone-bar" },
      el("span", { class: "bs-phone-back", "aria-hidden": "true" }, "‹"),
      el("strong", { class: "bs-phone-name" }, oaName),
      el("span", { class: "bs-phone-dots", "aria-hidden": "true" }, "···")),
    el("div", { class: "bs-phone-body" },
      items.length
        ? el("div", { class: "bs-pv-row" },
            el("span", { class: "bs-pv-avatar", "aria-hidden": "true" }),
            el("div", { class: "bs-pv-stack" }, items, when ? el("span", { class: "bs-pv-time" }, when) : null))
        : el("p", { class: "bs-pv-empty" }, "ตัวอย่างจะขึ้นตรงนี้เมื่อเริ่มเขียนข้อความ")),
  );
}
