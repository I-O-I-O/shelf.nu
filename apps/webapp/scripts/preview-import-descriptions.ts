/** Pure local preview: does not load environment, database, storage or HTTP code. */
import { repairImportedDescription } from "../app/modules/ioio-staff/import-description";
import { importDescriptionFixtures } from "../test/factories/ioio-import-descriptions";

for (const fixture of importDescriptionFixtures()) {
  const after = repairImportedDescription(
    fixture.currentDescription,
    fixture.filename,
    fixture.row
  );
  console.log(
    JSON.stringify({
      id: fixture.id,
      source: "synthetic fixture; no database record",
      action: after === null ? "preserve" : "would update",
      before: fixture.currentDescription,
      after: after ?? fixture.currentDescription,
    })
  );
}
