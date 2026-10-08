import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { IoioLocation } from "~/components/location/ioio-location-hierarchy";
import { IoioLocationHierarchy } from "~/components/location/ioio-location-hierarchy";

// why: the hierarchy test focuses on navigation and counts; image preview behavior is tested elsewhere.
vi.mock("~/components/image-with-preview/image-with-preview", () => ({
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));
// why: action menu permissions and dialogs are outside the location hierarchy presentation contract.
vi.mock("~/components/location/location-quick-actions", () => ({
  default: () => <button type="button">Location actions</button>,
}));
// why: the hierarchy selection contract is independent of cookie-backed list filters and the app organization context.
vi.mock("~/hooks/search-params", () => ({
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

function locationTree(): IoioLocation[] {
  const room = {
    id: "room-1",
    name: "IOIO Lab - B477",
    parentId: null,
    parent: null,
    imageUrl: null,
    thumbnailUrl: null,
    color: "#455A64",
    _count: { children: 1, assetLocations: 0, kits: 0 },
  } as unknown as IoioLocation;
  const section = {
    id: "section-1",
    name: "Section A",
    parentId: room.id,
    parent: {
      id: room.id,
      name: room.name,
      parentId: null,
      _count: { children: 1 },
    },
    imageUrl: null,
    thumbnailUrl: null,
    color: "#1565C0",
    _count: { children: 1, assetLocations: 2, kits: 1 },
  } as unknown as IoioLocation;

  return [room, section];
}

describe("IOIO Locations hierarchy UI", () => {
  it("shows Rooms, child levels, inventory counts, and filtered inventory links", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <IoioLocationHierarchy locations={locationTree()} />
      </MemoryRouter>
    );

    expect(screen.getByRole("heading", { name: "Rooms" })).toBeInTheDocument();
    expect(screen.getByText("1", { selector: "span" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "IOIO Lab - B477" }));

    expect(
      screen.getByRole("navigation", { name: "Location hierarchy" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Sections" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Section A" })
    ).toBeInTheDocument();
    expect(screen.getByText("2 assets")).toBeInTheDocument();
    expect(screen.getByText("1 kits")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "View inventory" })
    ).toHaveAttribute("href", "/assets?location=room-1");
  });

  it("renders a useful empty Rooms state", () => {
    render(
      <MemoryRouter>
        <IoioLocationHierarchy locations={[]} />
      </MemoryRouter>
    );

    expect(screen.getByText("No rooms found.")).toBeInTheDocument();
  });
});
