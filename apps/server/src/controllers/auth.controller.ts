import { Request, Response } from 'express';
import argon2 from 'argon2';
import { prisma } from '../config/db';
import { recordAudit } from '../services/audit.service';
import { toProfile } from './users.controller';
import { getLoginLockout, recordLoginAttempt } from '../services/loginProtection.service';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isPassword,
  normalizeEmail,
} from '../utils/credentials.util';

let dummyPasswordHash: string | null = null;

async function getDummyPasswordHash(): Promise<string> {
  if (!dummyPasswordHash) {
    dummyPasswordHash = await argon2.hash('not-a-real-password');
  }
  return dummyPasswordHash;
}

async function safeAudit(action: string, req: Request, metadata: Record<string, unknown> = {}): Promise<void> {
  try {
    await recordAudit(action, req, metadata);
  } catch {
    // Audit storage must not prevent authentication responses.
  }
}

function validationError(res: Response, message: string) {
  return res.status(400).json({
    success: false,
    error: { code: 'VALIDATION_ERROR', message },
  });
}

function authenticationError(res: Response) {
  return res.status(401).json({
    success: false,
    error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
  });
}

function requestIp(req: Request): string | null {
  return req.ip || req.socket.remoteAddress || null;
}

export const login = async (req: Request, res: Response) => {
  const identifier = normalizeEmail(req.body?.email);
  const password = req.body?.password;

  if (!identifier || !isPassword(password)) {
    return validationError(res, 'A valid email and password are required');
  }

  const ipAddress = requestIp(req);
  const lockout = await getLoginLockout(identifier, ipAddress);
  if (lockout.locked) {
    await safeAudit('LOGIN_LOCKED', req, { identifier, retryAfterSeconds: Math.ceil(lockout.retryAfterMs / 1000) });
    return res.status(429).json({
      success: false,
      error: {
        code: 'LOGIN_THROTTLED',
        message: 'Too many login attempts. Please try again later.',
        retryAfterSeconds: Math.max(1, Math.ceil(lockout.retryAfterMs / 1000)),
      },
    });
  }

  const user = await prisma.user.findUnique({ where: { email: identifier } });
  const passwordHash = user?.password ?? await getDummyPasswordHash();
  const validPassword = await argon2.verify(passwordHash, password);

  if (!user || !validPassword) {
    await recordLoginAttempt({ identifier, ipAddress, successful: false });
    await safeAudit('LOGIN_FAILURE', req, { identifier });
    return authenticationError(res);
  }

  await recordLoginAttempt({ identifier, ipAddress, successful: true });
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
  req.session.userId = user.id;
  await new Promise<void>((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });

  await safeAudit('LOGIN_SUCCESS', req, { actorEmail: user.email });
  // `role` is additive: existing clients are unaffected, PRO/ADMIN aware
  // clients can read it. The authoritative source remains GET /api/auth/me.
  return res.json({ success: true, data: { user: { id: user.id, email: user.email, role: user.role } } });
};

export const logout = async (req: Request, res: Response) => {
  const actorUserId = req.session.userId;
  await safeAudit('LOGOUT', req, { actorUserId });

  await new Promise<void>((resolve, reject) => {
    req.session.destroy((error) => (error ? reject(error) : resolve()));
  });
  res.clearCookie('connect.sid');
  return res.json({ success: true, data: {} });
};

export const changePassword = async (req: Request, res: Response) => {
  const actorUserId = req.session.userId;
  if (!actorUserId) {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
  }

  const { currentPassword, newPassword, confirmPassword } = req.body ?? {};
  if (
    typeof currentPassword !== 'string' ||
    !isPassword(newPassword) ||
    typeof confirmPassword !== 'string' ||
    newPassword !== confirmPassword
  ) {
    return validationError(res, `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters and confirmation must match`);
  }

  const user = await prisma.user.findUnique({ where: { id: actorUserId } });
  if (!user || !(await argon2.verify(user.password, currentPassword))) {
    await safeAudit('PASSWORD_CHANGE_FAILURE', req, { actorUserId });
    return res.status(401).json({
      success: false,
      error: { code: 'INVALID_CURRENT_PASSWORD', message: 'Current password is invalid' },
    });
  }

  const passwordHash = await argon2.hash(newPassword);
  await prisma.user.update({ where: { id: user.id }, data: { password: passwordHash } });

  await new Promise<void>((resolve, reject) => {
    req.session.regenerate((error) => (error ? reject(error) : resolve()));
  });
  req.session.userId = user.id;
  await new Promise<void>((resolve, reject) => {
    req.session.save((error) => (error ? reject(error) : resolve()));
  });

  await safeAudit('PASSWORD_CHANGED', req, { actorUserId, actorEmail: user.email });
  return res.json({ success: true, data: {} });
};

export const me = async (req: Request, res: Response) => {
  const actorUserId = req.session.userId;
  if (typeof actorUserId !== 'string') {
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Not authenticated' },
    });
  }

  const user = await prisma.user.findUnique({ where: { id: actorUserId } });
  if (!user) {
    return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
  }
  // Phase 8.1 — the authenticated user's role is part of the session identity.
  // Pre-deployment: also expose the lightweight profile so the sidebar user
  // block has a single source of truth (GET /api/auth/me).
  return res.json({ success: true, data: { user: toProfile(user) } });
};
