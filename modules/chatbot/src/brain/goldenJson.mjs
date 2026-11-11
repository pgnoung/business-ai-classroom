// brain/goldenJson.mjs — อ่าน JSON จากคอลัมน์ที่อาจเสีย โดยไม่ล้มทั้งด่าน
//
// ไฟล์ใบไม้ (ไม่ import อะไรเลย) เพราะทั้ง gate5 และ gate5select ต้องใช้ตัวเดียวกัน
// คอลัมน์ JSON ที่อ่านไม่ออกต้องกลายเป็น "ค่าว่าง" ไม่ใช่ทำให้การเผยแพร่ทั้งครั้งล้ม
export function parseGoldenJson(text, fallback) {
  try {
    const value = JSON.parse(String(text ?? ""));
    return value === null || value === undefined ? fallback : value;
  } catch { return fallback; }
}
