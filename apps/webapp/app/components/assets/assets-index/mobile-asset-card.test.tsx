import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";

// why: asset images rely on image-preview providers unrelated to card layout.
vi.mock("../asset-image", () => ({
  AssetImage: ({ alt, className }: { alt: string; className: string }) => (
    <img alt={alt} className={className} />
  ),
}));

// why: the status badge's availability tooltip is not part of the card layout.
vi.mock("../asset-status-badge", () => ({
  AssetStatusBadge: ({ status }: { status: string }) => (
    <span data-testid="asset-status">{status}</span>
  ),
}));

// why: location hierarchy loading is unrelated to how the location field wraps.
vi.mock("../../location/location-badge", () => ({
  LocationBadge: ({
    location,
    className,
  }: {
    location: { name: string };
    className?: string;
  }) => <span className={className}>{location.name}</span>,
}));

// why: permission resolution is tested in AssetQuickActions; this test checks
// the compact action placement in the card.
vi.mock("~/hooks/user-user-role-helper", () => ({
  useUserRoleHelper: () => ({ roles: ["ADMIN"] }),
}));

// why: the route context determines whether a list belongs to one user, which
// is not needed for the staff card presentation in this test.
vi.mock("~/hooks/use-is-user-assets-page", () => ({
  useIsUserAssetsPage: () => false,
}));

// why: this card fixture has no organization-specific code display setting.
vi.mock("~/hooks/use-current-organization", () => ({
  useCurrentOrganization: () => undefined,
}));

// why: this layout test verifies the single overflow affordance, not menu policy.
vi.mock("./asset-quick-actions", () => ({
  default: ({ compact }: { compact?: boolean }) =>
    compact ? <button type="button" aria-label="Asset actions" /> : null,
}));

import { MobileAssetCard } from "./mobile-asset-card";

describe("MobileAssetCard", () => {
  it("groups availability with the name and keeps metadata in labeled fields", () => {
    const item = {
      id: "asset-1",
      title: "A long measurement device name that should wrap on a phone",
      type: "QUANTITY_TRACKED",
      status: "AVAILABLE",
      availableToBook: true,
      quantity: 100,
      unitOfMeasure: "pieces",
      mainImage: null,
      thumbnailImage: null,
      mainImageExpiration: null,
      assetModel: null,
      category: {
        id: "category-1",
        name: "Very long category name for specialist equipment",
        color: "#f5c1c1",
      },
      assetLocations: [
        {
          location: {
            id: "location-1",
            name: "North building · second floor · long storage room",
            parentId: null,
            _count: { children: 0 },
          },
        },
      ],
      qrCodes: [{ id: "qr-1" }],
      qrId: "qr-1",
      sequentialId: null,
    };

    render(
      <MemoryRouter>
        <MobileAssetCard item={item} />
      </MemoryRouter>
    );

    const card = screen.getByRole("article");
    expect(card).toHaveClass("w-full", "min-w-0");
    expect(screen.getByRole("link", { name: item.title })).toHaveClass(
      "break-words"
    );
    expect(screen.getByTestId("asset-status")).toBeInTheDocument();
    expect(screen.getByText("100 total pieces")).toBeInTheDocument();
    expect(screen.getByText("Category")).toBeInTheDocument();
    expect(screen.getByText(item.category.name)).toBeInTheDocument();
    expect(screen.getByText("Location")).toBeInTheDocument();
    expect(
      screen.getByText(item.assetLocations[0].location.name)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Asset actions" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Edit asset information" })
    ).toBeNull();
  });
});
