// lukpraeArt.mjs — ภาพตัวละครลูกแพร (เฉพาะธีม lukprae) ที่หลายหน้าใช้ร่วมกัน
//
// ภาพทุกไฟล์ตัดจาก master ที่พี่ง้วงอนุมัติแล้วเท่านั้น (LKP-CHAR-002 character sheet) —
// ไม่มีภาพตัวละครที่เจนใหม่ในธีมนี้ ที่มา sha256 และตำแหน่งตัดอยู่ใน scripts/build-lukprae-ui-art.py
// instance อื่น (Airdog/Pngoung) ไม่ได้ใช้ภาพพวกนี้เลย: isLukpraeTheme() เป็นด่านเดียว
import { el, isGeneric } from "./dom.mjs";

const BASE = "/console/static/brand/lukprae";

// สีหน้า 5 แบบจากแผ่น character sheet — ความหมายที่ใช้ในคอนโซล
export const MOODS = Object.freeze({
  smile: "ยิ้มสบายใจ",
  wink: "ขยิบตายกนิ้วให้",
  thinking: "กำลังคิด",
  surprised: "ตกใจ",
  pout: "ทำปากยื่น",
});

export function isLukpraeTheme() {
  // white-label: ร้านทั่วไปไม่มีภาพตัวละครลูกแพรเลย แม้จะตั้งธีม lukprae ไว้ (ด่านเดียวของทุกภาพ)
  return !isGeneric() && globalThis.document?.documentElement?.classList?.contains("theme-lukprae") === true;
}

export function moodSrc(mood) {
  return `${BASE}/mood/${Object.hasOwn(MOODS, mood) ? mood : "smile"}.webp`;
}

// เหรียญภาพหน้าลูกแพร — alt เป็นคำอธิบายอารมณ์ ให้คนใช้โปรแกรมอ่านหน้าจอรู้ว่าเธอ "รู้สึก" ยังไง
// (ข้อมูลจริงอยู่ในประโยคข้าง ๆ เสมอ ภาพไม่ได้แบกข้อมูลเอง)
export function moodPortrait(mood = "smile", { size = "md", decorative = false } = {}) {
  const key = Object.hasOwn(MOODS, mood) ? mood : "smile";
  return el("span", { class: `lk-muse lk-muse-${size}`, "data-mood": key },
    el("img", {
      class: "lk-muse-img", src: moodSrc(key), width: "208", height: "208",
      alt: decorative ? "" : `ลูกแพร${MOODS[key]}`,
      ...(decorative ? { "aria-hidden": "true" } : {}),
      decoding: "async",
    }),
  );
}

export const LUKPRAE_FRONT_SRC = `${BASE}/lukprae-front.webp`;
export const NONGKAO_SRC = `${BASE}/intro/nongkao.webp`;
export const NONGKAO_FACE_SRC = `${BASE}/intro/nongkao-face.webp`;
export const INTRO_VIDEO_SRC = `${BASE}/intro/lukprae-universe-intro.mp4`;
export const INTRO_POSTER_SRC = `${BASE}/intro/lukprae-universe-intro-poster.webp`;
