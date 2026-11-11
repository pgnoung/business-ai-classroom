// broadcastState.mjs — ตัวช่วยแบบ pure ของหน้าบรอดแคสต์ (แยกจาก broadcast.mjs 28 ก.ย. 2026 กัน import วน)
// broadcast.mjs export ต่อให้ผู้เรียกเดิม (เทสต์ console-ui-state / broadcast-schedule) ไม่ต้องเปลี่ยน
export function createBroadcastSegmentStore() {
  const byChannel = new Map();
  const current = (channelId) => {
    const key = String(channelId || "default");
    if (!byChannel.has(key)) byChannel.set(key, { include: new Set(), exclude: new Set() });
    return byChannel.get(key);
  };
  return {
    current,
    toggle(channelId, side, tag) {
      const segment = current(channelId);
      const selected = side === "exclude" ? segment.exclude : segment.include;
      const other = side === "exclude" ? segment.include : segment.exclude;
      if (selected.has(tag)) selected.delete(tag);
      else {
        selected.add(tag);
        other.delete(tag);
      }
      return segment;
    },
    sanitize(channelId, allowedTags) {
      const allowed = new Set(allowedTags);
      const segment = current(channelId);
      for (const tag of segment.include) if (!allowed.has(tag)) segment.include.delete(tag);
      for (const tag of segment.exclude) if (!allowed.has(tag)) segment.exclude.delete(tag);
      return segment;
    },
    clear(channelId) {
      const segment = current(channelId);
      segment.include.clear();
      segment.exclude.clear();
      return segment;
    },
    replace(channelId, { includeTags = [], excludeTags = [] } = {}) {
      const segment = current(channelId);
      segment.include = new Set(includeTags.map(String).filter(Boolean));
      segment.exclude = new Set(excludeTags.map(String).filter(Boolean));
      for (const tag of segment.include) segment.exclude.delete(tag);
      return segment;
    },
    snapshot(channelId) {
      const segment = current(channelId);
      return {
        channelId: String(channelId || "default"),
        includeTags: [...segment.include],
        excludeTags: [...segment.exclude],
      };
    },
  };
}

export function broadcastSkippedCount(broadcast) {
  if (!broadcast || broadcast.status === "sending") return 0;
  return Math.max(0,
    Number(broadcast.audience_count || 0) -
    Number(broadcast.sent_count || 0) -
    Number(broadcast.failed_count || 0));
}

export function broadcastCanSend({ allowed = true, includeCount = 0, messageCount = 0, preview = {}, sending = false } = {}) {
  return allowed && !sending && includeCount > 0 && messageCount > 0 && preview.loading !== true &&
    preview.overAudienceCap !== true && Number(preview.count || 0) > 0 && preview.segmentKey === preview.currentSegmentKey &&
    Number(preview.messageCount || 0) === Number(messageCount) && preview.quota?.type !== "unknown" &&
    typeof preview.audienceConfirmation === "string";
}

export function formatBangkokDatetimeLocal(ms) {
  const date = new Date(Number(ms) + 7 * 60 * 60_000);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}`;
}

export function parseBangkokDatetimeLocal(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const [, year, month, day, hour, minute] = match.map(Number);
  const result = Date.UTC(year, month - 1, day, hour - 7, minute, 0, 0);
  return formatBangkokDatetimeLocal(result) === value ? result : null;
}

export function quarantineResolutionConfirmationText(id, resolution) {
  return `RESOLVE:${String(id || "")}:${String(resolution || "")}`;
}

export function broadcastScheduleUiMode({ canSend = false, schedulingEnabled = false } = {}) {
  return {
    visible: canSend === true,
    canCreate: canSend === true && schedulingEnabled === true,
  };
}


// replaceChildren() ของเบราว์เซอร์แปลง null เป็นข้อความ "null" (ต่างจาก el() ที่กรองให้) — ใช้ตัวนี้แทนทุกที่ในหน้าบรอดแคสต์
export function put(node, ...kids) {
  node.replaceChildren(...kids.flat(Infinity).filter((kid) => kid !== null && kid !== undefined && kid !== false));
  return node;
}
