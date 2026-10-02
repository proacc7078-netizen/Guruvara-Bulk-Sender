/*
 * Phase 7.2 → Phase 7.4 — unconfigured safety + OpenWA text delivery.
 *
 * Phase 7.2 asserted that WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED=false blocked
 * delivery. Phase 7.4 removed that gate: the "blocked" state is provider=none
 * (the safe unconfigured adapter), and provider=openwa delivers through the
 * resolved OpenWA adapter. Updated accordingly.
 *
 * Mocked only: the OpenWA adapter used below is a stub, no request is made and
 * no real message is sent. Throwaway SQLite database.
 */
const t = require('./test-7-2-helpers.cjs');
const path = require('path');

function setEnv(vars) { for (const k of Object.keys(vars)) { if (vars[k] === undefined) delete process.env[k]; else process.env[k] = vars[k]; } }

async function main() {
  console.log('=== Phase 7.2b -> 7.4 — unconfigured safety / OpenWA delivery ===');
  const x = await t.setup();
  const del = new x.svcMod.ExecutionDeliveryService();
  const provMod = require(path.join(t.h.DIST, 'services/whatsapp/whatsappProvider.js'));
  // The removed Phase 7.2 switch: set explicitly to prove it no longer matters.
  process.env.WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED = 'false';

  /* ---------------- provider=none: the safe unconfigured state ---------------- */
  setEnv({ WHATSAPP_PROVIDER: 'none' });
  provMod.resetWhatsAppAdapter();
  const n1 = await x.seedExecution(null, 'unconfigured text body');
  const nr1 = await del.sendExecutionRecipient(x.idOf(n1.exec, n1.recip));
  t.check('10 provider=none never calls sendText/sendMedia', x.calls.sendText.length === 0 && x.calls.sendMedia.length === 0, JSON.stringify(x.calls));
  t.check('11 provider=none keeps the existing failure classification', nr1.success === false && nr1.errorCode === 'WHATSAPP_PROVIDER_UNAVAILABLE' && /not configured/i.test(nr1.errorMessage || ''), JSON.stringify(nr1));
  const nw1 = await x.row(n1.exec, n1.recip);
  t.check('12 provider=none stores no providerMessageId and never marks SENT', nw1.status !== 'SENT' && nw1.providerMessageId === null, nw1.status);
  const n2 = await x.seedExecution('storage/uploads/local-only-72.png', 'unconfigured caption');
  await del.sendExecutionRecipient(x.idOf(n2.exec, n2.recip));
  const nw2 = await x.row(n2.exec, n2.recip);
  t.check('13 provider=none media snapshot is never sent either', x.calls.sendText.length === 0 && x.calls.sendMedia.length === 0 && nw2.status !== 'SENT', nw2.status);

  /* -------- provider=openwa: the delivery path uses the resolved adapter -------- */
  setEnv({
    WHATSAPP_PROVIDER: 'openwa',
    WHATSAPP_OPENWA_API_KEY: 'DUMMY_OPENWA_KEY',
    WHATSAPP_OPENWA_SESSION_ID: 'DUMMY_SESSION_ID',
    WHATSAPP_OPENWA_BASE_URL: 'http://openwa.invalid:2785',
  });
  x.providerDist.whatsappProviderRegistry.getAdapter = () => x.mockAdapter();
  const t1 = await x.seedExecution(null, 'hello openwa text');
  const r1 = await del.sendExecutionRecipient(x.idOf(t1.exec, t1.recip));
  t.check('14 OpenWA sendText is called through the delivery path (no gate required)',
    x.calls.sendText.length === 1 && x.calls.sendText[0].to === t1.recip.whatsappNumber && x.calls.sendText[0].msg === 'hello openwa text',
    JSON.stringify(x.calls.sendText));
  t.check('15 returned messageId becomes providerMessageId', r1.success === true && r1.providerMessageId === 'true_1@c.us_MOCK1', JSON.stringify(r1));
  const w1 = await x.row(t1.exec, t1.recip);
  t.check('16 successful OpenWA text marks SENT with the provider id', w1.status === 'SENT' && w1.providerMessageId === 'true_1@c.us_MOCK1', w1.status);
  const t2 = await x.seedExecution(null, 'second openwa text');
  const r2 = await del.sendExecutionRecipient(x.idOf(t2.exec, t2.recip));
  t.check('17 the removed gate variable has no effect on delivery', r2.success === true && x.calls.sendText.length === 2, JSON.stringify(r2));

  await x.teardown();
  delete process.env.WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED;
  const c = t.counters();
  console.log('Phase 7.2b -> 7.4 assertions done failed: ' + c.F);
  if (c.F > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
