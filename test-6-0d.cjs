/* Phase 6.0D — focused execution delivery media tests. Mocked adapter+real SQLite; no real sends. */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
let C = 0; let F = 0;
global.__check60d = function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); };
async function main() {
  console.log('=== Phase 6.0D execution delivery media ===');
  const check = global.__check60d;
  const dbPath = path.join(os.tmpdir(), 'exec60d-' + Date.now() + '.db');
  process.env.DATABASE_URL = 'file:' + dbPath;
  const { execSync } = require('child_process');
  execSync('npx prisma db push --schema=prisma/schema.prisma --skip-generate', { cwd: __dirname, env: { ...process.env }, stdio: 'pipe' });
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } } });

  const calls = { sendText: [], sendMedia: [] };
  const adapter = {
    getStatus: async () => 'DISCONNECTED',
    connect: async () => {},
    disconnect: async () => {},
    sendText: async (to, msg) => { calls.sendText.push({ to, msg }); return { success: true, providerMessageId: 'wamid.TXT' }; },
    sendMedia: async (to, media, caption) => { calls.sendMedia.push({ to, media, caption }); return { success: true, providerMessageId: 'wamid.IMG' }; },
    getMessageStatus: async () => 'UNKNOWN',
  };
  const svcMod = h.fresh('services/executionDelivery.service.js');
  // Plain require (NOT h.fresh) so we patch the SAME cached module instance
  // that executionDelivery.service.js already bound to.
  const providerMod = require('./apps/server/dist/services/whatsapp/WhatsAppAdapter.js');
  const origGetAdapter = providerMod.whatsappProviderRegistry.getAdapter;
  providerMod.whatsappProviderRegistry.getAdapter = () => adapter;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'exec60d-'));
  const imgPath = path.join(tmp, 'shot.png');
  fs.writeFileSync(imgPath, Buffer.from([0x89, 0x50]));
  async function seedExecution(mediaPath, body) {
    const camp = await prisma.campaign.create({ data: { name: 'C60D ' + Math.random() } });
    const exec = await prisma.campaignExecution.create({ data: { campaignId: camp.id, status: 'RUNNING', scheduledAt: new Date(), startedAt: new Date(), messageBody: body, mediaId: mediaPath ? 'm1' : null, mediaPath: mediaPath || null } });
    const recip = await prisma.recipient.create({ data: { name: 'R', whatsappNumber: '+1555000000' + Math.floor(Math.random() * 9), normalizedPhone: '91' + Date.now() + Math.floor(Math.random() * 99999), status: 'ACTIVE', source: 'MANUAL', consentStatus: 'GRANTED' } });
    await prisma.campaignExecutionRecipient.create({ data: { executionId: exec.id, recipientId: recip.id, whatsappNumber: recip.whatsappNumber, name: recip.name, status: 'PENDING' } });
    return { exec, recip };
  }
  const del = new svcMod.ExecutionDeliveryService();
  const idOf = (e, r) => e.id + ':' + r.id;

  // 1. text-only execution still uses sendText()
  const t1 = await seedExecution(null, 'text only body');
  const r1 = await del.sendExecutionRecipient(idOf(t1.exec, t1.recip));
  check('1 text exec uses sendText', calls.sendText.length === 1 && calls.sendMedia.length === 0 && r1.success === true && r1.providerMessageId === 'wamid.TXT', JSON.stringify(r1));
  check('2 text body passed as-is', calls.sendText[0].msg === 'text only body');

  // 3. image execution uses sendMedia with snapshot path + body as caption
  const t2 = await seedExecution(imgPath, 'caption from snapshot body');
  const r2 = await del.sendExecutionRecipient(idOf(t2.exec, t2.recip));
  check('3 image exec uses sendMedia', calls.sendMedia.length === 1 && calls.sendText.length === 1 && r2.success === true && r2.providerMessageId === 'wamid.IMG', JSON.stringify(r2));
  check('4 caption equals snapshot body', calls.sendMedia[0].caption === 'caption from snapshot body');
  check('5 execution media path used', calls.sendMedia[0].media.path === imgPath);
  check('6 mime inferred png', calls.sendMedia[0].media.mimeType === 'image/png');
  check('7 phone from snapshot', calls.sendMedia[0].to === t2.recip.whatsappNumber);

  await require('./test-6-0d-part2.cjs')({ check, del, idOf, seedExecution, calls, prisma, providerMod, adapter, imgPath });

  providerMod.whatsappProviderRegistry.getAdapter = origGetAdapter;
  await prisma.$disconnect();
  fs.rmSync(tmp, { recursive: true, force: true });
  try { fs.unlinkSync(dbPath); } catch {}
  console.log('6.0D Assertions: ' + C + ' failed: ' + F);
  if (F > 0) process.exitCode = 1;
}
main().catch((e) => { console.error(e.stack || e); process.exitCode = 1; });