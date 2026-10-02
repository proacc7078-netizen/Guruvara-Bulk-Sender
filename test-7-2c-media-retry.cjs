/* Phase 7.2c: gate=true media/retry/local-path + docs. Mocked only. */
const t = require('./test-7-2-helpers.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
async function main() {
  console.log('=== Phase 7.2c — media / retry / docs ===');
  const x = await t.setup();
  const del = new x.svcMod.ExecutionDeliveryService();
  x.providerDist.whatsappProviderRegistry.getAdapter = () => x.mockAdapter();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exec72c-'));
  const imgPath = path.join(tmp, 'shot.png');
  fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50]));
  const m1 = await x.seedExecution(imgPath, 'media caption body');
  const rm1 = await del.sendExecutionRecipient(x.idOf(m1.exec, m1.recip));
  t.check('18 gate=true media calls sendMedia with snapshot path/caption', x.calls.sendMedia.length === 1 && x.calls.sendMedia[0].media.path === imgPath && x.calls.sendMedia[0].caption === 'media caption body', JSON.stringify({ p: x.calls.sendMedia[0] && x.calls.sendMedia[0].media.path, c: x.calls.sendMedia[0] && x.calls.sendMedia[0].caption }));
  t.check('19 media messageId preserved', rm1.success === true && rm1.providerMessageId === 'true_1@c.us_MOCKIMG', JSON.stringify(rm1));
  x.providerDist.whatsappProviderRegistry.getAdapter = () => x.mockAdapter({
    sendText: async (to, msg) => { x.calls.sendText.push({ to, msg }); return { success: false, errorCode: 'WHATSAPP_SEND_FAILED', errorMessage: 'OpenWA API send failed with status 500.', metaError: { httpStatus: 500 } }; },
  });
  const f1 = await x.seedExecution(null, 'retry me');
  const fr = await del.sendExecutionRecipient(x.idOf(f1.exec, f1.recip));
  const w = await x.row(f1.exec, f1.recip);
  t.check('20 retry classification intact: 500 schedules retry', fr.success === false && fr.retryScheduled === true && w.status === 'PENDING' && !!w.nextAttemptAt, JSON.stringify(fr));
  // A. Provider adapter input: a local-only media payload with NO CMS-generated URL
  //    must still be rejected by the adapter itself (adapter-level safety preserved).
  const directMod = t.h.fresh('services/whatsapp/OpenWAWhatsAppAdapter.js');
  let directFetchCalls = 0;
  const real = new directMod.OpenWAWhatsAppAdapter(
    { provider: 'openwa', baseUrl: 'http://openwa.invalid:2785', apiKey: 'DUMMY_OPENWA_KEY', sessionId: 'DUMMY_SESSION_ID' },
    async () => { directFetchCalls++; throw new Error('fetch must not be called for a local-only path'); }
  );
  Object.defineProperty(real, 'constructor', { value: { name: 'OpenWAWhatsAppAdapter' }, configurable: true });
  const directLocal = await real.sendMedia('+1555000100', { path: path.join(tmp, 'local-only.png'), mimeType: 'image/png' }, 'local caption');
  t.check('21a direct adapter sendMedia with a local-only payload is still rejected',
    directLocal.success === false && directLocal.errorCode === 'WHATSAPP_CONFIGURATION_INVALID' && directFetchCalls === 0,
    JSON.stringify(directLocal));

  // B. Execution delivery: an execution carrying an immutable mediaId generates the
  //    signed CMS public media URL (host.docker.internal) and passes it to sendMedia().
  x.calls.sendMedia.length = 0;
  x.providerDist.whatsappProviderRegistry.getAdapter = () => x.mockAdapter();
  const l1 = await x.seedExecution(path.join(tmp, 'local-only.png'), 'local caption');
  const lr = await del.sendExecutionRecipient(x.idOf(l1.exec, l1.recip));
  const wl = await x.row(l1.exec, l1.recip);
  const generatedUrl = x.calls.sendMedia[0] && x.calls.sendMedia[0].media.url;
  t.check('21b execution delivery generates the signed public media URL from the immutable mediaId',
    lr.success === true && wl.status === 'SENT' && x.calls.sendMedia.length === 1 &&
    typeof generatedUrl === 'string' && /^https?:\/\//.test(generatedUrl) &&
    generatedUrl.includes('/api/media/public/') && generatedUrl.includes('token=') &&
    !/localhost|127\.0\.0\.1/.test(generatedUrl),
    JSON.stringify({ success: lr.success, status: wl.status, url: generatedUrl ? generatedUrl.replace(/token=[^&]+/, 'token=REDACTED') : null }));
  t.check('21c execution media delivery does not use the filesystem path as the provider URL',
    x.calls.sendMedia[0] && x.calls.sendMedia[0].media.path === path.join(tmp, 'local-only.png') &&
    generatedUrl !== path.join(tmp, 'local-only.png'),
    JSON.stringify({ path: x.calls.sendMedia[0] && x.calls.sendMedia[0].media.path }));
  const envExample = t.h.src(path.join(t.h.REPO_ROOT, '.env.example'));
  t.check('22 env example documents OpenWA delivery by provider selection (no gate var)',
    envExample.indexOf('WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED') < 0 && /WHATSAPP_PROVIDER=openwa/.test(envExample));
  const readme = t.h.src(path.join(t.h.REPO_ROOT, 'README.md'));
  t.check('23 README documents OpenWA delivery by provider selection (no gate var)',
    /WHATSAPP_PROVIDER=openwa/.test(readme) && /provider selection/i.test(readme) &&
    readme.indexOf('WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED') < 0);
  fs.rmSync(tmp, { recursive: true, force: true });
  await x.teardown();
  const c = t.counters();
  console.log('Phase 7.2c assertions done failed: ' + c.F);
  if (c.F > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });
