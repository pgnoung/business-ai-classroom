// tagFrameworkConvert.mjs — แผนแปลงป้ายทั้งฐานเข้ากรอบป้ายชุดเดียว (28 ก.ย. 2026)
//
// ใช้ร่วมกันระหว่าง tools/tag-framework-convert.mjs (แปลงจริงครั้งเดียว) กับ tools/tag-framework-dry-run.mjs
// ตรรกะต่อห้องคือตัวเดียวกับตอนระบบทำงาน: mergeFrameworkTags (scorer) + rfmTagsFromData (ออเดอร์ขยับ)
// ต่างกันแค่ว่าเครื่องมือทำทุกห้องทีเดียว รวมห้องที่ลูกค้าเงียบไปแล้ว (เป้าหมายหลักของบรอดแคสต์)
//
// ขอบเขตการเขียน (คำสั่ง 28 ก.ย.): ป้าย human ไม่ถูกแก้/ลบเด็ดขาด · เขียนทับเฉพาะป้าย ai (ยกเว้นป้ายระบบ
// เช่น ดีลร้อนค้าง/คลาสฟรี ที่คงไว้) · ป้าย rfm = ผลคำนวณของระบบชุดเดียวกับตอนออเดอร์ขยับ
// (ซื้อครั้งที่/ซื้อล่าสุด + ซื้อแล้ว: สินค้า + AOV)
// ข้อ 5 ของพี่ง้วง: ป้ายความสนใจ LINE OA เดิมในห้องที่ส่งถึง → เพิ่มเป็นค่า "สนใจ: <ชื่อคลาสปัจจุบัน>" ในชุด ai
// (เฉพาะค่าที่ AI ติดได้ ค่าของทีม เช่น ขั้น: รอโอน / ติดต่อ: งานรีวิว ไม่ถูกเขียนแทนคน — นับไว้ในรายงาน)
import {
  classifyHumanTag, cleanTagText, isBuyerMarker, lookupFrameworkTag, mergeFrameworkTags,
} from "./tagFramework.mjs";
import { PURCHASED_ORDER_STATUSES, bangkokMonthKey, summarizePurchases } from "./purchaseHistory.mjs";
import { rfmTagsFromData } from "./tags.mjs";

export const LEGACY_SOURCE_TAG = "ย้ายจาก LINE OA";
// ค่าที่ทีมพิมพ์เองในมิติเปิด (ของแจก/กิจกรรม/รุ่น) ออกรายงานเฉพาะที่ใช้ตั้งแต่ 3 ห้อง — ค่าที่ใช้ห้องเดียว
// อาจเป็นชื่อเฉพาะคน กรองที่ข้อมูลเลย (ไม่ใช่แค่ตอนพิมพ์ข้อความ) ทุกรูปแบบผลลัพธ์รวม --json จึงปลอดภัยเท่ากัน
export const RARE_TEAM_VALUE_BELOW = 3;
const BOUGHT = new Set(PURCHASED_ORDER_STATUSES);

function tableExists(sqlite, name) {
  return Boolean(sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * โหลดทุกห้อง (ยกเว้น canary) พร้อมป้ายทุกแหล่ง ออเดอร์ ระดับ AI ที่คนยืนยัน และ persona ล่าสุดของ scorer
 * อ่านอย่างเดียว — ใช้ได้ทั้งกับฐานที่เปิด readOnly และภายในธุรกรรมของการเขียนจริง
 */
export function loadConversionRooms(sqlite) {
  const rooms = new Map();
  for (const row of sqlite.prepare(
    "SELECT line_user_id AS id, channel_id AS channel, do_not_disturb AS dnd, marketing_consent AS consent FROM customers WHERE line_user_id NOT LIKE 'canary:%'",
  ).all()) {
    rooms.set(row.id, {
      id: row.id, channel: row.channel, dnd: Number(row.dnd) || 0, consent: Number(row.consent) || 0,
      ai: [], human: [], rfm: [], aiRows: [], rfmRows: [], orders: [], persona: "", aiLevel: null,
    });
  }
  for (const row of sqlite.prepare("SELECT customer_id AS id, tag, source, created_at FROM customer_tags ORDER BY created_at, tag").all()) {
    const room = rooms.get(row.id);
    if (!room || !Array.isArray(room[row.source])) continue;
    room[row.source].push(row.tag);
    if (row.source === "ai") room.aiRows.push({ tag: row.tag, created_at: row.created_at });
    if (row.source === "rfm") room.rfmRows.push({ tag: row.tag, created_at: row.created_at });
  }
  if (tableExists(sqlite, "orders")) {
    for (const row of sqlite.prepare("SELECT customer_id AS id, status, total, items_json, created_at FROM orders").all()) {
      rooms.get(row.id)?.orders.push({ status: row.status, total: row.total, items_json: row.items_json, created_at: row.created_at });
    }
  }
  if (tableExists(sqlite, "customer_facts")) {
    for (const row of sqlite.prepare("SELECT customer_id AS id, value, source FROM customer_facts WHERE fact_key = 'ai_level'").all()) {
      const room = rooms.get(row.id);
      if (room && Number.isInteger(Number(row.value))) room.aiLevel = { value: Number(row.value), source: row.source };
    }
  }
  if (tableExists(sqlite, "score_history")) {
    for (const row of sqlite.prepare(
      "SELECT customer_id AS id, payload_json AS payload FROM score_history WHERE rowid IN (SELECT MAX(rowid) FROM score_history GROUP BY customer_id)",
    ).all()) {
      const room = rooms.get(row.id);
      if (!room) continue;
      try {
        room.persona = String(JSON.parse(row.payload)?.persona_type || "");
      } catch {
        // payload พัง = ไม่รู้อาชีพจาก scorer — ไม่ใช่ความผิดพลาดของการแปลง
      }
    }
  }
  for (const room of rooms.values()) {
    room.legacy = room.human.includes(LEGACY_SOURCE_TAG) || room.ai.includes(LEGACY_SOURCE_TAG);
    room.facebook = room.channel === "facebook";
    // เงื่อนไขเดียวกับผู้รับบรอดแคสต์ (dbBroadcast) — Facebook ไม่มีบรอดแคสต์ · ห้องประวัติ userId คนละชุด
    room.reach = !room.facebook && room.dnd === 0 && room.consent >= 0 && !room.legacy;
    room.spam = [...room.human, ...room.ai].some((tag) => cleanTagText(tag).toLowerCase() === "null");
  }
  return rooms;
}

const aiSettable = (hit) => hit && !hit.archived && hit.dim.setBy === "ai" && hit.entry.setBy === "ai";

/** ป้ายความสนใจ/ขั้น LINE OA เดิมของทีม → ค่าในกรอบ (ข้อ 5) แยกค่าที่ AI ติดได้ออกจากค่าของทีม */
export function projectHumanTags(humanTags, framework) {
  const aiValues = new Set();
  const teamValues = new Set();
  for (const tag of humanTags) {
    for (const out of classifyHumanTag(tag, framework).to) {
      const hit = lookupFrameworkTag(out, framework);
      if (aiSettable(hit)) aiValues.add(hit.entry.tag);
      else if (hit) teamValues.add(hit.entry.tag);
    }
  }
  return { aiValues: [...aiValues], teamValues: [...teamValues] };
}

/**
 * แผนของห้องเดียว — ป้าย ai ชุดใหม่ + ป้าย rfm ชุดใหม่ (ยังไม่ตัดตัวที่ชนกับป้ายคน)
 * ป้าย ai ที่เป็นป้ายระบบ (ดีลร้อนค้าง/คลาสฟรี …) คงไว้ตามเดิม
 */
export function planRoomConversion(room, framework, { now = Date.now } = {}) {
  const keepAi = room.ai.filter((tag) => framework.systemTags.has(cleanTagText(tag)));
  const projected = room.reach ? projectHumanTags(room.human, framework) : { aiValues: [], teamValues: [] };
  const mergeWith = (extra) => mergeFrameworkTags({
    framework,
    previous: [...room.ai.filter((tag) => !framework.systemTags.has(cleanTagText(tag))), ...extra],
    next: [],
    humanTags: room.human,
    personaType: room.persona || "",
    facts: room.aiLevel ? { ai_level: room.aiLevel } : {},
  });
  const merged = mergeWith(projected.aiValues);
  // ค่าที่ได้เพิ่ม "เพราะ" ป้ายทีมเดิมจริง ๆ (ป้าย AI เดิมให้ค่าเดียวกันอยู่แล้ว = ไม่นับ)
  const withoutProjection = projected.aiValues.length ? mergeWith([]) : merged;
  projected.added = merged.filter((tag) => !withoutProjection.includes(tag));
  const ai = [...new Set([...keepAi, ...merged])];
  const rfm = rfmTagsFromData({ orders: room.orders, humanTags: room.human, purchase: framework.purchase, now });
  const bought = room.orders.filter((order) => BOUGHT.has(order.status));
  const purchase = framework.purchase
    ? summarizePurchases({ orderTimes: bought.map((order) => Number(order.created_at) || 0), humanTags: room.human, purchase: framework.purchase })
    : null;
  return { ai, rfm, projected, purchase };
}

const sameSet = (a, b) => a.length === b.length && a.every((tag) => b.includes(tag));

/** เทียบแผนกับของเดิม — ป้ายที่ชนกับป้ายคน (ชื่อเดียวกัน) ไม่ถูกเขียนซ้ำ (หนึ่งห้องมีป้ายชื่อเดียวได้ใบเดียว) */
export function diffRoomPlan(room, plan) {
  const human = new Set(room.human);
  const rfm = plan.rfm.filter((tag) => !human.has(tag));
  const ai = plan.ai.filter((tag) => !human.has(tag) && !rfm.includes(tag));
  return {
    ai, rfm,
    aiChanged: !sameSet(ai, room.ai),
    rfmChanged: !sameSet(rfm, room.rfm),
    aiRemoved: room.ai.filter((tag) => !ai.includes(tag)),
    aiAdded: ai.filter((tag) => !room.ai.includes(tag)),
    rfmRemoved: room.rfm.filter((tag) => !rfm.includes(tag)),
    rfmAdded: rfm.filter((tag) => !room.rfm.includes(tag)),
  };
}

/** แผนทั้งฐาน — คืนเฉพาะห้องที่ต้องเขียน (ห้องที่เหมือนเดิม = ไม่แตะ ทำให้รันซ้ำแล้วไม่มีอะไรเปลี่ยน) */
export function planConversion(rooms, framework, { now = Date.now } = {}) {
  const plans = new Map();
  const touched = [];
  for (const room of rooms.values()) {
    const plan = planRoomConversion(room, framework, { now });
    const diff = diffRoomPlan(room, plan);
    plans.set(room.id, { plan, diff });
    if (diff.aiChanged || diff.rfmChanged) touched.push(room.id);
  }
  return { plans, touched };
}

/* ------------------------------ รายงานยอดรวม ------------------------------ */

const bump = (obj, key, by = 1) => { obj[key] = (obj[key] || 0) + by; };
const pair = () => ({ all: 0, reach: 0 });
const add = (counter, room) => { counter.all += 1; if (room.reach) counter.reach += 1; };

function sourceStats(rooms, pick) {
  const tags = new Set();
  let rows = 0;
  const withAny = pair();
  for (const room of rooms.values()) {
    const list = pick(room);
    rows += list.length;
    for (const tag of list) tags.add(tag);
    if (list.length) add(withAny, room);
  }
  return { rows, distinct: tags.size, rooms: withAny.all, reachRooms: withAny.reach };
}

function dimensionCounts(rooms, framework, pick) {
  return framework.dimensions.map((dim) => {
    const perValue = new Map();
    const roomsWith = pair();
    for (const room of rooms.values()) {
      let has = false;
      for (const tag of pick(room)) {
        if (!cleanTagText(tag).startsWith(`${dim.key}:`)) continue;
        has = true;
        const counts = perValue.get(tag) || pair();
        add(counts, room);
        perValue.set(tag, counts);
      }
      if (has) add(roomsWith, room);
    }
    const teamTyped = dim.open && dim.setBy !== "system";
    const openValues = [...perValue].map(([tag, counts]) => ({ tag, ...counts }));
    const values = dim.open
      ? openValues.filter((v) => !teamTyped || v.all >= RARE_TEAM_VALUE_BELOW)
        .sort((a, b) => b.all - a.all || a.tag.localeCompare(b.tag, "th"))
      : dim.values.filter((value) => !value.archived).map((value) => ({ tag: value.tag, ...(perValue.get(value.tag) || pair()) }));
    // จำนวนค่าที่ถูกซ่อน (ไม่บอกว่าคืออะไร) — ให้รู้ว่ามีอยู่ โดยไม่เปิดเผยข้อความ
    const hiddenRare = teamTyped ? openValues.length - values.length : 0;
    return { key: dim.key, setBy: dim.setBy, open: dim.open, dynamic: dim.dynamic, rooms: roomsWith, values, hiddenRare };
  });
}

function purchaseReport(rooms, plans, framework) {
  const count = { "1": pair(), "2": pair(), "3+": pair() };
  const lastYear = {};
  const lastYearReach = {};
  const evidence = { historyOnly: pair(), ordersOnly: pair(), both: pair() };
  const ambiguous = {
    bothSources: pair(), absorbedOrders: pair(), adjacentMonth: pair(), countWithoutMonthAndOrders: pair(),
    noDate: pair(), monthsExceedCount: pair(), markerOnly: pair(), productTagsWithoutCount: pair(), productTagsWithoutCountHasCustomer: pair(),
  };
  const productKinds = new Set(["purchase"]);
  for (const room of rooms.values()) {
    const summary = plans.get(room.id)?.plan.purchase;
    if (!summary) continue;
    if (summary.count > 0) {
      add(count[summary.count >= 3 ? "3+" : String(summary.count)], room);
      const year = summary.lastMonth ? summary.lastMonth.slice(0, 4) : "ไม่รู้เดือน";
      bump(lastYear, year);
      if (room.reach) bump(lastYearReach, year);
      if (summary.historyCount > 0 && summary.orders > 0) add(evidence.both, room);
      else if (summary.historyCount > 0) add(evidence.historyOnly, room);
      else add(evidence.ordersOnly, room);
      for (const [flag, on] of Object.entries(summary.flags)) {
        if (flag === "absorbedOrders" ? on > 0 : on) add(ambiguous[flag], room);
      }
    } else if (room.human.some((tag) => productKinds.has(classifyHumanTag(tag, framework).kind))) {
      // ป้ายสินค้าที่เคยซื้อจาก LINE OA เดิม (AI Class, GEN AI Class room …) แต่ไม่มีป้ายนับครั้ง/เดือน/ออเดอร์
      add(ambiguous.productTagsWithoutCount, room);
      if (room.human.some((tag) => isBuyerMarker(tag, framework))) add(ambiguous.productTagsWithoutCountHasCustomer, room);
    }
  }
  return { count, lastYear, lastYearReach, evidence, ambiguous };
}

function legacyHumanReport(rooms, plans, framework) {
  const projectedAdded = {};
  const teamOnly = {};
  const kinds = {};
  for (const room of rooms.values()) {
    const entry = plans.get(room.id);
    if (room.reach && entry) {
      for (const tag of entry.plan.projected.added || []) if (entry.diff.ai.includes(tag) && !room.ai.includes(tag)) bump(projectedAdded, tag);
      for (const tag of entry.plan.projected.teamValues) if (!room.human.includes(tag)) bump(teamOnly, tag);
    }
    const seen = new Set();
    for (const tag of room.human) {
      const kind = classifyHumanTag(tag, framework).kind;
      if (seen.has(kind)) continue;
      seen.add(kind);
      const counter = kinds[kind] || pair();
      add(counter, room);
      kinds[kind] = counter;
    }
  }
  return { projectedAdded, teamOnly, kinds };
}

function segmentReport(rooms, plans, framework) {
  return framework.segments.map((segment) => {
    const hits = { reach: 0, facebook: 0 };
    for (const room of rooms.values()) {
      if (room.spam) continue;
      const entry = plans.get(room.id);
      const tags = [...room.human, ...(entry ? entry.diff.ai : room.ai), ...(entry ? entry.diff.rfm : room.rfm)];
      const has = (wanted) => tags.some((tag) => cleanTagText(tag) === cleanTagText(wanted));
      if (!segment.include.some(has)) continue;
      const excluded = segment.exclude.some((wanted) => (wanted === "@buyers"
        ? tags.some((tag) => isBuyerMarker(tag, framework)) : has(wanted)));
      if (excluded) continue;
      if (room.reach) hits.reach += 1;
      if (room.facebook) hits.facebook += 1;
    }
    return { id: segment.id, name: segment.name, ...hits };
  });
}

/** รายงานยอดรวมก่อน/หลัง — ไม่มีรหัสลูกค้า ชื่อ หรือข้อความแชท (ชื่อป้ายมาจากรายการของกรอบเท่านั้น) */
export function summarizeConversion(rooms, planned, framework) {
  const { plans, touched } = planned;
  const all = [...rooms.values()];
  const after = (room, source) => {
    const entry = plans.get(room.id);
    return entry ? entry.diff[source] : room[source];
  };
  let aiChanged = 0;
  let rfmChanged = 0;
  const reachTouched = pair();
  const oldRfmReplaced = {};
  for (const id of touched) {
    const { diff } = plans.get(id);
    const room = rooms.get(id);
    if (diff.aiChanged) aiChanged += 1;
    if (diff.rfmChanged) rfmChanged += 1;
    add(reachTouched, room);
    for (const tag of diff.rfmRemoved) bump(oldRfmReplaced, tag.startsWith("ซื้อแล้ว:") ? "ซื้อแล้ว: (สินค้าเดิม)" : tag);
  }
  return {
    frameworkId: framework.frameworkId,
    customers: {
      total: all.length,
      facebook: all.filter((room) => room.facebook).length,
      legacyHistory: all.filter((room) => room.legacy).length,
      reachableLine: all.filter((room) => room.reach).length,
      reachableNotSpam: all.filter((room) => room.reach && !room.spam).length,
    },
    sources: {
      before: {
        ai: sourceStats(rooms, (room) => room.ai), rfm: sourceStats(rooms, (room) => room.rfm), human: sourceStats(rooms, (room) => room.human),
      },
      after: {
        ai: sourceStats(rooms, (room) => after(room, "ai")), rfm: sourceStats(rooms, (room) => after(room, "rfm")),
        human: sourceStats(rooms, (room) => room.human),
      },
    },
    touched: { rooms: touched.length, reachRooms: reachTouched.reach, aiChanged, rfmChanged, oldRfmReplaced },
    dimensions: {
      before: dimensionCounts(rooms, framework, (room) => [...room.ai, ...room.rfm, ...room.human]),
      after: dimensionCounts(rooms, framework, (room) => [...after(room, "ai"), ...after(room, "rfm"), ...room.human]),
    },
    purchase: purchaseReport(rooms, plans, framework),
    legacyHuman: legacyHumanReport(rooms, plans, framework),
    segments: segmentReport(rooms, plans, framework),
  };
}

/** เดือนของออเดอร์ (ใช้ในเทสต์/รายงาน) — ส่งต่อจาก purchaseHistory ให้เครื่องมือไม่ต้อง import หลายที่ */
export { bangkokMonthKey };
