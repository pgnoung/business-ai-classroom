import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BRAND, makeBrand, setActiveBrand } from "../src/brand.mjs";
import { priceRule, withPriceDirectiveCapture } from "../src/priceDirectives.mjs";
import { buildClassRoutingRules } from "../src/salesMotion.mjs";

test("generic branding leaves customer goal evidence exact while rewriting static routing rules", (t) => {
  setActiveBrand(makeBrand({
    profile: "generic",
    agentName: "น้องมะลิ",
    ownerName: "เจ้าของร้าน",
    businessName: "ร้านทดสอบ",
  }));
  t.after(() => setActiveBrand(DEFAULT_BRAND));

  const customerText = "อยากให้พี่ง้วงช่วยทำคอนเทนต์ให้ร้านค่ะ";
  const rules = buildClassRoutingRules({ text: customerText }).join("\n");

  assert.match(rules, /"evidence":"อยากให้พี่ง้วงช่วยทำคอนเทนต์ให้ร้านค่ะ"/u);
  assert.match(rules, /สินค้าใดเหมาะที่สุด/u, "static course wording must still be branded for generic businesses");
});

test("priceRule captures and returns caller text without rewriting customer evidence", () => {
  const evidence = "ลูกค้าพิมพ์ว่าพี่ง้วงสอนอะไร";
  const captured = withPriceDirectiveCapture(() => priceRule("neutral", evidence));

  assert.equal(captured.text, evidence);
  assert.deepEqual(captured.directives, [{ side: "neutral", text: evidence }]);
});
