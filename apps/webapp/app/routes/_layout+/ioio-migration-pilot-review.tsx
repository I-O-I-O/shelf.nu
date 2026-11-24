import type { ReactNode } from "react";
import { OrganizationRoles } from "@prisma/client";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { z } from "zod";
import { useSearchParams } from "~/hooks/search-params";
import {
  REVIEW_CATEGORIES,
  REVIEW_TRACKING_TYPES,
  type ReviewCandidate,
  type ReviewDecision,
} from "~/modules/ioio-migration-review/review";
import {
  getReviewState,
  saveReviewDecision,
} from "~/modules/ioio-migration-review/review.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { ShelfError, makeShelfError } from "~/utils/error";
import { payload, error } from "~/utils/http.server";
import {
  PermissionAction,
  PermissionEntity,
} from "~/utils/permissions/permission.data";
import { requirePermission } from "~/utils/roles.server";

const title = "IOIO Migration Pilot Review";
const decisionSchema = z.enum(["APPROVE", "REJECT", "NEEDS_MORE_INFO"]);
const trackingSchema = z.enum(REVIEW_TRACKING_TYPES);
const consumptionSchema = z.enum(["TWO_WAY", "ONE_WAY"]);

export const meta: MetaFunction = () => [{ title: appendToMetaTitle(title) }];

async function requireReviewAccess(
  args: LoaderFunctionArgs | ActionFunctionArgs
) {
  const authSession = args.context.getSession();
  const permission = await requirePermission({
    userId: authSession.userId,
    request: args.request,
    entity: PermissionEntity.location,
    action: PermissionAction.read,
  });
  if (
    permission.role !== OrganizationRoles.ADMIN &&
    permission.role !== OrganizationRoles.OWNER
  ) {
    throw new ShelfError({
      cause: null,
      title: "Admin access required",
      message: "Only workspace administrators can approve migration records.",
      label: "Permission",
      status: 403,
      shouldBeCaptured: false,
    });
  }
  return permission;
}

export async function loader(args: LoaderFunctionArgs) {
  try {
    const { organizationId } = await requireReviewAccess(args);
    const milestone =
      new URL(args.request.url).searchParams.get("milestone") === "8" ? 8 : 6;
    return payload(await getReviewState(organizationId, milestone));
  } catch (cause) {
    const reason = makeShelfError(cause);
    throw data(error(reason), { status: reason.status });
  }
}

function formString(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function containsPrivateIdentity(value: string) {
  return /@[a-z0-9.-]+\.[a-z]{2,}|\b(?:student|borrower|holder|email|phone|contact|david|clint|veronika|bogdan|johannes|max)\b/i.test(
    value
  );
}

function validateDecision({
  candidate,
  decision,
  finalName,
  trackingType,
  finalQuantity,
  category,
  locationId,
  kitDecision,
  specialHandling,
  humanNote,
  consumptionType,
  isMilestone8,
  locationIsKnown,
}: {
  candidate: ReviewCandidate;
  decision: ReviewDecision;
  finalName: string;
  trackingType: string;
  finalQuantity: string;
  category: string;
  locationId: string;
  kitDecision: string;
  specialHandling: string;
  humanNote: string;
  consumptionType: string;
  isMilestone8: boolean;
  locationIsKnown: boolean;
}) {
  if (!candidate) return "Candidate not found in the M6 import plan.";
  if (!trackingSchema.safeParse(trackingType).success) {
    return "Choose a valid tracking type.";
  }
  if (locationId !== "UNASSIGNED" && !locationId) {
    return "Choose a Shelf location or UNASSIGNED.";
  }
  if (locationId !== "UNASSIGNED" && !locationIsKnown) {
    return "Choose an existing Shelf location or UNASSIGNED.";
  }
  if ([finalName, humanNote, specialHandling].some(containsPrivateIdentity)) {
    return "Personal or contact information is not allowed in this review tool.";
  }
  if (decision !== "APPROVE") return null;
  if (!finalName) return "APPROVE requires a final display name.";
  if (isMilestone8 && !consumptionSchema.safeParse(consumptionType).success) {
    return "Milestone 8 APPROVE requires TWO_WAY or ONE_WAY.";
  }
  if (!(REVIEW_CATEGORIES as readonly string[]).includes(category)) {
    return "APPROVE requires a valid working IOIO category.";
  }
  if (trackingType === "QUANTITY_TRACKED") {
    if (!/^\d+$/.test(finalQuantity)) {
      return "APPROVE requires an explicit non-negative numeric quantity for quantity tracking.";
    }
  } else if (finalQuantity && !/^\d+$/.test(finalQuantity)) {
    return "Final quantity must be numeric when supplied.";
  }
  if (!kitDecision) return "APPROVE requires an explicit kit decision.";
  if (candidate.kitClassification === "KIT CANDIDATE" && !kitDecision) {
    return "The kit candidate requires explicit confirmation.";
  }
  if (candidate.sourceItemName === "LightBulbs(2 broken)") {
    if (!specialHandling || specialHandling === "NEEDS_MORE_INFO") {
      return "Choose how the broken LightBulbs should be represented, or use NEEDS_MORE_INFO.";
    }
  }
  if (trackingType === "KIT" && kitDecision !== "CONFIRMED_KIT") {
    return "KIT tracking requires explicit CONFIRMED_KIT status; contents remain unspecified.";
  }
  return null;
}

export async function action(args: ActionFunctionArgs) {
  try {
    const { organizationId } = await requireReviewAccess(args);
    const milestone =
      new URL(args.request.url).searchParams.get("milestone") === "8" ? 8 : 6;
    const state = await getReviewState(organizationId, milestone);
    const formData = await args.request.formData();
    const candidateId = formString(formData, "candidate_id");
    const decision = decisionSchema.safeParse(
      formString(formData, "human_decision")
    );
    if (!decision.success)
      return data(
        { formError: "Choose APPROVE, REJECT, or NEEDS_MORE_INFO." },
        { status: 400 }
      );
    const candidate = state.candidates.find(
      (item) => item.candidateId === candidateId
    );
    const finalName = formString(formData, "final_name");
    const trackingType = formString(formData, "final_tracking_type");
    const finalQuantity = formString(formData, "final_quantity");
    const category = formString(formData, "final_category");
    const locationId = formString(formData, "final_location_id");
    const consumptionType = formString(formData, "final_consumption_type");
    const kitDecision = formString(formData, "kit_decision");
    const specialHandling = formString(formData, "special_handling");
    const humanNote = formString(formData, "human_note");
    const locationIsKnown =
      locationId === "UNASSIGNED" ||
      state.locations.some((location) => location.id === locationId);
    const validationError = validateDecision({
      candidate: candidate as ReviewCandidate,
      decision: decision.data,
      finalName,
      trackingType,
      finalQuantity,
      category,
      locationId,
      kitDecision,
      specialHandling,
      humanNote,
      consumptionType,
      isMilestone8: milestone === 8,
      locationIsKnown,
    });
    if (validationError)
      return data({ formError: validationError }, { status: 400 });
    const selectedLocation = state.locations.find(
      (location) => location.id === locationId
    );
    await saveReviewDecision({
      milestone,
      record: {
        candidate_id: candidateId,
        human_decision: decision.data,
        final_name: finalName,
        final_tracking_type: trackingType,
        final_quantity: finalQuantity,
        final_category: category,
        final_location_id: locationId === "UNASSIGNED" ? "" : locationId,
        final_location_name:
          selectedLocation?.path ??
          (locationId === "UNASSIGNED" ? "UNASSIGNED" : ""),
        final_consumption_type: consumptionType,
        kit_decision: kitDecision,
        human_note: humanNote,
        reviewed_at: new Date().toISOString(),
        special_handling: specialHandling,
      },
    });
    const nextCandidate = state.candidates.find(
      (item) =>
        item.candidateId !== candidateId &&
        !state.decisions.some((row) => row.candidate_id === item.candidateId)
    );
    return redirect(
      nextCandidate
        ? `/ioio-migration-pilot-review?milestone=${milestone}&candidate=${encodeURIComponent(
            nextCandidate.candidateId
          )}&saved=1`
        : `/ioio-migration-pilot-review?milestone=${milestone}&saved=1`
    );
  } catch (cause) {
    const reason = makeShelfError(cause);
    return data(error(reason), { status: reason.status });
  }
}

export default function IoioMigrationPilotReview() {
  const { candidates, locations, decisions, diagnostics } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [searchParams] = useSearchParams();
  const isMilestone8 = searchParams.get("milestone") === "8";
  const selectedId = searchParams.get("candidate");
  const selectedIndex = Math.max(
    0,
    candidates.findIndex((candidate) => candidate.candidateId === selectedId)
  );
  const candidate = candidates[selectedIndex];
  const savedDecision = decisions.find(
    (row) => row.candidate_id === candidate?.candidateId
  );
  const counts = {
    approved: decisions.filter((row) => row.human_decision === "APPROVE")
      .length,
    rejected: decisions.filter((row) => row.human_decision === "REJECT").length,
    needsInfo: decisions.filter(
      (row) => row.human_decision === "NEEDS_MORE_INFO"
    ).length,
  };
  const remaining = candidates.length - decisions.length;
  const isSaving = navigation.state === "submitting";
  const previous = candidates[selectedIndex - 1];
  const next = candidates[selectedIndex + 1];

  if (!candidate) {
    return (
      <ReviewShell
        counts={counts}
        remaining={remaining}
        diagnostics={diagnostics}
      >
        <p className="text-gray-700">
          No Milestone {isMilestone8 ? "8" : "6"} candidates are available.
        </p>
      </ReviewShell>
    );
  }

  return (
    <ReviewShell
      counts={counts}
      remaining={remaining}
      diagnostics={diagnostics}
    >
      <div className="mb-6 rounded border-2 border-amber-300 bg-amber-50 p-4">
        <p className="text-xs font-bold uppercase tracking-[0.18em] text-amber-900">
          Temporary migration tooling
        </p>
        <h1 className="mt-1 text-2xl font-bold text-gray-950">
          IOIO MIGRATION PILOT REVIEW — M{isMilestone8 ? "8" : "6"}
        </h1>
        <p className="mt-1 font-semibold text-amber-950">
          NOT YET IMPORTED INTO SHELF
        </p>
        <p className="mt-2 text-sm text-amber-900">
          Decisions are saved locally and only APPROVE rows are copied to the
          milestone approved-pilot artifact. This page never imports inventory.
        </p>
      </div>

      {searchParams.get("saved") ? (
        <div
          className="mb-4 rounded border border-green-300 bg-green-50 p-3 text-sm text-green-900"
          role="status"
        >
          Decision saved locally. No Shelf inventory was changed.
        </div>
      ) : null}
      {actionData && "formError" in actionData && actionData.formError ? (
        <div
          className="mb-4 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900"
          role="alert"
        >
          {actionData.formError}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-lg font-semibold text-gray-900">
          Candidate {selectedIndex + 1} of {candidates.length}
        </p>
        <div
          className="h-3 min-w-48 flex-1 overflow-hidden rounded-full bg-gray-200"
          aria-label={`${decisions.length} of ${candidates.length} reviewed`}
        >
          <div
            className="h-full rounded-full bg-primary-500 transition-all"
            style={{
              width: `${Math.round(
                (decisions.length / candidates.length) * 100
              )}%`,
            }}
          />
        </div>
      </div>

      {remaining === 0 ? (
        <div className="mb-6 rounded border border-green-300 bg-green-50 p-4 text-green-950">
          <p className="font-bold">
            All {candidates.length} candidates have decisions.
          </p>
          <p className="mt-1 text-sm">
            Approved records are ready for the controlled Milestone{" "}
            {isMilestone8 ? "8" : "6"} import request. Codex must be asked
            explicitly before any import occurs.
          </p>
        </div>
      ) : null}

      <Form method="post" className="space-y-6">
        <input
          type="hidden"
          name="candidate_id"
          value={candidate.candidateId}
        />
        <div className="grid gap-6 lg:grid-cols-2">
          <section
            className="rounded border bg-gray-50 p-5"
            aria-labelledby="source-heading"
          >
            <h2
              id="source-heading"
              className="text-lg font-semibold text-gray-950"
            >
              Source information
            </h2>
            <dl className="mt-4 grid gap-3 text-sm">
              <SourceField label="Candidate ID" value={candidate.candidateId} />
              <SourceField
                label="Source classification"
                value={candidate.sourceClassification}
              />
              <SourceField
                label="Original item name"
                value={candidate.sourceItemName}
              />
              <SourceField
                label="Original quantity"
                value={candidate.originalQuantity}
              />
              <SourceField
                label="Source category"
                value={candidate.originalCategory}
              />
              <SourceField
                label="Suggested category"
                value={candidate.suggestedCategory}
              />
              <SourceField
                label="Consumption suggestion"
                value={candidate.proposedConsumptionType}
              />
              <SourceField
                label="Original location text"
                value={candidate.originalLocationText}
              />
              <SourceField
                label="Source sheet / row"
                value={`${candidate.sourceSheet} / ${candidate.sourceRow}`}
              />
              <SourceField
                label="Duplicate classification"
                value={candidate.duplicateClassification}
              />
              <SourceField
                label="Kit classification"
                value={candidate.kitClassification}
              />
              {candidate.sourceNote ? (
                <SourceField
                  label="Sanitized source note"
                  value={candidate.sourceNote}
                />
              ) : (
                <SourceField
                  label="Sanitized source note"
                  value="No matching sanitized note available."
                />
              )}
            </dl>
          </section>

          <section
            className="rounded border bg-white p-5 shadow-sm"
            aria-labelledby="final-heading"
          >
            <h2
              id="final-heading"
              className="text-lg font-semibold text-gray-950"
            >
              Final values
            </h2>
            <p className="mt-1 text-sm text-gray-600">
              System suggestions are starting points only. Confirm every value
              before APPROVE.
            </p>
            <div className="mt-4 space-y-4">
              <Field
                label="Final display name"
                name="final_name"
                defaultValue={
                  savedDecision?.final_name ?? candidate.sourceItemName
                }
                required={false}
              />
              <SelectField
                label="Tracking type"
                name="final_tracking_type"
                defaultValue={
                  savedDecision?.final_tracking_type ??
                  candidate.proposedTrackingType
                }
                options={REVIEW_TRACKING_TYPES.map((value) => ({
                  value,
                  label: value,
                }))}
              />
              <Field
                label="Final quantity"
                name="final_quantity"
                type="number"
                min="0"
                step="1"
                defaultValue={
                  savedDecision?.final_quantity ?? candidate.proposedQuantity
                }
                help="Required for APPROVE when tracking type is QUANTITY_TRACKED."
              />
              {isMilestone8 ? (
                <SelectField
                  label="Consumption type"
                  name="final_consumption_type"
                  defaultValue={
                    savedDecision?.final_consumption_type ??
                    candidate.proposedConsumptionType
                  }
                  options={[
                    {
                      value: "TWO_WAY",
                      label: "TWO_WAY — reusable / returnable",
                    },
                    { value: "ONE_WAY", label: "ONE_WAY — consumed" },
                  ]}
                />
              ) : null}
              <SelectField
                label="Final category"
                name="final_category"
                defaultValue={
                  savedDecision?.final_category ??
                  ((REVIEW_CATEGORIES as readonly string[]).includes(
                    candidate.suggestedCategory
                  )
                    ? candidate.suggestedCategory
                    : "")
                }
                options={REVIEW_CATEGORIES.map((value) => ({
                  value,
                  label: value,
                }))}
                placeholder="Choose a category"
              />
              <SelectField
                label="Final Shelf location"
                name="final_location_id"
                defaultValue={savedDecision?.final_location_id || "UNASSIGNED"}
                options={[
                  { value: "UNASSIGNED", label: "UNASSIGNED" },
                  ...locations.map((location) => ({
                    value: location.id,
                    label: location.path,
                  })),
                ]}
              />
              <SelectField
                label="Kit decision"
                name="kit_decision"
                defaultValue={
                  savedDecision?.kit_decision ??
                  (candidate.kitClassification === "KIT CANDIDATE"
                    ? ""
                    : "NOT_A_KIT")
                }
                options={[
                  {
                    value: "CONFIRMED_KIT",
                    label: "CONFIRMED_KIT — no contents invented",
                  },
                  { value: "NOT_A_KIT", label: "NOT_A_KIT" },
                  { value: "NEEDS_MORE_INFO", label: "NEEDS_MORE_INFO" },
                ]}
                placeholder="Choose a kit decision"
              />
              {candidate.sourceItemName === "LightBulbs(2 broken)" ? (
                <SelectField
                  label="LightBulbs special handling"
                  name="special_handling"
                  defaultValue={savedDecision?.special_handling ?? ""}
                  options={[
                    {
                      value: "SEPARATE_BROKEN_ITEMS",
                      label: "Represent broken items separately",
                    },
                    {
                      value: "DO_NOT_SEPARATE_BROKEN_ITEMS",
                      label: "Do not represent separately",
                    },
                    { value: "NEEDS_MORE_INFO", label: "NEEDS_MORE_INFO" },
                  ]}
                  placeholder="Required for APPROVE"
                />
              ) : (
                <input
                  type="hidden"
                  name="special_handling"
                  value={savedDecision?.special_handling ?? ""}
                />
              )}
              <Field
                label="Human note"
                name="human_note"
                defaultValue={savedDecision?.human_note ?? ""}
                multiline
                help="Do not enter borrower or contact information."
              />
            </div>
          </section>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-5">
          <div className="flex gap-2">
            {previous ? (
              <Link
                className="rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
                to={`?milestone=${
                  isMilestone8 ? "8" : "6"
                }&candidate=${encodeURIComponent(previous.candidateId)}`}
              >
                Previous
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link
                className="rounded border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
                to={`?milestone=${
                  isMilestone8 ? "8" : "6"
                }&candidate=${encodeURIComponent(next.candidateId)}`}
              >
                Next
              </Link>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <DecisionButton decision="APPROVE" disabled={isSaving} />
            <DecisionButton decision="REJECT" disabled={isSaving} />
            <DecisionButton decision="NEEDS_MORE_INFO" disabled={isSaving} />
          </div>
        </div>
        <p className="text-xs text-gray-500">
          Choose a decision to save this candidate. Previous/Next navigation
          does not save unsent edits.
        </p>
      </Form>
    </ReviewShell>
  );
}

function ReviewShell({
  children,
  counts,
  remaining,
  diagnostics,
}: {
  children: ReactNode;
  counts: { approved: number; rejected: number; needsInfo: number };
  remaining: number;
  diagnostics: {
    processCwd: string;
    projectRoot: string;
    planPath: string;
    planExists: boolean;
    planBytes: number;
    parsedRows: number;
    status: "OK" | "MISSING" | "EMPTY";
    message: string;
  };
}) {
  return (
    <div className="mx-auto min-h-screen max-w-7xl px-4 py-8 md:px-8">
      <div className="mb-6 flex flex-wrap gap-4 rounded border bg-white p-4 text-sm shadow-sm">
        <span>
          <strong>Approved:</strong> {counts.approved}
        </span>
        <span>
          <strong>Rejected:</strong> {counts.rejected}
        </span>
        <span>
          <strong>Needs info:</strong> {counts.needsInfo}
        </span>
        <span>
          <strong>Remaining:</strong> {remaining}
        </span>
      </div>
      <div
        className={`mb-6 rounded border p-4 text-sm ${
          diagnostics.status === "OK"
            ? "border-blue-200 bg-blue-50 text-blue-950"
            : "border-red-300 bg-red-50 text-red-950"
        }`}
        role="status"
      >
        <p className="font-semibold">Review data source</p>
        <p className="mt-1">
          Total candidates loaded: {diagnostics.parsedRows}
        </p>
        <p className="mt-1 text-xs">
          Plan file size: {diagnostics.planBytes} bytes
        </p>
        <p className="mt-1 break-all font-mono text-xs">
          {diagnostics.planPath}
        </p>
        <p className="mt-1 text-xs">
          Resolved project root: {diagnostics.projectRoot}
        </p>
        <p className="mt-1 text-xs">
          Webapp process directory: {diagnostics.processCwd}
        </p>
        {diagnostics.status !== "OK" ? (
          <p className="mt-2 font-semibold">{diagnostics.message}</p>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function SourceField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-medium text-gray-600">{label}</dt>
      <dd className="mt-0.5 break-words text-gray-950">{value}</dd>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  type = "text",
  min,
  step,
  required = false,
  multiline = false,
  help,
}: {
  label: string;
  name: string;
  defaultValue: string;
  type?: string;
  min?: string;
  step?: string;
  required?: boolean;
  multiline?: boolean;
  help?: string;
}) {
  return (
    <label className="block text-sm font-medium text-gray-800">
      <span>{label}</span>
      {multiline ? (
        <textarea
          className="mt-1 min-h-24 w-full rounded border-gray-300 text-sm"
          name={name}
          defaultValue={defaultValue}
        />
      ) : (
        <input
          className="mt-1 w-full rounded border-gray-300 text-sm"
          name={name}
          type={type}
          min={min}
          step={step}
          defaultValue={defaultValue}
          required={required}
        />
      )}
      {help ? (
        <span className="mt-1 block text-xs font-normal text-gray-500">
          {help}
        </span>
      ) : null}
    </label>
  );
}

function SelectField({
  label,
  name,
  defaultValue,
  options,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue: string;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
}) {
  return (
    <label className="block text-sm font-medium text-gray-800">
      <span>{label}</span>
      <select
        className="mt-1 w-full rounded border-gray-300 text-sm"
        name={name}
        defaultValue={defaultValue}
      >
        {placeholder ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function DecisionButton({
  decision,
  disabled,
}: {
  decision: ReviewDecision;
  disabled: boolean;
}) {
  const classes =
    decision === "APPROVE"
      ? "border-green-700 bg-green-700 text-white hover:bg-green-800"
      : decision === "REJECT"
      ? "border-red-700 bg-red-700 text-white hover:bg-red-800"
      : "border-amber-600 bg-amber-500 text-white hover:bg-amber-600";
  return (
    <button
      className={`rounded border px-4 py-2 text-sm font-semibold disabled:opacity-50 ${classes}`}
      type="submit"
      name="human_decision"
      value={decision}
      disabled={disabled}
    >
      {decision.replaceAll("_", " ")}
    </button>
  );
}
