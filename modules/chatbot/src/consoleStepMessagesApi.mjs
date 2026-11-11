// consoleStepMessagesApi.mjs — เส้นทาง /console/api/broadcast/steps/* (28 ก.ย. 2026)
// เรียกจาก consoleBroadcastApi.mjs (route[1] === "steps") หลังตรวจ session + สิทธิ์ OA แล้วเท่านั้น
// กติกา: ดูได้ทุกคนที่เข้าหน้าบรอดแคสต์ได้ · สร้าง/แก้/เปิด/พัก/ปิด ต้องมี broadcast.send + CSRF + audit
// เปิดใช้ = preview (สรุปทริกเกอร์ ขั้น ประมาณโควตาต่อเดือน) → ใบยืนยัน HMAC 45 วิ ผูก version → พิมพ์ "เปิดใช้"
// ไม่มี id ลูกค้าในคำตอบ (สถิติเป็นตัวเลขรวมต่อขั้นเท่านั้น)
import { quotaPayload } from "./consoleBroadcastApi.mjs";
import { makeStudioConfirmation, studioConfirmationMatches, studioHash, STUDIO_CONFIRM_TTL_MS } from "./broadcastStudio.mjs";
import {
  DEFER_REASON_LABELS, STEP_LIMITS, STEP_MESSAGES_MODE_KEY, STOP_REASON_LABELS, stepMessagesMode, validateStepSequenceInput,
} from "./stepMessages.mjs";
import { jstDateKey } from "./lineInsight.mjs";
import { hasOperatorCapability } from "./operatorRoles.mjs";
import { FACEBOOK_CHANNEL_ID } from "./channels.mjs";

const DAY_MS = 86_400_000;
const CONFIRM_WORD = "เปิดใช้";
export const TRIGGER_LABELS = Object.freeze({
  follow: "เพิ่มเพื่อนใหม่", keyword: "ลูกค้าพิมพ์ #คีย์เวิร์ด", tag: "ติดป้าย", order_paid: "ออเดอร์ชำระแล้ว",
});

function triggerText(sequence) {
  if (sequence.trigger_type === "keyword") return `ลูกค้าพิมพ์ #${sequence.trigger_value}`;
  if (sequence.trigger_type === "tag") return `ติดป้าย ${String(sequence.trigger_value).replace(/\s*:\s*\*$/u, ": ทุกค่า")}`;
  return TRIGGER_LABELS[sequence.trigger_type] || sequence.trigger_type;
}

// ถ้อยคำเดียวกับหน้าคอนโซล (stepEditor.mjs delayLabel) — หน้ายืนยันกับตัวแก้ต้องพูดเหมือนกัน
export function delayText(delay, index) {
  const from = index === 0 ? "เข้าลำดับ" : "ขั้นก่อนหน้า";
  if (delay?.kind === "days") return `${delay.days} วันหลัง${from} · ${delay.at} น.`;
  return `${delay?.hours || 1} ชม. หลัง${from}`;
}

function tagPrefix(value) {
  const match = /^(.+?)\s*:\s*\*$/u.exec(String(value || "").trim());
  return match ? `${match[1].trim()}:` : "";
}

export function createStepMessageRoutes({
  db, config, engine, stepMessages, studio = null, channelLabel = (id) => String(id || "default"),
  catalogEntries = () => [], lineRegistry = null, logger = console, now = Date.now,
}) {
  const catalogByKey = () => new Map(catalogEntries().map((entry) => [entry.key, entry]));

  function publicSequence(sequence, { withStats = false } = {}) {
    const stats = db.stepSequenceStats(sequence);
    return {
      id: sequence.id,
      channelId: sequence.channel_id,
      channelName: channelLabel(sequence.channel_id),
      name: sequence.name,
      triggerType: sequence.trigger_type,
      triggerValue: sequence.trigger_value,
      triggerText: triggerText(sequence),
      stopOnReply: sequence.stop_on_reply,
      status: sequence.status,
      version: sequence.version,
      steps: sequence.steps.map((step, index) => ({ ...step, delayText: delayText(step.delay, index) })),
      activatedAt: sequence.activated_at ?? null,
      triggerSince: sequence.trigger_since ?? null,
      pausedBy: sequence.paused_by || "",
      createdBy: sequence.created_by,
      updatedAt: sequence.updated_at,
      totals: { active: stats.active, completed: stats.completed, stopped: stats.stopped, baseline: stats.baseline },
      ...(withStats ? { stepStats: stats.steps } : {}),
    };
  }

  async function monthlyEstimate(sequence) {
    const since = now() - 30 * DAY_MS;
    let enrollments = db.stepMonthlyEnrollmentEstimate({
      triggerType: sequence.trigger_type, triggerValue: sequence.trigger_value, prefix: tagPrefix(sequence.trigger_value),
      channelId: sequence.channel_id, since,
    });
    let basis = sequence.trigger_type === "follow" ? "เพื่อนใหม่ที่ระบบเห็นใน 30 วัน"
      : sequence.trigger_type === "keyword" ? "คนที่พิมพ์คีย์เวิร์ดนี้ใน 30 วัน"
        : sequence.trigger_type === "tag" ? "คนที่ได้ป้ายนี้ใน 30 วัน (สูงสุดโดยประมาณ)"
          : "ลูกค้าที่ชำระออเดอร์ใน 30 วัน";
    if (sequence.trigger_type === "follow" && studio && lineRegistry) {
      try {
        const current = await studio.followersSnapshot(sequence.channel_id);
        const past = await lineRegistry.forChannel(sequence.channel_id)?.getFollowersInsight?.({ date: jstDateKey(now() - 31 * DAY_MS) });
        if (current?.followers !== null && current?.followers !== undefined && past?.ok && past.status === "ready" && Number.isSafeInteger(past.followers)) {
          const delta = Math.max(0, Number(current.followers) - past.followers);
          if (delta > enrollments) {
            enrollments = delta;
            basis = "เพื่อนใหม่ 30 วันจากสถิติ LINE";
          }
        }
      } catch (error) {
        logger.debug?.(`steps: อ่านสถิติเพื่อนไม่สำเร็จ (${error?.message || error})`);
      }
    }
    const perEnrollment = sequence.steps.length;
    return { enrollmentsPerMonth: enrollments, messagesPerMonth: enrollments * perEnrollment, basis };
  }

  function baselineIds(sequence) {
    if (sequence.trigger_type === "tag") {
      return db.stepTagHolders({ channelId: sequence.channel_id, tag: sequence.trigger_value, prefix: tagPrefix(sequence.trigger_value) });
    }
    if (sequence.trigger_type === "order_paid") return db.stepPaidOrderHolders({ channelId: sequence.channel_id });
    return [];
  }

  function confirmationFields(sequence, sessionId) {
    return {
      sessionId, channelId: sequence.channel_id, mode: "step_activation",
      targetHash: studioHash({ id: sequence.id, version: sequence.version, trigger: [sequence.trigger_type, sequence.trigger_value], stopOnReply: sequence.stop_on_reply }),
      messagesHash: studioHash(sequence.steps), estimate: null, scheduledAt: null, fingerprint: sequence.id,
    };
  }

  function loadOwned(route, channelIds, json, res) {
    const sequence = db.getStepSequence(route[2]);
    if (!sequence) {
      json(res, 404, { ok: false, error: "ไม่พบลำดับข้อความนี้" });
      return null;
    }
    if (!channelIds.includes(sequence.channel_id)) {
      json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
      return null;
    }
    return sequence;
  }

  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "broadcast" || route[1] !== "steps") return false;
    const { readJson, json, username, sessionId, operator, requireCsrf, channelIds } = ctx;
    const canEdit = hasOperatorCapability(operator, "broadcast.send");

    if (req.method === "GET" && route.length === 2) {
      const requested = url.searchParams.get("channel") || channelIds[0];
      if (!channelIds.includes(requested)) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
        return true;
      }
      json(res, 200, {
        ok: true,
        mode: stepMessagesMode(db),
        modeKey: STEP_MESSAGES_MODE_KEY,
        canEdit,
        canToggleMode: String(operator?.role || "") === "owner",
        engineArmed: stepMessages?.armed?.() === true,
        limits: STEP_LIMITS,
        stopReasonLabels: STOP_REASON_LABELS,
        deferReasonLabels: DEFER_REASON_LABELS,
        triggerLabels: TRIGGER_LABELS,
        sequences: db.listStepSequences({ channel: requested }).map((sequence) => publicSequence(sequence)),
      });
      return true;
    }

    if (req.method === "GET" && route.length === 3) {
      const sequence = loadOwned(route, channelIds, json, res);
      if (!sequence) return true;
      json(res, 200, { ok: true, sequence: publicSequence(sequence, { withStats: true }) });
      return true;
    }

    if (req.method !== "POST") return false;
    if (!requireCsrf()) {
      json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" });
      return true;
    }
    if (!canEdit) {
      json(res, 403, { ok: false, error: "บัญชีนี้ดูลำดับข้อความได้ แต่สร้าง/แก้/เปิดใช้ไม่ได้" });
      return true;
    }

    /* ---- POST steps — สร้างร่าง ---- */
    if (route.length === 2) {
      const body = await readJson(req);
      if (!channelIds.includes(String(body.channelId || "default"))) {
        json(res, 403, { ok: false, error: "ไม่มีสิทธิ์ Broadcast ของ LINE OA นี้" });
        return true;
      }
      // รีวิวโค้ด 28 ก.ย.: ช่อง Facebook ส่ง push แบบ LINE ไม่ได้ — ลำดับจะเลื่อนไปเรื่อย ๆ โดยไม่มีใครรู้ จึงไม่รับตั้งแต่สร้าง
      if (String(body.channelId || "default") === FACEBOOK_CHANNEL_ID) {
        json(res, 400, { ok: false, error: "ข้อความตามขั้นใช้ได้กับ LINE OA เท่านั้น (Facebook ส่งข้อความแบบนี้ไม่ได้)" });
        return true;
      }
      const validated = validateStepSequenceInput(body, { imageCatalogByKey: catalogByKey(), guardCheck: stepMessages.guardCheck });
      if (validated.error) {
        json(res, 400, { ok: false, error: validated.error });
        return true;
      }
      const sequence = db.createStepSequence({ ...validated.sequence, createdBy: username });
      db.addAudit({ operator: username, action: "step_sequence_created", target: sequence.channel_id, detail: `sequence=${sequence.id}; trigger=${sequence.trigger_type}; steps=${sequence.steps.length}` });
      json(res, 201, { ok: true, sequence: publicSequence(sequence) });
      return true;
    }

    const sequence = loadOwned(route, channelIds, json, res);
    if (!sequence) return true;

    /* ---- POST steps/:id — แก้ (ร่าง/พักเท่านั้น) ---- */
    if (route.length === 3) {
      if (!["draft", "paused"].includes(sequence.status)) {
        json(res, 409, { ok: false, error: "ลำดับที่กำลังทำงานแก้ไม่ได้ — กดพักก่อน (คนที่อยู่ในลำดับจะรอ ไม่หลุด)" });
        return true;
      }
      const body = await readJson(req);
      const validated = validateStepSequenceInput({ ...body, channelId: sequence.channel_id }, { imageCatalogByKey: catalogByKey(), guardCheck: stepMessages.guardCheck });
      if (validated.error) {
        json(res, 400, { ok: false, error: validated.error });
        return true;
      }
      const updated = db.updateStepSequence(sequence.id, validated.sequence);
      if (!updated) {
        json(res, 409, { ok: false, error: "สถานะลำดับเปลี่ยนระหว่างบันทึก — โหลดใหม่ก่อน" });
        return true;
      }
      db.addAudit({ operator: username, action: "step_sequence_updated", target: sequence.channel_id, detail: `sequence=${sequence.id}; version=${updated.version}` });
      json(res, 200, { ok: true, sequence: publicSequence(updated) });
      return true;
    }

    const action = route[3];

    /* ---- POST steps/:id/preview — หน้ายืนยันเปิดใช้ ---- */
    if (action === "preview" && route.length === 4) {
      if (sequence.channel_id === FACEBOOK_CHANNEL_ID) {
        json(res, 400, { ok: false, error: "ข้อความตามขั้นใช้ได้กับ LINE OA เท่านั้น" });
        return true;
      }
      if (!["draft", "paused"].includes(sequence.status)) {
        json(res, 409, { ok: false, error: "ลำดับนี้ไม่ได้อยู่ในสถานะที่เปิดใช้ได้" });
        return true;
      }
      const recheck = validateStepSequenceInput({
        name: sequence.name, triggerType: sequence.trigger_type, triggerValue: sequence.trigger_value,
        stopOnReply: sequence.stop_on_reply, channelId: sequence.channel_id,
        steps: sequence.steps,
      }, { imageCatalogByKey: catalogByKey(), guardCheck: stepMessages.guardCheck });
      if (recheck.error) {
        json(res, 400, { ok: false, error: `ตรวจข้อความใหม่ไม่ผ่าน: ${recheck.error}` });
        return true;
      }
      if (sequence.status === "draft" && db.countActiveStepSequences(sequence.channel_id) >= STEP_LIMITS.maxActivePerChannel) {
        json(res, 409, { ok: false, error: `เปิดใช้พร้อมกันได้ไม่เกิน ${STEP_LIMITS.maxActivePerChannel} ลำดับต่อ OA` });
        return true;
      }
      const estimate = await monthlyEstimate(sequence);
      const quota = quotaPayload(await engine.quotaFor(sequence.channel_id).catch(() => null), estimate.messagesPerMonth);
      const warnings = [
        "ถ้าลำดับเดียวกันยังเปิดอยู่ใน LINE OA Manager ลูกค้าจะได้ทั้งสองชุด — ย้ายมาทีละลำดับ และปิดชุดใน OA Manager เมื่อเปิดที่นี่",
      ];
      if (stepMessagesMode(db) === "off") warnings.push("สวิตช์รวมข้อความตามขั้นปิดอยู่ (ตั้งค่า → สวิตช์พฤติกรรม) — เปิดใช้ได้ แต่จะยังไม่ส่งจนกว่าจะเปิดสวิตช์");
      if (sequence.trigger_type === "order_paid") warnings.push("ลูกค้าที่ซื้อแล้วทีมดูแล 100% — ใช้ลำดับนี้สำหรับข้อมูลเตรียมเรียน/เอกสารเท่านั้น (ไม่มีการขาย)");
      if (sequence.trigger_type === "follow") warnings.push("นับเฉพาะคนที่เพิ่มเพื่อนหลังกดเปิดใช้ · คนที่เลิกบล็อกไม่นับเป็นเพื่อนใหม่");
      // จุดเริ่มซ้ำกับลำดับที่ทำงานอยู่ = ลูกค้าเข้าทั้งสองชุด (เพดานวันละ 1 ข้อความยังกันไม่ให้ถี่ แต่ได้ครบทั้งสองชุด)
      const twins = db.activeStepSequences({ channel: sequence.channel_id, triggerType: sequence.trigger_type })
        .filter((other) => other.id !== sequence.id && String(other.trigger_value) === String(sequence.trigger_value));
      if (twins.length) {
        warnings.push(`ลำดับ ${twins.map((other) => `"${other.name}"`).join(", ")} เริ่มจากจุดเดียวกันและทำงานอยู่ — ลูกค้าจะเข้าทั้งสองลำดับ (ข้อความอัตโนมัติรวมกันไม่เกินวันละ 1 ครั้ง)`);
      }
      const baseline = baselineIds(sequence).length;
      if (baseline) warnings.push(`มี ${baseline.toLocaleString("th-TH")} คนที่ตรงเงื่อนไขอยู่แล้ว — ไม่ได้รับ (เริ่มนับเฉพาะคนใหม่หลังเปิดใช้)`);
      json(res, 200, {
        ok: true,
        summary: {
          name: sequence.name, channelName: channelLabel(sequence.channel_id), triggerText: triggerText(sequence),
          stopOnReply: sequence.stop_on_reply,
          steps: sequence.steps.map((step, index) => ({
            step: index + 1, delayText: delayText(step.delay, index), bubbles: step.messages.length,
            condition: step.condition,
          })),
          estimate, quota, baseline, warnings, expectedConfirmText: CONFIRM_WORD,
        },
        confirmation: makeStudioConfirmation({ secret: config.consoleSessionSecret, now, ...confirmationFields(sequence, sessionId) }),
        confirmationExpiresAt: now() + STUDIO_CONFIRM_TTL_MS,
      });
      return true;
    }

    /* ---- POST steps/:id/activate ---- */
    if (action === "activate" && route.length === 4) {
      const body = await readJson(req);
      if (sequence.channel_id === FACEBOOK_CHANNEL_ID) {
        json(res, 400, { ok: false, error: "ข้อความตามขั้นใช้ได้กับ LINE OA เท่านั้น" });
        return true;
      }
      if (body.confirm !== true || String(body.confirmText || "").trim() !== CONFIRM_WORD) {
        json(res, 400, { ok: false, error: `ต้องพิมพ์ "${CONFIRM_WORD}" เพื่อยืนยัน` });
        return true;
      }
      if (!studioConfirmationMatches({ token: body.confirmation, secret: config.consoleSessionSecret, now, ...confirmationFields(sequence, sessionId) })) {
        json(res, 400, { ok: false, error: "ใบยืนยันหมดอายุหรือลำดับถูกแก้หลังตรวจ — กดตรวจใหม่" });
        return true;
      }
      if (sequence.status === "draft" && db.countActiveStepSequences(sequence.channel_id) >= STEP_LIMITS.maxActivePerChannel) {
        json(res, 409, { ok: false, error: `เปิดใช้พร้อมกันได้ไม่เกิน ${STEP_LIMITS.maxActivePerChannel} ลำดับต่อ OA` });
        return true;
      }
      const result = db.activateStepSequence(sequence.id, {
        version: sequence.version, activatedBy: username, baselineCustomerIds: baselineIds(sequence),
        links: stepMessages.activationLinks(sequence),
      });
      if (!result) {
        json(res, 409, { ok: false, error: "สถานะหรือเวอร์ชันของลำดับเปลี่ยนระหว่างยืนยัน — โหลดใหม่ก่อน" });
        return true;
      }
      db.addAudit({
        operator: username, action: "step_sequence_activated", target: sequence.channel_id,
        detail: `sequence=${sequence.id}; version=${sequence.version}; trigger=${sequence.trigger_type}; baseline=${result.baseline}`,
      });
      json(res, 200, { ok: true, sequence: publicSequence(result.sequence), baseline: result.baseline });
      return true;
    }

    /* ---- POST steps/:id/pause · archive ---- */
    if (action === "pause" && route.length === 4) {
      const paused = db.pauseStepSequence(sequence.id, { pausedBy: username });
      if (!paused) {
        json(res, 409, { ok: false, error: "ลำดับนี้ไม่ได้ทำงานอยู่" });
        return true;
      }
      db.addAudit({ operator: username, action: "step_sequence_paused", target: sequence.channel_id, detail: `sequence=${sequence.id}` });
      json(res, 200, { ok: true, sequence: publicSequence(paused) });
      return true;
    }
    if (action === "archive" && route.length === 4) {
      const body = await readJson(req);
      if (body.confirm !== true) {
        json(res, 400, { ok: false, error: "ต้องยืนยันก่อนปิดลำดับถาวร" });
        return true;
      }
      const archived = db.archiveStepSequence(sequence.id);
      if (!archived) {
        json(res, 409, { ok: false, error: "ลำดับนี้ถูกปิดไปแล้ว" });
        return true;
      }
      db.addAudit({ operator: username, action: "step_sequence_archived", target: sequence.channel_id, detail: `sequence=${sequence.id}` });
      json(res, 200, { ok: true, sequence: publicSequence(archived) });
      return true;
    }

    return false;
  }

  return { handle };
}
