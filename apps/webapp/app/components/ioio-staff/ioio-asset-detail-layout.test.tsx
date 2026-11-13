import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { AssetDetailImage } from "~/components/assets/asset-image";
import { ASSET_IMAGE_PLACEHOLDER } from "~/modules/asset/image-resolution";
import { importedDescription } from "~/modules/ioio-staff/import-description";
import { IoioAssetDetailLayout } from "./ioio-asset-detail-layout";

const trackingHelp =
  "Each physical unit has its own QR code so IOIO can track which exact unit is borrowed and returned.";

function renderDetail({
  availableToBook = true,
  availableQuantity = 4,
  availabilityDetail,
  status,
  imageUrl = "/makey-kit.jpg",
  title = "Makey Kit",
  description = "A classroom electronics kit.",
}: {
  availableToBook?: boolean;
  availableQuantity?: number;
  availabilityDetail?: string;
  status?: string;
  imageUrl?: string | null;
  title?: string;
  description?: string | null;
} = {}) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <IoioAssetDetailLayout
            backTo="/ioio"
            backLabel="Back to Inventory"
            title={title}
            status={status}
            description={description}
            image={
              <AssetDetailImage
                asset={{
                  id: "makey-kit",
                  mainImage: imageUrl,
                  thumbnailImage: null,
                  assetModel: null,
                }}
                alt="Makey Kit"
              />
            }
            actions={<button type="button">Add to borrow list</button>}
            categoryName="Inventory"
            locations={[
              {
                path: [
                  "IOIO Lab - B477",
                  "Section A",
                  "Shelf A1",
                  "Container A1-13",
                ],
                href: "/ioio/browse?location=section-a-id",
              },
            ]}
            availableToBook={availableToBook}
            availableQuantity={availableQuantity}
            totalQuantity={5}
            unitLabel="kits"
            availabilityDetail={availabilityDetail}
            tracking="Individual QR tracking"
            maxBorrowDays={45}
          />
        ),
      },
    ],
    { initialEntries: ["/"] }
  );
  const rendered = render(<RouterProvider router={router} />);
  return rendered;
}

describe("IoioAssetDetailLayout", () => {
  afterEach(() => cleanup());

  it("shows clean imported product text on the student detail surface", () => {
    const description = importedDescription({
      title: "TinkerKit joystick module",
      assetModelDescription:
        "TinkerKit joystick module for directional input in Arduino and electronics projects.",
      sourceDescription: "Source lab: IOIO Lab. Source room: B477.",
    });
    const { container } = renderDetail({
      title: "TinkerKit joystick module",
      description,
    });
    expect(screen.getByText(description)).toBeVisible();
    expect(container.textContent).not.toMatch(
      /Imported from|Source lab:|Source room:|Source storage location:/
    );
  });

  it.each(["Grove Kit", "Camera"])(
    "stacks the %s image and details before its full-width description",
    (title) => {
      const description =
        "This kit includes an Arduino Nano 33 BLE Rev2.\n\nThe kit consists of the following components:\n1x Arduino Nano 33 BLE Sense Rev2\n1x USB-A to Micro-USB cable";
      renderDetail({ title, description });

      const titleHeading = screen.getByRole("heading", { name: title });
      const action = screen.getByRole("button", {
        name: "Add to borrow list",
      });
      const image = screen.getByRole("region", { name: `${title} image` });
      const details = screen.getByRole("heading", { name: "Details" });
      const descriptionHeading = screen.getByRole("heading", {
        name: "Description",
      });
      const descriptionText = screen.getByText(
        (_, element) =>
          element?.tagName === "P" && element.textContent === description
      );

      expect(
        titleHeading.compareDocumentPosition(action) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        action.compareDocumentPosition(image) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        image.compareDocumentPosition(descriptionHeading) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        details.compareDocumentPosition(descriptionHeading) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        descriptionHeading.compareDocumentPosition(descriptionText) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      expect(
        screen.getAllByRole("region", { name: `${title} image` })
      ).toHaveLength(1);
      expect(
        screen.getAllByRole("heading", { name: "Description" })
      ).toHaveLength(1);
      expect(
        screen.getAllByText(
          (_, element) =>
            element?.tagName === "P" && element.textContent === description
        )
      ).toHaveLength(1);
      expect(descriptionText.textContent).toBe(description);
      expect(descriptionText.className).toContain("whitespace-pre-wrap");
      expect(descriptionText.className).toContain("break-words");
      expect(descriptionHeading.closest("section")?.className).toContain(
        "w-full"
      );
      expect(action).toBeTruthy();
      expect(screen.getByText("4 / 5 kits available")).toBeTruthy();
      expect(screen.getByText("Inventory")).toBeTruthy();
    }
  );

  it("stretches the top cards equally and spans Description across both grid columns", () => {
    renderDetail({ status: "Available" });
    const title = screen.getByRole("heading", { name: "Makey Kit" });
    const header = title.closest("header")!;
    expect(header.textContent).not.toMatch(/Availability:|available/i);
    expect(screen.queryByLabelText("Availability")).not.toBeInTheDocument();
    expect(screen.getAllByText("4 / 5 kits available")).toHaveLength(1);
    const image = screen.getByRole("region", { name: "Makey Kit image" });
    const description = screen
      .getByRole("heading", { name: "Description" })
      .closest("section")!;
    const grid = image.parentElement!;
    expect(description.parentElement).toBe(grid);
    expect(description).toHaveClass("lg:col-span-2");
    expect(image.className).not.toMatch(/self-start|h-\[/);
    expect(grid).toHaveClass(
      "grid",
      "items-stretch",
      "gap-4",
      "lg:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.9fr)]"
    );
    for (const card of [image, description]) {
      expect(card).toHaveClass(
        "w-full",
        "min-w-0",
        "rounded-2xl",
        "border",
        "border-gray-200",
        "bg-white",
        "p-3",
        "sm:p-4",
        "shadow-sm"
      );
      expect(card.className).not.toMatch(/max-w-|mt-/);
    }
    const body = screen.getByText("A classroom electronics kit.");
    expect(body).toHaveClass(
      "w-full",
      "min-w-0",
      "max-w-[110ch]",
      "break-words",
      "[overflow-wrap:anywhere]"
    );
    const sidebar = screen
      .getByRole("heading", { name: "Details" })
      .closest("section")!;
    expect(sidebar.parentElement).toBe(grid);
    expect(Array.from(grid.children)).toEqual([image, sidebar, description]);
    expect(sidebar.className).not.toMatch(/self-start|h-\[/);
  });

  it("keeps the placeholder before a long description when no product image exists", () => {
    const description = "Long product information. ".repeat(200);
    renderDetail({ imageUrl: null, description });
    const placeholder = screen.getByAltText("Makey Kit");
    const heading = screen.getByRole("heading", { name: "Description" });
    expect(placeholder).toHaveAttribute("src", ASSET_IMAGE_PLACEHOLDER);
    expect(
      placeholder.compareDocumentPosition(heading) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(1);
  });

  it("does not render a description section for an empty description", () => {
    renderDetail({ description: " \n " });

    expect(screen.queryByRole("heading", { name: "Description" })).toBeNull();
  });

  it("shows concise student availability and the requested details grid", () => {
    const { container } = renderDetail();

    const backLink = screen.getByRole("link", { name: "Back to Inventory" });
    expect(backLink.getAttribute("href")).toBe("/ioio");
    expect(screen.getByText("4 / 5 kits available")).toBeTruthy();
    expect(screen.queryByText("4 available · 1 unavailable")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Add to borrow list" })
    ).toBeTruthy();
    expect(screen.queryByText("Ask IOIO about this item")).toBeNull();
    expect(
      screen.getByRole("link", { name: /IOIO Lab - B477/ }).getAttribute("href")
    ).toBe("/ioio/browse?location=section-a-id");
    expect(
      screen.getByRole("link", { name: /IOIO Lab - B477/ }).textContent
    ).toBe("IOIO Lab - B477 · Container A1-13");
    expect(screen.queryByText(/Section A|Shelf A1/u)).toBeNull();
    expect(screen.getByText("Inventory")).toBeTruthy();
    expect(screen.getByText("45 days")).toBeTruthy();

    const definitionLists = container.querySelectorAll("section dl");
    expect(
      Array.from(definitionLists[0]?.children ?? []).map(
        (entry) => entry.querySelector("dt")?.textContent
      )
    ).toEqual(["Location", "Category", "Maximum borrowing period", "Tracking"]);

    const imagePanel = screen.getByRole("region", { name: "Makey Kit image" });
    expect(imagePanel.className).not.toMatch(/h-\[|min-h-/u);
    expect(imagePanel.className).not.toContain("overflow-hidden");
    const image = screen.getByAltText("Makey Kit");
    expect(image.className).toContain("object-contain");
    expect(image.className).toContain("w-full");
    expect(image.className).toContain("max-h-[min(68dvh,calc(100dvh-20rem))]");
    expect(image.className).not.toContain("object-cover");
    expect(image.className).not.toContain("size-full");
    expect(image.getAttribute("width")).toBeNull();
    expect(image.getAttribute("height")).toBeNull();
    expect(imagePanel.parentElement?.className).toContain(
      "lg:grid-cols-[minmax(0,1.45fr)_minmax(340px,0.9fr)]"
    );
    expect(imagePanel.parentElement?.className).toContain("items-stretch");
    const availability = screen.getByText("4 / 5 kits available").parentElement;
    expect(availability?.className).toContain("bg-green-50");
  });

  it.each([
    ["landscape", "/wide-product.jpg"],
    ["portrait", "/tall-product.jpg"],
    ["square", "/square-product.jpg"],
    ["small-resolution", "/small-product.jpg"],
    ["placeholder", null],
  ])("contains %s images without forcing their dimensions", (_, imageUrl) => {
    renderDetail({ imageUrl });
    const image = screen.getByAltText("Makey Kit");

    expect(image.getAttribute("src")).toBe(imageUrl ?? ASSET_IMAGE_PLACEHOLDER);
    expect(image.className).toContain("object-contain");
    expect(image.className).toContain("w-full");
    expect(image.getAttribute("width")).toBeNull();
    expect(image.getAttribute("height")).toBeNull();
  });

  it("limits enlargement of small source images to 1.5 times their native width", () => {
    renderDetail({ imageUrl: "/small-product.jpg" });
    const image = screen.getByAltText("Makey Kit");
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 240,
    });

    fireEvent.load(image);

    expect(image.style.maxWidth).toBe("360px");
  });

  it("uses red only when no units are available", () => {
    renderDetail({ availableQuantity: 0 });
    expect(
      screen.getByText("0 / 5 kits available").parentElement?.className
    ).toContain("bg-red-50");

    cleanup();
    renderDetail({ availableQuantity: 1 });
    expect(
      screen.getByText("1 / 5 kits available").parentElement?.className
    ).toContain("bg-green-50");
  });

  it("shows a staff availability breakdown and opens QR tracking help", async () => {
    renderDetail({ availabilityDetail: "4 available · 1 in use" });
    expect(screen.getByText("4 available · 1 in use")).toBeTruthy();

    const trackingLabel = screen.getByText("Tracking");
    const helpTrigger = trackingLabel.parentElement?.querySelector("i");
    expect(helpTrigger).toBeTruthy();
    await act(async () => {
      fireEvent.pointerMove(helpTrigger!);
      fireEvent.mouseOver(helpTrigger!);
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(screen.getByRole("tooltip").textContent).toContain(trackingHelp);
  });
});

describe("shared staff/student borrowing restriction", () => {
  afterEach(cleanup);
  it.each([true, false, true])(
    "respects borrowability %s without changing stock",
    (availableToBook) => {
      const asset = Object.freeze({ availableToBook, quantity: 3 });
      renderDetail({
        availableToBook: asset.availableToBook,
        availableQuantity: asset.quantity,
        availabilityDetail: "3 available",
      });
      if (availableToBook) {
        expect(screen.getByText("3 / 5 kits available")).toBeTruthy();
      } else {
        expect(screen.getByText("Not available to borrow")).toBeTruthy();
        expect(screen.getByText("Lab use only")).toBeTruthy();
        expect(screen.queryByText(/3.*available/)).toBeNull();
      }
      expect(asset.quantity).toBe(3);
    }
  );
});
