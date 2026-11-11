// brain/writeKinds.mjs — ทะเบียนทางเขียนของคอนโซล + ค่าคงที่ของผลลัพธ์
//
// แยกจาก writeHook.mjs เพื่อคุมขนาดไฟล์ (< 400 บรรทัดตามกติกาของโมดูลสมอง) และเพื่อให้
// ฝั่งคอนโซลอ่านทะเบียนได้โดยไม่ต้องลากตัว hook ทั้งก้อนเข้ามา
/**
 * ทะเบียนทางเขียน: endpoint -> ชนิดของการเขียน -> การ์ดที่มันแตะ
 *
 * `cardKinds` คือ "ชนิดสูงสุดที่เส้นนี้แตะได้" ใช้ตัดสินสองอย่างก่อนลงมือ: มอบสิทธิ์ได้ไหม
 * และ canary ได้ไหม ส่วนชุด item_id ที่แตะจริง มาจากการเทียบการ์ดก่อน/หลังเขียน ไม่ใช่จากที่นี่
 */
export const BRAIN_WRITE_KINDS = Object.freeze({
  price_add: { capability: "prices.manage", cardKinds: ["price"], label: "ตารางราคา" },
  price_edit: { capability: "prices.manage", cardKinds: ["price"], label: "ตารางราคา" },
  price_delete: { capability: "prices.manage", cardKinds: ["price"], label: "ตารางราคา" },
  knowledge_add: { capability: "knowledge.publish", cardKinds: ["fact"], label: "คลังความรู้" },
  knowledge_edit: { capability: "knowledge.publish", cardKinds: ["fact"], label: "คลังความรู้" },
  knowledge_delete: { capability: "knowledge.publish", cardKinds: ["fact"], label: "คลังความรู้" },
  product_rules: { capability: "rules.manage", cardKinds: ["policy"], label: "กติกาสินค้า" },
  freeclass_links: { capability: "rules.manage", cardKinds: ["policy"], label: "ลิงก์คลาสฟรี" },
  hashtag_rules: { capability: "rules.manage", cardKinds: ["policy"], label: "คีย์เวิร์ดกิจกรรม #" },
  class_round_set: { capability: "rules.manage", cardKinds: ["schedule", "product"], label: "รอบเรียน" },
  class_round_delete: { capability: "rules.manage", cardKinds: ["schedule", "product"], label: "รอบเรียน" },
  // สองเส้นที่เหลือซึ่งเขียน knowledge_entries เหมือนกัน — ถ้าไม่เดินผ่านที่นี่ parity จะแตก
  // เงียบ ๆ ทันทีที่มีคนกด (คลังรีวิวเป็นงานประจำวันของทีม / ข้อเสนอการเรียนรู้เป็นของเจ้าของ)
  review_catalog_edit: { capability: "knowledge.publish", cardKinds: ["fact"], label: "คลังรีวิว" },
  // liveOnly เพราะเส้นนี้มีผลข้างเคียงนอกการ์ด: แถว learning_candidates ถูกปิดเป็น approved
  // ผลนั้นเล่นซ้ำตอนรับทราบทีหลังไม่ได้ (การ์ดไม่ได้พกมันไว้) ถ้าปล่อยให้ค้างเป็น proposed
  // เราจะได้รุ่นที่รอรับทราบ + คิวข้อเสนอที่ยังเปิดอยู่ = สองแหล่งความจริงที่ไม่มีใครสมาน
  learning_apply: {
    capability: "knowledge.publish", cardKinds: ["fact"], label: "ข้อเสนอการเรียนรู้", liveOnly: true,
  },
  // วาล์วนิรภัยของเจ้าของ: ปิดความรู้ที่ระบบเรียนมาทั้งสัปดาห์ในคลิกเดียว — liveOnly เพราะ
  // "ถอยของที่ทำพิษอยู่ตอนนี้" ที่ไปโผล่แค่ 10% ของห้อง ไม่ใช่การถอย มันคือการทดลองซ้ำ
  learning_rollback_week: {
    capability: "knowledge.publish", cardKinds: ["fact"], label: "ย้อนการเรียนรู้ทั้งสัปดาห์", liveOnly: true,
  },
  // โหมดสมอง/ข้อความเสริมต่อสาขา ยังไม่ใช่การ์ดในเฟสนี้ (channel_addendum เปิดที่ P4)
  // เดินผ่าน hook เพื่อให้ "ไม่มีทางเขียนไหนหลุดด่าน" เป็นจริง แล้วจบที่ผล unchanged
  brain_publish: { capability: "brain.publish", cardKinds: [], label: "สมอง AI ต่อสาขา" },
});

// ชนิดที่ห้าม canary บังคับในโค้ด (แบบแปลน §6 Step 5): ราคาสองค่าพร้อมกัน หรือรอบเรียน
// สองชุดพร้อมกัน คือความเสียหายทางธุรกิจที่ auto-halt มองไม่เห็น
export const CANARY_FORBIDDEN_KINDS = Object.freeze(["price", "schedule", "product"]);

/**
 * เฟส 1b **ไม่เปิด** ทางเผยแพร่ด้วยสิทธิ์ที่มอบมา — และนี่คือการตัดสินใจ ไม่ใช่ของที่ทำไม่ทัน
 *
 * รุ่นทดลอง (canary) ยังไม่มีความหมายจนกว่า runtime จะอ่านสมองใน P2: วันนี้ลูกค้าทุกคนได้ยิน
 * ของจาก "ตารางเดิม" ซึ่งเท่ากับรุ่น live เสมอ ดังนั้นการปล่อยให้ทีมงานกดแล้วได้รุ่นทดลอง
 * คือการบอกว่า "บันทึกแล้ว" กับของที่ไม่มีวันถึงใครเลย — แย่กว่าการบอกตรง ๆ ว่ายังไม่เปิด
 *
 * กลไก canary ทั้งชุดยังอยู่ครบและมีเทสต์คุม (P2 ต้องใช้) แต่ไม่มีเส้นทางไหนที่ผู้ใช้กดแล้ว
 * ผลิตรุ่น canary ได้ในเฟสนี้ — ทีมงานตกกลับไปเข้าคิวขออนุมัติเหมือนเดิม
 */
export const DELEGATED_PUBLISH_ENABLED = false;
export const DELEGATED_PUBLISH_CLOSED_MESSAGE =
  "ยังไม่เปิดให้มอบสิทธิ์เผยแพร่ในเฟสนี้ — ส่งเข้าคิวให้พี่ง้วงอนุมัติแทน";

export class BrainWriteRefused extends Error {
  /**
   * @param {object} [options]
   * @param {number} [options.status] รหัสตอบกลับ (ค่าเริ่มต้น 409)
   * @param {boolean} [options.silent] true = ไม่ต้องเขียน audit "ถูกบล็อก"
   *   ใช้กับกรณีที่ไม่มีใครทำอะไรผิด เช่นแถวที่จะแก้หายไปก่อน (แข่งกับการลบ)
   */
  constructor(message, { outcome = "blocked", findings = [], gates = [], status = 409, silent = false } = {}) {
    super(message);
    this.name = "BrainWriteRefused";
    this.outcome = outcome;
    this.findings = findings;
    this.gates = gates;
    this.status = status;
    this.silent = silent;
  }
}

