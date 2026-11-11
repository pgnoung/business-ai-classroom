// adReferralView.mjs — ข้อมูลแถบ "มาจากโฆษณา" ในหน้าแชท + ป้ายบนแถวรายการ (พี่ง้วง 6 ต.ค. 2026 ค่ำ:
// "ads id ให้อยู่ในหน้าแชทของลูกค้าได้ไหม เหมือน facebook ... มองง่ายเห็นง่าย ว่ามาจาก ads ไหน")
//
// อ่านอย่างเดียวจาก customer_ad_referrals (dbAdReferrals.mjs) · อ่านพัง = ไม่มีแถบ ห้ามลากห้องแชททั้งห้องล้ม
// ชื่อแอด/โพสต์โชว์ทุกคนที่เปิดห้องได้ (เหมือนกล่องข้อความของ Meta) · ลิงก์ตัวจัดการโฆษณาให้เฉพาะ finance.view
// (เจ้าของ) เพราะเป็นทางเข้าตัวเลขค่าแอด — เส้นรายงานรายแอดก็กันด้วยสิทธิ์เดียวกัน
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { photoUrlValue } from "./adReferral.mjs";

const ACCOUNT_DIGITS = /^(?:act_)?(\d{1,32})$/u;
const AD_ID = /^\d{1,32}$/u;
const POST_ID = /^\d{1,32}(?:_\d{1,32})?$/u;

/** ลิงก์เปิดแอดตัวนี้ในตัวจัดการโฆษณา — ไม่รู้บัญชี/เลขแอดผิดรูป = null */
export function adsManagerUrl(accountId, adId) {
  const account = ACCOUNT_DIGITS.exec(String(accountId || ""))?.[1];
  if (!account || !AD_ID.test(String(adId || ""))) return null;
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?act=${account}&selected_ad_ids=${adId}`;
}

/** ลิงก์โพสต์ของแอด (โพสต์สาธารณะของเพจ) — post_id ผิดรูป = null */
export function adPostUrl(postId) {
  const id = String(postId || "");
  return POST_ID.test(id) ? `https://www.facebook.com/${id}` : null;
}

/** ข้อมูลแถบในหน้าแชท — null = ห้องนี้ไม่ได้มาจากแอด หรืออ่านไม่ได้ */
/** ที่อยู่รูปที่เก็บไว้ในฐานข้อมูล (เสิร์ฟผ่านคอนโซลที่ล็อกอินแล้ว) — ?v= เปลี่ยนเมื่อรูปเปลี่ยน แคชได้ยาว */
export const adThumbPath = (adId, sha256) => `/console/api/ad-thumbs/${adId}?v=${String(sha256 || "").slice(0, 16)}`;

export function adReferralCardView(db, customerId, { operator, logger = console, onMissingThumb = () => {} } = {}) {
  try {
    const card = db.adReferralCardFor?.(customerId);
    if (!card) return null;
    const canOpenAdsManager = hasOperatorCapability(operator, "finance.view");
    const accountId = canOpenAdsManager ? db.latestAdsAccountId?.() || "" : "";
    const stamps = db.adThumbStamps?.(card.ads.map((ad) => ad.adId)) || new Map();
    let missing = false;
    const ads = card.ads.map((ad) => {
      // สำเนาในฐานข้อมูลก่อน (ไม่หมดอายุ) · ยังไม่มี = ลิงก์ CDN ไปพลาง แล้วปลุกตัวเก็บรูป
      // ตรวจโดเมนรูปซ้ำตอนอ่าน — วันหน้ามีทางเขียนอื่นนอกจาก webhook ก็ไม่หลุดรูปจากโดเมนแปลกไปถึงเบราว์เซอร์ทีม
      const stamp = stamps.get(ad.adId);
      const cdnUrl = photoUrlValue(ad.photoUrl);
      if (!stamp && cdnUrl && ad.adId) missing = true;
      const photoUrl = stamp ? adThumbPath(ad.adId, stamp.sha256) : cdnUrl;
      return {
          ...ad,
          photoUrl,
          mediaType: photoUrl ? ad.mediaType : "",
          postUrl: adPostUrl(ad.postId),
          adsManagerUrl: canOpenAdsManager ? adsManagerUrl(accountId, ad.adId) : null,
      };
    });
    if (missing) {
      try { onMissingThumb(); } catch { /* ตัวเก็บรูปพังห้ามลากห้องแชทล้ม */ }
    }
    return { ...card, ads };
  } catch (err) {
    logger?.warn?.(`ad referral card: อ่านที่มาจากแอดไม่สำเร็จ (${err?.message || err})`);
    return null;
  }
}

/** ป้ายบนแถวรายการ — แผนที่ว่างเมื่ออ่านพัง (รายการแชทต้องเปิดได้เสมอ) */
export function adReferralChips(db, customerIds, { logger = console } = {}) {
  try {
    return db.latestAdReferralsFor?.(customerIds) || new Map();
  } catch (err) {
    logger?.warn?.(`ad referral chips: อ่านที่มาจากแอดไม่สำเร็จ (${err?.message || err})`);
    return new Map();
  }
}
