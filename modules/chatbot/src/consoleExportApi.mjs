// consoleExportApi.mjs — route GET /console/api/export (CSV download)
// แยกจาก consoleApi.mjs เพื่อคุมขนาดไฟล์ <800 บรรทัด — session ถูกตรวจก่อนถึงตรงนี้แล้ว
// (GET download ผ่าน <a> ธรรมดา — session cookie คุมสิทธิ์อยู่แล้ว ไม่ต้องมี CSRF อ่านอย่างเดียว)
import { bangkokMonthRangeMs, exportFilename, streamCsvExport } from "./exportCsv.mjs";

export function handleExportRoute(res, url, { json, username, db, now = Date.now, parseChannelParam, channelLabel }) {
  const scope = url.searchParams.get("scope") || "all";
  if (scope !== "all" && scope !== "customer") {
    return json(res, 400, { ok: false, error: "scope ต้องเป็น all หรือ customer" });
  }
  let customerId = null;
  if (scope === "customer") {
    customerId = String(url.searchParams.get("customerId") || "");
    if (!customerId) {
      return json(res, 400, { ok: false, error: "ต้องส่ง customerId เมื่อ scope=customer" });
    }
    if (!db.getCustomer(customerId)) return json(res, 404, { ok: false, error: "ไม่พบลูกค้า" });
  }
  // W3: channel filter — ไม่ส่ง = ทุกสาขา (เดิม)
  const chParam = parseChannelParam(url);
  if (!chParam.ok) return json(res, 400, { ok: false, error: "channel ไม่อยู่ในรายการสาขา" });
  // month ไม่ส่ง = ทั้งหมด / ส่งมาต้องเป็น YYYY-MM (ขอบเขตเดือนตามเที่ยงคืนกรุงเทพ)
  const month = url.searchParams.get("month") || "";
  let sinceMs = 0;
  let untilMs = null;
  if (month) {
    const range = bangkokMonthRangeMs(month);
    if (!range) return json(res, 400, { ok: false, error: "month ต้องเป็นรูปแบบ YYYY-MM" });
    sinceMs = range.sinceMs;
    untilMs = range.untilMs;
  }
  res.writeHead(200, {
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": `attachment; filename="${exportFilename(scope, month, now(), chParam.channel)}"`,
    "x-content-type-options": "nosniff",
    "cache-control": "no-store",
  });
  const rows = streamCsvExport(res, {
    db, customerId, channel: chParam.channel, sinceMs, untilMs, channelLabel,
  });
  res.end();
  db.addAudit({
    operator: username, action: "export", target: customerId || "",
    detail: `scope=${scope} month=${month || "all"}${chParam.channel ? ` channel=${chParam.channel}` : ""} rows=${rows}`,
  });
}
