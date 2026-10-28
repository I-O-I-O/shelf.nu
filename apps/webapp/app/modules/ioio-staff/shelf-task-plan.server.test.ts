import { describe, expect, it } from "vitest";
import {
  resolveTaskSteps,
  shelfTaskSourceSchema,
  validateShelfTaskPlan,
  type ShelfTaskPlan,
} from "./shelf-task-plan.server";

const locations = [
  { id: "lab", name: "IOIO Lab - B477", parentId: null },
  { id: "lab-b", name: "Section B", parentId: "lab" },
  { id: "storage", name: "Storage Room - B442", parentId: null },
  { id: "storage-b", name: "Section B", parentId: "storage" },
];
const deletionPlan = (): ShelfTaskPlan => ({
  taskType: "STRUCTURE_CHANGE",
  goal: "Remove containers",
  sources: [{ type: "SHELF_LOCATIONS" }],
  steps: [
    {
      id: "section",
      capability: "RESOLVE_LOCATION",
      ref: { name: "Section B", withinRef: { name: "Storage Room" } },
    },
    {
      id: "containers",
      capability: "SELECT_LOCATIONS",
      within: "section",
      role: "CONTAINER",
    },
    {
      id: "delete",
      capability: "PROPOSE_DELETE_LOCATIONS",
      selection: "containers",
      quantity: { mode: "ALL" },
    },
  ],
  writesRequested: true,
  mutationPolicy: "PROPOSAL_ONLY",
  expectedOutput: "LOCATION_PROPOSAL",
});

describe("Shelf task authority boundary", () => {
  it("resolves nested and step-based references to the same canonical location", () => {
    const nested = resolveTaskSteps(deletionPlan(), locations);
    const steps = deletionPlan();
    steps.steps.splice(
      0,
      1,
      {
        id: "scope",
        capability: "RESOLVE_LOCATION",
        ref: { name: "Storage Room" },
      },
      {
        id: "section",
        capability: "RESOLVE_LOCATION",
        ref: { name: "Section B" },
        within: "scope",
      }
    );
    expect(nested.resolved.get("section")).toBe("storage-b");
    const aliased = deletionPlan();
    if (aliased.steps[0]!.capability === "RESOLVE_LOCATION")
      aliased.steps[0]!.ref.withinRef = { name: "storage" };
    expect(resolveTaskSteps(aliased, locations).resolved.get("section")).toBe(
      "storage-b"
    );
    const duplicates = [
      ...locations,
      { id: "duplicate", name: "Section B", parentId: "storage" },
    ];
    expect(
      resolveTaskSteps(deletionPlan(), duplicates, "duplicate").resolved.get(
        "section"
      )
    ).toBe("duplicate");
    expect(
      resolveTaskSteps(deletionPlan(), duplicates, "lab-b").unresolved
    ).toHaveLength(1);

    expect(resolveTaskSteps(steps, locations).resolved.get("section")).toBe(
      "storage-b"
    );
    expect(
      resolveTaskSteps(
        deletionPlan(),
        locations.filter(({ id }) => id !== "storage-b")
      ).unresolved
    ).toHaveLength(1);
    expect(
      resolveTaskSteps(deletionPlan(), [
        ...locations,
        { id: "duplicate", name: "Section B", parentId: "storage" },
      ]).unresolved
    ).toHaveLength(1);
  });
  it("rejects unsupported capabilities, dependency cycles, incompatible sources and mutation policies", () => {
    const plan = deletionPlan();
    expect(() =>
      validateShelfTaskPlan({
        ...plan,
        steps: [{ id: "sql", capability: "RUN_SQL" }],
      })
    ).toThrow();
    expect(() =>
      validateShelfTaskPlan({ ...plan, steps: [...plan.steps].reverse() })
    ).toThrow();
    expect(() =>
      validateShelfTaskPlan({ ...plan, sources: [{ type: "SHELF_INVENTORY" }] })
    ).toThrow();
    expect(() =>
      validateShelfTaskPlan({
        ...plan,
        taskType: "ANALYSIS",
        writesRequested: false,
      })
    ).toThrow();
    expect(() =>
      validateShelfTaskPlan({ ...plan, mutationPolicy: "APPLY" })
    ).toThrow();
    for (const role of ["UNKNOWN", "SHELF", "SECTION"]) {
      const changed = structuredClone(plan);
      Object.assign(changed.steps[1]!, { role });
      expect(() => validateShelfTaskPlan(changed)).toThrow();
    }
  });
  it("represents a safely uploaded table as a source without enabling file execution", () => {
    expect(
      shelfTaskSourceSchema.parse({
        type: "UPLOADED_FILE",
        fileType: "XLSX",
        sourceRef: "uploadedTable",
      })
    ).toEqual({
      type: "UPLOADED_FILE",
      fileType: "XLSX",
      sourceRef: "uploadedTable",
    });
    expect(() =>
      validateShelfTaskPlan({
        ...deletionPlan(),
        sources: [
          { type: "SHELF_LOCATIONS" },
          { type: "UPLOADED_FILE", fileType: "CSV", sourceRef: "table" },
        ],
      })
    ).toThrow(/not supported/);
  });
});
