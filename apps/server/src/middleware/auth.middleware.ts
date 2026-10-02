import { Request, Response, NextFunction } from 'express';
import { prisma } from '../config/db';
import { recordAuditSafe } from '../services/audit.service';
import { isRole, Role, ROLE } from '../utils/roles.util';

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
  }
  next();
};

/**
 * Phase 8.1 — role authorization.
 *
 * The session stays exactly as it was (it only carries `userId`): the role is
 * read from the database on every guarded request. That keeps existing sessions
 * working and makes a role change take effect immediately.
 *
 * Fails closed: an unauthenticated session gets the pre-existing 401 payload
 * and any role that is not explicitly allowed (including a corrupt/unexpected
 * stored value) gets 403 FORBIDDEN.
 *
 * Usage: `router.use(requireAuth, requireRole(ROLE.ADMIN))`
 */
/**
 * Pre-deployment role boundary — permanent/destructive actions.
 *
 * Returns true when the request is allowed to proceed. Otherwise it has already
 * written the standard 401/403 payload and the caller MUST return immediately.
 *
 * This exists because the destructive endpoints live on routers that must stay
 * PRO-accessible overall (the rest of messages/campaigns/recipients is normal
 * operational work), so the ADMIN check is applied per-handler instead of by
 * gating the whole router. It uses exactly the same database-backed role read
 * and the same audit + failure semantics as `requireRole`, so there is a single
 * authorization rule in the codebase rather than two.
 *
 * Usage:
 *   if (!(await denyUnlessAdmin(req, res))) return;
 */
export async function denyUnlessAdmin(req: Request, res: Response): Promise<boolean> {
  const userId = req.session?.userId;
  if (typeof userId !== 'string' || !userId) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return false;
  }
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) {
    res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
    return false;
  }
  if (!isRole(user.role) || user.role !== ROLE.ADMIN) {
    recordAuditSafe('AUTHORIZATION_DENIED', req, {
      requiredRoles: [ROLE.ADMIN],
      actualRole: isRole(user.role) ? user.role : '[INVALID]',
      method: req.method,
      path: req.originalUrl,
    });
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
    });
    return false;
  }
  return true;
}

export function requireRole(...allowedRoles: Role[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.session?.userId;
      if (typeof userId !== 'string' || !userId) {
        return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      }

      const user = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (!user) {
        // The session points at a user that no longer exists.
        return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      }

      if (!isRole(user.role) || !allowedRoles.includes(user.role)) {
        recordAuditSafe('AUTHORIZATION_DENIED', req, {
          requiredRoles: allowedRoles,
          actualRole: isRole(user.role) ? user.role : '[INVALID]',
          method: req.method,
          path: req.originalUrl,
        });
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'You do not have permission to perform this action' },
        });
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

