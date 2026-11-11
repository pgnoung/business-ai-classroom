// brain-gate5b.test.mjs — ด่านเดียวที่เสียเงินจริง: ต้องกดโดนโดยบังเอิญไม่ได้
//
// กติกาเหล็กของไฟล์นี้: **ห้ามมีเทสต์ไหนแตะโมเดลจริง** — fetch ถูกวางยาไว้ทั้งไฟล์
// และ askModel ถูกฉีดเข้ามาเป็น stub ที่นับจำนวนครั้งเสมอ
//
// สิ่งที่ต้องกันไว้ให้ได้:
//   - แฟล็กปิด = ยิงศูนย์ครั้ง (ข้อสำคัญที่สุด)
//   - ไม่มีตั๋วยืนยัน = ยิงศูนย์ครั้ง
//   - ตั๋วของรุ่นอื่น / ยอดอื่น / หมดอายุ = ยิงศูนย์ครั้ง
//   - ไม่ฉีด askModel = โยน ไม่ใช่ต่อสายเอง
//   - ไม่รายงานค่าใช้จ่ายก่อน = โยน (กติกา eval/COST.md)
//   - ยอดที่รายงานต้องมาก่อนคำขอแรก ไม่ใช่หลัง
import test from "node:test";
import assert from "node:assert/strict";
import { poisonGlobalFetch } from "./helpers.mjs";
import {
  runGate5b, planG5b, g5bConfirmToken, verifyG5bConfirm, differs,
  CONFIRM_TTL_MS, G5bRefused,
} from "../src/brain/gate5b.mjs";
import { estimateG5bCost, G5B_CAPS } from "../src/brain/gate5bCost.mjs";

poisonGlobalFetch();

const SECRET = "test-instance-secret";
const TREE = "tree-sha-abc";
const CARDS = [
  {
    itemId: "fact:parking", kind: "fact", key: "fact:parking", scope: { product: "*" },
    body: { kind: "fact", title: "ที่จอดรถ", content: "จอดฟรี 4 ชั่วโมง", question_th: ["ที่จอดรถมีไหมคะ"] },
  },
  {
    itemId: "fact:parking-old", kind: "fact", key: "fact:parking-old", scope: { product: "*" },
    body: { kind: "fact", title: "ที่จอดรถอาคารข้าง ๆ", content: "จอดฟรี 2 ชั่วโมง" },
  },
];
const TURNS = [{
  turn_id: "probe-logistics-01#1", case_id: "probe-logistics-01", turn_no: 1,
  synthetic_text: "ที่จอดรถมีไหมคะ", recorded_model_output: null, expected_json: "[]",
  route_inputs_json: "{}", severity: "style", origin: "eval_case", scope_json: '{"product":"*"}',
  labelled_at: 1,
}];

function stubModel(answers = {}) {
  const calls = [];
  const askModel = async ({ versionId, text }) => {
    calls.push({ versionId, text });
    return answers[versionId] ?? "จอดฟรี 2 ชั่วโมงค่ะ";
  };
  return { askModel, calls };
}

function confirmFor(plan, now = Date.now()) {
  return g5bConfirmToken({ treeSha256: TREE, thb: plan.estimate.thb, issuedAt: now, secret: SECRET });
}

// ที่เก็บตั๋วที่ใช้ไปแล้ว — ของจริงอยู่ในธุรกรรมเดียวกับที่เริ่มรัน (ดู runGate5b)
function nonceStore() {
  const used = new Set();
  return { used, consume: (nonce) => (used.has(nonce) ? false : (used.add(nonce), true)) };
}

const base = {
  treeSha256: TREE, secret: SECRET, cards: CARDS, turns: TURNS, touched: ["fact:parking"],
  nonceStore: nonceStore(),
};

test("แฟล็กปิด = ยิงโมเดลศูนย์ครั้ง (ข้อสำคัญที่สุดของไฟล์นี้)", async () => {
  const { askModel, calls } = stubModel();
  for (const gateMode of ["", "offline", "Heavy", "heavy "]) {
    const report = await runGate5b({ ...base, gateMode, askModel, onEstimate: () => {}, confirm: "x" });
    assert.equal(report.verdict, "not_applicable", `โหมด "${gateMode}" ต้องไม่ทำงาน`);
    assert.equal(report.calls, 0);
  }
  assert.equal(calls.length, 0, "ต้องไม่มีคำขอไปหาโมเดลแม้แต่ครั้งเดียว");
});

test("ไม่มีตั๋วยืนยัน = ปฏิเสธ และยิงศูนย์ครั้ง", async () => {
  const { askModel, calls } = stubModel();
  await assert.rejects(
    () => runGate5b({ ...base, gateMode: "heavy", confirm: "", askModel, onEstimate: () => {} }),
    (err) => err instanceof G5bRefused && err.reason === "confirm_required",
  );
  assert.equal(calls.length, 0);
});

test("ตั๋วของรุ่นอื่น / ยอดอื่น / หมดอายุ ใช้ไม่ได้", async () => {
  const now = Date.now();
  const plan = planG5b({ ...base });
  const { askModel, calls } = stubModel();
  const attempts = [
    g5bConfirmToken({ treeSha256: "tree-อื่น", thb: plan.estimate.thb, issuedAt: now, secret: SECRET }),
    g5bConfirmToken({ treeSha256: TREE, thb: plan.estimate.thb + 100, issuedAt: now, secret: SECRET }),
    g5bConfirmToken({ treeSha256: TREE, thb: plan.estimate.thb, issuedAt: now - CONFIRM_TTL_MS - 1000, secret: SECRET }),
    g5bConfirmToken({ treeSha256: TREE, thb: plan.estimate.thb, issuedAt: now, secret: "กุญแจอื่น" }),
  ];
  for (const confirm of attempts) {
    await assert.rejects(() => runGate5b({ ...base, gateMode: "heavy", confirm, askModel, onEstimate: () => {}, now }));
  }
  assert.equal(calls.length, 0, "ตั๋วที่ใช้ไม่ได้ต้องไม่ทำให้เกิดคำขอสักครั้ง");
});

test("ไม่ฉีด askModel = โยน ไม่ใช่ต่อสายเอง", async () => {
  const now = Date.now();
  const plan = planG5b({ ...base });
  await assert.rejects(
    () => runGate5b({ ...base, gateMode: "heavy", confirm: confirmFor(plan, now), now, onEstimate: () => {} }),
    (err) => err.reason === "no_client",
  );
});

test("ไม่รายงานค่าใช้จ่ายก่อน = โยน (กติกา eval/COST.md)", async () => {
  const now = Date.now();
  const plan = planG5b({ ...base });
  const { askModel, calls } = stubModel();
  await assert.rejects(
    () => runGate5b({ ...base, gateMode: "heavy", confirm: confirmFor(plan, now), now, askModel }),
    (err) => err.reason === "no_cost_report",
  );
  assert.equal(calls.length, 0);
});

test("ยอดเงินถูกรายงาน **ก่อน** คำขอแรก ไม่ใช่หลัง", async () => {
  const now = Date.now();
  const plan = planG5b({ ...base });
  const { askModel, calls } = stubModel();
  let callsWhenReported = -1;
  const report = await runGate5b({
    ...base, gateMode: "heavy", confirm: confirmFor(plan, now), now, askModel,
    onEstimate: (estimate) => {
      callsWhenReported = calls.length;
      assert.match(estimate.thaiSummary, /บาท/u, "ต้องบอกยอดเป็นบาท");
      assert.ok(estimate.workings.length >= 4, "ต้องแสดงวิธีคิดให้ตรวจทานได้");
    },
  });
  assert.equal(callsWhenReported, 0, "ตอนรายงานยอด ต้องยังไม่มีคำขอเกิดขึ้นเลย");
  assert.ok(calls.length > 0, "หลังยืนยันครบแล้วถึงจะยิงจริง");
  assert.equal(report.verdict, "pass");
});

test("คำตอบสองรุ่นต่างกันเรื่องข้อเท็จจริง -> ต้องรับทราบ + รันซ้ำก่อนนับ", async () => {
  const now = Date.now();
  const plan = planG5b({ ...base });
  const { askModel, calls } = stubModel({ live: "จอดฟรี 2 ชั่วโมงค่ะ", candidate: "จอดฟรี 4 ชั่วโมงค่ะ" });
  const report = await runGate5b({
    ...base, gateMode: "heavy", confirm: confirmFor(plan, now), now, askModel,
    liveVersionId: "live", candidateVersionId: "candidate", onEstimate: () => {},
  });
  assert.equal(report.verdict, "needs_ack");
  assert.ok(report.findings.length >= 1);
  assert.match(report.findings[0].message, /ต่างจากรุ่นที่ใช้อยู่|ไม่ตรงกัน/u);
  // ทุกความต่างถูกรันซ้ำหนึ่งครั้งก่อนนับ -> จำนวนคำขอมากกว่าคู่ปกติ
  assert.ok(calls.length > report.pairs.length * 2, "ความต่างต้องถูกรันซ้ำก่อนนับ");
  assert.ok(report.cost.thb > 0, "ต้องบันทึกค่าใช้จ่ายจริงหลังรัน");
});

test("ตั๋วยืนยันใช้ได้ครั้งเดียว — ยืนยันหนึ่งครั้งเรียกเก็บเงินซ้ำไม่ได้", async () => {
  const now = Date.now();
  const plan = planG5b({ ...base });
  const store = nonceStore();
  const confirm = confirmFor(plan, now);
  const { askModel, calls } = stubModel();
  const first = await runGate5b({ ...base, nonceStore: store, gateMode: "heavy", confirm, now, askModel, onEstimate: () => {} });
  assert.equal(first.verdict, "pass");
  const spent = calls.length;
  assert.ok(spent > 0);
  await assert.rejects(
    () => runGate5b({ ...base, nonceStore: store, gateMode: "heavy", confirm, now, askModel, onEstimate: () => {} }),
    (err) => /ถูกใช้ไปแล้ว/u.test(err.message),
  );
  assert.equal(calls.length, spent, "ตั๋วใบเดิมต้องไม่ทำให้เกิดคำขอเพิ่มแม้แต่ครั้งเดียว");
});

test("ไม่มีที่เก็บตั๋วที่ใช้แล้ว = ปฏิเสธ (fail closed) ไม่ใช่ปล่อยให้ยิงซ้ำได้", async () => {
  const now = Date.now();
  const plan = planG5b({ ...base });
  const { askModel, calls } = stubModel();
  await assert.rejects(
    () => runGate5b({ ...base, nonceStore: null, gateMode: "heavy", confirm: confirmFor(plan, now), now, askModel, onEstimate: () => {} }),
    (err) => /ตั๋วที่ใช้แล้วไม่พร้อม/u.test(err.message),
  );
  assert.equal(calls.length, 0);
});

test("ยอดที่เซ็นคือเพดาน (รวมการรันซ้ำเต็มที่) ยอดจริงคิดจากตัวนับคำขอ", async () => {
  const now = Date.now();
  const plan = planG5b({ ...base });
  // ยอดที่เซ็น = แผนนี้ + การรันซ้ำเต็มเพดาน (ไม่ใช่เพดานสูงสุดของทุกแผน แต่เป็นเพดานของแผนนี้)
  const ceiling = estimateG5bCost({
    replayTurns: plan.replay.length, probes: plan.probes.length, rerunPairs: G5B_CAPS.rerunPairs,
  });
  assert.equal(plan.estimate.thb, ceiling.thb,
    "ยอดที่เอาไปให้เจ้าของเซ็น ต้องเป็นยอดที่ฟังก์ชันนี้ทำเกินไม่ได้");
  const noRerun = estimateG5bCost({ replayTurns: plan.replay.length, probes: plan.probes.length, rerunPairs: 0 });
  assert.ok(ceiling.thb > noRerun.thb, "เพดานต้องสูงกว่ากรณีไม่มีการรันซ้ำ ไม่งั้นไม่ได้เซ็นเพดานจริง");
  const { askModel, calls } = stubModel();
  const report = await runGate5b({ ...base, nonceStore: nonceStore(), gateMode: "heavy", confirm: confirmFor(plan, now), now, askModel, onEstimate: () => {} });
  assert.equal(report.cost.prompts, calls.length, "ยอดจริงต้องมาจากจำนวนคำขอที่เกิดขึ้นจริง");
  assert.ok(report.cost.thb <= plan.estimate.thb, "ยอดจริงต้องไม่เกินยอดที่เซ็นไว้");
});

test("ความต่างที่เกินเพดานการรันซ้ำ = 'ยังไม่ได้ยืนยัน' ไม่ใช่ finding ที่บล็อก", async () => {
  const now = Date.now();
  // การ์ดหลายใบ -> probe หลายข้อ -> ความต่างมากกว่าเพดานการรันซ้ำ
  const manyCards = Array.from({ length: 6 }, (_, i) => ({
    itemId: `fact:x${i}`, kind: "fact", key: `fact:x${i}`, scope: { product: "*" },
    body: { kind: "fact", title: `หัวข้อที่ ${i} ยาวพอ`, content: "y", question_th: [`คำถามข้อ ${i} คืออะไรคะ`] },
  }));
  const wide = { ...base, cards: manyCards, touched: manyCards.map((c) => c.itemId), nonceStore: nonceStore() };
  const plan = planG5b(wide);
  const { askModel } = stubModel({ live: "ราคา 2 ชั่วโมง", candidate: "ราคา 4 ชั่วโมง" });
  const report = await runGate5b({ ...wide, gateMode: "heavy", confirm: g5bConfirmToken({ treeSha256: TREE, thb: plan.estimate.thb, issuedAt: now, secret: SECRET }), now, askModel, onEstimate: () => {} });
  const total = report.findings.length + report.unverified.length;
  assert.ok(report.pairs.filter((p) => p.differs).length === total);
  for (const pair of report.pairs) {
    assert.notEqual(pair.confirmed, undefined, "ทุกความต่างต้องมีสถานะชัดเจน");
  }
  assert.equal(report.findings.every((f) => f.severity === "block"), true);
  assert.equal(report.unverified.every((u) => !("severity" in u)), true, "ถังยังไม่ยืนยันต้องไม่มี severity");
});

test("การเรียบเรียงใหม่ไม่นับเป็นความต่าง แต่ตัวเลข/คำปฏิเสธนับ", () => {
  assert.equal(differs("จอดฟรี 2 ชั่วโมงค่ะ", "ที่จอดฟรีนะคะ 2 ชั่วโมง"), false);
  assert.equal(differs("จอดฟรี 2 ชั่วโมง", "จอดฟรี 4 ชั่วโมง"), true);
  assert.equal(differs("มีที่จอดค่ะ", "ไม่มีที่จอดค่ะ"), true);
});

test("GPT-6 lowers G5b estimate while counting cache-write cost", () => {
  const typical = estimateG5bCost({ replayTurns: G5B_CAPS.replayTurns, probes: G5B_CAPS.probes, rerunPairs: 0 });
  const worst = estimateG5bCost({ replayTurns: 99, probes: 99, rerunPairs: 99 });
  assert.equal(typical.thb, 7.18, 'GPT-6 standard + first cache write at owner FX 34');
  assert.ok(worst.thb <= 25, `แย่ที่สุด ${worst.thb} บาท ต้องไม่เกิน 25 — เพดานคือสิ่งที่ทำให้ยอดคาดเดาได้`);
  assert.equal(verifyG5bConfirm({ token: "", treeSha256: TREE, thb: 1, secret: SECRET }).ok, false);
});
