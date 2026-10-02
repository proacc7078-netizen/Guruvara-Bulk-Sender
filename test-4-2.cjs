/**
 * Phase 4.2 — Campaign Audience Selection Tests (REAL SUITE).
 *
 * Covers: CampaignRecipient schema, audience GET/PUT API (atomic replacement),
 * audience search/filter reuse, selection semantics in the editor, relation
 * safety (shared recipients, cascade on campaign delete, protected recipient
 * delete) and database safety.
 *
 * Run sequentially with the other suites — they share one SQLite database.
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
const AUDIENCE_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/campaignAudience.controller.ts');
const CAMPAIGNS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/campaigns.routes.ts');
const RECIPIENTS_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/recipients.controller.ts');
const RECIPIENTS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/recipients.routes.ts');
const IMPORTS_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/imports.routes.ts');
const MESSAGES_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/messages.controller.ts');
const MESSAGES_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/messages.routes.ts');
const MEDIA_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/media.controller.ts');
const MEDIA_ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/media.routes.ts');
const SERVER_INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');
const APP_PATH = path.join(REPO_ROOT, 'apps/web/src/App.tsx');
const CAMPAIGN_EDITOR_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/CampaignEditor.tsx');
const CAMPAIGNS_PAGE_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/Campaigns.tsx');
const IMPORT_WIZARD_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/ImportWizard.tsx');
const MESSAGE_EDITOR_PATH = path.join(REPO_ROOT, 'apps/web/src/pages/MessageEditor.tsx');

const TEST_PORT = 3147;
const BASE = 'http://127.0.0.1:' + TEST_PORT;
const STORAGE_DIR = path.join(REPO_ROOT, 'storage', 'uploads');
const MAX_CAMPAIGN_RECIPIENTS = 5000;

const RUN = String(Date.now()).slice(-6);
// Letters-only token derived from RUN. Recipient search also matches digit runs
// against phone digits, so name-search tokens must contain no digits.
const LETTERS_FOR_DIGITS = 'abcdefghij';
const RUNWORD = RUN.split('').map((d) => LETTERS_FOR_DIGITS[Number(d)]).join('');

let checks = 0;
let failures = 0;
let server = null;
let serverWorker = null;
let prisma = null;
let tempUserId = null;
const createdCampaignIds = new Set();
const createdRecipientIds = new Set();
const createdTagIds = new Set();
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

function blockMatch(source, startPattern, endPattern) {
  const start = source.search(startPattern);
  if (start === -1) return '';
  const rest = source.slice(start);
  const end = rest.search(endPattern);
  return end === -1 ? rest : rest.slice(0, end);
}

// Removes comments and the explicit later-phase field guards so the safety
// checks only scan real executable code.
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
function putJson(url, body, cookie) { return request('PUT', url, JSON.stringify(body), cookie, 'application/json'); }
function deleteJson(url, cookie) { return request('DELETE', url, undefined, cookie); }

/* ------------------------------------------------------------------ *
 * Schema (static)
 * ------------------------------------------------------------------ */
function schemaTests() {
  console.log('\n--- Prisma schema ---');
  const schema = readSource(SCHEMA_PATH);
  const join = modelBlock(schema, 'CampaignRecipient');
  const campaign = modelBlock(schema, 'Campaign');
  const recipient = modelBlock(schema, 'Recipient');

  check('1. CampaignRecipient model exists', /model CampaignRecipient \{/.test(schema));
  check('2. Campaign relation exists',
    /campaign\s+Campaign\s+@relation\(fields: \[campaignId\], references: \[id\], onDelete: Cascade\)/.test(join) &&
    /campaignRecipients\s+CampaignRecipient\[\]/.test(campaign));
  check('3. Recipient relation exists',
    /recipient\s+Recipient\s+@relation\(fields: \[recipientId\], references: \[id\], onDelete: Restrict\)/.test(join) &&
    /campaignRecipients\s+CampaignRecipient\[\]/.test(recipient));
  check('4. Composite campaign/recipient key exists',
    /@@id\(\[campaignId, recipientId\]\)/.test(join));
  check('5. Recipient index exists', /@@index\(\[recipientId\]\)/.test(join));
  check('6. No recipient personal-data snapshot fields',
    !/name|whatsappNumber|normalizedPhone|language|category|status|tags|notes|consent/i.test(join),
    join.replace(/\s+/g, ' ').slice(0, 120));
  check('6b. No delivery/queue/scheduling fields in the join model',
    !/sentAt|deliveryStatus|providerMessageId|retryCount|errorMessage|scheduledAt|queueId|whatsappMessageId|sent/i.test(join));
  check('6c. Join model stores only membership + createdAt',
    /campaignId\s+String/.test(join) && /recipientId\s+String/.test(join) &&
    /createdAt\s+DateTime\s+@default\(now\(\)\)/.test(join));
}

/* ------------------------------------------------------------------ *
 * Route wiring (static)
 * ------------------------------------------------------------------ */
function routeWiringTests() {
  console.log('\n--- Route wiring ---');
  const index = readSource(SERVER_INDEX_PATH);
  const routes = readSource(CAMPAIGNS_ROUTES_PATH);
  const controller = readSource(AUDIENCE_CONTROLLER_PATH);

  check('Routes: audience endpoints registered',
    routes.includes("router.get('/:id/audience', getCampaignAudience)") &&
    routes.includes("router.put('/:id/audience', updateCampaignAudience)"));
  check('Routes: audience controller imported + router still mounted',
    routes.includes("from '../controllers/campaignAudience.controller'") &&
    /app\.use\('\/api\/campaigns', campaignsRoutes\)/.test(index));
  check('Routes: audience endpoints stay behind requireAuth', routes.includes('router.use(requireAuth)'));
  check('Routes: existing campaign endpoints untouched',
    routes.includes('getCampaigns') && routes.includes('getCampaignById') &&
    routes.includes('createCampaign') && routes.includes('updateCampaign') &&
    routes.includes('deleteCampaign'));
  check('Routes: audience controller uses one atomic payload endpoint (no per-recipient route)',
    !/router\.put\('\/:id\/audience\/:recipientId'/.test(routes) && controller.includes('MAX_CAMPAIGN_RECIPIENTS'));
}

/* ------------------------------------------------------------------ *
 * Auth (runtime)
 * ------------------------------------------------------------------ */
async function authTests() {
  console.log('\n--- Auth ---');
  check('7. Unauthenticated GET audience -> 401',
    (await getJson('/api/campaigns/any-id/audience')).status === 401);
  check('8. Unauthenticated PUT audience -> 401',
    (await putJson('/api/campaigns/any-id/audience', { recipientIds: [] })).status === 401);
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */
const fixture = {
  campaign1: null,
  campaign2: null,
  campaign3: null,
  recipients: { A: null, B: null, C: null, D: null },
  tagId: null,
};

const phoneFor = (n) => '9' + RUN + String(n);

async function createFixtureRecipient(cookie, label, options) {
  const res = await postJson('/api/recipients', {
    name: `Phase42 ${label} ${RUNWORD}`,
    whatsappNumber: phoneFor(options.slot),
    language: options.language,
    category: 'Phase4Test',
    status: options.status,
    source: 'MANUAL',
  }, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdRecipientIds.add(id);
  return id;
}

async function createFixtureCampaign(cookie, label) {
  const res = await postJson('/api/campaigns', { name: `Phase42 ${label} ${RUN}` }, cookie);
  const id = res.json && res.json.data && res.json.data.id;
  if (id) createdCampaignIds.add(id);
  return id;
}

async function createFixtures(cookie) {
  console.log('\n--- Fixtures ---');
  fixture.recipients.A = await createFixtureRecipient(cookie, 'Ravi', { slot: 1001, status: 'ACTIVE', language: 'Hindi' });
  fixture.recipients.B = await createFixtureRecipient(cookie, 'Anil', { slot: 1002, status: 'PAUSED', language: 'Kannada' });
  fixture.recipients.C = await createFixtureRecipient(cookie, 'Kiran', { slot: 1003, status: 'ACTIVE', language: 'Kannada' });
  fixture.recipients.D = await createFixtureRecipient(cookie, 'Vijay', { slot: 1004, status: 'UNSUBSCRIBED', language: null });

  check('Fixtures: temporary recipients created',
    Object.values(fixture.recipients).every(Boolean),
    JSON.stringify(fixture.recipients));

  const tag = await postJson('/api/tags', { name: 'Phase42 Tag ' + RUN }, cookie);
  fixture.tagId = tag.json && tag.json.data && tag.json.data.id;
  if (fixture.tagId) createdTagIds.add(fixture.tagId);
  check('Fixtures: temporary tag created', !!fixture.tagId);

  const assignA = await postJson(`/api/recipients/${fixture.recipients.A}/tags`, { tagId: fixture.tagId }, cookie);
  const assignC = await postJson(`/api/recipients/${fixture.recipients.C}/tags`, { tagId: fixture.tagId }, cookie);
  check('Fixtures: tag assigned to two recipients',
    assignA.status === 200 && assignC.status === 200);

  fixture.campaign1 = await createFixtureCampaign(cookie, 'Campaign One');
  fixture.campaign2 = await createFixtureCampaign(cookie, 'Campaign Two');
  fixture.campaign3 = await createFixtureCampaign(cookie, 'Campaign Three');
  check('Fixtures: temporary campaigns created',
    !!fixture.campaign1 && !!fixture.campaign2 && !!fixture.campaign3);
}

/* ------------------------------------------------------------------ *
 * GET audience
 * ------------------------------------------------------------------ */
async function getTests(cookie) {
  console.log('\n--- GET audience ---');
  const empty = await getJson(`/api/campaigns/${fixture.campaign1}/audience`, cookie);
  check('9. Existing campaign audience returns successfully',
    empty.status === 200 && empty.json.success === true && Array.isArray(empty.json.data),
    'status=' + empty.status);
  check('10. Empty audience returns empty array',
    Array.isArray(empty.json.data) && empty.json.data.length === 0);

  const selected = await putJson(`/api/campaigns/${fixture.campaign1}/audience`, {
    recipientIds: [fixture.recipients.A],
  }, cookie);
  check('GET setup: one recipient selected',
    selected.status === 200 && selected.json.data.length === 1);

  const one = await getJson(`/api/campaigns/${fixture.campaign1}/audience`, cookie);
  const row = (one.json.data || [])[0] || {};
  check('11. Recipient fields are returned correctly',
    one.status === 200 && one.json.data.length === 1 &&
    row.id === fixture.recipients.A &&
    row.name === `Phase42 Ravi ${RUNWORD}` &&
    row.whatsappNumber === phoneFor(1001) &&
    row.normalizedPhone === phoneFor(1001) &&
    row.language === 'Hindi' &&
    row.category === 'Phase4Test' &&
    row.status === 'ACTIVE' &&
    row.source === 'MANUAL' &&
    Array.isArray(row.tags),
    JSON.stringify({ name: row.name, status: row.status, tags: row.tags && row.tags.length }));
  check('11b. No unnecessary sensitive/internal fields returned',
    !('consentStatus' in row) && !('notes' in row) && !('password' in row) &&
    !('lastMessageAt' in row) && !('consentTimestamp' in row),
    'keys=' + Object.keys(row).join(','));
  check('11c. Audience tags expose the assigned tag',
    (row.tags || []).some((entry) => entry.tag && entry.tag.id === fixture.tagId));

  check('12. Missing campaign -> 404',
    (await getJson('/api/campaigns/nonexistent-campaign/audience', cookie)).status === 404);
}

/* ------------------------------------------------------------------ *
 * PUT audience
 * ------------------------------------------------------------------ */
async function membershipCount(campaignId) {
  return prisma.campaignRecipient.count({ where: { campaignId } });
}

async function audienceIds(campaignId, cookie) {
  const res = await getJson(`/api/campaigns/${campaignId}/audience`, cookie);
  return (res.json && res.json.data ? res.json.data : []).map((r) => r.id).sort();
}

async function putTests(cookie) {
  console.log('\n--- PUT audience ---');
  const campaign1 = fixture.campaign1;

  const single = await putJson(`/api/campaigns/${campaign1}/audience`, { recipientIds: [fixture.recipients.A] }, cookie);
  check('13. Select one recipient',
    single.status === 200 && single.json.data.length === 1 &&
    single.json.data[0].id === fixture.recipients.A && (await membershipCount(campaign1)) === 1,
    'status=' + single.status);

  const multiple = await putJson(`/api/campaigns/${campaign1}/audience`, {
    recipientIds: [fixture.recipients.A, fixture.recipients.B],
  }, cookie);
  check('14. Select multiple recipients',
    multiple.status === 200 && multiple.json.data.length === 2 &&
    JSON.stringify(await audienceIds(campaign1, cookie)) ===
    JSON.stringify([fixture.recipients.A, fixture.recipients.B].sort()) &&
    (await membershipCount(campaign1)) === 2);

  const duplicated = await putJson(`/api/campaigns/${campaign1}/audience`, {
    recipientIds: [fixture.recipients.A, fixture.recipients.A, fixture.recipients.B, fixture.recipients.B],
  }, cookie);
  check('15. Duplicate recipient IDs are deduplicated',
    duplicated.status === 200 && duplicated.json.data.length === 2 &&
    (await membershipCount(campaign1)) === 2);

  const replaced = await putJson(`/api/campaigns/${campaign1}/audience`, {
    recipientIds: [fixture.recipients.C],
  }, cookie);
  check('22. Existing audience is replaced atomically',
    replaced.status === 200 && JSON.stringify(await audienceIds(campaign1, cookie)) ===
    JSON.stringify([fixture.recipients.C]) && (await membershipCount(campaign1)) === 1,
    'ids=' + (await audienceIds(campaign1, cookie)).join(','));
  check('22b. PUT returns the saved audience',
    replaced.json.data.length === 1 && replaced.json.data[0].id === fixture.recipients.C);
  check('22c. Re-saving the same audience is idempotent',
    (await putJson(`/api/campaigns/${campaign1}/audience`, {
      recipientIds: [fixture.recipients.C],
    }, cookie)).status === 200 && (await membershipCount(campaign1)) === 1);

  const cleared = await putJson(`/api/campaigns/${campaign1}/audience`, { recipientIds: [] }, cookie);
  check('16. Empty array clears audience',
    cleared.status === 200 && cleared.json.data.length === 0 && (await membershipCount(campaign1)) === 0);

  const invalid = await putJson(`/api/campaigns/${campaign1}/audience`, {
    recipientIds: [fixture.recipients.A, 'nonexistent-recipient-id'],
  }, cookie);
  check('17. Invalid recipient ID rejected', invalid.status === 400);

  // 18 — atomicity: an invalid ID must not change the existing audience
  await putJson(`/api/campaigns/${campaign1}/audience`, { recipientIds: [fixture.recipients.A] }, cookie);
  const beforeAtomic = await audienceIds(campaign1, cookie);
  const failedAtomic = await putJson(`/api/campaigns/${campaign1}/audience`, {
    recipientIds: [fixture.recipients.A, fixture.recipients.B, 'nonexistent-recipient-id'],
  }, cookie);
  const afterAtomic = await audienceIds(campaign1, cookie);
  check('18. Invalid recipient ID does not partially modify existing audience',
    failedAtomic.status === 400 && JSON.stringify(afterAtomic) === JSON.stringify(beforeAtomic) &&
    (await membershipCount(campaign1)) === 1,
    'before=' + beforeAtomic.join(',') + ' after=' + afterAtomic.join(','));

  check('19. Missing campaign -> 404',
    (await putJson('/api/campaigns/nonexistent-campaign/audience', { recipientIds: [] }, cookie)).status === 404);

  check('20. Malformed recipientIds rejected (not an array)',
    (await putJson(`/api/campaigns/${campaign1}/audience`, { recipientIds: 'not-an-array' }, cookie)).status === 400);
  check('20b. Malformed recipientIds rejected (missing field)',
    (await putJson(`/api/campaigns/${campaign1}/audience`, {}, cookie)).status === 400);
  check('20c. Malformed recipientIds rejected (non-string entry)',
    (await putJson(`/api/campaigns/${campaign1}/audience`, { recipientIds: [123] }, cookie)).status === 400);
  check('20d. Malformed recipientIds rejected (blank entry)',
    (await putJson(`/api/campaigns/${campaign1}/audience`, { recipientIds: ['   '] }, cookie)).status === 400);

  const oversized = Array.from({ length: MAX_CAMPAIGN_RECIPIENTS + 1 }, (_, index) => `fake-${index}`);
  const overLimit = await putJson(`/api/campaigns/${campaign1}/audience`, { recipientIds: oversized }, cookie);
  check('21. Payload above maximum rejected',
    overLimit.status === 400 && (await membershipCount(campaign1)) === 1,
    'status=' + overLimit.status);

  check('21b. Later-phase field rejected on PUT audience',
    (await putJson(`/api/campaigns/${campaign1}/audience`, {
      recipientIds: [fixture.recipients.A], sentAt: '2026-01-01T00:00:00.000Z',
    }, cookie)).status === 400);
  check('21c. Audience unchanged after rejected payloads',
    JSON.stringify(await audienceIds(campaign1, cookie)) === JSON.stringify([fixture.recipients.A]));
}

/* ------------------------------------------------------------------ *
 * Selection semantics + search/filters
 * ------------------------------------------------------------------ */
async function searchRecipients(cookie, params) {
  const query = new URLSearchParams(params).toString();
  const res = await getJson('/api/recipients' + (query ? '?' + query : ''), cookie);
  return {
    status: res.status,
    ids: ((res.json && res.json.data) || []).map((recipient) => recipient.id).sort(),
  };
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

async function selectionTests(cookie) {
  console.log('\n--- Selection semantics (editor source) ---');
  const editor = readSource(CAMPAIGN_EDITOR_PATH);
  const fetchEffect = blockMatch(editor, /\/\/ Debounced recipient search \+ filters\./, /audienceTagFilter\]\);/);
  const toggleBlock = blockMatch(editor, /const handleToggleRecipient = \(recipientId: string\) => \{/, /\n  \};/);
  const selectAllBlock = blockMatch(editor, /const handleSelectAllVisible = \(\) => \{/, /\n  \};/);
  const clearVisibleBlock = blockMatch(editor, /const handleClearVisible = \(\) => \{/, /\n  \};/);
  const clearFiltersBlock = blockMatch(editor, /const handleClearAudienceFilters = \(\) => \{/, /\n  \};/);

  // 23 — existing selection loads in the editor
  await putJson(`/api/campaigns/${fixture.campaign2}/audience`, {
    recipientIds: [fixture.recipients.A, fixture.recipients.B],
  }, cookie);
  const loadedIds = await audienceIds(fixture.campaign2, cookie);
  check('23. Existing selection loads in editor',
    editor.includes('`/api/campaigns/${campaignId}/audience`') &&
    editor.includes('setSelectedIds(response.data.data.map((recipient) => recipient.id))') &&
    sameSet(loadedIds, [fixture.recipients.A, fixture.recipients.B]),
    'loaded=' + loadedIds.length);

  check('24. Select All Visible works',
    selectAllBlock.length > 0 &&
    selectAllBlock.includes('visibleRecipients.map') &&
    selectAllBlock.includes('Array.from(new Set([...prev, ...visibleIds]))') &&
    !selectAllBlock.includes('setVisibleRecipients'));

  check('25. Clear Visible works',
    clearVisibleBlock.length > 0 &&
    clearVisibleBlock.includes('new Set(visibleRecipients.map') &&
    clearVisibleBlock.includes('prev.filter((id) => !visibleIds.has(id))'));

  check('26. Selection survives search',
    fetchEffect.length > 0 && !fetchEffect.includes('setSelectedIds') &&
    fetchEffect.includes("'/api/recipients'"));

  check('27. Selection survives filter changes',
    fetchEffect.includes('audienceStatusFilter') && fetchEffect.includes('audienceLanguageFilter') &&
    fetchEffect.includes('audienceTagFilter') && !fetchEffect.includes('setSelectedIds') &&
    clearFiltersBlock.length > 0 && !clearFiltersBlock.includes('setSelectedIds'));

  check('27b. Selection is only mutated by the intended handlers',
    (editor.match(/setSelectedIds\(/g) || []).length === 5 &&
    toggleBlock.includes('prev.includes(recipientId)'),
    'occurrences=' + (editor.match(/setSelectedIds\(/g) || []).length);

  await putJson(`/api/campaigns/${fixture.campaign3}/audience`, {
    recipientIds: [fixture.recipients.A, fixture.recipients.B, fixture.recipients.C],
  }, cookie);
  const countThree = await audienceIds(fixture.campaign3, cookie);
  check('28. Selected count is correct',
    countThree.length === 3 && editor.includes('Selected: {selectedIds.length}'));
}

async function searchFilterTests(cookie) {
  console.log('\n--- Search + filters (runtime, reused endpoint) ---');
  const searchName = await searchRecipients(cookie, { search: `Ravi ${RUNWORD}` });
  check('29. Search works (by name)',
    searchName.status === 200 && sameSet(searchName.ids, [fixture.recipients.A]),
    'results=' + searchName.ids.length);

  const searchPhone = await searchRecipients(cookie, { search: phoneFor(1002) });
  check('29b. Search works (by phone / normalized phone)',
    searchPhone.status === 200 && searchPhone.ids.includes(fixture.recipients.B));

  const pausedOnly = await searchRecipients(cookie, { search: RUNWORD, status: 'PAUSED' });
  check('30. Status filter works',
    pausedOnly.status === 200 && sameSet(pausedOnly.ids, [fixture.recipients.B]),
    'results=' + pausedOnly.ids.length);

  const activeOnly = await searchRecipients(cookie, { search: RUNWORD, status: 'ACTIVE' });
  check('30b. Status filter combines with search',
    sameSet(activeOnly.ids, [fixture.recipients.A, fixture.recipients.C]));

  const unsubscribed = await searchRecipients(cookie, { search: RUNWORD, status: 'UNSUBSCRIBED' });
  const allFixtures = await searchRecipients(cookie, { search: RUNWORD });
  check('30c. Non-ACTIVE recipients stay visible and selectable (no eligibility filtering)',
    unsubscribed.ids.includes(fixture.recipients.D) &&
    sameSet(allFixtures.ids, [fixture.recipients.A, fixture.recipients.B, fixture.recipients.C, fixture.recipients.D]),
    'visible=' + allFixtures.ids.length);

  const kannada = await searchRecipients(cookie, { search: RUNWORD, language: 'Kannada' });
  check('31. Language filter works',
    sameSet(kannada.ids, [fixture.recipients.B, fixture.recipients.C]));

  const tagged = await searchRecipients(cookie, { search: RUNWORD, tagId: fixture.tagId });
  check('32. Tag filter works',
    sameSet(tagged.ids, [fixture.recipients.A, fixture.recipients.C]));

  const combined = await searchRecipients(cookie, {
    search: `Ravi ${RUNWORD}`, status: 'ACTIVE', language: 'Hindi', tagId: fixture.tagId,
  });
  const combinedNegative = await searchRecipients(cookie, {
    search: `Ravi ${RUNWORD}`, status: 'ACTIVE', language: 'Kannada', tagId: fixture.tagId,
  });
  check('33. Combined search + filters work',
    sameSet(combined.ids, [fixture.recipients.A]) && combinedNegative.ids.length === 0,
    'positive=' + combined.ids.length + ' negative=' + combinedNegative.ids.length);

  // Membership is stored server-side, so listing/searching recipients cannot clear it.
  const afterSearches = await audienceIds(fixture.campaign2, cookie);
  check('33b. Audience membership is unaffected by search/filter requests',
    sameSet(afterSearches, [fixture.recipients.A, fixture.recipients.B]));
}

/* ------------------------------------------------------------------ *
 * UI (static)
 * ------------------------------------------------------------------ */
function frontendTests() {
  console.log('\n--- UI (CampaignEditor / Campaigns) ---');
  const editor = readSource(CAMPAIGN_EDITOR_PATH);
  const list = readSource(CAMPAIGNS_PAGE_PATH);
  const app = readSource(APP_PATH);
  const saveAudienceBlock = blockMatch(editor, /const handleSaveAudience = async \(\) => \{/, /\n  \};/);

  check('34. Audience section exists',
    editor.includes('>Audience</h2>') && /Phase 4\.2 — Audience/.test(editor));
  check('35. Recipient search field exists',
    editor.includes('id="audience-search"') && editor.includes('placeholder="Search by name or phone"'));
  check('36. Status filter exists',
    editor.includes('id="audience-status-filter"') &&
    editor.includes("const RECIPIENT_STATUSES = ['ACTIVE', 'PAUSED', 'UNSUBSCRIBED', 'INVALID', 'BLOCKED']"));
  check('37. Language filter exists',
    editor.includes('id="audience-language-filter"') && editor.includes('audienceLanguages.map'));
  check('38. Tag filter exists',
    editor.includes('id="audience-tag-filter"') && editor.includes("'/api/tags'") &&
    editor.includes('audienceTags.map'));
  check('39. Selected count exists',
    editor.includes('id="audience-selected-count"') && editor.includes('Selected: {selectedIds.length}'));
  check('40. Save audience action exists',
    editor.includes('id="audience-save"') && editor.includes('Save Audience') &&
    saveAudienceBlock.includes('axios.put'));
  check('40b. Audience is saved with one atomic call',
    (editor.match(/axios\.put[<{(]/g) || []).length === 1 &&
    saveAudienceBlock.includes('recipientIds: selectedIds'));
  check('41. Loading state exists',
    editor.includes('id="audience-loading"') && editor.includes('audienceLoading ?'));
  check('42. Error state exists',
    editor.includes('id="audience-error"') && editor.includes('audienceSaveError &&') &&
    editor.includes('setAudienceSaveError('));
  check('43. Existing campaign fields remain intact',
    editor.includes('id="campaign-name"') && editor.includes('id="campaign-description"') &&
    editor.includes('id="campaign-message"') && editor.includes('id="campaign-status"') &&
    editor.includes('axios.patch(`/api/campaigns/${campaignId}`'));
  check('43b. New campaigns explain that the audience needs a saved campaign',
    editor.includes('id="audience-hint"') && editor.includes('Save the campaign first'));
  check('43c. A newly saved campaign activates its audience section',
    editor.includes('navigate(`/campaigns/${created.data.data.id}/edit`)') &&
    editor.includes('id="audience-search"'));
  check('43d. Campaign list shows the audience size',
    list.includes('Audience: {audienceCounts[campaign.id] ?? 0}') &&
    list.includes('`/api/campaigns/${campaign.id}/audience`'));
  check('43e. Campaign routes still registered',
    app.includes('<Route path="/campaigns" element={<Campaigns />} />') &&
    app.includes('<Route path="/campaigns/new" element={<CampaignEditor mode="new" />} />') &&
    app.includes('<Route path="/campaigns/:id/edit" element={<CampaignEditor mode="edit" />} />'));
  check('43f. Audience search is debounced (300ms)',
    editor.includes('const RECIPIENT_SEARCH_DEBOUNCE_MS = 300;') &&
    editor.includes('}, RECIPIENT_SEARCH_DEBOUNCE_MS);'));
  check('43g. Recipient status is visible in the selector',
    editor.includes('getRecipientStatusColor(recipient.status)') && editor.includes('{recipient.status}'));
  check('43h. One checkbox per visible recipient, checked from the selection',
    editor.includes('checked={selectedIds.includes(recipient.id)}') &&
    editor.includes('onChange={() => handleToggleRecipient(recipient.id)}'));
}

/* ------------------------------------------------------------------ *
 * Safety (static)
 * ------------------------------------------------------------------ */
function safetyTests() {
  console.log('\n--- Safety ---');
  const schema = readSource(SCHEMA_PATH);
  const join = modelBlock(schema, 'CampaignRecipient');
  const audienceController = readSource(AUDIENCE_CONTROLLER_PATH);
  const audienceCode = stripGuardsAndComments(audienceController);
  const editor = readSource(CAMPAIGN_EDITOR_PATH);
  const list = readSource(CAMPAIGNS_PAGE_PATH);
  const frontend = editor + '\n' + list;
  const importWizard = readSource(IMPORT_WIZARD_PATH);
  const messageEditor = readSource(MESSAGE_EDITOR_PATH);
  const mediaController = readSource(MEDIA_CONTROLLER_PATH);

  check('44. No scheduling fields',
    !/scheduledAt|timezone|recurrence|nextRunAt/i.test(join) &&
    !/scheduledAt|timezone|recurrence|nextRunAt/i.test(audienceCode));
  check('45. No WhatsApp integration fields or calls',
    !/whatsappMessageId|wamid|whatsappApi|waMessageId|whatsappBusiness/i.test(join) &&
    !/whatsappMessageId|wamid|whatsappApi|waMessageId|whatsappBusiness/i.test(audienceCode) &&
    !/whatsappMessageId|wamid|whatsappApi|whatsappBusiness/i.test(frontend) &&
    !/whatsappMessageId|wamid/i.test(schema));
  check('46. No queue fields',
    !/queue/i.test(join) && !/queue/i.test(audienceCode) && !/queue/i.test(frontend));
  check('47. No delivery tracking',
    !/deliveryStatus|sentAt|providerMessageId|retryCount|errorMessage/i.test(join) &&
    !/deliveryStatus|sentAt|providerMessageId|retryCount|errorMessage/i.test(audienceCode) &&
    !/deliveryStatus|sentAt|providerMessageId/i.test(frontend));
  check('48. No Google integration',
    !/google|sheets|forms/i.test(join) && !/google|sheets|forms/i.test(audienceCode) &&
    !/google|sheets|forms/i.test(frontend));
  check('49. No external API or outbound network call in the audience backend',
    !/fetch\(|http\.request|https\.request|axios|node-fetch|googleapis/i.test(audienceCode));
  check('50. No recipient creation from the audience selector',
    !editor.includes("axios.post('/api/recipients'") && !editor.includes('axios.delete(') &&
    !/prisma\.recipient\.(create|update|delete|deleteMany|upsert)/.test(audienceController) &&
    !/prisma\.message/.test(audienceController));
  check('51. No recipient import changes',
    !/campaign|audience/i.test(importWizard) &&
    importWizard.includes('/api/recipients/import') &&
    readSource(IMPORTS_ROUTES_PATH).includes('previewImport') &&
    readSource(IMPORTS_ROUTES_PATH).includes('confirmImport'));
  check('51b. Message editor + media code untouched by the audience feature',
    !/campaignRecipient|audience/i.test(messageEditor) && !/campaignRecipient|audience/i.test(mediaController));
  check('51c. Audience controller only touches membership rows',
    audienceController.includes('prisma.campaignRecipient.deleteMany') &&
    audienceController.includes('prisma.campaignRecipient.createMany') &&
    !audienceController.includes('prisma.campaign.delete') &&
    !audienceController.includes('prisma.campaign.update'));
  check('51d. Later-phase fields are explicitly rejected by the audience API',
    audienceController.includes("'sentAt'") && audienceController.includes("'queueId'") &&
    audienceController.includes("'deliveryStatus'") && audienceController.includes("'whatsappMessageId'"));
  check('51e. Audience save is transactional',
    audienceController.includes('prisma.$transaction(operations)') &&
    audienceController.includes('MAX_CAMPAIGN_RECIPIENTS = 5000'));
}

/* ------------------------------------------------------------------ *
 * Relation safety (runtime)
 * ------------------------------------------------------------------ */
async function relationTests(cookie) {
  console.log('\n--- Relation safety ---');
  // 52 — a campaign can hold several recipients
  await putJson(`/api/campaigns/${fixture.campaign1}/audience`, {
    recipientIds: [fixture.recipients.A, fixture.recipients.B, fixture.recipients.C],
  }, cookie);
  check('52. Campaign can have multiple recipients',
    (await membershipCount(fixture.campaign1)) === 3 &&
    (await audienceIds(fixture.campaign1, cookie)).length === 3);

  // 53 — the same recipient may belong to multiple campaigns.
  // Campaign Three still holds A from the selection-count demo (check 28), so it
  // is cleared first to keep the membership count exactly scoped to 1 + 2.
  await putJson(`/api/campaigns/${fixture.campaign3}/audience`, { recipientIds: [] }, cookie);
  await putJson(`/api/campaigns/${fixture.campaign2}/audience`, {
    recipientIds: [fixture.recipients.A, fixture.recipients.B],
  }, cookie);
  const sharedCount = await prisma.campaignRecipient.count({ where: { recipientId: fixture.recipients.A } });
  check('53. Same recipient can belong to multiple campaigns',
    sharedCount === 2 &&
    (await audienceIds(fixture.campaign2, cookie)).includes(fixture.recipients.A),
    'memberships for recipient A=' + sharedCount);

  // 54 — removal is per campaign only
  await putJson(`/api/campaigns/${fixture.campaign1}/audience`, {
    recipientIds: [fixture.recipients.B, fixture.recipients.C],
  }, cookie);
  check('54. Removing a recipient from Campaign A does not remove it from Campaign B',
    !(await audienceIds(fixture.campaign1, cookie)).includes(fixture.recipients.A) &&
    (await audienceIds(fixture.campaign2, cookie)).includes(fixture.recipients.A));

  // 55 / 56 — deleting a campaign cascades its memberships but never its recipients
  const recipientsBeforeDelete = await prisma.recipient.count();
  const campaignTwoAudience = await audienceIds(fixture.campaign2, cookie);
  const deleteCampaignResponse = await deleteJson(`/api/campaigns/${fixture.campaign1}`, cookie);
  createdCampaignIds.delete(fixture.campaign1);
  const campaignOneMemberships = await membershipCount(fixture.campaign1);
  check('55. Deleting Campaign A does not delete its recipients',
    deleteCampaignResponse.status === 200 && campaignOneMemberships === 0 &&
    (await prisma.recipient.count()) === recipientsBeforeDelete &&
    !!(await prisma.recipient.findUnique({ where: { id: fixture.recipients.C } })),
    'memberships after delete=' + campaignOneMemberships);
  check('56. Deleting Campaign A does not affect Campaign B audience',
    sameSet(await audienceIds(fixture.campaign2, cookie), campaignTwoAudience));
}

/* ------------------------------------------------------------------ *
 * Recipient delete safety (runtime)
 * ------------------------------------------------------------------ */
async function recipientDeleteSafetyTests(cookie) {
  console.log('\n--- Recipient delete safety ---');
  const protectedRecipient = fixture.recipients.D;
  await putJson(`/api/campaigns/${fixture.campaign3}/audience`, {
    recipientIds: [protectedRecipient],
  }, cookie);
  const blockedDelete = await deleteJson(`/api/recipients/${protectedRecipient}`, cookie);
  const stillExists = await prisma.recipient.findUnique({ where: { id: protectedRecipient } });
  check('56b. Recipient delete is blocked while it belongs to a campaign audience',
    blockedDelete.status === 409 && !!stillExists,
    'status=' + blockedDelete.status);
  check('56c. The block explains why the delete was refused',
    blockedDelete.json && blockedDelete.json.error &&
    blockedDelete.json.error.code === 'RECIPIENT_IN_CAMPAIGN' &&
    /campaign/i.test(blockedDelete.json.error.message),
    blockedDelete.json && blockedDelete.json.error && blockedDelete.json.error.code);

  await putJson(`/api/campaigns/${fixture.campaign3}/audience`, { recipientIds: [] }, cookie);
  const allowedDelete = await deleteJson(`/api/recipients/${protectedRecipient}`, cookie);
  if (allowedDelete.status === 200) createdRecipientIds.delete(protectedRecipient);
  check('56d. Recipient can be deleted once it is removed from every audience',
    allowedDelete.status === 200 &&
    !(await prisma.recipient.findUnique({ where: { id: protectedRecipient } })),
    'status=' + allowedDelete.status);
}

/* ------------------------------------------------------------------ *
 * Regression (runtime + static)
 * ------------------------------------------------------------------ */
async function regressionTests(cookie, baseline) {
  console.log('\n--- Regression ---');
  const campaignsController = readSource(CAMPAIGNS_CONTROLLER_PATH);
  const campaignsRoutes = readSource(CAMPAIGNS_ROUTES_PATH);
  const messagesRoutes = readSource(MESSAGES_ROUTES_PATH);
  const messagesController = readSource(MESSAGES_CONTROLLER_PATH);
  const recipientsRoutes = readSource(RECIPIENTS_ROUTES_PATH);
  const recipientsController = readSource(RECIPIENTS_CONTROLLER_PATH);

  const campaigns = await getJson('/api/campaigns', cookie);
  const roundTrip = await postJson('/api/campaigns', { name: 'Phase42 Regression ' + RUN }, cookie);
  const roundTripId = roundTrip.json && roundTrip.json.data && roundTrip.json.data.id;
  if (roundTripId) createdCampaignIds.add(roundTripId);
  const roundTripPatch = roundTripId
    ? await patchJson('/api/campaigns/' + roundTripId, { status: 'READY' }, cookie)
    : { status: 0 };
  const roundTripDelete = roundTripId ? await deleteJson('/api/campaigns/' + roundTripId, cookie) : { status: 0 };
  if (roundTripDelete.status === 200) createdCampaignIds.delete(roundTripId);
  check('57. Campaign foundation API remains intact (test-4-1 surface)',
    campaigns.status === 200 && Array.isArray(campaigns.json.data) &&
    roundTrip.status === 201 && roundTripPatch.status === 200 &&
    roundTripPatch.json.data.status === 'READY' && roundTripDelete.status === 200 &&
    campaignsRoutes.includes('getCampaigns') && campaignsRoutes.includes('deleteCampaign') &&
    campaignsController.includes('export const createCampaign'),
    'list=' + campaigns.status + ' create=' + roundTrip.status);

  // 60 — message detail: the shared database normally has no Message records,
  // so seed one through the real Message API first. This keeps the regression
  // check meaningful (it must read an actual existing Message record) instead
  // of passing vacuously. The fixture is removed again below so the baseline
  // message set stays untouched.
  const messageFixture = await postJson('/api/messages', {
    name: 'Phase42 Regression Message ' + RUN,
    body: 'Phase 4.2 regression fixture body',
    language: 'Hindi',
    status: 'DRAFT',
  }, cookie);
  const messageFixtureId = messageFixture.json && messageFixture.json.data && messageFixture.json.data.id;
  if (messageFixtureId) createdMessageIds.add(messageFixtureId);
  check('60 setup: temporary message fixture created',
    messageFixture.status === 201 && !!messageFixtureId, 'status=' + messageFixture.status);

  const listMessages = await getJson('/api/messages', cookie);
  check('58. Existing Message API remains intact',
    listMessages.status === 200 && Array.isArray(listMessages.json.data) &&
    listMessages.json.data.length >= baseline.messages &&
    (!messageFixtureId || listMessages.json.data.some((message) => message.id === messageFixtureId)) &&
    messagesRoutes.includes("router.get('/'") && messagesController.includes('export const getMessages'),
    'messages=' + (listMessages.json && listMessages.json.data && listMessages.json.data.length));
  const recipients = await getJson('/api/recipients', cookie);
  check('59. Recipient/import code remains intact',
    recipients.status === 200 && Array.isArray(recipients.json.data) &&
    recipients.json.data.length >= baseline.recipients &&
    recipientsRoutes.includes('router.use(requireAuth)') &&
    recipientsRoutes.includes('importRecipients') && recipientsRoutes.includes('checkImportDuplicates') &&
    recipientsController.includes('export const getRecipients') &&
    recipientsController.includes('export const importRecipients') &&
    readSource(IMPORTS_ROUTES_PATH).includes('previewImport'),
    'recipients=' + (recipients.json && recipients.json.data && recipients.json.data.length));

  const mediaRoutes = readSource(MEDIA_ROUTES_PATH);
  const existingMessage = messageFixtureId || baseline.messageIds[0] || null;
  const readExisting = existingMessage ? await getJson('/api/messages/' + existingMessage, cookie) : { status: 0, json: null };
  const tagsList = await getJson('/api/tags', cookie);
  check('60. Message detail, tags and media routes remain intact',
    !!existingMessage && readExisting.status === 200 &&
    readExisting.json && readExisting.json.success === true && readExisting.json.data &&
    readExisting.json.data.id === existingMessage &&
    readExisting.json.data.name === 'Phase42 Regression Message ' + RUN &&
    tagsList.status === 200 && Array.isArray(tagsList.json.data) &&
    mediaRoutes.includes("router.get('/:id'") &&
    readSource(MEDIA_CONTROLLER_PATH).includes('export const upload'),
    'message=' + (existingMessage || 'none') + ' detail=' + readExisting.status);

  // Restore the message baseline immediately (the cleanup block is the backstop).
  if (messageFixtureId) {
    const messageCleanup = await deleteJson('/api/messages/' + messageFixtureId, cookie);
    if (messageCleanup.status === 200) createdMessageIds.delete(messageFixtureId);
  }
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  console.log('=== Phase 4.2: Campaign Audience Selection ===\n');
  process.env.PORT = String(TEST_PORT);
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };
  require('tsx/cjs');
  const indexModule = require('./apps/server/src/index.ts');
  serverWorker = indexModule.worker || null;
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
  baseline.messageIds = [...baselineIds.messages];
  const storageFilesBefore = fs.existsSync(STORAGE_DIR) ? fs.readdirSync(STORAGE_DIR) : [];
  console.log('Baseline counts:', JSON.stringify(baseline));

  const email = 'phase42-' + RUN + '@example.com';
  const password = 'Phase42-' + RUN + '-pw!';
  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;

  const loginRes = await request('POST', '/api/auth/login', JSON.stringify({ email, password }), null, 'application/json');
  const cookie = loginRes.setCookie ? loginRes.setCookie.split(';')[0] : null;
  check('0b. Temporary admin user can authenticate', cookie !== null);

  try {
    schemaTests();
    routeWiringTests();
    await authTests();
    await createFixtures(cookie);
    await getTests(cookie);
    await putTests(cookie);
    await selectionTests(cookie);
    await searchFilterTests(cookie);
    frontendTests();
    safetyTests();
    await relationTests(cookie);
    await recipientDeleteSafetyTests(cookie);
    await regressionTests(cookie, baseline);
  } catch (error) {
    failures++;
    console.error('Unexpected test error:', error && error.stack ? error.stack : error);
  } finally {
    for (const id of createdTagIds) {
      try { await prisma.tag.delete({ where: { id } }); } catch { }
    }
    for (const id of createdCampaignIds) {
      try { await prisma.campaign.delete({ where: { id } }); } catch { }
    }
    for (const id of createdMessageIds) {
      try { await prisma.message.delete({ where: { id } }); } catch { }
    }
    for (const id of createdRecipientIds) {
      try { await prisma.recipient.delete({ where: { id } }); } catch { }
    }
    if (tempUserId) {
      try { await prisma.user.delete({ where: { id: tempUserId } }); } catch { }
      tempUserId = null;
    }
  }

  console.log('\n--- Database safety ---');
  const finalCampaigns = await prisma.campaign.findMany({ select: { id: true } });
  const finalUsers = await prisma.user.findMany({ select: { id: true } });
  const finalRecipients = await prisma.recipient.findMany({ select: { id: true } });
  const finalMessages = await prisma.message.findMany({ select: { id: true } });
  const finalMedia = await prisma.media.findMany({ select: { id: true } });
  const finalMemberships = await prisma.campaignRecipient.count();

  check('61. Temporary campaigns cleaned up',
    finalCampaigns.length === baseline.campaigns &&
    finalCampaigns.every((c) => !createdCampaignIds.has(c.id)),
    'before=' + baseline.campaigns + ' after=' + finalCampaigns.length);
  check('62. Temporary audience memberships cleaned up',
    finalMemberships === baseline.memberships,
    'before=' + baseline.memberships + ' after=' + finalMemberships);
  check('63. Existing recipients unchanged',
    finalRecipients.length === baseline.recipients && finalRecipients.every((r) => baselineIds.recipients.has(r.id)),
    'before=' + baseline.recipients + ' after=' + finalRecipients.length);
  check('64. Existing messages unchanged',
    finalMessages.length === baseline.messages && finalMessages.every((m) => baselineIds.messages.has(m.id)),
    'before=' + baseline.messages + ' after=' + finalMessages.length);
  check('65. Existing media unchanged',
    finalMedia.length === baseline.media && finalMedia.every((m) => baselineIds.media.has(m.id)),
    'before=' + baseline.media + ' after=' + finalMedia.length);
  check('66. Existing users unchanged',
    finalUsers.length === baseline.users && finalUsers.every((u) => baselineIds.users.has(u.id)),
    'before=' + baseline.users + ' after=' + finalUsers.length);

  const storageFilesAfter = fs.existsSync(STORAGE_DIR) ? fs.readdirSync(STORAGE_DIR) : [];
  const newFiles = storageFilesAfter.filter((f) => !storageFilesBefore.includes(f));
  check('66b. No files added to storage/uploads', newFiles.length === 0, 'new=' + newFiles.length);

  if (server) await new Promise((resolve) => server.close(resolve));
  if (serverWorker) { try { await serverWorker.stop(); } catch { } }
  await prisma.$disconnect();

  console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
