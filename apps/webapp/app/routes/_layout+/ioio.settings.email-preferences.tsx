import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { data, useFetcher, useLoaderData } from "react-router";
import { z } from "zod";
import { Card } from "~/components/shared/card";
import {
  EMAIL_PREFERENCE_CATEGORIES,
  getUserEmailPreferences,
  updateUserEmailPreference,
  type EmailPreferenceCategory,
} from "~/modules/email-preferences/service.server";
import { requireStudentAccountSettings } from "~/modules/ioio-student/route.server";
import { makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

const toggleSchema = z.object({
  intent: z.literal("toggle"),
  category: z.enum(EMAIL_PREFERENCE_CATEGORIES),
  enabled: z.enum(["true", "false"]).transform((value) => value === "true"),
});

const preferenceRows: Array<{
  category: EmailPreferenceCategory;
  label: string;
  description: string;
}> = [
  {
    category: "RETURN_REMINDER",
    label: "Return reminders",
    description: "Reminders about upcoming return dates.",
  },
  {
    category: "EXTENSION_UPDATE",
    label: "Extension updates",
    description: "Updates when an extension request is decided.",
  },
  {
    category: "READY_FOR_PICKUP",
    label: "Ready for pickup",
    description: "A notice when prepared equipment is ready to collect.",
  },
  {
    category: "ANNUAL_ACCESS_UPDATE",
    label: "Annual access updates",
    description: "Updates about annual borrowing approval.",
  },
];

export async function loader({ context, request }: LoaderFunctionArgs) {
  const auth = await requireStudentAccountSettings({ context, request });
  return payload({ preferences: await getUserEmailPreferences(auth.userId) });
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const auth = await requireStudentAccountSettings({ context, request });
    const parsed = toggleSchema.parse(
      Object.fromEntries(await request.formData())
    );
    await updateUserEmailPreference(
      auth.userId,
      parsed.category,
      parsed.enabled
    );
    return data({
      ok: true as const,
      category: parsed.category,
      enabled: parsed.enabled,
    });
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

function PreferenceToggle({
  category,
  label,
  description,
  initialEnabled,
}: (typeof preferenceRows)[number] & { initialEnabled: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const [enabled, setEnabled] = useState(initialEnabled);

  useEffect(() => {
    if (fetcher.data && "error" in fetcher.data && fetcher.data.error) {
      setEnabled(initialEnabled);
    }
  }, [fetcher.data, initialEnabled]);

  const saving = fetcher.state !== "idle";
  const errorMessage =
    fetcher.data && "error" in fetcher.data
      ? fetcher.data.error?.message
      : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 border-b border-gray-100 py-4 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm font-bold text-gray-950">{label}</p>
        <p className="mt-1 text-sm text-gray-600">{description}</p>
        {errorMessage ? (
          <p className="mt-1 text-xs font-semibold text-red-700" role="alert">
            {errorMessage}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${label}: ${enabled ? "enabled" : "disabled"}`}
          disabled={saving}
          onClick={() => {
            const nextEnabled = !enabled;
            setEnabled(nextEnabled);
            void fetcher.submit(
              {
                intent: "toggle",
                category,
                enabled: String(nextEnabled),
              },
              { method: "post" }
            );
          }}
          className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full p-1 transition focus:outline-none focus:ring-2 focus:ring-red-700 focus:ring-offset-2 disabled:cursor-wait disabled:opacity-60 ${
            enabled ? "bg-red-700" : "bg-gray-300"
          }`}
        >
          <span
            className={`size-5 rounded-full bg-white shadow-sm transition ${
              enabled ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>
    </div>
  );
}

export const meta: MetaFunction = () => [{ title: "Email preferences" }];

export default function StudentEmailPreferences() {
  const { preferences } = useLoaderData<typeof loader>();
  return (
    <Card className="my-0 max-w-3xl rounded-2xl p-5 shadow-sm">
      <div>
        <h2 className="text-xl font-black text-gray-950">Email preferences</h2>
        <p className="mt-1 text-sm text-gray-600">
          Choose which optional IOIO Lab updates you would like to receive.
        </p>
      </div>
      <div className="mt-3">
        {preferenceRows.map((row) => (
          <PreferenceToggle
            key={row.category}
            {...row}
            initialEnabled={preferences[preferenceField(row.category)]}
          />
        ))}
      </div>
      <div className="mt-5 rounded-xl border border-gray-200 bg-gray-50 px-4 py-3">
        <p className="text-sm font-bold text-gray-950">
          Direct messages from IOIO Staff
        </p>
        <p className="mt-1 text-sm text-gray-600">Always enabled</p>
      </div>
      <div className="mt-3 rounded-xl border border-gray-200 bg-white px-4 py-3">
        <p className="text-sm font-bold text-gray-950">Security emails</p>
        <p className="mt-1 text-sm text-gray-600">
          Verification, password reset, and other account-security emails are
          always enabled and managed by the authentication provider.
        </p>
      </div>
    </Card>
  );
}

function preferenceField(category: EmailPreferenceCategory) {
  const fields = {
    BORROWING_CONFIRMATION: "borrowingConfirmation",
    RETURN_REMINDER: "returnReminders",
    EXTENSION_UPDATE: "extensionUpdates",
    READY_FOR_PICKUP: "readyForPickup",
    CARD_ACCESS_UPDATE: "cardAccessUpdates",
    ANNUAL_ACCESS_UPDATE: "annualAccessUpdates",
  } as const;
  return fields[category];
}
