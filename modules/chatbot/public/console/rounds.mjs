// rounds.mjs — หน้า "ที่นั่ง" (#/rounds): ทีมงานกรอกจำนวนที่นั่งคงเหลือของแต่ละรอบ
//
// ออกแบบให้ทำงานเดียวจบเร็วที่สุด เพราะคนที่ใช้หน้านี้กำลังคุยกับลูกค้าอยู่ในอีกจอ:
// เห็นทุกรอบพร้อมกัน กรอกเลขแล้วบันทึกได้ทันทีจากช่องนั้นเลย ไม่มีฟอร์มซ้อน ไม่มีหน้าถัดไป
//
// วันที่แก้ที่นี่ไม่ได้ตั้งใจ — วันเรียนมาจากไฟล์รอบเรียนซึ่งยึดตามปฏิทินจริง
// ถ้าหน้านี้แก้วันได้ด้วย จะกลายเป็นความจริงสองชุดที่ขัดกันเอง
import { el } from "./dom.mjs";
import { publishLabel, publishQueueHint, publishToast } from "./publishQueue.mjs";

// v1.4.35 (พี่ง้วงสั่ง 2026-08-19): กรอกเลขเดียวกับที่รายงานในกลุ่ม LINE
// ("ลงทะเบียนแล้ว = 7") แล้วระบบแปลงเป็น "เหลือกี่ที่" ให้เอง
// คนกรอกไม่ต้องคิดเลขในหัวก่อน = ลดโอกาสกรอกผิดตอนงานยุ่ง
const HELP = [
  // 28 ก.ย. 2026 (พี่ง้วง): "ใส่ตรงที่นั่งเมนูอย่างเดียว และลูกแพรเอาตรงนั้นไปใช้"
  "รอบที่เพิ่ม/ลบในหน้านี้ = รายการรอบที่ลูกแพรเสนอลูกค้า (ที่เดียว ไม่ต้องแก้การ์ดในคลังความรู้) · ถึงวันเรียนแล้วปิดรับเอง",
  "กรอกเลขเดียวกับที่รายงานในกลุ่ม LINE ได้เลย — “ลงทะเบียนแล้ว = 7” ก็พิมพ์ 7",
  "ระบบคิด “เหลือกี่ที่” ให้เอง จากฐาน 15 ท่านต่อรอบ (7 คน = เหลือ 8 ที่)",
  "ปล่อยว่าง = ลูกแพรพูดว่า “ที่นั่งจำนวนจำกัด ยืนยันตามลำดับการชำระ”",
  "ลงครบ 15 (หรือเกิน) = รอบนี้เต็ม ลูกแพรจะแจ้งเต็มพร้อมเสนอรอบถัดไปให้ทันที",
  "คลาสออนไลน์ที่รับไม่จำกัด: เว้นช่องที่นั่งว่างตอนเพิ่มรอบ — ลูกแพรจะไม่บอกตัวเลขที่นั่ง "
    + "และไม่พูดคำว่า “ไม่จำกัด” แต่จะบอกว่า “ราคาพิเศษมีจำนวนจำกัด”",
];

export function createRoundsPage({ api, toast, mount, pageHeader, tabBar, stopPolling, state }) {
  // 2 ก.ย. 2026 (คำสั่งพี่ง้วง): "ตัวรอบเรียน" เข้าไปเป็นข้อมูลตั้งต้นของลูกแพร
  // (seatRuleLines ฉีดวันเรียน/ที่นั่งเข้า prompt) การเพิ่มหรือลบรอบจึงเป็นของเจ้าของ
  // ส่วนช่อง "ลงทะเบียนแล้วกี่คน" ยังเป็นงานประจำวันของทีม — ต้องกรอกได้เหมือนเดิมทุกคน
  //
  // Package K: ทีมงานกรอกรอบใหม่ได้แล้ว กดแล้วเซิร์ฟเวอร์เก็บเป็นคำขอรอพี่ง้วงอนุมัติ
  // หน้านี้เปลี่ยนแค่ป้ายปุ่มกับ toast — ด่านจริงยังอยู่ฝั่งเซิร์ฟเวอร์เหมือนเดิม
  const canManageRounds = () => state?.me?.capabilities?.includes("rules.manage") === true;

  return async function renderRounds() {
    stopPolling();
    const data = await api("/console/api/class-rounds");
    const rounds = data.rounds || [];

    // v1.4.34: หลอดพลังแบบเกมตู้ — ที่นั่งเหลือเยอะ = เขียว ไล่ไป เหลือง ส้ม แดง
    // และเต็ม = ดำ + SOLD OUT
    // ทำด้วย CSS ล้วน ไม่ใช้รูป เพราะหลอดต้องเปลี่ยนตามตัวเลขแบบสด ๆ ทุกครั้งที่กรอก
    // รูปที่ generate มาจะกลายเป็นภาพนิ่งที่ต้องมี 16 เวอร์ชัน และคมไม่เท่าตอนซูม
    const gauge = (seatsLeft, capacity, unlimited = false) => {
      // คลาสออนไลน์ไม่มีลิมิตที่นั่ง — ไม่มีหลอดให้แสดง
      if (unlimited) return el("div", { class: "gauge is-unknown" }, el("span", { class: "gauge-fill gw-10" }));
      if (seatsLeft === null) return el("div", { class: "gauge is-unknown" }, el("span", { class: "gauge-fill" }));
      if (seatsLeft === 0) {
        return el("div", { class: "gauge is-soldout" },
          el("span", { class: "gauge-fill" }),
          el("span", { class: "gauge-soldout" }, "SOLD OUT"),
        );
      }
      const ratio = Math.min(1, seatsLeft / (capacity || 15));
      // ระดับสีอิงจาก "เหลือกี่ที่" ไม่ใช่สัดส่วน — คนอ่านคิดเป็นจำนวนที่นั่ง ไม่ใช่ %
      const level = seatsLeft <= 2 ? "danger" : seatsLeft <= 4 ? "warn" : seatsLeft <= 7 ? "mid" : "safe";
      // ความยาวหลอดต้องมาจาก "คลาส" ไม่ใช่ style ในแท็ก — CSP ของคอนโซลตั้ง
      // style-src 'self' (ไม่มี unsafe-inline) ซึ่งถูกต้องด้านความปลอดภัย แปลว่า
      // inline style ถูกบล็อกเงียบ ๆ: แอตทริบิวต์ติดอยู่บน DOM แต่เบราว์เซอร์ไม่ใช้
      // (เจอจริงตอนทำ: ตั้ง width 8-80% แต่ทุกหลอดยาวเท่ากันหมด)
      const step = Math.max(1, Math.ceil(ratio * 10));
      return el("div", { class: `gauge is-${level}` },
        el("span", { class: `gauge-fill gw-${step}` }),
      );
    };

    const row = (round, refresh) => {
      const input = el("input", {
        class: "seat-input keep-focus",
        type: "number", min: "0", max: "999", inputmode: "numeric",
        placeholder: "—",
        value: round.enrolled === null ? "" : String(round.enrolled),
      });

      const save = async () => {
        const raw = input.value.trim();
        try {
          await api("/console/api/class-rounds", {
            method: "POST",
            body: { date: round.date, enrolled: raw === "" ? null : Number(raw) },
          });
          // ยืนยันกลับเป็น "เหลือกี่ที่" เสมอ เพื่อให้คนกรอกเห็นทันทีว่าระบบแปลงถูกไหม
          const left = raw === "" ? null : Math.max(0, round.capacity - Number(raw));
          toast(raw === "" ? `${round.thai}: กลับไปใช้ข้อความจำนวนจำกัด` :
            left === 0 ? `${round.thai}: ลง ${Number(raw)} คน = เต็มแล้ว — ลูกแพรจะเสนอรอบถัดไปให้` :
            `${round.thai}: ลง ${Number(raw)} คน = เหลือ ${left} ที่`);
          await refresh();
        } catch (err) {
          toast(`บันทึกไม่สำเร็จ: ${err.message}`, "error");
        }
      };

      // Enter = บันทึกทันที (คนกรอกเลขมักกด Enter มากกว่าเลื่อนไปกดปุ่ม)
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") { event.preventDefault(); save(); }
      });

      const unlimited = round.unlimited === true;
      if (unlimited) { input.disabled = true; input.placeholder = "ไม่จำกัด"; }
      const full = round.seatsLeft === 0 && round.enrolled !== null;
      // สีต่อคลาส: ผูกกับ classKey ไม่ใช่ชื่อที่แสดง — เปลี่ยนชื่อคลาสแล้วสีต้องไม่หลุด
      const tone = round.classKey === "advance" ? "advance" : "basic";
      return el("tr", { class: full ? "is-full" : "" },
        el("td", { class: "seat-date" }, round.thai),
        el("td", { class: "seat-class" },
          el("span", { class: `class-badge class-${tone}` }, round.label)),
        el("td", { class: "seat-cell" }, input),
        el("td", { class: "seat-state" },
          gauge(round.seatsLeft, round.capacity, unlimited),
          el("span", { class: "seat-word" },
            unlimited ? "ราคาพิเศษมีจำนวนจำกัด"
              : round.seatsLeft === null ? "จำนวนจำกัด"
              : full ? (round.overbooked > 0 ? `เต็มแล้ว (เกิน ${round.overbooked})` : "เต็มแล้ว")
              : `เหลือ ${round.seatsLeft} ที่`),
        ),
        el("td", { class: "seat-actions" },
          // ปุ่มบันทึกที่นั่งต้องอยู่ครบทุกบทบาท — นี่คืองานที่ทีมทำระหว่างคุยกับลูกค้า
          unlimited ? null : el("button", { class: "btn small", onclick: save }, "บันทึก"),
          el("button", {
            class: "btn small btn-ghost",
            title: canManageRounds() ? "ลบรอบเรียนนี้" : "ส่งคำขอลบรอบนี้ให้พี่ง้วงอนุมัติ",
            onclick: async () => {
              const question = canManageRounds()
                ? `ลบรอบ ${round.thai} (${round.label}) ออกจากตาราง?\n\nลูกแพรจะไม่พูดถึงรอบนี้กับลูกค้าอีก`
                : `ส่งคำขอลบรอบ ${round.thai} (${round.label}) ให้พี่ง้วงอนุมัติ?`;
              if (!window.confirm(question)) return;
              try {
                const result = await api("/console/api/class-rounds/round-delete", { method: "POST", body: { date: round.date } });
                toast(publishToast(result, `ลบรอบ ${round.thai} แล้ว`));
                await refresh();
              } catch (err) { toast(`ลบไม่สำเร็จ: ${err.message}`, "error"); }
            },
          }, publishLabel(canManageRounds(), "ลบ", "ขอให้ลบ")),
        ),
      );
    };

    const refresh = async () => { await renderRounds(); };

    // ===== เพิ่มรอบเรียนเอง (คำสั่งพี่ง้วง 2026-08-26) =====
    // เดิมวันเรียนมาจากไฟล์ในตัว release แก้ไม่ได้จากหน้านี้ ต้องรอ release ถัดไป
    const newDate = el("input", { class: "keep-focus", type: "date" });
    const newLabel = el("input", {
      class: "keep-focus", type: "text", maxlength: "80",
      placeholder: "ชื่อคลาส เช่น Classroom AI Agent for Business",
    });
    const newCap = el("input", {
      class: "keep-focus", type: "number", min: "1", max: "999", inputmode: "numeric",
      placeholder: "เว้นว่าง = ไม่จำกัด (ออนไลน์)",
    });
    const addRound = async () => {
      const date = newDate.value.trim();
      const label = newLabel.value.trim();
      if (!date || !label) return toast("ต้องใส่วันเรียนและชื่อคลาส", "error");
      const capRaw = newCap.value.trim();
      try {
        const result = await api("/console/api/class-rounds/round", {
          method: "POST",
          body: {
            date, label,
            capacity: capRaw === "" ? null : Number(capRaw),
            classKey: /workflow|automation/iu.test(label) ? "advance" : "basic",
          },
        });
        toast(publishToast(result, capRaw === ""
          ? `เพิ่มรอบ ${date} แล้ว — ไม่จำกัดที่นั่ง ลูกแพรจะบอกว่า "ราคาพิเศษมีจำนวนจำกัด"`
          : `เพิ่มรอบ ${date} แล้ว — ${capRaw} ที่นั่ง`));
        newDate.value = ""; newLabel.value = ""; newCap.value = "";
        await refresh();
      } catch (err) { toast(`เพิ่มไม่สำเร็จ: ${err.message}`, "error"); }
    };
    // Package K: ทีมงานกรอกได้เต็มฟอร์ม กดแล้วกลายเป็นคำขอ — ต่างจากเดิมที่ล็อกช่องไว้
    // แล้วต้องไปพิมพ์ให้พี่ง้วงในแชทอีกรอบ (ซึ่งของจริงคือ "งานหาย")
    const canPublishRounds = canManageRounds();
    const addForm = el("section", { class: "panel round-add" },
      el("h2", { class: "block-title" }, "เพิ่มรอบเรียน"),
      el("p", { class: "block-hint" },
        canPublishRounds
          ? "กรอกที่นี่แล้วมีผลกับลูกแพรทันที · เว้นช่องที่นั่งว่างไว้สำหรับคลาสออนไลน์ที่รับได้ไม่จำกัด "
            + "— ลูกแพรจะไม่บอกตัวเลขที่นั่ง แต่จะบอกว่า “ราคาพิเศษมีจำนวนจำกัด”"
          : "กรอกแล้วกดส่ง — พี่ง้วงจะเห็นคำขอในหน้าตั้งค่า · เว้นช่องที่นั่งว่างไว้สำหรับคลาสออนไลน์ที่รับได้ไม่จำกัด"),
      canPublishRounds ? null : publishQueueHint(),
      el("div", { class: "round-add-row" }, newDate, newLabel, newCap,
        el("button", { class: "btn btn-primary small", onclick: addRound },
          publishLabel(canPublishRounds, "เพิ่มรอบ"))),
    );

    // ครอบด้วย page-scroll/page-inner เหมือนหน้าอื่น — เดิมวางตรงใน #app (overflow: hidden)
    // รอบเยอะแล้วเลื่อนลงไม่ถึงแถวล่าง และเนื้อหาชิดขอบจอ (พบตอนตรวจธีมลูกแพร 28 ก.ย. 2026)
    mount(
      pageHeader("ที่นั่งคงเหลือ", "กรอกรอบเรียนและจำนวนคนที่ลงทะเบียนแล้ว — มีผลกับลูกแพรทันที"),
      el("main", { class: "page-scroll" }, el("div", { class: "page-inner rounds-page" },
        addForm,
        rounds.length === 0
          ? el("p", { class: "empty" }, "ยังไม่มีรอบเรียนที่เปิดรับ — เพิ่มรอบแรกได้จากช่องด้านบน")
          : el("table", { class: "seat-table" },
              el("thead", {}, el("tr", {},
                el("th", {}, "วันเรียน"), el("th", {}, "คลาส"),
                el("th", {}, "ลงทะเบียนแล้ว (คน)"), el("th", {}, "ลูกแพรจะพูดว่า"), el("th", {}, ""))),
              el("tbody", {}, rounds.map((round) => row(round, refresh))),
            ),
        el("ul", { class: "seat-help" }, HELP.map((line) => el("li", {}, line))),
      )),
      tabBar(),
    );
  };
}
