const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
(async () => {
  const t = await p.$queryRawUnsafe("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
  console.log('TABLES:', t.map((x) => x.name).join(', '));
  const has = t.some((x) => x.name === '_prisma_migrations');
  console.log('_prisma_migrations EXISTS:', has);
  if (has) {
    const rows = await p.$queryRawUnsafe('SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at');
    console.log('ROWS:', rows.length);
    for (const r of rows) console.log('  -', r.migration_name, 'finished=', !!r.finished_at, 'rolledBack=', !!r.rolled_back_at);
  }
  await p.$disconnect();
})();