import { describe, expect, it } from "vitest";
import { isIoioAssetHidden } from "./visibility.shared";

describe("IOIO student visibility", () => {
  it("recognizes a hidden standalone asset without changing its availability", () => {
    expect(
      isIoioAssetHidden({ ioioHidden: true, availableToBook: true } as never)
    ).toBe(true);
  });

  it("recognizes a hidden model for its linked product units", () => {
    expect(
      isIoioAssetHidden(
        {
          ioioHidden: false,
          assetModel: {
            organizationId: "org-1",
            ioioHidden: true,
          },
        },
        "org-1"
      )
    ).toBe(true);
  });

  it("does not apply a foreign model's visibility to another organization", () => {
    expect(
      isIoioAssetHidden(
        {
          ioioHidden: false,
          assetModel: {
            organizationId: "org-2",
            ioioHidden: true,
          },
        },
        "org-1"
      )
    ).toBe(false);
  });
});
