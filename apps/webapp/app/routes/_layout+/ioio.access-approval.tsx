import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import {
  getStudentAnnualAccessApproval,
  requestStudentAnnualAccessApproval,
} from "~/modules/ioio-student/annual-access.server";
import { requireStudentAccountSettings } from "~/modules/ioio-student/route.server";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

export async function loader({ context, request }: LoaderFunctionArgs) {
  const auth = await requireStudentAccountSettings({ context, request });
  return payload(
    await getStudentAnnualAccessApproval({
      organizationId: auth.organizationId,
      userId: auth.userId,
    })
  );
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireStudentAccountSettings({ context, request });
    if (auth.role !== "SELF_SERVICE") {
      throw new Error("Annual approval is only required for Student accounts.");
    }
    const result = await requestStudentAnnualAccessApproval({
      organizationId: auth.organizationId,
      userId: auth.userId,
    });
    return data({ ok: true as const, result });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const meta: MetaFunction = () => [{ title: "IOIO access approval" }];

export default function AnnualAccessApprovalPage() {
  const approval = useLoaderData<typeof loader>();
  const actionResult = useActionData<typeof action>();
  const actionError =
    actionResult && "error" in actionResult
      ? actionResult.error?.message
      : null;
  const hasRequested =
    approval.status === "PENDING" || approval.status === "APPROVED";

  return (
    <section className="max-w-2xl space-y-5">
      <div>
        <p className="text-xs font-bold uppercase tracking-[0.16em] text-red-700">
          Student access
        </p>
        <h1 className="mt-2 text-3xl font-black tracking-tight text-gray-950">
          IOIO borrowing approval
        </h1>
        <p className="mt-2 text-sm text-gray-600">
          Browsing remains available when approval is pending or expired. Only
          new borrowing is paused until approval is current.
        </p>
      </div>

      {actionError ? (
        <p
          role="alert"
          className="rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-800"
        >
          {actionError}
        </p>
      ) : null}
      {actionResult && "ok" in actionResult && actionResult.ok ? (
        <p
          role="status"
          className="rounded-xl bg-green-50 px-4 py-3 text-sm font-semibold text-green-800"
        >
          Your request has been sent to IOIO Lab Staff. Approval may take a few
          days.
        </p>
      ) : null}

      {!approval.required ? (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
            Current status
          </p>
          <p className="mt-2 text-xl font-bold text-gray-950">
            Approval not required
          </p>
          <p className="mt-2 text-sm text-gray-600">
            Students can borrow normally. Existing approval records and loans
            are unchanged.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-gray-200 bg-white p-5 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-wide text-gray-500">
            Current status
          </p>
          <p className="mt-2 text-xl font-bold text-gray-950">
            {approval.status === "APPROVED"
              ? "Approved"
              : approval.status === "PENDING"
              ? "Pending approval"
              : approval.status === "EXPIRED"
              ? "Expired"
              : approval.status === "DECLINED"
              ? "Not approved"
              : approval.status === "REVOKED"
              ? "Borrowing approval revoked"
              : "Not requested"}
          </p>
          {approval.status === "APPROVED" ? (
            <p className="mt-2 text-sm text-gray-600">
              {approval.validUntil
                ? `Valid until ${new Intl.DateTimeFormat("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    timeZone: "UTC",
                  }).format(approval.validUntil)}.`
                : "You can borrow IOIO Lab equipment."}
            </p>
          ) : approval.status === "PENDING" ? (
            <p className="mt-2 whitespace-pre-line text-sm text-gray-600">
              {approval.pendingMessage}
            </p>
          ) : (
            <>
              <p className="mt-2 whitespace-pre-line text-sm text-gray-600">
                {approval.status === "EXPIRED"
                  ? "Your IOIO borrowing approval has expired.\n\nYou can still browse equipment, but you need renewed approval before borrowing again."
                  : approval.status === "DECLINED"
                  ? "Your previous request was not approved. You can still browse equipment and submit a new request."
                  : approval.status === "REVOKED"
                  ? "Your previous access approval was revoked. You can still browse equipment, but approval is required to borrow. Reapply for access below."
                  : approval.studentMessage}
              </p>
              <Form method="post" className="mt-5">
                <button
                  type="submit"
                  disabled={hasRequested}
                  className="rounded-xl bg-red-700 px-4 py-2.5 text-sm font-bold text-white hover:bg-red-800 focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-300"
                >
                  {approval.status === "REVOKED"
                    ? "Reapply for approval"
                    : "Request approval"}
                </button>
              </Form>
            </>
          )}
        </div>
      )}
    </section>
  );
}
