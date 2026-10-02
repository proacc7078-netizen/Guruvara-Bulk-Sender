/**
 * Regression: single-message DELETE must enforce the same campaign-reference
 * rule as the bulk delete (MESSAGE_IN_CAMPAIGN).
 *
 * Defect: bulk delete counted non-ARCHIVED campaigns and refused, but the
 * single-row DELETE deleted unconditionally and let the schema's
 * onDelete: SetNull null campaign.messageId, so the row trash icon bypassed the
 * protection.
 *
 * Uses a DISPOSABLE database supplied by the runner (DATABASE_URL). The real
 * japa.db is never opened. No WhatsApp / OpenWA / Meta call is made: the
 * controllers under test only touch the message and campaign tables.
 */
const path = require('path');
process.env.WHATSAPP_PROVIDER = 'none';
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900';
process.env.WORKER_POLL_INTERVAL_MS = '999900';
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('tsx/cjs');

const { prisma } = require('./apps/server/src/config/db');
const ctrl = require('./apps/server/src/controllers/messages.controller');

let checks = 0, failures = 0;
function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra !== undefined ? ' | ' + String(extra) : ''));
}

const RUN = String(Date.now()).slice(-6);
let seq = 0;
const uniq = (p) => p + '_' + RUN + '_' + (++seq);

/** Minimal fake Express req/res. */
function mkRes() {
  const r = { statusCode: 200, body: null };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const throwNext = (e) => { throw e; };
const mkMessage = () => prisma.message.create({ data: { name: uniq('Msg'), body: uniq('Body'), status: 'READY' } });
const mkCampaign = (messageId, status) => prisma.campaign.create({ data: { name: uniq('Camp'), messageId, status } });
const stillThere = (id) => prisma.message.findUnique({ where: { id } }).then((m) => m !== null);

async function main() {
  console.log('=== Single-message delete guard regression ===\n');
  console.log('DB =', process.env.DATABASE_URL);

  console.log('\n--- A. READY campaign blocks single delete ---');
  {
    const m = await mkMessage();
    const c = await mkCampaign(m.id, 'READY');
    const res = mkRes();
    await ctrl.deleteMessage({ params: { id: m.id } }, res, throwNext);
    check('A. READY campaign -> 409', res.statusCode === 409, 'status=' + res.statusCode);
    check('A1. code MESSAGE_IN_CAMPAIGN', res.body?.error?.code === 'MESSAGE_IN_CAMPAIGN', res.body?.error?.code);
    check('A2. message text says 1 active campaign', /used by 1 active campaign\./.test(res.body?.error?.message || ''), res.body?.error?.message);
    check('A3. message still exists', await stillThere(m.id));
    const after = await prisma.campaign.findUnique({ where: { id: c.id }, select: { messageId: true } });
    check('A4. campaign.messageId NOT nulled', after?.messageId === m.id, after?.messageId);
  }

  console.log('\n--- B. DRAFT campaign blocks single delete ---');
  {
    const m = await mkMessage();
    await mkCampaign(m.id, 'DRAFT');
    const res = mkRes();
    await ctrl.deleteMessage({ params: { id: m.id } }, res, throwNext);
    check('B. DRAFT -> 409 MESSAGE_IN_CAMPAIGN', res.statusCode === 409 && res.body?.error?.code === 'MESSAGE_IN_CAMPAIGN', res.statusCode + '/' + res.body?.error?.code);
    check('B1. message still exists', await stillThere(m.id));
  }

  console.log('\n--- C. SCHEDULED campaign blocks single delete ---');
  {
    const m = await mkMessage();
    const c = await mkCampaign(m.id, 'READY');
    await prisma.campaignSchedule.create({
      data: { campaignId: c.id, scheduledAt: new Date(Date.now() + 86400000), timezone: 'Asia/Kolkata', status: 'SCHEDULED' },
    });
    const sched = await prisma.campaignSchedule.findUnique({ where: { campaignId: c.id }, select: { status: true } });
    check('C0. campaign is READY with a SCHEDULED schedule', sched?.status === 'SCHEDULED', sched?.status);
    const res = mkRes();
    await ctrl.deleteMessage({ params: { id: m.id } }, res, throwNext);
    check('C. SCHEDULED -> 409 MESSAGE_IN_CAMPAIGN', res.statusCode === 409 && res.body?.error?.code === 'MESSAGE_IN_CAMPAIGN', res.statusCode + '/' + res.body?.error?.code);
    check('C1. message still exists', await stillThere(m.id));
    const surv = await prisma.campaignSchedule.findUnique({ where: { campaignId: c.id }, select: { status: true } });
    check('C2. schedule untouched', surv?.status === 'SCHEDULED', surv?.status);
  }

  console.log('\n--- D. ARCHIVED campaign does NOT block (even with execution history) ---');
  {
    const m = await mkMessage();
    const c = await mkCampaign(m.id, 'ARCHIVED');
    const exec = await prisma.campaignExecution.create({
      data: { campaignId: c.id, status: 'COMPLETED', scheduledAt: new Date(), messageBody: 'snapshot body' },
    });
    const res = mkRes();
    await ctrl.deleteMessage({ params: { id: m.id } }, res, throwNext);
    check('D. ARCHIVED (+exec history) -> delete allowed', res.statusCode === 200 && res.body?.success === true, res.statusCode + ' ' + JSON.stringify(res.body));
    check('D1. message is gone', (await prisma.message.findUnique({ where: { id: m.id } })) === null);
    const snap = await prisma.campaignExecution.findUnique({ where: { id: exec.id }, select: { messageBody: true, campaignId: true } });
    check('D2. execution snapshot body untouched', snap?.messageBody === 'snapshot body', snap?.messageBody);
    check('D3. execution still attached to its campaign', snap?.campaignId === c.id);
  }

  console.log('\n--- E. no campaign -> delete allowed ---');
  {
    const m = await mkMessage();
    const res = mkRes();
    await ctrl.deleteMessage({ params: { id: m.id } }, res, throwNext);
    check('E. No campaign -> delete allowed', res.statusCode === 200 && res.body?.success === true, res.statusCode);
    check('E1. message is gone', (await prisma.message.findUnique({ where: { id: m.id } })) === null);
  }

  console.log('\n--- F. bulk delete behaviour unchanged ---');
  {
    const blocked = await mkMessage();
    await mkCampaign(blocked.id, 'READY');
    const free = await mkMessage();
    const archivedOnly = await mkMessage();
    await mkCampaign(archivedOnly.id, 'ARCHIVED');
    const res = mkRes();
    await ctrl.bulkDeleteMessages({ body: { ids: [blocked.id, free.id, archivedOnly.id] } }, res, throwNext);
    const d = res.body?.data;
    check('F. bulk refuses blocked message with MESSAGE_IN_CAMPAIGN',
      !!d?.failed?.some((f) => f.id === blocked.id && f.code === 'MESSAGE_IN_CAMPAIGN'), JSON.stringify(d?.failed));
    check('F1. bulk deletes unused message', !!d?.succeeded?.includes(free.id));
    check('F2. bulk deletes archived-only message', !!d?.succeeded?.includes(archivedOnly.id));
    check('F3. partial flag set', d?.partial === true, 'partial=' + d?.partial);
    check('F4. refused message survives', await stillThere(blocked.id));
  }

  console.log('\n--- G. single and bulk error semantics are identical ---');
  {
    const m = await mkMessage();
    await mkCampaign(m.id, 'READY');
    const single = mkRes();
    await ctrl.deleteMessage({ params: { id: m.id } }, single, throwNext);
    const bulk = mkRes();
    await ctrl.bulkDeleteMessages({ body: { ids: [m.id] } }, bulk, throwNext);
    const b = bulk.body?.data?.failed?.[0];
    check('G. identical error message text', single.body?.error?.message === b?.message, single.body?.error?.message);
    check('G1. identical error code', single.body?.error?.code === b?.code, single.body?.error?.code);
  }

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error('Error:', e && e.stack ? e.stack : e); process.exitCode = 1; })
  .finally(async () => { try { await prisma.$disconnect(); } catch { } });
