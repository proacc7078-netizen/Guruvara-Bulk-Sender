const { execSync } = require('child_process');
try {
  execSync('npx tsc --noEmit', { cwd: 'apps/server', stdio: 'pipe' });
  console.log('TSC_OK');
} catch (e) {
  require('fs').writeFileSync('_tsc5.txt', e.stderr || String(e));
  console.log('TSC_ERR');
}
