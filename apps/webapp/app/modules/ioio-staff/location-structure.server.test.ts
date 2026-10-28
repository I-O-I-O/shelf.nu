import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  createLocation: vi.fn(),
  requestHelper: vi.fn(),
  assetLocationFindMany: vi.fn(),
  kitFindMany: vi.fn(),
  deleteLocation: vi.fn(),
}));
vi.mock("~/database/db.server", () => ({
  db: {
    location: { findMany: mocks.findMany },
    assetLocation: { findMany: mocks.assetLocationFindMany },
    kit: { findMany: mocks.kitFindMany },
  },
}));
vi.mock("~/modules/location/service.server", () => ({
  createLocation: mocks.createLocation,
  deleteLocation: mocks.deleteLocation,
}));
vi.mock("~/modules/ioio-staff/import-helper-client.server", () => ({
  requestImportHelperProposal: mocks.requestHelper,
}));

import {
  buildLocationStructureProposal,
  classifyOrganizationRequest,
  createLocationStructure,
  deleteApprovedStructureContainers,
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
    mocks.assetLocationFindMany.mockResolvedValue([]);
    mocks.kitFindMany.mockResolvedValue([]);
    mocks.deleteLocation.mockReset();
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
    expect(classifyOrganizationRequest("Ensure Section C has 5 shelves.")).toBe(
      "LOCATION_STRUCTURE"
    );
    expect(
      classifyOrganizationRequest(
        "Find better places for the electronics currently in Section A."
      )
    ).toBe("INVENTORY_REORGANIZATION");
  });

  it("keeps container deletion language in the location-structure domain", () => {
    expect(
      classifyOrganizationRequest(
        "in storage room in section A remove all containers and in section B remove only half of them"
      )
    ).toBe("LOCATION_STRUCTURE");
    expect(
      classifyOrganizationRequest(
        "Find better places for development boards in Section A"
      )
    ).toBe("INVENTORY_REORGANIZATION");
  });

  it("builds deterministic half-deletion review from live structure and blocks occupied containers", async () => {
    const locations: OrganizationLocation[] = [
      {
        id: "room",
        name: "Storage Room - B442",
        parentId: null,
        description: null,
      },
      {
        id: "section-a",
        name: "Section A",
        parentId: "room",
        description: null,
      },
      {
        id: "section-b",
        name: "Section B",
        parentId: "room",
        description: null,
      },
      {
        id: "shelf-a1",
        name: "Shelf A1",
        parentId: "section-a",
        description: null,
      },
      {
        id: "shelf-b1",
        name: "Shelf B1",
        parentId: "section-b",
        description: null,
      },
      ...Array.from({ length: 4 }, (_, index) => ({
        id: `ca-${index + 1}`,
        name: `Container A1-${index + 1}`,
        parentId: "shelf-a1",
        description: null,
      })),
      ...Array.from({ length: 5 }, (_, index) => ({
        id: `cb-${index + 1}`,
        name: `Container B1-${index + 1}`,
        parentId: "shelf-b1",
        description: null,
      })),
    ];
    mocks.findMany.mockResolvedValue(locations);
    mocks.assetLocationFindMany.mockResolvedValue([
      { locationId: "ca-1", quantity: 1 },
    ]);
    mocks.requestHelper.mockResolvedValue({
      status: "ready",
      proposal: {
        mode: "ORGANIZATION_PLAN",
        schemaVersion: 1,
        domain: "LOCATION_STRUCTURE",
        operations: [
          {
            operation: "DELETE_CHILDREN",
            targetRef: {
              name: "Section A",
              ancestorName: "Storage Room - B442",
            },
            childTypeHint: "container",
            quantity: { mode: "ALL" },
          },
          {
            operation: "DELETE_CHILDREN",
            targetRef: {
              name: "Section B",
              ancestorName: "Storage Room - B442",
            },
            childTypeHint: "container",
            quantity: { mode: "FRACTION", numerator: 1, denominator: 2 },
          },
        ],
      },
    });
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "in storage room in section A remove all containers and in section B remove only half of them",
    });
    expect(proposal.deletionReview?.sections[0]).toMatchObject({
      total: 4,
      selected: [{ id: "ca-2" }, { id: "ca-3" }, { id: "ca-4" }],
      blocked: [{ id: "ca-1" }],
    });
    expect(proposal.deletionReview?.sections[1]?.selected).toHaveLength(2);
    expect(proposal.deletionReview?.totalSelected).toBe(5);
    expect(mocks.requestHelper).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "ORGANIZATION_PLAN" })
    );
    expect(mocks.createLocation).not.toHaveBeenCalled();
    expect(mocks.deleteLocation).not.toHaveBeenCalled();
  });

  it.each([0, 2, 5])(
    "never substitutes shelves for %i container targets",
    async (count) => {
      const locations: OrganizationLocation[] = [
        { id: "room", name: "Storage Room", parentId: null, description: null },
        {
          id: "section",
          name: "Section A",
          parentId: "room",
          description: null,
        },
        {
          id: "shelf",
          name: "Shelf A1",
          parentId: "section",
          description: null,
        },
        {
          id: "shelf-2",
          name: "Shelf A2",
          parentId: "section",
          description: null,
        },
        {
          id: "unknown",
          name: "Unlabelled bin",
          parentId: "shelf",
          description: "container",
        },
        {
          id: "drawer",
          name: "Drawer A1-1",
          parentId: "shelf",
          description: null,
        },
        ...Array.from({ length: count }, (_, n) => ({
          id: `c${n}`,
          name: `Container A1-${n + 1}`,
          parentId: "shelf",
          description: null,
        })),
      ];
      mocks.findMany.mockResolvedValue(locations);
      const response = {
        mode: "ORGANIZATION_PLAN",
        schemaVersion: 1,
        domain: "LOCATION_STRUCTURE",
        scope: { ancestorRef: { name: "Storage Room" } },
        operations: [
          {
            operation: "DELETE_CHILDREN",
            targetRef: { name: "Section A" },
            childRole: "CONTAINER",
            quantity: { mode: "ALL" },
          },
        ],
      };
      mocks.requestHelper.mockResolvedValue({
        status: "ready",
        proposal: response,
      });
      const instruction = "remove all containers in Section A";
      const result = await buildLocationStructureProposal({
        organizationId: "org",
        instruction,
      });
      expect(result.deletionReview?.sections[0]?.total).toBe(count);
      expect(result.deletionReview?.totalSelected).toBe(count);
      expect(
        result.deletionReview?.sections[0]?.selected.every(
          ({ name, requestedRole }) =>
            name.startsWith("Container ") && requestedRole === "CONTAINER"
        )
      ).toBe(true);
      response.operations.push({
        ...response.operations[0]!,
        childRole: "DRAWER",
      });
      const mixedRoles = await buildLocationStructureProposal({
        organizationId: "org",
        instruction: "remove all containers and drawers in Section A",
      });
      expect(
        mixedRoles.deletionReview?.sections.map(({ total }) => total)
      ).toEqual([count, 1]);
      response.operations.pop();
      response.operations[0]!.quantity.mode = "FRACTION";
      Object.assign(response.operations[0]!.quantity, {
        numerator: 1,
        denominator: 2,
      });
      const half = await buildLocationStructureProposal({
        organizationId: "org",
        instruction: "remove half of the containers in Section A",
      });
      expect(half.deletionReview?.totalSelected).toBe(Math.floor(count / 2));
      for (const role of ["DRAWER", "SHELF", "SECTION", "ROOM", "UNKNOWN"]) {
        response.operations[0]!.childRole = role;
        const rejected = await buildLocationStructureProposal({
          organizationId: "org",
          instruction,
        });
        expect(rejected.deletionReview).toBeUndefined();
        expect(rejected.nodes).toEqual([]);
      }
      response.operations[0]!.childRole = "CONTAINER";
      response.operations[0]!.targetRef.name = "Shelf A1";
      const wrongScope = await buildLocationStructureProposal({
        organizationId: "org",
        instruction,
      });
      expect(wrongScope.unresolvedParent).toBe(true);
      expect(wrongScope.deletionReview).toBeUndefined();
      expect(mocks.deleteLocation).not.toHaveBeenCalled();
    }
  );

  it("applies only an unchanged reviewed container and blocks a changed scope", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "section", name: "Section A", parentId: null, description: null },
      { id: "shelf", name: "Shelf A1", parentId: "section", description: null },
      {
        id: "target",
        name: "Container A1-1",
        parentId: "shelf",
        description: null,
      },
    ]);
    mocks.deleteLocation.mockResolvedValue({ id: "target" });
    const target = {
      id: "target",
      requestedRole: "CONTAINER",
      sectionId: "section",
      shelfId: "shelf",
      path: "Section A / Shelf A1 / Container A1-1",
    };
    expect(
      await deleteApprovedStructureContainers({
        organizationId: "org",
        targets: [target],
      })
    ).toEqual([{ id: "target", status: "DELETED" }]);
    expect(mocks.deleteLocation).toHaveBeenCalledWith({
      id: "target",
      organizationId: "org",
    });
    mocks.deleteLocation.mockClear();
    const blocked = await deleteApprovedStructureContainers({
      organizationId: "org",
      targets: [{ ...target, sectionId: "another-section" }],
    });
    expect(blocked[0]?.status).toBe("FAILED");
    expect(mocks.deleteLocation).not.toHaveBeenCalled();
  });

  it.each(["Drawer A1-1", "Shelf A1", "Unlabelled bin"])(
    "blocks Apply when a container's role changed to %s",
    async (name) => {
      mocks.findMany.mockResolvedValue([
        { id: "section", name: "Section A", parentId: null, description: null },
        {
          id: "shelf",
          name: "Shelf A1",
          parentId: "section",
          description: null,
        },
        { id: "target", name, parentId: "shelf", description: null },
      ]);
      const result = await deleteApprovedStructureContainers({
        organizationId: "org",
        targets: [
          {
            id: "target",
            requestedRole: "CONTAINER",
            sectionId: "section",
            shelfId: "shelf",
            path: "Section A / Shelf A1 / Container A1-1",
          },
        ],
      });
      expect(result[0]?.status).toBe("FAILED");
      expect(mocks.deleteLocation).not.toHaveBeenCalled();
    }
  );

  it.each(["PLAN", "FIRST_OPERATION", "INSTRUCTION"])(
    "inherits ancestor scope from %s without matching sections in another root",
    async (source) => {
      const locations: OrganizationLocation[] = [
        {
          id: "lab",
          name: "IOIO Lab - B477",
          parentId: null,
          description: null,
        },
        {
          id: "storage",
          name: "Storage Room - B442",
          parentId: null,
          description: null,
        },
        ...["lab", "storage"].flatMap((root) =>
          ["A", "B", "C"].map((letter) => ({
            id: `${root}-${letter}`,
            name:
              root === "lab" && letter === "A"
                ? "Seciton A"
                : `Section ${letter}`,
            parentId: root,
            description: null,
          }))
        ),
        ...["A", "B"].flatMap((letter) => [
          {
            id: `shelf-${letter}`,
            name: `Shelf ${letter}1`,
            parentId: `storage-${letter}`,
            description: null,
          },
          ...[1, 2, 3].map((n) => ({
            id: `container-${letter}-${n}`,
            name: `Container ${letter}1-${n}`,
            parentId: `shelf-${letter}`,
            description: null,
          })),
        ]),
      ];
      mocks.findMany.mockResolvedValue(locations);
      mocks.requestHelper.mockResolvedValue({
        status: "ready",
        proposal: {
          mode: "ORGANIZATION_PLAN",
          schemaVersion: 1,
          domain: "LOCATION_STRUCTURE",
          ...(source === "PLAN"
            ? { scope: { ancestorRef: { name: "Storage Room" } } }
            : {}),
          operations: ["A", "B"].map((letter) => ({
            operation: "DELETE_CHILDREN",
            targetRef: {
              name: `Section ${letter}`,
              ...(source === "FIRST_OPERATION" && letter === "A"
                ? { ancestorName: "Storage Room" }
                : {}),
            },
            childTypeHint: "container",
            quantity:
              letter === "A"
                ? { mode: "ALL" }
                : { mode: "FRACTION", numerator: 1, denominator: 2 },
          })),
        },
      });
      const instruction =
        "in storage room in section A remove all containers and in section B remove only half of them";
      const result = await buildLocationStructureProposal({
        organizationId: "org-1",
        instruction,
      });
      expect(result.unresolvedParent).toBe(false);
      expect(result.deletionReview?.parentPath).toBe("Storage Room - B442");
      expect(
        result.deletionReview?.sections.map(
          (section) => section.selected.length
        )
      ).toEqual([3, 1]);
      expect(JSON.stringify(result.deletionReview)).not.toContain("IOIO Lab");
      expect(
        result.deletionReview?.sections
          .flatMap(({ selected }) => selected)
          .every(
            ({ name, requestedRole }) =>
              name.startsWith("Container ") && requestedRole === "CONTAINER"
          )
      ).toBe(true);
      expect(mocks.deleteLocation).not.toHaveBeenCalled();
      for (const variant of [
        [
          ...locations,
          {
            id: "duplicate",
            name: "Section A",
            parentId: "storage",
            description: null,
          },
        ],
        locations.filter(({ id }) => id !== "storage-A"),
      ]) {
        mocks.findMany.mockResolvedValue(variant);
        const unresolved = await buildLocationStructureProposal({
          organizationId: "org-1",
          instruction,
        });
        expect(unresolved.unresolvedParent).toBe(true);
        expect(
          unresolved.parentCandidates.every(({ path }) =>
            path.startsWith("Storage Room - B442")
          )
        ).toBe(true);
      }
    }
  );

  it.each([
    "remove all containers in Section A",
    "delete every container from Section A",
    "Section A should have no containers",
  ])(
    "uses the same validated structure plan for equivalent wording: %s",
    async (instruction) => {
      mocks.findMany.mockResolvedValue([
        { id: "room", name: "Storage Room", parentId: null, description: null },
        {
          id: "section-a",
          name: "Section A",
          parentId: "room",
          description: null,
        },
        {
          id: "shelf-a1",
          name: "Shelf A1",
          parentId: "section-a",
          description: null,
        },
        {
          id: "container-a1-1",
          name: "Container A1-1",
          parentId: "shelf-a1",
          description: null,
        },
      ]);
      mocks.requestHelper.mockResolvedValue({
        status: "ready",
        proposal: {
          mode: "ORGANIZATION_PLAN",
          schemaVersion: 1,
          domain: "LOCATION_STRUCTURE",
          operations: [
            {
              operation: "DELETE_CHILDREN",
              targetRef: { name: "Section A", ancestorName: "Storage Room" },
              childTypeHint: "container",
              quantity: { mode: "ALL" },
            },
          ],
        },
      });
      const proposal = await buildLocationStructureProposal({
        organizationId: "org-1",
        instruction,
      });
      expect(proposal.deletionReview?.sections).toMatchObject([
        {
          sectionName: "Section A",
          total: 1,
          selected: [{ id: "container-a1-1" }],
        },
      ]);
    }
  );

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

  it("keeps helper-proposed location dependencies parent-first in the review tree", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "room", name: "Storage Room", parentId: null, description: null },
      {
        id: "section-c",
        name: "Section C",
        parentId: "room",
        description: null,
      },
    ]);
    mocks.requestHelper.mockResolvedValue({
      status: "ready",
      proposal: {
        mode: "ORGANIZATION_PLAN",
        schemaVersion: 1,
        domain: "LOCATION_STRUCTURE",
        operations: [
          {
            operation: "CREATE_LOCATION",
            temporaryId: "shelf-c1",
            parentRef: { name: "Section C", ancestorName: "Storage Room" },
            name: "Shelf C1",
            description: null,
          },
          {
            operation: "CREATE_LOCATION",
            temporaryId: "container-c1-1",
            parentTemporaryId: "shelf-c1",
            name: "Container C1-1",
            description: null,
          },
        ],
      },
    });
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction: "Add a shelf and one container in Section C of Storage Room",
    });
    expect(
      proposal.nodes.map(({ name, parentTemporaryId }) => ({
        name,
        parentTemporaryId,
      }))
    ).toEqual([
      { name: "Shelf C1", parentTemporaryId: null },
      { name: "Container C1-1", parentTemporaryId: "plan-0" },
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

  it("plans the compound live instruction with proposed shelves and dependent containers", async () => {
    const storage = {
      id: "storage-live-shaped",
      name: "Storage Room - B442",
      parentId: null,
      description: null,
    };
    const locations: OrganizationLocation[] = [storage];
    for (const sectionLabel of ["A", "B", "C"]) {
      const sectionId = `section-${sectionLabel.toLowerCase()}`;
      locations.push({
        id: sectionId,
        name: `Section ${sectionLabel}`,
        parentId: storage.id,
        description: null,
      });
      if (sectionLabel !== "C") {
        for (let index = 1; index <= 7; index++) {
          locations.push({
            id: `shelf-${sectionLabel.toLowerCase()}${index}`,
            name: `Shelf ${sectionLabel}${index}`,
            parentId: sectionId,
            description: null,
          });
        }
      }
    }
    mocks.findMany.mockResolvedValue(locations);
    const instruction =
      "For each section in the storage room for each shelf create 3 containers. IF Section C doesn't have any shelves create 5 and for each one create 3 containers.";

    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction,
    });

    expect(proposal.source).toBe("DETERMINISTIC");
    expect(proposal.parentLocationId).toBe(storage.id);
    expect(proposal.bulkSummary).toMatchObject({
      sectionsScanned: 3,
      shelvesScanned: 14,
      newShelves: 5,
      existingTargetCount: 0,
      newTargetCount: 57,
      newTargetsUnderExistingShelves: 42,
      totalNewLocations: 62,
      emptySections: [],
    });
    const createdShelves = proposal.nodes.filter(
      (node) => node.status === "CREATE" && node.name.startsWith("Shelf C")
    );
    expect(createdShelves.map(({ name }) => name)).toEqual([
      "Shelf C1",
      "Shelf C2",
      "Shelf C3",
      "Shelf C4",
      "Shelf C5",
    ]);
    for (const shelf of createdShelves) {
      const containers = proposal.nodes.filter(
        (node) => node.parentTemporaryId === shelf.temporaryId
      );
      expect(containers.map(({ name }) => name)).toEqual([
        `Container ${shelf.name.slice("Shelf ".length)}-1`,
        `Container ${shelf.name.slice("Shelf ".length)}-2`,
        `Container ${shelf.name.slice("Shelf ".length)}-3`,
      ]);
      expect(containers.every((node) => node.status === "CREATE")).toBe(true);
    }
    expect(mocks.requestHelper).not.toHaveBeenCalled();
    expect(mocks.createLocation).not.toHaveBeenCalled();
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
  });

  it("treats an if-none shelf condition as false when a shelf already exists", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "storage",
        name: "Storage Room",
        parentId: null,
        description: null,
      },
      {
        id: "section-c",
        name: "Section C",
        parentId: "storage",
        description: null,
      },
      {
        id: "shelf-c1",
        name: "Shelf C1",
        parentId: "section-c",
        description: null,
      },
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "If Section C doesn't have any shelves create 5 and for each one create 3 containers.",
    });
    expect(
      proposal.nodes.filter((node) => node.status === "CREATE")
    ).toHaveLength(0);
    expect(proposal.bulkSummary).toMatchObject({
      shelvesScanned: 1,
      newShelves: 0,
      newTargetCount: 0,
      totalNewLocations: 0,
    });
    expect(mocks.requestHelper).not.toHaveBeenCalled();
  });

  it("ensures a numbered shelf set and its dependent containers", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "storage",
        name: "Storage Room",
        parentId: null,
        description: null,
      },
      {
        id: "section-c",
        name: "Section C",
        parentId: "storage",
        description: null,
      },
      {
        id: "shelf-c1",
        name: "Shelf C1",
        parentId: "section-c",
        description: null,
      },
      {
        id: "shelf-c2",
        name: "Shelf C2",
        parentId: "section-c",
        description: null,
      },
      {
        id: "container-c1-1",
        name: "Container C1-1",
        parentId: "shelf-c1",
        description: null,
      },
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "Ensure Section C has 5 shelves and each shelf has 3 containers.",
    });
    expect(proposal.bulkSummary).toMatchObject({
      shelvesScanned: 2,
      newShelves: 3,
      existingTargetCount: 1,
      newTargetCount: 14,
      totalNewLocations: 17,
    });
    expect(
      proposal.nodes
        .filter(
          (node) => node.name.startsWith("Shelf C") && node.status === "CREATE"
        )
        .map(({ name }) => name)
    ).toEqual(["Shelf C3", "Shelf C4", "Shelf C5"]);
    const shelfC3 = proposal.nodes.find((node) => node.name === "Shelf C3");
    expect(
      proposal.nodes.filter(
        (node) => node.parentTemporaryId === shelfC3?.temporaryId
      )
    ).toHaveLength(3);
    expect(mocks.requestHelper).not.toHaveBeenCalled();
  });

  it("supports ensure-per-shelf and conditional no-container wording", () => {
    expect(
      parseDeterministicBulkLocationStructure(
        "Ensure every shelf in Section A has 5 containers."
      )
    ).toMatchObject({
      parentName: "Section A",
      count: 5,
      itemType: "container",
    });
    expect(
      parseDeterministicBulkLocationStructure(
        "If Shelf A1 has no containers, create 3."
      )
    ).toMatchObject({
      parentName: "Shelf A1",
      shelfCondition: { mode: "IF_NONE", count: 3, itemType: "container" },
    });
    expect(
      parseDeterministicBulkLocationStructure(
        "If Shelf A1 has fewer than 2 containers, ensure 3."
      )
    ).toMatchObject({
      shelfCondition: {
        mode: "IF_FEWER_THAN",
        threshold: 2,
        count: 3,
        itemType: "container",
      },
    });
    expect(
      parseDeterministicBulkLocationStructure(
        "If there are no containers on each shelf in Section A, add 3."
      )
    ).toMatchObject({
      parentName: "Section A",
      shelfCondition: { mode: "IF_NONE", count: 3, itemType: "container" },
    });
    expect(
      parseDeterministicBulkLocationStructure(
        "For every section with no shelves create 4 shelves and add 2 containers to each."
      )
    ).toMatchObject({
      parentName: "",
      sectionShelfRule: {
        mode: "IF_NONE",
        shelfCount: 4,
        childrenPerShelf: { count: 2, itemType: "container" },
      },
    });
    expect(
      parseDeterministicBulkLocationStructure(
        "If Section B has no shelves create 3 shelves, then put 4 containers on each."
      )
    ).toMatchObject({
      parentName: "Section B",
      sectionShelfRule: {
        mode: "IF_NONE",
        shelfCount: 3,
        childrenPerShelf: { count: 4, itemType: "container" },
      },
    });
  });

  it("applies a no-containers condition to a uniquely resolved shelf only", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "section-a", name: "Section A", parentId: null, description: null },
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
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction: "If Shelf A1 has no containers, create 3.",
    });
    expect(proposal.parentLocationId).toBe("shelf-a1");
    expect(
      proposal.nodes
        .filter((node) => node.status === "CREATE")
        .map(({ name }) => name)
    ).toEqual(["Container A1-1", "Container A1-2", "Container A1-3"]);
    expect(proposal.nodes.some(({ name }) => name === "Shelf A2")).toBe(false);
    expect(mocks.requestHelper).not.toHaveBeenCalled();
  });

  it("fills only missing numbered containers when a shelf is below a minimum threshold", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "section-a", name: "Section A", parentId: null, description: null },
      {
        id: "shelf-a1",
        name: "Shelf A1",
        parentId: "section-a",
        description: null,
      },
      {
        id: "container-a1-1",
        name: "Container A1-1",
        parentId: "shelf-a1",
        description: null,
      },
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction: "If Shelf A1 has fewer than 2 containers, ensure 3.",
    });
    expect(
      proposal.nodes
        .filter((node) => node.status === "CREATE")
        .map(({ name }) => name)
    ).toEqual(["Container A1-2", "Container A1-3"]);
    expect(proposal.bulkSummary).toMatchObject({
      existingTargetCount: 1,
      newTargetCount: 2,
      totalNewLocations: 2,
    });
  });

  it("applies a no-containers-per-shelf condition only to empty shelves in scope", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "section-a", name: "Section A", parentId: null, description: null },
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
        id: "container-a1-1",
        name: "Container A1-1",
        parentId: "shelf-a1",
        description: null,
      },
    ]);
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "If there are no containers on each shelf in Section A, add 3.",
    });
    expect(
      proposal.nodes
        .filter((node) => node.status === "CREATE")
        .map(({ name }) => name)
    ).toEqual(["Container A2-1", "Container A2-2", "Container A2-3"]);
    expect(proposal.parentLocationId).toBe("section-a");
    expect(mocks.requestHelper).not.toHaveBeenCalled();
  });

  it("reruns a completed conditional shelf plan without proposing duplicates", async () => {
    const locations: OrganizationLocation[] = [
      { id: "section-c", name: "Section C", parentId: null, description: null },
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
    const instruction =
      "If Section C doesn't have any shelves create 2 and for each one create 2 containers.";
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction,
    });
    const created = await createLocationStructure({
      organizationId: "org-1",
      userId: "staff-1",
      proposalInput: {
        mode: proposal.mode,
        instruction: proposal.instruction,
        parentLocationId: proposal.parentLocationId,
        nodes: proposal.nodes,
      },
    });
    expect(created).toMatchObject({
      createdCount: 6,
      failedCount: 0,
      blockedCount: 0,
    });
    const rerun = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction,
    });
    expect(
      rerun.nodes.filter(({ status }) => status === "CREATE")
    ).toHaveLength(0);
    expect(rerun.bulkSummary?.totalNewLocations).toBe(0);
  });

  it("resolves proposed parent IDs before creating dependent children and blocks only a failed branch", async () => {
    const locations: OrganizationLocation[] = [
      { id: "section-c", name: "Section C", parentId: null, description: null },
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
        if (input.name === "Shelf C2")
          return Promise.reject(new Error("simulated shelf failure"));
        const created = {
          id: `db-${input.name}`,
          name: input.name,
          parentId: input.parentId ?? null,
          description: input.description,
        };
        locations.push(created);
        return Promise.resolve(created);
      }
    );
    const proposal = await buildLocationStructureProposal({
      organizationId: "org-1",
      instruction:
        "If Section C doesn't have any shelves create 3 and for each one create 2 containers.",
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
    expect(mocks.createLocation).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Container C1-1",
        parentId: "db-Shelf C1",
      })
    );
    expect(
      result.results
        .filter((entry) => entry.status === "BLOCKED")
        .map(({ name }) => name)
    ).toEqual(["Container C2-1", "Container C2-2"]);
    expect(result.results.find(({ name }) => name === "Shelf C2")?.status).toBe(
      "FAILED"
    );
    expect(result.results.find(({ name }) => name === "Shelf C3")?.status).toBe(
      "CREATED"
    );
    expect(result.blockedCount).toBe(2);
    expect(mocks.requestHelper).not.toHaveBeenCalled();
  });
});
