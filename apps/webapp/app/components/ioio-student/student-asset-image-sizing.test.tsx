import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StudentAssetPlaceholder } from "./student-ui";

describe("student asset image sizing", () => {
  it("bounds card and detail frames independently of image availability", () => {
    const card = render(<StudentAssetPlaceholder />);
    expect(card.container.firstElementChild?.className).toContain(
      "max-h-[240px]"
    );
    card.unmount();

    const detail = render(<StudentAssetPlaceholder variant="detail" />);
    expect(detail.container.firstElementChild?.className).toContain(
      "max-w-[600px]"
    );
    expect(detail.container.firstElementChild?.className).toContain(
      "lg:h-[27.5rem]"
    );
  });
});
