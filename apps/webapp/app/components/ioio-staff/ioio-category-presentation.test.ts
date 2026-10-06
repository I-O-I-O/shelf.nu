import { getIoioCategoryColor } from "./ioio-category-presentation";

describe("IOIO category presentation", () => {
  it("provides a safe fallback when no Category record is available", () => {
    expect(getIoioCategoryColor("Furniture")).toBe("#827717");
  });
});
