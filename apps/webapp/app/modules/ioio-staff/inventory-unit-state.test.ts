import { describe, expect, it } from "vitest";
import { getIoioPhysicalUnitState } from "./inventory-unit-state";

describe("IOIO physical inventory state", () => {
  const available = {
    assetStatus: "AVAILABLE",
    availableToBook: true,
    bookingStates: [],
    preparationStates: [],
    issueReportTypes: [],
    availableAccordingToIoioInventory: true,
  };

  it("uses one effective state for parent counts and physical-unit badges", () => {
    const units = [
      { label: "#001", input: available },
      {
        label: "#002",
        input: {
          ...available,
          preparationStates: ["READY_FOR_PICKUP"],
          availableAccordingToIoioInventory: false,
        },
      },
      {
        label: "#003",
        input: {
          ...available,
          assetStatus: "CHECKED_OUT",
          bookingStates: [{ status: "ONGOING", isSoftStaffReservation: false }],
          availableAccordingToIoioInventory: false,
        },
      },
      { label: "#004", input: available },
      { label: "#005", input: available },
    ];
    const states = units.map(({ label, input }) => ({
      label,
      status: getIoioPhysicalUnitState(input),
    }));

    expect(states).toEqual([
      { label: "#001", status: "Available" },
      { label: "#002", status: "Ready for pickup" },
      { label: "#003", status: "In use" },
      { label: "#004", status: "Available" },
      { label: "#005", status: "Available" },
    ]);
    expect(states.filter(({ status }) => status === "Available")).toHaveLength(
      3
    );
  });

  it("shows two reserved preparation bookings as two preparing units and three available", () => {
    const states = ["001", "002", "003", "004", "005"].map((id) =>
      getIoioPhysicalUnitState({
        ...available,
        bookingStates: ["004", "005"].includes(id)
          ? [{ status: "RESERVED", isSoftStaffReservation: false }]
          : [],
        preparationStates: ["004", "005"].includes(id)
          ? ["PENDING_PREPARATION"]
          : [],
        availableAccordingToIoioInventory: !["004", "005"].includes(id),
      })
    );

    expect(states.filter((state) => state === "Available")).toHaveLength(3);
    expect(states.filter((state) => state === "In preparation")).toHaveLength(
      2
    );
    expect(states).not.toContain("Reserved");
  });

  it("returns a fully released pickup unit to Available", () => {
    const releasedUnit = getIoioPhysicalUnitState({
      ...available,
      preparationStates: [],
    });

    expect(releasedUnit).toBe("Available");
    const statusesAfterRelease = [
      getIoioPhysicalUnitState(available),
      releasedUnit,
      getIoioPhysicalUnitState({
        ...available,
        assetStatus: "CHECKED_OUT",
        availableAccordingToIoioInventory: false,
      }),
      getIoioPhysicalUnitState(available),
      getIoioPhysicalUnitState(available),
    ];
    expect(
      statusesAfterRelease.filter((status) => status === "Available")
    ).toHaveLength(4);
  });

  it("shows preparation and issue states without treating course bookings as unavailable", () => {
    expect(
      getIoioPhysicalUnitState({
        ...available,
        preparationStates: ["PENDING_PREPARATION"],
        availableAccordingToIoioInventory: false,
      })
    ).toBe("In preparation");

    expect(
      getIoioPhysicalUnitState({
        ...available,
        bookingStates: [
          { status: "RESERVED", isSoftStaffReservation: true },
          { status: "ONGOING", isSoftStaffReservation: true },
        ],
      })
    ).toBe("Available");

    expect(
      getIoioPhysicalUnitState({
        ...available,
        bookingStates: [{ status: "RESERVED", isSoftStaffReservation: false }],
      })
    ).toBe("Reserved");

    expect(
      getIoioPhysicalUnitState({
        ...available,
        issueReportTypes: ["ITEM_DAMAGED"],
      })
    ).toBe("Broken");

    expect(
      getIoioPhysicalUnitState({
        ...available,
        issueReportTypes: ["ITEM_MISSING"],
      })
    ).toBe("Broken");
    expect(
      getIoioPhysicalUnitState({
        ...available,
        issueReportTypes: ["WRONG_LOCATION"],
      })
    ).toBe("Available");
  });

  it("shows the persisted out-of-service condition after a damaged report closes", () => {
    expect(
      getIoioPhysicalUnitState({
        ...available,
        availableToBook: false,
      })
    ).toBe("Out of service");
  });

  it("uses only unresolved physical-condition reports as unit blockers", () => {
    expect(
      getIoioPhysicalUnitState({
        ...available,
        issueReportTypes: ["ITEM_DAMAGED"],
      })
    ).toBe("Broken");

    expect(
      getIoioPhysicalUnitState({
        ...available,
        issueReportTypes: ["WRONG_LOCATION", "LOCATION_FULL", "OTHER"],
      })
    ).toBe("Available");
  });
});
