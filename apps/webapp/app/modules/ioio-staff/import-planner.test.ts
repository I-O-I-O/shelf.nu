import { describe, expect, it } from "vitest";
import {
  chunkImportUnitWork,
  formatIndividualUnitTitle,
  planIndividualUnitWork,
  planStaffInventoryImport,
  resolveIndividualUnitTitles,
} from "./import-planner";

const proposal = {
  operationId: "operation-1",
  rows: [
    { rowNumber: 2, action: "CREATE" },
    { rowNumber: 3, action: "IGNORE" },
  ],
};

describe("staff inventory import planner", () => {
  it("produces stable row identities for the same prepared proposal", () => {
    const first = planStaffInventoryImport(proposal);
    const second = planStaffInventoryImport(proposal);

    expect(second).toEqual(first);
    expect(first).toEqual([
      {
        rowKey: "row-2",
        unitIndex: null,
        kind: "CREATE",
        identityKey: "row-2:row",
        idempotencyKey: "operation-1:row-2:row",
      },
      {
        rowKey: "row-3",
        unitIndex: null,
        kind: "IGNORE",
        identityKey: "row-3:row",
        idempotencyKey: "operation-1:row-3:row",
      },
    ]);
  });

  it("plans stable per-unit identities and zero-padded titles", () => {
    const titles = resolveIndividualUnitTitles({
      productTitle: "Arduino Nano",
      quantity: 5,
      operationId: "operation-123456",
      rowNumber: 2,
      existingTitles: new Set(),
    });
    const work = planIndividualUnitWork({
      operationId: proposal.operationId,
      rowNumber: 2,
      assetModelId: "model-1",
      units: titles,
    });

    expect(titles.map(({ title }) => title)).toEqual([
      "Arduino Nano #001",
      "Arduino Nano #002",
      "Arduino Nano #003",
      "Arduino Nano #004",
      "Arduino Nano #005",
    ]);
    expect(work.map(({ identityKey }) => identityKey)).toEqual([
      "row-2:unit:0",
      "row-2:unit:1",
      "row-2:unit:2",
      "row-2:unit:3",
      "row-2:unit:4",
    ]);
    expect(
      planIndividualUnitWork({
        operationId: proposal.operationId,
        rowNumber: 2,
        assetModelId: "model-1",
        units: titles,
      })
    ).toEqual(work);
  });

  it("pads beyond three digits when a product has more than 99 units", () => {
    expect(
      formatIndividualUnitTitle({
        productTitle: "Arduino Nano",
        quantity: 120,
        unitIndex: 0,
      })
    ).toBe("Arduino Nano #001");
    expect(
      formatIndividualUnitTitle({
        productTitle: "Arduino Nano",
        quantity: 120,
        unitIndex: 99,
      })
    ).toBe("Arduino Nano #100");
  });

  it("resolves existing title collisions deterministically", () => {
    const args = {
      productTitle: "Arduino Nano",
      quantity: 2,
      operationId: "operation-123456",
      rowNumber: 2,
      existingTitles: new Set(["Arduino Nano #001"]),
    };

    expect(resolveIndividualUnitTitles(args)).toEqual(
      resolveIndividualUnitTitles(args)
    );
    expect(resolveIndividualUnitTitles(args)[0].title).toBe(
      "Arduino Nano #001 (import 123456-r2-u001)"
    );
  });

  it("chunks units without changing their global unit indices", () => {
    const units = Array.from({ length: 100 }, (_, unitIndex) => ({
      unitIndex,
      targetAssetId: `asset-${unitIndex}`,
    }));
    const chunks = chunkImportUnitWork(units, 25);

    expect(chunks.map((chunk) => chunk.length)).toEqual([25, 25, 25, 25]);
    expect(chunks.flat().map(({ unitIndex }) => unitIndex)).toEqual(
      Array.from({ length: 100 }, (_, index) => index)
    );
  });
});
