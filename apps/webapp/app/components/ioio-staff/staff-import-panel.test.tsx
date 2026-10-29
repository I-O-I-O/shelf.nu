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
  return render(<RouterProvider router={router} />);
}

describe("StaffImportPanel review gate", () => {
  it("shows image and status columns for ready rows", () => {
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

    expect(screen.getByRole("columnheader", { name: "Image" })).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Status" })).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Import" })).toBeTruthy();
    expect(screen.getByText("Development Boards Drawer")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Ignore" })).toBeTruthy();
  });

  it("shows a no-image state and offers Fix when a location needs review", () => {
    renderPanel({
      locationId: null,
      locationResolution: "UNMATCHED",
      action: "NEEDS_REVIEW",
    });

    expect(screen.getByText("No reliable image found")).toBeTruthy();
    expect(screen.getByText("Needs review")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Fix" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Import" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(screen.getByLabelText("Received quantity")).toBeTruthy();
  });

  it("submits a row Import through scoped Apply and preserves other approval decisions", async () => {
    let submitted: FormData | null = null;
    const rows = [
      {
        rowNumber: 1,
        title: "Arduino Nano",
        action: "CREATE",
        assetId: null,
        categoryId: "category-1",
        locationId: "location-1",
        quantity: 5,
        receivedQuantity: 5,
        type: "QUANTITY_TRACKED",
        reason: "New item",
      },
      {
        rowNumber: 2,
        title: "USB-C Cable",
        action: "CREATE",
        assetId: null,
        categoryId: "category-1",
        locationId: "location-1",
        quantity: 20,
        receivedQuantity: 20,
        type: "QUANTITY_TRACKED",
        reason: "New item",
      },
    ];
    const savedReviewDecisions = rows.map((row) => ({
      rowNumber: row.rowNumber,
      decision: "APPROVE",
      title: row.title,
      assetId: null,
      categoryId: row.categoryId,
      locationId: row.locationId,
      quantity: row.quantity,
      type: row.type,
      trackingModeConfirmed: false,
      productChoice: "NEW",
      unitOfMeasure: "pcs",
      consumptionType: "TWO_WAY",
    }));
    renderPanel(
      {},
      true,
      {
        rows,
        savedReviewDecisions,
        locationOptions: [
          {
            id: "location-1",
            name: "Container A2-1",
            pathLabel: "Room A / Shelf A2 / Container A2-1",
            operational: false,
            currentUnits: 0,
            parentId: null,
          },
        ],
      } as Partial<StaffImportProposal>,
      async ({ request }) => {
        submitted = await request.formData();
        return {
          error: null,
          kind: "import-in-progress",
          operationId: "operation-1",
        };
      }
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Import" })[0]!);

    await waitFor(() => expect(submitted).not.toBeNull());
    expect(submitted?.get("intent")).toBe("apply-row");
    expect(submitted?.get("rowNumber")).toBe("1");
    expect(
      JSON.parse(String(submitted?.get("reviewDecisions"))).map(
        (decision: { decision: string }) => decision.decision
      )
    ).toEqual(["APPROVE", "APPROVE"]);
  });

  it("imports selected rows directly and shows structured server issues until corrected", async () => {
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
    renderPanel(
      {},
      true,
      { rows } as Partial<StaffImportProposal>,
      async ({ request }) => {
        submitted = await request.formData();
        return {
          error: null,
          kind: "import-review-blocked",
          readyCount: 1,
          blockedCount: 1,
          blockedRows: [
            {
              rowNumber: 2,
              title: "USB-C Cable",
              issues: [
                {
                  code: "INVALID_CATEGORY",
                  message: "Choose a valid active category for USB-C Cable.",
                },
              ],
            },
          ],
        };
      }
    );
    fireEvent.click(screen.getByLabelText("Select all products on this page"));
    fireEvent.click(screen.getByRole("button", { name: "Import selected" }));
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "1 ready · 1 need review"
      )
    );
    expect(submitted?.get("intent")).toBe("apply-selected");
    expect(submitted?.get("rowNumbers")).toBe("[1,2]");
    await waitFor(() =>
      expect(
        screen.getByRole("row", { name: /USB-C Cable/ })
      ).toHaveTextContent("Needs review")
    );
    fireEvent.change(screen.getByLabelText("Category for USB-C Cable"), {
      target: { value: "category-1" },
    });
    expect(screen.getByRole("row", { name: /USB-C Cable/ })).toHaveTextContent(
      "Ready"
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps quantity tracking quiet and requires confirmation for individual tracking", () => {
    renderPanel({
      trackingReason: "Default for identical stock and components.",
    });
    expect(screen.queryByText("Individual tracking")).toBeNull();
    expect(screen.getByText("Quantity tracked")).toBeTruthy();
  });

  it("shows individual tracking details and requires explicit confirmation", () => {
    renderPanel({
      type: "INDIVIDUAL",
      trackingSource: "SOURCE_EXPLICIT",
      trackingReasonCode: "EXPLICIT_SERIALIZED_SOURCE",
      trackingReason:
        "The source explicitly marks this item for individual tracking.",
    });

    expect(screen.getByText("Individual tracking")).toBeTruthy();
    expect(screen.getByText("Individual / QR tracked")).toBeTruthy();
    expect(
      screen.getByText(
        "The source explicitly marks this item for individual tracking."
      )
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();

    fireEvent.click(screen.getByLabelText("Select Arduino Nano"));
    expect(
      screen.getByRole("button", { name: "Approve selected safe rows" })
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    const confirmation = screen.getByLabelText(
      "Confirm that Apply should create separate individual QR-tracked assets."
    );
    expect(confirmation).not.toBeChecked();
    fireEvent.click(confirmation);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
  });

  it("allows staff to change a new model to quantity tracking during review", () => {
    renderPanel({ type: "INDIVIDUAL", trackingSource: "SOURCE_EXPLICIT" });
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    fireEvent.change(screen.getByLabelText("Tracking mode"), {
      target: { value: "QUANTITY_TRACKED" },
    });

    expect(
      screen.queryByText(
        "Confirm that Apply should create separate individual QR-tracked assets."
      )
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
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

    expect(screen.getByLabelText("Tracking mode")).toBeDisabled();
    expect(
      screen.queryByText(
        "Confirm that Apply should create separate individual QR-tracked assets."
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
    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
    expect(screen.getByLabelText("Location")).toBeTruthy();
  });

  it("does not count unassigned Mouser rows as ready in the summary", () => {
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

    const summary = screen.getByText(/1 unassigned category/).parentElement;
    expect(summary).toBeTruthy();
    expect(summary).toHaveTextContent("1 unassigned category");
    expect(summary).toHaveTextContent("1 unassigned location");
    expect(summary).not.toHaveTextContent("ready");
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

    const approve = screen.queryByRole("button", { name: "Approve" });
    if (approve) fireEvent.click(approve);

    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
  });

  it("enables Apply when the proposal row has all required decisions", () => {
    renderPanel({ action: "CREATE", type: "QUANTITY_TRACKED" });
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    expect(
      screen.getByRole("button", { name: "Apply 1 approved item" })
    ).toBeEnabled();
    expect(screen.getByText("Quantity tracked")).toBeTruthy();
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
      { action: "CREATE", type: "QUANTITY_TRACKED" },
      true,
      {},
      applyAction
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Apply 1 approved item" })
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
      { action: "CREATE", type: "QUANTITY_TRACKED" },
      true,
      {},
      applyAction
    );

    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    fireEvent.click(
      screen.getByRole("button", { name: "Apply 1 approved item" })
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The proposal changed; review it again."
    );
    expect(applyAction).toHaveBeenCalledOnce();
    expect(screen.queryByText("Applying approved changes...")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Apply 1 approved item" })
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

    fireEvent.click(screen.getByRole("button", { name: "Fix" }));
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
    fireEvent.change(screen.getByLabelText("Location"), {
      target: { value: "container-1" },
    });
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
    expect(
      screen.getByText(/1 product found · 0 approved · 1 need review/)
    ).toBeTruthy();
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
    const quantity = screen.getByLabelText("Received quantity");
    expect(quantity).toHaveValue(4);
    fireEvent.change(quantity, { target: { value: "7" } });
    expect(screen.getByRole("row", { name: /Arduino Nano/ })).toHaveTextContent(
      "7"
    );
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
    expect(
      screen.getByText(/12 products found · 0 approved · 12 need review/)
    ).toBeTruthy();
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
    expect(screen.getByLabelText("AssetModel description")).toHaveValue(
      "A compact microcontroller board for electronics prototyping."
    );
    const useImage = screen.getByRole("checkbox", {
      name: "Use this image for the Shelf product",
    });
    expect(useImage).toBeChecked();
    expect(screen.getByLabelText("Upload another image")).toBeTruthy();
    fireEvent.click(useImage);
    expect(useImage).not.toBeChecked();
  });

  it("supports row selection and bulk ignore without changing Apply or Cancel controls", () => {
    renderPanel({ action: "NEEDS_REVIEW" });

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select Arduino Nano" })
    );
    fireEvent.click(screen.getByRole("button", { name: "Ignore selected" }));

    expect(screen.getByText("Ignored")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Confirm 1 ignored row" })
    ).toBeEnabled();
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

    expect(
      screen.getByText(/20 products found · 0 approved · 0 need review/)
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]!);
    expect(
      screen.getByText(/20 products found · 1 approved · 0 need review/)
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Apply 1 approved item" })
    );

    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(
      submittedDecisions.filter(({ decision }) => decision === "APPROVE")
    ).toMatchObject([{ rowNumber: 1, decision: "APPROVE", quantity: 1 }]);
  });

  it("bulk approves only the selected safe rows", () => {
    const rows = Array.from({ length: 6 }, (_, index) => ({
      rowNumber: index + 1,
      title: `Item ${index + 1}`,
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
    renderPanel({}, true, { rows } as Partial<StaffImportProposal>);

    for (let index = 1; index <= 5; index++) {
      fireEvent.click(
        screen.getByRole("checkbox", { name: `Select Item ${index}` })
      );
    }
    fireEvent.click(
      screen.getByRole("button", { name: "Approve selected safe rows" })
    );

    expect(
      screen.getByText(/6 products found · 5 approved · 0 need review/)
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Apply 5 approved items" })
    ).toBeEnabled();
  });

  it("saves the edited review choices for later without applying inventory", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(screen.getByRole("button", { name: "Save for later" }));

    await waitFor(() => expect(saveAction).toHaveBeenCalledOnce());
    expect(await screen.findByText(/Draft saved/)).toBeTruthy();
    expect(
      screen.getByText(/Draft · Nothing changes in Shelf until Apply/)
    ).toBeTruthy();
    expect(savedDecisions[0]).toMatchObject({
      decision: "APPROVE",
      categoryId: "category-1",
      locationId: "location-1",
    });
    expect(screen.queryByText(/Import finished/)).toBeNull();
  });

  it("keeps imported rows visible and prevents selecting them again", () => {
    renderPanel({ quantity: 4, receivedQuantity: 4 }, true, {
      appliedRowNumbers: [1],
    });

    expect(screen.getAllByText("Imported")).toHaveLength(1);
    expect(
      screen.getByRole("checkbox", { name: "Select Arduino Nano" })
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("keeps confirmed ignored rows out of Apply and bulk selection", () => {
    renderPanel({}, true, {
      ignoredRowNumbers: [1],
      savedReviewDecisions: [{ rowNumber: 1, decision: "IGNORE" }],
    });

    expect(screen.getAllByText("Ignored")).toHaveLength(1);
    expect(
      screen.getByRole("checkbox", { name: "Select Arduino Nano" })
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
