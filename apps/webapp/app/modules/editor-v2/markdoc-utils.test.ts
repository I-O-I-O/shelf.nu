import { describe, expect, it } from "vitest";
import {
  createEditorSchema,
  parseMarkdoc,
  serializeMarkdoc,
} from "./markdoc-utils";

describe("Handbook rich text Markdown persistence", () => {
  it("round-trips headings, emphasis, links, lists, and stored inline images", () => {
    const schema = createEditorSchema();
    const source = [
      "## Soldering setup",
      "",
      "Use a **clean** iron and read the [manufacturer guide](https://example.com/manual).",
      "",
      "![Iron setup](/api/image/image-1)",
      "",
      "- Check the tip",
      "- Set the temperature",
    ].join("\n");

    const saved = serializeMarkdoc(parseMarkdoc(source, schema), schema);

    expect(saved).toContain("## Soldering setup");
    expect(saved).toContain("**clean**");
    expect(saved).toContain("[manufacturer guide](https://example.com/manual)");
    expect(saved).toContain("![Iron setup](/api/image/image-1)");
    expect(saved).toContain("- Check the tip");
    expect(saved).toContain("- Set the temperature");
  });
});
