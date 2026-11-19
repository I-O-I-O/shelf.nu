import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IoioPageContainer } from "./page-container";

describe("IoioPageContainer", () => {
  it("centers full-width content with a consistent phone gutter", () => {
    render(
      <IoioPageContainer>
        <p>Page content</p>
      </IoioPageContainer>
    );

    expect(screen.getByRole("main")).toHaveClass(
      "mx-auto",
      "box-border",
      "w-full",
      "min-w-0",
      "max-w-full",
      "px-4"
    );
  });

  it("allows routes to add desktop widths without constraining phone width", () => {
    render(
      <IoioPageContainer className="max-w-7xl sm:px-6 lg:px-8">
        <p>Responsive page content</p>
      </IoioPageContainer>
    );

    expect(screen.getByRole("main")).toHaveClass(
      "w-full",
      "min-w-0",
      "max-w-7xl",
      "px-4",
      "sm:px-6",
      "lg:px-8"
    );
  });
});
