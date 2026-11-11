// orders.mjs — หน้า "ออเดอร์" (#/orders) — G6 P2
// รายการออเดอร์ + chip กรองสถานะ (นับจริงจาก SQL) + การ์ดออเดอร์: รายการแก้ได้
// เฉพาะตอนเป็นร่าง, ลิงก์เข้าห้องแชทลูกค้า, ป้ายสาขา (โหมดหลายสาขา), ผลสลิปที่แนบ,
// ปุ่มเดินสถานะตาม flow ร่าง → ยืนยัน → จ่าย → ส่ง → จบ (ยกเลิกได้ทุกขั้นที่ยังไม่จบ)
// การยืนยันทุกขั้นเป็นการกดของคน (human-confirms-money) — AI สร้างได้แค่ร่าง
import { el, timeAgo } from "./dom.mjs";
import { emptyArt, orderStatusBadge, orderStatusMetaFor, orderTotalLabel } from "./ui.mjs";
import { createExportControls } from "./exportUi.mjs";

const FILTERS = [
  { key: null, label: "ทั้งหมด", countKey: "all" },
  { key: "draft", label: "ร่าง", countKey: "draft" },
  { key: "confirmed", label: "ยืนยันแล้ว", countKey: "confirmed" },
  { key: "paid", label: "จ่ายแล้ว", countKey: "paid" },
  { key: "shipped", label: "จัดส่งแล้ว", countKey: "shipped" },
  { key: "done", label: "จบ", countKey: "done" },
  { key: "cancelled", label: "ยกเลิก", countKey: "cancelled" },
];

// 7 ต.ค. 2026 โหมดคลาส (พี่ง้วง: "ออเดอร์เป็นระบบของคลาสพี่ง้วง ไม่ได้มีส่งของ") — ค่าสถานะเดิม คำใหม่ ไม่มีชิปจัดส่ง
const FILTERS_CLASS = [
  { key: null, label: "ทั้งหมด", countKey: "all" },
  { key: "draft", label: "ร่าง", countKey: "draft" },
  { key: "confirmed", label: "รอชำระ", countKey: "confirmed" },
  { key: "paid", label: "ชำระแล้ว", countKey: "paid" },
  { key: "done", label: "ลงทะเบียนแล้ว", countKey: "done" },
  { key: "cancelled", label: "ยกเลิก", countKey: "cancelled" },
];

const EMPTY_TEXT_CLASS = {
  confirmed: "ไม่มีออเดอร์ที่รอชำระ",
  paid: "ไม่มีออเดอร์ที่ชำระแล้วแต่ยังไม่ลงทะเบียน",
  done: "ยังไม่มีผู้เรียนที่ลงทะเบียนจากออเดอร์",
};

const EMPTY_TEXT = {
  all: "ยังไม่มีออเดอร์ — ระบบจะสร้าง \"ร่าง\" ให้อัตโนมัติเมื่อลูกค้าตกลงซื้อในแชท หรือสร้างเองจากแผงข้อมูลลูกค้า",
  draft: "ไม่มีออเดอร์ร่าง — ร่างใหม่จากแชทจะโผล่ที่นี่ให้ตรวจก่อนยืนยัน",
  confirmed: "ไม่มีออเดอร์ที่ยืนยันแล้ว",
  paid: "ไม่มีออเดอร์ที่จ่ายแล้ว",
  shipped: "ไม่มีออเดอร์ที่กำลังจัดส่ง",
  done: "ยังไม่มีออเดอร์ที่จบ",
  cancelled: "ไม่มีออเดอร์ที่ยกเลิก",
};

export function createOrdersPage({ api, toast, mount, pageHeader, tabBar, stopPolling, state, setView, channelName }) {
  let filter = null; // สถานะที่กรองอยู่ (null = ทั้งหมด) — คงไว้ข้าม poll
  // โหมดออเดอร์จากคำตอบ GET /orders ล่าสุด (เซิร์ฟเวอร์เป็นคนตัดสิน) · รอบเรียนที่เลือกได้ (โหมดคลาส)
  let mode = state.features?.orderMode === "class" ? "class" : "shipping";
  let classRounds = [];
  const isClass = () => mode === "class";
  const statusMeta = () => orderStatusMetaFor(mode);
  const infoTitle = () => (isClass() ? "ข้อมูลผู้เรียน" : "ข้อมูลจัดส่ง");

  function customerLabel(o) {
    return o.known_name || o.display_name || `ลูกค้า ${String(o.customer_id).slice(-6)}`;
  }

  function filterChips(counts, refresh) {
    // โหมดคลาสยังโชว์ชิป "จัดส่งแล้ว" ถ้ามีออเดอร์เก่าค้างสถานะนั้น (ไม่ซ่อนงานค้าง)
    const list = isClass()
      ? (Number(counts?.shipped) > 0 ? [...FILTERS_CLASS.slice(0, 4), FILTERS[4], ...FILTERS_CLASS.slice(4)] : FILTERS_CLASS)
      : FILTERS;
    return el("nav", { class: "inbox-filters order-filters", "aria-label": "กรองสถานะออเดอร์" },
      list.map((f) => el("button", {
        class: `fchip fchip-branch${(filter ?? null) === f.key ? " is-active" : ""}`,
        onclick: () => {
          if (filter === f.key) return;
          filter = f.key;
          refresh();
        },
        ...((filter ?? null) === f.key ? { "aria-current": "true" } : {}),
      }, f.label, el("span", { class: "fchip-count" }, String(counts?.[f.countKey] ?? 0)))),
    );
  }

  /* --------------------- ข้อมูลจัดส่ง (v1.1 — พี่ง้วงสั่ง) --------------------- */

  // ป้ายเตือนจากตัวตรวจฝั่ง server (เบอร์ 9 หลัก / ปณ.เพี้ยน / gmail.con ฯลฯ)
  function shippingWarningsEl(order) {
    const warnings = order.shippingWarnings || [];
    if (!warnings.length) return null;
    return el("div", { class: "ship-warnings" },
      warnings.map((w) => el("p", { class: "ship-warning" }, `⚠ ${w}`)));
  }

  // ฟอร์มที่อยู่จัดส่ง — ใช้ทั้งในร่าง (บันทึกรวมกับรายการ) และหลังยืนยัน (ปุ่มแยก)
  // คืน { fields, value() } — value() = ก้อน shipping จากฟอร์ม หรือ null ถ้าว่างหมด
  function shippingFields(order) {
    const s = order.shipping || {};
    const nameIn = el("input", {
      class: "order-in keep-focus", type: "text", maxlength: "100",
      placeholder: isClass() ? "ชื่อ-นามสกุลผู้เรียน" : "ชื่อ-นามสกุลผู้รับ", value: s.name || "",
    });
    const phoneIn = el("input", {
      class: "order-in keep-focus", type: "tel", maxlength: "30",
      placeholder: isClass() ? "เบอร์โทรผู้เรียน (มือถือ 10 หลัก)" : "เบอร์โทรผู้รับ (มือถือ 10 หลัก)", value: s.phone || "",
    });
    // โหมดคลาส: ที่อยู่ไม่บังคับ — ใช้ออกใบกำกับภาษี/ใบเสนอราคาเท่านั้น (พี่ง้วง 7 ต.ค.)
    const addressIn = el("textarea", {
      class: "order-in order-in-address keep-focus", rows: "2", maxlength: "300",
      placeholder: isClass()
        ? "ที่อยู่สำหรับใบกำกับภาษี / ใบเสนอราคา (ไม่บังคับ)"
        : "ที่อยู่จัดส่ง (บ้านเลขที่ ตำบล อำเภอ จังหวัด รหัสไปรษณีย์)",
    });
    addressIn.value = s.address || "";
    const emailIn = el("input", {
      class: "order-in keep-focus", type: "email", maxlength: "100",
      placeholder: isClass() ? "อีเมลผู้เรียน (ส่งรายละเอียดคลาส/ใบเสร็จ)" : "อีเมล (สำหรับใบเสร็จ — ไม่บังคับ)", value: s.email || "",
    });
    const fields = el("div", { class: "order-shipping-edit" },
      el("p", { class: "order-section-label" }, infoTitle()),
      ...(isClass() ? [nameIn, phoneIn, emailIn, addressIn] : [nameIn, phoneIn, addressIn, emailIn]),
    );
    return {
      fields,
      value: () => {
        const shipping = {
          name: nameIn.value.trim(), phone: phoneIn.value.trim(),
          address: addressIn.value.trim(), email: emailIn.value.trim(),
        };
        return shipping.name || shipping.phone || shipping.address || shipping.email ? shipping : null;
      },
    };
  }

  // หลังยืนยันแล้ว (confirmed/paid): โชว์ + แก้ที่อยู่ได้จนกว่าของจะออก
  function shippingReadonly(order, refresh) {
    const s = order.shipping;
    const editable = ["confirmed", "paid"].includes(order.status);
    const lines = s
      ? el("div", { class: "order-shipping-view" },
          el("p", { class: "order-section-label" }, infoTitle()),
          s.name ? el("p", {}, `${isClass() ? "ผู้เรียน" : "ผู้รับ"}: ${s.name}`) : null,
          s.phone ? el("p", {}, `โทร: ${s.phone}`) : null,
          s.email ? el("p", {}, `อีเมล: ${s.email}`) : null,
          s.address ? el("p", {}, isClass() ? `ที่อยู่ (ใบกำกับ/ใบเสนอราคา): ${s.address}` : s.address) : null,
        )
      : (editable ? el("p", { class: "order-empty-items" }, `ยังไม่มี${infoTitle()}`) : null);
    if (!editable) return lines;
    const editBtn = el("button", {
      class: "btn btn-outline btn-mini",
      onclick: () => {
        const editor = shippingFields(order);
        const saveBtn = el("button", {
          class: "btn btn-primary btn-mini",
          onclick: async () => {
            saveBtn.disabled = true;
            try {
              await api(`/console/api/orders/${encodeURIComponent(order.id)}`, {
                method: "POST", body: { shipping: editor.value() },
              });
              toast(`บันทึก${infoTitle()}ออเดอร์ #${order.order_no} แล้ว`);
              await refresh();
            } catch (err) {
              toast(err.message);
              saveBtn.disabled = false;
            }
          },
        }, isClass() ? "บันทึกข้อมูลผู้เรียน" : "บันทึกที่อยู่");
        wrap.replaceChildren(editor.fields, el("div", { class: "block-actions" }, saveBtn));
      },
    }, isClass() ? (s ? "แก้ข้อมูลผู้เรียน" : "+ ใส่ข้อมูลผู้เรียน") : (s ? "แก้ที่อยู่" : "+ ใส่ที่อยู่จัดส่ง"));
    const wrap = el("div", { class: "order-shipping-wrap" }, lines, editBtn);
    return wrap;
  }

  /* ------------------------- แก้รายการ (เฉพาะร่าง) ------------------------- */

  function draftEditor(order, refresh) {
    let items = [];
    try {
      items = (JSON.parse(order.items_json || "[]") || []).map((it) => ({ ...it }));
    } catch {
      items = [];
    }
    const list = el("div", { class: "order-items-edit" });

    function itemRow(it) {
      const nameInput = el("input", {
        class: "order-in order-in-name keep-focus", type: "text", maxlength: "100",
        placeholder: "ชื่อสินค้า/รุ่น", value: it.name || "",
        oninput: (e) => { it.name = e.target.value; },
      });
      const qtyInput = el("input", {
        class: "order-in order-in-qty keep-focus", type: "number", min: "1", max: "99",
        value: String(it.qty ?? 1), "aria-label": "จำนวน",
        oninput: (e) => { it.qty = e.target.value; },
      });
      const priceInput = el("input", {
        class: "order-in order-in-price keep-focus", type: "number", min: "0", step: "0.01",
        placeholder: "ราคา/ชิ้น", value: it.price == null ? "" : String(it.price), "aria-label": "ราคาต่อชิ้น",
        oninput: (e) => { it.price = e.target.value === "" ? null : e.target.value; },
      });
      const row = el("div", { class: "order-item-row" },
        nameInput, qtyInput, priceInput,
        el("button", {
          class: "icon-del", "aria-label": "ลบรายการนี้", title: "ลบรายการนี้",
          onclick: () => {
            items = items.filter((x) => x !== it);
            row.remove();
          },
        }, "✕"),
      );
      return row;
    }

    for (const it of items) list.append(itemRow(it));

    const totalInput = el("input", {
      class: "order-in order-in-total keep-focus", type: "number", min: "0", step: "0.01",
      placeholder: "ยอดรวม (บาท)", value: order.total == null ? "" : String(order.total),
      "aria-label": "ยอดรวม",
    });
    const noteInput = el("input", {
      class: "order-in order-in-note keep-focus", type: "text", maxlength: "500",
      placeholder: "โน้ต (ไม่บังคับ)", value: order.note || "",
    });

    const sumBtn = el("button", {
      class: "btn btn-outline btn-mini",
      onclick: () => {
        // รวมจากรายการที่มีราคาครบทุกแถว — แถวไหนไม่มีราคา = รวมไม่ได้ (ให้คนตัดสิน)
        if (!items.length || items.some((it) => it.price == null || it.price === "" || !Number.isFinite(Number(it.price)))) {
          toast("ใส่ราคาให้ครบทุกรายการก่อน ถึงจะรวมอัตโนมัติได้");
          return;
        }
        const sum = items.reduce((acc, it) => acc + Number(it.price) * (Number(it.qty) || 1), 0);
        totalInput.value = String(sum);
      },
    }, "รวมยอดอัตโนมัติ");

    // v1.1: ที่อยู่จัดส่งอยู่ในฟอร์มร่างเลย — บันทึกทีเดียวพร้อมรายการ (ต่อ Google Sheet ได้ครบ)
    const shipEditor = shippingFields(order);

    const saveBtn = el("button", {
      class: "btn btn-primary btn-mini",
      onclick: async () => {
        const cleaned = items
          .map((it) => ({
            name: String(it.name || "").trim(),
            qty: Math.trunc(Number(it.qty)) || 1,
            price: it.price == null || it.price === "" ? null : Number(it.price),
          }))
          .filter((it) => it.name);
        const total = totalInput.value === "" ? null : Number(totalInput.value);
        saveBtn.disabled = true;
        try {
          await api(`/console/api/orders/${encodeURIComponent(order.id)}`, {
            method: "POST", body: { items: cleaned, total, note: noteInput.value, shipping: shipEditor.value() },
          });
          toast(`บันทึกออเดอร์ #${order.order_no} แล้ว`);
          await refresh();
        } catch (err) {
          toast(err.message);
          saveBtn.disabled = false;
        }
      },
    }, "บันทึกรายการ");

    return el("div", { class: "order-edit" },
      list,
      el("button", {
        class: "btn btn-outline btn-mini",
        onclick: () => {
          const it = { name: "", qty: 1, price: null };
          items.push(it);
          list.append(itemRow(it));
        },
      }, "+ เพิ่มรายการ"),
      el("div", { class: "order-edit-row" },
        el("label", { class: "order-total-label" }, "ยอดรวม", totalInput),
        sumBtn,
      ),
      noteInput,
      shipEditor.fields,
      el("div", { class: "block-actions" }, saveBtn),
    );
  }

  /* ------------------------- รอบเรียน (โหมดคลาส · 7 ต.ค. 2026) ------------------------- */

  // ผูกรอบเรียนกับออเดอร์ — กด "ชำระแล้ว" แล้วระบบลงชื่อผู้เรียนเข้ารอบนั้นให้ (consoleOrdersApi enrollFromOrder)
  function classRoundPicker(order, refresh) {
    const current = order.classRound;
    const editable = ["draft", "confirmed", "paid"].includes(order.status);
    if (!editable) {
      return current ? el("p", { class: "order-round" }, `รอบเรียน: ${current.label || current.classKey} · ${current.date}`) : null;
    }
    const keyOf = (r) => `${r.date}|${r.classKey}`;
    const known = classRounds.some((r) => current && keyOf(r) === keyOf(current));
    const select = el("select", {
      class: "order-in order-round-select",
      "aria-label": "รอบเรียนของออเดอร์นี้",
      onchange: async () => {
        const picked = classRounds.find((r) => keyOf(r) === select.value) || null;
        select.disabled = true;
        try {
          await api(`/console/api/orders/${encodeURIComponent(order.id)}`, {
            method: "POST", body: { classRound: picked ? { date: picked.date, classKey: picked.classKey, label: picked.label } : null },
          });
          toast(picked ? `ผูกออเดอร์ #${order.order_no} กับรอบ ${picked.thai || picked.date} แล้ว` : `ล้างรอบเรียนของออเดอร์ #${order.order_no} แล้ว`);
          await refresh();
        } catch (err) {
          toast(err.message);
          select.disabled = false;
        }
      },
    },
    el("option", { value: "" }, classRounds.length ? "— เลือกรอบเรียน —" : "ยังไม่มีรอบที่เปิด (เพิ่มได้ที่หน้า ที่นั่ง)"),
    current && !known ? el("option", { value: keyOf(current), selected: "" }, `${current.label || current.classKey} · ${current.date} (รอบนี้ปิดแล้ว)`) : null,
    classRounds.map((r) => el("option", { value: keyOf(r), ...(current && keyOf(r) === keyOf(current) ? { selected: "" } : {}) },
      `${r.label} · ${r.thai || r.date}`)));
    return el("div", { class: "order-round-wrap" },
      el("p", { class: "order-section-label" }, "รอบเรียน"),
      select,
      order.status !== "paid" ? el("p", { class: "order-round-hint" }, "กด \"ชำระแล้ว\" แล้วระบบลงชื่อผู้เรียนเข้ารอบนี้ให้เอง") : null,
    );
  }

  /* ------------------------------ การ์ดออเดอร์ ------------------------------ */

  function itemsReadonly(order) {
    let items = [];
    try {
      items = JSON.parse(order.items_json || "[]") || [];
    } catch {
      items = [];
    }
    if (!items.length) return el("p", { class: "order-empty-items" }, "ยังไม่มีรายการสินค้า");
    return el("div", { class: "order-items" },
      items.map((it) => el("div", { class: "order-item" },
        el("span", { class: "order-item-name" }, it.name),
        el("span", { class: "order-item-qty" }, `×${it.qty}`),
        el("span", { class: "order-item-price" },
          Number.isFinite(it.price) ? `฿${Number(it.price).toLocaleString("th-TH")}` : "ราคายังไม่ยืนยัน"),
      )),
    );
  }

  function actionButtons(order, refresh) {
    const meta = statusMeta()[order.status] || {};
    const buttons = [];
    if (meta.next) {
      buttons.push(el("button", {
        class: "btn btn-primary btn-mini",
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            await api(`/console/api/orders/${encodeURIComponent(order.id)}/status`, {
              method: "POST", body: { status: meta.next },
            });
            toast(`ออเดอร์ #${order.order_no} → ${statusMeta()[meta.next].label}`);
            await refresh();
          } catch (err) {
            toast(err.message);
            e.target.disabled = false;
          }
        },
      }, meta.nextLabel));
      buttons.push(el("button", {
        class: "btn btn-danger btn-mini",
        onclick: async (e) => {
          if (!window.confirm(`ยกเลิกออเดอร์ #${order.order_no} — ยืนยันไหม?`)) return;
          e.target.disabled = true;
          try {
            await api(`/console/api/orders/${encodeURIComponent(order.id)}/status`, {
              method: "POST", body: { status: "cancelled" },
            });
            toast(`ยกเลิกออเดอร์ #${order.order_no} แล้ว`);
            await refresh();
          } catch (err) {
            toast(err.message);
            e.target.disabled = false;
          }
        },
      }, "ยกเลิก"));
    }
    return buttons.length ? el("div", { class: "order-actions" }, buttons) : null;
  }

  function orderCard(order, refresh) {
    const multiChannel = (state.channels?.length ?? 0) > 1;
    const isDraft = order.status === "draft";
    return el("article", { class: `order-card order-card-${order.status}` },
      el("div", { class: "order-head" },
        el("span", { class: "order-no" }, `#${order.order_no}`),
        el("a", { class: "order-customer", href: `#/c/${encodeURIComponent(order.customer_id)}` },
          `${customerLabel(order)} ›`),
        orderStatusBadge(order.status, mode),
        multiChannel && order.channel_id
          ? el("span", { class: "badge badge-branch" }, channelName?.(order.channel_id) || order.channel_id)
          : null,
      ),
      el("div", { class: "order-meta" },
        el("span", {}, order.created_by === "ai" ? "สร้างโดยระบบจากแชท" : `สร้างโดย ${order.created_by || "ทีมงาน"}`),
        el("span", {}, ` · ${timeAgo(order.updated_at)}`),
        order.slip_check_id ? el("span", { class: "badge badge-orange order-slip" }, "มีสลิปแนบ") : null,
      ),
      shippingWarningsEl(order),
      isDraft ? draftEditor(order, refresh) : itemsReadonly(order),
      isDraft ? null : shippingReadonly(order, refresh),
      isClass() ? classRoundPicker(order, refresh) : null,
      isDraft ? null : el("p", { class: "order-total" }, "ยอดรวม: ",
        el("strong", {}, orderTotalLabel(order.total))),
      !isDraft && order.note ? el("p", { class: "order-note" }, order.note) : null,
      isDraft && order.created_by === "ai"
        ? el("p", { class: "order-ai-hint" }, "ร่างจากบทสนทนา — ตรวจรายการและราคาก่อนยืนยันเสมอ")
        : null,
      actionButtons(order, refresh),
    );
  }

  /* --------------------------------- render --------------------------------- */

  async function renderOrders() {
    stopPolling();
    const params = new URLSearchParams({ limit: "50" });
    if (filter) params.set("status", filter);
    if (state.channel) params.set("channel", state.channel);
    const data = await api(`/console/api/orders?${params.toString()}`);
    const rows = data.orders || [];
    mode = data.orderMode === "class" ? "class" : "shipping";
    classRounds = Array.isArray(data.classRounds) ? data.classRounds : [];

    mount(
      pageHeader("ออเดอร์"),
      el("main", { class: "page-scroll" }, el("div", { class: "page-inner" },
        el("p", { class: "kb-lede" }, isClass()
          ? "ระบบสร้าง \"ร่าง\" ให้อัตโนมัติเมื่อลูกค้าตกลงสมัครคลาสในแชท — คนตรวจแล้วกดยืนยันเองทุกขั้น: ยืนยันออเดอร์ → ชำระแล้ว → ลงทะเบียนเรียนแล้ว"
          : "ระบบสร้าง \"ร่าง\" ให้อัตโนมัติเมื่อลูกค้าตกลงซื้อในแชท — คนตรวจแล้วกดยืนยันเองทุกขั้น ไม่มีการคุยเรื่องเงินกับลูกค้าอัตโนมัติ"),
        filterChips(data.counts, renderOrders),
        el("div", { class: "order-list" },
          rows.length === 0
            ? el("div", { class: "empty-state" },
                emptyArt(),
                el("p", { class: "empty-title" }, "ไม่มีออเดอร์ในกลุ่มนี้"),
                el("p", { class: "empty-sub" }, (isClass() && EMPTY_TEXT_CLASS[filter]) || EMPTY_TEXT[filter || "all"]))
            : rows.map((o) => orderCard(o, renderOrders)),
        ),
        el("section", { class: "block export-block" },
          el("h2", { class: "block-title" }, "Export ออเดอร์"),
          createExportControls({
            endpoint: "/console/api/orders/export",
            buttonLabel: "ดาวน์โหลดออเดอร์ (CSV)",
            channels: state.channels,
          }),
          el("p", { class: "block-hint" }, "ไฟล์ CSV เปิดใน Excel ได้ทันที (เวลาไทย)"),
        ),
      )),
      tabBar(),
    );
    setView("page");
    // หน้านี้ไม่ poll — operator อาจกำลังแก้รายการร่างค้างไว้ (แบบแผนเดียวกับหน้า
    // ตั้งค่า/ความรู้/คำแก้: ห้าม re-render ทับฟอร์ม) — ทุก action รีเฟรชหน้าเองอยู่แล้ว
  }

  return renderOrders;
}
