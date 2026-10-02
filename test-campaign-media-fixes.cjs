/* Focused regression coverage for local OpenWA media and campaign deletion lifecycle. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const root = __dirname;
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const mediaService = read('apps/server/src/services/publicMedia.service.ts');
const delivery = read('apps/server/src/services/executionDelivery.service.ts');
const mediaController = read('apps/server/src/controllers/media.controller.ts');
const mediaRoutes = read('apps/server/src/routes/media.routes.ts');
const campaignsController = read('apps/server/src/controllers/campaigns.controller.ts');
const campaignsPage = read('apps/web/src/pages/Campaigns.tsx');

assert.match(mediaService, /MEDIA_PUBLIC_BASE_URL/);
assert.match(mediaService, /MEDIA_PUBLIC_TOKEN_SECRET/);
assert.match(mediaService, /createHmac\('sha256'/);
assert.match(mediaService, /timingSafeEqual/);
assert.match(delivery, /buildPublicMediaUrl\(executionRecipient\.execution\.mediaId\)/);
assert.match(delivery, /sendText\(/);
assert.match(mediaRoutes, /router\.get\('\/public\/:id', getPublicMedia\)/);
assert.match(mediaRoutes, /router\.use\(requireAuth\)/);
assert.match(mediaController, /verifyPublicMediaToken/);
assert.match(mediaController, /findUnique\(\{ where: \{ id: mediaId \} \}\)/);
assert.doesNotMatch(mediaController, /req\.params\.path/);
assert.match(campaignsController, /CAMPAIGN_HAS_EXECUTION_HISTORY/);
assert.match(campaignsController, /prisma\.campaignExecution\.count/);
assert.match(campaignsController, /Archive it instead/);
assert.match(campaignsPage, /Choose what you want to do/);
assert.match(campaignsPage, /Delete permanently/);
assert.match(campaignsPage, /status: 'ARCHIVED'/);

// Exercise URL generation and token verification in an isolated process environment.
const script = `
require('tsx/cjs');
const m = require(${JSON.stringify(path.join(root, 'apps/server/src/services/publicMedia.service.ts'))});
process.env.MEDIA_PUBLIC_BASE_URL = 'http://host.docker.internal:3000';
process.env.MEDIA_PUBLIC_TOKEN_SECRET = 'test-only-secret-with-enough-entropy';
const url = m.buildPublicMediaUrl('media-123');
if (!url || !url.startsWith('http://host.docker.internal:3000/api/media/public/media-123?token=')) throw new Error(url);
const token = new URL(url).searchParams.get('token');
if (!m.verifyPublicMediaToken('media-123', token)) throw new Error('valid token rejected');
if (m.verifyPublicMediaToken('media-123', token.slice(0, -1) + '0')) throw new Error('invalid token accepted');
if (m.verifyPublicMediaToken('../secret', token)) throw new Error('path-like id accepted');
console.log('focused media URL checks passed');
`;
execFileSync(process.execPath, ['-e', script], { cwd: root, stdio: 'inherit' });
console.log('Focused campaign/media regression checks passed');
