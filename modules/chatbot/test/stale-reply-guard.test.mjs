// stale-reply-guard — กันบอลลูนที่เหลือตอบคำถามเก่า เมื่อลูกค้าพิมพ์แทรกระหว่างส่ง
//
// เคสจริง 1 ก.ย. 2026 ห้อง Facebook (ไล่จาก llm_usage + messages ของ production):
//   21:07:01 ลูกค้า "งานประจำคะ"
//   21:07:20 โมเดลคิดเสร็จ — ด่าน "เช็คก่อนส่ง" (v1.4.46) ผ่านถูกต้อง ยังไม่มีข้อความใหม่
//   21:07:21 เริ่มทยอยส่ง 3 บอลลูน โดยหน่วงจังหวะพิมพ์คั่นบอลลูนละ ~6 วินาที
//   21:07:28 ลูกค้า "แต่อยากการายได้"  <- แทรกตอนส่งไปแล้ว 1-2 บอลลูน
//   21:07:33 บอลลูนที่เหลือออกจนครบ เชียร์คลาสผิดกลุ่ม
//   21:08:01 บอทต้องขอโทษแล้วตอบใหม่
//
// รูจริงคือช่วง ~12 วินาทีที่เราหน่วงจังหวะพิมพ์เอง แล้วไม่มีใครเช็คซ้ำ
// ไม่ใช่ตอนก่อนเริ่มส่ง (ตรงนั้นมีด่านอยู่แล้วและทำงานถูก)
import test from "node:test";
import assert from "node:assert/strict";
import { createFacebookClient } from "../src/facebookClient.mjs";

const silent = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function fbClient({ stillRelevant } = {}) {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ message_id: `m${sent.length}` }) };
  };
  const client = createFacebookClient({
    // sendDelayScale: 0 = ไม่รอจริงในเทสต์ แต่ยังเดินผ่านจุดเช็คทุกรอบเหมือนของจริง
    config: { fbMockUrl: "", fbLiveSend: true, fbApiVersion: "v24.0", lineTimeoutMs: 1000, sendDelayScale: 0 },
    credentials: () => ({ pageAccessToken: "tok" }),
    fetchImpl,
    logger: silent,
  });
  return { client, sent, stillRelevant };
}

const bubbles = [{ text: "หนึ่ง" }, { text: "สอง" }, { text: "สาม" }];

test("ลูกค้าพิมพ์แทรกระหว่างทยอยส่ง: หยุดบอลลูนที่เหลือ ไม่ยิงคำตอบเก่าให้ครบ", async () => {
  const { client, sent } = fbClient();
  let interrupted = false;
  const result = await client.sendBubbles({
    to: "PSID", bubbles,
    // บอลลูนแรกออกไปแล้ว ลูกค้าถึงพิมพ์แทรก — ตรงกับของจริง
    stillRelevant: () => { const ok = !interrupted; interrupted = true; return ok; },
  });

  assert.equal(result.ok, true, "ที่ส่งไปแล้วถือว่าส่งสำเร็จ ไม่ใช่ error");
  assert.equal(result.stoppedEarly, true, "ต้องบอก caller ว่าหยุดกลางคัน");
  assert.equal(sent.length, 2, "บอลลูนที่ 3 ต้องไม่ออก");
  assert.equal(result.delivered.length, 2, "รายงานจำนวนที่ถึงมือลูกค้าจริง");
  assert.equal(result.calls, 2);
});

test("ไม่มีใครพิมพ์แทรก: ส่งครบทุกบอลลูนเหมือนเดิม", async () => {
  const { client, sent } = fbClient();
  const result = await client.sendBubbles({ to: "PSID", bubbles, stillRelevant: () => true });
  assert.equal(result.ok, true);
  assert.ok(!result.stoppedEarly, "เส้นทางปกติต้องไม่ติดธงหยุด");
  assert.equal(sent.length, 3);
});

test("ไม่ส่ง stillRelevant มา (เช่น template ความปลอดภัย): ส่งครบเสมอ", async () => {
  const { client, sent } = fbClient();
  const result = await client.sendBubbles({ to: "PSID", bubbles });
  assert.equal(result.ok, true);
  assert.equal(sent.length, 3, "เงิน/ฉุกเฉิน/ขอคน ห้ามส่งครึ่ง ๆ กลาง ๆ");
});

test("บอลลูนแรกออกเสมอ — ตัดสินใจส่งไปแล้ว ห้ามเงียบสนิท", async () => {
  const { client, sent } = fbClient();
  const result = await client.sendBubbles({ to: "PSID", bubbles, stillRelevant: () => false });
  assert.equal(sent.length, 1, "ลูกค้าต้องได้อย่างน้อยหนึ่งข้อความ ไม่ใช่ทักแล้วเงียบ");
  assert.equal(result.stoppedEarly, true);
});
