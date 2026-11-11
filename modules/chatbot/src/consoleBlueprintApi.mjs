// consoleBlueprintApi.mjs — /console/api/blueprint… คุมแคมเปญ #AIAGENT (11 ต.ค. 2026)
//
// เฉพาะ Super Admin (role owner) ทั้งอ่านและเขียน: รายการคำขอมีสิ่งที่ลูกค้าพิมพ์เรื่องธุรกิจของตัวเอง
// ทุกการเปลี่ยน = CSRF + แถว audit · ไม่มีเส้นไหนในไฟล์นี้ส่งข้อความถึงลูกค้า (การส่งเป็นงานของ blueprintSender)
//
//   GET  blueprint                          ภาพรวม: โหมด เพดาน ยอดวันนี้ แคมเปญ + จำนวนตามสถานะ
//   GET  blueprint/requests?campaignId=…    รายการคำขอ (ไม่มีตัวแบบวางระบบเต็ม)
//   GET  blueprint/requests/<customerId>?campaignId=…  คำขอเดียว + ข้อความที่จะส่ง (ตัวอย่าง)
//   POST blueprint/mode        { mode: off|pregenerate|on }
//   POST blueprint/cap         { thb }
//   POST blueprint/campaign    { campaignId, keyword, title, sendAt, followupOffDays, enabled, … }
//   POST blueprint/regenerate  { campaignId, customerId }   สร้างใหม่ (ยังไม่ส่ง/ล้มเหลว เท่านั้น)
//   POST blueprint/release-holds { campaignId }             คืน FU ที่พักไว้ทั้งแคมเปญทันที (ทางถอย)
import {
  BLUEPRINT_MODES, DAILY_CAP_KEY, MAX_DAILY_CAP_THB, SEND_MODE_KEY,
  readCampaign, readCampaigns, readDailyCapThb, readSendMode, saveCampaign,
} from "./blueprintCampaignConfig.mjs";
import { countByStatus, listEntries, readEntry, readSpendThb, updateEntry } from "./blueprintStore.mjs";
import { releaseFollowupHold } from "./blueprintCampaign.mjs";
import { bangkokDay } from "./lineSendLedger.mjs";

const DENY = "เฉพาะ Super Admin เท่านั้นที่ดูและตั้งค่าแคมเปญ AI Agent ได้";
const REGENERATABLE = new Set(["pending", "ready", "failed", "expired", "skipped", "undeliverable"]);

function safeDecode(value) {
  try { return decodeURIComponent(String(value || "")); } catch { return ""; }
}

function listRow(db, entry) {
  const customer = db.getCustomer(entry.customerId);
  return {
    customerId: entry.customerId,
    displayName: String(customer?.display_name || ""),
    business: entry.business || "",
    answer: entry.answer || "",
    status: entry.status,
    submissions: entry.submissions || 0,
    receivedAt: entry.receivedAt || null,
    sentAt: entry.sentAt || null,
    lastError: entry.lastError || "",
    followupHold: entry.hold ? { applied: Boolean(entry.hold.applied), until: entry.hold.until, releasedAt: entry.hold.releasedAt || null } : null,
  };
}

export function createConsoleBlueprintRoutes({ db, sender = null, now = Date.now } = {}) {
  function overview() {
    const t = now();
    const entries = listEntries(db);
    return {
      ok: true,
      mode: readSendMode(db),
      modes: [...BLUEPRINT_MODES],
      capThb: readDailyCapThb(db),
      thbToday: Math.round(readSpendThb(db, bangkokDay(t)) * 100) / 100,
      campaigns: readCampaigns(db).map((campaign) => ({
        ...campaign,
        active: campaign.enabled && t < campaign.expiresAtMs,
        counts: countByStatus(entries.filter((e) => e.campaignId === campaign.campaignId)),
      })),
    };
  }

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "blueprint") return false;
    const { json, readJson, username, operator, requireCsrf } = ctx;
    if (String(operator?.role || "") !== "owner") {
      json(res, 403, { ok: false, error: DENY });
      return true;
    }
    if (req.method === "GET") {
      if (route.length === 1) {
        json(res, 200, overview());
        return true;
      }
      if (route[1] === "requests" && route.length <= 3) {
        const campaignId = String(url.searchParams.get("campaignId") || "");
        if (route.length === 2) {
          const rows = listEntries(db, campaignId).map((entry) => listRow(db, entry))
            .sort((a, b) => Number(b.receivedAt) - Number(a.receivedAt));
          json(res, 200, { ok: true, campaignId, requests: rows });
          return true;
        }
        const customerId = safeDecode(route[2]);
        const entry = campaignId ? readEntry(db, campaignId, customerId) : null;
        if (!entry) {
          json(res, 404, { ok: false, error: "ไม่พบคำขอนี้" });
          return true;
        }
        const campaign = readCampaign(db, campaignId);
        let preview = null;
        if (entry.draft?.blueprint && campaign && sender?.renderMessages) {
          try { preview = sender.renderMessages(entry.draft.blueprint, campaign, db.getCustomer(customerId)); } catch { preview = null; }
        }
        json(res, 200, { ok: true, request: { ...listRow(db, entry), rawText: entry.rawText || "", draft: entry.draft || null }, preview });
        return true;
      }
      json(res, 404, { ok: false, error: "ไม่พบเส้นทางนี้" });
      return true;
    }
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }
    const body = (await readJson(req)) || {};
    const action = route[1] || "";
    if (action === "mode" && route.length === 2) {
      const mode = String(body.mode || "").trim().toLowerCase();
      if (!BLUEPRINT_MODES.includes(mode)) {
        json(res, 400, { ok: false, error: `mode ต้องเป็น ${BLUEPRINT_MODES.join(" / ")}` });
        return true;
      }
      db.setSetting(SEND_MODE_KEY, mode);
      db.addAudit({ operator: username, action: "blueprint_mode", target: "", detail: mode });
      json(res, 200, overview());
      return true;
    }
    if (action === "cap" && route.length === 2) {
      const thb = Number(body.thb);
      if (!Number.isFinite(thb) || thb < 0 || thb > MAX_DAILY_CAP_THB) {
        json(res, 400, { ok: false, error: `เพดานต้องเป็นตัวเลข 0-${MAX_DAILY_CAP_THB} บาท` });
        return true;
      }
      db.setSetting(DAILY_CAP_KEY, String(thb));
      db.addAudit({ operator: username, action: "blueprint_cap", target: "", detail: `฿${thb}/วัน` });
      json(res, 200, overview());
      return true;
    }
    if (action === "campaign" && route.length === 2) {
      const saved = saveCampaign(db, body);
      if (!saved.ok) {
        json(res, 400, { ok: false, error: saved.errors.join(" · ") });
        return true;
      }
      db.addAudit({
        operator: username, action: "blueprint_campaign", target: saved.value.campaignId,
        detail: `${saved.value.keyword} · ${saved.value.enabled ? "เปิด" : "ปิด"} · ส่ง ${saved.value.sendAt}`,
      });
      json(res, 200, overview());
      return true;
    }
    if (action === "regenerate" && route.length === 2) {
      const campaignId = String(body.campaignId || "");
      const customerId = String(body.customerId || "");
      const write = updateEntry(db, campaignId, customerId, (current) => (current && REGENERATABLE.has(current.status)
        ? { ...current, status: "pending", attempts: 0, lastError: "", draft: undefined, rev: (Number(current.rev) || 0) + 1 } : null));
      if (!write.changed) {
        json(res, 409, { ok: false, error: "สร้างใหม่ได้เฉพาะคำขอที่ยังไม่ได้ส่ง/กำลังส่ง" });
        return true;
      }
      db.addAudit({ operator: username, action: "blueprint_regenerate", target: customerId, detail: campaignId });
      json(res, 200, { ok: true, request: listRow(db, write.entry) });
      return true;
    }
    if (action === "release-holds" && route.length === 2) {
      const campaignId = String(body.campaignId || "");
      const t = now();
      let restored = 0;
      for (const entry of listEntries(db, campaignId)) {
        if (!entry.hold || entry.hold.releasedAt) continue;
        const result = releaseFollowupHold(db, entry.customerId, entry.hold, { at: t });
        const write = updateEntry(db, entry.campaignId, entry.customerId, (current) => (current?.hold && !current.hold.releasedAt
          ? { ...current, hold: { ...current.hold, releasedAt: t, result, releasedBy: username } } : null));
        if (write.changed && result === "restored") restored += 1;
      }
      db.addAudit({ operator: username, action: "blueprint_release_holds", target: campaignId, detail: `คืน FU ${restored} ห้อง` });
      json(res, 200, { ok: true, restored });
      return true;
    }
    json(res, 404, { ok: false, error: "ไม่พบเส้นทางนี้" });
    return true;
  }

  return { handle };
}
