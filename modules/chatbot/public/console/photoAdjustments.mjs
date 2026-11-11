// Local-only colour adjustments: no generative model, geometry changes or network.
export const PHOTO_PRESETS = Object.freeze({
  original: { label: "ต้นฉบับ", brightness: 0, contrast: 0, saturation: 0, warmth: 0 },
  natural: { label: "สว่างธรรมชาติ", brightness: 0.28, contrast: 3, saturation: 5, warmth: -3 },
  bright: { label: "ช่วยภาพมืด", brightness: 0.5, contrast: 2, saturation: 6, warmth: -4 },
});
const bounded = (v, min, max) => Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : 0;
export function photoSettings(value = {}) {
  return { brightness: bounded(value.brightness, -0.5, 1), contrast: bounded(value.contrast, -15, 15), saturation: bounded(value.saturation, -20, 20), warmth: bounded(value.warmth, -15, 15) };
}
export function adjustPhotoPixels(source, settings = {}) {
  const s = photoSettings(settings);
  const output = new Uint8ClampedArray(source);
  if (Object.values(s).every(v => v === 0)) return output;
  const gamma = 1 / (2 ** s.brightness);
  const contrast = 1 + s.contrast / 100;
  const saturation = 1 + s.saturation / 100;
  const tone = v => Math.min(1, Math.max(0, ((v / 255) ** gamma - 0.5) * contrast + 0.5));
  const tones = Float64Array.from({ length: 256 }, (_, v) => tone(v));
  for (let i = 0; i < source.length; i += 4) {
    const r = tones[source[i]] * (1 + s.warmth / 200);
    const g = tones[source[i + 1]];
    const b = tones[source[i + 2]] * (1 - s.warmth / 200);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    output[i] = 255 * (luma + (r - luma) * saturation);
    output[i + 1] = 255 * (luma + (g - luma) * saturation);
    output[i + 2] = 255 * (luma + (b - luma) * saturation);
  }
  return output;
}
export function assessPhoto(source) {
  let sum = 0, count = 0, dark = 0, bright = 0;
  for (let i = 0; i < source.length; i += 4) {
    if (source[i + 3] < 128) continue;
    const y = (0.2126 * source[i] + 0.7152 * source[i + 1] + 0.0722 * source[i + 2]) / 255;
    sum += y; count += 1;
    if (y < 0.12) dark += 1;
    if (y > 0.97) bright += 1;
  }
  const mean = count ? sum / count : 0;
  return { mean, darkFraction: count ? dark / count : 0, brightFraction: count ? bright / count : 0,
    suggested: count && mean < 0.32 ? "bright" : count && mean < 0.5 ? "natural" : "original" };
}
export function photoSize(width, height, maxEdge = 1600) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1 || width * height > 32_000_000) throw new Error("รูปใหญ่เกินไป — ใช้ภาพไม่เกิน 32 ล้านพิกเซลค่ะ");
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
