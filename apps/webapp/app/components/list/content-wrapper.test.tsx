import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ListContentWrapper } from "./content-wrapper";

describe("ListContentWrapper", () => {
  it("fills the available page width without allowing child overflow", () => {
    render(
      <ListContentWrapper>
        <div>List content</div>
      </ListContentWrapper>
    );

    const wrapper = screen.getByText("List content").parentElement;
    expect(wrapper).toHaveClass("w-full", "min-w-0", "max-w-full");
  });
});
