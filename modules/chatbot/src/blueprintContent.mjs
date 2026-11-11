// blueprintContent.mjs — ประตูเดียวไปยังโมดูลเนื้อหาของแคมเปญ #AIAGENT (src/blueprint/: schema · prompt · flex)
//
// ทำไมไม่ import ตรง: server.mjs โหลดไฟล์แคมเปญตอนบูต ถ้าโมดูลเนื้อหาหาย/พัง (ไฟล์ไม่ได้เข้า release, syntax ผิด)
// import ตรง ๆ จะทำให้ลูกแพรบูตไม่ขึ้นทั้งระบบ — ผิดคำสั่ง "ไม่กระทบระบบเดิม" ร้ายที่สุด
// ที่นี่โหลดด้วย top-level await (เสร็จก่อน server.mjs โหลดจบเสมอ ไม่มีช่วงแข่งกับ webhook แรก)
// โหลดไม่ได้ = blueprintContent() คืน null → ขาเข้าคืน null (เส้นเดิมทุกไบต์) และตัวเดินรอบไม่ทำอะไร
let content = null;
let loadError = "";

try {
  const [schema, prompt, flex] = await Promise.all([
    import("./blueprint/blueprintSchema.mjs"),
    import("./blueprint/blueprintPrompt.mjs"),
    import("./blueprint/blueprintFlex.mjs"),
  ]);
  const required = {
    parseBlueprintText: schema.parseBlueprintText,
    buildBlueprintMessages: prompt.buildBlueprintMessages,
    buildBlueprintFlex: flex.buildBlueprintFlex,
    buildAckMessages: flex.buildAckMessages,
    blueprintToText: flex.blueprintToText,
  };
  const missing = Object.entries(required).filter(([, fn]) => typeof fn !== "function").map(([name]) => name);
  if (missing.length) throw new Error(`ไม่มีฟังก์ชัน ${missing.join(", ")}`);
  // ของเสริม (ไม่มี = ไม่ส่ง ไม่ปิดแคมเปญ): คำสั่งตั้งต้นแบบข้อความที่ลูกค้ากดค้างคัดลอกได้ ส่งตามหลังการ์ดในคำขอเดียวกัน
  const optional = typeof flex.buildAgentBriefText === "function" ? { buildAgentBriefText: flex.buildAgentBriefText } : {};
  content = Object.freeze({ ...required, ...optional, flexMaxBytes: Number(flex.FLEX_CONTENTS_MAX_BYTES) > 0 ? Number(flex.FLEX_CONTENTS_MAX_BYTES) : 30_000 });
} catch (err) {
  loadError = String(err?.message || err).slice(0, 200);
  console.error(`[chassis] แคมเปญ AI Agent: โหลดโมดูลเนื้อหาไม่สำเร็จ — ปิดแคมเปญทั้งหมด ลูกแพรทำงานตามเดิม (${loadError})`);
}

/** โมดูลเนื้อหา หรือ null ถ้าโหลดไม่ได้ */
export function blueprintContent() {
  return content;
}

export function blueprintContentError() {
  return loadError;
}
