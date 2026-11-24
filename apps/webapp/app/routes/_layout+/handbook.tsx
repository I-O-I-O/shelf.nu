import type { MetaFunction } from "react-router";
import { Outlet, useRouteLoaderData } from "react-router";
import StudentShell from "~/components/ioio-student/student-shell";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { resolveIoioAccountSurface } from "~/utils/ioio-role-routing";

export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Handbook") },
];

/**
 * Student Handbook pages share the same application navigation as the rest of
 * the student desk. Staff already receive StaffShell from the authenticated
 * app layout, so this route adds no second shell for staff.
 */
export default function HandbookLayout() {
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );

  if (!layoutData) return null;

  if (
    resolveIoioAccountSurface(layoutData.currentOrganizationUserRoles) ===
    "student"
  ) {
    return <StudentShell />;
  }

  return <Outlet />;
}
