/**
 * Phase 4.1 — Campaign Foundation Tests (REAL SUITE).
 *
 * Covers: Campaign schema, Campaign <-> Message relation, /api/campaigns CRUD,
 * relation safety (SetNull, shared message), campaign UI routes, safety
 * boundaries (no scheduling / audience / WhatsApp / queue / Google code) and
 * database safety (existing data untouched).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');
const argon2 = require('argon2');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma/schema.prisma');
const CAMPAIGNS_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/campaigns.controller.ts');
const CAMPAIGNS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/campaigns.routes.ts');
const MESSAGES_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/messages.controller.ts');
const MESSAGES_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/messages.routes.ts');
const MEDIA_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/media.controller.ts');
const RECIPIENTS_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/recipients.controller.ts');
const RECIPIENTS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/recipients.routes.ts');
const IMPORTS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/imports.routes.ts');
const SERVER_INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');
const APP_PATH = path.join(REPO_ROOT, 'apps/web/src/App.tsx');
const SIDEBAR_PATH = path.join(REPO_ROOT, 'apps/web/src/components/Sidebar.tsx');
const CAMPAIGNS_PAGE_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/Campaigns.tsx');
const CAMPAIGN_EDITOR_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/CampaignEditor.tsx');

const TEST_PORT = 3146;
const BASE = 'http://127.0.0.1:' + TEST_PORT;
const STORAGE_DIR = path.join(REPO_ROOT, 'storage', 'uploads');

const RUN = String(Date.now()).slice(-6);

let checks = 0;
let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;
const createdCampaignIds = new Set();
const createdMessageIds = new Set();

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

// Removes comments and the explicit later-phase field guards so that the
// safety checks only scan real executable code.
function stripGuardsAndComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/const FORBIDDEN_FIELDS = \[[\s\S]*?\];/, '');
}

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
function deleteJson(url, cookie) { return request('DELETE', url, undefined, cookie); }

/* ------------------------------------------------------------------ *
 * Schema (static)
 * ------------------------------------------------------------------ */
function schemaTests() {
  console.log('\n--- Prisma schema ---');
  const schema = readSource(SCHEMA_PATH);
  const campaign = modelBlock(schema, 'Campaign');
  const message = modelBlock(schema, 'Message');

  check('1. Campaign model exists', /model Campaign \{/.test(schema));
  check('2. Campaign -> Message relation exists',
    /message\s+Message\?\s+@relation\(fields: \[messageId\], references: \[id\], onDelete: SetNull\)/.test(campaign));
  check('3. Message -> Campaign relation exists', /campaigns\s+Campaign\[\]/.test(message));
  check('4. messageId is nullable', /messageId\s+String\?/.test(campaign));
  check('5. messageId is indexed', /@@index\(\[messageId\]\)/.test(campaign));
  check('6. Campaign status defaults to DRAFT',
    /status\s+String\s+@default\("DRAFT"\)/.test(campaign));
}

/* ------------------------------------------------------------------ *
 * Route wiring (static)
 * ------------------------------------------------------------------ */
function routeWiringTests() {
  console.log('\n--- Route wiring ---');
  const index = readSource(SERVER_INDEX_PATH);
  const routes = readSource(CAMPAIGNS_ROUTES_PATH);

  check('Routes: campaigns router mounted at /api/campaigns',
    /app\.use\('\/api\/campaigns', campaignsRoutes\)/.test(index) &&
    /import campaignsRoutes from '\.\/routes\/campaigns\.routes'/.test(index));
  check('Routes: all five endpoints registered',
    routes.includes("router.get('/'") && routes.includes("router.post('/'") &&
    routes.includes("router.get('/:id'") && routes.includes("router.patch('/:id'") &&
    routes.includes("router.delete('/:id'"));
  check('Routes: campaign routes stay behind requireAuth', routes.includes('router.use(requireAuth)'));
}

/* ------------------------------------------------------------------ *
 * Auth (runtime)
 * ------------------------------------------------------------------ */
async function authTests() {
  console.log('\n--- Auth ---');
  check('7. Unauthenticated GET /api/campaigns -> 401',
    (await getJson('/api/campaigns')).status === 401);
  check('8. Unauthenticated POST /api/campaigns -> 401',
    (await postJson('/api/campaigns', { name: 'Nope' })).status === 401);
  check('9. Unauthenticated GET /api/campaigns/:id -> 401',
    (await getJson('/api/campaigns/does-not-matter')).status === 401);
  check('10. Unauthenticated PATCH /api/campaigns/:id -> 401',
    (await patchJson('/api/campaigns/does-not-matter', { name: 'Nope' })).status === 401);
  check('11. Unauthenticated DELETE /api/campaigns/:id -> 401',
    (await deleteJson('/api/campaigns/does-not-matter')).status === 401);
}

/* ------------------------------------------------------------------ *
 * Create (runtime)
 * ------------------------------------------------------------------ */
const state = {
  messageA: null,
  messageB: null,
  messageC: null,
  campaignA: null,
  campaignB: null,
  campaignC: null,
  campaignD: null,
};

async function createFixtureMessage(cookie, label) {
  const res = await postJson('/api/messages', {
    name: 'Campaign Fixture ' + label + ' ' + RUN,
    body: 'Fixture body ' + label + ' ' + RUN,
  }, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdMessageIds.add(id);
  return id;
}

async function createTests(cookie) {
  console.log('\n--- Create ---');
  state.messageA = await createFixtureMessage(cookie, 'A');
  state.messageB = await createFixtureMessage(cookie, 'B');
  check('Create: fixture messages available for association',
    !!state.messageA && !!state.messageB);

  const created = await postJson('/api/campaigns', { name: 'Phase41 Name Only ' + RUN }, cookie);
  state.campaignA = created.json && created.json.data && created.json.data.id;
  if (state.campaignA) createdCampaignIds.add(state.campaignA);
  check('12. Create campaign with name only',
    created.status === 201 && !!state.campaignA && created.json.data.name === 'Phase41 Name Only ' + RUN,
    'status=' + created.status);
  check('13. Default status is DRAFT',
    created.json && created.json.data && created.json.data.status === 'DRAFT');

  const withDescription = await postJson('/api/campaigns', {
    name: 'Phase41 With Description ' + RUN,
    description: '  Description kept verbatim  ',
  }, cookie);
  if (withDescription.json && withDescription.json.data) createdCampaignIds.add(withDescription.json.data.id);
  check('14. Create with description',
    withDescription.status === 201 &&
    withDescription.json.data.description === '  Description kept verbatim  ',
    'description=' + JSON.stringify(withDescription.json && withDescription.json.data && withDescription.json.data.description));

  const withMessage = await postJson('/api/campaigns', {
    name: 'Phase41 With Message ' + RUN,
    messageId: state.messageA,
  }, cookie);
  if (withMessage.json && withMessage.json.data) createdCampaignIds.add(withMessage.json.data.id);
  state.campaignB = withMessage.json && withMessage.json.data && withMessage.json.data.id;
  check('15. Create with existing messageId',
    withMessage.status === 201 &&
    withMessage.json.data.messageId === state.messageA &&
    withMessage.json.data.message &&
    withMessage.json.data.message.id === state.messageA,
    'status=' + withMessage.status);

  check('16. Invalid messageId rejected',
    (await postJson('/api/campaigns', { name: 'Bad Message ' + RUN, messageId: 'nonexistent-message-id' }, cookie)).status === 400);
  check('17. Empty name rejected',
    (await postJson('/api/campaigns', { name: '' }, cookie)).status === 400);
  check('18. Whitespace-only name rejected',
    (await postJson('/api/campaigns', { name: '   ' }, cookie)).status === 400);
  check('19. Name >200 rejected',
    (await postJson('/api/campaigns', { name: 'x'.repeat(201) }, cookie)).status === 400);
  check('20. Invalid status rejected',
    (await postJson('/api/campaigns', { name: 'Bad Status ' + RUN, status: 'SCHEDULED' }, cookie)).status === 400);

  const trimmed = await postJson('/api/campaigns', { name: '  Trimmed ' + RUN + '  ' }, cookie);
  if (trimmed.json && trimmed.json.data) createdCampaignIds.add(trimmed.json.data.id);
  check('20b. Name is trimmed on create',
    trimmed.status === 201 && trimmed.json.data.name === 'Trimmed ' + RUN);

  const scheduled = await postJson('/api/campaigns', { name: 'Forbidden ' + RUN, scheduledAt: '2026-01-01T00:00:00.000Z' }, cookie);
  check('20c. Scheduling field rejected', scheduled.status === 400);
  const audience = await postJson('/api/campaigns', { name: 'Forbidden ' + RUN, recipientIds: ['r1'] }, cookie);
  check('20d. Recipient audience field rejected', audience.status === 400);
  const whatsapp = await postJson('/api/campaigns', { name: 'Forbidden ' + RUN, whatsappMessageId: 'wamid.123' }, cookie);
  check('20e. WhatsApp field rejected', whatsapp.status === 400);
  const queue = await postJson('/api/campaigns', { name: 'Forbidden ' + RUN, queueId: 'q1' }, cookie);
  check('20f. Queue field rejected', queue.status === 400);
}

/* ------------------------------------------------------------------ *
 * Read (runtime)
 * ------------------------------------------------------------------ */
async function readTests(cookie) {
  console.log('\n--- Read ---');
  const list = await getJson('/api/campaigns', cookie);
  check('21. List returns created campaign',
    list.status === 200 && Array.isArray(list.json.data) &&
    list.json.data.some((c) => c.id === state.campaignA));

  const fetched = await getJson('/api/campaigns/' + state.campaignA, cookie);
  check('22. Get-by-id returns campaign',
    fetched.status === 200 && fetched.json.data.id === state.campaignA &&
    fetched.json.data.name === 'Phase41 Name Only ' + RUN);

  const withMessage = await getJson('/api/campaigns/' + state.campaignB, cookie);
  check('23. Associated message summary is returned',
    withMessage.status === 200 && withMessage.json.data.message &&
    withMessage.json.data.message.id === state.messageA &&
    withMessage.json.data.message.name === 'Campaign Fixture A ' + RUN &&
    withMessage.json.data.message.status === 'DRAFT');

  const listEntry = (list.json.data || []).find((c) => c.id === state.campaignA) || {};
  // Read-only execution history was added to the campaign payload by a later
  // phase; this check still guards against any recipient/audience data leaking.
  check('23b. Campaign payload exposes only the expected fields (no recipient data)',
    JSON.stringify(Object.keys(listEntry).sort()) ===
    JSON.stringify(['createdAt', 'description', 'executions', 'id', 'message', 'messageId', 'name', 'status', 'updatedAt']),
    'keys=' + Object.keys(listEntry).join(','));

  check('24. Missing campaign returns 404',
    (await getJson('/api/campaigns/nonexistent-campaign', cookie)).status === 404);
}

/* ------------------------------------------------------------------ *
 * Update (runtime)
 * ------------------------------------------------------------------ */
async function updateTests(cookie) {
  console.log('\n--- Update ---');
  const renamed = await patchJson('/api/campaigns/' + state.campaignB, {
    name: 'Phase41 Renamed ' + RUN,
  }, cookie);
  check('25. Update name',
    renamed.status === 200 && renamed.json.data.name === 'Phase41 Renamed ' + RUN);

  const described = await patchJson('/api/campaigns/' + state.campaignB, {
    description: 'Updated description ' + RUN,
  }, cookie);
  check('26. Update description',
    described.status === 200 && described.json.data.description === 'Updated description ' + RUN);

  const archived = await patchJson('/api/campaigns/' + state.campaignB, { status: 'ARCHIVED' }, cookie);
  check('27. Update status',
    archived.status === 200 && archived.json.data.status === 'ARCHIVED');

  const reassigned = await patchJson('/api/campaigns/' + state.campaignB, { messageId: state.messageB }, cookie);
  check('28. Update messageId',
    reassigned.status === 200 && reassigned.json.data.messageId === state.messageB &&
    reassigned.json.data.message && reassigned.json.data.message.id === state.messageB);

  const cleared = await patchJson('/api/campaigns/' + state.campaignB, { messageId: null }, cookie);
  check('29. Remove messageId safely',
    cleared.status === 200 && cleared.json.data.messageId === null && cleared.json.data.message === null);

  check('30. Invalid status rejected',
    (await patchJson('/api/campaigns/' + state.campaignB, { status: 'RUNNING' }, cookie)).status === 400);
  check('31. Invalid messageId rejected',
    (await patchJson('/api/campaigns/' + state.campaignB, { messageId: 'nonexistent-message-id' }, cookie)).status === 400);
  check('32. Unknown campaign returns 404',
    (await patchJson('/api/campaigns/nonexistent-campaign', { name: 'Nope' }, cookie)).status === 404);
  check('32b. Empty name rejected on update',
    (await patchJson('/api/campaigns/' + state.campaignB, { name: '   ' }, cookie)).status === 400);
  check('32c. Name >200 rejected on update',
    (await patchJson('/api/campaigns/' + state.campaignB, { name: 'x'.repeat(201) }, cookie)).status === 400);
  check('32d. Forbidden scheduling field rejected on update',
    (await patchJson('/api/campaigns/' + state.campaignB, { scheduledAt: '2026-01-01T00:00:00.000Z' }, cookie)).status === 400);
}

/* ------------------------------------------------------------------ *
 * Delete (runtime)
 * ------------------------------------------------------------------ */
async function deleteTests(cookie, baseline) {
  console.log('\n--- Delete ---');
  const target = await postJson('/api/campaigns', {
    name: 'Phase41 Delete Me ' + RUN,
    messageId: state.messageA,
  }, cookie);
  const targetId = target.json && target.json.data && target.json.data.id;
  if (targetId) createdCampaignIds.add(targetId);

  const recipientsBefore = await prisma.recipient.findMany({ select: { id: true } });
  const mediaBefore = await prisma.media.findMany({ select: { id: true } });
  const campaignsBefore = await prisma.campaign.count();

  const deleted = await deleteJson('/api/campaigns/' + targetId, cookie);
  check('33. Delete campaign succeeds', deleted.status === 200 && deleted.json.success === true,
    'status=' + deleted.status);

  const afterDelete = await getJson('/api/campaigns/' + targetId, cookie);
  const campaignCount = await prisma.campaign.count();
  check('34. Campaign is removed',
    afterDelete.status === 404 && campaignCount === campaignsBefore - 1,
    'count=' + campaignCount);

  const messageStillThere = await getJson('/api/messages/' + state.messageA, cookie);
  check('35. Associated message remains',
    messageStillThere.status === 200 && messageStillThere.json.data.id === state.messageA);

  const recipientsAfter = await prisma.recipient.findMany({ select: { id: true } });
  check('36. Recipients remain unchanged',
    recipientsAfter.length === recipientsBefore.length &&
    recipientsAfter.every((r) => recipientsBefore.some((b) => b.id === r.id)) &&
    recipientsAfter.length === baseline.recipients,
    'count=' + recipientsAfter.length);

  const mediaAfter = await prisma.media.findMany({ select: { id: true } });
  check('37. Media remains unchanged',
    mediaAfter.length === mediaBefore.length &&
    mediaAfter.every((m) => mediaBefore.some((b) => b.id === m.id)) &&
    mediaAfter.length === baseline.media,
    'count=' + mediaAfter.length);

  check('37b. Deleting nonexistent campaign returns 404',
    (await deleteJson('/api/campaigns/nonexistent-campaign', cookie)).status === 404);
}

/* ------------------------------------------------------------------ *
 * Relation safety (runtime)
 * ------------------------------------------------------------------ */
async function relationTests(cookie) {
  console.log('\n--- Relation safety ---');
  const first = await postJson('/api/campaigns', { name: 'Phase41 Shared One ' + RUN, messageId: state.messageB }, cookie);
  const second = await postJson('/api/campaigns', { name: 'Phase41 Shared Two ' + RUN, messageId: state.messageB }, cookie);
  state.campaignC = first.json && first.json.data && first.json.data.id;
  state.campaignD = second.json && second.json.data && second.json.data.id;
  if (state.campaignC) createdCampaignIds.add(state.campaignC);
  if (state.campaignD) createdCampaignIds.add(state.campaignD);

  check('38. Same message can be associated with multiple campaigns',
    first.status === 201 && second.status === 201 &&
    first.json.data.messageId === state.messageB && second.json.data.messageId === state.messageB);

  const deleteFirst = await deleteJson('/api/campaigns/' + state.campaignC, cookie);
  const otherCampaign = await getJson('/api/campaigns/' + state.campaignD, cookie);
  const otherMessage = await getJson('/api/messages/' + state.messageB, cookie);
  check('39. Deleting one campaign does not affect the other',
    deleteFirst.status === 200 && otherCampaign.status === 200 &&
    otherCampaign.json.data.messageId === state.messageB &&
    otherMessage.status === 200);

  // SetNull behaviour, now behind the shared delete guard: a message that a live
  // campaign still references is refused without confirmation, and the confirmed
  // (?confirm=true) delete detaches the campaign (SetNull) instead of stranding it.
  state.messageC = await createFixtureMessage(cookie, 'C');
  const linked = await postJson('/api/campaigns', { name: 'Phase41 SetNull ' + RUN, messageId: state.messageC }, cookie);
  const linkedId = linked.json && linked.json.data && linked.json.data.id;
  if (linkedId) createdCampaignIds.add(linkedId);
  const refused = await deleteJson('/api/messages/' + state.messageC, cookie);
  const stillLinked = await getJson('/api/messages/' + state.messageC, cookie);
  check('40a. Message used by a live campaign is refused without confirmation',
    linked.status === 201 && refused.status === 409 &&
    refused.json && refused.json.error && refused.json.error.code === 'MESSAGE_IN_CAMPAIGN' &&
    stillLinked.status === 200,
    'status=' + refused.status);
  const messageDeleted = await deleteJson('/api/messages/' + state.messageC + '?confirm=true', cookie);
  if (messageDeleted.status === 200) createdMessageIds.delete(state.messageC);
  const afterSetNull = await getJson('/api/campaigns/' + linkedId, cookie);
  check('40. Confirmed message delete safely nulls campaign.messageId (SetNull)',
    messageDeleted.status === 200 && afterSetNull.status === 200 &&
    afterSetNull.json.data.messageId === null && afterSetNull.json.data.message === null,
    'messageId=' + JSON.stringify(afterSetNull.json && afterSetNull.json.data && afterSetNull.json.data.messageId));
}

/* ------------------------------------------------------------------ *
 * Frontend (static)
 * ------------------------------------------------------------------ */
function frontendTests() {
  console.log('\n--- Frontend ---');
  const app = readSource(APP_PATH);
  const sidebar = readSource(SIDEBAR_PATH);
  const list = readSource(CAMPAIGNS_PAGE_PATH);
  const editor = readSource(CAMPAIGN_EDITOR_PATH);

  check('41. /campaigns route exists',
    app.includes('<Route path="/campaigns" element={<Campaigns />} />') &&
    app.includes("import Campaigns from './pages/Campaigns'"));
  check('42. /campaigns/new route exists',
    app.includes('<Route path="/campaigns/new" element={<CampaignEditor mode="new" />} />'));
  check('43. /campaigns/:id/edit route exists',
    app.includes('<Route path="/campaigns/:id/edit" element={<CampaignEditor mode="edit" />} />') &&
    app.includes("import CampaignEditor from './pages/CampaignEditor'"));
  check('44. Campaign list calls /api/campaigns',
    list.includes('axios.get') && list.includes("'/api/campaigns'"));
  check('45. New campaign form exists',
    editor.includes('<form') && editor.includes('onSubmit={handleSubmit}') &&
    editor.includes('axios.post') && editor.includes("'/api/campaigns'"));
  check('46. Campaign name field exists',
    editor.includes('id="campaign-name"') && editor.includes('Campaign Name'));
  check('47. Description field exists',
    editor.includes('id="campaign-description"') && editor.includes('Description'));
  check('48. Message selector exists',
    editor.includes('id="campaign-message"') && editor.includes('<select') &&
    editor.includes("'/api/messages'") && editor.includes('<option value="">None</option>'));
  check('49. Status selector exists',
    editor.includes('id="campaign-status"') && editor.includes("const ALLOWED_STATUSES = ['DRAFT', 'READY', 'ARCHIVED']"));
  check('50. Edit form loads existing campaign',
    editor.includes('`/api/campaigns/${campaignId}`') &&
    editor.includes('axios.patch(`/api/campaigns/${campaignId}`'));
  check('51. Delete action exists',
    list.includes('axios.delete') && list.includes('`/api/campaigns/${deleteTarget.id}`') &&
    list.includes('Delete Campaign'));
  check('51b. Delete confirmation offers permanent deletion alongside Archive instead of forcing Archive-only',
    /Choose what you want to do/.test(list) && /Delete permanently/.test(list) && /Archive/.test(list))
  check('Nav: Campaigns entry in the sidebar links to /campaigns',
    sidebar.includes("href: '/campaigns'"));
  check('Nav: New Campaign navigates to /campaigns/new',
    list.includes("navigate('/campaigns/new')") && list.includes('New Campaign'));
  check('Nav: save and cancel return to /campaigns',
    (editor.match(/navigate\('\/campaigns'\)/g) || []).length >= 2);
  check('Editor: no message creation inside the campaign editor',
    !editor.includes("axios.post('/api/messages'"));
}

/* ------------------------------------------------------------------ *
 * Safety (static)
 * ------------------------------------------------------------------ */
function safetyStaticTests() {
  console.log('\n--- Safety ---');
  const schema = readSource(SCHEMA_PATH);
  const campaignBlock = modelBlock(schema, 'Campaign');
  const controller = stripGuardsAndComments(readSource(CAMPAIGNS_CONTROLLER_PATH));
  // Audit metadata such as audienceCount (inside recordAuditSafe) is audit
  // bookkeeping, not part of the campaign request/response surface, so it is
  // removed before the field scans below.
  const controllerNoAudit = controller.replace(/recordAuditSafe\([^;]*\)/g, 'recordAuditSafe()');
  const routes = readSource(CAMPAIGNS_ROUTES_PATH);
  const list = readSource(CAMPAIGNS_PAGE_PATH);
  const editor = readSource(CAMPAIGN_EDITOR_PATH);
  const backend = controller + '\n' + routes;

  check('52. No scheduling fields in Campaign model/controller',
    !/scheduledAt|timezone|recurrence|nextRunAt/i.test(campaignBlock) &&
    !/scheduledAt|timezone|recurrence|nextRunAt/i.test(controller));
  // Phase 4.1/4.2 scope: the Campaign foundation keeps only a message link plus
  // the Phase 4.2 audience relation (membership rows live in the dedicated
  // CampaignRecipient join model). The foundation POST/PATCH surface keeps
  // rejecting recipientIds/audience as request fields.
  check('53. No recipient payload fields in the Campaign foundation (relation lives in CampaignRecipient)',
    !/recipientIds/i.test(campaignBlock) && !/recipientIds|audience/i.test(controllerNoAudit) &&
    !/campaignRecipient\.(create|update|delete)/i.test(controller) &&
    !/prisma\.campaignRecipient/i.test(controller));
  // Phase 4.1/4.2 scope: the Campaign foundation controller stays free of
  // execution/sending fields. Phase 4.2 intentionally shows recipient
  // whatsappNumber values inside the audience selector so the administrator
  // can see which numbers were selected; it adds no WhatsApp sending code.
  check('54. No WhatsApp sending fields or integration',
    !/whatsappMessageId|wamid|whatsappBusiness|whatsappApi/i.test(campaignBlock) &&
    !/whatsappMessageId|wamid|whatsappBusiness|whatsappApi/i.test(controller) &&
    !/whatsappMessageId|wamid|whatsappBusiness|whatsappApi/i.test(list) &&
    !/whatsappMessageId|wamid|whatsappBusiness|whatsappApi/i.test(editor) &&
    !/WHATSAPP_.*TOKEN|WHATSAPP_API|waMessageId/i.test(backend));
  check('55. No queue fields or queue code',
    !/queueId|queue/i.test(campaignBlock) && !/queue/i.test(controller));
  check('56. No Google integration',
    !/google|spreadsheet|sheets\.googleapis/i.test(campaignBlock) &&
    !/google|spreadsheet|sheets\.googleapis/i.test(backend) &&
    !/google|spreadsheet/i.test(list) && !/google|spreadsheet/i.test(editor));
  check('57. No external API or outbound network call',
    !/fetch\(|http\.request|https\.request|axios|node-fetch|googleapis/i.test(backend));
  check('57b. Campaign backend rejects the later-phase fields explicitly',
    /FORBIDDEN_FIELDS/.test(readSource(CAMPAIGNS_CONTROLLER_PATH)) &&
    readSource(CAMPAIGNS_CONTROLLER_PATH).includes("'scheduledAt'") &&
    readSource(CAMPAIGNS_CONTROLLER_PATH).includes("'queueId'") &&
    readSource(CAMPAIGNS_CONTROLLER_PATH).includes("'whatsappMessageId'"));
  check('57c. Campaign controller has no media handling',
    !/multer|upload\.single|formData/i.test(controller));
  check('57d. Campaign controller never deletes messages or recipients',
    !/prisma\.message\.delete/.test(controller) && !/prisma\.recipient/i.test(controller) &&
    !/prisma\.media/i.test(controller) && !/prisma\.user/i.test(controller));
}

/* ------------------------------------------------------------------ *
 * Regression (runtime + static)
 * ------------------------------------------------------------------ */
async function regressionTests(cookie, baseline) {
  console.log('\n--- Regression ---');
  const messagesRoutes = readSource(MESSAGES_ROUTES_PATH);
  const messagesController = readSource(MESSAGES_CONTROLLER_PATH);
  const recipientsRoutes = readSource(RECIPIENTS_ROUTES_PATH);
  const recipientsController = readSource(RECIPIENTS_CONTROLLER_PATH);
  const importsRoutes = readSource(IMPORTS_ROUTES_PATH);
  const mediaControllerSource = readSource(MEDIA_CONTROLLER_PATH);
  const mediaRoutes = readSource(path.join(REPO_ROOT, 'apps/server/src/routes/media.routes.ts'));

  const listMessages = await getJson('/api/messages', cookie);
  const existingMessage = baseline.messageIds[0] || (listMessages.json.data[0] && listMessages.json.data[0].id);
  const readExisting = existingMessage ? await getJson('/api/messages/' + existingMessage, cookie) : { status: 0 };
  check('58. Existing Message API remains intact',
    listMessages.status === 200 && Array.isArray(listMessages.json.data) &&
    listMessages.json.data.length >= baseline.messages &&
    readExisting.status === 200 &&
    messagesRoutes.includes("router.get('/'") && messagesRoutes.includes("router.delete('/:id'") &&
    messagesController.includes('export const getMessages') &&
    messagesController.includes('export const deleteMessage') &&
    /export const upload/.test(mediaControllerSource) &&
    mediaRoutes.includes("router.get('/:id'"));

  const roundTrip = await postJson('/api/messages', { name: 'Regression Fixture ' + RUN, body: 'Body ' + RUN }, cookie);
  const roundTripId = roundTrip.json && roundTrip.json.data && roundTrip.json.data.id;
  if (roundTripId) createdMessageIds.add(roundTripId);
  const roundTripPatch = roundTripId ? await patchJson('/api/messages/' + roundTripId, { status: 'READY' }, cookie) : { status: 0 };
  const roundTripDelete = roundTripId ? await deleteJson('/api/messages/' + roundTripId, cookie) : { status: 0 };
  if (roundTripDelete.status === 200) createdMessageIds.delete(roundTripId);
  check('58b. Message API still supports create/update/delete',
    roundTrip.status === 201 && roundTripPatch.status === 200 &&
    roundTripPatch.json.data.status === 'READY' && roundTripDelete.status === 200);

  const recipients = await getJson('/api/recipients', cookie);
  check('59. Recipient/import code remains intact',
    recipients.status === 200 && Array.isArray(recipients.json.data) &&
    recipients.json.data.length === baseline.recipients &&
    recipientsRoutes.includes('router.use(requireAuth)') &&
    recipientsRoutes.includes('importRecipients') && recipientsRoutes.includes('checkImportDuplicates') &&
    recipientsController.includes('export const getRecipients') &&
    recipientsController.includes('export const importRecipients') &&
    importsRoutes.includes('previewImport') && importsRoutes.includes('confirmImport'),
    'recipients=' + (recipients.json && recipients.json.data && recipients.json.data.length));
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  console.log('=== Phase 4.1: Campaign Foundation ===\n');
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

  // Record database state before touching anything
  const baseline = {
    users: await prisma.user.count(),
    recipients: await prisma.recipient.count(),
    messages: await prisma.message.count(),
    media: await prisma.media.count(),
    campaigns: await prisma.campaign.count(),
  };
  const baselineIds = {
    users: new Set((await prisma.user.findMany({ select: { id: true } })).map((u) => u.id)),
    recipients: new Set((await prisma.recipient.findMany({ select: { id: true } })).map((r) => r.id)),
    messages: new Set((await prisma.message.findMany({ select: { id: true } })).map((m) => m.id)),
    media: new Set((await prisma.media.findMany({ select: { id: true } })).map((m) => m.id)),
  };
  baseline.messageIds = [...baselineIds.messages];
  const storageFilesBefore = fs.existsSync(STORAGE_DIR) ? fs.readdirSync(STORAGE_DIR) : [];
  console.log('Baseline counts:', JSON.stringify({
    users: baseline.users, recipients: baseline.recipients,
    messages: baseline.messages, media: baseline.media, campaigns: baseline.campaigns,
  }));

  const email = 'phase41-' + RUN + '@example.com';
  const password = 'Phase41-' + RUN + '-pw!';
  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;

  const loginRes = await request('POST', '/api/auth/login', JSON.stringify({ email, password }), null, 'application/json');
  const cookie = loginRes.setCookie ? loginRes.setCookie.split(';')[0] : null;
  check('0b. Temporary admin user can authenticate', cookie !== null);

  try {
    schemaTests();
    routeWiringTests();
    await authTests();
    await createTests(cookie);
    await readTests(cookie);
    await updateTests(cookie);
    await deleteTests(cookie, baseline);
    await relationTests(cookie);
    frontendTests();
    safetyStaticTests();
    await regressionTests(cookie, baseline);
  } catch (error) {
    failures++;
    console.error('Unexpected test error:', error && error.stack ? error.stack : error);
  } finally {
    // Remove only the records this test created
    for (const id of createdCampaignIds) {
      try { await prisma.campaign.delete({ where: { id } }); } catch { }
    }
    for (const id of createdMessageIds) {
      try { await prisma.message.delete({ where: { id } }); } catch { }
    }
    if (tempUserId) {
      try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { }
      tempUserId = null;
    }
  }

  console.log('\n--- Database safety ---');
  const finalCampaigns = await prisma.campaign.findMany();
  const finalUsers = await prisma.user.findMany({ select: { id: true } });
  const finalRecipients = await prisma.recipient.findMany({ select: { id: true } });
  const finalMessages = await prisma.message.findMany({ select: { id: true } });
  const finalMedia = await prisma.media.findMany({ select: { id: true } });

  check('63. Temporary campaigns cleaned up',
    finalCampaigns.length === baseline.campaigns &&
    finalCampaigns.every((c) => !createdCampaignIds.has(c.id)),
    'before=' + baseline.campaigns + ' after=' + finalCampaigns.length);
  check('64. Existing messages unchanged',
    finalMessages.length === baseline.messages && finalMessages.every((m) => baselineIds.messages.has(m.id)),
    'before=' + baseline.messages + ' after=' + finalMessages.length);
  check('65. Existing recipients unchanged',
    finalRecipients.length === baseline.recipients && finalRecipients.every((r) => baselineIds.recipients.has(r.id)),
    'before=' + baseline.recipients + ' after=' + finalRecipients.length);
  check('66. Existing media unchanged',
    finalMedia.length === baseline.media && finalMedia.every((m) => baselineIds.media.has(m.id)),
    'before=' + baseline.media + ' after=' + finalMedia.length);
  check('67. Existing users unchanged',
    finalUsers.length === baseline.users && finalUsers.every((u) => baselineIds.users.has(u.id)),
    'before=' + baseline.users + ' after=' + finalUsers.length);

  const storageFilesAfter = fs.existsSync(STORAGE_DIR) ? fs.readdirSync(STORAGE_DIR) : [];
  const newFiles = storageFilesAfter.filter((f) => !storageFilesBefore.includes(f));
  check('67b. No files added to storage/uploads', newFiles.length === 0, 'new=' + newFiles.length);

  if (server) await new Promise((resolve) => server.close(resolve));
  if (indexModule.worker) { try { await indexModule.worker.stop(); } catch { } }
  await prisma.$disconnect();

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
