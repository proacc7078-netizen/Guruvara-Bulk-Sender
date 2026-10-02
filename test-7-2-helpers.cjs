/* Phase 7.2b helpers: shared throwaway-DB delivery harness. Mocked only. */
const h = require('./test-5-3-helpers.cjs');
const path = require('path');
const fs = require('fs');
const os = require('os');
let C = 0; let F = 0;
function check(n, c, e) { C++; if (!c) F++; console.log((c ? 'PASS' : 'FAIL') + ': ' + n + (e ? ' | ' + e : '')); }
const SAVED = { G: process.env.WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED, D: process.env.DATABASE_URL };
async function setup() {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network disabled in Phase 7.2 tests'); };
  process.env.WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED = 'false';
  const dbPath = path.join(os.tmpdir(), 'exec72x-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.db');
  process.env.DATABASE_URL = 'file:' + dbPath;
  const { execSync } = require('child_process');
  execSync('npx prisma db push --schema=prisma/schema.prisma --skip-generate', { cwd: h.REPO_ROOT, env: { ...process.env }, stdio: 'pipe' });
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: 'file:' + dbPath } } });
  const dbMod = h.fresh('config/db.js');
  const svcMod = h.fresh('services/executionDelivery.service.js');
  const providerDist = require(path.join(h.REPO_ROOT, 'apps/server/dist/services/whatsapp/WhatsAppAdapter.js'));
  const origGetAdapter = providerDist.whatsappProviderRegistry.getAdapter;
  const calls = { sendText: [], sendMedia: [] };
  function mockAdapter(over) {
    const inst = Object.assign({
      getStatus: async () => 'DISCONNECTED', connect: async () => {}, disconnect: async () => {},
      sendText: async (to, msg) => { calls.sendText.push({ to, msg }); return { success: true, providerMessageId: 'true_1@c.us_MOCK1' }; },
      sendMedia: async (to, media, caption) => { calls.sendMedia.push({ to, media, caption }); return { success: true, providerMessageId: 'true_1@c.us_MOCKIMG' }; },
      getMessageStatus: async () => 'UNKNOWN',
    }, over || {});
    Object.defineProperty(inst, 'constructor', { value: { name: 'OpenWAWhatsAppAdapter' }, configurable: true });
    return inst;
  }
  async function seedExecution(mediaPath, body) {
    const camp = await prisma.campaign.create({ data: { name: 'C72x ' + Math.random() } });
    const exec = await prisma.campaignExecution.create({ data: { campaignId: camp.id, status: 'RUNNING', scheduledAt: new Date(), startedAt: new Date(), messageBody: body, mediaId: mediaPath ? 'm1' : null, mediaPath: mediaPath || null } });
    const recip = await prisma.recipient.create({ data: { name: 'R72', whatsappNumber: '+1555000100', normalizedPhone: '1555000' + Date.now() + Math.floor(Math.random() * 99999), status: 'ACTIVE', source: 'MANUAL', consentStatus: 'GRANTED' } });
    await prisma.campaignExecutionRecipient.create({ data: { executionId: exec.id, recipientId: recip.id, whatsappNumber: recip.whatsappNumber, name: recip.name, status: 'PENDING' } });
    return { exec, recip };
  }
  const idOf = (e, r) => e.id + ':' + r.id;
  async function row(e, r) { return prisma.campaignExecutionRecipient.findUnique({ where: { executionId_recipientId: { executionId: e.id, recipientId: r.id } } }); }
  async function teardown() {
    providerDist.whatsappProviderRegistry.getAdapter = origGetAdapter;
    globalThis.fetch = origFetch;
    await prisma.$disconnect();
    try { await dbMod.prisma.$disconnect(); } catch {}
    try { fs.unlinkSync(dbPath); } catch {}
    try { fs.unlinkSync(dbPath + '-journal'); } catch {}
    if (SAVED.G === undefined) delete process.env.WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED; else process.env.WHATSAPP_OPENWA_CAMPAIGN_SENDING_ENABLED = SAVED.G;
    if (SAVED.D === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = SAVED.D;
  }
  return { calls, mockAdapter, seedExecution, idOf, row, svcMod, providerDist, teardown };
}
module.exports = { h, path, fs, os, check, counters: () => ({ C, F }), bumpFail: () => { F++; }, setup, SAVED };
