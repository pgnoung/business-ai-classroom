// LINE OA capability status is deliberately a control-plane read model.
// It describes only what this instance is configured to receive, not what
// LINE has accepted or what an operator may have done in OA Manager.

function text(value, fallback = "") {
  const clean = String(value ?? "").trim();
  return clean || fallback;
}

function channelStatus(channel = {}, config = {}) {
  const id = text(channel.id, "default");
  const active = channel.active !== false;
  // A channel secret lets the runtime verify an inbound webhook. It is not a
  // provider readback and must never be presented as proof that LINE points at
  // this server.
  // `lineOaCapabilityStatus` already synthesizes the legacy channel with its
  // env secret.  Do not borrow that secret for a separate CHANNELS_FILE entry:
  // doing so would falsely say an incomplete branch OA can verify webhooks.
  const signedInboundConfigured = active && Boolean(text(channel.channelSecret));
  const trainingIntakeEnabled = config.trainingIntakeEnabled === true && config.teachEnabled === true;

  return Object.freeze({
    id,
    label: text(channel.name, id),
    active,
    webhook: Object.freeze({
      configured: signedInboundConfigured,
      provenConnected: false,
      status: signedInboundConfigured ? "configured_unverified" : "not_configured",
      message: signedInboundConfigured
        ? "ตั้งค่ารับข้อความขาเข้าแล้ว หน้านี้ยังไม่ได้ตรวจยืนยันการเชื่อมต่อกับ LINE"
        : "การตั้งค่ารับข้อความขาเข้าของ OA นี้ยังไม่ครบหรือยังไม่เปิดใช้งาน",
    }),
    managerDirect: Object.freeze({
      observed: false,
      status: "unobserved",
      message: "ข้อความที่ทีมตอบตรงใน LINE OA Manager ไม่ถูกดึงกลับเข้าระบบอัตโนมัติ",
    }),
    curatedQa: Object.freeze({
      enabled: trainingIntakeEnabled,
      status: trainingIntakeEnabled ? "queue_available" : "disabled",
      href: "#/teach-intake",
      message: trainingIntakeEnabled
        ? "รับเฉพาะคำถาม-คำตอบที่ทีมคัดและตัดข้อมูลส่วนบุคคลแล้วเข้าคิวตรวจ"
        : "คิวรับคำถาม-คำตอบจากทีมยังปิดอยู่",
    }),
    nativeBackup: Object.freeze({
      status: "schema_unverified",
      message: "รอตรวจรูปแบบไฟล์สำรองประวัติและสิทธิ์บัญชี ก่อนสร้างตัวนำเข้าจาก LINE OA",
    }),
    nativePerChatTags: Object.freeze({
      status: "not_available",
      message: "ระบบยังเชื่อมแท็กรายห้องจาก LINE OA อัตโนมัติไม่ได้",
    }),
  });
}

export function lineOaCapabilityStatus({ config = {}, channels = [] } = {}) {
  // `channels` comes from the instance loader. One chassis is one business;
  // multiple entries are branches/OAs of that same business, never tenants.
  const listed = Array.isArray(channels) && channels.length ? channels : [{
    id: "default",
    name: config.lineChannelName || "",
    channelSecret: config.lineChannelSecret || "",
    active: true,
  }];
  return Object.freeze({
    scope: "one_business_per_instance",
    channels: Object.freeze(listed.map((channel) => channelStatus(channel, config))),
    roomNote: Object.freeze({
      href: "#/chat",
      message: "เมื่อทีมคุยใน OA Manager ให้บันทึกสรุปส่งต่อในห้องลูกค้านั้น เพื่อให้บริบทกลับเข้าคอนโซล",
    }),
    localTagSafety: Object.freeze({
      status: "local_only",
      message: "ป้ายในคอนโซลแยกจากแท็กใน LINE OA ป้ายบางประเภทมีผลหยุด AI จึงต้องตรวจผลกระทบก่อนนำเข้า",
    }),
    notices: Object.freeze([
      "สถานะ configured ไม่ใช่หลักฐานว่า LINE เชื่อมต่อสำเร็จ ต้องยืนยันจาก provider readback หรือ webhook ที่ตรวจลายเซ็นแล้ว",
      "หน้านี้ไม่ดึงประวัติแชท, ไม่อ่านหรือเขียน tag, ไม่ส่งข้อความ และไม่แสดง credential",
    ]),
  });
}
