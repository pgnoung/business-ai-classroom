// overviewRoas.mjs — แผง "ROAS รวมทั้งบริษัท" ในหัวข้อรายละเอียดสำหรับทีมของหน้าภาพรวม
//
// 28 ก.ย. 2026: แยกจาก overviewTeam.mjs ให้แต่ละไฟล์ไม่เกิน ~400 บรรทัด — โค้ดย้ายมาทั้งก้อน
// ข้อความ เงื่อนไข และการยิง API เหมือนเดิมทุกบรรทัด (ต้นทางคือ overview.mjs ก่อนแยก)
// แผงนี้วาดเฉพาะผู้มีสิทธิ์เงิน (finance.view) — overview.mjs เป็นคนตัดสิน และเซิร์ฟเวอร์กันซ้ำอีกชั้น
import { el } from "./dom.mjs";
// 6 ต.ค. 2026: กล่อง "แอดตัวไหนพาคนแบบไหนมา" — โหลดเองเมื่อกดเปิด ใช้ช่วงเวลาเดียวกับแผงนี้
import { adReferralBox } from "./overviewAdReferrals.mjs";

export function createRoasPanel({ api, rerender, getRoasRange, setRoasRange, panelBroken }) {
  /* ---- แผง ROAS รวมทั้งบริษัท (คำสั่งพี่ง้วง 1 ก.ย. 2026) ----
   * รวมทั้งบริษัทตัวเดียว แล้วแตกยอดขายในวงเล็บว่ามาจากช่องไหนเท่าไร
   * ถ้าข้อมูลต้นทุนยังไม่ครบ จะไม่โชว์ตัวเลข ROAS แต่บอกตรง ๆ ว่าขาดอะไร
   */
  function roasPanel(r) {
    // กันที่รูปข้อมูลจริง ไม่ใช่แค่ธง ok — หน้าภาพรวมคือหน้าแรกหลังล็อกอิน ห้ามล้มทั้งหน้า
    if (!r?.ok || !r.window || !r.costs || !r.line || !Array.isArray(r.missing)) {
      return panelBroken("ROAS รวมทั้งบริษัท", r);
    }
    const baht = (v) => (v == null ? "—" : `฿${Math.round(v).toLocaleString("th-TH")}`);
    const msgs = (v) => (v == null ? "—" : Number(v).toLocaleString("th-TH"));
    const chLabel = { default: "LINE", facebook: "Facebook" };
    const parts = Object.entries(r.revenueByChannel || {})
      .map(([ch, v]) => `${chLabel[ch] || ch} ${baht(v)}`).join(" · ");
    // ตัดสินจากกำไรจริง ไม่ใช่ตัวเลข ROAS ที่ผ่านการปัดมาแล้ว
    const good = r.profitThb != null && r.profitThb >= 0;
    const cost = (label, value, sub) => el("div", { class: "roas-cost" },
      el("span", { class: "roas-cost-label" }, label),
      el("span", { class: "roas-cost-value" }, baht(value)),
      sub ? el("span", { class: "roas-cost-sub" }, sub) : null,
    );
    return el("section", { class: "kpi-hero roas-hero" },
      el("div", { class: "kpi-hero-head" },
        el("span", { class: "kpi-hero-title" }, "ROAS รวมทั้งบริษัท"),
        rangePicker(),
      ),
      el("div", { class: "roas-top" },
        el("div", { class: `roas-big ${r.roas == null ? "is-unknown" : good ? "is-good" : "is-bad"}` },
          el("span", { class: "kpi-hero-label" }, "ROAS"),
          el("span", { class: "roas-big-value" }, r.roas == null ? "—" : `${r.roas.toFixed(2)}x`),
          el("span", { class: "kpi-hero-sub" },
            r.roas != null ? `กำไร ${baht(r.profitThb)}`
              : r.noCost ? "ยังไม่มีต้นทุนในช่วงนี้ จึงยังหาร ROAS ไม่ได้"
                : `ยังคำนวณไม่ได้ — ขาด${r.missing.join(" และ ")}`),
        ),
        el("div", { class: "roas-rev" },
          el("span", { class: "kpi-hero-label" }, "ยอดขาย"),
          el("span", { class: "kpi-hero-value" }, baht(r.revenueThb)),
          el("span", { class: "kpi-hero-sub" }, parts ? `(${parts})` : "ยังไม่มีออเดอร์ในช่วงนี้"),
        ),
      ),
      el("div", { class: "roas-costs" },
        cost("ค่าแอด Meta", r.costs.adsThb, adsSourceNote(r)),
        cost("ค่า AI", r.costs.aiThb, "คิดอัตโนมัติ"),
        cost("ค่าส่งข้อความ LINE", r.costs.lineThb,
          r.costs.lineThb == null
            ? (r.line.reason || "อ่านโควตาไม่ได้")
            : `${msgs(Math.round(r.line.windowMsgsUsed))} ข้อความ × ฿${r.line.ratePerMsg}${r.line.estimated ? " (เฉลี่ย)" : ""}`),
        // พี่ง้วงขอไม่ให้โชว์ค่าใช้จ่ายอื่น ๆ — แต่ถ้ากรอกไว้แล้วซ่อน ยอดรวมจะไม่ตรงกับที่บวกเอง
        // จึงซ่อนเฉพาะตอนเป็นศูนย์ (ค่าเริ่มต้น) และโชว์เมื่อมีค่าจริง
        r.costs.miscThb > 0 ? cost("ค่าใช้จ่ายอื่น ๆ", r.costs.miscThb, "กรอกในตั้งค่าต้นทุน") : null,
        cost("ต้นทุนรวม", r.totalCostThb, ""),
      ),
      adsDailyBox(r),
      adReferralBox({ api, rangeQuery: roasRangeQuery }),
      ingestBox(r),
      lineSplitBox(r.line),
      costForm(r),
    );
  }

  // บอกที่มาของตัวเลขค่าแอดให้ชัด — อัตโนมัติรายวัน หรือกรอกมือก้อนเดียว
  // และเตือนเมื่อข้อมูลรายวันไม่ครบช่วง เพราะ ROAS จะต่ำกว่าจริงโดยไม่มีใครสังเกต
  function adsSourceNote(r) {
    const a = r.ads;
    if (!a) return r.costs.adsThb == null ? "ยังไม่ได้กรอก" : "";
    if (a.source === "none") return "ยังไม่ได้กรอก";
    // 2 ก.ย. 2026: ข้อมูลไม่ครบช่วง = ไม่มีตัวเลข ต้องบอกเหตุผลว่าทำไมและต้องรออะไร
    // ห้ามปล่อยให้ช่องว่างเปล่า คนจะคิดว่าระบบพัง แล้วไม่แจ้งใคร
    if (a.source === "incomplete") return a.reason || "ข้อมูลไม่ครบช่วงที่เลือก";
    if (a.source === "manual") {
      return a.estimated
        ? `เฉลี่ยจากยอดที่กรอกไว้ ${a.manualBasisDays} วัน`
        : "กรอกมือ (ยังไม่ได้ต่ออัตโนมัติ)";
    }
    return a.daysWithData < a.daysInWindow
      ? `อัตโนมัติ — มีข้อมูล ${a.daysWithData} จาก ${a.daysInWindow} วัน`
      : "อัตโนมัติจาก Make";
  }

  function adsDailyBox(r) {
    const a = r.ads;
    if (!a || !Array.isArray(a.recent) || !a.recent.length) return null;
    const baht = (v) => `฿${Math.round(Number(v) || 0).toLocaleString("th-TH")}`;
    return el("details", { class: "kpi-details" },
      el("summary", {}, `ค่าแอดรายวัน (${a.recent.length} วันล่าสุด)`),
      el("div", { class: "kpi-scroll" },
        el("table", { class: "kpi-table" },
          el("thead", {}, el("tr", {}, el("th", {}, "วันที่"), el("th", {}, "ค่าแอด"), el("th", {}, "ที่มา"))),
          el("tbody", {}, ...a.recent.map((row) => el("tr", {},
            el("th", { scope: "row" }, row.day),
            el("td", {}, baht(row.spend_thb)),
            el("td", {}, row.source || "—"),
          ))),
        ),
      ),
      a.daysWithData < a.daysInWindow
        ? el("p", { class: "block-hint kpi-caveat" },
            `ช่วงที่เลือกมี ${a.daysInWindow} วัน แต่มีค่าแอดแค่ ${a.daysWithData} วัน — `
            + "ROAS จะดูดีเกินจริงจนกว่าข้อมูลจะครบ")
        : null,
    );
  }

  /* ---- แยกให้เห็นว่าโควตา LINE เดือนนี้ ถูกใช้ไปกับบรอดแคสเท่าไร บอทเท่าไร ----
   * พี่ง้วงบรอดแคสจาก manager.line.biz ไม่ได้ทำผ่านคอนโซล แต่ใช้โควตาก้อนเดียวกัน
   * LINE มีแต่ยอดรวมทั้งเดือน จึงหาส่วนบรอดแคสด้วยการลบส่วนที่ระบบเรารู้ว่าเป็นของเราออก
   */
  function lineSplitBox(line) {
    if (line?.monthTotalMsgs == null) return null;
    const n = (v) => Number(v || 0).toLocaleString("th-TH");
    const pill = (label, value, tone) => el("div", { class: `roas-split-cell ${tone || ""}` },
      el("span", { class: "roas-cost-label" }, label),
      el("span", { class: "roas-cost-value" }, n(value)),
    );
    return el("details", { class: "kpi-details" },
      el("summary", {}, `โควตา LINE เดือนนี้ ${n(line.monthTotalMsgs)} ข้อความ`),
      el("div", { class: "roas-split" },
        pill("บรอดแคส (LINE OA)", line.monthBroadcastMsgs, "is-broadcast"),
        pill("ลูกแพรส่ง", line.monthAiMsgs, "is-ai"),
        pill("รวมทั้งหมด", line.monthTotalMsgs, ""),
      ),
      el("p", { class: "block-hint" },
        `ช่วงที่เลือกนี้ลูกแพรส่งไป ${n(line.windowAiMsgs)} ข้อความ`),
      line.aiExceedsTotal
        ? el("p", { class: "block-hint kpi-caveat" },
            "ยอดที่บอทส่งมากกว่ายอดโควตา — เป็นเรื่องปกติ เพราะข้อความที่ตอบกลับด้วย reply "
            + "LINE ไม่คิดโควตา มีเฉพาะ push กับบรอดแคสที่นับ ตัวเลขบรอดแคสจึงอ่านเป็น “อย่างน้อย” ไม่ใช่ค่าเป๊ะ")
        : el("p", { class: "block-hint" },
            "ตัวเลขบรอดแคสตรงนี้ประมาณจาก ยอดรวม − ข้อความที่บอทส่ง จึงเป็นค่าอย่างต่ำ — "
            + "ที่มาแยกละเอียด (ส่งเข้าทีม · บรอดแคสต์จาก OA Manager · ส่งหาลูกค้า) ดูที่การ์ด “LINE OA เดือนนี้” ด้านล่าง"),
      line.estimated
        ? el("p", { class: "block-hint kpi-caveat" },
            "ค่าส่งของช่วงที่เลือกเป็นค่าเฉลี่ยรายวันจากยอดทั้งเดือน เพราะ LINE ไม่มีตัวเลขรายวันให้ดึง")
        : null,
    );
  }

  /* ---- กล่องต่อ Make: URL + กุญแจ ----
   * กุญแจโชว์ครั้งเดียวตอนกดสร้าง แล้วดูย้อนหลังไม่ได้ — อยากได้ใหม่ต้องสร้างใหม่
   * ตั้งใจให้เป็นแบบนี้ เพื่อไม่ให้มีที่ไหนในระบบเก็บกุญแจไว้ให้อ่านซ้ำได้
   */
  function ingestBox(r) {
    // ใช้ URL ที่เซิร์ฟเวอร์บอกมา (บังคับ https) ไม่ใช่ location.origin ซึ่งอาจเป็น http
    // กุญแจเดินทางไปกับ header ถ้าไปทาง http จะวิ่งเปลือยให้คนกลางอ่านได้
    const url = r.ads?.ingestUrl || `${globalThis.location.origin}/webhooks/ads-spend`;
    const out = el("div", { class: "roas-key-out" });
    const status = el("span", { class: "rv-status" },
      r.ads?.ingestReady ? "ตั้งกุญแจไว้แล้ว" : "ยังไม่ได้ตั้งกุญแจ — Make ยังยิงเข้ามาไม่ได้");
    const show = el("button", { class: "btn btn-ghost", onclick: async () => {
      status.textContent = "กำลังอ่าน…"; status.className = "rv-status";
      try {
        const result = await api("/console/api/roas/ingest-key?reveal=1");
        if (!result.key) throw new Error("ยังไม่ได้สร้างกุญแจ");
        out.replaceChildren(
          el("p", { class: "block-hint" }, "คัดลอกไปวางในช่อง x-ads-key ของ Make"),
          el("code", { class: "roas-key" }, result.key));
        status.textContent = ""; status.className = "rv-status";
      } catch (err) {
        status.textContent = String(err?.message || err); status.className = "rv-status rv-bad";
      }
    } }, "ดูกุญแจ");
    show.hidden = !r.ads?.ingestReady;
    const gen = el("button", { class: "btn btn-ghost", onclick: async () => {
      if (r.ads?.ingestReady
        && !globalThis.confirm("สร้างกุญแจใหม่จะทำให้ของเดิมใช้ไม่ได้ทันที และต้องไปแก้ใน Make ด้วย — ยืนยันไหม?")) return;
      status.textContent = "กำลังสร้าง…"; status.className = "rv-status";
      try {
        const result = await api("/console/api/roas/ingest-key", { method: "POST" });
        out.replaceChildren(
          el("p", { class: "block-hint" }, "คัดลอกไปวางในช่อง x-ads-key ของ Make"),
          el("code", { class: "roas-key" }, result.key),
        );
        status.textContent = "สร้างแล้ว"; status.className = "rv-status rv-ok";
      } catch (err) {
        status.textContent = String(err?.message || err); status.className = "rv-status rv-bad";
      }
    } }, r.ads?.ingestReady ? "สร้างกุญแจใหม่" : "สร้างกุญแจ");
    return el("details", { class: "kpi-details" },
      el("summary", {}, "ต่อ Make ให้ยิงค่าแอดอัตโนมัติ"),
      el("p", { class: "block-hint" }, "ปลายทางที่ Make ต้องยิง (POST):"),
      el("code", { class: "roas-key" }, url),
      el("p", { class: "block-hint" },
        "ใส่กุญแจใน header ชื่อ x-ads-key และส่ง JSON: "
        + '{ "day": "2026-08-31", "spend": 3210.50, "accountId": "act_100000000000001" }'),
      el("div", { class: "rv-actions" }, show, gen, status),
      out,
    );
  }

  function costForm(r) {
    const field = (name, label, value, hint) => {
      const input = el("input", { class: "roas-input keep-focus", type: "text", inputmode: "decimal", value: value ?? "" });
      input.dataset.field = name;
      return el("label", { class: "roas-field" },
        el("span", {}, label), input, hint ? el("small", {}, hint) : null);
    };
    const s = r.settings || {};
    const wrap = el("div", { class: "roas-form" },
      field("adsThb", "ค่าแอด Meta (บาท)", s.adsThb, "ใช้เมื่อยังไม่มีข้อมูลรายวันจาก Make"),
      field("adsWindowDays", "ยอดค่าแอดข้างบนเป็นของกี่วัน", s.adsWindowDays || "30",
        "ระบบจะเฉลี่ยตามช่วงที่เลือกให้เอง"),
      field("lineRateThb", "ค่าส่ง LINE ต่อข้อความ", s.lineRateThb || "0.06", "ค่าเริ่มต้น 0.06 บาท"),
      field("miscThb", "ค่าใช้จ่ายอื่น ๆ (บาท)", s.miscThb, "เช่น chat package และจิปาถะอื่น"),
    );
    const status = el("span", { class: "rv-status" });
    const save = el("button", { class: "btn btn-ghost", onclick: async () => {
      const body = {};
      for (const input of wrap.querySelectorAll("input")) body[input.dataset.field] = input.value.trim();
      status.textContent = "กำลังบันทึก…"; status.className = "rv-status";
      try {
        await api("/console/api/roas", { method: "PUT", body: body });
        status.textContent = "บันทึกแล้ว"; status.className = "rv-status rv-ok";
        rerender();
      } catch (err) {
        status.textContent = String(err?.message || err); status.className = "rv-status rv-bad";
      }
    } }, "บันทึกต้นทุน");
    return el("details", { class: "kpi-details" },
      el("summary", {}, "ตั้งค่าต้นทุน"),
      wrap,
      el("div", { class: "rv-actions" }, save, status),
    );
  }

  /* ---- ตัวเลือกช่วงเวลา: ย้อนหลัง 7/30 วัน หรือเจาะดูรายวัน ----
   * รายวันใช้ขอบวันเวลาไทย ไม่ใช่ 24 ชม.ย้อนหลัง — เจ้าของถาม "ยอดวันที่ 1" ไม่ใช่ "24 ชม.ที่ผ่านมา"
   * keep-focus: ระหว่างเลือกอยู่ poll ห้าม re-render ทับ (หน้าภาพรวมรีเฟรชทุกนาทีแล้ว)
   */
  // ช่วงที่เลือกอยู่ในรูป query เดียวกับที่หน้าภาพรวมยิง /console/api/roas ("days:30" → "days=30")
  function roasRangeQuery() {
    const range = String(getRoasRange() || "days:30");
    return range.startsWith("date:") ? `date=${encodeURIComponent(range.slice(5))}` : `days=${encodeURIComponent(range.slice(5))}`;
  }

  function rangePicker() {
    const select = el("select", { class: "roas-range keep-focus", "aria-label": "ช่วงเวลาของ ROAS" });
    const add = (value, label) => {
      const option = el("option", { value }, label);
      if (value === getRoasRange()) option.selected = true;
      select.appendChild(option);
    };
    add("days:7", "ย้อนหลัง 7 วัน");
    add("days:30", "ย้อนหลัง 30 วัน");
    const today = new Date(Date.now() + 7 * 3_600_000);
    for (let i = 0; i < 14; i += 1) {
      const d = new Date(today.getTime() - i * 86_400_000);
      const key = d.toISOString().slice(0, 10);
      const label = i === 0 ? `วันนี้ (${key})` : i === 1 ? `เมื่อวาน (${key})` : key;
      add(`date:${key}`, label);
    }
    select.addEventListener("change", () => { setRoasRange(select.value); rerender(); });
    return select;
  }
  return roasPanel;
}
