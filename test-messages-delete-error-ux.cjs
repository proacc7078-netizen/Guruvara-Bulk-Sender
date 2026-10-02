/**
 * Regression: the Messages single-row delete must surface the backend error
 * message (notably MESSAGE_IN_CAMPAIGN) instead of a hard-coded generic string.
 *
 * The repo has no component-test framework for the web app (no vitest/jest), so
 * this follows the established convention (test-3-3 / test-3-5): assert the
 * page source, then execute the exact error-resolution expression against
 * representative Axios rejection shapes to prove the behaviour.
 *
 * No backend, database, API or provider call is made. The real japa.db is never
 * opened; the backend error payloads below are the literal shapes that
 * deleteMessage returns.
 */
const fs = require('fs');
const path = require('path');

const MESSAGES_PATH = path.join(__dirname, 'apps/web/src/pages/Messages.tsx');
const src = fs.readFileSync(MESSAGES_PATH, 'utf8');

let checks = 0, failures = 0;
function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log((cond ? 'PASS' : 'FAIL') + ': ' + name + (extra !== undefined ? ' | ' + String(extra) : ''));
}

/* ---------------- 1. source contract ---------------- */
const handler = (src.match(/const handleConfirmDelete = async \(\) => \{[\s\S]*?\n  \};/) || [''])[0];
check('1. handleConfirmDelete located', handler.length > 0);

check('1a. catch clause binds the error', /catch\s*\(\s*err\s*:\s*any\s*\)/.test(handler),
  (handler.match(/catch[^\n]*/) || ['none'])[0]);
check('1b. reads the backend error message', /err\.response\?\.data\?\.error\?\.message/.test(handler));
check('1c. keeps the generic fallback', /\|\|\s*'Failed to delete message\.'/.test(handler));
check('1d. no longer a bare catch with a hard-coded only message',
  !/catch\s*\{\s*setDeleteError\('Failed to delete message\.'\);/.test(handler));
check('1e. the delete API call itself is unchanged',
  /axios\.delete<\{ success: boolean \}>\(\s*`\/api\/messages\/\$\{deleteMessage\.id\}`\s*\)/.test(handler));
check('1f. success path still removes the row and closes the modal',
  /setMessages\(\(prev\) => prev\.filter\(\(m\) => m\.id !== deleteMessage\.id\)\)/.test(handler) &&
  /setShowDelete\(false\)/.test(handler));
check('1g. modal still renders deleteError', /\{deleteError && \(/.test(src));

/* ---------------- 2. behavioural check of the resolution expression ----------------
 * Evaluates the exact expression the page now uses against the real payload
 * shapes. Built as a function so the semantics are asserted, not just the text.
 */
const GENERIC = 'Failed to delete message.';
const resolve = (err) => (err?.response?.data?.error?.message) || GENERIC;

const inCampaign = {
  response: {
    status: 409,
    data: { success: false, error: { code: 'MESSAGE_IN_CAMPAIGN', message: 'Message is used by 1 active campaign. Archive those campaigns or the message instead.' } },
  },
};
check('2. MESSAGE_IN_CAMPAIGN shows the backend message',
  resolve(inCampaign) === 'Message is used by 1 active campaign. Archive those campaigns or the message instead.',
  resolve(inCampaign));
check('2a. plural count wording comes from the backend verbatim',
  resolve({ response: { data: { error: { code: 'MESSAGE_IN_CAMPAIGN', message: 'Message is used by 3 active campaigns. Archive those campaigns or the message instead.' } } } })
  === 'Message is used by 3 active campaigns. Archive those campaigns or the message instead.');

check('3. generic fallback for a network error (no response)', resolve({}) === GENERIC, resolve({}));
check('3a. generic fallback for a thrown Error', resolve(new Error('boom')) === GENERIC, resolve(new Error('boom')));
check('3b. generic fallback when the response has no error body', resolve({ response: { status: 500, data: {} } }) === GENERIC);
check('3c. generic fallback when the body has an error but no message', resolve({ response: { data: { error: { code: 'X' } } } }) === GENERIC);

check('4. NOT_FOUND surfaces the backend message', resolve({ response: { status: 404, data: { error: { code: 'NOT_FOUND', message: 'Message not found' } } } }) === 'Message not found');
check('4a. 500 INTERNAL_ERROR surfaces the backend message', resolve({ response: { status: 500, data: { error: { code: 'INTERNAL_ERROR', message: 'Failed to delete message' } } } }) === 'Failed to delete message');

/* ---------------- 3. the page must not duplicate the campaign wording ---------------- */
check('5. frontend does not re-implement the campaign-count wording',
  !/active campaign/i.test(src), (src.match(/active campaign/gi) || []).length + ' occurrence(s)');

console.log('\nAssertions run: ' + checks + ' | failed: ' + failures);
console.log('=== ' + (failures === 0 ? 'All checks passed' : failures + ' check(s) FAILED') + ' ===');
process.exitCode = failures === 0 ? 0 : 1;