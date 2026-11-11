// knowledge.mjs — หน้า "คลังความรู้" (#/knowledge): สมองของ AI ทั้งใบ โปร่งใสให้เจ้าของเห็น
// ส่วนแก้ได้: ความรู้ที่ทีมเพิ่ม (knowledge_entries) — เพิ่ม/แก้/ปิด/ลบ
// G6 (P1): มีสาขาที่เปิด "สมองแยก" = แถว chip เลือก scope (สมองกลาง | สาขาที่แยก) —
// รายการ + ฟอร์มเพิ่ม ทำงานใน scope ที่เลือก; สาขาโหมด shared อ่านสมองกลางเท่านั้น
// ส่วน READ-ONLY (GET /console/api/brain): Brand Pack, ลิงก์ไปหน้าตัวตน (#/soul), ตารางราคา approve,
// รูปที่ส่งได้ (พร้อม thumbnail), กฎความปลอดภัยเฉพาะธุรกิจ, สถานะโมเดล + token ที่ inject
// หน้านี้ไม่ poll — operator กำลังพิมพ์เนื้อหา ห้าม re-render ทับ
import { el, isGeneric, timeAgo } from "./dom.mjs";
import { switchDot } from "./ui.mjs";
import { publishLabel, publishQueueHint, publishToast } from "./publishQueue.mjs";
import { createReviewsSection } from "./reviews.mjs";
import { photoStudioCard } from "./photoEditor.mjs";

const CONTENT_MAX = 20000;

export function createKnowledgePage({ api, toast, mount, pageHeader, tabBar, stopPolling, setView, state }) {
  // G6: scope ที่กำลังดู — null = สมองกลาง / channel id = สมองแยกของสาขานั้น
  let scope = null;
  // Package K (คำสั่งพี่ง้วง 2 ก.ย. 2026): คลังความรู้ต่อตรงเข้า system prompt ระดับ
  // เดียวกับกติกาสินค้า การ "เปลี่ยน" จึงเป็นของเจ้าของ ส่วนทีมงานเสนอได้ตามปกติ
  // แล้วเซิร์ฟเวอร์เก็บเป็นคำขอรออนุมัติ (202) — อ่านยังเปิดให้ทุกบทบาทเหมือนเดิม
  const canPublish = () => state?.me?.capabilities?.includes("knowledge.publish") === true;

  /* ------------------------------ ฟอร์มเพิ่มความรู้ ------------------------------ */

  function metadataControls(status, initial = null) {
    if (!status?.ready) {
      return status?.enabled
        ? { node: el("p", { class: "block-hint kn-metadata-status" }, status.message || "ยังใช้การเลือกความรู้ตามเรื่องไม่ได้") }
        : null;
    }
    const metadata = initial || { mode: "pin", domain: "", offering: "", keywords: [] };
    const modeInput = el("select", { class: "kn-metadata-mode keep-focus", "aria-label": "วิธีใช้ความรู้นี้" },
      el("option", { value: "pin" }, "ใช้เป็นความรู้พื้นฐาน"),
      el("option", { value: "retrieve" }, "ใช้เมื่อถามเรื่องนี้"),
    );
    modeInput.value = metadata.mode === "retrieve" ? "retrieve" : "pin";
    const domainInput = el("input", { class: "kn-metadata-domain keep-focus", type: "text", maxlength: "64", value: metadata.domain || "", placeholder: "หมวด เช่น การตลาด LINE" });
    const offeringInput = el("input", { class: "kn-metadata-offering keep-focus", type: "text", maxlength: "64", value: metadata.offering || "", placeholder: "คลาส/บริการ เช่น LINE สำหรับมือใหม่" });
    const keywordsInput = el("input", { class: "kn-metadata-keywords keep-focus", type: "text", maxlength: "1619", value: (metadata.keywords || []).join(", "), placeholder: "คำที่ช่วยค้นเจอ คั่นด้วยจุลภาค" });
    return {
      node: el("fieldset", { class: "kn-metadata" },
        el("legend", {}, "เลือกเวลาที่ใช้ความรู้นี้ (ไม่บังคับ)"),
        modeInput,
        domainInput,
        offeringInput,
        keywordsInput,
        el("p", { class: "block-hint" }, "ถ้าเลือกใช้เมื่อถามเรื่องนี้ ต้องใส่คำที่ช่วยค้นเจออย่างน้อย 1 คำ"),
        status?.corpusCapChars ? el("p", { class: "block-hint" }, `คลังความรู้ทั้งหมดยังรวมได้ไม่เกิน ${Number(status.corpusCapChars).toLocaleString("th-TH")} ตัวอักษร`
          + (status.reviewCatalogCapChars ? ` (ไม่นับคลังรีวิว ซึ่งมีงบแยก ${Number(status.reviewCatalogCapChars).toLocaleString("th-TH")} ตัวอักษร)` : "")) : null,
      ),
      value: () => ({
        mode: modeInput.value,
        domain: domainInput.value,
        offering: offeringInput.value,
        keywords: keywordsInput.value.split(",").map((value) => value.trim()).filter(Boolean),
      }),
    };
  }

  function metadataPreview(metadata) {
    if (!metadata) return null;
    const scope = metadata.mode === "retrieve" ? "ใช้เมื่อถามเรื่องนี้" : "ความรู้พื้นฐาน";
    const labels = [metadata.domain, metadata.offering].filter(Boolean).join(" / ");
    return el("p", { class: "kn-meta kn-metadata-preview" }, `${scope}${labels ? ` · ${labels}` : ""}${metadata.keywords?.length ? ` · ค้นจาก ${metadata.keywords.join(", ")}` : ""}`);
  }

  function addCard(refresh, metadataStatus) {
    const titleInput = el("input", {
      class: "kn-title keep-focus", type: "text", maxlength: "200",
      placeholder: "หัวข้อ เช่น โปรโมชั่นเดือนนี้ / ขั้นตอนติดตั้ง / คำถามที่พบบ่อย",
    });
    const contentInput = el("textarea", {
      class: "kn-content keep-focus", rows: "6", maxlength: String(CONTENT_MAX),
      placeholder: "วางเนื้อหาความรู้ตรงนี้… (ไม่เกิน 20,000 ตัวอักษร)",
    });
    const metadata = metadataControls(metadataStatus);
    const fileInput = el("input", { class: "kn-file", type: "file", accept: ".txt,text/plain" });
    fileInput.hidden = true;
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        contentInput.value = String(reader.result || "").slice(0, CONTENT_MAX);
        if (!titleInput.value.trim()) titleInput.value = file.name.replace(/\.txt$/i, "").slice(0, 200);
        toast("อ่านไฟล์แล้ว — ตรวจเนื้อหาแล้วกดบันทึกได้เลย");
      };
      reader.onerror = () => toast("อ่านไฟล์ไม่สำเร็จ ลองใหม่อีกครั้งนะคะ");
      reader.readAsText(file);
      fileInput.value = ""; // เลือกไฟล์เดิมซ้ำได้
    });

    const saveBtn = el("button", {
      class: "btn btn-primary",
      onclick: async () => {
        const title = titleInput.value.trim();
        const content = contentInput.value;
        if (!title) return toast("ใส่หัวข้อก่อนนะคะ");
        if (!content.trim()) return toast("ใส่เนื้อหาก่อนนะคะ");
        saveBtn.disabled = true;
        try {
          // G6: สร้างเข้า scope ที่เลือกอยู่ (null = สมองกลาง)
          const result = await api("/console/api/knowledge", {
            method: "POST", body: { title, content, ...(scope ? { channelId: scope } : {}), ...(metadata?.value ? { knowledgeMetadata: metadata.value() } : {}) },
          });
          toast(publishToast(result, "บันทึกความรู้แล้ว"));
          await refresh();
        } catch (err) {
          toast(err.message);
          saveBtn.disabled = false;
        }
      },
    }, publishLabel(canPublish(), "บันทึกความรู้"));

    return el("div", { class: "kn-add" },
      el("p", { class: "block-hint" }, metadataStatus?.ready
        ? "เลือกได้ว่าความรู้นี้เป็นพื้นฐาน หรือให้ระบบเลือกเมื่อคำถามตรงเรื่อง — ห้ามใส่ราคา/โปรที่ยังไม่ approve"
        : "ความรู้ที่เปิดใช้จะถูกส่งให้ AI อ่านก่อนตอบทุกครั้ง — ห้ามใส่ราคา/โปรที่ยังไม่ approve (ระบบกันราคานอกตารางให้อีกชั้น)"),
      canPublish() ? null : publishQueueHint(),
      titleInput,
      contentInput,
      metadata?.node,
      el("div", { class: "block-actions" },
        el("button", { class: "btn btn-outline", onclick: () => fileInput.click() }, "อ่านจากไฟล์ .txt"),
        fileInput,
        saveBtn,
      ),
    );
  }

  /* ------------------------------ รายการความรู้ ------------------------------ */

  function previewText(content) {
    const lines = String(content || "").split("\n").filter((l) => l.trim() !== "").slice(0, 2);
    const text = lines.join("\n");
    return text.length > 220 ? `${text.slice(0, 220)}…` : text;
  }

  function entryCard(row, refresh, metadataStatus) {
    const isOn = row.active === 1;

    async function patch(body, okMessage) {
      try {
        const guarded = row.expectedKnowledgeHash
          ? { ...body, expectedKnowledgeHash: row.expectedKnowledgeHash }
          : body;
        const result = await api(`/console/api/knowledge/${encodeURIComponent(row.id)}`, { method: "POST", body: guarded });
        toast(publishToast(result, okMessage));
        await refresh();
      } catch (err) {
        toast(err.message);
      }
    }

    const card = el("article", { class: `kn-card${isOn ? "" : " is-off"}` });

    function viewMode() {
      const editBtn = el("button", { class: "btn btn-outline btn-mini", onclick: () => editMode() }, "แก้ไข");
      const delBtn = el("button", {
        class: "icon-del",
        "aria-label": canPublish() ? "ลบความรู้" : "ขอให้ลบความรู้",
        title: canPublish() ? "ลบความรู้" : "ส่งคำขอลบให้พี่ง้วงอนุมัติ",
        onclick: async () => {
          const question = canPublish()
            ? `ลบความรู้ "${row.title}" ถาวร — ยืนยันไหม?`
            : `ส่งคำขอลบความรู้ "${row.title}" ให้พี่ง้วงอนุมัติ?`;
          if (!window.confirm(question)) return;
          try {
            const result = await api(`/console/api/knowledge/${encodeURIComponent(row.id)}`, { method: "DELETE" });
            toast(publishToast(result, "ลบความรู้แล้ว"));
            await refresh();
          } catch (err) {
            toast(err.message);
          }
        },
      }, "✕");
      const toggleBtn = el("button", {
        class: "switch-line switch-line-mini",
        role: "switch",
        "aria-checked": isOn ? "true" : "false",
        onclick: () => patch({ active: !isOn }, !isOn ? "เปิดใช้ความรู้นี้แล้ว" : "ปิดความรู้นี้แล้ว — AI จะไม่เห็นอีก"),
      },
        switchDot(isOn),
        el("span", { class: `switch-state ${isOn ? "is-on-text" : "is-off-text"}` }, isOn ? "เปิดใช้" : "ปิดอยู่"),
      );
      card.replaceChildren(
        el("div", { class: "kn-head" },
          el("strong", { class: "kn-name" }, row.title || "-"),
          delBtn,
        ),
        el("p", { class: "kn-preview" }, previewText(row.content) || "—"),
        // replaceChildren(null) จะกลายเป็นข้อความ "null" — ไม่มี metadata ให้ข้ามไปเลย
        ...[metadataPreview(row.knowledgeMetadata)].filter(Boolean),
        el("div", { class: "kn-foot" },
          toggleBtn,
          el("span", { class: "kn-meta" }, `อัปเดต ${timeAgo(row.updated_at)}${row.updated_by ? ` · โดย ${row.updated_by}` : ""}`),
          editBtn,
        ),
      );
    }

    function editMode() {
      const titleInput = el("input", { class: "kn-title keep-focus", type: "text", maxlength: "200", value: row.title });
      const contentInput = el("textarea", { class: "kn-content keep-focus", rows: "6", maxlength: String(CONTENT_MAX) });
      contentInput.value = row.content;
      const metadata = metadataControls(metadataStatus, row.knowledgeMetadata);
      card.replaceChildren(
        titleInput,
        contentInput,
        metadata?.node,
        el("div", { class: "block-actions" },
          el("button", { class: "btn btn-ghost", onclick: () => viewMode() }, "ยกเลิก"),
          el("button", {
            class: "btn btn-primary",
            onclick: () => {
              const title = titleInput.value.trim();
              if (!title) return toast("ใส่หัวข้อก่อนนะคะ");
              if (!contentInput.value.trim()) return toast("ใส่เนื้อหาก่อนนะคะ");
              patch({ title, content: contentInput.value, ...(metadata?.value ? { knowledgeMetadata: metadata.value() } : {}) }, "บันทึกการแก้ไขแล้ว");
            },
          }, publishLabel(canPublish(), "บันทึก")),
        ),
      );
      titleInput.focus();
    }

    viewMode();
    return card;
  }

  /* --------------------- ส่วน READ-ONLY: สมองที่ AI โหลดจริง --------------------- */

  // section พับได้มาตรฐาน — หัวข้อ + จำนวนใน header + ป้าย "อ่านอย่างเดียว"
  function brainSection({ title, count = null, open = false, hint = "", children }) {
    return el("details", { class: "kb-sec", ...(open ? { open: "" } : {}) },
      el("summary", {},
        el("span", { class: "kb-sec-title" }, title),
        count != null ? el("span", { class: "kb-count" }, String(count)) : null,
        el("span", { class: "kb-ro" }, "อ่านอย่างเดียว"),
      ),
      hint ? el("p", { class: "block-hint" }, hint) : null,
      children,
    );
  }

  function brandPackSection(brain) {
    const text = brain?.brandPack || "";
    // 18 ต.ค. 2026 (audit soul): ป้ายเดิม "AI อ่านทุกคำตอบ" ไม่จริง — เครื่องเก่า/ทักตาม/YOLO หยิบไม่เกิน 2 หัวข้อ
    // (ไม่เกิน 4,000 อักษร) ที่ตรงกับเทิร์นนั้น ส่วนเครื่องตอบ v3 ไม่อ่านก้อนนี้เลย (อ่านการ์ดความรู้ที่อนุมัติแทน)
    return brainSection({
      title: "Brand Pack (ข้อมูลธุรกิจตั้งต้น — ระบบหยิบเฉพาะหัวข้อที่ตรงกับเทิร์นนั้น)",
      count: text ? `${text.length.toLocaleString("th-TH")} อักษร` : 0,
      hint: "เครื่องเก่า ทักตาม และ YOLO หยิบไม่เกิน 2 หัวข้อที่เกี่ยวกับข้อความนั้น · เครื่องตอบ v3 ไม่อ่านก้อนนี้ (อ่านการ์ดความรู้ที่อนุมัติแทน) · โหลดจากไฟล์ config ตอนสตาร์ทระบบ — แก้ไฟล์แล้วต้องรีสตาร์ทถึงเปลี่ยน",
      children: text
        ? el("pre", { class: "kb-pre" }, text)
        : el("p", { class: "kb-empty" }, "ยังไม่ได้ตั้ง Brand Pack — AI ตอบจากตัวตน (soul) และความรู้ทีมเท่านั้น"),
    });
  }

  // 18 ต.ค. 2026 (ขั้นที่ 2 ของแผน soul): กล่อง Persona เดิมโชว์ไฟล์ที่เครื่องตอบหลัก (v3) ไม่ได้อ่าน
  // ตัวตนจริงของทุกเส้นอยู่ที่หน้า #/soul ที่เดียว — ที่นี่เหลือลิงก์
  function soulLinkSection() {
    return el("div", { class: "kb-sec kb-soul-link" },
      el("a", { class: "kb-soul-anchor", href: "#/soul" },
        el("span", { class: "kb-sec-title" }, "ตัวตนของ AI (soul) — บุคลิก วิธีพูด และข้อความที่แต่ละเส้นได้จริง"),
        el("span", { class: "kb-ro" }, "เปิดหน้าตัวตน →"),
      ),
    );
  }

  function pricesSection(brain) {
    const rows = brain?.approvedPrices || [];
    return brainSection({
      title: "ตารางราคาที่ approve แล้ว",
      count: rows.length,
      hint: "AI พูดตัวเลขได้เฉพาะราคาในตารางนี้ — ตัวเลขนอกตารางถูกระบบกันไว้ให้คนรีวิวเสมอ",
      children: rows.length
        ? el("div", { class: "kb-price-list" }, rows.map((p) =>
            el("div", { class: "kb-price-row" },
              el("span", { class: "kb-price-label" }, p.label),
              el("span", { class: "kb-price-amount" }, `฿${Number(p.amount).toLocaleString("th-TH")}`),
            )))
        : el("p", { class: "kb-empty" }, "ตารางว่าง — AI จะไม่ยืนยันราคาใด ๆ (ทุกคำถามราคาส่งต่อให้คน)"),
    });
  }

  function imagesSection(brain) {
    const rows = brain?.images || [];
    return brainSection({
      title: "รูปที่ AI ส่งได้",
      count: rows.length,
      hint: "AI เลือกส่งได้เฉพาะรูปในแคตตาล็อกนี้ผ่านรหัส [IMAGE:key] — เดา URL เองไม่ได้",
      children: rows.length
        ? el("div", { class: "kb-img-grid" }, rows.map((img) =>
            el("figure", { class: "kb-img-card" },
              el("img", { class: "kb-img", src: img.previewUrl, alt: img.description || img.key, loading: "lazy" }),
              el("figcaption", { class: "kb-img-cap" },
                el("code", { class: "kb-img-key" }, img.key),
                img.description ? el("span", { class: "kb-img-desc" }, img.description) : null,
                img.needsVerification ? el("span", { class: "badge badge-orange" }, "รอยืนยันกับ LINE จริง") : null,
              ),
            )))
        : el("p", { class: "kb-empty" }, "แคตตาล็อกรูปว่าง — ฟีเจอร์ส่งรูปปิดอยู่"),
    });
  }

  function safetySection(brain) {
    const rows = brain?.safetyRules || [];
    return brainSection({
      title: "กฎความปลอดภัยเฉพาะธุรกิจ",
      count: rows.length,
      hint: "เจอคำเหล่านี้ = ตอบ template ตายตัว + แจ้งทีมทันที ไม่ผ่าน AI — กฎกลาง (ฉุกเฉินการแพทย์/ร้องเรียน/สลิป/ถามว่าเป็นบอท) ทำงานอยู่เสมอ เพิ่มเติมจากรายการนี้",
      children: rows.length
        ? el("div", { class: "kb-rule-list" }, rows.map((r) =>
            el("div", { class: "kb-rule" },
              el("div", { class: "chip-row" },
                el("span", { class: "kb-rule-reason" }, r.reason || "custom"),
                ...(r.keywords || []).map((k) => el("span", { class: "chip" }, k)),
              ),
              el("p", { class: "kb-rule-template" }, r.template),
            )))
        : el("p", { class: "kb-empty" }, "ยังไม่มีกฎเพิ่มเติม — ใช้กฎกลางของระบบอย่างเดียว"),
    });
  }

  function statusSection(brain) {
    const kn = brain?.knowledge || {};
    const models = brain?.models || {};
    const line = (label, value) => el("div", { class: "kb-status-row" },
      el("span", { class: "kb-status-label" }, label),
      el("strong", { class: "kb-status-value" }, value),
    );
    return brainSection({
      title: "สถานะสมอง AI ตอนนี้",
      open: true,
      children: el("div", { class: "kb-status" },
        line("โมเดลตอบลูกค้า", models.replyModel || "—"),
        line("โมเดลวิเคราะห์ score", models.scorerModel || "—"),
        line("ความรู้ทีมที่เปิดใช้", `${kn.active ?? 0} จาก ${kn.total ?? 0} รายการ`),
        // 19 ต.ค. 2026: คลังรีวิวมีงบแยก — เมตรสองตัว (ไม่มี catalogMaxChars = เซิร์ฟเวอร์อยู่โหมดเดิม แสดงแบบเดิม)
        kn.catalogMaxChars
          ? line("ขนาดความรู้ที่แนบต่อคำตอบ",
            `~${(kn.approxTokens ?? 0).toLocaleString("th-TH")} token (งบคลังความรู้ ${(kn.budgetChars ?? 0).toLocaleString("th-TH")} จาก ${(kn.maxChars ?? 0).toLocaleString("th-TH")} อักษร)`)
          : line("ขนาดความรู้ที่แนบต่อคำตอบ",
            `~${(kn.approxTokens ?? 0).toLocaleString("th-TH")} token (${(kn.injectedChars ?? 0).toLocaleString("th-TH")} จาก ${(kn.maxChars ?? 0).toLocaleString("th-TH")} อักษร)`),
        kn.catalogMaxChars
          ? line("คลังรีวิว (ส่งเฉพาะรายการที่ระบบเลือก)",
            `${(kn.catalogChars ?? 0).toLocaleString("th-TH")} จาก ${(kn.catalogMaxChars ?? 0).toLocaleString("th-TH")} อักษร`)
          : null,
      ),
    });
  }

  /* ----------------------- G6: scope chips (สมองกลาง | สาขาที่แยก) ----------------------- */

  function scopeChips(separateChannels, refresh) {
    if (!separateChannels.length) return null;
    const chip = (id, label) => el("button", {
      class: `fchip fchip-branch${(scope ?? null) === id ? " is-active" : ""}`,
      onclick: () => {
        if (scope === id) return;
        scope = id;
        refresh();
      },
      ...((scope ?? null) === id ? { "aria-current": "true" } : {}),
    }, label);
    return el("nav", { class: "inbox-filters kn-scope", "aria-label": "เลือกสมองที่จะดู" },
      chip(null, "🧠 สมองกลาง"),
      separateChannels.map((ch) => chip(ch.id, `🎨 ${ch.name || ch.id}`)),
    );
  }

  function scopeExplain(separateChannels) {
    if (!separateChannels.length) return null;
    if (!scope) {
      return el("p", { class: "filter-explain kn-scope-explain" },
        `กำลังดู: สมองกลาง — สาขาโหมดสมองกลางใช้ชุดนี้; สาขาที่แยกสมอง (${separateChannels.map((c) => c.name || c.id).join(", ")}) ไม่เห็นรายการชุดนี้`);
    }
    const ch = separateChannels.find((c) => c.id === scope);
    return el("p", { class: "filter-explain kn-scope-explain" },
      `กำลังดู: สมองแยกของ ${ch?.name || scope} — AI ของสาขานี้อ่านเฉพาะรายการชุดนี้ (ราคา รูป และกฎความปลอดภัยยังใช้กลางร่วมกัน)`);
  }

  /* --------------------------------- render --------------------------------- */

  async function renderKnowledge() {
    stopPolling();
    const buildReviews = createReviewsSection({ api, toast, refresh: renderKnowledge });
    const [data, brain, brainModes, reviewsBox] = await Promise.all([
      api("/console/api/knowledge"),
      api("/console/api/brain").catch(() => null),
      api("/console/api/settings/brain").catch(() => null), // G6: โหมดสมองต่อสาขา
      // white-label: คลังรีวิวผู้เรียนเป็นของ production course เท่านั้น — ร้านทั่วไปไม่ยิงเส้นนี้
      isGeneric(state) ? Promise.resolve(null) : buildReviews().catch(() => null),
    ]);
    const separateChannels = (brainModes?.channels || []).filter((ch) => ch.mode === "separate");
    // สาขาที่เคยเลือกไว้กลับไปโหมด shared แล้ว — เด้งกลับสมองกลาง (รายการสาขายังอยู่ใน DB)
    if (scope && !separateChannels.some((ch) => ch.id === scope)) scope = null;
    const allRows = data.knowledge || [];
    const rows = allRows.filter((row) => (scope ? row.channel_id === scope : !row.channel_id));
    mount(
      pageHeader("คลังความรู้"),
      el("main", { class: "page-scroll" }, el("div", { class: "page-inner" },
        photoStudioCard({ toast }),
        el("p", { class: "kb-lede" },
          "หน้านี้คือสมองทั้งใบของ AI — ทุกอย่างที่มันรู้และใช้ตอบลูกค้า อยู่ตรงนี้ครบ"),
        el("section", { class: "block kb-block" },
          el("details", { class: "kb-sec", open: "" },
            el("summary", {},
              el("span", { class: "kb-sec-title" }, "ความรู้ที่ทีมเพิ่ม"),
              el("span", { class: "kb-count" }, String(rows.length)),
              el("span", { class: "kb-ro kb-editable" }, "แก้ได้"),
            ),
            scopeChips(separateChannels, renderKnowledge),
            scopeExplain(separateChannels),
            addCard(renderKnowledge, data.knowledgeMetadata),
            el("div", { class: "kn-list" },
              rows.length === 0
                ? el("p", { class: "kb-empty" },
                    scope
                      ? "สาขานี้ยังไม่มีความรู้ของตัวเอง — เพิ่มอันแรกจากกล่องด้านบนได้เลย (สมองแยกไม่อ่านความรู้กลาง)"
                      : "ยังไม่มีความรู้ — เพิ่มอันแรกจากกล่องด้านบนได้เลย")
                : rows.map((row) => entryCard(row, renderKnowledge, data.knowledgeMetadata)),
            ),
          ),
        ),
        reviewsBox && !scope
          ? el("section", { class: "block kb-block" },
              el("details", { class: "kb-sec" },
                el("summary", {},
                  el("span", { class: "kb-sec-title" }, "คลังรีวิว"),
                  el("span", { class: "kb-ro kb-editable" }, "แก้ได้"),
                ),
                reviewsBox,
              ),
            )
          : null,
        brain
          ? el("section", { class: "block kb-block" },
              statusSection(brain),
              brandPackSection(brain),
              soulLinkSection(),
              pricesSection(brain),
              imagesSection(brain),
              safetySection(brain),
            )
          : el("p", { class: "block-hint" }, "โหลดข้อมูลสมอง AI ไม่สำเร็จ — รีเฟรชหน้านี้อีกครั้ง"),
      )),
      tabBar(),
    );
    setView("page");
  }

  return renderKnowledge;
}
