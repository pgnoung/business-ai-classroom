// evalFailures.mjs — "บทสนทนาไหนจะพัง" ในแผงรุ่นสมอง (เฟส 3)
//
// ปัญหาที่แผงนี้แก้: เดิมเวลาด่านบล็อกการเผยแพร่ คนกดเห็นแค่ข้อความสั้น ๆ กับรหัสเคส
// ("probe-price-01") ซึ่งไม่ได้บอกอะไรเลยว่าลูกค้าคนไหนจะได้คำตอบผิด และผิดยังไง
// ผลคือคนกดเรียนรู้ที่จะกดข้ามด่าน — ซึ่งทำให้ด่านทั้งชุดหมดความหมาย
//
// ที่นี่แสดงสามอย่างต่อบทสนทนา ภาษาไทยล้วน: ลูกค้าพูดอะไร · ลูกแพรตอบไว้ว่าอะไร ·
// ผิดกฎข้อไหน (แปลเป็นประโยค ไม่ใช่ชื่อกฎ) แล้วจึงมีปุ่มของเจ้าของ
//
// 375 px: การ์ดเป็นคอลัมน์เดียว ปุ่มเต็มความกว้าง ไม่มีตารางแนวนอน ไม่มีอะไรต้องเลื่อนข้าง
import { el } from "./dom.mjs";

const SEVERITY_LABEL = {
  irreversible: { text: "พังแล้วกู้ไม่ได้", tone: "badge-red" },
  lead: { text: "เสียโอกาสขาย", tone: "badge-orange" },
  style: { text: "สำนวน", tone: "badge-gray" },
};

function severityBadge(severity) {
  const meta = SEVERITY_LABEL[severity] ?? SEVERITY_LABEL.style;
  return el("span", { class: `badge ${meta.tone}` }, meta.text);
}

/** รายละเอียดหนึ่งเทิร์น: ลูกค้าพูดอะไร ลูกแพรตอบว่าอะไร เกณฑ์ที่ใช้ตัดสินคืออะไร */
function turnBlock(turn) {
  return el("div", { class: "ef-turn" },
    el("p", { class: "kn-meta ef-said" },
      el("strong", {}, "ลูกค้า: "),
      turn.customerSaid ?? "(ห้องนี้ถูกลบตามคำขอของลูกค้าแล้ว — อ่านข้อความไม่ได้)"),
    turn.lukpraeAnswered
      ? el("p", { class: "kn-meta ef-said" }, el("strong", {}, "ลูกแพรเคยตอบ: "), turn.lukpraeAnswered)
      : el("p", { class: "kn-meta ef-said" }, "ยังไม่เคยบันทึกคำตอบของเทิร์นนี้ไว้ — ด่านจึงตรวจได้แค่เส้นทาง"),
    turn.expectations.length
      ? el("ul", { class: "kn-list ef-expects" },
        turn.expectations.map((line) => el("li", { class: "kn-meta" }, line)))
      : null,
  );
}

/**
 * การ์ดของบทสนทนาหนึ่งเคส
 * @param {object} row      ผลจาก /console/api/eval/cases
 * @param {string[]} broke  ประโยคไทยที่บอกว่าพังข้อไหน (จาก finding ของด่าน)
 */
export function failingCaseCard(row, { broke = [], canRetire = false, api, toast, refresh } = {}) {
  async function act(action, body = {}) {
    try {
      const result = await api(`/console/api/eval/cases/${encodeURIComponent(row.caseId)}/${action}`, { method: "POST", body });
      toast(result?.applied
        ? (action === "retire" ? "ปิดเกณฑ์นี้แล้ว และเปิดงานให้ช่างเขียนเคสใหม่" : "เปิดเกณฑ์นี้กลับแล้ว")
        : "ทำรายการไม่สำเร็จ");
      await refresh?.();
    } catch (err) {
      toast(err.message, "error");
    }
  }

  const actions = [];
  if (canRetire && !row.retired) {
    actions.push(el("button", {
      class: "btn btn-outline btn-mini",
      onclick: () => {
        const reason = window.prompt(
          `เกณฑ์ของบทสนทนา “${row.title}” ล้าสมัยยังไงคะ?\n\n`
          + "เขียนสั้น ๆ ก็ได้ แต่ต้องเขียน — เหตุผลนี้จะกลายเป็นงานให้ช่างเขียนเคสใหม่มาแทน\n"
          + (row.blocksEvenWhenRetired
            ? "\n⚠ บทสนทนานี้เป็นเรื่องที่พังแล้วกู้ไม่ได้ ปิดแล้วมันจะยังบล็อกการเผยแพร่อยู่"
            : ""),
        );
        if (reason && reason.trim().length >= 8) act("retire", { reason: reason.trim() });
        else if (reason !== null) toast("ต้องเขียนเหตุผลอย่างน้อย 8 ตัวอักษร", "error");
      },
    }, "เกณฑ์นี้ล้าสมัย → ปิดเคสนี้"));
  }
  if (canRetire && row.retired) {
    actions.push(el("button", { class: "btn btn-outline btn-mini", onclick: () => act("restore") }, "เปิดเคสนี้กลับ"));
  }

  return el("article", { class: "kn-card ef-card" },
    el("div", { class: "kn-head" },
      el("strong", { class: "kn-name" }, row.title),
      severityBadge(row.severity),
    ),
    broke.length
      ? el("ul", { class: "kn-list ef-broke" }, broke.map((line) => el("li", { class: "kn-meta ef-break" }, line)))
      : null,
    row.retired
      ? el("p", { class: "kn-meta ef-retired" },
        `ปิดไว้โดย ${row.retired.by} — “${row.retired.reason}”`
        + (row.blocksEvenWhenRetired ? " · แต่ยังบล็อกอยู่เพราะเป็นเรื่องที่พังแล้วกู้ไม่ได้" : ""))
      : null,
    el("details", { class: "ef-detail" },
      el("summary", {}, "ดูบทสนทนาและเกณฑ์ที่ใช้ตัดสิน"),
      ...row.turns.map(turnBlock),
    ),
    actions.length ? el("div", { class: "block-actions ef-actions" }, actions) : null,
  );
}

/**
 * แผงย่อยในการ์ดรุ่นสมอง — คืน null เมื่อไม่มีอะไรต้องบอก (ไม่ต้องมีกล่องว่างเกะกะ)
 * @param {{enabled: boolean, reason?: string, cases: object[], canRetire?: boolean}} data
 */
// "ด่านนี้ดูให้เรื่องอะไร และเชื่อหลักฐานเก่าแค่ไหน" — ต้องอยู่ข้างผลเสมอ
// เพราะคำว่า "ผ่าน" ที่ไม่บอกขอบเขต คือคำที่ทำให้คนเลิกอ่านผลตรวจ
function scopeNote(data) {
  const parts = [];
  // "ตรวจได้กี่เทิร์นจากกี่เทิร์น" ต้องมาก่อนเสมอ — ถ้าไม่บอก คำว่า "ผ่านหมด" จะถูกอ่านว่า
  // "ทุกอย่างเรียบร้อย" ทั้งที่อาจแปลว่า "ไม่มีอะไรให้ตรวจเลย" (สองอย่างนี้ต่างกันสิ้นเชิง)
  const s = data.summary ?? {};
  if (Number(s.selectedTurns) > 0) {
    parts.push(`ตรวจได้ ${Number(s.checkedTurns) || 0} จาก ${Number(s.selectedTurns)} เทิร์นที่เกี่ยวข้อง`);
  }
  if (data.judged?.length) parts.push(`ด่านนี้ตัดสินให้เฉพาะเรื่องราคาและคำต้องห้าม (${data.judged.length} กฎ)`);
  if (data.outOfScope?.length) parts.push(`อีก ${data.outOfScope.length} เรื่องเป็นข้อความ/เส้นทาง ซึ่งด่านนี้ตัดสินแทนไม่ได้`);
  if (data.evidenceNewestAt) {
    const days = Math.round((Date.now() - data.evidenceNewestAt) / 86_400_000);
    parts.push(`คำตอบที่ใช้เล่นซ้ำบันทึกไว้ล่าสุด ${days} วันก่อน`);
  }
  return parts.length ? el("p", { class: "block-hint ef-scope" }, parts.join(" · ")) : null;
}

export function failingCasesBlock(data, { api, toast, refresh, details = new Map() } = {}) {
  if (!data || data.enabled !== true) return null;
  if (!data.cases?.length) {
    // "ไม่มีอะไรให้ตรวจ" กับ "ตรวจแล้วผ่าน" คนละเรื่อง — ห้ามแสดงเหมือนกัน
    // "ตรวจแล้วผ่าน" พูดได้ก็ต่อเมื่อตรวจไปแล้วจริง ๆ อย่างน้อยหนึ่งเทิร์น
    const checked = Number(data.summary?.checkedTurns) || 0;
    return el("div", { class: "ef-block" },
      data.reason
        ? el("p", { class: "block-hint ef-none" }, `ด่านเล่นซ้ำ: ${data.reason}`)
        : el("p", { class: "block-hint ef-none" }, checked > 0
          ? `ด่านเล่นซ้ำ: บทสนทนาที่ตรวจได้ผ่านหมด (${checked} เทิร์น)`
          : "ด่านเล่นซ้ำ: ยังไม่ได้ตรวจอะไรเลย — ยังบอกไม่ได้ว่าปลอดภัย"),
      scopeNote(data),
    );
  }
  return el("details", { class: "bv-detail ef-block" },
    el("summary", {}, `บทสนทนาที่จะพัง (${data.cases.length})`),
    el("p", { class: "block-hint" },
      "รายการนี้คือห้องที่ลูกแพรเคยตอบไว้แล้ว และคำตอบเดิมจะผิดกฎถ้าใช้สมองรุ่นนี้"
      + " — กดดูได้ว่าลูกค้าถามอะไรและลูกแพรตอบว่าอะไร"),
    scopeNote(data),
    el("div", { class: "kn-list ef-list" },
      data.cases.map((row) => failingCaseCard(
        // เซิร์ฟเวอร์แนบรายละเอียดมาแล้ว — `details` เป็นทางลัดสำหรับเทสต์เท่านั้น
        details.get(row.caseId) ?? {
          turns: [], retired: null, blocksEvenWhenRetired: row.severity === "irreversible", ...row,
        },
        { broke: row.broke ?? [], canRetire: data.canRetire === true, api, toast, refresh },
      ))),
  );
}
