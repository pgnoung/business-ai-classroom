// reviews.mjs — กล่อง "คลังรีวิว" ในหน้าคลังความรู้ (#/knowledge)
//
// ทำไมต้องมี (คำสั่งพี่ง้วง 1 ก.ย. 2026): ชมพู่เพิ่มรีวิวลูกค้าเรื่อย ๆ แต่ของเดิมต้องแก้เป็น
// ข้อความดิบทั้งก้อน พลาดรูปแบบทีเดียวรีวิวใบนั้นหายจากคลังเงียบ ๆ (เจอของจริงมาแล้ว 1 ใบ
// ที่ใส่เป็นลิงก์รีลแล้วบอทหยิบไม่ได้) กล่องนี้จึงกรอกเป็นช่อง แล้วให้ระบบประกอบรูปแบบให้
//
// หน้านี้ไม่ auto-refresh — ชมพู่กำลังพิมพ์อยู่ ห้าม re-render ทับ
import { el } from "./dom.mjs";

export function createReviewsSection({ api, toast, refresh }) {
  // ทำงานบนสำเนาในหน่วยความจำ กด "บันทึก" ครั้งเดียวถึงเขียนจริง
  let draft = null;
  let dirty = false;

  function markDirty(saveBtn, status) {
    dirty = true;
    saveBtn.disabled = false;
    status.textContent = "มีการแก้ไขที่ยังไม่ได้บันทึก";
    status.className = "rv-status rv-dirty";
  }

  function itemRow(section, item, index, rerender, saveBtn, status) {
    const whoInput = el("input", {
      class: "rv-who keep-focus", type: "text", value: item.who, maxlength: "200",
      placeholder: "เช่น คุณเอ — เจ้าของคลินิกความงาม",
    });
    whoInput.addEventListener("input", () => { item.who = whoInput.value; markDirty(saveBtn, status); });
    const urlInput = el("input", {
      class: "rv-url keep-focus", type: "url", value: item.url, maxlength: "500",
      placeholder: "https://www.facebook.com/share/r/...",
    });
    urlInput.addEventListener("input", () => { item.url = urlInput.value.trim(); markDirty(saveBtn, status); });
    return el("div", { class: "rv-row" },
      el("span", { class: "rv-no" }, String(index + 1)),
      el("div", { class: "rv-fields" }, whoInput, urlInput),
      el("button", {
        class: "btn btn-ghost rv-del", title: "ลบรีวิวนี้",
        onclick: () => {
          if (!globalThis.confirm(`ลบรีวิว "${item.who || "(ไม่มีชื่อ)"}" ออกจากคลัง?`)) return;
          section.items.splice(index, 1);
          markDirty(saveBtn, status);
          rerender();
        },
      }, "ลบ"),
    );
  }

  function sectionCard(section, rerender, saveBtn, status) {
    return el("div", { class: "rv-group" },
      el("div", { class: "rv-group-head" },
        el("span", { class: "rv-group-name" }, section.name),
        el("span", { class: "kb-count" }, String(section.items.length)),
      ),
      el("div", { class: "rv-rows" },
        section.items.length
          ? section.items.map((item, index) => itemRow(section, item, index, rerender, saveBtn, status))
          : el("p", { class: "kb-empty" }, "กลุ่มนี้ยังไม่มีรีวิว"),
      ),
      el("button", {
        class: "btn btn-ghost rv-add",
        onclick: () => {
          section.items.push({ who: "", url: "" });
          markDirty(saveBtn, status);
          rerender();
        },
      }, "+ เพิ่มรีวิวในกลุ่มนี้"),
    );
  }

  async function build() {
    const data = await api("/console/api/reviews").catch(() => null);
    if (!data?.ok) {
      return el("p", { class: "kb-empty" }, "โหลดคลังรีวิวไม่สำเร็จ — ลองรีเฟรชหน้านี้อีกครั้ง");
    }
    draft = data.sections.map((s) => ({ name: s.name, items: s.items.map((i) => ({ ...i })) }));
    dirty = false;

    const status = el("span", { class: "rv-status" }, `บันทึกล่าสุดโดย ${data.updatedBy || "—"}`);
    const saveBtn = el("button", { class: "btn btn-primary" }, "บันทึกคลังรีวิว");
    saveBtn.disabled = true;
    const body = el("div", { class: "rv-body" });

    function rerender() {
      body.replaceChildren(...draft.map((section) => sectionCard(section, rerender, saveBtn, status)));
    }
    rerender();

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      status.textContent = "กำลังบันทึก…";
      status.className = "rv-status";
      try {
        const result = await api("/console/api/reviews", {
          method: "PUT",
          body: { sections: draft },
        });
        dirty = false;
        status.textContent = `บันทึกแล้ว — คลังมีรีวิว ${result.total} รายการ`;
        status.className = "rv-status rv-ok";
        toast(`บันทึกคลังรีวิวแล้ว (${result.total} รายการ) ลูกแพรหยิบไปใช้ได้ทันที`);
        await refresh();
      } catch (err) {
        status.textContent = String(err?.message || err);
        status.className = "rv-status rv-bad";
        saveBtn.disabled = false;
        toast(String(err?.message || err));
      }
    });

    // เตือนก่อนออกจากหน้าเมื่อยังไม่บันทึก — พิมพ์รีวิวยาว ๆ แล้วหายคือเสียเวลาฟรี
    globalThis.addEventListener("beforeunload", (event) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    });

    return el("div", { class: "rv-wrap" },
      el("p", { class: "block-hint" },
        "ช่องบนคือ “ใครรีวิว” — ระบบใช้ข้อความนี้จับคู่รีวิวกับธุรกิจของลูกค้า " +
        "เขียนตำแหน่งและประเภทธุรกิจให้ชัด (เช่น “คุณบี — ธุรกิจคลินิกความงาม”) " +
        "ลูกค้าคลินิกจะได้เห็นรีวิวคลินิก ไม่ใช่รีวิวโรงงาน"),
      el("p", { class: "block-hint" },
        "ลิงก์ต้องเป็นของ Facebook แบบ /share/, /reel/, /watch/, /videos/ หรือ /posts/ เท่านั้น — " +
        "แบบอื่นบอทหยิบไปส่งไม่ได้ ระบบจะเตือนตอนกดบันทึก"),
      body,
      el("div", { class: "rv-actions" }, saveBtn, status),
    );
  }

  return build;
}
