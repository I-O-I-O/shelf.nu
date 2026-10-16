import { useLoaderData } from "react-router";
import {
  data,
  redirect,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { AssetDetailImage } from "~/components/assets/asset-image";
import { groupStudentAssets } from "~/components/ioio-student/inventory-presentation";
import {
  formatStudentLabel,
  SectionHeading,
} from "~/components/ioio-student/student-ui";
import { Button } from "~/components/shared/button";
import { db } from "~/database/db.server";
import { getPhysicalUnitLabelFromTitle } from "~/modules/asset/physical-unit";
import { IOIO_REPORT_OPERATION } from "~/modules/ioio-student/rate-limit.server";
import { getIoioReportAcknowledgement } from "~/modules/ioio-student/report-problem.shared";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import {
  formatStudentLocationPath,
  getStudentAssets,
} from "~/modules/ioio-student/service.server";
import { getCompactLocationSummary } from "~/modules/location/compact-location";
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
      select: { assetId: true, locationId: true, reportType: true },
    });
    if (!report) return redirect("/ioio");

    const reportedLocation =
      report.locationId &&
      (report.reportType === "WRONG_LOCATION" ||
        report.reportType === "LOCATION_FULL")
        ? await loadReportedLocation(report.locationId, auth.organizationId)
        : null;

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
        reportedLocation:
          !item && report.reportType === "LOCATION_FULL"
            ? reportedLocation
            : null,
        itemReportedLocation:
          item && report.reportType === "WRONG_LOCATION"
            ? reportedLocation
            : null,
        acknowledgement: getIoioReportAcknowledgement(report.reportType),
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId: auth.userId });
    throw data(error(reason), { status: reason.status });
  }
}

async function loadReportedLocation(
  locationId: string,
  organizationId: string
) {
  const locations = await db.location.findMany({
    where: { organizationId },
    select: { id: true, name: true, parentId: true },
  });
  const selectedLocation = locations.find(
    (location) => location.id === locationId
  );
  if (!selectedLocation) return null;

  const hierarchy = formatStudentLocationPath(locationId, locations);
  const summary = getCompactLocationSummary(hierarchy, {
    showIntermediateLocations: false,
  });
  const name = [summary.room, summary.storageLabel]
    .filter((part): part is string => Boolean(part))
    .join(" · ");

  return { name: name || selectedLocation.name };
}

export default function IoioReportComplete() {
  const { item, reportedLocation, itemReportedLocation, acknowledgement } =
    useLoaderData<typeof loader>();

  return (
    <div className="mx-auto max-w-2xl">
      <SectionHeading title="Report sent" />
      <section className="space-y-5 rounded-3xl border border-gray-200 bg-white p-5 shadow-sm sm:p-7">
        {item ? (
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4 sm:p-5">
            <div
              role="group"
              aria-label="Asset image preview"
              className="mx-auto flex h-[clamp(13rem,32vh,19rem)] w-full max-w-[26rem] items-center justify-center overflow-hidden rounded-2xl border border-gray-200 bg-white p-3 sm:h-[clamp(14rem,36vh,20rem)] sm:p-4"
            >
              <AssetDetailImage
                asset={item.image}
                alt={`Image of ${item.image.title}`}
                variant="compact"
                className="p-2 sm:p-3"
              />
            </div>
            <div className="mt-4 text-center">
              <h2 className="text-xl font-black text-gray-950">{item.title}</h2>
              {item.unitLabel ? (
                <p className="mt-1 text-sm font-semibold text-gray-600">
                  Unit <span className="ioio-identifier">{item.unitLabel}</span>
                </p>
              ) : null}
            </div>
            {itemReportedLocation ? (
              <p className="mt-4 border-t border-gray-200 pt-3 text-sm text-gray-700">
                <span className="block text-xs font-semibold uppercase tracking-wide text-gray-500">
                  Reported location
                </span>
                <span className="mt-1 block font-semibold">
                  {itemReportedLocation.name}
                </span>
              </p>
            ) : null}
          </div>
        ) : null}
        {!item && reportedLocation ? (
          <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
              Location full
            </p>
            <p className="mt-1 font-bold text-gray-950">
              {reportedLocation.name}
            </p>
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
