/**
 * Phase 4.3 — Campaign Review & Finalization Tests (REAL SUITE).
 *
 * Covers: readiness validation (server-authoritative), the finalize endpoint
 * (idempotent, atomic, single-field mutation), the review UI, READY -> DRAFT
 * invalidation on meaningful edits, later-phase safety boundaries, sequential
 * regression of the Phase 3 / 4.1 / 4.2 suites, and database safety.
 *
 * Run sequentially with the other suites — they share one SQLite database.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const dotenv = require('dotenv');
const argon2 = require('argon2');
const { spawnSync } = require('child_process');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma/schema.prisma');
const READINESS_UTIL_PATH = path.join(REPO_ROOT, 'apps/server/src/utils/campaignReadiness.util.ts');
const FINALIZE_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/campaignFinalize.controller.ts');
const CAMPAIGNS_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/campaigns.controller.ts');
const AUDIENCE_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/campaignAudience.controller.ts');
const CAMPAIGNS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/campaigns.routes.ts');
const MESSAGES_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/messages.controller.ts');
const MESSAGES_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/messages.routes.ts');
const MEDIA_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/media.controller.ts');
const MEDIA_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/media.routes.ts');
const RECIPIENTS_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/recipients.controller.ts');
const RECIPIENTS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/recipients.routes.ts');
const IMPORTS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/imports.routes.ts');
const SERVER_INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');
const APP_PATH = path.join(REPO_ROOT, 'apps/web/src/App.tsx');
const CAMPAIGN_EDITOR_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/CampaignEditor.tsx');
const CAMPAIGNS_PAGE_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/Campaigns.tsx');
const IMPORT_WIZARD_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/ImportWizard.tsx');
const MESSAGE_EDITOR_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/MessageEditor.tsx');

const TEST_PORT = 3148;
const BASE = 'http://127.0.0.1:' + TEST_PORT;
const STORAGE_DIR = path.join(REPO_ROOT, 'storage', 'uploads');

const RUN = String(Date.now()).slice(-6);
const phoneFor = (n) => '9' + RUN + String(n);

let checks = 0;
let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;
const createdCampaignIds = new Set();
const createdRecipientIds = new Set();
const createdMessageIds = new Set();
const createdMediaIds = new Set();
const createdTagIds = new Set();
const tempFilePaths = [];

function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function modelBlock(schema, modelName) {
  const match = schema.match(new RegExp('model ' + modelName + ' \\{[\\s\\S]*?\\n\\}'));
  return match ? match[0] : '';
}

function blockMatch(source, startPattern, endPattern) {
  const start = source.search(startPattern);
  if (start === -1) return '';
  const rest = source.slice(start);
  const end = rest.search(endPattern);
  return end === -1 ? rest : rest.slice(0, end);
}

// Latest-phase word scans run over executable code only, so explanatory
// comments that *name* a later phase cannot trip the boundary checks.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

const sameSet = (a, b) =>
  a.length === b.length && [...a].sort().join(',') === [...b].sort().join(',');

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return true;
    } catch { }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function request(method, url, body, cookie, contentType) {
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + url, { method, headers, body });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, json: parsed, text: raw, setCookie: res.headers.get('set-cookie') };
}

function getJson(url, cookie) { return request('GET', url, undefined, cookie); }
function postJson(url, body, cookie) { return request('POST', url, JSON.stringify(body), cookie, 'application/json'); }
function patchJson(url, body, cookie) { return request('PATCH', url, JSON.stringify(body), cookie, 'application/json'); }
function putJson(url, body, cookie) { return request('PUT', url, JSON.stringify(body), cookie, 'application/json'); }
function deleteJson(url, cookie) { return request('DELETE', url, undefined, cookie); }

// Multipart upload, same convention as the Phase 3 media suites.
async function uploadFile(filePath, cookie, messageId) {
  const fileContent = fs.readFileSync(filePath);
  const boundary = '----Boundary' + Date.now() + RUN;
  const fileName = path.basename(filePath);
  const mimeType = 'image/png';
  const prefix =
    (messageId
      ? `--${boundary}\r\nContent-Disposition: form-data; name="messageId"\r\n\r\n${messageId}\r\n`
      : '') +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${mimeType}\r\n\r\n`;
  const body = Buffer.concat([
    Buffer.from(prefix),
    fileContent,
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const headers = { 'Content-Type': `multipart/form-data; boundary=${boundary}` };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(BASE + '/api/media', { method: 'POST', headers, body });
  const raw = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  return { status: res.status, json: parsed, text: raw };
}

function createTestImage() {
  const filePath = path.join(os.tmpdir(), `phase43-img-${RUN}.png`);
  fs.writeFileSync(
    filePath,
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])
  );
  tempFilePaths.push(filePath);
  return filePath;
}

/**
 * Referential-integrity helpers.
 *
 * Prisma enforces the foreign keys, so a "dangling" reference can only be
 * simulated by briefly switching the SQLite pragma off on this connection. The
 * helpers report whether the simulation actually worked so the assertions can
 * stay honest: when the FK guard refuses the write, the data simply cannot
 * become inconsistent, which is also a valid outcome to verify.
 */
async function withForeignKeysOff(writeFn) {
  try {
    await prisma.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
    try {
      await writeFn();
      return true;
    } finally {
      await prisma.$executeRawUnsafe('PRAGMA foreign_keys = ON');
    }
  } catch {
    return false;
  }
}

const orphanRecipientId = () => 'phase43-orphan-recipient-' + RUN;
const orphanMessageId = () => 'phase43-orphan-message-' + RUN;

async function readiness(campaignId, cookie) {
  return getJson(`/api/campaigns/${campaignId}/readiness`, cookie);
}
async function finalize(campaignId, cookie) {
  return postJson(`/api/campaigns/${campaignId}/finalize`, {}, cookie);
}
async function campaignStatus(campaignId) {
  const row = await prisma.campaign.findUnique({ where: { id: campaignId }, select: { status: true } });
  return row ? row.status : null;
}
async function membershipCount(campaignId) {
  return prisma.campaignRecipient.count({ where: { campaignId } });
}
async function audienceIds(campaignId, cookie) {
  const res = await getJson(`/api/campaigns/${campaignId}/audience`, cookie);
  return (res.json && res.json.data ? res.json.data : []).map((r) => r.id).sort();
}

/* ------------------------------------------------------------------ *
 * Static contracts
 * ------------------------------------------------------------------ */
function staticContractTests() {
  console.log('\n--- Static contracts ---');
  const util = readSource(READINESS_UTIL_PATH);
  const finalizeController = readSource(FINALIZE_CONTROLLER_PATH);
  const routes = readSource(CAMPAIGNS_ROUTES_PATH);
  const index = readSource(SERVER_INDEX_PATH);

  check('S1. Readiness utility is reusable and returns { valid, issues }',
    /export\s+async\s+function\s+validateCampaignReadiness\s*\(\s*campaignId:\s*string\s*\)\s*:\s*Promise<CampaignReadiness>/.test(util) &&
    /valid:\s*boolean/.test(util) && /issues:\s*CampaignIssue\[\]/.test(util));

  check('S2. Every required readiness rule exists',
    ['NAME_REQUIRED', 'STATUS_INVALID', 'MESSAGE_REQUIRED', 'MESSAGE_NOT_FOUND',
      'MESSAGE_ARCHIVED', 'MESSAGE_EMPTY', 'AUDIENCE_EMPTY', 'AUDIENCE_RECIPIENT_MISSING']
      .every((code) => util.includes(code)),
    'codes checked=8');

  check('S3. Media is optional in the validator',
    !/if\s*\(\s*!\s*campaign\.message\.media\s*\)/.test(util) &&
    /MEDIA is optional/.test(util) && !util.includes('MEDIA_REQUIRED'));

  check('S4. Finalize + readiness routes are mounted behind requireAuth',
    routes.includes("router.get('/:id/readiness', getCampaignReadiness)") &&
    routes.includes("router.post('/:id/finalize', finalizeCampaign)") &&
    routes.includes('router.use(requireAuth)') &&
    /app\.use\('\/api\/campaigns', campaignsRoutes\)/.test(index));

  check('S5. Finalization only mutates the campaign status field',
    finalizeController.includes("data: { status: 'READY' }") &&
    !/prisma\.campaign\.create/.test(finalizeController) &&
    !/prisma\.recipient/.test(finalizeController) &&
    !/prisma\.message/.test(finalizeController) &&
    !/prisma\.media/.test(finalizeController) &&
    !/prisma\.campaignRecipient\.(create|delete|update)/.test(finalizeController));

  check('S6. Finalize keeps the readable CAMPAIGN_NOT_READY contract',
    finalizeController.includes('CAMPAIGN_NOT_READY') &&
    finalizeController.includes('Campaign is not ready') &&
    finalizeController.includes('issues,') &&
    finalizeController.includes('CAMPAIGN_ARCHIVED'));

  check('S7. Phase 4.1 / 4.2 campaign surface is untouched',
    readSource(CAMPAIGNS_CONTROLLER_PATH).includes('export const getCampaigns') &&
    readSource(CAMPAIGNS_CONTROLLER_PATH).includes('export const deleteCampaign') &&
    readSource(AUDIENCE_CONTROLLER_PATH).includes('export const updateCampaignAudience') &&
    readSource(AUDIENCE_CONTROLLER_PATH).includes('MAX_CAMPAIGN_RECIPIENTS = 5000'));
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */
const fixture = {
  campaign: null,
  campaignNoMessage: null,
  campaignNoAudience: null,
  emptyBodyMessage: null,
  archivedMessage: null,
  message: null,
  messageTwo: null,
  mediaId: null,
  mediaStoragePath: null,
  recipients: { A: null, B: null, C: null },
};

async function createFixtureRecipient(cookie, label, slot, status) {
  const res = await postJson('/api/recipients', {
    name: `Phase43 ${label} ${RUN}`,
    whatsappNumber: phoneFor(slot),
    language: 'Hindi',
    category: 'Phase4Test',
    status,
    source: 'MANUAL',
  }, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdRecipientIds.add(id);
  return id;
}

async function createFixtureMessage(cookie, label, body) {
  const res = await postJson('/api/messages', {
    name: `Phase43 ${label} ${RUN}`,
    body: body === undefined ? `Phase 4.3 body ${label} ${RUN}` : body,
    status: 'READY',
  }, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdMessageIds.add(id);
  return id;
}

async function createFixtureCampaign(cookie, label, messageId) {
  const res = await postJson('/api/campaigns', {
    name: `Phase43 ${label} ${RUN}`,
    ...(messageId ? { messageId } : {}),
  }, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdCampaignIds.add(id);
  return id;
}

async function createFixtures(cookie) {
  console.log('\n--- Fixtures ---');
  fixture.recipients.A = await createFixtureRecipient(cookie, 'Ravi', 2001, 'ACTIVE');
  fixture.recipients.B = await createFixtureRecipient(cookie, 'Anil', 2002, 'PAUSED');
  fixture.recipients.C = await createFixtureRecipient(cookie, 'Kiran', 2003, 'UNSUBSCRIBED');
  fixture.message = await createFixtureMessage(cookie, 'Message One');
  fixture.messageTwo = await createFixtureMessage(cookie, 'Message Two');
  fixture.archivedMessage = await createFixtureMessage(cookie, 'Archived Message');
  const archivedPatch = fixture.archivedMessage
    ? await patchJson(`/api/messages/${fixture.archivedMessage}`, { status: 'ARCHIVED' }, cookie)
    : { status: 0 };
  fixture.emptyBodyMessage = (await prisma.message.create({
    data: { name: `Phase43 Blank Body ${RUN}`, body: '   ', status: 'READY' },
  })).id;
  createdMessageIds.add(fixture.emptyBodyMessage);

  fixture.campaign = await createFixtureCampaign(cookie, 'Campaign One', fixture.message);
  fixture.campaignNoMessage = await createFixtureCampaign(cookie, 'Campaign No Message');
  fixture.campaignNoAudience = await createFixtureCampaign(cookie, 'Campaign No Audience', fixture.message);

  check('F1. Temporary recipients, messages and campaigns created',
    Object.values(fixture.recipients).every(Boolean) && !!fixture.message &&
    !!fixture.messageTwo && !!fixture.archivedMessage && !!fixture.emptyBodyMessage &&
    !!fixture.campaign && !!fixture.campaignNoMessage && !!fixture.campaignNoAudience,
    JSON.stringify(fixture.recipients));
  check('F2. Archived message fixture is really archived',
    archivedPatch.status === 200 && archivedPatch.json.data.status === 'ARCHIVED');
  check('F3. Blank-body message fixture is stored but blank',
    (await prisma.message.findUnique({ where: { id: fixture.emptyBodyMessage } })).body.trim() === '');
}

/* ------------------------------------------------------------------ *
 * Readiness validation (runtime)
 * ------------------------------------------------------------------ */
async function readinessTests(cookie) {
  console.log('\n--- Readiness validation ---');

  const noMessage = await readiness(fixture.campaignNoMessage, cookie);
  const noMessageCodes = ((noMessage.json.data || {}).issues || []).map((i) => i.code);
  check('1. Campaign with no message is not ready',
    noMessage.status === 200 && noMessage.json.data.valid === false &&
    noMessageCodes.includes('MESSAGE_REQUIRED'),
    'issues=' + noMessageCodes.join(','));
  check('1b. The same campaign is also missing an audience',
    noMessageCodes.includes('AUDIENCE_EMPTY'));

  const noAudience = await readiness(fixture.campaignNoAudience, cookie);
  const noAudienceCodes = ((noAudience.json.data || {}).issues || []).map((i) => i.code);
  check('2. Campaign with no audience is not ready',
    noAudience.status === 200 && noAudience.json.data.valid === false &&
    noAudienceCodes.includes('AUDIENCE_EMPTY'),
    'issues=' + noAudienceCodes.join(','));

  await putJson(`/api/campaigns/${fixture.campaign}/audience`, {
    recipientIds: [fixture.recipients.A, fixture.recipients.B],
  }, cookie);
  const valid = await readiness(fixture.campaign, cookie);
  check('3. Campaign with valid message + audience is ready',
    valid.status === 200 && valid.json.data.valid === true &&
    valid.json.data.issues.length === 0 && valid.json.data.audienceCount === 2,
    'valid=' + (valid.json.data && valid.json.data.valid) +
    ' audienceCount=' + (valid.json.data && valid.json.data.audienceCount));

  check('11. Media is optional — the campaign is ready with no media at all',
    valid.json.data.valid === true &&
    (await prisma.media.count({ where: { messageId: fixture.message } })) === 0);

  const imagePath = createTestImage();
  const upload = await uploadFile(imagePath, cookie, fixture.message);
  fixture.mediaId = upload.json && upload.json.data && upload.json.data.id;
  fixture.mediaStoragePath = upload.json && upload.json.data && upload.json.data.storagePath;
  if (fixture.mediaId) createdMediaIds.add(fixture.mediaId);
  const withMedia = await readiness(fixture.campaign, cookie);
  check('12. Existing valid media does not block readiness',
    upload.status === 201 && withMedia.json.data.valid === true,
    'upload=' + upload.status);

  // 4 — blank message body
  const blankCampaign = await createFixtureCampaign(cookie, 'Blank Body Campaign', fixture.emptyBodyMessage);
  await putJson(`/api/campaigns/${blankCampaign}/audience`, { recipientIds: [fixture.recipients.A] }, cookie);
  const blank = await readiness(blankCampaign, cookie);
  check('4. Empty message body is not ready',
    blank.json.data.valid === false &&
    blank.json.data.issues.some((i) => i.code === 'MESSAGE_EMPTY'),
    'issues=' + JSON.stringify(blank.json.data.issues.map((i) => i.code)));

  // 5 — archived message
  const archivedCampaign = await createFixtureCampaign(cookie, 'Archived Message Campaign', fixture.archivedMessage);
  await putJson(`/api/campaigns/${archivedCampaign}/audience`, { recipientIds: [fixture.recipients.A] }, cookie);
  const archived = await readiness(archivedCampaign, cookie);
  check('5. Archived message is not ready',
    archived.json.data.valid === false &&
    archived.json.data.issues.some((i) => i.code === 'MESSAGE_ARCHIVED'));

  // 6 — missing message (association resolves to nothing)
  const missingCampaign = await createFixtureCampaign(cookie, 'Missing Message Campaign', fixture.messageTwo);
  await putJson(`/api/campaigns/${missingCampaign}/audience`, { recipientIds: [fixture.recipients.A] }, cookie);
  await prisma.message.delete({ where: { id: fixture.messageTwo } });
  createdMessageIds.delete(fixture.messageTwo);
  const afterDelete = await prisma.campaign.findUnique({
    where: { id: missingCampaign }, select: { messageId: true },
  });
  const missing = await readiness(missingCampaign, cookie);
  const orphanMessageWritten = await withForeignKeysOff(() => prisma.campaign.update({
    where: { id: missingCampaign }, data: { messageId: orphanMessageId() },
  }));
  const danglingMessage = await readiness(missingCampaign, cookie);
  check('6. Missing message is not ready',
    afterDelete.messageId === null && missing.json.data.valid === false &&
    missing.json.data.issues.some((i) => i.code === 'MESSAGE_REQUIRED') &&
    /MESSAGE_NOT_FOUND/.test(readSource(READINESS_UTIL_PATH)),
    'deleted message -> messageId=' + String(afterDelete.messageId));
  check('6b. A dangling message reference is reported as MESSAGE_NOT_FOUND, never a crash',
    orphanMessageWritten
      ? (danglingMessage.status === 200 && danglingMessage.json.data.valid === false &&
        danglingMessage.json.data.issues.some((i) => i.code === 'MESSAGE_NOT_FOUND'))
      : (danglingMessage.status === 200 && danglingMessage.json.data.valid === false &&
        /MESSAGE_NOT_FOUND/.test(readSource(READINESS_UTIL_PATH))),
    orphanMessageWritten ? 'simulated dangling messageId' : 'FK guard refused dangling messageId');

  // 9 — missing campaign
  check('9. Missing campaign returns 404',
    (await readiness('nonexistent-campaign-id', cookie)).status === 404 &&
    (await finalize('nonexistent-campaign-id', cookie)).status === 404);
}

/* ------------------------------------------------------------------ *
 * Inconsistent membership + finalize (runtime)
 * ------------------------------------------------------------------ */
async function consistencyTests(cookie) {
  console.log('\n--- Inconsistent audience data ---');
  const campaign = await createFixtureCampaign(cookie, 'Consistency Campaign', fixture.message);
  await putJson(`/api/campaigns/${campaign}/audience`, { recipientIds: [fixture.recipients.A] }, cookie);
  const orphanWritten = await withForeignKeysOff(() => prisma.campaignRecipient.create({
    data: { campaignId: campaign, recipientId: orphanRecipientId() },
  }));
  const result = await readiness(campaign, cookie);
  const codes = ((result.json.data || {}).issues || []).map((i) => i.code);
  check('10. Missing/inconsistent recipient membership is not considered ready',
    orphanWritten
      ? (result.status === 200 && result.json.data.valid === false &&
        codes.includes('AUDIENCE_RECIPIENT_MISSING'))
      : (result.status === 200 && result.json.data.valid === true &&
        (await prisma.campaignRecipient.count({
          where: { campaignId: campaign, recipientId: orphanRecipientId() },
        })) === 0 &&
        /AUDIENCE_RECIPIENT_MISSING/.test(readSource(READINESS_UTIL_PATH))),
    orphanWritten
      ? 'simulated dangling membership | issues=' + codes.join(',')
      : 'FK guard refused the dangling membership row');
  await prisma.campaignRecipient.deleteMany({ where: { recipientId: orphanRecipientId() } });
}

async function finalizeTests(cookie) {
  console.log('\n--- Finalize ---');

  check('13. Unauthenticated finalize -> 401',
    (await postJson(`/api/campaigns/${fixture.campaign}/finalize`, {}, null)).status === 401 &&
    (await getJson(`/api/campaigns/${fixture.campaign}/readiness`)).status === 401);

  const messageBefore = await prisma.message.findUnique({ where: { id: fixture.message } });
  const recipientsBefore = await prisma.recipient.findMany({
    where: { id: { in: [fixture.recipients.A, fixture.recipients.B] } },
    orderBy: { id: 'asc' },
  });
  const mediaBefore = await prisma.media.findMany({ where: { id: fixture.mediaId } });
  const campaignsBefore = await prisma.campaign.count();
  const membershipsBefore = await membershipCount(fixture.campaign);

  const first = await finalize(fixture.campaign, cookie);
  check('14. Valid campaign changes DRAFT -> READY',
    first.status === 200 && first.json.success === true &&
    first.json.data.campaign.status === 'READY' &&
    first.json.data.validation.valid === true &&
    first.json.data.validation.issues.length === 0 &&
    (await campaignStatus(fixture.campaign)) === 'READY',
    'status=' + (await campaignStatus(fixture.campaign)));

  check('17. Already READY campaign finalizes idempotently',
    (await finalize(fixture.campaign, cookie)).status === 200 &&
    (await campaignStatus(fixture.campaign)) === 'READY' &&
    (await prisma.campaign.count()) === campaignsBefore &&
    (await membershipCount(fixture.campaign)) === membershipsBefore);
  check('19. Finalization does not create audience duplicates',
    (await membershipCount(fixture.campaign)) === membershipsBefore &&
    (await prisma.campaignRecipient.count({ where: { campaignId: fixture.campaign } })) ===
    (await audienceIds(fixture.campaign, cookie)).length);

  const messageAfter = await prisma.message.findUnique({ where: { id: fixture.message } });
  const recipientsAfter = await prisma.recipient.findMany({
    where: { id: { in: [fixture.recipients.A, fixture.recipients.B] } },
    orderBy: { id: 'asc' },
  });
  const mediaAfter = await prisma.media.findMany({ where: { id: fixture.mediaId } });
  check('20. Finalization does not modify the Message',
    JSON.stringify(messageBefore) === JSON.stringify(messageAfter),
    'status=' + (messageAfter && messageAfter.status));
  check('21. Finalization does not modify Recipients',
    JSON.stringify(recipientsBefore) === JSON.stringify(recipientsAfter));
  check('22. Finalization does not modify Media',
    JSON.stringify(mediaBefore) === JSON.stringify(mediaAfter));
}

async function finalizeEdgeTests(cookie) {
  console.log('\n--- Finalize edges ---');

  const invalid = await finalize(fixture.campaignNoMessage, cookie);
  check('15. Invalid campaign remains DRAFT',
    invalid.status === 400 && (await campaignStatus(fixture.campaignNoMessage)) === 'DRAFT',
    'status=' + (await campaignStatus(fixture.campaignNoMessage)) + ' http=' + invalid.status);
  check('16. Validation response contains structured issues',
    invalid.json.success === false &&
    invalid.json.error.code === 'CAMPAIGN_NOT_READY' &&
    invalid.json.error.message === 'Campaign is not ready' &&
    Array.isArray(invalid.json.error.issues) && invalid.json.error.issues.length > 0 &&
    invalid.json.error.issues.every((issue) =>
      typeof issue.code === 'string' && issue.code.length > 0 &&
      typeof issue.message === 'string' && issue.message.length > 0),
    'issues=' + JSON.stringify(invalid.json.error.issues.map((i) => i.code)));

  // 7 / 18 — archived campaigns (valid configuration, archived status)
  await patchJson(`/api/campaigns/${fixture.campaignNoAudience}`, { status: 'ARCHIVED' }, cookie);
  await putJson(`/api/campaigns/${fixture.campaignNoAudience}/audience`, {
    recipientIds: [fixture.recipients.C],
  }, cookie);
  const archivedReadiness = await readiness(fixture.campaignNoAudience, cookie);
  const archivedWrite = await finalize(fixture.campaignNoAudience, cookie);
  check('7. Archived campaign cannot finalize',
    archivedWrite.status === 400 &&
    archivedWrite.json.error.issues.some((i) => i.code === 'CAMPAIGN_ARCHIVED'),
    'http=' + archivedWrite.status + ' ready=' + archivedReadiness.json.data.valid);
  check('18. ARCHIVED campaign remains ARCHIVED',
    (await campaignStatus(fixture.campaignNoAudience)) === 'ARCHIVED' &&
    archivedWrite.json.data === undefined,
    'status=' + (await campaignStatus(fixture.campaignNoAudience)));
  await patchJson(`/api/campaigns/${fixture.campaignNoAudience}`, { status: 'DRAFT' }, cookie);

  // 8 — an invalid status value never crashes the validator
  await prisma.campaign.update({ where: { id: fixture.campaignNoMessage }, data: { status: 'SENT' } });
  const badRead = await readiness(fixture.campaignNoMessage, cookie);
  const badWrite = await finalize(fixture.campaignNoMessage, cookie);
  check('8. Invalid campaign status is handled safely',
    badRead.status === 200 &&
    badRead.json.data.issues.some((i) => i.code === 'STATUS_INVALID') &&
    badWrite.status === 400 &&
    badWrite.json.error.issues.some((i) => i.code === 'STATUS_INVALID') &&
    (await campaignStatus(fixture.campaignNoMessage)) === 'SENT',
    'status=' + (await campaignStatus(fixture.campaignNoMessage)));
  await prisma.campaign.update({ where: { id: fixture.campaignNoMessage }, data: { status: 'DRAFT' } });

  // Reads never mutate the status of a finalized campaign.
  await readiness(fixture.campaign, cookie);
  await getJson(`/api/campaigns/${fixture.campaign}`, cookie);
  await getJson('/api/campaigns', cookie);
  await audienceIds(fixture.campaign, cookie);
  check('R1. Unrelated reads never demote a READY campaign',
    (await campaignStatus(fixture.campaign)) === 'READY',
    'status=' + (await campaignStatus(fixture.campaign)));
}

/* ------------------------------------------------------------------ *
 * Status invalidation (runtime)
 * ------------------------------------------------------------------ */
async function invalidationTests(cookie) {
  console.log('\n--- Status invalidation (READY -> DRAFT) ---');
  const campaignId = fixture.campaign;

  await finalize(campaignId, cookie);
  check('I0. Campaign is READY before the invalidation checks',
    (await campaignStatus(campaignId)) === 'READY');

  // 34 — message association changed
  const messageEdit = await patchJson(`/api/campaigns/${campaignId}`, {
    messageId: fixture.archivedMessage,
  }, cookie);
  check('34. Editing the message association on a READY campaign returns it to DRAFT',
    messageEdit.status === 200 && messageEdit.json.data.status === 'DRAFT' &&
    messageEdit.json.data.messageId === fixture.archivedMessage &&
    (await campaignStatus(campaignId)) === 'DRAFT');
  const afterMessageEdit = await finalize(campaignId, cookie);
  check('34b. The demoted campaign cannot be finalized until it is valid again',
    afterMessageEdit.status === 400 &&
    afterMessageEdit.json.error.issues.some((i) => i.code === 'MESSAGE_ARCHIVED'));

  // restore a valid configuration
  await patchJson(`/api/campaigns/${campaignId}`, { messageId: fixture.message }, cookie);
  await finalize(campaignId, cookie);
  check('I1. Re-finalizing a valid DRAFT campaign returns it to READY',
    (await campaignStatus(campaignId)) === 'READY');

  // 35 — audience changed
  const audienceEdit = await putJson(`/api/campaigns/${campaignId}/audience`, {
    recipientIds: [fixture.recipients.A],
  }, cookie);
  check('35. Editing the audience on a READY campaign returns it to DRAFT',
    audienceEdit.status === 200 && (await campaignStatus(campaignId)) === 'DRAFT',
    'status=' + (await campaignStatus(campaignId)));
  await finalize(campaignId, cookie);
  const unchangedAudience = await putJson(`/api/campaigns/${campaignId}/audience`, {
    recipientIds: [fixture.recipients.A],
  }, cookie);
  check('35b. Saving the identical audience keeps the campaign READY',
    unchangedAudience.status === 200 && (await campaignStatus(campaignId)) === 'READY');

  // 36 — name changed
  const nameEdit = await patchJson(`/api/campaigns/${campaignId}`, {
    name: `Phase43 Campaign One Renamed ${RUN}`,
  }, cookie);
  check('36. Editing the name on a READY campaign returns it to DRAFT',
    nameEdit.status === 200 && nameEdit.json.data.status === 'DRAFT' &&
    (await campaignStatus(campaignId)) === 'DRAFT');
  await finalize(campaignId, cookie);
  const sameNameEdit = await patchJson(`/api/campaigns/${campaignId}`, {
    name: `Phase43 Campaign One Renamed ${RUN}`,
  }, cookie);
  check('36b. Re-submitting the identical name keeps the campaign READY',
    sameNameEdit.status === 200 && (await campaignStatus(campaignId)) === 'READY');

  // 37 — description-only edits follow the documented value-diff rule
  const descriptionEdit = await patchJson(`/api/campaigns/${campaignId}`, {
    description: `Phase 4.3 note ${RUN}`,
  }, cookie);
  check('37. Description-only edits keep the campaign READY (documented rule)',
    descriptionEdit.status === 200 &&
    descriptionEdit.json.data.description === `Phase 4.3 note ${RUN}` &&
    (await campaignStatus(campaignId)) === 'READY',
    'status=' + (await campaignStatus(campaignId)));
  check('37b. The demotion rule is a name/messageId value diff',
    /nameChanged/.test(readSource(CAMPAIGNS_CONTROLLER_PATH)) &&
    /messageChanged/.test(readSource(CAMPAIGNS_CONTROLLER_PATH)) &&
    readSource(CAMPAIGNS_CONTROLLER_PATH).includes('existing.status === ') &&
    /audienceChanged/.test(readSource(AUDIENCE_CONTROLLER_PATH)) &&
    /campaignStatusResetOperation/.test(readSource(AUDIENCE_CONTROLLER_PATH)));
}

/* ------------------------------------------------------------------ *
 * Editor review UI (static)
 * ------------------------------------------------------------------ */
function editorTests() {
  console.log('\n--- Editor review UI ---');
  const editor = readSource(CAMPAIGN_EDITOR_PATH);
  const list = readSource(CAMPAIGNS_PAGE_PATH);
  const app = readSource(APP_PATH);

  check('23. Review section exists',
    editor.includes('Phase 4.3 — Review & Finalize') && editor.includes('id="review-section"') &&
    editor.includes('>Review</h2>'));
  check('24. Campaign summary exists',
    editor.includes('id="review-campaign-summary"') && editor.includes('id="review-campaign-name"') &&
    editor.includes('id="review-campaign-description"') && editor.includes('id="review-campaign-status"'));
  check('25. Message summary exists',
    editor.includes('id="review-message-summary"') && editor.includes('id="review-message-name"') &&
    editor.includes('id="review-message-status"') && editor.includes('id="review-message-body"') &&
    editor.includes('Body preview'));
  check('26. Media summary exists',
    editor.includes('id="review-media-summary"') && editor.includes('id="review-media-preview"') &&
    editor.includes('id="review-media-filename"') && editor.includes('id="review-no-media"') &&
    editor.includes('No media attached'));
  check('27. Audience summary exists',
    editor.includes('id="review-audience-summary"') && editor.includes('id="review-audience-count"') &&
    editor.includes('Selected: {audienceSnapshot.length}') && /review-audience-row-/.test(editor));
  check('28. Readiness panel exists',
    editor.includes('id="readiness-panel"') && editor.includes('Campaign Readiness') &&
    editor.includes("item.ok ? '✓' : '○'") && editor.includes('Media (optional)') &&
    editor.includes('readiness-item-'));
  check('29. Finalize button exists',
    editor.includes('id="finalize-campaign"') && editor.includes('Finalize Campaign') &&
    editor.includes('onClick={handleFinalizeCampaign}'));
  check('30. Finalizing state exists',
    editor.includes("finalizing ? 'Finalizing...'") &&
    editor.includes('disabled={finalizing || !canFinalizeCampaign}'));
  check('31. Validation errors are displayed',
    editor.includes('id="finalize-error"') && editor.includes('id="finalize-issues"') &&
    editor.includes('setFinalizeIssues(Array.isArray(errorPayload?.issues) ? errorPayload.issues : [])') &&
    editor.includes('id="readiness-invalid"') && editor.includes('id="fix-campaign"'));
  check('32. READY status is displayed after finalization',
    editor.includes("setStatus('READY')") && editor.includes('id="finalize-success"') &&
    editor.includes('id="review-campaign-status"'));
  check('33. ARCHIVED campaign cannot be finalized',
    editor.includes('id="finalize-archived-guard"') &&
    editor.includes("const isArchivedCampaign = status === 'ARCHIVED'") &&
    editor.includes('const canFinalizeCampaign = Boolean(readiness?.valid) && !isArchivedCampaign'));
  check('33b. The review reads the authoritative readiness snapshot',
    editor.includes('`/api/campaigns/${campaignId}/readiness`'));
  check('33c. Finalization makes exactly one call to the finalize endpoint',
    (editor.match(/\/finalize`/g) || []).length === 1 &&
    editor.includes('axios.post<{ success: boolean; data: { campaign: { status: string } } }>('));
  check('33d. The review reuses the existing message + audience APIs',
    editor.includes('`/api/campaigns/${campaignId}/audience`') &&
    editor.includes('`/api/messages/${messageId}`') && editor.includes("'/api/messages'"));
  check('33e. A new campaign explains that the review needs a saved campaign',
    editor.includes('id="review-hint"') && editor.includes('Save the campaign first'));
  check('33f. Phase 4.1 / 4.2 editor behaviour is preserved',
    editor.includes('id="campaign-name"') && editor.includes('id="campaign-description"') &&
    editor.includes('id="campaign-message"') && editor.includes('id="campaign-status"') &&
    editor.includes('id="audience-search"') && editor.includes('id="audience-save"') &&
    (editor.match(/axios\.put[<{(]/g) || []).length === 1 &&
    (editor.match(/setSelectedIds\(/g) || []).length === 5);
  check('33g. Campaign list still shows status and audience size',
    list.includes('getStatusColor(campaign.status)') && list.includes('{campaign.status}') &&
    list.includes('Audience: {audienceCounts[campaign.id] ?? 0}'));
  check('33h. Campaign routes are still registered',
    app.includes('<Route path="/campaigns" element={<Campaigns />} />') &&
    app.includes('<Route path="/campaigns/new" element={<CampaignEditor mode="new" />} />') &&
    app.includes('<Route path="/campaigns/:id/edit" element={<CampaignEditor mode="edit" />} />'));
}

/* ------------------------------------------------------------------ *
 * Safety (static)
 * ------------------------------------------------------------------ */
function safetyTests() {
  console.log('\n--- Safety ---');
  const util = readSource(READINESS_UTIL_PATH);
  const finalizeController = readSource(FINALIZE_CONTROLLER_PATH);
  const editor = readSource(CAMPAIGN_EDITOR_PATH);
  const list = readSource(CAMPAIGNS_PAGE_PATH);
  const schema = readSource(SCHEMA_PATH);
  const backend = stripComments(util) + '\n' + stripComments(finalizeController);
  const frontend = stripComments(editor) + '\n' + stripComments(list);

  check('43. No scheduling in review/finalize backend',
    !/scheduledAt|timezone|recurrence|nextRunAt|schedule/i.test(backend));
  check('44. No queue',
    !/queue/i.test(backend) && !/queue/i.test(frontend));
  check('45. No WhatsApp sending/integration',
    !/whatsappMessageId|wamid|whatsappApi|whatsappBusiness|WHATSAPP_/i.test(backend) &&
    !/whatsappMessageId|wamid|whatsappApi|whatsappBusiness/i.test(frontend));
  check('46. No Google integration',
    !/google|sheets|forms/i.test(backend) && !/google|sheets|forms/i.test(frontend));
  check('47. No outbound or paid API call from the review/finalize backend',
    !/fetch\(|http\.request|https\.request|axios|node-fetch|googleapis|twilio|sendgrid|graph\.facebook|openai|stripe/i.test(backend));
  check('48. No delivery tracking',
    !/deliveryStatus|sentAt|providerMessageId|retryCount|errorMessage/i.test(backend) &&
    !/deliveryStatus|sentAt|providerMessageId/i.test(frontend));
  check('49. No analytics',
    !/analytics|mixpanel|segment|amplitude|grafana/i.test(backend) &&
    !/analytics|mixpanel|segment|amplitude/i.test(frontend));
  check('50. Finalization performs no execution work',
    !/setTimeout|setInterval|cron|worker_threads|child_process|spawn\(/i.test(backend));
  check('51. Import wizard, message editor and media code untouched by Phase 4.3',
    !/finalize|readiness/i.test(readSource(IMPORT_WIZARD_PATH)) &&
    !/finalize|readiness/i.test(readSource(MESSAGE_EDITOR_PATH)) &&
    !/finalize|readiness/i.test(readSource(MEDIA_CONTROLLER_PATH)) &&
    readSource(IMPORTS_ROUTES_PATH).includes('confirmImport') &&
    readSource(RECIPIENTS_ROUTES_PATH).includes('router.use(requireAuth)') &&
    readSource(MESSAGES_ROUTES_PATH).includes("router.get('/:id'") &&
    readSource(MEDIA_ROUTES_PATH).includes("router.get('/:id'"));
  check('52. Phase 4.2 schema is reused, not rebuilt',
    /model CampaignRecipient \{/.test(schema) &&
    /@@id\(\[campaignId, recipientId\]\)/.test(modelBlock(schema, 'CampaignRecipient')) &&
    !/finalizedAt|readyAt|reviewedAt/i.test(schema) &&
    /status\s+String\s+@default\("DRAFT"\)/.test(modelBlock(schema, 'Campaign')));
  check('53. Campaign/recipient/message/media controllers were not rewritten',
    readSource(CAMPAIGNS_CONTROLLER_PATH).includes('export const updateCampaign') &&
    readSource(RECIPIENTS_CONTROLLER_PATH).includes('RECIPIENT_IN_CAMPAIGN') &&
    readSource(MESSAGES_CONTROLLER_PATH).includes('export const updateMessage') &&
    /export const uploadMedia/.test(readSource(MEDIA_CONTROLLER_PATH)));
}

/* ------------------------------------------------------------------ *
 * Regression suites — run strictly one after another, after this suite's
 * server is closed, because they all share one SQLite database.
 * ------------------------------------------------------------------ */
function regressionSuiteTests() {
  console.log('\n--- Regression suites (sequential) ---');
  const suites = [
    ['38. test-4-1.cjs — Phase 4.1 campaign foundation', 'test-4-1.cjs'],
    ['39. test-4-2.cjs — Phase 4.2 campaign audience', 'test-4-2.cjs'],
    ['40. test-3-3.cjs — Phase 3 message CMS', 'test-3-3.cjs'],
    ['41. test-3-4.cjs — Phase 3 media', 'test-3-4.cjs'],
    ['42. test-3-5.cjs — Phase 3 message/media association', 'test-3-5.cjs'],
  ];
  for (const [label, file] of suites) {
    const result = spawnSync(process.execPath, [file], { cwd: REPO_ROOT, encoding: 'utf8' });
    const output = String(result.stdout || '') + String(result.stderr || '');
    const summaryLine = (output.match(/Assertions run:[^\n]*/) ||
      output.split('\n').filter((line) => /passed|passed:/i.test(line)).slice(-1) || ['no summary'])[0];
    check(label, result.status === 0 && /All checks passed/.test(output), summaryLine || 'no summary');
  }
}

/* ------------------------------------------------------------------ *
 * Cleanup — removes only the rows and files this suite created.
 * ------------------------------------------------------------------ */
async function cleanup() {
  for (const id of createdMediaIds) {
    try { await prisma.media.delete({ where: { id } }); } catch { }
  }
  if (fixture.mediaStoragePath) {
    try { if (fs.existsSync(fixture.mediaStoragePath)) fs.unlinkSync(fixture.mediaStoragePath); } catch { }
  }
  try {
    await prisma.campaignRecipient.deleteMany({ where: { recipientId: { startsWith: 'phase43-orphan' } } });
    await prisma.campaignRecipient.deleteMany({ where: { campaignId: { in: [...createdCampaignIds] } } });
  } catch { }
  for (const id of createdCampaignIds) {
    try { await prisma.campaign.delete({ where: { id } }); } catch { }
  }
  for (const id of createdMessageIds) {
    try { await prisma.message.delete({ where: { id } }); } catch { }
  }
  for (const id of createdRecipientIds) {
    try { await prisma.recipient.delete({ where: { id } }); } catch { }
  }
  for (const id of createdTagIds) {
    try { await prisma.tag.delete({ where: { id } }); } catch { }
  }
  for (const filePath of tempFilePaths) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
  }
  if (tempUserId) {
    try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { }
    tempUserId = null;
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  console.log('=== Phase 4.3: Campaign Review & Finalization ===\n');
  process.env.PORT = String(TEST_PORT);
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };
  require('tsx/cjs');
  const indexModule = require('./apps/server/src/index.ts');
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
  const serverUp = await waitForServer(20000);
  check('0. Real server is reachable', serverUp, BASE);
  if (!serverUp) { process.exitCode = 1; return; }

  const baseline = {
    users: await prisma.user.count(),
    recipients: await prisma.recipient.count(),
    messages: await prisma.message.count(),
    media: await prisma.media.count(),
    campaigns: await prisma.campaign.count(),
    memberships: await prisma.campaignRecipient.count(),
  };
  const baselineIds = {
    users: new Set((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id)),
    recipients: new Set((await prisma.recipient.findMany({ select: { id: true } })).map((r) => r.id)),
    messages: new Set((await prisma.message.findMany({ select: { id: true } })).map((m) => m.id)),
    media: new Set((await prisma.media.findMany({ select: { id: true } })).map((m) => m.id)),
  };
  const storageFilesBefore = fs.existsSync(STORAGE_DIR) ? fs.readdirSync(STORAGE_DIR) : [];
  console.log('Baseline counts:', JSON.stringify(baseline));

  const email = 'phase43-' + RUN + '@example.com';
  const password = 'Phase43-' + RUN + '-pw!';
  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;
  const loginRes = await request('POST', '/api/auth/login', JSON.stringify({ email, password }), null, 'application/json');
  const cookie = loginRes.setCookie ? loginRes.setCookie.split(';')[0] : null;
  check('0b. Temporary admin user can authenticate', cookie !== null);

  try {
    staticContractTests();
    await createFixtures(cookie);
    await readinessTests(cookie);
    await consistencyTests(cookie);
    await finalizeTests(cookie);
    await finalizeEdgeTests(cookie);
    await invalidationTests(cookie);
    editorTests();
    safetyTests();
  } catch (error) {
    failures++;
    console.error('Unexpected test error:', error && error.stack ? error.stack : error);
  } finally {
    await cleanup();
  }

  console.log('\n--- Database safety ---');
  const finalCampaigns = await prisma.campaign.findMany({ select: { id: true } });
  const finalMemberships = await prisma.campaignRecipient.count();
  const finalUsers = await prisma.user.findMany({ select: { id: true } });
  const finalRecipients = await prisma.recipient.findMany({ select: { id: true } });
  const finalMessages = await prisma.message.findMany({ select: { id: true } });
  const finalMedia = await prisma.media.findMany({ select: { id: true } });

  check('51. Temporary campaigns cleaned up',
    finalCampaigns.length === baseline.campaigns &&
    finalCampaigns.every((c) => !createdCampaignIds.has(c.id)),
    'before=' + baseline.campaigns + ' after=' + finalCampaigns.length);
  check('52. Temporary audience memberships cleaned up',
    finalMemberships === baseline.memberships,
    'before=' + baseline.memberships + ' after=' + finalMemberships);
  check('53. Existing messages unchanged (only test data was added and removed)',
    finalMessages.length === baseline.messages && finalMessages.every((m) => baselineIds.messages.has(m.id)),
    'before=' + baseline.messages + ' after=' + finalMessages.length);
  check('54. Existing recipients unchanged',
    finalRecipients.length === baseline.recipients && finalRecipients.every((r) => baselineIds.recipients.has(r.id)),
    'before=' + baseline.recipients + ' after=' + finalRecipients.length);
  check('55. Existing media unchanged',
    finalMedia.length === baseline.media && finalMedia.every((m) => baselineIds.media.has(m.id)),
    'before=' + baseline.media + ' after=' + finalMedia.length);
  check('56. Existing users unchanged',
    finalUsers.length === baseline.users && finalUsers.every((u) => baselineIds.users.has(u.id)),
    'before=' + baseline.users + ' after=' + finalUsers.length);

  const storageFilesAfter = fs.existsSync(STORAGE_DIR) ? fs.readdirSync(STORAGE_DIR) : [];
  const newFiles = storageFilesAfter.filter((f) => !storageFilesBefore.includes(f));
  check('56b. No files added to storage/uploads', newFiles.length === 0, 'new=' + newFiles.length);

  if (server) await new Promise((resolve) => server.close(resolve));
  if (indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
  await prisma.$disconnect();

  regressionSuiteTests();

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});