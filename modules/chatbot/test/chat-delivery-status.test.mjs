import test from "node:test";
import assert from "node:assert/strict";
import { messageEvidenceChips } from "../public/console/chat.mjs";

test("chat delivery status: provider acceptance is never labelled as customer read", () => {
  const accepted = messageEvidenceChips({
    direction: "out",
    delivery_status: { state: "accepted", proof: "line_request_accepted", read_receipt_available: false },
  });
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].label, "✓ LINE รับคำขอแล้ว");
  assert.doesNotMatch(JSON.stringify(accepted), /อ่านแล้ว/u);

  const partial = messageEvidenceChips({
    direction: "out",
    delivery_status: { state: "partial", proof: "line_request_accepted", read_receipt_available: false },
  });
  assert.equal(partial[0].label, "⚠ LINE รับได้บางส่วน");
  assert.doesNotMatch(JSON.stringify(partial), /อ่านแล้ว/u);
});

test("chat delivery status: customer reply is a separate interaction signal", () => {
  const chips = messageEvidenceChips({
    direction: "out",
    delivery_status: { state: "accepted" },
    customer_interaction_after: { type: "reply", at: 123 },
  });
  assert.deepEqual(chips.map((chip) => chip.kind), ["delivery", "interaction"]);
  assert.equal(chips[1].label, "↩ ลูกค้าตอบกลับหลังส่ง");
  assert.doesNotMatch(JSON.stringify(chips), /อ่านแล้ว/u);
  assert.deepEqual(messageEvidenceChips({ direction: "in" }), []);
});

test("chat delivery status: uncertain and rejected outcomes retain exact proof wording", () => {
  assert.equal(messageEvidenceChips({ direction: "out", delivery_status: { state: "ambiguous" } })[0].label, "? ผลส่งไม่ยืนยัน");
  assert.equal(messageEvidenceChips({ direction: "out", delivery_status: { state: "rejected" } })[0].label, "! LINE ปฏิเสธการส่ง");
});
