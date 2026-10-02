-- CreateTable
CREATE TABLE "CampaignExecution" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "campaignId" TEXT NOT NULL,
    "scheduleId" TEXT UNIQUE,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scheduledAt" DATETIME NOT NULL,
    "startedAt" DATETIME,
    "completedAt" DATETIME,
    "failedAt" DATETIME,
    "errorMessage" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "messageId" TEXT,
    "messageName" TEXT,
    "messageBody" TEXT,
    "messageLanguage" TEXT,
    "mediaId" TEXT,
    "mediaPath" TEXT,
    CONSTRAINT "CampaignExecution_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CampaignExecution_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "CampaignSchedule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CampaignExecutionRecipient" (
    "executionId" TEXT NOT NULL,
    "recipientId" TEXT NOT NULL,
    "whatsappNumber" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CampaignExecutionRecipient_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "CampaignExecution" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CampaignExecutionRecipient_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "Recipient" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    PRIMARY KEY ("executionId", "recipientId")
);

-- CreateIndex
CREATE INDEX "CampaignExecution_campaignId_idx" ON "CampaignExecution"("campaignId");

-- CreateIndex
CREATE INDEX "CampaignExecution_scheduleId_idx" ON "CampaignExecution"("scheduleId");

-- CreateIndex
CREATE INDEX "CampaignExecution_status_idx" ON "CampaignExecution"("status");

-- CreateIndex
CREATE INDEX "CampaignExecution_scheduledAt_idx" ON "CampaignExecution"("scheduledAt");

-- CreateIndex
CREATE INDEX "CampaignExecutionRecipient_recipientId_idx" ON "CampaignExecutionRecipient"("recipientId");
