const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  // Clean up test users (but keep baseline admin/test users)
  const testUsers = await prisma.user.findMany({ where: { email: { startsWith: 'phase' } } });
  for (const u of testUsers) {
    try { await prisma.user.delete({ where: { id: u.id } }); } catch { }
  }
  // Clean up any test campaigns
  const testCampaigns = await prisma.campaign.findMany({ where: { name: { startsWith: 'Phase5' } } });
  for (const c of testCampaigns) {
    try { await prisma.campaign.delete({ where: { id: c.id } }); } catch { }
  }
  // Clean up test messages
  const testMessages = await prisma.message.findMany({ where: { name: { startsWith: 'Phase5' } } });
  for (const m of testMessages) {
    try { await prisma.message.delete({ where: { id: m.id } }); } catch { }
  }
  // Clean up test recipients
  const testRecipients = await prisma.recipient.findMany({ where: { name: { startsWith: 'Phase5' } } });
  for (const r of testRecipients) {
    try { await prisma.recipient.delete({ where: { id: r.id } }); } catch { }
  }
  // Clean up test tags
  const testTags = await prisma.tag.findMany({ where: { name: { startsWith: 'Phase5' } } });
  for (const t of testTags) {
    try { await prisma.tag.delete({ where: { id: t.id } }); } catch { }
  }
  // Clean up audit logs and login attempts from test runs
  await prisma.auditLog.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  console.log('Cleanup done');
  await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
