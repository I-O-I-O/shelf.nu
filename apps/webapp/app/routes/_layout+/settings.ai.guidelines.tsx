import { useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import {
  data,
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
} from "react-router";
import { z } from "zod";
import { ErrorContent } from "~/components/errors";
import { AiGuidelineFieldHelp } from "~/components/settings/ai-guideline-help";
import { Button } from "~/components/shared/button";
import {
  IOIO_AI_GUIDELINE_SECTIONS,
  type IoioAiGuidelineKey,
} from "~/modules/ioio-ai-guidelines/guidelines.shared";
import {
  getIoioAiGuidelines,
  saveIoioAiGuidelines,
} from "~/modules/ioio-ai-guidelines/service.server";
import { requireIoioStaffAccess } from "~/modules/ioio-staff/access.server";
import { appendToMetaTitle } from "~/utils/append-to-meta-title";
import { ShelfError, makeShelfError } from "~/utils/error";
import { error, payload } from "~/utils/http.server";

const guidelineSchema = z.object({
  generalBehaviour: z.string().trim().max(3000),
  inventory: z.string().trim().max(3000),
  borrowing: z.string().trim().max(3000),
  locations: z.string().trim().max(3000),
  studentSupport: z.string().trim().max(3000),
  staffSupport: z.string().trim().max(3000),
  actions: z.string().trim().max(3000),
});

type ActionResult =
  | { success: true; message: string }
  | { success: false; message: string };

async function requireAiGuidelinesWorkspace({
  context,
  request,
}: Pick<LoaderFunctionArgs, "context" | "request">) {
  const access = await requireIoioStaffAccess({ context, request });
  if (access.currentOrganization.type === "PERSONAL") {
    throw new ShelfError({
      cause: null,
      message: "AI guidelines are available in IOIO Lab workspaces only.",
      label: "Settings",
      status: 403,
      shouldBeCaptured: false,
    });
  }
  return access;
}

export async function loader({ context, request }: LoaderFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { organizationId } = await requireAiGuidelinesWorkspace({
      context,
      request,
    });
    return payload(await getIoioAiGuidelines(organizationId));
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    throw data(error(reason), { status: reason.status });
  }
}

export async function action({ context, request }: ActionFunctionArgs) {
  const { userId } = context.getSession();
  try {
    const { organizationId } = await requireAiGuidelinesWorkspace({
      context,
      request,
    });
    const formData = await request.formData();
    const candidate = Object.fromEntries(
      IOIO_AI_GUIDELINE_SECTIONS.map(({ key }) => [
        key,
        formData.get(key) ?? "",
      ])
    );
    const parsed = guidelineSchema.safeParse(candidate);
    if (!parsed.success) {
      const invalidPath = String(parsed.error.issues[0]?.path[0] ?? "");
      const invalidField: IoioAiGuidelineKey | undefined =
        IOIO_AI_GUIDELINE_SECTIONS.find(({ key }) => key === invalidPath)?.key;
      return payload({
        success: false,
        message: invalidField
          ? `${
              IOIO_AI_GUIDELINE_SECTIONS.find(({ key }) => key === invalidField)
                ?.title ?? "A guideline"
            } must be 3,000 characters or fewer.`
          : "Check the guideline text and try again.",
      } satisfies ActionResult);
    }
    const totalCharacters = Object.values(parsed.data).reduce(
      (total, text) => total + text.length,
      0
    );
    if (totalCharacters > 12_000) {
      return payload({
        success: false,
        message: "Guidelines must be 12,000 characters or fewer in total.",
      } satisfies ActionResult);
    }

    await saveIoioAiGuidelines({
      organizationId,
      userId,
      sections: parsed.data,
    });
    return payload({
      success: true,
      message: "AI guidelines saved.",
    } satisfies ActionResult);
  } catch (cause) {
    const reason = makeShelfError(cause, { userId });
    return data(error(reason), { status: reason.status });
  }
}

export const handle = { breadcrumb: () => "Guidelines" };
export const meta: MetaFunction<typeof loader> = () => [
  { title: appendToMetaTitle("AI guidelines") },
];

export default function AiGuidelinesPage() {
  const { sections, updatedAt, updatedBy } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [openHelpKey, setOpenHelpKey] = useState<IoioAiGuidelineKey | null>(
    null
  );
  const isSaving = navigation.state === "submitting";
  const isSuccess = Boolean(
    actionData && "success" in actionData && actionData.success
  );
  const actionMessage =
    actionData && "message" in actionData
      ? actionData.message
      : actionData && "error" in actionData && actionData.error
      ? actionData.error.message
      : null;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 pb-8">
      <header className="mb-5">
        <h1 className="text-xl font-semibold text-gray-900">AI Guidelines</h1>
        <p className="mt-1 text-sm text-gray-600">
          Be specific about what Ask IOIO should do, when it should do it, and
          what it should avoid. Use the ? examples if you’re unsure what to
          write.
        </p>
      </header>

      <section className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-amber-950">
              AI Guidelines
            </h3>
            <p className="mt-1 text-sm text-amber-900">
              IOIO-specific preferences for how Ask IOIO answers and assists
              people.
            </p>
          </div>
          <div>
            <h3 className="text-sm font-semibold text-amber-950">
              System safeguards
            </h3>
            <p className="mt-1 text-sm text-amber-900">
              The app separately enforces privacy, access, and safety. These
              settings cannot change those protections or perform actions.
            </p>
          </div>
        </div>
        <p className="mt-3 text-xs text-amber-900">
          Do not enter secrets or personal information.
        </p>
      </section>

      {actionMessage ? (
        <p
          role="status"
          className={`mb-4 rounded-md px-3 py-2 text-sm ${
            isSuccess ? "bg-green-50 text-green-800" : "bg-red-50 text-red-800"
          }`}
        >
          {actionMessage}
        </p>
      ) : null}

      <Form method="post" className="space-y-5">
        {IOIO_AI_GUIDELINE_SECTIONS.map((section) => (
          <section
            key={section.key}
            className="rounded-lg border border-gray-200 bg-white p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <label
                htmlFor={section.key}
                className="pt-1 text-sm font-semibold text-gray-900"
              >
                {section.title}
              </label>
              <AiGuidelineFieldHelp
                sectionKey={section.key}
                title={section.title}
                open={openHelpKey === section.key}
                onOpenChange={(open) =>
                  setOpenHelpKey(open ? section.key : null)
                }
              />
            </div>
            <textarea
              id={section.key}
              name={section.key}
              rows={3}
              maxLength={3000}
              defaultValue={sections[section.key]}
              className="mt-3 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-200"
            />
            <p className="mt-1 text-right text-xs text-gray-500">
              Up to 3,000 characters
            </p>
          </section>
        ))}

        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-gray-500">
            {updatedAt
              ? `Last updated ${new Intl.DateTimeFormat(undefined, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }).format(new Date(updatedAt))}${
                  updatedBy ? ` by ${updatedBy}` : ""
                }`
              : "No Staff guidelines saved yet."}
          </p>
          <Button type="submit" disabled={isSaving}>
            {isSaving ? "Saving…" : "Save guidelines"}
          </Button>
        </div>
      </Form>
    </div>
  );
}

export const ErrorBoundary = () => <ErrorContent />;
