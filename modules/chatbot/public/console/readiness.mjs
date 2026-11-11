import { el } from "./dom.mjs";

const yesNo = (value, yes = "พร้อม", no = "ยังไม่ยืนยัน") => value === true ? yes : value === false ? no : "ไม่มีข้อมูล";
const count = (value) => Number.isFinite(Number(value)) ? String(Number(value)) : "—";
const DEBT_CODE_LABELS = Object.freeze({ L02: "จำนวนเงินต้องตรวจ", L03: "รอบเรียนเก่าต้องตรวจ", L15: "ข้อมูลส่วนบุคคลต้องตรวจ", G4: "กติกาเรื่องเงินต้องตรวจ" });
const NATIVE_BACKUP_STATUS = Object.freeze({ schema_unverified: "รูปแบบไฟล์ยังไม่ยืนยัน" });
const NATIVE_TAG_STATUS = Object.freeze({ not_available: "ยังไม่มีช่องทางซิงก์แท็กรายห้องจาก LINE" });

function metric(label, value, hint = "") {
  return el("div", { class: "readiness-metric" }, el("dt", {}, label), el("dd", {}, value), hint ? el("small", {}, hint) : null);
}

function brainBlock(response = {}) {
  const data = response.readiness || {};
  const flags = data.flags || {};
  const live = data.live || {};
  const parity = data.parity || {};
  const debt = data.debt || {};
  const byCode = debt.countsByCode || {};
  const blockerCount = data.selfEdit?.blockingCount || 0;
  const debtRows = Object.entries(byCode).filter(([, value]) => Number(value) > 0);
  return el("section", { class: "block readiness-block" },
    el("h2", { class: "block-title" }, "ความพร้อมสมอง"),
    el("p", { class: "block-hint" }, "เป็นข้อมูลสถานะและข้อเสนอรอเจ้าของตรวจเท่านั้น ไม่ได้เปิดใช้ตอบลูกค้า หรือเปลี่ยนความรู้"),
    el("dl", { class: "readiness-grid" },
      metric("โหมดอ่านสมองที่ตั้งค่า", flags.brainRead === "versioned" ? "ใช้คลังแบบมีรุ่น" : "ยังใช้โหมดเดิม"),
      metric("คลังแบบมีรุ่น", yesNo(flags.knowledgeVersioned, "เปิด", "ยังไม่เปิด")),
      metric("รุ่นสมองที่เตรียมไว้", live.exists === false ? "ยังไม่มีรุ่น" : `ลำดับ ${count(live.seq)}`),
      metric("ข้อมูลตรงกับรุ่นที่ใช้อยู่", yesNo(parity.ok)),
      metric("ผ่านต่อเนื่อง", `${count(parity.streakDays)} วัน`),
      metric("ประเด็นที่ติดด่านเมื่อแก้ข้อมูลเดิม", `${count(blockerCount)} รายการ`),
    ),
    el("div", { class: "readiness-debt" },
      el("strong", {}, `ประเด็นสืบทอดที่ยังรอเจ้าของตรวจ ${debt.pending ? debtRows.reduce((total, [, value]) => total + Number(value), 0) : 0} รายการ`),
      el("p", { class: "block-hint" }, "จำนวนนี้ไม่ใช่จำนวนลูกค้าที่มีปัญหา ข้อเสนอใหม่ที่สะอาดยังต้องผ่านการตรวจและอนุมัติของเจ้าของ"),
      debtRows.length ? el("ul", { class: "readiness-code-list" }, debtRows.map(([code, value]) => el("li", {}, `${DEBT_CODE_LABELS[code] || "ประเด็นต้องตรวจ"} (${code}): ${count(value)}`))) : null,
    ),
  );
}

function lineBlock(data = {}) {
  const rows = Array.isArray(data.channels) ? data.channels : [];
  return el("section", { class: "block readiness-block" },
    el("h2", { class: "block-title" }, "LINE OA"),
    el("p", { class: "block-hint" }, "สถานะนี้บอกสิ่งที่ระบบตั้งค่าและสิ่งที่ยังไม่มีหลักฐานจากผู้ให้บริการ แยกจากกันชัดเจน"),
    rows.length ? el("div", { class: "readiness-channel-list" }, rows.map((channel) => {
      return el("article", { class: "readiness-channel" },
        el("strong", {}, channel.label || channel.id || "LINE OA"),
        el("dl", { class: "readiness-grid is-compact" },
          metric("รับข้อความเข้า", yesNo(channel.webhook?.configured, "ตั้งค่าแล้ว", "ยังไม่ตั้งค่า")),
          metric("ผู้ให้บริการยืนยัน", channel.webhook?.provenConnected === true ? "ยืนยันแล้ว" : "ยังไม่ยืนยันจากผู้ให้บริการ"),
          metric("คำตอบจาก OA Manager", channel.managerDirect?.observed === true ? "พบหลักฐาน" : "ยังไม่พบหลักฐาน"),
          metric("Q&A ที่ทีมคัด", channel.curatedQa?.enabled === true ? "ใช้ได้จากหน้ารับข้อมูล" : "ยังไม่พร้อม"),
          metric("ไฟล์สำรองจาก LINE OA", NATIVE_BACKUP_STATUS[channel.nativeBackup?.status] || "สถานะยังไม่ยืนยัน"),
          metric("แท็กรายห้องจาก LINE OA", NATIVE_TAG_STATUS[channel.nativePerChatTags?.status] || "สถานะยังไม่ยืนยัน"),
        ),
        channel.nativeBackup?.message ? el("p", { class: "block-hint" }, channel.nativeBackup.message) : null,
        channel.nativePerChatTags?.message ? el("p", { class: "block-hint" }, channel.nativePerChatTags.message) : null,
      );
    })) : el("p", { class: "block-hint" }, "ยังไม่มีรายการ LINE OA ที่ตั้งค่าไว้"),
    data.roomNote?.href ? el("p", { class: "block-hint" }, el("a", { href: data.roomNote.href }, "ดูห้องแชทเพื่อบันทึกสรุปส่งต่อ"), " — ", data.roomNote.message) : null,
    data.localTagSafety?.message ? el("p", { class: "block-hint" }, data.localTagSafety.message) : null,
    rows.some((channel) => channel.curatedQa?.enabled === true)
      ? el("a", { class: "btn btn-outline", href: rows.find((channel) => channel.curatedQa?.enabled === true)?.curatedQa?.href || "#/teach-intake" }, "ไปหน้ารับ Q&A ที่ทีมคัด") : null,
  );
}

export function createReadinessPage({ api, mount, pageHeader, tabBar, stopPolling, setView }) {
  let renderGeneration = 0;
  async function render() {
    stopPolling();
    const generation = ++renderGeneration;
    const expectedHash = location.hash || "#/readiness";
    const stillCurrent = () => generation === renderGeneration && (location.hash || "#/readiness") === expectedHash;
    let brain; let line;
    try {
      [brain, line] = await Promise.all([api("/console/api/brain/readiness"), api("/console/api/line-oa/status")]);
    } catch (error) {
      if (!stillCurrent()) return;
      mount(pageHeader("ความพร้อมสมองและ LINE OA"), el("main", { class: "page-scroll" }, el("div", { class: "page-inner" },
        el("section", { class: "block" }, el("h2", { class: "block-title" }, "ยังเปิดข้อมูลความพร้อมไม่ได้"), el("p", { class: "block-hint" }, error.message)))), tabBar());
      setView("page");
      return;
    }
    if (!stillCurrent()) return;
    const refresh = el("button", { class: "btn btn-outline", type: "button", onclick: () => render() }, "รีเฟรชข้อมูล");
    mount(pageHeader("ความพร้อมสมองและ LINE OA"), el("main", { class: "page-scroll" }, el("div", { class: "page-inner readiness-page" },
      el("section", { class: "block readiness-intro" }, el("h2", { class: "block-title" }, "ความพร้อมสมองและ LINE OA"),
        el("p", { class: "block-hint" }, "อ่านสถานะล่าสุดเพื่อช่วยตัดสินใจ หน้านี้ไม่เปิดใช้ระบบ ไม่เผยแพร่ และไม่ส่งข้อความ"), refresh),
      brainBlock(brain), lineBlock(line),
    )), tabBar());
    setView("page");
  }
  return render;
}
