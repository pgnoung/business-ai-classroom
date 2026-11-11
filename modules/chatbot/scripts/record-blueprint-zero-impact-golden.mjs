#!/usr/bin/env node
// record-blueprint-zero-impact-golden.mjs — บันทึกค่าอ้างอิงของ test/blueprint-zero-impact.test.mjs จากซอร์ส "ก่อนมีแคมเปญ"
//
// วิธีใช้ (จาก root ของ repo — ไม่แตะ network/LINE/โมเดลจริง ทุกอย่างเป็น stub ของ test/helpers.mjs):
//   mkdir -p /tmp/bp-golden && git archive <commit> outputs/apps/ai-front-line-chassis | tar -x -C /tmp/bp-golden
//   GOLDEN_COMMIT=<commit> node outputs/apps/ai-front-line-chassis/scripts/record-blueprint-zero-impact-golden.mjs \
//     /tmp/bp-golden/outputs/apps/ai-front-line-chassis \
//     outputs/apps/ai-front-line-chassis/test/fixtures/blueprint-zero-impact-golden.json
// ตัวเล่นซ้ำ (test/fixtures/blueprint-replay-harness.mjs) มาจากซอร์สปัจจุบันเสมอ ส่วน createApp/helpers มาจากซอร์สของคอมมิตที่ให้มา
// เล่นสองรอบแล้วต้องได้ผลเหมือนกันทุกไบต์ก่อนเขียนไฟล์ (กันค่าอ้างอิงที่สุ่มเปลี่ยนเอง)
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const [rootArg, outArg] = process.argv.slice(2);
if (!rootArg || !outArg) {
  console.error("usage: record-blueprint-zero-impact-golden.mjs <chassis-root-of-commit> <out.json>");
  process.exit(2);
}
const root = resolve(rootArg);
const helpers = await import(`${root}/test/helpers.mjs`);
helpers.poisonGlobalFetch();
const { createApp } = await import(`${root}/src/server.mjs`);
const { runReplay } = await import(new URL("../test/fixtures/blueprint-replay-harness.mjs", import.meta.url));
const deps = { createApp, ...helpers };
const first = await runReplay(deps);
const second = await runReplay(deps);
if (!isDeepStrictEqual(first, second)) {
  console.error("ผลสองรอบไม่ตรงกัน — ค่าอ้างอิงไม่นิ่ง ห้ามบันทึก");
  process.exit(1);
}
writeFileSync(resolve(outArg), `${JSON.stringify({ commit: process.env.GOLDEN_COMMIT || "", ...first }, null, 1)}\n`);
console.log(`บันทึกแล้ว: ${first.steps.length} ข้อความ · ${Object.keys(first.tablesAfter).length} ตาราง`);
