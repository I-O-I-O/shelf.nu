CREATE TABLE "EmailTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "body" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmailTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmailTemplate_organizationId_key_key" ON "EmailTemplate"("organizationId", "key");
CREATE INDEX "EmailTemplate_organizationId_idx" ON "EmailTemplate"("organizationId");

ALTER TABLE "EmailTemplate" ADD CONSTRAINT "EmailTemplate_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;


CREATE TABLE "UserEmailPreference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "borrowingConfirmation" BOOLEAN NOT NULL DEFAULT true,
    "returnReminders" BOOLEAN NOT NULL DEFAULT true,
    "extensionUpdates" BOOLEAN NOT NULL DEFAULT true,
    "readyForPickup" BOOLEAN NOT NULL DEFAULT true,
    "cardAccessUpdates" BOOLEAN NOT NULL DEFAULT true,
    "annualAccessUpdates" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserEmailPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserEmailPreference_userId_key" ON "UserEmailPreference"("userId");
CREATE INDEX "UserEmailPreference_userId_idx" ON "UserEmailPreference"("userId");

ALTER TABLE "UserEmailPreference"
ADD CONSTRAINT "UserEmailPreference_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
