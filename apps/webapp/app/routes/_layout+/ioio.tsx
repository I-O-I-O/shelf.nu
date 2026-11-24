import { Outlet, useLocation, useRouteLoaderData } from "react-router";
import type { MetaFunction } from "react-router";
import StudentShell from "~/components/ioio-student/student-shell";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import {
  isIoioPersonalBorrowerRoute,
  resolveIoioAccountSurface,
} from "~/utils/ioio-role-routing";

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("IOIO Lab") },
];

export default function IoioStudentLayout() {
  const location = useLocation();
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );

  if (!layoutData) return null;

  const accountSurface = resolveIoioAccountSurface(
    layoutData.currentOrganizationUserRoles
  );
  if (accountSurface === "student") return <StudentShell />;

  // The root route supplies StaffShell and its shared checkout provider. Only
  // the personal borrowing pages are rendered inside that shell for Staff.
  return layoutData.isIoioStaff &&
    isIoioPersonalBorrowerRoute(location.pathname) ? (
    <Outlet />
  ) : null;
}
