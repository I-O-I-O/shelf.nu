/**
 * My Loans is a distinct route on each authenticated IOIO surface. Students
 * use the same IOIO personal borrowing workflow regardless of Staff role.
 */
export function getMyLoansPath(_surface: "student" | "staff") {
  return "/ioio/loans";
}
