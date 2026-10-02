const fs = require('fs');
const path = require('path');
const http = require('http');
const dotenv = require('dotenv');
const argon2 = require('argon2');

dotenv.config({ path: path.join(__dirname, '.env') });

const REPO_ROOT = __dirname;
const SERVER_INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');

const TEST_PORT = 3150;
const BASE = 'http://127.0.0.1:' + TEST_PORT;

const RUN = String(Date.now()).slice(-6);
const phoneFor = (n) => '9' + RUN + String(n);

let checks = 0;
let failures = 0;
let server = null;
let prisma = null;
let tempUserId = null;

function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
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

async function main() {
  console.log('=== Testing Execution Creation ===\n');
  process.env.PORT = String(TEST_PORT);
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function (...args) {
    server = this;
    return originalListen.apply(this, args);
  };
  require('tsx/cjs');
  require('./apps/server/src/index.ts');
  const { PrismaClient } = require('@prisma/client');
  prisma = new PrismaClient();
  const serverUp = await waitForServer(20000);
  check('0. Real server is reachable', serverUp, BASE);
  if (!serverUp) { process.exitCode = 1; return; }

  // Create test user
  const email = 'test-' + RUN + '@example.com';
  const password = 'Test-' + RUN + '-pw!';
  const createdUser = await prisma.user.create({ data: { email, password: await argon2.hash(password) } });
  tempUserId = createdUser.id;
  const loginRes = await request('POST', '/api/auth/login', JSON.stringify({ email, password }), null, 'application/json');
  const cookie = loginRes.setCookie ? loginRes.setCookie.split(';')[0] : null;
  check('0b. Test user can authenticate', cookie !== null);

  if (!cookie) {
    console.log('Failed to authenticate');
    return;
  }

  // Create test fixtures
  console.log('\n--- Creating test fixtures ---');
  
  // Create recipients
  const recipientARes = await postJson('/api/recipients', {
    name: `Test Ravi ${RUN} A`,
    whatsappNumber: phoneFor(1),
    language: 'Hindi',
    category: 'Test',
    status: 'ACTIVE',
    source: 'MANUAL',
  }, cookie);
  const recipientAId = recipientARes.json && recipientARes.json.data && recipientARes.json.data.id;
  
  const recipientBRes = await postJson('/api/recipients', {
    name: `Test Ravi ${RUN} B`,
    whatsappNumber: phoneFor(2),
    language: 'Hindi',
    category: 'Test',
    status: 'ACTIVE',
    source: 'MANUAL',
  }, cookie);
  const recipientBId = recipientBRes.json && recipientBRes.json.data && recipientBRes.json.data.id;
  
  check('Recipient A created', !!recipientAId);
  check('Recipient B created', !!recipientBId);

  // Create message
  const messageRes = await postJson('/api/messages', {
    name: `Test Message ${RUN}`,
    body: `Test body ${RUN}`,
    status: 'DRAFT',
  }, cookie);
  const messageId = messageRes.json && messageRes.json.data && messageRes.json.data.id;
  check('Message created', !!messageId);

  // Create campaign
  const campaignRes = await postJson('/api/campaigns', {
    name: `Test Campaign ${RUN}`,
    messageId: messageId,
  }, cookie);
  const campaignId = campaignRes.json && campaignRes.json.data && campaignRes.json.data.id;
  check('Campaign created', !!campaignId);

  // Add audience to campaign
  const audienceRes = await putJson(`/api/campaigns/${campaignId}/audience`, {
    recipientIds: [recipientAId, recipientBId],
  }, cookie);
  check('Audience added to campaign', audienceRes.status === 200);

  // Finalize campaign
  const finalizeRes = await postJson(`/api/campaigns/${campaignId}/finalize`, {}, cookie);
  check('Campaign finalized', finalizeRes.status === 200 && finalizeRes.json.data && finalizeRes.json.data.campaign.status === 'READY');

  // Create schedule
  const futureDate = new Date(Date.now() + 172800000).toISOString().slice(0, 16);
  const scheduleRes = await postJson(`/api/campaigns/${campaignId}/schedule`, {
    scheduledAt: futureDate,
    timezone: 'Asia/Kolkata'
  }, cookie);
  check('Schedule created', scheduleRes.status === 201 || scheduleRes.status === 200);

  // Now test execution creation
  console.log('\n--- Testing execution creation ---');
  const createRes = await postJson(`/api/campaigns/${campaignId}/execution`, {}, cookie);
  check('Execution creation successful', createRes.status === 201 || createRes.status === 200, `Status: ${createRes.status}`);
  
  if (createRes.status >= 200 && createRes.status < 300) {
    const executionId = createRes.json && createRes.json.data && createRes.json.data.execution && createRes.json.data.execution.id;
    check('Execution ID returned', !!executionId);
    
    if (executionId) {
      // Check that execution recipients were created
      const executionDetails = await prisma.campaignExecution.findUnique({
        where: { id: executionId },
        include: { recipients: true }
      });
      
      check('Execution found in DB', !!executionDetails);
      check('Has recipients', executionDetails && executionDetails.recipients.length === 2);
      
      // Check that recipient fields are set correctly
      if (executionDetails && executionDetails.recipients.length === 2) {
        const recipient = executionDetails.recipients[0];
        check('Recipient has whatsappNumber', !!recipient.whatsappNumber);
        check('Recipient has name', !!recipient.name);
        check('Recipient has status', !!recipient.status);
        check('Recipient status is PENDING', recipient.status === 'PENDING');
        check('Recipient attemptCount is 0', recipient.attemptCount === 0);
        check('Recipient providerMessageId is null', recipient.providerMessageId === null);
        check('Recipient errorCode is null', recipient.errorCode === null);
        check('Recipient errorMessage is null', recipient.errorMessage === null);
      }
    }
  } else {
    console.log('Error response:', createRes.json);
  }

  // Cleanup
  await prisma.$disconnect();
  if (server) await new Promise((resolve) => server.close(resolve));

  console.log('\n=== Test Complete ===');
  console.log(`Assertions run: ${checks} | failed: ${failures}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

function putJson(url, body, cookie) {
  return request('PUT', url, JSON.stringify(body), cookie, 'application/json');
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});