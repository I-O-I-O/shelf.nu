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
import { IoioAssetDetailLayout } from "./ioio-asset-detail-layout";

const trackingHelp =
  "Each physical unit has its own QR code so IOIO can track which exact unit is borrowed and returned.";

function renderDetail({
  availableQuantity = 4,
  availabilityDetail,
  imageUrl = "/makey-kit.jpg",
}: {
  availableQuantity?: number;
  availabilityDetail?: string;
  imageUrl?: string | null;
} = {}) {
  const router = createMemoryRouter(
    [
      {
        path: "/",
        element: (
          <IoioAssetDetailLayout
            backTo="/ioio"
            backLabel="Back to Inventory"
            title="Makey Kit"
            description="A classroom electronics kit."
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

  it("shows concise student availability and the requested details grid", () => {
    const { container } = renderDetail();

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
    expect(imagePanel.parentElement?.className).toContain("items-start");
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
