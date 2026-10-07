/**
 * My Loans is a distinct route on each authenticated IOIO surface. Students
 * use their IOIO workflow; staff use Shelf's booking list with a self filter.
 */
export function getMyLoansPath(surface: "student" | "staff") {
  return surface === "student" ? "/ioio/loans" : "/bookings?mine=1";
}
