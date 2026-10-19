import { describe, expect, it } from "vitest";
import {
  addIoioLabelToQueue,
  clearIoioLabelQueue,
  packIoioLabelsForA4,
  removeIoioLabelFromQueue,
  toggleIoioLabelInQueue,
  type IoioSizedLabel,
} from "./ioio-label-queue";
import { IOIO_A4, IOIO_A4_PRINTABLE_AREA } from "./ioio-label-sizing";

describe("IOIO label print queue", () => {
  it("accumulates selections across label types without duplicates", () => {
    let queue = addIoioLabelToQueue([], { type: "section", id: "section-a" });
    queue = addIoioLabelToQueue(queue, { type: "shelf", id: "shelf-a1" });
    queue = addIoioLabelToQueue(queue, { type: "shelf", id: "shelf-a2" });
    queue = addIoioLabelToQueue(queue, { type: "shelf", id: "shelf-a3" });
    queue = addIoioLabelToQueue(queue, { type: "shelf", id: "shelf-a1" });
    queue = addIoioLabelToQueue(queue, { type: "container", id: "shelf-a1" });

    expect(queue).toEqual([
      { type: "section", id: "section-a" },
      { type: "shelf", id: "shelf-a1" },
      { type: "shelf", id: "shelf-a2" },
      { type: "shelf", id: "shelf-a3" },
    ]);
  });

  it("removes only the requested selection and supports clearing all", () => {
    const queue = [
      { type: "section" as const, id: "section-a" },
      { type: "shelf" as const, id: "shelf-a1" },
      { type: "shelf" as const, id: "shelf-a2" },
    ];

    expect(
      removeIoioLabelFromQueue(queue, { type: "shelf", id: "shelf-a1" })
    ).toEqual([queue[0], queue[2]]);
    expect(toggleIoioLabelInQueue(queue, queue[0])).toEqual(queue.slice(1));
    expect(clearIoioLabelQueue(queue)).toEqual([]);
  });
});

describe("IOIO mixed label page packing", () => {
  const shelf = (id: string): IoioSizedLabel<string> => ({
    value: id,
    dimensions: { widthMm: 90, heightMm: 120 },
  });

  it("packs four shelf labels on one safe-margin page", () => {
    const pages = packIoioLabelsForA4(["A1", "A2", "A3", "A4"].map(shelf));

    expect(pages).toHaveLength(1);
    expect(
      pages[0].rows.map((row) => row.labels.map(({ value }) => value))
    ).toEqual([
      ["A1", "A2"],
      ["A3", "A4"],
    ]);
  });

  it("starts a second page only when another populated row does not fit", () => {
    const pages = packIoioLabelsForA4(
      Array.from({ length: 6 }, (_, index) => shelf(`A${index + 1}`))
    );

    expect(pages).toHaveLength(2);
    expect(
      pages.flatMap((page) => page.rows.flatMap((row) => row.labels))
    ).toHaveLength(6);
    expect(pages.every((page) => page.rows.length > 0)).toBe(true);
  });

  it("packs mixed sizes in a single page when their real dimensions fit", () => {
    const pages = packIoioLabelsForA4([
      { value: "small item", dimensions: { widthMm: 70, heightMm: 40 } },
      { value: "box", dimensions: { widthMm: 90, heightMm: 55 } },
      { value: "shelf", dimensions: { widthMm: 90, heightMm: 120 } },
    ]);

    expect(pages).toHaveLength(1);
    expect(
      pages[0].rows.flatMap((row) => row.labels.map(({ value }) => value))
    ).toEqual(["small item", "box", "shelf"]);
  });

  it("keeps a large section and shelves in one queue and uses their true sizes", () => {
    const pages = packIoioLabelsForA4([
      { value: "Section A", dimensions: { widthMm: 150, heightMm: 210 } },
      ...["A1", "A2", "A3", "A4"].map(shelf),
    ]);

    expect(pages).toHaveLength(2);
    expect(
      pages[0].rows.flatMap((row) => row.labels.map(({ value }) => value))
    ).toEqual(["Section A"]);
    expect(
      pages[1].rows.flatMap((row) => row.labels.map(({ value }) => value))
    ).toEqual(["A1", "A2", "A3", "A4"]);
    expect(pages.every((page) => page.rows.length > 0)).toBe(true);
  });

  it("keeps every packed row inside the 10 mm print-safe page area", () => {
    const pages = packIoioLabelsForA4([
      { value: "section", dimensions: { widthMm: 150, heightMm: 210 } },
      shelf("A1"),
      shelf("A2"),
      shelf("A3"),
    ]);
    const printableWidth = IOIO_A4_PRINTABLE_AREA.widthMm;
    const printableHeight = IOIO_A4_PRINTABLE_AREA.heightMm;

    for (const page of pages) {
      const packedHeight = page.rows.reduce(
        (height, row, index) =>
          height + row.heightMm + (index > 0 ? IOIO_A4.gapMm : 0),
        0
      );
      expect(packedHeight).toBeLessThanOrEqual(printableHeight);

      for (const row of page.rows) {
        const packedWidth = row.labels.reduce(
          (width, label, index) =>
            width + label.dimensions.widthMm + (index > 0 ? IOIO_A4.gapMm : 0),
          0
        );
        expect(packedWidth).toBeLessThanOrEqual(printableWidth);
      }
    }
  });

  it("does not emit a page for an empty queue or append a trailing blank page", () => {
    expect(packIoioLabelsForA4([])).toEqual([]);
    expect(packIoioLabelsForA4([shelf("A1")])).toHaveLength(1);
    expect(packIoioLabelsForA4([shelf("A1")])[0].rows).toHaveLength(1);
  });
});
