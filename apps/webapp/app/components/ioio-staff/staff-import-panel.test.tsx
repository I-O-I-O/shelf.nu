import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import type { StaffImportProposal } from "~/modules/ioio-staff/inventory-import.server";
import { StaffImportPanel } from "./staff-import-panel";

function renderPanel(
  rowOverrides: Record<string, unknown>,
  canCreateCategory = true,
  proposalOverrides: Partial<StaffImportProposal> = {},
  action?: (args: { request: Request }) => Promise<unknown>
) {
  const proposal = {
    version: 1,
    operationId: "operation-1",
    organizationId: "org-1",
    proposalHash: "proposal-hash",
    source: { filename: "inventory.pdf", size: 100, sha256: "a".repeat(64) },
    rows: [
      {
        rowNumber: 1,
        title: "Arduino Nano",
        action: "CREATE",
        assetId: null,
        categoryId: "category-1",
        locationId: null,
        currentQuantity: null,
        currentCategoryId: null,
        currentLocationId: null,
        quantity: 5,
        receivedQuantity: 5,
        type: "QUANTITY_TRACKED",
        reason: "New item",
        ...rowOverrides,
      },
    ],
    counts: {
      CREATE: 1,
      INCREASE_QUANTITY: 0,
      NO_CHANGE: 0,
      POSSIBLE_DUPLICATE: 0,
      NEEDS_REVIEW: 0,
      IGNORE: 0,
      UPDATE_QUANTITY: 0,
      UPDATE_LOCATION: 0,
      UPDATE_CATEGORY: 0,
      AMBIGUOUS: 0,
      REJECT: 0,
    },
    createdAt: new Date().toISOString(),
    categoryOptions: [{ id: "category-1", name: "Electronics" }],
    locationOptions: [],
    ...proposalOverrides,
  } as unknown as StaffImportProposal;
  const router = createMemoryRouter(
    [
      {
        path: "/staff/import",
        action,
        element: (
          <StaffImportPanel
            actionPath="/staff/import"
            initialProposal={proposal}
            canCreateCategory={canCreateCategory}
          />
        ),
      },
    ],
    { initialEntries: ["/staff/import"] }
  );
  return render(<RouterProvider router={router} />);
}

describe("StaffImportPanel review gate", () => {
  it("keeps Apply disabled after Approve when category is unresolved", () => {
    renderPanel({
      action: "NEEDS_REVIEW",
      categoryId: null,
      categoryResolution: "NEW_PROPOSED",
      proposedCategoryName: "Electronics",
    });

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
    expect(screen.getAllByText("NEEDS_REVIEW").length).toBeGreaterThan(0);
  });

  it.each([
    [
      "ambiguous location",
      { action: "NEEDS_REVIEW", locationResolution: "AMBIGUOUS" },
    ],
    ["invalid row", { action: "REJECT" }],
  ])("keeps Apply disabled for an %s", (_label, row) => {
    renderPanel(row);

    const approve = screen.queryByRole("button", { name: "Approve" });
    if (approve) fireEvent.click(approve);

    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
  });

  it("enables Apply when the proposal row has all required decisions", () => {
    renderPanel({ action: "CREATE", type: "INDIVIDUAL" });

    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeEnabled();
    expect(screen.getByText(/5 physical units/)).toBeTruthy();
  });

  it("submits Apply and exits the pending state after success", async () => {
    let finishAction!: (result: unknown) => void;
    const applyAction = vi.fn(
      () =>
        new Promise((resolve) => {
          finishAction = resolve;
        })
    );
    renderPanel(
      { action: "CREATE", type: "INDIVIDUAL" },
      true,
      {},
      applyAction
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Apply approved changes" })
    );

    await waitFor(() => expect(applyAction).toHaveBeenCalledOnce());
    expect(
      await screen.findByText("Applying approved changes...")
    ).toBeTruthy();
    finishAction({
      error: null,
      kind: "import-result",
      result: {
        createdIds: ["asset-1"],
        updatedIds: [],
        reusedIds: [],
        failedRows: [],
        conflictRows: [],
      },
    });

    await waitFor(() => {
      expect(screen.queryByText("Applying approved changes...")).toBeNull();
      expect(screen.getByText(/Import finished/)).toBeTruthy();
    });
  });

  it("returns to usable review state after a server validation error", async () => {
    const applyAction = vi.fn(() =>
      Promise.resolve({
        error: { message: "The proposal changed; review it again." },
      })
    );
    renderPanel(
      { action: "CREATE", type: "INDIVIDUAL" },
      true,
      {},
      applyAction
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Apply approved changes" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The proposal changed; review it again."
    );
    expect(applyAction).toHaveBeenCalledOnce();
    expect(screen.queryByText("Applying approved changes...")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeEnabled();
  });

  it("keeps new-category approval unresolved when Shelf denies category creation", () => {
    renderPanel(
      {
        action: "NEEDS_REVIEW",
        categoryId: null,
        categoryResolution: "NEW_PROPOSED",
        proposedCategoryName: "Sensors",
      },
      false
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      screen.getByRole("checkbox", { name: /Approve creating this category/i })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
  });

  it("shows the selected category and location in the review summary", () => {
    renderPanel(
      {
        action: "NEEDS_REVIEW",
        categoryId: null,
        category: "Cables",
        suggestedCategory: "Cables",
        categoryResolution: "ARCHIVED_MATCH",
        locationId: null,
        quantity: 20,
        type: "QUANTITY_TRACKED",
      },
      true,
      {
        categoryOptions: [
          { id: "active-cables", name: "Cables & adapters", archived: false },
          { id: "archived-cables", name: "Cables", archived: true },
        ],
        locationOptions: [
          {
            id: "container-1",
            name: "Container A1-1.1",
            pathLabel: "IOIO Lab – B477 · Shelf A1 · Container A1-1.1",
            parentId: "shelf-a1",
            currentUnits: 18,
            operational: false,
          },
        ],
      }
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Category"), {
      target: { value: "active-cables" },
    });
    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "container-1" },
    });

    expect(screen.getAllByText("Cables & adapters").length).toBe(2);
    expect(
      screen.getAllByText("IOIO Lab – B477 · Shelf A1 · Container A1-1.1")
        .length
    ).toBe(2);
    expect(
      screen.getByText(
        "Current units: 18; import adds: 20; capacity: not configured"
      )
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Matching category is archived; choose an active category."
      )
    ).toBeNull();
  });
});
