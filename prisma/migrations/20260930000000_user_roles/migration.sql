-- Phase 8.1 — Admin/Pro role system (additive, non-destructive).
--
-- Adds User.role with a CHECK constraint, so no value other than ADMIN or PRO
-- can ever be stored (including through a direct SQL write).
--
-- The NOT NULL DEFAULT 'ADMIN' means every pre-existing row — in particular the
-- seeded admin@japa.local user — keeps full ADMIN access. No row is rewritten,
-- no table is recreated and no data is deleted, so this migration is safe to
-- apply to an existing development database.
ALTER TABLE "User"
  ADD COLUMN "role" TEXT NOT NULL DEFAULT 'ADMIN' CHECK ("role" IN ('ADMIN', 'PRO'));
