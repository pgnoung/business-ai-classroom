// consoleTagFrameworkApi.mjs — GET /console/api/customers/tag-framework (28 ก.ย. 2026)
//
// แผงป้ายในห้องแชทโหลดครั้งเดียวต่อหน้า แล้วจัดกลุ่มป้ายตามมิติ + ทำตัวเลือกจากรายการปิด
// อยู่ใต้ราก "customers" เพราะทีมงานทุกบทบาทที่เปิดห้องแชทได้ต้องใช้ (ไม่ใช่เมนูตั้งค่า)
// สวิตช์ปิด/ไม่มีไฟล์กรอบ = framework: null → แผงกลับเป็นรายการป้ายแบบเดิม
import { frameworkView } from "./tagFramework.mjs";
import { activeTagFramework, tagFrameworkMode } from "./tagFrameworkMode.mjs";

export function createTagFrameworkRoutes({ db, tagFramework = null } = {}) {
  // ไฟล์กรอบโหลดครั้งเดียวตอนบูต — มุมมองสำหรับคอนโซลก็คำนวณครั้งเดียว
  const view = tagFramework ? frameworkView(tagFramework) : null;
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "customers" || route[1] !== "tag-framework" || route.length !== 2) return false;
    if (req.method !== "GET") {
      ctx.json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    const active = activeTagFramework(db, tagFramework);
    ctx.json(res, 200, {
      ok: true,
      available: Boolean(tagFramework),
      mode: tagFramework ? tagFrameworkMode(db) : "off",
      framework: active ? view : null,
    });
    return true;
  }
  return { handle };
}
