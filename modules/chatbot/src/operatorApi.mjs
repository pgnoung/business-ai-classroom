// operatorApi.mjs — inbox แบบ read-only สำหรับ G1a
// mutation มีแค่ 2 อย่างตาม SPEC: toggle ai_enabled + บันทึก correction candidate
// (console UI จริงเป็นงาน G1b — ห้ามสร้างในเฟสนี้)
import { MANUAL_AI_OFF_REASON } from "./aiPausePolicy.mjs";
import { releaseAutoCustomerTagOnReopen } from "./legacyLink.mjs";
import { stampHandoffHintReset } from "./pipeline.mjs";
import { isHumanEdit } from "./correctionCapture.mjs";
import { markHumanAiOn, markNotQualifiedOverride } from "./aiSwitch.mjs";

export function createOperatorApi({ db, lineRegistry = null }) {
  const profileRefreshes = new Set();
  // คืน true = จัดการ request แล้ว / false = ไม่ใช่ route ของโมดูลนี้
  async function handle(req, res, url, { readJson, json }) {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]
    if (parts[0] !== "api") return false;

    // GET /api/conversations — รายการแชท + ai_enabled + handoff summary
    if (req.method === "GET" && parts[1] === "conversations" && parts.length === 2) {
      json(res, 200, { ok: true, conversations: db.listConversations() });
      return true;
    }

    // GET /api/conversations/:id/messages
    if (req.method === "GET" && parts[1] === "conversations" && parts[3] === "messages") {
      const customerId = decodeURIComponent(parts[2]);
      const limit = Math.min(200, Number(url.searchParams.get("limit")) || 50);
      json(res, 200, { ok: true, customerId, messages: db.messagesFor(customerId, limit) });
      return true;
    }

    // GET /api/customers/:id — โปรไฟล์ + สถานะ gate
    if (req.method === "GET" && parts[1] === "customers" && parts.length === 3) {
      const customer = db.getCustomer(decodeURIComponent(parts[2]));
      if (!customer) {
        json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
        return true;
      }
      json(res, 200, { ok: true, customer });
      return true;
    }

    // Owner-authorized backfill after Meta profile access approval. The server
    // fetches the profile itself; callers cannot supply a name or change AI state.
    // This API is protected by DASHBOARD_API_KEY in server.mjs.
    if (req.method === "POST" && parts[1] === "customers" && parts[3] === "refresh-profile" && parts.length === 4) {
      const customerId = decodeURIComponent(parts[2]);
      const customer = db.getCustomer(customerId);
      if (!customer) { json(res, 404, { ok: false, reason: "customer_missing" }); return true; }
      if (customer.channel_id !== "facebook" || !/^facebook:\d+$/.test(customerId)
          || !lineRegistry?.channels.some((ch) => ch.id === "facebook" && ch.provider === "facebook")) {
        json(res, 400, { ok: false, reason: "not_facebook" }); return true;
      }
      if (customer.display_name) { json(res, 200, { ok: true, updated: false }); return true; }
      if (profileRefreshes.has(customerId)) { json(res, 409, { ok: false, reason: "refresh_in_progress" }); return true; }
      profileRefreshes.add(customerId);
      try {
        const profile = await lineRegistry.forChannel("facebook").getProfile({ userId: customerId.slice("facebook:".length) });
        if (!profile?.displayName) { json(res, 502, { ok: false, reason: "profile_unavailable" }); return true; }
        // An operator may have edited/forgotten the room while Meta was loading.
        const current = db.getCustomer(customerId);
        if (!current) { json(res, 404, { ok: false, reason: "customer_missing" }); return true; }
        if (current.display_name) { json(res, 200, { ok: true, updated: false }); return true; }
        db.setProfile(customerId, profile);
        db.addAudit({ operator: "dashboard-key", action: "facebook_profile_refresh", target: customerId, detail: "Profile loaded from Meta; conversation controls unchanged" });
        json(res, 200, { ok: true, updated: true });
      } catch {
        json(res, 502, { ok: false, reason: "profile_unavailable" });
      } finally {
        profileRefreshes.delete(customerId);
      }
      return true;
    }

    // POST /api/customers/:id/ai { enabled: true|false }
    if (req.method === "POST" && parts[1] === "customers" && parts[3] === "ai") {
      const customerId = decodeURIComponent(parts[2]);
      const body = await readJson(req);
      if (typeof body.enabled !== "boolean") {
        json(res, 400, { ok: false, error: "ต้องส่ง enabled เป็น boolean" });
        return true;
      }
      if (!db.getCustomer(customerId)) {
        json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
        return true;
      }
      // ปิดด้วยมือ (คีย์แดชบอร์ด) = sticky เหมือนคอนโซล — ดู aiPausePolicy.mjs
      // F7 (ตรวจย้อนหลัง ก.ย. 2026): เปิดคืนด้วยมือ = ถอนป้าย customer ที่ระบบติดจากชื่อซ้ำ (เหมือนคอนโซล)
      const previousOffReason = String(db.getCustomer(customerId)?.ai_off_reason || "");
      if (body.enabled) releaseAutoCustomerTagOnReopen({ db, customerId, operator: "dashboard-key" });
      const customer = db.setAiEnabled(customerId, body.enabled, body.enabled ? "" : MANUAL_AI_OFF_REASON);
      // 5 ต.ค. 2026: เปิดทับห้องสีเหลือง = ตัวกวาดคัดกรองห้ามปิดห้องนี้อีก (เส้นเดียวกับคอนโซล — aiSwitch.mjs)
      const override = body.enabled ? markNotQualifiedOverride({ db, customerId, previousOffReason, operator: "dashboard-key" }) : "";
      // รีวิวปรปักษ์ 5 ต.ค. #5: คนเปิด AI ทุกเหตุ = ประทับเวลา (ตัวกวาดไม่ปิดเหลืองห้องที่คนเพิ่งคืนให้ AI) — เส้นเดียวกับคอนโซล
      // รีวิวปรปักษ์ 5 ต.ค. #21: เส้นนี้ไม่มี pipeline จึง "ไม่" ตอบข้อความที่ค้างของห้องเหลืองให้ (คอนโซลตอบให้ผ่าน aiSwitch)
      //   ข้อความค้างยังอยู่ในคิวรอตอบให้คนเห็นเมื่อห้องเปิดแล้ว · ห้ามเดาคำตอบแทนคนจากสคริปต์
      if (body.enabled) markHumanAiOn({ db, customerId });
      // F9 (ตรวจย้อนหลัง ก.ย. 2026): เปิดคืนด้วยมือ = ห้องเริ่มรอบใหม่เหมือนคอนโซล — ใบ้เก่ามองไม่เห็น และบันไดทวง
      // SLA ของเหตุที่เกิดก่อนหน้านี้หยุด (needsHumanSla อ่านหมุดเดียวกันนี้)
      if (body.enabled) stampHandoffHintReset(db, customerId);
      // M6: mutation ผ่าน dashboard key ต้องมีร่องรอยเหมือน console (operator = "dashboard-key")
      db.addAudit({
        operator: "dashboard-key", action: "ai_toggle", target: customerId,
        detail: `${body.enabled ? "on" : "off"}${override}`,
      });
      json(res, 200, { ok: true, customer });
      return true;
    }

    // POST /api/corrections — เก็บคำแก้ของคนเข้า candidate queue (Correction Loop v1)
    if (req.method === "POST" && parts[1] === "corrections" && parts.length === 2) {
      const body = await readJson(req);
      const customerId = String(body.customerId || "").trim();
      if (!customerId) {
        json(res, 400, { ok: false, error: "ต้องส่ง customerId" });
        return true;
      }
      const aiDraft = String(body.aiDraft || "");
      const humanFinal = String(body.humanFinal || "");
      // เก็บร่างว่างได้ เพราะเป็นงานที่คนต้องมาแก้ภายหลัง แต่เมื่อทั้งสองฝั่งมี
      // ข้อความแล้วและลูกค้าเห็นว่าเหมือนกัน จะไม่สร้าง candidate ปลอมขึ้นมาใหม่
      if (aiDraft.trim() && humanFinal.trim() && !isHumanEdit(aiDraft, humanFinal)) {
        db.addAudit({ operator: "dashboard-key", action: "correction_ignored_no_edit", target: customerId, detail: "normalized_equal" });
        json(res, 200, { ok: true, id: null, ignored: "no_material_edit" });
        return true;
      }
      const id = db.addCorrection({
        customerId,
        aiDraft,
        humanFinal,
      });
      // M6: audit ไม่เก็บเนื้อหา draft — อ้างอิงด้วย correction id พอ (เนื้อหาอยู่ในตาราง corrections)
      db.addAudit({ operator: "dashboard-key", action: "correction_add", target: customerId, detail: `id=${id}` });
      json(res, 200, { ok: true, id });
      return true;
    }

    // GET /api/corrections?status=candidate
    if (req.method === "GET" && parts[1] === "corrections" && parts.length === 2) {
      const status = url.searchParams.get("status") || "candidate";
      const includeNoopHistory = url.searchParams.get("includeNoopHistory") === "true";
      const page = status === "candidate" && !includeNoopHistory
        ? db.listCorrectionWorkQueue()
        : { corrections: db.listCorrections(status), hiddenNoopCount: 0 };
      json(res, 200, { ok: true, ...page });
      return true;
    }

    // GET /api/canary — สถานะโครง probe (ยิงจริง G1b)
    if (req.method === "GET" && parts[1] === "canary" && parts.length === 2) {
      json(res, 200, { ok: true, canary: db.getCanary("line-webhook") });
      return true;
    }

    json(res, 404, { ok: false, error: "ไม่พบ endpoint นี้" });
    return true;
  }

  return { handle };
}
