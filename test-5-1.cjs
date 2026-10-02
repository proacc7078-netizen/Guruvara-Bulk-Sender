/**
 * Phase 5.1 — WhatsApp Adapter Foundation Tests
 *
 * Tests the provider-independent WhatsApp adapter abstraction.
 * Tests the abstraction, NOT a real WhatsApp provider.
 *
 * Run sequentially with other test suites — they share one SQLite database.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = __dirname;
const ADAPTER_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/WhatsAppAdapter.ts');
const TYPES_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/types.ts');
const CONFIG_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/config.ts');
const PROVIDER_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/whatsappProvider.ts');
const UNCONFIGURED_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/UnconfiguredWhatsAppAdapter.ts');
const INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/index.ts');
const ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/whatsapp.routes.ts');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/whatsapp.controller.ts');
const CAMPAIGN_EXECUTION_UTIL_PATH = path.join(REPO_ROOT, 'apps/server/src/utils/campaignExecution.util.ts');
const CAMPAIGN_EXECUTION_CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/campaignExecution.controller.ts');
const SERVER_INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma/schema.prisma');

let checks = 0;
let failures = 0;

function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra ? ' | ' + extra : ''));
}

function readSource(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/* ------------------------------------------------------------------ *
 * Type existence tests
 * ------------------------------------------------------------------ */
function typeTests() {
  console.log('\n--- Type existence ---');
  
  const typesSource = readSource(TYPES_PATH);
  const adapterSource = readSource(ADAPTER_PATH);
  const configSource = readSource(CONFIG_PATH);
  
  check('1. ConnectionStatus type exists', /export\s+type\s+ConnectionStatus/.test(typesSource));
  check('2. ConnectionStatus has DISCONNECTED', /'DISCONNECTED'/.test(typesSource));
  check('3. ConnectionStatus has CONNECTING', /'CONNECTING'/.test(typesSource));
  check('4. ConnectionStatus has CONNECTED', /'CONNECTED'/.test(typesSource));
  check('5. SendResult type exists', /export\s+interface\s+SendResult/.test(typesSource));
  check('6. SendResult has success field', /success:\s*boolean/.test(typesSource));
  check('7. SendResult has providerMessageId?', /providerMessageId\s*\?/.test(typesSource));
  check('8. SendResult has errorCode?', /errorCode\s*\?/.test(typesSource));
  check('9. SendResult has errorMessage?', /errorMessage\s*\?/.test(typesSource));
  check('10. MessageStatus type exists', /export\s+type\s+MessageStatus/.test(typesSource));
  check('11. MessageStatus has UNKNOWN', /'UNKNOWN'/.test(typesSource));
  check('12. MessageStatus has QUEUED', /'QUEUED'/.test(typesSource));
  check('13. MessageStatus has SENT', /'SENT'/.test(typesSource));
  check('14. MessageStatus has DELIVERED', /'DELIVERED'/.test(typesSource));
  check('15. MessageStatus has READ', /'READ'/.test(typesSource));
  check('16. MessageStatus has FAILED', /'FAILED'/.test(typesSource));
  check('17. MediaPayload type exists', /export\s+interface\s+MediaPayload/.test(typesSource));
  check('18. MediaPayload has path', /path:\s*string/.test(typesSource));
  check('19. MediaPayload has mimeType', /mimeType:\s*string/.test(typesSource));
  check('20. MediaPayload has filename?', /filename\s*\?/.test(typesSource));
  check('21. WhatsAppAdapter interface exists', /export\s+interface\s+WhatsAppAdapter/.test(typesSource));
  check('22. WhatsAppAdapter has getStatus', /getStatus\(\):\s*Promise<ConnectionStatus>/.test(typesSource));
  check('23. WhatsAppAdapter has connect', /connect\(\):\s*Promise<void>/.test(typesSource));
  check('24. WhatsAppAdapter has disconnect', /disconnect\(\):\s*Promise<void>/.test(typesSource));
  check('25. WhatsAppAdapter has sendText', /sendText\(/.test(typesSource));
  check('26. WhatsAppAdapter has sendMedia', /sendMedia\(/.test(typesSource));
  check('27. WhatsAppAdapter has getMessageStatus', /getMessageStatus\(/.test(typesSource));
  check('28. WhatsAppProviderRegistry interface exists', /export\s+interface\s+WhatsAppProviderRegistry/.test(typesSource));
  check('29. WhatsAppAdapterFactory type exists', /export\s+type\s+WhatsAppAdapterFactory/.test(typesSource));
  // Phase 5.2+: WhatsAppProviderConfig is a discriminated union type.
  check('30. WhatsAppProviderConfig type exists', /export\s+(?:interface|type)\s+WhatsAppProviderConfig/.test(configSource));
  check('31. WhatsAppProviderType type exists', /export\s+type\s+WhatsAppProviderType/.test(configSource));
}
/* ------------------------------------------------------------------ *
 * Provider implementation tests
 * ------------------------------------------------------------------ */
function providerTests() {
  console.log('\n--- Provider implementation ---');
  
  const providerSource = readSource(PROVIDER_PATH);
  const unconfiguredSource = readSource(UNCONFIGURED_PATH);
  const adapterSource = readSource(ADAPTER_PATH);
  
  check('32. getWhatsAppAdapter function exists', /export\s+function\s+getWhatsAppAdapter/.test(providerSource));
  check('33. resetWhatsAppAdapter function exists', /export\s+function\s+resetWhatsAppAdapter/.test(providerSource));
  check('34. Default adapter is UnconfiguredWhatsAppAdapter', /new\s+UnconfiguredWhatsAppAdapter/.test(providerSource));
  check('35. whatsappProviderRegistry exported', /export\s+const\s+whatsappProviderRegistry/.test(adapterSource));
  check('36. Unconfigured adapter returns DISCONNECTED', /async\s+getStatus\(\)/.test(unconfiguredSource) && /return\s+'DISCONNECTED'/.test(unconfiguredSource));
  check('37. connect() throws error', /async\s+connect\(\)/.test(unconfiguredSource) && /throw/.test(unconfiguredSource));
  check('38. disconnect() exists and is safe', /async\s+disconnect\(\)/.test(unconfiguredSource));
  check('39. sendText() throws error', /async\s+sendText\(/.test(unconfiguredSource) && /throw/.test(unconfiguredSource));
  check('40. sendMedia() throws error', /async\s+sendMedia\(/.test(unconfiguredSource) && /throw/.test(unconfiguredSource));
  check('41. getMessageStatus() exists', /async\s+getMessageStatus\(/.test(unconfiguredSource));
}

/* ------------------------------------------------------------------ *
 * Security and scope tests
 * ------------------------------------------------------------------ */
function securityTests() {
  console.log('\n--- Security and scope ---');
  
  const allWhatsAppSource = [
    readSource(TYPES_PATH),
    readSource(ADAPTER_PATH),
    readSource(CONFIG_PATH),
    readSource(PROVIDER_PATH),
    readSource(UNCONFIGURED_PATH),
    readSource(INDEX_PATH),
  ].join('\n');
  
  const serverSource = readSource(SERVER_INDEX_PATH);
  const campaignExecUtil = readSource(CAMPAIGN_EXECUTION_UTIL_PATH);
  const campaignExecController = readSource(CAMPAIGN_EXECUTION_CONTROLLER_PATH);
  
  check('42. No WhatsApp API token in source', !/\b(whatsapp.*token|WA_TOKEN|whatsapp_api_key)\s*[=:]\s*['"]/.test(allWhatsAppSource));
  check('43. No phone number credentials', !/\b(whatsapp.*phone|WA_PHONE|whatsapp_number)\s*[=:]\s*['"]?\+?\d{10,}/.test(allWhatsAppSource));
  check('44. No whatsapp-web.js import', !/require\(['"]whatsapp-web\.js['"]\)|from\s+['"]whatsapp-web\.js['"]/.test(allWhatsAppSource));
  check('45. No Baileys import', !/require\(['"]baileys['"]\)|from\s+['"]baileys['"]/.test(allWhatsAppSource));
  check('46. No @whiskeysockets/baileys import', !/require\(['"]@whiskeysockets\/baileys['"]\)|from\s+['"]@whiskeysockets\/baileys['"]/.test(allWhatsAppSource));
  check('47. No WhatsApp scraping code', !/webdriver|chrome-remote|puppeteer.*whatsapp|whatsapp.*scrape/i.test(allWhatsAppSource));
  check('48. No Redis imports', !/require\(['"]redis['"]\)|from\s+['"]redis['"]/.test(allWhatsAppSource));
  check('49. No Bull/BullMQ imports', !/require\(['"]bull['"]\)|from\s+['"]bull['"]/.test(allWhatsAppSource));
  check('50. No node-cron import', !/require\(['"]node-cron['"]\)|from\s+['"]node-cron['"]/.test(allWhatsAppSource));
  check('51. CampaignExecution util does not import WhatsAppAdapter', !/from\s+['"][^'"]*whatsapp/i.test(campaignExecUtil) && !/require\(['"][^'"]*whatsapp/i.test(campaignExecUtil));
  check('52. CampaignExecution controller does not import WhatsAppAdapter', !/from\s+['"][^'"]*whatsapp/i.test(campaignExecController) && !/require\(['"][^'"]*whatsapp/i.test(campaignExecController));
  check('53. No POST /api/whatsapp/send endpoint', !/router\.post\(['"]\/api\/whatsapp\/send['"]/.test(serverSource) && !/router\.post\(['"]\/whatsapp\/send['"]/.test(serverSource));
  
  let routesSource = '';
  if (fs.existsSync(ROUTES_PATH)) {
    routesSource = readSource(ROUTES_PATH);
  }
  // Phase 5.3: exactly one POST route is allowed — the manual test endpoint /send-test.
  const postRoutes = (routesSource.match(/router\.post\(\s*['"]([^'"]+)['"]/g) || [])
    .map((m) => m.replace(/router\.post\(\s*['"]/, '').replace(/['"]$/, ''));
  const allowedPosts = postRoutes.filter((r) => r === '/send-test');
  check('54. WhatsApp routes mutate only via POST /send-test (if any)', !routesSource || (!/router\.patch/i.test(routesSource) && !/router\.put/i.test(routesSource) && !/router\.delete/i.test(routesSource) && postRoutes.length === allowedPosts.length));
}

/* ------------------------------------------------------------------ *
 * Configuration tests
 * ------------------------------------------------------------------ */
function configTests() {
  console.log('\n--- Configuration ---');
  
  const configSource = readSource(CONFIG_PATH);
  
  check('55. Default provider is "none"', /provider:\s*['"]none['"]/.test(configSource));
  check('56. No credentials in config', !/\b(token|apiKey|api_key|password|secret)\s*[:=]/i.test(configSource));
}

/* ------------------------------------------------------------------ *
 * HTTP endpoint tests (if endpoint exists)
 * ------------------------------------------------------------------ */
function endpointTests() {
  console.log('\n--- HTTP endpoint (if present) ---');
  
  if (!fs.existsSync(ROUTES_PATH)) {
    check('57. WhatsApp status endpoint not added (acceptable)', true);
    return;
  }
  
  const routesSource = readSource(ROUTES_PATH);
  const controllerSource = fs.existsSync(CONTROLLER_PATH) ? readSource(CONTROLLER_PATH) : '';
  
  // Phase 5.3: exactly one POST route is allowed — the manual test endpoint /send-test.
  const postRoutes = (routesSource.match(/router\.post\(\s*['"]([^'"]+)['"]/g) || [])
    .map((m) => m.replace(/router\.post\(\s*['"]/, '').replace(/['"]$/, ''));
  const allowedPosts2 = postRoutes.filter((r) => r === '/send-test');
  check('58. WhatsApp routes expose only GET + POST /send-test (if present)',
    !/router\.patch|router\.put|router\.delete/i.test(routesSource) && postRoutes.length === allowedPosts2.length);
  
  if (controllerSource) {
    check('59. Status endpoint returns configured flag', /configured/.test(controllerSource));
    check('60. Status endpoint returns status', /status/.test(controllerSource));
  }
}

/* ------------------------------------------------------------------ *
 * Schema tests
 * ------------------------------------------------------------------ */
function schemaTests() {
  console.log('\n--- Schema ---');
  
  const schema = readSource(SCHEMA_PATH);
  
  check('61. CampaignExecutionRecipient has provider delivery fields',
    /providerMessageId|errorCode|errorMessage|attemptCount|status/.test(
      schema.match(/model\s+CampaignExecutionRecipient\s*\{[\s\S]*?\n\}/)?.[0] || ''
    ));
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  console.log('=== Phase 5.1 — WhatsApp Adapter Foundation Tests ===\n');
  
  try {
    typeTests();
    providerTests();
    securityTests();
    configTests();
    endpointTests();
    schemaTests();
  } catch (error) {
    failures++;
    console.error('Unexpected test error:', error && error.stack ? error.stack : error);
  }
  
  console.log('\n--- Summary ---');
  console.log('Assertions run: ' + checks + ' | failed: ' + failures);
  console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('Error:', error && error.stack ? error.stack : error);
  process.exitCode = 1;
});

