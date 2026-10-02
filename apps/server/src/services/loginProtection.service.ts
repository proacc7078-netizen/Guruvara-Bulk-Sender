import { prisma } from '../config/db';

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_LOCKOUT_MS = 15 * 60 * 1000;

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const LOGIN_MAX_ATTEMPTS = positiveInteger(process.env.LOGIN_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);
export const LOGIN_WINDOW_MS = positiveInteger(process.env.LOGIN_WINDOW_MS, DEFAULT_WINDOW_MS);
export const LOGIN_LOCKOUT_MS = positiveInteger(process.env.LOGIN_LOCKOUT_MS, DEFAULT_LOCKOUT_MS);

export async function getLoginLockout(identifier: string, ipAddress: string | null): Promise<{ locked: boolean; retryAfterMs: number }> {
  const since = new Date(Date.now() - LOGIN_WINDOW_MS);
  const where: {
    identifier: string;
    successful: false;
    createdAt: { gte: Date };
    ipAddress?: string | null;
  } = {
    identifier,
    successful: false,
    createdAt: { gte: since },
  };
  if (ipAddress) where.ipAddress = ipAddress;

  const failedAttempts = await prisma.loginAttempt.count({ where });
  if (failedAttempts < LOGIN_MAX_ATTEMPTS) {
    return { locked: false, retryAfterMs: 0 };
  }

  const latest = await prisma.loginAttempt.findFirst({
    where,
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const retryAfterMs = latest
    ? Math.max(0, latest.createdAt.getTime() + LOGIN_LOCKOUT_MS - Date.now())
    : LOGIN_LOCKOUT_MS;
  return { locked: retryAfterMs > 0, retryAfterMs };
}

export async function recordLoginAttempt(input: {
  identifier: string;
  ipAddress: string | null;
  successful: boolean;
}): Promise<void> {
  if (input.successful) {
    const where: {
      identifier: string;
      successful: false;
      ipAddress?: string | null;
    } = { identifier: input.identifier, successful: false };
    if (input.ipAddress) where.ipAddress = input.ipAddress;
    await prisma.$transaction([
      prisma.loginAttempt.create({ data: input }),
      prisma.loginAttempt.deleteMany({ where }),
    ]);
    return;
  }

  await prisma.loginAttempt.create({ data: input });
}
