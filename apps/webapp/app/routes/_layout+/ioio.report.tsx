import { useEffect, useRef, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  Outlet,
} from "react-router";
import {
  data,
  redirect,
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
  getIoioArchivedItemIds,
  IOIO_ARCHIVE_ITEM_TYPE,
} from "~/modules/ioio-staff/archive.server";
import {
  getReportAssetOptions,
  searchReportAssets,
} from "~/modules/ioio-student/report-form.shared";
import {
  createBorrowedItemProblemReport,
  getBorrowedItemProblemContext,
  prepareReportProblem,
  reportProblem,
} from "~/modules/ioio-student/report-problem.server";
import {
  IOIO_REPORT_CONTEXT_RULES,
  IOIO_REPORT_FORM_VALUES,
  IOIO_REPORTED_UNIT_LOCKING_REPORT_TYPES,
  IOIO_REPORT_TYPE_BY_FORM_VALUE,
  type IoioReportFormValue,
  type IoioReportType,
} from "~/modules/ioio-student/report-problem.shared";
import { getReportSubmissionFeedback } from "~/modules/ioio-student/report-submission-feedback";
import { requireStudentRead } from "~/modules/ioio-student/route.server";
import {
  getStudentAssets,
  getStudentLocations,
} from "~/modules/ioio-student/service.server";
import type { StudentLocation } from "~/modules/ioio-student/service.server";
import { getIoioPhysicalUnitDisplayName } from "~/modules/kit/ioio-kit-presentation";
import { makeShelfError, ShelfError } from "~/utils/error";
import { error, parseData, payload } from "~/utils/http.server";

const problemTypes = [
  { value: "DAMAGED", label: "Item damaged" },
  { value: "MISSING", label: "Item missing" },
  { value: "CANT_FIND", label: "Can't find item" },
  { value: "WRONG_LOCATION", label: "Wrong location" },
  { value: "LOCATION_FULL", label: "Location full" },
  { value: "KIT_INCOMPLETE", label: "Kit incomplete" },
  { value: "OTHER", label: "Other" },
] as const;

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
  productId: z.string().optional(),
  unitId: z.string().optional(),
  // Kept for compatibility with existing Shelf report integrations. The
  // student form intentionally does not expose a separate kit field.
  kitId: z.string().optional(),
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
    const [inventoryAssets, studentLocations] = await Promise.all([
      getStudentAssets({ organizationId }),
      getStudentLocations({ organizationId }),
    ]);
    const assetOptions = getReportAssetOptions(
      inventoryAssets,
      formatStudentLabel
    );
    const physicalUnitIds = assetOptions.flatMap((asset) =>
      asset.units.map((unit) => unit.id)
    );
    const unresolvedUnitReports = physicalUnitIds.length
      ? await db.ioioWriteOperation.findMany({
          where: {
            organizationId,
            operationType: "REPORT_PROBLEM",
            status: { in: ["SUCCEEDED", "PROCESSING"] },
            reportType: { in: [...IOIO_REPORTED_UNIT_LOCKING_REPORT_TYPES] },
            assetId: { in: physicalUnitIds },
          },
          select: { assetId: true },
        })
      : [];
    const reportedUnitIds = new Set(
      unresolvedUnitReports.flatMap((operation) =>
        operation.assetId ? [operation.assetId] : []
      )
    );
    const assets = getReportAssetOptions(
      inventoryAssets,
      formatStudentLabel,
      reportedUnitIds
    );
    const selectedUnit = params.get("assetId");
    const selectedAsset = selectedUnit
      ? assets.find((asset) =>
          asset.units.some((unit) => unit.id === selectedUnit)
        )
      : null;
    return data(
      payload({
        mode: "generic" as const,
        assets,
        locations: studentLocations,
        selectedProductId: selectedAsset?.id ?? null,
        selectedUnitId: selectedUnit,
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
      if (
        values.productId ||
        values.unitId ||
        values.locationId ||
        values.kitId
      ) {
        throw new Error("This loan report contains unrelated item details.");
      }
      if (!values.bookingId || !values.bookingAssetId || !values.assetId) {
        throw new Error("The borrowed item reference is incomplete.");
      }
      const selectedType = borrowedProblemTypes.find(
        (item) => item.value === values.problemType
      );
      if (!selectedType) {
        throw new Error("Choose a problem type before sending the report.");
      }
      const reportType = borrowedReportTypeByFormValue[selectedType.value];
      const savedReport = await createBorrowedItemProblemReport(
        {
          bookingId: values.bookingId,
          bookingAssetId: values.bookingAssetId,
          assetId: values.assetId,
          reportType,
          description: values.content,
        },
        { context, request },
        { source: "IOIO_STUDENT_REPORT" }
      );
      if (!savedReport.reportId) {
        throw new Error(
          "The report was saved without a confirmation reference."
        );
      }
      return redirect(getReportCompletionPath(savedReport.reportId));
    }

    const problemType = problemTypes.find(
      (item) => item.value === values.problemType
    );
    if (!problemType) {
      throw invalidReport("Choose what happened before sending the report.");
    }

    if (
      !IOIO_REPORT_FORM_VALUES.includes(
        values.problemType as IoioReportFormValue
      )
    ) {
      throw invalidReport("Choose what happened before sending the report.");
    }
    const formValue = values.problemType as IoioReportFormValue;
    const contextRules = IOIO_REPORT_CONTEXT_RULES[formValue];
    if (!contextRules) {
      throw invalidReport("Choose what happened before sending the report.");
    }
    const productId = values.productId?.trim() || "";
    const unitIdValue = values.unitId?.trim() || "";
    const locationId = values.locationId?.trim() || "";
    if (contextRules.asset === "required" && !productId) {
      throw invalidReport("Choose the item this report is about.");
    }
    if (contextRules.asset === "none" && (productId || unitIdValue)) {
      throw invalidReport("This report type does not use an item or unit.");
    }
    if (contextRules.location === "required" && !locationId) {
      throw invalidReport("Choose the Shelf location for this report.");
    }
    if (contextRules.location === "none" && locationId) {
      throw invalidReport("This report type does not use a location.");
    }
    if (unitIdValue && !productId) {
      throw invalidReport("Choose an item before selecting an exact unit.");
    }
    if (contextRules.exactUnit === "none" && unitIdValue) {
      throw invalidReport("This report type does not use an exact unit.");
    }
    if (values.assetId) {
      throw invalidReport(
        "This report type cannot use a borrowed-item reference."
      );
    }
    if (values.kitId || values.bookingId || values.bookingAssetId) {
      throw invalidReport("This report contains unrelated item details.");
    }

    let exactAssetId: string | null = null;
    let reportKitId: string | null = null;
    let reportDescription = values.content;
    if (productId) {
      const archivedAssetIds = await getIoioArchivedItemIds({
        organizationId,
        itemType: IOIO_ARCHIVE_ITEM_TYPE.ASSET,
      });
      const visibleAssetFilter = archivedAssetIds.length
        ? { id: { notIn: archivedAssetIds } }
        : {};
      const product = await db.asset.findFirst({
        where: {
          id: productId,
          organizationId,
          ...visibleAssetFilter,
        },
        select: {
          id: true,
          title: true,
          type: true,
          assetModelId: true,
          assetModel: { select: { name: true } },
          assetKits: { select: { kitId: true } },
        },
      });
      if (!product) {
        throw invalidReport("The selected item is not in this workspace.");
      }
      let assetKitIds = product.assetKits.map(({ kitId }) => kitId);

      if (product.type === "INDIVIDUAL") {
        const unitCount = product.assetModelId
          ? await db.asset.count({
              where: {
                organizationId,
                type: "INDIVIDUAL",
                assetModelId: product.assetModelId,
                ...visibleAssetFilter,
              },
            })
          : 1;
        if (
          contextRules.exactUnit === "required-if-multiple" &&
          unitCount > 1 &&
          !unitIdValue
        ) {
          throw invalidReport("Choose the exact unit this report is about.");
        }
        if (unitCount > 1 && !unitIdValue) {
          // A logical product selection without a unit must not be attached to
          // the canonical first unit, which would falsely mark that unit as
          // Reported or unavailable.
          const logicalName =
            product.assetModel?.name ??
            product.title.replace(/\s+#\d+\s*$/u, "");
          reportDescription = `${formatStudentLabel(
            logicalName
          )} (exact unit not specified): ${values.content}`;
        } else {
          const unitId = unitIdValue || product.id;
          const unit = await db.asset.findFirst({
            where: {
              id: unitId,
              organizationId,
              type: "INDIVIDUAL",
              ...visibleAssetFilter,
              ...(product.assetModelId
                ? { assetModelId: product.assetModelId }
                : { id: product.id }),
            },
            select: { id: true, assetKits: { select: { kitId: true } } },
          });
          if (!unit) {
            throw invalidReport(
              "Choose a unit belonging to the selected item."
            );
          }
          exactAssetId = unit.id;
          assetKitIds = unit.assetKits.map(({ kitId }) => kitId);
        }
      } else {
        if (unitIdValue) {
          throw invalidReport(
            "This item does not have separate physical units."
          );
        }
        exactAssetId = product.id;
      }
      reportKitId =
        exactAssetId && assetKitIds.length === 1 ? assetKitIds[0] : null;
    }

    const reportType = IOIO_REPORT_TYPE_BY_FORM_VALUE[formValue];
    const proposal = await prepareReportProblem(
      {
        report_type: reportType,
        asset_id: exactAssetId,
        kit_id: reportKitId ?? null,
        location_id: locationId || null,
        description: reportDescription,
      },
      { context, request },
      { source: "IOIO_STUDENT_REPORT" }
    );
    const savedReport = await reportProblem(
      {
        confirmationToken: proposal.confirmationToken,
        reportType,
        description: reportDescription,
      },
      { context, request }
    );

    if (!savedReport.reportId) {
      throw new Error("The report was saved without a confirmation reference.");
    }
    return redirect(getReportCompletionPath(savedReport.reportId));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId, organizationId });
    return data(error(reason, false), { status: reason.status });
  }
}

function getReportCompletionPath(reportId: string) {
  const searchParams = new URLSearchParams({ reportId });
  return `/ioio/report/complete?${searchParams.toString()}`;
}

function invalidReport(message: string): ShelfError {
  return new ShelfError({
    cause: null,
    label: "Report",
    message,
    shouldBeCaptured: false,
    status: 400,
  });
}

export default function IoioReport() {
  const loaderData = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const location = useLocation();
  const isSubmitting = navigation.state !== "idle";
  // `ioio.report.complete` is a child route under the report route. Render
  // that child instead of leaving the original form mounted beside it.
  if (location.pathname === "/ioio/report/complete") {
    return <Outlet />;
  }
  if (loaderData.mode === "borrowed") {
    return (
      <BorrowedProblemForm
        item={loaderData.borrowedItem}
        result={result}
        isSubmitting={isSubmitting}
      />
    );
  }
  return (
    <GenericReportForm
      assets={loaderData.assets}
      locations={loaderData.locations}
      selectedProductId={loaderData.selectedProductId}
      selectedUnitId={loaderData.selectedUnitId}
      result={result}
      isSubmitting={isSubmitting}
    />
  );
}

function GenericReportForm({
  assets,
  locations,
  selectedProductId,
  selectedUnitId,
  result,
  isSubmitting,
}: {
  assets: Array<{
    id: string;
    label: string;
    units: Array<{ id: string; label: string; reported: boolean }>;
    defaultUnitId: string | null;
  }>;
  locations: StudentLocation[];
  selectedProductId: string | null;
  selectedUnitId: string | null;
  result: ReturnType<typeof useActionData<typeof action>>;
  isSubmitting: boolean;
}) {
  const feedback = getReportSubmissionFeedback(result);
  const submitLock = useRef(false);
  useEffect(() => {
    if (!isSubmitting && feedback) submitLock.current = false;
  }, [feedback, isSubmitting]);
  const [problemType, setProblemType] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(
    selectedProductId ?? ""
  );
  const currentProduct = assets.find((asset) => asset.id === selectedProduct);
  const [itemSearch, setItemSearch] = useState(currentProduct?.label ?? "");
  const [showItemResults, setShowItemResults] = useState(false);
  const itemResults = searchReportAssets(assets, itemSearch);
  const selectedUnit = currentProduct?.units.find(
    (unit) => unit.id === selectedUnitId
  );
  const initialUnit = selectedUnit?.id ?? currentProduct?.defaultUnitId ?? "";
  const [unitSelection, setUnitSelection] = useState(initialUnit);
  const selectedUnitRecord = currentProduct?.units.find(
    (unit) => unit.id === unitSelection
  );
  const selectedUnitReported = selectedUnitRecord?.reported ?? false;
  const rules = problemType
    ? IOIO_REPORT_CONTEXT_RULES[problemType as IoioReportFormValue]
    : null;
  const exactUnitRequired = rules?.exactUnit === "required-if-multiple";
  const locationField =
    rules && rules.location !== "none" ? (
      <ReportLocationHierarchyField
        locations={locations}
        required={rules.location === "required"}
      />
    ) : null;
  const assetField =
    rules && rules.asset !== "none" ? (
      <>
        <input
          type="hidden"
          name="productId"
          value={selectedProduct}
          disabled={!selectedProduct}
        />
        <label
          htmlFor="report-product-search"
          className="block text-sm font-medium text-gray-800"
        >
          What item is this about?
          {rules.asset === "optional" ? " (optional)" : ""}
        </label>
        <input
          id="report-product-search"
          type="search"
          required={rules.asset === "required" && !selectedProduct}
          value={itemSearch}
          autoComplete="off"
          placeholder="Search items..."
          onFocus={() => setShowItemResults(true)}
          onChange={(event) => {
            const query = event.currentTarget.value;
            setItemSearch(query);
            setShowItemResults(true);
            if (query !== currentProduct?.label) {
              setSelectedProduct("");
              setUnitSelection("");
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") setShowItemResults(false);
          }}
          className="mt-1 block min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
        />
        {showItemResults ? (
          <ul
            aria-label="Matching items"
            className="mt-1 max-h-56 overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-sm"
          >
            {rules.asset === "optional" ? (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedProduct("");
                    setUnitSelection("");
                    setItemSearch("");
                    setShowItemResults(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50"
                >
                  No specific item
                </button>
              </li>
            ) : null}
            {itemResults.map((asset) => (
              <li key={asset.id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedProduct(asset.id);
                    setUnitSelection(asset.defaultUnitId ?? "");
                    setItemSearch(asset.label);
                    setShowItemResults(false);
                  }}
                  className="block w-full px-3 py-2 text-left text-sm font-semibold text-gray-900 hover:bg-red-50"
                >
                  {asset.label}
                  {asset.units.length ? (
                    <span className="ml-2 text-xs font-normal text-gray-500">
                      {asset.units.length} unit
                      {asset.units.length === 1 ? "" : "s"}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
            {!itemResults.length ? (
              <li className="px-3 py-2 text-sm text-gray-500">
                No matching items.
              </li>
            ) : null}
          </ul>
        ) : null}
        {currentProduct &&
        currentProduct.units.length > 1 &&
        rules.exactUnit !== "none" ? (
          <div>
            <label
              htmlFor="report-unit"
              className="block text-sm font-medium text-gray-800"
            >
              Which unit?{exactUnitRequired ? "" : " (optional)"}
            </label>
            <select
              id="report-unit"
              name="unitId"
              required={exactUnitRequired}
              value={unitSelection}
              onChange={(event) => setUnitSelection(event.currentTarget.value)}
              className="mt-1 block min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
            >
              <option value="">
                {exactUnitRequired ? "Choose a unit" : "Any unit / not sure"}
              </option>
              {currentProduct.units.map((unit) => (
                <option key={unit.id} value={unit.id} disabled={unit.reported}>
                  {unit.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              Reported units are waiting for Staff review and cannot be selected
              again.
            </p>
          </div>
        ) : rules.exactUnit !== "none" && currentProduct?.defaultUnitId ? (
          <>
            <input
              type="hidden"
              name="unitId"
              value={currentProduct.defaultUnitId}
            />
            {selectedUnitReported ? (
              <p className="-mt-4 text-sm font-semibold text-amber-800">
                {selectedUnitRecord?.label} is waiting for Staff review and
                cannot be selected again.
              </p>
            ) : null}
          </>
        ) : null}
      </>
    ) : null;
  const contextFields = (
    <>
      {assetField}
      {locationField}
    </>
  );
  return (
    <div>
      <SectionHeading title="Report" />
      {feedback?.ok === false ? (
        <div
          className="mb-5 rounded-xl bg-red-50 p-4 text-sm font-medium text-red-800"
          role="alert"
        >
          {feedback.message}
        </div>
      ) : null}
      <Form
        method="post"
        onSubmit={(event) => {
          if (submitLock.current) {
            event.preventDefault();
            return;
          }
          submitLock.current = true;
        }}
        className="space-y-5 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm"
      >
        <label className="block text-sm font-medium text-gray-800">
          What happened?
          <select
            name="problemType"
            required
            value={problemType}
            onChange={(event) => {
              const nextProblemType = event.currentTarget.value as
                | IoioReportFormValue
                | "";
              const nextRules = nextProblemType
                ? IOIO_REPORT_CONTEXT_RULES[nextProblemType]
                : null;
              if (!nextRules || nextRules.asset === "none") {
                setSelectedProduct("");
                setItemSearch("");
              }
              if (
                !nextRules ||
                nextRules.asset === "none" ||
                nextRules.exactUnit === "none"
              ) {
                setUnitSelection("");
              }
              setProblemType(nextProblemType);
            }}
            className="mt-1 block min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
          >
            <option value="">Choose an issue</option>
            {problemTypes.map((type) => (
              <option key={type.value} value={type.value}>
                {type.label}
              </option>
            ))}
          </select>
        </label>

        {contextFields}

        <label className="block text-sm font-medium text-gray-800">
          Description
          <textarea
            name="content"
            required
            minLength={3}
            maxLength={2000}
            rows={6}
            className="mt-1 block w-full rounded-xl border border-gray-300 px-3 py-2 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600"
            placeholder="Tell the TAs what happened."
          />
        </label>
        <button
          type="submit"
          disabled={isSubmitting || selectedUnitReported}
          className="min-h-11 rounded-xl bg-red-700 px-5 font-semibold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-600 disabled:cursor-wait disabled:opacity-60"
        >
          {isSubmitting
            ? "Submitting report…"
            : selectedUnitReported
            ? "Unit reported"
            : "Submit report"}
        </button>
      </Form>
    </div>
  );
}

function ReportLocationHierarchyField({
  locations,
  required,
}: {
  locations: StudentLocation[];
  required: boolean;
}) {
  const [roomId, setRoomId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [shelfId, setShelfId] = useState("");
  const [containerId, setContainerId] = useState("");
  const room = locations.find((location) => location.id === roomId);
  const section = room?.children.find((location) => location.id === sectionId);
  const shelf = section?.children.find((location) => location.id === shelfId);
  const container = shelf?.children.find(
    (location) => location.id === containerId
  );
  const selectedId =
    container?.id ?? shelf?.id ?? section?.id ?? room?.id ?? "";
  const selectClassName =
    "mt-1 block min-h-11 w-full rounded-xl border border-gray-300 bg-white px-3 focus:border-red-600 focus:outline-none focus:ring-2 focus:ring-red-600";
  const makeOptions = (items: StudentLocation[]) =>
    items.map((location) => (
      <option key={location.id} value={location.id}>
        {location.name}
      </option>
    ));

  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium text-gray-800">Location</legend>
      <input type="hidden" name="locationId" value={selectedId} />
      <label className="block text-sm font-medium text-gray-700">
        Room
        <select
          required={required}
          value={roomId}
          onChange={(event) => {
            setRoomId(event.currentTarget.value);
            setSectionId("");
            setShelfId("");
            setContainerId("");
          }}
          className={selectClassName}
        >
          <option value="">Select room</option>
          {makeOptions(locations)}
        </select>
      </label>
      {room?.children.length ? (
        <label className="block text-sm font-medium text-gray-700">
          Section
          <select
            value={sectionId}
            onChange={(event) => {
              setSectionId(event.currentTarget.value);
              setShelfId("");
              setContainerId("");
            }}
            className={selectClassName}
          >
            <option value="">Select section or keep the room</option>
            {makeOptions(room.children)}
          </select>
        </label>
      ) : null}
      {section?.children.length ? (
        <label className="block text-sm font-medium text-gray-700">
          Shelf
          <select
            value={shelfId}
            onChange={(event) => {
              setShelfId(event.currentTarget.value);
              setContainerId("");
            }}
            className={selectClassName}
          >
            <option value="">Select shelf or keep the section</option>
            {makeOptions(section.children)}
          </select>
        </label>
      ) : null}
      {shelf?.children.length ? (
        <label className="block text-sm font-medium text-gray-700">
          Container
          <select
            value={containerId}
            onChange={(event) => setContainerId(event.currentTarget.value)}
            className={selectClassName}
          >
            <option value="">Select container or keep the shelf</option>
            {makeOptions(shelf.children)}
          </select>
        </label>
      ) : null}
    </fieldset>
  );
}

function BorrowedProblemForm({
  item,
  result,
  isSubmitting,
}: {
  item: Awaited<ReturnType<typeof getBorrowedItemProblemContext>>;
  result: ReturnType<typeof useActionData<typeof action>>;
  isSubmitting: boolean;
}) {
  const feedback = getReportSubmissionFeedback(result);
  const submitLock = useRef(false);
  useEffect(() => {
    if (!isSubmitting && feedback) submitLock.current = false;
  }, [feedback, isSubmitting]);
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
        text="Tell the TAs what happened. Your loan will remain active until you return the item."
      />
      {feedback?.ok === false ? (
        <div
          className="mb-5 rounded-xl bg-red-50 p-4 text-sm font-medium text-red-800"
          role="alert"
        >
          {feedback.message}
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
        onSubmit={(event) => {
          if (submitLock.current) {
            event.preventDefault();
            return;
          }
          submitLock.current = true;
        }}
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
            placeholder="Describe the problem for the TAs."
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={isSubmitting}
            className="min-h-11 rounded-xl bg-red-700 px-5 font-semibold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-600 disabled:cursor-wait disabled:opacity-60"
          >
            {isSubmitting ? "Submitting report…" : "Submit report"}
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
