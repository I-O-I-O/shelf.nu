import { describe, expect, it } from "vitest";
import {
  fitsIoioA4Portrait,
  getIoioCloseUpPreviewSize,
  getIoioA4Capacity,
  getIoioA4PreviewScale,
  getIoioDefaultQrEnabled,
  getIoioDefaultPrintSize,
  getIoioPrintDimensions,
  getIoioPrintDimensionsError,
  IOIO_A4,
  IOIO_BOX_PRINT_PRESETS,
  IOIO_ITEM_PRINT_PRESETS,
  IOIO_KIT_PRINT_PRESETS,
  IOIO_PRINT_SIZE_ORDER,
  IOIO_ROOM_PRINT_PRESETS,
  IOIO_SECTION_PRINT_PRESETS,
  IOIO_SHELF_DEFAULT_DIMENSIONS,
  IOIO_SHELF_PRINT_PRESETS,
} from "./ioio-label-sizing";
import {
  IOIO_LABEL_CUSTOM_TEXT_MAX_LENGTH,
  getIoioLocationIdentifier,
  getIoioLocationPathIdentifier,
  normalizeIoioCustomLabelText,
  normalizeIoioLabelText,
  renderIoioLabelSvgMarkup,
} from "./ioio-labels";

const labelBase = {
  layout: "horizontal" as const,
  color: "#1565C0",
  colorName: "Blue",
  code: "A1",
  title: "Shelf",
  subtitle: "",
  room: "IOIO Lab / B477",
  headerMeta: "IOIO Lab - B477",
  scanText: "Scan to view this location",
  qrValue: "/ioio/browse?location=shelf-a1",
};

describe("IOIO label sizing", () => {
  it("fits close-up labels to both viewport dimensions without stretching", () => {
    const size = getIoioCloseUpPreviewSize(800, 500, {
      widthMm: 105,
      heightMm: 64,
    });

    expect(size.width).toBeLessThanOrEqual(776);
    expect(size.height).toBeLessThanOrEqual(476);
    expect(size.width / size.height).toBeCloseTo(105 / 64, 10);

    const heightLimited = getIoioCloseUpPreviewSize(1000, 300, {
      widthMm: 160,
      heightMm: 98,
    });
    expect(heightLimited.height).toBeCloseTo(276, 10);
    expect(heightLimited.width).toBeLessThanOrEqual(976);
  });

  it("builds an assigned Kit identifier from the deepest real location path", () => {
    expect(
      getIoioLocationPathIdentifier([
        { name: "IOIO Lab - B477" },
        { name: "Section A" },
        { name: "Shelf A1" },
        { name: "Box 13" },
      ])
    ).toBe("A1-13");
    expect(
      getIoioLocationPathIdentifier([
        { name: "IOIO Lab - B477" },
        { name: "Section A" },
        { name: "Shelf A1" },
      ])
    ).toBe("A1");
    expect(
      getIoioLocationPathIdentifier([
        { name: "IOIO Lab - B477" },
        { name: "Section A" },
      ])
    ).toBe("A");
    expect(getIoioLocationPathIdentifier([{ name: "IOIO Lab - B477" }])).toBe(
      null
    );
  });

  it("defines deterministic per-type dimensions for all seven sizes", () => {
    expect(IOIO_PRINT_SIZE_ORDER).toEqual([
      "xxs",
      "xs",
      "s",
      "m",
      "l",
      "xl",
      "xxl",
    ]);
    expect(IOIO_ROOM_PRINT_PRESETS).toEqual({
      xxs: { widthMm: 120, heightMm: 60 },
      xs: { widthMm: 160, heightMm: 75 },
      s: { widthMm: 200, heightMm: 90 },
      m: { widthMm: 240, heightMm: 110 },
      l: { widthMm: 280, heightMm: 130 },
      xl: { widthMm: 320, heightMm: 150 },
      xxl: { widthMm: 360, heightMm: 180 },
    });
    expect(IOIO_SECTION_PRINT_PRESETS).toEqual({
      xxs: { widthMm: 80, heightMm: 110 },
      xs: { widthMm: 95, heightMm: 135 },
      s: { widthMm: 115, heightMm: 160 },
      m: { widthMm: 150, heightMm: 210 },
      l: { widthMm: 165, heightMm: 230 },
      xl: { widthMm: 180, heightMm: 255 },
      xxl: { widthMm: 195, heightMm: 280 },
    });
  });

  it("uses the defined shelf and box size families", () => {
    expect(IOIO_SHELF_PRINT_PRESETS).toEqual({
      xxs: { widthMm: 45, heightMm: 60 },
      xs: { widthMm: 60, heightMm: 80 },
      s: { widthMm: 75, heightMm: 100 },
      m: { widthMm: 90, heightMm: 120 },
      l: { widthMm: 105, heightMm: 140 },
      xl: { widthMm: 120, heightMm: 160 },
      xxl: { widthMm: 135, heightMm: 180 },
    });
    expect(IOIO_SHELF_DEFAULT_DIMENSIONS).toEqual({
      widthMm: 90,
      heightMm: 120,
    });
    expect(IOIO_BOX_PRINT_PRESETS).toEqual({
      xxs: { widthMm: 55, heightMm: 35 },
      xs: { widthMm: 65, heightMm: 40 },
      s: { widthMm: 75, heightMm: 46 },
      m: { widthMm: 90, heightMm: 55 },
      l: { widthMm: 105, heightMm: 65 },
      xl: { widthMm: 120, heightMm: 75 },
      xxl: { widthMm: 140, heightMm: 88 },
    });
    expect(
      IOIO_PRINT_SIZE_ORDER.map((key) =>
        getIoioPrintDimensions("horizontal", key, "container")
      )
    ).toEqual(Object.values(IOIO_BOX_PRINT_PRESETS));
  });

  it("keeps the smallest kit label within a small kit-box face", () => {
    expect(IOIO_KIT_PRINT_PRESETS).toEqual({
      xxs: { widthMm: 60, heightMm: 38 },
      xs: { widthMm: 75, heightMm: 46 },
      s: { widthMm: 90, heightMm: 55 },
      m: { widthMm: 105, heightMm: 64 },
      l: { widthMm: 120, heightMm: 74 },
      xl: { widthMm: 140, heightMm: 86 },
      xxl: { widthMm: 160, heightMm: 98 },
    });
    expect(IOIO_KIT_PRINT_PRESETS.xxs.widthMm).toBeLessThanOrEqual(89);
    expect(IOIO_KIT_PRINT_PRESETS.xxs.heightMm).toBeLessThanOrEqual(64);
    expect(IOIO_KIT_PRINT_PRESETS.m).toEqual({
      widthMm: 105,
      heightMm: 64,
    });
  });

  it("gives individual labels compact QR-first dimensions", () => {
    expect(IOIO_ITEM_PRINT_PRESETS).toEqual({
      xxs: { widthMm: 35, heightMm: 20 },
      xs: { widthMm: 45, heightMm: 25 },
      s: { widthMm: 55, heightMm: 30 },
      m: { widthMm: 70, heightMm: 40 },
      l: { widthMm: 85, heightMm: 50 },
      xl: { widthMm: 100, heightMm: 60 },
      xxl: { widthMm: 120, heightMm: 70 },
    });
  });

  it("uses practical type-specific defaults and retains S/M/L controls", () => {
    expect(getIoioDefaultPrintSize("room")).toBe("s");
    expect(getIoioDefaultPrintSize("section")).toBe("m");
    expect(getIoioDefaultPrintSize("shelf")).toBe("m");
    expect(getIoioDefaultPrintSize("container")).toBe("m");
    expect(getIoioDefaultPrintSize("kit")).toBe("m");
    expect(getIoioDefaultPrintSize("item")).toBe("s");
  });

  it("defaults QR on only for Container, Kit, and Individual item labels", () => {
    expect(getIoioDefaultQrEnabled("room")).toBe(false);
    expect(getIoioDefaultQrEnabled("section")).toBe(false);
    expect(getIoioDefaultQrEnabled("shelf")).toBe(false);
    expect(getIoioDefaultQrEnabled("container")).toBe(true);
    expect(getIoioDefaultQrEnabled("kit")).toBe(true);
    expect(getIoioDefaultQrEnabled("item")).toBe(true);
  });

  it("builds location identifiers from hierarchy", () => {
    const section = getIoioLocationIdentifier("Section A", "section");
    const shelf = getIoioLocationIdentifier("Shelf 1", "shelf", section);

    expect(section).toBe("A");
    expect(shelf).toBe("A1");
    expect(getIoioLocationIdentifier("Shelf A1", "shelf", section)).toBe("A1");
    expect(getIoioLocationIdentifier("Box 13", "box", shelf)).toBe("A1-13");
    expect(normalizeIoioLabelText("Kit \u2013 Test")).toBe("Kit - Test");
  });

  it("calculates physical A4 scale and batch capacity", () => {
    const scale = getIoioA4PreviewScale({ widthMm: 100, heightMm: 55 });
    const capacity = getIoioA4Capacity({ widthMm: 60, heightMm: 30 });
    const oversizeCapacity = getIoioA4Capacity({
      widthMm: 240,
      heightMm: 110,
    });

    expect(scale.widthPercent).toBeCloseTo((100 / IOIO_A4.widthMm) * 100);
    expect(scale.heightPercent).toBeCloseTo((55 / IOIO_A4.heightMm) * 100);
    expect(capacity).toEqual({ columns: 3, rows: 8, capacity: 24 });
    expect(oversizeCapacity).toEqual({ columns: 0, rows: 0, capacity: 0 });
    expect(fitsIoioA4Portrait({ widthMm: 200, heightMm: 110 })).toBe(true);
    expect(fitsIoioA4Portrait({ widthMm: 240, heightMm: 110 })).toBe(false);
  });

  it("rejects invalid dimensions but retains large physical presets", () => {
    expect(getIoioPrintDimensionsError({ widthMm: 0, heightMm: 40 })).toBe(
      "Enter a valid label width and height."
    );
    expect(getIoioPrintDimensionsError({ widthMm: 360, heightMm: 180 })).toBe(
      null
    );
    expect(
      getIoioPrintDimensionsError({ widthMm: 190, heightMm: 125 })
    ).toBeNull();
  });

  it("uses the exact physical aspect ratio in the shared preview/export SVG", () => {
    const markup = renderIoioLabelSvgMarkup(
      { ...labelBase, variant: "shelf", code: "A1", title: "SHELF" },
      { widthMm: 90, heightMm: 120 }
    );

    expect(markup).toContain('width="90mm" height="120mm"');
    expect(markup).toContain('viewBox="0 0 90 120"');
    expect(markup).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(markup).toContain("IOIO Lab - B477");
    expect(markup).toContain(">A1</tspan>");
    expect(markup).toContain(">SHELF</tspan>");
    expect(markup).not.toContain("Boards &amp; Embedded");
    expect(markup).not.toContain("scaleX");
    expect(markup).not.toContain("scaleY");
    expect(markup).not.toContain('data-ioio-qr="true"');
  });

  it("preserves authoritative room header text exactly", () => {
    const headerMeta = "IOIO Lab - B477";
    const markup = renderIoioLabelSvgMarkup(
      { ...labelBase, variant: "shelf", headerMeta },
      { widthMm: 90, heightMm: 120 }
    );

    expect(markup).toContain(`>${headerMeta}</tspan>`);
    expect(markup).not.toContain("B4-77");
  });

  it("renders Section labels with a colored field and outlined white footer box", () => {
    const markup = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "section",
        code: "A",
        title: "SECTION",
        qrValue: undefined,
      },
      { widthMm: 150, heightMm: 210 }
    );
    const sectionFooterText = markup.match(
      /<text x="75" y="[\d.]+"[^>]*font-weight="800" fill="#1565C0"><tspan x="75" y="([\d.]+)">SECTION/u
    );

    expect(markup).toContain(
      '<rect x="0" y="184.8" width="150" height="25.2" fill="#ffffff"/>'
    );
    expect(markup).toContain(
      '<path d="M0.85 184.8H149.15V207.5Q149.15 209.15 147.5 209.15H2.5Q0.85 209.15 0.85 207.5Z" fill="none" stroke="#1565C0" stroke-width="0.9"/>'
    );
    expect(sectionFooterText).not.toBeNull();
    expect(Number(sectionFooterText?.[1])).toBeGreaterThan(184.8);
    expect(Number(sectionFooterText?.[1])).toBeLessThan(210);
    expect(markup).toContain(">A</tspan>");
  });

  it("renders Shelf labels with an adaptive outlined white footer box", () => {
    const markup = renderIoioLabelSvgMarkup(
      { ...labelBase, variant: "shelf", code: "A1", title: "SHELF" },
      { widthMm: 90, heightMm: 120 }
    );
    const shelfText = markup.match(
      /<text x="45" y="([\d.]+)" text-anchor="middle"[^>]*font-weight="800"[^>]*>\s*<tspan[^>]*y="([\d.]+)">SHELF/u
    );

    expect(markup).toContain(
      '<rect x="0" y="103.2" width="90" height="16.8" fill="#ffffff"/>'
    );
    expect(markup).toContain(
      '<path d="M0.85 103.2H89.15V117.5Q89.15 119.15 87.5 119.15H2.5Q0.85 119.15 0.85 117.5Z" fill="none" stroke="#1565C0" stroke-width="0.9"/>'
    );
    expect(shelfText).not.toBeNull();
    expect(Number(shelfText?.[2])).toBeGreaterThan(103.2);
    expect(Number(shelfText?.[2])).toBeLessThan(118);
  });

  it("scales Section and Shelf footer typography with physical size", () => {
    const footerFontSize = (
      variant: "section" | "shelf",
      widthMm: number,
      heightMm: number
    ) => {
      const markup = renderIoioLabelSvgMarkup(
        { ...labelBase, variant, code: variant === "section" ? "A" : "A1" },
        { widthMm, heightMm }
      );
      return Number(
        markup.match(
          /font-size="([\d.]+)" font-weight="800" fill="#1565C0"><tspan[^>]*>(?:SECTION|SHELF)/u
        )?.[1]
      );
    };

    expect(footerFontSize("section", 195, 280)).toBeGreaterThan(
      footerFontSize("section", 80, 110)
    );
    expect(footerFontSize("shelf", 135, 180)).toBeGreaterThan(
      footerFontSize("shelf", 45, 60)
    );
  });

  it("can omit type captions without leaving empty footer bands", () => {
    const section = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "section",
        code: "A",
        title: "SECTION",
        showTypeLabel: false,
      },
      { widthMm: 150, heightMm: 210 }
    );
    const shelf = renderIoioLabelSvgMarkup(
      { ...labelBase, variant: "shelf", code: "A1", showTypeLabel: false },
      { widthMm: 90, heightMm: 120 }
    );
    const box = renderIoioLabelSvgMarkup(
      { ...labelBase, variant: "box", code: "A1-13", showTypeLabel: false },
      { widthMm: 90, heightMm: 55 }
    );
    const kit = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "kit",
        title: "Makey Makey Kit",
        showTypeLabel: false,
      },
      { widthMm: 105, heightMm: 64 }
    );

    expect(section).not.toContain('width="150" height="25.2" fill="#ffffff"');
    expect(section).not.toContain(">SECTION</tspan>");
    expect(section).toContain(">A</tspan>");
    expect(shelf).not.toContain('width="90" height="16.8" fill="#ffffff"');
    expect(shelf).not.toContain(">SHELF</tspan>");
    expect(box).not.toContain(">BOX</tspan>");
    expect(kit).not.toContain(">KIT</tspan>");
    expect(kit).toContain(">Makey Makey Kit</tspan>");
  });

  it("keeps identifiers dominant with QR proportions specific to each type", () => {
    const qrWidth = (
      variant: "room" | "section" | "shelf" | "box" | "kit" | "item",
      size: { widthMm: number; heightMm: number }
    ) => {
      const markup = renderIoioLabelSvgMarkup({ ...labelBase, variant }, size);
      return {
        qr: Number(markup.match(/data-qr-block-size="([^"]+)"/u)?.[1]),
        text: [...markup.matchAll(/<text [^>]*font-size="([^"]+)"/gu)].map(
          (match) => Number(match[1])
        ),
      };
    };

    const box = qrWidth("box", { widthMm: 150, heightMm: 75 });
    const kit = qrWidth("kit", { widthMm: 90, heightMm: 60 });
    const item = qrWidth("item", { widthMm: 70, heightMm: 40 });

    expect(box.qr / 150).toBeGreaterThan(0.2);
    expect(kit.qr / 90).toBeGreaterThan(0.2);
    expect(item.qr / 70).toBeGreaterThan(0.3);
  });

  it("wraps long location and asset names and keeps unit numbers visible", () => {
    const roomMarkup = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "room",
        code: "B477",
        title: "ROOM",
        headerMeta:
          "International Robotics and Fabrication Laboratory North Wing - B477",
      },
      { widthMm: 160, heightMm: 100 }
    );
    const locationMarkup = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "section",
        code: "Measurement and Calibration Section Name That Is Much Too Long",
        title: "SECTION",
      },
      { widthMm: 130, heightMm: 85 }
    );
    const shelfMarkup = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "shelf",
        code: "Shelf A1 with a Long Measurement and Electronics Name",
        title: "SHELF",
      },
      { widthMm: 100, heightMm: 55 }
    );
    const assetMarkup = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "item",
        title: "A Very Long Oscilloscope and Measurement Equipment Name #001",
        subtitle: "Measurement & Lab Equipment",
      },
      { widthMm: 50, heightMm: 34 }
    );

    expect(roomMarkup).toContain(">International Robotics");
    expect(roomMarkup).toContain(">Laboratory North Wing");
    expect(roomMarkup).toContain("International");
    expect(locationMarkup).toContain("Measurement");
    expect(shelfMarkup).toContain(">SHELF</tspan>");
    expect(shelfMarkup).toContain(">Shelf A1 with a Long Measurement</tspan>");
    expect(shelfMarkup).toContain(">and Electronics Name</tspan>");
    expect(shelfMarkup).not.toContain("…");
    expect(assetMarkup).toContain(">#001</tspan>");
    expect(assetMarkup).toContain("…");
    expect(assetMarkup).toContain('viewBox="0 0 50 34"');
  });

  it("keeps complete location names visible with natural wrapping", () => {
    expect(getIoioLocationIdentifier("Section A", "section")).toBe("A");
    expect(getIoioLocationIdentifier("Section B", "section")).toBe("B");

    const locationNames = [
      "Pick-Up Zone",
      "Return Zone",
      "Broken Zone",
      "Electronics Return Zone",
      "Equipment Pickup Zone",
    ];
    const rendered = locationNames.map((name) => {
      const displayName = getIoioLocationIdentifier(name, "section");
      const markup = renderIoioLabelSvgMarkup(
        {
          ...labelBase,
          variant: "section",
          code: displayName,
          title: "SECTION",
        },
        { widthMm: 150, heightMm: 210 }
      );
      const mainText = [...markup.matchAll(/<text [^>]*>(.*?)<\/text>/gu)]
        .map(([, content]) => content)
        .find((content) => content.includes(displayName.split(/\s+/u)[0]));
      const lines = [
        ...(mainText ?? "").matchAll(/<tspan[^>]*>(.*?)<\/tspan>/gu),
      ]
        .map(([, line]) => line)
        .join(" ");
      const fontSize = Number(
        markup.match(/font-size="([\d.]+)" font-weight="900"/u)?.[1]
      );

      return { name, displayName, mainText, lines, fontSize };
    });

    const expectedLines: Record<string, string[]> = {
      "PICK-UP ZONE": ["PICK-UP", "ZONE"],
      "RETURN ZONE": ["RETURN", "ZONE"],
      "BROKEN ZONE": ["BROKEN", "ZONE"],
      "ELECTRONICS RETURN ZONE": ["ELECTRONICS", "RETURN ZONE"],
      "EQUIPMENT PICKUP ZONE": ["EQUIPMENT", "PICKUP ZONE"],
    };
    for (const { name, displayName, mainText, lines } of rendered) {
      expect(mainText, name).toBeDefined();
      expect(
        [...mainText!.matchAll(/<tspan[^>]*>(.*?)<\/tspan>/gu)].map(
          ([, line]) => line
        ),
        name
      ).toEqual(expectedLines[displayName]);
      expect(lines, name).toBe(displayName);
      expect(mainText, name).not.toContain("…");
      expect(
        [...mainText!.matchAll(/<tspan /gu)].length,
        name
      ).toBeLessThanOrEqual(2);
    }

    const sectionA = renderIoioLabelSvgMarkup(
      { ...labelBase, variant: "section", code: "A", title: "SECTION" },
      { widthMm: 150, heightMm: 210 }
    );
    const sectionAFont = Number(
      sectionA.match(/font-size="([\d.]+)" font-weight="900"/u)?.[1]
    );
    expect(sectionAFont).toBeGreaterThan(rendered.at(-1)!.fontSize);
  });

  it("does not emit text outside physically unusable custom dimensions", () => {
    const markup = renderIoioLabelSvgMarkup(
      { ...labelBase, variant: "item", title: "#001" },
      { widthMm: 3, heightMm: 1.5 }
    );

    expect(markup).toContain('width="3mm" height="1.5mm"');
    expect(markup).not.toContain("<text");
    expect(markup).not.toContain("<image");
  });

  it("keeps kit names inside a separate QR column and omits category text", () => {
    const markup = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "kit",
        title: "Makey Makey Kit with a Long Descriptive Name",
        subtitle: "KIT",
      },
      { widthMm: 70, heightMm: 45 }
    );

    expect(markup).toContain("Makey");
    expect(markup).toContain("Makey Makey Kit");
    expect(markup).not.toContain("Boards &amp; Embedded");
    expect(markup).toContain("KIT");
    expect(markup).toContain('data-ioio-qr="true"');
    expect(markup).toContain('viewBox="0 0 70 45"');
  });

  it("prints the full native Kit display name", () => {
    const markup = renderIoioLabelSvgMarkup(
      { ...labelBase, variant: "kit", title: "Arduino Kit" },
      { widthMm: 70, heightMm: 45 }
    );

    expect(markup).toContain('aria-label="Arduino Kit"');
    expect(markup).toContain(">Arduino Kit</tspan>");
  });

  it.each([
    "Arduino Kit",
    "Makey Makey Kit",
    "Raspberry Pi Kit",
    "micro:bit Kit",
  ])("keeps the common Kit name %s on one line", (title) => {
    const markup = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "kit",
        title,
        unitNumber: "#001",
      },
      { widthMm: 105, heightMm: 64 }
    );
    const nameText = [
      ...markup.matchAll(/<text x="[\d.]+"[^>]*>(.*?)<\/text>/gu),
    ]
      .map(([, content]) => content)
      .find((content) => content.includes(title));

    expect(nameText).toBeDefined();
    expect([...nameText!.matchAll(/<tspan /gu)]).toHaveLength(1);
    expect(nameText).toContain(`>${title}</tspan>`);
  });

  it("keeps a common Kit name on one line with its unit below and QR on the right", () => {
    const markup = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "kit",
        title: "Makey Makey Kit",
        unitNumber: "#003",
        headerMeta: "IOIO Lab - B477 - D4-1",
        headerRightText: "KIT",
      },
      { widthMm: 105, heightMm: 64 }
    );
    const qrX = Number(markup.match(/data-qr-x="([\d.]+)"/u)?.[1]);
    const textRows = [
      ...markup.matchAll(/<text x="([\d.]+)"[^>]*>(.*?)<\/text>/gu),
    ].filter((match) => !match[2].includes("INSTITUTE OF INTERACTIVE OBJECTS"));

    expect(markup).toContain('aria-label="Makey Makey Kit #003"');
    expect(markup).toContain(">Makey Makey Kit</tspan>");
    expect(markup).toContain(">#003</tspan>");
    expect(markup).toContain(">KIT</tspan>");
    expect(markup).toContain(">IOIO Lab - B477 - D4-1</tspan>");
    expect(markup).not.toContain("…");
    expect(qrX).toBeGreaterThan(50);
    expect(textRows.length).toBe(4);
    expect(Number(textRows[2][1])).toBeLessThan(qrX);
    expect(Number(textRows[3][1])).toBe(Number(textRows[2][1]));
    const nameBaseline = Number(textRows[2][2].match(/y="([\d.]+)"/u)?.[1]);
    const unitBaseline = Number(textRows[3][2].match(/y="([\d.]+)"/u)?.[1]);
    expect(unitBaseline).toBeGreaterThan(nameBaseline);
  });

  it("omits the SCAN ME caption while preserving QR identity and dimensions", () => {
    const label = { ...labelBase, variant: "item" as const, title: "Motor" };
    const normal = renderIoioLabelSvgMarkup(label, {
      widthMm: 55,
      heightMm: 30,
    });
    const customized = renderIoioLabelSvgMarkup(
      { ...label, customText: "Arduino Station" },
      { widthMm: 55, heightMm: 30 }
    );
    const qrMatrixId = (markup: string) =>
      markup.match(/data-qr-matrix="([^"]+)"/u)?.[1];

    expect(normal).not.toContain("SCAN ME");
    expect(customized).not.toContain("SCAN ME");
    expect(qrMatrixId(customized)).toBe(qrMatrixId(normal));

    const kit = renderIoioLabelSvgMarkup(
      {
        ...label,
        variant: "kit",
        title: "Makey Makey Kit",
        unitNumber: "#003",
      },
      { widthMm: 105, heightMm: 64 }
    );
    expect(kit).not.toContain("SCAN ME");
  });

  it("keeps custom label text at its original small caption size", () => {
    const markup = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "item",
        title: "Makey Kit #003",
        customText: "Workshop Kit",
      },
      { widthMm: 55, heightMm: 30 }
    );
    const customTextElement = [
      ...markup.matchAll(
        /<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*>(.*?)<\/text>/gu
      ),
    ].find(([, , , , content]) => content.includes("Workshop Kit"));
    const unitTextElement = [
      ...markup.matchAll(
        /<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="([\d.]+)"[^>]*>(.*?)<\/text>/gu
      ),
    ].find(([, , , , content]) => content.includes("#003"));
    expect(customTextElement).toBeDefined();
    expect(Number(customTextElement?.[3])).toBe(1.8);
    expect(Number(customTextElement?.[2])).toBeGreaterThan(
      Number(unitTextElement?.[2])
    );
  });

  it("fits long Kit names in at most two lines before the unit number", () => {
    const markup = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "kit",
        title: "Advanced Arduino Robotics Starter Kit",
        unitNumber: "#001",
      },
      { widthMm: 105, heightMm: 64 }
    );
    const textRows = [
      ...markup.matchAll(/<text x="([\d.]+)"[^>]*>(.*?)<\/text>/gu),
    ];
    const nameText = textRows.find(([, , content]) =>
      content.includes("Advanced")
    )?.[2];
    const unitText = textRows.find(([, , content]) =>
      content.includes("#001")
    )?.[2];

    expect(nameText).toBeDefined();
    expect([...nameText!.matchAll(/<tspan /gu)]).toHaveLength(2);
    expect(nameText).toContain("Robotics");
    expect(nameText).toContain("Starter Kit");
    expect(unitText).toContain("#001");
    expect(Number(unitText!.match(/y="([\d.]+)"/u)?.[1])).toBeGreaterThan(
      Number(nameText!.match(/y="([\d.]+)"/u)?.[1])
    );
  });

  it("keeps Container identifiers next to a separate QR and omits category text", () => {
    const markup = renderIoioLabelSvgMarkup(
      { ...labelBase, variant: "box", code: "A1-13", title: "CONTAINER" },
      { widthMm: 90, heightMm: 55 }
    );

    expect(markup).toContain(">A1-13</tspan>");
    expect(markup).toContain(">CONTAINER</tspan>");
    expect(markup).toContain('data-ioio-qr="true"');
    expect(markup).not.toContain("Boards &amp; Embedded");
  });

  it("omits the custom caption completely when the field is empty", () => {
    const normal = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "kit",
        title: "Workshop Kit",
        unitNumber: "#001",
      },
      { widthMm: 105, heightMm: 64 }
    );
    const empty = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "kit",
        title: "Workshop Kit",
        unitNumber: "#001",
        customText: "   ",
      },
      { widthMm: 105, heightMm: 64 }
    );

    expect(empty).toBe(normal);
  });

  it("renders subtle custom text without changing the canonical identity or QR", () => {
    const label = {
      ...labelBase,
      variant: "kit" as const,
      title: "Makey Makey Kit",
      unitNumber: "#003",
    };
    const normal = renderIoioLabelSvgMarkup(label, {
      widthMm: 105,
      heightMm: 64,
    });
    const customized = renderIoioLabelSvgMarkup(
      { ...label, customText: "Workshop Kit" },
      { widthMm: 105, heightMm: 64 }
    );
    const qrMatrixId = (markup: string) =>
      markup.match(/data-qr-matrix="([^"]+)"/u)?.[1];

    expect(customized).toContain('aria-label="Makey Makey Kit #003"');
    expect(customized).toContain(">Workshop Kit</tspan>");
    expect(qrMatrixId(customized)).toBe(qrMatrixId(normal));
    expect(customized).toContain(">Makey Makey Kit</tspan>");
    expect(customized).toContain(">#003</tspan>");
  });

  it("normalizes and bounds custom text while preserving Swedish and special characters", () => {
    const normalized = normalizeIoioCustomLabelText(
      "  Ångström & <Demo> \n Workshop Kit  "
    );
    const tooLong = normalizeIoioCustomLabelText("A".repeat(80));

    expect(normalized).toBe("Ångström & <Demo> Workshop Kit");
    expect([...tooLong]).toHaveLength(IOIO_LABEL_CUSTOM_TEXT_MAX_LENGTH);
    expect(tooLong).toBe("A".repeat(IOIO_LABEL_CUSTOM_TEXT_MAX_LENGTH));
    const markup = renderIoioLabelSvgMarkup(
      { ...labelBase, customText: normalized },
      { widthMm: 70, heightMm: 40 }
    );
    expect(markup).toContain("Ångström &amp; &lt;Demo&gt; Workshop Kit");
  });

  it("truncates long custom captions within the available label text area", () => {
    const markup = renderIoioLabelSvgMarkup(
      {
        ...labelBase,
        variant: "item",
        title: "Arduino Station",
        customText: "Electronics workshop equipment identifier",
      },
      { widthMm: 55, heightMm: 30 }
    );

    expect(markup).toContain('aria-label="Arduino Station"');
    expect(markup).toContain("…</tspan>");
    expect(markup).not.toContain(
      "Electronics workshop equipment identifier</tspan>"
    );
    expect(markup).toContain('data-ioio-qr="true"');
  });
});
