// lineUsage.mjs — อ่านข้อมูลจาก DB แล้วประกอบรายงาน "LINE OA เดือนนี้" + ข้อความสำหรับแชทเจ้าของ (28 ก.ย. 2026)
//
// ทางอ่านเดียวของทั้งการ์ดในคอนโซล (consoleLineUsageApi.mjs) และคำถามทาง Telegram (ownerChatLookups.mjs)
// ต่างกันแค่ที่มาของโควตา: คอนโซลยิงถาม LINE สด (แคช 5 นาทีใน lineClient) · แชทเจ้าของใช้ภาพล่าสุดที่ตัวดึงสถิติเก็บไว้
// อ่านอย่างเดียว ไม่มีชื่อ/ id ลูกค้าในผลเลย
import { QUOTA_SNAPSHOT_PREFIX } from "./lineInsight.mjs";
import {
  buildLineUsageReport, monthWindow, preLedgerWindow, readPlan, thaiDayLabel,
} from "./lineUsageReport.mjs";

const safe = (fn, fallback) => { try { return fn(); } catch { return fallback; } };

/** ภาพโควตาล่าสุดต่อ OA ที่ตัวดึงสถิติเก็บไว้ (ไม่ยิง LINE) — channelIds ว่าง = ทุก OA */
export function quotaSnapshots(db, channelIds = []) {
  const wanted = new Set((channelIds || []).map(String));
  return safe(() => db.lineQuotaSnapshots(), []).map((row) => {
    const channelId = String(row.key).slice(QUOTA_SNAPSHOT_PREFIX.length);
    const quota = safe(() => JSON.parse(row.value), null);
    return { channelId, name: channelId, quota: quota && typeof quota === "object" ? quota : null };
  }).filter((entry) => entry.quota && (!wanted.size || wanted.has(entry.channelId)));
}

/**
 * @param {object} input
 * @param {string[]} input.channelIds  OA ของ LINE ที่อยู่ในมุมมอง (ว่าง = ทุก OA ของ LINE)
 * @param {boolean} input.auditBackfill เติมแจ้งเตือนทีมช่วงก่อนเริ่มบันทึกจาก audit — ใช้ได้เฉพาะมุมมองรวมทุก OA
 *   (audit ไม่ได้จดว่าแจ้งเตือนออกทาง OA ไหน)
 */
export function loadLineUsageReport({
  db, nowMs, monthKey, channelIds = [], quotas = [], quotaSource = "live", includeCost = false, auditBackfill = true,
}) {
  const win = monthWindow(monthKey);
  const ledgerStartMs = db.lineSendLedgerStart({ channelIds });
  const pre = auditBackfill ? preLedgerWindow({ monthKey, nowMs, ledgerStartMs }) : null;
  return buildLineUsageReport({
    nowMs, monthKey, ledgerStartMs, quotas, quotaSource, includeCost,
    ledgerRows: db.lineSendRows({ fromDay: win.fromDay, toDay: win.toDay, channelIds }),
    insightRows: db.lineInsightRows({ fromDate: win.fromDate, toDate: win.toDate, channelIds }),
    auditRows: pre ? db.teamPushAuditRows({ sinceMs: pre.startMs, untilMs: pre.endMs }) : [],
    auditBackfill,
    plan: includeCost ? readPlan((key) => db.getSetting(key)) : null,
  });
}

/* ---------------------------- ข้อความสำหรับแชทเจ้าของ ---------------------------- */

const n = (value) => Math.round(Number(value) || 0).toLocaleString("en-US");
const baht = (value) => `฿${Number(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
const clock = (ms) => {
  const date = new Date(Number(ms) + 7 * 3_600_000);
  return `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")} น.`;
};

/** บรรทัดสรุปให้ลูกแพรตอบพี่ง้วง (ภาษาไทย ตัวเลขจากรายงานตรง ๆ) */
export function lineUsageLookupLines(report, { byDay = false, dayLinesMax = 31 } = {}) {
  const lines = [`【LINE OA】${report.monthLabel}${report.current ? ` · ข้อมูล ณ ${thaiDayLabel(new Date(report.asOf + 7 * 3_600_000).toISOString().slice(0, 10))} ${clock(report.asOf)}` : ""}`];
  const q = report.quota;
  if (q) {
    lines.push(q.limit !== null
      ? `โควตา: ใช้ไป ${n(q.used)} จาก ${n(q.limit)} ข้อความ (เหลือ ${n(q.left)})${q.at ? ` — ตัวเลข LINE ณ ${clock(q.at)}` : ""}`
      : `โควตา: ใช้ไป ${n(q.used)} ข้อความ (ไม่ได้ตั้งเพดาน)${q.at ? ` — ตัวเลข LINE ณ ${clock(q.at)}` : ""}`);
  } else if (report.current) {
    lines.push("โควตา: ยังไม่มีตัวเลขล่าสุดจาก LINE (ระบบดึงให้ทุกชั่วโมง) — ดูสดได้ในคอนโซล");
  }
  const parts = report.split.parts.map((part) => `${part.label} ${n(part.value)}`).join(" · ");
  lines.push(`ข้อความที่นับโควตาไปไหน${report.split.total !== null ? ` (รวม ${n(report.split.total)})` : ""}: ${parts}`);

  const rows = report.system.rows;
  const customerRows = rows.filter((r) => r.group === "customers" && r.counted > 0)
    .map((r) => `${r.label} ${n(r.counted)}${r.details.length ? ` (${r.details.map((d) => `${d.label} ${n(d.value)}`).join(" · ")})` : ""}`);
  if (customerRows.length) lines.push(`ส่งหาลูกค้าที่นับโควตา: ${customerRows.join(" · ")}`);
  const teamRows = rows.filter((r) => r.group === "team" && r.counted > 0).map((r) => `${r.label} ${n(r.counted)}`);
  const pre = report.system.preLedger;
  if (pre && (pre.alertPushes || pre.digestPushes)) teamRows.push(`ก่อนเริ่มบันทึก (จากบันทึกแจ้งเตือน) ${n(pre.alertPushes + pre.digestPushes)}`);
  if (teamRows.length) lines.push(`ส่งเข้าทีมงาน: ${teamRows.join(" · ")} — คาดทั้งเดือน ~${n(report.split.teamProjected)} ข้อความ`);

  const free = [
    ...rows.filter((r) => r.free > 0).map((r) => `${r.label} ${n(r.free)}`),
    ...report.lineStats.fields.filter((f) => f.counts === false && f.source === "oa" && f.value > 0).map((f) => `${f.label} ${n(f.value)}`),
  ];
  if (free.length) lines.push(`ไม่นับโควตา (ฟรี): ${free.join(" · ")}`);
  const oa = report.lineStats.fields.filter((f) => f.source === "oa" && f.counts === true && f.value > 0);
  if (oa.length) lines.push(`บรอดแคสต์จาก LINE OA Manager (สถิติ LINE): ${oa.map((f) => `${f.label} ${n(f.value)}`).join(" · ")}`);
  if (report.system.batching) {
    lines.push(`ข้อสังเกต: push ที่ส่งทีละบอลลูน ${n(report.system.batching.requests)} คำขอ จาก ${n(report.system.batching.sends)} ครั้งส่ง — LINE นับทีละคำขอ ถ้ารวมบอลลูนเป็นคำขอเดียวจะลดได้ ${n(report.system.batching.saving)} ข้อความ`);
  }

  const cost = report.cost;
  if (cost?.configured) {
    const now = cost.now;
    lines.push(now
      ? `ค่าใช้จ่ายโดยประมาณ (ตามราคาที่พี่ง้วงกรอกในคอนโซล): แพ็กเกจ ${baht(cost.plan.monthlyFeeThb)} + ส่วนเกิน ${n(now.extraMessages)} ข้อความ${now.extraThb === null ? " (ยังไม่ได้กรอกราคาส่วนเกิน)" : ` ${baht(now.extraThb)}`}${now.totalThb === null ? "" : ` = ${baht(now.totalThb)}`}`
      : "ค่าใช้จ่ายโดยประมาณ: ยังไม่มียอดโควตาให้คำนวณ");
    if (cost.projected) lines.push(`คาดทั้งเดือน ~${n(cost.projected.used)} ข้อความ${cost.projected.totalThb === null ? "" : ` ≈ ${baht(cost.projected.totalThb)}`}`);
  } else if (cost) {
    lines.push("ค่าใช้จ่ายเป็นเงิน: ยังไม่ได้กรอกราคาแพ็กเกจในคอนโซล — ตอบเป็นจำนวนข้อความเท่านั้น ห้ามเดาราคา");
  }
  for (const note of report.notes) lines.push(`หมายเหตุ: ${note.text}`);

  if (byDay) {
    const shown = report.days.slice(0, dayLinesMax);
    lines.push(`รายวัน (ใหม่→เก่า${shown.length < report.days.length ? `, ${dayLinesMax} วันล่าสุด` : ""}):`);
    for (const day of shown) {
      const ours = day.tracked
        ? `ทีม ${n(day.team)} · ลูกค้า ${n(day.customers)} (ฟรี ${n(day.customersFree)})${day.broadcastSystem ? ` · บรอดแคสต์คอนโซล ${n(day.broadcastSystem)}` : ""}`
        : `ทีม ${n(day.team)} (ก่อนเริ่มบันทึก)`;
      const line = day.lineOaCounted === null ? "" : ` · สถิติ LINE: OA Manager ${n(day.lineOaCounted)} / API ${n(day.lineApiCounted)}`;
      lines.push(`· ${day.label}${day.startsAt ? ` (นับตั้งแต่ ${clock(day.startsAt)})` : ""}: ${ours}${line}`);
    }
  }
  return lines;
}

/** รันคิวรี lineUsage ของแชทเจ้าของ (synchronous — ใช้ภาพโควตาที่เก็บไว้ ไม่ยิง LINE) */
export function runLineUsageLookup({ db, nowMs, monthKey, byDay = false }) {
  const report = loadLineUsageReport({
    db, nowMs, monthKey, quotas: quotaSnapshots(db), quotaSource: "snapshot", includeCost: true,
  });
  return lineUsageLookupLines(report, { byDay });
}
