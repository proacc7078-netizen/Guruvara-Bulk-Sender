-- Phase 5.6 — Persistent campaign scheduler: scheduler consumption bookkeeping.
--
-- Additive and non-destructive: three nullable columns on CampaignSchedule.
-- No existing column, index, constraint or row is touched.
--   consumedAt     : set when an execution snapshot exists for this schedule
--   lastAttemptAt  : last time the scheduler attempted this schedule
--   lastError      : preserved reason when execution creation failed
ALTER TABLE "CampaignSchedule" ADD COLUMN "consumedAt" DATETIME;
ALTER TABLE "CampaignSchedule" ADD COLUMN "lastAttemptAt" DATETIME;
ALTER TABLE "CampaignSchedule" ADD COLUMN "lastError" TEXT;
