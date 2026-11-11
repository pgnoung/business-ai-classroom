import { lineOaCapabilityStatus } from "./lineOaCapabilities.mjs";

const OWNER_ONLY_MESSAGE = "เฉพาะ Super Admin เท่านั้นที่ดูสถานะการเชื่อม LINE OA ได้";

// This is intentionally GET-only.  The status page is a safe readiness aid,
// not an integration setup or a data-import endpoint.
export function createLineOaCapabilityRoutes({ config = {}, channels = [] } = {}) {
  async function handle(req, res, url, route, ctx) {
    if (route[0] !== "line-oa" || route[1] !== "status" || route.length !== 2) return false;
    const { json, operator } = ctx;
    if (operator?.role !== "owner") {
      json(res, 403, { ok: false, error: OWNER_ONLY_MESSAGE });
      return true;
    }
    if (req.method !== "GET") {
      json(res, 405, { ok: false, error: "method ไม่ถูกต้อง" });
      return true;
    }
    json(res, 200, { ok: true, ...lineOaCapabilityStatus({ config, channels }) });
    return true;
  }
  return { handle };
}

export { OWNER_ONLY_MESSAGE };
