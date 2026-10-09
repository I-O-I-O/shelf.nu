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
  });
});
