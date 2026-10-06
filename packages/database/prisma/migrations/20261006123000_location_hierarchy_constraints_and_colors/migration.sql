ALTER TABLE "Location"
ADD COLUMN "color" TEXT;

WITH ranked_locations AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "organizationId", COALESCE("parentId", '')
      ORDER BY "createdAt", id
    ) - 1 AS color_index
  FROM "Location"
)
UPDATE "Location" AS location
SET "color" = (
  ARRAY[
    '#1565C0',
    '#2E7D32',
    '#C62828',
    '#6A1B9A',
    '#E65100',
    '#00796B',
    '#AD1457',
    '#455A64',
    '#827717',
    '#5D4037'
  ]::TEXT[]
)[(ranked_locations.color_index % 10) + 1]
FROM ranked_locations
WHERE location.id = ranked_locations.id
  AND ranked_locations.color_index < 10;

CREATE UNIQUE INDEX "Location_organizationId_parentId_color_key"
  ON "Location" ("organizationId", COALESCE("parentId", ''), "color")
  WHERE "color" IS NOT NULL;


-- Shelf previously enforced location name uniqueness across an entire
-- organization. Location names only need to be unique among siblings in the
-- recursive location tree.
DROP INDEX IF EXISTS "Location_name_organizationId_key";

CREATE UNIQUE INDEX "Location_name_organizationId_parentId_key"
  ON "Location"(LOWER(BTRIM("name")), "organizationId", COALESCE("parentId", ''));
