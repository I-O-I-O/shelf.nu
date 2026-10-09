import { useState } from "react";
import { CircleHelp } from "lucide-react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, Form, useActionData, useLoaderData } from "react-router";
import { z } from "zod";
import { ErrorContent } from "~/components/errors";
import { Button } from "~/components/shared/button";
import { InfoTooltip } from "~/components/shared/info-tooltip";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { ACCESS_APPROVAL_RENEWAL_MODE } from "~/modules/ioio-student/annual-access";
import {
  DEFAULT_ACCESS_APPROVAL_RENEWAL_MONTH,
  getAccessApprovalSettings,
  updateAccessApprovalSettings,
} from "~/modules/ioio-student/annual-access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

const SettingsSchema = z
  .object({
    required: z.enum(["on", "off"]),
    renewalMode: z.enum([
      ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR,
      ACCESS_APPROVAL_RENEWAL_MODE.TWELVE_MONTHS,
      ACCESS_APPROVAL_RENEWAL_MODE.SIX_MONTHS,
      ACCESS_APPROVAL_RENEWAL_MODE.CUSTOM,
    ]),
    renewalMonth: z.coerce.number().int().min(1).max(12),
    customMonths: z.string(),
    studentMessage: z.string().max(1000),
  })
  .superRefine((values, ctx) => {
    if (values.renewalMode !== ACCESS_APPROVAL_RENEWAL_MODE.CUSTOM) return;
    const months = Number(values.customMonths);
    if (!Number.isInteger(months) || months < 1 || months > 36) {
      ctx.addIssue({
        code: "custom",
        path: ["customMonths"],
        message: "Choose a renewal interval from 1 to 36 months.",
      });
    }
  });

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  const defaultStudentMessage =
    "Annual IOIO access approval required\n\nYou can browse IOIO Lab equipment, but borrowing requires current approval.\n\nApproval may take a few days.";
  try {
    const { organizationId } = await requireIoioStaffAccess({
      context,
      request,
    });
    return payload({
      settings: await getAccessApprovalSettings(organizationId),
      defaultStudentMessage,
    });
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
    const parsed = SettingsSchema.safeParse({
      required: String(formData.get("required") ?? "off"),
      renewalMode: String(formData.get("renewalMode") ?? ""),
      renewalMonth: String(
        formData.get("renewalMonth") ?? DEFAULT_ACCESS_APPROVAL_RENEWAL_MONTH
      ),
      customMonths: String(formData.get("customMonths") ?? ""),
      studentMessage: String(formData.get("studentMessage") ?? ""),
    });

    if (!parsed.success) {
      return data(
        {
          ok: false as const,
          message:
            parsed.error.issues[0]?.message ??
            "Check the access approval settings and try again.",
        },
        { status: 400 }
      );
    }

    const values = parsed.data;
    await updateAccessApprovalSettings({
      organizationId,
      updatedByUserId: userId,
      required: values.required === "on",
      renewalMode: values.renewalMode,
      renewalMonth: values.renewalMonth,
      customMonths:
        values.renewalMode === ACCESS_APPROVAL_RENEWAL_MODE.CUSTOM
          ? Number(values.customMonths)
          : null,
      studentMessage: values.studentMessage.trim(),
    });
    return payload({
      ok: true as const,
      saved: true,
      settings: await getAccessApprovalSettings(organizationId),
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const handle = { breadcrumb: () => "Access approval" };
export const meta: MetaFunction = () => [
  { title: appendToMetaTitle("Access approval") },
];

export default function AccessApprovalSettingsPage() {
  const { settings, defaultStudentMessage } = useLoaderData<typeof loader>();
  const actionResult = useActionData<typeof action>();
  const [renewalMode, setRenewalMode] = useState(settings.renewalMode);
  const success = actionResult && "saved" in actionResult && actionResult.saved;
  const errorMessage =
    actionResult && "ok" in actionResult && !actionResult.ok
      ? actionResult.message
      : actionResult && "error" in actionResult
      ? actionResult.error?.message
      : null;

  return (
    <section className="max-w-3xl space-y-5">
      <header>
        <h2 className="text-xl font-bold text-gray-950">Access approval</h2>
        <p className="mt-1 text-sm text-gray-600">
          Control how often Students need renewed IOIO borrowing approval.
        </p>
      </header>

      {success ? (
        <p
          role="status"
          className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-800"
        >
          Access approval settings saved.
        </p>
      ) : null}
      {errorMessage ? (
        <p
          role="alert"
          className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {errorMessage}
        </p>
      ) : null}

      <Form
        method="post"
        className="space-y-5 rounded-xl border border-gray-200 bg-white p-5"
      >
        <div className="flex items-start gap-3">
          <input
            type="checkbox"
            name="required"
            id="required"
            value="on"
            defaultChecked={settings.required}
            className="mt-1 size-4 rounded border-gray-300 text-red-700 focus:ring-red-700"
          />
          <span>
            <span className="flex items-center gap-2 text-sm font-semibold text-gray-900">
              <label htmlFor="required">Require Student approval</label>
              <InfoTooltip
                icon={<CircleHelp className="size-4" />}
                ariaLabel="About Student approval requirement"
                content="Students need current approval before they can start a new borrowing. Staff and TAs are exempt."
              />
            </span>
            <span className="mt-1 block text-sm text-gray-600">
              When disabled, Students can borrow normally. Existing loans are
              not affected.
            </span>
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-semibold text-gray-800">
            <span className="mb-1 flex items-center gap-2">
              Approval renewal
              <InfoTooltip
                icon={<CircleHelp className="size-4" />}
                ariaLabel="About approval renewal"
                content="Controls how long a Student approval remains valid. Existing approvals keep their saved expiry date."
              />
            </span>
            <select
              name="renewalMode"
              value={renewalMode}
              onChange={(event) =>
                setRenewalMode(event.currentTarget.value as typeof renewalMode)
              }
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal"
            >
              <option value={ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR}>
                Every academic year
              </option>
              <option value={ACCESS_APPROVAL_RENEWAL_MODE.TWELVE_MONTHS}>
                Every 12 months
              </option>
              <option value={ACCESS_APPROVAL_RENEWAL_MODE.SIX_MONTHS}>
                Every 6 months
              </option>
              <option value={ACCESS_APPROVAL_RENEWAL_MODE.CUSTOM}>
                Custom
              </option>
            </select>
          </label>

          {renewalMode === ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR ? (
            <label className="block text-sm font-semibold text-gray-800">
              <span className="mb-1 flex items-center gap-2">
                Renewal month
                <InfoTooltip
                  icon={<CircleHelp className="size-4" />}
                  ariaLabel="About renewal month"
                  content="Starts a new academic approval cycle in this month each year."
                />
              </span>
              <select
                name="renewalMonth"
                defaultValue={settings.renewalMonth}
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-normal"
              >
                {months.map((month, index) => (
                  <option key={month} value={index + 1}>
                    {month}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="flex items-end">
              {renewalMode === ACCESS_APPROVAL_RENEWAL_MODE.CUSTOM ? (
                <label className="block w-full text-sm font-semibold text-gray-800">
                  Renew every
                  <span className="mt-1 flex items-center gap-2 font-normal">
                    <input
                      type="number"
                      name="customMonths"
                      min={1}
                      max={36}
                      defaultValue={settings.customMonths ?? 9}
                      className="w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                    months (1 to 36)
                  </span>
                </label>
              ) : (
                <p className="pb-2 text-sm text-gray-600">
                  Approval validity is based on the date Staff approves the
                  request.
                </p>
              )}
            </div>
          )}
        </div>

        {renewalMode !== ACCESS_APPROVAL_RENEWAL_MODE.CUSTOM ? (
          <input
            type="hidden"
            name="customMonths"
            value={settings.customMonths ?? 9}
          />
        ) : null}
        {renewalMode !== ACCESS_APPROVAL_RENEWAL_MODE.ACADEMIC_YEAR ? (
          <input
            type="hidden"
            name="renewalMonth"
            value={settings.renewalMonth}
          />
        ) : null}

        <label className="block text-sm font-semibold text-gray-800">
          Student message
          <span className="mt-1 block text-xs font-normal text-gray-500">
            Plain text shown when a Student needs approval. HTML is not
            supported.
          </span>
          <textarea
            name="studentMessage"
            rows={5}
            maxLength={1000}
            defaultValue={settings.studentMessage || defaultStudentMessage}
            className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-normal"
          />
        </label>

        <Button type="submit" variant="primary">
          Save changes
        </Button>
      </Form>
    </section>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
