import { useEffect, useMemo, useState } from "react";
import type { CardAccessRequestStatus as PrismaCardAccessRequestStatus } from "@prisma/client";
import { Copy, Plus, Send } from "lucide-react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import { z } from "zod";
import { ErrorContent } from "~/components/errors";
import { SelectableRow } from "~/components/ioio-staff/selectable-row";
import { Button } from "~/components/shared/button";
import { Card } from "~/components/shared/card";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { CARD_ACCESS_REQUEST_STATUS as CardAccessRequestStatus } from "~/modules/ioio-staff/card-access.constants";
import {
  addStaffCardAccessRequest,
  getStaffCardAccessData,
  markCardAccessApproved,
  removeStaffCardAccessRequest,
  sendTeacherCardAccessBatch,
} from "~/modules/ioio-staff/card-access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, parseData, payload } from "~/utils/http.server";

const AddPersonSchema = z.object({
  applicantId: z.string().min(1),
  cardNumber: z
    .string()
    .trim()
    .regex(/^\d{10}$/, "Card number must be exactly 10 digits."),
  consent: z.literal("true"),
});

const SendTeacherSchema = z.object({ recipientId: z.string().min(1) });

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { organizationId } = await requireIoioStaffAccess({
      context,
      request,
    });
    return payload(await getStaffCardAccessData({ organizationId }));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { organizationId } = await requireIoioStaffAccess({
      context,
      request,
    });
    const formData = await request.formData();
    const intent = String(formData.get("intent") ?? "");
    const requestIds = formData.getAll("requestId").map(String).filter(Boolean);

    switch (intent) {
      case "add-person": {
        const parsed = parseData(formData, AddPersonSchema, {
          shouldBeCaptured: false,
        });
        await addStaffCardAccessRequest({
          organizationId,
          applicantId: parsed.applicantId,
          cardNumber: parsed.cardNumber,
          consentConfirmed: parsed.consent === "true",
        });
        return payload({ success: true, intent });
      }
      case "send-teacher": {
        const { recipientId } = SendTeacherSchema.parse({
          recipientId: formData.get("recipientId"),
        });
        await sendTeacherCardAccessBatch({
          organizationId,
          staffUserId: userId,
          recipientId,
          requestIds,
        });
        return payload({ success: true, intent });
      }
      case "approve": {
        const requestId = String(formData.get("requestId") ?? "");
        if (!requestId) throw new Error("Request id is required");
        await markCardAccessApproved({ organizationId, requestId });
        return payload({ success: true, intent });
      }
      case "remove": {
        const requestId = String(formData.get("requestId") ?? "");
        if (!requestId) throw new Error("Request id is required");
        await removeStaffCardAccessRequest({ organizationId, requestId });
        return payload({ success: true, intent });
      }
      default:
        throw new Error("Unsupported card access action");
    }
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction<typeof loader> = () => [
  { title: appendToMetaTitle("IOIO Lab Access") },
];

export const handle = {
  breadcrumb: () => "IOIO Lab Access",
};

const statusLabels: Record<PrismaCardAccessRequestStatus, string> = {
  WAITING_FOR_SUBMISSION: "Waiting for submission",
  SUBMITTED: "Pending approval",
  APPROVED: "Approved",
  NEEDS_ATTENTION: "Needs attention",
  CANCELLED: "Cancelled",
};

const statusBadgeClasses: Record<PrismaCardAccessRequestStatus, string> = {
  WAITING_FOR_SUBMISSION: "bg-amber-50 text-amber-800",
  SUBMITTED: "bg-blue-50 text-blue-800",
  APPROVED: "bg-green-50 text-green-800",
  NEEDS_ATTENTION: "bg-error-50 text-error-700",
  CANCELLED: "bg-gray-100 text-gray-600",
};

const activeRequestStatuses = new Set<PrismaCardAccessRequestStatus>([
  CardAccessRequestStatus.WAITING_FOR_SUBMISSION,
  CardAccessRequestStatus.SUBMITTED,
  CardAccessRequestStatus.NEEDS_ATTENTION,
]);

export default function CardAccessRequestsPage() {
  const { requests, people, staff } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [selectedIds, setSelectedIds] = useState<string[]>(
    requests
      .filter(
        (request) =>
          request.status === CardAccessRequestStatus.WAITING_FOR_SUBMISSION
      )
      .map((request) => request.id)
  );
  const [view, setView] = useState<"active" | "approved">("active");
  const [copied, setCopied] = useState(false);
  const errorMessage =
    actionData && "error" in actionData && actionData.error
      ? actionData.error.message
      : undefined;
  const successMessage =
    actionData && "success" in actionData && actionData.success
      ? actionData.intent === "add-person"
        ? "Added to card access request."
        : actionData.intent === "send-teacher"
        ? "Access request sent to teacher."
        : actionData.intent === "approve"
        ? "Card access request marked approved."
        : actionData.intent === "remove"
        ? "Person removed from the access request."
        : undefined
      : undefined;
  const visibleRequests = requests.filter((request) =>
    view === "approved"
      ? request.status === CardAccessRequestStatus.APPROVED
      : activeRequestStatuses.has(request.status)
  );
  const selectedRequests = useMemo(
    () =>
      requests.filter(
        (request) =>
          selectedIds.includes(request.id) &&
          request.status === CardAccessRequestStatus.WAITING_FOR_SUBMISSION
      ),
    [requests, selectedIds]
  );

  useEffect(() => {
    const waitingIds = new Set(
      requests
        .filter(
          (request) =>
            request.status === CardAccessRequestStatus.WAITING_FOR_SUBMISSION
        )
        .map((request) => request.id)
    );
    setSelectedIds((current) => current.filter((id) => waitingIds.has(id)));
  }, [requests]);

  const copyBatch = async () => {
    const text = selectedRequests
      .map((request) => {
        const name =
          request.applicant.displayName?.trim() ||
          [request.applicant.firstName, request.applicant.lastName]
            .filter(Boolean)
            .join(" ") ||
          request.applicant.email;
        return `${name} - ${request.applicant.email} - ${
          request.cardNumber ?? ""
        }`;
      })
      .join("\n");
    await navigator.clipboard.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const toggleSelected = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id]
    );
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-5">
      <Card className="my-0 p-0">
        <div className="border-b border-gray-200 px-4 py-5 md:px-6">
          <h2 className="text-text-lg font-semibold text-gray-900">
            IOIO Lab Access
          </h2>
          <p className="mt-1 text-sm text-gray-600">
            Add IOIO Lab users and their card numbers here so access details can
            be collected and sent to administration more quickly.
          </p>
        </div>

        {errorMessage ? (
          <p
            className="border-b border-error-200 bg-error-50 px-4 py-3 text-sm text-error-700 md:px-6"
            role="alert"
          >
            {errorMessage}
          </p>
        ) : null}
        {successMessage ? (
          <p
            className="border-b border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800 md:px-6"
            role="status"
          >
            {successMessage}
          </p>
        ) : null}

        <div className="divide-y divide-gray-100">
          <div className="flex gap-2 border-b border-gray-200 px-4 py-3 md:px-6">
            {(["active", "approved"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => setView(tab)}
                className={`rounded-full px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-primary-200 ${
                  view === tab
                    ? "bg-gray-900 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                }`}
                aria-pressed={view === tab}
              >
                {tab === "active" ? "Active" : "Approved"}
              </button>
            ))}
          </div>

          {visibleRequests.length === 0 ? (
            <p className="px-4 py-6 text-sm text-gray-500 md:px-6">
              {view === "approved"
                ? "No approved IOIO Lab access requests."
                : "No active IOIO Lab access requests."}
            </p>
          ) : (
            visibleRequests.map((request) => {
              const name =
                request.applicant.displayName?.trim() ||
                [request.applicant.firstName, request.applicant.lastName]
                  .filter(Boolean)
                  .join(" ") ||
                request.applicant.email;
              const canSelect =
                request.status ===
                CardAccessRequestStatus.WAITING_FOR_SUBMISSION;
              return (
                <SelectableRow
                  key={request.id}
                  selected={canSelect && selectedIds.includes(request.id)}
                  onToggle={
                    canSelect ? () => toggleSelected(request.id) : undefined
                  }
                  variant="list"
                  className="flex flex-wrap items-start gap-3 md:px-6"
                >
                  {canSelect ? (
                    <input
                      type="checkbox"
                      checked={selectedIds.includes(request.id)}
                      onChange={() => toggleSelected(request.id)}
                      aria-label={`Include ${name} in the next batch`}
                      className="mt-1 size-4 rounded border-gray-300 text-primary-600 focus:ring-primary-200"
                    />
                  ) : (
                    <span className="mt-1 size-4" aria-hidden="true" />
                  )}
                  <div className="min-w-[220px] flex-1">
                    <p className="font-medium text-gray-900">{name}</p>
                    <p className="text-sm text-gray-600">
                      {request.applicant.email}
                    </p>
                  </div>
                  <div className="min-w-[150px] text-sm text-gray-700">
                    {canSelect ? (
                      <p>
                        <span className="text-xs text-gray-500">
                          Card number
                        </span>
                        <span className="block font-medium text-gray-900">
                          {request.cardNumber}
                        </span>
                      </p>
                    ) : null}
                    <span
                      className={`mt-1 inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
                        statusBadgeClasses[request.status]
                      }`}
                    >
                      {statusLabels[request.status]}
                    </span>
                  </div>
                  {request.status ===
                  CardAccessRequestStatus.WAITING_FOR_SUBMISSION ? (
                    <Form
                      method="post"
                      onSubmit={(event) => {
                        if (
                          !window.confirm(
                            "Remove this person from the access request?"
                          )
                        ) {
                          event.preventDefault();
                        }
                      }}
                    >
                      <input type="hidden" name="intent" value="remove" />
                      <input
                        type="hidden"
                        name="requestId"
                        value={request.id}
                      />
                      <Button type="submit" variant="secondary" size="xs">
                        Remove
                      </Button>
                    </Form>
                  ) : null}
                  {request.status === CardAccessRequestStatus.SUBMITTED ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="approve" />
                      <input
                        type="hidden"
                        name="requestId"
                        value={request.id}
                      />
                      <Button type="submit" variant="secondary" size="xs">
                        Mark approved
                      </Button>
                    </Form>
                  ) : null}
                </SelectableRow>
              );
            })
          )}
        </div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="my-0">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">
                Add person
              </h3>
              <p className="mt-1 text-xs text-gray-500">
                Add an existing IOIO user and their card number so their access
                details can be included in the next administration request.
              </p>
            </div>
            <Plus aria-hidden="true" className="text-gray-400" size={18} />
          </div>
          <Form method="post" className="mt-4 space-y-3">
            <input type="hidden" name="intent" value="add-person" />
            <label className="flex flex-col gap-1 text-sm text-gray-700">
              Person
              <select
                name="applicantId"
                required
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="">Select a user</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name} - {person.email}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm text-gray-700">
              Card number
              <input
                name="cardNumber"
                required
                inputMode="numeric"
                pattern="[0-9]{10}"
                placeholder="Enter 10-digit card number"
                className="rounded border border-gray-300 px-3 py-2 text-sm"
              />
            </label>
            <label className="flex items-start gap-2 text-sm text-gray-700">
              <input
                type="checkbox"
                name="consent"
                value="true"
                required
                className="mt-0.5 size-4"
              />
              <span>
                This person has agreed to be included in this request.
              </span>
            </label>
            <Button type="submit" variant="secondary" size="sm">
              Add person
            </Button>
          </Form>
        </Card>

        {view === "active" ? (
          <Card className="my-0">
            <h3 className="text-sm font-semibold text-gray-900">
              Access request batch
            </h3>
            <p className="mt-1 text-xs text-gray-500">
              {selectedRequests.length} people selected
            </p>
            <Form
              method="post"
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                if (
                  !window.confirm(
                    `Send this access request to the selected Staff member?\n\nPeople included: ${selectedRequests.length}`
                  )
                ) {
                  event.preventDefault();
                }
              }}
            >
              <input type="hidden" name="intent" value="send-teacher" />
              {selectedRequests.map((request) => (
                <input
                  key={request.id}
                  type="hidden"
                  name="requestId"
                  value={request.id}
                />
              ))}
              <label className="flex flex-col gap-1 text-sm text-gray-700">
                Teacher / approver
                <select
                  name="recipientId"
                  required
                  className="rounded border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">Select Staff member</option>
                  {staff.map((person) => (
                    <option key={person.id} value={person.id}>
                      {person.name} - {person.email}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  compactLayout
                  noVerticalPadding
                  className="h-10 shrink-0"
                  disabled={!selectedRequests.length}
                  onClick={copyBatch}
                >
                  <span className="inline-flex items-center gap-2">
                    <Copy aria-hidden="true" className="size-4 shrink-0" />
                    <span>{copied ? "Copied" : "Copy all"}</span>
                  </span>
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  compactLayout
                  noVerticalPadding
                  className="h-10 shrink-0"
                  disabled={!selectedRequests.length}
                >
                  <span className="inline-flex items-center gap-2">
                    <Send aria-hidden="true" className="size-4 shrink-0" />
                    <span>Send access request</span>
                  </span>
                </Button>
              </div>
            </Form>
          </Card>
        ) : null}
      </div>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
