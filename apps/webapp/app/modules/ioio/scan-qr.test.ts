import { describe, expect, it } from "vitest";
import { getInventoryQrDestination, parseInventoryQrValue } from "./scan-qr";

describe("inventory QR destinations", () => {
  it("resolves existing Shelf asset and kit QR URLs", () => {
    expect(parseInventoryQrValue("https://shelf.nu/qr/cmv1234567")).toEqual({
      kind: "shelf-qr",
      qrId: "cmv1234567",
    });
    expect(parseInventoryQrValue("https://qr.shelf.nu/cmv1234567")).toEqual({
      kind: "shelf-qr",
      qrId: "cmv1234567",
    });
  });

  it("recognizes a nested location label and uses the normal location filter", () => {
    const parsed = parseInventoryQrValue(
      "https://shelf.nu/ioio/browse?location=container-4"
    );
    expect(parsed).toEqual({ kind: "location", locationId: "container-4" });
    if (parsed.kind === "location") {
      expect(
        getInventoryQrDestination(
          { kind: "location", locationId: parsed.locationId },
          "student"
        )
      ).toBe("/ioio/browse?location=container-4");
      expect(
        getInventoryQrDestination(
          { kind: "location", locationId: parsed.locationId },
          "staff"
        )
      ).toBe("/assets?location=container-4");
    }
  });

  it("routes assets through each audience's existing inventory detail", () => {
    const target = { kind: "asset" as const, assetId: "asset-1" };
    expect(getInventoryQrDestination(target, "student")).toBe(
      "/ioio/browse/asset-1"
    );
    expect(getInventoryQrDestination(target, "staff")).toBe(
      "/assets/asset-1/overview"
    );
  });

  it("rejects an unsupported QR payload", () => {
    expect(parseInventoryQrValue("not a QR destination")).toEqual({
      kind: "invalid",
    });
  });
});
