/**
 * Phase 5.12 pre-work — targeted orphan test-recipient cleanup.
 *
 * Context
 * -------
 * The Phase 5.11 report identified 60 orphaned synthetic test recipients that
 * were left behind by test-5-6 (and the earlier Phase 3.x walkthrough runs that
 * created rows in the same way). None of them has any CampaignRecipient,
 * CampaignExecutionRecipient or RecipientTag reference.
 *
 * What this script does
 * ---------------------
 * Removes ONLY recipients that match an explicit synthetic-test marker AND have
 * zero campaign/execution/tag references:
 *   1. name starts with "P56"                     (test-5-6 synthetic recipients)
 *   2. name matches /^Test Ravi \d+ [AB]$/        (test-5-6 synthetic recipients)
 *   3. normalizedPhone is one of the walkthrough  (Phase 3.x manual test records,
 *      919000011111 / 919000022222)               still unreferenced)
 *
 * What this script never does
 * ---------------------------
 * - No `prisma migrate reset`, no `prisma db reset`, no database deletion.
 * - No table drops, no `deleteMany({})` on any table.
 * - It never touches recipients that are referenced by a campaign, an execution
 *   or a tag, and it never touches recipients without a synthetic marker.
 *
 * Usage: node cleanup-orphan-test-recipients.cjs
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

/** Explicit synthetic markers. Anything that does not match stays untouched. */
const WALKTHROUGH_PHONES = ['919000011111', '919000022222'];
const TEST_RAVI_PATTERN = /^Test Ravi \d+ [AB]$/;

function classify(recipient) {
  if (typeof recipient.name === 'string' && recipient.name.startsWith('P56')) return 'P56';
  if (typeof recipient.name === 'string' && TEST_RAVI_PATTERN.test(recipient.name)) return 'TEST_RAVI';
  if (WALKTHROUGH_PHONES.includes(recipient.normalizedPhone)) return 'WALKTHROUGH';
  return null;
}

async function referenceCounts(recipientId) {
  const [campaignRecipients, executionRecipients, tags] = await Promise.all([
    prisma.campaignRecipient.count({ where: { recipientId } }),
    prisma.campaignExecutionRecipient.count({ where: { recipientId } }),
    prisma.recipientTag.count({ where: { recipientId } }),
  ]);
  return { campaignRecipients, executionRecipients, tags };
}

async function main() {
  const total = await prisma.recipient.count();
  const all = await prisma.recipient.findMany({
    select: { id: true, name: true, normalizedPhone: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  const candidates = [];
  const skippedReferenced = [];
  const skippedUnmatched = [];

  for (const recipient of all) {
    const marker = classify(recipient);
    if (!marker) {
      skippedUnmatched.push(recipient);
      continue;
    }
    const refs = await referenceCounts(recipient.id);
    if (refs.campaignRecipients || refs.executionRecipients || refs.tags) {
      skippedReferenced.push({ recipient, marker, refs });
      continue;
    }
    candidates.push({ recipient, marker });
  }

  console.log('recipients before cleanup: ' + total);
  console.log('synthetic orphans to remove: ' + candidates.length);
  for (const marker of ['P56', 'TEST_RAVI', 'WALKTHROUGH']) {
    const rows = candidates.filter((c) => c.marker === marker);
    console.log('  ' + marker.padEnd(12) + rows.length);
  }
  console.log('skipped (referenced by campaign/execution/tag): ' + skippedReferenced.length);
  for (const row of skippedReferenced) {
    console.log('  KEPT ' + row.recipient.name + ' refs=' + JSON.stringify(row.refs));
  }
  console.log('skipped (no synthetic marker): ' + skippedUnmatched.length);
  for (const row of skippedUnmatched) {
    console.log('  KEPT ' + row.name + ' [' + row.normalizedPhone + ']');
  }

  let removed = 0;
  for (const { recipient } of candidates) {
    // Targeted, single-row delete. Cascades (RecipientTag) cannot occur here
    // because referenced records were filtered out above.
    const result = await prisma.recipient.deleteMany({ where: { id: recipient.id } });
    removed += result.count;
  }
  console.log('recipients removed: ' + removed);

  const afterTotal = await prisma.recipient.count();
  const remainingP56 = await prisma.recipient.count({ where: { name: { startsWith: 'P56' } } });
  const remaining = await prisma.recipient.findMany({
    select: { name: true, normalizedPhone: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log('recipients after cleanup: ' + afterTotal);
  console.log('remaining P56* recipients: ' + remainingP56);
  console.log('remaining recipients: ' + JSON.stringify(remaining));

  const campaigns = await prisma.campaign.count();
  const schedules = await prisma.campaignSchedule.count();
  const executions = await prisma.campaignExecution.count();
  const executionRecipients = await prisma.campaignExecutionRecipient.count();
  const media = await prisma.media.count();
  const messages = await prisma.message.count();
  const users = await prisma.user.count();
  console.log(
    'preserved: campaigns=' + campaigns +
    ' schedules=' + schedules +
    ' executions=' + executions +
    ' executionRecipients=' + executionRecipients +
    ' media=' + media +
    ' messages=' + messages +
    ' users=' + users
  );

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error('Cleanup failed:', error && error.message ? error.message : error);
  try { await prisma.$disconnect(); } catch { }
  process.exit(1);
});
