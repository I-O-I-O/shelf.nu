import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
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
    categoryOptions: [
      { id: "category-1", name: "Electronics", color: "#2878b8" },
    ],
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
  return { ...render(<RouterProvider router={router} />), router };
}

describe("StaffImportPanel review gate", () => {
  it("keeps the review controls compact and the edit panel structured", () => {
    renderPanel(
      {
        action: "CREATE",
        locationId: "location-1",
        locationLabel: "Development Boards Drawer",
      },
      true,
      {
        locationOptions: [
          {
            id: "location-1",
            name: "Development Boards Drawer",
            pathLabel: "Development Boards Drawer",
            operational: false,
            currentUnits: 0,
            parentId: null,
          },
        ],
      }
    );

    expect(screen.getByRole("columnheader", { name: "Product" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Qty" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Category" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Location" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Image" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    const editHeader = screen.getByRole("columnheader", { name: "Edit" });
    expect(editHeader.className).toContain("w-[88px]");
    expect(screen.getByRole("table").className).toContain("min-w-[920px]");
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Development Boards Drawer")).toBeTruthy();

    const filename = screen.getByRole("heading", { name: "inventory.pdf" });
    const header = filename.parentElement?.parentElement;
    expect(header).toBeTruthy();
    const headerButtons = within(header!).getAllByRole("button");
    expect(headerButtons).toEqual([
      screen.getByRole("button", { name: "Apply approved changes" }),
      screen.getByRole("button", { name: "Cancel" }),
    ]);
    expect(
      screen.getByText(
        "Draft · Review edits save automatically. Nothing changes in Shelf until Apply."
      )
    ).toBeTruthy();
    expect(
      screen.queryByText(/approved ·|need review ·|products found ·/)
    ).toBeNull();
    expect(screen.queryByText("Draft saved automatically.")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Approve selected safe rows" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Import selected" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Ignore selected" })
    ).toBeNull();

    const row = screen.getByRole("row", { name: /Arduino Nano/ });
    expect(within(row).getByRole("button", { name: "Edit" })).toBeVisible();
    expect(within(row).queryByRole("button", { name: "Import" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(row).queryByRole("button", { name: "Ignore" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = screen.getByRole("group", { name: "Edit Arduino Nano" });
    expect(
      within(editor).getByRole("heading", { name: "Edit asset" })
    ).toBeTruthy();
    expect(within(editor).queryByText("Product")).toBeNull();
    expect(within(editor).queryByText("Inventory")).toBeNull();
    expect(within(editor).queryByText("Placement")).toBeNull();
    expect(within(editor).getByLabelText("Upload image")).toBeTruthy();
    expect(within(editor).queryByLabelText("Shelf match")).toBeNull();
    expect(within(editor).queryByText("Shelf match")).toBeNull();
    const itemName = within(editor).getByLabelText("Item name");
    fireEvent.change(itemName, { target: { value: "Arduino Nano ESP32" } });
    expect(itemName).toHaveValue("Arduino Nano ESP32");
    expect(within(editor).getByLabelText("Inventory quantity")).toBeTruthy();
    expect(within(editor).getByLabelText("Tracking mode")).toHaveValue(
      "QUANTITY_TRACKED"
    );
    expect(within(editor).getByLabelText("Consumption type")).toBeTruthy();
    expect(within(editor).queryByLabelText("Unit of measure")).toBeNull();
    expect(within(editor).queryByLabelText("Minimum quantity")).toBeNull();
    expect(within(editor).getByLabelText("Category")).toBeTruthy();
    expect(
      within(editor).getByRole("button", { name: "Location" })
    ).toBeTruthy();
    const layout = editor.querySelector(":scope > div.grid");
    expect(layout?.className).toContain("items-start");
    expect(layout?.className).toContain("grid-cols-1");
    expect(layout?.className).toContain(
      "lg:grid-cols-[minmax(0,1.4fr)_minmax(220px,0.8fr)]"
    );
    expect(layout?.className).not.toContain("h-full");
    expect(editor.className).toContain("border-gray-200");
    expect(editor.className).toContain("p-3");
    const description = within(editor).getByLabelText("Description");
    expect(description.className).toContain("w-full");
    expect(description.className).toContain("min-w-0");
    expect(description.className).toContain("min-h-[100px]");
    expect(description.className).toContain("resize-y");
    expect(description.closest("label")?.className).toContain("max-w-[512px]");
    expect(description).toHaveAttribute("rows", "4");
    expect(within(editor).getByText("Image")).toBeTruthy();
    const orderedFields = [
      itemName,
      within(editor).getByLabelText("Inventory quantity"),
      within(editor).getByRole("button", { name: "Location" }),
      within(editor).getByLabelText("Category"),
      within(editor).getByLabelText("Tracking mode"),
      within(editor).getByLabelText("Consumption type"),
      within(editor).getByLabelText("Upload image"),
      description,
    ];
    expect(
      orderedFields.every(
        (field, index) =>
          index === orderedFields.length - 1 ||
          Boolean(
            field.compareDocumentPosition(orderedFields[index + 1]) &
              Node.DOCUMENT_POSITION_FOLLOWING
          )
      )
    ).toBe(true);
    expect(editor.querySelector("input")?.className).toContain("min-w-0");
    expect(editor.querySelector("input")?.className).toContain("w-full");
    expect(editor.querySelector("[class*='overflow-x']")).toBeNull();
    expect(editor.textContent).not.toContain("Quantity settings");
    expect(within(editor).queryByRole("button", { name: "Import" })).toBeNull();
    expect(
      within(editor).queryByRole("button", { name: "Approve" })
    ).toBeNull();
    expect(within(editor).queryByRole("button", { name: "Ignore" })).toBeNull();
  });
  it("shows a no-image state and offers Edit when a location needs review", () => {
    renderPanel({
      locationId: null,
      locationResolution: "UNMATCHED",
      action: "NEEDS_REVIEW",
      productImageProposal: {
        status: "IMAGE_NOT_FOUND",
        failureReason: "SEARCH_PROVIDER_NOT_CONFIGURED",
      },
    });

    expect(screen.getByText("No reliable image found")).toBeTruthy();
    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      screen.getByText("Image search is unavailable right now.")
    ).toBeTruthy();
    expect(
      screen.queryByText(
        /SEARCH_PROVIDER_NOT_CONFIGURED|Search Provider Not Configured/
      )
    ).toBeNull();
    expect(screen.getByLabelText("Inventory quantity")).toBeTruthy();
  });

  it("uses row checkboxes as approval and applies only checked rows", async () => {
    const rows = ["Arduino Nano", "USB-C Cable"].map((title, index) => ({
      rowNumber: index + 1,
      title,
      action: "CREATE",
      assetId: null,
      categoryId: "category-1",
      locationId: null,
      quantity: 5,
      receivedQuantity: 5,
      type: "QUANTITY_TRACKED",
      reason: "New item",
    }));
    let submitted: FormData | undefined;
    const action = vi.fn(async ({ request }: { request: Request }) => {
      const form = await request.formData();
      if (form.get("intent") === "save-draft") {
        return {
          error: null,
          kind: "import-draft-saved",
          operationId: "operation-1",
        };
      }
      submitted = form;
      return {
        error: null,
        kind: "import-in-progress",
        operationId: "operation-1",
      };
    });
    renderPanel({}, true, { rows } as Partial<StaffImportProposal>, action);

    const firstRow = screen.getByLabelText("Approve Arduino Nano for import");
    const secondRow = screen.getByLabelText("Approve USB-C Cable for import");
    expect(firstRow).not.toBeChecked();
    expect(secondRow).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();

    fireEvent.click(firstRow);
    expect(firstRow).toBeChecked();
    expect(screen.queryByText("1 selected")).toBeNull();
    fireEvent.click(firstRow);
    expect(firstRow).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();

    fireEvent.click(firstRow);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Apply approved changes" })
      ).toBeEnabled();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Apply approved changes" })
    );
    await waitFor(() => expect(submitted).toBeDefined());
    expect(submitted?.get("intent")).toBe("apply-import");
    const decisions = JSON.parse(String(submitted?.get("reviewDecisions")));
    expect(
      decisions.map(
        (decision: { decision: string | null }) => decision.decision
      )
    ).toEqual(["APPROVE", null]);
    expect(decisions[0]).toMatchObject({
      productChoice: "NEW",
      unitOfMeasure: "pcs",
      consumptionType: "TWO_WAY",
      minQuantity: null,
    });
    expect(submitted?.get("rowNumbers")).toBeNull();
  });
  it("keeps Needs review rows disabled until their required issue is resolved", () => {
    renderPanel({
      title: "USB-C Cable",
      action: "NEEDS_REVIEW",
      categoryId: null,
      categoryResolution: "NEW_PROPOSED",
      proposedCategoryName: "Cables",
    });

    const checkbox = screen.getByLabelText("Approve USB-C Cable for import");
    expect(checkbox).toBeDisabled();
    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
    fireEvent.click(checkbox);
    expect(checkbox).not.toBeChecked();
    expect(
      screen.queryByRole("button", { name: "Approve selected safe rows" })
    ).toBeNull();
  });
  it("keeps quantity tracking quiet and requires confirmation for individual tracking", () => {
    renderPanel({
      trackingReason: "Default for identical stock and components.",
    });
    expect(screen.queryByText("Individual tracking")).toBeNull();
    expect(screen.getByText("Quantity tracked")).toBeTruthy();
    expect(
      screen.queryByText(
        /Individual tracking suggested|QR tracked|Tracking review required/i
      )
    ).toBeNull();
  });

  it("defaults source individual suggestions to quantity and lets staff select individual tracking", () => {
    renderPanel({
      type: "INDIVIDUAL",
      trackingSource: "SOURCE_EXPLICIT",
      trackingReasonCode: "EXPLICIT_SERIALIZED_SOURCE",
      trackingReason:
        "The source explicitly marks this item for individual tracking.",
    });

    expect(screen.queryByText("Individual tracking")).toBeNull();
    expect(screen.getByText("Quantity tracked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const trackingMode = screen.getByLabelText("Tracking mode");
    expect(trackingMode).toHaveValue("QUANTITY_TRACKED");
    fireEvent.change(trackingMode, { target: { value: "INDIVIDUAL" } });
    expect(screen.getByText("Individual tracking")).toBeTruthy();
    expect(screen.getByText("Individual / QR tracked")).toBeTruthy();
    const approval = screen.getByLabelText("Approve Arduino Nano for import");
    expect(approval).toBeDisabled();
    const confirmation = screen.getByLabelText(
      "Confirm separate individual QR-tracked assets on Apply."
    );
    expect(confirmation).not.toBeChecked();
    fireEvent.click(confirmation);
    expect(approval).toBeEnabled();
    fireEvent.click(approval);
    expect(approval).toBeChecked();
  });

  it("normalizes an unconfirmed legacy individual draft to the quantity default", () => {
    renderPanel(
      { type: "INDIVIDUAL", trackingSource: "SOURCE_EXPLICIT" },
      true,
      {
        savedReviewDecisions: [
          {
            rowNumber: 1,
            decision: null,
            type: "INDIVIDUAL",
            trackingModeConfirmed: false,
          },
        ],
      }
    );

    expect(screen.queryByText("Individual tracking")).toBeNull();
    expect(screen.getByText("Quantity tracked")).toBeTruthy();
  });

  it("preserves a manually selected individual mode in a saved draft", () => {
    renderPanel({ trackingSource: "DETERMINISTIC_DEFAULT" }, true, {
      savedReviewDecisions: [
        {
          rowNumber: 1,
          decision: null,
          type: "INDIVIDUAL",
          trackingModeConfirmed: false,
          trackingModeSelectedByStaff: true,
        },
      ],
    });

    expect(screen.getByText("Individual tracking")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(
      screen.getByLabelText(
        "Confirm separate individual QR-tracked assets on Apply."
      )
    ).not.toBeChecked();
  });

  it("keeps quantity tracking as the review default for imported rows", () => {
    renderPanel({ type: "INDIVIDUAL", trackingSource: "SOURCE_EXPLICIT" });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Tracking mode"), {
      target: { value: "QUANTITY_TRACKED" },
    });

    expect(
      screen.queryByText(
        "Confirm separate individual QR-tracked assets on Apply."
      )
    ).toBeNull();
    expect(
      screen.getByLabelText("Approve Arduino Nano for import")
    ).toBeEnabled();
  });

  it("locks tracking mode when a row uses an existing Shelf model", () => {
    renderPanel({
      assetId: "existing-asset",
      type: "INDIVIDUAL",
      trackingSource: "EXISTING_MODEL",
      matchCandidates: [
        {
          id: "existing-asset",
          title: "Arduino Nano",
          quantity: null,
          type: "INDIVIDUAL",
          category: "Electronics",
          location: null,
          expectedAssetState: {
            assetId: "existing-asset",
            title: "Arduino Nano",
            type: "INDIVIDUAL",
            quantity: null,
            categoryId: "category-1",
            locationIds: [],
            assetModelId: "model-1",
          },
        },
      ],
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.queryByLabelText("Shelf match")).toBeNull();
    expect(screen.getByLabelText("Tracking mode")).toBeDisabled();
    expect(
      screen.queryByText(
        "Confirm separate individual QR-tracked assets on Apply."
      )
    ).toBeNull();
  });

  it("uses a staff-friendly description source and hides image diagnostics", () => {
    renderPanel({
      assetModelDescription: "Wireless RP2350 microcontroller board.",
      assetModelDescriptionSource: "SOURCE",
      productImageProposal: {
        status: "IMAGE_NOT_FOUND",
        failureReason: "SEARCH_PROVIDER_NOT_CONFIGURED",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByLabelText("Description")).toHaveValue(
      "Wireless RP2350 microcontroller board."
    );
    expect(screen.getByText("Source: Import document")).toBeTruthy();
    expect(screen.getByText("No reliable image found.")).toBeTruthy();
    expect(
      screen.getByText("Image search is unavailable right now.")
    ).toBeTruthy();
    expect(
      screen.queryByText(
        /SEARCH_PROVIDER_NOT_CONFIGURED|Search Provider Not Configured/
      )
    ).toBeNull();
  });

  it("shows unresolved category and location as choices", () => {
    renderPanel(
      { categoryId: null, locationId: null, category: null, location: null },
      true,
      {
        locationOptions: [
          {
            id: "location-1",
            name: "Shelf",
            pathLabel: "Lab / Shelf",
            operational: false,
            currentUnits: 0,
            parentId: null,
          },
        ],
      }
    );

    expect(screen.getByText("Choose category")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Location for Arduino Nano" })
    ).toHaveTextContent("Choose location");
    expect(screen.getByLabelText("Category for Arduino Nano")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Location")).toBeTruthy();
  });

  it("does not repeat approval counts under the concise header", () => {
    renderPanel(
      {
        action: "CREATE",
        categoryId: null,
        locationId: null,
        category: null,
        location: null,
        mouserLineItem: true,
      },
      true,
      {
        source: {
          filename: "mouser.pdf",
          size: 100,
          sha256: "a".repeat(64),
          extractionProvider: "mouser-deterministic+claude-enrichment:v2",
        },
      }
    );

    expect(screen.getByRole("heading", { name: "mouser.pdf" })).toBeTruthy();
    expect(screen.getByText("1 product found")).toBeTruthy();
    expect(
      screen.queryByText(
        /products found ·|need review ·|unassigned category|unassigned location/
      )
    ).toBeNull();
    expect(
      screen.getByText(
        "Location assignment is optional when applying the import."
      )
    ).toBeTruthy();
  });
  it("shows medium-confidence suggestions without silently selecting them", () => {
    renderPanel(
      {
        categoryId: null,
        locationId: null,
        category: null,
        location: null,
        suggestedCategoryId: "category-1",
        categorySuggestionConfidence: 0.65,
        suggestedLocationId: "location-1",
        locationSuggestionConfidence: 0.65,
      },
      true,
      {
        locationOptions: [
          {
            id: "location-1",
            name: "Sensors Drawer",
            pathLabel: "Electronics Room / Sensors Drawer",
            operational: false,
            currentUnits: 0,
            parentId: null,
          },
        ],
      }
    );

    expect(screen.getByText("Suggested: Electronics · choose")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Location for Arduino Nano" })
    );
    expect(screen.getByText("Suggested", { selector: "p" })).toBeTruthy();
    expect(
      screen.getByRole("option", {
        name: "Electronics Room / Sensors Drawer",
      })
    ).toBeTruthy();
    expect(screen.getByLabelText("Category for Arduino Nano")).toHaveValue("");
  });

  it("keeps a Needs review row unapproved while category is unresolved", () => {
    renderPanel({
      action: "NEEDS_REVIEW",
      categoryId: null,
      categoryResolution: "NEW_PROPOSED",
      proposedCategoryName: "Electronics",
    });

    expect(
      screen.getByLabelText("Approve Arduino Nano for import")
    ).toBeDisabled();

    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
  });

  it.each([
    [
      "ambiguous location",
      { action: "NEEDS_REVIEW", locationResolution: "AMBIGUOUS" },
    ],
    ["invalid row", { action: "REJECT" }],
  ])("keeps Apply disabled for an %s", (_label, row) => {
    renderPanel(row);

    const approval = screen.getByLabelText("Approve Arduino Nano for import");
    expect(approval).not.toBeChecked();
    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
  });

  it("enables Apply after required decisions have been auto-saved", async () => {
    const saveAction = vi.fn(() =>
      Promise.resolve({
        error: null,
        kind: "import-draft-saved",
        operationId: "operation-1",
      })
    );
    renderPanel(
      { action: "CREATE", type: "QUANTITY_TRACKED" },
      true,
      {},
      saveAction
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByLabelText("Approve Arduino Nano for import"));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Apply approved changes" })
      ).toBeEnabled();
    });
    expect(saveAction).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Tracking mode")).toHaveValue(
      "QUANTITY_TRACKED"
    );
  });

  it("submits Apply and exits the pending state after success", async () => {
    let finishAction!: (result: unknown) => void;
    const applyAction = vi.fn(async ({ request }: { request: Request }) => {
      const form = await request.formData();
      if (form.get("intent") === "save-draft") {
        return {
          error: null,
          kind: "import-draft-saved",
          operationId: "operation-1",
        };
      }
      return new Promise((resolve) => {
        finishAction = resolve;
      });
    });
    renderPanel(
      { action: "CREATE", type: "QUANTITY_TRACKED" },
      true,
      {},
      applyAction
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByLabelText("Approve Arduino Nano for import"));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Apply approved changes" })
      ).toBeEnabled();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Apply approved changes" })
    );

    await waitFor(() => expect(applyAction).toHaveBeenCalledTimes(2));
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
    const applyAction = vi.fn(async ({ request }: { request: Request }) => {
      const form = await request.formData();
      return form.get("intent") === "save-draft"
        ? {
            error: null,
            kind: "import-draft-saved",
            operationId: "operation-1",
          }
        : { error: { message: "The proposal changed; review it again." } };
    });
    renderPanel(
      { action: "CREATE", type: "QUANTITY_TRACKED" },
      true,
      {},
      applyAction
    );

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByLabelText("Approve Arduino Nano for import"));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Apply approved changes" })
      ).toBeEnabled();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Apply approved changes" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The proposal changed; review it again."
    );
    expect(applyAction).toHaveBeenCalledTimes(2);
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
      screen.getByRole("checkbox", { name: /Allow creating this category/i })
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
          {
            id: "active-cables",
            name: "Cables & adapters",
            color: "#2878b8",
            archived: false,
          },
          {
            id: "archived-cables",
            name: "Cables",
            color: "#777777",
            archived: true,
          },
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

    fireEvent.change(screen.getByLabelText("Category for Arduino Nano"), {
      target: { value: "active-cables" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.click(screen.getByRole("button", { name: "Location" }));
    fireEvent.click(
      screen.getByRole("option", {
        name: "IOIO Lab – B477 · Shelf A1 · Container A1-1.1",
      })
    );
    fireEvent.click(screen.getByText("Details"));

    expect(screen.getByLabelText("Category for Arduino Nano")).toHaveValue(
      "active-cables"
    );
    expect(
      screen.getAllByText("IOIO Lab – B477 · Shelf A1 · Container A1-1.1")
        .length
    ).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByText(
        "Location capacity context: 18 current units; 20 proposed units; capacity not configured."
      )
    ).toBeTruthy();
    expect(
      screen.queryByText(
        "Matching category is archived; choose an active category."
      )
    ).toBeNull();
  });

  it("shows one compact row and keeps source and confidence details collapsed", () => {
    renderPanel(
      {
        title: "Relay Module",
        action: "NEEDS_REVIEW",
        supplierPartNumber: "713-101010001",
        manufacturerPartNumber: "101010001",
        categoryId: null,
        categoryResolution: "NEW_PROPOSED",
        proposedCategoryName: "Electronics",
        quantity: 4,
        orderedQuantity: null,
        receivedQuantity: null,
        type: "QUANTITY_TRACKED",
        categoryConfidence: "Medium",
        categoryReason: "An electronic component category is likely.",
        enrichmentConfidence: 0.83,
        sourceEvidence: [
          {
            sourceRef: "page-1-line-1",
            page: 1,
            text: "Private source excerpt for the relay module",
          },
        ],
      },
      true,
      {
        counts: {
          CREATE: 0,
          INCREASE_QUANTITY: 0,
          NO_CHANGE: 0,
          POSSIBLE_DUPLICATE: 0,
          NEEDS_REVIEW: 1,
          IGNORE: 0,
          UPDATE_QUANTITY: 0,
          UPDATE_LOCATION: 0,
          UPDATE_CATEGORY: 0,
          AMBIGUOUS: 0,
          REJECT: 0,
        },
      }
    );

    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByText("1 product found")).toBeTruthy();
    expect(screen.getByText("713-101010001")).not.toBeVisible();
    expect(screen.getByText("101010001")).not.toBeVisible();
    expect(screen.queryByRole("columnheader", { name: "Tracking" })).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Category" })).toBeTruthy();
    expect(screen.queryByText("Ordered quantity:")).toBeNull();
    expect(screen.queryByText("Received quantity:")).toBeNull();
    expect(
      screen.getByText("Private source excerpt for the relay module")
    ).not.toBeVisible();
    expect(
      screen.getByText(/An electronic component category is likely\./)
    ).not.toBeVisible();
    expect(screen.queryByText("INCREASE_QUANTITY")).toBeNull();
    expect(screen.queryByText("CREATE: 0")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Approve safe matches" })
    ).toBeNull();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(screen.queryByText("QUANTITY_TRACKED")).toBeNull();
    fireEvent.click(screen.getByText("Details"));
    expect(screen.getByText("713-101010001")).toBeVisible();
    expect(screen.getByText("101010001")).toBeVisible();
    expect(screen.getByText("Tracking:").parentElement).toHaveTextContent(
      "Tracking: Quantity"
    );
  });

  it("shows normalized quantity in the compact table and preloads Edit", () => {
    renderPanel({ quantity: 4, receivedQuantity: 4, type: "QUANTITY_TRACKED" });

    expect(screen.getByRole("row", { name: /Arduino Nano/ })).toHaveTextContent(
      "4"
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const quantity = screen.getByLabelText("Inventory quantity");
    expect(quantity).toHaveValue(4);
    fireEvent.change(quantity, { target: { value: "7" } });
    expect(
      screen.getAllByRole("row", { name: /Arduino Nano/ })[0]
    ).toHaveTextContent("7");
  });

  it("labels a concrete existing Shelf candidate as a possible match", () => {
    renderPanel({
      action: "POSSIBLE_DUPLICATE",
      matchCandidates: [
        {
          id: "asset-model-1",
          title: "Relay Module",
          quantity: 4,
          type: "QUANTITY_TRACKED",
          category: "Electronics",
          location: null,
        },
      ],
    });

    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(
      screen.getByText(/may already exist. Choose Use existing/)
    ).toBeTruthy();
    expect(screen.queryByText("Duplicate")).toBeNull();
  });

  it("renders selected categories with Shelf's colored category badge", () => {
    const { container } = renderPanel({
      categoryId: "category-1",
      category: "Electronics",
    });

    const categoryBadge = container.querySelector('[style*="#2878b833"]');
    expect(categoryBadge).toHaveTextContent("Electronics");
    expect(screen.getByLabelText("Category for Arduino Nano")).toBeTruthy();
  });

  it("does not label a possible-duplicate action without a Shelf candidate", () => {
    renderPanel({ action: "POSSIBLE_DUPLICATE", matchCandidates: [] });

    expect(screen.queryByText("Possible match")).toBeNull();
    expect(screen.queryByText("Possible match")).toBeNull();
  });

  it("renders the twelve-product review sample as twelve compact rows", () => {
    const productNames = [
      "TinkerKit boards",
      "Button Module",
      "Relay Module",
      "Relay Module",
      "LED Module",
      "Joystick",
      "Potentiometer",
      "Linear Potentiometer",
      "2/3 Axis Accelerometer",
      "RobotDyn 1 Relay 5V",
      "TinkerKit Sensor Shield",
      "Rotary encoder / potentiometer",
    ];
    const rows = productNames.map((title, index) => ({
      rowNumber: index + 1,
      title,
      action: "NEEDS_REVIEW",
      assetId: null,
      categoryId: null,
      locationId: null,
      currentQuantity: null,
      currentCategoryId: null,
      currentLocationId: null,
      quantity: index < 3 ? index + 5 : 1,
      receivedQuantity: null,
      type: index === 0 || index === 8 ? "INDIVIDUAL" : "QUANTITY_TRACKED",
      category: "Electronics",
      reason: "Awaiting staff review",
    }));

    renderPanel({}, true, { rows } as Partial<StaffImportProposal>);

    expect(screen.getAllByRole("row")).toHaveLength(13);
    expect(screen.getByText("12 products found")).toBeTruthy();
    expect(screen.getAllByText("Relay Module")).toHaveLength(2);
    productNames
      .filter((title) => title !== "Relay Module")
      .forEach((title) => expect(screen.getByText(title)).toBeTruthy());
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    screen
      .getAllByText("Awaiting staff review")
      .forEach((reason) => expect(reason).not.toBeVisible());
  });

  it("reveals source and confidence evidence only when Details is expanded", () => {
    renderPanel({
      sourceEvidence: [
        {
          sourceRef: "page-1-line-1",
          page: 1,
          text: "Private source excerpt for Arduino Nano",
        },
      ],
      categoryConfidence: "High",
      categoryReason: "The name identifies a development board.",
      enrichmentConfidence: 0.91,
    });

    expect(
      screen.getByText("Private source excerpt for Arduino Nano")
    ).not.toBeVisible();
    fireEvent.click(screen.getByText("Details"));
    expect(
      screen.getByText("Private source excerpt for Arduino Nano")
    ).toBeTruthy();
    expect(
      screen.getByText(/The name identifies a development board\./)
    ).toBeVisible();
  });

  it("shows the proposed description and image for staff review and editing", () => {
    renderPanel({
      assetModelDescription:
        "A compact microcontroller board for electronics prototyping.",
      assetModelDescriptionSource: "GENERATED",
      productImageProposal: {
        status: "IMAGE_FOUND",
        mimeType: "image/webp",
        imageId: `ioio-import-${"a".repeat(64)}`,
        sourceName: "Arduino Nano board",
        sourceUrl: "https://openverse.org/image/1",
        license: "cc0",
        autoAccepted: true,
      },
    });

    expect(screen.queryByText(/AssetModel description:/)).not.toBeVisible();
    expect(
      screen.getByRole("img", {
        name: "Proposed: Arduino Nano",
      })
    ).toBeVisible();
    expect(
      screen.getByRole("img", { name: "Proposed: Arduino Nano" })
    ).toHaveAttribute("src", `/api/image/ioio-import-${"a".repeat(64)}`);
    fireEvent.click(screen.getByText("Details"));
    expect(
      screen.getByText(
        /A compact microcontroller board for electronics prototyping\./
      )
    ).toBeVisible();
    expect(
      screen.getByRole("img", { name: "Suggested product for Arduino Nano" })
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByLabelText("Description")).toHaveValue(
      "A compact microcontroller board for electronics prototyping."
    );
    const useImage = screen.getByRole("checkbox", {
      name: "Use this image for the Shelf product",
    });
    expect(useImage).toBeChecked();
    expect(screen.getByLabelText("Replace image")).toBeTruthy();
    fireEvent.click(useImage);
    expect(useImage).not.toBeChecked();
  });

  it("keeps Needs review rows out of the Apply set", () => {
    renderPanel({
      action: "NEEDS_REVIEW",
      categoryId: null,
      categoryResolution: "NEW_PROPOSED",
      proposedCategoryName: "Electronics",
    });

    const checkbox = screen.getByLabelText("Approve Arduino Nano for import");
    expect(checkbox).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Ignore selected" })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
  });

  it("submits Cancel through the existing import action", async () => {
    const cancelAction = vi.fn(() =>
      Promise.resolve({ error: null, kind: "import-cancelled" })
    );
    renderPanel({ action: "NEEDS_REVIEW" }, true, {}, cancelAction);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(cancelAction).toHaveBeenCalledOnce());
  });

  it("approves one selected row and submits only that row for Apply", async () => {
    const rows = Array.from({ length: 20 }, (_, index) => ({
      rowNumber: index + 1,
      title:
        index === 0 ? "Seeed Studio XIAO ESP32-S3 Sense" : `Item ${index + 1}`,
      action: "CREATE",
      assetId: null,
      categoryId: "category-1",
      locationId: null,
      currentQuantity: null,
      currentCategoryId: null,
      currentLocationId: null,
      quantity: index + 1,
      receivedQuantity: index + 1,
      type: "QUANTITY_TRACKED",
      reason: "New item",
    }));
    let submittedDecisions: Array<{ rowNumber: number; decision: string }> = [];
    const action = vi.fn(async ({ request }: { request: Request }) => {
      const form = await request.formData();
      if (form.get("intent") === "save-draft") {
        return {
          error: null,
          kind: "import-draft-saved",
          operationId: "operation-1",
        };
      }
      submittedDecisions = JSON.parse(
        String(form.get("reviewDecisions"))
      ) as typeof submittedDecisions;
      return {
        error: null,
        kind: "import-in-progress",
        operationId: "operation-1",
      };
    });
    renderPanel({}, true, { rows } as Partial<StaffImportProposal>, action);

    expect(screen.getByText("20 products found")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
    fireEvent.click(
      screen.getByLabelText(
        "Approve Seeed Studio XIAO ESP32-S3 Sense for import"
      )
    );
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Apply approved changes" })
      ).toBeEnabled();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Apply approved changes" })
    );

    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(
      submittedDecisions.filter(({ decision }) => decision === "APPROVE")
    ).toMatchObject([{ rowNumber: 1, decision: "APPROVE", quantity: 1 }]);
  });

  it("approves rows directly through their checkboxes", async () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({
      rowNumber: index + 1,
      title: "Item " + (index + 1),
      action: "CREATE",
      assetId: null,
      categoryId: "category-1",
      locationId: null,
      currentQuantity: null,
      currentCategoryId: null,
      currentLocationId: null,
      quantity: index + 1,
      receivedQuantity: index + 1,
      type: "QUANTITY_TRACKED",
      reason: "New item",
    }));
    const saveAction = vi.fn(() =>
      Promise.resolve({
        error: null,
        kind: "import-draft-saved",
        operationId: "operation-1",
      })
    );
    renderPanel({}, true, { rows } as Partial<StaffImportProposal>, saveAction);

    for (let index = 1; index <= 5; index++) {
      fireEvent.click(
        screen.getByLabelText("Approve Item " + index + " for import")
      );
    }

    expect(screen.queryByText(/products found ·/)).toBeNull();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Apply approved changes" })
      ).toBeEnabled();
    });
  });
  it("automatically saves edited review choices without applying inventory", async () => {
    let savedDecisions: Array<Record<string, unknown>> = [];
    const saveAction = vi.fn(async ({ request }: { request: Request }) => {
      const form = await request.formData();
      savedDecisions = JSON.parse(String(form.get("reviewDecisions"))) as Array<
        Record<string, unknown>
      >;
      return {
        error: null,
        kind: "import-draft-saved",
        operationId: "operation-1",
      };
    });
    renderPanel(
      { locationId: null },
      true,
      {
        locationOptions: [
          {
            id: "location-1",
            name: "Shelf B3",
            pathLabel: "Storage / Section B / Shelf B3",
            operational: false,
            currentUnits: 2,
            parentId: "section-b",
          },
        ],
      },
      saveAction
    );

    fireEvent.change(screen.getByLabelText("Category for Arduino Nano"), {
      target: { value: "category-1" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Location for Arduino Nano" })
    );
    fireEvent.click(
      screen.getByRole("option", { name: "Storage / Section B / Shelf B3" })
    );
    fireEvent.click(screen.getByLabelText("Approve Arduino Nano for import"));
    expect(screen.queryByRole("button", { name: "Save for later" })).toBeNull();

    await waitFor(() => expect(saveAction).toHaveBeenCalledOnce());
    expect(
      screen.getByText(/Draft · Review edits save automatically/)
    ).toBeTruthy();
    expect(savedDecisions[0]).toMatchObject({
      decision: "APPROVE",
      categoryId: "category-1",
      locationId: "location-1",
    });
    expect(screen.queryByText(/Import finished/)).toBeNull();
  });

  it("clears implemented selection with Cancel and keeps Revert selected", async () => {
    const submittedForms: FormData[] = [];
    const action = vi.fn(async ({ request }: { request: Request }) => {
      submittedForms.push(await request.formData());
      return {
        error: {
          message: "The selected rows have already changed.",
        },
      };
    });
    const { router } = renderPanel(
      { quantity: 4, receivedQuantity: 4 },
      true,
      {
        rows: [1, 2, 3, 4].map((rowNumber) => ({
          rowNumber,
          title: `Arduino Nano ${rowNumber}`,
          action: "CREATE",
          assetId: null,
          categoryId: "category-1",
          locationId: null,
          currentQuantity: null,
          currentCategoryId: null,
          currentLocationId: null,
          quantity: rowNumber,
          receivedQuantity: rowNumber,
          type: "QUANTITY_TRACKED",
          category: "Electronics",
          location: null,
          reason: "New item",
        })),
        appliedRowNumbers: [1, 2, 3],
        revertibleRowNumbers: [1, 2, 3],
      },
      action
    );

    const implemented = screen.getByRole("region", {
      name: "Implemented (3)",
    });
    const pending = screen.getByRole("region", { name: "Pending review (1)" });
    const implementedTable = within(implemented).getByRole("table");
    const pendingTable = within(pending).getByRole("table");
    expect(implementedTable.className).toBe(pendingTable.className);
    expect(implementedTable.className).toContain("min-w-[920px]");
    expect(implemented.className).toBe(pending.className);
    const implementedHeading = within(implemented).getByRole("heading", {
      name: "Implemented (3)",
    });
    const implementedHeader = implementedHeading.parentElement as HTMLElement;
    const pendingHeader = within(pending).getByRole("heading", {
      name: "Pending review (1)",
    }).parentElement as HTMLElement;
    expect(implementedHeader.className).toBe(pendingHeader.className);
    expect(implementedHeader.className).toContain("flex-wrap");
    expect(implementedTable.parentElement?.className).toContain(
      "overflow-x-auto"
    );
    const pendingSelectAll = within(pending).getByRole("checkbox", {
      name: "Approve all ready rows on this page for import",
    });
    const pendingRowCheckbox = within(pending).getByRole("checkbox", {
      name: "Approve Arduino Nano 4 for import",
    });
    const implementedSelectAll = within(implemented).getByRole("checkbox", {
      name: "Select all implemented rows that can be reverted",
    });
    const implementedRowCheckbox = within(implemented).getByRole("checkbox", {
      name: "Select Arduino Nano 1 to revert",
    });
    expect(pendingSelectAll.className).toBe(pendingRowCheckbox.className);
    expect(pendingSelectAll.className).toBe(implementedSelectAll.className);
    expect(pendingSelectAll.className).toBe(implementedRowCheckbox.className);
    expect(
      within(implementedTable).getByRole("columnheader", { name: "Product" })
    ).toBeTruthy();
    expect(
      within(implementedTable).getByRole("columnheader", { name: "Qty" })
    ).toBeTruthy();
    expect(
      within(implementedTable).getByRole("columnheader", { name: "Status" })
    ).toBeTruthy();
    expect(within(implemented).getByText("Arduino Nano 1")).toBeTruthy();
    expect(within(implemented).getByText("Arduino Nano 2")).toBeTruthy();
    expect(within(implemented).getByText("Arduino Nano 3")).toBeTruthy();
    expect(within(implemented).getAllByRole("checkbox")).toHaveLength(4);
    expect(
      within(implemented).queryByRole("button", { name: /^Revert$/ })
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Revert selected" })
    ).toBeNull();

    fireEvent.click(
      within(implemented).getByRole("checkbox", {
        name: "Select Arduino Nano 1 to revert",
      })
    );
    expect(screen.getByText("1 selected")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Revert selected" })
    ).toBeTruthy();
    fireEvent.click(
      within(implemented).getByRole("checkbox", {
        name: "Select Arduino Nano 2 to revert",
      })
    );
    expect(screen.getByText("2 selected")).toBeTruthy();
    const implementedButtons = within(implementedHeader).getAllByRole("button");
    const implementedAction = within(implementedHeader).getByRole("button", {
      name: "Revert selected",
    });
    const implementedCancel = within(implementedHeader).getByRole("button", {
      name: "Cancel",
    });
    expect(implementedButtons).toEqual([implementedAction, implementedCancel]);
    expect(implementedAction).toBeTruthy();
    const topLevelCancel = screen.getAllByRole("button", { name: "Cancel" })[0];
    expect(implementedCancel.className).toBe(topLevelCancel.className);
    for (const button of [implementedAction, implementedCancel]) {
      for (const geometryClass of [
        "rounded",
        "border",
        "text-sm",
        "font-semibold",
        "px-4",
        "py-[10px]",
      ]) {
        expect(button.className).toContain(geometryClass);
      }
      expect(button.className).toContain("whitespace-nowrap");
    }
    expect(
      within(implementedTable).queryByRole("button", {
        name: "Revert selected",
      })
    ).toBeNull();
    expect(implementedHeader.className).toContain("flex-wrap");
    const actionGroup = implementedCancel.parentElement;
    expect(actionGroup?.className).toContain("gap-2");
    expect(actionGroup?.className).toContain("flex-wrap");
    expect(actionGroup?.className).toContain("min-w-0");

    fireEvent.click(implementedCancel);
    expect(submittedForms).toHaveLength(0);
    expect(router.state.location.pathname).toBe("/staff/import");
    expect(
      screen.getByRole("heading", { name: "inventory.pdf" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
    expect(
      within(implemented).getByRole("checkbox", {
        name: "Select Arduino Nano 1 to revert",
      })
    ).not.toBeChecked();
    expect(
      within(implemented).getByRole("checkbox", {
        name: "Select Arduino Nano 2 to revert",
      })
    ).not.toBeChecked();
    expect(within(implemented).queryByText("2 selected")).toBeNull();
    expect(
      within(implementedHeader).queryByRole("button", {
        name: "Revert selected",
      })
    ).toBeNull();
    expect(
      within(implementedHeader).queryByRole("button", { name: "Cancel" })
    ).toBeNull();

    fireEvent.click(
      within(implemented).getByRole("checkbox", {
        name: "Select Arduino Nano 1 to revert",
      })
    );
    fireEvent.click(
      within(implemented).getByRole("checkbox", {
        name: "Select Arduino Nano 2 to revert",
      })
    );
    expect(within(implemented).getByText("2 selected")).toBeTruthy();
    const revertButton = within(implementedHeader).getByRole("button", {
      name: "Revert selected",
    });
    fireEvent.click(revertButton);
    await waitFor(() => expect(submittedForms).toHaveLength(1));
    const submission = submittedForms[0];
    expect(submission.get("intent")).toBe("revert-selected");
    expect(submission.get("operationId")).toBe("operation-1");
    expect(JSON.parse(String(submission.get("rowNumbers")))).toEqual([1, 2]);
    expect(
      within(implemented).getByRole("checkbox", {
        name: "Select Arduino Nano 3 to revert",
      })
    ).not.toBeChecked();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The selected rows have already changed."
    );
  });

  it("uses matching select-all controls for ready and implemented rows", async () => {
    const submittedIntents: string[] = [];
    const action = vi.fn(async ({ request }: { request: Request }) => {
      const formData = await request.formData();
      const intent = String(formData.get("intent"));
      submittedIntents.push(intent);
      return intent === "save-draft"
        ? {
            error: null,
            kind: "import-draft-saved",
            operationId: "operation-1",
          }
        : { error: { message: "No revert submitted." } };
    });
    renderPanel(
      { quantity: 4, receivedQuantity: 4 },
      true,
      {
        rows: [1, 2, 3, 4].map((rowNumber) => ({
          rowNumber,
          title: `Arduino Nano ${rowNumber}`,
          action: "CREATE",
          assetId: null,
          categoryId: "category-1",
          locationId: null,
          currentQuantity: null,
          currentCategoryId: null,
          currentLocationId: null,
          quantity: rowNumber,
          receivedQuantity: rowNumber,
          type: "QUANTITY_TRACKED",
          category: "Electronics",
          location: null,
          reason: "New item",
        })),
        appliedRowNumbers: [1, 2, 3],
        revertibleRowNumbers: [1, 2, 3],
      },
      action
    );

    const pending = screen.getByRole("region", { name: "Pending review (1)" });
    const pendingSelectAll = within(pending).getByRole("checkbox", {
      name: "Approve all ready rows on this page for import",
    });
    const pendingRow = within(pending).getByRole("checkbox", {
      name: "Approve Arduino Nano 4 for import",
    });
    fireEvent.click(pendingSelectAll);
    expect(pendingSelectAll).toBeChecked();
    expect(pendingRow).toBeChecked();
    expect(within(pending).getByText("1 approved")).toBeTruthy();
    await waitFor(() => expect(submittedIntents).toEqual(["save-draft"]));

    fireEvent.click(pendingSelectAll);
    expect(pendingSelectAll).not.toBeChecked();
    expect(pendingRow).not.toBeChecked();
    await waitFor(() =>
      expect(submittedIntents).toEqual(["save-draft", "save-draft"])
    );
    expect(within(pending).queryByText("1 approved")).toBeNull();

    const implemented = screen.getByRole("region", {
      name: "Implemented (3)",
    });
    const implementedSelectAll = within(implemented).getByRole("checkbox", {
      name: "Select all implemented rows that can be reverted",
    });
    fireEvent.click(implementedSelectAll);
    expect(implementedSelectAll).toBeChecked();
    expect(within(implemented).getByText("3 selected")).toBeTruthy();
    for (const rowNumber of [1, 2, 3]) {
      expect(
        within(implemented).getByRole("checkbox", {
          name: `Select Arduino Nano ${rowNumber} to revert`,
        })
      ).toBeChecked();
    }

    fireEvent.click(implementedSelectAll);
    expect(implementedSelectAll).not.toBeChecked();
    expect(within(implemented).queryByText("3 selected")).toBeNull();
    expect(
      within(implemented).queryByRole("button", { name: "Revert selected" })
    ).toBeNull();
  });

  it("keeps previously ignored rows out of Apply", () => {
    renderPanel({}, true, {
      ignoredRowNumbers: [1],
      savedReviewDecisions: [{ rowNumber: 1, decision: "IGNORE" }],
    });

    expect(screen.getAllByText("Ignored")).toHaveLength(1);
    expect(
      screen.getByRole("checkbox", { name: "Approve Arduino Nano for import" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
  });
});

it("edits location inline using full organization paths without submitting", () => {
  const action = vi.fn(); // why: observe the external route submission boundary.
  renderPanel(
    { locationId: "a", locationLabel: "Storage / Section A / Container 1" },
    true,
    {
      locationOptions: [
        {
          id: "a",
          name: "Container 1",
          pathLabel: "Storage / Section A / Container 1",
          parentId: null,
        },
        {
          id: "b",
          name: "Container 1",
          pathLabel: "Storage / Section B / Container 1",
          parentId: null,
        },
      ],
    } as never,
    action
  );
  const selector = screen.getByRole("button", {
    name: "Location for Arduino Nano",
  });
  expect(selector).toHaveTextContent("Storage / Section A / Container 1");
  fireEvent.click(selector);
  const search = screen.getByRole("searchbox", {
    name: "Search locations for Arduino Nano",
  });
  fireEvent.change(search, { target: { value: "section b" } });
  fireEvent.click(
    screen.getByRole("option", {
      name: "Storage / Section B / Container 1",
    })
  );
  expect(selector).toHaveTextContent("Storage / Section B / Container 1");
  expect(
    screen.getByRole("combobox", { name: "Category for Arduino Nano" })
  ).toBeInTheDocument();
  expect(action).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect(selector).toBeInTheDocument();
});
it("offers Choose location for unresolved rows", () => {
  renderPanel({ locationId: null });
  const picker = screen.getByRole("button", {
    name: "Location for Arduino Nano",
  });
  expect(picker).toHaveTextContent("Choose location");
  fireEvent.click(picker);
  expect(
    screen.getByRole("option", { name: "Choose location" })
  ).toBeInTheDocument();
});

it("shows a weak existing location suggestion in the inline picker", () => {
  renderPanel(
    {
      locationId: null,
      locationLabel: "Unassigned",
      suggestedLocationId: "location-1",
      locationSuggestionConfidence: 0.4,
      locationSuggestionStatus: "WEAK_SUGGESTION",
    },
    true,
    {
      locationOptions: [
        {
          id: "location-1",
          name: "Cable Drawer",
          pathLabel: "Lab · Cable Drawer",
          operational: false,
          currentUnits: 0,
          parentId: null,
        },
      ],
    }
  );

  const picker = screen.getByRole("button", {
    name: "Location for Arduino Nano",
  });
  expect(picker).toHaveTextContent("Choose location");
  fireEvent.click(picker);
  expect(screen.getByText("Suggested", { selector: "p" })).toBeTruthy();
  expect(
    screen.getByRole("option", { name: "Lab · Cable Drawer" })
  ).toBeTruthy();
});

it.each([
  ["storage", "Storage Room - B442 / Section B / Shelf B3"],
  ["section b", "Storage Room - B442 / Section B / Shelf B3"],
  ["b3", "Storage Room - B442 / Section B / Shelf B3"],
  [
    "container b3",
    "Storage Room - B442 / Section B / Shelf B3 / Container B3-1",
  ],
  ["soldering", "Soldering Room - B443 / Shelf S2"],
])("finds locations by hierarchy text: %s", (query, pathLabel) => {
  renderPanel({ locationId: null }, true, {
    locationOptions: [
      {
        id: "location-b3",
        name: "Shelf B3",
        pathLabel: "Storage Room - B442 / Section B / Shelf B3",
        operational: false,
        currentUnits: 2,
        parentId: "section-b",
      },
      {
        id: "location-container-b3-1",
        name: "Container B3-1",
        pathLabel:
          "Storage Room - B442 / Section B / Shelf B3 / Container B3-1",
        operational: false,
        currentUnits: 2,
        parentId: "location-b3",
      },
      {
        id: "location-soldering",
        name: "Shelf S2",
        pathLabel: "Soldering Room - B443 / Shelf S2",
        operational: false,
        currentUnits: 2,
        parentId: "soldering-room",
      },
    ],
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Location for Arduino Nano" })
  );
  fireEvent.change(
    screen.getByRole("searchbox", {
      name: "Search locations for Arduino Nano",
    }),
    { target: { value: query } }
  );

  expect(screen.getByRole("option", { name: pathLabel })).toBeInTheDocument();
});
