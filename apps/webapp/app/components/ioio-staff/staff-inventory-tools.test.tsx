import { render, screen, within } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { StaffInventoryTools } from "./staff-inventory-tools";

function renderInventoryTools() {
  const Stub = createRoutesStub([
    { path: "/home", Component: StaffInventoryTools },
  ]);
  return render(<Stub initialEntries={["/home"]} />);
}

describe("staff dashboard inventory tools", () => {
  it("renders the section and links to the existing import and organize routes", () => {
    renderInventoryTools();

    expect(
      screen.getByRole("heading", { name: "Inventory tools", level: 2 })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Import inventory" })
    ).toHaveAttribute("href", "/staff/import");
    expect(
      screen.getByRole("link", { name: "Organize inventory" })
    ).toHaveAttribute("href", "/staff/organize");
  });

  it("explains Import capabilities and the review boundary", () => {
    renderInventoryTools();
    const importCard = screen
      .getByRole("heading", {
        name: "Import inventory",
        level: 3,
      })
      .closest("article");
    expect(importCard).toBeTruthy();
    const importContent = within(importCard as HTMLElement);

    expect(importContent.getByText(/PDF, CSV and XLSX/)).toBeInTheDocument();
    expect(
      importContent.getByText(/extracts products and quantities/)
    ).toBeInTheDocument();
    expect(importContent.getByText(/normalizes names/)).toBeInTheDocument();
    expect(
      importContent.getByText(/matches existing inventory/)
    ).toBeInTheDocument();
    expect(
      importContent.getAllByText(/existing categories and locations/).length
    ).toBeGreaterThan(0);
    expect(
      importContent.getByText(/ambiguous rows may need correction/)
    ).toBeInTheDocument();
    expect(
      importContent.getByText(/does not reorganize inventory/)
    ).toBeInTheDocument();
    expect(
      importContent.getByText(/descriptions and images may not be a match/)
    ).toBeInTheDocument();
    expect(
      importContent.getByText(/Nothing is created until staff approves Apply/)
    ).toBeInTheDocument();
  });

  it("describes Organize's supported work and current movement boundary", () => {
    renderInventoryTools();
    const organizeCard = screen
      .getByRole("heading", {
        name: "Organize inventory",
        level: 3,
      })
      .closest("article");
    expect(organizeCard).toBeTruthy();
    const organizeContent = within(organizeCard as HTMLElement);

    expect(
      organizeContent.getByText(/what is stored in a location/)
    ).toBeInTheDocument();
    expect(
      organizeContent.getByText(/better existing locations/)
    ).toBeInTheDocument();
    expect(
      organizeContent.getByText(/Creating simple rooms/)
    ).toBeInTheDocument();
    expect(
      organizeContent.getByText(/eligible empty locations/)
    ).toBeInTheDocument();
    expect(
      organizeContent.getByText(/Where should Arduino Nano go/)
    ).toBeInTheDocument();
    expect(
      organizeContent.getByText(/Show what is stored in Section A/)
    ).toBeInTheDocument();
    expect(
      organizeContent.getByText(/One main goal per request/)
    ).toBeInTheDocument();
    expect(
      organizeContent.getByText(/does not move products/)
    ).toBeInTheDocument();
    expect(
      organizeContent.getByText(/not measured container capacity/)
    ).toBeInTheDocument();
  });

  it("uses a responsive fluid card grid without fixed widths", () => {
    const { container } = renderInventoryTools();
    const cardGrid = container.querySelector("section > .grid");

    expect(cardGrid).toBeTruthy();
    expect(cardGrid?.className).toContain("sm:grid-cols-2");
    expect(cardGrid?.className).not.toMatch(/(?:min-)?w-\[\d/);
  });
});
