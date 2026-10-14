import { isIoioPhysicalUnitBlockingReport } from "~/modules/ioio-student/report-problem.shared";

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

/** Resolve one display state for both IOIO Inventory counts and unit badges. */
export function getIoioPhysicalUnitState({
  assetStatus,
  availableToBook,
  bookingStates,
  preparationStates,
  issueReportTypes,
  availableAccordingToIoioInventory,
}: IoioPhysicalUnitStateInput) {
  const blockingIssueReportTypes = issueReportTypes.filter(
    isIoioPhysicalUnitBlockingReport
  );
  if (blockingIssueReportTypes.length) return "Broken";

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

  if (!availableToBook) return "Out of service";
  const hasOnlySoftReservationOverlaps =
    bookingStates.length > 0 &&
    bookingStates.every(({ isSoftStaffReservation }) => isSoftStaffReservation);
  return availableAccordingToIoioInventory || hasOnlySoftReservationOverlaps
    ? "Available"
    : "Unavailable";
}
