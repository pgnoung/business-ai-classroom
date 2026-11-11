// businessSuiteLink.mjs — ลิงก์เปิดห้อง Facebook นี้ใน Meta Business Suite (28 ก.ย. 2026)
//
// พี่ง้วง: "ถ้าเคสไหนเกิน 24 ชม.แล้วตอบไม่ได้แล้ว ให้คุณลิ้งค์ business suite ห้องนั้นไว้หน่อยได้ไหม"
// คอนโซลตอบ Facebook ได้ภายใน 24 ชม. หลังข้อความล่าสุดของลูกค้า (messaging_type RESPONSE) — เกินนั้นคนต้องตอบใน
// Business Suite (ได้ถึง 7 วัน) ลิงก์นี้พาไปห้องเดียวกันทันทีแทนการค้นชื่อเอง
//
// ลิงก์ห้องตรงด้วย PSID ใช้ไม่ได้ (ทดสอบกับห้องจริง 28 ก.ย.) — เปิดกล่องข้อความของเพจ + คัดลอกชื่อให้ค้นแทน
// รหัสเพจไม่ได้เก็บในตั้งค่า — ถาม Graph API "/me" ด้วยโทเคนเพจที่ระบบมีอยู่แล้ว (อ่านอย่างเดียว) หรือเรียนรู้จาก webhook
// ไม่รู้รหัสเพจ/PSID ผิดรูป = ไม่มีลิงก์ (ห้ามเดา)

const DIGITS = /^\d{5,25}$/u;
const RETRY_AFTER_FAIL_MS = 10 * 60_000;

/**
 * ลิงก์กล่องข้อความ Messenger ของเพจใน Business Suite — "" เมื่อไม่รู้รหัสเพจ
 * 28 ก.ย. 2026 23:3x: พี่ง้วงลองลิงก์เปิดห้องตรงด้วย PSID (selected_item_id) ทั้งแบบ /messenger และ /all กับ 4-5 ห้อง
 * ขึ้น "Messenger User · เกิดข้อผิดพลาดขึ้น" ทุกห้อง = Business Suite ไม่ได้ใช้ PSID เป็นรหัสห้อง → เปิดกล่องข้อความของเพจ
 * แล้วให้ทีมค้นชื่อ (คอนโซลคัดลอกชื่อ Facebook ให้พร้อมกันตอนกด)
 */
export function businessSuiteInboxUrl(pageId) {
  const page = String(pageId ?? "");
  if (!DIGITS.test(page)) return "";
  return `https://business.facebook.com/latest/inbox/messenger?asset_id=${page}&mailbox_id=${page}`;
}

/**
 * รหัสเพจ Facebook ที่ระบบคุยอยู่ — จำเฉพาะค่าที่ได้จริง · Graph ล้ม = พักก่อนถามใหม่ (ไม่ยิงทุก poll)
 * @param {{ getClient: () => ({ getPageInfo?: () => Promise<{id: string}|null> }|null), logger?: object, now?: () => number }} deps
 */
export function createFacebookPageIdResolver({ getClient, logger = console, now = Date.now } = {}) {
  let pageId = "";
  let inflight = null;
  let lastTryAt = -Infinity;

  function current() {
    return pageId;
  }

  function learn(id) {
    const value = String(id ?? "");
    if (!pageId && DIGITS.test(value)) pageId = value;
  }

  function resolve() {
    if (pageId) return Promise.resolve(pageId);
    if (inflight) return inflight;
    const at = now();
    if (at - lastTryAt < RETRY_AFTER_FAIL_MS) return Promise.resolve("");
    lastTryAt = at;
    inflight = (async () => {
      try {
        const info = await getClient?.()?.getPageInfo?.();
        learn(info?.id);
      } catch (err) {
        logger.debug?.(`businessSuiteLink: ถามรหัสเพจไม่สำเร็จ (${err?.message || err})`);
      } finally {
        inflight = null;
      }
      return pageId;
    })();
    return inflight;
  }

  return { current, learn, resolve };
}
