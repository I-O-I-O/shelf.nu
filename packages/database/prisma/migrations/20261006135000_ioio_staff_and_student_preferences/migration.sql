ALTER TABLE "User"
ADD COLUMN "staffDashboardPreferences" JSONB;


-- Existing organization memberships are grandfathered as completed. The user
-- service marks newly created Student memberships incomplete explicitly.
ALTER TABLE "UserOrganization"
    ADD COLUMN "labIntroductionCompleted" BOOLEAN NOT NULL DEFAULT true;
