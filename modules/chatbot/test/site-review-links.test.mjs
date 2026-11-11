// Review links on pngoungacademy.com (2026-09-24): the review catalog may point at the
// review's own page instead of the Facebook reel. Only link recognition changes — who
// gets which review (sector/persona/format/course/kind) and "never send a review twice"
// must behave exactly as with the Facebook links.
import test from "node:test";
import assert from "node:assert/strict";
import { memoryDb, poisonGlobalFetch } from "./helpers.mjs";
import { focusReviewKnowledge, parseCatalogText, reviewUrlKey, selectReview } from "../src/reviewSelection.mjs";
import { parseReviewDoc, renderReviewDoc, validateReviewDoc } from "../src/reviewCatalogDoc.mjs";
import { catalogHash, prepareReviewCatalogUpdate } from "../src/reviewCatalogUpdate.mjs";
import { parseReviewCatalog } from "../src/stagedFollowups.mjs";
poisonGlobalFetch();

const GUID = "f8721601-20cb-4dca-8206-75e33a7deff9";
const bot = content => ({ role: "assistant", content });
const user = content => ({ role: "user", content });

// The same catalog twice: Facebook links (live today) and the site links that replace them.
const ROWS = [
  ["Classroom - AI Agent For Business", "คุณเอ · เจ้าของร้านอาหาร", "share/r/1AaaaaaaaA", "1AaaaaaaaA"],
  ["Classroom - AI Agent For Business", "คุณบี · คลินิกความงาม", "share/v/1BbbbbbbbB/?mibextid=wwXIfr", "1BbbbbbbbB"],
  ["Classroom - Workflow Automation", "คุณซี · โรงงานผลิตอาหาร", "reel/100000000000757", "100000000000757"],
  ["Private - AI Agent For Business", "คุณดี · สำนักงานบัญชี", "share/r/1DdddddddD", "1DdddddddD"],
  ["In-house - Workflow Automation", "ทีมงาน · บริษัทขนส่ง", "share/r/1EeeeeeeeE", "1EeeeeeeeE"],
  ["ตัวอย่างวิดิโอที่ตัดต่อด้วย AI", "ตัวอย่างคอนเทนต์ AI", "share/r/1FffffffF", null],
];
function catalogText(site) {
  const sections = [];
  for (const [section, who, fbPath, token] of ROWS) {
    let group = sections.find(s => s.name === section);
    if (!group) sections.push(group = { name: section, items: [] });
    const url = site && token ? `https://pngoungacademy.com/reviews/${token}` : `https://www.facebook.com/${fbPath}`;
    group.items.push({ who, url });
  }
  return renderReviewDoc({ preamble: "รีวิวนักเรียนจริง — วิธีใช้เดิม", sections });
}
const FB = parseCatalogText(catalogText(false));
const SITE = parseCatalogText(catalogText(true));

test("a site review link is the same review as the Facebook link it replaced", () => {
  assert.equal(reviewUrlKey("https://pngoungacademy.com/reviews/1AaaaaaaaA"), reviewUrlKey("https://www.facebook.com/share/r/1AaaaaaaaA/"));
  assert.equal(reviewUrlKey("https://pngoungacademy.com/reviews/1BbbbbbbbB"), reviewUrlKey("https://www.facebook.com/share/v/1BbbbbbbbB/?mibextid=wwXIfr"));
  assert.equal(reviewUrlKey("https://www.pngoungacademy.com/reviews/100000000000757/"), reviewUrlKey("https://web.facebook.com/reel/100000000000757"));
  assert.equal(reviewUrlKey("https://pngoungacademy.com/reviews/1AaaaaaaaA?utm_source=line#x"), reviewUrlKey("https://pngoungacademy.com/reviews/1AaaaaaaaA"));
  // Reviews without a Facebook source are named by their video id.
  assert.equal(reviewUrlKey(`https://pngoungacademy.com/reviews/${GUID.toUpperCase()}`), `https://pngoungacademy.com/reviews/${GUID}`);
  for (const value of ["https://www.facebook.com/share/v/1BbbbbbbbB/", "https://pngoungacademy.com/reviews/1AaaaaaaaA", `https://pngoungacademy.com/reviews/${GUID}`]) {
    assert.equal(reviewUrlKey(reviewUrlKey(value)), reviewUrlKey(value), `key of ${value} is stable`);
  }
});

test("only review pages on the real domain count as review links", () => {
  for (const bad of [
    "http://pngoungacademy.com/reviews/1AaaaaaaaA",
    "https://pngoungacademy.com/reviews/1AaaaaaaaA/og.png",
    "https://pngoungacademy.com/courses/custom-ai-army",
    "https://pngoungacademy.com/reviews",
    "https://pngoungacademy.com/reviews/abc",
    "https://pngoungacademy.com/reviews/a%2Fb",
    "https://pngoungacademy.com.evil.test/reviews/1AaaaaaaaA",
    "https://user:pw@pngoungacademy.com/reviews/1AaaaaaaaA",
    "https://pngoungacademy.com:8443/reviews/1AaaaaaaaA",
  ]) assert.equal(reviewUrlKey(bad), null, bad);
});

test("switching to site links keeps every item and the same choice of review", () => {
  assert.equal(SITE.length, FB.length);
  assert.deepEqual(SITE.map(r => [r.section, r.who, r.kind]), FB.map(r => [r.section, r.who, r.kind]));
  const contexts = [
    { text: "ทำร้านอาหารค่ะ อยากดูรีวิว" },
    { text: "เปิดคลินิกความงาม มีรีวิวไหม" },
    { text: "ขอรีวิว Workflow ค่ะ", history: [user("มีโรงงานผลิต")] },
    { text: "สนใจเรียน private ครับ ขอรีวิว" },
    { text: "อยากอบรมพนักงานในบริษัท workflow" },
    { text: "ขอรีวิวหน่อยค่ะ", personaType: "logistics" },
    { text: "ขอดูตัวอย่างคอนเทนต์", kind: "showcase" },
  ];
  for (const context of contexts) {
    assert.equal(selectReview(SITE, context)?.who, selectReview(FB, context)?.who, JSON.stringify(context));
  }
  // The model is shown the site link of the chosen review, never the Facebook one.
  const focused = focusReviewKnowledge(catalogText(true), { text: "ทำร้านอาหารค่ะ อยากดูรีวิว", score: 6 });
  assert.match(focused, /pngoungacademy\.com\/reviews\/1AaaaaaaaA/);
  assert.doesNotMatch(focused, /facebook\.com\/share\/r\/1AaaaaaaaA/);
});

test("a customer who already got the reel is not sent the same review as a site link", t => {
  const db = memoryDb(); t.after(() => db.close());
  const id = "U-site-review-continuity"; db.upsertCustomer(id, {});
  db.insertMessage({ customerId: id, direction: "out", msgType: "text", content: "https://www.facebook.com/share/r/1AaaaaaaaA/", operator: "system" });
  const context = { text: "ทำร้านอาหารค่ะ อยากดูรีวิว" };
  assert.equal(selectReview(SITE, context)?.who, "คุณเอ · เจ้าของร้านอาหาร");
  const next = selectReview(SITE, { ...context, sentUrls: db.sentReviewUrls(id) });
  assert.ok(next, "another review is still offered");
  assert.notEqual(next.who, "คุณเอ · เจ้าของร้านอาหาร");
  // Same through the visible history, as the reactive path sees it.
  assert.notEqual(selectReview(SITE, { ...context, history: [bot("https://web.facebook.com/share/r/1AaaaaaaaA/?mibextid=1")] })?.who, "คุณเอ · เจ้าของร้านอาหาร");
});

test("site links sent after the switch are remembered for a lifetime too", t => {
  const db = memoryDb(); t.after(() => db.close());
  const id = "U-site-review-memory"; db.upsertCustomer(id, {});
  for (const content of [
    "ดูคลิปนี้ได้เลยค่ะ\nhttps://pngoungacademy.com/reviews/1AaaaaaaaA",
    `https://pngoungacademy.com/reviews/${GUID}`,
    "https://pngoungacademy.com/courses/custom-ai-army",
  ]) db.insertMessage({ customerId: id, direction: "out", msgType: "text", content, operator: "system" });
  db.insertMessage({ customerId: id, direction: "in", msgType: "text", content: "https://pngoungacademy.com/reviews/1DdddddddD" });
  for (let i = 0; i < 20; i++) db.insertMessage({ customerId: id, direction: "out", msgType: "text", content: "ข้อความทดสอบ", operator: "system" });
  const sent = db.sentReviewUrls(id);
  assert.deepEqual([...sent].sort(), [reviewUrlKey("https://www.facebook.com/share/r/1AaaaaaaaA"), `https://pngoungacademy.com/reviews/${GUID}`].sort());
  assert.equal(selectReview(SITE.filter(r => r.who === "คุณเอ · เจ้าของร้านอาหาร"), { sentUrls: sent }), null);
});

test("the Console accepts site review links and still refuses other sites", () => {
  const doc = parseReviewDoc(catalogText(true));
  assert.deepEqual(validateReviewDoc(doc), []);
  assert.deepEqual(validateReviewDoc({ sections: [{ name: "กลุ่ม", items: [{ who: "คุณเอ", url: `https://pngoungacademy.com/reviews/${GUID}` }] }] }), []);
  const bad = validateReviewDoc({ sections: [{ name: "กลุ่ม", items: [
    { who: "คุณเอ", url: "https://pngoungacademy.com/courses/custom-ai-army" },
    { who: "คุณบี", url: "https://evil.example.com/reviews/1AaaaaaaaA" },
  ] }] });
  assert.ok(bad.some(e => e.includes("pngoungacademy.com")), bad.join("\n"));
  assert.ok(bad.some(e => e.includes("evil.example.com")), bad.join("\n"));
  // The Facebook link and the site link of one review are the same review.
  const twice = validateReviewDoc({ sections: [{ name: "กลุ่ม", items: [
    { who: "คุณเอ", url: "https://www.facebook.com/share/r/1AaaaaaaaA/" },
    { who: "คุณเอ", url: "https://pngoungacademy.com/reviews/1AaaaaaaaA" },
  ] }] });
  assert.ok(twice.some(e => e.includes("ซ้ำ")), twice.join("\n"));
  // Follow-ups read the same items from the saved text.
  assert.deepEqual(parseReviewCatalog([{ title: "รีวิวนักเรียนจริง", content: catalogText(true), active: 1 }]).map(r => r.who), FB.map(r => r.who));
});

test("the catalog refresh replaces Facebook links in place instead of keeping both", t => {
  const db = memoryDb(); t.after(() => db.close());
  const row = db.addKnowledge({ title: "รีวิวนักเรียนจริง", content: catalogText(false) });
  const doc = parseReviewDoc(catalogText(true));
  const prepared = prepareReviewCatalogUpdate(db, {
    entryId: row.id, expectedContentSha256: catalogHash(row.content), title: "รีวิวนักเรียนจริง", source: "site-links", doc,
  });
  assert.equal(prepared.summary.preserved, 0);
  assert.equal(prepared.summary.after, prepared.summary.before);
  assert.doesNotMatch(prepared.content, /รายการเดิมที่รักษาไว้/);
  assert.equal(prepared.content, catalogText(true));
  assert.doesNotMatch(prepared.content, /facebook\.com\/share\/r\/1AaaaaaaaA/);
  assert.match(prepared.content, /facebook\.com\/share\/r\/1FffffffF/, "items without a site page keep their Facebook link");
});
