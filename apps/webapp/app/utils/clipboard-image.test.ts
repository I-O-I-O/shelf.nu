import { describe, expect, it } from "vitest";
import { getClipboardImage } from "./clipboard-image";

function clipboard(items: Partial<DataTransferItem>[], files: File[] = []) {
  return { items, files } as unknown as DataTransfer;
}
describe("clipboard image extraction", () => {
  const png = new File(["png"], "clipboard.png", { type: "image/png" });
  it("uses a readable image item", () => {
    expect(
      getClipboardImage(
        clipboard([{ type: "image/png", getAsFile: () => png }])
      )
    ).toBe(png);
  });
  it("falls back to files when an item has no readable file", () => {
    expect(
      getClipboardImage(
        clipboard([{ type: "image/png", getAsFile: () => null }], [png])
      )
    ).toBe(png);
  });
  it("ignores text, non-image files and missing clipboard data", () => {
    expect(getClipboardImage(null)).toBeUndefined();
    expect(
      getClipboardImage(
        clipboard(
          [{ type: "text/plain" }],
          [new File(["text"], "notes.txt", { type: "text/plain" })]
        )
      )
    ).toBeUndefined();
  });
});
