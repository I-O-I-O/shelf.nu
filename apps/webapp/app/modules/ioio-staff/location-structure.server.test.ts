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
  type OrganizationLocation,
  parseDeterministicBulkLocationStructure,
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

  it("resolves the live-shaped Storage Room root and reuses only its Section A/B", async () => {
    const storageRoomId = "cmvf79s5i0009xmzlmbmq9zn8";
    const storageSectionAId = "cmvf8rbvx0010xmzlf0caamif";
    const storageSectionBId = "cmvf8riqe0013xmzl4bugjo7a";
    mocks.findMany.mockResolvedValue([
      {
        id: "cmv6f933x0002xm6w0h6d5439",
        name: "IOIO Lab - B477",
        parentId: null,
        description: null,
      },
      {
        id: "cmv6muufm001zxm6wcn519116",
        name: "Seciton A",
        parentId: "cmv6f933x0002xm6w0h6d5439",
        description: null,
      },
      {
        id: storageRoomId,
        name: "Storage Room - B442",
        parentId: null,
        description: null,
      },
      {
        id: storageSectionAId,
        name: "Section A",
        parentId: storageRoomId,
        description: null,
      },
      {
        id: storageSectionBId,
        name: "Section B",
        parentId: storageRoomId,
        description: null,
      },
      {
        id: "section-c-storage",
        name: "Section C",
        parentId: storageRoomId,
        description: null,
      },
    ]);

    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and Section B in the Storage Room with 7 shelves each.",
    });

    expect(proposal.parentLocationId).toBe(storageRoomId);
    expect(proposal.parentCandidates).toEqual([
      expect.objectContaining({
        id: storageRoomId,
        name: "Storage Room - B442",
      }),
    ]);
    expect(proposal.unresolvedParent).toBe(false);
    expect(proposal.nodes).toHaveLength(16);
    expect(
      proposal.nodes.filter((node) => node.status === "EXISTS")
    ).toMatchObject([
      { name: "Section A", existingLocationId: storageSectionAId },
      { name: "Section B", existingLocationId: storageSectionBId },
    ]);
    expect(
      proposal.nodes
        .filter((node) => node.status === "CREATE")
        .map(({ name }) => name)
    ).toEqual([
      "Shelf A1",
      "Shelf A2",
      "Shelf A3",
      "Shelf A4",
      "Shelf A5",
      "Shelf A6",
      "Shelf A7",
      "Shelf B1",
      "Shelf B2",
      "Shelf B3",
      "Shelf B4",
      "Shelf B5",
      "Shelf B6",
      "Shelf B7",
    ]);
    expect(
      proposal.nodes
        .filter((node) => node.name.startsWith("Shelf A"))
        .every((node) => node.parentTemporaryId === "section-a")
    ).toBe(true);
    expect(
      proposal.nodes
        .filter((node) => node.name.startsWith("Shelf B"))
        .every((node) => node.parentTemporaryId === "section-b")
    ).toBe(true);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.requestHelper).not.toHaveBeenCalled();
    expect(mocks.createLocation).not.toHaveBeenCalled();
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

  it("resolves parent names case-insensitively, with punctuation and unique partial matches", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "root",
        name: "IOIO Lab - B477",
        parentId: null,
        description: null,
      },
      {
        id: "store",
        name: "Main Storage",
        parentId: "root",
        description: null,
      },
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and B in the storage room with 1 shelf each.",
    });
    expect(proposal.parentLocationId).toBe("store");
    expect(proposal.parentCandidates[0]?.path).toBe(
      "IOIO Lab - B477 / Main Storage"
    );
    expect(mocks.requestHelper).not.toHaveBeenCalled();
  });

  it("prefers case-insensitive exact and normalized parent matches", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "lower", name: "storage room", parentId: null, description: null },
    ]);
    const caseInsensitive = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and Section B in the Storage Room with 1 shelf each.",
    });
    expect(caseInsensitive.parentLocationId).toBe("lower");
    mocks.findMany.mockResolvedValue([
      { id: "hyphen", name: "Storage-Room", parentId: null, description: null },
    ]);
    const normalized = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and Section B in the Storage Room with 1 shelf each.",
    });
    expect(normalized.parentLocationId).toBe("hyphen");
  });

  it("resolves a full path parent and surfaces ambiguous semantic matches", async () => {
    const locations: OrganizationLocation[] = [
      {
        id: "root",
        name: "IOIO Lab - B477",
        parentId: null,
        description: null,
      },
      {
        id: "storage",
        name: "Electronics Storage",
        parentId: "root",
        description: null,
      },
      { id: "other-root", name: "Annex", parentId: null, description: null },
      {
        id: "storage2",
        name: "Workshop Storage",
        parentId: "other-root",
        description: null,
      },
    ];
    mocks.findMany.mockResolvedValue(locations);
    const byPath = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and B in IOIO Lab - B477 / Electronics Storage with 1 shelf each.",
    });
    expect(byPath.parentLocationId).toBe("storage");
    const ambiguous = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and B in the Storage Room with 1 shelf each.",
    });
    expect(ambiguous.unresolvedParent).toBe(true);
    expect(ambiguous.parentCandidates).toHaveLength(2);
  });

  it("proposes a missing Storage Room beneath the one current root", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "root",
        name: "IOIO Lab - B477",
        parentId: null,
        description: null,
      },
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and Section B in the Storage Room with 7 shelves each.",
    });
    expect(proposal.parentResolution).toBe("CREATE_PARENT");
    expect(proposal.createMissingParent).toBe(true);
    expect(proposal.parentLocationId).toBe("root");
    expect(proposal.nodes).toHaveLength(17);
    expect(proposal.nodes[0]).toMatchObject({
      name: "Storage Room",
      status: "CREATE",
    });
    expect(proposal.nodes[1]).toMatchObject({
      name: "Section A",
      parentTemporaryId: proposal.nodes[0]?.temporaryId,
    });
    expect(mocks.requestHelper).not.toHaveBeenCalled();
  });

  it("asks staff to choose between roots when a requested parent is missing", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "root-a",
        name: "IOIO Lab - B477",
        parentId: null,
        description: null,
      },
      { id: "root-b", name: "Annex", parentId: null, description: null },
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and B in the Storage Room with 1 shelf each.",
    });
    expect(proposal.unresolvedParent).toBe(true);
    expect(proposal.parentResolution).toBe("AMBIGUOUS_ROOT");
    expect(proposal.parentCandidates.map(({ id }) => id)).toEqual([
      "root-a",
      "root-b",
    ]);
    const selected = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Create Section A and B in the Storage Room with 1 shelf each.",
      selectedParentId: "root-b",
    });
    expect(selected.createMissingParent).toBe(true);
    expect(selected.parentLocationId).toBe("root-b");
  });

  it("flags typo-equivalent Section A without silently reusing or creating it", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "root",
        name: "IOIO Lab - B477",
        parentId: null,
        description: null,
      },
      { id: "storage", name: "Storage", parentId: "root", description: null },
      { id: "typo", name: "Seciton A", parentId: "storage", description: null },
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction: "Create Section A and B in Storage with 1 shelf each.",
    });
    expect(proposal.nodes[0]).toMatchObject({
      name: "Section A",
      status: "POSSIBLE_DUPLICATE",
      possibleMatchKind: "TYPO",
      canCreateDespitePossibleMatch: true,
    });
    expect(proposal.nodes[0]?.possibleExistingMatches?.[0]?.name).toBe(
      "Seciton A"
    );
    await expect(
      createLocationStructure({
        organizationId: "org-1",
        userId: "staff-1",
        proposalInput: {
          mode: proposal.mode,
          instruction: proposal.instruction,
          parentLocationId: proposal.parentLocationId,
          nodes: proposal.nodes.map((node) => ({ ...node, status: "REVIEW" })),
        },
      })
    ).rejects.toThrow(/Resolve possible existing location matches/);
    expect(mocks.createLocation).not.toHaveBeenCalled();
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

  it.each([
    [
      "For each section in the storage room for each shelf create 3 containers.",
      "storage room",
      true,
      3,
      "container",
    ],
    [
      "For every shelf in Section A add 2 containers.",
      "Section A",
      false,
      2,
      "container",
    ],
    [
      "Add 4 drawers to every shelf in Section B.",
      "Section B",
      false,
      4,
      "drawer",
    ],
    [
      "Create 3 containers under each shelf in Storage Room.",
      "Storage Room",
      false,
      3,
      "container",
    ],
  ] as const)(
    "parses bulk instruction %s",
    (instruction, parentName, sectionsThenShelves, count, itemType) => {
      expect(parseDeterministicBulkLocationStructure(instruction)).toEqual({
        parentName,
        sectionsThenShelves,
        count,
        itemType,
      });
    }
  );

  it("expands storage-room sections without traversing unrelated roots or calling AI", async () => {
    const locations = [
      {
        id: "storage",
        name: "Storage Room - B442",
        parentId: null,
        description: null,
      },
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
        id: "section-b",
        name: "Section B",
        parentId: "storage",
        description: null,
      },
      {
        id: "shelf-b1",
        name: "Shelf B1",
        parentId: "section-b",
        description: null,
      },
      {
        id: "section-c",
        name: "Section C",
        parentId: "storage",
        description: null,
      },
      {
        id: "other-root",
        name: "IOIO Lab - B477",
        parentId: null,
        description: null,
      },
      {
        id: "other-typo-section",
        name: "Seciton A",
        parentId: "other-root",
        description: null,
      },
      {
        id: "other-shelf",
        name: "Shelf A1",
        parentId: "other-typo-section",
        description: null,
      },
    ];
    mocks.findMany.mockResolvedValue(locations);

    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "For each section in the storage room for each shelf create 3 containers.",
    });

    expect(proposal.parentLocationId).toBe("storage");
    expect(proposal.source).toBe("DETERMINISTIC");
    expect(proposal.bulkSummary).toMatchObject({
      sectionsScanned: 3,
      shelvesScanned: 3,
      existingTargetCount: 0,
      newTargetCount: 9,
      emptySections: ["Section C"],
    });
    expect(
      proposal.nodes
        .filter(({ status }) => status === "CREATE")
        .map(({ name }) => name)
    ).toEqual([
      "Container A1-1",
      "Container A1-2",
      "Container A1-3",
      "Container A2-1",
      "Container A2-2",
      "Container A2-3",
      "Container B1-1",
      "Container B1-2",
      "Container B1-3",
    ]);
    expect(
      proposal.nodes.some(
        ({ existingLocationId }) => existingLocationId === "other-shelf"
      )
    ).toBe(false);
    expect(
      proposal.nodes.find(({ name }) => name === "Section C")?.reviewNote
    ).toMatch(/No shelves found/);
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    expect(mocks.requestHelper).not.toHaveBeenCalled();
    expect(mocks.createLocation).not.toHaveBeenCalled();
  });

  it("proposes only the missing exact numbered container and does not count nested suffixes", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "storage",
        name: "Storage Room",
        parentId: null,
        description: null,
      },
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
        id: "container-1",
        name: "Container A1-1",
        parentId: "shelf-a1",
        description: null,
      },
      {
        id: "container-1-1",
        name: "Container A1-1.1",
        parentId: "shelf-a1",
        description: null,
      },
      {
        id: "container-2",
        name: "Container A1-2",
        parentId: "shelf-a1",
        description: null,
      },
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction: "For every shelf in Storage Room add 3 containers.",
    });
    expect(proposal.bulkSummary).toMatchObject({
      existingTargetCount: 2,
      newTargetCount: 1,
      alreadyCompleteShelves: [],
    });
    expect(
      proposal.nodes
        .filter(({ status }) => status === "CREATE")
        .map(({ name }) => name)
    ).toEqual(["Container A1-3"]);
    expect(
      proposal.nodes.find(({ name }) => name === "Container A1-1.1")?.status
    ).toBe("EXISTS");
  });

  it("marks a fully numbered shelf complete without proposing duplicate children", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "storage",
        name: "Storage Room",
        parentId: null,
        description: null,
      },
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
      ...[1, 2, 3].map((number) => ({
        id: `container-${number}`,
        name: `Container A1-${number}`,
        parentId: "shelf-a1",
        description: null,
      })),
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction: "For every shelf in Storage Room add 3 containers.",
    });
    expect(proposal.bulkSummary).toMatchObject({
      newTargetCount: 0,
      alreadyCompleteShelves: ["Storage Room / Section A / Shelf A1"],
    });
    expect(
      proposal.nodes.filter(({ status }) => status === "CREATE")
    ).toHaveLength(0);
  });

  it("creates only missing containers through Shelf and reruns as a no-op", async () => {
    const locations: OrganizationLocation[] = [
      {
        id: "storage",
        name: "Storage Room",
        parentId: null,
        description: null,
      },
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
        id: "container-1",
        name: "Container A1-1",
        parentId: "shelf-a1",
        description: null,
      },
      {
        id: "container-2",
        name: "Container A1-2",
        parentId: "shelf-a1",
        description: null,
      },
    ];
    mocks.findMany.mockImplementation(() =>
      Promise.resolve(locations.map((location) => ({ ...location })))
    );
    mocks.createLocation.mockImplementation(
      (input: {
        name: string;
        parentId?: string | null;
        description: string;
      }) => {
        const created = {
          id: `created-${input.name}`,
          name: input.name,
          parentId: input.parentId ?? null,
          description: input.description,
        };
        locations.push(created);
        return Promise.resolve(created);
      }
    );
    const instruction = "For every shelf in Storage Room add 3 containers.";
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction,
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
    expect(mocks.createLocation).toHaveBeenCalledTimes(1);
    expect(mocks.createLocation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Container A1-3",
        parentId: "shelf-a1",
        organizationId: "org-1",
        userId: "staff-1",
      })
    );
    expect(result).toMatchObject({ createdCount: 1, failedCount: 0 });

    const rerun = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction,
    });
    expect(rerun.bulkSummary?.newTargetCount).toBe(0);
    expect(
      rerun.nodes.filter(({ status }) => status === "CREATE")
    ).toHaveLength(0);
  });

  it("returns available live roots when the ambiguous helper fallback is unavailable", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "storage",
        name: "Storage Room",
        parentId: null,
        description: null,
      },
      { id: "shelf", name: "Shelf A1", parentId: "storage", description: null },
    ]);
    mocks.requestHelper.mockResolvedValue({
      status: "manual",
      reason: "network_error",
    });
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction: "Make a sensible storage layout for the storage room.",
    });
    expect(proposal.helperUnavailable).toBe(true);
    expect(proposal.parentCandidates).toEqual([
      { id: "storage", name: "Storage Room", path: "Storage Room" },
    ]);
    expect(proposal.parentResolution).toBe("UNRESOLVED");
  });
});
