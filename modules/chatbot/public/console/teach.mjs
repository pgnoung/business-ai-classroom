// teach.mjs — "จอสอนลูกแพร" (#/teach/<source>/<ref>)
//
// สี่คำถามที่จอนี้ต้องตอบก่อนคนกดส่ง (แบบแปลน §6 Step 1–2):
//   1. เรื่องนี้เป็นอะไร (ชิปเหตุผล -> ชนิดการ์ด)
//   2. ข้อความที่จะกลายเป็นความรู้ หน้าตาเป็นยังไง (แก้ได้ก่อนส่ง)
//   3. มันจะทับหรือขัดกับการ์ดใบไหนบ้าง (จับคำ — จอบอกตรง ๆ ว่าไม่ใช่หลักฐาน)
//   4. กดส่งแล้วจะเกิดอะไร (เผยแพร่เลย / เข้าคิวให้พี่ง้วง / ถูกด่านกัน)
//
// การกดส่ง **ไม่มีเส้นทางของตัวเอง**: มันยิงเข้า POST /console/api/knowledge หรือ
// /console/api/prices ซึ่งเป็นเส้นเดิมที่ผ่าน brainWriteHook อยู่แล้ว — จอนี้จึงได้ด่าน
// ทั้งบันได คิวขออนุมัติ และกติกาผู้เผยแพร่มาฟรีทั้งชุด โดยไม่มีตรรกะชุดที่สองให้เพี้ยน
import { el } from "./dom.mjs";
import { publishLabel, publishToast } from "./publishQueue.mjs";
import { saveDraft, readDraft, clearDraft } from "./teachDrafts.mjs";

const CONTENT_MAX = 20000;
const TITLE_MAX = 200;

const RISK_TEXT = {
  green: "เขียว — แก้ได้เลย ไม่มีเรื่องเงิน วันที่ หรือคำสัญญา",
  yellow: "เหลือง — มีเรื่องที่ต้องให้คนดูก่อน",
  red: "แดง — ของที่พูดกับลูกค้าเรื่องเงิน/วันที่ ต้องให้พี่ง้วงกดเอง",
};

function teachMetadataControls(status) {
  if (!status?.ready) return { node: status?.enabled
    ? el("p", { class: "block-hint kn-metadata-status" }, status.message || "ยังใช้การเลือกความรู้ตามเรื่องไม่ได้")
    : null, value: null, apply: () => {} };
  const mode = el("select", { class: "kn-metadata-mode keep-focus", "aria-label": "วิธีใช้ความรู้นี้" },
    el("option", { value: "pin" }, "ใช้เป็นความรู้พื้นฐาน"),
    el("option", { value: "retrieve" }, "ใช้เมื่อถามเรื่องนี้"),
  );
  const domain = el("input", { class: "kn-metadata-domain keep-focus", type: "text", maxlength: "64", placeholder: "หมวด เช่น การตลาด LINE" });
  const offering = el("input", { class: "kn-metadata-offering keep-focus", type: "text", maxlength: "64", placeholder: "คลาส/บริการ เช่น LINE สำหรับมือใหม่" });
  const keywords = el("input", { class: "kn-metadata-keywords keep-focus", type: "text", maxlength: "1619", placeholder: "คำที่ช่วยค้นเจอ คั่นด้วยจุลภาค" });
  const apply = (metadata = null) => {
    mode.value = metadata?.mode === "retrieve" ? "retrieve" : "pin";
    domain.value = metadata?.domain || "";
    offering.value = metadata?.offering || "";
    keywords.value = (metadata?.keywords || []).join(", ");
  };
  return {
    node: el("fieldset", { class: "kn-metadata" },
      el("legend", {}, "เลือกเวลาที่ใช้ความรู้นี้ (ไม่บังคับ)"), mode, domain, offering, keywords,
      el("p", { class: "block-hint" }, "ถ้าเลือกใช้เมื่อถามเรื่องนี้ ต้องใส่คำที่ช่วยค้นเจออย่างน้อย 1 คำ"),
      status?.corpusCapChars ? el("p", { class: "block-hint" }, `คลังความรู้ทั้งหมดยังรวมได้ไม่เกิน ${Number(status.corpusCapChars).toLocaleString("th-TH")} ตัวอักษร`
        + (status.reviewCatalogCapChars ? ` (ไม่นับคลังรีวิว ซึ่งมีงบแยก ${Number(status.reviewCatalogCapChars).toLocaleString("th-TH")} ตัวอักษร)` : "")) : null,
    ),
    value: () => ({ mode: mode.value, domain: domain.value, offering: offering.value,
      keywords: keywords.value.split(",").map((value) => value.trim()).filter(Boolean) }),
    apply,
  };
}

export function createTeachPage({ api, toast, mount, pageHeader, tabBar, stopPolling, setView, state }) {
  const canPublishKnowledge = () => state?.me?.capabilities?.includes("knowledge.publish") === true;
  const canPublishPrices = () => state?.me?.capabilities?.includes("prices.manage") === true;

  async function render({ source, ref }) {
    stopPolling();
    let data;
    try {
      data = await api(`/console/api/teach/session?source=${encodeURIComponent(source)}&ref=${encodeURIComponent(ref)}`);
    } catch (err) {
      mountShell(el("section", { class: "block" },
        el("h2", { class: "block-title" }, "เปิดเรื่องนี้ไม่ได้"),
        el("p", { class: "block-hint" }, err.message),
        el("a", { class: "btn btn-outline", href: "#/review" }, "← กลับกล่องตรวจ"),
      ));
      return;
    }

    // สถานะของจอนี้ทั้งหมดอยู่ในกลุ่มนี้ — ไม่มี state ซ่อนที่อื่น
    const chosenChips = new Set(data.selectedChips ?? []);
    let proposal = data.proposal;
    let related = data.related ?? [];
    let searchIsWeak = data.searchIsWeak === true;
    let targetId = "";       // "" = สร้างการ์ดใบใหม่ / id = แก้ใบเดิม
    let priceLabel = "";     // "" = ราคารายการใหม่ / label = แก้ยอดของรายการเดิม
    // ข้อความที่คนพิมพ์เอง — ต้องคืนได้เมื่อเลิกเลือกการ์ด (ไม่งั้นการกดผิดหนึ่งครั้งกินงานทั้งหมด)
    let ownText = data.correctText || "";
    let planning = null;     // คำขอจัดชนิดที่ยังค้างอยู่ (กดส่งต้องรอตัวนี้ก่อนเสมอ)
    const draft = readDraft(source, ref);
    let sending = false;     // กันกดสองที: repaint ห้ามเปิดปุ่มคืนระหว่างที่ยังส่งไม่จบ
    // กุญแจกันส่งซ้ำ — ผูกกับ "ของชิ้นนี้" ไม่ใช่กับการกดแต่ละครั้ง
    const teachKeyOf = (title, content) => `teach:${data.source}:${data.ref}:${hash32(`${title}\u0000${content}`)}`;

    const titleInput = el("input", {
      class: "kn-title keep-focus", type: "text", maxlength: String(TITLE_MAX),
      placeholder: "หัวข้อสั้น ๆ เช่น ที่จอดรถและการเดินทาง",
    });
    const contentInput = el("textarea", {
      class: "kn-content keep-focus", rows: "5", maxlength: String(CONTENT_MAX),
      placeholder: "ข้อความที่ลูกแพรควรใช้ตอบ",
    });
    // ของที่พิมพ์ค้างไว้มาก่อนของที่เซิร์ฟเวอร์เติมให้เสมอ — คนพิมพ์ไปแล้วสิบนาทีบนมือถือ
    // แล้วสลับแอปไปรับสาย กลับมาต้องเจอของเดิม ไม่ใช่หน้าเปล่า
    contentInput.value = draft?.content ?? (data.correctText || "");
    if (draft?.title) titleInput.value = draft.title;
    const amountInput = el("input", {
      class: "tc-input tc-amount", type: "number", min: "1", step: "1", placeholder: "ยอดเงิน (บาท)",
    });
    // ตัวเลือกรายการราคา: แก้ยอดของเดิม หรือเพิ่มรายการใหม่
    const priceSelect = el("select", { class: "tc-input tc-price-pick" },
      el("option", { value: "" }, "＋ เพิ่มรายการราคาใหม่"),
      (data.prices ?? []).map((row) => el("option", { value: row.label },
        `แก้ยอด: ${row.label} (${Number(row.amount).toLocaleString("th-TH")} บาท)`)),
    );
    priceSelect.addEventListener("change", () => {
      priceLabel = String(priceSelect.value || "");
      const current = (data.prices ?? []).find((row) => row.label === priceLabel);
      if (current) {
        titleInput.value = current.label;
        if (!amountInput.value) amountInput.value = String(current.amount);
      }
      repaint();
    });
    const replaceNote = el("p", { class: "tc-replace-note" });
    const metadata = teachMetadataControls(data.knowledgeMetadata);

    const proposalBox = el("div", { class: "tc-proposal" });
    const relatedBox = el("div", { class: "tc-related" });
    const sendBtn = el("button", { class: "btn btn-primary tc-send" }, "ส่ง");
    const saveCorrectionBtn = el("button", { class: "btn btn-outline tc-save-correction" }, "บันทึกคำแก้");

    // เลือก/เลิกเลือกการ์ดที่จะทับ — ต้องยกข้อความเดิมมาให้เห็น ไม่ใช่ทับเงียบ ๆ
    // (เดิม "แก้ใบนี้" เอาคำแก้สั้น ๆ ไปทับการ์ดทั้งใบ โดยไม่มีใครเห็นว่าอะไรกำลังจะหาย)
    function pickTarget(id) {
      if (targetId === id) return;
      if (!targetId) ownText = contentInput.value;   // เก็บของที่คนพิมพ์ไว้ก่อนสลับ
      targetId = id;
      const card = related.find((row) => row.id === id) ?? null;
      if (card) {
        contentInput.value = `${card.content ?? ""}\n\n${ownText}`.trim();
        // เติมหัวข้อจากการ์ดที่เลือก — งานพิมพ์ที่เหลือควรเป็นศูนย์เมื่อมันคือใบเดิม
        if (!titleInput.value.trim()) titleInput.value = card.title || "";
        metadata.apply(card.knowledgeMetadata);
      } else {
        contentInput.value = ownText;
        metadata.apply();
      }
      repaint();
    }

    function repaint() {
      const isPrice = proposal.kind === "price";
      proposalBox.replaceChildren(...proposalNodes(proposal));
      relatedBox.replaceChildren(...relatedNodes(related, { targetId, isPrice, searchIsWeak, onPick: pickTarget }));
      amountInput.hidden = !isPrice;
      priceSelect.hidden = !isPrice;
      if (metadata.node) metadata.node.hidden = isPrice;
      // ช่องหัวข้อทำหน้าที่ต่างกันตามชนิด — ป้ายที่ไม่ตรงงาน คือช่องที่คนกรอกผิดทุกครั้ง
      titleInput.setAttribute("placeholder", isPrice
        ? "ชื่อรายการราคา เช่น Early Bird รุ่น 58"
        : "หัวข้อสั้น ๆ เช่น ที่จอดรถและการเดินทาง");
      // "จะทับอะไร กี่ตัวอักษร" ต้องอยู่ติดปุ่มเสมอ ไม่ใช่ให้คนเดาจากชื่อการ์ด
      const target = targetId ? related.find((row) => row.id === targetId) : null;
      replaceNote.textContent = target
        ? `ข้อความเดิม ${Number(target.chars ?? 0)} ตัวอักษรจะถูกแทนที่ด้วยข้อความในช่องนี้ทั้งหมด`
        : "";
      replaceNote.hidden = !target;
      // ป้ายปุ่มต้องบอกสิ่งที่จะเกิดขึ้นจริง ไม่ใช่คำว่า "บันทึก" ทุกกรณี
      const canPublish = isPrice ? canPublishPrices() : canPublishKnowledge();
      sendBtn.textContent = proposal.blocked
        ? "ยังส่งไม่ได้"
        : publishLabel(canPublish, isPrice
          ? (priceLabel ? "แก้ยอดของรายการนี้" : "เพิ่มในตารางราคา")
          : (targetId ? "แทนที่ข้อความทั้งใบ" : "เพิ่มเป็นความรู้ใหม่"));
      sendBtn.disabled = sending || proposal.blocked || !proposal.writable || data.teachingBlocked === true;
    }

    // จัดชนิดใหม่ — เก็บคำขอที่ค้างไว้ใน `planning` เพราะปุ่มส่งต้องรอมันก่อนเสมอ
    // (กดส่งทันทีหลังพิมพ์ = ส่งภายใต้การจัดชนิดของรอบก่อน ซึ่งทำให้เรื่องเงินหลุดเป็นเขียวได้)
    function replan() {
      const run = (async () => {
        try {
          const result = await api("/console/api/teach/plan", {
            method: "POST",
            body: { chips: [...chosenChips], title: titleInput.value.trim(), correctText: contentInput.value },
          });
          proposal = result.proposal;
          related = result.related ?? [];
          searchIsWeak = result.searchIsWeak === true;
        } catch (err) {
          toast(err.message);
        }
        if (planning === run) planning = null;
        repaint();
      })();
      planning = run;
      return run;
    }

    const chipRow = el("div", { class: "tc-chips" },
      (data.chips ?? []).map((chip) => {
        const node = el("button", {
          class: `fchip${chosenChips.has(chip.id) ? " is-active" : ""}`,
          title: chip.writable === false ? chip.why : "",
          onclick: async () => {
            if (chosenChips.has(chip.id)) chosenChips.delete(chip.id); else chosenChips.add(chip.id);
            node.classList.toggle("is-active", chosenChips.has(chip.id));
            await replan();
          },
        }, chip.label);
        return node;
      }),
    );

    // พิมพ์เสร็จแล้วค่อยคิดใหม่ (ไม่ใช่ทุกตัวอักษร) — เส้น plan ไม่เรียกโมเดล แต่ก็ไม่ต้องรัว
    // `input` ตั้ง "ค้างอยู่" ไว้ก่อน แล้ว blur เป็นตัวยิงจริง: ปุ่มส่งจะได้รู้ว่ายังคิดไม่จบ
    let typedSincePlan = false;
    const markTyped = () => {
      typedSincePlan = true;
      saveDraft(source, ref, { title: titleInput.value, content: contentInput.value });
    };
    contentInput.addEventListener("input", markTyped);
    titleInput.addEventListener("input", markTyped);
    const planNow = () => { typedSincePlan = false; return replan(); };
    contentInput.addEventListener("blur", planNow);
    titleInput.addEventListener("blur", planNow);

    sendBtn.addEventListener("click", async () => {
      if (sending) return;
      // กดส่งทันทีหลังพิมพ์: ต้องรอผลจัดชนิดรอบใหม่ก่อนเสมอ ไม่งั้นข้อความที่เพิ่งพิมพ์
      // (เช่นตัวเลขเงิน) จะถูกส่งภายใต้การจัดชนิดของรอบก่อน แล้วกลายเป็นการ์ดเขียว
      const riskBefore = proposal.kind;
      if (typedSincePlan || planning) await planNow();
      if (proposal.blocked || !proposal.writable) return repaint();
      if (proposal.kind !== riskBefore) {
        repaint();
        return toast(`เรื่องนี้ถูกจัดใหม่เป็น "${proposal.riskLabel}" หลังข้อความที่เพิ่งพิมพ์ — ตรวจแล้วกดส่งอีกครั้งนะคะ`);
      }
      const title = titleInput.value.trim();
      const content = contentInput.value.trim();
      const isPrice = proposal.kind === "price";
      if (!content && !isPrice) return toast("ใส่ข้อความที่ลูกแพรควรใช้ตอบก่อนนะคะ");
      if (!isPrice && !title && !targetId) return toast("ใส่หัวข้อให้ความรู้ใบนี้ก่อนนะคะ");
      // ชื่อรายการราคาไปโผล่ในตารางที่ตัวกรองใช้จริง — ปล่อยให้ว่างแล้วเติมให้เองไม่ได้
      if (isPrice && !title && !priceLabel) return toast("ใส่ชื่อรายการราคาก่อนนะคะ (เช่น Early Bird รุ่น 58)");
      if (isPrice && !(Number(amountInput.value) > 0)) return toast("ใส่ยอดเงินที่ถูกต้องก่อนนะคะ");
      // ชื่อใหม่ที่ชนกับของเดิมแบบ "ต่างแค่รูป" = ราคาสองแถวในตารางของตัวกรอง
      const clash = isPrice && !priceLabel
        ? (data.prices ?? []).find((row) => samePriceLabel(row.label, title))
        : null;
      if (clash) {
        return toast(`มีรายการนี้อยู่แล้ว ("${clash.label}") — เลือก "แก้ยอด" ของรายการเดิมแทนนะคะ`);
      }
      sending = true;
      repaint();
      // teach = ที่มาของการสอนครั้งนี้ ติดไปกับ body ของเส้นเขียนเดิม (ไม่ใช่เส้นใหม่)
      const teach = {
        source: data.source === "message" ? "chat" : data.source,
        ...(data.source === "message" ? { messageRef: data.ref } : { correctionRef: data.ref }),
        reasonChips: [...chosenChips], correctText: contentInput.value.slice(0, 2000),
        risk: proposal.risk,
      };
      // กุญแจเดียวกันสำหรับของชิ้นเดียวกัน — เน็ตอืดแล้วกดซ้ำจะได้ 409 แทนการ์ดใบที่สอง
      const teachKey = teachKeyOf(title, content);
      const target = targetId ? related.find((row) => row.id === targetId) : null;
      try {
        const result = isPrice
          ? priceLabel
            ? await api(`/console/api/prices/${encodeURIComponent(priceLabel)}`,
              { method: "POST", body: { amount: Number(amountInput.value), teach, teachKey } })
            : await api("/console/api/prices",
              { method: "POST", body: { label: title, amount: Number(amountInput.value), teach, teachKey } })
          : targetId
            ? await api(`/console/api/knowledge/${encodeURIComponent(targetId)}`,
              { method: "POST", body: {
                content, teach, teachKey,
                ...(metadata.value ? { knowledgeMetadata: metadata.value() } : {}),
                ...(target?.expectedKnowledgeHash ? { expectedKnowledgeHash: target.expectedKnowledgeHash } : {}),
              } })
            : await api("/console/api/knowledge",
              { method: "POST", body: { title, content, teach, teachKey, ...(metadata.value ? { knowledgeMetadata: metadata.value() } : {}) } });
        clearDraft(source, ref);
        toast(publishToast(result, "ส่งบทเรียนให้ลูกแพรแล้ว"));
        location.hash = "#/review";
      } catch (err) {
        // ด่านของสมองตอบเป็นภาษาคนอยู่แล้ว ส่งต่อทั้งประโยค อย่าย่อ
        toast(err.message);
      } finally {
        sending = false;
        repaint();
      }
    });

    saveCorrectionBtn.addEventListener("click", async () => {
      const humanFinal = contentInput.value.trim();
      if (!humanFinal) return toast("พิมพ์คำตอบที่แก้จากร่างเดิมก่อนนะคะ");
      saveCorrectionBtn.disabled = true;
      try {
        await api("/console/api/teach/correction-final", {
          method: "POST", body: { source: data.source, ref: data.ref, humanFinal },
        });
        toast("บันทึกคำแก้แล้ว ตรวจและสอนต่อได้ค่ะ");
        await render({ source, ref });
      } catch (err) {
        toast(err.message);
        saveCorrectionBtn.disabled = false;
      }
    });

    repaint();
    mountShell(
      el("section", { class: "block tc-block" },
        el("h2", { class: "block-title" }, "สอนลูกแพรจากเรื่องนี้"),
        data.aiDraft
          ? el("p", { class: "tc-draft" }, `${data.draftLabel || "ลูกแพรตอบไว้ว่า:"} ${data.aiDraft}`)
          : null,
        correctionProvenanceNode(data.provenance, data.humanDecisionReason),
        inboundSourceNode(data.inboundSource, data.customerId),
        el("p", { class: "block-hint" }, "เลือกว่าเรื่องนี้เป็นอะไร แล้วแก้ข้อความให้เป็นความรู้ที่ใช้ซ้ำได้"),
        data.teachingBlocked
          ? el("p", { class: "tc-blocked" }, data.teachingBlockedReason || "บันทึกคำแก้ของคนก่อนจึงจะสอนได้")
          : null,
        draft ? el("p", { class: "tc-draft-restored" }, "กู้ข้อความที่พิมพ์ค้างไว้ให้แล้ว") : null,
        chipRow,
      ),
      el("section", { class: "block tc-block" },
        el("h2", { class: "block-title" }, "ข้อความที่จะกลายเป็นความรู้"),
        priceSelect,
        titleInput,
        contentInput,
        metadata.node,
        amountInput,
        replaceNote,
        proposalBox,
        data.teachingBlocked ? saveCorrectionBtn : null,
      ),
      el("section", { class: "block tc-block" },
        el("h2", { class: "block-title" }, "การ์ดที่น่าจะเกี่ยว"),
        el("p", { class: "block-hint" },
          "รายการนี้มาจากการจับคำ ไม่ใช่หลักฐานว่าลูกแพรใช้ใบไหนตอบ —"
          + " ถ้าใบไหนพูดเรื่องเดียวกัน เลือกแก้ใบนั้นแทนการเพิ่มใบใหม่จะไม่ทำให้ขัดกันเอง"),
        relatedBox,
      ),
      el("div", { class: "block-actions tc-actions" },
        el("a", { class: "btn btn-ghost", href: "#/review" }, "← กลับ"),
        data.customerId
          ? el("a", { class: "btn btn-ghost", href: `#/c/${encodeURIComponent(data.customerId)}` }, "เปิดห้องแชท")
          : null,
        sendBtn,
      ),
    );
  }

  function mountShell(...nodes) {
    mount(
      pageHeader("สอนลูกแพร"),
      el("main", { class: "page-scroll" }, el("div", { class: "page-inner tc-page" }, nodes)),
      tabBar(),
    );
    setView("page");
  }

  return render;
}

export function correctionProvenanceNode(provenance = {}, humanDecisionReason = "") {
  const nodes = [el("p", { class: "block-hint tc-provenance" },
    String(provenance?.label || "ที่มาร่างของระบบ: ไม่ได้บันทึก"))];
  if (String(humanDecisionReason || "").trim()) {
    nodes.push(el("p", { class: "block-hint tc-human-reason" }, `เหตุผลที่ทีมบันทึก: ${String(humanDecisionReason).trim()}`));
  }
  return el("div", { class: "tc-provenance-wrap" }, nodes);
}

// Fixed Thai labels keep provenance readable without confusing a linked burst's
// final local message with the full customer question.
export function inboundSourceNode(source = {}, customerId = "") {
  const room = customerId
    ? el("a", { class: "btn btn-ghost btn-mini", href: `#/c/${encodeURIComponent(customerId)}` }, "เปิดบทสนทนาทั้งห้อง")
    : null;
  if (source?.available !== true) {
    return el("p", { class: "block-hint tc-inbound-source" }, "ข้อความต้นทางที่เชื่อมไว้: ยังไม่มีข้อมูล", room);
  }
  const kind = String(source.kind || "unknown");
  if (kind !== "text") {
    const label = kind === "image" ? "รูปภาพ" : kind === "audio" ? "ข้อความเสียง" : "สื่อแนบ";
    return el("p", { class: "block-hint tc-inbound-source" }, `ข้อความต้นทางที่เชื่อมไว้/ข้อความล่าสุดในชุด: ${label}`, room);
  }
  return el("div", { class: "tc-inbound-source" },
    el("p", { class: "block-hint" }, "ข้อความต้นทางที่เชื่อมไว้/ข้อความล่าสุดในชุด:"),
    el("p", { class: "tc-draft" }, String(source.text || "")),
    room,
  );
}

/* ------------------------------- ชิ้นส่วนของจอ ------------------------------- */

// "สิ่งที่จะเกิดขึ้น" ต้องอ่านจบในสามบรรทัด และต้องบอกเหตุผลของสีเสมอ
export function proposalNodes(proposal) {
  const nodes = [
    el("p", { class: `tc-risk tc-risk-${proposal.risk}` },
      RISK_TEXT[proposal.risk] || `ระดับ ${proposal.riskLabel}`),
  ];
  for (const hit of proposal.escalatedBy ?? []) {
    nodes.push(el("p", { class: "tc-escalate" },
      `คำว่า “${hit.word}” ทำให้เรื่องนี้ต้องให้พี่ง้วงอนุมัติ`));
  }
  if (proposal.splitHint) nodes.push(el("p", { class: "tc-split" }, proposal.splitHint));
  if (proposal.blocked) nodes.push(el("p", { class: "tc-blocked", role: "alert" }, proposal.blockReason));
  else if (!proposal.writable) nodes.push(el("p", { class: "tc-blocked" }, proposal.notWritableWhy));
  return nodes;
}

// รายการการ์ดที่น่าจะเกี่ยว + ตัวเลือก "แก้ใบนี้แทน" (ไม่มีค่าเริ่มต้นอัตโนมัติโดยเจตนา:
// การเดาให้ว่าจะทับใบไหน คือวิธีที่แน่นอนที่สุดที่จะลบความรู้ที่ถูกอยู่แล้วทิ้ง)
export function relatedNodes(related = [], {
  targetId = "", isPrice = false, searchIsWeak = false, onPick = () => {},
} = {}) {
  if (isPrice) {
    return [el("p", { class: "block-hint" },
      "เรื่องราคาไม่ทับการ์ดความรู้ — มันจะเข้าไปเป็นแถวในตารางราคาที่ตัวกรองใช้")];
  }
  // "ไม่พบ" เป็นคำยืนยันที่ตัวจับคำพิสูจน์ไม่ได้ — พูดได้แค่ว่าระบบหาไม่เจอ
  const weakNote = searchIsWeak
    ? el("p", { class: "tc-weak" },
      "ระบบหาไม่เจอ ไม่ได้แปลว่าไม่มี — ถ้ารู้ว่ามีใบที่พูดเรื่องนี้อยู่ ให้ไปแก้ที่หน้าคลังความรู้แทน")
    : null;
  if (!related.length) {
    return [weakNote, el("p", { class: "kb-empty" }, "จะเป็นความรู้ใบใหม่")].filter(Boolean);
  }
  const pick = (id, label, hint) => el("button", {
    class: `kn-card tc-pick${targetId === id ? " is-picked" : ""}`,
    onclick: () => onPick(id),
  },
    el("span", { class: "tc-pick-title" }, label),
    hint ? el("span", { class: "tc-pick-hint" }, hint) : null,
  );
  return [
    weakNote,
    pick("", "＋ สร้างความรู้ใบใหม่", "ใช้เมื่อยังไม่มีใบไหนพูดเรื่องนี้"),
    ...related.map((card) => pick(card.id, card.title,
      `${card.excerpt}${card.weak ? " · ใกล้เคียงน้อย" : ""}`)),
  ].filter(Boolean);
}

// ชื่อรายการราคาที่ต่างกันแค่ช่องว่าง/ตัวพิมพ์ คือชื่อเดียวกัน (ฝั่งเซิร์ฟเวอร์กันอีกชั้น)
export function samePriceLabel(a, b) {
  const normal = (value) => String(value || "").normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
  return normal(a) !== "" && normal(a) === normal(b);
}

// กุญแจสั้น ๆ ที่คงที่ต่อเนื้อหาเดียวกัน — ใช้กันการส่งซ้ำ ไม่ใช่ความปลอดภัย
export function hash32(text) {
  let h = 2166136261;
  const value = String(text || "");
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
