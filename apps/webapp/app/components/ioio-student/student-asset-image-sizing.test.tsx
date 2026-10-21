import { render, screen } from "@testing-library/react";
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

  it("renders the resolved Shelf image URL in a student inventory card", () => {
    render(
      <StudentAssetPlaceholder
        asset={{
          id: "makey-unit-1",
          title: "Makey Kit #001",
          type: "INDIVIDUAL",
          mainImage: "https://storage.example/makey-kit.jpg",
          thumbnailImage: null,
          assetModel: null,
        }}
      />
    );

    expect(screen.getByAltText("Image of Makey Kit #001")).toHaveAttribute(
      "src",
      "https://storage.example/makey-kit.jpg"
    );
  });

  it("renders the resolved Shelf image URL in a student asset detail", () => {
    render(
      <StudentAssetPlaceholder
        variant="detail"
        asset={{
          id: "makey-unit-1",
          title: "Makey Kit #001",
          type: "INDIVIDUAL",
          mainImage: "https://storage.example/makey-kit.jpg",
          thumbnailImage: null,
          assetModel: null,
        }}
      />
    );

    expect(screen.getByAltText("Image of Makey Kit #001")).toHaveAttribute(
      "src",
      "https://storage.example/makey-kit.jpg"
    );
  });
});
