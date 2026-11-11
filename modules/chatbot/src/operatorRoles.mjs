const CAPABILITIES = Object.freeze({
  owner: Object.freeze([
    "operations.use", "orders.manage", "broadcast.use", "broadcast.send", "settings.manage",
    "knowledge.manage", "corrections.review", "export.use",
    "training.review", "users.manage", "customers.reset", "customers.forget", "media.read", "media.send",
    "backup.view", "notifications.manage", "ai_pause.manage", "payments.confirm",
    // คำสั่งพี่ง้วง 1 ก.ย. 2026: "ค่าแอด ROAS ให้เห็นเฉพาะพี่ง้วงคนเดียว และการตั้ง webhook
    // ใดๆ พนักงานไม่ควรเห็น" — สองตัวนี้จึงเป็นของ owner เท่านั้น
    //   finance.view        = ROAS ค่าแอด กำไร ต้นทุนรวม ค่า AI สมุด audit
    //   integrations.manage = โทเคน Facebook กุญแจ ads ingest สถานะ webhook ต่อ OA
    //                         โมเดล AI ผู้รับแจ้งเตือน สวิตช์สรุปรายวัน
    // แยกสองตัวเพราะวันหน้าอาจให้คนบัญชีดูตัวเลขได้โดยไม่ต้องแตะสายเชื่อมต่อ และกลับกัน
    //
    // จงใจไม่ให้ admin ด้วย: owner มีบัญชีเดียวโดยธรรมชาติ (auth.mjs seed บัญชีแรก)
    // ส่วน admin เป็นบทบาทที่แจกให้คนอื่นได้จาก dropdown ในหน้าตั้งค่า — วันที่ชมพู่ถูก
    // เลื่อนเป็น Admin ถ้ากันแค่ staff เธอจะเห็นกำไรและกดดูกุญแจ ingest ได้ทันที
    "finance.view", "integrations.manage",
    // 2 ก.ย. 2026: kpi.manage = แก้ "วันหยุดนักขัตฤกษ์" ที่ใช้ตัดวันออกจากการวัดผลงาน
    // (kpi.mjs: day.holiday → day.off → ตัดออกจาก speedWorkDays ซึ่งเป็นตัวเลขที่ใช้
    // ตัดสินผลงานทีมจริง ๆ) — คนถูกวัดต้องแก้เกณฑ์ที่ใช้วัดตัวเองไม่ได้
    // ตัวเลข KPI ยัง "อ่าน" ได้ทุกบทบาทตามคำสั่งเจ้าของ กันเฉพาะการเขียนเกณฑ์
    "kpi.manage",
    // 2 ก.ย. 2026 (คำสั่งพี่ง้วง): "ชมพู่ทำงานประจำวันได้เหมือนเดิมทุกอย่าง แต่การ
    // เผยแพร่ของที่เปลี่ยนสมองลูกแพร เป็นของพี่ง้วงคนเดียว" — สามตัวนี้คือของที่
    // "เข้าไปเป็นข้อมูลตั้งต้นของ AI" ไม่ใช่ผลลัพธ์ของงานหน้างาน
    //   prices.manage = ตารางราคา guard (เพิ่ม/แก้/ลบ) — ตัวเลขที่บอทพูดกับลูกค้า
    //   brain.publish = โหมดสมอง shared/separate + ข้อความเสริมต่อสาขา
    //   rules.manage  = กติกาสินค้า ลิงก์คลาสฟรี คีย์เวิร์ด # และตารางรอบเรียน
    //
    // เส้นแบ่งที่ต้องไม่เพี้ยน: "จำนวนคนที่ลงทะเบียนแล้ว" ของแต่ละรอบ ยังเป็นงาน
    // ประจำวันของทีม (POST /class-rounds) — ชมพู่กรอกเองได้ตลอด กันไปด้วยคือพัง
    //
    // จงใจไม่ให้ admin เหมือน finance.view/integrations.manage: admin เป็นบทบาทที่
    // แจกให้คนอื่นได้จาก dropdown ในหน้าตั้งค่า ถ้ากันแค่ staff วันที่ชมพู่ถูกเลื่อน
    // เป็น Admin เธอจะกดเปลี่ยนราคาที่บอทพูดกับลูกค้าได้ทันที
    //
    // Package K (2 ก.ย. 2026): มีคิวร่างแล้ว — ทีมงานที่ไม่มีสิทธิ์สามตัวข้างบนไม่ได้ 403
    // เปล่า ๆ อีกต่อไป แต่ได้ 202 "ส่งให้พี่ง้วงอนุมัติแล้ว" พร้อมแถวใน publish_requests
    // ทุกเส้น GET ยังเปิดให้ทีมอ่านเหมือนเดิม
    "prices.manage", "brain.publish", "rules.manage",
    // 2 ก.ย. 2026 (คำสั่งพี่ง้วงรอบเดียวกัน): คลังความรู้ (knowledge_entries) ต่อตรงเข้า
    // system prompt เหมือนกติกาสินค้า — การ "เปลี่ยน" จึงเป็นของเจ้าของด้วย
    //   knowledge.publish = เพิ่ม/แก้/ปิด/ลบ รายการในคลังความรู้ (GET ยังเปิดให้ทุกคน
    //                       และ knowledge.manage เดิมยังเป็นสิทธิ์ "เข้าหน้าความรู้" เหมือนเดิม)
    //   publish.approve   = อ่านคิวคำขอทั้งร้าน + กดอนุมัติ/ปฏิเสธ
    // ไม่ให้ admin ด้วยเหตุผลเดียวกับสามตัวบน: admin แจกจาก dropdown ได้
    "knowledge.publish", "publish.approve",
    // 2026-09-28 (คำสั่งพี่ง้วง): สอนลูกแพรจากแผง "ทำไมตอบแบบนี้" (src/consoleLessonsApi.mjs)
    //   lessons.teach   = พิมพ์บทเรียนใต้ฟองของลูกแพร (ทุกบทบาท — ของเจ้าของใช้ทันที)
    //   lessons.approve = อนุมัติ/แก้/ปิด/ลบบทเรียนที่ใช้จริง — เจ้าของเท่านั้น เหตุผลเดียวกับ
    //                     knowledge.publish: บทเรียนเปลี่ยนวิธีพูดของลูกแพรทันที และ admin แจกได้
    "lessons.teach", "lessons.approve",
    // 2026-09-28 (คำสั่งพี่ง้วง): YOLO = ให้ลูกแพรทักห้องนี้ต่อ 1 ครั้งทันที (yolo.mjs)
    // owner + admin เท่านั้น — เป็นการส่งข้อความเชิงรุกถึงลูกค้าจริงตามคำสั่งคน staff ไม่ได้
    "yolo.send",
    // 28 ก.ย. 2026 (พี่ง้วงถามว่าโควตา LINE ไปไหน): การ์ด "LINE OA เดือนนี้" — owner + admin เห็นจำนวนข้อความ
    // ตัวเลขเงิน (ราคาแพ็กเกจ/ค่าประมาณ) ยังกันด้วย finance.view ของเจ้าของอีกชั้น (consoleLineUsageApi.mjs)
    "line_usage.view",
    // 28 ก.ย. 2026: เชื่อม/ยกเลิกการเชื่อม "ลูกค้าคนเดียวกัน" ข้าม Facebook ↔ LINE ด้วยมือ + ดูห้องที่ระบบแนะนำ
    // (identityLink.mjs) owner + admin — การเชื่อมผิดคน = ป้าย/สถานะ/สรุปของคนหนึ่งไปโผล่ในห้องอีกคน
    "identity.link",
    // 12 ต.ค. 2026 ค่ำ (คำสั่งพี่ง้วง): ห้องตรวจ — กดยืนยัน/ปิดเงียบ/ไม่ปิด ห้องที่ AI เสนอให้ปิด (consoleOwnerReviewApi.mjs)
    // ทุกบทบาท (พี่ง้วงตัดสินเองว่า "ชมพู่ยืนยันได้") — staff เห็นเฉพาะห้องในสาขาที่ได้รับมอบ · แจ้งเตือนยังถึงเจ้าของคนเดียว
    "closes.confirm",
    // 3 พ.ย. 2026 (คำสั่งพี่ง้วง "พี่ง้วงเห็นคนเดียว"): ผลตรวจคำตอบของทีมโดย Luna (consoleTeamReviewApi.mjs)
    // owner เท่านั้น เหตุผลเดียวกับ finance.view — admin แจกจาก dropdown ได้ ชมพู่ต้องไม่เห็นคะแนนตัวเอง
    "team_review.view",
  ]),
  admin: Object.freeze([
    "operations.use", "orders.manage", "broadcast.use", "broadcast.send", "settings.manage",
    "knowledge.manage", "corrections.review", "export.use", "media.read", "media.send",
    "notifications.manage", "payments.confirm", "lessons.teach",
    "yolo.send", // 2026-09-28: ดูเหตุผลที่บทบาท owner
    "line_usage.view", // 28 ก.ย. 2026: การ์ด LINE OA เดือนนี้ (จำนวนข้อความ — ไม่มีตัวเลขเงิน)
    "identity.link", // 28 ก.ย. 2026: เชื่อมลูกค้าคนเดียวกันข้าม Facebook ↔ LINE (ดูเหตุผลที่บทบาท owner)
    "closes.confirm", // 12 ต.ค. 2026 ค่ำ: ห้องตรวจ — ยืนยันปิดห้องที่ AI เสนอ (ดูเหตุผลที่บทบาท owner)
  ]),
  // คำสั่งพี่ง้วง 2026-08-25: "ชมพู่ทำได้หมดเลย พนักงานทำได้หมด ยกเว้น ตั้งค่าเกี่ยวกับ
  // พนักงาน หรือ คน" — Staff จึงได้ชุดเดียวกับ Admin บวกสิทธิ์เปลี่ยนรหัสตัวเอง
  //
  // สิ่งที่ยัง "ไม่" ให้ Staff โดยเจตนา และยังเป็นของ Owner เท่านั้น:
  //   users.manage      = จัดการบัญชีคน (ข้อยกเว้นที่เจ้าของระบุตรง ๆ)
  //   customers.reset / customers.forget = ลบข้อมูลลูกค้าถาวร
  //   ai_pause.manage   = หยุด/เปิด AI ทั้งระบบ
  //   backup.view       = สถานะไฟล์สำรอง
  //   training.review   = อนุมัติชุดเทรน
  // เส้น /operators ถูกล็อกเป็น owner-only แบบ hardcode อีกชั้น (consoleOperatorAdminApi.mjs:34)
  operator: Object.freeze([
    "operations.use", "orders.manage", "broadcast.use", "broadcast.send", "settings.manage",
    "knowledge.manage", "corrections.review", "export.use", "media.read", "media.send",
    "notifications.manage", "payments.confirm", "password.change", "lessons.teach",
    "closes.confirm", // 12 ต.ค. 2026 ค่ำ: พี่ง้วงตัดสินว่าชมพู่ยืนยันปิดห้องที่ AI เสนอได้ (ห้องตรวจ)
  ]),
});

const ROLE_KEYS = Object.freeze({ owner: "super_admin", admin: "admin", operator: "staff" });
const ROLE_LABELS = Object.freeze({ owner: "Super Admin", admin: "Admin", operator: "Staff" });
// รายการยังเป็น allowlist (deny-by-default) แต่ครอบงานประจำครบตามคำสั่งเจ้าของ
// จงใจไม่ใส่ "operators" — การจัดการบัญชีคนเป็นของ Owner เท่านั้น
const STAFF_ROUTE_ROOTS = new Set([
  "inbox", "overview", "conversations", "customers", "notes", "followups",
  "orders", "broadcast", "class-rounds", "channels", "password",
  "quick-replies", "attachments", "corrections", "knowledge", "export",
  "stickers", "brain", "models", "prices", "settings", "me",
  // ปล่อยให้ owner-only handler เดิมตอบข้อความปฏิเสธตาม API contract เดิม
  "training-candidates", "backup-status", "learning",
  // 1 ก.ย. 2026: เปิดคืนสองเส้นที่กันเกินจนชมพู่ทำงานไม่ได้ — ทั้งคู่ไม่มีตัวเลขเงินสักฟิลด์
  //   kpi     = ผลงานการตอบแชท (เมนู "ผลงาน" โชว์ให้ staff อยู่แล้ว แต่ API 403 มาตลอด)
  //   reviews = ฟอร์มคลังรีวิวที่ทำมาให้ชมพู่กรอกโดยเฉพาะ
  // จงใจไม่เติม "roas"/"audit" — ปล่อยให้ deny-by-default ของ route กับ capability กันสองชั้น
  "kpi", "reviews",
  // Package K: ทีมงานต้องยิงเส้นคิวได้ ไม่งั้นส่งคำขอไปแล้วไม่มีทางรู้ว่าค้างอยู่หรือถูกปฏิเสธ
  // handler กรองให้เห็นเฉพาะคำขอของตัวเองอยู่แล้ว (ต้องมี publish.approve ถึงจะเห็นของทั้งร้าน)
  "publish-requests",
  // เฟส 3: กล่องตรวจ + จอสอน — ทีมงานต้องเข้าได้ ไม่งั้นคำแก้ที่เธอพิมพ์เองก็ไม่มีใครสอน
  // เส้นนี้อ่านอย่างเดียว การกดส่งวิ่งเข้า knowledge/prices ซึ่งมีด่านของตัวเองอยู่แล้ว
  "teach",
  // Read-only all-session history. The handler separately scopes each query to
  // the operator's granted OA channels.
  "history",
  // JEV decision receipts use the same human-review capability. They are
  // advisory records only and never grant a route to change the brain.
  "jev-reviews",
  "jev-audits",
  // 2026-09-28: บทเรียนจากแผง "ทำไมตอบแบบนี้" — ทีมงานสอนได้ (รออนุมัติ) handler กรองให้เห็น
  // ของที่ใช้อยู่ + ของตัวเอง และกันปุ่มของเจ้าของด้วย lessons.approve อีกชั้น
  "lessons",
  // 6 ต.ค. 2026 ค่ำ: รูปแอดในแถบ "มาจากโฆษณา" — ทีมงานเห็นชื่อแอดอยู่แล้ว รูปคือของชิ้นเดียวกัน ไม่มีตัวเลขเงิน
  "ad-thumbs",
  // 12 ต.ค. 2026 ค่ำ: ห้องตรวจของพี่ง้วง — ชมพู่ยืนยันปิดห้องที่ AI เสนอได้ (handler กรองสาขา + ต้องมี closes.confirm)
  "owner-review",
  // 18 ต.ค. 2026 (ขั้นที่ 2 ของแผน soul): หน้า #/soul อ่านอย่างเดียว — ข้อความเดียวกับกล่อง persona เดิมในหน้าความรู้
  // ที่ทีมงานเห็นอยู่แล้ว ไม่มีตัวเลขเงิน ไม่มีข้อมูลลูกค้า · handler กันด้วย knowledge.manage อีกชั้น
  "soul",
]);

// ที่มาเดียวของ "บทบาทไหนได้สิทธิ์นี้บ้าง" — ใช้สร้างเงื่อนไข SQL ฝั่งส่งจริง
// เพื่อไม่ให้ตารางสิทธิ์กับคิวรีที่ส่งของจริงเพี้ยนออกจากกันอีก
// (2026-08-25: staff ได้ notifications.manage แต่ SQL ยังกรอง owner/admin
//  ชมพู่จึงกดเปิดได้ ระบบตอบว่าสำเร็จ แต่ไม่มีวันได้รับแจ้งเตือนเลยสักครั้ง)
export function rolesWithCapability(capability) {
  return Object.keys(CAPABILITIES).filter((role) => CAPABILITIES[role].includes(capability));
}

export function publicRoleKey(role) {
  return ROLE_KEYS[role] || "staff";
}

export function publicRoleLabel(role) {
  return ROLE_LABELS[role] || ROLE_LABELS.operator;
}

export function capabilitiesForRole(role) {
  return [...(CAPABILITIES[role] || CAPABILITIES.operator)];
}

// Media is capability-driven: every role that carries media.send may send
// customer-facing media (Staff included since 2026-08-25); media.read alone only
// permits inspecting what already exists in the conversation.
export function hasOperatorCapability(operator, capability) {
  return capabilitiesForRole(operator?.role).includes(String(capability));
}

export function operatorInfo(op) {
  return {
    username: op.username,
    displayName: op.display_name,
    role: op.role,
    roleKey: publicRoleKey(op.role),
    roleLabel: publicRoleLabel(op.role),
    capabilities: capabilitiesForRole(op.role),
  };
}

export function internalManagedRole(roleKey) {
  if (roleKey === "admin") return "admin";
  if (roleKey === "staff") return "operator";
  return null;
}

// Admin retains the established console surface. Staff remains deny-by-default at
// the route level, but its allowlist now covers the full daily-operations surface
// per the owner's 2026-08-25 decision. Account management stays owner-only both by
// capability (users.manage) and by the hardcoded check in consoleOperatorAdminApi.
export function canAccessConsoleRoute(operator, route) {
  if (operator?.role === "owner" || operator?.role === "admin") return true;
  return operator?.role === "operator" && STAFF_ROUTE_ROOTS.has(route[0]);
}
