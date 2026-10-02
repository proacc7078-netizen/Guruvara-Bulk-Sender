/**
 * Regression: "Delete Selected" (bulk delete) on Recipients / Messages /
 * Campaigns must behave exactly like the single-item delete.
 *
 *   - no confirm      -> the existing dependency guard still refuses the item
 *                        and reports it per record; nothing is destroyed
 *   - confirm=true    -> the same explicit, opt-in permanent (force) delete that
 *                        DELETE /api/<resource>/:id?confirm=true uses
 *   - any other value -> no unlock ("1", "TRUE", "yes", "", ...)
 *
 * Safety: throwaway SQLite database in os.tmpdir() created with
 * `prisma db push --skip-generate`. The development database is never opened.
 * The controllers under test only touch their own tables: no WhatsApp / OpenWA /
 * Meta call is made and no scheduler / delivery worker is started.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO_ROOT = __dirname;

// Point DATABASE_URL at a disposable file BEFORE anything from the app is
// required. dotenv below only fills the remaining defaults (it never overrides
// an already-set variable), so this database is the one that stays in effect.
const DB_PATH = path.join(
  os.tmpdir(),
  'bulkdel-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.db'
);
process.env.DATABASE_URL = 'file:' + DB_PATH.replace(/\\/g, '/');
process.env.WHATSAPP_PROVIDER = process.env.WHATSAPP_PROVIDER || 'none';
process.env.SCHEDULER_POLL_INTERVAL_MS = '999900';
process.env.WORKER_POLL_INTERVAL_MS = '999900';
require('dotenv').config({ path: path.join(REPO_ROOT, '.env') });

const { execSync } = require('child_process');
execSync('npx prisma db push --schema=prisma/schema.prisma --skip-generate', {
  cwd: REPO_ROOT,
  env: { ...process.env },
  stdio: 'pipe',
});

require('tsx/cjs');
const { prisma } = require('./apps/server/src/config/db');
const recipientsCtrl = require('./apps/server/src/controllers/recipients.controller');
const messagesCtrl = require('./apps/server/src/controllers/messages.controller');
const campaignsCtrl = require('./apps/server/src/controllers/campaigns.controller');

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra !== undefined ? ' | ' + String(extra) : ''));
}

const RUN = String(Date.now()).slice(-6);
let seq = 0;
const uniq = (prefix) => prefix + '_' + RUN + '_' + (++seq);

/** Minimal fake Express req/res, matching the shape the controllers read. */
function mockReq(overrides) {
  return Object.assign({ params: {}, query: {}, body: {}, ip: '127.0.0.1', session: {} }, overrides || {});
}
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

/* ------------------------------- fixtures ------------------------------- */
function mkMessage(label) {
  return prisma.message.create({
    data: { name: uniq('Msg' + label), body: 'Body ' + label + ' ' + RUN, status: 'READY' },
  });
}
function mkRecipient(label) {
  const n = ++seq;
  return prisma.recipient.create({
    data: {
      name: uniq('Rec' + label),
      whatsappNumber: '9190000' + String(n).padStart(4, '0'),
      normalizedPhone: 'PH' + RUN + String(n).padStart(4, '0'),
      source: 'TEST',
    },
  });
}
function mkCampaign(label, messageId, status) {
  return prisma.campaign.create({
    data: { name: uniq('Camp' + label), messageId: messageId || null, status: status || 'DRAFT' },
  });
}
function addMembership(campaignId, recipientId) {
  return prisma.campaignRecipient.create({ data: { campaignId, recipientId } });
}
async function mkExecution(campaignId, recipientId, status) {
  const execution = await prisma.campaignExecution.create({
    data: {
      campaignId,
      status,
      scheduledAt: new Date(),
      messageName: 'Snapshot name',
      messageBody: 'Snapshot body (immutable)',
    },
  });
  await prisma.campaignExecutionRecipient.create({
    data: {
      executionId: execution.id,
      recipientId,
      whatsappNumber: '919000000000',
      name: 'Snapshot recipient',
      status: status === 'PENDING' || status === 'RUNNING' ? 'PENDING' : 'DELIVERED',
    },
  });
  return execution;
}

const recipientExists = (id) => prisma.recipient.findUnique({ where: { id } }).then((r) => r !== null);
const messageExists = (id) => prisma.message.findUnique({ where: { id } }).then((m) => m !== null);
const campaignExists = (id) => prisma.campaign.findUnique({ where: { id } }).then((c) => c !== null);
const failedCodes = (res) => (((res.body || {}).data || {}).failed || []).map((f) => f.code);
const items = (res, field) => (((res.body || {}).data || {})[field]) || [];
const memberships = (recipientId) => prisma.campaignRecipient.count({ where: { recipientId } });

/* --------------------------- A. Recipients --------------------------- */
async function recipientTests() {
  console.log('\n--- A. Recipients bulk delete ---');

  const inCampaign = await mkRecipient('A1');
  const campaign = await mkCampaign('A1', null, 'READY');
  await addMembership(campaign.id, inCampaign.id);

  // A1-A3: no confirm -> identical guard to DELETE /api/recipients/:id
  let res = mockRes();
  await recipientsCtrl.bulkDeleteRecipients(mockReq({ body: { ids: [inCampaign.id] } }), res);
  check('A1. Recipient in a campaign without confirm is reported, not deleted',
    res.statusCode === 200 && items(res, 'deleted').length === 0 && items(res, 'failed').length === 1,
    'status=' + res.statusCode + ' deleted=' + items(res, 'deleted').length);
  check('A2. Failure code is RECIPIENT_IN_CAMPAIGN',
    failedCodes(res)[0] === 'RECIPIENT_IN_CAMPAIGN', failedCodes(res).join(','));
  check('A3. Recipient + membership survive the refused delete',
    (await recipientExists(inCampaign.id)) && (await memberships(inCampaign.id)) === 1);

  // A4: only the exact string "true" may unlock the destructive path
  for (const bad of ['1', 'yes', 'TRUE', 'True', 'false', '']) {
    const badRes = mockRes();
    await recipientsCtrl.bulkDeleteRecipients(
      mockReq({ query: { confirm: bad }, body: { ids: [inCampaign.id] } }),
      badRes
    );
    check('A4. confirm=' + JSON.stringify(bad) + ' does not unlock the permanent delete',
      failedCodes(badRes)[0] === 'RECIPIENT_IN_CAMPAIGN', failedCodes(badRes).join(','));
  }
  check('A5. Recipient still intact after every rejected confirm value', await recipientExists(inCampaign.id));

  // A6: confirm=true via query -> permanent delete (same as the single-row path)
  res = mockRes();
  await recipientsCtrl.bulkDeleteRecipients(mockReq({ query: { confirm: 'true' }, body: { ids: [inCampaign.id] } }), res);
  check('A6. confirm=true deletes the recipient and reports it as deleted',
    res.statusCode === 200 && items(res, 'deleted').includes(inCampaign.id) && items(res, 'failed').length === 0,
    'deleted=' + JSON.stringify(items(res, 'deleted')));
  check('A7. Campaign membership removed', (await memberships(inCampaign.id)) === 0);
  check('A8. Recipient removed', (await recipientExists(inCampaign.id)) === false);
  check('A9. Campaign itself survives', await campaignExists(campaign.id));

  // A10: confirm=true in the request body works too (what the UI posts)
  const bodyConfirm = await mkRecipient('A10');
  const bodyCampaign = await mkCampaign('A10', null, 'READY');
  await addMembership(bodyCampaign.id, bodyConfirm.id);
  res = mockRes();
  await recipientsCtrl.bulkDeleteRecipients(
    mockReq({ body: { ids: [bodyConfirm.id], confirm: 'true' } }),
    res
  );
  check('A10. confirm:"true" in the body also unlocks the permanent delete',
    items(res, 'deleted').includes(bodyConfirm.id) && (await recipientExists(bodyConfirm.id)) === false);

  // A11-A12: a live delivery still wins over confirm (nothing is modified)
  const inFlight = await mkRecipient('A11');
  const inFlightCampaign = await mkCampaign('A11', null, 'READY');
  await addMembership(inFlightCampaign.id, inFlight.id);
  await mkExecution(inFlightCampaign.id, inFlight.id, 'RUNNING');
  res = mockRes();
  await recipientsCtrl.bulkDeleteRecipients(mockReq({ query: { confirm: 'true' }, body: { ids: [inFlight.id] } }), res);
  check('A11. PENDING/RUNNING delivery refuses the delete even with confirm=true',
    failedCodes(res)[0] === 'RECIPIENT_DELIVERY_IN_PROGRESS', failedCodes(res).join(','));
  check('A12. Nothing was removed for the refused recipient',
    (await recipientExists(inFlight.id)) &&
    (await memberships(inFlight.id)) === 1 &&
    (await prisma.campaignExecutionRecipient.count({ where: { recipientId: inFlight.id } })) === 1);

  // A13-A14: delivered history is deleted with the recipient, free ones still go
  const delivered = await mkRecipient('A13');
  const deliveredCampaign = await mkCampaign('A13', null, 'READY');
  await addMembership(deliveredCampaign.id, delivered.id);
  await mkExecution(deliveredCampaign.id, delivered.id, 'COMPLETED');
  res = mockRes();
  await recipientsCtrl.bulkDeleteRecipients(mockReq({ query: { confirm: 'true' }, body: { ids: [delivered.id] } }), res);
  check('A13. confirm=true also removes this recipient delivery history rows',
    items(res, 'deleted').includes(delivered.id) &&
    (await prisma.campaignExecutionRecipient.count({ where: { recipientId: delivered.id } })) === 0);

  const free = await mkRecipient('A14');
  res = mockRes();
  await recipientsCtrl.bulkDeleteRecipients(mockReq({ body: { ids: [free.id] } }), res);
  check('A14. Unreferenced recipient still deletes without confirm',
    items(res, 'deleted').includes(free.id) && (await recipientExists(free.id)) === false);

  // A15: mixed selection reports the partial outcome the UI renders
  const blocked = await mkRecipient('A15a');
  const blockedCampaign = await mkCampaign('A15a', null, 'READY');
  await addMembership(blockedCampaign.id, blocked.id);
  const deletable = await mkRecipient('A15b');
  res = mockRes();
  await recipientsCtrl.bulkDeleteRecipients(mockReq({ body: { ids: [blocked.id, deletable.id] } }), res);
  check('A15. Mixed selection -> one deleted, one reported, partial=true',
    (res.body || {}).data.partial === true &&
    items(res, 'deleted').includes(deletable.id) &&
    failedCodes(res)[0] === 'RECIPIENT_IN_CAMPAIGN');
}

/* ---------------------------- B. Messages ---------------------------- */
async function messageTests() {
  console.log('\n--- B. Messages bulk delete ---');

  const linked = await mkMessage('B1');
  const campaign = await mkCampaign('B1', linked.id, 'READY');
  const audience = await mkRecipient('B1');
  const execution = await mkExecution(campaign.id, audience.id, 'COMPLETED');

  // B1-B3: no confirm -> MESSAGE_IN_CAMPAIGN, message and link untouched
  let res = mockRes();
  await messagesCtrl.bulkDeleteMessages(mockReq({ body: { ids: [linked.id] } }), res);
  check('B1. Message used by a live campaign without confirm is reported, not deleted',
    res.statusCode === 200 && items(res, 'succeeded').length === 0 && items(res, 'failed').length === 1,
    'status=' + res.statusCode);
  check('B2. Failure code is MESSAGE_IN_CAMPAIGN',
    failedCodes(res)[0] === 'MESSAGE_IN_CAMPAIGN', failedCodes(res).join(','));
  check('B3. Message + campaign.messageId survive the refused delete',
    (await messageExists(linked.id)) === true &&
    ((await prisma.campaign.findUnique({ where: { id: campaign.id } })) || {}).messageId === linked.id);

  for (const bad of ['1', 'TRUE', 'yes', '']) {
    const badRes = mockRes();
    await messagesCtrl.bulkDeleteMessages(mockReq({ query: { confirm: bad }, body: { ids: [linked.id] } }), badRes);
    check('B4. confirm=' + JSON.stringify(bad) + ' does not unlock the permanent delete',
      failedCodes(badRes)[0] === 'MESSAGE_IN_CAMPAIGN', failedCodes(badRes).join(','));
  }

  // B5-B8: confirm=true -> force delete; campaign survives detached, history kept
  res = mockRes();
  await messagesCtrl.bulkDeleteMessages(mockReq({ query: { confirm: 'true' }, body: { ids: [linked.id] } }), res);
  check('B5. confirm=true deletes the message',
    items(res, 'succeeded').includes(linked.id) && (await messageExists(linked.id)) === false,
    'succeeded=' + JSON.stringify(items(res, 'succeeded')));
  const detached = await prisma.campaign.findUnique({ where: { id: campaign.id } });
  check('B6. Live campaign survives with messageId cleared',
    detached !== null && detached.messageId === null, 'messageId=' + (detached && detached.messageId));
  const keptExecution = await prisma.campaignExecution.findUnique({ where: { id: execution.id } });
  check('B7. Execution snapshot is preserved (history survives)',
    keptExecution !== null && keptExecution.messageBody === 'Snapshot body (immutable)');
  check('B8. Execution recipient history is preserved',
    (await prisma.campaignExecutionRecipient.count({ where: { executionId: execution.id } })) === 1);

  // B9: confirm in the body (what the UI posts)
  const bodyMessage = await mkMessage('B9');
  const bodyCampaign = await mkCampaign('B9', bodyMessage.id, 'READY');
  res = mockRes();
  await messagesCtrl.bulkDeleteMessages(mockReq({ body: { ids: [bodyMessage.id], confirm: 'true' } }), res);
  check('B9. confirm:"true" in the body also unlocks the permanent delete',
    items(res, 'succeeded').includes(bodyMessage.id) && (await messageExists(bodyMessage.id)) === false);

  // B10: ARCHIVE mode ignores confirm entirely (archive, never destroy)
  const archiveMe = await mkMessage('B10');
  const archiveCampaign = await mkCampaign('B10', archiveMe.id, 'READY');
  res = mockRes();
  await messagesCtrl.bulkArchiveMessages(mockReq({ query: { confirm: 'true' }, body: { ids: [archiveMe.id] } }), res);
  const archived = await prisma.message.findUnique({ where: { id: archiveMe.id } });
  check('B10. Bulk archive with confirm=true still only archives',
    archived !== null && archived.status === 'ARCHIVED' &&
    ((await prisma.campaign.findUnique({ where: { id: archiveCampaign.id } })) || {}).messageId === archiveMe.id,
    'status=' + (archived && archived.status));

  // B11: unreferenced message still deletes without confirm
  const freeMessage = await mkMessage('B11');
  res = mockRes();
  await messagesCtrl.bulkDeleteMessages(mockReq({ body: { ids: [freeMessage.id] } }), res);
  check('B11. Unreferenced message still deletes without confirm',
    items(res, 'succeeded').includes(freeMessage.id) && (await messageExists(freeMessage.id)) === false);
}

/* ---------------------------- C. Campaigns ---------------------------- */
async function campaignTests() {
  console.log('\n--- C. Campaigns bulk delete ---');

  const message = await mkMessage('C1');
  const audience = await mkRecipient('C1');
  const campaign = await mkCampaign('C1', message.id, 'READY');
  await addMembership(campaign.id, audience.id);
  const execution = await mkExecution(campaign.id, audience.id, 'COMPLETED');

  // C1-C3: no confirm -> CAMPAIGN_HAS_EXECUTION_HISTORY, history untouched
  let res = mockRes();
  await campaignsCtrl.bulkDeleteCampaigns(mockReq({ body: { ids: [campaign.id] } }), res);
  check('C1. Campaign with execution history without confirm is reported, not deleted',
    res.statusCode === 200 && items(res, 'succeeded').length === 0 && items(res, 'failed').length === 1,
    'status=' + res.statusCode);
  check('C2. Failure code is CAMPAIGN_HAS_EXECUTION_HISTORY',
    failedCodes(res)[0] === 'CAMPAIGN_HAS_EXECUTION_HISTORY', failedCodes(res).join(','));
  check('C3. Campaign + execution history survive the refused delete',
    (await campaignExists(campaign.id)) &&
    (await prisma.campaignExecution.count({ where: { campaignId: campaign.id } })) === 1);

  for (const bad of ['1', 'TRUE', 'yes', '']) {
    const badRes = mockRes();
    await campaignsCtrl.bulkDeleteCampaigns(mockReq({ query: { confirm: bad }, body: { ids: [campaign.id] } }), badRes);
    check('C4. confirm=' + JSON.stringify(bad) + ' does not unlock the permanent delete',
      failedCodes(badRes)[0] === 'CAMPAIGN_HAS_EXECUTION_HISTORY', failedCodes(badRes).join(','));
  }

  // C5-C9: confirm=true -> force delete of campaign + its history only
  res = mockRes();
  await campaignsCtrl.bulkDeleteCampaigns(mockReq({ query: { confirm: 'true' }, body: { ids: [campaign.id] } }), res);
  check('C5. confirm=true deletes the campaign',
    items(res, 'succeeded').includes(campaign.id) && (await campaignExists(campaign.id)) === false,
    'succeeded=' + JSON.stringify(items(res, 'succeeded')));
  check('C6. Execution rows removed',
    (await prisma.campaignExecution.count({ where: { campaignId: campaign.id } })) === 0);
  check('C7. Execution recipient rows removed',
    (await prisma.campaignExecutionRecipient.count({ where: { executionId: execution.id } })) === 0);
  check('C8. Campaign audience rows removed',
    (await prisma.campaignRecipient.count({ where: { campaignId: campaign.id } })) === 0);
  check('C9. Message + recipient survive the campaign force delete',
    (await messageExists(message.id)) && (await recipientExists(audience.id)));

  // C10: campaign without execution history still deletes without confirm
  const plain = await mkCampaign('C10', null, 'DRAFT');
  res = mockRes();
  await campaignsCtrl.bulkDeleteCampaigns(mockReq({ body: { ids: [plain.id] } }), res);
  check('C10. Campaign without execution history still deletes without confirm',
    items(res, 'succeeded').includes(plain.id) && (await campaignExists(plain.id)) === false);

  // C11: confirm in the body (what the UI posts)
  const viaBody = await mkCampaign('C11', null, 'READY');
  const historyRecipient = await mkRecipient('C11');
  await mkExecution(viaBody.id, historyRecipient.id, 'COMPLETED');
  res = mockRes();
  await campaignsCtrl.bulkDeleteCampaigns(mockReq({ body: { ids: [viaBody.id], confirm: 'true' } }), res);
  check('C11. confirm:"true" in the body also unlocks the permanent delete',
    items(res, 'succeeded').includes(viaBody.id) && (await campaignExists(viaBody.id)) === false);

  // C12: ARCHIVE mode ignores confirm entirely
  const archiveMe = await mkCampaign('C12', null, 'READY');
  await mkExecution(archiveMe.id, historyRecipient.id, 'COMPLETED');
  res = mockRes();
  await campaignsCtrl.bulkArchiveCampaigns(mockReq({ query: { confirm: 'true' }, body: { ids: [archiveMe.id] } }), res);
  const archived = await prisma.campaign.findUnique({ where: { id: archiveMe.id } });
  check('C12. Bulk archive with confirm=true still only archives',
    archived !== null && archived.status === 'ARCHIVED' &&
    (await prisma.campaignExecution.count({ where: { campaignId: archiveMe.id } })) === 1,
    'status=' + (archived && archived.status));
}

/* ------------------------ D. Frontend wiring ------------------------ */
const readSource = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

function frontendWiringTests() {
  console.log('\n--- D. Frontend wiring ---');
  const bar = readSource('apps/web/src/components/BulkActionsBar.tsx');
  check('D1. BulkActionsBar exposes an explicit permanent-delete handler', /onDeletePermanent\?:/.test(bar));
  check('D2. BulkActionsBar has a dedicated permanent confirmation state',
    bar.includes("confirming === 'permanent'"));
  check('D3. The escalation button is gated by the dependency failure codes',
    bar.includes('RECIPIENT_IN_CAMPAIGN') && bar.includes('MESSAGE_IN_CAMPAIGN') &&
    bar.includes('CAMPAIGN_HAS_EXECUTION_HISTORY'));
  check('D4. The per-page warning text prop is rendered', /permanentDeleteWarning/.test(bar));

  const pages = [
    ['Recipients', 'apps/web/src/pages/Recipients.tsx', 'bulkDeleteRecipients(true)'],
    ['Messages', 'apps/web/src/pages/Messages.tsx', "runBulk('/api/messages/bulk-delete', true)"],
    ['Campaigns', 'apps/web/src/pages/Campaigns.tsx', "runBulk('/api/campaigns/bulk-delete', true)"],
  ];
  for (const [name, rel, confirmedCall] of pages) {
    const page = readSource(rel);
    check('D5. ' + name + ' page wires onDeletePermanent to the confirmed call',
      page.includes('onDeletePermanent=') && page.includes(confirmedCall), confirmedCall);
    check('D6. ' + name + ' page sends confirm=true as query parameter and body flag',
      page.includes('confirm=true') && page.includes("confirm: 'true'"));
    check('D7. ' + name + ' page supplies an explicit permanent-delete warning',
      /permanentDeleteWarning="/.test(page));
  }
}

/* --------------------------------- main --------------------------------- */
async function main() {
  console.log('=== Bulk delete confirm=true regression ===');
  console.log('DB =', process.env.DATABASE_URL);

  await recipientTests();
  await messageTests();
  await campaignTests();
  frontendWiringTests();

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error('Unexpected test error:', error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    try { await prisma.$disconnect(); } catch { /* already closed */ }
    // Disposable database: always removed, whatever happened above.
    try { fs.unlinkSync(DB_PATH); } catch { /* already gone */ }
  }
})();
