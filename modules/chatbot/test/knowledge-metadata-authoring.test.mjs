// knowledge metadata authoring: server owns validation/readiness; the browser only proposes.
import test from "node:test";
import assert from "node:assert/strict";
import { request as nodeRequest } from "node:http";
import { createApp } from "../src/server.mjs";
import { hashPassword } from "../src/auth.mjs";
import { importCurrentSourcesAsVersion1, todayInBangkok } from "../src/brain/import.mjs";
import { knowledgeExpectedHash, knowledgeMetadataFromRow } from "../src/brain/knowledgeMetadata.mjs";
import { testConfig, memoryDb, hermesFetchStub, lineFetchStub, httpRequest, listen, poisonGlobalFetch } from "./helpers.mjs";
import { installBrowserGlobals } from "./console-dom.mjs";

poisonGlobalFetch();
const SECRET = "knowledge-metadata-authoring-secret-012345";
const PASSWORD = "knowledge-metadata-authoring-pass";
const QUIET = { warn() {}, debug() {}, log() {}, error() {} };

function textOf(node) {
  if (!node) return "";
  if (node.nodeType === 3) return String(node.textContent || "");
  return (node.children || []).map(textOf).join(" ");
}

function metadata(mode = "retrieve") {
  return { mode, domain: "การตลาด LINE", offering: "LINE สำหรับมือใหม่".normalize("NFKC"), keywords: ["แท็ก", "แชท"] };
}

async function boot(t, { ready = true } = {}) {
  const config = testConfig({ CONSOLE_SESSION_SECRET: SECRET, KNOWLEDGE_VERSIONED: "true", BRAIN_READ: "versioned" });
  config.brainRetrievalEnabled = true;
  const db = memoryDb();
  db.createOperator({ username: "ngoung", passHash: hashPassword(PASSWORD), role: "owner" });
  db.createOperator({ username: "chompoo", passHash: hashPassword(PASSWORD), role: "operator" });
  if (ready) importCurrentSourcesAsVersion1(db, { createdBy: "ngoung", logger: QUIET, todayIso: todayInBangkok(Date.now()) });
  const app = createApp({ config, db, logger: QUIET,
    overrides: { hermesFetch: hermesFetchStub(), lineFetch: lineFetchStub(), sleep: async () => {} } });
  await listen(app.server);
  t.after(() => { app.server.close(); db.close(); });
  return { app, db };
}

async function login(server, username) {
  const result = await request(server, "POST", "/console/api/login", { username, password: PASSWORD });
  assert.equal(result.status, 200);
  return { cookie: (result.headers["set-cookie"]?.[0] || "").split(";")[0], csrf: result.json.csrf };
}
function headers(session) { return { cookie: session.cookie, "x-csrf-token": session.csrf }; }
function request(server, method, path, body, extraHeaders = {}) {
  return httpRequest(server, { method, path, headers: { "content-type": "application/json", ...extraHeaders }, body: body === undefined ? null : JSON.stringify(body) });
}

function startStreamingJsonRequest(server, { path, headers, firstChunk }) {
  const address = server.address();
  // Observe the server's body-reader registration without consuming the stream.
  // The competing edit begins only after this handler is waiting for the rest
  // of the JSON, so the old read-row-before-body implementation deterministically loses.
  let resolveReading;
  const reading = new Promise((resolve) => { resolveReading = resolve; });
  server.prependOnceListener("request", (incoming) => {
    const onListener = (event) => {
      if (event !== "end") return;
      incoming.removeListener("newListener", onListener);
      resolveReading();
    };
    incoming.on("newListener", onListener);
  });
  let resolveResponse;
  let rejectResponse;
  const response = new Promise((resolve, reject) => { resolveResponse = resolve; rejectResponse = reject; });
  const req = nodeRequest({
    host: "127.0.0.1", port: address.port, method: "POST", path,
    headers: { "content-type": "application/json", ...headers }, agent: false,
  }, (res) => {
    const chunks = [];
    res.on("data", (chunk) => chunks.push(chunk));
    res.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolveResponse({ status: res.statusCode, json: JSON.parse(text) });
    });
  });
  req.once("error", rejectResponse);
  req.write(firstChunk);
  return { reading, finish: (remainingChunk) => { req.end(remainingChunk); return response; } };
}

test("metadata invalid / not-ready is refused before mutation and absent metadata stays legacy", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const bad = await request(app.server, "POST", "/console/api/knowledge", { title: "แท็ก", content: "คำอธิบาย", knowledgeMetadata: { mode: "retrieve", domain: "LINE OA" } }, headers(owner));
  assert.equal(bad.status, 400);
  assert.equal(db.listKnowledge().length, 0);

  const legacy = await request(app.server, "POST", "/console/api/knowledge", { title: "คำถามทั่วไป", content: "รายละเอียด" }, headers(owner));
  assert.equal(legacy.status, 200);
  assert.equal(knowledgeMetadataFromRow(legacy.json.entry), null, "รายการเดิมไม่มี metadata ต้องไม่เปลี่ยนความหมาย");
  assert.ok(legacy.json.entry.expectedKnowledgeHash, "legacy row needs a server token before its first metadata edit");
  db.updateKnowledge(legacy.json.entry.id, { provenance: { source: { importId: "legacy-import" } } });
  const latest = await request(app.server, "GET", "/console/api/knowledge", undefined, { cookie: owner.cookie });
  const current = latest.json.knowledge.find((row) => row.id === legacy.json.entry.id);
  const converted = await request(app.server, "POST", `/console/api/knowledge/${encodeURIComponent(current.id)}`, {
    knowledgeMetadata: metadata(), expectedKnowledgeHash: current.expectedKnowledgeHash,
  }, headers(owner));
  assert.equal(converted.status, 200, "legacy row can receive metadata using the latest server token");
  assert.equal(JSON.parse(db.getKnowledge(current.id).provenance_json).source.importId, "legacy-import", "metadata must retain lineage");
  assert.deepEqual(knowledgeMetadataFromRow(db.getKnowledge(current.id)), metadata());

  const { app: unavailable, db: unavailableDb } = await boot(t, { ready: false });
  const unavailableOwner = await login(unavailable.server, "ngoung");
  const notReady = await request(unavailable.server, "POST", "/console/api/knowledge", { title: "แท็ก", content: "คำอธิบาย", knowledgeMetadata: metadata() }, headers(unavailableOwner));
  assert.equal(notReady.status, 409);
  assert.equal(unavailableDb.listKnowledge().length, 0);
});

test("staff request keeps normalized metadata in approval queue; approved replay preserves other provenance", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");
  const queued = await request(app.server, "POST", "/console/api/knowledge", { title: "แท็ก LINE", content: "ใช้จัดกลุ่มบทสนทนา", knowledgeMetadata: metadata() }, headers(staff));
  assert.equal(queued.status, 202);
  assert.equal(db.listKnowledge().length, 0, "staff must not publish directly");
  const queuedBody = db.getPublishRequest(queued.json.requestId).body_json;
  assert.deepEqual(JSON.parse(queuedBody).knowledgeMetadata, metadata());

  const approved = await request(app.server, "POST", `/console/api/publish-requests/${encodeURIComponent(queued.json.requestId)}/approve`, {}, headers(owner));
  assert.equal(approved.status, 200);
  const row = db.listKnowledge()[0];
  assert.deepEqual(knowledgeMetadataFromRow(row), metadata());

  db.updateKnowledge(row.id, { provenance: { source: { importId: "source-1" }, knowledge: metadata() } });
  const edited = await request(app.server, "POST", `/console/api/knowledge/${encodeURIComponent(row.id)}`, {
    knowledgeMetadata: { ...metadata("pin"), keywords: [] }, expectedKnowledgeHash: knowledgeExpectedHash(db.getKnowledge(row.id)),
  }, headers(owner));
  assert.equal(edited.status, 200);
  const provenance = JSON.parse(db.getKnowledge(row.id).provenance_json);
  assert.equal(provenance.source.importId, "source-1");
  assert.deepEqual(knowledgeMetadataFromRow(db.getKnowledge(row.id)), { ...metadata("pin"), keywords: [] });
});

test("queued metadata edit becomes stale if owner changes the row, while unchanged approval applies once", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const staff = await login(app.server, "chompoo");
  const created = await request(app.server, "POST", "/console/api/knowledge", {
    title: "แท็ก LINE", content: "เดิม", knowledgeMetadata: metadata(),
  }, headers(owner));
  const id = created.json.entry.id;
  const staleQueued = await request(app.server, "POST", `/console/api/knowledge/${encodeURIComponent(id)}`, {
    content: "ข้อเสนอของทีม",
  }, headers(staff));
  assert.equal(staleQueued.status, 202);
  const ownerEdit = await request(app.server, "POST", `/console/api/knowledge/${encodeURIComponent(id)}`, {
    content: "เจ้าของแก้ล่าสุด", expectedKnowledgeHash: knowledgeExpectedHash(db.getKnowledge(id)),
  }, headers(owner));
  assert.equal(ownerEdit.status, 200);
  const stale = await request(app.server, "POST", `/console/api/publish-requests/${encodeURIComponent(staleQueued.json.requestId)}/approve`, {}, headers(owner));
  assert.equal(stale.status, 409);
  assert.equal(stale.json.staleKnowledge, true);
  assert.equal(db.getKnowledge(id).content, "เจ้าของแก้ล่าสุด", "stale queue must not overwrite the owner");
  assert.equal(db.getPublishRequest(staleQueued.json.requestId).status, "failed");

  const freshQueued = await request(app.server, "POST", `/console/api/knowledge/${encodeURIComponent(id)}`, {
    content: "ข้อเสนอที่ยังตรงรุ่น",
  }, headers(staff));
  assert.equal(freshQueued.status, 202);
  const approved = await request(app.server, "POST", `/console/api/publish-requests/${encodeURIComponent(freshQueued.json.requestId)}/approve`, {}, headers(owner));
  assert.equal(approved.status, 200);
  assert.equal(approved.json.applied, true);
  assert.equal(db.getKnowledge(id).content, "ข้อเสนอที่ยังตรงรุ่น");
});

test("a slow metadata edit cannot overwrite a newer owner edit made while its body is arriving", { timeout: 5000 }, async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const created = await request(app.server, "POST", "/console/api/knowledge", {
    title: "เรื่อง LINE", content: "เนื้อหาเดิม", knowledgeMetadata: metadata(),
  }, headers(owner));
  const id = created.json.entry.id;
  const staleBody = JSON.stringify({
    content: "ข้อความจากฟอร์มเก่า", expectedKnowledgeHash: created.json.entry.expectedKnowledgeHash,
  });
  const slow = startStreamingJsonRequest(app.server, {
    path: `/console/api/knowledge/${encodeURIComponent(id)}`,
    headers: headers(owner), firstChunk: staleBody.slice(0, 14),
  });
  await slow.reading;
  const ownerEdit = await request(app.server, "POST", `/console/api/knowledge/${encodeURIComponent(id)}`, {
    content: "เจ้าของแก้ล่าสุด", expectedKnowledgeHash: knowledgeExpectedHash(db.getKnowledge(id)),
  }, headers(owner));
  assert.equal(ownerEdit.status, 200);
  const stale = await slow.finish(staleBody.slice(14));
  assert.equal(stale.status, 409);
  assert.equal(stale.json.staleKnowledge, true);
  assert.equal(db.getKnowledge(id).content, "เจ้าของแก้ล่าสุด");
});

test("metadata write is CSRF-gated and list carries readiness without changing stored legacy rows", async (t) => {
  const { app, db } = await boot(t);
  const owner = await login(app.server, "ngoung");
  const blocked = await request(app.server, "POST", "/console/api/knowledge", { title: "แท็ก", content: "คำอธิบาย", knowledgeMetadata: metadata() }, { cookie: owner.cookie });
  assert.equal(blocked.status, 403);
  assert.equal(db.listKnowledge().length, 0);
  const listed = await request(app.server, "GET", "/console/api/knowledge", undefined, { cookie: owner.cookie });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.knowledgeMetadata.ready, true);
});

test("knowledge editor renders optional scope controls only when ready and preloads row scope", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/knowledge" });
  const { createKnowledgePage } = await import("../public/console/knowledge.mjs");
  const render = async (ready) => {
    const api = async (path) => {
      if (path.startsWith("/console/api/knowledge")) return {
        ok: true, knowledgeMetadata: { enabled: true, ready, message: "รอสมองรุ่นที่ใช้งานจริงก่อน จึงจะเลือกความรู้ตามเรื่องได้" },
        knowledge: [{ id: "k1", title: "แท็ก LINE", content: "ใช้จัดกลุ่ม", active: 1, channel_id: null, updated_at: 1,
          knowledgeMetadata: metadata() }],
      };
      if (path.startsWith("/console/api/brain")) return { ok: true, knowledge: {} };
      if (path.startsWith("/console/api/settings/brain")) return { ok: true, channels: [] };
      return { ok: true };
    };
    await createKnowledgePage({ api, toast: () => {}, mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
      pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {},
      state: { me: { capabilities: ["knowledge.publish"] } } })();
  };
  await render(true);
  assert.equal(doc.querySelectorAll(".kn-metadata-mode").length, 1, "new-entry form has the optional control");
  assert.doesNotMatch(textOf(doc.body), /ถูกส่งให้ AI อ่านก่อนตอบทุกครั้ง/u, "retrieval-ready UI must not claim every active item is sent every time");
  assert.match(textOf(doc.body), /ใช้เมื่อถามเรื่องนี้/u, "existing scope is visible for review");
  const edit = doc.querySelector(".btn-mini");
  edit.dispatch("click");
  const modes = doc.querySelectorAll(".kn-metadata-mode");
  const domains = doc.querySelectorAll(".kn-metadata-domain");
  assert.equal(modes.at(-1)?.value, "retrieve", "editing preloads existing scope");
  assert.equal(domains.at(-1)?.value, "การตลาด LINE");

  await render(false);
  assert.equal(doc.querySelectorAll(".kn-metadata-mode").length, 0, "unready runtime must not offer a control that cannot work");
  assert.match(textOf(doc.body), /รอสมองรุ่นที่ใช้งานจริง/u);
});

test("knowledge editor supplies the server token when converting a legacy row to retrieval", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/knowledge" });
  const { createKnowledgePage } = await import("../public/console/knowledge.mjs");
  let mutation = null;
  const api = async (path, options = {}) => {
    if (path === "/console/api/knowledge") return {
      ok: true, knowledgeMetadata: { enabled: true, ready: true, corpusCapChars: 80_000 },
      knowledge: [{ id: "legacy-1", title: "คู่มือเดิม", content: "เนื้อหาเดิม", active: 1, channel_id: null,
        updated_at: 1, knowledgeMetadata: null, expectedKnowledgeHash: "server-current-hash" }],
    };
    if (path === "/console/api/knowledge/legacy-1") {
      mutation = options.body;
      return { ok: true, entry: {} };
    }
    if (path.startsWith("/console/api/brain")) return { ok: true, knowledge: {} };
    if (path.startsWith("/console/api/settings/brain")) return { ok: true, channels: [] };
    return { ok: true };
  };
  await createKnowledgePage({ api, toast: () => {}, mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {},
    state: { me: { capabilities: ["knowledge.publish"] } } })();
  const card = doc.querySelector(".kn-card");
  card.querySelector(".btn-mini").dispatch("click");
  const modes = card.querySelectorAll(".kn-metadata-mode");
  const domains = card.querySelectorAll(".kn-metadata-domain");
  const offerings = card.querySelectorAll(".kn-metadata-offering");
  const keywords = card.querySelectorAll(".kn-metadata-keywords");
  modes.at(-1).value = "retrieve";
  domains.at(-1).value = "การตลาด LINE";
  offerings.at(-1).value = "LINE สำหรับมือใหม่";
  keywords.at(-1).value = "แท็ก";
  card.querySelector(".btn-primary").dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(mutation.expectedKnowledgeHash, "server-current-hash");
  assert.deepEqual(mutation.knowledgeMetadata, {
    mode: "retrieve", domain: "การตลาด LINE", offering: "LINE สำหรับมือใหม่", keywords: ["แท็ก"],
  });
});

test("การ์ดความรู้ที่ไม่มี metadata ไม่ส่ง null เข้า replaceChildren (เบราว์เซอร์จริงจะแสดงคำว่า null)", async (t) => {
  const { doc } = installBrowserGlobals(t, { hash: "#/knowledge" });
  const { createKnowledgePage } = await import("../public/console/knowledge.mjs");
  const api = async (path) => {
    if (path.startsWith("/console/api/knowledge")) return {
      ok: true, knowledgeMetadata: { enabled: false, ready: false },
      knowledge: [{ id: "k1", title: "โปรโมชัน", content: "ซื้อ 2 ลด 10", active: 1, channel_id: null, updated_at: 1, knowledgeMetadata: null }],
    };
    if (path.startsWith("/console/api/brain")) return { ok: true, knowledge: {} };
    if (path.startsWith("/console/api/settings/brain")) return { ok: true, channels: [] };
    return { ok: true };
  };
  await createKnowledgePage({ api, toast: () => {}, mount: (...nodes) => doc.body.replaceChildren(...nodes.filter(Boolean)),
    pageHeader: () => doc.createElement("header"), tabBar: () => doc.createElement("nav"), stopPolling: () => {}, setView: () => {},
    state: { me: { capabilities: ["knowledge.publish"] } } })();
  const card = doc.querySelectorAll(".kn-card")[0];
  assert.ok(card, "ต้องเห็นการ์ด");
  assert.ok(card.children.every((c) => c !== null && c !== undefined), "ห้ามมีลูกเป็น null");
});
