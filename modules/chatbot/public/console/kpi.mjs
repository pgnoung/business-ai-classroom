// kpi.mjs — หน้า "ผลงาน" (#/kpi): วัดการตอบแชท คน vs ลูกแพร (คำสั่งพี่ง้วง 1 ก.ย. 2026)
//
// หน้านี้ตั้งใจออกแบบให้ "อ่านผิดยาก" มากกว่าให้ตัวเลขดูดี:
// - โชว์จำนวนตัวอย่างคู่กับทุก % เสมอ ตัวอย่างน้อยจะได้ไม่ถูกเอาไปตัดสินใจ
// - % ปิดการขายมีเฉพาะ Hybrid กับ AI ล้วน ห้องที่คนดูแลล้วนโชว์เป็นจำนวนห้องเท่านั้น
//   เพราะเคสยากถูกส่งต่อให้คนเสมอ เอา % มาเทียบกันตรง ๆ จะสรุปผิดและไม่แฟร์กับทีม
import { el } from "./dom.mjs";
import { kpiVisualSummary } from "./kpiVisual.mjs";

const HOUR = 3_600_000;

function humanDuration(ms) {
  if (ms == null) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)} วินาที`;
  if (ms < HOUR) return `${Math.round(ms / 60_000)} นาที`;
  const hours = ms / HOUR;
  return hours < 24 ? `${hours.toFixed(1)} ชม.` : `${(hours / 24).toFixed(1)} วัน`;
}

function statCard(label, value, sub, tone = "") {
  return el("div", { class: `kpi-card ${tone}` },
    el("div", { class: "kpi-label" }, label),
    el("div", { class: "kpi-value" }, value),
    sub ? el("div", { class: "kpi-sub" }, sub) : null,
  );
}

function speedTable(title, note, group) {
  const row = (who, entry) => el("tr", {},
    el("th", { scope: "row" }, who),
    el("td", {}, humanDuration(entry.medianMs)),
    el("td", {}, humanDuration(entry.p90Ms)),
    el("td", {}, entry.count ? `${entry.count} ครั้ง` : "ไม่มีข้อมูล"),
  );
  return el("div", { class: "kpi-block" },
    el("h3", {}, title),
    note ? el("p", { class: "block-hint" }, note) : null,
    el("div", { class: "kpi-scroll" },
      el("table", { class: "kpi-table" },
        el("thead", {}, el("tr", {},
          el("th", {}, "ใครตอบ"), el("th", {}, "ปกติ (ค่ากลาง)"), el("th", {}, "ช้าสุด 10% แรก"), el("th", {}, "จำนวนที่วัด"))),
        el("tbody", {}, row("ลูกแพร (AI)", group.ai), row("ทีมงาน (คน)", group.human)),
      ),
    ),
  );
}

// 3 พ.ย. 2026 (พี่ง้วง: "AI ลูกแพร คือผู้ช่วย แต่ชมพู่ แอดมินจริง คือคนหลัก ... ชมพู่ใน 3-6 ชม ควรไปตอบต่อจาก AI")
// ไม้ = ลูกแพรคุยจบ ลูกค้าเงียบ 2 ชม.ทำการ · นับเวลาทำการ จ.–ส. 09:00–18:00 จากข้อความสุดท้ายของลูกแพร (src/relayBaton.mjs)
const pctText = (value) => (value == null ? "—" : `${value}%`);
export function relaySection(relay) {
  const r = relay.relay;
  const reply = relay.reply;
  const alone = relay.aiAlone;
  const tone = (value) => (value == null ? "" : value >= 80 ? "" : value >= 50 ? "kpi-warn" : "kpi-bad");
  return el("section", { class: "block kpi-relay" },
    el("h2", {}, "④ ไม้ต่อจากลูกแพร — ชมพู่เข้าไปคุยต่อหลัง AI จบไหม"),
    el("p", { class: "block-hint" },
      "ลูกแพรคุยจบแล้ว ลูกค้าเงียบครบ 2 ชม. = ส่งไม้ให้ทีม · เป้าต่อภายใน 3 ชม. เส้นตาย 6 ชม. "
      + "นับเวลาทำการ จ.–ส. 09:00–18:00 จากข้อความสุดท้ายของลูกแพร (ไม่นับวันในรายการวันหยุด)"),
    el("div", { class: "kpi-cards" },
      statCard("ต่อทันเส้นตาย 6 ชม.", pctText(r.within6Pct), `${r.within3 + r.within6} จาก ${r.decided} ไม้`, tone(r.within6Pct)),
      statCard("ต่อทันเป้า 3 ชม.", pctText(r.within3Pct), `${r.within3} จาก ${r.decided} ไม้`, tone(r.within3Pct)),
      statCard("ปกติต่อภายใน", humanDuration(r.medianLagWorkMs), "ค่ากลาง นับเวลาทำการ"),
      statCard("ลูกแพรคุยคนเดียวตลอด", String(alone.rooms),
        `จาก ${alone.roomsWithAi} ห้องที่ลูกแพรตอบ — ไม่เคยมีคนจริงพิมพ์เลย`, alone.rooms > 0 ? "kpi-warn" : ""),
    ),
    el("div", { class: "kpi-scroll" },
      el("table", { class: "kpi-table" },
        el("thead", {}, el("tr", {}, el("th", {}, "ผลของไม้"), el("th", {}, "จำนวน"))),
        el("tbody", {}, ...[
          ["ต่อภายใน 3 ชม.", r.within3],
          ["ต่อภายใน 3–6 ชม.", r.within6],
          ["ต่อแต่เกิน 6 ชม.", r.late],
          ["เลยเส้นตายแล้วยังไม่มีคนต่อ", r.missed],
          ["Facebook เลย 7 วัน ตอบไม่ได้แล้ว", r.lost],
          ["ลูกค้ากลับมาพูดเองก่อนเส้นตาย (ไม่นับเป็นพลาด)", r.cameBack],
          ["ยังไม่ถึงเส้นตาย", r.pending],
        ].map(([label, value]) => el("tr", {}, el("th", { scope: "row" }, label), el("td", {}, String(value))))),
      ),
    ),
    el("p", { class: "block-hint" },
      `อัตราตอบ: ลูกค้าพูด ${reply.turns} ครั้ง ได้คำตอบ ${pctText(reply.answeredPct)} `
      + `(ลูกแพรตอบก่อน ${reply.byAi} · คนตอบก่อน ${reply.byHuman} · ยังไม่มีใครตอบ ${reply.unanswered})`),
    el("p", { class: "block-hint kpi-caveat" },
      "% คิดจากไม้ที่ตัดสินแล้วเท่านั้น — ลูกค้ากลับมาเองก่อนเส้นตาย และไม้ที่ยังไม่ถึงเส้นตาย ไม่อยู่ในตัวหาร · "
      + "ทีมพิมพ์ในคอนโซล / Business Suite / YOLO นับว่าต่อแล้ว · กดเสร็จสิ้นไม่นับ"),
    r.decided > 0 && r.decided < 20
      ? el("p", { class: "block-hint kpi-thin-note" }, "ไม้ยังน้อยเกินกว่าจะสรุปแนวโน้มได้ — ดูประกอบกับรายชื่อในการ์ดหน้าภาพรวม")
      : null,
  );
}

// 3 พ.ย. 2026 (พี่ง้วง: "พี่ง้วงเห็นคนเดียว" · "ใช้ luna"): คะแนนคำตอบของทีมจาก Luna (src/teamReplyReview.mjs)
// วาดเฉพาะบัญชีที่มี team_review.view (owner) — ด่านจริงอยู่ฝั่งเซิร์ฟเวอร์ (403)
export function teamReviewSection(data) {
  const scoreText = (value) => (value == null ? "—" : `${value} / 5`);
  return el("section", { class: "block kpi-team-review" },
    el("h2", {}, "⑤ คุณภาพคำตอบของทีม (พี่ง้วงเห็นคนเดียว)"),
    el("p", { class: "block-hint" },
      `Luna อ่านทุกห้องที่ทีมพิมพ์คุยกับลูกค้า วันละครั้งหลัง 20:00 · ${data.days} วันล่าสุด ตรวจแล้ว ${data.reviewed} ห้อง`
      + (data.notReviewed ? ` (ยังไม่ได้อ่าน/อ่านไม่สำเร็จ ${data.notReviewed})` : "")),
    el("div", { class: "kpi-cards" },
      statCard("คะแนนเฉลี่ยทั้งทีม", scoreText(data.avgScore), "5 = ต่อจากลูกแพรเนียน ตรงคำถาม มีขั้นต่อไป",
        data.avgScore != null && data.avgScore < 3.5 ? "kpi-warn" : ""),
      ...data.operators.slice(0, 3).map((op) => statCard(op.operator, scoreText(op.avgScore), `${op.rooms} ห้อง · จุดที่ควรปรับ ${op.issues}`)),
    ),
    data.topIssues.length
      ? el("p", { class: "block-hint" }, `เจอบ่อย: ${data.topIssues.slice(0, 5).map((issue) => `${issue.label} ${issue.count}`).join(" · ")}`)
      : null,
    data.rooms.length
      ? el("details", { class: "kpi-details", open: true },
          el("summary", {}, `รายห้อง คะแนนต่ำก่อน (${data.rooms.length} ห้อง)`),
          el("ul", { class: "kpi-list" }, ...data.rooms.slice(0, 40).map((room) => el("li", {},
            el("a", { href: `#/c/${encodeURIComponent(room.id)}` }, room.name),
            ` · ${room.dayKey} · ${room.operators || "ทีม"} · `,
            el("strong", {}, `${room.score}/5`),
            room.summary ? ` — ${room.summary}` : "",
            room.issues.length ? el("div", { class: "block-hint" }, room.issues.map((issue) => `${issue.label}: ${issue.note || "—"}`).join(" · ")) : null,
            room.good ? el("div", { class: "block-hint" }, `👍 ${room.good}`) : null,
          ))),
        )
      : el("p", { class: "block-hint" }, "ยังไม่มีผลตรวจ — รอบแรกจะขึ้นหลัง 20:00"),
  );
}

export function createKpiPage({ api, mount, pageHeader, tabBar, stopPolling, setView, state }) {
  let days = 30;
  // 2 ก.ย. 2026: ตัวเลขผลงานอ่านได้ทุกบทบาท แต่ "วันหยุดที่กรอกเอง" คือเกณฑ์ที่ใช้ตัดวัน
  // ออกจากการวัด — คนถูกวัดต้องแก้เกณฑ์ที่ใช้วัดตัวเองไม่ได้ ด่านจริงอยู่ฝั่งเซิร์ฟเวอร์
  // (consoleSettingsApi PUT /kpi/holidays) ตรงนี้แค่ไม่วาดช่องที่กดบันทึกแล้วเด้ง 403
  const canEditHolidays = () => state?.me?.capabilities?.includes("kpi.manage") === true;
  const canSeeTeamReview = () => state?.me?.capabilities?.includes("team_review.view") === true;

  function holidayBox(holidays) {
    const input = el("textarea", {
      class: "kpi-holidays keep-focus", rows: "3",
      placeholder: "2026-12-05\n2026-12-10\n2026-12-31",
    });
    input.value = (holidays || []).join("\n");
    const status = el("span", { class: "rv-status" });
    const save = el("button", {
      class: "btn btn-ghost",
      onclick: async () => {
        status.textContent = "กำลังบันทึก…";
        status.className = "rv-status";
        try {
          const result = await api("/console/api/kpi/holidays", {
            method: "PUT", body: { holidays: input.value },
          });
          status.textContent = `บันทึกแล้ว ${result.holidays.length} วัน`;
          status.className = "rv-status rv-ok";
          renderKpi();
        } catch (err) {
          status.textContent = String(err?.message || err);
          status.className = "rv-status rv-bad";
        }
      },
    }, "บันทึกวันหยุด");
    return el("details", { class: "kpi-details" },
      el("summary", {}, "วันหยุดนักขัตฤกษ์ + วันที่ชมพู่ไม่มา"),
      el("p", { class: "block-hint" },
        "ใส่วันหยุดนักขัตฤกษ์และวันที่ชมพู่ลา/ไม่มา (ปปปป-ดด-วว บรรทัดละวัน) — วันในรายการนี้ไม่นับเข้า KPI "
        + "นาฬิกาไม้ต่อจากลูกแพรหยุดเดิน และไม่ส่งแจ้งเตือนทีมวันนั้น · ความเร็วตอบยังจับวันหยุดได้เองจากกฎ “เช้าไม่มีใครตอบ” อีกชั้น"),
      input,
      el("div", { class: "rv-actions" }, save, status),
    );
  }

  async function renderKpi() {
    stopPolling();
    const [data, teamReview] = await Promise.all([
      api(`/console/api/kpi?days=${days}`),
      // พังได้โดยไม่ลากหน้าผลงานล้ม (null = ไม่วาดส่วนนี้)
      canSeeTeamReview() ? api(`/console/api/team-review?days=${Math.min(days, 60)}`).catch(() => null) : Promise.resolve(null),
    ]);
    const { speed, backlog, closing, totals, days: dayInfo, holidays, window: win, relay } = data;

    const rangeChips = el("div", { class: "kpi-chips", role: "group", "aria-label": "ช่วงวันที่วัด" },
      ...[7, 14, 30, 90].map((option) => el("button", {
        class: `chip ${option === days ? "chip-on" : ""}`,
        "aria-pressed": option === days ? "true" : "false",
        onclick: () => { days = option; renderKpi(); },
      }, `${option} วัน`)),
    );

    const pct = (entry) => (entry.ratePct == null ? "—" : `${entry.ratePct}%`);
    const sample = (entry) => `${entry.closed} จาก ${entry.rooms} ห้อง`;
    const thin = (entry) => (entry.rooms > 0 && entry.rooms < 20 ? "kpi-thin" : "");

    mount(
      pageHeader("ผลงานการตอบแชท"),
      el("main", { class: "page-scroll" }, el("div", { class: "page-inner kpi-page" },
        rangeChips,
        el("p", { class: "kb-lede" },
          `นับเฉพาะบทสนทนาตั้งแต่ลูกแพรเริ่มทำงานจริง (${new Date(win.attributionStartMs).toLocaleDateString("th-TH")}) — `
          + `ก่อนหน้านั้นระบบยังไม่ได้บันทึกว่าใครเป็นคนตอบ จึงแยกคน/AI ไม่ได้`),
        // 28 ก.ย. 2026: ภาพสรุปสามเรื่องก่อน — ตารางละเอียดเดิมอยู่ครบข้างล่างสำหรับคนที่ต้องการตัวเลขเต็ม
        kpiVisualSummary(data),
        el("h2", { class: "kpi-detail-head" }, "ตัวเลขละเอียด"),

        el("section", { class: "block" },
          el("h2", {}, "① ความเร็วในการตอบ"),
          speedTable("ทุกช่วงเวลา", null, speed.all),
          speedTable("เฉพาะเวลาทำการ 09:00–21:00",
            "ลูกแพรตอบตอนตีสองได้ คนไม่ได้ — ชุดนี้ตัดเวลานอกงานออกแล้ว",
            speed.workingHours),
          speedTable("⭐ เวลาทำการ เฉพาะวันที่ทีมทำงาน",
            "ชุดนี้คือตัวเลขที่ใช้ตัดสินผลงานทีมได้จริง — ตัดวันอาทิตย์ วันหยุดนักขัตฤกษ์ "
            + "และวันที่ทีมหยุดออกแล้ว",
            speed.workingDays),
          el("p", { class: "block-hint" },
            `นับเป็นวันทำงาน ${dayInfo.counted} วัน · ตัดออก ${dayInfo.excluded.length} วัน`),
          dayInfo.excluded.length
            ? el("details", { class: "kpi-details" },
                el("summary", {}, `วันที่ไม่นับเข้า KPI (${dayInfo.excluded.length} วัน)`),
                el("ul", { class: "kpi-list" }, ...dayInfo.excluded.map((day) => el("li", {},
                  `${day.key} — ${day.reason}`))),
                el("p", { class: "block-hint" },
                  "“ทีมหยุด” ตัดสินจากกฎที่พี่ง้วงให้: เช้า 09:00–11:00 ไม่มีใครในทีมตอบเลย "
                  + "โดยจะตัดเฉพาะวันที่มีลูกค้าทักเข้ามาตอนเช้าจริง ๆ — เช้าที่เงียบเพราะไม่มีใครถาม "
                  + "ไม่ถือว่าหยุด"),
              )
            : null,
          canEditHolidays() ? holidayBox(holidays) : null,
          el("p", { class: "block-hint" },
            "ใช้ค่ากลาง ไม่ใช่ค่าเฉลี่ย เพราะเคสตอบข้ามคืนไม่กี่เคสจะลากค่าเฉลี่ยจนไร้ความหมาย · "
            + "ข้อความติดตาม (follow-up) ไม่นับเป็นการตอบ"),
        ),

        el("section", { class: "block" },
          el("h2", {}, "② แชทที่ลูกค้ารออยู่"),
          el("div", { class: "kpi-cards" },
            statCard("รออยู่ทั้งหมด", String(backlog.total), "ห้องที่ลูกค้าพิมพ์ค้างไว้",
              backlog.total > 0 ? "kpi-warn" : ""),
            statCard("ต้องให้คนไปตอบ", String(backlog.waitingForHuman), "ห้องที่ AI ปิดอยู่",
              backlog.waitingForHuman > 0 ? "kpi-bad" : ""),
          ),
          el("p", { class: "block-hint" },
            `นับเฉพาะห้องที่ลูกค้ารออยู่ไม่เกิน ${backlog.excluded.maxAgeHours} ชม. — `
            + `ไม่รวมบทสนทนาที่จบไปแล้ว ${backlog.excluded.endedRooms} ห้อง `
            + `และข้อความแฮชแท็กที่ระบบตั้งใจไม่ตอบ ${backlog.excluded.hashtagRooms} ห้อง`
            + (Number(backlog.excluded.notQualifiedRooms) > 0
              ? ` · ห้องที่ AI คัดกรองว่ายังไม่เข้าเกณฑ์ ${backlog.excluded.notQualifiedRooms} ห้อง`
              : "")),
          el("div", { class: "kpi-scroll" },
            el("table", { class: "kpi-table" },
              el("thead", {}, el("tr", {}, el("th", {}, "รอมานานแค่ไหน"), el("th", {}, "จำนวนห้อง"))),
              el("tbody", {}, ...backlog.buckets.map((bucket) => el("tr", {},
                el("th", { scope: "row" }, bucket.label), el("td", {}, String(bucket.rooms))))),
            ),
          ),
          backlog.top.length
            ? el("details", { class: "kpi-details" },
                el("summary", {}, `ห้องที่รอนานที่สุด ${backlog.top.length} ห้อง`),
                el("ul", { class: "kpi-list" }, ...backlog.top.map((item) => el("li", {},
                  el("a", { href: `#/c/${encodeURIComponent(item.customerId)}` },
                    `…${String(item.customerId).slice(-6)}`),
                  ` · ${item.channelId} · รอมา ${humanDuration(item.waitedMs)}`,
                  item.aiEnabled ? "" : el("strong", {}, " · AI ปิดอยู่"),
                ))),
              )
            : null,
        ),

        el("section", { class: "block" },
          el("h2", {}, "③ อัตราพาไปถึงจุดปิดการขาย"),
          el("p", { class: "block-hint kpi-caveat" },
            "⚠️ ตัวเลขนี้วัด “พาไปถึงจุดปิด” (ส่งเลขบัญชี หรือส่งรายละเอียด private/in-house ครบ) "
            + "ไม่ใช่ “เก็บเงินได้จริง” — ลูกแพรไม่อ่านสลิปและไม่ยืนยันยอดโดยตั้งใจ"),
          el("div", { class: "kpi-cards" },
            statCard("Hybrid (คน + AI ช่วยกัน)", pct(closing.hybrid), sample(closing.hybrid), thin(closing.hybrid)),
            statCard("ลูกแพรล้วน", pct(closing.fullyAi), sample(closing.fullyAi), thin(closing.fullyAi)),
            statCard("ห้องที่ทีมงานดูแลล้วน", String(closing.humanOnlyRooms),
              `ปิดได้ ${closing.humanOnlyClosed} ห้อง · ไม่คิดเป็น %`),
          ),
          el("p", { class: "block-hint kpi-caveat" },
            "ทำไมห้องที่ทีมงานดูแลล้วนถึงไม่มี %: เคสยากถูกส่งต่อให้คนเสมอ (จังหวะเงิน ข้อร้องเรียน งาน in-house) "
            + "ห้องกลุ่มนี้จึงเป็นเคสที่ถูกคัดมาแล้วว่ายาก การเอา % ไปเทียบกับกลุ่มอื่นจะสรุปผิด"),
          closing.hybrid.rooms + closing.fullyAi.rooms < 20
            ? el("p", { class: "block-hint kpi-thin-note" },
                "ตัวอย่างยังน้อยเกินกว่าจะสรุปแนวโน้มได้ — รอสะสมสัก 2–4 สัปดาห์ค่อยใช้ตัวเลขนี้ตัดสินใจ")
            : null,
          closing.noReplyRooms
            ? el("p", { class: "block-hint" }, `มี ${closing.noReplyRooms} ห้องที่ยังไม่มีใครตอบเลยในช่วงนี้`)
            : null,
        ),

        relay ? relaySection(relay) : null,
        teamReview?.ok ? teamReviewSection(teamReview) : null,

        el("p", { class: "block-hint" },
          `ช่วงที่วัด ${days} วัน · ${totals.rooms} ห้อง · ลูกค้าพูดทั้งหมด ${totals.inboundTurns} ตา`),
      )),
      tabBar(),
    );
    setView("page");
  }

  return renderKpi;
}
