import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BRAND, makeBrand, setActiveBrand } from "../src/brand.mjs";
import { buildConversationStyleRules } from "../src/conversationStyle.mjs";

test("generic branding rewrites static rules but preserves runtime literals", (t) => {
  setActiveBrand(makeBrand({
    profile: "generic",
    agentName: "น้องมะลิ",
    ownerName: "เจ้าของร้าน",
    businessName: "ร้านทดสอบ",
  }));
  t.after(() => setActiveBrand(DEFAULT_BRAND));

  const rules = buildConversationStyleRules({
    text: "สนใจค่ะ",
    customer: { known_name: "ลูกแพร" },
    askedQuestions: ["พี่ง้วงสอนอะไรบ้างคะ"],
    presetButton: {
      fromPresetButton: true,
      distinctButtons: ["ให้ลูกแพรช่วยแนะนำสินค้า"],
      tapCount: 1,
      buttonsOnlySoFar: true,
    },
    continuation: {
      action: "continue_previous_offer",
      offerText: "พี่ง้วงส่งรายละเอียดให้หน่อยค่ะ",
      offerHasMoney: false,
    },
  });

  assert.match(rules, /ลูกค้าเคยบอกชื่อเองว่า .*ลูกแพร/u);
  assert.match(rules, /พี่ง้วงสอนอะไรบ้างคะ/u);
  assert.match(rules, /ให้ลูกแพรช่วยแนะนำสินค้า/u);
  assert.match(rules, /พี่ง้วงส่งรายละเอียดให้หน่อยค่ะ/u);
  assert.match(rules, /ตัวเลขทุกตัวที่น้องมะลิพิมพ์/u, "static course-brand instructions must still be rewritten");
});
