import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import { AssetUsageDistributionContent } from "./asset-usage-distribution-content";

describe("Asset Usage & Distribution report content", () => {
  it("shows clear empty states for a period with no loans or active inventory", () => {
    render(
      <MemoryRouter>
        <AssetUsageDistributionContent
          usageKpis={[]}
          distributionKpis={[]}
          distributionBreakdown={{
            byCategory: [],
            byLocation: [],
            byStatus: [],
          }}
          timeframeLabel="Last 30 days"
        />
      </MemoryRouter>
    );

    expect(screen.getByText("No loans in this period.")).toBeTruthy();
    expect(screen.getByText("No active inventory to distribute.")).toBeTruthy();
    expect(screen.queryByText("0%")).toBeNull();
  });
});
