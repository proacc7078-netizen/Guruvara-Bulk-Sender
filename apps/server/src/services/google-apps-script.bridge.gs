/**
 * Phase 6.0B — Google Apps Script bridge (paste into the Sheet's Apps Script).
 *
 * No Google Cloud billing required. Runs as the spreadsheet owner; the Sheet stays private.
 * Auth: shared secret stored in Script Properties (key: CMS_SHARED_SECRET),
 * sent by the CMS as `?token=` (Apps Script cannot reliably expose the
 * Authorization header to the CMS, so the query parameter is the contract).
 */

var SHEET_TAB_NAME = 'Form Responses 1';
var TOKEN_PROPERTY = 'CMS_SHARED_SECRET';
var SPREADSHEET_ID_PROPERTY = 'GOOGLE_SHEETS_SPREADSHEET_ID';
var MAX_ROWS = 5000;

function getSharedSecret() {
  return PropertiesService.getScriptProperties().getProperty(TOKEN_PROPERTY) || '';
}

function getConfiguredSpreadsheetId() {
  return String(PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROPERTY) || '').trim();
}

function isAuthorized(e) {
  var expected = getSharedSecret();
  if (!expected) return false;
  var params = (e && e.parameter) || {};
  if (params.token && params.token === expected) return true;
  if (params.action === 'ping') {
    // Ping still requires the token; fall through to deny.
  }
  return false;
}

function findColumnIndexes(headers) {
  var nameIdx = -1;
  var phoneIdx = -1;
  var consentIdx = -1;
  var languageIdx = -1;
  for (var i = 0; i < headers.length; i++) {
    var h = String(headers[i] || '').trim().toLowerCase();
    if (h === 'name') nameIdx = i;
    if (h === 'whatsapp number' || h === 'whatsapp' || h === 'phone') phoneIdx = i;
    if (h.indexOf('i agree') === 0) consentIdx = i;
    // Language column from the Google Form, e.g.
    // "Preferred Language to Receive Updates". Matched loosely so a reworded
    // form question still resolves.
    if (h === 'language' || h.indexOf('language') !== -1) languageIdx = i;
  }
  if (consentIdx === -1) {
    for (var j = 0; j < headers.length; j++) {
      var c = String(headers[j] || '').trim().toLowerCase();
      if (c === 'consent' || c.indexOf('consent') !== -1) {
        consentIdx = j;
        break;
      }
    }
  }
  if (consentIdx === -1) {
    // This form asks the consent question as a full sentence, e.g.
    // "Would you like to receive WhatsApp updates from <Org>?".
    for (var k = 0; k < headers.length; k++) {
      var q = String(headers[k] || '').trim().toLowerCase();
      if (q.indexOf('would you like to receive') === 0) {
        consentIdx = k;
        break;
      }
    }
  }
  return { nameIdx: nameIdx, phoneIdx: phoneIdx, consentIdx: consentIdx, languageIdx: languageIdx };
}

function readRows() {
  var spreadsheetId = getConfiguredSpreadsheetId();
  if (!spreadsheetId) {
    // No relying on the active-spreadsheet context (a Web App deployment has none).
    throw new Error('MISSING_SPREADSHEET_ID: set Script Property ' + SPREADSHEET_ID_PROPERTY);
  }
  var ss = SpreadsheetApp.openById(spreadsheetId);
  if (!ss) {
    throw new Error('SPREADSHEET_NOT_FOUND: check ' + SPREADSHEET_ID_PROPERTY);
  }
  var sheet = ss.getSheetByName(SHEET_TAB_NAME);
  if (!sheet) {
    throw new Error('TAB_NOT_FOUND: no tab named "' + SHEET_TAB_NAME + '" in the configured spreadsheet');
  }
  var values = sheet.getDataRange().getValues();
  if (!values || values.length < 2) {
    return { headers: values && values[0] ? values[0] : [], rows: [] };
  }
  var headers = values[0].map(function (h) { return String(h || ''); });
  var idx = findColumnIndexes(headers);
  var rows = [];
  var limit = Math.min(values.length, MAX_ROWS + 1);
  for (var r = 1; r < limit; r++) {
    var line = values[r];
    rows.push({
      timestamp: String(line[0] || ''),
      name: idx.nameIdx >= 0 ? String(line[idx.nameIdx] || '') : '',
      whatsappNumber: idx.phoneIdx >= 0 ? String(line[idx.phoneIdx] || '') : '',
      consent: idx.consentIdx >= 0 ? String(line[idx.consentIdx] || '') : '',
      language: idx.languageIdx >= 0 ? String(line[idx.languageIdx] || '') : '',
    });
  }
  return { headers: headers, rows: rows, tabName: sheet.getName() };
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  if (!isAuthorized(e)) {
    return jsonOut({ success: false, error: 'UNAUTHORIZED' });
  }
  var params = (e && e.parameter) || {};
  if (params.action === 'ping') {
    return jsonOut({ success: true, message: 'Apps Script bridge reachable.' });
  }
  try {
    var data = readRows();
    return jsonOut({ success: true, headers: data.headers, tabName: data.tabName, rows: data.rows });
  } catch (err) {
    // Diagnostic-only: surface a safe, sanitized failure code so the exact
    // readRows() condition can be identified without leaking contents,
    // secrets or stack traces. Unknown errors still collapse to READ_FAILED.
    return jsonOut({ success: false, error: safeReadErrorCode(err) });
  }
}

// Maps a readRows() exception onto an allow-listed code.
// Only these four codes are ever returned; raw exception text is never echoed.
var READ_ERROR_CODES = ['MISSING_SPREADSHEET_ID', 'SPREADSHEET_NOT_FOUND', 'TAB_NOT_FOUND'];

function safeReadErrorCode(err) {
  var msg = (err && err.message) ? String(err.message) : '';
  for (var i = 0; i < READ_ERROR_CODES.length; i++) {
    var code = READ_ERROR_CODES[i];
    if (msg.indexOf(code) !== -1) return code;
  }
  return 'READ_FAILED';
}
