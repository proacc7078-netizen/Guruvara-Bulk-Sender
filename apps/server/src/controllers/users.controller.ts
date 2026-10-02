import { Request, Response } from 'express';
import argon2 from 'argon2';
import { prisma } from '../config/db';
import { recordAuditSafe } from '../services/audit.service';
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  isPassword,
  normalizeEmail,
} from '../utils/credentials.util';
import { ROLE, ROLES, parseRole } from '../utils/roles.util';

/**
 * Phase 8.1 — user management (ADMIN only).
 *
 * Minimal backend surface so an administrator can create a PRO account and
 * change roles later (no user-management UI yet, no invite/registration flow).
 * Every route is mounted behind
 * `requireAuth, requireRole(ROLE.ADMIN)` in routes/users.routes.ts.
 *
 * Passwords are hashed with argon2 (same as authentication) and never returned.
 */

// Never includes `password`.
const USER_SELECT = {
  id: true,
  email: true,
  role: true,
  displayName: true,
  assignment: true,
  avatarMediaId: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/**
 * Profile view for the signed-in user. Adds a resolvable avatar URL (the
 * existing authenticated media endpoint) so the client never sees or needs a
 * filesystem path. Returns `null` when no avatar is set, which is what makes
 * the sidebar fall back to initials.
 */
export const toProfile = (user: {
  id: string; email: string; role: string;
  displayName: string | null; assignment: string | null; avatarMediaId: string | null;
}) => ({
  id: user.id,
  email: user.email,
  role: user.role,
  displayName: user.displayName,
  assignment: user.assignment,
  avatarUrl: user.avatarMediaId ? `/api/media/${user.avatarMediaId}` : null,
  /** Initials fallback for the sidebar/avatar slot. Never persisted. */
  initials: (user.displayName || user.email)
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('') || 'U',
});

const validationError = (res: Response, message: string) =>
  res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });

const internalError = (res: Response, message: string) =>
  res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message } });

export const listUsers = async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      select: USER_SELECT,
      orderBy: [{ role: 'asc' }, { email: 'asc' }],
    });
    return res.json({ success: true, data: { users } });
  } catch (error) {
    return internalError(res, 'Failed to fetch users');
  }
};

export const createUser = async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const password = body.password;
    const role = parseRole(body.role);

    if (!email || !isPassword(password)) {
      return validationError(
        res,
        `A valid email and a password of ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters are required`
      );
    }
    // Invalid/unknown role values are rejected here, so they can never be stored.
    if (!role) {
      return validationError(res, `Role must be one of: ${ROLES.join(', ')}`);
    }

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) {
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_ALREADY_EXISTS', message: 'An account with this email already exists' },
      });
    }

    const user = await prisma.user.create({
      data: { email, password: await argon2.hash(password), role },
      select: USER_SELECT,
    });

    recordAuditSafe('USER_CREATE', req, { targetUserId: user.id, targetEmail: user.email, role: user.role });
    return res.status(201).json({ success: true, data: { user } });
  } catch (error) {
    return internalError(res, 'Failed to create user');
  }
};

export const updateUserRole = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const targetUserId = Array.isArray(id) ? id[0] : id;
    if (!targetUserId || typeof targetUserId !== 'string' || targetUserId.length > 200) {
      return validationError(res, 'Invalid user ID');
    }

    const role = parseRole((req.body ?? {}).role);
    if (!role) {
      return validationError(res, `Role must be one of: ${ROLES.join(', ')}`);
    }

    const target = await prisma.user.findUnique({ where: { id: targetUserId }, select: USER_SELECT });
    if (!target) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    }
    if (target.role === role) {
      return res.json({ success: true, data: { user: target } });
    }

    // Never leave the system without an administrator.
    if (target.role === ROLE.ADMIN) {
      const adminCount = await prisma.user.count({ where: { role: ROLE.ADMIN } });
      if (adminCount <= 1) {
        return res.status(409).json({
          success: false,
          error: { code: 'LAST_ADMIN', message: 'The last remaining administrator cannot be demoted' },
        });
      }
    }

    const user = await prisma.user.update({ where: { id: targetUserId }, data: { role }, select: USER_SELECT });
    recordAuditSafe('USER_ROLE_CHANGE', req, {
      targetUserId: user.id,
      targetEmail: user.email,
      previousRole: target.role,
      role: user.role,
    });
    return res.json({ success: true, data: { user } });
  } catch (error) {
    return internalError(res, 'Failed to update user role');
  }
};

/**
 * PATCH /api/users/me/profile — the signed-in user edits their own profile.
 *
 * Deliberately mounted on the ADMIN-only router (so a PRO session cannot reach
 * it) but it only ever writes `req.session.userId`'s own row, so it can never
 * be used to edit another account. Role is NOT writable here: role changes go
 * through the existing ADMIN-only /:id/role endpoint.
 */
export const updateMyProfile = async (req: Request, res: Response) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};

    if (body.displayName !== undefined) {
      const dn = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      if (dn.length > 80) return validationError(res, 'Display name must be 80 characters or fewer');
      data.displayName = dn.length ? dn : null;
    }
    if (body.assignment !== undefined) {
      const asg = typeof body.assignment === 'string' ? body.assignment.trim() : '';
      if (asg.length > 80) return validationError(res, 'Assignment must be 80 characters or fewer');
      data.assignment = asg.length ? asg : null;
    }
    if (body.avatarMediaId !== undefined) {
      const mid = body.avatarMediaId === null ? null : String(body.avatarMediaId);
      if (mid) {
        const media = await prisma.media.findUnique({ where: { id: mid }, select: { id: true, mimeType: true } });
        if (!media) return validationError(res, 'Unknown avatar media');
        if (!String(media.mimeType).startsWith('image/')) return validationError(res, 'Avatar must be an image');
      }
      data.avatarMediaId = mid;
    }

    if (Object.keys(data).length === 0) {
      const existing = await prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT });
      if (!existing) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
      return res.json({ success: true, data: { user: toProfile(existing) } });
    }

    const user = await prisma.user.update({ where: { id: userId }, data, select: USER_SELECT });
    recordAuditSafe('USER_PROFILE_UPDATE', req, { fields: Object.keys(data) });
    return res.json({ success: true, data: { user: toProfile(user) } });
  } catch (error) {
    return internalError(res, 'Failed to update profile');
  }
};

/**
 * DELETE /api/users — bulk delete.
 *
 * Protections are enforced SERVER-SIDE (the UI is not the security boundary):
 *   1. an ADMIN can never delete their own account;
 *   2. the system can never be left without an ADMIN;
 *   3. unknown ids are reported rather than silently ignored.
 *
 * The operation is all-or-nothing: if any selected id is blocked, nothing is
 * deleted and the reason for each blocked id is returned, so the UI never has
 * to guess about a partially applied destructive action.
 */
export const bulkDeleteUsers = async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const raw = Array.isArray(body.userIds) ? body.userIds : null;
    if (!raw || raw.length === 0) return validationError(res, 'userIds must be a non-empty array');
    if (raw.length > 200) return validationError(res, 'Too many users selected');
    const ids = [...new Set(raw.map((v) => String(v)))];

    const targets = await prisma.user.findMany({ where: { id: { in: ids } }, select: USER_SELECT });
    const found = new Map(targets.map((u) => [u.id, u]));

    const blocked: Array<{ id: string; email: string; code: string; message: string }> = [];
    for (const id of ids) {
      if (!found.has(id)) {
        blocked.push({ id, email: id, code: 'NOT_FOUND', message: 'User not found' });
        continue;
      }
      if (id === req.session?.userId) {
        blocked.push({ id, email: found.get(id)!.email, code: 'SELF_DELETE', message: 'You cannot delete your own account' });
      }
    }

    const deletingAdmins = targets.filter((u) => u.role === ROLE.ADMIN && !blocked.some((b) => b.id === u.id));
    if (deletingAdmins.length > 0) {
      const adminCount = await prisma.user.count({ where: { role: ROLE.ADMIN } });
      // Removing every remaining admin would lock everyone out of administration.
      if (adminCount - deletingAdmins.length <= 0) {
        for (const a of deletingAdmins) {
          blocked.push({ id: a.id, email: a.email, code: 'LAST_ADMIN', message: 'The last remaining administrator cannot be deleted' });
        }
      }
    }

    if (blocked.length > 0) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'BULK_DELETE_BLOCKED',
          message: blocked.length === 1
            ? blocked[0]!.message
            : `${blocked.length} selected users cannot be deleted. No users were deleted.`,
          blocked,
        },
      });
    }

    const deletable = targets.filter((u) => u.id !== req.session?.userId);
    const result = await prisma.user.deleteMany({ where: { id: { in: deletable.map((u) => u.id) } } });
    recordAuditSafe('USER_BULK_DELETE', req, { requested: ids.length, deleted: result.count, emails: deletable.map((u) => u.email) });
    return res.json({ success: true, data: { deleted: result.count, deletedEmails: deletable.map((u) => u.email) } });
  } catch (error) {
    return internalError(res, 'Failed to delete users');
  }
};
