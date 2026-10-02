const fs = require('fs');
const path = require('path');

const patterns = [
  { name: 'Facebook access token (EAA...)', regex: /EAA[A-Za-z0-9]{12}/ },
  { name: 'access_token assignment', regex: /access_token\s*[:=]\s*['"][^'"]+['"]/ },
  { name: 'WHATSAPP_ACCESS_TOKEN with value', regex: /WHATSAPP_ACCESS_TOKEN\s*=\s*['"][a-zA-Z0-9_-]{20,}['"]/ },
  { name: 'WHATSAPP_BUSINESS_ACCOUNT_ID with value', regex: /WHATSAPP_BUSINESS_ACCOUNT_ID\s*=\s*['"][0-9]{10,}['"]/ },
  { name: 'WHATSAPP_PHONE_NUMBER_ID with value', regex: /WHATSAPP_PHONE_NUMBER_ID\s*=\s*['"][0-9]{10,}['"]/ },
];

function scanDir(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name === '.git') continue;
      results.push(...scanDir(fullPath));
    } else if (/\.(ts|js|cjs|mjs)$/.test(entry.name)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      for (const p of patterns) {
        if (p.regex.test(content)) {
          results.push({ file: fullPath, pattern: p.name });
        }
      }
    }
  }
  return results;
}

const results = scanDir(path.join(__dirname, 'apps'));
results.push(...scanDir(__dirname));

if (results.length === 0) {
  console.log('No secrets found in source/test files');
} else {
  console.log('Secrets found:');
  for (const r of results) console.log(' ', r.file, '-', r.pattern);
}
