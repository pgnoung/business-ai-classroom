import test from "node:test";
import assert from "node:assert/strict";
import { businessKeywordMap, businessKeywordRows } from "../public/console/settings.mjs";

test("settings campaign rows preserve bare key and deliveryText across open/save", () => {
  const original = {
    claude10x: {
      seed: "ขอรับไฟล์ Claude Project Setup",
      note: "ไฟล์ที่ผู้ดูแลยืนยัน",
      deliveryText: "รับไฟล์ได้ที่ https://drive.google.com/example",
    },
    "#online": "สนใจคลาสออนไลน์",
  };
  const rows = businessKeywordRows(original);
  assert.deepEqual(businessKeywordMap(rows), original);
});

test("settings prefixes legacy rows without delivery but keeps an explicit delivery keyword bare", () => {
  assert.deepEqual(businessKeywordMap([
    { tag: "online", seed: "สนใจคลาสออนไลน์", note: "", deliveryText: "" },
    { tag: "Claude10x", seed: "ขอรับไฟล์", note: "", deliveryText: "ลิงก์" },
  ]), {
    "#online": "สนใจคลาสออนไลน์",
    claude10x: { seed: "ขอรับไฟล์", deliveryText: "ลิงก์" },
  });
});
