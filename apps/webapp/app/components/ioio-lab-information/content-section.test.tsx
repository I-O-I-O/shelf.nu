import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LabInfoContentSection } from "./content-section";

describe("LabInfoContentSection", () => {
  it("shows the supplied text and a compact optional-image placeholder for Staff", () => {
    render(
      <LabInfoContentSection
        title="How borrowing works"
        text={"Staff-authored paragraph one.\n\nStaff-authored paragraph two."}
        showEmptyImagePlaceholder
      />
    );

    expect(screen.getByText(/Staff-authored paragraph one/).textContent).toBe(
      "Staff-authored paragraph one.\n\nStaff-authored paragraph two."
    );
    expect(
      screen.getByText("No image added. Images are optional.")
    ).toBeTruthy();
    expect(
      screen.queryByText(/Take it now|Prepared for you|Return it/)
    ).toBeNull();
    expect(screen.queryByText(/System placeholder/)).toBeNull();
  });

  it("renders supporting images and captions in the shared section component", () => {
    render(
      <LabInfoContentSection
        title="About"
        text="Staff-authored copy"
        images={[
          {
            id: "image-1",
            url: "/lab-entrance.jpg",
            position: 0,
            caption: "Lab entrance",
            altText: "Entrance to IOIO Lab",
          },
        ]}
      />
    );

    const image = screen.getByRole("img", { name: "Entrance to IOIO Lab" });
    expect(image).toBeTruthy();
    expect(image.className).toContain("object-contain");
    expect(image.className).not.toContain("object-cover");
    expect(image.className).not.toContain("aspect-");
    expect(screen.getByText("Lab entrance")).toBeTruthy();
    expect(screen.getByText("Staff-authored copy")).toBeTruthy();
  });

  it("opens a full-content image viewer from both triggers and closes accessibly", () => {
    render(
      <LabInfoContentSection
        title="About"
        text="Staff-authored copy"
        images={[
          {
            id: "image-1",
            url: "/lab-entrance.jpg",
            position: 0,
            caption: "Lab entrance",
            altText: "Entrance to IOIO Lab",
          },
        ]}
      />
    );

    const [imageButton, magnifierButton] = screen.getAllByRole("button", {
      name: "View larger",
    });
    imageButton!.focus();
    fireEvent.click(screen.getByRole("img", { name: "Entrance to IOIO Lab" }));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeTruthy();
    expect(screen.getAllByText("Lab entrance")).toHaveLength(2);
    expect(screen.queryByText("Entrance to IOIO Lab")).toBeNull();
    const dialogImage = dialog.querySelector("img");
    expect(dialogImage?.className).toContain("object-contain");
    expect(dialogImage?.className).not.toContain("object-cover");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(imageButton);

    fireEvent.click(magnifierButton!);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /^Close$/ }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("renders sections without images as text only by default", () => {
    render(<LabInfoContentSection title="Rules" text="Staff-written rules." />);

    expect(screen.getByText("Staff-written rules.")).toBeTruthy();
    expect(
      screen.queryByText("No image added. Images are optional.")
    ).toBeNull();
  });

  it("places a two-image gallery below the full-width text", () => {
    const { container } = render(
      <LabInfoContentSection
        title="About"
        text="Staff-authored copy"
        images={[
          {
            id: "image-1",
            url: "/one.jpg",
            position: 0,
            caption: null,
            altText: "First image",
          },
          {
            id: "image-2",
            url: "/two.jpg",
            position: 1,
            caption: null,
            altText: "Second image",
          },
        ]}
      />
    );

    const text = screen.getByText("Staff-authored copy");
    const figures = container.querySelectorAll("figure");
    expect(figures).toHaveLength(2);
    for (const image of container.querySelectorAll("img")) {
      expect(image.className).toContain("object-contain");
      expect(image.className).not.toContain("object-cover");
    }
    expect(
      text.compareDocumentPosition(figures[0]!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it("keeps larger image sets in the gallery below the text", () => {
    const { container } = render(
      <LabInfoContentSection
        title="About"
        text="Staff-authored copy"
        images={Array.from({ length: 3 }, (_, index) => ({
          id: `image-${index}`,
          url: `/image-${index}.jpg`,
          position: index,
          caption: null,
          altText: `Image ${index}`,
        }))}
      />
    );

    const text = screen.getByText("Staff-authored copy");
    const figures = container.querySelectorAll("figure");
    expect(figures).toHaveLength(3);
    expect(
      text.compareDocumentPosition(figures[0]!) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
