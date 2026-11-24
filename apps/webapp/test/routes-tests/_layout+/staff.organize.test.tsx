import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createActionArgs } from "@mocks/remix";

const mocks = vi.hoisted(() => ({
  requireIoioStaffAccess: vi.fn(),
  getOrganizationLocationChoices: vi.fn(),
  buildLocationStructureProposal: vi.fn(),
  createLocationStructure: vi.fn(),
  generateInventoryOrganizationProposal: vi.fn(),
  requirePermission: vi.fn(),
}));

// why: these route dependencies perform permission checks, database retrieval, and helper calls; the tests exercise request routing and the staff-visible UI.
vi.mock("~/modules/ioio-staff/access.server", () => ({
  requireIoioStaffAccess: mocks.requireIoioStaffAccess,
}));
vi.mock("~/modules/ioio-staff/location-structure.server", async () => ({
  buildLocationStructureProposal: mocks.buildLocationStructureProposal,
  createLocationStructure: mocks.createLocationStructure,
  getOrganizationLocationChoices: mocks.getOrganizationLocationChoices,
  classifyOrganizationRequest: (
    await import("~/modules/ioio-staff/organize-classification")
  ).classifyOrganizationRequest,
}));
vi.mock("~/modules/ioio-staff/location-intelligence.server", () => ({
  generateInventoryOrganizationProposal:
    mocks.generateInventoryOrganizationProposal,
}));
vi.mock("~/utils/roles.server", () => ({
  requirePermission: mocks.requirePermission,
}));
vi.mock("~/components/layout/header", () => ({ default: () => null }));

import StaffOrganizePage, {
  action,
  loader,
} from "~/routes/_layout+/staff.organize";

function renderOrganizePage(initialEntry = "/staff/organize") {
  const router = createMemoryRouter(
    [
      {
        path: "/staff/organize",
        Component: StaffOrganizePage,
        loader,
        action,
      },
    ],
    { initialEntries: [initialEntry] }
  );
  return render(<RouterProvider router={router} />);
}

describe("staff organize experience", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireIoioStaffAccess.mockResolvedValue({
      organizationId: "org-1",
      userId: "staff-1",
    });
    mocks.getOrganizationLocationChoices.mockResolvedValue({
      categories: [{ id: "electronics", name: "Electronics" }],
      locations: [
        { id: "storage", name: "Storage Room", path: "Storage Room" },
      ],
    });
  });

  it("shows one general input and one Analyze button without workflow choices", async () => {
    renderOrganizePage();
    expect(
      await screen.findByRole("heading", { name: "Organize" })
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText(
        "Describe what you want to organize, create, move, or improve..."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Analyze" })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Organize inventory" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create storage structure" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/LOCATION_STRUCTURE|INVENTORY_REORGANIZATION/)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Create Section A and B in the Storage Room/)
    ).toBeInTheDocument();
  });

  it("routes a storage request to structure review without inventory analysis", async () => {
    const user = userEvent.setup();
    mocks.buildLocationStructureProposal.mockResolvedValue({
      mode: "LOCATION_STRUCTURE",
      instruction:
        "Create Section A and Section B in the Storage Room with 7 shelves each.",
      parentName: "Storage Room",
      parentLocationId: "storage",
      parentCandidates: [],
      unresolvedParent: false,
      nodes: [
        {
          temporaryId: "section-a",
          parentLocationId: "storage",
          parentTemporaryId: null,
          name: "Section A",
          description: null,
          status: "CREATE",
          existingLocationId: null,
        },
      ],
      source: "DETERMINISTIC",
    });
    renderOrganizePage();
    await user.type(
      await screen.findByRole("textbox"),
      "Create Section A and Section B in the Storage Room with 7 shelves each."
    );
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(
      await screen.findByRole("heading", { name: "Storage structure proposal" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "Product" })
    ).not.toBeInTheDocument();
    expect(mocks.buildLocationStructureProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: expect.stringContaining("Section A"),
      })
    );
    expect(mocks.generateInventoryOrganizationProposal).not.toHaveBeenCalled();
  });

  it("shows nothing to remove and disables Apply for a zero-container preview", async () => {
    mocks.buildLocationStructureProposal.mockResolvedValue({
      mode: "LOCATION_STRUCTURE",
      instruction: "remove all containers in Section A",
      parentName: "Storage Room",
      parentLocationId: null,
      parentCandidates: [],
      unresolvedParent: false,
      nodes: [],
      source: "AI",
      deletionReview: {
        parentPath: "Storage Room",
        totalSelected: 0,
        sections: [
          {
            sectionName: "Section A",
            requestedRole: "CONTAINER",
            requestedQuantity: "ALL",
            total: 0,
            selected: [],
            blocked: [],
          },
        ],
      },
    });
    renderOrganizePage();
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("textbox"),
      "remove all containers in Section A"
    );
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findByText("Nothing to remove.")).toBeInTheDocument();
    expect(screen.getByText(/0 containers found/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Apply approved changes" })
    ).toBeDisabled();
    expect(mocks.generateInventoryOrganizationProposal).not.toHaveBeenCalled();
  });

  it("renders read-only task analysis without mutation controls or inventory recommendations", async () => {
    mocks.buildLocationStructureProposal.mockResolvedValue({
      mode: "LOCATION_STRUCTURE",
      instruction: "what's in section B?",
      parentCandidates: [],
      unresolvedParent: false,
      nodes: [],
      source: "AI",
      analysis: {
        rows: [
          {
            id: "section",
            path: "Storage Room - B442 / Section B",
            placements: 2,
            units: 5,
          },
        ],
        locationsConsidered: 1,
        truncated: false,
      },
    });
    renderOrganizePage();
    const user = userEvent.setup();
    await user.type(await screen.findByRole("textbox"), "what's in section B?");
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(
      await screen.findByRole("heading", { name: "Location analysis" })
    ).toBeInTheDocument();
    expect(screen.getByText(/2 asset placements/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Apply approved changes" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create all" })
    ).not.toBeInTheDocument();
    expect(mocks.generateInventoryOrganizationProposal).not.toHaveBeenCalled();
  });

  it("keeps a failed structure interpretation out of inventory analysis", async () => {
    mocks.buildLocationStructureProposal.mockResolvedValue({
      mode: "LOCATION_STRUCTURE",
      instruction: "clear containers in Section B",
      parentCandidates: [],
      unresolvedParent: true,
      nodes: [],
      source: "AI",
      planError:
        "Could not interpret the structure request. No inventory analysis was performed.",
    });
    renderOrganizePage();
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("textbox"),
      "clear containers in Section B"
    );
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(
      await screen.findByText(/Could not interpret the structure request/)
    ).toBeInTheDocument();
    expect(mocks.generateInventoryOrganizationProposal).not.toHaveBeenCalled();
  });

  it("routes container removal to structure review and never retrieves inventory", async () => {
    mocks.buildLocationStructureProposal.mockResolvedValue({
      mode: "LOCATION_STRUCTURE",
      instruction:
        "in storage room in section A remove all containers and in section B remove only half of them",
      parentName: null,
      parentLocationId: null,
      parentCandidates: [],
      unresolvedParent: false,
      nodes: [],
      deletionReview: { sections: [], totalSelected: 0 },
      source: "AI",
    });
    const form = new FormData();
    form.set(
      "instruction",
      "in storage room in section A remove all containers and in section B remove only half of them"
    );
    const result = await action(
      createActionArgs({
        request: new Request("http://localhost/staff/organize", {
          method: "POST",
          body: form,
        }),
      }) as never
    );
    expect(result).toMatchObject({ kind: "structure-proposal" });
    expect(mocks.buildLocationStructureProposal).toHaveBeenCalled();
    expect(mocks.generateInventoryOrganizationProposal).not.toHaveBeenCalled();
  });

  it("renders reused sections and fourteen new shelves beneath the resolved room", async () => {
    const user = userEvent.setup();
    mocks.getOrganizationLocationChoices.mockResolvedValue({
      categories: [],
      locations: [
        {
          id: "storage",
          name: "Storage Room - B442",
          path: "Storage Room - B442",
        },
      ],
    });
    const nodes = [
      {
        temporaryId: "section-a",
        parentLocationId: "storage",
        parentTemporaryId: null,
        name: "Section A",
        description: null,
        status: "EXISTS",
        existingLocationId: "section-a-id",
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        temporaryId: `shelf-a${index + 1}`,
        parentLocationId: null,
        parentTemporaryId: "section-a",
        name: `Shelf A${index + 1}`,
        description: null,
        status: "CREATE",
        existingLocationId: null,
      })),
      {
        temporaryId: "section-b",
        parentLocationId: "storage",
        parentTemporaryId: null,
        name: "Section B",
        description: null,
        status: "EXISTS",
        existingLocationId: "section-b-id",
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        temporaryId: `shelf-b${index + 1}`,
        parentLocationId: null,
        parentTemporaryId: "section-b",
        name: `Shelf B${index + 1}`,
        description: null,
        status: "CREATE",
        existingLocationId: null,
      })),
    ];
    mocks.buildLocationStructureProposal.mockResolvedValue({
      mode: "LOCATION_STRUCTURE",
      instruction:
        "Create Section A and Section B in the Storage Room with 7 shelves each.",
      parentName: "Storage Room",
      parentLocationId: "storage",
      parentCandidates: [
        {
          id: "storage",
          name: "Storage Room - B442",
          path: "Storage Room - B442",
        },
      ],
      unresolvedParent: false,
      parentResolution: "MATCHED",
      createMissingParent: false,
      nodes,
      source: "DETERMINISTIC",
    });
    renderOrganizePage();
    await user.type(
      await screen.findByRole("textbox"),
      "Create Section A and Section B in the Storage Room with 7 shelves each."
    );
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(await screen.findByText("Storage Room - B442")).toBeInTheDocument();
    expect(
      screen.getByText(/14 locations to create · 2 already exist/)
    ).toBeInTheDocument();
    const proposalRows = screen.getAllByRole("listitem");
    expect(
      proposalRows.some(
        (row) => row.textContent?.includes("Section A (exists)")
      )
    ).toBe(true);
    expect(
      proposalRows.some(
        (row) => row.textContent?.includes("Section B (exists)")
      )
    ).toBe(true);
    expect(
      proposalRows.some((row) => row.textContent?.includes("Shelf A7"))
    ).toBe(true);
    expect(
      proposalRows.some((row) => row.textContent?.includes("Shelf B7"))
    ).toBe(true);
    expect(
      screen.queryByText(/Which location did you mean/)
    ).not.toBeInTheDocument();
    expect(mocks.generateInventoryOrganizationProposal).not.toHaveBeenCalled();
  });

  it("renders proposed shelves with their dependent containers nested beneath them", async () => {
    const user = userEvent.setup();
    const instruction =
      "For each section in the storage room for each shelf create 3 containers. IF Section C doesn't have any shelves create 5 and for each one create 3 containers.";
    mocks.buildLocationStructureProposal.mockResolvedValue({
      mode: "LOCATION_STRUCTURE",
      instruction,
      parentName: "storage room",
      parentLocationId: "storage",
      parentCandidates: [],
      unresolvedParent: false,
      parentResolution: "MATCHED",
      createMissingParent: false,
      nodes: [
        {
          temporaryId: "section-c",
          parentLocationId: "storage",
          parentTemporaryId: null,
          name: "Section C",
          description: null,
          status: "EXISTS",
          existingLocationId: "section-c",
        },
        {
          temporaryId: "shelf-c1",
          parentLocationId: null,
          parentTemporaryId: "section-c",
          name: "Shelf C1",
          description: null,
          status: "CREATE",
          existingLocationId: null,
        },
        {
          temporaryId: "container-c1-1",
          parentLocationId: null,
          parentTemporaryId: "shelf-c1",
          name: "Container C1-1",
          description: null,
          status: "CREATE",
          existingLocationId: null,
        },
      ],
      bulkSummary: {
        sectionsScanned: 1,
        shelvesScanned: 0,
        newShelves: 1,
        existingTargetCount: 0,
        newTargetCount: 1,
        newTargetsUnderExistingShelves: 0,
        totalNewLocations: 2,
        targetLabel: "containers",
        emptySections: [],
        alreadyCompleteShelves: [],
      },
      source: "DETERMINISTIC",
    });
    renderOrganizePage();
    await user.type(await screen.findByRole("textbox"), instruction);
    await user.click(screen.getByRole("button", { name: "Analyze" }));

    expect(await screen.findByText(/Shelf C1/)).toBeInTheDocument();
    const shelfRow = screen.getByText(/Shelf C1/).closest("li");
    const containerRow = screen.getByText(/Container C1-1/).closest("li");
    expect(shelfRow).toHaveAttribute("style", "padding-left: 2.5rem;");
    expect(containerRow).toHaveAttribute("style", "padding-left: 3.75rem;");
    expect(screen.getByText(/New shelves: 1/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create all" })).toBeEnabled();
    expect(
      screen.queryByRole("columnheader", { name: "Product" })
    ).not.toBeInTheDocument();
  });

  it("offers an explicit choice for a typo-like existing location before Create all", async () => {
    const user = userEvent.setup();
    mocks.buildLocationStructureProposal.mockResolvedValue({
      mode: "LOCATION_STRUCTURE",
      instruction: "Create Section A in Storage Room with 1 shelf each.",
      parentName: "Storage Room",
      parentLocationId: "storage",
      parentCandidates: [
        { id: "storage", name: "Storage Room", path: "Storage Room" },
      ],
      unresolvedParent: false,
      parentResolution: "MATCHED",
      createMissingParent: false,
      nodes: [
        {
          temporaryId: "section-a",
          parentLocationId: "storage",
          parentTemporaryId: null,
          name: "Section A",
          description: null,
          status: "POSSIBLE_DUPLICATE",
          existingLocationId: null,
          possibleExistingMatches: [
            { id: "typo", name: "Seciton A", path: "Storage Room / Seciton A" },
          ],
          possibleMatchKind: "TYPO",
          canCreateDespitePossibleMatch: true,
        },
      ],
      source: "DETERMINISTIC",
    });
    renderOrganizePage();
    await user.type(
      await screen.findByRole("textbox"),
      "Create Section A in Storage Room with 1 shelf each."
    );
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(
      await screen.findByText(/Possible existing match: Seciton A/)
    ).toBeInTheDocument();
    const createAll = screen.getByRole("button", { name: "Create all" });
    expect(createAll).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Create Section A" }));
    await waitFor(() => expect(createAll).toBeEnabled());
  });

  it("routes an inventory request to the current-to-suggested proposal UI", async () => {
    const user = userEvent.setup();
    mocks.generateInventoryOrganizationProposal.mockResolvedValue({
      proposalItems: [
        {
          modelId: "model-1",
          productName: "Development Board",
          currentCategoryId: "electronics",
          currentLocationId: "storage",
          categoryId: null,
          locationId: "new-location",
          categoryConfidence: 0.9,
          locationConfidence: 0.9,
          reason: "Fits the board area.",
        },
      ],
      diagnostics: {
        modelsConsidered: 1,
        modelsSentToClaude: 1,
        categoriesSent: 1,
        locationsSent: 1,
        batches: 1,
        requestBytes: 500,
        durationMs: 20,
        helperFailures: 0,
      },
      previewOnly: true,
    });
    renderOrganizePage();
    await user.type(
      await screen.findByRole("textbox"),
      "Find better places for everything in General Electronics."
    );
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    expect(
      await screen.findByRole("heading", { name: "Reorganization proposal" })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "Current location" })
    ).toBeInTheDocument();
    expect(mocks.generateInventoryOrganizationProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: expect.stringContaining("General Electronics"),
      })
    );
    expect(mocks.buildLocationStructureProposal).not.toHaveBeenCalled();
  });

  it("preserves repeated selected model IDs into the inventory placement task", async () => {
    mocks.generateInventoryOrganizationProposal.mockResolvedValue({
      proposalItems: [],
      diagnostics: {
        selectedModelCount: 4,
        modelsConsidered: 4,
        modelsSentToClaude: 4,
        categoriesSent: 3,
        locationsSent: 10,
        candidateLocationCountBeforeRanking: 30,
        candidateLocationCountAfterRanking: 10,
        locationsSentToClaude: 10,
        placementPressure: "USER_REPORTED_HIGH",
        recommendedCount: 2,
        suggestedCount: 2,
        keepCount: 0,
        unresolvedCount: 0,
        reasonCounts: {},
        helperFailures: 0,
        validationRejectedCount: 0,
        requestBytes: 900,
        requiresSelection: false,
        analysisScope: "Exactly 4 selected product models",
        durationMs: 10,
      },
      previewOnly: true,
    });
    renderOrganizePage(
      "/staff/organize?selectedModelId=usb&selectedModelId=arduino&selectedModelId=motor&selectedModelId=smalaa"
    );
    expect(
      await screen.findByText("4 selected products will be analyzed.")
    ).toBeInTheDocument();
    expect(
      screen.getAllByDisplayValue(/usb|arduino|motor|smalaa/)
    ).toHaveLength(4);
    const user = userEvent.setup();
    await user.type(
      screen.getByRole("textbox"),
      "These items are overflowing. Find better locations."
    );
    await user.click(screen.getByRole("button", { name: "Analyze" }));
    await waitFor(() =>
      expect(mocks.generateInventoryOrganizationProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedModelIds: ["usb", "arduino", "motor", "smalaa"],
        })
      )
    );
  });

  it("routes 'Where else could this go?' through inventory placement when a model is selected", async () => {
    mocks.generateInventoryOrganizationProposal.mockResolvedValue({
      proposalItems: [],
      diagnostics: {
        selectedModelCount: 1,
        modelsConsidered: 1,
        modelsSentToClaude: 1,
        categoriesSent: 1,
        locationsSent: 1,
        candidateLocationCountBeforeRanking: 8,
        candidateLocationCountAfterRanking: 1,
        locationsSentToClaude: 1,
        placementPressure: "NORMAL",
        recommendedCount: 0,
        suggestedCount: 0,
        keepCount: 1,
        unresolvedCount: 0,
        reasonCounts: {},
        helperFailures: 0,
        validationRejectedCount: 0,
        requestBytes: 400,
        batches: 1,
        requiresSelection: false,
        analysisScope: "Exactly 1 selected product model",
        durationMs: 10,
      },
      previewOnly: true,
    });
    renderOrganizePage("/staff/organize?selectedModelId=usb");
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("textbox"),
      "Where else could this go?"
    );
    await user.click(screen.getByRole("button", { name: "Analyze" }));

    await waitFor(() =>
      expect(mocks.generateInventoryOrganizationProposal).toHaveBeenCalledWith(
        expect.objectContaining({ selectedModelIds: ["usb"] })
      )
    );
    expect(mocks.buildLocationStructureProposal).not.toHaveBeenCalled();
  });

  it("keeps Create all behind an explicit action and location-create permission", async () => {
    mocks.createLocationStructure.mockResolvedValue({
      createdCount: 1,
      existingCount: 0,
      failedCount: 0,
      results: [],
    });
    const form = new FormData();
    form.set("intent", "create-structure");
    form.set(
      "proposal",
      JSON.stringify({
        instruction: "Create Section A",
        parentLocationId: "storage",
        nodes: [],
      })
    );
    const result = await action(
      createActionArgs({
        request: new Request("http://localhost/staff/organize", {
          method: "POST",
          body: form,
        }),
        context: { getSession: () => ({ userId: "staff-1" }) } as never,
      })
    );
    expect(mocks.requirePermission).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "staff-1" })
    );
    expect(mocks.createLocationStructure).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: "org-1",
        userId: "staff-1",
        proposalInput: expect.objectContaining({ mode: "LOCATION_STRUCTURE" }),
      })
    );
    expect(result).toMatchObject({ kind: "structure-created" });
  });
});

it("keeps unresolved named products visible and submits only a canonical clarification choice", async () => {
  mocks.generateInventoryOrganizationProposal.mockResolvedValue({
    previewOnly: true,
    proposalItems: [],
    diagnostics: {
      recommendedCount: 0,
      suggestedCount: 0,
      keepCount: 0,
      unresolvedCount: 0,
      modelsConsidered: 0,
      modelsSentToClaude: 0,
      selectedModelCount: 0,
      batches: 0,
      placementPressure: "NORMAL",
      analysisScope: "No product uniquely resolved",
    },
    taskPlan: { goal: "Find a better place for Motor." },
    grounding: {
      inventorySelectionMode: "EXPLICIT_PRODUCTS",
      explicitInventoryRefCount: 1,
      resolvedInventoryRefCount: 0,
      unresolvedInventoryRefCount: 1,
      selectedInventoryIdCount: 0,
      currentLocations: [],
      references: [
        {
          reference: { name: "Motor" },
          status: "AMBIGUOUS",
          modelId: null,
          candidates: [
            { id: "motor-a", name: "Motor A" },
            { id: "motor-b", name: "Motor B" },
          ],
        },
      ],
    },
  });
  renderOrganizePage();
  const user = userEvent.setup();
  await user.type(
    await screen.findByRole("textbox"),
    "Find a better place for Motor."
  );
  await user.click(screen.getByRole("button", { name: "Analyze" }));
  expect(await screen.findByText(/Requested products:/)).toHaveTextContent(
    "Resolved: 0"
  );
  await user.selectOptions(
    screen.getByRole("combobox", { name: /Could not uniquely resolve: Motor/ }),
    "motor-b"
  );
  await user.click(
    screen.getByRole("button", { name: "Analyze chosen products" })
  );
  await waitFor(() =>
    expect(
      mocks.generateInventoryOrganizationProposal
    ).toHaveBeenLastCalledWith(
      expect.objectContaining({
        instruction: "Find a better place for Motor.",
        inventoryRefs: [{ name: "Motor" }],
        referenceChoices: { Motor: "motor-b" },
      })
    )
  );
  expect(mocks.createLocationStructure).not.toHaveBeenCalled();
});
