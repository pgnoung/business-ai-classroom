import { el } from "./dom.mjs";
import { PHOTO_PRESETS, adjustPhotoPixels, assessPhoto, photoSettings, photoSize } from "./photoAdjustments.mjs";

function readDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("อ่านรูปไม่สำเร็จค่ะ"));
    reader.readAsDataURL(file);
  });
}
async function decodePhoto(file) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 12_000_000) throw new Error("ใช้ JPEG, PNG หรือ WebP ไม่เกิน 12 MB ค่ะ — รูป HEIC ให้ส่งออกเป็น JPEG ก่อน");
  const image = new Image();
  image.src = await readDataUrl(file); // data: is already allowed by Console CSP; no blob: expansion.
  try { await image.decode(); } catch { throw new Error("เปิดรูปนี้ไม่ได้ค่ะ กรุณาเลือกไฟล์ JPEG, PNG หรือ WebP ที่เปิดดูได้ตามปกติ"); }
  return image;
}
export async function exportPhotoCanvas(canvas, name) {
  for (const quality of [0.9, 0.8, 0.68, 0.52]) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", quality));
    if (blob && blob.size <= 950_000) return new File([blob], `${String(name || "photo").replace(/\.[^.]*$/u, "")}-chat.jpg`, { type: "image/jpeg" });
  }
  throw new Error("รูปยังใหญ่เกินส่ง — กรุณาเลือกรูปที่เล็กลงค่ะ");
}

// Returns a reviewed local File, the exact original File, or null. Never uploads/sends.
export async function openPhotoEditor(file, { applyLabel = "ใช้รูปนี้แนบแชท", isCurrent = () => true } = {}) {
  const image = await decodePhoto(file);
  if (!isCurrent()) return null;
  const size = photoSize(image.naturalWidth, image.naturalHeight);
  const before = el("canvas", { width: size.width, height: size.height, "aria-label": "ภาพต้นฉบับ" });
  const after = el("canvas", { width: size.width, height: size.height, "aria-label": "ภาพหลังปรับ" });
  const sourceCtx = before.getContext("2d", { willReadFrequently: true });
  const targetCtx = after.getContext("2d");
  if (!sourceCtx || !targetCtx) throw new Error("อุปกรณ์นี้เปิดตัวปรับรูปไม่ได้ค่ะ");
  sourceCtx.fillStyle = "#ffffff";
  sourceCtx.fillRect(0, 0, size.width, size.height);
  sourceCtx.drawImage(image, 0, 0, size.width, size.height);
  const source = sourceCtx.getImageData(0, 0, size.width, size.height);
  const assessment = assessPhoto(source.data);
  let current = photoSettings();
  let finished = false, busy = false, frame = 0;
  const previousFocus = document.activeElement;
  return new Promise(resolve => {
    const finish = result => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", cancelled);
      dialog.close(); dialog.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(result);
    };
    const cancelled = () => finish(null);
    const status = el("p", { class: "photo-editor-status", role: "status" });
    const permission = el("input", { type: "checkbox", onchange: () => {
      controls.disabled = !permission.checked;
      useButton.disabled = !permission.checked;
      if (!permission.checked) selectPreset("original");
    } });
    const inputs = {};
    function draw() {
      frame = 0;
      if (finished) return;
      const pixels = targetCtx.createImageData(size.width, size.height);
      pixels.data.set(adjustPhotoPixels(source.data, current));
      targetCtx.putImageData(pixels, 0, 0);
      status.textContent = Object.values(current).some(v => v !== 0)
        ? "ปรับเฉพาะแสงและสี ไม่สร้างหน้า/วัตถุใหม่ • ยังไม่ได้อัปโหลดหรือส่ง"
        : "กำลังแสดงต้นฉบับ • ยังไม่ได้อัปโหลดหรือส่ง";
    }
    function selectPreset(key) {
      current = photoSettings(PHOTO_PRESETS[key]);
      for (const [name, input] of Object.entries(inputs)) { input.value = String(current[name]); input.nextSibling.textContent = input.value; }
      draw();
    }
    const controls = el("fieldset", { class: "photo-editor-controls", disabled: true },
      el("legend", {}, "ปรับโทนภาพ"),
      el("div", { class: "photo-editor-presets" }, Object.entries(PHOTO_PRESETS).map(([key, preset]) =>
        el("button", { type: "button", class: "btn btn-outline", onclick: () => selectPreset(key) }, preset.label)),
        el("button", { type: "button", class: "btn btn-outline", onclick: () => selectPreset(assessment.suggested) }, "แนะนำตามแสง")),
      ...[["brightness", "ความสว่าง", -0.5, 1, 0.05], ["contrast", "ความต่างแสง", -15, 15, 1], ["saturation", "ความสดของสี", -20, 20, 1], ["warmth", "อุ่น / เย็น", -15, 15, 1]].map(([key, label, min, max, step]) => {
        const value = el("output", {}, "0");
        const input = el("input", { type: "range", min, max, step, value: 0, "aria-label": label, oninput: () => {
          current = photoSettings({ ...current, [key]: input.value }); value.textContent = input.value;
          cancelAnimationFrame(frame); frame = requestAnimationFrame(draw);
        } });
        inputs[key] = input;
        return el("label", { class: "photo-editor-slider" }, el("span", {}, label), input, value);
      }),
    );
    const originalButton = el("button", { type: "button", class: "btn btn-outline", onclick: () => finish(isCurrent() ? file : null) }, "ใช้ต้นฉบับ");
    const cancelButton = el("button", { type: "button", class: "btn btn-outline", onclick: cancelled }, "ยกเลิก");
    const useButton = el("button", { type: "button", class: "btn btn-primary", disabled: true, onclick: async () => {
      if (busy || !permission.checked || !isCurrent()) { if (!isCurrent()) finish(null); return; }
      busy = true; useButton.disabled = true; originalButton.disabled = true;
      controls.disabled = true; permission.disabled = true;
      try {
        draw();
        const output = Object.values(current).every(v => v === 0) ? file : await exportPhotoCanvas(after, file.name);
        if (!finished) finish(isCurrent() ? output : null);
      } catch (error) {
        if (!finished) { status.textContent = error.message; busy = false; useButton.disabled = false; originalButton.disabled = false; controls.disabled = false; permission.disabled = false; }
      }
    } }, applyLabel);
    const dialog = el("dialog", { class: "photo-editor", "aria-labelledby": "photo-editor-title", oncancel: event => { event.preventDefault(); cancelled(); } },
      el("h2", { id: "photo-editor-title" }, "เตรียมรูปให้พร้อมคุยกับลูกค้า"),
      el("p", {}, "ต้นฉบับไม่ถูกแก้ทับ • เลือกโทนแล้วตรวจภาพก่อนใช้ ไม่ปรับหรือส่งให้อัตโนมัติ"),
      el("div", { class: "photo-editor-compare" },
        el("figure", {}, before, el("figcaption", {}, "ก่อนปรับ")),
        el("figure", {}, after, el("figcaption", {}, "หลังปรับ"))),
      el("label", { class: "photo-editor-check" }, permission, "เป็นภาพถ่ายทั่วไปที่มีสิทธิ์ใช้ ไม่ใช่สลิป เอกสาร หรือภาพตัวเลขราคา"),
      el("p", { class: "block-hint" }, "สลิป เอกสาร และโปสเตอร์ราคาให้ใช้ต้นฉบับ ส่วนภาพผู้เรียนให้ตรวจสิทธิ์และข้อมูลบนหน้าจอก่อนส่ง"),
      controls, status,
      el("div", { class: "photo-editor-actions" }, cancelButton, originalButton, useButton),
    );
    document.body.append(dialog);
    window.addEventListener("hashchange", cancelled);
    draw();
    try { dialog.showModal(); permission.focus(); }
    catch { finish(null); }
  });
}

export function photoStudioCard({ toast }) {
  let busy = false;
  const input = el("input", { type: "file", accept: "image/jpeg,image/png,image/webp", hidden: true, onchange: async event => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file || busy) return;
    const page = location.hash;
    busy = true; button.disabled = true;
    try {
      const output = await openPhotoEditor(file, { applyLabel: "บันทึกสำเนาลงเครื่อง", isCurrent: () => location.hash === page });
      if (!output) return;
      const link = el("a", { href: await readDataUrl(output), download: output.name });
      document.body.append(link); link.click(); link.remove();
      toast("เตรียมสำเนาแล้ว — ยังไม่ได้เพิ่มเข้าคลัง AI หรือส่งลูกค้า นำไฟล์ไปแนบในห้องที่ต้องการค่ะ");
    } catch (error) { toast(error.message); }
    finally { busy = false; button.disabled = false; }
  } });
  const button = el("button", { type: "button", class: "btn btn-primary", onclick: () => input.click() }, "เลือกรูปเพื่อปรับแสงและสี");
  return el("section", { class: "block photo-studio" },
    el("h2", {}, "เตรียมรูปสำหรับแชท"),
    el("p", {}, "เพิ่มรูปจากเครื่อง → เทียบก่อน–หลัง → บันทึกสำเนา แล้วแนบในแชทได้เอง ต้นฉบับยังอยู่ ไม่เรียก AI และไม่มีค่าโมเดลเพิ่ม"),
    input, button,
    el("p", { class: "block-hint" }, "รูปที่จะให้ลูกแพรเลือกส่งอัตโนมัติยังต้องผ่านคลังรูปที่อนุมัติ การบันทึกสำเนานี้ไม่ได้เผยแพร่เข้าคลัง AI"));
}
