import type { Currency } from "@prisma/client";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import InventoryValueChart from "./inventory-value-chart";

describe("InventoryValueChart", () => {
  it("stacks the progress circle and metrics responsively to avoid overflow", () => {
    const loaderData: {
      totalAssets: number;
      valueKnownAssets: number;
      totalValuation: number;
      currency: Currency;
      locale: string;
    } = {
      totalAssets: 3,
      valueKnownAssets: 2,
      totalValuation: 123456789012.34,
      currency: "USD" satisfies Currency,
      locale: "en-US",
    };

    render(
      <MemoryRouter>
        <InventoryValueChart {...loaderData} />
      </MemoryRouter>
    );

    const layout = screen.getByTestId("inventory-value-layout");

    expect(layout).toHaveClass("flex-col");
    expect(layout).toHaveClass("md:flex-row");

    const expectedValue = loaderData.totalValuation.toLocaleString(
      loaderData.locale,
      { style: "currency", currency: loaderData.currency }
    );

    const valueElement = screen.getByText(expectedValue);

    expect(valueElement).toBeInTheDocument();
    expect(valueElement).toHaveClass("whitespace-nowrap");
  });
});
