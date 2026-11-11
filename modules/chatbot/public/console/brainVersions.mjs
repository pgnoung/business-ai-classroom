// brainVersions.mjs — แผง "รุ่นสมองลูกแพร" (เฟส 1b)
//
// สิ่งที่แผงนี้ต้องตอบให้ได้ในหน้าจอเดียว โดยไม่ต้องให้ใครเปิด log:
//   1. ตอนนี้ลูกแพรใช้สมองรุ่นไหน ใครเปลี่ยนล่าสุด เมื่อไร ผลด่านเป็นอะไร
//   2. มีรุ่นทดลอง (canary) ค้างอยู่ไหม — ของที่ทีมงานเสนอแต่ยังไม่ถึงลูกค้า
//   3. รุ่นที่ใช้อยู่มีข้อค้างอะไรบ้าง (ผลตรวจ) — "หนี้ความรู้" ที่ยังไม่ได้เก็บ
//   4. ถอยกลับได้ในกี่แตะ
//
// ปุ่มทั้งหมดเป็นของเจ้าของ (brain.publish) เท่านั้น — ด่านจริงอยู่ฝั่งเซิร์ฟเวอร์ ที่นี่แค่
// ไม่วาดปุ่มที่กดแล้วเด้ง 403 (กติกาเดียวกับ publishQueue.mjs)
import { el, timeAgo } from "./dom.mjs";
import { failingCasesBlock } from "./evalFailures.mjs";

export const BRAIN_VERSION_LIST_MAX = 10;

const STATUS_META = {
  live: { label: "ใช้งานจริง", tone: "badge-green" },
  canary: { label: "ทดลอง", tone: "badge-orange" },
  proposed: { label: "รอรับทราบ", tone: "badge-orange" },
  validated: { label: "ผ่านด่านแล้ว", tone: "badge-gray" },
  retired: { label: "รุ่นก่อน", tone: "badge-gray" },
  // รุ่นที่เคยเป็น canary แล้วถูกรุ่นทดลองใบใหม่แทนที่ — สถานะในฐานยังเป็น canary แต่ไม่มี
  // pointer แล้ว ถ้าแสดงว่า "ทดลอง" เฉย ๆ คนจะรอผลของรุ่นที่ไม่มีใครได้รับอีกแล้ว
  canary_retired: { label: "รุ่นทดลองที่ถูกแทนที่", tone: "badge-gray" },
  rolled_back: { label: "ถูกย้อนออก", tone: "badge-gray" },
  draft: { label: "ร่าง", tone: "badge-gray" },
  rejected: { label: "ปัดตก", tone: "badge-gray" },
  failed: { label: "ล้มเหลว", tone: "badge-red" },
  checking: { label: "กำลังตรวจ", tone: "badge-gray" },
};

const VERDICT_LABEL = {
  pass: "ด่านผ่านครบ",
  needs_ack: "มีข้อที่ต้องรับทราบ",
  block: "ด่านไม่ผ่าน",
  error: "เครื่องมือตรวจเสีย",
};

export function versionTitle(version) {
  return `รุ่น ${version.seq}${version.label ? ` · ${version.label}` : ""}`;
}

// บรรทัดเดียวที่บอก "ใคร เมื่อไร ผลด่านอะไร" — ป้ายที่อ่านแล้วไม่ต้องเดาต่อ
export function versionMeta(version, now = Date.now()) {
  const parts = [`โดย ${version.createdBy || "—"}`, timeAgo(version.publishedAt || version.createdAt, now)];
  if (version.verdict) parts.push(VERDICT_LABEL[version.verdict] || version.verdict);
  if (version.ackCount) parts.push(`รับทราบแล้ว ${version.ackCount} ครั้ง`);
  return parts.filter(Boolean).join(" · ");
}

function findingList(findings, emptyText) {
  if (!findings.length) return el("p", { class: "kb-empty" }, emptyText);
  return el("ul", { class: "kn-list bv-findings" },
    findings.map((finding) => el("li", { class: "kn-meta bv-finding" },
      el("span", { class: `badge ${finding.severity === "block" ? "badge-red" : "badge-gray"}` },
        finding.severity === "block" ? "ต้องแก้" : "เตือน"),
      ` ${finding.code} · ${finding.message}`,
    )),
  );
}

export function versionStatusKey(version) {
  if (version.pointer) return version.pointer;
  return version.status === "canary" ? "canary_retired" : version.status;
}

function versionCard(version, { api, toast, refresh, canManage, live, canaryWarnings = [] }) {
  const meta = STATUS_META[versionStatusKey(version)] || { label: version.status, tone: "badge-gray" };

  async function act(action, confirmText, body = {}) {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      const result = await api(`/console/api/brain/versions/${encodeURIComponent(version.versionId)}/${action}`, {
        method: "POST", body,
      });
      toast(result?.applied !== true ? "ทำรายการไม่สำเร็จ"
        : action === "discard" ? `ปัดตกรุ่น ${version.seq} แล้ว`
          : result.pointer === "canary"
            ? `รับทราบแล้ว — รุ่น ${version.seq} ขึ้นเป็นรุ่นทดลอง (ยังไม่ถึงลูกค้าทุกคน)`
            : `ใช้งานรุ่น ${version.seq} แล้ว — คลังความรู้ ราคา และกติกากลับมาตรงกับรุ่นนี้ทันที`);
      await refresh();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  const actions = [];
  if (canManage && version.pointer === "canary") {
    actions.push(el("button", {
      class: "btn btn-primary btn-mini",
      onclick: () => act("promote",
        `ใช้รุ่นทดลอง ${version.seq} กับลูกค้าทุกคน?`
        + (canaryWarnings.length ? `\n\nข้อที่ยังค้างในรุ่นนี้:\n${canaryWarnings.slice(0, 8).join("\n")}` : "")),
    }, "ใช้ทั้งหมดเลย"));
  }
  if (canManage && version.status === "proposed") {
    actions.push(el("button", {
      class: "btn btn-primary btn-mini",
      onclick: () => act("ack", `รับทราบข้อค้างของรุ่น ${version.seq} แล้วใช้งานเลย?`),
    }, "รับทราบและใช้งาน"));
  }
  // ปัดตกได้เฉพาะรุ่นที่ค้าง — และต้องมี เพราะรุ่นค้างหนึ่งใบกันไม่ให้ทีมงานส่งใบถัดไปได้
  if (canManage && (version.pointer === "canary" || version.status === "proposed")) {
    actions.push(el("button", {
      class: "btn btn-outline btn-mini",
      onclick: () => act("discard", `ปัดตกรุ่น ${version.seq}? ของในรุ่นนี้จะไม่ถูกใช้ และคนที่เสนอต้องส่งใหม่`),
    }, "ปัดตก"));
  }
  // ย้อนกลับได้เฉพาะรุ่นที่เคยถูกใช้จริงมาก่อน (เซิร์ฟเวอร์กันอีกชั้น)
  // ไปข้างหน้าก็ได้ ไม่ใช่แค่ถอยหลัง: รุ่นที่ผ่านด่านแล้วและไม่ได้ถูกปัดตก เอามาใช้ได้ทั้งคู่
  // (เซิร์ฟเวอร์เดินด่านกับรุ่นเป้าหมายซ้ำอีกครั้งก่อนใช้จริง — รุ่นเก่าอาจไม่ผ่านแล้ววันนี้)
  if (canManage && !version.pointer && ["retired", "rolled_back", "validated"].includes(version.status)
    && live && version.seq !== live.seq) {
    actions.push(el("button", {
      class: "btn btn-outline btn-mini",
      onclick: async () => {
        // ให้เห็นก่อนกดว่าอะไรจะเปลี่ยนจริง — ปุ่มที่เปลี่ยนคลังความรู้ทั้งก้อนโดยไม่บอกว่า
        // เปลี่ยนอะไร คือปุ่มที่คนกดด้วยความหวัง ไม่ใช่ด้วยความเข้าใจ
        const diff = await api(`/console/api/brain/versions/${encodeURIComponent(version.versionId)}/diff`)
          .then((data) => data?.diff ?? null).catch(() => null);
        const lines = diff
          ? [...diff.prices, ...diff.rounds, ...diff.knowledge].slice(0, 12).join("\n")
          : "(ดูรายละเอียดไม่ได้)";
        const note = diff?.note ? `\n\n${diff.note}` : "";
        await act("rollback",
          `ใช้สมองรุ่น ${version.seq} แทนรุ่นที่ใช้อยู่?\n\nสิ่งที่จะเปลี่ยน:\n${lines || "(ไม่มีความต่างที่สรุปได้)"}${note}`);
      },
    }, "ใช้รุ่นนี้แทน"));
  }

  return el("article", { class: "kn-card bv-card" },
    el("div", { class: "kn-head" },
      el("strong", { class: "kn-name" }, versionTitle(version)),
      el("span", { class: `badge ${meta.tone}` }, meta.label),
    ),
    el("p", { class: "kn-meta bv-meta" }, versionMeta(version)),
    // ข้อค้างของรุ่นที่รอรับทราบ ต้องอยู่ในการ์ดเดียวกับปุ่ม "รับทราบ" — ไม่ใช่ให้กดตาบอด
    version.status === "proposed" && (version.findings || []).length
      ? el("details", { class: "bv-detail" },
        el("summary", {}, `ข้อค้างที่ต้องรับทราบ (${version.findings.length})`),
        findingList(version.findings, "ไม่มีข้อค้าง"),
      )
      : null,
    actions.length ? el("div", { class: "block-actions bv-actions" }, actions) : null,
  );
}

/**
 * คืน null = ไม่ต้องวาด (แฟล็กปิด หรือยังไม่เคยมีรุ่นสมองเลย — ไม่ต้องมีกล่องว่างเกะกะ)
 *
 * `data` มาจากผู้เรียก (โหลดพร้อมเส้นอื่นใน Promise.all) ไม่ยิงเองอีกเส้น — หน้าตั้งค่า
 * โหลดช้าขึ้นหนึ่งรอบเต็ม ๆ เพื่อกล่องที่บางวันไม่ได้วาดเลย ไม่คุ้ม
 */
export function brainVersionsBlock({ data, failing = null, api, toast, refresh }) {
  // แฟล็กปิด = ปุ่มทุกปุ่มในแผงนี้ตอบ 409 อยู่แล้ว ห้ามวาดปุ่มที่กดแล้วไม่มีอะไรเกิดขึ้น
  if (!data || data.enabled !== true) return null;
  if (!Array.isArray(data.versions) || data.versions.length === 0) return null;

  const versions = data.versions.slice(0, BRAIN_VERSION_LIST_MAX);
  const live = versions.find((row) => row.pointer === "live") ?? null;
  const canary = versions.find((row) => row.pointer === "canary") ?? null;
  const canManage = data.canManage === true;
  const liveFindings = Array.isArray(data.findings?.live) ? data.findings.live : [];
  const canaryFindings = Array.isArray(data.findings?.canary) ? data.findings.canary : [];
  const delegation = data.delegation ?? null;

  return el("section", { class: "block bv-block" },
    el("h2", { class: "block-title" },
      "รุ่นสมองลูกแพร",
      Number(data.pending) > 0
        ? el("span", { class: "badge badge-orange bv-count" }, `มีรุ่นค้าง ${data.pending}`)
        : null,
    ),
    el("p", { class: "block-hint" },
      live
        ? `ตอนนี้ลูกแพรใช้สมองรุ่น ${live.seq} · ${versionMeta(live)}`
        : "ยังไม่มีรุ่นไหนถูกตั้งเป็นรุ่นใช้งานจริง"),
    delegation?.active
      ? el("p", { class: "block-hint bv-delegation" },
        `ทีมงานเผยแพร่เองได้ถึงรุ่นทดลองเท่านั้น (หมดอายุ ${new Date(delegation.expiresAt).toLocaleDateString("th-TH")})`)
      : null,

    el("details", { class: "bv-detail" },
      el("summary", {}, `ผลตรวจของรุ่นที่ใช้อยู่ (${liveFindings.length})`),
      el("p", { class: "block-hint" },
        "ข้อที่ยังค้างในสมองรุ่นนี้ — “เตือน” คือหนี้ความรู้ที่ยกมาจากของเดิม ค่อยเก็บได้"
        + " ส่วน “ต้องแก้” คือของที่จะบล็อกการเผยแพร่ครั้งถัดไปที่ไปแตะมัน"),
      findingList(liveFindings, "ไม่มีข้อค้าง"),
    ),
    canary
      ? el("details", { class: "bv-detail" },
        el("summary", {}, `ผลตรวจของรุ่นทดลอง (${canaryFindings.length})`),
        findingList(canaryFindings, "ไม่มีข้อค้าง"),
      )
      : null,
    // เฟส 3: "บทสนทนาไหนจะพัง" — อยู่ในแผงเดียวกับรุ่นสมอง ไม่ใช่หน้าใหม่
    // เพราะคำถาม "รุ่นนี้ปลอดภัยไหม" กับ "ห้องไหนจะพัง" เป็นคำถามเดียวกัน
    failingCasesBlock(failing, { api, toast, refresh }),

    el("div", { class: "kn-list bv-list" },
      versions.map((version) => versionCard(version, {
        api, toast, refresh, canManage, live,
        canaryWarnings: canaryFindings.map((finding) => `${finding.code} · ${finding.message}`),
      }))),
  );
}
