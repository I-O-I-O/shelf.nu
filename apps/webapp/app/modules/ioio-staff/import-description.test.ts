import { describe, expect, it } from "vitest";
import {
  buildLegacyImportedDescription,
  importedDescription,
  repairImportedDescription,
} from "./import-description";
import type { StaffImportProposalRow } from "./inventory-import.server";
import { importDescriptionFixtures } from "../../../test/factories/ioio-import-descriptions";

function joystick(overrides: Partial<StaffImportProposalRow> = {}) {
  return {
    title: "TinkerKit joystick module",
    sourceDescription: "TinkerKit joystick module.",
    assetModelDescription: null,
    sourceOrganization: "IOIO Lab",
    sourceRoom: "B477",
    sourceStorageLocation: "A3-5",
    manufacturer: "TinkerKi",
    ...overrides,
  } as StaffImportProposalRow;
}
const useful =
  "TinkerKit joystick module for directional input in Arduino and electronics projects.";
const filename = "IOIO_Lab_B477_A3_Claude_Import.pdf";
describe("import descriptions", () => {
  it("prefers useful joystick information and otherwise leaves it blank", () => {
    expect(importedDescription(joystick())).toBe("");
    expect(
      importedDescription(joystick({ assetModelDescription: useful }))
    ).toBe(useful);
  });
  it.each([
    "Imported from test.pdf",
    "Source lab: IOIO Lab",
    "Source room: B477",
    "Source storage location: A3-5",
    "Source description: joystick",
    "Manufacturer: TinkerKi",
  ])("rejects provenance: %s", (metadata) => {
    expect(
      importedDescription(
        joystick({ assetModelDescription: `${useful} ${metadata}` })
      )
    ).toBe("");
  });
  it("repairs only exact generated descriptions and preserves source evidence", () => {
    const row = joystick({ assetModelDescription: useful });
    const before = JSON.stringify(row);
    const legacy = buildLegacyImportedDescription(filename, row);
    expect(
      repairImportedDescription(`${useful}\n\n${legacy}`, filename, row)
    ).toBe(useful);
    expect(repairImportedDescription(legacy, filename, row)).toBe(useful);
    expect(JSON.stringify(row)).toBe(before);
    expect(
      repairImportedDescription(
        `${legacy} Manually added advice.`,
        filename,
        row
      )
    ).toBeNull();
    expect(
      repairImportedDescription(
        "Use this joystick with our student kits.",
        filename,
        row
      )
    ).toBeNull();
  });
  it.each(importDescriptionFixtures())(
    "previews $id without changing source evidence or manual text",
    (fixture) => {
      const before = JSON.stringify(fixture);
      const result = repairImportedDescription(
        fixture.currentDescription,
        fixture.filename,
        fixture.row
      );
      if (fixture.id.startsWith("fixture-manual")) {
        expect(result).toBeNull();
      } else {
        expect(result).toBe(fixture.expectedDescription);
        expect(result).not.toMatch(
          /Imported from|Source (?:lab|room|storage location|description):|Manufacturer:/
        );
        expect(fixture.row).toMatchObject({
          sourceOrganization: "IOIO Lab",
          sourceRoom: "B477",
        });
      }
      expect(JSON.stringify(fixture)).toBe(before);
    }
  );

  it("bounds new user-facing text to two sentences", () => {
    expect(
      importedDescription(
        joystick({
          assetModelDescription: `${useful} Connect using the supplied cable. Extra sentence.`,
        })
      )
    ).toBe(`${useful} Connect using the supplied cable.`);
  });
});
