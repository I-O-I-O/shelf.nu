import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  createLocation: vi.fn(),
  requestHelper: vi.fn(),
}));
vi.mock("~/database/db.server", () => ({
  db: { location: { findMany: mocks.findMany } },
}));
vi.mock("~/modules/location/service.server", () => ({
  createLocation: mocks.createLocation,
}));
vi.mock("~/modules/ioio-staff/import-helper-client.server", () => ({
  requestImportHelperProposal: mocks.requestHelper,
}));

import {
  buildLocationStructureProposal,
  classifyOrganizationRequest,
  createLocationStructure,
  parseDeterministicLocationStructure,
} from "./location-structure.server";

const locationFixture = [
  { id: "storage", name: "Storage Room", parentId: null, description: null },
  {
    id: "section-a",
    name: "Section A",
    parentId: "storage",
    description: null,
  },
  {
    id: "shelf-a1",
    name: "Shelf A1",
    parentId: "section-a",
    description: null,
  },
  {
    id: "shelf-a2",
    name: "Shelf A2",
    parentId: "section-a",
    description: null,
  },
  {
    id: "shelf-a3",
    name: "Shelf A3",
    parentId: "section-a",
    description: null,
  },
  {
    id: "shelf-a1-ref",
    name: "Shelf A1",
    parentId: "storage",
    description: null,
  },
];

describe("location structure planning", () => {
  beforeEach(() => {
    mocks.findMany.mockResolvedValue(locationFixture.slice(0, 1));
    mocks.requestHelper.mockReset();
    mocks.createLocation.mockReset();
  });

  it("classifies the three requested examples into separate workflows", () => {
    expect(
      classifyOrganizationRequest(
        "Create Section A and Section B in the Storage Room with 7 shelves each."
      )
    ).toBe("LOCATION_STRUCTURE");
    expect(classifyOrganizationRequest("Add 3 containers to Shelf A1.")).toBe(
      "LOCATION_STRUCTURE"
    );
    expect(
      classifyOrganizationRequest(
        "Find better places for the electronics currently in Section A."
      )
    ).toBe("INVENTORY_REORGANIZATION");
  });

  it("expands the first acceptance instruction to two sections and fourteen shelves", () => {
    const parsed = parseDeterministicLocationStructure(
      "Create Section A and Section B in the Storage Room with 7 shelves each."
    );
    expect(parsed?.parentName).toBe("Storage Room");
    expect(parsed?.descriptors).toHaveLength(16);
    expect(parsed?.descriptors.map(({ name }) => name)).toEqual([
      "Section A",
      "Shelf A1",
      "Shelf A2",
      "Shelf A3",
      "Shelf A4",
      "Shelf A5",
      "Shelf A6",
      "Shelf A7",
      "Section B",
      "Shelf B1",
      "Shelf B2",
      "Shelf B3",
      "Shelf B4",
      "Shelf B5",
      "Shelf B6",
      "Shelf B7",
    ]);
  });

  it("builds the exact acceptance proposal without consulting inventory or calling Claude", async () => {
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and Section B in the Storage Room with 7 shelves each.",
    });
    expect(proposal.nodes.map(({ name }) => name)).toEqual([
      "Section A",
      "Shelf A1",
      "Shelf A2",
      "Shelf A3",
      "Shelf A4",
      "Shelf A5",
      "Shelf A6",
      "Shelf A7",
      "Section B",
      "Shelf B1",
      "Shelf B2",
      "Shelf B3",
      "Shelf B4",
      "Shelf B5",
      "Shelf B6",
      "Shelf B7",
    ]);
    expect(proposal.nodes.every(({ status }) => status === "CREATE")).toBe(
      true
    );
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.requestHelper).not.toHaveBeenCalled();
    expect(mocks.createLocation).not.toHaveBeenCalled();
  });

  it("expands three containers beneath Shelf A1", () => {
    const parsed = parseDeterministicLocationStructure(
      "Add 3 containers to Shelf A1."
    );
    expect(parsed?.parentName).toBe("Shelf A1");
    expect(parsed?.descriptors.map(({ name }) => name)).toEqual([
      "Container A1-1",
      "Container A1-2",
      "Container A1-3",
    ]);
  });

  it("proposes the three requested containers under the resolved Shelf A1", async () => {
    mocks.findMany.mockResolvedValue([
      ...locationFixture.slice(0, 1),
      {
        id: "shelf-a1",
        name: "Shelf A1",
        parentId: "storage",
        description: null,
      },
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction: "Add 3 containers to Shelf A1.",
    });
    expect(proposal.parentLocationId).toBe("shelf-a1");
    expect(proposal.nodes.map(({ name }) => name)).toEqual([
      "Container A1-1",
      "Container A1-2",
      "Container A1-3",
    ]);
    expect(mocks.requestHelper).not.toHaveBeenCalled();
  });

  it("resolves a unique parent and reuses existing sections and shelves", async () => {
    mocks.findMany.mockResolvedValue(locationFixture);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and Section B in the Storage Room with 7 shelves each.",
    });
    expect(proposal.parentLocationId).toBe("storage");
    expect(
      proposal.nodes.find((node) => node.name === "Section A")?.status
    ).toBe("EXISTS");
    expect(
      proposal.nodes.find((node) => node.name === "Shelf A1")?.status
    ).toBe("EXISTS");
    expect(
      proposal.nodes.filter((node) => node.status === "CREATE")
    ).toHaveLength(12);
    expect(mocks.requestHelper).not.toHaveBeenCalled();
  });

  it("does not guess when a parent name matches more than one location", async () => {
    mocks.findMany.mockResolvedValue([
      ...locationFixture,
      {
        id: "storage-2",
        name: "Storage Room",
        parentId: null,
        description: null,
      },
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and Section B in the Storage Room with 7 shelves each.",
    });
    expect(proposal.unresolvedParent).toBe(true);
    expect(proposal.parentCandidates).toHaveLength(2);
    expect(proposal.nodes).toHaveLength(0);
  });

  it("requires a valid organization parent before creating anything", async () => {
    mocks.findMany.mockResolvedValue(locationFixture.slice(0, 1));
    await expect(
      createLocationStructure({
        organizationId: "org-1",
        userId: "staff-1",
        proposalInput: {
          mode: "LOCATION_STRUCTURE",
          instruction: "test",
          parentLocationId: "other-org-id",
          nodes: [],
        },
      })
    ).rejects.toThrow(/no longer available/);
    await expect(
      createLocationStructure({
        organizationId: "org-1",
        userId: "staff-1",
        proposalInput: {
          mode: "LOCATION_STRUCTURE",
          instruction: "test",
          parentLocationId: "storage",
          nodes: [
            {
              temporaryId: "x",
              parentLocationId: "other-org-id",
              parentTemporaryId: null,
              name: "Child",
              description: null,
              status: "CREATE",
              existingLocationId: null,
            },
          ],
        },
      })
    ).resolves.toMatchObject({ failedCount: 1 });
    expect(mocks.createLocation).not.toHaveBeenCalled();
  });

  it("creates approved locations parent-first through Shelf's canonical service", async () => {
    mocks.findMany.mockResolvedValue(locationFixture.slice(0, 1));
    mocks.createLocation.mockImplementation(
      (input: {
        name: string;
        parentId?: string | null;
        description: string;
      }) =>
        Promise.resolve({
          id: `created-${input.name}`,
          name: input.name,
          parentId: input.parentId ?? null,
          description: input.description,
        })
    );
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction: "Create Sensors section with 2 shelves in the Storage Room.",
    });
    const result = await createLocationStructure({
      organizationId: "org-1",
      userId: "staff-1",
      proposalInput: {
        mode: proposal.mode,
        instruction: proposal.instruction,
        parentLocationId: proposal.parentLocationId,
        nodes: proposal.nodes,
      },
    });
    expect(mocks.createLocation.mock.calls.map(([call]) => call.name)).toEqual([
      "Sensors section",
      "Shelf 1",
      "Shelf 2",
    ]);
    expect(
      mocks.createLocation.mock.calls.map(([call]) => call.parentId)
    ).toEqual([
      "storage",
      "created-Sensors section",
      "created-Sensors section",
    ]);
    expect(result).toMatchObject({
      createdCount: 3,
      existingCount: 0,
      failedCount: 0,
    });
  });
});
