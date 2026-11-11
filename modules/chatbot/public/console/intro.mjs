// intro.mjs — หน้า "Intro · จักรวาลลูกแพร" (#/intro) — 28 ก.ย. 2026
//
// พี่ง้วงสั่ง: "ทำ intro … เดี๋ยวเราค่อยเอาขึ้นเว็บ ในเมนูใหม่สุดด้านขวา" — หน้านี้จึงปิดอยู่
// เป็นค่าเริ่มต้น (features.intro) จนเจ้าของกดเปิดที่หน้าภาพรวม
// - วิดีโออินโทร 60 วินาทียังไม่มีไฟล์: เซิร์ฟเวอร์บอกผ่าน /me (introMedia) ไม่มีไฟล์ = กรอบรอที่ตั้งใจ
//   ออกแบบ (ไม่โชว์กรอบวิดีโอดำ ๆ ที่เล่นไม่ได้) · เสิร์ฟไฟล์แบบ HTTP Range ได้ (Safari ต้องใช้)
// - คำยืม "แอดมิน" ตามด้วย \u200b: ตัวตัดคำไทยของเบราว์เซอร์ไม่รู้จักคำนี้แล้วตัดกลางคำถัดไป
// - ภาพลูกแพร/น้องเก้าใช้ของที่อนุมัติแล้วเท่านั้น น้องฝนยังเป็นภาพรออนุมัติ → การ์ดใช้ลายหยดฝน
//   ที่ไม่ใช่ตัวละครแทน จนกว่าพี่ง้วงอนุมัติภาพจริง
import { el } from "./dom.mjs";
import { icon } from "./icons.mjs";
import { svgNode } from "./charts.mjs";
import {
  INTRO_POSTER_SRC, INTRO_VIDEO_SRC, LUKPRAE_FRONT_SRC, NONGKAO_SRC, moodPortrait,
} from "./lukpraeArt.mjs";

const SISTERS = Object.freeze([
  {
    key: "lukprae", rank: "พี่สาวคนโต", name: "ลูกแพร",
    role: "ผู้ช่วยหน้าบ้านของพี่ง้วง ติดกระดุม",
    text: "ตอบแชท LINE และ Facebook ให้ลูกค้าได้คำตอบไวและสุภาพ พอถึงจังหวะที่ต้องใช้คน ลูกแพรส่งต่อให้ทีมพร้อมสรุปเรื่องให้เสร็จ",
    duties: ["ตอบแชท LINE", "ตอบ Facebook", "ส่งต่อทีม"],
    art: { src: LUKPRAE_FRONT_SRC, width: 572, height: 1244 },
  },
  {
    key: "nongkao", rank: "คนกลาง", name: "น้องเก้า",
    role: "ผู้ช่วยแอดมิน\u200bของทุกร้าน",
    text: "ร่างคำตอบแชทให้แอดมิน\u200bร้านค้าออนไลน์ อ่านบทสนทนาแล้วเสนอคำตอบที่ใช่ คนเป็นคนกดส่งเองทุกครั้ง",
    duties: ["ร่างคำตอบ", "ทุกร้านค้า", "คนกดส่ง"],
    art: { src: NONGKAO_SRC, width: 360, height: 540 },
  },
  {
    key: "nongfon", rank: "คนเล็ก", name: "น้องฝน",
    role: "เฝ้าบ้านยามฝนตก",
    text: "ดูกล้องวงจรปิดหน้าบ้านตอนฝนตก แล้วแจ้งเตือนทันทีเมื่อน้ำเริ่มท่วม ให้ครอบครัวเตรียมตัวทัน",
    duties: ["ดูกล้องวงจรปิด", "แจ้งน้ำท่วม"],
    art: null, // ภาพตัวละครรออนุมัติ (N43) — ใช้ลายหยดฝนแทน
  },
]);

// ลายหยดฝน + วงน้ำ (ไม่ใช่ตัวละคร) สำหรับการ์ดน้องฝนระหว่างรอภาพที่อนุมัติ
function rainMotif() {
  const svg = svgNode("svg", { class: "sister-motif", viewBox: "0 0 120 150", "aria-hidden": "true", focusable: "false" });
  svg.append(
    svgNode("path", { class: "motif-drop", d: "M60 18C49 38 34 55 34 76a26 26 0 0 0 52 0c0-21-15-38-26-58z" }),
    svgNode("path", { class: "motif-shine", d: "M50 70a12 12 0 0 0 6 16" }),
    svgNode("ellipse", { class: "motif-ripple", cx: "60", cy: "124", rx: "38", ry: "7" }),
    svgNode("ellipse", { class: "motif-ripple is-far", cx: "60", cy: "124", rx: "54", ry: "11" }),
  );
  return svg;
}

function sisterCard(sister) {
  const art = sister.art
    ? el("img", {
        class: "sister-img", src: sister.art.src, width: String(sister.art.width), height: String(sister.art.height),
        alt: `${sister.name} ${sister.rank}`, loading: "lazy", decoding: "async",
      })
    : rainMotif();
  return el("article", { class: `sister is-${sister.key}`, "aria-labelledby": `sister-${sister.key}` },
    el("div", { class: "sister-window" }, art,
      sister.art ? null : el("span", { class: "sister-soon" }, "ภาพน้องฝนกำลังจะมา"),
    ),
    el("div", { class: "sister-copy" },
      el("span", { class: "sister-rank" }, sister.rank),
      el("h3", { class: "sister-name", id: `sister-${sister.key}` }, sister.name),
      el("p", { class: "sister-role" }, sister.role),
      el("p", { class: "sister-text" }, sister.text),
      el("ul", { class: "sister-duties", "aria-label": `หน้าที่ของ${sister.name}` },
        sister.duties.map((duty) => el("li", {}, duty))),
    ),
  );
}

// กรอบรออินโทร — ออกแบบให้เป็นเจตนา ไม่ใช่กรอบว่าง: ลูกแพรยิ้ม + ดาวสามดวงของสามพี่น้อง
function introPlaceholder() {
  const stars = svgNode("svg", { class: "intro-constellation", viewBox: "0 0 240 60", "aria-hidden": "true", focusable: "false" });
  stars.append(
    svgNode("path", { class: "constellation-line", d: "M24 40 L120 18 L216 36" }),
    svgNode("circle", { class: "constellation-star is-lukprae", cx: "24", cy: "40", r: "6" }),
    svgNode("circle", { class: "constellation-star is-nongkao", cx: "120", cy: "18", r: "5" }),
    svgNode("circle", { class: "constellation-star is-nongfon", cx: "216", cy: "36", r: "4" }),
  );
  return el("div", { class: "intro-placeholder" },
    moodPortrait("wink", { size: "lg", decorative: true }),
    el("p", { class: "intro-placeholder-title" }, "อินโทร 60 วินาที กำลังมาเร็ว ๆ นี้"),
    el("p", { class: "intro-placeholder-sub" }, "เมื่อไฟล์วิดีโอพร้อม หน้านี้จะเล่นได้ทันทีโดยไม่ต้องแก้อะไรเพิ่ม"),
    stars,
  );
}

export function createIntroPage({ mount, pageHeader, tabBar, stopPolling, setView, state }) {
  // เซิร์ฟเวอร์บอกมากับ /me ว่ามีไฟล์วิดีโอ/ภาพปกจริงไหม (ไม่ยิงคำขอเดาที่ได้ 404 ขึ้นแดงใน console)
  function stageContent() {
    const media = state?.introMedia || {};
    if (!media.video) return introPlaceholder();
    const video = el("video", {
      class: "intro-video", controls: "", playsinline: "", preload: "metadata",
      ...(media.poster ? { poster: INTRO_POSTER_SRC } : {}),
      "aria-label": "วิดีโออินโทรจักรวาลลูกแพร 60 วินาที",
    }, el("source", { src: INTRO_VIDEO_SRC, type: "video/mp4" }));
    // เล่นไม่ได้จริง (codec/ไฟล์เสีย) = กลับไปกรอบรอ ดีกว่าจอดำที่กดแล้วไม่มีอะไรเกิดขึ้น
    video.addEventListener("error", () => video.parentNode?.replaceChildren(introPlaceholder()), true);
    return video;
  }

  async function renderIntro() {
    stopPolling();
    const screen = el("div", { class: "intro-screen" }, stageContent());
    mount(
      pageHeader("Intro"),
      el("main", { class: "page-scroll" }, el("div", { class: "page-inner intro" },
        el("section", { class: "intro-hero", "aria-labelledby": "intro-title" },
          el("div", { class: "intro-copy" },
            el("p", { class: "intro-kicker" }, icon("sparkles", { size: 16 }), "จักรวาลลูกแพร"),
            el("h2", { class: "intro-title", id: "intro-title" }, "สามพี่น้องผู้ช่วยของพี่ง้วง ติดกระดุม"),
            el("p", { class: "intro-lede" },
              "ลูกแพรดูแลหน้าบ้านของบริษัท น้องเก้าช่วยแอดมิน\u200bทุกร้านร่างคำตอบ และน้องฝนเฝ้าบ้านให้ครอบครัวยามฝนตก"),
          ),
          el("figure", { class: "intro-stage" },
            screen,
            state?.introMedia?.video ? el("figcaption", { class: "intro-caption" }, "อินโทร 60 วินาที · จักรวาลลูกแพร") : null,
          ),
        ),
        el("section", { class: "intro-family", "aria-label": "สามพี่น้อง" }, SISTERS.map(sisterCard)),
      )),
      tabBar(),
    );
    setView("page");
  }

  return renderIntro;
}
