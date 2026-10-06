CREATE TYPE "LabTaskPriority" AS ENUM ('NORMAL', 'IMPORTANT', 'URGENT');
CREATE TYPE "LabTaskStatus" AS ENUM ('OPEN', 'COMPLETED');

CREATE TABLE "LabTask" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "title" VARCHAR(180) NOT NULL,
    "description" TEXT,
    "assignedToUserId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "completedByUserId" TEXT,
    "priority" "LabTaskPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "LabTaskStatus" NOT NULL DEFAULT 'OPEN',
    "dueDate" DATE,
    "completedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LabTask_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "LabTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "LabTask_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "LabTask_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "LabTask_completedByUserId_fkey" FOREIGN KEY ("completedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "LabTask_organizationId_status_deletedAt_dueDate_idx" ON "LabTask"("organizationId", "status", "deletedAt", "dueDate");
CREATE INDEX "LabTask_organizationId_assignedToUserId_status_deletedAt_idx" ON "LabTask"("organizationId", "assignedToUserId", "status", "deletedAt");
CREATE INDEX "LabTask_createdByUserId_idx" ON "LabTask"("createdByUserId");
CREATE INDEX "LabTask_completedByUserId_idx" ON "LabTask"("completedByUserId");
