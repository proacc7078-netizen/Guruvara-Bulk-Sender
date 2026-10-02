/**
 * Phase 8.1 — Admin / Pro role catalog.
 *
 * Two roles exist in the CMS:
 *
 * - ADMIN — full access to the CMS: messages, campaigns, recipients, user
 *   management, WhatsApp/provider configuration, Google Sheets configuration,
 *   system settings, backups and audit/system administration.
 * - PRO — operational access only: messages, campaigns, campaign audience
 *   selection and campaign scheduling. Every administrative surface above is
 *   denied by the backend (see middleware/auth.middleware.ts).
 *
 * SQLite (this project's database) has no Prisma enum support, so the canonical
 * values are enforced twice:
 *   1. a CHECK constraint on User.role in
 *      prisma/migrations/20260930000000_user_roles/migration.sql
 *   2. the validation helpers below, used by every application write path
 *      (see controllers/users.controller.ts).
 */

export const ROLE = {
  ADMIN: 'ADMIN',
  PRO: 'PRO',
} as const;

export type Role = (typeof ROLE)[keyof typeof ROLE];

/** Canonical role values, in display order. */
export const ROLES: readonly Role[] = [ROLE.ADMIN, ROLE.PRO];

/**
 * Default role for a user created without an explicit role. This is also the
 * value the migration backfills, which is why every pre-existing user
 * (including the seeded admin) keeps full access.
 */
export const DEFAULT_ROLE: Role = ROLE.ADMIN;

/** True only for the exact canonical role strings. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/**
 * Strict role parsing for request payloads: only the canonical values are
 * accepted, so an invalid role can never reach the database.
 */
export function parseRole(value: unknown): Role | null {
  return isRole(value) ? value : null;
}
