import { hasOperatorCapability } from "./operatorRoles.mjs";
import { createTrainingIntakeService, IntakeError, TRAINING_INTAKE_MAX } from "./trainingIntake.mjs";
import { knowledgeMetadataStatus } from "./consoleTeachApi.mjs";
import { brainModeOf, BRAIN_MODE_SEPARATE } from "./knowledgePack.mjs";

const CAPABILITY = "corrections.review";
const deny = "บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้";

export function trainingIntakeReadiness({ config = {}, db = {} } = {}) {
  const canPropose = config.trainingIntakeEnabled === true && config.teachEnabled === true;
  const publicationReady = knowledgeMetadataStatus({ config, db }).ready;
  const canPublish = canPropose && publicationReady;
  const message = !canPropose
    ? "ยังไม่เปิดรับข้อเสนอเพื่อสอนลูกแพร"
    : canPublish
      ? "รับข้อเสนอและพร้อมส่งเข้าคิวเผยแพร่หลังเจ้าของอนุมัติ"
      : "รับข้อเสนอเพื่อรอรีวิวได้ แต่รอสมองพร้อมก่อนจึงจะเผยแพร่ได้";
  return { canPropose, canPublish, message };
}

export function createTrainingIntakeRoutes({ db, config = {}, channels = [], now } = {}) {
  const service = createTrainingIntakeService({ db, config, channels, now });
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "teach" || route[1] !== "intake") return false;
    const { json, readJson, operator, username, requireCsrf } = ctx;
    const readiness = trainingIntakeReadiness({ config, db });
    if (!readiness.canPropose) {
      json(res, 404, { ok: false, error: "ไม่พบเส้นทางนี้" }); return true;
    }
    if (!hasOperatorCapability(operator, CAPABILITY)) { json(res, 403, { ok: false, error: deny }); return true; }
    if (req.method === "GET" && route.length === 2) {
      const knowledgeMetadata = knowledgeMetadataStatus({ config, db });
      json(res, 200, { ok: true, enabled: true, ready: readiness.canPropose, publicationReady: readiness.canPublish,
        message: readiness.message, origins: ["team_notes", "line_oa_curated"],
        channels: [{ id: null, label: "สมองกลาง" }, ...channels
          .filter((ch) => ch?.active !== false && brainModeOf(db, ch.id) === BRAIN_MODE_SEPARATE)
          .map((ch) => ({ id: ch.id, label: ch.name || ch.id }))],
        limits: TRAINING_INTAKE_MAX, knowledgeMetadata, published: false });
      return true;
    }
    const action = route[2] || "";
    if (req.method !== "POST" || route.length !== 3 || (action !== "preview" && action !== "commit")) return false;
    if (!requireCsrf()) { json(res, 403, { ok: false, error: "CSRF token ไม่ถูกต้อง" }); return true; }
    let body;
    try { body = await readJson(req); } catch { json(res, 400, { ok: false, error: "ข้อมูลไม่ถูกต้อง" }); return true; }
    try {
      if (action === "preview") { json(res, 200, service.preview(body)); return true; }
      if (!body || typeof body !== "object" || Array.isArray(body) || body.confirm !== true || typeof body.previewHash !== "string") {
        json(res, 400, { ok: false, error: "ต้องยืนยันรายการที่ตรวจแล้ว" }); return true;
      }
      const { previewHash, confirm: _confirm, ...input } = body;
      json(res, 202, service.commit({ body: input, previewHash, submittedBy: username }));
      return true;
    } catch (error) {
      const intake = error instanceof IntakeError;
      const status = intake ? error.status : 503;
      const stale = intake && error.code === "stale_preview";
      json(res, status, { ok: false, error: stale ? "ข้อมูลหรือคลังความรู้เปลี่ยนแล้ว กรุณาตรวจอีกครั้ง" : "ข้อมูลรับเข้าไม่ผ่านการตรวจ", ...(stale ? { stalePreview: true } : {}) });
      return true;
    }
  }
  return { handle };
}
