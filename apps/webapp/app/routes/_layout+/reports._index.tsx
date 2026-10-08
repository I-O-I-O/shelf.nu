import { data, useLoaderData } from "react-router";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";

import Header from "~/components/layout/header";
import { ListContentWrapper } from "~/components/list/content-wrapper";
import {
  getIoioAnalyticsReports,
  IoioAnalyticsLanding,
} from "~/components/reports/ioio-analytics-landing";
import { REPORTS } from "~/modules/reports/registry";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

export const meta: MetaFunction<typeof loader> = ({ data }) => [
  { title: appendToMetaTitle(data?.header?.title || "Analytics") },
];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();

  await requirePermission({
    userId,
    request,
    entity: PermissionEntity.reports,
    action: PermissionAction.read,
  });

  return data({
    header: {
      title: "Analytics",
      subHeading: "Understand lab activity and inventory usage.",
    },
    reports: REPORTS,
  });
}

export default function ReportsIndex() {
  const { reports } = useLoaderData<typeof loader>();
  const analyticsReports = getIoioAnalyticsReports(reports);

  return (
    <>
      <Header hideQuickFind />
      <ListContentWrapper>
        <div className="space-y-8">
          <IoioAnalyticsLanding reports={analyticsReports} />
        </div>
      </ListContentWrapper>
    </>
  );
}
