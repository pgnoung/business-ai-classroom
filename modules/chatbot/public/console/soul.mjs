// soul.mjs — หน้า "ตัวตนของ AI" (#/soul) อ่านอย่างเดียว (ขั้นที่ 2 ของแผน soul, 18 ต.ค. 2026)
// แสดงรุ่น soul ที่โปรเซสนี้ใช้จริง · hash · ข้อความที่แต่ละเส้นได้ · สัญญาส่วน C · ลำดับชั้นที่ชนะกัน
// ข้อมูลจาก GET /console/api/soul — ไม่มีปุ่มแก้ (การแก้พร้อมรุ่นและสิทธิ์ soul.publish เป็นงานขั้นที่ 4)
import { el, timeAgo } from "./dom.mjs";

const SOURCE_LABELS = Object.freeze({
  soul: { text: "จาก soul", className: "soul-src is-soul" },
  persona_file: { text: "ไฟล์ persona เดิม", className: "soul-src is-file" },
  chassis_default: { text: "ค่ากลางของระบบ", className: "soul-src is-default" },
});

function dateTime(value) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat("th-TH", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Bangkok" }).format(new Date(value));
  } catch {
    return "";
  }
}

function fact(label, value, hint = "") {
  return el("div", { class: "soul-fact" }, el("dt", {}, label), el("dd", {}, value || "—"), hint ? el("small", {}, hint) : null);
}

function versionBlock(info) {
  if (!info.installed) {
    return el("section", { class: "block soul-version is-missing" },
      el("h2", { class: "block-title" }, "ร้านนี้ยังไม่มี soul"),
      el("p", { class: "block-hint" }, "ระบบใช้ค่ากลางของ chassis ที่ไม่มีชื่อแบรนด์ และใช้ไฟล์ persona เดิมกับทักตาม ตั้ง SOUL_FILE ใน release เพื่อให้ตัวตนมาจากไฟล์เดียว"),
    );
  }
  const contract = info.contract || {};
  return el("section", { class: "block soul-version" },
    el("div", { class: "soul-version-head" },
      el("div", {},
        el("span", { class: "soul-eyebrow" }, "รุ่นที่ใช้ตอบลูกค้าอยู่ตอนนี้"),
        el("h2", {}, `${info.soulId || "soul"} · ${info.version || "ไม่ระบุรุ่น"}`),
        info.status ? el("p", { class: "block-hint" }, info.status) : null,
      ),
      el("span", { class: contract.ok ? "soul-contract is-ok" : "soul-contract is-bad" },
        contract.ok ? `สัญญาผ่าน ${contract.checked} ข้อ` : "สัญญาไม่ผ่าน"),
    ),
    el("dl", { class: "soul-facts" },
      fact("hash (sha256)", el("code", { title: info.sha256 }, `${String(info.sha256).slice(0, 12)}…`), "ข้อความขาออกทุกฟองที่ AI เขียนจดรุ่นนี้ไว้"),
      fact("ไฟล์", el("code", {}, info.fileName)),
      fact("ผู้อนุมัติ", info.approvedBy),
      fact("โหลดเข้าโปรเซสเมื่อ", info.loadedAt ? timeAgo(Date.parse(info.loadedAt)) : "", dateTime(info.loadedAt)),
      fact("เวลาเปิดใช้", info.activatedAt || "ไม่ได้ระบุในไฟล์ (นับจากเวลาสลับ release)"),
      fact("ตรวจด้วยคน", `${(contract.unchecked || []).length} ข้อ`, "ข้อในส่วน C ที่เครื่องตรวจเองไม่ได้"),
    ),
  );
}

const ROLLOUT_LABELS = Object.freeze({
  off: "ปิดอยู่ — ทุกห้องใช้รุ่นข้างบน",
  canary: "ทดลอง — ห้องใหม่บางส่วนได้รุ่นนี้",
  all: "เปิดทั้งหมด — ทุกห้องและทุกเส้นใช้รุ่นนี้",
});

// 20 ต.ค. 2026 (ขั้นที่ 3): release มีรุ่นทดลองมาด้วย — บอกว่าเปิดอยู่แค่ไหน (สวิตช์อยู่หน้าตั้งค่า → สวิตช์พฤติกรรม)
function candidateBlock(candidate, rollout) {
  if (!candidate) return null;
  const mode = rollout?.mode || "off";
  const contract = candidate.contract || {};
  return el("section", { class: "block soul-version soul-candidate" },
    el("div", { class: "soul-version-head" },
      el("div", {},
        el("span", { class: "soul-eyebrow" }, "รุ่นทดลองที่มากับ release นี้"),
        el("h2", {}, `${candidate.soulId || "soul"} · ${candidate.version || "ไม่ระบุรุ่น"}`),
        candidate.status ? el("p", { class: "block-hint" }, candidate.status) : null,
      ),
      el("span", { class: contract.ok ? "soul-contract is-ok" : "soul-contract is-bad" },
        contract.ok ? `สัญญาผ่าน ${contract.checked} ข้อ` : "สัญญาไม่ผ่าน"),
    ),
    el("dl", { class: "soul-facts" },
      fact("สถานะ", ROLLOUT_LABELS[mode] || mode, "เปลี่ยนได้ที่หน้าตั้งค่า → สวิตช์พฤติกรรม (เจ้าของเท่านั้น)"),
      mode === "canary" ? fact("สัดส่วนห้องใหม่", `${rollout.percent}%`, rollout.since ? `นับห้องที่เริ่มคุยตั้งแต่ ${dateTime(rollout.since)}` : "ยังไม่มีเวลาเริ่ม") : null,
      fact("hash (sha256)", el("code", { title: candidate.sha256 }, `${String(candidate.sha256).slice(0, 12)}…`)),
      fact("แก่น (ส่วน A)", `${Number(candidate.partAChars).toLocaleString("th-TH")} อักษร`),
    ),
  );
}

function layersBlock(layers = []) {
  return el("section", { class: "block soul-layers" },
    el("h2", { class: "block-title" }, "ลำดับชั้นที่ชนะกัน"),
    el("p", { class: "block-hint" }, "ชั้นบนชนะชั้นล่างเสมอ — soul ไม่ลบล้างด่านเงิน ตัวตน PDPA และการส่งต่อคนที่ล็อกในโค้ด"),
    el("ol", { class: "soul-layer-list" }, layers.map((layer) =>
      el("li", { class: layer.id === "soul" ? "is-soul" : "" },
        el("span", {}, layer.label),
        el("span", { class: layer.editable ? "soul-lock is-open" : "soul-lock" }, layer.editable ? "แก้ได้ในคอนโซล" : "อ่านอย่างเดียว"),
      ))),
  );
}

function pathSection(entry) {
  const source = SOURCE_LABELS[entry.source] || SOURCE_LABELS.chassis_default;
  return el("details", { class: "kb-sec soul-path" },
    el("summary", {},
      el("span", { class: "kb-sec-title" },
        el("code", { class: "soul-path-key" }, entry.path), " ", entry.label),
      el("span", { class: source.className }, source.text),
      el("span", { class: "kb-count" }, `${Number(entry.chars).toLocaleString("th-TH")} อักษร`),
    ),
    el("p", { class: "block-hint soul-path-hash" }, "sha256 ", el("code", { title: entry.sha256 }, `${String(entry.sha256).slice(0, 12)}…`)),
    entry.text
      ? el("pre", { class: "kb-pre soul-pre" }, entry.text)
      : el("p", { class: "kb-empty" }, entry.path === "legacy"
        ? "ว่าง — เครื่องเก่าใช้ persona ปกติ ไม่เปลี่ยนน้ำเสียงเมื่อเปิดสวิตช์"
        : "ว่าง"),
  );
}

function pathsBlock(paths = []) {
  return el("section", { class: "block kb-block soul-paths" },
    el("h2", { class: "block-title" }, "ข้อความที่แต่ละเส้นได้"),
    el("p", { class: "block-hint" }, "ข้อความเหล่านี้ไปถึงโมเดลตรงตัว ⟪ชั้นที่ล็อกในโค้ด⟫ คือส่วนที่ระบบเติมเอง เช่น รูปแบบคำตอบของเครื่อง v3"),
    paths.map(pathSection),
  );
}

function partBBlock(items = []) {
  return el("section", { class: "block soul-part-b" },
    el("h2", { class: "block-title" }, "คู่มือที่หยิบตามบริบท (ส่วน B)"),
    items.length
      ? el("ul", { class: "soul-b-list" }, items.map((item) =>
        el("li", {}, el("code", {}, item.id), ` · ${item.topics.join(", ") || "ไม่มีป้าย"} · ${item.chars} อักษร`)))
      : el("p", { class: "block-hint" }, "รุ่นนี้ยังไม่มีคู่มือแยก — การ์ดความรู้และตารางราคาที่อนุมัติทำหน้าที่นี้"),
  );
}

export function createSoulPage({ api, mount, pageHeader, tabBar, stopPolling, setView }) {
  let generation = 0;
  return async function renderSoul() {
    stopPolling();
    const mine = ++generation;
    let info;
    try {
      info = await api("/console/api/soul");
    } catch (error) {
      if (mine !== generation) return;
      mount(pageHeader("ตัวตนของ AI"), el("main", { class: "page-scroll" }, el("div", { class: "page-inner" },
        el("section", { class: "block" }, el("h2", { class: "block-title" }, "เปิดข้อมูลตัวตนไม่ได้"), el("p", { class: "block-hint" }, error.message)))), tabBar());
      setView("page");
      return;
    }
    if (mine !== generation) return;
    mount(
      pageHeader("ตัวตนของ AI"),
      el("main", { class: "page-scroll" },
        el("div", { class: "page-inner soul-page" },
          el("section", { class: "block soul-intro" },
            el("h2", { class: "block-title" }, "ตัวตนของ AI (soul)"),
            el("p", { class: "block-hint" }, "แหล่งเดียวของตัวตนและวิธีคุยที่ส่งให้โมเดลทุกเส้น — หน้านี้อ่านอย่างเดียว การแก้ต้องเล่นซ้ำแชทจริงและให้เจ้าของอนุมัติก่อนทุกครั้ง"),
          ),
          versionBlock(info),
          candidateBlock(info.candidate, info.rollout),
          layersBlock(info.layers),
          pathsBlock(info.paths),
          partBBlock(info.partB),
        ),
      ),
      tabBar(),
    );
    setView("page");
  };
}
