-- Pre-deployment review: lightweight user profile (ADDITIVE, non-destructive).
-- Adds User.displayName, User.assignment, User.avatarMediaId.
-- Every existing user row is copied across unchanged; roles are preserved and the
-- ADMIN/PRO CHECK constraint from 20260930000000_user_roles is re-created here
-- because the table is rebuilt to add the foreign key.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'ADMIN' CHECK ("role" IN ('ADMIN', 'PRO')),
    "displayName" TEXT,
    "assignment" TEXT,
    "avatarMediaId" TEXT,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "User_avatarMediaId_fkey" FOREIGN KEY ("avatarMediaId") REFERENCES "Media" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_User" ("createdAt", "email", "id", "lastLoginAt", "password", "role", "updatedAt") SELECT "createdAt", "email", "id", "lastLoginAt", "password", "role", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_avatarMediaId_key" ON "User"("avatarMediaId");
CREATE INDEX "User_role_idx" ON "User"("role");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;