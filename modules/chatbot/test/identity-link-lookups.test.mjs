// identity-link-lookups — มุมมอง "ลูกค้าทั้งคน" ในแชทเจ้าของ: ห้อง Facebook + LINE ที่เชื่อมกันแล้ว = คนเดียว
// ค้นห้องจากชื่อไม่ถามกลับว่าห้องไหน · ภาพรวมการขายบอกจำนวนคนเมื่อไม่เท่าจำนวนห้อง · ลูกค้าใหม่นับตามคน
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, poisonGlobalFetch, testConfig } from "./helpers.mjs";
import { runOwnerLookups } from "../src/ownerChatLookups.mjs";
import { validateLookupPlan } from "../src/ownerChatLookupCatalog.mjs";
import { findMentionedCustomers, mentionContextLines } from "../src/ownerChatMentions.mjs";
import { samePersonResolution } from "../src/identityLink.mjs";

poisonGlobalFetch();

const NOON = Date.UTC(2026, 8, 28, 5, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const FB = "facebook:psid-777";
const LINE = "U0123456789abcdef0123456789abc777";

function world(t) {
  const clock = { now: NOON };
  const db = memoryDb({ now: () => clock.now });
  t.after(() => db.close());
  const at = (ms, fn) => { const saved = clock.now; clock.now = ms; try { return fn(); } finally { clock.now = saved; } };
  at(NOON - 40 * DAY, () => db.upsertCustomer(FB, { displayName: "สมปอง รักเรียน", channelId: "facebook" }));
  at(NOON - 40 * DAY, () => db.insertMessage({ customerId: FB, direction: "in", content: "สนใจคลาสค่ะ" }));
  at(NOON - 20 * DAY, () => db.addTag(FB, "customer", "human"));
  at(NOON - 2 * HOUR, () => db.upsertCustomer(LINE, { displayName: "สมปอง รักเรียน" }));
  at(NOON - 2 * HOUR, () => db.insertMessage({ customerId: LINE, direction: "in", content: "ต่อแชทจาก Facebook" }));
  at(NOON - 2 * HOUR, () => db.addTag(LINE, "customer", "human"));
  at(NOON - 3 * HOUR, () => db.upsertCustomer("U-other", { displayName: "คนอื่น ทั่วไป" }));
  at(NOON - 3 * HOUR, () => db.insertMessage({ customerId: "U-other", direction: "in", content: "สวัสดีค่ะ" }));
  const config = testConfig();
  const run = (queries, ownerText = "") => {
    const checked = validateLookupPlan(JSON.stringify({ queries }), { ownerText, nowMs: NOON });
    return runOwnerLookups({ db, config, queries: checked.queries, nowMs: NOON, pricing: new Map(), thbPerUsd: 34 });
  };
  const link = () => db.runIdentityLinkTransaction(() => db.linkIdentityRowsInTx({ aId: FB, bId: LINE, via: "code", by: "customer_code" }));
  return { db, config, run, link };
}

test("ค้นห้องจากชื่อ: ยังไม่เชื่อม = ถามว่าห้องไหน · เชื่อมแล้ว = ห้องเดียว + ช่องทางอื่น + ลิงก์ทั้งสองห้อง", (t) => {
  const w = world(t);
  const before = w.run([{ name: "room", args: { name: "สมปอง" } }], "คุณสมปองเป็นไงบ้าง");
  assert.match(before.text, /ชื่อนี้ตรงกับ 2 ห้อง/u);
  w.link();
  const after = w.run([{ name: "room", args: { name: "สมปอง" } }], "คุณสมปองเป็นไงบ้าง");
  assert.doesNotMatch(after.text, /ตรงกับ 2 ห้อง/u);
  assert.match(after.text, /ช่องทางอื่นของลูกค้าคนเดียวกัน: Facebook \(ลูกค้าส่งรหัสยืนยันเอง\) — นับเป็นคนเดียว/u);
  assert.deepEqual(after.rooms.map((room) => room.id), [LINE, FB], "ห้องที่คุยล่าสุดก่อน แล้วแนบห้องอื่นของคนเดียวกัน");
  assert.ok(!after.text.includes("psid-777") && !after.text.includes(LINE), "ไม่มี id ในข้อความที่โมเดลเห็น");
});

test("แชทเจ้าของเอ่ยชื่อ: คนเดียวกันสองช่องทาง = แนบห้องเดียว ไม่ให้ลูกแพรถามกลับ · YOLO ยังต้องเลือกห้องเอง", (t) => {
  const w = world(t);
  w.link();
  const [mention] = findMentionedCustomers(w.db, "คุณสมปอง รักเรียนเป็นไงบ้าง");
  assert.equal(mention.status, "unique");
  const lines = mentionContextLines({ db: w.db, config: w.config, mentions: [mention], nowMs: NOON }).join("\n");
  assert.match(lines, /ช่องทางอื่นของลูกค้าคนเดียวกัน/u);
  const ambiguous = { status: "ambiguous", query: "สมปอง", total: 2, matches: [{ id: FB, tier: 1, lastMessageAt: 1 }, { id: "U-other", tier: 1, lastMessageAt: 2 }] };
  assert.equal(samePersonResolution(w.db, ambiguous), ambiguous, "ต่างคนกัน = ยังถามกลับตามเดิม");
  const hidden = { status: "ambiguous", query: "สมปอง", total: 3, matches: [{ id: FB, tier: 1 }, { id: LINE, tier: 1 }] };
  assert.equal(samePersonResolution(w.db, hidden), hidden, "มีห้องที่ไม่ได้แสดงอีก = ยังถามกลับ");
});

test("ภาพรวมการขาย: ลูกค้าที่ซื้อแล้วมีทั้ง Facebook และ LINE = 2 ห้อง 1 คน · ลูกค้าใหม่ไม่นับห้อง LINE ของคนเก่า", (t) => {
  const w = world(t);
  w.link();
  const funnel = w.run([{ name: "funnel", args: { days: 60 } }]).text;
  assert.match(funnel, /ห้องที่คุย 3 \(2 คน — บางคนมีทั้งห้อง Facebook และ LINE\)/u);
  assert.match(funnel, /ติดป้าย "ลูกค้า" \(ชำระ\/ลงเรียนแล้ว\): 2 ห้อง \(1 คน — บางคนมีทั้งห้อง Facebook และ LINE\)/u);
  const activity = w.run([{ name: "activity", args: { from: "2026-09-28", to: "2026-09-28" } }]).text;
  assert.match(activity, /ลูกค้าใหม่ \(ทักครั้งแรก\) 1 คน/u, "ห้อง LINE ของลูกค้าที่คุย Facebook มาก่อนไม่ใช่ลูกค้าใหม่");
});
