import { render, screen } from "@testing-library/react";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";
import { StaffInventoryTools } from "./staff-inventory-tools";

function renderInventoryTools() {
  const Stub = createRoutesStub([
    { path: "/home", Component: StaffInventoryTools },
  ]);
  return render(<Stub initialEntries={["/home"]} />);
}

describe("staff dashboard inventory shortcuts", () => {
  it("shows compact Import and Organize cards linked to their staff pages", () => {
    renderInventoryTools();

    expect(
      screen.getByRole("heading", { name: "Import", level: 2 })
    ).toBeInTheDocument();
    expect(
      screen.getByText("Add inventory from PDF, CSV, or Excel files.")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Import inventory" })
    ).toHaveAttribute("href", "/staff/import");

    expect(
      screen.getByRole("heading", { name: "Organize", level: 2 })
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Review existing inventory, find better locations, and plan simple storage changes."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Organize" })).toHaveAttribute(
      "href",
      "/staff/organize"
    );
  });

  it("does not render the old explanatory content", () => {
    renderInventoryTools();

    for (const oldCopy of [
      "Inventory tools",
      "Choose a focused tool to bring in inventory or improve where it is stored.",
      "Works best for",
      "Current limitations",
      "How the AI works",
      "One main goal per request works best.",
    ]) {
      expect(screen.queryByText(oldCopy)).not.toBeInTheDocument();
    }
  });

  it("uses a responsive fluid card grid without fixed widths", () => {
    const { container } = renderInventoryTools();
    const cardGrid = container.querySelector("section");
    const cards = Array.from(container.querySelectorAll("article"));

    expect(cardGrid).toBeTruthy();
    expect(cardGrid?.className).toContain("sm:grid-cols-2");
    expect(cardGrid?.className).toContain("items-stretch");
    expect(cardGrid?.className).not.toMatch(/(?:min-)?w-\[\d/);
    expect(cards).toHaveLength(2);

    const [importCard, organizeCard] = cards;
    expect(importCard.className).toBe(organizeCard.className);
    for (const card of cards) {
      expect(card.className).toContain("flex");
      expect(card.className).toContain("flex-col");
      expect(card.className).toContain("h-full");
      expect(card.className).not.toMatch(/\bh-\[\d/);
      expect(card.querySelector("p")?.className).toContain("flex-1");
      expect(card.querySelector("a")?.parentElement?.className).toContain(
        "mt-auto"
      );
    }
  });
});
