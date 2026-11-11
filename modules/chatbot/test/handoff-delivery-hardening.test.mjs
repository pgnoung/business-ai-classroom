import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { createEscalationNotifier, NOTIFY_KEY_PREFIX } from '../src/notify.mjs';
import { canAutoEnableAi } from '../src/aiPausePolicy.mjs';
import { paymentStartedFromRow, IMAGE_ACK_TEMPLATE } from '../src/pipeline.mjs';
import { createFacebookWebhook } from '../src/facebookWebhook.mjs';
import { createHmac } from 'node:crypto';
import { createFacebookClient } from '../src/facebookClient.mjs';
import { memoryDb, testConfig, poisonGlobalFetch, lineFetchStub } from './helpers.mjs';

poisonGlobalFetch();
const silent = { log() {}, warn() {}, error() {}, debug() {} };
const ids = ['U' + '1'.repeat(32), 'U' + '2'.repeat(32)];

test('a failed staff recipient does not swallow the next; retry only failed recipients', async () => {
  const db = memoryDb();
  db.setSetting(NOTIFY_KEY_PREFIX + 'default', JSON.stringify(ids));
  const calls = [];
  let fails = true;
  const notifier = createEscalationNotifier({ db, logger: silent, line: {
    async sendBubbles({ to }) {
      calls.push(to);
      if (to === ids[0] && fails) throw new Error('provider unavailable');
      return { ok: true };
    },
  } });
  const args = { customerId: 'test-room', reason: 'human_requested' };
  const first = await notifier.fire(args);
  assert.deepEqual(calls, ids);
  assert.equal(first.ok, false);
  assert.equal(first.sent, 1);
  fails = false;
  await notifier.fire(args);
  assert.deepEqual(calls, [...ids, ids[0]]);
  assert.equal((await notifier.fire(args)).skipped, 'cooldown');
  db.close();
});

test('provider rejection is not success and does not consume cooldown', async () => {
  const db = memoryDb();
  db.setSetting(NOTIFY_KEY_PREFIX + 'default', JSON.stringify([ids[0]]));
  let calls = 0;
  const notifier = createEscalationNotifier({ db, logger: silent, line: {
    async sendBubbles() { calls++; return { ok: false }; },
  } });
  for (let i = 0; i < 2; i++) assert.equal((await notifier.fire({ customerId: 'room', reason: 'image_review' })).ok, false);
  assert.equal(calls, 2);
  db.close();
});

for (const channelId of ['default', 'facebook']) {
  test(`${channelId}: attached file goes to staff, never interpreted as payment or sent to a model`, async () => {
    const db = memoryDb();
    const uid = '123456';
    const customerId = channelId === 'default' ? uid : `${channelId}:${uid}`;
    db.upsertCustomer(customerId, { channelId });
    const notifications = [];
    let modelCalls = 0;
    const line = lineFetchStub();
    const app = createApp({ db, config: testConfig(), logger: silent, overrides: {
      notifier: { fireLater(args) { notifications.push(args); } },
      lineFetch: line, hermesFetch: async () => { modelCalls++; throw new Error('must not call model'); },
    } });
    const event = { type: 'message', source: { userId: uid }, message: { type: 'file', id: 'pdf-test', fileName: 'document.pdf' } };
    const ctx = channelId === 'default' ? {} : { channelId };
    // F5 (ตรวจย้อนหลัง ก.ย. 2026): ห้องที่ยังไม่มีเรื่องเงิน — ธงคิวรอคน + AI คุยต่อ + ไม่ปลุกทีม
    const lead = await app.pipeline.handleEvent(event, ctx);
    assert.equal(lead.route, 'file_review');
    const row = db.getCustomer(customerId);
    assert.equal(row.ai_enabled, 1);
    assert.equal(row.state, 'NEEDS_HUMAN');
    assert.equal(Number(row.money_seen_at || 0), 0);
    assert.equal(paymentStartedFromRow(row), false, 'staff-only file summary is not payment evidence');
    assert.equal(modelCalls, 0);
    assert.equal(notifications.length, 0, 'no money context = queue flag only, no page');
    // ห้องที่มีเรื่องเงินแล้ว = เส้นเดิมทุกอย่าง
    db.markMoneySeen(customerId);
    const result = await app.pipeline.handleEvent({ ...event, message: { ...event.message, id: 'pdf-test-2' } }, ctx);
    assert.equal(result.suppressed, 'file_review');
    const moneyRow = db.getCustomer(customerId);
    assert.equal(moneyRow.ai_enabled, 0);
    assert.equal(moneyRow.ai_off_reason, 'file_review');
    assert.equal(canAutoEnableAi(moneyRow), false);
    assert.equal(modelCalls, 0);
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].reason, 'file_review');
    db.setAiEnabled(customerId, false, 'manual');
    await app.pipeline.handleEvent(event, ctx);
    assert.equal(db.getCustomer(customerId).ai_off_reason, 'manual');
    db.close();
  });
}

test('unavailable image notifies staff without claiming payment or sending a model reply', async () => {
  const db = memoryDb();
  db.upsertCustomer('image-room', {});
  const notices = [];
  const line = lineFetchStub();
  const app = createApp({ db, config: testConfig(), logger: silent, overrides: {
    imageClassify: { enabled: true, async classify() { return { kind: 'unknown', reasonCode: 'no_file' }; } },
    notifier: { fireLater(args) { notices.push(args); } }, lineFetch: line,
    hermesFetch: async () => { throw new Error('must not call model'); },
  } });
  await app.pipeline.handleEvent({ type: 'message', source: { userId: 'image-room' }, message: { type: 'image', id: 'missing' } });
  // F6 (ตรวจย้อนหลัง ก.ย. 2026): ห้องที่ยังไม่มีเรื่องเงิน — AI คุยต่อ + ตอบรับตายตัวหนึ่งบรรทัด
  assert.equal(db.getCustomer('image-room').ai_enabled, 1);
  assert.equal(paymentStartedFromRow(db.getCustomer('image-room')), false);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].reason, 'image_review');
  assert.equal(line.sends.length, 1);
  assert.ok(JSON.stringify(line.sends[0].body).includes(IMAGE_ACK_TEMPLATE));
  db.close();
});

test('Facebook signed file webhook reaches staff routing exactly once under provider replay', async () => {
  const db = memoryDb();
  db.upsertCustomer('facebook:987654', { channelId: 'facebook' });
  const notices = [];
  const notifier = { fireLater(args) { notices.push(args); } };
  const app = createApp({ db, config: testConfig(), logger: silent, overrides: {
    notifier, lineFetch: lineFetchStub(), hermesFetch: async () => { throw new Error('no model calls'); },
  } });
  const webhook = createFacebookWebhook({ db, config: {}, pipeline: app.pipeline, notifier,
    lineRegistry: { channels: [{ id: 'facebook', credentials: () => ({ appSecret: 'test-secret' }) }],
      forChannel: () => ({ async getProfile() { return null; } }) },
    logger: silent, readBody: async req => req._raw,
    json: (res, status) => { res.status = status; },
  });
  const raw = Buffer.from(JSON.stringify({ object: 'page', entry: [{ messaging: [{
    sender: { id: '987654' }, recipient: { id: 'page' }, message: { mid: 'file-mid',
      attachments: [{ type: 'file', payload: { url: 'https://example.invalid/document.pdf' } }] },
  }] }] }));
  const req = { method: 'POST', _raw: raw, headers: {
    'x-hub-signature-256': 'sha256=' + createHmac('sha256', 'test-secret').update(raw).digest('hex'),
  } };
  for (let i = 0; i < 2; i++) {
    const res = {};
    await webhook.handleWebhook(req, res);
    assert.equal(res.status, 200);
  }
  // F5 (ก.ย. 2026): ห้องที่ยังไม่มีเรื่องเงิน = ธงคิวรอคนครั้งเดียว ไม่ปลุกทีม AI คุยต่อ
  assert.equal(db.getCustomer('facebook:987654').state, 'NEEDS_HUMAN');
  assert.equal(db.getCustomer('facebook:987654').ai_enabled, 1);
  assert.equal(db.listAudit().filter(a => a.action === 'file_review' && a.target === 'facebook:987654').length, 1);
  assert.equal(notices.length, 0);
  assert.equal(db.messagesFor('facebook:987654', 10).filter(r => r.direction === 'in').length, 1);
  db.close();
});

test('overlapping staff sends do not duplicate recipients', async () => {
  const db = memoryDb();
  db.setSetting(NOTIFY_KEY_PREFIX + 'default', JSON.stringify(ids));
  const calls = [];
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const notifier = createEscalationNotifier({ db, logger: silent, line: {
    async sendBubbles({ to }) { calls.push(to); if (to === ids[0]) await pending; return { ok: true }; },
  } });
  const args = { customerId: 'overlap', reason: 'human_requested' };
  const first = notifier.fire(args);
  await notifier.fire(args);
  release();
  await first;
  assert.deepEqual(calls, ids);
  db.close();
});

test('Meta can return a name even when profile_pic makes the combined request fail', async () => {
  const calls = [];
  const client = createFacebookClient({ config: { fbLiveSend: true, fbApiVersion: 'v24.0' },
    credentials: () => ({ pageAccessToken: 'test-token' }),
    fetchImpl: async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.doesNotMatch(url, /access_token/);
      return url.includes('profile_pic')
        ? { ok: false, status: 400, async json() { return { error: { code: 100 } }; } }
        : { ok: true, async json() { return { first_name: 'Test', last_name: 'Person' }; } };
    }, logger: silent });
  assert.deepEqual(await client.getProfile({ userId: 'test-user' }), { displayName: 'Test Person', pictureUrl: '' });
  assert.equal(calls.length, 2);
});

test('forced one-shot handoff is not swallowed by an in-flight ordinary notification', async () => {
  const db = memoryDb();
  db.setSetting(NOTIFY_KEY_PREFIX + 'default', JSON.stringify([ids[0]]));
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const notifier = createEscalationNotifier({ db, logger: silent, line: {
    async sendBubbles() { calls++; if (calls === 1) await pending; return { ok: true }; },
  } });
  const first = notifier.fire({ customerId: 'forced', reason: 'image_review' });
  const handoff = await notifier.fire({ customerId: 'forced', reason: 'booking_handoff', force: true });
  assert.equal(handoff.sent, 1);
  release();
  await first;
  assert.equal(calls, 2);
  db.close();
});

test('Meta quota or server failure does not trigger another profile request', async () => {
  for (const status of [429, 500]) {
    let calls = 0;
    const client = createFacebookClient({ config: { fbLiveSend: true },
      credentials: () => ({ pageAccessToken: 'test-token' }),
      fetchImpl: async () => { calls++; return { ok: false, status }; }, logger: silent });
    assert.equal(await client.getProfile({ userId: 'test-user' }), null);
    assert.equal(calls, 1);
  }
});
