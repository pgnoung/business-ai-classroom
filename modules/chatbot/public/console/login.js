// login.js — หน้าเข้าสู่ระบบ console (cookie ถูกตั้งโดย server เป็น HttpOnly)
const form = document.getElementById("form");
const error = document.getElementById("error");

// 28 ก.ย. 2026: โหมดมืดที่คนใช้เครื่องนี้เลือกไว้ล่าสุดในคอนโซล (ยังไม่รู้ชื่อผู้ใช้ที่หน้านี้
// จึงอ่านค่า "ล่าสุดของเครื่อง" ที่ console.js จดไว้) — เฉพาะธีมลูกแพรที่ออกแบบหน้าเข้าระบบโหมดมืดแล้ว
// (Pngoung หน้าเข้าระบบยังสว่างเหมือนเดิม ไม่เปลี่ยนพฤติกรรม instance อื่น)
function applySavedDarkMode() {
  const root = document.documentElement;
  let dark = false;
  if (root.classList.contains("theme-lukprae")) {
    try { dark = localStorage.getItem("lukprae.ui_theme:last") === "dark"; } catch { dark = false; }
  }
  root.classList.toggle("theme-dark", dark);
  root.style.colorScheme = dark ? "dark" : "light";
}
applySavedDarkMode();

function applyBranding(branding) {
  if (!branding || typeof branding !== "object") return;
  const name = typeof branding.name === "string" ? branding.name : "Front Desk";
  const mark = typeof branding.mark === "string" ? branding.mark : "FD";
  const agent = typeof branding.agent === "string" ? branding.agent : "";
  // white-label (8 ต.ค. 2026): profile "generic" = ร้านอื่น — ไม่มีธีม/ตัวละครลูกแพร ใช้ธีม starter แทน
  const generic = branding.profile === "generic";
  const theme = generic && branding.theme === "lukprae" ? "starter" : branding.theme;
  document.documentElement.classList.toggle("theme-pngoung", theme === "pngoung");
  document.documentElement.classList.toggle("theme-lukprae", theme === "lukprae");
  document.documentElement.classList.toggle("theme-starter", theme === "starter");
  if (generic) {
    // ข้อความในหน้าต่างโค้ง (ซ่อนอยู่นอกธีม lukprae) ต้องไม่มีชื่อลูกแพรค้างใน DOM ของร้านอื่น
    const agentName = (typeof branding.agentName === "string" && branding.agentName.trim())
      || (typeof branding.agent === "string" && branding.agent.trim()) || "แอดมิน";
    const bubbleName = document.querySelector(".login-bubble .nb");
    if (bubbleName) bubbleName.textContent = agentName;
  }
  applySavedDarkMode();
  document.title = `เข้าสู่ระบบ · ${name} Console`;
  document.getElementById("brand-mark").textContent = mark;
  document.getElementById("brand-name").textContent = `${name} Console`;
  const agentLine = document.getElementById("brand-agent");
  agentLine.textContent = agent ? `ผู้ช่วย: ${agent}` : "สำหรับทีมแอดมินเท่านั้น";
}

fetch("/console/api/branding")
  .then((res) => res.ok ? res.json() : null)
  .then((data) => applyBranding(data?.branding))
  .catch(() => {}); // stable HTML defaults remain available if a proxy is unavailable

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = form.querySelector("button");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "กำลังเข้าสู่ระบบ…";
  error.hidden = true;

  try {
    const res = await fetch("/console/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: document.getElementById("username").value.trim(),
        password: document.getElementById("password").value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "เข้าสู่ระบบไม่สำเร็จ");
    // กลับไปห้องที่ตั้งใจจะเปิด ถ้ามี — ยอมรับเฉพาะ hash ภายในรูปแบบ "#/..."
    const next = new URLSearchParams(location.search).get("next") || "";
    location.href = /^#\/[\w\-./%]*$/.test(next) && next.length <= 200
      ? `/console/${next}`
      : "/console";
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    button.disabled = false;
    button.textContent = original;
  }
});
