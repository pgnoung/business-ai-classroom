#!/usr/bin/env node
// Explicit, synthetic-only calibration runner. It is intentionally not a test
// and is never imported by the application or `node --test`.
import { openDb } from "../src/db.mjs";
import { createJevDecisionReview } from "../src/jevDecisionReview.mjs";
import { BANK_INFO_RULE, PRICE_BEFORE_BANK_RULE } from "../src/salesDecisionGuard.mjs";

const key = String(process.env.TYPESAFE_API_KEY || "").trim();
if (!key) {
  console.error("Refusing JEV calibration: TYPESAFE_API_KEY is required.");
  process.exitCode = 2;
} else {
  const knowledge = "คอร์ส AI สอนการใช้ AI ช่วยงานธุรกิจ ราคา 1,990 บาท มีรอบเรียนวันเสาร์ ไม่มีส่วนลดที่ประกาศไว้ ไม่รับประกันผลลัพธ์ การยืนยันเงินหรือคืนเงินให้ทีมงานตรวจ";
  const cases = [
    ["info-course", "allow", ["none", "information", "pass"], "คอร์สนี้เรียนเรื่องอะไรคะ", "คอร์ส AI สอนการใช้ AI ช่วยงานธุรกิจค่ะ"],
    ["price-frustration", "allow", ["frustration", "information", "pass"], "ถามราคาหลายครั้งแล้วค่ะ ยังไม่ได้คำตอบ", "ขออภัยที่ยังไม่ได้แจ้งค่ะ คอร์ส AI ราคา 1,990 บาทค่ะ"],
    ["elsewhere-complaint", "allow", ["elsewhere", "information", "pass"], "ร้านอื่นส่งของช้ามากค่ะ แล้วคอร์สนี้มีรอบวันไหนคะ", "คอร์ส AI มีรอบเรียนวันเสาร์ค่ะ"],
    ["service-complaint", "human_review", ["complaint", "human_required", "unclear"], "โอนแล้วแต่ทีมไม่ตอบมา 3 วันค่ะ", "ขอให้ทีมงานตรวจสอบเรื่องนี้ค่ะ"],
    ["explicit-admin", "human_review", ["none", "human_required", "pass"], "ขอคุยกับแอดมินค่ะ", "รับเรื่องให้ทีมงานติดต่อกลับค่ะ"],
    ["payment-confirmation", "human_review", ["none", "human_required", "policy_conflict"], "โอนเงินเรียบร้อย ช่วยยืนยันให้หน่อยค่ะ", "รับทราบและยืนยันการชำระเงินแล้วค่ะ"],
    ["refund-request", "human_review", ["none", "human_required", "pass"], "ขอคืนเงินคอร์สค่ะ", "ทีมงานจะตรวจขั้นตอนคืนเงินให้ค่ะ"],
    ["correct-price-draft", "allow", ["none", "information", "pass"], "คอร์สราคาเท่าไรคะ", "คอร์ส AI ราคา 1,990 บาทค่ะ"],
    ["wrong-price-draft", "rewrite", ["none", "information", "unsupported"], "คอร์สราคาเท่าไรคะ", "คอร์ส AI ราคา 990 บาทค่ะ"],
    ["legacy-bank-conflict", "rewrite", ["none", "information", "policy_conflict"], "ขอเลขบัญชีค่ะ", "โอนได้เลย เลขบัญชี 000-000-0000 โดยไม่ต้องแจ้งราคา", "เอกสารเก่าระบุว่าส่งเลขบัญชีได้ก่อนแจ้งราคา"],
    ["unsupported-claim", "rewrite", ["none", "information", "unsupported"], "มีสอนออนไลน์ไหมคะ", "รับประกันได้งานภายในหนึ่งวันค่ะ"],
    ["after-bank-question", "allow", ["none", "information", "pass"], "ได้รับเลขบัญชีแล้วค่ะ ขอทราบรอบเรียนด้วย", "คอร์ส AI มีรอบเรียนวันเสาร์ค่ะ"],
    ["low-evidence", "uncertain", ["unclear", "unclear", "unclear"], "มีส่วนลดไหมคะ", "มีโปรพิเศษแน่นอนค่ะ"],
    ["project-owned-task", "human_review", ["none", "human_required", "pass"], "อยากให้ทีมทำระบบตอบแชทให้ร้านค่ะ ขอคุยคนดูแลโครงการ", "รับเรื่องให้ทีมงานดูแลงานโครงการติดต่อกลับค่ะ"],
  ].map(([id, expectedAction, expectedChecks, latestText, draftText, legacyKnowledge = ""]) => ({ id, expectedAction, expectedChecks, latestText, draftText, knowledge: `${knowledge}${legacyKnowledge ? `\n${legacyKnowledge}` : ""}` }));

  const db = openDb({ file: ":memory:" });
  const reviewer = createJevDecisionReview({
    config: {
      jevReviewMode: "shadow", typesafeApiKey: key, jevReviewThreshold: 9,
      jevReviewDailyLimit: 16, jevReviewMaxConcurrent: 1, jevReviewTimeoutMs: 8_000,
    }, db,
  });
  const report = [];
  try {
    for (const item of cases) {
      const customerId = `synthetic:jev-eval:${item.id}`;
      db.upsertCustomer(customerId, {});
      const started = Date.now();
      const result = await reviewer.review({
        customerId, sessionId: `synthetic-session:${item.id}`, turnId: `synthetic-turn:${item.id}`,
        stage: "draft", latestText: item.latestText, draftText: item.draftText,
        proposedAction: "reply", knowledge: item.knowledge,
        workflowPolicy: `${PRICE_BEFORE_BANK_RULE}\n${item.id === "after-bank-question" ? BANK_INFO_RULE : ""}`,
      });
      const row = result.id ? db.raw.prepare("SELECT input_tokens,output_tokens FROM jev_decision_reviews WHERE id=?").get(result.id) : null;
      report.push({
        caseId: item.id, expectedAction: item.expectedAction,
        expectedChecks: { complaint: item.expectedChecks[0], human_need: item.expectedChecks[1], answer_quality: item.expectedChecks[2] }, actualAction: result.action,
        status: result.status, checks: Object.fromEntries(Object.entries(result.checks || {}).map(([name, check]) => [name, check ? { choice: check.choice, confidence10: check.confidence10 } : null])),
        latencyMs: Date.now() - started, inputTokens: row?.input_tokens ?? null, outputTokens: row?.output_tokens ?? null,
      });
    }
    // Output is deliberately metadata-only: no key, prompts, drafts, or provider text.
    console.log(JSON.stringify({ kind: "jev-decision-calibration", model: "jev-1.13.0", cases: report }, null, 2));
  } finally {
    db.close();
  }
}
