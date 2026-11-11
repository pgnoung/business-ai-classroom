// processIdentity.mjs — "แถวนี้เป็นของโปรเซสที่ยังหายใจอยู่หรือของศพ"
//
// ตัวกวาดเทิร์นค้างตอนบูตเดิมแยกแค่ process_id ว่า "ไม่ใช่ของเรา" แล้วปักธงทันที
// ซึ่งผิดเมื่อมีสองโปรเซสทับกันจริง ๆ (คนรัน node src/server.mjs เช็คเองระหว่างของจริง
// ยังทำงาน — ตัวที่สองบูตไม่ขึ้นเพราะพอร์ตชนก็จริง แต่ตัวกวาดยิงไปแล้วก่อนเจอ EADDRINUSE)
// ผลคือเทิร์นที่โปรเซสเก่า "กำลังตอบอยู่จริง" ถูกปิดบัญชีทิ้งพร้อมปลุกแอดมิน -> ตอบซ้ำ
//
// จึงฝัง hostname + pid จริงไว้ใน process_id เพื่อให้ถามได้ตรง ๆ ว่าเจ้าของยังอยู่ไหม
// รูปแบบ: "<hostname>#<pid>#<สุ่ม 8 ตัว>" — ท่อนสุ่มกันชนกรณี pid ถูกใช้ซ้ำหลังรีบูต
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";

const SEP = "#";

export function createProcessId() {
  return `${hostname()}${SEP}${process.pid}${SEP}${randomUUID().slice(0, 8)}`;
}

function defaultIsAlive(pid) {
  try {
    process.kill(pid, 0);   // signal 0 = ถามเฉย ๆ ไม่ส่งสัญญาณจริง
    return true;
  } catch (err) {
    // EPERM = โปรเซสมีอยู่แต่เราไม่มีสิทธิ์ส่งสัญญาณ -> ยังมีชีวิต
    return err?.code === "EPERM";
  }
}

// fail-open โดยเจตนา: ตัดสินไม่ได้เมื่อไหร่ให้ถือว่า "ตายแล้ว" เสมอ
// เพราะโทษของการเข้าใจผิดสองทางไม่เท่ากัน — เดาว่าตายแล้วปักธงเกินจริง แอดมินเห็นห้อง
// ที่ไม่ต้องทำอะไร ส่วนเดาว่ายังอยู่แล้วข้าม = ลูกค้าเงียบถาวรโดยไม่มีใครรู้ ซึ่งคือบั๊กต้นเรื่อง
export function ownerStillRunning(processId, {
  selfPid = process.pid, host = hostname(), isAlive = defaultIsAlive,
} = {}) {
  const parts = String(processId || "").split(SEP);
  if (parts.length !== 3) return false;              // รูปแบบเก่า/แถวที่ seed เอง
  const [rowHost, rowPid] = parts;
  if (!rowHost || rowHost !== host) return false;    // คนละเครื่อง = ถามไม่ได้
  const pid = Number(rowPid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === selfPid) return false;                 // ตัวเราเอง (process_id เก่าที่ pid ซ้ำ)
  return isAlive(pid);
}
