#!/usr/bin/env node
// tag-framework-dry-run.mjs — ซ้อมกรอบป้ายใหม่กับฐานจริง "แบบอ่านอย่างเดียว" (ร่าง 28 ก.ย. 2026)
// เครื่องมือวิเคราะห์ (ความครอบคลุมของกฎแปลง · ถ้าแก้ตัวจับระดับ AI) — การแปลงจริงทั้งฐานใช้ tools/tag-framework-convert.mjs
//
// ตอบคำถามเดียว: ถ้าเปิดกรอบป้ายชุดเดียวแล้วแปลงป้าย AI เก่าเข้ากรอบวันนี้ ตัวเลขแต่ละมิติจะเป็นเท่าไร
// และกลุ่มบรอดแคสต์ที่เสนอจะมีคนกี่คน (นับเฉพาะคนที่บรอดแคสต์ LINE ส่งถึงจริง)
//
// ความปลอดภัย:
// - เปิดฐานด้วย readOnly: true ตรง ๆ (ไม่ใช้ openDb ที่รัน SCHEMA/ALTER) — ไม่มีคำสั่งเขียนเลยสักบรรทัด
// - รายงานมีแต่ตัวเลขรวมกับข้อความป้าย ไม่มีรหัสลูกค้า ชื่อ หรือข้อความแชท
// - ป้ายหายาก (ใช้ไม่ถึง 3 ห้อง) ไม่พิมพ์ข้อความออกมาเว้นแต่สั่ง --show-rare
//
// วิธีใช้ (กับสำเนาฐาน ไม่ใช่ไฟล์ที่ระบบกำลังเขียน):
//   node tools/tag-framework-dry-run.mjs --db /tmp/x/chassis-copy.sqlite --framework /path/tag-framework.json
//   เพิ่ม --json เพื่อได้ผลเป็น JSON
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  classifyHumanTag, cleanTagText, isBuyerMarker, legacyCoverage, loadTagFramework, mergeFrameworkTags,
} from "../src/tagFramework.mjs";

const LEGACY_SOURCE_TAG = "ย้ายจาก LINE OA";
const RARE_BELOW = 3;
const DAY_MS = 86_400_000;

export function parseArgs(argv) {
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : null;
  };
  return {
    db: value("--db"),
    framework: value("--framework") ?? (process.env.TAG_FRAMEWORK_FILE || null),
    json: argv.includes("--json"),
    showRare: argv.includes("--show-rare"),
  };
}

const isSpam = (tag) => cleanTagText(tag).toLowerCase() === "null";

function loadRooms(sqlite) {
  const rooms = new Map();
  for (const row of sqlite.prepare(
    "SELECT line_user_id AS id, channel_id AS channel, do_not_disturb AS dnd, marketing_consent AS consent FROM customers WHERE line_user_id NOT LIKE 'canary:%'",
  ).all()) {
    rooms.set(row.id, { channel: row.channel, dnd: Number(row.dnd) || 0, consent: Number(row.consent) || 0, ai: [], human: [], rfm: [] });
  }
  return rooms;
}

function attachTags(sqlite, rooms) {
  for (const row of sqlite.prepare("SELECT customer_id AS id, tag, source FROM customer_tags").all()) {
    const list = rooms.get(row.id)?.[row.source];
    if (Array.isArray(list)) list.push(row.tag);
  }
  for (const room of rooms.values()) {
    room.legacy = room.human.includes(LEGACY_SOURCE_TAG) || room.ai.includes(LEGACY_SOURCE_TAG);
    room.facebook = room.channel === "facebook";
    // เงื่อนไขเดียวกับ broadcastAudienceWhere ใน dbBroadcast.mjs (Facebook ไม่มีบรอดแคสต์)
    room.reach = !room.facebook && room.dnd === 0 && room.consent >= 0 && !room.legacy;
    room.spam = [...room.human, ...room.ai].some(isSpam);
  }
}

function tableExists(sqlite, name) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

// ข้อความ seed ของคีย์เวิร์ด # (ระบบเขียน ไม่ใช่ลูกค้าพิมพ์) — ใช้เทียบในหน่วยความจำเท่านั้น ไม่พิมพ์ออก
function campaignSeeds(sqlite) {
  if (!tableExists(sqlite, "settings")) return new Set();
  try {
    const raw = sqlite.prepare("SELECT value FROM settings WHERE key = 'hashtag_business_keywords'").get()?.value;
    const parsed = raw ? JSON.parse(raw) : {};
    return new Set(Object.values(parsed || {})
      .map((entry) => cleanTagText(typeof entry === "string" ? entry : entry?.seed))
      .filter(Boolean));
  } catch {
    return new Set();
  }
}

function attachFactsAndPersona(sqlite, rooms) {
  if (tableExists(sqlite, "customer_facts")) {
    const seeds = campaignSeeds(sqlite);
    for (const row of sqlite.prepare("SELECT customer_id AS id, value, source, evidence FROM customer_facts WHERE fact_key = 'ai_level'").all()) {
      const level = Number(row.value);
      if (!rooms.has(row.id) || !Number.isInteger(level)) continue;
      rooms.get(row.id).aiLevel = { value: level, source: row.source, fromSeed: seeds.has(cleanTagText(row.evidence)) };
    }
  }
  if (tableExists(sqlite, "score_history")) {
    for (const row of sqlite.prepare("SELECT customer_id AS id, payload_json AS payload FROM score_history ORDER BY customer_id, created_at, rowid").iterate()) {
      const room = rooms.get(row.id);
      if (!room) continue;
      try {
        room.persona = String(JSON.parse(row.payload)?.persona_type || "");
      } catch {
        // payload พัง = ไม่รู้กลุ่มอาชีพ ไม่ใช่ความผิดพลาดของการซ้อม
      }
    }
  }
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

function summarizeBefore(sqlite, rooms, now) {
  const bySource = sqlite.prepare(
    "SELECT source, COUNT(*) AS rows_n, COUNT(DISTINCT tag) AS distinct_n, COUNT(DISTINCT customer_id) AS rooms_n FROM customer_tags GROUP BY source ORDER BY source",
  ).all().map((row) => ({ source: row.source, rows: row.rows_n, distinct: row.distinct_n, rooms: row.rooms_n }));
  const aiCounts = new Map();
  let aiRooms = 0;
  for (const room of rooms.values()) {
    if (room.ai.length) aiRooms += 1;
    for (const tag of room.ai) bump(aiCounts, tag);
  }
  const recentTags = new Set(sqlite.prepare("SELECT tag FROM customer_tags WHERE source = 'ai' AND created_at > ?")
    .all(now - 7 * DAY_MS).map((row) => row.tag));
  const rows = [...aiCounts].map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag, "th"));
  const singletons = rows.filter((row) => row.n === 1);
  return {
    bySource,
    ai: {
      rows: rows.reduce((sum, row) => sum + row.n, 0),
      distinct: rows.length,
      rooms: aiRooms,
      singletonDistinct: singletons.length,
      singletonRows: singletons.length,
      distinctLast7d: recentTags.size,
      top: rows.filter((row) => row.n >= RARE_BELOW).slice(0, 25),
    },
    aiRowsForCoverage: rows,
  };
}

// trustDeterministic = สมมติว่าตัวจับระดับจากคำตอบบันไดถูกแก้แล้ว (ตัดค่าที่มาจาก seed คีย์เวิร์ดออก)
function afterTagsFor(room, framework, { trustDeterministic = false } = {}) {
  const fact = room.aiLevel;
  const usable = fact && (!trustDeterministic || fact.source === "human" || !fact.fromSeed);
  return mergeFrameworkTags({
    framework,
    previous: room.ai,
    next: [],
    humanTags: room.human,
    personaType: room.persona || "",
    facts: usable ? { ai_level: fact } : {},
    ...(trustDeterministic ? { factSources: ["human", "deterministic"] } : {}),
  });
}

function summarizeAfter(rooms, framework, { key = "after", trustDeterministic = false } = {}) {
  const perTag = new Map();
  const roomsWithAny = { all: 0, reach: 0, facebook: 0 };
  let totalTags = 0;
  let fromFact = 0;
  let fromPersona = 0;
  for (const room of rooms.values()) {
    const tags = afterTagsFor(room, framework, { trustDeterministic });
    room[key] = tags;
    if (!tags.length) continue;
    totalTags += tags.length;
    roomsWithAny.all += 1;
    if (room.reach) roomsWithAny.reach += 1;
    if (room.facebook) roomsWithAny.facebook += 1;
    const levelDim = framework.dimensions.find((dim) => dim.factKey === "ai_level");
    const trusted = trustDeterministic ? ["human", "deterministic"] : levelDim?.factSources || [];
    const factUsed = room.aiLevel && trusted.includes(room.aiLevel.source) && !(trustDeterministic && room.aiLevel.fromSeed);
    if (factUsed && tags.some((tag) => tag.startsWith(`${levelDim.key}:`))) fromFact += 1;
    if (room.persona && framework.personaToTag.get(room.persona) && tags.includes(framework.personaToTag.get(room.persona))) fromPersona += 1;
    for (const tag of tags) {
      const counts = perTag.get(tag) || { all: 0, reach: 0, facebook: 0 };
      counts.all += 1;
      if (room.reach) counts.reach += 1;
      if (room.facebook) counts.facebook += 1;
      perTag.set(tag, counts);
    }
  }
  const dimensions = framework.dimensions
    .filter((dim) => dim.setBy === "ai" && !dim.open)
    .map((dim) => ({
      key: dim.key,
      values: dim.values.map((value) => ({ tag: value.tag, ...(perTag.get(value.tag) || { all: 0, reach: 0, facebook: 0 }) })),
    }));
  return {
    roomsWithAny,
    avgTagsPerRoom: roomsWithAny.all ? Math.round((totalTags / roomsWithAny.all) * 10) / 10 : 0,
    distinctTags: perTag.size,
    fromFact,
    fromPersona,
    dimensions,
  };
}

function summarizeHuman(rooms, framework) {
  const kinds = new Map();
  const unknown = new Map();
  const projected = new Map();
  const classified = new Map();
  for (const room of rooms.values()) {
    const projectedHere = new Set();
    for (const tag of room.human) {
      let info = classified.get(tag);
      if (!info) { info = classifyHumanTag(tag, framework); classified.set(tag, info); }
      const kind = kinds.get(info.kind) || { kind: info.kind, tags: new Set(), rows: 0, reachRooms: 0 };
      kind.tags.add(tag);
      kind.rows += 1;
      if (room.reach) kind.reachRooms += 1;
      kinds.set(info.kind, kind);
      if (info.kind === "unknown") {
        const row = unknown.get(tag) || { tag, n: 0, reach: 0 };
        row.n += 1;
        if (room.reach) row.reach += 1;
        unknown.set(tag, row);
      }
      for (const out of info.to) projectedHere.add(out);
    }
    room.projected = [...projectedHere];
    if (!room.reach) continue;
    for (const out of projectedHere) {
      if (room.after?.includes(out)) continue;
      bump(projected, out);
    }
  }
  return {
    kinds: [...kinds.values()]
      .map((kind) => ({ kind: kind.kind, distinct: kind.tags.size, rows: kind.rows, reachRooms: kind.reachRooms }))
      .sort((a, b) => b.rows - a.rows),
    unknown: [...unknown.values()].sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag, "th")),
    projectedReach: [...projected].map(([tag, n]) => ({ tag, addedReachRooms: n })).sort((a, b) => b.addedReachRooms - a.addedReachRooms),
  };
}

function segmentMatch(tags, segment, framework) {
  const has = (wanted) => tags.some((tag) => cleanTagText(tag) === cleanTagText(wanted));
  if (!segment.include.some(has)) return false;
  for (const excluded of segment.exclude) {
    if (excluded === "@buyers") {
      if (tags.some((tag) => isBuyerMarker(tag, framework))) return false;
    } else if (has(excluded)) {
      return false;
    }
  }
  return true;
}

function summarizeSegments(rooms, framework, { key = "after" } = {}) {
  return framework.segments.map((segment) => {
    let reachAi = 0;
    let reachWithHuman = 0;
    let facebookAi = 0;
    for (const room of rooms.values()) {
      if (room.spam) continue;
      const base = [...room[key], ...room.human, ...room.rfm];
      const aiMatch = segmentMatch(base, segment, framework);
      if (room.reach && aiMatch) reachAi += 1;
      if (room.facebook && aiMatch) facebookAi += 1;
      if (room.reach && segmentMatch([...base, ...room.projected], segment, framework)) reachWithHuman += 1;
    }
    return { id: segment.id, name: segment.name, use: segment.use, include: segment.include, exclude: segment.exclude, reachAi, reachWithHuman, facebookAi };
  });
}

/**
 * รวบรวมรายงานซ้อมทั้งหมดจากฐาน (อ่านอย่างเดียว) — คืนแต่ตัวเลขรวมและข้อความป้าย
 * @param {import("node:sqlite").DatabaseSync} sqlite
 */
export function collectTagDryRun(sqlite, framework, { now = Date.now(), showRare = false } = {}) {
  // ป้ายหายากอาจเป็นชื่อร้าน/แบรนด์ของลูกค้าคนเดียว — ตัดออกจากรายงาน (รวม --json) เว้นแต่สั่งเอง
  const visible = (rows) => rows.filter((row) => showRare || row.n >= RARE_BELOW);
  const rooms = loadRooms(sqlite);
  attachTags(sqlite, rooms);
  attachFactsAndPersona(sqlite, rooms);
  const before = summarizeBefore(sqlite, rooms, now);
  const coverage = legacyCoverage(before.aiRowsForCoverage, framework);
  const distinctDecided = before.aiRowsForCoverage.filter((row) => !coverage.unmapped.some((u) => u.tag === cleanTagText(row.tag))).length;
  const after = summarizeAfter(rooms, framework);
  const human = summarizeHuman(rooms, framework);
  const segments = summarizeSegments(rooms, framework);
  const fixed = summarizeAfter(rooms, framework, { key: "afterFixed", trustDeterministic: true });
  const fixedSegments = summarizeSegments(rooms, framework, { key: "afterFixed" });
  const levelDim = framework.dimensions.find((dim) => dim.factKey === "ai_level");
  const all = [...rooms.values()];
  return {
    frameworkId: framework.frameworkId,
    // ค่าที่ไฟล์กรอบติดธงว่ารอพี่ง้วงยืนยัน + จำนวนข้อเสนอแปลงป้าย LINE OA เดิมที่รอยืนยัน
    needsConfirmation: {
      values: framework.dimensions.flatMap((dim) => dim.values.filter((value) => value.confirm)
        .map((value) => ({ tag: value.tag, question: value.confirm }))),
      humanMappings: framework.humanRules.filter((rule) => rule.confirm).length,
    },
    customers: {
      total: all.length,
      facebook: all.filter((room) => room.facebook).length,
      legacyHistory: all.filter((room) => room.legacy).length,
      reachableLine: all.filter((room) => room.reach).length,
      reachableNotSpam: all.filter((room) => room.reach && !room.spam).length,
    },
    before: { bySource: before.bySource, ai: before.ai },
    coverage: {
      total: coverage.total,
      byDisposition: coverage.byDisposition,
      toFrameworkPct: coverage.toFrameworkPct,
      decidedPct: coverage.decidedPct,
      distinctDecidedPct: before.aiRowsForCoverage.length
        ? Math.round((distinctDecided / before.aiRowsForCoverage.length) * 1000) / 10 : 0,
      unmappedTotal: coverage.unmapped.length,
      unmapped: visible(coverage.unmapped),
    },
    after,
    human: { ...human, unknownTotal: human.unknown.length, unknown: visible(human.unknown) },
    segments,
    // ถ้าแก้ตัวจับระดับ AI แล้ว (ไม่นับค่าที่มาจาก seed คีย์เวิร์ด) และเปิดให้ค่าจากระบบชนะ
    ifLevelDetectorFixed: {
      seedDerivedLevelFacts: all.filter((room) => room.aiLevel?.fromSeed).length,
      seedDerivedReach: all.filter((room) => room.aiLevel?.fromSeed && room.reach).length,
      level: fixed.dimensions.find((dim) => dim.key === levelDim?.key)?.values || [],
      segments: fixedSegments.map((seg) => ({ id: seg.id, name: seg.name, reachAi: seg.reachAi })),
    },
  };
}

const pct = (part, whole) => (whole ? `${Math.round((part / whole) * 1000) / 10}%` : "0%");

export function renderTagDryRun(report, { showRare = false } = {}) {
  const lines = [];
  const c = report.customers;
  lines.push(`[tag-dry-run] กรอบ ${report.frameworkId || "(ไม่มีชื่อ)"} — อ่านอย่างเดียว ไม่เขียนอะไรลงฐาน`);
  const pending = report.needsConfirmation;
  if (pending?.values.length || pending?.humanMappings) {
    lines.push(`รอพี่ง้วงยืนยัน: ${pending.values.map((v) => `${v.tag} (${v.question})`).join(" · ") || "-"} · ข้อเสนอแปลงป้าย LINE OA เดิม ${pending.humanMappings} ข้อ`);
  }
  lines.push(`ห้องทั้งหมด ${c.total} · Facebook ${c.facebook} · ห้องประวัติจาก LINE OA เดิม ${c.legacyHistory} · บรอดแคสต์ LINE ส่งถึงจริง ${c.reachableLine} (ไม่นับสแปม ${c.reachableNotSpam})`);
  lines.push("", "ก่อน — ป้ายตามแหล่ง:");
  for (const row of report.before.bySource) lines.push(`  ${row.source}: ${row.rows} ป้าย · ${row.distinct} แบบ · ${row.rooms} ห้อง`);
  const ai = report.before.ai;
  lines.push(`  ป้าย AI: ${ai.distinct} แบบ (ใช้ครั้งเดียว ${ai.singletonDistinct} แบบ = ${pct(ai.singletonRows, ai.rows)} ของการติดป้าย) · 7 วันล่าสุดมีป้าย AI ${ai.distinctLast7d} แบบ`);
  lines.push(`  ป้าย AI ที่ใช้บ่อย: ${ai.top.slice(0, 15).map((row) => `${row.tag} (${row.n})`).join(" · ")}`);
  const cov = report.coverage;
  const d = cov.byDisposition;
  lines.push("", `แปลงป้าย AI เก่าเข้ากรอบ (ถ่วงตามจำนวนครั้งที่ใช้ ${cov.total} ครั้ง):`);
  lines.push(`  เข้ากรอบ ${cov.toFrameworkPct}% · ตัดสินแล้วทั้งหมด ${cov.decidedPct}% (ป้ายระบบคงเดิม ${d.system || 0} · ตัดทิ้งเพราะไม่มีข้อมูลแบ่งกลุ่ม ${d.dropped || 0} · กันข้อมูลอ่อนไหว ${d.blocked || 0} · ยังไม่มีกฎ ${d.unmapped || 0})`);
  const unmapped = cov.unmapped.filter((row) => showRare || row.n >= RARE_BELOW);
  if (unmapped.length) lines.push(`  ยังไม่มีกฎ (ใช้ ≥${RARE_BELOW} ครั้ง): ${unmapped.map((row) => `${row.tag} (${row.n})`).join(" · ")}`);
  const after = report.after;
  lines.push("", `หลังแปลง — ห้องที่มีป้ายในกรอบ ${after.roomsWithAny.all} (LINE ส่งถึง ${after.roomsWithAny.reach} · Facebook ${after.roomsWithAny.facebook}) · เฉลี่ย ${after.avgTagsPerRoom} ป้าย/ห้อง · รวม ${after.distinctTags} แบบ`);
  lines.push(`  ระดับAI มาจากคำตอบบันไดที่ระบบจับได้ ${after.fromFact} ห้อง · อาชีพมาจาก persona ของ scorer ${after.fromPersona} ห้อง`);
  for (const dim of after.dimensions) {
    lines.push(`  [${dim.key}] ${dim.values.map((v) => `${v.tag.slice(dim.key.length + 2)} ${v.all}/${v.reach}`).join(" · ")}  (ทั้งหมด/LINE ส่งถึง)`);
  }
  lines.push("", "ป้าย LINE OA เดิมที่ทีมติด (human) แยกตามชนิด:");
  for (const kind of report.human.kinds) lines.push(`  ${kind.kind}: ${kind.distinct} แบบ · ${kind.rows} ป้าย · อยู่ในห้องที่ LINE ส่งถึง ${kind.reachRooms}`);
  const unknown = report.human.unknown.filter((row) => showRare || row.n >= RARE_BELOW);
  if (unknown.length) lines.push(`  ยังไม่รู้ความหมาย: ${unknown.map((row) => `${row.tag} (${row.n}/${row.reach})`).join(" · ")}`);
  if (report.human.projectedReach.length) {
    lines.push(`  ถ้าอนุมัติย้ายป้ายเดิมเข้ากรอบ จะเพิ่มในห้องที่ส่งถึง: ${report.human.projectedReach.map((row) => `${row.tag} +${row.addedReachRooms}`).join(" · ")}`);
  }
  lines.push("", "กลุ่มบรอดแคสต์ที่เสนอ (นับคนที่ LINE ส่งถึงจริง ไม่รวมสแปม):");
  for (const seg of report.segments) {
    lines.push(`  ${seg.name}: ${seg.reachAi} คน (รวมป้ายเดิมที่รออนุมัติ ${seg.reachWithHuman}) · Facebook ที่ตรงกลุ่ม ${seg.facebookAi} (บรอดแคสต์ไม่ได้)`);
  }
  const fixed = report.ifLevelDetectorFixed;
  if (fixed) {
    lines.push("", `ถ้าแก้ตัวจับระดับ AI แล้วให้ค่าจากคำตอบบันไดชนะ (ตอนนี้มี ${fixed.seedDerivedLevelFacts} ห้องที่ระดับมาจาก seed คีย์เวิร์ด · ในนั้นส่งถึงได้ ${fixed.seedDerivedReach}):`);
    lines.push(`  [ระดับAI] ${fixed.level.map((v) => `${v.tag.replace(/^[^:]+: /u, "")} ${v.all}/${v.reach}`).join(" · ")}`);
    lines.push(`  กลุ่ม: ${fixed.segments.map((seg) => `${seg.name} ${seg.reachAi}`).join(" · ")}`);
  }
  return lines.join("\n");
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.db || !args.framework) {
    console.error("[tag-dry-run] ต้องระบุ --db <สำเนาฐาน> และ --framework <tag-framework.json>");
    process.exitCode = 1;
    return;
  }
  const framework = loadTagFramework(args.framework);
  const sqlite = new DatabaseSync(String(args.db), { readOnly: true });
  try {
    const report = collectTagDryRun(sqlite, framework, { showRare: args.showRare });
    console.log(args.json ? JSON.stringify(report, null, 1) : renderTagDryRun(report, { showRare: args.showRare }));
  } finally {
    sqlite.close();
  }
}

function isMainModule(metaUrl) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) main();

