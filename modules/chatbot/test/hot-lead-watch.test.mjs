// v1.3.4: เหตุจริง 2026-08-13 — ลูกค้าคะแนน 10/10 ให้ชื่อบริษัท เลขผู้เสียภาษี ที่อยู่ครบ
// ถามวิธีโอนเงิน แล้วเงียบไป ระบบไม่ทำอะไรต่อเลย: followups = 0 แถวทั้งฐานข้อมูล
// human_owner ว่าง last_seen_by_operator_at = 0 (ไม่เคยมีใครเปิดห้องแชทนี้)
//
// ตัวเฝ้านี้ห้ามส่งข้อความหาลูกค้าเด็ดขาด — หน้าที่คือทำให้ทีมงานเห็นว่ามีดีลค้าง
import test from "node:test";
import assert from "node:assert/strict";

import {
  HOT_LEAD_SILENT_MS, HOT_LEAD_TAG,
  findStalledHotLeads, flagStalledHotLeads,
} from "../src/hotLeadWatch.mjs";

const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const LONG_AGO = NOW - HOT_LEAD_SILENT_MS - 60_000;
const JUST_NOW = NOW - 60_000;

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function customer(overrides = {}) {
  return {
    line_user_id: "U-hot", last_score: 10, human_owner: "",
    last_seen_by_operator_at: 0, updated_at: LONG_AGO, ...overrides,
  };
}

test("ลูกค้าร้อนที่เงียบนานและไม่มีใครรับช่วง = ต้องถูกจับ", () => {
  const found = findStalledHotLeads([customer()], { now: NOW });
  assert.equal(found.length, 1);
});

test("มีคนรับช่วงแล้ว หรือเคยเปิดห้องแล้ว = ไม่ต้องเตือนซ้ำ", () => {
  assert.equal(findStalledHotLeads([customer({ human_owner: "ชมพู่" })], { now: NOW }).length, 0);
  assert.equal(findStalledHotLeads([customer({ last_seen_by_operator_at: NOW })], { now: NOW }).length, 0);
});

test("ยังไม่ร้อนพอ หรือเพิ่งคุยกันเมื่อกี้ = ยังไม่ต้องเตือน", () => {
  assert.equal(findStalledHotLeads([customer({ last_score: 7 })], { now: NOW }).length, 0);
  assert.equal(findStalledHotLeads([customer({ last_score: null })], { now: NOW }).length, 0);
  assert.equal(findStalledHotLeads([customer({ updated_at: JUST_NOW })], { now: NOW }).length, 0);
});

test("ติดป้ายและเขียนโน้ตให้ทีมงาน แต่ต้องไม่แตะช่องทางส่งข้อความเลย", () => {
  const tags = [];
  const notes = [];
  const db = {
    listStalledHotLeadCandidates: () => [customer()],
    listTags: () => [],
    addTag: (customerId, tag, source) => tags.push({ customerId, tag, source }),
    addHandoffNote: (row) => notes.push(row),
  };
  const result = flagStalledHotLeads({ db, now: () => NOW, logger: silent });

  assert.equal(result.flagged, 1);
  assert.deepEqual(tags, [{ customerId: "U-hot", tag: HOT_LEAD_TAG, source: "ai" }]);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].author, "ai_auto");
  assert.match(notes[0].text, /คะแนนความสนใจ 10\/10/u);
  assert.match(notes[0].text, /ระบบไม่ได้ทักลูกค้าเอง/u, "โน้ตต้องบอกชัดว่าไม่ได้ทักลูกค้า");
});

test("ติดป้ายไปแล้วต้องไม่เขียนโน้ตซ้ำทุกรอบ", () => {
  const notes = [];
  const db = {
    listStalledHotLeadCandidates: () => [customer()],
    listTags: () => [{ tag: HOT_LEAD_TAG, source: "ai" }],
    addTag: () => { throw new Error("ต้องไม่ถูกเรียก"); },
    addHandoffNote: (row) => notes.push(row),
  };
  assert.equal(flagStalledHotLeads({ db, now: () => NOW, logger: silent }).flagged, 0);
  assert.equal(notes.length, 0);
});

test("DB ล้มต้องไม่ทำให้ตัวเฝ้าโยน error ออกไปกระทบงานอื่น", () => {
  const db = { listStalledHotLeadCandidates: () => { throw new Error("db down"); } };
  assert.deepEqual(flagStalledHotLeads({ db, now: () => NOW, logger: silent }), { flagged: 0, skipped: true });

  const partial = {
    listStalledHotLeadCandidates: () => [customer()],
    listTags: () => [],
    addTag: () => { throw new Error("write failed"); },
  };
  assert.equal(flagStalledHotLeads({ db: partial, now: () => NOW, logger: silent }).flagged, 0);
});
