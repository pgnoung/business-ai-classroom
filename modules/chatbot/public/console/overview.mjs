// overview.mjs — หน้า "ภาพรวม" ของ console (แยกไฟล์จาก console.js เพื่อคุมขนาดไฟล์)
// UX pass (คำติเจ้าของ 2026-08-10): ทุกการ์ดมีป้ายภาษาคนไทย + บรรทัดอธิบายใต้หัวข้อ,
// จุดแตะไปหน้าที่ถูกต้องจริง (ไม่พาเข้าแชทรวมมั่ว ๆ), สวิตช์เห็นเป็นสวิตช์จริง
//
// 28 ก.ย. 2026 (พี่ง้วง: "ตัวเลขเยอะ อยากให้ CEO ดูง่าย visual สวย ๆ"): หน้าแรกเปลี่ยนเป็น
// "วันนี้เป็นยังไง" — ลูกแพรเล่า + ประโยคละหนึ่งตัวเลข + คิวรอคนแบบเห็นหน้า + เส้นทางลูกค้า
// (overviewCeo.mjs) ส่วนการ์ด/แผงเดิมทั้งหมดยังอยู่ครบใน "รายละเอียดสำหรับทีม" (overviewTeam.mjs)
// ไฟล์นี้เหลือหน้าที่เดียว: ดึงข้อมูล กันผลค้างท่อ poll และประกอบหน้า
import { el, isGeneric } from "./dom.mjs";
import { switchDot } from "./ui.mjs";
import { NONGKAO_FACE_SRC, isLukpraeTheme, moodSrc } from "./lukpraeArt.mjs";
import { icon } from "./icons.mjs";
import { createTeamPanels } from "./overviewTeam.mjs";
import { attentionSection, funnelSection, heroDialog, summarizeDay, todayLines } from "./overviewCeo.mjs";
import { canSeeLineUsage, createLineUsagePanel } from "./lineUsage.mjs";
import { adSpendCard } from "./overviewAdSpend.mjs";
import { ownerReviewOverviewCard } from "./ownerReviewCard.mjs";

// รายชื่อ "เงินรั่ว" ขอมาทีเดียว 20 ห้อง (เพดานของ API) โชว์ 5 ห้องแรก ที่เหลือกางในหน้าเดิม
const ATTENTION_FETCH = 20;

export function createOverviewPage({ api, toast, mount, pageHeader, tabBar, stopPolling, state, setView }) {
  // 1 ก.ย. 2026: หน้าภาพรวมของพนักงานต้องไม่มีการ์ดเงินและกล่องต่อ webhook เลย
  // ด่านจริงอยู่ฝั่งเซิร์ฟเวอร์ (consoleApi.mjs) — ตรงนี้แค่ไม่วาดปุ่มที่กดไม่ได้
  const canFinance = () => state.me?.capabilities?.includes("finance.view") === true;
  // white-label (8 ต.ค. 2026): ร้านทั่วไปไม่มีค่าแอด/ROAS/ที่มาจากแอด และไม่มีจักรวาลลูกแพร
  // — ไม่ยิงเส้นและไม่วาดการ์ด (course: เงื่อนไขเดิมทุกตัว)
  const canAds = () => canFinance() && !isGeneric(state);
  const isOwner = () => state.me?.role === "owner";

  // REVIEW FIX v1.2 (HIGH): endpoint นี้ช้าสุดในระบบ (โควตาหลาย OA, timeout 10 วิ/ตัว)
  // — render ที่ fetch เสร็จช้าห้าม mount ทับหน้าที่ผู้ใช้เปิดไปแล้ว (แบบแผนเดียวกับ chat renderGen)
  let renderGen = 0;
  let lastSignature = "";
  // ช่วงเวลาของแผง ROAS ที่เลือกอยู่ — "days:7" | "days:30" | "date:YYYY-MM-DD"
  let roasRange = "days:30";
  // กาง "รายละเอียดสำหรับทีม" ค้างไว้ข้าม re-render (poll วาดหน้าใหม่ได้ทุกนาที)
  let teamOpen = false;
  // กางรายชื่อ "ดูเพิ่ม" ค้างไว้ข้าม re-render เหมือนกัน
  const expanded = { waiting: false, hot: false };

  // 28 ก.ย. 2026: การ์ด "LINE OA เดือนนี้" (เจ้าของ + แอดมิน) — โควตาไปกับทีม/บรอดแคสต์/ลูกค้าเท่าไร
  const lineUsage = createLineUsagePanel({ api, toast, state, rerender: () => renderOverview() });

  const team = createTeamPanels({
    api, toast, state,
    rerender: () => renderOverview(),
    getRoasRange: () => roasRange,
    setRoasRange: (value) => { roasRange = value; },
  });

  // W3: chip เลือกสาขา (โผล่เฉพาะ instance หลายสาขา) — แชร์ state.channel กับ inbox
  function branchChips(refresh) {
    if ((state.channels?.length ?? 0) <= 1) return null;
    const chip = (id, label) => el("button", {
      class: `fchip fchip-branch${(state.channel ?? null) === id ? " is-active" : ""}`,
      onclick: () => {
        if (state.channel === id) return;
        state.channel = id;
        refresh();
      },
    }, label);
    return el("nav", { class: "inbox-filters branch-filters overview-branches", "aria-label": "เลือกสาขา" },
      chip(null, "ทุกสาขา"),
      state.channels.map((ch) => chip(ch.id, ch.name || ch.id)),
    );
  }

  // สวิตช์หน้า Intro — เจ้าของเท่านั้น และเฉพาะ instance ลูกแพร (เนื้อหาเป็นจักรวาลลูกแพร)
  // ค่าเริ่มต้นปิด: เมนูขวาสุดจะโผล่ให้ทุกคนเห็นเมื่อพี่ง้วงกดเปิดที่นี่ (เซิร์ฟเวอร์กันสิทธิ์ซ้ำ)
  function introSwitch() {
    if (!isOwner() || !isLukpraeTheme() || isGeneric(state)) return null;
    const on = state.features?.intro === true;
    return el("section", { class: "block ov-intro-switch" },
      el("h2", { class: "block-title" }, "เมนู Intro · จักรวาลลูกแพร"),
      el("p", { class: "block-hint" }, "หน้าแนะนำลูกแพร น้องเก้า และน้องฝน พร้อมวิดีโออินโทร 60 วินาที — เปิดแล้วเมนูจะอยู่ขวาสุดให้ทุกคนในทีมเห็น"),
      el("button", {
        class: "switch-line", type: "button", role: "switch", "aria-checked": on ? "true" : "false",
        onclick: async () => {
          try {
            const result = await api("/console/api/intro", { method: "POST", body: { enabled: !on } });
            state.features = { ...state.features, intro: result.enabled === true };
            toast(result.enabled ? "เปิดเมนู Intro แล้ว" : "ซ่อนเมนู Intro แล้ว");
            await renderOverview();
          } catch (err) {
            toast(err.message);
          }
        },
      },
        switchDot(on),
        el("span", { class: `switch-state ${on ? "is-on-text" : "is-off-text"}` }, on ? "เปิดให้ทีมเห็น" : "ซ่อนอยู่"),
        el("span", { class: "switch-line-hint" }, on ? "แตะเพื่อซ่อน" : "แตะเพื่อเปิด"),
      ),
    );
  }

  // ทางเข้าหน้า Intro บนมือถือ (แถบล่างเต็มแล้ว) — หน้าสามพี่น้องเรียงกันเล็ก ๆ
  function universeTeaser() {
    return el("a", { class: "ov-universe", href: "#/intro" },
      el("span", { class: "ov-universe-faces", "aria-hidden": "true" },
        el("img", { class: "ov-face", src: moodSrc("smile"), width: "208", height: "208", alt: "", loading: "lazy" }),
        el("img", { class: "ov-face", src: NONGKAO_FACE_SRC, width: "160", height: "160", alt: "", loading: "lazy" }),
        el("span", { class: "ov-face is-rain" }, icon("drop", { size: 16 })),
      ),
      el("span", { class: "ov-universe-copy" },
        el("span", { class: "ov-universe-title" }, "จักรวาลลูกแพร"),
        el("span", { class: "ov-universe-sub" }, "รู้จักลูกแพร น้องเก้า และน้องฝน"),
      ),
    );
  }

  function teamDetails({ data, kpi, roas, lineUsagePayload }) {
    const details = el("details", { class: "ov-team", id: "ov-team" },
      el("summary", { class: "ov-team-summary" },
        el("span", { class: "ov-team-title" }, "รายละเอียดสำหรับทีม"),
        el("span", { class: "ov-team-hint" }, "ผลงานละเอียด ต้นทุน โควตา สวิตช์ และการส่งออก"),
      ),
      el("div", { class: "ov-team-body" },
        team.kpiPanel(kpi),
        // roasPanel ตัวเดียวพา adsDailyBox / ingestBox / lineSplitBox / costForm / rangePicker
        // หายไปทั้งชุด เพราะทั้งหมดถูกเรียกอยู่ข้างใน
        canAds() ? team.roasPanel(roas) : null,
        canSeeLineUsage(state) ? lineUsage.panel(lineUsagePayload) : null,
        team.trendBlock(data.series), // v1.2: กราฟแนวโน้ม 14 วัน (ต่อสาขาที่เลือก)
        team.statGrid(data, { canFinance: canFinance() }),
        // บรรทัดนี้ลิงก์ไปบล็อกโมเดลในหน้าตั้งค่าที่ถูกซ่อนไปแล้ว = ทางตันถ้าไม่ซ่อนด้วย
        canFinance() ? team.modelLine(data.aiCost) : null,
        team.exportBlock(),
        introSwitch(),
      ),
    );
    details.open = teamOpen;
    details.addEventListener("toggle", () => { teamOpen = details.open; });
    return details;
  }

  function openTeam() {
    teamOpen = true;
    const details = document.getElementById("ov-team");
    if (!details) return;
    details.open = true;
    const calm = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    details.scrollIntoView?.({ behavior: calm ? "auto" : "smooth", block: "start" });
  }

  async function renderOverview({ poll = false } = {}) {
    const gen = ++renderGen;
    const routeGen = state.routeGen;
    stopPolling();
    // W3: สถิติ scoped ตามสาขาที่เลือก (null = ทุกสาขา)
    const overviewQs = state.channel ? `?channel=${encodeURIComponent(state.channel)}` : "";
    // inbox ขอแค่ตัวเลขกลุ่มลูกค้า (counts) สำหรับเส้นทางลูกค้า — แถวเดียวพอ
    const countsQs = new URLSearchParams({ limit: "1" });
    if (state.channel) countsQs.set("channel", state.channel);
    const attentionQs = new URLSearchParams({ limit: String(ATTENTION_FETCH) });
    if (state.channel) attentionQs.set("channel", state.channel);
    const [data, kpi, roas, inbox, attention, lineUsagePayload, adSummary, ownerReview] = await Promise.all([
      api(`/console/api/overview${overviewQs}`),
      // เดิมกลืนเป็น null เฉย ๆ แล้วการ์ดหายเงียบ — 1 ก.ย. 2026 เส้น kpi พังเป็น 500
      // อยู่หลายสิบนาทีโดยไม่มีใครเห็น เพราะหน้าจอดูเหมือน "ยังไม่ได้ทำฟีเจอร์นี้"
      // เก็บ error ไว้เพื่อให้การ์ดบอกได้ว่า "โหลดไม่สำเร็จ" ไม่ใช่หายไปเฉย ๆ
      api("/console/api/kpi?days=7").catch((err) => ({ __failed: String(err?.message || err) })),
      // ไม่มีสิทธิ์ = ไม่ยิงเลย ไม่ใช่ยิงแล้วกลืน 403 — แผงแดง "ROAS รวมทั้งบริษัท
      // โหลดไม่สำเร็จ" จะได้ไม่ขึ้นบนจอพนักงาน (แผงแดงเองก็คือการบอกใบ้ของที่กันไว้)
      canAds()
        ? api(`/console/api/roas?${roasRange.startsWith("date:")
          ? `date=${roasRange.slice(5)}`
          : `days=${roasRange.slice(5)}`}`).catch(() => null)
        : Promise.resolve(null),
      api(`/console/api/inbox?${countsQs}`).catch(() => null),
      // เงินรั่วสองทาง (ลูกค้ารอคนตอบ / ลูกค้าร้อนเงียบไป รอทีมทักต่อ) — พังต้องบอกว่าพัง ไม่ใช่รายชื่อว่าง
      api(`/console/api/overview/attention?${attentionQs}`).catch((err) => ({ __failed: String(err?.message || err) })),
      // ไม่มีสิทธิ์ = ไม่ยิง (พนักงานไม่เห็นการ์ดนี้เลย) · พัง = การ์ดบอกว่าโหลดไม่สำเร็จ ไม่หายเงียบ
      canSeeLineUsage(state)
        ? api(lineUsage.query()).catch((err) => ({ __failed: String(err?.message || err) }))
        : Promise.resolve(null),
      // 7 ต.ค. 2026: การ์ดค่าแอดใบใหญ่ — เจ้าของเท่านั้น · พังแล้วการ์ดหาย หน้าแรกยังเปิดได้
      canAds() ? api("/console/api/roas/ad-summary").catch(() => null) : Promise.resolve(null),
      // 12 ต.ค. 2026 ค่ำ: ห้องตรวจ — peek=1 อ่านตัวเลขเฉย ๆ (ไม่ล้างแจ้งเตือนมือถือของเจ้าของระหว่าง poll)
      state.features?.ownerReview === true
        ? api("/console/api/owner-review/summary?peek=1").catch(() => null)
        : Promise.resolve(null),
    ]);
    // stale guard: มี render ใหม่กว่า หรือผู้ใช้ออกจากหน้าภาพรวมไปแล้ว = ทิ้งผลชุดนี้เงียบ ๆ
    const hash = location.hash || "#/";
    if (gen !== renderGen || routeGen !== state.routeGen || !(hash === "" || hash === "#" || hash === "#/")) return;
    // นาทีปัจจุบันอยู่ในลายเซ็นด้วย: "รอ 23 นาที" ต้องเดินตามจริง แม้ข้อมูลไม่เปลี่ยน
    const signature = JSON.stringify({
      data, adSummary, minute: Math.floor(Date.now() / 60_000), intro: state.features?.intro === true,
      ownerReview: ownerReview ? [ownerReview.counts?.pending, ownerReview.counts?.sendFailed] : null,
      counts: inbox?.counts || null,
      attention: attention?.__failed ? "failed" : [
        attention?.waiting?.total, attention?.hotQuiet?.total,
        (attention?.waiting?.rooms || []).map((room) => room.id),
        (attention?.hotQuiet?.rooms || []).map((room) => room.id),
      ],
      // asOf เปลี่ยนทุกคำขอ — ถ้าอยู่ในลายเซ็น หน้าจะวาดใหม่ทุก 15 วิแม้ตัวเลขไม่ขยับ
      lineUsage: lineUsagePayload?.report ? { ...lineUsagePayload, report: { ...lineUsagePayload.report, asOf: 0 } } : lineUsagePayload,
    });
    if (poll && signature === lastSignature && document.querySelector(".page-scroll")) {
      armPoll();
      return;
    }
    const day = summarizeDay({ data, counts: inbox?.counts, attention, kpi });
    const kpiOk = Boolean(kpi?.ok && kpi.speed?.workingDays);
    const leak = (kind) => {
      const build = () => attentionSection({
        kind, day, expanded: expanded[kind],
        // 28 ก.ย. 2026: ปุ่มลัด ✓ เสร็จสิ้น / สแปม บนแถวรอตอบ — ทำแล้ววาดหน้าใหม่ทันที (ห้องหลุดจากรายการ)
        actions: kind === "waiting" ? { api, toast, onChanged: () => renderOverview() } : null,
        onToggle: () => {
          expanded[kind] = !expanded[kind];
          const next = build();
          section.replaceWith(next);
          section = next;
        },
      });
      let section = build();
      return section;
    };

    mount(
      pageHeader("ภาพรวม"),
      el("main", { class: "page-scroll" }, el("div", { class: "page-inner ov" },
        branchChips(renderOverview),
        // 7 ต.ค. 2026 (พี่ง้วง): ค่าแอดต้องเห็นชัดตั้งแต่เปิดหน้า — การ์ดใหญ่บนสุด (เจ้าของเท่านั้น)
        canAds() ? adSpendCard(adSummary, { onOpenDetail: openTeam }) : null,
        // ห้องที่ AI เสนอปิดรอยืนยัน — โผล่เฉพาะตอนมีห้องรอ (ทางเข้าบนมือถือ แถบล่างไม่มีเมนูนี้)
        ownerReviewOverviewCard(ownerReview),
        // บนสุดสองคอลัมน์ที่สูงไม่เท่ากันได้ (ไม่ยืดการ์ดให้โหว่):
        //   ซ้าย = ลูกแพรเล่า → ลูกค้ารอคนตอบ (ประโยคของเธอกับรายชื่ออยู่ติดกัน)
        //   ขวา  = ตัวเลขวันนี้ → ลูกค้าร้อนเงียบไป รอทีมทักต่อ
        // มือถือเรียงซ้ายก่อนขวา: เงินรั่วก้อนใหญ่สุดจึงอยู่ใต้ประโยคของลูกแพรทันที
        el("section", { class: `ov-top mood-${day.mood.mood}`, "aria-label": "วันนี้เป็นยังไง" },
          el("div", { class: "ov-col" },
            heroDialog({ state, data, day }),
            leak("waiting"),
          ),
          el("div", { class: "ov-col" },
            todayLines({ data, day, kpiOk, roas, canFinance: canFinance(), openTeam }),
            leak("hot"),
          ),
        ),
        funnelSection({ day, data }),
        state.features?.intro === true && isLukpraeTheme() && !isGeneric(state) ? universeTeaser() : null,
        teamDetails({ data, kpi, roas, lineUsagePayload }),
      )),
      tabBar(),
    );
    lastSignature = signature;
    setView("page");
    armPoll();
  }

  // REVIEW FIX v1.2: แบบแผนเดียวกับ chat.mjs — setTimeout ลูกโซ่ rearm ใน finally เสมอ
  // (เดิม setInterval + stopPolling ต้นทาง: fetch ล้มครั้งเดียว = polling ตายถาวร)
  function armPoll() {
    stopPolling();
    // ยังอยู่หน้าภาพรวมจริงไหม — poll ที่ค้างท่อจากหน้าอื่นห้าม mount ทับหน้านั้น
    const onOverview = () => {
      const h = location.hash || "#/";
      return h === "" || h === "#" || h === "#/";
    };
    state.pollTimer = setTimeout(async () => {
      state.pollTimer = null;
      if (!onOverview()) return; // ออกจากหน้านี้แล้ว — หน้าใหม่มี poll ของตัวเอง
      const typing = document.activeElement?.classList?.contains("keep-focus");
      try {
        if (!typing && document.visibilityState !== "hidden") await renderOverview({ poll: true });
      } catch { /* เงียบ — rearm ด้านล่างเสมอ */ }
      finally {
        if (!state.pollTimer && onOverview()) armPoll();
      }
    }, 15_000);
  }

  return renderOverview;
}
