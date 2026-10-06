CREATE TYPE "TAShiftStatus" AS ENUM (
  'SCHEDULED',
  'AWAITING_CONFIRMATION',
  'CONFIRMED',
  'ADJUSTED'
);

CREATE TABLE "TAHoursPeriod" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "academicYear" VARCHAR(9) NOT NULL,
  "startDate" DATE NOT NULL,
  "endDate" DATE NOT NULL,
  "totalHoursBudget" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TAHoursPeriod_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TAHoursPeriod_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "TAHoursAllocation" (
  "id" TEXT NOT NULL,
  "periodId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "allocatedHours" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "createdByUserId" TEXT NOT NULL,
  "updatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TAHoursAllocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TAHoursAllocation_periodId_fkey"
    FOREIGN KEY ("periodId") REFERENCES "TAHoursPeriod"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TAHoursAllocation_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TAHoursAllocation_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TAHoursAllocation_updatedByUserId_fkey"
    FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "TAShift" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "periodId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "scheduledDate" DATE NOT NULL,
  "scheduledStartTime" VARCHAR(5) NOT NULL,
  "scheduledEndTime" VARCHAR(5) NOT NULL,
  "actualHours" DECIMAL(6,2),
  "actualHoursReason" VARCHAR(500),
  "status" "TAShiftStatus" NOT NULL DEFAULT 'SCHEDULED',
  "cancelledAt" TIMESTAMP(3),
  "createdByUserId" TEXT NOT NULL,
  "confirmedByUserId" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TAShift_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TAShift_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "Organization"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TAShift_periodId_fkey"
    FOREIGN KEY ("periodId") REFERENCES "TAHoursPeriod"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TAShift_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TAShift_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TAShift_confirmedByUserId_fkey"
    FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE "TAHoursCorrection" (
  "id" TEXT NOT NULL,
  "shiftId" TEXT NOT NULL,
  "previousHours" DECIMAL(6,2),
  "newHours" DECIMAL(6,2) NOT NULL,
  "reason" VARCHAR(500),
  "changedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TAHoursCorrection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TAHoursCorrection_shiftId_fkey"
    FOREIGN KEY ("shiftId") REFERENCES "TAShift"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TAHoursCorrection_changedByUserId_fkey"
    FOREIGN KEY ("changedByUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "TAHoursBudgetAdjustment" (
  "id" TEXT NOT NULL,
  "periodId" TEXT NOT NULL,
  "previousHours" DECIMAL(10,2) NOT NULL,
  "newHours" DECIMAL(10,2) NOT NULL,
  "reason" VARCHAR(500),
  "changedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TAHoursBudgetAdjustment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TAHoursBudgetAdjustment_periodId_fkey"
    FOREIGN KEY ("periodId") REFERENCES "TAHoursPeriod"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "TAHoursBudgetAdjustment_changedByUserId_fkey"
    FOREIGN KEY ("changedByUserId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "TAHoursPeriod_organizationId_academicYear_key"
  ON "TAHoursPeriod"("organizationId", "academicYear");
CREATE INDEX "TAHoursPeriod_organizationId_startDate_endDate_idx"
  ON "TAHoursPeriod"("organizationId", "startDate", "endDate");
CREATE UNIQUE INDEX "TAHoursAllocation_periodId_userId_key"
  ON "TAHoursAllocation"("periodId", "userId");
CREATE INDEX "TAHoursAllocation_userId_idx" ON "TAHoursAllocation"("userId");
CREATE INDEX "TAHoursAllocation_periodId_allocatedHours_idx"
  ON "TAHoursAllocation"("periodId", "allocatedHours");
CREATE INDEX "TAShift_organizationId_periodId_scheduledDate_cancelledAt_idx"
  ON "TAShift"("organizationId", "periodId", "scheduledDate", "cancelledAt");
CREATE INDEX "TAShift_organizationId_userId_scheduledDate_status_idx"
  ON "TAShift"("organizationId", "userId", "scheduledDate", "status");
CREATE INDEX "TAShift_createdByUserId_idx" ON "TAShift"("createdByUserId");
CREATE INDEX "TAShift_confirmedByUserId_idx" ON "TAShift"("confirmedByUserId");
CREATE INDEX "TAHoursCorrection_shiftId_createdAt_idx"
  ON "TAHoursCorrection"("shiftId", "createdAt");
CREATE INDEX "TAHoursBudgetAdjustment_periodId_createdAt_idx"
  ON "TAHoursBudgetAdjustment"("periodId", "createdAt");


ALTER TABLE "TAShift"
ADD COLUMN "isManual" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "manualEntryKey" TEXT;

CREATE UNIQUE INDEX "TAShift_manualEntryKey_key"
ON "TAShift"("manualEntryKey");


ALTER TABLE "TAHoursPeriod"
  ADD COLUMN "budgetAmountSek" DECIMAL(14, 2),
  ADD COLUMN "hourlyRateSekPerHour" DECIMAL(14, 2);
