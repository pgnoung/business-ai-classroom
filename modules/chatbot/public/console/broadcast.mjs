// broadcast.mjs — หน้าบรอดแคสต์ (สตูดิโอ) ของคอนโซล (เขียนใหม่ 28 ก.ย. 2026)
//
// พี่ง้วงขอ (28 ก.ย. 2026): "สำหรับ บรอดแคส ให้ทำ ระบบที่สร้างได้เหมือน LINE OA MANAGER เลยได้ไหม
// และให้สร้างระบบ STEP MESSAGE เหมือน LINE OA เลย"
// แท็บ (สถานะอยู่ใน URL): #/broadcast = สร้างข้อความ · #/broadcast/steps = ข้อความตามขั้น · #/broadcast/results = ผลลัพธ์
// ทุกการส่งยังต้องยืนยันโดยคน และเซิร์ฟเวอร์ตรวจกลุ่มผู้รับ/ข้อความ/โควตา/สิทธิ์ซ้ำทุกครั้ง
import { el } from "./dom.mjs";
import { createBroadcastCreateTab, createStudioStore } from "./broadcastCreate.mjs";
import { createBroadcastResultsTab } from "./broadcastResults.mjs";
import { permissionBlock, quarantineReviewBlock, scheduleListBlock, selfTestBlock } from "./broadcastBlocks.mjs";
import { createStepMessagesTab } from "./stepMessages.mjs";

// ตัวช่วย pure เดิม — เทสต์และหน้าอื่น import จากไฟล์นี้
export {
  broadcastCanSend, broadcastScheduleUiMode, broadcastSkippedCount, createBroadcastSegmentStore,
  formatBangkokDatetimeLocal, parseBangkokDatetimeLocal, quarantineResolutionConfirmationText,
} from "./broadcastState.mjs";

export const BROADCAST_TABS = Object.freeze([
  { key: "create", hash: "#/broadcast", label: "สร้างข้อความ" },
  { key: "steps", hash: "#/broadcast/steps", label: "ข้อความตามขั้น" },
  { key: "results", hash: "#/broadcast/results", label: "ผลลัพธ์" },
]);

export function currentBroadcastTab(hash = "") {
  const value = String(hash || "");
  if (value.startsWith("#/broadcast/steps")) return "steps";
  if (value.startsWith("#/broadcast/results")) return "results";
  return "create";
}

export function createBroadcastPage(deps) {
  const { api, toast, mount, pageHeader, tabBar, stopPolling, state, setView } = deps;
  const store = createStudioStore();
  const createTab = createBroadcastCreateTab(deps, store);
  const resultsTab = createBroadcastResultsTab(deps);
  // แท็บข้อความตามขั้นวาดหน้าใหม่เองหลังพัก/เปิดใช้/สลับสวิตช์ (URL เดิม = ไม่มี hashchange)
  const stepsTab = createStepMessagesTab({ ...deps, rerender: () => renderBroadcast() });
  let channelId = null;
  let renderGen = 0;

  const stillCurrent = (gen, routeGen, expectedHash) =>
    gen === renderGen && routeGen === state.routeGen && (location.hash || "#/") === expectedHash;

  async function loadTabData(tab, meta, query) {
    if (tab === "results") {
      const canManagePermissions = state.me?.role === "owner";
      const [campaigns, quarantines, schedules, permissions] = await Promise.all([
        api(`/console/api/broadcast/studio/campaigns${query}`).catch(() => null),
        meta.canSend === true ? api(`/console/api/broadcast/quarantines${query}`).catch(() => null) : Promise.resolve(null),
        meta.canSend === true ? api(`/console/api/broadcast/schedule${query}`).catch(() => null) : Promise.resolve(null),
        canManagePermissions ? api("/console/api/broadcast/permissions").catch(() => null) : Promise.resolve(null),
      ]);
      return { campaigns, quarantines, schedules, permissions };
    }
    if (tab === "create") {
      const [selfTest, quarantines] = await Promise.all([
        meta.canTestSend === true ? api(`/console/api/broadcast/self-test${query}`).catch(() => null) : Promise.resolve(null),
        meta.canSend === true ? api(`/console/api/broadcast/quarantines${query}`).catch(() => null) : Promise.resolve(null),
      ]);
      return { selfTest, quarantines };
    }
    return {};
  }

  async function renderBroadcast() {
    const gen = ++renderGen;
    const routeGen = state.routeGen;
    const expectedHash = location.hash || "#/";
    stopPolling();
    const tab = currentBroadcastTab(expectedHash);

    if (!channelId) {
      const bootstrap = await api("/console/api/broadcast/studio/meta");
      if (!stillCurrent(gen, routeGen, expectedHash)) return;
      channelId = bootstrap.channelId || bootstrap.channels?.[0]?.id || "default";
    }
    const requested = channelId;
    const query = `?channel=${encodeURIComponent(requested)}`;
    const meta = await api(`/console/api/broadcast/studio/meta${query}`);
    if (!stillCurrent(gen, routeGen, expectedHash) || channelId !== requested) return;
    const channels = meta.channels || [{ id: "default", name: "OA หลัก" }];
    if (!channels.some((channel) => channel.id === channelId)) {
      channelId = channels[0]?.id || "default";
      return renderBroadcast();
    }
    const data = await loadTabData(tab, meta, query);
    if (!stillCurrent(gen, routeGen, expectedHash) || channelId !== requested) return;
    const channelName = channels.find((channel) => channel.id === channelId)?.name || channelId;

    const channelChips = channels.length > 1
      ? el("nav", { class: "inbox-filters branch-filters bs-oa-chips", "aria-label": "เลือก LINE OA" },
          channels.map((channel) => el("button", {
            class: `fchip fchip-branch${channelId === channel.id ? " is-active" : ""}`, type: "button",
            "aria-pressed": channelId === channel.id ? "true" : "false",
            onclick: () => {
              if (channelId === channel.id) return;
              channelId = channel.id;
              renderBroadcast();
            },
          }, channel.name || channel.id)))
      : null;
    const tabs = el("nav", { class: "bs-tabs", role: "tablist", "aria-label": "ส่วนของบรอดแคสต์" },
      BROADCAST_TABS.map((entry) => el("a", {
        class: `bs-tab${entry.key === tab ? " is-active" : ""}`, href: entry.hash, role: "tab",
        "aria-selected": entry.key === tab ? "true" : "false",
      }, entry.label)));

    let content;
    if (tab === "results") {
      content = resultsTab.render({
        channelId,
        campaigns: data.campaigns?.campaigns || [],
        onTemplate: (template) => {
          store.applyTemplate(channelId, template);
          toast("นำผู้รับและข้อความมาเป็นแม่แบบแล้ว — ยังไม่ได้ส่ง");
          location.hash = "#/broadcast";
        },
        blocks: [
          data.quarantines ? quarantineReviewBlock({ api, toast, channelId, initial: data.quarantines }) : null,
          data.schedules ? scheduleListBlock({ api, toast, channelId, initial: data.schedules }) : null,
          permissionBlock({ api, toast, initial: data.permissions }),
        ],
      });
    } else if (tab === "steps") {
      content = await stepsTab.render({ meta, channelId, channelName });
      if (!stillCurrent(gen, routeGen, expectedHash) || channelId !== requested) return;
    } else {
      content = el("div", {},
        data.quarantines?.quarantines?.length
          ? quarantineReviewBlock({ api, toast, channelId, initial: data.quarantines })
          : null,
        createTab.render({
          meta, channelId, channelName,
          selfTestNode: meta.canTestSend === true
            ? selfTestBlock({ api, toast, channelId, canRegister: true, initial: data.selfTest })
            : null,
          onSent: ({ scheduled }) => {
            location.hash = scheduled ? "#/broadcast/results" : "#/broadcast/results";
          },
        }));
    }

    mount(
      pageHeader("บรอดแคสต์"),
      el("main", { class: "page-scroll", "data-scroll-key": `broadcast-${tab}` }, el("div", { class: "page-inner bs-page" },
        el("header", { class: "bs-hero" },
          el("div", { class: "bs-hero-copy" },
            el("p", { class: "bs-eyebrow" }, `LINE OA · ${channelName}`),
            el("h1", { class: "bs-title" }, tab === "steps" ? "ข้อความตามขั้น" : tab === "results" ? "ผลลัพธ์บรอดแคสต์" : "สร้างบรอดแคสต์"),
            el("p", { class: "bs-lede" }, tab === "steps"
              ? "ส่งข้อความตามลำดับอัตโนมัติเมื่อเพิ่มเพื่อน พิมพ์ # หรือติดป้าย — หยุดเองเมื่อลูกค้าซื้อ ขอหยุด หรือทีมเข้ามาคุย"
              : "ส่งถึงเพื่อนทุกคน กลุ่มเป้าหมายจาก OA Manager หรือคนที่คุยกับลูกแพรแล้วตามป้าย — ตรวจราคา โควตา และให้ยืนยันทุกครั้งก่อนส่ง")),
          channelChips),
        tabs,
        content,
      )),
      tabBar(),
    );
    setView("page");
  }

  return renderBroadcast;
}
