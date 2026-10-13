import { useLoaderData } from "react-router";
import {
  data,
  redirect,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { groupStudentAssets } from "~/components/ioio-student/inventory-presentation";
import {
  formatStudentLabel,
  SectionHeading,
  StudentAssetPlaceholder,
} from "~/components/ioio-student/student-ui";
import { Button } from "~/components/shared/button";
import { db } from "~/database/db.server";
import { getPhysicalUnitLabelFromTitle } from "~/modules/asset/physical-unit";
import { IOIO_REPORT_OPERATION } from "~/modules/ioio-student/rate-limit.server";
import { getIoioReportAcknowledgement } from "~/modules/ioio-student/report-problem.shared";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import { getStudentAssets } from "~/modules/ioio-student/service.server";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export const meta: MetaFunction<typeof loader> = () => [
  { title: "Report received" },
];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const auth = await requireStudentRead({ context, request });
  const reportId = new URL(request.url).searchParams.get("reportId");
  if (!reportId) return redirect("/ioio");

  try {
    const report = await db.ioioWriteOperation.findFirst({
      where: {
        operationType: IOIO_REPORT_OPERATION,
        source: "IOIO_STUDENT_REPORT",
        resultReportId: reportId,
        userId: auth.userId,
        organizationId: auth.organizationId,
        status: "SUCCEEDED",
      },
      select: { assetId: true, reportType: true },
    });
    if (!report) return redirect("/ioio");

    let item = null;
    if (report.assetId) {
      const inventoryAssets = await getStudentAssets({
        organizationId: auth.organizationId,
      });
      const reportedAsset = inventoryAssets.find(
        (asset) => asset.id === report.assetId
      );
      if (reportedAsset) {
        const logicalAsset = groupStudentAssets(inventoryAssets).find(
          (asset) =>
            asset.id === reportedAsset.id ||
            asset.sourceAssetIds.includes(reportedAsset.id)
        );
        if (logicalAsset) {
          item = {
            id: reportedAsset.id,
            title: formatStudentLabel(logicalAsset.title),
            unitLabel:
              reportedAsset.type === "INDIVIDUAL"
                ? getPhysicalUnitLabelFromTitle(reportedAsset.title) ??
                  (reportedAsset.sequentialId
                    ? `#${reportedAsset.sequentialId}`
                    : null)
                : null,
            image: {
              id: reportedAsset.id,
              title: reportedAsset.title,
              type: reportedAsset.type,
              mainImage: reportedAsset.mainImage,
              thumbnailImage: reportedAsset.thumbnailImage,
              assetModel: reportedAsset.assetModel,
              kitImage: reportedAsset.kitImage,
            },
          };
        }
      }
    }

    return data(
      payload({
        item,
        acknowledgement: getIoioReportAcknowledgement(report.reportType),
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId: auth.userId });
    throw data(error(reason), { status: reason.status });
  }
}

export default function IoioReportComplete() {
  const { item, acknowledgement } = useLoaderData<typeof loader>();

  return (
    <div className="mx-auto max-w-2xl">
      <SectionHeading title="Report sent" />
      <section className="space-y-5 rounded-3xl border border-gray-200 bg-white p-5 shadow-sm sm:p-7">
        {item ? (
          <div className="flex items-center gap-4">
            <div className="size-24 shrink-0 overflow-hidden rounded-2xl border border-gray-100 bg-gray-50 sm:size-28">
              <StudentAssetPlaceholder
                asset={item.image}
                variant="detail"
                className="size-full"
              />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-black text-gray-950">{item.title}</h2>
              {item.unitLabel ? (
                <p className="mt-1 text-sm font-semibold text-gray-600">
                  Unit {item.unitLabel}
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        <p
          role="status"
          className="rounded-xl bg-red-50 px-4 py-3 font-semibold text-red-900"
        >
          {acknowledgement}
        </p>
        <Button
          to="/ioio"
          variant="primary"
          width="full"
          size="md"
          className="min-h-12 rounded-xl border-red-700 bg-red-700 px-5 text-base font-bold text-white hover:bg-red-800 focus:ring-red-600"
        >
          Finish
        </Button>
      </section>
    </div>
  );
}
