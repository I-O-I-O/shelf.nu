export type IoioUnitBookingState = {
  status: string;
  isSoftStaffReservation: boolean;
};

export type IoioPhysicalUnitStateInput = {
  assetStatus: string;
  availableToBook: boolean;
  bookingStates: IoioUnitBookingState[];
  preparationStates: string[];
  issueReportTypes: string[];
  availableAccordingToIoioInventory: boolean;
};

const brokenIssueTypes = new Set([
  "ITEM_DAMAGED",
  "ITEM_NOT_WORKING",
  "PART_MISSING",
  "KIT_INCOMPLETE",
]);

/** Resolve one display state for both IOIO Inventory counts and unit badges. */
export function getIoioPhysicalUnitState({
  assetStatus,
  availableToBook,
  bookingStates,
  preparationStates,
  issueReportTypes,
  availableAccordingToIoioInventory,
}: IoioPhysicalUnitStateInput) {
  if (issueReportTypes.some((type) => brokenIssueTypes.has(type))) {
    return "Broken";
  }
  if (issueReportTypes.length) return "Issue reported";

  if (preparationStates.includes("READY_FOR_PICKUP")) {
    return "Ready for pickup";
  }
  if (preparationStates.includes("PENDING_PREPARATION")) {
    return "In preparation";
  }
  if (preparationStates.includes("CANCELLED_PICKUP")) {
    return "Put back required";
  }

  if (
    assetStatus === "IN_CUSTODY" ||
    assetStatus === "CHECKED_OUT" ||
    bookingStates.some(
      ({ status, isSoftStaffReservation }) =>
        (status === "ONGOING" || status === "OVERDUE") &&
        !isSoftStaffReservation
    )
  ) {
    return "In use";
  }

  if (
    bookingStates.some(
      ({ status, isSoftStaffReservation }) =>
        status === "RESERVED" && !isSoftStaffReservation
    )
  ) {
    return "Reserved";
  }

  if (!availableToBook) return "Temporarily unavailable";
  const hasOnlySoftReservationOverlaps =
    bookingStates.length > 0 &&
    bookingStates.every(({ isSoftStaffReservation }) => isSoftStaffReservation);
  return availableAccordingToIoioInventory || hasOnlySoftReservationOverlaps
    ? "Available"
    : "Unavailable";
}
