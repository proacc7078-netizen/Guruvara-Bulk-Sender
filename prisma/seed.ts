import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const email = 'admin@japa.local';
  const password = 'admin123';

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    console.log('Admin user already exists:', email);
    return;
  }

  const hashed = await argon2.hash(password);
  const user = await prisma.user.create({
    // Phase 8.1 — the seeded default account is the administrator.
    data: { email, password: hashed, role: 'ADMIN' },
  });

  console.log('✅ Admin user created!');
  console.log('   Email:   ', user.email);
  console.log('   Password: admin123');
  console.log('   Role:    ', user.role);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
