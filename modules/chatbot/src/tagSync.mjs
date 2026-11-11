// tagSync.mjs — ตรรกะแกนของการ sync chat tag เว็บ (chassis) -> LINE OA
//
// จุดนี้คือ "จุดที่ผิดไม่ได้" (คำสั่งพี่ง้วง 2026-08-17): PUT /chats/{chatId}/tags ของ
// LINE เป็นการ "แทนที่ทั้งชุด" ถ้าคำนวณ tagIds ผิดแม้ตัวเดียว = tag ที่ทีม/LINE ติดไว้
// หายยกแถว. โมดูลนี้จึงเป็น "ตรรกะบริสุทธิ์ ไม่มี I/O" เพื่อเทสต์ทุกกรณีขอบได้ก่อนแตะ LINE
//
// หลักการความปลอดภัย:
// - NON-DESTRUCTIVE: แตะเฉพาะ tag ที่อยู่ใน "managed namespace" (registry.sync_to_line)
//   tag อื่นบนห้อง (LINE/คนเป็นเจ้าของ) ต้องอยู่ครบเป๊ะทุกตัว
// - CAP 30: LINE จำกัด 30 tag/ห้อง (spec) — เกินแล้วห้าม PUT (คืน error ให้คนตัดสิน)
// - IDEMPOTENT: hash ของชุดที่ตั้งใจส่ง — ตรงกับที่เคยส่ง/ตรงกับ LINE ปัจจุบัน = ข้าม
// - ทุกอย่าง deterministic: เรียง tagId เสมอ (hash นิ่ง, เทสต์ reproduce ได้)

import { createHash } from "node:crypto";

// LINE จำกัด tag ต่อ 1 ห้อง (spec ยืนยันโดยพี่ง้วง 2026-08-17)
export const MAX_TAGS_PER_CHAT = 30;

// namespace ของ chassis tag: bare (ไม่มี "/") = green-label ที่ตรงกับ LINE;
// มี prefix "group/" = chassis-only (ยังไม่ sync จนกว่าจะ promote)
export function tagGroup(canonicalKey) {
  const value = String(canonicalKey || "");
  const slash = value.indexOf("/");
  return slash > 0 ? value.slice(0, slash) : "";
}
export function isBareTag(canonicalKey) {
  return tagGroup(canonicalKey) === "" && String(canonicalKey || "").trim() !== "";
}

/**
 * สร้าง lookup จาก registry rows: canonical_key -> line_tag_id (เฉพาะที่ sync ได้จริง)
 * และเซตของ line_tag_id ทั้งหมดใน managed namespace (ใช้แยก "tag ของเรา" ออกจาก "tag ของ LINE")
 */
export function buildManagedIndex(registryRows = [], { lineBotId = "" } = {}) {
  const keyToLineId = new Map();      // chassis tag -> LINE tagId
  const managedLineIds = new Set();   // LINE tagId ทั้งหมดที่ระบบเราดูแล
  for (const row of registryRows) {
    if (!row) continue;
    if (Number(row.active ?? 1) !== 1) continue;
    if (Number(row.sync_to_line ?? 0) !== 1) continue;
    if (lineBotId && row.line_bot_id && row.line_bot_id !== lineBotId) continue;
    const lineId = String(row.line_tag_id || "").trim();
    if (!lineId) continue; // ยังไม่จับคู่กับ tag ใน LINE = ยัง sync ไม่ได้ (ต้องสร้างมือก่อน)
    keyToLineId.set(String(row.canonical_key), lineId);
    managedLineIds.add(lineId);
  }
  return { keyToLineId, managedLineIds };
}

const uniqSorted = (ids) => [...new Set(ids.map((id) => String(id)).filter(Boolean))].sort();

export function tagSetHash(lineTagIds = []) {
  return createHash("sha256").update(uniqSorted(lineTagIds).join(",")).digest("hex").slice(0, 32);
}

/**
 * คำนวณชุด tagId ที่ "ควรเป็น" บนห้อง LINE — หัวใจของความปลอดภัย (แก้ตามรีวิว 2026-08-17)
 *
 * โมเดลความเป็นเจ้าของ (กัน "tag ทีมหายยกแถว"): chassis มีสิทธิ์ "ลบ" tag บนห้อง LINE
 * ได้เฉพาะ tag ที่ (ก) อยู่ใน managed namespace และ (ข) chassis "เคย push ตัวนี้ขึ้นห้องนี้
 * มาก่อน" (previouslyPushedIds) เท่านั้น — tag ที่ทีมติดเองตรงใน LINE (chassis ไม่เคย push)
 * ถูกสงวนเด็ดขาดแม้จะอยู่ใน managed namespace. ครั้งแรก (ยังไม่เคย push) = add-only ล้วน
 *
 * @param {string[]} chassisTags       tag ของลูกค้าใน chassis (customer_tags.tag)
 * @param {string[]} currentLineTagIds tagId ปัจจุบันบนห้อง LINE (จาก GET /chats)
 * @param {string[]} previouslyPushedIds tagId ที่ chassis เคย push ให้ห้องนี้ (จาก tag_sync_state)
 * @param {Set<string>|null} validManagedLineIds line_tag_id ที่ "ยังมีอยู่จริงใน LINE" ตอนนี้
 *        (จาก GET /tags สด) — กัน id ที่ถูกลบไปแล้วถูก push ซ้ำจนค้าง
 * @param {{keyToLineId: Map, managedLineIds: Set}} index จาก buildManagedIndex
 */
export function computeDesiredLineTags({
  chassisTags = [], currentLineTagIds = [], previouslyPushedIds = [], validManagedLineIds = null, index,
}) {
  const { keyToLineId, managedLineIds } = index;
  const current = uniqSorted(currentLineTagIds);
  const previouslyPushed = new Set(previouslyPushedIds.map(String));

  // 1) tag ของเราที่อยากให้มีตอนนี้ = chassis tags -> managed LINE tagId
  //    (กรองเฉพาะ id ที่ยังมีอยู่จริงใน LINE — กัน stale id ที่ถูกลบไปแล้ว)
  let managedTagIds = uniqSorted(chassisTags.map((tag) => keyToLineId.get(String(tag))).filter(Boolean));
  if (validManagedLineIds instanceof Set) managedTagIds = managedTagIds.filter((id) => validManagedLineIds.has(id));

  // 2) tag บนห้องที่ "chassis เป็นเจ้าของจริง" = managed AND เคย push เอง → เท่านั้นที่ลบได้
  const removable = current.filter((id) => managedLineIds.has(id) && previouslyPushed.has(id) && !managedTagIds.includes(id));
  const removableSet = new Set(removable);

  // 3) สงวนทุกอย่างที่ไม่ใช่ "ของเราที่ตั้งใจลบ" — tag ทีม/LINE อยู่ครบเสมอ
  const preservedTagIds = current.filter((id) => !removableSet.has(id));
  const desiredTagIds = uniqSorted([...preservedTagIds, ...managedTagIds]);

  // 4) CAP 30 — เกินห้ามส่ง (คืน error ให้คนดู ไม่ตัด tag มั่ว)
  if (desiredTagIds.length > MAX_TAGS_PER_CHAT) {
    return {
      ok: false, error: "exceeds_tag_cap", count: desiredTagIds.length,
      desiredTagIds, preservedTagIds, managedTagIds, added: [], removed: [], changed: false,
      hash: tagSetHash(desiredTagIds),
    };
  }

  const currentSet = new Set(current);
  const desiredSet = new Set(desiredTagIds);
  const added = desiredTagIds.filter((id) => !currentSet.has(id));
  const removed = current.filter((id) => !desiredSet.has(id));
  // safety invariant (defense-in-depth): ทุกตัวที่ลบต้องเป็น "ของเรา" (managed + เคย push +
  // ไม่อยู่ในชุดที่อยากได้แล้ว) — ถ้าหลุด tag ที่ไม่เข้าเงื่อนไข = บล็อกทันที ไม่ PUT
  const illegalRemovals = removed.filter((id) => !removableSet.has(id));

  return {
    ok: illegalRemovals.length === 0,
    ...(illegalRemovals.length ? { error: "would_remove_unowned_tag", illegalRemovals } : {}),
    count: desiredTagIds.length,
    desiredTagIds, preservedTagIds, managedTagIds,
    // managedTagIds = ชุดที่ chassis push รอบนี้ (เก็บลง tag_sync_state เป็น previouslyPushed รอบหน้า)
    added, removed,
    changed: added.length > 0 || removed.length > 0,
    hash: tagSetHash(desiredTagIds),
  };
}

/**
 * ตัดสินว่าห้องนี้ต้อง PUT ไหม — idempotency: ไม่เปลี่ยน หรือ hash ตรงกับที่เคยส่ง = ข้าม
 */
export function shouldPush(plan, { lastPushedHash = "" } = {}) {
  if (!plan?.ok) return { push: false, reason: plan?.error || "plan_not_ok" };
  if (!plan.changed) return { push: false, reason: "no_change" };
  if (lastPushedHash && lastPushedHash === plan.hash) return { push: false, reason: "hash_unchanged" };
  return { push: true, reason: "changed" };
}

/**
 * ตรวจ readback หลัง PUT — LINE ต้องคืน tagIds ตรงกับที่เราตั้งใจส่งเป๊ะ (provider readback)
 * ไม่ตรง = ห้าม mark สำเร็จ (คำสั่งพี่ง้วง "ห้ามผิดพลาด")
 */
export function verifyReadback({ desiredTagIds = [], readbackTagIds = [] }) {
  const want = uniqSorted(desiredTagIds).join(",");
  const got = uniqSorted(readbackTagIds).join(",");
  return { ok: want === got, want, got };
}
