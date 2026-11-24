/** Local-only; dry-run default. Explicit org and operation IDs required. */
import { db } from "../app/database/db.server";
import { repairImportedDescription } from "../app/modules/ioio-staff/import-description";
import type { StaffImportProposal } from "../app/modules/ioio-staff/inventory-import.server";

async function main() {
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(
      new URL(process.env.DATABASE_URL!).hostname
    )
  ) {
    throw new Error("Local development database required");
  }
  const [organizationId, ...operationIds] = process.argv
    .slice(2)
    .filter((arg) => arg !== "--apply");
  if (!organizationId || !operationIds.length)
    throw new Error("Supply organization ID and reviewed A1-A5 operation IDs");
  const operations = await db.ioioWriteOperation.findMany({
    where: {
      id: { in: operationIds },
      organizationId,
      operationType: "INVENTORY_IMPORT",
    },
    include: { importItems: true },
  });
  for (const operation of operations) {
    const stored = JSON.parse(operation.description) as {
      proposal?: StaffImportProposal;
    };
    const proposal = stored.proposal;
    if (!proposal || !/A[1-5](?:_|\b)/i.test(proposal.source.filename))
      continue;
    for (const item of operation.importItems) {
      if (
        item.status !== "DONE" ||
        !["CREATE", "INDIVIDUAL_UNIT_CREATE"].includes(item.kind) ||
        !item.targetAssetId
      )
        continue;
      const row = proposal.rows.find(
        (row) => item.rowKey === `row-${row.rowNumber}`
      );
      if (!row) continue;
      const asset = await db.asset.findFirst({
        where: { id: item.targetAssetId, organizationId },
      });
      if (!asset) continue;
      const description = repairImportedDescription(
        asset.description,
        proposal.source.filename,
        row
      );
      if (description === null || description === asset.description) continue;
      console.log(
        JSON.stringify({
          operationId: operation.id,
          assetId: asset.id,
          title: asset.title,
          before: asset.description,
          after: description,
        })
      );
      if (process.argv.includes("--apply")) {
        // Compare-and-swap preserves edits made since the preview/read.
        const result = await db.asset.updateMany({
          where: {
            id: asset.id,
            organizationId,
            description: asset.description,
            updatedAt: asset.updatedAt,
          },
          data: { description },
        });
        if (result.count !== 1)
          throw new Error(`Concurrent edit preserved: ${asset.id}`);
      }
    }
  }
}
main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
