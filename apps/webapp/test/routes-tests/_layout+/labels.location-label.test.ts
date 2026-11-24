// @vitest-environment node
import { describe, expect, it } from "vitest";
import { renderIoioLabelSvgMarkup } from "~/components/ioio-staff/ioio-labels";
import {
  getPrintableIoioLabelColor,
  getLabelPdfTitle,
  makeItemLabel,
  makeLocationLabel,
} from "~/routes/_layout+/labels";

function locationLabel(
  name: string,
  parentDepth = 3,
  level: "room" | "section" | "shelf" | "container" = "container"
) {
  const parents = [
    "IOIO Lab - B477",
    "Section A",
    "Shelf A1",
    "A1-1",
    name,
  ].slice(0, parentDepth);
  const names = [...parents, name];
  const locations = names.map((locationName, index) => ({
    id: `location-${index}`,
    name: locationName,
    parentId: index ? `location-${index - 1}` : null,
    color: index === 0 ? "#1565C0" : null,
  }));
  const location = locations.at(-1)!;
  const label = makeLocationLabel(
    location,
    new Map(locations.map((entry) => [entry.id, entry])),
    level,
    "http://localhost:3000"
  );
  return { label, location };
}

describe("IOIO location QR labels", () => {
  it("keeps each Section's persisted color even when a generic label color was chosen", () => {
    const sectionA = locationLabel("Section A", 1, "section").label;
    const sectionB = { ...sectionA, color: "#C62828" };
    expect(getPrintableIoioLabelColor(sectionA, "#C62828")).toBe(
      sectionA.color
    );
    expect(getPrintableIoioLabelColor(sectionB, sectionA.color)).toBe(
      "#C62828"
    );
  });
  it("uses the containing Section color for Section, Shelf, Container, and item labels", () => {
    const locations = [
      { id: "room", name: "IOIO Lab - B477", parentId: null, color: "#455A64" },
      { id: "section", name: "Section A", parentId: "room", color: "#1565C0" },
      { id: "shelf", name: "Shelf A1", parentId: "section", color: null },
      { id: "container", name: "A1-1.1", parentId: "shelf", color: null },
    ];
    const locationsById = new Map(
      locations.map((location) => [location.id, location])
    );

    for (const [id, level] of [
      ["section", "section"],
      ["shelf", "shelf"],
      ["container", "container"],
    ] as const) {
      expect(
        makeLocationLabel(
          locationsById.get(id)!,
          locationsById,
          level,
          "http://localhost:3000"
        ).color
      ).toBe("#1565C0");
    }
    expect(
      makeItemLabel(
        {
          kind: "asset",
          id: "asset",
          name: "Makey Kit",
          category: null,
          locationId: "container",
        },
        locationsById
      ).color
    ).toBe("#1565C0");
    expect(
      makeItemLabel(
        {
          kind: "kit",
          id: "kit",
          name: "Kit",
          category: null,
          locationId: "shelf",
        },
        locationsById
      ).color
    ).toBe("#1565C0");
  });

  it("updates item label colors from the current asset placement and Section hierarchy", () => {
    const locations = [
      { id: "room", name: "IOIO Lab - B477", parentId: null, color: "#455A64" },
      {
        id: "section-a",
        name: "Section A",
        parentId: "room",
        color: "#1565C0",
      },
      {
        id: "section-b",
        name: "Section B",
        parentId: "room",
        color: "#C62828",
      },
      { id: "shelf", name: "Shelf A1", parentId: "section-a", color: null },
      { id: "container", name: "A1-1.1", parentId: "shelf", color: null },
    ];
    const item = {
      kind: "asset" as const,
      id: "asset",
      name: "Makey Kit",
      category: null,
      locationId: "section-a",
    };
    const byId = () =>
      new Map(locations.map((location) => [location.id, location]));

    expect(makeItemLabel(item, byId()).color).toBe("#1565C0");
    expect(
      makeItemLabel({ ...item, locationId: "section-b" }, byId()).color
    ).toBe("#C62828");
    locations[3]!.parentId = "section-b";
    expect(
      makeItemLabel({ ...item, locationId: "container" }, byId()).color
    ).toBe("#C62828");
    locations[1]!.color = "#2E7D32";
    expect(makeItemLabel(item, byId()).color).toBe("#2E7D32");
    expect(
      makeItemLabel({ ...item, locationId: null }, byId()).color
    ).toBeDefined();
  });
  it("renders the existing Seciton A record as a single large A", () => {
    const { label } = locationLabel("Seciton A", 1, "section");
    const markup = renderIoioLabelSvgMarkup(label, {
      widthMm: 150,
      heightMm: 210,
    });
    const visibleText = [
      ...markup.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs),
    ].map(([, content]) =>
      [...content.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/gs)]
        .map(([, value]) => value)
        .join(" ")
    );

    expect(label.code).toBe("Seciton A");
    expect(visibleText).toEqual(["IOIO Lab - B477", "A", "SECTION"]);
  });

  it.each([
    ["Section A", "A"],
    ["Section C", "C"],
    ["Return Section", "Return"],
    ["Broken Section", "Broken"],
    ["Preparation Section", "Preparation"],
    ["Equipment Return Section", "Equipment Return"],
    ["SECTION B", "B"],
    ["Intersection", "Intersection"],
    ["Section", "Section"],
  ])("renders %s as only %s above the SECTION footer", (name, expected) => {
    const { label } = locationLabel(name, 1, "section");
    const markup = renderIoioLabelSvgMarkup(label, {
      widthMm: 150,
      heightMm: 210,
    });
    const visibleText = [
      ...markup.matchAll(/<text\b[^>]*>(.*?)<\/text>/gs),
    ].map(([, content]) =>
      [...content.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/gs)]
        .map(([, value]) => value)
        .join(" ")
    );

    expect(label.code).toBe(name);
    expect(visibleText).toEqual(["IOIO Lab - B477", expected, "SECTION"]);
  });

  it("does not repeat a stored Container prefix above the container type", () => {
    const { label, location } = locationLabel("Container A1-1.1");
    expect(label.code).toBe("Container A1-1.1");
    expect(label.displayCode).toBe("A1-1.1");
    expect(label.qrValue).toBe(
      `http://localhost:3000/ioio/browse?location=${location.id}`
    );

    const markup = renderIoioLabelSvgMarkup(label, {
      widthMm: 90,
      heightMm: 55,
    });
    const visibleText = [
      ...markup.matchAll(/<text\b([^>]*)>(.*?)<\/text>/gs),
    ].map(([, attributes, content]) => ({
      text: [...content.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/gs)]
        .map(([, value]) => value)
        .join(" "),
      fill: attributes.match(/fill="([^"]+)"/u)?.[1],
    }));

    expect(visibleText).toEqual([
      { text: "IOIO Lab - B477", fill: "#ffffff" },
      { text: "A1-1.1", fill: "#0c162d" },
      { text: "CONTAINER", fill: "#1565C0" },
    ]);
  });

  it("renders the exact assigned container name above its type label", () => {
    const { label } = locationLabel("A1-1.1");
    expect(label.code).toBe("A1-1.1");
    expect(label.subtitle).toBe("");
    expect(getLabelPdfTitle([label], "container")).toBe("A1-1.1");

    const markup = renderIoioLabelSvgMarkup(label, {
      widthMm: 140,
      heightMm: 88,
    });
    const primaryText = markup.match(
      /<text [^>]*font-weight="900"[^>]*>(.*?)<\/text>/u
    )?.[1];
    const typeText = markup.match(
      /<text [^>]*font-weight="800"[^>]*>(.*?)<\/text>/u
    )?.[1];
    expect(primaryText).toContain("A1-1.1");
    expect(typeText).toContain("CONTAINER");
  });

  it("keeps optional custom text out of the primary identifier", () => {
    const { label } = locationLabel("A1-1.1");
    const markup = renderIoioLabelSvgMarkup(
      { ...label, customText: "Container" },
      { widthMm: 140, heightMm: 88 }
    );
    const primaryText = markup.match(
      /<text [^>]*font-weight="900"[^>]*>(.*?)<\/text>/u
    )?.[1];

    expect(primaryText).toContain("A1-1.1");
    expect(primaryText).not.toContain("Container");
  });

  it("fits longer assigned container names without truncating them", () => {
    const name = "Cabinet A1-1.1-2 north-west_storage";
    const { label } = locationLabel(name);
    const markup = renderIoioLabelSvgMarkup(label, {
      widthMm: 140,
      heightMm: 88,
    });
    const primaryLines = [
      ...markup.matchAll(/<text [^>]*font-weight="900"[^>]*>(.*?)<\/text>/gu),
    ]
      .flatMap(([, content]) =>
        [...content.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/gu)].map(
          ([, line]) => line
        )
      )
      .join(" ")
      .replace(/\s+/gu, " ")
      .trim();

    expect(primaryLines).toBe(name);
    expect(primaryLines).not.toContain("…");
  });

  it.each(["A1-1.1_layer West", "Container A1-1.1_layer West"])(
    "preserves the exact assigned punctuation in %s",
    (name) => {
      const { label } = locationLabel(name);
      expect(label.code).toBe(name);
    }
  );

  it("uses the selected deeply nested record instead of its parent and preserves its QR target", () => {
    const { label, location } = locationLabel("Box West_2.1", 4);

    expect(label.code).toBe("Box West_2.1");
    expect(label.qrValue).toBe(
      `http://localhost:3000/ioio/browse?location=${location.id}`
    );
  });

  it.each([
    ["room", 0],
    ["section", 1],
    ["shelf", 2],
    ["container", 3],
  ] as const)("uses the assigned name for a %s label", (level, parentDepth) => {
    const name = "A1-1.1_layer West";
    const { label } = locationLabel(name, parentDepth, level);
    expect(label.code).toBe(name);
  });
});
