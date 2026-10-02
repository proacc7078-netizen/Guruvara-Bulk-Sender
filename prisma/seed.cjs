const { PrismaClient } = require('@prisma/client');
const argon2 = require('argon2');
const prisma = new PrismaClient();

async function main() {
  const existing = await prisma.user.findUnique({ where: { email: 'admin@japa.local' } });
  if (existing) {
    console.log('Admin already exists:', existing.email, '/ role:', existing.role);
    return;
  }
  const hashed = await argon2.hash('admin123');
  const user = await prisma.user.create({
    // Phase 8.1 — the seeded default account is the administrator.
    data: { email: 'admin@japa.local', password: hashed, role: 'ADMIN' }
  });
  console.log('Admin created:', user.email, '/ admin123 / role:', user.role);
}

main().catch(console.error).finally(() => prisma.$disconnect());
