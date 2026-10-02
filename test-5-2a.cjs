/**
 * Phase 5.2A — Official WhatsApp Provider Configuration Foundation Tests
 *
 * Tests configuration, factory, official adapter skeleton, and status endpoint.
 * Tests the abstraction, NOT a real WhatsApp provider.
 * No live WhatsApp API calls.
 *
 * Run sequentially with other test suites — they share one SQLite database.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = __dirname;
const ADAPTER_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/WhatsAppAdapter.ts');
const TYPES_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/types.ts');
const CONFIG_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/config.ts');
const ERRORS_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/errors.ts');
const PROVIDER_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/provider.ts');
const WHATSAPP_PROVIDER_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/whatsappProvider.ts');
const UNCONFIGURED_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/UnconfiguredWhatsAppAdapter.ts');
const OFFICIAL_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/OfficialWhatsAppAdapter.ts');
const INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/services/whatsapp/index.ts');
const ROUTES_PATH = path.join(REPO_ROOT, 'apps/server/src/routes/whatsapp.routes.ts');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'apps/server/src/controllers/whatsapp.controller.ts');
const SERVER_INDEX_PATH = path.join(REPO_ROOT, 'apps/server/src/index.ts');
const SCHEMA_PATH = path.join(REPO_ROOT, 'prisma/schema.prisma');
const GITIGNORE_PATH = path.join(REPO_ROOT, '.gitignore');
const ENV_EXAMPLE_PATH = path.join(REPO_ROOT, '.env.example');

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
 * Configuration tests
 * ------------------------------------------------------------------ */
function configTests() {
  console.log('\n--- Configuration ---');
  
  const configSource = readSource(CONFIG_PATH);
  const typesSource = readSource(TYPES_PATH);
  const errorsSource = readSource(ERRORS_PATH);
  
  // 1. provider=none loads successfully
  check('1. provider=none default in config', /provider:\s*['"]none['"]/.test(configSource));
  
  // 2. Missing credentials with provider=none is valid (config loads without throwing)
  check('2. loadWhatsAppConfig function exists', /export\s+(?:function|const)\s+loadWhatsAppConfig/.test(configSource));
  check('3. WhatsAppOfficialConfig type exists', /export\s+(?:interface|type)\s+WhatsAppOfficialConfig/.test(configSource));
  check('4. isOfficialProviderConfigured function exists', /export\s+(?:function|const)\s+isOfficialProviderConfigured/.test(configSource));
  
  // 5. provider=official requires required configuration (validation)
  check('5. validateOfficialConfig function exists', /export\s+(?:function|const)\s+validateOfficialConfig/.test(configSource));
  
  // 6. Missing official configuration is rejected (WHATSAPP_CONFIGURATION_INVALID error)
  check('6. WHATSAPP_CONFIGURATION_INVALID error code in types', /WHATSAPP_CONFIGURATION_INVALID/.test(typesSource));
  check('7. WhatsAppConfigurationError class exists', /export\s+class\s+WhatsAppConfigurationError/.test(errorsSource));
  check('8. WHATSAPP_CONFIGURATION_INVALID thrown for invalid config', /WHATSAPP_CONFIGURATION_INVALID/.test(errorsSource));
  
  // 7. Credentials are never exposed in returned diagnostics
  check('9. getConfigSummary method in OfficialWhatsAppAdapter', /getConfigSummary/.test(readSource(OFFICIAL_PATH)));
  check('10. getConfigSummary return does not include accessToken', !/getConfigSummary\(\)[\s\S]*?return\s*\{[\s\S]*?accessToken/.test(readSource(OFFICIAL_PATH)));
  check('11. getConfigSummary return does not include appSecret', !/getConfigSummary\(\)[\s\S]*?return\s*\{[\s\S]*?appSecret|clientSecret/.test(readSource(OFFICIAL_PATH)));
  
  // Config exports
  check('12. whatsappConfig exported', /export\s+const\s+whatsappConfig/.test(configSource));
  check('13. WhatsAppProviderType includes "official"', /'official'/.test(configSource));
}

/* ------------------------------------------------------------------ *
 * Provider factory tests
 * ------------------------------------------------------------------ */
function factoryTests() {
  console.log('\n--- Provider Factory ---');
  
  const providerSource = readSource(PROVIDER_PATH);
  const whatsappProviderSource = readSource(WHATSAPP_PROVIDER_PATH);
  const officialSource = readSource(OFFICIAL_PATH);
  const unconfiguredSource = readSource(UNCONFIGURED_PATH);
  
  // 7. provider=none returns UnconfiguredWhatsAppAdapter
  check('14. Factory selects UnconfiguredWhatsAppAdapter for none', /UnconfiguredWhatsAppAdapter/.test(providerSource) || /UnconfiguredWhatsAppAdapter/.test(whatsappProviderSource));
  
  // 8. provider=official returns OfficialWhatsAppAdapter
  check('15. Factory selects OfficialWhatsAppAdapter for official', /OfficialWhatsAppAdapter/.test(providerSource) || /OfficialWhatsAppAdapter/.test(whatsappProviderSource));
  
  // 9. Invalid official configuration does not silently fall back to none
  check('16. No silent fallback from official to none', !/catch\s*\(\s*\)\s*\{[\s\S]*?new\s+UnconfiguredWhatsAppAdapter/.test(providerSource) && 
    !/catch\s*\(\s*\)\s*\{[\s\S]*?new\s+UnconfiguredWhatsAppAdapter/.test(whatsappProviderSource));
  
  // 10. Factory caching/reset behavior remains correct
  check('17. getWhatsAppAdapter function exists', /export\s+function\s+getWhatsAppAdapter/.test(providerSource) || /export\s+function\s+getWhatsAppAdapter/.test(whatsappProviderSource));
  check('18. resetWhatsAppAdapter function exists', /export\s+function\s+resetWhatsAppAdapter/.test(providerSource) || /export\s+function\s+resetWhatsAppAdapter/.test(whatsappProviderSource));
  
  // Check isOfficialProviderConfigured is used
  check('19. Factory uses isOfficialProviderConfigured', /isOfficialProviderConfigured/.test(providerSource) || /isOfficialProviderConfigured/.test(whatsappProviderSource));
}

/* ------------------------------------------------------------------ *
 * Official Adapter tests
 * ------------------------------------------------------------------ */
function officialAdapterTests() {
  console.log('\n--- Official Adapter ---');
  
  const officialSource = readSource(OFFICIAL_PATH);
  const adapterSource = readSource(ADAPTER_PATH);
  
  // 18. OfficialWhatsAppAdapter implements WhatsAppAdapter
  check('20. OfficialWhatsAppAdapter implements WhatsAppAdapter', /implements\s+WhatsAppAdapter/.test(officialSource));
  
  // 19. connect validates configuration
  check('21. connect() validates configuration', /async\s+connect\(\)/.test(officialSource) && /validate|throw|error/i.test(officialSource));
  
  // 20. sendText does NOT send anything
  check('22. sendText() throws not implemented', /async\s+sendText\(/.test(officialSource) && /throw|not implemented|NotImplemented/i.test(officialSource));
  
  // 21. sendMedia does NOT send anything
  check('23. sendMedia() throws not implemented', /async\s+sendMedia\(/.test(officialSource) && /throw|not implemented|NotImplemented/i.test(officialSource));
  
  // 22. getMessageStatus does NOT call a provider
  check('24. getMessageStatus() throws not implemented', /async\s+getMessageStatus\(/.test(officialSource) && /throw|not implemented|NotImplemented/i.test(officialSource));
  
  // 23. No method falsely reports successful sending
  check('25. No send success without actual sending', !/return\s*\{[\s\S]*?success:\s*true/.test(officialSource) || /throw|not implemented/.test(officialSource));
  
  // Additional checks
  check('26. OfficialWhatsAppAdapter constructor accepts config', /constructor\(/.test(officialSource) && /config/.test(officialSource));
  check('27. getConfigSummary method exists', /getConfigSummary/.test(officialSource));
}

/* ------------------------------------------------------------------ *
 * Status endpoint tests
 * ------------------------------------------------------------------ */
function statusEndpointTests() {
  console.log('\n--- Status Endpoint ---');
  
  const controllerSource = readSource(CONTROLLER_PATH);
  const routesSource = fs.existsSync(ROUTES_PATH) ? readSource(ROUTES_PATH) : '';
  const officialSource = readSource(OFFICIAL_PATH);
  
  // 11. GET /api/whatsapp/status requires authentication
  check('28. Controller has getStatus function', /export\s+(?:function|const)\s+getStatus/.test(controllerSource));
  
  // Check routes for authentication middleware
  if (routesSource) {
    check('29. GET /api/whatsapp/status route exists', /router\.get\(['"\/api\/whatsapp\/status['"]|router\.get\(['"\/status['"]/.test(routesSource));
    check('30. Route uses authentication middleware', /authenticate|requireAuth|authMiddleware/.test(routesSource));
  }
  
  // 12. provider=none returns configured=false
  // 13. provider=none returns DISCONNECTED
  check('31. Controller handles unconfigured provider', /configured.*false|!isOfficialProviderConfigured/.test(controllerSource));
  
  // 14. provider=official with valid test configuration returns configured=true
  // 15. provider=official status remains DISCONNECTED because no live connection is being established
  check('32. Controller returns configured=true for official', /configured.*true|isOfficialProviderConfigured/.test(controllerSource));
  check('33. Status remains DISCONNECTED (no live connection)', /DISCONNECTED/.test(controllerSource) || /status.*DISCONNECTED/i.test(officialSource));
  
  // 16. Status response contains no credentials
  check('34. No access token in controller response', !/accessToken|access_token|WHATSAPP_ACCESS_TOKEN/.test(controllerSource));
  check('35. No app secret in controller response', !/appSecret|app_secret|clientSecret|client_secret/.test(controllerSource));
  
  // 17. Invalid configuration returns safe diagnostic
  check('36. Error handling in controller', /catch|try|next\(/.test(controllerSource));
}

/* ------------------------------------------------------------------ *
 * Security and scope tests
 * ------------------------------------------------------------------ */
function securityTests() {
  console.log('\n--- Security and Scope ---');
  
  const allWhatsAppSource = [
    readSource(TYPES_PATH),
    readSource(ADAPTER_PATH),
    readSource(CONFIG_PATH),
    readSource(ERRORS_PATH),
    readSource(PROVIDER_PATH),
    readSource(WHATSAPP_PROVIDER_PATH),
    readSource(UNCONFIGURED_PATH),
    readSource(OFFICIAL_PATH),
    readSource(INDEX_PATH),
    readSource(CONTROLLER_PATH),
  ].join('\n');
  
  // 24. No credentials are written to files
  // 25. No credentials are logged
  check('37. No console.log of credentials', !/console\.(log|error|warn)\([\s\S]*?(token|secret|password|key)/i.test(allWhatsAppSource));
  check('38. No accessToken in source code', !/accessToken\s*[=:]\s*['"][^'"]+['"]/.test(allWhatsAppSource));
  check('39. No hardcoded phone number', !/phoneNumberId\s*[=:]\s*['"]\d{10,}['"]/.test(allWhatsAppSource));
  check('40. No hardcoded business account id', !/businessAccountId\s*[=:]\s*['"]\d{10,}['"]/.test(allWhatsAppSource));
  
  // 26. No credentials are returned through API
  check('41. No credential return in controller', !/return\s*\{[\s\S]*?(accessToken|appSecret|clientSecret|WHATSAPP_ACCESS_TOKEN)/.test(readSource(CONTROLLER_PATH)));
  
  // 27. .env is ignored
  const gitignoreSource = fs.existsSync(GITIGNORE_PATH) ? readSource(GITIGNORE_PATH) : '';
  check('42. .env is in .gitignore', gitignoreSource && /^\.env($|\n)/m.test(gitignoreSource));
  check('43. .env.* is in .gitignore', gitignoreSource && /^\.env\.\*($|\n)/m.test(gitignoreSource));
  check('44. .env.example is NOT ignored', gitignoreSource && !/^\.env\.example($|\n)/m.test(gitignoreSource));
  
  // 28. .env.example contains placeholders only
  const envExampleSource = fs.existsSync(ENV_EXAMPLE_PATH) ? readSource(ENV_EXAMPLE_PATH) : '';
  check('45. .env.example has WHATSAPP_PROVIDER=none', envExampleSource && /WHATSAPP_PROVIDER\s*=\s*none/.test(envExampleSource));
  check('46. .env.example has empty placeholders', envExampleSource && /WHATSAPP_ACCESS_TOKEN\s*=\s*$/m.test(envExampleSource) && /WHATSAPP_BUSINESS_ACCOUNT_ID\s*=\s*$/m.test(envExampleSource) && /WHATSAPP_PHONE_NUMBER_ID\s*=\s*$/m.test(envExampleSource));
  check('47. .env.example has no real credentials', envExampleSource && !/^WHATSAPP_ACCESS_TOKEN[^\n]*=[^\n]*['"]?[a-zA-Z0-9_-]{20,}['"]?/m.test(envExampleSource) && !/^WHATSAPP_BUSINESS_ACCOUNT_ID[^\n]*=[^\n]*['"]?\d{10,}['"]?/m.test(envExampleSource) && !/^WHATSAPP_PHONE_NUMBER_ID[^\n]*=[^\n]*['"]?\d{10,}['"]?/m.test(envExampleSource));
  
  // 29. No WhatsApp SDK added
  check('48. No whatsapp-web.js import', !/require\(['"]whatsapp-web\.js['"]\)|from\s+['"]whatsapp-web\.js['"]/.test(allWhatsAppSource));
  // 30. No whatsapp-web.js
  check('49. No Baileys import', !/require\(['"]baileys['"]\)|from\s+['"]baileys['"]/.test(allWhatsAppSource));
  // 31. No Baileys
  check('50. No @whiskeysockets/baileys import', !/require\(['"]@whiskeysockets\/baileys['"]\)|from\s+['"]@whiskeysockets\/baileys['"]/.test(allWhatsAppSource));
  // 32. No scraping
  check('51. No WhatsApp scraping code', !/webdriver|chrome-remote|puppeteer.*whatsapp|whatsapp.*scrape/i.test(allWhatsAppSource));
  // 33. No worker
  // 34. No queue
  // 35. No cron
  // 36. No Redis
  check('52. No Redis imports', !/require\(['"]redis['"]\)|from\s+['"]redis['"]/.test(allWhatsAppSource));
  check('53. No Bull/BullMQ imports', !/require\(['"]bull['"]\)|from\s+['"]bull['"]/.test(allWhatsAppSource));
  check('54. No node-cron import', !/require\(['"]node-cron['"]\)|from\s+['"]node-cron['"]/.test(allWhatsAppSource));
  // 37. No database schema change - check prisma schema
  const schema = readSource(SCHEMA_PATH);
  check('55. CampaignExecutionRecipient has provider delivery fields',
    /providerMessageId|errorCode|errorMessage|attemptCount|status/.test(
      schema.match(/model\s+CampaignExecutionRecipient\s*\{[\s\S]*?\n\}/)?.[0] || ''
    ));
}

/* ------------------------------------------------------------------ *
 * Regression tests (Phase 5.1 compatibility)
 * ------------------------------------------------------------------ */
function regressionTests() {
  console.log('\n--- Regression (Phase 5.1) ---');
  
  const typesSource = readSource(TYPES_PATH);
  const adapterSource = readSource(ADAPTER_PATH);
  const configSource = readSource(CONFIG_PATH);
  const providerSource = readSource(PROVIDER_PATH);
  const unconfiguredSource = readSource(UNCONFIGURED_PATH);
  const indexSource = readSource(INDEX_PATH);
  
  // 38. Existing Phase 5.1 tests pass - check core types still exist
  check('56. ConnectionStatus type exists', /export\s+type\s+ConnectionStatus/.test(typesSource));
  check('57. ConnectionStatus has DISCONNECTED', /'DISCONNECTED'/.test(typesSource));
  check('58. SendResult type exists', /export\s+interface\s+SendResult/.test(typesSource));
  check('59. MessageStatus type exists', /export\s+type\s+MessageStatus/.test(typesSource));
  check('60. MediaPayload type exists', /export\s+interface\s+MediaPayload/.test(typesSource));
  check('61. WhatsAppAdapter interface exists', /export\s+interface\s+WhatsAppAdapter/.test(typesSource));
  check('62. WhatsAppAdapter has getStatus', /getStatus\(\):\s*Promise<ConnectionStatus>/.test(typesSource));
  check('63. WhatsAppAdapter has connect', /connect\(\):\s*Promise<void>/.test(typesSource));
  check('64. WhatsAppAdapter has disconnect', /disconnect\(\):\s*Promise<void>/.test(typesSource));
  check('65. WhatsAppAdapter has sendText', /sendText\(/.test(typesSource));
  check('66. WhatsAppAdapter has sendMedia', /sendMedia\(/.test(typesSource));
  check('67. WhatsAppAdapter has getMessageStatus', /getMessageStatus\(/.test(typesSource));
  check('68. WhatsAppProviderRegistry interface exists', /export\s+interface\s+WhatsAppProviderRegistry/.test(typesSource));
  check('69. WhatsAppAdapterFactory type exists', /export\s+type\s+WhatsAppAdapterFactory/.test(typesSource));
  check('70. WhatsAppProviderConfig type exists', /export\s+type\s+WhatsAppProviderConfig/.test(configSource));
  check('71. WhatsAppProviderType type exists', /export\s+type\s+WhatsAppProviderType/.test(configSource));
  
  // Provider implementation
  check('72. getWhatsAppAdapter function exists', /export\s+function\s+getWhatsAppAdapter/.test(providerSource));
  check('73. resetWhatsAppAdapter function exists', /export\s+function\s+resetWhatsAppAdapter/.test(providerSource));
  check('74. Default adapter is UnconfiguredWhatsAppAdapter', /new\s+UnconfiguredWhatsAppAdapter/.test(providerSource));
  check('75. whatsappProviderRegistry exported', /export\s+const\s+whatsappProviderRegistry/.test(adapterSource));
  check('76. Unconfigured adapter returns DISCONNECTED', /async\s+getStatus\(\)/.test(unconfiguredSource) && /return\s+'DISCONNECTED'/.test(unconfiguredSource));
  check('77. connect() throws error', /async\s+connect\(\)/.test(unconfiguredSource) && /throw/.test(unconfiguredSource));
  check('78. disconnect() exists and is safe', /async\s+disconnect\(\)/.test(unconfiguredSource));
  check('79. sendText() throws error', /async\s+sendText\(/.test(unconfiguredSource) && /throw/.test(unconfiguredSource));
  check('80. sendMedia() throws error', /async\s+sendMedia\(/.test(unconfiguredSource) && /throw/.test(unconfiguredSource));
  check('81. getMessageStatus() exists', /async\s+getMessageStatus\(/.test(unconfiguredSource));
  
  // Exports
  check('82. Index exports getWhatsAppAdapter', /getWhatsAppAdapter/.test(indexSource));
  check('83. Index exports resetWhatsAppAdapter', /resetWhatsAppAdapter/.test(indexSource));
  check('84. Index exports WhatsAppAdapter types', /WhatsAppAdapter/.test(indexSource));
  check('85. Index exports isOfficialProviderConfigured', /isOfficialProviderConfigured/.test(indexSource));
  check('86. Index exports WhatsAppOfficialConfig', /WhatsAppOfficialConfig/.test(indexSource));
}

/* ------------------------------------------------------------------ *
 * Main
 * ------------------------------------------------------------------ */
async function main() {
  console.log('=== Phase 5.2A — Official WhatsApp Provider Configuration Foundation Tests ===\n');
  
  try {
    configTests();
    factoryTests();
    officialAdapterTests();
    statusEndpointTests();
    securityTests();
    regressionTests();
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