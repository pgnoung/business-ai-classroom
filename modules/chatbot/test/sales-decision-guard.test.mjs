import test from "node:test";
import assert from "node:assert/strict";
import { checkPriceBeforeBank, paymentInstructionsIndex } from "../src/salesDecisionGuard.mjs";

const courses = [{ name: "AI Workflow Automation", aliases: ["AI Agent Workflow Automation", "AWFA"] }, { name: "AI Agent for Business", aliases: ["AIAB"] }];
const approvedPrices = [{ label: "AI Agent Workflow Automation — Early Bird", amount: 15900 }, { label: "AI Agent for Business — Early Bird", amount: 12900 }, { label: "Classroom", amount: 19900 }];
const approvedAmounts = new Set(approvedPrices.map(row => row.amount));
const guard = ({ text, ...extra }) => checkPriceBeforeBank({ text, approvedAmounts, approvedPrices, courses, ...extra });
for (const payment of ["โอนเข้าบัญชี 0000000000", "บัญชีกสิกร 0000000000", "โอนมาที่ 000-0-00000-0", "พร้อมเพย์: 0000000000", "[IMAGE:payment-kbank]"]) {
  test(`payment variant requires course-bound price: ${payment}`, () => {
    assert.equal(guard({ text: payment }).ok, false);
    assert.equal(guard({ text: `AI Agent Workflow Automation ราคา 15,900 บาท\n${payment}` }).ok, true);
  });
}
test("wrong course price and generic price label are blocked", () => {
  assert.equal(guard({ text: "AI Agent Workflow Automation ราคา 12,900 บาท\nเลขบัญชี: 0000000000" }).ok, false);
  assert.equal(guard({ text: "AI Agent for Business ราคา 19,900 บาท\nเลขบัญชี: 0000000000" }).ok, false);
  assert.equal(guard({ text: "AI Agent Workflow Automation ราคา 19,900 บาท\nเลขบัญชี: 0000000000" }).ok, false);
});
test("bank requires one explicit course and rejects ambiguous customer course evidence", () => {
  assert.equal(guard({ text: "ค่าเรียน 15,900 บาท\nเลขบัญชี: 0000000000" }).ok, false);
  assert.equal(guard({ text: "AI Agent Workflow Automation ราคา 15,900 บาท\nเลขบัญชี: 0000000000", latestText: "สนใจ AI Agent for Business" }).ok, false);
  assert.equal(guard({ text: "AI Agent Workflow Automation และ AI Agent for Business ราคา 15,900 บาท\nเลขบัญชี: 0000000000" }).ok, false);
});
test("same course in current or prior customer evidence remains valid", () => {
  const text = "AI Agent Workflow Automation ราคา 15,900 บาท\nพร้อมเพย์: 0000000000";
  assert.equal(guard({ text, latestText: "สนใจ AWFA ค่ะ" }).ok, true);
  assert.equal(guard({ text, history: [{ role: "user", content: "อยากเรียน AI Agent Workflow Automation" }] }).ok, true);
});
test("approved label alias binds a different canonical name and newest selection wins", () => {
  const text = "AI Agent Workflow Automation ราคา 15,900 บาท\nพร้อมเพย์: 0000000000";
  assert.equal(guard({ text, latestText: "สนใจ AWFA ค่ะ", history: [{ role: "user", content: "ก่อนหน้านี้สนใจ AI Agent for Business" }] }).ok, true);
});
test("normal replies and a mention without instructions remain available", () => {
  assert.equal(guard({ text: "AI Agent Workflow Automation ราคา 15,900 บาทค่ะ" }).ok, true);
  assert.equal(paymentInstructionsIndex("เดี๋ยวแจ้งเลขบัญชีให้ค่ะ"), -1);
});
