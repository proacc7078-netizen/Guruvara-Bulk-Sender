/* Temporary verification script for the Phase 3.2 post-completion cleanup.
   Reports recipient/message counts and recipient records. Read-only. */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const recipients = await prisma.recipient.count();
  const messages = await prisma.message.count();
  const tags = await prisma.tag.count();
  const users = await prisma.user.count();
  console.log('recipients=' + recipients + ' messages=' + messages + ' tags=' + tags + ' users=' + users);
  const rows = await prisma.recipient.findMany({
    select: { id: true, name: true, normalizedPhone: true, status: true },
    orderBy: { normalizedPhone: 'asc' },
  });
  console.log(JSON.stringify(rows, null, 1));
  await prisma.$disconnect();
})().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
