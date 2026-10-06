import { randomUUID } from "node:crypto";
import {
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
} from "react-router";
import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "react-router";
import { z } from "zod";
import { AssetImage } from "~/components/assets/asset-image";
import {
  formatStudentDateOnly,
  formatStudentLabel,
  SectionHeading,
} from "~/components/ioio-student/student-ui";
import { db } from "~/database/db.server";
import {
  createBorrowedItemProblemReport,
  getBorrowedItemProblemContext,
} from "~/modules/ioio-student/report-problem.server";
import type { IoioReportType } from "~/modules/ioio-student/report-problem.shared";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import { getIoioPhysicalUnitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import { createReport } from "~/modules/report-found/service.server";
import { makeShelfError } from "~/utils/error";
import { error, parseData, payload } from "~/utils/http.server";

const problemTypes = [
  { value: "DAMAGED", label: "Item damaged" },
  { value: "MISSING", label: "Item missing" },
  { value: "CANT_FIND", label: "Can't find item" },
  { value: "WRONG_LOCATION", label: "Wrong location" },
  { value: "LOCATION_FULL", label: "Location full" },
  { value: "KIT_INCOMPLETE", label: "Kit incomplete" },
  { value: "FOUND", label: "Found something" },
  { value: "OTHER", label: "Other" },
] as const;

const reportTypeByFormValue = {
  DAMAGED: "ITEM_DAMAGED",
  MISSING: "ITEM_MISSING",
  CANT_FIND: "CANNOT_FIND",
  WRONG_LOCATION: "WRONG_LOCATION",
  LOCATION_FULL: "LOCATION_FULL",
  KIT_INCOMPLETE: "KIT_INCOMPLETE",
  FOUND: "OTHER",
  OTHER: "OTHER",
} as const;

const REPORT_OPERATION = "REPORT_PROBLEM";

export const meta: MetaFunction<typeof loader> = () => [
  { title: "Report an issue" },
];

const borrowedProblemTypes = [
  { value: "DAMAGED", label: "Broken / damaged" },
  { value: "MISSING_PART", label: "Missing part" },
  { value: "NOT_WORKING", label: "Not working" },
  { value: "OTHER", label: "Other" },
] as const;

const borrowedReportTypeByFormValue: Record<
  (typeof borrowedProblemTypes)[number]["value"],
  IoioReportType
> = {
  DAMAGED: "ITEM_DAMAGED",
  MISSING_PART: "PART_MISSING",
  NOT_WORKING: "ITEM_NOT_WORKING",
  OTHER: "OTHER",
};

const ReportSchema = z.object({
  problemType: z.string().trim().min(1),
  assetId: z.string().optional(),
  // Kept for compatibility with existing Shelf report integrations. The
  // student form intentionally does not expose a separate kit field.
  kitId: z.string().optional(),
  // Kept for compatibility with existing report links. Students explain
  // location details in the description instead of resolving a location.
  locationId: z.string().optional(),
  bookingId: z.string().optional(),
  bookingAssetId: z.string().optional(),
  content: z.string().trim().min(3).max(2000),
});

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId, organizationId } = await requireStudentRead({
    context,
    request,
  });
  try {
    const params = new URL(request.url).searchParams;
    const bookingId = params.get("bookingId");
    const bookingAssetId = params.get("bookingAssetId");
    const assetId = params.get("assetId");
    if (bookingId || bookingAssetId || assetId) {
      if (!bookingId || !bookingAssetId || !assetId) {
        throw new Error("The borrowed item reference is incomplete.");
      }
      const borrowedItem = await getBorrowedItemProblemContext(
        { bookingId, bookingAssetId, assetId },
        { context, request }
      );
      return data(payload({ mode: "borrowed" as const, borrowedItem }));
    }
    const assets = await db.asset.findMany({
      where: { organizationId },
      select: { id: true, title: true },
      orderBy: { title: "asc" },
    });
    return data(
      payload({
        mode: "generic" as const,
        assets,
        selectedAssetId: params.get("assetId"),
        bookingId: params.get("bookingId"),
        bookingAssetId: params.get("bookingAssetId"),
      })
    );
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId, organizationId } = await requireStudentRead({
    context,
    request,
  });
  try {
    const values = parseData(await request.formData(), ReportSchema);
    if (values.bookingId || values.bookingAssetId) {
      if (!values.bookingId || !values.bookingAssetId || !values.assetId) {
        throw new Error("The borrowed item reference is incomplete.");
      }
      const selectedType = borrowedProblemTypes.find(
        (item) => item.value === values.problemType
      );
      if (!selectedType) {
        throw new Error("Choose a problem type before sending the report.");
      }
      await createBorrowedItemProblemReport(
        {
          bookingId: values.bookingId,
          bookingAssetId: values.bookingAssetId,
          assetId: values.assetId,
          reportType: borrowedReportTypeByFormValue[selectedType.value],
          description: values.content,
        },
        { context, request },
        { source: "IOIO_STUDENT_REPORT" }
      );
      return redirect("/ioio/loans?report=submitted");
    }

    const problemType = problemTypes.find(
      (item) => item.value === values.problemType
    );
    if (!problemType) {
      throw new Error("Choose what happened before sending the report.");
    }

    const [user, asset, kit, location] = await Promise.all([
      db.user.findUniqueOrThrow({
        where: { id: userId },
        select: { email: true },
      }),
      values.assetId
        ? db.asset.findFirst({
            where: { id: values.assetId, organizationId },
            select: {
              id: true,
              assetKits: { select: { kitId: true } },
            },
          })
        : null,
      values.kitId
        ? db.kit.findFirst({
            where: { id: values.kitId, organizationId },
            select: { id: true },
          })
        : null,
      values.locationId
        ? db.location.findFirst({
            where: { id: values.locationId, organizationId },
            select: { name: true },
          })
        : null,
    ]);
    if (values.assetId && !asset) {
      throw new Error("The selected asset is not in this workspace.");
    }
    if (values.kitId && !kit) {
      throw new Error("The selected kit is not in this workspace.");
    }
    if (values.locationId && !location) {
      throw new Error("The selected location is not in this workspace.");
    }

    let borrowedSourceKitId: string | null = null;
    if (values.bookingId || values.bookingAssetId) {
      if (!values.bookingId || !values.bookingAssetId || !values.assetId) {
        throw new Error("The borrowed item reference is incomplete.");
      }
      const teamMembers = await db.teamMember.findMany({
        where: { userId, organizationId, deletedAt: null },
        select: { id: true },
      });
      const borrowedAsset = await db.bookingAsset.findFirst({
        where: {
          id: values.bookingAssetId,
          bookingId: values.bookingId,
          assetId: values.assetId,
          checkedOutAt: { not: null },
          checkedInAt: null,
          booking: {
            organizationId,
            status: { in: ["ONGOING", "OVERDUE"] },
            OR: [
              { custodianUserId: userId },
              ...(teamMembers.length
                ? [
                    {
                      custodianTeamMemberId: {
                        in: teamMembers.map((member) => member.id),
                      },
                    },
                  ]
                : []),
            ],
          },
        },
        select: { id: true, sourceKitId: true },
      });
      if (!borrowedAsset) {
        throw new Error("That borrowed item is no longer active.");
      }
      borrowedSourceKitId = borrowedAsset.sourceKitId;
    }

    const assetKitIds = (asset?.assetKits ?? []).map(({ kitId }) => kitId);
    const derivedKitId =
      borrowedSourceKitId ??
      (assetKitIds.length === 1 ? assetKitIds[0] : kit?.id ?? null);
    if (values.kitId && derivedKitId && values.kitId !== derivedKitId) {
      throw new Error("The selected Kit does not match the borrowed item.");
    }
    const reportKit = derivedKitId
      ? await db.kit.findFirst({
          where: { id: derivedKitId, organizationId },
          select: { id: true },
        })
      : null;

    const details = [
      "[IOIO student report]",
      `Issue: ${problemType.label}`,
      location ? `Location: ${location.name}` : null,
      `Description: ${values.content}`,
    ]
      .filter(Boolean)
      .join("\n");

    await db.$transaction(async (tx) => {
      const report = await createReport({
        email: user.email,
        content: details,
        assetId: asset?.id,
        kitId: reportKit?.id,
        client: tx,
      });
      await tx.ioioWriteOperation.create({
        data: {
          operationType: REPORT_OPERATION,
          source: "IOIO_STUDENT_REPORT",
          status: "SUCCEEDED",
          idempotencyKey: randomUUID(),
          userId,
          organizationId,
          reportType: reportTypeByFormValue[problemType.value],
          description: values.content,
          assetId: asset?.id,
          kitId: reportKit?.id,
          locationId: values.locationId || null,
          bookingId: values.bookingId || null,
          bookingAssetId: values.bookingAssetId || null,
          resultReportId: report.id,
          completedAt: new Date(),
        },
      });
    });
    return payload({ ok: true });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, organizationId });
    return data(error(reason), { status: reason.status });
  }
}

function ReportSelect({
  label,
  name,
  options,
  emptyLabel,
  defaultValue,
}: {
  label: string;
  name: string;
  options: Array<{ id: string; label: string }>;
  emptyLabel: string;
  defaultValue?: string;
}) {
  return (
    <label className="block text-sm font-medium text-gray-800">
      {label}
      <select
        name={name}
        defaultValue={defaultValue}
        className="mt-1 block min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export default function IoioReport() {
  const loaderData = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  if (loaderData.mode === "borrowed") {
    return (
      <BorrowedProblemForm item={loaderData.borrowedItem} result={result} />
    );
  }
  const { assets, selectedAssetId, bookingId, bookingAssetId } = loaderData;
  const assetOptions = assets.map((asset) => ({
    id: asset.id,
    label: formatStudentLabel(asset.title),
  }));

  return (
    <div>
      <SectionHeading
        title="Report"
        text="Tell staff what happened. Inventory is not changed automatically."
      />
      {result && "ok" in result && result.ok ? (
        <div
          className="mb-5 rounded-xl bg-green-100 p-4 text-sm font-medium text-green-800"
          role="status"
        >
          Thanks - your report was sent for staff review.
        </div>
      ) : null}
      {result && "error" in result ? (
        <div
          className="mb-5 rounded-xl bg-red-50 p-4 text-sm font-medium text-red-800"
          role="alert"
        >
          {result.error?.message ?? "The report could not be submitted."}
        </div>
      ) : null}
      <Form
        method="post"
        className="space-y-5 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
      >
        <label className="block text-sm font-medium text-gray-800">
          What happened?
          <select
            name="problemType"
            required
            className="mt-1 block min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
          >
            <option value="">Choose an issue</option>
            {problemTypes.map((problemType) => (
              <option key={problemType.value} value={problemType.value}>
                {problemType.label}
              </option>
            ))}
          </select>
        </label>
        <ReportSelect
          label="Affected asset, if known"
          name="assetId"
          options={assetOptions}
          emptyLabel="No asset selected"
          defaultValue={selectedAssetId ?? undefined}
        />
        {bookingId && bookingAssetId ? (
          <>
            <input type="hidden" name="bookingId" value={bookingId} />
            <input type="hidden" name="bookingAssetId" value={bookingAssetId} />
          </>
        ) : null}
        <label className="block text-sm font-medium text-gray-800">
          Description
          <textarea
            name="content"
            required
            minLength={3}
            maxLength={2000}
            rows={6}
            className="mt-1 block w-full rounded-xl border border-gray-300 px-3 py-2 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
            placeholder="Tell staff what happened and include location details if useful."
          />
        </label>
        <button
          type="submit"
          className="min-h-11 rounded-xl bg-red-700 px-5 font-semibold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-600"
        >
          Submit report
        </button>
      </Form>
    </div>
  );
}

function BorrowedProblemForm({
  item,
  result,
}: {
  item: Awaited<ReturnType<typeof getBorrowedItemProblemContext>>;
  result: ReturnType<typeof useActionData<typeof action>>;
}) {
  const displayName = formatStudentLabel(
    item.isKit || item.unitLabel
      ? getIoioPhysicalUnitDisplayName({
          logicalProductName: item.itemName,
          unitNumber: item.unitLabel,
          missingUnitLabel: "Unit number missing",
        })
      : item.itemName
  );
  const image = { id: item.assetId, ...item.image };

  return (
    <div>
      <SectionHeading
        title="Report an issue"
        text="Tell staff what happened. Your loan will remain active until you return the item."
      />
      {result && "error" in result ? (
        <div
          className="mb-5 rounded-xl bg-red-50 p-4 text-sm font-medium text-red-800"
          role="alert"
        >
          {result.error?.message ?? "The report could not be submitted."}
        </div>
      ) : null}
      <div className="mb-5 flex gap-4 rounded-2xl border border-gray-200 bg-white p-4 shadow-sm">
        <div className="size-24 shrink-0 overflow-hidden rounded-xl bg-gray-100">
          <AssetImage
            asset={image}
            alt={`Image of ${displayName}`}
            useThumbnail={false}
            className="size-full"
          />
        </div>
        <div className="min-w-0 text-sm text-gray-700">
          <h2 className="font-bold text-gray-950">{displayName}</h2>
          <p className="mt-1">
            Borrowed: {formatStudentDateOnly(item.borrowedAt)}
          </p>
          <p>
            {item.dueAt
              ? `Due: ${formatStudentDateOnly(item.dueAt)}`
              : "No due date"}
          </p>
          <p>Quantity: {item.quantity}</p>
        </div>
      </div>
      <Form
        method="post"
        className="space-y-5 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
      >
        <input type="hidden" name="assetId" value={item.assetId} />
        <input type="hidden" name="bookingId" value={item.bookingId} />
        <input
          type="hidden"
          name="bookingAssetId"
          value={item.bookingAssetId}
        />
        <label className="block text-sm font-medium text-gray-800">
          Problem type
          <select
            name="problemType"
            required
            className="mt-1 block min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
          >
            <option value="">Choose an issue</option>
            {borrowedProblemTypes.map((problemType) => (
              <option key={problemType.value} value={problemType.value}>
                {problemType.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm font-medium text-gray-800">
          Description
          <textarea
            name="content"
            required
            minLength={3}
            maxLength={2000}
            rows={5}
            className="mt-1 block w-full rounded-xl border border-gray-300 px-3 py-2 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
            placeholder="Describe the problem for staff."
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="min-h-11 rounded-xl bg-red-700 px-5 font-semibold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-600"
          >
            Submit report
          </button>
          <Link
            to="/ioio/loans"
            className="min-h-11 rounded-xl border border-gray-300 px-5 py-2.5 font-semibold text-gray-700 hover:bg-gray-50"
          >
            Cancel
          </Link>
        </div>
      </Form>
    </div>
  );
}
