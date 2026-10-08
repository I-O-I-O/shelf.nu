import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { AssetUsageDistributionContent } from "./asset-usage-distribution-content";

// why: these app hooks normally read route-provided organization and client-hint context.
vi.mock("~/hooks/use-current-organization", () => ({
  useCurrentOrganization: () => ({ currency: "DKK" }),
}));
vi.mock("~/utils/client-hints", () => ({
  useHints: () => ({ locale: "en-GB" }),
}));

describe("Asset Usage & Distribution report content", () => {
  it("renders useful empty states when the organization has no report data", () => {
    render(
      <MemoryRouter>
        <AssetUsageDistributionContent
          usageRows={[]}
          usageKpis={[]}
          usageTotalRows={0}
          distributionKpis={[]}
          distributionBreakdown={{
            byCategory: [],
            byLocation: [],
            byStatus: [],
          }}
        />
      </MemoryRouter>
    );

    expect(screen.getByText("No usage data")).toBeTruthy();
    expect(screen.getByText("No categories defined")).toBeTruthy();
    expect(screen.getByText("No locations defined")).toBeTruthy();
    expect(screen.getByText("No status data")).toBeTruthy();
  });
});
