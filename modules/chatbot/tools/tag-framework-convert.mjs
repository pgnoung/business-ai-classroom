#!/usr/bin/env node
// tag-framework-convert.mjs — แปลงป้ายทั้งฐานเข้ากรอบป้ายชุดเดียว ครั้งเดียว (พี่ง้วงอนุมัติกรอบ 28 ก.ย. 2026)
//
// ทำไมต้องมี: scorer แปลงป้ายเก่าของห้องที่ลูกค้าทักกลับมาเองอยู่แล้ว แต่ลีดที่เงียบไป (เป้าหมายหลักของบรอดแคสต์)
// จะไม่มีวันถูกแตะ — เครื่องมือนี้ทำทุกห้องทีเดียวด้วยตรรกะชุดเดียวกับตอนระบบทำงาน (src/tagFrameworkConvert.mjs)
//
// ความปลอดภัย:
// - ค่าตั้งต้น = ซ้อม: เปิดฐาน readOnly พิมพ์แต่ยอดรวม (ไม่มีรหัส/ชื่อ/ข้อความลูกค้า)
// - เขียนจริงต้องมีทั้ง --write, --confirm-rooms <จำนวนห้องจากการซ้อมล่าสุด> และ --backup <ไฟล์ใหม่>
//   แผนตอนเขียนต้องได้จำนวนห้องเท่าที่ยืนยันพอดี ไม่งั้นยกเลิกทั้งหมด (ฐานขยับระหว่างซ้อมกับเขียน)
// - ธุรกรรมเดียว (BEGIN IMMEDIATE) · ป้าย human ไม่ถูกแก้/ลบ (ทุกคำสั่งลบผูก source) · หลังเขียนวางแผนซ้ำในธุรกรรม
//   ต้องเหลือ 0 ห้อง (รันซ้ำไม่เปลี่ยนอะไร) ไม่งั้นย้อนทั้งหมด · บันทึก admin_audit หนึ่งแถว
// - ก่อนเขียนเก็บแถว ai/rfm เดิมของทุกห้องที่จะแตะลงไฟล์ backup (สิทธิ์ 0600 ห้ามทับไฟล์เดิม) · ถอยด้วย --restore
//
// วิธีใช้ (บนเซิร์ฟเวอร์ ในนามผู้ใช้ของแอป):
//   node tools/tag-framework-convert.mjs --db <chassis.sqlite> --framework <tag-framework.json>            # ซ้อม
//   node tools/tag-framework-convert.mjs --db … --framework … --write --confirm-rooms 1234 --backup /…/tag-convert-backup.json
//   node tools/tag-framework-convert.mjs --db … --restore /…/tag-convert-backup.json --confirm-rooms 1234
//   เพิ่ม --json เพื่อได้ผลซ้อมเป็น JSON
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { loadTagFramework } from "../src/tagFramework.mjs";
import { loadConversionRooms, planConversion, summarizeConversion } from "../src/tagFrameworkConvert.mjs";

export const BACKUP_KIND = "tag-framework-convert-backup";
const OPERATOR = "tag-framework-convert";

export function parseArgs(argv) {
  const value = (name) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[at + 1] : null;
  };
  const confirm = value("--confirm-rooms");
  return {
    db: value("--db"),
    framework: value("--framework") ?? (process.env.TAG_FRAMEWORK_FILE || null),
    json: argv.includes("--json"),
    write: argv.includes("--write"),
    restore: value("--restore"),
    backup: value("--backup"),
    confirmRooms: confirm !== null && /^\d+$/u.test(confirm) ? Number(confirm) : null,
  };
}

class ConvertError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.code = code;
  }
}

function columnExists(sqlite, table, column) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column);
}

/** ซ้อม — เปิดฐานแบบอ่านอย่างเดียวแล้วคืนรายงานยอดรวม */
export function dryRunConversion({ db, framework, now = Date.now }) {
  const sqlite = new DatabaseSync(String(db), { readOnly: true });
  try {
    const rooms = loadConversionRooms(sqlite);
    return summarizeConversion(rooms, planConversion(rooms, framework, { now }), framework);
  } finally {
    sqlite.close();
  }
}

function writeBackup(file, payload) {
  if (!file) throw new ConvertError("เขียนจริงต้องระบุ --backup <ไฟล์ใหม่> สำหรับเก็บแถวเดิมของทุกห้องที่จะแตะ");
  if (existsSync(file)) throw new ConvertError(`มีไฟล์ ${basename(file)} อยู่แล้ว — ห้ามเขียนทับ backup เดิม ใช้ชื่อใหม่`);
  if (!existsSync(dirname(file))) throw new ConvertError(`ไม่พบโฟลเดอร์ของไฟล์ backup (${dirname(file)})`);
  writeFileSync(file, `${JSON.stringify(payload)}\n`, { flag: "wx", mode: 0o600 });
}

function audit(sqlite, { action, target, detail, at }) {
  sqlite.prepare("INSERT INTO admin_audit (id, operator, action, target, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), OPERATOR, action, String(target || ""), String(detail || "").slice(0, 500), at);
}

function inTransaction(sqlite, fn) {
  sqlite.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    try { sqlite.exec("ROLLBACK"); } catch { /* ไม่มีธุรกรรมค้าง */ }
    throw error;
  }
}

function openWritable(db) {
  const sqlite = new DatabaseSync(String(db));
  sqlite.exec("PRAGMA busy_timeout = 10000");
  return sqlite;
}

/**
 * เขียนจริง — ทุกอย่างในธุรกรรมเดียว คืนรายงาน (ของแผนที่เขียน) + จำนวนห้อง
 * @returns {{ report: object, written: number, backup: string | null }}
 */
export function writeConversion({ db, framework, confirmRooms, backup, now = Date.now }) {
  if (!Number.isInteger(confirmRooms)) {
    throw new ConvertError("เขียนจริงต้องมี --confirm-rooms <จำนวนห้องที่การซ้อมล่าสุดบอก>");
  }
  const sqlite = openWritable(db);
  let backupWritten = false;
  try {
    return inTransaction(sqlite, () => {
      const at = now();
      const rooms = loadConversionRooms(sqlite);
      const planned = planConversion(rooms, framework, { now });
      const report = summarizeConversion(rooms, planned, framework);
      if (planned.touched.length !== confirmRooms) {
        throw new ConvertError(`แผนตอนนี้ต้องแตะ ${planned.touched.length} ห้อง ไม่ตรงกับที่ยืนยัน ${confirmRooms} — ฐานขยับหลังการซ้อม ให้ซ้อมใหม่แล้วยืนยันเลขล่าสุด (ยังไม่ได้เขียนอะไร)`, 3);
      }
      if (!planned.touched.length) return { report, written: 0, backup: null };
      const dirty = columnExists(sqlite, "customers", "tags_dirty_at");
      const backupRooms = {};
      for (const id of planned.touched) {
        const room = rooms.get(id);
        const row = dirty ? sqlite.prepare("SELECT tags_dirty_at FROM customers WHERE line_user_id = ?").get(id) : null;
        backupRooms[id] = { ai: room.aiRows, rfm: room.rfmRows, tags_dirty_at: row?.tags_dirty_at ?? null };
      }
      writeBackup(backup, {
        kind: BACKUP_KIND, version: 1, createdAt: new Date(at).toISOString(), db: basename(String(db)),
        frameworkId: framework.frameworkId, rooms: backupRooms,
      });
      backupWritten = true;
      // ทุกคำสั่งลบผูก source — ป้ายที่คนติด (human) ถูกลบจากเส้นนี้ไม่ได้โดยโครงสร้าง
      const remove = sqlite.prepare("DELETE FROM customer_tags WHERE customer_id = ? AND source = ? AND tag = ?");
      const insert = sqlite.prepare("INSERT OR IGNORE INTO customer_tags (customer_id, tag, source, created_at) VALUES (?, ?, ?, ?)");
      const markDirty = dirty ? sqlite.prepare("UPDATE customers SET tags_dirty_at = ? WHERE line_user_id = ?") : null;
      let removed = 0;
      let added = 0;
      for (const id of planned.touched) {
        const { diff } = planned.plans.get(id);
        for (const tag of diff.aiRemoved) removed += Number(remove.run(id, "ai", tag).changes);
        for (const tag of diff.rfmRemoved) removed += Number(remove.run(id, "rfm", tag).changes);
        for (const tag of diff.rfmAdded) added += Number(insert.run(id, tag, "rfm", at).changes);
        for (const tag of diff.aiAdded) added += Number(insert.run(id, tag, "ai", at).changes);
        markDirty?.run(at, id);
      }
      // รันซ้ำต้องไม่เหลืออะไรให้เปลี่ยน — ไม่งั้นแผนกับของที่เขียนไม่ตรงกัน ย้อนทั้งหมด
      const again = planConversion(loadConversionRooms(sqlite), framework, { now });
      if (again.touched.length) {
        throw new ConvertError(`ตรวจหลังเขียนไม่ผ่าน: ยังเหลือ ${again.touched.length} ห้องที่ไม่ตรงแผน — ย้อนทั้งหมดแล้ว`, 4);
      }
      audit(sqlite, {
        action: "tag_framework_convert", target: framework.frameworkId, at,
        detail: `rooms=${planned.touched.length} (LINE ส่งถึง ${report.touched.reachRooms}) · ai เปลี่ยน ${report.touched.aiChanged} ห้อง · `
          + `rfm เปลี่ยน ${report.touched.rfmChanged} ห้อง · แถวเพิ่ม ${added} ลบ ${removed} · backup=${basename(backup)}`,
      });
      return { report, written: planned.touched.length, backup };
    });
  } catch (error) {
    // ธุรกรรมย้อนแล้ว = ฐานเหมือนก่อนเริ่มทุกแถว ไฟล์ backup จึงไม่มีประโยชน์ และมีรหัสลูกค้าอยู่ — ลบทิ้ง
    // (รันใหม่ด้วยชื่อไฟล์เดิมได้เลย)
    if (backupWritten) {
      try { rmSync(backup, { force: true }); } catch { /* ลบไม่ได้ = ข้อความด้านล่างบอกให้ใช้ชื่อใหม่ */ }
    }
    throw error;
  } finally {
    sqlite.close();
  }
}

function readBackup(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new ConvertError(`อ่านไฟล์ backup ไม่ได้ (${error.message})`);
  }
  if (parsed?.kind !== BACKUP_KIND || parsed.version !== 1 || !parsed.rooms || typeof parsed.rooms !== "object") {
    throw new ConvertError("ไฟล์นี้ไม่ใช่ backup ของเครื่องมือแปลงป้าย");
  }
  return parsed;
}

/** ถอยกลับ — คืนป้าย ai/rfm ของทุกห้องใน backup เป็นชุดเดิม (ป้าย human ไม่แตะ) */
export function restoreConversion({ db, file, confirmRooms, now = Date.now }) {
  const backup = readBackup(file);
  const ids = Object.keys(backup.rooms);
  if (confirmRooms !== ids.length) {
    throw new ConvertError(`backup มี ${ids.length} ห้อง — ยืนยันด้วย --confirm-rooms ${ids.length}`, 3);
  }
  const sqlite = openWritable(db);
  try {
    return inTransaction(sqlite, () => {
      const at = now();
      const clear = sqlite.prepare("DELETE FROM customer_tags WHERE customer_id = ? AND source IN ('ai', 'rfm')");
      const insert = sqlite.prepare("INSERT OR IGNORE INTO customer_tags (customer_id, tag, source, created_at) VALUES (?, ?, ?, ?)");
      const markDirty = columnExists(sqlite, "customers", "tags_dirty_at")
        ? sqlite.prepare("UPDATE customers SET tags_dirty_at = ? WHERE line_user_id = ?") : null;
      for (const id of ids) {
        const room = backup.rooms[id];
        clear.run(id);
        for (const row of room.ai || []) insert.run(id, String(row.tag), "ai", Number(row.created_at) || at);
        for (const row of room.rfm || []) insert.run(id, String(row.tag), "rfm", Number(row.created_at) || at);
        markDirty?.run(at, id);
      }
      audit(sqlite, {
        action: "tag_framework_convert_restore", target: backup.frameworkId, at,
        detail: `คืนป้าย ai/rfm เดิม ${ids.length} ห้องจาก ${basename(file)} (สร้างเมื่อ ${backup.createdAt})`,
      });
      return { restored: ids.length };
    });
  } finally {
    sqlite.close();
  }
}

/* ------------------------------ รายงานภาษาไทย ------------------------------ */

const fmt = (counter) => `${counter.all}/${counter.reach}`;
const valueName = (tag, key) => tag.slice(key.length + 2);

export function renderConversion(report, { mode = "dry-run" } = {}) {
  const lines = [];
  const c = report.customers;
  lines.push(`[tag-framework-convert] กรอบ ${report.frameworkId} — ${mode === "dry-run" ? "ซ้อม (ไม่เขียนอะไรลงฐาน)" : "แผนที่เขียนแล้ว"}`);
  lines.push(`ห้องทั้งหมด ${c.total} · Facebook ${c.facebook} · ห้องประวัติ LINE OA เดิม ${c.legacyHistory} · LINE ส่งถึงจริง ${c.reachableLine} (ไม่นับสแปม ${c.reachableNotSpam})`);
  lines.push("", "ป้ายตามแหล่ง (ก่อน → หลัง):");
  for (const source of ["ai", "rfm", "human"]) {
    const b = report.sources.before[source];
    const a = report.sources.after[source];
    lines.push(`  ${source}: ${b.rows} → ${a.rows} ป้าย · ${b.distinct} → ${a.distinct} แบบ · ${b.rooms} → ${a.rooms} ห้อง (LINE ส่งถึง ${b.reachRooms} → ${a.reachRooms})${source === "human" ? " — ไม่แตะ" : ""}`);
  }
  const t = report.touched;
  lines.push("", `ห้องที่ต้องเขียน: ${t.rooms} (LINE ส่งถึง ${t.reachRooms}) · ป้าย AI เปลี่ยน ${t.aiChanged} ห้อง · ป้ายระบบ (rfm) เปลี่ยน ${t.rfmChanged} ห้อง`);
  const replaced = Object.entries(t.oldRfmReplaced);
  if (replaced.length) lines.push(`  ป้าย rfm แบบเดิมที่ถูกแทน: ${replaced.map(([tag, n]) => `${tag} ${n}`).join(" · ")}`);
  if (mode === "dry-run" && t.rooms) {
    lines.push(`  เขียนจริง: --write --confirm-rooms ${t.rooms} --backup <ไฟล์ใหม่ในโฟลเดอร์ที่มีสิทธิ์ 0700>`);
  }
  lines.push("", "แต่ละมิติหลังแปลง (ห้องทั้งหมด/LINE ส่งถึง · ก่อน → หลัง):");
  const before = new Map(report.dimensions.before.map((dim) => [dim.key, dim]));
  for (const dim of report.dimensions.after) {
    const prior = before.get(dim.key);
    // ค่าที่ทีมพิมพ์เองที่ใช้ไม่ถึง 3 ห้องถูกกรองตั้งแต่ข้อมูล (summarizeConversion) — ที่นี่บอกแค่จำนวน
    const shown = dim.values.filter((v) => v.all > 0);
    const values = shown.map((v) => `${valueName(v.tag, dim.key)} ${fmt(v)}`).join(" · ") || "-";
    const hidden = dim.hiddenRare ? ` · ค่าที่ใช้ไม่ถึง 3 ห้องอีก ${dim.hiddenRare} ค่า (ไม่แสดง)` : "";
    lines.push(`  [${dim.key}]${dim.dynamic ? " (dynamic)" : ""} ห้อง ${fmt(prior.rooms)} → ${fmt(dim.rooms)} · ${values}${hidden}`);
  }
  const p = report.purchase;
  lines.push("", `ซื้อครั้งที่ (ทั้งหมด/ส่งถึง): 1 = ${fmt(p.count["1"])} · 2 = ${fmt(p.count["2"])} · 3+ = ${fmt(p.count["3+"])}`);
  const years = Object.keys(p.lastYear).sort();
  lines.push(`ซื้อล่าสุด ตามปี (ทั้งหมด/ส่งถึง): ${years.map((y) => `${y} ${p.lastYear[y]}/${p.lastYearReach[y] || 0}`).join(" · ") || "-"}`);
  lines.push(`หลักฐาน: ป้าย LINE OA เดิมอย่างเดียว ${fmt(p.evidence.historyOnly)} · ออเดอร์อย่างเดียว ${fmt(p.evidence.ordersOnly)} · ทั้งสองแหล่ง ${fmt(p.evidence.both)}`);
  const a = p.ambiguous;
  lines.push("กรณีกำกวม (ห้อง ทั้งหมด/ส่งถึง):");
  lines.push(`  มีทั้งป้ายเดิมและออเดอร์ ${fmt(a.bothSources)} · ในนั้นออเดอร์ถูกนับรวมในป้ายเดิม (เดือนเดียวกัน/ก่อน) ${fmt(a.absorbedOrders)} · ออเดอร์เดือนถัดจากป้ายเดือนพอดี (อาจเป็นครั้งเดียวกันที่ลงระบบช้า — นับแยก) ${fmt(a.adjacentMonth)}`);
  lines.push(`  มีแต่ป้ายนับครั้ง ไม่รู้เดือน (ไม่ติด ซื้อล่าสุด) ${fmt(a.noDate)} · ป้ายนับครั้ง+ออเดอร์แต่ไม่มีป้ายเดือน (อาจนับซ้ำ) ${fmt(a.countWithoutMonthAndOrders)} · ป้ายเดือนมากกว่าเลขครั้ง ${fmt(a.monthsExceedCount)}`);
  lines.push(`  มีป้ายคลาสที่เคยซื้อ (AI Class, GEN AI Class room …) แต่ไม่มีป้ายนับครั้ง/เดือน/ออเดอร์ = ไม่ติด ซื้อครั้งที่ ${fmt(a.productTagsWithoutCount)} (ในนั้นมี customer ${fmt(a.productTagsWithoutCountHasCustomer)})`);
  lines.push(`  มีแต่ป้ายคลาสที่ซื้อ/customer ไม่มีเลขครั้ง/เดือน/ออเดอร์ = นับเป็น ซื้อครั้งที่: 1 (ไม่ติด ซื้อล่าสุด) ${fmt(a.markerOnly)}`);
  const h = report.legacyHuman;
  const projected = Object.entries(h.projectedAdded);
  lines.push("", `ป้ายความสนใจ LINE OA เดิม → ชื่อคลาสปัจจุบัน (ห้องที่ส่งถึง ค่าที่เพิ่มขึ้นจริง): ${projected.map(([tag, n]) => `${tag} +${n}`).join(" · ") || "-"}`);
  const teamOnly = Object.entries(h.teamOnly);
  if (teamOnly.length) lines.push(`  ไม่เขียนแทนคน (เป็นค่าของทีม ป้ายเดิมยังใช้ได้): ${teamOnly.map(([tag, n]) => `${tag} ${n} ห้อง`).join(" · ")}`);
  const kinds = Object.entries(h.kinds).sort((x, y) => y[1].all - x[1].all);
  lines.push(`ป้ายทีมเดิมแยกชนิด (ห้อง ทั้งหมด/ส่งถึง — ไม่แตะ): ${kinds.map(([kind, counter]) => `${kind} ${fmt(counter)}`).join(" · ")}`);
  lines.push("", "กลุ่มบรอดแคสต์ตัวอย่าง (LINE ส่งถึง ไม่รวมสแปม · Facebook ที่ตรงกลุ่มแต่บรอดแคสต์ไม่ได้):");
  for (const seg of report.segments) lines.push(`  ${seg.name}: ${seg.reach} คน · Facebook ${seg.facebook}`);
  return lines.join("\n");
}

function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.db) throw new ConvertError("ต้องระบุ --db <ไฟล์ฐาน>");
  if (args.restore) {
    const result = restoreConversion({ db: args.db, file: args.restore, confirmRooms: args.confirmRooms });
    console.log(`[tag-framework-convert] คืนป้าย ai/rfm เดิมแล้ว ${result.restored} ห้อง (ป้ายที่คนติดไม่แตะ) · บันทึก admin_audit แล้ว`);
    return;
  }
  if (!args.framework) throw new ConvertError("ต้องระบุ --framework <tag-framework.json> (หรือ TAG_FRAMEWORK_FILE)");
  const framework = loadTagFramework(args.framework);
  if (!args.write) {
    const report = dryRunConversion({ db: args.db, framework });
    console.log(args.json ? JSON.stringify(report, null, 1) : renderConversion(report));
    return;
  }
  const result = writeConversion({ db: args.db, framework, confirmRooms: args.confirmRooms, backup: args.backup });
  if (!result.written) {
    console.log("[tag-framework-convert] ไม่มีอะไรต้องเปลี่ยน (แปลงครบแล้ว) — ไม่ได้เขียนอะไร");
    return;
  }
  console.log(renderConversion(result.report, { mode: "write" }));
  console.log(`\nเขียนแล้ว ${result.written} ห้องในธุรกรรมเดียว · backup: ${result.backup} · บันทึก admin_audit แล้ว`);
}

function isMainModule(metaUrl) {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(metaUrl);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  try {
    run();
  } catch (error) {
    console.error(`[tag-framework-convert] ${error.message}`);
    process.exitCode = error instanceof ConvertError ? error.code : 1;
  }
}
