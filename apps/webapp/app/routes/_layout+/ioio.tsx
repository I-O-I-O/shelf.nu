import { useRouteLoaderData } from "react-router";
import StudentShell from "~/components/ioio-student/student-shell";
import type { loader as layoutLoader } from "~/routes/_layout+/_layout";
import { resolveIoioAccountSurface } from "~/utils/ioio-role-routing";

export default function IoioStudentLayout() {
  const layoutData = useRouteLoaderData<typeof layoutLoader>(
    "routes/_layout+/_layout"
  );

  if (
    !layoutData ||
    resolveIoioAccountSurface(layoutData.currentOrganizationUserRoles) !==
      "student"
  ) {
    return null;
  }

  return <StudentShell />;
}
