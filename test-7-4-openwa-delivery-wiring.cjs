/*
 * Phase 7.4 — OpenWA wired into the campaign execution / queue-worker delivery path.
 *
 * Proves, with a recording fetch mock and a throwaway SQLite database:
 *   1. provider=official still resolves the official adapter
 *   2. provider=none stays safe/unconfigured (no provider is ever contacted)
 *   3. provider=openwa resolves OpenWAWhatsAppAdapter through the existing registry
 *   4. OpenWA delivery calls the adapter's existing sendText() through the
 *      existing execution delivery path (immutable snapshot phone/body)
 *   5. the providerMessageId returned by the OpenWA response is preserved by the
 *      existing execution flow (returned AND persisted on the recipient row)
 *   6. the official-provider delivery path is byte-for-byte unchanged
 *   7. the queue worker delivers through the same wired delivery path
 *
 * Safety:
 * - Throwaway SQLite database under the OS temp directory; the real database is
 *   never opened, reset or deleted.
 * - globalThis.fetch is replaced by a recording mock, so no request can ever
 *   reach a provider (no localhost:2785, no graph.facebook.com).
 * - Dummy credential/session placeholders only; no real WhatsApp message is sent.
 */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');

let C = 0;
let F = 0;
function check(n, c, e) {
  C++;
  if (!c) F++;
  console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : ''));
}

const OPENWA_KEY = 'DUMMY_OPENWA_KEY';
const OPENWA_SID = 'DUMMY_SESSION_ID';
const OPENWA_BASE = 'http://openwa.invalid:2785';
const OPENWA_TEXT_URL = OPENWA_BASE + '/api/sessions/' + OPENWA_SID + '/messages/send-text';
const OPENWA_MSG_ID = 'true_15551234567@c.us_WIRING1';
const OFFICIAL_MSG_ID = 'wamid.WIRING_OFFICIAL';
const OFFICIAL_TEXT_URL = 'https://graph.facebook.com/v20.0/DUMMY_PN/messages';
const PHONE = '+15551234567';

function openwaEnv(over) {
  return Object.assign(
    {
      WHATSAPP_PROVIDER: 'openwa',
      WHATSAPP_OPENWA_API_KEY: OPENWA_KEY,
      WHATSAPP_OPENWA_SESSION_ID: OPENWA_SID,
      WHATSAPP_OPENWA_BASE_URL: OPENWA_BASE,
    },
    over || {}
  );
}

function officialEnv(over) {
  return Object.assign(
    {
      WHATSAPP_PROVIDER: 'official',
      WHATSAPP_ACCESS_TOKEN: 'DUMMY_ACCESS_TOKEN',
      WHATSAPP_BUSINESS_ACCOUNT_ID: 'DUMMY_WABA',
      WHATSAPP_PHONE_NUMBER_ID: 'DUMMY_PN',
      WHATSAPP_API_VERSION: 'v20.0',
      WHATSAPP_API_BASE_URL: 'https://graph.facebook.com',
    },
    over || {}
  );
}

async function main() {
  console.log('=== Phase 7.4 — OpenWA delivery wiring ===');

  const savedDbUrl = process.env.DATABASE_URL;
  const dbPath = path.join(
    os.tmpdir(),
    'exec74-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.db'
  );
  process.env.DATABASE_URL = 'file:' + dbPath;

  // In-process fetch recorder: the mocked transport is the only transport.
  const origFetch = globalThis.fetch;
  const calls = [];
  function mockFetch(responder) {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: url, init: init || {} });
      return responder(url, init);
    };
  }
  mockFetch(() => ({ ok: true, status: 201, json: async () => ({ messageId: OPENWA_MSG_ID }) }));

  const { execSync } = require('child_process');
  execSync('npx prisma db push --schema=prisma/schema.prisma --skip-generate', {
    cwd: h.REPO_ROOT,
    env: { ...process.env },
    stdio: 'pipe',
  });
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } } });
  const dbMod = h.fresh('config/db.js');
  const svcMod = h.fresh('services/executionDelivery.service.js');
  const workerMod = h.fresh('services/executionQueueWorker.js');
  const provMod = require(path.join(h.DIST, 'services/whatsapp/whatsappProvider.js'));
  const registry = require(path.join(h.DIST, 'services/whatsapp/WhatsAppAdapter.js'))
    .whatsappProviderRegistry;

  async function seedExecution(body, phone) {
    const camp = await prisma.campaign.create({ data: { name: 'C74 ' + Math.random() } });
    const exec = await prisma.campaignExecution.create({
      data: {
        campaignId: camp.id,
        status: 'RUNNING',
        scheduledAt: new Date(),
        startedAt: new Date(),
        messageBody: body,
      },
    });
    const recip = await prisma.recipient.create({
      data: {
        name: 'R74',
        whatsappNumber: phone,
        normalizedPhone: '74' + Date.now() + Math.floor(Math.random() * 99999),
        status: 'ACTIVE',
        source: 'MANUAL',
        consentStatus: 'GRANTED',
      },
    });
    await prisma.campaignExecutionRecipient.create({
      data: {
        executionId: exec.id,
        recipientId: recip.id,
        whatsappNumber: phone,
        name: recip.name,
        status: 'PENDING',
      },
    });
    return { exec: exec, recip: recip };
  }
  const idOf = (e, r) => e.id + ':' + r.id;
  async function row(e, r) {
    return prisma.campaignExecutionRecipient.findUnique({
      where: { executionId_recipientId: { executionId: e.id, recipientId: r.id } },
    });
  }

  const del = new svcMod.ExecutionDeliveryService();

  /* ------------------------------------------------------------------ *
   * 1-3. provider selection on the adapter the delivery path resolves
   * ------------------------------------------------------------------ */
  let s = h.setEnv(officialEnv({ WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED: 'false' }));
  provMod.resetWhatsAppAdapter();
  check(
    '1 provider=official still resolves the official adapter',
    registry.getAdapter().constructor.name === 'OfficialWhatsAppAdapter',
    registry.getAdapter().constructor.name
  );
  h.rest(s);

  s = h.setEnv({ WHATSAPP_PROVIDER: 'none' });
  provMod.resetWhatsAppAdapter();
  check(
    '2 provider=none stays safe/unconfigured',
    registry.getAdapter().constructor.name === 'UnconfiguredWhatsAppAdapter',
    registry.getAdapter().constructor.name
  );
  h.rest(s);

  s = h.setEnv(openwaEnv());
  provMod.resetWhatsAppAdapter();
  const openwaAdapter = registry.getAdapter();
  check(
    '3 provider=openwa resolves OpenWAWhatsAppAdapter for the delivery path',
    openwaAdapter.constructor.name === 'OpenWAWhatsAppAdapter',
    openwaAdapter.constructor.name
  );
  check(
    '4 the resolved adapter implements the existing adapter interface',
    ['getStatus', 'connect', 'disconnect', 'sendText', 'sendMedia', 'getMessageStatus'].every(
      (m) => typeof openwaAdapter[m] === 'function'
    )
  );
  h.rest(s);

  // The removed Phase 7.2 switch must not influence provider selection any more.
  s = h.setEnv(openwaEnv({ WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED: 'false' }));
  provMod.resetWhatsAppAdapter();
  check(
    '5 the removed Phase 7.2 gate variable no longer gates OpenWA delivery',
    registry.getAdapter().constructor.name === 'OpenWAWhatsAppAdapter',
    registry.getAdapter().constructor.name
  );
  h.rest(s);

  /* ------------------------------------------------------------------ *
   * 4-5. OpenWA delivery through the existing execution delivery path
   * ------------------------------------------------------------------ */
  s = h.setEnv(openwaEnv());
  provMod.resetWhatsAppAdapter();
  calls.length = 0;
  const e1 = await seedExecution('openwa wiring body', PHONE);
  const r1 = await del.sendExecutionRecipient(idOf(e1.exec, e1.recip));
  check(
    '6 OpenWA delivery calls the adapter sendText endpoint via the delivery path',
    calls.length === 1 && calls[0].url === OPENWA_TEXT_URL && calls[0].init.method === 'POST',
    JSON.stringify(calls.map((c) => c.url))
  );
  const sentBody = calls.length === 1 ? JSON.parse(calls[0].init.body) : null;
  check(
    '7 snapshot recipient/body are used for the OpenWA request',
    !!sentBody && sentBody.chatId === '15551234567@c.us' && sentBody.text === 'openwa wiring body',
    JSON.stringify(sentBody)
  );
  check(
    '8 the API key travels in the X-API-Key header only',
    !!sentBody &&
      calls[0].init.headers['X-API-Key'] === OPENWA_KEY &&
      calls[0].url.indexOf(OPENWA_KEY) < 0 &&
      JSON.stringify(sentBody).indexOf(OPENWA_KEY) < 0
  );
  check(
    '9 sendText result propagates through the delivery flow',
    r1.success === true && r1.providerMessageId === OPENWA_MSG_ID,
    JSON.stringify(r1)
  );
  const w1 = await row(e1.exec, e1.recip);
  check(
    '10 providerMessageId returned by OpenWA is stored by the execution flow',
    w1.status === 'SENT' && w1.providerMessageId === OPENWA_MSG_ID && !!w1.sentAt,
    JSON.stringify({ status: w1.status, providerMessageId: w1.providerMessageId })
  );
  check(
    '11 delivery success clears the failure fields',
    w1.errorCode === null && w1.errorMessage === null && w1.nextAttemptAt === null
  );
  h.rest(s);

  /* ------------------------------------------------------------------ *
   * 6. the existing official-provider delivery behaviour is preserved
   * ------------------------------------------------------------------ */
  mockFetch(() => ({
    ok: true,
    status: 200,
    json: async () => ({ messaging_product: 'whatsapp', messages: [{ id: OFFICIAL_MSG_ID }] }),
  }));
  s = h.setEnv(officialEnv());
  provMod.resetWhatsAppAdapter();
  calls.length = 0;
  const e2 = await seedExecution('official body', PHONE);
  const r2 = await del.sendExecutionRecipient(idOf(e2.exec, e2.recip));
  check(
    '12 provider=official still posts to the Meta messages endpoint',
    calls.length === 1 && calls[0].url === OFFICIAL_TEXT_URL && calls[0].init.method === 'POST',
    JSON.stringify(calls.map((c) => c.url))
  );
  check(
    '13 official request keeps Bearer auth and the documented body',
    calls[0].init.headers['Authorization'] === 'Bearer DUMMY_ACCESS_TOKEN' &&
      JSON.parse(calls[0].init.body).type === 'text'
  );
  check(
    '14 official providerMessageId still preserved by the delivery flow',
    r2.success === true && r2.providerMessageId === OFFICIAL_MSG_ID,
    JSON.stringify(r2)
  );
  const w2 = await row(e2.exec, e2.recip);
  check(
    '15 official delivery still marks SENT with the provider id',
    w2.status === 'SENT' && w2.providerMessageId === OFFICIAL_MSG_ID
  );
  h.rest(s);

  /* ------------------------------------------------------------------ *
   * 2. provider=none stays safe on the real delivery path
   * ------------------------------------------------------------------ */
  globalThis.fetch = async () => {
    throw new Error('provider=none must never perform network I/O');
  };
  s = h.setEnv({ WHATSAPP_PROVIDER: 'none' });
  provMod.resetWhatsAppAdapter();
  const e3 = await seedExecution('none body', PHONE);
  const r3 = await del.sendExecutionRecipient(idOf(e3.exec, e3.recip));
  const w3 = await row(e3.exec, e3.recip);
  check(
    '16 provider=none delivery contacts no provider and stores no provider id',
    r3.success === false && w3.status !== 'SENT' && !w3.providerMessageId,
    JSON.stringify({ status: w3.status, providerMessageId: w3.providerMessageId })
  );
  check(
    '17 provider=none keeps the existing failure classification/retry behaviour',
    r3.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE' &&
      r3.retryScheduled === true &&
      w3.status === 'PENDING',
    JSON.stringify(r3)
  );
  h.rest(s);

  /* ------------------------------------------------------------------ *
   * 7. the queue worker delivers through the same wired path
   * ------------------------------------------------------------------ */
  mockFetch(() => ({ ok: true, status: 201, json: async () => ({ messageId: OPENWA_MSG_ID }) }));
  s = h.setEnv(openwaEnv());
  provMod.resetWhatsAppAdapter();
  calls.length = 0;
  const e4 = await seedExecution('worker wiring body', PHONE);
  const worker = new workerMod.ExecutionQueueWorker(999999);
  const cycle = await worker.processCycle();
  check(
    '18 queue worker delivered the PENDING recipient through OpenWA',
    cycle.processed === 1 && cycle.sent === 1,
    JSON.stringify(cycle)
  );
  check(
    '19 queue worker sent exactly one OpenWA send-text request',
    calls.length === 1 && calls[0].url === OPENWA_TEXT_URL,
    JSON.stringify(calls.map((c) => c.url))
  );
  const w4 = await row(e4.exec, e4.recip);
  check(
    '20 queue worker stored the returned providerMessageId',
    w4.status === 'SENT' && w4.providerMessageId === OPENWA_MSG_ID,
    JSON.stringify({ status: w4.status, providerMessageId: w4.providerMessageId })
  );
  const execRow = await prisma.campaignExecution.findUnique({ where: { id: e4.exec.id } });
  check(
    '21 existing worker finalization still completes the execution',
    execRow.status === 'COMPLETED',
    execRow.status
  );
  h.rest(s);

  /* ---------------- teardown ---------------- */
  globalThis.fetch = origFetch;
  await prisma.$disconnect();
  try {
    await dbMod.prisma.$disconnect();
  } catch {}
  try {
    fs.unlinkSync(dbPath);
  } catch {}
  try {
    fs.unlinkSync(dbPath + '-journal');
  } catch {}
  if (savedDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = savedDbUrl;

  console.log('Phase 7.4 assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e.stack || e);
  process.exitCode = 1;
});
