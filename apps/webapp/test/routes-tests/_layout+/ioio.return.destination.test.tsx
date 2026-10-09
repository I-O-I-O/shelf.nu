import { fireEvent, render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { expect, it, vi } from "vitest";
import IoioReturn from "~/routes/_layout+/ioio.return";

// why: the student shell animation depends on canvas APIs unavailable in happy-dom.
vi.mock("lottie-react", () => ({ default: () => null }));
// why: image rendering is unrelated to the return destination and needs
// storage-backed asset data that this focused student-instruction test omits.
vi.mock("~/components/assets/asset-image", () => ({
  AssetImage: () => <div aria-hidden="true" />,
}));

const item = {
  bookingId: "booking-1",
  bookingAssetId: "booking-asset-1",
  assetId: "asset-1",
  title: "Makey Kit #002",
  type: "INDIVIDUAL",
  returnHandling: "RETURN_TO_RETURN_ZONE",
  isKit: false,
  kitName: null,
  unitLabel: "002",
  quantity: 1,
  image: {
    mainImage: null,
    thumbnailImage: null,
    assetModel: null,
    kitImage: null,
  },
  locationPath: ["IOIO Lab - B477", "Shelf A1", "Container X"],
  locationImage: null,
  returnZone: {
    title: "Returns Area",
    path: ["IOIO Lab - B477", "Returns Area"],
    image: null,
    description: null,
  },
  problemZone: null,
};

function renderReturnRoute(returnHandling = "RETURN_TO_RETURN_ZONE") {
  const Stub = createRoutesStub([
    {
      path: "/ioio/return",
      Component: IoioReturn,
      loader: () => ({ item: { ...item, returnHandling } }),
      action: () => ({
        ok: true,
        intent: "return-prepared",
        proposal: { confirmationToken: "token", quantity: 1 },
      }),
    },
  ]);

  return render(<Stub initialEntries={["/ioio/return"]} />);
}

it("shows the configured Return section instead of the unit's storage container", async () => {
  renderReturnRoute();

  fireEvent.click(
    await screen.findByRole("button", { name: "Everything is OK" })
  );
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

  expect(
    await screen.findByRole("heading", {
      name: "Take this item to the Return section",
    })
  ).toBeTruthy();
  expect(screen.getByText("Returns Area")).toBeTruthy();
  expect(screen.getByText("IOIO Lab - B477 / Returns Area")).toBeTruthy();
  expect(screen.queryByText(/Container X/)).toBeNull();
});

it("falls back to the normal inventory location when no Return section is configured", async () => {
  renderReturnRoute("RETURN_TO_STORAGE");

  fireEvent.click(
    await screen.findByRole("button", { name: "Everything is OK" })
  );
  fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

  expect(
    await screen.findByRole("heading", {
      name: "Return this item to its Inventory location",
    })
  ).toBeTruthy();
  expect(screen.getByText("Container X")).toBeTruthy();
  expect(
    screen.getByText("IOIO Lab - B477 / Shelf A1 / Container X")
  ).toBeTruthy();
});
