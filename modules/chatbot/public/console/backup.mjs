import { el, timeAgo } from "./dom.mjs";

function dateTime(value) {
  if (!value) return "ยังไม่มี";
  try {
    return new Intl.DateTimeFormat("th-TH", {
      dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok",
    }).format(new Date(value));
  } catch {
    return "อ่านเวลาไม่ได้";
  }
}

function statusCopy(status) {
  if (status === "ok") return { label: "ปกติ", detail: "ชุดล่าสุดยังไม่เกิน 36 ชั่วโมง", className: "is-ok" };
  if (status === "stale") return { label: "เกินกำหนด", detail: "ชุดล่าสุดเก่ากว่า 36 ชั่วโมง ต้องตรวจงาน backup", className: "is-warn" };
  return { label: "ยังไม่มีหลักฐาน", detail: "ยังไม่พบเวลาสำรองข้อมูลสำเร็จในฐาน", className: "is-missing" };
}

export function createBackupPage({ api, mount, pageHeader, tabBar, stopPolling, setView }) {
  return async function renderBackup() {
    stopPolling();
    const response = await api("/console/api/backup-status");
    const backup = response.backup || {};
    const copy = statusCopy(backup.status);
    const retention = backup.retention || {};
    mount(
      pageHeader("สำรองข้อมูล"),
      el("main", { class: "page-scroll" },
        el("div", { class: "page-inner backup-page" },
          el("section", { class: `backup-hero ${copy.className}` },
            el("div", {},
              el("span", { class: "backup-eyebrow" }, "Encrypted backup"),
              el("h2", {}, copy.label),
              el("p", {}, copy.detail),
            ),
            el("div", { class: "backup-last" },
              el("span", {}, "สำเร็จล่าสุด"),
              el("strong", {}, backup.lastSuccessAt ? timeAgo(backup.lastSuccessAt) : "—"),
              el("small", {}, dateTime(backup.lastSuccessAt)),
            ),
          ),
          el("section", { class: "backup-grid", "aria-label": "นโยบายเก็บชุดสำรอง" },
            [["รายวัน", retention.daily], ["รายสัปดาห์", retention.weekly], ["รายเดือน", retention.monthly], ["รายปี", retention.yearly]]
              .map(([label, count]) => el("article", { class: "backup-policy-card" },
                el("strong", {}, String(count ?? "—")), el("span", {}, label),
              )),
          ),
          el("section", { class: "backup-detail-card" },
            el("h2", {}, "ซ้อมกู้คืน"),
            el("p", {}, backup.lastRestoreDrillAt
              ? `ผ่านล่าสุด ${timeAgo(backup.lastRestoreDrillAt)} · ${dateTime(backup.lastRestoreDrillAt)}`
              : "ยังไม่มี receipt การซ้อมกู้คืนบนเครื่องที่ถือกุญแจส่วนตัว"),
            el("p", { class: "backup-note" }, "ระบบแสดงเฉพาะหลักฐานที่บันทึกสำเร็จ ไม่ถือว่า timer ทำงานเพียงเพราะมีไฟล์ template"),
          ),
          el("section", { class: "backup-detail-card" },
            el("h2", {}, "ขอบเขตความปลอดภัย"),
            el("ul", { class: "backup-list" },
              el("li", {}, "ฐานถูก snapshot ผ่าน SQLite backup API ไม่คัดลอกไฟล์ฐานสด"),
              el("li", {}, "ชุดสำรองเข้ารหัสด้วย age และตรวจ SHA-256/manifest ก่อนรับว่าใช้ได้"),
              el("li", {}, "กู้คืนต้อง replay รายชื่อลืมลูกค้าแบบ hash ก่อนเปิด LINE"),
              el("li", {}, "กุญแจถอดรหัสไม่อยู่บน VPS และไม่มีปุ่มถอดรหัสในคอนโซล"),
            ),
          ),
        ),
      ),
      tabBar(),
    );
    setView("page");
  };
}
