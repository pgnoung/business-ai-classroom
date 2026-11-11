// personaParticleAudit.mjs — บันทึก audit เมื่อด่านคำลงท้ายตัวละครผู้หญิงแก้ข้อความ (5 ต.ค. 2026)
//
// พี่ง้วง: "เพิ่มด่านกันคำว่าครับให้หน่อย" — ด่านอยู่ที่ personaParticles.mjs (แก้ก่อน humanize)
// ไฟล์นี้แค่เล่าว่าแก้อะไรไป "เป็นชนิดและจำนวน" เท่านั้น:
//   · ไม่เก็บข้อความเต็ม/ช่วงที่แก้ (from/to) — ประโยคที่แก้ตัวเองอาจมีชื่อลูกค้าติดมา
//   · audit พังห้ามหยุดการส่งข้อความ (humanizer จับ throw ไว้อีกชั้นแล้ว แต่ที่นี่ก็ไม่ throw)

export const PERSONA_PARTICLE_AUDIT_ACTION = "persona_particle_fixed";
const KIND_RE = /^[a-z_]{1,40}$/u;
const MAX_KINDS = 12;

function countKinds(items) {
  const counts = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const kind = typeof item?.kind === "string" && KIND_RE.test(item.kind) ? item.kind : "other";
    counts.set(kind, (counts.get(kind) || 0) + 1);
  }
  return [...counts.entries()].slice(0, MAX_KINDS).map(([kind, n]) => `${kind}×${n}`).join(", ");
}

/** "fixes: khrap×2, na_khrap×1 · residual: male_pronoun×1" — ชนิด + จำนวนเท่านั้น ไม่มีเนื้อความ */
export function personaParticleAuditDetail(fixes, residual) {
  const parts = [];
  const fixed = countKinds(fixes);
  const left = countKinds(residual);
  if (fixed) parts.push(`fixes: ${fixed}`);
  if (left) parts.push(`residual: ${left}`);
  return parts.join(" · ") || "fixes: none";
}

/** callback ของ createHumanizer({ onParticleFix }) */
export function createParticleFixAudit({ db, logger = console } = {}) {
  return function onParticleFix(customerId, fixes, residual) {
    try {
      db.addAudit({
        operator: "system",
        action: PERSONA_PARTICLE_AUDIT_ACTION,
        target: String(customerId ?? ""),
        detail: personaParticleAuditDetail(fixes, residual),
      });
    } catch (err) {
      logger?.warn?.(`[persona-particles] audit ไม่สำเร็จ (${err?.message || err})`);
    }
  };
}
