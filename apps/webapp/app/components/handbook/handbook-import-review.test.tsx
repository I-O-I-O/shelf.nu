import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { HandbookImportReview } from "./handbook-import-review";

function renderReview(isStudent: boolean) {
  const router = createMemoryRouter(
    [
      {
        path: "/handbook/import",
        Component: () => (
          <HandbookImportReview
            draft={{
              title: "Soldering Basics",
              content: "## Safety\n\nWear eye protection.",
              sourceUrls: ["https://example.com/manual"],
            }}
            categories={[]}
            isStudent={isStudent}
            organizationId="org-1"
            userId="user-1"
            onImportAnother={() => {}}
          />
        ),
      },
    ],
    { initialEntries: ["/handbook/import"] }
  );

  return render(<RouterProvider router={router} />);
}

describe("HandbookImportReview", () => {
  it("shows editable imported fields and Staff draft/publish actions", () => {
    renderReview(false);

    expect(screen.getByLabelText("Title")).toHaveValue("Soldering Basics");
    expect(screen.getByRole("combobox", { name: "Category" })).toBeTruthy();
    expect(screen.getByLabelText(/Article content/)).toHaveValue(
      "## Safety\n\nWear eye protection."
    );
    expect(screen.getByLabelText(/External references/)).toHaveValue(
      "https://example.com/manual"
    );
    expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Publish article" })
    ).toBeTruthy();
    expect(screen.queryByText("Section")).toBeNull();
    expect(screen.queryByText(/Related Shelf products/)).toBeNull();
  });

  it("uses the student proposal and review actions", () => {
    renderReview(true);

    expect(
      screen.getByText(/choose an existing Handbook category or propose one/i)
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save draft" })).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Submit for review" })
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Publish article" })
    ).toBeNull();
  });
});
